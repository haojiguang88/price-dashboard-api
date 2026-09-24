import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";
import {
  insertAbnormalMonitorReads,
  parseAbnormalReadKey
} from "../src/routes/abnormalMonitorRoutes";

test("parses encoded abnormal read keys and rejects malformed values", () => {
  const parsed = parseAbnormalReadKey("object|%E5%8D%8E%E4%B8%BA|Mate%2070|%E9%BB%91%E8%89%B2|DAILY|2026-09-24");
  assert.ok(parsed);
  assert.equal(parsed?.category_name, "华为");
  assert.equal(parsed?.object_name, "Mate 70");
  assert.equal(parsed?.variant_name, "黑色");
  assert.equal(parsed?.canonicalReadKey, "object|%E5%8D%8E%E4%B8%BA|Mate%2070|%E9%BB%91%E8%89%B2|DAILY|2026-09-24");
  assert.equal(parseAbnormalReadKey("too|few|parts"), null);
  assert.equal(parseAbnormalReadKey(""), null);
});

test("batch insert marks unique unread keys and ignores duplicates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "abnormal-read-batch-"));
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

    const first = "object|%E5%8D%8E%E4%B8%BA|Mate%2070|%E9%BB%91%E8%89%B2|DAILY|2026-09-24";
    const second = "object|%E5%B0%8F%E7%B1%B3|14|%E7%99%BD%E8%89%B2|HIST_HIGH|2026-09-24";
    const summary = await insertAbnormalMonitorReads(db, [first, second, first, "bad-key"]);
    assert.equal(summary.valid, 2);
    assert.equal(summary.skipped_invalid, 1);
    assert.equal(summary.marked, 2);

    const replay = await insertAbnormalMonitorReads(db, [first, second]);
    assert.equal(replay.valid, 2);
    assert.equal(replay.marked, 0);

    const rows = await db.all(`SELECT read_key FROM abnormal_monitor_reads ORDER BY read_key`);
    assert.deepEqual(rows.map((row: { read_key: string }) => row.read_key), [first, second].sort());
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
