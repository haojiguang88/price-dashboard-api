import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCoinSilverPremiumSnapshot,
  inferCommemorativeCoinSilverWeight
} from "../src/services/coinSilverPremiumService";
import type { SilverAnchorEvidence } from "../src/services/marketAnchorService";

const buildAnchor = (overrides: Partial<SilverAnchorEvidence> = {}): SilverAnchorEvidence => ({
  symbol: "SGE_AGTD",
  label: "白银延期 Ag(T+D)",
  source: "tushare_sge",
  source_label: "Tushare 上金所 Ag(T+D)",
  latest_date: "2026-04-17",
  latest_close: 19.588,
  previous_close: 19.1,
  day_change_percent: 1,
  change_5d_percent: 5.5,
  change_20d_percent: 8.9,
  change_60d_percent: 12,
  high_60d: 22,
  low_60d: 16,
  sample_count_60d: 61,
  task_status: null,
  checked_at: "2026-04-17T10:00:00.000Z",
  latest_checked_at: "2026-04-17T10:00:00.000Z",
  freshness_status: "fresh",
  freshness_label: "已校验",
  refresh_status: "not_requested",
  refresh_message: "未触发刷新",
  evidence_note: "测试",
  risk_reference_note: "测试",
  trend_suggestion: {
    trend_phase: "牛市",
    recent_move: "温和上涨",
    action_bias: "偏持有",
    data_freshness: "新鲜",
    confidence: "高",
    basis: [],
    metrics: {
      day_change_percent: 1,
      change_3d_percent: 2,
      change_5d_percent: 5.5,
      change_10d_percent: 6,
      change_20d_percent: 8.9,
      change_60d_percent: 12,
      change_120d_percent: 20,
      ma_20: 18,
      ma_60: 17,
      drawdown_60d_percent: -5
    },
    note: "测试"
  },
  ...overrides
});

test("纪念币银本体溢价按重量和当日银价计算", () => {
  const result = calculateCoinSilverPremiumSnapshot({
    reference_price: 909,
    silver_grams: 30,
    price_source: "商品原始价格",
    weight_basis: "30g"
  }, buildAnchor(), "2026-04-17T11:00:00.000Z");

  assert.ok(result);
  assert.equal(result.silver_content_value, 587.64);
  assert.equal(result.premium_percent, 54.7);
  assert.equal(result.premium_band, "medium");
  assert.equal(result.decision, "neutral");
});

test("超高溢价在真实热度未确认时只提示补证据，不直接改变结果", () => {
  const result = calculateCoinSilverPremiumSnapshot({
    reference_price: 1198,
    silver_grams: 30
  }, buildAnchor());

  assert.ok(result);
  assert.equal(result.premium_percent, 103.9);
  assert.equal(result.premium_band, "very_high");
  assert.equal(result.decision, "incomplete");
  assert.equal(result.market_heat.level, "unknown");
});

test("银价走弱叠加高溢价和弱承接才形成组合提示", () => {
  const anchor = buildAnchor({
    trend_suggestion: {
      ...buildAnchor().trend_suggestion,
      trend_phase: "牛转熊",
      recent_move: "连续阴跌"
    }
  });
  const result = calculateCoinSilverPremiumSnapshot({
    reference_price: 1071,
    silver_grams: 30
  }, anchor, "2026-04-17T11:00:00.000Z", {
    has_market_heat: "否",
    has_continuous_bid_support: "否",
    deal_band_stable: "否",
    only_hype_no_real_demand: "是"
  });

  assert.ok(result);
  assert.equal(result.premium_band, "high");
  assert.equal(result.trend_risk, "high_risk");
  assert.equal(result.decision, "watch");
  assert.equal(result.market_heat.level, "weak");
});

test("银价连续暴涨时负溢价只作背景，强承接下不直接降级", () => {
  const anchor = buildAnchor({
    latest_date: "2026-01-28",
    latest_close: 29.31,
    trend_suggestion: {
      ...buildAnchor().trend_suggestion,
      trend_phase: "牛市",
      recent_move: "连续暴涨"
    }
  });
  const result = calculateCoinSilverPremiumSnapshot({
    reference_price: 745,
    silver_grams: 30
  }, anchor, "2026-01-28T11:00:00.000Z", {
    has_market_heat: "是",
    has_continuous_bid_support: "是",
    deal_band_stable: "是",
    only_hype_no_real_demand: "否"
  });

  assert.ok(result);
  assert.equal(result.premium_percent, -15.3);
  assert.equal(result.premium_band, "below_melt");
  assert.equal(result.decision, "neutral");
  assert.equal(result.market_heat.level, "strong");
  assert.match(result.risk_note, /不单独改变风控结果/);
});

test("含银重量优先从名称识别，龙银币卡类才按 30g 估算", () => {
  assert.deepEqual(
    inferCommemorativeCoinSilverWeight("马年银币", "150g大黑马"),
    { grams: 150, basis: "从本地名称/记录识别 150g" }
  );
  assert.deepEqual(
    inferCommemorativeCoinSilverWeight("工商卡", "2026年"),
    { grams: 30, basis: "按本地龙银币/卡类 30g 口径估算，可手动修改" }
  );
  assert.equal(inferCommemorativeCoinSilverWeight("未知纪念币", "普通版").grams, null);
});
