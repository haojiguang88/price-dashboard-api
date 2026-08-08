import express, { Request, Response as ExpressResponse } from 'express';
import { execFile } from 'child_process';
import path from 'path';
import getDb, { getDatabasePath } from '../config/database';
import { inferTaskWorkspace, resolveDomainForWorkspace, type WorkspaceKey } from '../utils/workspace';
import {
  businessWorkspaceCenterServices,
  type ScopedWorkspaceTaskCenterService
} from '../services/workspaceCenterScopedServices';
import { getWorkspaceCenterStatusCode } from '../services/workspaceCenterErrors';

type TaskRow = {
  id: number;
  task_key: string;
  name: string;
  domain: string;
  workspace?: string | null;
  task_type: string;
  enabled: number;
  schedule_time: string;
  schedule_days: string;
  priority: number;
  config_json?: string;
  last_run_at?: string | null;
  last_status?: string | null;
};

const lastScheduledRunByTaskWindow = new Map<string, string>();
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TASK_PYTHON = 'python3';
const RUNTIME_TASK_WORKSPACE: WorkspaceKey = 'business';

function getTaskDomain(task: Partial<TaskRow>) {
  const workspace = inferTaskWorkspace(task);
  return resolveDomainForWorkspace(task.domain, workspace);
}

function getRuntimeTaskWorkspaceScope(): WorkspaceKey {
  return RUNTIME_TASK_WORKSPACE;
}

function isTaskInRuntimeWorkspace(task: Partial<TaskRow>, runtimeWorkspace = getRuntimeTaskWorkspaceScope()) {
  return inferTaskWorkspace(task) === runtimeWorkspace;
}

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

function getTaskExecutionTimeoutMs(config: any) {
  const configuredMs = Number(config.task_timeout_ms || 0);
  const configuredMinutes = Number(config.task_timeout_minutes || 0);
  const raw = Number.isFinite(configuredMs) && configuredMs > 0
    ? configuredMs
    : Number.isFinite(configuredMinutes) && configuredMinutes > 0
      ? configuredMinutes * 60 * 1000
      : DEFAULT_TASK_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(raw), 60 * 1000), 6 * 60 * 60 * 1000);
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
  if (scheduleDays === 'work_days') return day >= 1 && day <= 5;
  return true;
}

function getScheduleWindowKey(task: TaskRow, now = new Date()) {
  return `${inferTaskWorkspace(task)}|${getDateKey(now)}|${task.task_key}|${task.schedule_time}`;
}

function parseScheduleTime(scheduleTime: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(scheduleTime || '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function getScheduleDueTime(task: TaskRow, now = new Date()) {
  const parsed = parseScheduleTime(task.schedule_time);
  if (!parsed) return null;
  const { year, month, day } = getChinaDateParts(now);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day, parsed.hour - 8, parsed.minute, 0, 0));
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

async function expireSupersededScheduledRuns(db: any, task: TaskRow, now = new Date()) {
  const taskWorkspace = inferTaskWorkspace(task);
  const taskTimeoutMs = getTaskExecutionTimeoutMs(parseConfig(task.config_json));
  const runningRows = await db.all(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running' AND workspace = ?
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC`,
    [task.task_key, taskWorkspace]
  );
  const staleRows = runningRows.filter((row: any) => {
    const startedMs = new Date(row.started_at).getTime();
    return Number.isFinite(startedMs) && now.getTime() - startedMs > taskTimeoutMs;
  });
  if (staleRows.length === 0) return;

  const finishedAt = now.toISOString();
  for (const row of staleRows) {
    const message = `${task.name || task.task_key}超过 ${formatDurationMs(taskTimeoutMs)} 仍未结束，自动标记为失败，避免定时器长期卡住。`;
    await db.run(
      `UPDATE task_center_runs
       SET status = 'error', message = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
      [message, finishedAt, row.id]
    );
  }
}

export async function cleanupOrphanedTaskRunsOnStartup() {
  const db = await getDb();
  const runtimeWorkspace = getRuntimeTaskWorkspaceScope();
  const rows = await db.all(
    `SELECT id, task_key
     FROM task_center_runs
     WHERE status = 'running'
       AND workspace = ?
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) ASC, id ASC`,
    [runtimeWorkspace]
  );
  if (rows.length === 0) return;

  const now = new Date().toISOString();
  const message = '后端重启时检测到孤儿运行记录，已自动标记为失败；需要重新手动执行或等待下一次定时任务。';
  for (const row of rows) {
    await db.run(
      `UPDATE task_center_runs
       SET status = 'error', message = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
      [message, now, row.id]
    );
    await db.run(
      `UPDATE task_center_tasks
       SET last_status = 'error',
           last_message = ?,
           last_run_at = ?,
           updated_at = ?
       WHERE task_key = ?
       AND workspace = ?`,
      [message, now, now, row.task_key, runtimeWorkspace]
    );
  }
  console.warn(`[task-center] cleaned ${rows.length} orphaned business task run(s) after backend startup`);
}

async function getScheduledTaskRunningReason(db: any, task: TaskRow, now = new Date()) {
  await expireSupersededScheduledRuns(db, task, now);
  const taskWorkspace = inferTaskWorkspace(task);
  const running = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running' AND workspace = ?
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [task.task_key, taskWorkspace]
  );
  if (!running) return null;
  return `${task.name || task.task_key}正在执行，本轮定时跳过，避免重复启动。开始时间：${formatChinaDateTime(running.started_at)}`;
}

function getTaskPython(config: any) {
  return String(
    config.python ||
    process.env.TASK_CENTER_PYTHON ||
    process.env.PYTHON_BIN ||
    DEFAULT_TASK_PYTHON
  );
}

type ExecFileTaskError = Error & {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
};

type BusinessTaskRunResult = {
  message: string;
  data: any;
  status?: 'success' | 'skipped';
};

function formatPythonTaskError(errorOutput: string, fallbackMessage: string, pythonBin: string) {
  const missingModule = errorOutput.match(/ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/);
  if (missingModule?.[1]) {
    return `任务中心 Python 依赖缺失：${missingModule[1]}。当前 Python：${pythonBin}。请先设置 TASK_CENTER_PYTHON 指向任务运行时 Python，并执行 npm run setup:business-tasks。`;
  }
  return errorOutput || fallbackMessage;
}

function runExecFileWithTimeout(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const child = execFile(command, args, {
      cwd: path.join(__dirname, '../..'),
      maxBuffer: 1024 * 1024 * 10,
      env: process.env
    }, (error, stdout, stderr) => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);

      const stdoutText = String(stdout || '');
      const stderrText = String(stderr || '');
      if (error) {
        const taskError = error as ExecFileTaskError;
        taskError.stdout = stdoutText;
        taskError.stderr = stderrText;
        taskError.timedOut = timedOut;
        reject(taskError);
        return;
      }
      if (timedOut) {
        const taskError = new Error('Task execution timed out') as ExecFileTaskError;
        taskError.stdout = stdoutText;
        taskError.stderr = stderrText;
        taskError.timedOut = true;
        reject(taskError);
        return;
      }

      resolve({ stdout: stdoutText, stderr: stderrText });
    });

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);
  });
}

async function runPythonJsonScript(
  config: any,
  scriptName: string,
  args: string[],
  fallbackMessage: string,
  timeoutMs: number,
  taskName: string
) {
  const scriptPath = path.join(__dirname, '../../scripts/business', scriptName);
  const pythonBin = getTaskPython(config);
  let stdout = '';
  let stderr = '';
  try {
    const result = await runExecFileWithTimeout(pythonBin, [scriptPath, ...args], timeoutMs);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const taskError = error as ExecFileTaskError;
    const errorOutput = String(taskError.stderr || taskError.stdout || '').trim();
    if (taskError.timedOut) {
      throw new Error(`任务执行超过等待上限 ${formatDurationMs(timeoutMs)}，已终止 Python 进程：${taskName}`);
    }
    if (taskError.code === 'ENOENT') {
      throw new Error(`任务中心找不到 Python 可执行文件：${pythonBin}。请安装 python3，或设置 TASK_CENTER_PYTHON 指向线上可用的 Python。`);
    }
    throw new Error(formatPythonTaskError(errorOutput || taskError.message || '', fallbackMessage, pythonBin));
  }
  const lines = stdout.trim().split('\n').filter(Boolean);
  let parsed: any;
  try {
    parsed = JSON.parse(lines[lines.length - 1] || '{}');
  } catch {
    const errorOutput = String(stderr || stdout || '').trim();
    throw new Error(`${fallbackMessage}：Python脚本未返回有效JSON${errorOutput ? `；输出：${errorOutput}` : ''}`);
  }
  if (parsed.success === false) {
    throw new Error(parsed.message || stderr || fallbackMessage);
  }
  return parsed;
}

function getTaskCompletionStatus(data: any): 'success' | 'skipped' {
  return data?.status === 'skipped' || data?.skipped === true ? 'skipped' : 'success';
}

function getLatestTaskRecordDate(data: any) {
  const records = Array.isArray(data?.records) ? data.records : [];
  const dates = records
    .map((record: any) => String(record?.price_date || record?.date || '').slice(0, 10))
    .filter((date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  return dates[dates.length - 1] || '';
}

function getBackupSourceReason(config: any, data: any) {
  if (config.use_backup_source === false || config.backup_on_stale === false) return '';
  const records = Array.isArray(data?.records) ? data.records : [];
  if (records.length === 0 && config.backup_on_empty !== false) {
    return '主源没有返回价格记录';
  }

  const latestDate = getLatestTaskRecordDate(data);
  const todayKey = getDateKey();
  if (latestDate && latestDate < todayKey) {
    return `主源最新价格日期 ${latestDate} 落后于今天 ${todayKey}`;
  }
  return '';
}

function buildBackupArgs(config: any, category: string) {
  const args = [
    '--db',
    getDatabasePath(),
    '--category',
    category
  ];
  if (config.dry_run) args.push('--dry-run');
  return args;
}

function getTaskSourceName(config: any, fallback: string) {
  const value = String(config.source_name ?? config.sourceName ?? '').trim();
  return value || fallback;
}

async function runBackupPriceUpdate(
  config: any,
  category: string,
  timeoutMs: number,
  taskName: string
) {
  return runPythonJsonScript(
    config,
    'iphone_backup.py',
    buildBackupArgs(config, category),
    `${category}备用价格源更新失败`,
    timeoutMs,
    taskName
  );
}

function buildTaskResult(
  parsed: any,
  fallbackMessage: string,
  extraMessage = ''
): BusinessTaskRunResult {
  return {
    message: `${parsed.message || fallbackMessage}${extraMessage}`,
    data: parsed,
    status: getTaskCompletionStatus(parsed)
  };
}

function buildBackupSuccessResult(
  primaryParsed: any | null,
  backupParsed: any,
  reason: string,
  primaryMessage: string,
  primaryErrorMessage?: string
): BusinessTaskRunResult {
  const backupStatus = getTaskCompletionStatus(backupParsed);
  const primaryStatus = primaryParsed ? getTaskCompletionStatus(primaryParsed) : undefined;
  const status = primaryStatus === 'success' ? 'success' : backupStatus;
  const backupMessage = backupParsed.message || '备用源执行完成';
  const message = primaryErrorMessage
    ? `${primaryMessage}：主源失败：${primaryErrorMessage}；已启用备用源：${backupMessage}`
    : `${primaryMessage}；${reason}，已尝试备用源：${backupMessage}`;

  return {
    message,
    data: {
      primary: primaryParsed,
      primary_error: primaryErrorMessage || '',
      backup: backupParsed,
      backup_reason: reason,
      backup_used: true
    },
    status
  };
}

function buildPrimaryWithBackupFailureResult(
  primaryParsed: any,
  reason: string,
  primaryMessage: string,
  backupErrorMessage: string
): BusinessTaskRunResult {
  return {
    message: `${primaryMessage}；${reason}，但备用源失败：${backupErrorMessage}`,
    data: {
      primary: primaryParsed,
      backup_error: backupErrorMessage,
      backup_reason: reason,
      backup_used: false
    },
    status: getTaskCompletionStatus(primaryParsed)
  };
}

async function runCommodityMetalsPriceUpdate(config: any, timeoutMs: number, taskName: string): Promise<BusinessTaskRunResult> {
  const source = ['auto', 'dehuang', 'jijinhao'].includes(String(config.source || '').trim())
    ? String(config.source).trim()
    : 'jijinhao';
  const historyDays = Number(config.history_days ?? config.historyDays ?? 30);
  const maxSourceAgeDays = Number(config.max_source_age_days ?? config.maxSourceAgeDays ?? 2);
  const args = [
    '--db',
    getDatabasePath(),
    '--targets',
    Array.isArray(config.targets)
      ? config.targets.join(',')
      : String(config.targets || '黄金9999,白银'),
    '--source',
    source,
    '--history-days',
    String(Number.isFinite(historyDays) && historyDays > 0 ? Math.round(historyDays) : 30),
    '--max-source-age-days',
    String(Number.isFinite(maxSourceAgeDays) && maxSourceAgeDays > 0 ? maxSourceAgeDays : 2)
  ];
  if (config.dry_run) args.push('--dry-run');

  const parsed = await runPythonJsonScript(config, 'guijinshu.py', args, '商品贵金属价格更新失败', timeoutMs, taskName);
  const priceText = Array.isArray(parsed.records)
    ? parsed.records
      .map((record: any) => `${record.object} ${record.price}`)
      .join('，')
    : '';
  return buildTaskResult(parsed, '商品贵金属价格更新完成', priceText ? `：${priceText}` : '');
}

async function runPreciousMetalMarketUpdate(config: any, timeoutMs: number, taskName: string): Promise<BusinessTaskRunResult> {
  const symbols = Array.isArray(config.symbols)
    ? config.symbols.join(',')
    : String(config.symbols || 'XAUUSD,SGE_AGTD,USDCNH');
  const args = [
    '--db',
    getDatabasePath(),
    '--mode',
    'update',
    '--symbols',
    symbols
  ];
  if (config.dry_run) args.push('--dry-run');

  const parsed = await runPythonJsonScript(config, 'precious_metal_market.py', args, '贵金属大盘行情更新失败', timeoutMs, taskName);
  return {
    message: parsed.message || '贵金属大盘行情更新完成',
    data: parsed,
    status: getTaskCompletionStatus(parsed)
  };
}

async function runIphonePriceUpdate(config: any, timeoutMs: number, taskName: string): Promise<BusinessTaskRunResult> {
  const category = String(config.category || '苹果手机');
  const primarySourceName = getTaskSourceName(config, '潮收汇苹果备用报价');
  const legacySourceName = getTaskSourceName(config, '德璜小程序档口报价');

  const legacyArgs = [
    '--db',
    getDatabasePath(),
    '--category',
    category,
    '--source-name',
    legacySourceName
  ];

  if (config.dry_run) legacyArgs.push('--dry-run');

  let parsed: any;
  try {
    parsed = await runBackupPriceUpdate(config, category, timeoutMs, taskName);
  } catch (error) {
    if (config.use_backup_source === false || config.backup_on_failure === false) {
      throw error;
    }

    let legacyParsed: any;
    try {
      legacyParsed = await runPythonJsonScript(config, 'iphone.py', legacyArgs, '德璜小程序苹果源更新失败', timeoutMs, taskName);
    } catch {
      throw error;
    }

    return {
      message: `苹果手机价格更新：${primarySourceName}失败：${(error as Error).message}；已回退${legacySourceName}`,
      data: {
        primary_error: (error as Error).message,
        primary_source: primarySourceName,
        fallback_source: legacySourceName,
        primary: null,
        fallback: legacyParsed,
      },
      status: getTaskCompletionStatus(legacyParsed)
    };
  }

  return buildTaskResult(parsed, `苹果手机价格更新完成（${primarySourceName}）`);
}

async function runVideoGameMachinePriceUpdate(config: any, timeoutMs: number, taskName: string): Promise<BusinessTaskRunResult> {
  const args = [
    '--db',
    getDatabasePath(),
    '--category',
    String(config.category || '游戏机'),
    '--source-name',
    getTaskSourceName(config, '东旭游戏机档口')
  ];
  if (config.dry_run) args.push('--dry-run');

  let parsed: any;
  try {
    parsed = await runPythonJsonScript(config, 'video_game_machine.py', args, '游戏机价格更新失败', timeoutMs, taskName);
  } catch (error) {
    if (config.use_backup_source === false || config.backup_on_failure === false) throw error;
    const backupParsed = await runBackupPriceUpdate(config, String(config.category || '游戏机'), timeoutMs, taskName);
    return buildBackupSuccessResult(null, backupParsed, '主源失败', '游戏机价格更新', (error as Error).message);
  }

  const unmappedText = Array.isArray(parsed.unmapped_enabled_objects) && parsed.unmapped_enabled_objects.length > 0
    ? `；系统对象未映射 ${parsed.unmapped_enabled_objects.join('、')}`
    : '';

  const primaryMessage = `${parsed.message || '游戏机价格更新完成'}${unmappedText}`;
  const backupReason = getBackupSourceReason(config, parsed);
  if (!backupReason) {
    return buildTaskResult(parsed, '游戏机价格更新完成', unmappedText);
  }

  try {
    const backupParsed = await runBackupPriceUpdate(config, String(config.category || '游戏机'), timeoutMs, taskName);
    return buildBackupSuccessResult(parsed, backupParsed, backupReason, primaryMessage);
  } catch (error) {
    return buildPrimaryWithBackupFailureResult(
      parsed,
      backupReason,
      primaryMessage,
      (error as Error).message
    );
  }
}

async function runPopMartPriceUpdate(config: any, timeoutMs: number, taskName: string): Promise<BusinessTaskRunResult> {
  const args = [
    '--db',
    getDatabasePath(),
    '--category',
    String(config.category || '泡泡玛特'),
    '--source-name',
    getTaskSourceName(config, '千岛泡泡玛特')
  ];
  if (config.dry_run) args.push('--dry-run');

  const parsed = await runPythonJsonScript(config, 'ppmt.py', args, '泡泡玛特价格更新失败', timeoutMs, taskName);
  const unmappedText = Array.isArray(parsed.unmapped_enabled_objects) && parsed.unmapped_enabled_objects.length > 0
    ? `；待确认映射 ${parsed.unmapped_enabled_objects.join('、')}`
    : '';

  return {
    message: `${parsed.message || '泡泡玛特价格更新完成'}${unmappedText}`,
    data: parsed,
    status: getTaskCompletionStatus(parsed)
  };
}

async function runLongyinbiPriceUpdate(config: any, timeoutMs: number, taskName: string): Promise<BusinessTaskRunResult> {
  const args = [
    '--db',
    getDatabasePath()
  ];
  if (config.replace_target) args.push('--replace-target');
  if (config.dry_run) args.push('--dry-run');

  const parsed = await runPythonJsonScript(config, 'longyinbi.py', args, '龙银币价格更新失败', timeoutMs, taskName);
  return {
    message: parsed.message || '龙银币价格更新完成',
    data: parsed,
    status: getTaskCompletionStatus(parsed)
  };
}

async function runLongchaoPriceUpdate(config: any, timeoutMs: number, taskName: string): Promise<BusinessTaskRunResult> {
  const args = [
    '--db',
    getDatabasePath()
  ];
  const pageSize = Number(config.page_size || config.pageSize || 0);
  const maxPages = Number(config.max_pages || config.maxPages || 0);
  if (Number.isFinite(pageSize) && pageSize > 0) args.push('--page-size', String(Math.floor(pageSize)));
  if (Number.isFinite(maxPages) && maxPages > 0) args.push('--max-pages', String(Math.floor(maxPages)));
  if (config.since) args.push('--since', String(config.since));
  if (config.until) args.push('--until', String(config.until));
  if (config.dry_run) args.push('--dry-run');

  const parsed = await runPythonJsonScript(config, 'longchao.py', args, '龙钞价格更新失败', timeoutMs, taskName);
  return {
    message: parsed.message || '龙钞价格更新完成',
    data: parsed,
    status: getTaskCompletionStatus(parsed)
  };
}

async function runBusinessTask(task: TaskRow, config: any, timeoutMs: number): Promise<BusinessTaskRunResult> {
  const taskName = task.name || task.task_key;
  if (task.task_type === 'commodity_metals_price_update' || task.task_key === 'commodity_metals_price_update') {
    return runCommodityMetalsPriceUpdate(config, timeoutMs, taskName);
  }
  if (task.task_type === 'precious_metal_market_update' || task.task_key === 'precious_metal_market_update') {
    return runPreciousMetalMarketUpdate(config, timeoutMs, taskName);
  }
  if (task.task_type === 'iphone_price_update' || task.task_key === 'iphone_price_update') {
    return runIphonePriceUpdate(config, timeoutMs, taskName);
  }
  if (task.task_type === 'video_game_machine_price_update' || task.task_key === 'video_game_machine_price_update') {
    return runVideoGameMachinePriceUpdate(config, timeoutMs, taskName);
  }
  if (task.task_type === 'popmart_price_update' || task.task_key === 'popmart_price_update') {
    return runPopMartPriceUpdate(config, timeoutMs, taskName);
  }
  if (task.task_type === 'longyinbi_price_update' || task.task_key === 'longyinbi_price_update') {
    return runLongyinbiPriceUpdate(config, timeoutMs, taskName);
  }
  if (task.task_type === 'longchao_price_update' || task.task_key === 'longchao_price_update') {
    return runLongchaoPriceUpdate(config, timeoutMs, taskName);
  }
  throw new Error(`生意任务执行器未接入：${task.task_key} / ${task.task_type}`);
}

async function executeTask(task: TaskRow, triggerType: 'manual' | 'schedule') {
  const db = await getDb();
  const taskWorkspace = inferTaskWorkspace(task);
  await expireSupersededScheduledRuns(db, task);
  const existingRunning = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running' AND workspace = ?
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [task.task_key, taskWorkspace]
  );
  if (existingRunning) {
    return {
      success: false,
      code: 'RUNNING_TASK_EXISTS',
      message: `${task.name || task.task_key}正在执行，本次启动被拦截，避免重复任务。开始时间：${formatChinaDateTime(existingRunning.started_at)}`,
      data: {
        running_run_id: existingRunning.id,
        started_at: existingRunning.started_at
      }
    };
  }

  const startedAt = new Date().toISOString();
  const taskDomain = getTaskDomain(task);
  const runResult = await db.run(
    `INSERT INTO task_center_runs (task_id, task_key, domain, workspace, trigger_type, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    [task.id, task.task_key, taskDomain, taskWorkspace, triggerType, startedAt]
  );
  const runId = Number(runResult.lastID);
  if (!Number.isFinite(runId)) {
    throw new Error(`任务运行记录创建失败：${task.task_key}`);
  }

  try {
    const config = parseConfig(task.config_json);
    const taskTimeoutMs = getTaskExecutionTimeoutMs(config);
    const update = await runBusinessTask(task, config, taskTimeoutMs);
    const finalStatus = update.status || 'success';
    const now = new Date().toISOString();
    const finalRunUpdate = await db.run(
      `UPDATE task_center_runs
       SET status = ?, message = ?, result_json = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
      [finalStatus, update.message, JSON.stringify(update.data), now, runId]
    );
    if (Number(finalRunUpdate?.changes || 0) === 0) {
      return {
        success: false,
        message: '任务已被超时保护或其他收口逻辑结束，后续迟到结果未覆盖任务状态。',
        data: update.data,
        run_id: runId
      };
    }
    await db.run(
      `UPDATE task_center_tasks
       SET last_status = ?, last_message = ?, last_run_at = ?, updated_at = ?
       WHERE id = ?`,
      [finalStatus, update.message, now, now, task.id]
    );
    if (triggerType === 'schedule') {
      lastScheduledRunByTaskWindow.set(task.task_key, getScheduleWindowKey(task));
    }
    return { success: true, message: update.message, data: update.data };
  } catch (error) {
    const message = (error as Error).message;
    const now = new Date().toISOString();
    await db.run(
      `UPDATE task_center_runs
       SET status = 'error', message = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
      [message, now, runId]
    );
    await db.run(
      `UPDATE task_center_tasks
       SET last_status = 'error', last_message = ?, last_run_at = ?, updated_at = ?
       WHERE id = ?`,
      [message, now, now, task.id]
    );
    return { success: false, message };
  }
}

export async function runTaskCenterSchedulerTick() {
  try {
    const db = await getDb();
    const runtimeWorkspace = getRuntimeTaskWorkspaceScope();
    const tasks: TaskRow[] = await db.all(
      `SELECT * FROM task_center_tasks
       WHERE enabled = 1
       ORDER BY schedule_time ASC, priority ASC, id ASC`
    );
    const now = new Date();
    for (const task of tasks.filter(task => isTaskInRuntimeWorkspace(task, runtimeWorkspace))) {
      if (!isDue(task, now)) continue;
      const runningReason = await getScheduledTaskRunningReason(db, task, now);
      if (runningReason) {
        console.log(`[task-center] ${runningReason}`);
        continue;
      }
      await executeTask(task, 'schedule');
    }
  } catch (error) {
    console.error('Task center scheduler tick failed:', (error as Error).message);
  }
}

export const createTaskCenterRoutes = (
  taskCenterService: ScopedWorkspaceTaskCenterService = businessWorkspaceCenterServices.taskCenter
) => {
  const router = express.Router();

  router.get('/task-center/tasks', async (req: Request, res: ExpressResponse) => {
    try {
      const data = await taskCenterService.getTaskCenterSnapshot(req.query.compact);
      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ success: false, message: `获取任务中心失败: ${(error as Error).message}` });
    }
  });

  router.get('/task-center/health', async (_req: Request, res: ExpressResponse) => {
    try {
      const data = await taskCenterService.getTaskCenterHealth();
      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({ success: false, message: `获取任务健康失败: ${(error as Error).message}` });
    }
  });

  router.get('/task-center/runs/:id', async (req: Request, res: ExpressResponse) => {
    try {
      const data = await taskCenterService.getTaskCenterRun(String(req.params.id));
      res.json({ success: true, data });
    } catch (error) {
      res.status(getWorkspaceCenterStatusCode(error)).json({ success: false, message: `获取任务执行详情失败: ${(error as Error).message}` });
    }
  });

  router.patch('/task-center/tasks/:id', async (req: Request, res: ExpressResponse) => {
    try {
      await taskCenterService.updateTaskCenterTask(String(req.params.id), req.body || {});
      res.json({ success: true, message: '任务配置已更新' });
    } catch (error) {
      res.status(getWorkspaceCenterStatusCode(error)).json({ success: false, message: `更新任务失败: ${(error as Error).message}` });
    }
  });

  router.delete('/task-center/tasks/:id', async (req: Request, res: ExpressResponse) => {
    try {
      const { task, runsDeleted } = await taskCenterService.deleteTaskCenterTask(String(req.params.id));
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
      res.status(getWorkspaceCenterStatusCode(error)).json({ success: false, message: `删除任务失败: ${(error as Error).message}` });
    }
  });

  router.post('/task-center/tasks/:id/run', async (req: Request, res: ExpressResponse) => {
    try {
      const db = await getDb();
      const task = await taskCenterService.getTaskCenterTask(String(req.params.id));

      const runningReason = await getScheduledTaskRunningReason(db, task, new Date());
      if (runningReason) {
        return res.status(409).json({ success: false, message: runningReason });
      }

      const result = await executeTask(task, 'manual');
      const statusCode = result.success ? 200 : 'code' in result && result.code === 'RUNNING_TASK_EXISTS' ? 409 : 500;
      res.status(statusCode).json(result);
    } catch (error) {
      res.status(getWorkspaceCenterStatusCode(error)).json({ success: false, message: `执行任务失败: ${(error as Error).message}` });
    }
  });

  return router;
};

export default createTaskCenterRoutes();
