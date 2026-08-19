import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import {
  BUSINESS_APP_WORKSPACE,
  BUSINESS_DATABASE_IDENTITY,
  validateExistingBusinessDatabase,
  verifyBusinessDatabaseReadiness
} from "../src/config/databaseValidation";
import { getExpectedMigrationIds, runMigrations } from "../src/migrations";

test("new temporary business database gains identity, migrations and required tables", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-db-readiness-"));
  const filename = path.join(tempDirectory, "business-test.db");
  const manager = new DatabaseManager({
    filename,
    allowCreate: true,
    initialize: initializeBusinessBaseSchema
  });

  try {
    await manager.getDb();
    await runMigrations(filename);
    const expectedMigrationIds = getExpectedMigrationIds();
    assert.equal(new Set(expectedMigrationIds).size, expectedMigrationIds.length);

    const db = await manager.getDb();
    const silverCatchupTask = await db.get(
      `SELECT task_type, enabled, schedule_time, schedule_days, config_json
       FROM task_center_tasks
       WHERE task_key = 'precious_metal_silver_catchup'`
    );
    assert.equal(silverCatchupTask?.task_type, 'precious_metal_market_update');
    assert.equal(silverCatchupTask?.enabled, 1);
    assert.equal(silverCatchupTask?.schedule_time, '21:10');
    assert.equal(silverCatchupTask?.schedule_days, 'work_days');
    assert.deepEqual(JSON.parse(silverCatchupTask?.config_json || '{}'), {
      symbols: ['SGE_AGTD'],
      freshness_symbols: ['SGE_AGTD'],
      require_current_date: true,
      retry_when_stale: true,
      retry_after_minutes: 30,
      task_timeout_minutes: 30
    });

    const identity = await validateExistingBusinessDatabase(filename, { allowEmpty: false });
    assert.equal(identity.identity, "marked");

    const report = await verifyBusinessDatabaseReadiness(filename, expectedMigrationIds);
    assert.equal(report.identity, BUSINESS_DATABASE_IDENTITY);
    assert.equal(report.workspace, BUSINESS_APP_WORKSPACE);
    assert.equal(report.latestMigrationId, expectedMigrationIds[expectedMigrationIds.length - 1]);
    assert.ok(report.migrationCount >= expectedMigrationIds.length);
  } finally {
    await manager.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
