import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("records Qiandao flash buy-limit change without inventing 遇见的惊喜 prices", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qiandao-flash-limit-"));
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
      `SELECT id FROM migrations WHERE id = '20261011_002_record_qiandao_flash_buy_limit_change'`
    );
    assert.ok(applied);

    const rule = await db.get(
      `SELECT title, type, track, core_content, summary_conclusion, note
       FROM rule_experiences
       WHERE title = '千岛闪购单号限购从约1%改为固定30只'
         AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(rule);
    assert.match(String(rule.core_content), /出售500只以内，一个号最多买5只/);
    assert.match(String(rule.core_content), /一个号可以买30只/);
    assert.match(String(rule.core_content), /不构成买入许可/);

    const archive = await db.get(
      `SELECT experience_note, position_level, one_sentence_judgment
       FROM product_archives
       WHERE archive_name = 'Zsiga / 遇见的惊喜' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(archive);
    assert.equal(archive.position_level, "watch");
    assert.match(String(archive.one_sentence_judgment), /只盯不买/);
    assert.match(String(archive.experience_note), /2026-10-11补充：千岛闪购单号限购改为30/);
    assert.match(String(archive.experience_note), /一号扫了30只/);
    assert.doesNotMatch(String(archive.experience_note), /买入许可/);

    const stage = await db.get(
      `SELECT stage_summary, action_rule
       FROM product_archive_stages
       WHERE stage_name = '千岛单号限购放宽后的扫货' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(stage);
    assert.match(String(stage.stage_summary), /固定30只/);
    assert.match(String(stage.action_rule), /不把30只扫货写成买入许可/);

    const profile = await db.get(
      `SELECT extra_json, experience_notes
       FROM category_profiles
       WHERE category_name = '泡泡玛特'
         AND object_name = 'Zsiga'
         AND variant_name = '遇见的惊喜'
         AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(profile);
    const extra = JSON.parse(String(profile.extra_json));
    assert.equal(extra.generation, 3);
    assert.equal(extra.qiandao_flash_buy_limit.new_rule, "one account can buy 30 regardless of listed qty");
    assert.equal(extra.qiandao_flash_buy_limit.invented_price, false);

    const original = await db.get(
      `SELECT id FROM original_price_records
       WHERE object_name = 'Zsiga' AND variant_name = '遇见的惊喜' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.equal(original, undefined);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20261011_002_record_qiandao_flash_buy_limit_change"]
    );
    await runMigrations(filename);
    const ruleCount = await db.get(
      `SELECT COUNT(*) AS total FROM rule_experiences
       WHERE title = '千岛闪购单号限购从约1%改为固定30只' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.equal(Number(ruleCount.total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
