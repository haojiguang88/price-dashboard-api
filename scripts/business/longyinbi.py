#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import longchao as airmb
from source_mappings import (
    load_enabled_source_mappings,
    mark_source_mapping_errors,
    mark_source_mappings_matched,
    mark_source_mappings_seen,
)

SOURCE_KEY = "airmb_longyinbi_presale"
SOURCE_NAME = "爱藏龙银币"
DEFAULT_CATEGORY = "纪念币"
DEFAULT_OBJECT = "龙银币"
DEFAULT_VARIANT = "2025年信泰评级"
DEFAULT_GOODS_ID = "7"
DEFAULT_CAT_ID = "1369"
DEFAULT_PRICE_OFFSET = 100
DEFAULT_EXTERNAL_KEY = f"{DEFAULT_GOODS_ID}|{DEFAULT_CAT_ID}|2025龙银币裸币|信泰+100"
MAX_PRICE_RECORD_NOTES = 5
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = os.environ.get(
    "BUSINESS_DB_PATH",
    os.environ.get("DB_PATH", str(REPO_ROOT / "data" / "price_dashboard_business_dev.db")),
)

DEFAULT_SOURCE_TARGETS = [
    {
        "external_key": DEFAULT_EXTERNAL_KEY,
        "external_name": "2025龙银币裸币",
        "category": DEFAULT_CATEGORY,
        "object": DEFAULT_OBJECT,
        "variant": DEFAULT_VARIANT,
        "goods_id": DEFAULT_GOODS_ID,
        "cat_id": DEFAULT_CAT_ID,
        "page_size": 100,
        "price_offset": DEFAULT_PRICE_OFFSET,
        "source_name": SOURCE_NAME,
    }
]


def normalize_text(value):
    return str(value or "").strip()


def to_positive_int(value, fallback):
    try:
        numeric_value = int(value)
        return numeric_value if numeric_value > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def to_float(value, fallback=0):
    try:
        numeric_value = float(value)
        return numeric_value if numeric_value == numeric_value else fallback
    except (TypeError, ValueError):
        return fallback


def latest_date_filter(*values):
    dates = [normalize_text(value) for value in values if normalize_text(value)]
    return max(dates) if dates else ""


def normalize_output_price(value):
    price = round(float(value), 2)
    return round(price) if price.is_integer() else price


def format_signed_price_offset(offset):
    normalized = normalize_output_price(offset)
    return f"+{normalized}" if float(normalized) >= 0 else str(normalized)


def build_price_offset_note(source_price, offset):
    return f"裸币价 {normalize_output_price(source_price)}；信泰{format_signed_price_offset(offset)}"


def select_price_note_indexes(records, max_notes=MAX_PRICE_RECORD_NOTES):
    if len(records) <= max_notes:
        return set(range(len(records)))

    ordered = sorted(
        enumerate(records),
        key=lambda item: (normalize_text(item[1].get("price_date")), item[0]),
    )
    selected = {
        ordered[0][0],
        ordered[-1][0],
        max(ordered, key=lambda item: float(item[1]["price"]))[0],
        min(ordered, key=lambda item: float(item[1]["price"]))[0],
    }

    biggest_move = None
    for previous, current in zip(ordered, ordered[1:]):
        previous_price = float(previous[1]["price"])
        current_price = float(current[1]["price"])
        if previous_price <= 0:
            continue
        move_score = abs(current_price - previous_price) / previous_price
        if biggest_move is None or move_score > biggest_move[0]:
            biggest_move = (move_score, current[0])
    if biggest_move:
        selected.add(biggest_move[1])

    if len(selected) < max_notes:
        slots = max_notes - len(selected)
        for slot in range(1, slots + 1):
            index = round((len(ordered) - 1) * slot / (slots + 1))
            selected.add(ordered[index][0])

    return set(sorted(selected)[:max_notes])


def parse_external_key(external_key):
    parts = [part.strip() for part in normalize_text(external_key).split("|")]
    return {
        "goods_id": parts[0] if len(parts) >= 1 and parts[0] else "",
        "cat_id": parts[1] if len(parts) >= 2 and parts[1] else "",
    }


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
            "price_offset": to_float(meta.get("price_offset"), DEFAULT_PRICE_OFFSET),
            "start_date": normalize_text(meta.get("start_date") or meta.get("since")),
            "source_name": normalize_text(mapping.get("source_name")) or SOURCE_NAME,
        })
    return targets, True


def apply_price_offset(records, target):
    adjusted_records = []
    offset = to_float(target.get("price_offset"), 0)
    for record in records:
        source_price = float(record["price"])
        adjusted_price = normalize_output_price(source_price + offset)
        adjusted_records.append({
            **record,
            "source_price": normalize_output_price(source_price),
            "price": adjusted_price,
            "source": target.get("source_name") or SOURCE_NAME,
            "note": "",
        })

    note_indexes = select_price_note_indexes(adjusted_records)
    for index in note_indexes:
        adjusted_records[index]["note"] = build_price_offset_note(
            adjusted_records[index]["source_price"],
            offset,
        )
    return adjusted_records


def upsert_price_records(db_path, records, dry_run=False):
    inserted = 0
    updated = 0
    skipped = 0
    results = []

    if dry_run:
        return inserted, updated, skipped, [{**record, "action": "dry_run"} for record in records]

    conn = sqlite3.connect(db_path)
    try:
        for record in records:
            airmb.ensure_master_data(conn, record)
            now = datetime.now().isoformat()
            existing = conn.execute(
                """
                SELECT id, price, source, note
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

            note = record.get("note") or ""
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

            record_id, old_price, old_source, old_note = existing
            if (
                float(old_price) == float(record["price"])
                and old_source == record["source"]
                and (old_note or "") == note
            ):
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


def delete_target_records(db_path, targets):
    conn = sqlite3.connect(db_path)
    deleted = 0
    try:
        for target in targets:
            cursor = conn.execute(
                """
                DELETE FROM price_records
                WHERE category = ?
                  AND object_name = ?
                  AND COALESCE(variant, '') = ?
                """,
                (target["category"], target["object"], target["variant"]),
            )
            deleted += cursor.rowcount
        conn.commit()
    finally:
        conn.close()
    return deleted


def build_parser():
    parser = argparse.ArgumentParser(description="同步爱藏龙银币裸币价格，并按信泰评级映射口径入库")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help="SQLite 数据库路径")
    parser.add_argument("--page-size", type=int, default=100, help="每页拉取数量")
    parser.add_argument("--max-pages", type=int, default=0, help="最多拉取页数；0 表示一直拉到空页")
    parser.add_argument("--since", default="", help="只导入此日期之后的数据，格式 YYYY-MM-DD")
    parser.add_argument("--until", default="", help="只导入此日期之前的数据，格式 YYYY-MM-DD")
    parser.add_argument("--replace-target", action="store_true", help="入库前先删除目标序列旧价格")
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
            "message": "爱藏龙银币更新已跳过：当前没有启用的数据源映射",
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
        source_rows = airmb.fetch_source_rows(target, args.page_size, args.max_pages)
        seen_keys.append(target["external_key"])
        total_source_count += len(source_rows)
        effective_since = latest_date_filter(args.since, target.get("start_date"))
        records, skipped_source_rows, target_parse_errors = airmb.extract_records(
            source_rows,
            target,
            since=effective_since,
            until=args.until,
        )
        records = apply_price_offset(records, target)
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
            "price_offset": target.get("price_offset", 0),
            "start_date": target.get("start_date") or "",
            "effective_since": effective_since,
            "source_count": len(source_rows),
            "matched_count": len(records),
            "filtered_count": skipped_source_rows,
        })

    if not args.dry_run:
        mark_source_mappings_seen(str(db_path), SOURCE_KEY, seen_keys)

    if not all_records:
        if not args.dry_run and configured:
            mark_source_mapping_errors(str(db_path), SOURCE_KEY, missing_errors)
        raise RuntimeError("爱藏龙银币接口未返回可入库价格")

    deleted_count = 0
    if args.replace_target and not args.dry_run:
        deleted_count = delete_target_records(str(db_path), targets)

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
            f"爱藏龙银币更新完成：目标 {len(targets)} 个，来源 {total_source_count} 条，清洗 {len(all_records)} 天，"
            f"删除旧记录 {deleted_count}，新增 {inserted}，更新 {updated}，跳过 {skipped}"
        ),
        "source": SOURCE_NAME,
        "source_key": SOURCE_KEY,
        "target_count": len(targets),
        "source_count": total_source_count,
        "matched_count": len(all_records),
        "filtered_count": total_filtered_count,
        "parse_error_count": len(parse_errors),
        "parse_errors": parse_errors[:5],
        "deleted_count": deleted_count,
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
        db = DEFAULT_DB_PATH
        if "--db" in os.sys.argv:
            try:
                db = os.sys.argv[os.sys.argv.index("--db") + 1]
            except (ValueError, IndexError):
                pass
        try:
            from source_mappings import mark_source_run_error
            mark_source_run_error(db, SOURCE_KEY, str(exc))
        except Exception:
            pass
        raise
