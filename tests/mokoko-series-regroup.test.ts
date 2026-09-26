import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

const variantNames = [
  "大春花",
  "大甜心",
  "小甜心",
  "毛球",
  "白裙子",
  "闪闪",
  "醒醒",
  "晒晒",
  "万圣节"
];

test("regroups MOKOKO SKUs under MOKOKO系列 variants without merging 大小甜心", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mokoko-series-"));
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
      `SELECT id FROM migrations WHERE id = '20260926_003_regroup_mokoko_series'`
    );
    assert.ok(applied);

    const series = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特' AND o.name = 'MOKOKO系列' AND COALESCE(o.is_archived, 0) = 0`
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
    assert.equal(mappings.length, 9);
    assert.ok(mappings.every((row: { object_name: string; status: string }) => (
      row.object_name === "MOKOKO系列" && row.status === "enabled"
    )));
    assert.ok(mappings.some((row: { variant_name: string; external_key: string }) => (
      row.variant_name === "大甜心" && row.external_key === "675597453717760702"
    )));
    assert.ok(mappings.some((row: { variant_name: string; external_key: string }) => (
      row.variant_name === "小甜心" && row.external_key === "672953785382971923"
    )));
    assert.equal(
      mappings.filter((row: { variant_name: string }) => row.variant_name === "大小甜心").length,
      0
    );

    const category = await db.get(`SELECT id FROM categories WHERE name = '泡泡玛特'`);
    await db.run(
      "INSERT OR IGNORE INTO objects (category_id, name) VALUES (?, ?)",
      [category.id, "大春花"]
    );
    const oldObject = await db.get(
      "SELECT id FROM objects WHERE category_id = ? AND name = ?",
      [category.id, "大春花"]
    );
    await db.run(
      `INSERT INTO price_records (date, category, object_name, variant, price, source, note)
       VALUES ('2026-09-25', '泡泡玛特', '大春花', '', 499, 'test', 'regroup fixture')`
    );
    await db.run(
      `INSERT INTO market_book_snapshots
         (category, object_name, variant, date, source_key, display_price, price_kind, captured_at)
       VALUES ('泡泡玛特', '大春花', '', '2026-09-25', 'qiandao_popmart', 499, 'avg_deal', '2026-09-25T12:00:00')`
    );
    await db.run("UPDATE objects SET is_archived = 0, archived_at = NULL WHERE id = ?", [oldObject.id]);
    await db.run("DELETE FROM migrations WHERE id = ?", ["20260926_003_regroup_mokoko_series"]);
    await runMigrations(filename);

    const movedPrice = await db.get(
      `SELECT object_name, variant, price FROM price_records
       WHERE category = '泡泡玛特' AND date = '2026-09-25' AND source = 'test'`
    );
    assert.equal(movedPrice.object_name, "MOKOKO系列");
    assert.equal(movedPrice.variant, "大春花");
    assert.equal(Number(movedPrice.price), 499);

    const movedBook = await db.get(
      `SELECT object_name, variant FROM market_book_snapshots
       WHERE source_key = 'qiandao_popmart' AND date = '2026-09-25' AND display_price = 499`
    );
    assert.equal(movedBook.object_name, "MOKOKO系列");
    assert.equal(movedBook.variant, "大春花");

    const archived = await db.get(
      `SELECT is_archived FROM objects WHERE id = ?`,
      [oldObject.id]
    );
    assert.equal(Number(archived.is_archived), 1);

    const leftoverPrice = await db.get(
      `SELECT id FROM price_records
       WHERE category = '泡泡玛特' AND object_name = '大春花'`
    );
    assert.equal(leftoverPrice, undefined);

    await db.run("DELETE FROM migrations WHERE id = ?", ["20260926_003_regroup_mokoko_series"]);
    await runMigrations(filename);
    const variantCount = await db.get(
      `SELECT COUNT(*) AS total FROM variants WHERE object_id = ? AND COALESCE(is_archived, 0) = 0`,
      [series.id]
    );
    assert.equal(Number(variantCount.total), 9);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
