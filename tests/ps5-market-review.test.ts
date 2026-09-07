import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("seeds the ongoing PS5 repricing case as a frozen V0.1 snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ps5-repricing-market-case-"));
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
    const title = "2026 PS5 系列价格重估 / PS5 Pro异常加速（进行中 V0.1）";
    const review = await db.get(
      `SELECT id, track, project_name, review_date, market_type_custom,
              summary_conclusion, short_lesson, background, market_start,
              market_evolution, key_turning_points, later_outcome,
              exposed_problem, extracted_lesson, note
       FROM market_reviews
       WHERE title = ? AND is_deleted = 0`,
      [title]
    );

    assert.ok(review);
    assert.equal(review.track, "游戏机");
    assert.equal(review.project_name, "PS5系列 / PS5 Pro");
    assert.equal(review.review_date, "2026-09-04");
    assert.match(review.market_type_custom, /疑似末端加速/);
    assert.match(review.summary_conclusion, /不预测顶部，也没有参与计划/);
    assert.match(review.short_lesson, /不适合追货/);
    assert.match(review.background, /日版数字版由约4800元升至9000元/);
    assert.match(review.background, /港版数字版由约5300元升至9300元/);
    assert.match(review.market_start, /以上均为截至冻结日的待验证推测/);
    assert.match(review.market_evolution, /暂不支持“单纯存储涨价导致所有游戏机普涨”/);
    assert.match(review.key_turning_points, /1\. Sony持续补货后/);
    assert.match(review.key_turning_points, /7\. 本轮存储成本/);
    assert.match(review.later_outcome, /V0\.1不写结局/);
    assert.match(review.later_outcome, /不确认后续一定暴跌/);
    assert.match(review.exposed_problem, /所有传导关系都停留在待验证层/);
    assert.match(review.extracted_lesson, /拿未来答案解释过去/);
    assert.match(review.note, /认知冻结日：2026-09-04/);
    assert.match(review.note, /形成V0\.2，不改写V0\.1原判断/);

    const audit = await db.get(
      `SELECT detail
       FROM audit_logs
       WHERE id = 'audit-market-review-ps5-repricing-v01-20260904'`
    );
    assert.ok(audit);
    assert.equal(JSON.parse(audit.detail).status, "ongoing");

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260904_001_seed_ps5_price_repricing_v01_market_case"]
    );
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT COUNT(*) AS total
       FROM market_reviews
       WHERE title = ? AND is_deleted = 0`,
      [title]
    );
    assert.equal(Number(duplicateCheck.total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
