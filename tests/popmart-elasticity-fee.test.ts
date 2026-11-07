import assert from "node:assert/strict";
import test from "node:test";
import { calculateSwingMetrics } from "../src/routes/elasticityAnalysisRoutes";

test("泡泡玛特反弹先扣 3% 卖出费用，盖不住费用不算一轮", () => {
  const blocked = calculateSwingMetrics([100, 90, 92], "泡泡玛特");
  assert.equal(blocked.sell_fee_rate, 0.03);
  assert.equal(blocked.completed_swing_count, 0);
  assert.equal(blocked.tradable_space_passed, false);
  assert.match(blocked.tradable_space_hint, /3%/);
});

test("泡泡玛特毛波动刚过 8% 时，扣费后不再达到可做门槛", () => {
  const tight = calculateSwingMetrics([719, 661, 719], "泡泡玛特");
  assert.equal(tight.completed_swing_count, 1);
  assert.ok(tight.net_range_amount > 30);
  assert.ok(tight.net_range_rate < 8);
  assert.equal(tight.tradable_space_passed, false);
  assert.equal(tight.elasticity_pattern, "有往返但空间不足");
});

test("泡泡玛特扣费后仍过 30 元和 8% 才算可做", () => {
  const tradable = calculateSwingMetrics([2067, 1208, 1692], "泡泡玛特");
  assert.equal(tradable.completed_swing_count, 1);
  assert.ok(tradable.net_range_amount >= 30);
  assert.ok(tradable.net_range_rate >= 8);
  assert.equal(tradable.tradable_space_passed, true);
  const rebound = 1692 * 0.97 - 1208;
  assert.ok(Math.abs(tradable.effective_swing_amount - Math.min(2067 - 1208, rebound)) < 0.01);
});

test("没有卖出费用的品类仍按毛价差判断", () => {
  const gross = calculateSwingMetrics([200, 100, 180], "游戏机");
  assert.equal(gross.sell_fee_rate, 0);
  assert.equal(gross.completed_swing_count, 1);
  assert.equal(gross.tradable_space_passed, true);
  assert.ok(Math.abs(gross.net_range_amount - 100) < 0.01);
});
