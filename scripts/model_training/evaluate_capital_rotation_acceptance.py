#!/usr/bin/env python3
import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path

import joblib
import numpy as np

from score_capital_rotation import (
    action_label,
    adjust_hardness_for_acceptance_discipline,
    artifact_payload,
    crowding_label,
    model_features,
    pick_artifact,
    safe_float,
)
from train_experiment_models import FEATURE_COLUMNS, connect


def round_or_none(value, digits=4):
    if value is None:
        return None
    try:
        numeric = float(value)
    except Exception:
        return None
    if not math.isfinite(numeric):
        return None
    return round(numeric, digits)


def percent_or_none(value):
    rounded = round_or_none(value, 4)
    if rounded is None:
        return None
    return round(rounded * 100, 2)


def load_json(path):
    if not path or not Path(path).exists():
        return {}
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}


def load_rows(path, from_date, max_rows):
    rows = []
    with Path(path).open("r", encoding="utf-8") as file:
        reader = csv.DictReader(file)
        for row in reader:
            if from_date and row.get("trade_date", "") < from_date:
                continue
            rows.append(row)
            if max_rows and len(rows) >= max_rows:
                break
    return rows


def matrix(rows, feature_names):
    names = feature_names or FEATURE_COLUMNS
    return np.asarray(
        [[safe_float(row.get(name)) for name in names] for row in rows],
        dtype=np.float32,
    )


def bucket_direction(probability, high, watch):
    if probability >= high:
        return "方向高"
    if probability >= watch:
        return "方向中"
    return "方向低"


def bucket_hardness(probability, pass_line, weak_line):
    if probability >= pass_line:
        return "承接高"
    if probability >= weak_line:
        return "承接中"
    return "承接低"


def drawdown_floor_for_regime(row):
    regime = str(row.get("market_regime") or "").upper()
    if regime == "RISK":
        return -0.06
    if regime == "CRASH":
        return -0.08
    return -0.08


def hits_drawdown_discipline(row):
    max_drawdown = safe_float(row.get("max_drawdown"), None)
    return max_drawdown is not None and max_drawdown <= drawdown_floor_for_regime(row)


def direction_worked(row):
    ret20 = safe_float(row.get("forward_return_20d"), None)
    max_forward_return = safe_float(row.get("max_forward_return"), None)
    return (
        (ret20 is not None and ret20 > 0)
        or (max_forward_return is not None and max_forward_return >= 0.06)
    )


def stats_for(rows):
    def values(key):
        return [safe_float(row.get(key), None) for row in rows if safe_float(row.get(key), None) is not None]

    def avg(vals):
        return sum(vals) / len(vals) if vals else None

    def median(vals):
        if not vals:
            return None
        ordered = sorted(vals)
        middle = len(ordered) // 2
        if len(ordered) % 2 == 0:
            return (ordered[middle - 1] + ordered[middle]) / 2
        return ordered[middle]

    ret5 = values("forward_return_5d")
    ret10 = values("forward_return_10d")
    ret20 = values("forward_return_20d")
    max_drawdowns = values("max_drawdown")
    positive20 = [value for value in ret20 if value > 0]
    fail_line = [row for row in rows if hits_drawdown_discipline(row)]
    path_broken_positive20 = [
        row for row in rows
        if hits_drawdown_discipline(row) and safe_float(row.get("forward_return_20d"), None) is not None
        and safe_float(row.get("forward_return_20d")) > 0
    ]
    direction_ok_broken = [
        row for row in rows
        if direction_worked(row) and hits_drawdown_discipline(row)
    ]
    return {
        "sample_count": len(rows),
        "avg_direction_score": round_or_none(avg([safe_float(row.get("direction_probability")) * 100 for row in rows]), 2),
        "avg_hardness_score": round_or_none(avg([safe_float(row.get("hardness_probability")) * 100 for row in rows]), 2),
        "win_rate_20d": round_or_none(len(positive20) / len(ret20) * 100 if ret20 else None, 2),
        "avg_return_5d": percent_or_none(avg(ret5)),
        "avg_return_10d": percent_or_none(avg(ret10)),
        "avg_return_20d": percent_or_none(avg(ret20)),
        "median_return_20d": percent_or_none(median(ret20)),
        "avg_max_drawdown": percent_or_none(avg(max_drawdowns)),
        "fail_line_rate": round_or_none(len(fail_line) / len(max_drawdowns) * 100 if max_drawdowns else None, 2),
        "path_broken_positive_20d_count": len(path_broken_positive20),
        "path_broken_positive_20d_rate": round_or_none(len(path_broken_positive20) / len(rows) * 100 if rows else None, 2),
        "direction_ok_broken_count": len(direction_ok_broken),
        "direction_ok_broken_rate": round_or_none(len(direction_ok_broken) / len(rows) * 100 if rows else None, 2),
    }


def model_accepts(row, args):
    return (
        safe_float(row.get("direction_probability")) >= args.direction_high
        and safe_float(row.get("hardness_probability")) >= args.hardness_pass
    )


def raw_model_accepts(row, args):
    raw_hardness = row.get("raw_hardness_probability")
    if raw_hardness is None:
        raw_hardness = row.get("hardness_probability")
    return (
        safe_float(row.get("direction_probability")) >= args.direction_high
        and safe_float(raw_hardness) >= args.hardness_pass
    )


def action_accepts(row):
    return (
        row.get("rotation_label") == "方向增强"
        and row.get("discipline_label") == "承接通过"
    )


def is_bad_acceptance(row):
    ret20 = safe_float(row.get("forward_return_20d"), None)
    return (
        (ret20 is not None and ret20 <= 0)
        or hits_drawdown_discipline(row)
    )


def acceptance_stats_for(rows, args):
    payload = stats_for(rows)
    selected = [row for row in rows if model_accepts(row, args)]
    raw_selected = [row for row in rows if raw_model_accepts(row, args)]
    action_selected = [row for row in rows if action_accepts(row)]

    def values(key, items):
        return [safe_float(row.get(key), None) for row in items if safe_float(row.get(key), None) is not None]

    def avg(vals):
        return sum(vals) / len(vals) if vals else None

    selected_ret20 = values("forward_return_20d", selected)
    selected_drawdowns = values("max_drawdown", selected)
    selected_positive20 = [value for value in selected_ret20 if value > 0]
    bad_selected = [row for row in selected if is_bad_acceptance(row)]
    bad_raw_selected = [row for row in raw_selected if is_bad_acceptance(row)]
    path_broken_selected = [
        row for row in selected
        if safe_float(row.get("forward_return_20d"), None) is not None
        and safe_float(row.get("forward_return_20d")) > 0
        and hits_drawdown_discipline(row)
    ]
    direction_ok_broken_selected = [
        row for row in selected
        if direction_worked(row) and hits_drawdown_discipline(row)
    ]
    action_ret20 = values("forward_return_20d", action_selected)
    action_drawdowns = values("max_drawdown", action_selected)
    action_positive20 = [value for value in action_ret20 if value > 0]
    bad_action_selected = [row for row in action_selected if is_bad_acceptance(row)]
    path_broken_action_selected = [
        row for row in action_selected
        if safe_float(row.get("forward_return_20d"), None) is not None
        and safe_float(row.get("forward_return_20d")) > 0
        and hits_drawdown_discipline(row)
    ]
    payload.update({
        "selected_count": len(selected),
        "raw_selected_count": len(raw_selected),
        "selected_win_rate_20d": round_or_none(len(selected_positive20) / len(selected_ret20) * 100 if selected_ret20 else None, 2),
        "selected_avg_return_20d": percent_or_none(avg(selected_ret20)),
        "selected_avg_max_drawdown": percent_or_none(avg(selected_drawdowns)),
        "false_positive_count": len(bad_selected),
        "false_positive_rate": round_or_none(len(bad_selected) / len(selected) * 100 if selected else None, 2),
        "raw_false_positive_count": len(bad_raw_selected),
        "raw_false_positive_rate": round_or_none(len(bad_raw_selected) / len(raw_selected) * 100 if raw_selected else None, 2),
        "path_broken_positive_20d_count": len(path_broken_selected),
        "path_broken_positive_20d_rate": round_or_none(len(path_broken_selected) / len(selected) * 100 if selected else None, 2),
        "direction_ok_broken_count": len(direction_ok_broken_selected),
        "direction_ok_broken_rate": round_or_none(len(direction_ok_broken_selected) / len(selected) * 100 if selected else None, 2),
        "action_pass_count": len(action_selected),
        "action_pass_win_rate_20d": round_or_none(len(action_positive20) / len(action_ret20) * 100 if action_ret20 else None, 2),
        "action_pass_avg_return_20d": percent_or_none(avg(action_ret20)),
        "action_pass_avg_max_drawdown": percent_or_none(avg(action_drawdowns)),
        "action_false_positive_count": len(bad_action_selected),
        "action_false_positive_rate": round_or_none(len(bad_action_selected) / len(action_selected) * 100 if action_selected else None, 2),
        "action_path_broken_positive_20d_count": len(path_broken_action_selected),
        "action_path_broken_positive_20d_rate": round_or_none(len(path_broken_action_selected) / len(action_selected) * 100 if action_selected else None, 2),
    })
    return payload


def market_regime_rows(enriched, args):
    order = {"NORMAL": 0, "RISK": 1, "CRASH": 2, "UNKNOWN": 3}
    grouped = defaultdict(list)
    for row in enriched:
        grouped[row.get("market_regime") or "UNKNOWN"].append(row)
    rows = []
    for regime, items in grouped.items():
        payload = acceptance_stats_for(items, args)
        payload["market_regime"] = regime
        payload["bucket"] = regime
        rows.append(payload)
    rows.sort(key=lambda item: (order.get(item["market_regime"], 99), item["market_regime"]))
    return rows


def regime_readiness(enriched, args):
    rows = market_regime_rows(enriched, args)
    by_regime = {row["market_regime"]: row for row in rows}
    min_samples = 500
    min_selected = 20
    gaps = []
    for regime in ("RISK", "CRASH"):
        item = by_regime.get(regime)
        if not item:
            gaps.append(f"{regime} 没有样本")
            continue
        if item["sample_count"] < min_samples:
            gaps.append(f"{regime} 样本 {item['sample_count']} < {min_samples}")
        if regime == "RISK" and (item.get("raw_selected_count") or 0) < min_selected:
            gaps.append(f"{regime} 原始方向+承接双高样本 {item.get('raw_selected_count') or 0} < {min_selected}")

    normal_count = by_regime.get("NORMAL", {}).get("sample_count", 0) or 0
    total = len(enriched)
    if total and normal_count / total >= 0.75:
        gaps.append("NORMAL 占比过高，模型可能更懂顺风局")

    return {
        "status": "need_risk_crash_backfill" if gaps else "ready",
        "need_backfill": bool(gaps),
        "min_samples_per_regime": min_samples,
        "min_selected_per_regime": min_selected,
        "gaps": gaps,
        "suggestion": (
            "优先补 RISK/CRASH 对应区间和板块样本，不盲目扩全量。"
            if gaps else
            "NORMAL/RISK/CRASH 样本暂够；RISK 看双高稳定性，CRASH 只看高分打脸和总闸冻结纪律。"
        ),
    }


def average_feature(rows, key):
    values = [safe_float(row.get(key), None) for row in rows if safe_float(row.get(key), None) is not None]
    return round_or_none(sum(values) / len(values), 4) if values else None


def count_when(rows, predicate):
    return sum(1 for row in rows if predicate(row))


def risk_false_positive_review(enriched, args):
    raw_selected = [
        row for row in enriched
        if row.get("market_regime") == "RISK" and raw_model_accepts(row, args)
    ]
    raw_false_positive = [row for row in raw_selected if is_bad_acceptance(row)]
    selected = [
        row for row in enriched
        if row.get("market_regime") == "RISK" and model_accepts(row, args)
    ]
    false_positive = [row for row in selected if is_bad_acceptance(row)]
    action_selected = [row for row in selected if action_accepts(row)]
    action_false_positive = [row for row in action_selected if is_bad_acceptance(row)]
    guarded_false_positive = [row for row in false_positive if not action_accepts(row)]
    if not selected:
        return {
            "selected_count": 0,
            "raw_selected_count": len(raw_selected),
            "false_positive_count": 0,
            "raw_false_positive_count": len(raw_false_positive),
            "false_positive_rate": None,
            "raw_false_positive_rate": round_or_none(len(raw_false_positive) / len(raw_selected) * 100 if raw_selected else None, 2),
            "action_pass_count": 0,
            "action_false_positive_count": 0,
            "action_false_positive_rate": None,
            "guarded_false_positive_count": 0,
            "patterns": [],
            "sample_cases": [],
            "label_suggestion": "RISK 暂无方向+承接双高样本，先等样本或回补风险区间。"
        }

    patterns = [
        {
            "name": "短期高位或拥挤",
            "hit_count": count_when(
                raw_false_positive,
                lambda row: safe_float(row.get("price_pos120")) >= 0.75
                or safe_float(row.get("distance_ma60")) >= 0.08
                or str(row.get("crowding_label") or "") in ("高位防追", "长周期高位")
            ),
            "rule": "price_pos120>=0.75 / distance_ma60>=8% / 拥挤标签"
        },
        {
            "name": "量能承接不足",
            "hit_count": count_when(
                raw_false_positive,
                lambda row: safe_float(row.get("amount_ratio_5_20")) < -0.2
                or safe_float(row.get("amount_ratio_20_60")) < -0.2
            ),
            "rule": "amount_ratio 是变化率；低于 -20% 才算缩量承接不足"
        },
        {
            "name": "市场广度偏弱",
            "hit_count": count_when(
                raw_false_positive,
                lambda row: safe_float(row.get("breadth_above_ma60_ratio")) < 0.45
                or safe_float(row.get("breadth_down_ratio")) > 0.55
            ),
            "rule": "breadth_above_ma60_ratio<45% 或 breadth_down_ratio>55%"
        },
        {
            "name": "自身先手涨幅过大",
            "hit_count": count_when(
                raw_false_positive,
                lambda row: safe_float(row.get("ret20")) >= 0.12
                or safe_float(row.get("ret60")) >= 0.25
            ),
            "rule": "ret20>=12% 或 ret60>=25%"
        },
    ]
    for item in patterns:
        item["hit_rate"] = round_or_none(item["hit_count"] / len(raw_false_positive) * 100 if raw_false_positive else None, 2)

    raw_false_positive.sort(
        key=lambda row: (
            -safe_float(row.get("direction_probability")),
            -safe_float(row.get("raw_hardness_probability") or row.get("hardness_probability")),
            safe_float(row.get("forward_return_20d")),
        )
    )
    sample_cases = []
    for row in raw_false_positive[:12]:
        sample_cases.append({
            "symbol": row.get("symbol"),
            "name": row.get("name"),
            "trade_date": row.get("trade_date"),
            "direction_score": int(round(safe_float(row.get("direction_probability")) * 100)),
            "hardness_score": int(round(safe_float(row.get("hardness_probability")) * 100)),
            "raw_hardness_score": int(round(safe_float(row.get("raw_hardness_probability") or row.get("hardness_probability")) * 100)),
            "forward_return_20d": percent_or_none(safe_float(row.get("forward_return_20d"), None)),
            "max_drawdown": percent_or_none(safe_float(row.get("max_drawdown"), None)),
            "ret20": percent_or_none(safe_float(row.get("ret20"), None)),
            "relative_ret20_hs300": percent_or_none(safe_float(row.get("relative_ret20_hs300"), None)),
            "amount_ratio_5_20": round_or_none(safe_float(row.get("amount_ratio_5_20"), None), 2),
            "price_pos120": round_or_none(safe_float(row.get("price_pos120"), None), 2),
            "drawdown_floor": percent_or_none(drawdown_floor_for_regime(row)),
            "path_broken_positive_20d": (
                safe_float(row.get("forward_return_20d"), None) is not None
                and safe_float(row.get("forward_return_20d")) > 0
                and hits_drawdown_discipline(row)
            ),
            "discipline_label": row.get("discipline_label"),
            "rotation_label": row.get("rotation_label"),
        })

    return {
        "selected_count": len(selected),
        "raw_selected_count": len(raw_selected),
        "false_positive_count": len(false_positive),
        "false_positive_rate": round_or_none(len(false_positive) / len(selected) * 100, 2),
        "raw_false_positive_count": len(raw_false_positive),
        "raw_false_positive_rate": round_or_none(len(raw_false_positive) / len(raw_selected) * 100 if raw_selected else None, 2),
        "action_pass_count": len(action_selected),
        "action_false_positive_count": len(action_false_positive),
        "action_false_positive_rate": round_or_none(len(action_false_positive) / len(action_selected) * 100 if action_selected else None, 2),
        "guarded_false_positive_count": len(guarded_false_positive),
        "feature_average": {
            "false_positive": {
                "ret20": percent_or_none(average_feature(raw_false_positive, "ret20")),
                "relative_ret20_hs300": percent_or_none(average_feature(raw_false_positive, "relative_ret20_hs300")),
                "amount_ratio_5_20": round_or_none(average_feature(raw_false_positive, "amount_ratio_5_20"), 2),
                "price_pos120": round_or_none(average_feature(raw_false_positive, "price_pos120"), 2),
                "breadth_above_ma60_ratio": percent_or_none(average_feature(raw_false_positive, "breadth_above_ma60_ratio")),
            },
            "selected": {
                "ret20": percent_or_none(average_feature(selected, "ret20")),
                "relative_ret20_hs300": percent_or_none(average_feature(selected, "relative_ret20_hs300")),
                "amount_ratio_5_20": round_or_none(average_feature(selected, "amount_ratio_5_20"), 2),
                "price_pos120": round_or_none(average_feature(selected, "price_pos120"), 2),
                "breadth_above_ma60_ratio": percent_or_none(average_feature(selected, "breadth_above_ma60_ratio")),
            }
        },
        "patterns": patterns,
        "sample_cases": sample_cases,
        "label_suggestion": "RISK 环境下承接标签应比 NORMAL 更硬：未来20日收益不低于0，最大回撤不低于 -6%，并提高 RISK 负样本权重。"
    }


def risk_discipline_interception_review(enriched, args):
    raw_selected = [
        row for row in enriched
        if row.get("market_regime") == "RISK" and raw_model_accepts(row, args)
    ]
    selected = [
        row for row in enriched
        if row.get("market_regime") == "RISK" and model_accepts(row, args)
    ]
    blocked = [row for row in raw_selected if not model_accepts(row, args)]
    caught_bad = [row for row in blocked if is_bad_acceptance(row)]
    path_broken_positive = [
        row for row in blocked
        if safe_float(row.get("forward_return_20d"), None) is not None
        and safe_float(row.get("forward_return_20d")) > 0
        and hits_drawdown_discipline(row)
    ]
    positive_not_broken = [
        row for row in blocked
        if safe_float(row.get("forward_return_20d"), None) is not None
        and safe_float(row.get("forward_return_20d")) > 0
        and not hits_drawdown_discipline(row)
    ]

    def avg_percent(rows, key):
        return percent_or_none(average_feature(rows, key))

    def case_label(row):
        if is_bad_acceptance(row):
            if (
                safe_float(row.get("forward_return_20d"), None) is not None
                and safe_float(row.get("forward_return_20d")) > 0
                and hits_drawdown_discipline(row)
            ):
                return "后验为正但路径打穿"
            return "纪律抓住误判"
        return "后验为正，继续复核"

    blocked.sort(
        key=lambda row: (
            0 if is_bad_acceptance(row) else 1,
            0 if case_label(row) == "后验为正但路径打穿" else 1,
            -safe_float(row.get("direction_probability")),
            -safe_float(row.get("raw_hardness_probability") or row.get("hardness_probability")),
        )
    )
    sample_cases = []
    for row in blocked[:16]:
        raw_hardness = safe_float(row.get("raw_hardness_probability") or row.get("hardness_probability"), None)
        adjusted_hardness = safe_float(row.get("hardness_probability"), None)
        sample_cases.append({
            "symbol": row.get("symbol"),
            "name": row.get("name"),
            "trade_date": row.get("trade_date"),
            "direction_score": int(round(safe_float(row.get("direction_probability")) * 100)),
            "raw_hardness_score": int(round(raw_hardness * 100)) if raw_hardness is not None else None,
            "hardness_score": int(round(adjusted_hardness * 100)) if adjusted_hardness is not None else None,
            "discipline_delta": round_or_none((adjusted_hardness - raw_hardness) * 100 if raw_hardness is not None and adjusted_hardness is not None else None, 2),
            "forward_return_20d": percent_or_none(safe_float(row.get("forward_return_20d"), None)),
            "max_drawdown": percent_or_none(safe_float(row.get("max_drawdown"), None)),
            "drawdown_floor": percent_or_none(drawdown_floor_for_regime(row)),
            "ret20": percent_or_none(safe_float(row.get("ret20"), None)),
            "relative_ret20_hs300": percent_or_none(safe_float(row.get("relative_ret20_hs300"), None)),
            "amount_ratio_5_20": round_or_none(safe_float(row.get("amount_ratio_5_20"), None), 2),
            "breadth_above_ma60_ratio": percent_or_none(safe_float(row.get("breadth_above_ma60_ratio"), None)),
            "breadth_down_ratio": percent_or_none(safe_float(row.get("breadth_down_ratio"), None)),
            "review_label": case_label(row),
            "discipline_label": row.get("discipline_label"),
            "discipline_reason": row.get("discipline_reason"),
            "rotation_label": row.get("rotation_label"),
        })

    return {
        "raw_selected_count": len(raw_selected),
        "selected_count": len(selected),
        "blocked_count": len(blocked),
        "caught_bad_count": len(caught_bad),
        "caught_bad_rate": round_or_none(len(caught_bad) / len(blocked) * 100 if blocked else None, 2),
        "path_broken_positive_count": len(path_broken_positive),
        "positive_not_broken_count": len(positive_not_broken),
        "blocked_avg_return_20d": avg_percent(blocked, "forward_return_20d"),
        "blocked_avg_max_drawdown": avg_percent(blocked, "max_drawdown"),
        "caught_avg_return_20d": avg_percent(caught_bad, "forward_return_20d"),
        "caught_avg_max_drawdown": avg_percent(caught_bad, "max_drawdown"),
        "sample_cases": sample_cases,
        "note": "这里专门看 RISK 里原始方向+承接双高、但被承接纪律压下来的样本；后续结果只用来校准纪律，不用来否定当时风控。",
    }


def crash_false_positive_review(enriched, args):
    selected = [
        row for row in enriched
        if row.get("market_regime") == "CRASH" and model_accepts(row, args)
    ]
    false_positive = [row for row in selected if is_bad_acceptance(row)]
    if not selected:
        return {
            "selected_count": 0,
            "false_positive_count": 0,
            "false_positive_rate": None,
            "sample_cases": [],
            "label_suggestion": "CRASH 当前没有模型双高样本；继续把 CRASH 当总闸冻结区，不给承接口。"
        }

    def has_weak_breadth(row):
        breadth = safe_float(row.get("breadth_above_ma60_ratio"), None)
        down = safe_float(row.get("breadth_down_ratio"), None)
        return (breadth is not None and 0 < breadth < 0.45) or (down is not None and down > 0.55)

    def has_path_broken(row):
        return safe_float(row.get("forward_return_20d"), None) is not None and (
            safe_float(row.get("forward_return_20d")) > 0 and hits_drawdown_discipline(row)
        )

    patterns = [
        {
            "name": "最终为正但路径打穿",
            "hit_count": count_when(false_positive, has_path_broken),
            "rule": "20日为正，但最大回撤打穿 CRASH -8% 纪律"
        },
        {
            "name": "20日结果为负",
            "hit_count": count_when(false_positive, lambda row: safe_float(row.get("forward_return_20d"), None) is not None and safe_float(row.get("forward_return_20d")) <= 0),
            "rule": "方向+承接双高但 20 日收益不正"
        },
        {
            "name": "市场广度偏弱",
            "hit_count": count_when(false_positive, has_weak_breadth),
            "rule": "breadth_above_ma60_ratio<45% 或 breadth_down_ratio>55%"
        },
        {
            "name": "短期高位或偏离",
            "hit_count": count_when(false_positive, lambda row: safe_float(row.get("price_pos120")) >= 0.75 or safe_float(row.get("distance_ma60")) >= 0.08),
            "rule": "price_pos120>=0.75 或 distance_ma60>=8%"
        },
    ]
    for item in patterns:
        item["hit_rate"] = round_or_none(item["hit_count"] / len(false_positive) * 100 if false_positive else None, 2)

    false_positive.sort(
        key=lambda row: (
            -safe_float(row.get("direction_probability")),
            -safe_float(row.get("hardness_probability")),
            safe_float(row.get("max_drawdown")),
        )
    )
    sample_cases = []
    for row in false_positive[:12]:
        sample_cases.append({
            "symbol": row.get("symbol"),
            "name": row.get("name"),
            "trade_date": row.get("trade_date"),
            "direction_score": int(round(safe_float(row.get("direction_probability")) * 100)),
            "hardness_score": int(round(safe_float(row.get("hardness_probability")) * 100)),
            "forward_return_20d": percent_or_none(safe_float(row.get("forward_return_20d"), None)),
            "max_drawdown": percent_or_none(safe_float(row.get("max_drawdown"), None)),
            "ret20": percent_or_none(safe_float(row.get("ret20"), None)),
            "relative_ret20_hs300": percent_or_none(safe_float(row.get("relative_ret20_hs300"), None)),
            "amount_ratio_5_20": round_or_none(safe_float(row.get("amount_ratio_5_20"), None), 2),
            "price_pos120": round_or_none(safe_float(row.get("price_pos120"), None), 2),
            "path_broken_positive_20d": has_path_broken(row),
            "discipline_label": row.get("discipline_label"),
            "rotation_label": row.get("rotation_label"),
        })

    return {
        "selected_count": len(selected),
        "false_positive_count": len(false_positive),
        "false_positive_rate": round_or_none(len(false_positive) / len(selected) * 100, 2),
        "patterns": patterns,
        "sample_cases": sample_cases,
        "label_suggestion": "CRASH 不能训练出承接口；方向可以记正例，承接硬度应作为冻结区负例，避免总闸下模型双高误导。"
    }


def enrich_rows(rows, direction_model, direction_features, hardness_model, hardness_features, args):
    direction_probabilities = direction_model.predict_proba(matrix(rows, direction_features))[:, 1]
    hardness_probabilities = hardness_model.predict_proba(matrix(rows, hardness_features))[:, 1]
    enriched = []
    for row, direction_probability, hardness_probability in zip(rows, direction_probabilities, hardness_probabilities):
        item = dict(row)
        direction_probability = float(direction_probability)
        raw_hardness_probability = float(hardness_probability)
        feature_map = {name: safe_float(item.get(name)) for name in FEATURE_COLUMNS}
        market_regime = item.get("market_regime") or "UNKNOWN"
        hardness_probability = adjust_hardness_for_acceptance_discipline(
            direction_probability,
            raw_hardness_probability,
            feature_map,
            market_regime,
        )
        hardness_probability = float(hardness_probability) if hardness_probability is not None else 0.0
        action, action_reason, discipline, discipline_reason = action_label(
            direction_probability,
            hardness_probability,
            feature_map,
            market_regime,
        )
        crowding, crowding_reason = crowding_label(feature_map)
        item["direction_probability"] = direction_probability
        item["hardness_probability"] = hardness_probability
        item["raw_hardness_probability"] = raw_hardness_probability
        item["direction_bucket"] = bucket_direction(direction_probability, args.direction_high, args.direction_watch)
        item["hardness_bucket"] = bucket_hardness(hardness_probability, args.hardness_pass, args.hardness_weak)
        item["bucket"] = f'{item["direction_bucket"]}/{item["hardness_bucket"]}'
        item["discipline_label"] = discipline
        item["discipline_reason"] = discipline_reason
        item["rotation_label"] = action
        item["rotation_reason"] = action_reason
        item["crowding_label"] = crowding
        item["crowding_reason"] = crowding_reason
        enriched.append(item)
    return enriched


def bucket_rows(enriched, key):
    grouped = defaultdict(list)
    for row in enriched:
        grouped[row.get(key) or "未分组"].append(row)
    rows = []
    for name, items in grouped.items():
        payload = stats_for(items)
        payload["bucket"] = name
        rows.append(payload)
    rows.sort(key=lambda item: (
        -item["sample_count"],
        -(item.get("avg_direction_score") or 0),
        -(item.get("avg_hardness_score") or 0),
    ))
    return rows


def year_rows(enriched):
    grouped = defaultdict(list)
    for row in enriched:
        trade_date = row.get("trade_date") or ""
        grouped[trade_date[:4] or "未知"].append(row)
    rows = []
    for year, items in grouped.items():
        payload = stats_for(items)
        payload["year"] = year
        rows.append(payload)
    rows.sort(key=lambda item: item["year"], reverse=True)
    return rows


def sample_rows(enriched, limit):
    ordered = sorted(
        enriched,
        key=lambda row: (
            -safe_float(row.get("direction_probability")),
            -safe_float(row.get("hardness_probability")),
            row.get("trade_date") or "",
        ),
    )
    rows = []
    for row in ordered[:limit]:
        rows.append({
            "symbol": row.get("symbol"),
            "name": row.get("name"),
            "asset_type": row.get("asset_type"),
            "universe_type": row.get("universe_type"),
            "trade_date": row.get("trade_date"),
            "market_regime": row.get("market_regime"),
            "direction_score": int(round(safe_float(row.get("direction_probability")) * 100)),
            "hardness_score": int(round(safe_float(row.get("hardness_probability")) * 100)),
            "bucket": row.get("bucket"),
            "discipline_label": row.get("discipline_label"),
            "rotation_label": row.get("rotation_label"),
            "crowding_label": row.get("crowding_label"),
            "forward_return_5d": percent_or_none(safe_float(row.get("forward_return_5d"), None)),
            "forward_return_10d": percent_or_none(safe_float(row.get("forward_return_10d"), None)),
            "forward_return_20d": percent_or_none(safe_float(row.get("forward_return_20d"), None)),
            "max_drawdown": percent_or_none(safe_float(row.get("max_drawdown"), None)),
        })
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--from-date", default="2024-01-01")
    parser.add_argument("--max-rows", type=int, default=60000)
    parser.add_argument("--sample-limit", type=int, default=40)
    parser.add_argument("--direction-high", type=float, default=0.62)
    parser.add_argument("--direction-watch", type=float, default=0.54)
    parser.add_argument("--hardness-pass", type=float, default=0.58)
    parser.add_argument("--hardness-weak", type=float, default=0.45)
    args = parser.parse_args()

    conn = connect(args.db)
    try:
        direction_artifact = (
            pick_artifact(conn, "experiment:capital-rotation-direction", required=False)
            or pick_artifact(conn, "experiment:capital-rotation")
        )
        hardness_artifact = pick_artifact(conn, "experiment:capital-rotation-hardness", required=True)
        source_dataset = direction_artifact["source_feature_db"]
        rows = load_rows(source_dataset, args.from_date, args.max_rows)
        if not rows:
            raise RuntimeError("没有可用于验收的历史样本。")

        direction_model = joblib.load(direction_artifact["model_file"])
        hardness_model = joblib.load(hardness_artifact["model_file"])
        enriched = enrich_rows(
            rows,
            direction_model,
            model_features(direction_artifact),
            hardness_model,
            model_features(hardness_artifact),
            args,
        )

        payload = {
            "artifacts": {
                "direction": artifact_payload(direction_artifact),
                "hardness": artifact_payload(hardness_artifact),
            },
            "source_dataset": source_dataset,
            "from_date": args.from_date,
            "thresholds": {
                "direction_high": args.direction_high,
                "direction_watch": args.direction_watch,
                "hardness_pass": args.hardness_pass,
                "hardness_weak": args.hardness_weak,
                "fail_line_drawdown": -0.08,
                "risk_fail_line_drawdown": -0.06,
                "crash_fail_line_drawdown": -0.08,
            },
            "summary": stats_for(enriched),
            "market_regime_buckets": market_regime_rows(enriched, args),
            "regime_readiness": regime_readiness(enriched, args),
            "risk_false_positive_review": risk_false_positive_review(enriched, args),
            "risk_discipline_interception_review": risk_discipline_interception_review(enriched, args),
            "crash_false_positive_review": crash_false_positive_review(enriched, args),
            "score_buckets": bucket_rows(enriched, "bucket"),
            "discipline_buckets": bucket_rows(enriched, "discipline_label"),
            "yearly": year_rows(enriched),
            "samples": sample_rows(enriched, args.sample_limit),
            "notes": [
                "先按 NORMAL / RISK / CRASH 分层验收，避免模型只学会顺风局。",
                "方向分和承接分来自当前已训练模型；历史未来收益只做验收标签。",
                "误判率口径：方向高且承接过线，但未来20日收益不正或最大回撤跌破纪律线；RISK 用 -6%，CRASH / NORMAL 用 -8%。",
                "纪律后误判率：在模型双高基础上再经过 RISK 量能、广度和高位纪律过滤后的误判率。",
                "路径打穿样本：即使未来20日最终为正，只要中间最大回撤打穿纪律线，也作为承接硬度负例。",
                "失效线命中率暂用未来窗口最大回撤近似，不等于真实交易失效线。",
                "模型输出只做辅助验收，不覆盖市场总闸、安全区、结构和账户风控。"
            ],
        }
        print(json.dumps({"success": True, "data": payload}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
