import assert from "node:assert/strict";
import test from "node:test";
import { resolveXiaogeBackfillDates, shiftDateKey } from "../src/utils/xiaogeTaskBackfill";

test("xiaoge backfill_days walks back from yesterday, oldest first", () => {
  assert.deepEqual(
    resolveXiaogeBackfillDates({ backfill_days: 3 }, "2026-10-23"),
    ["2026-10-20", "2026-10-21", "2026-10-22"]
  );
});

test("xiaoge backfill yesterday is the Shanghai date before today", () => {
  assert.deepEqual(
    resolveXiaogeBackfillDates({ backfill: "yesterday" }, "2026-10-23"),
    ["2026-10-22"]
  );
  assert.equal(shiftDateKey("2026-03-01", -1), "2026-02-28");
});

test("xiaoge backfill_days takes precedence over a single backfill date", () => {
  assert.deepEqual(
    resolveXiaogeBackfillDates({ backfill: "yesterday", backfill_days: 1 }, "2026-10-23"),
    ["2026-10-22"]
  );
});

test("xiaoge without backfill config stays on the live collector", () => {
  assert.deepEqual(resolveXiaogeBackfillDates({}, "2026-10-23"), []);
});

test("xiaoge backfill_days outside 1..7 fails before a run", () => {
  assert.throws(
    () => resolveXiaogeBackfillDates({ backfill_days: 8 }, "2026-10-23"),
    /1 到 7/
  );
});
