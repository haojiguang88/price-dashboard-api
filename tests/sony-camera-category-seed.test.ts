import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("seeds Sony camera category with FE 600mm F6.3 GM, FX5, RX10 V, official anchors and daily quote todo", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sony-camera-"));
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
      `SELECT id FROM migrations WHERE id = '20260927_002_seed_sony_camera_category'`
    );
    assert.ok(applied);

    const category = await db.get(
      `SELECT id, tracking_mode, is_archived FROM categories WHERE name = '索尼相机'`
    );
    assert.ok(category);
    assert.equal(category.tracking_mode, "active");
    assert.equal(Number(category.is_archived), 0);

    const expected: Record<string, string[]> = {
      "索尼 FE 600mm F6.3 GM OSS": ["国行", "港版"],
      "索尼 FX5 单机": ["国行"],
      "索尼 RX10 V": ["国行", "港版"]
    };

    for (const [objectName, variantNames] of Object.entries(expected)) {
      const object = await db.get(
        `SELECT o.id, o.is_archived FROM objects o
         JOIN categories c ON c.id = o.category_id
         WHERE c.name = '索尼相机' AND o.name = ?`,
        [objectName]
      );
      assert.ok(object, `object missing: ${objectName}`);
      assert.equal(Number(object.is_archived), 0);

      const variants = await db.all(
        `SELECT name FROM variants WHERE object_id = ?`,
        [object.id]
      );
      assert.deepEqual(
        variants.map((row: { name: string }) => row.name).sort(),
        [...variantNames].sort(),
        `variants mismatch for ${objectName}`
      );
    }

    const anchors = await db.all(
      `SELECT object_name, variant_name, original_price, effective_date, source
       FROM original_price_records
       WHERE category_name = '索尼相机' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.equal(anchors.length, 3);
    const anchorByObject = new Map(
      anchors.map((row: { object_name: string }) => [row.object_name, row])
    );
    const fe600 = anchorByObject.get("索尼 FE 600mm F6.3 GM OSS");
    assert.ok(fe600);
    assert.equal(fe600.variant_name, "国行");
    assert.equal(Number(fe600.original_price), 24999);
    assert.equal(fe600.effective_date, "2026-09-15");
    assert.equal(fe600.source, "索尼中国官方建议零售价");

    const fx5 = anchorByObject.get("索尼 FX5 单机");
    assert.ok(fx5);
    assert.equal(fx5.variant_name, "国行");
    assert.equal(Number(fx5.original_price), 32000);
    assert.equal(fx5.effective_date, "2026-07-22");

    const rx10 = anchorByObject.get("索尼 RX10 V");
    assert.ok(rx10);
    assert.equal(rx10.variant_name, "国行");
    assert.equal(Number(rx10.original_price), 15199);
    assert.equal(rx10.effective_date, "2026-07-09");

    const todo = await db.get(
      `SELECT title, priority, status, note, domain, workspace
       FROM manual_todos
       WHERE title = '建立索尼相机档口日报价渠道'`
    );
    assert.ok(todo);
    assert.equal(todo.priority, "high");
    assert.equal(todo.status, "pending");
    assert.equal(todo.domain, "business");
    assert.equal(todo.workspace, "business");
    assert.match(String(todo.note), /FE 600 F6\.3/);
    assert.match(String(todo.note), /POST \/api\/price-records（type=manual）/);
    assert.match(String(todo.note), /索尼相机/);

    // Idempotency: removing the migration row and re-running must not duplicate rows.
    await db.run("DELETE FROM migrations WHERE id = '20260927_002_seed_sony_camera_category'");
    await runMigrations(filename);
    const anchorCount = await db.get(
      `SELECT COUNT(*) AS total FROM original_price_records
       WHERE category_name = '索尼相机' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.equal(Number(anchorCount.total), 3);
    const todoCount = await db.get(
      `SELECT COUNT(*) AS total FROM manual_todos
       WHERE title = '建立索尼相机档口日报价渠道'`
    );
    assert.equal(Number(todoCount.total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
