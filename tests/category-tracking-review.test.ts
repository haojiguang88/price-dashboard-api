import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";
import {
  archiveCategoryRecord,
  classifyCategoryLiquidity
} from "../src/routes/masterDataRoutes";

test("category tracking review keeps core categories active and unused electronics as observe", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "category-tracking-"));
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
      `SELECT id FROM migrations WHERE id = '20260924_002_category_tracking_mode'`
    );
    assert.ok(applied);

    const apple = await db.get(
      `SELECT COALESCE(tracking_mode, 'active') AS tracking_mode
       FROM categories WHERE name = '苹果手机'`
    );
    assert.equal(apple?.tracking_mode, "active");

    await db.run(
      `UPDATE categories SET tracking_mode = 'observe', updated_at = CURRENT_TIMESTAMP
       WHERE name = '华为'`
    );
    const huawei = await db.get(
      `SELECT COALESCE(tracking_mode, 'active') AS tracking_mode, COALESCE(is_archived, 0) AS is_archived
       FROM categories WHERE name = '华为'`
    );
    assert.equal(huawei?.tracking_mode, "observe");
    assert.equal(Number(huawei?.is_archived), 0);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("illiquid categories without inventory become archive candidates", () => {
  const today = "2026-09-24";
  const none = classifyCategoryLiquidity({
    name: "佳能",
    last_price_date: null,
    is_archived: 0
  }, today);
  assert.equal(none.liquidity, "none");
  assert.equal(none.archive_candidate, true);

  const stale = classifyCategoryLiquidity({
    name: "华为",
    last_price_date: "2026-08-04",
    is_archived: 0
  }, today);
  assert.equal(stale.liquidity, "stale");
  assert.equal(stale.last_price_age_days, 51);
  assert.equal(stale.archive_candidate, true);

  const barelyFresh = classifyCategoryLiquidity({
    name: "华为",
    last_price_date: "2026-08-25",
    is_archived: 0
  }, today);
  assert.equal(barelyFresh.liquidity, "ok");
  assert.equal(barelyFresh.last_price_age_days, 30);
  assert.equal(barelyFresh.archive_candidate, false);

  const core = classifyCategoryLiquidity({
    name: "苹果手机",
    last_price_date: null,
    is_archived: 0
  }, today);
  assert.equal(core.archive_candidate, false);

  const inUse = classifyCategoryLiquidity({
    name: "索尼",
    last_price_date: null,
    open_position_count: 1
  }, today);
  assert.equal(inUse.archive_candidate, false);
});

test("archive helper archives unused category objects and variants", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "category-archive-"));
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
    const category = await db.get("SELECT id FROM categories WHERE name = '影石'");
    assert.ok(category?.id);
    await db.run("INSERT INTO objects (category_id, name) VALUES (?, ?)", [category.id, "Ace Pro"]);
    const object = await db.get("SELECT id FROM objects WHERE category_id = ?", [category.id]);
    await db.run("INSERT INTO variants (object_id, name) VALUES (?, ?)", [object.id, "标准版"]);
    await db.run(
      `UPDATE cshrich_catalog_categories
       SET tracked = 1, skip_reason = ''
       WHERE system_category_name = '影石' AND source_key = 'cshrich_electronics'`
    );

    const result = await archiveCategoryRecord(db, category.id);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.skipped, false);
      assert.equal(result.name, "影石");
    }

    const categoryRow = await db.get(
      "SELECT COALESCE(is_archived, 0) AS is_archived FROM categories WHERE id = ?",
      [category.id]
    );
    const objectRow = await db.get(
      "SELECT COALESCE(is_archived, 0) AS is_archived FROM objects WHERE category_id = ?",
      [category.id]
    );
    const variantRow = await db.get(
      "SELECT COALESCE(is_archived, 0) AS is_archived FROM variants WHERE object_id = ?",
      [object.id]
    );
    const catalog = await db.get(
      `SELECT tracked, skip_reason FROM cshrich_catalog_categories
       WHERE system_category_name = '影石' AND source_key = 'cshrich_electronics'`
    );
    assert.equal(Number(categoryRow.is_archived), 1);
    assert.equal(Number(objectRow.is_archived), 1);
    assert.equal(Number(variantRow.is_archived), 1);
    assert.equal(Number(catalog.tracked), 0);
    assert.equal(catalog.skip_reason, "品类已归档，停止日常采集");
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
