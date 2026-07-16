type SearchKind = "object" | "variant" | "rule" | "plan" | "event" | "risk" | "position" | "task";

export interface GlobalSearchItem {
  record_id: string;
  entity_id: number | string;
  kind: SearchKind;
  kind_label: string;
  title: string;
  subtitle: string;
  detail: string;
  path: string;
  source_type: string;
  category_id?: number | null;
  object_id?: number | null;
  variant_id?: number | null;
  category_name?: string | null;
  object_name?: string | null;
  variant_name?: string | null;
  date?: string | null;
  updated_at?: string | null;
}

interface SearchDefinition {
  select: string;
  from: string;
  searchColumns: string[];
  baseWhere?: string;
  orderBy: string;
}

const joinedText = (...columns: string[]) => (
  `trim(${columns.map(column => `COALESCE(CAST(${column} AS TEXT), '')`).join(" || ' ' || ")})`
);

const definitions: SearchDefinition[] = [
  {
    select: `
      'object:' || o.id AS record_id, o.id AS entity_id,
      'object' AS kind, '对象' AS kind_label,
      o.name AS title, ${joinedText("c.name", "'商品价格工作台'")} AS subtitle,
      '' AS detail, '/price/workbench' AS path, 'object' AS source_type,
      c.id AS category_id, o.id AS object_id, NULL AS variant_id,
      c.name AS category_name, o.name AS object_name, '' AS variant_name,
      NULL AS date, o.updated_at AS updated_at`,
    from: `objects o JOIN categories c ON c.id = o.category_id`,
    searchColumns: ["o.name", "c.name"],
    baseWhere: "COALESCE(o.is_archived, 0) = 0 AND COALESCE(c.is_archived, 0) = 0",
    orderBy: "datetime(o.updated_at) DESC, o.id DESC"
  },
  {
    select: `
      'variant:' || v.id AS record_id, v.id AS entity_id,
      'variant' AS kind, '变体' AS kind_label,
      ${joinedText("o.name", "v.name")} AS title, ${joinedText("c.name", "'商品价格工作台'")} AS subtitle,
      substr(COALESCE(v.note, ''), 1, 240) AS detail, '/price/workbench' AS path, 'variant' AS source_type,
      c.id AS category_id, o.id AS object_id, v.id AS variant_id,
      c.name AS category_name, o.name AS object_name, v.name AS variant_name,
      NULL AS date, v.updated_at AS updated_at`,
    from: `variants v JOIN objects o ON o.id = v.object_id JOIN categories c ON c.id = o.category_id`,
    searchColumns: ["v.name", "o.name", "c.name", "v.note"],
    baseWhere: "COALESCE(v.is_archived, 0) = 0 AND COALESCE(o.is_archived, 0) = 0 AND COALESCE(c.is_archived, 0) = 0",
    orderBy: "datetime(v.updated_at) DESC, v.id DESC"
  },
  {
    select: `
      'monitor_rule:' || r.id AS record_id, r.id AS entity_id,
      'rule' AS kind, '规则' AS kind_label,
      r.rule_name AS title, ${joinedText("r.rule_code", "r.rule_type", "r.status")} AS subtitle,
      substr(${joinedText("r.action_text", "r.description")}, 1, 240) AS detail,
      '/rules/edit/' || r.id AS path, 'monitor_rule' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      NULL AS category_name, NULL AS object_name, NULL AS variant_name,
      NULL AS date, r.updated_at AS updated_at`,
    from: "monitor_rules r",
    searchColumns: ["r.rule_name", "r.rule_code", "r.rule_type", "r.action_text", "r.description"],
    orderBy: "datetime(r.updated_at) DESC, r.id DESC"
  },
  {
    select: `
      'buying_plan:' || p.id AS record_id, p.id AS entity_id,
      'plan' AS kind, '买入计划' AS kind_label,
      p.plan_name AS title, ${joinedText("p.category_name", "p.object_name", "p.variant_name")} AS subtitle,
      substr(${joinedText("p.status", "p.total_amount", "p.note")}, 1, 240) AS detail,
      '/plan/buy' AS path, 'buying_plan' AS source_type,
      c.id AS category_id, o.id AS object_id, CASE WHEN COALESCE(p.variant_name, '') = '' THEN NULL ELSE v.id END AS variant_id,
      p.category_name, p.object_name, COALESCE(p.variant_name, '') AS variant_name,
      NULL AS date, p.updated_at AS updated_at`,
    from: `buying_plans p LEFT JOIN categories c ON c.name = p.category_name LEFT JOIN objects o ON o.category_id = c.id AND o.name = p.object_name LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(p.variant_name, '')`,
    searchColumns: ["p.plan_name", "p.category_name", "p.object_name", "p.variant_name", "p.note", "p.status"],
    orderBy: "datetime(p.updated_at) DESC, p.id DESC"
  },
  {
    select: `
      'selling_plan:' || p.id AS record_id, p.id AS entity_id,
      'plan' AS kind, '卖出计划' AS kind_label,
      p.plan_name AS title, ${joinedText("p.category_name", "p.object_name", "p.variant_name")} AS subtitle,
      substr(${joinedText("p.status", "p.total_amount", "p.note")}, 1, 240) AS detail,
      '/plan/sell' AS path, 'selling_plan' AS source_type,
      c.id AS category_id, o.id AS object_id, CASE WHEN COALESCE(p.variant_name, '') = '' THEN NULL ELSE v.id END AS variant_id,
      p.category_name, p.object_name, COALESCE(p.variant_name, '') AS variant_name,
      NULL AS date, p.updated_at AS updated_at`,
    from: `selling_plans p LEFT JOIN categories c ON c.name = p.category_name LEFT JOIN objects o ON o.category_id = c.id AND o.name = p.object_name LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(p.variant_name, '')`,
    searchColumns: ["p.plan_name", "p.category_name", "p.object_name", "p.variant_name", "p.note", "p.status"],
    orderBy: "datetime(p.updated_at) DESC, p.id DESC"
  },
  {
    select: `
      'annual_plan_item:' || p.id AS record_id, p.id AS entity_id,
      'plan' AS kind, '年度计划' AS kind_label,
      ${joinedText("p.category", "p.object_name")} AS title,
      ${joinedText("p.current_role", "p.current_action", "p.current_status")} AS subtitle,
      substr(${joinedText("p.thesis", "p.note")}, 1, 240) AS detail,
      '/annual-plan' AS path, 'annual_plan_item' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      p.category AS category_name, p.object_name, '' AS variant_name,
      NULL AS date, p.updated_at AS updated_at`,
    from: "annual_plan_items p",
    searchColumns: ["p.category", "p.object_name", "p.current_role", "p.current_action", "p.current_status", "p.thesis", "p.note"],
    baseWhere: "COALESCE(p.is_deleted, 0) = 0",
    orderBy: "datetime(p.updated_at) DESC, p.id DESC"
  },
  {
    select: `
      'event:' || e.id AS record_id, e.id AS entity_id,
      'event' AS kind, '事件' AS kind_label,
      e.title, ${joinedText("e.event_date", "e.track", "e.event_type")} AS subtitle,
      substr(${joinedText("e.related_object", "e.description", "e.impact")}, 1, 240) AS detail,
      '/event-v2' AS path, 'event' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      e.track AS category_name, e.related_object AS object_name, '' AS variant_name,
      e.event_date AS date, e.updated_at AS updated_at`,
    from: "event_records e",
    searchColumns: ["e.title", "e.track", "e.event_type", "e.related_object", "e.description", "e.impact", "e.note"],
    baseWhere: "COALESCE(e.is_deleted, 0) = 0",
    orderBy: "datetime(e.updated_at) DESC, e.id DESC"
  },
  {
    select: `
      'opinion:' || o.id AS record_id, o.id AS entity_id,
      'event' AS kind, '观点' AS kind_label,
      o.title, ${joinedText("o.person_name", "o.opinion_date", "o.track")} AS subtitle,
      substr(${joinedText("o.summary_result", "o.original_opinion", "o.my_interpretation")}, 1, 240) AS detail,
      '/opinion' AS path, 'opinion' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      o.track AS category_name, o.person_name AS object_name, '' AS variant_name,
      o.opinion_date AS date, o.updated_at AS updated_at`,
    from: "opinion_records o",
    searchColumns: ["o.title", "o.person_name", "o.source_platform", "o.track", "o.summary_result", "o.original_opinion", "o.judgment_basis", "o.my_interpretation", "o.validation_result", "o.note"],
    baseWhere: "COALESCE(o.is_deleted, 0) = 0",
    orderBy: "datetime(o.updated_at) DESC, o.id DESC"
  },
  {
    select: `
      'missed_review:' || r.id AS record_id, r.id AS entity_id,
      'event' AS kind, '错过复盘' AS kind_label,
      r.title, ${joinedText("r.review_date", "r.track", "r.project_name")} AS subtitle,
      substr(${joinedText("r.summary_conclusion", "r.short_lesson", "r.extracted_lesson")}, 1, 240) AS detail,
      '/review/missed' AS path, 'missed_review' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      r.track AS category_name, r.project_name AS object_name, '' AS variant_name,
      r.review_date AS date, r.updated_at AS updated_at`,
    from: "missed_projects r",
    searchColumns: ["r.title", "r.track", "r.project_name", "r.source", "r.signal", "r.reason", "r.trend", "r.summary_conclusion", "r.short_lesson", "r.note"],
    baseWhere: "COALESCE(r.is_deleted, 0) = 0",
    orderBy: "datetime(r.updated_at) DESC, r.id DESC"
  },
  {
    select: `
      'business_review:' || r.id AS record_id, r.id AS entity_id,
      'event' AS kind, '买卖复盘' AS kind_label,
      r.title, ${joinedText("r.review_date", "r.track", "r.project_name")} AS subtitle,
      substr(${joinedText("r.summary_conclusion", "r.short_lesson", "r.extracted_lesson")}, 1, 240) AS detail,
      '/review/business' AS path, 'business_review' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      r.track AS category_name, r.project_name AS object_name, '' AS variant_name,
      r.review_date AS date, r.updated_at AS updated_at`,
    from: "business_reviews r",
    searchColumns: ["r.title", "r.track", "r.project_name", "r.summary_conclusion", "r.background", "r.later_outcome", "r.extracted_lesson", "r.short_lesson", "r.note"],
    baseWhere: "COALESCE(r.is_deleted, 0) = 0",
    orderBy: "datetime(r.updated_at) DESC, r.id DESC"
  },
  {
    select: `
      'tree_case:' || r.id AS record_id, r.id AS entity_id,
      'event' AS kind, '挂树案例' AS kind_label,
      r.title, ${joinedText("r.review_date", "r.track", "r.project_name")} AS subtitle,
      substr(${joinedText("r.summary_conclusion", "r.short_lesson", "r.extracted_lesson")}, 1, 240) AS detail,
      '/review/case' AS path, 'tree_case' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      r.track AS category_name, r.project_name AS object_name, '' AS variant_name,
      r.review_date AS date, r.updated_at AS updated_at`,
    from: "tree_hanging_cases r",
    searchColumns: ["r.title", "r.track", "r.project_name", "r.tree_type", "r.summary_conclusion", "r.background", "r.later_outcome", "r.extracted_lesson", "r.short_lesson", "r.note"],
    baseWhere: "COALESCE(r.is_deleted, 0) = 0",
    orderBy: "datetime(r.updated_at) DESC, r.id DESC"
  },
  {
    select: `
      'market_review:' || r.id AS record_id, r.id AS entity_id,
      'event' AS kind, '行情复盘' AS kind_label,
      r.title, ${joinedText("r.review_date", "r.track", "r.project_name")} AS subtitle,
      substr(${joinedText("r.summary_conclusion", "r.short_lesson", "r.market_evolution")}, 1, 240) AS detail,
      '/review/market' AS path, 'market_review' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      r.track AS category_name, r.project_name AS object_name, '' AS variant_name,
      r.review_date AS date, r.updated_at AS updated_at`,
    from: "market_reviews r",
    searchColumns: ["r.title", "r.track", "r.project_name", "r.market_type_preset", "r.market_type_custom", "r.summary_conclusion", "r.short_lesson", "r.market_evolution", "r.note"],
    baseWhere: "COALESCE(r.is_deleted, 0) = 0",
    orderBy: "datetime(r.updated_at) DESC, r.id DESC"
  },
  {
    select: `
      'rule_experience:' || r.id AS record_id, r.id AS entity_id,
      'rule' AS kind, '规则经验' AS kind_label,
      r.title, ${joinedText("r.type", "r.track", "r.source_case")} AS subtitle,
      substr(${joinedText("r.summary_conclusion", "r.core_content")}, 1, 240) AS detail,
      '/review/rule' AS path, 'rule_experience' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      r.track AS category_name, r.source_case AS object_name, '' AS variant_name,
      NULL AS date, r.updated_at AS updated_at`,
    from: "rule_experiences r",
    searchColumns: ["r.title", "r.type", "r.track", "r.source_case", "r.summary_conclusion", "r.core_content", "r.note"],
    baseWhere: "COALESCE(r.is_deleted, 0) = 0",
    orderBy: "datetime(r.updated_at) DESC, r.id DESC"
  },
  {
    select: `
      'rejected_opportunity:' || r.id AS record_id, r.id AS entity_id,
      'risk' AS kind, '风控记录' AS kind_label,
      r.title, ${joinedText("r.decision_date", "r.track", "r.project_name")} AS subtitle,
      substr(${joinedText("r.rejection_reason", "r.risk_result", "r.later_summary")}, 1, 240) AS detail,
      '/risk-control/rejected-pool' AS path, 'rejected_opportunity' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      r.track AS category_name, r.related_object AS object_name, '' AS variant_name,
      r.decision_date AS date, r.updated_at AS updated_at`,
    from: "rejected_opportunities r",
    searchColumns: ["r.title", "r.track", "r.project_name", "r.related_object", "r.rejection_reason", "r.risk_result", "r.information_snapshot", "r.risk_rules_snapshot", "r.later_summary", "r.note"],
    baseWhere: "COALESCE(r.is_deleted, 0) = 0",
    orderBy: "datetime(r.updated_at) DESC, r.id DESC"
  },
  {
    select: `
      'position:' || p.id AS record_id, p.id AS entity_id,
      'position' AS kind, '仓位' AS kind_label,
      ${joinedText("p.category_name", "p.object_name", "p.variant_name")} AS title,
      ${joinedText("'当前仓位'", "p.total_cost", "p.total_profit")} AS subtitle,
      substr(${joinedText("p.total_quantity", "p.avg_price")}, 1, 240) AS detail,
      '/positions/current' AS path, 'position' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      p.category_name, p.object_name, COALESCE(p.variant_name, '') AS variant_name,
      NULL AS date, p.updated_at AS updated_at`,
    from: "positions p",
    searchColumns: ["p.category_name", "p.object_name", "p.variant_name", "p.track"],
    orderBy: "datetime(p.updated_at) DESC, p.id DESC"
  },
  {
    select: `
      'task:' || t.id AS record_id, t.id AS entity_id,
      'task' AS kind, '任务' AS kind_label,
      t.name AS title, ${joinedText("t.domain", "t.task_type", "t.last_status")} AS subtitle,
      substr(${joinedText("t.last_message", "t.schedule_time")}, 1, 240) AS detail,
      '/business/task-center' AS path, 'task' AS source_type,
      NULL AS category_id, NULL AS object_id, NULL AS variant_id,
      NULL AS category_name, NULL AS object_name, NULL AS variant_name,
      t.last_run_at AS date, t.updated_at AS updated_at`,
    from: "task_center_tasks t",
    searchColumns: ["t.name", "t.task_key", "t.domain", "t.task_type", "t.last_status", "t.last_message"],
    baseWhere: "COALESCE(t.workspace, 'business') = 'business'",
    orderBy: "datetime(t.updated_at) DESC, t.id DESC"
  }
];

const buildTokenFilter = (columns: string[], tokenCount: number) => {
  const haystack = joinedText(...columns);
  return Array.from({ length: tokenCount }, () => `instr(lower(${haystack}), ?) > 0`).join(" AND ");
};

export const searchGlobalRecords = async (
  db: any,
  rawQuery: string,
  requestedLimit = 40
): Promise<GlobalSearchItem[]> => {
  const query = String(rawQuery || "").trim().slice(0, 120);
  if (!query) return [];
  const tokens = query.split(/\s+/).filter(Boolean).slice(0, 8).map(token => token.toLocaleLowerCase());
  const limit = Math.min(60, Math.max(1, Math.floor(requestedLimit) || 40));
  const perModuleLimit = Math.min(10, Math.max(4, Math.ceil(limit / 8)));

  const buckets: GlobalSearchItem[][] = [];
  for (const definition of definitions) {
    const conditions = [definition.baseWhere, buildTokenFilter(definition.searchColumns, tokens.length)].filter(Boolean);
    const rows = await db.all(
      `SELECT ${definition.select}
       FROM ${definition.from}
       WHERE ${conditions.join(" AND ")}
       ORDER BY ${definition.orderBy}
       LIMIT ?`,
      [...tokens, perModuleLimit]
    );
    buckets.push(rows as GlobalSearchItem[]);
  }

  const results: GlobalSearchItem[] = [];
  const seen = new Set<string>();
  for (let index = 0; results.length < limit; index += 1) {
    let found = false;
    for (const bucket of buckets) {
      const item = bucket[index];
      if (!item) continue;
      found = true;
      const key = `${item.path}::${item.record_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(item);
      if (results.length >= limit) break;
    }
    if (!found) break;
  }
  return results;
};
