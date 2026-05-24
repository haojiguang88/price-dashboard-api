#!/usr/bin/env python3
import argparse
import json
import math
import sqlite3
from pathlib import Path

import joblib
import numpy as np

from train_experiment_models import (
    FEATURE_COLUMNS,
    avg_close,
    connect,
    latest_price_date,
    load_market_prices,
    load_price_lookup,
    load_supplemental_lookup,
    market_regime_for_date,
    market_return_for_date,
    row_features,
)


NON_EQUITY_NAME_WORDS = (
    "货币", "现金", "债", "国债", "地债", "政金", "城投", "信用债", "可转债",
    "短融", "存单", "黄金", "白银", "豆粕", "商品", "原油",
)

AI_CHAIN_NAME_CONDITION = """
(
  u.name LIKE '%CPO%'
  OR u.name LIKE '%光模块%'
  OR u.name LIKE '%光通信%'
  OR u.name LIKE '%通信%'
  OR u.name LIKE '%算力%'
  OR u.name LIKE '%云计算%'
  OR u.name LIKE '%数据中心%'
  OR u.name LIKE '%人工智能%'
  OR u.name LIKE '%AI%'
  OR u.name LIKE '%科创AI%'
  OR u.name LIKE '%半导体%'
  OR u.name LIKE '%芯片%'
  OR u.name LIKE '%半导体设备%'
  OR u.name LIKE '%软件%'
  OR u.name LIKE '%计算机%'
  OR u.name LIKE '%机器人%'
)
"""


def safe_float(value, default=0.0):
    try:
        numeric = float(value)
    except Exception:
        return default
    return numeric if math.isfinite(numeric) else default


def round_or_none(value, digits=4):
    if value is None:
        return None
    numeric = safe_float(value, None)
    if numeric is None:
        return None
    return round(numeric, digits)


def artifact_selection_score(row):
    metrics_file = row["metrics_file"] if "metrics_file" in row.keys() else None
    if metrics_file and Path(metrics_file).exists():
        try:
            payload = json.loads(Path(metrics_file).read_text(encoding="utf-8"))
            score = payload.get("selection_score")
            if score is not None:
                return safe_float(score)
        except Exception:
            pass
    test_auc = row["test_auc"] if "test_auc" in row.keys() else None
    validation_auc = row["validation_auc"] if "validation_auc" in row.keys() else None
    return safe_float(test_auc if test_auc is not None else validation_auc)


def pick_artifact(conn, domain, required=True):
    rows = conn.execute(
        """
        SELECT *
        FROM model_training_artifacts
        WHERE domain = ?
          AND model_file IS NOT NULL
        ORDER BY updated_at DESC
        """,
        (domain,),
    ).fetchall()
    available = [row for row in rows if Path(row["model_file"]).exists()]
    available.sort(key=artifact_selection_score, reverse=True)
    for row in available:
        if Path(row["model_file"]).exists():
            return row
    if not required:
        return None
    raise RuntimeError("未找到资金轮动可用模型文件，请先训练资金轮动模型。")


def model_features(artifact):
    model_json_path = artifact["model_json_file"] if "model_json_file" in artifact.keys() else None
    if model_json_path and Path(model_json_path).exists():
        payload = json.loads(Path(model_json_path).read_text(encoding="utf-8"))
        features = payload.get("features")
        if features:
            return features
    return FEATURE_COLUMNS


def load_candidates(conn, scope, latest_date):
    scope_filter = ""
    if scope == "ai":
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
                  ELSE MIN(universe_type)
                END AS universe_type
              FROM financial_asset_universe
              WHERE asset_type = 'etf'
                AND enabled = 1
                AND source = 'tushare'
              GROUP BY symbol, asset_type, source
            ),
            daily_latest AS (
              SELECT p.*,
                ROW_NUMBER() OVER (
                  PARTITION BY p.symbol, p.asset_type, p.source
                  ORDER BY p.trade_date DESC
                ) AS rn
              FROM financial_daily_prices p
              WHERE p.asset_type = 'etf'
                AND p.source = 'tushare'
                AND p.trade_date <= ?
                AND p.close IS NOT NULL
                AND p.close > 0
            ),
            trend_latest AS (
              SELECT t.*,
                ROW_NUMBER() OVER (
                  PARTITION BY t.symbol, t.asset_type, t.source
                  ORDER BY t.trade_date DESC, t.rule_version DESC, t.id DESC
                ) AS rn
              FROM financial_trend_phase_results t
              WHERE t.asset_type = 'etf'
                AND t.source = 'tushare'
                AND t.trade_date <= ?
                AND t.close IS NOT NULL
                AND t.close > 0
            )
            SELECT u.symbol, u.name, u.asset_type, u.source, u.universe_type,
              COALESCE(t.trade_date, p.trade_date) AS trade_date,
              COALESCE(t.close, p.close) AS close,
              t.ma20, t.ma60, t.bias60, t.ret5, t.ret20, t.range20, t.cross60_10,
              COALESCE(t.trend_phase_code, 'UNKNOWN') AS trend_phase_code,
              COALESCE(t.trend_phase_reason, 'AI链未生成走势阶段，直接用本地日线进入轮动评分。') AS trend_phase_reason
            FROM universe_unique u
            JOIN daily_latest p
              ON p.symbol = u.symbol AND p.asset_type = u.asset_type AND p.source = u.source AND p.rn = 1
            LEFT JOIN trend_latest t
              ON t.symbol = u.symbol AND t.asset_type = u.asset_type AND t.source = u.source AND t.rn = 1
            WHERE {AI_CHAIN_NAME_CONDITION}
            ORDER BY u.symbol ASC
            """,
            (latest_date, latest_date),
        ).fetchall()
        return dedupe_candidate_rows(rows)
    if scope == "focus":
        scope_filter = """
          AND (
            u.universe_type = 'industry_etf'
            OR u.name LIKE '%电力%'
            OR u.name LIKE '%存储%'
            OR u.name LIKE '%CPO%'
            OR u.name LIKE '%光模块%'
            OR u.name LIKE '%光通信%'
            OR u.name LIKE '%通信%'
            OR u.name LIKE '%算力%'
            OR u.name LIKE '%云计算%'
            OR u.name LIKE '%数据中心%'
            OR u.name LIKE '%半导体%'
            OR u.name LIKE '%芯片%'
            OR u.name LIKE '%半导体设备%'
            OR u.name LIKE '%人工智能%'
            OR u.name LIKE '%AI%'
            OR u.name LIKE '%新能源%'
          )
        """

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
              ELSE MIN(universe_type)
            END AS universe_type
          FROM financial_asset_universe
          WHERE asset_type = 'etf'
            AND enabled = 1
            AND source = 'tushare'
          GROUP BY symbol, asset_type, source
        ),
        trend_latest AS (
          SELECT t.*,
            ROW_NUMBER() OVER (
              PARTITION BY t.symbol, t.asset_type, t.source
              ORDER BY t.trade_date DESC, t.rule_version DESC, t.id DESC
            ) AS rn
          FROM financial_trend_phase_results t
          WHERE t.asset_type = 'etf'
            AND t.source = 'tushare'
            AND t.trade_date <= ?
            AND t.close IS NOT NULL
            AND t.close > 0
        )
        SELECT t.symbol, COALESCE(u.name, t.symbol) AS name, t.asset_type, t.source,
          u.universe_type, t.trade_date, t.close, t.ma20, t.ma60, t.bias60, t.ret5,
          t.ret20, t.range20, t.cross60_10, t.trend_phase_code, t.trend_phase_reason
        FROM trend_latest t
        JOIN universe_unique u
          ON u.symbol = t.symbol AND u.asset_type = t.asset_type AND u.source = t.source
        WHERE t.rn = 1
          {scope_filter}
        ORDER BY t.symbol ASC
        """,
        (latest_date,),
    ).fetchall()

    return dedupe_candidate_rows(rows)


def dedupe_candidate_rows(rows):
    candidates = []
    seen = set()
    for row in rows:
        name = str(row["name"] or "")
        if any(word in name for word in NON_EQUITY_NAME_WORDS):
            continue
        key = (row["symbol"], row["asset_type"], row["source"])
        if key in seen:
            continue
        seen.add(key)
        candidates.append(dict(row))
    return candidates


def crowding_label(features):
    ret20 = safe_float(features.get("ret20"))
    ret60 = safe_float(features.get("ret60"))
    distance_ma60 = safe_float(features.get("distance_ma60"))
    distance_ma120 = safe_float(features.get("distance_ma120"))
    amount_ratio = safe_float(features.get("amount_ratio_5_20"))
    price_pos120 = safe_float(features.get("price_pos120"), 0.5)

    if ret20 >= 0.10 or distance_ma60 >= 0.08 or (price_pos120 >= 0.75 and ret20 >= 0.08) or (price_pos120 >= 0.90 and amount_ratio >= 0.25):
        return "高位防追", "强势但偏高，只进训练样本，不给追高动作。"
    if ret60 >= 0.25 or distance_ma120 >= 0.18:
        return "长周期高位", "中期涨幅较大，先看轮动持续性和回踩承接。"
    if ret20 >= 0.06 and amount_ratio >= 0.2:
        return "放量抬头", "短期相对强且成交活跃，可以作为方向样本。"
    return "正常观察", "未出现明显拥挤，继续看相对强弱。"


def adjust_hardness_for_acceptance_discipline(direction_probability, hardness_probability, features, market_regime):
    if hardness_probability is None:
        return None

    hardness = float(hardness_probability)
    breadth_above_ma60_ratio = safe_float(features.get("breadth_above_ma60_ratio"), None)
    breadth_down_ratio = safe_float(features.get("breadth_down_ratio"), None)
    price_pos120 = safe_float(features.get("price_pos120"), 0.5)
    relative_ret20 = safe_float(features.get("relative_ret20_hs300"))
    distance_ma60 = safe_float(features.get("distance_ma60"))
    amount_available = safe_float(features.get("amount_available"))
    amount_ratio_5_20 = safe_float(features.get("amount_ratio_5_20"), None)
    amount_ratio_20_60 = safe_float(features.get("amount_ratio_20_60"), None)

    if market_regime == "CRASH":
        return min(hardness, 0.35)

    if market_regime != "RISK":
        return hardness

    breadth_known = (
        (breadth_above_ma60_ratio is not None and breadth_above_ma60_ratio > 0)
        or (breadth_down_ratio is not None and breadth_down_ratio > 0)
    )
    breadth_extreme_weak = breadth_known and (
        (breadth_above_ma60_ratio is not None and 0 < breadth_above_ma60_ratio < 0.25)
        or (breadth_down_ratio is not None and breadth_down_ratio > 0.68)
    )
    breadth_weak = breadth_known and (
        (breadth_above_ma60_ratio is not None and 0 < breadth_above_ma60_ratio < 0.45)
        or (breadth_down_ratio is not None and breadth_down_ratio > 0.55)
    )
    high_or_extended = (
        price_pos120 >= 0.75
        or distance_ma60 >= 0.08
        or relative_ret20 >= 0.06
    )
    amount_low = amount_available > 0 and (
        (amount_ratio_5_20 is not None and amount_ratio_5_20 < -0.2)
        or (amount_ratio_20_60 is not None and amount_ratio_20_60 < -0.2)
    )

    if breadth_extreme_weak:
        return min(hardness, 0.54)
    if breadth_weak and high_or_extended:
        return min(hardness, 0.55)
    if breadth_weak and amount_low:
        return min(hardness, 0.55)
    if direction_probability >= 0.62 and breadth_weak:
        return min(hardness, 0.57)
    return hardness


def predict_probability(model, feature_names, feature_map):
    matrix = np.asarray([[float(feature_map.get(name, 0) or 0) for name in feature_names]], dtype=np.float32)
    return float(model.predict_proba(matrix)[0][1])


def action_label(direction_probability, hardness_probability, features, market_regime):
    crowding, note = crowding_label(features)
    rel20 = safe_float(features.get("relative_ret20_hs300"))
    rel60 = safe_float(features.get("relative_ret60_hs300"))
    distance_ma60 = safe_float(features.get("distance_ma60"))
    price_pos120 = safe_float(features.get("price_pos120"), 0.5)
    amount_available = safe_float(features.get("amount_available"))
    amount_ratio_5_20 = safe_float(features.get("amount_ratio_5_20"), None)
    amount_ratio_20_60 = safe_float(features.get("amount_ratio_20_60"), None)
    breadth_above_ma60_ratio = safe_float(features.get("breadth_above_ma60_ratio"), None)
    breadth_down_ratio = safe_float(features.get("breadth_down_ratio"), None)
    hardness = 0.5 if hardness_probability is None else hardness_probability

    if market_regime == "CRASH":
        return "总闸冻结", "市场处于冻结状态，只记录方向变化。", "总闸冻结", "市场环境不过，方向和承接都不能覆盖总闸。"
    if crowding in ("高位防追", "长周期高位"):
        return "只训练不追", note, "高位纪律", "方向可以学习，但偏高或拥挤时不做承接动作。"
    if direction_probability >= 0.62 and hardness < 0.45:
        return "方向有承接弱", "方向分够，但承接/回撤模型不过线，只等回踩或下一轮确认。", "承接偏弱", "承接分低，纪律上不能把方向强度当成买点。"
    if market_regime == "RISK" and direction_probability >= 0.62 and hardness < 0.62:
        return "方向有承接弱", "RISK环境里方向分够，但承接硬度没有过风险区严格线，先不放行。", "风险区承接不足", "风险区承接线单独收紧，防最终涨了但过程先洗穿纪律线。"
    if market_regime == "RISK" and direction_probability >= 0.62 and hardness >= 0.58:
        amount_low = (
            amount_available > 0
            and (
                (amount_ratio_5_20 is not None and amount_ratio_5_20 < -0.2)
                or (amount_ratio_20_60 is not None and amount_ratio_20_60 < -0.2)
            )
        )
        breadth_known = (
            (breadth_above_ma60_ratio is not None and breadth_above_ma60_ratio > 0)
            or (breadth_down_ratio is not None and breadth_down_ratio > 0)
        )
        breadth_weak = (
            breadth_known
            and (
                (breadth_above_ma60_ratio is not None and breadth_above_ma60_ratio < 0.45)
                or (breadth_down_ratio is not None and breadth_down_ratio > 0.55)
            )
        )
        high_position = price_pos120 >= 0.8 and rel20 >= 0.04
        if amount_low:
            return "方向有承接弱", "RISK环境下方向和模型承接分都够，但量能承接不足，先不放行。", "量能承接不足", "RISK里缩量或量能低于中期均值时，容易出现方向对但承接打脸。"
        if breadth_weak:
            return "方向有承接弱", "RISK环境下市场广度偏弱，方向分不能直接当成承接通过。", "市场广度偏弱", "大面积走弱时，单个方向信号需要更硬的后续确认。"
        if high_position:
            return "只训练不追", "RISK环境下位置偏高且偏离MA60，先作为训练样本，不做承接通过。", "高位纪律", "风险环境里高位扩散最容易左右扇脸，先等回踩承接。"
    if direction_probability >= 0.62 and hardness >= 0.58 and rel20 >= 0.02 and distance_ma60 >= -0.02:
        return "方向增强", "方向模型、承接模型和相对强弱同时支持，后续仍要等结构和安全区。", "承接通过", "回撤纪律暂时过线，可以进入更细的结构观察。"
    if direction_probability >= 0.54 and hardness >= 0.5 and (rel20 >= 0 or rel60 >= 0.02):
        return "列入观察", "轮动证据出现且承接不弱，先进入方向观察。", "承接观察", "承接分未硬到直接通过，但没有触发纪律拦截。"
    if direction_probability >= 0.54:
        return "方向观察", "方向模型有抬头，但承接证据还不够，先只留样本。", "待承接确认", "需要看后续回踩、放量和结构是否能稳住。"
    if direction_probability <= 0.42:
        return "暂不看", "方向分低，暂时不作为轮动方向。", "不承接", "方向本身不过，承接判断不前置。"
    return "继续观察", "证据不够硬，等收盘后继续滚动。", "待确认", "方向和承接都还在中间区。"


def artifact_payload(artifact):
    if artifact is None:
        return None
    return {
        "domain": artifact["domain"] if "domain" in artifact.keys() else None,
        "model_key": artifact["model_key"],
        "model_type": artifact["model_type"],
        "validation_auc": artifact["validation_auc"],
        "test_auc": artifact["test_auc"],
        "updated_at": artifact["updated_at"],
        "model_file": artifact["model_file"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--scope", default="focus", choices=["focus", "all", "ai"])
    parser.add_argument("--limit", type=int, default=80)
    args = parser.parse_args()

    conn = connect(args.db)
    try:
        direction_artifact = (
            pick_artifact(conn, "experiment:capital-rotation-direction", required=False)
            or pick_artifact(conn, "experiment:capital-rotation")
        )
        hardness_artifact = pick_artifact(conn, "experiment:capital-rotation-hardness", required=False)
        direction_model = joblib.load(direction_artifact["model_file"])
        direction_features = model_features(direction_artifact)
        hardness_model = joblib.load(hardness_artifact["model_file"]) if hardness_artifact else None
        hardness_features = model_features(hardness_artifact) if hardness_artifact else []
        latest_date = latest_price_date(conn)
        candidates = load_candidates(conn, args.scope, latest_date)
        price_lookup, price_indexes = load_price_lookup(conn, candidates)
        supplemental = load_supplemental_lookup(conn, candidates)
        market_prices, market_index = load_market_prices(conn)
        market_cache = {}
        market_return_cache = {}

        items = []
        for row in candidates:
            price_key = (row["symbol"], row["asset_type"], row["source"])
            prices = price_lookup.get(price_key) or []
            if len(prices) < 260:
                continue
            latest_price = prices[-1]
            index = len(prices) - 1
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
            feature_map = row_features(row, prices, index, market_regime, market_returns, supplemental)
            direction_probability = predict_probability(direction_model, direction_features, feature_map)
            hardness_probability = (
                predict_probability(hardness_model, hardness_features, feature_map)
                if hardness_model is not None
                else None
            )
            raw_hardness_probability = hardness_probability
            hardness_probability = adjust_hardness_for_acceptance_discipline(
                direction_probability,
                hardness_probability,
                feature_map,
                market_regime,
            )
            action, action_reason, discipline, discipline_reason = action_label(
                direction_probability,
                hardness_probability,
                feature_map,
                market_regime,
            )
            crowding, crowding_reason = crowding_label(feature_map)
            hardness_score = int(round(hardness_probability * 100)) if hardness_probability is not None else None
            raw_model_accept = (
                direction_probability >= 0.62
                and raw_hardness_probability is not None
                and raw_hardness_probability >= 0.58
            )
            discipline_model_accept = (
                direction_probability >= 0.62
                and hardness_probability is not None
                and hardness_probability >= 0.58
            )

            items.append({
                "symbol": row["symbol"],
                "name": row["name"],
                "asset_type": row["asset_type"],
                "source": row["source"],
                "universe_type": row.get("universe_type") or "",
                "trade_date": row["trade_date"],
                "close": round_or_none(row["close"], 3),
                "model_probability": round_or_none(direction_probability, 4),
                "model_score": int(round(direction_probability * 100)),
                "direction_probability": round_or_none(direction_probability, 4),
                "direction_score": int(round(direction_probability * 100)),
                "hardness_probability": round_or_none(hardness_probability, 4),
                "hardness_score": hardness_score,
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
                "market_regime": market_regime,
                "trend_phase_code": row.get("trend_phase_code") or "UNKNOWN",
                "rotation_label": action,
                "rotation_reason": action_reason,
                "discipline_label": discipline,
                "discipline_reason": discipline_reason,
                "crowding_label": crowding,
                "crowding_reason": crowding_reason,
                "ret20": round_or_none(feature_map.get("ret20"), 4),
                "ret60": round_or_none(feature_map.get("ret60"), 4),
                "ret120": round_or_none(feature_map.get("ret120"), 4),
                "relative_ret20_hs300": round_or_none(feature_map.get("relative_ret20_hs300"), 4),
                "relative_ret60_hs300": round_or_none(feature_map.get("relative_ret60_hs300"), 4),
                "relative_ret120_hs300": round_or_none(feature_map.get("relative_ret120_hs300"), 4),
                "amount_ratio_5_20": round_or_none(feature_map.get("amount_ratio_5_20"), 4),
                "amount_ratio_20_60": round_or_none(feature_map.get("amount_ratio_20_60"), 4),
                "breadth_above_ma60_ratio": round_or_none(feature_map.get("breadth_above_ma60_ratio"), 4),
                "breadth_down_ratio": round_or_none(feature_map.get("breadth_down_ratio"), 4),
                "distance_ma60": round_or_none(feature_map.get("distance_ma60"), 4),
                "distance_ma120": round_or_none(feature_map.get("distance_ma120"), 4),
                "price_pos120": round_or_none(feature_map.get("price_pos120"), 4),
            })

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
            rank.get(item["rotation_label"], 9),
            -(item["direction_score"] or 0),
            -((item["hardness_score"] or 0)),
            -(item["relative_ret20_hs300"] or -999),
        ))
        payload = {
            "artifact": artifact_payload(direction_artifact),
            "direction_artifact": artifact_payload(direction_artifact),
            "hardness_artifact": artifact_payload(hardness_artifact),
            "split_model": hardness_artifact is not None,
            "latest_date": latest_date,
            "scope": args.scope,
            "total": len(items),
            "items": items[:max(1, args.limit)],
        }
        print(json.dumps({"success": True, "data": payload}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
