import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
import {
  countOpenPositionsForMaster,
  formatOpenPositionArchiveBlockMessage
} from "../src/utils/masterData";

const setupDatabase = async (filename: string) => {
  const db = await open({ filename, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE objects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_name TEXT NOT NULL,
      object_name TEXT NOT NULL,
      variant_name TEXT,
      total_quantity REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      avg_price REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE position_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      remaining_quantity REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE buying_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_name TEXT NOT NULL,
      category_name TEXT NOT NULL,
      object_name TEXT NOT NULL,
      variant_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      total_amount REAL NOT NULL DEFAULT 0
    );
  `);

  await db.run("INSERT INTO categories (name) VALUES (?)", ["纪念币"]);
  const category = await db.get<{ id: number }>("SELECT id FROM categories WHERE name = ?", ["纪念币"]);
  await db.run("INSERT INTO objects (category_id, name) VALUES (?, ?)", [category!.id, "龙银币"]);
  const object = await db.get<{ id: number }>("SELECT id FROM objects WHERE name = ?", ["龙银币"]);
  await db.run("INSERT INTO variants (object_id, name) VALUES (?, ?)", [object!.id, "封装"]);
  return db;
};

const withTempDatabase = async (callback: (db: Database) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-archive-"));
  const filename = path.join(directory, "archive-test.db");
  const db = await setupDatabase(filename);
  try {
    await callback(db);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("open-position counter blocks archive targets that still hold inventory", async () => {
  await withTempDatabase(async db => {
    const position = await db.run(
      `INSERT INTO positions (category_name, object_name, variant_name, total_quantity, total_cost, avg_price)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["纪念币", "龙银币", "封装", 2, 2000, 1000]
    );
    await db.run(
      "INSERT INTO position_batches (position_id, remaining_quantity) VALUES (?, ?)",
      [position.lastID, 2]
    );

    const objectCount = await countOpenPositionsForMaster(db, {
      level: "object",
      categoryName: "纪念币",
      objectName: "龙银币"
    });
    assert.equal(objectCount, 1);

    const variantCount = await countOpenPositionsForMaster(db, {
      level: "variant",
      categoryName: "纪念币",
      objectName: "龙银币",
      variantName: "封装"
    });
    assert.equal(variantCount, 1);

    const categoryCount = await countOpenPositionsForMaster(db, {
      level: "category",
      categoryName: "纪念币"
    });
    assert.equal(categoryCount, 1);

    assert.match(formatOpenPositionArchiveBlockMessage(1), /未平仓位/);
  });
});

test("fully closed batches do not block archive", async () => {
  await withTempDatabase(async db => {
    const position = await db.run(
      `INSERT INTO positions (category_name, object_name, variant_name, total_quantity, total_cost, avg_price)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["纪念币", "龙银币", "封装", 0, 0, 0]
    );
    await db.run(
      "INSERT INTO position_batches (position_id, remaining_quantity) VALUES (?, ?)",
      [position.lastID, 0]
    );

    const count = await countOpenPositionsForMaster(db, {
      level: "object",
      categoryName: "纪念币",
      objectName: "龙银币"
    });
    assert.equal(count, 0);
  });
});

test("positions remain visible with master_archived when object is archived", async () => {
  await withTempDatabase(async db => {
    const position = await db.run(
      `INSERT INTO positions (category_name, object_name, variant_name, total_quantity, total_cost, avg_price)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["纪念币", "龙银币", "封装", 1, 1000, 1000]
    );
    await db.run(
      "INSERT INTO position_batches (position_id, remaining_quantity) VALUES (?, ?)",
      [position.lastID, 1]
    );
    await db.run("UPDATE objects SET is_archived = 1");

    const rows = await db.all(`
      SELECT
        p.id,
        CASE
          WHEN c.id IS NULL OR o.id IS NULL THEN 1
          WHEN COALESCE(c.is_archived, 0) = 1 OR COALESCE(o.is_archived, 0) = 1 THEN 1
          WHEN COALESCE(p.variant_name, '') <> ''
            AND (v.id IS NULL OR COALESCE(v.is_archived, 0) = 1) THEN 1
          ELSE 0
        END AS master_archived
      FROM positions p
      JOIN position_batches pb ON p.id = pb.position_id
      LEFT JOIN categories c ON c.name = p.category_name
      LEFT JOIN objects o ON o.category_id = c.id AND o.name = p.object_name
      LEFT JOIN variants v ON v.object_id = o.id
        AND v.name = COALESCE(p.variant_name, '')
        AND COALESCE(p.variant_name, '') <> ''
      GROUP BY p.id
      HAVING SUM(pb.remaining_quantity) > 0
    `);

    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].master_archived), 1);
  });
});

test("active plan master filter hides plans whose object is archived", async () => {
  await withTempDatabase(async db => {
    await db.run(
      `INSERT INTO buying_plans (plan_name, category_name, object_name, variant_name, status, total_amount)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["买龙银", "纪念币", "龙银币", "封装", "pending", 1000]
    );
    await db.run("UPDATE objects SET is_archived = 1");

    const activeFilter = `
      EXISTS (
        SELECT 1
        FROM categories c
        JOIN objects o ON o.category_id = c.id
        WHERE c.name = p.category_name
          AND o.name = p.object_name
          AND COALESCE(c.is_archived, 0) = 0
          AND COALESCE(o.is_archived, 0) = 0
          AND (
            COALESCE(p.variant_name, '') = ''
            OR EXISTS (
              SELECT 1
              FROM variants v
              WHERE v.object_id = o.id
                AND v.name = p.variant_name
                AND COALESCE(v.is_archived, 0) = 0
            )
          )
      )
    `;

    const active = await db.all(
      `SELECT id FROM buying_plans p WHERE p.status IN ('pending', 'in_progress') AND ${activeFilter}`
    );
    const all = await db.all(`SELECT id FROM buying_plans p WHERE p.status IN ('pending', 'in_progress')`);
    assert.equal(all.length, 1);
    assert.equal(active.length, 0);
  });
});
