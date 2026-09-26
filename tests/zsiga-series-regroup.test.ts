import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("regroups Zsiga SKUs, renames 嘎子姐 to 向往之处, and enables 遇见的惊喜 scrape", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zsiga-series-"));
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
      `SELECT id FROM migrations WHERE id = '20260926_004_regroup_zsiga_series'`
    );
    assert.ok(applied);

    const series = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特' AND o.name = 'Zsiga' AND COALESCE(o.is_archived, 0) = 0`
    );
    assert.ok(series);

    const variants = await db.all(
      `SELECT name FROM variants WHERE object_id = ? AND COALESCE(is_archived, 0) = 0`,
      [series.id]
    );
    assert.deepEqual(
      new Set(variants.map((row: { name: string }) => row.name)),
      new Set(["向往之处", "姜饼人", "遇见的惊喜"])
    );

    const leftover = await db.all(
      `SELECT o.name FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特'
         AND o.name IN ('嘎子姐', '姜饼人', '向往之处', '遇见的惊喜')
         AND COALESCE(o.is_archived, 0) = 0`
    );
    assert.equal(leftover.length, 0);

    const mappings = await db.all(
      `SELECT object_name, variant_name, external_key, status, note
       FROM source_mappings
       WHERE source_key = 'qiandao_popmart'
         AND variant_name IN ('向往之处', '姜饼人', '遇见的惊喜')
         AND COALESCE(status, '') != 'disabled'`
    );
    assert.equal(mappings.length, 3);
    assert.ok(mappings.every((row: { object_name: string; status: string }) => (
      row.object_name === "Zsiga" && row.status === "enabled"
    )));
    assert.ok(mappings.some((row: { variant_name: string; external_key: string }) => (
      row.variant_name === "向往之处" && row.external_key === "875239228831738922"
    )));
    assert.ok(mappings.some((row: { variant_name: string; external_key: string }) => (
      row.variant_name === "遇见的惊喜" && row.external_key === "1046003922327624571"
    )));
    const surprise = mappings.find((row: { variant_name: string }) => row.variant_name === "遇见的惊喜");
    assert.match(String(surprise?.note), /不要误接人生秀场/);

    const merch = await db.get(
      `SELECT id FROM source_mappings
       WHERE source_key = 'qiandao_popmart'
         AND external_key IN (
           '1046015792543462737',
           '1046010537650989725',
           '1046018879551198440',
           '1046015196616724190'
         )`
    );
    assert.equal(merch, undefined);

    const archive = await db.get(
      `SELECT archive_name, object_name, variant_name
       FROM product_archives
       WHERE category_name = '泡泡玛特'
         AND object_name = 'Zsiga'
         AND COALESCE(variant_name, '') = '向往之处'
         AND COALESCE(is_deleted, 0) = 0`
    );
    if (archive) {
      assert.equal(archive.archive_name, "Zsiga / 向往之处");
    }

    const buyPlan = await db.get(
      `SELECT object_name, variant_name FROM buying_plans
       WHERE plan_name = '嘎子姐底仓分层占位'`
    );
    assert.ok(buyPlan);
    assert.equal(buyPlan.object_name, "Zsiga");
    assert.equal(buyPlan.variant_name, "向往之处");

    const annual = await db.get(
      `SELECT object_name FROM annual_plan_items
       WHERE category = '泡泡玛特' AND COALESCE(is_deleted, 0) = 0
         AND object_name IN ('嘎子姐', 'Zsiga')`
    );
    if (annual) {
      assert.equal(annual.object_name, "Zsiga");
    }

    await db.run("DELETE FROM migrations WHERE id = ?", ["20260926_004_regroup_zsiga_series"]);
    await runMigrations(filename);
    const variantCount = await db.get(
      `SELECT COUNT(*) AS total FROM variants WHERE object_id = ? AND COALESCE(is_archived, 0) = 0`,
      [series.id]
    );
    assert.equal(Number(variantCount.total), 3);
    const mappingCount = await db.get(
      `SELECT COUNT(*) AS total FROM source_mappings
       WHERE source_key = 'qiandao_popmart'
         AND external_key IN (
           '875239228831738922',
           '927988138113005044',
           '1046003922327624571'
         )`
    );
    assert.equal(Number(mappingCount.total), 3);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
