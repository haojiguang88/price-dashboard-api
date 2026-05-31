import json
import sqlite3
from datetime import datetime


def _table_exists(conn, table_name):
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _parse_meta(value):
    if not value:
        return {}
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, json.JSONDecodeError):
        return {}


def load_enabled_source_mappings(db_path, source_key):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        if not _table_exists(conn, "source_mappings"):
            return [], False

        configured_count = conn.execute(
            "SELECT COUNT(1) FROM source_mappings WHERE source_key = ?",
            (source_key,),
        ).fetchone()[0]
        rows = conn.execute(
            """
            SELECT *
            FROM source_mappings
            WHERE source_key = ?
              AND status = 'enabled'
            ORDER BY object_name ASC, external_name ASC, id ASC
            """,
            (source_key,),
        ).fetchall()
    finally:
        conn.close()

    mappings = []
    for row in rows:
        item = dict(row)
        item["external_meta"] = _parse_meta(item.get("external_meta_json"))
        mappings.append(item)
    return mappings, configured_count > 0


def _normalize_keys(external_keys):
    return sorted({str(item).strip() for item in external_keys if str(item or "").strip()})


def _update_keys(db_path, source_key, external_keys, assignments, params):
    keys = _normalize_keys(external_keys)
    if not keys:
        return 0

    conn = sqlite3.connect(db_path)
    try:
        if not _table_exists(conn, "source_mappings"):
            return 0
        placeholders = ",".join("?" for _ in keys)
        cursor = conn.execute(
            f"""
            UPDATE source_mappings
            SET {assignments},
                updated_at = ?
            WHERE source_key = ?
              AND external_key IN ({placeholders})
            """,
            [*params, datetime.now().isoformat(), source_key, *keys],
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def mark_source_mappings_seen(db_path, source_key, external_keys):
    now = datetime.now().isoformat()
    return _update_keys(
        db_path,
        source_key,
        external_keys,
        "last_seen_at = ?, last_error = NULL",
        [now],
    )


def mark_source_mappings_matched(db_path, source_key, external_keys):
    now = datetime.now().isoformat()
    return _update_keys(
        db_path,
        source_key,
        external_keys,
        "last_matched_at = ?, last_error = NULL",
        [now],
    )


def mark_source_mapping_errors(db_path, source_key, error_by_external_key):
    if not error_by_external_key:
        return 0

    conn = sqlite3.connect(db_path)
    try:
        if not _table_exists(conn, "source_mappings"):
            return 0
        changed = 0
        now = datetime.now().isoformat()
        for external_key, message in error_by_external_key.items():
            normalized_key = str(external_key or "").strip()
            if not normalized_key:
                continue
            cursor = conn.execute(
                """
                UPDATE source_mappings
                SET last_error = ?,
                    updated_at = ?
                WHERE source_key = ?
                  AND external_key = ?
                """,
                (str(message or "来源未返回可用价格"), now, source_key, normalized_key),
            )
            changed += cursor.rowcount
        conn.commit()
        return changed
    finally:
        conn.close()


def mark_source_run_error(db_path, source_key, message):
    conn = sqlite3.connect(db_path)
    try:
        if not _table_exists(conn, "source_mappings"):
            return 0
        now = datetime.now().isoformat()
        cursor = conn.execute(
            """
            UPDATE source_mappings
            SET last_error = ?,
                updated_at = ?
            WHERE source_key = ?
              AND status = 'enabled'
            """,
            (str(message or "来源任务执行失败"), now, source_key),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()
