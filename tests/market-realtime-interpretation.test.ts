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
