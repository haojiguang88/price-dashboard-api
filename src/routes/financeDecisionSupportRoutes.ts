import { Router, Request, Response } from 'express';
import getDb from '../config/database';
import { buildFinancePlanQuality } from '../services/financePlanQuality';
import { isBroadEquityEtfLike, isIndustryThemeEtfLike, resolveFinancePlanProfile } from '../services/financePlanProfile';
import { buildSignalLifecycleSummary } from '../services/financeSignalLifecycle';
import { getLatestCoveredTradeDate } from '../utils/financeTradeDate';
import {
  COMPOSITE_MARKET_GATE_POLICIES,
  evaluateCompositeMarketGateDecision,
  resolveCompositeMarketGatePolicy
} from '../utils/financeMarketRegime';

const router = Router();

const DECISION_SUPPORT_RULE_VERSION = 'decision_support_v1.1';
const MARKET_ADAPTATION_ACCEPTANCE_VERSION = 'market_adaptation_v1.1';
const MARKET_ADAPTATION_ACCEPTANCE_CACHE_TTL_MS = 60 * 1000;
let decisionSupportSchemaReady = false;
let marketAdaptationAcceptanceCache: { key: string; expiresAt: number; data: any } | null = null;

type ForwardMetrics = {
  ret5: number | null;
  ret10: number | null;
  ret20: number | null;
  maxDrawdown20: number | null;
  brokeInvalidation: boolean;
  latestTradeDate: string | null;
};

type MarketAdaptationSample = {
  symbol: string;
  name?: string | null;
  asset_type: string;
  source: string;
  trade_date: string;
  close: number | null;
  ma20: number | null;
  ma60: number | null;
  bias60: number | null;
  ret5: number | null;
  ret20: number | null;
  range20: number | null;
  cross60_10: number | null;
  trend_phase_code: string | null;
  universe_type?: string | null;
  metrics?: ForwardMetrics;
  industry?: {
    code: string | null;
    name: string | null;
    rankPct: number | null;
    ret20: number | null;
    bucket: string;
  };
  exposure?: {
    key: string;
    label: string;
    dedupe: boolean;
  };
  opportunityStyle?: {
    key: string;
    label: string;
    tone: 'good' | 'warn' | 'neutral';
  };
  adaptationScore?: number;
};

const MODEL_BOUNDARY = [
  { key: 'signal_score', label: '信号质量打分', allowed: true, note: '模型可以给候选和计划做辅助打分。' },
  { key: 'similar_cases', label: '相似历史案例', allowed: true, note: '模型可以提示相似失败/成功样本。' },
  { key: 'risk_warning', label: '失败风险提示', allowed: true, note: '模型可以提示假突破、追高和数据冲突。' },
  { key: 'review_summary', label: '复盘总结', allowed: true, note: '模型可以帮助整理复盘，不替代纪律。' },
  { key: 'open_permission', label: '直接开仓许可', allowed: false, note: '模型不能覆盖安全区、失效线、市场总闸和账户风控。' },
  { key: 'override_risk_line', label: '覆盖失效线', allowed: false, note: '模型不能直接修改风险边界。' },
  { key: 'override_market_gate', label: '覆盖市场总闸', allowed: false, note: '市场状态和账户状态仍是硬约束。' }
];

const PERMISSION_STAGES = [
  { key: 'ignore', label: '不看', allowedActions: ['记录原因'], blockedActions: ['入池', '建计划', '开仓'], note: '资产类型或风险状态不适合当前流程。' },
  { key: 'observe', label: '观察', allowedActions: ['补数据', '继续观察', '记录样本'], blockedActions: ['建计划', '开仓'], note: '信息还不够，不能直接升级。' },
  { key: 'candidate', label: '备选', allowedActions: ['二次确认', '样本跟踪'], blockedActions: ['开仓'], note: '只说明进入备选，不等于可以买。' },
  { key: 'plan', label: '计划', allowedActions: ['生成计划', '评分', '确认失效线'], blockedActions: ['自动开仓'], note: '计划用于模拟和纪律准备。' },
  { key: 'ready', label: '准备', allowedActions: ['按批次执行', '确认账户风控'], blockedActions: ['忽略失效线'], note: '只有准备状态才具备人工执行条件。' },
  { key: 'holding', label: '持仓', allowedActions: ['跟踪', '减仓', '止损', '复盘'], blockedActions: ['无计划加仓'], note: '持仓必须受退出纪律约束。' },
  { key: 'exit', label: '退出', allowedActions: ['确认退出', '生成复盘'], blockedActions: ['继续加仓'], note: '退出后沉淀为样本。' },
  { key: 'cooldown', label: '冷却', allowedActions: ['复盘', '降风险'], blockedActions: ['新增实仓'], note: '账户或标的进入冷却时只允许降风险。' }
];

const ACCOUNT_RISK_CONFIG_DEFAULTS = [
  { key: 'consecutive_failures_warn', label: '连续失败预警', value: 2, unit: '次', note: '达到后新计划降级。' },
  { key: 'consecutive_failures_block', label: '连续失败冷却', value: 3, unit: '次', note: '达到后暂停新增实仓。' },
  { key: 'monthly_loss_warn', label: '近30日亏损预警', value: 0, unit: '元', note: '低于该值后降低计划金额。' },
  { key: 'monthly_loss_block', label: '近30日亏损冷却', value: -10000, unit: '元', note: '低于该值后进入账户冷却。' },
  { key: 'largest_position_warn', label: '最大单计划占比预警', value: 0.45, unit: '比例', note: '当前暴露中单计划占比过高时提示。' },
  { key: 'active_plan_count_warn', label: '活跃计划数预警', value: 12, unit: '个', note: '同时跟踪计划太多会降低执行质量。' },
  { key: 'same_asset_type_count_warn', label: '同类资产计划数预警', value: 5, unit: '个', note: '同一资产类型过度集中时提示。' }
];

const DECISION_SAMPLE_STAGES = [
  { key: 'candidate_pool', label: '备选池', note: '从标的进入个股/ETF备选池开始记录。' },
  { key: 'trend_phase', label: '走势阶段', note: '验证走势阶段是否真的过滤掉不适合推进的标的。' },
  { key: 'single_asset_check', label: '单标的判断', note: '验证结构、安全区、流动性和模型辅助是否有过滤价值。' },
  { key: 'entry_trigger', label: '入场触发', note: '验证触发条件是否提升后续计划质量。' },
  { key: 'plan_ready', label: '计划准备池', note: '验证已具备建计划资格的标的后续表现。' },
  { key: 'trade_plan', label: '正式计划', note: '验证正式买入计划的执行质量和失效纪律。' }
];

const DECISION_SAMPLE_STAGE_LABELS = Object.fromEntries(
  DECISION_SAMPLE_STAGES.map(stage => [stage.key, stage.label])
);

const DECISION_SAMPLE_ADVANCED_STATUSES = new Set([
  'trend_ready',
  'wait_confirmation',
  'plan_ready',
  'plan_candidate',
  'confirmed',
  'planned'
]);

const DECISION_SAMPLE_BLOCKED_STATUSES = new Set([
  'expired',
  'rejected',
  'trend_blocked',
  'structure_watch',
  'invalidated',
  'returned',
  'returned_to_entry_trigger',
  'archived',
  'deleted',
  'blocked',
  'failed'
]);

async function ensureFinanceDecisionSupportSchema(db: any) {
  if (decisionSupportSchemaReady) return;

  await db.exec(`
	    CREATE TABLE IF NOT EXISTS finance_failure_samples (
	      id INTEGER PRIMARY KEY AUTOINCREMENT,
	      source_type TEXT NOT NULL,
	      source_id INTEGER NOT NULL,
	      sample_type TEXT NOT NULL,
	      symbol TEXT NOT NULL,
	      name TEXT,
	      asset_type TEXT,
	      source TEXT,
	      trade_date TEXT,
	      status TEXT,
	      reason TEXT,
	      score_json TEXT,
	      context_json TEXT,
	      outcome_json TEXT,
	      followup_status TEXT,
	      followup_status_manual INTEGER NOT NULL DEFAULT 0,
	      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_failure_samples_unique
      ON finance_failure_samples(source_type, source_id, sample_type);

	    CREATE INDEX IF NOT EXISTS idx_finance_failure_samples_symbol
	      ON finance_failure_samples(symbol, asset_type, source);

    CREATE TABLE IF NOT EXISTS finance_sample_validation_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_sample_validation_snapshots_day
      ON finance_sample_validation_snapshots(snapshot_date, rule_version);

    CREATE TABLE IF NOT EXISTS finance_account_risk_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      numeric_value REAL NOT NULL,
      unit TEXT,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS finance_decision_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      stage_key TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      asset_type TEXT,
      source TEXT,
      trade_date TEXT,
      current_status TEXT,
      stage_status TEXT,
      reason TEXT,
      rule_version TEXT,
      model_key TEXT,
      model_probability REAL,
      model_signal TEXT,
      score_json TEXT,
      context_json TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_decision_samples_unique
      ON finance_decision_samples(source_type, source_id, stage_key);

    CREATE INDEX IF NOT EXISTS idx_finance_decision_samples_symbol
      ON finance_decision_samples(symbol, asset_type, source);

    CREATE INDEX IF NOT EXISTS idx_finance_decision_samples_stage
      ON finance_decision_samples(stage_key, stage_status, updated_at);

    CREATE TABLE IF NOT EXISTS finance_decision_sample_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id INTEGER NOT NULL,
      snapshot_date TEXT NOT NULL,
      stage_key TEXT NOT NULL,
      current_status TEXT,
      trade_date TEXT,
      close_price REAL,
      invalidation_line REAL,
      trend_phase_code TEXT,
      structure_score REAL,
      trigger_score REAL,
      plan_quality_score REAL,
      model_probability REAL,
      ret_5d REAL,
      ret_10d REAL,
      ret_20d REAL,
      max_drawdown_20d REAL,
      broke_invalidation INTEGER NOT NULL DEFAULT 0,
      outcome_label TEXT,
      snapshot_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_decision_sample_snapshots_day
      ON finance_decision_sample_snapshots(sample_id, snapshot_date);

    CREATE INDEX IF NOT EXISTS idx_finance_decision_sample_snapshots_stage
      ON finance_decision_sample_snapshots(snapshot_date, stage_key, outcome_label);
	  `);

	  const failureSampleColumns = await db.all(`PRAGMA table_info(finance_failure_samples)`);
	  if (!failureSampleColumns.some((column: any) => column.name === 'followup_status_manual')) {
	    await db.exec(`ALTER TABLE finance_failure_samples ADD COLUMN followup_status_manual INTEGER NOT NULL DEFAULT 0`);
	  }
	  await db.run(
	    `UPDATE finance_failure_samples
	     SET followup_status_manual = 1
	     WHERE followup_status IN ('reviewed', 'archived')
	       AND COALESCE(followup_status_manual, 0) = 0`
	  );

  for (const item of ACCOUNT_RISK_CONFIG_DEFAULTS) {
    await db.run(
      `INSERT OR IGNORE INTO finance_account_risk_config
        (config_key, label, numeric_value, unit, note)
       VALUES (?, ?, ?, ?, ?)`,
      [item.key, item.label, item.value, item.unit, item.note]
    );
  }

  decisionSupportSchemaReady = true;
}

async function getFinanceBusinessSnapshotDate(db: any) {
  const coveredTradeDate = await getLatestCoveredTradeDate(db);
  if (coveredTradeDate) return coveredTradeDate;

  const row = await db.get(
    `SELECT MAX(trade_date) AS snapshot_date
     FROM (
       SELECT trade_date
       FROM financial_daily_prices
       WHERE trade_date IS NOT NULL
         AND COALESCE(source, 'tushare') = 'tushare'
       UNION ALL
       SELECT trade_date
       FROM financial_market_regime
       WHERE trade_date IS NOT NULL
     )`
  );
  if (row?.snapshot_date) return row.snapshot_date;
  const dateRow = await db.get(`SELECT date('now', 'localtime') as snapshot_date`);
  return dateRow?.snapshot_date || new Date().toISOString().slice(0, 10);
}

async function getCoveredTradeDateMap(db: any) {
  const [stock, etf] = await Promise.all([
    getLatestCoveredTradeDate(db, { assetTypes: ['stock'] }),
    getLatestCoveredTradeDate(db, { assetTypes: ['etf'] })
  ]);
  return { stock, etf };
}

async function getAccountRiskConfig(db: any) {
  await ensureFinanceDecisionSupportSchema(db);
  const rows = await db.all(
    `SELECT config_key, label, numeric_value, unit, note, updated_at
     FROM finance_account_risk_config
     ORDER BY id ASC`
  );
  const byKey = new Map<string, any>(rows.map((row: any) => [row.config_key, row]));
  return {
    rows,
    values: Object.fromEntries(
      ACCOUNT_RISK_CONFIG_DEFAULTS.map(item => {
        const row = byKey.get(item.key);
        return [item.key, toNumber(row?.numeric_value, item.value)];
      })
    )
  };
}

function validateAccountRiskConfigValues(values: Record<string, number>) {
  const errors: string[] = [];
  const requireNonNegativeInteger = (key: string, label: string) => {
    const value = values[key];
    if (!Number.isInteger(value) || value < 0) errors.push(`${label}必须是非负整数`);
  };
  const requirePositiveInteger = (key: string, label: string) => {
    const value = values[key];
    if (!Number.isInteger(value) || value <= 0) errors.push(`${label}必须是大于 0 的整数`);
  };

  requireNonNegativeInteger('consecutive_failures_warn', '连续失败预警');
  requireNonNegativeInteger('consecutive_failures_block', '连续失败冷却');
  requirePositiveInteger('active_plan_count_warn', '活跃计划数预警');
  requirePositiveInteger('same_asset_type_count_warn', '同类资产计划数预警');

  if (values.consecutive_failures_warn > values.consecutive_failures_block) {
    errors.push('连续失败预警不能大于连续失败冷却');
  }
  if (values.monthly_loss_block > values.monthly_loss_warn) {
    errors.push('近30日亏损冷却线不能高于预警线');
  }
  if (values.largest_position_warn <= 0 || values.largest_position_warn > 1) {
    errors.push('最大单计划占比预警必须在 0 到 1 之间');
  }

  return errors;
}

function toNumber(value: any, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function formatPercent(value: any, digits = 1): string {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '--';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function formatSignedPercent(value: any, digits = 1): string {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '--';
  const percent = Number(value) * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(digits)}%`;
}

function roundMetric(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function avg(values: Array<number | null | undefined>): number | null {
  const clean = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

async function getForwardMetrics(db: any, row: any): Promise<ForwardMetrics> {
  const tradeDate = row.trade_date || row.created_at?.slice(0, 10);
  if (!row.symbol || !tradeDate) {
    return { ret5: null, ret10: null, ret20: null, maxDrawdown20: null, brokeInvalidation: false, latestTradeDate: null };
  }
  const assetType = row.asset_type || 'stock';
  const maxTradeDate = row.maxTradeDate
    || row.max_trade_date
    || await getLatestCoveredTradeDate(db, { assetTypes: [assetType] });

  const prices = await db.all(
    `SELECT trade_date, close, low
     FROM financial_daily_prices
     WHERE symbol = ?
       AND asset_type = ?
       AND source = ?
       AND trade_date >= ?
       AND (? IS NULL OR trade_date <= ?)
     ORDER BY trade_date ASC
     LIMIT 26`,
    [row.symbol, assetType, row.source || 'tushare', tradeDate, maxTradeDate || null, maxTradeDate || null]
  );

  const entryClose = toNumber(row.close ?? row.close_price, toNumber(prices[0]?.close));
  if (!entryClose || prices.length < 2) {
    return { ret5: null, ret10: null, ret20: null, maxDrawdown20: null, brokeInvalidation: false, latestTradeDate: prices[0]?.trade_date || null };
  }

  const getReturn = (offset: number) => {
    const item = prices[offset];
    const close = toNumber(item?.close);
    return close > 0 ? roundMetric(close / entryClose - 1) : null;
  };
  const window20 = prices.slice(1, 21);
  const minLow = window20.length ? Math.min(...window20.map((item: any) => toNumber(item.low, toNumber(item.close)))) : null;
  const invalidationLine = toNumber(row.invalidation_line);

  return {
    ret5: getReturn(5),
    ret10: getReturn(10),
    ret20: getReturn(20),
    maxDrawdown20: minLow && minLow > 0 ? roundMetric(minLow / entryClose - 1) : null,
    brokeInvalidation: invalidationLine > 0 && window20.some((item: any) => toNumber(item.low, toNumber(item.close)) < invalidationLine),
    latestTradeDate: prices[prices.length - 1]?.trade_date || null
  };
}

function summarize(items: any[]) {
  const valid5 = items.filter(item => item.metrics?.ret5 !== null && item.metrics?.ret5 !== undefined);
  const valid10 = items.filter(item => item.metrics?.ret10 !== null && item.metrics?.ret10 !== undefined);
  const valid20 = items.filter(item => item.metrics?.ret20 !== null && item.metrics?.ret20 !== undefined);
  const wins5 = valid5.filter(item => Number(item.metrics.ret5) > 0);
  const wins10 = valid10.filter(item => Number(item.metrics.ret10) > 0);
  const wins20 = valid20.filter(item => Number(item.metrics.ret20) > 0);
  const invalidated = items.filter(item => item.metrics?.brokeInvalidation);
  return {
    total: items.length,
    evaluable5: valid5.length,
    evaluable10: valid10.length,
    evaluable20: valid20.length,
    coverage5: items.length ? roundMetric(valid5.length / items.length) : null,
    coverage10: items.length ? roundMetric(valid10.length / items.length) : null,
    coverage20: items.length ? roundMetric(valid20.length / items.length) : null,
    winRate5: valid5.length ? roundMetric(wins5.length / valid5.length) : null,
    winRate10: valid10.length ? roundMetric(wins10.length / valid10.length) : null,
    winRate20: valid20.length ? roundMetric(wins20.length / valid20.length) : null,
    avgRet5: roundMetric(avg(valid5.map(item => item.metrics?.ret5))),
    avgRet10: roundMetric(avg(valid10.map(item => item.metrics?.ret10))),
    avgRet20: roundMetric(avg(valid20.map(item => item.metrics?.ret20))),
    avgMaxDrawdown20: roundMetric(avg(valid20.map(item => item.metrics?.maxDrawdown20))),
    invalidationBreakRate: items.length ? roundMetric(invalidated.length / items.length) : null
  };
}

function getPlanScoreBucket(score: number | null | undefined) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) {
    return { key: 'unknown', label: '未知分' };
  }
  if (Number(score) >= 80) return { key: '80-100', label: '80分以上' };
  if (Number(score) >= 65) return { key: '65-79', label: '65-79分' };
  if (Number(score) >= 50) return { key: '50-64', label: '50-64分' };
  return { key: '0-49', label: '50分以下' };
}

function summarizeScoreBuckets(items: any[], getScore: (item: any) => number | null | undefined) {
  const order = ['80-100', '65-79', '50-64', '0-49', 'unknown'];
  const bucketMap = new Map<string, any[]>();
  items.forEach(item => {
    const bucket = getPlanScoreBucket(getScore(item));
    bucketMap.set(bucket.key, [...(bucketMap.get(bucket.key) || []), item]);
  });

  return order
    .map(key => {
      const rows = bucketMap.get(key) || [];
      const label = getPlanScoreBucket(
        key === '80-100' ? 80 : key === '65-79' ? 65 : key === '50-64' ? 50 : key === '0-49' ? 0 : null
      ).label;
      return {
        key,
        label,
        total: rows.length,
        invalidated: rows.filter(item => item.metrics?.brokeInvalidation).length,
        summary: summarize(rows)
      };
    })
    .filter(row => row.total > 0);
}

function compactSample(row: any, metrics: ForwardMetrics) {
  const planQuality = row.plan_quality || null;
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    assetType: row.asset_type,
    source: row.source,
    tradeDate: row.trade_date,
    status: row.pool_status || row.status || row.review_status,
    score: row.priority_score ?? row.structure_score ?? null,
    structureScore: row.structure_score ?? null,
    triggerScore: row.trigger_score ?? null,
    planQualityScore: planQuality?.score ?? null,
    planQualityLabel: planQuality?.label ?? null,
    invalidationLine: row.invalidation_line ?? null,
    entryPrice: row.close ?? row.close_price ?? null,
    maxLossPercent: row.max_loss_percent ?? null,
    trendPhase: row.trend_phase_code || null,
    perf20d: row.perf_20d ?? null,
    stoppedOut: row.stopped_out === 1,
    falseBreakout: row.false_breakout === 1,
    chasedHigh: row.chased_high === 1,
    modelProbability: row.model_probability ?? null,
    reason: row.first_blocking_gate_label || row.forbidden_reason || row.downgrade_reason || row.risk_note || row.trigger_reason || row.entry_reason || '',
    metrics
  };
}

const MARKET_ADAPTATION_PHASES = [
  'BREAKOUT',
  'SLOW_GRIND_UP',
  'TREND_UP',
  'RECOVERY',
  'TREND_TRANSITION',
  'HIGH_BASE',
  'SIDEWAYS',
  'SURGE'
];

const EARLY_WATCH_PHASES = new Set(['RECOVERY', 'TREND_TRANSITION', 'BREAKOUT', 'SLOW_GRIND_UP', 'TREND_UP']);
const MATURE_STRUCTURE_PHASES = new Set(['BREAKOUT', 'SLOW_GRIND_UP', 'TREND_UP', 'SURGE']);

function summarizePosterior(items: MarketAdaptationSample[]) {
  const evaluable5 = items.filter(item => item.metrics?.ret5 !== null && item.metrics?.ret5 !== undefined);
  const evaluable10 = items.filter(item => item.metrics?.ret10 !== null && item.metrics?.ret10 !== undefined);
  const evaluable20 = items.filter(item => item.metrics?.ret20 !== null && item.metrics?.ret20 !== undefined);
  const wins5 = evaluable5.filter(item => Number(item.metrics?.ret5) > 0);
  const wins10 = evaluable10.filter(item => Number(item.metrics?.ret10) > 0);
  const wins20 = evaluable20.filter(item => Number(item.metrics?.ret20) > 0);
  return {
    total: items.length,
    evaluable5: evaluable5.length,
    evaluable10: evaluable10.length,
    evaluable20: evaluable20.length,
    coverage5: items.length ? roundMetric(evaluable5.length / items.length) : null,
    coverage10: items.length ? roundMetric(evaluable10.length / items.length) : null,
    coverage20: items.length ? roundMetric(evaluable20.length / items.length) : null,
    winRate5: evaluable5.length ? roundMetric(wins5.length / evaluable5.length) : null,
    winRate10: evaluable10.length ? roundMetric(wins10.length / evaluable10.length) : null,
    winRate20: evaluable20.length ? roundMetric(wins20.length / evaluable20.length) : null,
    avgRet5: roundMetric(avg(evaluable5.map(item => item.metrics?.ret5))),
    avgRet10: roundMetric(avg(evaluable10.map(item => item.metrics?.ret10))),
    avgRet20: roundMetric(avg(evaluable20.map(item => item.metrics?.ret20))),
    avgMaxDrawdown20: roundMetric(avg(evaluable20.map(item => item.metrics?.maxDrawdown20)))
  };
}

function compactAdaptationExamples(items: MarketAdaptationSample[], limit = 8) {
  return items
    .slice(0, limit)
    .map(item => ({
      symbol: item.symbol,
      name: item.name,
      assetType: item.asset_type,
      tradeDate: item.trade_date,
      trendPhase: item.trend_phase_code,
      bias60: roundMetric(item.bias60),
      ret5: item.metrics?.ret5 ?? null,
      ret10: item.metrics?.ret10 ?? null,
      ret20: item.metrics?.ret20 ?? null,
      industry: item.industry || null,
      exposure: item.exposure || null,
      opportunityStyle: item.opportunityStyle || null
    }));
}

function comparePosterior(before: any, after: any) {
  const delta = (left: number | null | undefined, right: number | null | undefined) => {
    if (left === null || left === undefined || right === null || right === undefined) return null;
    return roundMetric(Number(right) - Number(left));
  };
  return {
    winRate5: delta(before?.winRate5, after?.winRate5),
    winRate10: delta(before?.winRate10, after?.winRate10),
    winRate20: delta(before?.winRate20, after?.winRate20),
    avgRet5: delta(before?.avgRet5, after?.avgRet5),
    avgRet10: delta(before?.avgRet10, after?.avgRet10),
    avgRet20: delta(before?.avgRet20, after?.avgRet20),
    avgMaxDrawdown20: delta(before?.avgMaxDrawdown20, after?.avgMaxDrawdown20)
  };
}

function buildAdaptationVerdict(
  before: any,
  after: any,
  options: { blocked?: any; min20?: number; mode?: 'higher_after' | 'blocked_weaker' | 'observe_only' } = {}
) {
  const min20 = options.min20 ?? 30;
  if ((after?.evaluable20 || 0) < min20) {
    return {
      status: 'insufficient',
      label: '20日样本不足',
      note: `20日可验样本 ${after?.evaluable20 || 0} 条，暂时只能看 5/10 日方向，不能定规则优劣。`
    };
  }

  if (options.mode === 'observe_only') {
    const watchRet = Number(after?.avgRet20 ?? 0);
    return watchRet > 0
      ? { status: 'observe_supported', label: '适合观察，不适合直接放行', note: '早期层 20 日均值为正，但它不是开仓许可，只适合作为主线苗头提前挂起。' }
      : { status: 'observe_cautious', label: '只保留低权重观察', note: '早期层没有证明能直接提高胜率，应继续限制在观察层。' };
  }

  if (options.mode === 'blocked_weaker' && options.blocked) {
    if ((options.blocked.evaluable20 || 0) < min20) {
      return {
        status: 'insufficient',
        label: '拦截样本不足',
        note: `被拦截组 20日可验样本 ${options.blocked.evaluable20 || 0} 条，暂时不能证明拦截有效。`
      };
    }
    const blockedWorse = Number(options.blocked.avgRet20 ?? 0) < Number(after.avgRet20 ?? 0)
      && Number(options.blocked.winRate20 ?? 0) <= Number(after.winRate20 ?? 0);
    return blockedWorse
      ? { status: 'supported', label: '规则有效倾向', note: '放行组 20日表现优于被拦截组，当前样本支持保留这条过滤。' }
      : { status: 'needs_review', label: '需要复核', note: '被拦截组没有明显更差，规则可能只是看起来聪明，需要继续调阈值。' };
  }

  const afterBetter = Number(after?.avgRet20 ?? 0) >= Number(before?.avgRet20 ?? 0)
    && Number(after?.winRate20 ?? 0) >= Number(before?.winRate20 ?? 0);
  return afterBetter
    ? { status: 'supported', label: '规则有效倾向', note: '过滤后 20日胜率和均值没有变差，当前样本支持继续保留。' }
    : { status: 'needs_review', label: '需要复核', note: '过滤后 20日表现没有优于过滤前，可能需要调阈值或只作为提示。' };
}

function buildCompositeGateVerdict(before: any, after: any, blocked: any, observe: any, policyKey?: string | null) {
  if ((blocked?.total || 0) === 0) {
    return {
      status: 'no_hard_block_samples',
      label: '暂无硬封锁样本',
      note: '当前回测窗口里没有被组合总闸硬封锁真正拦截的样本，不能把前后指标持平解读成规则有效。总闸铁律保留，但这轮只能观察降权/观察条件。'
    };
  }

  if (policyKey !== 'strict_v1' && (blocked?.evaluable20 || 0) < 20 && (observe?.evaluable20 || 0) >= 20) {
    const observeNotWorse = Number(observe?.avgRet20 ?? 0) >= Number(before?.avgRet20 ?? 0)
      && Number(observe?.winRate20 ?? 0) >= Number(before?.winRate20 ?? 0);
    return observeNotWorse
      ? {
          status: 'supported',
          label: '拆分口径有效倾向',
          note: '旧硬闸会拦掉的分化/弱宽度样本并不差，当前样本支持保留总闸铁律，但把单项分化降为观察/降权，不一票否决。'
        }
      : {
          status: 'needs_review',
          label: '观察组需要复核',
          note: '硬封锁样本不足，且观察/降权组没有明显优于基准，需要继续调组合总闸阈值。'
        };
  }
  return buildAdaptationVerdict(before, after, { blocked, mode: 'blocked_weaker', min20: 20 });
}

function buildIndustryStrengthDowngradeVerdict(normal: any, weak: any) {
  if ((weak?.evaluable20 || 0) < 30) {
    return {
      status: 'insufficient',
      label: '弱行业样本不足',
      note: `弱行业 20日可验样本 ${weak?.evaluable20 || 0} 条，暂时只能保留降权观察，不能定硬规则。`
    };
  }

  const weakClearlyWorse = Number(weak.avgRet20 ?? 0) < Number(normal.avgRet20 ?? 0)
    && Number(weak.winRate20 ?? 0) <= Number(normal.winRate20 ?? 0);
  return weakClearlyWorse
    ? {
        status: 'supported',
        label: '降权有效倾向',
        note: '弱行业组 20日表现弱于强/中行业组，当前样本支持降权观察；仍不作为个股硬拦截。'
      }
    : {
        status: 'needs_review',
        label: '只能降权观察',
        note: '弱行业组没有明显更差，不应硬拦截；最多保留优先级降权和人工复核提示。'
      };
}

function classifyAcceptanceExposureGroup(input: { symbol?: string; name?: string | null; universe_type?: string | null }) {
  const normalized = `${input.symbol || ''} ${input.name || ''} ${input.universe_type || ''}`.toLowerCase();
  const rules: Array<[RegExp, string, string]> = [
    [/沪深300|hs300|300etf|300ETF/i, 'broad:hs300', '沪深300敞口'],
    [/中证a500|a500/i, 'broad:a500', '中证A500敞口'],
    [/中证a50|a50/i, 'broad:a50', '中证A50敞口'],
    [/上证50|50etf|50ETF/i, 'broad:sse50', '上证50敞口'],
    [/中证500|500etf|500ETF/i, 'broad:csi500', '中证500敞口'],
    [/中证1000|1000etf|1000ETF/i, 'broad:csi1000', '中证1000敞口'],
    [/中证2000|2000etf|2000ETF/i, 'broad:csi2000', '中证2000敞口'],
    [/创业板|创业板指|159915|159949/i, 'broad:chinext', '创业板敞口'],
    [/科创50|科创板|588000|588080/i, 'broad:star50', '科创50敞口'],
    [/红利|股息|高股息|质量/i, 'style:dividend_quality', '红利质量敞口'],
    [/半导体|芯片|集成电路/i, 'industry:semiconductor', '半导体敞口'],
    [/人工智能|ai|云计算|软件|信创|计算机/i, 'industry:ai_cloud', 'AI/云计算敞口'],
    [/证券|券商/i, 'industry:brokerage', '券商敞口'],
    [/银行|保险|金融/i, 'industry:finance', '金融敞口'],
    [/医疗|医药|创新药|生物/i, 'industry:healthcare', '医药医疗敞口'],
    [/新能源车|电池|锂电/i, 'industry:nev_battery', '新能源车/电池敞口'],
    [/光伏|新能源/i, 'industry:solar', '光伏新能源敞口'],
    [/电力|公用事业|绿电/i, 'industry:power', '电力公用敞口'],
    [/机器人|装备|工业母机|机械/i, 'industry:equipment_robotics', '装备机器人敞口'],
    [/环保|碳中和/i, 'industry:environment', '环保敞口'],
    [/消费|食品饮料|白酒|酒ETF/i, 'industry:consumer', '消费敞口'],
    [/传媒|游戏/i, 'industry:media_game', '传媒游戏敞口'],
    [/军工|国防/i, 'industry:defense', '军工敞口'],
    [/有色|稀土|煤炭|钢铁|化工/i, 'industry:resources', '资源周期敞口'],
    [/地产|房地产|基建|建材/i, 'industry:property_infra', '地产基建敞口']
  ];
  for (const [pattern, key, label] of rules) {
    if (pattern.test(normalized)) return { key, label, dedupe: true };
  }
  return { key: `unique:${input.symbol || normalized}`, label: '未归类ETF敞口', dedupe: false };
}

function classifyAcceptanceOpportunityStyle(sample: MarketAdaptationSample) {
  const trend = String(sample.trend_phase_code || 'UNKNOWN');
  const bias60 = Number(sample.bias60 ?? 9);
  const range20 = Number(sample.range20 ?? 9);
  const nearSafeZone = bias60 >= -0.02 && bias60 <= 0.08;
  const notOverheated = range20 <= 0.24;

  if (trend === 'SLOW_GRIND_UP' && nearSafeZone && notOverheated) {
    return { key: 'slow_grind_attack', label: '慢涨进攻型', tone: 'good' as const };
  }
  if (trend === 'BREAKOUT' && nearSafeZone) {
    return { key: 'controlled_attack', label: '突破试探型', tone: 'warn' as const };
  }
  if (['TREND_UP', 'HIGH_BASE'].includes(trend) && bias60 >= 0 && bias60 <= 0.12) {
    return { key: 'trend_follow', label: '趋势跟随型', tone: 'good' as const };
  }
  if (['RECOVERY', 'TREND_TRANSITION', 'REBOUND'].includes(trend)) {
    return { key: 'repair_confirm', label: '修复确认型', tone: 'warn' as const };
  }
  if (['SIDEWAYS', 'CONSOLIDATION'].includes(trend)) {
    return { key: 'defensive_watch', label: '防守观察型', tone: 'neutral' as const };
  }
  return { key: 'risk_or_unknown', label: '风险/未确认型', tone: 'warn' as const };
}

function buildOpportunityStyleAcceptance(samples: MarketAdaptationSample[]) {
  const stockSamples = samples
    .filter(item => item.asset_type === 'stock')
    .map(item => ({ ...item, opportunityStyle: classifyAcceptanceOpportunityStyle(item) }));
  const attackKeys = new Set(['slow_grind_attack', 'controlled_attack', 'trend_follow']);
  const attack = stockSamples.filter(item => attackKeys.has(item.opportunityStyle?.key || ''));
  const observe = stockSamples.filter(item => !attackKeys.has(item.opportunityStyle?.key || ''));
  const before = summarizePosterior(stockSamples);
  const after = summarizePosterior(attack);
  const blocked = summarizePosterior(observe);
  const styleOrder = ['slow_grind_attack', 'controlled_attack', 'trend_follow', 'repair_confirm', 'defensive_watch', 'risk_or_unknown'];
  const buckets = styleOrder
    .map(key => {
      const bucketItems = stockSamples.filter(item => item.opportunityStyle?.key === key);
      const label = bucketItems[0]?.opportunityStyle?.label || key;
      return {
        key,
        label,
        total: bucketItems.length,
        summary: summarizePosterior(bucketItems)
      };
    })
    .filter(item => item.total > 0);

  return {
    key: 'stock_opportunity_style',
    title: '个股机会风格',
    beforeLabel: '全部个股候选样本',
    afterLabel: '体系内进攻风格',
    blockedLabel: '防守/修复对照',
    before,
    after,
    blocked,
    delta: comparePosterior(before, after),
    verdict: buildAdaptationVerdict(before, after, { blocked, mode: 'blocked_weaker', min20: 20 }),
    buckets,
    examples: compactAdaptationExamples(attack.sort((a, b) => Number(b.metrics?.ret20 ?? -99) - Number(a.metrics?.ret20 ?? -99)))
  };
}

function getAdaptationScore(item: MarketAdaptationSample) {
  const phaseScore: Record<string, number> = {
    BREAKOUT: 34,
    SURGE: 31,
    SLOW_GRIND_UP: 30,
    TREND_UP: 28,
    RECOVERY: 22,
    TREND_TRANSITION: 18,
    HIGH_BASE: 10,
    SIDEWAYS: 8
  };
  const bias = Math.abs(Number(item.bias60 || 0));
  const biasScore = Math.max(0, 20 - bias * 120);
  const momentumScore = Math.max(-8, Math.min(18, Number(item.ret20 || 0) * 120));
  const volatilityPenalty = Math.max(0, Number(item.range20 || 0) * 20);
  return roundMetric((phaseScore[item.trend_phase_code || ''] || 0) + biasScore + momentumScore - volatilityPenalty, 2) || 0;
}

async function getSampledTradeDates(db: any, options: { latestTradeDate: string; lookbackDays: number; stride: number }) {
  const rows = await db.all(
    `SELECT DISTINCT trade_date
     FROM financial_daily_prices
     WHERE asset_type = 'stock'
       AND source = 'tushare'
       AND trade_date <= ?
       AND trade_date >= date(?, ?)
     ORDER BY trade_date ASC`,
    [options.latestTradeDate, options.latestTradeDate, `-${options.lookbackDays} days`]
  );
  const allDates = rows.map((row: any) => row.trade_date).filter(Boolean);
  return allDates.filter((_: string, index: number) => index % options.stride === 0);
}

async function loadMarketAdaptationSamples(
  db: any,
  options: { latestTradeDate: string; lookbackDays: number; stride: number; perDateStockLimit: number; perDateEtfLimit: number }
): Promise<MarketAdaptationSample[]> {
  const sampledDates = await getSampledTradeDates(db, {
    latestTradeDate: options.latestTradeDate,
    lookbackDays: options.lookbackDays,
    stride: options.stride
  });
  if (!sampledDates.length) return [];
  const datePlaceholders = sampledDates.map(() => '?').join(',');
  const phasePlaceholders = MARKET_ADAPTATION_PHASES.map(() => '?').join(',');
  const rows = await db.all(
    `WITH universe_meta AS (
       SELECT symbol, asset_type, source,
              MAX(name) AS name,
              GROUP_CONCAT(DISTINCT universe_type) AS universe_type
       FROM financial_asset_universe
       GROUP BY symbol, asset_type, source
     ),
     base AS (
       SELECT t.symbol, COALESCE(u.name, t.symbol) AS name, t.asset_type, t.source,
              t.trade_date, t.close, t.ma20, t.ma60, t.bias60, t.ret5, t.ret20,
              t.range20, t.cross60_10, t.trend_phase_code, u.universe_type,
              ROW_NUMBER() OVER (
                PARTITION BY t.trade_date, t.asset_type
                ORDER BY
                  CASE t.trend_phase_code
                    WHEN 'BREAKOUT' THEN 1
                    WHEN 'SLOW_GRIND_UP' THEN 2
                    WHEN 'TREND_UP' THEN 3
                    WHEN 'RECOVERY' THEN 4
                    WHEN 'TREND_TRANSITION' THEN 5
                    ELSE 8
                  END,
                  ABS(COALESCE(t.bias60, 9)),
                  t.symbol
              ) AS rn
       FROM financial_trend_phase_results t
       LEFT JOIN universe_meta u
         ON u.symbol = t.symbol
        AND u.asset_type = t.asset_type
        AND u.source = t.source
       WHERE t.asset_type IN ('stock', 'etf')
         AND t.source = 'tushare'
         AND t.trade_date IN (${datePlaceholders})
         AND t.trend_phase_code IN (${phasePlaceholders})
         AND COALESCE(t.close, 0) > 0
         AND COALESCE(t.ma60, 0) > 0
         AND COALESCE(t.bias60, 0) BETWEEN -0.12 AND 0.18
     )
     SELECT *
     FROM base
     WHERE (asset_type = 'stock' AND rn <= ?)
        OR (asset_type = 'etf' AND rn <= ?)
     ORDER BY trade_date DESC, asset_type, rn`,
    [...sampledDates, ...MARKET_ADAPTATION_PHASES, options.perDateStockLimit, options.perDateEtfLimit]
  );

  const latestByAsset = await getCoveredTradeDateMap(db);
  const samples = rows.map((row: any) => ({
    symbol: row.symbol,
    name: row.name,
    asset_type: row.asset_type,
    source: row.source || 'tushare',
    trade_date: row.trade_date,
    close: row.close === null ? null : Number(row.close),
    ma20: row.ma20 === null ? null : Number(row.ma20),
    ma60: row.ma60 === null ? null : Number(row.ma60),
    bias60: row.bias60 === null ? null : Number(row.bias60),
    ret5: row.ret5 === null ? null : Number(row.ret5),
    ret20: row.ret20 === null ? null : Number(row.ret20),
    range20: row.range20 === null ? null : Number(row.range20),
    cross60_10: row.cross60_10 === null ? null : Number(row.cross60_10),
    trend_phase_code: row.trend_phase_code,
    universe_type: row.universe_type,
    exposure: row.asset_type === 'etf'
      ? classifyAcceptanceExposureGroup({ symbol: row.symbol, name: row.name, universe_type: row.universe_type })
      : undefined,
    adaptationScore: 0
  })) as MarketAdaptationSample[];

  for (const sample of samples) {
    sample.adaptationScore = getAdaptationScore(sample);
    sample.metrics = await getForwardMetrics(db, {
      symbol: sample.symbol,
      asset_type: sample.asset_type,
      source: sample.source || 'tushare',
      trade_date: sample.trade_date,
      close: sample.close,
      maxTradeDate: latestByAsset[sample.asset_type as 'stock' | 'etf'] || options.latestTradeDate
    });
  }
  return samples;
}

async function enrichIndustryStrengthBuckets(db: any, samples: MarketAdaptationSample[], latestTradeDate: string, lookbackDays: number) {
  const stockSamples = samples.filter(item => item.asset_type === 'stock');
  if (!stockSamples.length) return;
  const symbols = [...new Set(stockSamples.map(item => item.symbol))];
  const symbolPlaceholders = symbols.map(() => '?').join(',');
  const members = await db.all(
    `SELECT symbol, l1_code, l1_name
     FROM financial_sw_industry_members
     WHERE symbol IN (${symbolPlaceholders})
       AND (out_date IS NULL OR out_date = '')
       AND l1_code IS NOT NULL`,
    symbols
  );
  const memberMap = new Map<string, any>();
  members.forEach((row: any) => memberMap.set(row.symbol, row));
  const industryCodes = [...new Set(members.map((row: any) => row.l1_code).filter(Boolean))];
  if (!industryCodes.length) return;

  const codePlaceholders = industryCodes.map(() => '?').join(',');
  const startDateModifier = `-${lookbackDays + 120} days`;
  const industryRows = await db.all(
    `SELECT index_code, name, trade_date, close
     FROM financial_sw_industry_daily
     WHERE source = 'tushare'
       AND index_code IN (${codePlaceholders})
       AND trade_date <= ?
       AND trade_date >= date(?, ?)
     ORDER BY index_code, trade_date ASC`,
    [...industryCodes, latestTradeDate, latestTradeDate, startDateModifier]
  );

  const byCode = new Map<string, any[]>();
  industryRows.forEach((row: any) => {
    if (!byCode.has(row.index_code)) byCode.set(row.index_code, []);
    byCode.get(row.index_code)?.push(row);
  });

  const rankInputByDate = new Map<string, any[]>();
  for (const rows of byCode.values()) {
    rows.forEach((row, index) => {
      const before20 = rows[index - 20];
      const close = toNumber(row.close, 0);
      const prev = toNumber(before20?.close, 0);
      if (!prev || !close) return;
      const ret20 = close / prev - 1;
      if (!rankInputByDate.has(row.trade_date)) rankInputByDate.set(row.trade_date, []);
      rankInputByDate.get(row.trade_date)?.push({
        code: row.index_code,
        name: row.name,
        ret20
      });
    });
  }

  const rankMap = new Map<string, any>();
  for (const [tradeDate, rows] of rankInputByDate.entries()) {
    const sorted = [...rows].sort((a, b) => a.ret20 - b.ret20);
    sorted.forEach((row, index) => {
      const rankPct = sorted.length > 1 ? index / (sorted.length - 1) : 0.5;
      rankMap.set(`${tradeDate}|${row.code}`, {
        code: row.code,
        name: row.name,
        ret20: roundMetric(row.ret20),
        rankPct: roundMetric(rankPct),
        bucket: rankPct >= 0.67 ? 'strong' : rankPct <= 0.33 ? 'weak' : 'neutral'
      });
    });
  }

  stockSamples.forEach(sample => {
    const member = memberMap.get(sample.symbol);
    const industry = member ? rankMap.get(`${sample.trade_date}|${member.l1_code}`) : null;
    sample.industry = industry || {
      code: member?.l1_code || null,
      name: member?.l1_name || null,
      ret20: null,
      rankPct: null,
      bucket: 'unknown'
    };
  });
}

async function buildCompositeGateByDate(db: any, latestTradeDate: string, lookbackDays: number, policyKey?: string | null) {
  const policy = resolveCompositeMarketGatePolicy(policyKey);
  const indexSymbols = ['000300', '000905', '399006', '000688'];
  const rows = await db.all(
    `SELECT symbol, trade_date, close
     FROM financial_daily_prices
     WHERE asset_type = 'index'
       AND source = 'tushare'
       AND symbol IN (${indexSymbols.map(() => '?').join(',')})
       AND trade_date <= ?
       AND trade_date >= date(?, ?)
     ORDER BY symbol, trade_date ASC`,
    [...indexSymbols, latestTradeDate, latestTradeDate, `-${lookbackDays + 160} days`]
  );
  const bySymbol = new Map<string, any[]>();
  rows.forEach((row: any) => {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol)?.push(row);
  });

  const indexFeature = new Map<string, any>();
  for (const [symbol, items] of bySymbol.entries()) {
    let aboveDays = 0;
    items.forEach((row, index) => {
      const close = toNumber(row.close, 0);
      const window60 = items.slice(Math.max(0, index - 59), index + 1).map(item => toNumber(item.close, 0)).filter(Boolean);
      const ma60 = window60.length >= 60 ? avg(window60) : null;
      const prevWindow = index >= 5 ? items.slice(Math.max(0, index - 64), index - 4).map(item => toNumber(item.close, 0)).filter(Boolean) : [];
      const ma60Prev = prevWindow.length >= 60 ? avg(prevWindow) : null;
      aboveDays = ma60 && close > ma60 ? aboveDays + 1 : 0;
      const allowed = Boolean(ma60 && close > ma60 && (!ma60Prev || Number(ma60) >= Number(ma60Prev) * 0.995) && aboveDays >= 2);
      indexFeature.set(`${row.trade_date}|${symbol}`, {
        symbol,
        close,
        ma60,
        ma60Prev,
        aboveDays,
        allowed
      });
    });
  }

  const breadthRows = await db.all(
    `SELECT trade_date, above_ma60_ratio, down_ratio, amount_ratio_5_20
     FROM financial_market_breadth_daily
     WHERE trade_date <= ?
       AND trade_date >= date(?, ?)
     ORDER BY trade_date ASC`,
    [latestTradeDate, latestTradeDate, `-${lookbackDays + 20} days`]
  );
  const breadthMap = new Map<string, any>();
  breadthRows.forEach((row: any) => breadthMap.set(row.trade_date, row));

  const gateMap = new Map<string, any>();
  const dates = [...new Set<string>(rows.map((row: any) => String(row.trade_date)))];
  dates.forEach(tradeDate => {
    const primary = indexFeature.get(`${tradeDate}|000300`);
    const secondary = ['000905', '399006', '000688']
      .map(symbol => indexFeature.get(`${tradeDate}|${symbol}`))
      .filter(Boolean);
    const secondaryAllowedCount = secondary.filter(item => item.allowed).length;
    const breadth = breadthMap.get(tradeDate);
    const primaryAllowed = Boolean(primary?.allowed);
    const breadthAboveMa60 = breadth ? Number(breadth.above_ma60_ratio) : null;
    const breadthDownRatio = breadth ? Number(breadth.down_ratio) : null;
    const decision = evaluateCompositeMarketGateDecision({
      primaryAllowed,
      secondaryAllowCount: secondaryAllowedCount,
      secondaryTotal: secondary.length,
      breadthAboveMa60: Number.isFinite(Number(breadthAboveMa60)) ? Number(breadthAboveMa60) : null,
      breadthDownRatio: Number.isFinite(Number(breadthDownRatio)) ? Number(breadthDownRatio) : null
    }, policy);
    const compositeAllowed = primaryAllowed && !decision.blocked;
    gateMap.set(tradeDate, {
      tradeDate,
      primaryAllowed,
      compositeAllowed,
      secondaryAllowedCount,
      secondaryTotal: secondary.length,
      decision: decision.decision,
      policy: decision.policy,
      hardBlocked: decision.blocked,
      observeOnly: primaryAllowed && !decision.blocked && decision.warned,
      hardBlockers: decision.hardBlockers,
      observeWarnings: decision.observeWarnings,
      downgradeReasons: decision.downgradeReasons,
      breadthBlocked: decision.blocked && decision.hardBlockers.some(reason => /宽度|下跌/.test(reason)),
      breadth: breadth
        ? {
            aboveMa60Ratio: roundMetric(Number(breadth.above_ma60_ratio)),
            downRatio: roundMetric(Number(breadth.down_ratio)),
            amountRatio5_20: roundMetric(Number(breadth.amount_ratio_5_20))
          }
        : null
    });
  });
  return gateMap;
}

function buildEarlyWatchAcceptance(samples: MarketAdaptationSample[]) {
  const earlyWatch = samples.filter(item =>
    EARLY_WATCH_PHASES.has(item.trend_phase_code || '')
    && Number(item.bias60 ?? 9) >= -0.02
    && Number(item.bias60 ?? 9) <= 0.1
    && Number(item.cross60_10 ?? 0) <= 4
  );
  const mature = samples.filter(item =>
    MATURE_STRUCTURE_PHASES.has(item.trend_phase_code || '')
    && Number(item.bias60 ?? 9) >= 0
    && Number(item.bias60 ?? 9) <= 0.08
  );
  const earlySummary = summarizePosterior(earlyWatch);
  const matureSummary = summarizePosterior(mature);
  return {
    key: 'early_watch_layer',
    title: '早期观察层',
    beforeLabel: '成熟结构样本',
    afterLabel: '早期观察样本',
    before: matureSummary,
    after: earlySummary,
    delta: comparePosterior(matureSummary, earlySummary),
    verdict: buildAdaptationVerdict(matureSummary, earlySummary, { mode: 'observe_only' }),
    examples: compactAdaptationExamples(earlyWatch.sort((a, b) => Number(b.metrics?.ret20 ?? -99) - Number(a.metrics?.ret20 ?? -99)))
  };
}

function buildIndustryStrengthAcceptance(samples: MarketAdaptationSample[]) {
  const stockSamples = samples.filter(item => item.asset_type === 'stock' && item.industry);
  const strong = stockSamples.filter(item => item.industry?.bucket === 'strong');
  const allowed = stockSamples.filter(item => item.industry?.bucket === 'strong' || item.industry?.bucket === 'neutral');
  const weak = stockSamples.filter(item => item.industry?.bucket === 'weak');
  const before = summarizePosterior(stockSamples.filter(item => item.industry?.bucket !== 'unknown'));
  const after = summarizePosterior(allowed);
  const blocked = summarizePosterior(weak);
  return {
    key: 'stock_industry_strength',
    title: '个股行业强弱',
    beforeLabel: '不看行业强弱',
    afterLabel: '强/中行业正常权重',
    blockedLabel: '弱行业降权观察',
    before,
    after,
    blocked,
    delta: comparePosterior(before, after),
    verdict: buildIndustryStrengthDowngradeVerdict(after, blocked),
    buckets: [
      { key: 'strong', label: '强行业', summary: summarizePosterior(strong) },
      { key: 'neutral', label: '中性行业', summary: summarizePosterior(stockSamples.filter(item => item.industry?.bucket === 'neutral')) },
      { key: 'weak', label: '弱行业', summary: blocked },
      { key: 'unknown', label: '未知行业', summary: summarizePosterior(stockSamples.filter(item => item.industry?.bucket === 'unknown')) }
    ],
    examples: compactAdaptationExamples(strong.sort((a, b) => Number(b.metrics?.ret20 ?? -99) - Number(a.metrics?.ret20 ?? -99)))
  };
}

function buildEtfDedupeAcceptance(samples: MarketAdaptationSample[]) {
  const etfSamples = samples
    .filter(item => item.asset_type === 'etf' && item.exposure?.dedupe)
    .map(item => ({ ...item, adaptationScore: item.adaptationScore ?? getAdaptationScore(item) }));
  const groups = new Map<string, MarketAdaptationSample[]>();
  etfSamples.forEach(item => {
    const key = `${item.trade_date}|${item.exposure?.key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(item);
  });

  const before: MarketAdaptationSample[] = [];
  const kept: MarketAdaptationSample[] = [];
  const removed: MarketAdaptationSample[] = [];
  const groupSummaries: any[] = [];
  for (const [key, items] of groups.entries()) {
    if (items.length <= 1) continue;
    const sorted = [...items].sort((a, b) => Number(b.adaptationScore || 0) - Number(a.adaptationScore || 0));
    before.push(...items);
    kept.push(sorted[0]);
    removed.push(...sorted.slice(1));
    groupSummaries.push({
      key,
      tradeDate: sorted[0].trade_date,
      label: sorted[0].exposure?.label,
      total: items.length,
      kept: { symbol: sorted[0].symbol, name: sorted[0].name },
      removed: sorted.slice(1, 6).map(item => ({ symbol: item.symbol, name: item.name }))
    });
  }

  const beforeSummary = summarizePosterior(before);
  const afterSummary = summarizePosterior(kept);
  const removedSummary = summarizePosterior(removed);
  return {
    key: 'etf_exposure_dedupe',
    title: 'ETF同质敞口去重',
    beforeLabel: '去重前同组ETF',
    afterLabel: '每组保留代表',
    blockedLabel: '被去重标的',
    before: beforeSummary,
    after: afterSummary,
    blocked: removedSummary,
    delta: comparePosterior(beforeSummary, afterSummary),
    verdict: buildAdaptationVerdict(beforeSummary, afterSummary, { blocked: removedSummary, mode: 'blocked_weaker', min20: 15 }),
    duplicateGroups: groupSummaries.slice(0, 12),
    examples: compactAdaptationExamples(kept.sort((a, b) => Number(b.metrics?.ret20 ?? -99) - Number(a.metrics?.ret20 ?? -99)))
  };
}

function buildCompositeGateAcceptance(samples: MarketAdaptationSample[], gateMap: Map<string, any>) {
  const withGate = samples
    .map(item => ({ ...item, gate: gateMap.get(item.trade_date) }))
    .filter((item: any) => item.gate);
  const before = withGate.filter((item: any) => item.gate.primaryAllowed);
  const after = withGate.filter((item: any) => item.gate.compositeAllowed);
  const blocked = withGate.filter((item: any) => item.gate.primaryAllowed && item.gate.hardBlocked);
  const observe = withGate.filter((item: any) => item.gate.observeOnly);
  const clean = withGate.filter((item: any) => item.gate.primaryAllowed && item.gate.compositeAllowed && !item.gate.observeOnly);
  const beforeSummary = summarizePosterior(before);
  const afterSummary = summarizePosterior(after);
  const blockedSummary = summarizePosterior(blocked);
  const observeSummary = summarizePosterior(observe);
  const cleanSummary = summarizePosterior(clean);
  const blockedReasonCounts = blocked.reduce((acc: Record<string, number>, item: any) => {
    const reasons = item.gate.hardBlockers?.length ? item.gate.hardBlockers : ['组合总闸硬封锁'];
    reasons.forEach((reason: string) => {
      acc[reason] = (acc[reason] || 0) + 1;
    });
    return acc;
  }, {});
  const observeReasonCounts = observe.reduce((acc: Record<string, number>, item: any) => {
    const reasons = item.gate.downgradeReasons?.length ? item.gate.downgradeReasons : ['组合总闸降权观察'];
    reasons.forEach((reason: string) => {
      acc[reason] = (acc[reason] || 0) + 1;
    });
    return acc;
  }, {});
  const policy = withGate.find((item: any) => item.gate.policy)?.gate.policy || null;
  return {
    key: 'composite_market_gate',
    title: '组合市场总闸',
    beforeLabel: '只看沪深300',
    afterLabel: '硬封锁后仍放行',
    blockedLabel: '硬封锁拦截',
    observeLabel: '降权/观察条件',
    before: beforeSummary,
    after: afterSummary,
    blocked: blockedSummary,
    observe: observeSummary,
    clean: cleanSummary,
    delta: comparePosterior(beforeSummary, afterSummary),
    verdict: buildCompositeGateVerdict(beforeSummary, afterSummary, blockedSummary, observeSummary, policy?.key),
    policy,
    blockedReasons: Object.entries(blockedReasonCounts).map(([label, total]) => ({ label, total })),
    observeReasons: Object.entries(observeReasonCounts).map(([label, total]) => ({ label, total })),
    examples: compactAdaptationExamples(blocked.sort((a: any, b: any) => Number(a.metrics?.ret20 ?? 99) - Number(b.metrics?.ret20 ?? 99)))
  };
}

async function buildMarketAdaptationAcceptance(
  db: any,
  options: {
    lookbackDays?: number;
    stride?: number;
    perDateStockLimit?: number;
    perDateEtfLimit?: number;
    gatePolicy?: string | null;
  } = {}
) {
  const latestTradeDate = await getLatestCoveredTradeDate(db, { assetTypes: ['stock'] })
    || await getLatestCoveredTradeDate(db, { assetTypes: ['etf'] });
  if (!latestTradeDate) {
    return {
      ruleVersion: MARKET_ADAPTATION_ACCEPTANCE_VERSION,
      status: 'empty',
      latestTradeDate: null,
      message: '本地还没有可用于后验的金融日线。'
    };
  }

  const lookbackDays = Math.max(180, Math.min(1600, Number(options.lookbackDays || 720)));
  const stride = Math.max(3, Math.min(15, Number(options.stride || 6)));
  const samples = await loadMarketAdaptationSamples(db, {
    latestTradeDate,
    lookbackDays,
    stride,
    perDateStockLimit: Math.max(10, Math.min(80, Number(options.perDateStockLimit || 28))),
    perDateEtfLimit: Math.max(8, Math.min(80, Number(options.perDateEtfLimit || 24)))
  });
  await enrichIndustryStrengthBuckets(db, samples, latestTradeDate, lookbackDays);
  const gatePolicy = resolveCompositeMarketGatePolicy(options.gatePolicy);
  const gateMap = await buildCompositeGateByDate(db, latestTradeDate, lookbackDays, gatePolicy.key);

  const sections = [
    buildEarlyWatchAcceptance(samples),
    buildOpportunityStyleAcceptance(samples),
    buildIndustryStrengthAcceptance(samples),
    buildEtfDedupeAcceptance(samples),
    buildCompositeGateAcceptance(samples, gateMap)
  ];
  const usable = sections.filter((section: any) => section.verdict?.status === 'supported' || section.verdict?.status === 'observe_supported').length;
  const needsReview = sections.filter((section: any) => section.verdict?.status === 'needs_review' || section.verdict?.status === 'observe_cautious').length;
  const insufficient = sections.filter((section: any) => section.verdict?.status === 'insufficient').length;

  return {
    ruleVersion: MARKET_ADAPTATION_ACCEPTANCE_VERSION,
    policy: {
      key: gatePolicy.key,
      ruleVersion: gatePolicy.ruleVersion,
      label: gatePolicy.label,
      note: gatePolicy.note
    },
    policyOptions: Object.values(COMPOSITE_MARKET_GATE_POLICIES).map(policy => ({
      key: policy.key,
      ruleVersion: policy.ruleVersion,
      label: policy.label,
      note: policy.note
    })),
    status: samples.length ? 'ready' : 'empty',
    latestTradeDate,
    sampleScope: {
      lookbackDays,
      stride,
      totalSamples: samples.length,
      stockSamples: samples.filter(item => item.asset_type === 'stock').length,
      etfSamples: samples.filter(item => item.asset_type === 'etf').length,
      note: `按历史走势阶段横截面抽样重放，不写库；未来 5/10/20 日只作为后验标签，不作为当日规则输入。组合总闸当前回放：${gatePolicy.label}。`
    },
    summary: {
      sectionCount: sections.length,
      usable,
      needsReview,
      insufficient,
      conclusion: needsReview > 0
        ? '已有规则开始贴近市场，但仍有规则需要继续调阈值，不能只看逻辑漂亮。'
        : insufficient > 0
          ? '部分规则 20日样本不足，先看 5/10日方向并继续滚动。'
          : '当前样本支持这些市场适配规则继续保留。'
    },
    sections
  };
}

function getDecisionSampleStageLabel(stageKey: string) {
  return DECISION_SAMPLE_STAGE_LABELS[stageKey] || stageKey;
}

function getDecisionSampleStatusCategory(status: string | null | undefined) {
  const value = String(status || '').toLowerCase();
  if (DECISION_SAMPLE_ADVANCED_STATUSES.has(value)) return 'advanced';
  if (DECISION_SAMPLE_BLOCKED_STATUSES.has(value)) return 'blocked';
  if (value.includes('fail') || value.includes('invalid')) return 'blocked';
  if (value.includes('wait') || value.includes('pending') || value.includes('unreviewed')) return 'tracking';
  return 'tracking';
}

function getDecisionSampleOutcome(metrics: ForwardMetrics) {
  if (metrics.brokeInvalidation) return '跌破失效';
  if (metrics.ret20 !== null && metrics.ret20 > 0) return '20日正收益';
  if (metrics.ret20 !== null && metrics.ret20 <= 0) return '20日负收益';
  if (metrics.ret10 !== null && metrics.ret10 > 0) return '10日正收益';
  if (metrics.ret10 !== null && metrics.ret10 <= 0) return '10日负收益';
  return '跟踪中';
}

function getCandidateStageStatus(row: any, stageKey: string) {
  const poolStatus = String(row.pool_status || 'active');
  const reviewStatus = String(row.review_status || 'unreviewed');
  const trendCode = String(row.trend_phase_code || '');
  if (poolStatus === 'expired') return reviewStatus === 'rejected' ? 'rejected' : 'expired';
  if (stageKey === 'candidate_pool') return poolStatus;
  if (stageKey === 'trend_phase') {
    if (reviewStatus === 'trend_blocked') return 'trend_blocked';
    if (['structure_pending', 'structure_watch', 'wait_confirmation', 'plan_ready'].includes(reviewStatus)) return 'trend_ready';
    if (['BREAKOUT', 'SLOW_GRIND_UP', 'RECOVERY'].includes(trendCode)) return 'trend_ready';
    return 'waiting';
  }
  if (stageKey === 'single_asset_check') {
    if (reviewStatus === 'structure_watch') return 'structure_watch';
    if (reviewStatus === 'wait_confirmation') return 'wait_confirmation';
    if (reviewStatus === 'plan_ready') return 'plan_ready';
    if (reviewStatus === 'rejected') return 'rejected';
    if (reviewStatus === 'structure_pending') return 'pending';
    return reviewStatus;
  }
  return reviewStatus;
}

function hasReachedSingleAssetCheck(row: any) {
  return ['structure_pending', 'structure_watch', 'wait_confirmation', 'plan_ready', 'rejected'].includes(String(row.review_status || ''));
}

function extractModelFromSnapshot(snapshot: any) {
  const prediction = snapshot?.ml_prediction?.prediction || snapshot?.mlPrediction?.prediction || snapshot?.model_prediction || {};
  const model = snapshot?.ml_prediction?.model || snapshot?.mlPrediction?.model || {};
  const probability = Number(
    prediction.probability ??
    snapshot?.model_probability ??
    snapshot?.modelProbability ??
    model.probability
  );
  return {
    modelKey: model.modelKey || model.model_key || snapshot?.model_key || snapshot?.modelKey || null,
    modelProbability: Number.isFinite(probability) ? probability : null,
    modelSignal: prediction.label || prediction.signal || snapshot?.model_signal || snapshot?.modelSignal || null
  };
}

function extractDecisionSampleRow(row: any) {
  return {
    id: row.id,
    sampleId: row.sample_id,
    stageKey: row.stage_key,
    stageLabel: getDecisionSampleStageLabel(row.stage_key),
    sourceType: row.source_type,
    sourceId: row.source_id,
    symbol: row.symbol,
    name: row.name,
    assetType: row.asset_type,
    source: row.source,
    tradeDate: row.trade_date,
    status: row.stage_status || row.current_status,
    currentStatus: row.current_status,
    stageStatus: row.stage_status,
    reason: row.reason,
    modelKey: row.model_key,
    modelProbability: row.model_probability,
    modelSignal: row.model_signal,
    score: parseJson(row.score_json, {}),
    context: parseJson(row.context_json, {}),
    snapshotDate: row.snapshot_date,
    closePrice: row.close_price,
    invalidationLine: row.invalidation_line,
    trendPhase: row.trend_phase_code,
    outcomeLabel: row.outcome_label,
    updatedAt: row.updated_at,
    metrics: {
      ret5: row.ret_5d,
      ret10: row.ret_10d,
      ret20: row.ret_20d,
      maxDrawdown20: row.max_drawdown_20d,
      brokeInvalidation: row.broke_invalidation === 1
    }
  };
}

function getModelCompareKey(item: any) {
  const probability = Number(item.modelProbability);
  if (!Number.isFinite(probability)) return 'no_model';
  const category = getDecisionSampleStatusCategory(item.stageStatus || item.status);
  if (probability >= 0.65 && category === 'advanced') return 'model_high_rule_passed';
  if (probability >= 0.65 && category === 'blocked') return 'model_high_rule_blocked';
  if (probability < 0.5 && category === 'advanced') return 'model_low_rule_passed';
  return 'model_neutral';
}

function getModelCompareLabel(key: string) {
  switch (key) {
    case 'model_high_rule_passed': return '模型高分 + 规则通过';
    case 'model_high_rule_blocked': return '模型高分 + 规则拦截';
    case 'model_low_rule_passed': return '模型低分 + 规则通过';
    case 'model_neutral': return '模型中性/低冲突';
    default: return '暂无模型分';
  }
}

async function upsertDecisionSample(db: any, item: any) {
  await db.run(
    `INSERT INTO finance_decision_samples
      (source_type, source_id, stage_key, symbol, name, asset_type, source, trade_date,
       current_status, stage_status, reason, rule_version, model_key, model_probability, model_signal,
       score_json, context_json, first_seen_at, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(source_type, source_id, stage_key) DO UPDATE SET
       symbol = excluded.symbol,
       name = excluded.name,
       asset_type = excluded.asset_type,
       source = excluded.source,
       trade_date = excluded.trade_date,
       current_status = excluded.current_status,
       stage_status = excluded.stage_status,
       reason = excluded.reason,
       rule_version = excluded.rule_version,
       model_key = excluded.model_key,
       model_probability = excluded.model_probability,
       model_signal = excluded.model_signal,
       score_json = excluded.score_json,
       context_json = excluded.context_json,
       first_seen_at = COALESCE(finance_decision_samples.first_seen_at, excluded.first_seen_at),
       last_seen_at = excluded.last_seen_at,
       updated_at = CURRENT_TIMESTAMP`,
    [
      item.sourceType,
      item.sourceId,
      item.stageKey,
      item.symbol,
      item.name || '',
      item.assetType || 'stock',
      item.source || 'tushare',
      item.tradeDate || null,
      item.currentStatus || null,
      item.stageStatus || null,
      item.reason || '',
      item.ruleVersion || DECISION_SUPPORT_RULE_VERSION,
      item.modelKey || null,
      item.modelProbability ?? null,
      item.modelSignal || null,
      JSON.stringify(item.score || {}),
      JSON.stringify(item.context || {}),
      item.firstSeenAt || null,
      item.lastSeenAt || item.firstSeenAt || null
    ]
  );
}

async function archiveStaleTradePlanSamples(db: any) {
  const staleDecisionRows = await db.all(
    `SELECT ds.id, ds.reason, COALESCE(p.status, 'archived') as archive_status
     FROM finance_decision_samples ds
     LEFT JOIN financial_trade_plans p
       ON ds.source_type = 'trade_plan'
      AND ds.source_id = p.id
     WHERE ds.source_type = 'trade_plan'
       AND (
         p.id IS NULL
         OR COALESCE(p.is_deleted, 0) = 1
       )
       AND (
         COALESCE(ds.current_status, '') NOT IN ('returned_to_entry_trigger', 'archived', 'deleted')
         OR COALESCE(ds.stage_status, '') NOT IN ('returned_to_entry_trigger', 'archived', 'deleted')
       )`
  );

  for (const row of staleDecisionRows) {
    const status = row.archive_status || 'archived';
    const reason = String(row.reason || '').startsWith('计划已回流/软删除')
      ? row.reason
      : `计划已回流/软删除，样本已归档，不再计入当前流程。${row.reason ? `原原因：${row.reason}` : ''}`;
    await db.run(
      `UPDATE finance_decision_samples
       SET current_status = ?,
           stage_status = ?,
           reason = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, status, reason, row.id]
    );
  }

  const staleFailureRows = await db.all(
    `SELECT fs.id, fs.reason, COALESCE(p.status, 'archived') as archive_status
     FROM finance_failure_samples fs
     LEFT JOIN financial_trade_plans p
       ON fs.source_type = 'trade_plan'
      AND fs.source_id = p.id
     WHERE fs.source_type = 'trade_plan'
       AND (
         p.id IS NULL
         OR COALESCE(p.is_deleted, 0) = 1
       )
       AND COALESCE(fs.followup_status, '') <> 'archived'`
  );

  for (const row of staleFailureRows) {
    const reason = String(row.reason || '').startsWith('计划已回流/软删除')
      ? row.reason
      : `计划已回流/软删除，失败样本归档保留，不再作为当前待处理失败样本。${row.reason ? `原原因：${row.reason}` : ''}`;
    await db.run(
      `UPDATE finance_failure_samples
       SET status = ?,
           followup_status = 'archived',
           reason = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [row.archive_status || 'archived', reason, row.id]
    );
  }

  return {
    decisionSamples: staleDecisionRows.length,
    failureSamples: staleFailureRows.length
  };
}

async function syncDecisionSamplesFromSources(db: any, options: { captureSnapshots?: boolean } = {}) {
  await ensureFinanceDecisionSupportSchema(db);
  let processed = 0;

  const candidateRows = await db.all(
    `SELECT c.id, c.symbol, c.name, c.asset_type, c.source, c.trade_date, c.close,
            c.pool_status, c.review_status, c.priority_score, c.trend_phase_code,
            c.trend_phase_reason, c.structure_status, c.safe_zone_status,
            c.invalidation_line, c.first_blocking_gate_label, c.candidate_reason,
            c.forbidden_reason, c.downgrade_reason, c.risk_note, c.rule_version,
            c.first_selected_at, c.last_checked_at, c.created_at, c.updated_at,
            c.gate_trace_json, r.model_key, r.model_probability, r.lane_label,
            m.market_regime, m.entry_permission AS market_entry_permission,
            m.rule_version AS market_rule_version
     FROM financial_candidate_pool c
     LEFT JOIN financial_candidate_reviews r ON r.id = c.last_review_id
     LEFT JOIN financial_market_regime m
       ON m.symbol = '000300'
      AND m.trade_date = c.trade_date
     WHERE c.asset_type IN ('stock', 'etf')
     ORDER BY COALESCE(c.updated_at, c.last_checked_at, c.created_at) DESC
     LIMIT 900`
  );

  for (const row of candidateRows) {
    const candidateReason = row.first_blocking_gate_label || row.candidate_reason || row.forbidden_reason || row.downgrade_reason || row.risk_note || row.trend_phase_reason || '';
    const base = {
      sourceType: 'candidate_pool',
      sourceId: row.id,
      symbol: row.symbol,
      name: row.name,
      assetType: row.asset_type,
      source: row.source,
      tradeDate: row.trade_date,
      currentStatus: row.pool_status,
      reason: candidateReason,
      ruleVersion: row.rule_version,
      modelKey: row.model_key,
      modelProbability: row.model_probability,
      modelSignal: row.lane_label,
      firstSeenAt: row.first_selected_at || row.created_at,
      lastSeenAt: row.updated_at || row.last_checked_at,
      score: {
        priorityScore: row.priority_score,
        invalidationLine: row.invalidation_line
      },
      context: {
        close: row.close,
        poolStatus: row.pool_status,
        reviewStatus: row.review_status,
        trendPhase: row.trend_phase_code,
        structureStatus: row.structure_status,
        safeZoneStatus: row.safe_zone_status,
        marketRegime: row.market_regime || null,
        marketEntryPermission: row.market_entry_permission || null,
        marketRuleVersion: row.market_rule_version || null,
        gateTrace: parseJson(row.gate_trace_json, [])
      }
    };

    for (const stageKey of ['candidate_pool', 'trend_phase']) {
      await upsertDecisionSample(db, {
        ...base,
        stageKey,
        stageStatus: getCandidateStageStatus(row, stageKey)
      });
      processed += 1;
    }

    if (hasReachedSingleAssetCheck(row)) {
      await upsertDecisionSample(db, {
        ...base,
        stageKey: 'single_asset_check',
        stageStatus: getCandidateStageStatus(row, 'single_asset_check')
      });
      processed += 1;
    }
  }

  const observationRows = await db.all(
    `SELECT *
     FROM financial_entry_trigger_observations
     WHERE asset_type IN ('stock', 'etf')
     ORDER BY COALESCE(updated_at, created_at) DESC
     LIMIT 600`
  );

  for (const row of observationRows) {
    const snapshot = parseJson(row.snapshot_json, {});
    const modelInfo = extractModelFromSnapshot(snapshot);
    const base = {
      sourceType: 'entry_observation',
      sourceId: row.id,
      symbol: row.symbol,
      name: row.name,
      assetType: row.asset_type,
      source: row.source,
      tradeDate: row.trade_date,
      currentStatus: row.observation_status,
      reason: row.trigger_reason || row.note || '',
      ruleVersion: snapshot?.rule_version || DECISION_SUPPORT_RULE_VERSION,
      modelKey: modelInfo.modelKey,
      modelProbability: modelInfo.modelProbability,
      modelSignal: modelInfo.modelSignal,
      firstSeenAt: row.created_at,
      lastSeenAt: row.updated_at,
      score: {
        triggerScore: row.trigger_score,
        structureScore: row.structure_score,
        invalidationLine: row.invalidation_line
      },
      context: {
        action: row.entry_action,
        actionLabel: row.action_label,
        trendPhase: row.trend_phase_code,
        marketRegime: row.market_regime,
        entryPermission: row.entry_permission,
        close: row.close_price,
        ma20: row.ma20,
        ma60: row.ma60,
        snapshot
      }
    };

    await upsertDecisionSample(db, {
      ...base,
      stageKey: 'entry_trigger',
      stageStatus: row.observation_status
    });
    processed += 1;

    const hasPlanReadySample = await db.get(
      `SELECT id
       FROM finance_decision_samples
       WHERE source_type = 'entry_observation'
         AND source_id = ?
         AND stage_key = 'plan_ready'
       LIMIT 1`,
      [row.id]
    );
    if (['confirmed', 'plan_candidate', 'planned'].includes(String(row.observation_status)) || hasPlanReadySample?.id) {
      await upsertDecisionSample(db, {
        ...base,
        stageKey: 'plan_ready',
        stageStatus: row.observation_status
      });
      processed += 1;
    }
  }

  const archived = await archiveStaleTradePlanSamples(db);
  processed += archived.decisionSamples + archived.failureSamples;

  const planRows = await db.all(
    `SELECT *
     FROM financial_trade_plans
     WHERE is_deleted = 0
     ORDER BY COALESCE(updated_at, created_at) DESC
     LIMIT 500`
  );

  for (const row of planRows) {
    const planQuality = buildFinancePlanQuality(row);
    const snapshot = parseJson(row.trigger_snapshot_json, {});
    const modelInfo = extractModelFromSnapshot(snapshot);
    await upsertDecisionSample(db, {
      sourceType: 'trade_plan',
      sourceId: row.id,
      stageKey: 'trade_plan',
      symbol: row.symbol,
      name: row.name,
      assetType: row.asset_type,
      source: row.source,
      tradeDate: row.trade_date,
      currentStatus: row.status,
      stageStatus: row.status,
      reason: row.trigger_reason || row.entry_reason || row.note || '',
      ruleVersion: snapshot?.rule_version || DECISION_SUPPORT_RULE_VERSION,
      modelKey: modelInfo.modelKey,
      modelProbability: modelInfo.modelProbability,
      modelSignal: modelInfo.modelSignal,
      firstSeenAt: row.created_at,
      lastSeenAt: row.updated_at,
      score: {
        triggerScore: row.trigger_score,
        structureScore: row.structure_score,
        planQualityScore: planQuality.score,
        planQualityLabel: planQuality.label,
        invalidationLine: row.invalidation_line,
        maxLossPercent: row.max_loss_percent
      },
      context: {
        close: row.close_price,
        trendPhase: row.trend_phase_code,
        marketRegime: row.market_regime,
        entryPermission: row.entry_permission,
        planProfile: row.plan_profile,
        snapshot
      }
    });
    processed += 1;
  }

  const snapshotResult = options.captureSnapshots ? await captureDecisionSampleSnapshots(db) : { processed: 0 };
  return { processed, snapshots: snapshotResult.processed };
}

async function shouldSyncEntryDecisionSamples(db: any) {
  await ensureFinanceDecisionSupportSchema(db);
  const row = await db.get(
    `SELECT
       (SELECT COUNT(*)
        FROM financial_entry_trigger_observations
        WHERE asset_type IN ('stock', 'etf')) AS observation_count,
       (SELECT COUNT(*)
        FROM financial_entry_trigger_observations
        WHERE asset_type IN ('stock', 'etf')
          AND observation_status IN ('confirmed', 'plan_candidate', 'planned')) AS plan_ready_observation_count,
       (SELECT COUNT(*)
        FROM finance_decision_samples
        WHERE source_type = 'entry_observation'
          AND stage_key = 'entry_trigger') AS entry_trigger_sample_count,
       (SELECT COUNT(*)
        FROM finance_decision_samples
        WHERE source_type = 'entry_observation'
          AND stage_key = 'plan_ready') AS plan_ready_sample_count,
       (SELECT MAX(updated_at)
        FROM financial_entry_trigger_observations
        WHERE asset_type IN ('stock', 'etf')) AS latest_observation_update,
       (SELECT MAX(last_seen_at)
        FROM finance_decision_samples
        WHERE source_type = 'entry_observation'
          AND stage_key IN ('entry_trigger', 'plan_ready')) AS latest_sample_seen`
  );

  const observationCount = Number(row?.observation_count || 0);
  const planReadyObservationCount = Number(row?.plan_ready_observation_count || 0);
  const entryTriggerSampleCount = Number(row?.entry_trigger_sample_count || 0);
  const planReadySampleCount = Number(row?.plan_ready_sample_count || 0);
  const latestObservationUpdate = row?.latest_observation_update ? String(row.latest_observation_update) : null;
  const latestSampleSeen = row?.latest_sample_seen ? String(row.latest_sample_seen) : null;

  return (observationCount > 0 && entryTriggerSampleCount < observationCount)
    || (planReadyObservationCount > 0 && planReadySampleCount < planReadyObservationCount)
    || Boolean(latestObservationUpdate && (!latestSampleSeen || latestObservationUpdate > latestSampleSeen));
}

async function captureDecisionSampleSnapshots(db: any) {
  await ensureFinanceDecisionSupportSchema(db);
  const snapshotDate = await getFinanceBusinessSnapshotDate(db);
  const samples = await db.all(
    `SELECT *
     FROM finance_decision_samples
     WHERE NOT (
       source_type = 'trade_plan'
       AND stage_key = 'trade_plan'
       AND COALESCE(stage_status, '') IN ('returned_to_entry_trigger', 'archived', 'deleted')
     )
     ORDER BY COALESCE(updated_at, created_at) DESC
     LIMIT 1800`
  );
  const coveredTradeDates = await getCoveredTradeDateMap(db);
  let processed = 0;

  for (const sample of samples) {
    const context = parseJson(sample.context_json, {});
    const score = parseJson(sample.score_json, {});
    const assetType = sample.asset_type || 'stock';
    const maxTradeDate = coveredTradeDates[assetType as 'stock' | 'etf'] || null;
    const latestPrice = await db.get(
      `SELECT trade_date, close
       FROM financial_daily_prices
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND (? IS NULL OR trade_date <= ?)
       ORDER BY trade_date DESC
       LIMIT 1`,
      [sample.symbol, assetType, sample.source || 'tushare', maxTradeDate, maxTradeDate]
    );
    const close = toNumber(context.close ?? context.entryPrice ?? latestPrice?.close, 0);
    const invalidationLine = toNumber(score.invalidationLine ?? context.invalidationLine, 0);
    const metrics = await getForwardMetrics(db, {
      symbol: sample.symbol,
      asset_type: assetType,
      source: sample.source || 'tushare',
      trade_date: sample.trade_date || sample.first_seen_at?.slice(0, 10),
      close,
      invalidation_line: invalidationLine,
      created_at: sample.first_seen_at,
      maxTradeDate
    });
    const outcomeLabel = getDecisionSampleOutcome(metrics);
    await db.run(
      `INSERT INTO finance_decision_sample_snapshots
        (sample_id, snapshot_date, stage_key, current_status, trade_date, close_price,
         invalidation_line, trend_phase_code, structure_score, trigger_score, plan_quality_score,
         model_probability, ret_5d, ret_10d, ret_20d, max_drawdown_20d, broke_invalidation,
         outcome_label, snapshot_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(sample_id, snapshot_date) DO UPDATE SET
         stage_key = excluded.stage_key,
         current_status = excluded.current_status,
         trade_date = excluded.trade_date,
         close_price = excluded.close_price,
         invalidation_line = excluded.invalidation_line,
         trend_phase_code = excluded.trend_phase_code,
         structure_score = excluded.structure_score,
         trigger_score = excluded.trigger_score,
         plan_quality_score = excluded.plan_quality_score,
         model_probability = excluded.model_probability,
         ret_5d = excluded.ret_5d,
         ret_10d = excluded.ret_10d,
         ret_20d = excluded.ret_20d,
         max_drawdown_20d = excluded.max_drawdown_20d,
         broke_invalidation = excluded.broke_invalidation,
         outcome_label = excluded.outcome_label,
         snapshot_json = excluded.snapshot_json,
         updated_at = CURRENT_TIMESTAMP`,
      [
        sample.id,
        snapshotDate,
        sample.stage_key,
        sample.stage_status || sample.current_status,
        sample.trade_date || sample.first_seen_at?.slice(0, 10) || null,
        close || null,
        invalidationLine || null,
        context.trendPhase || null,
        score.structureScore ?? null,
        score.triggerScore ?? null,
        score.planQualityScore ?? null,
        sample.model_probability ?? null,
        metrics.ret5,
        metrics.ret10,
        metrics.ret20,
        metrics.maxDrawdown20,
        metrics.brokeInvalidation ? 1 : 0,
        outcomeLabel,
        JSON.stringify({
          latestTradeDate: latestPrice?.trade_date || metrics.latestTradeDate,
          statusCategory: getDecisionSampleStatusCategory(sample.stage_status || sample.current_status),
          context,
          score
        })
      ]
    );
    processed += 1;
  }

  return { processed, snapshotDate };
}

async function getDecisionSampleTrackingSummary(db: any, options: { sync?: boolean } = {}) {
  await ensureFinanceDecisionSupportSchema(db);
  if (options.sync !== false) {
    await syncDecisionSamplesFromSources(db, { captureSnapshots: true });
  }

  const rows = await db.all(
    `WITH latest AS (
       SELECT sample_id, MAX(snapshot_date) as snapshot_date
       FROM finance_decision_sample_snapshots
       GROUP BY sample_id
     )
     SELECT s.*,
            ds.snapshot_date,
            ds.close_price,
            ds.invalidation_line,
            ds.trend_phase_code,
            ds.structure_score,
            ds.trigger_score,
            ds.plan_quality_score,
            ds.ret_5d,
            ds.ret_10d,
            ds.ret_20d,
            ds.max_drawdown_20d,
            ds.broke_invalidation,
            ds.outcome_label
     FROM finance_decision_samples s
     LEFT JOIN latest l ON l.sample_id = s.id
     LEFT JOIN finance_decision_sample_snapshots ds
       ON ds.sample_id = s.id
      AND ds.snapshot_date = l.snapshot_date
     WHERE NOT (
       s.source_type = 'trade_plan'
       AND s.stage_key = 'trade_plan'
       AND COALESCE(s.stage_status, '') IN ('returned_to_entry_trigger', 'archived', 'deleted')
     )
     ORDER BY COALESCE(s.updated_at, s.created_at) DESC
     LIMIT 1800`
  );
  const items: any[] = rows.map(extractDecisionSampleRow);
  const stageSummaries = DECISION_SAMPLE_STAGES.map(stage => {
    const stageItems = items.filter((item: any) => item.stageKey === stage.key);
    const categories = stageItems.reduce((acc: Record<string, number>, item: any) => {
      const category = getDecisionSampleStatusCategory(item.stageStatus || item.status);
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {});
    return {
      ...stage,
      total: stageItems.length,
      advanced: categories.advanced || 0,
      tracking: categories.tracking || 0,
      blocked: categories.blocked || 0,
      summary: summarize(stageItems)
    };
  });

  const compareMap = new Map<string, any[]>();
  items.forEach((item: any) => {
    const key = getModelCompareKey(item);
    compareMap.set(key, [...(compareMap.get(key) || []), item]);
  });
  const compareOrder = ['model_high_rule_passed', 'model_high_rule_blocked', 'model_low_rule_passed', 'model_neutral', 'no_model'];
  const modelCompare = compareOrder
    .map(key => {
      const groupItems = compareMap.get(key) || [];
      return {
        key,
        label: getModelCompareLabel(key),
        total: groupItems.length,
        summary: summarize(groupItems),
        items: groupItems.slice(0, 8)
      };
    })
    .filter(group => group.total > 0);

  return {
    totalSamples: items.length,
    snapshotCount: rows.filter((row: any) => row.snapshot_date).length,
    stages: stageSummaries,
    modelCompare,
    recentItems: items.slice(0, 40)
  };
}

function groupByTrend(items: any[]) {
  const groups = new Map<string, any[]>();
  items.forEach(item => {
    const key = item.trendPhase || 'UNKNOWN';
    groups.set(key, [...(groups.get(key) || []), item]);
  });
  return Array.from(groups.entries())
    .map(([trendPhase, rows]) => ({ trendPhase, ...summarize(rows) }))
    .sort((a, b) => b.total - a.total);
}

function splitUniverseTypes(value: string | null | undefined): string[] {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

const ROUTE_CORRECTION_OPTIONS = [
  { key: 'stock', label: 'A股个股', assetType: 'stock', universeType: 'stock_whitelist' },
  { key: 'broad_etf', label: '宽基权益ETF', assetType: 'etf', universeType: 'broad_etf' },
  { key: 'industry_etf', label: '行业/主题权益ETF', assetType: 'etf', universeType: 'industry_etf' },
  { key: 'commodity_etf', label: '商品/黄金ETF', assetType: 'etf', universeType: 'commodity_etf' },
  { key: 'cross_border_etf', label: 'QDII/跨境ETF', assetType: 'etf', universeType: 'cross_border_etf' },
  { key: 'special_fund', label: 'LOF/特殊基金', assetType: 'etf', universeType: 'special_fund' },
  { key: 'bond_cash_etf', label: '债券/货币ETF', assetType: 'etf', universeType: 'bond_cash_etf' },
  { key: 'market_anchor', label: '市场指数/总闸锚', assetType: 'index', universeType: 'broad_index' },
  { key: 'unknown_etf', label: '未归类ETF', assetType: 'etf', universeType: 'unknown_etf' }
];

function getRouteCorrectionOption(routeKey: string) {
  return ROUTE_CORRECTION_OPTIONS.find(option => option.key === routeKey);
}

function throwAssetRoutingError(message: string, status = 400): never {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  throw error;
}

async function writeAssetRoutingAuditLog(db: any, payload: {
  symbol: string;
  source: string;
  routeLabel: string;
  detail: Record<string, any>;
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
        `资产路由确认：${payload.symbol} -> ${payload.routeLabel}`,
        JSON.stringify(payload.detail),
        `${payload.symbol}|${payload.source}`,
        '/finance/asset-routing',
        now,
        now
      ]
    );
  } catch (error) {
    console.warn('Failed to write asset routing audit log:', error);
  }
}

function getAssetRouteReviewState(row: any, route: any, profile: any) {
  const fetchMessages = String(row.fetch_messages || row.last_fetch_message || '');
  const universeTypeText = String(row.universe_type || '');
  const manualConfirmed = fetchMessages.includes('资产路由手工确认');
  const reviewReasons: string[] = [];

  if (!manualConfirmed) reviewReasons.push('未人工确认');
  if (!route.currentPoolApplicable) reviewReasons.push('当前主流程未接入');
  if (route.key === 'unknown_etf' || route.key === 'other' || profile.key === 'etf_unknown' || universeTypeText.includes('unknown')) {
    reviewReasons.push('路由置信度低');
  }

  const confidence = reviewReasons.includes('路由置信度低')
    ? 'low'
    : (!manualConfirmed || !route.currentPoolApplicable ? 'medium' : 'high');

  return {
    manualConfirmed,
    routeConfidence: confidence,
    routeConfidenceLabel: confidence === 'high' ? '高置信' : confidence === 'medium' ? '中置信' : '低置信',
    reviewReasons
  };
}

function classifyAssetRoute(row: any) {
  const symbol = String(row.symbol || '');
  const assetType = String(row.asset_type || '');
  const name = String(row.name || '');
  const text = `${name} ${symbol}`;
  const typeSet = new Set(splitUniverseTypes(row.universe_type));
  const isIndustryByName = isIndustryThemeEtfLike({ name, symbol });
  const isBroadByName = isBroadEquityEtfLike({ name, symbol });

  if (assetType === 'stock') {
    return {
      key: 'stock',
      label: 'A股个股',
      targetPool: '个股备选池',
      currentWorkflow: '个股安全区 + 结构 + 流动性/市值 + 模型辅助',
      currentPoolApplicable: true,
      requiredChecks: ['ST/退市过滤', '近20日成交额', '近5日最低成交额', '流通市值', '极端交易状态'],
      note: '个股可以进入当前权益流程，但必须先过流动性、市值和极端交易过滤。'
    };
  }

  if (assetType === 'index') {
    return {
      key: 'market_anchor',
      label: '市场锚/宽基指数',
      targetPool: '市场总闸',
      currentWorkflow: '只做环境判断，不直接生成买入计划',
      currentPoolApplicable: false,
      requiredChecks: ['市场阶段', '趋势方向', '风险开关'],
      note: '指数主要用于判断环境和总闸，不当作交易标的直接入池。'
    };
  }

  if (assetType !== 'etf') {
    return {
      key: 'other',
      label: '其它金融资产',
      targetPool: '待归类池',
      currentWorkflow: '暂不进入权益主升流程',
      currentPoolApplicable: false,
      requiredChecks: ['先补资产类型', '再定义策略池'],
      note: '资产类型未接入当前路由，需要先明确底层资产和退出规则。'
    };
  }

  if (typeSet.has('bond_cash_etf') || /货币|快线|现金(?!流)|债|国债|地债|政金|城投|信用债|可转债|短融|同业存单|存单/.test(text)) {
    return {
      key: 'bond_cash_etf',
      label: '债券/货币ETF',
      targetPool: '低波动/配置池',
      currentWorkflow: '不走权益主升策略',
      currentPoolApplicable: false,
      requiredChecks: ['利率环境', '久期风险', '信用风险', '流动性'],
      note: '债券/货币ETF不适合用主升结构筛选，后续应单独做配置型规则。'
    };
  }

  if (typeSet.has('commodity_etf') || /黄金ETF|上海金|金ETF|白银|豆粕|商品|原油|能源化工|有色期货/.test(text)) {
    return {
      key: 'commodity_etf',
      label: '商品/黄金ETF',
      targetPool: '商品/贵金属观察池',
      currentWorkflow: '走商品或贵金属逻辑，不走A股权益总闸',
      currentPoolApplicable: false,
      requiredChecks: ['商品周期', '美元/利率', '避险状态', '期现结构', '流动性'],
      note: '商品/黄金ETF需要独立路由，不能和权益ETF混在同一套入池规则里。'
    };
  }

  if (typeSet.has('cross_border_etf') || /QDII|纳指|纳斯达克|标普|德国|法国|日经|东证|恒生|港股|中概|海外|美国|亚太|东南亚|沙特|印度/.test(text) || symbol.startsWith('513')) {
    return {
      key: 'cross_border_etf',
      label: 'QDII/跨境ETF',
      targetPool: '跨境ETF观察池',
      currentWorkflow: '先处理海外市场、汇率和折溢价，再谈计划',
      currentPoolApplicable: false,
      requiredChecks: ['海外市场趋势', '汇率', '折溢价', '额度/暂停申购', '交易时差'],
      note: '跨境ETF不能直接套A股节奏，必须先过折溢价和海外市场检查。'
    };
  }

  if (typeSet.has('special_fund') || /LOF|封闭|REIT|REITS|基础设施|创新未来|定开/.test(text)) {
    return {
      key: 'special_fund',
      label: 'LOF/特殊基金',
      targetPool: '特殊基金观察池',
      currentWorkflow: '高溢价一票否决，结构只做辅助',
      currentPoolApplicable: false,
      requiredChecks: ['折溢价', '场内流动性', '基金结构', '申赎限制'],
      note: 'LOF/特殊基金要先处理折溢价和基金结构风险，不能只看日线形态。'
    };
  }

  if (typeSet.has('industry_etf') || isIndustryByName) {
    return {
      key: 'industry_etf',
      label: '行业/主题权益ETF',
      targetPool: '行业主题池',
      currentWorkflow: '行业强度 + 自身结构 + 安全区',
      currentPoolApplicable: true,
      requiredChecks: ['行业强度', '相对沪深300强度', '自身结构', '安全区', '成交额'],
      note: isIndustryByName && !typeSet.has('industry_etf')
        ? 'ETF profile v2 按名称识别为行业/主题权益ETF，先纳入行业强度层。'
        : '行业/主题ETF要先看行业强度，再看自身结构，不和宽基完全同路。'
    };
  }

  if (typeSet.has('broad_etf') || isBroadByName) {
    return {
      key: 'broad_etf',
      label: '宽基权益ETF',
      targetPool: '宽基结构池',
      currentWorkflow: '市场总闸 + 自身结构 + 安全区',
      currentPoolApplicable: true,
      requiredChecks: ['市场总闸', '自身结构', '安全区', '成交额'],
      note: isBroadByName && !typeSet.has('broad_etf')
        ? 'ETF profile v2 按名称识别为宽基权益ETF，走宽基结构池。'
        : '宽基ETF可以走当前权益流程，但不需要行业强度层。'
    };
  }

  return {
    key: 'unknown_etf',
    label: '未归类ETF',
    targetPool: '待归类池',
    currentWorkflow: '暂不进入权益主升流程',
    currentPoolApplicable: false,
    requiredChecks: ['补充ETF分组', '确认底层资产', '定义适用规则'],
    note: 'ETF未识别为宽基、行业、商品、跨境、债券/货币或特殊基金，先别让它自动进交易池。'
  };
}

function getRouteV2Metadata(routeKey: string) {
  switch (routeKey) {
    case 'stock':
      return {
        strategyPool: '个股权益池',
        permissionStage: '备选',
        dedicatedRules: ['流动性过滤', '流通市值', '极端交易状态', '安全区', '结构成立', '账户风控'],
        modelUse: ['信号质量打分', '失败风险提示', '相似案例'],
        hardBlocks: ['ST/退市', '本地日线断档', '成交额过低', '流通市值过小', '极端交易状态'],
        nextAction: '符合条件后进入备选池，再走入场触发和计划质量评分。'
      };
    case 'broad_etf':
      return {
        strategyPool: '宽基权益ETF池',
        permissionStage: '备选',
        dedicatedRules: ['市场总闸', '宽基本身结构', '安全区', '成交额'],
        modelUse: ['辅助评分', '波动风险提示'],
        hardBlocks: ['市场总闸冻结', '趋势阶段不适合', '本地日线断档'],
        nextAction: '宽基不看行业强度，重点看总闸和自身结构。'
      };
    case 'industry_etf':
      return {
        strategyPool: '行业/主题ETF池',
        permissionStage: '备选',
        dedicatedRules: ['行业强度', '相对沪深300强度', '自身结构', '安全区', '成交额'],
        modelUse: ['行业强弱提示', '失败风险提示'],
        hardBlocks: ['行业强度不足', '趋势阶段不适合', '本地日线断档'],
        nextAction: '行业/主题ETF先过行业强度，再过自身结构。'
      };
    case 'commodity_etf':
      return {
        strategyPool: '商品/贵金属池',
        permissionStage: '观察',
        dedicatedRules: ['商品周期', '美元/利率', '避险状态', '期现结构', '流动性'],
        modelUse: ['风险提示', '相似阶段参考'],
        hardBlocks: ['未接入商品专属规则池', '折溢价/期现结构缺失'],
        nextAction: '先进入商品/贵金属观察，不自动套A股权益入池。'
      };
    case 'cross_border_etf':
      return {
        strategyPool: 'QDII/跨境ETF池',
        permissionStage: '观察',
        dedicatedRules: ['海外市场趋势', '汇率', '折溢价', '额度/暂停申购', '交易时差'],
        modelUse: ['折溢价风险提示', '海外市场联动提示'],
        hardBlocks: ['折溢价缺失', '海外市场未接入', '额度/申购状态未知'],
        nextAction: '先补跨境专属检查，不直接进入A股权益主升池。'
      };
    case 'special_fund':
      return {
        strategyPool: 'LOF/特殊基金池',
        permissionStage: '观察',
        dedicatedRules: ['折溢价', '场内流动性', '基金结构', '申赎限制'],
        modelUse: ['高溢价风险提示'],
        hardBlocks: ['高溢价', '流动性不足', '申赎限制不清'],
        nextAction: '高溢价一票否决，先补基金结构信息。'
      };
    case 'bond_cash_etf':
      return {
        strategyPool: '债券/货币配置池',
        permissionStage: '不看',
        dedicatedRules: ['利率环境', '久期风险', '信用风险', '流动性'],
        modelUse: ['配置风险提示'],
        hardBlocks: ['不适用主升策略'],
        nextAction: '不进入主升交易池，只做配置观察。'
      };
    default:
      return {
        strategyPool: '待归类池',
        permissionStage: '不看',
        dedicatedRules: ['补资产类型', '确认底层资产', '定义策略池'],
        modelUse: ['暂不使用模型给交易许可'],
        hardBlocks: ['未定义专属规则池'],
        nextAction: '先补资产路由，再决定是否进入观察或备选。'
      };
  }
}

function getFailureTypeLabel(type: string) {
  switch (type) {
    case 'plan_invalidated': return '计划跌破失效线';
    case 'plan_negative_20d': return '计划20日负收益';
    case 'false_breakout': return '假突破';
    case 'chased_high': return '追高失败';
    case 'blocked_then_rallied': return '风控拦截后上涨';
    case 'blocked_validated': return '风控拦截被验证';
    case 'model_high_rule_failed': return '模型高分但规则失败';
    default: return type;
  }
}

function getFailureRuleCategoryBySampleType(type: string) {
  switch (type) {
    case 'blocked_then_rallied': return '规则误杀';
    case 'blocked_validated': return '拦截有效';
    case 'false_breakout': return '假突破';
    case 'chased_high': return '追高失败';
    case 'model_high_rule_failed': return '模型高分但规则失败';
    case 'plan_invalidated':
    case 'plan_negative_20d':
      return '规则通过但后验失败';
    default:
      return '待归因';
  }
}

function getFailureFollowupStatusLabel(status?: string | null) {
  switch (status) {
    case 'needs_review': return '需要复盘';
    case 'validated': return '拦截有效';
    case 'invalidated': return '跌破失效';
    case 'failed': return '后验失败';
    case 'recovered': return '后验修复';
    case 'tracking': return '继续跟踪';
    case 'reviewed': return '已复盘';
    case 'archived': return '已归档';
    default: return status || '继续跟踪';
  }
}

function parseJson(value: any, fallback: any = null) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildFailureRuleCandidate(row: any) {
  const outcome = parseJson(row.outcome_json, {});
  const context = parseJson(row.context_json, {});
  const score = parseJson(row.score_json, {});
  const symbolLabel = `${row.symbol}${row.name ? ` ${row.name}` : ''}`;
  const ret20Text = outcome.ret20 !== undefined && outcome.ret20 !== null
    ? `20日 ${formatSignedPercent(outcome.ret20)}`
    : '20日后验未满';
  const modelText = score.modelProbability !== undefined && score.modelProbability !== null
    ? `模型概率 ${formatPercent(score.modelProbability)}`
    : '模型概率缺失';
  const baseEvidence = [
    row.reason,
    ret20Text,
    outcome.maxDrawdown20 !== undefined && outcome.maxDrawdown20 !== null ? `20日最大回撤 ${formatSignedPercent(outcome.maxDrawdown20)}` : null,
    context.trendPhase ? `走势 ${context.trendPhase}` : null,
    score.structureScore !== undefined && score.structureScore !== null ? `结构分 ${score.structureScore}` : null,
    score.triggerScore !== undefined && score.triggerScore !== null ? `触发分 ${score.triggerScore}` : null,
    modelText
  ].filter(Boolean).join('；');

  switch (row.sample_type) {
    case 'blocked_then_rallied':
      return {
        category: '规则误杀',
        title: `${symbolLabel} 被拦截后继续上涨`,
        hypothesis: '当前拦截条件可能过硬，存在把修复型或慢涨型结构误杀的风险。',
        suggestedRule: '把该类拦截拆成硬拦截和复核拦截：总闸/退市/ST继续硬拦，修复阶段和风险降级进入二次复核。',
        evidence: baseEvidence,
        nextAction: '到规则经验里沉淀“误杀复核”规则候选。'
      };
    case 'blocked_validated':
      return {
        category: '拦截有效',
        title: `${symbolLabel} 被拦截后走弱`,
        hypothesis: '当前拦截条件有效，应保留并统计命中场景。',
        suggestedRule: '把该样本加入拦截有效证据，避免后续为了召回率放松同类规则。',
        evidence: baseEvidence,
        nextAction: '沉淀为正向规则证据。'
      };
    case 'false_breakout':
      return {
        category: '假突破',
        title: `${symbolLabel} 出现假突破样本`,
        hypothesis: '突破确认不足或追高过滤不够，导致计划进入后失效。',
        suggestedRule: '突破类计划增加站稳天数、回踩确认、量能延续或失效线距离约束。',
        evidence: baseEvidence,
        nextAction: '生成“假突破过滤”规则候选。'
      };
    case 'chased_high':
      return {
        category: '追高失败',
        title: `${symbolLabel} 追高失败`,
        hypothesis: '入场点离失效线或均线过远，盈亏比被压缩。',
        suggestedRule: '追高区只允许观察或小仓训练，要求回踩确认后再进入计划。',
        evidence: baseEvidence,
        nextAction: '生成“防追高”规则候选。'
      };
    case 'model_high_rule_failed':
      return {
        category: '模型高分但规则失败',
        title: `${symbolLabel} 模型高分但规则不通过`,
        hypothesis: '模型高分不能绕过安全区、结构和总闸；此类样本适合做辅助复核和训练样本。',
        suggestedRule: '保留规则优先级，模型高分只触发复核队列，不直接进入计划准备。',
        evidence: baseEvidence,
        nextAction: '沉淀为“模型只做辅助”的规则证据。'
      };
    case 'plan_invalidated':
    case 'plan_negative_20d':
      return {
        category: '规则通过但后验失败',
        title: `${symbolLabel} 进入计划后后验失败`,
        hypothesis: '规则通过不等于交易质量合格，触发点、失效线或市场环境过滤仍需收紧。',
        suggestedRule: '回看触发类型、失效线距离和走势阶段，增加计划质量阈值或冷却条件。',
        evidence: baseEvidence,
        nextAction: '生成“计划后验失败”规则候选。'
      };
    default:
      return {
        category: '待归因',
        title: `${symbolLabel} 待归因失败样本`,
        hypothesis: '样本已经沉淀，但还需要人工归因到规则误杀、假突破、模型冲突或后验失败。',
        suggestedRule: '先补充复盘结论，再转为具体规则候选。',
        evidence: baseEvidence,
        nextAction: '标记需要复盘。'
      };
  }
}

function mapFailureSampleRow(row: any) {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sampleType: row.sample_type,
    sampleTypeLabel: getFailureTypeLabel(row.sample_type),
    symbol: row.symbol,
    name: row.name,
    assetType: row.asset_type,
    source: row.source,
    tradeDate: row.trade_date,
    status: row.status,
    reason: row.reason,
    scores: parseJson(row.score_json, {}),
    context: parseJson(row.context_json, {}),
    outcome: parseJson(row.outcome_json, {}),
    followupStatus: row.followup_status || 'tracking',
    followupStatusLabel: getFailureFollowupStatusLabel(row.followup_status || 'tracking'),
    ruleCandidate: buildFailureRuleCandidate(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function buildFailureFollowupStatus(sampleType: string, metrics: ForwardMetrics) {
  if (sampleType === 'blocked_then_rallied') return 'needs_review';
  if (sampleType === 'blocked_validated') return 'validated';
  if (metrics.brokeInvalidation) return 'invalidated';
  if (metrics.ret20 !== null && metrics.ret20 < 0) return 'failed';
  if (metrics.ret20 !== null && metrics.ret20 > 0) return 'recovered';
  return 'tracking';
}

async function upsertFailureSample(db: any, item: any, sampleType: string, reason: string) {
  const itemContext = item.context || parseJson(item.context_json, {});
  await db.run(
    `INSERT INTO finance_failure_samples
      (source_type, source_id, sample_type, symbol, name, asset_type, source, trade_date, status, reason,
       score_json, context_json, outcome_json, followup_status, followup_status_manual, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
     ON CONFLICT(source_type, source_id, sample_type) DO UPDATE SET
       symbol = excluded.symbol,
       name = excluded.name,
       asset_type = excluded.asset_type,
       source = excluded.source,
       trade_date = excluded.trade_date,
       status = excluded.status,
       reason = excluded.reason,
       score_json = excluded.score_json,
       context_json = excluded.context_json,
       outcome_json = excluded.outcome_json,
       followup_status = CASE
         WHEN COALESCE(finance_failure_samples.followup_status_manual, 0) = 1
           THEN finance_failure_samples.followup_status
         ELSE excluded.followup_status
       END,
       followup_status_manual = COALESCE(finance_failure_samples.followup_status_manual, 0),
       updated_at = CURRENT_TIMESTAMP`,
    [
      item.sourceType || 'sample_validation',
      item.id,
      sampleType,
      item.symbol,
      item.name || '',
      item.assetType || item.asset_type || 'stock',
      item.source || 'tushare',
      item.tradeDate || item.trade_date || null,
      item.status || null,
      reason,
      JSON.stringify({
        score: item.score ?? null,
        structureScore: item.structureScore ?? null,
        triggerScore: item.triggerScore ?? null,
        planQualityScore: item.planQualityScore ?? null,
        modelProbability: item.modelProbability ?? null
      }),
      JSON.stringify({
        ...itemContext,
        trendPhase: item.trendPhase ?? null,
        invalidationLine: item.invalidationLine ?? null,
        maxLossPercent: item.maxLossPercent ?? null,
        entryPrice: item.entryPrice ?? null,
        marketRegime: itemContext.marketRegime ?? itemContext.market_regime ?? item.marketRegime ?? item.market_regime ?? null,
        marketEntryPermission: itemContext.marketEntryPermission ?? itemContext.entryPermission ?? item.marketEntryPermission ?? null,
        reason: item.reason || ''
      }),
      JSON.stringify(item.metrics || {}),
      buildFailureFollowupStatus(sampleType, item.metrics || {})
    ]
  );
}

async function syncFailureSamplesFromSummary(db: any, payload: { plans: any[]; blockedCandidates: any[]; modelConflicts: any[] }) {
  await ensureFinanceDecisionSupportSchema(db);
  let processed = 0;

  for (const plan of payload.plans) {
    const sampleTypes: Array<{ type: string; reason: string }> = [];
    if (plan.stoppedOut || plan.status === 'invalidated' || plan.metrics?.brokeInvalidation) {
      sampleTypes.push({ type: 'plan_invalidated', reason: '计划跌破失效线或已确认失效，沉淀为失败样本。' });
    }
    if (plan.falseBreakout) sampleTypes.push({ type: 'false_breakout', reason: '计划反馈标记为假突破。' });
    if (plan.chasedHigh) sampleTypes.push({ type: 'chased_high', reason: '计划反馈标记为追高失败。' });
    if (plan.metrics?.ret20 !== null && plan.metrics?.ret20 < 0) {
      sampleTypes.push({ type: 'plan_negative_20d', reason: '进入计划后20个交易日仍为负收益。' });
    }

    for (const sample of sampleTypes) {
      await upsertFailureSample(db, { ...plan, sourceType: 'trade_plan' }, sample.type, sample.reason);
      processed += 1;
    }
  }

  for (const candidate of payload.blockedCandidates) {
    const rallied = (candidate.metrics?.ret20 !== null && candidate.metrics?.ret20 >= 0.1) || (candidate.metrics?.ret10 !== null && candidate.metrics?.ret10 >= 0.06);
    const validated = candidate.metrics?.ret20 !== null && candidate.metrics?.ret20 <= 0;
    if (!rallied && !validated) continue;
    await upsertFailureSample(
      db,
      { ...candidate, sourceType: 'candidate_pool' },
      rallied ? 'blocked_then_rallied' : 'blocked_validated',
      rallied ? '风控/规则拦截后后续上涨，需要复盘当时拦截是否合理。' : '风控/规则拦截后后续走弱，拦截效果被样本验证。'
    );
    processed += 1;
  }

  for (const item of payload.modelConflicts) {
    await upsertFailureSample(
      db,
      { ...item, sourceType: 'candidate_review' },
      'model_high_rule_failed',
      '模型高分但安全区/结构/规则未通过，只能作为复核和训练样本，不给开仓许可。'
    );
    processed += 1;
  }

  return { processed };
}

async function getFailureSampleSummary(db: any) {
  await ensureFinanceDecisionSupportSchema(db);
  const archived = await db.get(
    `SELECT COUNT(*) as count
     FROM finance_failure_samples
     WHERE COALESCE(followup_status, '') = 'archived'`
  );
  const rows = await db.all(
    `SELECT *
     FROM finance_failure_samples
     WHERE COALESCE(followup_status, '') <> 'archived'
     ORDER BY updated_at DESC
     LIMIT 120`
  );
  const groups = new Map<string, any[]>();
  rows.forEach((row: any) => groups.set(row.sample_type, [...(groups.get(row.sample_type) || []), row]));
  const ruleCandidateGroups = new Map<string, number>();
  rows.forEach((row: any) => {
    const candidate = buildFailureRuleCandidate(row);
    ruleCandidateGroups.set(candidate.category, (ruleCandidateGroups.get(candidate.category) || 0) + 1);
  });
  return {
    total: rows.length,
    archived: toNumber(archived?.count),
    groups: Array.from(groups.entries()).map(([type, items]) => ({
      type,
      label: getFailureTypeLabel(type),
      total: items.length
    })),
    ruleCandidates: {
      total: rows.length,
      groups: Array.from(ruleCandidateGroups.entries()).map(([category, total]) => ({ category, total }))
    },
    items: rows.slice(0, 40).map(mapFailureSampleRow)
  };
}

async function getFailureSampleList(db: any, filters: {
  sampleType?: string;
  followupStatus?: string;
  q?: string;
  includeArchived?: boolean;
  page?: number;
  pageSize?: number;
}) {
  await ensureFinanceDecisionSupportSchema(db);
  const where: string[] = [];
  const params: any[] = [];

  if (filters.sampleType && filters.sampleType !== 'all') {
    where.push('sample_type = ?');
    params.push(filters.sampleType);
  }

  if (filters.followupStatus && filters.followupStatus !== 'all') {
    where.push("COALESCE(followup_status, 'tracking') = ?");
    params.push(filters.followupStatus);
  } else if (!filters.includeArchived) {
    where.push("COALESCE(followup_status, '') <> 'archived'");
  }

  const keyword = (filters.q || '').trim();
  if (keyword) {
    where.push('(symbol LIKE ? OR name LIKE ? OR reason LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(Math.max(Number(filters.pageSize) || 10, 1), 100);
  const page = Math.max(Number(filters.page) || 1, 1);
  const offset = (page - 1) * pageSize;

  const [totalRow, archivedRow, rows, typeRows, statusRows, ruleTypeRows] = await Promise.all([
    db.get(`SELECT COUNT(*) as count FROM finance_failure_samples ${whereSql}`, params),
    db.get(`SELECT COUNT(*) as count FROM finance_failure_samples WHERE COALESCE(followup_status, '') = 'archived'`),
    db.all(
      `SELECT *
       FROM finance_failure_samples
       ${whereSql}
       ORDER BY updated_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    ),
    db.all(
      `SELECT sample_type as type, COUNT(*) as total
       FROM finance_failure_samples
       ${whereSql}
       GROUP BY sample_type
       ORDER BY total DESC`,
      params
    ),
    db.all(
      `SELECT COALESCE(followup_status, 'tracking') as status, COUNT(*) as total
       FROM finance_failure_samples
       ${whereSql}
       GROUP BY COALESCE(followup_status, 'tracking')
       ORDER BY total DESC`,
      params
    ),
    db.all(
      `SELECT sample_type as type, COUNT(*) as total
       FROM finance_failure_samples
       ${whereSql}
       GROUP BY sample_type`,
      params
    )
  ]);

  const ruleCandidateGroups = new Map<string, number>();
  ruleTypeRows.forEach((row: any) => {
    const category = getFailureRuleCategoryBySampleType(row.type);
    ruleCandidateGroups.set(category, (ruleCandidateGroups.get(category) || 0) + toNumber(row.total));
  });

  return {
    total: toNumber(totalRow?.count),
    page,
    pageSize,
    archived: toNumber(archivedRow?.count),
    groups: typeRows.map((row: any) => ({
      type: row.type,
      label: getFailureTypeLabel(row.type),
      total: toNumber(row.total)
    })),
    statusGroups: statusRows.map((row: any) => ({
      status: row.status,
      label: getFailureFollowupStatusLabel(row.status),
      total: toNumber(row.total)
    })),
    ruleCandidates: {
      total: toNumber(totalRow?.count),
      groups: Array.from(ruleCandidateGroups.entries()).map(([category, total]) => ({ category, total }))
    },
    items: rows.map(mapFailureSampleRow)
  };
}

function compactSampleSnapshotListItem(row: any) {
  const summary = parseJson(row.summary_json, {});
  return {
    id: row.id,
    snapshotDate: row.snapshot_date,
    ruleVersion: row.rule_version,
    summary: {
      qualityGate: summary.qualityGate || null,
      cards: summary.cards || [],
      failureSamples: {
        total: summary.failureSamples?.total || 0
      },
      decisionTracking: {
        totalSamples: summary.decisionTracking?.totalSamples || 0
      },
      signalLifecycles: {
        total: summary.signalLifecycles?.total || 0
      }
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getSampleValidationSnapshots(db: any) {
  await ensureFinanceDecisionSupportSchema(db);
  const rows = await db.all(
    `SELECT id, snapshot_date, rule_version, summary_json, created_at, updated_at
     FROM finance_sample_validation_snapshots
     ORDER BY snapshot_date DESC, id DESC
     LIMIT 20`
  );
  return rows.map(compactSampleSnapshotListItem);
}

async function persistSampleValidationSnapshot(db: any, summary: any) {
  const qualityGate = buildSampleSnapshotQuality(summary);
  const snapshotDate = await getFinanceBusinessSnapshotDate(db);
  if (!qualityGate.canSaveSnapshot) {
    return {
      saved: false,
      snapshotDate,
      ruleVersion: DECISION_SUPPORT_RULE_VERSION,
      qualityGate,
      message: `样本快照未保存：${qualityGate.blockers.join('；')}`
    };
  }

  await db.run(
    `INSERT INTO finance_sample_validation_snapshots
      (snapshot_date, rule_version, summary_json, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(snapshot_date, rule_version) DO UPDATE SET
       summary_json = excluded.summary_json,
       updated_at = CURRENT_TIMESTAMP`,
    [snapshotDate, DECISION_SUPPORT_RULE_VERSION, JSON.stringify(compactSnapshotSummary(summary))]
  );

  return {
    saved: true,
    snapshotDate,
    ruleVersion: DECISION_SUPPORT_RULE_VERSION,
    qualityGate,
    message: qualityGate.status === 'warning'
      ? `当前样本快照已保存，但存在提示：${qualityGate.warnings.join('；')}`
      : '当前样本快照已保存'
  };
}

async function refreshStaleSampleValidationSnapshot(db: any, summary: any) {
  const snapshotDate = await getFinanceBusinessSnapshotDate(db);
  const latest = await db.get(
    `SELECT id, snapshot_date, updated_at
     FROM finance_sample_validation_snapshots
     WHERE rule_version = ?
     ORDER BY snapshot_date DESC, id DESC
     LIMIT 1`,
    [DECISION_SUPPORT_RULE_VERSION]
  );
  const qualityGate = buildSampleSnapshotQuality(summary);
  const latestSnapshotDate = latest?.snapshot_date || null;
  const stale = !latestSnapshotDate || latestSnapshotDate < snapshotDate;

  if (!stale) {
    return {
      status: 'fresh',
      saved: false,
      snapshotDate,
      latestSnapshotDate,
      latestUpdatedAt: latest?.updated_at || null,
      qualityGate,
      message: '样本验证快照已是当前业务日。'
    };
  }

  if (!qualityGate.canSaveSnapshot) {
    return {
      status: 'stale_blocked',
      saved: false,
      snapshotDate,
      latestSnapshotDate,
      latestUpdatedAt: latest?.updated_at || null,
      qualityGate,
      message: `样本验证快照停在 ${latestSnapshotDate || '无'}，但当前质量门不允许自动保存：${qualityGate.blockers.join('；')}`
    };
  }

  const saved = await persistSampleValidationSnapshot(db, summary);
  return {
    status: 'auto_refreshed',
    saved: true,
    snapshotDate,
    latestSnapshotDate,
    latestUpdatedAt: latest?.updated_at || null,
    qualityGate: saved.qualityGate,
    message: latestSnapshotDate
      ? `样本验证快照已从 ${latestSnapshotDate} 自动补齐到 ${snapshotDate}。`
      : `样本验证快照已自动保存到 ${snapshotDate}。`
  };
}

function compactDecisionTrackingRecentItem(item: any) {
  const {
    context: _context,
    gateTrace: _gateTrace,
    gate_trace: _gateTraceSnake,
    gate_trace_json: _gateTraceJson,
    ...lightItem
  } = item || {};
  return lightItem;
}

function compactSampleSectionForResponse(section: any) {
  if (!section) return section;
  return {
    ...section,
    items: (section.items || []).slice(0, 12)
  };
}

function compactFailureSampleItemForResponse(item: any) {
  const {
    scores: _scores,
    context: _context,
    ...lightItem
  } = item || {};
  return lightItem;
}

function compactSampleValidationSummaryForResponse(summary: any) {
  return {
    ...summary,
    sections: summary.sections
      ? Object.fromEntries(
          Object.entries(summary.sections).map(([key, section]) => [
            key,
            compactSampleSectionForResponse(section)
          ])
        )
      : summary.sections,
    decisionTracking: summary.decisionTracking
      ? {
          ...summary.decisionTracking,
          modelCompare: (summary.decisionTracking.modelCompare || []).map((group: any) => {
            const { items: _items, ...lightGroup } = group;
            return lightGroup;
          }),
          recentItems: (summary.decisionTracking.recentItems || [])
            .slice(0, 18)
            .map(compactDecisionTrackingRecentItem)
        }
      : summary.decisionTracking,
    failureSamples: summary.failureSamples
      ? {
          ...summary.failureSamples,
          items: (summary.failureSamples.items || [])
            .slice(0, 12)
            .map(compactFailureSampleItemForResponse)
        }
      : summary.failureSamples,
    signalLifecycles: summary.signalLifecycles
      ? {
          ...summary.signalLifecycles,
          trainingQueue: summary.signalLifecycles.trainingQueue || [],
          recent: (summary.signalLifecycles.recent || []).slice(0, 12)
        }
      : summary.signalLifecycles,
    snapshots: (summary.snapshots || []).map((snapshot: any) => ({
      id: snapshot.id,
      snapshotDate: snapshot.snapshotDate,
      ruleVersion: snapshot.ruleVersion,
      summary: {
        qualityGate: snapshot.summary?.qualityGate || null,
        cards: snapshot.summary?.cards || [],
        failureSamples: {
          total: snapshot.summary?.failureSamples?.total || 0
        },
        decisionTracking: {
          totalSamples: snapshot.summary?.decisionTracking?.totalSamples || 0
        },
        signalLifecycles: {
          total: snapshot.summary?.signalLifecycles?.total || 0
        }
      },
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt
    }))
  };
}

function compactSnapshotSummary(summary: any) {
  const qualityGate = buildSampleSnapshotQuality(summary);
  return {
    qualityGate,
    cards: summary.cards,
    posteriorCoverage: summary.posteriorCoverage || buildPosteriorCoverage(summary.cards || []),
    planScoreBuckets: summary.planScoreBuckets,
    scoreBucketGroups: summary.scoreBucketGroups,
    decisionTracking: {
      totalSamples: summary.decisionTracking?.totalSamples || 0,
      stages: summary.decisionTracking?.stages || [],
      modelCompare: summary.decisionTracking?.modelCompare || []
    },
    trendFailure: summary.trendFailure,
    failureSamples: {
      total: summary.failureSamples?.total || 0,
      groups: summary.failureSamples?.groups || []
    },
    signalLifecycles: {
      total: summary.signalLifecycles?.total || 0,
      statusCards: summary.signalLifecycles?.statusCards || [],
      survivalByType: summary.signalLifecycles?.survivalByType || []
    },
    createdAt: new Date().toISOString()
  };
}

function getSummaryCardValue(summary: any, key: string) {
  const card = (summary.cards || []).find((item: any) => item.key === key);
  return toNumber(card?.value);
}

function buildPosteriorCoverage(cards: any[]) {
  const totalSamples = (cards || []).reduce((sum: number, card: any) => sum + toNumber(card.value), 0);
  const evaluable5 = (cards || []).reduce((sum: number, card: any) => sum + toNumber(card.summary?.evaluable5), 0);
  const evaluable10 = (cards || []).reduce((sum: number, card: any) => sum + toNumber(card.summary?.evaluable10), 0);
  const evaluable20 = (cards || []).reduce((sum: number, card: any) => sum + toNumber(card.summary?.evaluable20), 0);
  const pending5 = Math.max(0, totalSamples - evaluable5);
  const pending10 = Math.max(0, totalSamples - evaluable10);
  const pending20 = Math.max(0, totalSamples - evaluable20);
  const coverage5 = totalSamples > 0 ? roundMetric(evaluable5 / totalSamples) : null;
  const coverage10 = totalSamples > 0 ? roundMetric(evaluable10 / totalSamples) : null;
  const coverage20 = totalSamples > 0 ? roundMetric(evaluable20 / totalSamples) : null;
  const status = totalSamples <= 0
    ? 'empty'
    : evaluable20 > 0
      ? coverage20 !== null && coverage20 < 0.3
        ? 'low_coverage'
        : 'usable'
    : (evaluable10 > 0 || evaluable5 > 0)
      ? 'early'
      : 'immature';
  const message = status === 'empty'
    ? '暂无样本，不能验证规则。'
    : status === 'early'
      ? `20日后验尚未成熟；当前已有 5日 ${coverage5 === null ? '--' : `${(Number(coverage5) * 100).toFixed(1)}%`} / 10日 ${coverage10 === null ? '--' : `${(Number(coverage10) * 100).toFixed(1)}%`} 覆盖，只能看早期方向。`
      : status === 'immature'
      ? '当前样本还没有完成20日后验，只能观察流程，不能证明规则有效。'
      : status === 'low_coverage'
        ? `20日后验覆盖率 ${(Number(coverage20) * 100).toFixed(1)}%，验证结论只能作为早期提示。`
        : `20日后验覆盖率 ${(Number(coverage20) * 100).toFixed(1)}%，可以开始比较规则效果。`;
  return {
    status,
    totalSamples,
    evaluable5,
    evaluable10,
    evaluable20,
    pending5,
    pending10,
    pending20,
    coverage5,
    coverage10,
    coverage20,
    message,
    nextAction: evaluable20 > 0
      ? pending20 > 0
        ? '等待更多20日后验补齐；当前可以先做早期提示，不要把低覆盖率当规则胜率。'
        : '可以保存快照并比较规则版本。'
      : evaluable10 > 0 || evaluable5 > 0
        ? '先用5/10日验证规则方向，继续等待20日后验成熟后再定规则优劣。'
        : '等待后续交易日滚动后验，或先同步决策轨迹/失败样本。'
  };
}

function buildSampleSnapshotQuality(summary: any) {
  const totalCardSamples = (summary.cards || []).reduce((sum: number, item: any) => sum + toNumber(item.value), 0);
  const decisionSamples = toNumber(summary.decisionTracking?.totalSamples);
  const planSamples = getSummaryCardValue(summary, 'plan');
  const planFailureSamples = toNumber(summary.sections?.planFailures?.summary?.total);
  const failureSamples = toNumber(summary.failureSamples?.total);
  const scoreBucketGroups = Array.isArray(summary.scoreBucketGroups) ? summary.scoreBucketGroups : [];
  const populatedScoreGroups = scoreBucketGroups.filter((group: any) =>
    (group.buckets || []).some((bucket: any) => toNumber(bucket.total) > 0)
  ).length;
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (totalCardSamples <= 0) {
    blockers.push('样本验证卡片总样本数为 0，不能保存空快照。');
  }
  if (decisionSamples <= 0) {
    blockers.push('决策样本轨迹为空，请先同步决策轨迹后再保存快照。');
  }
  if (planFailureSamples > 0 && failureSamples <= 0) {
    blockers.push('已经存在计划失败样本，但失败样本库为空，请先同步失败样本。');
  }
  if (planSamples > 0 && populatedScoreGroups === 0) {
    blockers.push('计划样本存在，但触发分/结构分/计划质量分桶没有有效样本。');
  }
  const posterior = summary.posteriorCoverage || {};
  if (posterior.totalSamples > 0 && posterior.evaluable20 <= 0 && posterior.evaluable10 <= 0 && posterior.evaluable5 <= 0) {
    blockers.push('所有样本都未完成5/10/20日后验，不能保存为规则验收快照。');
  } else if (posterior.totalSamples > 0 && posterior.evaluable20 <= 0 && (posterior.evaluable10 > 0 || posterior.evaluable5 > 0)) {
    warnings.push('20日后验尚未成熟，本次快照只能作为5/10日早期观察，不作为最终规则胜率。');
  } else if (summary.posteriorCoverage?.coverage20 !== null && summary.posteriorCoverage?.coverage20 < 0.3) {
    warnings.push(`20日后验覆盖率只有 ${(Number(summary.posteriorCoverage.coverage20) * 100).toFixed(1)}%，快照只能作为早期观察。`);
  }
  if (failureSamples <= 0) {
    warnings.push('失败样本库当前为空；如果今天确实没有失败样本，可以忽略这条提示。');
  }

  return {
    status: blockers.length ? 'blocked' : warnings.length ? 'warning' : 'pass',
    canSaveSnapshot: blockers.length === 0,
    blockers,
    warnings,
    metrics: {
      totalCardSamples,
      decisionSamples,
      planSamples,
      planFailureSamples,
      failureSamples,
      populatedScoreGroups,
      posteriorCoverage5: summary.posteriorCoverage?.coverage5 ?? null,
      posteriorCoverage10: summary.posteriorCoverage?.coverage10 ?? null,
      posteriorCoverage20: summary.posteriorCoverage?.coverage20 ?? null,
      posteriorEvaluable5: summary.posteriorCoverage?.evaluable5 ?? 0,
      posteriorEvaluable10: summary.posteriorCoverage?.evaluable10 ?? 0,
      posteriorEvaluable20: summary.posteriorCoverage?.evaluable20 ?? 0,
      posteriorPending5: summary.posteriorCoverage?.pending5 ?? 0,
      posteriorPending10: summary.posteriorCoverage?.pending10 ?? 0,
      posteriorPending20: summary.posteriorCoverage?.pending20 ?? 0
    }
  };
}

async function buildSampleValidationSummary(
  db: any,
  options: { syncDecisionTracking?: boolean; syncFailureSamples?: boolean } = {}
) {
  await ensureFinanceDecisionSupportSchema(db);
  const coveredTradeDates = await getCoveredTradeDateMap(db);
  const withCoveredTradeDate = (row: any) => ({
    ...row,
    maxTradeDate: coveredTradeDates[(row.asset_type || 'stock') as 'stock' | 'etf'] || null
  });
  const candidateRows = await db.all(
    `SELECT id, symbol, name, asset_type, source, trade_date, close, pool_status, review_status,
            priority_score, trend_phase_code, invalidation_line, first_blocking_gate_label,
            forbidden_reason, downgrade_reason, risk_note, created_at, updated_at
     FROM financial_candidate_pool
     WHERE asset_type IN ('stock', 'etf')
     ORDER BY COALESCE(last_checked_at, updated_at, created_at) DESC
     LIMIT 260`
  );
  const planRows = await db.all(
    `SELECT id, plan_name, symbol, name, asset_type, source, trade_date, close_price as close,
            status, structure_score, trigger_score, trend_phase_code, invalidation_line,
            max_loss_percent, suggested_entry_zone, trigger_type, trigger_reason, entry_reason,
            perf_5d, perf_10d, perf_20d, stopped_out, false_breakout, chased_high,
            created_at, updated_at
     FROM financial_trade_plans
     WHERE is_deleted = 0
     ORDER BY created_at DESC
     LIMIT 220`
  );
  const modelConflictRows = await db.all(
    `SELECT r.id, r.candidate_id, r.symbol, r.name, r.asset_type, r.source, r.trade_date,
            c.close, c.pool_status, c.review_status, c.priority_score, c.trend_phase_code,
            c.invalidation_line, c.safe_zone_status, c.structure_status, c.forbidden_reason,
            c.downgrade_reason, c.risk_note, r.model_probability, r.lane_label, r.created_at
     FROM financial_candidate_reviews r
     LEFT JOIN financial_candidate_pool c
       ON c.id = r.candidate_id
     WHERE r.model_probability >= 0.65
       AND (
         COALESCE(c.safe_zone_status, '') <> 'SAFE_ZONE'
         OR COALESCE(c.structure_status, '') <> 'STRUCTURE_CONFIRMED'
         OR COALESCE(c.pool_status, '') = 'expired'
       )
     ORDER BY r.created_at DESC
     LIMIT 120`
  );
  const rejectedRows = await db.all(
    `SELECT id, title, project_name, track, decision_date, decision_stage,
            decision_quality, later_status, rejection_reason, risk_result
     FROM rejected_opportunities
     WHERE is_deleted = 0
     ORDER BY decision_date DESC, id DESC
     LIMIT 80`
  );

  const candidates = await Promise.all(candidateRows.map(async (row: any) => {
    const item = withCoveredTradeDate(row);
    return compactSample(item, await getForwardMetrics(db, item));
  }));
  const plans = await Promise.all(planRows.map(async (row: any) => {
    const item = withCoveredTradeDate(row);
    const planQuality = buildFinancePlanQuality(row);
    return compactSample({ ...item, plan_quality: planQuality }, await getForwardMetrics(db, item));
  }));
  const modelConflicts = await Promise.all(modelConflictRows.map(async (row: any) => {
    const item = withCoveredTradeDate(row);
    return compactSample(item, await getForwardMetrics(db, item));
  }));
  const syncDecisionTracking = options.syncDecisionTracking === true || await shouldSyncEntryDecisionSamples(db);

  const enteredCandidates = candidates.filter(item => ['active', 'planned'].includes(String(item.status)));
  const blockedCandidates = candidates.filter(item => String(item.status) === 'expired');
  const planInvalidations = plans.filter(item => item.metrics.brokeInvalidation || item.status === 'invalidated' || item.stoppedOut);
  const planFailures = plans.filter(item => item.metrics.brokeInvalidation || item.stoppedOut || (item.metrics.ret20 !== null && item.metrics.ret20 < 0));
  const syncResult = options.syncFailureSamples
    ? await syncFailureSamplesFromSummary(db, { plans, blockedCandidates, modelConflicts })
    : { processed: 0 };
  const cards = [
    { key: 'candidate', label: '备选池样本', value: enteredCandidates.length, summary: summarize(enteredCandidates) },
    { key: 'blocked', label: '规则拦截样本', value: blockedCandidates.length, summary: summarize(blockedCandidates) },
    { key: 'plan', label: '计划样本', value: plans.length, summary: summarize(plans) },
    { key: 'model_conflict', label: '模型冲突样本', value: modelConflicts.length, summary: summarize(modelConflicts) }
  ];

  const summary = {
    cards,
    posteriorCoverage: buildPosteriorCoverage(cards),
    sections: {
      enteredCandidates: { title: '进入备选池后的表现', summary: summarize(enteredCandidates), items: enteredCandidates.slice(0, 30) },
      blockedCandidates: { title: '被规则/风控拦截后的表现', summary: summarize(blockedCandidates), items: blockedCandidates.slice(0, 30) },
      plans: { title: '进入计划池后的表现', summary: summarize(plans), items: plans.slice(0, 30) },
      planInvalidations: { title: '跌破失效线计划', summary: summarize(planInvalidations), items: planInvalidations.slice(0, 30) },
      modelConflicts: { title: '模型高分但规则未通过', summary: summarize(modelConflicts), items: modelConflicts.slice(0, 30) },
      planFailures: { title: '计划失败样本', summary: summarize(planFailures), items: planFailures.slice(0, 30) }
    },
    scoreBucketGroups: [
      {
        key: 'triggerScore',
        title: '触发分桶验证',
        note: '更偏执行触发质量，能观察“触发偏弱是否更容易跌破失效线”。',
        buckets: summarizeScoreBuckets(plans, item => item.triggerScore)
      },
      {
        key: 'structureScore',
        title: '结构分桶验证',
        note: '更偏结构质量，能观察“结构分低是否更容易失败”。',
        buckets: summarizeScoreBuckets(plans, item => item.structureScore)
      },
      {
        key: 'planQualityScore',
        title: '计划质量分桶验证',
        note: '复用金融买入计划的综合计划质量分。',
        buckets: summarizeScoreBuckets(plans, item => item.planQualityScore)
      }
    ],
    planScoreBuckets: summarizeScoreBuckets(plans, item => item.planQualityScore),
    trendFailure: groupByTrend([...plans, ...blockedCandidates].filter(item => item.metrics.brokeInvalidation || (item.metrics.ret20 !== null && item.metrics.ret20 < 0))),
    rejectedOpportunities: {
      total: rejectedRows.length,
      reviewNeeded: rejectedRows.filter((row: any) => row.decision_quality === 'needs_review' || row.later_status === 'trigger_review').length,
      items: rejectedRows.slice(0, 20)
    },
    decisionTracking: await getDecisionSampleTrackingSummary(db, { sync: syncDecisionTracking }),
    failureSamples: await getFailureSampleSummary(db),
    signalLifecycles: await buildSignalLifecycleSummary(db),
    snapshots: await getSampleValidationSnapshots(db),
    permissionStages: PERMISSION_STAGES,
    modelBoundary: MODEL_BOUNDARY,
    syncResult
  };

  return summary;
}

async function applyAssetRouteConfirmation(db: any, payload: {
  symbol: string;
  source?: string;
  routeKey: string;
  name?: string;
  note?: string;
  batchId?: string;
}) {
  const symbol = String(payload.symbol || '').trim();
  const source = String(payload.source || 'tushare').trim();
  const routeKey = String(payload.routeKey || '').trim();
  const option = getRouteCorrectionOption(routeKey);
  if (!/^\d{6}$/.test(symbol)) {
    throwAssetRoutingError('请输入6位标的代码');
  }
  if (!option) {
    throwAssetRoutingError('缺少有效的路由类型');
  }

  const existingRows = await db.all(
    `SELECT symbol, name, asset_type, universe_type, source, enabled, last_fetch_message
     FROM financial_asset_universe
     WHERE symbol = ?
       AND source = ?`,
    [symbol, source]
  );
  const activeRows = existingRows.filter((row: any) => toNumber(row.enabled) === 1);
  const name = String(
    payload.name
    || activeRows.find((row: any) => row.name)?.name
    || existingRows.find((row: any) => row.name)?.name
    || ''
  ).trim();
  const beforeUniverseTypes = Array.from(new Set(activeRows.map((row: any) => row.universe_type).filter(Boolean)));
  const beforeAssetTypes = Array.from(new Set(activeRows.map((row: any) => row.asset_type).filter(Boolean)));
  const beforeRoute = activeRows.length
    ? { ...classifyAssetRoute({
        symbol,
        name,
        asset_type: activeRows[0].asset_type,
        universe_type: beforeUniverseTypes.join(',')
      }), ...getRouteV2Metadata(classifyAssetRoute({
        symbol,
        name,
        asset_type: activeRows[0].asset_type,
        universe_type: beforeUniverseTypes.join(',')
      }).key) }
    : null;

  const now = new Date().toISOString();
  const note = String(payload.note || '').trim();
  const message = [
    `资产路由手工确认：${option.label}`,
    note,
    payload.batchId ? `批次 ${payload.batchId}` : ''
  ].filter(Boolean).join('；');
  const profile = resolveFinancePlanProfile({
    assetType: option.assetType,
    symbol,
    name,
    universeType: option.universeType
  });

  const disabledResult = await db.run(
    `UPDATE financial_asset_universe
     SET enabled = 0,
         last_fetch_message = ?,
         updated_at = ?
     WHERE symbol = ?
       AND source = ?
       AND (COALESCE(asset_type, '') <> ? OR COALESCE(universe_type, '') <> ?)`,
    [message, now, symbol, source, option.assetType, option.universeType]
  );

  await db.run(
    `INSERT INTO financial_asset_universe (
       symbol, name, asset_type, universe_type, source, enabled, update_status, last_fetch_message, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?)
     ON CONFLICT(symbol, asset_type, universe_type, source) DO UPDATE SET
       enabled = 1,
       name = COALESCE(NULLIF(excluded.name, ''), financial_asset_universe.name),
       last_fetch_message = excluded.last_fetch_message,
       updated_at = excluded.updated_at`,
    [symbol, name, option.assetType, option.universeType, source, message, now]
  );

  const candidateResult = await db.run(
    `UPDATE financial_candidate_pool
     SET asset_type = ?,
         plan_profile = ?,
         plan_profile_label = ?,
         updated_at = ?
     WHERE symbol = ?
       AND source = ?
       AND pool_status = 'active'`,
    [option.assetType, profile.key, profile.label, now, symbol, source]
  );
  const planResult = await db.run(
    `UPDATE financial_trade_plans
     SET asset_type = ?,
         plan_profile = ?,
         plan_profile_label = ?,
         plan_profile_note = ?,
         updated_at = ?
     WHERE symbol = ?
       AND source = ?
       AND is_deleted = 0
       AND status IN ('draft', 'watching', 'paper_tracking', 'active')`,
    [option.assetType, profile.key, profile.label, profile.note, now, symbol, source]
  );
  const baseRoute = classifyAssetRoute({
    symbol,
    name,
    asset_type: option.assetType,
    universe_type: option.universeType
  });
  const route = { ...baseRoute, ...getRouteV2Metadata(baseRoute.key) };
  const changed = {
    disabled_universe_rows: disabledResult?.changes || 0,
    active_candidates: candidateResult?.changes || 0,
    active_plans: planResult?.changes || 0
  };
  const before = {
    assetTypes: beforeAssetTypes,
    universeTypes: beforeUniverseTypes,
    routeKey: beforeRoute?.key || null,
    routeLabel: beforeRoute?.label || null
  };
  const after = {
    assetType: option.assetType,
    universeType: option.universeType,
    routeKey: route.key,
    routeLabel: route.label,
    profileKey: profile.key,
    profileLabel: profile.label
  };

  await writeAssetRoutingAuditLog(db, {
    symbol,
    source,
    routeLabel: option.label,
    detail: {
      before,
      after,
      changed,
      note,
      batchId: payload.batchId || null
    }
  });

  return {
    symbol,
    name,
    source,
    asset_type: option.assetType,
    universe_type: option.universeType,
    profile: {
      key: profile.key,
      label: profile.label,
      note: profile.note,
      allowsTradePlan: profile.allowsTradePlan
    },
    route,
    before,
    after,
    changed
  };
}

router.get('/asset-routing/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const universeRows = await db.all(
      `SELECT symbol,
              COALESCE(MAX(NULLIF(name, '')), '') as name,
              asset_type,
              source,
              GROUP_CONCAT(DISTINCT universe_type) as universe_type,
              GROUP_CONCAT(DISTINCT last_fetch_message) as fetch_messages,
              MAX(total_count) as total_count,
              MAX(last_trade_date) as last_trade_date,
              MAX(update_status) as update_status
       FROM financial_asset_universe
       WHERE enabled = 1
       GROUP BY symbol, asset_type, source`
    );
    const candidateRows = await db.all(
      `SELECT symbol, asset_type, source, COUNT(*) as active_count
       FROM financial_candidate_pool
       WHERE pool_status = 'active'
       GROUP BY symbol, asset_type, source`
    );
    const planRows = await db.all(
      `SELECT symbol, asset_type, source, COUNT(*) as active_count
       FROM financial_trade_plans
       WHERE is_deleted = 0
         AND status IN ('draft', 'watching', 'paper_tracking', 'active')
       GROUP BY symbol, asset_type, source`
    );

    const candidateMap = new Map(candidateRows.map((row: any) => [`${row.symbol}|${row.asset_type}|${row.source}`, toNumber(row.active_count)]));
    const planMap = new Map(planRows.map((row: any) => [`${row.symbol}|${row.asset_type}|${row.source}`, toNumber(row.active_count)]));
    const routeMap = new Map<string, any>();

    const items = universeRows.map((row: any) => {
      const baseRoute = classifyAssetRoute(row);
      const route = { ...baseRoute, ...getRouteV2Metadata(baseRoute.key) };
      const compactRoute = {
        key: route.key,
        label: route.label,
        targetPool: route.targetPool,
        permissionStage: route.permissionStage,
        currentPoolApplicable: route.currentPoolApplicable
      };
      const planProfile = resolveFinancePlanProfile({
        assetType: row.asset_type,
        symbol: row.symbol,
        name: row.name,
        universeType: row.universe_type
      });
      const key = `${row.symbol}|${row.asset_type}|${row.source}`;
      const item = {
        symbol: row.symbol,
        name: row.name,
        assetType: row.asset_type,
        source: row.source,
        universeType: row.universe_type,
        totalCount: row.total_count,
        lastTradeDate: row.last_trade_date,
        updateStatus: row.update_status,
        activeCandidates: candidateMap.get(key) || 0,
        activePlans: planMap.get(key) || 0,
        profile: {
          key: planProfile.key,
          label: planProfile.label,
          note: planProfile.note,
          allowsTradePlan: planProfile.allowsTradePlan
        },
        review: getAssetRouteReviewState(row, route, planProfile),
        route: compactRoute
      };
      const current = routeMap.get(route.key) || {
        key: route.key,
        label: route.label,
        targetPool: route.targetPool,
        currentWorkflow: route.currentWorkflow,
        currentPoolApplicable: route.currentPoolApplicable,
        requiredChecks: route.requiredChecks,
        note: route.note,
        strategyPool: route.strategyPool,
        permissionStage: route.permissionStage,
        dedicatedRules: route.dedicatedRules,
        modelUse: route.modelUse,
        hardBlocks: route.hardBlocks,
        nextAction: route.nextAction,
        total: 0,
        activeCandidates: 0,
        activePlans: 0,
        profileCounts: {}
      };
      current.total += 1;
      current.activeCandidates += item.activeCandidates;
      current.activePlans += item.activePlans;
      current.profileCounts[item.profile.key] = (current.profileCounts[item.profile.key] || 0) + 1;
      routeMap.set(route.key, current);
      return item;
    });

    const routeOrder = ['stock', 'broad_etf', 'industry_etf', 'commodity_etf', 'cross_border_etf', 'special_fund', 'bond_cash_etf', 'market_anchor', 'unknown_etf', 'other'];
    const routes = Array.from(routeMap.values()).sort((a, b) => {
      const orderA = routeOrder.indexOf(a.key);
      const orderB = routeOrder.indexOf(b.key);
      return (orderA === -1 ? 99 : orderA) - (orderB === -1 ? 99 : orderB);
    });

    res.json({
      success: true,
      data: {
        routes,
        items: items
          .sort((a: any, b: any) => (b.activePlans + b.activeCandidates) - (a.activePlans + a.activeCandidates))
          .slice(0, 120),
        totals: {
          assets: items.length,
          currentWorkflowAssets: items.filter((item: any) => item.route.currentPoolApplicable).length,
          outsideWorkflowAssets: items.filter((item: any) => !item.route.currentPoolApplicable).length,
          activeCandidates: items.reduce((sum: number, item: any) => sum + item.activeCandidates, 0),
          activePlans: items.reduce((sum: number, item: any) => sum + item.activePlans, 0)
        },
        routeCorrectionOptions: ROUTE_CORRECTION_OPTIONS,
        permissionStages: PERMISSION_STAGES,
        modelBoundary: MODEL_BOUNDARY
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取资产类型路由失败：${(error as Error).message}` });
  }
});

router.post('/asset-routing/confirm', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const data = await applyAssetRouteConfirmation(db, {
      symbol: req.body.symbol,
      source: req.body.source,
      routeKey: req.body.route_key || req.body.routeKey,
      name: req.body.name,
      note: req.body.note || '资产类型路由页手工确认'
    });

    res.json({
      success: true,
      message: `${data.symbol} 已确认路由为${data.route.label}`,
      data
    });
  } catch (error) {
    res.status((error as any).status || 500).json({ success: false, message: `确认资产路由失败：${(error as Error).message}` });
  }
});

router.post('/asset-routing/batch-confirm', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ success: false, message: '请选择需要批量确认的标的' });
    }
    if (items.length > 50) {
      return res.status(400).json({ success: false, message: '一次最多批量确认 50 个标的' });
    }

    const batchId = `asset-routing-${Date.now()}`;
    const results: any[] = [];
    await db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        const result = await applyAssetRouteConfirmation(db, {
          symbol: item.symbol,
          source: item.source,
          routeKey: item.route_key || item.routeKey,
          name: item.name,
          note: item.note || '资产类型路由页批量确认',
          batchId
        });
        results.push(result);
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    res.json({
      success: true,
      message: `已批量确认 ${results.length} 个资产路由`,
      data: {
        batchId,
        total: results.length,
        changed: results.reduce((sum, item) => ({
          disabled_universe_rows: sum.disabled_universe_rows + (item.changed?.disabled_universe_rows || 0),
          active_candidates: sum.active_candidates + (item.changed?.active_candidates || 0),
          active_plans: sum.active_plans + (item.changed?.active_plans || 0)
        }), { disabled_universe_rows: 0, active_candidates: 0, active_plans: 0 }),
        items: results
      }
    });
  } catch (error) {
    res.status((error as any).status || 500).json({ success: false, message: `批量确认资产路由失败：${(error as Error).message}` });
  }
});

router.get('/sample-validation/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const data: any = await buildSampleValidationSummary(db);
    const snapshotFreshness = await refreshStaleSampleValidationSnapshot(db, data);
    if (snapshotFreshness.saved) {
      data.snapshots = await getSampleValidationSnapshots(db);
    }
    data.snapshotFreshness = snapshotFreshness;
    res.json({ success: true, data: compactSampleValidationSummaryForResponse(data) });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取样本验证失败：${(error as Error).message}` });
  }
});

router.get('/market-adaptation/acceptance', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const options = {
      lookbackDays: req.query.lookback_days ? Number(req.query.lookback_days) : undefined,
      stride: req.query.stride ? Number(req.query.stride) : undefined,
      perDateStockLimit: req.query.stock_limit ? Number(req.query.stock_limit) : undefined,
      perDateEtfLimit: req.query.etf_limit ? Number(req.query.etf_limit) : undefined,
      gatePolicy: req.query.gate_policy ? String(req.query.gate_policy) : undefined
    };
    const cacheKey = JSON.stringify(options);
    if (marketAdaptationAcceptanceCache?.key === cacheKey && marketAdaptationAcceptanceCache.expiresAt > Date.now()) {
      return res.json({
        success: true,
        data: {
          ...marketAdaptationAcceptanceCache.data,
          cache: { hit: true, ttl_ms: MARKET_ADAPTATION_ACCEPTANCE_CACHE_TTL_MS }
        }
      });
    }

    const data = await buildMarketAdaptationAcceptance(db, options);
    marketAdaptationAcceptanceCache = {
      key: cacheKey,
      expiresAt: Date.now() + MARKET_ADAPTATION_ACCEPTANCE_CACHE_TTL_MS,
      data
    };
    res.json({
      success: true,
      data: {
        ...data,
        cache: { hit: false, ttl_ms: MARKET_ADAPTATION_ACCEPTANCE_CACHE_TTL_MS }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取市场适配验收失败：${(error as Error).message}` });
  }
});

router.post('/sample-validation/snapshot', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceDecisionSupportSchema(db);
    const summary = await buildSampleValidationSummary(db, {
      syncDecisionTracking: true,
      syncFailureSamples: true
    });
    const snapshotResult = await persistSampleValidationSnapshot(db, summary);
    if (!snapshotResult.saved) {
      return res.status(409).json({
        success: false,
        message: snapshotResult.message,
        data: { qualityGate: snapshotResult.qualityGate }
      });
    }
	    res.json({
	      success: true,
	      message: snapshotResult.message,
	      data: {
	        snapshotDate: snapshotResult.snapshotDate,
	        ruleVersion: snapshotResult.ruleVersion,
	        qualityGate: snapshotResult.qualityGate,
	        snapshots: await getSampleValidationSnapshots(db)
	      }
	    });
  } catch (error) {
    res.status(500).json({ success: false, message: `保存样本快照失败：${(error as Error).message}` });
  }
});

router.get('/failure-samples', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 10);
    const data = await getFailureSampleList(db, {
      sampleType: typeof req.query.sampleType === 'string' ? req.query.sampleType : undefined,
      followupStatus: typeof req.query.followupStatus === 'string' ? req.query.followupStatus : undefined,
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      includeArchived: req.query.includeArchived === '1' || req.query.includeArchived === 'true',
      page,
      pageSize
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取失败样本库失败：${(error as Error).message}` });
  }
});

router.patch('/failure-samples/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ success: false, message: '失败样本 ID 不合法' });
      return;
    }

    const nextStatus = typeof req.body?.followupStatus === 'string' ? req.body.followupStatus : '';
    const allowedStatuses = new Set(['tracking', 'needs_review', 'validated', 'invalidated', 'failed', 'recovered', 'reviewed', 'archived']);
    if (!allowedStatuses.has(nextStatus)) {
      res.status(400).json({ success: false, message: '失败样本处理状态不合法' });
      return;
    }

	    const db = await getDb();
	    await ensureFinanceDecisionSupportSchema(db);
	    await db.run(
	      `UPDATE finance_failure_samples
	       SET followup_status = ?,
	           followup_status_manual = 1,
	           updated_at = CURRENT_TIMESTAMP
	       WHERE id = ?`,
      [nextStatus, id]
    );
    const row = await db.get(`SELECT * FROM finance_failure_samples WHERE id = ?`, [id]);
    if (!row) {
      res.status(404).json({ success: false, message: '失败样本不存在' });
      return;
    }
    res.json({ success: true, data: mapFailureSampleRow(row) });
  } catch (error) {
    res.status(500).json({ success: false, message: `更新失败样本状态失败：${(error as Error).message}` });
  }
});

router.post('/failure-samples/sync', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const summary = await buildSampleValidationSummary(db, {
      syncDecisionTracking: true,
      syncFailureSamples: true
    });
    res.json({
      success: true,
      data: {
        syncResult: summary.syncResult,
        failureSamples: summary.failureSamples
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `同步失败样本失败：${(error as Error).message}` });
  }
});

router.post('/decision-samples/sync', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceDecisionSupportSchema(db);
    const syncResult = await syncDecisionSamplesFromSources(db, { captureSnapshots: true });
    const decisionTracking = await getDecisionSampleTrackingSummary(db, { sync: false });
    res.json({
      success: true,
      data: {
        syncResult,
        decisionTracking
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `同步决策样本失败：${(error as Error).message}` });
  }
});

router.get('/account-risk/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceDecisionSupportSchema(db);
    const riskConfig = await getAccountRiskConfig(db);
    const config = riskConfig.values;
    const activePlans = await db.all(
      `SELECT p.id, p.plan_name, p.symbol, p.name, p.asset_type, p.status, p.total_capital,
              p.structure_score, p.trend_phase_code, p.max_loss_percent, p.updated_at,
              COALESCE(SUM(CASE
                WHEN e.action_type IN ('buy', 'add') THEN e.execution_amount
                WHEN e.action_type IN ('sell', 'reduce', 'stop_loss', 'exit') THEN -e.execution_amount
                ELSE 0
              END), 0) as current_amount
       FROM financial_trade_plans p
       LEFT JOIN financial_trade_executions e ON e.plan_id = p.id
       WHERE p.is_deleted = 0
         AND p.status IN ('draft', 'watching', 'paper_tracking', 'active')
       GROUP BY p.id
       ORDER BY p.updated_at DESC
       LIMIT 300`
    );
    const recentOutcomes = await db.all(
      `SELECT id, plan_name, symbol, name, asset_type, status, perf_20d, stopped_out,
              false_breakout, chased_high, updated_at
       FROM financial_trade_plans
       WHERE is_deleted = 0
         AND (
           status IN ('closed', 'invalidated')
           OR stopped_out = 1
           OR perf_20d IS NOT NULL
         )
       ORDER BY updated_at DESC
       LIMIT 30`
    );
    const endedRows = await db.all(
      `SELECT id, category_name, object_name, variant_name, profit, sell_date
       FROM ended_positions
       WHERE sell_date >= date('now', '-30 day')
       ORDER BY sell_date DESC
       LIMIT 100`
    );

    const totalExposure = activePlans.reduce((sum: number, row: any) => sum + Math.max(0, toNumber(row.current_amount)), 0);
    const plannedCapital = activePlans.reduce((sum: number, row: any) => sum + Math.max(0, toNumber(row.total_capital)), 0);
    const byAssetTypeMap = new Map<string, { assetType: string; count: number; exposure: number; planned: number }>();
    activePlans.forEach((row: any) => {
      const key = row.asset_type || 'unknown';
      const current = byAssetTypeMap.get(key) || { assetType: key, count: 0, exposure: 0, planned: 0 };
      current.count += 1;
      current.exposure += Math.max(0, toNumber(row.current_amount));
      current.planned += Math.max(0, toNumber(row.total_capital));
      byAssetTypeMap.set(key, current);
    });
    const byAssetType = Array.from(byAssetTypeMap.values()).sort((a, b) => b.exposure - a.exposure);
    const maxAssetTypeCount = byAssetType.reduce((max, row) => Math.max(max, row.count), 0);
    const largest = [...activePlans].sort((a: any, b: any) => toNumber(b.current_amount) - toNumber(a.current_amount))[0] || null;
    const latestFailures: any[] = [];
    for (const row of recentOutcomes) {
      const failed = row.stopped_out === 1 || row.status === 'invalidated' || toNumber(row.perf_20d, 0) < 0;
      if (!failed) break;
      latestFailures.push(row);
    }
    const recentEndedProfit = endedRows.reduce((sum: number, row: any) => sum + toNumber(row.profit), 0);
    const recentEndedLossCount = endedRows.filter((row: any) => toNumber(row.profit) < 0).length;

    const rules = [
      {
        key: 'consecutive_failures',
        label: '连续计划失败',
        status: latestFailures.length >= config.consecutive_failures_block ? 'block' : latestFailures.length >= config.consecutive_failures_warn ? 'warn' : 'pass',
        value: latestFailures.length,
        message: latestFailures.length >= config.consecutive_failures_block
          ? `连续失败达到${config.consecutive_failures_block}次，建议进入账户冷却，只允许复盘和减风险。`
          : latestFailures.length >= config.consecutive_failures_warn
            ? `连续失败达到${config.consecutive_failures_warn}次，新开仓降级。`
            : '没有触发连续失败冷却。'
      },
      {
        key: 'monthly_loss',
        label: '近30日已结束盈亏',
        status: recentEndedProfit <= config.monthly_loss_block ? 'block' : recentEndedProfit < config.monthly_loss_warn ? 'warn' : 'pass',
        value: roundMetric(recentEndedProfit, 2),
        message: recentEndedProfit <= config.monthly_loss_block
          ? '近30日亏损较大，暂停新增实仓。'
          : recentEndedProfit < config.monthly_loss_warn
            ? '近30日为亏损，降低单笔计划金额。'
            : '近30日已结束仓位未触发亏损限制。'
      },
      {
        key: 'largest_position',
        label: '最大单计划暴露',
        status: totalExposure > 0 && largest && toNumber(largest.current_amount) / totalExposure >= config.largest_position_warn ? 'warn' : 'pass',
        value: totalExposure > 0 && largest ? roundMetric(toNumber(largest.current_amount) / totalExposure) : null,
        message: totalExposure > 0 && largest && toNumber(largest.current_amount) / totalExposure >= config.largest_position_warn ? '最大单计划占比偏高，继续新增前先考虑退出路径。' : '单计划暴露没有明显过度集中。'
      },
      {
        key: 'active_plan_count',
        label: '同时跟踪计划数',
        status: activePlans.length >= config.active_plan_count_warn ? 'warn' : 'pass',
        value: activePlans.length,
        message: activePlans.length >= config.active_plan_count_warn ? '同时跟踪计划过多，容易执行分散，建议清理低质量计划。' : '同时跟踪计划数量可控。'
      },
      {
        key: 'same_asset_type_count',
        label: '同类资产集中',
        status: maxAssetTypeCount >= config.same_asset_type_count_warn ? 'warn' : 'pass',
        value: maxAssetTypeCount,
        message: maxAssetTypeCount >= config.same_asset_type_count_warn ? '同一资产类型计划数量偏多，新计划先确认是否重复暴露。' : '同类资产计划数量可控。'
      }
    ];
    const hasBlock = rules.some(rule => rule.status === 'block');
    const hasWarn = rules.some(rule => rule.status === 'warn');

    res.json({
      success: true,
      data: {
        status: hasBlock ? 'COOLDOWN' : hasWarn ? 'LIMITED' : 'NORMAL',
        statusLabel: hasBlock ? '账户冷却' : hasWarn ? '限制开仓' : '正常',
        headline: hasBlock
          ? '账户层面触发冷却，先暂停新增实仓。'
          : hasWarn
            ? '账户层面有风险项，新计划要降金额或先做纸面跟踪。'
            : '账户层面未触发硬限制。',
        exposure: {
          activePlanCount: activePlans.length,
          totalExposure: roundMetric(totalExposure, 2),
          plannedCapital: roundMetric(plannedCapital, 2),
          largestPlan: largest ? {
            id: largest.id,
            name: largest.plan_name,
            symbol: largest.symbol,
            amount: roundMetric(toNumber(largest.current_amount), 2),
            percent: totalExposure > 0 ? roundMetric(toNumber(largest.current_amount) / totalExposure) : null
          } : null,
          byAssetType
        },
        recent: {
          consecutiveFailures: latestFailures.length,
          recentEndedProfit: roundMetric(recentEndedProfit, 2),
          recentEndedLossCount,
          latestFailures: latestFailures.slice(0, 6),
          endedRows: endedRows.slice(0, 8)
        },
        rules,
        config: riskConfig.rows,
        permissionStages: PERMISSION_STAGES,
        modelBoundary: MODEL_BOUNDARY
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取账户级风控失败：${(error as Error).message}` });
  }
});

router.patch('/account-risk/config', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceDecisionSupportSchema(db);
    const updates = Array.isArray(req.body?.items) ? req.body.items : [];
    const allowedKeys = new Set(ACCOUNT_RISK_CONFIG_DEFAULTS.map(item => item.key));
    const currentConfig = await getAccountRiskConfig(db);
    const nextValues = { ...currentConfig.values };
    const normalizedUpdates: Array<{ key: string; value: number }> = [];

    for (const item of updates) {
      const key = String(item?.config_key || item?.key || '');
      if (!allowedKeys.has(key)) continue;
      const value = Number(item?.numeric_value ?? item?.value);
      if (!Number.isFinite(value)) continue;
      nextValues[key] = value;
      normalizedUpdates.push({ key, value });
    }

    const validationErrors = validateAccountRiskConfigValues(nextValues);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: validationErrors.join('；')
      });
    }

    for (const item of normalizedUpdates) {
      await db.run(
        `UPDATE finance_account_risk_config
         SET numeric_value = ?, updated_at = CURRENT_TIMESTAMP
         WHERE config_key = ?`,
        [item.value, item.key]
      );
    }

    const data = await getAccountRiskConfig(db);
    res.json({ success: true, data: { config: data.rows } });
  } catch (error) {
    res.status(500).json({ success: false, message: `更新账户风控配置失败：${(error as Error).message}` });
  }
});

export default router;
