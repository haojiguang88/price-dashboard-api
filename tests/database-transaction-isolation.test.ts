import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager } from "../src/config/database";

test("request A rollback cannot roll back request B write", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-db-isolation-"));
  const filename = path.join(tempDirectory, "business-test.db");
  const manager = new DatabaseManager({
    filename,
    allowCreate: true,
    initialize: async db => {
      await db.exec(`
        CREATE TABLE isolation_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_name TEXT NOT NULL
        )
      `);
    }
  });

  let releaseRequestA!: () => void;
  const requestARollbackGate = new Promise<void>(resolve => {
    releaseRequestA = resolve;
  });
  let markRequestAReady!: () => void;
  const requestAReady = new Promise<void>(resolve => {
    markRequestAReady = resolve;
  });
  let markRequestBAttempted!: () => void;
  const requestBAttempted = new Promise<void>(resolve => {
    markRequestBAttempted = resolve;
  });
  let requestAConnection: unknown;
  let requestBConnection: unknown;
  let requestBSettled = false;

  try {
    await manager.getDb();

    const requestA = manager.runInRequestContext(async () => {
      const db = await manager.getDb();
      requestAConnection = db;
      await db.exec("BEGIN IMMEDIATE TRANSACTION");
      await db.run("INSERT INTO isolation_events (request_name) VALUES (?)", ["request-a"]);
      markRequestAReady();
      await requestARollbackGate;
      await db.exec("ROLLBACK");
    });

    await requestAReady;
    const requestB = manager.runInRequestContext(async () => {
      const db = await manager.getDb();
      requestBConnection = db;
      markRequestBAttempted();
      await db.run("INSERT INTO isolation_events (request_name) VALUES (?)", ["request-b"]);
      requestBSettled = true;
    });

    await requestBAttempted;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.notStrictEqual(requestAConnection, requestBConnection);
    assert.equal(requestBSettled, false);
    releaseRequestA();
    await Promise.all([requestA, requestB]);

    const db = await manager.getDb();
    const rows = await db.all<{ request_name: string }[]>(
      "SELECT request_name FROM isolation_events ORDER BY id ASC"
    );
    assert.deepEqual(rows.map(row => row.request_name), ["request-b"]);
  } finally {
    releaseRequestA();
    await manager.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
