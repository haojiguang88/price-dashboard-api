#!/usr/bin/env python3
import argparse
import json
import math
import sqlite3
import warnings
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


SYMBOL_CONFIG = {
    "XAUUSD": {
        "domain": "metal:gold",
        "title": "黄金本地模型实验",
        "sample_where": "symbol = 'XAUUSD' AND label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE'",
        "training_policy": "黄金先做本地实验训练，输出存活、短命和回撤风险概率。",
    },
}

TARGETS = {
    "survival_5d": {
        "title": "5日存活概率",
        "target_text": "信号未来5个交易日仍存活",
        "positive_meaning": "越高越像能活过初始抖动",
    },
    "short_lived_5d": {
        "title": "短命信号概率",
        "target_text": "信号1-5个交易日内短命失效",
        "positive_meaning": "越高越像短命/扇脸信号",
    },
    "drawdown_risk_20d": {
        "title": "20日回撤风险",
        "target_text": "未来20个交易日最大回撤触及-5%",
        "positive_meaning": "越高越需要降低动作级别",
    },
}

NUMERIC_FEATURES = [
    "distance_to_ma60",
    "recent_return_5",
    "recent_return_20",
    "drawdown_20",
    "range_ratio_5",
    "range_ratio_20",
    "lower_low",
    "abnormal_move",
    "state_continuation_days",
    "safe_confirmation_days",
    "safe_zone_days",
    "no_flying_knife_blocked",
    "dxy_proxy",
    "dxy_proxy_change_5d",
    "dxy_proxy_change_20d",
    "us10y_yield",
    "us10y_change_5d",
    "us10y_change_20d",
    "us10y_real_yield",
    "real_yield_change_5d",
    "real_yield_change_20d",
]

CATEGORICAL_FEATURES = [
    "state_code",
    "short_label",
    "mid_label",
    "long_label",
    "cycle_label",
    "signal_maturity",
    "rule_action",
    "dollar_state",
    "dollar_tailwind_for_gold",
    "us10y_state",
    "rate_tailwind_for_gold",
    "real_yield_state",
    "real_rate_tailwind_for_gold",
]

MODEL_KEYS = ("logistic_regression", "random_forest", "lightgbm_model")

warnings.filterwarnings("ignore", message="X does not have valid feature names")


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
          title TEXT,
          payload_json TEXT,
          run_id INTEGER,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(domain, source_key, rank_order)
        );
        """
    )
    conn.commit()


def safe_float(value, default=0.0):
    try:
        numeric = float(value)
    except Exception:
        return default
    return numeric if math.isfinite(numeric) else default


def parse_tags(value):
    if not value:
        return []
    try:
        payload = json.loads(value)
    except Exception:
        return []
    if not isinstance(payload, list):
        return []
    tags = []
    for item in payload:
        if isinstance(item, dict) and item.get("code"):
            tags.append(str(item["code"]))
    return tags


def target_value(target_key, row):
    if target_key == "survival_5d":
        return 1 if int(row["survived_5d"] or 0) == 1 else 0
    if target_key == "short_lived_5d":
        return 1 if int(row["short_lived_signal"] or 0) == 1 else 0
    if target_key == "drawdown_risk_20d":
        drawdown = row["future_max_drawdown_20d"]
        return 1 if drawdown is not None and safe_float(drawdown) <= -0.05 else 0
    raise RuntimeError(f"unknown target: {target_key}")


def load_rows(conn, symbol):
    config = SYMBOL_CONFIG.get(symbol)
    if not config:
        raise RuntimeError(f"{symbol} 暂不进入模型训练；白银先做黄金主锚分层。")

    where_clause = (
        config["sample_where"]
        .replace("symbol", "s.symbol")
        .replace("label_status", "s.label_status")
        .replace("rule_signal", "s.rule_signal")
    )
    rows = conn.execute(
        f"""
        SELECT
          s.id, s.symbol, s.asset_name, s.source, s.trade_date, s.close,
          s.state_code, s.short_label, s.mid_label, s.long_label, s.cycle_label,
          s.distance_to_ma60, s.recent_return_5, s.recent_return_20, s.drawdown_20,
          s.range_ratio_5, s.range_ratio_20, s.lower_low, s.abnormal_move,
          s.behavior_tags_json, s.state_continuation_days, s.safe_confirmation_days,
          s.safe_zone_days, s.signal_maturity, s.no_flying_knife_blocked,
          s.rule_signal, s.rule_action, s.future_return_5d, s.future_return_20d,
          s.future_max_drawdown_20d, s.break_recent_low_20d, s.survived_3d,
          s.survived_5d, s.short_lived_signal,
          mf.dxy_proxy, mf.dxy_proxy_change_5d, mf.dxy_proxy_change_20d,
          mf.dollar_state, mf.dollar_tailwind_for_gold,
          mf.us10y_yield, mf.us10y_change_5d, mf.us10y_change_20d,
          mf.us10y_state, mf.rate_tailwind_for_gold,
          mf.us10y_real_yield, mf.real_yield_change_5d, mf.real_yield_change_20d,
          mf.real_yield_state, mf.real_rate_tailwind_for_gold
        FROM metal_rule_lab_samples s
        LEFT JOIN metal_macro_factors mf
          ON mf.trade_date = s.trade_date
         AND mf.source = 'tushare_macro'
        WHERE {where_clause}
        ORDER BY s.trade_date ASC
        """
    ).fetchall()
    return [dict(row) for row in rows]


def build_feature_columns(rows):
    categories = {field: set() for field in CATEGORICAL_FEATURES}
    behavior_tags = set()
    for row in rows:
        for field in CATEGORICAL_FEATURES:
            value = row.get(field)
            if value is not None and str(value).strip():
                categories[field].add(str(value))
        behavior_tags.update(parse_tags(row.get("behavior_tags_json")))

    feature_names = list(NUMERIC_FEATURES)
    for field in CATEGORICAL_FEATURES:
        for value in sorted(categories[field]):
            feature_names.append(f"{field}={value}")
    for tag in sorted(behavior_tags):
        feature_names.append(f"behavior_tag={tag}")
    return feature_names


def feature_map(row):
    payload = {feature: safe_float(row.get(feature)) for feature in NUMERIC_FEATURES}
    for field in CATEGORICAL_FEATURES:
        value = row.get(field)
        if value is not None and str(value).strip():
            payload[f"{field}={value}"] = 1.0
    for tag in parse_tags(row.get("behavior_tags_json")):
        payload[f"behavior_tag={tag}"] = 1.0
    return payload


def attach_features(rows, feature_names):
    samples = []
    for row in rows:
        features = feature_map(row)
        sample = dict(row)
        sample["year"] = int(str(row["trade_date"])[:4])
        sample["x"] = [safe_float(features.get(feature)) for feature in feature_names]
        samples.append(sample)
    return samples


def choose_year_splits(samples, min_year_rows=50):
    years = sorted({sample["year"] for sample in samples})
    counts = {year: sum(1 for sample in samples if sample["year"] == year) for year in years}
    eligible = [year for year in years if counts[year] >= min_year_rows]
    if len(eligible) >= 3:
        validation_year = eligible[-2]
        test_year = eligible[-1]
        return {
            "mode": "year",
            "validation_year": validation_year,
            "test_year": test_year,
            "train": [sample for sample in samples if sample["year"] < validation_year],
            "validation": [sample for sample in samples if sample["year"] == validation_year],
            "test": [sample for sample in samples if sample["year"] == test_year],
            "final_train": list(samples),
            "year_counts": counts,
        }

    first = int(len(samples) * 0.7)
    second = int(len(samples) * 0.85)
    return {
        "mode": "chronological",
        "validation_year": None,
        "test_year": None,
        "train": samples[:first],
        "validation": samples[first:second],
        "test": samples[second:],
        "final_train": list(samples),
        "year_counts": counts,
    }


def matrix(rows):
    return np.asarray([row["x"] for row in rows], dtype=float)


def labels(rows, target_key):
    return np.asarray([target_value(target_key, row) for row in rows], dtype=int)


def make_model(model_key):
    if model_key == "logistic_regression":
        return Pipeline([
            ("scale", StandardScaler()),
            ("model", LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)),
        ])
    if model_key == "random_forest":
        return RandomForestClassifier(
            n_estimators=220,
            max_depth=7,
            min_samples_leaf=12,
            class_weight="balanced_subsample",
            random_state=42,
            n_jobs=-1,
        )
    if model_key == "lightgbm_model":
        return LGBMClassifier(
            n_estimators=240,
            learning_rate=0.035,
            num_leaves=20,
            min_child_samples=18,
            subsample=0.85,
            colsample_bytree=0.85,
            class_weight="balanced",
            random_state=42,
            verbosity=-1,
        )
    raise RuntimeError(f"unknown model key: {model_key}")


def metric_payload(y_true, probabilities):
    if len(y_true) == 0:
        return {"samples": 0, "positive_rate": None, "accuracy": None, "precision": None, "recall": None, "auc": None}
    predictions = (probabilities >= 0.5).astype(int)
    payload = {
        "samples": int(len(y_true)),
        "positive_rate": float(np.mean(y_true)),
        "accuracy": float(accuracy_score(y_true, predictions)),
        "precision": float(precision_score(y_true, predictions, zero_division=0)),
        "recall": float(recall_score(y_true, predictions, zero_division=0)),
    }
    try:
        payload["auc"] = float(roc_auc_score(y_true, probabilities)) if len(set(y_true.tolist())) > 1 else None
    except Exception:
        payload["auc"] = None
    return payload


def feature_importance(model_key, model, feature_names):
    if model_key == "logistic_regression":
        values = np.abs(model.named_steps["model"].coef_[0])
    else:
        values = getattr(model, "feature_importances_", np.zeros(len(feature_names)))
    total = float(np.sum(values)) or 1.0
    ranked = []
    for feature, raw in sorted(zip(feature_names, values), key=lambda item: item[1], reverse=True):
        ranked.append({"feature": feature, "raw_importance": float(raw), "importance": float(raw) / total})
    return ranked


def create_run(conn, domain, output_dir, source_count):
    timestamp = now()
    cursor = conn.execute(
        """
        INSERT INTO model_training_runs (
          domain, status, output_dir, current_item_key, message, source_row_count,
          started_at, created_at, updated_at
        )
        VALUES (?, 'running', ?, 'precious_metal_gold_training', ?, ?, ?, ?, ?)
        """,
        (domain, output_dir, "precious metal model training started", source_count, timestamp, timestamp, timestamp),
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


def persist_artifact(conn, domain, run_id, dataset_path, target_key, model_key, artifact, row_count, split_meta):
    timestamp = now()
    metrics = artifact["metrics"]
    validation_auc = metrics["validation"].get("auc")
    test_auc = metrics["test"].get("auc")
    registered_key = f"{target_key}_{model_key}"
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
            registered_key,
            TARGETS[target_key]["target_text"],
            model_key,
            artifact["model_file"],
            artifact["model_json_file"],
            artifact["metrics_file"],
            dataset_path,
            run_id,
            validation_auc,
            test_auc,
            json.dumps({"rows": row_count, "split": split_meta, "target": target_key}, ensure_ascii=False),
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
                registered_key,
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
                f"{registered_key}_importance",
                rank,
                f"{TARGETS[target_key]['title']} / {item['feature']}",
                json.dumps(item, ensure_ascii=False),
                run_id,
                timestamp,
            ),
        )
    conn.commit()


def train_target(samples, feature_names, split, target_key, output_dir):
    train_rows = split["train"]
    validation_rows = split["validation"]
    test_rows = split["test"]
    final_train_rows = split["final_train"]

    if len(train_rows) < 120 or len(validation_rows) < 30 or len(test_rows) < 30:
        raise RuntimeError("训练/验证/测试切分样本不足")
    if len(set(labels(train_rows, target_key).tolist())) < 2:
        raise RuntimeError("训练集只有一个类别")

    target_dir = Path(output_dir) / target_key
    target_dir.mkdir(parents=True, exist_ok=True)

    result = {}
    for model_key in MODEL_KEYS:
        eval_model = make_model(model_key)
        eval_model.fit(matrix(train_rows), labels(train_rows, target_key))
        validation_prob = eval_model.predict_proba(matrix(validation_rows))[:, 1]
        test_prob = eval_model.predict_proba(matrix(test_rows))[:, 1]

        final_model = make_model(model_key)
        final_model.fit(matrix(final_train_rows), labels(final_train_rows, target_key))

        metrics = {
            "model_key": model_key,
            "target_key": target_key,
            "target_title": TARGETS[target_key]["title"],
            "target_text": TARGETS[target_key]["target_text"],
            "positive_meaning": TARGETS[target_key]["positive_meaning"],
            "features": feature_names,
            "train": {
                "samples": len(train_rows),
                "positive_rate": float(np.mean(labels(train_rows, target_key))),
            },
            "validation": metric_payload(labels(validation_rows, target_key), validation_prob),
            "test": metric_payload(labels(test_rows, target_key), test_prob),
            "final_train": {
                "samples": len(final_train_rows),
                "positive_rate": float(np.mean(labels(final_train_rows, target_key))),
            },
            "feature_importance": feature_importance(model_key, final_model, feature_names),
        }
        model_file = target_dir / f"{model_key}.joblib"
        metrics_file = target_dir / f"{model_key}_metrics.json"
        model_json_file = target_dir / f"{model_key}.json"
        joblib.dump(final_model, model_file)
        metrics_file.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
        model_json_file.write_text(json.dumps({
            "model_key": f"{target_key}_{model_key}",
            "model_type": model_key,
            "target_key": target_key,
            "target_text": TARGETS[target_key]["target_text"],
            "features": feature_names,
            "trained_on": "all complete historical signal samples",
            "created_at": now(),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        result[model_key] = {
            "model_file": str(model_file),
            "metrics_file": str(metrics_file),
            "model_json_file": str(model_json_file),
            "metrics": metrics,
        }
    return result


def best_model_for_target(model_results):
    best_key = None
    best_score = -1.0
    for model_key, artifact in model_results.items():
        metrics = artifact["metrics"]
        score = metrics["test"].get("auc")
        if score is None:
            score = metrics["validation"].get("auc")
        if score is not None and score > best_score:
            best_key = model_key
            best_score = score
    return best_key or "logistic_regression"


def train_symbol(conn, symbol, output_root):
    config = SYMBOL_CONFIG[symbol]
    rows = load_rows(conn, symbol)
    if len(rows) < 300:
        raise RuntimeError(f"黄金完整信号样本不足：{len(rows)}，至少需要300条。")

    feature_names = build_feature_columns(rows)
    samples = attach_features(rows, feature_names)
    split = choose_year_splits(samples)
    split_meta = {
        "mode": split["mode"],
        "validation_year": split["validation_year"],
        "test_year": split["test_year"],
        "year_counts": split["year_counts"],
        "train_count": len(split["train"]),
        "validation_count": len(split["validation"]),
        "test_count": len(split["test"]),
        "final_train_count": len(split["final_train"]),
    }

    run_name = datetime.utcnow().strftime("run-%Y%m%d-%H%M%S")
    output_dir = Path(output_root) / symbol.lower() / run_name
    output_dir.mkdir(parents=True, exist_ok=True)
    dataset_path = output_dir / "dataset.json"
    dataset_path.write_text(json.dumps({
        "symbol": symbol,
        "domain": config["domain"],
        "feature_names": feature_names,
        "split": split_meta,
        "rows": [
            {
                "id": sample["id"],
                "trade_date": sample["trade_date"],
                "year": sample["year"],
                "close": sample["close"],
                "targets": {target: target_value(target, sample) for target in TARGETS},
                "features": dict(zip(feature_names, sample["x"])),
            }
            for sample in samples
        ],
    }, ensure_ascii=False), encoding="utf-8")

    run_id = create_run(conn, config["domain"], str(output_dir), len(samples))
    try:
        target_summaries = {}
        for target_key in TARGETS:
            model_results = train_target(samples, feature_names, split, target_key, output_dir)
            best_model = best_model_for_target(model_results)
            for model_key, artifact in model_results.items():
                persist_artifact(
                    conn,
                    config["domain"],
                    run_id,
                    str(dataset_path),
                    target_key,
                    model_key,
                    artifact,
                    len(samples),
                    split_meta,
                )
            target_summaries[target_key] = {
                "target_key": target_key,
                "title": TARGETS[target_key]["title"],
                "target_text": TARGETS[target_key]["target_text"],
                "positive_meaning": TARGETS[target_key]["positive_meaning"],
                "positive_count": int(sum(target_value(target_key, sample) for sample in samples)),
                "positive_rate": sum(target_value(target_key, sample) for sample in samples) / len(samples),
                "best_model": best_model,
                "models": {
                    model_key: {
                        "validation_auc": artifact["metrics"]["validation"].get("auc"),
                        "test_auc": artifact["metrics"]["test"].get("auc"),
                        "test_accuracy": artifact["metrics"]["test"].get("accuracy"),
                        "test_precision": artifact["metrics"]["test"].get("precision"),
                        "test_recall": artifact["metrics"]["test"].get("recall"),
                    }
                    for model_key, artifact in model_results.items()
                },
                "top_features": model_results[best_model]["metrics"]["feature_importance"][:8],
            }

        summary = {
            "symbol": symbol,
            "domain": config["domain"],
            "title": config["title"],
            "training_policy": config["training_policy"],
            "run_id": run_id,
            "output_dir": str(output_dir),
            "dataset_path": str(dataset_path),
            "sample_count": len(samples),
            "feature_count": len(feature_names),
            "split": split_meta,
            "targets": target_summaries,
            "no_lookahead_note": "特征只来自截面日及以前；未来收益、回撤、破低和存活只作为后验标签。模型产物只做概率解释，不给交易许可。",
            "completed_at": now(),
        }
        (output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        finish_run(conn, run_id, "completed", f"gold model experiment completed; samples={len(samples)}")
        return summary
    except Exception as exc:
        finish_run(conn, run_id, "failed", str(exc))
        raise


def main():
    parser = argparse.ArgumentParser(description="Train local precious metal experiment models")
    parser.add_argument("--db", required=True)
    parser.add_argument("--symbol", default="XAUUSD")
    parser.add_argument("--output-root", default="/Volumes/7100/model-training/precious-metals")
    args = parser.parse_args()

    np.random.seed(42)
    conn = connect(args.db)
    try:
        ensure_training_tables(conn)
        summary = train_symbol(conn, args.symbol, args.output_root)
        print(json.dumps({"success": True, "data": summary}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
