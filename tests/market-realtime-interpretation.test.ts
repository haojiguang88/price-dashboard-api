import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSilverRealtimeInterpretation,
  type MarketOhlcvPoint
} from "../src/services/marketRealtimeInterpretation";
import type {
  SilverSwingEvaluation,
  SilverSwingMetrics
} from "../src/services/marketAssistEvaluator";

const metrics = (overrides: Partial<SilverSwingMetrics> = {}): SilverSwingMetrics => ({
  dailyReturnPercent: 1.2039609603,
  return3dPercent: 0.0986471251,
  return5dPercent: -1.8515959652,
  return10dPercent: 0.3036079927,
  return20dPercent: 1.6893342878,
  upDays10d: 6,
  downDays10d: 4,
  bestSingleDayRise10dPercent: 4.6230129794,
  worstSingleDayDrop10dPercent: -3.4394992089,
  drawdownFrom20dHighPercent: -6.9496299207,
  recoveryFrom5dLowPercent: 1.2039609603,
  range10dPercent: 7.9132952268,
  range20dPercent: 13.3323435528,
  avgAbsDailyReturn20dPercent: 2.0522552112,
  dailyReturnStd20dPercent: 2.5020471558,
  daysAbsReturnGte4Pct20d: 3,
  ma20: 14.37145,
  ma60: 16.4097833333,
  ma120: 18.262,
  ma200: 16.950185,
  ma250: 15.458488,
  closeVsMa20Percent: -1.1512408282,
  closeVsMa60Percent: -13.4296918403,
  closeVsMa250Percent: -8.1022671816,
  ...overrides
});

const evaluation = (
  hitRuleKeys: string[],
  metricOverrides: Partial<SilverSwingMetrics> = {}
): SilverSwingEvaluation => ({
  date: "2026-07-29",
  close: 14.206,
  metrics: metrics(metricOverrides),
  rules: hitRuleKeys.map(ruleKey => ({ ruleKey, hit: true })),
  hitRuleKeys
});

const datedEvaluation = (
  date: string,
  close: number,
  hitRuleKeys: string[],
  metricOverrides: Partial<SilverSwingMetrics> = {}
): SilverSwingEvaluation => ({
  ...evaluation(hitRuleKeys, metricOverrides),
  date,
  close
});

const stableGoldEvaluation = (date: string) => datedEvaluation(
  date,
  2050,
  ["medium_sideways"],
  {
    return5dPercent: 0.5,
    closeVsMa20Percent: 0.4,
    closeVsMa60Percent: 1.2
  }
);

const normalPlanHistory = () => Array.from({ length: 20 }, (_, index) => {
  const day = String(index + 1).padStart(2, "0");
  const close = index < 10
    ? 5.7 + (index * 0.005)
    : index < 15
      ? 5.8 + ((index - 10) * 0.005)
      : 5.9 + ((index - 15) * 0.01);
  const hitRuleKeys = index >= 15 ? ["medium_sideways"] : [];
  const currentEvaluation = datedEvaluation(
    `2024-02-${day}`,
    close,
    hitRuleKeys,
    {
      closeVsMa20Percent: index >= 15 ? 0.8 : -0.4,
      closeVsMa60Percent: index >= 15 ? 0.2 : -0.6,
      return20dPercent: 1.2,
      range20dPercent: 4.1
    }
  );
  return {
    evaluation: currentEvaluation,
    goldEvaluation: stableGoldEvaluation(currentEvaluation.date)
  };
});

const recentBars: MarketOhlcvPoint[] = [
  {
    trade_date: "2026-07-27",
    open: 14.255,
    high: 14.603,
    low: 14.11,
    close: 14.537,
    volume: 201328
  },
  {
    trade_date: "2026-07-28",
    open: 14.25,
    high: 14.427,
    low: 13.825,
    close: 14.037,
    volume: 319044
  },
  {
    trade_date: "2026-07-29",
    open: 14.02,
    high: 14.219,
    low: 13.858,
    close: 14.206,
    volume: 247824
  }
];

test("single-day rebound after a sharp drop remains P1 review-only", () => {
  const result = buildSilverRealtimeInterpretation({
    evaluation: evaluation(["sideways"]),
    pricePoints: recentBars,
    primaryState: {
      key: "sideways",
      label: "横盘观察",
      tone: "neutral"
    },
    goldContext: {
      evaluation: evaluation(
        ["sideways", "medium_sideways"],
        {
          return5dPercent: -2.379969941,
          closeVsMa20Percent: -1.0014184919
        }
      ),
      latestPoint: {
        trade_date: "2026-07-29",
        close: 4031.99032
      }
    }
  });

  assert.equal(result.permission_layer, "P1");
  assert.equal(result.buy_permission, "review_only");
  assert.equal(result.repair_quality.key, "fragile_repair");
  assert.match(result.summary, /首次修复/);
  assert.ok(result.evidence.some(item => item.includes("33.8%")));
  assert.ok(result.evidence.some(item => item.includes("-22.3%")));
});

test("gold risk downgrades a silver P2 setup to P1", () => {
  const result = buildSilverRealtimeInterpretation({
    evaluation: evaluation(["medium_sideways"]),
    pricePoints: recentBars,
    primaryState: {
      key: "sideways",
      label: "横盘观察",
      tone: "neutral"
    },
    goldContext: {
      evaluation: evaluation(
        ["high_volatility"],
        {
          return5dPercent: -4.2,
          closeVsMa20Percent: -3.1
        }
      )
    }
  });

  assert.equal(result.permission_layer, "P1");
  assert.equal(result.buy_permission, "review_only");
  assert.equal(result.gold_context?.label, "黄金背景偏弱");
});

test("confirmed healthy pullback maps to P3 without a gold risk override", () => {
  const result = buildSilverRealtimeInterpretation({
    evaluation: evaluation(["healthy_pullback"], {
      dailyReturnPercent: 0.6,
      recoveryFrom5dLowPercent: 3.2
    }),
    pricePoints: [
      { trade_date: "2026-07-27", high: 14.5, low: 14.1, close: 14.3, volume: 220000 },
      { trade_date: "2026-07-28", high: 14.4, low: 14.15, close: 14.25, volume: 210000 },
      { trade_date: "2026-07-29", high: 14.45, low: 14.2, close: 14.3355, volume: 205000 }
    ],
    primaryState: {
      key: "healthy_pullback",
      label: "回踩不破",
      tone: "opportunity"
    }
  });

  assert.equal(result.permission_layer, "P3");
  assert.equal(result.buy_permission, "small_batch");
  assert.equal(result.repair_quality.key, "confirmed_repair");
});

test("a mature platform with rising lows and recovered averages upgrades to P4", () => {
  const permissionHistory = normalPlanHistory();
  const currentEvaluation = permissionHistory[permissionHistory.length - 1].evaluation;
  const result = buildSilverRealtimeInterpretation({
    evaluation: currentEvaluation,
    pricePoints: permissionHistory.map(item => ({
      trade_date: item.evaluation.date,
      close: item.evaluation.close
    })),
    primaryState: {
      key: "sideways",
      label: "横盘观察",
      tone: "neutral"
    },
    goldContext: {
      evaluation: stableGoldEvaluation(currentEvaluation.date)
    },
    permissionHistory
  });

  assert.equal(result.permission_layer, "P4");
  assert.equal(result.buy_permission, "normal");
  assert.equal(result.normal_plan_state.active, true);
  assert.equal(result.normal_plan_state.entered_on, currentEvaluation.date);
  assert.match(result.summary, /不是全仓许可/);
  assert.ok(result.evidence.some(item => item.includes(`正常计划自 ${currentEvaluation.date} 生效`)));
});

test("P4 persists through a neutral day and closes on a fast drop", () => {
  const permissionHistory = normalPlanHistory();
  const neutralEvaluation = datedEvaluation(
    "2024-02-21",
    6.02,
    [],
    {
      closeVsMa20Percent: 1.4,
      closeVsMa60Percent: 0.9
    }
  );
  const neutralHistory = [
    ...permissionHistory,
    {
      evaluation: neutralEvaluation,
      goldEvaluation: stableGoldEvaluation(neutralEvaluation.date)
    }
  ];
  const neutralResult = buildSilverRealtimeInterpretation({
    evaluation: neutralEvaluation,
    pricePoints: neutralHistory.map(item => ({
      trade_date: item.evaluation.date,
      close: item.evaluation.close
    })),
    primaryState: { key: "neutral", label: "中性观察", tone: "neutral" },
    permissionHistory: neutralHistory
  });

  assert.equal(neutralResult.permission_layer, "P4");
  assert.equal(neutralResult.normal_plan_state.entered_on, "2024-02-20");

  const fastDropEvaluation = datedEvaluation(
    "2024-02-22",
    5.72,
    ["fast_drop"],
    {
      dailyReturnPercent: -5.1,
      return5dPercent: -12.2,
      closeVsMa20Percent: -4.2,
      closeVsMa60Percent: -3.1
    }
  );
  const stoppedHistory = [
    ...neutralHistory,
    {
      evaluation: fastDropEvaluation,
      goldEvaluation: stableGoldEvaluation(fastDropEvaluation.date)
    }
  ];
  const stoppedResult = buildSilverRealtimeInterpretation({
    evaluation: fastDropEvaluation,
    pricePoints: stoppedHistory.map(item => ({
      trade_date: item.evaluation.date,
      close: item.evaluation.close
    })),
    primaryState: { key: "fast_drop", label: "暴跌", tone: "danger" },
    permissionHistory: stoppedHistory
  });

  assert.equal(stoppedResult.permission_layer, "P0");
  assert.equal(stoppedResult.normal_plan_state.active, false);
  assert.equal(stoppedResult.normal_plan_state.entered_on, null);
});

test("gold risk only pauses an active P4 and P4 resumes when the background clears", () => {
  const permissionHistory = normalPlanHistory();
  const riskDate = "2024-02-21";
  const riskEvaluation = datedEvaluation(
    riskDate,
    6.02,
    [],
    {
      closeVsMa20Percent: 1.4,
      closeVsMa60Percent: 0.9
    }
  );
  const riskHistory = [
    ...permissionHistory,
    {
      evaluation: riskEvaluation,
      goldEvaluation: datedEvaluation(riskDate, 1980, ["fast_drop"])
    }
  ];
  const riskResult = buildSilverRealtimeInterpretation({
    evaluation: riskEvaluation,
    pricePoints: riskHistory.map(item => ({
      trade_date: item.evaluation.date,
      close: item.evaluation.close
    })),
    primaryState: { key: "neutral", label: "中性观察", tone: "neutral" },
    goldContext: { evaluation: riskHistory[riskHistory.length - 1].goldEvaluation },
    permissionHistory: riskHistory
  });

  assert.equal(riskResult.permission_layer, "P3");
  assert.equal(riskResult.normal_plan_state.active, true);
  assert.match(riskResult.evidence.join(" "), /黄金背景风险临时降权/);

  const resumeDate = "2024-02-22";
  const resumeEvaluation = datedEvaluation(
    resumeDate,
    6.04,
    [],
    {
      closeVsMa20Percent: 1.6,
      closeVsMa60Percent: 1.1
    }
  );
  const resumeHistory = [
    ...riskHistory,
    {
      evaluation: resumeEvaluation,
      goldEvaluation: stableGoldEvaluation(resumeDate)
    }
  ];
  const resumeResult = buildSilverRealtimeInterpretation({
    evaluation: resumeEvaluation,
    pricePoints: resumeHistory.map(item => ({
      trade_date: item.evaluation.date,
      close: item.evaluation.close
    })),
    primaryState: { key: "neutral", label: "中性观察", tone: "neutral" },
    goldContext: { evaluation: stableGoldEvaluation(resumeDate) },
    permissionHistory: resumeHistory
  });

  assert.equal(resumeResult.permission_layer, "P4");
  assert.equal(resumeResult.normal_plan_state.entered_on, "2024-02-20");
});

test("historical replay ignores price bars after the evaluated date", () => {
  const replayEvaluation = {
    ...evaluation(["slow_rise"], {
      dailyReturnPercent: 1,
      return5dPercent: 5,
      closeVsMa20Percent: 2
    }),
    date: "2026-07-29",
    close: 14.2
  };
  const result = buildSilverRealtimeInterpretation({
    evaluation: replayEvaluation,
    pricePoints: [
      { trade_date: "2026-07-28", high: 14.1, low: 13.8, close: 14, volume: 100 },
      { trade_date: "2026-07-29", high: 14.3, low: 14, close: 14.2, volume: 110 },
      { trade_date: "2026-07-30", high: 30, low: 5, close: 6, volume: 999999 }
    ],
    primaryState: {
      key: "slow_rise",
      label: "慢涨观察",
      tone: "opportunity"
    },
    historicalReplay: true,
    requestedAsOfDate: "2026-07-29"
  });

  assert.ok(result.evidence.some(item => item.includes("日内区间约 66.7%")));
  assert.ok(result.evidence.some(item => item.includes("成交量较前一日 +10.0%")));
  assert.equal(result.evidence.some(item => item.includes("+908990.0%")), false);
  assert.match(result.data_notes.join(" "), /未使用后续行情/);
});
