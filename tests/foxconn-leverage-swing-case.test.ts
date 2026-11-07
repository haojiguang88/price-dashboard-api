import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("seeds the Foxconn leverage swing case as the body behind trading manual todo 675", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "foxconn-swing-case-"));
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
    const title = "工业富联杠杆波段：高胜率策略的尾部死亡";

    const applied = await db.get(
      `SELECT id FROM migrations WHERE id = '20261024_001_seed_foxconn_leverage_swing_tail_case'`
    );
    assert.ok(applied);

    const behaviorCase = await db.get(
      `SELECT id, origin_type, subject_alias, evidence_level, case_date, track, project_name,
              action_quality, outcome_type, evidence_role, source_type, source_id,
              background, visible_information, pressure_context, action_taken, result,
              self_response, learn_to_keep, learn_to_avoid, applicability_boundary,
              linked_rule_refs_json, source_snapshot_json, note
       FROM behavior_cases
       WHERE title = ? AND is_deleted = 0`,
      [title]
    );
    assert.ok(behaviorCase);
    assert.equal(behaviorCase.origin_type, "other");
    assert.equal(behaviorCase.subject_alias, "狗头");
    assert.equal(behaviorCase.evidence_level, "second_hand");
    assert.equal(behaviorCase.case_date, "2026-10-15");
    assert.equal(behaviorCase.track, "股票");
    assert.equal(behaviorCase.project_name, "工业富联（601138）");
    assert.equal(behaviorCase.action_quality, "bad");
    assert.equal(behaviorCase.outcome_type, "loss");
    assert.equal(behaviorCase.evidence_role, "negative");
    assert.equal(behaviorCase.source_type, "trading_manual_todo");
    assert.equal(behaviorCase.source_id, "675");
    assert.match(behaviorCase.background, /赚一两个点就收/);
    assert.match(behaviorCase.visible_information, /81\.05/);
    assert.match(behaviorCase.visible_information, /46\.9/);
    assert.match(behaviorCase.visible_information, /42\.1%/);
    assert.match(behaviorCase.visible_information, /DEEP_CRASH/);
    assert.match(behaviorCase.pressure_context, /信心/);
    assert.match(behaviorCase.action_taken, /接近坑底/);
    assert.match(behaviorCase.result, /融资加重仓/);
    assert.match(behaviorCase.self_response, /进场前写死/);
    assert.match(behaviorCase.learn_to_avoid, /历史胜率/);
    assert.match(behaviorCase.applicability_boundary, /不是工业富联的质地结论/);
    assert.match(behaviorCase.applicability_boundary, /不把本案例写成可以去抄这轮的底/);
    assert.match(behaviorCase.note, /#675/);

    const rules = JSON.parse(behaviorCase.linked_rule_refs_json);
    assert.ok(rules.some((item: string) => item.includes("不能交给临场信心")));
    assert.ok(rules.some((item: string) => item.includes("亏损端")));
    assert.ok(rules.some((item: string) => item.includes("#675")));
    const snapshot = JSON.parse(behaviorCase.source_snapshot_json);
    assert.equal(snapshot.sourceId, "675");
    assert.ok(snapshot.unverifiedClaims.some((item: string) => item.includes("成交价")));

    const links = await db.all(
      `SELECT p.name, l.role
       FROM behavior_case_pattern_links l
       JOIN behavior_patterns p ON p.id = l.pattern_id
       WHERE l.case_id = ?
       ORDER BY CASE l.role WHEN 'primary' THEN 0 ELSE 1 END, p.name`,
      [behaviorCase.id]
    );
    assert.deepEqual(links, [
      { name: "没有退出机制", role: "primary" },
      { name: "沉没成本绑架决策", role: "secondary" },
      { name: "连续盈利后的自信膨胀", role: "secondary" }
    ]);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
