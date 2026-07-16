import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";
import { searchGlobalRecords } from "../src/services/globalSearchService";

test("global search returns lightweight, record-addressable results from a temporary database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-global-search-"));
  const filename = path.join(directory, "search-test.db");
  const manager = new DatabaseManager({
    filename,
    allowCreate: true,
    initialize: initializeBusinessBaseSchema
  });

  try {
    await manager.getDb();
    await runMigrations(filename);
    const db = await manager.getDb();
    const longDescription = `统一搜索验证 ${"只用于确认摘要不会展开整篇正文 ".repeat(30)}`;
    const insert = await db.run(
      `INSERT INTO event_records
         (title, track, event_date, event_type, description, related_object, impact, source, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "统一搜索验证事件",
        "纪念币",
        "2026-07-16",
        "行情",
        longDescription,
        "龙钞散张",
        "验证统一搜索轻量返回",
        "测试",
        "仅写入临时数据库",
        "2026-07-16T02:00:00.000Z",
        "2026-07-16T02:00:00.000Z"
      ]
    );

    const results = await searchGlobalRecords(db, "统一搜索验证", 40);
    const event = results.find(item => item.record_id === `event:${insert.lastID}`);

    assert.ok(event);
    assert.equal(event?.entity_id, insert.lastID);
    assert.equal(event?.path, "/event-v2");
    assert.equal(event?.source_type, "event");
    assert.ok((event?.detail.length || 0) <= 240);
    assert.equal(results.some(item => item.title.includes("不存在的记录")), false);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
