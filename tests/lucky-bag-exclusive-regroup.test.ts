import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

const variantNames = ["飞行员", "大米兰", "拿铁", "情人节", "蓝裙子"];

test("regroups lucky-bag exclusive SKUs under 福袋专属", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lucky-bag-exclusive-"));
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
      `SELECT id FROM migrations WHERE id = '20260926_005_regroup_lucky_bag_exclusive'`
    );
    assert.ok(applied);

    const series = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特' AND o.name = '福袋专属' AND COALESCE(o.is_archived, 0) = 0`
    );
    assert.ok(series);

    const variants = await db.all(
      `SELECT name FROM variants WHERE object_id = ? AND COALESCE(is_archived, 0) = 0`,
      [series.id]
    );
    assert.deepEqual(
      new Set(variants.map((row: { name: string }) => row.name)),
      new Set(variantNames)
    );

    const leftover = await db.all(
      `SELECT o.name FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特'
         AND o.name IN (${variantNames.map(() => "?").join(", ")})
         AND COALESCE(o.is_archived, 0) = 0`,
      variantNames
    );
    assert.equal(leftover.length, 0);

    const mappings = await db.all(
      `SELECT object_name, variant_name, external_key, status
       FROM source_mappings
       WHERE source_key = 'qiandao_popmart'
         AND variant_name IN (${variantNames.map(() => "?").join(", ")})
         AND COALESCE(status, '') != 'disabled'`,
      variantNames
    );
    assert.equal(mappings.length, 5);
    assert.ok(mappings.every((row: { object_name: string; status: string }) => (
      row.object_name === "福袋专属" && row.status === "enabled"
    )));
    assert.ok(mappings.some((row: { variant_name: string; external_key: string }) => (
      row.variant_name === "飞行员" && row.external_key === "593651152747287737"
    )));
    assert.ok(mappings.some((row: { variant_name: string; external_key: string }) => (
      row.variant_name === "情人节" && row.external_key === "681855448701274650"
    )));

    const category = await db.get(`SELECT id FROM categories WHERE name = '泡泡玛特'`);
    await db.run(
      "INSERT OR IGNORE INTO objects (category_id, name) VALUES (?, ?)",
      [category.id, "飞行员"]
    );
    const oldObject = await db.get(
      "SELECT id FROM objects WHERE category_id = ? AND name = ?",
      [category.id, "飞行员"]
    );
    await db.run(
      `INSERT INTO price_records (date, category, object_name, variant, price, source, note)
       VALUES ('2026-09-25', '泡泡玛特', '飞行员', '', 199, 'test', 'lucky-bag fixture')`
    );
    await db.run("UPDATE objects SET is_archived = 0, archived_at = NULL WHERE id = ?", [oldObject.id]);
    await db.run("DELETE FROM migrations WHERE id = ?", ["20260926_005_regroup_lucky_bag_exclusive"]);
    await runMigrations(filename);

    const movedPrice = await db.get(
      `SELECT object_name, variant, price FROM price_records
       WHERE category = '泡泡玛特' AND date = '2026-09-25' AND source = 'test'`
    );
    assert.equal(movedPrice.object_name, "福袋专属");
    assert.equal(movedPrice.variant, "飞行员");
    assert.equal(Number(movedPrice.price), 199);

    const archived = await db.get(`SELECT is_archived FROM objects WHERE id = ?`, [oldObject.id]);
    assert.equal(Number(archived.is_archived), 1);

    await db.run("DELETE FROM migrations WHERE id = ?", ["20260926_005_regroup_lucky_bag_exclusive"]);
    await runMigrations(filename);
    const variantCount = await db.get(
      `SELECT COUNT(*) AS total FROM variants WHERE object_id = ? AND COALESCE(is_archived, 0) = 0`,
      [series.id]
    );
    assert.equal(Number(variantCount.total), 5);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
