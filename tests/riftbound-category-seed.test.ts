import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("seeds Riftbound card category with anniversary gift box, official anchor and Qiandao quote todo", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "riftbound-"));
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
      `SELECT id FROM migrations WHERE id = '20260928_001_seed_riftbound_category'`
    );
    assert.ok(applied);

    const category = await db.get(
      `SELECT id, tracking_mode, is_archived FROM categories WHERE name = '符文战场卡牌'`
    );
    assert.ok(category);
    assert.equal(category.tracking_mode, "active");
    assert.equal(Number(category.is_archived), 0);

    const object = await db.get(
      `SELECT o.id, o.is_archived FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '符文战场卡牌' AND o.name = '一周年纪念套装礼盒'`
    );
    assert.ok(object);
    assert.equal(Number(object.is_archived), 0);

    const variants = await db.all(
      `SELECT name FROM variants WHERE object_id = ?`,
      [object.id]
    );
    assert.deepEqual(
      variants.map((row: { name: string }) => row.name),
      ["简中版"]
    );

    const anchor = await db.get(
      `SELECT object_name, variant_name, original_price, effective_date, source, note
       FROM original_price_records
       WHERE category_name = '符文战场卡牌' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(anchor);
    assert.equal(anchor.object_name, "一周年纪念套装礼盒");
    assert.equal(anchor.variant_name, "简中版");
    assert.equal(Number(anchor.original_price), 358);
    assert.equal(anchor.effective_date, "2026-09-28");
    assert.equal(anchor.source, "拳头官方商城建议零售价");
    assert.match(String(anchor.note), /每人限购 2 盒/);
    assert.match(String(anchor.note), /周年纪念卡 \+ 36 张闪卡符文卡 \+ 进阶补充包/);

    const todo = await db.get(
      `SELECT title, priority, status, note, domain, workspace
       FROM manual_todos
       WHERE title = '监控符文战场礼盒千岛盘口'`
    );
    assert.ok(todo);
    assert.equal(todo.priority, "high");
    assert.equal(todo.status, "pending");
    assert.equal(todo.domain, "business");
    assert.equal(todo.workspace, "business");
    assert.match(String(todo.note), /求购价\/闪购价/);
    assert.match(String(todo.note), /官方锚 358 元/);
    assert.match(String(todo.note), /快进快出不留仓/);
    assert.match(String(todo.note), /官方加印公告 = 立即离场信号/);
    assert.match(String(todo.note), /T1 主题礼盒/);

    // Idempotency: removing the migration row and re-running must not duplicate rows.
    await db.run("DELETE FROM migrations WHERE id = '20260928_001_seed_riftbound_category'");
    await runMigrations(filename);
    const anchorCount = await db.get(
      `SELECT COUNT(*) AS total FROM original_price_records
       WHERE category_name = '符文战场卡牌' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.equal(Number(anchorCount.total), 1);
    const todoCount = await db.get(
      `SELECT COUNT(*) AS total FROM manual_todos
       WHERE title = '监控符文战场礼盒千岛盘口'`
    );
    assert.equal(Number(todoCount.total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
