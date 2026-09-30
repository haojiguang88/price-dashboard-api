import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("freezes OPPO and VIVO unactivated-phone pass-on ban without inventing SKUs or prices", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oppo-vivo-ota-"));
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
      `SELECT id FROM migrations WHERE id = '20260930_001_seed_oppo_vivo_ota_activation_ban'`
    );
    assert.ok(applied);

    for (const categoryName of ["OPPO", "VIVO"]) {
      const profile = await db.get(
        `SELECT business_style, operation_scene, risk_points, operating_discipline, extra_json, note
         FROM category_profiles
         WHERE category_name = ?
           AND COALESCE(object_name, '') = ''
           AND COALESCE(variant_name, '') = ''
           AND COALESCE(is_deleted, 0) = 0`,
        [categoryName]
      );
      assert.ok(profile, `missing category profile for ${categoryName}`);
      assert.equal(profile.business_style, "channel_spread");
      assert.equal(profile.operation_scene, "observe_only");
      assert.match(String(profile.risk_points), /空中激活/);
      assert.match(String(profile.risk_points), /退钱/);
      assert.match(String(profile.operating_discipline), /暂时不能撸/);
      assert.match(String(profile.operating_discipline), /政策还不清楚/);
      assert.match(String(profile.note), /认知冻结日：2026-09-30/);
      assert.doesNotMatch(String(profile.risk_points), /Find X|X200|A5 Pro/);
      const extra = JSON.parse(String(profile.extra_json));
      assert.equal(extra.can_flip, false);
      assert.equal(extra.specific_skus, "not_named");
    }

    const original = await db.get(
      `SELECT id FROM original_price_records
       WHERE category_name IN ('OPPO', 'VIVO') AND COALESCE(is_deleted, 0) = 0`
    );
    assert.equal(original, undefined);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260930_001_seed_oppo_vivo_ota_activation_ban"]
    );
    await runMigrations(filename);
    const profileCount = await db.get(
      `SELECT COUNT(*) AS total FROM category_profiles
       WHERE category_name IN ('OPPO', 'VIVO')
         AND COALESCE(object_name, '') = ''
         AND COALESCE(variant_name, '') = ''
         AND COALESCE(is_deleted, 0) = 0`
    );
    assert.equal(Number(profileCount.total), 2);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
