import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
import {
  isPlanArchivableStatus,
  parseIncludeArchivedPlans,
  planArchivedFilter,
  setPlanArchived
} from "../src/utils/planArchive";

const setupDatabase = async (filename: string) => {
  const db = await open({ filename, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE buying_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE selling_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
};

const withTempDatabase = async (callback: (db: Database) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-plan-archive-"));
  const filename = path.join(directory, "plan-archive-test.db");
  const db = await setupDatabase(filename);
  try {
    await callback(db);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const insertPlan = async (db: Database, tableName: "buying_plans" | "selling_plans", name: string, status: string) => {
  const result = await db.run(
    `INSERT INTO ${tableName} (plan_name, status) VALUES (?, ?)`,
    [name, status]
  );
  return Number(result.lastID);
};

const readPlan = (db: Database, tableName: "buying_plans" | "selling_plans", id: number) => (
  db.get<{ status: string; is_archived: number; archived_at: string | null }>(
    `SELECT status, is_archived, archived_at FROM ${tableName} WHERE id = ?`,
    [id]
  )
);

test("only completed plans are archivable", () => {
  for (const value of ["completed", "done", "已完成", " COMPLETED "]) {
    assert.equal(isPlanArchivableStatus(value), true, `${value} should be archivable`);
  }
  for (const value of ["pending", "in_progress", "cancelled", "已取消", "", null, undefined]) {
    assert.equal(isPlanArchivableStatus(value), false, `${String(value)} should not be archivable`);
  }
});

test("include_archived_plans only accepts explicit truthy flags", () => {
  for (const value of ["1", "true", "TRUE", " True "]) {
    assert.equal(parseIncludeArchivedPlans(value), true, `${value} should include archived plans`);
  }
  for (const value of ["0", "false", "", "yes", undefined, null]) {
    assert.equal(parseIncludeArchivedPlans(value), false, `${String(value)} should hide archived plans`);
  }
});

test("archiving a pending plan is rejected and leaves the row untouched", async () => {
  await withTempDatabase(async db => {
    const id = await insertPlan(db, "buying_plans", "未完成的买入计划", "pending");

    const result = await setPlanArchived(db, {
      tableName: "buying_plans",
      label: "买入计划",
      id,
      archived: true
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.message, /只有已完成的买入计划才能归档/);

    const row = await readPlan(db, "buying_plans", id);
    assert.equal(Number(row?.is_archived), 0);
    assert.equal(row?.archived_at, null);
  });
});

test("in-progress and cancelled plans are rejected too", async () => {
  await withTempDatabase(async db => {
    for (const status of ["in_progress", "cancelled"]) {
      const id = await insertPlan(db, "selling_plans", `计划-${status}`, status);
      const result = await setPlanArchived(db, {
        tableName: "selling_plans",
        label: "卖出计划",
        id,
        archived: true
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.message, /只有已完成的卖出计划才能归档/);
    }
  });
});

test("a completed plan can be archived, restored and archived again", async () => {
  await withTempDatabase(async db => {
    const id = await insertPlan(db, "buying_plans", "已完成的买入计划", "completed");

    const archived = await setPlanArchived(db, {
      tableName: "buying_plans",
      label: "买入计划",
      id,
      archived: true
    });
    assert.equal(archived.ok, true);
    if (archived.ok) {
      assert.equal(archived.archived, true);
      assert.equal(archived.changes, 1);
      assert.equal(archived.message, "买入计划已归档");
    }

    const archivedRow = await readPlan(db, "buying_plans", id);
    assert.equal(Number(archivedRow?.is_archived), 1);
    assert.ok(archivedRow?.archived_at);

    const restored = await setPlanArchived(db, {
      tableName: "buying_plans",
      label: "买入计划",
      id,
      archived: false
    });
    assert.equal(restored.ok, true);
    if (restored.ok) assert.equal(restored.message, "买入计划已恢复");

    const restoredRow = await readPlan(db, "buying_plans", id);
    assert.equal(Number(restoredRow?.is_archived), 0);
    assert.equal(restoredRow?.archived_at, null);
    assert.equal(restoredRow?.status, "completed");
  });
});

test("repeating archive or restore is a no-op instead of an error", async () => {
  await withTempDatabase(async db => {
    const id = await insertPlan(db, "selling_plans", "已完成卖出计划", "completed");

    await setPlanArchived(db, { tableName: "selling_plans", label: "卖出计划", id, archived: true });
    const repeatArchive = await setPlanArchived(db, {
      tableName: "selling_plans",
      label: "卖出计划",
      id,
      archived: true
    });
    assert.equal(repeatArchive.ok, true);
    if (repeatArchive.ok) assert.equal(repeatArchive.changes, 0);

    await setPlanArchived(db, { tableName: "selling_plans", label: "卖出计划", id, archived: false });
    const repeatRestore = await setPlanArchived(db, {
      tableName: "selling_plans",
      label: "卖出计划",
      id,
      archived: false
    });
    assert.equal(repeatRestore.ok, true);
    if (repeatRestore.ok) assert.equal(repeatRestore.changes, 0);
  });
});

test("archiving a missing plan reports 404", async () => {
  await withTempDatabase(async db => {
    const result = await setPlanArchived(db, {
      tableName: "buying_plans",
      label: "买入计划",
      id: 999999,
      archived: true
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 404);
      assert.equal(result.message, "买入计划不存在");
    }
  });
});

test("default list scope hides archived plans and keeps active ones", async () => {
  await withTempDatabase(async db => {
    const activeId = await insertPlan(db, "buying_plans", "执行中的计划", "in_progress");
    const pendingId = await insertPlan(db, "buying_plans", "待执行计划", "pending");
    const doneId = await insertPlan(db, "buying_plans", "已完成的计划", "completed");

    await setPlanArchived(db, {
      tableName: "buying_plans",
      label: "买入计划",
      id: doneId,
      archived: true
    });

    const visible = await db.all<{ id: number }[]>(
      `SELECT p.id FROM buying_plans p WHERE ${planArchivedFilter("p")}`
    );
    const visibleIds = visible.map(row => Number(row.id)).sort((a, b) => a - b);
    assert.deepEqual(visibleIds, [activeId, pendingId].sort((a, b) => a - b));
    assert.equal(visibleIds.includes(doneId), false);

    const all = await db.all<{ id: number }[]>("SELECT id FROM buying_plans");
    assert.equal(all.length, 3);

    const includingArchived = await db.all<{ id: number }[]>(
      `SELECT p.id FROM buying_plans p WHERE 1 = 1 OR ${planArchivedFilter("p")}`
    );
    assert.equal(includingArchived.length, 3);
  });
});
