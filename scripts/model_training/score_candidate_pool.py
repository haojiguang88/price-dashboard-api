#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path

import joblib
import numpy as np

from predict import connect, latest_feature_row, model_features, pick_artifact


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--rule-version", default="candidate_pool_v1")
    parser.add_argument("--domain", choices=["stock", "etf"])
    parser.add_argument("--model-key")
    parser.add_argument("--pool-status", choices=["active", "expired", "all"], default="active")
    parser.add_argument("--limit", type=int, default=500)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        params = [args.rule_version]
        domain_filter = ""
        status_filter = ""
        if args.pool_status != "all":
            status_filter = " AND pool_status = ?"
            params.append(args.pool_status)
        if args.domain:
            domain_filter = " AND asset_type = ?"
            params.append(args.domain)
        params.append(args.limit)
        rows = conn.execute(
            f"""
            SELECT symbol, name, asset_type, source
            FROM financial_candidate_pool
            WHERE rule_version = ?
              {status_filter}
              {domain_filter}
            ORDER BY priority_score DESC, last_checked_at DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
    finally:
        conn.close()

    model_cache = {}
    scores = {}
    for row in rows:
        domain = row["asset_type"]
        key = f"{row['symbol']}|{row['asset_type']}|{row['source']}"
        if domain not in ("stock", "etf"):
            scores[key] = {"available": False, "reason": "该资产类型暂未接入模型"}
            continue

        if domain not in model_cache:
            main_conn = connect(args.db)
            try:
                artifact = pick_artifact(main_conn, domain, args.model_key if args.domain == domain else None)
                model_cache[domain] = {
                    "artifact": artifact,
                    "model": joblib.load(artifact["model_file"]),
                    "features": model_features(artifact),
                }
            except Exception as exc:
                model_cache[domain] = {"error": str(exc)}
            finally:
                main_conn.close()

        cached = model_cache[domain]
        if cached.get("error"):
            scores[key] = {"available": False, "reason": cached["error"]}
            continue

        artifact = cached["artifact"]
        try:
            feature_row = latest_feature_row(artifact["source_feature_db"], domain, row["symbol"])
            matrix = np.asarray([[float(feature_row[feature] or 0) for feature in cached["features"]]], dtype=np.float32)
            probability = float(cached["model"].predict_proba(matrix)[0][1])
            scores[key] = {
                "available": True,
                "probability": probability,
                "modelKey": artifact["model_key"],
                "target": artifact["target"],
                "tradeDate": feature_row["trade_date"],
            }
        except Exception as exc:
            scores[key] = {"available": False, "reason": str(exc)}

    print(json.dumps({"success": True, "data": {"scores": scores}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
