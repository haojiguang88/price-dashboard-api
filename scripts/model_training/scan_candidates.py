#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path

import joblib
import numpy as np

from predict import MODEL_FEATURES, connect, model_features, pick_artifact


def latest_rows(feature_db_path, domain, features, limit):
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
        rows = conn.execute(
            f"""
            WITH ranked AS (
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
                CASE WHEN trend_phase = 'range' THEN 1 ELSE 0 END AS trend_range,
                ROW_NUMBER() OVER (PARTITION BY symbol, asset_type ORDER BY trade_date DESC) AS rn
              FROM financial_ml_features
              WHERE asset_type = ?
            )
            SELECT *
            FROM ranked
            WHERE rn = 1
            ORDER BY symbol
            LIMIT ?
            """,
            (domain, limit),
        ).fetchall()
        matrix = np.asarray([[float(row[feature] or 0) for feature in features] for row in rows], dtype=np.float32)
        return rows, matrix
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--model-key")
    parser.add_argument("--limit", type=int, default=5000)
    parser.add_argument("--top", type=int, default=30)
    args = parser.parse_args()

    conn = connect(args.db)
    try:
        artifact = pick_artifact(conn, args.domain, args.model_key)
        feature_db = artifact["source_feature_db"]
        if not feature_db or not Path(feature_db).exists():
            raise RuntimeError("模型登记里的特征库不存在，不能扫描候选。")
        features = model_features(artifact)
        rows, matrix = latest_rows(feature_db, args.domain, features, args.limit)
        if len(rows) == 0:
            raise RuntimeError("没有可扫描的最新特征行。")

        model = joblib.load(artifact["model_file"])
        probabilities = model.predict_proba(matrix)[:, 1].tolist()
        candidates = []
        for row, probability in zip(rows, probabilities):
            candidates.append({
                "symbol": row["symbol"],
                "name": row["name"],
                "market": row["market"],
                "tradeDate": row["trade_date"],
                "close": row["close"],
                "probability": float(probability),
                "structureScore": row["structure_score"] if "structure_score" in row.keys() else None,
                "trendPhase": row["trend_phase"],
                "inSafetyZone": bool(row["in_safety_zone"]) if "in_safety_zone" in row.keys() else False,
                "safetyZonePos": row["safety_zone_pos"] if "safety_zone_pos" in row.keys() else None,
            })
        candidates.sort(key=lambda item: item["probability"], reverse=True)
        print(json.dumps({
            "success": True,
            "data": {
                "domain": args.domain,
                "modelKey": artifact["model_key"],
                "modelType": artifact["model_type"],
                "scanned": len(rows),
                "items": candidates[:args.top],
            },
        }, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
