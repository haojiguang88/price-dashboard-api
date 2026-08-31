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
    pricingAnalysis: {
      basePriceLabel: "普通品",
      basePrice: 1000,
      observedPriceLabel: "收购报价",
      observedPriceLow: 17000,
      priceSignalType: "bid",
      conditionStack: ["首日", "70分", "首日"],
      buyerBreadth: "single",
      keyBuyerDependency: "high",
      exitLiquidity: "thin",
      verificationNote: "尚未确认成交"
    },
    patternLinks: [
      { patternId: 2, role: "secondary" },
      { patternId: 1, role: "primary" },
      { patternId: 1, role: "primary" }
    ]
  });

  assert.equal(input.actionQuality, "good");
  assert.equal(input.outcomeType, "sold_early");
  assert.equal(input.evidenceRole, "positive");
  assert.equal(input.pricingAnalysis.observedPriceHigh, 17000);
  assert.deepEqual(input.pricingAnalysis.conditionStack, ["首日", "70分"]);
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

  assert.throws(() => normalizeHumanCaseInput({
    title: "价格区间错误",
    background: "背景",
    actionTaken: "动作",
    selfResponse: "我的动作",
    pricingAnalysis: {
      observedPriceLow: 17000,
      observedPriceHigh: 1000
    }
  }), /观察价上限不能低于下限/);
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

test("seeds the Situational Awareness case as leverage and liquidity risk evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "situational-awareness-case-"));
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
    const behaviorCase = await db.get(
      `SELECT id, origin_type, evidence_level, action_quality, outcome_type,
              evidence_role, self_response, note
       FROM behavior_cases
       WHERE title = ? AND is_deleted = 0`,
      ["Situational Awareness：看对大势却失去等待资格"]
    );

    assert.ok(behaviorCase);
    assert.equal(behaviorCase.origin_type, "public");
    assert.equal(behaviorCase.evidence_level, "documented");
    assert.equal(behaviorCase.action_quality, "flawed");
    assert.equal(behaviorCase.outcome_type, "loss");
    assert.equal(behaviorCase.evidence_role, "negative");
    assert.match(behaviorCase.self_response, /保证金剥夺等待权/);
    assert.match(behaviorCase.note, /“被围剿”缺少充分证据/);

    const links = await db.all(
      `SELECT p.name, l.role
       FROM behavior_case_pattern_links l
       JOIN behavior_patterns p ON p.id = l.pattern_id
       WHERE l.case_id = ?
       ORDER BY CASE l.role WHEN 'primary' THEN 0 ELSE 1 END, p.name`,
      [behaviorCase.id]
    );
    assert.deepEqual(links, [
      { name: "过度下注", role: "primary" },
      { name: "暴涨后崩跌", role: "secondary" },
      { name: "连续盈利后的自信膨胀", role: "secondary" }
    ]);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260812_001_add_situational_awareness_risk_case"]
    );
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT COUNT(*) AS total
       FROM behavior_cases
       WHERE title = ? AND is_deleted = 0`,
      ["Situational Awareness：看对大势却失去等待资格"]
    );
    assert.equal(Number(duplicateCheck.total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("merges the Android miss into one second-order supply-chain case", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "android-supply-chain-case-"));
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
    const review = await db.get(
      `SELECT id, title, miss_type, exposed_problem, short_lesson
       FROM missed_projects
       WHERE title = ? AND is_deleted = 0`,
      ["安卓机器：产业链推演只走一半，起飞后不追"]
    );
    assert.ok(review);
    assert.match(review.miss_type, /前期推演不足/);
    assert.match(review.exposed_problem, /产能挤占/);
    assert.match(review.short_lesson, /第二阶、第三阶/);

    const behaviorCase = await db.get(
      `SELECT id, action_quality, outcome_type, evidence_role, self_response,
              linked_rule_refs_json
       FROM behavior_cases
       WHERE source_type = 'missed_project' AND source_id = ? AND is_deleted = 0`,
      [String(review.id)]
    );
    assert.ok(behaviorCase);
    assert.equal(behaviorCase.action_quality, "mixed");
    assert.equal(behaviorCase.outcome_type, "mixed");
    assert.equal(behaviorCase.evidence_role, "boundary");
    assert.match(behaviorCase.self_response, /八问模板/);
    assert.deepEqual(JSON.parse(behaviorCase.linked_rule_refs_json), [
      "大趋势只是入口，真正的机会往往藏在趋势造成的第二阶、第三阶供需变化里",
      "先把因果链验证完整；价格起飞后仍不追高"
    ]);

    const links = await db.all(
      `SELECT p.name, l.role
       FROM behavior_case_pattern_links l
       JOIN behavior_patterns p ON p.id = l.pattern_id
       WHERE l.case_id = ?
       ORDER BY CASE l.role WHEN 'primary' THEN 0 ELSE 1 END, p.name`,
      [behaviorCase.id]
    );
    assert.deepEqual(links, [
      { name: "研究与推演停在表层", role: "primary" },
      { name: "产能挤占与二三阶传导", role: "secondary" },
      { name: "恐惧与过度防守", role: "secondary" }
    ]);

    const rule = await db.get(
      `SELECT summary_conclusion, note
       FROM rule_experiences
       WHERE title = ? AND is_deleted = 0`,
      ["大趋势要继续推演产能挤占和二三阶供需变化"]
    );
    assert.match(rule?.summary_conclusion || "", /大趋势只是入口/);
    assert.match(rule?.note || "", /不自动生成操作结论/);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260812_002_merge_android_ai_supply_chain_case"]
    );
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM missed_projects
          WHERE title = ? AND is_deleted = 0) AS review_total,
         (SELECT COUNT(*) FROM behavior_cases
          WHERE source_type = 'missed_project' AND source_id = ? AND is_deleted = 0) AS case_total`,
      ["安卓机器：产业链推演只走一半，起飞后不追", String(review.id)]
    );
    assert.equal(Number(duplicateCheck.review_total), 1);
    assert.equal(Number(duplicateCheck.case_total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("seeds collectible scarcity cases with honest quote and liquidity boundaries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "collectible-pricing-case-"));
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
    const luckyCase = await db.get(
      `SELECT id, action_quality, outcome_type, evidence_role, pricing_analysis_json,
              visible_information, self_response, learn_to_keep, learn_to_avoid,
              applicability_boundary, linked_rule_refs_json
       FROM behavior_cases
       WHERE title = ? AND is_deleted = 0`,
      ["工商25龙：首日+70分+如意王的17倍收购观察"]
    );
    assert.ok(luckyCase);
    assert.equal(luckyCase.action_quality, "mixed");
    assert.equal(luckyCase.outcome_type, "ongoing");
    assert.equal(luckyCase.evidence_role, "boundary");
    assert.match(luckyCase.visible_information, /不是圈层目标号，价格会低很多/);
    assert.match(luckyCase.self_response, /是否圈层目标号/);
    assert.match(luckyCase.learn_to_keep, /固定玩家圈层/);
    assert.match(luckyCase.learn_to_avoid, /翻倍公式/);
    assert.match(luckyCase.applicability_boundary, /小众收藏品/);
    assert.match(luckyCase.applicability_boundary, /普通靓号/);

    const linkedRules = JSON.parse(luckyCase.linked_rule_refs_json);
    assert.ok(linkedRules.some((item: string) => item.includes("稀缺入场券")));
    assert.ok(linkedRules.some((item: string) => item.includes("圈外只做前期低价小量埋伏")));

    const luckyPricing = JSON.parse(luckyCase.pricing_analysis_json);
    assert.equal(luckyPricing.basePrice, 1000);
    assert.equal(luckyPricing.observedPriceLow, 17000);
    assert.equal(luckyPricing.priceSignalType, "bid");
    assert.equal(luckyPricing.buyerBreadth, "concentrated");
    assert.deepEqual(luckyPricing.conditionStack, ["龙头", "首日", "评级70分", "圈层目标号：如意王"]);
    assert.match(luckyPricing.verificationNote, /非圈层目标号码价格低很多/);

    const circlePattern = await db.get(
      `SELECT summary, mechanism, protective_action
       FROM behavior_patterns
       WHERE name = '组合稀缺与圈层定价' AND is_deleted = 0`
    );
    assert.ok(circlePattern);
    assert.match(circlePattern.summary, /特定号码/);
    assert.match(circlePattern.mechanism, /并非所有靓号共享/);
    assert.match(circlePattern.protective_action, /高位不追/);

    const luckyLinks = await db.all(
      `SELECT p.name, l.role
       FROM behavior_case_pattern_links l
       JOIN behavior_patterns p ON p.id = l.pattern_id
       WHERE l.case_id = ?
       ORDER BY CASE l.role WHEN 'primary' THEN 0 ELSE 1 END, p.name`,
      [luckyCase.id]
    );
    assert.deepEqual(luckyLinks, [
      { name: "研究与推演停在表层", role: "primary" },
      { name: "组合稀缺与圈层定价", role: "secondary" },
      { name: "资金拉盘", role: "secondary" }
    ]);

    const facaiCase = await db.get(
      `SELECT id, title, action_quality, pricing_analysis_json
       FROM behavior_cases
       WHERE project_name = '发财龙（PMG网红专标）' AND is_deleted = 0`
    );
    assert.ok(facaiCase);
    assert.match(facaiCase.title, /运营制造稀缺/);
    assert.equal(facaiCase.action_quality, "good");
    const facaiPricing = JSON.parse(facaiCase.pricing_analysis_json);
    assert.equal(facaiPricing.basePrice, 670);
    assert.equal(facaiPricing.observedPriceLow, 6000);
    assert.equal(facaiPricing.observedPriceHigh, 7000);

    const facaiLinks = await db.all(
      `SELECT p.name, p.category, l.role
       FROM behavior_case_pattern_links l
       JOIN behavior_patterns p ON p.id = l.pattern_id
       WHERE l.case_id = ?
       ORDER BY CASE l.role WHEN 'primary' THEN 0 ELSE 1 END, p.name`,
      [facaiCase.id]
    );
    assert.deepEqual(facaiLinks, [
      { name: "主动放弃与纪律优先", category: "positive_discipline", role: "primary" },
      { name: "资金拉盘", category: "market_structure", role: "secondary" },
      { name: "运营制造稀缺", category: "market_structure", role: "secondary" }
    ]);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260822_001_add_case_pricing_analysis_and_collectible_samples"]
    );
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM behavior_cases
          WHERE title = ? AND is_deleted = 0) AS case_total,
         (SELECT COUNT(*) FROM behavior_patterns
          WHERE name = '组合稀缺与圈层定价' AND is_deleted = 0) AS pattern_total`,
      ["工商25龙：首日+70分+如意王的17倍收购观察"]
    );
    assert.equal(Number(duplicateCheck.case_total), 1);
    assert.equal(Number(duplicateCheck.pattern_total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
