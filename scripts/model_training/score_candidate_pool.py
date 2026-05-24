#!/usr/bin/env python3
import argparse
import json
import math
import sqlite3
from pathlib import Path

import joblib
import numpy as np

from predict import connect, latest_feature_row, model_features, pick_artifact


def latest_covered_trade_date(conn, domain, min_coverage_ratio=0.92):
    rows = conn.execute(
        """
        SELECT trade_date, COUNT(DISTINCT symbol) AS symbol_count
        FROM financial_daily_prices
        WHERE asset_type = ?
          AND close IS NOT NULL
          AND close > 0
          AND trade_date IS NOT NULL
        GROUP BY trade_date
        ORDER BY trade_date DESC
        LIMIT 12
        """,
        (domain,),
    ).fetchall()
    if not rows:
        return None

    for index, row in enumerate(rows):
        if index >= len(rows) - 1:
            return row["trade_date"]
        previous_count = int(rows[index + 1]["symbol_count"] or 0)
        current_count = int(row["symbol_count"] or 0)
        min_expected = math.floor(previous_count * min_coverage_ratio) if previous_count > 0 else 0
        if min_expected <= 0 or current_count >= min_expected:
            return row["trade_date"]

    return rows[-1]["trade_date"]


def feature_db_latest_trade_date(feature_db_path, domain):
    conn = connect(feature_db_path)
    try:
        row = conn.execute(
            """
            SELECT MAX(trade_date) AS latest_trade_date
            FROM financial_ml_features
            WHERE asset_type = ?
              AND trade_date IS NOT NULL
            """,
            (domain,),
        ).fetchone()
        return row["latest_trade_date"] if row else None
    finally:
        conn.close()


def stale_feature_reason(domain, latest_trade_date, as_of_trade_date):
    if not latest_trade_date:
        return f"{domain} 模型特征库没有可用交易日，请先重新生成训练特征。"
    return (
        "模型特征库滞后："
        f"{domain} 特征日 {latest_trade_date}，当前评分口径 {as_of_trade_date}；"
        "请先刷新训练特征/重新训练后再评分。"
    )


def sql_identifier(name):
    return '"' + str(name).replace('"', '""') + '"'


def table_columns(conn, pragma_name):
    return [row["name"] for row in conn.execute(f"PRAGMA {pragma_name}").fetchall()]


def ensure_candidate_feature_rows(db_path, feature_db_path, domain, symbols, as_of_trade_date):
    unique_symbols = sorted({symbol for symbol in symbols if symbol})
    if not unique_symbols or not as_of_trade_date:
        return {
            "attempted": False,
            "reason": "没有需要补齐特征的候选标的或评分交易日。",
            "insertedRows": 0,
        }

    conn = connect(db_path)
    attached = False
    try:
        conn.execute("PRAGMA temp_store = FILE")
        conn.execute("PRAGMA cache_size = -120000")
        conn.execute("ATTACH DATABASE ? AS feature_db", (str(feature_db_path),))
        attached = True
        conn.execute("DROP TABLE IF EXISTS temp_candidate_symbols")
        conn.execute("CREATE TEMP TABLE temp_candidate_symbols(symbol TEXT PRIMARY KEY)")
        conn.executemany(
            "INSERT OR IGNORE INTO temp_candidate_symbols(symbol) VALUES (?)",
            [(symbol,) for symbol in unique_symbols],
        )
        conn.execute("DROP TABLE IF EXISTS temp_candidate_ml_features")
        conn.execute(
            """
            CREATE TEMP TABLE temp_candidate_ml_features AS
            WITH base AS (
              SELECT
                p.symbol,
                p.name,
                p.market,
                p.asset_type,
                p.trade_date,
                p.open,
                p.high,
                p.low,
                p.close,
                p.volume,
                p.amount,
                p.close / NULLIF(LAG(p.close, 1) OVER symbol_window, 0) - 1.0 AS ret_1d,
                p.close / NULLIF(LAG(p.close, 5) OVER symbol_window, 0) - 1.0 AS ret_5d,
                p.close / NULLIF(LAG(p.close, 10) OVER symbol_window, 0) - 1.0 AS ret_10d,
                p.close / NULLIF(LAG(p.close, 20) OVER symbol_window, 0) - 1.0 AS ret_20d,
                p.close / NULLIF(LAG(p.close, 60) OVER symbol_window, 0) - 1.0 AS ret_60d,
                AVG(p.close) OVER ma5_window AS ma5,
                AVG(p.close) OVER ma10_window AS ma10,
                AVG(p.close) OVER ma20_window AS ma20,
                AVG(p.close) OVER ma60_window AS ma60,
                AVG(p.close) OVER ma120_window AS ma120,
                AVG(p.volume) OVER ma20_window AS volume_ma20,
                AVG(p.amount) OVER amount20_window AS amount_ma20,
                MIN(p.low) OVER ma60_window AS low_60,
                MAX(p.high) OVER ma60_window AS high_60,
                MIN(p.low) OVER ma120_window AS low_120,
                MAX(p.high) OVER ma120_window AS high_120,
                MIN(p.low) OVER ma20_window AS low_20,
                MAX(p.high) OVER ma20_window AS high_20
              FROM temp_candidate_symbols selected_symbols
              JOIN financial_daily_prices AS p INDEXED BY idx_financial_daily_prices_symbol_date
                ON p.symbol = selected_symbols.symbol
              WHERE p.asset_type = ?
                AND p.close IS NOT NULL
                AND p.close > 0
                AND p.trade_date IS NOT NULL
                AND p.trade_date BETWEEN date(?, '-420 days') AND ?
              WINDOW
                symbol_window AS (PARTITION BY p.symbol, p.asset_type ORDER BY p.trade_date),
                ma5_window AS (PARTITION BY p.symbol, p.asset_type ORDER BY p.trade_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW),
                ma10_window AS (PARTITION BY p.symbol, p.asset_type ORDER BY p.trade_date ROWS BETWEEN 9 PRECEDING AND CURRENT ROW),
                ma20_window AS (PARTITION BY p.symbol, p.asset_type ORDER BY p.trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
                ma60_window AS (PARTITION BY p.symbol, p.asset_type ORDER BY p.trade_date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW),
                ma120_window AS (PARTITION BY p.symbol, p.asset_type ORDER BY p.trade_date ROWS BETWEEN 119 PRECEDING AND CURRENT ROW),
                amount20_window AS (PARTITION BY p.symbol, p.asset_type ORDER BY p.trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)
            ),
            features AS (
              SELECT
                symbol,
                name,
                market,
                asset_type,
                trade_date,
                open,
                high,
                low,
                close,
                volume,
                amount,
                ret_1d,
                ret_5d,
                ret_10d,
                ret_20d,
                ret_60d,
                ma5,
                ma10,
                ma20,
                ma60,
                ma120,
                volume / NULLIF(volume_ma20, 0) AS volume_ratio_20,
                amount / NULLIF(amount_ma20, 0) AS amount_ratio_20,
                AVG(ret_1d) OVER vol20_window AS ret_20d_mean,
                AVG(ret_1d * ret_1d) OVER vol20_window AS ret_20d_sq_mean,
                AVG(ret_1d) OVER vol60_window AS ret_60d_mean,
                AVG(ret_1d * ret_1d) OVER vol60_window AS ret_60d_sq_mean,
                low_20,
                high_20,
                low_60,
                high_60,
                low_120,
                high_120,
                (low_60 + (high_60 - low_60) * 0.20) AS safety_lower,
                (low_60 + (high_60 - low_60) * 0.45) AS safety_upper,
                close / NULLIF(ma20, 0) - 1.0 AS distance_ma20,
                close / NULLIF(ma60, 0) - 1.0 AS distance_ma60,
                ma20 / NULLIF(LAG(ma20, 5) OVER feature_symbol_window, 0) - 1.0 AS ma20_slope_5d,
                ma60 / NULLIF(LAG(ma60, 20) OVER feature_symbol_window, 0) - 1.0 AS ma60_slope_20d,
                close / NULLIF(high_20, 0) - 1.0 AS pullback_from_20d_high,
                close / NULLIF(high_20, 0) >= 0.995 AS breakout_20d,
                low_20 / NULLIF(high_20, 0) - 1.0 AS drawdown_20d,
                low_60 / NULLIF(high_60, 0) - 1.0 AS drawdown_60d,
                CASE WHEN ret_1d >= 0.095 THEN 1 ELSE 0 END AS limit_up_like,
                CASE WHEN ret_1d <= -0.095 THEN 1 ELSE 0 END AS limit_down_like,
                CASE
                  WHEN high_60 > low_60 THEN (close - low_60) / NULLIF(high_60 - low_60, 0)
                  ELSE NULL
                END AS price_pos_60,
                CASE
                  WHEN high_120 > low_120 THEN (close - low_120) / NULLIF(high_120 - low_120, 0)
                  ELSE NULL
                END AS price_pos_120,
                CASE
                  WHEN high_60 > low_60 THEN (close - (low_60 + (high_60 - low_60) * 0.20)) / NULLIF((high_60 - low_60) * 0.25, 0)
                  ELSE NULL
                END AS safety_zone_pos,
                CASE
                  WHEN ma20 > ma60 AND close >= ma20 THEN 'uptrend'
                  WHEN ma20 < ma60 AND close <= ma20 THEN 'downtrend'
                  ELSE 'range'
                END AS trend_phase,
                (
                  CASE WHEN ma20 > ma60 THEN 25 ELSE 0 END +
                  CASE WHEN close >= ma20 THEN 20 ELSE 0 END +
                  CASE WHEN ret_20d > 0 THEN 15 ELSE 0 END +
                  CASE WHEN volume_ma20 IS NOT NULL AND volume <= volume_ma20 * 2 THEN 10 ELSE 0 END +
                  CASE WHEN high_60 > low_60 AND close BETWEEN (low_60 + (high_60 - low_60) * 0.20) AND (low_60 + (high_60 - low_60) * 0.45) THEN 30 ELSE 0 END
                ) AS structure_score
              FROM base
              WINDOW
                feature_symbol_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date),
                vol20_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
                vol60_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)
            ),
            feature_dates AS (
              SELECT DISTINCT trade_date
              FROM (
                SELECT
                  trade_date,
                  ROW_NUMBER() OVER (
                    PARTITION BY symbol, asset_type
                    ORDER BY trade_date DESC
                  ) AS latest_rank
                FROM features
                WHERE ma60 IS NOT NULL
                  AND trade_date <= ?
              )
              WHERE latest_rank = 1
            ),
            hs300_prices AS (
              SELECT trade_date, close, low, high
              FROM (
                SELECT
                  trade_date,
                  close,
                  low,
                  high,
                  ROW_NUMBER() OVER (
                    PARTITION BY trade_date
                    ORDER BY CASE source WHEN 'tushare' THEN 1 WHEN 'akshare' THEN 2 ELSE 9 END
                  ) AS source_rank
                FROM financial_daily_prices
                WHERE symbol = '000300'
                  AND asset_type = 'index'
                  AND close IS NOT NULL
                  AND close > 0
                  AND trade_date IS NOT NULL
                  AND trade_date BETWEEN date(?, '-420 days') AND ?
              )
              WHERE source_rank = 1
            ),
            hs300_base AS (
              SELECT
                trade_date,
                close,
                close / NULLIF(LAG(close, 20) OVER hs300_window, 0) - 1.0 AS hs300_ret_20d,
                close / NULLIF(LAG(close, 60) OVER hs300_window, 0) - 1.0 AS hs300_ret_60d,
                close / NULLIF(LAG(close, 120) OVER hs300_window, 0) - 1.0 AS hs300_ret_120d,
                close / NULLIF(AVG(close) OVER hs300_ma60_window, 0) - 1.0 AS hs300_distance_ma60,
                MIN(low) OVER hs300_ma60_window / NULLIF(MAX(high) OVER hs300_ma60_window, 0) - 1.0 AS hs300_drawdown_60d
              FROM hs300_prices
              WINDOW
                hs300_window AS (ORDER BY trade_date),
                hs300_ma60_window AS (ORDER BY trade_date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)
            ),
            market_table AS (
              SELECT
                trade_date,
                table_regime
              FROM (
                SELECT
                  trade_date,
                  CASE
                    WHEN market_regime LIKE 'NORMAL%' THEN 'NORMAL'
                    WHEN market_regime = 'RISK' THEN 'RISK'
                    WHEN market_regime IN ('CRASH_WARNING', 'DEEP_CRASH', 'CRASH') THEN 'CRASH'
                    ELSE 'UNKNOWN'
                  END AS table_regime,
                  ROW_NUMBER() OVER (
                    PARTITION BY trade_date
                    ORDER BY updated_at DESC, id DESC
                  ) AS regime_rank
                FROM financial_market_regime
                WHERE symbol = '000300'
                  AND trade_date BETWEEN date(?, '-420 days') AND ?
              )
              WHERE regime_rank = 1
            ),
            market_context AS (
              SELECT
                h.*,
                COALESCE(
                  m.table_regime,
                  CASE
                    WHEN COALESCE(h.hs300_drawdown_60d, 0) <= -0.15 OR COALESCE(h.hs300_ret_20d, 0) <= -0.12 THEN 'CRASH'
                    WHEN COALESCE(h.hs300_drawdown_60d, 0) <= -0.10 OR COALESCE(h.hs300_ret_20d, 0) <= -0.08 THEN 'RISK'
                    WHEN COALESCE(h.hs300_distance_ma60, 0) >= 0 AND COALESCE(h.hs300_ret_20d, 0) > -0.05 THEN 'NORMAL'
                    ELSE 'UNKNOWN'
                  END
                ) AS market_regime_key
              FROM hs300_base h
              LEFT JOIN market_table m
                ON m.trade_date = (
                  SELECT MAX(m2.trade_date)
                  FROM market_table m2
                  WHERE m2.trade_date <= h.trade_date
                )
            ),
            market_asof AS (
              SELECT
                fd.trade_date AS feature_trade_date,
                mc.*
              FROM feature_dates fd
              LEFT JOIN market_context mc
                ON mc.trade_date = (
                  SELECT MAX(mc2.trade_date)
                  FROM market_context mc2
                  WHERE mc2.trade_date <= fd.trade_date
                )
            ),
            breadth_context AS (
              SELECT *
              FROM financial_market_breadth_daily
              WHERE market_universe = 'stock_tushare'
                AND trade_date BETWEEN date(?, '-420 days') AND ?
            ),
            breadth_asof AS (
              SELECT
                fd.trade_date AS feature_trade_date,
                b.*
              FROM feature_dates fd
              LEFT JOIN breadth_context b
                ON b.trade_date = (
                  SELECT MAX(b2.trade_date)
                  FROM breadth_context b2
                  WHERE b2.trade_date <= fd.trade_date
                )
            ),
            industry_base AS (
              SELECT
                index_code,
                trade_date,
                close,
                amount,
                close / NULLIF(LAG(close, 5) OVER industry_window, 0) - 1.0 AS industry_ret_5d,
                close / NULLIF(LAG(close, 20) OVER industry_window, 0) - 1.0 AS industry_ret_20d,
                close / NULLIF(LAG(close, 60) OVER industry_window, 0) - 1.0 AS industry_ret_60d,
                amount / NULLIF(AVG(amount) OVER industry_amount20_window, 0) AS industry_amount_ratio_20
              FROM financial_sw_industry_daily
              WHERE close IS NOT NULL
                AND close > 0
                AND trade_date IS NOT NULL
                AND trade_date BETWEEN date(?, '-420 days') AND ?
              WINDOW
                industry_window AS (PARTITION BY index_code ORDER BY trade_date),
                industry_amount20_window AS (PARTITION BY index_code ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)
            ),
            industry_ranked AS (
              SELECT
                *,
                CASE
                  WHEN industry_count > 1 THEN 1.0 - ((industry_rank - 1.0) / NULLIF(industry_count - 1.0, 0))
                  ELSE 0.5
                END AS industry_ret20_rank
              FROM (
                SELECT
                  industry_base.*,
                  RANK() OVER (PARTITION BY trade_date ORDER BY industry_ret_20d DESC) AS industry_rank,
                  COUNT(*) OVER (PARTITION BY trade_date) AS industry_count
                FROM industry_base
              )
            ),
            industry_codes AS (
              SELECT DISTINCT index_code
              FROM industry_ranked
            ),
            industry_asof AS (
              SELECT
                fd.trade_date AS feature_trade_date,
                ir.*
              FROM feature_dates fd
              CROSS JOIN industry_codes codes
              LEFT JOIN industry_ranked ir
                ON ir.index_code = codes.index_code
               AND ir.trade_date = (
                 SELECT MAX(ir2.trade_date)
                 FROM industry_ranked ir2
                 WHERE ir2.index_code = codes.index_code
                   AND ir2.trade_date <= fd.trade_date
               )
              WHERE ir.index_code IS NOT NULL
            ),
            universe_ranked AS (
              SELECT
                symbol,
                asset_type,
                universe_type,
                ROW_NUMBER() OVER (
                  PARTITION BY symbol, asset_type
                  ORDER BY
                    CASE universe_type
                      WHEN 'industry_etf' THEN 1
                      WHEN 'broad_etf' THEN 2
                      WHEN 'cross_border_etf' THEN 3
                      WHEN 'bond_cash_etf' THEN 4
                      WHEN 'commodity_etf' THEN 5
                      WHEN 'stock_whitelist' THEN 6
                      WHEN 'hs300_component' THEN 7
                      WHEN 'full_etf' THEN 8
                      WHEN 'full_stock' THEN 9
                      ELSE 99
                    END
                ) AS route_rank
              FROM financial_asset_universe
              WHERE enabled = 1
            ),
            universe_context AS (
              SELECT symbol, asset_type, universe_type
              FROM universe_ranked
              WHERE route_rank = 1
            ),
            final_features AS (
              SELECT
                features.*,
                CASE
                  WHEN ret_20d_sq_mean IS NOT NULL AND ret_20d_mean IS NOT NULL
                  THEN sqrt(MAX(ret_20d_sq_mean - ret_20d_mean * ret_20d_mean, 0))
                  ELSE NULL
                END AS volatility_20,
                CASE
                  WHEN ret_60d_sq_mean IS NOT NULL AND ret_60d_mean IS NOT NULL
                  THEN sqrt(MAX(ret_60d_sq_mean - ret_60d_mean * ret_60d_mean, 0))
                  ELSE NULL
                END AS volatility_60,
                CASE
                  WHEN safety_zone_pos BETWEEN 0 AND 1 THEN 1
                  ELSE 0
                END AS in_safety_zone,
                COALESCE(market_asof.hs300_ret_20d, 0) AS hs300_ret_20d,
                COALESCE(market_asof.hs300_ret_60d, 0) AS hs300_ret_60d,
                COALESCE(market_asof.hs300_ret_120d, 0) AS hs300_ret_120d,
                COALESCE(market_asof.hs300_distance_ma60, 0) AS hs300_distance_ma60,
                COALESCE(market_asof.hs300_drawdown_60d, 0) AS hs300_drawdown_60d,
                COALESCE(features.ret_20d - market_asof.hs300_ret_20d, 0) AS relative_ret20_hs300,
                COALESCE(features.ret_60d - market_asof.hs300_ret_60d, 0) AS relative_ret60_hs300,
                COALESCE((features.close / NULLIF(LAG(features.close, 120) OVER feature_output_window, 0) - 1.0) - market_asof.hs300_ret_120d, 0) AS relative_ret120_hs300,
                COALESCE(market_asof.market_regime_key, 'UNKNOWN') AS market_regime,
                CASE WHEN market_asof.market_regime_key = 'NORMAL' THEN 1 ELSE 0 END AS market_normal,
                CASE WHEN market_asof.market_regime_key = 'RISK' THEN 1 ELSE 0 END AS market_risk,
                CASE WHEN market_asof.market_regime_key = 'CRASH' THEN 1 ELSE 0 END AS market_crash,
                CASE WHEN market_asof.market_regime_key IS NULL OR market_asof.market_regime_key = 'UNKNOWN' THEN 1 ELSE 0 END AS market_unknown,
                COALESCE(breadth_asof.up_ratio, 0) AS breadth_up_ratio,
                COALESCE(breadth_asof.down_ratio, 0) AS breadth_down_ratio,
                COALESCE(breadth_asof.limit_up_ratio, 0) AS breadth_limit_up_ratio,
                COALESCE(breadth_asof.limit_down_ratio, 0) AS breadth_limit_down_ratio,
                COALESCE(breadth_asof.above_ma20_ratio, 0) AS breadth_above_ma20_ratio,
                COALESCE(breadth_asof.above_ma60_ratio, 0) AS breadth_above_ma60_ratio,
                COALESCE(breadth_asof.above_ma120_ratio, 0) AS breadth_above_ma120_ratio,
                COALESCE(breadth_asof.amount_ratio_5_20, 0) AS breadth_amount_ratio_5_20,
                CASE WHEN industry_asof.index_code IS NOT NULL THEN 1 ELSE 0 END AS industry_known,
                COALESCE(industry_asof.industry_ret_5d, 0) AS industry_ret_5d,
                COALESCE(industry_asof.industry_ret_20d, 0) AS industry_ret_20d,
                COALESCE(industry_asof.industry_ret_60d, 0) AS industry_ret_60d,
                COALESCE(industry_asof.industry_amount_ratio_20, 0) AS industry_amount_ratio_20,
                COALESCE(industry_asof.industry_ret20_rank, 0) AS industry_ret20_rank,
                COALESCE(industry_asof.industry_ret_20d - market_asof.hs300_ret_20d, 0) AS industry_relative_ret20_hs300,
                COALESCE(features.ret_20d - industry_asof.industry_ret_20d, 0) AS asset_vs_industry_ret20,
                CASE WHEN features.asset_type = 'etf' AND universe_context.universe_type = 'broad_etf' THEN 1 ELSE 0 END AS etf_route_broad_etf,
                CASE WHEN features.asset_type = 'etf' AND universe_context.universe_type = 'industry_etf' THEN 1 ELSE 0 END AS etf_route_industry_etf,
                CASE WHEN features.asset_type = 'etf' AND universe_context.universe_type = 'cross_border_etf' THEN 1 ELSE 0 END AS etf_route_cross_border_etf,
                CASE WHEN features.asset_type = 'etf' AND universe_context.universe_type = 'bond_cash_etf' THEN 1 ELSE 0 END AS etf_route_bond_cash_etf,
                CASE WHEN features.asset_type = 'etf' AND universe_context.universe_type = 'commodity_etf' THEN 1 ELSE 0 END AS etf_route_commodity_etf,
                CASE
                  WHEN features.asset_type = 'etf'
                    AND COALESCE(universe_context.universe_type, 'other') NOT IN ('broad_etf', 'industry_etf', 'cross_border_etf', 'bond_cash_etf', 'commodity_etf')
                  THEN 1 ELSE 0
                END AS etf_route_other
              FROM features
              LEFT JOIN market_asof
                ON market_asof.feature_trade_date = features.trade_date
              LEFT JOIN breadth_asof
                ON breadth_asof.feature_trade_date = features.trade_date
              LEFT JOIN financial_sw_industry_members industry_member
                ON industry_member.symbol = features.symbol
               AND features.asset_type = 'stock'
               AND (
                 industry_member.in_date IS NULL
                 OR industry_member.in_date = ''
                 OR industry_member.in_date <= features.trade_date
               )
               AND (
                 industry_member.out_date IS NULL
                 OR industry_member.out_date = ''
                 OR industry_member.out_date >= features.trade_date
               )
              LEFT JOIN industry_asof
                ON industry_asof.index_code = industry_member.l1_code
               AND industry_asof.feature_trade_date = features.trade_date
              LEFT JOIN universe_context
                ON universe_context.symbol = features.symbol
               AND universe_context.asset_type = features.asset_type
              WHERE ma60 IS NOT NULL
              WINDOW
                feature_output_window AS (PARTITION BY features.symbol, features.asset_type ORDER BY features.trade_date)
            )
            SELECT *
            FROM (
              SELECT
                final_features.*,
                ROW_NUMBER() OVER (
                  PARTITION BY final_features.symbol, final_features.asset_type
                  ORDER BY final_features.trade_date DESC
                ) AS rn
              FROM final_features
              WHERE final_features.trade_date <= ?
            )
            WHERE rn = 1
            """,
            (
                domain,
                as_of_trade_date,
                as_of_trade_date,
                as_of_trade_date,
                as_of_trade_date,
                as_of_trade_date,
                as_of_trade_date,
                as_of_trade_date,
                as_of_trade_date,
                as_of_trade_date,
                as_of_trade_date,
                as_of_trade_date,
                as_of_trade_date,
            ),
        )

        candidate_row = conn.execute(
            """
            SELECT
              COUNT(*) AS count,
              MIN(trade_date) AS min_trade_date,
              MAX(trade_date) AS max_trade_date
            FROM temp_candidate_ml_features
            """
        ).fetchone()
        inserted_rows = int(candidate_row["count"] or 0)
        if inserted_rows <= 0:
            conn.rollback()
            return {
                "attempted": True,
                "symbols": len(unique_symbols),
                "insertedRows": 0,
                "reason": "当前候选标的没有生成可评分特征行。",
            }

        target_columns = table_columns(conn, "feature_db.table_info(financial_ml_features)")
        temp_columns = set(table_columns(conn, "table_info(temp_candidate_ml_features)"))
        missing_columns = [column for column in target_columns if column not in temp_columns]
        if missing_columns:
            raise RuntimeError(f"候选特征补齐列不完整：缺少 {', '.join(missing_columns[:8])}")
        insert_columns = [column for column in target_columns if column != "rn"]
        column_sql = ", ".join(sql_identifier(column) for column in insert_columns)

        conn.execute(
            """
            DELETE FROM feature_db.financial_ml_features
            WHERE rowid IN (
              SELECT f.rowid
              FROM temp_candidate_ml_features t
              JOIN feature_db.financial_ml_features AS f INDEXED BY idx_financial_ml_features_symbol_date
                ON f.symbol = t.symbol
               AND f.trade_date = t.trade_date
              WHERE f.asset_type = ?
            )
            """,
            (domain,),
        )
        conn.execute(
            f"""
            INSERT INTO feature_db.financial_ml_features ({column_sql})
            SELECT {column_sql}
            FROM temp_candidate_ml_features
            """
        )
        conn.commit()
        return {
            "attempted": True,
            "symbols": len(unique_symbols),
            "insertedRows": inserted_rows,
            "minTradeDate": candidate_row["min_trade_date"],
            "maxTradeDate": candidate_row["max_trade_date"],
            "featureDb": str(feature_db_path),
        }
    finally:
        if attached:
            try:
                conn.execute("DETACH DATABASE feature_db")
            except Exception:
                pass
        conn.close()


def candidate_feature_gap(db_path, feature_db_path, domain, symbols, as_of_trade_date):
    unique_symbols = sorted({symbol for symbol in symbols if symbol})
    if not unique_symbols or not as_of_trade_date:
        return {"missingSymbols": [], "checkedSymbols": 0}

    conn = connect(db_path)
    feature_conn = connect(feature_db_path)
    missing_symbols = []
    try:
        for symbol in unique_symbols:
            price_row = conn.execute(
                """
                SELECT MAX(trade_date) AS latest_trade_date
                FROM financial_daily_prices INDEXED BY idx_financial_daily_prices_symbol_date
                WHERE symbol = ?
                  AND asset_type = ?
                  AND close IS NOT NULL
                  AND close > 0
                  AND trade_date IS NOT NULL
                  AND trade_date <= ?
                """,
                (symbol, domain, as_of_trade_date),
            ).fetchone()
            latest_price_date = price_row["latest_trade_date"] if price_row else None
            if not latest_price_date:
                continue

            feature_row = feature_conn.execute(
                """
                SELECT MAX(trade_date) AS latest_trade_date
                FROM financial_ml_features INDEXED BY idx_financial_ml_features_symbol_date
                WHERE symbol = ?
                  AND asset_type = ?
                  AND trade_date IS NOT NULL
                  AND trade_date <= ?
                """,
                (symbol, domain, as_of_trade_date),
            ).fetchone()
            latest_feature_date = feature_row["latest_trade_date"] if feature_row else None
            if latest_feature_date is None or latest_feature_date < latest_price_date:
                missing_symbols.append(symbol)
        return {
            "missingSymbols": missing_symbols,
            "checkedSymbols": len(unique_symbols),
            "missingCount": len(missing_symbols),
        }
    finally:
        feature_conn.close()
        conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--rule-version", default="candidate_pool_v1")
    parser.add_argument("--domain", choices=["stock", "etf"])
    parser.add_argument("--symbol")
    parser.add_argument("--model-key")
    parser.add_argument("--pool-status", choices=["active", "expired", "all"], default="active")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--trade-date")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        as_of_trade_date = args.trade_date
        if not as_of_trade_date and args.domain in ("stock", "etf"):
            as_of_trade_date = latest_covered_trade_date(conn, args.domain)

        params = [args.rule_version]
        domain_filter = ""
        symbol_filter = ""
        status_filter = ""
        trade_date_filter = ""
        if args.pool_status != "all":
            status_filter = " AND pool_status = ?"
            params.append(args.pool_status)
        if args.domain:
            domain_filter = " AND asset_type = ?"
            params.append(args.domain)
        if args.symbol:
            symbol_filter = " AND symbol = ?"
            params.append(args.symbol)
        if as_of_trade_date:
            trade_date_filter = " AND (trade_date IS NULL OR trade_date <= ?)"
            params.append(as_of_trade_date)
        params.append(args.limit)
        rows = conn.execute(
            f"""
            SELECT symbol, name, asset_type, source
            FROM financial_candidate_pool
            WHERE rule_version = ?
              {status_filter}
              {domain_filter}
              {symbol_filter}
              {trade_date_filter}
            ORDER BY priority_score DESC, last_checked_at DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
    finally:
        conn.close()

    model_cache = {}
    candidate_feature_refreshes = {}
    scores = {}
    for row in rows:
        domain = row["asset_type"]
        key = f"{row['symbol']}|{row['asset_type']}|{row['source']}"
        if domain not in ("stock", "etf"):
            scores[key] = {"available": False, "reason": "该资产类型暂未接入模型"}
            continue

        if domain not in model_cache:
            main_conn = connect(args.db)
            try:
                artifact = pick_artifact(main_conn, domain, args.model_key if args.domain == domain else None)
                latest_feature_trade_date = feature_db_latest_trade_date(artifact["source_feature_db"], domain)
                domain_symbols = [candidate["symbol"] for candidate in rows if candidate["asset_type"] == domain]
                feature_gap = candidate_feature_gap(
                    args.db,
                    artifact["source_feature_db"],
                    domain,
                    domain_symbols,
                    as_of_trade_date,
                )
                if as_of_trade_date and feature_gap.get("missingSymbols"):
                    candidate_feature_refresh = ensure_candidate_feature_rows(
                        args.db,
                        artifact["source_feature_db"],
                        domain,
                        feature_gap["missingSymbols"],
                        as_of_trade_date,
                    )
                    candidate_feature_refresh["beforeMissingCount"] = feature_gap.get("missingCount", 0)
                    feature_gap = candidate_feature_gap(
                        args.db,
                        artifact["source_feature_db"],
                        domain,
                        domain_symbols,
                        as_of_trade_date,
                    )
                    candidate_feature_refresh["afterMissingCount"] = feature_gap.get("missingCount", 0)
                    candidate_feature_refreshes[domain] = candidate_feature_refresh
                    latest_feature_trade_date = feature_db_latest_trade_date(artifact["source_feature_db"], domain)
                    if feature_gap.get("missingSymbols"):
                        missing_sample = ", ".join(feature_gap["missingSymbols"][:8])
                        raise RuntimeError(f"{domain} 候选标的特征仍缺失：{missing_sample}")
                model_cache[domain] = {
                    "artifact": artifact,
                    "model": joblib.load(artifact["model_file"]),
                    "features": model_features(artifact),
                    "latestFeatureTradeDate": latest_feature_trade_date,
                }
            except Exception as exc:
                model_cache[domain] = {"error": str(exc)}
            finally:
                main_conn.close()

        cached = model_cache[domain]
        if cached.get("error"):
            scores[key] = {"available": False, "reason": cached["error"]}
            continue

        artifact = cached["artifact"]
        try:
            feature_trade_date = args.trade_date or as_of_trade_date
            feature_row = latest_feature_row(artifact["source_feature_db"], domain, row["symbol"], feature_trade_date)
            matrix = np.asarray([[float(feature_row[feature] or 0) for feature in cached["features"]]], dtype=np.float32)
            probability = float(cached["model"].predict_proba(matrix)[0][1])
            scores[key] = {
                "available": True,
                "probability": probability,
                "modelKey": artifact["model_key"],
                "target": artifact["target"],
                "tradeDate": feature_row["trade_date"],
                "asOfTradeDate": as_of_trade_date,
                "latestFeatureTradeDate": feature_row["trade_date"],
            }
        except Exception as exc:
            scores[key] = {"available": False, "reason": str(exc)}

    print(json.dumps({
        "success": True,
        "data": {
            "asOfTradeDate": as_of_trade_date,
            "candidateFeatureRefreshes": candidate_feature_refreshes,
            "scores": scores,
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
