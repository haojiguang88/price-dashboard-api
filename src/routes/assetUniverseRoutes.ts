import express, { Request, Response } from 'express';
import getDb from '../config/database';
import { exec, execFile } from 'child_process';
import path from 'path';

const router = express.Router();

const DEFAULT_MIN_FETCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

const autoUpdateState: {
  running: boolean;
  timer: NodeJS.Timeout | null;
  universe_type: string;
  source: string;
  interval_minutes: number;
  interval_seconds: number;
  limit_per_tick: number;
  processed_count: number;
  last_results: any[];
  started_at?: string;
  last_run_at?: string;
  last_message?: string;
} = {
  running: false,
  timer: null,
  universe_type: 'all',
  source: 'tushare',
  interval_minutes: 0.5,
  interval_seconds: 30,
  limit_per_tick: 5,
  processed_count: 0,
  last_results: []
};

type DailyCloseProgressEvent = {
  type: 'start' | 'finish';
  stage: string;
  stageLabel: string;
  index: number;
  total: number;
  item: UniverseItem;
  result?: any;
};

type DailyCloseUpdateState = {
  running: boolean;
  run_id: string | null;
  phase: string;
  phase_label: string;
  total_count: number;
  processed_count: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  current_symbol: string | null;
  current_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_updated_at: string | null;
  last_message: string;
  last_results: any[];
};

const dailyCloseUpdateState: DailyCloseUpdateState = {
  running: false,
  run_id: null,
  phase: 'idle',
  phase_label: '未运行',
  total_count: 0,
  processed_count: 0,
  success_count: 0,
  failed_count: 0,
  skipped_count: 0,
  current_symbol: null,
  current_name: null,
  started_at: null,
  finished_at: null,
  last_updated_at: null,
  last_message: '每日收盘更新未运行',
  last_results: []
};

interface UniverseItem {
  id: number;
  symbol: string;
  name: string;
  asset_type: string;
  universe_type: string;
  source: string;
  last_fetch_at?: string;
  update_status?: string;
}

interface ProcessAssetOptions {
  forceUpdate?: boolean;
  intervalMs?: number;
  staleUpdatingMinutes?: number;
  incremental?: boolean;
  lookbackDays?: number;
  progressStage?: string;
  progressStageLabel?: string;
  onProgress?: (event: DailyCloseProgressEvent) => void;
}

interface ProcessDueAssetsOptions extends ProcessAssetOptions {
  universeType: string;
  source: string;
  limit: number | null;
  excludeKeys?: Set<string>;
  preferMissingStock?: boolean;
  skipKnownInsufficient?: boolean;
  onItemsSelected?: (items: UniverseItem[]) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseScriptJson(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const parse = (text: string) => JSON.parse(text.replace(/\bNaN\b/g, 'null'));

  try {
    return parse(trimmed);
  } catch {
    const jsonStart = trimmed.indexOf('{');
    const jsonEnd = trimmed.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        return parse(trimmed.slice(jsonStart, jsonEnd + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseUniverseLimit(value: any, defaultLimit: number | null = null): number | null {
  if (value === undefined || value === null || value === '' || value === 'all') {
    return defaultLimit;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.floor(numeric);
}

function getDailyCloseProgressPercent() {
  if (dailyCloseUpdateState.total_count <= 0) {
    return dailyCloseUpdateState.running ? 3 : 100;
  }
  const raw = (dailyCloseUpdateState.processed_count / dailyCloseUpdateState.total_count) * 100;
  if (dailyCloseUpdateState.running) return Math.min(99, Math.max(1, Math.round(raw)));
  return Math.min(100, Math.max(0, Math.round(raw)));
}

function resetDailyCloseUpdateState(runId: string) {
  Object.assign(dailyCloseUpdateState, {
    running: true,
    run_id: runId,
    phase: 'preparing',
    phase_label: '准备更新',
    total_count: 0,
    processed_count: 0,
    success_count: 0,
    failed_count: 0,
    skipped_count: 0,
    current_symbol: null,
    current_name: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    last_updated_at: new Date().toISOString(),
    last_message: '正在统计需要更新的标的...',
    last_results: []
  });
}

function applyDailyCloseProgress(event: DailyCloseProgressEvent) {
  dailyCloseUpdateState.phase = event.stage;
  dailyCloseUpdateState.phase_label = event.stageLabel;
  dailyCloseUpdateState.current_symbol = event.item.symbol;
  dailyCloseUpdateState.current_name = event.item.name || null;
  dailyCloseUpdateState.last_updated_at = new Date().toISOString();

  if (event.type === 'start') {
    dailyCloseUpdateState.last_message = `${event.stageLabel}：正在更新 ${event.item.symbol} ${event.item.name || ''}`.trim();
    return;
  }

  dailyCloseUpdateState.processed_count += 1;
  if (event.result?.skipped) dailyCloseUpdateState.skipped_count += 1;
  else if (event.result?.success) dailyCloseUpdateState.success_count += 1;
  else dailyCloseUpdateState.failed_count += 1;
  dailyCloseUpdateState.last_message = `${event.stageLabel}：${event.item.symbol} ${event.result?.message || '处理完成'}`;
  dailyCloseUpdateState.last_results = [{
    symbol: event.item.symbol,
    name: event.item.name,
    stage: event.stage,
    stage_label: event.stageLabel,
    status: event.result?.skipped ? 'skipped' : event.result?.success ? 'success' : 'error',
    message: event.result?.message || '',
    at: new Date().toISOString()
  }, ...dailyCloseUpdateState.last_results].slice(0, 20);
}

function publicDailyCloseUpdateState() {
  return {
    ...dailyCloseUpdateState,
    percent: getDailyCloseProgressPercent()
  };
}

function buildScriptErrorMessage(defaultMessage: string, stdout: string, stderr: string, error?: Error | null) {
  const parts = [stderr, stdout, error?.message || '']
    .map(part => part.trim())
    .filter(Boolean);

  if (!parts.length) return defaultMessage;
  return `${defaultMessage}：${parts.join(' | ').slice(0, 500)}`;
}

function shiftIsoDate(value: string | null | undefined, offsetDays: number) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function resolveIncrementalStartDate(db: any, item: UniverseItem, lookbackDays: number) {
  const latest = await db.get(
    `SELECT MAX(trade_date) as last_trade_date
     FROM financial_daily_prices
     WHERE symbol = ?
       AND asset_type = ?
       AND source = ?`,
    [item.symbol, item.asset_type, item.source]
  );
  const lastTradeDate = latest?.last_trade_date || null;
  return shiftIsoDate(lastTradeDate, -Math.max(lookbackDays, 0));
}

async function refreshUniverseStatus(db: any, id?: number) {
  const items = id
    ? await db.all(`SELECT id, symbol, source FROM financial_asset_universe WHERE id = ?`, [id])
    : await db.all(`SELECT id, symbol, source FROM financial_asset_universe`);

  for (const item of items) {
    const status = await db.get(
      `SELECT
         COUNT(*) as total_count,
         MIN(trade_date) as first_trade_date,
         MAX(trade_date) as last_trade_date,
         MAX(updated_at) as last_updated
       FROM financial_daily_prices
       WHERE symbol = ? AND source = ?`,
      [item.symbol, item.source]
    );

    await db.run(
      `UPDATE financial_asset_universe
       SET total_count = ?,
           first_trade_date = ?,
           last_trade_date = ?,
           last_updated = ?,
           local_data_ready = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        status?.total_count || 0,
        status?.first_trade_date || null,
        status?.last_trade_date || null,
        status?.last_updated || null,
        (status?.total_count || 0) >= 120 ? 1 : 0,
        new Date().toISOString(),
        item.id
      ]
    );
  }
}

async function refreshUniverseStatusForItem(db: any, item: UniverseItem) {
  const status = await db.get(
    `SELECT
       COUNT(*) as total_count,
       MIN(trade_date) as first_trade_date,
       MAX(trade_date) as last_trade_date,
       MAX(updated_at) as last_updated
     FROM financial_daily_prices
     WHERE symbol = ? AND asset_type = ? AND source = ?`,
    [item.symbol, item.asset_type, item.source]
  );

  await db.run(
    `UPDATE financial_asset_universe
     SET total_count = ?,
         first_trade_date = ?,
         last_trade_date = ?,
         last_updated = ?,
         local_data_ready = ?,
         updated_at = ?
     WHERE symbol = ? AND asset_type = ? AND source = ?`,
    [
      status?.total_count || 0,
      status?.first_trade_date || null,
      status?.last_trade_date || null,
      status?.last_updated || null,
      (status?.total_count || 0) >= 120 ? 1 : 0,
      new Date().toISOString(),
      item.symbol,
      item.asset_type,
      item.source
    ]
  );
}

async function updateUniverseRows(db: any, item: UniverseItem, setSql: string, params: any[]) {
  await db.run(
    `UPDATE financial_asset_universe
     SET ${setSql}
     WHERE symbol = ? AND asset_type = ? AND source = ?`,
    [...params, item.symbol, item.asset_type, item.source]
  );
}

async function fetchAssetDaily(symbol: string, assetType: string, source: string, startDate?: string | null, endDate?: string | null) {
  const scriptPath = path.join(__dirname, '../../scripts/finance/fetch_asset_daily.py');

  return new Promise<any>((resolve) => {
    const args = [scriptPath, symbol, assetType, '--source', source];
    if (startDate) args.push('--start-date', startDate);
    if (endDate) args.push('--end-date', endDate);

    execFile('/usr/bin/python3', args, { timeout: 120000 }, (error, stdout, stderr) => {
      const parsed = parseScriptJson(stdout);
      if (parsed) {
        resolve(parsed);
        return;
      }

      if (error) {
        resolve({ success: false, message: buildScriptErrorMessage('数据脚本执行失败', stdout, stderr, error) });
        return;
      }

      resolve({ success: false, message: buildScriptErrorMessage('数据脚本返回内容无法解析', stdout, stderr) });
    });
  });
}

async function fetchAssetUniverseList(includeStock: boolean, includeEtf: boolean) {
  const scriptPath = path.join(__dirname, '../../scripts/finance/fetch_asset_universe.py');
  const flags = [
    includeStock ? '--stocks' : '',
    includeEtf ? '--etfs' : ''
  ].filter(Boolean).join(' ');

  return new Promise<any>((resolve) => {
    exec(`/usr/bin/python3 "${scriptPath}" ${flags}`, { timeout: 120000 }, (error, stdout, stderr) => {
      const parsed = parseScriptJson(stdout);
      if (parsed) {
        resolve(parsed);
        return;
      }

      if (error) {
        resolve({ success: false, message: buildScriptErrorMessage('资产清单脚本执行失败', stdout, stderr, error) });
        return;
      }

      resolve({ success: false, message: buildScriptErrorMessage('资产清单脚本返回内容无法解析', stdout, stderr) });
    });
  });
}

async function persistDailyPrices(db: any, item: UniverseItem, data: any) {
  let insertedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const price of data.items || []) {
    const close = Number(price.close);
    if (!price.trade_date || !Number.isFinite(close)) {
      skippedCount++;
      continue;
    }

    const existing = await db.get(
      `SELECT 1 FROM financial_daily_prices WHERE symbol = ? AND trade_date = ? AND source = ?`,
      [item.symbol, price.trade_date, item.source]
    );

    await db.run(
      `INSERT OR REPLACE INTO financial_daily_prices
       (symbol, name, market, asset_type, trade_date, open, high, low, close, volume, amount, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.symbol,
        data.name || item.name || '',
        'cn',
        item.asset_type,
        price.trade_date,
        Number.isFinite(Number(price.open)) ? Number(price.open) : null,
        Number.isFinite(Number(price.high)) ? Number(price.high) : null,
        Number.isFinite(Number(price.low)) ? Number(price.low) : null,
        close,
        Number.isFinite(Number(price.volume)) ? Number(price.volume) : null,
        Number.isFinite(Number(price.amount)) ? Number(price.amount) : null,
        item.source,
        new Date().toISOString()
      ]
    );

    if (existing) updatedCount++;
    else insertedCount++;
  }

  return { insertedCount, updatedCount, skippedCount };
}

async function processAssetList(db: any, items: UniverseItem[], options: ProcessAssetOptions = {}) {
  const results: any[] = [];
  const progressStage = options.progressStage || 'asset_update';
  const progressStageLabel = options.progressStageLabel || '资产更新';

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const now = new Date();
    options.onProgress?.({
      type: 'start',
      stage: progressStage,
      stageLabel: progressStageLabel,
      index,
      total: items.length,
      item
    });

    if (!options.forceUpdate && item.last_fetch_at) {
      const lastFetchTime = new Date(item.last_fetch_at).getTime();
      if (Number.isFinite(lastFetchTime) && now.getTime() - lastFetchTime < DEFAULT_MIN_FETCH_INTERVAL_MS) {
        const skippedResult = {
          symbol: item.symbol,
          skipped: true,
          message: '距离上次请求不足6小时，跳过以保护数据源频率'
        };
        results.push(skippedResult);
        options.onProgress?.({
          type: 'finish',
          stage: progressStage,
          stageLabel: progressStageLabel,
          index,
          total: items.length,
          item,
          result: skippedResult
        });
        continue;
      }
    }

    await updateUniverseRows(
      db,
      item,
      `update_status = 'updating', last_fetch_at = ?, updated_at = ?`,
      [now.toISOString(), now.toISOString()]
    );

    const fetchStartDate = options.incremental
      ? await resolveIncrementalStartDate(db, item, options.lookbackDays ?? 10)
      : null;
    const fetchModeLabel = fetchStartDate ? `增量拉取 ${fetchStartDate} 起` : '全量拉取';
    const data = await fetchAssetDaily(item.symbol, item.asset_type, item.source, fetchStartDate);

    if (!data.success) {
      const emptyDataMessage = data.message || '请求数据源失败';
      if (/为空|无数据|no data|empty/i.test(emptyDataMessage)) {
        await updateUniverseRows(
          db,
          item,
          `update_status = 'success', last_fetch_message = ?, updated_at = ?`,
          [`${fetchModeLabel}：无新增行情，可能停牌或数据源暂未更新`, new Date().toISOString()]
        );
        const emptyResult = {
          symbol: item.symbol,
          success: true,
          noNewData: true,
          insertedCount: 0,
          updatedCount: 0,
          skippedCount: 0,
          fetchMode: fetchStartDate ? 'incremental' : 'full',
          fetchStartDate,
          message: `${fetchModeLabel}：无新增行情，可能停牌或数据源暂未更新`
        };
        results.push(emptyResult);
        options.onProgress?.({
          type: 'finish',
          stage: progressStage,
          stageLabel: progressStageLabel,
          index,
          total: items.length,
          item,
          result: emptyResult
        });
        continue;
      }

      await updateUniverseRows(
        db,
        item,
        `update_status = 'error', last_fetch_message = ?, updated_at = ?`,
        [`${fetchModeLabel}：${data.message || '请求数据源失败'}`, new Date().toISOString()]
      );
      const failedResult = {
        symbol: item.symbol,
        success: false,
        fetchMode: fetchStartDate ? 'incremental' : 'full',
        fetchStartDate,
        message: `${fetchModeLabel}：${data.message || '请求数据源失败'}`
      };
      results.push(failedResult);
      options.onProgress?.({
        type: 'finish',
        stage: progressStage,
        stageLabel: progressStageLabel,
        index,
        total: items.length,
        item,
        result: failedResult
      });
    } else {
      const saved = await persistDailyPrices(db, item, data);
      await updateUniverseRows(
        db,
        item,
        `name = COALESCE(NULLIF(?, ''), name),
         update_status = 'success',
         last_fetch_message = ?,
         updated_at = ?`,
        [
          data.name || '',
          saved.insertedCount > 0
            ? `${fetchModeLabel}：已存本地，新增 ${saved.insertedCount} 条，更新 ${saved.updatedCount} 条，跳过异常 ${saved.skippedCount || 0} 条`
            : `${fetchModeLabel}：无新增行情，可能停牌或当日数据已存在，更新 ${saved.updatedCount} 条，跳过异常 ${saved.skippedCount || 0} 条`,
          new Date().toISOString()
        ]
      );
      await refreshUniverseStatusForItem(db, item);
      const successResult = {
        symbol: item.symbol,
        success: true,
        noNewData: saved.insertedCount === 0,
        fetchMode: fetchStartDate ? 'incremental' : 'full',
        fetchStartDate,
        message: saved.insertedCount === 0 ? `${fetchModeLabel}：无新增行情，可能停牌或当日数据已存在` : `${fetchModeLabel}：已存本地`,
        ...saved
      };
      results.push(successResult);
      options.onProgress?.({
        type: 'finish',
        stage: progressStage,
        stageLabel: progressStageLabel,
        index,
        total: items.length,
        item,
        result: successResult
      });
    }

    if (options.intervalMs && index < items.length - 1) {
      await sleep(options.intervalMs);
    }
  }

  return results;
}

async function processDueAssets(options: ProcessDueAssetsOptions) {
  const db = await getDb();
  const params: any[] = [options.source];
  let where = 'WHERE enabled = 1 AND source = ?';

  await db.run(
    `UPDATE financial_asset_universe
     SET update_status = 'pending',
         last_fetch_message = '上次更新中断，已释放为待处理',
         updated_at = ?
     WHERE update_status = 'updating'
       AND datetime(updated_at) <= datetime('now', '-30 minutes')`,
    [new Date().toISOString()]
  );

  if (options.universeType && options.universeType !== 'all') {
    where += ' AND universe_type = ?';
    params.push(options.universeType);
  }

  if (!options.forceUpdate) {
    where += ` AND (last_fetch_at IS NULL OR datetime(last_fetch_at) <= datetime('now', '-6 hours'))`;
  }

  if (options.skipKnownInsufficient) {
    where += `
      AND NOT (
        local_data_ready = 0
        AND update_status = 'success'
        AND COALESCE(total_count, 0) > 0
        AND COALESCE(total_count, 0) < 120
      )`;
  }

  if (options.excludeKeys?.size) {
    const excluded = Array.from(options.excludeKeys);
    where += ` AND (symbol || '|' || asset_type || '|' || source) NOT IN (${excluded.map(() => '?').join(',')})`;
    params.push(...excluded);
  }

  const orderBy = options.preferMissingStock
    ? `ORDER BY
       CASE WHEN local_data_ready = 1 THEN 1 ELSE 0 END,
       CASE WHEN asset_type = 'stock' THEN 0 WHEN asset_type = 'etf' THEN 1 ELSE 2 END,
       CASE WHEN COALESCE(total_count, 0) = 0 THEN 0 ELSE 1 END,
       CASE WHEN update_status = 'error' THEN 1 ELSE 0 END,
       COALESCE(last_fetch_at, ''),
       COALESCE(total_count, 0) ASC,
       symbol`
    : `ORDER BY
       CASE WHEN local_data_ready = 1 THEN 1 ELSE 0 END,
       CASE WHEN update_status = 'error' THEN 1 ELSE 0 END,
       COALESCE(total_count, 0) DESC,
       COALESCE(last_fetch_at, ''),
       symbol`;

  const fetchLimit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : null;
  const limitSql = fetchLimit ? 'LIMIT ?' : '';
  if (fetchLimit) params.push(fetchLimit);

  const items: UniverseItem[] = await db.all(
    `WITH grouped AS (
       SELECT
         MIN(id) as id,
         symbol,
         MAX(name) as name,
         asset_type,
         GROUP_CONCAT(DISTINCT universe_type) as universe_type,
         source,
         MAX(last_fetch_at) as last_fetch_at,
         CASE
           WHEN SUM(CASE WHEN update_status = 'updating' THEN 1 ELSE 0 END) > 0 THEN 'updating'
           WHEN SUM(CASE WHEN update_status = 'error' THEN 1 ELSE 0 END) > 0 THEN 'error'
           WHEN SUM(CASE WHEN update_status = 'success' THEN 1 ELSE 0 END) > 0 THEN 'success'
           ELSE 'pending'
         END as update_status,
         MAX(total_count) as total_count,
         MAX(local_data_ready) as local_data_ready
       FROM financial_asset_universe
       ${where}
       GROUP BY symbol, asset_type, source
     )
     SELECT *
     FROM grouped
     ${orderBy}
     ${limitSql}`,
    params
  );

  options.onItemsSelected?.(items);
  const results = await processAssetList(db, items, options);

  return { processed_count: items.length, results };
}

async function runFullUniverseDailyCloseUpdate(params: {
  source: string;
  universeLimit: number | null;
  intervalMs: number;
  excludeKeys: Set<string>;
}) {
  try {
    dailyCloseUpdateState.phase = 'full_universe';
    dailyCloseUpdateState.phase_label = '全市场补齐';
    dailyCloseUpdateState.last_updated_at = new Date().toISOString();
    dailyCloseUpdateState.last_message = '优先标的已更新，正在后台补齐全市场日线...';

    await processDueAssets({
      universeType: 'all',
      source: params.source,
      limit: params.universeLimit,
      forceUpdate: true,
      intervalMs: params.intervalMs,
      incremental: true,
      lookbackDays: 10,
      excludeKeys: params.excludeKeys,
      progressStage: 'full_universe',
      progressStageLabel: '全市场补齐',
      onProgress: applyDailyCloseProgress,
      onItemsSelected: (items) => {
        dailyCloseUpdateState.total_count += items.length;
        dailyCloseUpdateState.phase = 'full_universe';
        dailyCloseUpdateState.phase_label = '全市场补齐';
        dailyCloseUpdateState.last_updated_at = new Date().toISOString();
        dailyCloseUpdateState.last_message = `全市场补齐队列 ${items.length} 个，总计 ${dailyCloseUpdateState.total_count} 个标的。`;
      }
    });

    dailyCloseUpdateState.running = false;
    dailyCloseUpdateState.phase = 'completed';
    dailyCloseUpdateState.phase_label = '行情更新完成';
    dailyCloseUpdateState.finished_at = new Date().toISOString();
    dailyCloseUpdateState.last_updated_at = dailyCloseUpdateState.finished_at;
    dailyCloseUpdateState.current_symbol = null;
    dailyCloseUpdateState.current_name = null;
    dailyCloseUpdateState.last_message = `每日收盘行情更新完成：成功 ${dailyCloseUpdateState.success_count} 个，失败 ${dailyCloseUpdateState.failed_count} 个，准备刷新备选池。`;
  } catch (error) {
    dailyCloseUpdateState.running = false;
    dailyCloseUpdateState.phase = 'error';
    dailyCloseUpdateState.phase_label = '更新失败';
    dailyCloseUpdateState.finished_at = new Date().toISOString();
    dailyCloseUpdateState.last_updated_at = dailyCloseUpdateState.finished_at;
    dailyCloseUpdateState.last_message = `全市场日线补齐失败: ${(error as Error).message}`;
  }
}

router.get('/asset-universe', async (req: Request, res: Response) => {
  try {
    const db = await getDb();

    const universeType = req.query.universe_type as string | undefined;
    const assetType = req.query.asset_type as string | undefined;
    const status = req.query.update_status as string | undefined;
    const q = String(req.query.q || '').trim();
    const page = Math.max(Number(req.query.page || 1), 1);
    const pageSize = Math.min(Math.max(Number(req.query.page_size || 20), 10), 100);
    const offset = (page - 1) * pageSize;
    const sortKey = String(req.query.sort_key || 'symbol');
    const sortDirection = String(req.query.sort_direction || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const sortColumns: Record<string, string> = {
      symbol: 'symbol',
      name: 'name',
      universe_type: 'universe_type',
      asset_type: 'asset_type',
      total_count: 'total_count',
      date_range: 'last_trade_date',
      update_status: 'update_status',
      last_fetch_at: 'last_fetch_at'
    };
    const sortColumn = sortColumns[sortKey] || 'symbol';

    const params: any[] = [];
    const where: string[] = [];

    if (universeType && universeType !== 'all') {
      where.push('universe_type = ?');
      params.push(universeType);
    }

    if (assetType) {
      where.push('asset_type = ?');
      params.push(assetType);
    }

    if (status) {
      where.push('update_status = ?');
      params.push(status);
    }

    if (q) {
      where.push('(symbol LIKE ? OR name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const groupedSql = `
      WITH grouped AS (
        SELECT
           MIN(id) as id,
           symbol,
           MAX(name) as name,
           asset_type,
           GROUP_CONCAT(DISTINCT universe_type) as universe_type,
           source,
           MAX(enabled) as enabled,
           CASE
             WHEN SUM(CASE WHEN update_status = 'updating' THEN 1 ELSE 0 END) > 0 THEN 'updating'
             WHEN SUM(CASE WHEN update_status = 'error' THEN 1 ELSE 0 END) > 0 THEN 'error'
             WHEN SUM(CASE WHEN update_status = 'success' THEN 1 ELSE 0 END) > 0 THEN 'success'
             ELSE 'pending'
           END as update_status,
           MAX(total_count) as total_count,
           MIN(first_trade_date) as first_trade_date,
           MAX(last_trade_date) as last_trade_date,
           MAX(last_updated) as last_updated,
           MAX(last_fetch_at) as last_fetch_at,
           MAX(last_fetch_message) as last_fetch_message,
           MAX(local_data_ready) as local_data_ready
         FROM financial_asset_universe
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         GROUP BY symbol, asset_type, source
      )
    `;

    const totalRow = await db.get(
      `${groupedSql}
       SELECT COUNT(*) AS total
       FROM grouped`,
      params
    );

    const rows = await db.all(
      `${groupedSql}
       SELECT *
       FROM grouped
       ORDER BY ${sortColumn} ${sortDirection}, symbol ASC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const summary = await db.all(
      `SELECT universe_type, asset_type, COUNT(*) as total,
              SUM(CASE WHEN local_data_ready = 1 THEN 1 ELSE 0 END) as ready_count,
              SUM(CASE WHEN update_status = 'updating' THEN 1 ELSE 0 END) as updating_count,
              SUM(CASE WHEN update_status = 'error' THEN 1 ELSE 0 END) as error_count
       FROM financial_asset_universe
       GROUP BY universe_type, asset_type
       ORDER BY universe_type, asset_type`
    );

    const coverageWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const coverage = await db.get(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN local_data_ready = 1 THEN 1 ELSE 0 END) as completed_count,
         SUM(CASE
           WHEN local_data_ready = 0
            AND update_status != 'updating'
            AND (last_fetch_at IS NULL OR datetime(last_fetch_at) <= datetime('now', '-6 hours'))
            AND NOT (
              update_status = 'success'
              AND COALESCE(total_count, 0) > 0
              AND COALESCE(total_count, 0) < 120
            )
           THEN 1 ELSE 0 END) as processable_count,
         SUM(CASE
           WHEN local_data_ready = 0
            AND update_status != 'updating'
            AND last_fetch_at IS NOT NULL
            AND datetime(last_fetch_at) > datetime('now', '-6 hours')
            AND NOT (
              update_status = 'success'
              AND COALESCE(total_count, 0) > 0
              AND COALESCE(total_count, 0) < 120
            )
           THEN 1 ELSE 0 END) as cooling_count,
         SUM(CASE
           WHEN local_data_ready = 0
            AND update_status = 'success'
            AND COALESCE(total_count, 0) > 0
            AND COALESCE(total_count, 0) < 120
           THEN 1 ELSE 0 END) as insufficient_count,
         SUM(CASE WHEN update_status = 'updating' THEN 1 ELSE 0 END) as updating_count,
         SUM(CASE WHEN update_status = 'error' THEN 1 ELSE 0 END) as error_count
       FROM financial_asset_universe
       ${coverageWhere}`,
      params
    );

    res.json({
      success: true,
      data: {
        items: rows,
        summary,
        coverage,
        pagination: {
          page,
          page_size: pageSize,
          total: Number(totalRow?.total || 0),
          total_pages: Math.ceil(Number(totalRow?.total || 0) / pageSize)
        },
        sort: {
          sort_key: sortKey,
          sort_direction: sortDirection.toLowerCase()
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取资产库失败: ${(error as Error).message}` });
  }
});

router.get('/asset-universe/detail', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = String(req.query.symbol || '').trim();
    const assetType = String(req.query.asset_type || '').trim();
    const source = String(req.query.source || 'tushare').trim();

    if (!symbol || !assetType) {
      return res.status(400).json({ success: false, message: 'symbol and asset_type are required' });
    }

    const universeRows = await db.all(
      `SELECT *
       FROM financial_asset_universe
       WHERE symbol = ? AND asset_type = ? AND source = ?
       ORDER BY universe_type`,
      [symbol, assetType, source]
    );

    if (!universeRows.length) {
      return res.status(404).json({ success: false, message: '资产库标的不存在' });
    }

    const dailyStats = await db.get(
      `SELECT
         COUNT(*) as total_count,
         MIN(trade_date) as first_trade_date,
         MAX(trade_date) as last_trade_date,
         MAX(updated_at) as last_updated,
         AVG(amount) as avg_amount,
         AVG(CASE WHEN trade_date >= date((SELECT MAX(trade_date) FROM financial_daily_prices WHERE symbol = ? AND asset_type = ? AND source = ?), '-30 day') THEN amount ELSE NULL END) as avg_amount_recent
       FROM financial_daily_prices
       WHERE symbol = ? AND asset_type = ? AND source = ?`,
      [symbol, assetType, source, symbol, assetType, source]
    );

    const latestPrice = await db.get(
      `SELECT trade_date, open, high, low, close, volume, amount, updated_at
       FROM financial_daily_prices
       WHERE symbol = ? AND asset_type = ? AND source = ?
       ORDER BY trade_date DESC
       LIMIT 1`,
      [symbol, assetType, source]
    );

    const recentPrices = await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount
       FROM financial_daily_prices
       WHERE symbol = ? AND asset_type = ? AND source = ?
       ORDER BY trade_date DESC
       LIMIT 20`,
      [symbol, assetType, source]
    );

    const stockBasic = assetType === 'stock'
      ? await db.get(
          `SELECT trade_date, total_mv_yuan, circ_mv_yuan, turnover_rate, pe, pb, updated_at
           FROM financial_stock_basic_metrics
           WHERE symbol = ? AND source = ?
           ORDER BY trade_date DESC
           LIMIT 1`,
          [symbol, source]
        ).catch(() => null)
      : null;

    const candidate = await db.get(
      `SELECT pool_status, priority, priority_score, candidate_reason, forbidden_reason, downgrade_reason, last_checked_at
       FROM financial_candidate_pool
       WHERE symbol = ? AND asset_type = ? AND source = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [symbol, assetType, source]
    ).catch(() => null);

    const trendPhase = await db.get(
      `SELECT trend_phase_code, trend_phase_reason, trade_date, updated_at
       FROM financial_trend_phase_results
       WHERE symbol = ? AND asset_type = ? AND source = ?
       ORDER BY trade_date DESC
       LIMIT 1`,
      [symbol, assetType, source]
    ).catch(() => null);

    const firstRow = universeRows[0];
    const fetchTimes = universeRows.map((row: any) => row.last_fetch_at).filter(Boolean).sort();
    const fetchMessages = universeRows.map((row: any) => row.last_fetch_message).filter(Boolean);

    res.json({
      success: true,
      data: {
        asset: {
          id: firstRow.id,
          symbol,
          name: firstRow.name,
          asset_type: assetType,
          source,
          universe_types: universeRows.map((row: any) => row.universe_type),
          universe_type: universeRows.map((row: any) => row.universe_type).join(','),
          enabled: Math.max(...universeRows.map((row: any) => Number(row.enabled || 0))),
          update_status: universeRows.some((row: any) => row.update_status === 'updating')
            ? 'updating'
            : universeRows.some((row: any) => row.update_status === 'error')
              ? 'error'
              : universeRows.some((row: any) => row.update_status === 'success')
                ? 'success'
                : 'pending',
          total_count: dailyStats?.total_count || 0,
          first_trade_date: dailyStats?.first_trade_date || null,
          last_trade_date: dailyStats?.last_trade_date || null,
          last_updated: dailyStats?.last_updated || null,
          local_data_ready: (dailyStats?.total_count || 0) >= 120 ? 1 : 0,
          last_fetch_at: fetchTimes.length ? fetchTimes[fetchTimes.length - 1] : null,
          last_fetch_message: fetchMessages.length ? fetchMessages[fetchMessages.length - 1] : null,
        },
        daily_stats: dailyStats || null,
        latest_price: latestPrice || null,
        recent_prices: recentPrices,
        stock_basic: stockBasic || null,
        candidate: candidate || null,
        trend_phase: trendPhase || null,
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取资产详情失败: ${(error as Error).message}` });
  }
});

router.post('/asset-universe/batch-update', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const universeType = req.body.universe_type;
    const source = req.body.source || 'tushare';
    const limit = Math.min(Number(req.body.limit || 3), 20);
    const intervalMs = Math.max(Number(req.body.interval_ms || 3000), 1500);
    const forceUpdate = req.body.force_update === true;

    const result = await processDueAssets({
      universeType,
      source,
      limit,
      forceUpdate,
      intervalMs,
      preferMissingStock: !forceUpdate,
      skipKnownInsufficient: !forceUpdate
    });

    res.json({
      success: true,
      message: `批量更新完成，本次处理 ${result.processed_count} 个标的`,
      data: result
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `批量更新失败: ${(error as Error).message}` });
  }
});

router.post('/asset-universe/update-one', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = String(req.body.symbol || '').trim();
    const assetType = String(req.body.asset_type || req.body.assetType || '').trim();
    const source = String(req.body.source || 'tushare').trim();

    if (!/^\d{6}$/.test(symbol)) {
      return res.status(400).json({ success: false, message: '请输入6位标的代码' });
    }
    if (!['stock', 'etf', 'index'].includes(assetType)) {
      return res.status(400).json({ success: false, message: '资产类型必须是 stock、etf 或 index' });
    }
    if (!['tushare', 'akshare'].includes(source)) {
      return res.status(400).json({ success: false, message: '数据源必须是 tushare 或 akshare' });
    }

    let item: UniverseItem | undefined = await db.get(
      `SELECT
         MIN(id) as id,
         symbol,
         COALESCE(MAX(name), '') as name,
         asset_type,
         GROUP_CONCAT(DISTINCT universe_type) as universe_type,
         source,
         MAX(last_fetch_at) as last_fetch_at,
         CASE
           WHEN SUM(CASE WHEN update_status = 'updating' THEN 1 ELSE 0 END) > 0 THEN 'updating'
           WHEN SUM(CASE WHEN update_status = 'error' THEN 1 ELSE 0 END) > 0 THEN 'error'
           WHEN SUM(CASE WHEN update_status = 'success' THEN 1 ELSE 0 END) > 0 THEN 'success'
           ELSE 'pending'
         END as update_status
       FROM financial_asset_universe
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND enabled = 1
       GROUP BY symbol, asset_type, source`,
      [symbol, assetType, source]
    );

    if (!item) {
      await db.run(
        `INSERT OR IGNORE INTO financial_asset_universe
         (symbol, name, asset_type, universe_type, source, update_status)
         VALUES (?, '', ?, 'manual_watch', ?, 'pending')`,
        [symbol, assetType, source]
      );
      item = await db.get(
        `SELECT id, symbol, COALESCE(name, '') as name, asset_type, universe_type, source, last_fetch_at, update_status
         FROM financial_asset_universe
         WHERE symbol = ?
           AND asset_type = ?
           AND source = ?
         ORDER BY id DESC
         LIMIT 1`,
        [symbol, assetType, source]
      );
    }

    if (!item) {
      return res.status(500).json({ success: false, message: `${symbol} 未能加入资产库，无法补齐日线` });
    }

    const results = await processAssetList(db, [item], { forceUpdate: true, incremental: true, lookbackDays: 10 });
    const result = results[0] as any;
    const latest = await db.get(
      `SELECT COUNT(*) as total_count, MAX(trade_date) as last_trade_date
       FROM financial_daily_prices
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?`,
      [symbol, assetType, source]
    );

    if (!result?.success) {
      return res.status(500).json({
        success: false,
        message: `${symbol} 日线补齐失败：${result?.message || '数据源请求失败'}`,
        data: { result, latest }
      });
    }

    const insertedCount = result.insertedCount || 0;
    const updatedCount = result.updatedCount || 0;
    res.json({
      success: true,
      message: `${symbol} 日线补齐完成：${result.fetchStartDate ? `增量拉取 ${result.fetchStartDate} 起，` : '全量拉取，'}新增 ${insertedCount} 条，更新 ${updatedCount} 条，本地最新 ${latest?.last_trade_date || '--'}`,
      data: {
        result,
        total_count: latest?.total_count || 0,
        last_trade_date: latest?.last_trade_date || null
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `单标的日线补齐失败: ${(error as Error).message}` });
  }
});

router.get('/asset-universe/daily-close-update/status', async (_req: Request, res: Response) => {
  res.json({ success: true, data: publicDailyCloseUpdateState() });
});

router.post('/asset-universe/daily-close-update', async (req: Request, res: Response) => {
  if (dailyCloseUpdateState.running) {
    return res.status(409).json({
      success: false,
      message: '每日收盘更新正在运行，请等待当前任务完成',
      data: publicDailyCloseUpdateState()
    });
  }

  const runId = `${Date.now()}`;
  resetDailyCloseUpdateState(runId);

  try {
    const db = await getDb();
    const source = req.body.source || 'tushare';
    const activePlanLimit = Math.max(Math.min(Number(req.body.active_plan_limit || 50), 200), 1);
    const candidateLimit = Math.max(Math.min(Number(req.body.candidate_limit || 20), 100), 1);
    const universeLimit = parseUniverseLimit(req.body.universe_limit, null);
    const intervalMs = Math.max(Number(req.body.interval_ms || 1500), 800);

    const activePlanItems: UniverseItem[] = await db.all(
      `SELECT
         COALESCE(MIN(u.id), 0) as id,
         p.symbol,
         COALESCE(MAX(u.name), MAX(p.name), '') as name,
         p.asset_type,
         COALESCE(MAX(u.universe_type), 'financial_position') as universe_type,
         p.source,
         MAX(u.last_fetch_at) as last_fetch_at
       FROM financial_trade_plans p
       LEFT JOIN financial_asset_universe u
         ON u.symbol = p.symbol
        AND u.asset_type = p.asset_type
        AND u.source = p.source
       WHERE p.is_deleted = 0
         AND p.source = ?
         AND (p.is_bought = 1 OR p.status IN ('active', 'paper_tracking'))
       GROUP BY p.symbol, p.asset_type, p.source
       ORDER BY MAX(p.updated_at) DESC, p.symbol
       LIMIT ?`,
      [source, activePlanLimit]
    );

    const activePlanKeys = new Set(activePlanItems.map(item => `${item.symbol}|${item.asset_type}|${item.source}`));
    const candidateItems: UniverseItem[] = await db.all(
      `SELECT
         MIN(u.id) as id,
         c.symbol,
         COALESCE(MAX(u.name), MAX(c.name), '') as name,
         c.asset_type,
         COALESCE(MAX(u.universe_type), 'candidate_pool') as universe_type,
         c.source,
         MAX(u.last_fetch_at) as last_fetch_at
       FROM financial_candidate_pool c
       JOIN financial_asset_universe u
         ON u.symbol = c.symbol
        AND u.asset_type = c.asset_type
        AND u.source = c.source
       WHERE c.pool_status = 'active'
         AND c.source = ?
         AND u.enabled = 1
         AND NOT EXISTS (
           SELECT 1 FROM financial_trade_plans p
           WHERE p.is_deleted = 0
             AND p.symbol = c.symbol
             AND p.asset_type = c.asset_type
             AND p.source = c.source
             AND (p.is_bought = 1 OR p.status IN ('active', 'paper_tracking'))
         )
       GROUP BY c.symbol, c.asset_type, c.source
       ORDER BY MAX(c.priority = 'high') DESC, MAX(c.last_checked_at) DESC, c.symbol
       LIMIT ?`,
      [source, candidateLimit]
    );

    const candidateKeys = new Set([...activePlanKeys, ...candidateItems.map(item => `${item.symbol}|${item.asset_type}|${item.source}`)]);
    dailyCloseUpdateState.total_count = activePlanItems.length + candidateItems.length;
    dailyCloseUpdateState.last_updated_at = new Date().toISOString();
    dailyCloseUpdateState.last_message = `待更新标的已统计：持仓/计划 ${activePlanItems.length} 个，备选池 ${candidateItems.length} 个，正在补全全市场队列...`;

    const activePlanResults = await processAssetList(db, activePlanItems, {
      forceUpdate: true,
      intervalMs,
      incremental: true,
      lookbackDays: 10,
      progressStage: 'active_plans',
      progressStageLabel: '持仓/计划优先',
      onProgress: applyDailyCloseProgress
    });

    const candidateResults = await processAssetList(db, candidateItems, {
      forceUpdate: true,
      intervalMs,
      incremental: true,
      lookbackDays: 10,
      progressStage: 'candidate_pool',
      progressStageLabel: '备选池优先',
      onProgress: applyDailyCloseProgress
    });

    if (universeLimit === null) {
      const priorityResults = [...activePlanResults, ...candidateResults];
      const prioritySuccessCount = priorityResults.filter((item: any) => item.success).length;
      const priorityFailedCount = priorityResults.filter((item: any) => !item.success && !item.skipped).length;
      dailyCloseUpdateState.phase = 'full_universe_queued';
      dailyCloseUpdateState.phase_label = '全市场补齐排队';
      dailyCloseUpdateState.last_updated_at = new Date().toISOString();
      dailyCloseUpdateState.last_message = '持仓/计划和备选池已优先更新，全市场补齐已转后台继续。';

      void runFullUniverseDailyCloseUpdate({
        source,
        universeLimit,
        intervalMs,
        excludeKeys: candidateKeys
      });

      return res.json({
        success: true,
        message: `每日收盘优先更新完成：持仓计划 ${activePlanResults.length} 个，备选池 ${candidateResults.length} 个，成功 ${prioritySuccessCount} 个，失败 ${priorityFailedCount} 个；全市场补齐已在后台继续`,
        data: {
          active_plan_count: activePlanResults.length,
          candidate_count: candidateResults.length,
          universe_count: null,
          universe_limit: 'all',
          success_count: prioritySuccessCount,
          failed_count: priorityFailedCount,
          background_full_universe: true,
          progress: publicDailyCloseUpdateState(),
          results: priorityResults
        }
      });
    }

    const universeResult = await processDueAssets({
      universeType: 'all',
      source,
      limit: universeLimit,
      forceUpdate: true,
      intervalMs,
      incremental: true,
      lookbackDays: 10,
      excludeKeys: candidateKeys,
      progressStage: 'full_universe',
      progressStageLabel: '全市场补齐',
      onProgress: applyDailyCloseProgress,
      onItemsSelected: (items) => {
        dailyCloseUpdateState.total_count += items.length;
        dailyCloseUpdateState.phase = 'full_universe';
        dailyCloseUpdateState.phase_label = '全市场补齐';
        dailyCloseUpdateState.last_updated_at = new Date().toISOString();
        dailyCloseUpdateState.last_message = `全市场补齐队列 ${items.length} 个，总计 ${dailyCloseUpdateState.total_count} 个标的。`;
      }
    });

    const allResults = [...activePlanResults, ...candidateResults, ...universeResult.results];
    const successCount = allResults.filter((item: any) => item.success).length;
    const failedCount = allResults.filter((item: any) => !item.success && !item.skipped).length;
    dailyCloseUpdateState.running = false;
    dailyCloseUpdateState.phase = 'completed';
    dailyCloseUpdateState.phase_label = '行情更新完成';
    dailyCloseUpdateState.finished_at = new Date().toISOString();
    dailyCloseUpdateState.last_updated_at = dailyCloseUpdateState.finished_at;
    dailyCloseUpdateState.last_message = `每日收盘行情更新完成：成功 ${successCount} 个，失败 ${failedCount} 个，准备刷新备选池。`;

    res.json({
      success: true,
      message: `每日收盘行情更新完成：优先增量更新持仓计划 ${activePlanResults.length} 个，备选池 ${candidateResults.length} 个，全市场增量补充${universeLimit === null ? '（全部标的）' : ''} ${universeResult.processed_count} 个，成功 ${successCount} 个，失败 ${failedCount} 个`,
      data: {
        active_plan_count: activePlanResults.length,
        candidate_count: candidateResults.length,
        universe_count: universeResult.processed_count,
        universe_limit: universeLimit === null ? 'all' : universeLimit,
        success_count: successCount,
        failed_count: failedCount,
        results: allResults
      }
    });
  } catch (error) {
    dailyCloseUpdateState.running = false;
    dailyCloseUpdateState.phase = 'error';
    dailyCloseUpdateState.phase_label = '更新失败';
    dailyCloseUpdateState.finished_at = new Date().toISOString();
    dailyCloseUpdateState.last_updated_at = dailyCloseUpdateState.finished_at;
    dailyCloseUpdateState.last_message = `每日收盘行情更新失败: ${(error as Error).message}`;
    res.status(500).json({ success: false, message: `每日收盘行情更新失败: ${(error as Error).message}` });
  }
});

router.post('/asset-universe/sync-full-list', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const includeStock = req.body.include_stock !== false;
    const includeEtf = req.body.include_etf !== false;

    const data = await fetchAssetUniverseList(includeStock, includeEtf);
    if (!data.success) {
      return res.status(500).json({ success: false, message: data.message || '全市场清单同步失败' });
    }

    let insertedCount = 0;
    let skippedCount = 0;

    for (const item of data.items || []) {
      const result = await db.run(
        `INSERT OR IGNORE INTO financial_asset_universe
         (symbol, name, asset_type, universe_type, source, update_status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
        [item.symbol, item.name || '', item.asset_type, item.universe_type, item.source || 'tushare']
      );
      if (result.changes && result.changes > 0) insertedCount++;
      else skippedCount++;
    }

    if (insertedCount > 0) {
      await refreshUniverseStatus(db);
    }

    res.json({
      success: true,
      message: `全市场清单同步完成：新增 ${insertedCount} 个，已存在 ${skippedCount} 个`,
      data: { inserted_count: insertedCount, skipped_count: skippedCount, total_count: data.items?.length || 0 }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `全市场清单同步失败: ${(error as Error).message}` });
  }
});

router.get('/asset-universe/auto-update/status', async (_req: Request, res: Response) => {
  res.json({ success: true, data: { ...autoUpdateState, timer: undefined } });
});

router.post('/asset-universe/auto-update/start', async (req: Request, res: Response) => {
  if (autoUpdateState.running) {
    return res.json({ success: true, message: '自动低频拉取已在运行', data: { ...autoUpdateState, timer: undefined } });
  }

  autoUpdateState.running = true;
  autoUpdateState.universe_type = req.body.universe_type || 'all';
  autoUpdateState.source = req.body.source || 'tushare';
  const requestedIntervalSeconds = req.body.interval_seconds !== undefined
    ? Number(req.body.interval_seconds)
    : Number(req.body.interval_minutes || 0.5) * 60;
  autoUpdateState.interval_seconds = Math.max(requestedIntervalSeconds || 30, 10);
  autoUpdateState.interval_minutes = Math.round((autoUpdateState.interval_seconds / 60) * 100) / 100;
  autoUpdateState.limit_per_tick = Math.max(Math.min(Number(req.body.limit_per_tick || 5), 20), 1);
  autoUpdateState.processed_count = 0;
  autoUpdateState.started_at = new Date().toISOString();
  autoUpdateState.last_message = `自动低频拉取已启动，每${autoUpdateState.interval_seconds}秒处理${autoUpdateState.limit_per_tick}个`;

  const runTick = async () => {
    if (!autoUpdateState.running) return;
    autoUpdateState.last_run_at = new Date().toISOString();
    try {
      const result = await processDueAssets({
        universeType: autoUpdateState.universe_type,
        source: autoUpdateState.source,
        limit: autoUpdateState.limit_per_tick,
        forceUpdate: false,
        preferMissingStock: true,
        skipKnownInsufficient: true
      });
      autoUpdateState.processed_count += result.processed_count;
      autoUpdateState.last_results = [
        ...result.results.map((item: any) => ({
          symbol: item.symbol,
          status: item.success ? 'success' : item.skipped ? 'skipped' : 'error',
          message: item.message || (item.success ? `已存本地：新增 ${item.insertedCount || 0} 条，更新 ${item.updatedCount || 0} 条` : '失败'),
          at: new Date().toISOString()
        })),
        ...autoUpdateState.last_results
      ].slice(0, 20);
      const first = result.results[0];
      autoUpdateState.last_message = first
        ? `${first.symbol}: ${first.success ? '已存本地' : first.skipped ? '跳过' : `失败 - ${first.message || '原因未知'}`}`
        : '没有可处理标的';
    } catch (error) {
      autoUpdateState.last_message = `自动拉取失败: ${(error as Error).message}`;
      autoUpdateState.last_results = [{
        symbol: '-',
        status: 'error',
        message: (error as Error).message,
        at: new Date().toISOString()
      }, ...autoUpdateState.last_results].slice(0, 20);
    }
  };

  await runTick();
  autoUpdateState.timer = setInterval(runTick, autoUpdateState.interval_seconds * 1000);

  res.json({ success: true, message: '自动低频拉取已启动', data: { ...autoUpdateState, timer: undefined } });
});

router.post('/asset-universe/auto-update/stop', async (_req: Request, res: Response) => {
  if (autoUpdateState.timer) {
    clearInterval(autoUpdateState.timer);
  }
  autoUpdateState.running = false;
  autoUpdateState.timer = null;
  autoUpdateState.last_message = '自动低频拉取已停止';
  res.json({ success: true, message: '自动低频拉取已停止', data: { ...autoUpdateState, timer: undefined } });
});

export default router;
