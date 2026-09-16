import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("starts Gazijie core position as layered entry and forbids filling all at once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gazijie-layered-core-"));
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
    await db.run("INSERT OR IGNORE INTO objects (category_id, name) VALUES (?, ?)", [category.id, "嘎子姐"]);
    const object = await db.get(
      "SELECT id FROM objects WHERE category_id = ? AND name = ?",
      [category.id, "嘎子姐"]
    );
    const existingArchive = await db.get(
      `SELECT id FROM product_archives
       WHERE category_name = '泡泡玛特' AND object_name = '嘎子姐' AND is_deleted = 0
       ORDER BY id LIMIT 1`
    );
    if (!existingArchive) {
      await db.run(
        `INSERT INTO product_archives
          (category_id, category_name, object_id, object_name, archive_name,
           position_level, one_sentence_judgment, issue_info, risk_basis,
           experience_note, pending_questions, confidence, status)
         VALUES (?, '泡泡玛特', ?, '嘎子姐', '嘎子姐', 'main', ?, ?, ?, ?, ?,
                 'confirmed', 'active')`,
        [
          category.id,
          object.id,
          "等补货把价格砸下来就干",
          "没有经历过持续数月的通货补",
          "每天更新价格",
          "补货观察",
          "补货时间未知"
        ]
      );
    }
    await db.run(
      `INSERT OR IGNORE INTO annual_plans
        (year, title, status, is_deleted, created_at, updated_at)
       VALUES (2026, '2026年度计划', '生效中', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    );

    await db.run(
      "DELETE FROM migrations WHERE id IN (?, ?)",
      [
        "20260912_003_start_gazijie_layered_core_position",
        "20260912_004_keep_gazijie_core_position_in_plans_only"
      ]
    );
    await runMigrations(filename);

    const archive = await db.get(
      `SELECT one_sentence_judgment, experience_note, pending_questions
       FROM product_archives
       WHERE category_name = '泡泡玛特' AND object_name = '嘎子姐' AND is_deleted = 0`
    );
    assert.ok(archive);
    assert.equal(archive.one_sentence_judgment, "等补货把价格砸下来就干");
    assert.doesNotMatch(String(archive.experience_note || ""), /底仓分层占位/);
    assert.doesNotMatch(String(archive.pending_questions || ""), /不能把底仓一次打满/);

    const annualItem = await db.get(
      `SELECT current_role, current_action, current_status, position_rule, thesis
       FROM annual_plan_items
       WHERE category = '泡泡玛特' AND object_name = '嘎子姐' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(annualItem);
    assert.equal(annualItem.current_role, "试错");
    assert.equal(annualItem.current_action, "轻仓参与");
    assert.equal(annualItem.current_status, "生效中");
    assert.match(annualItem.position_rule, /禁止一次打满/);
    assert.match(annualItem.thesis, /不把泡泡玛特整体升回主做/);

    const buyPlan = await db.get(
      `SELECT plan_name, status, plan_quantity, batches, note
       FROM buying_plans
       WHERE plan_name = '嘎子姐底仓分层占位' AND object_name = '嘎子姐'`
    );
    assert.ok(buyPlan);
    assert.equal(buyPlan.status, "pending");
    assert.equal(Number(buyPlan.plan_quantity), 2);
    assert.match(buyPlan.note, /禁止一次打满/);
    const batches = JSON.parse(buyPlan.batches);
    assert.equal(batches.length, 2);
    assert.equal(batches[0].target_price, 530);
    assert.equal(batches[1].target_price, 500);
    assert.equal(batches[0].plan_quantity, 1);
    assert.match(batches[0].note, /不加价追/);
    assert.match(batches[1].note, /第一层没观察完不加/);

    await db.run(
      "DELETE FROM migrations WHERE id IN (?, ?)",
      [
        "20260912_003_start_gazijie_layered_core_position",
        "20260912_004_keep_gazijie_core_position_in_plans_only"
      ]
    );
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM buying_plans WHERE plan_name = '嘎子姐底仓分层占位') AS plan_total,
         (SELECT COUNT(*) FROM annual_plan_items
          WHERE object_name = '嘎子姐' AND COALESCE(is_deleted, 0) = 0) AS item_total`
    );
    assert.equal(Number(duplicateCheck.plan_total), 1);
    assert.equal(Number(duplicateCheck.item_total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
