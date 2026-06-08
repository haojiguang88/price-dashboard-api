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

const requiredRules = [
  "extreme_volatility",
  "extreme_buy_lock",
  "extreme_sell_ladder",
  "extreme_crash_guard",
  "extreme_reentry_check",
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

const regressionSamples = [
  {
    date: "2011-04-25",
    shouldHit: ["fast_rise", "overheat_rise"],
    shouldMiss: ["extreme_volatility", "falling_knife"]
  },
  {
    date: "2011-05-06",
    shouldHit: ["extreme_volatility", "fast_drop", "falling_knife"],
    shouldMiss: ["slow_decline", "sideways"]
  },
  {
    date: "2011-06-14",
    shouldHit: ["slow_decline"],
    shouldMiss: ["extreme_volatility", "falling_knife", "sideways"]
  },
  {
    date: "2020-03-17",
    shouldHit: ["high_volatility", "fast_drop", "falling_knife"],
    shouldMiss: ["extreme_volatility", "sideways"]
  },
  {
    date: "2020-03-20",
    shouldHit: ["extreme_volatility", "fast_rise", "fast_drop", "falling_knife"],
    shouldMiss: ["sideways"]
  },
  {
    date: "2020-08-10",
    shouldHit: ["high_volatility", "fast_rise", "overheat_rise"],
    shouldMiss: ["extreme_volatility", "falling_knife"]
  },
  {
    date: "2020-08-12",
    shouldHit: ["extreme_volatility", "fast_drop", "falling_knife"],
    shouldMiss: ["slow_decline", "sideways"]
  },
  {
    date: "2025-12-05",
    shouldHit: ["slow_rise"],
    shouldMiss: ["extreme_volatility", "fast_rise", "overheat_rise", "fast_drop", "falling_knife", "sideways"]
  },
  {
    date: "2025-12-24",
    shouldHit: ["high_volatility", "fast_rise", "overheat_rise"],
    shouldMiss: ["extreme_volatility", "falling_knife"]
  },
  {
    date: "2026-01-29",
    shouldHit: ["extreme_volatility", "fast_rise", "overheat_rise"],
    shouldMiss: ["falling_knife", "sideways"]
  },
  {
    date: "2026-02-05",
    shouldHit: ["extreme_volatility", "fast_drop", "falling_knife"],
    shouldMiss: ["slow_decline", "sideways"]
  },
  {
    date: "2026-03-23",
    shouldHit: ["extreme_volatility", "fast_drop", "falling_knife"],
    shouldMiss: ["slow_decline", "sideways"]
  },
  {
    date: "2026-06-05",
    shouldHit: ["high_volatility", "slow_decline"],
    shouldMiss: ["extreme_volatility", "fast_drop", "falling_knife", "sideways"]
  }
];

const expectedExtremeClusters = [
  { start: "2011-05-06", end: "2011-05-30" },
  { start: "2020-03-20", end: "2020-04-15" },
  { start: "2020-08-12", end: "2020-08-18" },
  { start: "2026-01-05", end: "2026-04-20" }
];

const round = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
};

const assertRuleHits = (evaluation: SilverSwingEvaluation, expected: string[], mode: "hit" | "miss") => {
  for (const ruleKey of expected) {
    const hasRule = evaluation.hitRuleKeys.includes(ruleKey);
    if (mode === "hit") {
      assert.ok(hasRule, `${evaluation.date} should hit ${ruleKey}, actual: ${evaluation.hitRuleKeys.join(", ")}`);
    } else {
      assert.ok(!hasRule, `${evaluation.date} should not hit ${ruleKey}, actual: ${evaluation.hitRuleKeys.join(", ")}`);
    }
  }
};

const main = async () => {
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  try {
    const points = await db.all<MarketPricePoint[]>(
      `SELECT trade_date, close
       FROM market_anchor_daily_prices
       WHERE symbol = 'SGE_AGTD'
         AND close IS NOT NULL
       ORDER BY trade_date ASC`
    );
    const rules = await db.all<MarketAssistRuleInput[]>(
      `SELECT rule_key, rule_type, threshold_json, status, display_order
       FROM market_assist_rules
       WHERE asset_symbol = 'SGE_AGTD'
         AND rule_group = 'silver_swing_plan'
         AND status = 'active'
       ORDER BY display_order ASC`
    );

    assert.ok(points.length > 4000, `Expected enough SGE_AGTD history, got ${points.length}`);
    for (const ruleKey of requiredRules) {
      assert.ok(rules.some(rule => rule.rule_key === ruleKey), `Missing assist rule: ${ruleKey}`);
    }

    const allEvaluations = points.map(point => evaluateSilverSwingRules(points, rules, point.trade_date));
    const byDate = new Map(allEvaluations.map(evaluation => [evaluation.date, evaluation]));

    for (const sample of regressionSamples) {
      const evaluation = byDate.get(sample.date);
      assert.ok(evaluation, `Missing regression date: ${sample.date}`);
      assertRuleHits(evaluation, sample.shouldHit, "hit");
      assertRuleHits(evaluation, sample.shouldMiss, "miss");
    }

    const extremeClusters = clusterRuleHits(allEvaluations, "extreme_volatility", 2)
      .map(({ start, end }) => ({ start, end }));
    assert.deepStrictEqual(
      extremeClusters,
      expectedExtremeClusters,
      `Extreme volatility clusters drifted: ${JSON.stringify(extremeClusters)}`
    );

    const reportRows = regressionSamples.map(sample => {
      const evaluation = byDate.get(sample.date)!;
      return {
        date: evaluation.date,
        close: round(evaluation.close),
        r1: round(evaluation.metrics.dailyReturnPercent),
        r5: round(evaluation.metrics.return5dPercent),
        r10: round(evaluation.metrics.return10dPercent),
        r20: round(evaluation.metrics.return20dPercent),
        range20: round(evaluation.metrics.range20dPercent),
        hits: evaluation.hitRuleKeys.join(" / ")
      };
    });

    console.log(`Silver assist evaluator regression passed (${points.length} rows, ${rules.length} rules).`);
    console.table(reportRows);
  } finally {
    await db.close();
  }
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
