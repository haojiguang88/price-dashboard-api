import getDb from "../../config/database";
import { loadSignalSettings } from "./signalAnalysisService";

/**
 * 线报监控的读取与统计层。
 *
 * 统计口径按实验要求第二十二节：重点不是采集量，而是
 *   SKU Hit Rate         命中目标 SKU / 总采集
 *   Theoretical Opportunity Rate  有理论空间 / 命中 SKU
 *   Effective Opportunity Rate    人工确认有效 / 总采集
 *   True Profit Rate      实际产生利润 / 进入人工审核
 *   Average Realized Profit
 * 全部按 origin_source（原始来源）和 collector_source（哪个采集器）两个维度分别统计。
 */

export interface SignalListFilters {
  profit_status?: string;
  match_status?: string;
  origin_source?: string;
  collector_source?: string;
  review_status?: string;
  keyword?: string;
  date_from?: string;
  date_to?: string;
  only_with_profit?: boolean;
  page?: number;
  page_size?: number;
  sort?: string;
}

const SORTABLE: Record<string, string> = {
  published_at: "published_at",
  first_seen_at: "first_seen_at",
  gross_spread: "gross_spread",
  final_buy_price: "final_buy_price",
  match_confidence: "match_confidence",
  id: "id"
};

const buildListWhere = (filters: SignalListFilters) => {
  const where: string[] = [];
  const params: unknown[] = [];

  const eq = (column: string, value?: string) => {
    if (!value) return;
    where.push(`${column} = ?`);
    params.push(value);
  };

  eq("profit_status", filters.profit_status);
  eq("match_status", filters.match_status);
  eq("origin_source", filters.origin_source);
  eq("review_status", filters.review_status);
  if (filters.only_with_profit) {
    where.push("profit_status IN ('PROFITABLE_CANDIDATE', 'HIGH_VALUE_CANDIDATE')");
  }
  if (filters.collector_source) {
    where.push("collectors_json LIKE ?");
    params.push(`%${filters.collector_source}%`);
  }
  if (filters.keyword) {
    where.push("(title LIKE ? OR content LIKE ? OR COALESCE(sku, '') LIKE ?)");
    const like = `%${filters.keyword}%`;
    params.push(like, like, like);
  }
  if (filters.date_from) {
    where.push("date(COALESCE(published_at, first_seen_at)) >= date(?)");
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    where.push("date(COALESCE(published_at, first_seen_at)) <= date(?)");
    params.push(filters.date_to);
  }

  return { where, params };
};

const LIST_COLUMNS = `
  id, origin_source, title, sku, category_name, object_name, variant_name,
  published_at, first_seen_at, last_seen_at, first_seen_source, source_count, collectors_json,
  platform, raw_price_text, final_price, final_buy_price, price_status,
  current_recycle_price, recycle_price_updated_at, recycle_source, recycle_confidence,
  gross_spread, gross_margin_rate, profit_status, match_status, match_confidence,
  execution_level, account_risk, purchase_limit, region_requirement, qualification_requirement,
  private_candidate, review_status, review_verdict, reviewed_at,
  outcome_status, actual_profit, expired_at, expiration_reason, opportunity_window_minutes,
  deal_url, url
`;

export const listSignals = async (filters: SignalListFilters) => {
  const db = await getDb();
  const pageSize = Math.min(Math.max(Number(filters.page_size) || 30, 1), 200);
  const requestedPage = Math.max(Number(filters.page) || 1, 1);
  const { where, params } = buildListWhere(filters);
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const sortColumn = SORTABLE[String(filters.sort || "gross_spread")] || "gross_spread";
  const orderSql = `ORDER BY (${sortColumn} IS NULL), ${sortColumn} DESC, id DESC`;

  const totalRow = await db.get(`SELECT COUNT(*) AS total FROM normalized_signal ${whereSql}`, params);
  const total = Number(totalRow?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);

  const rows = await db.all(
    `SELECT ${LIST_COLUMNS} FROM normalized_signal ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  );

  return {
    data: rows.map((row: any) => ({
      ...row,
      collectors: safeJsonArray(row.collectors_json),
      private_candidate: Number(row.private_candidate) === 1
    })),
    pagination: { total, page, pageSize, totalPages }
  };
};

const safeJsonArray = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const getSignalDetail = async (id: number | string) => {
  const db = await getDb();
  const signal = await db.get("SELECT * FROM normalized_signal WHERE id = ?", [id]);
  if (!signal) return null;

  // 同一事件的所有原始记录：三个采集器各自看到的原文，按发现时间排序。
  const rawSignals = await db.all(
    `SELECT id, source_key, collector_source, origin_source, external_id, title, content, url,
            published_at, first_collected_at, last_collected_at, seen_count, status, raw_data
       FROM raw_signal
      WHERE normalized_signal_id = ?
      ORDER BY first_collected_at ASC, id ASC`,
    [id]
  );

  const settings = await loadSignalSettings(db);
  return {
    ...(signal as any),
    collectors: safeJsonArray((signal as any).collectors_json),
    observations: safeJsonArray((signal as any).observations_json),
    price_detail: (() => {
      try {
        return JSON.parse(String((signal as any).price_detail_json ?? "{}"));
      } catch {
        return {};
      }
    })(),
    raw_signals: rawSignals,
    private_candidate: Number((signal as any).private_candidate) === 1,
    settings
  };
};

interface GroupStats {
  key: string;
  collected: number;
  matched: number;
  profitable: number;
  high_value: number;
  reviewed: number;
  valid: number;
  realized_profit: number;
  avg_spread: number | null;
  avg_realized_profit: number | null;
  sku_hit_rate: number;
  effective_opportunity_rate: number;
  true_profit_rate: number;
}

const emptyStats = (key: string): GroupStats => ({
  key,
  collected: 0,
  matched: 0,
  profitable: 0,
  high_value: 0,
  reviewed: 0,
  valid: 0,
  realized_profit: 0,
  avg_spread: null,
  avg_realized_profit: null,
  sku_hit_rate: 0,
  effective_opportunity_rate: 0,
  true_profit_rate: 0
});

const finalizeStats = (stats: GroupStats): GroupStats => {
  const round = (value: number) => Number(value.toFixed(4));
  stats.sku_hit_rate = stats.collected > 0 ? round(stats.matched / stats.collected) : 0;
  stats.effective_opportunity_rate = stats.collected > 0 ? round(stats.valid / stats.collected) : 0;
  stats.true_profit_rate = stats.reviewed > 0 ? round(stats.valid / stats.reviewed) : 0;
  stats.avg_spread = stats.profitable > 0
    ? Number((stats.avg_spread ?? 0).toFixed(2))
    : null;
  stats.avg_realized_profit = stats.valid > 0
    ? Number((stats.realized_profit / stats.valid).toFixed(2))
    : null;
  return stats;
};

interface LeadTimeRow {
  key: string;
  participated_events: number;
  first_by_collected: number;
  first_by_published: number;
  avg_lead_minutes: number | null;
  avg_publish_lag_minutes: number | null;
  first_rate: number;
}

const emptyLeadTime = (key: string): LeadTimeRow => ({
  key,
  participated_events: 0,
  first_by_collected: 0,
  first_by_published: 0,
  avg_lead_minutes: null,
  avg_publish_lag_minutes: null,
  first_rate: 0
});

const minutesBetween = (later: string, earlier: string): number | null => {
  const a = new Date(later).getTime();
  const b = new Date(earlier).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (a - b) / 60000;
};

/**
 * 「这条信息最早出现在哪」——实验六个问题之一。
 *
 * 只有被两个以上采集器看到的事件才有信息量（只有一个采集器时它天然是第一），
 * 所以参与统计的只有 source_count >= 2 的事件。两个口径都算：
 *   按我们抓到的时间（collected_at）：谁先抓到
 *   按原始发布时间（published_at）：谁看到的原文发布时间更早
 * 另外记录「发布 → 我们抓到」的延迟，用来判断某个来源是不是真的快。
 */
const computeLeadTime = (rows: any[]): { by_collector: LeadTimeRow[]; by_origin_source: any[] } => {
  const byCollector = new Map<string, LeadTimeRow>();
  const originAgg = new Map<string, {
    key: string;
    events: number;
    first_distribution: Record<string, number>;
    lag_sum: number;
    lag_count: number;
  }>();

  const bumpCollector = (collector: string) => {
    const row = byCollector.get(collector) ?? emptyLeadTime(collector);
    byCollector.set(collector, row);
    return row;
  };

  for (const row of rows) {
    if (Number(row.source_count) < 2) continue;
    const observations = safeJsonObservations(row.observations_json);
    if (observations.length < 2) continue;

    const collectedTimes = observations
      .map(item => item.collected_at)
      .filter((value): value is string => Boolean(value));
    if (collectedTimes.length < 2) continue;
    const earliestCollected = collectedTimes.reduce((min, value) => (value < min ? value : min));

    const publishedTimes = observations
      .map(item => item.published_at)
      .filter((value): value is string => Boolean(value));
    const earliestPublished = publishedTimes.length > 0
      ? publishedTimes.reduce((min, value) => (value < min ? value : min))
      : null;

    // 同一采集器可能有多条观测，事件内按采集器取最早的一条。
    const perCollector = new Map<string, { collected_at: string; published_at: string | null }>();
    for (const observation of observations) {
      const current = perCollector.get(observation.collector);
      if (!current || String(observation.collected_at) < current.collected_at) {
        perCollector.set(observation.collector, {
          collected_at: String(observation.collected_at),
          published_at: observation.published_at || null
        });
      }
    }

    const firstCollectors: string[] = [];
    for (const [collector, observation] of perCollector) {
      const stats = bumpCollector(collector);
      stats.participated_events += 1;

      if (observation.collected_at === earliestCollected) {
        stats.first_by_collected += 1;
        firstCollectors.push(collector);
      }
      if (earliestPublished && observation.published_at === earliestPublished) {
        stats.first_by_published += 1;
      }

      const lead = minutesBetween(observation.collected_at, earliestCollected);
      if (lead !== null) {
        stats.avg_lead_minutes = (stats.avg_lead_minutes ?? 0) + lead;
      }
      if (observation.published_at) {
        const lag = minutesBetween(observation.collected_at, observation.published_at);
        if (lag !== null) {
          stats.avg_publish_lag_minutes = (stats.avg_publish_lag_minutes ?? 0) + lag;
        }
      }
    }

    const originKey = String(row.origin_source || "未知");
    const origin = originAgg.get(originKey)
      ?? { key: originKey, events: 0, first_distribution: {}, lag_sum: 0, lag_count: 0 };
    origin.events += 1;
    for (const collector of firstCollectors) {
      origin.first_distribution[collector] = (origin.first_distribution[collector] ?? 0) + 1;
    }
    const firstLag = minutesBetween(earliestCollected, earliestPublished ?? earliestCollected);
    if (firstLag !== null) {
      origin.lag_sum += firstLag;
      origin.lag_count += 1;
    }
    originAgg.set(originKey, origin);
  }

  const byCollectorRows = [...byCollector.values()].map(row => ({
    ...row,
    avg_lead_minutes: row.participated_events > 0 && row.avg_lead_minutes !== null
      ? Number((row.avg_lead_minutes / row.participated_events).toFixed(2))
      : null,
    avg_publish_lag_minutes: row.participated_events > 0 && row.avg_publish_lag_minutes !== null
      ? Number((row.avg_publish_lag_minutes / row.participated_events).toFixed(2))
      : null,
    first_rate: row.participated_events > 0
      ? Number((row.first_by_collected / row.participated_events).toFixed(4))
      : 0
  })).sort((a, b) => b.first_rate - a.first_rate || b.participated_events - a.participated_events);

  const byOriginRows = [...originAgg.values()].map(row => ({
    key: row.key,
    events: row.events,
    first_distribution: row.first_distribution,
    avg_publish_to_collect_minutes: row.lag_count > 0 ? Number((row.lag_sum / row.lag_count).toFixed(2)) : null
  })).sort((a, b) => b.events - a.events);

  return { by_collector: byCollectorRows, by_origin_source: byOriginRows };
};

const safeJsonObservations = (value: unknown): Array<{ collector: string; collected_at: string; published_at: string | null }> => {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item === "object" && item.collector && item.collected_at)
      .map(item => ({
        collector: String(item.collector),
        collected_at: String(item.collected_at),
        published_at: item.published_at ? String(item.published_at) : null
      }));
  } catch {
    return [];
  }
};

/**
 * 来源质量评分的「原始输入」（实验第二十三节）。
 * 只把成分摆出来，不自动决定权重：先跑 2~4 周攒够数据，权重由人定。
 * 失误 = 人工判为假车/公交车/无法执行，或最终结果 INVALID。
 */
const computeSourceScoreInputs = (rows: any[]) => {
  const byCollector = new Map<string, {
    collector: string;
    collected: number;
    matched: number;
    valid: number;
    invalid: number;
    reviewed: number;
    realized_profit: number;
    lead_minutes_sum: number;
    lead_minutes_count: number;
  }>();

  for (const row of rows) {
    for (const collector of safeJsonArray(row.collectors_json)) {
      const stats = byCollector.get(collector) ?? {
        collector,
        collected: 0,
        matched: 0,
        valid: 0,
        invalid: 0,
        reviewed: 0,
        realized_profit: 0,
        lead_minutes_sum: 0,
        lead_minutes_count: 0
      };
      stats.collected += 1;
      if (row.match_status === "matched") stats.matched += 1;
      if (row.review_status === "reviewed") stats.reviewed += 1;
      const valid = row.review_verdict === "真车" || row.outcome_status === "VALID";
      const invalid = ["假车", "公交车", "无法执行"].includes(String(row.review_verdict))
        || row.outcome_status === "INVALID";
      if (valid) {
        stats.valid += 1;
        stats.realized_profit += Number(row.actual_profit) || 0;
      }
      if (invalid) stats.invalid += 1;
      byCollector.set(collector, stats);
    }
  }

  return [...byCollector.values()].map(stats => ({
    collector: stats.collector,
    collected: stats.collected,
    matched: stats.matched,
    hit_rate: stats.collected > 0 ? Number((stats.matched / stats.collected).toFixed(4)) : 0,
    reviewed: stats.reviewed,
    valid: stats.valid,
    invalid: stats.invalid,
    valid_count: stats.valid,
    realized_profit: Number(stats.realized_profit.toFixed(2)),
    miss_rate: stats.reviewed > 0 ? Number((stats.invalid / stats.reviewed).toFixed(4)) : 0,
    note: "只记录原始输入，权重由人工在跑够 2~4 周后确定"
  }));
};

/** 按维度汇总：命中率 / 有效机会率 / 真实利润率 / 平均理论空间 / 平均实际利润。 */
export const getSourceStats = async (options: { date_from?: string; date_to?: string } = {}) => {
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.date_from) {
    where.push("date(COALESCE(published_at, first_seen_at)) >= date(?)");
    params.push(options.date_from);
  }
  if (options.date_to) {
    where.push("date(COALESCE(published_at, first_seen_at)) <= date(?)");
    params.push(options.date_to);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await db.all(
    `SELECT
       origin_source,
       collectors_json,
       match_status,
       profit_status,
       review_status,
       review_verdict,
       outcome_status,
       gross_spread,
       actual_profit,
       observations_json,
       source_count,
       first_seen_source,
       published_at,
       first_seen_at
     FROM normalized_signal ${whereSql}`,
    params
  );

  const byOrigin = new Map<string, GroupStats>();
  const byCollector = new Map<string, GroupStats>();

  const bump = (map: Map<string, GroupStats>, key: string, row: any) => {
    const stats = map.get(key) ?? emptyStats(key);
    stats.collected += 1;
    if (row.match_status === "matched") stats.matched += 1;
    if (row.profit_status === "PROFITABLE_CANDIDATE") stats.profitable += 1;
    if (row.profit_status === "HIGH_VALUE_CANDIDATE") {
      stats.high_value += 1;
      stats.profitable += 1;
    }
    if (Number.isFinite(Number(row.gross_spread))) {
      stats.avg_spread = (stats.avg_spread ?? 0) + Number(row.gross_spread);
    }
    if (row.review_status === "reviewed") stats.reviewed += 1;
    const valid = row.review_verdict === "真车" || row.outcome_status === "VALID";
    if (valid) {
      stats.valid += 1;
      stats.realized_profit += Number(row.actual_profit) || 0;
    }
    map.set(key, stats);
  };

  for (const row of rows as any[]) {
    bump(byOrigin, String(row.origin_source || "未知"), row);
    for (const collector of safeJsonArray(row.collectors_json)) {
      bump(byCollector, collector, row);
    }
  }

  return {
    by_origin_source: [...byOrigin.values()].map(finalizeStats).sort((a, b) => b.collected - a.collected),
    by_collector_source: [...byCollector.values()].map(finalizeStats).sort((a, b) => b.collected - a.collected),
    lead_time: computeLeadTime(rows as any[]),
    source_score_inputs: computeSourceScoreInputs(rows as any[])
  };
};

/** 今日（或指定日期）总览：采集 → 匹配 → 有空间 → 已审核 → 有效。 */
export const getSignalOverview = async (options: { date?: string } = {}) => {
  const db = await getDb();
  const date = options.date && /^\d{4}-\d{2}-\d{2}$/.test(options.date)
    ? options.date
    : new Date().toISOString().slice(0, 10);

  const summary = await db.get(
    `SELECT
       COUNT(*) AS collected,
       SUM(CASE WHEN match_status = 'matched' THEN 1 ELSE 0 END) AS matched,
       SUM(CASE WHEN profit_status IN ('PROFITABLE_CANDIDATE','HIGH_VALUE_CANDIDATE') THEN 1 ELSE 0 END) AS profitable,
       SUM(CASE WHEN profit_status = 'HIGH_VALUE_CANDIDATE' THEN 1 ELSE 0 END) AS high_value,
       SUM(CASE WHEN review_status = 'reviewed' THEN 1 ELSE 0 END) AS reviewed,
       SUM(CASE WHEN review_verdict = '真车' OR outcome_status = 'VALID' THEN 1 ELSE 0 END) AS valid,
       SUM(COALESCE(actual_profit, 0)) AS realized_profit
     FROM normalized_signal
     WHERE date(COALESCE(published_at, first_seen_at)) = date(?)`,
    [date]
  );

  const rawToday = await db.get(
    "SELECT COUNT(*) AS raw_count FROM raw_signal WHERE date(first_collected_at) = date(?)",
    [date]
  );

  const settings = await loadSignalSettings(db);
  const collected = Number(summary?.collected || 0);
  const reviewed = Number(summary?.reviewed || 0);

  return {
    date,
    raw_collected: Number(rawToday?.raw_count || 0),
    collected,
    matched: Number(summary?.matched || 0),
    profitable: Number(summary?.profitable || 0),
    high_value: Number(summary?.high_value || 0),
    reviewed,
    valid: Number(summary?.valid || 0),
    realized_profit: Number(summary?.realized_profit || 0),
    sku_hit_rate: collected > 0 ? Number((Number(summary?.matched || 0) / collected).toFixed(4)) : 0,
    effective_opportunity_rate: collected > 0 ? Number((Number(summary?.valid || 0) / collected).toFixed(4)) : 0,
    true_profit_rate: reviewed > 0 ? Number((Number(summary?.valid || 0) / reviewed).toFixed(4)) : 0,
    settings
  };
};

/** 待人工处理的量，用于菜单角标和「该看哪里」的提示。 */
export const getReviewQueueSummary = async () => {
  const db = await getDb();
  const rows = await db.all(
    `SELECT profit_status, COUNT(*) AS n
       FROM normalized_signal
      WHERE review_status = 'pending'
        AND profit_status IN ('PROFITABLE_CANDIDATE', 'HIGH_VALUE_CANDIDATE')
      GROUP BY profit_status`
  );
  const map = new Map((rows as any[]).map(row => [row.profit_status, Number(row.n)]));
  return {
    pending_high_value: map.get("HIGH_VALUE_CANDIDATE") ?? 0,
    pending_profitable: map.get("PROFITABLE_CANDIDATE") ?? 0
  };
};

export const listSignalSources = async () => {
  const db = await getDb();
  return db.all(
    `SELECT id, source_key, name, type, base_url, enabled, collector_type, poll_interval,
            min_request_interval, priority, note, last_success_at, last_error_at, last_error_message,
            last_collected_at, consecutive_failures, disabled_reason
       FROM signal_source
      ORDER BY id`
  );
};
