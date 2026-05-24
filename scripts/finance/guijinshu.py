#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import requests


API_URL = "https://www.dehuangshop.com/goods/getGoldAndSilver"
SOURCE_NAME = "德璜小程序贵金属"
DEFAULT_DB_PATH = "/Volumes/7100/price-dashboard-data/db/price_dashboard_dev.db"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 "
        "MicroMessenger/6.8.0(0x16080000) NetType/WIFI MiniProgramEnv/Mac "
        "MacWechat/WMPF MacWechat/3.8.8(0x13080810) XWEB/1227"
    ),
    "xweb_xhr": "1",
    "content-type": "application/json",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "referer": "https://servicewechat.com/wx9b2d507b1f88138d/85/page-frame.html",
    "accept-language": "zh-CN,zh;q=0.9",
}

TARGETS = {
    "黄金9999": {"category": "贵金属", "object": "黄金", "variant": "", "digits": 0},
    "白银": {"category": "贵金属", "object": "白银", "variant": "", "digits": 1},
}


def parse_source_time(value):
    if not value:
        return datetime.now().strftime("%Y-%m-%d"), ""
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d %H:%M")
        return parsed.strftime("%Y-%m-%d"), value
    except ValueError:
        return str(value)[:10], str(value)


def normalize_price(raw_price, digits):
    price = float(str(raw_price).replace(",", "").strip())
    return round(price, digits)


def fetch_payload():
    response = requests.get(API_URL, headers=HEADERS, timeout=20)
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") != 0:
        raise RuntimeError(payload.get("message") or "贵金属接口返回失败")
    return payload


def extract_records(payload, enabled_targets):
    records = []
    for group in payload.get("data") or []:
        for subcategory in group.get("subcategoryList") or []:
            for config in subcategory.get("configurationList") or []:
                trade_date, source_time = parse_source_time(config.get("date"))
                for item in config.get("propertyList") or []:
                    parameter = str(item.get("parameter") or "").strip()
                    if parameter not in enabled_targets:
                        continue
                    target = TARGETS[parameter]
                    raw_price = item.get("price")
                    if raw_price is None or str(raw_price).strip() == "":
                        continue
                    records.append({
                        "parameter": parameter,
                        "category": target["category"],
                        "object": target["object"],
                        "variant": target["variant"],
                        "price": normalize_price(raw_price, target["digits"]),
                        "raw_price": raw_price,
                        "trade_date": trade_date,
                        "source_time": source_time,
                        "source": SOURCE_NAME,
                    })
    return records


def ensure_master_data(conn, record):
    category = conn.execute(
        "SELECT id FROM categories WHERE name = ?",
        (record["category"],),
    ).fetchone()
    now = datetime.now().isoformat()
    if category is None:
        cursor = conn.execute(
            "INSERT INTO categories (name, created_at, updated_at) VALUES (?, ?, ?)",
            (record["category"], now, now),
        )
        category_id = cursor.lastrowid
    else:
        category_id = category[0]

    obj = conn.execute(
        "SELECT id FROM objects WHERE category_id = ? AND name = ?",
        (category_id, record["object"]),
    ).fetchone()
    if obj is None:
        conn.execute(
            "INSERT INTO objects (category_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (category_id, record["object"], now, now),
        )


def upsert_price_records(db_path, records, dry_run=False):
    inserted = 0
    updated = 0
    skipped = 0
    results = []

    if dry_run:
        for record in records:
            results.append({**record, "action": "dry_run"})
        return inserted, updated, skipped, results

    conn = sqlite3.connect(db_path)
    try:
        for record in records:
            ensure_master_data(conn, record)
            now = datetime.now().isoformat()
            existing = conn.execute(
                """
                SELECT id, price, note FROM price_records
                WHERE date = ?
                  AND category = ?
                  AND object_name = ?
                  AND COALESCE(variant, '') = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (record["trade_date"], record["category"], record["object"], record["variant"]),
            ).fetchone()

            if existing is None:
                conn.execute(
                    """
                    INSERT INTO price_records
                      (date, category, object_name, variant, price, source, note, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record["trade_date"],
                        record["category"],
                        record["object"],
                        record["variant"],
                        record["price"],
                        record["source"],
                        "",
                        now,
                        now,
                    ),
                )
                inserted += 1
                results.append({**record, "action": "insert"})
                continue

            record_id, old_price, old_note = existing
            if float(old_price) == float(record["price"]):
                if old_note and "来源时间" in str(old_note):
                    conn.execute(
                        """
                        UPDATE price_records
                        SET note = '', updated_at = ?
                        WHERE id = ?
                        """,
                        (now, record_id),
                    )
                    updated += 1
                    results.append({**record, "action": "clear_note", "id": record_id})
                    continue
                skipped += 1
                results.append({**record, "action": "skip", "id": record_id})
                continue

            conn.execute(
                """
                UPDATE price_records
                SET price = ?,
                    source = ?,
                    note = CASE WHEN note LIKE '%来源时间%' THEN '' ELSE note END,
                    updated_at = ?
                WHERE id = ?
                """,
                (record["price"], record["source"], now, record_id),
            )
            updated += 1
            results.append({**record, "action": "update", "id": record_id, "old_price": old_price})

        conn.commit()
    finally:
        conn.close()

    return inserted, updated, skipped, results


def main():
    parser = argparse.ArgumentParser(description="Fetch gold/silver prices and write commodity price records")
    parser.add_argument("--db", default=os.environ.get("DB_PATH", DEFAULT_DB_PATH), help="SQLite database path")
    parser.add_argument("--targets", default="黄金9999,白银", help="Comma separated source parameters to import")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and parse without writing database")
    args = parser.parse_args()

    db_path = Path(args.db)
    enabled_targets = {
        item.strip()
        for item in str(args.targets).split(",")
        if item.strip() in TARGETS
    }
    if not enabled_targets:
        raise RuntimeError(f"没有可导入的目标，可选：{', '.join(TARGETS.keys())}")
    if not args.dry_run and not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")

    payload = fetch_payload()
    records = extract_records(payload, enabled_targets)
    if not records:
        raise RuntimeError("贵金属接口未返回可入库的黄金/白银价格")

    inserted, updated, skipped, results = upsert_price_records(str(db_path), records, args.dry_run)
    print(json.dumps({
        "success": True,
        "message": f"商品贵金属价格更新完成：新增 {inserted}，更新 {updated}，跳过 {skipped}",
        "inserted_count": inserted,
        "updated_count": updated,
        "skipped_count": skipped,
        "records": results,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({
            "success": False,
            "message": str(exc),
        }, ensure_ascii=False))
        raise
