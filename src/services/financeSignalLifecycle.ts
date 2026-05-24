import { getLatestCoveredTradeDate } from '../utils/financeTradeDate';

type SignalCheckInput = {
  symbol: string;
  name?: string | null;
  assetType: string;
  source: string;
  observationId?: number | null;
  observationStatus?: string | null;
  candidateReviewStatus?: string | null;
  scanConclusion?: string | null;
  snapshot?: any;
};

type LifecycleStatus = {
  key: string;
  label: string;
  sampleLabel: string;
  sampleQuality: string;
  modelTrainingReady: number;
};

let lifecycleSchemaReady = false;

const TERMINAL_STATUSES = new Set(['invalidated']);
const VALID_OBSERVATION_STATUSES = new Set(['watching', 'plan_candidate', 'confirmed']);
const INVALID_OBSERVATION_STATUSES = new Set(['invalidated', 'returned']);

export async function ensureFinanceSignalLifecycleSchema(db: any) {
  if (lifecycleSchemaReady) return;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS financial_signal_lifecycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      name TEXT,
      asset_type TEXT NOT NULL,
      source TEXT NOT NULL,
      signal_type_key TEXT,
      signal_type_label TEXT,
      first_trigger_date TEXT,
      latest_check_date TEXT,
      maturity_status TEXT NOT NULL DEFAULT 'new_trigger',
      maturity_label TEXT,
      sample_label TEXT,
      sample_quality TEXT,
      observation_status TEXT,
      candidate_review_status TEXT,
      first_observation_id INTEGER,
      latest_observation_id INTEGER,
      check_count INTEGER NOT NULL DEFAULT 0,
      valid_check_count INTEGER NOT NULL DEFAULT 0,
      invalid_check_count INTEGER NOT NULL DEFAULT 0,
      consecutive_valid_days INTEGER NOT NULL DEFAULT 0,
      confirmed_invalid_days INTEGER NOT NULL DEFAULT 0,
      flip_count INTEGER NOT NULL DEFAULT 0,
      reentry_count INTEGER NOT NULL DEFAULT 0,
      t1_valid INTEGER,
      t3_valid INTEGER,
      t5_valid INTEGER,
      broke_invalidation INTEGER NOT NULL DEFAULT 0,
      model_training_ready INTEGER NOT NULL DEFAULT 0,
      model_training_used INTEGER NOT NULL DEFAULT 0,
      model_training_batch_id TEXT,
      human_review_status TEXT NOT NULL DEFAULT 'pending',
      human_review_note TEXT,
      first_snapshot_json TEXT,
      latest_snapshot_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_financial_signal_lifecycles_symbol
      ON financial_signal_lifecycles(symbol, asset_type, source, maturity_status);

    CREATE INDEX IF NOT EXISTS idx_financial_signal_lifecycles_training
      ON financial_signal_lifecycles(model_training_ready, human_review_status, updated_at);

    CREATE TABLE IF NOT EXISTS financial_signal_lifecycle_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lifecycle_id INTEGER NOT NULL,
      observation_id INTEGER,
      check_date TEXT NOT NULL,
      trade_date TEXT,
      is_valid INTEGER NOT NULL DEFAULT 0,
      is_invalidated INTEGER NOT NULL DEFAULT 0,
      observation_status TEXT,
      entry_action TEXT,
      candidate_review_status TEXT,
      close_price REAL,
      ma20 REAL,
      ma60 REAL,
      invalidation_line REAL,
      trend_phase_code TEXT,
      structure_score REAL,
      trigger_score REAL,
      scan_conclusion TEXT,
      snapshot_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(lifecycle_id, check_date)
    );

    CREATE INDEX IF NOT EXISTS idx_financial_signal_lifecycle_checks_lifecycle
      ON financial_signal_lifecycle_checks(lifecycle_id, check_date);
  `);

  lifecycleSchemaReady = true;
}

function dateOnly(value?: string | null) {
  if (!value) return new Date().toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function getLatestLocalTradeDate(db: any, source: string, assetType: string) {
  const exactDate = await getLatestCoveredTradeDate(db, {
    source,
    assetTypes: [assetType],
  });
  if (exactDate) return exactDate;

  const fallbackDate = await getLatestCoveredTradeDate(db, {
    source,
    assetTypes: ['stock', 'etf', 'index'],
  });
  return fallbackDate || new Date().toISOString().slice(0, 10);
}

function numberOrNull(value: any) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSnapshot(value: any) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function classifySignalType(snapshot: any, assetType: string) {
  const planProfile = String(snapshot?.plan_profile || snapshot?.plan_draft?.plan_profile || '');
  const trendPhase = String(snapshot?.trend_phase_code || '');
  const opportunityCode = String(snapshot?.opportunity_type?.code || '');
  const name = String(snapshot?.name || '');

  if (assetType === 'etf') {
    if (planProfile === 'etf_broad_equity') {
      return { key: 'broad_etf', label: '宽基ETF' };
    }
    return { key: 'theme_etf', label: '主题ETF' };
  }

  if (assetType === 'stock') {
    if (opportunityCode === 'REPAIR' || ['RECOVERY', 'TREND_TRANSITION', 'REBOUND'].includes(trendPhase)) {
      return { key: 'repair_stock', label: '修复型个股' };
    }
    if (opportunityCode === 'TREND' || ['BREAKOUT', 'SLOW_GRIND_UP', 'TREND_UP'].includes(trendPhase)) {
      return { key: 'trend_stock', label: '趋势型个股' };
    }
    if (opportunityCode === 'DEFENSIVE' || /银行|保险|电力|运营商|高速|煤炭|公用|中字/.test(name)) {
      return { key: 'defensive_large_cap', label: '防守型大票' };
    }
    return { key: 'repair_stock', label: '修复型个股' };
  }

  return { key: 'other', label: '其他信号' };
}

function getCheckValidity(input: SignalCheckInput) {
  const status = String(input.observationStatus || '');
  const action = String(input.snapshot?.action || input.snapshot?.entry_action || '');
  const close = Number(input.snapshot?.close ?? input.snapshot?.close_price);
  const invalidationLine = Number(input.snapshot?.invalidation_line);
  const brokeInvalidation = Number.isFinite(close) && Number.isFinite(invalidationLine) && invalidationLine > 0 && close < invalidationLine;
  const isInvalidated = brokeInvalidation || INVALID_OBSERVATION_STATUSES.has(status) || ['BLOCKED', 'INVALIDATED'].includes(action);
  const isValid = !isInvalidated && VALID_OBSERVATION_STATUSES.has(status);

  return {
    isValid,
    isInvalidated,
    brokeInvalidation
  };
}

function resolveLifecycleStatus(args: {
  checkCount: number;
  consecutiveValidDays: number;
  confirmedInvalidDays: number;
  flipCount: number;
  isValid: boolean;
  isInvalidated: boolean;
}) : LifecycleStatus {
  const { checkCount, consecutiveValidDays, confirmedInvalidDays, flipCount, isValid, isInvalidated } = args;

  if (isInvalidated && checkCount <= 2) {
    return {
      key: 'short_lived_signal',
      label: '短命信号',
      sampleLabel: 'short_lived_signal',
      sampleQuality: 'negative',
      modelTrainingReady: 1
    };
  }

  if (isValid && consecutiveValidDays >= 5) {
    return {
      key: 'stable_plan',
      label: '稳定计划',
      sampleLabel: 'stable_signal',
      sampleQuality: 'positive',
      modelTrainingReady: 1
    };
  }

  if (isValid && consecutiveValidDays >= 3) {
    return {
      key: 'mature_plan',
      label: '成熟计划',
      sampleLabel: 'mature_signal',
      sampleQuality: 'positive',
      modelTrainingReady: 1
    };
  }

  if (flipCount >= 2 && checkCount <= 6) {
    return {
      key: 'face_slap_zone',
      label: '扇脸区',
      sampleLabel: 'face_slap_signal',
      sampleQuality: 'boundary',
      modelTrainingReady: 1
    };
  }

  if (isInvalidated && confirmedInvalidDays >= 2) {
    return {
      key: 'invalidated',
      label: '失效',
      sampleLabel: 'invalidated_signal',
      sampleQuality: 'negative',
      modelTrainingReady: 1
    };
  }

  if (isInvalidated) {
    return {
      key: 'invalidation_watch',
      label: '失效观察',
      sampleLabel: 'invalidation_watch',
      sampleQuality: 'boundary',
      modelTrainingReady: 0
    };
  }

  if (isValid && consecutiveValidDays >= 2) {
    return {
      key: 'rechecking',
      label: '复核中',
      sampleLabel: 'survived_recheck',
      sampleQuality: 'neutral',
      modelTrainingReady: 0
    };
  }

  return {
    key: 'new_trigger',
    label: '新触发',
    sampleLabel: 'new_trigger',
    sampleQuality: 'pending',
    modelTrainingReady: 0
  };
}

function survivalAt(checks: any[], index: number) {
  if (checks.length <= index) return null;
  return checks[index].is_valid ? 1 : 0;
}

export async function recordSignalLifecycleCheck(db: any, input: SignalCheckInput) {
  await ensureFinanceSignalLifecycleSchema(db);

  const snapshot = input.snapshot || {};
  const symbol = input.symbol || snapshot.symbol;
  const assetType = input.assetType || snapshot.asset_type || 'stock';
  const source = input.source || snapshot.data_source_used || 'tushare';
  if (!symbol) return null;

  const checkDate = dateOnly(
    snapshot.trade_date
      || snapshot.tradeDate
      || await getLatestLocalTradeDate(db, source, assetType)
  );
  const signalType = classifySignalType(snapshot, assetType);
  const validity = getCheckValidity(input);

  let lifecycle = await db.get(
    `SELECT *
     FROM financial_signal_lifecycles
     WHERE symbol = ? AND asset_type = ? AND source = ?
     ORDER BY id DESC
     LIMIT 1`,
    [symbol, assetType, source]
  );

  if (!lifecycle || (TERMINAL_STATUSES.has(String(lifecycle.maturity_status)) && validity.isValid)) {
    const result = await db.run(
      `INSERT INTO financial_signal_lifecycles (
        symbol, name, asset_type, source, signal_type_key, signal_type_label,
        first_trigger_date, latest_check_date, first_observation_id, latest_observation_id,
        first_snapshot_json, latest_snapshot_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        symbol,
        input.name || snapshot.name || symbol,
        assetType,
        source,
        signalType.key,
        signalType.label,
        checkDate,
        checkDate,
        input.observationId || null,
        input.observationId || null,
        JSON.stringify(snapshot),
        JSON.stringify(snapshot)
      ]
    );
    lifecycle = await db.get(`SELECT * FROM financial_signal_lifecycles WHERE id = ?`, [result.lastID]);
  }

  await db.run(
    `INSERT INTO financial_signal_lifecycle_checks (
      lifecycle_id, observation_id, check_date, trade_date, is_valid, is_invalidated,
      observation_status, entry_action, candidate_review_status, close_price, ma20, ma60,
      invalidation_line, trend_phase_code, structure_score, trigger_score, scan_conclusion,
      snapshot_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(lifecycle_id, check_date) DO UPDATE SET
      observation_id = excluded.observation_id,
      trade_date = excluded.trade_date,
      is_valid = excluded.is_valid,
      is_invalidated = excluded.is_invalidated,
      observation_status = excluded.observation_status,
      entry_action = excluded.entry_action,
      candidate_review_status = excluded.candidate_review_status,
      close_price = excluded.close_price,
      ma20 = excluded.ma20,
      ma60 = excluded.ma60,
      invalidation_line = excluded.invalidation_line,
      trend_phase_code = excluded.trend_phase_code,
      structure_score = excluded.structure_score,
      trigger_score = excluded.trigger_score,
      scan_conclusion = excluded.scan_conclusion,
      snapshot_json = excluded.snapshot_json,
      updated_at = CURRENT_TIMESTAMP`,
    [
      lifecycle.id,
      input.observationId || null,
      checkDate,
      snapshot.trade_date || null,
      validity.isValid ? 1 : 0,
      validity.isInvalidated ? 1 : 0,
      input.observationStatus || null,
      snapshot.action || null,
      input.candidateReviewStatus || null,
      numberOrNull(snapshot.close ?? snapshot.close_price),
      numberOrNull(snapshot.ma20),
      numberOrNull(snapshot.ma60),
      numberOrNull(snapshot.invalidation_line),
      snapshot.trend_phase_code || null,
      numberOrNull(snapshot.structure_score?.score ?? snapshot.structure_score),
      numberOrNull(snapshot.trigger_score),
      input.scanConclusion || null,
      JSON.stringify(snapshot)
    ]
  );

  const checks = await db.all(
    `SELECT *
     FROM financial_signal_lifecycle_checks
     WHERE lifecycle_id = ?
     ORDER BY check_date ASC, id ASC`,
    [lifecycle.id]
  );
  const validCheckCount = checks.filter((item: any) => item.is_valid).length;
  const invalidCheckCount = checks.filter((item: any) => item.is_invalidated).length;
  let consecutiveValidDays = 0;
  let confirmedInvalidDays = 0;
  for (let index = checks.length - 1; index >= 0; index -= 1) {
    if (checks[index].is_valid) consecutiveValidDays += 1;
    else break;
  }
  for (let index = checks.length - 1; index >= 0; index -= 1) {
    if (checks[index].is_invalidated) confirmedInvalidDays += 1;
    else break;
  }

  let flipCount = 0;
  let reentryCount = 0;
  for (let index = 1; index < checks.length; index += 1) {
    if (Boolean(checks[index - 1].is_valid) !== Boolean(checks[index].is_valid)) {
      flipCount += 1;
      if (checks[index].is_valid) reentryCount += 1;
    }
  }
  const status = resolveLifecycleStatus({
    checkCount: checks.length,
    consecutiveValidDays,
    confirmedInvalidDays,
    flipCount,
    isValid: validity.isValid,
    isInvalidated: validity.isInvalidated
  });

  await db.run(
    `UPDATE financial_signal_lifecycles
     SET name = ?,
         signal_type_key = ?,
         signal_type_label = ?,
         latest_check_date = ?,
         maturity_status = ?,
         maturity_label = ?,
         sample_label = ?,
         sample_quality = ?,
         observation_status = ?,
         candidate_review_status = ?,
         first_observation_id = COALESCE(first_observation_id, ?),
         latest_observation_id = ?,
         check_count = ?,
         valid_check_count = ?,
         invalid_check_count = ?,
         consecutive_valid_days = ?,
         confirmed_invalid_days = ?,
         flip_count = ?,
         reentry_count = ?,
         t1_valid = ?,
         t3_valid = ?,
         t5_valid = ?,
         broke_invalidation = ?,
         model_training_ready = ?,
         latest_snapshot_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      input.name || snapshot.name || symbol,
      signalType.key,
      signalType.label,
      checkDate,
      status.key,
      status.label,
      status.sampleLabel,
      status.sampleQuality,
      input.observationStatus || null,
      input.candidateReviewStatus || null,
      input.observationId || null,
      input.observationId || null,
      checks.length,
      validCheckCount,
      invalidCheckCount,
      consecutiveValidDays,
      confirmedInvalidDays,
      flipCount,
      reentryCount,
      survivalAt(checks, 1),
      survivalAt(checks, 3),
      survivalAt(checks, 5),
      checks.some((item: any) => item.is_invalidated) || validity.brokeInvalidation ? 1 : 0,
      status.modelTrainingReady,
      JSON.stringify(snapshot),
      lifecycle.id
    ]
  );

  return db.get(`SELECT * FROM financial_signal_lifecycles WHERE id = ?`, [lifecycle.id]);
}

function rate(numerator: number, denominator: number) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function statusLabel(key: string) {
  const labels: Record<string, string> = {
    new_trigger: '新触发',
    rechecking: '复核中',
    mature_plan: '成熟计划',
    stable_plan: '稳定计划',
    short_lived_signal: '短命信号',
    face_slap_zone: '扇脸区',
    invalidation_watch: '失效观察',
    invalidated: '失效'
  };
  return labels[key] || key;
}

export async function buildSignalLifecycleSummary(db: any) {
  await ensureFinanceSignalLifecycleSchema(db);

  const totalRow = await db.get(
    `SELECT COUNT(*) AS total
     FROM financial_signal_lifecycles`
  );

  const statusRows = await db.all(
    `SELECT COALESCE(maturity_status, 'new_trigger') AS key, COUNT(*) AS count
     FROM financial_signal_lifecycles
     GROUP BY COALESCE(maturity_status, 'new_trigger')`
  );

  const typeRows = await db.all(
    `SELECT
       COALESCE(signal_type_key, 'other') AS key,
       COALESCE(MAX(signal_type_label), COALESCE(signal_type_key, 'other')) AS label,
       COUNT(*) AS total,
       SUM(CASE WHEN t1_valid IS NOT NULL THEN 1 ELSE 0 END) AS t1_ready,
       SUM(CASE WHEN t1_valid = 1 THEN 1 ELSE 0 END) AS t1_valid_count,
       SUM(CASE WHEN t3_valid IS NOT NULL THEN 1 ELSE 0 END) AS t3_ready,
       SUM(CASE WHEN t3_valid = 1 THEN 1 ELSE 0 END) AS t3_valid_count,
       SUM(CASE WHEN t5_valid IS NOT NULL THEN 1 ELSE 0 END) AS t5_ready,
       SUM(CASE WHEN t5_valid = 1 THEN 1 ELSE 0 END) AS t5_valid_count,
       SUM(CASE WHEN broke_invalidation = 1 THEN 1 ELSE 0 END) AS invalidation_count,
       SUM(CASE WHEN maturity_status = 'face_slap_zone' THEN 1 ELSE 0 END) AS face_slap_count,
       SUM(CASE WHEN maturity_status = 'short_lived_signal' THEN 1 ELSE 0 END) AS short_lived,
       SUM(CASE WHEN model_training_ready = 1 THEN 1 ELSE 0 END) AS training_ready
     FROM financial_signal_lifecycles
     GROUP BY COALESCE(signal_type_key, 'other')
     ORDER BY total DESC`
  );

  const trainingRows = await db.all(
    `SELECT *
     FROM financial_signal_lifecycles
     WHERE model_training_ready = 1
       AND model_training_used = 0
     ORDER BY updated_at DESC, id DESC
     LIMIT 30`
  );

  const recentRows = await db.all(
    `SELECT *
     FROM financial_signal_lifecycles
     ORDER BY updated_at DESC, id DESC
     LIMIT 40`
  );

  const byStatus = new Map<string, number>();
  statusRows.forEach((row: any) => {
    byStatus.set(String(row.key || 'new_trigger'), Number(row.count || 0));
  });

  const statusOrder = ['new_trigger', 'rechecking', 'mature_plan', 'stable_plan', 'short_lived_signal', 'face_slap_zone', 'invalidation_watch', 'invalidated'];

  return {
    total: Number(totalRow?.total || 0),
    statusCards: statusOrder.map(key => ({
      key,
      label: statusLabel(key),
      count: byStatus.get(key) || 0
    })),
    survivalByType: typeRows.map((row: any) => ({
      key: row.key,
      label: row.label || row.key,
      total: Number(row.total || 0),
      t1Rate: rate(Number(row.t1_valid_count || 0), Number(row.t1_ready || 0)),
      t3Rate: rate(Number(row.t3_valid_count || 0), Number(row.t3_ready || 0)),
      t5Rate: rate(Number(row.t5_valid_count || 0), Number(row.t5_ready || 0)),
      invalidationRate: rate(Number(row.invalidation_count || 0), Number(row.total || 0)),
      faceSlapRate: rate(Number(row.face_slap_count || 0), Number(row.total || 0)),
      shortLived: Number(row.short_lived || 0),
      trainingReady: Number(row.training_ready || 0)
    })),
    trainingQueue: trainingRows.map(compactLifecycle),
    recent: recentRows.map(compactLifecycle)
  };
}

export async function syncSignalLifecyclesFromEntryObservations(db: any, limit = 500) {
  await ensureFinanceSignalLifecycleSchema(db);

  const recentRows = await db.all(
    `SELECT id, symbol, name, asset_type, source, trade_date, observation_status,
            entry_action, trigger_score, structure_score, trend_phase_code, market_regime,
            close_price, ma20, ma60, invalidation_line, snapshot_json, note, updated_at
     FROM financial_entry_trigger_observations
     ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
     LIMIT ?`,
    [Math.min(Number(limit) || 500, 1000)]
  );

  const lifecycleObservationRows = await db.all(
    `SELECT o.id, o.symbol, o.name, o.asset_type, o.source, o.trade_date, o.observation_status,
            o.entry_action, o.trigger_score, o.structure_score, o.trend_phase_code, o.market_regime,
            o.close_price, o.ma20, o.ma60, o.invalidation_line, o.snapshot_json, o.note, o.updated_at
     FROM financial_entry_trigger_observations o
     WHERE o.id IN (
       SELECT latest_observation_id
       FROM financial_signal_lifecycles
       WHERE latest_observation_id IS NOT NULL
         AND (
           observation_status IN ('watching', 'plan_candidate', 'confirmed')
           OR maturity_status IN ('new_trigger', 'rechecking', 'mature_plan', 'stable_plan', 'invalidation_watch')
         )
     )
     ORDER BY COALESCE(o.updated_at, o.created_at) DESC, o.id DESC
     LIMIT 1000`
  );

  const rowById = new Map<number, any>();
  [...recentRows, ...lifecycleObservationRows].forEach((row: any) => {
    rowById.set(Number(row.id), row);
  });
  const rows = Array.from(rowById.values()).sort((a: any, b: any) => {
    const timeDiff = new Date(String(b.updated_at || 0)).getTime() - new Date(String(a.updated_at || 0)).getTime();
    if (timeDiff !== 0) return timeDiff;
    return Number(b.id || 0) - Number(a.id || 0);
  });

  let synced = 0;
  for (const row of rows) {
    const snapshot = {
      ...parseSnapshot(row.snapshot_json),
      symbol: row.symbol,
      name: row.name,
      asset_type: row.asset_type,
      data_source_used: row.source,
      trade_date: row.trade_date,
      action: row.entry_action,
      trigger_score: row.trigger_score,
      structure_score: row.structure_score,
      trend_phase_code: row.trend_phase_code,
      market_regime: row.market_regime,
      close: row.close_price,
      ma20: row.ma20,
      ma60: row.ma60,
      invalidation_line: row.invalidation_line
    };
    await recordSignalLifecycleCheck(db, {
      symbol: row.symbol,
      name: row.name,
      assetType: row.asset_type,
      source: row.source,
      observationId: row.id,
      observationStatus: row.observation_status,
      candidateReviewStatus: null,
      scanConclusion: row.note || '同步历史入场观察',
      snapshot
    });
    synced += 1;
  }

  const summary = await buildSignalLifecycleSummary(db);
  return {
    checked: rows.length,
    recentChecked: recentRows.length,
    lifecycleReferenceChecked: lifecycleObservationRows.length,
    synced,
    total: summary.total,
    statusCards: summary.statusCards
  };
}

function compactLifecycle(row: any) {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    assetType: row.asset_type,
    source: row.source,
    signalTypeKey: row.signal_type_key,
    signalTypeLabel: row.signal_type_label,
    firstTriggerDate: row.first_trigger_date,
    latestCheckDate: row.latest_check_date,
    maturityStatus: row.maturity_status,
    maturityLabel: row.maturity_label || statusLabel(row.maturity_status),
    sampleLabel: row.sample_label,
    sampleQuality: row.sample_quality,
    checkCount: row.check_count,
    consecutiveValidDays: row.consecutive_valid_days,
    confirmedInvalidDays: row.confirmed_invalid_days,
    flipCount: row.flip_count,
    reentryCount: row.reentry_count,
    t1Valid: row.t1_valid,
    t3Valid: row.t3_valid,
    t5Valid: row.t5_valid,
    brokeInvalidation: Boolean(row.broke_invalidation),
    modelTrainingReady: Boolean(row.model_training_ready),
    modelTrainingUsed: Boolean(row.model_training_used),
    humanReviewStatus: row.human_review_status,
    humanReviewNote: row.human_review_note,
    updatedAt: row.updated_at
  };
}
