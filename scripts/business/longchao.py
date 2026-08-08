#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

from source_mappings import (
    load_enabled_source_mappings,
    mark_source_mapping_errors,
    mark_source_mappings_matched,
    mark_source_mappings_seen,
    mark_source_run_error,
)

API_URL = "https://w.airmb.com/sw/goods/sys-presale/preGoodsPriceRecord"
LINE_API_URL = "https://w.airmb.com/sw/goods/sys-presale/preGoodsPriceRecordLine"
SOURCE_KEY = "airmb_longchao_presale"
SOURCE_NAME = "爱藏龙钞"
DEFAULT_CATEGORY = "纪念钞"
DEFAULT_OBJECT = "龙钞"
DEFAULT_VARIANT = "散张"
DEFAULT_GOODS_ID = "1"
DEFAULT_CAT_ID = "3"
DEFAULT_EXTERNAL_KEY = f"{DEFAULT_GOODS_ID}|{DEFAULT_CAT_ID}|{DEFAULT_VARIANT}"
CHINA_TZ = timezone(timedelta(hours=8))
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = os.environ.get(
    "BUSINESS_DB_PATH",
    os.environ.get("DB_PATH", str(REPO_ROOT / "data" / "price_dashboard_business_dev.db")),
)

DEFAULT_SOURCE_TARGETS = [
    {
        "external_key": DEFAULT_EXTERNAL_KEY,
        "external_name": "龙钞散张",
        "category": DEFAULT_CATEGORY,
        "object": DEFAULT_OBJECT,
        "variant": DEFAULT_VARIANT,
        "goods_id": DEFAULT_GOODS_ID,
        "cat_id": DEFAULT_CAT_ID,
            "source_name": SOURCE_NAME,
    }
]


def build_headers():
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
            "AirmbMessenger/6.0.0"
        ),
        "X-Requested-With": "XMLHttpRequest",
        "SOURCE_TYPE": "3",
        "APP_VERSION": "5.4.0",
        "Referer": (
            "https://w.airmb.com/wap/presale/priceDetail?"
            "id=1&name=%E9%BE%99%E9%92%9E&spec=%E5%8D%95%E5%BC%A0"
        ),
        "Origin": "https://w.airmb.com",
        "Accept-Language": "zh-CN,zh-Hans;q=0.9",
    }
    optional_headers = {
        "USER_ID": os.environ.get("AIRMB_USER_ID"),
        "ACCESS_TOKEN": os.environ.get("AIRMB_ACCESS_TOKEN"),
        "OUT_SOURCE": os.environ.get("AIRMB_OUT_SOURCE"),
        "Cookie": os.environ.get("AIRMB_COOKIE"),
    }
    headers.update({key: value for key, value in optional_headers.items() if value})
    return headers


def normalize_text(value):
    return str(value or "").strip()


def normalize_price(value):
    text = normalize_text(value).replace(",", "")
    if not text:
        raise ValueError("价格为空")
    price = float(text)
    if price <= 0:
        raise ValueError(f"价格必须大于 0：{value}")
    return round(price) if price.is_integer() else round(price, 2)


def parse_timestamp(value):
    text = normalize_text(value)
    if not text:
        raise ValueError("createTime 为空")
    timestamp = int(float(text))
    if timestamp > 10_000_000_000:
        timestamp = int(timestamp / 1000)
    parsed = datetime.fromtimestamp(timestamp, CHINA_TZ)
    return parsed.strftime("%Y-%m-%d"), parsed.strftime("%Y-%m-%d %H:%M:%S"), timestamp


def parse_external_key(external_key):
    parts = [part.strip() for part in normalize_text(external_key).split("|")]
    return {
        "goods_id": parts[0] if len(parts) >= 1 and parts[0] else "",
        "cat_id": parts[1] if len(parts) >= 2 and parts[1] else "",
    }


def to_positive_int(value, fallback):
    try:
        numeric_value = int(value)
        return numeric_value if numeric_value > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def load_target_definitions(db_path):
    mappings, configured = load_enabled_source_mappings(db_path, SOURCE_KEY)
    if not configured:
        return DEFAULT_SOURCE_TARGETS, False

    if not mappings:
        return [], True

    targets = []
    for mapping in mappings:
        meta = mapping.get("external_meta") or {}
        external_key = normalize_text(mapping.get("external_key")) or DEFAULT_EXTERNAL_KEY
        parsed_key = parse_external_key(external_key)
        category = normalize_text(mapping.get("category_name")) or DEFAULT_CATEGORY
        object_name = normalize_text(mapping.get("object_name")) or DEFAULT_OBJECT
        if not category or not object_name:
            continue
        targets.append({
            "external_key": external_key,
            "external_name": normalize_text(mapping.get("external_name")) or object_name,
            "category": category,
            "object": object_name,
            "variant": normalize_text(mapping.get("variant_name")),
            "goods_id": normalize_text(meta.get("goods_id")) or parsed_key["goods_id"] or DEFAULT_GOODS_ID,
            "cat_id": normalize_text(meta.get("cat_id")) or parsed_key["cat_id"] or DEFAULT_CAT_ID,
            "page_size": to_positive_int(meta.get("page_size"), 0),
            "api_mode": normalize_text(meta.get("api_mode")),
            "selected_time": normalize_text(meta.get("selected_time") or meta.get("selectedTime")),
            "source_name": normalize_text(mapping.get("source_name")) or SOURCE_NAME,
        })
    return targets, True


def uses_price_record_line_api(target):
    api_mode = normalize_text(target.get("api_mode")).lower()
    return api_mode in {
        "price_record_line",
        "line",
        "pregoods_price_record_line",
        "pregoodspricerecordline",
    }


def fetch_page(session, target, page, page_size):
    response = session.post(
        API_URL,
        data={
            "id": target["goods_id"],
            "catId": target["cat_id"],
            "curPage": str(page),
            "pageSize": str(page_size),
        },
        headers=build_headers(),
        timeout=25,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") != 0:
        raise RuntimeError(payload.get("message") or "爱藏龙钞接口返回失败")
    data = payload.get("data") or []
    if not isinstance(data, list):
        raise RuntimeError("爱藏龙钞接口 data 不是列表")
    return data


def fetch_line_rows(session, target):
    headers = build_headers()
    headers["Referer"] = "https://w.airmb.com/wap/presale/newPrice"
    selected_time = normalize_text(target.get("selected_time")) or "2"
    response = session.post(
        LINE_API_URL,
        data={
            "id": target["goods_id"],
            "selectedTime": selected_time,
        },
        headers=headers,
        timeout=25,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") != 0:
        raise RuntimeError(payload.get("message") or "爱藏价格线接口返回失败")
    data = payload.get("data") or []
    if not isinstance(data, list):
        raise RuntimeError("爱藏价格线接口 data 不是列表")
    return data


def fetch_source_rows(target, default_page_size, max_pages):
    session = requests.Session()
    if uses_price_record_line_api(target):
        return fetch_line_rows(session, target)

    rows = []
    page = 1
    page_size = target.get("page_size") or default_page_size
    while True:
        page_rows = fetch_page(session, target, page, page_size)
        if not page_rows:
            break
        rows.extend(page_rows)
        if len(page_rows) < page_size:
            break
        if max_pages and page >= max_pages:
            break
        page += 1
    return rows


def extract_records(source_rows, target, since="", until=""):
    records_by_date = {}
    skipped_rows = 0
    errors = []
    for row in source_rows:
        try:
            # 价格线接口 createTime 常为展示值（如 "7.10"），优先用 createTimeInt。
            timestamp_value = row.get("createTimeInt")
            if timestamp_value in (None, ""):
                timestamp_value = row.get("createTime")
            price_date, source_time, timestamp = parse_timestamp(timestamp_value)
            if since and price_date < since:
                skipped_rows += 1
                continue
            if until and price_date > until:
                skipped_rows += 1
                continue
            price = normalize_price(row.get("price"))
        except (TypeError, ValueError) as exc:
            errors.append(str(exc))
            skipped_rows += 1
            continue

        current = records_by_date.get(price_date)
        if current and current["source_timestamp"] >= timestamp:
            continue

        records_by_date[price_date] = {
            "external_key": target["external_key"],
            "category": target["category"],
            "object": target["object"],
            "variant": target["variant"],
            "price": price,
            "raw_price": row.get("price"),
            "price_date": price_date,
            "source_time": source_time,
            "source_timestamp": timestamp,
            "source": target.get("source_name") or SOURCE_NAME,
        }

    return sorted(records_by_date.values(), key=lambda item: item["price_date"]), skipped_rows, errors


def ensure_master_data(conn, record):
    now = datetime.now().isoformat()
    category = conn.execute(
        "SELECT id FROM categories WHERE name = ?",
        (record["category"],),
    ).fetchone()
    if category is None:
        category_id = conn.execute(
            "INSERT INTO categories (name, created_at, updated_at) VALUES (?, ?, ?)",
            (record["category"], now, now),
        ).lastrowid
    else:
        category_id = category[0]

    obj = conn.execute(
        "SELECT id FROM objects WHERE category_id = ? AND name = ?",
        (category_id, record["object"]),
    ).fetchone()
    if obj is None:
        object_id = conn.execute(
            "INSERT INTO objects (category_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (category_id, record["object"], now, now),
        ).lastrowid
    else:
        object_id = obj[0]

    if not record["variant"]:
        return

    variant = conn.execute(
        "SELECT id FROM variants WHERE object_id = ? AND name = ?",
        (object_id, record["variant"]),
    ).fetchone()
    if variant is None:
        conn.execute(
            "INSERT INTO variants (object_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (object_id, record["variant"], now, now),
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
                SELECT id, price, source
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
                        "",
                        now,
                        now,
                    ),
                )
                inserted += 1
                results.append({**record, "action": "insert"})
                continue

            record_id, old_price, old_source = existing
            if float(old_price) == float(record["price"]) and old_source == record["source"]:
                skipped += 1
                results.append({**record, "action": "skip", "id": record_id})
                continue

            conn.execute(
                """
                UPDATE price_records
                SET price = ?,
                    source = ?,
                    note = '',
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


def build_parser():
    parser = argparse.ArgumentParser(description="同步爱藏龙钞历史价格到商品价格工作台")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help="SQLite 数据库路径")
    parser.add_argument("--page-size", type=int, default=100, help="每页拉取数量")
    parser.add_argument("--max-pages", type=int, default=0, help="最多拉取页数；0 表示一直拉到空页")
    parser.add_argument("--since", default="", help="只导入此日期之后的数据，格式 YYYY-MM-DD")
    parser.add_argument("--until", default="", help="只导入此日期之前的数据，格式 YYYY-MM-DD")
    parser.add_argument("--dry-run", action="store_true", help="只抓取和解析，不写数据库")
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    db_path = Path(args.db)
    if args.page_size < 1 or args.page_size > 200:
        raise RuntimeError("--page-size 需要在 1 到 200 之间")
    if args.max_pages < 0:
        raise RuntimeError("--max-pages 不能小于 0")
    if not args.dry_run and not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")

    targets, configured = load_target_definitions(str(db_path))
    if not targets:
        print(json.dumps({
            "success": True,
            "status": "skipped",
            "skipped": True,
            "message": "爱藏价格更新已跳过：当前没有启用的数据源映射",
            "source": SOURCE_NAME,
            "source_key": SOURCE_KEY,
            "records": [],
            "inserted_count": 0,
            "updated_count": 0,
            "skipped_count": 0,
        }, ensure_ascii=False))
        return

    all_records = []
    target_summaries = []
    seen_keys = []
    missing_errors = {}
    total_source_count = 0
    total_filtered_count = 0
    parse_errors = []

    for target in targets:
        source_rows = fetch_source_rows(target, args.page_size, args.max_pages)
        seen_keys.append(target["external_key"])
        total_source_count += len(source_rows)
        records, skipped_source_rows, target_parse_errors = extract_records(
            source_rows,
            target,
            since=args.since,
            until=args.until,
        )
        total_filtered_count += skipped_source_rows
        parse_errors.extend([
            f"{target['external_name']}: {message}"
            for message in target_parse_errors
        ])
        if records:
            all_records.extend(records)
        else:
            missing_errors[target["external_key"]] = "本次来源未返回可入库价格"
        target_summaries.append({
            "external_key": target["external_key"],
            "external_name": target["external_name"],
            "category": target["category"],
            "object": target["object"],
            "variant": target["variant"],
            "source_count": len(source_rows),
            "matched_count": len(records),
            "filtered_count": skipped_source_rows,
        })

    if not args.dry_run:
        mark_source_mappings_seen(str(db_path), SOURCE_KEY, seen_keys)

    if not all_records:
        if not args.dry_run and configured:
            mark_source_mapping_errors(str(db_path), SOURCE_KEY, missing_errors)
        raise RuntimeError("爱藏接口未返回可入库价格")

    inserted, updated, skipped, results = upsert_price_records(str(db_path), all_records, args.dry_run)
    if not args.dry_run:
        matched_keys = {record["external_key"] for record in all_records}
        mark_source_mappings_matched(str(db_path), SOURCE_KEY, matched_keys)
        mark_source_mapping_errors(str(db_path), SOURCE_KEY, {
            key: message
            for key, message in missing_errors.items()
            if key not in matched_keys
        })

    print(json.dumps({
        "success": True,
        "message": (
            f"爱藏价格更新完成：目标 {len(targets)} 个，来源 {total_source_count} 条，清洗 {len(all_records)} 天，"
            f"新增 {inserted}，更新 {updated}，跳过 {skipped}"
        ),
        "source": SOURCE_NAME,
        "source_key": SOURCE_KEY,
        "target_count": len(targets),
        "source_count": total_source_count,
        "matched_count": len(all_records),
        "filtered_count": total_filtered_count,
        "parse_error_count": len(parse_errors),
        "parse_errors": parse_errors[:5],
        "inserted_count": inserted,
        "updated_count": updated,
        "skipped_count": skipped,
        "targets": target_summaries,
        "records": results,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        try:
            parser = build_parser()
            parsed_args, _ = parser.parse_known_args()
            if Path(parsed_args.db).exists():
                mark_source_run_error(parsed_args.db, SOURCE_KEY, f"爱藏价格更新失败：{exc}")
        except Exception:
            pass
        print(json.dumps({
            "success": False,
            "message": str(exc),
        }, ensure_ascii=False))
        raise
