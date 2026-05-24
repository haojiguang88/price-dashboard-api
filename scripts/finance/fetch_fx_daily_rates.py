#!/usr/bin/env python3
import argparse
import json
import math
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path


DEFAULT_DB_PATH = "/Volumes/7100/price-dashboard-data/db/price_dashboard_dev.db"
DEFAULT_TS_CODE = "USDCNH.FXCM"
DEFAULT_SOURCE = "tushare_fxcm"
DEFAULT_START_DATE = "20200101"


def load_env_file():
    for path in [Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"]:
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
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


def round_number(value, digits=6):
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def same_number(left, right, digits=6):
    left_number = round_number(to_float(left), digits)
    right_number = round_number(to_float(right), digits)
    return left_number == right_number


def classify_cny_state(change_5d, change_20d):
    # USDCNH 上行 = 人民币贬值；对白银人民币价格偏顺风。
    if (change_5d is not None and change_5d >= 0.003) or (change_20d is not None and change_20d >= 0.008):
        return "人民币贬值", "顺风"
    if (change_5d is not None and change_5d <= -0.003) or (change_20d is not None and change_20d <= -0.008):
        return "人民币升值", "逆风"
    return "人民币震荡", "中性"


def ensure_schema(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS fx_daily_rates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trade_date TEXT NOT NULL,
          ts_code TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'tushare_fxcm',
          usd_cny_mid REAL NOT NULL,
          bid_open REAL,
          bid_close REAL,
          bid_high REAL,
          bid_low REAL,
          ask_open REAL,
          ask_close REAL,
          ask_high REAL,
          ask_low REAL,
          tick_qty REAL,
          usd_cny_change_5d REAL,
          usd_cny_change_20d REAL,
          cny_state TEXT NOT NULL DEFAULT '人民币震荡',
          fx_tailwind_for_silver TEXT NOT NULL DEFAULT '中性',
          raw_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(trade_date, ts_code, source)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_fx_daily_rates_scope
        ON fx_daily_rates(ts_code, source, trade_date DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_fx_daily_rates_tailwind
        ON fx_daily_rates(fx_tailwind_for_silver, cny_state, trade_date DESC)
        """
    )


def get_default_start_date(conn, ts_code, source):
    row = conn.execute(
        "SELECT MAX(trade_date) FROM fx_daily_rates WHERE ts_code = ? AND source = ?",
        (ts_code, source),
    ).fetchone()
    latest = row[0] if row else None
    if not latest:
        return DEFAULT_START_DATE
    try:
        start = datetime.strptime(latest, "%Y-%m-%d") - timedelta(days=45)
        return start.strftime("%Y%m%d")
    except ValueError:
        return DEFAULT_START_DATE


def fetch_tushare_fx(ts_code, start_date, end_date):
    token = os.getenv("TUSHARE_TOKEN")
    if not token:
        raise RuntimeError("TUSHARE_TOKEN 未配置")
    try:
        import tushare as ts
    except ImportError as exc:
        raise RuntimeError(f"Tushare模块未安装: {exc}") from exc

    pro = ts.pro_api(token)
    df = pro.fx_daily(
        ts_code=ts_code,
        start_date=compact_date(start_date),
        end_date=compact_date(end_date),
    )
    if df is None or df.empty:
        return []

    rows = []
    for item in df.to_dict("records"):
        trade_date = format_tushare_date(item.get("trade_date"))
        if is_weekend(trade_date):
            continue
        bid_close = to_float(item.get("bid_close"))
        ask_close = to_float(item.get("ask_close"))
        if bid_close is None and ask_close is None:
            continue
        if bid_close is not None and ask_close is not None:
            mid = (bid_close + ask_close) / 2
        else:
            mid = bid_close if bid_close is not None else ask_close

        rows.append({
            "trade_date": trade_date,
            "ts_code": item.get("ts_code") or ts_code,
            "usd_cny_mid": round_number(mid, 6),
            "bid_open": to_float(item.get("bid_open")),
            "bid_close": bid_close,
            "bid_high": to_float(item.get("bid_high")),
            "bid_low": to_float(item.get("bid_low")),
            "ask_open": to_float(item.get("ask_open")),
            "ask_close": ask_close,
            "ask_high": to_float(item.get("ask_high")),
            "ask_low": to_float(item.get("ask_low")),
            "tick_qty": to_float(item.get("tick_qty")),
            "raw_json": json.dumps(item, ensure_ascii=False, default=str),
        })
    rows.sort(key=lambda row: row["trade_date"])
    return rows


def upsert_rows(conn, rows, source, dry_run=False):
    inserted = 0
    updated = 0
    skipped = 0
    now = datetime.now().isoformat()

    for row in rows:
        existing = conn.execute(
            """
            SELECT id, usd_cny_mid, bid_close, ask_close
            FROM fx_daily_rates
            WHERE trade_date = ? AND ts_code = ? AND source = ?
            """,
            (row["trade_date"], row["ts_code"], source),
        ).fetchone()

        if dry_run:
            if existing:
                skipped += 1
            else:
                inserted += 1
            continue

        if existing:
            _, old_mid, old_bid_close, old_ask_close = existing
            changed = (
                not same_number(old_mid, row["usd_cny_mid"])
                or not same_number(old_bid_close, row["bid_close"])
                or not same_number(old_ask_close, row["ask_close"])
            )
            if not changed:
                skipped += 1
                continue
            conn.execute(
                """
                UPDATE fx_daily_rates
                SET usd_cny_mid = ?, bid_open = ?, bid_close = ?, bid_high = ?, bid_low = ?,
                    ask_open = ?, ask_close = ?, ask_high = ?, ask_low = ?, tick_qty = ?,
                    raw_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    row["usd_cny_mid"], row["bid_open"], row["bid_close"], row["bid_high"], row["bid_low"],
                    row["ask_open"], row["ask_close"], row["ask_high"], row["ask_low"], row["tick_qty"],
                    row["raw_json"], now, existing[0],
                ),
            )
            updated += 1
            continue

        conn.execute(
            """
            INSERT INTO fx_daily_rates (
              trade_date, ts_code, source, usd_cny_mid,
              bid_open, bid_close, bid_high, bid_low,
              ask_open, ask_close, ask_high, ask_low, tick_qty,
              raw_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["trade_date"], row["ts_code"], source, row["usd_cny_mid"],
                row["bid_open"], row["bid_close"], row["bid_high"], row["bid_low"],
                row["ask_open"], row["ask_close"], row["ask_high"], row["ask_low"], row["tick_qty"],
                row["raw_json"], now, now,
            ),
        )
        inserted += 1

    return inserted, updated, skipped


def recompute_derived_fields(conn, ts_code, source, dry_run=False):
    rows = conn.execute(
        """
        SELECT id, usd_cny_mid
        FROM fx_daily_rates
        WHERE ts_code = ? AND source = ?
        ORDER BY trade_date ASC
        """,
        (ts_code, source),
    ).fetchall()

    updated = 0
    for index, row in enumerate(rows):
        row_id, mid = row
        change_5d = None
        change_20d = None
        if index >= 5 and rows[index - 5][1]:
            change_5d = float(mid) / float(rows[index - 5][1]) - 1
        if index >= 20 and rows[index - 20][1]:
            change_20d = float(mid) / float(rows[index - 20][1]) - 1
        cny_state, tailwind = classify_cny_state(change_5d, change_20d)
        if not dry_run:
            conn.execute(
                """
                UPDATE fx_daily_rates
                SET usd_cny_change_5d = ?, usd_cny_change_20d = ?,
                    cny_state = ?, fx_tailwind_for_silver = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    round_number(change_5d, 6),
                    round_number(change_20d, 6),
                    cny_state,
                    tailwind,
                    datetime.now().isoformat(),
                    row_id,
                ),
            )
        updated += 1
    return updated


def main():
    load_env_file()
    parser = argparse.ArgumentParser(description="Fetch Tushare FX daily rates for USD/CNY auxiliary factor")
    parser.add_argument("--db", default=os.environ.get("DB_PATH", DEFAULT_DB_PATH), help="SQLite database path")
    parser.add_argument("--ts-code", default=DEFAULT_TS_CODE, help="Tushare FX ts_code")
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="Stored source name")
    parser.add_argument("--start-date", default="", help="YYYYMMDD or YYYY-MM-DD")
    parser.add_argument("--end-date", default=datetime.now().strftime("%Y%m%d"), help="YYYYMMDD or YYYY-MM-DD")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and parse without writing database")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not args.dry_run and not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")

    conn = sqlite3.connect(str(db_path))
    try:
        ensure_schema(conn)
        start_date = args.start_date or get_default_start_date(conn, args.ts_code, args.source)
        rows = fetch_tushare_fx(args.ts_code, start_date, args.end_date)
        inserted, updated, skipped = upsert_rows(conn, rows, args.source, args.dry_run)
        derived_updated = recompute_derived_fields(conn, args.ts_code, args.source, args.dry_run)
        if not args.dry_run:
            conn.commit()

        latest = conn.execute(
            """
            SELECT trade_date, usd_cny_mid, usd_cny_change_5d, usd_cny_change_20d,
                   cny_state, fx_tailwind_for_silver
            FROM fx_daily_rates
            WHERE ts_code = ? AND source = ?
            ORDER BY trade_date DESC
            LIMIT 1
            """,
            (args.ts_code, args.source),
        ).fetchone()
        latest_payload = None
        if latest:
            latest_payload = {
                "trade_date": latest[0],
                "usd_cny_mid": latest[1],
                "usd_cny_change_5d": latest[2],
                "usd_cny_change_20d": latest[3],
                "cny_state": latest[4],
                "fx_tailwind_for_silver": latest[5],
            }

        print(json.dumps({
            "success": True,
            "message": f"USD/CNY 汇率辅助更新完成：新增 {inserted}，更新 {updated}，跳过 {skipped}",
            "ts_code": args.ts_code,
            "source": args.source,
            "start_date": format_tushare_date(start_date),
            "end_date": format_tushare_date(args.end_date),
            "fetched_count": len(rows),
            "inserted_count": inserted,
            "updated_count": updated,
            "skipped_count": skipped,
            "derived_updated_count": derived_updated,
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
