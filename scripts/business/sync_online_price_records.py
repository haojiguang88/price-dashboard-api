#!/usr/bin/env python3
"""Sync one category of production price records into the local business DB.

The script is intentionally category-scoped so production data cannot overwrite
the whole local workspace by accident.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SECRET_ENV = Path.home() / ".codex" / "secrets" / "baota-panel.env"
DEFAULT_LOCAL_ENV = REPO_ROOT / ".env"
DEFAULT_DB_PATH = REPO_ROOT / "data" / "price_dashboard_business_dev.db"


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
    return values


def resolve_db_path(args: argparse.Namespace, local_env: dict[str, str]) -> Path:
    configured = args.db or os.environ.get("BUSINESS_DB_PATH") or local_env.get("BUSINESS_DB_PATH")
    if not configured:
        return DEFAULT_DB_PATH
    path = Path(configured).expanduser()
    return path if path.is_absolute() else (REPO_ROOT / path).resolve()


def normalize_api_base(value: str) -> str:
    base = value.strip().rstrip("/")
    return base if base.endswith("/api") else f"{base}/api"


def resolve_api_base(args: argparse.Namespace, secret_env: dict[str, str]) -> str | None:
    raw_api = args.api_base or os.environ.get("BUSINESS_API_PUBLIC_URL") or secret_env.get("BUSINESS_API_PUBLIC_URL")
    if raw_api and raw_api.startswith(("http://", "https://")):
        return raw_api
    if raw_api and raw_api.startswith("/"):
        domain = os.environ.get("BUSINESS_FRONTEND_DOMAIN") or secret_env.get("BUSINESS_FRONTEND_DOMAIN")
        if domain and domain.startswith(("http://", "https://")):
            return f"{domain.rstrip('/')}{raw_api}"
    host = os.environ.get("SERVER_HOST") or secret_env.get("SERVER_HOST")
    port = os.environ.get("BUSINESS_API_PORT") or secret_env.get("BUSINESS_API_PORT")
    if host and port:
        scheme = "http" if not str(host).startswith(("http://", "https://")) else ""
        normalized_host = str(host).rstrip("/")
        return f"{scheme + '://' if scheme else ''}{normalized_host}:{port}/api"
    return raw_api


def normalize_record(raw: dict[str, Any]) -> dict[str, Any]:
    category = raw.get("category_name") or raw.get("category") or ""
    variant = raw.get("variant_name") if "variant_name" in raw else raw.get("variant", "")
    price = raw.get("price")
    return {
        "date": str(raw.get("date") or "")[:10].strip(),
        "category_name": str(category or "").strip(),
        "object_name": str(raw.get("object_name") or raw.get("objectName") or "").strip(),
        "variant_name": str(variant or "").strip(),
        "price": float(price) if price is not None and str(price).strip() else None,
        "source": str(raw.get("source") or "").strip(),
        "note": str(raw.get("note") or "").strip(),
    }


def fetch_api_records(api_base: str, category: str, timeout: int) -> list[dict[str, Any]]:
    url = f"{normalize_api_base(api_base)}/price-records?{urlencode({'category': category, 'include_archived': '1'})}"
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    payload = response.json()
    rows = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("线上接口返回格式不是价格记录数组")
    return [normalize_record(row) for row in rows if isinstance(row, dict)]


def load_json_records(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("JSON 文件格式不是价格记录数组")
    return [normalize_record(row) for row in rows if isinstance(row, dict)]


def load_sqlite_records(path: Path, category: str) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"source db not found: {path}")
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT date, category AS category_name, object_name,
                   COALESCE(variant, '') AS variant_name, price, source, note
            FROM price_records
            WHERE category = ?
            ORDER BY date ASC, object_name ASC, variant ASC, id ASC
            """,
            (category,),
        ).fetchall()
        return [normalize_record(dict(row)) for row in rows]
    finally:
        conn.close()


def date_in_scope(record: dict[str, Any], since: str | None, until: str | None) -> bool:
    date = record["date"]
    if since and date < since:
        return False
    if until and date > until:
        return False
    return True


def validate_master_data(conn: sqlite3.Connection, record: dict[str, Any]) -> str | None:
    category = conn.execute(
        "SELECT id FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
        (record["category_name"],),
    ).fetchone()
    if not category:
        return "未找到对应品类主数据"
    obj = conn.execute(
        "SELECT id FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
        (category["id"], record["object_name"]),
    ).fetchone()
    if not obj:
        return "未找到对应对象主数据"
    if record["variant_name"]:
        variant = conn.execute(
            "SELECT id FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
            (obj["id"], record["variant_name"]),
        ).fetchone()
        if not variant:
            return "未找到对应变体主数据"
    return None


def median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def anomaly_messages(conn: sqlite3.Connection, record: dict[str, Any], exclude_id: int | None = None) -> list[str]:
    params: list[Any] = [record["category_name"], record["object_name"], record["variant_name"]]
    exclude_clause = ""
    if exclude_id is not None:
        exclude_clause = "AND id != ?"
        params.append(exclude_id)
    rows = conn.execute(
        f"""
        SELECT id, date, price
        FROM price_records
        WHERE category = ? AND object_name = ? AND COALESCE(variant, '') = ?
          {exclude_clause}
        ORDER BY date ASC, created_at ASC, id ASC
        """,
        params,
    ).fetchall()
    price = record["price"]
    before = [row for row in rows if str(row["date"]) < record["date"]]
    after = [row for row in rows if str(row["date"]) > record["date"]]
    messages: list[str] = []
    if before:
        previous = before[-1]
        previous_price = float(previous["price"])
        if previous_price > 0:
            pct = (price - previous_price) / previous_price * 100
            if abs(pct) >= 30:
                messages.append(f"较上一条 {previous['date']} 价格 {previous_price:g} 变动 {pct:.2f}%")
    if after:
        next_row = after[0]
        next_price = float(next_row["price"])
        if next_price > 0:
            pct = (price - next_price) / next_price * 100
            if abs(pct) >= 30:
                messages.append(f"较下一条 {next_row['date']} 价格 {next_price:g} 变动 {pct:.2f}%")
    recent_median = median([float(row["price"]) for row in before[-7:]])
    if recent_median and len(before[-7:]) >= 3:
        if price <= recent_median * 0.5 or price >= recent_median * 1.5:
            messages.append(f"偏离最近 7 条中位数 {recent_median:g} 超过 50%，疑似漏位或录错")
    return messages


def sync_records(conn: sqlite3.Connection, records: list[dict[str, Any]], apply: bool, update_existing: bool) -> dict[str, Any]:
    summary = {
        "fetched": len(records),
        "inserted": 0,
        "updated": 0,
        "skipped": 0,
        "failed": 0,
        "warnings": [],
        "failures": [],
    }
    now = datetime.utcnow().isoformat()
    conn.execute("BEGIN IMMEDIATE")
    try:
        for index, record in enumerate(records, start=1):
            missing = [key for key in ("date", "category_name", "object_name", "price") if record.get(key) in ("", None)]
            if missing:
                summary["failed"] += 1
                summary["failures"].append({"row_index": index, "reason": f"缺少字段: {', '.join(missing)}", "record": record})
                continue
            master_error = validate_master_data(conn, record)
            if master_error:
                summary["failed"] += 1
                summary["failures"].append({"row_index": index, "reason": master_error, "record": record})
                continue

            existing = conn.execute(
                """
                SELECT id, price, source, note
                FROM price_records
                WHERE date = ? AND category = ? AND object_name = ? AND COALESCE(variant, '') = ?
                """,
                (record["date"], record["category_name"], record["object_name"], record["variant_name"]),
            ).fetchone()
            messages = anomaly_messages(conn, record, existing["id"] if existing else None)
            if messages:
                summary["warnings"].append({
                    "row_index": index,
                    "date": record["date"],
                    "category_name": record["category_name"],
                    "object_name": record["object_name"],
                    "variant_name": record["variant_name"],
                    "price": record["price"],
                    "messages": messages,
                })

            if existing:
                changed = (
                    float(existing["price"]) != float(record["price"])
                    or str(existing["source"] or "") != record["source"]
                    or str(existing["note"] or "") != record["note"]
                )
                if update_existing and changed:
                    conn.execute(
                        """
                        UPDATE price_records
                        SET price = ?, source = ?, note = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (record["price"], record["source"], record["note"], now, existing["id"]),
                    )
                    summary["updated"] += 1
                else:
                    summary["skipped"] += 1
                continue

            conn.execute(
                """
                INSERT INTO price_records
                  (date, category, object_name, variant, price, source, note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["date"],
                    record["category_name"],
                    record["object_name"],
                    record["variant_name"],
                    record["price"],
                    record["source"],
                    record["note"],
                    now,
                    now,
                ),
            )
            summary["inserted"] += 1

        if apply:
            conn.commit()
        else:
            conn.rollback()
    except Exception:
        conn.rollback()
        raise
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sync online business price records by category into local SQLite.")
    parser.add_argument("--category", default="纪念钞", help="Category to sync, default: 纪念钞")
    parser.add_argument("--db", help="Local business SQLite path. Defaults to BUSINESS_DB_PATH or ./data/price_dashboard_business_dev.db")
    parser.add_argument("--config", default=str(DEFAULT_SECRET_ENV), help="Env file containing BUSINESS_API_PUBLIC_URL")
    parser.add_argument("--api-base", help="Online API base URL. Overrides BUSINESS_API_PUBLIC_URL in --config")
    parser.add_argument("--source-json", help="Import records from an exported JSON file instead of the online API")
    parser.add_argument("--source-db", help="Import records from a SQLite backup instead of the online API")
    parser.add_argument("--since", help="Only sync records on or after YYYY-MM-DD")
    parser.add_argument("--until", help="Only sync records on or before YYYY-MM-DD")
    parser.add_argument("--timeout", type=int, default=30, help="Online API timeout seconds")
    parser.add_argument("--apply", action="store_true", help="Write changes. Without this flag the script only dry-runs and rolls back.")
    parser.add_argument("--no-update-existing", action="store_true", help="Do not update local records when the same key already exists.")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    local_env = load_env_file(DEFAULT_LOCAL_ENV)
    secret_env = load_env_file(Path(args.config).expanduser())
    db_path = resolve_db_path(args, local_env)

    if args.source_json:
        records = load_json_records(Path(args.source_json).expanduser())
        source = f"json:{args.source_json}"
    elif args.source_db:
        records = load_sqlite_records(Path(args.source_db).expanduser(), args.category)
        source = f"db:{args.source_db}"
    else:
        api_base = resolve_api_base(args, secret_env)
        if not api_base:
            raise SystemExit("缺少线上 API 地址：请传 --api-base，或在 ~/.codex/secrets/baota-panel.env 配置 BUSINESS_API_PUBLIC_URL")
        records = fetch_api_records(api_base, args.category, args.timeout)
        source = "online-api"

    scoped = [
        record
        for record in records
        if record["category_name"] == args.category and date_in_scope(record, args.since, args.until)
    ]

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        summary = sync_records(
            conn,
            scoped,
            apply=args.apply,
            update_existing=not args.no_update_existing,
        )
    finally:
        conn.close()

    output = {
        "mode": "apply" if args.apply else "dry_run",
        "source": source,
        "db_path": str(db_path),
        "category": args.category,
        "since": args.since,
        "until": args.until,
        **summary,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
