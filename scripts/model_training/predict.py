#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path

import joblib
import numpy as np


MODEL_FEATURES = [
    "ret_5d",
    "ret_10d",
    "ret_20d",
    "ret_60d",
    "volume_ratio_20",
    "amount_ratio_20",
    "price_pos_60",
    "price_pos_120",
    "safety_zone_pos",
    "volatility_20",
    "volatility_60",
    "ma20_slope_5d",
    "ma60_slope_20d",
    "distance_ma20",
    "distance_ma60",
    "drawdown_20d",
    "drawdown_60d",
    "breakout_20d",
    "pullback_from_20d_high",
    "limit_up_like",
    "limit_down_like",
    "in_safety_zone",
    "structure_score",
    "trend_uptrend",
    "trend_downtrend",
    "trend_range",
]

MODEL_PRIORITY = ["lightgbm_model", "random_forest", "logistic_regression"]

TARGET_TEXT = {
    "label_structure_safe_20d": "未来20日收益>5%且回撤<=8%且不跌破安全区",
    "label_ret_20d_gt_5": "未来20日收益 > 5%",
}


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def pick_artifact(conn, domain, model_key=None):
    keys = [model_key] if model_key else MODEL_PRIORITY
    for key in keys:
        row = conn.execute(
            """
            SELECT *
            FROM model_training_artifacts
            WHERE domain = ? AND model_key = ?
            """,
            (domain, key),
        ).fetchone()
        if row and row["model_file"] and Path(row["model_file"]).exists():
            return row
    raise RuntimeError(f"未找到 {domain} 可用模型文件，请先完成模型与结果落库。")


def latest_feature_row(feature_db_path, domain, symbol, trade_date=None):
    conn = connect(feature_db_path)
    try:
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(financial_ml_features)").fetchall()
        }
        feature_selects = []
        for feature in MODEL_FEATURES:
            if feature in ("trend_uptrend", "trend_downtrend", "trend_range"):
                continue
            if feature in columns:
                feature_selects.append(f"COALESCE({feature}, 0) AS {feature}")
            else:
                feature_selects.append(f"0 AS {feature}")
        feature_sql = ",\n              ".join(feature_selects)
        params = [symbol, domain]
        date_filter = ""
        if trade_date:
            date_filter = "AND trade_date <= ?"
            params.append(trade_date)
        row = conn.execute(
            f"""
            SELECT
              symbol,
              name,
              market,
              asset_type,
              trade_date,
              close,
              safety_lower,
              safety_upper,
              {feature_sql},
              COALESCE(trend_phase, 'unknown') AS trend_phase,
              CASE WHEN trend_phase = 'uptrend' THEN 1 ELSE 0 END AS trend_uptrend,
              CASE WHEN trend_phase = 'downtrend' THEN 1 ELSE 0 END AS trend_downtrend,
              CASE WHEN trend_phase = 'range' THEN 1 ELSE 0 END AS trend_range
            FROM financial_ml_features
            WHERE symbol = ?
              AND asset_type = ?
              {date_filter}
            ORDER BY trade_date DESC
            LIMIT 1
            """,
            params,
        ).fetchone()
        if not row:
            raise RuntimeError(f"未找到 {symbol} 的可预测特征，请确认该标的已进入训练样本。")
        return row
    finally:
        conn.close()


def model_features(artifact):
    model_json_path = artifact["model_json_file"] if "model_json_file" in artifact.keys() else None
    if model_json_path and Path(model_json_path).exists():
        payload = json.loads(Path(model_json_path).read_text(encoding="utf-8"))
        features = payload.get("features")
        if features:
            return features
    return MODEL_FEATURES


def row_to_features(row, features):
    return [[float(row[name] or 0) for name in features]]


def load_rule_rows(conn, domain, model_key, limit=8):
    rows = conn.execute(
        """
        SELECT source_key, rank_order, title, payload_json
        FROM model_training_rule_candidates
        WHERE domain = ?
          AND source_key IN (?, 'backtest_validation', 'backtest_test')
        ORDER BY
          CASE source_key
            WHEN ? THEN 0
            WHEN 'backtest_validation' THEN 1
            ELSE 2
          END,
          rank_order ASC
        LIMIT ?
        """,
        (domain, model_key, model_key, limit),
    ).fetchall()
    results = []
    for row in rows:
        payload = json.loads(row["payload_json"])
        results.append({
            "sourceKey": row["source_key"],
            "rankOrder": row["rank_order"],
            "title": row["title"],
            "payload": payload,
        })
    return results


def load_feature_importance(conn, domain, model_key, limit=8):
    rows = conn.execute(
        """
        SELECT feature, importance, raw_importance, rank_order
        FROM model_training_feature_importance
        WHERE domain = ? AND model_key = ?
        ORDER BY rank_order ASC
        LIMIT ?
        """,
        (domain, model_key, limit),
    ).fetchall()
    return [dict(row) for row in rows]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--model-key")
    parser.add_argument("--trade-date")
    args = parser.parse_args()

    conn = connect(args.db)
    try:
        artifact = pick_artifact(conn, args.domain, args.model_key)
        feature_db = artifact["source_feature_db"]
        if not feature_db or not Path(feature_db).exists():
            raise RuntimeError("模型登记里的特征库不存在，不能预测。")

        feature_row = latest_feature_row(feature_db, args.domain, args.symbol, args.trade_date)
        model = joblib.load(artifact["model_file"])
        features = model_features(artifact)
        matrix = np.asarray(row_to_features(feature_row, features), dtype=np.float32)
        probability = float(model.predict_proba(matrix)[0][1])

        result = {
            "domain": args.domain,
            "symbol": feature_row["symbol"],
            "name": feature_row["name"],
            "market": feature_row["market"],
            "tradeDate": feature_row["trade_date"],
            "close": feature_row["close"],
            "model": {
                "modelKey": artifact["model_key"],
                "modelType": artifact["model_type"],
                "target": artifact["target"],
                "modelFile": artifact["model_file"],
                "validationAuc": artifact["validation_auc"],
                "testAuc": artifact["test_auc"],
            },
            "prediction": {
                "target": TARGET_TEXT.get(artifact["target"], artifact["target"]),
                "probability": probability,
                "confidence": "high" if probability >= 0.65 or probability <= 0.35 else "medium",
            },
            "structure": {
                "structureScore": feature_row["structure_score"],
                "trendPhase": feature_row["trend_phase"],
                "inSafetyZone": bool(feature_row["in_safety_zone"]),
                "safetyZonePos": feature_row["safety_zone_pos"],
                "safetyLower": feature_row["safety_lower"],
                "safetyUpper": feature_row["safety_upper"],
            },
            "features": {name: feature_row[name] for name in features},
            "featureImportance": load_feature_importance(conn, args.domain, artifact["model_key"]),
            "ruleCandidates": load_rule_rows(conn, args.domain, artifact["model_key"]),
        }
        print(json.dumps({"success": True, "data": result}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
