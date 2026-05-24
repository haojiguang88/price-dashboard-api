#!/usr/bin/env python3
import argparse
import json
import shutil
import time
from pathlib import Path

from predict import connect, pick_artifact
from run_pipeline import run_feature_table


def latest_feature_trade_date(feature_db_path, domain):
    path = Path(feature_db_path)
    if not path.exists() or path.stat().st_size <= 0:
        return {
            "latest_trade_date": None,
            "rows": 0,
            "exists": path.exists(),
            "size_bytes": path.stat().st_size if path.exists() else 0,
        }
    conn = connect(feature_db_path)
    try:
        row = conn.execute(
            """
            SELECT MAX(trade_date) AS latest_trade_date, COUNT(*) AS rows
            FROM financial_ml_features
            WHERE asset_type = ?
            """,
            (domain,),
        ).fetchone()
        return {
            "latest_trade_date": row["latest_trade_date"] if row else None,
            "rows": int(row["rows"] or 0) if row else 0,
            "exists": True,
            "size_bytes": path.stat().st_size,
        }
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--domain", choices=["stock", "etf"], required=True)
    parser.add_argument("--model-key")
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    conn = connect(args.db)
    try:
        artifact = pick_artifact(conn, args.domain, args.model_key)
        feature_db_path = artifact["source_feature_db"]
        if not feature_db_path:
            raise RuntimeError("模型登记里没有 source_feature_db，无法定位要刷新的特征库。")
        feature_path = Path(feature_db_path)
        if args.check_only:
            summary = latest_feature_trade_date(feature_db_path, args.domain)
            print(json.dumps({
                "success": True,
                "data": {
                    "domain": args.domain,
                    "modelKey": artifact["model_key"],
                    "runId": artifact["run_id"],
                    "featureDb": feature_db_path,
                    "latestTradeDate": summary["latest_trade_date"],
                    "rows": summary["rows"],
                    "exists": summary["exists"],
                    "sizeBytes": summary["size_bytes"],
                    "checkedOnly": True,
                },
            }, ensure_ascii=False))
            return
        output_dir = feature_path.parent
        temp_dir = output_dir / f".feature-refresh-{args.domain}-{int(time.time())}"
        temp_feature_path = temp_dir / "features.sqlite"
        try:
            note = run_feature_table(conn, args.domain, str(temp_dir))
            if not temp_feature_path.exists() or temp_feature_path.stat().st_size <= 0:
                raise RuntimeError("临时特征库生成失败，已保留原特征库。")
            backup_path = output_dir / "features.sqlite.bak"
            if feature_path.exists() and feature_path.stat().st_size > 0:
                shutil.copy2(feature_path, backup_path)
            temp_feature_path.replace(feature_path)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
    finally:
        conn.close()

    summary = latest_feature_trade_date(feature_db_path, args.domain)
    print(json.dumps({
        "success": True,
        "data": {
            "domain": args.domain,
            "modelKey": artifact["model_key"],
            "runId": artifact["run_id"],
            "featureDb": feature_db_path,
            "latestTradeDate": summary["latest_trade_date"],
            "rows": summary["rows"],
            "note": note,
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
