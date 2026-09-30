import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("elevates Pop Mart one tier to secondary while keeping only Zsiga small-lot executable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "popmart-annual-elevate-"));
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

    await db.run(
      `INSERT OR IGNORE INTO annual_plans
        (year, title, status, is_deleted, created_at, updated_at)
       VALUES (2026, '2026年度计划', '生效中', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    );
    const plan = await db.get(
      `SELECT id FROM annual_plans WHERE year = 2026 AND COALESCE(is_deleted, 0) = 0 ORDER BY id LIMIT 1`
    );
    assert.ok(plan);

    const existingTrack = await db.get(
      `SELECT id FROM annual_plan_items
       WHERE plan_id = ? AND category = '泡泡玛特' AND object_name = '整体' AND COALESCE(is_deleted, 0) = 0`,
      [plan.id]
    );
    if (!existingTrack) {
      await db.run(
        `INSERT INTO annual_plan_items
          (plan_id, scope_type, category, object_name, current_role, current_action,
           current_status, thesis, current_reason, position_rule, exit_rule,
           downgrade_reason, resume_condition, priority_order, note,
           is_deleted, created_at, updated_at)
         VALUES (?, '赛道', '泡泡玛特', '整体', '试错', '轻仓参与', '已降级', ?, ?, ?, ?, ?, ?, 3, ?,
                 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          plan.id,
          "当前泡泡玛特整体不作为主做方向，仅保留观察与条件触发后的再评估权。",
          "当前二级市场过烂、流动性不足，但是嘎子姐和姜饼人可以观察，这俩工艺复杂，有承接",
          "当前不主动加仓，不扩张，不作为主线配置。",
          "若有仓位，按拉高出货/变现优先。",
          "二级市场过烂、流动性不足、整体环境太弱，当前不适合主动参与。",
          "后续仅在市场明显转暖、承接恢复、成交连续性改善后再评估恢复。",
          "整体降级为观察/暂停，后续视市场是否明显转暖再定。"
        ]
      );
    } else {
      await db.run(
        `UPDATE annual_plan_items
         SET current_role = '试错',
             current_action = '轻仓参与',
             current_status = '已降级',
             current_reason = '当前二级市场过烂、流动性不足',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [existingTrack.id]
      );
    }

    await db.run(
      `UPDATE annual_plan_items
       SET current_role = '试错',
           current_action = '轻仓参与',
           current_status = '生效中',
           current_reason = '2026-09-12：底仓分层占位，禁止一次打满。整体赛道仍降级。',
           updated_at = CURRENT_TIMESTAMP
       WHERE category = '泡泡玛特'
         AND object_name IN ('Zsiga', '嘎子姐', '向往之处')
         AND COALESCE(is_deleted, 0) = 0`
    );
    await db.run(
      `DELETE FROM annual_plan_item_changes
       WHERE change_date = '2026-09-30'
         AND COALESCE(reason, '') LIKE '%认知冻结日：2026-09-30%'`
    );
    await db.run(
      "DELETE FROM migrations WHERE id IN (?, ?, ?, ?)",
      [
        "20260912_003_start_gazijie_layered_core_position",
        "20260912_004_keep_gazijie_core_position_in_plans_only",
        "20260926_004_regroup_zsiga_series",
        "20260930_002_elevate_popmart_secondary_zsiga_only"
      ]
    );
    await runMigrations(filename);

    const track = await db.get(
      `SELECT current_role, current_action, current_status, thesis, position_rule
       FROM annual_plan_items
       WHERE category = '泡泡玛特' AND object_name = '整体' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(track);
    assert.equal(track.current_role, "次主线");
    assert.equal(track.current_action, "只观察");
    assert.equal(track.current_status, "生效中");
    assert.match(String(track.thesis), /不把泡泡玛特整体升回主做/);
    assert.doesNotMatch(String(track.thesis), /升回主做方向/);
    assert.match(String(track.position_rule), /唯一执行口子是 Zsiga \/ 向往之处小仓/);

    const zsiga = await db.get(
      `SELECT current_role, current_action, current_status, thesis, position_rule
       FROM annual_plan_items
       WHERE category = '泡泡玛特' AND object_name = 'Zsiga' AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(zsiga);
    assert.equal(zsiga.current_role, "次主线");
    assert.equal(zsiga.current_action, "轻仓参与");
    assert.equal(zsiga.current_status, "生效中");
    assert.match(String(zsiga.thesis), /不把泡泡玛特整体升回主做/);
    assert.match(String(zsiga.position_rule), /禁止一次打满/);
    assert.match(String(zsiga.position_rule), /520\+/);
    assert.match(String(zsiga.position_rule), /500/);

    const changes = await db.all(
      `SELECT plan_item_id, old_role, new_role, old_action, new_action, old_status, new_status
       FROM annual_plan_item_changes
       WHERE change_date = '2026-09-30'
         AND COALESCE(reason, '') LIKE '%认知冻结日：2026-09-30%'
       ORDER BY id`
    );
    assert.equal(changes.length, 2);
    const trackChange = changes.find((row: { old_status: string }) => row.old_status === "已降级");
    const zsigaChange = changes.find((row: { old_status: string }) => row.old_status === "生效中");
    assert.ok(trackChange);
    assert.equal(trackChange.old_role, "试错");
    assert.equal(trackChange.new_role, "次主线");
    assert.equal(trackChange.old_action, "轻仓参与");
    assert.equal(trackChange.new_action, "只观察");
    assert.ok(zsigaChange);
    assert.equal(zsigaChange.old_role, "试错");
    assert.equal(zsigaChange.new_role, "次主线");
    assert.equal(zsigaChange.new_action, "轻仓参与");

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260930_002_elevate_popmart_secondary_zsiga_only"]
    );
    await runMigrations(filename);
    const rerunCount = await db.get(
      `SELECT COUNT(*) AS total
       FROM annual_plan_item_changes
       WHERE change_date = '2026-09-30'
         AND COALESCE(reason, '') LIKE '%认知冻结日：2026-09-30%'`
    );
    assert.equal(Number(rerunCount.total), 2);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
