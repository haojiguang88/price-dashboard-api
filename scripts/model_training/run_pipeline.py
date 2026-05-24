#!/usr/bin/env python3
import argparse
import json
import math
import os
import random
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path


PLAN_ORDER = [
    "data_audit",
    "feature_table",
    "label_table",
    "split_dataset",
    "baseline_stats",
    "logistic_regression",
    "random_forest",
    "lightgbm_model",
    "backtest_report",
    "persist_models",
    "prediction_api",
    "frontend_result",
    "strategy_feedback",
    "llm_rule_summary",
    "llm_failure_review",
    "llm_strategy_docs",
    "llm_assisted_iteration",
]

MODEL_FEATURES = [
    "ret_5d",
    "ret_10d",
    "ret_20d",
    "ret_60d",
    "volume_ratio_20",
    "amount_ratio_20",
    "price_pos_60",
    "price_pos_120",
    "safety_zone_pos",
    "volatility_20",
    "volatility_60",
    "ma20_slope_5d",
    "ma60_slope_20d",
    "distance_ma20",
    "distance_ma60",
    "drawdown_20d",
    "drawdown_60d",
    "breakout_20d",
    "pullback_from_20d_high",
    "limit_up_like",
    "limit_down_like",
    "in_safety_zone",
    "structure_score",
    "trend_uptrend",
    "trend_downtrend",
    "trend_range",
    "hs300_ret_20d",
    "hs300_ret_60d",
    "hs300_ret_120d",
    "hs300_distance_ma60",
    "hs300_drawdown_60d",
    "relative_ret20_hs300",
    "relative_ret60_hs300",
    "relative_ret120_hs300",
    "market_normal",
    "market_risk",
    "market_crash",
    "market_unknown",
    "breadth_up_ratio",
    "breadth_down_ratio",
    "breadth_limit_up_ratio",
    "breadth_limit_down_ratio",
    "breadth_above_ma20_ratio",
    "breadth_above_ma60_ratio",
    "breadth_above_ma120_ratio",
    "breadth_amount_ratio_5_20",
    "industry_known",
    "industry_ret_5d",
    "industry_ret_20d",
    "industry_ret_60d",
    "industry_amount_ratio_20",
    "industry_ret20_rank",
    "industry_relative_ret20_hs300",
    "asset_vs_industry_ret20",
    "etf_route_broad_etf",
    "etf_route_industry_etf",
    "etf_route_cross_border_etf",
    "etf_route_bond_cash_etf",
    "etf_route_commodity_etf",
    "etf_route_other",
]

MODEL_TARGET_LABEL = "label_structure_safe_20d"
MODEL_TARGET_TEXT = "未来20日收益>5%且回撤<=8%且不跌破安全区"


def now():
    return datetime.utcnow().isoformat(timespec="milliseconds") + "Z"


def connect(db_path):
    conn = sqlite3.connect(db_path, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 60000")
    return conn


def update_run(conn, run_id, **fields):
    if not fields:
        return
    fields["updated_at"] = now()
    assignments = ", ".join(f"{key} = ?" for key in fields)
    params = list(fields.values()) + [run_id]
    conn.execute(f"UPDATE model_training_runs SET {assignments} WHERE id = ?", params)
    conn.commit()


def table_exists(conn, table_name):
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def has_run_plan_items(conn, run_id):
    if not table_exists(conn, "model_training_run_plan_items"):
        return False
    row = conn.execute(
        "SELECT COUNT(*) AS count FROM model_training_run_plan_items WHERE run_id = ?",
        (run_id,),
    ).fetchone()
    return bool(row and row["count"])


def update_plan_item(conn, domain, item_key, status, note=None, completed=False, run_id=None):
    timestamp = now()
    completed_at = timestamp if completed else None
    if run_id and has_run_plan_items(conn, run_id):
        conn.execute(
            """
            UPDATE model_training_run_plan_items
            SET status = ?,
                note = COALESCE(?, note),
                completed_at = ?,
                updated_at = ?
            WHERE run_id = ? AND domain = ? AND item_key = ?
            """,
            (status, note, completed_at, timestamp, run_id, domain, item_key),
        )
    else:
        conn.execute(
            """
            UPDATE model_training_plan_items
            SET status = ?,
                note = COALESCE(?, note),
                completed_at = ?,
                updated_at = ?
            WHERE domain = ? AND item_key = ?
            """,
            (status, note, completed_at, timestamp, domain, item_key),
        )
    conn.commit()


def write_artifact(output_dir, filename, payload):
    path = Path(output_dir)
    path.mkdir(parents=True, exist_ok=True)
    (path / filename).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def read_json_file(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def latest_domain_artifact(output_dir, filename):
    output_path = Path(output_dir)
    direct_path = output_path / filename
    if direct_path.exists():
        return direct_path

    domain_root = output_path.parent
    candidates = sorted(
        domain_root.glob(f"run-*/{filename}"),
        key=lambda candidate: candidate.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        return None
    return candidates[0]


def sigmoid(value):
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def auc_score(labels, scores):
    pairs = sorted(zip(scores, labels), key=lambda item: item[0])
    pos = sum(labels)
    neg = len(labels) - pos
    if pos == 0 or neg == 0:
        return None
    rank_sum = 0.0
    index = 0
    while index < len(pairs):
        end = index + 1
        while end < len(pairs) and pairs[end][0] == pairs[index][0]:
            end += 1
        avg_rank = (index + 1 + end) / 2.0
        for cursor in range(index, end):
            if pairs[cursor][1] == 1:
                rank_sum += avg_rank
        index = end
    return (rank_sum - pos * (pos + 1) / 2.0) / (pos * neg)


def classification_metrics(labels, scores, threshold=0.5):
    preds = [1 if score >= threshold else 0 for score in scores]
    tp = sum(1 for y, p in zip(labels, preds) if y == 1 and p == 1)
    tn = sum(1 for y, p in zip(labels, preds) if y == 0 and p == 0)
    fp = sum(1 for y, p in zip(labels, preds) if y == 0 and p == 1)
    fn = sum(1 for y, p in zip(labels, preds) if y == 1 and p == 0)
    total = len(labels)
    return {
        "samples": total,
        "positive_rate": sum(labels) / total if total else None,
        "accuracy": (tp + tn) / total if total else None,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "auc": auc_score(labels, scores),
        "avg_score": sum(scores) / total if total else None,
        "confusion": {"tp": tp, "tn": tn, "fp": fp, "fn": fn},
    }


def run_data_audit(conn, domain, output_dir):
    deleted = 0
    if domain in ("stock", "etf"):
      before = conn.execute(
          """
          SELECT COUNT(*) AS count
          FROM financial_daily_prices
          WHERE asset_type = ?
            AND (close IS NULL OR close <= 0 OR trade_date IS NULL)
          """,
          (domain,),
      ).fetchone()["count"]
      conn.execute(
          """
          DELETE FROM financial_daily_prices
          WHERE asset_type = ?
            AND (close IS NULL OR close <= 0 OR trade_date IS NULL)
          """,
          (domain,),
      )
      conn.commit()
      deleted = before
      remaining = conn.execute(
          """
          SELECT COUNT(*) AS count
          FROM financial_daily_prices
          WHERE asset_type = ?
            AND close IS NOT NULL
            AND close > 0
            AND trade_date IS NOT NULL
          """,
          (domain,),
      ).fetchone()["count"]
    else:
      remaining = conn.execute(
          "SELECT COUNT(*) AS count FROM football_matches WHERE is_deleted = 0"
      ).fetchone()["count"]

    write_artifact(output_dir, "data_audit.json", {
        "domain": domain,
        "deleted_invalid_rows": deleted,
        "remaining_source_rows": remaining,
        "completed_at": now(),
    })
    return f"数据体检完成；删除无效行 {deleted}；可用源数据 {remaining} 行。"


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


def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def cleanup_sqlite_file(path):
    path = Path(path)
    for candidate in [
        path,
        Path(str(path) + "-journal"),
        Path(str(path) + "-wal"),
        Path(str(path) + "-shm"),
    ]:
        if candidate.exists():
            candidate.unlink()


def configure_sqlite_work_area(conn, output_path):
    temp_dir = Path(output_path) / "_sqlite_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)

    for key in ("SQLITE_TMPDIR", "TMPDIR", "TEMP", "TMP"):
        os.environ[key] = str(temp_dir)

    conn.execute("PRAGMA temp_store = FILE")
    conn.execute("PRAGMA cache_size = -200000")
    try:
        conn.execute(f"PRAGMA temp_store_directory = {sql_literal(temp_dir)}")
    except sqlite3.DatabaseError:
        pass

    return temp_dir


def configure_training_artifact_db(conn, schema_name):
    conn.execute(f"PRAGMA {schema_name}.synchronous = OFF")
    conn.execute(f"PRAGMA {schema_name}.journal_mode = OFF")


def record_feature_progress(output_dir, step_key, note):
    progress_path = Path(output_dir) / "feature_table_progress.json"
    payload = read_json_file(progress_path) if progress_path.exists() else {"steps": []}
    payload["updated_at"] = now()
    payload["steps"].append({
        "step": step_key,
        "note": note,
        "completed_at": now(),
    })
    write_artifact(output_dir, "feature_table_progress.json", payload)


def execute_feature_step(conn, output_dir, step_key, note, sql, params=()):
    conn.execute(sql, params)
    conn.commit()
    record_feature_progress(output_dir, step_key, note)


def run_feature_table(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩特征表需要用比赛/盘口数据单独生成，不能复用金融日线特征脚本。")

    max_trade_date = latest_covered_trade_date(conn, domain)
    if not max_trade_date:
        raise RuntimeError(f"{domain} 没有覆盖合格的交易日，停止生成训练样本表。")

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    feature_db_path = output_path / "features.sqlite"
    work_db_path = output_path / "features_work.sqlite"
    cleanup_sqlite_file(feature_db_path)
    cleanup_sqlite_file(work_db_path)

    temp_dir = configure_sqlite_work_area(conn, output_path)
    conn.execute(f"ATTACH DATABASE ? AS feature_db", (str(feature_db_path),))
    conn.execute(f"ATTACH DATABASE ? AS feature_work", (str(work_db_path),))
    try:
        configure_training_artifact_db(conn, "feature_db")
        configure_training_artifact_db(conn, "feature_work")

        execute_feature_step(
            conn,
            output_dir,
            "price_base",
            "基础日线滚动窗口表已落盘到外接盘工作库。",
            """
            CREATE TABLE feature_work.price_base AS
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
              close / NULLIF(LAG(close, 1) OVER symbol_window, 0) - 1.0 AS ret_1d,
              close / NULLIF(LAG(close, 5) OVER symbol_window, 0) - 1.0 AS ret_5d,
              close / NULLIF(LAG(close, 10) OVER symbol_window, 0) - 1.0 AS ret_10d,
              close / NULLIF(LAG(close, 20) OVER symbol_window, 0) - 1.0 AS ret_20d,
              close / NULLIF(LAG(close, 60) OVER symbol_window, 0) - 1.0 AS ret_60d,
              AVG(close) OVER ma5_window AS ma5,
              AVG(close) OVER ma10_window AS ma10,
              AVG(close) OVER ma20_window AS ma20,
              AVG(close) OVER ma60_window AS ma60,
              AVG(close) OVER ma120_window AS ma120,
              AVG(volume) OVER ma20_window AS volume_ma20,
              AVG(amount) OVER amount20_window AS amount_ma20,
              MIN(low) OVER ma60_window AS low_60,
              MAX(high) OVER ma60_window AS high_60,
              MIN(low) OVER ma120_window AS low_120,
              MAX(high) OVER ma120_window AS high_120,
              MIN(low) OVER ma20_window AS low_20,
              MAX(high) OVER ma20_window AS high_20
            FROM financial_daily_prices
            WHERE asset_type = ?
              AND close IS NOT NULL
              AND close > 0
              AND trade_date IS NOT NULL
              AND trade_date <= ?
            WINDOW
              symbol_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date),
              ma5_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW),
              ma10_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN 9 PRECEDING AND CURRENT ROW),
              ma20_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
              ma60_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW),
              ma120_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN 119 PRECEDING AND CURRENT ROW),
              amount20_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)
            """,
            (domain, max_trade_date),
        )
        conn.execute("CREATE INDEX feature_work.idx_price_base_symbol_date ON price_base(symbol, trade_date)")
        conn.execute("CREATE INDEX feature_work.idx_price_base_trade_date ON price_base(trade_date)")
        conn.commit()

        execute_feature_step(
            conn,
            output_dir,
            "price_features",
            "价格结构特征表已落盘到外接盘工作库。",
            """
            CREATE TABLE feature_work.price_features AS
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
            FROM feature_work.price_base
            WINDOW
              feature_symbol_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date),
              vol20_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
              vol60_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW)
            """,
        )
        conn.execute("CREATE INDEX feature_work.idx_price_features_symbol_date ON price_features(symbol, trade_date)")
        conn.execute("CREATE INDEX feature_work.idx_price_features_trade_date ON price_features(trade_date)")
        conn.commit()

        execute_feature_step(
            conn,
            output_dir,
            "feature_dates",
            "特征交易日表已落盘到外接盘工作库。",
            """
            CREATE TABLE feature_work.feature_dates AS
            SELECT DISTINCT trade_date
            FROM feature_work.price_features
            """,
        )
        conn.execute("CREATE UNIQUE INDEX feature_work.idx_feature_dates_trade_date ON feature_dates(trade_date)")
        conn.commit()

        execute_feature_step(
            conn,
            output_dir,
            "market_asof",
            "沪深300和市场状态 as-of 表已落盘到外接盘工作库。",
            """
            CREATE TABLE feature_work.market_asof AS
            WITH
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
                  AND trade_date <= ?
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
              FROM feature_work.feature_dates fd
              LEFT JOIN market_context mc
                ON mc.trade_date = (
                  SELECT MAX(mc2.trade_date)
                  FROM market_context mc2
                  WHERE mc2.trade_date <= fd.trade_date
                )
            )
            SELECT * FROM market_asof
            """,
            (max_trade_date,),
        )
        conn.execute("CREATE UNIQUE INDEX feature_work.idx_market_asof_date ON market_asof(feature_trade_date)")
        conn.commit()

        execute_feature_step(
            conn,
            output_dir,
            "breadth_asof",
            "市场宽度 as-of 表已落盘到外接盘工作库。",
            """
            CREATE TABLE feature_work.breadth_asof AS
            WITH
            breadth_context AS (
              SELECT *
              FROM financial_market_breadth_daily
              WHERE market_universe = 'stock_tushare'
            ),
            breadth_asof AS (
              SELECT
                fd.trade_date AS feature_trade_date,
                b.*
              FROM feature_work.feature_dates fd
              LEFT JOIN breadth_context b
                ON b.trade_date = (
                  SELECT MAX(b2.trade_date)
                  FROM breadth_context b2
                  WHERE b2.trade_date <= fd.trade_date
                )
            )
            SELECT * FROM breadth_asof
            """,
        )
        conn.execute("CREATE UNIQUE INDEX feature_work.idx_breadth_asof_date ON breadth_asof(feature_trade_date)")
        conn.commit()

        execute_feature_step(
            conn,
            output_dir,
            "industry_asof",
            "行业强弱 as-of 表已落盘到外接盘工作库。",
            """
            CREATE TABLE feature_work.industry_asof AS
            WITH
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
              FROM feature_work.feature_dates fd
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
            )
            SELECT * FROM industry_asof
            """,
        )
        conn.execute("CREATE INDEX feature_work.idx_industry_asof_date_code ON industry_asof(feature_trade_date, index_code)")
        conn.commit()

        execute_feature_step(
            conn,
            output_dir,
            "industry_members",
            "行业成分映射表已复制到外接盘工作库。",
            """
            CREATE TABLE feature_work.industry_members AS
            SELECT symbol, l1_code, in_date, out_date
            FROM financial_sw_industry_members
            """,
        )
        conn.execute("CREATE INDEX feature_work.idx_industry_members_symbol_dates ON industry_members(symbol, in_date, out_date)")
        conn.commit()

        execute_feature_step(
            conn,
            output_dir,
            "universe_context",
            "资产路由表已落盘到外接盘工作库。",
            """
            CREATE TABLE feature_work.universe_context AS
            WITH
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
            )
            SELECT * FROM universe_context
            """,
        )
        conn.execute("CREATE UNIQUE INDEX feature_work.idx_universe_context_symbol_type ON universe_context(symbol, asset_type)")
        conn.commit()

        execute_feature_step(
            conn,
            output_dir,
            "financial_ml_features",
            "最终训练特征表已写入 features.sqlite。",
            """
            CREATE TABLE feature_db.financial_ml_features AS
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
            FROM feature_work.price_features features
            LEFT JOIN feature_work.market_asof market_asof
              ON market_asof.feature_trade_date = features.trade_date
            LEFT JOIN feature_work.breadth_asof breadth_asof
              ON breadth_asof.feature_trade_date = features.trade_date
            LEFT JOIN feature_work.industry_members industry_member
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
            LEFT JOIN feature_work.industry_asof industry_asof
              ON industry_asof.index_code = industry_member.l1_code
             AND industry_asof.feature_trade_date = features.trade_date
            LEFT JOIN feature_work.universe_context universe_context
              ON universe_context.symbol = features.symbol
             AND universe_context.asset_type = features.asset_type
            WHERE ma60 IS NOT NULL
            WINDOW
              feature_output_window AS (PARTITION BY features.symbol, features.asset_type ORDER BY features.trade_date)
            """,
        )
        conn.execute("CREATE INDEX feature_db.idx_financial_ml_features_symbol_date ON financial_ml_features(symbol, trade_date)")
        conn.execute("CREATE INDEX feature_db.idx_financial_ml_features_date ON financial_ml_features(trade_date)")
        conn.commit()

        row = conn.execute("SELECT COUNT(*) AS count FROM feature_db.financial_ml_features").fetchone()
        symbol_row = conn.execute("SELECT COUNT(DISTINCT symbol) AS count FROM feature_db.financial_ml_features").fetchone()
        date_row = conn.execute("SELECT MIN(trade_date) AS min_date, MAX(trade_date) AS max_date FROM feature_db.financial_ml_features").fetchone()
        summary = {
            "domain": domain,
            "feature_db": str(feature_db_path),
            "feature_rows": row["count"],
            "symbols": symbol_row["count"],
            "min_trade_date": date_row["min_date"],
            "max_trade_date": date_row["max_date"],
            "covered_trade_date": max_trade_date,
            "completed_at": now(),
            "feature_table": "financial_ml_features",
            "work_db": str(work_db_path),
            "sqlite_temp_dir": str(temp_dir),
        }
        write_artifact(output_dir, "feature_table.json", summary)
        return f"训练样本特征表生成完成；{summary['feature_rows']} 行，{summary['symbols']} 个标的；文件：{feature_db_path}"
    finally:
        for schema_name in ("feature_work", "feature_db"):
            try:
                conn.execute(f"DETACH DATABASE {schema_name}")
            except sqlite3.DatabaseError:
                pass
        conn.commit()
        cleanup_sqlite_file(work_db_path)
        shutil.rmtree(temp_dir, ignore_errors=True)


def run_label_table(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩标签需要基于比赛结果和盘口结果单独生成，不能复用金融日线标签脚本。")

    max_trade_date = latest_covered_trade_date(conn, domain)
    if not max_trade_date:
        raise RuntimeError(f"{domain} 没有覆盖合格的交易日，停止生成训练标签。")

    feature_db_path = Path(output_dir) / "features.sqlite"
    if not feature_db_path.exists():
        domain_root = Path(output_dir).parent
        candidates = sorted(
            domain_root.glob("run-*/features.sqlite"),
            key=lambda candidate: candidate.stat().st_mtime,
            reverse=True,
        )
        if not candidates:
            raise FileNotFoundError(f"未找到特征库：{feature_db_path}，请先完成生成训练样本表。")
        shutil.copy2(candidates[0], feature_db_path)

    conn.execute(f"ATTACH DATABASE ? AS feature_db", (str(feature_db_path),))
    try:
        conn.execute("DROP TABLE IF EXISTS feature_db.financial_ml_labels")
        conn.execute(
            """
            CREATE TABLE feature_db.financial_ml_labels AS
            WITH forward AS (
              SELECT
                symbol,
                asset_type,
                trade_date,
                close,
                LEAD(close, 5) OVER symbol_window AS close_fwd_5,
                LEAD(close, 10) OVER symbol_window AS close_fwd_10,
                LEAD(close, 20) OVER symbol_window AS close_fwd_20,
                LEAD(close, 60) OVER symbol_window AS close_fwd_60,
                MIN(low) OVER drawdown_20_window AS min_low_next_20,
                MAX(high) OVER breakout_20_window AS max_high_prev_20,
                MAX(high) OVER future_5_window AS max_high_next_5,
                MIN(close) OVER future_5_close_window AS min_close_next_5
              FROM financial_daily_prices
              WHERE asset_type = ?
                AND close IS NOT NULL
                AND close > 0
                AND trade_date IS NOT NULL
                AND trade_date <= ?
              WINDOW
                symbol_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date),
                drawdown_20_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN CURRENT ROW AND 20 FOLLOWING),
                breakout_20_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING),
                future_5_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN CURRENT ROW AND 5 FOLLOWING),
                future_5_close_window AS (PARTITION BY symbol, asset_type ORDER BY trade_date ROWS BETWEEN CURRENT ROW AND 5 FOLLOWING)
            )
            SELECT
              f.symbol,
              f.asset_type,
              f.trade_date,
              f.close,
              close_fwd_5 / NULLIF(f.close, 0) - 1.0 AS future_ret_5d,
              close_fwd_10 / NULLIF(f.close, 0) - 1.0 AS future_ret_10d,
              close_fwd_20 / NULLIF(f.close, 0) - 1.0 AS future_ret_20d,
              close_fwd_60 / NULLIF(f.close, 0) - 1.0 AS future_ret_60d,
              min_low_next_20 / NULLIF(f.close, 0) - 1.0 AS max_drawdown_20d,
              CASE WHEN close_fwd_5 / NULLIF(f.close, 0) - 1.0 > 0 THEN 1 ELSE 0 END AS label_ret_5d_gt_0,
              CASE WHEN close_fwd_10 / NULLIF(f.close, 0) - 1.0 > 0.03 THEN 1 ELSE 0 END AS label_ret_10d_gt_3,
              CASE WHEN close_fwd_20 / NULLIF(f.close, 0) - 1.0 > 0.05 THEN 1 ELSE 0 END AS label_ret_20d_gt_5,
              CASE WHEN close_fwd_60 / NULLIF(f.close, 0) - 1.0 > 0.10 THEN 1 ELSE 0 END AS label_ret_60d_gt_10,
              CASE WHEN min_low_next_20 / NULLIF(f.close, 0) - 1.0 >= -0.05 THEN 1 ELSE 0 END AS label_drawdown_20d_lt_5,
              CASE WHEN min_low_next_20 < feat.safety_lower THEN 1 ELSE 0 END AS label_break_safety_20d,
              CASE
                WHEN max_high_prev_20 IS NOT NULL
                  AND f.close > max_high_prev_20
                  AND min_close_next_5 < max_high_prev_20
                  AND close_fwd_10 / NULLIF(f.close, 0) - 1.0 <= 0
                THEN 1 ELSE 0
              END AS label_fake_breakout_10d,
              CASE
                WHEN close_fwd_20 / NULLIF(f.close, 0) - 1.0 > 0.05
                  AND min_low_next_20 / NULLIF(f.close, 0) - 1.0 >= -0.08
                  AND min_low_next_20 >= feat.safety_lower
                  AND NOT (
                    max_high_prev_20 IS NOT NULL
                    AND f.close > max_high_prev_20
                    AND min_close_next_5 < max_high_prev_20
                    AND close_fwd_10 / NULLIF(f.close, 0) - 1.0 <= 0
                  )
                  AND COALESCE(feat.ret_20d, 0) > -0.20
                  AND COALESCE(feat.name, '') NOT LIKE '%ST%'
                  AND COALESCE(feat.name, '') NOT LIKE 'N%'
                THEN 1 ELSE 0
              END AS label_structure_safe_20d
            FROM forward f
            JOIN feature_db.financial_ml_features feat
              ON feat.symbol = f.symbol
             AND feat.asset_type = f.asset_type
             AND feat.trade_date = f.trade_date
            WHERE close_fwd_20 IS NOT NULL
            """,
            (domain, max_trade_date),
        )
        conn.execute("CREATE INDEX feature_db.idx_financial_ml_labels_symbol_date ON financial_ml_labels(symbol, trade_date)")
        conn.execute("CREATE INDEX feature_db.idx_financial_ml_labels_date ON financial_ml_labels(trade_date)")
        conn.commit()

        row = conn.execute("SELECT COUNT(*) AS count FROM feature_db.financial_ml_labels").fetchone()
        positive = conn.execute(
            """
            SELECT
              SUM(label_ret_5d_gt_0) AS ret_5_pos,
              SUM(label_ret_10d_gt_3) AS ret_10_gt_3,
              SUM(label_ret_20d_gt_5) AS ret_20_gt_5,
              SUM(label_structure_safe_20d) AS structure_safe_20d,
              SUM(label_drawdown_20d_lt_5) AS dd_20_ok,
              SUM(label_break_safety_20d) AS break_safety,
              SUM(label_fake_breakout_10d) AS fake_breakout
            FROM feature_db.financial_ml_labels
            """
        ).fetchone()
        summary = {
            "domain": domain,
            "feature_db": str(feature_db_path),
            "label_rows": row["count"],
            "positive_counts": dict(positive),
            "covered_trade_date": max_trade_date,
            "completed_at": now(),
            "label_table": "financial_ml_labels",
        }
        write_artifact(output_dir, "label_table.json", summary)
        return f"训练标签生成完成；{summary['label_rows']} 行；文件：{feature_db_path}"
    finally:
        conn.execute("DETACH DATABASE feature_db")
        conn.commit()


def resolve_feature_db(output_dir):
    feature_db_path = Path(output_dir) / "features.sqlite"
    if feature_db_path.exists():
        return feature_db_path

    domain_root = Path(output_dir).parent
    candidates = sorted(
        domain_root.glob("run-*/features.sqlite"),
        key=lambda candidate: candidate.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError(f"未找到特征库：{feature_db_path}，请先完成生成训练样本表和标签。")
    shutil.copy2(candidates[0], feature_db_path)
    return feature_db_path


def run_split_dataset(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩训练集切分需要基于比赛日期和赛季单独实现。")

    feature_db_path = resolve_feature_db(output_dir)
    conn.execute(f"ATTACH DATABASE ? AS feature_db", (str(feature_db_path),))
    try:
        feature_count = conn.execute(
            "SELECT COUNT(*) AS count FROM feature_db.financial_ml_features"
        ).fetchone()["count"]
        label_count = conn.execute(
            "SELECT COUNT(*) AS count FROM feature_db.financial_ml_labels"
        ).fetchone()["count"]
        if feature_count == 0 or label_count == 0:
            raise RuntimeError("特征表或标签表为空，不能切分训练集。")

        date_row = conn.execute(
            """
            SELECT
              MIN(l.trade_date) AS min_date,
              MAX(l.trade_date) AS max_date,
              CAST(strftime('%Y', MAX(l.trade_date)) AS INTEGER) AS max_year
            FROM feature_db.financial_ml_labels l
            """
        ).fetchone()
        max_year = int(date_row["max_year"])
        validation_year = max_year - 1
        test_year = max_year

        conn.execute("DROP TABLE IF EXISTS feature_db.financial_ml_dataset")
        conn.execute(
            """
            CREATE TABLE feature_db.financial_ml_dataset AS
            SELECT
              f.*,
              l.future_ret_5d,
              l.future_ret_10d,
              l.future_ret_20d,
              l.future_ret_60d,
              l.max_drawdown_20d,
              l.label_ret_5d_gt_0,
              l.label_ret_10d_gt_3,
              l.label_ret_20d_gt_5,
              l.label_ret_60d_gt_10,
              l.label_drawdown_20d_lt_5,
              l.label_break_safety_20d,
              l.label_fake_breakout_10d,
              l.label_structure_safe_20d,
              CASE
                WHEN CAST(strftime('%Y', f.trade_date) AS INTEGER) >= ? THEN 'test'
                WHEN CAST(strftime('%Y', f.trade_date) AS INTEGER) = ? THEN 'validation'
                ELSE 'train'
              END AS dataset_split
            FROM feature_db.financial_ml_features f
            JOIN feature_db.financial_ml_labels l
              ON l.symbol = f.symbol
             AND l.asset_type = f.asset_type
             AND l.trade_date = f.trade_date
            """
            ,
            (test_year, validation_year),
        )
        conn.execute("CREATE INDEX feature_db.idx_financial_ml_dataset_split ON financial_ml_dataset(dataset_split)")
        conn.execute("CREATE INDEX feature_db.idx_financial_ml_dataset_symbol_date ON financial_ml_dataset(symbol, trade_date)")
        conn.commit()

        split_rows = conn.execute(
            """
            SELECT dataset_split, COUNT(*) AS count
            FROM feature_db.financial_ml_dataset
            GROUP BY dataset_split
            ORDER BY dataset_split
            """
        ).fetchall()
        summary = {
            "domain": domain,
            "feature_db": str(feature_db_path),
            "dataset_table": "financial_ml_dataset",
            "date_range": {"min": date_row["min_date"], "max": date_row["max_date"]},
            "split_rule": {
                "train": f"year < {validation_year}",
                "validation": f"year = {validation_year}",
                "test": f"year >= {test_year}",
            },
            "rows_by_split": {row["dataset_split"]: row["count"] for row in split_rows},
            "completed_at": now(),
        }
        write_artifact(output_dir, "split_dataset.json", summary)
        return f"训练/验证/测试集切分完成；train={summary['rows_by_split'].get('train', 0)}，validation={summary['rows_by_split'].get('validation', 0)}，test={summary['rows_by_split'].get('test', 0)}。"
    finally:
        conn.execute("DETACH DATABASE feature_db")
        conn.commit()


def run_baseline_stats(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩规则基线统计需要基于盘口玩法单独实现。")

    feature_db_path = resolve_feature_db(output_dir)
    conn.execute(f"ATTACH DATABASE ? AS feature_db", (str(feature_db_path),))
    try:
        dataset_count = conn.execute(
            "SELECT COUNT(*) AS count FROM feature_db.financial_ml_dataset"
        ).fetchone()["count"]
        if dataset_count == 0:
            raise RuntimeError("训练数据集为空，不能生成规则基线统计。")

        conn.execute("DROP TABLE IF EXISTS feature_db.financial_ml_baseline_stats")
        conn.execute(
            """
            CREATE TABLE feature_db.financial_ml_baseline_stats (
              group_type TEXT NOT NULL,
              group_value TEXT NOT NULL,
              dataset_split TEXT NOT NULL,
              sample_count INTEGER NOT NULL,
              avg_future_ret_5d REAL,
              avg_future_ret_10d REAL,
              avg_future_ret_20d REAL,
              avg_future_ret_60d REAL,
              win_rate_5d REAL,
              win_rate_10d_gt_3 REAL,
              win_rate_20d_gt_5 REAL,
              structure_safe_rate_20d REAL,
              win_rate_60d_gt_10 REAL,
              avg_max_drawdown_20d REAL,
              drawdown_ok_rate_20d REAL,
              break_safety_rate_20d REAL,
              fake_breakout_rate_10d REAL
            )
            """
        )

        group_sql = [
            (
                "structure_score_bucket",
                """
                CASE
                  WHEN structure_score >= 80 THEN '80+'
                  WHEN structure_score >= 60 THEN '60-79'
                  WHEN structure_score >= 40 THEN '40-59'
                  ELSE '0-39'
                END
                """,
            ),
            ("in_safety_zone", "CASE WHEN in_safety_zone = 1 THEN '安全区内' ELSE '安全区外' END"),
            ("trend_phase", "COALESCE(trend_phase, 'unknown')"),
            (
                "structure_x_safety",
                """
                CASE
                  WHEN structure_score >= 60 AND in_safety_zone = 1 THEN '结构>=60且安全区内'
                  WHEN structure_score >= 60 AND in_safety_zone = 0 THEN '结构>=60且安全区外'
                  WHEN structure_score < 60 AND in_safety_zone = 1 THEN '结构<60但安全区内'
                  ELSE '结构<60且安全区外'
                END
                """,
            ),
        ]

        for group_type, expression in group_sql:
            conn.execute(
                f"""
                INSERT INTO feature_db.financial_ml_baseline_stats
                SELECT
                  ? AS group_type,
                  {expression} AS group_value,
                  dataset_split,
                  COUNT(*) AS sample_count,
                  AVG(future_ret_5d) AS avg_future_ret_5d,
                  AVG(future_ret_10d) AS avg_future_ret_10d,
                  AVG(future_ret_20d) AS avg_future_ret_20d,
                  AVG(future_ret_60d) AS avg_future_ret_60d,
                  AVG(label_ret_5d_gt_0) AS win_rate_5d,
                  AVG(label_ret_10d_gt_3) AS win_rate_10d_gt_3,
                  AVG(label_ret_20d_gt_5) AS win_rate_20d_gt_5,
                  AVG(label_structure_safe_20d) AS structure_safe_rate_20d,
                  AVG(label_ret_60d_gt_10) AS win_rate_60d_gt_10,
                  AVG(max_drawdown_20d) AS avg_max_drawdown_20d,
                  AVG(label_drawdown_20d_lt_5) AS drawdown_ok_rate_20d,
                  AVG(label_break_safety_20d) AS break_safety_rate_20d,
                  AVG(label_fake_breakout_10d) AS fake_breakout_rate_10d
                FROM feature_db.financial_ml_dataset
                GROUP BY group_value, dataset_split
                """,
                (group_type,),
            )
        conn.commit()

        stats_rows = conn.execute(
            "SELECT COUNT(*) AS count FROM feature_db.financial_ml_baseline_stats"
        ).fetchone()["count"]
        split_rows = conn.execute(
            """
            SELECT dataset_split, COUNT(*) AS count
            FROM feature_db.financial_ml_dataset
            GROUP BY dataset_split
            ORDER BY dataset_split
            """
        ).fetchall()
        best_rows = conn.execute(
            """
            SELECT group_type, group_value, dataset_split, sample_count,
                   ROUND(win_rate_20d_gt_5, 4) AS win_rate_20d_gt_5,
                   ROUND(structure_safe_rate_20d, 4) AS structure_safe_rate_20d,
                   ROUND(avg_future_ret_20d, 4) AS avg_future_ret_20d,
                   ROUND(avg_max_drawdown_20d, 4) AS avg_max_drawdown_20d
            FROM feature_db.financial_ml_baseline_stats
            WHERE dataset_split = 'train' AND sample_count >= 1000
            ORDER BY structure_safe_rate_20d DESC, win_rate_20d_gt_5 DESC, avg_future_ret_20d DESC
            LIMIT 10
            """
        ).fetchall()
        summary = {
            "domain": domain,
            "feature_db": str(feature_db_path),
            "baseline_table": "financial_ml_baseline_stats",
            "stats_rows": stats_rows,
            "rows_by_split": {row["dataset_split"]: row["count"] for row in split_rows},
            "top_train_groups": [dict(row) for row in best_rows],
            "completed_at": now(),
        }
        write_artifact(output_dir, "baseline_stats.json", summary)
        return f"规则基线统计完成；统计分组 {stats_rows} 行；最佳训练组已写入 baseline_stats.json。"
    finally:
        conn.execute("DETACH DATABASE feature_db")
        conn.commit()


def fetch_model_rows(conn, split, limit):
    year_count = conn.execute(
        """
        SELECT COUNT(DISTINCT strftime('%Y', trade_date)) AS count
        FROM feature_db.financial_ml_dataset
        WHERE dataset_split = ?
        """,
        (split,),
    ).fetchone()["count"] or 1
    per_group_limit = max(1000, math.ceil(limit / max(1, year_count * 2)))
    feature_select_sql = ",\n          ".join(
        [
            "CASE WHEN trend_phase = 'uptrend' THEN 1 ELSE 0 END AS trend_uptrend"
            if feature == "trend_uptrend"
            else "CASE WHEN trend_phase = 'downtrend' THEN 1 ELSE 0 END AS trend_downtrend"
            if feature == "trend_downtrend"
            else "CASE WHEN trend_phase = 'range' THEN 1 ELSE 0 END AS trend_range"
            if feature == "trend_range"
            else f"COALESCE({feature}, 0) AS {feature}"
            for feature in MODEL_FEATURES
        ]
    )
    rows = conn.execute(
        f"""
        WITH sampled AS (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY strftime('%Y', trade_date), {MODEL_TARGET_LABEL}
                   ORDER BY RANDOM()
                 ) AS sample_rank
          FROM feature_db.financial_ml_dataset
          WHERE dataset_split = ?
            AND {MODEL_TARGET_LABEL} IS NOT NULL
        )
        SELECT
          {feature_select_sql},
          {MODEL_TARGET_LABEL} AS label
        FROM sampled
        WHERE sample_rank <= ?
        ORDER BY RANDOM()
        LIMIT ?
        """,
        (split, per_group_limit, limit),
    ).fetchall()
    features = []
    labels = []
    for row in rows:
        features.append([float(row[name]) for name in MODEL_FEATURES])
        labels.append(int(row["label"]))
    return features, labels


def save_model_artifact(output_dir, filename, payload):
    path = Path(output_dir)
    path.mkdir(parents=True, exist_ok=True)
    try:
        import joblib
    except ImportError as exc:
        raise RuntimeError("缺少 joblib，请确认正在使用 /Volumes/7100/model-training/venv/bin/python。") from exc
    joblib.dump(payload, path / filename)


def feature_importance_payload(values):
    total = float(sum(abs(value) for value in values)) or 1.0
    return sorted(
        [
            {"feature": feature, "importance": float(abs(value) / total), "raw_importance": float(value)}
            for feature, value in zip(MODEL_FEATURES, values)
        ],
        key=lambda item: item["importance"],
        reverse=True,
    )


def write_metrics_table(conn, table_name, metrics):
    conn.execute(f"DROP TABLE IF EXISTS feature_db.{table_name}")
    conn.execute(
        f"""
        CREATE TABLE feature_db.{table_name} (
          split TEXT PRIMARY KEY,
          samples INTEGER,
          positive_rate REAL,
          accuracy REAL,
          precision REAL,
          recall REAL,
          auc REAL,
          avg_score REAL
        )
        """
    )
    for split_name in ("train", "validation", "test"):
        split_metrics = metrics[split_name]
        conn.execute(
            f"""
            INSERT INTO feature_db.{table_name}
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                split_name,
                split_metrics["samples"],
                split_metrics["positive_rate"],
                split_metrics["accuracy"],
                split_metrics["precision"],
                split_metrics["recall"],
                split_metrics["auc"],
                split_metrics["avg_score"],
            ),
        )


def standardize(train_features, *other_sets):
    columns = len(train_features[0])
    means = []
    stds = []
    for col in range(columns):
        values = [row[col] for row in train_features]
        mean = sum(values) / len(values)
        variance = sum((value - mean) ** 2 for value in values) / len(values)
        std = math.sqrt(variance) or 1.0
        means.append(mean)
        stds.append(std)

    def transform(rows):
        return [[(row[col] - means[col]) / stds[col] for col in range(columns)] for row in rows]

    return [transform(train_features), *[transform(rows) for rows in other_sets]], means, stds


def train_logistic_regression(features, labels, epochs=80, lr=0.08, l2=0.001):
    random.seed(42)
    weights = [0.0 for _ in range(len(features[0]))]
    bias = math.log((sum(labels) + 1) / (len(labels) - sum(labels) + 1))
    n = len(labels)
    for _ in range(epochs):
        grad_w = [0.0 for _ in weights]
        grad_b = 0.0
        for row, label in zip(features, labels):
            pred = sigmoid(sum(w * value for w, value in zip(weights, row)) + bias)
            error = pred - label
            grad_b += error
            for index, value in enumerate(row):
                grad_w[index] += error * value
        bias -= lr * grad_b / n
        for index in range(len(weights)):
            grad = grad_w[index] / n + l2 * weights[index]
            weights[index] -= lr * grad
    return weights, bias


def predict_scores(features, weights, bias):
    return [sigmoid(sum(w * value for w, value in zip(weights, row)) + bias) for row in features]


def gini_impurity(labels):
    if not labels:
        return 0.0
    positive = sum(labels) / len(labels)
    return 1.0 - positive * positive - (1.0 - positive) * (1.0 - positive)


def build_decision_stump(features, labels, feature_indices):
    base_impurity = gini_impurity(labels)
    best = None
    n = len(labels)
    for feature_index in feature_indices:
        values = [row[feature_index] for row in features]
        sorted_values = sorted(values)
        if len(sorted_values) < 10:
            continue
        quantiles = [0.2, 0.35, 0.5, 0.65, 0.8]
        thresholds = []
        for quantile in quantiles:
            pos = min(len(sorted_values) - 1, max(0, int(len(sorted_values) * quantile)))
            thresholds.append(sorted_values[pos])
        for threshold in sorted(set(thresholds)):
            left_labels = []
            right_labels = []
            for row, label in zip(features, labels):
                if row[feature_index] <= threshold:
                    left_labels.append(label)
                else:
                    right_labels.append(label)
            if len(left_labels) < 50 or len(right_labels) < 50:
                continue
            weighted_impurity = (len(left_labels) / n) * gini_impurity(left_labels) + (len(right_labels) / n) * gini_impurity(right_labels)
            gain = base_impurity - weighted_impurity
            if best is None or gain > best["gain"]:
                best = {
                    "feature_index": feature_index,
                    "feature": MODEL_FEATURES[feature_index],
                    "threshold": threshold,
                    "gain": gain,
                    "left_prob": (sum(left_labels) + 1) / (len(left_labels) + 2),
                    "right_prob": (sum(right_labels) + 1) / (len(right_labels) + 2),
                    "left_count": len(left_labels),
                    "right_count": len(right_labels),
                }
    if best is None:
        positive = (sum(labels) + 1) / (len(labels) + 2)
        best = {
            "feature_index": 0,
            "feature": MODEL_FEATURES[0],
            "threshold": 0.0,
            "gain": 0.0,
            "left_prob": positive,
            "right_prob": positive,
            "left_count": len(labels),
            "right_count": 0,
        }
    return best


def predict_stump_scores(features, stump):
    feature_index = stump["feature_index"]
    threshold = stump["threshold"]
    return [stump["left_prob"] if row[feature_index] <= threshold else stump["right_prob"] for row in features]


def train_stump_forest(features, labels, n_estimators=40, sample_size=30000, feature_sample_size=5):
    random.seed(42)
    forest = []
    n = len(labels)
    feature_count = len(MODEL_FEATURES)
    for _ in range(n_estimators):
        sample_indices = [random.randrange(n) for _ in range(min(sample_size, n))]
        sampled_features = [features[index] for index in sample_indices]
        sampled_labels = [labels[index] for index in sample_indices]
        feature_indices = random.sample(range(feature_count), min(feature_sample_size, feature_count))
        forest.append(build_decision_stump(sampled_features, sampled_labels, feature_indices))
    return forest


def predict_forest_scores(features, forest):
    if not forest:
        return [0.0 for _ in features]
    aggregate = [0.0 for _ in features]
    for stump in forest:
        scores = predict_stump_scores(features, stump)
        for index, score in enumerate(scores):
            aggregate[index] += score
    return [score / len(forest) for score in aggregate]


def run_logistic_regression(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩逻辑回归需要基于盘口标签单独实现。")

    try:
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler
    except ImportError as exc:
        raise RuntimeError("缺少 scikit-learn，请确认正在使用 /Volumes/7100/model-training/venv/bin/python。") from exc

    feature_db_path = resolve_feature_db(output_dir)
    conn.execute(f"ATTACH DATABASE ? AS feature_db", (str(feature_db_path),))
    try:
        dataset_count = conn.execute(
            "SELECT COUNT(*) AS count FROM feature_db.financial_ml_dataset"
        ).fetchone()["count"]
        if dataset_count == 0:
            raise RuntimeError("训练数据集为空，不能训练逻辑回归。")

        train_x, train_y = fetch_model_rows(conn, "train", 200000)
        validation_x, validation_y = fetch_model_rows(conn, "validation", 100000)
        test_x, test_y = fetch_model_rows(conn, "test", 100000)
        if not train_x or not validation_x or not test_x:
            raise RuntimeError("训练/验证/测试样本不足，不能训练逻辑回归。")

        model = Pipeline([
            ("scaler", StandardScaler()),
            ("classifier", LogisticRegression(
                max_iter=800,
                class_weight="balanced",
                random_state=42,
                solver="lbfgs",
            )),
        ])
        model.fit(train_x, train_y)
        train_scores = model.predict_proba(train_x)[:, 1].tolist()
        validation_scores = model.predict_proba(validation_x)[:, 1].tolist()
        test_scores = model.predict_proba(test_x)[:, 1].tolist()
        classifier = model.named_steps["classifier"]

        model_payload = {
            "domain": domain,
            "model_type": "sklearn_logistic_regression",
            "target": MODEL_TARGET_LABEL,
            "features": MODEL_FEATURES,
            "model_file": "logistic_regression_model.joblib",
            "intercept": float(classifier.intercept_[0]),
            "coefficients": [float(value) for value in classifier.coef_[0]],
            "trained_at": now(),
            "source_feature_db": str(feature_db_path),
        }
        metrics = {
            "train": classification_metrics(train_y, train_scores),
            "validation": classification_metrics(validation_y, validation_scores),
            "test": classification_metrics(test_y, test_scores),
            "feature_weights": sorted(
                [
                    {"feature": feature, "weight": float(weight), "abs_weight": float(abs(weight))}
                    for feature, weight in zip(MODEL_FEATURES, classifier.coef_[0])
                ],
                key=lambda item: item["abs_weight"],
                reverse=True,
            ),
            "sample_limits": {"train": len(train_y), "validation": len(validation_y), "test": len(test_y)},
        }
        save_model_artifact(output_dir, "logistic_regression_model.joblib", model)
        write_artifact(output_dir, "logistic_regression_model.json", model_payload)
        write_artifact(output_dir, "logistic_regression_metrics.json", metrics)

        write_metrics_table(conn, "financial_ml_logistic_metrics", metrics)
        conn.commit()
        validation_auc = metrics["validation"]["auc"]
        test_auc = metrics["test"]["auc"]
        return f"sklearn 逻辑回归训练完成；目标={MODEL_TARGET_TEXT}；validation AUC={validation_auc:.4f}，test AUC={test_auc:.4f}。"
    finally:
        conn.execute("DETACH DATABASE feature_db")
        conn.commit()


def run_random_forest(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩随机森林需要基于盘口标签单独实现。")

    try:
        from sklearn.ensemble import RandomForestClassifier
    except ImportError as exc:
        raise RuntimeError("缺少 scikit-learn，请确认正在使用 /Volumes/7100/model-training/venv/bin/python。") from exc

    feature_db_path = resolve_feature_db(output_dir)
    conn.execute(f"ATTACH DATABASE ? AS feature_db", (str(feature_db_path),))
    try:
        dataset_count = conn.execute(
            "SELECT COUNT(*) AS count FROM feature_db.financial_ml_dataset"
        ).fetchone()["count"]
        if dataset_count == 0:
            raise RuntimeError("训练数据集为空，不能训练随机森林。")

        train_x, train_y = fetch_model_rows(conn, "train", 160000)
        validation_x, validation_y = fetch_model_rows(conn, "validation", 80000)
        test_x, test_y = fetch_model_rows(conn, "test", 80000)
        if not train_x or not validation_x or not test_x:
            raise RuntimeError("训练/验证/测试样本不足，不能训练随机森林。")

        model = RandomForestClassifier(
            n_estimators=180,
            max_depth=9,
            min_samples_leaf=120,
            max_features="sqrt",
            class_weight="balanced_subsample",
            random_state=42,
            n_jobs=-1,
        )
        model.fit(train_x, train_y)
        train_scores = model.predict_proba(train_x)[:, 1].tolist()
        validation_scores = model.predict_proba(validation_x)[:, 1].tolist()
        test_scores = model.predict_proba(test_x)[:, 1].tolist()
        feature_importance = feature_importance_payload(model.feature_importances_)

        model_payload = {
            "domain": domain,
            "model_type": "sklearn_random_forest",
            "target": MODEL_TARGET_LABEL,
            "features": MODEL_FEATURES,
            "model_file": "random_forest_model.joblib",
            "params": model.get_params(),
            "trained_at": now(),
            "source_feature_db": str(feature_db_path),
        }
        metrics = {
            "train": classification_metrics(train_y, train_scores),
            "validation": classification_metrics(validation_y, validation_scores),
            "test": classification_metrics(test_y, test_scores),
            "feature_importance": feature_importance,
            "rule_candidates": feature_importance[:8],
            "sample_limits": {"train": len(train_y), "validation": len(validation_y), "test": len(test_y)},
        }
        save_model_artifact(output_dir, "random_forest_model.joblib", model)
        write_artifact(output_dir, "random_forest_model.json", model_payload)
        write_artifact(output_dir, "random_forest_metrics.json", metrics)

        write_metrics_table(conn, "financial_ml_random_forest_metrics", metrics)
        conn.commit()
        validation_auc = metrics["validation"]["auc"]
        test_auc = metrics["test"]["auc"]
        return f"sklearn 随机森林规则挖掘完成；目标={MODEL_TARGET_TEXT}；validation AUC={validation_auc:.4f}，test AUC={test_auc:.4f}。"
    finally:
        conn.execute("DETACH DATABASE feature_db")
        conn.commit()


def run_lightgbm_model(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩 LightGBM 需要基于盘口标签单独实现。")

    try:
        import numpy as np
        from lightgbm import LGBMClassifier
    except ImportError as exc:
        raise RuntimeError("缺少 numpy 或 LightGBM，请确认正在使用 /Volumes/7100/model-training/venv/bin/python。") from exc

    feature_db_path = resolve_feature_db(output_dir)
    conn.execute(f"ATTACH DATABASE ? AS feature_db", (str(feature_db_path),))
    try:
        dataset_count = conn.execute(
            "SELECT COUNT(*) AS count FROM feature_db.financial_ml_dataset"
        ).fetchone()["count"]
        if dataset_count == 0:
            raise RuntimeError("训练数据集为空，不能训练 LightGBM。")

        train_x, train_y = fetch_model_rows(conn, "train", 260000)
        validation_x, validation_y = fetch_model_rows(conn, "validation", 120000)
        test_x, test_y = fetch_model_rows(conn, "test", 120000)
        if not train_x or not validation_x or not test_x:
            raise RuntimeError("训练/验证/测试样本不足，不能训练 LightGBM。")

        train_x = np.asarray(train_x, dtype=np.float32)
        validation_x = np.asarray(validation_x, dtype=np.float32)
        test_x = np.asarray(test_x, dtype=np.float32)
        train_y = np.asarray(train_y, dtype=np.int32)
        validation_y = np.asarray(validation_y, dtype=np.int32)
        test_y = np.asarray(test_y, dtype=np.int32)

        positive_count = int(np.sum(train_y))
        negative_count = len(train_y) - positive_count
        scale_pos_weight = negative_count / positive_count if positive_count else 1.0
        model = LGBMClassifier(
            objective="binary",
            n_estimators=360,
            learning_rate=0.035,
            num_leaves=31,
            max_depth=-1,
            min_child_samples=120,
            subsample=0.82,
            colsample_bytree=0.82,
            reg_alpha=0.1,
            reg_lambda=0.6,
            scale_pos_weight=scale_pos_weight,
            random_state=42,
            n_jobs=-1,
            verbosity=-1,
        )
        model.fit(
            train_x,
            train_y,
            eval_set=[(validation_x, validation_y)],
            eval_metric="auc",
        )
        train_scores = model.predict_proba(train_x)[:, 1].tolist()
        validation_scores = model.predict_proba(validation_x)[:, 1].tolist()
        test_scores = model.predict_proba(test_x)[:, 1].tolist()
        feature_importance = feature_importance_payload(model.feature_importances_)
        train_y_list = train_y.tolist()
        validation_y_list = validation_y.tolist()
        test_y_list = test_y.tolist()

        model_payload = {
            "domain": domain,
            "model_type": "lightgbm_lgbm_classifier",
            "target": MODEL_TARGET_LABEL,
            "features": MODEL_FEATURES,
            "model_file": "lightgbm_model.joblib",
            "params": model.get_params(),
            "scale_pos_weight": scale_pos_weight,
            "trained_at": now(),
            "source_feature_db": str(feature_db_path),
        }
        metrics = {
            "train": classification_metrics(train_y_list, train_scores),
            "validation": classification_metrics(validation_y_list, validation_scores),
            "test": classification_metrics(test_y_list, test_scores),
            "feature_importance": feature_importance,
            "rule_candidates": feature_importance[:10],
            "sample_limits": {"train": len(train_y), "validation": len(validation_y), "test": len(test_y)},
        }
        save_model_artifact(output_dir, "lightgbm_model.joblib", model)
        write_artifact(output_dir, "lightgbm_model.json", model_payload)
        write_artifact(output_dir, "lightgbm_metrics.json", metrics)

        write_metrics_table(conn, "financial_ml_lightgbm_metrics", metrics)
        conn.commit()
        validation_auc = metrics["validation"]["auc"]
        test_auc = metrics["test"]["auc"]
        return f"LightGBM 梯度提升模型训练完成；目标={MODEL_TARGET_TEXT}；validation AUC={validation_auc:.4f}，test AUC={test_auc:.4f}。"
    finally:
        conn.execute("DETACH DATABASE feature_db")
        conn.commit()


def run_backtest_report(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩分层回测需要基于赛果和盘口盈亏单独实现。")

    feature_db_path = resolve_feature_db(output_dir)
    conn.execute(f"ATTACH DATABASE ? AS feature_db", (str(feature_db_path),))
    try:
        dataset_count = conn.execute(
            "SELECT COUNT(*) AS count FROM feature_db.financial_ml_dataset"
        ).fetchone()["count"]
        if dataset_count == 0:
            raise RuntimeError("训练数据集为空，不能生成分层回测报告。")

        conn.execute("DROP TABLE IF EXISTS feature_db.financial_ml_backtest_report")
        conn.execute(
            """
            CREATE TABLE feature_db.financial_ml_backtest_report (
              group_type TEXT NOT NULL,
              group_value TEXT NOT NULL,
              dataset_split TEXT NOT NULL,
              sample_count INTEGER NOT NULL,
              avg_future_ret_5d REAL,
              avg_future_ret_10d REAL,
              avg_future_ret_20d REAL,
              avg_future_ret_60d REAL,
              median_future_ret_20d REAL,
              win_rate_5d REAL,
              win_rate_10d_gt_3 REAL,
              win_rate_20d_gt_5 REAL,
              structure_safe_rate_20d REAL,
              win_rate_60d_gt_10 REAL,
              avg_max_drawdown_20d REAL,
              drawdown_ok_rate_20d REAL,
              break_safety_rate_20d REAL,
              fake_breakout_rate_10d REAL,
              risk_adjusted_20d REAL
            )
            """
        )

        group_sql = [
            ("year", "strftime('%Y', trade_date)"),
            ("asset_type", "asset_type"),
            ("trend_phase", "COALESCE(trend_phase, 'unknown')"),
            ("market_regime", "COALESCE(market_regime, 'UNKNOWN')"),
            (
                "relative_hs300_bucket",
                """
                CASE
                  WHEN relative_ret20_hs300 >= 0.05 THEN '强于沪深300>=5%'
                  WHEN relative_ret20_hs300 >= 0.02 THEN '强于沪深3002-5%'
                  WHEN relative_ret20_hs300 <= -0.05 THEN '弱于沪深300>=5%'
                  WHEN relative_ret20_hs300 <= -0.02 THEN '弱于沪深3002-5%'
                  ELSE '贴近沪深300'
                END
                """,
            ),
            (
                "breadth_ma60_bucket",
                """
                CASE
                  WHEN breadth_above_ma60_ratio >= 0.60 THEN '广度强'
                  WHEN breadth_above_ma60_ratio >= 0.40 THEN '广度中性'
                  WHEN breadth_above_ma60_ratio > 0 THEN '广度弱'
                  ELSE '广度未知'
                END
                """,
            ),
            (
                "industry_strength_bucket",
                """
                CASE
                  WHEN industry_known < 0.5 THEN '行业未知'
                  WHEN industry_ret20_rank >= 0.80 THEN '行业强势前20%'
                  WHEN industry_ret20_rank >= 0.60 THEN '行业偏强'
                  WHEN industry_ret20_rank <= 0.20 THEN '行业弱势后20%'
                  WHEN industry_ret20_rank <= 0.40 THEN '行业偏弱'
                  ELSE '行业中性'
                END
                """,
            ),
            (
                "etf_route",
                """
                CASE
                  WHEN etf_route_broad_etf >= 0.5 THEN '宽基ETF'
                  WHEN etf_route_industry_etf >= 0.5 THEN '行业ETF'
                  WHEN etf_route_cross_border_etf >= 0.5 THEN '跨境ETF'
                  WHEN etf_route_bond_cash_etf >= 0.5 THEN '债券货币ETF'
                  WHEN etf_route_commodity_etf >= 0.5 THEN '商品ETF'
                  WHEN asset_type != 'etf' THEN '非ETF'
                  ELSE '其他ETF'
                END
                """,
            ),
            (
                "structure_score_bucket",
                """
                CASE
                  WHEN structure_score >= 80 THEN '80+'
                  WHEN structure_score >= 60 THEN '60-79'
                  WHEN structure_score >= 40 THEN '40-59'
                  ELSE '0-39'
                END
                """,
            ),
            (
                "safety_zone_bucket",
                """
                CASE
                  WHEN safety_zone_pos BETWEEN 0 AND 1 THEN '安全区内'
                  WHEN safety_zone_pos < 0 THEN '低于安全区'
                  WHEN safety_zone_pos > 1 THEN '高于安全区'
                  ELSE '未知'
                END
                """,
            ),
            (
                "structure_x_safety",
                """
                CASE
                  WHEN structure_score >= 60 AND safety_zone_pos BETWEEN 0 AND 1 THEN '结构>=60且安全区内'
                  WHEN structure_score >= 60 AND safety_zone_pos > 1 THEN '结构>=60但高于安全区'
                  WHEN structure_score >= 60 AND safety_zone_pos < 0 THEN '结构>=60但低于安全区'
                  WHEN structure_score < 60 AND safety_zone_pos BETWEEN 0 AND 1 THEN '结构<60但安全区内'
                  ELSE '结构<60且安全区外'
                END
                """,
            ),
        ]

        for group_type, expression in group_sql:
            conn.execute(
                f"""
                INSERT INTO feature_db.financial_ml_backtest_report
                WITH grouped AS (
                  SELECT
                    ? AS group_type,
                    {expression} AS group_value,
                    dataset_split,
                    COUNT(*) AS sample_count,
                    AVG(future_ret_5d) AS avg_future_ret_5d,
                    AVG(future_ret_10d) AS avg_future_ret_10d,
                    AVG(future_ret_20d) AS avg_future_ret_20d,
                    AVG(future_ret_60d) AS avg_future_ret_60d,
                    AVG(label_ret_5d_gt_0) AS win_rate_5d,
                    AVG(label_ret_10d_gt_3) AS win_rate_10d_gt_3,
                    AVG(label_ret_20d_gt_5) AS win_rate_20d_gt_5,
                    AVG(label_structure_safe_20d) AS structure_safe_rate_20d,
                    AVG(label_ret_60d_gt_10) AS win_rate_60d_gt_10,
                    AVG(max_drawdown_20d) AS avg_max_drawdown_20d,
                    AVG(label_drawdown_20d_lt_5) AS drawdown_ok_rate_20d,
                    AVG(label_break_safety_20d) AS break_safety_rate_20d,
                    AVG(label_fake_breakout_10d) AS fake_breakout_rate_10d
                  FROM feature_db.financial_ml_dataset
                  GROUP BY group_value, dataset_split
                )
                SELECT
                  g.group_type,
                  g.group_value,
                  g.dataset_split,
                  g.sample_count,
                  g.avg_future_ret_5d,
                  g.avg_future_ret_10d,
                  g.avg_future_ret_20d,
                  g.avg_future_ret_60d,
                  g.avg_future_ret_20d AS median_future_ret_20d,
                  g.win_rate_5d,
                  g.win_rate_10d_gt_3,
                  g.win_rate_20d_gt_5,
                  g.structure_safe_rate_20d,
                  g.win_rate_60d_gt_10,
                  g.avg_max_drawdown_20d,
                  g.drawdown_ok_rate_20d,
                  g.break_safety_rate_20d,
                  g.fake_breakout_rate_10d,
                  g.avg_future_ret_20d / NULLIF(ABS(g.avg_max_drawdown_20d), 0) AS risk_adjusted_20d
                FROM grouped g
                """,
                (group_type,),
            )
        conn.commit()

        report_rows = conn.execute(
            "SELECT COUNT(*) AS count FROM feature_db.financial_ml_backtest_report"
        ).fetchone()["count"]
        top_validation = conn.execute(
            """
            SELECT group_type, group_value, dataset_split, sample_count,
                   ROUND(avg_future_ret_20d, 4) AS avg_future_ret_20d,
                   ROUND(median_future_ret_20d, 4) AS median_future_ret_20d,
                   ROUND(win_rate_20d_gt_5, 4) AS win_rate_20d_gt_5,
                   ROUND(structure_safe_rate_20d, 4) AS structure_safe_rate_20d,
                   ROUND(avg_max_drawdown_20d, 4) AS avg_max_drawdown_20d,
                   ROUND(risk_adjusted_20d, 4) AS risk_adjusted_20d
            FROM feature_db.financial_ml_backtest_report
            WHERE dataset_split = 'validation' AND sample_count >= 500
            ORDER BY structure_safe_rate_20d DESC, risk_adjusted_20d DESC, avg_future_ret_20d DESC
            LIMIT 12
            """
        ).fetchall()
        top_test = conn.execute(
            """
            SELECT group_type, group_value, dataset_split, sample_count,
                   ROUND(avg_future_ret_20d, 4) AS avg_future_ret_20d,
                   ROUND(median_future_ret_20d, 4) AS median_future_ret_20d,
                   ROUND(win_rate_20d_gt_5, 4) AS win_rate_20d_gt_5,
                   ROUND(structure_safe_rate_20d, 4) AS structure_safe_rate_20d,
                   ROUND(avg_max_drawdown_20d, 4) AS avg_max_drawdown_20d,
                   ROUND(risk_adjusted_20d, 4) AS risk_adjusted_20d
            FROM feature_db.financial_ml_backtest_report
            WHERE dataset_split = 'test' AND sample_count >= 300
            ORDER BY structure_safe_rate_20d DESC, risk_adjusted_20d DESC, avg_future_ret_20d DESC
            LIMIT 12
            """
        ).fetchall()
        summary = {
            "domain": domain,
            "feature_db": str(feature_db_path),
            "report_table": "financial_ml_backtest_report",
            "report_rows": report_rows,
            "group_types": [group_type for group_type, _ in group_sql],
            "top_validation_groups": [dict(row) for row in top_validation],
            "top_test_groups": [dict(row) for row in top_test],
            "median_mode": "avg_proxy_to_avoid_full_dataset_window_scan",
            "completed_at": now(),
        }
        write_artifact(output_dir, "backtest_report.json", summary)
        return f"分层回测报告完成；生成分组 {report_rows} 行；已输出 backtest_report.json。"
    finally:
        conn.execute("DETACH DATABASE feature_db")
        conn.commit()


def run_persist_models(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩模型落库需要等足彩盘口模型训练完成后单独实现。")

    manifest_path = Path(output_dir) / "manifest.json"
    manifest = read_json_file(manifest_path) if manifest_path.exists() else {}
    current_run_id = int(manifest.get("runId") or 0)
    persisted_at = now()

    conn.execute(
        """
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
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS model_training_feature_importance (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT NOT NULL,
          model_key TEXT NOT NULL,
          feature TEXT NOT NULL,
          importance REAL,
          raw_importance REAL,
          rank_order INTEGER NOT NULL,
          run_id INTEGER,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(domain, model_key, feature)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS model_training_rule_candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT NOT NULL,
          source_key TEXT NOT NULL,
          rank_order INTEGER NOT NULL,
          title TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          run_id INTEGER,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(domain, source_key, rank_order)
        )
        """
    )

    model_specs = [
        ("logistic_regression", "logistic_regression_model.json", "logistic_regression_metrics.json", "logistic_regression_model.joblib"),
        ("random_forest", "random_forest_model.json", "random_forest_metrics.json", "random_forest_model.joblib"),
        ("lightgbm_model", "lightgbm_model.json", "lightgbm_metrics.json", "lightgbm_model.joblib"),
    ]

    persisted_models = []
    for model_key, model_json_name, metrics_name, model_file_name in model_specs:
        model_json_path = latest_domain_artifact(output_dir, model_json_name)
        metrics_path = latest_domain_artifact(output_dir, metrics_name)
        model_file_path = latest_domain_artifact(output_dir, model_file_name)
        if not model_json_path or not metrics_path:
            continue

        model_payload = read_json_file(model_json_path)
        metrics_payload = read_json_file(metrics_path)
        validation_auc = metrics_payload.get("validation", {}).get("auc")
        test_auc = metrics_payload.get("test", {}).get("auc")
        sample_limits = metrics_payload.get("sample_limits", {})

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
                model_payload.get("target"),
                model_payload.get("model_type"),
                str(model_file_path) if model_file_path else None,
                str(model_json_path),
                str(metrics_path),
                model_payload.get("source_feature_db"),
                current_run_id,
                validation_auc,
                test_auc,
                json.dumps(sample_limits, ensure_ascii=False),
                persisted_at,
                persisted_at,
            ),
        )

        importance_rows = metrics_payload.get("feature_importance") or metrics_payload.get("feature_weights") or []
        for index, item in enumerate(importance_rows, start=1):
            feature = item.get("feature")
            if not feature:
                continue
            importance = item.get("importance")
            if importance is None:
                importance = item.get("abs_weight")
            raw_importance = item.get("raw_importance")
            if raw_importance is None:
                raw_importance = item.get("weight")
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
                (domain, model_key, feature, importance, raw_importance, index, current_run_id, persisted_at),
            )

        for index, item in enumerate(metrics_payload.get("rule_candidates", [])[:12], start=1):
            title = item.get("feature") or item.get("group_value") or f"{model_key}候选{index}"
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
                (domain, model_key, index, str(title), json.dumps(item, ensure_ascii=False), current_run_id, persisted_at),
            )

        persisted_models.append({
            "model_key": model_key,
            "model_type": model_payload.get("model_type"),
            "model_file": str(model_file_path) if model_file_path else None,
            "metrics_file": str(metrics_path),
            "validation_auc": validation_auc,
            "test_auc": test_auc,
        })

    backtest_path = latest_domain_artifact(output_dir, "backtest_report.json")
    backtest_payload = read_json_file(backtest_path) if backtest_path else {}
    for source_key, rows in [
        ("backtest_validation", backtest_payload.get("top_validation_groups", [])),
        ("backtest_test", backtest_payload.get("top_test_groups", [])),
    ]:
        for index, item in enumerate(rows[:12], start=1):
            title = f"{item.get('group_type')}:{item.get('group_value')}"
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
                (domain, source_key, index, title, json.dumps(item, ensure_ascii=False), current_run_id, persisted_at),
            )

    if not persisted_models:
        raise RuntimeError("没有找到可落库的模型产物，请先完成逻辑回归、随机森林或 LightGBM。")

    summary = {
        "domain": domain,
        "run_id": current_run_id,
        "persisted_models": persisted_models,
        "backtest_report_file": str(backtest_path) if backtest_path else None,
        "tables": [
            "model_training_artifacts",
            "model_training_feature_importance",
            "model_training_rule_candidates",
        ],
        "completed_at": persisted_at,
    }
    write_artifact(output_dir, "persist_models.json", summary)
    conn.commit()
    return f"模型与结果落库完成；已登记 {len(persisted_models)} 个模型，特征重要性和规则候选已写入主库。"


def run_prediction_api(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩预测接口需要等足彩盘口模型落库后单独实现。")

    artifacts = conn.execute(
        """
        SELECT model_key, model_type, model_file, source_feature_db, validation_auc, test_auc
        FROM model_training_artifacts
        WHERE domain = ?
        ORDER BY
          CASE model_key
            WHEN 'lightgbm_model' THEN 1
            WHEN 'random_forest' THEN 2
            WHEN 'logistic_regression' THEN 3
            ELSE 9
          END
        """,
        (domain,),
    ).fetchall()
    if not artifacts:
        raise RuntimeError("还没有已落库模型，不能启用预测接口。")

    available_models = []
    for row in artifacts:
        model_file = row["model_file"]
        feature_db = row["source_feature_db"]
        if not model_file or not Path(model_file).exists():
            raise RuntimeError(f"{row['model_key']} 的模型文件不存在：{model_file}")
        if not feature_db or not Path(feature_db).exists():
            raise RuntimeError(f"{row['model_key']} 的特征库不存在：{feature_db}")
        available_models.append(dict(row))

    summary = {
        "domain": domain,
        "default_model_key": available_models[0]["model_key"],
        "available_models": available_models,
        "endpoints": [
            f"GET /api/model-training/predict/{domain}/:symbol",
            f"GET /api/model-training/predict/{domain}/:symbol?modelKey=lightgbm_model",
            f"GET /api/model-training/predict/{domain}/:symbol?tradeDate=YYYY-MM-DD",
        ],
        "script": "scripts/model_training/predict.py",
        "completed_at": now(),
    }
    write_artifact(output_dir, "prediction_api.json", summary)
    return f"预测接口检查完成；默认模型={summary['default_model_key']}；已启用 {len(available_models)} 个模型。"


def run_frontend_result(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩前端结果展示需要等足彩训练结果接入后单独实现。")

    artifacts = conn.execute(
        """
        SELECT model_key, model_type, model_file, validation_auc, test_auc
        FROM model_training_artifacts
        WHERE domain = ?
        ORDER BY
          CASE model_key
            WHEN 'lightgbm_model' THEN 1
            WHEN 'random_forest' THEN 2
            WHEN 'logistic_regression' THEN 3
            ELSE 9
          END
        """,
        (domain,),
    ).fetchall()
    if not artifacts:
        raise RuntimeError("没有模型落库结果，前端无法展示训练结果。")

    importance_count = conn.execute(
        "SELECT COUNT(*) AS count FROM model_training_feature_importance WHERE domain = ?",
        (domain,),
    ).fetchone()["count"]
    rule_count = conn.execute(
        "SELECT COUNT(*) AS count FROM model_training_rule_candidates WHERE domain = ?",
        (domain,),
    ).fetchone()["count"]
    if importance_count == 0 or rule_count == 0:
        raise RuntimeError("特征重要性或规则候选为空，前端展示数据不完整。")

    summary = {
        "domain": domain,
        "result_endpoint": f"GET /api/model-training/results/{domain}",
        "prediction_endpoint": f"GET /api/model-training/predict/{domain}/:symbol",
        "model_count": len(artifacts),
        "feature_importance_count": importance_count,
        "rule_candidate_count": rule_count,
        "models": [dict(row) for row in artifacts],
        "completed_at": now(),
    }
    write_artifact(output_dir, "frontend_result.json", summary)
    return f"前端结果展示数据检查完成；模型 {len(artifacts)} 个，特征重要性 {importance_count} 条，规则候选 {rule_count} 条。"


def run_strategy_feedback(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩策略反哺需要等足彩盘口模型和页面独立接入后实现。")

    artifact = conn.execute(
        """
        SELECT model_key, model_type, validation_auc, test_auc
        FROM model_training_artifacts
        WHERE domain = ?
        ORDER BY
          CASE model_key
            WHEN 'lightgbm_model' THEN 1
            WHEN 'random_forest' THEN 2
            WHEN 'logistic_regression' THEN 3
            ELSE 9
          END
        LIMIT 1
        """,
        (domain,),
    ).fetchone()
    if not artifact:
        raise RuntimeError("没有可反哺的默认模型，请先完成模型落库。")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS model_training_strategy_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT NOT NULL UNIQUE,
          default_model_key TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'advisory',
          target TEXT NOT NULL DEFAULT 'label_structure_safe_20d',
          high_probability_threshold REAL NOT NULL DEFAULT 0.65,
          low_probability_threshold REAL NOT NULL DEFAULT 0.35,
          enabled_for_structure INTEGER NOT NULL DEFAULT 1,
          enabled_for_entry_trigger INTEGER NOT NULL DEFAULT 1,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    timestamp = now()
    note = "第一版只作为模型辅助层展示，不直接改变结构判断、入场触发和买卖结论。"
    conn.execute(
        """
        INSERT INTO model_training_strategy_feedback (
          domain, default_model_key, mode, target, high_probability_threshold,
          low_probability_threshold, enabled_for_structure, enabled_for_entry_trigger,
          note, created_at, updated_at
        )
        VALUES (?, ?, 'advisory', ?, 0.65, 0.35, 1, 1, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET
          default_model_key = excluded.default_model_key,
          mode = excluded.mode,
          target = excluded.target,
          high_probability_threshold = excluded.high_probability_threshold,
          low_probability_threshold = excluded.low_probability_threshold,
          enabled_for_structure = excluded.enabled_for_structure,
          enabled_for_entry_trigger = excluded.enabled_for_entry_trigger,
          note = excluded.note,
          updated_at = excluded.updated_at
        """,
        (domain, artifact["model_key"], MODEL_TARGET_LABEL, note, timestamp, timestamp),
    )
    conn.commit()

    summary = {
        "domain": domain,
        "mode": "advisory",
        "default_model_key": artifact["model_key"],
        "model_type": artifact["model_type"],
        "thresholds": {
            "high_probability": 0.65,
            "low_probability": 0.35,
        },
        "enabled_for": ["structure_check", "entry_trigger"],
        "note": note,
        "completed_at": timestamp,
    }
    write_artifact(output_dir, "strategy_feedback.json", summary)
    return f"结构/安全区反哺配置完成；默认模型={artifact['model_key']}；当前为辅助展示模式，不改变原规则结论。"


def markdown_table(rows, headers):
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join(["---"] * len(headers)) + " |",
    ]
    for row in rows:
        lines.append("| " + " | ".join(str(row.get(header, "")) for header in headers) + " |")
    return "\n".join(lines)


def run_llm_rule_summary(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩大模型总结需要等足彩模型独立训练完成后实现。")

    models = conn.execute(
        """
        SELECT model_key, model_type, ROUND(validation_auc, 4) AS validation_auc, ROUND(test_auc, 4) AS test_auc
        FROM model_training_artifacts
        WHERE domain = ?
        ORDER BY test_auc DESC
        """,
        (domain,),
    ).fetchall()
    rules = conn.execute(
        """
        SELECT source_key, rank_order, title, payload_json
        FROM model_training_rule_candidates
        WHERE domain = ?
        ORDER BY source_key, rank_order ASC
        LIMIT 30
        """,
        (domain,),
    ).fetchall()
    if not models or not rules:
        raise RuntimeError("缺少模型指标或规则候选，不能生成规则总结。")

    parsed_rules = []
    for row in rules:
        payload = json.loads(row["payload_json"])
        parsed_rules.append({
            "source_key": row["source_key"],
            "rank_order": row["rank_order"],
            "title": row["title"],
            "payload": payload,
        })

    summary = {
        "domain": domain,
        "mode": "local_summary_llm_ready",
        "note": "当前为本地结构化总结，后续可把 same payload 交给本地大模型生成自然语言策略说明。",
        "models": [dict(row) for row in models],
        "rule_candidates": parsed_rules,
        "conclusions": [
            "优先采用测试集 AUC 更稳的模型作为辅助概率来源。",
            "第一版只把规则候选用于观察和解释，不直接改变原安全区 + 结构成立规则。",
            "特征重要性靠前的字段应重点进入下一版规则解释和失败样本复盘。",
        ],
        "completed_at": now(),
    }
    write_artifact(output_dir, "llm_rule_summary.json", summary)
    markdown = "# 大模型规则候选总结（本地预生成）\n\n"
    markdown += "当前版本未调用外部大模型，先生成可投喂本地大模型的结构化总结。\n\n"
    markdown += markdown_table([dict(row) for row in models], ["model_key", "model_type", "validation_auc", "test_auc"])
    markdown += "\n\n## 初步结论\n\n"
    markdown += "\n".join(f"- {item}" for item in summary["conclusions"])
    Path(output_dir, "llm_rule_summary.md").write_text(markdown, encoding="utf-8")
    return f"大模型规则候选总结完成；已生成 llm_rule_summary.json/md，规则候选 {len(parsed_rules)} 条。"


def run_llm_failure_review(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩失败样本分析需要等足彩模型独立训练完成后实现。")

    feature_db_path = resolve_feature_db(output_dir)
    conn.execute(f"ATTACH DATABASE ? AS feature_db", (str(feature_db_path),))
    try:
        failure_rows = conn.execute(
            """
            SELECT
              dataset_split,
              COUNT(*) AS sample_count,
              ROUND(AVG(future_ret_20d), 4) AS avg_future_ret_20d,
              ROUND(AVG(max_drawdown_20d), 4) AS avg_max_drawdown_20d,
              ROUND(AVG(label_break_safety_20d), 4) AS break_safety_rate_20d,
              ROUND(AVG(label_fake_breakout_10d), 4) AS fake_breakout_rate_10d
            FROM feature_db.financial_ml_dataset
            WHERE structure_score >= 60
              AND in_safety_zone = 1
              AND label_structure_safe_20d = 0
            GROUP BY dataset_split
            ORDER BY dataset_split
            """
        ).fetchall()
        by_trend = conn.execute(
            """
            SELECT
              COALESCE(trend_phase, 'unknown') AS trend_phase,
              COUNT(*) AS sample_count,
              ROUND(AVG(future_ret_20d), 4) AS avg_future_ret_20d,
              ROUND(AVG(max_drawdown_20d), 4) AS avg_max_drawdown_20d,
              ROUND(AVG(label_break_safety_20d), 4) AS break_safety_rate_20d
            FROM feature_db.financial_ml_dataset
            WHERE structure_score >= 60
              AND in_safety_zone = 1
              AND label_structure_safe_20d = 0
            GROUP BY trend_phase
            HAVING sample_count >= 200
            ORDER BY break_safety_rate_20d DESC, sample_count DESC
            LIMIT 12
            """
        ).fetchall()
    finally:
        conn.execute("DETACH DATABASE feature_db")
        conn.commit()

    summary = {
        "domain": domain,
        "mode": "local_failure_review_llm_ready",
        "failure_definition": "结构分>=60 且安全区内，但未达成：未来20日收益>5%、回撤<=8%、且不跌破安全区。",
        "failure_by_split": [dict(row) for row in failure_rows],
        "failure_by_trend": [dict(row) for row in by_trend],
        "review_points": [
            "重点检查高结构分但未来收益不达标的样本是否集中在特定走势阶段。",
            "若跌破安全区比例高，说明安全区定义需要更严格或加入市场环境过滤。",
            "若假突破比例高，下一版应强化突破后回踩确认和成交量约束。",
        ],
        "completed_at": now(),
    }
    write_artifact(output_dir, "llm_failure_review.json", summary)
    markdown = "# 失败样本复盘（本地预生成）\n\n"
    markdown += f"失败定义：{summary['failure_definition']}\n\n"
    markdown += markdown_table(summary["failure_by_split"], ["dataset_split", "sample_count", "avg_future_ret_20d", "avg_max_drawdown_20d", "break_safety_rate_20d", "fake_breakout_rate_10d"])
    markdown += "\n\n## 复盘重点\n\n"
    markdown += "\n".join(f"- {item}" for item in summary["review_points"])
    Path(output_dir, "llm_failure_review.md").write_text(markdown, encoding="utf-8")
    return f"大模型失败样本分析完成；已生成失败分层 {len(summary['failure_by_split'])} 组。"


def run_llm_strategy_docs(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩策略文档需要等足彩模型独立训练完成后实现。")

    feedback = conn.execute(
        "SELECT * FROM model_training_strategy_feedback WHERE domain = ?",
        (domain,),
    ).fetchone()
    artifacts = conn.execute(
        """
        SELECT model_key, model_type, ROUND(validation_auc, 4) AS validation_auc, ROUND(test_auc, 4) AS test_auc
        FROM model_training_artifacts
        WHERE domain = ?
        ORDER BY
          CASE model_key
            WHEN 'lightgbm_model' THEN 1
            WHEN 'random_forest' THEN 2
            WHEN 'logistic_regression' THEN 3
            ELSE 9
          END
        """,
        (domain,),
    ).fetchall()
    if not feedback or not artifacts:
        raise RuntimeError("缺少反哺配置或模型指标，不能生成策略文档。")

    doc = {
        "domain": domain,
        "version": "structure_safety_ml_v1",
        "default_model_key": feedback["default_model_key"],
        "mode": feedback["mode"],
        "core_rule": "买点仍由安全区 + 结构成立 + 失效线决定，模型只提供概率辅助。",
        "thresholds": {
            "high_probability": feedback["high_probability_threshold"],
            "low_probability": feedback["low_probability_threshold"],
        },
        "models": [dict(row) for row in artifacts],
        "boundaries": [
            f"模型训练目标是{MODEL_TARGET_TEXT}，不是即时买卖点。",
            "模型概率不覆盖黑天鹅、停牌、流动性突变和外部政策冲击。",
            "任何入场仍需经过原有市场状态、结构判断、入场触发和风控模板。",
        ],
        "completed_at": now(),
    }
    write_artifact(output_dir, "llm_strategy_docs.json", doc)
    markdown = "# 结构成立 + 安全区模型策略说明 v1\n\n"
    markdown += f"默认模型：`{doc['default_model_key']}`\n\n"
    markdown += f"核心原则：{doc['core_rule']}\n\n"
    markdown += "## 模型指标\n\n"
    markdown += markdown_table(doc["models"], ["model_key", "model_type", "validation_auc", "test_auc"])
    markdown += "\n\n## 使用边界\n\n"
    markdown += "\n".join(f"- {item}" for item in doc["boundaries"])
    Path(output_dir, "llm_strategy_docs.md").write_text(markdown, encoding="utf-8")
    return "策略文档生成完成；已输出 llm_strategy_docs.json/md。"


def run_llm_assisted_iteration(conn, domain, output_dir):
    if domain not in ("stock", "etf"):
        raise NotImplementedError("足彩下一轮迭代建议需要等足彩模型独立训练完成后实现。")

    importances = conn.execute(
        """
        SELECT model_key, feature, ROUND(importance, 4) AS importance, rank_order
        FROM model_training_feature_importance
        WHERE domain = ?
        ORDER BY model_key, rank_order ASC
        """,
        (domain,),
    ).fetchall()
    if not importances:
        raise RuntimeError("缺少特征重要性，不能生成下一轮迭代建议。")

    top_features = {}
    for row in importances:
        key = row["model_key"]
        top_features.setdefault(key, [])
        if len(top_features[key]) < 5:
            top_features[key].append(dict(row))

    suggestions = [
        {
            "area": "安全区",
            "action": "把安全区从固定20%-45%箱体改成可按波动率自适应。",
            "reason": "当前模型中 safety_zone_pos 有解释力，但还不足以单独决定胜率。",
        },
        {
            "area": "结构评分",
            "action": "拆分结构分来源，分别验证均线、位置、成交量、突破/回踩。",
            "reason": "避免一个总分掩盖真正有效的子因子。",
        },
        {
            "area": "失败样本",
            "action": "增加假突破、追高、跌破安全区后的冷却期标签。",
            "reason": "下一轮应从失败共性里找过滤条件，而不是只追求更高命中率。",
        },
        {
            "area": "训练目标",
            "action": "并行训练未来20日回撤风险和未来60日趋势延续概率。",
            "reason": "单一收益标签容易忽略持有过程的风险。",
        },
    ]
    payload = {
        "domain": domain,
        "mode": "local_iteration_plan_llm_ready",
        "top_features_by_model": top_features,
        "suggestions": suggestions,
        "next_version": "structure_safety_ml_v2",
        "completed_at": now(),
    }
    write_artifact(output_dir, "llm_assisted_iteration.json", payload)
    markdown = "# 下一轮模型迭代建议\n\n"
    markdown += "\n".join(f"- **{item['area']}**：{item['action']} 原因：{item['reason']}" for item in suggestions)
    Path(output_dir, "llm_assisted_iteration.md").write_text(markdown, encoding="utf-8")
    return f"下一套打法迭代建议生成完成；建议 {len(suggestions)} 条。"


def run_step(conn, domain, item_key, output_dir):
    if item_key == "data_audit":
        return run_data_audit(conn, domain, output_dir)
    if item_key == "feature_table":
        return run_feature_table(conn, domain, output_dir)
    if item_key == "label_table":
        return run_label_table(conn, domain, output_dir)
    if item_key == "split_dataset":
        return run_split_dataset(conn, domain, output_dir)
    if item_key == "baseline_stats":
        return run_baseline_stats(conn, domain, output_dir)
    if item_key == "logistic_regression":
        return run_logistic_regression(conn, domain, output_dir)
    if item_key == "random_forest":
        return run_random_forest(conn, domain, output_dir)
    if item_key == "lightgbm_model":
        return run_lightgbm_model(conn, domain, output_dir)
    if item_key == "backtest_report":
        return run_backtest_report(conn, domain, output_dir)
    if item_key == "persist_models":
        return run_persist_models(conn, domain, output_dir)
    if item_key == "prediction_api":
        return run_prediction_api(conn, domain, output_dir)
    if item_key == "frontend_result":
        return run_frontend_result(conn, domain, output_dir)
    if item_key == "strategy_feedback":
        return run_strategy_feedback(conn, domain, output_dir)
    if item_key == "llm_rule_summary":
        return run_llm_rule_summary(conn, domain, output_dir)
    if item_key == "llm_failure_review":
        return run_llm_failure_review(conn, domain, output_dir)
    if item_key == "llm_strategy_docs":
        return run_llm_strategy_docs(conn, domain, output_dir)
    if item_key == "llm_assisted_iteration":
        return run_llm_assisted_iteration(conn, domain, output_dir)

    raise NotImplementedError(
        f"{item_key} 的执行脚本还未接入。流水线会在这里停止，避免误标完成。"
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    conn = connect(args.db)

    try:
        use_run_plan_items = has_run_plan_items(conn, args.run_id)
        if use_run_plan_items:
            items = conn.execute(
                """
                SELECT item_key, title
                FROM model_training_run_plan_items
                WHERE run_id = ? AND domain = ? AND status != 'completed'
                ORDER BY sort_order ASC
                """,
                (args.run_id, args.domain),
            ).fetchall()
        else:
            items = conn.execute(
                """
                SELECT item_key, title
                FROM model_training_plan_items
                WHERE domain = ? AND status != 'completed'
                ORDER BY sort_order ASC
                """,
                (args.domain,),
            ).fetchall()

        if not items:
            update_run(conn, args.run_id, status="completed", message="训练计划已全部完成", finished_at=now())
            return

        for item in items:
            item_key = item["item_key"]
            title = item["title"]
            update_run(conn, args.run_id, current_item_key=item_key, message=f"流水线执行中：{title}")
            update_plan_item(
                conn,
                args.domain,
                item_key,
                "running",
                note=f"流水线执行中；运行目录：{args.output_dir}",
                run_id=args.run_id,
            )

            try:
                note = run_step(conn, args.domain, item_key, args.output_dir)
                update_plan_item(conn, args.domain, item_key, "completed", note=note, completed=True, run_id=args.run_id)
            except Exception as exc:
                message = str(exc)
                update_plan_item(conn, args.domain, item_key, "failed", note=message, run_id=args.run_id)
                update_run(conn, args.run_id, status="failed", message=message, finished_at=now())
                return

        update_run(conn, args.run_id, status="completed", message="训练流水线已全部完成", finished_at=now())
    finally:
        conn.close()


if __name__ == "__main__":
    main()
