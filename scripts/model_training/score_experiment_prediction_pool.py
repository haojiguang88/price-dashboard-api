#!/usr/bin/env python3
import argparse
import json
import math
from pathlib import Path

import joblib

from score_capital_rotation import (
    action_label,
    adjust_hardness_for_acceptance_discipline,
    artifact_payload,
    crowding_label,
    model_features,
    pick_artifact,
    predict_probability,
    round_or_none,
    safe_float,
)
from train_experiment_models import (
    EXPERIMENTS,
    avg_close,
    build_supplemental_indexes,
    chunked,
    connect,
    latest_price_date,
    load_market_prices,
    load_price_lookup,
    load_supplemental_lookup,
    market_regime_for_date,
    market_return_for_date,
    pick_industry_mapping,
    row_features,
    select_available,
    table_exists,
)


def pct(value):
    numeric = safe_float(value, None)
    if numeric is None:
        return None
    return round(numeric * 100, 2)


def safe_round(value, digits=2):
    numeric = safe_float(value, None)
    if numeric is None:
        return None
    return round(numeric, digits)


def ratio_multiple(value):
    numeric = safe_float(value, None)
    if numeric is None:
        return None
    return round(1 + numeric, 2)


def index_at_or_before(prices, trade_date):
    selected = None
    for index, item in enumerate(prices):
        if item["trade_date"] <= trade_date:
            selected = index
        else:
            break
    return selected


def replay_window_bounds(as_of_date, horizon_days):
    # Keep enough history for 250-day structure features and enough future for labels.
    return f"date('{as_of_date}', '-900 days')", f"date('{as_of_date}', '+{max(120, horizon_days * 4)} days')"


def load_price_lookup_window(conn, candidates, as_of_date, horizon_days):
    start_expr, end_expr = replay_window_bounds(as_of_date, horizon_days)
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
                  AND trade_date BETWEEN {start_expr} AND {end_expr}
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


def load_supplemental_lookup_window(conn, candidates, as_of_date, horizon_days):
    start_expr, end_expr = replay_window_bounds(as_of_date, horizon_days)
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
            f"""
            SELECT trade_date, up_ratio, down_ratio, limit_up_ratio, limit_down_ratio,
                   above_ma20_ratio, above_ma60_ratio, above_ma120_ratio,
                   amount_ratio_5_20
            FROM financial_market_breadth_daily
            WHERE source = 'tushare'
              AND market_universe = 'stock_tushare'
              AND trade_date BETWEEN {start_expr} AND {end_expr}
            """
        ).fetchall()
        for row in rows:
            item = dict(row)
            data["market_breadth"][item["trade_date"]] = item

    if stock_symbols:
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
                          AND trade_date BETWEEN {start_expr} AND {end_expr}
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
                      AND trade_date BETWEEN {start_expr} AND {end_expr}
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
                      AND trade_date BETWEEN {start_expr} AND {end_expr}
                    """,
                    chunk,
                ).fetchall()
                for row in rows:
                    item = dict(row)
                    key = (item["symbol"], item.get("source") or "tushare", item["trade_date"])
                    data["limit"].setdefault(key, []).append(item)

    if stock_symbols and table_exists(conn, "financial_sw_industry_members"):
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
            if item["symbol"] in stock_symbols and pick_industry_mapping(item, as_of_date):
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
                  AND trade_date BETWEEN {start_expr} AND {end_expr}
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
                base = prices[index - 20]["close"]
                value = prices[index]["close"] / base - 1 if base else 0.0
                returns_by_date.setdefault(prices[index]["trade_date"], []).append((code, value))
        for trade_date, values in returns_by_date.items():
            if len(values) < 2:
                continue
            ordered = sorted(values, key=lambda item: item[1])
            denominator = len(ordered) - 1
            for rank, (code, _value) in enumerate(ordered):
                data["industry_ret20_rank"][(code, trade_date)] = rank / denominator

    return build_supplemental_indexes(data)


def return_at(base_close, future_prices, days):
    if len(future_prices) < days or not base_close:
        return None
    return future_prices[days - 1]["close"] / base_close - 1


def max_future_return(base_close, future_prices):
    if not future_prices or not base_close:
        return None
    return max(item["close"] / base_close - 1 for item in future_prices)


def max_future_drawdown(base_close, future_prices):
    if not future_prices or not base_close:
        return None
    return min(item["close"] / base_close - 1 for item in future_prices)


def drawdown_discipline_floor(market_regime):
    regime = str(market_regime or "").upper()
    if "RISK" in regime:
        return -0.06
    if "CRASH" in regime:
        return -0.08
    return -0.08


def direction_outcome(key, label_status, forward_return_20d, max_return, max_drawdown, market_regime=None):
    if label_status == "pending":
        return "待观察"
    threshold = EXPERIMENTS[key].get("positive_threshold", 0.06)
    drawdown_floor = drawdown_discipline_floor(market_regime)
    if max_return is not None and max_return >= threshold:
        return "方向兑现"
    if max_drawdown is not None and max_drawdown <= drawdown_floor:
        return "方向失败"
    if label_status == "partial":
        return "观察中"
    if forward_return_20d is not None and forward_return_20d > 0:
        return "小幅兑现"
    return "未兑现"


def hardness_outcome(label_status, max_return, max_drawdown, market_regime=None):
    if label_status == "pending":
        return "待观察"
    regime = str(market_regime or "").upper()
    drawdown_floor = drawdown_discipline_floor(market_regime)
    if max_drawdown is not None and max_drawdown <= drawdown_floor:
        if "RISK" in regime:
            return "风险区承接破坏"
        if "CRASH" in regime:
            return "冻结区回撤打穿"
        return "承接破坏"
    if max_drawdown is not None and max_drawdown <= -0.05:
        return "承接偏弱"
    if max_return is not None and max_return >= 0.05:
        return "承接有效"
    return "观察中" if label_status == "partial" else "承接一般"


def attach_future_outcome(item, prices, index, key, horizon_days):
    future_prices = prices[index + 1:index + 1 + horizon_days]
    available = len(future_prices)
    label_status = "complete" if available >= horizon_days else "partial" if available > 0 else "pending"
    base_close = safe_float(item.get("close"), None)
    forward_5 = return_at(base_close, future_prices, 5)
    forward_10 = return_at(base_close, future_prices, 10)
    forward_20 = return_at(base_close, future_prices, 20)
    max_return = max_future_return(base_close, future_prices)
    max_drawdown = max_future_drawdown(base_close, future_prices)
    market_regime = item.get("market_regime")
    drawdown_floor = drawdown_discipline_floor(market_regime)
    item["future_label"] = {
        "horizon_days": horizon_days,
        "available_future_days": available,
        "horizon_end_date": future_prices[min(available, horizon_days) - 1]["trade_date"] if available else None,
        "label_status": label_status,
        "forward_return_5d": pct(forward_5),
        "forward_return_10d": pct(forward_10),
        "forward_return_20d": pct(forward_20),
        "max_forward_return": pct(max_return),
        "max_drawdown": pct(max_drawdown),
        "drawdown_discipline_hit": bool(max_drawdown is not None and max_drawdown <= drawdown_floor),
        "direction_outcome": direction_outcome(key, label_status, forward_20, max_return, max_drawdown, market_regime),
        "hardness_outcome": hardness_outcome(label_status, max_return, max_drawdown, market_regime),
        "label_reason": (
            f"已满 {horizon_days} 个未来交易日"
            if label_status == "complete"
            else f"已有 {available}/{horizon_days} 个未来交易日，继续滚动"
            if available
            else "尚无未来交易日"
        ),
    }


def load_current_candidates(conn, key, config, latest_date, asset_type, candidate_limit):
    asset_types = [asset_type] if asset_type in config["asset_types"] else config["asset_types"]
    placeholders = ",".join("?" for _ in asset_types)
    rows = conn.execute(
        f"""
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
        trend_ranked AS (
          SELECT t.*,
            ROW_NUMBER() OVER (
              PARTITION BY t.symbol, t.asset_type, t.source
              ORDER BY t.trade_date DESC, t.rule_version DESC, t.id DESC
            ) AS rn
          FROM financial_trend_phase_results t
          WHERE t.asset_type IN ({placeholders})
            AND t.close IS NOT NULL
            AND t.close > 0
            AND t.trade_date <= ?
            AND t.trade_date >= date(?, '-15 days')
            {config["where"]}
        )
        SELECT t.symbol, COALESCE(u.name, t.symbol) AS name, t.asset_type, t.source,
          u.universe_type, t.trade_date, t.close, t.ma20, t.ma60, t.bias60, t.ret5,
          t.ret20, t.range20, t.cross60_10, t.trend_phase_code, t.trend_phase_reason
        FROM trend_ranked t
        LEFT JOIN universe_unique u
          ON u.symbol = t.symbol AND u.asset_type = t.asset_type AND u.source = t.source
        WHERE t.rn = 1
        ORDER BY t.trade_date DESC, ABS(COALESCE(t.ret20, 0)) DESC, t.symbol ASC
        LIMIT ?
        """,
        [*asset_types, latest_date, latest_date, candidate_limit],
    ).fetchall()
    candidates = []
    seen = set()
    for row in rows:
        item = dict(row)
        candidate_key = (item["symbol"], item["asset_type"], item["source"])
        if candidate_key in seen:
            continue
        seen.add(candidate_key)
        candidates.append(item)
    return candidates, asset_types


def rule_score(key, row, features, market_regime):
    ret5 = safe_float(features.get("ret5"))
    ret20 = safe_float(features.get("ret20"))
    range20 = safe_float(features.get("range20"))
    range60 = safe_float(features.get("range60"), range20)
    bias60 = safe_float(features.get("bias60"))
    amount_available = safe_float(features.get("amount_available"))
    trend = str(row.get("trend_phase_code") or "UNKNOWN").upper()
    trend_good = trend in {"BREAKOUT", "SLOW_GRIND_UP", "TREND_UP", "RECOVERY", "TREND_TRANSITION"}
    market_penalty = 18 if market_regime == "CRASH" else 8 if market_regime == "RISK" else 0

    if key == "elasticity-hardness":
        value = 52 + range20 * 180 + max(ret20, 0) * 55 - max(-ret20, 0) * 50 - max(-bias60, 0) * 45 - market_penalty
    elif key == "crash-recovery":
        value = 55 + max(-ret5, 0) * 220 + max(-ret20, 0) * 90 + (8 if bias60 > -0.08 else -8) + (8 if trend_good else 0) - market_penalty
    elif key == "signal-lifecycle":
        value = 50 + (18 if trend_good else -8) - abs(bias60) * 55 - safe_float(row.get("cross60_10")) * 2 + max(ret20, 0) * 45 - market_penalty
    elif key == "double-stock":
        value = 45 + max(ret20, 0) * 120 + range60 * 60 + (14 if trend_good else -6) + (6 if amount_available > 0 else 0) - market_penalty
    elif key == "capital-rotation":
        value = 48 + max(ret20, 0) * 130 + max(ret5, 0) * 80 + (16 if trend_good else -8) - market_penalty
    else:
        value = 50
    return int(round(max(0, min(100, value))))


def feature_label(key, row, features, score):
    ret5 = safe_float(features.get("ret5"))
    ret20 = safe_float(features.get("ret20"))
    range20 = safe_float(features.get("range20"))
    if key == "crash-recovery":
        if ret5 <= -0.08:
            return "急跌修复样本"
        if ret20 <= -0.15:
            return "深回撤修复样本"
        return "普通回撤样本"
    if key == "signal-lifecycle":
        if safe_float(row.get("cross60_10")) >= 3:
            return "扇脸高风险"
        if score >= 70:
            return "信号较稳定"
        return "复核观察"
    if key == "double-stock":
        if score >= 75:
            return "高弹性趋势胚子"
        return "普通潜力样本"
    if key == "capital-rotation":
        if ret5 > 0.03 and ret20 > 0.08:
            return "轮动加速"
        if ret20 > 0.03:
            return "轮动抬头"
        return "轮动观察"
    if range20 >= 0.18:
        return "高弹性"
    if score >= 70:
        return "弹性硬度均衡"
    return "普通波动"


def feature_snapshot(row, features, market_regime, market_returns):
    industry_known = safe_float(features.get("industry_known")) > 0
    sector_known = safe_float(features.get("sector_known")) > 0
    return {
        "trend_phase_code": row.get("trend_phase_code") or "UNKNOWN",
        "trend_phase_reason": row.get("trend_phase_reason") or "",
        "universe_type": row.get("universe_type") or "",
        "market_regime": market_regime,
        "market_ret20": pct(market_returns.get(20)),
        "breadth_up_ratio": pct(features.get("breadth_up_ratio")),
        "breadth_down_ratio": pct(features.get("breadth_down_ratio")),
        "breadth_above_ma60_ratio": pct(features.get("breadth_above_ma60_ratio")),
        "ret5": pct(features.get("ret5")),
        "ret20": pct(features.get("ret20")),
        "ret60": pct(features.get("ret60")),
        "ret120": pct(features.get("ret120")),
        "ret250": pct(features.get("ret250")),
        "range20": pct(features.get("range20")),
        "range60": pct(features.get("range60")),
        "range120": pct(features.get("range120")),
        "bias60": pct(features.get("bias60")),
        "distance_ma120": pct(features.get("distance_ma120")),
        "distance_ma250": pct(features.get("distance_ma250")),
        "price_pos120": pct(features.get("price_pos120")),
        "price_pos250": pct(features.get("price_pos250")),
        "cross60_10": safe_round(row.get("cross60_10"), 0) or 0,
        "avg_amount_20": None,
        "amount_ratio_5_20": ratio_multiple(features.get("amount_ratio_5_20")),
        "amount_ratio_20_60": ratio_multiple(features.get("amount_ratio_20_60")),
        "amount_available": 1 if safe_float(features.get("amount_available")) > 0 else 0,
        "industry_known": industry_known,
        "industry_code": None,
        "industry_name": None,
        "industry_ret20": pct(features.get("industry_ret20")) if industry_known else None,
        "industry_amount_ratio_5_20": ratio_multiple(features.get("industry_amount_ratio_5_20")) if industry_known else None,
        "industry_relative_ret20_hs300": pct(features.get("industry_relative_ret20_hs300")) if industry_known else None,
        "sector_known": sector_known,
        "sector_ret5": pct(features.get("sector_ret5")) if sector_known else None,
        "sector_ret20": pct(features.get("sector_ret20")) if sector_known else None,
        "sector_ret60": pct(features.get("sector_ret60")) if sector_known else None,
        "sector_amount_ratio_5_20": ratio_multiple(features.get("sector_amount_ratio_5_20")) if sector_known else None,
        "sector_relative_ret20_hs300": pct(features.get("sector_relative_ret20_hs300")) if sector_known else None,
        "asset_vs_sector_ret20": pct(features.get("asset_vs_sector_ret20")) if sector_known else None,
        "relative_ret20_hs300": pct(features.get("relative_ret20_hs300")),
        "relative_ret60_hs300": pct(features.get("relative_ret60_hs300")),
        "relative_ret120_hs300": pct(features.get("relative_ret120_hs300")),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--experiment", required=True, choices=list(EXPERIMENTS.keys()))
    parser.add_argument("--asset-type", default="")
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--as-of-date", default="")
    parser.add_argument("--include-outcomes", action="store_true")
    parser.add_argument("--horizon-days", type=int, default=20)
    args = parser.parse_args()

    conn = connect(args.db)
    try:
        config = EXPERIMENTS[args.experiment]
        limit = max(1, min(args.limit, 120))
        latest_date = args.as_of_date or latest_price_date(conn)
        horizon_days = max(5, min(args.horizon_days, 60))
        candidate_limit = max(limit * (6 if args.as_of_date else 16), 60 if args.as_of_date else 160)
        candidates, asset_types = load_current_candidates(
            conn,
            args.experiment,
            config,
            latest_date,
            args.asset_type,
            candidate_limit,
        )
        if not candidates:
            print(json.dumps({
                "success": True,
                "data": {
                    "meta": {
                        "key": args.experiment,
                        "title": config["title"],
                        "asset_types": asset_types,
                        "latest_price_date": latest_date,
                        "no_lookahead_rule": "最新预测池只取当前可见截面特征，不读取未来收益。",
                    },
                    "summary": {"item_count": 0, "average_score": None, "average_model_score": None, "market": {}},
                    "items": [],
                },
            }, ensure_ascii=False))
            return

        if args.experiment == "capital-rotation":
            main_artifact = pick_artifact(conn, "experiment:capital-rotation-direction", required=False) or pick_artifact(conn, "experiment:capital-rotation")
            hardness_artifact = pick_artifact(conn, "experiment:capital-rotation-hardness", required=False)
            direction_artifact = main_artifact
        else:
            main_artifact = pick_artifact(conn, f"experiment:{args.experiment}")
            direction_artifact = None
            hardness_artifact = None

        main_model = joblib.load(main_artifact["model_file"])
        main_features = model_features(main_artifact)
        hardness_model = joblib.load(hardness_artifact["model_file"]) if hardness_artifact else None
        hardness_features = model_features(hardness_artifact) if hardness_artifact else []

        # The scoring features only need the rolling structure window before the
        # cut-off date. Loading full symbol history makes the UI replay endpoint
        # look frozen on a multi-year local database.
        price_lookup, _ = load_price_lookup_window(conn, candidates, latest_date, horizon_days)
        supplemental = load_supplemental_lookup_window(conn, candidates, latest_date, horizon_days)
        market_prices, market_index = load_market_prices(conn)
        market_cache = {}
        market_return_cache = {}
        items = []

        for row in candidates:
            price_key = (row["symbol"], row["asset_type"], row["source"])
            prices = price_lookup.get(price_key) or []
            if len(prices) < 60:
                continue
            index = index_at_or_before(prices, latest_date)
            if index is None or index < 59:
                continue
            latest_price = prices[index]
            row["trade_date"] = latest_price["trade_date"]
            row["close"] = latest_price["close"]
            row["ma20"] = avg_close(prices, index, 20)
            row["ma60"] = avg_close(prices, index, 60)
            row["bias60"] = row["close"] / row["ma60"] - 1 if row["ma60"] else 0
            market_regime = market_regime_for_date(market_prices, market_index, row["trade_date"], market_cache)
            market_returns = {
                days: market_return_for_date(market_prices, market_index, row["trade_date"], days, market_return_cache)
                for days in (5, 20, 60, 120)
            }
            features = row_features(row, prices, index, market_regime, market_returns, supplemental)
            model_probability = predict_probability(main_model, main_features, features)
            hardness_probability = (
                predict_probability(hardness_model, hardness_features, features)
                if hardness_model is not None
                else None
            )
            raw_hardness_probability = hardness_probability
            if args.experiment == "capital-rotation":
                hardness_probability = adjust_hardness_for_acceptance_discipline(
                    model_probability,
                    hardness_probability,
                    features,
                    market_regime,
                )
            score = rule_score(args.experiment, row, features, market_regime)
            item = {
                "symbol": row["symbol"],
                "name": row["name"],
                "asset_type": row["asset_type"],
                "source": row["source"],
                "universe_type": row.get("universe_type") or "",
                "trade_date": row["trade_date"],
                "close": round_or_none(row["close"], 3),
                "market_regime": market_regime,
                "experiment_score": score,
                "rule_score": score,
                "model_probability": round_or_none(model_probability, 4),
                "model_score": int(round(model_probability * 100)),
                "feature_label": feature_label(args.experiment, row, features, score),
                "feature_snapshot": feature_snapshot(row, features, market_regime, market_returns),
                "no_lookahead_note": f"最新预测池只使用 {row['trade_date']} 及以前数据；没有读取未来收益。",
            }

            if args.experiment == "capital-rotation":
                raw_model_accept = (
                    model_probability >= 0.62
                    and raw_hardness_probability is not None
                    and raw_hardness_probability >= 0.58
                )
                discipline_model_accept = (
                    model_probability >= 0.62
                    and hardness_probability is not None
                    and hardness_probability >= 0.58
                )
                action, action_reason, discipline, discipline_reason = action_label(
                    model_probability,
                    hardness_probability,
                    features,
                    market_regime,
                )
                crowding, crowding_reason = crowding_label(features)
                item.update({
                    "direction_probability": round_or_none(model_probability, 4),
                    "direction_score": int(round(model_probability * 100)),
                    "hardness_probability": round_or_none(hardness_probability, 4),
                    "hardness_score": int(round(hardness_probability * 100)) if hardness_probability is not None else None,
                    "raw_hardness_probability": round_or_none(raw_hardness_probability, 4),
                    "raw_hardness_score": int(round(raw_hardness_probability * 100)) if raw_hardness_probability is not None else None,
                    "raw_model_accept": raw_model_accept,
                    "discipline_model_accept": discipline_model_accept,
                    "discipline_blocked": raw_model_accept and not discipline_model_accept,
                    "discipline_adjustment": round_or_none(
                        hardness_probability - raw_hardness_probability
                        if hardness_probability is not None and raw_hardness_probability is not None
                        else None,
                        4,
                    ),
                    "rotation_label": action,
                    "rotation_reason": action_reason,
                    "discipline_label": discipline,
                    "discipline_reason": discipline_reason,
                    "crowding_label": crowding,
                    "crowding_reason": crowding_reason,
                })
            if args.include_outcomes:
                attach_future_outcome(item, prices, index, args.experiment, horizon_days)
            items.append(item)

        if args.experiment == "capital-rotation":
            rank = {
                "方向增强": 0,
                "列入观察": 1,
                "方向有承接弱": 2,
                "方向观察": 3,
                "继续观察": 4,
                "只训练不追": 5,
                "总闸冻结": 6,
                "暂不看": 7,
            }
            items.sort(key=lambda item: (
                rank.get(item.get("rotation_label"), 9),
                -(item.get("direction_score") or 0),
                -(item.get("hardness_score") or 0),
                -(item.get("model_score") or 0),
            ))
        else:
            items.sort(key=lambda item: (-(item.get("model_score") or 0), -(item.get("rule_score") or 0)))
        items = items[:limit]

        market_summary = {}
        action_summary = {}
        discipline_blocked_count = 0
        raw_model_accept_count = 0
        discipline_model_accept_count = 0
        for item in items:
            market_summary[item["market_regime"]] = market_summary.get(item["market_regime"], 0) + 1
            label = item.get("rotation_label") or item.get("feature_label") or "未分类"
            action_summary[label] = action_summary.get(label, 0) + 1
            if item.get("raw_model_accept"):
                raw_model_accept_count += 1
            if item.get("discipline_model_accept"):
                discipline_model_accept_count += 1
            if item.get("discipline_blocked"):
                discipline_blocked_count += 1

        avg_rule = sum(item.get("rule_score") or 0 for item in items) / len(items) if items else None
        avg_model = sum(item.get("model_score") or 0 for item in items) / len(items) if items else None
        outcome_items = [item for item in items if item.get("future_label", {}).get("label_status") in {"complete", "partial"}]
        complete_items = [item for item in items if item.get("future_label", {}).get("label_status") == "complete"]
        avg_return_20 = (
            sum(item["future_label"]["forward_return_20d"] for item in complete_items if item["future_label"]["forward_return_20d"] is not None)
            / len([item for item in complete_items if item["future_label"]["forward_return_20d"] is not None])
            if complete_items and [item for item in complete_items if item["future_label"]["forward_return_20d"] is not None]
            else None
        )
        win_items = [
            item for item in complete_items
            if item["future_label"].get("forward_return_20d") is not None and item["future_label"]["forward_return_20d"] > 0
        ]
        fail_items = [
            item for item in outcome_items
            if item["future_label"].get("max_drawdown") is not None and item["future_label"]["max_drawdown"] <= -8
        ]
        payload = {
            "meta": {
                "key": args.experiment,
                "title": config["title"],
                "asset_types": asset_types,
                "latest_price_date": latest_date,
                "as_of_date": latest_date,
                "replay_mode": bool(args.as_of_date),
                "outcome_horizon_days": horizon_days if args.include_outcomes else None,
                "no_lookahead_rule": "最新预测池只取当前可见截面特征，不读取未来收益；模型只辅助筛选，不给开仓许可。",
            },
            "artifact": artifact_payload(main_artifact),
            "direction_artifact": artifact_payload(direction_artifact),
            "hardness_artifact": artifact_payload(hardness_artifact),
            "split_model": args.experiment == "capital-rotation" and hardness_artifact is not None,
            "summary": {
                "item_count": len(items),
                "average_score": round_or_none(avg_rule, 2),
                "average_model_score": round_or_none(avg_model, 2),
                "market": market_summary,
                "action": action_summary,
                "raw_model_accept_count": raw_model_accept_count,
                "discipline_model_accept_count": discipline_model_accept_count,
                "discipline_blocked_count": discipline_blocked_count,
                "complete_count": len(complete_items),
                "partial_count": len([item for item in items if item.get("future_label", {}).get("label_status") == "partial"]),
                "pending_count": len([item for item in items if item.get("future_label", {}).get("label_status") == "pending"]),
                "win_rate_20d": round_or_none(len(win_items) / len(complete_items) * 100, 2) if complete_items else None,
                "average_forward_return_20d": round_or_none(avg_return_20, 2),
                "fail_line_rate": round_or_none(len(fail_items) / len(outcome_items) * 100, 2) if outcome_items else None,
            },
            "items": items,
        }
        print(json.dumps({"success": True, "data": payload}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
