#!/usr/bin/env python3
import argparse
import json
import math
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import requests


DEFAULT_TRADING_DB = "/Volumes/7100/price-dashboard-data/db/price_dashboard_trading_dev.db"
DEFAULT_SYMBOLS = ["XAUUSD", "SGE_AGTD"]

SYMBOL_CONFIGS = {
    "XAUUSD": {
        "name": "黄金现货",
        "market": "global",
        "asset_type": "precious_metal_anchor",
        "source": "twelvedata",
        "source_label": "Twelve Data / XAU/USD",
    },
    "SGE_AGTD": {
        "name": "白银延期 Ag(T+D)",
        "market": "sge",
        "asset_type": "precious_metal_anchor",
        "source": "tushare_sge",
        "source_label": "Tushare 上金所 Ag(T+D)",
    },
}


def load_local_env():
    for env_path in [Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"]:
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            text = line.strip()
            if not text or text.startswith("#") or "=" not in text:
                continue
            key, value = text.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def json_number(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def format_tushare_date(value):
    text = str(value or "").strip()
    if text.endswith(".0"):
        text = text[:-2]
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    if len(text) >= 10 and text[4] == "-" and text[7] == "-":
        return text[:10]
    return text


def compact_date(value):
    text = str(value or "").strip()
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return text.replace("-", "")
    return text


def is_weekend_date(value):
    try:
        return datetime.strptime(format_tushare_date(value), "%Y-%m-%d").weekday() >= 5
    except (TypeError, ValueError):
        return False


def parse_symbols(value):
    if isinstance(value, list):
        items = value
    else:
        items = str(value or "").split(",")
    symbols = []
    for item in items:
        symbol = str(item or "").strip().upper()
        if symbol and symbol in SYMBOL_CONFIGS and symbol not in symbols:
            symbols.append(symbol)
    return symbols or DEFAULT_SYMBOLS


def ensure_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS market_anchor_daily_prices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          name TEXT NOT NULL,
          market TEXT,
          asset_type TEXT NOT NULL DEFAULT 'precious_metal_anchor',
          trade_date TEXT NOT NULL,
          open REAL,
          high REAL,
          low REAL,
          close REAL,
          volume REAL,
          amount REAL,
          source TEXT NOT NULL,
          source_label TEXT,
          raw_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(symbol, trade_date, source)
        );

        CREATE INDEX IF NOT EXISTS idx_market_anchor_daily_symbol_date
          ON market_anchor_daily_prices(symbol, source, trade_date DESC);

        CREATE INDEX IF NOT EXISTS idx_market_anchor_daily_asset_date
          ON market_anchor_daily_prices(asset_type, trade_date DESC);
        """
    )
    conn.commit()


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    return conn


def row_changed(existing, item):
    if not existing:
        return True
    fields = ["open", "high", "low", "close", "volume", "amount"]
    for field in fields:
        left = existing[field]
        right = item.get(field)
        if left is None and right is None:
            continue
        if left is None or right is None:
            return True
        if abs(float(left) - float(right)) > 1e-9:
            return True
    return False


def upsert_items(conn, items, dry_run=False):
    inserted = 0
    updated = 0
    skipped = 0
    latest_dates = {}
    latest_records = {}

    for item in items:
        existing = conn.execute(
            """
            SELECT *
            FROM market_anchor_daily_prices
            WHERE symbol = ? AND trade_date = ? AND source = ?
            """,
            [item["symbol"], item["trade_date"], item["source"]],
        ).fetchone()
        latest_dates[item["symbol"]] = max(latest_dates.get(item["symbol"], ""), item["trade_date"])
        latest_records[item["symbol"]] = item if item["trade_date"] >= latest_records.get(item["symbol"], {}).get("trade_date", "") else latest_records[item["symbol"]]
        if existing and not row_changed(existing, item):
            skipped += 1
            continue
        if existing:
            updated += 1
        else:
            inserted += 1
        if dry_run:
            continue
        conn.execute(
            """
            INSERT INTO market_anchor_daily_prices
              (symbol, name, market, asset_type, trade_date, open, high, low, close,
               volume, amount, source, source_label, raw_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(symbol, trade_date, source) DO UPDATE SET
              name = excluded.name,
              market = excluded.market,
              asset_type = excluded.asset_type,
              open = excluded.open,
              high = excluded.high,
              low = excluded.low,
              close = excluded.close,
              volume = excluded.volume,
              amount = excluded.amount,
              source_label = excluded.source_label,
              raw_json = excluded.raw_json,
              updated_at = CURRENT_TIMESTAMP
            """,
            [
                item["symbol"],
                item["name"],
                item["market"],
                item["asset_type"],
                item["trade_date"],
                item.get("open"),
                item.get("high"),
                item.get("low"),
                item.get("close"),
                item.get("volume"),
                item.get("amount"),
                item["source"],
                item["source_label"],
                item.get("raw_json"),
            ],
        )

    if not dry_run:
        conn.commit()

    return {
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "latest_dates": latest_dates,
        "records": list(latest_records.values()),
    }


def normalize_price_item(symbol, raw):
    config = SYMBOL_CONFIGS[symbol]
    trade_date = format_tushare_date(raw.get("trade_date") or raw.get("datetime"))
    close = json_number(raw.get("close"))
    if not trade_date or close is None or is_weekend_date(trade_date):
        return None
    return {
        "symbol": symbol,
        "name": config["name"],
        "market": config["market"],
        "asset_type": config["asset_type"],
        "trade_date": trade_date,
        "open": json_number(raw.get("open")) or close,
        "high": json_number(raw.get("high")) or close,
        "low": json_number(raw.get("low")) or close,
        "close": close,
        "volume": json_number(raw.get("volume") if "volume" in raw else raw.get("vol")),
        "amount": json_number(raw.get("amount")),
        "source": config["source"],
        "source_label": config["source_label"],
        "raw_json": json.dumps(raw, ensure_ascii=False),
    }


def import_history_from_trading(source_db, symbols):
    if not Path(source_db).exists():
        raise RuntimeError(f"交易库不存在：{source_db}")
    source = sqlite3.connect(source_db)
    source.row_factory = sqlite3.Row
    try:
        placeholders = ",".join("?" for _ in symbols)
        rows = source.execute(
            f"""
            SELECT symbol, name, market, asset_type, trade_date, open, high, low, close,
                   volume, amount, source
            FROM financial_daily_prices
            WHERE symbol IN ({placeholders})
              AND source IN ('twelvedata', 'tushare_sge')
            ORDER BY symbol ASC, trade_date ASC
            """,
            symbols,
        ).fetchall()
        items = []
        for row in rows:
            symbol = row["symbol"]
            if symbol not in SYMBOL_CONFIGS:
                continue
            raw = dict(row)
            item = normalize_price_item(symbol, raw)
            if item:
                items.append(item)
        return items
    finally:
        source.close()


def fetch_twelvedata_gold():
    load_local_env()
    api_key = os.getenv("TWELVE_DATA_API_KEY")
    if not api_key:
        raise RuntimeError("TWELVE_DATA_API_KEY 未配置，无法拉取黄金 XAU/USD")
    response = requests.get(
        "https://api.twelvedata.com/time_series",
        params={
            "symbol": "XAU/USD",
            "interval": "1day",
            "apikey": api_key,
            "outputsize": 5000,
            "format": "JSON",
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    if "values" not in payload:
        raise RuntimeError(f"Twelve Data 返回格式异常：{payload}")
    items = [normalize_price_item("XAUUSD", row) for row in payload["values"]]
    return sorted([item for item in items if item], key=lambda item: item["trade_date"])


def fetch_tushare_silver():
    load_local_env()
    token = os.getenv("TUSHARE_TOKEN")
    if not token:
        raise RuntimeError("TUSHARE_TOKEN 未配置，无法拉取白银 Ag(T+D)")
    try:
        import tushare as ts
    except ImportError as error:
        raise RuntimeError(f"Tushare模块未安装：{error}") from error
    pro = ts.pro_api(token)
    df = pro.sge_daily(
        ts_code="Ag(T+D)",
        start_date="20061030",
        end_date=datetime.now().strftime("%Y%m%d"),
    )
    if df is None or df.empty:
        raise RuntimeError("Tushare SGE Ag(T+D) 返回数据为空")
    rows = []
    for row in df.to_dict("records"):
        raw = dict(row)
        raw["trade_date"] = format_tushare_date(raw.get("trade_date"))
        rows.append(raw)
    items = [normalize_price_item("SGE_AGTD", row) for row in rows]
    return sorted([item for item in items if item], key=lambda item: item["trade_date"])


def fetch_updates(symbols):
    items = []
    errors = []
    failed_symbols = []
    if "XAUUSD" in symbols:
        try:
            items.extend(fetch_twelvedata_gold())
        except Exception as error:
            errors.append(f"XAUUSD: {error}")
            failed_symbols.append("XAUUSD")
    if "SGE_AGTD" in symbols:
        try:
            items.extend(fetch_tushare_silver())
        except Exception as error:
            errors.append(f"SGE_AGTD: {error}")
            failed_symbols.append("SGE_AGTD")
    if errors and not items:
        raise RuntimeError("；".join(errors))
    return items, errors, failed_symbols


def main():
    parser = argparse.ArgumentParser(description="Business precious metal market anchors")
    parser.add_argument("--db", required=True, help="Business database path")
    parser.add_argument("--mode", choices=["import-history", "update"], default="update")
    parser.add_argument("--trading-db", default=DEFAULT_TRADING_DB)
    parser.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    symbols = parse_symbols(args.symbols)
    conn = connect(args.db)
    try:
        if args.mode == "import-history":
            items = import_history_from_trading(args.trading_db, symbols)
            source_errors = []
            failed_symbols = []
        else:
            items, source_errors, failed_symbols = fetch_updates(symbols)

        result = upsert_items(conn, items, dry_run=args.dry_run)
        partial = f"；部分来源失败：{'；'.join(source_errors)}" if source_errors else ""
        print(json.dumps({
            "success": True,
            "mode": args.mode,
            "symbols": symbols,
            "source_count": len(items),
            "matched_count": len(items),
            "inserted": result["inserted"],
            "updated": result["updated"],
            "skipped": result["skipped"],
            "source_errors": source_errors,
            "failed_symbols": failed_symbols,
            "latest_dates": result["latest_dates"],
            "records": result["records"],
            "dry_run": args.dry_run,
            "message": f"贵金属大盘行情{'历史复制' if args.mode == 'import-history' else '更新'}完成：新增 {result['inserted']}，更新 {result['updated']}，跳过 {result['skipped']}{partial}",
        }, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({
            "success": False,
            "message": str(error),
            "mode": args.mode,
            "symbols": symbols,
        }, ensure_ascii=False))
        raise SystemExit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
