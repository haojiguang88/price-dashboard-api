import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("seeds the gingerbread A-position case without calling empty inventory a miss", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zsiga-gingerbread-a-"));
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
    const marketTitle = "2026 Zsiga姜饼人：没有A仓占位，现价不能写成踏空（进行中 V0.1）";
    const behaviorTitle = "姜饼人：1000附近该占A仓没占，现价不是补课口";

    const applied = await db.get(
      `SELECT id FROM migrations WHERE id = '20261010_001_seed_zsiga_gingerbread_a_position_case'`
    );
    assert.ok(applied);

    const review = await db.get(
      `SELECT id, track, project_name, review_date, summary_conclusion, short_lesson,
              later_outcome, extracted_lesson, note
       FROM market_reviews
       WHERE title = ? AND is_deleted = 0`,
      [marketTitle]
    );
    assert.ok(review);
    assert.equal(review.track, "泡泡玛特");
    assert.equal(review.project_name, "Zsiga姜饼人");
    assert.equal(review.review_date, "2026-10-10");
    assert.match(review.summary_conclusion, /没有在1000附近拿一两只做A仓占位/);
    assert.match(review.short_lesson, /没有座位不能叫踏空/);
    assert.match(review.later_outcome, /不把没有A仓写成绝对踏空/);
    assert.match(review.later_outcome, /不把现价拿来补A仓/);
    assert.doesNotMatch(review.later_outcome, /已经判断它会跌/);
    assert.match(review.extracted_lesson, /A仓占位有时比看对方向更重要/);
    assert.match(review.note, /认知冻结日：2026-10-10/);

    const behaviorCase = await db.get(
      `SELECT id, action_quality, outcome_type, evidence_role, action_taken, result,
              self_response, learn_to_avoid, applicability_boundary, linked_rule_refs_json,
              pricing_analysis_json
       FROM behavior_cases
       WHERE title = ? AND is_deleted = 0`,
      [behaviorTitle]
    );
    assert.ok(behaviorCase);
    assert.equal(behaviorCase.action_quality, "mixed");
    assert.equal(behaviorCase.outcome_type, "ongoing");
    assert.equal(behaviorCase.evidence_role, "boundary");
    assert.match(behaviorCase.action_taken, /1000附近没有拿一两只做A仓占位/);
    assert.match(behaviorCase.action_taken, /现价1793不追/);
    assert.match(behaviorCase.result, /不是看错方向后的踏空账单/);
    assert.match(behaviorCase.self_response, /现价不是补座位的地方/);
    assert.match(behaviorCase.learn_to_avoid, /绝对踏空/);
    assert.match(behaviorCase.applicability_boundary, /不把本案例写成现在可以开仓/);
    const rules = JSON.parse(behaviorCase.linked_rule_refs_json);
    assert.ok(rules.some((item: string) => item.includes("A仓占位是座位")));
    const pricing = JSON.parse(behaviorCase.pricing_analysis_json);
    assert.equal(pricing.basePrice, 399);
    assert.equal(pricing.observedPriceLow, 858);
    assert.equal(pricing.observedPriceHigh, 1793);
    assert.equal(pricing.priceSignalType, "market_reference");

    const links = await db.all(
      `SELECT p.name, l.role
       FROM behavior_case_pattern_links l
       JOIN behavior_patterns p ON p.id = l.pattern_id
       WHERE l.case_id = ?
       ORDER BY CASE l.role WHEN 'primary' THEN 0 ELSE 1 END, p.name`,
      [behaviorCase.id]
    );
    assert.deepEqual(links, [
      { name: "主动放弃与纪律优先", role: "primary" },
      { name: "补货结构反转", role: "secondary" },
      { name: "资金拉盘", role: "secondary" },
      { name: "追高", role: "secondary" }
    ]);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20261010_001_seed_zsiga_gingerbread_a_position_case"]
    );
    await runMigrations(filename);
    const duplicate = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM market_reviews WHERE title = ? AND is_deleted = 0) AS review_total,
         (SELECT COUNT(*) FROM behavior_cases WHERE title = ? AND is_deleted = 0) AS case_total`,
      [marketTitle, behaviorTitle]
    );
    assert.equal(Number(duplicate.review_total), 1);
    assert.equal(Number(duplicate.case_total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
