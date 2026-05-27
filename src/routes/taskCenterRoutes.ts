import express, { Request, Response as ExpressResponse } from 'express';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import getDb, { getDatabasePath } from '../config/database';
import { inferTaskWorkspace, resolveDomainForWorkspace, type WorkspaceKey } from '../utils/workspace';
import {
  businessWorkspaceCenterServices,
  type ScopedWorkspaceTaskCenterService
} from '../services/workspaceCenterScopedServices';
import { getWorkspaceCenterStatusCode } from '../services/workspaceCenterErrors';

const execFileAsync = promisify(execFile);

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
const MODEL_TRAINING_ROOT = process.env.MODEL_TRAINING_ROOT || '/Volumes/7100/model-training';
const DEFAULT_TASK_PYTHON = path.join(MODEL_TRAINING_ROOT, 'venv', 'bin', 'python');
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
  return `${inferTaskWorkspace(task)}|${getDateKey(now)}|${task.task_key}|${task.schedule_time}`;
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

async function expireSupersededScheduledRuns(db: any, taskKey: string, taskName: string, now = new Date()) {
  const runningRows = await db.all(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_key = ? AND status = 'running'
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC`,
    [taskKey]
  );
  const staleRows = runningRows.filter((row: any) => {
    const startedMs = new Date(row.started_at).getTime();
    return Number.isFinite(startedMs) && now.getTime() - startedMs > DEFAULT_TASK_TIMEOUT_MS;
  });
  if (staleRows.length === 0) return;

  const finishedAt = now.toISOString();
  for (const row of staleRows) {
    const message = `${taskName}超过 ${formatDurationMs(DEFAULT_TASK_TIMEOUT_MS)} 仍未结束，自动标记为失败，避免定时器长期卡住。`;
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
  const workspaceCondition = runtimeWorkspace ? ' AND workspace = ?' : '';
  const params = runtimeWorkspace ? [runtimeWorkspace] : [];
  const rows = await db.all(
    `SELECT id, task_key
     FROM task_center_runs
     WHERE status = 'running'
       ${workspaceCondition}
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) ASC, id ASC`,
    params
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
       ${runtimeWorkspace ? 'AND workspace = ?' : ''}`,
      runtimeWorkspace
        ? [message, now, now, row.task_key, runtimeWorkspace]
        : [message, now, now, row.task_key]
    );
  }
  console.warn(`[task-center] cleaned ${rows.length} orphaned business task run(s) after backend startup`);
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

function getTaskPython(config: any) {
  return String(config.python || process.env.PYTHON_BIN || process.env.MODEL_TRAINING_PYTHON || DEFAULT_TASK_PYTHON);
}

async function runPythonJsonScript(config: any, scriptName: string, args: string[], fallbackMessage: string) {
  const scriptPath = path.join(__dirname, '../../scripts/business', scriptName);
  const { stdout, stderr } = await execFileAsync(getTaskPython(config), [scriptPath, ...args], {
    cwd: path.join(__dirname, '../..'),
    maxBuffer: 1024 * 1024 * 10,
    env: process.env
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || '{}');
  if (parsed.success === false) {
    throw new Error(parsed.message || stderr || fallbackMessage);
  }
  return parsed;
}

async function runCommodityMetalsPriceUpdate(config: any) {
  const args = [
    '--db',
    String(config.db || getDatabasePath()),
    '--targets',
    Array.isArray(config.targets)
      ? config.targets.join(',')
      : String(config.targets || '黄金9999,白银')
  ];
  if (config.dry_run) args.push('--dry-run');

  const parsed = await runPythonJsonScript(config, 'guijinshu.py', args, '商品贵金属价格更新失败');
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
  const args = [
    '--db',
    String(config.db || getDatabasePath()),
    '--category',
    String(config.category || '苹果手机')
  ];
  if (config.dry_run) args.push('--dry-run');

  const parsed = await runPythonJsonScript(config, 'iphone.py', args, '苹果手机价格更新失败');
  return {
    message: parsed.message || '苹果手机价格更新完成',
    data: parsed
  };
}

async function runVideoGameMachinePriceUpdate(config: any) {
  const args = [
    '--db',
    String(config.db || getDatabasePath()),
    '--category',
    String(config.category || '游戏机')
  ];
  if (config.dry_run) args.push('--dry-run');

  const parsed = await runPythonJsonScript(config, 'video_game_machine.py', args, '游戏机价格更新失败');
  const unmappedText = Array.isArray(parsed.unmapped_enabled_objects) && parsed.unmapped_enabled_objects.length > 0
    ? `；系统对象未映射 ${parsed.unmapped_enabled_objects.join('、')}`
    : '';

  return {
    message: `${parsed.message || '游戏机价格更新完成'}${unmappedText}`,
    data: parsed
  };
}

async function runPopMartPriceUpdate(config: any) {
  const args = [
    '--db',
    String(config.db || getDatabasePath()),
    '--category',
    String(config.category || '泡泡玛特')
  ];
  if (config.dry_run) args.push('--dry-run');

  const parsed = await runPythonJsonScript(config, 'ppmt.py', args, '泡泡玛特价格更新失败');
  const unmappedText = Array.isArray(parsed.unmapped_enabled_objects) && parsed.unmapped_enabled_objects.length > 0
    ? `；待确认映射 ${parsed.unmapped_enabled_objects.join('、')}`
    : '';

  return {
    message: `${parsed.message || '泡泡玛特价格更新完成'}${unmappedText}`,
    data: parsed
  };
}

async function runBusinessTask(task: TaskRow, config: any) {
  if (task.task_type === 'commodity_metals_price_update' || task.task_key === 'commodity_metals_price_update') {
    return runCommodityMetalsPriceUpdate(config);
  }
  if (task.task_type === 'iphone_price_update' || task.task_key === 'iphone_price_update') {
    return runIphonePriceUpdate(config);
  }
  if (task.task_type === 'video_game_machine_price_update' || task.task_key === 'video_game_machine_price_update') {
    return runVideoGameMachinePriceUpdate(config);
  }
  if (task.task_type === 'popmart_price_update' || task.task_key === 'popmart_price_update') {
    return runPopMartPriceUpdate(config);
  }
  throw new Error(`生意任务执行器未接入：${task.task_key} / ${task.task_type}`);
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
      message: `${task.name || task.task_key}正在执行，本次启动被拦截，避免重复任务。开始时间：${formatChinaDateTime(existingRunning.started_at)}`,
      data: {
        running_run_id: existingRunning.id,
        started_at: existingRunning.started_at
      }
    };
  }

  const startedAt = new Date().toISOString();
  const taskDomain = getTaskDomain(task);
  const taskWorkspace = inferTaskWorkspace(task);
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
    return await withTaskExecutionTimeout((async () => {
      const update = await runBusinessTask(task, config);
      const now = new Date().toISOString();
      const finalRunUpdate = await db.run(
        `UPDATE task_center_runs
         SET status = 'success', message = ?, result_json = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
        [update.message, JSON.stringify(update.data), now, runId]
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
         SET last_status = 'success', last_message = ?, last_run_at = ?, updated_at = ?
         WHERE id = ?`,
        [update.message, now, now, task.id]
      );
      if (triggerType === 'schedule') {
        lastScheduledRunByTaskWindow.set(task.task_key, getScheduleWindowKey(task));
      }
      return { success: true, message: update.message, data: update.data };
    })(), task, taskTimeoutMs);
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
