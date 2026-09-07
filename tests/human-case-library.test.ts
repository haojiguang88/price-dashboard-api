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

test("seeds the Fuyao case as mixed survival and discipline evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fuyao-trading-survival-case-"));
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
      `SELECT id, origin_type, subject_alias, evidence_level, track,
              action_quality, outcome_type, evidence_role, action_taken,
              self_response, applicability_boundary, linked_rule_refs_json,
              source_snapshot_json, note
       FROM behavior_cases
       WHERE title = ? AND is_deleted = 0`,
      ["扶摇聊交易：从反复爆仓到“先不死”的账户重建"]
    );

    assert.ok(behaviorCase);
    assert.equal(behaviorCase.origin_type, "public");
    assert.equal(behaviorCase.subject_alias, "扶摇聊交易");
    assert.equal(behaviorCase.evidence_level, "unconfirmed");
    assert.equal(behaviorCase.track, "杠杆交易（期货/外汇未确认）");
    assert.equal(behaviorCase.action_quality, "mixed");
    assert.equal(behaviorCase.outcome_type, "mixed");
    assert.equal(behaviorCase.evidence_role, "boundary");
    assert.match(behaviorCase.action_taken, /每笔最多亏3美元/);
    assert.match(behaviorCase.action_taken, /每天最多3单/);
    assert.match(behaviorCase.self_response, /借款不用于高杠杆交易/);
    assert.match(behaviorCase.applicability_boundary, /借钱扩大账户也不是可复制的正面动作/);
    assert.match(behaviorCase.note, /不作为收益承诺/);
    assert.deepEqual(JSON.parse(behaviorCase.linked_rule_refs_json), [
      "先不死，保住本金",
      "单次损失必须事先限定并可承受",
      "只做交易系统内的机会",
      "亏损后禁止加码翻本",
      "连续盈利不得突破仓位边界"
    ]);
    assert.equal(
      JSON.parse(behaviorCase.source_snapshot_json).verificationStatus,
      "unconfirmed"
    );

    const links = await db.all(
      `SELECT p.name, p.category, l.role
       FROM behavior_case_pattern_links l
       JOIN behavior_patterns p ON p.id = l.pattern_id
       WHERE l.case_id = ?
       ORDER BY CASE l.role WHEN 'primary' THEN 0 ELSE 1 END, p.name`,
      [behaviorCase.id]
    );
    assert.deepEqual(links, [
      { name: "过度下注", category: "execution_error", role: "primary" },
      { name: "恐惧与过度防守", category: "human_bias", role: "secondary" },
      { name: "连续盈利后的自信膨胀", category: "human_bias", role: "secondary" }
    ]);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260903_001_seed_fuyao_trading_survival_case"]
    );
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT COUNT(*) AS total
       FROM behavior_cases
       WHERE title = ? AND is_deleted = 0`,
      ["扶摇聊交易：从反复爆仓到“先不死”的账户重建"]
    );
    assert.equal(Number(duplicateCheck.total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("seeds the creator audience-pressure case without treating profit as a good action", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "creator-audience-pressure-case-"));
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
    const pattern = await db.get(
      `SELECT axis, category, maturity, summary, counter_question, protective_action
       FROM behavior_patterns
       WHERE name = '外部评价绑架决策' AND is_deleted = 0`
    );
    assert.ok(pattern);
    assert.equal(pattern.axis, "human");
    assert.equal(pattern.category, "human_bias");
    assert.equal(pattern.maturity, "candidate");
    assert.match(pattern.summary, /放弃原本符合自身风险边界的决策/);
    assert.match(pattern.counter_question, /替我承担回撤/);
    assert.match(pattern.protective_action, /公开观点与个人仓位分开/);

    const behaviorCase = await db.get(
      `SELECT id, origin_type, subject_alias, evidence_level, track,
              action_quality, outcome_type, evidence_role, background,
              visible_information, pressure_context, result, self_response,
              learn_to_avoid, applicability_boundary, linked_rule_refs_json,
              source_snapshot_json, note
       FROM behavior_cases
       WHERE title = ? AND is_deleted = 0`,
      ["小张小张吃饭用缸：粉丝评价绑架退出，盈利仍大幅回撤"]
    );

    assert.ok(behaviorCase);
    assert.equal(behaviorCase.origin_type, "public");
    assert.equal(behaviorCase.subject_alias, "小张小张吃饭用缸");
    assert.equal(behaviorCase.evidence_level, "unconfirmed");
    assert.equal(behaviorCase.track, "科技ETF（具体品种未确认）");
    assert.equal(behaviorCase.action_quality, "flawed");
    assert.equal(behaviorCase.outcome_type, "profit");
    assert.equal(behaviorCase.evidence_role, "negative");
    assert.match(behaviorCase.background, /账户总额还是累计盈利尚不明确/);
    assert.match(behaviorCase.visible_information, /具体持仓、成交和净值曲线不可得/);
    assert.match(behaviorCase.pressure_context, /退出动作变成了舆论选择/);
    assert.match(behaviorCase.result, /不能证明最高点能够提前判断/);
    assert.match(behaviorCase.self_response, /后面继续上涨就接受卖飞/);
    assert.match(behaviorCase.learn_to_avoid, /总体仍盈利/);
    assert.match(behaviorCase.applicability_boundary, /金额和收益真实性不作为模式成立的前提/);
    assert.match(behaviorCase.note, /均保留为待核验口述数据/);
    assert.deepEqual(JSON.parse(behaviorCase.linked_rule_refs_json), [
      "公开表达不能替代退出纪律",
      "末端加速分批兑现，接受卖飞",
      "别人不承担我的回撤，不能替我决定仓位"
    ]);
    assert.equal(
      JSON.parse(behaviorCase.source_snapshot_json).verificationStatus,
      "unconfirmed"
    );

    const links = await db.all(
      `SELECT p.name, p.category, l.role
       FROM behavior_case_pattern_links l
       JOIN behavior_patterns p ON p.id = l.pattern_id
       WHERE l.case_id = ?
       ORDER BY CASE l.role WHEN 'primary' THEN 0 ELSE 1 END, p.name`,
      [behaviorCase.id]
    );
    assert.deepEqual(links, [
      { name: "没有退出机制", category: "execution_error", role: "primary" },
      { name: "外部评价绑架决策", category: "human_bias", role: "secondary" },
      { name: "暴涨后崩跌", category: "market_structure", role: "secondary" }
    ]);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260903_002_seed_creator_audience_pressure_exit_case"]
    );
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM behavior_cases
          WHERE title = ? AND is_deleted = 0) AS case_total,
         (SELECT COUNT(*) FROM behavior_patterns
          WHERE name = '外部评价绑架决策' AND is_deleted = 0) AS pattern_total`,
      ["小张小张吃饭用缸：粉丝评价绑架退出，盈利仍大幅回撤"]
    );
    assert.equal(Number(duplicateCheck.case_total), 1);
    assert.equal(Number(duplicateCheck.pattern_total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("seeds the Li Yien case with long-term thesis and late-entry boundaries separated", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "li-yien-long-term-boundary-case-"));
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
    const pattern = await db.get(
      `SELECT axis, category, maturity, summary, mechanism,
              counter_question, protective_action, note
       FROM behavior_patterns
       WHERE name = '长期叙事替代入场与风控' AND is_deleted = 0`
    );
    assert.ok(pattern);
    assert.equal(pattern.axis, "human");
    assert.equal(pattern.category, "human_bias");
    assert.equal(pattern.maturity, "candidate");
    assert.match(pattern.summary, /任何价格都能参与/);
    assert.match(pattern.mechanism, /低位布局者与高位跟随者/);
    assert.match(pattern.counter_question, /今天没有仓位/);
    assert.match(pattern.protective_action, /方向、价格、仓位和期限分开判断/);
    assert.match(pattern.note, /不否定长期持有本身/);

    const behaviorCase = await db.get(
      `SELECT id, origin_type, subject_alias, evidence_level, case_date,
              action_quality, outcome_type, evidence_role, source_note,
              visible_information, action_taken, result, self_response,
              learn_to_keep, learn_to_avoid, applicability_boundary,
              linked_rule_refs_json, source_snapshot_json, note
       FROM behavior_cases
       WHERE title = ? AND is_deleted = 0`,
      ["李一恩“拿着别动”：长期逻辑不能替代入场与风控"]
    );

    assert.ok(behaviorCase);
    assert.equal(behaviorCase.origin_type, "public");
    assert.equal(behaviorCase.subject_alias, "李一恩");
    assert.equal(behaviorCase.evidence_level, "second_hand");
    assert.equal(behaviorCase.case_date, "2026-07-01");
    assert.equal(behaviorCase.action_quality, "mixed");
    assert.equal(behaviorCase.outcome_type, "ongoing");
    assert.equal(behaviorCase.evidence_role, "boundary");
    assert.match(behaviorCase.source_note, /明确提示位置已高、不要追/);
    assert.match(behaviorCase.visible_information, /两组同时存在的信息/);
    assert.match(behaviorCase.action_taken, /完整公开内容其实也包含/);
    assert.match(behaviorCase.result, /长期产业判断目前不能仅凭一次回撤判定对错/);
    assert.match(behaviorCase.self_response, /末端加速后不追/);
    assert.match(behaviorCase.learn_to_keep, /保留其完整表述中/);
    assert.match(behaviorCase.learn_to_avoid, /低位成本和长期资金条件/);
    assert.match(behaviorCase.applicability_boundary, /不能把后期所有追高损失简单归责于博主/);
    assert.match(behaviorCase.note, /不把口号单独截出来定罪/);
    assert.deepEqual(JSON.parse(behaviorCase.linked_rule_refs_json), [
      "长期方向、入场价格、仓位和持有期限必须分开判断",
      "低位布局者的持有逻辑不能直接移植给高位追入者",
      "外部观点只进观察层，最终动作服从自己的体系"
    ]);
    const sourceSnapshot = JSON.parse(behaviorCase.source_snapshot_json);
    assert.equal(sourceSnapshot.verificationStatus, "partially_documented");
    assert.equal(sourceSnapshot.references.length, 4);
    assert.ok(sourceSnapshot.documentedClaims.some((item: string) => item.includes("不要追")));
    assert.ok(sourceSnapshot.unverifiedClaims.some((item: string) => item.includes("账户亏损")));

    const links = await db.all(
      `SELECT p.name, p.category, l.role
       FROM behavior_case_pattern_links l
       JOIN behavior_patterns p ON p.id = l.pattern_id
       WHERE l.case_id = ?
       ORDER BY CASE l.role WHEN 'primary' THEN 0 ELSE 1 END, p.name`,
      [behaviorCase.id]
    );
    assert.deepEqual(links, [
      { name: "追高", category: "execution_error", role: "primary" },
      { name: "FOMO（错失焦虑）", category: "human_bias", role: "secondary" },
      { name: "长期叙事替代入场与风控", category: "human_bias", role: "secondary" }
    ]);

    await db.run(
      "DELETE FROM migrations WHERE id = ?",
      ["20260903_003_seed_li_yien_long_term_narrative_boundary_case"]
    );
    await runMigrations(filename);
    const duplicateCheck = await db.get(
      `SELECT
         (SELECT COUNT(*) FROM behavior_cases
          WHERE title = ? AND is_deleted = 0) AS case_total,
         (SELECT COUNT(*) FROM behavior_patterns
          WHERE name = '长期叙事替代入场与风控' AND is_deleted = 0) AS pattern_total`,
      ["李一恩“拿着别动”：长期逻辑不能替代入场与风控"]
    );
    assert.equal(Number(duplicateCheck.case_total), 1);
    assert.equal(Number(duplicateCheck.pattern_total), 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
