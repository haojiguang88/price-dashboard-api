#!/usr/bin/env python3
import argparse
import json
import math
import os
import sqlite3
import time
from datetime import datetime


def normalize_date(value):
    text = str(value or "").strip()
    if "-" in text:
        text = text.replace("-", "")
    return text


def format_date(value):
    text = normalize_date(value)
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    return str(value or "")


def safe_value(value):
    try:
        import pandas as pd
        if pd.isna(value):
            return None
    except Exception:
        pass
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def safe_float(value):
    value = safe_value(value)
    if value is None or value == "":
        return None
    try:
        numeric = float(value)
        return numeric if math.isfinite(numeric) else None
    except Exception:
        return None


def compact_symbol(ts_code):
    return str(ts_code or "").split(".")[0].zfill(6)


def raw_json(row):
    return json.dumps({key: safe_value(value) for key, value in dict(row).items()}, ensure_ascii=False)


def ensure_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS financial_moneyflow (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'tushare',
          trade_date TEXT NOT NULL,
          buy_sm_amount REAL,
          sell_sm_amount REAL,
          buy_md_amount REAL,
          sell_md_amount REAL,
          buy_lg_amount REAL,
          sell_lg_amount REAL,
          buy_elg_amount REAL,
          sell_elg_amount REAL,
          net_mf_amount REAL,
          net_mf_vol REAL,
          raw_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(symbol, source, trade_date)
        );

        CREATE INDEX IF NOT EXISTS idx_financial_moneyflow_symbol_date
        ON financial_moneyflow(symbol, source, trade_date);

        CREATE TABLE IF NOT EXISTS financial_moneyflow_ths (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'tushare',
          trade_date TEXT NOT NULL,
          latest REAL,
          pct_change REAL,
          net_amount REAL,
          net_amount_rate REAL,
          buy_lg_amount REAL,
          buy_lg_amount_rate REAL,
          buy_md_amount REAL,
          buy_md_amount_rate REAL,
          raw_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(symbol, source, trade_date)
        );

        CREATE INDEX IF NOT EXISTS idx_financial_moneyflow_ths_symbol_date
        ON financial_moneyflow_ths(symbol, source, trade_date);

        CREATE TABLE IF NOT EXISTS financial_limit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'tushare',
          trade_date TEXT NOT NULL,
          limit_status TEXT,
          limit_type TEXT,
          close REAL,
          pct_chg REAL,
          first_time TEXT,
          last_time TEXT,
          open_times INTEGER,
          fd_amount REAL,
          fc_ratio REAL,
          fl_ratio REAL,
          raw_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(symbol, source, trade_date, limit_status)
        );

        CREATE INDEX IF NOT EXISTS idx_financial_limit_events_date
        ON financial_limit_events(trade_date, limit_status);

        CREATE TABLE IF NOT EXISTS financial_limit_prices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'tushare',
          trade_date TEXT NOT NULL,
          up_limit REAL,
          down_limit REAL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(symbol, source, trade_date)
        );

        CREATE INDEX IF NOT EXISTS idx_financial_limit_prices_symbol_date
        ON financial_limit_prices(symbol, source, trade_date);

        CREATE TABLE IF NOT EXISTS financial_sw_industries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          index_code TEXT NOT NULL,
          industry_name TEXT,
          level TEXT,
          parent_code TEXT,
          src TEXT NOT NULL DEFAULT 'SW2021',
          raw_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(index_code, src)
        );

        CREATE TABLE IF NOT EXISTS financial_sw_industry_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          name TEXT,
          l1_code TEXT,
          l1_name TEXT,
          l2_code TEXT,
          l2_name TEXT,
          l3_code TEXT,
          l3_name TEXT,
          in_date TEXT,
          out_date TEXT,
          is_new TEXT,
          src TEXT NOT NULL DEFAULT 'SW2021',
          raw_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(symbol, src, l1_code, l2_code, l3_code)
        );

        CREATE INDEX IF NOT EXISTS idx_financial_sw_members_symbol
        ON financial_sw_industry_members(symbol, src, is_new);

        CREATE TABLE IF NOT EXISTS financial_sw_industry_daily (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          index_code TEXT NOT NULL,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'tushare',
          trade_date TEXT NOT NULL,
          open REAL,
          high REAL,
          low REAL,
          close REAL,
          pre_close REAL,
          change_amount REAL,
          pct_change REAL,
          volume REAL,
          amount REAL,
          raw_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(index_code, source, trade_date)
        );

        CREATE INDEX IF NOT EXISTS idx_financial_sw_daily_code_date
        ON financial_sw_industry_daily(index_code, source, trade_date);
        """
    )
    conn.commit()


def get_trade_dates(conn, days, start_date=None, end_date=None, include_end_date=False):
    params = []
    where = ["asset_type = 'stock'", "source = 'tushare'"]
    if start_date:
        where.append("trade_date >= ?")
        params.append(format_date(start_date))
    if end_date:
        where.append("trade_date <= ?")
        params.append(format_date(end_date))
    rows = conn.execute(
        f"""
        SELECT DISTINCT trade_date
        FROM financial_daily_prices
        WHERE {' AND '.join(where)}
        ORDER BY trade_date DESC
        LIMIT ?
        """,
        [*params, int(days)],
    ).fetchall()
    dates = {format_date(row[0]) for row in rows if row[0]}
    if include_end_date:
        dates.add(format_date(end_date or datetime.now().strftime("%Y%m%d")))
    ordered = sorted(date for date in dates if date)
    return [normalize_date(date) for date in ordered[-int(days):]]


def fetch_daily_basic(conn, pro, trade_date):
    fields = (
        "ts_code,trade_date,close,turnover_rate,turnover_rate_f,volume_ratio,"
        "pe,pe_ttm,pb,ps,ps_ttm,dv_ratio,dv_ttm,total_share,float_share,"
        "free_share,total_mv,circ_mv"
    )
    df = pro.daily_basic(trade_date=trade_date, fields=fields)
    if df is None or df.empty:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
    rows = []
    for item in df.to_dict("records"):
        symbol = compact_symbol(item.get("ts_code"))
        if not symbol:
            continue
        total_mv = safe_float(item.get("total_mv"))
        circ_mv = safe_float(item.get("circ_mv"))
        rows.append((
            symbol,
            "tushare",
            format_date(item.get("trade_date") or trade_date),
            safe_float(item.get("close")),
            safe_float(item.get("turnover_rate")),
            safe_float(item.get("turnover_rate_f")),
            safe_float(item.get("volume_ratio")),
            safe_float(item.get("pe")),
            safe_float(item.get("pe_ttm")),
            safe_float(item.get("pb")),
            safe_float(item.get("ps")),
            safe_float(item.get("ps_ttm")),
            safe_float(item.get("dv_ratio")),
            safe_float(item.get("dv_ttm")),
            safe_float(item.get("total_share")),
            safe_float(item.get("float_share")),
            safe_float(item.get("free_share")),
            None if total_mv is None else total_mv * 10000,
            None if circ_mv is None else circ_mv * 10000,
            now,
            now,
        ))
    conn.executemany(
        """
        INSERT INTO financial_stock_basic_metrics (
          symbol, source, trade_date, close, turnover_rate, turnover_rate_f, volume_ratio,
          pe, pe_ttm, pb, ps, ps_ttm, dv_ratio, dv_ttm, total_share, float_share,
          free_share, total_mv_yuan, circ_mv_yuan, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, source, trade_date) DO UPDATE SET
          close = excluded.close,
          turnover_rate = excluded.turnover_rate,
          turnover_rate_f = excluded.turnover_rate_f,
          volume_ratio = excluded.volume_ratio,
          pe = excluded.pe,
          pe_ttm = excluded.pe_ttm,
          pb = excluded.pb,
          ps = excluded.ps,
          ps_ttm = excluded.ps_ttm,
          dv_ratio = excluded.dv_ratio,
          dv_ttm = excluded.dv_ttm,
          total_share = excluded.total_share,
          float_share = excluded.float_share,
          free_share = excluded.free_share,
          total_mv_yuan = excluded.total_mv_yuan,
          circ_mv_yuan = excluded.circ_mv_yuan,
          updated_at = excluded.updated_at
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def fetch_moneyflow(conn, pro, trade_date):
    df = pro.moneyflow(trade_date=trade_date)
    if df is None or df.empty:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
    rows = []
    for item in df.to_dict("records"):
        symbol = compact_symbol(item.get("ts_code"))
        if not symbol:
            continue
        rows.append((
            symbol,
            "tushare",
            format_date(item.get("trade_date") or trade_date),
            safe_float(item.get("buy_sm_amount")),
            safe_float(item.get("sell_sm_amount")),
            safe_float(item.get("buy_md_amount")),
            safe_float(item.get("sell_md_amount")),
            safe_float(item.get("buy_lg_amount")),
            safe_float(item.get("sell_lg_amount")),
            safe_float(item.get("buy_elg_amount")),
            safe_float(item.get("sell_elg_amount")),
            safe_float(item.get("net_mf_amount")),
            safe_float(item.get("net_mf_vol")),
            raw_json(item),
            now,
            now,
        ))
    conn.executemany(
        """
        INSERT INTO financial_moneyflow (
          symbol, source, trade_date, buy_sm_amount, sell_sm_amount, buy_md_amount,
          sell_md_amount, buy_lg_amount, sell_lg_amount, buy_elg_amount,
          sell_elg_amount, net_mf_amount, net_mf_vol, raw_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, source, trade_date) DO UPDATE SET
          buy_sm_amount = excluded.buy_sm_amount,
          sell_sm_amount = excluded.sell_sm_amount,
          buy_md_amount = excluded.buy_md_amount,
          sell_md_amount = excluded.sell_md_amount,
          buy_lg_amount = excluded.buy_lg_amount,
          sell_lg_amount = excluded.sell_lg_amount,
          buy_elg_amount = excluded.buy_elg_amount,
          sell_elg_amount = excluded.sell_elg_amount,
          net_mf_amount = excluded.net_mf_amount,
          net_mf_vol = excluded.net_mf_vol,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def fetch_moneyflow_ths(conn, pro, trade_date):
    df = pro.moneyflow_ths(trade_date=trade_date)
    if df is None or df.empty:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
    rows = []
    for item in df.to_dict("records"):
        symbol = compact_symbol(item.get("ts_code"))
        if not symbol:
            continue
        rows.append((
            symbol,
            safe_value(item.get("name")),
            "tushare",
            format_date(item.get("trade_date") or trade_date),
            safe_float(item.get("latest") or item.get("close")),
            safe_float(item.get("pct_change") or item.get("pct_chg")),
            safe_float(item.get("net_amount") or item.get("net_mf_amount")),
            safe_float(item.get("net_amount_rate") or item.get("net_rate")),
            safe_float(item.get("buy_lg_amount")),
            safe_float(item.get("buy_lg_amount_rate")),
            safe_float(item.get("buy_md_amount")),
            safe_float(item.get("buy_md_amount_rate")),
            raw_json(item),
            now,
            now,
        ))
    conn.executemany(
        """
        INSERT INTO financial_moneyflow_ths (
          symbol, name, source, trade_date, latest, pct_change, net_amount,
          net_amount_rate, buy_lg_amount, buy_lg_amount_rate, buy_md_amount,
          buy_md_amount_rate, raw_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, source, trade_date) DO UPDATE SET
          name = excluded.name,
          latest = excluded.latest,
          pct_change = excluded.pct_change,
          net_amount = excluded.net_amount,
          net_amount_rate = excluded.net_amount_rate,
          buy_lg_amount = excluded.buy_lg_amount,
          buy_lg_amount_rate = excluded.buy_lg_amount_rate,
          buy_md_amount = excluded.buy_md_amount,
          buy_md_amount_rate = excluded.buy_md_amount_rate,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def fetch_limits(conn, pro, trade_date):
    now = datetime.now().isoformat(timespec="seconds")
    price_count = 0
    event_count = 0

    limit_prices = pro.stk_limit(trade_date=trade_date)
    if limit_prices is not None and not limit_prices.empty:
        rows = []
        for item in limit_prices.to_dict("records"):
            symbol = compact_symbol(item.get("ts_code"))
            if not symbol:
                continue
            rows.append((
                symbol,
                "tushare",
                format_date(item.get("trade_date") or trade_date),
                safe_float(item.get("up_limit")),
                safe_float(item.get("down_limit")),
                now,
                now,
            ))
        conn.executemany(
            """
            INSERT INTO financial_limit_prices (
              symbol, source, trade_date, up_limit, down_limit, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, source, trade_date) DO UPDATE SET
              up_limit = excluded.up_limit,
              down_limit = excluded.down_limit,
              updated_at = excluded.updated_at
            """,
            rows,
        )
        price_count = len(rows)

    limit_events = pro.limit_list_d(trade_date=trade_date)
    if limit_events is not None and not limit_events.empty:
        rows = []
        for item in limit_events.to_dict("records"):
            symbol = compact_symbol(item.get("ts_code"))
            if not symbol:
                continue
            limit_status = str(item.get("limit") or item.get("limit_type") or item.get("status") or "").strip()
            rows.append((
                symbol,
                safe_value(item.get("name")),
                "tushare",
                format_date(item.get("trade_date") or trade_date),
                limit_status,
                safe_value(item.get("limit_type") or item.get("status")),
                safe_float(item.get("close")),
                safe_float(item.get("pct_chg")),
                safe_value(item.get("first_time")),
                safe_value(item.get("last_time")),
                int(safe_float(item.get("open_times")) or 0),
                safe_float(item.get("fd_amount")),
                safe_float(item.get("fc_ratio")),
                safe_float(item.get("fl_ratio")),
                raw_json(item),
                now,
                now,
            ))
        conn.executemany(
            """
            INSERT INTO financial_limit_events (
              symbol, name, source, trade_date, limit_status, limit_type, close, pct_chg,
              first_time, last_time, open_times, fd_amount, fc_ratio, fl_ratio,
              raw_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, source, trade_date, limit_status) DO UPDATE SET
              name = excluded.name,
              limit_type = excluded.limit_type,
              close = excluded.close,
              pct_chg = excluded.pct_chg,
              first_time = excluded.first_time,
              last_time = excluded.last_time,
              open_times = excluded.open_times,
              fd_amount = excluded.fd_amount,
              fc_ratio = excluded.fc_ratio,
              fl_ratio = excluded.fl_ratio,
              raw_json = excluded.raw_json,
              updated_at = excluded.updated_at
            """,
            rows,
        )
        event_count = len(rows)

    conn.commit()
    return {"limit_prices": price_count, "limit_events": event_count}


def fetch_sw_classify(conn, pro):
    now = datetime.now().isoformat(timespec="seconds")
    total = 0
    for level in ("L1", "L2", "L3"):
        df = pro.index_classify(level=level, src="SW2021")
        if df is None or df.empty:
            continue
        rows = []
        for item in df.to_dict("records"):
            index_code = str(item.get("index_code") or item.get("ts_code") or "").strip()
            if not index_code:
                continue
            rows.append((
                index_code,
                safe_value(item.get("industry_name") or item.get("name")),
                level,
                safe_value(item.get("parent_code")),
                "SW2021",
                raw_json(item),
                now,
                now,
            ))
        conn.executemany(
            """
            INSERT INTO financial_sw_industries (
              index_code, industry_name, level, parent_code, src, raw_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(index_code, src) DO UPDATE SET
              industry_name = excluded.industry_name,
              level = excluded.level,
              parent_code = excluded.parent_code,
              raw_json = excluded.raw_json,
              updated_at = excluded.updated_at
            """,
            rows,
        )
        total += len(rows)
    conn.commit()
    return total


def fetch_sw_members(conn, pro):
    now = datetime.now().isoformat(timespec="seconds")
    frames = []
    try:
        offset = 0
        while True:
            df = pro.index_member_all(is_new="Y", limit=3000, offset=offset)
            if df is None or df.empty:
                break
            frames.append(df)
            if len(df) < 3000:
                break
            offset += 3000
    except Exception:
        df = pro.index_member_all()
        if df is not None and not df.empty:
            frames.append(df)
    if not frames:
        return 0
    try:
        import pandas as pd
        df = pd.concat(frames, ignore_index=True).drop_duplicates()
    except Exception:
        df = frames[0]
    rows = []
    for item in df.to_dict("records"):
        symbol = compact_symbol(item.get("ts_code") or item.get("con_code"))
        if not symbol:
            continue
        rows.append((
            symbol,
            safe_value(item.get("name") or item.get("con_name")),
            safe_value(item.get("l1_code")),
            safe_value(item.get("l1_name")),
            safe_value(item.get("l2_code")),
            safe_value(item.get("l2_name")),
            safe_value(item.get("l3_code")),
            safe_value(item.get("l3_name")),
            format_date(item.get("in_date")) if item.get("in_date") else None,
            format_date(item.get("out_date")) if item.get("out_date") else None,
            safe_value(item.get("is_new")),
            "SW2021",
            raw_json(item),
            now,
            now,
        ))
    conn.executemany(
        """
        INSERT INTO financial_sw_industry_members (
          symbol, name, l1_code, l1_name, l2_code, l2_name, l3_code, l3_name,
          in_date, out_date, is_new, src, raw_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, src, l1_code, l2_code, l3_code) DO UPDATE SET
          name = excluded.name,
          in_date = excluded.in_date,
          out_date = excluded.out_date,
          is_new = excluded.is_new,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def fetch_sw_daily(conn, pro, trade_date):
    try:
        df = pro.sw_daily(trade_date=trade_date)
    except Exception:
        df = pro.sw_daily(start_date=trade_date, end_date=trade_date)
    if df is None or df.empty:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
    rows = []
    for item in df.to_dict("records"):
        index_code = str(item.get("ts_code") or item.get("index_code") or "").strip()
        if not index_code:
            continue
        rows.append((
            index_code,
            safe_value(item.get("name")),
            "tushare",
            format_date(item.get("trade_date") or trade_date),
            safe_float(item.get("open")),
            safe_float(item.get("high")),
            safe_float(item.get("low")),
            safe_float(item.get("close")),
            safe_float(item.get("pre_close")),
            safe_float(item.get("change") or item.get("change_amount")),
            safe_float(item.get("pct_change") or item.get("pct_chg")),
            safe_float(item.get("vol") or item.get("volume")),
            safe_float(item.get("amount")),
            raw_json(item),
            now,
            now,
        ))
    conn.executemany(
        """
        INSERT INTO financial_sw_industry_daily (
          index_code, name, source, trade_date, open, high, low, close, pre_close,
          change_amount, pct_change, volume, amount, raw_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(index_code, source, trade_date) DO UPDATE SET
          name = excluded.name,
          open = excluded.open,
          high = excluded.high,
          low = excluded.low,
          close = excluded.close,
          pre_close = excluded.pre_close,
          change_amount = excluded.change_amount,
          pct_change = excluded.pct_change,
          volume = excluded.volume,
          amount = excluded.amount,
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description="Fetch Tushare supplemental finance data into local SQLite.")
    parser.add_argument(
        "--db",
        default=os.environ.get(
            "BUSINESS_DB_PATH",
            os.environ.get("DB_PATH", "/Volumes/7100/price-dashboard-data/db/price_dashboard_business_dev.db"),
        ),
    )
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--start-date", default=None)
    parser.add_argument("--end-date", default=None)
    parser.add_argument("--sections", default="daily_basic,moneyflow,moneyflow_ths,limits,sw")
    parser.add_argument("--delay-seconds", type=float, default=0.15)
    parser.add_argument("--include-end-date", action="store_true")
    args = parser.parse_args()

    token = os.environ.get("TUSHARE_TOKEN")
    if not token:
        print(json.dumps({"success": False, "message": "TUSHARE_TOKEN 未配置"}, ensure_ascii=False))
        return 1

    try:
        import tushare as ts
    except ImportError as exc:
        print(json.dumps({"success": False, "message": f"Tushare模块未安装: {exc}"}, ensure_ascii=False))
        return 1

    sections = {section.strip() for section in args.sections.split(",") if section.strip()}
    conn = sqlite3.connect(args.db, timeout=60)
    conn.execute("PRAGMA busy_timeout = 60000")
    results = []
    failures = []
    try:
        ensure_schema(conn)
        trade_dates = get_trade_dates(conn, args.days, args.start_date, args.end_date, args.include_end_date)
        pro = ts.pro_api(token)

        if "sw" in sections:
            for key, label, fn in (
                ("sw_classify", "申万行业分类", lambda: fetch_sw_classify(conn, pro)),
                ("sw_members", "申万行业成分", lambda: fetch_sw_members(conn, pro)),
            ):
                try:
                    count = fn()
                    results.append({"section": key, "label": label, "count": count})
                except Exception as exc:
                    failures.append({"section": key, "message": str(exc)})
                time.sleep(args.delay_seconds)

        totals = {}
        for trade_date in trade_dates:
            daily_result = {"trade_date": format_date(trade_date)}
            if "daily_basic" in sections:
                try:
                    count = fetch_daily_basic(conn, pro, trade_date)
                    daily_result["daily_basic"] = count
                    totals["daily_basic"] = totals.get("daily_basic", 0) + count
                except Exception as exc:
                    failures.append({"section": "daily_basic", "trade_date": format_date(trade_date), "message": str(exc)})
                time.sleep(args.delay_seconds)

            if "moneyflow" in sections:
                try:
                    count = fetch_moneyflow(conn, pro, trade_date)
                    daily_result["moneyflow"] = count
                    totals["moneyflow"] = totals.get("moneyflow", 0) + count
                except Exception as exc:
                    failures.append({"section": "moneyflow", "trade_date": format_date(trade_date), "message": str(exc)})
                time.sleep(args.delay_seconds)

            if "moneyflow_ths" in sections:
                try:
                    count = fetch_moneyflow_ths(conn, pro, trade_date)
                    daily_result["moneyflow_ths"] = count
                    totals["moneyflow_ths"] = totals.get("moneyflow_ths", 0) + count
                except Exception as exc:
                    failures.append({"section": "moneyflow_ths", "trade_date": format_date(trade_date), "message": str(exc)})
                time.sleep(args.delay_seconds)

            if "limits" in sections:
                try:
                    value = fetch_limits(conn, pro, trade_date)
                    daily_result.update(value)
                    totals["limit_prices"] = totals.get("limit_prices", 0) + value["limit_prices"]
                    totals["limit_events"] = totals.get("limit_events", 0) + value["limit_events"]
                except Exception as exc:
                    failures.append({"section": "limits", "trade_date": format_date(trade_date), "message": str(exc)})
                time.sleep(args.delay_seconds)

            if "sw" in sections:
                try:
                    count = fetch_sw_daily(conn, pro, trade_date)
                    daily_result["sw_daily"] = count
                    totals["sw_daily"] = totals.get("sw_daily", 0) + count
                except Exception as exc:
                    failures.append({"section": "sw_daily", "trade_date": format_date(trade_date), "message": str(exc)})
                time.sleep(args.delay_seconds)

            results.append(daily_result)

        payload = {
            "success": len(results) > 0,
            "trade_dates": len(trade_dates),
            "sections": sorted(sections),
            "totals": totals,
            "failures": failures[:30],
            "failure_count": len(failures),
            "results_tail": results[-5:],
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 0 if payload["success"] else 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
