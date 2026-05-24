#!/usr/bin/env python3
import argparse
import json
import sqlite3
from datetime import datetime


def connect(db_path):
    conn = sqlite3.connect(db_path, timeout=120)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 120000")
    return conn


def ensure_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS financial_market_breadth_daily (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trade_date TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'tushare',
          market_universe TEXT NOT NULL DEFAULT 'stock_tushare',
          stock_count INTEGER DEFAULT 0,
          up_count INTEGER DEFAULT 0,
          down_count INTEGER DEFAULT 0,
          flat_count INTEGER DEFAULT 0,
          limit_up_count INTEGER DEFAULT 0,
          limit_down_count INTEGER DEFAULT 0,
          above_ma20_count INTEGER DEFAULT 0,
          above_ma60_count INTEGER DEFAULT 0,
          above_ma120_count INTEGER DEFAULT 0,
          amount_total REAL DEFAULT 0,
          amount_ratio_5_20 REAL DEFAULT 0,
          up_ratio REAL DEFAULT 0,
          down_ratio REAL DEFAULT 0,
          limit_up_ratio REAL DEFAULT 0,
          limit_down_ratio REAL DEFAULT 0,
          above_ma20_ratio REAL DEFAULT 0,
          above_ma60_ratio REAL DEFAULT 0,
          above_ma120_ratio REAL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(trade_date, source, market_universe)
        );

        CREATE INDEX IF NOT EXISTS idx_financial_market_breadth_date
        ON financial_market_breadth_daily(trade_date, source, market_universe);
        """
    )
    conn.commit()


def default_range(conn):
    row = conn.execute(
        """
        SELECT MIN(trade_date) AS min_date, MAX(trade_date) AS max_date
        FROM financial_daily_prices
        WHERE asset_type = 'stock'
          AND source = 'tushare'
          AND close IS NOT NULL
          AND close > 0
        """
    ).fetchone()
    return row["min_date"], row["max_date"]


def latest_trade_date_window(conn, end_date, days):
    if not days or days <= 0:
        return None
    rows = conn.execute(
        """
        SELECT DISTINCT trade_date
        FROM financial_daily_prices
        WHERE asset_type = 'stock'
          AND source = 'tushare'
          AND close IS NOT NULL
          AND close > 0
          AND trade_date <= ?
        ORDER BY trade_date DESC
        LIMIT ?
        """,
        (end_date, int(days)),
    ).fetchall()
    if not rows:
        return None
    ordered = sorted(row["trade_date"] for row in rows if row["trade_date"])
    return ordered[0] if ordered else None


def rebuild_market_breadth(conn, start_date, end_date):
    now = datetime.now().isoformat(timespec="seconds")
    conn.execute(
        """
        DELETE FROM financial_market_breadth_daily
        WHERE source = 'tushare'
          AND market_universe = 'stock_tushare'
          AND trade_date BETWEEN ? AND ?
        """,
        (start_date, end_date),
    )
    conn.commit()

    conn.execute(
        """
        INSERT INTO financial_market_breadth_daily (
          trade_date, source, market_universe, stock_count, up_count, down_count, flat_count,
          limit_up_count, limit_down_count, above_ma20_count, above_ma60_count, above_ma120_count,
          amount_total, amount_ratio_5_20, up_ratio, down_ratio, limit_up_ratio, limit_down_ratio,
          above_ma20_ratio, above_ma60_ratio, above_ma120_ratio, created_at, updated_at
        )
        WITH price_calc AS (
          SELECT
            p.symbol,
            p.trade_date,
            p.close,
            COALESCE(p.amount, 0) AS amount,
            LAG(p.close) OVER (
              PARTITION BY p.symbol
              ORDER BY p.trade_date
            ) AS prev_close,
            AVG(p.close) OVER (
              PARTITION BY p.symbol
              ORDER BY p.trade_date
              ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
            ) AS ma20,
            COUNT(p.close) OVER (
              PARTITION BY p.symbol
              ORDER BY p.trade_date
              ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
            ) AS ma20_count,
            AVG(p.close) OVER (
              PARTITION BY p.symbol
              ORDER BY p.trade_date
              ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
            ) AS ma60,
            COUNT(p.close) OVER (
              PARTITION BY p.symbol
              ORDER BY p.trade_date
              ROWS BETWEEN 59 PRECEDING AND CURRENT ROW
            ) AS ma60_count,
            AVG(p.close) OVER (
              PARTITION BY p.symbol
              ORDER BY p.trade_date
              ROWS BETWEEN 119 PRECEDING AND CURRENT ROW
            ) AS ma120,
            COUNT(p.close) OVER (
              PARTITION BY p.symbol
              ORDER BY p.trade_date
              ROWS BETWEEN 119 PRECEDING AND CURRENT ROW
            ) AS ma120_count
          FROM financial_daily_prices p
          WHERE p.asset_type = 'stock'
            AND p.source = 'tushare'
            AND p.close IS NOT NULL
            AND p.close > 0
            AND p.trade_date BETWEEN date(?, '-420 days') AND ?
        ),
        scored AS (
          SELECT
            pc.trade_date,
            pc.symbol,
            pc.close,
            pc.prev_close,
            pc.amount,
            pc.ma20,
            pc.ma20_count,
            pc.ma60,
            pc.ma60_count,
            pc.ma120,
            pc.ma120_count,
            lp.up_limit,
            lp.down_limit
          FROM price_calc pc
          LEFT JOIN financial_limit_prices lp
            ON lp.symbol = pc.symbol
           AND lp.source = 'tushare'
           AND lp.trade_date = pc.trade_date
        ),
        daily AS (
          SELECT
            trade_date,
            COUNT(*) AS stock_count,
            SUM(CASE WHEN prev_close IS NOT NULL AND close > prev_close THEN 1 ELSE 0 END) AS up_count,
            SUM(CASE WHEN prev_close IS NOT NULL AND close < prev_close THEN 1 ELSE 0 END) AS down_count,
            SUM(CASE WHEN prev_close IS NOT NULL AND close = prev_close THEN 1 ELSE 0 END) AS flat_count,
            SUM(CASE WHEN up_limit IS NOT NULL AND close >= up_limit * 0.999 THEN 1 ELSE 0 END) AS limit_up_count,
            SUM(CASE WHEN down_limit IS NOT NULL AND close <= down_limit * 1.001 THEN 1 ELSE 0 END) AS limit_down_count,
            SUM(CASE WHEN ma20_count >= 20 AND close >= ma20 THEN 1 ELSE 0 END) AS above_ma20_count,
            SUM(CASE WHEN ma60_count >= 60 AND close >= ma60 THEN 1 ELSE 0 END) AS above_ma60_count,
            SUM(CASE WHEN ma120_count >= 120 AND close >= ma120 THEN 1 ELSE 0 END) AS above_ma120_count,
            SUM(amount) AS amount_total
          FROM scored
          GROUP BY trade_date
        ),
        rolled AS (
          SELECT
            daily.*,
            AVG(amount_total) OVER (
              ORDER BY trade_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
            ) AS amount_avg5,
            AVG(amount_total) OVER (
              ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
            ) AS amount_avg20,
            COUNT(amount_total) OVER (
              ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
            ) AS amount_count20
          FROM daily
        )
        SELECT
          trade_date,
          'tushare',
          'stock_tushare',
          stock_count,
          up_count,
          down_count,
          flat_count,
          limit_up_count,
          limit_down_count,
          above_ma20_count,
          above_ma60_count,
          above_ma120_count,
          amount_total,
          CASE
            WHEN amount_count20 >= 20 AND amount_avg20 > 0 THEN amount_avg5 / amount_avg20 - 1
            ELSE 0
          END AS amount_ratio_5_20,
          CASE WHEN stock_count > 0 THEN CAST(up_count AS REAL) / stock_count ELSE 0 END,
          CASE WHEN stock_count > 0 THEN CAST(down_count AS REAL) / stock_count ELSE 0 END,
          CASE WHEN stock_count > 0 THEN CAST(limit_up_count AS REAL) / stock_count ELSE 0 END,
          CASE WHEN stock_count > 0 THEN CAST(limit_down_count AS REAL) / stock_count ELSE 0 END,
          CASE WHEN stock_count > 0 THEN CAST(above_ma20_count AS REAL) / stock_count ELSE 0 END,
          CASE WHEN stock_count > 0 THEN CAST(above_ma60_count AS REAL) / stock_count ELSE 0 END,
          CASE WHEN stock_count > 0 THEN CAST(above_ma120_count AS REAL) / stock_count ELSE 0 END,
          ?,
          ?
        FROM rolled
        WHERE trade_date BETWEEN ? AND ?
        ORDER BY trade_date ASC
        """,
        (start_date, end_date, now, now, start_date, end_date),
    )
    conn.commit()
    row = conn.execute(
        """
        SELECT COUNT(*) AS count, MIN(trade_date) AS min_date, MAX(trade_date) AS max_date
        FROM financial_market_breadth_daily
        WHERE source = 'tushare'
          AND market_universe = 'stock_tushare'
          AND trade_date BETWEEN ? AND ?
        """,
        (start_date, end_date),
    ).fetchone()
    return dict(row)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    parser.add_argument("--days", type=int)
    args = parser.parse_args()

    conn = connect(args.db)
    try:
        ensure_schema(conn)
        default_start, default_end = default_range(conn)
        end_date = args.end_date or default_end
        start_date = args.start_date or latest_trade_date_window(conn, end_date, args.days) or default_start
        result = rebuild_market_breadth(conn, start_date, end_date)
        print(json.dumps({"success": True, "data": result}, ensure_ascii=False))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
