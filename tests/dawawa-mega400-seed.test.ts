import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

const mega1000SpuIds = [
  "713221212611870338",
  "889792775980073242"
];

test("seeds Pop Mart object 大娃 with two MEGA 400% variants and Qiandao scrape mappings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawawa-mega400-"));
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
      `SELECT id FROM migrations WHERE id = '20261001_001_seed_dawawa_mega400_variants'`
    );
    assert.ok(applied);

    const object = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特' AND o.name = '大娃' AND COALESCE(o.is_archived, 0) = 0`
    );
    assert.ok(object);

    const variants = await db.all(
      `SELECT name FROM variants WHERE object_id = ? AND COALESCE(is_archived, 0) = 0 ORDER BY name`,
      [object.id]
    );
    assert.deepEqual(
      variants.map((row: { name: string }) => row.name),
      ["mega400%梵高博物馆杏花", "mega400%漫漫花落-绒"]
    );

    const almond = await db.get(
      `SELECT object_name, variant_name, external_key, external_name, status, note
       FROM source_mappings
       WHERE source_key = 'qiandao_popmart' AND variant_name = 'mega400%梵高博物馆杏花'`
    );
    assert.ok(almond);
    assert.equal(almond.object_name, "大娃");
    assert.equal(almond.external_key, "713221358640770544");
    assert.equal(almond.external_name, "MEGA ROYAL MOLLY 400% 梵高博物馆·杏花");
    assert.equal(almond.status, "enabled");
    assert.match(String(almond.note), /不要误接 1000%/);

    const velvet = await db.get(
      `SELECT object_name, variant_name, external_key, external_name, status, note
       FROM source_mappings
       WHERE source_key = 'qiandao_popmart' AND variant_name = 'mega400%漫漫花落-绒'`
    );
    assert.ok(velvet);
    assert.equal(velvet.object_name, "大娃");
    assert.equal(velvet.external_key, "890886808303317137");
    assert.equal(velvet.external_name, "MEGA ROYAL MOLLY 400% 漫缦花落-绒");
    assert.equal(velvet.status, "enabled");
    assert.match(String(velvet.note), /不要误接 1000%/);

    const mega1000 = await db.get(
      `SELECT id FROM source_mappings
       WHERE source_key = 'qiandao_popmart'
         AND external_key IN (${mega1000SpuIds.map(() => "?").join(", ")})`,
      mega1000SpuIds
    );
    assert.equal(mega1000, undefined);

    const inventedPrice = await db.get(
      `SELECT id FROM original_price_records
       WHERE category_name = '泡泡玛特' AND object_name = '大娃' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.equal(inventedPrice, undefined);

    await db.run("DELETE FROM migrations WHERE id = ?", ["20261001_001_seed_dawawa_mega400_variants"]);
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM objects o
          JOIN categories c ON c.id = o.category_id
          WHERE c.name = '泡泡玛特' AND o.name = '大娃' AND COALESCE(o.is_archived, 0) = 0) AS object_total,
         (SELECT COUNT(*) FROM variants WHERE object_id = ? AND COALESCE(is_archived, 0) = 0) AS variant_total,
         (SELECT COUNT(*) FROM source_mappings
          WHERE source_key = 'qiandao_popmart' AND object_name = '大娃') AS mapping_total`,
      [object.id]
    );
    assert.equal(Number(duplicateCheck.object_total), 1);
    assert.equal(Number(duplicateCheck.variant_total), 2);
    assert.equal(Number(duplicateCheck.mapping_total), 2);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
