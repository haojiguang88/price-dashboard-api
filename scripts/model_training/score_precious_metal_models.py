#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path

import joblib
import numpy as np

from train_precious_metal_models import TARGETS, feature_map, make_model, safe_float, target_value


DOMAIN_BY_SYMBOL = {
    "XAUUSD": "metal:gold",
}

TARGET_ORDER = ("survival_5d", "short_lived_5d", "drawdown_risk_20d")

SAMPLE_COLUMNS = """
  id, symbol, asset_name, source, trade_date, close,
  state_code, short_label, mid_label, long_label, cycle_label,
  distance_to_ma60, recent_return_5, recent_return_20, drawdown_20,
  range_ratio_5, range_ratio_20, lower_low, abnormal_move,
  behavior_tags_json, state_continuation_days, safe_confirmation_days,
  safe_zone_days, signal_maturity, no_flying_knife_blocked,
  rule_signal, rule_action, rule_action_label, label_status,
  future_return_5d, future_return_20d, future_max_drawdown_20d,
  break_recent_low_20d, survived_3d, survived_5d, short_lived_signal
"""


def connect(db_path):
    conn = sqlite3.connect(db_path, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 60000")
    return conn


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None


def number(value, digits=4):
    if value is None:
        return None
    try:
        return round(float(value), digits)
    except Exception:
        return None


def fetch_latest_run_summary(conn, domain):
    row = conn.execute(
        """
        SELECT id, status, output_dir, source_row_count, started_at, finished_at, message
        FROM model_training_runs
        WHERE domain = ? AND status = 'completed'
        ORDER BY id DESC
        LIMIT 1
        """,
        (domain,),
    ).fetchone()
    if not row:
        return None, None
    summary = read_json(Path(row["output_dir"]) / "summary.json") if row["output_dir"] else None
    return dict(row), summary


def fetch_artifacts(conn, domain, run_id, summary):
    artifacts = {}
    for target_key in TARGET_ORDER:
        best_model = None
        if summary:
            target_summary = (summary.get("targets") or {}).get(target_key) or {}
            best_model = target_summary.get("best_model")

        rows = conn.execute(
            """
            SELECT model_key, target, model_type, model_file, model_json_file,
                   metrics_file, run_id, validation_auc, test_auc
            FROM model_training_artifacts
            WHERE domain = ?
              AND model_key LIKE ?
              AND (? IS NULL OR run_id = ?)
            ORDER BY test_auc DESC, validation_auc DESC
            """,
            (domain, f"{target_key}_%", run_id, run_id),
        ).fetchall()
        if not rows:
            continue
        picked = None
        if best_model:
            expected = f"{target_key}_{best_model}"
            picked = next((row for row in rows if row["model_key"] == expected), None)
        picked = picked or rows[0]
        model_meta = read_json(picked["model_json_file"]) or {}
        metrics = read_json(picked["metrics_file"]) or {}
        model_file = Path(picked["model_file"])
        if not model_file.exists():
            continue
        artifacts[target_key] = {
            "target_key": target_key,
            "title": TARGETS[target_key]["title"],
            "target_text": TARGETS[target_key]["target_text"],
            "model_key": picked["model_key"],
            "model_type": picked["model_type"],
            "model_file": str(model_file),
            "features": model_meta.get("features") or metrics.get("features") or [],
            "model": joblib.load(model_file),
            "metrics": {
                "validation_auc": number(picked["validation_auc"]),
                "test_auc": number(picked["test_auc"]),
                "validation": metrics.get("validation") or {},
                "test": metrics.get("test") or {},
            },
        }
    return artifacts


def load_samples(conn, symbol, only_signal=False, complete=False):
    clauses = ["symbol = ?"]
    params = [symbol]
    if only_signal:
        clauses.append("rule_signal = 'SIGNAL_CANDIDATE'")
    if complete:
        clauses.append("label_status = 'complete'")
    where = " AND ".join(clauses)
    rows = conn.execute(
        f"""
        SELECT {SAMPLE_COLUMNS}
        FROM metal_rule_lab_samples
        WHERE {where}
        ORDER BY trade_date ASC
        """,
        params,
    ).fetchall()
    return [dict(row) for row in rows]


def sample_year(row):
    return int(str(row["trade_date"])[:4])


def split_sample_rows(samples, summary):
    if not summary:
        first = int(len(samples) * 0.7)
        return samples[:first], samples[first:]

    split = summary.get("split") or {}
    validation_year = split.get("validation_year")
    if validation_year:
        train_rows = [row for row in samples if sample_year(row) < int(validation_year)]
        evaluation = [row for row in samples if sample_year(row) >= int(validation_year)]
        return train_rows, evaluation

    first = int(len(samples) * 0.7)
    return samples[:first], samples[first:]


def vector_for_row(row, features):
    values = feature_map(row)
    return np.asarray([[safe_float(values.get(feature)) for feature in features]], dtype=float)


def matrix_for_rows(rows, features):
    return np.asarray([
        [safe_float(feature_map(row).get(feature)) for feature in features]
        for row in rows
    ], dtype=float)


def labels_for_rows(rows, target_key):
    return np.asarray([target_value(target_key, row) for row in rows], dtype=int)


def build_validation_artifacts(samples, artifacts, summary):
    train_rows, evaluation_rows = split_sample_rows(samples, summary)
    validation_artifacts = {}

    for target_key, artifact in artifacts.items():
        features = artifact.get("features") or []
        if not features or len(train_rows) < 50 or len(evaluation_rows) < 20:
            validation_artifacts[target_key] = artifact
            validation_artifacts[target_key]["validation_model_source"] = "final_model_fallback"
            continue

        y_train = labels_for_rows(train_rows, target_key)
        if len(set(y_train.tolist())) < 2:
            validation_artifacts[target_key] = artifact
            validation_artifacts[target_key]["validation_model_source"] = "final_model_fallback_single_class"
            continue

        model = make_model(artifact["model_type"])
        model.fit(matrix_for_rows(train_rows, features), y_train)
        validation_artifacts[target_key] = {
            **artifact,
            "model": model,
            "validation_model_source": "train_split_only",
            "validation_train_count": len(train_rows),
            "validation_eval_count": len(evaluation_rows),
        }

    return validation_artifacts


def predict_row(row, artifacts):
    predictions = {}
    for target_key, artifact in artifacts.items():
        if not artifact["features"]:
            continue
        probability = float(artifact["model"].predict_proba(vector_for_row(row, artifact["features"]))[0][1])
        predictions[target_key] = {
            "target_key": target_key,
            "title": artifact["title"],
            "probability": round(probability, 4),
            "model_key": artifact["model_key"],
            "model_type": artifact["model_type"],
        }
    return predictions


def compact_sample(row, predictions=None):
    return {
        "id": row["id"],
        "trade_date": row["trade_date"],
        "close": number(row["close"], 2),
        "state_code": row["state_code"],
        "rule_action": row["rule_action"],
        "rule_action_label": row["rule_action_label"],
        "signal_maturity": row["signal_maturity"],
        "safe_confirmation_days": int(row["safe_confirmation_days"] or 0),
        "label_status": row["label_status"],
        "survived_5d": bool(row["survived_5d"]) if row["survived_5d"] is not None else None,
        "short_lived_signal": bool(row["short_lived_signal"]) if row["short_lived_signal"] is not None else None,
        "future_return_20d": number(row["future_return_20d"]),
        "future_max_drawdown_20d": number(row["future_max_drawdown_20d"]),
        "predictions": predictions or {},
    }


def latest_prediction(samples, artifacts):
    if not samples:
        return None
    latest = samples[-1]
    latest_signal = next((row for row in reversed(samples) if row["rule_signal"] == "SIGNAL_CANDIDATE"), None)
    payload = {
        "latest_sample": compact_sample(latest),
        "latest_signal_sample": compact_sample(latest_signal, predict_row(latest_signal, artifacts)) if latest_signal else None,
        "applicable": latest["rule_signal"] == "SIGNAL_CANDIDATE",
        "reason": "",
    }
    if payload["applicable"]:
        payload["latest_sample"]["predictions"] = predict_row(latest, artifacts)
        payload["reason"] = "当前黄金为信号候选，模型辅助评分已生效。"
    else:
        payload["reason"] = "当前黄金不是信号候选，模型不强行评分；下方展示最近一次可评分信号。"
    return payload


def evaluation_rows(samples, summary):
    if not summary:
        return samples
    split = summary.get("split") or {}
    validation_year = split.get("validation_year")
    if not validation_year:
        return samples
    return [row for row in samples if int(str(row["trade_date"])[:4]) >= int(validation_year)]


def confusion_bucket(rows, artifacts, target_key, high_threshold, actual_key, positive_value=True):
    result = {
        "high_positive": 0,
        "high_false": 0,
        "low_positive": 0,
        "low_false": 0,
        "middle": 0,
    }
    for row in rows:
        probability = predict_row(row, {target_key: artifacts[target_key]}).get(target_key, {}).get("probability")
        if probability is None:
            continue
        actual = bool(row.get(actual_key))
        if probability >= high_threshold:
            if actual is positive_value:
                result["high_positive"] += 1
            else:
                result["high_false"] += 1
        elif probability <= 1 - high_threshold:
            if actual is positive_value:
                result["low_positive"] += 1
            else:
                result["low_false"] += 1
        else:
            result["middle"] += 1
    return result


def drawdown_actual(row):
    value = row.get("future_max_drawdown_20d")
    return value is not None and safe_float(value) <= -0.05


def safe_rate(numerator, denominator):
    if not denominator:
        return None
    return number(float(numerator) / float(denominator))


def average(values):
    values = [safe_float(value) for value in values if value is not None]
    if not values:
        return None
    return number(sum(values) / len(values))


def row_actual_for_target(row, target_key):
    if target_key == "survival_5d":
        return bool(row.get("survived_5d"))
    if target_key == "short_lived_5d":
        return bool(row.get("short_lived_signal"))
    if target_key == "drawdown_risk_20d":
        return drawdown_actual(row)
    return False


def row_probability(predictions, target_key):
    value = (predictions.get(target_key) or {}).get("probability")
    if value is None:
        return None
    return safe_float(value)


def summarize_prediction_bucket(scored, target_key, predicate):
    bucket = [(row, predictions) for row, predictions in scored if predicate(row_probability(predictions, target_key))]
    count = len(bucket)
    actual_count = sum(1 for row, _ in bucket if row_actual_for_target(row, target_key))
    returns = [row.get("future_return_20d") for row, _ in bucket if row.get("future_return_20d") is not None]
    drawdowns = [row.get("future_max_drawdown_20d") for row, _ in bucket if row.get("future_max_drawdown_20d") is not None]
    return {
        "count": count,
        "actual_count": actual_count,
        "actual_rate": safe_rate(actual_count, count),
        "avg_return_20d": average(returns),
        "avg_drawdown_20d": average(drawdowns),
    }


def build_target_validation(scored, target_key, high_threshold, low_threshold):
    available = [(row, predictions) for row, predictions in scored if row_probability(predictions, target_key) is not None]
    total = len(available)
    actual_total = sum(1 for row, _ in available if row_actual_for_target(row, target_key))
    baseline_rate = safe_rate(actual_total, total)
    high = summarize_prediction_bucket(available, target_key, lambda prob: prob is not None and prob >= high_threshold)
    low = summarize_prediction_bucket(available, target_key, lambda prob: prob is not None and prob <= low_threshold)
    middle = summarize_prediction_bucket(available, target_key, lambda prob: prob is not None and low_threshold < prob < high_threshold)
    high_edge = number((high["actual_rate"] or 0) - (baseline_rate or 0)) if high["actual_rate"] is not None and baseline_rate is not None else None
    low_edge = number((baseline_rate or 0) - (low["actual_rate"] or 0)) if low["actual_rate"] is not None and baseline_rate is not None else None
    return {
        "target_key": target_key,
        "title": TARGETS[target_key]["title"],
        "sample_count": total,
        "actual_count": actual_total,
        "baseline_rate": baseline_rate,
        "high_threshold": high_threshold,
        "low_threshold": low_threshold,
        "high_bucket": high,
        "middle_bucket": middle,
        "low_bucket": low,
        "high_edge_vs_baseline": high_edge,
        "low_edge_vs_baseline": low_edge,
    }


def build_yearly_validation(scored):
    buckets = {}
    for row, predictions in scored:
      year = str(row["trade_date"])[:4]
      buckets.setdefault(year, []).append((row, predictions))

    rows = []
    for year in sorted(buckets.keys()):
        items = buckets[year]
        survival = build_target_validation(items, "survival_5d", 0.60, 0.40)
        short_lived = build_target_validation(items, "short_lived_5d", 0.60, 0.40)
        drawdown = build_target_validation(items, "drawdown_risk_20d", 0.55, 0.40)
        rows.append({
            "year": year,
            "sample_count": len(items),
            "survival_high_count": survival["high_bucket"]["count"],
            "survival_high_actual_rate": survival["high_bucket"]["actual_rate"],
            "survival_baseline_rate": survival["baseline_rate"],
            "short_lived_high_count": short_lived["high_bucket"]["count"],
            "short_lived_high_actual_rate": short_lived["high_bucket"]["actual_rate"],
            "short_lived_baseline_rate": short_lived["baseline_rate"],
            "drawdown_high_count": drawdown["high_bucket"]["count"],
            "drawdown_high_actual_rate": drawdown["high_bucket"]["actual_rate"],
            "drawdown_baseline_rate": drawdown["baseline_rate"],
        })
    return rows


def build_validation_conclusion(target_reports, yearly_rows):
    checks = []

    survival = target_reports.get("survival_5d") or {}
    short_lived = target_reports.get("short_lived_5d") or {}
    drawdown = target_reports.get("drawdown_risk_20d") or {}

    checks.append({
        "key": "survival_high_bucket",
        "label": "高存活评分是否真更容易存活",
        "passed": (survival.get("high_bucket") or {}).get("count", 0) >= 20
                  and (survival.get("high_edge_vs_baseline") or 0) >= 0.05,
        "actual": {
            "count": (survival.get("high_bucket") or {}).get("count", 0),
            "actual_rate": (survival.get("high_bucket") or {}).get("actual_rate"),
            "baseline_rate": survival.get("baseline_rate"),
            "edge": survival.get("high_edge_vs_baseline"),
        },
        "threshold": {"count": 20, "edge": 0.05},
    })

    checks.append({
        "key": "short_lived_high_bucket",
        "label": "高短命评分是否真更容易短命",
        "passed": (short_lived.get("high_bucket") or {}).get("count", 0) >= 20
                  and (short_lived.get("high_edge_vs_baseline") or 0) >= 0.05,
        "actual": {
            "count": (short_lived.get("high_bucket") or {}).get("count", 0),
            "actual_rate": (short_lived.get("high_bucket") or {}).get("actual_rate"),
            "baseline_rate": short_lived.get("baseline_rate"),
            "edge": short_lived.get("high_edge_vs_baseline"),
        },
        "threshold": {"count": 20, "edge": 0.05},
    })

    checks.append({
        "key": "drawdown_high_bucket",
        "label": "高回撤评分是否真更容易打到纪律线",
        "passed": (drawdown.get("high_bucket") or {}).get("count", 0) >= 15
                  and (drawdown.get("high_edge_vs_baseline") or 0) >= 0.04,
        "actual": {
            "count": (drawdown.get("high_bucket") or {}).get("count", 0),
            "actual_rate": (drawdown.get("high_bucket") or {}).get("actual_rate"),
            "baseline_rate": drawdown.get("baseline_rate"),
            "edge": drawdown.get("high_edge_vs_baseline"),
        },
        "threshold": {"count": 15, "edge": 0.04},
    })

    eligible_years = [row for row in yearly_rows if row["sample_count"] >= 20]
    unstable_years = [
        row["year"] for row in eligible_years
        if row["survival_high_count"] >= 8
        and row["survival_high_actual_rate"] is not None
        and row["survival_baseline_rate"] is not None
        and row["survival_high_actual_rate"] < row["survival_baseline_rate"]
    ]
    checks.append({
        "key": "year_stability",
        "label": "分年份是否没有明显反向失效",
        "passed": len(eligible_years) >= 2 and len(unstable_years) == 0,
        "actual": {"eligible_years": len(eligible_years), "unstable_years": unstable_years},
        "threshold": {"eligible_years": 2, "unstable_years": 0},
    })

    passed_count = sum(1 for item in checks if item["passed"])
    if passed_count >= 3:
        status = "validated"
        label = "模型有辅助价值"
        text = "黄金模型在存活、短命或回撤风险上有可见区分度，可以作为规则通过后的辅助降级/提醒工具。"
    elif passed_count >= 2:
        status = "watch"
        label = "模型可观察"
        text = "黄金模型有部分区分度，但还不能放大权重；适合继续做验收报告和错例复盘。"
    else:
        status = "needs_review"
        label = "模型需复核"
        text = "黄金模型暂未证明稳定增量价值，先看错判样本和规则阈值，不进入主决策。"

    return {
        "status": status,
        "label": label,
        "text": text,
        "checks": checks,
        "usage_rules": [
            "模型只辅助降级和风险提醒，不反向放行交易。",
            "规则未通过时，模型高分不能覆盖安全区和结构成立。",
            "规则通过但模型提示高短命或高回撤时，降级为复核观察。",
            "每次训练后先看验收报告，再决定是否使用新模型。"
        ],
    }


def build_case(row, predictions, case_type, title, reason):
    item = compact_sample(row, predictions)
    item["case_type"] = case_type
    item["case_title"] = title
    item["case_reason"] = reason
    return item


def validation_report(samples, artifacts, summary, limit):
    rows = evaluation_rows(samples, summary)
    scored = []
    for row in rows:
        predictions = predict_row(row, artifacts)
        scored.append((row, predictions))

    cases = {
        "high_survival_success": [],
        "high_survival_failed": [],
        "short_lived_hit": [],
        "short_lived_missed": [],
        "drawdown_warning_hit": [],
        "drawdown_warning_missed": [],
    }

    for row, predictions in scored:
        survival = predictions.get("survival_5d", {}).get("probability")
        short_lived = predictions.get("short_lived_5d", {}).get("probability")
        drawdown = predictions.get("drawdown_risk_20d", {}).get("probability")

        if survival is not None and survival >= 0.60 and row["survived_5d"]:
            cases["high_survival_success"].append(build_case(row, predictions, "high_survival_success", "高存活且真存活", "模型高存活分与后验一致。"))
        if survival is not None and survival >= 0.60 and not row["survived_5d"]:
            cases["high_survival_failed"].append(build_case(row, predictions, "high_survival_failed", "高存活但短命", "模型高估了信号存活度。"))
        if short_lived is not None and short_lived >= 0.60 and row["short_lived_signal"]:
            cases["short_lived_hit"].append(build_case(row, predictions, "short_lived_hit", "短命预警命中", "模型提示短命，后验确实失效。"))
        if short_lived is not None and short_lived < 0.40 and row["short_lived_signal"]:
            cases["short_lived_missed"].append(build_case(row, predictions, "short_lived_missed", "短命漏判", "模型没有提前识别短命信号。"))

        has_drawdown = drawdown_actual(row)
        if drawdown is not None and drawdown >= 0.55 and has_drawdown:
            cases["drawdown_warning_hit"].append(build_case(row, predictions, "drawdown_warning_hit", "回撤预警命中", "模型提示回撤风险，后验确实打到纪律线。"))
        if drawdown is not None and drawdown < 0.40 and has_drawdown:
            cases["drawdown_warning_missed"].append(build_case(row, predictions, "drawdown_warning_missed", "回撤漏判", "模型低估了后续回撤。"))

    case_order = [
        "high_survival_failed",
        "short_lived_missed",
        "drawdown_warning_missed",
        "high_survival_success",
        "short_lived_hit",
        "drawdown_warning_hit",
    ]
    compact_cases = []
    for key in case_order:
        compact_cases.extend(cases[key][:limit])

    target_reports = {
        "survival_5d": build_target_validation(scored, "survival_5d", 0.60, 0.40) if "survival_5d" in artifacts else None,
        "short_lived_5d": build_target_validation(scored, "short_lived_5d", 0.60, 0.40) if "short_lived_5d" in artifacts else None,
        "drawdown_risk_20d": build_target_validation(scored, "drawdown_risk_20d", 0.55, 0.40) if "drawdown_risk_20d" in artifacts else None,
    }
    target_reports = {key: value for key, value in target_reports.items() if value is not None}
    yearly = build_yearly_validation(scored)
    conclusion = build_validation_conclusion(target_reports, yearly)

    return {
        "scope": "validation_and_test_years",
        "sample_count": len(rows),
        "model_source_note": "验收报告使用训练段临时重训的模型预测验证/测试段；不使用最终全样本模型回看后验，避免把验收做得过于乐观。",
        "model_sources": {
            key: {
                "model_key": artifact.get("model_key"),
                "model_type": artifact.get("model_type"),
                "source": artifact.get("validation_model_source", "unknown"),
                "train_count": artifact.get("validation_train_count"),
                "eval_count": artifact.get("validation_eval_count"),
            }
            for key, artifact in artifacts.items()
        },
        "thresholds": {
            "survival_high": 0.60,
            "short_lived_high": 0.60,
            "drawdown_risk_high": 0.55,
            "drawdown_risk_line": -0.05,
        },
        "confusion": {
            "survival_5d": confusion_bucket(rows, artifacts, "survival_5d", 0.60, "survived_5d", True) if "survival_5d" in artifacts else None,
            "short_lived_5d": confusion_bucket(rows, artifacts, "short_lived_5d", 0.60, "short_lived_signal", True) if "short_lived_5d" in artifacts else None,
            "drawdown_risk_20d": {
                "high_risk_hit": sum(1 for row, pred in scored if pred.get("drawdown_risk_20d", {}).get("probability", 0) >= 0.55 and drawdown_actual(row)),
                "high_risk_false": sum(1 for row, pred in scored if pred.get("drawdown_risk_20d", {}).get("probability", 0) >= 0.55 and not drawdown_actual(row)),
                "low_risk_missed": sum(1 for row, pred in scored if pred.get("drawdown_risk_20d", {}).get("probability", 1) < 0.40 and drawdown_actual(row)),
                "low_risk_clean": sum(1 for row, pred in scored if pred.get("drawdown_risk_20d", {}).get("probability", 1) < 0.40 and not drawdown_actual(row)),
            } if "drawdown_risk_20d" in artifacts else None,
        },
        "conclusion": conclusion,
        "targets": target_reports,
        "yearly": yearly,
        "case_counts": {key: len(value) for key, value in cases.items()},
        "cases": compact_cases[: max(limit * 3, limit)],
    }


def main():
    parser = argparse.ArgumentParser(description="Score precious metal local models")
    parser.add_argument("--db", required=True)
    parser.add_argument("--symbol", default="XAUUSD")
    parser.add_argument("--case-limit", type=int, default=8)
    args = parser.parse_args()

    domain = DOMAIN_BY_SYMBOL.get(args.symbol)
    if not domain:
        print(json.dumps({"success": False, "message": "当前只支持黄金模型评分；白银先继续分层。"}, ensure_ascii=False))
        raise SystemExit(1)

    conn = connect(args.db)
    try:
        run, summary = fetch_latest_run_summary(conn, domain)
        if not run:
            print(json.dumps({"success": False, "message": "未找到黄金模型训练结果，请先训练黄金模型。"}, ensure_ascii=False))
            raise SystemExit(1)
        artifacts = fetch_artifacts(conn, domain, run["id"], summary)
        if len(artifacts) < 3:
            print(json.dumps({"success": False, "message": "黄金模型产物不完整，请重新训练。"}, ensure_ascii=False))
            raise SystemExit(1)

        all_samples = load_samples(conn, args.symbol, only_signal=False, complete=False)
        complete_signal_samples = load_samples(conn, args.symbol, only_signal=True, complete=True)
        validation_artifacts = build_validation_artifacts(complete_signal_samples, artifacts, summary)
        payload = {
            "symbol": args.symbol,
            "domain": domain,
            "run": run,
            "summary": {
                "sample_count": summary.get("sample_count") if summary else len(complete_signal_samples),
                "split": summary.get("split") if summary else None,
                "targets": {
                    key: {
                        "title": artifact["title"],
                        "model_key": artifact["model_key"],
                        "model_type": artifact["model_type"],
                        "metrics": artifact["metrics"],
                    }
                    for key, artifact in artifacts.items()
                },
            },
            "latest_prediction": latest_prediction(all_samples, artifacts),
            "validation": validation_report(complete_signal_samples, validation_artifacts, summary, max(1, args.case_limit)),
            "no_lookahead_note": "当前样本评分使用最终模型；历史验收报告使用训练段模型预测验证/测试段，特征只取样本截面当时字段，未来结果只用于验收和错例复盘。模型输出不覆盖规则权限。",
        }
        print(json.dumps({"success": True, "data": payload}, ensure_ascii=False))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
