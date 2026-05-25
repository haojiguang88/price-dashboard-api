import express, { Request, Response } from 'express';
import getDb, { getDatabasePath } from '../config/database';
import { exec, execFile } from 'child_process';
import path from 'path';
import {
  calculateProfileInvalidationLine,
  getFinanceStructureProfileConfig,
  resolveFinancePlanProfile
} from '../services/financePlanProfile';
import {
  calculateEntryTriggerPlan,
  calculateStructure,
  calculateStructureScore,
  classifyOpportunityType,
  getEntryManualPriorityLevel,
  getEntryManualPriorityScore,
  getEntryTrendPriority,
  getTrendAction,
  type DailyPrice,
  type StructureCheckResult
} from '../services/financeEntryTriggerRules';
import {
  applySignalLifecycleGate,
  buildPlanReadyValueMetrics,
  ensureEntryTriggerObservationSchema,
  entryObservationKey,
  getEntryMarketGateBlocker,
  isEntryMarketGateOpen,
  isEntrySnapshotInvalidated,
  loadLatestSignalLifecycleMap,
  parseJson,
  resolveCandidateStatusAfterEntryScan,
  signalLifecycleAllowsPlan,
  writeEntryObservationAuditLog
} from '../services/financeEntryObservationService';
import { recordSignalLifecycleCheck } from '../services/financeSignalLifecycle';
import { getFreshMarketRegime } from '../utils/financeMarketRegime';
import {
  buildEntryObservationQueueInfo,
  buildObservationQueueSummary,
  compareObservationQueueItems
} from '../utils/entryObservationQueue';
import { getLatestCoveredTradeDate } from '../utils/financeTradeDate';

const router = express.Router();
const TREND_PHASE_VERSION = 'trend_phase_v1.1';
const CANDIDATE_RULE_VERSION = 'candidate_pool_v1';
type EntryObservationScope = 'actionable' | 'risk_priority_recheck' | 'lifecycle_recheck' | 'risk_hold' | 'watching' | 'confirmed' | 'invalidated' | 'returned' | 'resolved' | 'all';
const TRAINING_ROOT = process.env.MODEL_TRAINING_ROOT || '/Volumes/7100/model-training';
const TRAINING_PYTHON = process.env.MODEL_TRAINING_PYTHON || path.join(TRAINING_ROOT, 'venv', 'bin', 'python');

function parseDateOnly(value: unknown) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function getCalendarDateDiff(fromDate: string, toDate: string) {
  const fromTime = new Date(`${fromDate}T00:00:00Z`).getTime();
  const toTime = new Date(`${toDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return null;
  return Math.max(0, Math.round((toTime - fromTime) / 86400000));
}

async function loadPlanReadyAgeByTradeDate(db: any, items: any[], latestTradeDate: string | null, sourceFallback = 'tushare') {
  const tradeDates = items.map(item => parseDateOnly(item.trade_date)).filter(Boolean);
  if (!latestTradeDate || tradeDates.length === 0) return new Map<string, number>();
  const minTradeDate = tradeDates.sort()[0];
  const source = sourceFallback || 'tushare';
  const rows = await db.all(
    `SELECT DISTINCT trade_date
     FROM financial_daily_prices
     WHERE source = ?
       AND asset_type IN ('stock', 'etf', 'index')
       AND trade_date >= ?
       AND trade_date <= ?
     ORDER BY trade_date ASC`,
    [source, minTradeDate, latestTradeDate]
  );
  const dates = rows.map((row: any) => parseDateOnly(row.trade_date)).filter(Boolean);
  const latestIndex = dates.lastIndexOf(latestTradeDate);
  const ageByDate = new Map<string, number>();
  dates.forEach((date: string, index: number) => {
    const age = latestIndex >= 0 ? Math.max(0, latestIndex - index) : getCalendarDateDiff(date, latestTradeDate);
    ageByDate.set(date, age ?? 0);
  });
  return ageByDate;
}

function buildPlanReadyFreshness(item: any, latestTradeDate: string | null, ageByDate: Map<string, number>) {
  const tradeDate = parseDateOnly(item.trade_date);
  const age = tradeDate && latestTradeDate
    ? ageByDate.get(tradeDate) ?? getCalendarDateDiff(tradeDate, latestTradeDate)
    : null;
  const status = String(item.observation_status || '');
  const ageText = typeof age === 'number' ? `${age} 个交易日` : '未知交易日';

  if (!tradeDate || !latestTradeDate || age === null) {
    return {
      plan_ready_latest_trade_date: latestTradeDate,
      plan_ready_age_trading_days: age,
      plan_ready_freshness_status: 'unknown',
      plan_ready_freshness_label: '待复核',
      plan_ready_freshness_reason: '缺少交易日覆盖信息，生成计划前先按最新日线复核。',
      plan_ready_action_required: 'refresh_before_plan'
    };
  }

  if (status === 'plan_candidate') {
    const pendingSameDay = age === 0;
    return {
      plan_ready_latest_trade_date: latestTradeDate,
      plan_ready_age_trading_days: age,
      plan_ready_freshness_status: pendingSameDay ? 'pending_next_session' : 'needs_confirmation',
      plan_ready_freshness_label: pendingSameDay ? '待次日确认' : '待复核确认',
      plan_ready_freshness_reason: pendingSameDay
        ? '信号交易日与最新覆盖日相同，下一交易日复核通过后才算真正计划准备。'
        : `计划候选已跨 ${ageText}，但还没有升级为确认态，先复核再决定是否生成计划。`,
      plan_ready_action_required: 'secondary_confirm_before_plan'
    };
  }

  if (age <= 1) {
    return {
      plan_ready_latest_trade_date: latestTradeDate,
      plan_ready_age_trading_days: age,
      plan_ready_freshness_status: 'fresh',
      plan_ready_freshness_label: age === 0 ? '当日确认' : '次日确认',
      plan_ready_freshness_reason: `已通过二次确认，距最新覆盖日 ${ageText}。`,
      plan_ready_action_required: 'review_before_manual_plan'
    };
  }

  if (age <= 3) {
    return {
      plan_ready_latest_trade_date: latestTradeDate,
      plan_ready_age_trading_days: age,
      plan_ready_freshness_status: 'stale',
      plan_ready_freshness_label: '需复核',
      plan_ready_freshness_reason: `确认信号已滞后 ${ageText}，生成计划前必须按最新日线复核。`,
      plan_ready_action_required: 'refresh_before_plan'
    };
  }

  return {
    plan_ready_latest_trade_date: latestTradeDate,
    plan_ready_age_trading_days: age,
    plan_ready_freshness_status: 'expired',
    plan_ready_freshness_label: '信号过期',
    plan_ready_freshness_reason: `确认信号已滞后 ${ageText}，优先重新扫描或退回观察，不应直接生成计划。`,
    plan_ready_action_required: 'rescan_or_return'
  };
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

  const activeModel = await db.get(
    `SELECT model_key, activated_at, updated_at
     FROM model_training_active_models
     WHERE domain = ?
     LIMIT 1`,
    [assetType]
  );
  const selectedModelKey = activeModel?.model_key || feedback.default_model_key;
  const selectedModelSource = activeModel?.model_key ? 'active_model' : 'strategy_feedback';
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
    selectedModelKey
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
      modelKey: selectedModelKey,
      modelKeySource: selectedModelSource,
      feedbackModelKey: feedback.default_model_key,
      activeModelKey: activeModel?.model_key || null,
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
            modelKeySource: selectedModelSource,
            feedbackModelKey: feedback.default_model_key,
            activeModelKey: activeModel?.model_key || null,
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
    const lightPayload = String(req.query.payload || '').trim() === 'light';
    const rawObservationScope = String(req.query.observation_scope || '').trim();
    const observationScope: EntryObservationScope | '' = ['actionable', 'risk_priority_recheck', 'lifecycle_recheck', 'risk_hold', 'watching', 'confirmed', 'invalidated', 'returned', 'resolved', 'all'].includes(rawObservationScope)
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
      } else if (['risk_priority_recheck', 'lifecycle_recheck', 'risk_hold'].includes(observationScope)) {
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
      || ['actionable', 'risk_priority_recheck', 'lifecycle_recheck', 'risk_hold', 'watching'].includes(observationScope);
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
    if (!lightPayload) {
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
    }
    const lifecycleByKey = await loadLatestSignalLifecycleMap(db, items);
    const hasPlanReadyItems = items.some((item: any) => ['confirmed', 'plan_candidate'].includes(String(item.observation_status || '')));
    const planReadyLatestTradeDate = hasPlanReadyItems
      ? await getLatestCoveredTradeDate(db, { source: source || items[0]?.source || 'tushare', assetTypes: ['stock', 'etf'] })
      : null;
    const planReadyAgeByTradeDate = hasPlanReadyItems
      ? await loadPlanReadyAgeByTradeDate(db, items, planReadyLatestTradeDate, source || items[0]?.source || 'tushare')
      : new Map<string, number>();
    items = await Promise.all(items.map(async (item: any) => {
      const snapshot = parseJson(item.snapshot_json, null);
      const { snapshot_json: _snapshotJson, ...itemWithoutRawSnapshot } = item;
      const queueInfo = buildEntryObservationQueueInfo(item, snapshot, lifecycleByKey.get(entryObservationKey(item)));
      const planReadyFreshness = ['confirmed', 'plan_candidate'].includes(String(item.observation_status || ''))
        ? buildPlanReadyFreshness(item, planReadyLatestTradeDate, planReadyAgeByTradeDate)
        : {};
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
      const planValueMetrics = lightPayload
        ? null
        : await buildPlanReadyValueMetrics(db, item, snapshot, maxLossPercent);
      const planQuality = planValueMetrics?.plan_quality || null;
      const planProfileKey = snapshot?.plan_profile || snapshot?.plan_draft?.plan_profile || item.plan_profile;
      return {
        ...itemWithoutRawSnapshot,
        ...queueInfo,
        ...planReadyFreshness,
        opportunity_type: opportunityType,
        max_loss_percent: maxLossPercent,
        ...(!lightPayload && planValueMetrics && planQuality ? {
          target_price: planValueMetrics.target_price,
          target_source: planValueMetrics.target_source,
          target_space_percent: planValueMetrics.target_space_percent,
          downside_risk_percent: planValueMetrics.downside_risk_percent,
          risk_reward_ratio: planValueMetrics.risk_reward_ratio,
          pressure_distance_percent: planValueMetrics.target_space_percent,
          plan_quality: planQuality,
          plan_quality_score: planQuality.score,
          plan_quality_label: planQuality.label,
          plan_quality_action: planQuality.action
        } : {}),
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
    const bucketScopeMap: Partial<Record<EntryObservationScope, string>> = {
      risk_priority_recheck: 'risk_priority_recheck',
      lifecycle_recheck: 'lifecycle_recheck',
      risk_hold: 'risk_hold'
    };
    const bucketScope = bucketScopeMap[observationScope as EntryObservationScope];
    if (bucketScope) {
      items = items
        .filter((item: any) => item.observation_queue_bucket === bucketScope)
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

    await writeEntryObservationAuditLog(db, {
      observationId: id,
      symbol: observation.symbol,
      name: observation.name,
      action,
      actionLabel: actionConfig.label,
      note: manualNote,
      previousStatus: observation.observation_status,
      currentStatus: 'watching'
    });

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

export default router;
