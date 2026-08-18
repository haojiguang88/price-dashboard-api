import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnnualEntryOpportunityReport,
  parseAnnualEntryOpportunityYear
} from "../src/services/annualEntryOpportunityService";
import type { MarketAssistRuleInput } from "../src/services/marketAssistEvaluator";
import type { MarketOhlcvPoint } from "../src/services/marketRealtimeInterpretation";

const addDays = (start: string, days: number) => {
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const buildRisingPoints = (
  start: string,
  count: number,
  initialClose: number,
  dailyStep: number
): MarketOhlcvPoint[] => Array.from({ length: count }, (_, index) => {
  const close = initialClose + (index * dailyStep);
  return {
    trade_date: addDays(start, index),
    open: close - 0.01,
    high: close + 0.02,
    low: close - 0.02,
    close,
    volume: 1000 + index
  };
});

const mediumSidewaysRule: MarketAssistRuleInput = {
  rule_key: "medium_sideways",
  rule_type: "medium_sideways",
  threshold: {
    abs_return_20d_lte_percent: 100,
    range_20d_lte_percent: 100
  },
  status: "active",
  display_order: 1
};

test("annual replay groups P2/P3 as small entries and P4 as formal entries", () => {
  const silverPoints = buildRisingPoints("2023-12-01", 120, 10, 0.01);
  const goldPoints = buildRisingPoints("2023-12-01", 120, 2000, 0.1);
  const report = buildAnnualEntryOpportunityReport({
    year: 2024,
    silverPoints,
    silverRules: [mediumSidewaysRule],
    goldPoints,
    goldRules: [mediumSidewaysRule]
  });

  assert.ok(report.trade_day_count > 0);
  assert.ok(report.small_batch_count > 0);
  assert.ok(report.normal_plan_count > 0);
  assert.equal(report.items.length, report.small_batch_count + report.normal_plan_count);
  assert.ok(report.items.every(item => item.trade_date.startsWith("2024-")));
  assert.ok(report.items.every(item => ["P2", "P3", "P4"].includes(item.permission_layer)));
  assert.ok(report.items.some(item => item.entry_type === "small_batch" && item.entry_label === "小仓"));
  assert.ok(report.items.some(item => item.entry_type === "normal_plan" && item.entry_label === "正式入场"));
});

test("annual replay ignores all price bars after the selected year", () => {
  const silverPoints = buildRisingPoints("2023-12-01", 120, 10, 0.01);
  const goldPoints = buildRisingPoints("2023-12-01", 120, 2000, 0.1);
  const baseReport = buildAnnualEntryOpportunityReport({
    year: 2024,
    silverPoints,
    silverRules: [mediumSidewaysRule],
    goldPoints,
    goldRules: [mediumSidewaysRule]
  });
  const reportWithFutureCrash = buildAnnualEntryOpportunityReport({
    year: 2024,
    silverPoints: [...silverPoints, { trade_date: "2025-01-02", close: 1 }],
    silverRules: [mediumSidewaysRule],
    goldPoints: [...goldPoints, { trade_date: "2025-01-02", close: 500 }],
    goldRules: [mediumSidewaysRule]
  });

  assert.deepEqual(reportWithFutureCrash.items, baseReport.items);
  assert.equal(reportWithFutureCrash.trade_day_count, baseReport.trade_day_count);
  assert.equal(reportWithFutureCrash.small_batch_count, baseReport.small_batch_count);
  assert.equal(reportWithFutureCrash.normal_plan_count, baseReport.normal_plan_count);
});

test("annual replay year rejects malformed and future values", () => {
  assert.equal(parseAnnualEntryOpportunityYear("2024", 2026), 2024);
  assert.throws(() => parseAnnualEntryOpportunityYear("24", 2026), /四位年份/);
  assert.throws(() => parseAnnualEntryOpportunityYear("2027", 2026), /1900-2026/);
});
