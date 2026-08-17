import assert from "node:assert/strict";
import test from "node:test";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
import {
  deletePositionBatch,
  PositionBatchDeleteError
} from "../src/routes/positionRoutes";

const createTestDb = async () => {
  const db = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_name TEXT NOT NULL,
      object_name TEXT NOT NULL,
      variant_name TEXT,
      total_quantity REAL NOT NULL,
      total_cost REAL NOT NULL,
      avg_price REAL NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE position_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      batch_date TEXT NOT NULL,
      batch_price REAL NOT NULL,
      batch_quantity REAL NOT NULL,
      batch_cost REAL NOT NULL,
      remaining_quantity REAL NOT NULL,
      note TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
    );
    CREATE TABLE sell_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT,
      position_id TEXT
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      entity_id TEXT,
      path TEXT,
      domain TEXT NOT NULL,
      workspace TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
};

const insertPosition = async (db: Database) => {
  const result = await db.run(
    `INSERT INTO positions
      (category_name, object_name, variant_name, total_quantity, total_cost, avg_price, updated_at)
     VALUES ('纪念币', '测试银币', '30克', 5, 700, 140, '2026-08-17T00:00:00.000Z')`
  );
  return Number(result.lastID);
};

const insertBatch = async (
  db: Database,
  positionId: number,
  price: number,
  quantity: number,
  date: string
) => {
  const result = await db.run(
    `INSERT INTO position_batches
      (position_id, batch_date, batch_price, batch_quantity, batch_cost, remaining_quantity, note)
     VALUES (?, ?, ?, ?, ?, ?, '')`,
    [positionId, date, price, quantity, price * quantity, quantity]
  );
  return Number(result.lastID);
};

test("deleting an unsold batch recalculates the parent position and appends an audit log", async () => {
  const db = await createTestDb();
  try {
    const positionId = await insertPosition(db);
    const deletedBatchId = await insertBatch(db, positionId, 100, 3, "2026-08-01");
    await insertBatch(db, positionId, 200, 2, "2026-08-02");

    const result = await deletePositionBatch(db, deletedBatchId);

    assert.equal(result.positionDeleted, false);
    assert.equal(await db.get("SELECT id FROM position_batches WHERE id = ?", [deletedBatchId]), undefined);
    const position = await db.get("SELECT total_quantity, total_cost, avg_price FROM positions WHERE id = ?", [positionId]);
    assert.deepEqual(position, { total_quantity: 2, total_cost: 400, avg_price: 200 });
    const audit = await db.get("SELECT module, action, entity_id FROM audit_logs");
    assert.deepEqual(audit, { module: "仓位管理", action: "删除仓位批次", entity_id: String(deletedBatchId) });
  } finally {
    await db.close();
  }
});

test("deleting the only unsold batch also removes the empty parent position", async () => {
  const db = await createTestDb();
  try {
    const positionId = await insertPosition(db);
    const batchId = await insertBatch(db, positionId, 140, 5, "2026-08-01");

    const result = await deletePositionBatch(db, batchId);

    assert.equal(result.positionDeleted, true);
    assert.equal(await db.get("SELECT id FROM positions WHERE id = ?", [positionId]), undefined);
  } finally {
    await db.close();
  }
});

test("a batch with sell history cannot be deleted", async () => {
  const db = await createTestDb();
  try {
    const positionId = await insertPosition(db);
    const batchId = await insertBatch(db, positionId, 140, 5, "2026-08-01");
    await db.run("INSERT INTO sell_records (batch_id, position_id) VALUES (?, ?)", [String(batchId), String(positionId)]);

    await assert.rejects(
      () => deletePositionBatch(db, batchId),
      (error: unknown) => error instanceof PositionBatchDeleteError && error.statusCode === 409
    );

    assert.ok(await db.get("SELECT id FROM position_batches WHERE id = ?", [batchId]));
    assert.ok(await db.get("SELECT id FROM positions WHERE id = ?", [positionId]));
    assert.equal((await db.get("SELECT COUNT(*) AS count FROM audit_logs")).count, 0);
  } finally {
    await db.close();
  }
});
