import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

const merchSpuIds = [
  "1037745426066871037",
  "1037745025561184515",
  "1037743738144702351"
];

test("adds 寻找LABUBU系列 under MOKOKO系列 and enables the 搪胶毛绒吊卡 scrape", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mokoko-find-labubu-"));
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
      `SELECT id FROM migrations WHERE id = '20260927_001_add_mokoko_find_labubu'`
    );
    assert.ok(applied);

    const series = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特' AND o.name = 'MOKOKO系列' AND COALESCE(o.is_archived, 0) = 0`
    );
    assert.ok(series);

    const variant = await db.get(
      `SELECT id, name FROM variants
       WHERE object_id = ? AND name = '寻找LABUBU系列' AND COALESCE(is_archived, 0) = 0`,
      [series.id]
    );
    assert.ok(variant);

    const mapping = await db.get(
      `SELECT object_name, variant_name, external_key, external_name, status, note, external_meta_json
       FROM source_mappings
       WHERE source_key = 'qiandao_popmart'
         AND variant_name = '寻找LABUBU系列'`
    );
    assert.ok(mapping);
    assert.equal(mapping.object_name, "MOKOKO系列");
    assert.equal(mapping.external_key, "1037744361988697639");
    assert.equal(mapping.external_name, "寻找LABUBU系列MOKOKO搪胶毛绒吊卡");
    assert.equal(mapping.status, "enabled");
    assert.match(String(mapping.note), /不要误接陶瓷杯/);
    assert.match(String(mapping.external_meta_json), /1037744361988697639/);

    const merch = await db.get(
      `SELECT id FROM source_mappings
       WHERE source_key = 'qiandao_popmart'
         AND external_key IN (${merchSpuIds.map(() => "?").join(", ")})`,
      merchSpuIds
    );
    assert.equal(merch, undefined);

    const leftover = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特'
         AND o.name IN ('寻找LABUBU', '寻找LABUBU系列')
         AND COALESCE(o.is_archived, 0) = 0`
    );
    assert.equal(leftover, undefined);

    const category = await db.get(`SELECT id FROM categories WHERE name = '泡泡玛特'`);
    await db.run(
      "INSERT OR IGNORE INTO objects (category_id, name) VALUES (?, ?)",
      [category.id, "寻找LABUBU系列"]
    );
    const leftoverObject = await db.get(
      "SELECT id FROM objects WHERE category_id = ? AND name = ?",
      [category.id, "寻找LABUBU系列"]
    );
    await db.run(
      `INSERT INTO price_records (date, category, object_name, variant, price, source, note)
       VALUES ('2026-09-27', '泡泡玛特', '寻找LABUBU系列', '', 181, 'test', 'find-labubu fixture')`
    );
    await db.run("UPDATE objects SET is_archived = 0, archived_at = NULL WHERE id = ?", [leftoverObject.id]);
    await db.run("DELETE FROM migrations WHERE id = ?", ["20260927_001_add_mokoko_find_labubu"]);
    await runMigrations(filename);

    const movedPrice = await db.get(
      `SELECT object_name, variant, price FROM price_records
       WHERE category = '泡泡玛特' AND date = '2026-09-27' AND source = 'test'`
    );
    assert.equal(movedPrice.object_name, "MOKOKO系列");
    assert.equal(movedPrice.variant, "寻找LABUBU系列");
    assert.equal(Number(movedPrice.price), 181);

    const archived = await db.get(
      `SELECT is_archived FROM objects WHERE id = ?`,
      [leftoverObject.id]
    );
    assert.equal(Number(archived.is_archived), 1);

    await db.run("DELETE FROM migrations WHERE id = ?", ["20260927_001_add_mokoko_find_labubu"]);
    await runMigrations(filename);
    const variantCount = await db.get(
      `SELECT COUNT(*) AS total FROM variants
       WHERE object_id = ? AND name = '寻找LABUBU系列' AND COALESCE(is_archived, 0) = 0`,
      [series.id]
    );
    assert.equal(Number(variantCount.total), 1);
    const mappingCount = await db.get(
      `SELECT COUNT(*) AS total FROM source_mappings
       WHERE source_key = 'qiandao_popmart' AND external_key = '1037744361988697639'`
    );
    assert.equal(Number(mappingCount.total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
