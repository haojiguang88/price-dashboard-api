import express, { Request, Response } from 'express';
import getDb, { getDatabasePath } from '../config/database';
import { exec, execFile } from 'child_process';
import path from 'path';
import {
  calculateProfileInvalidationLine,
  getFinancePlanProfileConfig,
  getFinanceStructureProfileConfig,
  resolveFinancePlanProfile
} from '../services/financePlanProfile';
import { buildFinancePlanQuality } from '../services/financePlanQuality';
import { recordSignalLifecycleCheck } from '../services/financeSignalLifecycle';
import { getFreshMarketRegime } from '../utils/financeMarketRegime';

const router = express.Router();
const TREND_PHASE_VERSION = 'trend_phase_v1.1';
const CANDIDATE_RULE_VERSION = 'candidate_pool_v1';
const ENTRY_READY_TREND_PHASES = new Set(['BREAKOUT', 'SLOW_GRIND_UP', 'RECOVERY']);
const ENTRY_HARD_BLOCK_TREND_PHASES = new Set(['REBOUND', 'SLOW_BLEED', 'CRASH_DROP']);
const ENTRY_TREND_PRIORITY: Record<string, number> = {
  SLOW_GRIND_UP: 0,
  BREAKOUT: 1,
  RECOVERY: 2
};
type EntryObservationScope = 'actionable' | 'risk_priority_recheck' | 'watching' | 'confirmed' | 'invalidated' | 'returned' | 'resolved' | 'all';
const TRAINING_ROOT = process.env.MODEL_TRAINING_ROOT || '/Volumes/7100/model-training';
const TRAINING_PYTHON = process.env.MODEL_TRAINING_PYTHON || path.join(TRAINING_ROOT, 'venv', 'bin', 'python');
let entryTriggerObservationSchemaReady = false;

interface DailyPrice {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

interface SourceStatus {
  source: string;
  total_count: number;
  first_trade_date: string | null;
  last_trade_date: string | null;
  last_updated: string | null;
  has_enough_60: boolean;
  has_enough_120: boolean;
}

interface AssetDataStatus {
  symbol: string;
  preferred_source: string;
  sources: SourceStatus[];
}

type OpportunityTypeCode = 'DEFENSIVE' | 'REPAIR' | 'TREND' | 'EMOTIONAL' | 'NOT_APPLICABLE';

interface OpportunityTypeTag {
  code: OpportunityTypeCode;
  label: string;
  tone: 'neutral' | 'warn' | 'good';
  reason: string;
}

interface StructureCheckResult {
  symbol: string;
  name: string;
  asset_type: string;
  trade_date: string;
  close: number;
  ma20: number;
  ma60: number;
  ma120: number;
  ma60_prev: number;
  ma60_slope: string;
  distance_to_ma60: number;
  above_ma60_days: number;
  below_ma60_days: number;
  low_20: number | null;
  low_60: number | null;
  high_60: number | null;
  drawdown_20: number | null;
  drawdown_60: number | null;
  structure_status: string;
  structure_reason: string;
  safe_zone_status: string;
  safe_zone_reason: string;
  invalidation_line: number;
  market_regime: string;
  entry_permission: string;
  trend_phase_code?: string | null;
  trend_phase_reason?: string | null;
  trend_action?: string;
  trend_action_reason?: string;
  final_status: string;
  final_reason: string;
  data_source_used: string;
  available_sources: string[];
  structure_score?: StructureScoreResult;
  opportunity_type?: OpportunityTypeTag;
}

async function ensureEntryTriggerObservationSchema(db: any) {
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

function isEntryMarketGateOpen(entryPermission?: string | null) {
  return entryPermission === 'ALLOW_STRUCTURE_CHECK';
}

function getEntryMarketGateBlockReason(marketGate: any) {
  if (marketGate?.stale) return marketGate.freshness_reason;
  return marketGate?.entry_reason
    || marketGate?.result_reason
    || marketGate?.freshness_reason
    || '市场总闸未开放单标的结构判断。';
}

async function getEntryMarketGateBlocker(db: any, source: string) {
  const marketGate = await getFreshMarketRegime(db, { source });
  if (isEntryMarketGateOpen(marketGate?.entry_permission)) return null;
  return {
    marketGate,
    message: `市场总闸未通过，禁止推进单标的判断/入场触发；本轮不修改入场观察和候选池状态：${getEntryMarketGateBlockReason(marketGate)}`
  };
}

function isEntrySnapshotBlockedByMarketGate(snapshot: any) {
  return snapshot?.action === 'BLOCKED' && !isEntryMarketGateOpen(snapshot?.entry_permission);
}

function isEntrySnapshotInvalidated(snapshot: any) {
  if (isEntrySnapshotBlockedByMarketGate(snapshot)) return false;
  return snapshot?.action === 'BLOCKED'
    || snapshot?.action === 'INVALIDATED'
    || snapshot?.structure_status === 'STRUCTURE_BROKEN'
    || (snapshot?.close && snapshot?.invalidation_line && snapshot.close < snapshot.invalidation_line);
}

function getTrendPhaseLabel(code?: string | null): string {
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
    default: return code || '状态未确认';
  }
}

function getEntryTrendPriority(code?: string | null): number {
  return ENTRY_TREND_PRIORITY[code || ''] ?? 9;
}

function getEntryManualPriorityLevel(
  trendPhaseCode: string | null | undefined,
  triggerScore: number,
  structureScore: number,
  maxLossPercent: number | null,
  planProfileKey?: string | null
) {
  const profile = getFinancePlanProfileConfig(planProfileKey);
  if (!ENTRY_READY_TREND_PHASES.has(trendPhaseCode || '')) return 'OBSERVE';
  const riskOk = maxLossPercent !== null && maxLossPercent <= profile.maxRiskPercent;
  const riskTight = maxLossPercent !== null && maxLossPercent <= profile.tightRiskPercent;

  if (trendPhaseCode === 'SLOW_GRIND_UP' && triggerScore >= 75 && structureScore >= 75 && riskTight) {
    return 'A';
  }
  if (triggerScore >= 80 && structureScore >= 75 && riskOk) {
    return 'A';
  }
  if (trendPhaseCode === 'BREAKOUT' && triggerScore >= 70 && structureScore >= 75 && riskOk) {
    return 'A';
  }
  if (trendPhaseCode === 'SLOW_GRIND_UP' && triggerScore >= 55 && structureScore >= 70) {
    return 'B';
  }
  if (trendPhaseCode === 'RECOVERY' && triggerScore >= 70 && structureScore >= 70 && riskOk) {
    return 'B';
  }
  if (triggerScore >= 60 && structureScore >= 70) {
    return 'B';
  }
  return 'C';
}

function resolveCandidateStatusAfterEntryScan(snapshot: any, invalidated: boolean, canUpgrade: boolean) {
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

function signalLifecycleAllowsPlan(lifecycle: any) {
  return ['mature_plan', 'stable_plan'].includes(String(lifecycle?.maturity_status || ''));
}

function applySignalLifecycleGate(decision: any, lifecycle: any, rawCanUpgrade: boolean, invalidated: boolean) {
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

function getEntryManualPriorityScore(
  trendPhaseCode: string | null | undefined,
  triggerScore: number,
  structureScore: number,
  maxLossPercent: number | null,
  planProfileKey?: string | null
) {
  const profile = getFinancePlanProfileConfig(planProfileKey);
  const level = getEntryManualPriorityLevel(trendPhaseCode, triggerScore, structureScore, maxLossPercent, planProfileKey);
  const levelScore = level === 'A' ? 300 : level === 'B' ? 200 : level === 'C' ? 100 : 0;
  const trendScore = Math.max(0, 30 - getEntryTrendPriority(trendPhaseCode) * 10);
  const riskScore = maxLossPercent === null ? 0 : Math.max(0, Math.round((profile.maxRiskPercent - Math.min(maxLossPercent, profile.maxRiskPercent)) * 1000));
  return levelScore + trendScore + Math.round(triggerScore || 0) + Math.round((structureScore || 0) / 2) + riskScore;
}

function getPriorHigh(prices: DailyPrice[], days: number): number | null {
  const priorPrices = prices.slice(0, -1).slice(-days);
  const highs = priorPrices.map((price) => Number(price.high)).filter(Number.isFinite);
  if (highs.length === 0) return null;
  return Math.max(...highs);
}

async function buildPlanReadyValueMetrics(
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

function getTrendAction(
  trendPhaseCode: string | null | undefined,
  structureScore: StructureScoreResult,
  structure: ReturnType<typeof calculateStructure>
): { action: string; reason: string } {
  if (structureScore.metrics.is_invalidated || structure.structure_status === 'STRUCTURE_BROKEN') {
    return {
      action: 'BLOCK',
      reason: '结构已失效，走势阶段只作记录，不进入后续流程。'
    };
  }

  switch (trendPhaseCode) {
    case 'SLOW_GRIND_UP':
      if (structureScore.score >= 75 && structure.safe_zone_status === 'SAFE_ZONE') {
        return { action: 'HIGH_PRIORITY', reason: '慢涨 + 安全区 + 结构分较高，可优先进入入场触发观察。' };
      }
      return { action: 'WATCH', reason: '慢涨阶段但结构分或安全区不足，继续观察。' };
    case 'BREAKOUT':
      return { action: structureScore.score >= 70 ? 'HIGH_PRIORITY' : 'WATCH', reason: '突破阶段优先看回踩是否不破，满足后再进入入场触发。' };
    case 'RECOVERY':
      return { action: structureScore.score >= 65 ? 'MEDIUM_HIGH_PRIORITY' : 'WATCH', reason: '修复阶段适合观察结构能否刚成立，不直接追。' };
    case 'TREND_UP':
      return { action: 'WATCH', reason: '趋势上行但波动高于慢涨标准，先观察回踩是否稳定，不直接提高到入场优先。' };
    case 'TREND_TRANSITION':
    case 'CONSOLIDATION':
    case 'SIDEWAYS':
      return { action: 'WATCH', reason: '走势仍偏观察，等待方向确认或触发条件出现。' };
    case 'SURGE':
      return { action: 'WAIT_PULLBACK', reason: '急涨阶段不追，等待回踩 MA20/MA60 或平台确认。' };
    case 'HIGH_BASE':
      return { action: 'LOWER_PRIORITY', reason: '高位横盘降低优先级，重点防止高位假突破。' };
    case 'REBOUND':
    case 'SLOW_BLEED':
    case 'CRASH_DROP':
      return { action: 'BLOCK', reason: `${getTrendPhaseLabel(trendPhaseCode)}阶段不进入买入计划，只保留观察。` };
    default:
      return { action: 'WATCH', reason: '走势阶段未确认，先按观察处理。' };
  }
}

async function getModelPrediction(
  db: any,
  symbol: string,
  assetType: string,
  context: 'structure' | 'entry_trigger'
) {
  if (!['stock', 'etf'].includes(assetType)) {
    return null;
  }

  const feedback = await db.get(
    `SELECT *
     FROM model_training_strategy_feedback
     WHERE domain = ?
     LIMIT 1`,
    [assetType]
  );
  if (!feedback) {
    return null;
  }
  if (context === 'structure' && !feedback.enabled_for_structure) {
    return null;
  }
  if (context === 'entry_trigger' && !feedback.enabled_for_entry_trigger) {
    return null;
  }

  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'predict.py');
  const dbPath = getDatabasePath();
  const latestLocalPrice = await db.get(
    `SELECT MAX(trade_date) AS latest_trade_date
     FROM financial_daily_prices
     WHERE symbol = ?
       AND asset_type = ?
       AND source = 'tushare'
       AND close IS NOT NULL
       AND close > 0`,
    [symbol, assetType]
  );
  const latestLocalTradeDate = latestLocalPrice?.latest_trade_date || null;
  const args = [
    scriptPath,
    '--db',
    dbPath,
    '--domain',
    assetType,
    '--symbol',
    symbol,
    '--model-key',
    feedback.default_model_key
  ];
  if (latestLocalTradeDate) {
    args.push('--trade-date', latestLocalTradeDate);
  }

  const buildUnavailablePrediction = (reason: string, options: { stale?: boolean; modelTradeDate?: string | null } = {}) => {
    const isStale = Boolean(options.stale) || /特征库滞后|特征日|落后/.test(reason);
    const domainLabel = assetType === 'etf' ? 'ETF' : '个股';
    const featureTradeDate = options.modelTradeDate || null;
    return {
      available: false,
      stale: isStale,
      mode: feedback.mode,
      tradeDate: featureTradeDate,
      latestTradeDate: latestLocalTradeDate,
      error: reason,
      note: isStale
        ? `模型辅助层特征滞后，已阻止使用旧特征预测；原结构规则照常生效。`
        : '模型辅助层暂不可用，原结构规则照常生效。',
      remediation: {
        code: isStale ? 'MODEL_FEATURE_STALE' : 'MODEL_PREDICTION_UNAVAILABLE',
        title: isStale ? `${domainLabel}模型特征需要刷新` : `${domainLabel}模型预测需要检查`,
        reason: isStale
          ? `当前本地日线口径 ${latestLocalTradeDate || '--'}，模型特征口径 ${featureTradeDate || '未知'}，不能用旧特征参与判断。`
          : reason,
        featureTradeDate,
        latestTradeDate: latestLocalTradeDate,
        actions: [
          {
            label: '运行金融日终流水线',
            path: '/finance',
            description: '先刷新行情、模型特征和候选模型分数，让单标的页重新读取同一口径。'
          },
          {
            label: `检查${domainLabel}模型训练`,
            path: `/model-training/${assetType}`,
            description: '查看特征库、训练产物和启用模型；必要时重训或同步候选评分。'
          }
        ]
      }
    };
  };

  const parsePredictionPayload = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch (_error) {
      return null;
    }
  };

  return new Promise((resolve) => {
    execFile(
      TRAINING_PYTHON,
      args,
      { timeout: 30000 },
      (error, stdout) => {
        if (error) {
          const payload = parsePredictionPayload(stdout || '');
          const reason = payload?.message || error.message;
          resolve(buildUnavailablePrediction(reason, {
            stale: /特征库滞后|特征日|落后/.test(reason),
            modelTradeDate: payload?.data?.tradeDate
              || payload?.data?.trade_date
              || payload?.data?.latestFeatureTradeDate
              || payload?.data?.asOfTradeDate
              || null
          }));
          return;
        }
        try {
          const payload = parsePredictionPayload(stdout || '');
          if (!payload) {
            throw new Error('模型预测输出为空或不是 JSON');
          }
          if (!payload.success) {
            resolve(buildUnavailablePrediction(payload.message || '模型预测失败'));
            return;
          }
          const modelTradeDate = payload.data?.tradeDate
            || payload.data?.trade_date
            || payload.data?.latestFeatureTradeDate
            || payload.data?.asOfTradeDate
            || null;
          if (modelTradeDate && latestLocalTradeDate && String(modelTradeDate) < String(latestLocalTradeDate)) {
            resolve(buildUnavailablePrediction(
              `模型辅助层日期 ${modelTradeDate} 落后本地日线 ${latestLocalTradeDate}。`,
              { stale: true, modelTradeDate }
            ));
            return;
          }
          resolve({
            available: true,
            mode: feedback.mode,
            high_probability_threshold: feedback.high_probability_threshold,
            low_probability_threshold: feedback.low_probability_threshold,
            note: feedback.note,
            ...payload.data
          });
        } catch (parseError) {
          resolve(buildUnavailablePrediction(`模型预测结果解析失败：${(parseError as Error).message}`));
        }
      }
    );
  });
}

interface StructureScoreDetail {
  label: string;
  score: number;
  max_score: number;
  status: 'good' | 'neutral' | 'bad';
  reason: string;
}

interface StructureScoreResult {
  score: number;
  level: 'STRONG' | 'GOOD' | 'WATCH' | 'WEAK' | 'BROKEN';
  level_label: string;
  conclusion: string;
  details: StructureScoreDetail[];
  penalty_reasons: string[];
  metrics: {
    ma20_slope: 'up' | 'flat' | 'down' | 'unknown';
    ma60_slope: 'up' | 'flat' | 'down' | 'unknown';
    max_drawdown_20: number | null;
    amplitude_20: number | null;
    box_position: 'lower' | 'middle' | 'upper' | 'unknown';
    box_position_ratio: number | null;
    has_breakout_pullback: boolean;
    is_invalidated: boolean;
  };
}

function toNullableNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function parseJson(value: unknown, fallback: any = null) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function entryObservationKey(row: any) {
  return `${row.symbol || ''}|${row.asset_type || ''}|${row.source || ''}`;
}

async function loadLatestSignalLifecycleMap(db: any, rows: any[]) {
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

function buildEntryObservationQueueInfo(item: any, snapshot: any, lifecycle: any) {
  const status = String(item.observation_status || '');
  const rawAction = String(snapshot?.action || item.entry_action || '');
  const maturityStatus = String(lifecycle?.maturity_status || '');
  const maturityLabel = lifecycle?.maturity_label || maturityStatus || null;
  const consecutiveValidDays = Number(lifecycle?.consecutive_valid_days || 0);
  const triggerScore = Number(item.trigger_score || snapshot?.trigger_score || 0);
  const structureScore = Number(item.structure_score || snapshot?.structure_score?.score || snapshot?.structure_score || 0);
  const manualReviewAction = String(item.manual_review_action || '');
  const manualReviewLabel = item.manual_review_label || '';
  const manualReviewNote = item.manual_review_note || '';
  const close = Number(item.close_price ?? snapshot?.close ?? snapshot?.close_price);
  const invalidationLine = Number(item.invalidation_line ?? snapshot?.invalidation_line);
  const maxLossPercent = Number.isFinite(close) && close > 0 && Number.isFinite(invalidationLine) && invalidationLine > 0
    ? Math.max(0, (close - invalidationLine) / close)
    : null;
  const rawReadyToPlan = rawAction === 'READY_TO_PLAN';
  const highTriggerRiskReview = rawReadyToPlan
    && triggerScore >= 80
    && structureScore >= 75
    && (maxLossPercent === null || maxLossPercent <= 0.06);
  const needsHighTriggerRiskReview = highTriggerRiskReview && !['continue_observe', 'return_risk_hold'].includes(manualReviewAction);

  let bucket = 'waiting_trigger';
  let label = '继续观察触发';
  let recommendation = 'continue_observe';
  let reason = item.trigger_reason || '等待触发条件继续确认。';

  if (['confirmed', 'plan_candidate'].includes(status)) {
    bucket = 'plan_ready';
    label = '计划准备池';
    recommendation = 'manual_create_trade_plan';
    reason = '入场触发已确认，可进入计划准备；生成正式计划和金额仍需人工确认。';
  } else if (status === 'watching' && rawReadyToPlan) {
    if (['mature_plan', 'stable_plan'].includes(maturityStatus)) {
      bucket = 'ready_to_plan';
      label = '应进计划准备';
      recommendation = 'auto_advance_to_plan_ready';
      reason = `${maturityLabel || '生命周期已成熟'}，且触发分 ${triggerScore} / 结构分 ${structureScore}，应由自动流程推进到计划准备池。`;
    } else if (['face_slap_zone', 'short_lived_signal', 'invalidation_watch', 'invalidated'].includes(maturityStatus)) {
      if (maturityStatus === 'face_slap_zone' && highTriggerRiskReview) {
        if (manualReviewAction === 'return_risk_hold') {
          bucket = 'risk_hold';
          label = manualReviewLabel || '人工退回风险观察';
          recommendation = 'continue_risk_observe';
          reason = `人工复核已退回风险观察：${manualReviewNote || '生命周期仍有真实翻转，先不占高触发优先位。'}`;
        } else if (manualReviewAction === 'continue_observe') {
          bucket = 'lifecycle_recheck';
          label = manualReviewLabel || '人工继续观察';
          recommendation = 'continue_lifecycle_recheck';
          reason = `人工复核选择继续观察：${manualReviewNote || '保留观察记录，等待后续自动流水线重新确认。'}`;
        } else {
          bucket = 'risk_priority_recheck';
          label = manualReviewAction === 'wait_next_day' ? (manualReviewLabel || '等下一日确认') : '高触发复核';
          recommendation = manualReviewAction === 'wait_next_day' ? 'wait_next_day_recheck' : 'manual_risk_recheck';
          reason = manualReviewAction === 'wait_next_day'
            ? `人工复核选择等下一日确认：${manualReviewNote || '今天不进计划，下一交易日继续优先复核。'}`
            : `${maturityLabel || '扇脸区'}，但触发分 ${triggerScore} / 结构分 ${structureScore} 较高，失效线距离${maxLossPercent !== null ? ` ${(maxLossPercent * 100).toFixed(1)}%` : '可控'}；不自动进计划，建议优先人工复核是否继续观察或等待下一日确认。`;
        }
      } else {
        bucket = 'risk_hold';
        label = maturityStatus === 'face_slap_zone' ? '扇脸风险观察' : '风险观察';
        recommendation = 'continue_risk_observe';
        reason = `${maturityLabel || '生命周期风险'}，虽然触发条件满足，但历史复核不稳定，先不推进计划准备。`;
      }
    } else if (maturityStatus === 'rechecking') {
      bucket = 'lifecycle_recheck';
      label = '已触发待复核';
      recommendation = 'continue_lifecycle_recheck';
      reason = `触发条件已满足，但生命周期只有连续 ${consecutiveValidDays} 天有效；需要至少 3 天稳定后再进计划准备。`;
    } else {
      bucket = 'lifecycle_recheck';
      label = '新触发待复核';
      recommendation = 'continue_lifecycle_recheck';
      reason = '触发条件刚满足，先观察生命周期是否连续有效，避免当天假触发直接进计划。';
    }
  } else if (status === 'watching' && rawAction === 'WAIT_PULLBACK') {
    bucket = 'wait_pullback';
    label = '等待回踩';
    recommendation = 'continue_wait_pullback';
    reason = item.trigger_reason || '位置不在安全触发区，继续等待回踩确认。';
  } else if (status === 'watching') {
    bucket = 'waiting_trigger';
    label = '触发未完成';
    recommendation = 'continue_wait_trigger';
    reason = item.trigger_reason || '结构仍可观察，但入场触发条件还不完整。';
  } else if (['invalidated', 'returned', 'planned'].includes(status)) {
    bucket = 'resolved';
    label = status === 'invalidated' ? '已失效' : status === 'planned' ? '已建计划' : '已退回';
    recommendation = 'resolved';
    reason = item.note || item.trigger_reason || '该记录已归档。';
  }

  return {
    observation_queue_bucket: bucket,
    observation_queue_label: label,
    observation_queue_reason: reason,
    observation_queue_recommendation: recommendation,
    raw_entry_action: rawAction || null,
    lifecycle_status: maturityStatus || null,
    lifecycle_label: maturityLabel,
    lifecycle_check_count: lifecycle?.check_count ?? null,
    lifecycle_consecutive_valid_days: lifecycle?.consecutive_valid_days ?? null,
    lifecycle_valid_check_count: lifecycle?.valid_check_count ?? null,
    lifecycle_flip_count: lifecycle?.flip_count ?? null,
    high_trigger_risk_review: needsHighTriggerRiskReview ? 1 : 0,
    should_auto_advance_to_plan_ready: recommendation === 'auto_advance_to_plan_ready' ? 1 : 0
  };
}

function buildObservationQueueSummary(items: Array<{ observation_queue_bucket?: string; should_auto_advance_to_plan_ready?: number }>) {
  const summary: Record<string, number> = {
    plan_ready: 0,
    ready_to_plan: 0,
    risk_priority_recheck: 0,
    lifecycle_recheck: 0,
    risk_hold: 0,
    wait_pullback: 0,
    waiting_trigger: 0,
    resolved: 0,
    should_auto_advance: 0
  };
  items.forEach((item) => {
    const bucket = item.observation_queue_bucket || 'waiting_trigger';
    summary[bucket] = Number(summary[bucket] || 0) + 1;
    if (item.should_auto_advance_to_plan_ready) {
      summary.should_auto_advance += 1;
    }
  });
  return summary;
}

function getObservationQueueSortRank(item: any) {
  switch (item.observation_queue_bucket) {
    case 'ready_to_plan':
    case 'plan_ready':
      return 0;
    case 'risk_priority_recheck':
      return 1;
    case 'lifecycle_recheck':
      return 2;
    case 'risk_hold':
      return 3;
    case 'wait_pullback':
      return 4;
    case 'waiting_trigger':
      return 5;
    default:
      return 9;
  }
}

function compareObservationQueueItems(a: any, b: any) {
  const bucketDiff = getObservationQueueSortRank(a) - getObservationQueueSortRank(b);
  if (bucketDiff !== 0) return bucketDiff;
  const triggerDiff = Number(b.trigger_score || 0) - Number(a.trigger_score || 0);
  if (triggerDiff !== 0) return triggerDiff;
  const structureDiff = Number(b.structure_score || 0) - Number(a.structure_score || 0);
  if (structureDiff !== 0) return structureDiff;
  const aLoss = typeof a.max_loss_percent === 'number' ? a.max_loss_percent : 9;
  const bLoss = typeof b.max_loss_percent === 'number' ? b.max_loss_percent : 9;
  if (aLoss !== bLoss) return aLoss - bLoss;
  const flipDiff = Number(b.lifecycle_flip_count || 0) - Number(a.lifecycle_flip_count || 0);
  if (flipDiff !== 0) return flipDiff;
  return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
}

function classifyOpportunityType(input: {
  asset_type?: string;
  plan_profile?: string | null;
  profile_key?: string | null;
  structure_status?: string | null;
  safe_zone_status?: string | null;
  trend_phase_code?: string | null;
  distance_to_ma60?: number | null;
  above_ma60_days?: number | null;
  ma20_slope?: string | null;
  ma60_slope?: string | null;
  amplitude_20?: number | null;
}): OpportunityTypeTag {
  const trendPhaseCode = String(input.trend_phase_code || 'UNKNOWN');
  const assetType = String(input.asset_type || 'stock');
  const distanceToMa60 = toNullableNumber(input.distance_to_ma60);
  const aboveMa60Days = toNullableNumber(input.above_ma60_days) ?? 0;
  const amplitude20 = toNullableNumber(input.amplitude_20);
  const structureConfirmed = input.structure_status === 'STRUCTURE_CONFIRMED';
  const safeZone = input.safe_zone_status === 'SAFE_ZONE';
  const ma20Slope = String(input.ma20_slope || '');
  const ma60Slope = String(input.ma60_slope || '');
  const profile = getFinanceStructureProfileConfig(input.plan_profile || input.profile_key);
  const distanceComfortable = distanceToMa60 !== null && distanceToMa60 >= profile.safeZoneMin && distanceToMa60 <= profile.distanceComfortMax;
  const distanceClose = distanceToMa60 !== null && distanceToMa60 >= profile.safeZoneMin && distanceToMa60 <= profile.distanceTightMax;
  const lowVolatility = amplitude20 !== null && amplitude20 <= profile.lowVolatilityMax;

  if (!['stock', 'etf'].includes(assetType)) {
    return {
      code: 'NOT_APPLICABLE',
      label: '不适用型',
      tone: 'neutral',
      reason: '资产类型不匹配当前权益池，先进入资产路由，不作为交易许可。'
    };
  }

  if (
    trendPhaseCode === 'SURGE' ||
    (amplitude20 !== null && amplitude20 >= profile.emotionalAmplitudeMin && !distanceClose)
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

interface EntryTriggerItem {
  code: string;
  name: string;
  status: 'triggered' | 'waiting' | 'blocked';
  score: number;
  reason: string;
}

interface EntryTriggerPlan {
  action: 'READY_TO_PLAN' | 'WAIT_TRIGGER' | 'WAIT_PULLBACK' | 'OBSERVE' | 'BLOCKED' | 'INVALIDATED';
  action_label: string;
  trigger_score: number;
  trigger_reason: string;
  triggered_items: EntryTriggerItem[];
  waiting_items: EntryTriggerItem[];
  blocked_reasons: string[];
  plan_draft: {
    entry_reason: string;
    trigger_condition: string;
    suggested_entry_zone: string;
    invalidation_line: number;
    max_loss_percent: number | null;
    plan_profile: string;
    plan_profile_label: string;
    plan_profile_note: string;
    position_suggestion: string;
    follow_up: string;
  };
  metrics: {
    distance_to_ma20: number | null;
    distance_to_ma60: number;
    latest_change: number | null;
    volume_ratio_5: number | null;
    recent_breakout_level: number | null;
    days_since_breakout: number | null;
    not_chasing: boolean;
    manual_priority_level: string;
    manual_priority_score: number;
    trend_priority_rank: number;
  };
}

function logRead(message: string, symbol?: string, source?: string) {
  const timestamp = new Date().toISOString();
  const prefix = symbol ? `[${symbol}]` : '';
  const sourcePrefix = source ? `[${source}]` : '';
  console.log(`${timestamp} [READ_ONLY] ${prefix} ${sourcePrefix} ${message}`);
}

function logUpdate(message: string, symbol?: string, source?: string) {
  const timestamp = new Date().toISOString();
  const prefix = symbol ? `[${symbol}]` : '';
  const sourcePrefix = source ? `[${source}]` : '';
  console.log(`${timestamp} [UPDATE] ${prefix} ${sourcePrefix} ${message}`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getMovingAverage(prices: DailyPrice[], period: number, endExclusive: number): number | null {
  const start = endExclusive - period;
  if (start < 0) return null;
  const closes = prices.slice(start, endExclusive).map((price) => Number(price.close)).filter(Number.isFinite);
  return closes.length === period ? average(closes) : null;
}

function getSlope(current: number | null, previous: number | null): 'up' | 'flat' | 'down' | 'unknown' {
  if (current === null || previous === null || previous === 0) return 'unknown';
  const change = (current - previous) / previous;
  if (change > 0.001) return 'up';
  if (change < -0.001) return 'down';
  return 'flat';
}

function getMaxDrawdown(prices: DailyPrice[]): number | null {
  if (prices.length < 2) return null;
  let peak = Number(prices[0].close);
  let maxDrawdown = 0;
  prices.forEach((price) => {
    const close = Number(price.close);
    if (!Number.isFinite(close)) return;
    peak = Math.max(peak, close);
    if (peak > 0) {
      maxDrawdown = Math.min(maxDrawdown, (close - peak) / peak);
    }
  });
  return Math.abs(maxDrawdown);
}

function getAmplitude(prices: DailyPrice[]): number | null {
  if (prices.length === 0) return null;
  const highs = prices.map((price) => Number(price.high)).filter(Number.isFinite);
  const lows = prices.map((price) => Number(price.low)).filter(Number.isFinite);
  if (highs.length === 0 || lows.length === 0) return null;
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  return low > 0 ? (high - low) / low : null;
}

function getBoxPosition(prices: DailyPrice[], close: number): { position: StructureScoreResult['metrics']['box_position']; ratio: number | null } {
  if (prices.length < 20) return { position: 'unknown', ratio: null };
  const highs = prices.map((price) => Number(price.high)).filter(Number.isFinite);
  const lows = prices.map((price) => Number(price.low)).filter(Number.isFinite);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  if (high <= low) return { position: 'unknown', ratio: null };
  const ratio = clamp((close - low) / (high - low), 0, 1);
  if (ratio <= 0.35) return { position: 'lower', ratio };
  if (ratio >= 0.7) return { position: 'upper', ratio };
  return { position: 'middle', ratio };
}

function roundRatio(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

function calculateStructureScore(
  structure: ReturnType<typeof calculateStructure>,
  prices: DailyPrice[],
  planProfileKey?: string | null
): StructureScoreResult {
  const profile = getFinanceStructureProfileConfig(planProfileKey);
  const latestIndex = prices.length;
  const recent20 = prices.slice(-20);
  const recent60 = prices.slice(-60);
  const recent120 = prices.slice(-120);

  const ma20Current = getMovingAverage(prices, 20, latestIndex) ?? structure.ma20;
  const ma20Previous = getMovingAverage(prices, 20, latestIndex - 1);
  const ma60Current = getMovingAverage(prices, 60, latestIndex) ?? structure.ma60;
  const ma60Previous = getMovingAverage(prices, 60, latestIndex - 1);
  const ma20Slope = getSlope(ma20Current, ma20Previous);
  const ma60Slope = getSlope(ma60Current, ma60Previous);
  const maxDrawdown20 = getMaxDrawdown(recent20);
  const amplitude20 = getAmplitude(recent20);
  const box = getBoxPosition(recent120.length >= 60 ? recent120 : recent60, structure.close);
  const isInvalidated = Boolean(structure.invalidation_line && structure.close < structure.invalidation_line);
  const previous20High = recent20.length >= 20 ? Math.max(...recent20.slice(0, -1).map((price) => Number(price.high)).filter(Number.isFinite)) : null;
  const hasBreakoutPullback = Boolean(
    previous20High &&
    structure.close >= structure.ma20 &&
    structure.close >= structure.ma60 &&
    structure.close <= previous20High * (1 + Math.min(profile.safeZoneMax, 0.06)) &&
    structure.close >= previous20High * (1 - Math.abs(profile.safeZoneMin))
  );

  const details: StructureScoreDetail[] = [];
  const addDetail = (detail: StructureScoreDetail) => details.push(detail);

  const aboveDaysScore = structure.above_ma60_days >= Math.max(20, profile.minAboveMa60Days * 5) ? 15 : structure.above_ma60_days >= Math.max(10, profile.minAboveMa60Days * 3) ? 12 : structure.above_ma60_days >= profile.minAboveMa60Days ? 8 : structure.above_ma60_days > 0 ? 4 : 0;
  addDetail({
    label: '站上MA60天数',
    score: aboveDaysScore,
    max_score: 15,
    status: aboveDaysScore >= 12 ? 'good' : aboveDaysScore >= 8 ? 'neutral' : 'bad',
    reason: `连续站上 MA60 ${structure.above_ma60_days} 天`
  });

  const ma60Score = ma60Slope === 'up' ? 15 : ma60Slope === 'flat' ? 8 : ma60Slope === 'unknown' ? 6 : 0;
  addDetail({
    label: 'MA60方向',
    score: ma60Score,
    max_score: 15,
    status: ma60Score >= 12 ? 'good' : ma60Score >= 6 ? 'neutral' : 'bad',
    reason: ma60Slope === 'up' ? 'MA60 上行' : ma60Slope === 'flat' ? 'MA60 走平' : ma60Slope === 'down' ? 'MA60 下行' : 'MA60 方向数据不足'
  });

  const ma20Score = ma20Slope === 'up' ? 10 : ma20Slope === 'flat' ? 6 : ma20Slope === 'unknown' ? 4 : 0;
  addDetail({
    label: 'MA20方向',
    score: ma20Score,
    max_score: 10,
    status: ma20Score >= 8 ? 'good' : ma20Score >= 4 ? 'neutral' : 'bad',
    reason: ma20Slope === 'up' ? 'MA20 开始上行' : ma20Slope === 'flat' ? 'MA20 走平' : ma20Slope === 'down' ? 'MA20 下行' : 'MA20 方向数据不足'
  });

  const distance = structure.distance_to_ma60;
  const distanceScore = distance < 0 ? 0 : distance <= profile.distanceComfortMax ? 15 : distance <= profile.distanceWatchMax ? 10 : distance <= profile.highRiskChaseMin * 2.5 ? 5 : 0;
  addDetail({
    label: '距离MA60',
    score: distanceScore,
    max_score: 15,
    status: distanceScore >= 12 ? 'good' : distanceScore >= 5 ? 'neutral' : 'bad',
    reason: distance < 0 ? '仍在 MA60 下方' : distance <= profile.distanceComfortMax ? `符合${profile.label}的MA60舒适距离` : distance <= profile.distanceWatchMax ? `距离 MA60 中等，仍在${profile.label}观察区` : '距离 MA60 偏远，有追高风险'
  });

  const drawdownScore = maxDrawdown20 === null ? 4 : maxDrawdown20 <= profile.drawdownGoodMax ? 10 : maxDrawdown20 <= profile.drawdownWatchMax ? 7 : maxDrawdown20 <= profile.drawdownWeakMax ? 3 : 0;
  addDetail({
    label: '20日最大回撤',
    score: drawdownScore,
    max_score: 10,
    status: drawdownScore >= 8 ? 'good' : drawdownScore >= 4 ? 'neutral' : 'bad',
    reason: maxDrawdown20 === null ? '20 日回撤数据不足' : `20 日最大回撤 ${(maxDrawdown20 * 100).toFixed(2)}%`
  });

  const amplitudeScore = amplitude20 === null ? 4 : amplitude20 <= profile.amplitudeGoodMax ? 10 : amplitude20 <= profile.amplitudeWatchMax ? 7 : amplitude20 <= profile.amplitudeWeakMax ? 3 : 0;
  addDetail({
    label: '20日振幅',
    score: amplitudeScore,
    max_score: 10,
    status: amplitudeScore >= 8 ? 'good' : amplitudeScore >= 4 ? 'neutral' : 'bad',
    reason: amplitude20 === null ? '20 日振幅数据不足' : `20 日振幅 ${(amplitude20 * 100).toFixed(2)}%`
  });

  addDetail({
    label: '突破后回踩',
    score: hasBreakoutPullback ? 10 : structure.structure_status === 'STRUCTURE_CONFIRMED' ? 6 : 2,
    max_score: 10,
    status: hasBreakoutPullback ? 'good' : structure.structure_status === 'STRUCTURE_CONFIRMED' ? 'neutral' : 'bad',
    reason: hasBreakoutPullback ? '接近突破位且未跌回 MA20/MA60' : '暂未识别出明确突破后回踩形态'
  });

  addDetail({
    label: '失效线',
    score: isInvalidated ? 0 : structure.below_ma60_days > 0 ? 3 : 10,
    max_score: 10,
    status: isInvalidated ? 'bad' : structure.below_ma60_days > 0 ? 'neutral' : 'good',
    reason: isInvalidated ? '已跌破失效线' : structure.below_ma60_days > 0 ? `连续跌破 MA60 ${structure.below_ma60_days} 天` : '未跌破失效线'
  });

  const boxScore = box.position === 'lower' ? 5 : box.position === 'middle' ? 4 : box.position === 'upper' ? 2 : 2;
  addDetail({
    label: '箱体位置',
    score: boxScore,
    max_score: 5,
    status: box.position === 'lower' || box.position === 'middle' ? 'good' : box.position === 'upper' ? 'neutral' : 'bad',
    reason: box.position === 'lower' ? '处于箱体下沿' : box.position === 'middle' ? '处于箱体中位' : box.position === 'upper' ? '处于箱体高位' : '箱体位置数据不足'
  });

  const score = clamp(Math.round(details.reduce((sum, detail) => sum + detail.score, 0)), 0, 100);
  const penaltyReasons = details
    .filter((detail) => detail.status === 'bad')
    .map((detail) => detail.reason)
    .slice(0, 4);

  let level: StructureScoreResult['level'] = 'WEAK';
  let levelLabel = '结构偏弱';
  let conclusion = '先观察，等待 MA60、MA20 和安全区继续修复。';
  if (isInvalidated || structure.structure_status === 'STRUCTURE_BROKEN') {
    level = 'BROKEN';
    levelLabel = '结构失效';
    conclusion = '结构已经失效，不进入买入计划。';
  } else if (score >= 80) {
    level = 'STRONG';
    levelLabel = '结构强';
    conclusion = '结构质量较高，可进入后续入场触发观察。';
  } else if (score >= 65) {
    level = 'GOOD';
    levelLabel = '结构良好';
    conclusion = '结构基本可用，等待更明确的入场触发。';
  } else if (score >= 50) {
    level = 'WATCH';
    levelLabel = '结构观察';
    conclusion = '结构正在修复，适合放观察池。';
  }

  return {
    score,
    level,
    level_label: levelLabel,
    conclusion,
    details,
    penalty_reasons: penaltyReasons,
    metrics: {
      ma20_slope: ma20Slope,
      ma60_slope: ma60Slope,
      max_drawdown_20: roundRatio(maxDrawdown20),
      amplitude_20: roundRatio(amplitude20),
      box_position: box.position,
      box_position_ratio: roundRatio(box.ratio),
      has_breakout_pullback: hasBreakoutPullback,
      is_invalidated: isInvalidated
    }
  };
}

function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return Number(value).toFixed(3);
}

function getVolumeRatio5(prices: DailyPrice[]): number | null {
  if (prices.length < 6) return null;
  const latest = Number(prices[prices.length - 1].volume);
  const previous5 = prices.slice(-6, -1).map((price) => Number(price.volume)).filter(Number.isFinite);
  const avg5 = average(previous5);
  if (!Number.isFinite(latest) || !avg5 || avg5 <= 0) return null;
  return roundRatio(latest / avg5);
}

function getRecentBreakout(prices: DailyPrice[]): { level: number | null; days: number | null } {
  if (prices.length < 25) return { level: null, days: null };
  const latestIndex = prices.length - 1;
  for (let index = latestIndex; index >= Math.max(20, latestIndex - 4); index--) {
    const previous20 = prices.slice(index - 20, index);
    const highs = previous20.map((price) => Number(price.high)).filter(Number.isFinite);
    if (highs.length < 20) continue;
    const level = Math.max(...highs);
    if (Number(prices[index].close) > level) {
      return { level, days: latestIndex - index };
    }
  }
  return { level: null, days: null };
}

function calculateEntryTriggerPlan(
  structure: ReturnType<typeof calculateStructure>,
  structureScore: StructureScoreResult,
  prices: DailyPrice[],
  marketRegime: string,
  entryPermission: string,
  trendPhaseCode?: string | null,
  trendAction?: string,
  planProfileKey?: string | null
): EntryTriggerPlan {
  const planProfile = getFinancePlanProfileConfig(planProfileKey);
  const latest = prices[prices.length - 1];
  const previous = prices.length >= 2 ? prices[prices.length - 2] : null;
  const latestChange = previous && previous.close > 0 ? roundRatio((latest.close - previous.close) / previous.close) : null;
  const distanceToMa20 = structure.ma20 > 0 ? roundRatio((structure.close - structure.ma20) / structure.ma20) : null;
  const volumeRatio5 = getVolumeRatio5(prices);
  const recentBreakout = getRecentBreakout(prices);
  const notChasing = structure.distance_to_ma60 <= planProfile.chaseDistanceMax && (latestChange === null || latestChange <= planProfile.dailyChangeChaseMax);
  const nearInvalidation = structure.invalidation_line > 0
    ? (structure.close - structure.invalidation_line) / structure.close <= planProfile.nearInvalidationMax && structure.close > structure.invalidation_line
    : false;
  const maxLossPercent = structure.invalidation_line > 0 && structure.close > structure.invalidation_line
    ? roundRatio((structure.close - structure.invalidation_line) / structure.close)
    : null;

  const blockedReasons: string[] = [];
  const structureReadinessReasons: string[] = [];
  const trendReadinessReasons: string[] = [];
  if (!planProfile.allowsTradePlan) {
    blockedReasons.push(`${planProfile.label}：${planProfile.note}`);
  }
  if (entryPermission !== 'ALLOW_STRUCTURE_CHECK') {
    blockedReasons.push('市场权限未放行，当前只允许观察或等待修复。');
  }
  if (structureScore.metrics.is_invalidated || structure.structure_status === 'STRUCTURE_BROKEN') {
    blockedReasons.push('结构已跌破失效线或进入结构破坏。');
  }
  if (structure.structure_status !== 'STRUCTURE_CONFIRMED') {
    structureReadinessReasons.push('结构尚未成立');
  }
  if (structure.safe_zone_status !== 'SAFE_ZONE') {
    structureReadinessReasons.push('位置不在相对安全区');
  }
  const trendPhaseReady = ENTRY_READY_TREND_PHASES.has(trendPhaseCode || '');
  const trendPhaseHardBlocked = ENTRY_HARD_BLOCK_TREND_PHASES.has(trendPhaseCode || '');
  if (trendPhaseHardBlocked) {
    blockedReasons.push(`${getTrendPhaseLabel(trendPhaseCode)}阶段不生成买入计划。`);
  } else if (!trendPhaseReady) {
    const trendLabel = getTrendPhaseLabel(trendPhaseCode);
    if (trendPhaseCode === 'SURGE') {
      trendReadinessReasons.push('急涨阶段需要等待回踩确认');
    } else if (trendPhaseCode === 'HIGH_BASE') {
      trendReadinessReasons.push('高位横盘阶段只观察，防止假突破');
    } else if (trendPhaseCode === 'SIDEWAYS') {
      trendReadinessReasons.push('横盘震荡阶段方向未确认');
    } else if (trendPhaseCode === 'TREND_TRANSITION') {
      trendReadinessReasons.push('趋势转换中，尚未确认新方向');
    } else if (trendPhaseCode === 'CONSOLIDATION') {
      trendReadinessReasons.push('震荡待确认，尚未形成可执行趋势');
    } else {
      trendReadinessReasons.push(`走势阶段为${trendLabel}，未达到准备入场阶段`);
    }
  }

  const items: EntryTriggerItem[] = [
    {
      code: 'PULLBACK_MA60_HOLD',
      name: '回踩 MA60 不破',
      status: latest.low <= structure.ma60 * 1.025 && structure.close >= structure.ma60 && structure.distance_to_ma60 <= 0.05 ? 'triggered' : 'waiting',
      score: latest.low <= structure.ma60 * 1.025 && structure.close >= structure.ma60 && structure.distance_to_ma60 <= 0.05 ? 25 : 0,
      reason: `最低价 ${formatPrice(latest.low)}，MA60 ${formatPrice(structure.ma60)}，偏离 MA60 ${(structure.distance_to_ma60 * 100).toFixed(2)}%。`
    },
    {
      code: 'PULLBACK_MA20_HOLD',
      name: '回踩 MA20 不破',
      status: latest.low <= structure.ma20 * 1.02 && structure.close >= structure.ma20 && structureScore.metrics.ma20_slope !== 'down' ? 'triggered' : 'waiting',
      score: latest.low <= structure.ma20 * 1.02 && structure.close >= structure.ma20 && structureScore.metrics.ma20_slope !== 'down' ? 20 : 0,
      reason: `最低价 ${formatPrice(latest.low)}，MA20 ${formatPrice(structure.ma20)}，MA20方向：${structureScore.metrics.ma20_slope}。`
    },
    {
      code: 'BREAKOUT_CONFIRM_1_3',
      name: '突破后 1-3 天不跌回平台',
      status: recentBreakout.level && recentBreakout.days !== null && recentBreakout.days <= 3 && structure.close >= recentBreakout.level * 0.98 ? 'triggered' : 'waiting',
      score: recentBreakout.level && recentBreakout.days !== null && recentBreakout.days <= 3 && structure.close >= recentBreakout.level * 0.98 ? 20 : 0,
      reason: recentBreakout.level
        ? `近 ${recentBreakout.days} 天出现突破，平台位约 ${formatPrice(recentBreakout.level)}，当前未明显跌回。`
        : '近 5 个交易日未识别出明确平台突破。'
    },
    {
      code: 'SHORT_RECLAIM',
      name: '缩量回踩后重新站上短线',
      status: structure.close >= structure.ma20 && (volumeRatio5 === null || volumeRatio5 <= 1.15) && structureScore.metrics.ma20_slope !== 'down' ? 'triggered' : 'waiting',
      score: structure.close >= structure.ma20 && (volumeRatio5 === null || volumeRatio5 <= 1.15) && structureScore.metrics.ma20_slope !== 'down' ? 15 : 0,
      reason: volumeRatio5 === null
        ? '成交量数据不足，按价格重新站上 MA20 观察。'
        : `当前成交量约为 5 日均量 ${volumeRatio5.toFixed(2)} 倍。`
    },
    {
      code: 'NEAR_INVALIDATION_LINE',
      name: '距离失效线足够近',
      status: nearInvalidation ? 'triggered' : 'waiting',
      score: nearInvalidation ? 10 : 0,
      reason: maxLossPercent === null
        ? '当前价格未站在失效线之上。'
        : `到${planProfile.label}失效线的理论风险约 ${(maxLossPercent * 100).toFixed(2)}%。`
    },
    {
      code: 'NOT_CHASING_TODAY',
      name: '当天不是追高状态',
      status: notChasing ? 'triggered' : 'blocked',
      score: notChasing ? 10 : 0,
      reason: latestChange === null
        ? `偏离 MA60 ${(structure.distance_to_ma60 * 100).toFixed(2)}%，当前Profile允许追高上限 ${(planProfile.chaseDistanceMax * 100).toFixed(1)}%。`
        : `当日涨跌幅 ${(latestChange * 100).toFixed(2)}%，偏离 MA60 ${(structure.distance_to_ma60 * 100).toFixed(2)}%，当前Profile日涨幅追高上限 ${(planProfile.dailyChangeChaseMax * 100).toFixed(1)}%。`
    }
  ];

  if (!notChasing) {
    blockedReasons.push('当前位置偏离 MA60 较远或当日涨幅偏大，避免追高。');
  }
  if (structureScore.score < 50) {
    blockedReasons.push('结构评分低于 50，入场触发不可靠。');
  }
  const structureReady = structureReadinessReasons.length === 0;
  const trendReady = trendReadinessReasons.length === 0;

  const triggeredItems = items.filter((item) => item.status === 'triggered');
  const waitingItems = items.filter((item) => item.status === 'waiting');
  const triggerScore = clamp(Math.round(items.reduce((sum, item) => sum + item.score, 0)), 0, 100);
  const primaryTrigger = triggeredItems.find((item) => item.code !== 'NOT_CHASING_TODAY') || triggeredItems[0];

  let action: EntryTriggerPlan['action'] = 'WAIT_TRIGGER';
  let actionLabel = '等待触发';
  let triggerReason = '结构可以继续观察，但尚未出现足够明确的入场触发。';

  if (structureScore.metrics.is_invalidated || structure.structure_status === 'STRUCTURE_BROKEN') {
    action = 'INVALIDATED';
    actionLabel = '结构失效';
    triggerReason = '已跌破失效线或结构破坏，不生成买入计划。';
  } else if (blockedReasons.length > 0 && (!planProfile.allowsTradePlan || entryPermission !== 'ALLOW_STRUCTURE_CHECK' || trendPhaseHardBlocked || structureScore.score < 50)) {
    action = 'BLOCKED';
    actionLabel = '禁止入场';
    triggerReason = blockedReasons[0];
  } else if (!structureReady) {
    if (structure.structure_status === 'STRUCTURE_CONFIRMED' && (structure.safe_zone_status === 'HIGH_RISK_CHASE' || !notChasing)) {
      action = 'WAIT_PULLBACK';
      actionLabel = '等待回踩';
      triggerReason = '结构已成立但位置不在相对安全区，等待回踩后再确认。';
    } else {
      action = 'OBSERVE';
      actionLabel = '结构观察';
      triggerReason = `${structureReadinessReasons.join('，')}，不生成买入计划草案。`;
    }
  } else if (!trendReady) {
    if (trendPhaseCode === 'SURGE' || trendAction === 'WAIT_PULLBACK') {
      action = 'WAIT_PULLBACK';
      actionLabel = '等待回踩';
    } else {
      action = 'OBSERVE';
      actionLabel = '走势观察';
    }
    triggerReason = `${trendReadinessReasons.join('，')}，不生成买入计划草案。`;
  } else if (trendAction === 'WAIT_PULLBACK' || structure.safe_zone_status === 'HIGH_RISK_CHASE' || !notChasing) {
    action = 'WAIT_PULLBACK';
    actionLabel = '等待回踩';
    triggerReason = '当前更适合等回踩确认，不追高。';
  } else if (structureScore.score >= planProfile.minStructureScore && primaryTrigger && triggerScore >= planProfile.minTriggerScore) {
    action = 'READY_TO_PLAN';
    actionLabel = '可生成买入计划草案';
    triggerReason = `${primaryTrigger.name} 已触发，且结构评分达到 ${structureScore.score}；当前按${planProfile.label}参数生成计划。`;
  } else if (structureScore.score >= 50) {
    action = 'OBSERVE';
    actionLabel = '观察触发';
    triggerReason = '结构处于可观察区，等待 MA20/MA60 回踩不破或突破确认。';
  }

  const entryZoneLow = Math.min(structure.ma20, structure.ma60);
  const entryZoneHigh = Math.max(structure.ma20, structure.ma60) * 1.025;
  const manualPriorityLevel = getEntryManualPriorityLevel(
    trendPhaseCode,
    triggerScore,
    structureScore.score,
    maxLossPercent,
    planProfile.key
  );
  const manualPriorityScore = getEntryManualPriorityScore(
    trendPhaseCode,
    triggerScore,
    structureScore.score,
    maxLossPercent,
    planProfile.key
  );
  const positionSuggestion = action === 'READY_TO_PLAN'
    ? manualPriorityLevel === 'A' && trendPhaseCode === 'SLOW_GRIND_UP'
      ? '中等试仓上限，仍以失效线控制亏损；不加满，不追涨。'
      : manualPriorityLevel === 'A'
        ? '小到中等试仓，失效线清楚才执行，触发后继续复核。'
        : manualPriorityLevel === 'B'
          ? '小仓试探，确认延续后再考虑加仓。'
          : '最小观察仓试错，优先确认走势延续，不急于加仓。'
    : '暂不建仓，等待触发条件完成。';

  return {
    action,
    action_label: actionLabel,
    trigger_score: triggerScore,
    trigger_reason: triggerReason,
    triggered_items: triggeredItems,
    waiting_items: waitingItems,
    blocked_reasons: [...blockedReasons, ...structureReadinessReasons, ...trendReadinessReasons],
    plan_draft: {
      entry_reason: primaryTrigger ? `${primaryTrigger.name}；${triggerReason}` : triggerReason,
      trigger_condition: primaryTrigger ? primaryTrigger.name : '等待 MA20/MA60 回踩不破或突破后确认',
      suggested_entry_zone: `${formatPrice(entryZoneLow)} - ${formatPrice(entryZoneHigh)}`,
      invalidation_line: structure.invalidation_line,
      max_loss_percent: maxLossPercent,
      plan_profile: planProfile.key,
      plan_profile_label: planProfile.label,
      plan_profile_note: planProfile.note,
      position_suggestion: positionSuggestion,
      follow_up: '买入后跟踪 5/10/20/60 日表现，并记录是否跌破失效线、是否进入主升或是假突破。'
    },
    metrics: {
      distance_to_ma20: distanceToMa20,
      distance_to_ma60: structure.distance_to_ma60,
      latest_change: latestChange,
      volume_ratio_5: volumeRatio5,
      recent_breakout_level: recentBreakout.level ? Math.round(recentBreakout.level * 1000) / 1000 : null,
      days_since_breakout: recentBreakout.days,
      not_chasing: notChasing,
      manual_priority_level: manualPriorityLevel,
      manual_priority_score: manualPriorityScore,
      trend_priority_rank: getEntryTrendPriority(trendPhaseCode)
    }
  };
}

async function fetchAndUpdateData(db: any, symbol: string, assetType: string, source: string, forceUpdate: boolean = false): Promise<{ success: boolean; message: string; updated: boolean }> {
  const now = new Date();
  
  const lastUpdateResult = await db.get(
    `SELECT MAX(updated_at) as last_updated, MAX(trade_date) as last_trade_date
     FROM financial_daily_prices 
     WHERE symbol = ? AND asset_type = ? AND source = ?`,
    [symbol, assetType, source]
  );

  if (!forceUpdate && lastUpdateResult.last_updated) {
    const lastUpdated = new Date(lastUpdateResult.last_updated);
    const diffSeconds = (now.getTime() - lastUpdated.getTime()) / 1000;
    
    if (diffSeconds < 60) {
      logUpdate(`数据更新频率限制：距离上次更新不足60秒`, symbol, source);
      return { success: true, message: '距离上次更新不足60秒', updated: false };
    }
  }

  const scriptPath = path.join(__dirname, '../../scripts/finance/fetch_asset_daily.py');
  
  logUpdate(`开始从 ${source} 获取数据`, symbol, source);
  
  const result = await new Promise<{ success: boolean; data?: any; message?: string }>((resolve) => {
    exec(`/usr/bin/python3 "${scriptPath}" ${symbol} ${assetType} --source ${source}`, (error, stdout, stderr) => {
      if (error) {
        const errorMsg = `获取数据失败: ${stderr || error.message}`;
        logUpdate(errorMsg, symbol, source);
        resolve({
          success: false,
          message: errorMsg
        });
        return;
      }
      try {
        const data = JSON.parse(stdout);
        resolve({ success: true, data });
      } catch {
        const errorMsg = 'Python脚本返回无效响应';
        logUpdate(errorMsg, symbol, source);
        resolve({ success: false, message: errorMsg });
      }
    });
  });

  if (!result.success) {
    return { success: false, message: result.message || '获取数据失败', updated: false };
  }

  const data = result.data;
  
  let insertedCount = 0;
  let updatedCount = 0;
  
  for (const item of data.items) {
    const existing = await db.get(
      `SELECT 1 FROM financial_daily_prices 
       WHERE symbol = ? AND trade_date = ? AND source = ?`,
      [symbol, item.trade_date, source]
    );
    
    await db.run(
      `INSERT OR REPLACE INTO financial_daily_prices 
       (symbol, name, market, asset_type, trade_date, open, high, low, close, volume, amount, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        symbol,
        data.name,
        'cn',
        assetType,
        item.trade_date,
        item.open,
        item.high,
        item.low,
        item.close,
        item.volume,
        item.amount,
        source
      ]
    );
    
    if (existing) {
      updatedCount++;
    } else {
      insertedCount++;
    }
  }
  
  const statusMsg = `数据更新完成：新增 ${insertedCount} 条，更新 ${updatedCount} 条`;
  logUpdate(statusMsg, symbol, source);
  
  return { success: true, message: statusMsg, updated: true };
}

router.post('/update-daily', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.body.symbol;
    const assetType = req.body.asset_type;
    const sourceStrategy = req.body.source_strategy || 'tushare';
    const forceUpdate = req.body.force_update || false;

    if (!symbol || !assetType || !['stock', 'etf', 'index'].includes(assetType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid symbol or asset_type'
      });
    }

    if (!['tushare', 'akshare'].includes(sourceStrategy)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid source_strategy. Must be "tushare" or "akshare"'
      });
    }

    logUpdate(`收到更新请求: ${symbol} ${assetType} ${sourceStrategy}`, symbol, sourceStrategy);

    const updateResult = await fetchAndUpdateData(db, symbol, assetType, sourceStrategy, forceUpdate);
    
    if (!updateResult.success) {
      return res.status(500).json({
        success: false,
        message: updateResult.message
      });
    }

    const status = await getDataStatus(db, symbol);
    
    const lastUpdateResult = await db.get(
      `SELECT name FROM financial_daily_prices WHERE symbol = ? AND source = ? LIMIT 1`,
      [symbol, sourceStrategy]
    );
    
    res.json({
      success: true,
      message: updateResult.updated ? updateResult.message : '距离上次更新不足60秒，已返回本地最新结果。',
      data: {
        ...status,
        is_mock: false,
        name: lastUpdateResult?.name || '',
        asset_type: assetType,
        source: sourceStrategy,
        auto_updated: updateResult.updated
      }
    });
  } catch (error) {
    logUpdate(`更新失败: ${(error as Error).message}`, req.body.symbol, req.body.source_strategy);
    console.error('Error updating daily prices:', error);
    res.status(500).json({
      success: false,
      message: `更新失败: ${(error as Error).message}`
    });
  }
});

router.get('/data-status', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.query.symbol as string;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: 'symbol is required'
      });
    }

    logRead(`获取数据状态: ${symbol}`, symbol);

    const status = await getDataStatus(db, symbol);

    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logRead(`获取状态失败: ${(error as Error).message}`, req.query.symbol as string);
    console.error('Error getting data status:', error);
    res.status(500).json({
      success: false,
      message: `获取状态失败: ${(error as Error).message}`
    });
  }
});

async function getDataStatus(db: any, symbol: string): Promise<AssetDataStatus> {
  const results = await db.all(
    `SELECT 
       source,
       COUNT(*) as total_count,
       MIN(trade_date) as first_trade_date,
       MAX(trade_date) as last_trade_date,
       MAX(updated_at) as last_updated
     FROM financial_daily_prices 
     WHERE symbol = ? 
     GROUP BY source`,
    [symbol]
  );

  const sources: SourceStatus[] = results.map((row: any) => ({
    source: row.source,
    total_count: row.total_count || 0,
    first_trade_date: row.first_trade_date || null,
    last_trade_date: row.last_trade_date || null,
    last_updated: row.last_updated || null,
    has_enough_60: (row.total_count || 0) >= 60,
    has_enough_120: (row.total_count || 0) >= 120
  }));

  const hasTushare = sources.some(s => s.source === 'tushare');
  
  return {
    symbol,
    preferred_source: hasTushare ? 'tushare' : (sources.length > 0 ? sources[0].source : 'tushare'),
    sources
  };
}

router.get('/daily-prices', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.query.symbol as string;
    const source = (req.query.source as string) || 'tushare';
    const limit = parseInt(req.query.limit as string) || 120;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: 'symbol is required'
      });
    }

    logRead(`获取日线数据: ${symbol} source=${source}`, symbol, source);

    const prices = await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount 
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = ? 
       ORDER BY trade_date DESC 
       LIMIT ?`,
      [symbol, source, limit]
    );

    res.json({
      success: true,
      data: {
        symbol,
        source,
        items: prices.reverse()
      }
    });
  } catch (error) {
    logRead(`获取日线数据失败: ${(error as Error).message}`, req.query.symbol as string, req.query.source as string);
    console.error('Error getting daily prices:', error);
    res.status(500).json({
      success: false,
      message: `获取日线数据失败: ${(error as Error).message}`
    });
  }
});

function getCandidateReviewStatusLabel(status?: string | null) {
  switch (status) {
    case 'wait_confirmation': return '等待入场触发';
    case 'trend_blocked': return '退回走势阶段';
    case 'structure_watch': return '单标的观察';
    case 'rejected': return '已淘汰';
    default: return status || '未同步';
  }
}

function resolveManualStructureCandidateDecision(input: {
  finalStatus: string;
  finalReason: string;
  trendAction?: string | null;
  structureStatus?: string | null;
}) {
  if (input.finalStatus === 'READY_FOR_PLAN') {
    return {
      review_status: 'wait_confirmation',
      pool_status: 'active',
      final_status: 'WAIT',
      review_action: 'manual_structure_passed_to_entry',
      reason: input.finalReason || '手工单标的判断通过，已推进入场触发。'
    };
  }
  if (input.trendAction === 'BLOCK') {
    return {
      review_status: 'trend_blocked',
      pool_status: 'active',
      final_status: 'WAIT',
      review_action: 'manual_structure_back_to_trend',
      reason: input.finalReason || '手工单标的判断显示走势阶段未通过，退回走势阶段。'
    };
  }
  if (input.structureStatus === 'STRUCTURE_BROKEN') {
    return {
      review_status: 'rejected',
      pool_status: 'expired',
      final_status: 'REJECTED',
      review_action: 'manual_structure_hard_rejected',
      reason: input.finalReason || '手工单标的判断显示结构破坏，已从活跃候选中淘汰。'
    };
  }
  return {
    review_status: 'structure_watch',
    pool_status: 'active',
    final_status: 'WAIT',
    review_action: 'manual_structure_watch',
    reason: input.finalReason || '手工单标的判断未通过，继续结构观察。'
  };
}

async function syncManualStructureCheckCandidate(
  db: any,
  input: {
    candidateId?: number;
    symbol: string;
    assetType: string;
    source: string;
    name: string;
    planProfile: { key: string; label: string };
    result: any;
    structureScore: any;
    trendPhase: any;
    marketRegime: string;
    entryPermission: string;
    finalStatus: string;
    finalReason: string;
    trendAction: string;
  }
) {
  const candidate = input.candidateId && input.candidateId > 0
    ? await db.get(
      `SELECT id, review_status, pool_status
       FROM financial_candidate_pool
       WHERE id = ?
         AND symbol = ?
         AND asset_type = ?
         AND source = ?
         AND rule_version = ?
       LIMIT 1`,
      [input.candidateId, input.symbol, input.assetType, input.source, CANDIDATE_RULE_VERSION]
    )
    : await db.get(
      `SELECT id, review_status, pool_status
       FROM financial_candidate_pool
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND rule_version = ?
         AND pool_status = 'active'
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [input.symbol, input.assetType, input.source, CANDIDATE_RULE_VERSION]
    );

  if (!candidate || String(candidate.pool_status || '') !== 'active') {
    return { synced: false, reason: '未找到可同步的候选池记录。' };
  }

  const decision = resolveManualStructureCandidateDecision({
    finalStatus: input.finalStatus,
    finalReason: input.finalReason,
    trendAction: input.trendAction,
    structureStatus: input.result.structure_status
  });
  const now = new Date().toISOString();
  await db.run(
    `UPDATE financial_candidate_pool
     SET name = COALESCE(NULLIF(?, ''), name),
         trade_date = COALESCE(?, trade_date),
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
         market_regime = ?,
         entry_permission = ?,
         plan_profile = ?,
         plan_profile_label = ?,
         final_status = ?,
         pool_status = ?,
         invalidation_line = COALESCE(?, invalidation_line),
         candidate_reason = ?,
         forbidden_reason = ?,
         review_status = ?,
         last_checked_at = ?,
         last_review_at = ?,
         review_action = ?,
         updated_at = ?
     WHERE id = ?
       AND rule_version = ?`,
    [
      input.name,
      input.result.trade_date || null,
      input.result.close ?? null,
      input.result.ma20 ?? null,
      input.result.ma60 ?? null,
      input.result.ma120 ?? null,
      input.result.distance_to_ma60 ?? null,
      input.result.above_ma60_days ?? null,
      input.result.structure_status || null,
      input.result.structure_reason || null,
      input.result.safe_zone_status || null,
      input.result.safe_zone_reason || null,
      input.trendPhase?.trend_phase_code || null,
      input.trendPhase?.trend_phase_reason || null,
      input.marketRegime,
      input.entryPermission,
      input.planProfile.key,
      input.planProfile.label,
      decision.final_status,
      decision.pool_status,
      input.result.invalidation_line ?? null,
      decision.reason,
      decision.review_status === 'rejected' ? decision.reason : null,
      decision.review_status,
      now,
      now,
      decision.review_action,
      now,
      candidate.id,
      CANDIDATE_RULE_VERSION
    ]
  );

  return {
    synced: true,
    candidate_id: candidate.id,
    previous_review_status: candidate.review_status || null,
    review_status: decision.review_status,
    review_status_label: getCandidateReviewStatusLabel(decision.review_status),
    pool_status: decision.pool_status,
    review_action: decision.review_action,
    reason: decision.reason
  };
}

router.post('/structure-check', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.body.symbol;
    const assetType = req.body.asset_type;
    const source = req.body.source || 'tushare';

    if (!symbol || !assetType || !['stock', 'etf', 'index'].includes(assetType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid symbol or asset_type'
      });
    }

    logRead(`结构判断请求: ${symbol} ${assetType} ${source}`, symbol, source);

    const prices = await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount 
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = ? 
       ORDER BY trade_date ASC`,
      [symbol, source]
    );

    if (prices.length < 60) {
      const status = await getDataStatus(db, symbol);
      const availableSources = status.sources.map((s: any) => s.source);
      return res.json({
        success: true,
        data: {
          symbol,
          name: '',
          asset_type: assetType,
          structure_status: 'INSUFFICIENT_DATA',
          structure_reason: `数据不足（当前${prices.length}条），需要至少60条日线数据。`,
          final_status: 'INSUFFICIENT_DATA',
          final_reason: '数据不足，无法进行结构判断。',
          data_source_used: source,
          available_sources: availableSources
        }
      });
    }

    const marketRegimeResult = await getFreshMarketRegime(db, { source });
    const marketRegime = marketRegimeResult?.market_regime || 'UNKNOWN';
    const entryPermission = marketRegimeResult?.entry_permission || 'OBSERVE_ONLY';
    const nameResult = await db.get(
      `SELECT name FROM financial_daily_prices
       WHERE symbol = ? AND asset_type = ? AND source = ? AND name IS NOT NULL AND TRIM(name) <> ''
       ORDER BY trade_date DESC LIMIT 1`,
      [symbol, assetType, source]
    );
    const universeNameResult = await db.get(
      `SELECT COALESCE(MAX(NULLIF(name, '')), '') as name,
              GROUP_CONCAT(DISTINCT universe_type) as universe_type
       FROM financial_asset_universe
       WHERE symbol = ? AND asset_type = ? AND source = ?`,
      [symbol, assetType, source]
    );
    const name = nameResult?.name || universeNameResult?.name || symbol;
    const planProfile = resolveFinancePlanProfile({
      assetType,
      symbol,
      name,
      universeType: universeNameResult?.universe_type || ''
    });

    const result = calculateStructure(prices, planProfile.key);
    const structureScore = calculateStructureScore(result, prices, planProfile.key);
    const trendPhase = await db.get(
      `SELECT trend_phase_code, trend_phase_reason
       FROM financial_trend_phase_results
       WHERE symbol = ? AND asset_type = ? AND source = ? AND rule_version = ?
       ORDER BY trade_date DESC LIMIT 1`,
      [symbol, assetType, source, TREND_PHASE_VERSION]
    );
    const trendAction = getTrendAction(trendPhase?.trend_phase_code, structureScore, result);
    const opportunityType = classifyOpportunityType({
      asset_type: assetType,
      plan_profile: planProfile.key,
      structure_status: result.structure_status,
      safe_zone_status: result.safe_zone_status,
      trend_phase_code: trendPhase?.trend_phase_code || 'UNKNOWN',
      distance_to_ma60: result.distance_to_ma60,
      above_ma60_days: result.above_ma60_days,
      ma20_slope: structureScore.metrics.ma20_slope,
      ma60_slope: structureScore.metrics.ma60_slope,
      amplitude_20: structureScore.metrics.amplitude_20
    });
    
    let finalStatus: string;
    let finalReason: string;

	    if (entryPermission !== 'ALLOW_STRUCTURE_CHECK') {
	      finalStatus = 'BLOCKED_BY_MARKET';
	      finalReason = marketRegimeResult?.stale
	        ? marketRegimeResult.freshness_reason
	        : '大盘当前不允许进入结构判断，标的信号仅作观察。';
    } else if (trendAction.action === 'BLOCK') {
      finalStatus = 'WAIT';
      finalReason = trendAction.reason;
    } else if (trendAction.action === 'WAIT_PULLBACK') {
      finalStatus = 'WAIT';
      finalReason = trendAction.reason;
    } else if (result.structure_status === 'STRUCTURE_CONFIRMED' && result.safe_zone_status === 'SAFE_ZONE') {
      finalStatus = 'READY_FOR_PLAN';
      finalReason = trendAction.action === 'HIGH_PRIORITY' || trendAction.action === 'MEDIUM_HIGH_PRIORITY'
        ? `${trendAction.reason} 可进入入场触发，不等于直接买入。`
        : '满足结构判断条件，可进入入场触发观察，但不代表直接买入。';
    } else {
      finalStatus = 'WAIT';
      const reasons: string[] = [];
      if (result.structure_status !== 'STRUCTURE_CONFIRMED') {
        reasons.push('结构未成立');
      }
      if (result.safe_zone_status !== 'SAFE_ZONE') {
        reasons.push('位置不在相对安全区');
      }
      finalReason = reasons.length > 0 ? reasons.join('，') + '，继续观察。' : '继续观察。';
    }

    const status = await getDataStatus(db, symbol);
    const availableSources = status.sources.map((s: any) => s.source);
    const mlPrediction = await getModelPrediction(db, symbol, assetType, 'structure');
    const candidateStateSync = isEntryMarketGateOpen(entryPermission)
      ? await syncManualStructureCheckCandidate(db, {
          candidateId: Number(req.body.candidate_id || req.body.candidateId || 0),
          symbol,
          assetType,
          source,
          name,
          planProfile,
          result,
          structureScore,
          trendPhase,
          marketRegime,
          entryPermission,
          finalStatus,
          finalReason,
          trendAction: trendAction.action
        })
      : {
          skipped: true,
          reason: finalReason || '市场总闸未通过，本次只返回结构快照，不同步候选池状态。'
        };

    res.json({
      success: true,
      data: {
        symbol,
        name,
        asset_type: assetType,
        plan_profile: planProfile.key,
        plan_profile_label: planProfile.label,
        plan_profile_note: planProfile.note,
        ...result,
	        structure_score: structureScore,
	        market_regime: marketRegime,
	        entry_permission: entryPermission,
	        market_regime_trade_date: marketRegimeResult?.trade_date || null,
	        market_regime_target_trade_date: marketRegimeResult?.target_trade_date || null,
	        market_regime_freshness_status: marketRegimeResult?.freshness_status || 'missing',
	        market_regime_freshness_reason: marketRegimeResult?.freshness_reason || '暂无市场总闸记录，已按观察处理。',
	        trend_phase_code: trendPhase?.trend_phase_code || 'UNKNOWN',
        trend_phase_reason: trendPhase?.trend_phase_reason || '暂无走势阶段数据，请先在走势阶段页执行重算。',
        trend_action: trendAction.action,
        trend_action_reason: trendAction.reason,
        opportunity_type: opportunityType,
        final_status: finalStatus,
	        final_reason: finalReason,
	        data_source_used: source,
	        available_sources: availableSources,
	        ml_prediction: mlPrediction,
	        candidate_state_sync: candidateStateSync
      }
    });
  } catch (error) {
    logRead(`结构判断失败: ${(error as Error).message}`, req.body.symbol, req.body.source);
    console.error('Error in structure check:', error);
    res.status(500).json({
      success: false,
      message: `结构判断失败: ${(error as Error).message}`
    });
  }
});

async function buildEntryTriggerSnapshot(db: any, symbol: string, assetType: string, source: string): Promise<any> {
  const prices = await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount
       FROM financial_daily_prices
       WHERE symbol = ? AND asset_type = ? AND source = ?
       ORDER BY trade_date ASC`,
    [symbol, assetType, source]
  );

  if (prices.length < 60) {
    return {
      symbol,
      name: symbol,
      asset_type: assetType,
      data_source_used: source,
      action: 'BLOCKED',
      action_label: '数据不足',
      trigger_score: 0,
      trigger_reason: `数据不足（当前${prices.length}条），需要至少60条日线数据。`,
      triggered_items: [],
      waiting_items: [],
      blocked_reasons: ['本地日线数据不足，无法生成入场触发。'],
      plan_draft: null,
      metrics: null
    };
  }

  const marketRegimeResult = await getFreshMarketRegime(db, { source });
  const marketRegime = marketRegimeResult?.market_regime || 'UNKNOWN';
  const entryPermission = marketRegimeResult?.entry_permission || 'OBSERVE_ONLY';
  const nameResult = await db.get(
      `SELECT name FROM financial_daily_prices
       WHERE symbol = ? AND asset_type = ? AND source = ? AND name IS NOT NULL AND TRIM(name) <> ''
       ORDER BY trade_date DESC LIMIT 1`,
    [symbol, assetType, source]
  );
  const universeResult = await db.get(
      `SELECT COALESCE(MAX(NULLIF(name, '')), '') as name,
              GROUP_CONCAT(DISTINCT universe_type) as universe_type
       FROM financial_asset_universe
       WHERE symbol = ? AND asset_type = ? AND source = ?`,
    [symbol, assetType, source]
  );
  const displayName = nameResult?.name || universeResult?.name || symbol;
  const planProfile = resolveFinancePlanProfile({
    assetType,
    symbol,
    name: displayName,
    universeType: universeResult?.universe_type || ''
  });
  const rawStructure = calculateStructure(prices, planProfile.key);
  const profileInvalidationLine = calculateProfileInvalidationLine(planProfile.key, { ma60: rawStructure.ma60 }) || rawStructure.invalidation_line;
  const structure = {
    ...rawStructure,
    invalidation_line: profileInvalidationLine
  };
  const structureScore = calculateStructureScore(structure, prices, planProfile.key);
  const trendPhase = await db.get(
      `SELECT trend_phase_code, trend_phase_reason
       FROM financial_trend_phase_results
       WHERE symbol = ? AND asset_type = ? AND source = ? AND rule_version = ?
       ORDER BY trade_date DESC LIMIT 1`,
    [symbol, assetType, source, TREND_PHASE_VERSION]
  );
  const trendAction = getTrendAction(trendPhase?.trend_phase_code, structureScore, structure);
  const opportunityType = classifyOpportunityType({
    asset_type: assetType,
    plan_profile: planProfile.key,
    structure_status: structure.structure_status,
    safe_zone_status: structure.safe_zone_status,
    trend_phase_code: trendPhase?.trend_phase_code || 'UNKNOWN',
    distance_to_ma60: structure.distance_to_ma60,
    above_ma60_days: structure.above_ma60_days,
    ma20_slope: structureScore.metrics.ma20_slope,
    ma60_slope: structureScore.metrics.ma60_slope,
    amplitude_20: structureScore.metrics.amplitude_20
  });
	  const triggerPlan = calculateEntryTriggerPlan(
	    structure,
	    structureScore,
	    prices,
	    marketRegime,
    entryPermission,
    trendPhase?.trend_phase_code || 'UNKNOWN',
	    trendAction.action,
	    planProfile.key
	  );
	  const effectiveTriggerPlan = marketRegimeResult?.stale
	    ? {
	        ...triggerPlan,
	        trigger_reason: marketRegimeResult.freshness_reason,
	        blocked_reasons: [
	          marketRegimeResult.freshness_reason,
	          ...(triggerPlan.blocked_reasons || []).filter((reason: string) => reason !== '市场权限未放行，当前只允许观察或等待修复。')
	        ]
	      }
	    : triggerPlan;
	  const mlPrediction = await getModelPrediction(db, symbol, assetType, 'entry_trigger');

  return {
    symbol,
    name: displayName,
    asset_type: assetType,
    universe_type: universeResult?.universe_type || '',
    plan_profile: planProfile.key,
    plan_profile_label: planProfile.label,
    plan_profile_note: planProfile.note,
    trade_date: structure.trade_date,
    close: structure.close,
    ma20: structure.ma20,
    ma60: structure.ma60,
	    invalidation_line: structure.invalidation_line,
	    market_regime: marketRegime,
	    entry_permission: entryPermission,
	    market_regime_trade_date: marketRegimeResult?.trade_date || null,
	    market_regime_target_trade_date: marketRegimeResult?.target_trade_date || null,
	    market_regime_freshness_status: marketRegimeResult?.freshness_status || 'missing',
	    market_regime_freshness_reason: marketRegimeResult?.freshness_reason || '暂无市场总闸记录，已按观察处理。',
	    structure_status: structure.structure_status,
    safe_zone_status: structure.safe_zone_status,
    structure_score: structureScore,
    trend_phase_code: trendPhase?.trend_phase_code || 'UNKNOWN',
    trend_phase_reason: trendPhase?.trend_phase_reason || '暂无走势阶段数据，请先在走势阶段页执行重算。',
    trend_action: trendAction.action,
    trend_action_reason: trendAction.reason,
    opportunity_type: opportunityType,
	    data_source_used: source,
	    ml_prediction: mlPrediction,
	    ...effectiveTriggerPlan
	  };
	}

router.post('/entry-trigger', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureEntryTriggerObservationSchema(db);
    const symbol = req.body.symbol;
    const assetType = req.body.asset_type;
    const source = req.body.source || 'tushare';

    if (!symbol || !assetType || !['stock', 'etf', 'index'].includes(assetType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid symbol or asset_type'
      });
    }

    const marketGateBlocker = await getEntryMarketGateBlocker(db, source);
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

    logRead(`入场触发请求: ${symbol} ${assetType} ${source}`, symbol, source);
    const snapshot = await buildEntryTriggerSnapshot(db, symbol, assetType, source);

    res.json({
      success: true,
      data: snapshot
    });
  } catch (error) {
    logRead(`入场触发失败: ${(error as Error).message}`, req.body.symbol, req.body.source);
    console.error('Error in entry trigger:', error);
    res.status(500).json({
      success: false,
      message: `入场触发失败: ${(error as Error).message}`
    });
  }
});

router.post('/entry-trigger-observations', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureEntryTriggerObservationSchema(db);
    const snapshot = req.body.snapshot;
    const note = String(req.body.note || '').trim();

    if (!snapshot || !snapshot.symbol || !['stock', 'etf', 'index'].includes(snapshot.asset_type)) {
      return res.status(400).json({
        success: false,
        message: '缺少有效的入场触发快照'
      });
    }

    if (!isEntryMarketGateOpen(snapshot.entry_permission)) {
      return res.status(423).json({
        success: false,
        message: `市场总闸未通过，禁止写入入场观察；本轮不修改观察队列：${snapshot.market_regime_freshness_reason || snapshot.trigger_reason || '市场总闸未开放单标的结构判断。'}`,
        data: {
          market_regime: snapshot.market_regime || null,
          entry_permission: snapshot.entry_permission || null,
          downstream_blocked: true
        }
      });
    }

    const now = new Date().toISOString();
    const observationValues = {
      symbol: snapshot.symbol,
      name: snapshot.name || snapshot.symbol,
      assetType: snapshot.asset_type,
      source: snapshot.data_source_used || req.body.source || 'tushare',
      tradeDate: snapshot.trade_date || null,
      observationStatus: 'watching',
      entryAction: snapshot.action || '',
      actionLabel: snapshot.action_label || '',
      triggerScore: snapshot.trigger_score || 0,
      triggerReason: snapshot.trigger_reason || '',
      structureScore: snapshot.structure_score?.score || null,
      trendPhaseCode: snapshot.trend_phase_code || '',
      marketRegime: snapshot.market_regime || '',
      entryPermission: snapshot.entry_permission || '',
      closePrice: snapshot.close || null,
      ma20: snapshot.ma20 || null,
      ma60: snapshot.ma60 || null,
      invalidationLine: snapshot.invalidation_line || null,
      snapshotJson: JSON.stringify(snapshot),
      note,
    };

    let existing = await db.get(
      `SELECT id FROM financial_entry_trigger_observations
       WHERE symbol = ? AND asset_type = ? AND source = ? AND trade_date = ? AND entry_action = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [
        observationValues.symbol,
        observationValues.assetType,
        observationValues.source,
        observationValues.tradeDate,
        observationValues.entryAction
      ]
    );
    if (!existing?.id) {
      existing = await db.get(
        `SELECT id FROM financial_entry_trigger_observations
         WHERE symbol = ? AND asset_type = ? AND source = ?
           AND observation_status IN ('watching', 'plan_candidate', 'confirmed')
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [
          observationValues.symbol,
          observationValues.assetType,
          observationValues.source
        ]
      );
    }

    let observationId = existing?.id;
    if (existing?.id) {
      await db.run(
        `UPDATE financial_entry_trigger_observations
         SET name = ?,
             trade_date = ?,
             observation_status = ?,
             entry_action = ?,
             action_label = ?,
             trigger_score = ?,
             trigger_reason = ?,
             structure_score = ?,
             trend_phase_code = ?,
             market_regime = ?,
             entry_permission = ?,
             close_price = ?,
             ma20 = ?,
             ma60 = ?,
             invalidation_line = ?,
             snapshot_json = ?,
             note = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          observationValues.name,
          observationValues.tradeDate,
          observationValues.observationStatus,
          observationValues.entryAction,
          observationValues.actionLabel,
          observationValues.triggerScore,
          observationValues.triggerReason,
          observationValues.structureScore,
          observationValues.trendPhaseCode,
          observationValues.marketRegime,
          observationValues.entryPermission,
          observationValues.closePrice,
          observationValues.ma20,
          observationValues.ma60,
          observationValues.invalidationLine,
          observationValues.snapshotJson,
          observationValues.note,
          now,
          existing.id
        ]
      );
    } else {
      const result = await db.run(
        `INSERT INTO financial_entry_trigger_observations (
          symbol, name, asset_type, source, trade_date, observation_status,
          entry_action, action_label, trigger_score, trigger_reason,
          structure_score, trend_phase_code, market_regime, entry_permission,
          close_price, ma20, ma60, invalidation_line, snapshot_json, note,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          observationValues.symbol,
          observationValues.name,
          observationValues.assetType,
          observationValues.source,
          observationValues.tradeDate,
          observationValues.observationStatus,
          observationValues.entryAction,
          observationValues.actionLabel,
          observationValues.triggerScore,
          observationValues.triggerReason,
          observationValues.structureScore,
          observationValues.trendPhaseCode,
          observationValues.marketRegime,
          observationValues.entryPermission,
          observationValues.closePrice,
          observationValues.ma20,
          observationValues.ma60,
          observationValues.invalidationLine,
          observationValues.snapshotJson,
          observationValues.note,
          now,
          now
        ]
      );
      observationId = result.lastID;
    }

    const observation = await db.get(
      `SELECT * FROM financial_entry_trigger_observations WHERE id = ?`,
      [observationId]
    );
    await recordSignalLifecycleCheck(db, {
      symbol: observationValues.symbol,
      name: observationValues.name,
      assetType: observationValues.assetType,
      source: observationValues.source,
      observationId: observationId ? Number(observationId) : null,
      observationStatus: observationValues.observationStatus,
      candidateReviewStatus: null,
      scanConclusion: existing?.id ? '入场观察更新' : '入场观察保存',
      snapshot
    });

    res.json({
      success: true,
      message: existing?.id ? '入场观察已更新' : '入场观察已保存',
      data: observation
    });
  } catch (error) {
    console.error('Error saving entry trigger observation:', error);
    res.status(500).json({
      success: false,
      message: `保存入场观察失败: ${(error as Error).message}`
    });
  }
});

router.get('/entry-trigger-observations', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureEntryTriggerObservationSchema(db);
    const symbol = String(req.query.symbol || '').trim();
    const assetType = String(req.query.asset_type || '').trim();
    const source = String(req.query.source || '').trim();
    const keyword = String(req.query.q || '').trim();
    const requestedLimit = Math.min(Number(req.query.limit || 30), 100);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const rawObservationScope = String(req.query.observation_scope || '').trim();
    const observationScope: EntryObservationScope | '' = ['actionable', 'risk_priority_recheck', 'watching', 'confirmed', 'invalidated', 'returned', 'resolved', 'all'].includes(rawObservationScope)
      ? rawObservationScope as EntryObservationScope
      : '';

    const baseParams: any[] = [];
    let baseWhere = 'WHERE 1 = 1';
    if (symbol) {
      baseWhere += ' AND symbol = ?';
      baseParams.push(symbol);
    }
    if (assetType) {
      baseWhere += ' AND asset_type = ?';
      baseParams.push(assetType);
    }
    if (source) {
      baseWhere += ' AND source = ?';
      baseParams.push(source);
    }
    if (keyword) {
      baseWhere += ` AND (symbol LIKE ? OR COALESCE(name, '') LIKE ?)`;
      baseParams.push(`%${keyword}%`, `%${keyword}%`);
    }
    const observationStatus = String(req.query.observation_status || '').trim();
    const activeScope = String(req.query.status_scope || '').trim() === 'active';
    const scopedToCurrentQueue = Boolean(observationStatus) || activeScope || Boolean(observationScope);
    const outerParams: any[] = [];
    let outerWhere = 'WHERE o.rn = 1';
    if (observationStatus) {
      if (observationStatus === 'confirmed') {
        outerWhere += " AND o.observation_status IN ('confirmed', 'plan_candidate')";
      } else {
        outerWhere += ' AND o.observation_status = ?';
        outerParams.push(observationStatus);
      }
    } else if (observationScope) {
      if (observationScope === 'actionable') {
        outerWhere += " AND o.observation_status IN ('watching', 'plan_candidate')";
      } else if (observationScope === 'risk_priority_recheck') {
        outerWhere += " AND o.observation_status IN ('watching', 'plan_candidate')";
      } else if (observationScope === 'watching') {
        outerWhere += " AND o.observation_status = 'watching'";
      } else if (observationScope === 'confirmed') {
        outerWhere += " AND o.observation_status IN ('confirmed', 'plan_candidate')";
      } else if (observationScope === 'invalidated') {
        outerWhere += " AND o.observation_status = 'invalidated'";
      } else if (observationScope === 'returned') {
        outerWhere += " AND o.observation_status = 'returned'";
      } else if (observationScope === 'resolved') {
        outerWhere += " AND o.observation_status IN ('confirmed', 'invalidated', 'planned', 'returned')";
      }
    } else if (activeScope) {
      outerWhere += " AND o.observation_status IN ('watching', 'plan_candidate')";
    }
    const excludeExistingPlan = String(req.query.exclude_existing_plan || '').trim() === '1';
    if (excludeExistingPlan) {
      outerWhere += ` AND NOT EXISTS (
        SELECT 1
        FROM financial_trade_plans p
        WHERE p.symbol = o.symbol
          AND p.asset_type = o.asset_type
          AND p.source = o.source
          AND p.is_deleted = 0
	          AND p.status IN ('draft', 'watching', 'paper_tracking', 'active')
      )`;
    }
    const shouldPageAfterHydration = observationStatus === 'confirmed'
      || ['actionable', 'risk_priority_recheck', 'watching'].includes(observationScope);
    let queryLimit = requestedLimit;
    const queryOffset = shouldPageAfterHydration ? 0 : offset;
    const rankedObservationSql = `
      WITH ranked_observations AS (
        SELECT
          financial_entry_trigger_observations.*,
          ROW_NUMBER() OVER (
            PARTITION BY symbol, asset_type, source
            ORDER BY updated_at DESC, id DESC
          ) AS rn
        FROM financial_entry_trigger_observations
        ${baseWhere}
      )
    `;
    const summaryRows = await db.all(
      `${rankedObservationSql}
       SELECT o.observation_status, COUNT(*) AS total
       FROM ranked_observations o
       WHERE o.rn = 1
       GROUP BY o.observation_status`,
      [...baseParams]
    );
    const summary = {
      actionable: 0,
      watching: 0,
      plan_candidate: 0,
      confirmed: 0,
      invalidated: 0,
      planned: 0,
      returned: 0,
      resolved: 0,
      all: 0
    };
    summaryRows.forEach((row: any) => {
      const statusKey = String(row.observation_status || '');
      const total = Number(row.total || 0);
      if (statusKey in summary) {
        summary[statusKey as keyof typeof summary] += total;
      }
      if (statusKey === 'watching' || statusKey === 'plan_candidate') summary.actionable += total;
      if (['confirmed', 'invalidated', 'planned', 'returned'].includes(statusKey)) summary.resolved += total;
      summary.all += total;
    });
    const activeQueueRows = await db.all(
      `${rankedObservationSql}
       SELECT *
       FROM ranked_observations o
       WHERE o.rn = 1
         AND o.observation_status IN ('watching', 'plan_candidate', 'confirmed')`,
      [...baseParams]
    );
    const activeLifecycleMap = await loadLatestSignalLifecycleMap(db, activeQueueRows);
    const queueSummary = buildObservationQueueSummary(activeQueueRows.map((row: any) => {
      const snapshot = parseJson(row.snapshot_json, null);
      const lifecycle = activeLifecycleMap.get(entryObservationKey(row));
      return buildEntryObservationQueueInfo(row, snapshot, lifecycle);
    }));
    const totalRow = scopedToCurrentQueue || excludeExistingPlan
      ? await db.get(
          `${rankedObservationSql}
           SELECT COUNT(*) as total
           FROM ranked_observations o
           ${outerWhere}`,
          [...baseParams, ...outerParams]
        )
      : await db.get(
          `SELECT COUNT(*) as total
           FROM financial_entry_trigger_observations
           ${baseWhere}`,
          [...baseParams]
        );

    if (shouldPageAfterHydration) {
      queryLimit = Math.max(Number(totalRow?.total || 0), requestedLimit);
    }

    let items = scopedToCurrentQueue || excludeExistingPlan
      ? await db.all(
          `${rankedObservationSql}
           SELECT *
           FROM ranked_observations o
           ${outerWhere}
           ORDER BY updated_at DESC, created_at DESC, id DESC
           LIMIT ? OFFSET ?`,
          [...baseParams, ...outerParams, queryLimit, queryOffset]
        )
      : await db.all(
          `SELECT *
           FROM financial_entry_trigger_observations
           ${baseWhere}
           ORDER BY updated_at DESC, created_at DESC, id DESC
           LIMIT ? OFFSET ?`,
          [...baseParams, requestedLimit, offset]
        );
    for (const item of items) {
      const existingPlan = await db.get(
        `SELECT id, plan_name, status, total_capital, updated_at
         FROM financial_trade_plans
         WHERE symbol = ?
           AND asset_type = ?
           AND source = ?
           AND is_deleted = 0
	           AND status IN ('draft', 'watching', 'paper_tracking', 'active')
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [item.symbol, item.asset_type, item.source]
      );
      item.has_existing_plan = existingPlan ? 1 : 0;
      item.existing_plan = existingPlan || null;
    }
    const lifecycleByKey = await loadLatestSignalLifecycleMap(db, items);
    items = await Promise.all(items.map(async (item: any) => {
      const snapshot = parseJson(item.snapshot_json, null);
      const { snapshot_json: _snapshotJson, ...itemWithoutRawSnapshot } = item;
      const queueInfo = buildEntryObservationQueueInfo(item, snapshot, lifecycleByKey.get(entryObservationKey(item)));
      const close = Number(item.close_price);
      const invalidation = Number(item.invalidation_line);
      const ma60 = Number(item.ma60);
      const rawMaxLossPercent = Number.isFinite(close) && close > 0 && Number.isFinite(invalidation) && invalidation > 0
        ? (close - invalidation) / close
        : null;
      const maxLossPercent = rawMaxLossPercent !== null ? Math.max(0, rawMaxLossPercent) : null;
      const distanceToMa60 = Number.isFinite(close) && close > 0 && Number.isFinite(ma60) && ma60 > 0
        ? (close - ma60) / ma60
        : null;
      const opportunityType = snapshot?.opportunity_type || classifyOpportunityType({
        asset_type: item.asset_type,
        plan_profile: snapshot?.plan_profile || snapshot?.plan_draft?.plan_profile || item.plan_profile,
        structure_status: snapshot?.structure_status,
        safe_zone_status: snapshot?.safe_zone_status,
        trend_phase_code: item.trend_phase_code,
        distance_to_ma60: snapshot?.metrics?.distance_to_ma60 ?? distanceToMa60,
        above_ma60_days: snapshot?.above_ma60_days,
        ma20_slope: snapshot?.structure_score?.metrics?.ma20_slope,
        ma60_slope: snapshot?.structure_score?.metrics?.ma60_slope,
        amplitude_20: snapshot?.structure_score?.metrics?.amplitude_20
      });
      const planValueMetrics = await buildPlanReadyValueMetrics(db, item, snapshot, maxLossPercent);
      const planQuality = planValueMetrics.plan_quality;
      const planProfileKey = snapshot?.plan_profile || snapshot?.plan_draft?.plan_profile || item.plan_profile;
      return {
        ...itemWithoutRawSnapshot,
        ...queueInfo,
        opportunity_type: opportunityType,
        max_loss_percent: maxLossPercent,
        target_price: planValueMetrics.target_price,
        target_source: planValueMetrics.target_source,
        target_space_percent: planValueMetrics.target_space_percent,
        downside_risk_percent: planValueMetrics.downside_risk_percent,
        risk_reward_ratio: planValueMetrics.risk_reward_ratio,
        pressure_distance_percent: planValueMetrics.target_space_percent,
        plan_quality: planQuality,
        plan_quality_score: planQuality.score,
        plan_quality_label: planQuality.label,
        plan_quality_action: planQuality.action,
        manual_priority_level: getEntryManualPriorityLevel(
          item.trend_phase_code,
          Number(item.trigger_score || 0),
          Number(item.structure_score || 0),
          maxLossPercent,
          planProfileKey
        ),
        manual_priority_score: getEntryManualPriorityScore(
          item.trend_phase_code,
          Number(item.trigger_score || 0),
          Number(item.structure_score || 0),
          maxLossPercent,
          planProfileKey
        ),
        trend_priority_rank: getEntryTrendPriority(item.trend_phase_code)
      };
    }));
    let responseTotal = Number(totalRow?.total || 0);
    if (observationScope === 'risk_priority_recheck') {
      items = items
        .filter((item: any) => item.observation_queue_bucket === 'risk_priority_recheck')
        .sort(compareObservationQueueItems);
      responseTotal = items.length;
      items = items.slice(offset, offset + requestedLimit);
    } else if (['actionable', 'watching'].includes(observationScope)) {
      items = items.sort(compareObservationQueueItems);
      items = items.slice(offset, offset + requestedLimit);
    } else if (observationStatus === 'confirmed') {
      items.sort((a: any, b: any) => {
        if (Number(b.plan_quality_score || 0) !== Number(a.plan_quality_score || 0)) {
          return Number(b.plan_quality_score || 0) - Number(a.plan_quality_score || 0);
        }
        if (Number(b.risk_reward_ratio || 0) !== Number(a.risk_reward_ratio || 0)) {
          return Number(b.risk_reward_ratio || 0) - Number(a.risk_reward_ratio || 0);
        }
        if (Number(b.target_space_percent || 0) !== Number(a.target_space_percent || 0)) {
          return Number(b.target_space_percent || 0) - Number(a.target_space_percent || 0);
        }
        if (b.manual_priority_score !== a.manual_priority_score) {
          return b.manual_priority_score - a.manual_priority_score;
        }
        if (a.trend_priority_rank !== b.trend_priority_rank) {
          return a.trend_priority_rank - b.trend_priority_rank;
        }
        if (Number(b.trigger_score || 0) !== Number(a.trigger_score || 0)) {
          return Number(b.trigger_score || 0) - Number(a.trigger_score || 0);
        }
        return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
      });
      const seen = new Set<string>();
      items = items.filter((item: any) => {
        const key = `${item.symbol}|${item.asset_type}|${item.source}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      items = items.slice(offset, offset + requestedLimit);
    }

    res.json({
      success: true,
      data: {
        items,
        total: responseTotal,
        limit: requestedLimit,
        offset,
        observation_scope: observationScope || (activeScope ? 'actionable' : 'raw'),
        summary: {
          ...summary,
          queue_plan_ready: queueSummary.plan_ready,
          queue_ready_to_plan: queueSummary.ready_to_plan,
          queue_risk_priority_recheck: queueSummary.risk_priority_recheck,
          queue_lifecycle_recheck: queueSummary.lifecycle_recheck,
          queue_risk_hold: queueSummary.risk_hold,
          queue_wait_pullback: queueSummary.wait_pullback,
          queue_waiting_trigger: queueSummary.waiting_trigger,
          queue_should_auto_advance: queueSummary.should_auto_advance
        },
        queue_summary: queueSummary
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `获取入场观察记录失败: ${(error as Error).message}`
    });
  }
});

router.post('/entry-trigger-observations/secondary-scan', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureEntryTriggerObservationSchema(db);
    const limit = Math.min(Number(req.body.limit || 50), 200);
    const now = new Date().toISOString();
    const symbolFilter = String(req.body.symbol || '').trim();
    const assetTypeFilter = String(req.body.asset_type || '').trim();
    const sourceFilter = String(req.body.source || '').trim();
    const marketGateBlocker = await getEntryMarketGateBlocker(db, sourceFilter || 'tushare');
    if (marketGateBlocker) {
      return res.status(423).json({
        success: false,
        message: marketGateBlocker.message,
        data: {
          market_gate: marketGateBlocker.marketGate,
          downstream_blocked: true,
          checked_count: 0,
          upgraded_count: 0,
          invalidated_count: 0,
          returned_count: 0,
          results: []
        }
      });
    }
    const targetFilters: string[] = [];
    const targetParams: any[] = [];
    if (symbolFilter) {
      targetFilters.push('symbol = ?');
      targetParams.push(symbolFilter);
    }
    if (assetTypeFilter) {
      targetFilters.push('asset_type = ?');
      targetParams.push(assetTypeFilter);
    }
    if (sourceFilter) {
      targetFilters.push('source = ?');
      targetParams.push(sourceFilter);
    }
    const targetFilterSql = targetFilters.length > 0 ? ` AND ${targetFilters.join(' AND ')}` : '';

    const observationRows = await db.all(
      `SELECT id, symbol, name, asset_type, source, observation_status
       FROM financial_entry_trigger_observations
       WHERE observation_status IN ('watching', 'plan_candidate', 'confirmed')
         ${targetFilterSql}
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
      [...targetParams, limit]
    );

    const candidateRows = await db.all(
      `SELECT id, symbol, name, asset_type, source, review_status
       FROM financial_candidate_pool
       WHERE pool_status = 'active' AND review_status IN ('wait_confirmation', 'plan_ready')
         ${targetFilterSql}
       ORDER BY last_review_at DESC, id DESC
       LIMIT ?`,
      [...targetParams, limit]
    );

    const targets = new Map<string, any>();
    observationRows.forEach((row: any) => {
      const key = `${row.symbol}|${row.asset_type}|${row.source}`;
      const target = targets.get(key) || {
        symbol: row.symbol,
        name: row.name,
        asset_type: row.asset_type,
        source: row.source,
        observation_ids: [],
        candidate_ids: []
      };
      target.observation_ids.push(row.id);
      targets.set(key, target);
    });
    candidateRows.forEach((row: any) => {
      const key = `${row.symbol}|${row.asset_type}|${row.source}`;
      const target = targets.get(key) || {
        symbol: row.symbol,
        name: row.name,
        asset_type: row.asset_type,
        source: row.source,
        observation_ids: [],
        candidate_ids: []
      };
      target.candidate_ids.push(row.id);
      targets.set(key, target);
    });

    const results: any[] = [];
    for (const target of Array.from(targets.values()).slice(0, limit)) {
      const snapshot = await buildEntryTriggerSnapshot(db, target.symbol, target.asset_type, target.source);
      const trendUnknown = !snapshot.trend_phase_code || snapshot.trend_phase_code === 'UNKNOWN';
      const invalidated = isEntrySnapshotInvalidated(snapshot);
      const rawCanUpgrade = snapshot.action === 'READY_TO_PLAN' && !trendUnknown && !invalidated;
      const rawCandidateDecision = resolveCandidateStatusAfterEntryScan(snapshot, invalidated, rawCanUpgrade);
      const rawReturnedToUpstream = rawCandidateDecision.reviewStatus === 'trend_blocked' || rawCandidateDecision.reviewStatus === 'structure_watch';
      const provisionalStatus = invalidated ? 'invalidated' : rawReturnedToUpstream ? 'returned' : 'watching';
      const observationIds = [...target.observation_ids];
      if (observationIds.length === 0) {
        const existingRows = await db.all(
          `SELECT id
           FROM financial_entry_trigger_observations
           WHERE symbol = ?
             AND asset_type = ?
             AND source = ?
             AND observation_status IN ('watching', 'plan_candidate', 'confirmed')
           ORDER BY updated_at DESC, id DESC`,
          [target.symbol, target.asset_type, target.source]
        );
        observationIds.push(...existingRows.map((row: any) => Number(row.id)));
      }
      const lifecycle = await recordSignalLifecycleCheck(db, {
        symbol: target.symbol,
        name: snapshot.name || target.name,
        assetType: target.asset_type,
        source: target.source,
        observationId: observationIds[0] ? Number(observationIds[0]) : null,
        observationStatus: provisionalStatus,
        candidateReviewStatus: rawCandidateDecision.reviewStatus,
        scanConclusion: rawCandidateDecision.conclusion,
        snapshot
      });
      const canUpgrade = rawCanUpgrade && signalLifecycleAllowsPlan(lifecycle);
      const candidateDecision = applySignalLifecycleGate(
        resolveCandidateStatusAfterEntryScan(snapshot, invalidated, canUpgrade),
        lifecycle,
        rawCanUpgrade,
        invalidated
      );
      const returnedToUpstream = candidateDecision.reviewStatus === 'trend_blocked' || candidateDecision.reviewStatus === 'structure_watch';
      const status = invalidated ? 'invalidated' : canUpgrade ? 'confirmed' : returnedToUpstream ? 'returned' : 'watching';
      const candidateReviewStatus = candidateDecision.reviewStatus;
      const scanConclusion = candidateDecision.conclusion;
      const lifecycleHoldingReady = rawCanUpgrade && !canUpgrade && !invalidated && status === 'watching';
      const observationAction = status === 'returned'
        ? 'OBSERVE'
        : status === 'invalidated'
          ? (snapshot.action === 'BLOCKED' ? 'BLOCKED' : 'INVALIDATED')
          : lifecycleHoldingReady
            ? 'OBSERVE'
          : (snapshot.action || '');
      const observationActionLabel = status === 'returned'
        ? '退回单标的判断'
        : status === 'invalidated'
          ? '失效/阻断'
          : lifecycleHoldingReady
            ? '生命周期观察'
          : (snapshot.action_label || '');

      if (observationIds.length > 0) {
        await db.run(
          `UPDATE financial_entry_trigger_observations
           SET observation_status = ?,
               trade_date = ?,
               entry_action = ?,
               action_label = ?,
               trigger_score = ?,
               trigger_reason = ?,
               structure_score = ?,
               trend_phase_code = ?,
               market_regime = ?,
               entry_permission = ?,
               close_price = ?,
               ma20 = ?,
               ma60 = ?,
               invalidation_line = ?,
               snapshot_json = ?,
               note = ?,
               updated_at = ?
           WHERE id IN (${observationIds.map(() => '?').join(',')})`,
          [
            status,
            snapshot.trade_date || null,
            observationAction,
            observationActionLabel,
            snapshot.trigger_score || 0,
            snapshot.trigger_reason || '',
            snapshot.structure_score?.score || null,
            snapshot.trend_phase_code || '',
            snapshot.market_regime || '',
            snapshot.entry_permission || '',
            snapshot.close || null,
            snapshot.ma20 || null,
            snapshot.ma60 || null,
            snapshot.invalidation_line || null,
            JSON.stringify(snapshot),
            `二次确认扫描：${scanConclusion}`,
            now,
            ...observationIds
          ]
        );
      } else {
        const inserted = await db.run(
          `INSERT INTO financial_entry_trigger_observations (
            symbol, name, asset_type, source, trade_date, observation_status,
            entry_action, action_label, trigger_score, trigger_reason,
            structure_score, trend_phase_code, market_regime, entry_permission,
            close_price, ma20, ma60, invalidation_line, snapshot_json, note,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            target.symbol,
            snapshot.name || target.name || target.symbol,
            target.asset_type,
            snapshot.data_source_used || target.source,
            snapshot.trade_date || null,
            status,
            observationAction,
            observationActionLabel,
            snapshot.trigger_score || 0,
            snapshot.trigger_reason || '',
            snapshot.structure_score?.score || null,
            snapshot.trend_phase_code || '',
            snapshot.market_regime || '',
            snapshot.entry_permission || '',
            snapshot.close || null,
            snapshot.ma20 || null,
            snapshot.ma60 || null,
            snapshot.invalidation_line || null,
            JSON.stringify(snapshot),
            `二次确认扫描：${scanConclusion}`,
            now,
            now
          ]
        );
        if (inserted.lastID) observationIds.push(Number(inserted.lastID));
      }

      if (target.candidate_ids.length > 0) {
        await db.run(
	          `UPDATE financial_candidate_pool
	           SET review_status = ?,
	               pool_status = ?,
	               final_status = ?,
	               trade_date = COALESCE(?, trade_date),
	               close = COALESCE(?, close),
	               ma20 = COALESCE(?, ma20),
	               ma60 = COALESCE(?, ma60),
	               invalidation_line = COALESCE(?, invalidation_line),
	               trend_phase_code = COALESCE(NULLIF(?, ''), trend_phase_code),
	               trend_phase_reason = COALESCE(NULLIF(?, ''), trend_phase_reason),
	               market_regime = COALESCE(NULLIF(?, ''), market_regime),
	               entry_permission = COALESCE(NULLIF(?, ''), entry_permission),
	               last_checked_at = ?,
	               last_review_at = ?,
               review_action = ?,
               candidate_reason = ?,
               forbidden_reason = CASE WHEN ? = 1 THEN ? ELSE forbidden_reason END,
               updated_at = ?
           WHERE id IN (${target.candidate_ids.map(() => '?').join(',')})`,
          [
	            candidateReviewStatus,
	            candidateDecision.poolStatus,
	            candidateDecision.finalStatus,
	            snapshot.trade_date || null,
	            snapshot.close || null,
	            snapshot.ma20 || null,
	            snapshot.ma60 || null,
	            snapshot.invalidation_line || null,
	            snapshot.trend_phase_code || '',
	            snapshot.trend_phase_reason || '',
	            snapshot.market_regime || '',
	            snapshot.entry_permission || '',
	            now,
	            now,
            candidateDecision.reviewAction,
            snapshot.trigger_reason || scanConclusion,
            invalidated ? 1 : 0,
            invalidated ? snapshot.trigger_reason || '入场触发失效淘汰' : null,
            now,
            ...target.candidate_ids
          ]
        );
      }

      await recordSignalLifecycleCheck(db, {
        symbol: target.symbol,
        name: snapshot.name || target.name,
        assetType: target.asset_type,
        source: target.source,
        observationId: observationIds[0] ? Number(observationIds[0]) : null,
        observationStatus: status,
        candidateReviewStatus,
        scanConclusion,
        snapshot
      });

      results.push({
        symbol: target.symbol,
        name: snapshot.name || target.name,
        asset_type: target.asset_type,
        source: target.source,
        observation_ids: observationIds,
        candidate_ids: target.candidate_ids,
        conclusion: scanConclusion,
        observation_status: status,
        candidate_review_status: candidateReviewStatus,
        action: snapshot.action,
        action_label: snapshot.action_label,
        trigger_score: snapshot.trigger_score,
        trend_phase_code: snapshot.trend_phase_code,
        close: snapshot.close,
        invalidation_line: snapshot.invalidation_line,
        reason: snapshot.trigger_reason
      });
    }

    const summary = {
      checked: results.length,
      upgraded: results.filter(item => item.conclusion === '可升级计划准备').length,
      waiting: results.filter(item => ['继续等待', '复核中继续观察'].includes(item.conclusion) || String(item.conclusion || '').endsWith('仅观察')).length,
      returned: results.filter(item => String(item.conclusion || '').startsWith('退回')).length,
      invalidated: results.filter(item => item.conclusion === '失效淘汰').length
    };

    res.json({
      success: true,
      message: `二次确认扫描完成：检查 ${summary.checked} 个，升级 ${summary.upgraded} 个，继续等待 ${summary.waiting} 个，退回 ${summary.returned} 个，失效 ${summary.invalidated} 个。`,
      data: { summary, results }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `二次确认扫描失败: ${(error as Error).message}`
    });
  }
});

router.post('/entry-trigger-observations/:id/secondary-scan', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureEntryTriggerObservationSchema(db);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '无效的观察记录ID' });
    }

    const observation = await db.get(
      `SELECT * FROM financial_entry_trigger_observations WHERE id = ?`,
      [id]
    );
    if (!observation) {
      return res.status(404).json({ success: false, message: '入场观察记录不存在' });
    }

    const now = new Date().toISOString();
    const marketGateBlocker = await getEntryMarketGateBlocker(db, observation.source || 'tushare');
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
    const snapshot = await buildEntryTriggerSnapshot(db, observation.symbol, observation.asset_type, observation.source);
    const trendUnknown = !snapshot.trend_phase_code || snapshot.trend_phase_code === 'UNKNOWN';
    const invalidated = isEntrySnapshotInvalidated(snapshot);
    const rawCanUpgrade = snapshot.action === 'READY_TO_PLAN' && !trendUnknown && !invalidated;
    const rawCandidateDecision = resolveCandidateStatusAfterEntryScan(snapshot, invalidated, rawCanUpgrade);
    const rawReturnedToUpstream = rawCandidateDecision.reviewStatus === 'trend_blocked' || rawCandidateDecision.reviewStatus === 'structure_watch';
    const provisionalStatus = invalidated ? 'invalidated' : rawReturnedToUpstream ? 'returned' : 'watching';
    const lifecycle = await recordSignalLifecycleCheck(db, {
      symbol: observation.symbol,
      name: snapshot.name || observation.name,
      assetType: observation.asset_type,
      source: observation.source,
      observationId: id,
      observationStatus: provisionalStatus,
      candidateReviewStatus: rawCandidateDecision.reviewStatus,
      scanConclusion: rawCandidateDecision.conclusion,
      snapshot
    });
    const canUpgrade = rawCanUpgrade && signalLifecycleAllowsPlan(lifecycle);
    const candidateDecision = applySignalLifecycleGate(
      resolveCandidateStatusAfterEntryScan(snapshot, invalidated, canUpgrade),
      lifecycle,
      rawCanUpgrade,
      invalidated
    );
    const returnedToUpstream = candidateDecision.reviewStatus === 'trend_blocked' || candidateDecision.reviewStatus === 'structure_watch';
    const status = invalidated ? 'invalidated' : canUpgrade ? 'confirmed' : returnedToUpstream ? 'returned' : 'watching';
    const candidateReviewStatus = candidateDecision.reviewStatus;
    const conclusion = candidateDecision.conclusion;
    const lifecycleHoldingReady = rawCanUpgrade && !canUpgrade && !invalidated && status === 'watching';
    const observationAction = status === 'returned'
      ? 'OBSERVE'
      : status === 'invalidated'
        ? (snapshot.action === 'BLOCKED' ? 'BLOCKED' : 'INVALIDATED')
        : lifecycleHoldingReady
          ? 'OBSERVE'
        : (snapshot.action || '');
    const observationActionLabel = status === 'returned'
      ? '退回单标的判断'
      : status === 'invalidated'
        ? '失效/阻断'
        : lifecycleHoldingReady
          ? '生命周期观察'
        : (snapshot.action_label || '');

    await db.run(
      `UPDATE financial_entry_trigger_observations
       SET observation_status = ?,
           trade_date = ?,
           entry_action = ?,
           action_label = ?,
           trigger_score = ?,
           trigger_reason = ?,
           structure_score = ?,
           trend_phase_code = ?,
           market_regime = ?,
           entry_permission = ?,
           close_price = ?,
           ma20 = ?,
           ma60 = ?,
           invalidation_line = ?,
           snapshot_json = ?,
           note = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        status,
        snapshot.trade_date || null,
        observationAction,
        observationActionLabel,
        snapshot.trigger_score || 0,
        snapshot.trigger_reason || '',
        snapshot.structure_score?.score || null,
        snapshot.trend_phase_code || '',
        snapshot.market_regime || '',
        snapshot.entry_permission || '',
        snapshot.close || null,
        snapshot.ma20 || null,
        snapshot.ma60 || null,
        snapshot.invalidation_line || null,
        JSON.stringify(snapshot),
        `单条二次确认：${conclusion}`,
        now,
        id
      ]
    );

    await db.run(
	      `UPDATE financial_candidate_pool
	       SET review_status = ?,
	           pool_status = ?,
	           final_status = ?,
	           trade_date = COALESCE(?, trade_date),
	           close = COALESCE(?, close),
	           ma20 = COALESCE(?, ma20),
	           ma60 = COALESCE(?, ma60),
	           invalidation_line = COALESCE(?, invalidation_line),
	           trend_phase_code = COALESCE(NULLIF(?, ''), trend_phase_code),
	           trend_phase_reason = COALESCE(NULLIF(?, ''), trend_phase_reason),
	           market_regime = COALESCE(NULLIF(?, ''), market_regime),
	           entry_permission = COALESCE(NULLIF(?, ''), entry_permission),
	           last_checked_at = ?,
	           last_review_at = ?,
           review_action = ?,
           candidate_reason = ?,
           forbidden_reason = CASE WHEN ? = 1 THEN ? ELSE forbidden_reason END,
           updated_at = ?
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND pool_status = 'active'
         AND review_status IN ('wait_confirmation', 'plan_ready', 'unreviewed', 'structure_ready', 'structure_watch')`,
      [
	        candidateReviewStatus,
	        candidateDecision.poolStatus,
	        candidateDecision.finalStatus,
	        snapshot.trade_date || null,
	        snapshot.close || null,
	        snapshot.ma20 || null,
	        snapshot.ma60 || null,
	        snapshot.invalidation_line || null,
	        snapshot.trend_phase_code || '',
	        snapshot.trend_phase_reason || '',
	        snapshot.market_regime || '',
	        snapshot.entry_permission || '',
	        now,
	        now,
        candidateDecision.reviewAction,
        snapshot.trigger_reason || conclusion,
        invalidated ? 1 : 0,
        invalidated ? snapshot.trigger_reason || '入场触发失效淘汰' : null,
        now,
        observation.symbol,
        observation.asset_type,
        observation.source
      ]
    );

    await recordSignalLifecycleCheck(db, {
      symbol: observation.symbol,
      name: snapshot.name || observation.name,
      assetType: observation.asset_type,
      source: observation.source,
      observationId: id,
      observationStatus: status,
      candidateReviewStatus,
      scanConclusion: conclusion,
      snapshot
    });

    const saved = await db.get(
      `SELECT * FROM financial_entry_trigger_observations WHERE id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: `二次确认完成：${conclusion}`,
      data: {
        conclusion,
        observation: saved,
        snapshot
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `单条二次确认失败: ${(error as Error).message}`
    });
  }
});

router.post('/entry-trigger-observations/:id/manual-review', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureEntryTriggerObservationSchema(db);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '无效的观察记录ID' });
    }

    const action = String(req.body.action || '').trim();
    const actionMap: Record<string, { label: string; note: string; candidateAction: string }> = {
      continue_observe: {
        label: '人工继续观察',
        note: '保留观察记录，等待后续自动流水线重新确认。',
        candidateAction: 'entry_trigger_manual_continue_observe'
      },
      wait_next_day: {
        label: '等下一日确认',
        note: '今天不进计划，下一交易日继续优先复核。',
        candidateAction: 'entry_trigger_manual_wait_next_day'
      },
      return_risk_hold: {
        label: '人工退回风险观察',
        note: '生命周期仍有真实翻转，先不占高触发优先位。',
        candidateAction: 'entry_trigger_manual_risk_hold'
      }
    };
    const actionConfig = actionMap[action];
    if (!actionConfig) {
      return res.status(400).json({ success: false, message: '无效的人工复核动作' });
    }

    const observation = await db.get(
      `SELECT *
       FROM financial_entry_trigger_observations
       WHERE id = ?`,
      [id]
    );
    if (!observation) {
      return res.status(404).json({ success: false, message: '入场观察记录不存在' });
    }
    if (observation.observation_status !== 'watching') {
      return res.status(409).json({
        success: false,
        message: '只有观察中的记录可以做人工复核分流；已确认/归档记录请在对应队列处理。'
      });
    }

    const marketGateBlocker = await getEntryMarketGateBlocker(db, observation.source || 'tushare');
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

    const now = new Date().toISOString();
    const manualNote = String(req.body.note || '').trim() || actionConfig.note;
    await db.run(
      `UPDATE financial_entry_trigger_observations
       SET observation_status = 'watching',
           manual_review_action = ?,
           manual_review_label = ?,
           manual_review_note = ?,
           manual_reviewed_at = ?,
           note = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        action,
        actionConfig.label,
        manualNote,
        now,
        `人工复核分流：${actionConfig.label}。${manualNote}`,
        now,
        id
      ]
    );

    await db.run(
      `UPDATE financial_candidate_pool
       SET review_status = 'wait_confirmation',
           pool_status = 'active',
           final_status = 'WAIT',
           review_action = ?,
           candidate_reason = ?,
           last_review_at = ?,
           updated_at = ?
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND pool_status = 'active'
         AND review_status IN ('wait_confirmation', 'plan_ready', 'structure_ready', 'structure_watch', 'unreviewed')`,
      [
        actionConfig.candidateAction,
        `入场高触发人工复核：${actionConfig.label}。${manualNote}`,
        now,
        now,
        observation.symbol,
        observation.asset_type,
        observation.source
      ]
    );

    const saved = await db.get(
      `SELECT *
       FROM financial_entry_trigger_observations
       WHERE id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: `${observation.symbol} 已分流：${actionConfig.label}`,
      data: {
        observation: saved,
        action,
        label: actionConfig.label
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `人工复核分流失败: ${(error as Error).message}`
    });
  }
});

router.delete('/entry-trigger-observations/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureEntryTriggerObservationSchema(db);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '无效的观察记录ID' });
    }

    const result = await db.run(
      `DELETE FROM financial_entry_trigger_observations WHERE id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: result.changes ? '入场观察记录已删除' : '记录不存在或已删除'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `删除入场观察记录失败: ${(error as Error).message}`
    });
  }
});

function calculateStructure(prices: DailyPrice[], planProfileKey?: string | null): Omit<StructureCheckResult, 'symbol' | 'name' | 'asset_type' | 'market_regime' | 'entry_permission' | 'final_status' | 'final_reason' | 'data_source_used' | 'available_sources'> {
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

  const ma60Slope = ma60 >= ma60Prev ? 'up' : 'down';

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
    if (prices[i].close > dayMA60) {
      aboveMa60Days++;
    } else {
      break;
    }
  }

  let belowMa60Days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA60 = getMA60At(i);
    if (dayMA60 === null) break;
    if (prices[i].close < dayMA60) {
      belowMa60Days++;
    } else {
      break;
    }
  }

  const low20 = last20Prices.length >= 20 ? Math.min(...last20Prices.map(p => p.close)) : null;
  const low60 = last60Prices.length >= 60 ? Math.min(...last60Prices.map(p => p.close)) : null;
  const high60 = last60Prices.length >= 60 ? Math.max(...last60Prices.map(p => p.close)) : null;

  const close20DaysAgo = prices.length >= 21 ? prices[prices.length - 21].close : null;
  const close60DaysAgo = prices.length >= 61 ? prices[prices.length - 61].close : null;

  const drawdown20 = close20DaysAgo !== null ? (close / close20DaysAgo) - 1 : null;
  const drawdown60 = close60DaysAgo !== null ? (close / close60DaysAgo) - 1 : null;

  let structureStatus: string;
  let structureReason: string;

  const ma60NotFalling = ma60 >= ma60Prev;
  if (close > ma60 && ma60NotFalling && aboveMa60Days >= profile.minAboveMa60Days) {
    structureStatus = 'STRUCTURE_CONFIRMED';
    structureReason = `按${profile.label}：收盘价站上MA60并连续站稳${profile.minAboveMa60Days}天，MA60未下弯。`;
  } else if (belowMa60Days >= profile.brokenBelowMa60Days) {
    structureStatus = 'STRUCTURE_BROKEN';
    structureReason = `按${profile.label}：收盘价连续跌破MA60达到${profile.brokenBelowMa60Days}天，结构破坏。`;
  } else {
    structureStatus = 'STRUCTURE_WATCH';
    const reasons: string[] = [];
    if (Math.abs(distanceToMa60) < profile.distanceTightMax) {
      reasons.push('价格接近MA60');
    }
    if (close > ma60 && aboveMa60Days < profile.minAboveMa60Days) {
      reasons.push('站上MA60但天数不足');
    }
    if (ma60 < ma60Prev) {
      reasons.push('MA60仍下弯');
    }
    structureReason = reasons.length > 0 ? reasons.join('，') + '。' : '继续观察结构变化。';
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
    if (distanceToMa60 > profile.safeZoneMax && distanceToMa60 <= profile.highRiskChaseMin) {
      safeZoneReason = '价格略高于MA60，但未进入明显追高区。';
    } else if (distanceToMa60 >= profile.brokenZoneMax && distanceToMa60 < profile.safeZoneMin) {
      safeZoneReason = '价格略低于MA60，但未进入明显破位区。';
    } else {
      safeZoneReason = '当前位置中性。';
    }
  }

  const invalidationLine = ma60 * (1 - planProfile.invalidationBufferPercent);
  const digits = planProfile.key.startsWith('etf_') ? 4 : 3;

  return {
    trade_date: tradeDate,
    close: Math.round(close * 1000) / 1000,
    ma20: Math.round(ma20 * 1000) / 1000,
    ma60: Math.round(ma60 * 1000) / 1000,
    ma120: Math.round(ma120 * 1000) / 1000,
    ma60_prev: Math.round(ma60Prev * 1000) / 1000,
    ma60_slope: ma60Slope,
    distance_to_ma60: Math.round(distanceToMa60 * 10000) / 10000,
    above_ma60_days: aboveMa60Days,
    below_ma60_days: belowMa60Days,
    low_20: low20 !== null ? Math.round(low20 * 1000) / 1000 : null,
    low_60: low60 !== null ? Math.round(low60 * 1000) / 1000 : null,
    high_60: high60 !== null ? Math.round(high60 * 1000) / 1000 : null,
    drawdown_20: drawdown20 !== null ? Math.round(drawdown20 * 10000) / 10000 : null,
    drawdown_60: drawdown60 !== null ? Math.round(drawdown60 * 10000) / 10000 : null,
    structure_status: structureStatus,
    structure_reason: structureReason,
    safe_zone_status: safeZoneStatus,
    safe_zone_reason: safeZoneReason,
    invalidation_line: Math.round(invalidationLine * 10 ** digits) / 10 ** digits
  };
}

export default router;
