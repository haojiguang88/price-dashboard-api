import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_DATA_STATUSES,
  summarizeTaskRunPayload,
  type TaskDataStatus
} from "../src/services/workspaceTaskCenterService";

const statusOf = (payload: unknown): TaskDataStatus => summarizeTaskRunPayload(payload).data_status;

test("task data_status contract covers the documented enum", () => {
  assert.deepEqual([...TASK_DATA_STATUSES].sort(), [
    "mapping_gap",
    "no_change",
    "no_source_data",
    "source_error",
    "unknown",
    "updated"
  ]);
});

test("task data_status matrix matches the grab-data contract", () => {
  assert.equal(
    statusOf({
      inserted_count: 1,
      updated_count: 0,
      source_errors: [{ message: "boom" }]
    }),
    "source_error",
    "source errors outrank writes"
  );

  assert.equal(
    statusOf({
      inserted_count: 0,
      updated_count: 2,
      skipped_count: 10,
      source_count: 12
    }),
    "updated"
  );

  assert.equal(
    statusOf({
      inserted_count: 0,
      updated_count: 0,
      unmapped_enabled_objects: [{ name: "未映射对象" }]
    }),
    "mapping_gap"
  );

  assert.equal(
    statusOf({
      inserted_count: 0,
      updated_count: 0,
      skipped_count: 5,
      source_count: 8,
      matched_count: 5,
      filtered_count: 100
    }),
    "no_change",
    "successful scrape with unchanged prices"
  );

  assert.equal(
    statusOf({
      inserted_count: 0,
      updated_count: 0,
      source_count: 0,
      records: []
    }),
    "no_source_data"
  );

  assert.equal(statusOf(null), "unknown");
  assert.equal(statusOf(undefined), "unknown");
});

test("persisted envelope fields are additive and do not hide nested writes", () => {
  // Mimic taskCenterRoutes wrapping: run_status/data_status sit beside business payload.
  const summary = summarizeTaskRunPayload({
    run_status: "success",
    data_status: "no_change",
    inserted_count: 0,
    updated_count: 0,
    skipped_count: 3,
    source_count: 3,
    primary: {
      inserted_count: 0,
      updated_count: 0,
      source_count: 0
    },
    backup: {
      inserted_count: 2,
      updated_count: 1,
      source_count: 3
    }
  });

  assert.equal(summary.inserted, 2);
  assert.equal(summary.updated, 1);
  assert.equal(summary.data_status, "updated");
});
