#!/usr/bin/env python3
import argparse
import json
import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path

import requests


API_URL = "https://www.dehuangshop.com/goods/data"
CATEGORY_NAME = "苹果手机"
SOURCE_NAME = "档口报价"
DEFAULT_DB_PATH = os.environ.get(
    "BUSINESS_DB_PATH",
    os.environ.get("DB_PATH", "/Volumes/7100/price-dashboard-data/db/price_dashboard_business_dev.db"),
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 "
        "MicroMessenger/6.8.0(0x16080000) NetType/WIFI MiniProgramEnv/Mac "
        "MacWechat/3.8.8(0x13080810) XWEB/1227"
    ),
    "Content-Type": "application/json",
    "xweb_xhr": "1",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "referer": "https://servicewechat.com/wx9b2d507b1f88138d/85/page-frame.html",
    "accept-language": "zh-CN,zh;q=0.9",
}

COLOR_ALIASES = {
    "青雾蓝色": "蓝色",
    "深蓝色": "蓝色",
    "鼠尾草绿色": "绿色",
    "薰衣草紫色": "紫色",
    "星宇橙色": "橙色",
    "沙漠色": "沙色",
}


def fetch_payload():
    response = requests.post(API_URL, data=json.dumps({}), headers=HEADERS, timeout=25)
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") != 0:
        raise RuntimeError(payload.get("message") or "苹果手机接口返回失败")
    return payload


def parse_source_time(value):
    if not value:
        return datetime.now().strftime("%Y-%m-%d"), ""
    text = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(text, fmt)
            return parsed.strftime("%Y-%m-%d"), text
        except ValueError:
            continue
    return text[:10], text


def normalize_model_name(name):
    text = str(name or "").strip()
    text = re.sub(r"\d+(?:\.\d+)?寸", "", text)
    text = text.replace("ProMax", "Pro Max")
    text = text.replace("Pro max", "Pro Max")
    text = re.sub(r"iPhone\s*(\d+)", r"iPhone \1", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def normalize_storage(value):
    match = re.search(r"(\d+)\s*(G|T)", str(value or ""), flags=re.IGNORECASE)
    if not match:
        return "", ""
    storage = f"{match.group(1)}{match.group(2).upper()}"
    rest = f"{value[:match.start()]}{value[match.end():]}"
    return storage, rest


def normalize_color(value, allowed_variants):
    color = str(value or "").strip()
    color = re.sub(r"[\s+/\\_-]+", "", color)
    color = color.replace("钛金属", "").replace("金属", "")
    if color in allowed_variants:
        return color

    alias = COLOR_ALIASES.get(color)
    if alias and alias in allowed_variants:
        return alias

    for variant in allowed_variants:
        if variant and variant in color:
            return variant

    return ""


def normalize_price(raw_price):
    text = str(raw_price).replace(",", "").strip()
    if not text:
        raise ValueError("价格为空")
    return round(float(text))


def load_whitelist(db_path, category):
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT o.name, v.name
            FROM categories c
            JOIN objects o ON o.category_id = c.id
            JOIN variants v ON v.object_id = o.id
            WHERE c.name = ?
              AND COALESCE(c.is_archived, 0) = 0
              AND COALESCE(o.is_archived, 0) = 0
              AND COALESCE(v.is_archived, 0) = 0
            ORDER BY o.name, v.name
            """,
            (category,),
        ).fetchall()
    finally:
        conn.close()

    whitelist = {}
    for object_name, variant_name in rows:
        whitelist.setdefault(object_name, set()).add(variant_name)
    return whitelist


def iter_iphone_configs(payload):
    for group in payload.get("data") or []:
        if str(group.get("name") or "").strip() != "苹果":
            continue
        for subcategory in group.get("subcategoryList") or []:
            for config in subcategory.get("configurationList") or []:
                model_name = normalize_model_name(config.get("name"))
                if not model_name.startswith("iPhone "):
                    continue
                yield model_name, config


def extract_records(payload, whitelist, category):
    records_by_key = {}
    source_count = 0
    matched_count = 0

    for model_name, config in iter_iphone_configs(payload):
        trade_date, source_time = parse_source_time(config.get("date"))
        for item in config.get("propertyList") or []:
            source_count += 1
            parameter = str(item.get("parameter") or "").strip()
            storage, color_part = normalize_storage(parameter)
            if not storage:
                continue

            object_name = f"{model_name} {storage}"
            allowed_variants = whitelist.get(object_name)
            if not allowed_variants:
                continue

            variant = normalize_color(color_part, allowed_variants)
            if not variant:
                continue

            raw_price = item.get("price")
            if raw_price is None or str(raw_price).strip() == "":
                continue

            price = normalize_price(raw_price)
            matched_count += 1
            key = (trade_date, category, object_name, variant)
            records_by_key[key] = {
                "category": category,
                "object": object_name,
                "variant": variant,
                "price": price,
                "raw_price": raw_price,
                "trade_date": trade_date,
                "source_time": source_time,
                "source": SOURCE_NAME,
                "source_model": model_name,
                "source_parameter": parameter,
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
    parser = argparse.ArgumentParser(description="Fetch iPhone prices and write commodity price records")
    parser.add_argument("--db", default=os.environ.get("DB_PATH", DEFAULT_DB_PATH), help="SQLite database path")
    parser.add_argument("--category", default=CATEGORY_NAME, help="Commodity category name")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and parse without writing database")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")

    whitelist = load_whitelist(str(db_path), args.category)
    if not whitelist:
        raise RuntimeError(f"系统里没有启用的{args.category}型号/颜色")

    payload = fetch_payload()
    records, source_count, matched_count, filtered_count = extract_records(payload, whitelist, args.category)
    if not records:
        raise RuntimeError("苹果手机接口未返回可匹配系统型号/颜色的价格")

    inserted, updated, skipped, results = upsert_price_records(str(db_path), records, args.dry_run)
    print(json.dumps({
        "success": True,
        "message": (
            f"苹果手机价格更新完成：新增 {inserted}，更新 {updated}，跳过 {skipped}，"
            f"过滤 {filtered_count}"
        ),
        "inserted_count": inserted,
        "updated_count": updated,
        "skipped_count": skipped,
        "source_count": source_count,
        "matched_count": matched_count,
        "filtered_count": filtered_count,
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
