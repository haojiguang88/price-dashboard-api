#!/usr/bin/env python3
import argparse
import csv
import json
import math
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np

from train_experiment_models import (
    EXPERIMENTS,
    FEATURE_COLUMNS,
    avg_close,
    build_dataset,
    connect,
    create_run,
    ensure_training_tables,
    feature_importance,
    finish_run,
    labels,
    load_price_lookup,
    load_market_prices,
    load_supplemental_lookup,
    make_model,
    matrix,
    metric_payload,
    now,
    range_over_days,
    return_over_days,
    row_features,
    safe_ratio,
    split_dataset,
    market_return_for_date,
)


MODEL_KEYS = ("logistic_regression", "random_forest", "lightgbm_model")
DIRECTION_CONTEXT_TRENDS = {
    "BREAKOUT",
    "SLOW_GRIND_UP",
    "TREND_UP",
    "SURGE",
    "TREND_TRANSITION",
}


def safe_float(value, default=0.0):
    try:
        numeric = float(value)
    except Exception:
        return default
    return numeric if math.isfinite(numeric) else default


def write_dataset(rows, dataset_path):
    if not rows:
        return
    columns = list(rows[0].keys())
    with Path(dataset_path).open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def forward_market_return(market_prices, market_index, trade_date, days):
    index = market_index.get(trade_date)
    if index is None or index + days >= len(market_prices):
        return 0.0
    return safe_ratio(market_prices[index + days]["close"], market_prices[index]["close"])


def annotate_rotation_targets(
    rows,
    conn,
    relative_threshold,
    direction_absolute_floor,
    hardness_absolute_floor,
    drawdown_floor,
    risk_hardness_absolute_floor,
    risk_drawdown_floor,
):
    market_prices, market_index = load_market_prices(conn)
    for row in rows:
        market_forward = forward_market_return(market_prices, market_index, row["trade_date"], 20)
        relative_forward = float(row.get("forward_return_20d") or 0) - market_forward
        forward_return_20d = float(row.get("forward_return_20d") or 0)
        max_drawdown = float(row.get("max_drawdown") or 0)
        market_regime = row.get("market_regime") or "UNKNOWN"
        is_crash_regime = market_regime == "CRASH"
        target_hardness_absolute_floor = hardness_absolute_floor
        target_drawdown_floor = drawdown_floor
        target_policy = "base"
        if market_regime == "RISK":
            target_hardness_absolute_floor = risk_hardness_absolute_floor
            target_drawdown_floor = risk_drawdown_floor
            target_policy = "risk_strict"
        elif is_crash_regime:
            target_policy = "crash_freeze"
        original_target = int(row.get("target") or 0)
        row["original_target"] = original_target
        row["forward_market_return_20d"] = market_forward
        row["forward_relative_return_20d"] = relative_forward
        row["hardness_return_floor"] = target_hardness_absolute_floor
        row["hardness_drawdown_floor"] = target_drawdown_floor
        row["hardness_target_policy"] = target_policy
        row["direction_target"] = 1 if (
            relative_forward >= relative_threshold
            and forward_return_20d >= direction_absolute_floor
        ) else 0
        raw_hardness_target = 1 if (
            max_drawdown >= target_drawdown_floor
            and forward_return_20d >= target_hardness_absolute_floor
        ) else 0
        row["hardness_target"] = 0 if is_crash_regime else raw_hardness_target
        row["combined_target"] = 1 if row["direction_target"] and row["hardness_target"] else 0
        row["acceptance_broken"] = 1 if max_drawdown <= target_drawdown_floor else 0
        row["direction_ok_acceptance_broken"] = 1 if (
            row["direction_target"] == 1
            and row["acceptance_broken"] == 1
        ) else 0
        row["path_broken_positive_20d"] = 1 if (
            row["direction_ok_acceptance_broken"] == 1
            and forward_return_20d > 0
        ) else 0
        breadth_above_ma60 = safe_float(row.get("breadth_above_ma60_ratio"))
        breadth_known = breadth_above_ma60 > 0
        row["crash_freeze_negative"] = 1 if is_crash_regime else 0
        row["risk_path_false_positive_pattern"] = 1 if (
            market_regime == "RISK"
            and row["path_broken_positive_20d"] == 1
            and safe_float(row.get("price_pos120")) >= 0.75
            and breadth_known
            and breadth_above_ma60 <= 0.45
        ) else 0
    return rows


def direction_context_signals(
    row,
    min_relative_ret20,
    min_relative_ret60,
    min_sector_relative_ret20,
    min_ret20,
    min_amount_ratio_5_20,
    min_price_pos120,
):
    """Use only current-snapshot fields; future labels must not enter this filter."""
    signals = []
    trend = str(row.get("trend_phase_code") or "").upper()
    if trend in DIRECTION_CONTEXT_TRENDS:
        signals.append("趋势阶段")
    if safe_float(row.get("relative_ret20_hs300")) >= min_relative_ret20:
        signals.append("20日相对沪深300")
    if safe_float(row.get("relative_ret60_hs300")) >= min_relative_ret60:
        signals.append("60日相对沪深300")
    if (
        safe_float(row.get("sector_relative_ret20_hs300")) >= min_sector_relative_ret20
        or safe_float(row.get("industry_relative_ret20_hs300")) >= min_sector_relative_ret20
    ):
        signals.append("板块/行业相对强")
    if safe_float(row.get("ret20")) >= min_ret20:
        signals.append("自身20日收益")
    if (
        safe_float(row.get("distance_ma60")) >= 0
        and safe_float(row.get("amount_ratio_5_20")) >= min_amount_ratio_5_20
        and safe_float(row.get("ret20")) >= 0
    ):
        signals.append("站上MA60且量能抬头")
    if (
        safe_float(row.get("price_pos120")) >= min_price_pos120
        and safe_float(row.get("relative_ret20_hs300")) >= 0
    ):
        signals.append("120日价格位置")
    return signals


def annotate_hardness_training_context(
    rows,
    min_signals,
    min_relative_ret20,
    min_relative_ret60,
    min_sector_relative_ret20,
    min_ret20,
    min_amount_ratio_5_20,
    min_price_pos120,
):
    for row in rows:
        signals = direction_context_signals(
            row,
            min_relative_ret20,
            min_relative_ret60,
            min_sector_relative_ret20,
            min_ret20,
            min_amount_ratio_5_20,
            min_price_pos120,
        )
        row["hardness_context_signal_count"] = len(signals)
        row["hardness_context_signals"] = "、".join(signals)
        row["hardness_context"] = 1 if len(signals) >= min_signals else 0
    return rows


def rows_for_target(rows, target_column):
    task_rows = []
    for row in rows:
        item = dict(row)
        item["target"] = int(item.get(target_column) or 0)
        item["target_column"] = target_column
        task_rows.append(item)
    return task_rows


def task_source_rows(rows, task):
    if task.get("row_filter") != "hardness_context":
        return rows
    return [
        row for row in rows
        if int(row.get("hardness_context") or 0) == 1
        or int(row.get("risk_backfill_target") or 0) == 1
    ]


def parse_json_object(value):
    if not value:
        return {}
    try:
        payload = json.loads(value)
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def label_ratio(value):
    numeric = safe_float(value, None)
    if numeric is None:
        return 0.0
    return numeric / 100 if abs(numeric) > 1.5 else numeric


def risk_weak_flags(features, market_regime):
    if str(market_regime or "").upper() != "RISK":
        return {
            "risk_weak_breadth": 0,
            "risk_weak_relative_hs300": 0,
            "risk_weak_amount": 0,
            "risk_weak_count": 0,
        }
    weak_breadth = (
        safe_float(features.get("breadth_above_ma60_ratio")) > 0
        and safe_float(features.get("breadth_above_ma60_ratio")) <= 0.45
    )
    weak_relative = (
        safe_float(features.get("relative_ret20_hs300")) <= -0.03
        or safe_float(features.get("relative_ret60_hs300")) <= -0.05
    )
    weak_amount = (
        safe_float(features.get("amount_ratio_5_20")) <= -0.20
        or safe_float(features.get("sector_amount_ratio_5_20")) <= -0.20
    )
    return {
        "risk_weak_breadth": 1 if weak_breadth else 0,
        "risk_weak_relative_hs300": 1 if weak_relative else 0,
        "risk_weak_amount": 1 if weak_amount else 0,
        "risk_weak_count": sum([weak_breadth, weak_relative, weak_amount]),
    }


def initialize_backfill_flags(rows):
    for row in rows:
        row.setdefault("risk_backfill_sample", 0)
        row.setdefault("risk_backfill_target", 0)
        row.setdefault("risk_backfill_source_count", 0)
        row.setdefault("risk_weak_breadth", 0)
        row.setdefault("risk_weak_relative_hs300", 0)
        row.setdefault("risk_weak_amount", 0)
        row.setdefault("risk_weak_count", 0)


def load_risk_backfill_rows(conn, config, limit):
    rows = conn.execute(
        """
        SELECT
          s.experiment_key, s.symbol, s.name, s.asset_type, s.source,
          s.universe_type, s.trade_date, s.close, s.market_regime,
          s.feature_snapshot_json,
          l.forward_return_5d, l.forward_return_10d, l.forward_return_20d,
          l.max_forward_return, l.max_drawdown
        FROM finance_experiment_prediction_snapshots s
        INNER JOIN finance_experiment_prediction_labels l
          ON l.snapshot_id = s.id AND l.horizon_days = 20
        WHERE s.saved_from = 'risk_crash_backfill'
          AND s.experiment_key = 'capital-rotation'
          AND COALESCE(l.label_status, 'pending') = 'complete'
          AND COALESCE(s.market_regime, 'UNKNOWN') = 'RISK'
        ORDER BY s.trade_date ASC, s.symbol ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    candidates = []
    for row in rows:
        snapshot = parse_json_object(row["feature_snapshot_json"])
        candidates.append({
            "symbol": row["symbol"],
            "name": row["name"] or row["symbol"],
            "asset_type": row["asset_type"] or "etf",
            "source": row["source"] or "tushare",
            "universe_type": row["universe_type"] or snapshot.get("universe_type") or "",
            "trade_date": row["trade_date"],
            "close": safe_float(row["close"]),
            "trend_phase_code": snapshot.get("trend_phase_code") or "UNKNOWN",
            "cross60_10": safe_float(snapshot.get("cross60_10")),
            "_label": row,
        })

    if not candidates:
        return [], {"candidate_count": 0, "usable_count": 0, "target_count": 0, "skipped_count": 0}

    price_lookup, price_indexes = load_price_lookup(conn, candidates)
    market_prices, market_index = load_market_prices(conn)
    supplemental = load_supplemental_lookup(conn, candidates)
    market_return_cache = {}

    backfill_rows = []
    skipped = 0
    for row in candidates:
        price_key = (row["symbol"], row["asset_type"], row["source"])
        prices = price_lookup.get(price_key)
        index = price_indexes.get(price_key, {}).get(row["trade_date"])
        if prices is None or index is None or index < 59:
            skipped += 1
            continue

        close = safe_float(row.get("close")) or safe_float(prices[index]["close"])
        ma20 = avg_close(prices, index, 20)
        ma60 = avg_close(prices, index, 60)
        base_row = {
            "symbol": row["symbol"],
            "name": row["name"],
            "asset_type": row["asset_type"],
            "source": row["source"],
            "universe_type": row.get("universe_type") or "",
            "trade_date": row["trade_date"],
            "close": close,
            "ma20": ma20,
            "ma60": ma60,
            "bias60": safe_ratio(close, ma60),
            "ret5": return_over_days(prices, index, 5),
            "ret20": return_over_days(prices, index, 20),
            "range20": range_over_days(prices, index, 20),
            "cross60_10": row.get("cross60_10") or 0,
            "trend_phase_code": row.get("trend_phase_code") or "UNKNOWN",
        }
        market_regime = "RISK"
        market_returns = {
            days: market_return_for_date(market_prices, market_index, row["trade_date"], days, market_return_cache)
            for days in (5, 20, 60, 120)
        }
        features = row_features(base_row, prices, index, market_regime, market_returns, supplemental)
        flags = risk_weak_flags(features, market_regime)
        if flags["risk_weak_count"] <= 0:
            skipped += 1
            continue

        label = row["_label"]
        max_forward_return = label_ratio(label["max_forward_return"])
        max_drawdown = label_ratio(label["max_drawdown"])
        backfill_rows.append({
            "symbol": row["symbol"],
            "name": row["name"],
            "asset_type": row["asset_type"],
            "source": row["source"],
            "universe_type": row.get("universe_type") or "",
            "trade_date": row["trade_date"],
            "close": close,
            "market_regime": market_regime,
            "trend_phase_code": row.get("trend_phase_code") or "UNKNOWN",
            "target": 1 if (
                max_forward_return >= config["positive_threshold"]
                and max_drawdown >= config["max_drawdown_floor"]
            ) else 0,
            "forward_return_window": label_ratio(label["forward_return_20d"]),
            "forward_return_5d": label_ratio(label["forward_return_5d"]),
            "forward_return_10d": label_ratio(label["forward_return_10d"]),
            "forward_return_20d": label_ratio(label["forward_return_20d"]),
            "max_forward_return": max_forward_return,
            "max_drawdown": max_drawdown,
            "risk_backfill_sample": 1,
            "risk_backfill_target": 1,
            "risk_backfill_source_count": 1,
            **flags,
            **features,
        })

    return backfill_rows, {
        "candidate_count": len(candidates),
        "usable_count": len(backfill_rows),
        "target_count": len(backfill_rows),
        "skipped_count": skipped,
    }


def merge_risk_backfill_rows(rows, backfill_rows):
    initialize_backfill_flags(rows)
    existing = {
        (row["symbol"], row["asset_type"], row["source"], row["trade_date"]): row
        for row in rows
    }
    added = 0
    merged = 0
    for row in backfill_rows:
        key = (row["symbol"], row["asset_type"], row["source"], row["trade_date"])
        if key in existing:
            target = existing[key]
            target["risk_backfill_sample"] = 1
            target["risk_backfill_target"] = 1
            target["risk_backfill_source_count"] = int(target.get("risk_backfill_source_count") or 0) + 1
            for flag_key in ("risk_weak_breadth", "risk_weak_relative_hs300", "risk_weak_amount"):
                target[flag_key] = max(int(target.get(flag_key) or 0), int(row.get(flag_key) or 0))
            target["risk_weak_count"] = sum([
                int(target.get("risk_weak_breadth") or 0),
                int(target.get("risk_weak_relative_hs300") or 0),
                int(target.get("risk_weak_amount") or 0),
            ])
            merged += 1
            continue
        rows.append(row)
        existing[key] = row
        added += 1
    initialize_backfill_flags(rows)
    return {
        "added_count": added,
        "merged_count": merged,
        "training_target_count": sum(int(row.get("risk_backfill_target") or 0) for row in rows),
        "weak_breadth_count": sum(int(row.get("risk_weak_breadth") or 0) for row in rows),
        "weak_relative_hs300_count": sum(int(row.get("risk_weak_relative_hs300") or 0) for row in rows),
        "weak_amount_count": sum(int(row.get("risk_weak_amount") or 0) for row in rows),
    }


def sample_weight(row, recent_start="2025-01-01", current_start="2026-01-01"):
    trade_date = row["trade_date"]
    weight = 1.0
    if trade_date >= "2024-01-01":
        weight *= 1.25
    if trade_date >= recent_start:
        weight *= 2.0
    if trade_date >= current_start:
        weight *= 3.0
    if row.get("universe_type") == "industry_etf":
        weight *= 1.15
    if row.get("market_regime") == "NORMAL":
        weight *= 1.05
    if row.get("target_column") == "hardness_target":
        if row.get("market_regime") == "RISK":
            weight *= 2.2
        elif row.get("market_regime") == "CRASH":
            weight *= 2.6
            if int(row.get("target") or 0) == 0:
                weight *= 1.55
            if int(row.get("crash_freeze_negative") or 0) == 1:
                weight *= 1.35
        if int(row.get("risk_backfill_target") or 0) == 1:
            weight *= 2.0
            weak_count = min(int(row.get("risk_weak_count") or 0), 3)
            weight *= (1.0 + 0.30 * weak_count)
            if int(row.get("target") or 0) == 0:
                weight *= 1.35
        if int(row.get("risk_path_false_positive_pattern") or 0) == 1:
            weight *= 2.5
        forward_return_20d = safe_float(row.get("forward_return_20d"))
        max_drawdown = safe_float(row.get("max_drawdown"))
        if int(row.get("target") or 0) == 0 and (forward_return_20d <= 0 or max_drawdown <= -0.08):
            weight *= 1.35
            if row.get("market_regime") == "RISK":
                weight *= 1.35
                if safe_float(row.get("ret20")) >= 0.045 or safe_float(row.get("relative_ret20_hs300")) >= 0.035:
                    weight *= 1.2
        if int(row.get("direction_ok_acceptance_broken") or 0) == 1:
            weight *= 2.4
            if row.get("market_regime") == "RISK":
                weight *= 1.35
        if int(row.get("path_broken_positive_20d") or 0) == 1:
            weight *= 1.8
    return weight


def fit_model(model_key, model, x_train, y_train, weights):
    if model_key == "logistic_regression":
        model.fit(x_train, y_train, model__sample_weight=weights)
    else:
        model.fit(x_train, y_train, sample_weight=weights)


def train_weighted_models(rows, output_dir, target_description):
    train_rows, validation_rows, test_rows = split_dataset(rows)
    x_train, y_train = matrix(train_rows), labels(train_rows)
    x_validation, y_validation = matrix(validation_rows), labels(validation_rows)
    x_test, y_test = matrix(test_rows), labels(test_rows)
    weights = np.asarray([sample_weight(row) for row in train_rows], dtype=float)

    if len(set(y_train.tolist())) < 2:
        raise RuntimeError("training split has only one class; need more positive/negative samples")

    result = {}
    for model_key in MODEL_KEYS:
        model = make_model(model_key)
        fit_model(model_key, model, x_train, y_train, weights)
        validation_prob = model.predict_proba(x_validation)[:, 1]
        test_prob = model.predict_proba(x_test)[:, 1]
        metrics = {
            "model_key": model_key,
            "features": FEATURE_COLUMNS,
            "target": target_description,
            "weighting": {
                "2024_plus": 1.25,
                "2025_plus": 2.0,
                "2026_plus": 3.0,
                "industry_etf": 1.15,
                "normal_market": 1.05,
                "risk_hardness_negative": 2.2,
                "crash_freeze_negative": "2.6 * 1.55 * 1.35",
                "risk_path_false_positive_pattern": 2.5,
                "direction_ok_acceptance_broken": 2.4,
                "path_broken_positive_20d": 1.8,
            },
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
            "model_type": model_key,
            "features": FEATURE_COLUMNS,
            "target": metrics["target"],
            "created_at": now(),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        result[model_key] = {
            "model_file": str(joblib_path),
            "metrics_file": str(metrics_path),
            "model_json_file": str(model_json_path),
            "metrics": metrics,
        }
    return result


def rolling_year_validation_weighted(rows, model_key, years=(2024, 2025, 2026)):
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
        fit_model(
            model_key,
            model,
            matrix(train_rows),
            labels(train_rows),
            np.asarray([sample_weight(row) for row in train_rows], dtype=float),
        )
        probabilities = model.predict_proba(matrix(validation_rows))[:, 1]
        payload.update(metric_payload(labels(validation_rows), probabilities))
        payload["status"] = "completed"
        results.append(payload)
    return results


def selection_score(metrics, rolling):
    test_auc = metrics["test"].get("auc") or 0.0
    validation_auc = metrics["validation"].get("auc") or 0.0
    by_year = {item["year"]: item.get("auc") for item in rolling if item.get("status") == "completed"}
    auc_2025 = by_year.get(2025) or validation_auc
    auc_2026 = by_year.get(2026) or test_auc
    return 0.10 * validation_auc + 0.20 * test_auc + 0.25 * auc_2025 + 0.45 * auc_2026


def write_error_cases(rows, model_key, output_dir, year=2026, limit=40):
    year_start = f"{year}-01-01"
    year_end = f"{year}-12-31"
    train_rows = [row for row in rows if row["trade_date"] < year_start]
    evaluation_rows = [row for row in rows if year_start <= row["trade_date"] <= year_end]
    if len(train_rows) < 300 or len(evaluation_rows) < 50:
        return {"year": year, "status": "skipped", "message": "样本不足"}

    model = make_model(model_key)
    fit_model(
        model_key,
        model,
        matrix(train_rows),
        labels(train_rows),
        np.asarray([sample_weight(row) for row in train_rows], dtype=float),
    )
    probabilities = model.predict_proba(matrix(evaluation_rows))[:, 1]
    cases = []
    for row, probability in zip(evaluation_rows, probabilities):
        prediction = 1 if probability >= 0.5 else 0
        target = int(row["target"])
        if prediction == target:
            continue
        case_type = "高分误判" if prediction == 1 else "低分错过"
        cases.append({
            "case_type": case_type,
            "symbol": row["symbol"],
            "name": row["name"],
            "trade_date": row["trade_date"],
            "probability": round(float(probability), 6),
            "target": target,
            "forward_relative_return_20d": row.get("forward_relative_return_20d"),
            "forward_return_20d": row.get("forward_return_20d"),
            "forward_market_return_20d": row.get("forward_market_return_20d"),
            "max_drawdown": row.get("max_drawdown"),
            "market_regime": row.get("market_regime"),
            "universe_type": row.get("universe_type"),
            "trend_phase_code": row.get("trend_phase_code"),
            "ret20": row.get("ret20"),
            "relative_ret20_hs300": row.get("relative_ret20_hs300"),
            "sector_relative_ret20_hs300": row.get("sector_relative_ret20_hs300"),
            "amount_ratio_5_20": row.get("amount_ratio_5_20"),
            "breadth_above_ma120_ratio": row.get("breadth_above_ma120_ratio"),
            "breadth_limit_down_ratio": row.get("breadth_limit_down_ratio"),
            "hardness_drawdown_floor": row.get("hardness_drawdown_floor"),
            "acceptance_broken": row.get("acceptance_broken"),
            "direction_ok_acceptance_broken": row.get("direction_ok_acceptance_broken"),
            "path_broken_positive_20d": row.get("path_broken_positive_20d"),
        })

    false_positive = [case for case in cases if case["case_type"] == "高分误判"]
    false_negative = [case for case in cases if case["case_type"] == "低分错过"]
    false_positive.sort(key=lambda item: item["probability"], reverse=True)
    false_negative.sort(key=lambda item: item["probability"])
    selected = false_positive[:limit] + false_negative[:limit]
    path = Path(output_dir) / f"error_cases_{year}.csv"
    if selected:
        with path.open("w", encoding="utf-8", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=list(selected[0].keys()))
            writer.writeheader()
            writer.writerows(selected)
    return {
        "year": year,
        "status": "completed",
        "path": str(path),
        "total_errors": len(cases),
        "false_positive": len(false_positive),
        "false_negative": len(false_negative),
        "written": len(selected),
    }


def persist_specialist(
    conn,
    domain,
    run_id,
    dataset_path,
    model_results,
    best_model,
    output_dir,
    row_count,
    target_description,
    sample_meta=None,
):
    timestamp = now()
    sample_limits = {"rows": row_count, "specialist": True}
    if sample_meta:
        sample_limits.update(sample_meta)
    for model_key, artifact in model_results.items():
        metrics = artifact["metrics"]
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
                target_description,
                model_key,
                artifact["model_file"],
                artifact["model_json_file"],
                artifact["metrics_file"],
                dataset_path,
                run_id,
                metrics["validation"].get("auc"),
                metrics["test"].get("auc"),
                json.dumps(sample_limits, ensure_ascii=False),
                timestamp,
                timestamp,
            ),
        )
        for rank, item in enumerate(metrics["feature_importance"][:25], start=1):
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
    conn.commit()
    return best_model


def publish_to_capital_rotation(conn, source_domain, target_domain="experiment:capital-rotation"):
    timestamp = now()
    artifacts = conn.execute(
        """
        SELECT *
        FROM model_training_artifacts
        WHERE domain = ?
        """,
        (source_domain,),
    ).fetchall()
    for artifact in artifacts:
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
                target_domain,
                artifact["model_key"],
                artifact["target"],
                artifact["model_type"],
                artifact["model_file"],
                artifact["model_json_file"],
                artifact["metrics_file"],
                artifact["source_feature_db"],
                artifact["run_id"],
                artifact["validation_auc"],
                artifact["test_auc"],
                artifact["sample_limits_json"],
                timestamp,
                timestamp,
            ),
        )
    rows = conn.execute(
        """
        SELECT *
        FROM model_training_feature_importance
        WHERE domain = ?
        """,
        (source_domain,),
    ).fetchall()
    for row in rows:
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
                target_domain,
                row["model_key"],
                row["feature"],
                row["importance"],
                row["raw_importance"],
                row["rank_order"],
                row["run_id"],
                timestamp,
            ),
        )
    conn.commit()


def run_training_task(conn, task, rows, output_root, run_name):
    output_dir = Path(output_root) / task["output_name"] / run_name
    output_dir.mkdir(parents=True, exist_ok=True)
    dataset_path = str(output_dir / "dataset.csv")
    write_dataset(rows, dataset_path)
    run_id = create_run(conn, task["domain"], str(output_dir), len(rows))
    try:
        if len(rows) < 300:
            raise RuntimeError(f"not enough samples: {len(rows)}")
        if len(set(row["target"] for row in rows)) < 2:
            raise RuntimeError("dataset has only one class")

        model_results = train_weighted_models(rows, output_dir, task["target_description"])
        rolling = {
            model_key: rolling_year_validation_weighted(rows, model_key)
            for model_key in MODEL_KEYS
        }
        scores = {
            model_key: selection_score(model_results[model_key]["metrics"], rolling[model_key])
            for model_key in MODEL_KEYS
        }
        for model_key, artifact in model_results.items():
            metrics_path = Path(artifact["metrics_file"])
            metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
            metrics["rolling_validation"] = rolling[model_key]
            metrics["selection_score"] = scores[model_key]
            metrics["selection_policy"] = {
                "validation_auc": 0.10,
                "test_auc": 0.20,
                "rolling_2025_auc": 0.25,
                "rolling_2026_auc": 0.45,
                "reason": "资金轮动和承接纪律更重视当前市场周期，避免旧周期拖偏。"
            }
            metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
            artifact["metrics"] = metrics
        best_model = max(scores.items(), key=lambda item: item[1])[0]
        persist_specialist(
            conn,
            task["domain"],
            run_id,
            dataset_path,
            model_results,
            best_model,
            output_dir,
            len(rows),
            task["target_description"],
            task.get("sample_meta"),
        )
        error_report = write_error_cases(rows, best_model, output_dir, year=2026)
        summary = {
            "experiment": task["experiment"],
            "domain": task["domain"],
            "run_id": run_id,
            "output_dir": str(output_dir),
            "dataset_path": dataset_path,
            "target": task["target_description"],
            "sample_count": len(rows),
            "positive_count": sum(row["target"] for row in rows),
            "positive_rate": sum(row["target"] for row in rows) / len(rows),
            "best_model": best_model,
            "selection_scores": scores,
            "models": {
                model_key: {
                    "validation_auc": model_results[model_key]["metrics"]["validation"].get("auc"),
                    "test_auc": model_results[model_key]["metrics"]["test"].get("auc"),
                    "test_accuracy": model_results[model_key]["metrics"]["test"].get("accuracy"),
                    "rolling_validation": rolling[model_key],
                }
                for model_key in MODEL_KEYS
            },
            "error_report": error_report,
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
    parser.add_argument("--output-root", default="/Volumes/7100/model-training/experiments")
    parser.add_argument("--max-candidates", type=int, default=120000)
    parser.add_argument("--max-samples", type=int, default=50000)
    parser.add_argument("--relative-threshold", type=float, default=0.02)
    parser.add_argument("--direction-absolute-floor", type=float, default=0.0)
    parser.add_argument("--hardness-absolute-floor", type=float, default=-0.02)
    parser.add_argument("--drawdown-floor", type=float, default=-0.08)
    parser.add_argument("--risk-hardness-absolute-floor", type=float, default=0.0)
    parser.add_argument("--risk-drawdown-floor", type=float, default=-0.06)
    parser.add_argument("--hardness-scope", choices=["direction-context", "all"], default="direction-context")
    parser.add_argument("--direction-context-min-signals", type=int, default=3)
    parser.add_argument("--context-relative-ret20-floor", type=float, default=0.02)
    parser.add_argument("--context-relative-ret60-floor", type=float, default=0.04)
    parser.add_argument("--context-sector-relative-ret20-floor", type=float, default=0.04)
    parser.add_argument("--context-ret20-floor", type=float, default=0.05)
    parser.add_argument("--context-amount-ratio-5-20-floor", type=float, default=0.20)
    parser.add_argument("--context-price-pos120-floor", type=float, default=0.70)
    parser.add_argument("--no-risk-backfill", dest="include_risk_backfill", action="store_false")
    parser.add_argument("--risk-backfill-limit", type=int, default=2000)
    parser.add_argument("--publish", action="store_true")
    parser.set_defaults(include_risk_backfill=True)
    args = parser.parse_args()

    run_name = datetime.utcnow().strftime("run-%Y%m%d-%H%M%S")
    base_output_dir = Path(args.output_root) / "capital-rotation-split" / run_name
    base_output_dir.mkdir(parents=True, exist_ok=True)
    direction_target = (
        f"轮动方向：20日相对沪深300跑赢>={args.relative_threshold:.2%}，"
        f"自身20日收益>={args.direction_absolute_floor:.2%}，不纳入回撤约束"
    )
    hardness_scope_note = ""
    if args.hardness_scope == "direction-context":
        hardness_scope_note = (
            f"；训练样本限定为当前截面至少{args.direction_context_min_signals}个方向语境信号"
            "，不使用未来方向标签筛样本"
        )
    hardness_target = (
        f"承接硬度/回撤纪律：未来20日最大回撤>={args.drawdown_floor:.2%}，"
        f"自身20日收益>={args.hardness_absolute_floor:.2%}，不判断方向"
        f"；RISK环境单独收紧为最大回撤>={args.risk_drawdown_floor:.2%}、"
        f"自身20日收益>={args.risk_hardness_absolute_floor:.2%}"
        "；CRASH环境作为总闸冻结区，承接硬度一律按负例训练"
        "；方向有效但过程回撤打穿的样本作为承接负例，20日最终为正也不能洗白路径风险"
        f"{hardness_scope_note}"
    )

    conn = connect(args.db)
    ensure_training_tables(conn)
    try:
        config = dict(EXPERIMENTS["capital-rotation"])
        rows, dataset_path = build_dataset(
            conn,
            "capital-rotation",
            config,
            base_output_dir,
            args.max_candidates,
            args.max_samples,
        )
        risk_backfill_meta = {
            "enabled": bool(args.include_risk_backfill),
            "candidate_count": 0,
            "usable_count": 0,
            "target_count": 0,
            "skipped_count": 0,
            "added_count": 0,
            "merged_count": 0,
            "training_target_count": 0,
            "weak_breadth_count": 0,
            "weak_relative_hs300_count": 0,
            "weak_amount_count": 0,
            "note": "risk_crash_backfill 只并入 capital-rotation 的 RISK 弱承接样本；CRASH 不用于承接放行训练。"
        }
        initialize_backfill_flags(rows)
        if args.include_risk_backfill:
            backfill_rows, loaded_meta = load_risk_backfill_rows(conn, config, args.risk_backfill_limit)
            merged_meta = merge_risk_backfill_rows(rows, backfill_rows)
            risk_backfill_meta.update(loaded_meta)
            risk_backfill_meta.update(merged_meta)
        rows = annotate_rotation_targets(
            rows,
            conn,
            args.relative_threshold,
            args.direction_absolute_floor,
            args.hardness_absolute_floor,
            args.drawdown_floor,
            args.risk_hardness_absolute_floor,
            args.risk_drawdown_floor,
        )
        rows = annotate_hardness_training_context(
            rows,
            args.direction_context_min_signals,
            args.context_relative_ret20_floor,
            args.context_relative_ret60_floor,
            args.context_sector_relative_ret20_floor,
            args.context_ret20_floor,
            args.context_amount_ratio_5_20_floor,
            args.context_price_pos120_floor,
        )
        write_dataset(rows, dataset_path)
        hardness_context_rows = [row for row in rows if int(row.get("hardness_context") or 0) == 1]

        tasks = [
            {
                "experiment": "capital-rotation-direction",
                "domain": "experiment:capital-rotation-direction",
                "output_name": "capital-rotation-direction",
                "target_column": "direction_target",
                "target_description": direction_target,
            },
            {
                "experiment": "capital-rotation-hardness",
                "domain": "experiment:capital-rotation-hardness",
                "output_name": "capital-rotation-hardness",
                "target_column": "hardness_target",
                "target_description": hardness_target,
                "row_filter": "hardness_context" if args.hardness_scope == "direction-context" else None,
                "sample_meta": {
                    "hardness_scope": args.hardness_scope,
                    "direction_context_min_signals": args.direction_context_min_signals,
                    "context_relative_ret20_floor": args.context_relative_ret20_floor,
                    "context_relative_ret60_floor": args.context_relative_ret60_floor,
                    "context_sector_relative_ret20_floor": args.context_sector_relative_ret20_floor,
                    "context_ret20_floor": args.context_ret20_floor,
                    "context_amount_ratio_5_20_floor": args.context_amount_ratio_5_20_floor,
                    "context_price_pos120_floor": args.context_price_pos120_floor,
                    "risk_hardness_absolute_floor": args.risk_hardness_absolute_floor,
                    "risk_drawdown_floor": args.risk_drawdown_floor,
                    "context_rows": len(hardness_context_rows),
                    "risk_backfill": risk_backfill_meta,
                },
            },
        ]
        task_summaries = []
        for task in tasks:
            source_rows = task_source_rows(rows, task)
            task_rows = rows_for_target(source_rows, task["target_column"])
            task_summaries.append(run_training_task(conn, task, task_rows, args.output_root, run_name))

        summary = {
            "experiment": "capital-rotation-split",
            "output_dir": str(base_output_dir),
            "dataset_path": dataset_path,
            "sample_count": len(rows),
            "targets": {
                "direction": direction_target,
                "hardness": hardness_target,
            },
            "direction_positive_count": sum(row["direction_target"] for row in rows),
            "direction_positive_rate": sum(row["direction_target"] for row in rows) / len(rows),
            "hardness_positive_count": sum(row["hardness_target"] for row in rows),
            "hardness_positive_rate": sum(row["hardness_target"] for row in rows) / len(rows),
            "hardness_scope": args.hardness_scope,
            "risk_hardness_absolute_floor": args.risk_hardness_absolute_floor,
            "risk_drawdown_floor": args.risk_drawdown_floor,
            "hardness_context_count": len(hardness_context_rows),
            "hardness_context_rate": len(hardness_context_rows) / len(rows),
            "hardness_context_positive_count": sum(row["hardness_target"] for row in hardness_context_rows),
            "hardness_context_positive_rate": (
                sum(row["hardness_target"] for row in hardness_context_rows) / len(hardness_context_rows)
                if hardness_context_rows else 0
            ),
            "risk_backfill": risk_backfill_meta,
            "acceptance_broken_count": sum(row["acceptance_broken"] for row in rows),
            "direction_ok_acceptance_broken_count": sum(row["direction_ok_acceptance_broken"] for row in rows),
            "path_broken_positive_20d_count": sum(row["path_broken_positive_20d"] for row in rows),
            "risk_path_false_positive_pattern_count": sum(row["risk_path_false_positive_pattern"] for row in rows),
            "crash_freeze_negative_count": sum(row["crash_freeze_negative"] for row in rows),
            "hardness_context_direction_ok_acceptance_broken_count": sum(row["direction_ok_acceptance_broken"] for row in hardness_context_rows),
            "hardness_context_path_broken_positive_20d_count": sum(row["path_broken_positive_20d"] for row in hardness_context_rows),
            "hardness_context_risk_path_false_positive_pattern_count": sum(row["risk_path_false_positive_pattern"] for row in hardness_context_rows),
            "hardness_context_crash_freeze_negative_count": sum(row["crash_freeze_negative"] for row in hardness_context_rows),
            "combined_positive_count": sum(row["combined_target"] for row in rows),
            "combined_positive_rate": sum(row["combined_target"] for row in rows) / len(rows),
            "tasks": task_summaries,
            "published_to_capital_rotation": bool(args.publish),
            "completed_at": now(),
        }
        if args.publish:
            publish_to_capital_rotation(conn, "experiment:capital-rotation-direction")
        (base_output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"success": True, "data": summary}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
