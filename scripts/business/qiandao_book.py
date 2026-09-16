#!/usr/bin/env python3
import json
import re
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")
SOURCE_KEY = "qiandao_popmart"
STOCK_SELL = "STOCK_ORDER_DIRECTION_SELL"
STOCK_BUY = "STOCK_ORDER_DIRECTION_BUY"


def shanghai_today():
    return datetime.now(SHANGHAI).strftime("%Y-%m-%d")


def shanghai_now_iso():
    return datetime.now(SHANGHAI).replace(microsecond=0).isoformat()


def to_shanghai_datetime(value):
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(SHANGHAI)
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        number = int(text)
        if number > 10**12:
            number = number / 1000
        return datetime.fromtimestamp(number, tz=timezone.utc).astimezone(SHANGHAI)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(SHANGHAI)
    except ValueError:
        return None


def revive_nuxt(payload, index, memo=None, depth=0):
    if memo is None:
        memo = {}
    if not isinstance(index, int) or index < 0 or index >= len(payload):
        return index
    if index in memo:
        return memo[index]
    node = payload[index]
    if isinstance(node, (str, int, float, bool)) or node is None:
        memo[index] = node
        return node
    if isinstance(node, list):
        memo[index] = None
        revived = [
            revive_nuxt(payload, item, memo, depth + 1) if isinstance(item, int) else item
            for item in node
        ]
        memo[index] = revived
        return revived
    if isinstance(node, dict):
        memo[index] = None
        revived = {
            key: revive_nuxt(payload, value, memo, depth + 1) if isinstance(value, int) else value
            for key, value in node.items()
        }
        memo[index] = revived
        return revived
    memo[index] = node
    return node


def extract_nuxt_payload(page_html):
    match = re.search(
        r'<script type="application/json" data-nuxt-data="nuxt-app"[^>]*>(.*?)</script>',
        page_html,
        flags=re.S,
    )
    if not match:
        return None
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, list) else None


def _as_number(value):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:
        return None
    return number


def _as_int(value):
    number = _as_number(value)
    if number is None:
        return None
    return int(number)


def _walk(node, visitor, seen=None):
    if seen is None:
        seen = set()
    identity = id(node)
    if identity in seen:
        return
    seen.add(identity)
    visitor(node)
    if isinstance(node, dict):
        for value in node.values():
            _walk(value, visitor, seen)
    elif isinstance(node, list):
        for item in node:
            _walk(item, visitor, seen)


def _collect_order(node, direction):
    if not isinstance(node, dict):
        return None
    if node.get("direction") != direction:
        return None
    price = _as_number(node.get("price"))
    qty = _as_int(node.get("amount") or node.get("qty") or node.get("quantity"))
    if price is None or qty is None or qty <= 0:
        return None
    created = to_shanghai_datetime(node.get("createdAt") or node.get("created_at") or node.get("updatedAt"))
    return {
        "external_id": str(node.get("id") or "").strip(),
        "price": price,
        "qty": qty,
        "owner_id": str(node.get("ownerId") or node.get("owner_id") or "").strip() or None,
        "created_at": created.isoformat() if created else None,
    }


def _collect_trade(node):
    if not isinstance(node, dict):
        return None
    keys = set(node)
    looks_like_trade = bool(
        {"dealPrice", "deal_price", "filledPrice", "strikePrice"} & keys
        and {"qty", "amount", "quantity", "dealAmount"} & keys
        and ({"tradedAt", "traded_at", "dealTime", "soldAt", "createdAt"} & keys)
    )
    if node.get("direction") in (STOCK_SELL, STOCK_BUY):
        return None
    if not looks_like_trade:
        return None
    price = _as_number(
        node.get("dealPrice")
        or node.get("deal_price")
        or node.get("filledPrice")
        or node.get("price")
    )
    qty = _as_int(node.get("qty") or node.get("amount") or node.get("quantity") or node.get("dealAmount"))
    traded = to_shanghai_datetime(
        node.get("tradedAt") or node.get("traded_at") or node.get("dealTime") or node.get("soldAt") or node.get("createdAt")
    )
    external_id = str(node.get("id") or node.get("orderId") or node.get("dealId") or "").strip()
    if price is None or qty is None or qty <= 0 or not traded or not external_id:
        return None
    return {
        "external_id": external_id,
        "price": price,
        "qty": qty,
        "traded_at": traded.isoformat(),
        "trade_date": traded.strftime("%Y-%m-%d"),
        "buyer_account_id": str(node.get("buyerId") or node.get("buyer_account_id") or node.get("buyerUserId") or "").strip() or None,
        "seller_account_id": str(node.get("sellerId") or node.get("seller_account_id") or node.get("ownerId") or "").strip() or None,
    }


def parse_revived_book(revived_nodes):
    flash = {}
    avg_deal_price = None
    ask_orders = []
    bid_orders = []
    trades = []
    seen_asks = set()
    seen_bids = set()
    seen_trades = set()

    def visitor(node):
        nonlocal avg_deal_price, flash
        if not isinstance(node, dict):
            return
        if "totalSellingMount" in node or "totalSellingAmount" in node:
            qty = _as_int(node.get("totalSellingMount") or node.get("totalSellingAmount"))
            min_price = _as_number(node.get("minPrice") or node.get("priceMin"))
            shops = node.get("shops") if isinstance(node.get("shops"), list) else []
            shop_name = ""
            if shops and isinstance(shops[0], dict):
                shop_name = str(shops[0].get("name") or "").strip()
            flash = {
                "min_price": min_price,
                "selling_qty": qty,
                "shop_name": shop_name,
            }
        if "strikePrice" in node and avg_deal_price is None:
            avg_deal_price = _as_number(node.get("strikePrice"))
        ask = _collect_order(node, STOCK_SELL)
        if ask:
            key = ask["external_id"] or (ask["price"], ask["qty"], ask["owner_id"])
            if key not in seen_asks:
                seen_asks.add(key)
                ask_orders.append(ask)
        bid = _collect_order(node, STOCK_BUY)
        if bid:
            key = bid["external_id"] or (bid["price"], bid["qty"], bid["owner_id"])
            if key not in seen_bids:
                seen_bids.add(key)
                bid_orders.append(bid)
        trade = _collect_trade(node)
        if trade and trade["external_id"] not in seen_trades:
            seen_trades.add(trade["external_id"])
            trades.append(trade)

    for node in revived_nodes:
        _walk(node, visitor)

    return {
        "avg_deal_price": avg_deal_price,
        "flash": flash,
        "ask_orders": ask_orders,
        "bid_orders": bid_orders,
        "trades": trades,
    }


def empty_book():
    return {
        "avg_deal_price": None,
        "flash": {},
        "ask_orders": [],
        "bid_orders": [],
        "trades": [],
    }


def parse_spu_html(page_html):
    payload = extract_nuxt_payload(page_html)
    if not payload:
        return empty_book()
    revived = []
    memo = {}
    for index, node in enumerate(payload):
        if isinstance(node, dict):
            revived.append(revive_nuxt(payload, index, memo))
    return parse_revived_book(revived)


def book_from_json(payload):
    if payload is None:
        return empty_book()
    nodes = []
    if isinstance(payload, list):
        nodes = [item for item in payload if isinstance(item, dict)]
    elif isinstance(payload, dict):
        nodes = [payload]
        data = payload.get("data")
        if isinstance(data, dict):
            nodes.append(data)
        elif isinstance(data, list):
            nodes.extend(item for item in data if isinstance(item, dict))
    return parse_revived_book(nodes)


def merge_books(*books):
    merged = empty_book()
    seen_asks = set()
    seen_bids = set()
    seen_trades = set()
    for book in books:
        if not book:
            continue
        if merged["avg_deal_price"] is None and book.get("avg_deal_price") is not None:
            merged["avg_deal_price"] = book.get("avg_deal_price")
        if not merged["flash"] and book.get("flash"):
            merged["flash"] = dict(book.get("flash") or {})
        for order in book.get("ask_orders") or []:
            key = order.get("external_id") or (order.get("price"), order.get("qty"), order.get("owner_id"))
            if key in seen_asks:
                continue
            seen_asks.add(key)
            merged["ask_orders"].append(order)
        for order in book.get("bid_orders") or []:
            key = order.get("external_id") or (order.get("price"), order.get("qty"), order.get("owner_id"))
            if key in seen_bids:
                continue
            seen_bids.add(key)
            merged["bid_orders"].append(order)
        for trade in book.get("trades") or []:
            key = trade.get("external_id")
            if not key or key in seen_trades:
                continue
            seen_trades.add(key)
            merged["trades"].append(trade)
    return merged


def aggregate_levels(orders):
    grouped = defaultdict(int)
    for order in orders:
        price = _as_number(order.get("price"))
        qty = _as_int(order.get("qty"))
        if price is None or qty is None or qty <= 0:
            continue
        grouped[price] += qty
    return [
        {"price": price, "qty": qty}
        for price, qty in sorted(grouped.items(), key=lambda item: item[0])
    ]


def choose_display_price(book):
    bid_levels = aggregate_levels(book.get("bid_orders") or [])
    bid_price = max((level["price"] for level in bid_levels), default=None)
    bid_qty = sum(level["qty"] for level in bid_levels) if bid_levels else None
    flash = book.get("flash") or {}
    flash_min = _as_number(flash.get("min_price"))
    flash_qty = _as_int(flash.get("selling_qty"))
    ask_levels = aggregate_levels(book.get("ask_orders") or [])
    ask_qty = flash_qty if flash_qty is not None else (sum(level["qty"] for level in ask_levels) or None)
    avg_deal = _as_number(book.get("avg_deal_price"))

    if bid_price is not None:
        kind = "bid"
        display = bid_price
    elif flash_min is not None:
        kind = "flash_min"
        display = flash_min
    elif avg_deal is not None:
        kind = "avg_deal"
        display = avg_deal
    else:
        kind = None
        display = None

    return {
        "display_price": display,
        "price_kind": kind,
        "bid_price": bid_price,
        "bid_qty": bid_qty,
        "flash_min_price": flash_min,
        "flash_selling_qty": flash_qty,
        "ask_qty": ask_qty,
        "ask_levels": ask_levels,
        "bid_levels": bid_levels,
        "avg_deal_price": avg_deal,
    }


def detect_sweep(trades, window_seconds=1800, lot_qty=5, min_repeats=3):
    by_buyer = defaultdict(list)
    for trade in trades:
        buyer = str(trade.get("buyer_account_id") or "").strip()
        qty = _as_int(trade.get("qty"))
        traded = to_shanghai_datetime(trade.get("traded_at"))
        if not buyer or qty is None or qty < lot_qty or traded is None:
            continue
        by_buyer[buyer].append(traded)
    for stamps in by_buyer.values():
        stamps.sort()
        start = 0
        for end, current in enumerate(stamps):
            while (current - stamps[start]).total_seconds() > window_seconds:
                start += 1
            if end - start + 1 >= min_repeats:
                return 1
    return 0


def upsert_market_book(db_path, record, book, dry_run=False):
    chosen = choose_display_price(book)
    date_text = record["price_date"]
    variant = str(record.get("variant") or "")
    captured_at = shanghai_now_iso()
    trades = list(book.get("trades") or [])
    payload = {
        **chosen,
        "sweep_hint": 0,
        "trade_count": len(trades),
        "captured_at": captured_at,
    }
    if dry_run:
        return payload

    sweep_hint = 0
    stored_trades = []
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(
            """
            INSERT INTO market_book_snapshots
              (category, object_name, variant, date, source_key,
               flash_min_price, flash_selling_qty, ask_qty, bid_qty, bid_price,
               display_price, price_kind, avg_deal_price, sweep_hint, captured_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_key, category, object_name, variant, date) DO UPDATE SET
               flash_min_price = excluded.flash_min_price,
               flash_selling_qty = excluded.flash_selling_qty,
               ask_qty = excluded.ask_qty,
               bid_qty = excluded.bid_qty,
               bid_price = excluded.bid_price,
               display_price = excluded.display_price,
               price_kind = excluded.price_kind,
               avg_deal_price = excluded.avg_deal_price,
               sweep_hint = excluded.sweep_hint,
               captured_at = excluded.captured_at,
               updated_at = excluded.updated_at
            """,
            (
                record["category"],
                record["object"],
                variant,
                date_text,
                SOURCE_KEY,
                chosen["flash_min_price"],
                chosen["flash_selling_qty"],
                chosen["ask_qty"],
                chosen["bid_qty"],
                chosen["bid_price"],
                chosen["display_price"],
                chosen["price_kind"] or "avg_deal",
                chosen["avg_deal_price"],
                0,
                captured_at,
                captured_at,
                captured_at,
            ),
        )
        snapshot = conn.execute(
            """
            SELECT id FROM market_book_snapshots
            WHERE source_key = ? AND category = ? AND object_name = ? AND variant = ? AND date = ?
            """,
            (SOURCE_KEY, record["category"], record["object"], variant, date_text),
        ).fetchone()
        snapshot_id = snapshot[0]
        conn.execute("DELETE FROM market_book_levels WHERE snapshot_id = ?", (snapshot_id,))
        for side, levels in (("ask", chosen["ask_levels"]), ("bid", chosen["bid_levels"])):
            for level in levels:
                conn.execute(
                    """
                    INSERT INTO market_book_levels (snapshot_id, side, price, qty)
                    VALUES (?, ?, ?, ?)
                    """,
                    (snapshot_id, side, level["price"], level["qty"]),
                )
        for trade in trades:
            conn.execute(
                """
                INSERT INTO market_trades
                  (external_id, category, object_name, variant, source_key,
                   traded_at, trade_date, price, qty, buyer_account_id, seller_account_id,
                   created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(external_id) DO UPDATE SET
                   traded_at = excluded.traded_at,
                   trade_date = excluded.trade_date,
                   price = excluded.price,
                   qty = excluded.qty,
                   buyer_account_id = excluded.buyer_account_id,
                   seller_account_id = excluded.seller_account_id,
                   updated_at = excluded.updated_at
                """,
                (
                    trade["external_id"],
                    record["category"],
                    record["object"],
                    variant,
                    SOURCE_KEY,
                    trade["traded_at"],
                    trade["trade_date"],
                    trade["price"],
                    trade["qty"],
                    trade.get("buyer_account_id"),
                    trade.get("seller_account_id"),
                    captured_at,
                    captured_at,
                ),
            )
        stored_trades = conn.execute(
            """
            SELECT buyer_account_id, qty, traded_at
            FROM market_trades
            WHERE source_key = ? AND category = ? AND object_name = ? AND variant = ? AND trade_date = ?
            """,
            (SOURCE_KEY, record["category"], record["object"], variant, date_text),
        ).fetchall()
        sweep_hint = detect_sweep([
            {"buyer_account_id": row[0], "qty": row[1], "traded_at": row[2]}
            for row in stored_trades
        ])
        conn.execute(
            "UPDATE market_book_snapshots SET sweep_hint = ?, updated_at = ? WHERE id = ?",
            (sweep_hint, captured_at, snapshot_id),
        )
        conn.commit()
    finally:
        conn.close()
    payload["sweep_hint"] = sweep_hint
    payload["trade_count"] = len(stored_trades) if not dry_run else len(trades)
    return payload
