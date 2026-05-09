import express, { Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import getDb from '../config/database';
import {
  buildIndustryEtfStrengthContext,
  buildIndustryStrengthGateReason,
  calculateIndustryEtfStrength,
  formatIndustryStrengthNote,
  type IndustryEtfStrengthContext,
  type IndustryEtfStrengthItem
} from '../services/industryEtfStrengthService';
import {
  getFinancePlanProfileConfig,
  getFinanceStructureProfileConfig,
  resolveFinancePlanProfile
} from '../services/financePlanProfile';

const router = express.Router();

const CANDIDATE_RULE_VERSION = 'candidate_pool_v1';
const TREND_PHASE_VERSION = 'trend_phase_v1.1';
const CANDIDATE_POOL_ASSET_TYPES = ['stock', 'etf'];
const STOCK_AVG20_AMOUNT_MIN_YUAN = 100_000_000;
const STOCK_MIN5_AMOUNT_MIN_YUAN = 30_000_000;
const STOCK_CIRC_MARKET_CAP_MIN_YUAN = 5_000_000_000;
const ETF_HARD_BLOCK_TREND_PHASES = new Set(['SURGE', 'REBOUND', 'SLOW_BLEED', 'CRASH_DROP']);
const STRUCTURE_QUEUE_STATUSES = new Set(['structure_pending', 'structure_watch', 'model_conflict']);
const STRUCTURE_READY_TREND_PHASES = new Set(['BREAKOUT', 'SLOW_GRIND_UP', 'RECOVERY']);
const STRUCTURE_HARD_REJECT_GATES = new Set([
  'asset_applicability',
  'data_ready',
  'special_treatment',
  'liquidity_gate',
  'market_cap_gate',
  'extreme_trade_gate',
  'etf_group_gate'
]);
const trainingRoot = process.env.MODEL_TRAINING_ROOT || '/Volumes/7100/model-training';
const trainingPython = process.env.MODEL_TRAINING_PYTHON || path.join(trainingRoot, 'venv', 'bin', 'python');
let candidateReviewSchemaReady = false;

interface CandidatePriorityResult {
  priority: 'high' | 'medium' | 'low';
  priority_score: number;
  forbidden_reason: string | null;
  downgrade_reason: string | null;
  risk_note: string | null;
}

interface DailyPrice {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

interface RecentRiskProfile {
  forbidden_reasons: string[];
  downgrade_reasons: string[];
  risk_note: string | null;
  max_drawdown_20: number | null;
  pullback_from_20_high: number | null;
  range_20: number | null;
  latest_change: number | null;
}

interface StockTradeQualification {
  data_freshness: {
    status: GateStatus;
    blocking: boolean;
    reason: string;
    forbidden_reason: string | null;
    note: string;
    latest_trade_date: string | null;
    market_trade_date: string | null;
  };
  liquidity: {
    passed: boolean;
    reason: string;
    forbidden_reason: string | null;
    note: string;
    avg20_amount_yuan: number | null;
    min5_amount_yuan: number | null;
  };
  market_cap: {
    status: GateStatus;
    blocking: boolean;
    reason: string;
    forbidden_reason: string | null;
    note: string;
    circ_mv_yuan: number | null;
    total_mv_yuan: number | null;
  };
  extreme_trade: {
    passed: boolean;
    reason: string;
    forbidden_reason: string | null;
    note: string;
  };
  forbidden_reason: string | null;
  note: string | null;
}

type EtfRouteKey =
  | 'equity_broad'
  | 'equity_industry'
  | 'commodity'
  | 'cross_border'
  | 'bond_cash'
  | 'special_fund'
  | 'unknown';

interface EtfStrategyRoute {
  key: EtfRouteKey;
  label: string;
  current_pool_applicable: boolean;
  target_pool: string;
  forbidden_reason: string | null;
  note: string;
}

type GateStatus = 'passed' | 'failed' | 'not_applicable';

interface CandidateGate {
  key: string;
  label: string;
  status: GateStatus;
  reason: string;
  blocking: boolean;
}

type OpportunityTypeCode = 'DEFENSIVE' | 'REPAIR' | 'TREND' | 'EMOTIONAL' | 'NOT_APPLICABLE';

interface OpportunityTypeTag {
  code: OpportunityTypeCode;
  label: string;
  tone: 'neutral' | 'warn' | 'good';
  reason: string;
}

const CANDIDATE_GATE_DEFINITIONS = [
  { key: 'asset_applicability', label: '资产适用性' },
  { key: 'data_ready', label: '数据充足' },
  { key: 'data_freshness_gate', label: '日线同步' },
  { key: 'special_treatment', label: 'ST/退市过滤' },
  { key: 'liquidity_gate', label: '流动性' },
  { key: 'market_cap_gate', label: '市值/流通市值' },
  { key: 'extreme_trade_gate', label: '极端交易状态' },
  { key: 'market_gate', label: '市场总闸' },
  { key: 'structure_gate', label: '结构成立' },
  { key: 'safe_zone_gate', label: '安全区' },
  { key: 'trend_phase_gate', label: '走势阶段' },
  { key: 'risk_forbidden_gate', label: '禁止风险项' },
  { key: 'etf_group_gate', label: 'ETF策略路由' },
  { key: 'risk_downgrade_gate', label: '降级项' },
  { key: 'priority_gate', label: '优先分' },
  { key: 'model_reference', label: '模型参考' },
];

const MODEL_RECHECK_HARD_BLOCKING_GATES = new Set([
  'asset_applicability',
  'data_ready',
  'special_treatment',
  'liquidity_gate',
  'market_cap_gate',
  'extreme_trade_gate',
  'structure_gate',
  'risk_forbidden_gate',
]);
function isHardBlockedFromModelRecheck(item: any) {
  const firstBlockingGateKey = String(item?.first_blocking_gate_key || '').trim();
  const firstBlockingGateLabel = String(item?.first_blocking_gate_label || '').trim();
  const structureStatus = String(item?.structure_status || '').trim();
  const forbiddenReason = String(item?.forbidden_reason || item?.candidate_reason || item?.risk_note || '').trim();
  return MODEL_RECHECK_HARD_BLOCKING_GATES.has(firstBlockingGateKey)
    || firstBlockingGateLabel === 'ST/退市过滤'
    || structureStatus === 'STRUCTURE_BROKEN'
    || /结构(失败|破坏)|跌破失效线|极端交易状态/.test(forbiddenReason)
    || isSpecialTreatmentName(item?.name);
}

function isVisibleModelRecheckItem(item: any) {
  const probability = Number(item?.ml_probability);
  const structureProfile = getFinanceStructureProfileConfig(resolveCandidateProfile(item).key);
  return !isHardBlockedFromModelRecheck(item)
    && item?.ml_available
    && Number.isFinite(probability)
    && probability >= structureProfile.modelLowProbability;
}

function parseJson(value: unknown, fallback: any = null) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function makeGate(
  key: string,
  status: GateStatus,
  reason: string,
  blocking = false
): CandidateGate {
  const definition = CANDIDATE_GATE_DEFINITIONS.find(item => item.key === key);
  return {
    key,
    label: definition?.label || key,
    status,
    reason,
    blocking
  };
}

function buildGateTrace(
  overrides: CandidateGate[],
  selected: boolean,
  finalReason: string
) {
  const overrideMap = new Map(overrides.map(gate => [gate.key, gate]));
  const gates = CANDIDATE_GATE_DEFINITIONS.map(definition => (
    overrideMap.get(definition.key) || makeGate(
      definition.key,
      'not_applicable',
      '前置条件未满足或当前规则不需要继续判断。',
      false
    )
  ));
  const blockingGates = gates.filter(gate => gate.blocking);
  const finalGate = makeGate(
    'final_result',
    selected ? 'passed' : 'failed',
    finalReason,
    false
  );
  const allGates = [...gates, finalGate];

  return {
    rule_version: CANDIDATE_RULE_VERSION,
    final_selected: selected,
    final_reason: finalReason,
    first_blocking_gate: blockingGates[0] || null,
    blocking_gates: blockingGates,
    gates: allGates,
    status_counts: allGates.reduce((summary: Record<GateStatus, number>, gate) => {
      summary[gate.status] = (summary[gate.status] || 0) + 1;
      return summary;
    }, { passed: 0, failed: 0, not_applicable: 0 })
  };
}

function attachGateTrace<T extends Record<string, any>>(
  payload: T,
  gates: CandidateGate[],
  selected: boolean,
  finalReason: string
) {
  const gateTrace = buildGateTrace(gates, selected, finalReason);
  return {
    ...payload,
    gate_trace: gateTrace,
    first_blocking_gate_key: gateTrace.first_blocking_gate?.key || null,
    first_blocking_gate_label: gateTrace.first_blocking_gate?.label || null,
    blocking_gate_labels: gateTrace.blocking_gates.map((gate: CandidateGate) => gate.label).join('、') || null,
  };
}

function buildGateSummary(evaluations: any[]) {
  const byGate = CANDIDATE_GATE_DEFINITIONS.map(definition => ({
    key: definition.key,
    label: definition.label,
    passed: 0,
    failed: 0,
    not_applicable: 0,
  }));
  const byGateMap = new Map(byGate.map(item => [item.key, item]));
  const firstBlockingMap = new Map<string, { key: string; label: string; count: number }>();

  for (const evaluation of evaluations) {
    const trace = evaluation.gate_trace;
    if (!trace) continue;
    for (const gate of trace.gates || []) {
      if (gate.key === 'final_result') continue;
      const row = byGateMap.get(gate.key);
      if (row) {
        row[gate.status as GateStatus] += 1;
      }
    }
    if (trace.first_blocking_gate) {
      const key = trace.first_blocking_gate.key;
      const existing = firstBlockingMap.get(key) || {
        key,
        label: trace.first_blocking_gate.label,
        count: 0
      };
      existing.count += 1;
      firstBlockingMap.set(key, existing);
    }
  }

  return {
    total: evaluations.length,
    selected: evaluations.filter(item => item.selected).length,
    rejected: evaluations.filter(item => !item.selected).length,
    by_gate: byGate,
    first_blocking: Array.from(firstBlockingMap.values()).sort((a, b) => b.count - a.count),
  };
}

function buildStoredGateTrace(item: any) {
  const assetType = item.asset_type;
  const selected = item.pool_status === 'active';
  const finalReason = item.candidate_reason || item.forbidden_reason || item.downgrade_reason || '历史记录未保存完整诊断明细，按当前入池字段回放。';
  const isSupportedAsset = CANDIDATE_POOL_ASSET_TYPES.includes(assetType);
  const isEtf = assetType === 'etf';
  const marketAllowed = item.entry_permission === 'ALLOW_STRUCTURE_CHECK';
  const structureConfirmed = item.structure_status === 'STRUCTURE_CONFIRMED';
  const safeZone = item.safe_zone_status === 'SAFE_ZONE';
  const trendConfirmed = Boolean(item.trend_phase_code && item.trend_phase_code !== 'UNKNOWN');
  const hasForbidden = Boolean(item.forbidden_reason);
  const priorityScore = Number(item.priority_score || 0);
  const structureProfile = getFinanceStructureProfileConfig(resolveCandidateProfile(item).key);

  return buildGateTrace([
    makeGate(
      'asset_applicability',
      isSupportedAsset ? 'passed' : 'not_applicable',
      isSupportedAsset ? `${isEtf ? 'ETF' : 'A股个股'}属于当前备选池可评估类型。` : '备选池只允许 A股个股 和 ETF。',
      !isSupportedAsset
    ),
    makeGate('data_ready', 'passed', '该记录已进入备选池，历史日线已满足入池时的数据要求。'),
    assetType === 'stock'
      ? makeGate('data_freshness_gate', 'not_applicable', '历史入池记录未保存日线同步明细，等待下次扫描按新规则重算。')
      : makeGate('data_freshness_gate', 'not_applicable', 'ETF日线同步由ETF流程单独复核。'),
    makeGate(
      'special_treatment',
      isSpecialTreatmentName(item.name) ? 'failed' : 'passed',
      isSpecialTreatmentName(item.name) ? 'ST / *ST / 退市风险标的，禁止进入备选池。' : '未命中 ST / 退市过滤。',
      isSpecialTreatmentName(item.name)
    ),
    assetType === 'stock'
      ? makeGate('liquidity_gate', 'not_applicable', '历史入池记录未保存流动性明细，等待下次扫描按新规则重算。')
      : makeGate('liquidity_gate', 'not_applicable', 'ETF暂不走个股流动性硬门槛。'),
    assetType === 'stock'
      ? makeGate('market_cap_gate', 'not_applicable', '历史入池记录未保存市值快照，等待本地市值数据补齐后重算。')
      : makeGate('market_cap_gate', 'not_applicable', 'ETF暂不走个股市值硬门槛。'),
    assetType === 'stock'
      ? makeGate('extreme_trade_gate', 'not_applicable', '历史入池记录未保存极端交易状态明细，等待下次扫描按新规则重算。')
      : makeGate('extreme_trade_gate', 'not_applicable', 'ETF暂不走个股极端交易状态硬门槛。'),
    makeGate(
      'market_gate',
      marketAllowed ? 'passed' : 'failed',
      marketAllowed ? '市场总闸允许进入结构判断。' : '市场总闸未开放单标的结构判断。',
      !marketAllowed
    ),
    makeGate(
      'structure_gate',
      structureConfirmed ? 'passed' : 'failed',
      item.structure_reason || (structureConfirmed ? '结构成立。' : '结构未成立。'),
      !structureConfirmed
    ),
    makeGate(
      'safe_zone_gate',
      safeZone ? 'passed' : 'failed',
      item.safe_zone_reason || (safeZone ? '处于相对安全区。' : '安全区未成立。'),
      !safeZone
    ),
    isEtf
      ? makeGate(
          'trend_phase_gate',
          trendConfirmed
            ? ETF_HARD_BLOCK_TREND_PHASES.has(item.trend_phase_code)
              ? 'failed'
              : 'passed'
            : 'not_applicable',
          trendConfirmed
            ? ETF_HARD_BLOCK_TREND_PHASES.has(item.trend_phase_code)
              ? `ETF走势阶段为${getTrendPhaseLabel(item.trend_phase_code)}，不进入权益主升备选池。`
              : `ETF走势阶段已确认：${getTrendPhaseLabel(item.trend_phase_code)}。`
            : 'ETF走势阶段未确认，仅用于优先级降权和复核提示，不再一票否决。',
          Boolean(trendConfirmed && ETF_HARD_BLOCK_TREND_PHASES.has(item.trend_phase_code))
        )
      : makeGate(
          'trend_phase_gate',
          trendConfirmed ? 'passed' : 'not_applicable',
          trendConfirmed ? `走势阶段已确认：${getTrendPhaseLabel(item.trend_phase_code)}。` : '个股走势阶段未确认时只降优先级，不作为硬阻断。',
          false
        ),
    makeGate(
      'risk_forbidden_gate',
      hasForbidden ? 'failed' : 'passed',
      item.forbidden_reason || '未命中追高、破位、假突破、急涨/反抽/阴跌/暴跌等禁止项。',
      hasForbidden
    ),
    isEtf
      ? makeGate('etf_group_gate', 'passed', '历史记录未保存详细ETF策略路由，本次按已入池记录视为当前权益主升池适用。')
      : makeGate('etf_group_gate', 'not_applicable', '个股不走 ETF 策略路由。'),
    isEtf
      ? makeGate(
          'risk_downgrade_gate',
          'passed',
          item.downgrade_reason ? `ETF存在降级项：${item.downgrade_reason}；仅降权和提示复核，不作为入池硬阻断。` : 'ETF未命中降级项。',
          false
        )
      : makeGate(
          'risk_downgrade_gate',
          'passed',
          item.downgrade_reason ? `存在降级项：${item.downgrade_reason}；个股只降优先级，不直接阻断入池。` : '未命中降级项。',
          false
        ),
    isEtf
      ? makeGate(
          'priority_gate',
          priorityScore >= structureProfile.candidatePriorityPassScore ? 'passed' : 'failed',
          `ETF优先分 ${priorityScore}，${structureProfile.label}入池阈值 ${structureProfile.candidatePriorityPassScore}。`,
          priorityScore < structureProfile.candidatePriorityPassScore
        )
      : makeGate('priority_gate', 'not_applicable', `个股无固定优先分入池阈值，当前优先分 ${priorityScore} 只用于排序。`),
    makeGate('model_reference', 'not_applicable', '模型概率不决定入池，只用于入池后的分层、复盘和风控参考。')
  ], selected, finalReason);
}

function hydrateCandidateItem(item: any) {
  const parsedGateTrace = parseJson(item.gate_trace_json, null);
  const planProfile = item.plan_profile
    ? getFinancePlanProfileConfig(item.plan_profile)
    : resolveCandidateProfile(item);
  const itemWithProfile = {
    ...item,
    plan_profile: item.plan_profile || planProfile.key,
    plan_profile_label: item.plan_profile_label || planProfile.label
  };
  const hasCurrentGateShape = parsedGateTrace?.gates && CANDIDATE_GATE_DEFINITIONS.every(definition =>
    parsedGateTrace.gates.some((gate: CandidateGate) => gate.key === definition.key)
  );
  const gateTrace = hasCurrentGateShape ? parsedGateTrace : buildStoredGateTrace(itemWithProfile);
  return {
    ...itemWithProfile,
    opportunity_type: item.opportunity_type || classifyOpportunityType(itemWithProfile),
    gate_trace: gateTrace,
    first_blocking_gate_key: item.first_blocking_gate_key || gateTrace.first_blocking_gate?.key || null,
    first_blocking_gate_label: item.first_blocking_gate_label || gateTrace.first_blocking_gate?.label || null,
    blocking_gate_labels: item.blocking_gate_labels || gateTrace.blocking_gates?.map((gate: CandidateGate) => gate.label).join('、') || null,
  };
}

async function ensureCandidateReviewSchema(db: any) {
  if (candidateReviewSchemaReady) return;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS financial_candidate_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      asset_type TEXT NOT NULL,
      source TEXT NOT NULL,
      trade_date TEXT,
      rule_version TEXT NOT NULL,
      model_key TEXT,
      model_target TEXT,
      model_probability REAL,
      lane_key TEXT,
      lane_label TEXT,
      suggested_action_key TEXT,
      suggested_action_label TEXT,
      review_status TEXT NOT NULL DEFAULT 'draft',
      draft_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_financial_candidate_reviews_candidate
    ON financial_candidate_reviews(candidate_id, created_at);

    CREATE TABLE IF NOT EXISTS financial_stock_basic_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'tushare',
      trade_date TEXT NOT NULL,
      total_mv_yuan REAL,
      circ_mv_yuan REAL,
      turnover_rate REAL,
      pe REAL,
      pb REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(symbol, source, trade_date)
    );

    CREATE INDEX IF NOT EXISTS idx_financial_stock_basic_metrics_symbol
    ON financial_stock_basic_metrics(symbol, source, trade_date);
  `);

  const columns = await db.all(`PRAGMA table_info(financial_candidate_pool)`);
  const columnNames = new Set(columns.map((column: any) => column.name));
  const alterStatements = [
    ['review_status', `ALTER TABLE financial_candidate_pool ADD COLUMN review_status TEXT NOT NULL DEFAULT 'unreviewed'`],
    ['last_review_id', `ALTER TABLE financial_candidate_pool ADD COLUMN last_review_id INTEGER`],
    ['last_review_at', `ALTER TABLE financial_candidate_pool ADD COLUMN last_review_at TEXT`],
    ['review_action', `ALTER TABLE financial_candidate_pool ADD COLUMN review_action TEXT`],
    ['gate_trace_json', `ALTER TABLE financial_candidate_pool ADD COLUMN gate_trace_json TEXT`],
    ['first_blocking_gate_key', `ALTER TABLE financial_candidate_pool ADD COLUMN first_blocking_gate_key TEXT`],
    ['first_blocking_gate_label', `ALTER TABLE financial_candidate_pool ADD COLUMN first_blocking_gate_label TEXT`],
    ['blocking_gate_labels', `ALTER TABLE financial_candidate_pool ADD COLUMN blocking_gate_labels TEXT`],
    ['plan_profile', `ALTER TABLE financial_candidate_pool ADD COLUMN plan_profile TEXT`],
    ['plan_profile_label', `ALTER TABLE financial_candidate_pool ADD COLUMN plan_profile_label TEXT`],
  ];

  for (const [columnName, sql] of alterStatements) {
    if (!columnNames.has(columnName)) {
      await db.exec(sql);
    }
  }

  candidateReviewSchemaReady = true;
}

function isSpecialTreatmentName(name?: string | null): boolean {
  return /(^|\*)ST|退/.test(name || '');
}

function normalizeAmountToYuan(amount: unknown, source?: string): number {
  const value = Number(amount || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (source === 'tushare') return value * 1000;
  if (source === 'akshare' || source === 'mock') return value;
  return value < 100_000_000 ? value * 1000 : value;
}

function formatCnyAmount(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '--';
  const amount = Number(value);
  if (amount >= 100_000_000) return `${(amount / 100_000_000).toFixed(2)}亿`;
  if (amount >= 10_000) return `${(amount / 10_000).toFixed(0)}万`;
  return `${amount.toFixed(0)}元`;
}

function getLimitLikeThreshold(symbol: string): number {
  if (/^(8|4|920)/.test(symbol)) return 0.295;
  if (/^(688|300|301)/.test(symbol)) return 0.195;
  return 0.095;
}

function calculateStockDataFreshnessGate(
  prices: DailyPrice[],
  latestMarketDate?: string | null
): StockTradeQualification['data_freshness'] {
  const latest = prices[prices.length - 1];
  const latestTradeDate = latest?.trade_date || null;
  const marketTradeDate = latestMarketDate || null;
  const stale = Boolean(marketTradeDate && latestTradeDate && latestTradeDate < marketTradeDate);
  const note = marketTradeDate
    ? `本地最新 ${latestTradeDate || '--'}，市场最新交易日 ${marketTradeDate}。`
    : `本地最新 ${latestTradeDate || '--'}，市场最新交易日未确认。`;
  const reason = stale
    ? `本地日线没有同步到市场最新交易日。${note}节假日没有交易数据，不需要补；只需要补齐缺失的实际交易日。`
    : `${note}日线同步满足当前扫描要求。`;

  return {
    status: stale ? 'failed' : 'passed',
    blocking: stale,
    reason,
    forbidden_reason: stale ? reason : null,
    note,
    latest_trade_date: latestTradeDate,
    market_trade_date: marketTradeDate
  };
}

function calculateStockLiquidityGate(prices: DailyPrice[], source: string): StockTradeQualification['liquidity'] {
  const last20 = prices.slice(-20);
  const last5 = prices.slice(-5);
  const last20Amounts = last20.map(price => normalizeAmountToYuan(price.amount, source));
  const last5Amounts = last5.map(price => normalizeAmountToYuan(price.amount, source));
  const avg20Amount = last20Amounts.length > 0
    ? last20Amounts.reduce((sum, value) => sum + value, 0) / last20Amounts.length
    : 0;
  const min5Amount = last5Amounts.length > 0 ? Math.min(...last5Amounts) : 0;

  const failures: string[] = [];
  if (avg20Amount < STOCK_AVG20_AMOUNT_MIN_YUAN) {
    failures.push(`近20日平均成交额 ${formatCnyAmount(avg20Amount)}，低于 ${formatCnyAmount(STOCK_AVG20_AMOUNT_MIN_YUAN)} 硬门槛`);
  }
  if (min5Amount < STOCK_MIN5_AMOUNT_MIN_YUAN) {
    failures.push(`近5日最低成交额 ${formatCnyAmount(min5Amount)}，低于 ${formatCnyAmount(STOCK_MIN5_AMOUNT_MIN_YUAN)} 硬门槛`);
  }

  const note = `近20日平均成交额 ${formatCnyAmount(avg20Amount)}；近5日最低成交额 ${formatCnyAmount(min5Amount)}。`;
  return {
    passed: failures.length === 0,
    reason: failures.length > 0 ? failures.join('；') : `${note}流动性满足个股交易资格。`,
    forbidden_reason: failures.length > 0 ? failures.join('；') : null,
    note,
    avg20_amount_yuan: Math.round(avg20Amount),
    min5_amount_yuan: Math.round(min5Amount)
  };
}

async function getStockMarketCapSnapshot(db: any, symbol: string, source: string) {
  return db.get(
    `SELECT trade_date, total_mv_yuan, circ_mv_yuan, turnover_rate, pe, pb
     FROM financial_stock_basic_metrics
     WHERE symbol = ? AND source = ?
     ORDER BY trade_date DESC
     LIMIT 1`,
    [symbol, source]
  );
}

function calculateStockMarketCapGate(snapshot: any): StockTradeQualification['market_cap'] {
  if (!snapshot) {
    const reason = '本地暂未落流通市值快照，无法确认50亿市值门槛，按个股交易资格未通过处理。';
    return {
      status: 'failed',
      blocking: true,
      reason,
      forbidden_reason: reason,
      note: reason,
      circ_mv_yuan: null,
      total_mv_yuan: null
    };
  }

  const circMv = Number(snapshot.circ_mv_yuan || 0) || null;
  const totalMv = Number(snapshot.total_mv_yuan || 0) || null;
  const comparableMv = circMv || totalMv || 0;
  const passed = comparableMv >= STOCK_CIRC_MARKET_CAP_MIN_YUAN;
  const metricName = circMv ? '流通市值' : '总市值';
  const note = `${metricName} ${formatCnyAmount(comparableMv)}，市值快照日期 ${snapshot.trade_date}。`;
  const forbiddenReason = passed ? null : `${metricName} ${formatCnyAmount(comparableMv)}，低于 ${formatCnyAmount(STOCK_CIRC_MARKET_CAP_MIN_YUAN)} 硬门槛。`;

  return {
    status: passed ? 'passed' : 'failed',
    blocking: !passed,
    reason: forbiddenReason || `${note}满足个股交易资格。`,
    forbidden_reason: forbiddenReason,
    note,
    circ_mv_yuan: circMv,
    total_mv_yuan: totalMv
  };
}

function calculateStockExtremeTradeGate(
  prices: DailyPrice[],
  symbol: string
): StockTradeQualification['extreme_trade'] {
  const last10 = prices.slice(-11);
  const threshold = getLimitLikeThreshold(symbol);
  const failures: string[] = [];
  let recentLimitLikeCount = 0;
  let oneLineBoardCount = 0;
  let maxConsecutiveLimitLike = 0;
  let currentConsecutiveLimitLike = 0;

  for (let index = 1; index < last10.length; index += 1) {
    const previous = last10[index - 1];
    const current = last10[index];
    const change = previous.close > 0 ? current.close / previous.close - 1 : 0;
    const limitLike = Math.abs(change) >= threshold;
    const oneLineBoard = limitLike && current.close > 0 && Math.abs(current.high - current.low) / current.close <= 0.002;

    if (limitLike) {
      recentLimitLikeCount += 1;
      currentConsecutiveLimitLike += 1;
      maxConsecutiveLimitLike = Math.max(maxConsecutiveLimitLike, currentConsecutiveLimitLike);
    } else {
      currentConsecutiveLimitLike = 0;
    }
    if (oneLineBoard) {
      oneLineBoardCount += 1;
    }
  }

  if (maxConsecutiveLimitLike >= 2) {
    failures.push(`近10日出现连续${maxConsecutiveLimitLike}天涨跌停级别波动`);
  }
  if (recentLimitLikeCount >= 3) {
    failures.push(`近10日涨跌停级别波动 ${recentLimitLikeCount} 次，情绪波动过强`);
  }
  if (oneLineBoardCount > 0) {
    failures.push(`近10日出现 ${oneLineBoardCount} 次疑似一字板`);
  }

  const note = `近10日涨跌停级别波动 ${recentLimitLikeCount} 次，最大连续 ${maxConsecutiveLimitLike} 天，疑似一字板 ${oneLineBoardCount} 次。`;
  return {
    passed: failures.length === 0,
    reason: failures.length > 0 ? failures.join('；') : `${note}未见极端交易状态。`,
    forbidden_reason: failures.length > 0 ? failures.join('；') : null,
    note
  };
}

async function calculateStockTradeQualification(
  db: any,
  symbol: string,
  source: string,
  prices: DailyPrice[]
): Promise<StockTradeQualification> {
  const latestMarket = await db.get(
    `SELECT MAX(trade_date) AS trade_date
     FROM financial_daily_prices
     WHERE symbol = '000300' AND asset_type = 'index' AND source = ?`,
    [source]
  );
  const marketCapSnapshot = await getStockMarketCapSnapshot(db, symbol, source);
  const dataFreshness = calculateStockDataFreshnessGate(prices, latestMarket?.trade_date || null);
  const liquidity = calculateStockLiquidityGate(prices, source);
  const marketCap = calculateStockMarketCapGate(marketCapSnapshot);
  const extremeTrade = calculateStockExtremeTradeGate(prices, symbol);
  const forbiddenReasons = [
    dataFreshness.forbidden_reason,
    liquidity.forbidden_reason,
    marketCap.forbidden_reason,
    extremeTrade.forbidden_reason
  ].filter((reason): reason is string => Boolean(reason));
  const notes = [dataFreshness.note, liquidity.note, marketCap.note, extremeTrade.note].filter(Boolean);

  return {
    data_freshness: dataFreshness,
    liquidity,
    market_cap: marketCap,
    extreme_trade: extremeTrade,
    forbidden_reason: forbiddenReasons.length > 0 ? forbiddenReasons.join('；') : null,
    note: notes.length > 0 ? notes.join('；') : null
  };
}

function getEtfGateReason(
  assetType: string,
  route: EtfStrategyRoute | null | undefined,
  priorityResult: CandidatePriorityResult,
  passScore = 70
): string | null {
  if (assetType !== 'etf') return null;
  if (route && !route.current_pool_applicable) {
    return null;
  }
  if (priorityResult.priority_score < passScore) {
    return `ETF优先分 ${priorityResult.priority_score} 低于入池阈值${passScore}。`;
  }
  return null;
}

function runCandidateScoreWorker(limit: number, poolStatus: 'active' | 'expired' | 'all' = 'active'): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'db', 'price_dashboard_dev.db');
    const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'score_candidate_pool.py');
    const child = spawn(trainingPython, [
      scriptPath,
      '--db', dbPath,
      '--rule-version', CANDIDATE_RULE_VERSION,
      '--pool-status', poolStatus,
      '--limit', String(limit)
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      const text = lines[lines.length - 1] || '';
      try {
        const payload = JSON.parse(text || '{}');
        if (code === 0 && payload.success) {
          resolve(payload.data?.scores || {});
          return;
        }
        reject(new Error(payload.message || stderr || `备选池模型评分脚本退出：${code}`));
      } catch (error) {
        reject(new Error(stderr || text || `备选池模型评分输出无法解析：${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function calculateStructure(prices: DailyPrice[], planProfileKey?: string | null) {
  const profile = getFinanceStructureProfileConfig(planProfileKey);
  const planProfile = getFinancePlanProfileConfig(planProfileKey);
  const latestPrice = prices[prices.length - 1];
  const close = latestPrice.close;
  const tradeDate = latestPrice.trade_date;

  const last20Prices = prices.slice(-20);
  const ma20 = last20Prices.reduce((sum, p) => sum + p.close, 0) / 20;

  const last60Prices = prices.slice(-60);
  const ma60 = last60Prices.reduce((sum, p) => sum + p.close, 0) / 60;

  const prev60Prices = prices.slice(-61, -1);
  const ma60Prev = prev60Prices.reduce((sum, p) => sum + p.close, 0) / 60;

  const last120Prices = prices.slice(-120);
  const ma120 = last120Prices.length >= 120
    ? last120Prices.reduce((sum, p) => sum + p.close, 0) / 120
    : ma60;

  const distanceToMa60 = (close - ma60) / ma60;

  const getMA60At = (index: number): number | null => {
    if (index < 59) return null;
    const slice = prices.slice(index - 59, index + 1);
    return slice.reduce((sum, p) => sum + p.close, 0) / 60;
  };

  let aboveMa60Days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA60 = getMA60At(i);
    if (dayMA60 === null) break;
    if (prices[i].close > dayMA60) aboveMa60Days++;
    else break;
  }

  let belowMa60Days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA60 = getMA60At(i);
    if (dayMA60 === null) break;
    if (prices[i].close < dayMA60) belowMa60Days++;
    else break;
  }

  let structureStatus: string;
  let structureReason: string;

  if (close > ma60 && ma60 >= ma60Prev && aboveMa60Days >= profile.minAboveMa60Days) {
    structureStatus = 'STRUCTURE_CONFIRMED';
    structureReason = `按${profile.label}：收盘价站上MA60并连续站稳${profile.minAboveMa60Days}天，MA60未下弯。`;
  } else if (belowMa60Days >= profile.brokenBelowMa60Days) {
    structureStatus = 'STRUCTURE_BROKEN';
    structureReason = `按${profile.label}：收盘价连续跌破MA60达到${profile.brokenBelowMa60Days}天，结构破坏。`;
  } else {
    structureStatus = 'STRUCTURE_WATCH';
    const reasons: string[] = [];
    if (Math.abs(distanceToMa60) < profile.distanceTightMax) reasons.push('价格接近MA60');
    if (close > ma60 && aboveMa60Days < profile.minAboveMa60Days) reasons.push('站上MA60但天数不足');
    if (ma60 < ma60Prev) reasons.push('MA60仍下弯');
    structureReason = reasons.length > 0 ? `${reasons.join('，')}。` : '继续观察结构变化。';
  }

  let safeZoneStatus: string;
  let safeZoneReason: string;

  if (distanceToMa60 >= profile.safeZoneMin && distanceToMa60 <= profile.safeZoneMax) {
    safeZoneStatus = 'SAFE_ZONE';
    safeZoneReason = `按${profile.label}：价格在MA60附近，处于相对安全区。`;
  } else if (distanceToMa60 > profile.highRiskChaseMin) {
    safeZoneStatus = 'HIGH_RISK_CHASE';
    safeZoneReason = `按${profile.label}：价格明显高于MA60，处于追高区。`;
  } else if (distanceToMa60 < profile.brokenZoneMax) {
    safeZoneStatus = 'BROKEN_ZONE';
    safeZoneReason = `按${profile.label}：价格明显跌破MA60，处于破位区。`;
  } else {
    safeZoneStatus = 'NEUTRAL_ZONE';
    safeZoneReason = `当前位置中性，未进入${profile.label}的安全区或硬风险区。`;
  }
  const invalidationLine = ma60 * (1 - planProfile.invalidationBufferPercent);
  const digits = planProfile.key.startsWith('etf_') ? 4 : 3;

  return {
    trade_date: tradeDate,
    close: Math.round(close * 1000) / 1000,
    ma20: Math.round(ma20 * 1000) / 1000,
    ma60: Math.round(ma60 * 1000) / 1000,
    ma120: Math.round(ma120 * 1000) / 1000,
    distance_to_ma60: Math.round(distanceToMa60 * 10000) / 10000,
    above_ma60_days: aboveMa60Days,
    below_ma60_days: belowMa60Days,
    structure_status: structureStatus,
    structure_reason: structureReason,
    safe_zone_status: safeZoneStatus,
    safe_zone_reason: safeZoneReason,
    invalidation_line: Math.round(invalidationLine * 10 ** digits) / 10 ** digits
  };
}

function calculateWindowMaxDrawdown(prices: DailyPrice[]): number | null {
  if (prices.length < 2) return null;
  let peak = prices[0].high;
  let maxDrawdown = 0;

  for (const price of prices) {
    peak = Math.max(peak, price.high);
    if (peak > 0) {
      maxDrawdown = Math.min(maxDrawdown, price.low / peak - 1);
    }
  }

  return Math.round(maxDrawdown * 10000) / 10000;
}

function calculateRecentRiskProfile(
  prices: DailyPrice[],
  structure: ReturnType<typeof calculateStructure>,
  assetType: string,
  planProfileKey?: string | null
): RecentRiskProfile {
  const profile = getFinanceStructureProfileConfig(planProfileKey);
  const last20 = prices.slice(-20);
  const latest = prices[prices.length - 1];
  const previous = prices[prices.length - 2];
  const high20 = Math.max(...last20.map((price) => price.high));
  const low20 = Math.min(...last20.map((price) => price.low));
  const maxDrawdown20 = calculateWindowMaxDrawdown(last20);
  const pullbackFrom20High = high20 > 0 ? Math.round((latest.close / high20 - 1) * 10000) / 10000 : null;
  const range20 = low20 > 0 ? Math.round((high20 / low20 - 1) * 10000) / 10000 : null;
  const latestChange = previous?.close > 0 ? Math.round((latest.close / previous.close - 1) * 10000) / 10000 : null;
  const thresholds = {
    hardPullback: -profile.drawdownWatchMax,
    warnPullback: -profile.drawdownGoodMax,
    hardDrawdown: -profile.drawdownWeakMax,
    warnDrawdown: -profile.drawdownWatchMax,
    warnRange: profile.amplitudeWatchMax,
    warnLatestSurge: profile.emotionalAmplitudeMin / 3,
    fakeBreakPullback: -Math.max(profile.drawdownGoodMax * 0.8, 0.02)
  };

  const forbiddenReasons: string[] = [];
  const downgradeReasons: string[] = [];

  if (pullbackFrom20High !== null && pullbackFrom20High <= thresholds.hardPullback) {
    forbiddenReasons.push(`距离20日高点回落${Math.abs(pullbackFrom20High * 100).toFixed(1)}%，疑似冲高回落`);
  } else if (pullbackFrom20High !== null && pullbackFrom20High <= thresholds.warnPullback) {
    downgradeReasons.push(`距离20日高点回落${Math.abs(pullbackFrom20High * 100).toFixed(1)}%，强结构降级观察`);
  }

  if (maxDrawdown20 !== null && maxDrawdown20 <= thresholds.hardDrawdown) {
    forbiddenReasons.push(`20日最大回撤${Math.abs(maxDrawdown20 * 100).toFixed(1)}%，波动风险过高`);
  } else if (maxDrawdown20 !== null && maxDrawdown20 <= thresholds.warnDrawdown) {
    downgradeReasons.push(`20日最大回撤${Math.abs(maxDrawdown20 * 100).toFixed(1)}%，安全垫不足`);
  }

  if (
    structure.above_ma60_days <= 5 &&
    pullbackFrom20High !== null &&
    pullbackFrom20High <= thresholds.fakeBreakPullback
  ) {
    forbiddenReasons.push('刚站上MA60但已从20日高点明显回落，按假突破风险处理');
  }

  if (range20 !== null && range20 >= thresholds.warnRange) {
    downgradeReasons.push(`20日振幅${(range20 * 100).toFixed(1)}%，波动偏大`);
  }

  if (latestChange !== null && latestChange >= thresholds.warnLatestSurge) {
    downgradeReasons.push(`最近单日上涨${(latestChange * 100).toFixed(1)}%，避免急涨后追入`);
  }

  const noteParts = [
    maxDrawdown20 !== null ? `20日最大回撤 ${(maxDrawdown20 * 100).toFixed(1)}%` : null,
    pullbackFrom20High !== null ? `距20日高点 ${(pullbackFrom20High * 100).toFixed(1)}%` : null,
    range20 !== null ? `20日振幅 ${(range20 * 100).toFixed(1)}%` : null,
    latestChange !== null ? `最近日涨跌 ${(latestChange * 100).toFixed(1)}%` : null
  ].filter(Boolean);

  return {
    forbidden_reasons: forbiddenReasons,
    downgrade_reasons: downgradeReasons,
    risk_note: noteParts.length > 0 ? noteParts.join('；') : null,
    max_drawdown_20: maxDrawdown20,
    pullback_from_20_high: pullbackFrom20High,
    range_20: range20,
    latest_change: latestChange
  };
}

function calculateCandidatePriority(
  structure: ReturnType<typeof calculateStructure>,
  marketEntryPermission?: string,
  trendPhaseCode?: string,
  riskProfile?: RecentRiskProfile,
  planProfileKey?: string | null
): CandidatePriorityResult {
  const profile = getFinanceStructureProfileConfig(planProfileKey);
  const forbiddenReasons: string[] = [];
  const downgradeReasons: string[] = [];
  let score = 0;

  if (marketEntryPermission !== 'ALLOW_STRUCTURE_CHECK') {
    forbiddenReasons.push('市场环境未开放单标的判断');
  } else {
    score += 20;
  }

  if (structure.structure_status === 'STRUCTURE_CONFIRMED') {
    score += 25;
  } else if (structure.structure_status === 'STRUCTURE_WATCH') {
    score += 10;
    downgradeReasons.push('结构仍在观察，未完全成立');
  } else {
    forbiddenReasons.push('结构破坏或数据不足');
  }

  if (structure.safe_zone_status === 'SAFE_ZONE') {
    score += 20;
  } else if (structure.safe_zone_status === 'NEUTRAL_ZONE') {
    score += 8;
    downgradeReasons.push('位置中性，安全垫不足');
  } else if (structure.safe_zone_status === 'HIGH_RISK_CHASE') {
    forbiddenReasons.push('处于追高区，不进入备选池');
  } else if (structure.safe_zone_status === 'BROKEN_ZONE') {
    forbiddenReasons.push('处于破位区，不进入备选池');
  }

  if (structure.distance_to_ma60 >= -0.01 && structure.distance_to_ma60 <= profile.distanceTightMax) {
    score += 15;
  } else if (structure.distance_to_ma60 >= profile.safeZoneMin && structure.distance_to_ma60 <= profile.safeZoneMax) {
    score += 10;
  } else if (structure.distance_to_ma60 > profile.safeZoneMax) {
    score -= 8;
    downgradeReasons.push(`距离 MA60 超出${profile.label}安全区，追高风险上升`);
  }

  if (structure.above_ma60_days >= Math.max(10, profile.minAboveMa60Days * 3)) {
    score += 10;
  } else if (structure.above_ma60_days >= profile.minAboveMa60Days) {
    score += 6;
  } else {
    downgradeReasons.push('站上 MA60 时间偏短');
  }

  switch (trendPhaseCode) {
    case 'SLOW_GRIND_UP':
    case 'BREAKOUT':
      score += 10;
      break;
    case 'RECOVERY':
      score += 7;
      downgradeReasons.push('修复阶段，等待结构进一步确认');
      break;
    case 'TREND_UP':
      score += 7;
      downgradeReasons.push('趋势上行但波动偏大，等待回踩稳定');
      break;
    case 'TREND_TRANSITION':
    case 'CONSOLIDATION':
    case 'SIDEWAYS':
      score += 3;
      downgradeReasons.push('走势阶段偏观察');
      break;
    case 'HIGH_BASE':
      score -= 10;
      downgradeReasons.push('高位横盘，降低优先级');
      break;
    case 'SURGE':
      forbiddenReasons.push('急涨阶段不追，等待回踩');
      break;
    case 'REBOUND':
      forbiddenReasons.push('反抽阶段只观察，不进入备选池');
      break;
    case 'SLOW_BLEED':
      forbiddenReasons.push('阴跌阶段禁止入池');
      break;
    case 'CRASH_DROP':
      forbiddenReasons.push('暴跌阶段禁止入池');
      break;
    default:
      downgradeReasons.push('走势阶段未确认');
      break;
  }

  if (riskProfile) {
    forbiddenReasons.push(...riskProfile.forbidden_reasons);
    downgradeReasons.push(...riskProfile.downgrade_reasons);
    if (riskProfile.forbidden_reasons.length > 0) {
      score = Math.min(score, 45);
    } else if (riskProfile.downgrade_reasons.length > 0) {
      score -= Math.min(20, riskProfile.downgrade_reasons.length * 6);
    }
  }

  const priorityScore = Math.max(0, Math.min(100, Math.round(score)));
  const priority = priorityScore >= 80 ? 'high' : priorityScore >= 60 ? 'medium' : 'low';

  return {
    priority,
    priority_score: priorityScore,
    forbidden_reason: forbiddenReasons.length > 0 ? forbiddenReasons.join('；') : null,
    downgrade_reason: downgradeReasons.length > 0 ? Array.from(new Set(downgradeReasons)).join('；') : null,
    risk_note: riskProfile?.risk_note || null
  };
}

function getTrendPhaseLabel(code?: string): string {
  switch (code) {
    case 'CRASH_DROP': return '暴跌';
    case 'SURGE': return '急涨';
    case 'REBOUND': return '反抽';
    case 'BREAKOUT': return '突破';
    case 'HIGH_BASE': return '高位横盘';
    case 'TREND_UP': return '趋势上行';
    case 'SLOW_GRIND_UP': return '慢涨';
    case 'RECOVERY': return '修复';
    case 'SIDEWAYS': return '横盘震荡';
    case 'SLOW_BLEED': return '阴跌';
    case 'CONSOLIDATION': return '震荡待确认';
    case 'TREND_TRANSITION': return '趋势转换中';
    case 'UNKNOWN': return '状态未确认';
    default: return code || '';
  }
}

function toNullableNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function classifyOpportunityType(input: any): OpportunityTypeTag {
  const trendPhaseCode = String(input?.trend_phase_code || input?.trend_phase?.trend_phase_code || 'UNKNOWN');
  const assetType = String(input?.asset_type || 'stock');
  const structureStatus = String(input?.structure_status || input?.structure?.structure_status || '');
  const safeZoneStatus = String(input?.safe_zone_status || input?.structure?.safe_zone_status || '');
  const distanceToMa60 = toNullableNumber(input?.distance_to_ma60 ?? input?.structure?.distance_to_ma60);
  const aboveMa60Days = toNullableNumber(input?.above_ma60_days ?? input?.structure?.above_ma60_days) ?? 0;
  const amplitudeOrRange = toNullableNumber(input?.amplitude_20 ?? input?.range_20);
  const ma20Slope = String(input?.ma20_slope || input?.structure_score?.metrics?.ma20_slope || '');
  const ma60Slope = String(input?.ma60_slope || input?.structure_score?.metrics?.ma60_slope || input?.structure?.ma60_slope || '');
  const structureConfirmed = structureStatus === 'STRUCTURE_CONFIRMED';
  const safeZone = safeZoneStatus === 'SAFE_ZONE';
  const profile = getFinanceStructureProfileConfig(input?.plan_profile || input?.profile_key);
  const distanceComfortable = distanceToMa60 !== null && distanceToMa60 >= profile.safeZoneMin && distanceToMa60 <= profile.distanceComfortMax;
  const distanceClose = distanceToMa60 !== null && distanceToMa60 >= profile.safeZoneMin && distanceToMa60 <= profile.distanceTightMax;
  const lowVolatility = amplitudeOrRange !== null && amplitudeOrRange <= profile.lowVolatilityMax;

  if (!['stock', 'etf'].includes(assetType)) {
    return {
      code: 'NOT_APPLICABLE',
      label: '不适用型',
      tone: 'neutral',
      reason: '资产类型不匹配当前权益池，先进入资产路由，不作为硬闸门外的交易许可。'
    };
  }

  if (
    trendPhaseCode === 'SURGE' ||
    (amplitudeOrRange !== null && amplitudeOrRange >= profile.emotionalAmplitudeMin && !distanceClose)
  ) {
    return {
      code: 'EMOTIONAL',
      label: '情绪型/急涨型',
      tone: 'warn',
      reason: '短期急涨或波动过大，只作为解释层提示，不追涨，不直接放大计划。'
    };
  }

  if (
    safeZone &&
    structureConfirmed &&
    distanceComfortable &&
    (
      trendPhaseCode === 'SLOW_GRIND_UP' ||
      trendPhaseCode === 'BREAKOUT' ||
      (ma20Slope === 'up' && (ma60Slope === 'up' || ma60Slope === 'flat') && aboveMa60Days >= 10)
    )
  ) {
    return {
      code: 'TREND',
      label: '趋势型',
      tone: 'good',
      reason: '结构较强，可优先进入计划跟踪，仍需失效线和仓位控制。'
    };
  }

  if (
    trendPhaseCode === 'SIDEWAYS' ||
    trendPhaseCode === 'CONSOLIDATION' ||
    (distanceClose && aboveMa60Days >= 12 && (lowVolatility || trendPhaseCode === 'RECOVERY'))
  ) {
    return {
      code: 'DEFENSIVE',
      label: '防守型',
      tone: 'neutral',
      reason: '低波动或横盘属性更强，结构稳定但进攻性不足，适合观察或低仓训练。'
    };
  }

  if (
    trendPhaseCode === 'RECOVERY' ||
    trendPhaseCode === 'TREND_TRANSITION' ||
    trendPhaseCode === 'REBOUND' ||
    trendPhaseCode === 'HIGH_BASE' ||
    trendPhaseCode === 'UNKNOWN' ||
    !structureConfirmed ||
    aboveMa60Days < 10 ||
    ma60Slope === 'down'
  ) {
    return {
      code: 'REPAIR',
      label: '修复型',
      tone: 'warn',
      reason: '刚从下跌或震荡中修复，尚未证明趋势重启，等待二次确认。'
    };
  }

  return {
    code: 'DEFENSIVE',
    label: '防守型',
    tone: 'neutral',
    reason: '结构偏稳但进攻特征不强，适合观察或低仓训练。'
  };
}

function buildCandidateReason(structureReason: string, safeZoneReason: string, trendPhaseCode?: string): string {
  const parts = ['安全区 + 结构成立'];
  if (trendPhaseCode) parts.push(`走势阶段：${getTrendPhaseLabel(trendPhaseCode)}`);
  parts.push(structureReason);
  parts.push(safeZoneReason);
  return parts.join('；');
}

function joinReasonParts(...parts: Array<string | null | undefined>): string | null {
  const values = parts.filter((part): part is string => Boolean(part));
  return values.length > 0 ? values.join('；') : null;
}

async function evaluateEtfIndustryGate(
  db: any,
  symbol: string,
  source: string,
  name: string | null | undefined,
  prices: DailyPrice[],
  context?: IndustryEtfStrengthContext
): Promise<{ strength: IndustryEtfStrengthItem | null; forbidden_reason: string | null; note: string | null }> {
  const strengthContext = context || await buildIndustryEtfStrengthContext(db, { scope: 'focus', benchmarkSymbol: '000300' });
  const industryCandidate = strengthContext.candidateMap.get(symbol);

  if (!industryCandidate) {
    return {
      strength: null,
      forbidden_reason: 'ETF未纳入行业强度层，先压出备选池。',
      note: null
    };
  }

  const strength = calculateIndustryEtfStrength(
    {
      ...industryCandidate,
      name: industryCandidate.name || name || symbol,
      source: industryCandidate.source || source
    },
    prices,
    strengthContext.benchmarkReturns
  );

  return {
    strength,
    forbidden_reason: buildIndustryStrengthGateReason(strength),
    note: formatIndustryStrengthNote(strength)
  };
}

function splitUniverseTypes(value?: string | null): string[] {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function classifyEtfStrategyRoute(
  symbol: string,
  name: string | null | undefined,
  universeTypes: string | null | undefined,
  context?: IndustryEtfStrengthContext
): EtfStrategyRoute {
  const text = `${name || ''} ${symbol}`;
  const typeSet = new Set(splitUniverseTypes(universeTypes));
  const isFocusOrIndustry = typeSet.has('industry_etf') || Boolean(context?.candidateMap.has(symbol));
  const makeRoute = (
    key: EtfRouteKey,
    label: string,
    currentPoolApplicable: boolean,
    targetPool: string,
    note: string
  ): EtfStrategyRoute => ({
    key,
    label,
    current_pool_applicable: currentPoolApplicable,
    target_pool: targetPool,
    forbidden_reason: currentPoolApplicable ? null : note,
    note
  });

  if (typeSet.has('bond_cash_etf') || /货币|快线|现金(?!流)|债|国债|地债|政金|城投|信用债|可转债|短融|同业存单|存单/.test(text)) {
    return makeRoute(
      'bond_cash',
      '债券/货币ETF',
      false,
      '低波动/配置池',
      '债券/货币类ETF不适用当前权益主升策略，只展示结构结果，暂不进入权益ETF备选池。'
    );
  }

  if (typeSet.has('commodity_etf') || /黄金ETF|上海金|金ETF|白银|豆粕|商品|原油|能源化工|有色期货/.test(text)) {
    return makeRoute(
      'commodity',
      '商品ETF',
      false,
      '商品ETF观察池',
      '商品ETF受商品、美元、利率和避险逻辑影响，不适用当前权益主升策略，只展示结构结果。'
    );
  }

  if (typeSet.has('cross_border_etf') || /QDII|纳指|纳斯达克|标普|德国|法国|日经|东证|恒生|港股|中概|海外|美国|亚太|东南亚|沙特|印度/.test(text) || symbol.startsWith('513')) {
    return makeRoute(
      'cross_border',
      'QDII/跨境ETF',
      false,
      '跨境ETF观察池',
      'QDII/跨境ETF需要额外处理汇率、海外市场时差和折溢价风险，暂不进入权益主升备选池。'
    );
  }

  if (typeSet.has('special_fund') || /LOF|封闭|REIT|REITS|基础设施|创新未来|定开/.test(text)) {
    return makeRoute(
      'special_fund',
      'LOF/特殊基金',
      false,
      '特殊基金观察池',
      'LOF/特殊基金需要额外处理折溢价和基金结构风险，暂不进入权益主升备选池。'
    );
  }

  if (typeSet.has('broad_etf')) {
    return makeRoute(
      'equity_broad',
      '宽基权益ETF',
      true,
      '宽基结构池',
      '宽基权益ETF走宽基/市场总闸和自身结构，不走行业强度层。'
    );
  }

  if (isFocusOrIndustry) {
    return makeRoute(
      'equity_industry',
      '行业/主题权益ETF',
      true,
      '行业主题池',
      '行业/主题权益ETF需通过行业强度层，再结合自身结构和安全区。'
    );
  }

  return makeRoute(
    'unknown',
    '未归类ETF',
    false,
    '待归类池',
    universeTypes
      ? `ETF分组为 ${universeTypes}，当前未识别为宽基、行业主题、商品、跨境、债券/货币或特殊基金；只展示结构结果，暂不进入交易池。`
      : 'ETF分类未识别，只展示结构结果，暂不进入交易池。'
  );
}

async function evaluateEtfPreGate(
  db: any,
  symbol: string,
  source: string,
  name: string | null | undefined,
  universeTypes: string | null | undefined,
  prices: DailyPrice[],
  context?: IndustryEtfStrengthContext,
  route?: EtfStrategyRoute
): Promise<{ strength: IndustryEtfStrengthItem | null; forbidden_reason: string | null; note: string | null }> {
  const strengthContext = context || await buildIndustryEtfStrengthContext(db, { scope: 'focus', benchmarkSymbol: '000300' });
  const strategyRoute = route || classifyEtfStrategyRoute(symbol, name, universeTypes, strengthContext);

  if (!strategyRoute.current_pool_applicable) {
    return {
      strength: null,
      forbidden_reason: strategyRoute.note,
      note: `ETF策略路由：${strategyRoute.label} -> ${strategyRoute.target_pool}`
    };
  }

  const typeSet = new Set(splitUniverseTypes(universeTypes));
  const isIndustryOrFocusEtf = strategyRoute.key === 'equity_industry' || typeSet.has('industry_etf') || strengthContext.candidateMap.has(symbol);

  if (isIndustryOrFocusEtf) {
    return evaluateEtfIndustryGate(db, symbol, source, name, prices, strengthContext);
  }

  if (strategyRoute.key === 'equity_broad' || typeSet.has('broad_etf')) {
    return {
      strength: null,
      forbidden_reason: null,
      note: `ETF策略路由：${strategyRoute.label} -> ${strategyRoute.target_pool}；宽基ETF走宽基/市场总闸和自身结构，不走行业强度层`
    };
  }

  return {
    strength: null,
    forbidden_reason: strategyRoute.note,
    note: `ETF策略路由：${strategyRoute.label} -> ${strategyRoute.target_pool}`
  };
}

function formatPercent(value?: number | null, digits = 1): string {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '--';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function formatSignedPercent(value?: number | null, digits = 1): string {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '--';
  const percent = Number(value) * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(digits)}%`;
}

function resolveCandidateProfile(item: any) {
  return resolveFinancePlanProfile({
    assetType: item?.asset_type,
    symbol: item?.symbol,
    name: item?.name,
    universeType: item?.universe_types || item?.universe_type || item?.etf_universe_types
  });
}

function hasSupportedModelTarget(item: any): boolean {
  return !item?.ml_target || item.ml_target === 'label_structure_safe_20d';
}

function getCandidateModelSignal(item: any): 'accept' | 'neutral' | 'conflict' | 'unscored' {
  if (!item.ml_available || item.ml_probability === undefined || item.ml_probability === null) return 'unscored';
  const structureProfile = getFinanceStructureProfileConfig(resolveCandidateProfile(item).key);
  const highThreshold = structureProfile.modelHighProbability;
  const lowThreshold = structureProfile.modelLowProbability;
  if (item.ml_probability >= highThreshold) return 'accept';
  if (item.ml_probability < lowThreshold) return 'conflict';
  return 'neutral';
}

function getCandidateRiskSignal(item: any): 'clean' | 'warning' | 'danger' {
  if (item.forbidden_reason || /假突破|冲高回落|风险过高|追高|破位/.test(item.forbidden_reason || '')) {
    return 'danger';
  }
  if (/回撤|振幅|急涨|高点回落|安全垫不足|降级|波动偏大/.test(item.downgrade_reason || '')) {
    return 'warning';
  }
  return 'clean';
}

function getCandidatePoolLane(item: any): { key: string; label: string } {
  const modelKey = getCandidateModelSignal(item);
  const riskKey = getCandidateRiskSignal(item);
  const targetMismatch = !hasSupportedModelTarget(item);
  if (modelKey === 'accept' && riskKey === 'clean' && !targetMismatch) return { key: 'focus', label: '模型认可重点池' };
  if (modelKey === 'accept' && riskKey !== 'clean' && !targetMismatch) return { key: 'risk_downgrade', label: '模型认可但风险降级' };
  if ((modelKey === 'neutral' || modelKey === 'accept') && !targetMismatch) return { key: 'observe', label: '中性观察池' };
  return { key: 'residual', label: '规则残留池' };
}

function getSuggestedReviewAction(item: any): { key: string; label: string; tone: string } {
  const modelKey = getCandidateModelSignal(item);
  const riskKey = getCandidateRiskSignal(item);
  const targetMismatch = !hasSupportedModelTarget(item);
  if (targetMismatch || modelKey === 'unscored') {
    return { key: 'MOVE_TO_RESIDUAL', label: '移入规则残留', tone: 'neutral' };
  }
  if (modelKey === 'conflict') {
    return { key: 'IGNORE_OR_RESCAN', label: '先忽略或等下次扫描', tone: 'danger' };
  }
  if (modelKey === 'accept' && riskKey === 'clean' && item.trend_phase_code && item.trend_phase_code !== 'UNKNOWN') {
    return { key: 'PREPARE_PLAN', label: '可进入买入计划准备', tone: 'success' };
  }
  if (modelKey === 'accept') {
    return { key: 'WAIT_CONFIRMATION', label: '等待二次确认', tone: 'warning' };
  }
  return { key: 'CONTINUE_OBSERVE', label: '继续观察', tone: 'neutral' };
}

function getReviewStatusLabel(status?: string | null): string {
  switch (status) {
    case 'drafted': return '已生成草稿';
    case 'trend_blocked': return '卡在走势阶段';
    case 'structure_pending': return '待单标的判断';
    case 'structure_watch': return '单标的观察';
    case 'structure_ready': return '单标的通过';
    case 'model_conflict': return '模型冲突待复核';
    case 'wait_confirmation': return '等待二次确认';
    case 'plan_ready': return '进入计划准备';
    case 'rejected': return '复盘淘汰';
    case 'unreviewed':
    default:
      return '未复盘';
  }
}

function getStructureQueueStatusMeta(item: any): { key: string; label: string; tone: string; reason: string } {
  const status = String(item?.review_status || 'structure_pending');
  const trendCode = String(item?.trend_phase_code || '');
  const reason = item?.candidate_reason || item?.forbidden_reason || item?.downgrade_reason || item?.trend_phase_reason || '等待单标的判断。';

  if (status === 'structure_watch') {
    return { key: 'watch', label: '单标的观察', tone: 'warning', reason };
  }
  if (status === 'model_conflict') {
    return { key: 'model_conflict', label: '模型冲突待复核', tone: 'cyan', reason };
  }
  if (status === 'wait_confirmation') {
    return { key: 'entry_trigger', label: '已推进入场触发', tone: 'success', reason: reason || '单标的判断通过，等待入场触发扫描。' };
  }
  if (status === 'trend_blocked' || (trendCode && !STRUCTURE_READY_TREND_PHASES.has(trendCode))) {
    return { key: 'trend_blocked', label: '退回走势阶段', tone: 'warning', reason };
  }
  return { key: 'pending', label: '待单标的判断', tone: 'neutral', reason };
}

function resolveStructureQueueDecision(evaluation: any): {
  review_status: string;
  pool_status: string;
  final_status: string;
  review_action: string;
  reason: string;
} {
  const reason = evaluation?.candidate_reason || evaluation?.forbidden_reason || evaluation?.reason || '单标的判断结果待确认';
  if (evaluation?.selected) {
    return {
      review_status: 'wait_confirmation',
      pool_status: 'active',
      final_status: 'READY_FOR_PLAN',
      review_action: 'single_target_passed_to_entry',
      reason: reason || '单标的判断通过，已推进入场触发。'
    };
  }

  const gateKey = String(evaluation?.first_blocking_gate_key || '');
  if (gateKey === 'trend_phase_gate') {
    return {
      review_status: 'trend_blocked',
      pool_status: 'active',
      final_status: 'WAIT',
      review_action: 'single_target_back_to_trend',
      reason: `走势阶段未通过：${reason}`
    };
  }

  if (STRUCTURE_HARD_REJECT_GATES.has(gateKey) || isHardBlockedFromModelRecheck(evaluation)) {
    return {
      review_status: 'rejected',
      pool_status: 'expired',
      final_status: 'REJECTED',
      review_action: 'single_target_hard_rejected',
      reason
    };
  }

  return {
    review_status: 'structure_watch',
    pool_status: 'active',
    final_status: 'WAIT',
    review_action: 'single_target_watch',
    reason
  };
}

async function applyStructureQueueDecision(db: any, id: number, evaluation: any, name = '') {
  const now = new Date().toISOString();
  const decision = resolveStructureQueueDecision(evaluation);
  const structure = evaluation.structure || {};
  const trendPhase = evaluation.trend_phase || {};
  const marketRegime = evaluation.market_regime || {};

  if (evaluation.selected) {
    await upsertCandidate(db, evaluation, name);
  }

  await db.run(
    `UPDATE financial_candidate_pool
     SET trade_date = COALESCE(?, trade_date),
         close = COALESCE(?, close),
         ma20 = COALESCE(?, ma20),
         ma60 = COALESCE(?, ma60),
         ma120 = COALESCE(?, ma120),
         distance_to_ma60 = COALESCE(?, distance_to_ma60),
         above_ma60_days = COALESCE(?, above_ma60_days),
         structure_status = COALESCE(?, structure_status),
         structure_reason = COALESCE(?, structure_reason),
         safe_zone_status = COALESCE(?, safe_zone_status),
         safe_zone_reason = COALESCE(?, safe_zone_reason),
         trend_phase_code = COALESCE(?, trend_phase_code),
         trend_phase_reason = COALESCE(?, trend_phase_reason),
         market_regime = COALESCE(?, market_regime),
         entry_permission = COALESCE(?, entry_permission),
         plan_profile = COALESCE(?, plan_profile),
         plan_profile_label = COALESCE(?, plan_profile_label),
         final_status = ?,
         pool_status = ?,
         priority = COALESCE(?, priority),
         priority_score = COALESCE(?, priority_score),
         invalidation_line = COALESCE(?, invalidation_line),
         candidate_reason = ?,
         forbidden_reason = ?,
         downgrade_reason = ?,
         risk_note = ?,
         review_status = ?,
         gate_trace_json = ?,
         first_blocking_gate_key = ?,
         first_blocking_gate_label = ?,
         blocking_gate_labels = ?,
         last_checked_at = ?,
         last_review_at = ?,
         review_action = ?,
         updated_at = ?
     WHERE id = ?
       AND rule_version = ?`,
    [
      structure.trade_date || null,
      structure.close ?? null,
      structure.ma20 ?? null,
      structure.ma60 ?? null,
      structure.ma120 ?? null,
      structure.distance_to_ma60 ?? null,
      structure.above_ma60_days ?? null,
      structure.structure_status || null,
      structure.structure_reason || null,
      structure.safe_zone_status || null,
      structure.safe_zone_reason || null,
      trendPhase.trend_phase_code || null,
      trendPhase.trend_phase_reason || null,
      marketRegime.market_regime || null,
      marketRegime.entry_permission || null,
      evaluation.plan_profile || null,
      evaluation.plan_profile_label || null,
      decision.final_status,
      decision.pool_status,
      evaluation.priority || null,
      evaluation.priority_score ?? null,
      structure.invalidation_line ?? null,
      decision.reason,
      decision.review_status === 'rejected' ? (evaluation.forbidden_reason || decision.reason) : (evaluation.forbidden_reason || null),
      evaluation.downgrade_reason || null,
      evaluation.risk_note || '',
      decision.review_status,
      evaluation.gate_trace ? JSON.stringify(evaluation.gate_trace) : null,
      evaluation.first_blocking_gate_key || null,
      evaluation.first_blocking_gate_label || null,
      evaluation.blocking_gate_labels || null,
      now,
      now,
      decision.review_action,
      now,
      id,
      CANDIDATE_RULE_VERSION
    ]
  );

  return decision;
}

async function fetchStructureQueueItem(db: any, id: number) {
  const row = await db.get(
    `SELECT c.*,
            (
              SELECT GROUP_CONCAT(DISTINCT u.universe_type)
              FROM financial_asset_universe u
              WHERE u.symbol = c.symbol
                AND u.asset_type = c.asset_type
                AND u.source = c.source
            ) AS universe_type
     FROM financial_candidate_pool c
     WHERE c.id = ?
       AND c.rule_version = ?`,
    [id, CANDIDATE_RULE_VERSION]
  );
  if (!row) return null;
  const hydrated = hydrateCandidateItem(row);
  const statusMeta = getStructureQueueStatusMeta(hydrated);
  return {
    ...hydrated,
    queue_status: statusMeta.key,
    queue_status_label: statusMeta.label,
    queue_status_tone: statusMeta.tone,
    queue_reason: statusMeta.reason
  };
}

function splitReasonText(text?: string | null): string[] {
  if (!text) return [];
  return String(text)
    .split(/[；;]/)
    .map(part => part.trim())
    .filter(Boolean);
}

function buildCandidateReviewDraft(item: any) {
  const modelKey = getCandidateModelSignal(item);
  const riskKey = getCandidateRiskSignal(item);
  const lane = getCandidatePoolLane(item);
  const action = getSuggestedReviewAction(item);
  const targetMismatch = !hasSupportedModelTarget(item);
  const riskItems = [
    ...splitReasonText(item.forbidden_reason),
    ...splitReasonText(item.downgrade_reason),
    ...(item.risk_note ? [item.risk_note] : [])
  ];

  const modelText: string[] = [];
  if (item.ml_available && typeof item.ml_probability === 'number') {
    modelText.push(`模型概率 ${formatPercent(item.ml_probability)}，模型键 ${item.ml_model_key || '--'}。`);
    modelText.push(`训练目标 ${item.ml_target || '--'}，评分日期 ${item.ml_score_trade_date || item.trade_date || '--'}。`);
  } else {
    modelText.push(item.ml_score_reason || '当前没有可用模型评分。');
  }
  if (targetMismatch) {
    modelText.push('该标的不是当前个股结构安全模型目标，或模型标签不一致，不能和个股重点池同级处理。');
  }

  const confirmationItems: string[] = [];
  if (!item.trend_phase_code || item.trend_phase_code === 'UNKNOWN') {
    confirmationItems.push('走势阶段未确认，下一次扫描需要先补趋势阶段判断。');
  } else {
    confirmationItems.push(`走势阶段为 ${getTrendPhaseLabel(item.trend_phase_code)}，观察是否能延续而不是单日脉冲。`);
  }
  if (riskKey === 'warning') {
    confirmationItems.push('存在风险降级项，等待回撤收敛、波动降低或重新站稳后再升级。');
  }
  confirmationItems.push('优先看回踩不破 MA60/失效线，且不出现放量冲高回落。');

  const invalidationItems = [
    item.invalidation_line ? `收盘价跌破失效线 ${Number(item.invalidation_line).toFixed(3)}。` : '失效线缺失，暂时不能进入严格计划。',
    '连续跌破 MA60 或结构状态转为破坏。',
    '下一轮模型评分跌破中性区，或规则扫描转为禁止入池。',
    '风险摘要新增假突破、冲高回落或20日回撤显著扩大。'
  ];

  return {
    generated_at: new Date().toISOString(),
    review_id: item.last_review_id || null,
    lane,
    model_signal: modelKey,
    risk_signal: riskKey,
    suggested_action: action,
    review_status: {
      key: item.review_status || 'unreviewed',
      label: getReviewStatusLabel(item.review_status)
    },
    summary: `${item.symbol} ${item.name || ''} 当前归入「${lane.label}」，建议动作：${action.label}。`,
    candidate: item,
    sections: [
      {
        title: '入池理由',
        items: [
          item.candidate_reason || '暂无入池原因。',
          `机会类型：${item.opportunity_type?.label || classifyOpportunityType(item).label}。${item.opportunity_type?.reason || classifyOpportunityType(item).reason}`,
          `结构：${item.structure_status || '--'}；安全区：${item.safe_zone_status || '--'}；偏离 MA60 ${formatSignedPercent(item.distance_to_ma60)}；连续站上 MA60 ${item.above_ma60_days ?? 0} 天。`,
          `优先级 ${item.priority || '--'}，评分 ${item.priority_score ?? '--'}。`
        ]
      },
      {
        title: '模型判断',
        items: modelText
      },
      {
        title: '风险点',
        items: riskItems.length > 0 ? riskItems : ['当前没有明显风险降级或禁止项。']
      },
      {
        title: '二次确认',
        items: confirmationItems
      },
      {
        title: '失效条件',
        items: invalidationItems
      }
    ]
  };
}

async function evaluateCandidate(
  db: any,
  symbol: string,
  assetType: string,
  source: string,
  industryStrengthContext?: IndustryEtfStrengthContext
) {
  if (!CANDIDATE_POOL_ASSET_TYPES.includes(assetType)) {
    const reason = '备选池只允许 A股个股 和 ETF，指数只作为市场总闸/宽基参照，不进入备选池。';
    return attachGateTrace({
      selected: false,
      symbol,
      asset_type: assetType,
      source,
      priority: 'low',
      priority_score: 0,
      reason,
      forbidden_reason: reason,
      downgrade_reason: null,
      risk_note: null,
      candidate_reason: reason
    }, [
      makeGate('asset_applicability', 'not_applicable', reason, true),
      makeGate('model_reference', 'not_applicable', '模型不参与资产适用性判断。')
    ], false, reason);
  }

  const assetMeta = await db.get(
    `SELECT MAX(name) AS name, GROUP_CONCAT(DISTINCT universe_type) AS universe_types
     FROM financial_asset_universe
     WHERE symbol = ? AND asset_type = ? AND source = ?`,
    [symbol, assetType, source]
  );
  if (isSpecialTreatmentName(assetMeta?.name)) {
    const reason = 'ST / *ST / 退市风险标的，禁止进入备选池。';
    return attachGateTrace({
      selected: false,
      symbol,
      asset_type: assetType,
      source,
      priority: 'low',
      priority_score: 0,
      reason,
      forbidden_reason: reason,
      downgrade_reason: null,
      risk_note: 'ST / *ST / 退市风险',
      candidate_reason: reason
    }, [
      makeGate('asset_applicability', 'passed', `${assetType === 'etf' ? 'ETF' : 'A股个股'}属于当前备选池可评估类型。`),
      makeGate('special_treatment', 'failed', reason, true),
      makeGate('model_reference', 'not_applicable', '模型不参与 ST/退市过滤。')
    ], false, reason);
  }
  const prices = await db.all(
    `SELECT trade_date, open, high, low, close, volume, amount
     FROM financial_daily_prices
     WHERE symbol = ? AND asset_type = ? AND source = ?
     ORDER BY trade_date ASC`,
    [symbol, assetType, source]
  );

  if (prices.length < 120) {
    const reason = `数据不足（当前${prices.length}条），需要至少120条日线。`;
    return attachGateTrace({
      selected: false,
      symbol,
      asset_type: assetType,
      source,
      reason,
      priority: 'low',
      priority_score: 0,
      forbidden_reason: reason,
      downgrade_reason: null,
      risk_note: null
    }, [
      makeGate('asset_applicability', 'passed', `${assetType === 'etf' ? 'ETF' : 'A股个股'}属于当前备选池可评估类型。`),
      makeGate('data_ready', 'failed', reason, true),
      makeGate('special_treatment', 'passed', '未命中 ST / 退市过滤。'),
      makeGate('model_reference', 'not_applicable', '数据不足时不进入模型参考。')
    ], false, reason);
  }

  const etfRoute = assetType === 'etf'
    ? classifyEtfStrategyRoute(symbol, assetMeta?.name, assetMeta?.universe_types, industryStrengthContext)
    : null;
  const planProfile = resolveFinancePlanProfile({
    assetType,
    symbol,
    name: assetMeta?.name || symbol,
    universeType: assetMeta?.universe_types || ''
  });
  const structureProfile = getFinanceStructureProfileConfig(planProfile.key);
  const etfPreGate = assetType === 'etf'
    ? await evaluateEtfPreGate(db, symbol, source, assetMeta?.name, assetMeta?.universe_types, prices, industryStrengthContext, etfRoute || undefined)
    : null;
  const stockTradeQualification = assetType === 'stock'
    ? await calculateStockTradeQualification(db, symbol, source, prices)
    : null;

  const structure = calculateStructure(prices, planProfile.key);
  const riskProfile = calculateRecentRiskProfile(prices, structure, assetType, planProfile.key);
  const trendPhase = await db.get(
    `SELECT trend_phase_code, trend_phase_reason
     FROM financial_trend_phase_results
     WHERE symbol = ? AND asset_type = ? AND source = ? AND rule_version = ?
     ORDER BY trade_date DESC LIMIT 1`,
    [symbol, assetType, source, TREND_PHASE_VERSION]
  );

  const marketRegime = await db.get(
    `SELECT market_regime, entry_permission
     FROM financial_market_regime
     WHERE symbol = '000300'
     ORDER BY trade_date DESC LIMIT 1`
  );

  const priorityResult = calculateCandidatePriority(
    structure,
    marketRegime?.entry_permission || 'OBSERVE_ONLY',
    trendPhase?.trend_phase_code,
    riskProfile,
    planProfile.key
  );
  const opportunityType = classifyOpportunityType({
    asset_type: assetType,
    plan_profile: planProfile.key,
    structure,
    structure_status: structure.structure_status,
    safe_zone_status: structure.safe_zone_status,
    distance_to_ma60: structure.distance_to_ma60,
    above_ma60_days: structure.above_ma60_days,
    trend_phase_code: trendPhase?.trend_phase_code,
    range_20: riskProfile.range_20,
    priority_score: priorityResult.priority_score
  });
  const etfGateReason = getEtfGateReason(
    assetType,
    etfRoute,
    priorityResult,
    structureProfile.candidatePriorityPassScore
  );
  const etfPreGateReason = etfPreGate?.forbidden_reason
    ? `${etfPreGate.forbidden_reason.replace(/[。；;]+$/, '')}；当前结果只表示不进入“权益主升ETF池”，结构扫描结果仍保留。`
    : null;

  const selected =
    structure.structure_status === 'STRUCTURE_CONFIRMED' &&
    structure.safe_zone_status === 'SAFE_ZONE' &&
    (marketRegime?.entry_permission || 'OBSERVE_ONLY') === 'ALLOW_STRUCTURE_CHECK' &&
    !priorityResult.forbidden_reason &&
    !stockTradeQualification?.forbidden_reason &&
    !etfPreGateReason &&
    !etfGateReason;

  const candidateReason = selected
    ? buildCandidateReason(structure.structure_reason, structure.safe_zone_reason, trendPhase?.trend_phase_code)
    : stockTradeQualification?.forbidden_reason || priorityResult.forbidden_reason || etfPreGateReason || etfGateReason || '未同时满足安全区、结构成立和市场允许进入判断。';
  const etfGateNote = etfPreGate?.note || null;
  const stockTradeNote = assetType === 'stock' ? stockTradeQualification?.note || null : null;
  const fullCandidateReason = joinReasonParts(etfGateNote, stockTradeNote, candidateReason) || candidateReason;
  const gateTrace = attachGateTrace({}, [
    makeGate('asset_applicability', 'passed', `${assetType === 'etf' ? '权益类ETF' : 'A股个股'}属于当前备选池可评估类型。`),
    makeGate('data_ready', 'passed', `本地日线 ${prices.length} 条，满足至少120日要求。`),
    assetType === 'stock'
      ? makeGate(
          'data_freshness_gate',
          stockTradeQualification?.data_freshness.status || 'not_applicable',
          stockTradeQualification?.data_freshness.reason || '日线同步状态未计算。',
          Boolean(stockTradeQualification?.data_freshness.blocking)
        )
      : makeGate('data_freshness_gate', 'not_applicable', 'ETF日线同步由ETF流程单独复核。'),
    makeGate('special_treatment', 'passed', '未命中 ST / 退市过滤。'),
    assetType === 'stock'
      ? makeGate(
          'liquidity_gate',
          stockTradeQualification?.liquidity.passed ? 'passed' : 'failed',
          stockTradeQualification?.liquidity.reason || '流动性未计算。',
          !stockTradeQualification?.liquidity.passed
        )
      : makeGate('liquidity_gate', 'not_applicable', 'ETF暂不走个股流动性硬门槛。'),
    assetType === 'stock'
      ? makeGate(
          'market_cap_gate',
          stockTradeQualification?.market_cap.status || 'not_applicable',
          stockTradeQualification?.market_cap.reason || '本地未落市值数据。',
          Boolean(stockTradeQualification?.market_cap.blocking)
        )
      : makeGate('market_cap_gate', 'not_applicable', 'ETF暂不走个股市值硬门槛。'),
    assetType === 'stock'
      ? makeGate(
          'extreme_trade_gate',
          stockTradeQualification?.extreme_trade.passed ? 'passed' : 'failed',
          stockTradeQualification?.extreme_trade.reason || '极端交易状态未计算。',
          !stockTradeQualification?.extreme_trade.passed
        )
      : makeGate('extreme_trade_gate', 'not_applicable', 'ETF暂不走个股极端交易状态硬门槛。'),
    makeGate(
      'market_gate',
      (marketRegime?.entry_permission || 'OBSERVE_ONLY') === 'ALLOW_STRUCTURE_CHECK' ? 'passed' : 'failed',
      (marketRegime?.entry_permission || 'OBSERVE_ONLY') === 'ALLOW_STRUCTURE_CHECK'
        ? '市场总闸允许进入结构判断。'
        : '市场总闸未开放单标的结构判断。',
      (marketRegime?.entry_permission || 'OBSERVE_ONLY') !== 'ALLOW_STRUCTURE_CHECK'
    ),
    makeGate(
      'structure_gate',
      structure.structure_status === 'STRUCTURE_CONFIRMED' ? 'passed' : 'failed',
      structure.structure_reason,
      structure.structure_status !== 'STRUCTURE_CONFIRMED'
    ),
    makeGate(
      'safe_zone_gate',
      structure.safe_zone_status === 'SAFE_ZONE' ? 'passed' : 'failed',
      structure.safe_zone_reason,
      structure.safe_zone_status !== 'SAFE_ZONE'
    ),
    assetType === 'etf'
      ? makeGate(
          'trend_phase_gate',
          !trendPhase?.trend_phase_code || trendPhase.trend_phase_code === 'UNKNOWN'
            ? 'not_applicable'
            : ETF_HARD_BLOCK_TREND_PHASES.has(trendPhase.trend_phase_code)
              ? 'failed'
              : 'passed',
          !trendPhase?.trend_phase_code || trendPhase.trend_phase_code === 'UNKNOWN'
            ? 'ETF走势阶段未确认，仅用于优先级降权和复核提示，不再一票否决。'
            : ETF_HARD_BLOCK_TREND_PHASES.has(trendPhase.trend_phase_code)
              ? `ETF走势阶段为${getTrendPhaseLabel(trendPhase.trend_phase_code)}，不进入权益主升备选池。`
              : `ETF走势阶段已确认：${getTrendPhaseLabel(trendPhase.trend_phase_code)}。`,
          Boolean(trendPhase?.trend_phase_code && ETF_HARD_BLOCK_TREND_PHASES.has(trendPhase.trend_phase_code))
        )
      : makeGate(
          'trend_phase_gate',
          trendPhase?.trend_phase_code && trendPhase.trend_phase_code !== 'UNKNOWN' ? 'passed' : 'not_applicable',
          trendPhase?.trend_phase_code && trendPhase.trend_phase_code !== 'UNKNOWN'
            ? `走势阶段已确认：${getTrendPhaseLabel(trendPhase.trend_phase_code)}。`
            : '个股走势阶段未确认时只降优先级，不作为硬阻断。',
          false
        ),
    makeGate(
      'risk_forbidden_gate',
      priorityResult.forbidden_reason ? 'failed' : 'passed',
      priorityResult.forbidden_reason || '未命中追高、破位、假突破、急涨/反抽/阴跌/暴跌等禁止项。',
      Boolean(priorityResult.forbidden_reason)
    ),
    assetType === 'etf'
      ? makeGate(
          'etf_group_gate',
          etfPreGateReason ? 'failed' : 'passed',
          etfPreGateReason || etfPreGate?.note || 'ETF策略路由通过。',
          Boolean(etfPreGateReason)
        )
      : makeGate('etf_group_gate', 'not_applicable', '个股不走 ETF 策略路由。'),
    assetType === 'etf'
      ? makeGate(
          'risk_downgrade_gate',
          'passed',
          priorityResult.downgrade_reason ? `ETF存在降级项：${priorityResult.downgrade_reason}；仅降权和提示复核，不作为入池硬阻断。` : 'ETF未命中降级项。',
          false
        )
      : makeGate(
          'risk_downgrade_gate',
          priorityResult.downgrade_reason ? 'passed' : 'passed',
          priorityResult.downgrade_reason ? `存在降级项：${priorityResult.downgrade_reason}；个股只降优先级，不直接阻断入池。` : '未命中降级项。',
          false
        ),
    assetType === 'etf'
      ? makeGate(
          'priority_gate',
          priorityResult.priority_score >= structureProfile.candidatePriorityPassScore ? 'passed' : 'failed',
          `ETF优先分 ${priorityResult.priority_score}，${structureProfile.label}入池阈值 ${structureProfile.candidatePriorityPassScore}。`,
          priorityResult.priority_score < structureProfile.candidatePriorityPassScore
        )
      : makeGate('priority_gate', 'not_applicable', `个股无固定优先分入池阈值，当前优先分 ${priorityResult.priority_score} 只用于排序。`),
    makeGate('model_reference', 'not_applicable', '模型概率不决定入池，只用于入池后的分层、复盘和风控参考。')
  ], selected, fullCandidateReason);

  return {
    selected,
    symbol,
    asset_type: assetType,
    source,
    structure,
    trend_phase: trendPhase || null,
    market_regime: marketRegime || null,
    priority: priorityResult.priority,
    priority_score: priorityResult.priority_score,
    forbidden_reason: stockTradeQualification?.forbidden_reason || priorityResult.forbidden_reason || etfPreGateReason || etfGateReason,
    downgrade_reason: etfGateReason ? priorityResult.downgrade_reason : priorityResult.downgrade_reason,
    risk_note: joinReasonParts(priorityResult.risk_note, stockTradeNote) || priorityResult.risk_note,
    industry_strength: etfPreGate?.strength || null,
    etf_strategy_route: etfRoute,
    plan_profile: planProfile.key,
    plan_profile_label: planProfile.label,
    stock_trade_qualification: stockTradeQualification,
    opportunity_type: opportunityType,
    candidate_reason: fullCandidateReason,
    gate_trace: gateTrace.gate_trace,
    first_blocking_gate_key: gateTrace.first_blocking_gate_key,
    first_blocking_gate_label: gateTrace.first_blocking_gate_label,
    blocking_gate_labels: gateTrace.blocking_gate_labels
  };
}

async function upsertCandidate(db: any, evaluation: any, name = '') {
  const now = new Date().toISOString();
  const structure = evaluation.structure;
  const trendPhase = evaluation.trend_phase;
  const marketRegime = evaluation.market_regime;

  await db.run(
    `INSERT INTO financial_candidate_pool (
      symbol, name, asset_type, source, trade_date, close, ma20, ma60, ma120,
      distance_to_ma60, above_ma60_days, structure_status, structure_reason,
      safe_zone_status, safe_zone_reason, trend_phase_code, trend_phase_reason,
      market_regime, entry_permission, plan_profile, plan_profile_label,
      final_status, pool_status, priority, priority_score,
      invalidation_line, candidate_reason, forbidden_reason, downgrade_reason, risk_note,
      gate_trace_json, first_blocking_gate_key, first_blocking_gate_label, blocking_gate_labels,
      rule_version,
      first_selected_at, last_checked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, asset_type, source, rule_version) DO UPDATE SET
      name = COALESCE(NULLIF(excluded.name, ''), financial_candidate_pool.name),
      trade_date = excluded.trade_date,
      close = excluded.close,
      ma20 = excluded.ma20,
      ma60 = excluded.ma60,
      ma120 = excluded.ma120,
      distance_to_ma60 = excluded.distance_to_ma60,
      above_ma60_days = excluded.above_ma60_days,
      structure_status = excluded.structure_status,
      structure_reason = excluded.structure_reason,
      safe_zone_status = excluded.safe_zone_status,
      safe_zone_reason = excluded.safe_zone_reason,
      trend_phase_code = excluded.trend_phase_code,
      trend_phase_reason = excluded.trend_phase_reason,
      market_regime = excluded.market_regime,
      entry_permission = excluded.entry_permission,
      plan_profile = excluded.plan_profile,
      plan_profile_label = excluded.plan_profile_label,
      final_status = excluded.final_status,
      pool_status = 'active',
      priority = excluded.priority,
      priority_score = excluded.priority_score,
      invalidation_line = excluded.invalidation_line,
      candidate_reason = excluded.candidate_reason,
      forbidden_reason = excluded.forbidden_reason,
      downgrade_reason = excluded.downgrade_reason,
      risk_note = excluded.risk_note,
      gate_trace_json = excluded.gate_trace_json,
      first_blocking_gate_key = excluded.first_blocking_gate_key,
      first_blocking_gate_label = excluded.first_blocking_gate_label,
      blocking_gate_labels = excluded.blocking_gate_labels,
      last_checked_at = excluded.last_checked_at,
      updated_at = excluded.updated_at`,
    [
      evaluation.symbol,
      name,
      evaluation.asset_type,
      evaluation.source,
      structure.trade_date,
      structure.close,
      structure.ma20,
      structure.ma60,
      structure.ma120,
      structure.distance_to_ma60,
      structure.above_ma60_days,
      structure.structure_status,
      structure.structure_reason,
      structure.safe_zone_status,
      structure.safe_zone_reason,
      trendPhase?.trend_phase_code || null,
      trendPhase?.trend_phase_reason || null,
      marketRegime?.market_regime || 'UNKNOWN',
      marketRegime?.entry_permission || 'OBSERVE_ONLY',
      evaluation.plan_profile || null,
      evaluation.plan_profile_label || null,
      'READY_FOR_PLAN',
      'active',
      evaluation.priority,
      evaluation.priority_score,
      structure.invalidation_line,
      evaluation.candidate_reason,
      evaluation.forbidden_reason,
      evaluation.downgrade_reason,
      evaluation.risk_note || '',
      evaluation.gate_trace ? JSON.stringify(evaluation.gate_trace) : null,
      evaluation.first_blocking_gate_key || null,
      evaluation.first_blocking_gate_label || null,
      evaluation.blocking_gate_labels || null,
      CANDIDATE_RULE_VERSION,
      now,
      now,
      now,
      now
    ]
  );
}

async function recordRejectedCandidateEvaluation(db: any, evaluation: any) {
  const now = new Date().toISOString();
  const structure = evaluation.structure || {};
  const trendPhase = evaluation.trend_phase;
  const marketRegime = evaluation.market_regime;
  const reason = evaluation.candidate_reason || evaluation.reason || '本次复核未满足入池条件';

  await db.run(
    `UPDATE financial_candidate_pool
     SET trade_date = ?,
         close = ?,
         ma20 = ?,
         ma60 = ?,
         ma120 = ?,
         distance_to_ma60 = ?,
         above_ma60_days = ?,
         structure_status = ?,
         structure_reason = ?,
         safe_zone_status = ?,
         safe_zone_reason = ?,
         trend_phase_code = ?,
         trend_phase_reason = ?,
         market_regime = ?,
         entry_permission = ?,
         plan_profile = ?,
         plan_profile_label = ?,
         final_status = 'REJECTED',
         pool_status = 'expired',
         priority = ?,
         priority_score = ?,
         invalidation_line = ?,
         candidate_reason = ?,
         forbidden_reason = ?,
         downgrade_reason = ?,
         risk_note = ?,
         review_status = 'rejected',
         gate_trace_json = ?,
         first_blocking_gate_key = ?,
         first_blocking_gate_label = ?,
         blocking_gate_labels = ?,
         last_checked_at = ?,
         last_review_at = ?,
         review_action = 'excluded_recheck',
         updated_at = ?
     WHERE symbol = ?
       AND asset_type = ?
       AND source = ?
       AND rule_version = ?`,
    [
      structure.trade_date || null,
      structure.close ?? null,
      structure.ma20 ?? null,
      structure.ma60 ?? null,
      structure.ma120 ?? null,
      structure.distance_to_ma60 ?? null,
      structure.above_ma60_days ?? null,
      structure.structure_status || 'UNKNOWN',
      structure.structure_reason || null,
      structure.safe_zone_status || 'UNKNOWN',
      structure.safe_zone_reason || null,
      trendPhase?.trend_phase_code || null,
      trendPhase?.trend_phase_reason || null,
      marketRegime?.market_regime || 'UNKNOWN',
      marketRegime?.entry_permission || 'OBSERVE_ONLY',
      evaluation.plan_profile || null,
      evaluation.plan_profile_label || null,
      evaluation.priority || 'medium',
      evaluation.priority_score || 0,
      structure.invalidation_line ?? null,
      reason,
      evaluation.forbidden_reason || evaluation.reason || reason,
      evaluation.downgrade_reason || null,
      evaluation.risk_note || '',
      evaluation.gate_trace ? JSON.stringify(evaluation.gate_trace) : null,
      evaluation.first_blocking_gate_key || null,
      evaluation.first_blocking_gate_label || null,
      evaluation.blocking_gate_labels || null,
      now,
      now,
      now,
      evaluation.symbol,
      evaluation.asset_type,
      evaluation.source,
      CANDIDATE_RULE_VERSION
    ]
  );
}

router.get('/candidate-pool', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureCandidateReviewSchema(db);
    const status = (req.query.status as string) || 'active';
    const assetType = req.query.asset_type as string | undefined;
    const reviewStatus = req.query.review_status as string | undefined;
    const reviewQueue = req.query.review_queue as string | undefined;
    const excludeEntryObservation = req.query.exclude_entry_observation === '1' || req.query.exclude_entry_observation === 'true';
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const queryLimit = reviewQueue === 'model_recheck'
      ? Math.min(Math.max(limit * 10, 200), 500)
      : limit;
    const includeModel = req.query.include_model === '1' || req.query.include_model === 'true' || reviewQueue === 'model_recheck';

    const params: any[] = [CANDIDATE_RULE_VERSION];
    let where = 'WHERE rule_version = ?';

    if (status !== 'all') {
      where += ' AND pool_status = ?';
      params.push(status);
    }

    if (assetType) {
      where += ' AND asset_type = ?';
      params.push(assetType);
    } else {
      where += ` AND asset_type IN ('stock', 'etf')`;
    }

    if (reviewStatus) {
      where += ' AND COALESCE(review_status, ?) = ?';
      params.push('unreviewed', reviewStatus);
    }

    if (reviewQueue === 'model_recheck') {
      where += ` AND NOT (
        COALESCE(first_blocking_gate_key, '') IN ('asset_applicability', 'special_treatment')
        OR COALESCE(first_blocking_gate_label, '') = 'ST/退市过滤'
        OR COALESCE(name, '') LIKE 'ST%'
        OR COALESCE(name, '') LIKE '*ST%'
        OR COALESCE(name, '') LIKE '%退%'
      )`;
    }

    if (excludeEntryObservation) {
      where += ` AND NOT EXISTS (
        SELECT 1
        FROM financial_entry_trigger_observations o
        WHERE o.symbol = financial_candidate_pool.symbol
          AND o.asset_type = financial_candidate_pool.asset_type
          AND o.source = financial_candidate_pool.source
          AND o.observation_status IN ('watching', 'plan_candidate', 'confirmed')
      )`;
    }

    params.push(queryLimit);

    let items = await db.all(
      `SELECT financial_candidate_pool.*,
              (
                SELECT GROUP_CONCAT(DISTINCT u.universe_type)
                FROM financial_asset_universe u
                WHERE u.symbol = financial_candidate_pool.symbol
                  AND u.asset_type = financial_candidate_pool.asset_type
                  AND u.source = financial_candidate_pool.source
              ) AS universe_type,
              (
                SELECT MAX(p.trade_date)
                FROM financial_daily_prices p
                WHERE p.symbol = financial_candidate_pool.symbol
                  AND p.asset_type = financial_candidate_pool.asset_type
                  AND p.source = financial_candidate_pool.source
              ) AS local_last_trade_date,
              (
                SELECT MAX(p.updated_at)
                FROM financial_daily_prices p
                WHERE p.symbol = financial_candidate_pool.symbol
                  AND p.asset_type = financial_candidate_pool.asset_type
                  AND p.source = financial_candidate_pool.source
              ) AS local_price_updated_at,
              (
                SELECT MAX(u.last_fetch_at)
                FROM financial_asset_universe u
                WHERE u.symbol = financial_candidate_pool.symbol
                  AND u.asset_type = financial_candidate_pool.asset_type
                  AND u.source = financial_candidate_pool.source
              ) AS local_last_fetch_at,
              (
                SELECT GROUP_CONCAT(DISTINCT u.last_fetch_message)
                FROM financial_asset_universe u
                WHERE u.symbol = financial_candidate_pool.symbol
                  AND u.asset_type = financial_candidate_pool.asset_type
                  AND u.source = financial_candidate_pool.source
                  AND u.last_fetch_message IS NOT NULL
              ) AS local_last_fetch_message,
              (
                SELECT MAX(m.trade_date)
                FROM financial_daily_prices m
                WHERE m.symbol = '000300'
                  AND m.asset_type = 'index'
                  AND m.source = financial_candidate_pool.source
              ) AS market_latest_trade_date
       FROM financial_candidate_pool
       ${where}
       ORDER BY priority_score DESC, last_checked_at DESC, trade_date DESC
       LIMIT ?`,
      params
    );

    if (includeModel && ['active', 'expired', 'all'].includes(status)) {
      try {
        const scoreMap = await runCandidateScoreWorker(queryLimit, status === 'all' ? 'all' : status as 'active' | 'expired');
        items = items.map((item: any) => {
          const score = scoreMap[`${item.symbol}|${item.asset_type}|${item.source}`];
          return {
            ...item,
            ml_available: score?.available === true ? 1 : 0,
            ml_probability: score?.probability ?? null,
            ml_model_key: score?.modelKey ?? null,
            ml_target: score?.target ?? null,
            ml_score_trade_date: score?.tradeDate ?? null,
            ml_score_reason: score?.reason ?? null,
          };
        });
      } catch (error) {
        items = items.map((item: any) => ({
          ...item,
          ml_available: 0,
          ml_probability: null,
          ml_score_reason: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    if (reviewQueue === 'model_recheck') {
      items = items.filter(isVisibleModelRecheckItem).slice(0, limit);
    }

    items = items.map(hydrateCandidateItem);

    res.json({ success: true, data: { items } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `获取备选池失败: ${(error as Error).message}`
    });
  }
});

router.post('/candidate-pool/evaluate-one', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureCandidateReviewSchema(db);
    const symbol = String(req.body.symbol || '').trim();
    const assetType = req.body.asset_type;
    const source = req.body.source || 'tushare';

    if (!symbol || !CANDIDATE_POOL_ASSET_TYPES.includes(assetType)) {
      return res.status(400).json({
        success: false,
        message: 'symbol and valid asset_type are required; candidate pool only supports stock or etf'
      });
    }

    const previousCandidate = await db.get(
      `SELECT id, pool_status, review_status
       FROM financial_candidate_pool
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND rule_version = ?
       LIMIT 1`,
      [symbol, assetType, source, CANDIDATE_RULE_VERSION]
    );

    const industryStrengthContext = assetType === 'etf'
      ? await buildIndustryEtfStrengthContext(db, { scope: 'focus', benchmarkSymbol: '000300' })
      : undefined;
    const evaluation = await evaluateCandidate(db, symbol, assetType, source, industryStrengthContext);
    const hardBlockedFromModelRecheck = isHardBlockedFromModelRecheck(evaluation);

    if (evaluation.selected) {
      await upsertCandidate(db, evaluation);
      if (previousCandidate?.pool_status === 'expired') {
        const now = new Date().toISOString();
        await db.run(
          `UPDATE financial_candidate_pool
           SET review_status = 'unreviewed',
               last_review_id = NULL,
               last_review_at = ?,
               review_action = 'reentered_from_excluded_recheck',
               updated_at = ?
           WHERE symbol = ?
             AND asset_type = ?
             AND source = ?
             AND rule_version = ?`,
          [now, now, symbol, assetType, source, CANDIDATE_RULE_VERSION]
        );
      }
    } else {
      await recordRejectedCandidateEvaluation(db, evaluation);
    }

    res.json({
      success: true,
      data: {
        ...evaluation,
        previous_pool_status: previousCandidate?.pool_status || null,
        next_location: evaluation.selected
          ? {
              key: 'candidate_pool',
              label: `${assetType === 'etf' ? 'ETF备选池' : '个股备选池'} / 待生成复盘`,
              status: 'active',
              review_status: 'unreviewed'
            }
          : {
              key: hardBlockedFromModelRecheck ? 'hard_blocked' : 'excluded_review',
              label: hardBlockedFromModelRecheck ? '硬闸门拦截 / 不进入模型复核' : '被剔除标的模型复核 / 已淘汰样本',
              status: 'expired',
              review_status: 'rejected'
            }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `评估入池失败: ${(error as Error).message}`
    });
  }
});

router.get('/candidate-pool/structure-queue', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureCandidateReviewSchema(db);
    const source = String(req.query.source || 'tushare');
    const assetType = String(req.query.asset_type || '').trim();
    const limit = Math.max(Math.min(parseInt(req.query.limit as string) || 80, 300), 1);
    const readySql = Array.from(STRUCTURE_READY_TREND_PHASES).map(() => '?').join(',');

    const params: any[] = [TREND_PHASE_VERSION, source, ...Array.from(STRUCTURE_READY_TREND_PHASES)];
    const whereParts = [
      `c.pool_status = 'active'`,
      `c.asset_type IN ('stock', 'etf')`,
      `c.source = ?`,
      `COALESCE(c.review_status, 'unreviewed') NOT IN ('trend_blocked', 'structure_ready', 'wait_confirmation', 'plan_ready', 'rejected')`,
      `(
        COALESCE(c.review_status, 'unreviewed') IN ('structure_pending', 'structure_watch', 'model_conflict')
        OR t.trend_phase_code IN (${readySql})
      )`
    ];

    if (assetType === 'stock' || assetType === 'etf') {
      whereParts.push(`c.asset_type = ?`);
      params.push(assetType);
    }

    const latestTrendJoin = `
      LEFT JOIN financial_trend_phase_results t ON t.id = (
        SELECT t2.id
        FROM financial_trend_phase_results t2
        WHERE t2.symbol = c.symbol
          AND t2.asset_type = c.asset_type
          AND t2.source = c.source
          AND t2.rule_version = ?
        ORDER BY t2.trade_date DESC, t2.id DESC
        LIMIT 1
      )
    `;
    const whereSql = whereParts.join('\n      AND ');

    const countParams = [...params];
    const countRows = await db.all(
      `SELECT
         COALESCE(c.review_status, 'structure_pending') AS review_status,
         COUNT(*) AS count
       FROM financial_candidate_pool c
       ${latestTrendJoin}
       WHERE ${whereSql}
       GROUP BY COALESCE(c.review_status, 'structure_pending')`,
      countParams
    );

    const rows = await db.all(
      `SELECT c.*,
              t.trend_phase_code AS latest_trend_phase_code,
              t.trend_phase_reason AS latest_trend_phase_reason,
              (
                SELECT GROUP_CONCAT(DISTINCT u.universe_type)
                FROM financial_asset_universe u
                WHERE u.symbol = c.symbol
                  AND u.asset_type = c.asset_type
                  AND u.source = c.source
              ) AS universe_type
       FROM financial_candidate_pool c
       ${latestTrendJoin}
       WHERE ${whereSql}
       ORDER BY
         CASE COALESCE(c.review_status, 'structure_pending')
           WHEN 'structure_pending' THEN 0
           WHEN 'model_conflict' THEN 1
           WHEN 'structure_watch' THEN 2
           ELSE 3
         END,
         c.priority_score DESC,
         COALESCE(c.updated_at, c.last_checked_at) DESC,
         c.id DESC
       LIMIT ?`,
      [...params, limit]
    );

    const items = rows.map((row: any) => {
      const hydrated = hydrateCandidateItem({
        ...row,
        trend_phase_code: row.trend_phase_code || row.latest_trend_phase_code,
        trend_phase_reason: row.trend_phase_reason || row.latest_trend_phase_reason,
        review_status: STRUCTURE_QUEUE_STATUSES.has(row.review_status)
          ? row.review_status
          : 'structure_pending'
      });
      const statusMeta = getStructureQueueStatusMeta(hydrated);
      return {
        ...hydrated,
        queue_status: statusMeta.key,
        queue_status_label: statusMeta.label,
        queue_status_tone: statusMeta.tone,
        queue_reason: statusMeta.reason
      };
    });

    const countMap = countRows.reduce((summary: Record<string, number>, row: any) => {
      const status = STRUCTURE_QUEUE_STATUSES.has(row.review_status) ? row.review_status : 'structure_pending';
      summary[status] = (summary[status] || 0) + Number(row.count || 0);
      return summary;
    }, {});

    res.json({
      success: true,
      data: {
        items,
        summary: {
          total: Object.values(countMap).reduce((sum, count) => sum + Number(count || 0), 0),
          pending: countMap.structure_pending || 0,
          watch: countMap.structure_watch || 0,
          ready: 0,
          model_conflict: countMap.model_conflict || 0
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `获取单标的判断队列失败: ${(error as Error).message}`
    });
  }
});

router.post('/candidate-pool/structure-queue/:id/recheck', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureCandidateReviewSchema(db);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '无效的队列ID' });
    }

    const candidate = await db.get(
      `SELECT id, symbol, name, asset_type, source, pool_status
       FROM financial_candidate_pool
       WHERE id = ?
         AND rule_version = ?
       LIMIT 1`,
      [id, CANDIDATE_RULE_VERSION]
    );
    if (!candidate) {
      return res.status(404).json({ success: false, message: '单标的判断队列记录不存在' });
    }
    if (!CANDIDATE_POOL_ASSET_TYPES.includes(candidate.asset_type)) {
      return res.status(400).json({ success: false, message: '该资产类型不进入单标的判断队列' });
    }

    const industryStrengthContext = candidate.asset_type === 'etf'
      ? await buildIndustryEtfStrengthContext(db, { scope: 'focus', benchmarkSymbol: '000300' })
      : undefined;
    const evaluation = await evaluateCandidate(db, candidate.symbol, candidate.asset_type, candidate.source, industryStrengthContext);
    const decision = await applyStructureQueueDecision(db, id, evaluation, candidate.name || '');
    const item = await fetchStructureQueueItem(db, id);

    const messageLabel = decision.review_status === 'wait_confirmation'
      ? '已推进入场触发'
      : getReviewStatusLabel(decision.review_status);

    res.json({
      success: true,
      message: `单标的判断完成：${messageLabel}`,
      data: {
        selected: Boolean(evaluation.selected),
        decision,
        evaluation,
        item
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `单标的判断队列重算失败: ${(error as Error).message}`
    });
  }
});

router.post('/candidate-pool/scan-universe', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureCandidateReviewSchema(db);
    const universeType = req.body.universe_type || 'all';
    const assetType = req.body.asset_type as string | undefined;
    const source = req.body.source || 'tushare';
    const requestedLimit = req.body.limit === undefined || req.body.limit === null || req.body.limit === ''
      ? null
      : Number(req.body.limit);
    const limit = requestedLimit && Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 10000)
      : null;

    if (assetType && !CANDIDATE_POOL_ASSET_TYPES.includes(assetType)) {
      return res.status(400).json({
        success: false,
        message: 'invalid asset_type; candidate pool only supports stock or etf'
      });
    }

    const params: any[] = [source];
    let where = `WHERE enabled = 1 AND local_data_ready = 1 AND source = ?`;

    if (assetType) {
      where += ' AND asset_type = ?';
      params.push(assetType);
    } else {
      where += ` AND asset_type IN ('stock', 'etf')`;
    }

    if (universeType !== 'all') {
      where += ' AND universe_type = ?';
      params.push(universeType);
    }

    const rawCountResult = await db.get(
      `SELECT COUNT(*) as total
       FROM financial_asset_universe
       ${where}`,
      params
    );

    const dedupedCountResult = await db.get(
      `SELECT COUNT(*) as total
       FROM (
         SELECT symbol, asset_type, source
         FROM financial_asset_universe
         ${where}
         GROUP BY symbol, asset_type, source
       )`,
      params
    );

    const assetQueryParams = [...params];
    const limitClause = limit ? 'LIMIT ?' : '';
    if (limit) {
      assetQueryParams.push(limit);
    }

    const assets = await db.all(
      `WITH matched AS (
         SELECT symbol, asset_type, source
         FROM financial_asset_universe
         ${where}
         GROUP BY symbol, asset_type, source
       ),
       grouped AS (
         SELECT
           u.symbol,
           MAX(u.name) as name,
           u.asset_type,
           u.source,
           GROUP_CONCAT(DISTINCT u.universe_type) as universe_type
         FROM financial_asset_universe u
         INNER JOIN matched m
           ON m.symbol = u.symbol
          AND m.asset_type = u.asset_type
          AND m.source = u.source
         WHERE u.enabled = 1
           AND u.local_data_ready = 1
         GROUP BY u.symbol, u.asset_type, u.source
       )
       SELECT *
       FROM grouped
       ORDER BY
         CASE
           WHEN asset_type = 'etf' AND universe_type LIKE '%broad_etf%' THEN 0
           WHEN asset_type = 'etf' AND universe_type LIKE '%industry_etf%' THEN 1
           WHEN asset_type = 'etf' AND universe_type LIKE '%full_etf%' THEN 2
           WHEN asset_type = 'stock' AND universe_type LIKE '%stock_whitelist%' THEN 0
           WHEN asset_type = 'stock' AND universe_type LIKE '%hs300_component%' THEN 1
           ELSE 9
         END,
         universe_type,
         asset_type,
         symbol
       ${limitClause}`,
      assetQueryParams
    );

    const industryStrengthContext = (!assetType || assetType === 'etf')
      ? await buildIndustryEtfStrengthContext(db, { scope: 'focus', benchmarkSymbol: '000300' })
      : undefined;
    const results = [];
    const evaluations: any[] = [];
    let selectedCount = 0;

    for (const asset of assets) {
      const evaluation: any = await evaluateCandidate(db, asset.symbol, asset.asset_type, asset.source, industryStrengthContext);
      evaluations.push(evaluation);

      if (evaluation.selected) {
        await upsertCandidate(db, evaluation, asset.name || '');
        selectedCount++;
      } else {
        const now = new Date().toISOString();
        await db.run(
          `UPDATE financial_candidate_pool
           SET pool_status = 'expired',
               last_checked_at = ?,
               updated_at = ?,
               candidate_reason = ?,
               priority_score = ?,
               forbidden_reason = ?,
               downgrade_reason = ?,
               risk_note = ?,
               gate_trace_json = ?,
               first_blocking_gate_key = ?,
               first_blocking_gate_label = ?,
               blocking_gate_labels = ?
           WHERE symbol = ? AND asset_type = ? AND source = ? AND rule_version = ? AND pool_status = 'active'`,
          [
            now,
            now,
            evaluation.candidate_reason || evaluation.reason || '本次扫描未满足入池条件',
            evaluation.priority_score || 0,
            evaluation.forbidden_reason || evaluation.reason || '本次扫描未满足入池条件',
            evaluation.downgrade_reason || null,
            evaluation.risk_note || '',
            evaluation.gate_trace ? JSON.stringify(evaluation.gate_trace) : null,
            evaluation.first_blocking_gate_key || null,
            evaluation.first_blocking_gate_label || null,
            evaluation.blocking_gate_labels || null,
            asset.symbol,
            asset.asset_type,
            asset.source,
            CANDIDATE_RULE_VERSION
          ]
        );
      }

      results.push({
        symbol: asset.symbol,
        name: asset.name,
        asset_type: asset.asset_type,
        universe_type: asset.universe_type,
        selected: evaluation.selected,
        industry_strength: evaluation.industry_strength || null,
        reason: evaluation.candidate_reason || evaluation.reason,
        gate_trace: evaluation.gate_trace || null,
        first_blocking_gate: evaluation.gate_trace?.first_blocking_gate || null,
        blocking_gates: evaluation.gate_trace?.blocking_gates || [],
        first_blocking_gate_label: evaluation.first_blocking_gate_label || null,
        blocking_gate_labels: evaluation.blocking_gate_labels || null
      });
    }

    const rawCount = rawCountResult?.total || assets.length;
    const dedupedTotal = dedupedCountResult?.total || assets.length;
    const duplicateCount = Math.max(0, rawCount - dedupedTotal);
    const uncheckedCount = Math.max(0, dedupedTotal - assets.length);

    const scanScopeText = limit ? `限制检查 ${limit} 个` : '全量检查';
    const responseResults = results.length <= 500
      ? results
      : [
          ...results.filter(item => item.selected),
          ...results.filter(item => !item.selected).slice(0, 200)
        ];

    const selectedMessage = assetType === 'etf'
      ? `${selectedCount} 个进入权益主升ETF池`
      : `${selectedCount} 个进入备选池`;

    res.json({
      success: true,
      message: `扫描完成：${scanScopeText}，实际检查 ${assets.length} 个${assetType ? ` ${assetType}` : ''}唯一资产，${selectedMessage}（匹配分组 ${rawCount} 条，去重后 ${dedupedTotal} 个，重复 ${duplicateCount} 条，未检查 ${uncheckedCount} 个）`,
      data: {
        checked_count: assets.length,
        raw_count: rawCount,
        deduped_count: dedupedTotal,
        deduped_total: dedupedTotal,
        duplicate_count: duplicateCount,
        unchecked_count: uncheckedCount,
        selected_count: selectedCount,
        result_count: results.length,
        returned_result_count: responseResults.length,
        gate_summary: buildGateSummary(evaluations),
        results: responseResults
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `扫描资产库失败: ${(error as Error).message}`
    });
  }
});

router.get('/candidate-pool/:id/review-draft', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureCandidateReviewSchema(db);
    const id = req.params.id;

    const item = await db.get(
      `SELECT *
       FROM financial_candidate_pool
       WHERE id = ? AND rule_version = ?`,
      [id, CANDIDATE_RULE_VERSION]
    );

    if (!item) {
      return res.status(404).json({ success: false, message: '备选池标的不存在' });
    }

    let enrichedItem = {
      ...item,
      ml_available: 0,
      ml_probability: null,
      ml_model_key: null,
      ml_target: null,
      ml_score_trade_date: null,
      ml_score_reason: null,
    };

    try {
      const scoreMap = await runCandidateScoreWorker(500);
      const score = scoreMap[`${item.symbol}|${item.asset_type}|${item.source}`];
      enrichedItem = {
        ...enrichedItem,
        ml_available: score?.available === true ? 1 : 0,
        ml_probability: score?.probability ?? null,
        ml_model_key: score?.modelKey ?? null,
        ml_target: score?.target ?? null,
        ml_score_trade_date: score?.tradeDate ?? null,
        ml_score_reason: score?.reason ?? null,
      };
    } catch (error) {
      enrichedItem.ml_score_reason = error instanceof Error ? error.message : String(error);
    }

    const draft = buildCandidateReviewDraft(enrichedItem);
    const now = new Date().toISOString();
    const insertResult = await db.run(
      `INSERT INTO financial_candidate_reviews (
        candidate_id, symbol, name, asset_type, source, trade_date, rule_version,
        model_key, model_target, model_probability, lane_key, lane_label,
        suggested_action_key, suggested_action_label, review_status, draft_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        enrichedItem.id,
        enrichedItem.symbol,
        enrichedItem.name || null,
        enrichedItem.asset_type,
        enrichedItem.source,
        enrichedItem.trade_date,
        CANDIDATE_RULE_VERSION,
        enrichedItem.ml_model_key || null,
        enrichedItem.ml_target || null,
        enrichedItem.ml_probability ?? null,
        draft.lane.key,
        draft.lane.label,
        draft.suggested_action.key,
        draft.suggested_action.label,
        'draft',
        JSON.stringify(draft),
        now,
        now
      ]
    );

    const reviewId = insertResult.lastID;
    await db.run(
      `UPDATE financial_candidate_pool
       SET review_status = 'drafted',
           last_review_id = ?,
           last_review_at = ?,
           review_action = ?,
           updated_at = ?
       WHERE id = ?`,
      [reviewId, now, draft.suggested_action.key, now, id]
    );

    draft.review_id = reviewId || null;
    draft.review_status = { key: 'drafted', label: getReviewStatusLabel('drafted') };
    draft.candidate = {
      ...draft.candidate,
      review_status: 'drafted',
      last_review_id: reviewId || null,
      last_review_at: now,
      review_action: draft.suggested_action.key
    };

    res.json({
      success: true,
      data: draft
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `生成复盘草稿失败: ${(error as Error).message}`
    });
  }
});

router.patch('/candidate-pool/:id/review-status', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureCandidateReviewSchema(db);
    const id = req.params.id;
    const status = req.body.status;
    const validStatuses = [
      'unreviewed',
      'drafted',
      'trend_blocked',
      'structure_pending',
      'structure_watch',
      'structure_ready',
      'model_conflict',
      'wait_confirmation',
      'plan_ready',
      'rejected'
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: '无效的复盘状态' });
    }

    const now = new Date().toISOString();
    await db.run(
      `UPDATE financial_candidate_pool
       SET review_status = ?, updated_at = ?
       WHERE id = ?`,
      [status, now, id]
    );

    const item = await db.get(`SELECT last_review_id FROM financial_candidate_pool WHERE id = ?`, [id]);
    if (item?.last_review_id) {
      await db.run(
        `UPDATE financial_candidate_reviews
         SET review_status = ?, updated_at = ?
         WHERE id = ?`,
        [status === 'drafted' ? 'draft' : status, now, item.last_review_id]
      );
    }

    res.json({
      success: true,
      data: {
        status,
        label: getReviewStatusLabel(status)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `更新复盘状态失败: ${(error as Error).message}`
    });
  }
});

router.patch('/candidate-pool/:id/status', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureCandidateReviewSchema(db);
    const id = req.params.id;
    const status = req.body.status;

    if (!['active', 'ignored', 'planned', 'expired'].includes(status)) {
      return res.status(400).json({ success: false, message: '无效的备选池状态' });
    }

    await db.run(
      `UPDATE financial_candidate_pool
       SET pool_status = ?, updated_at = ?
       WHERE id = ?`,
      [status, new Date().toISOString(), id]
    );

    res.json({ success: true, message: '备选池状态已更新' });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `更新备选池状态失败: ${(error as Error).message}`
    });
  }
});

export default router;
