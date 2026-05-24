#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import requests


LIST_URL = "https://xcx1406.ycdongxu.com/index.php/Api/user/newphone"
DETAIL_URL = "https://xcx1406.ycdongxu.com/index.php/Api/user/getprices"
CATEGORY_NAME = "游戏机"
SOURCE_NAME = "档口报价"
DEFAULT_DB_PATH = "/Volumes/7100/price-dashboard-data/db/price_dashboard_dev.db"

BASE_PARAMS = {
    "appId": "wxa77a15b31af3c425",
    "code": "0b1J5qFa14lTIL0meAFa1JVfow1J5qFf",
    "open_time": "1778920067494",
    "scene": "undefined",
    "key": "14834ff74f92e80cae3adc802e74b458",
    "web": "0",
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 "
        "MicroMessenger/6.8.0(0x16080000) NetType/WIFI MiniProgramEnv/Mac "
        "MacWechat/3.8.8(0x13080810) XWEB/1227"
    ),
    "xweb_xhr": "1",
    "content-type": "application/json",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "referer": "https://servicewechat.com/wxa77a15b31af3c425/16/page-frame.html",
    "accept-language": "zh-CN,zh;q=0.9",
}

SOURCE_TARGETS = [
    {"object": "Switch OLED日版红蓝", "brand": "任天堂", "name": "日版OLED", "key": "红蓝"},
    {"object": "Switch OLED日版黑白", "brand": "任天堂", "name": "日版OLED", "key": "白色"},
    {"object": "Switch日版续航灰", "brand": "任天堂", "name": "日版续航", "key": "灰色"},
    {"object": "Switch日版续航红蓝", "brand": "任天堂", "name": "日版续航", "key": "红蓝"},
    {"object": "Switch OLED港版红蓝", "brand": "任天堂", "name": "港版OLED", "key": "红蓝"},
    {"object": "Switch OLED港版黑白", "brand": "任天堂", "name": "港版OLED", "key": "白色"},
    {"object": "NS2港版单机原盒", "brand": "任天堂", "name": "Switch2港版LCD", "key": "单机标准版"},
    {"object": "NS2港版捆绑马车同捆", "brand": "任天堂", "name": "Switch2港版LCD", "key": "马里奥赛车世界套装"},
    {"object": "NS2新加坡单机原盒", "brand": "任天堂", "name": "Switch2新加坡版", "key": "单机"},
    {"object": "NS2新加坡同捆", "brand": "任天堂", "name": "Switch2新加坡版", "key": "马里奥套装"},
    {"object": "PS5国行光驱slim", "brand": "索尼", "name": "PS5国行", "key": "光驱Slim"},
    {"object": "PS5国行数字slim", "brand": "索尼", "name": "PS5国行", "key": "数字Slim"},
    {"object": "PS5 Pro国行数字", "brand": "索尼", "name": "PS5国行", "key": "PRO数字"},
    {"object": "PS5日版光驱slim", "brand": "索尼", "name": "PS5日版", "key": "光驱Slim"},
    {"object": "PS5日版数字slim", "brand": "索尼", "name": "PS5日版", "key": "数字Slim"},
    {"object": "PS5 Pro日版数字", "brand": "索尼", "name": "PS5日版", "key": "PRO数字"},
    {"object": "PS5港版光驱slim", "brand": "索尼", "name": "PS5港版", "key": "光驱Slim"},
    {"object": "PS5港版数字", "brand": "索尼", "name": "PS5港版", "key": "数字Slim"},
    {"object": "PS5 Pro港版数字", "brand": "索尼", "name": "PS5港版", "key": "PRO数字"},
]


def now_ms():
    return str(int(datetime.now().timestamp() * 1000))


def parse_source_time(value):
    if not value:
        return datetime.now().strftime("%Y-%m-%d"), ""
    text = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(text, fmt)
            return parsed.strftime("%Y-%m-%d"), text
        except ValueError:
            continue
    return text[:10], text


def normalize_text(value):
    return str(value or "").replace(" ", "").strip().lower()


def normalize_price(raw_price):
    text = str(raw_price).replace(",", "").strip()
    if not text:
        raise ValueError("价格为空")
    return round(float(text))


def fetch_json(url, params):
    response = requests.get(url, params=params, headers=HEADERS, timeout=25)
    response.raise_for_status()
    return response.json()


def fetch_source_items():
    list_params = {
        **BASE_PARAMS,
        "parent_name": "数码潮玩",
        "c_time": now_ms(),
    }
    groups = fetch_json(LIST_URL, list_params)
    flattened = []
    for group in groups or []:
        if group.get("brand") not in {"任天堂", "索尼"}:
            continue
        for mobile in group.get("mobiles") or []:
            detail_params = {
                **BASE_PARAMS,
                "id": mobile.get("id"),
                "c_time": now_ms(),
            }
            details = fetch_json(DETAIL_URL, detail_params)
            for item in details or []:
                specs = item.get("specs") or [item]
                for spec in specs:
                    flattened.append({
                        "id": spec.get("id") or item.get("id"),
                        "brand": spec.get("brand") or item.get("brand") or group.get("brand"),
                        "tab": spec.get("tab") or item.get("tab"),
                        "mobile_name": spec.get("mobile_name") or item.get("mobile_name"),
                        "key": spec.get("key") or item.get("key"),
                        "price": spec.get("price") if spec.get("price") is not None else item.get("price"),
                        "old": spec.get("old") if spec.get("old") is not None else item.get("old"),
                        "add_time": spec.get("add_time") or item.get("add_time"),
                    })
    return flattened


def load_enabled_objects(db_path, category):
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT o.name
            FROM categories c
            JOIN objects o ON o.category_id = c.id
            WHERE c.name = ?
              AND COALESCE(c.is_archived, 0) = 0
              AND COALESCE(o.is_archived, 0) = 0
            ORDER BY o.name
            """,
            (category,),
        ).fetchall()
    finally:
        conn.close()
    return {row[0] for row in rows}


def match_target(source_item, enabled_objects):
    source_brand = str(source_item.get("brand") or "")
    source_name = normalize_text(source_item.get("mobile_name"))
    source_key = normalize_text(source_item.get("key"))

    for target in SOURCE_TARGETS:
        if target["object"] not in enabled_objects:
            continue
        if target["brand"] != source_brand:
            continue
        if normalize_text(target["name"]) not in source_name:
            continue
        if normalize_text(target["key"]) not in source_key:
            continue
        return target["object"]
    return ""


def extract_records(source_items, enabled_objects, category):
    records_by_key = {}
    source_count = 0
    matched_count = 0

    for item in source_items:
        source_count += 1
        object_name = match_target(item, enabled_objects)
        if not object_name:
            continue

        raw_price = item.get("price")
        if raw_price is None or str(raw_price).strip() == "":
            continue
        price = normalize_price(raw_price)
        if price <= 0:
            continue

        trade_date, source_time = parse_source_time(item.get("add_time"))
        matched_count += 1
        key = (trade_date, category, object_name, "")
        records_by_key[key] = {
            "category": category,
            "object": object_name,
            "variant": "",
            "price": price,
            "raw_price": raw_price,
            "trade_date": trade_date,
            "source_time": source_time,
            "source": SOURCE_NAME,
            "source_id": item.get("id"),
            "source_mobile_name": item.get("mobile_name"),
            "source_key": item.get("key"),
        }

    records = list(records_by_key.values())
    return records, source_count, matched_count, max(source_count - matched_count, 0)


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
            now = datetime.now().isoformat()
            existing = conn.execute(
                """
                SELECT id, price
                FROM price_records
                WHERE date = ?
                  AND category = ?
                  AND object_name = ?
                  AND COALESCE(variant, '') = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (
                    record["trade_date"],
                    record["category"],
                    record["object"],
                    record["variant"],
                ),
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

            record_id, old_price = existing
            if float(old_price) == float(record["price"]):
                skipped += 1
                results.append({**record, "action": "skip", "id": record_id})
                continue

            conn.execute(
                """
                UPDATE price_records
                SET price = ?,
                    source = ?,
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
    parser = argparse.ArgumentParser(description="Fetch video game console prices and write commodity price records")
    parser.add_argument("--db", default=os.environ.get("DB_PATH", DEFAULT_DB_PATH), help="SQLite database path")
    parser.add_argument("--category", default=CATEGORY_NAME, help="Commodity category name")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and parse without writing database")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")

    enabled_objects = load_enabled_objects(str(db_path), args.category)
    if not enabled_objects:
        raise RuntimeError(f"系统里没有启用的{args.category}型号")

    source_items = fetch_source_items()
    records, source_count, matched_count, filtered_count = extract_records(source_items, enabled_objects, args.category)
    if not records:
        raise RuntimeError("游戏机接口未返回可匹配系统型号的价格")

    inserted, updated, skipped, results = upsert_price_records(str(db_path), records, args.dry_run)
    target_objects = {target["object"] for target in SOURCE_TARGETS}
    unmapped_enabled_objects = sorted(enabled_objects - target_objects)

    print(json.dumps({
        "success": True,
        "message": (
            f"游戏机价格更新完成：新增 {inserted}，更新 {updated}，跳过 {skipped}，"
            f"过滤 {filtered_count}"
        ),
        "inserted_count": inserted,
        "updated_count": updated,
        "skipped_count": skipped,
        "source_count": source_count,
        "matched_count": matched_count,
        "filtered_count": filtered_count,
        "unmapped_enabled_objects": unmapped_enabled_objects,
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
