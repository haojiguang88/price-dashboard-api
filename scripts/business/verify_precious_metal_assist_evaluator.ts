import assert from "assert";
import path from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import {
  clusterRuleHits,
  evaluateSilverSwingRules,
  type MarketAssistRuleInput,
  type MarketPricePoint,
  type SilverSwingEvaluation
} from "../../src/services/marketAssistEvaluator";

const dbPath = process.env.BUSINESS_DB_PATH || path.resolve(process.cwd(), "data/price_dashboard_business_dev.db");

interface RegressionSample {
  date: string;
  shouldHit?: string[];
  shouldMiss?: string[];
}

interface ClusterExpectation {
  ruleKey: string;
  mergeGap: number;
  clusters: Array<{ start: string; end: string }>;
}

interface AssetRegressionConfig {
  label: string;
  symbol: "SGE_AGTD" | "XAUUSD";
  ruleGroup: "silver_swing_plan" | "precious_metal_plan";
  minRows: number;
  requiredRules: string[];
  samples: RegressionSample[];
  clusterExpectations?: ClusterExpectation[];
}

const silverRequiredRules = [
  "extreme_volatility",
  "extreme_buy_lock",
  "extreme_sell_ladder",
  "extreme_crash_guard",
  "extreme_reentry_check",
  "high_volatility",
  "fast_rise",
  "overheat_rise",
  "slow_rise",
  "ma250_stretch",
  "fast_drop",
  "falling_knife",
  "slow_decline",
  "sideways",
  "medium_sideways",
  "healthy_pullback"
];

const goldRequiredRules = [
  "extreme_volatility",
  "high_volatility",
  "fast_rise",
  "overheat_rise",
  "slow_rise",
  "fast_drop",
  "falling_knife",
  "slow_decline",
  "sideways",
  "medium_sideways",
  "healthy_pullback"
];

const configs: AssetRegressionConfig[] = [
  {
    label: "Silver / SGE_AGTD",
    symbol: "SGE_AGTD",
    ruleGroup: "silver_swing_plan",
    minRows: 4000,
    requiredRules: silverRequiredRules,
    samples: [
      { date: "2011-04-25", shouldHit: ["fast_rise", "overheat_rise"], shouldMiss: ["extreme_volatility", "falling_knife"] },
      { date: "2011-05-06", shouldHit: ["extreme_volatility", "fast_drop", "falling_knife"], shouldMiss: ["slow_decline", "sideways"] },
      { date: "2011-06-14", shouldHit: ["slow_decline"], shouldMiss: ["extreme_volatility", "falling_knife", "sideways"] },
      { date: "2020-03-17", shouldHit: ["high_volatility", "fast_drop", "falling_knife"], shouldMiss: ["extreme_volatility", "sideways"] },
      { date: "2020-03-20", shouldHit: ["extreme_volatility", "fast_rise", "fast_drop", "falling_knife"], shouldMiss: ["sideways"] },
      { date: "2020-08-10", shouldHit: ["high_volatility", "fast_rise", "overheat_rise"], shouldMiss: ["extreme_volatility", "falling_knife"] },
      { date: "2020-08-12", shouldHit: ["extreme_volatility", "fast_drop", "falling_knife"], shouldMiss: ["slow_decline", "sideways"] },
      { date: "2025-12-05", shouldHit: ["slow_rise", "ma250_stretch"], shouldMiss: ["extreme_volatility", "fast_rise", "overheat_rise", "fast_drop", "falling_knife", "sideways"] },
      { date: "2025-12-24", shouldHit: ["high_volatility", "fast_rise", "overheat_rise", "ma250_stretch"], shouldMiss: ["extreme_volatility", "falling_knife"] },
      { date: "2026-01-29", shouldHit: ["extreme_volatility", "fast_rise", "overheat_rise", "ma250_stretch"], shouldMiss: ["falling_knife", "sideways"] },
      { date: "2026-02-05", shouldHit: ["extreme_volatility", "fast_drop", "falling_knife"], shouldMiss: ["slow_decline", "sideways"] },
      { date: "2026-03-23", shouldHit: ["extreme_volatility", "fast_drop", "falling_knife"], shouldMiss: ["slow_decline", "sideways"] },
      { date: "2026-06-05", shouldHit: ["high_volatility", "slow_decline"], shouldMiss: ["extreme_volatility", "fast_drop", "falling_knife", "sideways"] }
    ],
    clusterExpectations: [
      {
        ruleKey: "extreme_volatility",
        mergeGap: 2,
        clusters: [
          { start: "2011-05-06", end: "2011-05-30" },
          { start: "2020-03-20", end: "2020-04-15" },
          { start: "2020-08-12", end: "2020-08-18" },
          { start: "2026-01-05", end: "2026-04-20" }
        ]
      }
    ]
  },
  {
    label: "Gold / XAUUSD",
    symbol: "XAUUSD",
    ruleGroup: "precious_metal_plan",
    minRows: 10000,
    requiredRules: goldRequiredRules,
    samples: [
      { date: "2011-08-08", shouldHit: ["slow_rise"], shouldMiss: ["extreme_volatility", "high_volatility", "fast_drop", "falling_knife"] },
      { date: "2011-09-06", shouldHit: ["high_volatility"], shouldMiss: ["extreme_volatility", "falling_knife"] },
      { date: "2011-09-23", shouldHit: ["high_volatility", "fast_drop"], shouldMiss: ["extreme_volatility", "falling_knife"] },
      { date: "2020-03-16", shouldHit: ["high_volatility", "fast_drop", "slow_decline"], shouldMiss: ["extreme_volatility", "falling_knife"] },
      { date: "2020-08-06", shouldHit: ["slow_rise"], shouldMiss: ["extreme_volatility", "high_volatility", "fast_drop"] },
      { date: "2020-08-11", shouldHit: ["high_volatility", "fast_drop", "falling_knife"], shouldMiss: ["extreme_volatility", "slow_decline"] },
      { date: "2025-12-01", shouldHit: ["slow_rise"], shouldMiss: ["extreme_volatility", "fast_drop", "falling_knife"] },
      { date: "2025-12-29", shouldHit: ["fast_drop", "sideways"], shouldMiss: ["extreme_volatility", "high_volatility", "falling_knife"] },
      { date: "2026-02-02", shouldHit: ["extreme_volatility", "fast_drop", "falling_knife"], shouldMiss: ["slow_decline", "sideways"] },
      { date: "2026-03-23", shouldHit: ["high_volatility", "fast_drop"], shouldMiss: ["extreme_volatility", "falling_knife"] },
      { date: "2026-06-05", shouldMiss: ["extreme_volatility", "high_volatility", "fast_rise", "fast_drop", "falling_knife"] }
    ]
  }
];

const round = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
};

const assertRuleHits = (
  config: AssetRegressionConfig,
  evaluation: SilverSwingEvaluation,
  expected: string[] = [],
  mode: "hit" | "miss"
) => {
  for (const ruleKey of expected) {
    const hasRule = evaluation.hitRuleKeys.includes(ruleKey);
    if (mode === "hit") {
      assert.ok(
        hasRule,
        `${config.label} ${evaluation.date} should hit ${ruleKey}, actual: ${evaluation.hitRuleKeys.join(", ")}`
      );
    } else {
      assert.ok(
        !hasRule,
        `${config.label} ${evaluation.date} should not hit ${ruleKey}, actual: ${evaluation.hitRuleKeys.join(", ")}`
      );
    }
  }
};

const loadAssetData = async (db: Awaited<ReturnType<typeof open>>, config: AssetRegressionConfig) => {
  const points = await db.all<MarketPricePoint[]>(
    `SELECT trade_date, close
     FROM market_anchor_daily_prices
     WHERE symbol = ?
       AND close IS NOT NULL
     ORDER BY trade_date ASC`,
    [config.symbol]
  );
  const rules = await db.all<MarketAssistRuleInput[]>(
    `SELECT rule_key, rule_type, threshold_json, status, display_order
     FROM market_assist_rules
     WHERE asset_symbol = ?
       AND rule_group = ?
       AND status = 'active'
     ORDER BY display_order ASC`,
    [config.symbol, config.ruleGroup]
  );
  return { points, rules };
};

const verifyAsset = async (db: Awaited<ReturnType<typeof open>>, config: AssetRegressionConfig) => {
  const { points, rules } = await loadAssetData(db, config);

  assert.ok(points.length > config.minRows, `${config.label} expected enough history, got ${points.length}`);
  for (const ruleKey of config.requiredRules) {
    assert.ok(rules.some(rule => rule.rule_key === ruleKey), `${config.label} missing assist rule: ${ruleKey}`);
  }

  const allEvaluations = points.map(point => evaluateSilverSwingRules(points, rules, point.trade_date));
  const byDate = new Map(allEvaluations.map(evaluation => [evaluation.date, evaluation]));

  for (const sample of config.samples) {
    const evaluation = byDate.get(sample.date);
    assert.ok(evaluation, `${config.label} missing regression date: ${sample.date}`);
    assertRuleHits(config, evaluation, sample.shouldHit, "hit");
    assertRuleHits(config, evaluation, sample.shouldMiss, "miss");
  }

  for (const expectation of config.clusterExpectations || []) {
    const clusters = clusterRuleHits(allEvaluations, expectation.ruleKey, expectation.mergeGap)
      .map(({ start, end }) => ({ start, end }));
    assert.deepStrictEqual(
      clusters,
      expectation.clusters,
      `${config.label} ${expectation.ruleKey} clusters drifted: ${JSON.stringify(clusters)}`
    );
  }

  const reportRows = config.samples.map(sample => {
    const evaluation = byDate.get(sample.date)!;
    return {
      asset: config.symbol,
      date: evaluation.date,
      close: round(evaluation.close),
      r1: round(evaluation.metrics.dailyReturnPercent),
      r5: round(evaluation.metrics.return5dPercent),
      r10: round(evaluation.metrics.return10dPercent),
      r20: round(evaluation.metrics.return20dPercent),
      range20: round(evaluation.metrics.range20dPercent),
      hits: evaluation.hitRuleKeys.join(" / ") || "-"
    };
  });

  console.log(`${config.label} regression passed (${points.length} rows, ${rules.length} rules).`);
  console.table(reportRows);
};

const main = async () => {
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  try {
    for (const config of configs) {
      await verifyAsset(db, config);
    }
  } finally {
    await db.close();
  }
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
