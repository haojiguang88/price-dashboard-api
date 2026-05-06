#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path


MODEL_SPECS = [
    ("logistic_regression", "logistic_regression_model.json", "logistic_regression_metrics.json"),
    ("random_forest", "random_forest_model.json", "random_forest_metrics.json"),
    ("lightgbm_model", "lightgbm_model.json", "lightgbm_metrics.json"),
]


TARGET_TEXT = {
    "label_structure_safe_20d": "结构成立+安全区有效样本",
    "label_ret_20d_gt_5": "未来20日收益>5%",
}


def read_json(path):
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def number(value):
    if value is None:
        return None
    return float(value)


def run_payload(run):
    output_dir = Path(run["output_dir"])
    label_payload = read_json(output_dir / "label_table.json") or {}
    split_payload = read_json(output_dir / "split_dataset.json") or {}

    models = []
    default_test_auc = None
    target = None
    for model_key, model_json_name, metrics_name in MODEL_SPECS:
        model_json = read_json(output_dir / model_json_name) or {}
        metrics = read_json(output_dir / metrics_name) or {}
        if not metrics:
            continue
        target = target or model_json.get("target")
        validation_auc = metrics.get("validation", {}).get("auc")
        test_auc = metrics.get("test", {}).get("auc")
        if model_key == "lightgbm_model":
            default_test_auc = test_auc
        models.append({
            "modelKey": model_key,
            "modelType": model_json.get("model_type"),
            "target": model_json.get("target"),
            "validationAuc": number(validation_auc),
            "testAuc": number(test_auc),
            "sampleLimits": metrics.get("sample_limits"),
            "positiveRate": {
                "train": number(metrics.get("train", {}).get("positive_rate")),
                "validation": number(metrics.get("validation", {}).get("positive_rate")),
                "test": number(metrics.get("test", {}).get("positive_rate")),
            },
        })

    positive_counts = label_payload.get("positive_counts") or {}
    label_rows = label_payload.get("label_rows")
    structure_positive = positive_counts.get("structure_safe_20d")
    old_positive = positive_counts.get("ret_20_gt_5")

    return {
        "runId": run["id"],
        "status": run["status"],
        "target": target,
        "targetText": TARGET_TEXT.get(target, target or "-"),
        "outputDir": run["output_dir"],
        "sourceRowCount": run["source_row_count"],
        "startedAt": run["started_at"],
        "finishedAt": run["finished_at"],
        "labelRows": label_rows,
        "structurePositiveRate": structure_positive / label_rows if label_rows and structure_positive is not None else None,
        "oldRet20PositiveRate": old_positive / label_rows if label_rows and old_positive is not None else None,
        "rowsBySplit": split_payload.get("rows_by_split") or {},
        "models": models,
        "defaultTestAuc": number(default_test_auc),
    }


def registered_model_bundle(conn, domain):
    try:
        rows = conn.execute(
            """
            SELECT model_key, target, model_type, run_id, validation_auc, test_auc,
                   model_file, metrics_file, updated_at
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
    except sqlite3.Error:
        return None

    if not rows:
        return None

    target = rows[0]["target"]
    return {
        "target": target,
        "targetText": TARGET_TEXT.get(target, target or "-"),
        "models": [
            {
                "modelKey": row["model_key"],
                "modelType": row["model_type"],
                "target": row["target"],
                "runId": row["run_id"],
                "validationAuc": number(row["validation_auc"]),
                "testAuc": number(row["test_auc"]),
                "modelFile": row["model_file"],
                "metricsFile": row["metrics_file"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ],
    }


def with_deltas(runs):
    ordered = list(reversed(runs))
    previous_by_target = {}
    for run in ordered:
        target = run.get("target") or "unknown"
        previous = previous_by_target.get(target)
        run["deltaVsPreviousSameTarget"] = {
            "defaultTestAuc": (
                run["defaultTestAuc"] - previous["defaultTestAuc"]
                if previous and run["defaultTestAuc"] is not None and previous["defaultTestAuc"] is not None
                else None
            ),
            "sourceRowCount": (
                run["sourceRowCount"] - previous["sourceRowCount"]
                if previous and run["sourceRowCount"] is not None and previous["sourceRowCount"] is not None
                else None
            ),
        }
        previous_by_target[target] = run
    return list(reversed(ordered))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--limit", type=int, default=8)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT id, domain, status, output_dir, source_row_count, started_at, finished_at
            FROM model_training_runs
            WHERE domain = ?
              AND status = 'completed'
              AND output_dir IS NOT NULL
              AND output_dir != ''
            ORDER BY id DESC
            LIMIT ?
            """,
            (args.domain, args.limit),
        ).fetchall()
        runs = []
        skipped_runs = []
        for row in rows:
            output_dir = Path(row["output_dir"])
            if output_dir.exists():
                payload = run_payload(dict(row))
                if payload["models"]:
                    runs.append(payload)
                else:
                    skipped_runs.append({
                        "runId": row["id"],
                        "status": row["status"],
                        "outputDir": row["output_dir"],
                        "sourceRowCount": row["source_row_count"],
                        "finishedAt": row["finished_at"],
                        "reason": "该 run 目录缺少模型指标文件，可能只执行了后续文档/LLM阶段，不能参与模型版本对比。",
                    })
            else:
                skipped_runs.append({
                    "runId": row["id"],
                    "status": row["status"],
                    "outputDir": row["output_dir"],
                    "sourceRowCount": row["source_row_count"],
                    "finishedAt": row["finished_at"],
                    "reason": "训练目录不存在，不能读取模型指标。",
                })
        print(json.dumps({
            "success": True,
            "data": {
                "domain": args.domain,
                "runs": with_deltas(runs),
                "skippedRuns": skipped_runs,
                "registeredModels": registered_model_bundle(conn, args.domain),
            },
        }, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
