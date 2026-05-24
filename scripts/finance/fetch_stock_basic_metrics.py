#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
from datetime import datetime


def normalize_date(value: str) -> str:
    text = str(value or "").strip()
    if "-" in text:
        return text.replace("-", "")
    return text


def format_date(value: str) -> str:
    text = normalize_date(value)
    if len(text) == 8:
        return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    return value


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS financial_stock_basic_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'tushare',
          trade_date TEXT NOT NULL,
          total_mv_yuan REAL,
          circ_mv_yuan REAL,
          turnover_rate REAL,
          pe REAL,
          pb REAL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(symbol, source, trade_date)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_financial_stock_basic_metrics_symbol
        ON financial_stock_basic_metrics(symbol, source, trade_date)
        """
    )


def get_default_trade_date(conn: sqlite3.Connection) -> str:
    row = conn.execute(
        """
        SELECT MAX(trade_date)
        FROM financial_daily_prices
        WHERE asset_type = 'stock' AND source = 'tushare'
        """
    ).fetchone()
    if not row or not row[0]:
        return datetime.now().strftime("%Y%m%d")
    return normalize_date(row[0])


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch latest A-share daily_basic market-cap snapshots into local DB.")
    parser.add_argument("--db", default=os.environ.get("DB_PATH", "/Volumes/7100/price-dashboard-data/db/price_dashboard_dev.db"))
    parser.add_argument("--trade-date", default=None, help="YYYYMMDD or YYYY-MM-DD. Defaults to latest local stock trade_date.")
    parser.add_argument("--source", default="tushare")
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

    conn = sqlite3.connect(args.db)
    try:
        ensure_schema(conn)
        trade_date = normalize_date(args.trade_date or get_default_trade_date(conn))
        pro = ts.pro_api(token)
        df = pro.daily_basic(
            trade_date=trade_date,
            fields="ts_code,trade_date,turnover_rate,pe,pb,total_mv,circ_mv"
        )

        if df is None or df.empty:
            print(json.dumps({"success": False, "message": f"{trade_date} daily_basic 返回为空"}, ensure_ascii=False))
            return 1

        now = datetime.now().isoformat(timespec="seconds")
        rows = []
        for _, item in df.iterrows():
            symbol = str(item.get("ts_code", "")).split(".")[0]
            if not symbol:
                continue
            total_mv = item.get("total_mv")
            circ_mv = item.get("circ_mv")
            rows.append((
                symbol,
                args.source,
                format_date(str(item.get("trade_date") or trade_date)),
                None if total_mv is None else float(total_mv) * 10000,
                None if circ_mv is None else float(circ_mv) * 10000,
                None if item.get("turnover_rate") is None else float(item.get("turnover_rate")),
                None if item.get("pe") is None else float(item.get("pe")),
                None if item.get("pb") is None else float(item.get("pb")),
                now,
                now,
            ))

        conn.executemany(
            """
            INSERT INTO financial_stock_basic_metrics (
              symbol, source, trade_date, total_mv_yuan, circ_mv_yuan,
              turnover_rate, pe, pb, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, source, trade_date) DO UPDATE SET
              total_mv_yuan = excluded.total_mv_yuan,
              circ_mv_yuan = excluded.circ_mv_yuan,
              turnover_rate = excluded.turnover_rate,
              pe = excluded.pe,
              pb = excluded.pb,
              updated_at = excluded.updated_at
            """,
            rows,
        )
        conn.commit()
        print(json.dumps({
            "success": True,
            "trade_date": format_date(trade_date),
            "inserted_or_updated": len(rows)
        }, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
