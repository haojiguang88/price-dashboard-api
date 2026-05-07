import express, { Request, Response } from 'express';
import getDb from '../config/database';
import { runFinanceCandidateFunnelPipeline, runFinanceDailyPipeline } from '../services/financeDailyPipeline';

const router = express.Router();

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
};

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerRunning = false;
const lastRunByTaskDate = new Map<string, string>();

function parseConfig(configJson?: string) {
  if (!configJson) return {};
  try {
    return JSON.parse(configJson);
  } catch {
    return {};
  }
}

function isRunnableToday(scheduleDays: string, now = new Date()) {
  const day = now.getDay();
  if (scheduleDays === 'every_day') return true;
  if (scheduleDays === 'work_days' || scheduleDays === 'trade_days') return day >= 1 && day <= 5;
  return true;
}

function getDateKey(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function hasRunToday(task: TaskRow, now = new Date()) {
  const todayKey = getDateKey(now);
  if (lastRunByTaskDate.get(task.task_key) === todayKey) return true;
  if (!task.last_run_at) return false;
  return getDateKey(new Date(task.last_run_at)) === todayKey;
}

function isDue(task: TaskRow, now = new Date()) {
  if (!task.enabled) return false;
  if (!isRunnableToday(task.schedule_days, now)) return false;

  const [hour, minute] = task.schedule_time.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;

  const due = new Date(now);
  due.setHours(hour, minute, 0, 0);
  if (now < due) return false;

  return !hasRunToday(task, now);
}

async function callApi(path: string, body: any) {
  const port = process.env.PORT || 3001;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json() as any;
  if (!response.ok || data.success === false) {
    throw new Error(data.message || `接口执行失败: ${path}`);
  }
  return data;
}

async function runMetalsDailyUpdate(config: any) {
  const configuredSymbols = Array.isArray(config.symbols)
    ? config.symbols
    : [config.symbol || 'XAUUSD'];
  const symbols = Array.from(new Set(
    configuredSymbols
      .map((item: any) => String(item || '').trim().toUpperCase())
      .filter(Boolean)
  ));
  const allowedSymbols = symbols.filter(symbol => symbol === 'XAUUSD');
  const skippedSymbols = symbols.filter(symbol => symbol !== 'XAUUSD');

  if (allowedSymbols.length === 0) {
    throw new Error('贵金属行情更新未执行：当前只接入 XAUUSD，XAGUSD 等品种暂不可用');
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

async function executeTask(task: TaskRow, triggerType: 'manual' | 'schedule') {
  const db = await getDb();
  const startedAt = new Date().toISOString();
  const runResult = await db.run(
    `INSERT INTO task_center_runs (task_id, task_key, trigger_type, status, started_at)
     VALUES (?, ?, ?, 'running', ?)`,
    [task.id, task.task_key, triggerType, startedAt]
  );
  const runId = runResult.lastID;

  try {
    const config = parseConfig(task.config_json);
    let result: any;
    let message = '';

    if (task.task_type === 'finance_daily_pipeline') {
      result = await runFinanceDailyPipeline(config);
      const failedStep = result.steps.find((step: any) => step.status === 'error');
      message = failedStep
        ? `金融日终流水线失败：停在「${failedStep.label}」 - ${failedStep.message || '原因未知'}`
        : `金融日终流水线完成：${result.summary.success}/${result.summary.total} 步完成`;
      if (failedStep) {
        await db.run(
          `UPDATE task_center_runs
           SET status = 'error', message = ?, result_json = ?, finished_at = ?
           WHERE id = ?`,
          [message, JSON.stringify(result), new Date().toISOString(), runId]
        );
        await db.run(
          `UPDATE task_center_tasks
           SET last_status = 'error', last_message = ?, last_run_at = ?, updated_at = ?
           WHERE id = ?`,
          [message, new Date().toISOString(), new Date().toISOString(), task.id]
        );
        return { success: false, message, data: result };
      }
    } else if (task.task_type === 'finance_candidate_funnel_pipeline') {
      result = await runFinanceCandidateFunnelPipeline(config);
      const failedStep = result.steps.find((step: any) => step.status === 'error');
      message = failedStep
        ? `入池漏斗流水线失败：停在「${failedStep.label}」 - ${failedStep.message || '原因未知'}`
        : `入池漏斗流水线完成：${result.summary.success}/${result.summary.total} 步完成`;
      if (failedStep) {
        await db.run(
          `UPDATE task_center_runs
           SET status = 'error', message = ?, result_json = ?, finished_at = ?
           WHERE id = ?`,
          [message, JSON.stringify(result), new Date().toISOString(), runId]
        );
        await db.run(
          `UPDATE task_center_tasks
           SET last_status = 'error', last_message = ?, last_run_at = ?, updated_at = ?
           WHERE id = ?`,
          [message, new Date().toISOString(), new Date().toISOString(), task.id]
        );
        return { success: false, message, data: result };
      }
    } else if (task.task_type === 'daily_close_update') {
      const update = await callApi('/api/finance/asset-universe/daily-close-update', {
        source: config.source || 'tushare',
        active_plan_limit: Number(config.active_plan_limit || 50),
        candidate_limit: Number(config.candidate_limit || 20),
        universe_limit: config.universe_limit ?? 'all',
        interval_ms: Number(config.interval_ms || 1200)
      });
      const scan = await callApi('/api/finance/candidate-pool/scan-universe', {
        universe_type: 'all',
        source: config.source || 'tushare'
      });
      const suggestions = await callApi('/api/finance/trade-plans/sync-active-suggestions', {
        limit: Number(config.active_plan_limit || 50)
      });
      result = { update: update.data, scan: scan.data, suggestions: suggestions.data };
      message = `${update.message || '行情更新完成'}；${scan.message || '备选池刷新完成'}；${suggestions.message || '金融计划动作建议已同步'}`;
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
    } else {
      throw new Error(`任务执行器未接入：${task.task_key} / ${task.task_type}`);
    }

    await db.run(
      `UPDATE task_center_runs
       SET status = 'success', message = ?, result_json = ?, finished_at = ?
       WHERE id = ?`,
      [message, JSON.stringify(result), new Date().toISOString(), runId]
    );
    await db.run(
      `UPDATE task_center_tasks
       SET last_status = 'success', last_message = ?, last_run_at = ?, updated_at = ?
       WHERE id = ?`,
      [message, new Date().toISOString(), new Date().toISOString(), task.id]
    );
    lastRunByTaskDate.set(task.task_key, getDateKey());
    return { success: true, message, data: result };
  } catch (error) {
    const message = (error as Error).message;
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
       ORDER BY priority ASC, id ASC`
    );
    const now = new Date();
    for (const task of tasks) {
      if (isDue(task, now)) {
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

router.get('/task-center/tasks', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const tasks = await db.all(
      `SELECT * FROM task_center_tasks
       ORDER BY priority ASC, id ASC`
    );
    const runs = await db.all(
      `SELECT * FROM task_center_runs
       ORDER BY started_at DESC
       LIMIT 30`
    );
    res.json({ success: true, data: { tasks, runs } });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取任务中心失败: ${(error as Error).message}` });
  }
});

router.patch('/task-center/tasks/:id', async (req: Request, res: Response) => {
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

router.delete('/task-center/tasks/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const task = await db.get(`SELECT * FROM task_center_tasks WHERE id = ?`, [req.params.id]);
    if (!task) return res.status(404).json({ success: false, message: '任务不存在' });

    const running = await db.get(
      `SELECT id, started_at
       FROM task_center_runs
       WHERE task_id = ? AND status = 'running'
       ORDER BY started_at DESC, id DESC
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

    lastRunByTaskDate.delete(task.task_key);
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

router.post('/task-center/tasks/:id/run', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const task = await db.get(`SELECT * FROM task_center_tasks WHERE id = ?`, [req.params.id]);
    if (!task) return res.status(404).json({ success: false, message: '任务不存在' });

    const result = await executeTask(task, 'manual');
    res.status(result.success ? 200 : 500).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: `执行任务失败: ${(error as Error).message}` });
  }
});

export default router;
