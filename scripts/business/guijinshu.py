#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import requests

from source_mappings import (
    load_enabled_source_mappings,
    mark_source_mapping_errors,
    mark_source_mappings_matched,
    mark_source_mappings_seen,
)

API_URL = "https://www.dehuangshop.com/goods/getGoldAndSilver"
JHJ_HISTORY_URL = "https://api.jijinhao.com/history/quote.htm"

PRIMARY_SOURCE_KEY = "dehuang_metals"
PRIMARY_SOURCE_NAME = "德璜小程序贵金属"
FALLBACK_SOURCE_KEY = "jijinhao_recycle_metals"
FALLBACK_SOURCE_NAME = "金投网贵金属回收"

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = os.environ.get(
    "BUSINESS_DB_PATH",
    os.environ.get("DB_PATH", str(REPO_ROOT / "data" / "price_dashboard_business_dev.db")),
)

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

PRIMARY_TARGETS = {
    "黄金9999": {"category": "贵金属", "object": "黄金", "variant": "", "digits": 0},
    "白银": {"category": "贵金属", "object": "白银", "variant": "", "digits": 1},
}

FALLBACK_TARGETS = {
    "JO_321453": {
        "category": "贵金属",
        "object": "黄金",
        "variant": "",
        "digits": 0,
        "external_name": "黄金回收价格",
        "note": "备用源；金投网贵金属回收历史接口",
    },
    "JO_321465": {
        "category": "贵金属",
        "object": "白银",
        "variant": "",
        "digits": 2,
        "external_name": "足银回收价格",
        "note": "备用源；金投网贵金属回收历史接口",
    },
}


def load_target_definitions(db_path, source_key, fallback_targets):
    mappings, configured = load_enabled_source_mappings(db_path, source_key)
    if not configured:
        return fallback_targets

    target_definitions = {}
    for mapping in mappings:
        external_key = str(mapping.get("external_key") or "").strip()
        category = str(mapping.get("category_name") or "").strip()
        object_name = str(mapping.get("object_name") or "").strip()
        if not external_key or not category or not object_name:
            continue
        fallback = fallback_targets.get(external_key, {})
        meta = mapping.get("external_meta") or {}
        target_definitions[external_key] = {
            "category": category,
            "object": object_name,
            "variant": str(mapping.get("variant_name") or ""),
            "digits": int(meta.get("digits", fallback.get("digits", 0))),
            "external_name": str(mapping.get("external_name") or fallback.get("external_name") or external_key),
            "note": str(mapping.get("note") or fallback.get("note") or ""),
        }
    return target_definitions


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


def parse_source_datetime(value):
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def records_stale_message(records, max_age_days):
    if not records:
        return ""
    parsed_times = [
        parse_source_datetime(record.get("source_time") or record.get("trade_date"))
        for record in records
    ]
    parsed_times = [item for item in parsed_times if item is not None]
    if not parsed_times:
        return ""
    latest = max(parsed_times)
    age_days = (datetime.now() - latest).total_seconds() / 86400
    if age_days <= max_age_days:
        return ""
    return f"{PRIMARY_SOURCE_NAME}来源时间已过期：最新 {latest.strftime('%Y-%m-%d %H:%M')}，超过 {max_age_days:g} 天"


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


def ensure_fallback_source_mappings(db_path, target_definitions):
    conn = sqlite3.connect(db_path)
    try:
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_mappings'"
        ).fetchone()
        if table is None:
            return

        now = datetime.now().isoformat()
        for external_key, target in target_definitions.items():
            category = conn.execute(
                "SELECT id FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
                (target["category"],),
            ).fetchone()
            obj = conn.execute(
                """
                SELECT o.id
                FROM objects o
                JOIN categories c ON c.id = o.category_id
                WHERE c.name = ?
                  AND o.name = ?
                  AND COALESCE(o.is_archived, 0) = 0
                """,
                (target["category"], target["object"]),
            ).fetchone()
            status = "enabled" if category and obj else "unmapped"
            note = target.get("note") or ""
            if status != "enabled":
                note = "初始化时未找到对应主数据，请在数据源映射页面确认"

            conn.execute(
                """
                INSERT INTO source_mappings
                  (source_key, source_name, external_key, external_name, external_meta_json,
                   category_id, object_id, variant_id, category_name, object_name, variant_name,
                   status, note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '', ?, ?, ?, ?)
                ON CONFLICT(source_key, external_key) DO UPDATE SET
                  source_name = excluded.source_name,
                  external_name = excluded.external_name,
                  external_meta_json = excluded.external_meta_json,
                  category_id = COALESCE(excluded.category_id, source_mappings.category_id),
                  object_id = COALESCE(excluded.object_id, source_mappings.object_id),
                  category_name = excluded.category_name,
                  object_name = excluded.object_name,
                  variant_name = '',
                  status = CASE
                    WHEN source_mappings.status = 'disabled' THEN source_mappings.status
                    ELSE excluded.status
                  END,
                  note = CASE
                    WHEN source_mappings.status = 'disabled' THEN source_mappings.note
                    ELSE excluded.note
                  END,
                  updated_at = excluded.updated_at
                """,
                (
                    FALLBACK_SOURCE_KEY,
                    FALLBACK_SOURCE_NAME,
                    external_key,
                    target.get("external_name") or external_key,
                    json.dumps({"digits": target.get("digits", 0)}, ensure_ascii=False),
                    category[0] if category else None,
                    obj[0] if obj else None,
                    target["category"],
                    target["object"],
                    status,
                    note,
                    now,
                    now,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def extract_records(payload, enabled_targets, target_definitions):
    records = []
    seen_keys = set()
    missing_errors = {}
    for group in payload.get("data") or []:
        for subcategory in group.get("subcategoryList") or []:
            for config in subcategory.get("configurationList") or []:
                trade_date, source_time = parse_source_time(config.get("date"))
                for item in config.get("propertyList") or []:
                    parameter = str(item.get("parameter") or "").strip()
                    if parameter not in enabled_targets:
                        continue
                    seen_keys.add(parameter)
                    target = target_definitions[parameter]
                    raw_price = item.get("price")
                    if raw_price is None or str(raw_price).strip() == "":
                        missing_errors[parameter] = "本次来源出现该项，但价格为空"
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
                        "source": PRIMARY_SOURCE_NAME,
                    })
    missing_keys = set(enabled_targets) - seen_keys
    for key in missing_keys:
        missing_errors[key] = "本次来源未出现该外部项"
    return records, sorted(seen_keys), missing_errors


def fetch_jijinhao_history(code, page_size):
    response = requests.get(
        JHJ_HISTORY_URL,
        params={"code": code, "pageSize": page_size, "currentPage": 1},
        headers={
            "User-Agent": HEADERS["User-Agent"],
            "Referer": "https://m.cngold.org/datacenter/futures/gjs/gjshs.html",
        },
        timeout=20,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list) or not payload:
        raise RuntimeError(f"金投网历史接口返回异常：{code}")
    return payload[0].get("data") or []


def extract_jijinhao_records(enabled_targets, target_definitions, history_days):
    records = []
    seen_keys = []
    missing_errors = {}
    since_date = (datetime.now() - timedelta(days=history_days)).date()
    page_size = max(20, min(500, history_days + 10))

    for code in sorted(enabled_targets):
        target = target_definitions[code]
        rows = fetch_jijinhao_history(code, page_size)
        if not rows:
            missing_errors[code] = "金投网历史接口未返回该项数据"
            continue
        seen_keys.append(code)
        for row in rows:
            quote = row.get("quote") or {}
            raw_price = quote.get("q63", quote.get("q2"))
            source_time_raw = quote.get("q59")
            trade_date, source_time = parse_source_time(source_time_raw)
            parsed_date = parse_source_datetime(trade_date)
            if parsed_date and parsed_date.date() < since_date:
                continue
            if raw_price is None or str(raw_price).strip() == "":
                continue
            records.append({
                "parameter": code,
                "category": target["category"],
                "object": target["object"],
                "variant": target["variant"],
                "price": normalize_price(raw_price, target["digits"]),
                "raw_price": raw_price,
                "trade_date": trade_date,
                "source_time": source_time,
                "source": FALLBACK_SOURCE_NAME,
                "protect_existing": True,
            })

    missing_keys = set(enabled_targets) - set(seen_keys)
    for key in missing_keys:
        missing_errors[key] = "金投网历史接口未出现该外部项"
    records.sort(key=lambda item: (item["trade_date"], item["object"], item["parameter"]))
    return records, sorted(seen_keys), missing_errors


def requested_target_list(value):
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


def select_primary_targets(requested, target_definitions):
    return {item for item in requested if item in target_definitions}


def select_target_objects(requested, primary_definitions):
    objects = set()
    for item in requested:
        target = primary_definitions.get(item)
        if target:
            objects.add(target["object"])
    return objects


def select_fallback_targets(requested, selected_objects, target_definitions):
    selected = {
        key
        for key, target in target_definitions.items()
        if key in requested
        or target.get("external_name") in requested
        or target.get("object") in selected_objects
    }
    return selected


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
                SELECT id, price, note, source FROM price_records
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

            record_id, old_price, old_note, old_source = existing
            if record.get("protect_existing") and str(old_source or "") != str(record["source"]):
                skipped += 1
                results.append({**record, "action": "skip_existing_source", "id": record_id, "old_source": old_source})
                continue

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
    parser.add_argument(
        "--source",
        choices=["auto", "dehuang", "jijinhao"],
        default="auto",
        help="Use primary Dehuang source, fallback Jijinhao source, or auto fallback when primary is stale",
    )
    parser.add_argument(
        "--max-source-age-days",
        type=float,
        default=2,
        help="In auto mode, fallback when Dehuang source time is older than this many days",
    )
    parser.add_argument(
        "--history-days",
        type=int,
        default=30,
        help="When using Jijinhao fallback, fetch and backfill this many recent calendar days",
    )
    parser.add_argument("--dry-run", action="store_true", help="Fetch and parse without writing database")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not args.dry_run and not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")

    requested = requested_target_list(args.targets)
    primary_definitions = load_target_definitions(str(db_path), PRIMARY_SOURCE_KEY, PRIMARY_TARGETS)
    primary_targets = select_primary_targets(requested, primary_definitions)
    selected_objects = select_target_objects(requested, primary_definitions)

    if not primary_definitions:
        print(json.dumps({
            "success": True,
            "status": "skipped",
            "skipped": True,
            "message": "商品贵金属价格更新已跳过：当前没有启用的数据源映射",
            "inserted_count": 0,
            "updated_count": 0,
            "skipped_count": 0,
            "records": [],
        }, ensure_ascii=False))
        return

    records = []
    seen_keys = []
    missing_errors = {}
    source_key = PRIMARY_SOURCE_KEY
    source_name = PRIMARY_SOURCE_NAME
    fallback_reason = ""

    if args.source in ("auto", "dehuang"):
        if not primary_targets:
            if args.source == "dehuang":
                raise RuntimeError(f"没有可导入的德璜目标，可选：{', '.join(primary_definitions.keys())}")
        else:
            payload = fetch_payload()
            records, seen_keys, missing_errors = extract_records(payload, primary_targets, primary_definitions)
            if not args.dry_run:
                mark_source_mappings_seen(str(db_path), PRIMARY_SOURCE_KEY, seen_keys)
            if records:
                stale_message = records_stale_message(records, args.max_source_age_days)
                if stale_message:
                    fallback_reason = stale_message
                    if not args.dry_run:
                        mark_source_mapping_errors(
                            str(db_path),
                            PRIMARY_SOURCE_KEY,
                            {key: stale_message for key in {record["parameter"] for record in records}},
                        )
                    if args.source == "dehuang":
                        raise RuntimeError(stale_message)
                    records = []
                elif args.source == "auto":
                    source_key = PRIMARY_SOURCE_KEY
                    source_name = PRIMARY_SOURCE_NAME
            elif args.source == "dehuang":
                if not args.dry_run:
                    mark_source_mapping_errors(str(db_path), PRIMARY_SOURCE_KEY, missing_errors)
                raise RuntimeError("贵金属接口未返回可入库的黄金/白银价格")

    if not records and args.source in ("auto", "jijinhao"):
        if not args.dry_run:
            ensure_fallback_source_mappings(str(db_path), FALLBACK_TARGETS)
        fallback_definitions = load_target_definitions(str(db_path), FALLBACK_SOURCE_KEY, FALLBACK_TARGETS)
        fallback_targets = select_fallback_targets(requested, selected_objects, fallback_definitions)
        if not fallback_targets:
            raise RuntimeError(f"没有可导入的金投网备用源目标，可选：{', '.join(fallback_definitions.keys())}")
        records, seen_keys, missing_errors = extract_jijinhao_records(
            fallback_targets,
            fallback_definitions,
            args.history_days,
        )
        source_key = FALLBACK_SOURCE_KEY
        source_name = FALLBACK_SOURCE_NAME
        if not args.dry_run:
            mark_source_mappings_seen(str(db_path), FALLBACK_SOURCE_KEY, seen_keys)
        if not records:
            if not args.dry_run:
                mark_source_mapping_errors(str(db_path), FALLBACK_SOURCE_KEY, missing_errors)
            raise RuntimeError("金投网备用源未返回可入库的黄金/白银价格")

    if not records:
        raise RuntimeError("贵金属价格任务未获取到可入库记录")

    inserted, updated, skipped, results = upsert_price_records(str(db_path), records, args.dry_run)
    matched_keys = {record["parameter"] for record in records}
    if not args.dry_run:
        mark_source_mappings_matched(str(db_path), source_key, matched_keys)
        mark_source_mapping_errors(str(db_path), source_key, {
            key: message
            for key, message in missing_errors.items()
            if key not in matched_keys
        })
    fallback_text = f"，备用原因：{fallback_reason}" if fallback_reason and source_key == FALLBACK_SOURCE_KEY else ""
    print(json.dumps({
        "success": True,
        "source": source_key,
        "message": f"商品贵金属价格更新完成：来源 {source_name}{fallback_text}；新增 {inserted}，更新 {updated}，跳过 {skipped}",
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
