#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path

import joblib
import numpy as np

from predict import connect, model_features, pick_artifact


TARGET_TEXT = {
    "label_structure_safe_20d": "未来20日收益>5%且回撤<=8%且不跌破安全区",
    "label_ret_20d_gt_5": "未来20日收益 > 5%",
}


def number(value, digits=4):
    if value is None:
        return None
    return round(float(value), digits)


def load_review_rows(feature_db_path, domain, features, target, limit):
    conn = connect(feature_db_path)
    try:
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(financial_ml_dataset)").fetchall()
        }
        if target not in columns:
            raise RuntimeError(f"训练数据集中缺少目标标签：{target}")

        feature_selects = []
        for feature in features:
            if feature in ("trend_uptrend", "trend_downtrend", "trend_range"):
                continue
            if feature in columns:
                feature_selects.append(f"COALESCE({feature}, 0) AS {feature}")
            else:
                feature_selects.append(f"0 AS {feature}")
        feature_sql = ",\n              ".join(feature_selects)

        rows = conn.execute(
            f"""
            SELECT
              symbol,
              name,
              market,
              asset_type,
              trade_date,
              close,
              dataset_split,
              future_ret_20d,
              max_drawdown_20d,
              label_break_safety_20d,
              label_fake_breakout_10d,
              {target} AS target_label,
              {feature_sql},
              COALESCE(trend_phase, 'unknown') AS trend_phase,
              CASE WHEN trend_phase = 'uptrend' THEN 1 ELSE 0 END AS trend_uptrend,
              CASE WHEN trend_phase = 'downtrend' THEN 1 ELSE 0 END AS trend_downtrend,
              CASE WHEN trend_phase = 'range' THEN 1 ELSE 0 END AS trend_range
            FROM financial_ml_dataset
            WHERE asset_type = ?
              AND dataset_split IN ('validation', 'test')
              AND {target} IS NOT NULL
            ORDER BY trade_date DESC, symbol ASC
            LIMIT ?
            """,
            (domain, limit),
        ).fetchall()
        if not rows:
            raise RuntimeError("没有可复盘的验证/测试样本，请先完成训练集切分和模型落库。")

        matrix = np.asarray([[float(row[feature] or 0) for feature in features] for row in rows], dtype=np.float32)
        return rows, matrix
    finally:
        conn.close()


def row_payload(row, probability):
    return {
        "symbol": row["symbol"],
        "name": row["name"],
        "market": row["market"],
        "tradeDate": row["trade_date"],
        "split": row["dataset_split"],
        "close": row["close"],
        "probability": float(probability),
        "targetLabel": int(row["target_label"]),
        "futureRet20d": number(row["future_ret_20d"]),
        "maxDrawdown20d": number(row["max_drawdown_20d"]),
        "structureScore": number(row["structure_score"], 2) if "structure_score" in row.keys() else None,
        "safetyZonePos": number(row["safety_zone_pos"], 4) if "safety_zone_pos" in row.keys() else None,
        "inSafetyZone": bool(row["in_safety_zone"]) if "in_safety_zone" in row.keys() else False,
        "trendPhase": row["trend_phase"],
        "breakSafety": bool(row["label_break_safety_20d"]) if "label_break_safety_20d" in row.keys() else False,
        "fakeBreakout": bool(row["label_fake_breakout_10d"]) if "label_fake_breakout_10d" in row.keys() else False,
    }


def summarize(items):
    if not items:
        return {
            "count": 0,
            "positiveRate": None,
            "avgProbability": None,
            "avgStructureScore": None,
            "avgFutureRet20d": None,
            "avgMaxDrawdown20d": None,
        }
    return {
        "count": len(items),
        "positiveRate": sum(item["targetLabel"] for item in items) / len(items),
        "avgProbability": sum(item["probability"] for item in items) / len(items),
        "avgStructureScore": sum((item["structureScore"] or 0) for item in items) / len(items),
        "avgFutureRet20d": sum((item["futureRet20d"] or 0) for item in items) / len(items),
        "avgMaxDrawdown20d": sum((item["maxDrawdown20d"] or 0) for item in items) / len(items),
    }


def group_payload(title, description, items, limit):
    sliced = items[:limit]
    return {
        "title": title,
        "description": description,
        "summary": summarize(sliced),
        "items": sliced,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--model-key")
    parser.add_argument("--sample-limit", type=int, default=120000)
    parser.add_argument("--top", type=int, default=30)
    args = parser.parse_args()

    conn = connect(args.db)
    try:
        artifact = pick_artifact(conn, args.domain, args.model_key)
        feature_db = artifact["source_feature_db"]
        if not feature_db or not Path(feature_db).exists():
            raise RuntimeError("模型登记里的特征库不存在，不能生成复盘驾驶舱。")

        features = model_features(artifact)
        target = artifact["target"]
        rows, matrix = load_review_rows(feature_db, args.domain, features, target, args.sample_limit)
        model = joblib.load(artifact["model_file"])
        probabilities = model.predict_proba(matrix)[:, 1].tolist()
        items = [row_payload(row, probability) for row, probability in zip(rows, probabilities)]

        high_probability = sorted(items, key=lambda item: item["probability"], reverse=True)
        high_structure = sorted(items, key=lambda item: (item["structureScore"] or 0, item["probability"]), reverse=True)
        high_prob_low_structure = [
            item for item in high_probability
            if item["probability"] >= 0.65 and (item["structureScore"] or 0) < 45
        ]
        high_structure_low_prob = [
            item for item in high_structure
            if (item["structureScore"] or 0) >= 70 and item["probability"] < 0.45
        ]
        failed_structure = sorted(
            [
                item for item in items
                if (item["structureScore"] or 0) >= 60
                and item["inSafetyZone"]
                and item["targetLabel"] == 0
            ],
            key=lambda item: (item["futureRet20d"] or -999, item["maxDrawdown20d"] or -999),
        )

        groups = {
            "highProbability": group_payload(
                "模型高概率样本",
                "模型认为更接近当前训练目标的历史验证/测试样本。",
                high_probability,
                args.top,
            ),
            "highStructure": group_payload(
                "结构高分样本",
                "按结构评分排序，用来观察规则强样本和模型概率是否一致。",
                high_structure,
                args.top,
            ),
            "highProbabilityLowStructure": group_payload(
                "模型高但结构低",
                "模型看好、结构分偏低的冲突样本，重点防止模型学成超跌反弹。",
                high_prob_low_structure,
                args.top,
            ),
            "highStructureLowProbability": group_payload(
                "结构高但模型低",
                "规则看起来强、模型不认可的样本，重点检查是否缺少财报/产业/市场状态过滤。",
                high_structure_low_prob,
                args.top,
            ),
            "failedStructure": group_payload(
                "结构安全区失败样本",
                "结构分>=60且安全区内，但没有达成训练目标的样本。",
                failed_structure,
                args.top,
            ),
        }

        print(json.dumps({
            "success": True,
            "data": {
                "domain": args.domain,
                "modelKey": artifact["model_key"],
                "modelType": artifact["model_type"],
                "target": target,
                "targetText": TARGET_TEXT.get(target, target),
                "sampled": len(items),
                "featureDb": feature_db,
                "groups": groups,
            },
        }, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
