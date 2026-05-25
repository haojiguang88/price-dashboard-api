import express, { Request, Response as ExpressResponse } from 'express';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import getDb, { getDatabasePath } from '../config/database';
import {
  compactFinancePipelineResultForStorage,
  markFinancePipelineResultInterrupted,
  runFinanceCandidateFunnelPipeline,
  runFinanceDailyPipeline,
  runExperimentPredictionSnapshotPipeline
} from '../services/financeDailyPipeline';
import { getLocalHttpErrorMessage, requestLocalJson } from '../utils/localHttpClient';

const router = express.Router();
const execFileAsync = promisify(execFile);

type TaskRow = {
  id: number;
  task_key: string;
  name: string;
  domain: string;
  task_type: string;
  enabled: number;
  schedule_time: string;
  schedule_days: string;
  priority: number;
  config_json?: string;
  last_run_at?: string | null;
  last_status?: string | null;
};

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerRunning = false;
const lastScheduledRunByTaskWindow = new Map<string, string>();
const TASK_RUNNING_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_METAL_SYMBOLS = ['XAUUSD', 'SGE_AGTD'];
const SUPPORTED_METAL_SYMBOLS = new Set(DEFAULT_METAL_SYMBOLS);
const FINANCE_DAILY_PIPELINE_TASK_KEY = 'finance_daily_pipeline';
const FINANCE_CANDIDATE_FUNNEL_TASK_KEY = 'finance_candidate_funnel_pipeline';
const FINANCE_EXPERIMENT_PREDICTION_TASK_KEY = 'finance_experiment_prediction_snapshots';
const FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY = 'finance_tushare_supplemental_update';
const FINANCE_TUSHARE_FINANCIAL_REPORTS_TASK_KEY = 'finance_tushare_financial_reports_update';
const DEFAULT_LOCAL_API_TIMEOUT_MS = 90 * 60 * 1000;

function parseConfig(configJson?: string) {
  if (!configJson) return {};
  try {
    return JSON.parse(configJson);
  } catch {
    return {};
  }
}

function formatDurationMs(timeoutMs: number) {
  const minutes = Math.round(timeoutMs / 60000);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.round(minutes / 60);
  return `${hours}小时`;
}

function getTaskExecutionTimeoutMs(task: TaskRow, config: any) {
  const configuredMs = Number(config.task_timeout_ms || 0);
  const configuredMinutes = Number(config.task_timeout_minutes || 0);
  const raw = Number.isFinite(configuredMs) && configuredMs > 0
    ? configuredMs
    : Number.isFinite(configuredMinutes) && configuredMinutes > 0
      ? configuredMinutes * 60 * 1000
      : task.task_key === FINANCE_DAILY_PIPELINE_TASK_KEY || task.task_type === 'finance_daily_pipeline'
        ? TASK_RUNNING_TIMEOUT_MS
        : task.task_key === FINANCE_EXPERIMENT_PREDICTION_TASK_KEY || task.task_type === 'finance_experiment_prediction_snapshots'
          ? 20 * 60 * 1000
          : task.task_key === FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY || task.task_type === 'finance_tushare_supplemental_update'
            ? 45 * 60 * 1000
            : task.task_key === FINANCE_TUSHARE_FINANCIAL_REPORTS_TASK_KEY || task.task_type === 'finance_tushare_financial_reports_update'
              ? 90 * 60 * 1000
              : 30 * 60 * 1000;
  return Math.min(Math.max(Math.floor(raw), 60 * 1000), 6 * 60 * 60 * 1000);
}

function withTaskExecutionTimeout<T>(promise: Promise<T>, task: TaskRow, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`任务执行超过等待上限 ${formatDurationMs(timeoutMs)}，已由任务中心超时保护收口：${task.name || task.task_key}`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function getDateKey(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function getChinaDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  }).formatToParts(now).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 0
  };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday] ?? now.getDay()
  };
}

function isRunnableToday(scheduleDays: string, now = new Date()) {
  const day = getChinaDateParts(now).weekday;
  if (scheduleDays === 'every_day') return true;
  if (scheduleDays === 'work_days' || scheduleDays === 'trade_days') return day >= 1 && day <= 5;
  return true;
}

function getScheduleWindowKey(task: TaskRow, now = new Date()) {
  return `${getDateKey(now)}|${task.schedule_time}`;
}

function getScheduleDueTime(task: TaskRow, now = new Date()) {
  const [hour, minute] = task.schedule_time.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const { year, month, day } = getChinaDateParts(now);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0));
}

function hasRunInScheduleWindow(task: TaskRow, now = new Date()) {
  const todayKey = getDateKey(now);
  if (lastScheduledRunByTaskWindow.get(task.task_key) === getScheduleWindowKey(task, now)) return true;
  if (!task.last_run_at) return false;
  const lastRunAt = new Date(task.last_run_at);
  if (!Number.isFinite(lastRunAt.getTime())) return false;
  if (getDateKey(lastRunAt) !== todayKey) return false;
  const due = getScheduleDueTime(task, now);
  if (!due || lastRunAt < due) return false;

  if (task.last_status === 'error') {
    const config = parseConfig(task.config_json);
    const retryAfterMinutes = Math.min(
      Math.max(Number(config.retry_after_minutes || config.retry_interval_minutes || 30), 10),
      180
    );
    return now.getTime() - lastRunAt.getTime() < retryAfterMinutes * 60 * 1000;
  }

  return true;
}

function isDue(task: TaskRow, now = new Date()) {
  if (!task.enabled) return false;
  if (!isRunnableToday(task.schedule_days, now)) return false;

  const due = getScheduleDueTime(task, now);
  if (!due) return false;
  if (now < due) return false;

  return !hasRunInScheduleWindow(task, now);
}

function formatChinaDateTime(value?: string | null) {
  if (!value) return '--';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  });
}

function hasRunAtOrAfterChinaSchedule(startedAt?: string | null, scheduleTime = '17:10', now = new Date()) {
  if (!startedAt) return false;
  const runDate = new Date(startedAt);
  if (!Number.isFinite(runDate.getTime())) return false;
  if (getDateKey(runDate) !== getDateKey(now)) return false;
  const due = getScheduleDueTime({ schedule_time: scheduleTime } as TaskRow, now);
  if (!due) return true;
  return runDate >= due;
}

async function getScheduledFunnelSkipReason(db: any, now = new Date()) {
  await expireSupersededScheduledRuns(db, FINANCE_DAILY_PIPELINE_TASK_KEY, '金融日终流水线', now);

  const supplementalWaitReason = await getScheduledDailyPipelineWaitReason(db, now);
  if (supplementalWaitReason) {
    return `Tushare辅助数据补全仍在执行，入池漏斗本轮先跳过，避免拿半新半旧数据推进。${supplementalWaitReason}`;
  }

  const runningDaily = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [FINANCE_DAILY_PIPELINE_TASK_KEY]
  );
  if (runningDaily) {
    return `金融日终流水线正在执行，已包含入池漏斗，本次定时漏斗自动跳过。开始时间：${formatChinaDateTime(runningDaily.started_at)}`;
  }

  const dailyTask = await db.get(
    `SELECT schedule_time FROM task_center_tasks WHERE task_key = ?`,
    [FINANCE_DAILY_PIPELINE_TASK_KEY]
  );
  const latestDaily = await db.get(
    `SELECT id, status, started_at, finished_at, message
     FROM task_center_runs
     WHERE task_key = ? AND status IN ('success', 'error')
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [FINANCE_DAILY_PIPELINE_TASK_KEY]
  );
  if (
    latestDaily
    && hasRunAtOrAfterChinaSchedule(latestDaily.started_at, dailyTask?.schedule_time || '17:10')
  ) {
    if (latestDaily.status === 'success') {
      return `今日金融日终流水线已成功执行，且已包含入池漏斗，本次定时漏斗自动跳过。完成时间：${formatChinaDateTime(latestDaily.finished_at)}`;
    }
    return `今日金融日终流水线已经失败，兜底漏斗不自动越过主流程继续推进。失败信息：${latestDaily.message || '原因未知'}`;
  }

  return null;
}

async function getScheduledDailyPipelineWaitReason(db: any, now = new Date()) {
  await expireSupersededScheduledRuns(db, FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY, 'Tushare辅助数据补全', now);

  const supplementalTask = await db.get(
    `SELECT enabled, schedule_time
     FROM task_center_tasks
     WHERE task_key = ?`,
    [FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY]
  );
  if (!supplementalTask?.enabled) return null;
  const supplementalScheduleTime = supplementalTask.schedule_time || '17:00';

  const runningSupplemental = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY]
  );
  if (runningSupplemental?.started_at) {
    const startedAt = new Date(runningSupplemental.started_at);
    if (Number.isFinite(startedAt.getTime())) {
      const ageMs = now.getTime() - startedAt.getTime();
      const isToday = getDateKey(startedAt) === getDateKey(now);
      const isFreshRun = ageMs >= 0 && ageMs <= 4 * 60 * 60 * 1000;
      if (isToday && isFreshRun) {
        return `Tushare辅助数据补全正在执行，日终流水线本轮先等待，避免拿半新半旧数据推进。Tushare开始时间：${formatChinaDateTime(runningSupplemental.started_at)}`;
      }
    }
  }

  const latestSupplemental = await db.get(
    `SELECT id, status, started_at, finished_at, message
     FROM task_center_runs
     WHERE task_key = ? AND status IN ('success', 'error')
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY]
  );
  const ranAfterTodaySchedule = hasRunAtOrAfterChinaSchedule(
    latestSupplemental?.started_at,
    supplementalScheduleTime,
    now
  );
  if (!ranAfterTodaySchedule) {
    return `Tushare辅助数据补全今天尚未在 ${supplementalScheduleTime} 后成功完成，日终流水线先等待，避免旧辅助特征推进。`;
  }
  if (latestSupplemental.status === 'error') {
    return `Tushare辅助数据补全今天失败，日终流水线先不越过数据前置步骤。失败信息：${latestSupplemental.message || '原因未知'}`;
  }

  return null;
}

async function getFinanceDailyCoverageIssue(db: any) {
  const targetRow = await db.get(
    `SELECT MAX(trade_date) AS trade_date
     FROM financial_daily_prices
     WHERE source = 'tushare'
       AND asset_type IN ('stock', 'etf', 'index')
       AND close IS NOT NULL
       AND close > 0`
  );
  const targetTradeDate = targetRow?.trade_date || null;
  if (!targetTradeDate) return null;

  const previousRow = await db.get(
    `SELECT MAX(trade_date) AS trade_date
     FROM financial_daily_prices
     WHERE source = 'tushare'
       AND asset_type IN ('stock', 'etf')
       AND trade_date < ?`,
    [targetTradeDate]
  );
  const previousTradeDate = previousRow?.trade_date || null;
  if (!previousTradeDate) return null;

  const countForDate = async (date: string) => {
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
      [date]
    );
    return Number(row?.count || 0);
  };

  const currentCount = await countForDate(targetTradeDate);
  const previousCount = await countForDate(previousTradeDate);
  const minExpected = previousCount > 0 ? Math.floor(previousCount * 0.92) : 0;
  if (previousCount > 0 && currentCount < minExpected) {
    return `全市场日线覆盖不足：${targetTradeDate} 当前 ${currentCount} 个，上一交易日 ${previousTradeDate} ${previousCount} 个，低于阈值 ${minExpected}`;
  }
  return null;
}

async function expireSupersededScheduledRuns(db: any, taskKey: string, taskName: string, now = new Date()) {
  const latestCompletedRun = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ?
       AND status != 'running'
       AND finished_at IS NOT NULL
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [taskKey]
  );
  const latestCompletedMs = latestCompletedRun?.started_at
    ? new Date(latestCompletedRun.started_at).getTime()
    : NaN;
  const runningRows = await db.all(
    `SELECT id, started_at, result_json
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC`,
    [taskKey]
  );
  const staleRows = runningRows.filter((row: any) => {
    const startedMs = new Date(row.started_at).getTime();
    if (!Number.isFinite(startedMs)) return false;
    if (Number.isFinite(latestCompletedMs) && latestCompletedMs > startedMs) return true;
    return now.getTime() - startedMs > TASK_RUNNING_TIMEOUT_MS;
  });
  if (staleRows.length === 0) return;

  const finishedAt = now.toISOString();
  for (const row of staleRows) {
    const startedMs = new Date(row.started_at).getTime();
    const superseded = Number.isFinite(latestCompletedMs) && latestCompletedMs > startedMs;
    const message = superseded
      ? `${taskName}运行状态已过期：后面已有更新的完成记录，本条自动标记为失败，避免定时器误判仍在执行。`
      : `${taskName}超过 ${Math.round(TASK_RUNNING_TIMEOUT_MS / 3600000)} 小时仍未结束，自动标记为失败，避免定时器长期卡住。`;
    const interruptedResult = markFinancePipelineResultInterrupted(row.result_json, message, finishedAt);
    if (interruptedResult) {
      await db.run(
        `UPDATE task_center_runs
         SET status = 'error', message = ?, result_json = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
        [message, JSON.stringify(compactFinancePipelineResultForStorage(interruptedResult)), finishedAt, row.id]
      );
    } else {
      await db.run(
        `UPDATE task_center_runs
         SET status = 'error', message = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
        [message, finishedAt, row.id]
      );
    }
  }
}

export async function cleanupOrphanedFinanceTaskRunsOnStartup() {
  const db = await getDb();
  const now = new Date().toISOString();
  const taskKeys = [
    FINANCE_DAILY_PIPELINE_TASK_KEY,
    FINANCE_CANDIDATE_FUNNEL_TASK_KEY,
    FINANCE_EXPERIMENT_PREDICTION_TASK_KEY,
    'daily_close_update',
    FINANCE_TUSHARE_SUPPLEMENTAL_TASK_KEY
  ];
  const rows = await db.all(
    `SELECT id, task_key, result_json
     FROM task_center_runs
     WHERE status = 'running'
       AND task_key IN (${taskKeys.map(() => '?').join(',')})
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) ASC, id ASC`,
    taskKeys
  );
  if (rows.length === 0) return;

  const message = '后端重启时检测到孤儿运行记录，已自动标记为失败；需要重新手动执行或等待下一次定时流水线。';
  for (const row of rows) {
    const interruptedResult = markFinancePipelineResultInterrupted(row.result_json, message, now);
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
       SET last_status = 'error',
           last_message = ?,
           last_run_at = ?,
           updated_at = ?
       WHERE task_key = ?`,
      [message, now, now, row.task_key]
    );
  }
  console.warn(`[task-center] cleaned ${rows.length} orphaned finance task run(s) after backend startup`);
}

async function getScheduledTaskRunningReason(db: any, task: TaskRow, now = new Date()) {
  await expireSupersededScheduledRuns(db, task.task_key, task.name || task.task_key, now);
  const running = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [task.task_key]
  );
  if (!running) return null;
  return `${task.name || task.task_key}正在执行，本轮定时跳过，避免重复启动。开始时间：${formatChinaDateTime(running.started_at)}`;
}

async function callApi(path: string, body: any) {
  const port = process.env.PORT || 3001;
  let data: any = null;
  try {
    const response = await requestLocalJson(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      body,
      timeoutMs: DEFAULT_LOCAL_API_TIMEOUT_MS
    });
    data = response.data;
  } catch (error) {
    throw new Error(`接口请求失败 POST ${path}（等待上限 90分钟）: ${getLocalHttpErrorMessage(error)}`);
  }
  if (data?.success === false) {
    throw new Error(data.message || `接口执行失败: ${path}`);
  }
  return data;
}

async function getApi(path: string) {
  const port = process.env.PORT || 3001;
  let data: any = null;
  try {
    const response = await requestLocalJson(`http://127.0.0.1:${port}${path}`, {
      method: 'GET',
      timeoutMs: DEFAULT_LOCAL_API_TIMEOUT_MS
    });
    data = response.data;
  } catch (error) {
    throw new Error(`接口请求失败 GET ${path}（等待上限 90分钟）: ${getLocalHttpErrorMessage(error)}`);
  }
  if (data?.success === false) {
    throw new Error(data.message || `接口执行失败: ${path}`);
  }
  return data;
}

async function persistFinancePipelineProgress(
  db: any,
  task: TaskRow,
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
    [message, now, now, task.id]
  );
}

async function finishTaskRunIfRunning(
  db: any,
  task: TaskRow,
  runId: number,
  status: string,
  message: string,
  resultJson?: any
) {
  const now = new Date().toISOString();
  const runUpdate = resultJson === undefined
    ? await db.run(
      `UPDATE task_center_runs
       SET status = ?, message = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
      [status, message, now, runId]
    )
    : await db.run(
      `UPDATE task_center_runs
       SET status = ?, message = ?, result_json = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
      [status, message, JSON.stringify(resultJson), now, runId]
    );

  if (Number(runUpdate?.changes || 0) === 0) return false;

  await db.run(
    `UPDATE task_center_tasks
     SET last_status = ?, last_message = ?, last_run_at = ?, updated_at = ?
     WHERE id = ?`,
    [status, message, now, now, task.id]
  );
  return true;
}

function buildLateTaskResult(runId: number, data?: any) {
  return {
    success: false,
    message: '任务已被超时保护或其他收口逻辑结束，后续迟到结果未覆盖任务状态。',
    data,
    run_id: runId
  };
}

async function runMetalsDailyUpdate(config: any) {
  const configuredSymbols = Array.isArray(config.symbols)
    ? config.symbols
    : [config.symbol || DEFAULT_METAL_SYMBOLS];
  const symbols: string[] = Array.from(new Set<string>(
    configuredSymbols.flat()
      .map((item: any) => String(item || '').trim().toUpperCase())
      .filter(Boolean)
  ));
  const allowedSymbols = symbols.filter(symbol => SUPPORTED_METAL_SYMBOLS.has(symbol));
  const skippedSymbols = symbols.filter(symbol => !SUPPORTED_METAL_SYMBOLS.has(symbol));

  if (allowedSymbols.length === 0) {
    throw new Error(`贵金属行情更新未执行：当前支持 ${DEFAULT_METAL_SYMBOLS.join(', ')}`);
  }

  const results = [];
  for (const symbol of allowedSymbols) {
    const update = await callApi('/api/finance/metals/update', {
      symbol,
      force_update: Boolean(config.force_update)
    });
    results.push(update.data);
  }

  const latestText = results
    .map((item: any) => `${item.symbol} 最新交易日 ${item.last_trade_date || '--'}`)
    .join('，');
  const skippedText = skippedSymbols.length > 0
    ? `；跳过未接入品种 ${skippedSymbols.join(', ')}`
    : '';

  return {
    message: `贵金属行情更新完成：${latestText}${skippedText}`,
    data: {
      results,
      skipped_symbols: skippedSymbols
    }
  };
}

function normalizeTradeDate(value: any) {
  const raw = String(value || '').trim();
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  const text = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function getLatestSupplementalTradeDate(parsed: any, config: any) {
  const rows = Array.isArray(parsed?.results_tail) ? parsed.results_tail : [];
  const withData = rows
    .filter((row: any) => [
      'daily_basic',
      'moneyflow',
      'moneyflow_ths',
      'limit_prices',
      'limit_events',
      'sw_daily'
    ].some(key => Number(row?.[key] || 0) > 0))
    .map((row: any) => normalizeTradeDate(row?.trade_date))
    .filter(Boolean) as string[];
  const candidates = withData.length > 0
    ? withData
    : rows
      .map((row: any) => normalizeTradeDate(row?.trade_date))
      .filter(Boolean) as string[];
  const fallback = normalizeTradeDate(config.end_date);
  if (fallback) candidates.push(fallback);
  return candidates.sort().pop() || null;
}

function formatMarketBreadthResult(result: any) {
  const data = result?.data || {};
  const count = Number(data.count || 0);
  const minDate = data.min_date || '--';
  const maxDate = data.max_date || '--';
  return `市场广度 ${count} 日(${minDate}~${maxDate})`;
}

async function runMarketBreadthDerivedUpdate(config: any, supplementalResult: any) {
  const scriptPath = path.join(__dirname, '../../scripts/finance/build_market_derived_features.py');
  const pythonBin = String(config.python || process.env.PYTHON_BIN || '/usr/bin/python3');
  const daysValue = Number(config.market_breadth_days ?? config.days ?? 60);
  const days = Number.isFinite(daysValue) && daysValue > 0 ? Math.floor(daysValue) : 60;
  const args = [
    scriptPath,
    '--db',
    String(config.db || getDatabasePath()),
    '--days',
    String(days)
  ];
  const startDate = normalizeTradeDate(config.market_breadth_start_date || config.start_date);
  const endDate = getLatestSupplementalTradeDate(supplementalResult, config);
  if (startDate) args.push('--start-date', startDate);
  if (endDate) args.push('--end-date', endDate);

  const { stdout, stderr } = await execFileAsync(pythonBin, args, {
    cwd: path.join(__dirname, '../..'),
    maxBuffer: 1024 * 1024 * 20,
    env: process.env
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || '{}');
  if (parsed.success === false) {
    throw new Error(parsed.message || stderr || '市场广度衍生数据重建失败');
  }
  return parsed;
}

async function runTushareSupplementalUpdate(config: any) {
  const scriptPath = path.join(__dirname, '../../scripts/finance/fetch_tushare_supplemental.py');
  const pythonBin = String(config.python || process.env.PYTHON_BIN || '/usr/bin/python3');
  const sections = Array.isArray(config.sections)
    ? config.sections.join(',')
    : String(config.sections || 'daily_basic,moneyflow,moneyflow_ths,limits,sw');
  const args = [
    scriptPath,
    '--db',
    String(config.db || getDatabasePath()),
    '--days',
    String(Number(config.days || 60)),
    '--sections',
    sections,
    '--delay-seconds',
    String(Number(config.delay_seconds ?? 0.15))
  ];
  if (config.start_date) args.push('--start-date', String(config.start_date));
  if (config.end_date) args.push('--end-date', String(config.end_date));
  if (config.include_end_date !== false) args.push('--include-end-date');

  const { stdout, stderr } = await execFileAsync(pythonBin, args, {
    cwd: path.join(__dirname, '../..'),
    maxBuffer: 1024 * 1024 * 20,
    env: process.env
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || '{}');
  if (parsed.success === false) {
    throw new Error(parsed.message || stderr || 'Tushare辅助数据补全失败');
  }
  const marketBreadth = config.rebuild_market_breadth === false
    ? null
    : await runMarketBreadthDerivedUpdate(config, parsed);
  const totals = parsed.totals || {};
  const marketBreadthText = marketBreadth ? `，${formatMarketBreadthResult(marketBreadth)}` : '';
  const failureText = parsed.failure_count
    ? `；部分接口跳过/失败 ${parsed.failure_count} 条`
    : '';
  return {
    message: `Tushare辅助数据补全完成：${parsed.trade_dates || 0} 个交易日，daily_basic ${totals.daily_basic || 0}，moneyflow ${totals.moneyflow || 0}，moneyflow_ths ${totals.moneyflow_ths || 0}，limit ${totals.limit_events || 0}，SW日线 ${totals.sw_daily || 0}${marketBreadthText}${failureText}`,
    data: {
      ...parsed,
      market_breadth: marketBreadth
    }
  };
}

async function runTushareFinancialReportsUpdate(config: any) {
  const scriptPath = path.join(__dirname, '../../scripts/finance/fetch_tushare_financial_reports.py');
  const pythonBin = String(config.python || process.env.PYTHON_BIN || '/usr/bin/python3');
  const sections = Array.isArray(config.sections)
    ? config.sections.join(',')
    : String(config.sections || 'income_vip,balancesheet_vip,cashflow_vip,fina_indicator_vip');
  const args = [
    scriptPath,
    '--db',
    String(config.db || getDatabasePath()),
    '--sections',
    sections,
    '--period-count',
    String(Number(config.period_count || 8)),
    '--limit',
    String(Number(config.limit || 5000)),
    '--delay-seconds',
    String(Number(config.delay_seconds ?? 0.3))
  ];
  if (Array.isArray(config.periods) && config.periods.length > 0) {
    args.push('--periods', config.periods.join(','));
  } else if (config.periods) {
    args.push('--periods', String(config.periods));
  }

  const { stdout, stderr } = await execFileAsync(pythonBin, args, {
    cwd: path.join(__dirname, '../..'),
    maxBuffer: 1024 * 1024 * 20,
    env: process.env
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || '{}');
  if (parsed.success === false) {
    throw new Error(parsed.message || stderr || 'Tushare财报结构化数据补全失败');
  }
  const totals = parsed.totals || {};
  const failureText = parsed.failure_count
    ? `；部分接口跳过/失败 ${parsed.failure_count} 条`
    : '';
  return {
    message: `Tushare财报结构化补全完成：${parsed.periods?.length || 0} 个报告期，落库 ${parsed.upserted_facts || 0} 条，利润表 ${totals.income_vip || 0}，资产负债表 ${totals.balancesheet_vip || 0}，现金流量表 ${totals.cashflow_vip || 0}，财务指标 ${totals.fina_indicator_vip || 0}${failureText}`,
    data: parsed
  };
}

async function runCommodityMetalsPriceUpdate(config: any) {
  const scriptPath = path.join(__dirname, '../../scripts/finance/guijinshu.py');
  const pythonBin = String(config.python || process.env.PYTHON_BIN || '/usr/bin/python3');
  const args = [
    scriptPath,
    '--db',
    String(config.db || getDatabasePath()),
    '--targets',
    Array.isArray(config.targets)
      ? config.targets.join(',')
      : String(config.targets || '黄金9999,白银')
  ];
  if (config.dry_run) args.push('--dry-run');

  const { stdout, stderr } = await execFileAsync(pythonBin, args, {
    cwd: path.join(__dirname, '../..'),
    maxBuffer: 1024 * 1024 * 5,
    env: process.env
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || '{}');
  if (parsed.success === false) {
    throw new Error(parsed.message || stderr || '商品贵金属价格更新失败');
  }

  const priceText = Array.isArray(parsed.records)
    ? parsed.records
      .map((record: any) => `${record.object} ${record.price}`)
      .join('，')
    : '';
  return {
    message: `${parsed.message || '商品贵金属价格更新完成'}${priceText ? `：${priceText}` : ''}`,
    data: parsed
  };
}

async function runIphonePriceUpdate(config: any) {
  const scriptPath = path.join(__dirname, '../../scripts/finance/iphone.py');
  const pythonBin = String(config.python || process.env.PYTHON_BIN || '/usr/bin/python3');
  const args = [
    scriptPath,
    '--db',
    String(config.db || getDatabasePath()),
    '--category',
    String(config.category || '苹果手机')
  ];
  if (config.dry_run) args.push('--dry-run');

  const { stdout, stderr } = await execFileAsync(pythonBin, args, {
    cwd: path.join(__dirname, '../..'),
    maxBuffer: 1024 * 1024 * 10,
    env: process.env
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || '{}');
  if (parsed.success === false) {
    throw new Error(parsed.message || stderr || '苹果手机价格更新失败');
  }

  return {
    message: parsed.message || '苹果手机价格更新完成',
    data: parsed
  };
}

async function runVideoGameMachinePriceUpdate(config: any) {
  const scriptPath = path.join(__dirname, '../../scripts/finance/video_game_machine.py');
  const pythonBin = String(config.python || process.env.PYTHON_BIN || '/usr/bin/python3');
  const args = [
    scriptPath,
    '--db',
    String(config.db || getDatabasePath()),
    '--category',
    String(config.category || '游戏机')
  ];
  if (config.dry_run) args.push('--dry-run');

  const { stdout, stderr } = await execFileAsync(pythonBin, args, {
    cwd: path.join(__dirname, '../..'),
    maxBuffer: 1024 * 1024 * 10,
    env: process.env
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || '{}');
  if (parsed.success === false) {
    throw new Error(parsed.message || stderr || '游戏机价格更新失败');
  }

  const unmappedText = Array.isArray(parsed.unmapped_enabled_objects) && parsed.unmapped_enabled_objects.length > 0
    ? `；系统对象未映射 ${parsed.unmapped_enabled_objects.join('、')}`
    : '';

  return {
    message: `${parsed.message || '游戏机价格更新完成'}${unmappedText}`,
    data: parsed
  };
}

async function runPopMartPriceUpdate(config: any) {
  const scriptPath = path.join(__dirname, '../../scripts/finance/ppmt.py');
  const pythonBin = String(config.python || process.env.PYTHON_BIN || '/usr/bin/python3');
  const args = [
    scriptPath,
    '--db',
    String(config.db || getDatabasePath()),
    '--category',
    String(config.category || '泡泡玛特')
  ];
  if (config.dry_run) args.push('--dry-run');

  const { stdout, stderr } = await execFileAsync(pythonBin, args, {
    cwd: path.join(__dirname, '../..'),
    maxBuffer: 1024 * 1024 * 10,
    env: process.env
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || '{}');
  if (parsed.success === false) {
    throw new Error(parsed.message || stderr || '泡泡玛特价格更新失败');
  }

  const unmappedText = Array.isArray(parsed.unmapped_enabled_objects) && parsed.unmapped_enabled_objects.length > 0
    ? `；待确认映射 ${parsed.unmapped_enabled_objects.join('、')}`
    : '';

  return {
    message: `${parsed.message || '泡泡玛特价格更新完成'}${unmappedText}`,
    data: parsed
  };
}

async function runFxDailyRatesUpdate(config: any) {
  const scriptPath = path.join(__dirname, '../../scripts/finance/fetch_fx_daily_rates.py');
  const pythonBin = String(config.python || process.env.PYTHON_BIN || '/usr/bin/python3');
  const args = [
    scriptPath,
    '--db',
    String(config.db || getDatabasePath()),
    '--ts-code',
    String(config.ts_code || 'USDCNH.FXCM'),
    '--source',
    String(config.source || 'tushare_fxcm')
  ];
  if (config.start_date) args.push('--start-date', String(config.start_date));
  if (config.end_date) args.push('--end-date', String(config.end_date));
  if (config.dry_run) args.push('--dry-run');

  const { stdout, stderr } = await execFileAsync(pythonBin, args, {
    cwd: path.join(__dirname, '../..'),
    maxBuffer: 1024 * 1024 * 10,
    env: process.env
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || '{}');
  if (parsed.success === false) {
    throw new Error(parsed.message || stderr || 'USD/CNY汇率辅助更新失败');
  }

  const latest = parsed.latest
    ? `；最新 ${parsed.latest.trade_date} ${Number(parsed.latest.usd_cny_mid).toFixed(4)} / ${parsed.latest.fx_tailwind_for_silver}`
    : '';
  return {
    message: `${parsed.message || 'USD/CNY汇率辅助更新完成'}${latest}`,
    data: parsed
  };
}

async function runMetalMacroFactorsUpdate(config: any) {
  const scriptPath = path.join(__dirname, '../../scripts/finance/fetch_metal_macro_factors.py');
  const pythonBin = String(config.python || process.env.PYTHON_BIN || '/usr/bin/python3');
  const args = [
    scriptPath,
    '--db',
    String(config.db || getDatabasePath()),
    '--source',
    String(config.source || 'tushare_macro')
  ];
  if (config.start_date) args.push('--start-date', String(config.start_date));
  if (config.end_date) args.push('--end-date', String(config.end_date));
  if (config.dry_run) args.push('--dry-run');

  const { stdout, stderr } = await execFileAsync(pythonBin, args, {
    cwd: path.join(__dirname, '../..'),
    maxBuffer: 1024 * 1024 * 20,
    env: process.env
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || '{}');
  if (parsed.success === false) {
    throw new Error(parsed.message || stderr || '贵金属宏观因子更新失败');
  }

  const latest = parsed.latest
    ? `；最新 ${parsed.latest.trade_date}，汇率${parsed.latest.fx_tailwind_for_silver || '未知'}，美元${parsed.latest.dollar_tailwind_for_gold || '未知'}，实际利率${parsed.latest.real_rate_tailwind_for_gold || '未知'}`
    : '';
  return {
    message: `${parsed.message || '贵金属宏观因子更新完成'}${latest}`,
    data: parsed
  };
}

function toFiniteNumber(value: any, fallback: number | null = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeSilverGateThresholds(config: any = {}) {
  return {
    min_main_signal_count: Math.max(Number(config.min_main_signal_count ?? 300), 30),
    min_block_signal_count: Math.max(Number(config.min_block_signal_count ?? 300), 30),
    min_short_lived_edge: Math.max(Number(config.min_short_lived_edge ?? 0.03), 0),
    min_drawdown_edge: Math.max(Number(config.min_drawdown_edge ?? 0.005), 0),
    min_fx_coverage: Math.min(Math.max(Number(config.min_fx_coverage ?? 0.8), 0), 1)
  };
}

function getSilverSegment(validation: any, code: string) {
  return Array.isArray(validation?.segments)
    ? validation.segments.find((item: any) => item.segment_code === code)
    : null;
}

function evaluateSilverTrainingGate(validation: any, gateConfig: any = {}) {
  const thresholds = normalizeSilverGateThresholds(gateConfig);
  const main = getSilverSegment(validation, 'GOLD_PASS_SILVER_SIGNAL') || {};
  const blocked = getSilverSegment(validation, 'GOLD_NOT_STABLE_BLOCK') || {};
  const mainSignalCount = Number(main.signal_candidate_count || 0);
  const blockedSignalCount = Number(blocked.signal_candidate_count || 0);
  const mainShortLivedRate = toFiniteNumber(main.signal_short_lived_rate, null);
  const blockedShortLivedRate = toFiniteNumber(blocked.signal_short_lived_rate, null);
  const mainDrawdown = toFiniteNumber(main.signal_avg_drawdown_20d, null);
  const blockedDrawdown = toFiniteNumber(blocked.signal_avg_drawdown_20d, null);
  const fxCoverage = toFiniteNumber(validation?.fx_coverage?.matched_rate, 0) || 0;
  const shortLivedEdge = mainShortLivedRate !== null && blockedShortLivedRate !== null
    ? blockedShortLivedRate - mainShortLivedRate
    : null;
  const drawdownEdge = mainDrawdown !== null && blockedDrawdown !== null
    ? mainDrawdown - blockedDrawdown
    : null;
  const checks = [
    {
      key: 'main_signal_sample_size',
      label: '黄金通过后的白银信号样本量',
      passed: mainSignalCount >= thresholds.min_main_signal_count,
      actual: mainSignalCount,
      threshold: thresholds.min_main_signal_count,
      unit: '条'
    },
    {
      key: 'blocked_signal_sample_size',
      label: '黄金未稳拦截样本量',
      passed: blockedSignalCount >= thresholds.min_block_signal_count,
      actual: blockedSignalCount,
      threshold: thresholds.min_block_signal_count,
      unit: '条'
    },
    {
      key: 'short_lived_rate_edge',
      label: '短命率差异',
      passed: shortLivedEdge !== null && shortLivedEdge >= thresholds.min_short_lived_edge,
      actual: shortLivedEdge,
      threshold: thresholds.min_short_lived_edge,
      unit: 'rate',
      note: '黄金通过后的白银信号短命率，需要明显低于黄金未稳拦截层。'
    },
    {
      key: 'drawdown_edge',
      label: '回撤差异',
      passed: drawdownEdge !== null && drawdownEdge >= thresholds.min_drawdown_edge,
      actual: drawdownEdge,
      threshold: thresholds.min_drawdown_edge,
      unit: 'rate',
      note: '数值越大越好；主样本未来20日最大回撤应比拦截层更轻。'
    },
    {
      key: 'fx_coverage',
      label: '汇率辅助覆盖率',
      passed: fxCoverage >= thresholds.min_fx_coverage,
      actual: fxCoverage,
      threshold: thresholds.min_fx_coverage,
      unit: 'rate'
    }
  ];
  const failedChecks = checks.filter(check => !check.passed);
  const passed = failedChecks.length === 0;
  const metrics = {
    main_signal_count: mainSignalCount,
    blocked_signal_count: blockedSignalCount,
    main_short_lived_rate: mainShortLivedRate,
    blocked_short_lived_rate: blockedShortLivedRate,
    short_lived_edge: shortLivedEdge,
    main_signal_avg_drawdown_20d: mainDrawdown,
    blocked_signal_avg_drawdown_20d: blockedDrawdown,
    drawdown_edge: drawdownEdge,
    fx_coverage: fxCoverage
  };

  return {
    symbol: 'SGE_AGTD',
    gate_key: 'silver_auxiliary_training_gate',
    status: passed ? 'passed' : 'blocked',
    passed,
    generated_at: new Date().toISOString(),
    thresholds,
    metrics,
    checks,
    message: passed
      ? '白银训练闸门通过：分层样本量、短命率差异、回撤差异和汇率覆盖均达标。'
      : `白银训练闸门未通过：${failedChecks.map(check => check.label).join('、')} 未达标。`
  };
}

async function persistMetalTrainingGateRun(db: any, gate: any) {
  await db.run(
    `INSERT INTO metal_training_gate_runs (
      symbol, gate_key, status, passed, metrics_json, checks_json,
      thresholds_json, reason, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      gate.symbol,
      gate.gate_key,
      gate.status,
      gate.passed ? 1 : 0,
      JSON.stringify(gate.metrics || {}),
      JSON.stringify(gate.checks || []),
      JSON.stringify(gate.thresholds || {}),
      gate.message
    ]
  );
}

function createPipelineStep(key: string, label: string, status: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  return {
    key,
    label,
    status,
    message,
    data,
    started_at: timestamp,
    finished_at: timestamp
  };
}

async function runPreciousMetalsTrainingPipeline(config: any, db: any) {
  const symbols = Array.from(new Set<string>(
    (Array.isArray(config.symbols) ? config.symbols : DEFAULT_METAL_SYMBOLS)
      .map((item: any) => String(item || '').trim().toUpperCase())
      .filter(Boolean)
  )).filter(symbol => SUPPORTED_METAL_SYMBOLS.has(symbol));
  const replayLimit = Math.min(Math.max(Number(config.replay_limit || 1500), 80), 1500);
  const steps: any[] = [];
  let stopped = false;
  let silverGate: any = null;
  let goldRuleReport: any = null;
  let goldModelValidationReport: any = null;

  const runStep = async (key: string, label: string, action: () => Promise<any>) => {
    const step: any = {
      key,
      label,
      status: 'running',
      started_at: new Date().toISOString()
    };
    steps.push(step);
    try {
      const data = await action();
      step.status = 'success';
      step.finished_at = new Date().toISOString();
      step.message = data?.message || data?.data?.message || '完成';
      step.data = data?.data ?? data;
      return data;
    } catch (error) {
      stopped = true;
      step.status = 'error';
      step.finished_at = new Date().toISOString();
      step.message = (error as Error).message;
      return null;
    }
  };

  const skipStep = (key: string, label: string, message: string, data?: any) => {
    steps.push(createPipelineStep(key, label, 'skipped', message, data));
  };

  if (symbols.length === 0) {
    steps.push(createPipelineStep(
      'validate_symbols',
      '校验贵金属品种',
      'error',
      `未配置可执行贵金属品种，当前支持 ${DEFAULT_METAL_SYMBOLS.join(', ')}`
    ));
    stopped = true;
  }

  if (!stopped && config.refresh_prices !== false) {
    await runStep('refresh_metal_prices', '更新贵金属行情', () => runMetalsDailyUpdate({ ...config, symbols }));
  } else if (!stopped) {
    skipStep('refresh_metal_prices', '更新贵金属行情', '配置 refresh_prices=false，本轮跳过行情更新。');
  }

  if (!stopped && config.refresh_fx !== false) {
    await runStep('refresh_fx_rates', '更新USD/CNY汇率辅助', () => runFxDailyRatesUpdate(config.fx || config));
  } else if (!stopped) {
    skipStep('refresh_fx_rates', '更新USD/CNY汇率辅助', '配置 refresh_fx=false，本轮跳过汇率更新。');
  }

  if (!stopped && config.refresh_macro !== false) {
    await runStep('refresh_metal_macro_factors', '更新贵金属宏观因子', () => runMetalMacroFactorsUpdate(config.macro || config));
  } else if (!stopped) {
    skipStep('refresh_metal_macro_factors', '更新贵金属宏观因子', '配置 refresh_macro=false，本轮跳过宏观因子更新。');
  }

  for (const symbol of symbols) {
    if (stopped) break;
    await runStep(`save_samples_${symbol.toLowerCase()}`, `${symbol} 样本回放落库`, () => callApi('/api/finance/metals/rule-lab/samples/save', {
      symbol,
      limit: replayLimit,
      saved_from: 'precious_metals_training_pipeline'
    }));
  }

  if (!stopped && config.save_action_samples !== false) {
    await runStep('save_action_samples', '贵金属动作样本库落库', () => callApi('/api/finance/metals/rule-lab/action-samples/save', {
      symbol: 'all',
      limit: replayLimit * symbols.length,
      saved_from: 'precious_metals_training_pipeline'
    }));
  } else if (!stopped) {
    skipStep('save_action_samples', '贵金属动作样本库落库', '配置 save_action_samples=false，本轮跳过动作样本库。');
  }

  if (!stopped && config.generate_action_report !== false) {
    await runStep('metal_action_sample_report', '贵金属动作后验验收报告', () => callApi('/api/finance/metals/rule-lab/action-samples/report/generate', {
      saved_from: 'precious_metals_training_pipeline'
    }));
  } else if (!stopped) {
    skipStep('metal_action_sample_report', '贵金属动作后验验收报告', '配置 generate_action_report=false，本轮跳过动作后验报告。');
  }

  if (!stopped) {
    await runStep('sample_health', '贵金属样本体检', () => getApi('/api/finance/metals/rule-lab/samples/health?symbol=all'));
  }

  if (!stopped) {
    await runStep('gold_rule_contrast_report', '黄金规则对照报告', async () => {
      const result = await callApi('/api/finance/metals/rule-lab/gold-rule-report/generate', {
        saved_from: 'precious_metals_training_pipeline'
      });
      goldRuleReport = result?.data?.report || null;
      return result;
    });
  }

  if (!stopped) {
    await runStep('silver_layer_validation', '白银黄金主锚分层验收', () => getApi('/api/finance/metals/rule-lab/silver-validation?case_limit=4'));
  }

  if (!stopped) {
    await runStep('silver_training_gate', '白银训练闸门', async () => {
      const validationStep = steps.find(step => step.key === 'silver_layer_validation');
      const validation = validationStep?.data || {};
      silverGate = evaluateSilverTrainingGate(validation, config.silver_gate || {});
      await persistMetalTrainingGateRun(db, silverGate);
      return {
        message: silverGate.message,
        data: silverGate
      };
    });
  }

  if (!stopped && config.train_gold !== false) {
    await runStep('train_gold_model', '训练黄金主锚模型', () => callApi('/api/finance/metals/rule-lab/training/run', {
      symbol: 'XAUUSD'
    }));
  } else if (!stopped) {
    skipStep('train_gold_model', '训练黄金主锚模型', '配置 train_gold=false，本轮跳过黄金训练。');
  }

  if (!stopped) {
    await runStep('gold_model_validation_report', '黄金模型验收报告', async () => {
      const result = await callApi('/api/finance/metals/rule-lab/training/gold-validation-report/generate', {
        saved_from: 'precious_metals_training_pipeline',
        case_limit: Number(config.gold_model_validation_case_limit || 8)
      });
      goldModelValidationReport = result?.data?.report || null;
      return result;
    });
  }

  if (!stopped) {
    if (silverGate?.passed && config.train_silver_if_gate_pass === true) {
      skipStep(
        'train_silver_model',
        '训练白银辅助模型',
        '白银训练闸门已通过，但当前训练入口仍锁定在黄金主锚；需要先打开白银训练边界后再执行。'
      );
    } else if (silverGate?.passed) {
      skipStep(
        'train_silver_model',
        '训练白银辅助模型',
        '白银训练闸门已通过，但配置未开启 train_silver_if_gate_pass；先保留人工确认。'
      );
    } else {
      skipStep(
        'train_silver_model',
        '训练白银辅助模型',
        silverGate?.message || '白银训练闸门未通过，本轮不训练白银辅助模型。',
        silverGate
      );
    }
  }

  const failedStep = steps.find(step => step.status === 'error') || null;
  const successCount = steps.filter(step => step.status === 'success').length;
  const skippedCount = steps.filter(step => step.status === 'skipped').length;

  return {
    summary: {
      total: steps.length,
      success: successCount,
      skipped: skippedCount,
      failed: failedStep ? 1 : 0,
      failed_step: failedStep?.key || null
    },
    symbols,
    replay_limit: replayLimit,
    gold_rule_report: goldRuleReport,
    gold_model_validation_report: goldModelValidationReport,
    silver_gate: silverGate,
    steps,
    finished_at: new Date().toISOString()
  };
}

async function executeTask(task: TaskRow, triggerType: 'manual' | 'schedule') {
  const db = await getDb();
  await expireSupersededScheduledRuns(db, task.task_key, task.name || task.task_key);
  const existingRunning = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [task.task_key]
  );
  if (existingRunning) {
    return {
      success: false,
      code: 'RUNNING_TASK_EXISTS',
      message: `${task.name || task.task_key}正在执行，本次启动被拦截，避免重复流水线。开始时间：${formatChinaDateTime(existingRunning.started_at)}`,
      data: {
        running_run_id: existingRunning.id,
        started_at: existingRunning.started_at
      }
    };
  }

  const startedAt = new Date().toISOString();
  const runResult = await db.run(
    `INSERT INTO task_center_runs (task_id, task_key, trigger_type, status, started_at)
     VALUES (?, ?, ?, 'running', ?)`,
    [task.id, task.task_key, triggerType, startedAt]
  );
  const runId = Number(runResult.lastID);
  if (!Number.isFinite(runId)) {
    throw new Error(`任务运行记录创建失败：${task.task_key}`);
  }

  try {
    const config = parseConfig(task.config_json);
    const taskTimeoutMs = getTaskExecutionTimeoutMs(task, config);
    return await withTaskExecutionTimeout((async () => {
    let result: any;
    let message = '';
    let finalStatus = 'success';

    if (task.task_type === 'finance_daily_pipeline') {
      result = await runFinanceDailyPipeline(config, {
        taskKey: task.task_key,
        onProgress: ({ step, result: progressResult }) => persistFinancePipelineProgress(
          db,
          task,
          runId,
          '金融日终流水线',
          step,
          progressResult
        )
      });
      const failedStep = result.steps.find((step: any) => step.status === 'error');
      const skippedSteps = result.steps.filter((step: any) => step.status === 'skipped');
      const marketGateSkippedStep = skippedSteps.find((step: any) => step.data?.downstream_blocked);
      message = failedStep
        ? `金融日终流水线失败：停在「${failedStep.label}」 - ${failedStep.message || '原因未知'}`
        : marketGateSkippedStep
          ? `金融日终流水线已按市场总闸停止下游：${marketGateSkippedStep.message || '总闸未通过'}`
        : `金融日终流水线完成：${result.summary.success}/${result.summary.total} 步完成`;
      if (failedStep) {
        const finished = await finishTaskRunIfRunning(db, task, runId, 'error', message, compactFinancePipelineResultForStorage(result));
        if (!finished) return buildLateTaskResult(runId, result);
        return { success: false, message, data: result };
      }
      if (marketGateSkippedStep) {
        finalStatus = 'skipped';
      }
    } else if (task.task_type === 'finance_candidate_funnel_pipeline' || task.task_key === FINANCE_CANDIDATE_FUNNEL_TASK_KEY) {
      const skipReason = triggerType === 'schedule'
        ? await getScheduledFunnelSkipReason(db)
        : null;
      if (skipReason) {
        const finishedAt = new Date().toISOString();
        finalStatus = 'skipped';
        result = {
          summary: { total: 1, success: 0, skipped: 1, failed: 0, failed_step: null },
          steps: [
            {
              key: 'skip_duplicate_daily_pipeline',
              label: '跳过重复漏斗',
              status: 'skipped',
              message: skipReason,
              started_at: startedAt,
              finished_at: finishedAt,
              data: { trigger_type: triggerType }
            }
          ],
          config,
          finished_at: finishedAt
        };
        message = skipReason;
      } else {
        result = await runFinanceCandidateFunnelPipeline(config, {
          taskKey: task.task_key,
          onProgress: ({ step, result: progressResult }) => persistFinancePipelineProgress(
            db,
            task,
            runId,
            '入池漏斗流水线',
            step,
            progressResult
          )
        });
        const failedStep = result.steps.find((step: any) => step.status === 'error');
        message = failedStep
          ? `入池漏斗流水线失败：停在「${failedStep.label}」 - ${failedStep.message || '原因未知'}`
          : `入池漏斗流水线完成：${result.summary.success}/${result.summary.total} 步完成`;
        if (failedStep) {
          const finished = await finishTaskRunIfRunning(db, task, runId, 'error', message, compactFinancePipelineResultForStorage(result));
          if (!finished) return buildLateTaskResult(runId, result);
          return { success: false, message, data: result };
        }
      }
    } else if (task.task_type === 'finance_experiment_prediction_snapshots' || task.task_key === FINANCE_EXPERIMENT_PREDICTION_TASK_KEY) {
      result = await runExperimentPredictionSnapshotPipeline(config, {
        taskKey: task.task_key,
        onProgress: ({ step, result: progressResult }) => persistFinancePipelineProgress(
          db,
          task,
          runId,
          '五模型实验预测池落库',
          step,
          progressResult
        )
      });
      const failedStep = result.steps.find((step: any) => step.status === 'error');
      message = failedStep
        ? `五模型实验预测池落库失败：${failedStep.message || '原因未知'}`
        : `五模型实验预测池落库完成：${result.summary.success}/${result.summary.total} 步完成`;
      if (failedStep) {
        const finished = await finishTaskRunIfRunning(db, task, runId, 'error', message, compactFinancePipelineResultForStorage(result));
        if (!finished) return buildLateTaskResult(runId, result);
        return { success: false, message, data: result };
      }
    } else if (task.task_type === 'daily_close_update') {
      result = await runFinanceDailyPipeline(config, {
        taskKey: task.task_key,
        onProgress: ({ step, result: progressResult }) => persistFinancePipelineProgress(
          db,
          task,
          runId,
          '旧日线任务已切换金融日终流水线',
          step,
          progressResult
        )
      });
      const failedStep = result.steps.find((step: any) => step.status === 'error');
      const skippedSteps = result.steps.filter((step: any) => step.status === 'skipped');
      const marketGateSkippedStep = skippedSteps.find((step: any) => step.data?.downstream_blocked);
      message = failedStep
        ? `旧日线任务按新金融日终流水线执行失败：停在「${failedStep.label}」 - ${failedStep.message || '原因未知'}`
        : marketGateSkippedStep
          ? `旧日线任务已按市场总闸停止下游：${marketGateSkippedStep.message || '总闸未通过'}`
          : `旧日线任务已按新金融日终流水线完成：${result.summary.success}/${result.summary.total} 步完成`;
      if (failedStep) {
        const finished = await finishTaskRunIfRunning(db, task, runId, 'error', message, compactFinancePipelineResultForStorage(result));
        if (!finished) return buildLateTaskResult(runId, result);
        return { success: false, message, data: result };
      }
      if (marketGateSkippedStep) {
        finalStatus = 'skipped';
      }
    } else if (task.task_type === 'secondary_confirmation_scan') {
      const scan = await callApi('/api/finance/assets/entry-trigger-observations/secondary-scan', {
        limit: Number(config.limit || 80)
      });
      result = scan.data;
      message = scan.message || '二次确认扫描完成';
    } else if (task.task_type === 'metals_daily_update' || task.task_key === 'metals_daily_update') {
      const update = await runMetalsDailyUpdate(config);
      result = update.data;
      message = update.message;
    } else if (task.task_type === 'finance_tushare_supplemental_update' || task.task_key === 'finance_tushare_supplemental_update') {
      const update = await runTushareSupplementalUpdate(config);
      result = update.data;
      message = update.message;
    } else if (task.task_type === 'finance_tushare_financial_reports_update' || task.task_key === FINANCE_TUSHARE_FINANCIAL_REPORTS_TASK_KEY) {
      const update = await runTushareFinancialReportsUpdate(config);
      result = update.data;
      message = update.message;
    } else if (task.task_type === 'commodity_metals_price_update' || task.task_key === 'commodity_metals_price_update') {
      const update = await runCommodityMetalsPriceUpdate(config);
      result = update.data;
      message = update.message;
    } else if (task.task_type === 'iphone_price_update' || task.task_key === 'iphone_price_update') {
      const update = await runIphonePriceUpdate(config);
      result = update.data;
      message = update.message;
    } else if (task.task_type === 'video_game_machine_price_update' || task.task_key === 'video_game_machine_price_update') {
      const update = await runVideoGameMachinePriceUpdate(config);
      result = update.data;
      message = update.message;
    } else if (task.task_type === 'popmart_price_update' || task.task_key === 'popmart_price_update') {
      const update = await runPopMartPriceUpdate(config);
      result = update.data;
      message = update.message;
    } else if (task.task_type === 'fx_daily_rates_update' || task.task_key === 'fx_daily_rates_update') {
      const update = await runFxDailyRatesUpdate(config);
      result = update.data;
      message = update.message;
    } else if (task.task_type === 'metal_macro_factors_update' || task.task_key === 'metal_macro_factors_update') {
      const update = await runMetalMacroFactorsUpdate(config);
      result = update.data;
      message = update.message;
    } else if (task.task_type === 'precious_metals_training_pipeline' || task.task_key === 'precious_metals_training_pipeline') {
      result = await runPreciousMetalsTrainingPipeline(config, db);
      const failedStep = result.steps.find((step: any) => step.status === 'error');
      message = failedStep
        ? `贵金属训练流水线失败：停在「${failedStep.label}」 - ${failedStep.message || '原因未知'}`
        : result.silver_gate?.passed
          ? `贵金属训练流水线完成：${result.summary.success}/${result.summary.total} 步完成；白银训练闸门通过`
          : `贵金属训练流水线完成：${result.summary.success}/${result.summary.total} 步完成；白银训练闸门未通过`;
      if (failedStep) {
        const finished = await finishTaskRunIfRunning(db, task, runId, 'error', message, result);
        if (!finished) return buildLateTaskResult(runId, result);
        return { success: false, message, data: result };
      }
    } else {
      throw new Error(`任务执行器未接入：${task.task_key} / ${task.task_type}`);
    }

    const finalRunUpdate = await db.run(
      `UPDATE task_center_runs
       SET status = ?, message = ?, result_json = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
      [
        finalStatus,
        message,
        JSON.stringify(
          task.task_type === 'finance_daily_pipeline'
            || task.task_type === 'daily_close_update'
            || task.task_type === 'finance_candidate_funnel_pipeline'
            || task.task_key === FINANCE_CANDIDATE_FUNNEL_TASK_KEY
            || task.task_type === 'finance_experiment_prediction_snapshots'
            || task.task_key === FINANCE_EXPERIMENT_PREDICTION_TASK_KEY
            ? compactFinancePipelineResultForStorage(result)
            : result
        ),
        new Date().toISOString(),
        runId
      ]
    );
    if (Number(finalRunUpdate?.changes || 0) === 0) {
      return buildLateTaskResult(runId, result);
    }
    await db.run(
      `UPDATE task_center_tasks
       SET last_status = ?, last_message = ?, last_run_at = ?, updated_at = ?
       WHERE id = ?`,
      [finalStatus, message, new Date().toISOString(), new Date().toISOString(), task.id]
    );
    if ((task.task_type === 'finance_daily_pipeline' || task.task_type === 'daily_close_update') && finalStatus === 'success') {
      const now = new Date().toISOString();
      await db.run(
        `UPDATE task_center_tasks
         SET last_status = 'success',
             last_message = '今日漏斗已由金融日终流水线覆盖执行，不需要兜底重复跑。',
             last_run_at = ?,
             updated_at = ?
         WHERE task_key = ?`,
        [now, now, FINANCE_CANDIDATE_FUNNEL_TASK_KEY]
      );
    }
    if (triggerType === 'schedule') {
      lastScheduledRunByTaskWindow.set(task.task_key, getScheduleWindowKey(task));
    }
    return { success: true, message, data: result };
    })(), task, taskTimeoutMs);
  } catch (error) {
    const message = (error as Error).message;
    await finishTaskRunIfRunning(db, task, runId, 'error', message);
    return { success: false, message };
  }
}

async function schedulerTick() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const db = await getDb();
    const tasks: TaskRow[] = await db.all(
      `SELECT * FROM task_center_tasks
       WHERE enabled = 1
       ORDER BY schedule_time ASC, priority ASC, id ASC`
    );
    const now = new Date();
    for (const task of tasks) {
      let due = isDue(task, now);
      if (!due && (task.task_type === 'finance_daily_pipeline' || task.task_key === FINANCE_DAILY_PIPELINE_TASK_KEY)) {
        const scheduledAt = getScheduleDueTime(task, now);
        if (
          task.enabled
          && String(task.last_status || '') === 'success'
          && isRunnableToday(task.schedule_days, now)
          && scheduledAt
          && now >= scheduledAt
        ) {
          const coverageIssue = await getFinanceDailyCoverageIssue(db);
          if (coverageIssue) {
            due = true;
            console.log(`[task-center] ${coverageIssue}，今日成功记录不再视为完成，准备补跑金融日终流水线。`);
          }
        }
      }
      if (due) {
        const runningReason = await getScheduledTaskRunningReason(db, task, now);
        if (runningReason) {
          console.log(`[task-center] ${runningReason}`);
          continue;
        }
        if (task.task_type === 'finance_daily_pipeline' || task.task_key === FINANCE_DAILY_PIPELINE_TASK_KEY) {
          const waitReason = await getScheduledDailyPipelineWaitReason(db, now);
          if (waitReason) {
            console.log(`[task-center] ${waitReason}`);
            continue;
          }
        }
        await executeTask(task, 'schedule');
      }
    }
  } catch (error) {
    console.error('Task center scheduler tick failed:', (error as Error).message);
  } finally {
    schedulerRunning = false;
  }
}

export function startTaskCenterScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(schedulerTick, 60 * 1000);
  setTimeout(schedulerTick, 5000);
  console.log('Task center scheduler started');
}

router.get('/task-center/tasks', async (req: Request, res: ExpressResponse) => {
  try {
    const db = await getDb();
    const compactRuns = ['1', 'true', 'yes'].includes(String(req.query.compact || '').toLowerCase());
    const tasks = await db.all(
      `SELECT
         t.*,
         COALESCE(
           (SELECT r.status FROM task_center_runs r WHERE r.task_key = t.task_key ORDER BY datetime(REPLACE(r.started_at, 'T', ' ')) DESC, r.id DESC LIMIT 1),
           t.last_status
         ) AS last_status,
         COALESCE(
           (SELECT r.message FROM task_center_runs r WHERE r.task_key = t.task_key ORDER BY datetime(REPLACE(r.started_at, 'T', ' ')) DESC, r.id DESC LIMIT 1),
           t.last_message
         ) AS last_message,
         COALESCE(
           (SELECT COALESCE(r.finished_at, r.started_at) FROM task_center_runs r WHERE r.task_key = t.task_key ORDER BY datetime(REPLACE(r.started_at, 'T', ' ')) DESC, r.id DESC LIMIT 1),
           t.last_run_at
         ) AS last_run_at
       FROM task_center_tasks t
       ORDER BY t.schedule_time ASC, t.priority ASC, t.id ASC`
    );
    const runs = await db.all(
      compactRuns
        ? `SELECT id, task_id, task_key, trigger_type, status, message, started_at, finished_at
           FROM task_center_runs
           ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC
           LIMIT 30`
        : `SELECT * FROM task_center_runs
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC
       LIMIT 30`
    );
    res.json({ success: true, data: { tasks, runs } });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取任务中心失败: ${(error as Error).message}` });
  }
});

router.patch('/task-center/tasks/:id', async (req: Request, res: ExpressResponse) => {
  try {
    const db = await getDb();
    const id = req.params.id;
    const enabled = req.body.enabled === undefined ? undefined : (req.body.enabled ? 1 : 0);
    const scheduleTime = String(req.body.schedule_time || '').trim();
    const configJson = req.body.config_json;

    const fields: string[] = [];
    const params: any[] = [];
    if (enabled !== undefined) {
      fields.push('enabled = ?');
      params.push(enabled);
    }
    if (/^\d{2}:\d{2}$/.test(scheduleTime)) {
      fields.push('schedule_time = ?');
      params.push(scheduleTime);
    }
    if (configJson !== undefined) {
      fields.push('config_json = ?');
      params.push(typeof configJson === 'string' ? configJson : JSON.stringify(configJson));
    }
    fields.push('updated_at = ?');
    params.push(new Date().toISOString(), id);

    await db.run(
      `UPDATE task_center_tasks SET ${fields.join(', ')} WHERE id = ?`,
      params
    );

    res.json({ success: true, message: '任务配置已更新' });
  } catch (error) {
    res.status(500).json({ success: false, message: `更新任务失败: ${(error as Error).message}` });
  }
});

router.delete('/task-center/tasks/:id', async (req: Request, res: ExpressResponse) => {
  try {
    const db = await getDb();
    const task = await db.get(`SELECT * FROM task_center_tasks WHERE id = ?`, [req.params.id]);
    if (!task) return res.status(404).json({ success: false, message: '任务不存在' });

    const running = await db.get(
      `SELECT id, started_at
       FROM task_center_runs
       WHERE task_id = ? AND status = 'running'
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
       LIMIT 1`,
      [task.id]
    );
    if (running) {
      return res.status(409).json({ success: false, message: '任务正在执行中，完成后再删除' });
    }

    await db.run('BEGIN');
    let runsDeleted = 0;
    try {
      const runResult = await db.run(
        `DELETE FROM task_center_runs
         WHERE task_id = ? OR task_key = ?`,
        [task.id, task.task_key]
      );
      runsDeleted = Number(runResult?.changes || 0);

      await db.run(`DELETE FROM task_center_tasks WHERE id = ?`, [task.id]);
      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }

    lastScheduledRunByTaskWindow.delete(task.task_key);
    res.json({
      success: true,
      message: `任务「${task.name}」已删除`,
      data: {
        id: task.id,
        task_key: task.task_key,
        runs_deleted: runsDeleted
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `删除任务失败: ${(error as Error).message}` });
  }
});

router.post('/task-center/tasks/:id/run', async (req: Request, res: ExpressResponse) => {
  try {
    const db = await getDb();
    const task = await db.get(`SELECT * FROM task_center_tasks WHERE id = ?`, [req.params.id]);
    if (!task) return res.status(404).json({ success: false, message: '任务不存在' });

    const runningReason = await getScheduledTaskRunningReason(db, task, new Date());
    if (runningReason) {
      return res.status(409).json({ success: false, message: runningReason });
    }

    const result = await executeTask(task, 'manual');
    const statusCode = result.success ? 200 : 'code' in result && result.code === 'RUNNING_TASK_EXISTS' ? 409 : 500;
    res.status(statusCode).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: `执行任务失败: ${(error as Error).message}` });
  }
});

export default router;
