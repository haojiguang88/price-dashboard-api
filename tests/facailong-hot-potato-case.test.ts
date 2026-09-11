import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("closes the Facai Long influencer case as a hot-potato hanging tree", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "facailong-hot-potato-"));
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

    const treeCase = await db.get(
      `SELECT title, tree_type, later_outcome, short_lesson, judgment_at_that_time
       FROM tree_hanging_cases
       WHERE project_name = '发财龙（PMG网红专标）' AND COALESCE(is_deleted, 0) = 0
       ORDER BY id LIMIT 1`
    );
    assert.ok(treeCase, "tree hanging case should exist");
    assert.equal(treeCase.title, "发财龙网红专标击鼓传花挂树案例");
    assert.match(String(treeCase.tree_type), /击鼓传花/);
    assert.match(String(treeCase.later_outcome), /击鼓传花坐实（2026-09-07）/);
    assert.match(String(treeCase.later_outcome), /原价抢到的没事/);
    assert.match(String(treeCase.later_outcome), /高价收货的挂树上/);
    assert.doesNotMatch(String(treeCase.later_outcome), /观察中/);
    assert.match(String(treeCase.short_lesson), /最后一棒/);
    assert.match(String(treeCase.judgment_at_that_time), /高位不追/);

    const behaviorCase = await db.get(
      `SELECT title, outcome_type, result, pricing_analysis_json
       FROM behavior_cases
       WHERE project_name = '发财龙（PMG网红专标）' AND COALESCE(is_deleted, 0) = 0
       ORDER BY id LIMIT 1`
    );
    assert.ok(behaviorCase, "behavior case should exist");
    assert.equal(behaviorCase.outcome_type, "mixed");
    assert.match(String(behaviorCase.title), /击鼓传花/);
    assert.match(String(behaviorCase.result), /认怂/);
    const pricing = JSON.parse(String(behaviorCase.pricing_analysis_json || "{}"));
    assert.equal(pricing.inventedPostCrashPrice, undefined);
    assert.match(String(pricing.verificationNote), /不补造砸盘后的精确成交价/);

    const applied = await db.get(
      "SELECT id FROM migrations WHERE id = ?",
      ["20260907_001_close_facailong_influencer_hot_potato"]
    );
    assert.ok(applied);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
