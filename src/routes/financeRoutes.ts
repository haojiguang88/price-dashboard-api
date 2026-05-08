import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import getDb from '../config/database';
import {
  DEFAULT_FINANCE_CANDIDATE_FUNNEL_CONFIG,
  DEFAULT_FINANCE_PIPELINE_CONFIG,
  runFinanceCandidateFunnelPipeline,
  runFinanceDailyPipeline
} from '../services/financeDailyPipeline';
import {
  MARKET_ASSETS,
  buildIndustryEtfStrengthResponse,
  getMarketAssetMeta,
  getPreferredMarketSource
} from '../services/industryEtfStrengthService';

const router = Router();
const execAsync = promisify(exec);
const FINANCE_PIPELINE_TASK_KEY = 'finance_daily_pipeline';
const FINANCE_FUNNEL_TASK_KEY = 'finance_candidate_funnel_pipeline';
const CHINA_TIME_ZONE = 'Asia/Shanghai';
const PIPELINE_MANUAL_EARLIEST_MINUTE = 16 * 60;
const PIPELINE_RUNNING_TIMEOUT_MS = 2 * 60 * 60 * 1000;

interface DailyPrice {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  updated_at?: string;
}

interface MarketBehaviorTag {
  code: string;
  label: string;
  tone: 'good' | 'warn' | 'risk' | 'neutral';
  reason: string;
}

interface MarketRegime {
  symbol: string;
  name: string;
  trade_date: string;
  close: number;
  ma20: number | null;
  ma20_slope: string;
  ma60: number;
  ma60_prev: number;
  ma60_slope: string;
  ma120: number | null;
  ma120_prev: number | null;
  ma120_slope: string;
  ma250: number | null;
  ma250_prev: number | null;
  ma250_slope: string;
  low_60: number | null;
  low_120: number | null;
  cross_count_10: number;
  above_ma60_days: number;
  below_ma60_days: number;
  drawdown_20: number | null;
  drawdown_60: number | null;
  drawdown_120: number | null;
  latest_change: number | null;
  distance_to_ma60: number;
  distance_to_ma250: number | null;
  higher_high: boolean;
  higher_low: boolean;
  lower_high: boolean;
  lower_low: boolean;
  sideways: boolean;
  up_days: number;
  down_days: number;
  market_regime: string;
  result_reason: string;
  entry_permission: string;
  entry_reason: string;
  rule_version: string;
  cycle_layer_version: string;
  short_state: string;
  short_label: string;
  short_reason: string;
  mid_state: string;
  mid_label: string;
  mid_reason: string;
  long_state: string;
  long_label: string;
  long_reason: string;
  behavior_tags: MarketBehaviorTag[];
  is_mock?: boolean;
  source?: string;
}

interface FetchResult {
  data: DailyPrice[];
  source: string;
  is_mock: boolean;
}

interface TodayActionItem {
  id: number;
  symbol: string;
  name?: string;
  asset_type?: string;
  label: string;
  detail?: string;
  score?: number | null;
  priority?: string;
  path: string;
}

const COOLDOWN_SECONDS = 60;

function getChinaDateKey(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: CHINA_TIME_ZONE });
}

function getMarketDailyAssetType(symbol: string): 'index' | 'etf' | null {
  const meta = getMarketAssetMeta(symbol);
  if (meta.category === 'broad' || meta.category === 'style') return 'index';
  if (meta.category === 'industry' || symbol.startsWith('5') || symbol.startsWith('1')) return 'etf';
  return null;
}

function getChinaLocalDate(date = new Date()) {
  return new Date(date.toLocaleString('en-US', { timeZone: CHINA_TIME_ZONE }));
}

function getPipelineEarliestTimeLabel() {
  const hour = Math.floor(PIPELINE_MANUAL_EARLIEST_MINUTE / 60);
  const minute = PIPELINE_MANUAL_EARLIEST_MINUTE % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatChinaDateTime(value?: string | null) {
  if (!value) return '--';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    timeZone: CHINA_TIME_ZONE,
    hour12: false
  });
}

function getRunDateKey(startedAt?: string | null) {
  if (!startedAt) return null;
  const date = new Date(startedAt);
  if (!Number.isFinite(date.getTime())) return null;
  return getChinaDateKey(date);
}

async function expireStaleFinancePipelineRuns(db: any) {
  const runningRows = await db.all(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY started_at DESC, id DESC`,
    [FINANCE_PIPELINE_TASK_KEY]
  );
  const nowMs = Date.now();
  const staleRows = runningRows.filter((row: any) => {
    const startedMs = new Date(row.started_at).getTime();
    return Number.isFinite(startedMs) && nowMs - startedMs > PIPELINE_RUNNING_TIMEOUT_MS;
  });
  if (staleRows.length === 0) return;

  const now = new Date().toISOString();
  for (const row of staleRows) {
    const message = `金融日终流水线超过 ${Math.round(PIPELINE_RUNNING_TIMEOUT_MS / 3600000)} 小时仍未结束，已自动标记为失败，请确认是否在非交易时段或数据源无响应时启动。`;
    await db.run(
      `UPDATE task_center_runs
       SET status = 'error', message = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
      [message, now, row.id]
    );
    await db.run(
      `UPDATE task_center_tasks
       SET last_status = 'error', last_message = ?, last_run_at = ?, updated_at = ?
       WHERE task_key = ?`,
      [message, now, now, FINANCE_PIPELINE_TASK_KEY]
    );
  }
}

async function buildManualPipelineRunGuard(db: any, force = false) {
  await expireStaleFinancePipelineRuns(db);

  if (force) {
    return { can_run: true, reason: null, force_supported: true };
  }

  const running = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
    [FINANCE_PIPELINE_TASK_KEY]
  );
  if (running) {
    return {
      can_run: false,
      reason: `金融日终流水线正在执行中，开始时间：${formatChinaDateTime(running.started_at)}`,
      force_supported: false,
      running
    };
  }

  const localNow = getChinaLocalDate();
  const day = localNow.getDay();
  if (day === 0 || day === 6) {
    return {
      can_run: false,
      reason: '今天不是交易日（周末），日终流水线不启动，避免无意义请求数据源。',
      force_supported: true
    };
  }

  const minuteOfDay = localNow.getHours() * 60 + localNow.getMinutes();
  if (minuteOfDay < PIPELINE_MANUAL_EARLIEST_MINUTE) {
    return {
      can_run: false,
      reason: `日终流水线只允许 ${getPipelineEarliestTimeLabel()} 后执行。当前还未到收盘后处理窗口，先不要请求行情源。`,
      force_supported: true
    };
  }

  const latestRun = await db.get(
    `SELECT id, status, started_at, message
     FROM task_center_runs
     WHERE task_key = ?
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
    [FINANCE_PIPELINE_TASK_KEY]
  );
  if (latestRun?.status === 'success' && getRunDateKey(latestRun.started_at) === getChinaDateKey()) {
    return {
      can_run: false,
      reason: '今日流水线已经成功执行过。本页默认不重复跑，避免休市或无新数据时反复请求。',
      force_supported: true
    };
  }

  return { can_run: true, reason: null, force_supported: true };
}

async function fetchIndexDaily(symbol: string): Promise<FetchResult> {
  const meta = getMarketAssetMeta(symbol);
  if (meta.category === 'industry' || symbol.startsWith('5') || symbol.startsWith('1')) {
    const scriptPath = `${process.cwd()}/scripts/finance/fetch_asset_daily.py`;
    const { stdout, stderr } = await execAsync(`/usr/bin/python3 ${scriptPath} ${symbol} etf --source tushare`);

    if (stderr && !stdout) {
      throw new Error(`Python script error: ${stderr}`);
    }

    const result = JSON.parse(stdout);
    if (!result.success) {
      throw new Error(result.message || `Tushare ETF fetch failed: ${symbol}`);
    }

    return {
      data: result.items,
      source: result.source || 'tushare',
      is_mock: result.is_mock === true
    };
  }

  if (getPreferredMarketSource(symbol) === 'tushare') {
    const scriptPath = `${process.cwd()}/scripts/finance/fetch_asset_daily.py`;
    const { stdout, stderr } = await execAsync(`/usr/bin/python3 ${scriptPath} ${symbol} index --source tushare`);

    if (stderr && !stdout) {
      throw new Error(`Python script error: ${stderr}`);
    }

    const result = JSON.parse(stdout);
    if (!result.success) {
      throw new Error(result.message || `Tushare index fetch failed: ${symbol}`);
    }

    return {
      data: result.items,
      source: result.source || 'tushare',
      is_mock: result.is_mock === true
    };
  }

  const scriptPath = `${process.cwd()}/scripts/finance/fetch_index_daily.py`;
  const { stdout, stderr } = await execAsync(`/usr/bin/python3 ${scriptPath} ${symbol}`);
  
  if (stderr) {
    throw new Error(`Python script error: ${stderr}`);
  }
  
  const result = JSON.parse(stdout);
  
  if (result.error) {
    throw new Error(result.error);
  }
  
  return result as FetchResult;
}

async function upsertDailyPrices(prices: DailyPrice[], symbol: string, source: string): Promise<void> {
  const db = await getDb();
  const name = getMarketAssetMeta(symbol).name;
  const market = 'CN';
  const asset_type = symbol.startsWith('5') || symbol.startsWith('1') ? 'etf' : 'index';
  
  for (const price of prices) {
    await db.run(
      `INSERT OR REPLACE INTO financial_daily_prices 
        (symbol, name, market, asset_type, trade_date, open, high, low, close, volume, amount, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [symbol, name, market, asset_type, price.trade_date, price.open, price.high, price.low, price.close, price.volume, price.amount, source]
    );
  }
}

async function getDailyPrices(symbol: string, source: string = 'akshare'): Promise<DailyPrice[]> {
  const db = await getDb();
  const assetType = getMarketDailyAssetType(symbol);
  const assetFilter = assetType ? 'AND asset_type = ?' : '';
  const params = assetType ? [symbol, source, assetType] : [symbol, source];
  return db.all(
    `SELECT trade_date, open, high, low, close, volume, amount, updated_at 
     FROM financial_daily_prices 
     WHERE symbol = ? AND source = ? ${assetFilter}
     ORDER BY trade_date ASC`,
    params
  );
}

async function getLastUpdatedTime(symbol: string, source: string = 'akshare'): Promise<string | null> {
  const db = await getDb();
  const assetType = getMarketDailyAssetType(symbol);
  const assetFilter = assetType ? 'AND asset_type = ?' : '';
  const params = assetType ? [symbol, source, assetType] : [symbol, source];
  const result = await db.get(
    `SELECT MAX(updated_at) as last_updated 
     FROM financial_daily_prices 
     WHERE symbol = ? AND source = ? ${assetFilter}`,
    params
  );
  return result?.last_updated || null;
}

async function getLatestRegime(symbol: string): Promise<any | null> {
  const db = await getDb();
  const result = await db.get(
    `SELECT * FROM financial_market_regime 
     WHERE symbol = ? AND result_reason NOT LIKE '%模拟数据%' 
     ORDER BY id DESC LIMIT 1`,
    [symbol]
  );
  return result;
}

function parseJsonConfig(configJson?: string | null) {
  if (!configJson) return {};
  try {
    return JSON.parse(configJson);
  } catch {
    return {};
  }
}

async function ensureFinancePipelineTask(db: any) {
  await db.run(
    `INSERT OR IGNORE INTO task_center_tasks
      (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
     VALUES (?, ?, ?, ?, 0, '16:30', 'trade_days', 8, ?, 'pending', ?)`,
    [
      FINANCE_PIPELINE_TASK_KEY,
      '金融日终流水线',
      'finance',
      'finance_daily_pipeline',
      JSON.stringify(DEFAULT_FINANCE_PIPELINE_CONFIG),
      '一键串联市场总闸、日线更新、备选池、入场触发和持仓建议；只更新建议，不自动买卖'
    ]
  );
  return db.get(`SELECT * FROM task_center_tasks WHERE task_key = ?`, [FINANCE_PIPELINE_TASK_KEY]);
}

async function ensureFinanceFunnelTask(db: any) {
  await db.run(
    `INSERT OR IGNORE INTO task_center_tasks
      (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
     VALUES (?, ?, ?, ?, 0, '09:30', 'trade_days', 7, ?, 'pending', ?)`,
    [
      FINANCE_FUNNEL_TASK_KEY,
      '入池漏斗流水线',
      'finance',
      'finance_candidate_funnel_pipeline',
      JSON.stringify(DEFAULT_FINANCE_CANDIDATE_FUNNEL_CONFIG),
      '从当前备选池自动重算走势阶段、复核资格并推进入场触发观察；只推进建议，不自动建仓'
    ]
  );
  return db.get(`SELECT * FROM task_center_tasks WHERE task_key = ?`, [FINANCE_FUNNEL_TASK_KEY]);
}

async function buildManualFunnelRunGuard(db: any) {
  const running = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
    [FINANCE_FUNNEL_TASK_KEY]
  );
  if (running) {
    return {
      can_run: false,
      reason: `入池漏斗流水线正在执行中，开始时间：${formatChinaDateTime(running.started_at)}`,
      force_supported: false,
      running
    };
  }

  return { can_run: true, reason: null, force_supported: false };
}

function getDurationSeconds(startedAt?: string, finishedAt?: string) {
  if (!startedAt || !finishedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function toArray(value: any) {
  return Array.isArray(value) ? value : [];
}

function countBy<T>(items: T[], getKey: (item: T) => string | undefined | null) {
  return items.reduce((acc: Record<string, number>, item) => {
    const key = getKey(item) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function assetTypeBreakdown(items: any[], predicate: (item: any) => boolean = () => true) {
  const filtered = items.filter(predicate);
  return {
    stock: filtered.filter((item: any) => item.asset_type === 'stock').length,
    etf: filtered.filter((item: any) => item.asset_type === 'etf').length
  };
}

function marketRegimeText(value?: string | null) {
  switch (value) {
    case 'NORMAL_CONFIRMED': return '正常确认区';
    case 'NORMAL': return '正常区';
    case 'RISK': return '风险区';
    case 'CRASH_WARNING': return '股灾预警';
    case 'CRASH': return '股灾冻结区';
    case 'UNKNOWN': return '状态未确认';
    default: return value || '--';
  }
}

function summarizePipelineStep(step: any) {
  const data = step?.data || {};
  const results = toArray(data.results);
  const items = toArray(data.items);
  const base = {
    key: step.key,
    label: step.label,
    status: step.status,
    message: step.message,
    started_at: step.started_at,
    finished_at: step.finished_at,
    duration_seconds: getDurationSeconds(step.started_at, step.finished_at),
    metrics: {} as Record<string, any>,
    details: [] as Array<Record<string, any>>
  };

  switch (step.key) {
    case 'market_environment': {
      base.metrics = {
        checked: results.length,
        success: results.filter((item: any) => item.success).length,
        failed: results.filter((item: any) => item.success === false).length
      };
      base.details = results.slice(0, 8).map((item: any) => ({
        symbol: item.symbol,
        status: item.success ? '成功' : '失败',
        trade_date: item.trade_date,
        result: marketRegimeText(item.market_regime) || item.message || '--'
      }));
      break;
    }
    case 'daily_prices': {
      const inserted = results.reduce((sum: number, item: any) => sum + Number(item.insertedCount || 0), 0);
      const updated = results.reduce((sum: number, item: any) => sum + Number(item.updatedCount || 0), 0);
      const noNewData = results.filter((item: any) => item.noNewData).length;
      base.metrics = {
        active_plan: Number(data.active_plan_count || 0),
        candidate: Number(data.candidate_count || 0),
        universe: Number(data.universe_count || 0),
        success: Number(data.success_count ?? results.filter((item: any) => item.success).length),
        failed: Number(data.failed_count ?? results.filter((item: any) => item.success === false).length),
        inserted,
        updated,
        no_new_data: noNewData
      };
      base.details = results
        .filter((item: any) => item.success === false || Number(item.insertedCount || 0) > 0)
        .slice(0, 8)
        .map((item: any) => ({
          symbol: item.symbol,
          status: item.success ? '新增' : '失败',
          inserted: Number(item.insertedCount || 0),
          updated: Number(item.updatedCount || 0),
          result: item.message || '--'
        }));
      break;
    }
    case 'candidate_scan': {
      const selected = results.filter((item: any) => item.selected);
      base.metrics = {
        checked: Number(data.checked_count || results.length),
        raw: Number(data.raw_count || 0),
        deduped: Number(data.deduped_count || 0),
        duplicate: Number(data.duplicate_count || 0),
        unchecked: Number(data.unchecked_count || 0),
        selected: Number(data.selected_count ?? selected.length),
        rejected: Math.max(0, Number(data.checked_count || results.length) - Number(data.selected_count ?? selected.length))
      };
      base.details = selected.slice(0, 8).map((item: any) => ({
        symbol: item.symbol,
        name: item.name,
        asset_type: item.asset_type,
        result: item.reason || '进入备选池'
      }));
      break;
    }
    case 'candidate_funnel': {
      const nestedSteps = toArray(data.steps);
      base.metrics = {
        total: Number(data.summary?.total || nestedSteps.length),
        success: Number(data.summary?.success || nestedSteps.filter((item: any) => item.status === 'success').length),
        failed: Number(data.summary?.failed || nestedSteps.filter((item: any) => item.status === 'error').length)
      };
      base.details = nestedSteps.map((item: any) => ({
        key: item.key,
        status: item.status,
        result: item.message || item.label || '--'
      }));
      break;
    }
    case 'active_candidate_collect': {
      const byAssetType = assetTypeBreakdown(items);
      base.metrics = {
        active: items.length,
        stock: byAssetType.stock,
        etf: byAssetType.etf
      };
      base.details = items.slice(0, 8).map((item: any) => ({
        symbol: item.symbol,
        name: item.name,
        asset_type: item.asset_type,
        score: item.priority_score,
        result: '当前 active 备选'
      }));
      break;
    }
    case 'trend_phase_recalc': {
      const byAssetType = assetTypeBreakdown(results);
      const passedByAssetType = assetTypeBreakdown(results, (item: any) => item.passed);
      base.metrics = {
        checked: Number(data.checked_count || results.length),
        stock: byAssetType.stock,
        etf: byAssetType.etf,
        passed: Number(data.passed_count || results.filter((item: any) => item.passed).length),
        stock_passed: passedByAssetType.stock,
        etf_passed: passedByAssetType.etf,
        blocked: Number(data.blocked_count || results.filter((item: any) => item.success === false || item.passed === false).length),
        success: results.filter((item: any) => item.success).length,
        failed: results.filter((item: any) => item.success === false).length
      };
      base.details = results.slice(0, 8).map((item: any) => ({
        symbol: item.symbol,
        name: item.name,
        asset_type: item.asset_type,
        status: item.success === false ? '失败' : item.passed ? '通过' : '挡下',
        result: item.reason || item.message || '--'
      }));
      break;
    }
    case 'candidate_recheck': {
      const selected = results.filter((item: any) => item.selected);
      const byAssetType = assetTypeBreakdown(results);
      const selectedByAssetType = assetTypeBreakdown(results, (item: any) => item.selected);
      base.metrics = {
        checked: Number(data.checked_count || results.length),
        stock: byAssetType.stock,
        etf: byAssetType.etf,
        selected: Number(data.selected_count ?? selected.length),
        stock_selected: selectedByAssetType.stock,
        etf_selected: selectedByAssetType.etf,
        rejected: Math.max(0, Number(data.checked_count || results.length) - Number(data.selected_count ?? selected.length))
      };
      base.details = results.slice(0, 8).map((item: any) => ({
        symbol: item.symbol,
        name: item.name,
        asset_type: item.asset_type,
        score: item.priority_score,
        status: item.selected ? '保留' : '淘汰',
        result: item.reason || '--'
      }));
      break;
    }
    case 'entry_observation_seed': {
      const byAssetType = assetTypeBreakdown(results);
      const readyByAssetType = assetTypeBreakdown(results, (item: any) => item.passed);
      base.metrics = {
        checked: results.length,
        stock: byAssetType.stock,
        etf: byAssetType.etf,
        ready: Number(data.ready_count || results.filter((item: any) => item.passed).length),
        stock_ready: readyByAssetType.stock,
        etf_ready: readyByAssetType.etf,
        blocked: Number(data.blocked_count || results.filter((item: any) => item.passed === false).length),
        plan_candidate: results.filter((item: any) => item.observation_status === 'plan_candidate').length,
        failed: results.filter((item: any) => item.success === false).length,
        action_counts: countBy(results, (item: any) => item.action_label || item.action)
      };
      base.details = results.slice(0, 8).map((item: any) => ({
        symbol: item.symbol,
        name: item.name,
        status: item.success === false ? '失败' : item.passed ? '准备入场' : '继续观察',
        score: item.trigger_score,
        result: item.action_label || item.reason || '--'
      }));
      break;
    }
    case 'entry_trigger_scan': {
      const summary = data.summary || {};
      const byAssetType = assetTypeBreakdown(results);
      const upgradedByAssetType = assetTypeBreakdown(results, (item: any) => item.conclusion === '可升级计划准备');
      base.metrics = {
        checked: Number(summary.checked || results.length),
        stock: byAssetType.stock,
        etf: byAssetType.etf,
        upgraded: Number(summary.upgraded || 0),
        stock_upgraded: upgradedByAssetType.stock,
        etf_upgraded: upgradedByAssetType.etf,
        waiting: Number(summary.waiting || 0),
        invalidated: Number(summary.invalidated || 0),
        action_counts: countBy(results, (item: any) => item.action_label || item.action)
      };
      base.details = results
        .filter((item: any) => item.action === 'READY_TO_PLAN' || item.observation_status === 'confirmed' || item.observation_status === 'invalidated')
        .slice(0, 8)
        .map((item: any) => ({
          symbol: item.symbol,
          name: item.name,
          status: item.observation_status,
          score: item.trigger_score,
          result: item.action_label || item.conclusion || item.reason || '--'
        }));
      break;
    }
    case 'active_plan_suggestions': {
      base.metrics = {
        synced: items.length,
        action_counts: countBy(items, (item: any) => item.action_label)
      };
      base.details = items.slice(0, 8).map((item: any) => ({
        plan_id: item.plan_id,
        suggestion_id: item.suggestion_id,
        result: item.action_label || '--'
      }));
      break;
    }
    case 'workflow_summary': {
      base.metrics = {
        candidate_active: Number(data.counts?.candidate_active || 0),
        structure_pending: Number(data.counts?.structure_pending || 0),
        structure_watch: Number(data.counts?.structure_watch || 0),
        structure_ready: Number(data.counts?.structure_ready || 0),
        wait_confirmation: Number(data.counts?.wait_confirmation || 0),
        entry_observations: Number(data.counts?.entry_observations || 0),
        plan_ready: Number(data.counts?.plan_ready || 0),
        trade_plans_active: Number(data.counts?.trade_plans_active || 0),
        invalidated: Number(data.counts?.invalidated || 0)
      };
      base.details = data.market ? [{
        symbol: data.market.symbol,
        name: data.market.name,
        trade_date: data.market.trade_date,
        result: marketRegimeText(data.market.market_regime)
      }] : [];
      break;
    }
    default:
      base.metrics = {};
  }

  return base;
}

function compactPipelineResult(resultJson?: string | null) {
  const result = parseJsonConfig(resultJson);
  const steps = toArray(result.steps).map(summarizePipelineStep);
  return {
    summary: result.summary || {
      total: steps.length,
      success: steps.filter((step: any) => step.status === 'success').length,
      failed: steps.filter((step: any) => step.status === 'error').length,
      failed_step: steps.find((step: any) => step.status === 'error')?.key || null
    },
    steps,
    config: result.config || null,
    finished_at: result.finished_at || null
  };
}

function extractDailyChanges(compactResult: any) {
  const steps = toArray(compactResult?.steps);
  const findStep = (key: string) => steps.find((step: any) => step.key === key);
  const dailyPrices = findStep('daily_prices');
  const candidateScan = findStep('candidate_scan');
  const entryTriggerScan = findStep('entry_trigger_scan');
  const activePlanSuggestions = findStep('active_plan_suggestions');

  return {
    data_update: {
      label: '本地行情更新',
      metrics: dailyPrices?.metrics || {},
      summary: dailyPrices?.message || '暂无本地行情更新记录'
    },
    candidate_changes: {
      label: '新增/刷新备选',
      metrics: candidateScan?.metrics || {},
      items: toArray(candidateScan?.details).slice(0, 8),
      summary: candidateScan?.message || '暂无备选池扫描记录'
    },
    trigger_changes: {
      label: '入场触发变化',
      metrics: entryTriggerScan?.metrics || {},
      items: toArray(entryTriggerScan?.details).slice(0, 8),
      summary: entryTriggerScan?.message || '暂无入场触发扫描记录'
    },
    plan_actions: {
      label: '计划动作建议',
      metrics: activePlanSuggestions?.metrics || {},
      items: toArray(activePlanSuggestions?.details).slice(0, 8),
      summary: activePlanSuggestions?.message || '暂无计划动作建议记录'
    }
  };
}

function buildRiskBoardPlanItem(row: any) {
  const actionCode = row.action_code || 'WATCH';
  const actionLabel = row.action_label || '继续观察';
  const close = Number(row.latest_close ?? row.close_price ?? 0);
  const invalidationLine = Number(row.latest_invalidation_line ?? row.invalidation_line ?? 0);
  const invalidated = Boolean(
    ['EXIT_BASE', 'STOP_LOSS_TACTICAL'].includes(actionCode) ||
    (close > 0 && invalidationLine > 0 && close < invalidationLine)
  );
  const noAdd = Boolean(actionCode === 'NO_ADD' || actionLabel.includes('禁止') || actionLabel.includes('不加仓'));
  const needReduce = Boolean(['EXIT_BASE', 'STOP_LOSS_TACTICAL', 'BASE_EXIT_WATCH', 'REDUCE_TACTICAL_WATCH'].includes(actionCode));
  const canPrepare = Boolean(['BASE_CAN_ENTER', 'TACTICAL_CAN_ENTER'].includes(actionCode));
  const justHold = Boolean(['WATCH', 'HOLD_BASE', 'HOLD_BASE_AND_TACTICAL'].includes(actionCode) && !invalidated);
  const positionTotal = Number(row.base_position_amount || 0) + Number(row.tactical_position_amount || 0) + Number(row.observation_position_amount || 0);

  let todayPermission = '继续观察，不主动处理';
  if (invalidated) todayPermission = '触发风控，先处理风险';
  else if (needReduce) todayPermission = '不加仓，进入减仓/退出观察';
  else if (noAdd) todayPermission = '今天不加仓';
  else if (canPrepare) todayPermission = '可进入计划准备，仍需人工确认';
  else if (justHold) todayPermission = '继续趴着';

  return {
    id: row.plan_id,
    source_type: 'trade_plan',
    lane: row.is_bought ? '正式计划' : row.status === 'draft' ? '计划草案' : '观察计划',
    symbol: row.symbol,
    name: row.name,
    asset_type: row.asset_type,
    status: row.status,
    priority: row.priority || 'normal',
    action_code: actionCode,
    action_label: actionLabel,
    action_reason: row.action_reason || row.trigger_reason || '暂无动作说明',
    today_permission: todayPermission,
    need_reduce_or_stop_add: needReduce || noAdd,
    invalidated,
    just_hold: justHold,
    can_prepare: canPrepare,
    close_price: close || null,
    invalidation_line: invalidationLine || null,
    trigger_score: row.trigger_score,
    structure_score: row.structure_score,
    trend_phase_code: row.trend_phase_code,
    position_amount: positionTotal,
    updated_at: row.suggestion_date || row.updated_at,
    path: '/finance/trade-plans'
  };
}

function buildRiskBoardObservationItem(row: any, sourceType: 'plan_ready' | 'entry_watch') {
  const isPlanReady = sourceType === 'plan_ready';
  return {
    id: row.id,
    source_type: sourceType,
    lane: isPlanReady ? '计划准备' : '入场观察',
    symbol: row.symbol,
    name: row.name,
    asset_type: row.asset_type,
    status: row.observation_status || (isPlanReady ? 'confirmed' : 'watching'),
    priority: isPlanReady ? 'high' : 'normal',
    action_code: isPlanReady ? 'READY_TO_PLAN' : 'WATCH_ENTRY',
    action_label: isPlanReady ? '待生成计划' : '继续观察触发',
    action_reason: row.trigger_reason || '等待入场触发条件继续确认',
    today_permission: isPlanReady ? '可进入计划准备，仍不代表买入' : '今天不动，继续观察',
    need_reduce_or_stop_add: false,
    invalidated: false,
    just_hold: !isPlanReady,
    can_prepare: isPlanReady,
    close_price: row.close_price || null,
    invalidation_line: row.invalidation_line || null,
    trigger_score: row.trigger_score,
    structure_score: row.structure_score,
    trend_phase_code: row.trend_phase_code,
    position_amount: 0,
    updated_at: row.updated_at,
    path: '/finance/entry-trigger'
  };
}

router.get('/workflow-summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const scalar = async (sql: string, params: any[] = []) => {
      const row = await db.get(sql, params);
      return Number(row?.count || 0);
    };

    const latestMarket = await db.get(
      `SELECT symbol, name, trade_date, close, market_regime, entry_permission, entry_reason, distance_to_ma60
       FROM financial_market_regime
       WHERE symbol = '000300'
       ORDER BY trade_date DESC, id DESC
       LIMIT 1`
    );

    const counts = {
      candidate_active: await scalar(`SELECT COUNT(*) as count FROM financial_candidate_pool WHERE pool_status = 'active' AND asset_type IN ('stock', 'etf')`),
      review_unreviewed: await scalar(`SELECT COUNT(*) as count FROM financial_candidate_pool WHERE pool_status = 'active' AND asset_type IN ('stock', 'etf') AND COALESCE(review_status, 'unreviewed') = 'unreviewed'`),
      review_drafted: await scalar(`SELECT COUNT(*) as count FROM financial_candidate_pool WHERE pool_status = 'active' AND asset_type IN ('stock', 'etf') AND review_status = 'drafted'`),
      trend_blocked: await scalar(`SELECT COUNT(*) as count FROM financial_candidate_pool WHERE pool_status = 'active' AND asset_type IN ('stock', 'etf') AND review_status = 'trend_blocked'`),
      structure_pending: await scalar(`SELECT COUNT(*) as count FROM financial_candidate_pool WHERE pool_status = 'active' AND asset_type IN ('stock', 'etf') AND review_status = 'structure_pending'`),
      structure_watch: await scalar(`SELECT COUNT(*) as count FROM financial_candidate_pool WHERE pool_status = 'active' AND asset_type IN ('stock', 'etf') AND review_status = 'structure_watch'`),
      structure_ready: await scalar(`SELECT COUNT(*) as count FROM financial_candidate_pool WHERE pool_status = 'active' AND asset_type IN ('stock', 'etf') AND review_status = 'structure_ready'`),
      wait_confirmation: await scalar(`
        SELECT COUNT(*) as count
        FROM financial_candidate_pool c
        WHERE c.pool_status = 'active'
          AND c.asset_type IN ('stock', 'etf')
          AND c.review_status = 'wait_confirmation'
          AND NOT EXISTS (
            SELECT 1
            FROM financial_entry_trigger_observations o
            WHERE o.symbol = c.symbol
              AND o.asset_type = c.asset_type
              AND o.source = c.source
              AND o.observation_status IN ('watching', 'plan_candidate', 'confirmed')
          )
      `),
      entry_observations: await scalar(`SELECT COUNT(*) as count FROM financial_entry_trigger_observations WHERE observation_status IN ('watching', 'plan_candidate')`),
      plan_ready: await scalar(`
        SELECT COUNT(*) as count
        FROM financial_entry_trigger_observations o
        WHERE o.observation_status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1
            FROM financial_trade_plans p
            WHERE p.symbol = o.symbol
              AND p.asset_type = o.asset_type
              AND p.source = o.source
              AND p.is_deleted = 0
              AND p.status IN ('draft', 'watching', 'active')
          )
      `),
      invalidated: await scalar(`
        SELECT
          (SELECT COUNT(*) FROM financial_candidate_pool WHERE asset_type IN ('stock', 'etf') AND review_status = 'rejected') +
          (SELECT COUNT(*) FROM financial_entry_trigger_observations WHERE observation_status = 'invalidated') as count
      `),
      trade_plans_active: await scalar(`SELECT COUNT(*) as count FROM financial_trade_plans WHERE is_deleted = 0 AND status IN ('draft', 'watching', 'active')`),
    };

    const latestCandidates = await db.all(
      `SELECT id, symbol, name, asset_type, priority_score, review_status, candidate_reason, last_checked_at
       FROM financial_candidate_pool
       WHERE pool_status = 'active'
         AND asset_type IN ('stock', 'etf')
       ORDER BY priority_score DESC, last_checked_at DESC
       LIMIT 6`
    );

    const latestObservations = await db.all(
      `SELECT id, symbol, name, asset_type, observation_status, trigger_score, trend_phase_code, updated_at
       FROM financial_entry_trigger_observations
       ORDER BY updated_at DESC, id DESC
       LIMIT 6`
    );

    const highPrioritySuggestions = await db.all(
      `SELECT s.id, s.symbol, p.name, p.asset_type, s.action_label, s.action_reason, s.priority,
              s.trigger_score, s.trend_phase_code, s.close_price, s.invalidation_line, s.suggestion_date
       FROM financial_action_suggestions s
       JOIN financial_trade_plans p ON p.id = s.plan_id
       WHERE p.is_deleted = 0
         AND s.id IN (
           SELECT MAX(id)
           FROM financial_action_suggestions
           GROUP BY plan_id
         )
       ORDER BY
         CASE s.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
         s.suggestion_date DESC,
         s.id DESC
       LIMIT 6`
    );

    const planReadyItems = await db.all(
      `SELECT id, symbol, name, asset_type, trigger_score, trigger_reason, structure_score,
              trend_phase_code, close_price, invalidation_line, updated_at
       FROM financial_entry_trigger_observations o
       WHERE o.observation_status = 'confirmed'
         AND NOT EXISTS (
           SELECT 1
           FROM financial_trade_plans p
           WHERE p.symbol = o.symbol
             AND p.asset_type = o.asset_type
             AND p.source = o.source
             AND p.is_deleted = 0
             AND p.status IN ('draft', 'watching', 'active')
         )
       ORDER BY
         CASE
           WHEN trend_phase_code = 'SLOW_GRIND_UP' AND trigger_score >= 75 AND structure_score >= 75
                AND close_price > 0 AND invalidation_line > 0
                AND ((close_price - invalidation_line) / close_price) <= 0.04 THEN 0
           WHEN trigger_score >= 80 AND structure_score >= 75 THEN 1
           WHEN trend_phase_code = 'BREAKOUT' AND trigger_score >= 70 AND structure_score >= 75 THEN 2
           WHEN trend_phase_code = 'SLOW_GRIND_UP' THEN 3
           WHEN trend_phase_code = 'BREAKOUT' THEN 4
           WHEN trend_phase_code = 'RECOVERY' THEN 5
           ELSE 9
         END,
         trigger_score DESC,
         CASE
           WHEN close_price > 0 AND invalidation_line > 0 THEN ((close_price - invalidation_line) / close_price)
           ELSE 9
         END ASC,
         updated_at DESC,
         id DESC
       LIMIT 6`
    );

    const pendingTriggerItems = await db.all(
      `SELECT c.id, c.symbol, c.name, c.asset_type, c.priority_score, c.candidate_reason, c.last_review_at
       FROM financial_candidate_pool c
       WHERE c.pool_status = 'active'
         AND c.asset_type IN ('stock', 'etf')
         AND c.review_status = 'wait_confirmation'
         AND NOT EXISTS (
           SELECT 1
           FROM financial_entry_trigger_observations o
           WHERE o.symbol = c.symbol
             AND o.asset_type = c.asset_type
             AND o.source = c.source
             AND o.observation_status IN ('watching', 'plan_candidate', 'confirmed')
         )
       ORDER BY c.priority_score DESC, c.last_review_at DESC, c.id DESC
       LIMIT 6`
    );

    const watchObservationItems = await db.all(
      `SELECT id, symbol, name, asset_type, observation_status, trigger_score, trigger_reason, trend_phase_code, updated_at
       FROM financial_entry_trigger_observations
       WHERE observation_status IN ('watching', 'plan_candidate')
       ORDER BY trigger_score DESC, updated_at DESC, id DESC
       LIMIT 6`
    );

    const invalidatedItems = await db.all(
      `SELECT id, symbol, name, asset_type, 'candidate' as source_type, forbidden_reason as reason, updated_at
       FROM financial_candidate_pool
       WHERE asset_type IN ('stock', 'etf')
         AND review_status = 'rejected'
       UNION ALL
       SELECT id, symbol, name, asset_type, 'observation' as source_type, note as reason, updated_at
       FROM financial_entry_trigger_observations
       WHERE observation_status = 'invalidated'
       ORDER BY updated_at DESC
       LIMIT 6`
    );

    const activePlanRows = await db.all(
      `SELECT p.id as plan_id, p.symbol, p.name, p.asset_type, p.status, p.is_bought,
              p.trigger_reason, p.structure_score, p.trend_phase_code, p.close_price, p.invalidation_line,
              p.updated_at,
              s.id as suggestion_id, s.action_code, s.action_label, s.action_reason, s.priority,
              s.trigger_score, s.trend_phase_code as suggestion_trend_phase_code,
              s.close_price as latest_close, s.invalidation_line as latest_invalidation_line,
              s.base_position_amount, s.tactical_position_amount, s.observation_position_amount,
              s.suggestion_date
       FROM financial_trade_plans p
       LEFT JOIN financial_action_suggestions s ON s.id = (
         SELECT MAX(id)
         FROM financial_action_suggestions
         WHERE plan_id = p.id
       )
       WHERE p.is_deleted = 0
         AND p.status IN ('draft', 'watching', 'paper_tracking', 'active')
       ORDER BY
         CASE COALESCE(s.priority, 'normal') WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
         p.is_bought DESC,
         COALESCE(s.suggestion_date, p.updated_at) DESC
       LIMIT 12`
    );

    const todayFocus: TodayActionItem[] = [
      ...highPrioritySuggestions
        .filter((item: any) => item.priority === 'high')
        .map((item: any) => ({
          id: item.id,
          symbol: item.symbol,
          name: item.name,
          asset_type: item.asset_type,
          label: item.action_label,
          detail: item.action_reason,
          score: item.trigger_score,
          priority: item.priority,
          path: '/finance/trade-plans'
        })),
      ...planReadyItems.map((item: any) => ({
        id: item.id,
        symbol: item.symbol,
        name: item.name,
        asset_type: item.asset_type,
        label: '待生成计划',
        detail: item.trigger_reason,
        score: item.trigger_score,
        priority: 'normal',
        path: '/finance/entry-trigger'
      })),
      ...pendingTriggerItems.slice(0, 3).map((item: any) => ({
        id: item.id,
        symbol: item.symbol,
        name: item.name,
        asset_type: item.asset_type,
        label: '待触发扫描',
        detail: item.candidate_reason,
        score: item.priority_score,
        priority: 'normal',
        path: '/finance/entry-trigger'
      }))
    ].slice(0, 8);

    const todaySummary = {
      focus_items: todayFocus,
      plan_ready: planReadyItems,
      pending_triggers: pendingTriggerItems,
      entry_watch: watchObservationItems,
      risk_alerts: highPrioritySuggestions,
      invalidated: invalidatedItems
    };

    const riskBoardItems = [
      ...activePlanRows.map(buildRiskBoardPlanItem),
      ...planReadyItems.map((item: any) => buildRiskBoardObservationItem(item, 'plan_ready')),
      ...watchObservationItems.map((item: any) => buildRiskBoardObservationItem(item, 'entry_watch'))
    ].sort((a: any, b: any) => {
      const priority = (item: any) => {
        if (item.invalidated) return 0;
        if (item.need_reduce_or_stop_add) return 1;
        if (item.can_prepare) return 2;
        if (item.priority === 'high') return 3;
        return 4;
      };
      return priority(a) - priority(b);
    }).slice(0, 18);

    const riskBoard = {
      summary: {
        total: riskBoardItems.length,
        allowed_to_prepare: riskBoardItems.filter((item: any) => item.can_prepare && !item.invalidated).length,
        reduce_or_stop_add: riskBoardItems.filter((item: any) => item.need_reduce_or_stop_add).length,
        invalidated: riskBoardItems.filter((item: any) => item.invalidated).length,
        just_hold: riskBoardItems.filter((item: any) => item.just_hold).length
      },
      items: riskBoardItems
    };

    const latestPipelineRun = await db.get(
      `SELECT id, status, message, result_json, started_at, finished_at
       FROM task_center_runs
       WHERE task_key = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
      [FINANCE_PIPELINE_TASK_KEY]
    );
    const latestPipelineResult = latestPipelineRun?.result_json ? compactPipelineResult(latestPipelineRun.result_json) : null;
    const dailyChanges = latestPipelineResult ? {
      run_id: latestPipelineRun.id,
      status: latestPipelineRun.status,
      message: latestPipelineRun.message,
      started_at: latestPipelineRun.started_at,
      finished_at: latestPipelineRun.finished_at,
      duration_seconds: getDurationSeconds(latestPipelineRun.started_at, latestPipelineRun.finished_at),
      ...extractDailyChanges(latestPipelineResult)
    } : null;

    res.json({
      success: true,
      data: {
        market: latestMarket || null,
        counts,
        latest_candidates: latestCandidates,
        latest_observations: latestObservations,
        today_summary: todaySummary,
        risk_board: riskBoard,
        daily_changes: dailyChanges
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `获取金融流程总览失败: ${(error as Error).message}`
    });
  }
});

router.get('/daily-pipeline/status', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const task = await ensureFinancePipelineTask(db);
    const runGuard = await buildManualPipelineRunGuard(db);
    const latestRun = await db.get(
      `SELECT *
       FROM task_center_runs
       WHERE task_key = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
      [FINANCE_PIPELINE_TASK_KEY]
    );

    if (latestRun?.result_json) {
      latestRun.result = compactPipelineResult(latestRun.result_json);
      latestRun.duration_seconds = getDurationSeconds(latestRun.started_at, latestRun.finished_at);
      delete latestRun.result_json;
    }

    res.json({
      success: true,
      data: {
        task,
        latest_run: latestRun || null,
        run_guard: runGuard
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `获取金融流水线状态失败: ${(error as Error).message}`
    });
  }
});

router.get('/daily-pipeline/logs', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinancePipelineTask(db);
    const limit = Math.min(Math.max(Number(req.query.limit || 8), 1), 30);
    const runs = await db.all(
      `SELECT id, task_id, task_key, trigger_type, status, message, result_json, started_at, finished_at, created_at
       FROM task_center_runs
       WHERE task_key = ?
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
      [FINANCE_PIPELINE_TASK_KEY, limit]
    );

    const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const items = runs.map((run: any) => {
      const compactResult = compactPipelineResult(run.result_json);
      return {
        id: run.id,
        task_key: run.task_key,
        trigger_type: run.trigger_type,
        status: run.status,
        message: run.message,
        started_at: run.started_at,
        finished_at: run.finished_at,
        created_at: run.created_at,
        duration_seconds: getDurationSeconds(run.started_at, run.finished_at),
        is_today: run.started_at
          ? new Date(run.started_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) === todayKey
          : false,
        result: compactResult
      };
    });

    res.json({
      success: true,
      data: {
        items,
        latest: items[0] || null
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `获取金融流水线日志失败: ${(error as Error).message}`
    });
  }
});

router.post('/daily-pipeline/run', async (req: Request, res: Response) => {
  const db = await getDb();
  const task = await ensureFinancePipelineTask(db);
  const runGuard = await buildManualPipelineRunGuard(db, req.body?.force === true);

  if (!runGuard.can_run) {
    return res.status(runGuard.running ? 409 : 425).json({
      success: false,
      message: runGuard.reason,
      data: {
        run_guard: runGuard
      }
    });
  }

  const startedAt = new Date().toISOString();
  const runResult = await db.run(
    `INSERT INTO task_center_runs (task_id, task_key, trigger_type, status, started_at)
     VALUES (?, ?, 'manual', 'running', ?)`,
    [task.id, FINANCE_PIPELINE_TASK_KEY, startedAt]
  );
  const runId = runResult.lastID;

  try {
    const config = {
      ...parseJsonConfig(task.config_json),
      ...(req.body?.config || {})
    };
    const result = await runFinanceDailyPipeline(config);
    const failedStep = result.steps.find((step: any) => step.status === 'error');
    const status = failedStep ? 'error' : 'success';
    const message = failedStep
      ? `金融日终流水线失败：停在「${failedStep.label}」 - ${failedStep.message || '原因未知'}`
      : `金融日终流水线完成：${result.summary.success}/${result.summary.total} 步完成`;

    await db.run(
      `UPDATE task_center_runs
       SET status = ?, message = ?, result_json = ?, finished_at = ?
       WHERE id = ?`,
      [status, message, JSON.stringify(result), new Date().toISOString(), runId]
    );
    await db.run(
      `UPDATE task_center_tasks
       SET last_status = ?, last_message = ?, last_run_at = ?, updated_at = ?
       WHERE id = ?`,
      [status, message, new Date().toISOString(), new Date().toISOString(), task.id]
    );

    res.status(failedStep ? 500 : 200).json({
      success: !failedStep,
      message,
      data: result
    });
  } catch (error) {
    const message = `金融日终流水线执行失败: ${(error as Error).message}`;
    await db.run(
      `UPDATE task_center_runs
       SET status = 'error', message = ?, finished_at = ?
       WHERE id = ?`,
      [message, new Date().toISOString(), runId]
    );
    await db.run(
      `UPDATE task_center_tasks
       SET last_status = 'error', last_message = ?, last_run_at = ?, updated_at = ?
       WHERE id = ?`,
      [message, new Date().toISOString(), new Date().toISOString(), task.id]
    );
    res.status(500).json({ success: false, message });
  }
});

router.get('/candidate-funnel/status', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const task = await ensureFinanceFunnelTask(db);
    const runGuard = await buildManualFunnelRunGuard(db);
    const latestRun = await db.get(
      `SELECT *
       FROM task_center_runs
       WHERE task_key = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
      [FINANCE_FUNNEL_TASK_KEY]
    );

    if (latestRun?.result_json) {
      latestRun.result = compactPipelineResult(latestRun.result_json);
      latestRun.duration_seconds = getDurationSeconds(latestRun.started_at, latestRun.finished_at);
      delete latestRun.result_json;
    }

    res.json({
      success: true,
      data: {
        task,
        latest_run: latestRun || null,
        run_guard: runGuard
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `获取入池漏斗流水线状态失败: ${(error as Error).message}`
    });
  }
});

router.post('/candidate-funnel/run', async (req: Request, res: Response) => {
  const db = await getDb();
  const task = await ensureFinanceFunnelTask(db);
  const runGuard = await buildManualFunnelRunGuard(db);

  if (!runGuard.can_run) {
    return res.status(409).json({
      success: false,
      message: runGuard.reason,
      data: { run_guard: runGuard }
    });
  }

  const startedAt = new Date().toISOString();
  const runResult = await db.run(
    `INSERT INTO task_center_runs (task_id, task_key, trigger_type, status, started_at)
     VALUES (?, ?, 'manual', 'running', ?)`,
    [task.id, FINANCE_FUNNEL_TASK_KEY, startedAt]
  );
  const runId = runResult.lastID;

  try {
    const config = {
      ...parseJsonConfig(task.config_json),
      ...(req.body?.config || {})
    };
    const result = await runFinanceCandidateFunnelPipeline(config);
    const failedStep = result.steps.find((step: any) => step.status === 'error');
    const status = failedStep ? 'error' : 'success';
    const message = failedStep
      ? `入池漏斗流水线失败：停在「${failedStep.label}」 - ${failedStep.message || '原因未知'}`
      : `入池漏斗流水线完成：${result.summary.success}/${result.summary.total} 步完成`;

    await db.run(
      `UPDATE task_center_runs
       SET status = ?, message = ?, result_json = ?, finished_at = ?
       WHERE id = ?`,
      [status, message, JSON.stringify(result), new Date().toISOString(), runId]
    );
    await db.run(
      `UPDATE task_center_tasks
       SET last_status = ?, last_message = ?, last_run_at = ?, updated_at = ?
       WHERE id = ?`,
      [status, message, new Date().toISOString(), new Date().toISOString(), task.id]
    );

    res.status(failedStep ? 500 : 200).json({
      success: !failedStep,
      message,
      data: result
    });
  } catch (error) {
    const message = `入池漏斗流水线执行失败: ${(error as Error).message}`;
    await db.run(
      `UPDATE task_center_runs
       SET status = 'error', message = ?, finished_at = ?
       WHERE id = ?`,
      [message, new Date().toISOString(), runId]
    );
    await db.run(
      `UPDATE task_center_tasks
       SET last_status = 'error', last_message = ?, last_run_at = ?, updated_at = ?
       WHERE id = ?`,
      [message, new Date().toISOString(), new Date().toISOString(), task.id]
    );
    res.status(500).json({ success: false, message });
  }
});

function roundNumber(value: number | null | undefined, digits = 2): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function calculateCloseAverage(prices: DailyPrice[], window: number, endExclusive = prices.length): number | null {
  if (endExclusive < window) return null;
  const slice = prices.slice(endExclusive - window, endExclusive);
  if (slice.length < window) return null;
  return slice.reduce((sum, price) => sum + price.close, 0) / window;
}

function getSlope(current: number | null, previous: number | null): string {
  if (current === null || previous === null) return 'unknown';
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
}

function percentChange(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined || previous === 0) return null;
  return current / previous - 1;
}

function averageDailyRange(prices: DailyPrice[]): number | null {
  if (prices.length === 0) return null;
  const values = prices
    .map(price => {
      const close = price.close || 0;
      if (close <= 0) return null;
      const high = price.high || price.close;
      const low = price.low || price.close;
      return (high - low) / close;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countTrailingDirectionDays(prices: DailyPrice[], direction: 'up' | 'down'): number {
  let count = 0;
  for (let i = prices.length - 1; i > 0; i--) {
    const current = prices[i].close;
    const previous = prices[i - 1].close;
    if (direction === 'up' && current > previous) {
      count++;
      continue;
    }
    if (direction === 'down' && current < previous) {
      count++;
      continue;
    }
    break;
  }
  return count;
}

function getMarketRegimeShortLabel(regime: string): string {
  switch (regime) {
    case 'NORMAL': return '中期正常区';
    case 'NORMAL_CONFIRMED': return '中期正常确认区';
    case 'RISK': return '中期风险区';
    case 'CRASH_WARNING': return '中期股灾预警';
    case 'CRASH': return '中期冻结区';
    case 'DEEP_CRASH': return '中期深度股灾区';
    case 'REBUILD_WATCH': return '中期修复观察区';
    case 'UNKNOWN': return '中期状态未确认';
    default: return regime;
  }
}

function addBehaviorTag(tags: MarketBehaviorTag[], tag: MarketBehaviorTag) {
  if (!tags.some(item => item.code === tag.code)) {
    tags.push(tag);
  }
}

function calculateMarketRegime(prices: DailyPrice[], isMock: boolean, source: string, symbol = '000300'): MarketRegime {
  const name = getMarketAssetMeta(symbol).name;
  const ruleVersion = 'market_regime_v1.1';
  const cycleLayerVersion = 'market_cycle_layers_v1';
  
  if (prices.length < 120) {
    return {
      symbol,
      name,
      trade_date: prices.length > 0 ? prices[prices.length - 1].trade_date : '',
      close: prices.length > 0 ? prices[prices.length - 1].close : 0,
      ma20: null,
      ma20_slope: 'unknown',
      ma60: 0,
      ma60_prev: 0,
      ma60_slope: 'unknown',
      ma120: null,
      ma120_prev: null,
      ma120_slope: 'unknown',
      ma250: null,
      ma250_prev: null,
      ma250_slope: 'unknown',
      low_60: null,
      low_120: null,
      cross_count_10: 0,
      above_ma60_days: 0,
      below_ma60_days: 0,
      drawdown_20: 0,
      drawdown_60: 0,
      drawdown_120: 0,
      latest_change: null,
      distance_to_ma60: 0,
      distance_to_ma250: null,
      higher_high: false,
      higher_low: false,
      lower_high: false,
      lower_low: false,
      sideways: false,
      up_days: 0,
      down_days: 0,
      market_regime: 'UNKNOWN',
      result_reason: '历史数据不足120个交易日，暂无法完整判定股灾分级。',
      entry_permission: 'OBSERVE_ONLY',
      entry_reason: '状态不明确，仅观察。',
      rule_version: ruleVersion,
      cycle_layer_version: cycleLayerVersion,
      short_state: 'SHORT_UNKNOWN',
      short_label: '短期状态未确认',
      short_reason: '历史数据不足，暂不能识别短期行为。',
      mid_state: 'UNKNOWN',
      mid_label: '中期状态未确认',
      mid_reason: '历史数据不足120个交易日，暂无法完整判定中期总闸。',
      long_state: 'LONG_UNKNOWN',
      long_label: '长期牛熊未确认',
      long_reason: '历史数据不足250个交易日，暂不能用MA250判断长期牛熊。',
      behavior_tags: [],
      is_mock: isMock,
      source
    };
  }
  
  const latestPrice = prices[prices.length - 1];
  const close = latestPrice.close;
  const trade_date = latestPrice.trade_date;

  const ma20 = calculateCloseAverage(prices, 20);
  const ma20_prev = calculateCloseAverage(prices, 20, prices.length - 1);
  const ma120 = calculateCloseAverage(prices, 120);
  const ma120_prev = calculateCloseAverage(prices, 120, prices.length - 1);
  const ma250 = calculateCloseAverage(prices, 250);
  const ma250_prev = calculateCloseAverage(prices, 250, prices.length - 1);
  const ma20_slope = getSlope(ma20, ma20_prev);
  const ma120_slope = getSlope(ma120, ma120_prev);
  const ma250_slope = getSlope(ma250, ma250_prev);

  const last60Prices = prices.slice(-60);
  const ma60 = last60Prices.reduce((sum, p) => sum + p.close, 0) / 60;
  
  const prev60Prices = prices.slice(-61, -1);
  const ma60_prev = prev60Prices.reduce((sum, p) => sum + p.close, 0) / 60;
  
  let ma60_slope: string;
  if (ma60 < ma60_prev) {
    ma60_slope = 'down';
  } else if (ma60 > ma60_prev) {
    ma60_slope = 'up';
  } else {
    ma60_slope = 'flat';
  }
  
  const low_60 = Math.min(...last60Prices.map(p => p.close));
  
  const last120Prices = prices.slice(-120);
  const low_120 = Math.min(...last120Prices.map(p => p.close));

  const latest_change = prices.length >= 2 ? percentChange(close, prices[prices.length - 2].close) : null;
  const return_5d = prices.length >= 6 ? percentChange(close, prices[prices.length - 6].close) : null;
  
  const close_20_days_ago = prices.length >= 21 ? prices[prices.length - 21].close : null;
  const close_60_days_ago = prices.length >= 61 ? prices[prices.length - 61].close : null;
  const close_120_days_ago = prices.length >= 121 ? prices[prices.length - 121].close : null;
  
  const drawdown_20 = close_20_days_ago !== null ? (close / close_20_days_ago) - 1 : null;
  const drawdown_60 = close_60_days_ago !== null ? (close / close_60_days_ago) - 1 : null;
  const drawdown_120 = close_120_days_ago !== null ? (close / close_120_days_ago) - 1 : null;
  
  const distance_to_ma60 = (close - ma60) / ma60;
  const distance_to_ma250 = ma250 !== null ? percentChange(close, ma250) : null;

  const last20Prices = prices.slice(-20);
  const prev20Prices = prices.slice(-40, -20);
  const last20High = Math.max(...last20Prices.map(price => price.high || price.close));
  const last20Low = Math.min(...last20Prices.map(price => price.low || price.close));
  const prev20High = prev20Prices.length === 20 ? Math.max(...prev20Prices.map(price => price.high || price.close)) : null;
  const prev20Low = prev20Prices.length === 20 ? Math.min(...prev20Prices.map(price => price.low || price.close)) : null;
  const higher_high = prev20High !== null && last20High > prev20High * 1.005;
  const higher_low = prev20Low !== null && last20Low > prev20Low * 1.005;
  const lower_high = prev20High !== null && last20High < prev20High * 0.995;
  const lower_low = prev20Low !== null && last20Low < prev20Low * 0.995;
  const range_20d = last20Low > 0 ? (last20High - last20Low) / last20Low : null;
  const sideways = range_20d !== null && range_20d <= 0.06 && drawdown_20 !== null && Math.abs(drawdown_20) <= 0.025 && !higher_high && !lower_low;
  const up_days = countTrailingDirectionDays(prices, 'up');
  const down_days = countTrailingDirectionDays(prices, 'down');
  const recentRange = averageDailyRange(prices.slice(-5));
  const previousRange = averageDailyRange(prices.slice(-25, -5));
  const volatilityExpanding = recentRange !== null && previousRange !== null && recentRange > previousRange * 1.35 && recentRange > 0.015;
  const volatilityContracting = recentRange !== null && previousRange !== null && recentRange < previousRange * 0.75;
  
  const getMA60At = (index: number): number | null => {
    if (index < 59) return null;
    const slice = prices.slice(index - 59, index + 1);
    return slice.reduce((sum, p) => sum + p.close, 0) / 60;
  };
  
  let cross_count_10 = 0;
  const last10Prices = prices.slice(-10);
  let prevSide: 'above' | 'below' | null = null;
  
  for (let i = 0; i < last10Prices.length; i++) {
    const globalIndex = prices.length - 10 + i;
    const dayMA60 = getMA60At(globalIndex);
    
    if (dayMA60 === null) continue;
    
    let currentSide: 'above' | 'below' | 'equal';
    if (last10Prices[i].close > dayMA60) {
      currentSide = 'above';
    } else if (last10Prices[i].close < dayMA60) {
      currentSide = 'below';
    } else {
      currentSide = 'equal';
    }
    
    if (currentSide !== 'equal') {
      if (prevSide !== null && prevSide !== currentSide) {
        cross_count_10++;
      }
      prevSide = currentSide;
    }
  }
  
  let above_ma60_days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA60 = getMA60At(i);
    if (dayMA60 === null) break;
    if (prices[i].close > dayMA60) {
      above_ma60_days++;
    } else {
      break;
    }
  }
  
  let below_ma60_days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA60 = getMA60At(i);
    if (dayMA60 === null) break;
    if (prices[i].close < dayMA60) {
      below_ma60_days++;
    } else {
      break;
    }
  }
  
  let market_regime = 'UNKNOWN';
  let result_reason = '当前数据不满足明确状态，继续观察。';
  
  if ((drawdown_60 !== null && drawdown_60 <= -0.20) || 
      (drawdown_120 !== null && drawdown_120 <= -0.25) || 
      distance_to_ma60 <= -0.10) {
    market_regime = 'DEEP_CRASH';
    result_reason = '市场进入深度股灾区，极端机会开始出现，但禁止直接抄底，等待安全区 + 结构成立。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if ((close < ma60 && ma60 < ma60_prev && drawdown_20 !== null && drawdown_20 <= -0.10) || 
             (low_120 !== null && close < low_120) || 
             (drawdown_60 !== null && drawdown_60 <= -0.15)) {
    market_regime = 'CRASH';
    result_reason = '市场进入股灾/冻结区，不抄底，等待结构重建。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if ((close < ma60 && ma60 < ma60_prev) || 
             (low_60 !== null && close < low_60) || 
             (drawdown_20 !== null && drawdown_20 <= -0.08) || 
             below_ma60_days >= 3) {
    market_regime = 'CRASH_WARNING';
    result_reason = '市场进入股灾预警区，开始重点观察，但不抄底，不接飞刀。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if ((drawdown_120 !== null && drawdown_120 <= -0.08) && 
             close > ma60 && 
             above_ma60_days >= 3) {
    market_regime = 'REBUILD_WATCH';
    result_reason = '市场处于修复观察区，短期已站回MA60，但120日跌幅仍较深（-8%以内），不能直接视为正常确认。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if (cross_count_10 >= 2 || 
             (close < ma60 && ma60 >= ma60_prev) || 
             (drawdown_20 !== null && drawdown_20 <= -0.05 && drawdown_20 > -0.08)) {
    market_regime = 'RISK';
    result_reason = '市场处于风险区，只观察，降速，不急于建仓。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if (close > ma60 && ma60 >= ma60_prev && above_ma60_days >= 5 && cross_count_10 < 2 && 
             (drawdown_120 === null || drawdown_120 > -0.08)) {
    market_regime = 'NORMAL_CONFIRMED';
    result_reason = '收盘价站上MA60并连续站稳5天，MA60未下弯，120日跌幅已修复至-8%以内，市场进入正常确认区。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if (close > ma60 && ma60 >= ma60_prev && cross_count_10 < 2 && 
             (drawdown_20 === null || drawdown_20 > -0.08) && 
             (drawdown_60 === null || drawdown_60 > -0.15) &&
             (drawdown_120 === null || drawdown_120 > -0.08)) {
    market_regime = 'NORMAL';
    result_reason = '市场处于正常观察区，可以继续观察个股/ETF结构。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  }
  
  let entry_permission = 'OBSERVE_ONLY';
  let entry_reason = '状态不明确，仅观察。';
  
  if (market_regime === 'DEEP_CRASH' || market_regime === 'CRASH') {
    entry_permission = 'FREEZE';
    entry_reason = '市场冻结，不允许建仓，只观察，等待结构重建。';
  } else if (market_regime === 'CRASH_WARNING') {
    entry_permission = 'WATCH_FOR_REBUILD';
    entry_reason = '股灾预警，等待止跌和结构修复。';
  } else if (market_regime === 'REBUILD_WATCH') {
    entry_permission = 'WATCH_FOR_REBUILD';
    entry_reason = '市场处于深跌后的修复观察区，短期已有反弹，但长周期仍未完全修复，等待结构进一步确认。';
  } else if (market_regime === 'RISK') {
    entry_permission = 'OBSERVE_ONLY';
    entry_reason = '风险区，只观察，不主动扩大仓位。';
  } else if (market_regime === 'NORMAL' || market_regime === 'NORMAL_CONFIRMED') {
    entry_permission = 'ALLOW_STRUCTURE_CHECK';
    entry_reason = '允许进入个股/ETF结构判断，但仍需安全区 + 结构成立 + 失效线。';
  }

  const behavior_tags: MarketBehaviorTag[] = [];
  const hasFastUp = latest_change !== null && latest_change >= 0.03;
  const hasFastDown = latest_change !== null && latest_change <= -0.03;
  const hasFiveDayFastUp = return_5d !== null && return_5d >= 0.06;
  const hasFiveDayFastDown = return_5d !== null && return_5d <= -0.06;
  const isSlowGrindUp = drawdown_20 !== null
    && drawdown_20 >= 0.02
    && drawdown_20 <= 0.10
    && ma20 !== null
    && close > ma20
    && ma20_slope !== 'down'
    && higher_low
    && !volatilityExpanding;
  const isSlowBleed = drawdown_20 !== null
    && drawdown_20 <= -0.025
    && drawdown_20 >= -0.10
    && ma20 !== null
    && (close < ma20 || lower_high)
    && !hasFastDown
    && !volatilityExpanding;

  if (hasFastUp) {
    addBehaviorTag(behavior_tags, { code: 'SURGE', label: '暴涨', tone: 'warn', reason: '单日涨幅达到3%以上，防止情绪追高。' });
  }
  if (hasFastDown) {
    addBehaviorTag(behavior_tags, { code: 'CRASH_DAY', label: '暴跌', tone: 'risk', reason: '单日跌幅达到3%以上，优先观察是否破位。' });
  }
  if (hasFiveDayFastUp) {
    addBehaviorTag(behavior_tags, { code: 'FAST_UP_5D', label: '短期急涨', tone: 'warn', reason: '5日涨幅达到6%以上，注意短线拥挤。' });
  }
  if (hasFiveDayFastDown) {
    addBehaviorTag(behavior_tags, { code: 'FAST_DOWN_5D', label: '短期急跌', tone: 'risk', reason: '5日跌幅达到6%以上，先看风险释放和止跌结构。' });
  }
  if (up_days >= 4) {
    addBehaviorTag(behavior_tags, { code: 'CONSECUTIVE_UP', label: '连续上涨', tone: 'warn', reason: `已连续${up_days}个交易日收盘上涨，短期不宜追。` });
  }
  if (down_days >= 4) {
    addBehaviorTag(behavior_tags, { code: 'CONSECUTIVE_DOWN', label: '连续下跌', tone: 'risk', reason: `已连续${down_days}个交易日收盘下跌，等待止跌确认。` });
  }
  if (isSlowGrindUp) {
    addBehaviorTag(behavior_tags, { code: 'SLOW_GRIND_UP', label: '慢涨', tone: 'good', reason: '20日温和上行，低点抬高且波动未明显放大。' });
  }
  if (isSlowBleed) {
    addBehaviorTag(behavior_tags, { code: 'SLOW_BLEED', label: '阴跌', tone: 'risk', reason: '20日缓慢走弱，价格低于短均线或高点抬低。' });
  }
  if (sideways) {
    addBehaviorTag(behavior_tags, { code: 'SIDEWAYS', label: '横盘震荡', tone: 'neutral', reason: '近20日振幅和涨跌幅都较小，等待方向选择。' });
  }
  if (higher_high) {
    addBehaviorTag(behavior_tags, { code: 'HIGHER_HIGH', label: '高点抬高', tone: 'good', reason: '近20日高点高于前20日，攻击结构有改善。' });
  }
  if (higher_low) {
    addBehaviorTag(behavior_tags, { code: 'HIGHER_LOW', label: '低点抬高', tone: 'good', reason: '近20日低点高于前20日，承接结构有改善。' });
  }
  if (lower_high) {
    addBehaviorTag(behavior_tags, { code: 'LOWER_HIGH', label: '高点抬低', tone: 'risk', reason: '近20日高点低于前20日，反弹高度不足。' });
  }
  if (lower_low) {
    addBehaviorTag(behavior_tags, { code: 'LOWER_LOW', label: '低点抬低', tone: 'risk', reason: '近20日低点低于前20日，防止趋势转弱。' });
  }
  if (volatilityExpanding) {
    addBehaviorTag(behavior_tags, { code: 'VOL_EXPAND', label: '波动放大', tone: 'warn', reason: '近5日平均振幅明显高于前20日，仓位要降速。' });
  } else if (volatilityContracting) {
    addBehaviorTag(behavior_tags, { code: 'VOL_CONTRACT', label: '波动收敛', tone: 'neutral', reason: '近5日平均振幅低于前20日，等待突破或回踩确认。' });
  }

  let short_state = 'SHORT_NEUTRAL';
  let short_label = '短期中性';
  let short_reason = '短期行为没有明显极端特征，继续观察。';
  if (hasFastDown || hasFiveDayFastDown) {
    short_state = 'SHORT_FAST_DOWN';
    short_label = '短期急跌';
    short_reason = '出现单日或5日急跌，先看风险释放和止跌结构。';
  } else if (hasFastUp || hasFiveDayFastUp) {
    short_state = 'SHORT_FAST_UP';
    short_label = '短期急涨';
    short_reason = '出现单日或5日急涨，防追高，等待回踩不破。';
  } else if (isSlowBleed) {
    short_state = 'SHORT_SLOW_BLEED';
    short_label = '短期阴跌';
    short_reason = '价格缓慢走弱但未出现极端暴跌，先防慢性破位。';
  } else if (isSlowGrindUp) {
    short_state = 'SHORT_SLOW_GRIND_UP';
    short_label = '短期慢涨';
    short_reason = '温和上行、低点抬高且波动未失控，短期行为较健康。';
  } else if (sideways) {
    short_state = 'SHORT_SIDEWAYS';
    short_label = '短期横盘震荡';
    short_reason = '近20日方向不强，等待突破、回踩或跌破后的确认。';
  } else if (lower_high && lower_low) {
    short_state = 'SHORT_WEAK';
    short_label = '短期转弱';
    short_reason = '高点和低点同时抬低，短期偏弱。';
  } else if (higher_high && higher_low) {
    short_state = 'SHORT_UP';
    short_label = '短期走强';
    short_reason = '高点和低点同步抬高，短期结构改善。';
  } else if (up_days >= 4) {
    short_state = 'SHORT_CONSECUTIVE_UP';
    short_label = '短期连续上涨';
    short_reason = `已连续${up_days}个交易日上涨，注意短线追高风险。`;
  } else if (down_days >= 4) {
    short_state = 'SHORT_CONSECUTIVE_DOWN';
    short_label = '短期连续下跌';
    short_reason = `已连续${down_days}个交易日下跌，等待止跌确认。`;
  }

  const getMA250At = (index: number): number | null => {
    if (index < 249) return null;
    const slice = prices.slice(index - 249, index + 1);
    return slice.reduce((sum, price) => sum + price.close, 0) / 250;
  };

  let above_ma250_days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA250 = getMA250At(i);
    if (dayMA250 === null) break;
    if (prices[i].close > dayMA250) {
      above_ma250_days++;
    } else {
      break;
    }
  }

  let below_ma250_days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA250 = getMA250At(i);
    if (dayMA250 === null) break;
    if (prices[i].close < dayMA250) {
      below_ma250_days++;
    } else {
      break;
    }
  }

  const ma250_60ago = prices.length >= 310 ? getMA250At(prices.length - 61) : null;
  const ma250_slope_60 = ma250 !== null && ma250_60ago !== null && ma250_60ago > 0
    ? ma250 / ma250_60ago - 1
    : null;
  const ma250_long_slope =
    ma250_slope_60 === null ? 'unknown' :
    ma250_slope_60 >= 0.01 ? 'up' :
    ma250_slope_60 <= -0.01 ? 'down' :
    'flat';

  let long_state = 'LONG_UNKNOWN';
  let long_label = '长期牛熊未确认';
  let long_reason = '历史数据不足250个交易日，暂不能用MA250判断长期牛熊。';
  if (ma250 !== null) {
    const slopeText = ma250_long_slope === 'up' ? '上行' : ma250_long_slope === 'down' ? '下行' : ma250_long_slope === 'flat' ? '走平' : '未知';
    const ma120Text = ma120_slope === 'up' ? '上行' : ma120_slope === 'down' ? '下行' : ma120_slope === 'flat' ? '走平' : '未知';
    const distanceText = distance_to_ma250 === null ? '--' : `${(distance_to_ma250 * 100).toFixed(2)}%`;
    const aboveBuffer = distance_to_ma250 !== null && distance_to_ma250 >= 0.02;
    const belowBuffer = distance_to_ma250 !== null && distance_to_ma250 <= -0.02;
    const sustainedAbove = above_ma250_days >= 30;
    const sustainedBelow = below_ma250_days >= 30;
    const confirmedBull = aboveBuffer && sustainedAbove && ma250_long_slope !== 'down' && ma120_slope !== 'down';
    const confirmedBear = belowBuffer && sustainedBelow && ma250_long_slope === 'down' && (ma120_slope === 'down' || lower_high || lower_low);
    const repairWatch = aboveBuffer && above_ma250_days >= 10 && ma250_long_slope !== 'down' && (ma120_slope !== 'down' || higher_low);
    const weakenWatch = belowBuffer && below_ma250_days >= 10 && ma250_long_slope !== 'up' && (ma120_slope === 'down' || lower_high || lower_low);

    if (confirmedBull) {
      long_state = 'LONG_BULL';
      long_label = '长期牛市';
      long_reason = `收盘价在MA250上方且偏离 ${distanceText}，已连续站上MA250 ${above_ma250_days} 天，MA250约60日斜率${slopeText}，MA120${ma120Text}，长期背景偏牛。`;
    } else if (confirmedBear) {
      long_state = 'LONG_BEAR';
      long_label = '长期熊市';
      long_reason = `收盘价在MA250下方且偏离 ${distanceText}，已连续跌破MA250 ${below_ma250_days} 天，MA250约60日斜率${slopeText}，长期背景偏熊。`;
    } else if (repairWatch) {
      long_state = 'LONG_BEAR_TO_BULL';
      long_label = '长期转强观察';
      long_reason = `收盘价重新站上MA250并偏离 ${distanceText}，已连续站上 ${above_ma250_days} 天，MA250约60日斜率${slopeText}；先记为长期转强观察，不直接等同牛市确认。`;
    } else if (weakenWatch) {
      long_state = 'LONG_BULL_TO_BEAR';
      long_label = '长期转弱观察';
      long_reason = `收盘价跌破MA250并偏离 ${distanceText}，已连续跌破 ${below_ma250_days} 天，MA250约60日斜率${slopeText}；先记为长期转弱观察，不直接等同熊市确认。`;
    } else if (close > ma250 && ma250_long_slope !== 'down') {
      long_state = 'LONG_BULL_PULLBACK';
      long_label = '长期牛市回撤';
      long_reason = `价格仍在MA250上方，但连续站上天数/偏离或长期斜率还没满足牛市确认；先按MA250上方震荡或牛市回撤观察。`;
    } else {
      long_state = 'LONG_TRANSITION';
      long_label = '长期均线争夺';
      long_reason = `价格在MA250附近或长期斜率未确认，当前偏离 ${distanceText}；不把MA250附近来回穿越直接判成牛熊转换。`;
    }
  }
  
  return {
    symbol,
    name,
    trade_date,
    close,
    ma20: roundNumber(ma20, 2),
    ma20_slope,
    ma60: Math.round(ma60 * 100) / 100,
    ma60_prev: Math.round(ma60_prev * 100) / 100,
    ma60_slope,
    ma120: roundNumber(ma120, 2),
    ma120_prev: roundNumber(ma120_prev, 2),
    ma120_slope,
    ma250: roundNumber(ma250, 2),
    ma250_prev: roundNumber(ma250_prev, 2),
    ma250_slope,
    low_60: low_60 !== null ? Math.round(low_60 * 100) / 100 : null,
    low_120: low_120 !== null ? Math.round(low_120 * 100) / 100 : null,
    cross_count_10,
    above_ma60_days,
    below_ma60_days,
    drawdown_20: drawdown_20 !== null ? Math.round(drawdown_20 * 10000) / 10000 : null,
    drawdown_60: drawdown_60 !== null ? Math.round(drawdown_60 * 10000) / 10000 : null,
    drawdown_120: drawdown_120 !== null ? Math.round(drawdown_120 * 10000) / 10000 : null,
    latest_change: roundNumber(latest_change, 4),
    distance_to_ma60: Math.round(distance_to_ma60 * 10000) / 10000,
    distance_to_ma250: roundNumber(distance_to_ma250, 4),
    higher_high,
    higher_low,
    lower_high,
    lower_low,
    sideways,
    up_days,
    down_days,
    market_regime,
    result_reason,
    entry_permission,
    entry_reason,
    rule_version: ruleVersion,
    cycle_layer_version: cycleLayerVersion,
    short_state,
    short_label,
    short_reason,
    mid_state: market_regime,
    mid_label: getMarketRegimeShortLabel(market_regime),
    mid_reason: result_reason,
    long_state,
    long_label,
    long_reason,
    behavior_tags,
    is_mock: isMock,
    source
  };
}

async function saveMarketRegime(regime: MarketRegime): Promise<void> {
  const db = await getDb();
  await db.run(
    `INSERT INTO financial_market_regime 
      (symbol, name, trade_date, close, ma60, ma60_prev, ma60_slope, low_60, low_120, cross_count_10, above_ma60_days, below_ma60_days, drawdown_20, drawdown_60, drawdown_120, distance_to_ma60, market_regime, result_reason, entry_permission, entry_reason, rule_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [regime.symbol, regime.name, regime.trade_date, regime.close, regime.ma60, regime.ma60_prev, regime.ma60_slope, regime.low_60, regime.low_120, regime.cross_count_10, regime.above_ma60_days, regime.below_ma60_days, regime.drawdown_20, regime.drawdown_60, regime.drawdown_120, regime.distance_to_ma60, regime.market_regime, regime.result_reason, regime.entry_permission, regime.entry_reason, regime.rule_version]
  );
}

function pickCycleLayerFields(regime: MarketRegime) {
  return {
    ma20: regime.ma20,
    ma20_slope: regime.ma20_slope,
    ma120: regime.ma120,
    ma120_prev: regime.ma120_prev,
    ma120_slope: regime.ma120_slope,
    ma250: regime.ma250,
    ma250_prev: regime.ma250_prev,
    ma250_slope: regime.ma250_slope,
    latest_change: regime.latest_change,
    distance_to_ma250: regime.distance_to_ma250,
    higher_high: regime.higher_high,
    higher_low: regime.higher_low,
    lower_high: regime.lower_high,
    lower_low: regime.lower_low,
    sideways: regime.sideways,
    up_days: regime.up_days,
    down_days: regime.down_days,
    cycle_layer_version: regime.cycle_layer_version,
    short_state: regime.short_state,
    short_label: regime.short_label,
    short_reason: regime.short_reason,
    mid_state: regime.mid_state,
    mid_label: regime.mid_label,
    mid_reason: regime.mid_reason,
    long_state: regime.long_state,
    long_label: regime.long_label,
    long_reason: regime.long_reason,
    behavior_tags: regime.behavior_tags
  };
}

async function enrichMarketRegimeWithCycleLayers(regime: any | null, symbol: string, source: string, isMock = false): Promise<any | null> {
  if (!regime) return regime;
  try {
    const prices = await getDailyPrices(symbol, source);
    if (prices.length >= 120) {
      const enriched = calculateMarketRegime(prices, isMock, source, symbol);
      return {
        ...regime,
        ...pickCycleLayerFields(enriched),
        mid_state: regime.market_regime || enriched.market_regime,
        mid_label: getMarketRegimeShortLabel(regime.market_regime || enriched.market_regime),
        mid_reason: regime.result_reason || enriched.result_reason,
        source,
        is_mock: isMock
      };
    }
  } catch (error) {
    console.warn(`enrich market cycle layers failed for ${symbol}:`, (error as Error).message);
  }

  return {
    ...regime,
    cycle_layer_version: 'market_cycle_layers_v1',
    short_state: regime.short_state || 'SHORT_UNKNOWN',
    short_label: regime.short_label || '短期状态未确认',
    short_reason: regime.short_reason || '未能读取足够日线，暂不显示短期行为。',
    mid_state: regime.market_regime || 'UNKNOWN',
    mid_label: getMarketRegimeShortLabel(regime.market_regime || 'UNKNOWN'),
    mid_reason: regime.result_reason || '沿用现有中期总闸结果。',
    long_state: regime.long_state || 'LONG_UNKNOWN',
    long_label: regime.long_label || '长期牛熊未确认',
    long_reason: regime.long_reason || '未能读取足够MA250数据，暂不显示长期牛熊。',
    behavior_tags: regime.behavior_tags || [],
    source,
    is_mock: isMock
  };
}

async function getOrCalculateLatestRegime(symbol: string): Promise<any | null> {
  const source = getPreferredMarketSource(symbol);
  const latest = await getLatestRegime(symbol);
  if (latest) {
    return enrichMarketRegimeWithCycleLayers(latest, symbol, source, false);
  }

  const prices = await getDailyPrices(symbol, source);
  if (prices.length < 60) return null;

  const regime = calculateMarketRegime(prices, false, source, symbol);
  await saveMarketRegime(regime);
  return { ...regime, source, is_mock: false };
}

function getOpportunityStatus(regime?: any | null): { status: string; label: string; reason: string; score: number } {
  if (!regime) {
    return { status: 'NO_DATA', label: '无数据', reason: '本地日线不足，先更新数据。', score: 0 };
  }
  switch (regime.entry_permission) {
    case 'ALLOW_STRUCTURE_CHECK':
      return { status: 'SUITABLE', label: '适合筛选', reason: regime.entry_reason || '允许进入单标的判断。', score: 85 };
    case 'OBSERVE_ONLY':
      return { status: 'OBSERVE', label: '只观察', reason: regime.entry_reason || '风险区，只观察。', score: 45 };
    case 'WATCH_FOR_REBUILD':
      return { status: 'REBUILD_WATCH', label: '等待修复', reason: regime.entry_reason || '等待结构重建。', score: 30 };
    case 'FREEZE':
      return { status: 'FREEZE', label: '冻结', reason: regime.entry_reason || '市场冻结，不允许建仓。', score: 10 };
    default:
      return { status: 'UNKNOWN', label: '未确认', reason: '状态不明确。', score: 20 };
  }
}

function buildEnvironmentConclusion(items: any[]) {
  const byRole = new Map(items.map(item => [item.role, item]));
  const industryItems = items.filter(item => item.category === 'industry');
  const strongIndustries = industryItems.filter(item => item.opportunity.status === 'SUITABLE');
  const suitable: string[] = [];

  if (byRole.get('core_large')?.opportunity.status === 'SUITABLE') suitable.push('宽基');
  if (byRole.get('mid_small')?.opportunity.status === 'SUITABLE') suitable.push('中小盘');
  if (byRole.get('growth')?.opportunity.status === 'SUITABLE') suitable.push('成长');
  if (byRole.get('tech_volatility')?.opportunity.status === 'SUITABLE') suitable.push('科技高波动');
  if (strongIndustries.length > 0) suitable.push('行业ETF');

  if (suitable.length === 0) {
    return {
      mode: 'OBSERVE_ONLY',
      title: '只观察',
      summary: '主要市场维度尚未形成可操作环境，等待结构修复。',
      suitable_types: [],
      industry_focus: []
    };
  }

  return {
    mode: 'SELECTIVE',
    title: `适合关注：${suitable.join(' / ')}`,
    summary: `当前更适合从 ${suitable.join('、')} 中做单标的结构判断，买点仍由安全区、结构成立和失效线决定。`,
    suitable_types: suitable,
    industry_focus: strongIndustries.map(item => ({ symbol: item.symbol, name: item.name, regime: item.market_regime }))
  };
}

router.post('/market/index/update', async (req: Request, res: Response) => {
  try {
    const symbol = req.body.symbol || '000300';
    const preferredSource = getPreferredMarketSource(symbol);
    
    // 检查冷却时间
    const lastUpdated = await getLastUpdatedTime(symbol, preferredSource);
    if (lastUpdated) {
      const lastUpdatedTime = new Date(lastUpdated.replace(' ', 'T') + 'Z').getTime();
      const now = Date.now();
      const diffSeconds = (now - lastUpdatedTime) / 1000;
      
      if (diffSeconds < COOLDOWN_SECONDS) {
        // 冷却中，返回本地最新结果
        const latestRegime = await getLatestRegime(symbol);
        if (latestRegime) {
          const enrichedLatestRegime = await enrichMarketRegimeWithCycleLayers(latestRegime, symbol, preferredSource, false);
          return res.json({
            success: true,
            message: `距离上次更新不足${COOLDOWN_SECONDS}秒，已返回本地最新结果。`,
            data: enrichedLatestRegime
          });
        }
      }
    }
    
    // 未命中冷却，调用AKShare
    const fetchResult = await fetchIndexDaily(symbol);
    const prices = fetchResult.data;
    const isMock = fetchResult.is_mock;
    const source = fetchResult.source;
    
    if (prices.length === 0) {
      return res.status(400).json({
        success: false,
        message: '未获取到日线数据',
        is_mock: isMock,
        source
      });
    }
    
    await upsertDailyPrices(prices, symbol, source);
    
    const allPrices = await getDailyPrices(symbol, source);
    
    const regime = calculateMarketRegime(allPrices, isMock, source, symbol);
    
    await saveMarketRegime(regime);
    
    res.json({
      success: true,
      message: isMock ? `${regime.name}日线更新成功（当前为模拟数据）` : `${regime.name}日线更新成功`,
      data: regime
    });
  } catch (error) {
    console.error('Error updating index daily:', error);
    res.status(500).json({
      success: false,
      message: `更新失败: ${(error as Error).message}`
    });
  }
});

router.post('/market/environment/update', async (req: Request, res: Response) => {
  try {
    const symbols = Array.isArray(req.body.symbols) && req.body.symbols.length > 0
      ? req.body.symbols
      : MARKET_ASSETS.map(asset => asset.symbol);
    const results = [];

    for (const symbol of symbols) {
      try {
        const fetchResult = await fetchIndexDaily(symbol);
        await upsertDailyPrices(fetchResult.data, symbol, fetchResult.source);
        const allPrices = await getDailyPrices(symbol, fetchResult.source);
        const regime = calculateMarketRegime(allPrices, fetchResult.is_mock, fetchResult.source, symbol);
        await saveMarketRegime(regime);
        results.push({ symbol, success: true, trade_date: regime.trade_date, market_regime: regime.market_regime });
      } catch (error) {
        results.push({ symbol, success: false, message: (error as Error).message });
      }
    }
    const successCount = results.filter(result => result.success).length;
    const latestTradeDate = results
      .filter(result => result.success && result.trade_date)
      .map(result => result.trade_date)
      .sort()
      .pop();

    res.json({
      success: true,
      message: `市场环境层更新完成：成功 ${successCount} 个，失败 ${results.length - successCount} 个${latestTradeDate ? `，最新交易日 ${latestTradeDate}` : ''}`,
      data: { results }
    });
  } catch (error) {
    console.error('Error updating market environment:', error);
    res.status(500).json({
      success: false,
      message: `市场环境层更新失败: ${(error as Error).message}`
    });
  }
});

router.get('/market/industry-etf-strength', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const scope = req.query.scope === 'all' ? 'all' : 'focus';
    const limit = Math.min(Number(req.query.limit || 30), 200);
    const benchmarkSymbol = String(req.query.benchmark || '000300');
    const data = await buildIndustryEtfStrengthResponse(db, { scope, limit, benchmarkSymbol });

    res.json({
      success: true,
      data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `获取行业ETF强度失败: ${(error as Error).message}`
    });
  }
});

router.get('/market/environment', async (_req: Request, res: Response) => {
  try {
    const items = [];

    for (const asset of MARKET_ASSETS) {
      const regime = await getOrCalculateLatestRegime(asset.symbol);
      const opportunity = getOpportunityStatus(regime);
      items.push({
        ...asset,
        trade_date: regime?.trade_date || null,
        close: regime?.close || null,
        ma20: regime?.ma20 ?? null,
        ma20_slope: regime?.ma20_slope || 'unknown',
        ma60: regime?.ma60 || null,
        ma60_slope: regime?.ma60_slope || 'unknown',
        ma120: regime?.ma120 ?? null,
        ma120_slope: regime?.ma120_slope || 'unknown',
        ma250: regime?.ma250 ?? null,
        ma250_slope: regime?.ma250_slope || 'unknown',
        distance_to_ma60: regime?.distance_to_ma60 ?? null,
        distance_to_ma250: regime?.distance_to_ma250 ?? null,
        above_ma60_days: regime?.above_ma60_days ?? 0,
        market_regime: regime?.market_regime || 'NO_DATA',
        entry_permission: regime?.entry_permission || 'OBSERVE_ONLY',
        short_state: regime?.short_state || 'SHORT_UNKNOWN',
        short_label: regime?.short_label || '短期状态未确认',
        short_reason: regime?.short_reason || '暂无短期行为数据。',
        mid_state: regime?.mid_state || regime?.market_regime || 'NO_DATA',
        mid_label: regime?.mid_label || getMarketRegimeShortLabel(regime?.market_regime || 'NO_DATA'),
        mid_reason: regime?.mid_reason || regime?.result_reason || '暂无中期总闸数据。',
        long_state: regime?.long_state || 'LONG_UNKNOWN',
        long_label: regime?.long_label || '长期牛熊未确认',
        long_reason: regime?.long_reason || '暂无长期牛熊数据。',
        behavior_tags: regime?.behavior_tags || [],
        result_reason: regime?.result_reason || '暂无本地市场状态数据。',
        entry_reason: regime?.entry_reason || '暂无本地市场状态数据。',
        source: regime?.source || getPreferredMarketSource(asset.symbol),
        opportunity
      });
    }

    res.json({
      success: true,
      data: {
        rule_version: 'market_environment_v1',
        updated_at: new Date().toISOString(),
        conclusion: buildEnvironmentConclusion(items),
        items
      }
    });
  } catch (error) {
    console.error('Error getting market environment:', error);
    res.status(500).json({
      success: false,
      message: `获取市场环境层失败: ${(error as Error).message}`
    });
  }
});

router.get('/market/regime/latest', async (req: Request, res: Response) => {
  try {
    const symbol = req.query.symbol || '000300';
    const includeMock = req.query.include_mock === 'true';
    
    let query = `SELECT * FROM financial_market_regime 
                 WHERE symbol = ? `;
    let params: any[] = [symbol];
    
    if (!includeMock) {
      query += `AND result_reason NOT LIKE '%模拟数据%' `;
    }
    
    query += `ORDER BY id DESC LIMIT 1`;
    
    const result = await getDb().then(db => db.get(query, params));
    
    let isMock = false;
    let source = getPreferredMarketSource(String(symbol));
    if (result && result.result_reason && result.result_reason.includes('模拟数据')) {
      isMock = true;
      source = 'mock';
    }
    
    const enrichedResult = result
      ? await enrichMarketRegimeWithCycleLayers(result, String(symbol), source, isMock)
      : result;
    
    res.json({
      success: true,
      data: enrichedResult
    });
  } catch (error) {
    console.error('Error getting latest regime:', error);
    res.status(500).json({
      success: false,
      message: `获取失败: ${(error as Error).message}`
    });
  }
});

router.get('/market/daily-prices', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = String(req.query.symbol || '000300');
    const limit = parseInt(req.query.limit as string) || 120;
    const source = (req.query.source as string) || getPreferredMarketSource(symbol);
    const assetType = getMarketDailyAssetType(symbol);
    const assetFilter = assetType ? 'AND asset_type = ?' : '';
    const params = assetType ? [symbol, source, assetType, limit] : [symbol, source, limit];
    
    const result = await db.all(
      `SELECT * FROM financial_daily_prices 
       WHERE symbol = ? AND source = ? ${assetFilter}
       ORDER BY trade_date DESC 
       LIMIT ?`,
      params
    );
    
    res.json({
      success: true,
      data: result,
      is_mock: source === 'mock',
      source
    });
  } catch (error) {
    console.error('Error getting daily prices:', error);
    res.status(500).json({
      success: false,
      message: `获取失败: ${(error as Error).message}`
    });
  }
});

const isValidDate = (dateStr: string): boolean => {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateStr)) return false;
  
  const date = new Date(dateStr);
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  
  return date.getFullYear() === year && 
         date.getMonth() === month && 
         date.getDate() === day;
};

router.post('/market/regime/backtest', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = String(req.body.symbol || '000300');
    const source = req.body.source || getPreferredMarketSource(symbol);
    const startDateInput = req.body.start_date || '2015-01-01';
    const endDateInput = req.body.end_date || new Date().toISOString().split('T')[0];
    
    if (!isValidDate(startDateInput)) {
      return res.status(400).json({
        success: false,
        message: `无效的开始日期格式: ${startDateInput}，请使用 YYYY-MM-DD 格式。`
      });
    }
    
    if (!isValidDate(endDateInput)) {
      return res.status(400).json({
        success: false,
        message: `无效的结束日期格式: ${endDateInput}，请使用 YYYY-MM-DD 格式。`
      });
    }
    
    const startDate = startDateInput;
    const endDate = endDateInput;
    
    if (startDate > endDate) {
      return res.status(400).json({
        success: false,
        message: '开始日期不能大于结束日期。'
      });
    }
    
    // 只读本地数据，不调用AKShare
    const assetType = getMarketDailyAssetType(symbol);
    const assetFilter = assetType ? 'AND asset_type = ?' : '';
    const priceParams = assetType ? [symbol, source, assetType] : [symbol, source];
    const allPrices = await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount 
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = ? ${assetFilter}
       ORDER BY trade_date ASC`,
      priceParams
    );
    
    if (allPrices.length < 120) {
      return res.status(400).json({
        success: false,
        message: `本地${getMarketAssetMeta(symbol).name}历史数据不足（当前${allPrices.length}条），请先更新当前标的日线。`
      });
    }
    
    const filteredPrices = allPrices.filter(p => p.trade_date >= startDate && p.trade_date <= endDate);
    
    if (filteredPrices.length === 0) {
      return res.status(400).json({
        success: false,
        message: `指定日期范围[${startDate}至${endDate}]内没有数据。`
      });
    }
    
    const resultItems: any[] = [];
    const summary: any = {
      NORMAL: 0,
      NORMAL_CONFIRMED: 0,
      RISK: 0,
      REBUILD_WATCH: 0,
      CRASH_WARNING: 0,
      CRASH: 0,
      DEEP_CRASH: 0,
      UNKNOWN: 0
    };
    const shortSummary: Record<string, number> = {};
    const midSummary: Record<string, number> = {};
    const longSummary: Record<string, number> = {};
    
    for (let i = 0; i < filteredPrices.length; i++) {
      const currentIndex = allPrices.findIndex(p => p.trade_date === filteredPrices[i].trade_date);
      if (currentIndex === -1) continue;
      
      const historyPrices = allPrices.slice(0, currentIndex + 1);
      const regime = calculateMarketRegime(historyPrices, false, source, symbol);
      
      resultItems.push({
        trade_date: regime.trade_date,
        close: regime.close,
        ma20: regime.ma20,
        ma20_slope: regime.ma20_slope,
        ma60: regime.ma60,
        ma60_prev: regime.ma60_prev,
        ma60_slope: regime.ma60_slope,
        ma120: regime.ma120,
        ma120_slope: regime.ma120_slope,
        ma250: regime.ma250,
        ma250_slope: regime.ma250_slope,
        low_60: regime.low_60,
        low_120: regime.low_120,
        cross_count_10: regime.cross_count_10,
        above_ma60_days: regime.above_ma60_days,
        below_ma60_days: regime.below_ma60_days,
        drawdown_20: regime.drawdown_20,
        drawdown_60: regime.drawdown_60,
        drawdown_120: regime.drawdown_120,
        latest_change: regime.latest_change,
        distance_to_ma60: regime.distance_to_ma60,
        distance_to_ma250: regime.distance_to_ma250,
        market_regime: regime.market_regime,
        entry_permission: regime.entry_permission,
        result_reason: regime.result_reason,
        short_state: regime.short_state,
        short_label: regime.short_label,
        short_reason: regime.short_reason,
        mid_state: regime.mid_state,
        mid_label: regime.mid_label,
        mid_reason: regime.mid_reason,
        long_state: regime.long_state,
        long_label: regime.long_label,
        long_reason: regime.long_reason,
        behavior_tags: regime.behavior_tags
      });
      
      if (summary[regime.market_regime] !== undefined) {
        summary[regime.market_regime]++;
      }
      shortSummary[regime.short_state] = (shortSummary[regime.short_state] || 0) + 1;
      midSummary[regime.mid_state] = (midSummary[regime.mid_state] || 0) + 1;
      longSummary[regime.long_state] = (longSummary[regime.long_state] || 0) + 1;
    }
    
    res.json({
      success: true,
      data: {
        symbol,
        source,
        start_date: startDate,
        end_date: endDate,
        items: resultItems,
        summary,
        short_summary: shortSummary,
        mid_summary: midSummary,
        long_summary: longSummary
      }
    });
  } catch (error) {
    console.error('Error running backtest:', error);
    res.status(500).json({
      success: false,
      message: `回测失败: ${(error as Error).message}`
    });
  }
});

router.get('/market/data-status', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = String(req.query.symbol || '000300');
    const source = (req.query.source as string) || getPreferredMarketSource(symbol);
    const assetType = getMarketDailyAssetType(symbol);
    const assetFilter = assetType ? 'AND asset_type = ?' : '';
    const baseParams = assetType ? [symbol, source, assetType] : [symbol, source];
    
    const [countResult, dateResult, lastUpdatedResult] = await Promise.all([
      db.get(`SELECT COUNT(*) as total_count FROM financial_daily_prices WHERE symbol = ? AND source = ? ${assetFilter}`, baseParams),
      db.all(`SELECT trade_date FROM financial_daily_prices WHERE symbol = ? AND source = ? ${assetFilter} ORDER BY trade_date ASC LIMIT 1`, baseParams),
      db.get(`SELECT MAX(updated_at) as last_updated FROM financial_daily_prices WHERE symbol = ? AND source = ? ${assetFilter}`, baseParams)
    ]);
    
    const totalCount = countResult?.total_count || 0;
    const firstTradeDate = dateResult.length > 0 ? dateResult[0].trade_date : null;
    
    // 获取最后一个交易日
    const lastDateResult = await db.all(`SELECT trade_date FROM financial_daily_prices WHERE symbol = ? AND source = ? ORDER BY trade_date DESC LIMIT 1`, [symbol, source]);
    const lastTradeDate = lastDateResult.length > 0 ? lastDateResult[0].trade_date : null;
    
    res.json({
      success: true,
      data: {
        symbol,
        source,
        total_count: totalCount,
        first_trade_date: firstTradeDate,
        last_trade_date: lastTradeDate,
        last_updated: lastUpdatedResult?.last_updated || null,
        has_enough_60: totalCount >= 60,
        has_enough_120: totalCount >= 120
      }
    });
  } catch (error) {
    console.error('Error getting data status:', error);
    res.status(500).json({
      success: false,
      message: `获取失败: ${(error as Error).message}`
    });
  }
});

router.get('/market/debug-calculation', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.query.symbol || '000300';
    const targetDate = req.query.date as string;
    
    const allPrices = await db.all(
      `SELECT trade_date, close, open, high, low, volume, amount 
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = 'akshare' 
       ORDER BY trade_date ASC`,
      [symbol]
    );
    
    let targetIndex = allPrices.length - 1;
    if (targetDate) {
      targetIndex = allPrices.findIndex(p => p.trade_date === targetDate);
      if (targetIndex === -1) {
        return res.status(400).json({
          success: false,
          message: `指定日期 ${targetDate} 没有数据`
        });
      }
    }
    
    const targetPrice = allPrices[targetIndex];
    const close = targetPrice.close;
    const trade_date = targetPrice.trade_date;
    
    const getMA60At = (index: number): number | null => {
      if (index < 59) return null;
      const slice = allPrices.slice(index - 59, index + 1);
      return slice.reduce((sum: number, p: any) => sum + p.close, 0) / 60;
    };
    
    const ma60 = getMA60At(targetIndex);
    const ma60_prev = getMA60At(targetIndex - 1);
    
    const last60Index = Math.max(0, targetIndex - 59);
    const last60Prices = allPrices.slice(last60Index, targetIndex + 1);
    const low_60 = last60Prices.length >= 60 ? Math.min(...last60Prices.map((p: any) => p.close)) : null;
    
    const last120Index = Math.max(0, targetIndex - 119);
    const last120Prices = allPrices.slice(last120Index, targetIndex + 1);
    const low_120 = last120Prices.length >= 120 ? Math.min(...last120Prices.map((p: any) => p.close)) : null;
    
    const close_20_days_ago = targetIndex >= 20 ? allPrices[targetIndex - 20].close : null;
    const close_60_days_ago = targetIndex >= 60 ? allPrices[targetIndex - 60].close : null;
    const close_120_days_ago = targetIndex >= 120 ? allPrices[targetIndex - 120].close : null;
    
    const drawdown_20 = close_20_days_ago !== null ? (close / close_20_days_ago) - 1 : null;
    const drawdown_60 = close_60_days_ago !== null ? (close / close_60_days_ago) - 1 : null;
    const drawdown_120 = close_120_days_ago !== null ? (close / close_120_days_ago) - 1 : null;
    
    const distance_to_ma60 = ma60 !== null ? (close - ma60) / ma60 : null;
    
    let above_ma60_days = 0;
    for (let i = targetIndex; i >= 0; i--) {
      const dayMA60 = getMA60At(i);
      if (dayMA60 === null) break;
      if (allPrices[i].close > dayMA60) {
        above_ma60_days++;
      } else {
        break;
      }
    }
    
    let below_ma60_days = 0;
    for (let i = targetIndex; i >= 0; i--) {
      const dayMA60 = getMA60At(i);
      if (dayMA60 === null) break;
      if (allPrices[i].close < dayMA60) {
        below_ma60_days++;
      } else {
        break;
      }
    }
    
    const sample_10_start = Math.max(0, targetIndex - 9);
    const sample_10 = [];
    for (let i = sample_10_start; i <= targetIndex; i++) {
      const dayMA60 = getMA60At(i);
      let side = 'unknown';
      if (dayMA60 !== null) {
        if (allPrices[i].close > dayMA60) {
          side = 'above';
        } else if (allPrices[i].close < dayMA60) {
          side = 'below';
        } else {
          side = 'equal';
        }
      }
      sample_10.push({
        trade_date: allPrices[i].trade_date,
        close: allPrices[i].close,
        ma60: dayMA60,
        side
      });
    }
    
    let cross_count_10 = 0;
    let prevSide: 'above' | 'below' | null = null;
    for (const item of sample_10) {
      if (item.ma60 === null) continue;
      if (item.side !== 'equal') {
        if (prevSide !== null && prevSide !== item.side) {
          cross_count_10++;
        }
        prevSide = item.side as 'above' | 'below';
      }
    }
    
    res.json({
      success: true,
      data: {
        trade_date,
        close,
        ma60: ma60 !== null ? Math.round(ma60 * 100) / 100 : null,
        ma60_prev: ma60_prev !== null ? Math.round(ma60_prev * 100) / 100 : null,
        distance_to_ma60: distance_to_ma60 !== null ? Math.round(distance_to_ma60 * 10000) / 10000 : null,
        low_60: low_60 !== null ? Math.round(low_60 * 100) / 100 : null,
        low_120: low_120 !== null ? Math.round(low_120 * 100) / 100 : null,
        close_20_days_ago,
        close_60_days_ago,
        close_120_days_ago,
        drawdown_20: drawdown_20 !== null ? Math.round(drawdown_20 * 10000) / 10000 : null,
        drawdown_60: drawdown_60 !== null ? Math.round(drawdown_60 * 10000) / 10000 : null,
        drawdown_120: drawdown_120 !== null ? Math.round(drawdown_120 * 10000) / 10000 : null,
        above_ma60_days,
        below_ma60_days,
        cross_count_10,
        sample_10,
        sample_60_count: last60Prices.length,
        sample_120_count: last120Prices.length,
        total_available_days: allPrices.length,
        target_index: targetIndex
      }
    });
  } catch (error) {
    console.error('Error in debug calculation:', error);
    res.status(500).json({
      success: false,
      message: `调试接口失败: ${(error as Error).message}`
    });
  }
});

export default router;
