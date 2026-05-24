import getDb from '../config/database';
import { getDatabasePath } from '../config/database';
import path from 'path';
import { spawn } from 'child_process';
import { recordSignalLifecycleCheck } from './financeSignalLifecycle';
import { MARKET_ASSETS } from './industryEtfStrengthService';
import { getLocalHttpErrorMessage, requestLocalJson } from '../utils/localHttpClient';
import { getLatestCoveredTradeDate, getTradeDateCoverage } from '../utils/financeTradeDate';
import { getFreshMarketRegime } from '../utils/financeMarketRegime';

const TREND_PHASE_VERSION = 'trend_phase_v1.1';
const CANDIDATE_RULE_VERSION = 'candidate_pool_v1';
const FUNNEL_READY_TREND_PHASES = new Set(['BREAKOUT', 'SLOW_GRIND_UP', 'RECOVERY']);
const FUNNEL_HOLD_TREND_PHASES = new Set(['TREND_UP', 'HIGH_BASE', 'SIDEWAYS', 'CONSOLIDATION', 'TREND_TRANSITION', 'UNKNOWN']);
const FUNNEL_REJECT_TREND_PHASES = new Set(['CRASH_DROP', 'SLOW_BLEED', 'SURGE', 'REBOUND']);
const DEFAULT_LOCAL_API_TIMEOUT_MS = 90 * 60 * 1000;
const DEFAULT_MODEL_FEATURE_CHECK_TIMEOUT_MS = Number(process.env.FINANCE_MODEL_FEATURE_CHECK_TIMEOUT_MS || 2 * 60 * 1000);
const DEFAULT_MODEL_FEATURE_REFRESH_TIMEOUT_MS = Number(process.env.FINANCE_MODEL_FEATURE_REFRESH_TIMEOUT_MS || 12 * 60 * 1000);
const MAX_CHILD_OUTPUT_CHARS = 20000;
const MODEL_TRAINING_ROOT = process.env.MODEL_TRAINING_ROOT || '/Volumes/7100/model-training';
const MODEL_TRAINING_PYTHON = process.env.MODEL_TRAINING_PYTHON || path.join(MODEL_TRAINING_ROOT, 'venv', 'bin', 'python');

export interface FinancePipelineStep {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
  message?: string;
  data?: any;
  started_at?: string;
  finished_at?: string;
}

export interface FinancePipelineConfig {
  source?: string;
  active_plan_limit?: number;
  candidate_limit?: number;
  daily_price_candidate_limit?: number;
  universe_limit?: number | 'all';
  wait_full_universe?: boolean;
  interval_ms?: number;
  secondary_scan_limit?: number;
  model_recheck_limit?: number;
  market_symbols?: string[];
  prediction_pool_limit?: number;
  prediction_label_limit?: number;
  prediction_horizon_days?: number;
  refresh_model_features?: boolean;
  model_feature_check_timeout_ms?: number;
  model_feature_refresh_timeout_ms?: number;
  model_score_limit?: number;
  local_api_timeout_ms?: number;
  force?: boolean;
  prediction_experiments?: Array<string | {
    key: string;
    asset_type?: string;
    limit?: number;
    enabled?: boolean;
  }>;
}

export interface FinanceCandidateFunnelConfig {
  source?: string;
  candidate_limit?: number;
  secondary_scan_limit?: number;
}

export interface FinancePipelineProgressPayload {
  task_key?: string;
  step: FinancePipelineStep;
  result: any;
}

export interface FinancePipelineRuntimeOptions {
  onProgress?: (payload: FinancePipelineProgressPayload) => Promise<void> | void;
  taskKey?: string;
}

export const DEFAULT_FINANCE_PIPELINE_CONFIG: FinancePipelineConfig = {
  source: 'tushare',
  active_plan_limit: 50,
  candidate_limit: 300,
  daily_price_candidate_limit: 80,
  universe_limit: 'all',
  wait_full_universe: true,
  interval_ms: 1200,
  secondary_scan_limit: 200,
  model_recheck_limit: 200,
  market_symbols: MARKET_ASSETS.map(asset => asset.symbol),
  prediction_pool_limit: 40,
  prediction_label_limit: 600,
  prediction_horizon_days: 20,
  refresh_model_features: process.env.FINANCE_REFRESH_MODEL_FEATURES !== 'false',
  model_feature_check_timeout_ms: DEFAULT_MODEL_FEATURE_CHECK_TIMEOUT_MS,
  model_feature_refresh_timeout_ms: DEFAULT_MODEL_FEATURE_REFRESH_TIMEOUT_MS,
  model_score_limit: 500,
  local_api_timeout_ms: DEFAULT_LOCAL_API_TIMEOUT_MS,
  prediction_experiments: [
    { key: 'elasticity-hardness', asset_type: 'stock' },
    { key: 'elasticity-hardness', asset_type: 'etf' },
    { key: 'crash-recovery', asset_type: 'stock' },
    { key: 'crash-recovery', asset_type: 'etf' },
    { key: 'signal-lifecycle', asset_type: 'stock' },
    { key: 'signal-lifecycle', asset_type: 'etf' },
    { key: 'double-stock', asset_type: 'stock' },
    { key: 'capital-rotation', asset_type: 'etf' }
  ]
};

export const DEFAULT_FINANCE_CANDIDATE_FUNNEL_CONFIG: FinanceCandidateFunnelConfig = {
  source: 'tushare',
  candidate_limit: 300,
  secondary_scan_limit: 200
};

function getLocalBaseUrl() {
  const port = process.env.PORT || 3001;
  return `http://127.0.0.1:${port}`;
}

function normalizeTimeoutMs(timeoutMs?: number | null) {
  const value = Number(timeoutMs || DEFAULT_LOCAL_API_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_LOCAL_API_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(value), 60 * 1000), 6 * 60 * 60 * 1000);
}

function formatTimeout(timeoutMs: number) {
  const seconds = Math.round(timeoutMs / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.round(minutes / 60);
  return `${hours}小时`;
}

function normalizeModelFeatureRefreshTimeoutMs(timeoutMs?: number | null, checkOnly = false) {
  const defaultTimeout = checkOnly ? DEFAULT_MODEL_FEATURE_CHECK_TIMEOUT_MS : DEFAULT_MODEL_FEATURE_REFRESH_TIMEOUT_MS;
  const maxTimeout = checkOnly ? 10 * 60 * 1000 : 60 * 60 * 1000;
  const value = Number(timeoutMs || defaultTimeout);
  if (!Number.isFinite(value) || value <= 0) {
    return defaultTimeout;
  }
  return Math.min(Math.max(Math.floor(value), 60 * 1000), maxTimeout);
}

function appendChildOutput(current: string, chunk: any) {
  const next = current + chunk.toString();
  return next.length > MAX_CHILD_OUTPUT_CHARS
    ? next.slice(next.length - MAX_CHILD_OUTPUT_CHARS)
    : next;
}

function terminateChildProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

function pruneStepResultsForStorage(stepKey: string, results: any[]) {
  const rows = Array.isArray(results) ? results : [];
  if (stepKey === 'daily_prices') {
    return rows
      .filter((item: any) => item?.success === false || Number(item?.insertedCount || 0) > 0 || Number(item?.updatedCount || 0) > 0)
      .slice(0, 40);
  }
  if (stepKey === 'candidate_scan') {
    return rows
      .filter((item: any) => item?.selected || item?.success === false)
      .slice(0, 80);
  }
  if (stepKey === 'entry_trigger_scan') {
    return rows
      .filter((item: any) => ['READY_TO_PLAN', 'CONFIRMED', 'INVALIDATED'].includes(String(item?.action || '').toUpperCase())
        || ['confirmed', 'invalidated'].includes(String(item?.observation_status || '')))
      .slice(0, 80);
  }
  return rows.slice(0, 60);
}

function pruneStepDataForStorage(step: any) {
  const data = step?.data;
  if (!data || typeof data !== 'object') return data;
  const compact: any = { ...data };
  if (Array.isArray(compact.results)) {
    compact.results = pruneStepResultsForStorage(String(step.key || ''), compact.results);
    compact.results_truncated = true;
  }
  if (Array.isArray(compact.items)) {
    compact.items = compact.items.slice(0, 80);
    compact.items_truncated = true;
  }
  if (Array.isArray(compact.snapshots)) {
    compact.snapshots = compact.snapshots.slice(0, 20);
    compact.snapshots_truncated = true;
  }
  if (compact.decisionTracking && typeof compact.decisionTracking === 'object') {
    compact.decisionTracking = {
      ...compact.decisionTracking,
      items: Array.isArray(compact.decisionTracking.items) ? compact.decisionTracking.items.slice(0, 40) : compact.decisionTracking.items,
      recentItems: Array.isArray(compact.decisionTracking.recentItems) ? compact.decisionTracking.recentItems.slice(0, 40) : compact.decisionTracking.recentItems
    };
  }
  return compact;
}

export function compactFinancePipelineResultForStorage(result: any) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    steps: Array.isArray(result.steps)
      ? result.steps.map((step: any) => ({
        ...step,
        data: pruneStepDataForStorage(step)
      }))
      : result.steps,
    compacted_for_storage: true
  };
}

export function markFinancePipelineResultInterrupted(resultJson: any, message: string, finishedAt = new Date().toISOString()) {
  if (!resultJson) return null;
  let result = resultJson;
  if (typeof resultJson === 'string') {
    try {
      result = JSON.parse(resultJson);
    } catch {
      return null;
    }
  }
  if (!result || typeof result !== 'object') return null;

  const rawSteps = Array.isArray(result.steps) ? result.steps : [];
  if (rawSteps.length === 0) {
    return {
      ...result,
      summary: {
        ...(result.summary || {}),
        failed: 1,
        failed_step: result.summary?.failed_step || null,
        interrupted: true
      },
      finished_at: result.finished_at || finishedAt
    };
  }

  let hasMarkedError = false;
  const steps = rawSteps.map((step: any) => {
    if (step?.status === 'error') {
      hasMarkedError = true;
      return step;
    }
    if (step?.status === 'running') {
      hasMarkedError = true;
      return {
        ...step,
        status: 'error',
        message: step.message ? `${step.message}；${message}` : message,
        finished_at: step.finished_at || finishedAt
      };
    }
    if (step?.status === 'pending') {
      if (!hasMarkedError) {
        hasMarkedError = true;
        return {
          ...step,
          status: 'error',
          message,
          finished_at: step.finished_at || finishedAt
        };
      }
      return {
        ...step,
        status: 'skipped',
        message: step.message || `前置步骤中断，未执行：${message}`,
        finished_at: step.finished_at || finishedAt
      };
    }
    return step;
  });
  const failedStep = steps.find((step: any) => step.status === 'error');

  return {
    ...result,
    summary: {
      ...(result.summary || {}),
      total: steps.length,
      success: steps.filter((step: any) => step.status === 'success').length,
      skipped: steps.filter((step: any) => step.status === 'skipped').length,
      failed: failedStep ? 1 : 0,
      failed_step: failedStep?.key || null,
      interrupted: true
    },
    steps,
    finished_at: result.finished_at || finishedAt
  };
}

async function callLocalApi(path: string, body?: any, method: 'GET' | 'POST' = 'POST', timeoutMs?: number) {
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const options = {
    method,
    timeoutMs: normalizedTimeoutMs,
    body
  };

  let data: any = null;
  try {
    const response = await requestLocalJson(`${getLocalBaseUrl()}${path}`, options);
    data = response.data;
  } catch (error) {
    throw new Error(`接口请求失败 ${method} ${path}（等待上限 ${formatTimeout(normalizedTimeoutMs)}）: ${getLocalHttpErrorMessage(error)}`);
  }
  if (data?.success === false) {
    throw new Error(data.message || `接口执行失败: ${path}`);
  }
  return data;
}

function runModelFeatureRefreshWorker(
  domain: 'stock' | 'etf',
  checkOnly = false,
  timeoutMs?: number
): Promise<any> {
  return new Promise((resolve, reject) => {
    const normalizedTimeoutMs = normalizeModelFeatureRefreshTimeoutMs(timeoutMs, checkOnly);
    const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'refresh_model_features.py');
    const args = [
      scriptPath,
      '--db', getDatabasePath(),
      '--domain', domain
    ];
    if (checkOnly) {
      args.push('--check-only');
    }
    const child = spawn(MODEL_TRAINING_PYTHON, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout;
    const finish = (callback?: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      callback?.();
    };
    timeout = setTimeout(() => {
      if (settled) return;
      const modeLabel = checkOnly ? '检查' : '刷新';
      const stderrTail = stderr.trim().split('\n').slice(-5).join('；');
      terminateChildProcess(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        terminateChildProcess(child, 'SIGKILL');
      }, 5000);
      settled = true;
      reject(new Error(`${domain} 模型特征${modeLabel}超过 ${formatTimeout(normalizedTimeoutMs)} 未结束，已停止子进程${stderrTail ? `；最近错误：${stderrTail}` : ''}`));
    }, normalizedTimeoutMs);
    child.stdout.on('data', chunk => {
      stdout = appendChildOutput(stdout, chunk);
    });
    child.stderr.on('data', chunk => {
      stderr = appendChildOutput(stderr, chunk);
    });
    child.on('error', error => {
      finish(() => reject(error));
    });
    child.on('close', code => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      finish(() => {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const text = lines[lines.length - 1] || '';
        try {
          const payload = JSON.parse(text || '{}');
          if (code === 0 && payload.success) {
            resolve(payload.data);
            return;
          }
          reject(new Error(payload.message || stderr || `模型特征刷新脚本退出：${code}`));
        } catch (error) {
          reject(new Error(stderr || text || `模型特征刷新输出无法解析：${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });
  });
}

async function ensureModelCandidateScoreAsOfColumn(db: any) {
  const columns = await db.all(`PRAGMA table_info(model_training_candidate_scores)`);
  const names = new Set((columns || []).map((column: any) => column.name));
  if (!names.has('as_of_trade_date')) {
    await db.exec(`ALTER TABLE model_training_candidate_scores ADD COLUMN as_of_trade_date TEXT`);
  }
}

async function refreshModelFeatureTables(config: Required<FinancePipelineConfig>) {
  const db = await getDb();
  await ensureModelCandidateScoreAsOfColumn(db);
  const domains: Array<'stock' | 'etf'> = ['stock', 'etf'];
  const results = [];
  for (const domain of domains) {
    try {
      const latestCoveredTradeDate = await getLatestCoveredTradeDate(db, {
        source: config.source,
        assetTypes: [domain],
        minCoverageRatio: 0.88
      });
      const before = await runModelFeatureRefreshWorker(domain, true, config.model_feature_check_timeout_ms);
      const featureStale = Boolean(latestCoveredTradeDate && (!before.latestTradeDate || before.latestTradeDate < latestCoveredTradeDate));
      const refreshed = config.refresh_model_features === true && featureStale;
      const result = refreshed
        ? await runModelFeatureRefreshWorker(domain, false, config.model_feature_refresh_timeout_ms)
        : before;
      const scoreRow = await db.get(
        `SELECT MAX(COALESCE(as_of_trade_date, trade_date)) as latest_trade_date
         FROM model_training_candidate_scores
         WHERE domain = ?`,
        [domain]
      );
      const featureTradeDate = result.latestTradeDate || null;
      const scoreTradeDate = scoreRow?.latest_trade_date || null;
      results.push({
        ...result,
        success: true,
        checkedLatestTradeDate: before.latestTradeDate || null,
        refreshed,
        latestCoveredTradeDate,
        latestScoreTradeDate: scoreTradeDate,
        featureStale: Boolean(latestCoveredTradeDate && (!featureTradeDate || featureTradeDate < latestCoveredTradeDate)),
        scoreStale: Boolean(latestCoveredTradeDate && (!scoreTradeDate || scoreTradeDate < latestCoveredTradeDate))
      });
    } catch (error) {
      results.push({
        domain,
        success: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const failed = results.filter(item => item.success === false);
  const stale = results.filter((item: any) => item.success && (item.featureStale || item.scoreStale));
  const blockingFeatureStale = results.filter((item: any) => item.success && item.featureStale);
  const refreshedCount = results.filter((item: any) => item.success && item.refreshed).length;
  const failedMessage = failed.length
    ? `；失败 ${failed.length} 个域：${failed.map(item => `${item.domain} ${item.message}`).join('；')}`
    : '';
  const staleMessage = stale.length
    ? `；落后最新日线 ${stale.map((item: any) => {
      const parts = [
        item.featureStale ? `特征 ${item.latestTradeDate || '--'}` : null,
        item.scoreStale ? `候选分 ${item.latestScoreTradeDate || '--'}` : null
      ].filter(Boolean).join(' / ');
      return `${item.domain}(${parts}，最新 ${item.latestCoveredTradeDate || '--'})`;
    }).join('；')}`
    : '';
  const blockingMessage = config.refresh_model_features === true && blockingFeatureStale.length > 0
    ? `；特征仍滞后，模型辅助降级：${blockingFeatureStale.map((item: any) => `${item.domain} 特征 ${item.latestTradeDate || '--'} / 最新日线 ${item.latestCoveredTradeDate || '--'}`).join('；')}`
    : '';
  const auxiliaryMessage = failed.length || blockingFeatureStale.length
    ? '，模型辅助不可用或不完整，规则主链继续推进'
    : '';
  return {
    message: `模型特征按需刷新完成：成功 ${results.length - failed.length}/${results.length} 个域，重建 ${refreshedCount} 个${auxiliaryMessage}${failedMessage}${staleMessage}${blockingMessage}`,
    data: {
      results,
      auto_refresh_enabled: config.refresh_model_features === true,
      model_auxiliary_available: failed.length < results.length && blockingFeatureStale.length === 0,
      refreshed_count: refreshedCount,
      checked_count: results.length - failed.length,
      failed_count: failed.length,
      stale_count: stale.length,
      blocking_stale_count: blockingFeatureStale.length
    }
  };
}

async function syncModelCandidateScores(config: Required<FinancePipelineConfig>) {
  const domains: Array<'stock' | 'etf'> = ['stock', 'etf'];
  const limit = Math.min(Math.max(Number(config.model_score_limit || 500), 50), 2000);
  const results = [];

  for (const domain of domains) {
    try {
      const result = await callLocalApi(
        `/api/model-training/sync-candidates/${domain}`,
        { limit },
        'POST',
        config.local_api_timeout_ms
      );
      results.push({
        domain,
        success: true,
        checked: Number(result.data?.checked || 0),
        scored: Number(result.data?.scored || 0),
        coveredTradeDate: result.data?.coveredTradeDate || null,
        modelKey: result.data?.modelKey || null,
        modelRunId: result.data?.modelRunId || null,
        message: result.message || '候选模型分数已同步'
      });
    } catch (error) {
      results.push({
        domain,
        success: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const successCount = results.filter(item => item.success).length;
  const scoredCount = results.reduce((sum: number, item: any) => sum + Number(item.scored || 0), 0);
  const checkedCount = results.reduce((sum: number, item: any) => sum + Number(item.checked || 0), 0);
  const failedCount = results.length - successCount;
  const failedMessage = failedCount > 0
    ? `，失败 ${failedCount} 个域：${results.filter(item => !item.success).map(item => `${item.domain} ${item.message || '原因未知'}`).join('；')}。模型分数仅作辅助，规则主链继续推进`
    : '';

  return {
    message: `候选模型分数同步完成：成功 ${successCount}/${results.length} 个域，检查 ${checkedCount} 个，评分 ${scoredCount} 个${failedMessage}`,
    data: {
      results,
      model_auxiliary_available: successCount > 0,
      checked_count: checkedCount,
      scored_count: scoredCount,
      failed_count: failedCount
    }
  };
}

function mergeConfig(config?: FinancePipelineConfig | null): Required<FinancePipelineConfig> {
  return {
    ...DEFAULT_FINANCE_PIPELINE_CONFIG,
    ...(config || {})
  } as Required<FinancePipelineConfig>;
}

async function normalizeCandidatePoolFlowState(db: any) {
  const normalizedAt = new Date().toISOString();
  const normalized = await db.run(
    `UPDATE financial_candidate_pool
     SET pool_status = 'expired',
         final_status = 'REJECTED',
         review_action = CASE
           WHEN COALESCE(review_action, '') = '' THEN 'auto_status_cleanup'
           ELSE review_action
         END,
         updated_at = ?
     WHERE pool_status = 'active'
       AND asset_type IN ('stock', 'etf')
       AND COALESCE(review_status, '') = 'rejected'`,
    [normalizedAt]
  );
  const normalizedExpiredFinalStatus = await db.run(
    `UPDATE financial_candidate_pool
     SET final_status = 'REJECTED',
         updated_at = ?
     WHERE pool_status = 'expired'
       AND asset_type IN ('stock', 'etf')
       AND COALESCE(final_status, '') <> 'REJECTED'`,
    [normalizedAt]
  );
  const normalizedExpiredReviewStatus = await db.run(
    `UPDATE financial_candidate_pool
     SET review_status = 'rejected',
         review_action = CASE
           WHEN COALESCE(review_action, '') = '' THEN 'auto_expired_status_cleanup'
           ELSE review_action
         END,
         updated_at = ?
     WHERE pool_status = 'expired'
      AND COALESCE(review_status, '') <> 'rejected'`,
    [normalizedAt]
  );
  const normalizedExpiredReviewAction = await db.run(
    `UPDATE financial_candidate_pool
     SET review_action = 'expired_rejected_status_cleanup',
         updated_at = ?
     WHERE pool_status = 'expired'
       AND asset_type IN ('stock', 'etf')
       AND COALESCE(review_status, '') = 'rejected'
       AND COALESCE(review_action, '') = ''`,
    [normalizedAt]
  );
  const normalizedFinalStatus = await db.run(
    `UPDATE financial_candidate_pool
     SET final_status = 'WAIT',
         updated_at = ?
     WHERE pool_status = 'active'
       AND asset_type IN ('stock', 'etf')
       AND review_status IN ('trend_blocked', 'structure_pending', 'structure_watch', 'wait_confirmation', 'unreviewed', 'drafted')
       AND final_status = 'READY_FOR_PLAN'`,
    [normalizedAt]
  );
  const normalizedSettledRecheck = await db.run(
    `UPDATE financial_candidate_pool
     SET final_status = 'REJECTED',
         updated_at = ?
     WHERE review_action = 'auto_model_recheck_settled'
       AND review_status = 'rejected'
       AND final_status = 'READY_FOR_PLAN'`,
    [normalizedAt]
  );
  const normalizedStaleReview = await db.run(
    `UPDATE financial_candidate_pool
     SET review_status = 'unreviewed',
         last_review_id = NULL,
         last_review_at = NULL,
         review_action = CASE
           WHEN COALESCE(review_action, '') = '' THEN 'stale_review_cleanup'
           ELSE review_action || '_stale_cleared'
         END,
         updated_at = ?
     WHERE pool_status = 'active'
       AND asset_type IN ('stock', 'etf')
       AND last_review_id IS NOT NULL
       AND COALESCE(review_status, 'unreviewed') NOT IN ('plan_ready', 'wait_confirmation', 'rejected')
       AND EXISTS (
         SELECT 1
         FROM financial_candidate_reviews r
         WHERE r.id = financial_candidate_pool.last_review_id
           AND r.trade_date < financial_candidate_pool.trade_date
       )`,
    [normalizedAt]
  );

  return {
    normalized_rejected_active_count: Number(normalized?.changes || 0),
    normalized_expired_final_status_count: Number(normalizedExpiredFinalStatus?.changes || 0),
    normalized_expired_review_status_count: Number(normalizedExpiredReviewStatus?.changes || 0),
    normalized_expired_review_action_count: Number(normalizedExpiredReviewAction?.changes || 0),
    normalized_final_status_count: Number(normalizedFinalStatus?.changes || 0),
    normalized_settled_recheck_count: Number(normalizedSettledRecheck?.changes || 0),
    normalized_stale_review_count: Number(normalizedStaleReview?.changes || 0)
  };
}

interface ModelRecheckQueueItem {
  id?: number;
  symbol: string;
  name?: string;
  asset_type: 'stock' | 'etf' | string;
  source?: string;
  review_action?: string;
  model_recheck_bucket?: string;
}

type ModelRecheckScope = 'data_gap' | 'high_conflict' | 'neutral' | 'all';

function mergeFunnelConfig(config?: FinanceCandidateFunnelConfig | null): Required<FinanceCandidateFunnelConfig> {
  return {
    ...DEFAULT_FINANCE_CANDIDATE_FUNNEL_CONFIG,
    ...(config || {})
  } as Required<FinanceCandidateFunnelConfig>;
}

function getShortTrendReason(trendCode: string, trendReason?: string | null) {
  const reason = String(trendReason || '').trim();
  if (!reason) return trendCode || 'UNKNOWN';
  return reason.length > 80 ? `${reason.slice(0, 80)}...` : reason;
}

function getTrendPhaseDecision(trendCode?: string | null) {
  const code = trendCode || 'UNKNOWN';
  if (FUNNEL_READY_TREND_PHASES.has(code)) {
    return {
      action: 'advance',
      label: '进入下一步',
      reason: '走势阶段已进入可推进区'
    };
  }
  if (FUNNEL_REJECT_TREND_PHASES.has(code)) {
    return {
      action: 'reject',
      label: '踢出本轮',
      reason: '走势阶段触发硬拦截，不进入单标的判断'
    };
  }
  if (FUNNEL_HOLD_TREND_PHASES.has(code)) {
    return {
      action: 'hold',
      label: '留在走势队列',
      reason: '走势阶段尚未进入可推进区，等待后续确认'
    };
  }
  return {
    action: 'hold',
    label: '留在走势队列',
    reason: '走势阶段未识别，等待后续确认'
  };
}

function normalizePredictionExperimentConfigs(config: Required<FinancePipelineConfig>) {
  const fallback = DEFAULT_FINANCE_PIPELINE_CONFIG.prediction_experiments || [];
  const rawItems = Array.isArray(config.prediction_experiments) && config.prediction_experiments.length > 0
    ? config.prediction_experiments
    : fallback;
  const seen = new Set<string>();
  return rawItems
    .map((item: any) => {
      if (typeof item === 'string') {
        return { key: item, asset_type: '', limit: config.prediction_pool_limit, enabled: true };
      }
      return {
        key: String(item?.key || '').trim(),
        asset_type: String(item?.asset_type || item?.assetType || '').trim(),
        limit: Number(item?.limit || config.prediction_pool_limit),
        enabled: item?.enabled !== false
      };
    })
    .filter(item => {
      if (!item.enabled || !item.key || seen.has(`${item.key}|${item.asset_type}`)) return false;
      seen.add(`${item.key}|${item.asset_type}`);
      return true;
    });
}

async function fetchModelRecheckQueue(scope: ModelRecheckScope, limit: number): Promise<ModelRecheckQueueItem[]> {
  const params = new URLSearchParams({
    status: 'expired',
    include_model: '1',
    review_queue: 'model_recheck',
    review_scope: scope,
    limit: String(Math.min(Math.max(limit, 1), 500)),
    offset: '0'
  });
  const result = await callLocalApi(`/api/finance/candidate-pool?${params.toString()}`, undefined, 'GET');
  return Array.isArray(result.data?.items) ? result.data.items : [];
}

async function markModelRecheckSettled(db: any, item: ModelRecheckQueueItem, reason: string) {
  const now = new Date().toISOString();
  const note = `自动复核后仍未通过：${reason || '规则仍未放行，沉淀为后验样本'}`;
  const candidateId = Number(item.id);
  const hasCandidateId = Number.isFinite(candidateId) && candidateId > 0;
  await db.run(
    `UPDATE financial_candidate_pool
     SET review_action = 'auto_model_recheck_settled',
         downgrade_reason = ?,
         risk_note = CASE
           WHEN COALESCE(risk_note, '') = '' THEN ?
           WHEN risk_note LIKE ? THEN risk_note
           ELSE risk_note || '；' || ?
         END,
         last_review_at = ?,
         updated_at = ?
     WHERE ${hasCandidateId
       ? `id = ?`
       : `symbol = ?
       AND asset_type = ?
       AND source = ?
       AND rule_version = ?`}
       AND pool_status = 'expired'`,
    [
      note,
      note,
      `%${note}%`,
      note,
      now,
      now,
      ...(hasCandidateId
        ? [candidateId]
        : [
            item.symbol,
            item.asset_type,
            item.source || 'tushare',
            CANDIDATE_RULE_VERSION
          ])
    ]
  );
}

async function markModelRecheckManualRequired(db: any, item: ModelRecheckQueueItem, reason: string) {
  const now = new Date().toISOString();
  const note = `模型复核保留人工口子：${reason || '模型仍给分，但规则或风控未放行'}`;
  const candidateId = Number(item.id);
  const hasCandidateId = Number.isFinite(candidateId) && candidateId > 0;
  await db.run(
    `UPDATE financial_candidate_pool
     SET review_action = 'model_conflict_manual_required',
         risk_note = CASE
           WHEN COALESCE(risk_note, '') = '' THEN ?
           WHEN risk_note LIKE ? THEN risk_note
           ELSE risk_note || '；' || ?
         END,
         last_review_at = ?,
         updated_at = ?
     WHERE ${hasCandidateId
       ? `id = ?`
       : `symbol = ?
       AND asset_type = ?
       AND source = ?
       AND rule_version = ?`}
       AND pool_status = 'expired'`,
    [
      note,
      `%${note}%`,
      note,
      now,
      now,
      ...(hasCandidateId
        ? [candidateId]
        : [
            item.symbol,
            item.asset_type,
            item.source || 'tushare',
            CANDIDATE_RULE_VERSION
          ])
    ]
  );
}

async function runModelRecheckAutomation(config: Required<FinancePipelineConfig>) {
  const db = await getDb();
  const limit = Math.min(Math.max(Number(config.model_recheck_limit || 200), 1), 500);
  const dataGapItems = await fetchModelRecheckQueue('data_gap', limit);
  const neutralItems = await fetchModelRecheckQueue('neutral', limit);
  const highConflictItems = (await fetchModelRecheckQueue('high_conflict', limit))
    .filter(item => String(item.review_action || '') !== 'model_conflict_manual_required');
  const seen = new Set<string>();
  const queue = [...dataGapItems, ...highConflictItems, ...neutralItems]
    .filter((item) => {
      const key = `${item.symbol}|${item.asset_type}|${item.source || 'tushare'}`;
      if (!item.symbol || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);

  const results: any[] = [];
  for (const item of queue) {
    const source = item.source || config.source || 'tushare';
    const bucket = item.model_recheck_bucket || (
      dataGapItems.includes(item) ? 'data_gap' : neutralItems.includes(item) ? 'neutral' : 'high_conflict'
    );
    try {
      let dailyUpdated = false;
      if (bucket === 'data_gap') {
        await callLocalApi('/api/finance/asset-universe/update-one', {
          symbol: item.symbol,
          asset_type: item.asset_type,
          source
        });
        dailyUpdated = true;
      }

      const evaluated = await callLocalApi('/api/finance/candidate-pool/evaluate-one', {
        symbol: item.symbol,
        asset_type: item.asset_type,
        source
      });
      const selected = Boolean(evaluated.data?.selected);
      let settled = false;
      let manualRequired = false;
      if (!selected && bucket === 'high_conflict') {
        await markModelRecheckManualRequired(
          db,
          { ...item, source },
          evaluated.data?.candidate_reason || evaluated.data?.reason || '复核后仍是模型高分与规则冲突'
        );
        manualRequired = true;
      } else if (!selected) {
        await markModelRecheckSettled(
          db,
          { ...item, source },
          evaluated.data?.candidate_reason || evaluated.data?.reason || '复核后规则仍未通过'
        );
        settled = true;
      }
      results.push({
        symbol: item.symbol,
        name: item.name,
        asset_type: item.asset_type,
        source,
        bucket,
        success: true,
        daily_updated: dailyUpdated,
        selected,
        settled,
        manual_required: manualRequired,
        next_location: evaluated.data?.next_location || null,
        reason: evaluated.data?.candidate_reason || evaluated.data?.reason || ''
      });
    } catch (error) {
      results.push({
        symbol: item.symbol,
        name: item.name,
        asset_type: item.asset_type,
        source,
        bucket,
        success: false,
        reason: (error as Error).message
      });
    }
  }

  const failedCount = results.filter(item => item.success === false).length;
  const selectedCount = results.filter(item => item.selected).length;
  const settledCount = results.filter(item => item.settled).length;
  const manualRequiredCount = results.filter(item => item.manual_required).length;
  const dailyUpdatedCount = results.filter(item => item.daily_updated).length;
  const failedMessage = failedCount > 0 && queue.length > 0 && failedCount === queue.length
    ? '，全部复核失败，本轮仅记录失败原因，规则主链继续推进'
    : '';
  return {
    message: `模型复核自动流转完成：处理 ${results.length} 条，回流 ${selectedCount} 条，沉淀 ${settledCount} 条，保留人工冲突 ${manualRequiredCount} 条，补日线 ${dailyUpdatedCount} 条，失败 ${failedCount} 条${failedMessage}`,
    data: {
      checked_count: results.length,
      selected_count: selectedCount,
      settled_count: settledCount,
      manual_required_count: manualRequiredCount,
      daily_updated_count: dailyUpdatedCount,
      failed_count: failedCount,
      data_gap_count: dataGapItems.length,
      neutral_count: neutralItems.length,
      high_conflict_count: highConflictItems.length,
      results
    }
  };
}

async function updateObservationsByIds(db: any, ids: number[], sqlSet: string, params: any[]) {
  if (ids.length === 0) return { changes: 0 };
  return db.run(
    `UPDATE financial_entry_trigger_observations
     SET ${sqlSet}
     WHERE id IN (${ids.map(() => '?').join(',')})`,
    [...params, ...ids]
  );
}

async function dedupeOpenEntryObservations(db: any, source = 'tushare') {
  const rows = await db.all(
    `SELECT id, symbol, name, asset_type, source, trade_date, observation_status, updated_at
     FROM financial_entry_trigger_observations
     WHERE source = ?
       AND observation_status IN ('watching', 'plan_candidate', 'confirmed')
     ORDER BY symbol ASC, asset_type ASC, source ASC, updated_at DESC, id DESC`,
    [source]
  );
  const statusRank: Record<string, number> = {
    confirmed: 3,
    plan_candidate: 2,
    watching: 1
  };
  const grouped = new Map<string, any[]>();
  rows.forEach((row: any) => {
    const key = `${row.symbol}|${row.asset_type}|${row.source}`;
    const group = grouped.get(key) || [];
    group.push(row);
    grouped.set(key, group);
  });

  const duplicateIds: number[] = [];
  const details: any[] = [];
  grouped.forEach((group) => {
    if (group.length <= 1) return;
    const sorted = [...group].sort((a: any, b: any) => {
      const rankDiff = (statusRank[String(b.observation_status)] || 0) - (statusRank[String(a.observation_status)] || 0);
      if (rankDiff !== 0) return rankDiff;
      const timeDiff = new Date(String(b.updated_at || 0)).getTime() - new Date(String(a.updated_at || 0)).getTime();
      if (timeDiff !== 0) return timeDiff;
      return Number(b.id || 0) - Number(a.id || 0);
    });
    const keeper = sorted[0];
    const duplicates = sorted.slice(1);
    duplicateIds.push(...duplicates.map((row: any) => Number(row.id)));
    details.push({
      category: 'deduped',
      symbol: keeper.symbol,
      name: keeper.name,
      asset_type: keeper.asset_type,
      source: keeper.source,
      trade_date: keeper.trade_date,
      status: '重复归并',
      kept_observation_id: keeper.id,
      archived_observation_ids: duplicates.map((row: any) => row.id),
      result: `同标的同来源保留 1 条最高优先级/最新观察，归并 ${duplicates.length} 条重复记录`
    });
  });

  if (duplicateIds.length > 0) {
    await updateObservationsByIds(
      db,
      duplicateIds,
      `observation_status = 'returned',
       entry_action = 'OBSERVE',
       action_label = '重复归并',
       note = '日终流水线自动归并：同标的同来源只保留一条最高优先级/最新入场观察。',
       updated_at = ?`,
      [new Date().toISOString()]
    );
  }

  return {
    deduped_count: duplicateIds.length,
    detail_count: details.length,
    details
  };
}

export async function runEntryObservationAutoSettlement(source = 'tushare') {
  const db = await getDb();
  const now = new Date().toISOString();
  const staleDays = 20;
  const latestTradeDate = await getLatestCoveredTradeDate(db, {
    source,
    assetTypes: ['stock', 'etf'],
  }) || new Date().toISOString().slice(0, 10);
  const rejectCodes = Array.from(FUNNEL_REJECT_TREND_PHASES);

  const invalidatedRows = await db.all(
    `SELECT id, symbol, name, asset_type, source, trade_date, close_price, invalidation_line,
            entry_action, action_label, trigger_reason, trend_phase_code, entry_permission
     FROM financial_entry_trigger_observations
     WHERE source = ?
       AND observation_status IN ('watching', 'plan_candidate', 'confirmed')
       AND (
         (close_price IS NOT NULL AND invalidation_line IS NOT NULL AND close_price < invalidation_line)
         OR entry_action = 'INVALIDATED'
         OR (entry_action = 'BLOCKED' AND COALESCE(entry_permission, 'ALLOW_STRUCTURE_CHECK') = 'ALLOW_STRUCTURE_CHECK')
         OR trend_phase_code IN (${rejectCodes.map(() => '?').join(',')})
       )`,
    [source, ...rejectCodes]
  );
  const invalidatedIds = invalidatedRows.map((row: any) => Number(row.id));
  await updateObservationsByIds(
    db,
    invalidatedIds,
    `observation_status = 'invalidated',
     entry_action = CASE WHEN entry_action IN ('BLOCKED', 'INVALIDATED') THEN entry_action ELSE 'INVALIDATED' END,
     action_label = '自动失效',
     trigger_reason = CASE
       WHEN close_price IS NOT NULL AND invalidation_line IS NOT NULL AND close_price < invalidation_line THEN '自动沉淀：收盘价跌破失效线。'
       WHEN trend_phase_code IN (${rejectCodes.map(() => '?').join(',')}) THEN '自动沉淀：走势阶段进入硬拦截区。'
       ELSE COALESCE(NULLIF(trigger_reason, ''), '自动沉淀：规则未放行。')
     END,
     note = '日终流水线自动失效：不再占用入场观察人工队列。',
     updated_at = ?`,
    [...rejectCodes, now]
  );

  const readyRows = await db.all(
    `SELECT o.id, o.symbol, o.name, o.asset_type, o.source, o.trade_date,
            o.close_price, o.invalidation_line, o.action_label, o.trigger_reason, o.trigger_score
     FROM financial_entry_trigger_observations o
     WHERE o.source = ?
       AND o.observation_status = 'watching'
       AND o.entry_action = 'READY_TO_PLAN'`,
    [source]
  );
  const readyIds = readyRows.map((row: any) => Number(row.id));
  await updateObservationsByIds(
    db,
    readyIds,
    `observation_status = 'plan_candidate',
     action_label = COALESCE(NULLIF(action_label, ''), '可生成买入计划草案'),
     note = '日终流水线自动归入计划准备候选；仍需人工填写金额并生成正式计划。',
     updated_at = ?`,
    [now]
  );

  for (const row of readyRows) {
    await db.run(
      `UPDATE financial_candidate_pool
       SET review_status = 'plan_ready',
           final_status = 'READY_FOR_PLAN',
           review_action = 'entry_observation_ready_to_plan',
           last_review_at = ?,
           updated_at = ?
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND pool_status = 'active'`,
      [now, now, row.symbol, row.asset_type, row.source || source]
    );
  }

  const plannedRows = await db.all(
    `SELECT o.id, o.symbol, o.name, o.asset_type, o.source, o.trade_date,
            o.close_price, o.invalidation_line, o.action_label, o.trigger_reason
     FROM financial_entry_trigger_observations o
     WHERE o.source = ?
       AND o.observation_status IN ('confirmed', 'plan_candidate')
       AND EXISTS (
         SELECT 1
         FROM financial_trade_plans p
         WHERE p.symbol = o.symbol
           AND p.asset_type = o.asset_type
           AND p.source = o.source
           AND COALESCE(p.is_deleted, 0) = 0
           AND p.status NOT IN ('cancelled', 'deleted', 'archived')
       )`,
    [source]
  );
  const plannedIds = plannedRows.map((row: any) => Number(row.id));
  await updateObservationsByIds(
    db,
    plannedIds,
    `observation_status = 'planned',
     action_label = '已生成计划',
     note = '日终流水线自动归档：已存在买入计划，不再占用入场观察人工队列。',
     updated_at = ?`,
    [now]
  );

  const orphanOpenRows = await db.all(
    `SELECT o.id, o.symbol, o.name, o.asset_type, o.source, o.trade_date,
            o.close_price, o.invalidation_line, o.action_label, o.trigger_reason
     FROM financial_entry_trigger_observations o
     WHERE o.source = ?
       AND o.observation_status IN ('watching', 'confirmed', 'plan_candidate')
       AND NOT EXISTS (
         SELECT 1
         FROM financial_trade_plans p
         WHERE p.symbol = o.symbol
           AND p.asset_type = o.asset_type
           AND p.source = o.source
           AND COALESCE(p.is_deleted, 0) = 0
           AND p.status NOT IN ('cancelled', 'deleted', 'archived')
       )
       AND NOT EXISTS (
         SELECT 1
         FROM financial_candidate_pool c
         WHERE c.symbol = o.symbol
           AND c.asset_type = o.asset_type
           AND c.source = o.source
           AND c.pool_status = 'active'
           AND (
             o.observation_status = 'watching'
             OR (
               c.review_status = 'plan_ready'
               AND c.final_status = 'READY_FOR_PLAN'
             )
           )
       )`,
    [source]
  );
  const orphanOpenIds = orphanOpenRows.map((row: any) => Number(row.id));
  await updateObservationsByIds(
    db,
    orphanOpenIds,
    `observation_status = 'returned',
     entry_action = 'OBSERVE',
     action_label = '上游已失效',
     note = '日终流水线自动退回：上游备选池已过期/拒绝，且未生成正式买入计划；不再占用入场观察人工队列。',
     updated_at = ?`,
    [now]
  );

  const staleRows = await db.all(
    `SELECT o.id, o.symbol, o.name, o.asset_type, o.source, o.trade_date,
            o.close_price, o.invalidation_line, o.action_label, o.trigger_reason
     FROM financial_entry_trigger_observations o
     WHERE o.source = ?
       AND o.observation_status IN ('watching', 'plan_candidate')
       AND COALESCE(o.trade_date, substr(o.updated_at, 1, 10)) <= date(?, ?)
       AND NOT EXISTS (
         SELECT 1
         FROM financial_trade_plans p
         WHERE p.symbol = o.symbol
           AND p.asset_type = o.asset_type
           AND p.source = o.source
           AND COALESCE(p.is_deleted, 0) = 0
           AND p.status NOT IN ('cancelled', 'deleted', 'archived')
       )`,
    [source, latestTradeDate, `-${staleDays} day`]
  );
  const staleIds = staleRows.map((row: any) => Number(row.id));
  await updateObservationsByIds(
    db,
    staleIds,
    `observation_status = 'returned',
     entry_action = 'OBSERVE',
     action_label = '自动退回',
     note = ?,
     updated_at = ?`,
    [`日终流水线自动沉淀：连续观察超过 ${staleDays} 天仍未触发，等待重新入池或结构重新确认。`, now]
  );

  const rowsToReject = invalidatedRows;
  for (const row of rowsToReject) {
    await db.run(
      `UPDATE financial_candidate_pool
       SET pool_status = 'expired',
           review_status = 'rejected',
           final_status = 'REJECTED',
           forbidden_reason = '入场观察日终自动失效',
           review_action = 'entry_observation_auto_invalidated',
           last_review_at = ?,
           updated_at = ?
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND pool_status = 'active'`,
      [now, now, row.symbol, row.asset_type, row.source || source]
    );
  }

  for (const row of staleRows) {
    await db.run(
      `UPDATE financial_candidate_pool
       SET review_status = CASE
             WHEN COALESCE(review_status, 'unreviewed') IN ('plan_ready', 'wait_confirmation') THEN 'structure_watch'
             ELSE review_status
           END,
           review_action = 'entry_observation_auto_returned',
           last_review_at = ?,
           updated_at = ?
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND pool_status = 'active'`,
      [now, now, row.symbol, row.asset_type, row.source || source]
    );
  }

  const invalidatedDetails = invalidatedRows.map((row: any) => {
    const closePrice = row.close_price === null || row.close_price === undefined ? null : Number(row.close_price);
    const invalidationLine = row.invalidation_line === null || row.invalidation_line === undefined ? null : Number(row.invalidation_line);
    const brokeLine = closePrice !== null && invalidationLine !== null && closePrice < invalidationLine;
    const hardTrend = rejectCodes.includes(String(row.trend_phase_code || ''));
    return {
      category: 'invalidated',
      observation_id: row.id,
      symbol: row.symbol,
      name: row.name,
      asset_type: row.asset_type,
      source: row.source || source,
      trade_date: row.trade_date,
      close_price: closePrice,
      invalidation_line: invalidationLine,
      trend_phase_code: row.trend_phase_code,
      status: '自动失效',
      result: brokeLine
        ? `收盘价 ${closePrice} 跌破失效线 ${invalidationLine}`
        : hardTrend
          ? `走势阶段 ${row.trend_phase_code} 进入硬拦截区`
          : row.trigger_reason || row.action_label || '规则未放行'
    };
  });

  const plannedDetails = plannedRows.map((row: any) => ({
    category: 'planned',
    observation_id: row.id,
    symbol: row.symbol,
    name: row.name,
    asset_type: row.asset_type,
    source: row.source || source,
    trade_date: row.trade_date,
    close_price: row.close_price,
    invalidation_line: row.invalidation_line,
    status: '已计划',
    result: '已存在买入计划，自动归档观察记录'
  }));

  const orphanOpenDetails = orphanOpenRows.map((row: any) => ({
    category: 'returned',
    observation_id: row.id,
    symbol: row.symbol,
    name: row.name,
    asset_type: row.asset_type,
    source: row.source || source,
    trade_date: row.trade_date,
    close_price: row.close_price,
    invalidation_line: row.invalidation_line,
    status: '上游已失效',
    result: '入场观察缺少活跃备选池支撑，自动退回观察'
  }));

  const returnedDetails = staleRows.map((row: any) => ({
    category: 'returned',
    observation_id: row.id,
    symbol: row.symbol,
    name: row.name,
    asset_type: row.asset_type,
    source: row.source || source,
    trade_date: row.trade_date,
    close_price: row.close_price,
    invalidation_line: row.invalidation_line,
    status: '自动退回',
    result: `连续观察超过 ${staleDays} 天仍未触发`
  }));

  const readyDetails = readyRows.map((row: any) => ({
    category: 'ready_to_plan',
    observation_id: row.id,
    symbol: row.symbol,
    name: row.name,
    asset_type: row.asset_type,
    source: row.source || source,
    trade_date: row.trade_date,
    close_price: row.close_price,
    invalidation_line: row.invalidation_line,
    score: row.trigger_score,
    status: '归入计划候选',
    result: row.trigger_reason || row.action_label || '触发条件已满足，等待人工生成计划'
  }));

  const deduped = await dedupeOpenEntryObservations(db, source);
  const details = [
    ...invalidatedDetails,
    ...readyDetails,
    ...plannedDetails,
    ...orphanOpenDetails,
    ...returnedDetails,
    ...deduped.details
  ];

  return {
    message: `入场观察自动沉淀完成：失效 ${invalidatedIds.length} 条，归入计划候选 ${readyIds.length} 条，已计划 ${plannedIds.length} 条，上游失效退回 ${orphanOpenIds.length} 条，超时退回 ${staleIds.length} 条，归并重复 ${deduped.deduped_count} 条`,
    data: {
      latest_trade_date: latestTradeDate,
      stale_days: staleDays,
      invalidated_count: invalidatedIds.length,
      ready_to_plan_count: readyIds.length,
      planned_count: plannedIds.length,
      orphan_ready_returned_count: orphanOpenIds.length,
      orphan_open_returned_count: orphanOpenIds.length,
      returned_count: staleIds.length,
      deduped_count: deduped.deduped_count,
      details
    }
  };
}

type PredictionExperimentProgressStatus = 'running' | 'success' | 'error';
type PredictionExperimentProgressHandler = (
  experiment: { key: string; asset_type?: string; limit?: number },
  status: PredictionExperimentProgressStatus,
  data?: any
) => Promise<void> | void;

function getPredictionExperimentStepKey(experiment: { key: string; asset_type?: string }) {
  return `experiment_prediction_${experiment.key}_${experiment.asset_type || 'all'}`;
}

function getPredictionExperimentStepLabel(experiment: { key: string; asset_type?: string }) {
  const assetLabel = experiment.asset_type ? ` / ${experiment.asset_type}` : '';
  return `${experiment.key}${assetLabel} 预测池落库`;
}

async function runExperimentPredictionSnapshotRollup(
  config: Required<FinancePipelineConfig>,
  onExperimentProgress?: PredictionExperimentProgressHandler
) {
  const experiments = normalizePredictionExperimentConfigs(config);
  if (experiments.length === 0) {
    throw new Error('没有配置需要落库的五模型实验预测池');
  }

  const results = [];
  const localTimeoutMs = normalizeTimeoutMs(config.local_api_timeout_ms);
  for (const experiment of experiments) {
    await onExperimentProgress?.(experiment, 'running', {
      experiment_key: experiment.key,
      asset_type: experiment.asset_type || 'all'
    });
    try {
      const poolParams = new URLSearchParams({
        limit: String(Math.min(Math.max(Number(experiment.limit || config.prediction_pool_limit || 40), 10), 120))
      });
      if (experiment.asset_type) {
        poolParams.set('asset_type', experiment.asset_type);
      }
      const saved = await callLocalApi(
        `/api/finance/experiments/${experiment.key}/prediction-pool/snapshots?${poolParams.toString()}`,
        undefined,
        'POST',
        localTimeoutMs
      );

      const labelParams = new URLSearchParams({
        limit: String(Math.min(Math.max(Number(config.prediction_label_limit || 600), 20), 2000)),
        horizon_days: String(Math.min(Math.max(Number(config.prediction_horizon_days || 20), 5), 60)),
        saved_from: 'latest_prediction_pool'
      });
      if (experiment.asset_type) {
        labelParams.set('asset_type', experiment.asset_type);
      }
      const refreshed = await callLocalApi(
        `/api/finance/experiments/${experiment.key}/prediction-labels/refresh?${labelParams.toString()}`,
        undefined,
        'POST',
        localTimeoutMs
      );

      const item = {
        experiment_key: experiment.key,
        asset_type: experiment.asset_type || 'all',
        success: true,
        saved_count: Number(saved.data?.saved_count || 0),
        inserted_count: Number(saved.data?.inserted_count || 0),
        updated_count: Number(saved.data?.updated_count || 0),
        refreshed_count: Number(refreshed.data?.refreshed_count || 0),
        completed_count: Number(refreshed.data?.completed_count || 0),
        partial_count: Number(refreshed.data?.partial_count || 0),
        pending_count: Number(refreshed.data?.pending_count || 0),
        latest_trade_date: saved.data?.snapshot_summary?.latest_trade_date || null,
        last_saved_at: saved.data?.snapshot_summary?.last_saved_at || null
      };
      results.push(item);
      await onExperimentProgress?.(experiment, 'success', item);
    } catch (error) {
      const item = {
        experiment_key: experiment.key,
        asset_type: experiment.asset_type || 'all',
        success: false,
        message: (error as Error).message
      };
      results.push(item);
      await onExperimentProgress?.(experiment, 'error', item);
    }
  }

  const failedCount = results.filter(item => item.success === false).length;
  if (failedCount === results.length) {
    throw new Error(`五模型实验预测池落库全部失败：${failedCount}/${results.length} 个实验失败`);
  }
  if (failedCount > 0) {
    const failedNames = results
      .filter(item => item.success === false)
      .map((item: any) => `${item.experiment_key}${item.message ? `：${item.message}` : ''}`)
      .join('；');
    throw new Error(`五模型实验预测池落库部分失败：${failedCount}/${results.length} 个实验失败。已阻止日终流水线静默成功，失败项：${failedNames}`);
  }

  const savedCount = results.reduce((sum, item: any) => sum + Number(item.saved_count || 0), 0);
  const insertedCount = results.reduce((sum, item: any) => sum + Number(item.inserted_count || 0), 0);
  const updatedCount = results.reduce((sum, item: any) => sum + Number(item.updated_count || 0), 0);
  const refreshedCount = results.reduce((sum, item: any) => sum + Number(item.refreshed_count || 0), 0);
  const completedCount = results.reduce((sum, item: any) => sum + Number(item.completed_count || 0), 0);
  const partialCount = results.reduce((sum, item: any) => sum + Number(item.partial_count || 0), 0);
  const pendingCount = results.reduce((sum, item: any) => sum + Number(item.pending_count || 0), 0);

  return {
    message: `五模型实验预测池滚动完成：保存 ${savedCount} 条，后验刷新 ${refreshedCount} 条，失败 ${failedCount} 个实验`,
    data: {
      checked_count: results.length,
      saved_count: savedCount,
      inserted_count: insertedCount,
      updated_count: updatedCount,
      refreshed_count: refreshedCount,
      completed_count: completedCount,
      partial_count: partialCount,
      pending_count: pendingCount,
      failed_count: failedCount,
      results
    }
  };
}

export async function runExperimentPredictionSnapshotPipeline(
  config: FinancePipelineConfig = {},
  options: FinancePipelineRuntimeOptions = {}
) {
  const merged = {
    ...DEFAULT_FINANCE_PIPELINE_CONFIG,
    local_api_timeout_ms: 5 * 60 * 1000,
    ...config
  } as Required<FinancePipelineConfig>;

  const experimentConfigs = normalizePredictionExperimentConfigs(merged);
  const steps: FinancePipelineStep[] = experimentConfigs.map(experiment => ({
    key: getPredictionExperimentStepKey(experiment),
    label: getPredictionExperimentStepLabel(experiment),
    status: 'pending'
  }));
  const buildResult = () => {
    const failedSteps = steps.filter(item => item.status === 'error');
    const successCount = steps.filter(item => item.status === 'success').length;
    return {
      summary: {
        total: steps.length,
        success: successCount,
        failed: failedSteps.length,
        failed_step: failedSteps[0]?.key || null
      },
      steps,
      config: {
        prediction_pool_limit: merged.prediction_pool_limit,
        prediction_label_limit: merged.prediction_label_limit,
        prediction_horizon_days: merged.prediction_horizon_days,
        prediction_experiments: merged.prediction_experiments
      },
      finished_at: steps.length > 0 && steps.every(item => item.status !== 'running' && item.status !== 'pending')
        ? (steps[steps.length - 1].finished_at || new Date().toISOString())
        : null
    };
  };

  const publishStep = async (step: FinancePipelineStep) => {
    await options.onProgress?.({
      task_key: options.taskKey,
      step: { ...step },
      result: buildResult()
    });
  };

  const updateExperimentStep = async (
    experiment: { key: string; asset_type?: string },
    status: PredictionExperimentProgressStatus,
    data?: any
  ) => {
    let step = steps.find(item => item.key === getPredictionExperimentStepKey(experiment));
    if (!step) {
      step = {
        key: getPredictionExperimentStepKey(experiment),
        label: getPredictionExperimentStepLabel(experiment),
        status: 'pending'
      };
      steps.push(step);
    }
    if (status === 'running' && !step.started_at) {
      step.started_at = new Date().toISOString();
    }
    step.status = status;
    step.message = status === 'running'
      ? '正在保存预测池并刷新后验标签'
      : data?.message || (status === 'success' ? '预测池落库完成' : '预测池落库失败');
    step.data = data;
    if (status !== 'running') {
      step.finished_at = new Date().toISOString();
    }
    await publishStep(step);
  };

  if (steps.length > 0) {
    await publishStep(steps[0]);
  }

  try {
    await runExperimentPredictionSnapshotRollup(merged, updateExperimentStep);
  } catch (error) {
    const message = (error as Error).message;
    const unfinished = steps.filter(item => item.status === 'pending' || item.status === 'running');
    if (unfinished.length === 0 && steps.length === 0) {
      steps.push({
        key: 'experiment_prediction_snapshots',
        label: '五模型实验预测池落库',
        status: 'error',
        message,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString()
      });
    } else {
      for (const step of unfinished) {
        step.status = 'error';
        step.message = message;
        step.finished_at = new Date().toISOString();
      }
    }
  }

  const result = buildResult();
  await options.onProgress?.({
    task_key: options.taskKey,
    step: { ...(steps.find(item => item.status === 'error') || steps[steps.length - 1]) },
    result
  });
  return result;
}

function buildPipelineResult(steps: FinancePipelineStep[], config: any) {
  const failedStep = steps.find(step => step.status === 'error');
  return {
    summary: {
      total: steps.length,
      success: steps.filter(step => step.status === 'success').length,
      skipped: steps.filter(step => step.status === 'skipped').length,
      failed: failedStep ? 1 : 0,
      failed_step: failedStep?.key || null
    },
    steps,
    config,
    finished_at: new Date().toISOString()
  };
}

function isMarketGateOpen(marketGate: any) {
  return marketGate?.entry_permission === 'ALLOW_STRUCTURE_CHECK';
}

function isEntrySnapshotBlockedByMarketGate(snapshot: any) {
  return snapshot?.action === 'BLOCKED' && snapshot?.entry_permission !== 'ALLOW_STRUCTURE_CHECK';
}

function isEntrySnapshotInvalidated(snapshot: any) {
  if (isEntrySnapshotBlockedByMarketGate(snapshot)) return false;
  return snapshot?.action === 'BLOCKED'
    || snapshot?.action === 'INVALIDATED'
    || snapshot?.structure_status === 'STRUCTURE_BROKEN'
    || (snapshot?.close && snapshot?.invalidation_line && snapshot.close < snapshot.invalidation_line);
}

function getMarketGateStopReason(marketGate: any) {
  if (marketGate?.stale) return marketGate.freshness_reason;
  return marketGate?.entry_reason
    || marketGate?.result_reason
    || marketGate?.freshness_reason
    || '市场总闸未开放单标的结构判断。';
}

async function skipPendingPipelineSteps(
  steps: FinancePipelineStep[],
  message: string,
  data: any,
  options?: FinancePipelineRuntimeOptions,
  buildResult?: () => any
) {
  const finishedAt = new Date().toISOString();
  for (const step of steps) {
    if (step.status !== 'pending') continue;
    step.status = 'skipped';
    step.message = message;
    step.data = data;
    step.finished_at = finishedAt;
    await emitPipelineProgress(options, step, buildResult ? buildResult() : { steps });
  }
}

async function emitPipelineProgress(
  options: FinancePipelineRuntimeOptions | undefined,
  step: FinancePipelineStep,
  result: any
) {
  if (!options?.onProgress) return;
  try {
    await options.onProgress({
      task_key: options.taskKey,
      step,
      result
    });
  } catch (error) {
    console.warn(`[finance-pipeline] progress callback failed: ${(error as Error).message}`);
  }
}

async function runPipelineStep(
  steps: FinancePipelineStep[],
  key: string,
  fn: () => Promise<any>,
  options?: FinancePipelineRuntimeOptions,
  buildResult?: () => any
) {
  const step = steps.find(item => item.key === key);
  if (!step) return true;
  step.status = 'running';
  step.started_at = new Date().toISOString();
  await emitPipelineProgress(options, step, buildResult ? buildResult() : { steps });
  try {
    const result = await fn();
    step.status = 'success';
    step.message = result.message || '完成';
    step.data = result.data;
    step.finished_at = new Date().toISOString();
    await emitPipelineProgress(options, step, buildResult ? buildResult() : { steps });
    return true;
  } catch (error) {
    step.status = 'error';
    step.message = (error as Error).message;
    step.finished_at = new Date().toISOString();
    await emitPipelineProgress(options, step, buildResult ? buildResult() : { steps });
    return false;
  }
}

async function markEmbeddedCandidateFunnelTaskSuccess(message: string) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.run(
    `UPDATE task_center_tasks
     SET last_status = 'success',
         last_message = ?,
         last_run_at = ?,
         updated_at = ?
     WHERE task_key = 'finance_candidate_funnel_pipeline'`,
    [`日终流水线内置执行：${message}`, now, now]
  );
}

export async function runFinanceDailyPipeline(config?: FinancePipelineConfig | null, options?: FinancePipelineRuntimeOptions) {
  const merged = mergeConfig(config);
  const db = await getDb();
  const steps: FinancePipelineStep[] = [
    { key: 'daily_prices', label: '本地日线更新', status: 'pending' },
    { key: 'market_environment', label: '市场总闸更新', status: 'pending' },
    { key: 'entry_observation_preflight_settlement', label: '入场观察预沉淀', status: 'pending' },
    { key: 'model_feature_refresh', label: '个股/ETF模型特征新鲜度检查', status: 'pending' },
    { key: 'candidate_scan', label: '个股/ETF备选池扫描', status: 'pending' },
    { key: 'model_recheck_auto', label: '模型复核自动流转', status: 'pending' },
    { key: 'model_candidate_scores', label: '个股/ETF候选模型分数同步', status: 'pending' },
    { key: 'candidate_funnel', label: '入池漏斗刷新', status: 'pending' },
    { key: 'entry_trigger_scan', label: '入场触发扫描', status: 'pending' },
    { key: 'entry_observation_settlement', label: '入场观察自动沉淀', status: 'pending' },
    { key: 'active_plan_suggestions', label: '持仓/计划建议同步', status: 'pending' },
    { key: 'decision_sample_tracking', label: '决策样本轨迹', status: 'pending' },
    { key: 'signal_lifecycle_sync', label: '信号生命周期同步', status: 'pending' },
    { key: 'sample_validation_snapshot', label: '样本验证快照', status: 'pending' },
    { key: 'experiment_prediction_snapshots', label: '五模型实验预测池落库', status: 'pending' },
    { key: 'workflow_summary', label: '指挥台快照', status: 'pending' }
  ];

  const buildResult = () => buildPipelineResult(steps, merged);
  const runStep = (key: string, fn: () => Promise<any>) => runPipelineStep(
    steps,
    key,
    fn,
    { ...options, taskKey: options?.taskKey || 'finance_daily_pipeline' },
    buildResult
  );
  let dailyPriceResult: any = null;
  let marketGate: any = null;

  if (!await runStep('daily_prices', async () => {
    const dailyPriceCandidateLimit = Math.min(
      Math.max(Number(merged.daily_price_candidate_limit || 80), 20),
      Math.max(Number(merged.candidate_limit || 80), 20),
      120
    );
    dailyPriceResult = await callLocalApi('/api/finance/asset-universe/daily-close-update', {
      source: merged.source,
      active_plan_limit: merged.active_plan_limit,
      candidate_limit: dailyPriceCandidateLimit,
      universe_limit: merged.universe_limit,
      wait_full_universe: merged.wait_full_universe === true,
      interval_ms: merged.interval_ms
    });
    const targetTradeDate = dailyPriceResult?.data?.target_trade_date || null;
    if (targetTradeDate) {
      const coverage = await getTradeDateCoverage(db, targetTradeDate, {
        source: merged.source,
        assetTypes: ['stock', 'etf', 'index']
      });
      if (coverage.status === 'incomplete') {
        throw new Error(`全市场日线覆盖不足，日终流水线停止向下推进：${targetTradeDate} 当前 ${coverage.current_count} 个，上一交易日 ${coverage.previous_trade_date || '--'} ${coverage.previous_count} 个，阈值 ${coverage.min_expected}。本轮只允许保留日线补齐进度，不刷新市场总闸、备选池、模型复核和入池漏斗。`);
      }
      return {
        ...dailyPriceResult,
        data: {
          ...(dailyPriceResult?.data || {}),
          coverage
        }
      };
    }
    return dailyPriceResult;
  })) return buildResult();

  if (!await runStep('market_environment', async () => {
    const result = await callLocalApi('/api/finance/market/environment/update', {
      symbols: merged.market_symbols,
      force: merged.force === true
    });
    marketGate = await getFreshMarketRegime(db, { source: merged.source });
    const downstreamBlocked = !isMarketGateOpen(marketGate);
    return {
      ...result,
      data: {
        ...(result?.data || {}),
        market_gate: marketGate,
        downstream_blocked: downstreamBlocked
      }
    };
  })) return buildResult();

  if (!isMarketGateOpen(marketGate)) {
    const reason = getMarketGateStopReason(marketGate);
    await skipPendingPipelineSteps(
      steps,
      `市场总闸未通过，下游金融漏斗禁止推进：${reason}`,
      {
        market_gate: marketGate,
        downstream_blocked: true
      },
      { ...options, taskKey: options?.taskKey || 'finance_daily_pipeline' },
      buildResult
    );
    return buildResult();
  }

  if (!await runStep('entry_observation_preflight_settlement', () => runEntryObservationAutoSettlement(merged.source))) return buildResult();

  if (!await runStep('model_feature_refresh', () => refreshModelFeatureTables(merged))) return buildResult();

  const minCandidateTradeDate = dailyPriceResult?.data?.target_trade_date || null;
  if (!await runStep('candidate_scan', async () => {
    if (minCandidateTradeDate) {
      const coverage = await getTradeDateCoverage(db, minCandidateTradeDate, {
        source: merged.source,
        assetTypes: ['stock', 'etf', 'index']
      });
      if (coverage.status === 'incomplete') {
        throw new Error(`全市场日线覆盖不足，备选池扫描停止推进：${minCandidateTradeDate} 当前 ${coverage.current_count} 个，上一交易日 ${coverage.previous_trade_date || '--'} ${coverage.previous_count} 个，阈值 ${coverage.min_expected}。本轮未执行备选池状态清理，避免半截行情改动业务队列。`);
      }
    }
    const cleanupBefore = await normalizeCandidatePoolFlowState(db);
    const result = await callLocalApi('/api/finance/candidate-pool/scan-universe', {
      universe_type: 'all',
      source: merged.source,
      ...(minCandidateTradeDate ? { min_trade_date: minCandidateTradeDate } : {})
    });
    const cleanupAfter = await normalizeCandidatePoolFlowState(db);
    return {
      ...result,
      data: {
        ...(result?.data || {}),
        candidate_state_cleanup: {
          before_scan: cleanupBefore,
          after_scan: cleanupAfter
        }
      }
    };
  })) return buildResult();

  if (!await runStep('model_recheck_auto', async () => {
    const result = await runModelRecheckAutomation(merged);
    const cleanupAfter = await normalizeCandidatePoolFlowState(db);
    return {
      ...result,
      data: {
        ...(result?.data || {}),
        candidate_state_cleanup: cleanupAfter
      }
    };
  })) return buildResult();

  if (!await runStep('model_candidate_scores', () => syncModelCandidateScores(merged))) return buildResult();

  if (!await runStep('candidate_funnel', async () => {
    const result = await runFinanceCandidateFunnelPipeline({
      source: merged.source,
      candidate_limit: Math.max(Number(merged.candidate_limit || 120), 120),
      secondary_scan_limit: merged.secondary_scan_limit
    });
    const failedStep = result.steps.find((step: any) => step.status === 'error');
    if (failedStep) {
      throw new Error(`入池漏斗停在「${failedStep.label}」：${failedStep.message || '原因未知'}`);
    }
    const message = `入池漏斗刷新完成：${result.summary.success}/${result.summary.total} 步完成`;
    await markEmbeddedCandidateFunnelTaskSuccess(message);
    return {
      message,
      data: result
    };
  })) return buildResult();

  if (!await runStep('entry_trigger_scan', () => callLocalApi('/api/finance/assets/entry-trigger-observations/secondary-scan', {
    limit: merged.secondary_scan_limit
  }))) return buildResult();

  if (!await runStep('entry_observation_settlement', () => runEntryObservationAutoSettlement(merged.source))) return buildResult();

  if (!await runStep('active_plan_suggestions', () => callLocalApi('/api/finance/trade-plans/sync-active-suggestions', {
    limit: merged.active_plan_limit
  }))) return buildResult();

  if (!await runStep('decision_sample_tracking', () => callLocalApi('/api/finance/decision-samples/sync'))) return buildResult();

  if (!await runStep('signal_lifecycle_sync', () => callLocalApi('/api/finance/signal-lifecycles/sync-observations', {
    limit: 800
  }))) return buildResult();

  if (!await runStep('sample_validation_snapshot', () => callLocalApi('/api/finance/sample-validation/snapshot'))) return buildResult();

  if (!await runStep('experiment_prediction_snapshots', () => runExperimentPredictionSnapshotRollup(merged))) return buildResult();

  await runStep('workflow_summary', () => callLocalApi('/api/finance/workflow-summary', undefined, 'GET'));

  return buildResult();
}

export async function runFinanceCandidateFunnelPipeline(config?: FinanceCandidateFunnelConfig | null, options?: FinancePipelineRuntimeOptions) {
  const merged = mergeFunnelConfig(config);
  const db = await getDb();
  const steps: FinancePipelineStep[] = [
    { key: 'active_candidate_collect', label: '读取当前备选池', status: 'pending' },
    { key: 'trend_phase_recalc', label: '走势阶段重算', status: 'pending' },
    { key: 'candidate_recheck', label: '单标的判断', status: 'pending' },
    { key: 'entry_observation_seed', label: '推进入场观察', status: 'pending' },
    { key: 'entry_trigger_scan', label: '入场触发确认', status: 'pending' },
    { key: 'entry_observation_settlement', label: '入场观察自动沉淀', status: 'pending' }
  ];

  const buildResult = () => buildPipelineResult(steps, merged);
  const runStep = (key: string, fn: () => Promise<any>) => runPipelineStep(
    steps,
    key,
    fn,
    { ...options, taskKey: options?.taskKey || 'finance_candidate_funnel_pipeline' },
    buildResult
  );
  const nowIso = () => new Date().toISOString();
  let candidates: any[] = [];
  let trendReadyCandidates: any[] = [];
  let qualifiedCandidates: any[] = [];
  let readyObservationIds: number[] = [];

  const marketGate = await getFreshMarketRegime(db, { source: merged.source });
  if (!isMarketGateOpen(marketGate)) {
    const reason = getMarketGateStopReason(marketGate);
    await skipPendingPipelineSteps(
      steps,
      `市场总闸未通过，入池漏斗禁止推进：${reason}`,
      {
        market_gate: marketGate,
        downstream_blocked: true
      },
      { ...options, taskKey: options?.taskKey || 'finance_candidate_funnel_pipeline' },
      buildResult
    );
    return buildResult();
  }

  if (!await runStep('active_candidate_collect', async () => {
    const latestPriceRow = await db.get(
      `SELECT MAX(trade_date) AS trade_date
       FROM financial_daily_prices
       WHERE source = ?
         AND asset_type IN ('stock', 'etf', 'index')
         AND close IS NOT NULL
         AND close > 0`,
      [merged.source]
    );
    const latestPriceTradeDate = latestPriceRow?.trade_date ? String(latestPriceRow.trade_date) : null;
    if (latestPriceTradeDate) {
      const coverage = await getTradeDateCoverage(db, latestPriceTradeDate, {
        source: merged.source,
        assetTypes: ['stock', 'etf', 'index'],
      });
      if (coverage.status === 'incomplete') {
        throw new Error(`全市场日线覆盖不足，入池漏斗停止推进：${latestPriceTradeDate} 当前 ${coverage.current_count} 个，上一交易日 ${coverage.previous_trade_date || '--'} ${coverage.previous_count} 个，阈值 ${coverage.min_expected}。本轮未执行状态清理、走势重算和入场观察更新，避免半截行情改动业务队列。`);
      }
    }
    const normalizedAt = nowIso();
    const normalized = await db.run(
      `UPDATE financial_candidate_pool
       SET pool_status = 'expired',
           final_status = 'REJECTED',
           review_action = CASE
             WHEN COALESCE(review_action, '') = '' THEN 'auto_status_cleanup'
             ELSE review_action
           END,
           updated_at = ?
       WHERE pool_status = 'active'
         AND asset_type IN ('stock', 'etf')
         AND COALESCE(review_status, '') = 'rejected'`,
      [normalizedAt]
    );
    const normalizedCount = Number(normalized?.changes || 0);
    const normalizedExpiredFinalStatus = await db.run(
      `UPDATE financial_candidate_pool
       SET final_status = 'REJECTED',
           updated_at = ?
       WHERE pool_status = 'expired'
         AND asset_type IN ('stock', 'etf')
         AND COALESCE(final_status, '') <> 'REJECTED'`,
      [normalizedAt]
    );
    const normalizedExpiredFinalStatusCount = Number(normalizedExpiredFinalStatus?.changes || 0);
    const normalizedExpiredReviewStatus = await db.run(
      `UPDATE financial_candidate_pool
       SET review_status = 'rejected',
           review_action = CASE
             WHEN COALESCE(review_action, '') = '' THEN 'auto_expired_status_cleanup'
             ELSE review_action
           END,
           updated_at = ?
       WHERE pool_status = 'expired'
         AND COALESCE(review_status, '') <> 'rejected'`,
      [normalizedAt]
    );
    const normalizedExpiredReviewStatusCount = Number(normalizedExpiredReviewStatus?.changes || 0);
    const normalizedExpiredReviewAction = await db.run(
      `UPDATE financial_candidate_pool
       SET review_action = 'expired_rejected_status_cleanup',
           updated_at = ?
       WHERE pool_status = 'expired'
         AND asset_type IN ('stock', 'etf')
         AND COALESCE(review_status, '') = 'rejected'
         AND COALESCE(review_action, '') = ''`,
      [normalizedAt]
    );
    const normalizedExpiredReviewActionCount = Number(normalizedExpiredReviewAction?.changes || 0);
    const normalizedFinalStatus = await db.run(
      `UPDATE financial_candidate_pool
       SET final_status = 'WAIT',
           updated_at = ?
       WHERE pool_status = 'active'
         AND asset_type IN ('stock', 'etf')
         AND review_status IN ('trend_blocked', 'structure_pending', 'structure_watch', 'wait_confirmation', 'unreviewed', 'drafted')
         AND final_status = 'READY_FOR_PLAN'`,
      [normalizedAt]
    );
    const normalizedFinalStatusCount = Number(normalizedFinalStatus?.changes || 0);
    const normalizedSettledRecheck = await db.run(
      `UPDATE financial_candidate_pool
       SET final_status = 'REJECTED',
           updated_at = ?
       WHERE review_action = 'auto_model_recheck_settled'
         AND review_status = 'rejected'
         AND final_status = 'READY_FOR_PLAN'`,
      [normalizedAt]
    );
    const normalizedSettledRecheckCount = Number(normalizedSettledRecheck?.changes || 0);
    const normalizedStaleReview = await db.run(
      `UPDATE financial_candidate_pool
       SET review_status = 'unreviewed',
           last_review_id = NULL,
           last_review_at = NULL,
           review_action = CASE
             WHEN COALESCE(review_action, '') = '' THEN 'stale_review_cleanup'
             ELSE review_action || '_stale_cleared'
           END,
           updated_at = ?
       WHERE pool_status = 'active'
         AND asset_type IN ('stock', 'etf')
         AND last_review_id IS NOT NULL
         AND COALESCE(review_status, 'unreviewed') NOT IN ('plan_ready', 'wait_confirmation', 'rejected')
         AND EXISTS (
           SELECT 1
           FROM financial_candidate_reviews r
           WHERE r.id = financial_candidate_pool.last_review_id
             AND r.trade_date < financial_candidate_pool.trade_date
         )`,
      [normalizedAt]
    );
    const normalizedStaleReviewCount = Number(normalizedStaleReview?.changes || 0);
    candidates = await db.all(
      `SELECT id, symbol, name, asset_type, source, priority_score, trade_date, review_status
       FROM financial_candidate_pool
       WHERE pool_status = 'active'
         AND source = ?
         AND asset_type IN ('stock', 'etf')
         AND COALESCE(review_status, 'unreviewed') NOT IN ('rejected', 'plan_ready')
       ORDER BY priority_score DESC, last_checked_at DESC, id DESC
       LIMIT ?`,
      [merged.source, Math.max(Math.min(Number(merged.candidate_limit || 120), 300), 1)]
    );
    return {
      message: `读取 active 备选 ${candidates.length} 个${normalizedCount ? `，清理 rejected 残留 ${normalizedCount} 个` : ''}${normalizedExpiredFinalStatusCount ? `，沉淀 expired 状态 ${normalizedExpiredFinalStatusCount} 个` : ''}${normalizedExpiredReviewStatusCount ? `，清理 expired 复核状态 ${normalizedExpiredReviewStatusCount} 个` : ''}${normalizedExpiredReviewActionCount ? `，补齐 expired 审计动作 ${normalizedExpiredReviewActionCount} 个` : ''}${normalizedFinalStatusCount ? `，修正状态错位 ${normalizedFinalStatusCount} 个` : ''}${normalizedSettledRecheckCount ? `，修正模型沉淀 ${normalizedSettledRecheckCount} 个` : ''}${normalizedStaleReviewCount ? `，清掉过期复核引用 ${normalizedStaleReviewCount} 个` : ''}`,
      data: {
        items: candidates,
        normalized_rejected_active_count: normalizedCount,
        normalized_expired_final_status_count: normalizedExpiredFinalStatusCount,
        normalized_expired_review_status_count: normalizedExpiredReviewStatusCount,
        normalized_expired_review_action_count: normalizedExpiredReviewActionCount,
        normalized_final_status_count: normalizedFinalStatusCount,
        normalized_settled_recheck_count: normalizedSettledRecheckCount,
        normalized_stale_review_count: normalizedStaleReviewCount
      }
    };
  })) return buildResult();

  if (!await runStep('trend_phase_recalc', async () => {
    const results = [];
    for (const item of candidates) {
      try {
        const result = await callLocalApi('/api/finance/trend-phase/recalc', {
          symbol: item.symbol,
          asset_type: item.asset_type,
          source: item.source || merged.source
        });
        const latestTrend = await db.get(
          `SELECT trend_phase_code, trend_phase_reason, trade_date
           FROM financial_trend_phase_results
           WHERE symbol = ? AND asset_type = ? AND source = ? AND rule_version = ?
           ORDER BY trade_date DESC
           LIMIT 1`,
          [item.symbol, item.asset_type, item.source || merged.source, TREND_PHASE_VERSION]
        );
        const trendCode = latestTrend?.trend_phase_code || 'UNKNOWN';
        const trendReason = latestTrend?.trend_phase_reason || `走势阶段为 ${trendCode}，未达到准备入场阶段。`;
        const decision = getTrendPhaseDecision(trendCode);
        if (decision.action === 'advance') {
          trendReadyCandidates.push(item);
          const now = nowIso();
          await db.run(
            `UPDATE financial_candidate_pool
             SET review_status = CASE
                   WHEN COALESCE(review_status, 'unreviewed') IN ('trend_blocked', 'unreviewed', 'drafted') THEN 'structure_pending'
                   ELSE review_status
                 END,
                 trend_phase_code = ?,
                 trend_phase_reason = ?,
                 candidate_reason = CASE
                   WHEN COALESCE(candidate_reason, '') = '' THEN ?
                   ELSE candidate_reason
                 END,
                 review_action = 'trend_phase_advanced',
                 last_review_at = ?,
                 updated_at = ?
             WHERE id = ?
               AND pool_status = 'active'
               AND COALESCE(review_status, 'unreviewed') NOT IN ('rejected', 'plan_ready')`,
            [trendCode, trendReason, `走势阶段已通过：${getShortTrendReason(trendCode, trendReason)}`, now, now, item.id]
          );
        } else if (decision.action === 'reject') {
          const now = nowIso();
          const reason = `${decision.label}：${getShortTrendReason(trendCode, trendReason)}`;
          await db.run(
            `UPDATE financial_candidate_pool
             SET pool_status = 'expired',
                 review_status = 'rejected',
                 final_status = 'REJECTED',
                 trend_phase_code = ?,
                 trend_phase_reason = ?,
                 candidate_reason = ?,
                 forbidden_reason = ?,
                 last_review_at = ?,
                 review_action = 'trend_phase_rejected',
                 updated_at = ?
             WHERE id = ?
               AND pool_status = 'active'
               AND COALESCE(review_status, 'unreviewed') NOT IN ('plan_ready')`,
            [trendCode, trendReason, reason, reason, now, now, item.id]
          );
          await db.run(
            `UPDATE financial_entry_trigger_observations
             SET observation_status = 'invalidated',
                 entry_action = 'BLOCKED',
                 action_label = '走势淘汰',
                 trigger_reason = ?,
                 trend_phase_code = ?,
                 note = ?,
                 updated_at = ?
             WHERE symbol = ?
               AND asset_type = ?
               AND source = ?
               AND observation_status IN ('watching', 'plan_candidate', 'confirmed')`,
            [
              reason,
              trendCode,
              '入池漏斗走势阶段硬拦截：本轮踢出 active 备选，后续重新符合条件再由备选池扫描带回。',
              now,
              item.symbol,
              item.asset_type,
              item.source || merged.source
            ]
          );
        } else {
          const now = nowIso();
          await db.run(
            `UPDATE financial_candidate_pool
             SET review_status = 'trend_blocked',
                 trend_phase_code = ?,
                 trend_phase_reason = ?,
                 candidate_reason = ?,
                 review_action = 'trend_phase_hold',
                 last_review_at = ?,
                 updated_at = ?
             WHERE id = ?
               AND pool_status = 'active'
               AND COALESCE(review_status, 'unreviewed') NOT IN ('rejected', 'plan_ready')`,
            [trendCode, trendReason, `走势阶段卡住：${getShortTrendReason(trendCode, trendReason)}`, now, now, item.id]
          );
          await db.run(
            `UPDATE financial_entry_trigger_observations
             SET observation_status = 'returned',
                 entry_action = 'OBSERVE',
                 action_label = '退回走势队列',
                 trigger_reason = ?,
                 trend_phase_code = ?,
                 note = ?,
                 updated_at = ?
             WHERE symbol = ?
               AND asset_type = ?
               AND source = ?
               AND observation_status IN ('watching', 'plan_candidate', 'confirmed')`,
            [
              `走势阶段为 ${trendCode}，未达到准备入场阶段。`,
              trendCode,
              '入池漏斗走势阶段留队：退回走势阶段队列，不占用入场观察人工队列。',
              now,
              item.symbol,
              item.asset_type,
              item.source || merged.source
            ]
          );
        }
        results.push({
          symbol: item.symbol,
          name: item.name,
          asset_type: item.asset_type,
          success: true,
          passed: decision.action === 'advance',
          decision: decision.action,
          decision_label: decision.label,
          trend_phase_code: trendCode,
          message: result.message,
          reason: `走势阶段${decision.label}：${trendCode}`,
          data: result.data
        });
      } catch (error) {
        results.push({
          symbol: item.symbol,
          name: item.name,
          asset_type: item.asset_type,
          success: false,
          message: (error as Error).message
        });
      }
    }
    const failedCount = results.filter((item: any) => item.success === false).length;
    if (candidates.length > 0 && failedCount === candidates.length) {
      throw new Error(`走势阶段重算全部失败：${failedCount}/${candidates.length} 个标的接口失败`);
    }
    const holdCount = results.filter((item: any) => item.success !== false && item.decision === 'hold').length;
    const rejectedCount = results.filter((item: any) => item.success !== false && item.decision === 'reject').length;
    return {
      message: `走势阶段重算完成：推进 ${trendReadyCandidates.length} 个，留队 ${holdCount} 个，踢出 ${rejectedCount} 个，失败 ${failedCount} 个`,
      data: {
        results,
        checked_count: candidates.length,
        passed_count: trendReadyCandidates.length,
        hold_count: holdCount,
        rejected_count: rejectedCount,
        blocked_count: holdCount + rejectedCount,
        failed_count: failedCount
      }
    };
  })) return buildResult();

  if (!await runStep('candidate_recheck', async () => {
    const results = [];
    for (const item of trendReadyCandidates) {
      try {
        const result = await callLocalApi(`/api/finance/candidate-pool/structure-queue/${item.id}/recheck`, undefined, 'POST');
        const evaluation = result.data?.evaluation || {};
        const queueItem = result.data?.item || {};
        const passedStructure = queueItem.review_status === 'wait_confirmation' || result.data?.decision?.review_status === 'wait_confirmation';
        if (passedStructure) {
          qualifiedCandidates.push(item);
        }
        results.push({
          symbol: item.symbol,
          name: item.name,
          asset_type: item.asset_type,
          selected: passedStructure,
          review_status: queueItem.review_status || result.data?.decision?.review_status,
          priority_score: evaluation.priority_score,
          reason: queueItem.queue_reason || evaluation.candidate_reason || evaluation.reason || result.message
        });
      } catch (error) {
        results.push({
          symbol: item.symbol,
          name: item.name,
          asset_type: item.asset_type,
          selected: false,
          success: false,
          reason: (error as Error).message
        });
      }
    }
    const failedCount = results.filter((item: any) => item.success === false).length;
    if (trendReadyCandidates.length > 0 && failedCount === trendReadyCandidates.length) {
      throw new Error(`备选资格复核全部失败：${failedCount}/${trendReadyCandidates.length} 个标的接口失败`);
    }
    const rejectedCount = results.filter((item: any) => item.success !== false && item.review_status === 'rejected').length;
    const watchCount = results.filter((item: any) => item.success !== false && ['structure_watch', 'trend_blocked', 'model_conflict'].includes(item.review_status)).length;
    return {
      message: `单标的判断完成：通过 ${qualifiedCandidates.length} 个，观察/回退 ${watchCount} 个，淘汰 ${rejectedCount} 个，失败 ${failedCount} 个`,
      data: {
        results,
        selected_count: qualifiedCandidates.length,
        watch_count: watchCount,
        rejected_count: rejectedCount,
        failed_count: failedCount,
        checked_count: trendReadyCandidates.length
      }
    };
  })) return buildResult();

  if (!await runStep('entry_observation_seed', async () => {
    const results = [];
    for (const item of qualifiedCandidates) {
      try {
        const trigger = await callLocalApi('/api/finance/assets/entry-trigger', {
          symbol: item.symbol,
          asset_type: item.asset_type,
          source: item.source || merged.source
        });
        const snapshot = trigger.data;
        if (snapshot?.action !== 'READY_TO_PLAN') {
          const invalidated = isEntrySnapshotInvalidated(snapshot);
          const nextObservationStatus = invalidated ? 'invalidated' : 'watching';
          const trendReady = FUNNEL_READY_TREND_PHASES.has(snapshot?.trend_phase_code || '');
          const structureDegraded =
            snapshot?.structure_status !== 'STRUCTURE_CONFIRMED' ||
            snapshot?.safe_zone_status !== 'SAFE_ZONE' ||
            (typeof snapshot?.structure_score?.score === 'number' && snapshot.structure_score.score < 50);
          const nextCandidateStatus = invalidated
            ? 'rejected'
            : !trendReady
              ? 'trend_blocked'
              : structureDegraded
                ? 'structure_watch'
                : 'wait_confirmation';
          const scanConclusion = invalidated
            ? '入池漏斗预检：失效淘汰'
            : nextCandidateStatus === 'structure_watch'
              ? '入池漏斗预检：结构/安全区退化，退回单标的判断'
              : nextCandidateStatus === 'trend_blocked'
                ? '入池漏斗预检：走势阶段退化，退回走势队列'
                : '入池漏斗预检：买点未触发，留在入场触发观察';
          const now = nowIso();
          const existingObservations = await db.all(
            `SELECT id
             FROM financial_entry_trigger_observations
             WHERE symbol = ?
               AND asset_type = ?
               AND source = ?
               AND observation_status IN ('plan_candidate', 'confirmed', 'watching')
             ORDER BY updated_at DESC, id DESC`,
            [item.symbol, item.asset_type, item.source || merged.source]
          );
          if (existingObservations.length > 0) {
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
               WHERE id IN (${existingObservations.map(() => '?').join(',')})`,
	              [
	                nextObservationStatus,
	                snapshot?.trade_date || null,
	                snapshot?.action || '',
                snapshot?.action_label || '',
                snapshot?.trigger_score || 0,
                snapshot?.trigger_reason || '',
                snapshot?.structure_score?.score || null,
                snapshot?.trend_phase_code || '',
                snapshot?.market_regime || '',
                snapshot?.entry_permission || '',
                snapshot?.close || null,
                snapshot?.ma20 || null,
                snapshot?.ma60 || null,
                snapshot?.invalidation_line || null,
                JSON.stringify(snapshot || {}),
                scanConclusion,
                now,
                ...existingObservations.map((row: any) => row.id)
              ]
            );
            for (const observation of existingObservations) {
              await recordSignalLifecycleCheck(db, {
                symbol: item.symbol,
                name: snapshot?.name || item.name,
                assetType: item.asset_type,
                source: item.source || merged.source,
                observationId: observation.id,
                observationStatus: nextObservationStatus,
                candidateReviewStatus: nextCandidateStatus,
                scanConclusion,
                snapshot
              });
            }
          }
	          await db.run(
	            `UPDATE financial_candidate_pool
	             SET review_status = ?,
	                 pool_status = CASE
	                   WHEN ? = 'rejected' THEN 'expired'
	                   ELSE pool_status
	                 END,
	                 final_status = CASE
	                   WHEN ? = 'rejected' THEN 'REJECTED'
	                   ELSE 'WAIT'
	                 END,
	                 trade_date = COALESCE(?, trade_date),
	                 close = COALESCE(?, close),
	                 ma20 = COALESCE(?, ma20),
	                 ma60 = COALESCE(?, ma60),
	                 invalidation_line = COALESCE(?, invalidation_line),
	                 trend_phase_code = COALESCE(NULLIF(?, ''), trend_phase_code),
	                 trend_phase_reason = COALESCE(NULLIF(?, ''), trend_phase_reason),
	                 market_regime = COALESCE(NULLIF(?, ''), market_regime),
	                 entry_permission = COALESCE(NULLIF(?, ''), entry_permission),
	                 updated_at = ?
	             WHERE symbol = ?
               AND asset_type = ?
               AND source = ?
               AND pool_status = 'active'
               AND review_status IN ('structure_ready', 'wait_confirmation', 'unreviewed')`,
	            [
	              nextCandidateStatus,
	              nextCandidateStatus,
	              nextCandidateStatus,
	              snapshot?.trade_date || null,
	              snapshot?.close || null,
	              snapshot?.ma20 || null,
	              snapshot?.ma60 || null,
	              snapshot?.invalidation_line || null,
	              snapshot?.trend_phase_code || '',
	              snapshot?.trend_phase_reason || '',
	              snapshot?.market_regime || '',
	              snapshot?.entry_permission || '',
	              now,
	              item.symbol,
              item.asset_type,
              item.source || merged.source
            ]
          );
          results.push({
            symbol: item.symbol,
            name: snapshot?.name || item.name,
            asset_type: item.asset_type,
            passed: false,
            downgraded: existingObservations.length > 0,
            action: snapshot?.action,
            action_label: snapshot?.action_label,
            trigger_score: snapshot?.trigger_score,
            reason: snapshot?.trigger_reason || '入场触发未通过'
          });
          continue;
        }

        const saved = await callLocalApi('/api/finance/assets/entry-trigger-observations', {
          snapshot,
          source: snapshot?.data_source_used || item.source || merged.source,
          note: '入池漏斗流水线自动推进至入场触发观察；只生成流程建议，不自动建仓。'
        });
        if (saved.data?.id) {
          readyObservationIds.push(Number(saved.data.id));
        }
        results.push({
          symbol: item.symbol,
          name: snapshot?.name || item.name,
          asset_type: item.asset_type,
          passed: true,
          action: snapshot?.action,
          action_label: snapshot?.action_label,
          trigger_score: snapshot?.trigger_score,
          observation_status: saved.data?.observation_status,
          observation_id: saved.data?.id,
          reason: snapshot?.trigger_reason
        });
      } catch (error) {
        results.push({
          symbol: item.symbol,
          name: item.name,
          asset_type: item.asset_type,
          success: false,
          reason: (error as Error).message
        });
      }
    }
    const failedCount = results.filter((item: any) => item.success === false).length;
    if (qualifiedCandidates.length > 0 && failedCount === qualifiedCandidates.length) {
      throw new Error(`入场触发预检全部失败：${failedCount}/${qualifiedCandidates.length} 个标的接口失败`);
    }
    const readyCount = results.filter((item: any) => item.passed).length;
    const blockedCount = results.filter((item: any) => item.success !== false && !item.passed).length;
    return {
      message: `入场触发预检完成：准备入场 ${readyCount} 个，继续观察 ${blockedCount} 个，失败 ${failedCount} 个`,
      data: {
        results,
        ready_count: readyCount,
        blocked_count: blockedCount,
        failed_count: failedCount,
        downgraded_count: results.filter((item: any) => item.downgraded).length,
        observation_ids: readyObservationIds
      }
    };
  })) return buildResult();

  if (!await runStep('entry_trigger_scan', async () => {
    const scan = await callLocalApi('/api/finance/assets/entry-trigger-observations/secondary-scan', {
      source: merged.source,
      limit: Math.max(Math.min(Number(merged.secondary_scan_limit || 120), 200), 1)
    });
    const data = scan.data || {};
    const summary = data.summary || {
      checked: Number(data.checked_count || 0),
      upgraded: Number(data.upgraded_count || 0),
      waiting: Number(data.waiting_count || 0),
      invalidated: Number(data.invalidated_count || 0),
      failed: Number(data.failed_count || 0)
    };
    return {
      message: `${scan.message || '入场触发确认完成'}；本轮新入场观察 ${readyObservationIds.length} 条，旧观察已纳入二次扫描`,
      data: {
        ...data,
        summary,
        seeded_observation_ids: readyObservationIds
      }
    };
  })) return buildResult();

  await runStep('entry_observation_settlement', () => runEntryObservationAutoSettlement(merged.source));

  return buildResult();
}
