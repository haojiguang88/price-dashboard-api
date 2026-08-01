import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";
import {
  normalizeHumanCaseInput,
  normalizeHumanCasePatternInput
} from "../src/services/humanCaseLibraryService";
import {
  createHumanCaseSourceSnapshot,
  loadHumanCaseSources
} from "../src/services/humanCaseSourceService";

test("normalizes a real case while keeping action quality separate from outcome", () => {
  const input = normalizeHumanCaseInput({
    title: "按计划卖出但后来继续上涨",
    originType: "self",
    evidenceLevel: "first_hand",
    background: "价格快速上涨，市场情绪明显升温。",
    actionTaken: "按照预先计划分批卖出。",
    actionQuality: "good",
    outcomeType: "sold_early",
    evidenceRole: "positive",
    selfResponse: "以后仍按计划退出，不用最高价倒推当时决策。",
    patternLinks: [
      { patternId: 2, role: "secondary" },
      { patternId: 1, role: "primary" },
      { patternId: 1, role: "primary" }
    ]
  });

  assert.equal(input.actionQuality, "good");
  assert.equal(input.outcomeType, "sold_early");
  assert.equal(input.evidenceRole, "positive");
  assert.deepEqual(input.patternLinks, [
    { patternId: 2, role: "secondary" },
    { patternId: 1, role: "primary" }
  ]);
});

test("rejects invalid evidence dates and invalid pattern axes", () => {
  assert.throws(() => normalizeHumanCaseInput({
    title: "日期错误",
    background: "背景",
    actionTaken: "动作",
    selfResponse: "我的动作",
    caseDate: "2026-99-99"
  }), /案例日期格式/);

  assert.throws(() => normalizeHumanCasePatternInput({
    name: "错误分类",
    axis: "market",
    category: "human_bias"
  }), /市场轴只能使用市场结构分类/);
});

test("normalizes manual maturity and defaults case evidence to pending judgment", () => {
  const pattern = normalizeHumanCasePatternInput({
    name: "追高",
    axis: "human",
    category: "execution_error",
    maturity: "recurring"
  });
  const caseInput = normalizeHumanCaseInput({
    title: "样本",
    background: "背景",
    actionTaken: "动作",
    selfResponse: "我的动作",
    patternLinks: [{ patternId: 1, role: "primary" }]
  });

  assert.equal(pattern.maturity, "recurring");
  assert.equal(caseInput.evidenceRole, "neutral");
});

test("keeps unverified opinions in observation while linking completed reviews", async () => {
  const db = {
    all: async (sql: string) => {
      if (sql.includes("FROM business_reviews")) {
        return [{
          id: 7,
          title: "按计划退出",
          track: "纪念币",
          project_name: "样本",
          review_date: "2026-07-01",
          background: "价格上涨",
          judgment_at_that_time: "承接开始变弱",
          action_at_that_time: "分批卖出",
          later_outcome: "后来继续上涨",
          extracted_lesson: "动作正确，接受卖飞"
        }];
      }
      if (sql.includes("FROM opinion_records")) {
        return [{
          id: 9,
          title: "未经验证观点",
          person_name: "测试人物",
          source_platform: "公开平台",
          opinion_date: "2026-07-02",
          validation_status: "pending",
          original_opinion: "市场可能反转"
        }];
      }
      if (sql.includes("FROM behavior_cases")) {
        return [{
          id: 3,
          title: "已提炼案例",
          source_type: "business_review",
          source_id: "7"
        }];
      }
      return [];
    }
  };

  const sources = await loadHumanCaseSources(db);
  const review = sources.find(source => source.sourceType === "business_review");
  const opinion = sources.find(source => source.sourceType === "opinion_record");

  assert.equal(review?.readiness, "ready");
  assert.equal(review?.linkedCaseId, "3");
  assert.equal(review?.prefill.actionTaken, "分批卖出");
  const snapshot = createHumanCaseSourceSnapshot(review!);
  assert.equal(snapshot.prefill.actionTaken, "分批卖出");
  assert.equal(snapshot.sourcePath, "/review/business?recordId=7");
  assert.equal(opinion?.readiness, "observation");
  assert.equal(opinion?.linkedCaseId, "");
  assert.match(opinion?.readinessReason || "", /观察层/);
});

test("requires source type and source id to be provided together", () => {
  assert.throws(() => normalizeHumanCaseInput({
    title: "缺少来源 ID",
    background: "背景",
    actionTaken: "动作",
    selfResponse: "我的动作",
    sourceType: "business_review"
  }), /必须同时填写/);
});

test("stores an immutable source snapshot and prevents duplicate active distillation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "human-case-source-"));
  const filename = path.join(directory, "human-case.db");
  const manager = new DatabaseManager({
    filename,
    allowCreate: true,
    initialize: initializeBusinessBaseSchema
  });

  try {
    await manager.getDb();
    await runMigrations(filename);
    const db = await manager.getDb();
    const seededDeadHold = await db.get(
      "SELECT category, maturity FROM behavior_patterns WHERE name = '死扛' AND is_deleted = 0"
    );
    const sunkCostMechanism = await db.get(
      "SELECT category FROM behavior_patterns WHERE name = '沉没成本绑架决策' AND is_deleted = 0"
    );
    const duplicateSunkCostMechanism = await db.get(
      "SELECT id FROM behavior_patterns WHERE name = '沉没成本与拒绝承认' AND is_deleted = 0"
    );
    assert.equal(seededDeadHold?.category, "execution_error");
    assert.equal(seededDeadHold?.maturity, "candidate");
    assert.equal(sunkCostMechanism?.category, "human_bias");
    assert.equal(duplicateSunkCostMechanism, undefined);
    const inserted = await db.run(
      `INSERT INTO business_reviews
        (title, track, review_date, background, judgment_at_that_time,
         action_at_that_time, later_outcome, extracted_lesson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "原始标题",
        "纪念币",
        "2026-07-31",
        "原始背景",
        "当时判断",
        "分批退出",
        "后来卖飞",
        "接受卖飞"
      ]
    );
    const sourceId = String(inserted.lastID);
    const source = await loadHumanCaseSources(db).then(items => (
      items.find(item => item.sourceType === "business_review" && item.sourceId === sourceId)
    ));
    assert.ok(source);
    const snapshot = createHumanCaseSourceSnapshot(source!);

    await db.run(
      `INSERT INTO behavior_cases
        (title, background, action_taken, self_response, source_type, source_id, source_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "提炼案例",
        "原始背景",
        "分批退出",
        "继续按计划执行",
        "business_review",
        sourceId,
        JSON.stringify(snapshot)
      ]
    );
    await db.run("UPDATE business_reviews SET title = ? WHERE id = ?", ["修改后的标题", sourceId]);

    const stored = await db.get(
      "SELECT source_snapshot_json FROM behavior_cases WHERE source_type = ? AND source_id = ?",
      ["business_review", sourceId]
    );
    assert.equal(JSON.parse(stored.source_snapshot_json).sourceTitle, "原始标题");
    assert.equal(JSON.parse(stored.source_snapshot_json).prefill.actionTaken, "分批退出");

    await assert.rejects(
      db.run(
        `INSERT INTO behavior_cases
          (title, background, action_taken, self_response, source_type, source_id, source_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["重复案例", "背景", "动作", "迁移动作", "business_review", sourceId, "{}"]
      ),
      /UNIQUE constraint failed/
    );
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
