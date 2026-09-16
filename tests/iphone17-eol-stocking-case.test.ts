import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("seeds the ongoing iPhone 17 EOL stocking case without writing an outcome", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "iphone17-eol-stocking-"));
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
    const marketTitle = "2026 iPhone 17 停产涨价囤货观察（进行中 V0.1）";
    const behaviorTitle = "iPhone 17停产涨价叙事：看不清先不参加，杠杆囤货另记账";

    const review = await db.get(
      `SELECT id, track, project_name, review_date, market_type_custom,
              summary_conclusion, short_lesson, background, market_evolution,
              later_outcome, extracted_lesson, exposed_problem, note
       FROM market_reviews
       WHERE title = ? AND is_deleted = 0`,
      [marketTitle]
    );
    assert.ok(review);
    assert.equal(review.track, "苹果手机");
    assert.equal(review.project_name, "iPhone 17系列");
    assert.equal(review.review_date, "2026-09-11");
    assert.match(review.market_type_custom, /杠杆库存风险/);
    assert.match(review.summary_conclusion, /没有参加/);
    assert.match(review.summary_conclusion, /后期涨不涨未知/);
    assert.match(review.short_lesson, /一台亏也就一两百/);
    assert.match(review.short_lesson, /不涨就废了，得赔死/);
    assert.match(review.exposed_problem, /一台普通回撤大约一两百/);
    assert.match(review.note, /后续行情由用户自行更新/);
    assert.match(review.background, /潮收汇苹果备用报价/);
    assert.match(review.market_evolution, /9月10日回到5900元/);
    assert.match(review.market_evolution, /7930元/);
    assert.match(review.market_evolution, /9000元/);
    assert.match(review.later_outcome, /V0\.1不写结局/);
    assert.doesNotMatch(review.later_outcome, /已经判断它会跌/);
    assert.match(review.extracted_lesson, /不拿后来的涨跌改写当时判断/);
    assert.match(review.note, /认知冻结日：2026-09-11/);
    assert.match(review.note, /形成V0\.2，不改写V0\.1原判断/);

    const behaviorCase = await db.get(
      `SELECT id, origin_type, evidence_level, action_quality, outcome_type,
              evidence_role, action_taken, result, self_response,
              pricing_analysis_json, source_type, source_id, linked_rule_refs_json
       FROM behavior_cases
       WHERE title = ? AND is_deleted = 0`,
      [behaviorTitle]
    );
    assert.ok(behaviorCase);
    assert.equal(behaviorCase.origin_type, "self");
    assert.equal(behaviorCase.evidence_level, "first_hand");
    assert.equal(behaviorCase.action_quality, "good");
    assert.equal(behaviorCase.outcome_type, "ongoing");
    assert.equal(behaviorCase.evidence_role, "boundary");
    assert.match(behaviorCase.action_taken, /没有参加/);
    assert.match(behaviorCase.result, /会不会涨不知道/);
    assert.match(behaviorCase.self_response, /一台普通回撤大约一两百/);
    assert.match(behaviorCase.self_response, /加杠杆后不涨就会赔死/);
    assert.equal(behaviorCase.source_type, "market_review");
    assert.equal(String(behaviorCase.source_id), String(review.id));

    const linkedRules = JSON.parse(behaviorCase.linked_rule_refs_json);
    assert.ok(linkedRules.some((item: string) => item.includes("一两百")));
    assert.ok(linkedRules.some((item: string) => item.includes("赔死")));
    const pricing = JSON.parse(behaviorCase.pricing_analysis_json);
    assert.equal(pricing.basePrice, 5900);
    assert.equal(pricing.observedPriceHigh, 9050);
    assert.equal(pricing.priceSignalType, "market_reference");
    assert.equal(pricing.buyerBreadth, "concentrated");
    assert.deepEqual(pricing.conditionStack, [
      "17停产叙事",
      "18涨价并发布叙事",
      "二级档口囤货",
      "撸货圈子",
      "部分杠杆收货"
    ]);

    const links = await db.all(
      `SELECT p.name, l.role
       FROM behavior_case_pattern_links l
       JOIN behavior_patterns p ON p.id = l.pattern_id
       WHERE l.case_id = ?
       ORDER BY CASE l.role WHEN 'primary' THEN 0 ELSE 1 END, p.name`,
      [behaviorCase.id]
    );
    assert.deepEqual(links, [
      { name: "过度下注", role: "primary" },
      { name: "抢跑/没有等待", role: "secondary" },
      { name: "研究与推演停在表层", role: "secondary" }
    ]);

    await db.run(
      "DELETE FROM migrations WHERE id IN (?, ?)",
      [
        "20260911_001_seed_iphone17_eol_stocking_case",
        "20260911_002_refine_iphone17_unlevered_vs_leverage_loss"
      ]
    );
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM market_reviews
          WHERE title = ? AND is_deleted = 0) AS review_total,
         (SELECT COUNT(*) FROM behavior_cases
          WHERE title = ? AND is_deleted = 0) AS case_total`,
      [marketTitle, behaviorTitle]
    );
    assert.equal(Number(duplicateCheck.review_total), 1);
    assert.equal(Number(duplicateCheck.case_total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
