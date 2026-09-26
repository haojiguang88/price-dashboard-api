import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("refines the Gazijie archive without inventing a dated 400-yuan price record", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gazijie-product-archive-"));
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
    await db.run("INSERT OR IGNORE INTO categories (name) VALUES (?)", ["泡泡玛特"]);
    const category = await db.get("SELECT id FROM categories WHERE name = ?", ["泡泡玛特"]);
    const object = await db.get(
      "SELECT id FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
      [category.id, "Zsiga"]
    );
    assert.ok(object);
    const legacyExperience = "之前也有过门店轮动补货，但不是通货补，当时把价格砸到450以下了。，然后就不咋补货了，零零散散的有补货，后来长时间横盘以后就涨上去了";
    const existingArchive = await db.get(
      `SELECT id FROM product_archives
       WHERE category_name = '泡泡玛特' AND object_name = 'Zsiga'
         AND COALESCE(variant_name, '') IN ('', '向往之处')
         AND is_deleted = 0
       ORDER BY id LIMIT 1`
    );
    if (existingArchive) {
      await db.run(
        `UPDATE product_archives
         SET issue_info = ?, risk_basis = ?, experience_note = ?, pending_questions = ?
         WHERE id = ?`,
        [
          "没有经历过持续数月的通货补",
          "每天更新价格",
          legacyExperience,
          "补货时间未知",
          existingArchive.id
        ]
      );
    } else {
      await db.run(
        `INSERT INTO product_archives
          (category_id, category_name, object_id, object_name, archive_name,
           position_level, one_sentence_judgment, issue_info, risk_basis,
           experience_note, pending_questions, confidence, status)
         VALUES (?, '泡泡玛特', ?, 'Zsiga', 'Zsiga / 向往之处', 'main', ?, ?, ?, ?, ?,
                 'confirmed', 'active')`,
        [
          category.id,
          object.id,
          "等补货把价格砸下来再观察",
          "没有经历过持续数月的通货补",
          "每天更新价格",
          legacyExperience,
          "补货时间未知"
        ]
      );
    }

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260906_001_refine_gazijie_supply_floor_archive"]
    );
    await runMigrations(filename);

    const archive = await db.get(
      `SELECT id, issue_info, risk_basis, experience_note, pending_questions
       FROM product_archives
       WHERE category_name = '泡泡玛特' AND object_name = 'Zsiga'
         AND COALESCE(variant_name, '') IN ('', '向往之处')
         AND is_deleted = 0`
    );
    assert.ok(archive);
    assert.match(archive.issue_info, /阶段性大规模补货和通货补必须分开判断/);
    assert.match(archive.risk_basis, /400元出头仅是历史上连续多日大规模补货/);
    assert.match(archive.experience_note, /历史供给压力锚（日期待核）/);
    assert.match(archive.experience_note, /官方未再出现同等级的大规模补货/);
    assert.doesNotMatch(archive.experience_note, /砸到450以下/);
    assert.match(archive.pending_questions, /周年庆线上货的实际规模/);

    const stages = await db.all(
      `SELECT stage_name, time_text, price_low, stage_summary, action_rule,
              evidence_note, confidence, sort_order, note
       FROM product_archive_stages
       WHERE archive_id = ? AND is_deleted = 0
       ORDER BY sort_order, id`,
      [archive.id]
    );
    assert.equal(stages.length, 2);
    assert.equal(stages[0].stage_name, "连续大规模补货压力底");
    assert.equal(stages[0].price_low, null);
    assert.match(stages[0].time_text, /具体日期待核/);
    assert.match(stages[0].evidence_note, /不能反证更早的400元出头低位/);
    assert.equal(stages[1].stage_name, "2026周年庆线上放货消化");
    assert.match(stages[1].stage_summary, /群内收货价也约为510元/);
    assert.match(stages[1].note, /不使用自提码作为信号/);

    const inventedPrice = await db.get(
      `SELECT COUNT(*) AS total
       FROM price_records
       WHERE category = '泡泡玛特'
         AND object_name IN ('嘎子姐', 'Zsiga')
         AND price > 400
         AND price < 500`
    );
    assert.equal(Number(inventedPrice.total), 0);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260906_001_refine_gazijie_supply_floor_archive"]
    );
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT COUNT(*) AS total
       FROM product_archive_stages
       WHERE archive_id = ?
         AND stage_name IN ('连续大规模补货压力底', '2026周年庆线上放货消化')
         AND is_deleted = 0`,
      [archive.id]
    );
    assert.equal(Number(duplicateCheck.total), 2);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("records Gazijie 520-area temporary stabilize without calling it a new floor", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gazijie-520-stabilize-"));
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
    await db.run("INSERT OR IGNORE INTO categories (name) VALUES (?)", ["泡泡玛特"]);
    const category = await db.get("SELECT id FROM categories WHERE name = ?", ["泡泡玛特"]);
    const object = await db.get(
      "SELECT id FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
      [category.id, "Zsiga"]
    );
    assert.ok(object);
    const existingArchive = await db.get(
      `SELECT id FROM product_archives
       WHERE category_name = '泡泡玛特' AND object_name = 'Zsiga'
         AND COALESCE(variant_name, '') IN ('', '向往之处')
         AND is_deleted = 0
       ORDER BY id LIMIT 1`
    );
    if (!existingArchive) {
      await db.run(
        `INSERT INTO product_archives
          (category_id, category_name, object_id, object_name, archive_name,
           position_level, one_sentence_judgment, issue_info, risk_basis,
           experience_note, pending_questions, confidence, status)
         VALUES (?, '泡泡玛特', ?, 'Zsiga', 'Zsiga / 向往之处', 'main', ?, ?, ?, ?, ?,
                 'confirmed', 'active')`,
        [
          category.id,
          object.id,
          "等补货把价格砸下来再观察",
          "没有经历过持续数月的通货补",
          "每天更新价格",
          "补货观察",
          "补货时间未知"
        ]
      );
    }

    await db.run(
      "DELETE FROM migrations WHERE id IN (?, ?)",
      [
        "20260906_001_refine_gazijie_supply_floor_archive",
        "20260912_002_record_gazijie_520_temporary_stabilize"
      ]
    );
    await runMigrations(filename);

    const archive = await db.get(
      `SELECT id, experience_note, pending_questions
       FROM product_archives
       WHERE category_name = '泡泡玛特' AND object_name = 'Zsiga'
         AND COALESCE(variant_name, '') IN ('', '向往之处')
         AND is_deleted = 0`
    );
    assert.ok(archive);
    assert.match(archive.experience_note, /2026-09-12：520附近暂时稳定/);
    assert.match(archive.experience_note, /520收不太好收/);
    assert.match(archive.experience_note, /不把520写成新底或买入许可/);
    assert.match(archive.pending_questions, /520收不太好收/);
    assert.match(archive.pending_questions, /千岛520\+/);

    const stabilize = await db.get(
      `SELECT time_text, price_low, price_end, stage_summary, action_rule, evidence_note
       FROM product_archive_stages
       WHERE archive_id = ?
         AND stage_name = '2026-09 放货后520附近暂时企稳'
         AND is_deleted = 0`,
      [archive.id]
    );
    assert.ok(stabilize);
    assert.match(stabilize.time_text, /暂时稳定/);
    assert.equal(Number(stabilize.price_low), 513);
    assert.equal(Number(stabilize.price_end), 529);
    assert.match(stabilize.stage_summary, /千岛也基本在520\+/);
    assert.match(stabilize.action_rule, /不把520当成新底或买入许可/);
    assert.match(stabilize.evidence_note, /不补造/);

    const dumpStage = await db.get(
      `SELECT time_text
       FROM product_archive_stages
       WHERE archive_id = ?
         AND stage_name = '2026周年庆线上放货消化'
         AND is_deleted = 0`,
      [archive.id]
    );
    assert.ok(dumpStage);
    assert.doesNotMatch(String(dumpStage.time_text), /进行中/);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260912_002_record_gazijie_520_temporary_stabilize"]
    );
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT COUNT(*) AS total
       FROM product_archive_stages
       WHERE archive_id = ?
         AND stage_name = '2026-09 放货后520附近暂时企稳'
         AND is_deleted = 0`,
      [archive.id]
    );
    assert.equal(Number(duplicateCheck.total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
