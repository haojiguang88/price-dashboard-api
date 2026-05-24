import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import getDb, { getDatabasePath } from '../config/database';
import { getLatestCoveredTradeDate } from '../utils/financeTradeDate';

const router = Router();
const trainingRoot = process.env.MODEL_TRAINING_ROOT || '/Volumes/7100/model-training';
const trainingPython = process.env.MODEL_TRAINING_PYTHON || path.join(trainingRoot, 'venv', 'bin', 'python');

type ExperimentKey =
  | 'elasticity-hardness'
  | 'crash-recovery'
  | 'signal-lifecycle'
  | 'double-stock'
  | 'capital-rotation';

type DailyPrice = {
  trade_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  amount: number | null;
  volume: number | null;
};

type BaseRow = {
  symbol: string;
  name: string | null;
  asset_type: string;
  source: string;
  universe_type: string | null;
  trade_date: string;
  close: number;
  ma20: number | null;
  ma60: number | null;
  bias60: number | null;
  ret5: number | null;
  ret20: number | null;
  range20: number | null;
  cross60_10: number | null;
  trend_phase_code: string;
  trend_phase_reason: string;
};

type SimulatedSample = {
  symbol: string;
  name: string;
  asset_type: string;
  source: string;
  trade_date: string;
  close: number;
  market_regime: string;
  experiment_score: number;
  feature_label: string;
  result_label: string;
  forward_return_5d: number | null;
  forward_return_10d: number | null;
  forward_return_20d: number | null;
  forward_return_window: number | null;
  max_forward_return: number | null;
  max_drawdown: number | null;
  feature_snapshot: Record<string, any>;
  no_lookahead_note: string;
};

type PredictionSnapshotRow = {
  id: number;
  experiment_key: ExperimentKey;
  symbol: string;
  name: string | null;
  asset_type: string;
  source: string;
  universe_type: string | null;
  trade_date: string;
  close: number | null;
  market_regime?: string | null;
};

type TimedCacheEntry<T> = {
  expiresAt: number;
  data: T;
};

const BACKTEST_CACHE_MS = 10 * 60 * 1000;
const HEAVY_REPORT_CACHE_MS = 5 * 60 * 1000;
const EXPERIMENT_TRAINING_RUNNING_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const backtestCache = new Map<string, TimedCacheEntry<any>>();
const predictionPoolCache = new Map<string, TimedCacheEntry<any>>();
const predictionReplayCache = new Map<string, TimedCacheEntry<any>>();
const directionBoardCache = new Map<string, TimedCacheEntry<any>>();
const acceptanceReportCache = new Map<string, TimedCacheEntry<any>>();
let latestPriceDateCache: TimedCacheEntry<string> | null = null;
let experimentIndexesReady = false;
let experimentIndexesPromise: Promise<void> | null = null;

const getCached = <T>(cache: Map<string, TimedCacheEntry<T>>, key: string) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.data;
};

const setCached = <T>(cache: Map<string, TimedCacheEntry<T>>, key: string, data: T, ttl: number) => {
  cache.set(key, {
    expiresAt: Date.now() + ttl,
    data
  });
};

const invalidatePredictionSnapshotCache = (key: ExperimentKey, assetType?: string) => {
  const prefix = `snapshot|${key}|`;
  const assetSuffix = `|${assetType || ''}`;
  for (const cacheKey of Array.from(predictionPoolCache.keys())) {
    if (!cacheKey.startsWith(prefix)) continue;
    if (assetType && !cacheKey.endsWith(assetSuffix)) continue;
    predictionPoolCache.delete(cacheKey);
  }
};

const isForceRefresh = (req: Request) => (
  String(req.query.force || req.query.refresh || '') === '1'
);

const normalizeSnapshotSavedFrom = (value: any, fallback = 'latest_prediction_pool') => {
  const normalized = String(value || '').trim();
  if (!normalized) return fallback;
  if (normalized === 'all') return '';
  return normalized;
};

const experimentMeta: Record<ExperimentKey, {
  title: string;
  assetTypes: string[];
  forwardWindow: number;
  sampleLimit: number;
  positiveThreshold: number;
}> = {
  'elasticity-hardness': {
    title: '弹性/硬度模型',
    assetTypes: ['stock', 'etf'],
    forwardWindow: 20,
    sampleLimit: 160,
    positiveThreshold: 0.08
  },
  'crash-recovery': {
    title: '暴跌修复模型',
    assetTypes: ['stock', 'etf'],
    forwardWindow: 20,
    sampleLimit: 160,
    positiveThreshold: 0.06
  },
  'signal-lifecycle': {
    title: '信号生命周期反扇脸模型',
    assetTypes: ['stock', 'etf'],
    forwardWindow: 20,
    sampleLimit: 160,
    positiveThreshold: 0.05
  },
  'double-stock': {
    title: '翻倍股模型',
    assetTypes: ['stock'],
    forwardWindow: 120,
    sampleLimit: 120,
    positiveThreshold: 0.35
  },
  'capital-rotation': {
    title: '资金轮动模型',
    assetTypes: ['etf'],
    forwardWindow: 20,
    sampleLimit: 160,
    positiveThreshold: 0.06
  }
};

const experimentKeys = Object.keys(experimentMeta) as ExperimentKey[];
const experimentDomain = (key: ExperimentKey) => `experiment:${key}`;

const experimentTrainingDomains = (key: ExperimentKey | 'all') => (
  key === 'all'
    ? experimentKeys.map(item => experimentDomain(item))
    : [experimentDomain(key)]
);

async function expireStaleExperimentTrainingRuns(db: any, key: ExperimentKey | 'all') {
  const domains = experimentTrainingDomains(key);
  if (!domains.length) return;
  const placeholders = domains.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT id, started_at
     FROM model_training_runs
     WHERE status = 'running'
       AND domain IN (${placeholders})`,
    domains
  );
  const nowMs = Date.now();
  const staleRows = rows.filter((row: any) => {
    const startedAt = new Date(row.started_at).getTime();
    return Number.isFinite(startedAt) && nowMs - startedAt > EXPERIMENT_TRAINING_RUNNING_TIMEOUT_MS;
  });
  if (!staleRows.length) return;

  const finishedAt = new Date().toISOString();
  for (const row of staleRows) {
    await db.run(
      `UPDATE model_training_runs
       SET status = 'failed',
           message = ?,
           finished_at = ?,
           updated_at = ?
       WHERE id = ? AND status = 'running'`,
      [
        `实验模型训练超过 ${Math.round(EXPERIMENT_TRAINING_RUNNING_TIMEOUT_MS / 3600000)} 小时仍未结束，自动标记失败，避免重复任务长期卡住。`,
        finishedAt,
        finishedAt,
        row.id
      ]
    );
  }
}

async function getRunningExperimentTrainingRun(db: any, key: ExperimentKey | 'all') {
  await expireStaleExperimentTrainingRuns(db, key);
  const domains = experimentTrainingDomains(key);
  if (!domains.length) return null;
  const placeholders = domains.map(() => '?').join(',');
  return db.get(
    `SELECT id, domain, status, message, output_dir, source_row_count, started_at
     FROM model_training_runs
     WHERE status = 'running'
       AND domain IN (${placeholders})
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
    domains
  );
}

type RiskCrashRegime = 'RISK' | 'CRASH';

type RiskCrashBackfillCandidate = {
  trade_date: string;
  year: string;
  market_regime: RiskCrashRegime;
  raw_regime: string;
  candidate_source: 'financial_market_regime' | 'derived_hs300_daily';
  row_count: number;
};

type RiskCrashBackfillJob = {
  id: string;
  status: 'running' | 'completed' | 'failed';
  target_profile?: string;
  started_at: string;
  finished_at: string | null;
  message: string;
  candidate_count: number;
  selected_dates: RiskCrashBackfillCandidate[];
  experiment_keys: ExperimentKey[];
  progress: {
    total_tasks: number;
    completed_tasks: number;
    current: string | null;
  };
  result: {
    saved_count: number;
    inserted_count: number;
    updated_count: number;
    refreshed_count: number;
    completed_count: number;
    partial_count: number;
    pending_count: number;
    target_saved_count?: number;
    target_skipped_count?: number;
    errors: string[];
  };
};

let riskCrashBackfillJob: RiskCrashBackfillJob | null = null;

const round = (value: number | null | undefined, digits = 4) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const percent = (value: number | null | undefined) => {
  const rounded = round(value, 4);
  return rounded === null ? null : round(rounded * 100, 2);
};

const max = (values: number[]) => values.length > 0 ? Math.max(...values) : null;
const min = (values: number[]) => values.length > 0 ? Math.min(...values) : null;

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const getReturnAt = (baseClose: number, future: DailyPrice[], offset: number) => {
  const item = future[offset - 1];
  if (!item || !baseClose) return null;
  return item.close / baseClose - 1;
};

const getMaxForwardReturn = (baseClose: number, future: DailyPrice[]) => {
  if (!baseClose || future.length === 0) return null;
  return max(future.map(item => item.close / baseClose - 1));
};

const getMaxForwardDrawdown = (baseClose: number, future: DailyPrice[]) => {
  if (!baseClose || future.length === 0) return null;
  let peak = baseClose;
  let worst = 0;
  future.forEach(item => {
    peak = Math.max(peak, item.close);
    worst = Math.min(worst, item.close / peak - 1);
  });
  return worst;
};

const latestPast = (past: DailyPrice[], offset: number) => {
  const index = past.length - offset;
  return index >= 0 ? past[index] : null;
};

const returnFromPast = (currentClose: number, past: DailyPrice[], days: number) => {
  const item = latestPast(past, days + 1);
  if (!item?.close || !currentClose) return null;
  return currentClose / item.close - 1;
};

const rangeFromPast = (past: DailyPrice[], days: number) => {
  const slice = past.slice(-days);
  if (slice.length === 0) return null;
  const high = max(slice.map(item => item.high || item.close).filter(Number.isFinite));
  const low = min(slice.map(item => item.low || item.close).filter(Number.isFinite));
  if (!high || !low) return null;
  return high / low - 1;
};

const averageAmount = (past: DailyPrice[], days: number) => {
  const values = past.slice(-days).map(item => item.amount || 0).filter(value => value > 0);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const fieldRatioFromPast = (past: DailyPrice[], shortDays: number, longDays: number, field: 'amount' | 'volume') => {
  const shortValues = past.slice(-shortDays).map(item => item[field] || 0).filter(value => value > 0);
  const longValues = past.slice(-longDays).map(item => item[field] || 0).filter(value => value > 0);
  if (shortValues.length === 0 || longValues.length === 0) return null;
  const shortAverage = shortValues.reduce((sum, value) => sum + value, 0) / shortValues.length;
  const longAverage = longValues.reduce((sum, value) => sum + value, 0) / longValues.length;
  return longAverage === 0 ? null : shortAverage / longAverage;
};

const pricePositionFromPast = (past: DailyPrice[], days: number) => {
  const slice = past.slice(-days);
  if (slice.length < Math.min(days, 20)) return null;
  const current = slice[slice.length - 1]?.close;
  const high = max(slice.map(item => item.high || item.close).filter(Number.isFinite));
  const low = min(slice.map(item => item.low || item.close).filter(Number.isFinite));
  if (!current || high === null || low === null || high === low) return null;
  return (current - low) / (high - low);
};

const distanceToAverageFromPast = (past: DailyPrice[], days: number) => {
  if (past.length < days) return null;
  const current = past[past.length - 1]?.close;
  const average = averageClose(past, days);
  if (!current || !average) return null;
  return current / average - 1;
};

const subtractNullable = (
  left: number | null | undefined,
  right: number | null | undefined
) => {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  return left - right;
};

const calendarDayDiff = (left: string | null | undefined, right: string | null | undefined) => {
  if (!left || !right) return null;
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return null;
  return Math.max(0, Math.round((leftTime - rightTime) / 86400000));
};

const classifyMarket = (value: string | null | undefined) => {
  const normalized = String(value || '').toUpperCase();
  if (normalized.includes('CRASH')) return 'CRASH';
  if (normalized.includes('RISK')) return 'RISK';
  if (normalized.includes('NORMAL') || normalized.includes('SAFE') || normalized.includes('BULL')) return 'NORMAL';
  return normalized || 'UNKNOWN';
};

const averageClose = (prices: DailyPrice[], days: number, end = prices.length) => {
  if (end < days) return null;
  const slice = prices.slice(end - days, end);
  if (slice.length < days) return null;
  return slice.reduce((sum, item) => sum + item.close, 0) / days;
};

const percentChangeRaw = (current: number | null | undefined, previous: number | null | undefined) => {
  if (current === null || current === undefined || previous === null || previous === undefined || previous === 0) return null;
  return current / previous - 1;
};

const calculateHistoricalMarketRegime = (prices: DailyPrice[]) => {
  if (prices.length < 120) return 'UNKNOWN';
  const latest = prices[prices.length - 1];
  const close = latest.close;
  const ma60 = averageClose(prices, 60);
  const ma60Prev = averageClose(prices, 60, prices.length - 1);
  if (!ma60 || !ma60Prev) return 'UNKNOWN';

  const low60 = min(prices.slice(-60).map(item => item.close).filter(Number.isFinite));
  const low120 = min(prices.slice(-120).map(item => item.close).filter(Number.isFinite));
  const drawdown20 = prices.length >= 21 ? percentChangeRaw(close, prices[prices.length - 21].close) : null;
  const drawdown60 = prices.length >= 61 ? percentChangeRaw(close, prices[prices.length - 61].close) : null;
  const drawdown120 = prices.length >= 121 ? percentChangeRaw(close, prices[prices.length - 121].close) : null;
  const distanceToMa60 = close / ma60 - 1;

  let aboveMa60Days = 0;
  let belowMa60Days = 0;
  let crossCount10 = 0;
  let previousSide: 'above' | 'below' | null = null;

  for (let index = prices.length - 1; index >= 0; index--) {
    const ma = averageClose(prices, 60, index + 1);
    if (!ma) break;
    if (prices[index].close > ma) {
      if (belowMa60Days === 0) aboveMa60Days++;
    } else {
      break;
    }
  }

  for (let index = prices.length - 1; index >= 0; index--) {
    const ma = averageClose(prices, 60, index + 1);
    if (!ma) break;
    if (prices[index].close < ma) {
      if (aboveMa60Days === 0) belowMa60Days++;
    } else {
      break;
    }
  }

  prices.slice(-10).forEach((item, offset) => {
    const globalIndex = prices.length - 10 + offset;
    const ma = averageClose(prices, 60, globalIndex + 1);
    if (!ma) return;
    const side = item.close > ma ? 'above' : item.close < ma ? 'below' : previousSide;
    if (!side) return;
    if (previousSide && previousSide !== side) crossCount10++;
    previousSide = side;
  });

  if ((drawdown60 !== null && drawdown60 <= -0.20) ||
      (drawdown120 !== null && drawdown120 <= -0.25) ||
      distanceToMa60 <= -0.10) {
    return 'CRASH';
  }
  if ((close < ma60 && ma60 < ma60Prev && drawdown20 !== null && drawdown20 <= -0.10) ||
      (low120 !== null && close < low120) ||
      (drawdown60 !== null && drawdown60 <= -0.15)) {
    return 'CRASH';
  }
  if ((close < ma60 && ma60 < ma60Prev) ||
      (low60 !== null && close < low60) ||
      (drawdown20 !== null && drawdown20 <= -0.08) ||
      belowMa60Days >= 3) {
    return 'CRASH';
  }
  if (crossCount10 >= 2 ||
      (close < ma60 && ma60 >= ma60Prev) ||
      (drawdown20 !== null && drawdown20 <= -0.05 && drawdown20 > -0.08)) {
    return 'RISK';
  }
  if (close > ma60 && ma60 >= ma60Prev && aboveMa60Days >= 5 && crossCount10 < 2 &&
      (drawdown120 === null || drawdown120 > -0.08)) {
    return 'NORMAL';
  }
  if (close > ma60 && ma60 >= ma60Prev && crossCount10 < 2 &&
      (drawdown20 === null || drawdown20 > -0.08) &&
      (drawdown60 === null || drawdown60 > -0.15) &&
      (drawdown120 === null || drawdown120 > -0.08)) {
    return 'NORMAL';
  }
  return 'RISK';
};

const getExperimentScore = (key: ExperimentKey, row: BaseRow, past: DailyPrice[], marketRegime: string) => {
  const currentClose = row.close;
  const ret5 = row.ret5 ?? returnFromPast(currentClose, past, 5) ?? 0;
  const ret20 = row.ret20 ?? returnFromPast(currentClose, past, 20) ?? 0;
  const range20 = row.range20 ?? rangeFromPast(past, 20) ?? 0;
  const range60 = rangeFromPast(past, 60) ?? range20;
  const avgAmount20 = averageAmount(past, 20) ?? 0;
  const bias60 = row.bias60 ?? (row.ma60 ? currentClose / row.ma60 - 1 : 0);
  const trendGood = ['BREAKOUT', 'SLOW_GRIND_UP', 'TREND_UP', 'RECOVERY', 'TREND_TRANSITION'].includes(row.trend_phase_code);
  const marketPenalty = marketRegime === 'CRASH' ? 18 : marketRegime === 'RISK' ? 8 : 0;

  switch (key) {
    case 'elasticity-hardness':
      return Math.round(Math.max(0, Math.min(100, 52 + range20 * 180 + Math.max(ret20, 0) * 55 - Math.max(-ret20, 0) * 50 - Math.max(-bias60, 0) * 45 - marketPenalty)));
    case 'crash-recovery':
      return Math.round(Math.max(0, Math.min(100, 55 + Math.max(-ret5, 0) * 220 + Math.max(-ret20, 0) * 90 + (bias60 > -0.08 ? 8 : -8) + (trendGood ? 8 : 0) - marketPenalty)));
    case 'signal-lifecycle':
      return Math.round(Math.max(0, Math.min(100, 50 + (trendGood ? 18 : -8) - Math.abs(bias60) * 55 - (row.cross60_10 || 0) * 2 + Math.max(ret20, 0) * 45 - marketPenalty)));
    case 'double-stock':
      return Math.round(Math.max(0, Math.min(100, 45 + Math.max(ret20, 0) * 120 + range60 * 60 + (trendGood ? 14 : -6) + (avgAmount20 > 0 ? 6 : 0) - marketPenalty)));
    case 'capital-rotation':
      return Math.round(Math.max(0, Math.min(100, 48 + Math.max(ret20, 0) * 130 + Math.max(ret5, 0) * 80 + (trendGood ? 16 : -8) - marketPenalty)));
    default:
      return 50;
  }
};

const getFeatureLabel = (key: ExperimentKey, row: BaseRow, past: DailyPrice[], score: number) => {
  const ret5 = row.ret5 ?? returnFromPast(row.close, past, 5) ?? 0;
  const ret20 = row.ret20 ?? returnFromPast(row.close, past, 20) ?? 0;
  const range20 = row.range20 ?? rangeFromPast(past, 20) ?? 0;

  if (key === 'crash-recovery') {
    if (ret5 <= -0.08) return '急跌修复样本';
    if (ret20 <= -0.15) return '深回撤修复样本';
    return '普通回撤样本';
  }
  if (key === 'signal-lifecycle') {
    if ((row.cross60_10 || 0) >= 3) return '扇脸高风险';
    if (score >= 70) return '信号较稳定';
    return '复核观察';
  }
  if (key === 'double-stock') {
    if (score >= 75) return '高弹性趋势胚子';
    return '普通潜力样本';
  }
  if (key === 'capital-rotation') {
    if (ret5 > 0.03 && ret20 > 0.08) return '轮动加速';
    if (ret20 > 0.03) return '轮动抬头';
    return '轮动观察';
  }
  if (range20 >= 0.18) return '高弹性';
  if (score >= 70) return '弹性硬度均衡';
  return '普通波动';
};

const getResultLabel = (key: ExperimentKey, maxForwardReturn: number | null, maxDrawdown: number | null, forwardWindow: number) => {
  const maxReturn = maxForwardReturn ?? 0;
  const drawdown = maxDrawdown ?? 0;
  if (key === 'double-stock') {
    if (maxReturn >= 1) return `窗口内翻倍`;
    if (maxReturn >= 0.35) return `${forwardWindow}日强趋势`;
    if (drawdown <= -0.2) return '高回撤失败';
    return '未走出';
  }
  if (key === 'crash-recovery') {
    if (maxReturn >= 0.08 && drawdown > -0.12) return '修复成功';
    if (drawdown <= -0.15) return '二次下杀';
    return '修复不明';
  }
  if (key === 'signal-lifecycle') {
    if (maxReturn >= 0.06 && drawdown > -0.08) return '信号存活';
    if (drawdown <= -0.1) return '信号打脸';
    return '继续观察';
  }
  if (key === 'capital-rotation') {
    if (maxReturn >= 0.06) return '轮动有效';
    if (drawdown <= -0.08) return '轮动失败';
    return '轮动不明显';
  }
  if (maxReturn >= 0.08 && drawdown > -0.1) return '波段有效';
  if (drawdown <= -0.12) return '弹性伤人';
  return '弹性一般';
};

async function ensureExperimentIndexes(db: any) {
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_financial_daily_prices_symbol_date
      ON financial_daily_prices(symbol, asset_type, source, trade_date);
    CREATE INDEX IF NOT EXISTS idx_financial_daily_prices_scope_date
      ON financial_daily_prices(source, asset_type, trade_date DESC);
    CREATE INDEX IF NOT EXISTS idx_financial_trend_phase_date_type
      ON financial_trend_phase_results(trade_date, asset_type, source);
    CREATE INDEX IF NOT EXISTS idx_financial_market_regime_symbol_date
      ON financial_market_regime(symbol, trade_date);
  `);
}

async function ensureExperimentIndexesOnce(db: any) {
  if (experimentIndexesReady) return;
  if (!experimentIndexesPromise) {
    experimentIndexesPromise = ensureExperimentIndexes(db)
      .then(() => {
        experimentIndexesReady = true;
      })
      .finally(() => {
        experimentIndexesPromise = null;
      });
  }
  await experimentIndexesPromise;
}

async function getLatestPriceDate(db: any, force = false) {
  if (!force && latestPriceDateCache && latestPriceDateCache.expiresAt >= Date.now()) {
    return latestPriceDateCache.data;
  }
  const latestDate = String(await getLatestCoveredTradeDate(db) || '');
  latestPriceDateCache = {
    expiresAt: Date.now() + 60 * 1000,
    data: latestDate
  };
  return latestDate;
}

async function getMarketRegime(db: any, tradeDate: string, cache: Map<string, string>) {
  if (cache.has(tradeDate)) return cache.get(tradeDate) || 'UNKNOWN';
  const row = await db.get(
    `SELECT market_regime FROM financial_market_regime
     WHERE symbol = '000300' AND trade_date <= ?
     ORDER BY trade_date DESC, id DESC
     LIMIT 1`,
    [tradeDate]
  );
  let regime = classifyMarket(row?.market_regime);
  if (regime === 'UNKNOWN') {
    const marketPrices = await db.all(
      `WITH ranked_prices AS (
         SELECT trade_date, open, high, low, close, amount, volume,
           ROW_NUMBER() OVER (
             PARTITION BY trade_date
             ORDER BY CASE source WHEN 'tushare' THEN 0 WHEN 'akshare' THEN 1 ELSE 2 END
           ) AS rn
         FROM financial_daily_prices
         WHERE symbol = '000300' AND trade_date <= ? AND close IS NOT NULL AND close > 0
       )
       SELECT trade_date, open, high, low, close, amount, volume
       FROM ranked_prices
       WHERE rn = 1
       ORDER BY trade_date DESC
       LIMIT 260`,
      [tradeDate]
    );
    const normalized = marketPrices.map((item: any) => ({
      trade_date: String(item.trade_date),
      open: item.open === null || item.open === undefined ? null : Number(item.open),
      high: item.high === null || item.high === undefined ? null : Number(item.high),
      low: item.low === null || item.low === undefined ? null : Number(item.low),
      close: Number(item.close),
      amount: item.amount === null || item.amount === undefined ? null : Number(item.amount),
      volume: item.volume === null || item.volume === undefined ? null : Number(item.volume)
    })).reverse();
    regime = calculateHistoricalMarketRegime(normalized);
  }
  cache.set(tradeDate, regime);
  return regime;
}

async function getMarketReturnSnapshot(db: any, tradeDate: string, cache: Map<string, any>) {
  if (cache.has(tradeDate)) return cache.get(tradeDate);
  const marketPrices = await db.all(
    `WITH ranked_prices AS (
       SELECT trade_date, open, high, low, close, amount, volume,
         ROW_NUMBER() OVER (
           PARTITION BY trade_date
           ORDER BY CASE source WHEN 'tushare' THEN 0 WHEN 'akshare' THEN 1 ELSE 2 END
         ) AS rn
       FROM financial_daily_prices
       WHERE symbol = '000300' AND trade_date <= ? AND close IS NOT NULL AND close > 0
     )
     SELECT trade_date, open, high, low, close, amount, volume
     FROM ranked_prices
     WHERE rn = 1
     ORDER BY trade_date DESC
     LIMIT 260`,
    [tradeDate]
  );
  const normalized = marketPrices.map((item: any) => ({
    trade_date: String(item.trade_date),
    open: item.open === null || item.open === undefined ? null : Number(item.open),
    high: item.high === null || item.high === undefined ? null : Number(item.high),
    low: item.low === null || item.low === undefined ? null : Number(item.low),
    close: Number(item.close),
    amount: item.amount === null || item.amount === undefined ? null : Number(item.amount),
    volume: item.volume === null || item.volume === undefined ? null : Number(item.volume)
  })).reverse();
  const currentClose = normalized[normalized.length - 1]?.close || 0;
  const marketTradeDate = normalized[normalized.length - 1]?.trade_date || null;
  const breadth = await db.get(
    `SELECT trade_date, up_ratio, down_ratio, limit_up_ratio, limit_down_ratio,
       above_ma20_ratio, above_ma60_ratio, above_ma120_ratio, amount_ratio_5_20
     FROM financial_market_breadth_daily
     WHERE trade_date <= ?
     ORDER BY trade_date DESC, id DESC
     LIMIT 1`,
    [tradeDate]
  );
  const snapshot = {
    ret5: returnFromPast(currentClose, normalized, 5),
    ret20: returnFromPast(currentClose, normalized, 20),
    ret60: returnFromPast(currentClose, normalized, 60),
    ret120: returnFromPast(currentClose, normalized, 120),
    market_trade_date: marketTradeDate,
    breadth_trade_date: breadth?.trade_date || null,
    breadth_lag_days: calendarDayDiff(tradeDate, breadth?.trade_date || null),
    breadth_up_ratio: breadth?.up_ratio === null || breadth?.up_ratio === undefined ? null : Number(breadth.up_ratio),
    breadth_down_ratio: breadth?.down_ratio === null || breadth?.down_ratio === undefined ? null : Number(breadth.down_ratio),
    breadth_above_ma60_ratio: breadth?.above_ma60_ratio === null || breadth?.above_ma60_ratio === undefined ? null : Number(breadth.above_ma60_ratio),
    breadth_amount_ratio_5_20: breadth?.amount_ratio_5_20 === null || breadth?.amount_ratio_5_20 === undefined ? null : Number(breadth.amount_ratio_5_20)
  };
  cache.set(tradeDate, snapshot);
  return snapshot;
}

async function getIndustrySnapshot(db: any, row: BaseRow, tradeDate: string, marketReturns: any, cache: Map<string, any>) {
  const cacheKey = `${row.symbol}|${row.asset_type}|${row.source}|${tradeDate}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const empty = {
    known: false,
    code: null,
    name: null,
    ret5: null,
    ret20: null,
    ret60: null,
    amount_ratio_5_20: null,
    relative_ret20_hs300: null,
    trade_date: null,
    lag_days: null
  };
  if (row.asset_type !== 'stock') {
    cache.set(cacheKey, empty);
    return empty;
  }
  try {
    const member = await db.get(
      `SELECT l1_code, l1_name, l2_code, l2_name, l3_code, l3_name
       FROM financial_sw_industry_members
       WHERE symbol = ?
         AND (COALESCE(is_new, 'Y') = 'Y' OR out_date IS NULL OR out_date = '' OR out_date >= ?)
       ORDER BY CASE COALESCE(is_new, 'Y') WHEN 'Y' THEN 0 ELSE 1 END, id DESC
       LIMIT 1`,
      [row.symbol, tradeDate]
    );
    const code = member?.l2_code || member?.l1_code;
    if (!code) {
      cache.set(cacheKey, empty);
      return empty;
    }
    const rows = await db.all(
      `SELECT trade_date, close, amount
       FROM financial_sw_industry_daily
       WHERE index_code = ? AND trade_date <= ? AND close IS NOT NULL AND close > 0
       ORDER BY trade_date DESC
       LIMIT 80`,
      [code, tradeDate]
    );
    const prices = rows.map((item: any) => ({
      trade_date: String(item.trade_date),
      open: null,
      high: null,
      low: null,
      close: Number(item.close),
      amount: item.amount === null || item.amount === undefined ? null : Number(item.amount),
      volume: null
    })).reverse();
    const currentClose = prices[prices.length - 1]?.close || null;
    const ret5 = currentClose ? returnFromPast(currentClose, prices, 5) : null;
    const ret20 = currentClose ? returnFromPast(currentClose, prices, 20) : null;
    const ret60 = currentClose ? returnFromPast(currentClose, prices, 60) : null;
    const snapshot = {
      known: true,
      code,
      name: member?.l2_name || member?.l1_name || null,
      trade_date: prices[prices.length - 1]?.trade_date || null,
      lag_days: calendarDayDiff(tradeDate, prices[prices.length - 1]?.trade_date || null),
      ret5,
      ret20,
      ret60,
      amount_ratio_5_20: fieldRatioFromPast(prices, 5, 20, 'amount'),
      relative_ret20_hs300: subtractNullable(ret20, marketReturns.ret20)
    };
    cache.set(cacheKey, snapshot);
    return snapshot;
  } catch {
    cache.set(cacheKey, empty);
    return empty;
  }
}

async function getDailyWindow(db: any, row: BaseRow, tradeDate: string, direction: 'past' | 'future', limit: number) {
  const comparator = direction === 'past' ? '<=' : '>';
  const order = direction === 'past' ? 'DESC' : 'ASC';
  const prices = await db.all(
    `SELECT trade_date, open, high, low, close, amount, volume
     FROM financial_daily_prices
     WHERE symbol = ? AND asset_type = ? AND source = ? AND trade_date ${comparator} ? AND close IS NOT NULL AND close > 0
     ORDER BY trade_date ${order}
     LIMIT ?`,
    [row.symbol, row.asset_type, row.source, tradeDate, limit]
  );
  const normalized = prices.map((item: any) => ({
    trade_date: String(item.trade_date),
    open: item.open === null || item.open === undefined ? null : Number(item.open),
    high: item.high === null || item.high === undefined ? null : Number(item.high),
    low: item.low === null || item.low === undefined ? null : Number(item.low),
    close: Number(item.close),
    amount: item.amount === null || item.amount === undefined ? null : Number(item.amount),
    volume: item.volume === null || item.volume === undefined ? null : Number(item.volume)
  }));
  return direction === 'past' ? normalized.reverse() : normalized;
}

function buildFeatureSnapshot(
  row: BaseRow,
  past: DailyPrice[],
  marketRegime: string,
  marketReturns: any,
  industry: any,
  tradeDate: string
) {
  const ret5 = row.ret5 ?? returnFromPast(row.close, past, 5);
  const ret20 = row.ret20 ?? returnFromPast(row.close, past, 20);
  const ret60 = returnFromPast(row.close, past, 60);
  const ret120 = returnFromPast(row.close, past, 120);
  const ret250 = returnFromPast(row.close, past, 250);
  const amountRatio520 = fieldRatioFromPast(past, 5, 20, 'amount');
  const amountRatio2060 = fieldRatioFromPast(past, 20, 60, 'amount');
  const sectorKnown = Boolean(industry?.known) || (row.asset_type === 'etf' && row.universe_type === 'industry_etf');
  const sectorRet5 = industry?.known ? industry.ret5 : sectorKnown ? ret5 : null;
  const sectorRet20 = industry?.known ? industry.ret20 : sectorKnown ? ret20 : null;
  const sectorRet60 = industry?.known ? industry.ret60 : sectorKnown ? ret60 : null;
  const sectorAmountRatio = industry?.known ? industry.amount_ratio_5_20 : sectorKnown ? amountRatio520 : null;

  return {
    trend_phase_code: row.trend_phase_code,
    trend_phase_reason: row.trend_phase_reason,
    universe_type: row.universe_type || null,
    market_regime: marketRegime,
    market_feature_trade_date: marketReturns.market_trade_date || null,
    breadth_feature_trade_date: marketReturns.breadth_trade_date || null,
    breadth_lag_days: marketReturns.breadth_lag_days ?? null,
    market_ret20: percent(marketReturns.ret20),
    breadth_up_ratio: percent(marketReturns.breadth_up_ratio),
    breadth_down_ratio: percent(marketReturns.breadth_down_ratio),
    breadth_above_ma60_ratio: percent(marketReturns.breadth_above_ma60_ratio),
    ret5: percent(ret5),
    ret20: percent(ret20),
    ret60: percent(ret60),
    ret120: percent(ret120),
    ret250: percent(ret250),
    range20: percent(row.range20 ?? rangeFromPast(past, 20)),
    range60: percent(rangeFromPast(past, 60)),
    range120: percent(rangeFromPast(past, 120)),
    bias60: percent(row.bias60 ?? (row.ma60 ? row.close / row.ma60 - 1 : null)),
    distance_ma120: percent(distanceToAverageFromPast(past, 120)),
    distance_ma250: percent(distanceToAverageFromPast(past, 250)),
    price_pos120: percent(pricePositionFromPast(past, 120)),
    price_pos250: percent(pricePositionFromPast(past, 250)),
    cross60_10: row.cross60_10 || 0,
    avg_amount_20: round(averageAmount(past, 20), 2),
    amount_ratio_5_20: round(amountRatio520, 2),
    amount_ratio_20_60: round(amountRatio2060, 2),
    amount_available: averageAmount(past, 20) ? 1 : 0,
    industry_known: Boolean(industry?.known),
    industry_code: industry?.code || null,
    industry_name: industry?.name || null,
    industry_feature_trade_date: industry?.trade_date || null,
    industry_lag_days: industry?.lag_days ?? calendarDayDiff(tradeDate, industry?.trade_date || null),
    industry_ret20: percent(industry?.ret20),
    industry_amount_ratio_5_20: round(industry?.amount_ratio_5_20, 2),
    industry_relative_ret20_hs300: percent(industry?.relative_ret20_hs300),
    sector_known: sectorKnown,
    sector_ret5: percent(sectorRet5),
    sector_ret20: percent(sectorRet20),
    sector_ret60: percent(sectorRet60),
    sector_amount_ratio_5_20: round(sectorAmountRatio, 2),
    sector_relative_ret20_hs300: percent(subtractNullable(sectorRet20, marketReturns.ret20)),
    asset_vs_sector_ret20: percent(subtractNullable(ret20, sectorRet20)),
    relative_ret20_hs300: percent(subtractNullable(ret20, marketReturns.ret20)),
    relative_ret60_hs300: percent(subtractNullable(ret60, marketReturns.ret60)),
    relative_ret120_hs300: percent(subtractNullable(ret120, marketReturns.ret120))
  };
}

async function buildBacktest(db: any, key: ExperimentKey, req: Request, latestDateOverride?: string) {
  const meta = experimentMeta[key];
  const limit = Math.min(Math.max(Number(req.query.limit || meta.sampleLimit), 20), 300);
  const assetTypeQuery = String(req.query.asset_type || req.query.assetType || '').trim();
  const assetTypes = assetTypeQuery && meta.assetTypes.includes(assetTypeQuery)
    ? [assetTypeQuery]
    : meta.assetTypes;
  const forwardWindow = Math.min(Math.max(Number(req.query.forward_window || meta.forwardWindow), 5), key === 'double-stock' ? 180 : 60);
  const minFutureRows = Math.min(forwardWindow, 20);
  const calendarHoldoutDays = forwardWindow * 2 + 10;
  const latestDate = latestDateOverride || await getLatestPriceDate(db);

  const placeholders = assetTypes.map(() => '?').join(',');
  const rows: BaseRow[] = await db.all(
    `WITH universe_unique AS (
       SELECT symbol, asset_type, source, MAX(name) AS name,
         CASE
           WHEN SUM(CASE WHEN universe_type = 'industry_etf' THEN 1 ELSE 0 END) > 0 THEN 'industry_etf'
           WHEN SUM(CASE WHEN universe_type = 'broad_etf' THEN 1 ELSE 0 END) > 0 THEN 'broad_etf'
           WHEN SUM(CASE WHEN universe_type = 'commodity_etf' THEN 1 ELSE 0 END) > 0 THEN 'commodity_etf'
           WHEN SUM(CASE WHEN universe_type = 'cross_border_etf' THEN 1 ELSE 0 END) > 0 THEN 'cross_border_etf'
           WHEN SUM(CASE WHEN universe_type = 'bond_cash_etf' THEN 1 ELSE 0 END) > 0 THEN 'bond_cash_etf'
           WHEN SUM(CASE WHEN universe_type = 'special_fund' THEN 1 ELSE 0 END) > 0 THEN 'special_fund'
           WHEN SUM(CASE WHEN universe_type = 'hs300_component' THEN 1 ELSE 0 END) > 0 THEN 'hs300_component'
           ELSE MIN(universe_type)
         END AS universe_type
       FROM financial_asset_universe
       GROUP BY symbol, asset_type, source
     ),
     trend_latest AS (
       SELECT t.*,
         ROW_NUMBER() OVER (
           PARTITION BY t.symbol, t.asset_type, t.source, t.trade_date
           ORDER BY t.rule_version DESC, t.id DESC
         ) AS rn
       FROM financial_trend_phase_results t
       WHERE t.asset_type IN (${placeholders})
         AND t.close IS NOT NULL AND t.close > 0
         AND t.trade_date <= date(?, '-' || ? || ' days')
     )
     SELECT t.symbol, COALESCE(u.name, t.symbol) AS name, t.asset_type, t.source,
       u.universe_type, t.trade_date, t.close, t.ma20, t.ma60, t.bias60, t.ret5,
       t.ret20, t.range20, t.cross60_10, t.trend_phase_code, t.trend_phase_reason
     FROM trend_latest t
     LEFT JOIN universe_unique u
       ON u.symbol = t.symbol AND u.asset_type = t.asset_type AND u.source = t.source
     WHERE t.rn = 1
     ORDER BY t.trade_date DESC, ABS(COALESCE(t.ret20, 0)) DESC, t.symbol ASC
     LIMIT ?`,
    [...assetTypes, latestDate, calendarHoldoutDays, limit * 10]
  );

  const marketCache = new Map<string, string>();
  const marketReturnCache = new Map<string, any>();
  const industryCache = new Map<string, any>();
  const samples: SimulatedSample[] = [];
  const seenSampleKeys = new Set<string>();

  for (const row of rows) {
    if (samples.length >= limit) break;
    const sampleKey = `${row.symbol}|${row.asset_type}|${row.source}|${row.trade_date}`;
    if (seenSampleKeys.has(sampleKey)) continue;
    seenSampleKeys.add(sampleKey);
    if (key === 'crash-recovery' && !((row.ret5 ?? 0) <= -0.04 || (row.ret20 ?? 0) <= -0.08 || (row.range20 ?? 0) >= 0.12)) {
      continue;
    }
    if (key === 'capital-rotation' && row.asset_type !== 'etf') {
      continue;
    }

    const [past, future, marketRegime, marketReturns] = await Promise.all([
      getDailyWindow(db, row, row.trade_date, 'past', 260),
      getDailyWindow(db, row, row.trade_date, 'future', forwardWindow),
      getMarketRegime(db, row.trade_date, marketCache),
      getMarketReturnSnapshot(db, row.trade_date, marketReturnCache)
    ]);

    if (past.length < 20 || future.length < minFutureRows) continue;

    const industry = await getIndustrySnapshot(db, row, row.trade_date, marketReturns, industryCache);
    const score = getExperimentScore(key, row, past, marketRegime);
    const ret5 = getReturnAt(row.close, future, 5);
    const ret10 = getReturnAt(row.close, future, 10);
    const ret20 = getReturnAt(row.close, future, 20);
    const retWindow = getReturnAt(row.close, future, Math.min(forwardWindow, future.length));
    const maxForwardReturn = getMaxForwardReturn(row.close, future);
    const maxDrawdown = getMaxForwardDrawdown(row.close, future);

    samples.push({
      symbol: row.symbol,
      name: row.name || row.symbol,
      asset_type: row.asset_type,
      source: row.source,
      trade_date: row.trade_date,
      close: round(row.close, 3) || 0,
      market_regime: marketRegime,
      experiment_score: score,
      feature_label: getFeatureLabel(key, row, past, score),
      result_label: getResultLabel(key, maxForwardReturn, maxDrawdown, forwardWindow),
      forward_return_5d: percent(ret5),
      forward_return_10d: percent(ret10),
      forward_return_20d: percent(ret20),
      forward_return_window: percent(retWindow),
      max_forward_return: percent(maxForwardReturn),
      max_drawdown: percent(maxDrawdown),
      feature_snapshot: buildFeatureSnapshot(row, past, marketRegime, marketReturns, industry, row.trade_date),
      no_lookahead_note: `特征只使用 ${row.trade_date} 及以前数据；未来 ${forwardWindow} 个交易日只作为结果标签。`
    });
  }

  const sortedSamples = samples.sort((a, b) => b.experiment_score - a.experiment_score);
  const positive = sortedSamples.filter(item => (item.max_forward_return ?? 0) >= meta.positiveThreshold * 100);
  const returns = sortedSamples.map(item => item.forward_return_window).filter((value): value is number => value !== null);
  const drawdowns = sortedSamples.map(item => item.max_drawdown).filter((value): value is number => value !== null);
  const topScoreSamples = sortedSamples.slice(0, Math.max(1, Math.floor(sortedSamples.length * 0.2)));
  const topReturns = topScoreSamples.map(item => item.forward_return_window).filter((value): value is number => value !== null);

  return {
    meta: {
      key,
      title: meta.title,
      asset_types: assetTypes,
      forward_window: forwardWindow,
      latest_price_date: latestDate,
      no_lookahead_rule: '样本排序和特征只使用截面日及以前数据；5/10/20/窗口收益只在结果区展示。'
    },
    summary: {
      sample_count: sortedSamples.length,
      positive_count: positive.length,
      positive_rate: sortedSamples.length > 0 ? round(positive.length / sortedSamples.length * 100, 2) : 0,
      median_window_return: round(median(returns), 2),
      median_max_drawdown: round(median(drawdowns), 2),
      top_score_median_window_return: round(median(topReturns), 2),
      best_window_return: round(max(returns), 2),
      worst_window_return: round(min(returns), 2)
    },
    samples: sortedSamples.slice(0, 60)
  };
}

async function buildPredictionPool(db: any, key: ExperimentKey, req: Request, latestDateOverride?: string) {
  const meta = experimentMeta[key];
  const limit = Math.min(Math.max(Number(req.query.limit || 40), 10), 120);
  const assetTypeQuery = String(req.query.asset_type || req.query.assetType || '').trim();
  const assetTypes = assetTypeQuery && meta.assetTypes.includes(assetTypeQuery)
    ? [assetTypeQuery]
    : meta.assetTypes;
  const latestDate = latestDateOverride || await getLatestPriceDate(db);
  const placeholders = assetTypes.map(() => '?').join(',');

  const rows: BaseRow[] = await db.all(
    `WITH universe_unique AS (
       SELECT symbol, asset_type, source, MAX(name) AS name,
         CASE
           WHEN SUM(CASE WHEN universe_type = 'industry_etf' THEN 1 ELSE 0 END) > 0 THEN 'industry_etf'
           WHEN SUM(CASE WHEN universe_type = 'broad_etf' THEN 1 ELSE 0 END) > 0 THEN 'broad_etf'
           WHEN SUM(CASE WHEN universe_type = 'commodity_etf' THEN 1 ELSE 0 END) > 0 THEN 'commodity_etf'
           WHEN SUM(CASE WHEN universe_type = 'cross_border_etf' THEN 1 ELSE 0 END) > 0 THEN 'cross_border_etf'
           WHEN SUM(CASE WHEN universe_type = 'bond_cash_etf' THEN 1 ELSE 0 END) > 0 THEN 'bond_cash_etf'
           WHEN SUM(CASE WHEN universe_type = 'special_fund' THEN 1 ELSE 0 END) > 0 THEN 'special_fund'
           WHEN SUM(CASE WHEN universe_type = 'hs300_component' THEN 1 ELSE 0 END) > 0 THEN 'hs300_component'
           ELSE MIN(universe_type)
         END AS universe_type
       FROM financial_asset_universe
       GROUP BY symbol, asset_type, source
     ),
     trend_ranked AS (
       SELECT t.*,
         ROW_NUMBER() OVER (
           PARTITION BY t.symbol, t.asset_type, t.source
           ORDER BY t.trade_date DESC, t.rule_version DESC, t.id DESC
         ) AS rn
       FROM financial_trend_phase_results t
       WHERE t.asset_type IN (${placeholders})
         AND t.close IS NOT NULL AND t.close > 0
         AND t.trade_date <= ?
         AND t.trade_date >= date(?, '-10 days')
     )
     SELECT t.symbol, COALESCE(u.name, t.symbol) AS name, t.asset_type, t.source,
       u.universe_type, t.trade_date, t.close, t.ma20, t.ma60, t.bias60, t.ret5,
       t.ret20, t.range20, t.cross60_10, t.trend_phase_code, t.trend_phase_reason
     FROM trend_ranked t
     LEFT JOIN universe_unique u
       ON u.symbol = t.symbol AND u.asset_type = t.asset_type AND u.source = t.source
     WHERE t.rn = 1
     ORDER BY t.trade_date DESC, ABS(COALESCE(t.ret20, 0)) DESC, t.symbol ASC
     LIMIT ?`,
    [...assetTypes, latestDate, latestDate, limit * 12]
  );

  const marketCache = new Map<string, string>();
  const marketReturnCache = new Map<string, any>();
  const industryCache = new Map<string, any>();
  const items: any[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (items.length >= limit) break;
    const sampleKey = `${row.symbol}|${row.asset_type}|${row.source}`;
    if (seen.has(sampleKey)) continue;
    seen.add(sampleKey);
    if (key === 'crash-recovery' && !((row.ret5 ?? 0) <= -0.04 || (row.ret20 ?? 0) <= -0.08 || (row.range20 ?? 0) >= 0.12)) {
      continue;
    }
    if (key === 'capital-rotation' && row.asset_type !== 'etf') {
      continue;
    }
    const [past, marketRegime, marketReturns] = await Promise.all([
      getDailyWindow(db, row, row.trade_date, 'past', 260),
      getMarketRegime(db, row.trade_date, marketCache),
      getMarketReturnSnapshot(db, row.trade_date, marketReturnCache)
    ]);
    if (past.length < 20) continue;
    const industry = await getIndustrySnapshot(db, row, row.trade_date, marketReturns, industryCache);
    const score = getExperimentScore(key, row, past, marketRegime);
    items.push({
      symbol: row.symbol,
      name: row.name || row.symbol,
      asset_type: row.asset_type,
      source: row.source,
      trade_date: row.trade_date,
      close: round(row.close, 3) || 0,
      market_regime: marketRegime,
      experiment_score: score,
      feature_label: getFeatureLabel(key, row, past, score),
      feature_snapshot: buildFeatureSnapshot(row, past, marketRegime, marketReturns, industry, row.trade_date),
      no_lookahead_note: `最新预测池只使用 ${row.trade_date} 及以前数据；没有读取未来收益。`
    });
  }

  const sortedItems = items.sort((a, b) => b.experiment_score - a.experiment_score);
  const marketSummary = sortedItems.reduce((acc: Record<string, number>, item) => {
    acc[item.market_regime] = (acc[item.market_regime] || 0) + 1;
    return acc;
  }, {});

  return {
    meta: {
      key,
      title: meta.title,
      asset_types: assetTypes,
      latest_price_date: latestDate,
      no_lookahead_rule: '最新预测池只取当前可见截面特征，不读取未来收益；正式动作仍要走市场总闸、安全区、结构和失效线。'
    },
    summary: {
      item_count: sortedItems.length,
      average_score: round(sortedItems.reduce((sum, item) => sum + item.experiment_score, 0) / Math.max(1, sortedItems.length), 2),
      market: marketSummary
    },
    items: sortedItems
  };
}

function readJsonFile(filePath: string | null | undefined) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function getExperimentModelSummary(db: any, key: ExperimentKey) {
  const domain = experimentDomain(key);
  const run = await db.get(
    `SELECT id, domain, status, output_dir, message, source_row_count, started_at, finished_at, updated_at
     FROM model_training_runs
     WHERE domain = ?
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
    [domain]
  );
  const artifacts = await db.all(
    `SELECT model_key, target, model_type, model_file, metrics_file, validation_auc, test_auc, updated_at
     FROM model_training_artifacts
     WHERE domain = ?
     ORDER BY CASE model_key
       WHEN 'lightgbm_model' THEN 1
       WHEN 'random_forest' THEN 2
       WHEN 'logistic_regression' THEN 3
       ELSE 9
     END`,
    [domain]
  );
  const importance = await db.all(
    `SELECT model_key, feature, importance, rank_order
     FROM model_training_feature_importance
     WHERE domain = ?
     ORDER BY model_key ASC, rank_order ASC
     LIMIT 18`,
    [domain]
  );
  const decoratedArtifacts = artifacts.map((artifact: any) => {
    const metrics = readJsonFile(artifact.metrics_file);
    return {
      ...artifact,
      train_samples: metrics?.train?.samples ?? null,
      train_positive_rate: metrics?.train?.positive_rate ?? null,
      validation_samples: metrics?.validation?.samples ?? null,
      validation_positive_rate: metrics?.validation?.positive_rate ?? null,
      validation_accuracy: metrics?.validation?.accuracy ?? null,
      validation_precision: metrics?.validation?.precision ?? null,
      validation_recall: metrics?.validation?.recall ?? null,
      test_samples: metrics?.test?.samples ?? null,
      test_positive_rate: metrics?.test?.positive_rate ?? null,
      test_accuracy: metrics?.test?.accuracy ?? null,
      test_precision: metrics?.test?.precision ?? null,
      test_recall: metrics?.test?.recall ?? null,
      feature_count: Array.isArray(metrics?.features) ? metrics.features.length : null
    };
  });
  const runSummary = readJsonFile(run?.output_dir ? path.join(run.output_dir, 'summary.json') : null);
  const bestArtifact = decoratedArtifacts.reduce((best: any, artifact: any) => {
    const score = artifact.test_auc ?? artifact.validation_auc ?? -1;
    const bestScore = best ? (best.test_auc ?? best.validation_auc ?? -1) : -1;
    return score > bestScore ? artifact : best;
  }, null);

  return {
    key,
    domain,
    run: run || null,
    artifacts: decoratedArtifacts,
    feature_importance: importance,
    health: {
      best_model: runSummary?.best_model || bestArtifact?.model_key || null,
      sample_count: runSummary?.sample_count ?? run?.source_row_count ?? null,
      positive_rate: runSummary?.positive_rate ?? null,
      rolling_validation: runSummary?.rolling_validation || [],
      feature_count: bestArtifact?.feature_count ?? null,
      output_dir: run?.output_dir || null,
      completed_at: runSummary?.completed_at || run?.finished_at || null
    }
  };
}

function startExperimentTrainingWorker(key: ExperimentKey | 'all') {
  const dbPath = getDatabasePath();
  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'train_experiment_models.py');
  const outputRoot = path.join(trainingRoot, 'experiments');

  if (!fs.existsSync(trainingPython)) {
    throw new Error(`实验模型训练 Python 不存在：${trainingPython}`);
  }
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`实验模型训练脚本不存在：${scriptPath}`);
  }
  fs.mkdirSync(outputRoot, { recursive: true });

  const child = spawn(trainingPython, [
    scriptPath,
    '--db', dbPath,
    '--experiment', key,
    '--output-root', outputRoot
  ], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

const runCapitalRotationDirectionWorker = (
  scope: 'focus' | 'all' | 'ai',
  limit: number
): Promise<any> => new Promise((resolve, reject) => {
  const dbPath = getDatabasePath();
  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'score_capital_rotation.py');
  const child = spawn(trainingPython, [
    scriptPath,
    '--db', dbPath,
    '--scope', scope,
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
    const text = stdout.trim();
    try {
      const payload = JSON.parse(text || '{}');
      if (code === 0 && payload.success) {
        resolve(payload.data);
        return;
      }
      reject(new Error(payload.message || stderr || `资金轮动方向榜脚本退出：${code}`));
    } catch (error) {
      reject(new Error(stderr || text || `资金轮动方向榜输出无法解析：${error instanceof Error ? error.message : String(error)}`));
    }
  });
});

const runExperimentPredictionPoolWorker = (
  key: ExperimentKey,
  assetType: string,
  limit: number,
  options: { asOfDate?: string; includeOutcomes?: boolean; horizonDays?: number } = {}
): Promise<any> => new Promise((resolve, reject) => {
  const dbPath = getDatabasePath();
  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'score_experiment_prediction_pool.py');
  const args = [
    scriptPath,
    '--db', dbPath,
    '--experiment', key,
    '--limit', String(limit)
  ];
  if (assetType) {
    args.push('--asset-type', assetType);
  }
  if (options.asOfDate) {
    args.push('--as-of-date', options.asOfDate);
  }
  if (options.includeOutcomes) {
    args.push('--include-outcomes');
  }
  if (options.horizonDays) {
    args.push('--horizon-days', String(options.horizonDays));
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
    const text = stdout.trim();
    try {
      const payload = JSON.parse(text || '{}');
      if (code === 0 && payload.success) {
        resolve(payload.data);
        return;
      }
      reject(new Error(payload.message || stderr || `最新预测池脚本退出：${code}`));
    } catch (error) {
      reject(new Error(stderr || text || `最新预测池输出无法解析：${error instanceof Error ? error.message : String(error)}`));
    }
  });
});

const quoteSqlIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

async function hasSavedFromPredictionSnapshotUniqueKey(db: any): Promise<boolean> {
  const indexes = await db.all(`PRAGMA index_list(finance_experiment_prediction_snapshots)`);
  const expectedColumns = new Set(['experiment_key', 'symbol', 'asset_type', 'source', 'trade_date', 'saved_from']);
  for (const index of indexes) {
    if (!Number(index.unique)) continue;
    const columns = await db.all(`PRAGMA index_info(${quoteSqlIdentifier(String(index.name))})`);
    const names = columns.map((column: any) => String(column.name));
    if (names.length === expectedColumns.size && names.every((name: string) => expectedColumns.has(name))) {
      return true;
    }
  }
  return false;
}

async function ensurePredictionSnapshotIndexes(db: any) {
  const ensureIndex = async (indexName: string, expectedColumns: string[], createSql: string) => {
    const columns = await db.all(`PRAGMA index_info(${quoteSqlIdentifier(indexName)})`);
    const names = columns.map((column: any) => String(column.name));
    const matches = names.length === expectedColumns.length && names.every((name: string, index: number) => name === expectedColumns[index]);
    if (columns.length && !matches) {
      await db.exec(`DROP INDEX IF EXISTS ${quoteSqlIdentifier(indexName)}`);
    }
    if (!matches) {
      await db.exec(createSql);
    }
  };

  await ensureIndex(
    'idx_finance_experiment_snapshots_scope',
    ['experiment_key', 'saved_from', 'trade_date', 'asset_type', 'source'],
    `CREATE INDEX IF NOT EXISTS idx_finance_experiment_snapshots_scope
     ON finance_experiment_prediction_snapshots(experiment_key, saved_from, trade_date DESC, asset_type, source)`
  );

  await ensureIndex(
    'idx_finance_experiment_snapshots_symbol',
    ['symbol', 'asset_type', 'source', 'trade_date', 'saved_from'],
    `CREATE INDEX IF NOT EXISTS idx_finance_experiment_snapshots_symbol
     ON finance_experiment_prediction_snapshots(symbol, asset_type, source, trade_date DESC, saved_from)`
  );

  await ensureIndex(
    'idx_finance_experiment_snapshots_saved_from',
    ['saved_from', 'experiment_key', 'market_regime', 'trade_date'],
    `CREATE INDEX IF NOT EXISTS idx_finance_experiment_snapshots_saved_from
     ON finance_experiment_prediction_snapshots(saved_from, experiment_key, market_regime, trade_date DESC)`
  );
}

async function rebuildPredictionSnapshotsSavedFromUnique(db: any) {
  const hasSavedFromUnique = await hasSavedFromPredictionSnapshotUniqueKey(db);
  if (hasSavedFromUnique) return;

  await db.exec('PRAGMA foreign_keys = OFF');
  try {
    await db.exec('BEGIN TRANSACTION');
    await db.exec(`
      CREATE TABLE finance_experiment_prediction_snapshots_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_key TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT,
        asset_type TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        universe_type TEXT,
        trade_date TEXT NOT NULL,
        close REAL,
        market_regime TEXT,
        experiment_score INTEGER,
        rule_score INTEGER,
        model_probability REAL,
        model_score INTEGER,
        direction_probability REAL,
        direction_score INTEGER,
        hardness_probability REAL,
        hardness_score INTEGER,
        raw_hardness_probability REAL,
        raw_hardness_score INTEGER,
        raw_model_accept INTEGER NOT NULL DEFAULT 0,
        discipline_model_accept INTEGER NOT NULL DEFAULT 0,
        discipline_blocked INTEGER NOT NULL DEFAULT 0,
        discipline_adjustment REAL,
        feature_label TEXT,
        rotation_label TEXT,
        rotation_reason TEXT,
        discipline_label TEXT,
        discipline_reason TEXT,
        crowding_label TEXT,
        crowding_reason TEXT,
        feature_snapshot_json TEXT,
        artifact_json TEXT,
        no_lookahead_note TEXT,
        saved_from TEXT NOT NULL DEFAULT 'latest_prediction_pool',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(experiment_key, symbol, asset_type, source, trade_date, saved_from)
      );

      INSERT INTO finance_experiment_prediction_snapshots_next (
        id, experiment_key, symbol, name, asset_type, source, universe_type, trade_date, close,
        market_regime, experiment_score, rule_score, model_probability, model_score,
        direction_probability, direction_score, hardness_probability, hardness_score,
        raw_hardness_probability, raw_hardness_score, raw_model_accept, discipline_model_accept,
        discipline_blocked, discipline_adjustment,
        feature_label, rotation_label, rotation_reason, discipline_label, discipline_reason,
        crowding_label, crowding_reason, feature_snapshot_json, artifact_json, no_lookahead_note,
        saved_from, created_at, updated_at
      )
      SELECT
        id, experiment_key, symbol, name, COALESCE(asset_type, ''), COALESCE(source, ''), universe_type, trade_date, close,
        market_regime, experiment_score, rule_score, model_probability, model_score,
        direction_probability, direction_score, hardness_probability, hardness_score,
        raw_hardness_probability, raw_hardness_score, COALESCE(raw_model_accept, 0), COALESCE(discipline_model_accept, 0),
        COALESCE(discipline_blocked, 0), discipline_adjustment,
        feature_label, rotation_label, rotation_reason, discipline_label, discipline_reason,
        crowding_label, crowding_reason, feature_snapshot_json, artifact_json, no_lookahead_note,
        COALESCE(NULLIF(saved_from, ''), 'latest_prediction_pool'), created_at, updated_at
      FROM finance_experiment_prediction_snapshots;

      DROP TABLE finance_experiment_prediction_snapshots;
      ALTER TABLE finance_experiment_prediction_snapshots_next RENAME TO finance_experiment_prediction_snapshots;
    `);
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  } finally {
    await db.exec('PRAGMA foreign_keys = ON');
  }

  const foreignKeyIssues = await db.all('PRAGMA foreign_key_check');
  if (foreignKeyIssues.length) {
    throw new Error(`预测池快照唯一键迁移后外键检查失败：${foreignKeyIssues.length} 条`);
  }
}

async function ensurePredictionSnapshotTables(db: any) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS finance_experiment_prediction_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_key TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      asset_type TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      universe_type TEXT,
      trade_date TEXT NOT NULL,
      close REAL,
      market_regime TEXT,
      experiment_score INTEGER,
      rule_score INTEGER,
      model_probability REAL,
      model_score INTEGER,
      direction_probability REAL,
      direction_score INTEGER,
      hardness_probability REAL,
      hardness_score INTEGER,
      raw_hardness_probability REAL,
      raw_hardness_score INTEGER,
      raw_model_accept INTEGER NOT NULL DEFAULT 0,
      discipline_model_accept INTEGER NOT NULL DEFAULT 0,
      discipline_blocked INTEGER NOT NULL DEFAULT 0,
      discipline_adjustment REAL,
      feature_label TEXT,
      rotation_label TEXT,
      rotation_reason TEXT,
      discipline_label TEXT,
      discipline_reason TEXT,
      crowding_label TEXT,
      crowding_reason TEXT,
      feature_snapshot_json TEXT,
      artifact_json TEXT,
      no_lookahead_note TEXT,
      saved_from TEXT NOT NULL DEFAULT 'latest_prediction_pool',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(experiment_key, symbol, asset_type, source, trade_date, saved_from)
    );

    CREATE TABLE IF NOT EXISTS finance_experiment_prediction_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      experiment_key TEXT NOT NULL,
      symbol TEXT NOT NULL,
      asset_type TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      trade_date TEXT NOT NULL,
      base_close REAL,
      horizon_days INTEGER NOT NULL DEFAULT 20,
      available_future_days INTEGER NOT NULL DEFAULT 0,
      horizon_end_date TEXT,
      forward_return_5d REAL,
      forward_return_10d REAL,
      forward_return_20d REAL,
      max_forward_return REAL,
      max_drawdown REAL,
      drawdown_discipline_hit INTEGER NOT NULL DEFAULT 0,
      direction_outcome TEXT,
      hardness_outcome TEXT,
      label_status TEXT NOT NULL DEFAULT 'pending',
      label_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (snapshot_id) REFERENCES finance_experiment_prediction_snapshots(id) ON DELETE CASCADE,
      UNIQUE(snapshot_id, horizon_days)
    );

    CREATE INDEX IF NOT EXISTS idx_finance_experiment_labels_scope
    ON finance_experiment_prediction_labels(experiment_key, label_status, trade_date DESC);
  `);

  const snapshotColumns = await db.all(`PRAGMA table_info(finance_experiment_prediction_snapshots)`);
  const existingColumns = new Set(snapshotColumns.map((column: any) => String(column.name)));
  const requiredColumns = [
    ['saved_from', "TEXT NOT NULL DEFAULT 'latest_prediction_pool'"],
    ['raw_hardness_probability', 'REAL'],
    ['raw_hardness_score', 'INTEGER'],
    ['raw_model_accept', 'INTEGER NOT NULL DEFAULT 0'],
    ['discipline_model_accept', 'INTEGER NOT NULL DEFAULT 0'],
    ['discipline_blocked', 'INTEGER NOT NULL DEFAULT 0'],
    ['discipline_adjustment', 'REAL']
  ];
  for (const [column, definition] of requiredColumns) {
    if (!existingColumns.has(column)) {
      await db.exec(`ALTER TABLE finance_experiment_prediction_snapshots ADD COLUMN ${column} ${definition}`);
    }
  }
  await rebuildPredictionSnapshotsSavedFromUnique(db);
  await ensurePredictionSnapshotIndexes(db);
}

const nullableNumber = (value: any) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const jsonStringify = (value: any) => {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

const jsonParseObject = (value: any): Record<string, any> => {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const buildArtifactSnapshot = (data: any) => ({
  artifact: data?.artifact || null,
  direction_artifact: data?.direction_artifact || null,
  hardness_artifact: data?.hardness_artifact || null,
  split_model: Boolean(data?.split_model)
});

async function persistPredictionSnapshots(
  db: any,
  key: ExperimentKey,
  data: any,
  options: { savedFrom?: string; replaceLatestScope?: boolean; replaceAssetType?: string; expectedTradeDate?: string | null } = {}
) {
  await ensurePredictionSnapshotTables(db);
  const items = Array.isArray(data?.items) ? data.items : [];
  const artifactJson = jsonStringify(buildArtifactSnapshot(data));
  const inferredSavedFrom = options.savedFrom
    || data?.meta?.saved_from
    || data?.meta?.savedFrom
    || (data?.meta?.replay_mode ? 'historical_prediction_replay' : 'latest_prediction_pool');
  const savedFrom = normalizeSnapshotSavedFrom(inferredSavedFrom, 'latest_prediction_pool') || 'latest_prediction_pool';
  let inserted = 0;
  let updated = 0;
  let pruned = 0;
  const currentIdentitySet = new Set<string>();
  const currentTradeDates = new Set<string>();
  const buildSnapshotIdentity = (item: any) => [
    String(item.symbol || '').trim(),
    String(item.asset_type || '').trim(),
    String(item.source || '').trim(),
    String(item.trade_date || '').trim()
  ].join('\u0000');
  const expectedTradeDate = String(options.expectedTradeDate || '').trim();

  if (savedFrom === 'latest_prediction_pool' && options.replaceLatestScope && items.length === 0) {
    throw new Error('最新预测池为空，已拒绝覆盖或保留旧口径快照；请先确认实时计算是否正常。');
  }
  if (savedFrom === 'latest_prediction_pool' && expectedTradeDate) {
    const staleItem = items.find((item: any) => String(item?.trade_date || '').trim() !== expectedTradeDate);
    if (staleItem) {
      throw new Error(`最新预测池截面日不一致：${staleItem.symbol || '未知标的'} 是 ${staleItem.trade_date || '--'}，系统最新交易日是 ${expectedTradeDate}。`);
    }
  }

  await db.exec('BEGIN TRANSACTION');
  try {
    for (const item of items) {
      const symbol = String(item.symbol || '').trim();
      const tradeDate = String(item.trade_date || '').trim();
      if (!symbol || !tradeDate) continue;

      const assetType = String(item.asset_type || '').trim();
      const source = String(item.source || '').trim();
      currentIdentitySet.add(buildSnapshotIdentity({ symbol, asset_type: assetType, source, trade_date: tradeDate }));
      currentTradeDates.add(tradeDate);
      const existing = await db.get(
        `SELECT id, saved_from FROM finance_experiment_prediction_snapshots
         WHERE experiment_key = ? AND symbol = ? AND asset_type = ? AND source = ? AND trade_date = ? AND saved_from = ?`,
        [key, symbol, assetType, source, tradeDate, savedFrom]
      );

      await db.run(
        `INSERT INTO finance_experiment_prediction_snapshots (
          experiment_key, symbol, name, asset_type, source, universe_type, trade_date, close,
          market_regime, experiment_score, rule_score, model_probability, model_score,
          direction_probability, direction_score, hardness_probability, hardness_score,
          raw_hardness_probability, raw_hardness_score, raw_model_accept, discipline_model_accept,
          discipline_blocked, discipline_adjustment,
          feature_label, rotation_label, rotation_reason, discipline_label, discipline_reason,
          crowding_label, crowding_reason, feature_snapshot_json, artifact_json, no_lookahead_note,
          saved_from, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(experiment_key, symbol, asset_type, source, trade_date, saved_from) DO UPDATE SET
          name = excluded.name,
          universe_type = excluded.universe_type,
          close = excluded.close,
          market_regime = excluded.market_regime,
          experiment_score = excluded.experiment_score,
          rule_score = excluded.rule_score,
          model_probability = excluded.model_probability,
          model_score = excluded.model_score,
          direction_probability = excluded.direction_probability,
          direction_score = excluded.direction_score,
          hardness_probability = excluded.hardness_probability,
          hardness_score = excluded.hardness_score,
          raw_hardness_probability = excluded.raw_hardness_probability,
          raw_hardness_score = excluded.raw_hardness_score,
          raw_model_accept = excluded.raw_model_accept,
          discipline_model_accept = excluded.discipline_model_accept,
          discipline_blocked = excluded.discipline_blocked,
          discipline_adjustment = excluded.discipline_adjustment,
          feature_label = excluded.feature_label,
          rotation_label = excluded.rotation_label,
          rotation_reason = excluded.rotation_reason,
          discipline_label = excluded.discipline_label,
          discipline_reason = excluded.discipline_reason,
          crowding_label = excluded.crowding_label,
          crowding_reason = excluded.crowding_reason,
          feature_snapshot_json = excluded.feature_snapshot_json,
          artifact_json = excluded.artifact_json,
          no_lookahead_note = excluded.no_lookahead_note,
          updated_at = CURRENT_TIMESTAMP`,
        [
          key,
          symbol,
          item.name || symbol,
          assetType,
          source,
          item.universe_type || item.feature_snapshot?.universe_type || null,
          tradeDate,
          nullableNumber(item.close),
          item.market_regime || null,
          nullableNumber(item.experiment_score),
          nullableNumber(item.rule_score),
          nullableNumber(item.model_probability),
          nullableNumber(item.model_score),
          nullableNumber(item.direction_probability),
          nullableNumber(item.direction_score),
          nullableNumber(item.hardness_probability),
          nullableNumber(item.hardness_score),
          nullableNumber(item.raw_hardness_probability),
          nullableNumber(item.raw_hardness_score),
          item.raw_model_accept ? 1 : 0,
          item.discipline_model_accept ? 1 : 0,
          item.discipline_blocked ? 1 : 0,
          nullableNumber(item.discipline_adjustment),
          item.feature_label || null,
          item.rotation_label || null,
          item.rotation_reason || null,
          item.discipline_label || null,
          item.discipline_reason || null,
          item.crowding_label || null,
          item.crowding_reason || null,
          jsonStringify(item.feature_snapshot || {}),
          artifactJson,
          item.no_lookahead_note || null,
          savedFrom
        ]
      );

      const snapshot = await db.get(
        `SELECT id FROM finance_experiment_prediction_snapshots
         WHERE experiment_key = ? AND symbol = ? AND asset_type = ? AND source = ? AND trade_date = ? AND saved_from = ?`,
        [key, symbol, assetType, source, tradeDate, savedFrom]
      );
      if (snapshot?.id) {
        await db.run(
          `INSERT OR IGNORE INTO finance_experiment_prediction_labels (
            snapshot_id, experiment_key, symbol, asset_type, source, trade_date, base_close, label_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
          [snapshot.id, key, symbol, assetType, source, tradeDate, nullableNumber(item.close)]
        );
      }

      if (existing?.id) {
        updated++;
      } else {
        inserted++;
      }
    }

    if (options.replaceLatestScope && savedFrom === 'latest_prediction_pool' && currentIdentitySet.size > 0) {
      const replaceAssetType = String(options.replaceAssetType || '').trim();
      for (const tradeDate of currentTradeDates) {
        const params: any[] = [key, savedFrom, tradeDate];
        const clauses = ['experiment_key = ?', 'saved_from = ?', 'trade_date = ?'];
        if (replaceAssetType) {
          clauses.push('asset_type = ?');
          params.push(replaceAssetType);
        }
        const existingRows = await db.all(
          `SELECT id, symbol, asset_type, source, trade_date
           FROM finance_experiment_prediction_snapshots
           WHERE ${clauses.join(' AND ')}`,
          params
        );
        const staleIds = existingRows
          .filter((row: any) => !currentIdentitySet.has(buildSnapshotIdentity(row)))
          .map((row: any) => Number(row.id))
          .filter((id: number) => Number.isFinite(id) && id > 0);
        if (!staleIds.length) continue;
        const placeholders = staleIds.map(() => '?').join(',');
        const deleteResult = await db.run(
          `DELETE FROM finance_experiment_prediction_snapshots WHERE id IN (${placeholders})`,
          staleIds
        );
        pruned += Number(deleteResult?.changes || 0);
      }
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }

  return {
    saved_count: inserted + updated,
    inserted_count: inserted,
    updated_count: updated,
    pruned_count: pruned
  };
}

async function getFuturePricesForSnapshot(db: any, snapshot: PredictionSnapshotRow, horizonDays: number) {
  const rows: any[] = await db.all(
    `SELECT trade_date, open, high, low, close, amount, volume
     FROM financial_daily_prices
     WHERE symbol = ? AND asset_type = ? AND source = ? AND trade_date > ? AND close IS NOT NULL AND close > 0
     ORDER BY trade_date ASC
     LIMIT ?`,
    [snapshot.symbol, snapshot.asset_type, snapshot.source, snapshot.trade_date, horizonDays]
  );
  return rows.map((item: any) => ({
    trade_date: String(item.trade_date),
    open: nullableNumber(item.open),
    high: nullableNumber(item.high),
    low: nullableNumber(item.low),
    close: Number(item.close),
    amount: nullableNumber(item.amount),
    volume: nullableNumber(item.volume)
  }));
}

function normalizeProvidedPredictionPoolForSave(
  key: ExperimentKey,
  providedPool: any,
  assetType: string,
  limit: number,
  latestDate: string | null
) {
  if (!providedPool || typeof providedPool !== 'object' || !Array.isArray(providedPool.items)) {
    throw new Error('当前页面没有可保存的实时预测池。');
  }
  const meta = providedPool.meta && typeof providedPool.meta === 'object' ? providedPool.meta : {};
  const providedKey = String(meta.key || '').trim();
  if (providedKey && providedKey !== key) {
    throw new Error(`当前实时预测池模型不一致：页面是 ${providedKey}，保存目标是 ${key}。`);
  }
  if (meta.replay_mode === true || meta.data_source === 'prediction_replay_snapshot') {
    throw new Error('历史截面回放结果不能保存为最新预测池。');
  }
  if (meta.snapshot_mode === true || meta.data_source === 'latest_prediction_pool_snapshot') {
    throw new Error('当前展示的是日终快照，不是实时计算结果；请先手动实时计算，再保存当前结果。');
  }
  const providedTradeDate = String(meta.as_of_date || meta.latest_price_date || '').trim();
  if (latestDate && providedTradeDate && providedTradeDate !== latestDate) {
    throw new Error(`当前实时预测池截面日 ${providedTradeDate} 不是最新交易日 ${latestDate}，已拒绝保存旧结果。`);
  }
  const items = providedPool.items
    .slice(0, Math.min(Math.max(Number(limit || 40), 10), 120))
    .filter((item: any) => String(item?.symbol || '').trim() && String(item?.trade_date || '').trim())
    .map((item: any) => ({
      ...item,
      symbol: String(item.symbol || '').trim(),
      asset_type: String(item.asset_type || '').trim(),
      source: String(item.source || '').trim(),
      trade_date: String(item.trade_date || '').trim()
    }));
  if (!items.length) {
    throw new Error('当前实时预测池为空，不能保存为空快照。');
  }
  const invalidAsset = items.find((item: any) => !experimentMeta[key].assetTypes.includes(item.asset_type));
  if (invalidAsset) {
    throw new Error(`当前实时预测池包含不属于 ${experimentMeta[key].title} 的资产类型：${invalidAsset.symbol} / ${invalidAsset.asset_type || '未知'}。`);
  }
  if (latestDate) {
    const staleItem = items.find((item: any) => item.trade_date !== latestDate);
    if (staleItem) {
      throw new Error(`当前实时预测池包含旧截面样本：${staleItem.symbol} 是 ${staleItem.trade_date}，最新交易日是 ${latestDate}。`);
    }
  }
  if (assetType) {
    const mismatched = items.find((item: any) => item.asset_type !== assetType);
    if (mismatched) {
      throw new Error(`当前实时预测池资产范围与保存范围不一致：${mismatched.symbol} 是 ${mismatched.asset_type || '未知'}，当前范围是 ${assetType}。`);
    }
  }

  return {
    ...providedPool,
    meta: {
      ...meta,
      key,
      title: experimentMeta[key].title,
      asset_types: experimentMeta[key].assetTypes,
      latest_price_date: latestDate || meta.latest_price_date || null,
      as_of_date: latestDate || meta.as_of_date || null,
      replay_mode: false,
      snapshot_mode: false,
      data_source: 'displayed_live_prediction_pool',
      saved_from: 'latest_prediction_pool',
      no_lookahead_rule: meta.no_lookahead_rule || '保存当前页面实时预测池；只使用截面日及以前数据，不读取未来收益。'
    },
    items
  };
}

const getDrawdownDisciplineFloorPercent = (marketRegime?: string | null) => {
  const normalizedRegime = classifyMarket(marketRegime);
  if (normalizedRegime === 'RISK') return -6;
  if (normalizedRegime === 'CRASH') return -8;
  return -8;
};

const getDirectionOutcome = (
  key: ExperimentKey,
  labelStatus: string,
  forwardReturn20: number | null,
  maxForwardReturn: number | null,
  maxDrawdown: number | null,
  marketRegime?: string | null
) => {
  if (labelStatus === 'pending') return '待观察';
  const threshold = (experimentMeta[key]?.positiveThreshold || 0.06) * 100;
  const drawdownFloor = getDrawdownDisciplineFloorPercent(marketRegime);
  if ((maxForwardReturn ?? -Infinity) >= threshold) return '方向兑现';
  if ((maxDrawdown ?? 0) <= drawdownFloor) return '方向失败';
  if (labelStatus === 'partial') return '观察中';
  if ((forwardReturn20 ?? 0) > 0) return '小幅兑现';
  return '未兑现';
};

const getHardnessOutcome = (
  labelStatus: string,
  maxForwardReturn: number | null,
  maxDrawdown: number | null,
  marketRegime?: string | null
) => {
  if (labelStatus === 'pending') return '待观察';
  const normalizedRegime = classifyMarket(marketRegime);
  const drawdownFloor = getDrawdownDisciplineFloorPercent(marketRegime);
  if ((maxDrawdown ?? 0) <= drawdownFloor) {
    if (normalizedRegime === 'RISK') return '风险区承接破坏';
    if (normalizedRegime === 'CRASH') return '冻结区回撤打穿';
    return '承接破坏';
  }
  if ((maxDrawdown ?? 0) <= -5) return '承接偏弱';
  if ((maxForwardReturn ?? 0) >= 5) return '承接有效';
  return labelStatus === 'partial' ? '观察中' : '承接一般';
};

async function refreshPredictionLabels(
  db: any,
  key: ExperimentKey,
  options: { assetType?: string; limit?: number; horizonDays?: number; force?: boolean; savedFrom?: string }
) {
  await ensurePredictionSnapshotTables(db);
  const horizonDays = Math.min(Math.max(Number(options.horizonDays || 20), 5), 60);
  const limit = Math.min(Math.max(Number(options.limit || 300), 20), 2000);
  const params: any[] = [key];
  const clauses = ['s.experiment_key = ?'];
  if (options.assetType) {
    clauses.push('s.asset_type = ?');
    params.push(options.assetType);
  }
  const savedFrom = normalizeSnapshotSavedFrom(options.savedFrom);
  if (savedFrom) {
    clauses.push('s.saved_from = ?');
    params.push(savedFrom);
  }
  const latestCoveredTradeDate = await getLatestCoveredTradeDate(db);
  if (latestCoveredTradeDate) {
    clauses.push('s.trade_date <= ?');
    params.push(latestCoveredTradeDate);
  }
  if (!options.force) {
    clauses.push("(l.label_status IS NULL OR l.label_status != 'complete')");
  }
  const snapshots: PredictionSnapshotRow[] = await db.all(
    `SELECT s.*
     FROM finance_experiment_prediction_snapshots s
     LEFT JOIN finance_experiment_prediction_labels l
       ON l.snapshot_id = s.id AND l.horizon_days = ?
     WHERE ${clauses.join(' AND ')}
     ORDER BY s.trade_date DESC, s.id DESC
     LIMIT ?`,
    [horizonDays, ...params, limit]
  );

  let refreshed = 0;
  let completed = 0;
  let partial = 0;
  let pending = 0;

  for (const snapshot of snapshots) {
    const baseClose = nullableNumber(snapshot.close);
    if (!baseClose) continue;
    const future = await getFuturePricesForSnapshot(db, snapshot, horizonDays);
    const availableFutureDays = future.length;
    const labelStatus = availableFutureDays >= horizonDays ? 'complete' : availableFutureDays > 0 ? 'partial' : 'pending';
    const forwardReturn5 = availableFutureDays >= 5 ? percent(getReturnAt(baseClose, future, 5)) : null;
    const forwardReturn10 = availableFutureDays >= 10 ? percent(getReturnAt(baseClose, future, 10)) : null;
    const forwardReturn20 = availableFutureDays >= 20 ? percent(getReturnAt(baseClose, future, 20)) : null;
    const maxForwardReturn = availableFutureDays > 0 ? percent(getMaxForwardReturn(baseClose, future)) : null;
    const maxDrawdown = availableFutureDays > 0 ? percent(getMaxForwardDrawdown(baseClose, future)) : null;
    const horizonEndDate = future[Math.min(availableFutureDays, horizonDays) - 1]?.trade_date || null;
    const drawdownDisciplineFloor = getDrawdownDisciplineFloorPercent(snapshot.market_regime);
    const directionOutcome = getDirectionOutcome(key, labelStatus, forwardReturn20, maxForwardReturn, maxDrawdown, snapshot.market_regime);
    const hardnessOutcome = getHardnessOutcome(labelStatus, maxForwardReturn, maxDrawdown, snapshot.market_regime);
    const labelReason = labelStatus === 'complete'
      ? `已满 ${horizonDays} 个未来交易日`
      : availableFutureDays > 0
        ? `已有 ${availableFutureDays}/${horizonDays} 个未来交易日，继续滚动`
        : `尚无 ${snapshot.trade_date} 之后的未来交易日`;

    await db.run(
      `INSERT INTO finance_experiment_prediction_labels (
        snapshot_id, experiment_key, symbol, asset_type, source, trade_date, base_close, horizon_days,
        available_future_days, horizon_end_date, forward_return_5d, forward_return_10d,
        forward_return_20d, max_forward_return, max_drawdown, drawdown_discipline_hit,
        direction_outcome, hardness_outcome, label_status, label_reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(snapshot_id, horizon_days) DO UPDATE SET
        base_close = excluded.base_close,
        available_future_days = excluded.available_future_days,
        horizon_end_date = excluded.horizon_end_date,
        forward_return_5d = excluded.forward_return_5d,
        forward_return_10d = excluded.forward_return_10d,
        forward_return_20d = excluded.forward_return_20d,
        max_forward_return = excluded.max_forward_return,
        max_drawdown = excluded.max_drawdown,
        drawdown_discipline_hit = excluded.drawdown_discipline_hit,
        direction_outcome = excluded.direction_outcome,
        hardness_outcome = excluded.hardness_outcome,
        label_status = excluded.label_status,
        label_reason = excluded.label_reason,
        updated_at = CURRENT_TIMESTAMP`,
      [
        snapshot.id,
        key,
        snapshot.symbol,
        snapshot.asset_type,
        snapshot.source,
        snapshot.trade_date,
        baseClose,
        horizonDays,
        availableFutureDays,
        horizonEndDate,
        forwardReturn5,
        forwardReturn10,
        forwardReturn20,
        maxForwardReturn,
        maxDrawdown,
        maxDrawdown !== null && maxDrawdown <= drawdownDisciplineFloor ? 1 : 0,
        directionOutcome,
        hardnessOutcome,
        labelStatus,
        labelReason
      ]
    );

    refreshed++;
    if (labelStatus === 'complete') completed++;
    else if (labelStatus === 'partial') partial++;
    else pending++;
  }

  return {
    horizon_days: horizonDays,
    scanned_count: snapshots.length,
    refreshed_count: refreshed,
    completed_count: completed,
    partial_count: partial,
    pending_count: pending
  };
}

async function getSnapshotDailyCoverageQuality(db: any, tradeDate: string | null) {
  if (!tradeDate) {
    return { status: 'unknown', trade_date: null, message: '没有快照日期' };
  }

  const previousDateRow = await db.get(
    `SELECT MAX(trade_date) as trade_date
     FROM financial_daily_prices
     WHERE source = 'tushare'
       AND asset_type IN ('stock', 'etf')
       AND trade_date < ?`,
    [tradeDate]
  );
  const previousTradeDate = previousDateRow?.trade_date || null;
  if (!previousTradeDate) {
    return { status: 'unknown', trade_date: tradeDate, message: '没有上一交易日覆盖基准' };
  }

  const countForDate = async (date: string) => {
    const row = await db.get(
      `SELECT COUNT(DISTINCT p.symbol || '|' || p.asset_type || '|' || p.source) as count
       FROM financial_daily_prices p
       JOIN financial_asset_universe u
         ON u.symbol = p.symbol
        AND u.asset_type = p.asset_type
        AND u.source = p.source
       WHERE p.source = 'tushare'
         AND p.asset_type IN ('stock', 'etf')
         AND p.trade_date = ?
         AND u.enabled = 1`,
      [date]
    );
    return Number(row?.count || 0);
  };

  const currentCount = await countForDate(tradeDate);
  const previousCount = await countForDate(previousTradeDate);
  if (previousCount <= 0) {
    return { status: 'unknown', trade_date: tradeDate, current_count: currentCount, previous_trade_date: previousTradeDate, previous_count: previousCount };
  }

  const minExpected = Math.floor(previousCount * 0.92);
  if (currentCount < minExpected) {
    return {
      status: 'incomplete',
      trade_date: tradeDate,
      current_count: currentCount,
      previous_trade_date: previousTradeDate,
      previous_count: previousCount,
      min_expected: minExpected,
      message: `${tradeDate} 日线覆盖不足：${currentCount}/${previousCount}，已跳过这批预测池快照`
    };
  }

  return {
    status: 'ok',
    trade_date: tradeDate,
    current_count: currentCount,
    previous_trade_date: previousTradeDate,
    previous_count: previousCount,
    min_expected: minExpected
  };
}

async function getPredictionSnapshotSummary(
  db: any,
  key: ExperimentKey,
  options: { assetType?: string; limit?: number; savedFrom?: string; latestOnly?: boolean } = {}
) {
  await ensurePredictionSnapshotTables(db);
  const params: any[] = [key];
  const clauses = ['s.experiment_key = ?'];
  if (options.assetType) {
    clauses.push('s.asset_type = ?');
    params.push(options.assetType);
  }
  const savedFrom = normalizeSnapshotSavedFrom(options.savedFrom);
  if (savedFrom) {
    clauses.push('s.saved_from = ?');
    params.push(savedFrom);
  }
  let snapshotScope = 'history';
  let scopeTradeDate: string | null = null;
  let scopeDataQuality: any = null;
  if (savedFrom === 'latest_prediction_pool' && options.latestOnly !== false) {
    const skippedDates: any[] = [];
    if (options.assetType) {
      const snapshotDates = await db.all(
        `SELECT s.trade_date
         FROM finance_experiment_prediction_snapshots s
         WHERE ${clauses.join(' AND ')}
         GROUP BY s.trade_date
         ORDER BY s.trade_date DESC
         LIMIT 10`,
        params
      );
      for (const row of snapshotDates) {
        const candidateDate = row?.trade_date || null;
        const quality = await getSnapshotDailyCoverageQuality(db, candidateDate);
        if (quality.status !== 'incomplete') {
          scopeTradeDate = candidateDate;
          scopeDataQuality = {
            ...quality,
            skipped_dates: skippedDates
          };
          break;
        }
        skippedDates.push(quality);
      }
      if (!scopeTradeDate && snapshotDates[0]?.trade_date) {
        scopeTradeDate = snapshotDates[0].trade_date;
        scopeDataQuality = {
          ...(await getSnapshotDailyCoverageQuality(db, scopeTradeDate)),
          skipped_dates: skippedDates.slice(1)
        };
      }
      if (scopeTradeDate) {
        clauses.push('s.trade_date = ?');
        params.push(scopeTradeDate);
      }
    } else {
      const snapshotDates = await db.all(
        `SELECT s.asset_type, s.trade_date
         FROM finance_experiment_prediction_snapshots s
         WHERE ${clauses.join(' AND ')}
         GROUP BY s.asset_type, s.trade_date
         ORDER BY s.asset_type ASC, s.trade_date DESC`,
        params
      );
      const grouped = snapshotDates.reduce((acc: Map<string, any[]>, row: any) => {
        const assetType = String(row.asset_type || '');
        const rows = acc.get(assetType) || [];
        rows.push(row);
        acc.set(assetType, rows);
        return acc;
      }, new Map<string, any[]>());
      const latestScopes: Array<{ asset_type: string; trade_date: string }> = [];
      for (const [assetType, rows] of grouped.entries()) {
        let selectedDate: string | null = null;
        for (const row of rows.slice(0, 10)) {
          const candidateDate = row?.trade_date || null;
          const quality = await getSnapshotDailyCoverageQuality(db, candidateDate);
          if (quality.status !== 'incomplete') {
            selectedDate = candidateDate;
            break;
          }
          skippedDates.push({ asset_type: assetType, ...quality });
        }
        if (!selectedDate && rows[0]?.trade_date) {
          selectedDate = rows[0].trade_date;
        }
        if (selectedDate) {
          latestScopes.push({ asset_type: assetType, trade_date: selectedDate });
        }
      }
      if (latestScopes.length) {
        const scopeClause = latestScopes
          .map(() => '(s.asset_type = ? AND s.trade_date = ?)')
          .join(' OR ');
        clauses.push(`(${scopeClause})`);
        params.push(...latestScopes.flatMap(scope => [scope.asset_type, scope.trade_date]));
        scopeTradeDate = latestScopes.map(scope => scope.trade_date).sort().slice(-1)[0] || null;
        scopeDataQuality = {
          status: 'latest_by_asset_type',
          asset_trade_dates: latestScopes,
          skipped_dates: skippedDates
        };
      }
    }
    snapshotScope = 'latest_trade_date';
  }
  const where = clauses.join(' AND ');
  const summary = await db.get(
    `SELECT
       COUNT(*) AS total_count,
       MAX(s.trade_date) AS latest_trade_date,
       MAX(s.updated_at) AS last_saved_at,
       SUM(CASE WHEN COALESCE(l.label_status, 'pending') = 'complete' THEN 1 ELSE 0 END) AS complete_count,
       SUM(CASE WHEN COALESCE(l.label_status, 'pending') = 'partial' THEN 1 ELSE 0 END) AS partial_count,
       SUM(CASE WHEN COALESCE(l.label_status, 'pending') = 'pending' THEN 1 ELSE 0 END) AS pending_count,
       SUM(CASE WHEN COALESCE(l.label_status, 'pending') = 'complete' AND l.forward_return_20d > 0 THEN 1 ELSE 0 END) AS win_count,
       AVG(l.forward_return_20d) AS average_forward_return_20d,
       AVG(l.max_drawdown) AS average_max_drawdown,
       SUM(CASE WHEN l.drawdown_discipline_hit = 1 THEN 1 ELSE 0 END) AS drawdown_discipline_hit_count,
       AVG(s.model_probability) AS average_model_probability,
       AVG(s.direction_probability) AS average_direction_probability,
       AVG(s.hardness_probability) AS average_hardness_probability,
       AVG(s.raw_hardness_probability) AS average_raw_hardness_probability,
       SUM(CASE WHEN s.raw_model_accept = 1 THEN 1 ELSE 0 END) AS raw_model_accept_count,
       SUM(CASE WHEN s.discipline_model_accept = 1 THEN 1 ELSE 0 END) AS discipline_model_accept_count,
       SUM(CASE WHEN s.discipline_blocked = 1 THEN 1 ELSE 0 END) AS discipline_blocked_count,
       SUM(CASE
         WHEN s.raw_model_accept = 1
          AND (COALESCE(s.discipline_model_accept, 0) = 0 OR COALESCE(s.discipline_blocked, 0) = 1)
         THEN 1 ELSE 0
       END) AS rule_conflict_count
     FROM finance_experiment_prediction_snapshots s
     LEFT JOIN finance_experiment_prediction_labels l
       ON l.snapshot_id = s.id AND l.horizon_days = 20
     WHERE ${where}`,
    params
  );
  const regimeRows = await db.all(
    `SELECT
       COALESCE(s.market_regime, 'UNKNOWN') AS market_regime,
       COUNT(*) AS total_count,
       SUM(CASE WHEN COALESCE(l.label_status, 'pending') = 'complete' THEN 1 ELSE 0 END) AS complete_count,
       SUM(CASE WHEN COALESCE(l.label_status, 'pending') = 'partial' THEN 1 ELSE 0 END) AS partial_count,
       SUM(CASE WHEN COALESCE(l.label_status, 'pending') = 'pending' THEN 1 ELSE 0 END) AS pending_count,
       AVG(s.model_probability) AS average_model_probability,
       AVG(s.direction_probability) AS average_direction_probability,
       AVG(s.hardness_probability) AS average_hardness_probability,
       AVG(s.raw_hardness_probability) AS average_raw_hardness_probability,
       SUM(CASE WHEN s.raw_model_accept = 1 THEN 1 ELSE 0 END) AS raw_model_accept_count,
       SUM(CASE WHEN s.discipline_model_accept = 1 THEN 1 ELSE 0 END) AS discipline_model_accept_count,
       SUM(CASE WHEN s.discipline_blocked = 1 THEN 1 ELSE 0 END) AS discipline_blocked_count,
       AVG(l.forward_return_20d) AS average_forward_return_20d,
       AVG(l.max_drawdown) AS average_max_drawdown,
       SUM(CASE WHEN l.drawdown_discipline_hit = 1 THEN 1 ELSE 0 END) AS drawdown_discipline_hit_count
     FROM finance_experiment_prediction_snapshots s
     LEFT JOIN finance_experiment_prediction_labels l
       ON l.snapshot_id = s.id AND l.horizon_days = 20
     WHERE ${where}
     GROUP BY COALESCE(s.market_regime, 'UNKNOWN')
     ORDER BY CASE COALESCE(s.market_regime, 'UNKNOWN')
       WHEN 'NORMAL' THEN 1
       WHEN 'RISK' THEN 2
       WHEN 'CRASH' THEN 3
       ELSE 9
     END`,
    params
  );
  const rows = await db.all(
    `SELECT
       s.id, s.experiment_key, s.symbol, s.name, s.asset_type, s.source, s.universe_type,
       s.trade_date, s.close, s.market_regime, s.rule_score, s.model_probability,
       s.direction_probability, s.hardness_probability, s.raw_hardness_probability,
       s.raw_hardness_score, s.raw_model_accept, s.discipline_model_accept,
       s.discipline_blocked, s.discipline_adjustment,
       s.feature_label, s.rotation_label,
       s.discipline_label, s.crowding_label, s.saved_from, s.updated_at,
       l.label_status, l.available_future_days, l.forward_return_5d, l.forward_return_10d,
       l.forward_return_20d, l.max_forward_return, l.max_drawdown, l.drawdown_discipline_hit,
       l.direction_outcome, l.hardness_outcome, l.label_reason, l.updated_at AS label_updated_at
     FROM finance_experiment_prediction_snapshots s
     LEFT JOIN finance_experiment_prediction_labels l
       ON l.snapshot_id = s.id AND l.horizon_days = 20
     WHERE ${where}
     ORDER BY s.trade_date DESC, s.updated_at DESC, s.id DESC
     LIMIT ?`,
    [...params, Math.min(Math.max(Number(options.limit || 20), 5), 100)]
  );

  return {
    summary: {
      scope: snapshotScope,
      scope_trade_date: scopeTradeDate,
      total_count: Number(summary?.total_count || 0),
      latest_trade_date: summary?.latest_trade_date || null,
      last_saved_at: summary?.last_saved_at || null,
      complete_count: Number(summary?.complete_count || 0),
      partial_count: Number(summary?.partial_count || 0),
      pending_count: Number(summary?.pending_count || 0),
      win_rate_20d: Number(summary?.complete_count || 0)
        ? round(Number(summary?.win_count || 0) / Number(summary?.complete_count || 0) * 100, 2)
        : null,
      average_forward_return_20d: round(summary?.average_forward_return_20d, 2),
      average_max_drawdown: round(summary?.average_max_drawdown, 2),
      drawdown_discipline_hit_count: Number(summary?.drawdown_discipline_hit_count || 0),
      average_model_probability: round(summary?.average_model_probability, 4),
      average_direction_probability: round(summary?.average_direction_probability, 4),
      average_hardness_probability: round(summary?.average_hardness_probability, 4),
      average_raw_hardness_probability: round(summary?.average_raw_hardness_probability, 4),
      raw_model_accept_count: Number(summary?.raw_model_accept_count || 0),
      discipline_model_accept_count: Number(summary?.discipline_model_accept_count || 0),
      discipline_blocked_count: Number(summary?.discipline_blocked_count || 0),
      rule_conflict_count: Number(summary?.rule_conflict_count || 0),
      data_quality: scopeDataQuality
    },
    market_regime_buckets: regimeRows.map((row: any) => ({
      market_regime: row.market_regime || 'UNKNOWN',
      total_count: Number(row.total_count || 0),
      complete_count: Number(row.complete_count || 0),
      partial_count: Number(row.partial_count || 0),
      pending_count: Number(row.pending_count || 0),
      average_model_probability: round(row.average_model_probability, 4),
      average_direction_probability: round(row.average_direction_probability, 4),
      average_hardness_probability: round(row.average_hardness_probability, 4),
      average_raw_hardness_probability: round(row.average_raw_hardness_probability, 4),
      raw_model_accept_count: Number(row.raw_model_accept_count || 0),
      discipline_model_accept_count: Number(row.discipline_model_accept_count || 0),
      discipline_blocked_count: Number(row.discipline_blocked_count || 0),
      average_forward_return_20d: round(row.average_forward_return_20d, 2),
      average_max_drawdown: round(row.average_max_drawdown, 2),
      drawdown_discipline_hit_count: Number(row.drawdown_discipline_hit_count || 0)
    })),
    items: rows
  };
}

async function getLatestPredictionPoolSnapshot(
  db: any,
  key: ExperimentKey,
  options: { assetType?: string; limit?: number } = {}
) {
  await ensurePredictionSnapshotTables(db);
  const params: any[] = [key, 'latest_prediction_pool'];
  const clauses = ['experiment_key = ?', 'saved_from = ?'];
  if (options.assetType) {
    clauses.push('asset_type = ?');
    params.push(options.assetType);
  }
  const latestCoveredTradeDate = await getLatestCoveredTradeDate(db);
  if (latestCoveredTradeDate) {
    clauses.push('trade_date <= ?');
    params.push(latestCoveredTradeDate);
  }
  const where = clauses.join(' AND ');
  const rowWhere = clauses.map((clause) => `s.${clause}`).join(' AND ');
  const snapshotDates = await db.all(
    `SELECT asset_type, trade_date
     FROM finance_experiment_prediction_snapshots
     WHERE ${where}
     GROUP BY asset_type, trade_date
     ORDER BY asset_type ASC, trade_date DESC`,
    params
  );
  const groupedDates = snapshotDates.reduce((acc: Map<string, string[]>, row: any) => {
    const rowAssetType = String(row.asset_type || '');
    const rows = acc.get(rowAssetType) || [];
    if (row.trade_date) rows.push(String(row.trade_date));
    acc.set(rowAssetType, rows);
    return acc;
  }, new Map<string, string[]>());
  const skippedDates: any[] = [];
  const latestScopes: Array<{ asset_type: string; trade_date: string }> = [];
  for (const [scopeAssetType, tradeDates] of groupedDates.entries()) {
    let selectedDate: string | null = null;
    for (const candidateDate of tradeDates.slice(0, 10)) {
      const quality = await getSnapshotDailyCoverageQuality(db, candidateDate);
      if (quality.status !== 'incomplete') {
        selectedDate = candidateDate;
        break;
      }
      skippedDates.push({ asset_type: scopeAssetType, ...quality });
    }
    if (!selectedDate && tradeDates[0]) {
      selectedDate = tradeDates[0];
    }
    if (selectedDate) {
      latestScopes.push({ asset_type: scopeAssetType, trade_date: selectedDate });
    }
  }
  const latestTradeDate = latestScopes
    .map(scope => scope.trade_date)
    .sort()
    .slice(-1)[0] || '';
  if (!latestScopes.length || !latestTradeDate) return null;
  const scopeClause = latestScopes
    .map(() => '(s.asset_type = ? AND s.trade_date = ?)')
    .join(' OR ');
  const scopeParams = latestScopes.flatMap(scope => [scope.asset_type, scope.trade_date]);

  const limit = Math.min(Math.max(Number(options.limit || 40), 10), 120);
  const rows = await db.all(
    `SELECT
       s.id, s.experiment_key, s.symbol, s.name, s.asset_type, s.source, s.universe_type,
       s.trade_date, s.close, s.market_regime, s.experiment_score, s.rule_score,
       s.model_probability, s.model_score,
       s.direction_probability, s.direction_score,
       s.hardness_probability, s.hardness_score,
       s.raw_hardness_probability, s.raw_hardness_score,
       s.raw_model_accept, s.discipline_model_accept, s.discipline_blocked,
       s.discipline_adjustment,
       s.feature_label, s.rotation_label, s.rotation_reason,
       s.discipline_label, s.discipline_reason,
       s.crowding_label, s.crowding_reason,
       s.feature_snapshot_json, s.artifact_json, s.no_lookahead_note, s.updated_at,
       l.label_status, l.available_future_days, l.forward_return_5d, l.forward_return_10d,
       l.forward_return_20d, l.max_forward_return, l.max_drawdown, l.drawdown_discipline_hit
     FROM finance_experiment_prediction_snapshots s
     LEFT JOIN finance_experiment_prediction_labels l
       ON l.snapshot_id = s.id AND l.horizon_days = 20
     WHERE ${rowWhere} AND (${scopeClause})
     ORDER BY
       COALESCE(s.discipline_model_accept, 0) DESC,
       COALESCE(s.model_score, s.model_probability * 100, s.rule_score, s.experiment_score, 0) DESC,
       COALESCE(s.rule_score, s.experiment_score, 0) DESC,
       s.updated_at DESC,
       s.id DESC
     LIMIT ?`,
    [...params, ...scopeParams, limit]
  );

  const items: Array<Record<string, any>> = rows.map((row: any) => ({
    id: row.id,
    symbol: row.symbol,
    name: row.name || row.symbol,
    asset_type: row.asset_type || '',
    source: row.source || '',
    universe_type: row.universe_type || null,
    trade_date: row.trade_date,
    close: nullableNumber(row.close),
    market_regime: row.market_regime || 'UNKNOWN',
    experiment_score: nullableNumber(row.experiment_score),
    rule_score: nullableNumber(row.rule_score),
    model_probability: nullableNumber(row.model_probability),
    model_score: nullableNumber(row.model_score),
    direction_probability: nullableNumber(row.direction_probability),
    direction_score: nullableNumber(row.direction_score),
    hardness_probability: nullableNumber(row.hardness_probability),
    hardness_score: nullableNumber(row.hardness_score),
    raw_hardness_probability: nullableNumber(row.raw_hardness_probability),
    raw_hardness_score: nullableNumber(row.raw_hardness_score),
    raw_model_accept: Number(row.raw_model_accept || 0) === 1,
    discipline_model_accept: Number(row.discipline_model_accept || 0) === 1,
    discipline_blocked: Number(row.discipline_blocked || 0) === 1,
    discipline_adjustment: nullableNumber(row.discipline_adjustment),
    feature_label: row.feature_label || '未标注',
    rotation_label: row.rotation_label || null,
    rotation_reason: row.rotation_reason || null,
    discipline_label: row.discipline_label || null,
    discipline_reason: row.discipline_reason || null,
    crowding_label: row.crowding_label || null,
    crowding_reason: row.crowding_reason || null,
    feature_snapshot: jsonParseObject(row.feature_snapshot_json),
    no_lookahead_note: row.no_lookahead_note || '默认读取日终落库快照；手动实时计算才会现场重跑。'
  }));

  const average = (values: Array<number | null | undefined>) => {
    const filtered = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
    if (filtered.length === 0) return null;
    return round(filtered.reduce((sum, value) => sum + value, 0) / filtered.length, 2);
  };
  const market = items.reduce<Record<string, number>>((acc, item) => {
    const marketRegime = item.market_regime || 'UNKNOWN';
    acc[marketRegime] = (acc[marketRegime] || 0) + 1;
    return acc;
  }, {});
  const action = items.reduce<Record<string, number>>((acc, item) => {
    const label = item.rotation_label || item.feature_label || '未标注';
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const labelCounts = items.reduce((acc, item: any) => {
    const status = String(rows.find((row: any) => row.id === item.id)?.label_status || 'pending');
    if (status === 'complete') acc.complete_count += 1;
    else if (status === 'partial') acc.partial_count += 1;
    else acc.pending_count += 1;
    return acc;
  }, { complete_count: 0, partial_count: 0, pending_count: 0 });
  const artifactSnapshot = jsonParseObject(rows[0]?.artifact_json);

  return {
    meta: {
      key,
      title: experimentMeta[key].title,
      asset_types: experimentMeta[key].assetTypes,
      latest_price_date: latestTradeDate,
      as_of_date: latestTradeDate,
      asset_trade_dates: latestScopes,
      data_quality: {
        scope: 'latest_prediction_pool',
        skipped_dates: skippedDates
      },
      replay_mode: false,
      snapshot_mode: true,
      data_source: 'latest_prediction_pool_snapshot',
      last_saved_at: rows[0]?.updated_at || null,
      outcome_horizon_days: 20,
      no_lookahead_rule: '默认读取日终落库快照，不现场重跑；手动实时计算才刷新当前截面。'
    },
    summary: {
      item_count: items.length,
      average_score: average(items.map((item) => item.rule_score ?? item.experiment_score)),
      average_model_score: average(items.map((item) => item.model_score ?? (item.model_probability !== null && item.model_probability !== undefined ? item.model_probability * 100 : null))),
      market,
      action,
      ...labelCounts,
      raw_model_accept_count: items.filter((item) => item.raw_model_accept).length,
      discipline_model_accept_count: items.filter((item) => item.discipline_model_accept).length,
      discipline_blocked_count: items.filter((item) => item.discipline_blocked).length,
      average_forward_return_20d: average(rows.map((row: any) => nullableNumber(row.forward_return_20d))),
      fail_line_rate: (() => {
        const labeled = rows.filter((row: any) => (
          String(row.label_status || 'pending') !== 'pending'
          && Number(row.available_future_days || 0) > 0
          && row.drawdown_discipline_hit !== null
          && row.drawdown_discipline_hit !== undefined
        ));
        if (!labeled.length) return null;
        return round(labeled.filter((row: any) => Number(row.drawdown_discipline_hit || 0) === 1).length / labeled.length, 4);
      })()
    },
    artifact: artifactSnapshot.artifact || null,
    direction_artifact: artifactSnapshot.direction_artifact || null,
    hardness_artifact: artifactSnapshot.hardness_artifact || null,
    split_model: Boolean(artifactSnapshot.split_model),
    items
  };
}

const CAPITAL_ROTATION_AI_TERMS = [
  'CPO', '光模块', '光通信', '通信', '算力', '云计算', '数据中心', '人工智能',
  'AI', '科创AI', '半导体', '芯片', '半导体设备', '软件', '计算机', '机器人'
];

const CAPITAL_ROTATION_FOCUS_TERMS = [
  '电力', '存储', 'CPO', '光模块', '光通信', '通信', '算力', '云计算', '数据中心',
  '半导体', '芯片', '半导体设备', '人工智能', 'AI', '新能源'
];

const capitalRotationScopeMatches = (item: any, scope: 'focus' | 'all' | 'ai') => {
  if (scope === 'all') return true;
  const name = String(item.name || '');
  const universeType = String(item.universe_type || item.feature_snapshot?.universe_type || '');
  if (scope === 'ai') {
    return CAPITAL_ROTATION_AI_TERMS.some(term => name.includes(term));
  }
  return universeType === 'industry_etf' || CAPITAL_ROTATION_FOCUS_TERMS.some(term => name.includes(term));
};

async function getCapitalRotationDirectionBoardSnapshot(
  db: any,
  scope: 'focus' | 'all' | 'ai',
  limit: number
) {
  const snapshot = await getLatestPredictionPoolSnapshot(db, 'capital-rotation', {
    assetType: 'etf',
    limit: 120
  });
  const sourceItems = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const items = sourceItems
    .filter(item => capitalRotationScopeMatches(item, scope))
    .slice(0, limit)
    .map((item: any) => {
      const featureSnapshot = item.feature_snapshot || {};
      return {
        ...item,
        trend_phase_code: featureSnapshot.trend_phase_code || item.trend_phase_code || 'UNKNOWN',
        ret20: nullableNumber(featureSnapshot.ret20),
        ret60: nullableNumber(featureSnapshot.ret60),
        ret120: nullableNumber(featureSnapshot.ret120),
        relative_ret20_hs300: nullableNumber(featureSnapshot.relative_ret20_hs300),
        relative_ret60_hs300: nullableNumber(featureSnapshot.relative_ret60_hs300),
        relative_ret120_hs300: nullableNumber(featureSnapshot.relative_ret120_hs300),
        amount_ratio_5_20: nullableNumber(featureSnapshot.amount_ratio_5_20),
        amount_ratio_20_60: nullableNumber(featureSnapshot.amount_ratio_20_60),
        breadth_above_ma60_ratio: nullableNumber(featureSnapshot.breadth_above_ma60_ratio),
        breadth_down_ratio: nullableNumber(featureSnapshot.breadth_down_ratio),
        distance_ma60: nullableNumber(featureSnapshot.distance_ma60 ?? featureSnapshot.bias60),
        distance_ma120: nullableNumber(featureSnapshot.distance_ma120),
        price_pos120: nullableNumber(featureSnapshot.price_pos120)
      };
    });

  return {
    artifact: snapshot?.direction_artifact || snapshot?.artifact || null,
    direction_artifact: snapshot?.direction_artifact || snapshot?.artifact || null,
    hardness_artifact: snapshot?.hardness_artifact || null,
    split_model: Boolean(snapshot?.split_model),
    latest_date: snapshot?.meta?.latest_price_date || null,
    last_saved_at: snapshot?.meta?.last_saved_at || null,
    scope,
    total: items.length,
    data_source: 'latest_prediction_pool_snapshot',
    snapshot_mode: true,
    items
  };
}

async function getPredictionReplaySnapshot(
  db: any,
  key: ExperimentKey,
  options: { asOfDate: string; assetType?: string; limit?: number; horizonDays?: number }
) {
  await ensurePredictionSnapshotTables(db);
  const horizonDays = Math.min(Math.max(Number(options.horizonDays || 20), 5), 60);
  const limit = Math.min(Math.max(Number(options.limit || 10), 5), 120);
  const params: any[] = [key, options.asOfDate];
  const clauses = ['s.experiment_key = ?', 's.trade_date = ?'];
  if (options.assetType) {
    clauses.push('s.asset_type = ?');
    params.push(options.assetType);
  }
  const rows = await db.all(
    `SELECT
       s.id, s.experiment_key, s.symbol, s.name, s.asset_type, s.source, s.universe_type,
       s.trade_date, s.close, s.market_regime, s.experiment_score, s.rule_score,
       s.model_probability, s.model_score,
       s.direction_probability, s.direction_score,
       s.hardness_probability, s.hardness_score,
       s.raw_hardness_probability, s.raw_hardness_score,
       s.raw_model_accept, s.discipline_model_accept, s.discipline_blocked,
       s.discipline_adjustment,
       s.feature_label, s.rotation_label, s.rotation_reason,
       s.discipline_label, s.discipline_reason,
       s.crowding_label, s.crowding_reason,
       s.feature_snapshot_json, s.artifact_json, s.no_lookahead_note,
       s.saved_from, s.updated_at,
       l.available_future_days, l.horizon_end_date,
       l.forward_return_5d, l.forward_return_10d, l.forward_return_20d,
       l.max_forward_return, l.max_drawdown, l.drawdown_discipline_hit,
       l.direction_outcome, l.hardness_outcome, l.label_status, l.label_reason
     FROM finance_experiment_prediction_snapshots s
     LEFT JOIN finance_experiment_prediction_labels l
       ON l.snapshot_id = s.id AND l.horizon_days = ?
     WHERE ${clauses.join(' AND ')}
     ORDER BY
       CASE s.saved_from
         WHEN 'risk_crash_backfill' THEN 1
         WHEN 'latest_prediction_pool' THEN 2
         ELSE 9
       END,
       COALESCE(s.discipline_model_accept, 0) DESC,
       COALESCE(s.model_score, s.model_probability * 100, s.rule_score, s.experiment_score, 0) DESC,
       COALESCE(s.rule_score, s.experiment_score, 0) DESC,
       s.updated_at DESC,
       s.id DESC
     LIMIT ?`,
    [horizonDays, ...params, limit]
  );
  if (!rows.length) return null;

  const items: any[] = rows.map((row: any) => ({
    id: row.id,
    symbol: row.symbol,
    name: row.name || row.symbol,
    asset_type: row.asset_type || '',
    source: row.source || '',
    universe_type: row.universe_type || null,
    trade_date: row.trade_date,
    close: nullableNumber(row.close),
    market_regime: row.market_regime || 'UNKNOWN',
    experiment_score: nullableNumber(row.experiment_score),
    rule_score: nullableNumber(row.rule_score),
    model_probability: nullableNumber(row.model_probability),
    model_score: nullableNumber(row.model_score),
    direction_probability: nullableNumber(row.direction_probability),
    direction_score: nullableNumber(row.direction_score),
    hardness_probability: nullableNumber(row.hardness_probability),
    hardness_score: nullableNumber(row.hardness_score),
    raw_hardness_probability: nullableNumber(row.raw_hardness_probability),
    raw_hardness_score: nullableNumber(row.raw_hardness_score),
    raw_model_accept: Number(row.raw_model_accept || 0) === 1,
    discipline_model_accept: Number(row.discipline_model_accept || 0) === 1,
    discipline_blocked: Number(row.discipline_blocked || 0) === 1,
    discipline_adjustment: nullableNumber(row.discipline_adjustment),
    feature_label: row.feature_label || '未标注',
    rotation_label: row.rotation_label || null,
    rotation_reason: row.rotation_reason || null,
    discipline_label: row.discipline_label || null,
    discipline_reason: row.discipline_reason || null,
    crowding_label: row.crowding_label || null,
    crowding_reason: row.crowding_reason || null,
    feature_snapshot: jsonParseObject(row.feature_snapshot_json),
    future_label: {
      horizon_days: horizonDays,
      available_future_days: Number(row.available_future_days || 0),
      horizon_end_date: row.horizon_end_date || null,
      label_status: row.label_status || 'pending',
      forward_return_5d: nullableNumber(row.forward_return_5d),
      forward_return_10d: nullableNumber(row.forward_return_10d),
      forward_return_20d: nullableNumber(row.forward_return_20d),
      max_forward_return: nullableNumber(row.max_forward_return),
      max_drawdown: nullableNumber(row.max_drawdown),
      drawdown_discipline_hit: Number(row.drawdown_discipline_hit || 0) === 1,
      direction_outcome: row.direction_outcome || null,
      hardness_outcome: row.hardness_outcome || null,
      label_reason: row.label_reason || '快照后验标签尚未刷新'
    },
    saved_from: row.saved_from || null,
    no_lookahead_note: row.no_lookahead_note || `历史截面快照只使用 ${row.trade_date} 及以前数据；未来收益只作为后验标签。`
  }));

  const average = (values: Array<number | null | undefined>) => {
    const filtered = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
    if (!filtered.length) return null;
    return round(filtered.reduce((sum, value) => sum + value, 0) / filtered.length, 2);
  };
  const completeItems = items.filter(item => item.future_label.label_status === 'complete');
  const outcomeItems = items.filter(item => item.future_label.label_status !== 'pending');
  const winItems = completeItems.filter(item => (
    item.future_label.forward_return_20d !== null
    && item.future_label.forward_return_20d !== undefined
    && item.future_label.forward_return_20d > 0
  ));
  const failedItems = outcomeItems.filter(item => item.future_label.drawdown_discipline_hit);
  const market = items.reduce<Record<string, number>>((acc, item) => {
    const marketRegime = item.market_regime || 'UNKNOWN';
    acc[marketRegime] = (acc[marketRegime] || 0) + 1;
    return acc;
  }, {});
  const action = items.reduce<Record<string, number>>((acc, item) => {
    const label = item.rotation_label || item.feature_label || '未标注';
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const artifactSnapshot = jsonParseObject(rows[0]?.artifact_json);

  return {
    meta: {
      key,
      title: experimentMeta[key].title,
      asset_types: experimentMeta[key].assetTypes,
      latest_price_date: options.asOfDate,
      as_of_date: options.asOfDate,
      replay_mode: true,
      snapshot_mode: true,
      data_source: 'prediction_replay_snapshot',
      saved_from: rows[0]?.saved_from || null,
      last_saved_at: rows[0]?.updated_at || null,
      outcome_horizon_days: horizonDays,
      no_lookahead_rule: '优先读取已落库历史截面快照；快照不存在时不会现场重算，只有强制实时重算才跑 worker。'
    },
    artifact: artifactSnapshot.artifact || null,
    direction_artifact: artifactSnapshot.direction_artifact || null,
    hardness_artifact: artifactSnapshot.hardness_artifact || null,
    split_model: Boolean(artifactSnapshot.split_model),
    summary: {
      item_count: items.length,
      average_score: average(items.map(item => item.rule_score ?? item.experiment_score)),
      average_model_score: average(items.map(item => item.model_score ?? (item.model_probability !== null && item.model_probability !== undefined ? item.model_probability * 100 : null))),
      market,
      action,
      raw_model_accept_count: items.filter(item => item.raw_model_accept).length,
      discipline_model_accept_count: items.filter(item => item.discipline_model_accept).length,
      discipline_blocked_count: items.filter(item => item.discipline_blocked).length,
      complete_count: completeItems.length,
      partial_count: items.filter(item => item.future_label.label_status === 'partial').length,
      pending_count: items.filter(item => item.future_label.label_status === 'pending').length,
      win_rate_20d: completeItems.length ? round(winItems.length / completeItems.length * 100, 2) : null,
      average_forward_return_20d: average(completeItems.map(item => item.future_label.forward_return_20d)),
      fail_line_rate: outcomeItems.length ? round(failedItems.length / outcomeItems.length * 100, 2) : null
    },
    items
  };
}

const getBestExperimentArtifact = (artifacts: any[]) => artifacts.reduce((best: any, artifact: any) => {
  const score = artifact.test_auc ?? artifact.validation_auc ?? -1;
  const bestScore = best ? (best.test_auc ?? best.validation_auc ?? -1) : -1;
  return score > bestScore ? artifact : best;
}, null);

const getExperimentNextAction = (
  modelSummary: Awaited<ReturnType<typeof getExperimentModelSummary>>,
  snapshotSummary: {
    total_count: number;
    complete_count: number;
    partial_count?: number;
    pending_count: number;
  },
  marketBuckets: Array<{ market_regime: string; total_count: number; complete_count: number }>
) => {
  if (!modelSummary.run) return '先训练模型';
  if (modelSummary.run.status !== 'completed') return '等待训练完成';
  if (snapshotSummary.total_count === 0) return '保存预测池';
  if (snapshotSummary.complete_count === 0) return '等待20日后验';
  const riskComplete = marketBuckets
    .filter(bucket => bucket.market_regime === 'RISK' || bucket.market_regime === 'CRASH')
    .reduce((sum, bucket) => sum + bucket.complete_count, 0);
  if (riskComplete < 20) return '补风险样本';
  if (snapshotSummary.pending_count > snapshotSummary.complete_count) return '继续滚标签';
  return '复盘验收';
};

const buildExperimentAcceptanceEvidence = (
  snapshotSummary: {
    total_count: number;
    complete_count: number;
    partial_count?: number;
    pending_count: number;
  },
  marketBuckets: Array<{ market_regime: string; complete_count: number }>
) => {
  const total = Number(snapshotSummary.total_count || 0);
  const complete = Number(snapshotSummary.complete_count || 0);
  const pending = Number(snapshotSummary.pending_count || 0);
  const completion_rate = total > 0 ? round(complete / total * 100, 2) : null;
  const risk_crash_complete_count = marketBuckets
    .filter(bucket => bucket.market_regime === 'RISK' || bucket.market_regime === 'CRASH')
    .reduce((sum, bucket) => sum + Number(bucket.complete_count || 0), 0);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (total <= 0) blockers.push('缺少最新预测池快照。');
  if (total > 0 && complete <= 0) blockers.push('最新预测池尚无20日后验完成样本。');
  if (complete > 0 && complete < 20) blockers.push(`20日后验完成样本只有 ${complete} 条，低于 20 条最低验收线。`);
  if (completion_rate !== null && completion_rate < 30) warnings.push(`20日后验覆盖率 ${completion_rate}%，当前市场证据仍偏薄。`);
  if (risk_crash_complete_count < 20) warnings.push(`RISK/CRASH 后验样本 ${risk_crash_complete_count} 条，弱市证据不足。`);

  return {
    status: blockers.length ? 'blocked' : warnings.length ? 'warning' : 'usable',
    total_count: total,
    complete_count: complete,
    pending_count: pending,
    completion_rate,
    risk_crash_complete_count,
    blockers,
    warnings
  };
};

const getExperimentCandidateAuxiliary = (
  modelSummary: Awaited<ReturnType<typeof getExperimentModelSummary>>,
  snapshotSummary: {
    total_count: number;
    complete_count: number;
    pending_count: number;
    rule_conflict_count?: number;
    discipline_model_accept_count?: number;
  },
  marketBuckets: Array<{ market_regime: string; complete_count: number }>,
  acceptanceEvidence = buildExperimentAcceptanceEvidence(snapshotSummary, marketBuckets)
) => {
  if (!modelSummary.run) {
    return { allowed: false, label: '不可辅助', reason: '模型尚未训练完成。' };
  }
  if (modelSummary.run.status !== 'completed') {
    return { allowed: false, label: '等待训练', reason: '训练任务还没有完成。' };
  }
  if (snapshotSummary.total_count <= 0) {
    return { allowed: false, label: '缺预测池', reason: '还没有最新预测池快照。' };
  }
  if (snapshotSummary.complete_count <= 0) {
    return { allowed: false, label: '等后验', reason: '20日后验尚未完成，不能进入候选辅助。' };
  }
  if (acceptanceEvidence.blockers.length > 0) {
    return { allowed: false, label: '证据不足', reason: acceptanceEvidence.blockers.join('；') };
  }

  const riskComplete = marketBuckets
    .filter(bucket => bucket.market_regime === 'RISK' || bucket.market_regime === 'CRASH')
    .reduce((sum, bucket) => sum + bucket.complete_count, 0);
  if (riskComplete < 20) {
    return { allowed: false, label: '补风险样本', reason: 'RISK/CRASH 后验样本不足，先补弱市和冻结区。' };
  }

  const conflictCount = Number(snapshotSummary.rule_conflict_count || 0);
  const acceptedCount = Number(snapshotSummary.discipline_model_accept_count || 0);
  if (conflictCount > Math.max(acceptedCount, 3)) {
    return { allowed: false, label: '先复盘冲突', reason: '模型认可但被规则/纪律拦截的样本偏多。' };
  }

  return { allowed: true, label: '可候选辅助', reason: '只允许做候选辅助评分，不给开仓许可。' };
};

const normalizeRiskCrashRegime = (value: string | null | undefined): RiskCrashRegime | null => {
  const normalized = classifyMarket(value);
  if (normalized === 'CRASH') return 'CRASH';
  if (normalized === 'RISK') return 'RISK';
  return null;
};

const parseDateTime = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, (month || 1) - 1, day || 1);
};

const dateDistanceDays = (left: string, right: string) => (
  Math.abs(parseDateTime(left) - parseDateTime(right)) / 86400000
);

const getBackfillCutoffDate = async (db: any, horizonDays: number) => {
  const row = await db.get(
    `SELECT trade_date
     FROM (
       SELECT DISTINCT trade_date
       FROM financial_daily_prices
       WHERE symbol = '000300' AND close IS NOT NULL AND close > 0
       ORDER BY trade_date DESC
       LIMIT ?
     )
     ORDER BY trade_date ASC
     LIMIT 1`,
    [horizonDays + 1]
  );
  return row?.trade_date ? String(row.trade_date) : null;
};

const getTableRiskCrashCandidates = async (db: any, cutoffDate: string | null): Promise<RiskCrashBackfillCandidate[]> => {
  const params: any[] = [];
  const cutoffClause = cutoffDate ? 'AND trade_date <= ?' : '';
  if (cutoffDate) params.push(cutoffDate);
  const rows = await db.all(
    `WITH ranked_regimes AS (
       SELECT
         trade_date,
         market_regime AS raw_regime,
         COUNT(*) OVER (PARTITION BY trade_date) AS row_count,
         ROW_NUMBER() OVER (
           PARTITION BY trade_date
           ORDER BY id DESC
         ) AS rn
       FROM financial_market_regime
       WHERE symbol = '000300' ${cutoffClause}
     )
     SELECT trade_date, raw_regime, row_count
     FROM ranked_regimes
     WHERE rn = 1
     ORDER BY trade_date DESC`,
    params
  );

  return rows.flatMap((row: any) => {
    const regime = normalizeRiskCrashRegime(row.raw_regime);
    if (!regime) return [];
    const tradeDate = String(row.trade_date);
    return [{
      trade_date: tradeDate,
      year: tradeDate.slice(0, 4),
      market_regime: regime,
      raw_regime: String(row.raw_regime || regime),
      candidate_source: 'financial_market_regime' as const,
      row_count: Number(row.row_count || 0)
    }];
  });
};

const getDerivedRiskCrashCandidates = async (db: any, cutoffDate: string | null): Promise<RiskCrashBackfillCandidate[]> => {
  const params: any[] = [];
  const cutoffClause = cutoffDate ? 'AND trade_date <= ?' : '';
  if (cutoffDate) params.push(cutoffDate);
  const rows = await db.all(
    `WITH ranked_prices AS (
       SELECT trade_date, open, high, low, close, amount, volume,
         ROW_NUMBER() OVER (
           PARTITION BY trade_date
           ORDER BY CASE source WHEN 'tushare' THEN 0 WHEN 'akshare' THEN 1 ELSE 2 END
         ) AS rn
       FROM financial_daily_prices
       WHERE symbol = '000300' ${cutoffClause} AND close IS NOT NULL AND close > 0
     )
     SELECT trade_date, open, high, low, close, amount, volume
     FROM ranked_prices
     WHERE rn = 1
     ORDER BY trade_date ASC`,
    params
  );
  const prices: DailyPrice[] = rows.map((item: any) => ({
    trade_date: String(item.trade_date),
    open: nullableNumber(item.open),
    high: nullableNumber(item.high),
    low: nullableNumber(item.low),
    close: Number(item.close),
    amount: nullableNumber(item.amount),
    volume: nullableNumber(item.volume)
  }));

  const candidates: RiskCrashBackfillCandidate[] = [];
  for (let index = 119; index < prices.length; index++) {
    const tradeDate = prices[index].trade_date;
    const regime = normalizeRiskCrashRegime(calculateHistoricalMarketRegime(prices.slice(0, index + 1)));
    if (!regime) continue;
    candidates.push({
      trade_date: tradeDate,
      year: tradeDate.slice(0, 4),
      market_regime: regime,
      raw_regime: regime,
      candidate_source: 'derived_hs300_daily',
      row_count: 1
    });
  }
  return candidates.sort((a, b) => b.trade_date.localeCompare(a.trade_date));
};

const getRiskCrashCandidateUniverse = async (db: any, horizonDays = 20) => {
  const cutoffDate = await getBackfillCutoffDate(db, horizonDays);
  const tableCandidates = await getTableRiskCrashCandidates(db, cutoffDate);
  const derivedCandidates = tableCandidates.length > 0 ? [] : await getDerivedRiskCrashCandidates(db, cutoffDate);
  const candidates = tableCandidates.length > 0 ? tableCandidates : derivedCandidates;
  const candidateBuckets = candidates.reduce<Record<string, {
    year: string;
    market_regime: RiskCrashRegime;
    count: number;
    first_date: string;
    last_date: string;
  }>>((acc, item) => {
    const key = `${item.year}-${item.market_regime}`;
    const existing = acc[key];
    if (!existing) {
      acc[key] = {
        year: item.year,
        market_regime: item.market_regime,
        count: 1,
        first_date: item.trade_date,
        last_date: item.trade_date
      };
      return acc;
    }
    existing.count += 1;
    existing.first_date = item.trade_date < existing.first_date ? item.trade_date : existing.first_date;
    existing.last_date = item.trade_date > existing.last_date ? item.trade_date : existing.last_date;
    return acc;
  }, {});

  return {
    cutoff_date: cutoffDate,
    candidate_source: tableCandidates.length > 0 ? 'financial_market_regime' : 'derived_hs300_daily',
    table_candidate_count: tableCandidates.length,
    derived_candidate_count: derivedCandidates.length,
    candidate_count: candidates.length,
    candidate_buckets: Object.values(candidateBuckets).sort((a, b) => (
      b.year.localeCompare(a.year) || a.market_regime.localeCompare(b.market_regime)
    )),
    candidates
  };
};

const sampleRiskCrashCandidates = (
  candidates: RiskCrashBackfillCandidate[],
  options: { maxDates: number; perRegimeYear: number; minGapDays: number }
) => {
  const grouped = candidates.reduce<Record<string, RiskCrashBackfillCandidate[]>>((acc, item) => {
    const key = `${item.year}-${item.market_regime}`;
    acc[key] = acc[key] || [];
    acc[key].push(item);
    return acc;
  }, {});

  const groupedSamples = Object.values(grouped).flatMap((items) => {
    const selected: RiskCrashBackfillCandidate[] = [];
    [...items].sort((a, b) => b.trade_date.localeCompare(a.trade_date)).forEach((item) => {
      if (selected.length >= options.perRegimeYear) return;
      if (selected.every(existing => dateDistanceDays(existing.trade_date, item.trade_date) >= options.minGapDays)) {
        selected.push(item);
      }
    });
    return selected;
  }).sort((a, b) => b.trade_date.localeCompare(a.trade_date));

  const selected: RiskCrashBackfillCandidate[] = [];
  groupedSamples.forEach((item) => {
    if (selected.length >= options.maxDates) return;
    if (selected.every(existing => dateDistanceDays(existing.trade_date, item.trade_date) >= options.minGapDays)) {
      selected.push(item);
    }
  });
  return selected;
};

const getRiskCrashBackfillExistingKeys = async (db: any) => {
  await ensurePredictionSnapshotTables(db);
  const rows = await db.all(
    `SELECT DISTINCT
       trade_date,
       COALESCE(market_regime, 'UNKNOWN') AS market_regime
     FROM finance_experiment_prediction_snapshots
     WHERE saved_from = 'risk_crash_backfill'
       AND trade_date IS NOT NULL`
  );
  return new Set<string>(
    rows.map((row: any) => `${String(row.trade_date)}-${classifyMarket(row.market_regime)}`)
  );
};

const getRiskCrashBackfillExistingDates = async (db: any): Promise<Array<{
  trade_date: string;
  market_regime: RiskCrashRegime;
}>> => {
  await ensurePredictionSnapshotTables(db);
  const rows = await db.all(
    `SELECT DISTINCT
       trade_date,
       COALESCE(market_regime, 'UNKNOWN') AS market_regime
     FROM finance_experiment_prediction_snapshots
     WHERE saved_from = 'risk_crash_backfill'
       AND trade_date IS NOT NULL`
  );
  return rows.flatMap((row: any) => {
    const marketRegime = normalizeRiskCrashRegime(row.market_regime);
    if (!marketRegime) return [];
    return [{
      trade_date: String(row.trade_date),
      market_regime: marketRegime
    }];
  });
};

const filterRiskCrashExistingCandidates = (
  candidates: RiskCrashBackfillCandidate[],
  existingKeys: Set<string>,
  options?: {
    existingDates?: Array<{ trade_date: string; market_regime: RiskCrashRegime }>;
    minGapDays?: number;
  }
) => candidates.filter((item) => {
  if (existingKeys.has(`${item.trade_date}-${classifyMarket(item.market_regime)}`)) return false;
  const minGapDays = options?.minGapDays || 0;
  if (!options?.existingDates || minGapDays <= 0) return true;
  return options.existingDates.every((existing) => (
    existing.market_regime !== item.market_regime
    || dateDistanceDays(existing.trade_date, item.trade_date) >= minGapDays
  ));
});

const percentPointValue = (value: any) => {
  const numeric = nullableNumber(value);
  if (numeric === null) return null;
  return Math.abs(numeric) <= 1.5 ? numeric * 100 : numeric;
};

const ratioChangeValue = (value: any) => {
  const numeric = nullableNumber(value);
  if (numeric === null) return null;
  return numeric > 0.35 ? numeric - 1 : numeric;
};

const getRiskWeakTargetFlags = (sample: {
  market_regime?: string | null;
  breadth_above_ma60_ratio?: number | null;
  relative_ret20_hs300?: number | null;
  relative_ret60_hs300?: number | null;
  amount_ratio_5_20?: number | null;
}) => {
  const marketRegime = classifyMarket(sample.market_regime);
  const breadthPct = percentPointValue(sample.breadth_above_ma60_ratio);
  const relative20Pct = percentPointValue(sample.relative_ret20_hs300);
  const relative60Pct = percentPointValue(sample.relative_ret60_hs300);
  const amountChange = ratioChangeValue(sample.amount_ratio_5_20);
  const weakBreadth = marketRegime === 'RISK' && breadthPct !== null && breadthPct > 0 && breadthPct <= 45;
  const weakRelativeHs300 = marketRegime === 'RISK' && (
    (relative20Pct !== null && relative20Pct <= -3)
    || (relative60Pct !== null && relative60Pct <= -5)
  );
  const weakAmount = marketRegime === 'RISK' && amountChange !== null && amountChange <= -0.2;
  const labels: string[] = [];
  if (weakBreadth) labels.push('市场广度弱');
  if (weakRelativeHs300) labels.push('相对沪深300弱');
  if (weakAmount) labels.push('缩量承接不足');
  return {
    weak_breadth: weakBreadth,
    weak_relative_hs300: weakRelativeHs300,
    weak_amount: weakAmount,
    hit_count: labels.length,
    labels,
    normalized: {
      breadth_above_ma60_pct: round(breadthPct, 2),
      relative_ret20_hs300_pct: round(relative20Pct, 2),
      relative_ret60_hs300_pct: round(relative60Pct, 2),
      amount_ratio_5_20_change: round(amountChange, 4)
    }
  };
};

const getRiskWeakTargetFlagsFromSnapshot = (featureSnapshot: Record<string, any>, marketRegime?: string | null) => getRiskWeakTargetFlags({
  market_regime: marketRegime || featureSnapshot.market_regime,
  breadth_above_ma60_ratio: getFeatureValue(featureSnapshot, ['breadth_above_ma60_ratio']),
  relative_ret20_hs300: getFeatureValue(featureSnapshot, ['relative_ret20_hs300', 'sector_relative_ret20_hs300']),
  relative_ret60_hs300: getFeatureValue(featureSnapshot, ['relative_ret60_hs300', 'sector_relative_ret60_hs300']),
  amount_ratio_5_20: getFeatureValue(featureSnapshot, ['amount_ratio_5_20', 'sector_amount_ratio_5_20'])
});

const summarizeRiskCrashDeceptionReview = (reviewed: any[]) => {
  const deceptionSamples = reviewed.filter(sample => sample.deception_type);
  const categories = [
    {
      key: 'risk_model_double_high_false_positive',
      name: 'RISK 双高误判',
      rule: '风险区里方向分高、承接分也不低，但后续亏损或回撤纪律打穿。',
      action: '提高 RISK 下承接门槛，把高分但弱路径样本喂给硬度模型。'
    },
    {
      key: 'crash_high_score_false_positive',
      name: 'CRASH 高分打脸',
      rule: '冻结区里模型仍给高分，但后续方向不兑现或过程击穿纪律。',
      action: 'CRASH 总闸不放承接口，只训练反抽识别和风险解释。'
    },
    {
      key: 'direction_ok_broken_path',
      name: '方向对但路径打穿',
      rule: '未来最大涨幅/20日结果能兑现，但中途最大回撤已经洗出纪律线。',
      action: '方向正例、承接负例，专门训练“能不能扛得住”。'
    },
    {
      key: 'positive_20d_broken_path',
      name: '20日为正但中途洗穿',
      rule: '最终 20 日收益为正，但过程打穿风险区回撤纪律。',
      action: '不能算承接成功，防止后验结果美化真实持仓体验。'
    }
  ].map((category) => {
    const samples = deceptionSamples.filter(sample => sample.deception_type === category.key);
    return {
      ...category,
      count: samples.length,
      samples: samples.slice(0, 8)
    };
  });

  const patternDefinitions = [
    {
      key: 'high_position_or_chase',
      name: '高位/追高容易骗分',
      rule: '120日位置偏高、MA60 偏离偏大或20日涨幅偏热时，方向分容易盖住回撤风险。',
      hit: (sample: any) => (
        (sample.price_pos120 !== null && sample.price_pos120 >= 0.75)
        || (sample.distance_ma60 !== null && sample.distance_ma60 >= 0.08)
        || (sample.ret20 !== null && sample.ret20 >= 0.12)
      )
    },
    {
      key: 'weak_amount_acceptance',
      name: '量能承接不足',
      rule: '5/20 成交额比偏弱时，反弹有方向但容易没有硬承接。',
      hit: (sample: any) => Boolean(sample.risk_target_flags?.weak_amount)
    },
    {
      key: 'weak_breadth',
      name: '市场广度偏弱',
      rule: '广度低时，高分标的更容易只是局部反抽，不适合直接放行。',
      hit: (sample: any) => Boolean(sample.risk_target_flags?.weak_breadth)
    },
    {
      key: 'weak_relative_hs300',
      name: '相对沪深300偏弱',
      rule: '风险区里连沪深300都跑不赢时，方向分更容易只是弱修复假象。',
      hit: (sample: any) => Boolean(sample.risk_target_flags?.weak_relative_hs300)
    },
    {
      key: 'score_masks_path',
      name: '方向分遮住路径风险',
      rule: '模型分高且方向对，但回撤纪律打穿，说明“会涨”和“能拿”必须拆开。',
      hit: (sample: any) => sample.high_score && sample.direction_ok_broken
    },
    {
      key: 'risk_crash_context',
      name: '风险区总闸必须前置',
      rule: 'RISK/CRASH 里高分不等于可承接，先看市场层，再看单标的。',
      hit: (sample: any) => ['RISK', 'CRASH'].includes(sample.market_regime) && sample.high_score
    }
  ];

  return {
    note: '这里抓的是模型最容易被后验结果骗的样本：方向可能对，但路径、承接和风险区纪律不允许直接放行。',
    totals: {
      total_count: deceptionSamples.length,
      risk_model_double_high_false_positive_count: categories.find(item => item.key === 'risk_model_double_high_false_positive')?.count || 0,
      crash_high_score_false_positive_count: categories.find(item => item.key === 'crash_high_score_false_positive')?.count || 0,
      direction_ok_broken_path_count: categories.find(item => item.key === 'direction_ok_broken_path')?.count || 0,
      positive_20d_broken_path_count: categories.find(item => item.key === 'positive_20d_broken_path')?.count || 0
    },
    categories,
    patterns: patternDefinitions.map((pattern) => {
      const hitCount = deceptionSamples.filter(pattern.hit).length;
      return {
        key: pattern.key,
        name: pattern.name,
        hit_count: hitCount,
        hit_rate: deceptionSamples.length ? round(hitCount / deceptionSamples.length * 100, 2) : null,
        rule: pattern.rule
      };
    }),
    samples: [...deceptionSamples].sort((a, b) => {
      const priorityDelta = (b.deception_priority || 0) - (a.deception_priority || 0);
      if (priorityDelta) return priorityDelta;
      const drawdownDelta = (a.max_drawdown ?? 0) - (b.max_drawdown ?? 0);
      if (drawdownDelta) return drawdownDelta;
      return (b.score ?? 0) - (a.score ?? 0);
    }).slice(0, 80)
  };
};

async function getRiskCrashBackfillSnapshotSummary(db: any) {
  await ensurePredictionSnapshotTables(db);
  const rows = await db.all(
    `SELECT
       s.experiment_key,
       COALESCE(s.market_regime, 'UNKNOWN') AS market_regime,
       COUNT(*) AS total_count,
       SUM(CASE WHEN COALESCE(l.label_status, 'pending') = 'complete' THEN 1 ELSE 0 END) AS complete_count,
       SUM(CASE WHEN COALESCE(l.label_status, 'pending') = 'partial' THEN 1 ELSE 0 END) AS partial_count,
       SUM(CASE WHEN COALESCE(l.label_status, 'pending') = 'pending' THEN 1 ELSE 0 END) AS pending_count,
       AVG(s.model_probability) AS average_model_probability,
       AVG(s.direction_probability) AS average_direction_probability,
       AVG(s.hardness_probability) AS average_hardness_probability,
       AVG(l.forward_return_20d) AS average_forward_return_20d,
       AVG(l.max_drawdown) AS average_max_drawdown,
       SUM(CASE
         WHEN COALESCE(l.label_status, 'pending') = 'complete'
          AND COALESCE(l.max_drawdown, 0) <= CASE WHEN COALESCE(s.market_regime, 'UNKNOWN') = 'RISK' THEN -6 ELSE -8 END
         THEN 1
         ELSE 0
       END) AS drawdown_discipline_hit_count,
       SUM(CASE
         WHEN COALESCE(s.direction_score, s.model_score, s.rule_score, s.experiment_score, 0) >= 70 THEN 1
         ELSE 0
       END) AS high_score_count,
       SUM(CASE
         WHEN COALESCE(s.direction_score, s.model_score, s.rule_score, s.experiment_score, 0) >= 70
          AND COALESCE(l.label_status, 'pending') = 'complete'
          AND (
            COALESCE(l.forward_return_20d, -999) < 0
            OR COALESCE(l.max_drawdown, 0) <= CASE WHEN COALESCE(s.market_regime, 'UNKNOWN') = 'RISK' THEN -6 ELSE -8 END
            OR l.drawdown_discipline_hit = 1
          )
         THEN 1
         ELSE 0
       END) AS high_score_false_positive_count,
       SUM(CASE
         WHEN COALESCE(s.direction_score, s.model_score, s.rule_score, s.experiment_score, 0) >= 70
          AND COALESCE(l.label_status, 'pending') = 'complete'
          AND (
            l.direction_outcome LIKE '%兑现%'
            OR l.direction_outcome LIKE '%有效%'
            OR COALESCE(l.forward_return_20d, -999) > 0
          )
         THEN 1
         ELSE 0
       END) AS high_score_direction_hit_count
     FROM finance_experiment_prediction_snapshots s
     LEFT JOIN finance_experiment_prediction_labels l
       ON l.snapshot_id = s.id AND l.horizon_days = 20
     WHERE s.saved_from = 'risk_crash_backfill'
       AND COALESCE(s.market_regime, 'UNKNOWN') IN ('RISK', 'CRASH')
     GROUP BY s.experiment_key, COALESCE(s.market_regime, 'UNKNOWN')
     ORDER BY s.experiment_key,
       CASE COALESCE(s.market_regime, 'UNKNOWN') WHEN 'RISK' THEN 1 WHEN 'CRASH' THEN 2 ELSE 9 END`
  );

  const totals = rows.reduce((acc: any, row: any) => {
    acc.total_count += Number(row.total_count || 0);
    acc.complete_count += Number(row.complete_count || 0);
    acc.partial_count += Number(row.partial_count || 0);
    acc.pending_count += Number(row.pending_count || 0);
    acc.high_score_count += Number(row.high_score_count || 0);
    acc.high_score_false_positive_count += Number(row.high_score_false_positive_count || 0);
    acc.high_score_direction_hit_count += Number(row.high_score_direction_hit_count || 0);
    acc.drawdown_discipline_hit_count += Number(row.drawdown_discipline_hit_count || 0);
    return acc;
  }, {
    total_count: 0,
    complete_count: 0,
    partial_count: 0,
    pending_count: 0,
    high_score_count: 0,
    high_score_false_positive_count: 0,
    high_score_direction_hit_count: 0,
    drawdown_discipline_hit_count: 0
  });

  return {
    totals,
    buckets: rows.map((row: any) => ({
      experiment_key: row.experiment_key,
      title: experimentMeta[row.experiment_key as ExperimentKey]?.title || row.experiment_key,
      market_regime: row.market_regime,
      total_count: Number(row.total_count || 0),
      complete_count: Number(row.complete_count || 0),
      partial_count: Number(row.partial_count || 0),
      pending_count: Number(row.pending_count || 0),
      average_model_probability: round(row.average_model_probability, 4),
      average_direction_probability: round(row.average_direction_probability, 4),
      average_hardness_probability: round(row.average_hardness_probability, 4),
      average_forward_return_20d: round(row.average_forward_return_20d, 2),
      average_max_drawdown: round(row.average_max_drawdown, 2),
      drawdown_discipline_hit_count: Number(row.drawdown_discipline_hit_count || 0),
      high_score_count: Number(row.high_score_count || 0),
      high_score_false_positive_count: Number(row.high_score_false_positive_count || 0),
      high_score_direction_hit_count: Number(row.high_score_direction_hit_count || 0)
    }))
  };
}

const getDirectionReviewThresholdPercent = (key: ExperimentKey) => (
  Math.min((experimentMeta[key]?.positiveThreshold || 0.06) * 100, 8)
);

const getFeatureValue = (featureSnapshot: Record<string, any>, keys: string[]) => {
  for (const key of keys) {
    const value = nullableNumber(featureSnapshot[key]);
    if (value !== null) return value;
  }
  return null;
};

async function getRiskCrashDisciplineReview(db: any) {
  await ensurePredictionSnapshotTables(db);
  const rows = await db.all(
    `SELECT
       s.id,
       s.experiment_key,
       s.symbol,
       s.name,
       s.asset_type,
       s.source,
       s.trade_date,
       s.close,
       COALESCE(s.market_regime, 'UNKNOWN') AS market_regime,
       s.experiment_score,
       s.rule_score,
       s.model_score,
       s.direction_score,
       s.hardness_score,
       s.feature_label,
       s.rotation_label,
       s.discipline_label,
       s.discipline_reason,
       s.feature_snapshot_json,
       l.forward_return_5d,
       l.forward_return_10d,
       l.forward_return_20d,
       l.max_forward_return,
       l.max_drawdown,
       l.direction_outcome,
       l.hardness_outcome,
       l.label_status
     FROM finance_experiment_prediction_snapshots s
     INNER JOIN finance_experiment_prediction_labels l
       ON l.snapshot_id = s.id AND l.horizon_days = 20
     WHERE s.saved_from = 'risk_crash_backfill'
       AND COALESCE(s.market_regime, 'UNKNOWN') IN ('RISK', 'CRASH')
       AND COALESCE(l.label_status, 'pending') = 'complete'`
  );

  const reviewed: any[] = rows.map((row: any) => {
    const key = String(row.experiment_key || 'elasticity-hardness') as ExperimentKey;
    const featureSnapshot = jsonParseObject(row.feature_snapshot_json);
    const marketRegime = classifyMarket(row.market_regime);
    const score = nullableNumber(row.direction_score)
      ?? nullableNumber(row.model_score)
      ?? nullableNumber(row.rule_score)
      ?? nullableNumber(row.experiment_score)
      ?? 0;
    const hardnessScore = nullableNumber(row.hardness_score);
    const forwardReturn20 = nullableNumber(row.forward_return_20d);
    const maxForwardReturn = nullableNumber(row.max_forward_return);
    const maxDrawdown = nullableNumber(row.max_drawdown);
    const drawdownFloor = getDrawdownDisciplineFloorPercent(marketRegime);
    const directionThreshold = getDirectionReviewThresholdPercent(key);
    const directionOutcome = String(row.direction_outcome || '');
    const directionWorked = (
      (maxForwardReturn !== null && maxForwardReturn >= directionThreshold)
      || (forwardReturn20 !== null && forwardReturn20 > 0)
      || directionOutcome.includes('兑现')
      || directionOutcome.includes('有效')
    );
    const acceptanceBroken = maxDrawdown !== null && maxDrawdown <= drawdownFloor;
    const highScore = score >= 70;
    const directionOkBroken = directionWorked && acceptanceBroken;
    const pathBrokenPositive20 = directionOkBroken && forwardReturn20 !== null && forwardReturn20 > 0;
    const ret20 = getFeatureValue(featureSnapshot, ['ret20']);
    const ret60 = getFeatureValue(featureSnapshot, ['ret60']);
    const relativeRet20Hs300 = getFeatureValue(featureSnapshot, ['relative_ret20_hs300', 'sector_relative_ret20_hs300']);
    const relativeRet60Hs300 = getFeatureValue(featureSnapshot, ['relative_ret60_hs300', 'sector_relative_ret60_hs300']);
    const amountRatio520 = getFeatureValue(featureSnapshot, ['amount_ratio_5_20', 'sector_amount_ratio_5_20']);
    const pricePos120 = getFeatureValue(featureSnapshot, ['price_pos120']);
    const distanceMa60 = getFeatureValue(featureSnapshot, ['distance_ma60', 'bias60', 'sector_distance_ma60']);
    const breadthAboveMa60Ratio = getFeatureValue(featureSnapshot, ['breadth_above_ma60_ratio']);
    const riskTargetFlags = getRiskWeakTargetFlags({
      market_regime: marketRegime,
      breadth_above_ma60_ratio: breadthAboveMa60Ratio,
      relative_ret20_hs300: relativeRet20Hs300,
      relative_ret60_hs300: relativeRet60Hs300,
      amount_ratio_5_20: amountRatio520
    });
    const lowHardness = directionWorked && (hardnessScore === null || hardnessScore < 58);
    const strongModelButWeakResult = highScore && (
      (forwardReturn20 !== null && forwardReturn20 <= 0)
      || acceptanceBroken
    );
    const riskDoubleHighFalsePositive = marketRegime === 'RISK'
      && highScore
      && (hardnessScore === null || hardnessScore >= 58)
      && strongModelButWeakResult;
    const crashHighScoreFalsePositive = marketRegime === 'CRASH' && strongModelButWeakResult;
    let reviewLabel = '方向未兑现';
    let reviewAction = '继续只做后验观察';
    if (marketRegime === 'CRASH' && directionWorked) {
      reviewLabel = acceptanceBroken ? 'CRASH方向对但冻结区打穿' : 'CRASH方向有效但总闸冻结';
      reviewAction = '只训练方向，不放承接口';
    } else if (directionOkBroken) {
      reviewLabel = '方向对但承接/回撤打穿';
      reviewAction = '调低承接硬度，风险区禁止直接放行';
    } else if (acceptanceBroken) {
      reviewLabel = '回撤纪律打穿';
      reviewAction = '标记弱承接样本';
    } else if (directionWorked) {
      reviewLabel = lowHardness ? '方向有效但承接分低' : '方向有效承接通过';
      reviewAction = lowHardness ? '补承接特征和硬度标签' : '保留为正向承接样本';
    }
    const reviewReason = `方向阈值 ${directionThreshold.toFixed(1)}%，${marketRegime === 'RISK' ? 'RISK' : 'CRASH'} 回撤纪律 ${drawdownFloor}%；最大涨幅 ${maxForwardReturn ?? '--'}%，最大回撤 ${maxDrawdown ?? '--'}%。`;
    const deceptionPatterns: string[] = [];
    if ((pricePos120 !== null && pricePos120 >= 0.75) || (distanceMa60 !== null && distanceMa60 >= 0.08) || (ret20 !== null && ret20 >= 0.12)) {
      deceptionPatterns.push('高位/追高');
    }
    if (riskTargetFlags.weak_amount) {
      deceptionPatterns.push('量能承接不足');
    }
    if (riskTargetFlags.weak_breadth) {
      deceptionPatterns.push('市场广度偏弱');
    }
    if (riskTargetFlags.weak_relative_hs300) {
      deceptionPatterns.push('相对沪深300弱');
    }
    if (highScore && directionOkBroken) {
      deceptionPatterns.push('高分遮住路径风险');
    }
    let deceptionType: string | null = null;
    let deceptionReason: string | null = null;
    let deceptionPriority = 0;
    if (crashHighScoreFalsePositive) {
      deceptionType = 'crash_high_score_false_positive';
      deceptionReason = 'CRASH 冻结区仍给高分，但后续收益/回撤没有通过风险纪律。';
      deceptionPriority = 90;
    } else if (riskDoubleHighFalsePositive) {
      deceptionType = 'risk_model_double_high_false_positive';
      deceptionReason = 'RISK 里方向分高、承接分不低，但后续亏损或回撤打穿。';
      deceptionPriority = 85;
    } else if (pathBrokenPositive20) {
      deceptionType = 'positive_20d_broken_path';
      deceptionReason = '20日结果为正，但中途最大回撤已经打穿纪律线。';
      deceptionPriority = 80;
    } else if (directionOkBroken) {
      deceptionType = 'direction_ok_broken_path';
      deceptionReason = '方向判断有效，但承接/回撤纪律没扛住。';
      deceptionPriority = 75;
    }

    return {
      id: Number(row.id),
      experiment_key: key,
      title: experimentMeta[key]?.title || key,
      symbol: String(row.symbol || ''),
      name: row.name ? String(row.name) : null,
      asset_type: String(row.asset_type || ''),
      source: String(row.source || ''),
      trade_date: String(row.trade_date || ''),
      close: nullableNumber(row.close),
      market_regime: marketRegime,
      score: round(score, 2),
      hardness_score: round(hardnessScore, 2),
      high_score: highScore,
      direction_threshold: round(directionThreshold, 2),
      drawdown_floor: drawdownFloor,
      direction_worked: directionWorked,
      acceptance_broken: acceptanceBroken,
      direction_ok_broken: directionOkBroken,
      path_broken_positive_20d: pathBrokenPositive20,
      low_hardness: lowHardness,
      forward_return_5d: round(row.forward_return_5d, 2),
      forward_return_10d: round(row.forward_return_10d, 2),
      forward_return_20d: round(forwardReturn20, 2),
      max_forward_return: round(maxForwardReturn, 2),
      max_drawdown: round(maxDrawdown, 2),
      direction_outcome: row.direction_outcome || null,
      hardness_outcome: row.hardness_outcome || null,
      feature_label: row.feature_label || null,
      rotation_label: row.rotation_label || null,
      discipline_label: row.discipline_label || null,
      discipline_reason: row.discipline_reason || null,
      ret20: round(ret20, 4),
      ret60: round(ret60, 4),
      relative_ret20_hs300: round(relativeRet20Hs300, 4),
      relative_ret60_hs300: round(relativeRet60Hs300, 4),
      amount_ratio_5_20: round(amountRatio520, 4),
      amount_ratio_5_20_change: riskTargetFlags.normalized.amount_ratio_5_20_change,
      price_pos120: round(pricePos120, 4),
      distance_ma60: round(distanceMa60, 4),
      breadth_above_ma60_ratio: round(breadthAboveMa60Ratio, 4),
      breadth_above_ma60_pct: riskTargetFlags.normalized.breadth_above_ma60_pct,
      relative_ret20_hs300_pct: riskTargetFlags.normalized.relative_ret20_hs300_pct,
      relative_ret60_hs300_pct: riskTargetFlags.normalized.relative_ret60_hs300_pct,
      risk_target_flags: riskTargetFlags,
      risk_target_labels: riskTargetFlags.labels,
      risk_target_hit_count: riskTargetFlags.hit_count,
      review_label: reviewLabel,
      review_reason: reviewReason,
      review_action: reviewAction,
      deception_type: deceptionType,
      deception_reason: deceptionReason,
      deception_patterns: deceptionPatterns,
      deception_priority: deceptionPriority,
      training_target: directionOkBroken
        ? '方向正例 / 承接负例'
        : (directionWorked ? '方向正例 / 承接待定' : '方向待定'),
      training_weight_note: pathBrokenPositive20
        ? '最终20日为正但过程打穿，承接负样本加权'
        : (directionOkBroken ? '方向有效但过程打穿，承接负样本加权' : null)
    };
  });

  const createBucket = (sample: any) => ({
    experiment_key: sample.experiment_key,
    title: sample.title,
    market_regime: sample.market_regime,
    total_count: 0,
    direction_worked_count: 0,
    acceptance_broken_count: 0,
    direction_ok_broken_count: 0,
    high_score_direction_ok_broken_count: 0,
    sum_forward_return_20d: 0,
    count_forward_return_20d: 0,
    sum_max_forward_return: 0,
    count_max_forward_return: 0,
    sum_max_drawdown: 0,
    count_max_drawdown: 0,
    sum_score: 0,
    count_score: 0,
    sum_hardness_score: 0,
    count_hardness_score: 0
  });

  const buckets = Array.from(reviewed.reduce<Map<string, any>>((acc, sample) => {
    const bucketKey = `${sample.experiment_key}-${sample.market_regime}`;
    const bucket = acc.get(bucketKey) || createBucket(sample);
    bucket.total_count += 1;
    if (sample.direction_worked) bucket.direction_worked_count += 1;
    if (sample.acceptance_broken) bucket.acceptance_broken_count += 1;
    if (sample.direction_ok_broken) bucket.direction_ok_broken_count += 1;
    if (sample.high_score && sample.direction_ok_broken) bucket.high_score_direction_ok_broken_count += 1;
    if (sample.forward_return_20d !== null) {
      bucket.sum_forward_return_20d += sample.forward_return_20d;
      bucket.count_forward_return_20d += 1;
    }
    if (sample.max_forward_return !== null) {
      bucket.sum_max_forward_return += sample.max_forward_return;
      bucket.count_max_forward_return += 1;
    }
    if (sample.max_drawdown !== null) {
      bucket.sum_max_drawdown += sample.max_drawdown;
      bucket.count_max_drawdown += 1;
    }
    if (sample.score !== null) {
      bucket.sum_score += sample.score;
      bucket.count_score += 1;
    }
    if (sample.hardness_score !== null) {
      bucket.sum_hardness_score += sample.hardness_score;
      bucket.count_hardness_score += 1;
    }
    acc.set(bucketKey, bucket);
    return acc;
  }, new Map()).values()).map((bucket: any) => ({
    experiment_key: bucket.experiment_key,
    title: bucket.title,
    market_regime: bucket.market_regime,
    total_count: bucket.total_count,
    direction_worked_count: bucket.direction_worked_count,
    acceptance_broken_count: bucket.acceptance_broken_count,
    direction_ok_broken_count: bucket.direction_ok_broken_count,
    high_score_direction_ok_broken_count: bucket.high_score_direction_ok_broken_count,
    average_forward_return_20d: bucket.count_forward_return_20d ? round(bucket.sum_forward_return_20d / bucket.count_forward_return_20d, 2) : null,
    average_max_forward_return: bucket.count_max_forward_return ? round(bucket.sum_max_forward_return / bucket.count_max_forward_return, 2) : null,
    average_max_drawdown: bucket.count_max_drawdown ? round(bucket.sum_max_drawdown / bucket.count_max_drawdown, 2) : null,
    average_score: bucket.count_score ? round(bucket.sum_score / bucket.count_score, 2) : null,
    average_hardness_score: bucket.count_hardness_score ? round(bucket.sum_hardness_score / bucket.count_hardness_score, 2) : null
  })).sort((a, b) => (
    a.experiment_key.localeCompare(b.experiment_key)
    || (a.market_regime === 'RISK' ? -1 : 1)
  ));

  const patternDefinitions = [
    {
      key: 'risk_strict_drawdown',
      name: 'RISK 严格回撤打穿',
      rule: 'RISK 样本按 -6% 最大回撤验收承接硬度。',
      hit: (sample: any) => sample.market_regime === 'RISK' && sample.acceptance_broken
    },
    {
      key: 'crash_direction_freeze',
      name: 'CRASH 方向有效但总闸冻结',
      rule: 'CRASH 样本只训练方向和反抽，不给承接放行。',
      hit: (sample: any) => sample.market_regime === 'CRASH' && sample.direction_worked
    },
    {
      key: 'high_score_broken',
      name: '高分仍打穿',
      rule: '方向/模型分不低，但未来过程击穿风险区回撤纪律。',
      hit: (sample: any) => sample.high_score && sample.direction_ok_broken
    },
    {
      key: 'positive_20d_broken_path',
      name: '20日正收益但过程打穿',
      rule: '最终 20 日是正的，但中间回撤已经不适合承接。',
      hit: (sample: any) => (sample.forward_return_20d ?? -Infinity) > 0 && sample.acceptance_broken
    },
    {
      key: 'direction_low_hardness',
      name: '方向有效但承接分低/缺失',
      rule: '方向有结果，但承接模型没有给足硬度。',
      hit: (sample: any) => sample.low_hardness
    }
  ];

  const totals = {
    total_count: reviewed.length,
    direction_worked_count: reviewed.filter(sample => sample.direction_worked).length,
    acceptance_broken_count: reviewed.filter(sample => sample.acceptance_broken).length,
    direction_ok_broken_count: reviewed.filter(sample => sample.direction_ok_broken).length,
    risk_direction_ok_broken_count: reviewed.filter(sample => sample.market_regime === 'RISK' && sample.direction_ok_broken).length,
    crash_direction_ok_broken_count: reviewed.filter(sample => sample.market_regime === 'CRASH' && sample.direction_ok_broken).length,
    path_broken_positive_20d_count: reviewed.filter(sample => sample.path_broken_positive_20d).length,
    high_score_direction_ok_broken_count: reviewed.filter(sample => sample.high_score && sample.direction_ok_broken).length,
    risk_weak_target_count: reviewed.filter(sample => sample.risk_target_hit_count > 0).length,
    weak_breadth_count: reviewed.filter(sample => sample.risk_target_flags?.weak_breadth).length,
    weak_relative_hs300_count: reviewed.filter(sample => sample.risk_target_flags?.weak_relative_hs300).length,
    weak_amount_count: reviewed.filter(sample => sample.risk_target_flags?.weak_amount).length,
    risk_weak_target_direction_ok_broken_count: reviewed.filter(sample => sample.risk_target_hit_count > 0 && sample.direction_ok_broken).length,
    risk_strict_floor: -6,
    crash_floor: -8
  };

  const tuningSamples = reviewed.filter(sample => sample.direction_ok_broken);
  const cleanDirectionSamples = reviewed.filter(sample => sample.direction_worked && !sample.acceptance_broken);
  const averageOf = (samples: any[], key: string) => {
    const values = samples
      .map(sample => nullableNumber(sample[key]))
      .filter((value): value is number => value !== null);
    return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 4) : null;
  };
  const featureKeys = [
    'ret20',
    'ret60',
    'relative_ret20_hs300',
    'relative_ret60_hs300',
    'amount_ratio_5_20',
    'price_pos120',
    'distance_ma60',
    'breadth_above_ma60_ratio',
    'hardness_score'
  ];
  const featureDeltas = featureKeys.map(key => {
    const brokenAverage = averageOf(tuningSamples, key);
    const cleanAverage = averageOf(cleanDirectionSamples, key);
    return {
      key,
      broken_average: brokenAverage,
      clean_direction_average: cleanAverage,
      delta: brokenAverage !== null && cleanAverage !== null ? round(brokenAverage - cleanAverage, 4) : null
    };
  });

  return {
    discipline_note: 'RISK 按 -6% 最大回撤验收承接硬度；CRASH 不放行，只训练方向/反抽和打脸样本。',
    tuning_note: '这批方向对但承接打穿样本用于硬度训练：方向标签保留正例，承接/回撤纪律标签记负例；20日最终为正但过程打穿也不能算承接成功。',
    training_rules: [
      '方向是否有效继续看未来最大涨幅/20日收益，不把方向和承接混成一个标签。',
      'RISK 最大回撤 <= -6% 视为承接纪律打穿，承接硬度负例加权。',
      'RISK 中市场广度弱、相对沪深300弱、缩量承接不足的样本单独加标签，优先喂给承接硬度/回撤纪律。',
      'CRASH 不给承接放行，只训练方向/反抽和打脸样本。',
      '20日收益为正但中间打穿纪律线，归为“路径打穿型正收益”，方向可正、承接必须负。',
      '高分仍打穿样本提高复盘优先级，防方向分盖过失效线和账户纪律。'
    ],
    totals,
    deception_review: summarizeRiskCrashDeceptionReview(reviewed),
    tuning_set: {
      sample_count: tuningSamples.length,
      path_broken_positive_20d_count: totals.path_broken_positive_20d_count,
      feature_deltas: featureDeltas,
      samples: [...tuningSamples].sort((a, b) => {
        const pathDelta = Number(b.path_broken_positive_20d) - Number(a.path_broken_positive_20d);
        if (pathDelta) return pathDelta;
        const drawdownDelta = (a.max_drawdown ?? 0) - (b.max_drawdown ?? 0);
        if (drawdownDelta) return drawdownDelta;
        return (b.score ?? 0) - (a.score ?? 0);
      }).slice(0, 80)
    },
    buckets,
    patterns: patternDefinitions.map((pattern) => {
      const hitCount = reviewed.filter(pattern.hit).length;
      return {
        key: pattern.key,
        name: pattern.name,
        hit_count: hitCount,
        hit_rate: reviewed.length ? round(hitCount / reviewed.length * 100, 2) : null,
        rule: pattern.rule
      };
    }),
    samples: [...reviewed].sort((a, b) => {
      const brokenDelta = Number(b.direction_ok_broken) - Number(a.direction_ok_broken);
      if (brokenDelta) return brokenDelta;
      const drawdownDelta = (a.max_drawdown ?? 0) - (b.max_drawdown ?? 0);
      if (drawdownDelta) return drawdownDelta;
      return (b.score ?? 0) - (a.score ?? 0);
    }).slice(0, 80)
  };
}

const compactRiskCrashDisciplineReview = (review: any) => {
  if (!review) return review;
  return {
    ...review,
    details_loaded: false,
    deception_review: review.deception_review
      ? {
        ...review.deception_review,
        categories: (review.deception_review.categories || []).map((category: any) => ({
          ...category,
          samples: []
        })),
        samples: []
      }
      : review.deception_review,
    tuning_set: review.tuning_set
      ? {
        ...review.tuning_set,
        samples: []
      }
      : review.tuning_set,
    samples: []
  };
};

const getRiskCrashBackfillStatus = async (db: any, options: { detail?: 'summary' | 'full' } = {}) => {
  const candidateUniverse = await getRiskCrashCandidateUniverse(db, 20);
  const existingKeys = await getRiskCrashBackfillExistingKeys(db);
  const existingDates = await getRiskCrashBackfillExistingDates(db);
  const freshCandidates = filterRiskCrashExistingCandidates(candidateUniverse.candidates, existingKeys, {
    existingDates,
    minGapDays: 20
  });
  const selectedPreview = sampleRiskCrashCandidates(freshCandidates, {
    maxDates: 8,
    perRegimeYear: 1,
    minGapDays: 20
  });
  const snapshotSummary = await getRiskCrashBackfillSnapshotSummary(db);
  const disciplineReview = await getRiskCrashDisciplineReview(db);
  const { candidates: _candidates, ...candidateSummary } = candidateUniverse;
  const includeFullDetails = options.detail === 'full';
  return {
    ...candidateSummary,
    ...(includeFullDetails ? { candidates: _candidates } : {}),
    fresh_candidate_count: freshCandidates.length,
    selected_preview: selectedPreview,
    snapshots: snapshotSummary,
    discipline_review: includeFullDetails
      ? { ...disciplineReview, details_loaded: true }
      : compactRiskCrashDisciplineReview(disciplineReview),
    job: riskCrashBackfillJob,
    note: candidateUniverse.table_candidate_count > 0
      ? '候选日期来自 financial_market_regime；只按当时市场状态回放，不把未来结果塞回特征。'
      : 'financial_market_regime 暂无历史 RISK/CRASH 日期，当前用沪深300历史日线按同口径派生候选，不写回市场状态表。'
  };
};

const getBackfillAssetType = (key: ExperimentKey) => {
  if (key === 'double-stock') return 'stock';
  if (key === 'capital-rotation') return 'etf';
  return '';
};

const runRiskCrashBackfillJob = async (
  job: RiskCrashBackfillJob,
  options: { samplesPerExperiment: number; horizonDays: number; targetProfile?: string }
) => {
  try {
    const db = await getDb();
    await ensureExperimentIndexesOnce(db);
    await ensurePredictionSnapshotTables(db);

    for (const candidate of job.selected_dates) {
      for (const key of job.experiment_keys) {
        job.progress.current = `${experimentMeta[key].title} / ${candidate.trade_date} / ${candidate.market_regime}`;
        try {
          const data = await runExperimentPredictionPoolWorker(key, getBackfillAssetType(key), options.samplesPerExperiment, {
            asOfDate: candidate.trade_date,
            includeOutcomes: true,
            horizonDays: options.horizonDays
          });
          const normalizedItems = Array.isArray(data?.items)
            ? data.items.map((item: any) => ({
              ...item,
              market_regime: normalizeRiskCrashRegime(item.market_regime) || candidate.market_regime
            }))
            : [];
          const itemsForPersist = options.targetProfile === 'risk_acceptance_weak'
            ? normalizedItems.filter((item: any) => (
              classifyMarket(item.market_regime) === 'RISK'
              && getRiskWeakTargetFlagsFromSnapshot(item.feature_snapshot || {}, item.market_regime).hit_count > 0
            ))
            : normalizedItems;
          const skippedCount = normalizedItems.length - itemsForPersist.length;
          if (options.targetProfile === 'risk_acceptance_weak') {
            job.result.target_saved_count = (job.result.target_saved_count || 0) + itemsForPersist.length;
            job.result.target_skipped_count = (job.result.target_skipped_count || 0) + skippedCount;
          }
          const saved = await persistPredictionSnapshots(
            db,
            key,
            { ...data, items: itemsForPersist },
            { savedFrom: 'risk_crash_backfill' }
          );
          const refreshed = await refreshPredictionLabels(db, key, {
            assetType: getBackfillAssetType(key),
            limit: 2000,
            horizonDays: options.horizonDays,
            force: false,
            savedFrom: 'risk_crash_backfill'
          });
          job.result.saved_count += saved.saved_count;
          job.result.inserted_count += saved.inserted_count;
          job.result.updated_count += saved.updated_count;
          job.result.refreshed_count += refreshed.refreshed_count;
          job.result.completed_count += refreshed.completed_count;
          job.result.partial_count += refreshed.partial_count;
          job.result.pending_count += refreshed.pending_count;
        } catch (error) {
          job.result.errors.push(`${key}/${candidate.trade_date}: ${(error as Error).message}`);
        } finally {
          job.progress.completed_tasks += 1;
        }
      }
    }

    job.status = job.result.errors.length > 0 ? 'failed' : 'completed';
    job.message = job.status === 'completed'
      ? (options.targetProfile === 'risk_acceptance_weak'
        ? `RISK 承接弱项样本补齐完成：目标命中 ${job.result.target_saved_count || 0} 条，落库 ${job.result.saved_count} 条。`
        : `风险区历史样本补齐完成：落库 ${job.result.saved_count} 条。`)
      : `风险区历史样本补齐完成但有 ${job.result.errors.length} 个错误。`;
    job.finished_at = new Date().toISOString();
    job.progress.current = null;
  } catch (error) {
    job.status = 'failed';
    job.message = `风险区历史样本补齐失败：${(error as Error).message}`;
    job.finished_at = new Date().toISOString();
    job.progress.current = null;
    job.result.errors.push((error as Error).message);
  }
};

const runCapitalRotationAcceptanceWorker = (
  fromDate: string,
  sampleLimit: number
): Promise<any> => new Promise((resolve, reject) => {
  const dbPath = getDatabasePath();
  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'evaluate_capital_rotation_acceptance.py');
  const child = spawn(trainingPython, [
    scriptPath,
    '--db', dbPath,
    '--from-date', fromDate,
    '--sample-limit', String(sampleLimit)
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
    const text = stdout.trim();
    try {
      const payload = JSON.parse(text || '{}');
      if (code === 0 && payload.success) {
        resolve(payload.data);
        return;
      }
      reject(new Error(payload.message || stderr || `资金轮动验收脚本退出：${code}`));
    } catch (error) {
      reject(new Error(stderr || text || `资金轮动验收输出无法解析：${error instanceof Error ? error.message : String(error)}`));
    }
  });
});

router.get('/experiments/risk-crash-backfill/status', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureExperimentIndexesOnce(db);
    const detailQuery = String(req.query.detail || req.query.include_details || '').trim();
    const data = await getRiskCrashBackfillStatus(db, {
      detail: detailQuery === 'full' || detailQuery === '1' ? 'full' : 'summary'
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `读取 RISK/CRASH 样本补齐状态失败：${(error as Error).message}`
    });
  }
});

router.post('/experiments/risk-crash-backfill/run', async (req: Request, res: Response) => {
  try {
    if (riskCrashBackfillJob?.status === 'running') {
      return res.status(409).json({
        success: false,
        message: 'RISK/CRASH 样本补齐正在执行中，先等当前任务结束。',
        data: { job: riskCrashBackfillJob }
      });
    }

    const db = await getDb();
    await ensureExperimentIndexesOnce(db);
    await ensurePredictionSnapshotTables(db);
    const maxDates = Math.min(Math.max(Number(req.query.max_dates || req.query.maxDates || req.body?.max_dates || req.body?.maxDates || 4), 1), 8);
    const perRegimeYear = Math.min(Math.max(Number(req.query.per_regime_year || req.query.perRegimeYear || req.body?.per_regime_year || req.body?.perRegimeYear || 1), 1), 3);
    const minGapDays = Math.min(Math.max(Number(req.query.min_gap_days || req.query.minGapDays || req.body?.min_gap_days || req.body?.minGapDays || 20), 5), 90);
    const samplesPerExperiment = Math.min(Math.max(Number(req.query.samples_per_experiment || req.query.samplesPerExperiment || req.body?.samples_per_experiment || req.body?.samplesPerExperiment || 10), 5), 30);
    const horizonDays = Math.min(Math.max(Number(req.query.horizon_days || req.query.horizonDays || req.body?.horizon_days || req.body?.horizonDays || 20), 5), 60);
    const requestedKey = String(req.query.experiment_key || req.query.experimentKey || req.body?.experiment_key || req.body?.experimentKey || '').trim() as ExperimentKey;
    const includeExisting = String(req.query.include_existing || req.query.includeExisting || req.body?.include_existing || req.body?.includeExisting || '').trim() === '1';
    const targetProfile = String(req.query.target_profile || req.query.targetProfile || req.body?.target_profile || req.body?.targetProfile || '').trim();
    const keys = requestedKey && experimentMeta[requestedKey] ? [requestedKey] : experimentKeys;

    const candidateUniverse = await getRiskCrashCandidateUniverse(db, horizonDays);
    const existingKeys = await getRiskCrashBackfillExistingKeys(db);
    const existingDates = await getRiskCrashBackfillExistingDates(db);
    const candidatesForRunBase = includeExisting
      ? candidateUniverse.candidates
      : filterRiskCrashExistingCandidates(candidateUniverse.candidates, existingKeys, {
        existingDates,
        minGapDays
      });
    const candidatesForRun = targetProfile === 'risk_acceptance_weak'
      ? candidatesForRunBase.filter(candidate => classifyMarket(candidate.market_regime) === 'RISK')
      : candidatesForRunBase;
    const selectedDates = sampleRiskCrashCandidates(candidatesForRun, {
      maxDates,
      perRegimeYear,
      minGapDays
    });
    if (selectedDates.length === 0) {
      return res.status(400).json({
        success: false,
        message: '没有找到可用于回放的 RISK/CRASH 历史截面日。',
        data: {
          cutoff_date: candidateUniverse.cutoff_date,
          candidate_count: candidateUniverse.candidate_count,
          fresh_candidate_count: candidatesForRun.length,
          note: candidateUniverse.table_candidate_count > 0
            ? 'financial_market_regime 里没有满足间隔条件、且尚未补齐过的风险日期。'
            : 'financial_market_regime 暂无历史风险日期，沪深300日线派生候选也为空或已补齐。'
        }
      });
    }

    const now = new Date().toISOString();
    riskCrashBackfillJob = {
      id: `risk-crash-backfill-${Date.now()}`,
      status: 'running',
      target_profile: targetProfile || undefined,
      started_at: now,
      finished_at: null,
      message: targetProfile === 'risk_acceptance_weak'
        ? 'RISK 承接弱项历史样本补齐正在后台执行。'
        : 'RISK/CRASH 风险区历史样本补齐正在后台执行。',
      candidate_count: candidateUniverse.candidate_count,
      selected_dates: selectedDates,
      experiment_keys: keys,
      progress: {
        total_tasks: selectedDates.length * keys.length,
        completed_tasks: 0,
        current: null
      },
      result: {
        saved_count: 0,
        inserted_count: 0,
        updated_count: 0,
        refreshed_count: 0,
        completed_count: 0,
        partial_count: 0,
        pending_count: 0,
        target_saved_count: targetProfile === 'risk_acceptance_weak' ? 0 : undefined,
        target_skipped_count: targetProfile === 'risk_acceptance_weak' ? 0 : undefined,
        errors: []
      }
    };

    void runRiskCrashBackfillJob(riskCrashBackfillJob, { samplesPerExperiment, horizonDays, targetProfile });

    res.json({
      success: true,
      data: {
        job: riskCrashBackfillJob,
        candidate_source: candidateUniverse.candidate_source,
        note: '后台任务已启动；打开页面或点击刷新状态只读进度，不会重复触发回放。'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `启动 RISK/CRASH 样本补齐失败：${(error as Error).message}`
    });
  }
});

router.get('/experiments/overview', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const assetType = String(req.query.asset_type || req.query.assetType || '').trim();
    const experiments = await Promise.all(experimentKeys.map(async (key) => {
      const modelSummary = await getExperimentModelSummary(db, key);
      const bestArtifact = getBestExperimentArtifact(modelSummary.artifacts);
      const snapshotData = await getPredictionSnapshotSummary(db, key, {
        assetType: assetType || undefined,
        limit: 5
      });
      const nextAction = getExperimentNextAction(
        modelSummary,
        snapshotData.summary,
        snapshotData.market_regime_buckets
      );
      const acceptanceEvidence = buildExperimentAcceptanceEvidence(
        snapshotData.summary,
        snapshotData.market_regime_buckets
      );
      const candidateAuxiliary = getExperimentCandidateAuxiliary(
        modelSummary,
        snapshotData.summary,
        snapshotData.market_regime_buckets,
        acceptanceEvidence
      );

      return {
        key,
        title: experimentMeta[key].title,
        model: {
          run_id: modelSummary.run?.id ?? null,
          status: modelSummary.run?.status ?? 'not_started',
          best_model: modelSummary.health?.best_model ?? bestArtifact?.model_key ?? null,
          sample_count: modelSummary.health?.sample_count ?? modelSummary.run?.source_row_count ?? null,
          positive_rate: modelSummary.health?.positive_rate ?? null,
          validation_auc: bestArtifact?.validation_auc ?? null,
          test_auc: bestArtifact?.test_auc ?? null,
          completed_at: modelSummary.health?.completed_at ?? null,
          output_dir: modelSummary.health?.output_dir ?? null
        },
        snapshots: snapshotData.summary,
        market_regime_buckets: snapshotData.market_regime_buckets,
        acceptance_evidence: acceptanceEvidence,
        candidate_auxiliary: candidateAuxiliary,
        next_action: nextAction
      };
    }));

    const summary = experiments.reduce((acc, item) => {
      acc.model_ready_count += item.model.status === 'completed' ? 1 : 0;
      acc.snapshot_total += item.snapshots.total_count;
      acc.complete_count += item.snapshots.complete_count;
      acc.partial_count += item.snapshots.partial_count;
      acc.pending_count += item.snapshots.pending_count;
      acc.rule_conflict_count += item.snapshots.rule_conflict_count || 0;
      acc.candidate_auxiliary_allowed_count += item.candidate_auxiliary.allowed ? 1 : 0;
      if (!acc.latest_trade_date || (item.snapshots.latest_trade_date && item.snapshots.latest_trade_date > acc.latest_trade_date)) {
        acc.latest_trade_date = item.snapshots.latest_trade_date;
      }
      if (!acc.last_saved_at || (item.snapshots.last_saved_at && item.snapshots.last_saved_at > acc.last_saved_at)) {
        acc.last_saved_at = item.snapshots.last_saved_at;
      }
      return acc;
    }, {
      model_ready_count: 0,
      snapshot_total: 0,
      complete_count: 0,
      partial_count: 0,
      pending_count: 0,
      rule_conflict_count: 0,
      candidate_auxiliary_allowed_count: 0,
      latest_trade_date: null as string | null,
      last_saved_at: null as string | null
    });

    res.json({
      success: true,
      data: {
        summary: {
          ...summary,
          experiment_count: experiments.length
        },
        experiments,
        updated_at: new Date().toISOString(),
        no_trade_note: '五模型验收台只读取已落库预测池、后验标签和训练产物；不自动回放、不自动训练、不产生开仓许可。'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `读取实验模型总览失败：${(error as Error).message}`
    });
  }
});

router.get('/experiments/capital-rotation/direction-board', async (req: Request, res: Response) => {
  try {
    const scopeQuery = String(req.query.scope || 'focus');
    const scope = scopeQuery === 'all' || scopeQuery === 'ai' ? scopeQuery : 'focus';
    const limit = Math.min(Math.max(Number(req.query.limit || 40), 10), 120);
    const cacheKey = `${scope}|${limit}`;
    const cached = isForceRefresh(req) ? null : getCached(directionBoardCache, cacheKey);
    const db = await getDb();
    const data = cached || (isForceRefresh(req)
      ? await runCapitalRotationDirectionWorker(scope, limit)
      : await getCapitalRotationDirectionBoardSnapshot(db, scope, limit));
    if (!cached) {
      setCached(directionBoardCache, cacheKey, data, HEAVY_REPORT_CACHE_MS);
    }
    const items = Array.isArray(data.items) ? data.items : [];
    const summary = items.reduce((acc: Record<string, number>, item: any) => {
      const key = item.rotation_label || '继续观察';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    res.json({
      success: true,
      data: {
        ...data,
        summary: {
          returned: items.length,
          direction_up: summary['方向增强'] || 0,
          watch: (summary['列入观察'] || 0) + (summary['方向观察'] || 0) + (summary['继续观察'] || 0),
          weak_acceptance: summary['方向有承接弱'] || 0,
          train_only: summary['只训练不追'] || 0,
          frozen: summary['总闸冻结'] || 0,
          raw: summary
        },
        no_trade_note: '资金轮动模型已拆成方向判断与承接/回撤纪律；它只做观察和训练样本，不给开仓许可，买入仍需市场总闸、安全区、结构和失效线。'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `生成资金轮动方向榜失败：${(error as Error).message}`
    });
  }
});

router.get('/experiments/capital-rotation/acceptance-report', async (req: Request, res: Response) => {
  try {
    const fromDate = String(req.query.from_date || req.query.fromDate || '2024-01-01');
    const sampleLimit = Math.min(Math.max(Number(req.query.sample_limit || req.query.sampleLimit || 40), 10), 120);
    const cacheKey = `${fromDate}|${sampleLimit}`;
    const cached = isForceRefresh(req) ? null : getCached(acceptanceReportCache, cacheKey);
    const data = cached || await runCapitalRotationAcceptanceWorker(fromDate, sampleLimit);
    if (!cached) {
      setCached(acceptanceReportCache, cacheKey, data, HEAVY_REPORT_CACHE_MS);
    }
    res.json({
      success: true,
      data: {
        ...data,
        discipline_note: '第一版纪律：方向高只说明钱在动，承接高才允许列入观察；方向高但承接低只训练不追；所有输出仍不能覆盖市场总闸、安全区、结构和失效线。'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `生成资金轮动验收报告失败：${(error as Error).message}`
    });
  }
});

router.get('/experiments/:key/backtest', async (req: Request, res: Response) => {
  try {
    const key = req.params.key as ExperimentKey;
    if (!experimentMeta[key]) {
      return res.status(404).json({ success: false, message: '未知实验模型' });
    }
    const db = await getDb();
    await ensureExperimentIndexesOnce(db);
    const forceRefresh = isForceRefresh(req);
    const latestDate = await getLatestPriceDate(db, forceRefresh);
    const cacheKey = [
      key,
      latestDate,
      String(req.query.limit || ''),
      String(req.query.asset_type || req.query.assetType || ''),
      String(req.query.forward_window || req.query.forwardWindow || '')
    ].join('|');
    const cached = forceRefresh ? null : getCached(backtestCache, cacheKey);
    const data = cached || await buildBacktest(db, key, req, latestDate);
    if (!cached) {
      setCached(backtestCache, cacheKey, data, BACKTEST_CACHE_MS);
    }
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `历史模拟失败：${(error as Error).message}`
    });
  }
});

router.get('/experiments/:key/prediction-pool', async (req: Request, res: Response) => {
  try {
    const key = req.params.key as ExperimentKey;
    if (!experimentMeta[key]) {
      return res.status(404).json({ success: false, message: '未知实验模型' });
    }
    const db = await getDb();
    await ensureExperimentIndexesOnce(db);
    const forceRefresh = isForceRefresh(req);
    const latestDate = await getLatestPriceDate(db, forceRefresh);
    const limit = Math.min(Math.max(Number(req.query.limit || 40), 10), 120);
    const assetType = String(req.query.asset_type || req.query.assetType || '').trim();
    const cacheKey = [
      forceRefresh ? 'live' : 'snapshot',
      key,
      latestDate,
      String(limit),
      assetType
    ].join('|');
    const cached = forceRefresh ? null : getCached(predictionPoolCache, cacheKey);
    let data = cached;
    if (!data && !forceRefresh) {
      data = await getLatestPredictionPoolSnapshot(db, key, { assetType, limit });
    }
    if (!data && !forceRefresh) {
      data = {
        meta: {
          key,
          title: experimentMeta[key].title,
          asset_types: experimentMeta[key].assetTypes,
          latest_price_date: latestDate || null,
          as_of_date: latestDate || null,
          replay_mode: false,
          snapshot_mode: true,
          data_source: 'latest_prediction_pool_snapshot',
          last_saved_at: null,
          outcome_horizon_days: 20,
          no_lookahead_rule: '当前还没有日终落库快照；请等待日终流水线或手动实时计算后保存。'
        },
        summary: {
          item_count: 0,
          average_score: null,
          average_model_score: null,
          market: {},
          action: {},
          complete_count: 0,
          partial_count: 0,
          pending_count: 0,
          raw_model_accept_count: 0,
          discipline_model_accept_count: 0,
          discipline_blocked_count: 0,
          average_forward_return_20d: null,
          fail_line_rate: null
        },
        artifact: null,
        direction_artifact: null,
        hardness_artifact: null,
        split_model: false,
        items: []
      };
    }
    if (!data) {
      data = await runExperimentPredictionPoolWorker(key, assetType, limit);
    }
    if (!cached) {
      setCached(predictionPoolCache, cacheKey, data, BACKTEST_CACHE_MS);
    }
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `读取最新预测池失败：${(error as Error).message}`
    });
  }
});

router.get('/experiments/:key/prediction-replay', async (req: Request, res: Response) => {
  try {
    const key = req.params.key as ExperimentKey;
    if (!experimentMeta[key]) {
      return res.status(404).json({ success: false, message: '未知实验模型' });
    }
    const asOfDate = String(req.query.as_of_date || req.query.asOfDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      return res.status(400).json({ success: false, message: '请传入历史截面日 as_of_date，格式 YYYY-MM-DD' });
    }
    const db = await getDb();
    await ensureExperimentIndexesOnce(db);
    const forceRefresh = isForceRefresh(req);
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 10), 120);
    const horizonDays = Math.min(Math.max(Number(req.query.horizon_days || req.query.horizonDays || 20), 5), 60);
    const assetType = String(req.query.asset_type || req.query.assetType || '').trim();
    const cacheKey = [key, asOfDate, String(limit), String(horizonDays), assetType].join('|');
    const cached = forceRefresh ? null : getCached(predictionReplayCache, cacheKey);
    const snapshotData = cached || (!forceRefresh
      ? await getPredictionReplaySnapshot(db, key, { asOfDate, assetType, limit, horizonDays })
      : null);
    const data = snapshotData || (forceRefresh
      ? await runExperimentPredictionPoolWorker(key, assetType, limit, {
        asOfDate,
        includeOutcomes: true,
        horizonDays
      })
      : {
        meta: {
          key,
          title: experimentMeta[key].title,
          asset_types: experimentMeta[key].assetTypes,
          latest_price_date: asOfDate,
          as_of_date: asOfDate,
          replay_mode: true,
          snapshot_mode: true,
          data_source: 'prediction_replay_snapshot',
          saved_from: null,
          last_saved_at: null,
          outcome_horizon_days: horizonDays,
          no_lookahead_rule: '当前截面没有落库快照；默认不现场重算，点击“强制实时重算”才会跑历史回放。'
        },
        artifact: null,
        direction_artifact: null,
        hardness_artifact: null,
        split_model: false,
        summary: {
          item_count: 0,
          average_score: null,
          average_model_score: null,
          market: {},
          action: {},
          raw_model_accept_count: 0,
          discipline_model_accept_count: 0,
          discipline_blocked_count: 0,
          complete_count: 0,
          partial_count: 0,
          pending_count: 0,
          win_rate_20d: null,
          average_forward_return_20d: null,
          fail_line_rate: null
        },
        items: []
      });
    if (!cached) {
      setCached(predictionReplayCache, cacheKey, data, BACKTEST_CACHE_MS);
    }
    res.json({
      success: true,
      data: {
        ...data,
        replay_note: '历史截面回放只使用 as_of_date 当天及以前的特征；未来收益仅作为后验标签，用来验模型，不参与当时排序。'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `历史截面预测池回放失败：${(error as Error).message}`
    });
  }
});

router.post('/experiments/:key/prediction-pool/snapshots', async (req: Request, res: Response) => {
  try {
    const key = req.params.key as ExperimentKey;
    if (!experimentMeta[key]) {
      return res.status(404).json({ success: false, message: '未知实验模型' });
    }
    const db = await getDb();
    await ensureExperimentIndexesOnce(db);
    await ensurePredictionSnapshotTables(db);
    const latestDate = await getLatestPriceDate(db, true);
    const limit = Math.min(Math.max(Number(req.query.limit || req.body?.limit || 40), 10), 120);
    const assetType = String(req.query.asset_type || req.query.assetType || req.body?.asset_type || req.body?.assetType || '').trim();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const shouldSaveCurrentPool = body.use_current_pool === true || body.useCurrentPool === true;
    const data = shouldSaveCurrentPool
      ? normalizeProvidedPredictionPoolForSave(key, body.pool, assetType, limit, latestDate)
      : await runExperimentPredictionPoolWorker(key, assetType, limit);
    const saved = await persistPredictionSnapshots(db, key, data, {
      replaceLatestScope: true,
      replaceAssetType: assetType,
      expectedTradeDate: latestDate
    });
    invalidatePredictionSnapshotCache(key, assetType);
    const snapshotData = await getPredictionSnapshotSummary(db, key, {
      assetType,
      limit: 20,
      savedFrom: 'latest_prediction_pool'
    });
    setCached(
      predictionPoolCache,
      ['live', key, latestDate, String(limit), assetType].join('|'),
      data,
      BACKTEST_CACHE_MS
    );
    res.json({
      success: true,
      data: {
        pool: data,
        snapshot_summary: snapshotData.summary,
        snapshot_market_regime_buckets: snapshotData.market_regime_buckets,
        recent_snapshots: snapshotData.items,
        source: shouldSaveCurrentPool ? 'displayed_live_pool' : 'recomputed_live_pool',
        ...saved
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `保存最新预测池失败：${(error as Error).message}`
    });
  }
});

router.post('/experiments/:key/prediction-labels/refresh', async (req: Request, res: Response) => {
  try {
    const key = req.params.key as ExperimentKey;
    if (!experimentMeta[key]) {
      return res.status(404).json({ success: false, message: '未知实验模型' });
    }
    const db = await getDb();
    await ensureExperimentIndexesOnce(db);
    const assetType = String(req.query.asset_type || req.query.assetType || req.body?.asset_type || req.body?.assetType || '').trim();
    const savedFrom = String(req.query.saved_from || req.query.savedFrom || req.body?.saved_from || req.body?.savedFrom || '').trim();
    const refreshed = await refreshPredictionLabels(db, key, {
      assetType,
      limit: Number(req.query.limit || req.body?.limit || 600),
      horizonDays: Number(req.query.horizon_days || req.query.horizonDays || req.body?.horizon_days || req.body?.horizonDays || 20),
      force: isForceRefresh(req),
      savedFrom
    });
    invalidatePredictionSnapshotCache(key, assetType);
    const snapshotData = await getPredictionSnapshotSummary(db, key, { assetType, limit: 20, savedFrom });
    res.json({
      success: true,
      data: {
        ...refreshed,
        snapshot_summary: snapshotData.summary,
        snapshot_market_regime_buckets: snapshotData.market_regime_buckets,
        recent_snapshots: snapshotData.items
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `刷新后验标签失败：${(error as Error).message}`
    });
  }
});

router.get('/experiments/:key/prediction-snapshots', async (req: Request, res: Response) => {
  try {
    const key = req.params.key as ExperimentKey;
    if (!experimentMeta[key]) {
      return res.status(404).json({ success: false, message: '未知实验模型' });
    }
    const db = await getDb();
    const assetType = String(req.query.asset_type || req.query.assetType || '').trim();
    const savedFrom = String(req.query.saved_from || req.query.savedFrom || '').trim();
    const snapshotScope = String(req.query.snapshot_scope || req.query.scope || '').trim();
    const latestOnly = snapshotScope !== 'history' && snapshotScope !== 'all' && String(req.query.include_history || '') !== '1';
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 5), 100);
    const data = await getPredictionSnapshotSummary(db, key, { assetType, limit, savedFrom, latestOnly });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `读取预测池快照失败：${(error as Error).message}`
    });
  }
});

router.get('/experiments/:key/model', async (req: Request, res: Response) => {
  try {
    const key = req.params.key as ExperimentKey;
    if (!experimentMeta[key]) {
      return res.status(404).json({ success: false, message: '未知实验模型' });
    }
    const db = await getDb();
    const data = await getExperimentModelSummary(db, key);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `读取模型训练结果失败：${(error as Error).message}`
    });
  }
});

router.post('/experiments/:key/train', async (req: Request, res: Response) => {
  try {
    const key = req.params.key as ExperimentKey;
    if (!experimentMeta[key]) {
      return res.status(404).json({ success: false, message: '未知实验模型' });
    }
    const db = await getDb();
    const running = await getRunningExperimentTrainingRun(db, key);
    if (running) {
      return res.status(409).json({
        success: false,
        message: `实验模型训练正在执行中：${running.domain}，开始时间：${running.started_at}`,
        data: { running }
      });
    }
    startExperimentTrainingWorker(key);
    res.json({
      success: true,
      message: '实验模型训练已启动，产物写入外接盘。',
      data: { key, output_root: path.join(trainingRoot, 'experiments') }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `启动实验模型训练失败：${(error as Error).message}`
    });
  }
});

router.post('/experiments/train-all', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const running = await getRunningExperimentTrainingRun(db, 'all');
    if (running) {
      return res.status(409).json({
        success: false,
        message: `实验模型训练正在执行中：${running.domain}，开始时间：${running.started_at}`,
        data: { running }
      });
    }
    startExperimentTrainingWorker('all');
    res.json({
      success: true,
      message: '五个实验模型训练已启动，产物写入外接盘。',
      data: { keys: Object.keys(experimentMeta), output_root: path.join(trainingRoot, 'experiments') }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `启动五场景训练失败：${(error as Error).message}`
    });
  }
});

export default router;
