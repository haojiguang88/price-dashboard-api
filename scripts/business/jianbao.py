#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

import requests

from source_mappings import (
    mark_source_mapping_errors,
    mark_source_mappings_matched,
    mark_source_mappings_seen,
    mark_source_run_error,
)

BASE_URL = "https://www.jianbaoshangcheng.com"
SOURCE_KEY = "jianbao_market"
SOURCE_NAME = "见宝商城"
CATEGORY_NAME = "纪念钞"
OBJECT_NAME = "见宝"
CHINA_TZ = timezone(timedelta(hours=8))
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = os.environ.get(
    "BUSINESS_DB_PATH",
    os.environ.get("DB_PATH", str(REPO_ROOT / "data" / "price_dashboard_business_dev.db")),
)

# 只有浏览器打开过的上架通知能核对起始价。目录接口 publishPrice 为空，
# 公告详情会跳到微信验证码，每日任务读不到其余品种。
KNOWN_START_PRICES = {
    "800052": {
        "price": 688.0,
        "effective_date": "2026-10-13",
        "source": "见宝上架通知",
        "reason": "买卖起始价",
        "note": "三版币贰角《彩蝶版》上架通知：起始价 688 元，首发 1003 张，首日涨跌幅 20%，之后 10%。",
    }
}


def normalize_text(value):
    return str(value or "").strip()


def normalize_price(value):
    price = float(value)
    if price <= 0:
        raise ValueError(f"价格必须大于 0：{value}")
    return round(price) if price.is_integer() else round(price, 2)


def variant_name(code, name):
    return f"{code} {normalize_text(name)}".strip()


def china_today():
    return datetime.now(CHINA_TZ).date()


def parse_chart_dates(labels, today):
    parsed = []
    for label in labels:
        month_text, day_text = normalize_text(label).split("/")
        month = int(month_text)
        day = int(day_text)
        candidate = date(today.year, month, day)
        if candidate > today:
            candidate = date(today.year - 1, month, day)
        parsed.append(candidate)

    if not parsed:
        return []

    fixed = [parsed[0]]
    for item in parsed[1:]:
        while item < fixed[-1]:
            try:
                item = date(item.year + 1, item.month, item.day)
            except ValueError as exc:
                raise ValueError(f"无法对齐曲线日期：{item}") from exc
        fixed.append(item)
    return [item.isoformat() for item in fixed]


def build_session():
    session = requests.Session()
    session.trust_env = False
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
        ),
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Origin": BASE_URL,
        "Referer": f"{BASE_URL}/store/market/",
    })
    return session


def post_json(session, path, data):
    response = session.post(f"{BASE_URL}{path}", data=data, timeout=25)
    response.raise_for_status()
    payload = response.json()
    if payload.get("success") != 1:
        raise RuntimeError(payload.get("msg") or f"见宝接口失败：{path}")
    return payload


def fetch_catalog(session):
    items = {}
    request_index = 0
    seen_pages = set()
    while request_index not in seen_pages and len(seen_pages) < 20:
        seen_pages.add(request_index)
        payload = post_json(session, "/store/market/index.aspx", {
            "action": "LoadPingzhong",
            "searchKey": "",
            "sortType": "",
            "sortValue": "",
            "pageIndex": str(request_index),
        })
        for row in payload.get("data") or []:
            code = normalize_text(row.get("code"))
            if code:
                items[code] = row
        current_page = int(payload.get("pageIndex") or 0)
        page_count = int(payload.get("pageCount") or 0)
        if page_count <= 0 or current_page >= page_count:
            break
        request_index = current_page + 1
    if not items:
        raise RuntimeError("见宝目录没有返回品种")
    return list(items.values())


def fetch_chart(session, stock_id):
    payload = post_json(session, "/store/Market/TradeList.aspx", {
        "action": "LoadChartData",
        "stockId": str(stock_id),
        "period": "成立以来",
    })
    labels = payload.get("xList") or []
    values = payload.get("xValue") or []
    if len(labels) != len(values):
        raise RuntimeError(f"曲线日期和价格数量不一致：{stock_id}")
    return list(zip(labels, values))


def column_exists(conn, table_name, column_name):
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return any(row[1] == column_name for row in rows)


def ensure_master_data(conn, item):
    now = datetime.now().isoformat()
    category = conn.execute(
        "SELECT id FROM categories WHERE name = ?",
        (CATEGORY_NAME,),
    ).fetchone()
    if category is None:
        raise RuntimeError(f"缺少品类：{CATEGORY_NAME}")
    category_id = category[0]

    obj = conn.execute(
        "SELECT id FROM objects WHERE category_id = ? AND name = ?",
        (category_id, OBJECT_NAME),
    ).fetchone()
    if obj is None:
        object_id = conn.execute(
            "INSERT INTO objects (category_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (category_id, OBJECT_NAME, now, now),
        ).lastrowid
    else:
        object_id = obj[0]

    name = variant_name(item["code"], item["name"])
    grade = normalize_text(item.get("pingjiScore"))
    note = f"见宝代码 {item['code']}"
    if grade:
        note = f"{note}；评级口径 {grade}"
    variant = conn.execute(
        "SELECT id, note FROM variants WHERE object_id = ? AND name = ?",
        (object_id, name),
    ).fetchone()
    if variant is None:
        variant_id = conn.execute(
            "INSERT INTO variants (object_id, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (object_id, name, note, now, now),
        ).lastrowid
    else:
        variant_id = variant[0]
        if not normalize_text(variant[1]):
            conn.execute(
                "UPDATE variants SET note = ?, updated_at = ? WHERE id = ?",
                (note, now, variant_id),
            )
    return category_id, object_id, variant_id, name


def upsert_source_mapping(conn, item, category_id, object_id, variant_id, variant):
    now = datetime.now().isoformat()
    meta = json.dumps({
        "stock_id": item["id"],
        "grade": normalize_text(item.get("pingjiScore")),
    }, ensure_ascii=False)
    external_key = item["code"]
    external_name = normalize_text(item.get("name")) or external_key
    existing = conn.execute(
        "SELECT id FROM source_mappings WHERE source_key = ? AND external_key = ?",
        (SOURCE_KEY, external_key),
    ).fetchone()
    if existing is None:
        conn.execute(
            """
            INSERT INTO source_mappings
              (source_key, source_name, external_key, external_name, external_meta_json,
               category_id, object_id, variant_id, category_name, object_name, variant_name,
               status, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?, ?)
            """,
            (
                SOURCE_KEY,
                SOURCE_NAME,
                external_key,
                external_name,
                meta,
                category_id,
                object_id,
                variant_id,
                CATEGORY_NAME,
                OBJECT_NAME,
                variant,
                "日价格取成立以来曲线。公开逐笔只覆盖近几日。",
                now,
                now,
            ),
        )
        return
    conn.execute(
        """
        UPDATE source_mappings
        SET source_name = ?,
            external_name = ?,
            external_meta_json = ?,
            category_id = ?,
            object_id = ?,
            variant_id = ?,
            category_name = ?,
            object_name = ?,
            variant_name = ?,
            status = 'enabled',
            updated_at = ?
        WHERE id = ?
        """,
        (
            SOURCE_NAME,
            external_name,
            meta,
            category_id,
            object_id,
            variant_id,
            CATEGORY_NAME,
            OBJECT_NAME,
            variant,
            now,
            existing[0],
        ),
    )


def build_records(item, chart_rows, today):
    labels = [label for label, _value in chart_rows]
    dates = parse_chart_dates(labels, today)
    code = item["code"]
    name = variant_name(code, item["name"])
    qty = item.get("todayTradeQuantity")
    if qty in (None, ""):
        qty = 0
    amount = normalize_text(item.get("todayTradeAmount")) or "0"
    yuncang = normalize_text(item.get("yuncangCount")) or "--"
    records = []
    for index, (price_date, (_label, raw_price)) in enumerate(zip(dates, chart_rows)):
        is_today = price_date == today.isoformat()
        is_first = index == 0 and not is_today
        if is_today:
            note = f"当日成交{qty}张；成交额{amount}万；云仓{yuncang}"
        elif is_first:
            note = "曲线起点，逐笔未覆盖"
        else:
            note = ""
        records.append({
            "external_key": code,
            "category": CATEGORY_NAME,
            "object": OBJECT_NAME,
            "variant": name,
            "price": normalize_price(raw_price),
            "price_date": price_date,
            "source": SOURCE_NAME,
            "note": note,
            "is_today": is_today,
            "is_first": is_first,
        })
    return records


def upsert_price_records(conn, records):
    inserted = 0
    updated = 0
    skipped = 0
    has_price_kind = column_exists(conn, "price_records", "price_kind")
    now = datetime.now().isoformat()
    for record in records:
        existing = conn.execute(
            """
            SELECT id, price, source, COALESCE(note, '')
            FROM price_records
            WHERE date = ?
              AND category = ?
              AND object_name = ?
              AND COALESCE(variant, '') = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (record["price_date"], record["category"], record["object"], record["variant"]),
        ).fetchone()
        if existing is None:
            if has_price_kind:
                conn.execute(
                    """
                    INSERT INTO price_records
                      (date, category, object_name, variant, price, source, note, price_kind, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'avg_deal', ?, ?)
                    """,
                    (
                        record["price_date"],
                        record["category"],
                        record["object"],
                        record["variant"],
                        record["price"],
                        record["source"],
                        record["note"],
                        now,
                        now,
                    ),
                )
            else:
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
                        record["note"],
                        now,
                        now,
                    ),
                )
            inserted += 1
            continue

        record_id, old_price, old_source, old_note = existing
        next_note = record["note"] if record["note"] else old_note
        same_price = float(old_price) == float(record["price"])
        same_source = old_source == record["source"]
        same_note = old_note == next_note
        if same_price and same_source and same_note:
            skipped += 1
            continue
        if has_price_kind:
            conn.execute(
                """
                UPDATE price_records
                SET price = ?, source = ?, note = ?, price_kind = 'avg_deal', updated_at = ?
                WHERE id = ?
                """,
                (record["price"], record["source"], next_note, now, record_id),
            )
        else:
            conn.execute(
                """
                UPDATE price_records
                SET price = ?, source = ?, note = ?, updated_at = ?
                WHERE id = ?
                """,
                (record["price"], record["source"], next_note, now, record_id),
            )
        updated += 1
    return inserted, updated, skipped


def upsert_known_original_price(conn, item, category_id, object_id, variant_id, variant):
    known = KNOWN_START_PRICES.get(item["code"])
    if not known:
        return False
    existing = conn.execute(
        """
        SELECT id
        FROM original_price_records
        WHERE category_name = ?
          AND object_name = ?
          AND COALESCE(variant_name, '') = ?
          AND effective_date = ?
          AND ABS(original_price - ?) < 0.001
          AND COALESCE(is_deleted, 0) = 0
        LIMIT 1
        """,
        (CATEGORY_NAME, OBJECT_NAME, variant, known["effective_date"], known["price"]),
    ).fetchone()
    if existing:
        return False
    now = datetime.now().isoformat()
    conn.execute(
        """
        INSERT INTO original_price_records
          (category_id, category_name, object_id, object_name, variant_id, variant_name,
           original_price, effective_date, source, reason, note, is_deleted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        """,
        (
            category_id,
            CATEGORY_NAME,
            object_id,
            OBJECT_NAME,
            variant_id,
            variant,
            known["price"],
            known["effective_date"],
            known["source"],
            known["reason"],
            known["note"],
            now,
            now,
        ),
    )
    return True


def fetch_trade_pages(session, stock_id):
    rows = []
    request_index = 0
    seen_pages = set()
    while request_index not in seen_pages and len(seen_pages) < 30:
        seen_pages.add(request_index)
        payload = post_json(session, "/store/Market/TradeList.aspx", {
            "action": "LoadTradeList",
            "stockId": str(stock_id),
            "pageIndex": str(request_index),
        })
        rows.extend(payload.get("data") or [])
        current_page = int(payload.get("pageIndex") or 0)
        page_count = int(payload.get("pageCount") or 0)
        if page_count <= 0 or current_page >= page_count:
            break
        request_index = current_page + 1
    return rows


def fetch_order_book(session, stock_id):
    payload = post_json(session, f"/store/market/detail.aspx?pzid={stock_id}", {
        "action": "LoadWeiTuoOrder",
    })

    def levels(rows):
        parsed = []
        for row in rows or []:
            price_text = normalize_text(row.get("price"))
            if not price_text or price_text == "--":
                continue
            try:
                price = float(price_text)
                qty = int(Decimal(str(row.get("quantity") or "0")))
            except (TypeError, ValueError, InvalidOperation):
                continue
            if price <= 0 or qty <= 0:
                continue
            parsed.append({"price": normalize_price(price), "qty": qty})
        return parsed

    return levels(payload.get("sell")), levels(payload.get("buy"))


def parse_trade_clock(text, today):
    date_part, time_part = normalize_text(text).split()
    month_text, day_text = date_part.split("-")
    hour_text, minute_text = time_part.split(":")
    candidate = date(today.year, int(month_text), int(day_text))
    if candidate > today:
        candidate = date(today.year - 1, candidate.month, candidate.day)
    traded_at = f"{candidate.isoformat()}T{int(hour_text):02d}:{int(minute_text):02d}:00+08:00"
    return candidate.isoformat(), traded_at


def parse_public_trades(code, rows, today):
    parsed = []
    for index, row in enumerate(rows):
        fee = Decimal(str(row.get("fee") or "0"))
        qty = int(Decimal(str(row.get("quantity") or "0")))
        if fee <= 0 or qty <= 0:
            continue
        trade_date, traded_at = parse_trade_clock(row.get("tradeTime"), today)
        trade_type = normalize_text(row.get("tradeType")) or "成交"
        unit_price = (fee / Decimal(qty)).quantize(Decimal("0.01"))
        base_id = f"jianbao:{code}:{traded_at[:16]}:{fee.quantize(Decimal('0.01'))}:{qty}:{trade_type}"
        parsed.append({
            "_idx": index,
            "base_id": base_id,
            "trade_date": trade_date,
            "traded_at": traded_at,
            "price": normalize_price(unit_price),
            "qty": qty,
            "trade_type": trade_type,
        })
    return parsed


def split_trade_external_id(external_id):
    text = str(external_id)
    if "#" not in text:
        return text, 0
    base, suffix = text.rsplit("#", 1)
    if suffix.isdigit():
        return base, int(suffix)
    return text, 0


def assign_trade_external_ids(existing_ids, parsed_trades):
    grouped = defaultdict(list)
    for trade in parsed_trades:
        grouped[trade["base_id"]].append(trade)
    assigned = []
    for base_id, group in grouped.items():
        oldest_first = sorted(group, key=lambda item: -item["_idx"])
        existing = existing_ids.get(base_id, [])
        if len(oldest_first) >= len(existing):
            extras = [
                f"{base_id}#{len(existing) + offset + 1}"
                for offset in range(len(oldest_first) - len(existing))
            ]
            external_ids = [*existing, *extras]
        else:
            external_ids = existing[len(existing) - len(oldest_first):]
        for trade, external_id in zip(oldest_first, external_ids):
            assigned.append({**trade, "external_id": external_id})
    return assigned


def load_trade_external_ids(conn, variant):
    rows = conn.execute(
        """
        SELECT external_id
        FROM market_trades
        WHERE source_key = ?
          AND category = ?
          AND object_name = ?
          AND variant = ?
        """,
        (SOURCE_KEY, CATEGORY_NAME, OBJECT_NAME, variant),
    ).fetchall()
    grouped = defaultdict(list)
    for (external_id,) in rows:
        base_id, suffix = split_trade_external_id(external_id)
        grouped[base_id].append((suffix, external_id))
    return {
        base_id: [external_id for _suffix, external_id in sorted(items)]
        for base_id, items in grouped.items()
    }


def upsert_trade_book(conn, variant, trades, ask_levels, bid_levels, today, price_by_date):
    now = datetime.now(CHINA_TZ).isoformat(timespec="seconds")
    existing_ids = load_trade_external_ids(conn, variant)
    assigned = assign_trade_external_ids(existing_ids, trades)
    for trade in assigned:
        conn.execute(
            """
            INSERT INTO market_trades
              (external_id, category, object_name, variant, source_key,
               traded_at, trade_date, price, qty, buyer_account_id, seller_account_id,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(external_id) DO UPDATE SET
               traded_at = excluded.traded_at,
               trade_date = excluded.trade_date,
               price = excluded.price,
               qty = excluded.qty,
               buyer_account_id = excluded.buyer_account_id,
               updated_at = excluded.updated_at
            """,
            (
                trade["external_id"],
                CATEGORY_NAME,
                OBJECT_NAME,
                variant,
                SOURCE_KEY,
                trade["traded_at"],
                trade["trade_date"],
                trade["price"],
                trade["qty"],
                trade["trade_type"],
                now,
                now,
            ),
        )

    for trade_date in sorted({trade["trade_date"] for trade in assigned}):
        is_today = trade_date == today.isoformat()
        asks = ask_levels if is_today else []
        bids = bid_levels if is_today else []
        conn.execute(
            """
            INSERT INTO market_book_snapshots
              (category, object_name, variant, date, source_key,
               flash_min_price, flash_selling_qty, ask_qty, bid_qty, bid_price,
               display_price, price_kind, avg_deal_price, sweep_hint, captured_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, 'avg_deal', ?, 0, ?, ?, ?)
            ON CONFLICT(source_key, category, object_name, variant, date) DO UPDATE SET
               flash_min_price = NULL,
               flash_selling_qty = NULL,
               ask_qty = excluded.ask_qty,
               bid_qty = excluded.bid_qty,
               bid_price = excluded.bid_price,
               display_price = NULL,
               price_kind = 'avg_deal',
               avg_deal_price = excluded.avg_deal_price,
               sweep_hint = 0,
               captured_at = excluded.captured_at,
               updated_at = excluded.updated_at
            """,
            (
                CATEGORY_NAME,
                OBJECT_NAME,
                variant,
                trade_date,
                SOURCE_KEY,
                sum(level["qty"] for level in asks) if is_today else None,
                sum(level["qty"] for level in bids) if is_today else None,
                bids[0]["price"] if bids else None,
                price_by_date.get(trade_date),
                now,
                now,
                now,
            ),
        )
        snapshot = conn.execute(
            """
            SELECT id FROM market_book_snapshots
            WHERE source_key = ? AND category = ? AND object_name = ? AND variant = ? AND date = ?
            """,
            (SOURCE_KEY, CATEGORY_NAME, OBJECT_NAME, variant, trade_date),
        ).fetchone()
        conn.execute("DELETE FROM market_book_levels WHERE snapshot_id = ?", (snapshot[0],))
        if is_today:
            for side, levels in (("ask", asks), ("bid", bids)):
                for level in levels:
                    conn.execute(
                        """
                        INSERT INTO market_book_levels (snapshot_id, side, price, qty)
                        VALUES (?, ?, ?, ?)
                        """,
                        (snapshot[0], side, level["price"], level["qty"]),
                    )
    return len(assigned)


def build_parser():
    parser = argparse.ArgumentParser(description="同步见宝商城日价格到商品价格工作台")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help="SQLite 数据库路径")
    parser.add_argument("--dry-run", action="store_true", help="只抓取和解析，不写数据库")
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    db_path = Path(args.db)
    if not args.dry_run and not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")

    session = build_session()
    catalog = fetch_catalog(session)
    today = china_today()
    summaries = []
    all_records = []
    trade_bundles = []
    errors = {}
    original_inserted = 0

    for item in catalog:
        code = normalize_text(item.get("code"))
        stock_id = item.get("id")
        try:
            chart_rows = fetch_chart(session, stock_id)
            records = build_records(item, chart_rows, today)
        except (TypeError, ValueError, RuntimeError, requests.RequestException) as exc:
            errors[code or str(stock_id)] = str(exc)
            summaries.append({
                "external_key": code,
                "external_name": normalize_text(item.get("name")),
                "matched_count": 0,
                "error": str(exc),
            })
            continue
        if not records:
            errors[code] = "成立以来曲线没有价格"
        trade_error = ""
        public_trades = []
        ask_levels = []
        bid_levels = []
        try:
            public_trades = parse_public_trades(code, fetch_trade_pages(session, stock_id), today)
            ask_levels, bid_levels = fetch_order_book(session, stock_id)
        except (TypeError, ValueError, RuntimeError, requests.RequestException, InvalidOperation) as exc:
            trade_error = str(exc)
        if records:
            trade_bundles.append({
                "code": code,
                "variant": records[0]["variant"],
                "trades": public_trades,
                "ask_levels": ask_levels,
                "bid_levels": bid_levels,
            })
        all_records.extend(records)
        summaries.append({
            "external_key": code,
            "external_name": normalize_text(item.get("name")),
            "variant": records[0]["variant"] if records else "",
            "matched_count": len(records),
            "first_date": records[0]["price_date"] if records else "",
            "last_date": records[-1]["price_date"] if records else "",
            "last_price": records[-1]["price"] if records else None,
            "public_trade_count": len(public_trades),
            "trade_error": trade_error,
        })

    if not all_records:
        raise RuntimeError("见宝曲线没有返回可入库价格")

    inserted = updated = skipped = 0
    trade_count = sum(len(bundle["trades"]) for bundle in trade_bundles)
    if not args.dry_run:
        conn = sqlite3.connect(db_path)
        try:
            by_code = {normalize_text(item.get("code")): item for item in catalog}
            seen_variants = {}
            for record in all_records:
                if record["external_key"] in seen_variants:
                    continue
                item = by_code[record["external_key"]]
                category_id, object_id, variant_id, variant = ensure_master_data(conn, item)
                upsert_source_mapping(conn, item, category_id, object_id, variant_id, variant)
                if upsert_known_original_price(conn, item, category_id, object_id, variant_id, variant):
                    original_inserted += 1
                seen_variants[record["external_key"]] = True
            inserted, updated, skipped = upsert_price_records(conn, all_records)
            price_by_date = {
                (record["variant"], record["price_date"]): record["price"]
                for record in all_records
            }
            for bundle in trade_bundles:
                upsert_trade_book(
                    conn,
                    bundle["variant"],
                    bundle["trades"],
                    bundle["ask_levels"],
                    bundle["bid_levels"],
                    today,
                    {
                        price_date: price
                        for (variant, price_date), price in price_by_date.items()
                        if variant == bundle["variant"]
                    },
                )
            conn.commit()
        finally:
            conn.close()
        mark_source_mappings_seen(str(db_path), SOURCE_KEY, [item["external_key"] for item in summaries if item.get("external_key")])
        matched = [item["external_key"] for item in summaries if item.get("matched_count")]
        mark_source_mappings_matched(str(db_path), SOURCE_KEY, matched)
        mark_source_mapping_errors(str(db_path), SOURCE_KEY, errors)

    print(json.dumps({
        "success": True,
        "message": (
            f"见宝价格更新完成：品种 {len(catalog)} 个，日价格 {len(all_records)} 天，"
            f"新增 {inserted}，更新 {updated}，跳过 {skipped}，原始价新登记 {original_inserted} 条，"
            f"公开窗成交 {trade_count} 笔"
        ),
        "source": SOURCE_NAME,
        "source_key": SOURCE_KEY,
        "target_count": len(catalog),
        "source_count": len(all_records),
        "matched_count": len(all_records),
        "inserted_count": inserted,
        "updated_count": updated,
        "skipped_count": skipped,
        "original_price_inserted_count": original_inserted,
        "public_trade_count": trade_count,
        "error_count": len(errors),
        "targets": summaries,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        try:
            parser = build_parser()
            parsed_args, _ = parser.parse_known_args()
            if Path(parsed_args.db).exists() and not parsed_args.dry_run:
                mark_source_run_error(parsed_args.db, SOURCE_KEY, f"见宝价格更新失败：{exc}")
        except Exception:
            pass
        print(json.dumps({
            "success": False,
            "message": str(exc),
        }, ensure_ascii=False))
        raise
