import express from "express";
import getDb from "../config/database";
import { isValidDateOnly } from "../utils/dateValidation";

const router = express.Router();

interface PriceRecordRow {
  id: number;
  date: string;
  category: string;
  object_name: string;
  variant: string;
  price: number;
  source: string | null;
  note: string | null;
  category_id: number | null;
  object_id: number | null;
  variant_id: number | null;
}

interface SeriesStats {
  label: string;
  category_name: string;
  object_name: string;
  variant_name: string;
  category_id: number | null;
  object_id: number | null;
  variant_id: number | null;
  record_count: number;
  first_date: string;
  first_price: number;
  current_date: string;
  current_price: number;
  previous_date: string | null;
  previous_price: number | null;
  change_amount: number | null;
  change_percent: number | null;
  period_start_date: string | null;
  period_start_price: number | null;
  period_change_amount: number | null;
  period_change_percent: number | null;
  min_price: number;
  min_date: string;
  max_price: number;
  max_date: string;
  drawdown_percent: number;
  from_first_percent: number;
  historical_high_break_percent: number | null;
  historical_low_break_percent: number | null;
  days_since_latest: number;
  source: string | null;
  note: string | null;
}

interface JumpInsight {
  label: string;
  category_name: string;
  object_name: string;
  variant_name: string;
  category_id: number | null;
  object_id: number | null;
  variant_id: number | null;
  from_date: string;
  to_date: string;
  from_price: number;
  to_price: number;
  change_amount: number;
  change_percent: number;
  source: string | null;
  note: string | null;
}

interface PriceAnomalyWarning {
  code: string;
  severity: "warning";
  message: string;
  baseline_date?: string;
  baseline_price?: number;
  median_price?: number;
  change_percent?: number;
}

type PriceQualityAlertSeverity = "critical" | "warning";
type PriceQualityAlertStatus = "pending" | "ignored" | "fixed";

interface PriceQualityAlert {
  alert_key: string;
  record_id: number;
  date: string;
  category_name: string;
  object_name: string;
  variant_name: string;
  category_id: number | null;
  object_id: number | null;
  variant_id: number | null;
  price: number;
  alert_type: string;
  severity: PriceQualityAlertSeverity;
  message: string;
  basis: Record<string, unknown>;
  status: PriceQualityAlertStatus;
  review_note: string | null;
  reviewed_at: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LARGE_PRICE_MOVE_PERCENT = 30;
const MEDIAN_OUTLIER_RATIO = 0.5;
const ISOLATED_NEIGHBOR_CLOSE_PERCENT = 15;
const VALID_QUALITY_ALERT_STATUSES = new Set<PriceQualityAlertStatus>(["pending", "ignored", "fixed"]);

const toTrimmedText = (value: unknown) => (
  value === undefined || value === null ? '' : String(value).trim()
);

const toDateValue = (date: string) => new Date(`${date}T00:00:00`).getTime();

const daysBetween = (fromDate: string, toDate: string) => {
  return Math.round((toDateValue(toDate) - toDateValue(fromDate)) / DAY_MS);
};

const roundNumber = (value: number, digits = 2) => {
  return Number(value.toFixed(digits));
};

const roundNullable = (value: number | null, digits = 2) => {
  return value === null || !Number.isFinite(value) ? null : roundNumber(value, digits);
};

const percentChange = (current: number, previous: number) => {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
};

const medianNumber = (values: number[]) => {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
};

const getSeriesKey = (record: PriceRecordRow) => {
  return [record.category, record.object_name, record.variant || ''].join('|');
};

const buildSeriesLabel = (record: PriceRecordRow) => {
  return [record.category, record.object_name, record.variant].filter(Boolean).join(' / ');
};

const hashString = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const toInsightItem = (item: SeriesStats) => ({
  ...item,
  first_price: roundNumber(item.first_price),
  current_price: roundNumber(item.current_price),
  previous_price: item.previous_price === null ? null : roundNumber(item.previous_price),
  change_amount: roundNullable(item.change_amount),
  change_percent: roundNullable(item.change_percent),
  period_start_price: item.period_start_price === null ? null : roundNumber(item.period_start_price),
  period_change_amount: roundNullable(item.period_change_amount),
  period_change_percent: roundNullable(item.period_change_percent),
  min_price: roundNumber(item.min_price),
  max_price: roundNumber(item.max_price),
  drawdown_percent: roundNumber(item.drawdown_percent),
  from_first_percent: roundNumber(item.from_first_percent)
});

const toJumpInsightItem = (item: JumpInsight) => ({
  ...item,
  from_price: roundNumber(item.from_price),
  to_price: roundNumber(item.to_price),
  change_amount: roundNumber(item.change_amount),
  change_percent: roundNumber(item.change_percent)
});

const getTargetIdMaps = async (db: any) => {
  const categories = await db.all('SELECT id, name, COALESCE(is_archived, 0) AS is_archived FROM categories');
  const objects = await db.all('SELECT id, category_id, name, COALESCE(is_archived, 0) AS is_archived FROM objects');
  const variants = await db.all('SELECT id, object_id, name, COALESCE(is_archived, 0) AS is_archived FROM variants');

  const categoryIds = new Map<string, number>();
  const objectIds = new Map<string, number>();
  const variantIds = new Map<string, number>();
  const archivedCategories = new Set<string>();
  const archivedObjects = new Set<string>();
  const archivedVariants = new Set<string>();

  categories.forEach((category: any) => {
    categoryIds.set(category.name, category.id);
    if (Number(category.is_archived) === 1) {
      archivedCategories.add(category.name);
    }
  });

  objects.forEach((object: any) => {
    objectIds.set(`${object.category_id}|${object.name}`, object.id);
    if (Number(object.is_archived) === 1) {
      archivedObjects.add(`${object.category_id}|${object.name}`);
    }
  });

  variants.forEach((variant: any) => {
    variantIds.set(`${variant.object_id}|${variant.name}`, variant.id);
    if (Number(variant.is_archived) === 1) {
      archivedVariants.add(`${variant.object_id}|${variant.name}`);
    }
  });

  return { categoryIds, objectIds, variantIds, archivedCategories, archivedObjects, archivedVariants };
};

const isArchivedPriceRecord = (record: PriceRecordRow, maps: Awaited<ReturnType<typeof getTargetIdMaps>>) => {
  if (maps.archivedCategories.has(record.category)) return true;
  const categoryId = maps.categoryIds.get(record.category);
  if (!categoryId) return false;
  if (maps.archivedObjects.has(`${categoryId}|${record.object_name}`)) return true;
  const objectId = maps.objectIds.get(`${categoryId}|${record.object_name}`);
  if (!objectId || !record.variant) return false;
  return maps.archivedVariants.has(`${objectId}|${record.variant}`);
};

const ensurePriceQualityAlertReviewTable = async (db: any) => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS price_quality_alert_reviews (
      alert_key TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_price_quality_alert_reviews_status
      ON price_quality_alert_reviews(status, updated_at DESC);
  `);
};

const loadActivePriceRows = async (db: any): Promise<PriceRecordRow[]> => {
  const maps = await getTargetIdMaps(db);
  const { categoryIds, objectIds, variantIds } = maps;
  const rows = await db.all(`
    SELECT
      id,
      date,
      category,
      object_name,
      COALESCE(variant, '') AS variant,
      CAST(price AS REAL) AS price,
      source,
      note
    FROM price_records
    WHERE date IS NOT NULL AND price IS NOT NULL
    ORDER BY category, object_name, variant, date ASC, created_at ASC, id ASC
  `);

  return rows
    .map((row: any) => {
      const categoryId = categoryIds.get(row.category) || null;
      const objectId = categoryId ? objectIds.get(`${categoryId}|${row.object_name}`) || null : null;
      const variantId = objectId && row.variant ? variantIds.get(`${objectId}|${row.variant}`) || null : null;

      return {
        id: Number(row.id),
        date: String(row.date || '').slice(0, 10),
        category: String(row.category || '').trim(),
        object_name: String(row.object_name || '').trim(),
        variant: String(row.variant || '').trim(),
        price: Number(row.price),
        source: row.source || null,
        note: row.note || null,
        category_id: categoryId,
        object_id: objectId,
        variant_id: variantId
      };
    })
    .filter((row: PriceRecordRow) => row.date && row.category && row.object_name && Number.isFinite(row.price))
    .filter((row: PriceRecordRow) => !isArchivedPriceRecord(row, maps));
};

const createQualityAlertKey = (
  record: PriceRecordRow,
  alertType: string,
  basis: Record<string, unknown>
) => {
  const source = JSON.stringify({
    record_id: record.id,
    date: record.date,
    price: roundNumber(record.price),
    alert_type: alertType,
    basis
  });
  return `pqa_${hashString(source)}`;
};

const createQualityAlert = (
  record: PriceRecordRow,
  alertType: string,
  severity: PriceQualityAlertSeverity,
  message: string,
  basis: Record<string, unknown>
): PriceQualityAlert => ({
  alert_key: createQualityAlertKey(record, alertType, basis),
  record_id: record.id,
  date: record.date,
  category_name: record.category,
  object_name: record.object_name,
  variant_name: record.variant || '',
  category_id: record.category_id,
  object_id: record.object_id,
  variant_id: record.variant_id,
  price: roundNumber(record.price),
  alert_type: alertType,
  severity,
  message,
  basis,
  status: "pending",
  review_note: null,
  reviewed_at: null
});

const loadQualityAlertReviews = async (
  db: any,
  alertKeys: string[]
): Promise<Map<string, any>> => {
  const reviews = new Map<string, any>();
  if (alertKeys.length === 0) return reviews;

  for (let index = 0; index < alertKeys.length; index += 500) {
    const chunk = alertKeys.slice(index, index + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT alert_key, status, note, reviewed_at
       FROM price_quality_alert_reviews
       WHERE alert_key IN (${placeholders})`,
      chunk
    );
    rows.forEach((row: any) => reviews.set(String(row.alert_key), row));
  }

  return reviews;
};

const buildPriceQualityAlerts = async (db: any): Promise<PriceQualityAlert[]> => {
  await ensurePriceQualityAlertReviewTable(db);
  const records = await loadActivePriceRows(db);
  const groupedRecords: Record<string, PriceRecordRow[]> = {};

  records.forEach(record => {
    const key = getSeriesKey(record);
    if (!groupedRecords[key]) groupedRecords[key] = [];
    groupedRecords[key].push(record);
  });

  const alerts: PriceQualityAlert[] = [];
  Object.values(groupedRecords).forEach(seriesRecords => {
    seriesRecords.sort((a, b) => toDateValue(a.date) - toDateValue(b.date) || a.id - b.id);

    const recordsByDate = new Map<string, PriceRecordRow[]>();
    seriesRecords.forEach(record => {
      const rows = recordsByDate.get(record.date) || [];
      rows.push(record);
      recordsByDate.set(record.date, rows);
    });

    recordsByDate.forEach(rows => {
      if (rows.length <= 1) return;
      rows.forEach(record => {
        alerts.push(createQualityAlert(
          record,
          "DUPLICATE_SAME_DATE",
          "critical",
          `同一对象在 ${record.date} 有 ${rows.length} 条价格记录，需要确认是否重复录入或口径冲突`,
          {
            duplicate_record_ids: rows.map(item => item.id),
            duplicate_prices: rows.map(item => roundNumber(item.price))
          }
        ));
      });
    });

    for (let index = 0; index < seriesRecords.length; index += 1) {
      const record = seriesRecords[index];
      const previous = index > 0 ? seriesRecords[index - 1] : null;
      const next = index < seriesRecords.length - 1 ? seriesRecords[index + 1] : null;

      if (previous && previous.price > 0) {
        const change = percentChange(record.price, previous.price);
        if (change !== null && Math.abs(change) >= LARGE_PRICE_MOVE_PERCENT) {
          alerts.push(createQualityAlert(
            record,
            "LARGE_MOVE_FROM_PREVIOUS",
            Math.abs(change) >= 80 ? "critical" : "warning",
            `较上一条 ${previous.date} 的 ${roundNumber(previous.price)} 变动 ${roundNumber(change)}%，需要确认是真行情还是漏位/录错`,
            {
              baseline_record_id: previous.id,
              baseline_date: previous.date,
              baseline_price: roundNumber(previous.price),
              change_percent: roundNumber(change)
            }
          ));
        }
      }

      if (next && next.price > 0) {
        const change = percentChange(record.price, next.price);
        if (change !== null && Math.abs(change) >= LARGE_PRICE_MOVE_PERCENT) {
          alerts.push(createQualityAlert(
            record,
            "LARGE_MOVE_FROM_NEXT",
            Math.abs(change) >= 80 ? "critical" : "warning",
            `较下一条 ${next.date} 的 ${roundNumber(next.price)} 反向偏离 ${roundNumber(change)}%，如果前后价格接近，优先排查录错`,
            {
              baseline_record_id: next.id,
              baseline_date: next.date,
              baseline_price: roundNumber(next.price),
              change_percent: roundNumber(change)
            }
          ));
        }
      }

      if (previous && next && previous.price > 0 && next.price > 0) {
        const fromPrevious = percentChange(record.price, previous.price);
        const fromNext = percentChange(record.price, next.price);
        const neighborChange = percentChange(next.price, previous.price);
        const isolatedDirection = record.price > previous.price && record.price > next.price
          ? "spike"
          : record.price < previous.price && record.price < next.price
            ? "drop"
            : "";

        if (
          isolatedDirection
          && fromPrevious !== null
          && fromNext !== null
          && neighborChange !== null
          && Math.abs(fromPrevious) >= LARGE_PRICE_MOVE_PERCENT
          && Math.abs(fromNext) >= LARGE_PRICE_MOVE_PERCENT
          && Math.abs(neighborChange) <= ISOLATED_NEIGHBOR_CLOSE_PERCENT
        ) {
          alerts.push(createQualityAlert(
            record,
            "ISOLATED_SPIKE_OR_DROP",
            "critical",
            isolatedDirection === "drop"
              ? "单条价格明显低于前后记录，像漏位或录错，优先处理"
              : "单条价格明显高于前后记录，像多写一位或异常尖峰，优先复核",
            {
              previous_record_id: previous.id,
              previous_date: previous.date,
              previous_price: roundNumber(previous.price),
              next_record_id: next.id,
              next_date: next.date,
              next_price: roundNumber(next.price),
              from_previous_percent: roundNumber(fromPrevious),
              from_next_percent: roundNumber(fromNext),
              neighbor_change_percent: roundNumber(neighborChange)
            }
          ));
        }
      }

      const previousPrices = seriesRecords
        .slice(Math.max(0, index - 7), index)
        .map(item => item.price)
        .filter(value => Number.isFinite(value) && value > 0);
      const recentMedian = medianNumber(previousPrices);
      if (previousPrices.length >= 3 && recentMedian && (
        record.price <= recentMedian * MEDIAN_OUTLIER_RATIO
        || record.price >= recentMedian * (1 / MEDIAN_OUTLIER_RATIO)
      )) {
        const deviationPercent = percentChange(record.price, recentMedian) || 0;
        alerts.push(createQualityAlert(
          record,
          "RECENT_MEDIAN_OUTLIER",
          Math.abs(deviationPercent) >= 80 ? "critical" : "warning",
          `偏离最近 7 条中位数 ${roundNumber(recentMedian)} 达 ${roundNumber(deviationPercent)}%，需要人工复核`,
          {
            median_price: roundNumber(recentMedian),
            deviation_percent: roundNumber(deviationPercent),
            sample_count: previousPrices.length
          }
        ));
      }
    }
  });

  const reviews = await loadQualityAlertReviews(db, alerts.map(alert => alert.alert_key));
  return alerts.map(alert => {
    const review = reviews.get(alert.alert_key);
    if (!review || !VALID_QUALITY_ALERT_STATUSES.has(review.status)) return alert;
    return {
      ...alert,
      status: review.status,
      review_note: review.note || null,
      reviewed_at: review.reviewed_at || null
    };
  });
};

const qualityAlertStatusSummary = (alerts: PriceQualityAlert[]) => {
  const byStatus = { pending: 0, ignored: 0, fixed: 0 };
  const bySeverity = { critical: 0, warning: 0 };
  const byType: Record<string, number> = {};

  alerts.forEach(alert => {
    byStatus[alert.status] += 1;
    bySeverity[alert.severity] += 1;
    byType[alert.alert_type] = (byType[alert.alert_type] || 0) + 1;
  });

  return {
    total: alerts.length,
    pending: byStatus.pending,
    ignored: byStatus.ignored,
    fixed: byStatus.fixed,
    critical: bySeverity.critical,
    warning: bySeverity.warning,
    by_type: byType
  };
};

const writeQualityAlertAuditLog = async (
  db: any,
  action: string,
  alertKey: string,
  detail: string
) => {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO audit_logs
      (id, timestamp, module, action, target, status, detail, entity_id, path, domain, workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `price_quality_alert_${action}_${hashString(alertKey)}_${Date.now()}`,
      now,
      "价格数据质量",
      action,
      "价格异常告警",
      "success",
      detail,
      alertKey,
      "/price/quality-alerts",
      "business",
      "business",
      now,
      now
    ]
  ).catch(() => undefined);
};

const buildPriceAnomalyWarnings = async (
  db: any,
  input: {
    date: string;
    category_name: string;
    object_name: string;
    variant_name: string;
    price: number;
  },
  excludeId?: string | number
): Promise<PriceAnomalyWarning[]> => {
  const rows = await db.all(
    `SELECT id, date, CAST(price AS REAL) AS price
     FROM price_records
     WHERE category = ? AND object_name = ? AND COALESCE(variant, '') = ?
       AND (? IS NULL OR id != ?)
     ORDER BY date ASC, created_at ASC, id ASC`,
    [
      input.category_name,
      input.object_name,
      input.variant_name,
      excludeId ?? null,
      excludeId ?? null
    ]
  );
  const warnings: PriceAnomalyWarning[] = [];
  const beforeRows = rows.filter((row: any) => String(row.date) < input.date);
  const afterRows = rows.filter((row: any) => String(row.date) > input.date);
  const previous = beforeRows[beforeRows.length - 1];
  const next = afterRows[0];

  const pushMoveWarning = (row: any, direction: "上一条" | "下一条") => {
    if (!row || Number(row.price) <= 0) return;
    const change = percentChange(input.price, Number(row.price));
    if (change === null || Math.abs(change) < LARGE_PRICE_MOVE_PERCENT) return;
    warnings.push({
      code: direction === "上一条" ? "LARGE_MOVE_FROM_PREVIOUS" : "LARGE_MOVE_FROM_NEXT",
      severity: "warning",
      message: `疑似异常价格：较${direction} ${row.date} 的 ${roundNumber(Number(row.price))} 变动 ${roundNumber(change)}%`,
      baseline_date: String(row.date),
      baseline_price: roundNumber(Number(row.price)),
      change_percent: roundNumber(change)
    });
  };

  pushMoveWarning(previous, "上一条");
  pushMoveWarning(next, "下一条");

  const recentPrices = beforeRows
    .slice(-7)
    .map((row: any) => Number(row.price))
    .filter((value: number) => Number.isFinite(value) && value > 0);
  const recentMedian = medianNumber(recentPrices);
  if (recentPrices.length >= 3 && recentMedian && (
    input.price <= recentMedian * MEDIAN_OUTLIER_RATIO
    || input.price >= recentMedian * (1 / MEDIAN_OUTLIER_RATIO)
  )) {
    warnings.push({
      code: "RECENT_MEDIAN_OUTLIER",
      severity: "warning",
      message: `疑似漏位或录错：当前价格 ${roundNumber(input.price)} 偏离最近 7 条中位数 ${roundNumber(recentMedian)} 超过 50%`,
      median_price: roundNumber(recentMedian)
    });
  }

  return warnings;
};

const buildPriceInsights = (records: PriceRecordRow[]) => {
  if (records.length === 0) {
    return {
      overview: {
        total_records: 0,
        series_count: 0,
        category_count: 0,
        earliest_date: null,
        latest_date: null,
        latest_date_records: 0,
        active_series_last_7d: 0,
        stale_series_over_14d: 0,
        suspected_anomaly_count: 0
      },
      category_summary: [],
      latest_moves: [],
      period_gainers: [],
      period_losers: [],
      drawdowns: [],
      record_highs: [],
      record_lows: [],
      stale_targets: [],
      suspected_anomalies: [],
      recent_dates: []
    };
  }

  const groupedRecords: Record<string, PriceRecordRow[]> = {};
  const categoryCounts = new Map<string, number>();
  const dateCounts = new Map<string, number>();

  records.forEach(record => {
    const key = getSeriesKey(record);
    if (!groupedRecords[key]) {
      groupedRecords[key] = [];
    }
    groupedRecords[key].push(record);
    categoryCounts.set(record.category, (categoryCounts.get(record.category) || 0) + 1);
    dateCounts.set(record.date, (dateCounts.get(record.date) || 0) + 1);
  });

  Object.values(groupedRecords).forEach(seriesRecords => {
    seriesRecords.sort((a, b) => (
      toDateValue(a.date) - toDateValue(b.date) ||
      a.id - b.id
    ));
  });

  const sortedDates = [...dateCounts.keys()].sort((a, b) => toDateValue(a) - toDateValue(b));
  const earliestDate = sortedDates[0];
  const latestDate = sortedDates[sortedDates.length - 1];
  const seriesStats: SeriesStats[] = [];
  const jumps: JumpInsight[] = [];

  Object.values(groupedRecords).forEach(seriesRecords => {
    const first = seriesRecords[0];
    const last = seriesRecords[seriesRecords.length - 1];
    const previous = seriesRecords.length > 1 ? seriesRecords[seriesRecords.length - 2] : null;
    const previousRecords = seriesRecords.slice(0, -1);
    const minRecord = seriesRecords.reduce((min, record) => record.price < min.price ? record : min, first);
    const maxRecord = seriesRecords.reduce((max, record) => record.price > max.price ? record : max, first);
    const previousMinRecord = previousRecords.length > 0
      ? previousRecords.reduce((min, record) => record.price < min.price ? record : min, previousRecords[0])
      : null;
    const previousMaxRecord = previousRecords.length > 0
      ? previousRecords.reduce((max, record) => record.price > max.price ? record : max, previousRecords[0])
      : null;
    const periodCutoff = toDateValue(last.date) - 30 * DAY_MS;
    const periodBase = [...seriesRecords].reverse().find(record => toDateValue(record.date) <= periodCutoff) || first;
    const periodChangeAmount = periodBase.id !== last.id ? last.price - periodBase.price : null;
    const periodChangePercent = periodBase.id !== last.id ? percentChange(last.price, periodBase.price) : null;
    const changeAmount = previous ? last.price - previous.price : null;
    const changePercent = previous ? percentChange(last.price, previous.price) : null;
    const fromFirstPercent = percentChange(last.price, first.price) || 0;
    const drawdownPercent = percentChange(last.price, maxRecord.price) || 0;
    const historicalHighBreakPercent = previousMaxRecord && last.price > previousMaxRecord.price
      ? percentChange(last.price, previousMaxRecord.price)
      : null;
    const historicalLowBreakPercent = previousMinRecord && last.price < previousMinRecord.price
      ? percentChange(last.price, previousMinRecord.price)
      : null;

    seriesStats.push({
      label: buildSeriesLabel(last),
      category_name: last.category,
      object_name: last.object_name,
      variant_name: last.variant || '',
      category_id: last.category_id,
      object_id: last.object_id,
      variant_id: last.variant_id,
      record_count: seriesRecords.length,
      first_date: first.date,
      first_price: first.price,
      current_date: last.date,
      current_price: last.price,
      previous_date: previous?.date || null,
      previous_price: previous?.price || null,
      change_amount: changeAmount,
      change_percent: changePercent,
      period_start_date: periodBase.id !== last.id ? periodBase.date : null,
      period_start_price: periodBase.id !== last.id ? periodBase.price : null,
      period_change_amount: periodChangeAmount,
      period_change_percent: periodChangePercent,
      min_price: minRecord.price,
      min_date: minRecord.date,
      max_price: maxRecord.price,
      max_date: maxRecord.date,
      drawdown_percent: drawdownPercent,
      from_first_percent: fromFirstPercent,
      historical_high_break_percent: historicalHighBreakPercent,
      historical_low_break_percent: historicalLowBreakPercent,
      days_since_latest: daysBetween(last.date, latestDate),
      source: last.source,
      note: last.note
    });

    for (let index = 1; index < seriesRecords.length; index++) {
      const fromRecord = seriesRecords[index - 1];
      const toRecord = seriesRecords[index];
      const jumpPercent = percentChange(toRecord.price, fromRecord.price);
      if (jumpPercent === null) continue;

      jumps.push({
        label: buildSeriesLabel(toRecord),
        category_name: toRecord.category,
        object_name: toRecord.object_name,
        variant_name: toRecord.variant || '',
        category_id: toRecord.category_id,
        object_id: toRecord.object_id,
        variant_id: toRecord.variant_id,
        from_date: fromRecord.date,
        to_date: toRecord.date,
        from_price: fromRecord.price,
        to_price: toRecord.price,
        change_amount: toRecord.price - fromRecord.price,
        change_percent: jumpPercent,
        source: toRecord.source,
        note: toRecord.note
      });
    }
  });

  const activeSeries = seriesStats.filter(item => item.days_since_latest <= 7);
  const staleSeries = seriesStats.filter(item => item.days_since_latest >= 14);
  const suspectedAnomalies = jumps
    .filter(item => Math.abs(item.change_percent) >= 20 || Math.abs(item.change_amount) >= 1000)
    .sort((a, b) => Math.abs(b.change_percent) - Math.abs(a.change_percent))
    .slice(0, 20)
    .map(toJumpInsightItem);

  const categorySummary = [...categoryCounts.entries()].map(([category, totalRecords]) => {
    const categorySeries = seriesStats.filter(item => item.category_name === category);
    const movedSeries = categorySeries.filter(item => item.change_percent !== null);
    const totalMove = movedSeries.reduce((sum, item) => sum + (item.change_percent || 0), 0);

    return {
      category,
      total_records: totalRecords,
      series_count: categorySeries.length,
      active_series_last_7d: categorySeries.filter(item => item.days_since_latest <= 7).length,
      latest_up: movedSeries.filter(item => (item.change_percent || 0) > 0).length,
      latest_down: movedSeries.filter(item => (item.change_percent || 0) < 0).length,
      latest_flat: movedSeries.filter(item => item.change_percent === 0).length,
      avg_latest_change_percent: movedSeries.length > 0 ? roundNumber(totalMove / movedSeries.length) : null
    };
  }).sort((a, b) => b.total_records - a.total_records);

  return {
    overview: {
      total_records: records.length,
      series_count: seriesStats.length,
      category_count: categoryCounts.size,
      earliest_date: earliestDate,
      latest_date: latestDate,
      latest_date_records: dateCounts.get(latestDate) || 0,
      active_series_last_7d: activeSeries.length,
      stale_series_over_14d: staleSeries.length,
      suspected_anomaly_count: suspectedAnomalies.length
    },
    category_summary: categorySummary,
    latest_moves: activeSeries
      .filter(item => item.change_percent !== null)
      .sort((a, b) => Math.abs(b.change_percent || 0) - Math.abs(a.change_percent || 0))
      .slice(0, 12)
      .map(toInsightItem),
    period_gainers: activeSeries
      .filter(item => item.period_change_percent !== null)
      .sort((a, b) => (b.period_change_percent || 0) - (a.period_change_percent || 0))
      .slice(0, 10)
      .map(toInsightItem),
    period_losers: activeSeries
      .filter(item => item.period_change_percent !== null)
      .sort((a, b) => (a.period_change_percent || 0) - (b.period_change_percent || 0))
      .slice(0, 10)
      .map(toInsightItem),
    drawdowns: activeSeries
      .sort((a, b) => a.drawdown_percent - b.drawdown_percent)
      .slice(0, 12)
      .map(toInsightItem),
    record_highs: activeSeries
      .filter(item => item.record_count >= 2 && item.historical_high_break_percent !== null)
      .sort((a, b) => toDateValue(b.current_date) - toDateValue(a.current_date) || b.current_price - a.current_price)
      .slice(0, 10)
      .map(toInsightItem),
    record_lows: activeSeries
      .filter(item => item.record_count >= 2 && item.historical_low_break_percent !== null)
      .sort((a, b) => toDateValue(b.current_date) - toDateValue(a.current_date) || a.current_price - b.current_price)
      .slice(0, 10)
      .map(toInsightItem),
    stale_targets: staleSeries
      .sort((a, b) => b.days_since_latest - a.days_since_latest || b.record_count - a.record_count)
      .slice(0, 20)
      .map(toInsightItem),
    suspected_anomalies: suspectedAnomalies,
    recent_dates: [...dateCounts.entries()]
      .sort((a, b) => toDateValue(b[0]) - toDateValue(a[0]))
      .slice(0, 12)
      .map(([date, count]) => ({ date, count }))
  };
};

router.get("/price-records/quality-alerts", async (req, res) => {
  try {
    const db = await getDb();
    const status = toTrimmedText(req.query.status || "pending") as PriceQualityAlertStatus | "all";
    const category = toTrimmedText(req.query.category);
    const q = toTrimmedText(req.query.q).toLowerCase();

    if (status !== "all" && !VALID_QUALITY_ALERT_STATUSES.has(status)) {
      return res.status(400).json({ success: false, message: "status 只能是 pending、ignored、fixed 或 all" });
    }

    const alerts = await buildPriceQualityAlerts(db);
    const filteredAlerts = alerts
      .filter(alert => status === "all" || alert.status === status)
      .filter(alert => !category || alert.category_name === category)
      .filter(alert => {
        if (!q) return true;
        return [
          alert.category_name,
          alert.object_name,
          alert.variant_name,
          alert.message,
          alert.alert_type,
          alert.review_note || ""
        ].some(value => String(value).toLowerCase().includes(q));
      })
      .sort((a, b) => {
        const severityRank = { critical: 2, warning: 1 };
        return severityRank[b.severity] - severityRank[a.severity]
          || toDateValue(b.date) - toDateValue(a.date)
          || b.record_id - a.record_id;
      });

    res.json({
      success: true,
      data: {
        summary: qualityAlertStatusSummary(alerts),
        alerts: filteredAlerts
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: `获取价格数据质量告警失败: ${message}` });
  }
});

router.put("/price-records/quality-alerts/:alertKey", async (req, res) => {
  try {
    const db = await getDb();
    await ensurePriceQualityAlertReviewTable(db);
    const alertKey = toTrimmedText(req.params.alertKey);
    const status = toTrimmedText(req.body?.status) as PriceQualityAlertStatus;
    const note = toTrimmedText(req.body?.note);

    if (!alertKey) {
      return res.status(400).json({ success: false, message: "alertKey 不能为空" });
    }
    if (!VALID_QUALITY_ALERT_STATUSES.has(status)) {
      return res.status(400).json({ success: false, message: "status 只能是 pending、ignored 或 fixed" });
    }

    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO price_quality_alert_reviews
         (alert_key, status, note, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(alert_key) DO UPDATE SET
         status = excluded.status,
         note = excluded.note,
         reviewed_at = excluded.reviewed_at,
         updated_at = excluded.updated_at`,
      [alertKey, status, note, status === "pending" ? null : now, now, now]
    );
    await writeQualityAlertAuditLog(db, status, alertKey, note || `状态改为 ${status}`);

    res.json({ success: true, data: { alert_key: alertKey, status, note, reviewed_at: status === "pending" ? null : now } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: `更新价格数据质量告警失败: ${message}` });
  }
});

router.get("/price-records/insights", async (req, res) => {
  try {
    const db = await getDb();
    const records = await loadActivePriceRows(db);

    res.json({
      status: "success",
      data: buildPriceInsights(records)
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "Failed to build price insights", error: errorMessage });
  }
});

router.get("/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const { category, object_name, variant } = req.query;
    const includeArchived = String(req.query.include_archived || "").toLowerCase() === "1" || String(req.query.include_archived || "").toLowerCase() === "true";
    
    let query = "SELECT * FROM price_records";
    const params = [];
    
    if (category || object_name || variant) {
      query += " WHERE";
      if (category) {
        query += " category = ?";
        params.push(category);
      }
      if (object_name) {
        query += params.length > 0 ? " AND" : "";
        query += " object_name = ?";
        params.push(object_name);
      }
      if (variant) {
        query += params.length > 0 ? " AND" : "";
        query += " variant = ?";
        params.push(variant);
      }
    }
    
    const priceRecords = await db.all(query, params);
    if (includeArchived) {
      return res.json({ status: "success", data: priceRecords });
    }

    const maps = await getTargetIdMaps(db);
    const activePriceRecords = priceRecords.filter((row: any) => !isArchivedPriceRecord({
      id: Number(row.id),
      date: String(row.date || '').slice(0, 10),
      category: String(row.category || '').trim(),
      object_name: String(row.object_name || '').trim(),
      variant: String(row.variant || '').trim(),
      price: Number(row.price),
      source: row.source || null,
      note: row.note || null,
      category_id: null,
      object_id: null,
      variant_id: null
    }, maps));
    res.json({ status: "success", data: activePriceRecords });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "Failed to fetch price records", error: errorMessage });
  }
});

router.post("/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const { date, category_name, object_name, variant_name, price, source, note } = req.body;
    const normalizedDate = toTrimmedText(date);
    const normalizedCategoryName = toTrimmedText(category_name);
    const normalizedObjectName = toTrimmedText(object_name);
    const normalizedVariantName = toTrimmedText(variant_name);
    const normalizedSource = toTrimmedText(source);
    const normalizedNote = toTrimmedText(note);
    
    // 校验字段
    if (!normalizedCategoryName || !normalizedObjectName || price === undefined || price === null || !normalizedDate) {
      return res.status(400).json({ 
        success: false, 
        message: "缺少必填字段", 
        error_code: "MISSING_REQUIRED_FIELD", 
        data: null 
      });
    }
    
    // 校验价格是否为正数
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: "price 必须是大于 0 的数字",
        error_code: "INVALID_PRICE", 
        data: null 
      });
    }
    
    if (!isValidDateOnly(normalizedDate)) {
      return res.status(400).json({ 
        success: false, 
        message: "日期格式错误", 
        error_code: "INVALID_DATE", 
        data: null 
      });
    }
    
    // 标准化 variant_name
    const variant = normalizedVariantName;
    
    // 校验主数据是否存在
    const category = await db.get("SELECT * FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0", [normalizedCategoryName]);
    if (!category) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0", [category.id, normalizedObjectName]);
    if (!object) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (normalizedVariantName) {
      const variantRow = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0", [object.id, normalizedVariantName]);
      if (!variantRow) {
        return res.status(400).json({ 
          success: false, 
          message: "未找到对应主数据", 
          error_code: "MASTER_DATA_NOT_FOUND", 
          data: null 
        });
      }
    }

    const warnings = await buildPriceAnomalyWarnings(db, {
      date: normalizedDate,
      category_name: normalizedCategoryName,
      object_name: normalizedObjectName,
      variant_name: variant,
      price
    });
    
    const now = new Date().toISOString();
    let newRecord;
    await db.run("BEGIN IMMEDIATE TRANSACTION");
    try {
      const existingRecord = await db.get(
        "SELECT * FROM price_records WHERE date = ? AND category = ? AND object_name = ? AND COALESCE(variant, '') = ?",
        [normalizedDate, normalizedCategoryName, normalizedObjectName, variant]
      );

      if (existingRecord) {
        await db.run("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "该对象在该日期已有价格记录，请使用编辑功能修改",
          error_code: "PRICE_RECORD_DUPLICATE",
          data: null
        });
      }

      const result = await db.run(
        "INSERT INTO price_records (date, category, object_name, variant, price, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [normalizedDate, normalizedCategoryName, normalizedObjectName, variant, price, normalizedSource, normalizedNote, now, now]
      );
      newRecord = await db.get("SELECT * FROM price_records WHERE id = ?", [result.lastID]);
      await db.run("COMMIT");
    } catch (error) {
      await db.run("ROLLBACK").catch(() => undefined);
      throw error;
    }

    res.json({
      success: true,
      message: warnings.length > 0 ? "价格记录新增成功，但检测到疑似异常价格" : "价格记录新增成功",
      warnings,
      data: {
        id: newRecord.id,
        date: newRecord.date,
        category_name: newRecord.category,
        object_name: newRecord.object_name,
        variant_name: newRecord.variant,
        price: newRecord.price,
        source: newRecord.source,
        note: newRecord.note,
        warnings
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "未知错误，请联系开发排查", 
      error_code: "UNKNOWN_ERROR", 
      data: null 
    });
  }
});

router.put("/price-records/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { date, category_name, object_name, variant_name, price, source, note } = req.body;
    
    // 标准化字段
    const normalizedDate = toTrimmedText(date);
    const normalizedCategoryName = toTrimmedText(category_name);
    const normalizedObjectName = toTrimmedText(object_name);
    const normalizedVariantName = toTrimmedText(variant_name);
    const normalizedSource = toTrimmedText(source);
    const normalizedNote = toTrimmedText(note);
    
    // 校验必填字段
    if (!normalizedCategoryName || !normalizedObjectName || price === undefined || !normalizedDate) {
      return res.status(400).json({ 
        success: false, 
        message: "缺少必填字段", 
        error_code: "MISSING_REQUIRED_FIELD", 
        data: null 
      });
    }
    
    // 校验价格是否为正数
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: "price 必须是大于 0 的数字",
        error_code: "INVALID_PRICE", 
        data: null 
      });
    }
    
    if (!isValidDateOnly(normalizedDate)) {
      return res.status(400).json({ 
        success: false, 
        message: "日期格式错误", 
        error_code: "INVALID_DATE", 
        data: null 
      });
    }
    
    // 校验主数据是否存在
    const category = await db.get("SELECT * FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0", [normalizedCategoryName]);
    if (!category) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0", [category.id, normalizedObjectName]);
    if (!object) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (normalizedVariantName) {
      const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0", [object.id, normalizedVariantName]);
      if (!variant) {
        return res.status(400).json({ 
          success: false, 
          message: "未找到对应主数据", 
          error_code: "MASTER_DATA_NOT_FOUND", 
          data: null 
        });
      }
    }
    
    // 检查是否已存在相同记录（排除当前记录自身）
    const existingRecord = await db.get(
      "SELECT * FROM price_records WHERE date = ? AND category = ? AND object_name = ? AND COALESCE(variant, '') = ? AND id != ?",
      [normalizedDate, normalizedCategoryName, normalizedObjectName, normalizedVariantName, id]
    );
    
    if (existingRecord) {
      return res.status(400).json({
        success: false,
        message: "该对象在该日期已有其它价格记录，请检查后修改",
        error_code: "PRICE_RECORD_DUPLICATE",
        data: null
      });
    }

    const warnings = await buildPriceAnomalyWarnings(db, {
      date: normalizedDate,
      category_name: normalizedCategoryName,
      object_name: normalizedObjectName,
      variant_name: normalizedVariantName,
      price
    }, id);
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      "UPDATE price_records SET date = ?, category = ?, object_name = ?, variant = ?, price = ?, source = ?, note = ?, updated_at = ? WHERE id = ?", 
      [normalizedDate, normalizedCategoryName, normalizedObjectName, normalizedVariantName, price, normalizedSource, normalizedNote, now, id]
    );
    
    // 检查记录是否存在
    if (result.changes === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "记录不存在", 
        error_code: "UNKNOWN_ERROR", 
        data: null 
      });
    }
    
    // 返回更新后的数据
    const updatedRecord = await db.get("SELECT * FROM price_records WHERE id = ?", [id]);
    res.json({
      success: true,
      message: warnings.length > 0 ? "修改成功，但检测到疑似异常价格" : "修改成功",
      warnings,
      data: {
        id: updatedRecord.id,
        date: updatedRecord.date,
        category_name: updatedRecord.category,
        object_name: updatedRecord.object_name,
        variant_name: updatedRecord.variant,
        price: updatedRecord.price,
        source: updatedRecord.source,
        note: updatedRecord.note,
        warnings
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "未知错误，请联系开发排查", 
      error_code: "UNKNOWN_ERROR", 
      data: null 
    });
  }
});

router.post("/import/price-records", async (req, res) => {
  let db: any;
  let transactionStarted = false;
  try {
    db = await getDb();
    const records = req.body;
    
    if (!Array.isArray(records)) {
      return res.status(400).json({ 
        success: false, 
        message: "导入失败：请求体格式错误", 
        data: null 
      });
    }
    
    let success = 0;
    let skipped = 0;
    let failed = 0;
    const failed_records = [];
    const skipped_records = [];
    const warning_records = [];
    
    // 用于跟踪本批已处理的记录，避免包内重复
    const processedRecords = new Set();
    await db.run("BEGIN IMMEDIATE TRANSACTION");
    transactionStarted = true;
    
    for (let i = 0; i < records.length; i++) {
      const record = records[i] && typeof records[i] === 'object' ? records[i] : {};
      
      // 标准化字段
      const date = toTrimmedText(record.date);
      const category_name = toTrimmedText(record.category_name);
      const object_name = toTrimmedText(record.object_name);
      const variant_name = toTrimmedText(record.variant_name);
      const price = record.price;
      const source = toTrimmedText(record.source);
      const note = toTrimmedText(record.note);
      
      // 校验必填字段
      if (!category_name || !object_name || price === undefined || !date || !source) {
        failed++;
        failed_records.push({
          row_index: i + 1,
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "MISSING_REQUIRED_FIELD",
          message: "缺少必填字段: date, category_name, object_name, price, source"
        });
        continue;
      }
      
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        failed++;
        failed_records.push({
          row_index: i + 1,
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "INVALID_PRICE",
          message: "price 必须是大于 0 的数字"
        });
        continue;
      }
      
      if (!isValidDateOnly(date)) {
        failed++;
        failed_records.push({
          row_index: i + 1,
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "INVALID_DATE",
          message: "日期格式错误"
        });
        continue;
      }
      
      // 检查本批数据内部重复
      const recordKey = `${date}|${category_name}|${object_name}|${variant_name}`;
      if (processedRecords.has(recordKey)) {
        skipped++;
        skipped_records.push({
          row_index: i + 1,
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "PRICE_RECORD_DUPLICATE",
          message: "该对象在该日期已有价格记录，已跳过"
        });
        continue;
      }
      
      // 校验主数据是否存在
      try {
        const category = await db.get("SELECT * FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0", [category_name]);
        if (!category) {
          failed++;
          failed_records.push({
            row_index: i + 1,
            date: date,
            category_name: category_name,
            object_name: object_name,
            variant_name: variant_name,
            reason: "MASTER_DATA_NOT_FOUND",
            message: "未找到对应主数据"
          });
          continue;
        }
        
        const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0", [category.id, object_name]);
        if (!object) {
          failed++;
          failed_records.push({
            row_index: i + 1,
            date: date,
            category_name: category_name,
            object_name: object_name,
            variant_name: variant_name,
            reason: "MASTER_DATA_NOT_FOUND",
            message: "未找到对应主数据"
          });
          continue;
        }
        
        // 如果 variant_name 不为空，校验变体是否存在
        if (variant_name) {
          const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0", [object.id, variant_name]);
          if (!variant) {
            failed++;
            failed_records.push({
              row_index: i + 1,
              date: date,
              category_name: category_name,
              object_name: object_name,
              variant_name: variant_name,
              reason: "MASTER_DATA_NOT_FOUND",
              message: "未找到对应主数据"
            });
            continue;
          }
        }
        
        // 检查数据库中是否已存在
        const existingRecord = await db.get(
          "SELECT * FROM price_records WHERE date = ? AND category = ? AND object_name = ? AND COALESCE(variant, '') = ?",
          [date, category_name, object_name, variant_name]
        );
        
        if (existingRecord) {
          skipped++;
          skipped_records.push({
            row_index: i + 1,
            date: date,
            category_name: category_name,
            object_name: object_name,
            variant_name: variant_name,
            reason: "PRICE_RECORD_DUPLICATE",
            message: "该对象在该日期已有价格记录，已跳过"
          });
          continue;
        }

        const warnings = await buildPriceAnomalyWarnings(db, {
          date,
          category_name,
          object_name,
          variant_name,
          price
        });
        if (warnings.length > 0) {
          warning_records.push({
            row_index: i + 1,
            date,
            category_name,
            object_name,
            variant_name,
            price,
            warnings
          });
        }
        
        // 插入记录
        const now = new Date().toISOString();
        await db.run(
          "INSERT INTO price_records (date, category, object_name, variant, price, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [date, category_name, object_name, variant_name, price, source, note, now, now]
        );
        success++;
        processedRecords.add(recordKey);
      } catch (error) {
        failed++;
        failed_records.push({
          row_index: i + 1,
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "UNKNOWN_ERROR",
          message: "未知错误，请联系开发排查"
        });
      }
    }

    await db.run("COMMIT");
    transactionStarted = false;
    
    res.json({
      success: true,
      message: warning_records.length > 0 ? "导入完成，但存在疑似异常价格" : "导入完成",
      data: {
        success_count: success,
        skipped_count: skipped,
        failed_count: failed,
        warning_count: warning_records.length,
        warning_records,
        skipped_records: skipped_records,
        failed_records: failed_records
      }
    });
  } catch (error) {
    if (transactionStarted && db) {
      await db.run("ROLLBACK").catch(() => undefined);
    }
    res.status(500).json({ 
      success: false, 
      message: "导入失败：服务端异常", 
      data: null 
    });
  }
});

export default router;
