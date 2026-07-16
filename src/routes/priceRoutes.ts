import express from "express";
import { randomUUID } from "node:crypto";
import getDb, { withTransaction } from "../config/database";
import { isValidDateOnly } from "../utils/dateValidation";
import {
  buildPriceImportPreview,
  executePriceImportBatch,
  PriceImportBatchConflictError,
  PriceImportValidationError
} from "../services/priceImportService";
import { buildQualityAlertRecheckMetadata } from "../services/priceQualityAlertService";

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
  action?: string | null;
  reviewed_by?: string | null;
  correction_record_id?: number | null;
  last_checked_at?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LARGE_PRICE_MOVE_PERCENT = 30;
const STRONG_JUMP_PERCENT = 20;
const STRONG_JUMP_AMOUNT = 1000;
const HIGH_UNIT_PRICE_STANDARD_JUMP_DAYS = 14;
const MEDIAN_OUTLIER_RATIO = 0.5;
const ISOLATED_NEIGHBOR_CLOSE_PERCENT = 15;
const HIGH_UNIT_PRICE_STANDARD_CATEGORIES = new Set(["苹果手机", "游戏机"]);
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
      record_id INTEGER,
      alert_type TEXT,
      action TEXT,
      reviewed_by TEXT,
      correction_record_id INTEGER,
      basis_json TEXT,
      alert_snapshot_json TEXT,
      last_checked_at TEXT,
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
      `SELECT alert_key, status, note, reviewed_at, action, reviewed_by, correction_record_id, last_checked_at
       FROM price_quality_alert_reviews
       WHERE alert_key IN (${placeholders})`,
      chunk
    );
    rows.forEach((row: any) => reviews.set(String(row.alert_key), row));
  }

  return reviews;
};

const persistQualityAlertSnapshots = async (db: any, alerts: PriceQualityAlert[]) => {
  if (alerts.length === 0) return;
  const now = new Date().toISOString();
  for (const alert of alerts) {
    await db.run(
      `INSERT INTO price_quality_alert_reviews
         (alert_key, record_id, alert_type, status, basis_json, alert_snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
       ON CONFLICT(alert_key) DO UPDATE SET
         record_id = COALESCE(price_quality_alert_reviews.record_id, excluded.record_id),
         alert_type = COALESCE(price_quality_alert_reviews.alert_type, excluded.alert_type),
         basis_json = COALESCE(price_quality_alert_reviews.basis_json, excluded.basis_json),
         alert_snapshot_json = COALESCE(price_quality_alert_reviews.alert_snapshot_json, excluded.alert_snapshot_json)`,
      [
        alert.alert_key,
        alert.record_id,
        alert.alert_type,
        JSON.stringify(alert.basis || {}),
        JSON.stringify(alert),
        now,
        now
      ]
    );
  }
};

const loadResolvedQualityAlerts = async (db: any, activeAlertKeys: Set<string>): Promise<PriceQualityAlert[]> => {
  const rows = await db.all(
    `SELECT alert_key, status, note, reviewed_at, action, reviewed_by, correction_record_id,
            last_checked_at, alert_snapshot_json
     FROM price_quality_alert_reviews
     WHERE status IN ('ignored', 'fixed') AND alert_snapshot_json IS NOT NULL`
  );

  return rows.flatMap((row: any) => {
    if (activeAlertKeys.has(String(row.alert_key))) return [];
    try {
      const snapshot = JSON.parse(String(row.alert_snapshot_json || '')) as PriceQualityAlert;
      return [{
        ...snapshot,
        status: row.status,
        review_note: row.note || null,
        reviewed_at: row.reviewed_at || null,
        action: row.action || null,
        reviewed_by: row.reviewed_by || null,
        correction_record_id: row.correction_record_id || null,
        last_checked_at: row.last_checked_at || null
      }];
    } catch {
      return [];
    }
  });
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

  await persistQualityAlertSnapshots(db, alerts);
  const reviews = await loadQualityAlertReviews(db, alerts.map(alert => alert.alert_key));
  return alerts.map(alert => {
    const review = reviews.get(alert.alert_key);
    if (!review || !VALID_QUALITY_ALERT_STATUSES.has(review.status)) return alert;
    return {
      ...alert,
      status: review.status,
      review_note: review.note || null,
      reviewed_at: review.reviewed_at || null,
      action: review.action || null,
      reviewed_by: review.reviewed_by || null,
      correction_record_id: review.correction_record_id || null,
      last_checked_at: review.last_checked_at || null
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
  );
};

const getServerReviewActor = () => toTrimmedText(process.env.APP_ACTOR) || 'local-user';

const performQualityAlertRecheck = async (
  db: any,
  alertKey: string,
  correctionRecordId?: number | null
) => {
  await ensurePriceQualityAlertReviewTable(db);
  let review = await db.get(
    `SELECT alert_key, record_id, alert_type, correction_record_id, alert_snapshot_json
     FROM price_quality_alert_reviews WHERE alert_key = ?`,
    [alertKey]
  );

  if (!review) {
    await buildPriceQualityAlerts(db);
    review = await db.get(
      `SELECT alert_key, record_id, alert_type, correction_record_id, alert_snapshot_json
       FROM price_quality_alert_reviews WHERE alert_key = ?`,
      [alertKey]
    );
  }
  if (!review?.alert_snapshot_json) {
    const error = new Error('告警快照不存在，请先刷新质量告警列表');
    (error as any).statusCode = 404;
    throw error;
  }

  const snapshot = JSON.parse(String(review.alert_snapshot_json)) as PriceQualityAlert;
  const currentAlerts = await buildPriceQualityAlerts(db);
  const activeMatch = currentAlerts.find(alert => (
    Number(alert.record_id) === Number(review.record_id || snapshot.record_id)
    && alert.alert_type === String(review.alert_type || snapshot.alert_type)
  ));
  const now = new Date().toISOString();
  const resolved = !activeMatch;
  const nextStatus: PriceQualityAlertStatus = resolved ? 'fixed' : 'pending';
  const metadata = buildQualityAlertRecheckMetadata({
    resolved,
    correctionRecordId,
    existingCorrectionRecordId: review.correction_record_id,
    activeMessage: activeMatch?.message,
    snapshotMessage: snapshot.message
  });

  await db.run(
    `UPDATE price_quality_alert_reviews
     SET status = ?, note = ?, action = ?, reviewed_by = ?, correction_record_id = ?,
         reviewed_at = ?, last_checked_at = ?, updated_at = ?
     WHERE alert_key = ?`,
    [
      nextStatus,
      metadata.note,
      metadata.action,
      getServerReviewActor(),
      metadata.correctionRecordId,
      resolved ? now : null,
      now,
      now,
      alertKey
    ]
  );
  await writeQualityAlertAuditLog(db, metadata.action, alertKey, metadata.note);

  return {
    alert_key: alertKey,
    resolved,
    status: nextStatus,
    note: metadata.note,
    correction_record_id: metadata.correctionRecordId,
    reviewed_by: getServerReviewActor(),
    checked_at: now,
    current_alert: activeMatch || null
  };
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

const averageNumber = (values: Array<number | null | undefined>) => {
  const validValues = values.filter((value): value is number => Number.isFinite(Number(value)));
  if (validValues.length === 0) return null;
  return validValues.reduce((sum, value) => sum + value, 0) / validValues.length;
};

const ratio = (count: number, total: number) => (total > 0 ? count / total : 0);

const isStrongPriceJump = (
  jump: Pick<JumpInsight, "category_name" | "from_date" | "to_date" | "change_percent" | "change_amount">
) => {
  if (HIGH_UNIT_PRICE_STANDARD_CATEGORIES.has(jump.category_name)) {
    const gapDays = daysBetween(jump.from_date, jump.to_date);
    if (gapDays > HIGH_UNIT_PRICE_STANDARD_JUMP_DAYS) return false;
    return Math.abs(jump.change_percent) >= STRONG_JUMP_PERCENT;
  }
  return Math.abs(jump.change_percent) >= STRONG_JUMP_PERCENT || Math.abs(jump.change_amount) >= STRONG_JUMP_AMOUNT;
};

const buildPriceAnalysisAssistant = (seriesStats: SeriesStats[], jumps: JumpInsight[], latestDate: string) => {
  const activeSeries = seriesStats.filter(item => item.days_since_latest <= 7);
  const staleSeries = seriesStats.filter(item => item.days_since_latest >= 14);
  const activeMovedSeries = activeSeries.filter(item => item.change_percent !== null);
  const activeUp = activeMovedSeries.filter(item => Number(item.change_percent || 0) > 0);
  const activeDown = activeMovedSeries.filter(item => Number(item.change_percent || 0) < 0);
  const activeFlat = activeMovedSeries.filter(item => Number(item.change_percent || 0) === 0);
  const activeAvgChange = averageNumber(activeMovedSeries.map(item => item.change_percent));
  const activeRatio = ratio(activeSeries.length, seriesStats.length);
  const upRatio = ratio(activeUp.length, activeMovedSeries.length);
  const downRatio = ratio(activeDown.length, activeMovedSeries.length);
  const staleRatio = ratio(staleSeries.length, seriesStats.length);
  const strongJumpCount = jumps.filter(isStrongPriceJump).length;
  const bigDrawdownCount = activeSeries.filter(item => item.drawdown_percent <= -30).length;
  const recordLowCount = activeSeries.filter(item => item.historical_low_break_percent !== null).length;
  const recordHighCount = activeSeries.filter(item => item.historical_high_break_percent !== null).length;

  const tags: string[] = [];
  if (activeRatio < 0.35) tags.push("行情更新偏少");
  if (staleRatio >= 0.35) tags.push("多标的价格偏旧");
  if (downRatio >= 0.45 && Number(activeAvgChange || 0) < -1) tags.push("近期偏弱");
  if (upRatio >= 0.45 && Number(activeAvgChange || 0) > 1) tags.push("近期偏强");
  if (upRatio >= 0.25 && downRatio >= 0.25) tags.push("品类分化");
  if (strongJumpCount >= 5) tags.push("跳变较多");
  if (bigDrawdownCount >= 5) tags.push("高位回撤较多");
  if (recordLowCount > 0) tags.push("有标的破新低");
  if (recordHighCount > 0) tags.push("有标的破新高");

  let marketGate = "中性观察";
  if (activeRatio < 0.25 || staleRatio >= 0.5) {
    marketGate = "数据不新鲜，先补记录";
  } else if (strongJumpCount >= 8 && upRatio >= 0.25 && downRatio >= 0.25) {
    marketGate = "剧烈分化，先拆品类";
  } else if (downRatio >= 0.5 && Number(activeAvgChange || 0) < -2) {
    marketGate = "偏弱，优先看错杀和承接";
  } else if (upRatio >= 0.5 && Number(activeAvgChange || 0) > 2) {
    marketGate = "偏强，警惕追高";
  } else if (upRatio >= 0.25 && downRatio >= 0.25) {
    marketGate = "分化，按品类单独判断";
  }

  const evidence = [
    `最新价格日期 ${latestDate || "--"}，活跃序列 ${activeSeries.length}/${seriesStats.length}`,
    `近期上涨 ${activeUp.length}、下跌 ${activeDown.length}、持平 ${activeFlat.length}`,
    activeAvgChange !== null ? `活跃序列平均最近变动 ${roundNumber(activeAvgChange)}%` : "",
    staleSeries.length > 0 ? `超过 14 天未更新 ${staleSeries.length} 个序列` : "",
    bigDrawdownCount > 0 ? `高位回撤超过 30% 的活跃序列 ${bigDrawdownCount} 个` : "",
    strongJumpCount > 0 ? `明显跳变 ${strongJumpCount} 段，需要区分真实行情和数据错误` : ""
  ].filter(Boolean);

  const questions = [
    activeRatio < 0.35 ? "先确认没更新的品类是确实没行情/还没录，还是任务或数据源断了。" : "",
    downRatio >= 0.45 ? "下跌品类里哪些是错杀，哪些是真弱，要看承接和后续供给。" : "",
    upRatio >= 0.45 ? "上涨品类里哪些是真买盘，哪些可能是拉高出货或短期炒作。" : "",
    strongJumpCount > 0 ? "跳变大的记录先看数据质量，再看是否属于首发脉冲、补货砸盘或人为拉盘。" : "",
    bigDrawdownCount > 0 ? "高位回撤的品种要分清回撤修复机会和趋势失效。" : ""
  ].filter(Boolean);

  const categoryNames = Array.from(new Set(seriesStats.map(item => item.category_name))).filter(Boolean);
  const categoryAnalysis = categoryNames.map(category => {
    const categorySeries = seriesStats.filter(item => item.category_name === category);
    const active = categorySeries.filter(item => item.days_since_latest <= 7);
    const stale = categorySeries.filter(item => item.days_since_latest >= 14);
    const moved = active.filter(item => item.change_percent !== null);
    const latestUp = moved.filter(item => Number(item.change_percent || 0) > 0);
    const latestDown = moved.filter(item => Number(item.change_percent || 0) < 0);
    const latestFlat = moved.filter(item => Number(item.change_percent || 0) === 0);
    const periodUp = active.filter(item => Number(item.period_change_percent || 0) >= 10);
    const periodDown = active.filter(item => Number(item.period_change_percent || 0) <= -10);
    const drawdowns = active.filter(item => item.drawdown_percent <= -30);
    const lows = active.filter(item => item.historical_low_break_percent !== null);
    const highs = active.filter(item => item.historical_high_break_percent !== null);
    const categoryJumps = jumps.filter(item => item.category_name === category && isStrongPriceJump(item));
    const avgLatestChange = averageNumber(moved.map(item => item.change_percent));
    const categoryUpRatio = ratio(latestUp.length, moved.length);
    const categoryDownRatio = ratio(latestDown.length, moved.length);
    const styleTags: string[] = [];

    if (ratio(stale.length, categorySeries.length) >= 0.4) styleTags.push("数据偏旧");
    if (categoryUpRatio >= 0.5 && Number(avgLatestChange || 0) > 1) styleTags.push("近期走强");
    if (categoryDownRatio >= 0.5 && Number(avgLatestChange || 0) < -1) styleTags.push("近期走弱");
    if (categoryUpRatio >= 0.25 && categoryDownRatio >= 0.25) styleTags.push("内部明显分化");
    if (periodUp.length > 0) styleTags.push("近30日有拉升");
    if (periodDown.length > 0) styleTags.push("近30日有回落");
    if (drawdowns.length > 0) styleTags.push("高位回撤");
    if (categoryJumps.length > 0) styleTags.push("跳变/脉冲");
    if (highs.length > 0) styleTags.push("有历史新高");
    if (lows.length > 0) styleTags.push("有历史新低");

    let environment = "中性观察";
    if (ratio(stale.length, categorySeries.length) >= 0.5) {
      environment = "数据偏旧";
    } else if (categoryJumps.length >= 3) {
      environment = "剧烈波动";
    } else if (categoryDownRatio >= 0.5 && Number(avgLatestChange || 0) < -1) {
      environment = "偏弱";
    } else if (categoryUpRatio >= 0.5 && Number(avgLatestChange || 0) > 1) {
      environment = "偏强";
    } else if (categoryUpRatio >= 0.25 && categoryDownRatio >= 0.25) {
      environment = "分化";
    }

    const riskPrompts = [
      styleTags.includes("数据偏旧") ? "先确认价格没更新是市场无报价/还没录，还是任务/数据源问题。" : "",
      styleTags.includes("跳变/脉冲") ? "跳变品种先排除录错，再判断是否首发脉冲、补货砸盘或资金炒作。" : "",
      styleTags.includes("高位回撤") ? "高位回撤品种不要只看便宜，要看承接是否还在。" : "",
      styleTags.includes("近期走强") ? "走强时避免追高，确认真实成交和可拿货数量。" : "",
      styleTags.includes("近期走弱") ? "走弱时先区分错杀和趋势失效。" : ""
    ].filter(Boolean);

    const nextQuestions = [
      "这个品类现在是快进快出、等抄底，还是只观察？",
      category === "纪念币" ? "这次是新品首发，还是老品二次进场？银价和发行价锚有没有变化？" : "",
      category === "纪念钞" ? "龙钞散张是否接近你认可的安全边际，币商成本线有没有新信息？" : "",
      category === "泡泡玛特" ? "上涨/下跌来自补货、福袋砸盘、IP热度，还是弱市承接不足？" : "",
      category === "贵金属" ? "当前是牛市、熊市、牛转熊，还是熊转牛？连续暴涨要不要先看出货风险？" : "",
      riskPrompts.length > 0 ? "这些风险点里哪些已经有线下成交或档口反馈可以验证？" : ""
    ].filter(Boolean);

    return {
      category,
      environment,
      style_tags: styleTags.length > 0 ? styleTags : ["样本平稳"],
      series_count: categorySeries.length,
      active_series_count: active.length,
      stale_series_count: stale.length,
      latest_up: latestUp.length,
      latest_down: latestDown.length,
      latest_flat: latestFlat.length,
      avg_latest_change_percent: avgLatestChange === null ? null : roundNumber(avgLatestChange),
      big_drawdown_count: drawdowns.length,
      jump_count: categoryJumps.length,
      evidence: [
        `活跃 ${active.length}/${categorySeries.length} 个序列`,
        `最近上涨 ${latestUp.length}、下跌 ${latestDown.length}、持平 ${latestFlat.length}`,
        avgLatestChange !== null ? `平均最近变动 ${roundNumber(avgLatestChange)}%` : "",
        drawdowns.length > 0 ? `高位回撤超过 30% 的序列 ${drawdowns.length} 个` : "",
        categoryJumps.length > 0 ? `明显跳变 ${categoryJumps.length} 段` : ""
      ].filter(Boolean),
      risk_prompts: riskPrompts,
      next_questions: nextQuestions
    };
  }).sort((a, b) => b.series_count - a.series_count);

  return {
    market_gate: marketGate,
    latest_date: latestDate || null,
    tags: tags.length > 0 ? tags : ["暂无明显偏向"],
    evidence,
    questions: questions.length > 0 ? questions : ["当前价格层面没有明显总闸信号，按品类画像和具体对象继续拆。"],
    category_analysis: categoryAnalysis.slice(0, 8)
  };
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
      recent_dates: [],
      analysis_assistant: buildPriceAnalysisAssistant([], [], "")
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
    .filter(isStrongPriceJump)
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
      .map(([date, count]) => ({ date, count })),
    analysis_assistant: buildPriceAnalysisAssistant(seriesStats, jumps, latestDate)
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

    const activeAlerts = await buildPriceQualityAlerts(db);
    const resolvedAlerts = await loadResolvedQualityAlerts(
      db,
      new Set(activeAlerts.map(alert => alert.alert_key))
    );
    const alerts = [...activeAlerts, ...resolvedAlerts];
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
    if (status === 'fixed') {
      return res.status(400).json({ success: false, message: "不能直接标记已修正，请保存价格后重新检测" });
    }
    if (status === 'ignored' && note.length < 4) {
      return res.status(400).json({ success: false, message: "确认无需修正时必须填写理由" });
    }

    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO price_quality_alert_reviews
         (alert_key, status, note, action, reviewed_by, reviewed_at, last_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(alert_key) DO UPDATE SET
         status = excluded.status,
         note = excluded.note,
         action = excluded.action,
         reviewed_by = excluded.reviewed_by,
         reviewed_at = excluded.reviewed_at,
         last_checked_at = excluded.last_checked_at,
         updated_at = excluded.updated_at`,
      [
        alertKey,
        status,
        note,
        status === 'ignored' ? 'confirmed_no_change' : 'reopened',
        getServerReviewActor(),
        status === "pending" ? null : now,
        now,
        now,
        now
      ]
    );
    await writeQualityAlertAuditLog(db, status, alertKey, note || `状态改为 ${status}`);

    res.json({
      success: true,
      data: {
        alert_key: alertKey,
        status,
        note,
        action: status === 'ignored' ? 'confirmed_no_change' : 'reopened',
        reviewed_by: getServerReviewActor(),
        reviewed_at: status === "pending" ? null : now
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: `更新价格数据质量告警失败: ${message}` });
  }
});

router.post("/price-records/quality-alerts/:alertKey/recheck", async (req, res) => {
  try {
    const db = await getDb();
    const alertKey = toTrimmedText(req.params.alertKey);
    const rawCorrectionRecordId = Number(req.body?.correction_record_id);
    const correctionRecordId = Number.isInteger(rawCorrectionRecordId) && rawCorrectionRecordId > 0
      ? rawCorrectionRecordId
      : null;

    if (!alertKey) {
      return res.status(400).json({ success: false, message: "alertKey 不能为空" });
    }

    const result = await performQualityAlertRecheck(db, alertKey, correctionRecordId);
    res.json({
      success: true,
      message: result.resolved ? '重新检测通过，告警已自动关闭' : '重新检测后疑点仍存在',
      data: result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = Number((error as any)?.statusCode) || 500;
    res.status(statusCode).json({ success: false, message });
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
    const paged = req.query.page !== undefined || req.query.pageSize !== undefined || req.query.paged === "1";

    if (paged) {
      if (!category || !object_name) {
        return res.status(400).json({
          status: "error",
          message: "分页读取价格历史时必须指定 category 和 object_name"
        });
      }

      const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(req.query.pageSize || "30"), 10) || 30));
      const requestedPage = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
      const where: string[] = [];
      const whereParams: unknown[] = [];
      where.push("pr.category = ?");
      whereParams.push(String(category));
      where.push("pr.object_name = ?");
      whereParams.push(String(object_name));
      if (variant !== undefined && String(variant).trim()) {
        where.push("COALESCE(pr.variant, '') = ?");
        whereParams.push(String(variant));
      } else {
        where.push("COALESCE(pr.variant, '') = ''");
      }
      if (!includeArchived) {
        where.push("(c.id IS NULL OR COALESCE(c.is_archived, 0) = 0)");
        where.push("(o.id IS NULL OR COALESCE(o.is_archived, 0) = 0)");
        where.push("(COALESCE(pr.variant, '') = '' OR v.id IS NULL OR COALESCE(v.is_archived, 0) = 0)");
      }

      const fromSql = `
        FROM price_records pr
        LEFT JOIN categories c ON c.name = pr.category
        LEFT JOIN objects o ON o.category_id = c.id AND o.name = pr.object_name
        LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(pr.variant, '')
      `;
      const baseWhereSql = `WHERE ${where.join(" AND ")}`;
      const baseSelectSql = `
        SELECT
          pr.id,
          pr.date,
          pr.category,
          pr.object_name,
          COALESCE(pr.variant, '') AS variant,
          CAST(pr.price AS REAL) AS price,
          pr.source,
          pr.note,
          pr.created_at,
          pr.updated_at,
          c.id AS category_id,
          o.id AS object_id,
          CASE WHEN COALESCE(pr.variant, '') = '' THEN NULL ELSE v.id END AS variant_id
        ${fromSql}
        ${baseWhereSql}
      `;

      const latest = await db.get(`${baseSelectSql} ORDER BY pr.date DESC, pr.id DESC LIMIT 1`, whereParams);
      const high = await db.get(`${baseSelectSql} ORDER BY CAST(pr.price AS REAL) DESC, pr.date DESC, pr.id DESC LIMIT 1`, whereParams);
      const low = await db.get(`${baseSelectSql} ORDER BY CAST(pr.price AS REAL) ASC, pr.date DESC, pr.id DESC LIMIT 1`, whereParams);

      const chartPeriod = String(req.query.chart_period || "30");
      const listWhere = [...where];
      const listParams = [...whereParams];
      if ((chartPeriod === "10" || chartPeriod === "30") && latest?.date) {
        listWhere.push("date(pr.date) >= date(?, ?)");
        listParams.push(String(latest.date), `-${Number(chartPeriod) - 1} day`);
      }
      const listWhereSql = `WHERE ${listWhere.join(" AND ")}`;
      const selectSql = `
        SELECT
          pr.id,
          pr.date,
          pr.category,
          pr.object_name,
          COALESCE(pr.variant, '') AS variant,
          CAST(pr.price AS REAL) AS price,
          pr.source,
          pr.note,
          pr.created_at,
          pr.updated_at,
          c.id AS category_id,
          o.id AS object_id,
          CASE WHEN COALESCE(pr.variant, '') = '' THEN NULL ELSE v.id END AS variant_id
        ${fromSql}
        ${listWhereSql}
      `;

      const countRow = await db.get<{ total: number }>(
        `SELECT COUNT(*) AS total ${fromSql} ${listWhereSql}`,
        listParams
      );
      const total = Number(countRow?.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      let page = Math.min(requestedPage, totalPages);

      const focusId = Number.parseInt(String(req.query.focus_id || ""), 10);
      if (Number.isFinite(focusId) && focusId > 0 && total > 0) {
        const focusRecord = await db.get<{ id: number; date: string }>(
          `${selectSql} AND pr.id = ? LIMIT 1`,
          [...listParams, focusId]
        );
        if (focusRecord) {
          const newerRow = await db.get<{ total: number }>(
            `SELECT COUNT(*) AS total
             ${fromSql}
             ${listWhereSql}
             AND (pr.date > ? OR (pr.date = ? AND pr.id > ?))`,
            [...listParams, focusRecord.date, focusRecord.date, focusRecord.id]
          );
          page = Math.floor(Number(newerRow?.total || 0) / pageSize) + 1;
        }
      }

      const records = await db.all(
        `${selectSql}
         ORDER BY pr.date DESC, pr.id DESC
         LIMIT ? OFFSET ?`,
        [...listParams, pageSize, (page - 1) * pageSize]
      );
      const chartRecords = await db.all(
        `SELECT
           pr.id,
           pr.date,
           pr.category,
           pr.object_name,
           COALESCE(pr.variant, '') AS variant,
           CAST(pr.price AS REAL) AS price,
           pr.source,
           pr.note,
           c.id AS category_id,
           o.id AS object_id,
           CASE WHEN COALESCE(pr.variant, '') = '' THEN NULL ELSE v.id END AS variant_id
         ${fromSql}
         ${listWhereSql}
         ORDER BY pr.date ASC, pr.id ASC`,
        listParams
      );

      return res.json({
        status: "success",
        data: records,
        pagination: { total, page, pageSize, totalPages },
        summary: {
          latest_price: latest?.price ?? null,
          latest_date: latest?.date ?? null,
          high_price: high?.price ?? null,
          high_date: high?.date ?? null,
          low_price: low?.price ?? null,
          low_date: low?.date ?? null
        },
        chart_data: chartRecords
      });
    }
    
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
    const maps = await getTargetIdMaps(db);
    const enrichedPriceRecords = priceRecords.map((row: any) => {
      const categoryId = maps.categoryIds.get(String(row.category || '').trim()) || null;
      const objectId = categoryId
        ? maps.objectIds.get(`${categoryId}|${String(row.object_name || '').trim()}`) || null
        : null;
      const variantId = objectId && String(row.variant || '').trim()
        ? maps.variantIds.get(`${objectId}|${String(row.variant || '').trim()}`) || null
        : null;
      return { ...row, category_id: categoryId, object_id: objectId, variant_id: variantId };
    });
    if (includeArchived) {
      return res.json({ status: "success", data: enrichedPriceRecords });
    }

    const activePriceRecords = enrichedPriceRecords.filter((row: any) => !isArchivedPriceRecord({
      id: Number(row.id),
      date: String(row.date || '').slice(0, 10),
      category: String(row.category || '').trim(),
      object_name: String(row.object_name || '').trim(),
      variant: String(row.variant || '').trim(),
      price: Number(row.price),
      source: row.source || null,
      note: row.note || null,
      category_id: row.category_id,
      object_id: row.object_id,
      variant_id: row.variant_id
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
    const { date, category_name, object_name, variant_name, price, source, note, quality_alert_key } = req.body;
    
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
    
    const qualityAlertKey = toTrimmedText(quality_alert_key);

    // 告警修正时，价格更新、复检结果和审计日志必须一起成功或一起回滚。
    const now = new Date().toISOString();
    const updateRecord = async (connection: any) => {
      const result = await connection.run(
        "UPDATE price_records SET date = ?, category = ?, object_name = ?, variant = ?, price = ?, source = ?, note = ?, updated_at = ? WHERE id = ?",
        [normalizedDate, normalizedCategoryName, normalizedObjectName, normalizedVariantName, price, normalizedSource, normalizedNote, now, id]
      );
      if (result.changes === 0) {
        const error = new Error("记录不存在");
        (error as any).statusCode = 404;
        throw error;
      }

      const updatedRecord = await connection.get("SELECT * FROM price_records WHERE id = ?", [id]);
      const qualityRecheck = qualityAlertKey
        ? await performQualityAlertRecheck(connection, qualityAlertKey, Number(id))
        : null;
      return { updatedRecord, qualityRecheck };
    };

    const { updatedRecord, qualityRecheck } = qualityAlertKey
      ? await withTransaction(updateRecord)
      : await updateRecord(db);

    res.json({
      success: true,
      message: qualityRecheck?.resolved
          ? "修改成功，重新检测通过，告警已自动关闭"
          : warnings.length > 0 ? "修改成功，但检测到疑似异常价格" : "修改成功",
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
        warnings,
        quality_recheck: qualityRecheck,
        quality_recheck_error: null
      }
    });
  } catch (error) {
    const statusCode = Number((error as any)?.statusCode) || 500;
    res.status(statusCode).json({
      success: false, 
      message: statusCode === 404 ? "记录不存在" : "保存失败，价格与告警均未修改，请稍后重试",
      error_code: statusCode === 404 ? "PRICE_RECORD_NOT_FOUND" : "PRICE_ALERT_UPDATE_FAILED",
      data: null 
    });
  }
});

const readImportRecords = (body: unknown) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const records = (body as Record<string, unknown>).records;
  return Array.isArray(records) ? records : null;
};

router.post("/import/price-records/preview", async (req, res) => {
  try {
    const records = readImportRecords(req.body);
    if (!records || records.length === 0) {
      return res.status(400).json({ success: false, message: "请求体必须包含至少一条价格记录", data: null });
    }

    const db = await getDb();
    const preview = await buildPriceImportPreview(db, records);
    res.json({
      success: true,
      message: preview.error_count || preview.conflict_count ? "预览完成，请先处理冲突和错误" : "预览完成，可以确认导入",
      data: {
        batch_id: randomUUID(),
        ...preview
      }
    });
  } catch {
    res.status(500).json({ success: false, message: "预览失败：服务端异常", data: null });
  }
});

router.post("/import/price-records/commit", async (req, res) => {
  try {
    const records = readImportRecords(req.body);
    const batchId = toTrimmedText(req.body?.batch_id);
    if (!records || records.length === 0 || !batchId || batchId.length > 120) {
      return res.status(400).json({ success: false, message: "缺少有效的批次号或价格记录", data: null });
    }

    const execution = await withTransaction(transactionDb => executePriceImportBatch(transactionDb, batchId, records, {
      collectWarnings: record => buildPriceAnomalyWarnings(
        transactionDb,
        record,
        record.action === "update" ? record.existing_record_id || undefined : undefined
      )
    }));

    res.json({
      success: true,
      message: execution.idempotentReplay
        ? "该批次已经导入，已返回原结果"
        : execution.result.warning_count > 0 ? "导入完成，但存在疑似异常价格" : "导入完成",
      data: { ...execution.result, idempotent_replay: execution.idempotentReplay }
    });
  } catch (error) {
    if (error instanceof PriceImportValidationError) {
      return res.status(422).json({ success: false, message: error.message, data: error.preview });
    }
    if (error instanceof PriceImportBatchConflictError) {
      return res.status(409).json({ success: false, message: error.message, data: null });
    }
    res.status(500).json({ success: false, message: "导入失败：服务端异常", data: null });
  }
});

router.post("/import/price-records", (_req, res) => {
  res.status(400).json({
    success: false,
    message: "请先调用预览接口，再使用批次号确认导入",
    data: null
  });
});

export default router;
