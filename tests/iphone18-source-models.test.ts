import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

const OBJECT_NAMES = [
  "iPhone 18 Pro 256G",
  "iPhone 18 Pro 512G",
  "iPhone 18 Pro 1TB",
  "iPhone 18 Pro 2TB",
  "iPhone 18 Pro Max 256G",
  "iPhone 18 Pro Max 512G",
  "iPhone 18 Pro Max 1TB",
  "iPhone 18 Pro Max 2TB"
];
const COLORS = ["黑色", "银色", "红色", "蓝色"];

test("seeds iPhone 18 Pro/Pro Max objects from the live CSHRich catalog without inventing missing models", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "iphone18-source-models-"));
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

    const category = await db.get(
      `SELECT id, name, COALESCE(is_archived, 0) AS is_archived
       FROM categories
       WHERE name = '苹果手机'`
    );
    assert.ok(category);
    assert.equal(category.is_archived, 0);

    const objects = await db.all(
      `SELECT o.name
       FROM objects o
       WHERE o.category_id = ?
         AND COALESCE(o.is_archived, 0) = 0
         AND o.name LIKE 'iPhone 18%'
       ORDER BY o.name`,
      [category.id]
    );
    assert.deepEqual(objects.map((row: { name: string }) => row.name), [...OBJECT_NAMES].sort());

    for (const objectName of OBJECT_NAMES) {
      const variants = await db.all(
        `SELECT v.name
         FROM variants v
         JOIN objects o ON o.id = v.object_id
         WHERE o.category_id = ?
           AND o.name = ?
           AND COALESCE(v.is_archived, 0) = 0
         ORDER BY v.name`,
        [category.id, objectName]
      );
      assert.deepEqual(variants.map((row: { name: string }) => row.name), [...COLORS].sort());
    }

    const invented = await db.all(
      `SELECT name FROM objects
       WHERE category_id = ?
         AND name IN ('iPhone 18 256G', 'iPhone 18 Plus 256G', 'iPhone 18 Air 256G')`,
      [category.id]
    );
    assert.equal(invented.length, 0);

    const applied = await db.get(
      `SELECT id FROM migrations WHERE id = '20260917_001_seed_iphone18_source_models'`
    );
    assert.ok(applied);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
