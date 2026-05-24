#!/usr/bin/env python3
import argparse
import csv
import json
import math
import random
import sqlite3
from bisect import bisect_right
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
from lightgbm import LGBMClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_score, recall_score, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


EXPERIMENTS = {
    "elasticity-hardness": {
        "title": "elasticity_hardness",
        "asset_types": ["stock", "etf"],
        "forward_window": 20,
        "positive_threshold": 0.08,
        "max_drawdown_floor": -0.10,
        "where": "",
    },
    "crash-recovery": {
        "title": "crash_recovery",
        "asset_types": ["stock", "etf"],
        "forward_window": 20,
        "positive_threshold": 0.08,
        "max_drawdown_floor": -0.12,
        "where": "AND (COALESCE(t.ret5, 0) <= -0.04 OR COALESCE(t.ret20, 0) <= -0.08 OR COALESCE(t.range20, 0) >= 0.12)",
    },
    "signal-lifecycle": {
        "title": "signal_lifecycle",
        "asset_types": ["stock", "etf"],
        "forward_window": 20,
        "positive_threshold": 0.06,
        "max_drawdown_floor": -0.08,
        "where": "",
    },
    "double-stock": {
        "title": "double_stock",
        "asset_types": ["stock"],
        "forward_window": 120,
        "positive_threshold": 0.35,
        "max_drawdown_floor": -0.25,
        "where": "AND COALESCE(t.range20, 0) >= 0.05",
    },
    "capital-rotation": {
        "title": "capital_rotation",
        "asset_types": ["etf"],
        "forward_window": 20,
        "positive_threshold": 0.06,
        "max_drawdown_floor": -0.08,
        "where": "",
    },
}

TREND_CODES = [
    "BREAKOUT",
    "SLOW_GRIND_UP",
    "TREND_UP",
    "RECOVERY",
    "TREND_TRANSITION",
    "CRASH_DROP",
    "SLOW_BLEED",
    "SURGE",
    "UNKNOWN",
]

ETF_ROUTE_TYPES = [
    "broad_etf",
    "industry_etf",
    "commodity_etf",
    "cross_border_etf",
    "bond_cash_etf",
    "full_etf",
    "special_fund",
]

BASE_FEATURE_COLUMNS = [
    "asset_is_stock",
    "asset_is_etf",
    "ret5",
    "ret1",
    "ret3",
    "ret20",
    "ret60",
    "ret120",
    "ret250",
    "range20",
    "range5",
    "range10",
    "range60",
    "range120",
    "range250",
    "bias60",
    "cross60_10",
    "distance_ma20",
    "distance_ma60",
    "distance_ma120",
    "distance_ma250",
    "ma120_slope20",
    "ma250_slope60",
    "price_pos20",
    "price_pos60",
    "price_pos120",
    "price_pos250",
    "drawdown20",
    "drawdown60",
    "drawdown120",
    "days_since_20_high",
    "days_since_20_low",
    "up_days_5",
    "up_days_10",
    "down_days_5",
    "down_days_10",
    "consecutive_up_days",
    "consecutive_down_days",
    "max_daily_gain_5",
    "max_daily_drop_5",
    "max_daily_gain_20",
    "max_daily_drop_20",
    "close_above_ma20_days_5",
    "close_above_ma60_days_10",
    "ma20_reclaim_5",
    "ma60_reclaim_10",
    "down_amount_ratio_5_20",
    "up_amount_ratio_5_20",
    "down_up_amount_ratio_10",
    "today_gap_prev_close",
    "today_intraday_return",
    "today_upper_shadow_ratio",
    "today_lower_shadow_ratio",
    "today_body_ratio",
    "amount_available",
    "amount_ratio_5_20",
    "amount_ratio_20_60",
    "amount_ratio_current_20",
    "volume_ratio_5_20",
    "volume_ratio_20_60",
    "stock_turnover_rate",
    "stock_turnover_rate_f",
    "stock_volume_ratio_basic",
    "stock_total_mv_log",
    "stock_circ_mv_log",
    "stock_pe_ttm",
    "stock_pb",
    "moneyflow_net_amount_log",
    "moneyflow_elg_net_amount_log",
    "limit_up_5",
    "limit_down_5",
    "limit_down_today",
    "breadth_up_ratio",
    "breadth_down_ratio",
    "breadth_limit_up_ratio",
    "breadth_limit_down_ratio",
    "breadth_above_ma20_ratio",
    "breadth_above_ma60_ratio",
    "breadth_above_ma120_ratio",
    "breadth_amount_ratio_5_20",
    "industry_known",
    "industry_ret5",
    "industry_ret20",
    "industry_ret60",
    "industry_amount_ratio_5_20",
    "industry_ret20_rank",
    "industry_relative_ret5_hs300",
    "industry_relative_ret20_hs300",
    "industry_relative_ret60_hs300",
    "sector_known",
    "sector_ret5",
    "sector_ret20",
    "sector_ret60",
    "sector_amount_ratio_5_20",
    "sector_relative_ret20_hs300",
    "asset_vs_sector_ret5",
    "asset_vs_sector_ret20",
    "asset_vs_sector_ret60",
    "relative_ret20_hs300",
    "relative_ret60_hs300",
    "relative_ret120_hs300",
    "market_normal",
    "market_risk",
    "market_crash",
    "market_unknown",
]

FEATURE_COLUMNS = (
    BASE_FEATURE_COLUMNS
    + [f"etf_route_{route}" for route in ETF_ROUTE_TYPES]
    + ["etf_route_other"]
    + [f"trend_{code.lower()}" for code in TREND_CODES]
)


def now():
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def connect(db_path):
    conn = sqlite3.connect(db_path, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 60000")
    return conn


def ensure_training_tables(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS model_training_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          output_dir TEXT NOT NULL,
          current_item_key TEXT,
          message TEXT,
          source_row_count INTEGER DEFAULT 0,
          started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          finished_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS model_training_artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT NOT NULL,
          model_key TEXT NOT NULL,
          target TEXT,
          model_type TEXT,
          model_file TEXT,
          model_json_file TEXT,
          metrics_file TEXT,
          source_feature_db TEXT,
          run_id INTEGER,
          validation_auc REAL,
          test_auc REAL,
          sample_limits_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(domain, model_key)
        );
        CREATE TABLE IF NOT EXISTS model_training_feature_importance (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT NOT NULL,
          model_key TEXT NOT NULL,
          feature TEXT NOT NULL,
          importance REAL,
          raw_importance REAL,
          rank_order INTEGER,
          run_id INTEGER,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(domain, model_key, feature)
        );
        CREATE TABLE IF NOT EXISTS model_training_rule_candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT NOT NULL,
          source_key TEXT NOT NULL,
          rank_order INTEGER NOT NULL,
          title TEXT NOT NULL,
          payload_json TEXT,
          run_id INTEGER,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(domain, source_key, rank_order)
        );
        """
    )
    conn.commit()


def latest_price_date(conn, min_coverage_ratio=0.92):
    rows = conn.execute(
        """
        SELECT trade_date, COUNT(DISTINCT symbol) AS rows
        FROM financial_daily_prices
        WHERE source = 'tushare'
          AND asset_type IN ('stock', 'etf', 'index')
          AND close IS NOT NULL
          AND close > 0
        GROUP BY trade_date
        ORDER BY trade_date DESC
        LIMIT 12
        """
    ).fetchall()
    if not rows:
        return None

    for index, row in enumerate(rows):
        if index >= len(rows) - 1:
            return row["trade_date"]
        previous = rows[index + 1]
        previous_count = int(previous["rows"] or 0)
        current_count = int(row["rows"] or 0)
        min_expected = math.floor(previous_count * min_coverage_ratio) if previous_count > 0 else 0
        if min_expected <= 0 or current_count >= min_expected:
            return row["trade_date"]

    return rows[-1]["trade_date"]


def sample_evenly(rows, limit):
    if len(rows) <= limit:
        return rows
    selected = []
    step = len(rows) / limit
    for index in range(limit):
        selected.append(rows[int(index * step)])
    return selected


def load_candidates(conn, key, config, latest_date, max_candidates):
    placeholders = ",".join("?" for _ in config["asset_types"])
    holdout_days = config["forward_window"] * 2 + 10
    query = f"""
        WITH universe_unique AS (
          SELECT symbol, asset_type, source, MAX(name) AS name,
            CASE
              WHEN SUM(CASE WHEN universe_type = 'industry_etf' THEN 1 ELSE 0 END) > 0 THEN 'industry_etf'
              WHEN SUM(CASE WHEN universe_type = 'broad_etf' THEN 1 ELSE 0 END) > 0 THEN 'broad_etf'
              WHEN SUM(CASE WHEN universe_type = 'commodity_etf' THEN 1 ELSE 0 END) > 0 THEN 'commodity_etf'
              WHEN SUM(CASE WHEN universe_type = 'cross_border_etf' THEN 1 ELSE 0 END) > 0 THEN 'cross_border_etf'
              WHEN SUM(CASE WHEN universe_type = 'bond_cash_etf' THEN 1 ELSE 0 END) > 0 THEN 'bond_cash_etf'
              WHEN SUM(CASE WHEN universe_type = 'special_fund' THEN 1 ELSE 0 END) > 0 THEN 'special_fund'
              WHEN SUM(CASE WHEN universe_type = 'hs300_component' THEN 1 ELSE 0 END) > 0 THEN 'hs300_component'
              ELSE MIN(universe_type)
            END AS universe_type
          FROM financial_asset_universe
          GROUP BY symbol, asset_type, source
        ),
        trend_latest AS (
          SELECT t.*,
            ROW_NUMBER() OVER (
              PARTITION BY t.symbol, t.asset_type, t.source, t.trade_date
              ORDER BY t.rule_version DESC, t.id DESC
            ) AS rn
          FROM financial_trend_phase_results t
          WHERE t.asset_type IN ({placeholders})
            AND t.close IS NOT NULL
            AND t.close > 0
            AND t.trade_date <= date(?, '-' || ? || ' days')
            {config["where"]}
        )
        SELECT t.symbol, COALESCE(u.name, t.symbol) AS name, t.asset_type, t.source,
               t.trade_date, t.close, t.ma20, t.ma60, t.bias60, t.ret5, t.ret20,
               t.range20, t.cross60_10, t.trend_phase_code, u.universe_type
        FROM trend_latest t
        LEFT JOIN universe_unique u
          ON u.symbol = t.symbol AND u.asset_type = t.asset_type AND u.source = t.source
        WHERE t.rn = 1
        ORDER BY t.trade_date ASC, t.symbol ASC
    """
    rows = conn.execute(query, [*config["asset_types"], latest_date, holdout_days]).fetchall()
    return sample_evenly([dict(row) for row in rows], max_candidates)


def chunked(values, size):
    for start in range(0, len(values), size):
        yield values[start:start + size]


def load_price_lookup(conn, candidates):
    by_asset_source = {}
    for row in candidates:
        key = (row["asset_type"], row["source"])
        by_asset_source.setdefault(key, set()).add(row["symbol"])

    lookup = {}
    indexes = {}
    for (asset_type, source), symbols in by_asset_source.items():
        for chunk in chunked(sorted(symbols), 400):
            placeholders = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"""
                SELECT symbol, asset_type, source, trade_date, open, close, high, low, volume, amount
                FROM financial_daily_prices
                WHERE asset_type = ?
                  AND source = ?
                  AND symbol IN ({placeholders})
                  AND close IS NOT NULL
                  AND close > 0
                ORDER BY symbol ASC, trade_date ASC
                """,
                [asset_type, source, *chunk],
            ).fetchall()
            for item in rows:
                key = (item["symbol"], item["asset_type"], item["source"])
                lookup.setdefault(key, []).append(
                    {
                        "trade_date": item["trade_date"],
                        "open": float(item["open"] or item["close"]),
                        "close": float(item["close"]),
                        "high": float(item["high"] or item["close"]),
                        "low": float(item["low"] or item["close"]),
                        "volume": float(item["volume"] or 0),
                        "amount": float(item["amount"] or 0),
                    }
                )

    for key, prices in lookup.items():
        indexes[key] = {item["trade_date"]: index for index, item in enumerate(prices)}
    return lookup, indexes


def load_market_prices(conn):
    rows = conn.execute(
        """
        WITH ranked_prices AS (
          SELECT trade_date, close,
            ROW_NUMBER() OVER (
              PARTITION BY trade_date
              ORDER BY CASE source WHEN 'tushare' THEN 0 WHEN 'akshare' THEN 1 ELSE 2 END
            ) AS rn
          FROM financial_daily_prices
          WHERE symbol = '000300'
            AND close IS NOT NULL
            AND close > 0
        )
        SELECT trade_date, close
        FROM ranked_prices
        WHERE rn = 1
        ORDER BY trade_date ASC
        """
    ).fetchall()
    prices = [{"trade_date": row["trade_date"], "close": float(row["close"])} for row in rows]
    return prices, {item["trade_date"]: index for index, item in enumerate(prices)}


def table_exists(conn, table_name):
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def normalize_date(value):
    text = str(value or "").strip()
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    return text[:10]


def pick_industry_mapping(mappings, trade_date):
    date_key = normalize_date(trade_date)
    rows = mappings if isinstance(mappings, list) else [mappings]
    candidates = []
    for item in rows:
        if not item:
            continue
        in_date = normalize_date(item.get("in_date"))
        out_date = normalize_date(item.get("out_date"))
        if in_date and in_date > date_key:
            continue
        if out_date and out_date < date_key:
            continue
        candidates.append(item)
    if not candidates:
        return None
    candidates.sort(
        key=lambda item: (
            1 if str(item.get("is_new") or "Y").upper() == "Y" else 0,
            normalize_date(item.get("in_date")),
        ),
        reverse=True,
    )
    return candidates[0]


def existing_columns(conn, table_name):
    if not table_exists(conn, table_name):
        return set()
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()}


def select_available(conn, table_name, desired_columns, fallback_columns):
    columns = existing_columns(conn, table_name)
    selected = [column for column in desired_columns if column in columns]
    for column in fallback_columns:
        if column not in selected and column in columns:
            selected.append(column)
    return selected


def date_at_or_before(dates, trade_date):
    if not dates:
        return None
    index = bisect_right(dates, trade_date) - 1
    if index < 0:
        return None
    return dates[index]


def index_at_or_before(prices, trade_date):
    if not prices:
        return None
    dates = [item["trade_date"] for item in prices]
    index = bisect_right(dates, trade_date) - 1
    return index if index >= 0 else None


def build_supplemental_indexes(data):
    for bucket in ("basic", "moneyflow"):
        bucket_dates = {}
        for symbol, source, trade_date in data.get(bucket, {}).keys():
            bucket_dates.setdefault((symbol, source), []).append(trade_date)
        for key, dates in bucket_dates.items():
            bucket_dates[key] = sorted(set(dates))
        data[f"{bucket}_dates"] = bucket_dates

    data["market_breadth_dates"] = sorted(data.get("market_breadth", {}).keys())
    industry_dates = {}
    for code, prices in data.get("industry_prices", {}).items():
        industry_dates[code] = [item["trade_date"] for item in prices]
    data["industry_dates"] = industry_dates
    return data


def load_supplemental_lookup(conn, candidates):
    stock_symbols = sorted({row["symbol"] for row in candidates if row["asset_type"] == "stock"})
    data = {
        "basic": {},
        "moneyflow": {},
        "limit": {},
        "market_breadth": {},
        "basic_dates": {},
        "moneyflow_dates": {},
        "market_breadth_dates": [],
        "industry_map": {},
        "industry_prices": {},
        "industry_index": {},
        "industry_dates": {},
        "industry_ret20_rank": {},
    }
    if table_exists(conn, "financial_market_breadth_daily"):
        rows = conn.execute(
            """
            SELECT trade_date, up_ratio, down_ratio, limit_up_ratio, limit_down_ratio,
                   above_ma20_ratio, above_ma60_ratio, above_ma120_ratio,
                   amount_ratio_5_20
            FROM financial_market_breadth_daily
            WHERE source = 'tushare'
              AND market_universe = 'stock_tushare'
            """
        ).fetchall()
        for row in rows:
            item = dict(row)
            data["market_breadth"][item["trade_date"]] = item

    if not stock_symbols:
        return build_supplemental_indexes(data)

    for chunk in chunked(stock_symbols, 400):
        placeholders = ",".join("?" for _ in chunk)

        if table_exists(conn, "financial_stock_basic_metrics"):
            columns = select_available(
                conn,
                "financial_stock_basic_metrics",
                [
                    "symbol", "source", "trade_date", "total_mv_yuan", "circ_mv_yuan",
                    "turnover_rate", "turnover_rate_f", "volume_ratio", "pe", "pe_ttm", "pb"
                ],
                ["symbol", "source", "trade_date"],
            )
            if {"symbol", "source", "trade_date"}.issubset(set(columns)):
                rows = conn.execute(
                    f"""
                    SELECT {', '.join(columns)}
                    FROM financial_stock_basic_metrics
                    WHERE symbol IN ({placeholders})
                    """,
                    chunk,
                ).fetchall()
                for row in rows:
                    item = dict(row)
                    data["basic"][(item["symbol"], item.get("source") or "tushare", item["trade_date"])] = item

        if table_exists(conn, "financial_moneyflow"):
            rows = conn.execute(
                f"""
                SELECT symbol, source, trade_date, buy_elg_amount, sell_elg_amount,
                       net_mf_amount, net_mf_vol
                FROM financial_moneyflow
                WHERE symbol IN ({placeholders})
                """,
                chunk,
            ).fetchall()
            for row in rows:
                item = dict(row)
                data["moneyflow"][(item["symbol"], item.get("source") or "tushare", item["trade_date"])] = item

        if table_exists(conn, "financial_limit_events"):
            rows = conn.execute(
                f"""
                SELECT symbol, source, trade_date, limit_status, limit_type, pct_chg
                FROM financial_limit_events
                WHERE symbol IN ({placeholders})
                """,
                chunk,
            ).fetchall()
            for row in rows:
                item = dict(row)
                key = (item["symbol"], item.get("source") or "tushare", item["trade_date"])
                data["limit"].setdefault(key, []).append(item)

    if table_exists(conn, "financial_sw_industry_members"):
        rows = conn.execute(
            """
            SELECT symbol, name, l1_code, l1_name, l2_code, l2_name, l3_code, l3_name,
                   in_date, out_date, is_new
            FROM financial_sw_industry_members
            ORDER BY symbol ASC, COALESCE(in_date, '') DESC, id DESC
            """
        ).fetchall()
        for row in rows:
            item = dict(row)
            if item["symbol"] in stock_symbols:
                data["industry_map"].setdefault(item["symbol"], []).append(item)

    industry_codes = sorted({
        item.get("l2_code") or item.get("l1_code")
        for mappings in data["industry_map"].values()
        for item in mappings
        if item.get("l2_code") or item.get("l1_code")
    })
    if industry_codes and table_exists(conn, "financial_sw_industry_daily"):
        for chunk in chunked(industry_codes, 300):
            placeholders = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"""
                SELECT index_code, trade_date, close, amount
                FROM financial_sw_industry_daily
                WHERE index_code IN ({placeholders})
                  AND close IS NOT NULL
                  AND close > 0
                ORDER BY index_code ASC, trade_date ASC
                """,
                chunk,
            ).fetchall()
            for row in rows:
                item = {
                    "trade_date": row["trade_date"],
                    "close": float(row["close"]),
                    "amount": float(row["amount"] or 0),
                }
                data["industry_prices"].setdefault(row["index_code"], []).append(item)
        for code, prices in data["industry_prices"].items():
            data["industry_index"][code] = {item["trade_date"]: index for index, item in enumerate(prices)}
        returns_by_date = {}
        for code, prices in data["industry_prices"].items():
            for index in range(20, len(prices)):
                value = safe_ratio(prices[index]["close"], prices[index - 20]["close"])
                returns_by_date.setdefault(prices[index]["trade_date"], []).append((code, value))
        for trade_date, values in returns_by_date.items():
            if len(values) < 2:
                continue
            ordered = sorted(values, key=lambda item: item[1])
            denominator = len(ordered) - 1
            for rank, (code, _value) in enumerate(ordered):
                data["industry_ret20_rank"][(code, trade_date)] = rank / denominator

    return build_supplemental_indexes(data)


def avg_close(prices, end, days):
    if end + 1 < days:
        return None
    section = prices[end - days + 1:end + 1]
    return sum(item["close"] for item in section) / days


def safe_float(value):
    try:
        numeric = float(value)
    except Exception:
        return 0.0
    return numeric if math.isfinite(numeric) else 0.0


def safe_ratio(numerator, denominator):
    try:
        if denominator is None or float(denominator) == 0:
            return 0.0
        value = float(numerator) / float(denominator) - 1
        return value if math.isfinite(value) else 0.0
    except Exception:
        return 0.0


def signed_log(value):
    numeric = safe_float(value)
    if numeric == 0:
        return 0.0
    return math.copysign(math.log1p(abs(numeric)), numeric)


def return_over_days(prices, end, days):
    if end < days:
        return 0.0
    return safe_ratio(prices[end]["close"], prices[end - days]["close"])


def range_over_days(prices, end, days):
    if end + 1 < days:
        return 0.0
    section = prices[end - days + 1:end + 1]
    high = max(safe_float(item.get("high") or item.get("close")) for item in section)
    low = min(safe_float(item.get("low") or item.get("close")) for item in section)
    return safe_ratio(high, low)


def price_position(prices, end, days):
    if end + 1 < days:
        return 0.5
    section = prices[end - days + 1:end + 1]
    close = safe_float(prices[end]["close"])
    high = max(safe_float(item.get("high") or item.get("close")) for item in section)
    low = min(safe_float(item.get("low") or item.get("close")) for item in section)
    if high <= low:
        return 0.5
    return max(0.0, min(1.0, (close - low) / (high - low)))


def drawdown_from_high(prices, end, days):
    if end + 1 < days:
        return 0.0
    section = prices[end - days + 1:end + 1]
    high = max(safe_float(item.get("high") or item.get("close")) for item in section)
    return safe_ratio(prices[end]["close"], high)


def days_since_extreme(prices, end, days, field, mode):
    if end < 0:
        return 0.0
    start = max(0, end - days + 1)
    section = prices[start:end + 1]
    if not section:
        return 0.0
    values = [safe_float(item.get(field) or item.get("close")) for item in section]
    extreme = max(values) if mode == "max" else min(values)
    last_offset = 0
    for offset, value in enumerate(values):
        if value == extreme:
            last_offset = offset
    return float(len(values) - 1 - last_offset)


def daily_return_at(prices, index):
    if index <= 0:
        return 0.0
    return safe_ratio(prices[index]["close"], prices[index - 1]["close"])


def directional_days(prices, end, days, direction):
    if end <= 0:
        return 0.0
    start = max(1, end - days + 1)
    count = 0
    for index in range(start, end + 1):
        daily = daily_return_at(prices, index)
        if direction == "up" and daily > 0:
            count += 1
        if direction == "down" and daily < 0:
            count += 1
    return float(count)


def consecutive_direction_days(prices, end, direction):
    if end <= 0:
        return 0.0
    count = 0
    for index in range(end, 0, -1):
        daily = daily_return_at(prices, index)
        if direction == "up" and daily > 0:
            count += 1
            continue
        if direction == "down" and daily < 0:
            count += 1
            continue
        break
    return float(count)


def extreme_daily_return(prices, end, days, mode):
    if end <= 0:
        return 0.0
    start = max(1, end - days + 1)
    values = [daily_return_at(prices, index) for index in range(start, end + 1)]
    if not values:
        return 0.0
    return max(values) if mode == "max" else min(values)


def close_above_ma_days(prices, end, ma_days, lookback_days):
    start = max(0, end - lookback_days + 1)
    count = 0
    for index in range(start, end + 1):
        ma = avg_close(prices, index, ma_days)
        if ma and safe_float(prices[index]["close"]) >= ma:
            count += 1
    return float(count)


def ma_reclaim(prices, end, ma_days, lookback_days):
    ma_current = avg_close(prices, end, ma_days)
    if not ma_current or safe_float(prices[end]["close"]) < ma_current:
        return 0.0
    start = max(0, end - lookback_days + 1)
    for index in range(start, end):
        ma = avg_close(prices, index, ma_days)
        if ma and safe_float(prices[index]["close"]) < ma:
            return 1.0
    return 0.0


def avg_field_by_return_direction(prices, end, days, field, direction):
    if end <= 0:
        return None
    start = max(1, end - days + 1)
    values = []
    for index in range(start, end + 1):
        daily = daily_return_at(prices, index)
        if direction == "up" and daily > 0:
            values.append(safe_float(prices[index].get(field)))
        if direction == "down" and daily < 0:
            values.append(safe_float(prices[index].get(field)))
    values = [value for value in values if value > 0]
    if not values:
        return None
    return sum(values) / len(values)


def today_candle_features(prices, end):
    item = prices[end]
    previous_close = safe_float(prices[end - 1]["close"]) if end > 0 else safe_float(item.get("open") or item.get("close"))
    open_price = safe_float(item.get("open") or item.get("close"))
    close = safe_float(item.get("close"))
    high = max(safe_float(item.get("high") or close), open_price, close)
    low = min(safe_float(item.get("low") or close), open_price, close)
    span = high - low
    if span <= 0:
        span = max(abs(close), 1.0)
    return {
        "gap_prev_close": safe_ratio(open_price, previous_close),
        "intraday_return": safe_ratio(close, open_price),
        "upper_shadow_ratio": max(0.0, high - max(open_price, close)) / span,
        "lower_shadow_ratio": max(0.0, min(open_price, close) - low) / span,
        "body_ratio": abs(close - open_price) / span,
    }


def ma_slope(prices, end, days, lag):
    if end < lag:
        return 0.0
    current = avg_close(prices, end, days)
    previous = avg_close(prices, end - lag, days)
    return safe_ratio(current, previous)


def avg_positive_field(prices, end, days, field):
    if end < 0:
        return None
    start = max(0, end - days + 1)
    values = [safe_float(item.get(field)) for item in prices[start:end + 1]]
    values = [value for value in values if value > 0]
    if not values:
        return None
    return sum(values) / len(values)


def field_ratio(prices, end, short_days, long_days, field):
    short_avg = avg_positive_field(prices, end, short_days, field)
    long_avg = avg_positive_field(prices, end, long_days, field)
    return safe_ratio(short_avg, long_avg)


def market_return_for_date(market_prices, market_index, trade_date, days, cache):
    cache_key = (trade_date, days)
    if cache_key in cache:
        return cache[cache_key]
    index = market_index.get(trade_date)
    if index is None:
        index = index_at_or_before(market_prices, trade_date)
    if index is None or index < days:
        cache[cache_key] = 0.0
        return 0.0
    value = safe_ratio(market_prices[index]["close"], market_prices[index - days]["close"])
    cache[cache_key] = value
    return value


def supplemental_for_date(supplemental, bucket, row, trade_date):
    source = row.get("source") or "tushare"
    sources = [source]
    if source != "tushare":
        sources.append("tushare")
    for item_source in sources:
        key = (row["symbol"], item_source)
        asof_date = date_at_or_before(
            supplemental.get(f"{bucket}_dates", {}).get(key, []),
            trade_date,
        )
        if not asof_date:
            continue
        item = supplemental.get(bucket, {}).get((row["symbol"], item_source, asof_date))
        if item:
            return item
    return {}


def is_limit_down_event(item):
    status = f"{item.get('limit_status') or ''} {item.get('limit_type') or ''}".upper()
    pct = safe_float(item.get("pct_chg"))
    return "D" in status or "跌停" in status or (pct is not None and pct <= -9.5)


def is_limit_up_event(item):
    status = f"{item.get('limit_status') or ''} {item.get('limit_type') or ''}".upper()
    pct = safe_float(item.get("pct_chg"))
    return "U" in status or "涨停" in status or (pct is not None and pct >= 9.5)


def count_limit_events(supplemental, row, price_window, predicate):
    count = 0
    source = row.get("source") or "tushare"
    for item in price_window:
        events = (
            supplemental.get("limit", {}).get((row["symbol"], source, item["trade_date"]))
            or supplemental.get("limit", {}).get((row["symbol"], "tushare", item["trade_date"]))
            or []
        )
        if any(predicate(event) for event in events):
            count += 1
    return count


def industry_features_for_date(supplemental, row, trade_date):
    mapping = pick_industry_mapping(
        supplemental.get("industry_map", {}).get(row["symbol"]),
        trade_date,
    )
    if not mapping:
        return {
            "known": 0.0,
            "ret5": 0.0,
            "ret20": 0.0,
            "ret60": 0.0,
            "amount_ratio_5_20": 0.0,
            "ret20_rank": 0.0,
        }
    code = mapping.get("l2_code") or mapping.get("l1_code")
    prices = supplemental.get("industry_prices", {}).get(code)
    industry_trade_date = date_at_or_before(
        supplemental.get("industry_dates", {}).get(code, []),
        trade_date,
    )
    index = supplemental.get("industry_index", {}).get(code, {}).get(industry_trade_date)
    if not prices or index is None:
        return {
            "known": 1.0,
            "ret5": 0.0,
            "ret20": 0.0,
            "ret60": 0.0,
            "amount_ratio_5_20": 0.0,
            "ret20_rank": 0.0,
        }
    return {
        "known": 1.0,
        "ret5": return_over_days(prices, index, 5),
        "ret20": return_over_days(prices, index, 20),
        "ret60": return_over_days(prices, index, 60),
        "amount_ratio_5_20": field_ratio(prices, index, 5, 20, "amount"),
        "ret20_rank": safe_float(supplemental.get("industry_ret20_rank", {}).get((code, industry_trade_date))),
    }


def market_breadth_for_date(supplemental, trade_date):
    asof_date = date_at_or_before(supplemental.get("market_breadth_dates", []), trade_date)
    item = supplemental.get("market_breadth", {}).get(asof_date) or {}
    return {
        "breadth_up_ratio": safe_float(item.get("up_ratio")),
        "breadth_down_ratio": safe_float(item.get("down_ratio")),
        "breadth_limit_up_ratio": safe_float(item.get("limit_up_ratio")),
        "breadth_limit_down_ratio": safe_float(item.get("limit_down_ratio")),
        "breadth_above_ma20_ratio": safe_float(item.get("above_ma20_ratio")),
        "breadth_above_ma60_ratio": safe_float(item.get("above_ma60_ratio")),
        "breadth_above_ma120_ratio": safe_float(item.get("above_ma120_ratio")),
        "breadth_amount_ratio_5_20": safe_float(item.get("amount_ratio_5_20")),
    }


def market_regime_for_date(market_prices, market_index, trade_date, cache):
    if trade_date in cache:
        return cache[trade_date]
    index = market_index.get(trade_date)
    if index is None:
        index = index_at_or_before(market_prices, trade_date)
    if index is None or index < 120:
        cache[trade_date] = "UNKNOWN"
        return "UNKNOWN"

    close = market_prices[index]["close"]
    ma60 = avg_close(market_prices, index, 60)
    ma60_prev = avg_close(market_prices, index - 1, 60)
    if not ma60 or not ma60_prev:
        cache[trade_date] = "UNKNOWN"
        return "UNKNOWN"

    close_20 = market_prices[index - 20]["close"] if index >= 20 else None
    close_60 = market_prices[index - 60]["close"] if index >= 60 else None
    close_120 = market_prices[index - 120]["close"] if index >= 120 else None
    drawdown20 = close / close_20 - 1 if close_20 else 0
    drawdown60 = close / close_60 - 1 if close_60 else 0
    drawdown120 = close / close_120 - 1 if close_120 else 0
    low60 = min(item["close"] for item in market_prices[index - 59:index + 1])
    low120 = min(item["close"] for item in market_prices[index - 119:index + 1])
    distance_ma60 = close / ma60 - 1

    below_ma60_days = 0
    above_ma60_days = 0
    for cursor in range(index, 58, -1):
        ma = avg_close(market_prices, cursor, 60)
        if not ma:
            break
        if market_prices[cursor]["close"] < ma:
            below_ma60_days += 1
        else:
            break
    for cursor in range(index, 58, -1):
        ma = avg_close(market_prices, cursor, 60)
        if not ma:
            break
        if market_prices[cursor]["close"] > ma:
            above_ma60_days += 1
        else:
            break

    if drawdown60 <= -0.20 or drawdown120 <= -0.25 or distance_ma60 <= -0.10:
        regime = "CRASH"
    elif (close < ma60 and ma60 < ma60_prev and drawdown20 <= -0.10) or close < low120 or drawdown60 <= -0.15:
        regime = "CRASH"
    elif (close < ma60 and ma60 < ma60_prev) or close < low60 or drawdown20 <= -0.08 or below_ma60_days >= 3:
        regime = "CRASH"
    elif (close < ma60 and ma60 >= ma60_prev) or (drawdown20 <= -0.05 and drawdown20 > -0.08):
        regime = "RISK"
    elif close > ma60 and ma60 >= ma60_prev and above_ma60_days >= 5 and drawdown120 > -0.08:
        regime = "NORMAL"
    elif close > ma60 and ma60 >= ma60_prev and drawdown20 > -0.08 and drawdown60 > -0.15 and drawdown120 > -0.08:
        regime = "NORMAL"
    else:
        regime = "RISK"

    cache[trade_date] = regime
    return regime


def max_forward_return(base_close, future):
    return max(item["close"] / base_close - 1 for item in future)


def max_forward_drawdown(base_close, future):
    peak = base_close
    worst = 0.0
    for item in future:
        peak = max(peak, item["close"])
        worst = min(worst, item["close"] / peak - 1)
    return worst


def row_features(row, prices, index, market_regime, market_returns, supplemental):
    trend = str(row.get("trend_phase_code") or "UNKNOWN").upper()
    universe_type = str(row.get("universe_type") or "").lower()
    ret1 = return_over_days(prices, index, 1)
    ret3 = return_over_days(prices, index, 3)
    ret5 = return_over_days(prices, index, 5) if index >= 5 else safe_float(row.get("ret5") or 0)
    ret20 = return_over_days(prices, index, 20) if index >= 20 else safe_float(row.get("ret20") or 0)
    ret60 = return_over_days(prices, index, 60)
    ret120 = return_over_days(prices, index, 120)
    ret250 = return_over_days(prices, index, 250)
    amount_current = safe_float(prices[index].get("amount"))
    amount_avg20 = avg_positive_field(prices, index, 20, "amount")
    amount_ratio_5_20 = field_ratio(prices, index, 5, 20, "amount")
    amount_ratio_20_60 = field_ratio(prices, index, 20, 60, "amount")
    amount_ratio_current_20 = safe_ratio(amount_current, amount_avg20)
    down_amount_5 = avg_field_by_return_direction(prices, index, 5, "amount", "down")
    up_amount_5 = avg_field_by_return_direction(prices, index, 5, "amount", "up")
    down_amount_10 = avg_field_by_return_direction(prices, index, 10, "amount", "down")
    up_amount_10 = avg_field_by_return_direction(prices, index, 10, "amount", "up")
    volume_ratio_5_20 = field_ratio(prices, index, 5, 20, "volume")
    volume_ratio_20_60 = field_ratio(prices, index, 20, 60, "volume")
    candle = today_candle_features(prices, index)
    trade_date = row["trade_date"]
    basic = supplemental_for_date(supplemental, "basic", row, trade_date)
    flow = supplemental_for_date(supplemental, "moneyflow", row, trade_date)
    limit_window = prices[max(0, index - 4):index + 1]
    limit_down_5 = count_limit_events(supplemental, row, limit_window, is_limit_down_event)
    limit_up_5 = count_limit_events(supplemental, row, limit_window, is_limit_up_event)
    today_events = supplemental.get("limit", {}).get((row["symbol"], row.get("source") or "tushare", trade_date), [])
    if not today_events:
        today_events = supplemental.get("limit", {}).get((row["symbol"], "tushare", trade_date), [])
    breadth = market_breadth_for_date(supplemental, trade_date)
    industry = industry_features_for_date(supplemental, row, trade_date)
    if industry["known"] > 0:
        sector_known = 1.0
        sector_ret5 = industry["ret5"]
        sector_ret20 = industry["ret20"]
        sector_ret60 = industry["ret60"]
        sector_amount_ratio_5_20 = industry["amount_ratio_5_20"]
    elif row["asset_type"] == "etf" and universe_type == "industry_etf":
        sector_known = 1.0
        sector_ret5 = ret5
        sector_ret20 = ret20
        sector_ret60 = ret60
        sector_amount_ratio_5_20 = amount_ratio_5_20
    else:
        sector_known = 0.0
        sector_ret5 = 0.0
        sector_ret20 = 0.0
        sector_ret60 = 0.0
        sector_amount_ratio_5_20 = 0.0
    asset_vs_sector_ret5 = ret5 - sector_ret5 if sector_known > 0 else 0.0
    asset_vs_sector_ret20 = ret20 - sector_ret20 if sector_known > 0 else 0.0
    asset_vs_sector_ret60 = ret60 - sector_ret60 if sector_known > 0 else 0.0
    elg_net_amount = safe_float(flow.get("buy_elg_amount")) - safe_float(flow.get("sell_elg_amount"))

    features = {
        "asset_is_stock": 1.0 if row["asset_type"] == "stock" else 0.0,
        "asset_is_etf": 1.0 if row["asset_type"] == "etf" else 0.0,
        "ret1": ret1,
        "ret3": ret3,
        "ret5": ret5,
        "ret20": ret20,
        "ret60": ret60,
        "ret120": ret120,
        "ret250": ret250,
        "range5": range_over_days(prices, index, 5),
        "range10": range_over_days(prices, index, 10),
        "range20": range_over_days(prices, index, 20) or safe_float(row.get("range20") or 0),
        "range60": range_over_days(prices, index, 60),
        "range120": range_over_days(prices, index, 120),
        "range250": range_over_days(prices, index, 250),
        "bias60": safe_float(row.get("bias60") or 0),
        "cross60_10": safe_float(row.get("cross60_10") or 0),
        "distance_ma20": safe_ratio(row.get("close"), row.get("ma20")),
        "distance_ma60": safe_ratio(row.get("close"), row.get("ma60")),
        "distance_ma120": safe_ratio(row.get("close"), avg_close(prices, index, 120)),
        "distance_ma250": safe_ratio(row.get("close"), avg_close(prices, index, 250)),
        "ma120_slope20": ma_slope(prices, index, 120, 20),
        "ma250_slope60": ma_slope(prices, index, 250, 60),
        "price_pos20": price_position(prices, index, 20),
        "price_pos60": price_position(prices, index, 60),
        "price_pos120": price_position(prices, index, 120),
        "price_pos250": price_position(prices, index, 250),
        "drawdown20": drawdown_from_high(prices, index, 20),
        "drawdown60": drawdown_from_high(prices, index, 60),
        "drawdown120": drawdown_from_high(prices, index, 120),
        "days_since_20_high": days_since_extreme(prices, index, 20, "high", "max"),
        "days_since_20_low": days_since_extreme(prices, index, 20, "low", "min"),
        "up_days_5": directional_days(prices, index, 5, "up"),
        "up_days_10": directional_days(prices, index, 10, "up"),
        "down_days_5": directional_days(prices, index, 5, "down"),
        "down_days_10": directional_days(prices, index, 10, "down"),
        "consecutive_up_days": consecutive_direction_days(prices, index, "up"),
        "consecutive_down_days": consecutive_direction_days(prices, index, "down"),
        "max_daily_gain_5": extreme_daily_return(prices, index, 5, "max"),
        "max_daily_drop_5": extreme_daily_return(prices, index, 5, "min"),
        "max_daily_gain_20": extreme_daily_return(prices, index, 20, "max"),
        "max_daily_drop_20": extreme_daily_return(prices, index, 20, "min"),
        "close_above_ma20_days_5": close_above_ma_days(prices, index, 20, 5),
        "close_above_ma60_days_10": close_above_ma_days(prices, index, 60, 10),
        "ma20_reclaim_5": ma_reclaim(prices, index, 20, 5),
        "ma60_reclaim_10": ma_reclaim(prices, index, 60, 10),
        "down_amount_ratio_5_20": safe_ratio(down_amount_5, amount_avg20),
        "up_amount_ratio_5_20": safe_ratio(up_amount_5, amount_avg20),
        "down_up_amount_ratio_10": safe_ratio(down_amount_10, up_amount_10),
        "today_gap_prev_close": candle["gap_prev_close"],
        "today_intraday_return": candle["intraday_return"],
        "today_upper_shadow_ratio": candle["upper_shadow_ratio"],
        "today_lower_shadow_ratio": candle["lower_shadow_ratio"],
        "today_body_ratio": candle["body_ratio"],
        "amount_available": 1.0 if amount_current > 0 or amount_avg20 else 0.0,
        "amount_ratio_5_20": amount_ratio_5_20,
        "amount_ratio_20_60": amount_ratio_20_60,
        "amount_ratio_current_20": amount_ratio_current_20,
        "volume_ratio_5_20": volume_ratio_5_20,
        "volume_ratio_20_60": volume_ratio_20_60,
        "stock_turnover_rate": safe_float(basic.get("turnover_rate")),
        "stock_turnover_rate_f": safe_float(basic.get("turnover_rate_f")),
        "stock_volume_ratio_basic": safe_float(basic.get("volume_ratio")),
        "stock_total_mv_log": math.log1p(max(0.0, safe_float(basic.get("total_mv_yuan")))),
        "stock_circ_mv_log": math.log1p(max(0.0, safe_float(basic.get("circ_mv_yuan")))),
        "stock_pe_ttm": safe_float(basic.get("pe_ttm")),
        "stock_pb": safe_float(basic.get("pb")),
        "moneyflow_net_amount_log": signed_log(flow.get("net_mf_amount")),
        "moneyflow_elg_net_amount_log": signed_log(elg_net_amount),
        "limit_up_5": float(limit_up_5),
        "limit_down_5": float(limit_down_5),
        "limit_down_today": 1.0 if any(is_limit_down_event(event) for event in today_events) else 0.0,
        **breadth,
        "industry_known": industry["known"],
        "industry_ret5": industry["ret5"],
        "industry_ret20": industry["ret20"],
        "industry_ret60": industry["ret60"],
        "industry_amount_ratio_5_20": industry["amount_ratio_5_20"],
        "industry_ret20_rank": industry["ret20_rank"],
        "industry_relative_ret5_hs300": industry["ret5"] - market_returns.get(5, 0.0),
        "industry_relative_ret20_hs300": industry["ret20"] - market_returns.get(20, 0.0),
        "industry_relative_ret60_hs300": industry["ret60"] - market_returns.get(60, 0.0),
        "sector_known": sector_known,
        "sector_ret5": sector_ret5,
        "sector_ret20": sector_ret20,
        "sector_ret60": sector_ret60,
        "sector_amount_ratio_5_20": sector_amount_ratio_5_20,
        "sector_relative_ret20_hs300": sector_ret20 - market_returns.get(20, 0.0),
        "asset_vs_sector_ret5": asset_vs_sector_ret5,
        "asset_vs_sector_ret20": asset_vs_sector_ret20,
        "asset_vs_sector_ret60": asset_vs_sector_ret60,
        "relative_ret20_hs300": ret20 - market_returns.get(20, 0.0),
        "relative_ret60_hs300": ret60 - market_returns.get(60, 0.0),
        "relative_ret120_hs300": ret120 - market_returns.get(120, 0.0),
        "market_normal": 1.0 if market_regime == "NORMAL" else 0.0,
        "market_risk": 1.0 if market_regime == "RISK" else 0.0,
        "market_crash": 1.0 if market_regime == "CRASH" else 0.0,
        "market_unknown": 1.0 if market_regime == "UNKNOWN" else 0.0,
    }
    for route in ETF_ROUTE_TYPES:
        features[f"etf_route_{route}"] = 1.0 if row["asset_type"] == "etf" and universe_type == route else 0.0
    features["etf_route_other"] = (
        1.0 if row["asset_type"] == "etf" and universe_type not in ETF_ROUTE_TYPES else 0.0
    )
    for code in TREND_CODES:
        features[f"trend_{code.lower()}"] = 1.0 if trend == code else 0.0
    return features


def build_dataset(conn, key, config, output_dir, max_candidates, max_samples):
    latest_date = latest_price_date(conn)
    candidates = load_candidates(conn, key, config, latest_date, max_candidates)
    price_lookup, price_indexes = load_price_lookup(conn, candidates)
    market_prices, market_index = load_market_prices(conn)
    supplemental = load_supplemental_lookup(conn, candidates)
    market_cache = {}
    market_return_cache = {}

    rows = []
    min_future_rows = min(20, config["forward_window"])
    for row in candidates:
        price_key = (row["symbol"], row["asset_type"], row["source"])
        prices = price_lookup.get(price_key)
        index = price_indexes.get(price_key, {}).get(row["trade_date"])
        if prices is None or index is None:
            continue
        future = prices[index + 1:index + 1 + config["forward_window"]]
        if len(future) < min_future_rows:
            continue

        base_close = float(row["close"])
        forward_return = future[-1]["close"] / base_close - 1
        forward_return_5d = future[min(4, len(future) - 1)]["close"] / base_close - 1
        forward_return_10d = future[min(9, len(future) - 1)]["close"] / base_close - 1
        forward_return_20d = future[min(19, len(future) - 1)]["close"] / base_close - 1
        max_ret = max_forward_return(base_close, future)
        max_dd = max_forward_drawdown(base_close, future)
        target = 1 if max_ret >= config["positive_threshold"] and max_dd >= config["max_drawdown_floor"] else 0
        market_regime = market_regime_for_date(market_prices, market_index, row["trade_date"], market_cache)
        market_returns = {
            days: market_return_for_date(market_prices, market_index, row["trade_date"], days, market_return_cache)
            for days in (5, 20, 60, 120)
        }
        features = row_features(row, prices, index, market_regime, market_returns, supplemental)
        rows.append({
            "symbol": row["symbol"],
            "name": row["name"],
            "asset_type": row["asset_type"],
            "source": row["source"],
            "universe_type": row.get("universe_type") or "",
            "trade_date": row["trade_date"],
            "close": base_close,
            "market_regime": market_regime,
            "trend_phase_code": row.get("trend_phase_code") or "UNKNOWN",
            "target": target,
            "forward_return_window": forward_return,
            "forward_return_5d": forward_return_5d,
            "forward_return_10d": forward_return_10d,
            "forward_return_20d": forward_return_20d,
            "max_forward_return": max_ret,
            "max_drawdown": max_dd,
            **features,
        })

    if max_samples and len(rows) > max_samples:
        rows = sample_evenly(rows, max_samples)

    dataset_path = Path(output_dir) / "dataset.csv"
    dataset_path.parent.mkdir(parents=True, exist_ok=True)
    if rows:
        columns = list(rows[0].keys())
        with dataset_path.open("w", encoding="utf-8", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)

    return rows, str(dataset_path)


def split_dataset(rows):
    ordered = sorted(rows, key=lambda item: (item["trade_date"], item["symbol"]))
    total = len(ordered)
    train_end = int(total * 0.70)
    validation_end = int(total * 0.85)
    return ordered[:train_end], ordered[train_end:validation_end], ordered[validation_end:]


def matrix(rows):
    return np.array([[float(row[column]) for column in FEATURE_COLUMNS] for row in rows], dtype=float)


def labels(rows):
    return np.array([int(row["target"]) for row in rows], dtype=int)


def metric_payload(y_true, probabilities):
    if len(y_true) == 0:
        return {"samples": 0}
    predictions = (probabilities >= 0.5).astype(int)
    payload = {
        "samples": int(len(y_true)),
        "positive_rate": float(np.mean(y_true)) if len(y_true) else None,
        "accuracy": float(accuracy_score(y_true, predictions)),
        "precision": float(precision_score(y_true, predictions, zero_division=0)),
        "recall": float(recall_score(y_true, predictions, zero_division=0)),
    }
    try:
        payload["auc"] = float(roc_auc_score(y_true, probabilities)) if len(set(y_true.tolist())) > 1 else None
    except Exception:
        payload["auc"] = None
    return payload


def feature_importance(model_key, model):
    if model_key == "logistic_regression":
        classifier = model.named_steps["model"]
        values = np.abs(classifier.coef_[0])
    else:
        values = getattr(model, "feature_importances_", np.zeros(len(FEATURE_COLUMNS)))
    total = float(np.sum(values)) or 1.0
    ranked = []
    for feature, raw in sorted(zip(FEATURE_COLUMNS, values), key=lambda item: item[1], reverse=True):
        ranked.append({"feature": feature, "raw_importance": float(raw), "importance": float(raw) / total})
    return ranked


def make_model(model_key):
    if model_key == "logistic_regression":
        return Pipeline([
            ("scale", StandardScaler()),
            ("model", LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)),
        ])
    if model_key == "random_forest":
        return RandomForestClassifier(
            n_estimators=220,
            max_depth=8,
            min_samples_leaf=20,
            class_weight="balanced_subsample",
            random_state=42,
            n_jobs=-1,
        )
    if model_key == "lightgbm_model":
        return LGBMClassifier(
            n_estimators=260,
            learning_rate=0.035,
            max_depth=-1,
            num_leaves=24,
            min_child_samples=30,
            subsample=0.85,
            colsample_bytree=0.85,
            class_weight="balanced",
            random_state=42,
            verbosity=-1,
        )
    raise RuntimeError(f"unknown model key: {model_key}")


def train_models(rows, output_dir):
    train_rows, validation_rows, test_rows = split_dataset(rows)
    x_train, y_train = matrix(train_rows), labels(train_rows)
    x_validation, y_validation = matrix(validation_rows), labels(validation_rows)
    x_test, y_test = matrix(test_rows), labels(test_rows)

    if len(set(y_train.tolist())) < 2:
        raise RuntimeError("training split has only one class; need more positive/negative samples")

    models = {model_key: make_model(model_key) for model_key in (
        "logistic_regression",
        "random_forest",
        "lightgbm_model",
    )}

    result = {}
    for model_key, model in models.items():
        model.fit(x_train, y_train)
        validation_prob = model.predict_proba(x_validation)[:, 1]
        test_prob = model.predict_proba(x_test)[:, 1]
        metrics = {
            "model_key": model_key,
            "features": FEATURE_COLUMNS,
            "train": {"samples": len(train_rows), "positive_rate": float(np.mean(y_train))},
            "validation": metric_payload(y_validation, validation_prob),
            "test": metric_payload(y_test, test_prob),
            "feature_importance": feature_importance(model_key, model),
        }
        joblib_path = Path(output_dir) / f"{model_key}.joblib"
        metrics_path = Path(output_dir) / f"{model_key}_metrics.json"
        model_json_path = Path(output_dir) / f"{model_key}.json"
        joblib.dump(model, joblib_path)
        metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
        model_json_path.write_text(json.dumps({
            "model_key": model_key,
            "model_type": model.__class__.__name__,
            "features": FEATURE_COLUMNS,
            "created_at": now(),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        result[model_key] = {
            "model_file": str(joblib_path),
            "metrics_file": str(metrics_path),
            "model_json_file": str(model_json_path),
            "metrics": metrics,
        }
    return result


def rolling_year_validation(rows, model_key, years=(2025, 2026)):
    results = []
    for year in years:
        year_start = f"{year}-01-01"
        year_end = f"{year}-12-31"
        train_rows = [row for row in rows if row["trade_date"] < year_start]
        validation_rows = [row for row in rows if year_start <= row["trade_date"] <= year_end]
        payload = {
            "year": year,
            "model_key": model_key,
            "train_samples": len(train_rows),
            "validation_samples": len(validation_rows),
        }
        if len(train_rows) < 300 or len(validation_rows) < 50:
            payload["status"] = "skipped"
            payload["message"] = "样本不足"
            results.append(payload)
            continue
        if len(set(row["target"] for row in train_rows)) < 2 or len(set(row["target"] for row in validation_rows)) < 2:
            payload["status"] = "skipped"
            payload["message"] = "正负样本不足"
            results.append(payload)
            continue
        model = make_model(model_key)
        model.fit(matrix(train_rows), labels(train_rows))
        probabilities = model.predict_proba(matrix(validation_rows))[:, 1]
        payload.update(metric_payload(labels(validation_rows), probabilities))
        payload["status"] = "completed"
        results.append(payload)
    return results


def create_run(conn, domain, output_dir, source_count):
    timestamp = now()
    cursor = conn.execute(
        """
        INSERT INTO model_training_runs (
          domain, status, output_dir, current_item_key, message, source_row_count,
          started_at, created_at, updated_at
        )
        VALUES (?, 'running', ?, 'experiment_model_training', ?, ?, ?, ?, ?)
        """,
        (domain, output_dir, "experiment model training started", source_count, timestamp, timestamp, timestamp),
    )
    conn.commit()
    return cursor.lastrowid


def finish_run(conn, run_id, status, message):
    timestamp = now()
    conn.execute(
        """
        UPDATE model_training_runs
        SET status = ?, message = ?, finished_at = ?, updated_at = ?
        WHERE id = ?
        """,
        (status, message, timestamp, timestamp, run_id),
    )
    conn.commit()


def persist_models(conn, domain, run_id, output_dir, dataset_path, model_results, config, row_count):
    timestamp = now()
    best_model = None
    best_auc = -1.0
    for model_key, artifact in model_results.items():
        metrics = artifact["metrics"]
        validation_auc = metrics["validation"].get("auc")
        test_auc = metrics["test"].get("auc")
        score = test_auc if test_auc is not None else validation_auc
        if score is not None and score > best_auc:
            best_auc = score
            best_model = model_key
        conn.execute(
            """
            INSERT INTO model_training_artifacts (
              domain, model_key, target, model_type, model_file, model_json_file,
              metrics_file, source_feature_db, run_id, validation_auc, test_auc,
              sample_limits_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(domain, model_key) DO UPDATE SET
              target = excluded.target,
              model_type = excluded.model_type,
              model_file = excluded.model_file,
              model_json_file = excluded.model_json_file,
              metrics_file = excluded.metrics_file,
              source_feature_db = excluded.source_feature_db,
              run_id = excluded.run_id,
              validation_auc = excluded.validation_auc,
              test_auc = excluded.test_auc,
              sample_limits_json = excluded.sample_limits_json,
              updated_at = excluded.updated_at
            """,
            (
                domain,
                model_key,
                f"max_forward_return >= {config['positive_threshold']} and max_drawdown >= {config['max_drawdown_floor']}",
                model_key,
                artifact["model_file"],
                artifact["model_json_file"],
                artifact["metrics_file"],
                dataset_path,
                run_id,
                validation_auc,
                test_auc,
                json.dumps({"rows": row_count, "forward_window": config["forward_window"]}, ensure_ascii=False),
                timestamp,
                timestamp,
            ),
        )
        for rank, item in enumerate(metrics["feature_importance"][:20], start=1):
            conn.execute(
                """
                INSERT INTO model_training_feature_importance (
                  domain, model_key, feature, importance, raw_importance, rank_order, run_id, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(domain, model_key, feature) DO UPDATE SET
                  importance = excluded.importance,
                  raw_importance = excluded.raw_importance,
                  rank_order = excluded.rank_order,
                  run_id = excluded.run_id,
                  updated_at = excluded.updated_at
                """,
                (
                    domain,
                    model_key,
                    item["feature"],
                    item["importance"],
                    item["raw_importance"],
                    rank,
                    run_id,
                    timestamp,
                ),
            )
        for rank, item in enumerate(metrics["feature_importance"][:8], start=1):
            conn.execute(
                """
                INSERT INTO model_training_rule_candidates (
                  domain, source_key, rank_order, title, payload_json, run_id, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(domain, source_key, rank_order) DO UPDATE SET
                  title = excluded.title,
                  payload_json = excluded.payload_json,
                  run_id = excluded.run_id,
                  updated_at = excluded.updated_at
                """,
                (
                    domain,
                    f"{model_key}_importance",
                    rank,
                    f"{item['feature']} importance",
                    json.dumps(item, ensure_ascii=False),
                    run_id,
                    timestamp,
                ),
            )
    conn.commit()
    return best_model


def train_experiment(conn, key, output_root, max_candidates, max_samples):
    if key not in EXPERIMENTS:
        raise RuntimeError(f"unknown experiment: {key}")
    config = EXPERIMENTS[key]
    domain = f"experiment:{key}"
    run_name = datetime.utcnow().strftime("run-%Y%m%d-%H%M%S")
    output_dir = Path(output_root) / key / run_name
    output_dir.mkdir(parents=True, exist_ok=True)

    run_id = create_run(conn, domain, str(output_dir), 0)
    try:
        rows, dataset_path = build_dataset(conn, key, config, output_dir, max_candidates, max_samples)
        timestamp = now()
        conn.execute(
            """
            UPDATE model_training_runs
            SET source_row_count = ?, message = ?, updated_at = ?
            WHERE id = ?
            """,
            (len(rows), f"dataset built; samples={len(rows)}", timestamp, run_id),
        )
        conn.commit()
        if len(rows) < 300:
            raise RuntimeError(f"not enough samples: {len(rows)}")
        if len(set(row["target"] for row in rows)) < 2:
            raise RuntimeError("dataset has only one class")
        model_results = train_models(rows, output_dir)
        best_model = persist_models(conn, domain, run_id, str(output_dir), dataset_path, model_results, config, len(rows))
        rolling_validation = rolling_year_validation(rows, best_model)
        summary = {
            "experiment": key,
            "domain": domain,
            "run_id": run_id,
            "output_dir": str(output_dir),
            "dataset_path": dataset_path,
            "sample_count": len(rows),
            "positive_count": sum(row["target"] for row in rows),
            "positive_rate": sum(row["target"] for row in rows) / len(rows),
            "best_model": best_model,
            "models": {
                model_key: {
                    "validation_auc": artifact["metrics"]["validation"].get("auc"),
                    "test_auc": artifact["metrics"]["test"].get("auc"),
                    "test_accuracy": artifact["metrics"]["test"].get("accuracy"),
                }
                for model_key, artifact in model_results.items()
            },
            "rolling_validation": rolling_validation,
            "completed_at": now(),
        }
        (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        finish_run(conn, run_id, "completed", f"completed; best_model={best_model}; samples={len(rows)}")
        return summary
    except Exception as exc:
        finish_run(conn, run_id, "failed", str(exc))
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--experiment", default="all", choices=["all", *EXPERIMENTS.keys()])
    parser.add_argument("--output-root", default="/Volumes/7100/model-training/experiments")
    parser.add_argument("--max-candidates", type=int, default=40000)
    parser.add_argument("--max-samples", type=int, default=12000)
    args = parser.parse_args()

    random.seed(42)
    np.random.seed(42)
    conn = connect(args.db)
    ensure_training_tables(conn)
    keys = list(EXPERIMENTS.keys()) if args.experiment == "all" else [args.experiment]
    results = []
    try:
        for key in keys:
            results.append(train_experiment(conn, key, args.output_root, args.max_candidates, args.max_samples))
        print(json.dumps({"success": True, "data": results}, ensure_ascii=False))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
