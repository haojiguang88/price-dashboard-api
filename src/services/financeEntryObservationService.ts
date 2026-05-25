import { getFinanceStructureProfileConfig } from './financePlanProfile';
import { buildFinancePlanQuality } from './financePlanQuality';
import { getFreshMarketRegime } from '../utils/financeMarketRegime';
import { ENTRY_READY_TREND_PHASES, roundRatio, type DailyPrice } from './financeEntryTriggerRules';

let entryTriggerObservationSchemaReady = false;

export async function ensureEntryTriggerObservationSchema(db: any) {
  if (entryTriggerObservationSchemaReady) return;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS financial_entry_trigger_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      name TEXT,
      asset_type TEXT NOT NULL,
      source TEXT NOT NULL,
      trade_date TEXT,
      observation_status TEXT NOT NULL DEFAULT 'watching',
      entry_action TEXT,
      action_label TEXT,
      trigger_score INTEGER,
      trigger_reason TEXT,
      structure_score INTEGER,
      trend_phase_code TEXT,
      market_regime TEXT,
      entry_permission TEXT,
      close_price REAL,
      ma20 REAL,
      ma60 REAL,
      invalidation_line REAL,
      snapshot_json TEXT NOT NULL,
      note TEXT,
      manual_review_action TEXT,
      manual_review_label TEXT,
      manual_review_note TEXT,
      manual_reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_financial_entry_trigger_observations_symbol
    ON financial_entry_trigger_observations(symbol, asset_type, source, observation_status);
  `);

  const columns = await db.all(`PRAGMA table_info(financial_entry_trigger_observations)`);
  const existingColumns = new Set(columns.map((column: any) => column.name));
  const extraColumns = [
    ['manual_review_action', `ALTER TABLE financial_entry_trigger_observations ADD COLUMN manual_review_action TEXT`],
    ['manual_review_label', `ALTER TABLE financial_entry_trigger_observations ADD COLUMN manual_review_label TEXT`],
    ['manual_review_note', `ALTER TABLE financial_entry_trigger_observations ADD COLUMN manual_review_note TEXT`],
    ['manual_reviewed_at', `ALTER TABLE financial_entry_trigger_observations ADD COLUMN manual_reviewed_at TEXT`]
  ];
  for (const [columnName, sql] of extraColumns) {
    if (!existingColumns.has(columnName)) {
      await db.exec(sql);
    }
  }

  entryTriggerObservationSchemaReady = true;
}

export function isEntryMarketGateOpen(entryPermission?: string | null) {
  return entryPermission === 'ALLOW_STRUCTURE_CHECK';
}

function getEntryMarketGateBlockReason(marketGate: any) {
  if (marketGate?.stale) return marketGate.freshness_reason;
  return marketGate?.entry_reason
    || marketGate?.result_reason
    || marketGate?.freshness_reason
    || '市场总闸未开放单标的结构判断。';
}

export async function getEntryMarketGateBlocker(db: any, source: string) {
  const marketGate = await getFreshMarketRegime(db, { source });
  if (isEntryMarketGateOpen(marketGate?.entry_permission)) return null;
  return {
    marketGate,
    message: `市场总闸未通过，禁止推进单标的判断/入场触发；本轮不修改入场观察和候选池状态：${getEntryMarketGateBlockReason(marketGate)}`
  };
}

export async function writeEntryObservationAuditLog(db: any, payload: {
  observationId: number;
  symbol: string;
  name?: string | null;
  actionLabel: string;
  action: string;
  note: string;
  previousStatus?: string | null;
  currentStatus?: string | null;
}) {
  try {
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO audit_logs
        (id, timestamp, module, action, target, status, detail, entity_id, path, created_at, updated_at)
       VALUES (?, ?, ?, 'update', ?, 'success', ?, ?, ?, ?, ?)`,
      [
        `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        now,
        '金融专项',
        `入场观察人工复核：${payload.symbol} ${payload.name || ''}`.trim(),
        JSON.stringify({
          action: payload.action,
          action_label: payload.actionLabel,
          note: payload.note,
          previous_status: payload.previousStatus || null,
          current_status: payload.currentStatus || null
        }),
        String(payload.observationId),
        '/finance/entry-trigger/observations',
        now,
        now
      ]
    );
  } catch (error) {
    console.warn('Failed to write entry observation audit log:', error);
  }
}

function isEntrySnapshotBlockedByMarketGate(snapshot: any) {
  return snapshot?.action === 'BLOCKED' && !isEntryMarketGateOpen(snapshot?.entry_permission);
}

export function isEntrySnapshotInvalidated(snapshot: any) {
  if (isEntrySnapshotBlockedByMarketGate(snapshot)) return false;
  return snapshot?.action === 'BLOCKED'
    || snapshot?.action === 'INVALIDATED'
    || snapshot?.structure_status === 'STRUCTURE_BROKEN'
    || (snapshot?.close && snapshot?.invalidation_line && snapshot.close < snapshot.invalidation_line);
}

export function resolveCandidateStatusAfterEntryScan(snapshot: any, invalidated: boolean, canUpgrade: boolean) {
  const trendReady = ENTRY_READY_TREND_PHASES.has(snapshot?.trend_phase_code || '');
  const structureDegraded =
    snapshot?.structure_status !== 'STRUCTURE_CONFIRMED' ||
    snapshot?.safe_zone_status !== 'SAFE_ZONE' ||
    (typeof snapshot?.structure_score?.score === 'number' && snapshot.structure_score.score < 50);

  if (invalidated) {
    return {
      reviewStatus: 'rejected',
      poolStatus: 'expired',
      finalStatus: 'REJECTED',
      reviewAction: 'entry_trigger_invalidated',
      conclusion: '失效淘汰'
    };
  }
  if (canUpgrade) {
    return {
      reviewStatus: 'plan_ready',
      poolStatus: 'active',
      finalStatus: 'READY_FOR_PLAN',
      reviewAction: 'entry_trigger_plan_ready',
      conclusion: '可升级计划准备'
    };
  }
  if (!trendReady) {
    return {
      reviewStatus: 'trend_blocked',
      poolStatus: 'active',
      finalStatus: 'WAIT',
      reviewAction: 'entry_trigger_back_to_trend',
      conclusion: '退回走势阶段'
    };
  }
  if (structureDegraded) {
    return {
      reviewStatus: 'structure_watch',
      poolStatus: 'active',
      finalStatus: 'WAIT',
      reviewAction: 'entry_trigger_back_to_structure',
      conclusion: '退回单标的判断'
    };
  }
  return {
    reviewStatus: 'wait_confirmation',
    poolStatus: 'active',
    finalStatus: 'WAIT',
    reviewAction: 'entry_trigger_waiting',
    conclusion: '继续等待'
  };
}

export function signalLifecycleAllowsPlan(lifecycle: any) {
  return ['mature_plan', 'stable_plan'].includes(String(lifecycle?.maturity_status || ''));
}

export function applySignalLifecycleGate(decision: any, lifecycle: any, rawCanUpgrade: boolean, invalidated: boolean) {
  if (!rawCanUpgrade || invalidated || signalLifecycleAllowsPlan(lifecycle)) return decision;

  const maturityStatus = String(lifecycle?.maturity_status || 'new_trigger');
  const label = lifecycle?.maturity_label || (maturityStatus === 'rechecking' ? '复核中' : '新触发');

  return {
    reviewStatus: 'wait_confirmation',
    poolStatus: 'active',
    finalStatus: 'WAIT',
    reviewAction: 'entry_trigger_lifecycle_recheck',
    conclusion: maturityStatus === 'rechecking' ? '复核中继续观察' : `${label}仅观察`
  };
}

function getPriorHigh(prices: DailyPrice[], days: number): number | null {
  const priorPrices = prices.slice(0, -1).slice(-days);
  const highs = priorPrices.map((price) => Number(price.high)).filter(Number.isFinite);
  if (highs.length === 0) return null;
  return Math.max(...highs);
}

function toNullableNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export async function buildPlanReadyValueMetrics(
  db: any,
  item: any,
  snapshot: any,
  maxLossPercent: number | null
) {
  const close = toNullableNumber(item.close_price) ?? toNullableNumber(snapshot?.close);
  if (!close || close <= 0) {
    return {
      target_price: null,
      target_source: '缺少当前价，无法计算上方空间',
      target_space_percent: null,
      downside_risk_percent: maxLossPercent,
      risk_reward_ratio: null,
      plan_quality: buildFinancePlanQuality({ ...item, plan_profile: snapshot?.plan_profile || item.plan_profile, max_loss_percent: maxLossPercent })
    };
  }

  const params: any[] = [item.symbol, item.asset_type, item.source];
  let tradeDateFilter = '';
  if (item.trade_date) {
    tradeDateFilter = 'AND trade_date <= ?';
    params.push(item.trade_date);
  }
  const rows = await db.all(
    `SELECT trade_date, open, high, low, close, volume, amount
     FROM financial_daily_prices
     WHERE symbol = ?
       AND asset_type = ?
       AND source = ?
       ${tradeDateFilter}
     ORDER BY trade_date DESC
     LIMIT 160`,
    params
  );
  const prices: DailyPrice[] = [...rows].reverse();
  const high60 = getPriorHigh(prices, 60);
  const high120 = getPriorHigh(prices, 120);
  let targetPrice = Math.max(high60 || 0, high120 || 0);
  let targetSource = targetPrice === high120 && high120
    ? '近120日前高压力'
    : targetPrice === high60 && high60
      ? '近60日前高压力'
      : '历史压力不足';

  if (!Number.isFinite(targetPrice) || targetPrice <= close) {
    const profileKey = item.plan_profile || snapshot?.plan_profile || snapshot?.plan_draft?.plan_profile;
    const extension = getFinanceStructureProfileConfig(profileKey).targetExtensionPercent;
    targetPrice = close * (1 + extension);
    targetSource = `近120日无明显上方压力，按${getFinanceStructureProfileConfig(profileKey).label}保守延展估算`;
  }

  const targetSpacePercent = targetPrice > close ? roundRatio((targetPrice - close) / close) : 0;
  const downsideRiskPercent = maxLossPercent !== null ? roundRatio(Math.max(0, maxLossPercent)) : null;
  const riskRewardRatio = downsideRiskPercent && downsideRiskPercent > 0 && targetSpacePercent !== null
    ? Math.round((targetSpacePercent / downsideRiskPercent) * 100) / 100
    : null;
  const planQuality = buildFinancePlanQuality({
    ...item,
    plan_profile: snapshot?.plan_profile || item.plan_profile,
    close_price: close,
    max_loss_percent: downsideRiskPercent,
    target_space_percent: targetSpacePercent,
    pressure_distance_percent: targetSpacePercent,
    suggested_entry_zone: snapshot?.plan_draft?.suggested_entry_zone,
    trigger_type: item.entry_action || snapshot?.action || 'READY_TO_PLAN'
  });

  return {
    target_price: Math.round(targetPrice * 1000) / 1000,
    target_source: targetSource,
    target_space_percent: targetSpacePercent,
    downside_risk_percent: downsideRiskPercent,
    risk_reward_ratio: riskRewardRatio,
    plan_quality: planQuality
  };
}

export function parseJson(value: unknown, fallback: any = null) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function entryObservationKey(row: any) {
  return `${row.symbol || ''}|${row.asset_type || ''}|${row.source || ''}`;
}

export async function loadLatestSignalLifecycleMap(db: any, rows: any[]) {
  if (!rows.length) return new Map<string, any>();
  const symbols = Array.from(new Set(rows.map(row => row.symbol).filter(Boolean)));
  if (!symbols.length) return new Map<string, any>();
  const placeholders = symbols.map(() => '?').join(',');
  let lifecycleRows: any[] = [];
  try {
    lifecycleRows = await db.all(
      `WITH ranked_lifecycles AS (
         SELECT l.*,
                ROW_NUMBER() OVER (
                  PARTITION BY l.symbol, l.asset_type, l.source
                  ORDER BY COALESCE(l.latest_check_date, l.updated_at) DESC, l.id DESC
                ) AS rn
         FROM financial_signal_lifecycles l
         WHERE l.symbol IN (${placeholders})
       )
       SELECT *
       FROM ranked_lifecycles
       WHERE rn = 1`,
      symbols
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return new Map<string, any>();
    throw error;
  }
  const wanted = new Set(rows.map(entryObservationKey));
  const map = new Map<string, any>();
  lifecycleRows.forEach((row: any) => {
    const key = entryObservationKey(row);
    if (wanted.has(key)) map.set(key, row);
  });
  return map;
}
