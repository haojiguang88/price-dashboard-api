import express, { Request, Response } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import getDb, { getDatabasePath } from '../config/database';
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
  isIndustryThemeEtfLike,
  resolveFinancePlanProfile
} from '../services/financePlanProfile';
import {
  adjustPriorityWithStockIndustry,
  buildStockIndustryStrengthContext,
  calculateCandidatePriority,
  calculateRecentRiskProfile,
  calculateStockTradeQualification,
  classifyOpportunityType,
  evaluateStockIndustryStrength,
  type CandidatePriorityResult,
  type OpportunityTypeTag,
  type RecentRiskProfile,
  type StockIndustryStrengthContext,
  type StockIndustryStrengthItem,
  type StockTradeQualification
} from '../services/financeStockRules';
import { getLatestCoveredTradeDate } from '../utils/financeTradeDate';
import { getFreshMarketRegime } from '../utils/financeMarketRegime';

const router = express.Router();

const CANDIDATE_RULE_VERSION = 'candidate_pool_v1';
const TREND_PHASE_VERSION = 'trend_phase_v1.1';
const CANDIDATE_POOL_ASSET_TYPES = ['stock', 'etf'];
const ETF_HARD_BLOCK_TREND_PHASES = new Set(['SURGE', 'REBOUND', 'SLOW_BLEED', 'CRASH_DROP']);
const STRUCTURE_QUEUE_STATUSES = new Set(['structure_pending', 'structure_watch', 'model_conflict']);
const STRUCTURE_READY_TREND_PHASES = new Set(['BREAKOUT', 'SLOW_GRIND_UP', 'RECOVERY']);
const STRUCTURE_HOLD_TREND_PHASES = new Set(['TREND_UP', 'HIGH_BASE', 'SIDEWAYS', 'CONSOLIDATION', 'TREND_TRANSITION', 'UNKNOWN']);
const MODEL_RECHECK_QUERY_LIMIT = 1000;
const CANDIDATE_SCORE_CACHE_MS = 60 * 1000;
const CANDIDATE_MODEL_PRIORITY = ['lightgbm_model', 'random_forest', 'logistic_regression'];
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
let candidatePoolLightColumnsCache: string[] | null = null;

const candidateScoreCache = new Map<string, {
  expiresAt: number;
  data?: Record<string, any>;
  promise?: Promise<Record<string, any>>;
}>();
const candidateModelFreshnessCache = new Map<string, {
  expiresAt: number;
  data: CandidateModelFreshness;
}>();

interface CandidateModelFreshness {
  available: boolean;
  reason: string | null;
  modelKey: string | null;
  target: string | null;
  latestFeatureTradeDate: string | null;
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

type CandidateFlowTimelineStatus = 'done' | 'active' | 'waiting' | 'blocked' | 'missing';

interface CandidateFlowTimelineStep {
  key: string;
  label: string;
  status: CandidateFlowTimelineStatus;
  date?: string | null;
  summary: string;
  detail: string;
  metric?: string | null;
  actionLabel?: string | null;
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

const MODEL_RECHECK_SOFT_CONFLICT_GATES = new Set([
  'market_gate',
  'safe_zone_gate',
  'trend_phase_gate',
  'risk_downgrade_gate',
  'priority_gate',
  'etf_group_gate',
]);

const MODEL_RECHECK_BATCH_DATE_SQL = `substr(COALESCE(NULLIF(updated_at, ''), NULLIF(last_checked_at, '')), 1, 10)`;

const MODEL_RECHECK_SOFT_CONFLICT_SQL = `(
  COALESCE(review_action, '') = 'model_conflict_manual_required'
  OR (
    COALESCE(priority_score, 0) >= 80
    AND (
      COALESCE(first_blocking_gate_key, '') IN ('market_gate', 'safe_zone_gate', 'trend_phase_gate', 'risk_downgrade_gate', 'priority_gate', 'etf_group_gate')
      OR COALESCE(review_action, '') IN ('trend_phase_rejected', 'single_target_watch', 'entry_trigger_back_to_structure', 'entry_trigger_back_to_trend')
      OR (
        COALESCE(first_blocking_gate_key, '') = ''
        AND (
          COALESCE(candidate_reason, '') LIKE '%走势%'
          OR COALESCE(candidate_reason, '') LIKE '%安全区%'
          OR COALESCE(candidate_reason, '') LIKE '%降级%'
          OR COALESCE(candidate_reason, '') LIKE '%踢出本轮%'
          OR COALESCE(candidate_reason, '') LIKE '%只观察%'
          OR COALESCE(candidate_reason, '') LIKE '%等待%'
          OR COALESCE(forbidden_reason, '') LIKE '%走势%'
          OR COALESCE(forbidden_reason, '') LIKE '%安全区%'
          OR COALESCE(forbidden_reason, '') LIKE '%降级%'
          OR COALESCE(forbidden_reason, '') LIKE '%踢出本轮%'
          OR COALESCE(forbidden_reason, '') LIKE '%只观察%'
          OR COALESCE(forbidden_reason, '') LIKE '%等待%'
          OR COALESCE(downgrade_reason, '') LIKE '%走势%'
          OR COALESCE(downgrade_reason, '') LIKE '%安全区%'
          OR COALESCE(downgrade_reason, '') LIKE '%降级%'
          OR COALESCE(downgrade_reason, '') LIKE '%踢出本轮%'
          OR COALESCE(downgrade_reason, '') LIKE '%只观察%'
          OR COALESCE(downgrade_reason, '') LIKE '%等待%'
          OR COALESCE(risk_note, '') LIKE '%走势%'
          OR COALESCE(risk_note, '') LIKE '%安全区%'
          OR COALESCE(risk_note, '') LIKE '%降级%'
          OR COALESCE(risk_note, '') LIKE '%踢出本轮%'
          OR COALESCE(risk_note, '') LIKE '%只观察%'
          OR COALESCE(risk_note, '') LIKE '%等待%'
        )
      )
    )
  )
)`;
const MODEL_RECHECK_NOT_HARD_BLOCKED_SQL = `NOT (
  COALESCE(first_blocking_gate_key, '') IN ('asset_applicability', 'data_ready', 'special_treatment', 'liquidity_gate', 'market_cap_gate', 'extreme_trade_gate', 'structure_gate', 'risk_forbidden_gate')
  OR COALESCE(first_blocking_gate_label, '') = 'ST/退市过滤'
  OR COALESCE(structure_status, '') = 'STRUCTURE_BROKEN'
  OR COALESCE(NULLIF(forbidden_reason, ''), NULLIF(candidate_reason, ''), NULLIF(risk_note, ''), '') LIKE '%结构失败%'
  OR COALESCE(NULLIF(forbidden_reason, ''), NULLIF(candidate_reason, ''), NULLIF(risk_note, ''), '') LIKE '%结构破坏%'
  OR COALESCE(NULLIF(forbidden_reason, ''), NULLIF(candidate_reason, ''), NULLIF(risk_note, ''), '') LIKE '%跌破失效线%'
  OR COALESCE(NULLIF(forbidden_reason, ''), NULLIF(candidate_reason, ''), NULLIF(risk_note, ''), '') LIKE '%极端交易状态%'
)`;
const MODEL_RECHECK_DATA_GAP_SQL = `(
  (
    SELECT MAX(p.trade_date)
    FROM financial_daily_prices p
    WHERE p.symbol = financial_candidate_pool.symbol
      AND p.asset_type = financial_candidate_pool.asset_type
      AND p.source = financial_candidate_pool.source
  ) < (
    SELECT MAX(m.trade_date)
    FROM financial_daily_prices m
    WHERE m.source = financial_candidate_pool.source
      AND m.symbol = '000300'
      AND m.asset_type = 'index'
  )
  OR COALESCE(candidate_reason, '') LIKE '%最新日线停留%'
  OR COALESCE(candidate_reason, '') LIKE '%日线缺口%'
  OR COALESCE(candidate_reason, '') LIKE '%数据断档%'
  OR COALESCE(candidate_reason, '') LIKE '%没有同步到市场最新交易日%'
  OR COALESCE(forbidden_reason, '') LIKE '%最新日线停留%'
  OR COALESCE(forbidden_reason, '') LIKE '%日线缺口%'
  OR COALESCE(forbidden_reason, '') LIKE '%数据断档%'
  OR COALESCE(forbidden_reason, '') LIKE '%没有同步到市场最新交易日%'
  OR COALESCE(risk_note, '') LIKE '%最新日线停留%'
  OR COALESCE(risk_note, '') LIKE '%日线缺口%'
  OR COALESCE(risk_note, '') LIKE '%数据断档%'
  OR COALESCE(risk_note, '') LIKE '%没有同步到市场最新交易日%'
)`;

type ModelRecheckScope = 'actionable' | 'data_gap' | 'high_conflict' | 'neutral' | 'all';
type ModelRecheckBucket = 'data_gap' | 'high_conflict' | 'neutral' | 'archive' | 'hard_blocked' | 'unscored';

function getModelRecheckFirstBlockingGate(item: any) {
  const parsedGateTrace = parseJson(item?.gate_trace_json, null);
  const key = String(item?.first_blocking_gate_key || parsedGateTrace?.first_blocking_gate?.key || '').trim();
  const label = String(item?.first_blocking_gate_label || parsedGateTrace?.first_blocking_gate?.label || '').trim();
  if (key || label) {
    return { key, label };
  }
  const rebuiltGateTrace = buildStoredGateTrace(item);
  return {
    key: String(rebuiltGateTrace?.first_blocking_gate?.key || '').trim(),
    label: String(rebuiltGateTrace?.first_blocking_gate?.label || '').trim()
  };
}

function isHardBlockedFromModelRecheck(item: any) {
  const { key: firstBlockingGateKey, label: firstBlockingGateLabel } = getModelRecheckFirstBlockingGate(item);
  const structureStatus = String(item?.structure_status || '').trim();
  const forbiddenReason = String(item?.forbidden_reason || item?.candidate_reason || item?.risk_note || '').trim();
  return MODEL_RECHECK_HARD_BLOCKING_GATES.has(firstBlockingGateKey)
    || firstBlockingGateLabel === 'ST/退市过滤'
    || structureStatus === 'STRUCTURE_BROKEN'
    || /结构(失败|破坏)|跌破失效线|极端交易状态/.test(forbiddenReason)
    || isSpecialTreatmentName(item?.name);
}

function hasModelRecheckDataGap(item: any) {
  const localDate = String(item?.local_last_trade_date || '').trim();
  const marketDate = String(item?.market_latest_trade_date || '').trim();
  const reason = String(item?.candidate_reason || item?.forbidden_reason || item?.risk_note || '').trim();
  return Boolean(localDate && marketDate && localDate < marketDate)
    || /最新日线停留|日线缺口|数据断档|没有同步到市场最新交易日/.test(reason);
}

function isSoftModelConflictGate(item: any) {
  const { key: gateKey } = getModelRecheckFirstBlockingGate(item);
  const reviewAction = String(item?.review_action || '').trim();
  const reason = String(item?.candidate_reason || item?.forbidden_reason || item?.downgrade_reason || item?.risk_note || '').trim();
  return MODEL_RECHECK_SOFT_CONFLICT_GATES.has(gateKey)
    || (!gateKey && /走势|安全区|降级|踢出本轮|只观察|等待/.test(reason))
    || ['trend_phase_rejected', 'single_target_watch', 'entry_trigger_back_to_structure', 'entry_trigger_back_to_trend'].includes(reviewAction);
}

function isFinanceMarketGateOpen(marketGate: any) {
  return marketGate?.entry_permission === 'ALLOW_STRUCTURE_CHECK';
}

function getFinanceMarketGateBlockReason(marketGate: any) {
  if (marketGate?.stale) return marketGate.freshness_reason;
  return marketGate?.entry_reason
    || marketGate?.result_reason
    || marketGate?.freshness_reason
    || '市场总闸未开放单标的结构判断。';
}

async function getFinanceMarketGateBlocker(db: any, source: string) {
  const marketGate = await getFreshMarketRegime(db, { source });
  if (isFinanceMarketGateOpen(marketGate)) return null;
  return {
    marketGate,
    message: `市场总闸未通过，禁止推进备选池/单标的判断；本轮不修改候选池状态：${getFinanceMarketGateBlockReason(marketGate)}`
  };
}

function isCandidateReviewStatusFlowAdvancing(status: string) {
  return [
    'unreviewed',
    'drafted',
    'structure_pending',
    'structure_watch',
    'structure_ready',
    'model_conflict',
    'wait_confirmation',
    'plan_ready'
  ].includes(status);
}

function isCandidatePoolStatusFlowAdvancing(status: string) {
  return ['active', 'planned'].includes(status);
}

function isTrueModelRecheckConflict(item: any) {
  const reviewAction = String(item?.review_action || '').trim();
  if (reviewAction === 'auto_model_recheck_settled') return false;
  const probability = Number(item?.ml_probability);
  if (!item?.ml_available || !Number.isFinite(probability)) return false;
  if (!hasSupportedModelTarget(item)) return false;
  if (hasModelRecheckDataGap(item) || isHardBlockedFromModelRecheck(item)) return false;
  if (!isSoftModelConflictGate(item)) return false;

  const structureProfile = getFinanceStructureProfileConfig(resolveCandidateProfile(item).key);
  const strictProbability = Math.max(structureProfile.modelHighProbability + 0.08, 0.70);
  const priorityScore = Number(item?.priority_score || 0);
  return probability >= strictProbability && priorityScore >= 80;
}

function getModelRecheckBucket(item: any): ModelRecheckBucket {
  const reviewAction = String(item?.review_action || '').trim();
  if (reviewAction === 'auto_model_recheck_settled') return 'archive';
  if (isHardBlockedFromModelRecheck(item)) return 'hard_blocked';
  if (reviewAction === 'model_conflict_manual_required') return 'high_conflict';
  if (hasModelRecheckDataGap(item)) return 'data_gap';
  const probability = Number(item?.ml_probability);
  if (!item?.ml_available || !Number.isFinite(probability)) return 'unscored';
  if (isTrueModelRecheckConflict(item)) return 'high_conflict';
  const structureProfile = getFinanceStructureProfileConfig(resolveCandidateProfile(item).key);
  if (probability >= structureProfile.modelLowProbability) return 'neutral';
  return 'archive';
}

function getModelRecheckBatchDate(item: any) {
  return String(item?.updated_at || item?.last_checked_at || '').slice(0, 10);
}

function getLatestModelRecheckBatchDate(items: any[]) {
  return items.reduce((latest, item) => {
    const date = getModelRecheckBatchDate(item);
    return date && date > latest ? date : latest;
  }, '');
}

function isVisibleModelRecheckItem(item: any, scope: ModelRecheckScope = 'actionable', latestBatchDate = '') {
  const bucket = getModelRecheckBucket(item);
  const inLatestBatch = !latestBatchDate || getModelRecheckBatchDate(item) === latestBatchDate;
  if (scope === 'data_gap') return bucket === 'data_gap';
  if (scope === 'high_conflict') return bucket === 'high_conflict';
  if (scope === 'neutral') return bucket === 'neutral';
  if (scope === 'all') return ['data_gap', 'high_conflict', 'neutral'].includes(bucket);
  return inLatestBatch && bucket === 'high_conflict';
}

function buildModelRecheckSummary(items: any[], latestBatchDate = '') {
  const summary = {
    actionable: 0,
    current_batch: 0,
    data_gap: 0,
    high_conflict: 0,
    neutral: 0,
    all: 0,
    archive: 0,
    hard_blocked: 0,
    unscored: 0
  };
  items.forEach((item) => {
    const bucket = getModelRecheckBucket(item);
    summary[bucket] += 1;
    if (getModelRecheckBatchDate(item) === latestBatchDate) {
      summary.current_batch += 1;
      if (bucket === 'high_conflict') summary.actionable += 1;
    }
    if (bucket === 'data_gap' || bucket === 'high_conflict' || bucket === 'neutral') summary.all += 1;
  });
  return summary;
}

function parseJson(value: unknown, fallback: any = null) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function quoteSqlIdentifier(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function getCandidatePoolLightSelectColumns(db: any, alias = 'financial_candidate_pool') {
  if (!candidatePoolLightColumnsCache) {
    const columns = await db.all(`PRAGMA table_info(financial_candidate_pool)`);
    candidatePoolLightColumnsCache = columns
      .map((column: any) => String(column.name || '').trim())
      .filter((name: string) => name && name !== 'gate_trace_json');
  }

  const prefix = alias ? `${alias}.` : '';
  const columnNames = candidatePoolLightColumnsCache || [];
  return columnNames
    .map((name) => `${prefix}${quoteSqlIdentifier(name)}`)
    .join(', ');
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

function hydrateCandidateItem(item: any, options: { includeGateTrace?: boolean } = {}) {
  const parsedGateTrace = item.gate_trace_json ? parseJson(item.gate_trace_json, null) : null;
  const planProfile = item.plan_profile
    ? getFinancePlanProfileConfig(item.plan_profile)
    : resolveCandidateProfile(item);
  const { gate_trace_json: _gateTraceJson, ...itemWithoutRawGateTrace } = item;
  const itemWithProfile = {
    ...itemWithoutRawGateTrace,
    plan_profile: item.plan_profile || planProfile.key,
    plan_profile_label: item.plan_profile_label || planProfile.label
  };
  const hasCurrentGateShape = parsedGateTrace?.gates && CANDIDATE_GATE_DEFINITIONS.every(definition =>
    parsedGateTrace.gates.some((gate: CandidateGate) => gate.key === definition.key)
  );
  const needsGateTrace = Boolean(options.includeGateTrace)
    || !item.first_blocking_gate_key
    || !item.first_blocking_gate_label
    || !item.blocking_gate_labels;
  const gateTrace = needsGateTrace
    ? (hasCurrentGateShape ? parsedGateTrace : buildStoredGateTrace(itemWithProfile))
    : null;
  const hydrated = {
    ...itemWithProfile,
    opportunity_type: item.opportunity_type || classifyOpportunityType(itemWithProfile),
    first_blocking_gate_key: item.first_blocking_gate_key || gateTrace?.first_blocking_gate?.key || null,
    first_blocking_gate_label: item.first_blocking_gate_label || gateTrace?.first_blocking_gate?.label || null,
    blocking_gate_labels: item.blocking_gate_labels || gateTrace?.blocking_gates?.map((gate: CandidateGate) => gate.label).join('、') || null,
  };
  if (options.includeGateTrace) {
    return {
      ...hydrated,
      gate_trace: gateTrace || buildStoredGateTrace(itemWithProfile)
    };
  }
  return hydrated;
}

async function getOptionalFlowRow(db: any, sql: string, params: any[] = []) {
  try {
    return await db.get(sql, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table|no such column/i.test(message)) return null;
    throw error;
  }
}

function buildTimelineStep(input: CandidateFlowTimelineStep): CandidateFlowTimelineStep {
  return {
    key: input.key,
    label: input.label,
    status: input.status,
    date: input.date || null,
    summary: input.summary || '--',
    detail: input.detail || '--',
    metric: input.metric || null,
    actionLabel: input.actionLabel || null
  };
}

function getCandidatePoolTimelineStatus(item: any): CandidateFlowTimelineStatus {
  const poolStatus = String(item.pool_status || '');
  const reviewStatus = String(item.review_status || '');
  if (poolStatus === 'expired' || poolStatus === 'ignored' || reviewStatus === 'rejected') return 'blocked';
  if (poolStatus === 'planned' || reviewStatus === 'plan_ready') return 'done';
  if (poolStatus === 'active') return 'done';
  return 'waiting';
}

function getTrendTimelineStatus(code?: string | null): CandidateFlowTimelineStatus {
  const value = String(code || '');
  if (!value || value === 'UNKNOWN') return 'missing';
  if (['CRASH_DROP', 'SURGE', 'REBOUND', 'SLOW_BLEED'].includes(value)) return 'blocked';
  if (['BREAKOUT', 'SLOW_GRIND_UP', 'RECOVERY', 'TREND_UP', 'HIGH_BASE'].includes(value)) return 'done';
  return 'waiting';
}

function getStructureTimelineStatus(item: any, reviewRow: any): CandidateFlowTimelineStatus {
  const reviewStatus = String(item.review_status || reviewRow?.review_status || '');
  if (['rejected', 'ignored'].includes(reviewStatus)) return 'blocked';
  if (['wait_confirmation', 'plan_ready'].includes(reviewStatus) || reviewRow?.review_status === 'confirmed') return 'done';
  if (['structure_pending', 'structure_watch', 'structure_ready', 'model_conflict', 'drafted'].includes(reviewStatus)) return 'active';
  if (item.structure_status === 'STRUCTURE_CONFIRMED' && item.safe_zone_status === 'SAFE_ZONE') return 'done';
  if (item.structure_status === 'STRUCTURE_BROKEN' || item.safe_zone_status === 'BROKEN_ZONE') return 'blocked';
  return 'waiting';
}

function getEntryTriggerTimelineStatus(row: any): CandidateFlowTimelineStatus {
  if (!row) return 'missing';
  const status = String(row.observation_status || '');
  if (['confirmed', 'plan_candidate'].includes(status)) return 'done';
  if (['watching', 'rechecking'].includes(status)) return 'active';
  if (['blocked', 'invalidated', 'expired', 'rejected', 'returned', 'upstream_expired'].includes(status)) return 'blocked';
  return 'waiting';
}

function getPlanTimelineStatus(row: any): CandidateFlowTimelineStatus {
  if (!row) return 'missing';
  const status = String(row.status || '');
  if (['confirmed', 'active', 'executed', 'completed'].includes(status) || row.is_bought === 1) return 'done';
  if (['draft', 'pending', 'watching'].includes(status)) return 'active';
  if (['invalidated', 'cancelled', 'archived', 'deleted'].includes(status) || row.stopped_out === 1) return 'blocked';
  return 'waiting';
}

function getOutcomeTimelineStatus(metrics: any): CandidateFlowTimelineStatus {
  if (!metrics) return 'missing';
  if (metrics.brokeInvalidation) return 'blocked';
  if (metrics.ret20 !== null && metrics.ret20 !== undefined) return Number(metrics.ret20) > 0 ? 'done' : 'blocked';
  if (metrics.ret10 !== null && metrics.ret10 !== undefined) return 'active';
  return 'waiting';
}

function getOutcomeLabel(metrics: any): string {
  if (!metrics) return '等待样本验证';
  if (metrics.brokeInvalidation) return '跌破失效';
  if (metrics.ret20 !== null && metrics.ret20 !== undefined) return Number(metrics.ret20) > 0 ? '20日正收益' : '20日负收益';
  if (metrics.ret10 !== null && metrics.ret10 !== undefined) return Number(metrics.ret10) > 0 ? '10日正收益' : '10日负收益';
  if (metrics.ret5 !== null && metrics.ret5 !== undefined) return Number(metrics.ret5) > 0 ? '5日正收益' : '5日负收益';
  return '等待样本验证';
}

function formatOutcomeMetric(metrics: any): string | null {
  if (!metrics) return null;
  const parts = [
    metrics.ret5 !== null && metrics.ret5 !== undefined ? `5日 ${formatSignedPercent(metrics.ret5)}` : null,
    metrics.ret10 !== null && metrics.ret10 !== undefined ? `10日 ${formatSignedPercent(metrics.ret10)}` : null,
    metrics.ret20 !== null && metrics.ret20 !== undefined ? `20日 ${formatSignedPercent(metrics.ret20)}` : null,
    metrics.maxDrawdown20 !== null && metrics.maxDrawdown20 !== undefined ? `20日最大回撤 ${formatSignedPercent(metrics.maxDrawdown20)}` : null
  ].filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

async function getCandidateForwardOutcome(db: any, item: any) {
  const tradeDate = item.trade_date || item.first_selected_at?.slice(0, 10);
  if (!item.symbol || !tradeDate) return null;
  const maxTradeDate = await getLatestCoveredTradeDate(db, { assetTypes: [item.asset_type || 'stock'] });
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
    [item.symbol, item.asset_type || 'stock', item.source || 'tushare', tradeDate, maxTradeDate || null, maxTradeDate || null]
  );
  const entryClose = toNullableNumber(item.close) || toNullableNumber(prices[0]?.close);
  if (!entryClose || prices.length < 2) {
    return {
      latestTradeDate: prices[0]?.trade_date || null,
      ret5: null,
      ret10: null,
      ret20: null,
      maxDrawdown20: null,
      brokeInvalidation: false
    };
  }
  const getReturn = (offset: number) => {
    const close = toNullableNumber(prices[offset]?.close);
    return close && close > 0 ? Math.round((close / entryClose - 1) * 10000) / 10000 : null;
  };
  const window20 = prices.slice(1, 21);
  const minLow = window20.length
    ? Math.min(...window20.map((price: any) => toNullableNumber(price.low) || toNullableNumber(price.close) || entryClose))
    : null;
  const invalidationLine = toNullableNumber(item.invalidation_line);
  return {
    latestTradeDate: prices[prices.length - 1]?.trade_date || null,
    ret5: getReturn(5),
    ret10: getReturn(10),
    ret20: getReturn(20),
    maxDrawdown20: minLow && minLow > 0 ? Math.round((minLow / entryClose - 1) * 10000) / 10000 : null,
    brokeInvalidation: Boolean(invalidationLine && window20.some((price: any) => (toNullableNumber(price.low) || toNullableNumber(price.close) || entryClose) < invalidationLine))
  };
}

async function buildCandidateFlowTimeline(db: any, item: any): Promise<CandidateFlowTimelineStep[]> {
  const [trendRow, reviewRow, observationRow, planRow, sampleRow] = await Promise.all([
    getOptionalFlowRow(
      db,
      `SELECT trade_date, trend_phase_code, trend_phase_reason, reason_details, created_at
       FROM financial_trend_phase_results
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
       ORDER BY trade_date DESC, id DESC
       LIMIT 1`,
      [item.symbol, item.asset_type, item.source]
    ),
    getOptionalFlowRow(
      db,
      `SELECT id, review_status, lane_label, suggested_action_label, draft_json, created_at, updated_at
       FROM financial_candidate_reviews
       WHERE candidate_id = ?
          OR (symbol = ? AND asset_type = ? AND source = ?)
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [item.id, item.symbol, item.asset_type, item.source]
    ),
    getOptionalFlowRow(
      db,
      `SELECT id, trade_date, observation_status, entry_action, action_label, trigger_score,
              trigger_reason, trend_phase_code, close_price, invalidation_line, created_at, updated_at
       FROM financial_entry_trigger_observations
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [item.symbol, item.asset_type, item.source]
    ),
    getOptionalFlowRow(
      db,
      `SELECT id, plan_name, trade_date, status, trigger_type, trigger_reason, structure_score,
              trigger_score, close_price, invalidation_line, max_loss_percent, is_bought,
              stopped_out, perf_5d, perf_10d, perf_20d, created_at, updated_at
       FROM financial_trade_plans
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND COALESCE(is_deleted, 0) = 0
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [item.symbol, item.asset_type, item.source]
    ),
    getOptionalFlowRow(
      db,
      `WITH latest AS (
         SELECT sample_id, MAX(snapshot_date) AS snapshot_date
         FROM finance_decision_sample_snapshots
         GROUP BY sample_id
       )
       SELECT s.id, s.stage_key, s.stage_status, s.reason, s.updated_at,
              ds.snapshot_date, ds.ret_5d, ds.ret_10d, ds.ret_20d,
              ds.max_drawdown_20d, ds.broke_invalidation, ds.outcome_label
       FROM finance_decision_samples s
       LEFT JOIN latest l ON l.sample_id = s.id
       LEFT JOIN finance_decision_sample_snapshots ds
         ON ds.sample_id = s.id
        AND ds.snapshot_date = l.snapshot_date
       WHERE s.symbol = ?
         AND s.asset_type = ?
         AND s.source = ?
       ORDER BY COALESCE(ds.snapshot_date, s.updated_at) DESC, s.id DESC
       LIMIT 1`,
      [item.symbol, item.asset_type, item.source]
    )
  ]);
  const fallbackOutcome = sampleRow?.outcome_label ? null : await getCandidateForwardOutcome(db, item);
  const sampleMetrics = sampleRow
    ? {
        ret5: sampleRow.ret_5d,
        ret10: sampleRow.ret_10d,
        ret20: sampleRow.ret_20d,
        maxDrawdown20: sampleRow.max_drawdown_20d,
        brokeInvalidation: sampleRow.broke_invalidation === 1
      }
    : fallbackOutcome;
  const trendCode = trendRow?.trend_phase_code || item.trend_phase_code;
  const reviewDraft = parseJson(reviewRow?.draft_json, {});

  return [
    buildTimelineStep({
      key: 'candidate_pool',
      label: '入池原因',
      status: getCandidatePoolTimelineStatus(item),
      date: item.trade_date,
      summary: item.pool_status === 'active' ? '已进入备选池' : getPoolStatusLabel(item.pool_status),
      detail: item.candidate_reason || item.first_blocking_gate_label || item.forbidden_reason || item.downgrade_reason || item.risk_note || '已记录入池结果，等待后续流水线推进。',
      metric: item.priority_score !== null && item.priority_score !== undefined ? `优先分 ${item.priority_score}` : null
    }),
    buildTimelineStep({
      key: 'trend_phase',
      label: '走势阶段',
      status: getTrendTimelineStatus(trendCode),
      date: trendRow?.trade_date || item.trade_date,
      summary: trendCode ? getTrendPhaseLabel(trendCode) : '未形成走势阶段',
      detail: trendRow?.trend_phase_reason || trendRow?.reason_details || item.trend_phase_reason || '还没有走势阶段结果，需要等日终走势阶段流水线补算。',
      metric: trendRow?.created_at || null
    }),
    buildTimelineStep({
      key: 'single_asset_check',
      label: '结构判断',
      status: getStructureTimelineStatus(item, reviewRow),
      date: reviewRow?.updated_at || item.last_review_at || item.last_checked_at,
      summary: reviewRow?.lane_label || getStructureLabel(item.structure_status),
      detail: reviewDraft?.summary || item.risk_note || item.candidate_reason || '结构、安全区和风险项已用于当前候选状态。',
      metric: item.invalidation_line ? `失效线 ${Number(item.invalidation_line).toFixed(3)}` : null,
      actionLabel: reviewRow?.suggested_action_label || null
    }),
    buildTimelineStep({
      key: 'entry_trigger',
      label: '入场触发',
      status: getEntryTriggerTimelineStatus(observationRow),
      date: observationRow?.updated_at || observationRow?.trade_date || null,
      summary: observationRow?.action_label || observationRow?.observation_status || '尚未进入触发观察',
      detail: observationRow?.trigger_reason || '单标的判断通过后，才会进入入场触发观察或计划准备池。',
      metric: observationRow?.trigger_score !== null && observationRow?.trigger_score !== undefined ? `触发分 ${observationRow.trigger_score}` : null,
      actionLabel: observationRow?.entry_action || null
    }),
    buildTimelineStep({
      key: 'trade_plan',
      label: '是否进计划',
      status: getPlanTimelineStatus(planRow),
      date: planRow?.updated_at || planRow?.trade_date || null,
      summary: planRow?.plan_name || (item.review_status === 'plan_ready' ? '已到计划准备口' : '未生成买入计划'),
      detail: planRow?.trigger_reason || (item.review_status === 'plan_ready' ? '已进入计划准备池，但金融买入计划仍需要人工确认。' : '未到计划准备口，不能绕过触发直接生成买入计划。'),
      metric: planRow?.max_loss_percent !== null && planRow?.max_loss_percent !== undefined ? `最大损失 ${formatPercent(planRow.max_loss_percent)}` : null,
      actionLabel: planRow?.status || null
    }),
    buildTimelineStep({
      key: 'posterior_validation',
      label: '后验结果',
      status: getOutcomeTimelineStatus(sampleMetrics),
      date: sampleRow?.snapshot_date || fallbackOutcome?.latestTradeDate || null,
      summary: sampleRow?.outcome_label || getOutcomeLabel(sampleMetrics),
      detail: sampleRow?.reason || '后验口径按入池日后的 5/10/20 个交易日和失效线观察，样本不足时继续等待。',
      metric: formatOutcomeMetric(sampleMetrics),
      actionLabel: sampleRow?.stage_key || null
    })
  ];
}

function compactTextForList(value: unknown, maxBytes = 180) {
  if (value === undefined || value === null) return value;
  const text = String(value);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let clipped = text;
  while (clipped.length > 0 && Buffer.byteLength(`${clipped}...`, 'utf8') > maxBytes) {
    clipped = clipped.slice(0, Math.max(0, clipped.length - 8));
  }
  return `${clipped.trimEnd()}...`;
}

function stripEmptyCompactFields(payload: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

function compactOpportunityTypeForList(value: any) {
  if (!value) return value;
  return stripEmptyCompactFields({
    code: value.code,
    label: value.label,
    tone: value.tone,
    reason: compactTextForList(value.reason, 90)
  });
}

function compactCandidatePoolListItem(item: any) {
  return stripEmptyCompactFields({
    id: item.id,
    symbol: item.symbol,
    name: item.name,
    asset_type: item.asset_type,
    source: item.source,
    trade_date: item.trade_date,
    close: item.close,
    ma60: item.ma60,
    distance_to_ma60: item.distance_to_ma60,
    above_ma60_days: item.above_ma60_days,
    structure_status: item.structure_status,
    safe_zone_status: item.safe_zone_status,
    trend_phase_code: item.trend_phase_code,
    entry_permission: item.entry_permission,
    pool_status: item.pool_status,
    priority: item.priority,
    priority_score: item.priority_score,
    forbidden_reason: compactTextForList(item.forbidden_reason, 160),
    downgrade_reason: compactTextForList(item.downgrade_reason, 140),
    risk_note: compactTextForList(item.risk_note, 140),
    invalidation_line: item.invalidation_line,
    candidate_reason: compactTextForList(item.candidate_reason, 180),
    last_checked_at: item.last_checked_at,
    ml_available: item.ml_available,
    ml_probability: item.ml_probability,
    ml_target: item.ml_target,
    ml_score_reason: compactTextForList(item.ml_score_reason, 120),
    review_status: item.review_status,
    last_review_at: item.last_review_at,
    has_entry_observation: item.entry_observation_status ? 1 : 0,
    entry_observation_id: item.entry_observation_id,
    entry_observation_status: item.entry_observation_status,
    entry_observation_action_label: item.entry_observation_action_label,
    entry_observation_trigger_score: item.entry_observation_trigger_score,
    entry_observation_trigger_reason: compactTextForList(item.entry_observation_trigger_reason, 140),
    entry_observation_updated_at: item.entry_observation_updated_at,
    universe_type: item.universe_type,
    plan_profile: item.plan_profile,
    plan_profile_label: item.plan_profile_label,
    opportunity_type: compactOpportunityTypeForList(item.opportunity_type)
  });
}

function compactModelRecheckListItem(item: any) {
  return stripEmptyCompactFields({
    ...compactCandidatePoolListItem(item),
    first_blocking_gate_key: item.first_blocking_gate_key,
    first_blocking_gate_label: item.first_blocking_gate_label,
    blocking_gate_labels: item.blocking_gate_labels,
    updated_at: item.updated_at,
    local_last_trade_date: item.local_last_trade_date,
    local_price_updated_at: item.local_price_updated_at,
    local_last_fetch_at: item.local_last_fetch_at,
    local_last_fetch_message: compactTextForList(item.local_last_fetch_message, 220),
    market_latest_trade_date: item.market_latest_trade_date,
    model_recheck_bucket: item.model_recheck_bucket,
    model_recheck_data_gap: item.model_recheck_data_gap
  });
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

function getFeatureDbLatestTradeDate(featureDbPath: string, domain: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const featureDb = new sqlite3.Database(featureDbPath, sqlite3.OPEN_READONLY, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      featureDb.get(
        `SELECT MAX(trade_date) AS latest_trade_date
         FROM financial_ml_features
         WHERE asset_type = ?
           AND trade_date IS NOT NULL`,
        [domain],
        (queryError, row: any) => {
          featureDb.close();
          if (queryError) {
            reject(queryError);
            return;
          }
          resolve(row?.latest_trade_date ? String(row.latest_trade_date) : null);
        }
      );
    });
  });
}

function buildStaleFeatureReason(domain: string, latestTradeDate: string | null, asOfTradeDate: string | null | undefined) {
  if (!latestTradeDate) {
    return `${domain} 模型特征库没有可用交易日，请先重新生成训练特征。`;
  }
  return `模型特征库滞后：${domain} 特征日 ${latestTradeDate}，当前评分口径 ${asOfTradeDate || '--'}；请先刷新训练特征/重新训练后再评分。`;
}

async function getCandidateModelFreshness(
  db: any,
  domain: string,
  asOfTradeDate?: string | null
): Promise<CandidateModelFreshness> {
  const cacheKey = `${domain}|${asOfTradeDate || 'latest'}`;
  const cached = candidateModelFreshnessCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const artifacts = await db.all(
    `SELECT domain, model_key, target, model_file, source_feature_db
     FROM model_training_artifacts
     WHERE domain = ?`,
    [domain]
  );
  const artifact = CANDIDATE_MODEL_PRIORITY
    .map(modelKey => artifacts.find((row: any) => row.model_key === modelKey && row.model_file && fs.existsSync(row.model_file)))
    .find(Boolean);

  let data: CandidateModelFreshness;
  if (!artifact) {
    data = {
      available: false,
      reason: `未找到 ${domain} 可用模型文件，请先完成模型与结果落库。`,
      modelKey: null,
      target: null,
      latestFeatureTradeDate: null
    };
  } else if (!artifact.source_feature_db || !fs.existsSync(artifact.source_feature_db)) {
    data = {
      available: false,
      reason: '模型登记里的特征库不存在，不能预测。',
      modelKey: artifact.model_key || null,
      target: artifact.target || null,
      latestFeatureTradeDate: null
    };
  } else {
    const latestFeatureTradeDate = await getFeatureDbLatestTradeDate(artifact.source_feature_db, domain);
    const stale = Boolean(asOfTradeDate && (!latestFeatureTradeDate || latestFeatureTradeDate < asOfTradeDate));
    data = {
      available: !stale,
      reason: stale ? buildStaleFeatureReason(domain, latestFeatureTradeDate, asOfTradeDate) : null,
      modelKey: artifact.model_key || null,
      target: artifact.target || null,
      latestFeatureTradeDate
    };
  }

  candidateModelFreshnessCache.set(cacheKey, {
    expiresAt: Date.now() + CANDIDATE_SCORE_CACHE_MS,
    data
  });
  return data;
}

function buildUnavailableCandidateScoreMap(
  items: any[],
  freshnessByDomain: Map<string, CandidateModelFreshness>
) {
  return items.reduce((scores: Record<string, any>, item: any) => {
    const freshness = freshnessByDomain.get(item.asset_type);
    scores[`${item.symbol}|${item.asset_type}|${item.source}`] = {
      available: false,
      modelKey: freshness?.modelKey || null,
      target: freshness?.target || null,
      tradeDate: freshness?.latestFeatureTradeDate || null,
      reason: freshness?.reason || '该资产类型暂未接入模型'
    };
    return scores;
  }, {});
}

function getCandidateScoreKey(item: any) {
  return `${item.symbol}|${item.asset_type}|${item.source}`;
}

function toPersistedCandidateScore(row: any, asOfTradeDate?: string | null) {
  const probability = Number(row.probability);
  const scoreTradeDate = row.as_of_trade_date || row.trade_date || null;
  const current = !asOfTradeDate || scoreTradeDate === asOfTradeDate;
  return {
    available: current && Number.isFinite(probability),
    probability: Number.isFinite(probability) ? probability : null,
    modelKey: row.model_key || null,
    target: row.model_target || null,
    tradeDate: scoreTradeDate,
    reason: current
      ? row.conflict_label || null
      : `候选模型分数滞后：评分日 ${scoreTradeDate || '--'}，当前覆盖交易日 ${asOfTradeDate || '--'}。`
  };
}

async function loadPersistedCandidateScoreMap(
  db: any,
  items: any[],
  asOfTradeDate?: string | null
): Promise<Record<string, any>> {
  if (!items.length) return {};
  const domains = Array.from(new Set(
    items.map(item => item.asset_type).filter(domain => CANDIDATE_POOL_ASSET_TYPES.includes(domain))
  ));
  const symbols = Array.from(new Set(items.map(item => item.symbol).filter(Boolean)));
  if (!domains.length || !symbols.length) return {};

  const domainPlaceholders = domains.map(() => '?').join(', ');
  const symbolPlaceholders = symbols.map(() => '?').join(', ');
  const rows = await db.all(
    `WITH ranked_scores AS (
       SELECT s.*,
              ROW_NUMBER() OVER (
                PARTITION BY s.domain, s.symbol, s.asset_type, s.source
                ORDER BY
                  CASE WHEN COALESCE(s.as_of_trade_date, s.trade_date) = ? THEN 0 ELSE 1 END,
                  COALESCE(s.as_of_trade_date, s.trade_date) DESC,
                  s.updated_at DESC,
                  s.id DESC
              ) AS rn
       FROM model_training_candidate_scores s
       WHERE s.domain IN (${domainPlaceholders})
         AND s.symbol IN (${symbolPlaceholders})
         AND s.asset_type IN ('stock', 'etf')
         AND (? IS NULL OR COALESCE(s.as_of_trade_date, s.trade_date) <= ?)
     )
     SELECT *
     FROM ranked_scores
     WHERE rn = 1`,
    [asOfTradeDate || '', ...domains, ...symbols, asOfTradeDate || null, asOfTradeDate || null]
  );

  const itemKeys = new Set(items.map(getCandidateScoreKey));
  return rows.reduce((scores: Record<string, any>, row: any) => {
    const key = getCandidateScoreKey(row);
    if (itemKeys.has(key)) {
      scores[key] = toPersistedCandidateScore(row, asOfTradeDate);
    }
    return scores;
  }, {});
}

function hasCurrentPersistedScores(items: any[], scoreMap: Record<string, any>, asOfTradeDate?: string | null) {
  return items.every(item => {
    const score = scoreMap[getCandidateScoreKey(item)];
    if (!score || score.available !== true || typeof score.probability !== 'number') return false;
    return !asOfTradeDate || score.tradeDate === asOfTradeDate;
  });
}

function runCandidateScoreWorker(
  limit: number,
  poolStatus: 'active' | 'expired' | 'all' = 'active',
  tradeDate?: string | null,
  domain?: string | null,
  symbol?: string | null
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const dbPath = getDatabasePath();
    const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'score_candidate_pool.py');
    const args = [
      scriptPath,
      '--db', dbPath,
      '--rule-version', CANDIDATE_RULE_VERSION,
      '--pool-status', poolStatus,
      '--limit', String(limit)
    ];
    if (tradeDate) {
      args.push('--trade-date', tradeDate);
    }
    if (domain && CANDIDATE_POOL_ASSET_TYPES.includes(domain)) {
      args.push('--domain', domain);
    }
    if (symbol) {
      args.push('--symbol', symbol);
    }
    const child = spawn(trainingPython, args, {
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

async function runCachedCandidateScoreWorker(
  limit: number,
  poolStatus: 'active' | 'expired' | 'all' = 'active',
  tradeDate?: string | null,
  domain?: string | null,
  symbol?: string | null
) {
  const cacheKey = `${poolStatus}|${limit}|${tradeDate || 'latest'}|${domain || 'all'}|${symbol || 'all'}`;
  const cached = candidateScoreCache.get(cacheKey);
  if (cached?.data && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  if (cached?.promise) {
    return cached.promise;
  }
  const promise = runCandidateScoreWorker(limit, poolStatus, tradeDate, domain, symbol);
  candidateScoreCache.set(cacheKey, {
    expiresAt: 0,
    promise
  });
  try {
    const data = await promise;
    candidateScoreCache.set(cacheKey, {
      expiresAt: Date.now() + CANDIDATE_SCORE_CACHE_MS,
      data
    });
    return data;
  } catch (error) {
    if (candidateScoreCache.get(cacheKey)?.promise === promise) {
      candidateScoreCache.delete(cacheKey);
    }
    throw error;
  }
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

function getStructureLabel(value?: string): string {
  switch (value) {
    case 'STRUCTURE_CONFIRMED': return '结构成立';
    case 'STRUCTURE_WATCH': return '结构观察';
    case 'STRUCTURE_BROKEN': return '结构破坏';
    case 'INSUFFICIENT_DATA': return '数据不足';
    default: return value || '--';
  }
}

function getPoolStatusLabel(value?: string): string {
  switch (value) {
    case 'active': return '备选中';
    case 'ignored': return '已忽略';
    case 'planned': return '已进入计划';
    case 'expired': return '已失效';
    default: return value || '--';
  }
}

function toNullableNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
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
    strengthContext.benchmarkReturns,
    { asOfTradeDate: strengthContext.asOfTradeDate }
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
  const isFocusOrIndustry = typeSet.has('industry_etf') || isIndustryThemeEtfLike({ name, symbol }) || Boolean(context?.candidateMap.has(symbol));
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

function classifyEtfExposureGroup(input: { symbol?: string | null; name?: string | null; universe_type?: string | null; plan_profile?: string | null }) {
  const text = `${input.name || ''} ${input.symbol || ''}`;
  const normalized = text.replace(/\s+/g, '');
  const broadRules: Array<[RegExp, string, string]> = [
    [/沪深300|HS300/i, 'broad:hs300', '沪深300敞口'],
    [/中证A?500|A500/i, 'broad:a500', '中证A500敞口'],
    [/中证A?50|A50/i, 'broad:a50', '中证A50敞口'],
    [/上证50/i, 'broad:sse50', '上证50敞口'],
    [/中证500(?!0)|500增强/i, 'broad:zz500', '中证500敞口'],
    [/中证1000|1000增强/i, 'broad:zz1000', '中证1000敞口'],
    [/中证2000|2000增强/i, 'broad:zz2000', '中证2000敞口'],
    [/创业板50|创业板ETF|创业板/i, 'style:chinext', '创业板敞口'],
    [/科创50|科创100|科创/i, 'style:star', '科创敞口'],
    [/MSCIA股|MSCI中国A股|MSCI中国ETF|MSCI/i, 'broad:msci_a', 'MSCI A股敞口'],
    [/红利|高股息|股息|质量/i, 'factor:dividend_quality', '红利/质量/高股息敞口']
  ];
  const industryRules: Array<[RegExp, string, string]> = [
    [/半导体|芯片|集成电路/i, 'industry:semiconductor', '半导体敞口'],
    [/人工智能|AI|云计算|算力|软件|信创|数据/i, 'industry:ai_cloud', 'AI/云计算敞口'],
    [/证券|券商|金融科技/i, 'industry:brokerage', '证券金融敞口'],
    [/银行|保险/i, 'industry:bank_insurance', '银行保险敞口'],
    [/医疗|医药|创新药|生物/i, 'industry:healthcare', '医疗医药敞口'],
    [/新能源车|新能源汽车|锂电|电池/i, 'industry:nev_battery', '新能源车/电池敞口'],
    [/光伏|太阳能/i, 'industry:solar', '光伏敞口'],
    [/电力|绿色电力|公用事业/i, 'industry:power', '电力敞口'],
    [/高端装备|装备|机械|机器人/i, 'industry:equipment_robot', '高端装备/机器人敞口'],
    [/环保|碳中和/i, 'industry:environment', '环保敞口'],
    [/消费|食品饮料|白酒|酒ETF/i, 'industry:consumer', '消费敞口'],
    [/传媒|游戏/i, 'industry:media_game', '传媒游戏敞口'],
    [/军工|国防/i, 'industry:defense', '军工敞口'],
    [/有色|稀土|煤炭|钢铁|化工/i, 'industry:resources', '资源周期敞口'],
    [/地产|房地产|基建|建材/i, 'industry:property_infra', '地产基建敞口']
  ];
  for (const [pattern, key, label] of [...broadRules, ...industryRules]) {
    if (pattern.test(normalized)) return { key, label, dedupe: true };
  }
  if (String(input.plan_profile || '').includes('etf_broad')) {
    return { key: `broad:other:${input.symbol || normalized}`, label: '其它宽基敞口', dedupe: false };
  }
  if (String(input.plan_profile || '').includes('etf_industry')) {
    return { key: `industry:other:${input.symbol || normalized}`, label: '其它行业主题敞口', dedupe: false };
  }
  return { key: `unique:${input.symbol || normalized}`, label: '未归类ETF敞口', dedupe: false };
}

async function dedupeActiveEtfExposureCandidates(
  db: any,
  options: { source: string; minTradeDate?: string | null }
) {
  const params: any[] = [options.source, CANDIDATE_RULE_VERSION];
  const minDateClause = options.minTradeDate ? 'AND c.trade_date >= ?' : '';
  if (options.minTradeDate) params.push(options.minTradeDate);
  const rows = await db.all(
    `SELECT c.id, c.symbol, c.name, c.trade_date, c.priority_score, c.final_status,
            c.distance_to_ma60, c.plan_profile,
            (
              SELECT GROUP_CONCAT(DISTINCT u.universe_type)
              FROM financial_asset_universe u
              WHERE u.symbol = c.symbol
                AND u.asset_type = c.asset_type
                AND u.source = c.source
            ) AS universe_type,
            (
              SELECT AVG(p.amount)
              FROM financial_daily_prices p
              WHERE p.symbol = c.symbol
                AND p.asset_type = c.asset_type
                AND p.source = c.source
                AND p.trade_date <= c.trade_date
                AND p.trade_date >= date(c.trade_date, '-45 days')
            ) AS avg_amount20
     FROM financial_candidate_pool c
     WHERE c.pool_status = 'active'
       AND c.asset_type = 'etf'
       AND c.source = ?
       AND c.rule_version = ?
       ${minDateClause}`,
    params
  );

  const groups = new Map<string, any[]>();
  const groupMeta = new Map<string, { label: string; dedupe: boolean }>();
  for (const row of rows) {
    const group = classifyEtfExposureGroup({
      symbol: row.symbol,
      name: row.name,
      universe_type: row.universe_type,
      plan_profile: row.plan_profile
    });
    groupMeta.set(group.key, { label: group.label, dedupe: group.dedupe });
    if (!groups.has(group.key)) groups.set(group.key, []);
    groups.get(group.key)?.push(row);
  }

  const expiredIds: number[] = [];
  const dedupedGroups: any[] = [];
  for (const [key, items] of groups.entries()) {
    const meta = groupMeta.get(key);
    if (!meta?.dedupe || items.length <= 1) continue;
    const sorted = [...items].sort((a, b) => {
      const readyDiff = (b.final_status === 'READY_FOR_PLAN' ? 1 : 0) - (a.final_status === 'READY_FOR_PLAN' ? 1 : 0);
      if (readyDiff) return readyDiff;
      const priorityDiff = Number(b.priority_score || 0) - Number(a.priority_score || 0);
      if (priorityDiff) return priorityDiff;
      const amountDiff = Number(b.avg_amount20 || 0) - Number(a.avg_amount20 || 0);
      if (amountDiff) return amountDiff;
      const distanceDiff = Math.abs(Number(a.distance_to_ma60 || 0)) - Math.abs(Number(b.distance_to_ma60 || 0));
      if (distanceDiff) return distanceDiff;
      return String(a.symbol || '').localeCompare(String(b.symbol || ''));
    });
    const keeper = sorted[0];
    const duplicates = sorted.slice(1);
    expiredIds.push(...duplicates.map(item => Number(item.id)).filter(Boolean));
    dedupedGroups.push({
      key,
      label: meta.label,
      kept: { id: keeper.id, symbol: keeper.symbol, name: keeper.name },
      expired_count: duplicates.length,
      expired_symbols: duplicates.map(item => item.symbol)
    });
  }

  if (expiredIds.length > 0) {
    const now = new Date().toISOString();
    const placeholders = expiredIds.map(() => '?').join(',');
    await db.run(
      `UPDATE financial_candidate_pool
       SET pool_status = 'expired',
           final_status = 'REJECTED',
           review_status = 'rejected',
           review_action = CASE
             WHEN COALESCE(review_action, '') = '' THEN 'etf_exposure_duplicate_expired'
             ELSE review_action
           END,
           candidate_reason = '同类ETF敞口重复，本轮只保留同组优先分/流动性更好的代表。',
           forbidden_reason = '同类ETF敞口重复，避免候选池暴露集中和重复计划。',
           first_blocking_gate_key = 'etf_exposure_dedup_gate',
           first_blocking_gate_label = '同类ETF敞口重复',
           blocking_gate_labels = '同类ETF敞口重复',
           last_checked_at = ?,
           last_review_at = ?,
           updated_at = ?
       WHERE id IN (${placeholders})`,
      [now, now, now, ...expiredIds]
    );
  }

  return {
    expired_count: expiredIds.length,
    groups: dedupedGroups
  };
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
    return { key: 'REVIEW_PLAN_CANDIDATE', label: '建议人工复核计划条件', tone: 'success' };
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
      final_status: 'WAIT',
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
  industryStrengthContext?: IndustryEtfStrengthContext,
  stockIndustryStrengthContext?: StockIndustryStrengthContext
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
  const stockIndustryStrength = assetType === 'stock'
    ? evaluateStockIndustryStrength(symbol, stockIndustryStrengthContext)
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

  const marketRegime = await getFreshMarketRegime(db, { source });
  const marketDowngradeReasons = Array.isArray(marketRegime?.composite_gate?.downgrade_reasons)
    ? marketRegime.composite_gate.downgrade_reasons
    : [];

  const basePriorityResult = calculateCandidatePriority(
    structure,
    marketRegime?.entry_permission || 'OBSERVE_ONLY',
    trendPhase?.trend_phase_code,
    riskProfile,
    planProfile.key,
    marketDowngradeReasons
  );
  const priorityResult = assetType === 'stock'
    ? adjustPriorityWithStockIndustry(basePriorityResult, stockIndustryStrength)
    : basePriorityResult;
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
    !stockIndustryStrength?.forbidden_reason &&
    !etfPreGateReason &&
    !etfGateReason;
  const earlyMainlineWatch =
    !selected &&
    opportunityType.code === 'EARLY_LEADER_WATCH' &&
    (marketRegime?.entry_permission || 'OBSERVE_ONLY') === 'ALLOW_STRUCTURE_CHECK' &&
    !stockTradeQualification?.forbidden_reason &&
    !stockIndustryStrength?.forbidden_reason &&
    !priorityResult.forbidden_reason &&
    !etfPreGateReason &&
    !etfGateReason;

  const marketFreshnessReason = marketRegime?.stale ? marketRegime.freshness_reason : null;
  const candidateReason = selected
    ? buildCandidateReason(structure.structure_reason, structure.safe_zone_reason, trendPhase?.trend_phase_code)
    : earlyMainlineWatch
      ? `${opportunityType.label}：${opportunityType.reason}；${structure.structure_reason}；${structure.safe_zone_reason}`
    : marketFreshnessReason || stockTradeQualification?.forbidden_reason || stockIndustryStrength?.forbidden_reason || priorityResult.forbidden_reason || etfPreGateReason || etfGateReason || '未同时满足安全区、结构成立和市场允许进入判断。';
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
    assetType === 'stock'
      ? makeGate(
          'stock_industry_gate',
          stockIndustryStrength?.forbidden_reason
            ? 'failed'
            : stockIndustryStrength?.downgrade_reason
              ? 'passed'
              : stockIndustryStrength?.known
                ? 'passed'
                : 'not_applicable',
          stockIndustryStrength?.forbidden_reason
            || stockIndustryStrength?.downgrade_reason
            || stockIndustryStrength?.reason
            || '行业强弱未计算。',
          Boolean(stockIndustryStrength?.forbidden_reason)
        )
      : makeGate('stock_industry_gate', 'not_applicable', 'ETF不走个股申万行业强弱门槛。'),
	    makeGate(
	      'market_gate',
	      (marketRegime?.entry_permission || 'OBSERVE_ONLY') === 'ALLOW_STRUCTURE_CHECK' ? 'passed' : 'failed',
	      marketRegime?.stale
	        ? marketRegime.freshness_reason
	        : (marketRegime?.entry_permission || 'OBSERVE_ONLY') === 'ALLOW_STRUCTURE_CHECK'
	        ? marketDowngradeReasons.length > 0
            ? `市场总闸允许进入结构判断，但组合条件进入观察/降权：${marketDowngradeReasons.join('；')}`
            : '市场总闸允许进入结构判断。'
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
    watch_only: earlyMainlineWatch,
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
    industry_strength: etfPreGate?.strength || stockIndustryStrength || null,
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

function getCandidateScanSeedStatus(trendPhase: any) {
  const trendCode = String(trendPhase?.trend_phase_code || '').trim();
  if (STRUCTURE_READY_TREND_PHASES.has(trendCode)) {
    return {
      reviewStatus: 'structure_pending',
      reviewAction: 'candidate_scan_trend_ready'
    };
  }
  if (trendCode && (STRUCTURE_HOLD_TREND_PHASES.has(trendCode) || ETF_HARD_BLOCK_TREND_PHASES.has(trendCode))) {
    return {
      reviewStatus: 'trend_blocked',
      reviewAction: 'candidate_scan_trend_hold'
    };
  }
  return {
    reviewStatus: 'unreviewed',
    reviewAction: null
  };
}

async function seedCandidateFlowStatusFromTrend(db: any, evaluation: any, now: string) {
  const seed = getCandidateScanSeedStatus(evaluation.trend_phase);
  if (seed.reviewStatus === 'unreviewed') return;

  await db.run(
    `UPDATE financial_candidate_pool
     SET review_status = CASE
           WHEN COALESCE(review_status, 'unreviewed') = 'plan_ready' THEN review_status
           WHEN ? = 'structure_pending'
             AND COALESCE(review_status, 'unreviewed') IN ('wait_confirmation', 'structure_watch', 'model_conflict')
             THEN review_status
           ELSE ?
         END,
         final_status = CASE
           WHEN COALESCE(review_status, 'unreviewed') = 'plan_ready' THEN final_status
           ELSE 'WAIT'
         END,
         review_action = CASE
           WHEN COALESCE(review_status, 'unreviewed') = 'plan_ready' THEN review_action
           WHEN ? = 'structure_pending'
             AND COALESCE(review_status, 'unreviewed') IN ('wait_confirmation', 'structure_watch', 'model_conflict')
             THEN review_action
           ELSE ?
         END,
         last_review_at = CASE
           WHEN COALESCE(review_status, 'unreviewed') = 'plan_ready' THEN last_review_at
           ELSE COALESCE(last_review_at, ?)
         END,
         updated_at = ?
     WHERE symbol = ?
       AND asset_type = ?
       AND source = ?
       AND rule_version = ?
       AND pool_status = 'active'`,
    [
      seed.reviewStatus,
      seed.reviewStatus,
      seed.reviewStatus,
      seed.reviewAction,
      now,
      now,
      evaluation.symbol,
      evaluation.asset_type,
      evaluation.source,
      CANDIDATE_RULE_VERSION
    ]
  );
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
      final_status = CASE
        WHEN COALESCE(financial_candidate_pool.review_status, 'unreviewed') = 'plan_ready' THEN financial_candidate_pool.final_status
        ELSE excluded.final_status
      END,
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
      'WAIT',
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

  await seedCandidateFlowStatusFromTrend(db, evaluation, now);

  if (!evaluation.watch_only) {
    await db.run(
      `UPDATE financial_candidate_pool
       SET review_status = 'unreviewed',
           review_action = CASE
             WHEN COALESCE(review_action, '') IN ('', 'rejected', 'excluded_recheck') THEN 'reactivated_by_candidate_scan'
             ELSE review_action
           END,
           updated_at = ?
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND rule_version = ?
         AND COALESCE(review_status, 'unreviewed') = 'rejected'
         AND pool_status = 'active'`,
      [
        now,
        evaluation.symbol,
        evaluation.asset_type,
        evaluation.source,
        CANDIDATE_RULE_VERSION
      ]
    );
  }
}

async function markCandidateAsWatchOnly(db: any, evaluation: any) {
  const now = new Date().toISOString();
  await db.run(
    `UPDATE financial_candidate_pool
     SET final_status = 'WAIT',
         review_status = 'structure_watch',
         review_action = 'early_mainline_watch',
         candidate_reason = ?,
         downgrade_reason = COALESCE(NULLIF(downgrade_reason, ''), ?),
         last_checked_at = ?,
         updated_at = ?
     WHERE symbol = ?
       AND asset_type = ?
       AND source = ?
       AND rule_version = ?`,
    [
      evaluation.candidate_reason || '早期主线观察，只进入观察层，不生成买入计划。',
      evaluation.candidate_reason || '早期主线观察，只进入观察层，不生成买入计划。',
      now,
      now,
      evaluation.symbol,
      evaluation.asset_type,
      evaluation.source,
      CANDIDATE_RULE_VERSION
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
    const rawReviewScope = String(req.query.review_scope || 'actionable');
    const reviewScope: ModelRecheckScope = ['actionable', 'data_gap', 'high_conflict', 'neutral', 'all'].includes(rawReviewScope)
      ? rawReviewScope as ModelRecheckScope
      : 'actionable';
    const excludeEntryObservation = req.query.exclude_entry_observation === '1' || req.query.exclude_entry_observation === 'true';
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const queryLimit = reviewQueue === 'model_recheck'
      ? reviewScope === 'data_gap'
        ? limit
        : reviewScope === 'actionable'
        ? Math.min(MODEL_RECHECK_QUERY_LIMIT, Math.max(limit + offset, 200))
        : MODEL_RECHECK_QUERY_LIMIT
      : limit;
    const queryOffset = reviewQueue === 'model_recheck'
      ? reviewScope === 'data_gap' ? offset : 0
      : offset;
    const includeModel = req.query.include_model === '1' || req.query.include_model === 'true' || reviewQueue === 'model_recheck';
    const keyword = String(req.query.q || '').trim();
    const coveredTradeDate = await getLatestCoveredTradeDate(db, {
      assetTypes: assetType && CANDIDATE_POOL_ASSET_TYPES.includes(assetType)
        ? [assetType]
        : CANDIDATE_POOL_ASSET_TYPES
    });

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

    if (keyword) {
      where += ` AND (symbol LIKE ? OR COALESCE(name, '') LIKE ?)`;
      params.push(`%${keyword}%`, `%${keyword}%`);
    }

    if (coveredTradeDate) {
      where += ' AND (trade_date IS NULL OR trade_date <= ?)';
      params.push(coveredTradeDate);
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
        FROM (
          SELECT o.observation_status
          FROM financial_entry_trigger_observations o
          WHERE o.symbol = financial_candidate_pool.symbol
            AND o.asset_type = financial_candidate_pool.asset_type
            AND o.source = financial_candidate_pool.source
          ORDER BY o.updated_at DESC, o.id DESC
          LIMIT 1
        ) latest_observation
        WHERE latest_observation.observation_status IN ('watching', 'plan_candidate', 'confirmed')
      )`;
    }

    let modelRecheckLatestBatchDate = '';
    let modelRecheckSqlTotalRow: any = null;
    if (reviewQueue === 'model_recheck') {
      const latestBatchRow = await db.get(
        `SELECT MAX(${MODEL_RECHECK_BATCH_DATE_SQL}) AS latest_batch_date
         FROM financial_candidate_pool
         ${where}`,
        [...params]
      );
      modelRecheckLatestBatchDate = String(latestBatchRow?.latest_batch_date || '');

      if (reviewScope === 'actionable') {
        if (modelRecheckLatestBatchDate) {
          where += ` AND ${MODEL_RECHECK_BATCH_DATE_SQL} = ?`;
          params.push(modelRecheckLatestBatchDate);
        }
        where += ` AND COALESCE(review_action, '') <> 'auto_model_recheck_settled'
          AND ${MODEL_RECHECK_NOT_HARD_BLOCKED_SQL}
          AND ${MODEL_RECHECK_SOFT_CONFLICT_SQL}`;
      } else if (reviewScope === 'data_gap') {
        where += ` AND COALESCE(review_action, '') <> 'auto_model_recheck_settled'
          AND ${MODEL_RECHECK_NOT_HARD_BLOCKED_SQL}
          AND ${MODEL_RECHECK_DATA_GAP_SQL}`;
      } else {
        where += ` AND COALESCE(review_action, '') <> 'auto_model_recheck_settled'
          AND ${MODEL_RECHECK_NOT_HARD_BLOCKED_SQL}
          AND (${MODEL_RECHECK_DATA_GAP_SQL} OR ${MODEL_RECHECK_SOFT_CONFLICT_SQL})`;
      }

      if (reviewScope === 'data_gap') {
        modelRecheckSqlTotalRow = await db.get(
          `SELECT COUNT(*) as total
           FROM financial_candidate_pool
           ${where}`,
          [...params]
        );
      }
    }

    const totalRow = reviewQueue === 'model_recheck'
      ? null
      : await db.get(
          `SELECT COUNT(*) as total
           FROM financial_candidate_pool
           ${where}`,
          [...params]
        );

    params.push(queryLimit, queryOffset);
    const candidatePageColumns = await getCandidatePoolLightSelectColumns(db);

    let items = await db.all(
      `WITH candidate_page AS (
         SELECT ${candidatePageColumns}
         FROM financial_candidate_pool
         ${where}
         ORDER BY priority_score DESC, last_checked_at DESC, trade_date DESC
         LIMIT ? OFFSET ?
       ),
       universe_stats AS (
         SELECT cp.symbol,
                cp.asset_type,
                cp.source,
                GROUP_CONCAT(DISTINCT u.universe_type) AS universe_type,
                MAX(u.last_fetch_at) AS local_last_fetch_at,
                GROUP_CONCAT(DISTINCT u.last_fetch_message) AS local_last_fetch_message
         FROM candidate_page cp
         LEFT JOIN financial_asset_universe u
           ON u.symbol = cp.symbol
          AND u.asset_type = cp.asset_type
          AND u.source = cp.source
         GROUP BY cp.symbol, cp.asset_type, cp.source
       ),
       daily_stats AS (
         SELECT cp.symbol,
                cp.asset_type,
                cp.source,
                MAX(p.trade_date) AS local_last_trade_date,
                MAX(p.updated_at) AS local_price_updated_at
         FROM candidate_page cp
         LEFT JOIN financial_daily_prices p
           ON p.symbol = cp.symbol
          AND p.asset_type = cp.asset_type
          AND p.source = cp.source
         GROUP BY cp.symbol, cp.asset_type, cp.source
       ),
       market_stats AS (
         SELECT cp.source,
                MAX(m.trade_date) AS market_latest_trade_date
         FROM (SELECT DISTINCT source FROM candidate_page) cp
         LEFT JOIN financial_daily_prices m
           ON m.source = cp.source
          AND m.symbol = '000300'
          AND m.asset_type = 'index'
         GROUP BY cp.source
       ),
       latest_entry_observations AS (
         SELECT *
         FROM (
           SELECT o.id,
                  o.symbol,
                  o.asset_type,
                  o.source,
                  o.observation_status,
                  o.action_label,
                  o.trigger_score,
                  o.trigger_reason,
                  o.updated_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY o.symbol, o.asset_type, o.source
                    ORDER BY o.updated_at DESC, o.id DESC
                  ) AS rn
           FROM financial_entry_trigger_observations o
         )
         WHERE rn = 1
       )
       SELECT cp.*,
              universe_stats.universe_type,
              daily_stats.local_last_trade_date,
              daily_stats.local_price_updated_at,
              universe_stats.local_last_fetch_at,
              universe_stats.local_last_fetch_message,
              market_stats.market_latest_trade_date,
              latest_entry_observations.id AS entry_observation_id,
              latest_entry_observations.observation_status AS entry_observation_status,
              latest_entry_observations.action_label AS entry_observation_action_label,
              latest_entry_observations.trigger_score AS entry_observation_trigger_score,
              latest_entry_observations.trigger_reason AS entry_observation_trigger_reason,
              latest_entry_observations.updated_at AS entry_observation_updated_at
       FROM candidate_page cp
       LEFT JOIN universe_stats
         ON universe_stats.symbol = cp.symbol
        AND universe_stats.asset_type = cp.asset_type
        AND universe_stats.source = cp.source
       LEFT JOIN daily_stats
         ON daily_stats.symbol = cp.symbol
        AND daily_stats.asset_type = cp.asset_type
        AND daily_stats.source = cp.source
       LEFT JOIN market_stats
         ON market_stats.source = cp.source
       LEFT JOIN latest_entry_observations
         ON latest_entry_observations.symbol = cp.symbol
        AND latest_entry_observations.asset_type = cp.asset_type
        AND latest_entry_observations.source = cp.source
       ORDER BY cp.priority_score DESC, cp.last_checked_at DESC, cp.trade_date DESC`,
      params
    );

    const shouldAttachModelScores = includeModel
      && ['active', 'expired', 'all'].includes(status)
      && !(reviewQueue === 'model_recheck' && reviewScope === 'data_gap');

    if (shouldAttachModelScores && items.length > 0) {
      try {
        const scoreLimit = reviewQueue === 'model_recheck'
          ? queryLimit
          : Math.min(offset + limit, 500);
        const scoreDomain = assetType && CANDIDATE_POOL_ASSET_TYPES.includes(assetType) ? assetType : null;
        const modelDomains = Array.from(new Set(
          (scoreDomain ? [scoreDomain] : items.map((item: any) => item.asset_type))
            .filter((domain: string) => CANDIDATE_POOL_ASSET_TYPES.includes(domain))
        ));
        const freshnessEntries = await Promise.all(
          modelDomains.map(async domain => [domain, await getCandidateModelFreshness(db, domain, coveredTradeDate)] as const)
        );
        const freshnessByDomain = new Map(freshnessEntries);
        const allRequestedModelsUnavailable = modelDomains.length > 0
          && modelDomains.every(domain => freshnessByDomain.get(domain)?.available === false);
        const persistedScoreMap = allRequestedModelsUnavailable
          ? {}
          : await loadPersistedCandidateScoreMap(db, items, coveredTradeDate);
        const scoreMap = allRequestedModelsUnavailable
          ? buildUnavailableCandidateScoreMap(items, freshnessByDomain)
          : hasCurrentPersistedScores(items, persistedScoreMap, coveredTradeDate)
          ? persistedScoreMap
          : await runCachedCandidateScoreWorker(
              scoreLimit,
              status === 'all' ? 'all' : status as 'active' | 'expired',
              coveredTradeDate,
              scoreDomain
            );
        items = items.map((item: any) => {
          const score = scoreMap[getCandidateScoreKey(item)];
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
      const latestBatchDate = modelRecheckLatestBatchDate || getLatestModelRecheckBatchDate(items);
      const summary = buildModelRecheckSummary(items, latestBatchDate);
      const visibleItems = items.filter((item: any) => isVisibleModelRecheckItem(item, reviewScope, latestBatchDate));
      const filteredTotal = reviewScope === 'data_gap'
        ? Number(modelRecheckSqlTotalRow?.total || visibleItems.length)
        : visibleItems.length;
      if (reviewScope === 'data_gap') {
        summary.data_gap = filteredTotal;
        summary.all = Math.max(summary.all, filteredTotal);
      }
      items = reviewScope === 'data_gap'
        ? visibleItems
        : visibleItems.slice(offset, offset + limit);
      items = items.map((item: any) => ({
        ...hydrateCandidateItem(item),
        model_recheck_bucket: getModelRecheckBucket(item),
        model_recheck_data_gap: hasModelRecheckDataGap(item) ? 1 : 0
      })).map((item: any) => compactModelRecheckListItem(item));

      return res.json({
        success: true,
        data: {
          items,
          total: filteredTotal,
          limit,
          offset,
          covered_trade_date: coveredTradeDate,
          review_scope: reviewScope,
          latest_batch_date: latestBatchDate,
          summary
        }
      });
    }

    items = items.map((item: any) => compactCandidatePoolListItem(hydrateCandidateItem(item)));

    res.json({
      success: true,
      data: {
        items,
        total: Number(totalRow?.total || 0),
        limit,
        offset,
        covered_trade_date: coveredTradeDate
      }
    });
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

    const marketGateBlocker = await getFinanceMarketGateBlocker(db, source);
    if (marketGateBlocker) {
      return res.status(423).json({
        success: false,
        message: marketGateBlocker.message,
        data: {
          market_gate: marketGateBlocker.marketGate,
          downstream_blocked: true
        }
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
    const stockIndustryStrengthContext = assetType === 'stock'
      ? await buildStockIndustryStrengthContext(db)
      : undefined;
    const evaluation: any = await evaluateCandidate(db, symbol, assetType, source, industryStrengthContext, stockIndustryStrengthContext);
    const hardBlockedFromModelRecheck = isHardBlockedFromModelRecheck(evaluation);
    const scanSeed = getCandidateScanSeedStatus(evaluation.trend_phase);

    if (evaluation.selected || evaluation.watch_only) {
      await upsertCandidate(db, evaluation);
      if (evaluation.watch_only) {
        await markCandidateAsWatchOnly(db, evaluation);
      }
      if (previousCandidate?.pool_status === 'expired') {
        const now = new Date().toISOString();
        await db.run(
          `UPDATE financial_candidate_pool
           SET review_status = ?,
               final_status = 'WAIT',
               last_review_id = NULL,
               last_review_at = ?,
               review_action = ?,
               updated_at = ?
           WHERE symbol = ?
             AND asset_type = ?
             AND source = ?
             AND rule_version = ?`,
          [
            evaluation.watch_only ? 'structure_watch' : scanSeed.reviewStatus,
            now,
            evaluation.watch_only ? 'early_mainline_watch' : (scanSeed.reviewAction || 'reentered_from_excluded_recheck'),
            now,
            symbol,
            assetType,
            source,
            CANDIDATE_RULE_VERSION
          ]
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
              key: scanSeed.reviewStatus === 'structure_pending'
                ? 'structure_queue'
                : scanSeed.reviewStatus === 'trend_blocked'
                  ? 'trend_phase'
                  : 'candidate_pool',
              label: scanSeed.reviewStatus === 'structure_pending'
                ? '单标的判断 / 待判断'
                : scanSeed.reviewStatus === 'trend_blocked'
                  ? '走势阶段 / 留队观察'
                  : `${assetType === 'etf' ? 'ETF备选池' : '个股备选池'} / 待走势补算`,
              status: 'active',
              review_status: scanSeed.reviewStatus
            }
          : evaluation.watch_only
          ? {
              key: 'candidate_pool',
              label: `${assetType === 'etf' ? 'ETF备选池' : '个股备选池'} / 早期主线观察`,
              status: 'active',
              review_status: 'structure_watch'
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

    const candidateColumns = await getCandidatePoolLightSelectColumns(db, 'c');
    const rows = await db.all(
      `SELECT ${candidateColumns},
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

    const marketGateBlocker = await getFinanceMarketGateBlocker(db, candidate.source || 'tushare');
    if (marketGateBlocker) {
      return res.status(423).json({
        success: false,
        message: marketGateBlocker.message,
        data: {
          market_gate: marketGateBlocker.marketGate,
          downstream_blocked: true
        }
      });
    }

    const industryStrengthContext = candidate.asset_type === 'etf'
      ? await buildIndustryEtfStrengthContext(db, { scope: 'focus', benchmarkSymbol: '000300' })
      : undefined;
    const stockIndustryStrengthContext = candidate.asset_type === 'stock'
      ? await buildStockIndustryStrengthContext(db)
      : undefined;
    const evaluation = await evaluateCandidate(db, candidate.symbol, candidate.asset_type, candidate.source, industryStrengthContext, stockIndustryStrengthContext);
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
    const minTradeDate = String(req.body.min_trade_date || req.body.minTradeDate || '').trim();
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

    const marketGateBlocker = await getFinanceMarketGateBlocker(db, source);
    if (marketGateBlocker) {
      return res.status(423).json({
        success: false,
        message: marketGateBlocker.message,
        data: {
          market_gate: marketGateBlocker.marketGate,
          downstream_blocked: true,
          checked_count: 0,
          selected_count: 0,
          result_count: 0,
          results: []
        }
      });
    }

    const latestCoveredTradeDate = await getLatestCoveredTradeDate(db, {
      source,
      assetTypes: assetType ? [assetType, 'index'] : ['stock', 'etf', 'index']
    });
    const effectiveMinTradeDate = minTradeDate || latestCoveredTradeDate || '';
    let staleExpiredCount = 0;

    if (effectiveMinTradeDate && !limit && universeType === 'all') {
      const now = new Date().toISOString();
      const staleAssetClause = assetType ? `asset_type = ?` : `asset_type IN ('stock', 'etf')`;
      const staleParams = assetType
        ? [effectiveMinTradeDate, effectiveMinTradeDate, now, now, now, source, assetType, effectiveMinTradeDate]
        : [effectiveMinTradeDate, effectiveMinTradeDate, now, now, now, source, effectiveMinTradeDate];
      const staleResult = await db.run(
        `UPDATE financial_candidate_pool
         SET pool_status = 'expired',
             final_status = 'REJECTED',
             review_status = 'rejected',
             review_action = CASE
               WHEN COALESCE(review_action, '') = '' THEN 'stale_trade_date_expired'
               ELSE review_action
             END,
             candidate_reason = '行情覆盖日已到 ' || ? || '，本候选仍停留在旧交易日，先沉淀过期，等待本轮扫描重新带回。',
             forbidden_reason = '行情覆盖日已到 ' || ? || '，本候选仍停留在旧交易日，禁止继续占用 active 队列。',
             first_blocking_gate_key = 'data_freshness_gate',
             first_blocking_gate_label = '行情日滞后',
             blocking_gate_labels = '行情日滞后',
             last_checked_at = ?,
             last_review_at = ?,
             updated_at = ?
         WHERE pool_status = 'active'
           AND source = ?
           AND ${staleAssetClause}
           AND COALESCE(trade_date, '') < ?`,
        staleParams
      );
      staleExpiredCount = Number(staleResult?.changes || 0);
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
    if (effectiveMinTradeDate) {
      where += ` AND COALESCE(last_trade_date, '') >= ?`;
      params.push(effectiveMinTradeDate);
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
    const stockIndustryStrengthContext = (!assetType || assetType === 'stock')
      ? await buildStockIndustryStrengthContext(db, { asOfTradeDate: effectiveMinTradeDate || null })
      : undefined;
    const results = [];
    const evaluations: any[] = [];
    let selectedCount = 0;

    for (const asset of assets) {
      const evaluation: any = await evaluateCandidate(db, asset.symbol, asset.asset_type, asset.source, industryStrengthContext, stockIndustryStrengthContext);
      evaluations.push(evaluation);

      if (evaluation.selected || evaluation.watch_only) {
        await upsertCandidate(db, evaluation, asset.name || '');
        if (evaluation.watch_only) {
          await markCandidateAsWatchOnly(db, evaluation);
        }
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
        watch_only: Boolean(evaluation.watch_only),
        industry_strength: evaluation.industry_strength || null,
        reason: evaluation.candidate_reason || evaluation.reason,
        gate_trace: evaluation.gate_trace || null,
        first_blocking_gate: evaluation.gate_trace?.first_blocking_gate || null,
        blocking_gates: evaluation.gate_trace?.blocking_gates || [],
        first_blocking_gate_label: evaluation.first_blocking_gate_label || null,
        blocking_gate_labels: evaluation.blocking_gate_labels || null
      });
    }

    const exposureDedupe = (!limit && universeType === 'all' && (!assetType || assetType === 'etf'))
      ? await dedupeActiveEtfExposureCandidates(db, { source, minTradeDate: effectiveMinTradeDate || null })
      : { expired_count: 0, groups: [] };
    const selectedAfterDedupe = Math.max(0, selectedCount - Number(exposureDedupe.expired_count || 0));

    const rawCount = rawCountResult?.total || assets.length;
    const dedupedTotal = dedupedCountResult?.total || assets.length;
    const duplicateCount = Math.max(0, rawCount - dedupedTotal);
    const uncheckedCount = Math.max(0, dedupedTotal - assets.length);

    const scanScopeText = [
      limit ? `限制检查 ${limit} 个` : '全量检查',
      effectiveMinTradeDate ? `最新交易日不早于 ${effectiveMinTradeDate}` : ''
    ].filter(Boolean).join('，');
    const responseResults = results.length <= 500
      ? results
      : [
          ...results.filter(item => item.selected),
          ...results.filter(item => !item.selected).slice(0, 200)
        ];

    const selectedMessage = assetType === 'etf'
      ? `${selectedAfterDedupe} 个进入权益主升ETF池`
      : `${selectedAfterDedupe} 个进入备选池`;

    res.json({
      success: true,
      message: `扫描完成：${scanScopeText}，实际检查 ${assets.length} 个${assetType ? ` ${assetType}` : ''}唯一资产，${selectedMessage}${staleExpiredCount ? `，沉淀旧交易日 active ${staleExpiredCount} 个` : ''}${exposureDedupe.expired_count ? `，ETF同类敞口去重 ${exposureDedupe.expired_count} 个` : ''}（匹配分组 ${rawCount} 条，去重后 ${dedupedTotal} 个，重复 ${duplicateCount} 条，未检查 ${uncheckedCount} 个）`,
      data: {
        checked_count: assets.length,
        raw_count: rawCount,
        deduped_count: dedupedTotal,
        deduped_total: dedupedTotal,
        duplicate_count: duplicateCount,
        unchecked_count: uncheckedCount,
        min_trade_date: effectiveMinTradeDate || null,
        stale_expired_count: staleExpiredCount,
        selected_count: selectedCount,
        selected_after_exposure_dedupe: selectedAfterDedupe,
        etf_exposure_dedupe: exposureDedupe,
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

router.get('/candidate-pool/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureCandidateReviewSchema(db);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '无效的备选池ID' });
    }

    const item = await db.get(
      `SELECT *
       FROM financial_candidate_pool
       WHERE id = ?
         AND rule_version = ?
       LIMIT 1`,
      [id, CANDIDATE_RULE_VERSION]
    );

    if (!item) {
      return res.status(404).json({ success: false, message: '备选池标的不存在' });
    }

    res.json({
      success: true,
      data: {
        item: {
          ...hydrateCandidateItem(item, { includeGateTrace: true }),
          flow_timeline: await buildCandidateFlowTimeline(db, item)
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `获取备选池详情失败: ${(error as Error).message}`
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

    const marketGateBlocker = await getFinanceMarketGateBlocker(db, item.source || 'tushare');
    if (marketGateBlocker) {
      return res.status(423).json({
        success: false,
        message: marketGateBlocker.message,
        data: {
          market_gate: marketGateBlocker.marketGate,
          downstream_blocked: true
        }
      });
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
      const coveredTradeDate = CANDIDATE_POOL_ASSET_TYPES.includes(item.asset_type)
        ? await getLatestCoveredTradeDate(db, { assetTypes: [item.asset_type] })
        : null;
      const scoreMap = await runCandidateScoreWorker(1, 'all', coveredTradeDate, item.asset_type, item.symbol);
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
      [reviewId, now, 'model_review_draft_created', now, id]
    );

    draft.review_id = reviewId || null;
    draft.review_status = { key: 'drafted', label: getReviewStatusLabel('drafted') };
    draft.candidate = {
      ...draft.candidate,
      review_status: 'drafted',
      last_review_id: reviewId || null,
      last_review_at: now,
      review_action: 'model_review_draft_created'
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

    const item = await db.get(`SELECT source, last_review_id FROM financial_candidate_pool WHERE id = ?`, [id]);
    if (!item) {
      return res.status(404).json({ success: false, message: '候选标的不存在' });
    }

    if (isCandidateReviewStatusFlowAdvancing(status)) {
      const marketGateBlocker = await getFinanceMarketGateBlocker(db, item.source || 'tushare');
      if (marketGateBlocker) {
        return res.status(423).json({
          success: false,
          message: marketGateBlocker.message,
          data: {
            market_gate: marketGateBlocker.marketGate,
            downstream_blocked: true
          }
        });
      }
    }

    const now = new Date().toISOString();
    await db.run(
      `UPDATE financial_candidate_pool
       SET review_status = ?, updated_at = ?
       WHERE id = ?`,
      [status, now, id]
    );

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

    const item = await db.get(`SELECT source FROM financial_candidate_pool WHERE id = ?`, [id]);
    if (!item) {
      return res.status(404).json({ success: false, message: '候选标的不存在' });
    }

    if (isCandidatePoolStatusFlowAdvancing(status)) {
      const marketGateBlocker = await getFinanceMarketGateBlocker(db, item.source || 'tushare');
      if (marketGateBlocker) {
        return res.status(423).json({
          success: false,
          message: marketGateBlocker.message,
          data: {
            market_gate: marketGateBlocker.marketGate,
            downstream_blocked: true
          }
        });
      }
    }

    const now = new Date().toISOString();
    await db.run(
      `UPDATE financial_candidate_pool
       SET pool_status = ?,
           final_status = CASE
             WHEN ? IN ('expired', 'ignored') THEN 'REJECTED'
             WHEN ? = 'planned' THEN 'READY_FOR_PLAN'
             WHEN ? = 'active' AND COALESCE(review_status, '') = 'plan_ready' THEN 'READY_FOR_PLAN'
             WHEN ? = 'active' THEN 'WAIT'
             ELSE final_status
           END,
           review_status = CASE
             WHEN ? IN ('expired', 'ignored') THEN 'rejected'
             ELSE review_status
           END,
           review_action = CASE
             WHEN ? IN ('expired', 'ignored') THEN 'manual_status_update'
             ELSE review_action
           END,
           updated_at = ?
       WHERE id = ?`,
      [status, status, status, status, status, status, status, now, id]
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
