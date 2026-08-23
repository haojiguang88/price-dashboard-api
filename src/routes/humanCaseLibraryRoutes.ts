import { randomUUID } from "node:crypto";
import express from "express";
import getDb, { withTransaction } from "../config/database";
import {
  normalizeHumanCaseInput,
  normalizeHumanCasePatternInput,
  parseStoredStringList,
  type HumanCasePatternLinkInput
} from "../services/humanCaseLibraryService";
import {
  HUMAN_CASE_SOURCE_TYPES,
  createHumanCaseSourceSnapshot,
  loadHumanCaseSource,
  loadHumanCaseSources,
  type HumanCaseSourceType
} from "../services/humanCaseSourceService";
import { normalizeQueryText, parsePagination, toLikePattern } from "../utils/listQuery";

const router = express.Router();

const patternSelect = `
  SELECT p.*,
         (
           SELECT COUNT(DISTINCT l.case_id)
           FROM behavior_case_pattern_links l
           JOIN behavior_cases c ON c.id = l.case_id
           WHERE l.pattern_id = p.id
             AND c.is_deleted = 0
         ) AS sample_count
         ,(
           SELECT COUNT(DISTINCT l.case_id)
           FROM behavior_case_pattern_links l
           JOIN behavior_cases c ON c.id = l.case_id
           WHERE l.pattern_id = p.id
             AND l.role = 'primary'
             AND c.is_deleted = 0
         ) AS primary_sample_count
         ,(
           SELECT COUNT(DISTINCT c.id)
           FROM behavior_case_pattern_links l
           JOIN behavior_cases c ON c.id = l.case_id
           WHERE l.pattern_id = p.id
             AND c.is_deleted = 0
             AND c.evidence_role = 'negative'
         ) AS negative_count
         ,(
           SELECT COUNT(DISTINCT c.id)
           FROM behavior_case_pattern_links l
           JOIN behavior_cases c ON c.id = l.case_id
           WHERE l.pattern_id = p.id
             AND c.is_deleted = 0
             AND c.evidence_role = 'positive'
         ) AS positive_count
         ,(
           SELECT COUNT(DISTINCT c.id)
           FROM behavior_case_pattern_links l
           JOIN behavior_cases c ON c.id = l.case_id
           WHERE l.pattern_id = p.id
             AND c.is_deleted = 0
             AND c.evidence_role = 'boundary'
         ) AS boundary_count
         ,(
           SELECT COUNT(DISTINCT NULLIF(TRIM(c.track), ''))
           FROM behavior_case_pattern_links l
           JOIN behavior_cases c ON c.id = l.case_id
           WHERE l.pattern_id = p.id
             AND c.is_deleted = 0
         ) AS track_count
         ,(
           SELECT MAX(COALESCE(NULLIF(c.case_date, ''), SUBSTR(c.created_at, 1, 10)))
           FROM behavior_case_pattern_links l
           JOIN behavior_cases c ON c.id = l.case_id
           WHERE l.pattern_id = p.id
             AND c.is_deleted = 0
         ) AS latest_case_date
         ,(
           SELECT COUNT(DISTINCT c.id)
           FROM behavior_case_pattern_links l
           JOIN behavior_cases c ON c.id = l.case_id
           WHERE l.pattern_id = p.id
             AND c.is_deleted = 0
             AND c.linked_rule_refs_json NOT IN ('', '[]')
         ) AS rule_linked_case_count
  FROM behavior_patterns p
`;

const caseSelect = `
  SELECT id, title, origin_type, subject_alias, source_note, evidence_level,
         case_date, track, project_name, background, visible_information,
         pressure_context, action_taken, result, action_quality, outcome_type,
         evidence_role,
         self_response, learn_to_keep, learn_to_avoid, applicability_boundary,
         linked_rule_refs_json, source_type, source_id, source_snapshot_json,
         pricing_analysis_json, note, created_at, updated_at
  FROM behavior_cases
`;

const parseStoredObject = (value: unknown) => {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const serializePricingAnalysis = (value: unknown) => {
  const stored = parseStoredObject(value) as Record<string, unknown>;
  const positiveNumber = (input: unknown) => {
    const number = Number(input);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  const basePrice = positiveNumber(stored.basePrice);
  const observedPriceLow = positiveNumber(stored.observedPriceLow);
  const observedPriceHigh = positiveNumber(stored.observedPriceHigh) ?? observedPriceLow;
  const multiple = (price: number | null) => (
    basePrice && price ? Math.round((price / basePrice) * 100) / 100 : null
  );

  return {
    basePriceLabel: String(stored.basePriceLabel || ""),
    basePrice,
    observedPriceLabel: String(stored.observedPriceLabel || ""),
    observedPriceLow,
    observedPriceHigh,
    priceSignalType: String(stored.priceSignalType || "unconfirmed"),
    conditionStack: Array.isArray(stored.conditionStack)
      ? stored.conditionStack.map(item => String(item)).filter(Boolean)
      : [],
    buyerBreadth: String(stored.buyerBreadth || "unknown"),
    keyBuyerDependency: String(stored.keyBuyerDependency || "unknown"),
    exitLiquidity: String(stored.exitLiquidity || "unknown"),
    verificationNote: String(stored.verificationNote || ""),
    premiumMultipleLow: multiple(observedPriceLow),
    premiumMultipleHigh: multiple(observedPriceHigh)
  };
};

const serializePattern = (row: any, linkedRuleRefs: string[] = []) => ({
  id: String(row.id),
  name: row.name,
  axis: row.axis,
  category: row.category,
  summary: row.summary || "",
  triggerPhrases: parseStoredStringList(row.trigger_phrases_json),
  observableActions: parseStoredStringList(row.observable_actions_json),
  mechanism: row.mechanism || "",
  riskChain: row.risk_chain || "",
  counterQuestion: row.counter_question || "",
  protectiveAction: row.protective_action || "",
  positiveCounterpart: row.positive_counterpart || "",
  maturity: row.maturity || "candidate",
  status: row.status,
  sortOrder: Number(row.sort_order || 0),
  note: row.note || "",
  sampleCount: Number(row.sample_count || 0),
  primarySampleCount: Number(row.primary_sample_count || 0),
  negativeCount: Number(row.negative_count || 0),
  positiveCount: Number(row.positive_count || 0),
  boundaryCount: Number(row.boundary_count || 0),
  trackCount: Number(row.track_count || 0),
  latestCaseDate: row.latest_case_date || "",
  ruleLinkedCaseCount: Number(row.rule_linked_case_count || 0),
  linkedRuleRefs,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const serializeCase = (row: any, patterns: any[] = []) => {
  const sourceSnapshot = parseStoredObject(row.source_snapshot_json) as Record<string, unknown>;
  const sourceLink = row.source_type && row.source_id
    ? {
        sourceType: row.source_type,
        sourceId: String(row.source_id),
        sourceModule: String(sourceSnapshot.sourceModule || "原始档案"),
        sourceTitle: String(sourceSnapshot.sourceTitle || ""),
        sourceDate: String(sourceSnapshot.sourceDate || ""),
        sourcePath: String(sourceSnapshot.sourcePath || "")
      }
    : null;

  return {
  id: String(row.id),
  title: row.title,
  originType: row.origin_type,
  subjectAlias: row.subject_alias || "",
  sourceNote: row.source_note || "",
  evidenceLevel: row.evidence_level,
  caseDate: row.case_date || "",
  track: row.track || "",
  projectName: row.project_name || "",
  background: row.background || "",
  visibleInformation: row.visible_information || "",
  pressureContext: row.pressure_context || "",
  actionTaken: row.action_taken || "",
  result: row.result || "",
  actionQuality: row.action_quality,
  outcomeType: row.outcome_type,
  evidenceRole: row.evidence_role || "neutral",
  selfResponse: row.self_response || "",
  learnToKeep: row.learn_to_keep || "",
  learnToAvoid: row.learn_to_avoid || "",
  applicabilityBoundary: row.applicability_boundary || "",
  linkedRuleRefs: parseStoredStringList(row.linked_rule_refs_json),
  sourceType: row.source_type || "",
  sourceId: row.source_id || "",
  sourceSnapshot,
  sourceLink,
  pricingAnalysis: serializePricingAnalysis(row.pricing_analysis_json),
  note: row.note || "",
  patterns,
  createdAt: row.created_at,
  updatedAt: row.updated_at
  };
};

const loadPatternRuleRefs = async (db: any, patternIds: number[]) => {
  const grouped = new Map<number, Set<string>>();
  if (!patternIds.length) return grouped;

  const placeholders = patternIds.map(() => "?").join(",");
  const rows = await db.all(
    `SELECT l.pattern_id, c.linked_rule_refs_json
     FROM behavior_case_pattern_links l
     JOIN behavior_cases c ON c.id = l.case_id
     WHERE l.pattern_id IN (${placeholders})
       AND c.is_deleted = 0
       AND c.linked_rule_refs_json NOT IN ('', '[]')`,
    patternIds
  );

  for (const row of rows) {
    const patternId = Number(row.pattern_id);
    const refs = grouped.get(patternId) || new Set<string>();
    for (const ruleRef of parseStoredStringList(row.linked_rule_refs_json)) refs.add(ruleRef);
    grouped.set(patternId, refs);
  }
  return grouped;
};

const loadPatternLinks = async (db: any, caseIds: number[]) => {
  const grouped = new Map<number, any[]>();
  if (!caseIds.length) return grouped;

  const placeholders = caseIds.map(() => "?").join(",");
  const rows = await db.all(
    `SELECT l.case_id, l.role, p.id, p.name, p.axis, p.category,
            p.summary, p.counter_question, p.protective_action,
            p.positive_counterpart
     FROM behavior_case_pattern_links l
     JOIN behavior_patterns p ON p.id = l.pattern_id
     WHERE l.case_id IN (${placeholders})
       AND p.is_deleted = 0
     ORDER BY CASE l.role WHEN 'primary' THEN 0 ELSE 1 END,
              p.axis,
              p.sort_order,
              p.id`,
    caseIds
  );

  for (const row of rows) {
    const caseId = Number(row.case_id);
    const current = grouped.get(caseId) || [];
    current.push({
      id: String(row.id),
      name: row.name,
      axis: row.axis,
      category: row.category,
      role: row.role,
      summary: row.summary || "",
      counterQuestion: row.counter_question || "",
      protectiveAction: row.protective_action || "",
      positiveCounterpart: row.positive_counterpart || ""
    });
    grouped.set(caseId, current);
  }

  return grouped;
};

const loadCase = async (db: any, id: number) => {
  const row = await db.get(`${caseSelect} WHERE id = ? AND is_deleted = 0`, [id]);
  if (!row) return null;
  const links = await loadPatternLinks(db, [id]);
  return serializeCase(row, links.get(id) || []);
};

const validatePatternLinks = async (
  db: any,
  links: HumanCasePatternLinkInput[]
) => {
  if (!links.length) {
    throw new Error("每条案例必须设置 1 个主决策模式");
  }
  if (links.length > 3) {
    throw new Error("每条案例最多关联 1 个主决策模式和 2 个辅助模式");
  }
  const ids = links.map(link => link.patternId);
  const placeholders = ids.map(() => "?").join(",");
  const patterns = await db.all(
    `SELECT id, axis, category
     FROM behavior_patterns
     WHERE id IN (${placeholders})
       AND is_deleted = 0
       AND status = 'active'`,
    ids
  );
  if (patterns.length !== ids.length) {
    throw new Error("存在无效、归档或已删除的关联模式");
  }

  const patternById = new Map<number, any>(
    patterns.map((pattern: any) => [Number(pattern.id), pattern])
  );
  const primaryLinks = links.filter(link => link.role === "primary");
  if (primaryLinks.length !== 1) {
    throw new Error("每条案例必须且只能设置 1 个主决策模式");
  }
  const primaryPattern = patternById.get(primaryLinks[0].patternId);
  if (!primaryPattern || !["execution_error", "positive_discipline"].includes(primaryPattern.category)) {
    throw new Error("主模式必须是错误动作或正向纪律，市场情境和心理机制只能作为辅助证据");
  }
  for (const link of links.filter(item => item.role === "secondary")) {
    const pattern = patternById.get(link.patternId);
    if (!pattern || !["market_structure", "human_bias"].includes(pattern.category)) {
      throw new Error("辅助模式只允许选择外部市场情境或内在心理机制");
    }
  }
};

const replacePatternLinks = async (
  db: any,
  caseId: number,
  links: HumanCasePatternLinkInput[],
  now: string
) => {
  await validatePatternLinks(db, links);
  await db.run("DELETE FROM behavior_case_pattern_links WHERE case_id = ?", [caseId]);
  for (const link of links) {
    await db.run(
      `INSERT INTO behavior_case_pattern_links
        (case_id, pattern_id, role, note, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      [caseId, link.patternId, link.role, now, now]
    );
  }
};

const writeAudit = async (
  db: any,
  action: string,
  target: string,
  entityId: string,
  detail: Record<string, unknown>,
  now: string
) => {
  await db.run(
    `INSERT INTO audit_logs
      (id, timestamp, module, action, target, status, detail, entity_id,
       path, domain, workspace, created_at, updated_at)
     VALUES (?, ?, '人因案例库', ?, ?, 'success', ?, ?, '/review/human-cases',
             'business', 'business', ?, ?)`,
    [
      `audit-${randomUUID()}`,
      now,
      action,
      target,
      JSON.stringify(detail),
      entityId,
      now,
      now
    ]
  );
};

router.get("/behavior-patterns", async (req, res, next) => {
  try {
    const db = await getDb();
    const axis = normalizeQueryText(req.query.axis);
    const category = normalizeQueryText(req.query.category);
    const status = normalizeQueryText(req.query.status) || "active";
    const keyword = normalizeQueryText(req.query.q);
    const where: string[] = ["p.is_deleted = 0"];
    const params: any[] = [];

    if (axis) {
      where.push("p.axis = ?");
      params.push(axis);
    }
    if (category) {
      where.push("p.category = ?");
      params.push(category);
    }
    if (status !== "all") {
      where.push("p.status = ?");
      params.push(status);
    }
    if (keyword) {
      const like = toLikePattern(keyword);
      where.push(`(
        p.name LIKE ?
        OR p.summary LIKE ?
        OR p.trigger_phrases_json LIKE ?
        OR p.observable_actions_json LIKE ?
        OR p.counter_question LIKE ?
      )`);
      params.push(like, like, like, like, like);
    }

    const rows = await db.all(
      `${patternSelect}
       WHERE ${where.join(" AND ")}
       ORDER BY p.axis, p.sort_order, p.id`,
      params
    );
    const ruleRefs = await loadPatternRuleRefs(db, rows.map((row: any) => Number(row.id)));
    return res.json({
      success: true,
      data: rows.map((row: any) => serializePattern(
        row,
        Array.from(ruleRefs.get(Number(row.id)) || [])
      )),
      message: "获取案例模式成功"
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/behavior-patterns/:id", async (req, res, next) => {
  try {
    const db = await getDb();
    const id = Number(req.params.id);
    const row = await db.get(
      `${patternSelect} WHERE p.id = ? AND p.is_deleted = 0`,
      [id]
    );
    if (!row) {
      return res.status(404).json({ success: false, message: "案例模式不存在" });
    }
    const ruleRefs = await loadPatternRuleRefs(db, [id]);
    return res.json({
      success: true,
      data: serializePattern(row, Array.from(ruleRefs.get(id) || [])),
      message: "获取案例模式成功"
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/behavior-patterns", async (req, res, next) => {
  try {
    let input;
    try {
      input = normalizeHumanCasePatternInput(req.body || {});
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "案例模式内容不合法"
      });
    }

    const data = await withTransaction(async db => {
      const now = new Date().toISOString();
      const result = await db.run(
        `INSERT INTO behavior_patterns
          (name, axis, category, summary, trigger_phrases_json, observable_actions_json,
           mechanism, risk_chain, counter_question, protective_action, positive_counterpart,
           maturity, status, sort_order, note, is_deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          input.name,
          input.axis,
          input.category,
          input.summary,
          JSON.stringify(input.triggerPhrases),
          JSON.stringify(input.observableActions),
          input.mechanism,
          input.riskChain,
          input.counterQuestion,
          input.protectiveAction,
          input.positiveCounterpart,
          input.maturity,
          input.status,
          input.sortOrder,
          input.note,
          now,
          now
        ]
      );
      await writeAudit(db, "create", input.name, String(result.lastID), {
        axis: input.axis,
        category: input.category
      }, now);
      const row = await db.get(
        `${patternSelect} WHERE p.id = ? AND p.is_deleted = 0`,
        [result.lastID]
      );
      return serializePattern(row);
    });
    return res.status(201).json({ success: true, data, message: "案例模式已创建" });
  } catch (error) {
    return next(error);
  }
});

router.put("/behavior-patterns/:id", async (req, res, next) => {
  try {
    let input;
    try {
      input = normalizeHumanCasePatternInput(req.body || {});
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "案例模式内容不合法"
      });
    }

    const id = Number(req.params.id);
    const data = await withTransaction(async db => {
      const existing = await db.get(
        "SELECT id FROM behavior_patterns WHERE id = ? AND is_deleted = 0",
        [id]
      );
      if (!existing) {
        const error = new Error("案例模式不存在") as Error & { status?: number };
        error.status = 404;
        throw error;
      }

      const now = new Date().toISOString();
      await db.run(
        `UPDATE behavior_patterns
         SET name = ?, axis = ?, category = ?, summary = ?,
             trigger_phrases_json = ?, observable_actions_json = ?,
             mechanism = ?, risk_chain = ?, counter_question = ?,
             protective_action = ?, positive_counterpart = ?, maturity = ?, status = ?,
             sort_order = ?, note = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.name,
          input.axis,
          input.category,
          input.summary,
          JSON.stringify(input.triggerPhrases),
          JSON.stringify(input.observableActions),
          input.mechanism,
          input.riskChain,
          input.counterQuestion,
          input.protectiveAction,
          input.positiveCounterpart,
          input.maturity,
          input.status,
          input.sortOrder,
          input.note,
          now,
          id
        ]
      );
      await writeAudit(db, "update", input.name, String(id), {
        axis: input.axis,
        category: input.category
      }, now);
      const row = await db.get(
        `${patternSelect} WHERE p.id = ? AND p.is_deleted = 0`,
        [id]
      );
      return serializePattern(row);
    });
    return res.json({ success: true, data, message: "案例模式已更新" });
  } catch (error) {
    return next(error);
  }
});

router.delete("/behavior-patterns/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await withTransaction(async db => {
      const existing = await db.get(
        `SELECT id, name
         FROM behavior_patterns
         WHERE id = ? AND is_deleted = 0`,
        [id]
      );
      if (!existing) {
        const error = new Error("案例模式不存在") as Error & { status?: number };
        error.status = 404;
        throw error;
      }
      const linked = await db.get(
        `SELECT COUNT(DISTINCT l.case_id) AS total
         FROM behavior_case_pattern_links l
         JOIN behavior_cases c ON c.id = l.case_id
         WHERE l.pattern_id = ? AND c.is_deleted = 0`,
        [id]
      );
      if (Number(linked?.total || 0) > 0) {
        const error = new Error("该模式仍有关联案例，请先调整关联或改为归档") as Error & { status?: number };
        error.status = 409;
        throw error;
      }

      const now = new Date().toISOString();
      await db.run(
        "UPDATE behavior_patterns SET is_deleted = 1, updated_at = ? WHERE id = ?",
        [now, id]
      );
      await writeAudit(db, "delete", existing.name, String(id), {}, now);
      return { id: String(id) };
    });
    return res.json({ success: true, data: result, message: "案例模式已删除" });
  } catch (error) {
    return next(error);
  }
});

const sourceModuleLabels: Record<HumanCaseSourceType, string> = {
  business_review: "买卖复盘",
  missed_project: "错过复盘",
  tree_case: "挂树复盘",
  market_review: "行情复盘",
  opinion_record: "观点记录"
};

router.get("/behavior-case-summary", async (_req, res, next) => {
  try {
    const db = await getDb();
    const sources = await loadHumanCaseSources(db);
    const [
      caseTotals,
      patternTotals,
      repeatedPatternTotals,
      crossDomainPatternTotals,
      ruleLinkedPatternTotals,
      matrixRows,
      topPatternRows
    ] = await Promise.all([
      db.get(`SELECT COUNT(*) AS total,
                     SUM(CASE WHEN source_type = '' OR source_id = '' THEN 1 ELSE 0 END) AS standalone_total
              FROM behavior_cases WHERE is_deleted = 0`),
      db.get(`SELECT COUNT(*) AS total,
                     SUM(CASE WHEN category = 'execution_error' THEN 1 ELSE 0 END) AS error_total,
                     SUM(CASE WHEN category = 'positive_discipline' THEN 1 ELSE 0 END) AS positive_total,
                     SUM(CASE WHEN category IN ('execution_error', 'positive_discipline') THEN 1 ELSE 0 END) AS decision_total,
                     SUM(CASE WHEN category IN ('execution_error', 'positive_discipline') AND maturity = 'candidate' THEN 1 ELSE 0 END) AS candidate_total,
                     SUM(CASE WHEN category IN ('execution_error', 'positive_discipline') AND maturity = 'recurring' THEN 1 ELSE 0 END) AS recurring_total,
                     SUM(CASE WHEN category IN ('execution_error', 'positive_discipline') AND maturity = 'stable' THEN 1 ELSE 0 END) AS stable_total,
                     SUM(CASE WHEN category IN ('execution_error', 'positive_discipline') AND maturity = 'rule_ready' THEN 1 ELSE 0 END) AS rule_ready_total
              FROM behavior_patterns
              WHERE is_deleted = 0 AND status = 'active'`),
      db.get(`SELECT COUNT(*) AS total
              FROM (
                SELECT l.pattern_id
                FROM behavior_case_pattern_links l
                JOIN behavior_cases c ON c.id = l.case_id AND c.is_deleted = 0
                JOIN behavior_patterns p ON p.id = l.pattern_id
                  AND p.is_deleted = 0 AND p.status = 'active'
                  AND p.category IN ('execution_error', 'positive_discipline')
                GROUP BY l.pattern_id
                HAVING COUNT(DISTINCT l.case_id) >= 2
              ) repeated_patterns`),
      db.get(`SELECT COUNT(*) AS total
              FROM (
                SELECT l.pattern_id
                FROM behavior_case_pattern_links l
                JOIN behavior_cases c ON c.id = l.case_id AND c.is_deleted = 0
                JOIN behavior_patterns p ON p.id = l.pattern_id
                  AND p.is_deleted = 0 AND p.status = 'active'
                  AND p.category IN ('execution_error', 'positive_discipline')
                WHERE NULLIF(TRIM(c.track), '') IS NOT NULL
                GROUP BY l.pattern_id
                HAVING COUNT(DISTINCT c.track) >= 2
              ) cross_domain_patterns`),
      db.get(`SELECT COUNT(DISTINCT p.id) AS total
              FROM behavior_patterns p
              JOIN behavior_case_pattern_links l ON l.pattern_id = p.id
              JOIN behavior_cases c ON c.id = l.case_id AND c.is_deleted = 0
              WHERE p.is_deleted = 0
                AND p.status = 'active'
                AND p.category IN ('execution_error', 'positive_discipline')
                AND c.linked_rule_refs_json NOT IN ('', '[]')`),
      db.all(`SELECT action_quality, outcome_type, COUNT(*) AS total
              FROM behavior_cases
              WHERE is_deleted = 0
              GROUP BY action_quality, outcome_type
              ORDER BY total DESC, action_quality, outcome_type`),
      db.all(`SELECT p.id, p.name, p.axis, p.category, COUNT(DISTINCT l.case_id) AS sample_count
              FROM behavior_patterns p
              JOIN behavior_case_pattern_links l ON l.pattern_id = p.id
              JOIN behavior_cases c ON c.id = l.case_id AND c.is_deleted = 0
              WHERE p.is_deleted = 0 AND p.status = 'active'
                AND p.category IN ('execution_error', 'positive_discipline')
              GROUP BY p.id, p.name, p.axis, p.category
              ORDER BY sample_count DESC, p.sort_order, p.id
              LIMIT 8`)
    ]);

    const bySource = HUMAN_CASE_SOURCE_TYPES.map(sourceType => {
      const scoped = sources.filter(source => source.sourceType === sourceType);
      return {
        sourceType,
        label: sourceModuleLabels[sourceType],
        total: scoped.length,
        linked: scoped.filter(source => source.linkedCaseId).length,
        pending: scoped.filter(source => source.readiness === "ready" && !source.linkedCaseId).length,
        observation: scoped.filter(source => source.readiness === "observation").length
      };
    });
    const readySources = sources.filter(source => source.readiness === "ready");
    const linkedSources = sources.filter(source => source.linkedCaseId);

    return res.json({
      success: true,
      data: {
        rawSourceTotal: sources.length,
        readySourceTotal: readySources.length,
        observationSourceTotal: sources.filter(source => source.readiness === "observation").length,
        distilledSourceTotal: linkedSources.length,
        pendingDistillationTotal: readySources.filter(source => !source.linkedCaseId).length,
        caseTotal: Number(caseTotals?.total || 0),
        standaloneCaseTotal: Number(caseTotals?.standalone_total || 0),
        patternTotal: Number(patternTotals?.total || 0),
        decisionPatternTotal: Number(patternTotals?.decision_total || 0),
        errorPatternTotal: Number(patternTotals?.error_total || 0),
        positivePatternTotal: Number(patternTotals?.positive_total || 0),
        candidatePatternTotal: Number(patternTotals?.candidate_total || 0),
        recurringMaturityTotal: Number(patternTotals?.recurring_total || 0),
        stablePatternTotal: Number(patternTotals?.stable_total || 0),
        ruleReadyPatternTotal: Number(patternTotals?.rule_ready_total || 0),
        repeatedPatternTotal: Number(repeatedPatternTotals?.total || 0),
        crossDomainPatternTotal: Number(crossDomainPatternTotals?.total || 0),
        ruleLinkedPatternTotal: Number(ruleLinkedPatternTotals?.total || 0),
        distillationRate: readySources.length
          ? Math.round((linkedSources.filter(source => source.readiness === "ready").length / readySources.length) * 1000) / 10
          : 0,
        bySource,
        actionOutcomeMatrix: matrixRows.map((row: any) => ({
          actionQuality: row.action_quality,
          outcomeType: row.outcome_type,
          total: Number(row.total || 0)
        })),
        topPatterns: topPatternRows.map((row: any) => ({
          id: String(row.id),
          name: row.name,
          axis: row.axis,
          category: row.category,
          sampleCount: Number(row.sample_count || 0)
        }))
      },
      message: "获取案例沉淀总览成功"
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/behavior-case-sources", async (req, res, next) => {
  try {
    const db = await getDb();
    const pagination = parsePagination(req.query.page, req.query.pageSize);
    const keyword = normalizeQueryText(req.query.q).toLowerCase();
    const sourceType = normalizeQueryText(req.query.sourceType ?? req.query.source_type);
    const readiness = normalizeQueryText(req.query.readiness);
    const linkStatus = normalizeQueryText(req.query.linkStatus ?? req.query.link_status) || "pending";
    let sources = await loadHumanCaseSources(db);

    if (sourceType) sources = sources.filter(source => source.sourceType === sourceType);
    if (readiness && readiness !== "all") {
      sources = sources.filter(source => source.readiness === readiness);
    }
    if (linkStatus === "pending") sources = sources.filter(source => !source.linkedCaseId);
    if (linkStatus === "linked") sources = sources.filter(source => Boolean(source.linkedCaseId));
    if (keyword) {
      sources = sources.filter(source => [
        source.title,
        source.sourceModule,
        source.track,
        source.projectName,
        source.summary,
        source.prefill.subjectAlias
      ].some(value => value.toLowerCase().includes(keyword)));
    }

    sources.sort((left, right) => {
      const dateCompare = right.sourceDate.localeCompare(left.sourceDate);
      if (dateCompare !== 0) return dateCompare;
      return Number(right.sourceId) - Number(left.sourceId);
    });
    const total = sources.length;
    const items = sources.slice(pagination.offset, pagination.offset + pagination.limit);

    return res.json({
      success: true,
      data: {
        items,
        total,
        page: pagination.page,
        pageSize: pagination.pageSize
      },
      message: "获取待提炼来源成功"
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/behavior-case-sources/:sourceType/:sourceId", async (req, res, next) => {
  try {
    const db = await getDb();
    const source = await loadHumanCaseSource(db, req.params.sourceType, req.params.sourceId);
    if (!source) {
      return res.status(404).json({ success: false, message: "原始档案不存在" });
    }
    return res.json({ success: true, data: source, message: "获取原始档案成功" });
  } catch (error) {
    return next(error);
  }
});

router.get("/behavior-cases", async (req, res, next) => {
  try {
    const db = await getDb();
    const pagination = parsePagination(req.query.page, req.query.pageSize);
    const keyword = normalizeQueryText(req.query.q);
    const originType = normalizeQueryText(req.query.originType ?? req.query.origin_type);
    const actionQuality = normalizeQueryText(req.query.actionQuality ?? req.query.action_quality);
    const outcomeType = normalizeQueryText(req.query.outcomeType ?? req.query.outcome_type);
    const evidenceRole = normalizeQueryText(req.query.evidenceRole ?? req.query.evidence_role);
    const patternId = Number(normalizeQueryText(req.query.patternId ?? req.query.pattern_id));
    const where: string[] = ["c.is_deleted = 0"];
    const params: any[] = [];

    if (keyword) {
      const like = toLikePattern(keyword);
      where.push(`(
        c.title LIKE ?
        OR c.subject_alias LIKE ?
        OR c.track LIKE ?
        OR c.project_name LIKE ?
        OR c.background LIKE ?
        OR c.action_taken LIKE ?
        OR c.self_response LIKE ?
        OR c.pricing_analysis_json LIKE ?
      )`);
      params.push(like, like, like, like, like, like, like, like);
    }
    if (originType) {
      where.push("c.origin_type = ?");
      params.push(originType);
    }
    if (actionQuality) {
      where.push("c.action_quality = ?");
      params.push(actionQuality);
    }
    if (outcomeType) {
      where.push("c.outcome_type = ?");
      params.push(outcomeType);
    }
    if (evidenceRole) {
      where.push("c.evidence_role = ?");
      params.push(evidenceRole);
    }
    if (Number.isInteger(patternId) && patternId > 0) {
      where.push(`EXISTS (
        SELECT 1
        FROM behavior_case_pattern_links filter_link
        WHERE filter_link.case_id = c.id
          AND filter_link.pattern_id = ?
      )`);
      params.push(patternId);
    }

    const whereClause = where.join(" AND ");
    const totalRow = await db.get(
      `SELECT COUNT(*) AS total FROM behavior_cases c WHERE ${whereClause}`,
      params
    );
    const rows = await db.all(
      `${caseSelect.replace("FROM behavior_cases", "FROM behavior_cases c")}
       WHERE ${whereClause}
       ORDER BY CASE WHEN c.case_date IS NULL OR c.case_date = '' THEN 1 ELSE 0 END,
                c.case_date DESC,
                c.updated_at DESC,
                c.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pagination.limit, pagination.offset]
    );
    const ids = rows.map((row: any) => Number(row.id));
    const links = await loadPatternLinks(db, ids);
    return res.json({
      success: true,
      data: {
        items: rows.map((row: any) => serializeCase(row, links.get(Number(row.id)) || [])),
        total: Number(totalRow?.total || 0),
        page: pagination.page,
        pageSize: pagination.pageSize
      },
      message: "获取人因案例成功"
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/behavior-cases/:id", async (req, res, next) => {
  try {
    const db = await getDb();
    const id = Number(req.params.id);
    const data = await loadCase(db, id);
    if (!data) {
      return res.status(404).json({ success: false, message: "人因案例不存在" });
    }
    return res.json({ success: true, data, message: "获取人因案例成功" });
  } catch (error) {
    return next(error);
  }
});

router.post("/behavior-cases", async (req, res, next) => {
  try {
    let input;
    try {
      input = normalizeHumanCaseInput(req.body || {});
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "人因案例内容不合法"
      });
    }

    const data = await withTransaction(async db => {
      const now = new Date().toISOString();
      let sourceSnapshotJson = "{}";
      if (input.sourceType && input.sourceId) {
        const source = await loadHumanCaseSource(db, input.sourceType, input.sourceId);
        if (!source) {
          const error = new Error("关联的原始档案不存在") as Error & { status?: number };
          error.status = 404;
          throw error;
        }
        if (source.readiness !== "ready") {
          const error = new Error("该观点仍在观察层，完成验证后才能提炼为案例") as Error & { status?: number };
          error.status = 409;
          throw error;
        }
        if (source.linkedCaseId) {
          const error = new Error(`该原始档案已提炼为案例「${source.linkedCaseTitle}」`) as Error & { status?: number };
          error.status = 409;
          throw error;
        }
        sourceSnapshotJson = JSON.stringify(createHumanCaseSourceSnapshot(source));
      }
      const result = await db.run(
        `INSERT INTO behavior_cases
          (title, origin_type, subject_alias, source_note, evidence_level, case_date,
           track, project_name, background, visible_information, pressure_context,
           action_taken, result, action_quality, outcome_type, evidence_role, self_response,
           learn_to_keep, learn_to_avoid, applicability_boundary, linked_rule_refs_json,
           source_type, source_id, source_snapshot_json, pricing_analysis_json, note,
           is_deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          input.title,
          input.originType,
          input.subjectAlias,
          input.sourceNote,
          input.evidenceLevel,
          input.caseDate || null,
          input.track,
          input.projectName,
          input.background,
          input.visibleInformation,
          input.pressureContext,
          input.actionTaken,
          input.result,
          input.actionQuality,
          input.outcomeType,
          input.evidenceRole,
          input.selfResponse,
          input.learnToKeep,
          input.learnToAvoid,
          input.applicabilityBoundary,
          JSON.stringify(input.linkedRuleRefs),
          input.sourceType,
          input.sourceId,
          sourceSnapshotJson,
          JSON.stringify(input.pricingAnalysis),
          input.note,
          now,
          now
        ]
      );
      const caseId = Number(result.lastID);
      await replacePatternLinks(db, caseId, input.patternLinks, now);
      await writeAudit(db, "create", input.title, String(caseId), {
        originType: input.originType,
        actionQuality: input.actionQuality,
        outcomeType: input.outcomeType,
        patternIds: input.patternLinks.map(link => link.patternId),
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        hasPricingAnalysis: Boolean(
          input.pricingAnalysis.basePrice
          || input.pricingAnalysis.observedPriceLow
          || input.pricingAnalysis.conditionStack.length
        )
      }, now);
      const created = await loadCase(db, caseId);
      if (!created) throw new Error("案例保存后读取失败");
      return created;
    });
    return res.status(201).json({ success: true, data, message: "人因案例已保存" });
  } catch (error) {
    return next(error);
  }
});

router.put("/behavior-cases/:id", async (req, res, next) => {
  try {
    let input;
    try {
      input = normalizeHumanCaseInput(req.body || {});
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "人因案例内容不合法"
      });
    }

    const id = Number(req.params.id);
    const data = await withTransaction(async db => {
      const existing = await db.get(
        "SELECT id, source_type, source_id FROM behavior_cases WHERE id = ? AND is_deleted = 0",
        [id]
      );
      if (!existing) {
        const error = new Error("人因案例不存在") as Error & { status?: number };
        error.status = 404;
        throw error;
      }
      if (
        String(existing.source_type || "") !== input.sourceType
        || String(existing.source_id || "") !== input.sourceId
      ) {
        const error = new Error("案例来源在创建后不可改绑，请从对应原始档案重新提炼") as Error & { status?: number };
        error.status = 409;
        throw error;
      }

      const now = new Date().toISOString();
      await db.run(
        `UPDATE behavior_cases
         SET title = ?, origin_type = ?, subject_alias = ?, source_note = ?,
             evidence_level = ?, case_date = ?, track = ?, project_name = ?,
             background = ?, visible_information = ?, pressure_context = ?,
             action_taken = ?, result = ?, action_quality = ?, outcome_type = ?, evidence_role = ?,
             self_response = ?, learn_to_keep = ?, learn_to_avoid = ?,
             applicability_boundary = ?, linked_rule_refs_json = ?,
             source_type = ?, source_id = ?, pricing_analysis_json = ?, note = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.title,
          input.originType,
          input.subjectAlias,
          input.sourceNote,
          input.evidenceLevel,
          input.caseDate || null,
          input.track,
          input.projectName,
          input.background,
          input.visibleInformation,
          input.pressureContext,
          input.actionTaken,
          input.result,
          input.actionQuality,
          input.outcomeType,
          input.evidenceRole,
          input.selfResponse,
          input.learnToKeep,
          input.learnToAvoid,
          input.applicabilityBoundary,
          JSON.stringify(input.linkedRuleRefs),
          input.sourceType,
          input.sourceId,
          JSON.stringify(input.pricingAnalysis),
          input.note,
          now,
          id
        ]
      );
      await replacePatternLinks(db, id, input.patternLinks, now);
      await writeAudit(db, "update", input.title, String(id), {
        originType: input.originType,
        actionQuality: input.actionQuality,
        outcomeType: input.outcomeType,
        patternIds: input.patternLinks.map(link => link.patternId),
        hasPricingAnalysis: Boolean(
          input.pricingAnalysis.basePrice
          || input.pricingAnalysis.observedPriceLow
          || input.pricingAnalysis.conditionStack.length
        )
      }, now);
      const updated = await loadCase(db, id);
      if (!updated) throw new Error("案例更新后读取失败");
      return updated;
    });
    return res.json({ success: true, data, message: "人因案例已更新" });
  } catch (error) {
    return next(error);
  }
});

router.delete("/behavior-cases/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await withTransaction(async db => {
      const existing = await db.get(
        "SELECT id, title FROM behavior_cases WHERE id = ? AND is_deleted = 0",
        [id]
      );
      if (!existing) {
        const error = new Error("人因案例不存在") as Error & { status?: number };
        error.status = 404;
        throw error;
      }
      const now = new Date().toISOString();
      await db.run(
        "UPDATE behavior_cases SET is_deleted = 1, updated_at = ? WHERE id = ?",
        [now, id]
      );
      await writeAudit(db, "delete", existing.title, String(id), {}, now);
      return { id: String(id) };
    });
    return res.json({ success: true, data: result, message: "人因案例已删除" });
  } catch (error) {
    return next(error);
  }
});

export default router;
