import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("seeds 泡泡玛特 福袋专属 星夜许愿树毛绒公仔挂件", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "popmart-starry-night-"));
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
      `SELECT id FROM migrations WHERE id = '20261012_001_seed_popmart_starry_night_wish_tree'`
    );
    assert.ok(applied);

    const object = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特' AND o.name = '福袋专属' AND COALESCE(o.is_archived, 0) = 0`
    );
    assert.ok(object);

    const variant = await db.get(
      `SELECT id FROM variants
       WHERE object_id = ? AND name = '星夜许愿树毛绒公仔挂件' AND COALESCE(is_archived, 0) = 0`,
      [object.id]
    );
    assert.ok(variant);

    const mapping = await db.get(
      `SELECT object_name, variant_name, external_name, status, note
       FROM source_mappings
       WHERE source_key = 'qiandao_popmart' AND external_key = '802529831630726794'`
    );
    assert.ok(mapping);
    assert.equal(mapping.object_name, "福袋专属");
    assert.equal(mapping.variant_name, "星夜许愿树毛绒公仔挂件");
    assert.equal(mapping.external_name, "星夜许愿树毛绒公仔挂件");
    assert.equal(mapping.status, "enabled");
    assert.match(String(mapping.note), /不要误接不眠剧场/);

    const price = await db.get(
      `SELECT price, source, note FROM price_records
       WHERE category = '泡泡玛特'
         AND object_name = '福袋专属'
         AND variant = '星夜许愿树毛绒公仔挂件'
         AND date = '2026-10-12'`
    );
    assert.ok(price);
    assert.equal(price.price, 2168);
    assert.equal(price.source, "用户口述");
    assert.match(String(price.note), /2168\.25/);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
