#!/usr/bin/env python3
import argparse
import json
import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path

import requests

try:
    from source_mappings import (
        load_enabled_source_mappings,
        mark_source_mapping_errors,
        mark_source_mappings_matched,
        mark_source_mappings_seen,
        mark_source_run_error,
    )
except ImportError:
    load_enabled_source_mappings = None
    mark_source_mapping_errors = None
    mark_source_mappings_matched = None
    mark_source_mappings_seen = None
    mark_source_run_error = None


API_URL = "https://api.cshrich.online/miniapp/price/catalog"
IPHONE_CATEGORY_NAME = "苹果手机"
GAME_CATEGORY_NAME = "游戏机"
IPHONE_SOURCE_KEY = "cshrich_iphone_backup"
GAME_SOURCE_KEY = "cshrich_game_console_backup"
IPHONE_SOURCE_NAME = "潮收汇苹果备用报价"
GAME_SOURCE_NAME = "潮收汇游戏机备用报价"
DEFAULT_DB_PATH = (
    os.environ.get("BUSINESS_DB_PATH")
    or str(Path(__file__).resolve().parents[2] / "data" / "price_dashboard_business.db")
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
        "MicroMessenger/8.0.62(0x18003e3a) NetType/WIFI Language/zh_CN"
    ),
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Referer": "https://servicewechat.com/wx1a757c4f909fb3a4/12/page-frame.html",
}

COLOR_ALIASES = {
    "深青色": "深青色",
    "青绿色": "深青色",
    "青色": "深青色",
    "群青": "群青色",
    "群青色": "群青色",
    "沙漠色": "沙色",
    "沙漠": "沙色",
    "原色钛": "原色",
    "原色钛金属": "原色",
    "黑钛": "黑色",
    "白钛": "白色",
}

DEFAULT_GAME_TARGETS = [
    {
        "object": "NS2港版单机原盒",
        "series_name": "任天堂",
        "model_name": "Switch2 游戏机",
        "variant_key": "单机标准版",
    },
    {
        "object": "NS2港版捆绑马车同捆",
        "series_name": "任天堂",
        "model_name": "港版Nintendo Switch2马车世界包装",
        "variant_key": "BEE-S-KB6LA-HKG",
    },
    {
        "object": "NS2新加坡单机原盒",
        "series_name": "任天堂",
        "model_name": "Switch2 游戏机",
        "variant_key": "新加坡版标准",
    },
]


def normalize_text(value):
    return str(value or "").replace(" ", "").strip().lower()


def normalize_price(raw_price):
    text = str(raw_price).replace(",", "").strip()
    if not text:
        raise ValueError("价格为空")
    return round(float(text))


def normalize_storage(value):
    match = re.search(r"(\d+)\s*(TB|T|G)", str(value or ""), flags=re.IGNORECASE)
    if not match:
        return ""
    unit = match.group(2).upper()
    if unit == "T":
        unit = "TB"
    return f"{match.group(1)}{unit}"


def normalize_iphone_model_name(name):
    text = str(name or "").strip()
    text = text.replace("ProMax", "Pro Max")
    text = text.replace("Promax", "Pro Max")
    text = text.replace("PRO MAX", "Pro Max")
    text = text.replace("PRO", "Pro")
    text = re.sub(r"iPhone(\d+)", r"iPhone \1", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def build_iphone_object_name(source_name):
    compact = re.sub(r"\s+", "", str(source_name or ""))
    match = re.search(r"iPhone(\d+)(ProMax|Pro|Plus)?(\d+)(TB|T|G)", compact, flags=re.IGNORECASE)
    if not match:
        return ""
    generation = match.group(1)
    tier = (match.group(2) or "").lower()
    storage_unit = match.group(4).upper()
    if storage_unit == "T":
        storage_unit = "TB"
    storage = f"{match.group(3)}{storage_unit}"
    tier_text = ""
    if tier == "promax":
        tier_text = " Pro Max"
    elif tier == "pro":
        tier_text = " Pro"
    elif tier == "plus":
        tier_text = " Plus"
    return f"iPhone {generation}{tier_text} {storage}"


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
        if variant and (variant in color or color in variant):
            return variant

    return ""


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

    current_year = datetime.now().year
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(f"{current_year}-{text}", fmt)
            return parsed.strftime("%Y-%m-%d"), text
        except ValueError:
            continue

    return text[:10], text


def fetch_catalog():
    response = requests.get(API_URL, headers=HEADERS, timeout=30)
    response.raise_for_status()
    payload = response.json()
    if payload.get("success") is not True:
        raise RuntimeError(payload.get("message") or "备用价格接口返回失败")
    data = payload.get("data") or {}
    models_by_category = data.get("modelsByCategory")
    if not isinstance(models_by_category, dict):
        raise RuntimeError("备用价格接口缺少 modelsByCategory")
    return data


def iter_catalog_items(catalog, category_id):
    models_by_category = catalog.get("modelsByCategory") or {}
    for item in models_by_category.get(str(category_id), []) or []:
        variants = item.get("variants") or []
        if not variants:
            variants = [{}]
        for variant in variants:
            yield item, variant


def load_whitelist(db_path, category):
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT o.name, COALESCE(v.name, '')
            FROM categories c
            JOIN objects o ON o.category_id = c.id
            LEFT JOIN variants v ON v.object_id = o.id
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
        whitelist.setdefault(object_name, set()).add(variant_name or "")
    return whitelist


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


def build_external_key(target):
    return f"{target['series_name']}|{target['model_name']}|{target['variant_key']}"


def load_game_targets(db_path):
    if load_enabled_source_mappings is None:
        return [{**target, "external_key": build_external_key(target)} for target in DEFAULT_GAME_TARGETS]

    mappings, configured = load_enabled_source_mappings(db_path, GAME_SOURCE_KEY)
    if not configured:
        return [{**target, "external_key": build_external_key(target)} for target in DEFAULT_GAME_TARGETS]

    targets = []
    for mapping in mappings:
        meta = mapping.get("external_meta") or {}
        object_name = str(mapping.get("object_name") or "").strip()
        series_name = str(meta.get("series_name") or "").strip()
        model_name = str(meta.get("model_name") or "").strip()
        variant_key = str(meta.get("variant_key") or "").strip()
        if not object_name or not series_name or not model_name or not variant_key:
            continue
        targets.append({
            "object": object_name,
            "series_name": series_name,
            "model_name": model_name,
            "variant_key": variant_key,
            "external_key": str(mapping.get("external_key") or f"{series_name}|{model_name}|{variant_key}").strip(),
        })
    return targets


def extract_iphone_records(catalog, whitelist, category):
    records_by_key = {}
    source_count = 0
    matched_count = 0
    stale_count = 0
    invalid_price_count = 0

    for item, variant_item in iter_catalog_items(catalog, "1"):
        if str(item.get("brandName") or "").strip() != "苹果":
            continue

        source_count += 1
        object_name = build_iphone_object_name(item.get("name"))
        allowed_variants = whitelist.get(object_name)
        if not allowed_variants:
            continue

        variant = normalize_color(variant_item.get("color"), allowed_variants)
        if not variant:
            continue

        raw_price = variant_item.get("settlementPrice") or variant_item.get("price")
        try:
            price = normalize_price(raw_price)
        except (TypeError, ValueError):
            invalid_price_count += 1
            continue
        if price <= 0:
            invalid_price_count += 1
            continue

        if variant_item.get("isOutdated") or item.get("isOutdated"):
            stale_count += 1

        price_date, source_time = parse_source_time(item.get("updatedAt") or catalog.get("meta", {}).get("updatedAt"))
        matched_count += 1
        key = (price_date, category, object_name, variant)
        records_by_key[key] = {
            "category": category,
            "object": object_name,
            "variant": variant,
            "price": price,
            "raw_price": raw_price,
            "price_date": price_date,
            "source_time": source_time,
            "source": IPHONE_SOURCE_NAME,
            "source_key": IPHONE_SOURCE_KEY,
            "source_model_id": item.get("id"),
            "source_model_name": item.get("name"),
            "source_variant_id": variant_item.get("skuId"),
            "source_variant_name": variant_item.get("color"),
            "source_is_outdated": bool(variant_item.get("isOutdated") or item.get("isOutdated")),
        }

    return list(records_by_key.values()), source_count, matched_count, max(source_count - matched_count, 0), stale_count, invalid_price_count


def match_game_target(item, variant_item, enabled_objects, source_targets):
    source_series = normalize_text(item.get("seriesName"))
    source_name = normalize_text(item.get("name"))
    source_variant = normalize_text(variant_item.get("color"))

    for target in source_targets:
        if target["object"] not in enabled_objects:
            continue
        if normalize_text(target["series_name"]) not in source_series:
            continue
        if normalize_text(target["model_name"]) not in source_name:
            continue
        if normalize_text(target["variant_key"]) not in source_variant:
            continue
        return target
    return None


def extract_game_records(catalog, enabled_objects, category, source_targets):
    records_by_key = {}
    source_count = 0
    matched_count = 0
    stale_count = 0
    invalid_price_count = 0
    seen_external_keys = set()
    missing_errors = {}
    invalid_price_keys = set()

    for item, variant_item in iter_catalog_items(catalog, "181"):
        if str(item.get("seriesName") or "").strip() != "任天堂":
            continue
        source_count += 1
        target = match_game_target(item, variant_item, enabled_objects, source_targets)
        if not target:
            continue

        external_key = target["external_key"]
        seen_external_keys.add(external_key)
        raw_price = variant_item.get("settlementPrice") or variant_item.get("price")
        try:
            price = normalize_price(raw_price)
        except (TypeError, ValueError):
            invalid_price_count += 1
            invalid_price_keys.add(external_key)
            continue
        if price <= 0:
            invalid_price_count += 1
            invalid_price_keys.add(external_key)
            continue

        if variant_item.get("isOutdated") or item.get("isOutdated"):
            stale_count += 1

        price_date, source_time = parse_source_time(item.get("updatedAt") or catalog.get("meta", {}).get("updatedAt"))
        matched_count += 1
        key = (price_date, category, target["object"], "")
        records_by_key[key] = {
            "category": category,
            "object": target["object"],
            "variant": "",
            "price": price,
            "raw_price": raw_price,
            "price_date": price_date,
            "source_time": source_time,
            "source": GAME_SOURCE_NAME,
            "source_key": GAME_SOURCE_KEY,
            "source_model_id": item.get("id"),
            "source_model_name": item.get("name"),
            "source_variant_id": variant_item.get("skuId"),
            "source_variant_name": variant_item.get("color"),
            "source_is_outdated": bool(variant_item.get("isOutdated") or item.get("isOutdated")),
            "mapping_external_key": external_key,
        }

    missing_external_keys = {target["external_key"] for target in source_targets} - seen_external_keys
    for external_key in missing_external_keys:
        missing_errors[external_key] = "本次备用来源未出现该外部项"

    return (
        list(records_by_key.values()),
        source_count,
        matched_count,
        max(source_count - matched_count, 0),
        stale_count,
        invalid_price_count,
        sorted(seen_external_keys),
        missing_errors,
        sorted(invalid_price_keys),
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
                    record["price_date"],
                    record["category"],
                    record["object"],
                    record["variant"],
                ),
            ).fetchone()

            note = "来源标记为非当天更新" if record.get("source_is_outdated") else ""

            if existing is None:
                conn.execute(
                    """
                    INSERT INTO price_records
                      (date, category, object_name, variant, price, source, note, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record["price_date"],
                        record["category"],
                        record["object"],
                        record["variant"],
                        record["price"],
                        record["source"],
                        note,
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
                    note = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (record["price"], record["source"], note, now, record_id),
            )
            updated += 1
            results.append({**record, "action": "update", "id": record_id, "old_price": old_price})

        conn.commit()
    finally:
        conn.close()

    return inserted, updated, skipped, results


def output_skipped(message, **extra):
    payload = {
        "success": True,
        "status": "skipped",
        "skipped": True,
        "message": message,
        "inserted_count": 0,
        "updated_count": 0,
        "skipped_count": 0,
        "source_count": 0,
        "matched_count": 0,
        "filtered_count": 0,
        "records": [],
    }
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False))


def run_iphone_backup(db_path, category, dry_run):
    whitelist = load_whitelist(db_path, category)
    if not whitelist:
        raise RuntimeError(f"系统里没有启用的{category}型号/颜色")

    catalog = fetch_catalog()
    records, source_count, matched_count, filtered_count, stale_count, invalid_price_count = extract_iphone_records(
        catalog,
        whitelist,
        category,
    )
    if not records:
        raise RuntimeError("苹果手机备用接口未返回可匹配系统型号/颜色的可用价格")

    inserted, updated, skipped, results = upsert_price_records(db_path, records, dry_run)
    print(json.dumps({
        "success": True,
        "source_key": IPHONE_SOURCE_KEY,
        "message": (
            f"苹果手机备用源更新完成：新增 {inserted}，更新 {updated}，跳过 {skipped}，"
            f"过滤 {filtered_count}"
        ),
        "inserted_count": inserted,
        "updated_count": updated,
        "skipped_count": skipped,
        "source_count": source_count,
        "matched_count": matched_count,
        "filtered_count": filtered_count,
        "stale_count": stale_count,
        "invalid_price_count": invalid_price_count,
        "records": results,
    }, ensure_ascii=False))


def run_game_backup(db_path, category, dry_run):
    enabled_objects = load_enabled_objects(db_path, category)
    if not enabled_objects:
        output_skipped(f"系统里没有启用的{category}型号，本次游戏机备用源已跳过")
        return

    source_targets = load_game_targets(db_path)
    if not source_targets:
        output_skipped("游戏机备用源已跳过：当前没有启用的数据源映射")
        return

    catalog = fetch_catalog()
    try:
        (
            records,
            source_count,
            matched_count,
            filtered_count,
            stale_count,
            invalid_price_count,
            seen_external_keys,
            missing_errors,
            invalid_price_keys,
        ) = extract_game_records(catalog, enabled_objects, category, source_targets)
    except Exception as exc:
        if not dry_run and mark_source_run_error is not None:
            mark_source_run_error(db_path, GAME_SOURCE_KEY, f"游戏机备用源更新失败：{exc}")
        raise

    if not dry_run and mark_source_mappings_seen is not None:
        mark_source_mappings_seen(db_path, GAME_SOURCE_KEY, seen_external_keys)

    if not records:
        if not dry_run and mark_source_mapping_errors is not None:
            mark_source_mapping_errors(db_path, GAME_SOURCE_KEY, missing_errors)
        output_skipped(
            "游戏机备用源未返回可入库价格，本次跳过",
            source_count=source_count,
            matched_count=matched_count,
            filtered_count=filtered_count,
            stale_count=stale_count,
            invalid_price_count=invalid_price_count,
            invalid_price_keys=invalid_price_keys,
            missing_errors=missing_errors,
        )
        return

    inserted, updated, skipped, results = upsert_price_records(db_path, records, dry_run)
    matched_external_keys = {record["mapping_external_key"] for record in records}
    if not dry_run:
        if mark_source_mappings_matched is not None:
            mark_source_mappings_matched(db_path, GAME_SOURCE_KEY, matched_external_keys)
        if mark_source_mapping_errors is not None:
            mark_source_mapping_errors(db_path, GAME_SOURCE_KEY, {
                key: message
                for key, message in missing_errors.items()
                if key not in matched_external_keys
            })

    target_objects = {target["object"] for target in source_targets}
    unmapped_enabled_objects = sorted(enabled_objects - target_objects)
    print(json.dumps({
        "success": True,
        "source_key": GAME_SOURCE_KEY,
        "message": (
            f"游戏机备用源更新完成：新增 {inserted}，更新 {updated}，跳过 {skipped}，"
            f"过滤 {filtered_count}"
        ),
        "inserted_count": inserted,
        "updated_count": updated,
        "skipped_count": skipped,
        "source_count": source_count,
        "matched_count": matched_count,
        "filtered_count": filtered_count,
        "stale_count": stale_count,
        "invalid_price_count": invalid_price_count,
        "invalid_price_keys": invalid_price_keys,
        "unmapped_enabled_objects": unmapped_enabled_objects,
        "records": results,
    }, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description="Fetch backup commodity prices from CSHRich catalog")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help="SQLite database path")
    parser.add_argument("--category", default=IPHONE_CATEGORY_NAME, help="Commodity category name")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and parse without writing database")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")

    category = str(args.category or "").strip()
    if category == IPHONE_CATEGORY_NAME:
        run_iphone_backup(str(db_path), category, args.dry_run)
        return
    if category == GAME_CATEGORY_NAME:
        run_game_backup(str(db_path), category, args.dry_run)
        return
    raise RuntimeError(f"备用源暂不支持品类：{category}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({
            "success": False,
            "message": str(exc),
        }, ensure_ascii=False))
        raise
