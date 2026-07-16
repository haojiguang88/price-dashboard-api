import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
import {
  buildPriceImportPreview,
  executePriceImportBatch,
  PriceImportBatchConflictError
} from "../src/services/priceImportService";

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
    CREATE TABLE price_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      object_name TEXT NOT NULL,
      variant TEXT,
      price REAL NOT NULL,
      source TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE price_import_batches (
      batch_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('processing', 'completed')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  await db.run("INSERT INTO categories (name) VALUES (?)", ["纪念钞"]);
  const category = await db.get<{ id: number }>("SELECT id FROM categories WHERE name = ?", ["纪念钞"]);
  await db.run("INSERT INTO objects (category_id, name) VALUES (?, ?)", [category!.id, "龙钞散张"]);
  return db;
};

const withTempDatabase = async (callback: (db: Database) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-import-"));
  const filename = path.join(directory, "import-test.db");
  const db = await setupDatabase(filename);
  try {
    await callback(db);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const record = (date: string, price: number, source = "闲鱼", note = "") => ({
  date,
  category_name: "纪念钞",
  object_name: "龙钞散张",
  variant_name: "",
  price,
  source,
  note
});

test("price import preview separates create, update, skip, conflict and real-date errors", async () => {
  await withTempDatabase(async db => {
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO price_records
       (date, category, object_name, variant, price, source, note, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`,
      ["2026-07-01", "纪念钞", "龙钞散张", 60, "闲鱼", "不变", now, now]
    );
    await db.run(
      `INSERT INTO price_records
       (date, category, object_name, variant, price, source, note, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`,
      ["2026-07-02", "纪念钞", "龙钞散张", 61, "闲鱼", "旧备注", now, now]
    );

    const preview = await buildPriceImportPreview(db, [
      record("2026-07-01", 60, "闲鱼", "不变"),
      record("2026-07-02", 62, "闲鱼", "新备注"),
      record("2026-07-03", 63),
      record("2026-07-03", 63),
      record("2026-07-04", 64),
      record("2026-07-04", 65),
      record("2026-99-99", 66)
    ]);

    assert.deepEqual(
      {
        total: preview.total_count,
        create: preview.new_count,
        update: preview.update_count,
        skip: preview.skipped_count,
        conflict: preview.conflict_count,
        error: preview.error_count
      },
      { total: 7, create: 1, update: 1, skip: 2, conflict: 2, error: 1 }
    );
    assert.equal(preview.records.at(-1)?.reason, "INVALID_DATE");
  });
});

test("price import preview rejects invalid field types at the API boundary", async () => {
  await withTempDatabase(async db => {
    const preview = await buildPriceImportPreview(db, [
      { ...record("2026-07-05", 65), source: 123 },
      { ...record("2026-07-06", 66), note: ["invalid"] }
    ]);

    assert.equal(preview.error_count, 2);
    assert.ok(preview.records.every(item => item.reason === "INVALID_FIELD_TYPE"));
  });
});

test("price import preview blocks an ambiguous existing duplicate instead of updating an arbitrary row", async () => {
  await withTempDatabase(async db => {
    const now = new Date().toISOString();
    for (const price of [67, 68]) {
      await db.run(
        `INSERT INTO price_records
         (date, category, object_name, variant, price, source, note, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?, '', ?, ?)`,
        ["2026-07-07", "纪念钞", "龙钞散张", price, "闲鱼", now, now]
      );
    }

    const preview = await buildPriceImportPreview(db, [record("2026-07-07", 69)]);

    assert.equal(preview.conflict_count, 1);
    assert.equal(preview.records[0]?.reason, "EXISTING_RECORD_CONFLICT");
    assert.equal(preview.records[0]?.existing_record_id, null);
  });
});

test("replaying the same import batch writes once and returns the original result", async () => {
  await withTempDatabase(async db => {
    const records = [record("2026-07-10", 70)];

    await db.exec("BEGIN IMMEDIATE TRANSACTION");
    const first = await executePriceImportBatch(db, "batch-one", records);
    await db.exec("COMMIT");
    assert.equal(first.idempotentReplay, false);
    assert.equal(first.result.created_count, 1);

    await db.exec("BEGIN IMMEDIATE TRANSACTION");
    const replay = await executePriceImportBatch(db, "batch-one", records);
    await db.exec("COMMIT");
    assert.equal(replay.idempotentReplay, true);
    assert.deepEqual(replay.result, first.result);

    const count = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM price_records");
    assert.equal(count?.count, 1);

    await db.exec("BEGIN IMMEDIATE TRANSACTION");
    await assert.rejects(
      () => executePriceImportBatch(db, "batch-one", [record("2026-07-10", 71)]),
      PriceImportBatchConflictError
    );
    await db.exec("ROLLBACK");
  });
});
