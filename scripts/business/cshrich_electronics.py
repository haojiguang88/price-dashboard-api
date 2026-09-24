#!/usr/bin/env python3
import argparse
import json
import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path

from iphone_backup import (
    fetch_catalog,
    iter_catalog_items,
    normalize_price,
    parse_source_time,
    upsert_price_records,
)

SOURCE_KEY = "cshrich_electronics"
SOURCE_NAME = "潮收汇电子产品报价"
SKIP_SERIES_NAMES = {"任天堂"}
DEFAULT_DB_PATH = (
    os.environ.get("BUSINESS_DB_PATH")
    or str(Path(__file__).resolve().parents[2] / "data" / "price_dashboard_business.db")
)


def normalize_name(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def load_catalog(catalog_path):
    if catalog_path:
        payload = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
        if payload.get("success") is False:
            raise RuntimeError(payload.get("message") or "目录夹具返回失败")
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        if not isinstance(data, dict):
            raise RuntimeError("目录夹具缺少 data")
        return data
    return fetch_catalog()


def list_top_categories(catalog):
    filters = catalog.get("filters") or {}
    items = filters.get("topCategories") or []
    result = []
    for item in items:
        external_id = str(item.get("id") or "").strip()
        external_name = normalize_name(item.get("name"))
        if external_id and external_name:
            result.append({"external_id": external_id, "external_name": external_name})
    return result


def model_count_for(catalog, external_id):
    models = (catalog.get("modelsByCategory") or {}).get(str(external_id)) or []
    return len(models)


def ensure_category(conn, name):
    conn.execute(
        """
        INSERT OR IGNORE INTO categories (name, created_at, updated_at)
        VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (name,),
    )
    row = conn.execute(
        "SELECT id, COALESCE(is_archived, 0) AS is_archived FROM categories WHERE name = ?",
        (name,),
    ).fetchone()
    if not row or int(row["is_archived"] or 0) == 1:
        return None
    return row["id"]


def ensure_object_variant(conn, category_id, object_name, variant_name):
    conn.execute(
        """
        INSERT OR IGNORE INTO objects (category_id, name, created_at, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (category_id, object_name),
    )
    object_row = conn.execute(
        """
        SELECT id, COALESCE(is_archived, 0) AS is_archived
        FROM objects
        WHERE category_id = ? AND name = ?
        """,
        (category_id, object_name),
    ).fetchone()
    if not object_row or int(object_row["is_archived"] or 0) == 1 or not variant_name:
        return
    conn.execute(
        """
        INSERT OR IGNORE INTO variants (object_id, name, created_at, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (object_row["id"], variant_name),
    )


def load_tracked_categories(conn):
    return conn.execute(
        """
        SELECT external_id, external_name, system_category_name, tracked, skip_reason
        FROM cshrich_catalog_categories
        WHERE source_key = ?
        ORDER BY external_id
        """,
        (SOURCE_KEY,),
    ).fetchall()


def upsert_catalog_category(conn, item, model_count, seen_at, create_if_missing=True):
    existing = conn.execute(
        """
        SELECT id, system_category_name, tracked, skip_reason
        FROM cshrich_catalog_categories
        WHERE source_key = ? AND external_id = ?
        """,
        (SOURCE_KEY, item["external_id"]),
    ).fetchone()
    if existing:
        conn.execute(
            """
            UPDATE cshrich_catalog_categories
            SET external_name = ?,
                last_seen_at = ?,
                last_model_count = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (item["external_name"], seen_at, model_count, existing["id"]),
        )
        return {"action": "seen", "row": dict(existing), "created": False}

    if not create_if_missing:
        return {"action": "ignored", "row": None, "created": False}

    system_name = item["external_name"]
    tracked = 1
    skip_reason = ""
    conn.execute(
        """
        INSERT INTO cshrich_catalog_categories
          (source_key, external_id, external_name, system_category_name, tracked, skip_reason,
           first_seen_at, last_seen_at, last_model_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (
            SOURCE_KEY,
            item["external_id"],
            item["external_name"],
            system_name,
            tracked,
            skip_reason,
            seen_at,
            seen_at,
            model_count,
        ),
    )
    row = conn.execute(
        """
        SELECT id, system_category_name, tracked, skip_reason
        FROM cshrich_catalog_categories
        WHERE source_key = ? AND external_id = ?
        """,
        (SOURCE_KEY, item["external_id"]),
    ).fetchone()
    return {"action": "created", "row": dict(row), "created": True}


def skip_series(item):
    return normalize_name(item.get("seriesName")) in SKIP_SERIES_NAMES


def extract_category_records(catalog, external_id, category_name):
    records_by_key = {}
    object_specs = []
    source_count = 0
    skipped_series_count = 0
    invalid_price_count = 0
    for item, variant_item in iter_catalog_items(catalog, str(external_id)):
        source_count += 1
        if skip_series(item):
            skipped_series_count += 1
            continue
        object_name = normalize_name(item.get("name"))
        variant_name = normalize_name(variant_item.get("color"))
        if not object_name:
            continue
        object_specs.append((object_name, variant_name))
        raw_price = variant_item.get("settlementPrice")
        if raw_price is None or str(raw_price).strip() == "":
            raw_price = variant_item.get("price")
        try:
            price = normalize_price(raw_price)
        except (TypeError, ValueError):
            invalid_price_count += 1
            continue
        if price <= 0:
            invalid_price_count += 1
            continue
        price_date, source_time = parse_source_time(
            item.get("updatedAt") or catalog.get("meta", {}).get("updatedAt")
        )
        key = (price_date, category_name, object_name, variant_name)
        records_by_key[key] = {
            "category": category_name,
            "object": object_name,
            "variant": variant_name,
            "price": price,
            "raw_price": raw_price,
            "price_date": price_date,
            "source_time": source_time,
            "source": SOURCE_NAME,
            "source_key": SOURCE_KEY,
            "source_is_outdated": bool(variant_item.get("isOutdated") or item.get("isOutdated")),
        }
    return list(records_by_key.values()), object_specs, source_count, skipped_series_count, invalid_price_count


def sync_tracked_category(conn, catalog, mapping, dry_run):
    category_name = mapping["system_category_name"]
    records, object_specs, source_count, skipped_series_count, invalid_price_count = extract_category_records(
        catalog,
        mapping["external_id"],
        category_name,
    )
    created_objects = 0
    if not dry_run:
        category_id = ensure_category(conn, category_name)
        if category_id is None:
            return {
                "category": category_name,
                "external_id": mapping["external_id"],
                "source_count": source_count,
                "object_spec_count": len({(name, variant) for name, variant in object_specs}),
                "created_objects": 0,
                "skipped_series_count": skipped_series_count,
                "invalid_price_count": invalid_price_count,
                "skipped_archived": True,
                "price_records": [],
            }
        seen = set()
        for object_name, variant_name in object_specs:
            marker = (object_name, variant_name)
            if marker in seen:
                continue
            seen.add(marker)
            before = conn.execute(
                "SELECT id FROM objects WHERE category_id = ? AND name = ?",
                (category_id, object_name),
            ).fetchone()
            ensure_object_variant(conn, category_id, object_name, variant_name)
            if before is None:
                created_objects += 1
        active_rows = conn.execute(
            """
            SELECT o.name, COALESCE(v.name, '')
            FROM objects o
            LEFT JOIN variants v ON v.object_id = o.id AND COALESCE(v.is_archived, 0) = 0
            WHERE o.category_id = ?
              AND COALESCE(o.is_archived, 0) = 0
            """,
            (category_id,),
        ).fetchall()
        active_keys = {(row[0], row[1]) for row in active_rows}
        records = [
            record
            for record in records
            if (record["object"], record["variant"]) in active_keys
        ]
    return {
        "category": category_name,
        "external_id": mapping["external_id"],
        "source_count": source_count,
        "object_spec_count": len({(name, variant) for name, variant in object_specs}),
        "created_objects": created_objects,
        "skipped_series_count": skipped_series_count,
        "invalid_price_count": invalid_price_count,
        "price_records": records,
    }


def discover(conn, catalog, dry_run, create_missing):
    seen_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    created = []
    seen = []
    for item in list_top_categories(catalog):
        model_count = model_count_for(catalog, item["external_id"])
        if dry_run:
            existing = conn.execute(
                """
                SELECT system_category_name, tracked
                FROM cshrich_catalog_categories
                WHERE source_key = ? AND external_id = ?
                """,
                (SOURCE_KEY, item["external_id"]),
            ).fetchone()
            if existing:
                seen.append(item["external_name"])
            else:
                created.append(item["external_name"])
            continue
        result = upsert_catalog_category(conn, item, model_count, seen_at, create_if_missing=create_missing)
        if result["created"]:
            created.append(item["external_name"])
            if result["row"] and int(result["row"]["tracked"] or 0) == 1:
                ensure_category(conn, result["row"]["system_category_name"])
        elif result["action"] == "seen":
            seen.append(item["external_name"])
    return created, seen


def sync_targets(conn, catalog, mappings, dry_run):
    summaries = []
    price_records = []
    for mapping in mappings:
        summary = sync_tracked_category(conn, catalog, mapping, dry_run)
        price_records.extend(summary.pop("price_records"))
        summaries.append(summary)
    return summaries, price_records


def run(db_path, mode, catalog_path, dry_run):
    catalog = load_catalog(catalog_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        created_categories, seen_categories = discover(
            conn,
            catalog,
            dry_run,
            create_missing=(mode in {"discover", "all"}),
        )
        tracked = [
            row
            for row in load_tracked_categories(conn)
            if int(row["tracked"] or 0) == 1
        ]
        if mode in {"sync", "all"}:
            targets = tracked
        elif mode == "discover":
            created = set(created_categories)
            targets = [row for row in tracked if row["system_category_name"] in created]
        else:
            targets = []

        sync_summaries, price_records = sync_targets(conn, catalog, targets, dry_run)
        if not dry_run:
            conn.commit()

        inserted = updated = skipped = 0
        if price_records:
            inserted, updated, skipped, _results = upsert_price_records(
                db_path,
                price_records,
                dry_run=dry_run,
            )

        tracked_count = conn.execute(
            "SELECT COUNT(*) FROM cshrich_catalog_categories WHERE source_key = ? AND tracked = 1",
            (SOURCE_KEY,),
        ).fetchone()[0]
        payload = {
            "success": True,
            "source_key": SOURCE_KEY,
            "mode": mode,
            "message": (
                f"潮收汇电子产品{('巡检' if mode == 'discover' else '同步')}完成："
                f"新品类 {len(created_categories)}，写入价格 {inserted}，更新 {updated}，跳过 {skipped}"
            ),
            "inserted_count": len(created_categories) if mode == "discover" else inserted,
            "updated_count": len(seen_categories) if mode == "discover" else updated,
            "skipped_count": skipped,
            "created_category_count": len(created_categories),
            "seen_category_count": len(seen_categories),
            "tracked_count": tracked_count,
            "new_categories": created_categories,
            "sync_summaries": sync_summaries,
            "matched_count": len(price_records),
            "source_count": sum(item.get("source_count", 0) for item in sync_summaries),
        }
        print(json.dumps(payload, ensure_ascii=False))
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="Sync CSHRich electronics categories, objects, and prices")
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH))
    parser.add_argument("--mode", choices=["discover", "sync", "all"], default="all")
    parser.add_argument("--catalog", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    db_path = Path(args.db)
    if not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")
    run(str(db_path), args.mode, args.catalog or None, args.dry_run)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        raise
