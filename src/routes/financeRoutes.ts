import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import getDb from '../config/database';
import {
  DEFAULT_FINANCE_CANDIDATE_FUNNEL_CONFIG,
  DEFAULT_FINANCE_PIPELINE_CONFIG,
  compactFinancePipelineResultForStorage,
  markFinancePipelineResultInterrupted,
  runFinanceCandidateFunnelPipeline,
  runFinanceDailyPipeline
} from '../services/financeDailyPipeline';
import {
  MARKET_ASSETS,
  buildIndustryEtfStrengthResponse,
  getMarketAssetMeta,
  getPreferredMarketSource
} from '../services/industryEtfStrengthService';
import { getLatestCoveredTradeDate, getTradeDateCoverage } from '../utils/financeTradeDate';
import { getFreshMarketRegime } from '../utils/financeMarketRegime';
import { calculateMarketRegime, getMarketRegimeShortLabel, type DailyPrice, type MarketRegime } from '../services/financeMarketRegimeCalculator';
import {
  buildEntryObservationQueueInfo,
  compareObservationQueueItems,
  getEntryObservationQueueActionCode
} from '../utils/entryObservationQueue';
import { calculateMetalRegime, filterMetalTradingPrices, getMetalAsset } from './metalRoutes';

const router = Router();
const execAsync = promisify(exec);
const FINANCE_PIPELINE_TASK_KEY = 'finance_daily_pipeline';
const FINANCE_FUNNEL_TASK_KEY = 'finance_candidate_funnel_pipeline';
const FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY = 'finance_tushare_supplemental_update';
const CHINA_TIME_ZONE = 'Asia/Shanghai';
const PIPELINE_MANUAL_EARLIEST_MINUTE = 17 * 60;
const PIPELINE_RUNNING_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const WORKFLOW_SUMMARY_CACHE_TTL_MS = 10 * 1000;
const INDUSTRY_ETF_STRENGTH_CACHE_TTL_MS = 60 * 1000;
let workflowDailyChangesCache: {
  key: string;
  expiresAt: number;
  data: any;
} | null = null;
let workflowDailyPriceHealthCache: {
  expiresAt: number;
  data: any;
} | null = null;
let workflowEntryObservationRowsCache: {
  expiresAt: number;
  data: any[];
} | null = null;
let workflowMetalsHealthCache: {
  key: string;
  expiresAt: number;
  data: any;
} | null = null;
let industryEtfStrengthCache: {
  key: string;
  expiresAt: number;
  data: any;
} | null = null;
const latestEntryObservationCte = `
  WITH latest_entry_observations AS (
    SELECT *
    FROM (
      SELECT
        o.*,
        ROW_NUMBER() OVER (
          PARTITION BY o.symbol, o.asset_type, o.source
          ORDER BY o.updated_at DESC, o.id DESC
        ) AS rn
      FROM financial_entry_trigger_observations o
    )
    WHERE rn = 1
  )
`;

router.get('/workflow-summary/light', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const data = await buildWorkflowLightSummary(db);
    res.json({
      success: true,
      data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `获取金融流程轻量总览失败: ${(error as Error).message}`
    });
  }
});

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

function getChinaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHINA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day)
  };
}

function getChinaDateTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHINA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };
  const hour = Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday] ?? -1
  };
}

function getMarketDailyAssetType(symbol: string): 'index' | 'etf' | null {
  const meta = getMarketAssetMeta(symbol);
  if (meta.category === 'broad' || meta.category === 'style') return 'index';
  if (meta.category === 'industry' || symbol.startsWith('5') || symbol.startsWith('1')) return 'etf';
  return null;
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

function getChinaScheduleDueTime(scheduleTime = '17:10', now = new Date()) {
  const [hour, minute] = scheduleTime.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const { year, month, day } = getChinaDateParts(now);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0));
}

function hasRunAtOrAfterSchedule(startedAt?: string | null, scheduleTime = '17:10', now = new Date()) {
  if (!startedAt) return false;
  const runDate = new Date(startedAt);
  if (!Number.isFinite(runDate.getTime())) return false;
  if (getChinaDateKey(runDate) !== getChinaDateKey(now)) return false;

  const due = getChinaScheduleDueTime(scheduleTime, now);
  if (!due) return true;
  return runDate >= due;
}

async function expireStaleFinancePipelineRuns(db: any) {
  const latestCompletedRun = await db.get(
    `SELECT started_at
     FROM task_center_runs
     WHERE task_key = ?
       AND status != 'running'
       AND finished_at IS NOT NULL
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [FINANCE_PIPELINE_TASK_KEY]
  );
  const latestCompletedMs = latestCompletedRun?.started_at
    ? new Date(latestCompletedRun.started_at).getTime()
    : NaN;
  const runningRows = await db.all(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC`,
    [FINANCE_PIPELINE_TASK_KEY]
  );
  const nowMs = Date.now();
  const staleRows = runningRows.filter((row: any) => {
    const startedMs = new Date(row.started_at).getTime();
    if (!Number.isFinite(startedMs)) return false;
    if (Number.isFinite(latestCompletedMs) && latestCompletedMs > startedMs) return true;
    return nowMs - startedMs > PIPELINE_RUNNING_TIMEOUT_MS;
  });
  if (staleRows.length === 0) return;

  const now = new Date().toISOString();
  for (const row of staleRows) {
    const message = `金融日终流水线超过 ${Math.round(PIPELINE_RUNNING_TIMEOUT_MS / 3600000)} 小时仍未结束，已自动标记为失败，请确认是否在非交易时段或数据源无响应时启动。`;
    const resultRow = await db.get(
      `SELECT result_json
       FROM task_center_runs
       WHERE id = ?`,
      [row.id]
    );
    const interruptedResult = markFinancePipelineResultInterrupted(resultRow?.result_json, message, now);
    if (interruptedResult) {
      await db.run(
        `UPDATE task_center_runs
         SET status = 'error', message = ?, result_json = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
        [message, JSON.stringify(compactFinancePipelineResultForStorage(interruptedResult)), now, row.id]
      );
    } else {
      await db.run(
        `UPDATE task_center_runs
         SET status = 'error', message = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
        [message, now, row.id]
      );
    }
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
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
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

  const localNow = getChinaDateTimeParts();
  if (localNow.weekday === 0 || localNow.weekday === 6) {
    return {
      can_run: false,
      reason: '今天不是交易日（周末），日终流水线不启动，避免无意义请求数据源。',
      force_supported: true
    };
  }

  const minuteOfDay = localNow.hour * 60 + localNow.minute;
  if (minuteOfDay < PIPELINE_MANUAL_EARLIEST_MINUTE) {
    return {
      can_run: false,
      reason: `日终流水线只允许 ${getPipelineEarliestTimeLabel()} 后执行；Tushare辅助数据补全会在 17:00 后先跑，金融日终流水线随后接着跑。当前还未到收盘后处理窗口。`,
      force_supported: true
    };
  }

  const runningSupplemental = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY]
  );
  if (runningSupplemental?.started_at) {
    const startedMs = new Date(runningSupplemental.started_at).getTime();
    const isFreshRunning = Number.isFinite(startedMs)
      && Date.now() - startedMs <= PIPELINE_RUNNING_TIMEOUT_MS;
    if (isFreshRunning) {
      return {
        can_run: false,
        reason: `Tushare辅助数据补全正在执行，先不要手动跑日终流水线，避免拿半新半旧数据推进。Tushare开始时间：${formatChinaDateTime(runningSupplemental.started_at)}`,
        force_supported: true,
        running: runningSupplemental
      };
    }
  }

  const supplementalTask = await db.get(
    `SELECT enabled, schedule_time FROM task_center_tasks WHERE task_key = ?`,
    [FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY]
  );
  if (supplementalTask?.enabled) {
    const supplementalScheduleTime = supplementalTask.schedule_time || '17:00';
    const latestSupplemental = await db.get(
      `SELECT id, status, started_at, finished_at, message
       FROM task_center_runs
       WHERE task_key = ? AND status IN ('success', 'error')
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
       LIMIT 1`,
      [FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY]
    );
    if (!hasRunAtOrAfterSchedule(latestSupplemental?.started_at, supplementalScheduleTime)) {
      return {
        can_run: false,
        reason: `Tushare辅助数据补全今天尚未在 ${supplementalScheduleTime} 后成功完成，先不要手动跑日终流水线，避免旧辅助特征推进。`,
        force_supported: true
      };
    }
    if (latestSupplemental.status === 'error') {
      return {
        can_run: false,
        reason: `Tushare辅助数据补全今天失败，先不要手动跑日终流水线。失败信息：${latestSupplemental.message || '原因未知'}`,
        force_supported: true
      };
    }
  }

  const latestRun = await db.get(
    `SELECT id, status, started_at, message
     FROM task_center_runs
     WHERE task_key = ?
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [FINANCE_PIPELINE_TASK_KEY]
  );
  const pipelineTask = await db.get(
    `SELECT schedule_time FROM task_center_tasks WHERE task_key = ?`,
    [FINANCE_PIPELINE_TASK_KEY]
  );
  if (
    latestRun?.status === 'success'
    && getRunDateKey(latestRun.started_at) === getChinaDateKey()
    && hasRunAtOrAfterSchedule(latestRun.started_at, pipelineTask?.schedule_time || '17:10')
  ) {
    return {
      can_run: false,
      reason: '今日正式窗口后的流水线已经成功执行过。本页默认不重复跑，避免休市或无新数据时反复请求。',
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
     ORDER BY trade_date DESC, id DESC LIMIT 1`,
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
     VALUES (?, ?, ?, ?, 0, '17:10', 'trade_days', 8, ?, 'pending', ?)`,
    [
      FINANCE_PIPELINE_TASK_KEY,
      '金融日终流水线',
      'finance',
      'finance_daily_pipeline',
      JSON.stringify(DEFAULT_FINANCE_PIPELINE_CONFIG),
      '收盘后自动串联日线、市场总闸、备选池、模型复核、入池漏斗、入场触发、持仓建议、五模型实验预测池和后验标签；计划生成与仓位填写仍保留人工确认'
    ]
  );
  return db.get(`SELECT * FROM task_center_tasks WHERE task_key = ?`, [FINANCE_PIPELINE_TASK_KEY]);
}

async function ensureFinanceFunnelTask(db: any) {
  await db.run(
    `INSERT OR IGNORE INTO task_center_tasks
      (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
     VALUES (?, ?, ?, ?, 0, '17:25', 'trade_days', 7, ?, 'pending', ?)`,
    [
      FINANCE_FUNNEL_TASK_KEY,
      '入池漏斗流水线',
      'finance',
      'finance_candidate_funnel_pipeline',
      JSON.stringify(DEFAULT_FINANCE_CANDIDATE_FUNNEL_CONFIG),
      '收盘后自动推进走势阶段、单标的判断和入场触发观察；不自动生成买入计划'
    ]
  );
  await db.run(
    `UPDATE task_center_tasks
     SET schedule_time = '17:25',
         last_message = '收盘后自动推进走势阶段、单标的判断和入场触发观察；不自动生成买入计划',
         updated_at = CURRENT_TIMESTAMP
     WHERE task_key = ?
       AND schedule_time IN ('09:30', '16:45')`,
    [FINANCE_FUNNEL_TASK_KEY]
  );
  return db.get(`SELECT * FROM task_center_tasks WHERE task_key = ?`, [FINANCE_FUNNEL_TASK_KEY]);
}

const FUNNEL_REPAIR_STEP_KEYS = new Set([
  'model_feature_refresh',
  'candidate_scan',
  'model_recheck_auto',
  'model_candidate_scores',
  'candidate_funnel',
  'entry_trigger_scan',
  'entry_observation_settlement',
  'active_plan_suggestions'
]);

function getRecoverableFunnelRepair(latestDaily: any) {
  if (!latestDaily || latestDaily.status !== 'error') return null;
  const result = parseJsonConfig(latestDaily.result_json);
  const steps = toArray(result.steps);
  if (steps.length === 0) return null;

  const dailyPricesStep = steps.find((step: any) => step.key === 'daily_prices');
  const marketStep = steps.find((step: any) => step.key === 'market_environment');
  const failedStep = steps.find((step: any) => step.status === 'error');
  const skippedSteps = steps.filter((step: any) => step.status === 'skipped');
  const marketBlocked = steps.some((step: any) => step?.data?.downstream_blocked);
  const repairRelevant = Boolean(failedStep && FUNNEL_REPAIR_STEP_KEYS.has(String(failedStep.key || '')))
    || skippedSteps.some((step: any) => FUNNEL_REPAIR_STEP_KEYS.has(String(step.key || '')));

  if (marketBlocked || dailyPricesStep?.status !== 'success' || marketStep?.status !== 'success' || !repairRelevant) {
    return null;
  }

  return {
    failed_step: failedStep?.key || null,
    failed_label: failedStep?.label || null,
    skipped_count: skippedSteps.length,
    started_at: latestDaily.started_at,
    message: latestDaily.message || failedStep?.message || '日终流水线下游步骤未闭环'
  };
}

function compactRunGuardRun(run: any) {
  if (!run || typeof run !== 'object') return run;
  const { result_json: _resultJson, ...safeRun } = run;
  return safeRun;
}

async function getDailyPipelineRecovery(db: any, latestDaily: any) {
  if (!latestDaily || latestDaily.status !== 'error') return null;
  const boundaryAt = latestDaily.finished_at || latestDaily.started_at;
  if (!boundaryAt) return null;

  const latestFunnel = await db.get(
    `SELECT id, task_key, status, message, started_at, finished_at
     FROM task_center_runs
     WHERE task_key = ?
       AND status = 'success'
       AND datetime(REPLACE(REPLACE(started_at, 'T', ' '), 'Z', '')) >
           datetime(REPLACE(REPLACE(?, 'T', ' '), 'Z', ''))
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [FINANCE_FUNNEL_TASK_KEY, boundaryAt]
  );
  if (!latestFunnel) return null;

  const repair = getRecoverableFunnelRepair(latestDaily);
  const failedLabel = repair?.failed_label || repair?.failed_step || '日终下游步骤';
  return {
    status: 'recovered_by_funnel',
    message: `上次日终停在「${failedLabel}」，但后续入池漏斗已于 ${formatChinaDateTime(latestFunnel.finished_at || latestFunnel.started_at)} 成功补跑；备选池、走势阶段和入场观察可按漏斗补跑结果查看，完整日终仍建议在下一收盘窗口重跑闭环。`,
    repair,
    funnel_run: latestFunnel,
    next_actions: [
      '若只是查看候选/观察队列，可按后续成功漏斗结果继续看。',
      '若要刷新模型特征、样本快照和实验预测池，仍应重跑完整日终流水线。',
      '金融买入计划仍保持人工确认，不因补跑漏斗自动生成或执行。'
    ]
  };
}

async function buildManualFunnelRunGuard(db: any) {
  await expireStaleFinancePipelineRuns(db);

  const runningDaily = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [FINANCE_PIPELINE_TASK_KEY]
  );
  if (runningDaily) {
    return {
      can_run: false,
      reason: `金融日终流水线正在执行中，漏斗已包含在本次收盘流程内。开始时间：${formatChinaDateTime(runningDaily.started_at)}`,
      force_supported: false,
      running: runningDaily
    };
  }

  const running = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
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

  const dailyTask = await db.get(
    `SELECT schedule_time FROM task_center_tasks WHERE task_key = ?`,
    [FINANCE_PIPELINE_TASK_KEY]
  );
  const latestDaily = await db.get(
    `SELECT id, status, started_at, finished_at, message, result_json
     FROM task_center_runs
     WHERE task_key = ? AND status IN ('success', 'error')
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [FINANCE_PIPELINE_TASK_KEY]
  );
  const dailyScheduleTime = dailyTask?.schedule_time || '17:10';
  const recoverableRepair = getRecoverableFunnelRepair(latestDaily);
  if (recoverableRepair) {
    return {
      can_run: true,
      reason: `金融日终已完成日线和市场总闸，但下游停在「${recoverableRepair.failed_label || recoverableRepair.failed_step || '未知步骤'}」，可单独补跑本地入池漏斗；不会拉新行情，也不会自动生成买入计划。日终失败信息：${recoverableRepair.message}`,
      latest_daily: compactRunGuardRun(latestDaily),
      repair: recoverableRepair,
      force_supported: false
    };
  }

  const localNow = getChinaDateTimeParts();
  if (localNow.weekday === 0 || localNow.weekday === 6) {
    return {
      can_run: false,
      reason: '今天不是交易日（周末），漏斗不单独启动，避免用休市旧数据推进。',
      force_supported: false
    };
  }

  const minuteOfDay = localNow.hour * 60 + localNow.minute;
  if (minuteOfDay < PIPELINE_MANUAL_EARLIEST_MINUTE) {
    return {
      can_run: false,
      reason: `入池漏斗按收盘日线口径执行，只允许 ${getPipelineEarliestTimeLabel()} 后启动。建议直接跑金融日终流水线，它会一并执行漏斗。`,
      force_supported: false
    };
  }

  const dailyRanAfterSchedule = hasRunAtOrAfterSchedule(latestDaily?.started_at, dailyScheduleTime);
  if (dailyRanAfterSchedule && latestDaily?.status === 'success') {
    return {
      can_run: false,
      reason: `今日金融日终流水线已经成功执行，且已包含入池漏斗，不需要单独重复跑。完成时间：${formatChinaDateTime(latestDaily.finished_at)}`,
      force_supported: false
    };
  }
  if (dailyRanAfterSchedule && latestDaily?.status === 'error') {
    return {
      can_run: true,
      reason: `今日金融日终流水线失败，可单独补跑入池漏斗；漏斗内部会再次检查全市场日线覆盖，避免半截行情推进。日终失败信息：${latestDaily.message || '原因未知'}`,
      latest_daily: compactRunGuardRun(latestDaily),
      force_supported: false
    };
  }

  return {
    can_run: true,
    reason: `今日 ${dailyScheduleTime} 后的金融日终流水线尚未成功执行，可单独补跑入池漏斗；漏斗内部会再次检查全市场日线覆盖，避免旧数据推进。`,
    force_supported: false
  };
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
    severity: undefined as 'warning' | undefined,
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
    case 'model_recheck_auto': {
      base.metrics = {
        checked: Number(data.checked_count || results.length),
        selected: Number(data.selected_count || 0),
        settled: Number(data.settled_count || 0),
        manual_required: Number(data.manual_required_count || 0),
        daily_updated: Number(data.daily_updated_count || 0),
        data_gap: Number(data.data_gap_count || 0),
        neutral: Number(data.neutral_count || 0),
        high_conflict: Number(data.high_conflict_count || 0),
        failed: Number(data.failed_count || 0)
      };
      const rankModelRecheck = (item: any) => {
        if (item.success === false) return 0;
        if (item.manual_required) return 1;
        if (item.selected) return 2;
        if (item.settled) return 3;
        return 4;
      };
      base.details = results
        .slice()
        .sort((left: any, right: any) => rankModelRecheck(left) - rankModelRecheck(right))
        .slice(0, 40)
        .map((item: any) => {
          const category = item.success === false
            ? 'failed'
            : item.manual_required
              ? 'true_conflict'
              : item.selected
                ? 'reflow'
                : item.settled
                  ? 'auto_settled'
                  : 'other';
          return {
            category,
            symbol: item.symbol,
            name: item.name,
            asset_type: item.asset_type,
            status: item.success === false
              ? '失败'
              : item.manual_required
                ? '真冲突'
                : item.selected
                  ? '回流'
                  : item.settled
                    ? '自动沉淀'
                    : '复核',
            result: item.reason || item.bucket || '--'
          };
        });
      break;
    }
    case 'model_feature_refresh': {
      const failedCount = Number(data.failed_count || 0);
      const blockingStaleCount = Number(data.blocking_stale_count || 0);
      const auxiliaryUnavailable = data.model_auxiliary_available === false;
      if (auxiliaryUnavailable || failedCount > 0 || blockingStaleCount > 0) {
        base.severity = 'warning';
      }
      base.metrics = {
        checked: Number(data.checked_count || results.filter((item: any) => item.success).length),
        refreshed: Number(data.refreshed_count || 0),
        stale: Number(data.stale_count || 0),
        blocking_stale: blockingStaleCount,
        failed: failedCount,
        model_auxiliary: auxiliaryUnavailable ? '降级' : '可用'
      };
      base.details = results.map((item: any) => ({
        category: item.success === false || item.featureStale || item.scoreStale ? 'failed' : 'other',
        symbol: item.domain,
        status: item.success === false
          ? '失败'
          : item.featureStale
            ? '特征滞后'
            : item.scoreStale
              ? '候选分滞后'
              : item.refreshed
                ? '已重建'
                : '正常',
        trade_date: item.latestCoveredTradeDate || item.latestTradeDate || null,
        result: item.success === false
          ? item.message || '模型特征检查失败'
          : `特征 ${item.latestTradeDate || '--'} / 候选分 ${item.latestScoreTradeDate || '--'} / 最新日线 ${item.latestCoveredTradeDate || '--'}`
      }));
      break;
    }
    case 'model_candidate_scores': {
      const failedCount = Number(data.failed_count || 0);
      if (data.model_auxiliary_available === false || failedCount > 0) {
        base.severity = 'warning';
      }
      base.metrics = {
        checked: Number(data.checked_count || 0),
        scored: Number(data.scored_count || 0),
        failed: failedCount,
        model_auxiliary: data.model_auxiliary_available === false ? '降级' : '可用'
      };
      base.details = results.map((item: any) => ({
        category: item.success === false ? 'failed' : 'other',
        symbol: item.domain,
        status: item.success === false ? '失败' : '成功',
        trade_date: item.coveredTradeDate || null,
        result: item.success
          ? `评分 ${Number(item.scored || 0)} / 检查 ${Number(item.checked || 0)}，模型 ${item.modelKey || '--'} #${item.modelRunId || '--'}`
          : item.message || '候选模型分数同步失败'
      }));
      break;
    }
    case 'entry_observation_preflight_settlement':
    case 'entry_observation_settlement': {
      const details = toArray(data.details);
      const invalidatedCount = Number(data.invalidated_count || 0);
      const readyToPlanCount = Number(data.ready_to_plan_count || 0);
      const plannedCount = Number(data.planned_count || 0);
      const orphanOpenReturnedCount = Number(data.orphan_open_returned_count || data.orphan_ready_returned_count || 0);
      const timeoutReturnedCount = Number(data.returned_count || 0);
      const dedupedCount = Number(data.deduped_count || 0);
      base.metrics = {
        invalidated: invalidatedCount,
        ready_to_plan: readyToPlanCount,
        planned: plannedCount,
        returned: orphanOpenReturnedCount + timeoutReturnedCount,
        orphan_open_returned: orphanOpenReturnedCount,
        timeout_returned: timeoutReturnedCount,
        deduped: dedupedCount,
        total: invalidatedCount
          + readyToPlanCount
          + plannedCount
          + orphanOpenReturnedCount
          + timeoutReturnedCount
          + dedupedCount,
        latest_trade_date: data.latest_trade_date || null,
        stale_days: Number(data.stale_days || 0)
      };
      base.details = details.slice(0, 60).map((item: any) => ({
        category: item.category || 'other',
        observation_id: item.observation_id,
        symbol: item.symbol,
        name: item.name,
        asset_type: item.asset_type,
        status: item.status || '--',
        trade_date: item.trade_date,
        close_price: item.close_price,
        invalidation_line: item.invalidation_line,
        trend_phase_code: item.trend_phase_code,
        result: item.result || '--'
      }));
      break;
    }
    case 'experiment_prediction_snapshots': {
      base.metrics = {
        checked: Number(data.checked_count || results.length),
        saved: Number(data.saved_count || 0),
        inserted: Number(data.inserted_count || 0),
        updated: Number(data.updated_count || 0),
        refreshed: Number(data.refreshed_count || 0),
        completed: Number(data.completed_count || 0),
        partial: Number(data.partial_count || 0),
        pending: Number(data.pending_count || 0),
        failed: Number(data.failed_count || 0)
      };
      base.details = results.map((item: any) => ({
        experiment_key: item.experiment_key,
        asset_type: item.asset_type,
        status: item.success ? '成功' : '失败',
        saved_count: Number(item.saved_count || 0),
        refreshed_count: Number(item.refreshed_count || 0),
        result: item.success
          ? `保存 ${Number(item.saved_count || 0)}，后验 ${Number(item.refreshed_count || 0)}`
          : item.message || '失败'
      }));
      break;
    }
    case 'active_candidate_collect': {
      const byAssetType = assetTypeBreakdown(items);
      base.metrics = {
        active: items.length,
        stock: byAssetType.stock,
        etf: byAssetType.etf,
        normalized: Number(data.normalized_rejected_active_count || 0)
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
        .filter((item: any) => item.action === 'READY_TO_PLAN' || ['confirmed', 'plan_candidate', 'invalidated'].includes(item.observation_status))
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
    case 'decision_sample_tracking': {
      const syncResult = data.syncResult || {};
      const tracking = data.decisionTracking || {};
      const stages = toArray(tracking.stages);
      const recentItems = toArray(tracking.items || tracking.recentItems);
      base.metrics = {
        synced: Number(syncResult.processed || 0),
        snapshots: Number(syncResult.snapshots || tracking.snapshotCount || 0),
        total: Number(tracking.total || tracking.totalSamples || 0),
        tracking: stages.reduce((sum: number, stage: any) => sum + Number(stage.tracking || 0), 0),
        advanced: stages.reduce((sum: number, stage: any) => sum + Number(stage.advanced || 0), 0),
        blocked: stages.reduce((sum: number, stage: any) => sum + Number(stage.blocked || 0), 0)
      };
      base.details = recentItems.slice(0, 12).map((item: any) => ({
        symbol: item.symbol,
        name: item.name,
        asset_type: item.assetType || item.asset_type,
        status: item.labelStatus || item.label_status || item.stageStatus || item.stage_status,
        result: item.stageLabel || item.stage_label || item.stageKey || item.stage_key || '决策样本'
      }));
      break;
    }
    case 'signal_lifecycle_sync': {
      base.metrics = {
        checked: Number(data.checked || 0),
        synced: Number(data.synced || 0),
        total: Number(data.total || 0)
      };
      base.details = toArray(data.statusCards).slice(0, 12).map((item: any) => ({
        status: item.label || item.key,
        result: `${Number(item.count ?? item.value ?? 0)} 条`
      }));
      break;
    }
    case 'sample_validation_snapshot': {
      const snapshots = toArray(data.snapshots);
      base.metrics = {
        saved: 1,
        snapshots: snapshots.length,
        latest: data.snapshotDate || null
      };
      base.details = snapshots.slice(0, 8).map((item: any) => ({
        snapshot_date: item.snapshotDate || item.snapshot_date,
        rule_version: item.ruleVersion || item.rule_version,
        result: '样本验证快照'
      }));
      break;
    }
    case 'workflow_summary': {
      base.metrics = {
        candidate_active: Number(data.counts?.candidate_active || 0),
        structure_pending: Number(data.counts?.structure_pending || 0),
        structure_watch: Number(data.counts?.structure_watch || 0),
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
      skipped: steps.filter((step: any) => step.status === 'skipped').length,
      failed: steps.filter((step: any) => step.status === 'error').length,
      failed_step: steps.find((step: any) => step.status === 'error')?.key || null
    },
    steps,
    config: result.config || null,
    finished_at: result.finished_at || null
  };
}

async function buildCandidateFlowIntegrity(db: any) {
  const row = await db.get(
    `SELECT
       SUM(CASE WHEN pool_status = 'active'
                  AND asset_type IN ('stock', 'etf')
                  AND COALESCE(review_status, 'unreviewed') = 'unreviewed'
                THEN 1 ELSE 0 END) AS active_unreviewed,
       SUM(CASE WHEN pool_status = 'active'
                  AND asset_type IN ('stock', 'etf')
                  AND COALESCE(review_status, '') <> 'plan_ready'
                  AND final_status = 'READY_FOR_PLAN'
                THEN 1 ELSE 0 END) AS ready_for_plan_mismatch,
       SUM(CASE WHEN pool_status = 'active'
                  AND asset_type IN ('stock', 'etf')
                  AND review_status = 'plan_ready'
                  AND final_status <> 'READY_FOR_PLAN'
                THEN 1 ELSE 0 END) AS plan_ready_final_mismatch,
       SUM(CASE WHEN pool_status = 'active'
                  AND asset_type IN ('stock', 'etf')
                  AND review_status IN ('wait_confirmation', 'trend_blocked', 'structure_pending', 'structure_watch')
                  AND final_status <> 'WAIT'
                THEN 1 ELSE 0 END) AS wait_state_final_mismatch
     FROM financial_candidate_pool`
  );
  const counts = {
    active_unreviewed: Number(row?.active_unreviewed || 0),
    ready_for_plan_mismatch: Number(row?.ready_for_plan_mismatch || 0),
    plan_ready_final_mismatch: Number(row?.plan_ready_final_mismatch || 0),
    wait_state_final_mismatch: Number(row?.wait_state_final_mismatch || 0)
  };
  const issues = [
    counts.active_unreviewed > 0
      ? { code: 'active_unreviewed', count: counts.active_unreviewed, message: `发现 ${counts.active_unreviewed} 条 active 候选仍停在 unreviewed，说明漏斗状态推进没有闭环。` }
      : null,
    counts.ready_for_plan_mismatch > 0
      ? { code: 'ready_for_plan_mismatch', count: counts.ready_for_plan_mismatch, message: `发现 ${counts.ready_for_plan_mismatch} 条非 plan_ready 候选挂着 READY_FOR_PLAN，计划口径会被误放大。` }
      : null,
    counts.plan_ready_final_mismatch > 0
      ? { code: 'plan_ready_final_mismatch', count: counts.plan_ready_final_mismatch, message: `发现 ${counts.plan_ready_final_mismatch} 条 plan_ready 候选未挂 READY_FOR_PLAN，买入计划准备池会漏数。` }
      : null,
    counts.wait_state_final_mismatch > 0
      ? { code: 'wait_state_final_mismatch', count: counts.wait_state_final_mismatch, message: `发现 ${counts.wait_state_final_mismatch} 条等待态候选 final_status 不是 WAIT，后续队列可能错位。` }
      : null
  ].filter(Boolean);
  return {
    status: issues.length > 0 ? 'attention' : 'ok',
    counts,
    issues
  };
}

function appendCandidateFlowWarnings(workflowWarnings: any[], integrity: any) {
  const issues = Array.isArray(integrity?.issues) ? integrity.issues : [];
  for (const issue of issues) {
    workflowWarnings.push({
      code: issue.code || 'candidate_flow_integrity',
      level: 'needs_reconcile',
      message: issue.message || '备选池状态口径需要修复。'
    });
  }
}

async function persistManualPipelineProgress(
  db: any,
  taskId: number,
  runId: number,
  label: string,
  step: any,
  result: any
) {
  const now = new Date().toISOString();
  const stepLabel = step?.label || step?.key || '未知步骤';
  const stepMessage = step?.message ? `：${step.message}` : '';
  const message = step?.status === 'error'
    ? `${label}执行中断：停在「${stepLabel}」${stepMessage}`
    : step?.status === 'success'
      ? `${label}执行中：已完成「${stepLabel}」${stepMessage}`
      : step?.status === 'skipped'
        ? `${label}执行中：已跳过「${stepLabel}」${stepMessage}`
        : `${label}执行中：正在执行「${stepLabel}」`;

  await db.run(
    `UPDATE task_center_runs
     SET message = ?, result_json = ?
     WHERE id = ? AND status = 'running'`,
    [message, JSON.stringify(compactFinancePipelineResultForStorage(result)), runId]
  );
  await db.run(
    `UPDATE task_center_tasks
     SET last_status = 'running',
         last_message = ?,
         last_run_at = ?,
         updated_at = ?
     WHERE id = ?`,
    [message, now, now, taskId]
  );
}

function extractDailyChanges(compactResult: any) {
  const steps = toArray(compactResult?.steps);
  const findStep = (key: string) => steps.find((step: any) => step.key === key);
  const dailyPrices = findStep('daily_prices');
  const candidateScan = findStep('candidate_scan');
  const entryTriggerScan = findStep('entry_trigger_scan');
  const entryObservationPreflight = findStep('entry_observation_preflight_settlement');
  const entryObservationSettlement = findStep('entry_observation_settlement');
  const activePlanSuggestions = findStep('active_plan_suggestions');
  const mergeMetrics = (...metricItems: Array<Record<string, any> | undefined>) => {
    const merged: Record<string, any> = {};
    metricItems.forEach((metrics) => {
      Object.entries(metrics || {}).forEach(([key, value]) => {
        if (typeof value === 'number') {
          merged[key] = Number(merged[key] || 0) + value;
        } else if (value !== null && value !== undefined && value !== '') {
          merged[key] = merged[key] || value;
        }
      });
    });
    return merged;
  };
  const settlementDetails = [
    ...toArray(entryObservationPreflight?.details).map((item: any) => ({ ...item, source_step: '预沉淀' })),
    ...toArray(entryObservationSettlement?.details).map((item: any) => ({ ...item, source_step: '沉淀收尾' }))
  ];
  const settlementMessage = [entryObservationPreflight?.message, entryObservationSettlement?.message]
    .filter(Boolean)
    .join('；');

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
    settlement_changes: {
      label: '自动沉淀/归档',
      metrics: mergeMetrics(entryObservationPreflight?.metrics, entryObservationSettlement?.metrics),
      items: settlementDetails.slice(0, 8),
      summary: settlementMessage || '暂无入场观察沉淀记录'
    },
    plan_actions: {
      label: '计划动作建议',
      metrics: activePlanSuggestions?.metrics || {},
      items: toArray(activePlanSuggestions?.details).slice(0, 8),
      summary: activePlanSuggestions?.message || '暂无计划动作建议记录'
    }
  };
}

function getPipelineDailyChangesCacheKey(run: any) {
  return [
    run?.id || '',
    run?.task_key || '',
    run?.status || '',
    run?.message || '',
    run?.started_at || '',
    run?.finished_at || '',
    run?.result_json_size || 0
  ].join('|');
}

async function buildWorkflowDailyChanges(db: any, latestPipelineRun: any) {
  if (!latestPipelineRun) return null;

  const cacheKey = getPipelineDailyChangesCacheKey(latestPipelineRun);
  if (workflowDailyChangesCache?.key === cacheKey && workflowDailyChangesCache.expiresAt > Date.now()) {
    return workflowDailyChangesCache.data;
  }

  const resultRow = await db.get(
    `SELECT result_json
     FROM task_center_runs
     WHERE id = ?`,
    [latestPipelineRun.id]
  );
  const latestPipelineResult = resultRow?.result_json ? compactPipelineResult(resultRow.result_json) : null;
  const dailyChanges = latestPipelineResult ? {
    run_id: latestPipelineRun.id,
    task_key: latestPipelineRun.task_key,
    status: latestPipelineRun.status,
    message: latestPipelineRun.message,
    started_at: latestPipelineRun.started_at,
    finished_at: latestPipelineRun.finished_at,
    duration_seconds: getDurationSeconds(latestPipelineRun.started_at, latestPipelineRun.finished_at),
    ...extractDailyChanges(latestPipelineResult)
  } : null;

  workflowDailyChangesCache = {
    key: cacheKey,
    expiresAt: latestPipelineRun.status === 'running'
      ? Date.now() + WORKFLOW_SUMMARY_CACHE_TTL_MS
      : Number.POSITIVE_INFINITY,
    data: dailyChanges
  };

  return dailyChanges;
}

async function buildWorkflowDailyPriceHealth(db: any) {
  if (workflowDailyPriceHealthCache && workflowDailyPriceHealthCache.expiresAt > Date.now()) {
    return workflowDailyPriceHealthCache.data;
  }

  const targetTradeRow = await db.get(
    `SELECT MAX(trade_date) AS trade_date
     FROM financial_daily_prices
     WHERE source = 'tushare'
       AND asset_type IN ('stock', 'etf', 'index')
       AND close IS NOT NULL
       AND close > 0`
  );
  const targetTradeDate = targetTradeRow?.trade_date || null;
  if (!targetTradeDate) {
    const data = {
      target_trade_date: null,
      covered_trade_date: null,
      raw_latest_trade_date: null,
      rows: 0,
      coverage: null
    };
    workflowDailyPriceHealthCache = {
      expiresAt: Date.now() + 5 * 1000,
      data
    };
    return data;
  }

  const previousRow = await db.get(
    `SELECT MAX(trade_date) AS trade_date
     FROM financial_daily_prices
     WHERE source = 'tushare'
       AND asset_type IN ('stock', 'etf')
       AND trade_date < ?`,
    [targetTradeDate]
  );
  const previousTradeDate = previousRow?.trade_date || null;

  const allRowsForDate = async (tradeDate: string) => {
    const row = await db.get(
      `SELECT COUNT(p.symbol) AS count
       FROM financial_daily_prices p
       WHERE p.source = 'tushare'
         AND p.asset_type IN ('stock', 'etf', 'index')
         AND p.trade_date = ?
         AND p.close IS NOT NULL
         AND p.close > 0`,
      [tradeDate]
    );
    return Number(row?.count || 0);
  };
  const enabledRowsForDate = async (tradeDate: string) => {
    const row = await db.get(
      `SELECT COUNT(DISTINCT p.symbol || '|' || p.asset_type || '|' || p.source) AS count
       FROM financial_daily_prices p
       JOIN financial_asset_universe u
         ON u.symbol = p.symbol
        AND u.asset_type = p.asset_type
        AND u.source = p.source
       WHERE p.source = 'tushare'
         AND p.asset_type IN ('stock', 'etf')
         AND p.trade_date = ?
         AND u.enabled = 1`,
      [tradeDate]
    );
    return Number(row?.count || 0);
  };

  const [
    rawLatestRows,
    currentEnabledCount,
    previousEnabledCount
  ] = await Promise.all([
    allRowsForDate(targetTradeDate),
    enabledRowsForDate(targetTradeDate),
    previousTradeDate ? enabledRowsForDate(previousTradeDate) : Promise.resolve(0)
  ]);
  const minExpected = previousEnabledCount > 0 ? Math.floor(previousEnabledCount * 0.92) : 0;
  const coverageStatus = previousEnabledCount > 0 && currentEnabledCount < minExpected ? 'incomplete' : 'ok';
  const coveredTradeDate = coverageStatus === 'incomplete'
    ? await getLatestCoveredTradeDate(db)
    : targetTradeDate;
  const data = {
    target_trade_date: targetTradeDate,
    covered_trade_date: coveredTradeDate,
    raw_latest_trade_date: targetTradeDate,
    rows: rawLatestRows,
    coverage: previousTradeDate ? {
      current_count: currentEnabledCount,
      previous_trade_date: previousTradeDate,
      previous_count: previousEnabledCount,
      min_expected: minExpected,
      status: coverageStatus
    } : null
  };

  workflowDailyPriceHealthCache = {
    expiresAt: Date.now() + 5 * 1000,
    data
  };
  return data;
}

async function buildWorkflowLatestEntryObservationRows(db: any) {
  if (workflowEntryObservationRowsCache && workflowEntryObservationRowsCache.expiresAt > Date.now()) {
    return workflowEntryObservationRowsCache.data;
  }

  const rows = await db.all(
    `${latestEntryObservationCte},
     latest_signal_lifecycles AS (
       SELECT *
       FROM (
         SELECT l.*,
                ROW_NUMBER() OVER (
                  PARTITION BY l.symbol, l.asset_type, l.source
                  ORDER BY COALESCE(l.latest_check_date, l.updated_at) DESC, l.id DESC
                ) AS rn
         FROM financial_signal_lifecycles l
       )
       WHERE rn = 1
     )
     SELECT o.id, o.symbol, o.name, o.asset_type, o.source, o.observation_status,
            o.entry_action, o.snapshot_json,
            o.trigger_score, o.trigger_reason, o.structure_score, o.trend_phase_code,
            o.close_price, o.invalidation_line, o.note,
            o.manual_review_action, o.manual_review_label, o.manual_review_note, o.manual_reviewed_at,
            l.maturity_status AS lifecycle_status,
            l.maturity_label AS lifecycle_label,
            l.flip_count AS lifecycle_flip_count,
            l.consecutive_valid_days AS lifecycle_consecutive_valid_days,
            o.updated_at
     FROM latest_entry_observations o
     LEFT JOIN latest_signal_lifecycles l
       ON l.symbol = o.symbol
      AND l.asset_type = o.asset_type
      AND l.source = o.source`
  );

  workflowEntryObservationRowsCache = {
    expiresAt: Date.now() + 5 * 1000,
    data: rows
  };
  return rows;
}

async function buildWorkflowLightSummary(db: any) {
  const [
    market,
    dailyPriceHealth,
    candidateCountsRow,
    tradePlansActiveRow,
    latestEntryObservationRows,
    activeTradePlanKeyRows,
    latestCandidates,
    waitConfirmationCandidateRows,
    candidateFlowIntegrity
  ] = await Promise.all([
    getFreshMarketRegime(db, { source: 'tushare' }),
    buildWorkflowDailyPriceHealth(db),
    db.get(
      `SELECT
         SUM(CASE WHEN pool_status = 'active' AND COALESCE(review_status, 'unreviewed') <> 'rejected' THEN 1 ELSE 0 END) AS candidate_active,
         SUM(CASE WHEN pool_status = 'active' AND COALESCE(review_status, 'unreviewed') = 'unreviewed' THEN 1 ELSE 0 END) AS review_unreviewed,
         SUM(CASE WHEN pool_status = 'active' AND review_status = 'drafted' THEN 1 ELSE 0 END) AS review_drafted,
         SUM(CASE WHEN pool_status = 'active' AND review_status = 'trend_blocked' THEN 1 ELSE 0 END) AS trend_blocked,
         SUM(CASE WHEN pool_status = 'active' AND review_status = 'structure_pending' THEN 1 ELSE 0 END) AS structure_pending,
         SUM(CASE WHEN pool_status = 'active' AND review_status = 'structure_watch' THEN 1 ELSE 0 END) AS structure_watch,
         SUM(CASE WHEN pool_status = 'active' AND review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM financial_candidate_pool
       WHERE asset_type IN ('stock', 'etf')`
    ),
    db.get(
      `SELECT COUNT(*) AS count
       FROM financial_trade_plans
       WHERE is_deleted = 0
         AND status IN ('draft', 'watching', 'paper_tracking', 'active')`
    ),
    buildWorkflowLatestEntryObservationRows(db),
    db.all(
      `SELECT symbol, asset_type, source
       FROM financial_trade_plans
       WHERE is_deleted = 0
         AND status IN ('draft', 'watching', 'paper_tracking', 'active')`
    ),
    db.all(
      `SELECT id, symbol, name, asset_type, priority_score, review_status, candidate_reason, last_checked_at
       FROM financial_candidate_pool
       WHERE pool_status = 'active'
         AND asset_type IN ('stock', 'etf')
         AND COALESCE(review_status, 'unreviewed') <> 'rejected'
       ORDER BY priority_score DESC, last_checked_at DESC
       LIMIT 6`
    ),
    db.all(
      `SELECT c.id, c.symbol, c.name, c.asset_type, c.source, c.priority_score, c.last_review_at
       FROM financial_candidate_pool c
       WHERE c.pool_status = 'active'
         AND c.asset_type IN ('stock', 'etf')
         AND c.review_status = 'wait_confirmation'`
    ),
    buildCandidateFlowIntegrity(db)
  ]);

  const rowKey = (row: any) => `${row.symbol || ''}|${row.asset_type || ''}|${row.source || ''}`;
  const numberValue = (value: any) => Number(value || 0);
  const rowTime = (value: any) => {
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
  };
  const activeTradePlanKeys = new Set(activeTradePlanKeyRows.map(rowKey));
  const activeEntryObservationKeys = new Set(
    latestEntryObservationRows
      .filter((row: any) => ['watching', 'plan_candidate', 'confirmed'].includes(row.observation_status))
      .map(rowKey)
  );
  const planReadyObservationRows = latestEntryObservationRows
    .filter((row: any) => ['confirmed', 'plan_candidate'].includes(row.observation_status) && !activeTradePlanKeys.has(rowKey(row)));
  const pendingTriggerRows = waitConfirmationCandidateRows
    .filter((row: any) => !activeEntryObservationKeys.has(rowKey(row)));
  const latestObservations = latestEntryObservationRows
    .slice()
    .sort((a: any, b: any) => rowTime(b.updated_at) - rowTime(a.updated_at) || numberValue(b.id) - numberValue(a.id))
    .slice(0, 6)
    .map((row: any) => ({
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      asset_type: row.asset_type,
      observation_status: row.observation_status,
      trigger_score: row.trigger_score,
      trend_phase_code: row.trend_phase_code,
      updated_at: row.updated_at
    }));
  const dailyCoverage = dailyPriceHealth.coverage;
  const targetTradeDate = dailyPriceHealth.target_trade_date || market?.target_trade_date || null;
  const coveredTradeDate = dailyPriceHealth.covered_trade_date || null;
  const workflowWarnings = [];
  if (market?.stale) {
    workflowWarnings.push({
      code: 'market_gate_stale',
      level: 'block_flow',
      message: market.freshness_reason
    });
  }
  if (dailyCoverage?.status === 'incomplete') {
    workflowWarnings.push({
      code: 'daily_prices_incomplete',
      level: 'block_flow',
      message: `最新日线 ${targetTradeDate || '--'} 覆盖不足，当前流程应锁定最近完整交易日 ${coveredTradeDate || '--'}，不要用半截行情推进备选池、漏斗和入场触发。`
    });
  }
  appendCandidateFlowWarnings(workflowWarnings, candidateFlowIntegrity);

  return {
    market,
    counts: {
      candidate_active: numberValue(candidateCountsRow?.candidate_active),
      review_unreviewed: numberValue(candidateCountsRow?.review_unreviewed),
      review_drafted: numberValue(candidateCountsRow?.review_drafted),
      trend_blocked: numberValue(candidateCountsRow?.trend_blocked),
      structure_pending: numberValue(candidateCountsRow?.structure_pending),
      structure_watch: numberValue(candidateCountsRow?.structure_watch),
      wait_confirmation: pendingTriggerRows.length,
      entry_observations: latestEntryObservationRows.filter((row: any) => ['watching', 'plan_candidate'].includes(row.observation_status)).length,
      plan_ready: planReadyObservationRows.length,
      invalidated: numberValue(candidateCountsRow?.rejected) + latestEntryObservationRows.filter((row: any) => row.observation_status === 'invalidated').length,
      trade_plans_active: numberValue(tradePlansActiveRow?.count)
    },
    latest_candidates: latestCandidates,
    latest_observations: latestObservations,
    data_freshness: {
      target_trade_date: targetTradeDate,
      effective_trade_date: coveredTradeDate || targetTradeDate,
      raw_latest_trade_date: targetTradeDate,
      workflow_data_mode: dailyCoverage?.status === 'incomplete' ? 'locked_to_latest_covered_trade_date' : 'latest_trade_date',
      workflow_warnings: workflowWarnings,
      queue_integrity: candidateFlowIntegrity,
      sources: [{
        key: 'daily_prices',
        label: 'A股/ETF日线',
        latest_trade_date: targetTradeDate,
        target_trade_date: targetTradeDate,
        lag_days: 0,
        status: dailyCoverage?.status === 'incomplete' ? 'incomplete' : targetTradeDate ? 'fresh' : 'missing',
        rows: Number(dailyPriceHealth.rows || 0),
        ...(dailyCoverage ? { coverage: dailyCoverage } : {})
      }]
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
  const queueInfo = buildEntryObservationQueueInfo(row, parseJsonConfig(row.snapshot_json));
  const close = Number(row.close_price || 0);
  const invalidationLine = Number(row.invalidation_line || 0);
  const observationActionCode = getEntryObservationQueueActionCode(queueInfo, isPlanReady);
  return {
    id: row.id,
    source_type: sourceType,
    lane: isPlanReady ? '计划准备' : '入场观察',
    symbol: row.symbol,
    name: row.name,
    asset_type: row.asset_type,
    status: row.observation_status || (isPlanReady ? 'confirmed' : 'watching'),
    priority: isPlanReady || ['READY_TO_PLAN_AUTO', 'RISK_PRIORITY_RECHECK'].includes(observationActionCode) ? 'high' : 'normal',
    action_code: observationActionCode,
    action_label: isPlanReady ? '待生成计划' : queueInfo.observation_queue_label,
    action_reason: isPlanReady ? row.trigger_reason || '等待生成计划' : queueInfo.observation_queue_reason,
    today_permission: isPlanReady
      ? '可进入计划准备，仍不代表买入'
      : observationActionCode === 'RISK_PRIORITY_RECHECK'
        ? '高触发但生命周期翻转，不自动进计划，先人工复核'
        : observationActionCode === 'LIFECYCLE_RECHECK'
          ? '触发已满足但生命周期未稳定，继续复核'
          : observationActionCode === 'RISK_HOLD'
            ? '风险未解除，不进计划'
        : '今天不动，继续观察',
    need_reduce_or_stop_add: false,
    invalidated: false,
    just_hold: !isPlanReady,
    can_prepare: isPlanReady,
    close_price: close || null,
    invalidation_line: invalidationLine || null,
    trigger_score: row.trigger_score,
    structure_score: row.structure_score,
    trend_phase_code: row.trend_phase_code,
    lifecycle_status: row.lifecycle_status || null,
    lifecycle_label: row.lifecycle_label || null,
    manual_review_action: row.manual_review_action || null,
    position_amount: 0,
    updated_at: row.updated_at,
    path: isPlanReady
      ? '/finance/entry-trigger/plan-ready'
      : observationActionCode === 'RISK_PRIORITY_RECHECK'
        ? '/finance/entry-trigger/observations?observation_scope=risk_priority_recheck'
        : observationActionCode === 'LIFECYCLE_RECHECK'
          ? '/finance/entry-trigger/observations?observation_scope=lifecycle_recheck'
          : observationActionCode === 'RISK_HOLD'
            ? '/finance/entry-trigger/observations?observation_scope=risk_hold'
            : '/finance/entry-trigger/observations'
  };
}

router.get('/workflow-summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const dailyPriceHealth = await buildWorkflowDailyPriceHealth(db);
    const coveredTradeDate = dailyPriceHealth.covered_trade_date;

    const latestMarket = await db.get(
      `SELECT symbol, name, trade_date, close, market_regime, entry_permission, entry_reason, distance_to_ma60
       FROM financial_market_regime
       WHERE symbol = '000300'
         ${coveredTradeDate ? 'AND trade_date <= ?' : ''}
       ORDER BY trade_date DESC, id DESC
       LIMIT 1`,
      coveredTradeDate ? [coveredTradeDate] : []
    );

    const [
      candidateCountsRow,
      tradePlansActiveRow,
      latestEntryObservationRows,
      activeTradePlanKeyRows,
      activePlanReadyCandidateRows
    ] = await Promise.all([
      db.get(
        `SELECT
           SUM(CASE WHEN pool_status = 'active' AND COALESCE(review_status, 'unreviewed') <> 'rejected' THEN 1 ELSE 0 END) AS candidate_active,
           SUM(CASE WHEN pool_status = 'active' AND COALESCE(review_status, 'unreviewed') = 'unreviewed' THEN 1 ELSE 0 END) AS review_unreviewed,
           SUM(CASE WHEN pool_status = 'active' AND review_status = 'drafted' THEN 1 ELSE 0 END) AS review_drafted,
           SUM(CASE WHEN pool_status = 'active' AND review_status = 'trend_blocked' THEN 1 ELSE 0 END) AS trend_blocked,
           SUM(CASE WHEN pool_status = 'active' AND review_status = 'structure_pending' THEN 1 ELSE 0 END) AS structure_pending,
           SUM(CASE WHEN pool_status = 'active' AND review_status = 'structure_watch' THEN 1 ELSE 0 END) AS structure_watch,
           SUM(CASE WHEN pool_status = 'active' AND review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected
         FROM financial_candidate_pool
         WHERE asset_type IN ('stock', 'etf')`
      ),
      db.get(
        `SELECT COUNT(*) AS count
         FROM financial_trade_plans
         WHERE is_deleted = 0
           AND status IN ('draft', 'watching', 'paper_tracking', 'active')`
      ),
      buildWorkflowLatestEntryObservationRows(db),
      db.all(
        `SELECT symbol, asset_type, source
         FROM financial_trade_plans
         WHERE is_deleted = 0
           AND status IN ('draft', 'watching', 'paper_tracking', 'active')`
      ),
      db.all(
        `SELECT symbol, asset_type, source
         FROM financial_candidate_pool
         WHERE pool_status = 'active'
           AND asset_type IN ('stock', 'etf')
           AND review_status = 'plan_ready'`
      )
    ]);
    const rowKey = (row: any) => `${row.symbol || ''}|${row.asset_type || ''}|${row.source || ''}`;
    const activeTradePlanKeys = new Set(activeTradePlanKeyRows.map(rowKey));
    const activePlanReadyCandidateKeys = new Set(activePlanReadyCandidateRows.map(rowKey));
    const activeEntryObservationKeys = new Set(
      latestEntryObservationRows
        .filter((row: any) => ['watching', 'plan_candidate', 'confirmed'].includes(row.observation_status))
        .map(rowKey)
    );
    const planReadyObservationRows = latestEntryObservationRows
      .filter((row: any) => ['confirmed', 'plan_candidate'].includes(row.observation_status) && !activeTradePlanKeys.has(rowKey(row)));
    const waitConfirmationObservationBlockers = activeEntryObservationKeys;
    const counts = {
      candidate_active: Number(candidateCountsRow?.candidate_active || 0),
      review_unreviewed: Number(candidateCountsRow?.review_unreviewed || 0),
      review_drafted: Number(candidateCountsRow?.review_drafted || 0),
      trend_blocked: Number(candidateCountsRow?.trend_blocked || 0),
      structure_pending: Number(candidateCountsRow?.structure_pending || 0),
      structure_watch: Number(candidateCountsRow?.structure_watch || 0),
      wait_confirmation: 0,
      entry_observations: latestEntryObservationRows.filter((row: any) => ['watching', 'plan_candidate'].includes(row.observation_status)).length,
      plan_ready: planReadyObservationRows.length,
      invalidated: Number(candidateCountsRow?.rejected || 0) + latestEntryObservationRows.filter((row: any) => row.observation_status === 'invalidated').length,
      trade_plans_active: Number(tradePlansActiveRow?.count || 0),
    };

    const [
      latestCandidates,
      highPrioritySuggestions,
      waitConfirmationCandidateRows,
      rejectedCandidateItems,
      activePlanRows
    ] = await Promise.all([
      db.all(
        `SELECT id, symbol, name, asset_type, priority_score, review_status, candidate_reason, last_checked_at
         FROM financial_candidate_pool
         WHERE pool_status = 'active'
           AND asset_type IN ('stock', 'etf')
           AND COALESCE(review_status, 'unreviewed') <> 'rejected'
         ORDER BY priority_score DESC, last_checked_at DESC
         LIMIT 6`
      ),
      db.all(
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
      ),
      db.all(
        `SELECT c.id, c.symbol, c.name, c.asset_type, c.source, c.priority_score, c.candidate_reason, c.last_review_at
         FROM financial_candidate_pool c
         WHERE c.pool_status = 'active'
           AND c.asset_type IN ('stock', 'etf')
           AND c.review_status = 'wait_confirmation'`
      ),
      db.all(
        `SELECT id, symbol, name, asset_type, 'candidate' as source_type, forbidden_reason as reason, updated_at
         FROM financial_candidate_pool
         WHERE pool_status = 'active'
           AND asset_type IN ('stock', 'etf')
           AND review_status = 'rejected'
         ORDER BY updated_at DESC
         LIMIT 12`
      ),
      db.all(
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
           COALESCE(s.suggestion_date, p.updated_at) DESC`
      )
    ]);

    const numberValue = (value: any) => Number(value || 0);
    const rowTime = (value: any) => {
      const time = value ? new Date(value).getTime() : 0;
      return Number.isFinite(time) ? time : 0;
    };
    const compareUpdatedDesc = (a: any, b: any) => rowTime(b.updated_at) - rowTime(a.updated_at)
      || numberValue(b.id) - numberValue(a.id);
    const pickLatestObservation = (row: any) => ({
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      asset_type: row.asset_type,
      observation_status: row.observation_status,
      trigger_score: row.trigger_score,
      trend_phase_code: row.trend_phase_code,
      updated_at: row.updated_at
    });
    const pickPlanReadyObservation = (row: any) => ({
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      asset_type: row.asset_type,
      trigger_score: row.trigger_score,
      trigger_reason: row.trigger_reason,
      structure_score: row.structure_score,
      trend_phase_code: row.trend_phase_code,
      close_price: row.close_price,
      invalidation_line: row.invalidation_line,
      updated_at: row.updated_at
    });
    const hydrateWatchObservationQueue = (row: any) => ({
      ...row,
      ...buildEntryObservationQueueInfo(row, parseJsonConfig(row.snapshot_json))
    });
    const getObservationQueuePath = (actionCode: string) => {
      switch (actionCode) {
        case 'RISK_PRIORITY_RECHECK':
          return '/finance/entry-trigger/observations?observation_scope=risk_priority_recheck';
        case 'LIFECYCLE_RECHECK':
          return '/finance/entry-trigger/observations?observation_scope=lifecycle_recheck';
        case 'RISK_HOLD':
          return '/finance/entry-trigger/observations?observation_scope=risk_hold';
        default:
          return '/finance/entry-trigger/observations';
      }
    };
    const pickWatchObservation = (row: any) => {
      const actionCode = getEntryObservationQueueActionCode(row);
      return {
        id: row.id,
        symbol: row.symbol,
        name: row.name,
        asset_type: row.asset_type,
        observation_status: row.observation_status,
        trigger_score: row.trigger_score,
        trigger_reason: row.trigger_reason,
        trend_phase_code: row.trend_phase_code,
        updated_at: row.updated_at,
        label: row.observation_queue_label,
        detail: row.observation_queue_reason,
        score: row.trigger_score,
        priority: actionCode === 'RISK_PRIORITY_RECHECK' || actionCode === 'RISK_HOLD' ? 'high' : 'normal',
        path: getObservationQueuePath(actionCode)
      };
    };
    const latestObservations = latestEntryObservationRows
      .slice()
      .sort(compareUpdatedDesc)
      .slice(0, 6)
      .map(pickLatestObservation);
    const planReadyRank = (row: any) => {
      const triggerScore = numberValue(row.trigger_score);
      const structureScore = numberValue(row.structure_score);
      const close = numberValue(row.close_price);
      const invalidationLine = numberValue(row.invalidation_line);
      const invalidationDistance = close > 0 && invalidationLine > 0
        ? (close - invalidationLine) / close
        : 9;
      if (row.trend_phase_code === 'SLOW_GRIND_UP' && triggerScore >= 75 && structureScore >= 75 && invalidationDistance <= 0.04) return 0;
      if (triggerScore >= 80 && structureScore >= 75) return 1;
      if (row.trend_phase_code === 'BREAKOUT' && triggerScore >= 70 && structureScore >= 75) return 2;
      if (row.trend_phase_code === 'SLOW_GRIND_UP') return 3;
      if (row.trend_phase_code === 'BREAKOUT') return 4;
      if (row.trend_phase_code === 'RECOVERY') return 5;
      return 9;
    };
    const planReadyItems = planReadyObservationRows
      .slice()
      .sort((a: any, b: any) => {
        const closeA = numberValue(a.close_price);
        const invalidationA = numberValue(a.invalidation_line);
        const distanceA = closeA > 0 && invalidationA > 0 ? (closeA - invalidationA) / closeA : 9;
        const closeB = numberValue(b.close_price);
        const invalidationB = numberValue(b.invalidation_line);
        const distanceB = closeB > 0 && invalidationB > 0 ? (closeB - invalidationB) / closeB : 9;
        return planReadyRank(a) - planReadyRank(b)
          || numberValue(b.trigger_score) - numberValue(a.trigger_score)
          || distanceA - distanceB
          || compareUpdatedDesc(a, b);
      })
      .slice(0, 6)
      .map(pickPlanReadyObservation);
    const pendingTriggerRows = waitConfirmationCandidateRows
      .filter((row: any) => !waitConfirmationObservationBlockers.has(rowKey(row)));
    counts.wait_confirmation = pendingTriggerRows.length;
    const pendingTriggerItems = pendingTriggerRows
      .slice()
      .sort((a: any, b: any) => numberValue(b.priority_score) - numberValue(a.priority_score)
        || rowTime(b.last_review_at) - rowTime(a.last_review_at)
        || numberValue(b.id) - numberValue(a.id))
      .slice(0, 6);
    const watchObservationItems = latestEntryObservationRows
      .filter((row: any) => ['watching', 'plan_candidate'].includes(row.observation_status))
      .map(hydrateWatchObservationQueue)
      .sort(compareObservationQueueItems)
      .slice(0, 6)
      .map(pickWatchObservation);
    const invalidatedItems = [
      ...rejectedCandidateItems,
      ...latestEntryObservationRows
        .filter((row: any) => row.observation_status === 'invalidated')
        .map((row: any) => ({
          id: row.id,
          symbol: row.symbol,
          name: row.name,
          asset_type: row.asset_type,
          source_type: 'observation',
          reason: row.note,
          updated_at: row.updated_at
        }))
    ].sort(compareUpdatedDesc).slice(0, 6);

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
	          path: '/finance/entry-trigger/plan-ready'
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
	          path: '/finance/entry-trigger/pending'
	        }))
	    ].slice(0, 8);
	
	    const todaySummary = {
	      focus_items: todayFocus,
	      plan_ready: planReadyItems.map((item: any) => ({
	        ...item,
	        path: '/finance/entry-trigger/plan-ready'
	      })),
	      pending_triggers: pendingTriggerItems.map((item: any) => ({
	        ...item,
	        path: '/finance/entry-trigger/pending'
	      })),
	      entry_watch: watchObservationItems.map((item: any) => ({
	        ...item,
	        path: item.path || '/finance/entry-trigger/observations'
	      })),
	      risk_alerts: highPrioritySuggestions,
	      invalidated: invalidatedItems.map((item: any) => ({
	        ...item,
	        path: item.source_type === 'candidate'
	          ? `/finance/candidate-pool/${item.asset_type === 'etf' ? 'etf' : 'stock'}`
	          : '/finance/entry-trigger/observations?observation_scope=invalidated'
	      }))
	    };

    const allRiskBoardItems = [
      ...activePlanRows.map(buildRiskBoardPlanItem),
      ...planReadyObservationRows.map((item: any) => buildRiskBoardObservationItem(item, 'plan_ready')),
      ...latestEntryObservationRows
        .filter((row: any) => row.observation_status === 'watching')
        .map((item: any) => buildRiskBoardObservationItem(item, 'entry_watch'))
    ].sort((a: any, b: any) => {
      const priority = (item: any) => {
        if (item.invalidated) return 0;
        if (item.need_reduce_or_stop_add) return 1;
        if (item.action_code === 'RISK_PRIORITY_RECHECK') return 2;
        if (item.action_code === 'LIFECYCLE_RECHECK') return 3;
        if (item.action_code === 'RISK_HOLD') return 4;
        if (item.can_prepare) return 5;
        if (item.priority === 'high') return 6;
        return 7;
      };
      return priority(a) - priority(b)
        || Number(b.trigger_score || 0) - Number(a.trigger_score || 0)
        || rowTime(b.updated_at) - rowTime(a.updated_at)
        || numberValue(b.id) - numberValue(a.id);
    });
    const riskBoardItems = allRiskBoardItems.slice(0, 18);

    const riskBoard = {
      summary: {
        total: allRiskBoardItems.length,
        allowed_to_prepare: allRiskBoardItems.filter((item: any) => item.can_prepare && !item.invalidated).length,
        plan_ready_to_prepare: allRiskBoardItems.filter((item: any) => item.can_prepare && !item.invalidated && item.source_type !== 'trade_plan').length,
        trade_plan_can_prepare: allRiskBoardItems.filter((item: any) => item.can_prepare && !item.invalidated && item.source_type === 'trade_plan').length,
        reduce_or_stop_add: allRiskBoardItems.filter((item: any) => item.need_reduce_or_stop_add).length,
        invalidated: allRiskBoardItems.filter((item: any) => item.invalidated).length,
        high_trigger_recheck: allRiskBoardItems.filter((item: any) => item.action_code === 'RISK_PRIORITY_RECHECK').length,
        lifecycle_recheck: allRiskBoardItems.filter((item: any) => item.action_code === 'LIFECYCLE_RECHECK').length,
        risk_hold: allRiskBoardItems.filter((item: any) => item.action_code === 'RISK_HOLD').length,
        just_hold: allRiskBoardItems.filter((item: any) => ['WATCH_ENTRY', 'WAIT_PULLBACK'].includes(item.action_code)).length,
        preview_count: riskBoardItems.length
      },
      items: riskBoardItems
    };

    const latestPipelineRun = await db.get(
      `SELECT id, task_key, status, message, started_at, finished_at, LENGTH(result_json) AS result_json_size
       FROM task_center_runs
       WHERE task_key IN (?, ?)
       ORDER BY datetime(REPLACE(COALESCE(finished_at, started_at), 'T', ' ')) DESC,
                datetime(REPLACE(started_at, 'T', ' ')) DESC,
                id DESC
       LIMIT 1`,
      [FINANCE_PIPELINE_TASK_KEY, FINANCE_FUNNEL_TASK_KEY]
    );
    const dailyChanges = await buildWorkflowDailyChanges(db, latestPipelineRun);

    const targetTradeDate = dailyPriceHealth.target_trade_date;
    const lagDays = (tradeDate?: string | null) => {
      if (!targetTradeDate || !tradeDate) return null;
      const start = new Date(`${tradeDate}T00:00:00Z`).getTime();
      const end = new Date(`${targetTradeDate}T00:00:00Z`).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return Math.max(0, Math.round((end - start) / (24 * 60 * 60 * 1000)));
    };
    const freshnessStatus = (tradeDate?: string | null) => {
      const lag = lagDays(tradeDate);
      if (!tradeDate) return 'missing';
      if (lag === null || lag <= 0) return 'fresh';
      if (lag <= 2) return 'lagging';
      return 'stale';
    };
	    const sourceFreshness = async (key: string, label: string, sql: string, params: any[] = [], extra: Record<string, any> = {}) => {
	      const row = await db.get(sql, params);
	      const tradeDate = row?.trade_date || null;
	      return {
	        key,
        label,
        latest_trade_date: tradeDate,
        target_trade_date: targetTradeDate,
        lag_days: lagDays(tradeDate),
        status: extra.status || freshnessStatus(tradeDate),
        rows: Number(row?.rows || row?.count || 0),
	        ...extra
	      };
	    };
	    const buildMetalWorkflowHealth = async () => {
	      const cacheKey = targetTradeDate || 'no-target-date';
	      const cachedMetalsHealth = workflowMetalsHealthCache;
	      if (cachedMetalsHealth !== null && cachedMetalsHealth.key === cacheKey && cachedMetalsHealth.expiresAt > Date.now()) {
	        return cachedMetalsHealth.data;
	      }
	      const assets = [
	        { symbol: 'XAUUSD', label: '黄金主锚' },
	        { symbol: 'SGE_AGTD', label: '白银弹性' }
	      ];
	      const items = await Promise.all(assets.map(async (item) => {
	        const asset = getMetalAsset(item.symbol);
	        if (!asset) {
	          return {
	            symbol: item.symbol,
	            label: item.label,
	            status: 'missing',
	            health_level: 'data_gap',
	            reason: '贵金属资产配置不存在，无法纳入金融主流程健康检查。'
	          };
	        }
	        const prices = filterMetalTradingPrices(await db.all(
	          `SELECT trade_date, open, high, low, close, volume, amount
	           FROM (
	             SELECT trade_date, open, high, low, close, volume, amount
	             FROM financial_daily_prices
	             WHERE symbol = ?
	               AND source = ?
	               AND strftime('%w', trade_date) NOT IN ('0', '6')
	             ORDER BY trade_date DESC
	             LIMIT 1260
	           )
	           ORDER BY trade_date ASC`,
	          [item.symbol, asset.source]
	        ));
	        if (prices.length === 0) {
	          return {
	            symbol: item.symbol,
	            label: item.label,
	            source: asset.source,
	            status: 'missing',
	            rows: 0,
	            health_level: 'data_gap',
	            reason: '暂无贵金属日线，先跑贵金属行情更新。'
	          };
	        }
	        const regime = calculateMetalRegime(prices, asset.source);
	        const status = prices.length < 120 ? 'incomplete' : freshnessStatus(regime.trade_date);
	        const isDataGap = status === 'missing' || status === 'stale' || status === 'incomplete';
	        const isRiskState = ['RISK', 'OVERHEAT', 'UNKNOWN'].includes(regime.state_code);
	        const isWatchState = ['REBOUND', 'LOW_RANGE', 'REPAIR_WATCH', 'STRUCTURE_FORMING', 'SAFE_CANDIDATE'].includes(regime.state_code);
	        const healthLevel = isDataGap ? 'data_gap' : isRiskState ? 'risk' : isWatchState ? 'watch' : 'ok';
	        return {
	          symbol: item.symbol,
	          label: item.label,
	          source: asset.source,
	          latest_trade_date: regime.trade_date,
	          target_trade_date: targetTradeDate,
	          lag_days: lagDays(regime.trade_date),
	          rows: prices.length,
	          close: regime.close,
	          status,
	          health_level: healthLevel,
	          state_code: regime.state_code,
	          state_label: regime.mid_label || regime.state_code,
	          entry_permission: regime.entry_permission,
	          entry_reason: regime.entry_reason,
	          safe_confirmation_days: regime.safe_confirmation_days || 0,
	          signal_maturity_label: regime.signal_maturity_label || null,
	          latest_change: regime.latest_change,
	          reason: isDataGap
	            ? `贵金属行情口径${status === 'incomplete' ? '样本不足' : '未对齐'}，不能只看 A股/ETF 健康就推进。`
	            : regime.entry_reason
	        };
	      }));
	      const health = {
	        summary: {
	          total: items.length,
	          ok: items.filter((item: any) => item.health_level === 'ok').length,
	          watch: items.filter((item: any) => item.health_level === 'watch').length,
	          risk: items.filter((item: any) => item.health_level === 'risk').length,
	          data_gap: items.filter((item: any) => item.health_level === 'data_gap').length,
	          action_required: items.filter((item: any) => item.health_level === 'risk' || item.health_level === 'data_gap').length
	        },
	        items
	      };
	      workflowMetalsHealthCache = {
	        key: cacheKey,
	        expiresAt: Date.now() + 5 * 1000,
	        data: health
	      };
	      return health;
	    };
	    const dailyCoverage = dailyPriceHealth.coverage;
    const activePlanReadyCandidateCount = activePlanReadyCandidateRows.length;
    const confirmedWithoutActivePlanReadyCandidate = latestEntryObservationRows
      .filter((row: any) => ['confirmed', 'plan_candidate'].includes(row.observation_status) && !activePlanReadyCandidateKeys.has(rowKey(row)))
      .length;
    const metalsHealth = await buildMetalWorkflowHealth();
    const candidateFlowIntegrity = await buildCandidateFlowIntegrity(db);
	    const workflowWarnings = [];
	    if (dailyCoverage?.status === 'incomplete') {
	      workflowWarnings.push({
	        code: 'daily_prices_incomplete',
        level: 'block_flow',
        message: `最新日线 ${targetTradeDate} 覆盖不足，当前流程应锁定最近完整交易日 ${coveredTradeDate || '--'}，不要用半截行情推进备选池、漏斗和入场触发。`
      });
    }
    if (confirmedWithoutActivePlanReadyCandidate > 0) {
      workflowWarnings.push({
        code: 'plan_ready_queue_mismatch',
        level: 'needs_reconcile',
	        message: `发现 ${confirmedWithoutActivePlanReadyCandidate} 条已确认入场观察未对应 active 计划准备候选，可能来自历史半推进或人工/流水线错位。`
	      });
	    }
	    if (metalsHealth.summary.action_required > 0) {
	      const blockedLabels = metalsHealth.items
	        .filter((item: any) => item.health_level === 'risk' || item.health_level === 'data_gap')
	        .map((item: any) => `${item.label}${item.state_label ? `/${item.state_label}` : ''}`);
	      workflowWarnings.push({
	        code: 'metals_health_attention',
	        level: 'needs_review',
	        message: `贵金属主流程有 ${metalsHealth.summary.action_required} 个健康项需要复核：${blockedLabels.join('、')}。`
	      });
	    }
    appendCandidateFlowWarnings(workflowWarnings, candidateFlowIntegrity);
    const dailyPricesFreshnessItem = {
      key: 'daily_prices',
      label: 'A股/ETF日线',
      latest_trade_date: targetTradeDate,
      target_trade_date: targetTradeDate,
      lag_days: lagDays(targetTradeDate),
      status: dailyCoverage?.status === 'incomplete' ? 'incomplete' : freshnessStatus(targetTradeDate),
      rows: Number(dailyPriceHealth.rows || 0),
      ...(dailyCoverage ? { coverage: dailyCoverage } : {})
    };
    const sourceFreshnessItems = await Promise.all([
      sourceFreshness(
        'market_regime',
        '市场总闸',
        `WITH latest AS (
           SELECT trade_date FROM financial_market_regime ORDER BY trade_date DESC LIMIT 1
         )
         SELECT latest.trade_date, COUNT(r.id) AS rows
         FROM latest
         LEFT JOIN financial_market_regime r ON r.trade_date = latest.trade_date`
      ),
      sourceFreshness(
        'market_breadth',
        '市场广度',
        `WITH latest AS (
           SELECT trade_date FROM financial_market_breadth_daily ORDER BY trade_date DESC LIMIT 1
         )
         SELECT latest.trade_date, COUNT(b.id) AS rows
         FROM latest
         LEFT JOIN financial_market_breadth_daily b ON b.trade_date = latest.trade_date`
      ),
      sourceFreshness(
        'industry_strength',
        '行业强弱',
        `WITH latest AS (
           SELECT trade_date FROM financial_sw_industry_daily ORDER BY trade_date DESC LIMIT 1
         )
         SELECT latest.trade_date, COUNT(i.id) AS rows
         FROM latest
         LEFT JOIN financial_sw_industry_daily i ON i.trade_date = latest.trade_date`
      ),
      sourceFreshness(
        'limit_events',
        '涨跌停事件',
        `WITH latest AS (
           SELECT trade_date FROM financial_limit_events ORDER BY trade_date DESC LIMIT 1
         )
         SELECT latest.trade_date, COUNT(e.id) AS rows
         FROM latest
         LEFT JOIN financial_limit_events e ON e.trade_date = latest.trade_date`
      ),
      sourceFreshness(
        'basic_metrics',
        '成交额/基础指标',
        `WITH latest AS (
           SELECT trade_date FROM financial_stock_basic_metrics ORDER BY trade_date DESC LIMIT 1
         )
         SELECT latest.trade_date, COUNT(m.symbol) AS rows
         FROM latest
         LEFT JOIN financial_stock_basic_metrics m ON m.trade_date = latest.trade_date`
      )
    ]);
    const staleSourceItems = sourceFreshnessItems.filter((item: any) => ['missing', 'stale', 'incomplete'].includes(item.status));
    if (staleSourceItems.length > 0) {
      workflowWarnings.push({
        code: 'auxiliary_sources_stale',
        level: 'needs_review',
        message: `辅助行情源未对齐 ${targetTradeDate || '--'}：${staleSourceItems.map((item: any) => `${item.label}${item.latest_trade_date ? `停在 ${item.latest_trade_date}` : '暂无数据'}`).join('、')}。涉及广度、行业强弱、涨跌停或基础指标的结论先按滞后处理。`
      });
    }
    const laggingSourceItems = sourceFreshnessItems.filter((item: any) => item.status === 'lagging');
    if (laggingSourceItems.length > 0) {
      workflowWarnings.push({
        code: 'auxiliary_sources_lagging',
        level: 'needs_sync',
        message: `辅助行情源有轻微滞后：${laggingSourceItems.map((item: any) => `${item.label}${item.latest_trade_date ? ` ${item.latest_trade_date}` : ''}`).join('、')}。自动补齐前，不把相关分层当成最新收盘结论。`
      });
    }

	    const dataFreshness = {
	      target_trade_date: targetTradeDate,
	      effective_trade_date: coveredTradeDate || targetTradeDate,
	      raw_latest_trade_date: targetTradeDate,
	      workflow_data_mode: dailyCoverage?.status === 'incomplete' ? 'locked_to_latest_covered_trade_date' : 'latest_trade_date',
	      workflow_warnings: workflowWarnings,
	      metals_health: metalsHealth,
	      queue_consistency: {
	        active_plan_ready_candidates: activePlanReadyCandidateCount,
	        confirmed_observations_without_active_plan_ready_candidate: confirmedWithoutActivePlanReadyCandidate,
	        candidate_flow_integrity: candidateFlowIntegrity
	      },
      sources: [
        dailyPricesFreshnessItem,
        ...sourceFreshnessItems,
	        ...metalsHealth.items.map((item: any) => ({
	          key: `metal_${String(item.symbol || '').toLowerCase()}`,
	          label: item.label || item.symbol,
	          latest_trade_date: item.latest_trade_date || null,
	          target_trade_date: targetTradeDate,
	          lag_days: item.lag_days ?? null,
	          status: item.status || 'missing',
	          rows: Number(item.rows || 0),
	          state_code: item.state_code || null,
	          state_label: item.state_label || null,
	          entry_permission: item.entry_permission || null
	        }))
	      ],
      experiment_snapshots: await db.all(
        `WITH latest AS (
           SELECT experiment_key, MAX(trade_date) AS latest_trade_date
           FROM finance_experiment_prediction_snapshots
           WHERE saved_from = 'latest_prediction_pool'
             ${coveredTradeDate ? 'AND trade_date <= ?' : ''}
           GROUP BY experiment_key
         )
         SELECT l.experiment_key, l.latest_trade_date, COUNT(s.id) AS rows
         FROM latest l
         LEFT JOIN finance_experiment_prediction_snapshots s
           ON s.experiment_key = l.experiment_key
          AND s.saved_from = 'latest_prediction_pool'
         AND s.trade_date = l.latest_trade_date
         GROUP BY l.experiment_key, l.latest_trade_date
         ORDER BY l.experiment_key`,
        coveredTradeDate ? [coveredTradeDate] : []
      )
    };

    res.json({
      success: true,
      data: {
        market: latestMarket || null,
        counts,
        latest_candidates: latestCandidates,
        latest_observations: latestObservations,
        today_summary: todaySummary,
        risk_board: riskBoard,
        data_freshness: dataFreshness,
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
    const latestPriceRow = await db.get(
      `SELECT MAX(trade_date) AS trade_date
       FROM financial_daily_prices
       WHERE source = 'tushare'
         AND asset_type IN ('stock', 'etf', 'index')
         AND close IS NOT NULL
         AND close > 0`
    );
    const latestPriceTradeDate = latestPriceRow?.trade_date ? String(latestPriceRow.trade_date) : null;
    const coveredTradeDate = await getLatestCoveredTradeDate(db);
    const dailyPriceQuality = latestPriceTradeDate
      ? await getTradeDateCoverage(db, latestPriceTradeDate)
      : null;
    const latestRun = await db.get(
      `SELECT *
       FROM task_center_runs
       WHERE task_key = ?
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
       LIMIT 1`,
      [FINANCE_PIPELINE_TASK_KEY]
    );

    if (latestRun?.result_json) {
      latestRun.result = compactPipelineResult(latestRun.result_json);
      latestRun.duration_seconds = getDurationSeconds(latestRun.started_at, latestRun.finished_at);
      const recovery = await getDailyPipelineRecovery(db, latestRun);
      if (latestRun.status === 'success' && dailyPriceQuality?.status === 'incomplete') {
        latestRun.effective_status = 'stale_success';
        latestRun.effective_message = `最近成功记录对应的行情覆盖不足：${latestPriceTradeDate} 当前 ${dailyPriceQuality.current_count} 个，上一交易日 ${dailyPriceQuality.previous_trade_date} ${dailyPriceQuality.previous_count} 个。`;
      } else if (recovery) {
        latestRun.effective_status = recovery.status;
        latestRun.effective_message = recovery.message;
        latestRun.recovery = recovery;
      }
      delete latestRun.result_json;
    }

    res.json({
      success: true,
      data: {
        task,
        latest_run: latestRun || null,
        run_guard: runGuard,
        daily_price_quality: {
          latest_trade_date: latestPriceTradeDate,
          covered_trade_date: coveredTradeDate,
          coverage: dailyPriceQuality,
          status: dailyPriceQuality?.status || 'unknown'
        }
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
    await ensureFinanceFunnelTask(db);
    const limit = Math.min(Math.max(Number(req.query.limit || 8), 1), 30);
    const scope = String(req.query.scope || 'daily');
    const stepsMode = String(req.query.steps || 'all');
    const taskKeys = scope === 'workflow'
      ? [FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY, FINANCE_PIPELINE_TASK_KEY, FINANCE_FUNNEL_TASK_KEY]
      : [FINANCE_PIPELINE_TASK_KEY];
    const placeholders = taskKeys.map(() => '?').join(',');
    const runs = await db.all(
      `SELECT r.id, r.task_id, r.task_key, r.trigger_type, r.status, r.message,
              r.started_at, r.finished_at, r.created_at,
              COALESCE(t.name, r.task_key) AS task_label
       FROM task_center_runs r
       LEFT JOIN task_center_tasks t ON t.id = r.task_id
       WHERE r.task_key IN (${placeholders})
       ORDER BY datetime(REPLACE(r.started_at, 'T', ' ')) DESC, r.id DESC
       LIMIT ?`,
      [...taskKeys, limit]
    );

    const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const compactResultByRunId = new Map<number, ReturnType<typeof compactPipelineResult>>();
    if (stepsMode === 'all') {
      const resultRows = runs.length
        ? await db.all(
            `SELECT id, result_json
             FROM task_center_runs
             WHERE id IN (${runs.map(() => '?').join(',')})`,
            runs.map((run: any) => run.id)
          )
        : [];
      resultRows.forEach((row: any) => {
        compactResultByRunId.set(Number(row.id), compactPipelineResult(row.result_json));
      });
    } else if (stepsMode === 'latest') {
      for (const run of runs) {
        const row = await db.get(
          `SELECT result_json
           FROM task_center_runs
           WHERE id = ?`,
          [run.id]
        );
        const compactResult = compactPipelineResult(row?.result_json);
        if ((compactResult.steps || []).length > 0) {
          compactResultByRunId.set(Number(run.id), compactResult);
          break;
        }
      }
    }

    const items = runs.map((run: any) => {
      const compactResult = compactResultByRunId.get(Number(run.id));
      return {
        id: run.id,
        task_key: run.task_key,
        task_label: run.task_label,
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
        result: compactResult || {
          summary: null,
          finished_at: run.finished_at || null
        }
      };
    });

    res.json({
      success: true,
      data: {
        scope,
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
  const runId = Number(runResult.lastID);
  if (!Number.isFinite(runId)) {
    throw new Error('金融日终流水线运行记录创建失败');
  }

  const config = {
    ...parseJsonConfig(task.config_json),
    ...(req.body?.config || {}),
    force: req.body?.force === true
  };

  void (async () => {
    try {
      const result = await runFinanceDailyPipeline(config, {
        taskKey: FINANCE_PIPELINE_TASK_KEY,
        onProgress: ({ step, result: progressResult }) => persistManualPipelineProgress(
          db,
          task.id,
          runId,
          '金融日终流水线',
          step,
          progressResult
        )
      });
      const failedStep = result.steps.find((step: any) => step.status === 'error');
      const skippedSteps = result.steps.filter((step: any) => step.status === 'skipped');
      const marketGateSkippedStep = skippedSteps.find((step: any) => step.data?.downstream_blocked);
      const status = failedStep ? 'error' : marketGateSkippedStep ? 'skipped' : 'success';
      const message = failedStep
        ? `金融日终流水线失败：停在「${failedStep.label}」 - ${failedStep.message || '原因未知'}`
        : marketGateSkippedStep
          ? `金融日终流水线已按市场总闸停止下游：${marketGateSkippedStep.message || '总闸未通过'}`
        : `金融日终流水线完成：${result.summary.success}/${result.summary.total} 步完成`;

      await db.run(
        `UPDATE task_center_runs
         SET status = ?, message = ?, result_json = ?, finished_at = ?
         WHERE id = ?`,
        [status, message, JSON.stringify(compactFinancePipelineResultForStorage(result)), new Date().toISOString(), runId]
      );
      await db.run(
        `UPDATE task_center_tasks
         SET last_status = ?, last_message = ?, last_run_at = ?, updated_at = ?
         WHERE id = ?`,
        [status, message, new Date().toISOString(), new Date().toISOString(), task.id]
      );
      if (status === 'success') {
        const now = new Date().toISOString();
        await db.run(
          `UPDATE task_center_tasks
           SET last_status = 'success',
               last_message = '今日漏斗已由金融日终流水线覆盖执行，不需要兜底重复跑。',
               last_run_at = ?,
               updated_at = ?
           WHERE task_key = ?`,
          [now, now, FINANCE_FUNNEL_TASK_KEY]
        );
      }
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
    }
  })();

  res.status(202).json({
    success: true,
    message: '金融日终流水线已启动，页面会自动刷新执行状态。',
    data: {
      run_id: runId,
      status: 'running',
      started_at: startedAt
    }
  });
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
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
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
  const runId = Number(runResult.lastID);
  if (!Number.isFinite(runId)) {
    throw new Error('入池漏斗流水线运行记录创建失败');
  }

  try {
    const config = {
      ...parseJsonConfig(task.config_json),
      ...(req.body?.config || {})
    };
    const result = await runFinanceCandidateFunnelPipeline(config, {
      taskKey: FINANCE_FUNNEL_TASK_KEY,
      onProgress: ({ step, result: progressResult }) => persistManualPipelineProgress(
        db,
        task.id,
        runId,
        '入池漏斗流水线',
        step,
        progressResult
      )
    });
    const failedStep = result.steps.find((step: any) => step.status === 'error');
    const skippedSteps = result.steps.filter((step: any) => step.status === 'skipped');
    const marketGateSkippedStep = skippedSteps.find((step: any) => step.data?.downstream_blocked);
    const status = failedStep ? 'error' : marketGateSkippedStep ? 'skipped' : 'success';
    const message = failedStep
      ? `入池漏斗流水线失败：停在「${failedStep.label}」 - ${failedStep.message || '原因未知'}`
      : marketGateSkippedStep
        ? `入池漏斗流水线已按市场总闸跳过：${marketGateSkippedStep.message || '总闸未通过'}`
      : `入池漏斗流水线完成：${result.summary.success}/${result.summary.total} 步完成`;

    await db.run(
      `UPDATE task_center_runs
       SET status = ?, message = ?, result_json = ?, finished_at = ?
       WHERE id = ?`,
      [status, message, JSON.stringify(compactFinancePipelineResultForStorage(result)), new Date().toISOString(), runId]
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

async function saveMarketRegime(regime: MarketRegime): Promise<void> {
  const db = await getDb();
  await db.exec('BEGIN TRANSACTION');
  try {
    await db.run(
      `DELETE FROM financial_market_regime
       WHERE symbol = ?
         AND trade_date = ?
         AND COALESCE(rule_version, 'market_regime_v1') = COALESCE(?, 'market_regime_v1')`,
      [regime.symbol, regime.trade_date, regime.rule_version || 'market_regime_v1']
    );
    await db.run(
      `INSERT INTO financial_market_regime 
        (symbol, name, trade_date, close, ma60, ma60_prev, ma60_slope, low_60, low_120, cross_count_10, above_ma60_days, below_ma60_days, drawdown_20, drawdown_60, drawdown_120, distance_to_ma60, market_regime, result_reason, entry_permission, entry_reason, rule_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [regime.symbol, regime.name, regime.trade_date, regime.close, regime.ma60, regime.ma60_prev, regime.ma60_slope, regime.low_60, regime.low_120, regime.cross_count_10, regime.above_ma60_days, regime.below_ma60_days, regime.drawdown_20, regime.drawdown_60, regime.drawdown_120, regime.distance_to_ma60, regime.market_regime, regime.result_reason, regime.entry_permission, regime.entry_reason, regime.rule_version]
    );
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
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
  const prices = await getDailyPrices(symbol, source);
  const latestPriceTradeDate = prices.length > 0 ? prices[prices.length - 1]?.trade_date : null;
  if (latest && (!latestPriceTradeDate || String(latest.trade_date || '') >= String(latestPriceTradeDate))) {
    return enrichMarketRegimeWithCycleLayers(latest, symbol, source, false);
  }

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
    if (req.body?.force !== true) {
      const localNow = getChinaDateTimeParts();
      const minuteOfDay = localNow.hour * 60 + localNow.minute;
      if (localNow.weekday === 0 || localNow.weekday === 6) {
        return res.status(425).json({
          success: false,
          message: '今天不是交易日（周末），市场环境层不刷新，保持最近一个收盘日口径。'
        });
      }
      if (minuteOfDay < PIPELINE_MANUAL_EARLIEST_MINUTE) {
        return res.status(425).json({
          success: false,
          message: `市场环境层按收盘日线口径刷新，只允许 ${getPipelineEarliestTimeLabel()} 后执行。建议收盘后直接跑金融日终流水线。`
        });
      }
    }

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
    const asOfTradeDate = String(req.query.as_of_trade_date || req.query.asOfTradeDate || '').trim();
    const cacheKey = JSON.stringify({ scope, limit, benchmarkSymbol, asOfTradeDate });
    if (industryEtfStrengthCache?.key === cacheKey && industryEtfStrengthCache.expiresAt > Date.now()) {
      return res.json({
        success: true,
        data: {
          ...industryEtfStrengthCache.data,
          cache: { hit: true, ttl_ms: INDUSTRY_ETF_STRENGTH_CACHE_TTL_MS }
        }
      });
    }
    const data = await buildIndustryEtfStrengthResponse(db, {
      scope,
      limit,
      benchmarkSymbol,
      asOfTradeDate
    });
    industryEtfStrengthCache = {
      key: cacheKey,
      expiresAt: Date.now() + INDUSTRY_ETF_STRENGTH_CACHE_TTL_MS,
      data
    };

    res.json({
      success: true,
      data: {
        ...data,
        cache: { hit: false, ttl_ms: INDUSTRY_ETF_STRENGTH_CACHE_TTL_MS }
      }
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
        updated_at: regime?.updated_at || null,
        opportunity
      });
    }
    const dataDate = items
      .map((item: any) => item.trade_date)
      .filter(Boolean)
      .sort()
      .pop() || null;
    const latestUpdatedAt = items
      .map((item: any) => item.updated_at)
      .filter(Boolean)
      .sort()
      .pop() || null;

    res.json({
      success: true,
      data: {
        rule_version: 'market_environment_v1',
        data_date: dataDate,
        data_label: dataDate ? `${dataDate} 收盘` : null,
        updated_at: latestUpdatedAt || new Date().toISOString(),
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
    
    query += `ORDER BY trade_date DESC, id DESC LIMIT 1`;
    
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
