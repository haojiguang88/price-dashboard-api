import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnnualEntryOpportunityReport,
  buildGoldAnnualObservationReport,
  parseAnnualOpportunityAsset,
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

const buildDeepRepairThenFailurePoints = (): MarketOhlcvPoint[] => {
  const background = buildRisingPoints("2023-01-01", 365, 100, 0.01);
  const declineCloses = [101, 99, 97, 95, 93, 91, 89, 87, 85, 83];
  const decline = declineCloses.map((close, index) => ({
    trade_date: addDays("2024-01-01", index),
    close
  }));
  const platform = Array.from({ length: 28 }, (_, index) => ({
    trade_date: addDays("2024-01-11", index),
    close: 83 + (index * 0.03)
  }));
  return [
    ...background,
    ...decline,
    ...platform,
    {
      trade_date: addDays("2024-01-11", platform.length),
      close: 78
    }
  ];
};

const buildDeepRepairCandidatePoints = (): MarketOhlcvPoint[] => {
  const background = buildRisingPoints("2023-01-01", 365, 100, 0.3);
  const declineCloses = [205, 200, 195, 190, 185, 180, 175, 170, 168, 166];
  const decline = declineCloses.map((close, index) => ({
    trade_date: addDays("2024-01-01", index),
    close
  }));
  const platform = Array.from({ length: 32 }, (_, index) => ({
    trade_date: addDays("2024-01-11", index),
    close: 166 + (index * 0.1)
  }));
  return [...background, ...decline, ...platform];
};

const buildBullMarketPullbackCandidatePoints = (): MarketOhlcvPoint[] => {
  const background = buildRisingPoints("2023-01-01", 340, 100, 0.05);
  const pullbackCloses = [120, 124, 130, 134, 130, 128, 126, 125];
  const pullback = pullbackCloses.map((close, index) => ({
    trade_date: addDays("2023-01-01", background.length + index),
    close
  }));
  const platform = Array.from({ length: 18 }, (_, index) => ({
    trade_date: addDays("2023-01-01", background.length + pullback.length + index),
    close: 125.4 + (index * 0.18)
  }));
  return [...background, ...pullback, ...platform];
};

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

const permissiveHealthyPullbackRule: MarketAssistRuleInput = {
  rule_key: "healthy_pullback",
  rule_type: "healthy_pullback",
  threshold: {
    drawdown_from_recent_high_between_percent: [0, 100],
    close_vs_ma20_gte_percent: -100,
    close_vs_ma60_gte_percent: -100,
    recovery_from_5d_low_gte_percent: 0
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
  assert.equal(report.asset, "silver");
  assert.equal(report.result_mode, "entry_permission");
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

test("gold annual replay keeps an ordinary healthy pullback at value-improving observation level", () => {
  const goldPoints = buildRisingPoints("2023-01-01", 500, 1800, 0.4);
  const report = buildGoldAnnualObservationReport({
    year: 2024,
    goldPoints,
    goldRules: [permissiveHealthyPullbackRule]
  });

  assert.equal(report.asset, "gold");
  assert.equal(report.result_mode, "observation");
  assert.ok(report.trade_day_count > 0);
  assert.equal(report.candidate_pool_count, 0);
  assert.ok(report.value_improving_count > 0);
  assert.equal(report.small_batch_count, 0);
  assert.equal(report.normal_plan_count, 0);
  assert.ok(report.items.every(item => item.trade_date.startsWith("2024-")));
  assert.ok(report.items.every(item => item.permission_layer === null));
  assert.ok(report.items.every(item => item.entry_type === "value_improving"));
  assert.ok(report.items.every(item => item.permission_label.includes("不构成买入许可")));
  assert.equal(report.repair_withdrawn_count, 0);
});

test("gold deep-drawdown repair only upgrades to candidate when the long-cycle average is still rising", () => {
  const report = buildGoldAnnualObservationReport({
    year: 2024,
    goldPoints: buildDeepRepairCandidatePoints(),
    goldRules: [mediumSidewaysRule]
  });

  assert.ok(report.value_improving_count > 0);
  assert.ok(report.candidate_pool_count > 0);
  assert.ok(report.items.some(item => (
    item.entry_type === "candidate_pool"
    && item.observation_path === "deep_drawdown_repair"
    && item.permission_layer === null
  )));
});

test("gold bull-market pullback opens a separate medium-term candidate path", () => {
  const goldPoints = buildBullMarketPullbackCandidatePoints();
  const report = buildGoldAnnualObservationReport({
    year: 2023,
    goldPoints,
    goldRules: [mediumSidewaysRule]
  });

  const candidate = report.items.find(item => (
    item.entry_type === "candidate_pool"
    && item.observation_path === "bull_market_pullback"
  ));
  assert.ok(candidate);
  assert.match(candidate.conclusion_reason, /牛市健康回踩候选/);
  assert.match(candidate.permission_label, /不构成买入许可/);
});

test("gold bull-market pullback withdrawal keeps its candidate path and starting date", () => {
  const goldPoints = buildBullMarketPullbackCandidatePoints();
  const initialReport = buildGoldAnnualObservationReport({
    year: 2023,
    goldPoints,
    goldRules: [mediumSidewaysRule]
  });
  const candidate = initialReport.items.find(item => (
    item.entry_type === "candidate_pool"
    && item.observation_path === "bull_market_pullback"
  ));
  assert.ok(candidate);
  const candidateIndex = goldPoints.findIndex(point => point.trade_date === candidate.trade_date);
  const failedPoints = [
    ...goldPoints.slice(0, candidateIndex + 1),
    {
      trade_date: addDays(candidate.trade_date, 1),
      close: candidate.close * 0.9
    }
  ];
  const failedReport = buildGoldAnnualObservationReport({
    year: 2023,
    goldPoints: failedPoints,
    goldRules: [mediumSidewaysRule]
  });
  const withdrawal = failedReport.items.find(item => item.entry_type === "repair_withdrawn");

  assert.equal(withdrawal?.observation_path, "bull_market_pullback");
  assert.equal(withdrawal?.transition_from_date, candidate.trade_date);
});

test("gold deep-drawdown replay records a failed repair withdrawal without rewriting earlier observations", () => {
  const goldPoints = buildDeepRepairThenFailurePoints();
  const failureDate = String(goldPoints[goldPoints.length - 1].trade_date);
  const reportBeforeFailure = buildGoldAnnualObservationReport({
    year: 2024,
    goldPoints: goldPoints.slice(0, -1),
    goldRules: [mediumSidewaysRule]
  });
  const reportAfterFailure = buildGoldAnnualObservationReport({
    year: 2024,
    goldPoints,
    goldRules: [mediumSidewaysRule]
  });

  assert.ok(reportBeforeFailure.value_improving_count > 0);
  assert.equal(reportBeforeFailure.repair_withdrawn_count, 0);
  assert.deepEqual(
    reportAfterFailure.items.filter(item => item.trade_date < failureDate),
    reportBeforeFailure.items
  );
  assert.equal(reportAfterFailure.repair_withdrawn_count, 1);
  const withdrawal = reportAfterFailure.items.find(item => item.entry_type === "repair_withdrawn");
  assert.equal(withdrawal?.trade_date, failureDate);
  assert.equal(withdrawal?.entry_label, "修复撤销");
  assert.equal(withdrawal?.observation_path, "deep_drawdown_repair");
  assert.ok(withdrawal?.transition_from_date);
  assert.match(withdrawal?.conclusion_reason || "", /回到继续观察/);
});

test("annual replay year rejects malformed and future values", () => {
  assert.equal(parseAnnualEntryOpportunityYear("2024", 2026), 2024);
  assert.throws(() => parseAnnualEntryOpportunityYear("24", 2026), /四位年份/);
  assert.throws(() => parseAnnualEntryOpportunityYear("2027", 2026), /1900-2026/);
});

test("annual replay asset defaults to silver and accepts gold aliases", () => {
  assert.equal(parseAnnualOpportunityAsset(undefined), "silver");
  assert.equal(parseAnnualOpportunityAsset("silver"), "silver");
  assert.equal(parseAnnualOpportunityAsset("SGE_AGTD"), "silver");
  assert.equal(parseAnnualOpportunityAsset("gold"), "gold");
  assert.equal(parseAnnualOpportunityAsset("XAUUSD"), "gold");
  assert.throws(() => parseAnnualOpportunityAsset("platinum"), /gold 或 silver/);
});
