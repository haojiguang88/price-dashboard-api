#!/usr/bin/env python3
"""Load a DevTools trading-history JSON into market_trades. No network calls."""
import argparse
import json
import os
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SOURCE_KEY = "qiandao_popmart"
ROOT = Path(__file__).resolve().parents[3]
SHANGHAI = ZoneInfo("Asia/Shanghai")
DEFAULT_DB = os.environ.get("BUSINESS_DB_PATH") or str(ROOT / "data" / "price_dashboard_business_dev.db")


def external_id(row, duplicate_index):
    parts = [
        str(row["spu_id"]),
        str(row["tradingTime"]),
        str(row["tradingAmount"]),
        "1" if row.get("isAcquisition") else "0",
        str(row.get("buyerName") or ""),
        str(row.get("sellerName") or ""),
    ]
    if duplicate_index:
        parts.append(f"#{duplicate_index}")
    return "qiandao:" + "|".join(parts)


def shanghai_stamp(trading_time):
    millis = int(str(trading_time))
    moment = datetime.fromtimestamp(millis / 1000, tz=timezone.utc).astimezone(SHANGHAI)
    return moment.replace(microsecond=0).isoformat(), moment.strftime("%Y-%m-%d")


def normalize_row(row):
    amount = row.get("tradingAmount")
    if amount is None:
        amount = row.get("price")
    buyer = str(row.get("buyerName") or "").strip()
    seller = str(row.get("sellerName") or "").strip()
    if row.get("isDealBySeller") and not seller:
        seller = str(row.get("userId") or "").strip()
    elif not buyer:
        buyer = str(row.get("userId") or "").strip()
    qty = row.get("qty")
    if qty is None:
        qty = row.get("amount") or 1
    return {
        "spu_id": row.get("spu_id"),
        "tradingTime": row.get("tradingTime"),
        "tradingAmount": amount,
        "isAcquisition": bool(row.get("isAcquisition")),
        "buyerName": buyer,
        "sellerName": seller,
        "category": row.get("category") or "",
        "object_name": row.get("object_name") or "",
        "variant_name": row.get("variant_name") or "",
        "qty": int(qty),
    }


def load_rows(path):
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = payload.get("items") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise SystemExit("JSON 里没有 items 数组")
    seen = Counter()
    prepared = []
    for raw in rows:
        row = normalize_row(raw)
        if row["tradingAmount"] is None or not row["tradingTime"] or not row["spu_id"]:
            continue
        key = (
            str(row["spu_id"]),
            str(row["tradingTime"]),
            str(row["tradingAmount"]),
            "1" if row["isAcquisition"] else "0",
            row["buyerName"],
            row["sellerName"],
        )
        duplicate_index = seen[key]
        seen[key] += 1
        traded_at, trade_date = shanghai_stamp(row["tradingTime"])
        prepared.append({
            "external_id": external_id(row, duplicate_index),
            "category": row["category"],
            "object_name": row["object_name"],
            "variant": row["variant_name"],
            "traded_at": traded_at,
            "trade_date": trade_date,
            "price": float(row["tradingAmount"]),
            "qty": row["qty"],
            "buyer_account_id": row["buyerName"] or None,
            "seller_account_id": row["sellerName"] or None,
        })
    return prepared


def import_rows(db_path, rows, dry_run):
    if dry_run:
        return len(rows)
    now = datetime.now(SHANGHAI).replace(microsecond=0).isoformat()
    conn = sqlite3.connect(db_path)
    try:
        for row in rows:
            if not row["category"] or not row["object_name"]:
                continue
            conn.execute(
                """
                INSERT INTO market_trades
                  (external_id, category, object_name, variant, source_key,
                   traded_at, trade_date, price, qty, buyer_account_id, seller_account_id,
                   created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(external_id) DO UPDATE SET
                  traded_at = excluded.traded_at,
                  trade_date = excluded.trade_date,
                  price = excluded.price,
                  qty = excluded.qty,
                  buyer_account_id = excluded.buyer_account_id,
                  seller_account_id = excluded.seller_account_id,
                  updated_at = excluded.updated_at
                """,
                (
                    row["external_id"],
                    row["category"],
                    row["object_name"],
                    row["variant"],
                    SOURCE_KEY,
                    row["traded_at"],
                    row["trade_date"],
                    row["price"],
                    row["qty"],
                    row["buyer_account_id"],
                    row.get("seller_account_id"),
                    now,
                    now,
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return len(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("json_path")
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    rows = load_rows(args.json_path)
    count = import_rows(args.db, rows, args.dry_run)
    print(f"{'dry-run ' if args.dry_run else ''}rows={count}")


if __name__ == "__main__":
    main()
