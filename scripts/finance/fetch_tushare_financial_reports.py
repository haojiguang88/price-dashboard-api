#!/usr/bin/env python3
import argparse
import json
import math
import os
import sqlite3
import time
from datetime import datetime


DEFAULT_SECTIONS = "income_vip,balancesheet_vip,cashflow_vip,fina_indicator_vip"
REPORT_QUARTER_ENDS = ("0331", "0630", "0930", "1231")


def normalize_date(value):
    text = str(value or "").strip()
    if "-" in text:
        text = text.replace("-", "")
    return text


def format_date(value):
    text = normalize_date(value)
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    return str(value or "").strip() or None


def compact_symbol(ts_code):
    text = str(ts_code or "").strip()
    if not text:
        return ""
    return text.split(".")[0].zfill(6)


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
        number = float(value)
        return number if math.isfinite(number) else None
    except Exception:
        return None


def first_value(item, *keys):
    for key in keys:
        value = safe_value(item.get(key))
        if value is not None and value != "":
            return value
    return None


def first_float(item, *keys):
    for key in keys:
        value = safe_float(item.get(key))
        if value is not None:
            return value
    return None


def raw_json(row):
    return json.dumps({key: safe_value(value) for key, value in dict(row).items()}, ensure_ascii=False)


def compare_date_text(value):
    text = normalize_date(value)
    return text if len(text) == 8 and text.isdigit() else ""


def latest_text(*values):
    formatted = [format_date(value) for value in values if value]
    if not formatted:
        return None
    return max(formatted, key=compare_date_text)


def latest_periods(count):
    today = datetime.now()
    periods = []
    for year in range(today.year, today.year - 8, -1):
        for suffix in reversed(REPORT_QUARTER_ENDS):
            period = f"{year}{suffix}"
            if period <= today.strftime("%Y%m%d"):
                periods.append(period)
            if len(periods) >= count:
                return periods
    return periods


def ensure_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS financial_report_structured (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          name TEXT,
          source TEXT NOT NULL DEFAULT 'tushare',
          end_date TEXT NOT NULL,
          ann_date TEXT,
          f_ann_date TEXT,
          report_type TEXT,
          comp_type TEXT,
          total_revenue REAL,
          revenue REAL,
          operate_profit REAL,
          total_profit REAL,
          net_profit REAL,
          net_profit_parent REAL,
          basic_eps REAL,
          total_assets REAL,
          total_liab REAL,
          total_equity REAL,
          money_cap REAL,
          inventories REAL,
          accounts_receiv REAL,
          contract_liab REAL,
          n_cashflow_act REAL,
          c_fr_sale_sg REAL,
          free_cashflow REAL,
          roe REAL,
          grossprofit_margin REAL,
          netprofit_margin REAL,
          debt_to_assets REAL,
          current_ratio REAL,
          quick_ratio REAL,
          revenue_yoy REAL,
          netprofit_yoy REAL,
          ocf_yoy REAL,
          ocf_to_net_profit REAL,
          raw_income_json TEXT,
          raw_balance_json TEXT,
          raw_cashflow_json TEXT,
          raw_indicator_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(symbol, source, end_date)
        );

        CREATE INDEX IF NOT EXISTS idx_financial_report_structured_period
        ON financial_report_structured(end_date DESC, source, symbol);

        CREATE INDEX IF NOT EXISTS idx_financial_report_structured_visible
        ON financial_report_structured(f_ann_date DESC, ann_date DESC, symbol);
        """
    )
    conn.commit()


def get_name_map(conn):
    try:
        rows = conn.execute(
            """
            SELECT symbol, MAX(name) AS name
            FROM financial_asset_universe
            WHERE asset_type = 'stock'
              AND source = 'tushare'
              AND name IS NOT NULL
              AND TRIM(name) <> ''
            GROUP BY symbol
            """
        ).fetchall()
    except sqlite3.Error:
        return {}
    return {str(row[0]).zfill(6): row[1] for row in rows if row[0] and row[1]}


def query_tushare(pro, endpoint, **kwargs):
    if hasattr(pro, "query"):
        return pro.query(endpoint, **kwargs)
    method = getattr(pro, endpoint)
    return method(**kwargs)


def fetch_endpoint_period(pro, endpoint, period, limit, delay_seconds):
    offset = 0
    rows = []
    while True:
        df = query_tushare(pro, endpoint, period=period, limit=limit, offset=offset)
        if df is None or df.empty:
            break
        records = df.to_dict("records")
        rows.extend(records)
        if len(records) < limit:
            break
        offset += limit
        time.sleep(delay_seconds)
    return rows


def select_latest_records(records):
    selected = {}
    for item in records:
        symbol = compact_symbol(item.get("ts_code"))
        end_date = format_date(item.get("end_date"))
        if not symbol or not end_date:
            continue
        key = (symbol, end_date)
        current = selected.get(key)
        if current is None:
            selected[key] = item
            continue
        current_visible = compare_date_text(first_value(current, "f_ann_date", "ann_date"))
        item_visible = compare_date_text(first_value(item, "f_ann_date", "ann_date"))
        if item_visible >= current_visible:
            selected[key] = item
    return selected


def touch_common_fact(fact, item, name_map):
    symbol = fact["symbol"]
    fact["name"] = first_value(item, "name") or name_map.get(symbol) or fact.get("name")
    fact["ann_date"] = latest_text(fact.get("ann_date"), item.get("ann_date"))
    fact["f_ann_date"] = latest_text(fact.get("f_ann_date"), item.get("f_ann_date"))
    fact["report_type"] = str(first_value(item, "report_type") or fact.get("report_type") or "").strip() or None
    fact["comp_type"] = str(first_value(item, "comp_type") or fact.get("comp_type") or "").strip() or None


def merge_income(facts, records, name_map):
    for key, item in select_latest_records(records).items():
        symbol, end_date = key
        fact = facts.setdefault(key, {"symbol": symbol, "end_date": end_date})
        touch_common_fact(fact, item, name_map)
        fact.update({
            "total_revenue": first_float(item, "total_revenue"),
            "revenue": first_float(item, "revenue"),
            "operate_profit": first_float(item, "operate_profit"),
            "total_profit": first_float(item, "total_profit"),
            "net_profit": first_float(item, "n_income", "net_profit"),
            "net_profit_parent": first_float(item, "n_income_attr_p", "net_profit_parent"),
            "basic_eps": first_float(item, "basic_eps"),
            "raw_income_json": raw_json(item),
        })


def merge_balance(facts, records, name_map):
    for key, item in select_latest_records(records).items():
        symbol, end_date = key
        fact = facts.setdefault(key, {"symbol": symbol, "end_date": end_date})
        touch_common_fact(fact, item, name_map)
        fact.update({
            "total_assets": first_float(item, "total_assets"),
            "total_liab": first_float(item, "total_liab"),
            "total_equity": first_float(item, "total_hldr_eqy_inc_min_int", "total_hldr_eqy_exc_min_int"),
            "money_cap": first_float(item, "money_cap"),
            "inventories": first_float(item, "inventories"),
            "accounts_receiv": first_float(item, "accounts_receiv", "acct_rcv"),
            "contract_liab": first_float(item, "contract_liab", "contract_liabilities"),
            "raw_balance_json": raw_json(item),
        })


def merge_cashflow(facts, records, name_map):
    for key, item in select_latest_records(records).items():
        symbol, end_date = key
        fact = facts.setdefault(key, {"symbol": symbol, "end_date": end_date})
        touch_common_fact(fact, item, name_map)
        fact.update({
            "n_cashflow_act": first_float(item, "n_cashflow_act"),
            "c_fr_sale_sg": first_float(item, "c_fr_sale_sg"),
            "free_cashflow": first_float(item, "free_cashflow"),
            "raw_cashflow_json": raw_json(item),
        })


def merge_indicator(facts, records, name_map):
    for key, item in select_latest_records(records).items():
        symbol, end_date = key
        fact = facts.setdefault(key, {"symbol": symbol, "end_date": end_date})
        touch_common_fact(fact, item, name_map)
        fact.update({
            "roe": first_float(item, "roe", "roe_dt"),
            "grossprofit_margin": first_float(item, "grossprofit_margin"),
            "netprofit_margin": first_float(item, "netprofit_margin"),
            "debt_to_assets": first_float(item, "debt_to_assets"),
            "current_ratio": first_float(item, "current_ratio"),
            "quick_ratio": first_float(item, "quick_ratio"),
            "revenue_yoy": first_float(item, "tr_yoy", "or_yoy"),
            "netprofit_yoy": first_float(item, "netprofit_yoy", "dt_netprofit_yoy"),
            "ocf_yoy": first_float(item, "ocf_yoy"),
            "raw_indicator_json": raw_json(item),
        })


def finalize_fact(fact):
    fact["source"] = str(fact.get("source") or "tushare").strip() or "tushare"
    ocf = fact.get("n_cashflow_act")
    net_profit = fact.get("net_profit_parent") or fact.get("net_profit")
    if ocf is not None and net_profit not in (None, 0):
        fact["ocf_to_net_profit"] = ocf / net_profit
    return fact


UPSERT_COLUMNS = [
    "symbol", "name", "source", "end_date", "ann_date", "f_ann_date", "report_type", "comp_type",
    "total_revenue", "revenue", "operate_profit", "total_profit", "net_profit", "net_profit_parent",
    "basic_eps", "total_assets", "total_liab", "total_equity", "money_cap", "inventories",
    "accounts_receiv", "contract_liab", "n_cashflow_act", "c_fr_sale_sg", "free_cashflow", "roe",
    "grossprofit_margin", "netprofit_margin", "debt_to_assets", "current_ratio", "quick_ratio",
    "revenue_yoy", "netprofit_yoy", "ocf_yoy", "ocf_to_net_profit", "raw_income_json",
    "raw_balance_json", "raw_cashflow_json", "raw_indicator_json"
]


def upsert_facts(conn, facts):
    if not facts:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
    columns = [*UPSERT_COLUMNS, "created_at", "updated_at"]
    placeholders = ", ".join("?" for _ in columns)
    update_columns = [column for column in UPSERT_COLUMNS if column not in ("symbol", "source", "end_date")]
    update_sql = ",\n          ".join(
        f"{column} = COALESCE(excluded.{column}, financial_report_structured.{column})"
        for column in update_columns
    )
    update_sql = f"{update_sql},\n          updated_at = excluded.updated_at"
    sql = f"""
        INSERT INTO financial_report_structured ({", ".join(columns)})
        VALUES ({placeholders})
        ON CONFLICT(symbol, source, end_date) DO UPDATE SET
          {update_sql}
    """
    rows = []
    for fact in facts:
        finalized = finalize_fact(fact)
        rows.append([
            finalized.get(column) if column != "source" else finalized.get("source") or "tushare"
            for column in UPSERT_COLUMNS
        ] + [now, now])
    conn.executemany(sql, rows)
    conn.commit()
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description="Fetch Tushare structured financial reports into local SQLite.")
    parser.add_argument("--db", default=os.environ.get("DB_PATH", "/Volumes/7100/price-dashboard-data/db/price_dashboard_dev.db"))
    parser.add_argument("--sections", default=DEFAULT_SECTIONS)
    parser.add_argument("--periods", default=None, help="Comma separated report periods, e.g. 20250331,20250630")
    parser.add_argument("--period-count", type=int, default=8)
    parser.add_argument("--limit", type=int, default=5000)
    parser.add_argument("--delay-seconds", type=float, default=0.3)
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

    sections = [section.strip() for section in args.sections.split(",") if section.strip()]
    periods = [
        normalize_date(period)
        for period in (args.periods.split(",") if args.periods else latest_periods(max(args.period_count, 1)))
        if normalize_date(period)
    ]
    endpoint_mergers = {
        "income_vip": merge_income,
        "balancesheet_vip": merge_balance,
        "cashflow_vip": merge_cashflow,
        "fina_indicator_vip": merge_indicator,
    }

    conn = sqlite3.connect(args.db, timeout=60)
    conn.execute("PRAGMA busy_timeout = 60000")
    failures = []
    results = []
    totals = {section: 0 for section in sections}
    upserted_total = 0
    try:
        ensure_schema(conn)
        name_map = get_name_map(conn)
        pro = ts.pro_api(token)

        for period in periods:
            facts = {}
            period_result = {"period": format_date(period), "sections": {}}
            for endpoint in sections:
                merger = endpoint_mergers.get(endpoint)
                if not merger:
                    failures.append({"section": endpoint, "period": format_date(period), "message": "暂未接入该财报接口"})
                    continue
                try:
                    records = fetch_endpoint_period(pro, endpoint, period, max(args.limit, 100), args.delay_seconds)
                    totals[endpoint] = totals.get(endpoint, 0) + len(records)
                    period_result["sections"][endpoint] = len(records)
                    merger(facts, records, name_map)
                except Exception as exc:
                    failures.append({"section": endpoint, "period": format_date(period), "message": str(exc)})
                time.sleep(args.delay_seconds)
            upserted = upsert_facts(conn, list(facts.values()))
            upserted_total += upserted
            period_result["upserted_facts"] = upserted
            results.append(period_result)

        payload = {
            "success": upserted_total > 0,
            "periods": [format_date(period) for period in periods],
            "sections": sections,
            "totals": totals,
            "upserted_facts": upserted_total,
            "failure_count": len(failures),
            "failures": failures[:30],
            "results_tail": results[-5:],
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 0 if payload["success"] else 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
