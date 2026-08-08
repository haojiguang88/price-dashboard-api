import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTaskRunPayload } from "../src/services/workspaceTaskCenterService";

test("backup writes override an empty primary source result", () => {
  const summary = summarizeTaskRunPayload({
    primary: {
      records: [],
      inserted_count: 0,
      updated_count: 0,
      source_count: 0
    },
    backup: {
      records: Array.from({ length: 50 }, (_, index) => ({ price: 1000 + index })),
      inserted_count: 50,
      updated_count: 0,
      source_count: 50
    },
    backup_used: true
  });

  assert.equal(summary.inserted, 50);
  assert.equal(summary.data_status, "updated");
});

test("a genuinely empty successful run remains no source data", () => {
  const summary = summarizeTaskRunPayload({
    records: [],
    inserted_count: 0,
    updated_count: 0,
    source_count: 0
  });

  assert.equal(summary.inserted, 0);
  assert.equal(summary.updated, 0);
  assert.equal(summary.data_status, "no_source_data");
});

test("pipeline step writes are included in the top-level task result", () => {
  const summary = summarizeTaskRunPayload({
    steps: [
      {
        key: "primary_source",
        data: { records: [], source_count: 0 }
      },
      {
        key: "backup_source",
        data: { inserted_count: 3, source_count: 3 }
      }
    ]
  });

  assert.equal(summary.inserted, 3);
  assert.equal(summary.data_status, "updated");
});

test("successful run with only skips is no_change, not updated", () => {
  const summary = summarizeTaskRunPayload({
    inserted_count: 0,
    updated_count: 0,
    skipped_count: 5,
    source_count: 10,
    matched_count: 5,
    filtered_count: 230
  });

  assert.equal(summary.data_status, "no_change");
  assert.equal(summary.skipped, 5);
});

