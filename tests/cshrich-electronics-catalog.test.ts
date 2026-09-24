import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import {
  CSHRICH_ELECTRONICS_SOURCE_KEY,
  CSHRICH_SEEDED_TOP_CATEGORIES
} from "../src/constants/electronicsCategories";
import { runMigrations } from "../src/migrations";
import { assessPriceMove } from "../src/services/priceAnomalyDetection";
import { getFreshnessThresholdHours, isRunnableToday } from "../src/utils/taskSchedule";

const CATALOG_FIXTURE = path.join(
  process.cwd(),
  "tests/fixtures/cshrich-electronics-catalog.json"
);
const PYTHON_BIN = [
  process.env.TASK_CENTER_PYTHON,
  path.join(process.cwd(), ".venv/bin/python"),
  "python3"
].find((value) => value && (value === "python3" || existsSync(value))) || "python3";
const SCRIPT_PATH = path.join(process.cwd(), "scripts/business/cshrich_electronics.py");

const sunday = new Date("2026-09-20T04:00:00.000Z");
const monday = new Date("2026-09-21T04:00:00.000Z");

const runScript = (dbPath: string, mode: string) => {
  const result = spawnSync(
    PYTHON_BIN,
    [SCRIPT_PATH, "--db", dbPath, "--mode", mode, "--catalog", CATALOG_FIXTURE],
    { encoding: "utf8" }
  );
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const lines = (result.stdout || "").trim().split("\n").filter(Boolean);
  let payload: any = null;
  try {
    payload = JSON.parse(lines[lines.length - 1] || "{}");
  } catch {
    payload = null;
  }
  if (result.status !== 0 || payload?.success === false) {
    throw new Error(payload?.message || output || `python exited ${result.status}`);
  }
  return payload;
};

const objectNames = async (db: any, categoryName: string) => {
  const rows = await db.all(
    `SELECT o.name
     FROM objects o
     JOIN categories c ON c.id = o.category_id
     WHERE c.name = ?
     ORDER BY o.name`,
    [categoryName]
  );
  return rows.map((row: { name: string }) => row.name);
};

test("weekly_sunday only runs on Sunday and uses an 8-day freshness window", () => {
  assert.equal(isRunnableToday("weekly_sunday", sunday), true);
  assert.equal(isRunnableToday("weekly_sunday", monday), false);
  assert.equal(isRunnableToday("every_day", monday), true);
  assert.equal(isRunnableToday("work_days", sunday), false);
  assert.equal(isRunnableToday("work_days", monday), true);
  assert.equal(getFreshnessThresholdHours("weekly_sunday"), 192);
  assert.equal(getFreshnessThresholdHours("work_days"), 84);
  assert.equal(getFreshnessThresholdHours("every_day"), 36);
});

test("new electronics categories use the high-unit-price move profile", () => {
  const assessment = assessPriceMove({
    categoryName: "华为",
    changePercent: -6.14,
    changeAmount: -540
  });
  assert.equal(assessment.shouldAlert, true);
  assert.equal(assessment.profile, "high_unit_price");
});

test("records current CSHRich top categories, skips Apple/Nintendo, and discovers new ones weekly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cshrich-electronics-"));
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

    const catalogRows = await db.all(
      `SELECT external_id, external_name, system_category_name, tracked
       FROM cshrich_catalog_categories
       WHERE source_key = ?
       ORDER BY CAST(external_id AS INTEGER)`,
      [CSHRICH_ELECTRONICS_SOURCE_KEY]
    );
    assert.equal(catalogRows.length, CSHRICH_SEEDED_TOP_CATEGORIES.length);
    const apple = catalogRows.find((row: { external_id: string }) => row.external_id === "1");
    assert.equal(apple?.system_category_name, "苹果手机");
    assert.equal(Number(apple?.tracked), 0);

    const trackedNames = catalogRows
      .filter((row: { tracked: number }) => Number(row.tracked) === 1)
      .map((row: { system_category_name: string }) => row.system_category_name);
    for (const name of trackedNames) {
      const category = await db.get(`SELECT id FROM categories WHERE name = ?`, [name]);
      assert.ok(category, `missing system category ${name}`);
    }

    const extraApple = await db.get(`SELECT id FROM categories WHERE name = '苹果'`);
    assert.equal(extraApple, undefined);

    const dailyTask = await db.get(
      `SELECT schedule_days, schedule_time, enabled, task_type
       FROM task_center_tasks
       WHERE task_key = 'cshrich_electronics_price_update'`
    );
    assert.equal(dailyTask?.task_type, "cshrich_electronics_price_update");
    assert.equal(dailyTask?.schedule_days, "every_day");
    assert.equal(dailyTask?.schedule_time, "18:20");
    assert.equal(Number(dailyTask?.enabled), 1);

    const weeklyTask = await db.get(
      `SELECT schedule_days, schedule_time, enabled, task_type
       FROM task_center_tasks
       WHERE task_key = 'cshrich_catalog_discover'`
    );
    assert.equal(weeklyTask?.task_type, "cshrich_catalog_discover");
    assert.equal(weeklyTask?.schedule_days, "weekly_sunday");
    assert.equal(weeklyTask?.schedule_time, "10:00");
    assert.equal(Number(weeklyTask?.enabled), 1);

    const syncPayload = runScript(filename, "sync");
    assert.equal(syncPayload.success, true);
    assert.ok(!syncPayload.new_categories?.includes("三星测试"));

    const afterSync = await db.all(
      `SELECT external_id FROM cshrich_catalog_categories WHERE external_id = '9999'`
    );
    assert.equal(afterSync.length, 0);
    assert.deepEqual(await objectNames(db, "华为"), ["Mate 70"]);
    assert.deepEqual(await objectNames(db, "潮玩"), ["某潮玩"]);
    assert.equal((await objectNames(db, "苹果手机")).includes("iPhone 测试机"), false);

    const nintendo = await db.get(
      `SELECT o.name
       FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '潮玩' AND o.name = 'Switch OLED'`
    );
    assert.equal(nintendo, undefined);

    const huaweiPrice = await db.get(
      `SELECT price, source
       FROM price_records
       WHERE category = '华为' AND object_name = 'Mate 70' AND COALESCE(variant, '') = '黑色'`
    );
    assert.equal(Number(huaweiPrice?.price), 4200);
    assert.equal(huaweiPrice?.source, "潮收汇电子产品报价");

    const discoverPayload = runScript(filename, "discover");
    assert.equal(discoverPayload.success, true);
    assert.deepEqual(discoverPayload.new_categories, ["三星测试"]);

    const discovered = await db.get(
      `SELECT tracked, system_category_name
       FROM cshrich_catalog_categories
       WHERE source_key = ? AND external_id = '9999'`,
      [CSHRICH_ELECTRONICS_SOURCE_KEY]
    );
    assert.equal(discovered?.system_category_name, "三星测试");
    assert.equal(Number(discovered?.tracked), 1);
    assert.deepEqual(await objectNames(db, "三星测试"), ["Galaxy 测试机"]);

    await db.run(
      `UPDATE objects SET is_archived = 1, archived_at = CURRENT_TIMESTAMP
       WHERE name = 'Mate 70'`
    );
    await db.run(
      `UPDATE categories SET is_archived = 1, archived_at = CURRENT_TIMESTAMP
       WHERE name = '华为'`
    );
    runScript(filename, "sync");
    const stillArchivedObject = await db.get(
      `SELECT COALESCE(is_archived, 0) AS is_archived FROM objects WHERE name = 'Mate 70'`
    );
    const stillArchivedCategory = await db.get(
      `SELECT COALESCE(is_archived, 0) AS is_archived FROM categories WHERE name = '华为'`
    );
    assert.equal(Number(stillArchivedObject?.is_archived), 1);
    assert.equal(Number(stillArchivedCategory?.is_archived), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
