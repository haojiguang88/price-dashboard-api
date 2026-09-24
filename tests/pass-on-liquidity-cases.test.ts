import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("seeds four pass-on cases without rewriting later prices into the original decision", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pass-on-liquidity-"));
  const filename = path.join(directory, "business.db");
  const manager = new DatabaseManager({
    filename,
    allowCreate: true,
    initialize: initializeBusinessBaseSchema
  });

  try {
    await manager.getDb();
    await runMigrations(filename);
    const db = await manager.getDb();

    const applied = await db.get(
      `SELECT id FROM migrations WHERE id = '20260924_003_seed_pass_on_liquidity_cases'`
    );
    assert.ok(applied);

    const pokemon = await db.get(
      `SELECT title, action_taken, result, outcome_type, evidence_role, learn_to_avoid,
              applicability_boundary, pricing_analysis_json
       FROM behavior_cases
       WHERE project_name = '宝可梦30周年' AND is_deleted = 0`
    );
    assert.ok(pokemon);
    assert.match(pokemon.action_taken, /没有开A仓/);
    assert.match(pokemon.result, /后来起飞了/);
    assert.match(pokemon.result, /不把起飞写成卖飞/);
    assert.equal(pokemon.outcome_type, "unknown");
    assert.equal(pokemon.evidence_role, "boundary");
    assert.match(pokemon.learn_to_avoid, /后来的起飞证明当时该干/);
    assert.match(pokemon.applicability_boundary, /不把本案例当成宝可梦日常跟踪/);
    assert.equal(JSON.parse(pokemon.pricing_analysis_json).exitLiquidity, "thin");

    const moutai = await db.get(
      `SELECT background, later_outcome, short_lesson
       FROM market_reviews
       WHERE project_name = '茅台四季' AND is_deleted = 0`
    );
    const moutaiCase = await db.get(
      `SELECT action_taken, result, pricing_analysis_json, linked_rule_refs_json
       FROM behavior_cases
       WHERE project_name = '茅台四季' AND is_deleted = 0`
    );
    assert.ok(moutai);
    assert.ok(moutaiCase);
    assert.match(String(moutai.background), /一套4瓶/);
    assert.match(String(moutai.short_lesson), /官方限量不信/);
    assert.match(String(moutai.later_outcome), /不证明当时已经精确预测/);
    assert.match(moutaiCase.action_taken, /复刻不了70周年/);
    assert.match(moutaiCase.result, /破发/);
    const moutaiPricing = JSON.parse(moutaiCase.pricing_analysis_json);
    assert.equal(moutaiPricing.observedPriceLow, 500);
    assert.equal(moutaiPricing.observedPriceHigh, 600);
    assert.equal(moutaiPricing.priceSignalType, "bid");
    assert.match(moutaiPricing.verificationNote, /一套加价/);
    const moutaiRules = JSON.parse(moutaiCase.linked_rule_refs_json);
    assert.ok(moutaiRules.some((item: string) => item.includes("70周年")));

    const iphone = await db.get(
      `SELECT later_outcome, market_evolution, note
       FROM market_reviews
       WHERE project_name = 'iPhone 18系列' AND is_deleted = 0`
    );
    const iphoneCase = await db.get(
      `SELECT action_taken, result, outcome_type, pricing_analysis_json
       FROM behavior_cases
       WHERE project_name = 'iPhone 18系列' AND is_deleted = 0`
    );
    assert.ok(iphone);
    assert.ok(iphoneCase);
    assert.match(iphone.later_outcome, /不在V0\.1里写盈亏/);
    assert.match(iphone.market_evolution, /10050/);
    assert.match(iphone.market_evolution, /9850/);
    assert.match(iphone.market_evolution, /不能写成已经完成反撸/);
    assert.equal(iphoneCase.outcome_type, "ongoing");
    assert.match(iphoneCase.action_taken, /发货慢按反撸/);
    const iphonePricing = JSON.parse(iphoneCase.pricing_analysis_json);
    assert.equal(iphonePricing.basePrice, 10050);
    assert.equal(iphonePricing.observedPriceLow, 9850);

    const cards = await db.get(
      `SELECT action_taken, learn_to_avoid, linked_rule_refs_json
       FROM behavior_cases
       WHERE project_name = '球星卡' AND is_deleted = 0`
    );
    assert.ok(cards);
    assert.match(cards.action_taken, /不参与炒作/);
    assert.match(cards.learn_to_avoid, /原价抽的安全感带进二级炒作/);
    const cardRules = JSON.parse(cards.linked_rule_refs_json);
    assert.ok(cardRules.some((item: string) => item.includes("原价抽")));

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260924_003_seed_pass_on_liquidity_cases"]
    );
    await runMigrations(filename);
    const duplicate = await db.get(
      `SELECT COUNT(*) AS total FROM behavior_cases
       WHERE project_name IN ('宝可梦30周年', '茅台四季', 'iPhone 18系列', '球星卡')
         AND is_deleted = 0`
    );
    assert.equal(Number(duplicate.total), 4);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
