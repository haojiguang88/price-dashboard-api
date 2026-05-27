#!/usr/bin/env python3
import argparse
import json
import math
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path


DEFAULT_DB_PATH = os.environ.get(
    "BUSINESS_DB_PATH",
    os.environ.get("DB_PATH", "/Volumes/7100/price-dashboard-data/db/price_dashboard_business_dev.db"),
)
DEFAULT_SOURCE = "tushare_macro"
DEFAULT_START_DATE = "20200101"
USDCNH_CODE = "USDCNH.FXCM"
DXY_PAIR_WEIGHTS = {
    "EURUSD.FXCM": -0.576,
    "USDJPY.FXCM": 0.136,
    "GBPUSD.FXCM": -0.119,
    "USDCAD.FXCM": 0.091,
    "USDSEK.FXCM": 0.042,
    "USDCHF.FXCM": 0.036,
}
DXY_CONSTANT = 50.14348112


def load_env_file():
    for path in [Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"]:
        if not path.exists():
            continue
        for line in path.read_text(errors="ignore").splitlines():
            text = line.strip()
            if not text or text.startswith("#") or "=" not in text:
                continue
            key, value = text.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def to_float(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def round_number(value, digits=6):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, digits) if math.isfinite(number) else None


def format_tushare_date(value):
    text = str(value or "").strip()
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    return text[:10]


def compact_date(value):
    text = str(value or "").strip()
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return text.replace("-", "")
    return text


def is_weekend(value):
    try:
        return datetime.strptime(format_tushare_date(value), "%Y-%m-%d").weekday() >= 5
    except ValueError:
        return False


def date_range(start_date, end_date):
    start = datetime.strptime(format_tushare_date(start_date), "%Y-%m-%d")
    end = datetime.strptime(format_tushare_date(end_date), "%Y-%m-%d")
    cursor = start
    while cursor <= end:
        if cursor.weekday() < 5:
            yield cursor.strftime("%Y-%m-%d")
        cursor += timedelta(days=1)


def classify_cny_state(change_5d, change_20d):
    if (change_5d is not None and change_5d >= 0.003) or (change_20d is not None and change_20d >= 0.008):
        return "人民币贬值", "顺风"
    if (change_5d is not None and change_5d <= -0.003) or (change_20d is not None and change_20d <= -0.008):
        return "人民币升值", "逆风"
    return "人民币震荡", "中性"


def classify_dollar_state(change_5d, change_20d):
    if (change_5d is not None and change_5d >= 0.005) or (change_20d is not None and change_20d >= 0.015):
        return "美元走强", "逆风", "逆风"
    if (change_5d is not None and change_5d <= -0.005) or (change_20d is not None and change_20d <= -0.015):
        return "美元走弱", "顺风", "顺风"
    return "美元震荡", "中性", "中性"


def classify_rate_state(change_5d, change_20d, short_threshold=0.15, long_threshold=0.3):
    if (change_5d is not None and change_5d >= short_threshold) or (change_20d is not None and change_20d >= long_threshold):
        return "利率上行", "逆风"
    if (change_5d is not None and change_5d <= -short_threshold) or (change_20d is not None and change_20d <= -long_threshold):
        return "利率下行", "顺风"
    return "利率震荡", "中性"


def ensure_schema(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS metal_macro_factors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trade_date TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'tushare_macro',
          usd_cnh_mid REAL,
          usd_cnh_change_5d REAL,
          usd_cnh_change_20d REAL,
          cny_state TEXT,
          fx_tailwind_for_silver TEXT,
          dxy_proxy REAL,
          dxy_proxy_source TEXT,
          dxy_proxy_change_5d REAL,
          dxy_proxy_change_20d REAL,
          dollar_state TEXT,
          dollar_tailwind_for_gold TEXT,
          dollar_tailwind_for_silver TEXT,
          us10y_yield REAL,
          us10y_change_5d REAL,
          us10y_change_20d REAL,
          us10y_state TEXT,
          rate_tailwind_for_gold TEXT,
          us10y_real_yield REAL,
          real_yield_change_5d REAL,
          real_yield_change_20d REAL,
          real_yield_state TEXT,
          real_rate_tailwind_for_gold TEXT,
          raw_fx_json TEXT,
          raw_rate_json TEXT,
          raw_real_rate_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(trade_date, source)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_metal_macro_factors_date
        ON metal_macro_factors(trade_date DESC, source)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_metal_macro_factors_states
        ON metal_macro_factors(fx_tailwind_for_silver, dollar_tailwind_for_gold, real_rate_tailwind_for_gold, trade_date DESC)
        """
    )


def get_default_start_date(conn, source):
    row = conn.execute(
        "SELECT MAX(trade_date) FROM metal_macro_factors WHERE source = ?",
        (source,),
    ).fetchone()
    latest = row[0] if row else None
    if not latest:
        return DEFAULT_START_DATE
    try:
        start = datetime.strptime(latest, "%Y-%m-%d") - timedelta(days=60)
        return start.strftime("%Y%m%d")
    except ValueError:
        return DEFAULT_START_DATE


def connect_tushare():
    token = os.getenv("TUSHARE_TOKEN")
    if not token:
        raise RuntimeError("TUSHARE_TOKEN 未配置")
    try:
        import tushare as ts
    except ImportError as exc:
        raise RuntimeError(f"Tushare模块未安装: {exc}") from exc
    return ts.pro_api(token)


def mid_price(item):
    bid = to_float(item.get("bid_close"))
    ask = to_float(item.get("ask_close"))
    if bid is not None and ask is not None:
        return (bid + ask) / 2
    return bid if bid is not None else ask


def fetch_fx_series(pro, ts_code, start_date, end_date):
    df = pro.fx_daily(
        ts_code=ts_code,
        start_date=compact_date(start_date),
        end_date=compact_date(end_date),
    )
    rows = {}
    if df is None or df.empty:
        return rows
    for item in df.to_dict("records"):
        trade_date = format_tushare_date(item.get("trade_date"))
        if is_weekend(trade_date):
            continue
        value = mid_price(item)
        if value is None:
            continue
        rows[trade_date] = {
            "value": round_number(value, 8),
            "raw": item,
        }
    return rows


def fetch_rate_series(pro, endpoint, start_date, end_date):
    df = getattr(pro, endpoint)(
        start_date=compact_date(start_date),
        end_date=compact_date(end_date),
    )
    rows = {}
    if df is None or df.empty:
        return rows
    for item in df.to_dict("records"):
        trade_date = format_tushare_date(item.get("date") or item.get("trade_date"))
        if is_weekend(trade_date):
            continue
        value = to_float(item.get("y10"))
        if value is None:
            continue
        rows[trade_date] = {
            "value": round_number(value, 6),
            "raw": item,
        }
    return rows


def value_asof(series, trade_date, max_gap_days=7):
    if trade_date in series:
        return series[trade_date]
    cursor = datetime.strptime(trade_date, "%Y-%m-%d")
    for offset in range(1, max_gap_days + 1):
        candidate = (cursor - timedelta(days=offset)).strftime("%Y-%m-%d")
        if candidate in series:
            return series[candidate]
    return None


def compute_dxy_proxy(pair_values):
    value = DXY_CONSTANT
    for code, weight in DXY_PAIR_WEIGHTS.items():
        pair = pair_values.get(code)
        if pair is None or pair <= 0:
            return None
        value *= pair ** weight
    return round_number(value, 6)


def indexed_change(rows, index, key, offset, mode="ratio"):
    current = rows[index].get(key)
    if current is None or index < offset:
        return None
    previous = rows[index - offset].get(key)
    if previous is None:
        return None
    if mode == "diff":
        return round_number(float(current) - float(previous), 6)
    if previous == 0:
        return None
    return round_number(float(current) / float(previous) - 1, 6)


def build_factor_rows(pro, start_date, end_date):
    fx_codes = [USDCNH_CODE, *DXY_PAIR_WEIGHTS.keys()]
    fx_series = {code: fetch_fx_series(pro, code, start_date, end_date) for code in fx_codes}
    nominal_rates = fetch_rate_series(pro, "us_tycr", start_date, end_date)
    real_rates = fetch_rate_series(pro, "us_trycr", start_date, end_date)

    rows = []
    for trade_date in date_range(start_date, end_date):
        usdcnh = value_asof(fx_series[USDCNH_CODE], trade_date)
        pair_values = {}
        raw_fx = {}
        for code in DXY_PAIR_WEIGHTS:
            pair = value_asof(fx_series[code], trade_date)
            if pair:
                pair_values[code] = pair["value"]
                raw_fx[code] = pair["raw"]
        dxy_proxy = compute_dxy_proxy(pair_values)
        nominal = value_asof(nominal_rates, trade_date)
        real = value_asof(real_rates, trade_date)

        if not any([usdcnh, dxy_proxy is not None, nominal, real]):
            continue

        row = {
            "trade_date": trade_date,
            "usd_cnh_mid": usdcnh["value"] if usdcnh else None,
            "dxy_proxy": dxy_proxy,
            "dxy_proxy_source": "FXCM synthetic DXY basket" if dxy_proxy is not None else None,
            "us10y_yield": nominal["value"] if nominal else None,
            "us10y_real_yield": real["value"] if real else None,
            "raw_fx_json": json.dumps({
                "USDCNH": usdcnh["raw"] if usdcnh else None,
                "DXY_PAIRS": raw_fx,
            }, ensure_ascii=False, default=str),
            "raw_rate_json": json.dumps(nominal["raw"], ensure_ascii=False, default=str) if nominal else None,
            "raw_real_rate_json": json.dumps(real["raw"], ensure_ascii=False, default=str) if real else None,
        }
        rows.append(row)

    for index, row in enumerate(rows):
        row["usd_cnh_change_5d"] = indexed_change(rows, index, "usd_cnh_mid", 5)
        row["usd_cnh_change_20d"] = indexed_change(rows, index, "usd_cnh_mid", 20)
        row["cny_state"], row["fx_tailwind_for_silver"] = classify_cny_state(
            row["usd_cnh_change_5d"],
            row["usd_cnh_change_20d"],
        )

        row["dxy_proxy_change_5d"] = indexed_change(rows, index, "dxy_proxy", 5)
        row["dxy_proxy_change_20d"] = indexed_change(rows, index, "dxy_proxy", 20)
        dollar_state, dollar_gold, dollar_silver = classify_dollar_state(
            row["dxy_proxy_change_5d"],
            row["dxy_proxy_change_20d"],
        )
        row["dollar_state"] = dollar_state
        row["dollar_tailwind_for_gold"] = dollar_gold
        row["dollar_tailwind_for_silver"] = dollar_silver

        row["us10y_change_5d"] = indexed_change(rows, index, "us10y_yield", 5, "diff")
        row["us10y_change_20d"] = indexed_change(rows, index, "us10y_yield", 20, "diff")
        row["us10y_state"], row["rate_tailwind_for_gold"] = classify_rate_state(
            row["us10y_change_5d"],
            row["us10y_change_20d"],
        )

        row["real_yield_change_5d"] = indexed_change(rows, index, "us10y_real_yield", 5, "diff")
        row["real_yield_change_20d"] = indexed_change(rows, index, "us10y_real_yield", 20, "diff")
        row["real_yield_state"], row["real_rate_tailwind_for_gold"] = classify_rate_state(
            row["real_yield_change_5d"],
            row["real_yield_change_20d"],
            short_threshold=0.1,
            long_threshold=0.2,
        )

    return rows, {
        "fx_series_counts": {code: len(series) for code, series in fx_series.items()},
        "nominal_rate_count": len(nominal_rates),
        "real_rate_count": len(real_rates),
    }


def comparable_payload(row):
    keys = [
        "usd_cnh_mid", "usd_cnh_change_5d", "usd_cnh_change_20d", "cny_state", "fx_tailwind_for_silver",
        "dxy_proxy", "dxy_proxy_change_5d", "dxy_proxy_change_20d", "dollar_state",
        "dollar_tailwind_for_gold", "dollar_tailwind_for_silver", "us10y_yield",
        "us10y_change_5d", "us10y_change_20d", "us10y_state", "rate_tailwind_for_gold",
        "us10y_real_yield", "real_yield_change_5d", "real_yield_change_20d",
        "real_yield_state", "real_rate_tailwind_for_gold",
    ]
    return {key: row.get(key) for key in keys}


def same_payload(left, right):
    return json.dumps(left, sort_keys=True, ensure_ascii=False) == json.dumps(right, sort_keys=True, ensure_ascii=False)


def upsert_rows(conn, rows, source, dry_run=False):
    inserted = 0
    updated = 0
    skipped = 0
    now_text = datetime.now().isoformat()
    columns = [
        "usd_cnh_mid", "usd_cnh_change_5d", "usd_cnh_change_20d", "cny_state", "fx_tailwind_for_silver",
        "dxy_proxy", "dxy_proxy_source", "dxy_proxy_change_5d", "dxy_proxy_change_20d", "dollar_state",
        "dollar_tailwind_for_gold", "dollar_tailwind_for_silver", "us10y_yield", "us10y_change_5d",
        "us10y_change_20d", "us10y_state", "rate_tailwind_for_gold", "us10y_real_yield",
        "real_yield_change_5d", "real_yield_change_20d", "real_yield_state", "real_rate_tailwind_for_gold",
        "raw_fx_json", "raw_rate_json", "raw_real_rate_json",
    ]

    for row in rows:
        existing = conn.execute(
            """
            SELECT *
            FROM metal_macro_factors
            WHERE trade_date = ? AND source = ?
            """,
            (row["trade_date"], source),
        ).fetchone()
        if dry_run:
            inserted += 0 if existing else 1
            skipped += 1 if existing else 0
            continue

        if existing:
            existing_payload = comparable_payload(dict(existing))
            new_payload = comparable_payload(row)
            if same_payload(existing_payload, new_payload):
                skipped += 1
                continue
            set_clause = ", ".join([f"{column} = ?" for column in columns])
            conn.execute(
                f"""
                UPDATE metal_macro_factors
                SET {set_clause}, updated_at = ?
                WHERE id = ?
                """,
                [row.get(column) for column in columns] + [now_text, existing["id"]],
            )
            updated += 1
            continue

        conn.execute(
            f"""
            INSERT INTO metal_macro_factors (
              trade_date, source, {", ".join(columns)}, created_at, updated_at
            ) VALUES (
              ?, ?, {", ".join(["?" for _ in columns])}, ?, ?
            )
            """,
            [row["trade_date"], source] + [row.get(column) for column in columns] + [now_text, now_text],
        )
        inserted += 1
    return inserted, updated, skipped


def main():
    load_env_file()
    parser = argparse.ArgumentParser(description="Fetch Tushare macro factors for precious metal validation")
    parser.add_argument("--db", default=os.environ.get("DB_PATH", DEFAULT_DB_PATH), help="SQLite database path")
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="Stored source name")
    parser.add_argument("--start-date", default="", help="YYYYMMDD or YYYY-MM-DD")
    parser.add_argument("--end-date", default=datetime.now().strftime("%Y%m%d"), help="YYYYMMDD or YYYY-MM-DD")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and parse without writing database")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not args.dry_run and not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        ensure_schema(conn)
        start_date = args.start_date or get_default_start_date(conn, args.source)
        pro = connect_tushare()
        rows, source_counts = build_factor_rows(pro, start_date, args.end_date)
        inserted, updated, skipped = upsert_rows(conn, rows, args.source, args.dry_run)
        if not args.dry_run:
            conn.commit()

        latest = conn.execute(
            """
            SELECT trade_date, usd_cnh_mid, cny_state, fx_tailwind_for_silver,
                   dxy_proxy, dollar_state, dollar_tailwind_for_gold,
                   us10y_yield, us10y_state, rate_tailwind_for_gold,
                   us10y_real_yield, real_yield_state, real_rate_tailwind_for_gold
            FROM metal_macro_factors
            WHERE source = ?
            ORDER BY trade_date DESC
            LIMIT 1
            """,
            (args.source,),
        ).fetchone()
        latest_payload = dict(latest) if latest else None
        print(json.dumps({
            "success": True,
            "message": f"贵金属宏观辅助因子更新完成：新增 {inserted}，更新 {updated}，跳过 {skipped}",
            "source": args.source,
            "start_date": format_tushare_date(start_date),
            "end_date": format_tushare_date(args.end_date),
            "fetched_count": len(rows),
            "inserted_count": inserted,
            "updated_count": updated,
            "skipped_count": skipped,
            "source_counts": source_counts,
            "latest": latest_payload,
        }, ensure_ascii=False))
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({
            "success": False,
            "message": str(exc),
        }, ensure_ascii=False))
        raise
