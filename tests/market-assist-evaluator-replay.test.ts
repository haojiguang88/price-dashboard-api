import assert from "node:assert/strict";
import test from "node:test";
import { calculateSilverSwingMetrics } from "../src/services/marketAssistEvaluator";

test("historical evaluator uses the nearest prior trading day", () => {
  const result = calculateSilverSwingMetrics([
    { trade_date: "2025-12-04", close: 13 },
    { trade_date: "2025-12-05", close: 13.5 },
    { trade_date: "2025-12-08", close: 20 }
  ], "2025-12-07");

  assert.equal(result.point.date, "2025-12-05");
  assert.equal(result.point.close, 13.5);
  assert.equal(result.metrics.dailyReturnPercent, (13.5 - 13) / 13 * 100);
});

test("historical evaluator refuses a date before the first available sample", () => {
  assert.throws(() => calculateSilverSwingMetrics([
    { trade_date: "2025-12-05", close: 13.5 }
  ], "2025-12-01"), /No market price point on or before target date/);
});
