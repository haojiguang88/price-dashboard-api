import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("seeds Crybaby Gulu/Lianxia and Disney collab catalog with frozen portraits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crybaby-disney-"));
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
      `SELECT id FROM migrations WHERE id = '20260926_001_seed_crybaby_gulu_disney_collab'`
    );
    assert.ok(applied);
    const renamed = await db.get(
      `SELECT id FROM migrations WHERE id = '20260926_002_rename_crybaby_and_seed_qiandao_spus'`
    );
    assert.ok(renamed);

    const tears = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特' AND o.name = '哭娃'`
    );
    assert.ok(tears);
    const renamedAway = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特' AND o.name = '眼泪工厂' AND COALESCE(o.is_archived, 0) = 0`
    );
    assert.equal(renamedAway, undefined);
    const disney = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特' AND o.name = '迪士尼联名'`
    );
    assert.ok(disney);

    const variants = await db.all(
      `SELECT name FROM variants WHERE object_id IN (?, ?)`,
      [tears.id, disney.id]
    );
    assert.deepEqual(
      new Set(variants.map((row: { name: string }) => row.name)),
      new Set(["咕噜咕噜", "恋夏一族", "哭哭兔", "奇奇和蒂蒂", "唐老鸭的歌唱"])
    );

    const gulu = await db.get(
      `SELECT supply_mode, sales_mode, extra_json, note
       FROM category_profiles
       WHERE category_name = '泡泡玛特'
         AND object_name = '哭娃'
         AND variant_name = '咕噜咕噜'
         AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(gulu);
    assert.match(String(gulu.supply_mode), /还没补死/);
    assert.match(String(gulu.sales_mode), /134/);
    assert.match(String(gulu.note), /认知冻结日：2026-09-26/);
    assert.equal(JSON.parse(gulu.extra_json).retail_price, 129);

    const disneySeries = await db.get(
      `SELECT price_pattern, experience_notes
       FROM category_profiles
       WHERE category_name = '泡泡玛特'
         AND object_name = '迪士尼联名'
         AND COALESCE(variant_name, '') = ''
         AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(disneySeries);
    assert.match(String(disneySeries.price_pattern), /950/);
    assert.match(String(disneySeries.experience_notes), /承接比哭娃二代弱|承接略弱/);

    const original = await db.get(
      `SELECT original_price FROM original_price_records
       WHERE object_name = '哭娃' AND variant_name = '咕噜咕噜' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.equal(Number(original?.original_price), 129);

    const archive = await db.get(
      `SELECT one_sentence_judgment, pending_questions FROM product_archives
       WHERE archive_name = '哭娃 / 咕噜咕噜' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(archive);
    assert.match(String(archive.one_sentence_judgment), /还没补死/);
    assert.match(String(archive.pending_questions), /持续跟踪补货/);

    const mappings = await db.all(
      `SELECT variant_name, external_key, status, object_name
       FROM source_mappings
       WHERE source_key = 'qiandao_popmart'
         AND variant_name IN ('咕噜咕噜', '恋夏一族', '奇奇和蒂蒂', '唐老鸭的歌唱', '哭哭兔')
         AND COALESCE(status, '') != 'disabled'`
    );
    assert.equal(mappings.length, 5);
    assert.ok(mappings.every((row: { status: string }) => row.status === "enabled"));
    assert.ok(mappings.some((row: { variant_name: string; external_key: string }) => row.variant_name === "咕噜咕噜" && row.external_key === "923539750290195305"));
    assert.ok(mappings.some((row: { variant_name: string; object_name: string }) => row.variant_name === "哭哭兔" && row.object_name === "哭娃"));

    await db.run(
      "DELETE FROM migrations WHERE id IN (?, ?)",
      [
        "20260926_001_seed_crybaby_gulu_disney_collab",
        "20260926_002_rename_crybaby_and_seed_qiandao_spus"
      ]
    );
    await runMigrations(filename);
    const profileCount = await db.get(
      `SELECT COUNT(*) AS total FROM category_profiles
       WHERE category_name = '泡泡玛特'
         AND object_name IN ('哭娃', '迪士尼联名')
         AND COALESCE(is_deleted, 0) = 0
         AND COALESCE(variant_name, '') IN ('咕噜咕噜', '恋夏一族', '奇奇和蒂蒂', '唐老鸭的歌唱', '')`
    );
    assert.equal(Number(profileCount.total), 5);
    const mappingCount = await db.get(
      `SELECT COUNT(*) AS total FROM source_mappings
       WHERE source_key = 'qiandao_popmart'
         AND external_key IN (
           '923539750290195305',
           '923539678349500863',
           '839239377744850095',
           '839239297214219448',
           '791072292330313271'
         )`
    );
    assert.equal(Number(mappingCount.total), 5);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
