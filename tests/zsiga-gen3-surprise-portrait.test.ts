import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("freezes Zsiga gen3 遇见的惊喜 as a watch portrait without invented prices", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zsiga-gen3-"));
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
      `SELECT id FROM migrations WHERE id = '20260926_006_seed_zsiga_gen3_surprise_portrait'`
    );
    assert.ok(applied);

    const profile = await db.get(
      `SELECT supply_mode, sales_mode, operating_discipline, extra_json, note
       FROM category_profiles
       WHERE category_name = '泡泡玛特'
         AND object_name = 'Zsiga'
         AND variant_name = '遇见的惊喜'
         AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(profile);
    assert.match(String(profile.supply_mode), /第三代/);
    assert.match(String(profile.supply_mode), /线下部分门店还在补/);
    assert.doesNotMatch(String(profile.supply_mode), /通货补已经/);
    assert.match(String(profile.operating_discipline), /只盯、不加仓|只盯/);
    assert.match(String(profile.note), /认知冻结日：2026-09-26/);
    assert.equal(JSON.parse(profile.extra_json).generation, 3);

    const archive = await db.get(
      `SELECT one_sentence_judgment, position_level, pending_questions, experience_note
       FROM product_archives
       WHERE archive_name = 'Zsiga / 遇见的惊喜' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(archive);
    assert.equal(archive.position_level, "watch");
    assert.match(String(archive.one_sentence_judgment), /只盯不买/);
    assert.match(String(archive.pending_questions), /原价/);
    assert.doesNotMatch(String(archive.experience_note), /买入许可/);

    const original = await db.get(
      `SELECT id FROM original_price_records
       WHERE object_name = 'Zsiga' AND variant_name = '遇见的惊喜' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.equal(original, undefined);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260926_006_seed_zsiga_gen3_surprise_portrait"]
    );
    await runMigrations(filename);
    const profileCount = await db.get(
      `SELECT COUNT(*) AS total FROM category_profiles
       WHERE category_name = '泡泡玛特'
         AND object_name = 'Zsiga'
         AND variant_name = '遇见的惊喜'
         AND COALESCE(is_deleted, 0) = 0`
    );
    assert.equal(Number(profileCount.total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
