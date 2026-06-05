import express from "express";
import getDb from "../config/database";
import { normalizeQueryText } from "../utils/listQuery";

const router = express.Router();

type EvidenceGroupKey = "discipline" | "historicalEvents" | "missedReviews" | "opinions" | "relatedCases";

interface EvidenceQuery {
  table: string;
  group: EvidenceGroupKey;
  module: string;
  dateColumn?: string;
  columns: string[];
  summaryColumns: string[];
  sourceColumn?: string;
  orderBy: string;
  pathPrefix: string;
}

const defaultMetalTerms = ["白银", "银价", "贵金属", "黄金"];
const sellPlanTerms = ["暴涨", "暴跌", "出货", "卖", "减仓", "止盈", "底仓", "波段", "错过", "飞刀", "利润"];
const metalDomainTerms = ["白银", "银价", "贵金属", "黄金", "金银", "实物银"];
const unrelatedBusinessTerms = ["泡泡玛特", "MOKOKO", "LABUBU", "labubu", "游戏机", "苹果", "茅台", "宝可梦", "大疆", "PS5"];
const genericSellDisciplineTerms = [
  "暴涨必须出货",
  "暴跌不是机会",
  "拉高出货",
  "先锁利润",
  "底仓",
  "波段",
  "飞刀",
  "止盈",
  "利润优先",
  "退出预案",
  "路径不稳"
];

const evidenceQueries: EvidenceQuery[] = [
  {
    table: "rule_experiences",
    group: "discipline",
    module: "规则经验",
    columns: ["title", "track", "type", "source_case", "core_content", "summary_conclusion", "note"],
    summaryColumns: ["summary_conclusion", "core_content", "note"],
    sourceColumn: "source_case",
    orderBy: "updated_at DESC, created_at DESC, id DESC",
    pathPrefix: "/review/rule"
  },
  {
    table: "event_records",
    group: "historicalEvents",
    module: "事件记录",
    dateColumn: "event_date",
    columns: ["title", "track", "event_type", "description", "related_object", "impact", "source", "note"],
    summaryColumns: ["impact", "description", "note"],
    sourceColumn: "source",
    orderBy: "event_date DESC, updated_at DESC, id DESC",
    pathPrefix: "/event-v2"
  },
  {
    table: "missed_projects",
    group: "missedReviews",
    module: "错过复盘",
    dateColumn: "review_date",
    columns: ["title", "track", "project_name", "source", "miss_type", "signal", "reason", "trend", "exposed_problem", "extracted_lesson", "summary_conclusion", "short_lesson", "note"],
    summaryColumns: ["summary_conclusion", "extracted_lesson", "short_lesson", "trend", "reason"],
    sourceColumn: "source",
    orderBy: "review_date DESC, updated_at DESC, id DESC",
    pathPrefix: "/review/missed"
  },
  {
    table: "opinion_records",
    group: "opinions",
    module: "观点记录",
    dateColumn: "opinion_date",
    columns: ["title", "track", "person_name", "source_platform", "validation_status", "summary_result", "original_opinion", "my_interpretation", "validation_result", "person_observation", "note"],
    summaryColumns: ["summary_result", "my_interpretation", "validation_result", "original_opinion", "note"],
    sourceColumn: "person_name",
    orderBy: "opinion_date DESC, updated_at DESC, id DESC",
    pathPrefix: "/opinion"
  },
  {
    table: "business_reviews",
    group: "relatedCases",
    module: "买卖复盘",
    dateColumn: "review_date",
    columns: ["title", "track", "project_name", "result_type", "summary_conclusion", "background", "judgment_at_that_time", "action_at_that_time", "later_outcome", "exposed_problem", "extracted_lesson", "short_lesson", "note"],
    summaryColumns: ["summary_conclusion", "extracted_lesson", "short_lesson", "background"],
    orderBy: "review_date DESC, updated_at DESC, id DESC",
    pathPrefix: "/review/business"
  },
  {
    table: "market_reviews",
    group: "relatedCases",
    module: "行情复盘",
    dateColumn: "review_date",
    columns: ["title", "track", "project_name", "market_type_preset", "market_type_custom", "summary_conclusion", "short_lesson", "background", "market_start", "market_evolution", "key_turning_points", "later_outcome", "exposed_problem", "extracted_lesson", "note"],
    summaryColumns: ["summary_conclusion", "short_lesson", "extracted_lesson", "market_evolution"],
    orderBy: "review_date DESC, updated_at DESC, id DESC",
    pathPrefix: "/cognition"
  },
  {
    table: "tree_hanging_cases",
    group: "relatedCases",
    module: "挂树案例",
    dateColumn: "review_date",
    columns: ["title", "track", "project_name", "tree_type", "summary_conclusion", "background", "judgment_at_that_time", "action_at_that_time", "later_outcome", "exposed_problem", "extracted_lesson", "short_lesson", "note"],
    summaryColumns: ["summary_conclusion", "extracted_lesson", "short_lesson", "later_outcome"],
    orderBy: "review_date DESC, updated_at DESC, id DESC",
    pathPrefix: "/cognition"
  }
];

const compactText = (value: unknown, maxLength = 180): string => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
};

const unique = (items: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  items.forEach((item) => {
    const text = normalizeQueryText(item);
    if (!text || seen.has(text)) return;
    seen.add(text);
    result.push(text);
  });
  return result;
};

const buildTerms = (keyword: string, scene: string, track = ""): string[] => {
  const rawTerms = keyword
    .split(/[,\s，、/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const terms = rawTerms.length > 0 ? rawTerms : defaultMetalTerms;
  if (track) {
    terms.push(track);
  }
  if (terms.some((term) => term.includes("白银") || term.includes("银价") || term.includes("贵金属"))) {
    terms.push(...defaultMetalTerms);
  }
  if (scene === "sell_plan") {
    terms.push(...sellPlanTerms);
  }
  return unique(terms);
};

const buildMatchWhere = (query: EvidenceQuery, terms: string[], track: string) => {
  const params: string[] = [];
  const searchParams: string[] = [];
  const searchParts = terms.map((term) => {
    const columnParts = query.columns.map((column) => `IFNULL(${column}, '') LIKE ?`);
    searchParams.push(...query.columns.map(() => `%${term}%`));
    return `(${columnParts.join(" OR ")})`;
  });

  const whereParts = ["is_deleted = 0"];
  if (searchParts.length > 0) {
    whereParts.push(`(${searchParts.join(" OR ")})`);
    params.push(...searchParams);
  }

  return {
    whereSql: whereParts.join(" AND "),
    params
  };
};

const pickSummary = (row: Record<string, unknown>, columns: string[]): string => {
  for (const column of columns) {
    const text = compactText(row[column]);
    if (text) return text;
  }
  return "";
};

const scoreRow = (row: Record<string, unknown>, query: EvidenceQuery, terms: string[], scene: string, track: string): number => {
  const title = String(row.title || "");
  const text = query.columns.map((column) => String(row[column] || "")).join(" ");
  const rowTrack = String(row.track || "");
  let score = 0;
  terms.forEach((term) => {
    if (!term) return;
    if (title.includes(term)) score += 5;
    if (text.includes(term)) score += 1;
  });
  if (scene === "sell_plan") {
    sellPlanTerms.forEach((term) => {
      if (title.includes(term)) score += 4;
      if (text.includes(term)) score += 2;
    });
    genericSellDisciplineTerms.forEach((term) => {
      if (title.includes(term)) score += 8;
      if (text.includes(term)) score += 3;
    });
  }
  if (query.group === "discipline") score += 6;
  if (query.group === "missedReviews") score += 4;
  if (query.group === "historicalEvents") score += 2;
  if (track && rowTrack.includes(track)) score += 3;
  return score;
};

const includesAny = (text: string, terms: string[]): boolean => terms.some((term) => text.includes(term));

const isRelevantForKeyword = (row: Record<string, unknown>, query: EvidenceQuery, keyword: string, scene: string): boolean => {
  if (!keyword.includes("白银") && !keyword.includes("银价")) return true;
  const text = query.columns.map((column) => String(row[column] || "")).join(" ");
  const hasMetalDomain = includesAny(text, metalDomainTerms);
  if (hasMetalDomain) return true;
  if (query.group === "discipline" && scene === "sell_plan") {
    return includesAny(text, genericSellDisciplineTerms) && !includesAny(text, unrelatedBusinessTerms);
  }
  return false;
};

router.get("/cognition/evidence", async (req, res) => {
  try {
    const db = await getDb();
    const track = normalizeQueryText(req.query.track);
    const keyword = normalizeQueryText(req.query.keyword || "白银");
    const scene = normalizeQueryText(req.query.scene || "general");
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 12);
    const terms = buildTerms(keyword, scene, track);

    const grouped: Record<EvidenceGroupKey, any[]> = {
      discipline: [],
      historicalEvents: [],
      missedReviews: [],
      opinions: [],
      relatedCases: []
    };

    for (const query of evidenceQueries) {
      const selectedColumns = [
        "id",
        "title",
        "track",
        query.dateColumn ? `${query.dateColumn} AS evidence_date` : "created_at AS evidence_date",
        query.sourceColumn ? `${query.sourceColumn} AS evidence_source` : "'' AS evidence_source",
        ...query.columns.filter((column) => !["title", "track"].includes(column))
      ];
      const { whereSql, params } = buildMatchWhere(query, terms, track);
      const candidateLimit = query.group === "discipline" ? 120 : limit * 8;
      const rows = await db.all(
        `SELECT ${selectedColumns.join(", ")}
         FROM ${query.table}
         WHERE ${whereSql}
         ORDER BY ${query.orderBy}
         LIMIT ?`,
        [...params, candidateLimit]
      );

      grouped[query.group].push(...rows
        .filter((row: Record<string, unknown>) => isRelevantForKeyword(row, query, keyword, scene))
        .map((row: Record<string, unknown>) => ({
          id: row.id,
          module: query.module,
          title: row.title,
          track: row.track,
          date: row.evidence_date,
          source: row.evidence_source,
          summary: pickSummary(row, query.summaryColumns),
          score: scoreRow(row, query, terms, scene, track),
          match_reason: scene === "sell_plan" ? "按白银卖出计划场景自动匹配" : "按关键词自动匹配",
          path: `${query.pathPrefix}?focusId=${row.id}`
        })));
    }

    Object.keys(grouped).forEach((key) => {
      const groupKey = key as EvidenceGroupKey;
      grouped[groupKey] = grouped[groupKey]
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, limit)
        .map(({ score, ...item }) => item);
    });

    const total = Object.values(grouped).reduce((sum, items) => sum + items.length, 0);

    res.json({
      success: true,
      data: {
        scene,
        track,
        keyword,
        terms,
        match_mode: "rule_based_auto_recall",
        match_note: "系统按赛道、关键词和场景纪律自动召回；结果只作为认知依据，不直接给买卖许可。",
        groups: grouped,
        total
      }
    });
  } catch (error) {
    console.error("Error fetching cognition evidence:", error);
    res.status(500).json({ success: false, message: "获取认知依据失败" });
  }
});

export default router;
