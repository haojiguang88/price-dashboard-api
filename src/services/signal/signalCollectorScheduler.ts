import getDb from "../../config/database";
import { createXianbaokuAdapter } from "./adapters/xianbaokuAdapter";
import { createXb86Adapter } from "./adapters/xb86Adapter";
import { createZuankebaAdapter } from "./adapters/zuankebaAdapter";
import { ingestCollectedSignals, loadCompleteIds, loadPendingEnrichmentIds } from "./signalIngestService";
import type { SignalAdapter } from "./signalTypes";

/**
 * 线报采集调度（常驻在 API 进程内）。
 *
 * 与任务中心那种「每天跑一次脚本」的模型不同，线报要按秒级轮询，所以这里单独一个循环：
 * - 每个源独立节奏、独立失败计数，一个源挂了不影响其它源；
 * - 请求之间强制不小于官方最短间隔（线报酷官方要求最快 5 秒一次）；
 * - 失败指数退避；连续 3 次降频，连续 10 次自动暂停并标 SOURCE_ERROR，等人工恢复。
 */

const TICK_MS = 5000;
const MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE = 10;
const SLOWDOWN_AFTER_FAILURES = 3;
const MAX_BACKOFF_MULTIPLIER = 8;
/**
 * 每轮最多补几个详情页。
 *
 * 这个数字直接决定实际节拍：86 的最短请求间隔是 10s、赚客吧 20s，
 * 「1 个列表 + N 个详情」在节流下要花 (1+N)×间隔 秒。取 4 的话 86 要 50s、
 * 赚客吧要 100s，再加上轮询间隔，实际就变成 105s / 220s —— 采集器之间的
 * 抓取密度差 3~7 倍，「哪个来源最早出现」会被采样节奏带偏，而不是真实领先。
 * 取 2 之后：86 约 30s、赚客吧约 60s，都能塞进各自配置的轮询间隔里。
 */
const DETAIL_FETCH_BUDGET = 2;

interface SourceRuntime {
  sourceKey: string;
  sourceId: number;
  name: string;
  adapter: SignalAdapter;
  pollIntervalMs: number;
  minRequestIntervalMs: number;
  nextRunAt: number;
  running: boolean;
  consecutiveFailures: number;
  lastRequestAt: number;
  disabledReason: string | null;
}

const ADAPTER_FACTORIES: Record<string, () => SignalAdapter> = {
  xianbaoku: () => createXianbaokuAdapter(),
  xb86: () => createXb86Adapter(),
  zuankeba: () => createZuankebaAdapter()
};

const runtimeBySource = new Map<string, SourceRuntime>();
let timer: NodeJS.Timeout | null = null;
let stopping = false;

const buildThrottle = (runtime: SourceRuntime) => async () => {
  const wait = Math.max(0, runtime.lastRequestAt + runtime.minRequestIntervalMs - Date.now());
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  runtime.lastRequestAt = Date.now();
};

const backoffMultiplier = (failures: number): number => (
  failures >= SLOWDOWN_AFTER_FAILURES
    ? Math.min(MAX_BACKOFF_MULTIPLIER, 2 ** (failures - SLOWDOWN_AFTER_FAILURES + 1))
    : 1
);

/**
 * 从本轮「开始时间」往后排下一轮，而不是从结束时间。
 * 否则单轮耗时会被加到间隔上，实际节拍 = 耗时 + 间隔，配置就失真了。
 */
const scheduleNext = (runtime: SourceRuntime, cycleStartedAt: number) => {
  const multiplier = backoffMultiplier(runtime.consecutiveFailures);
  runtime.nextRunAt = cycleStartedAt + runtime.pollIntervalMs * multiplier;
};

const recordSuccess = async (runtime: SourceRuntime) => {
  const db = await getDb();
  const now = new Date().toISOString();
  runtime.consecutiveFailures = 0;
  await db.run(
    `UPDATE signal_source
        SET last_success_at = ?, last_collected_at = ?, consecutive_failures = 0,
            last_error_message = NULL, disabled_reason = NULL, updated_at = ?
      WHERE source_key = ?`,
    [now, now, now, runtime.sourceKey]
  );
};

const recordFailure = async (runtime: SourceRuntime, message: string) => {
  const db = await getDb();
  const now = new Date().toISOString();
  runtime.consecutiveFailures += 1;

  const shouldDisable = runtime.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE;
  const disabledReason = shouldDisable
    ? `SOURCE_ERROR: 连续失败 ${runtime.consecutiveFailures} 次，已自动暂停，请人工确认来源可用后恢复`
    : runtime.disabledReason;

  await db.run(
    `UPDATE signal_source
        SET last_error_at = ?, last_error_message = ?, consecutive_failures = ?,
            enabled = CASE WHEN ? THEN 0 ELSE enabled END,
            disabled_reason = ?, updated_at = ?
      WHERE source_key = ?`,
    [now, message.slice(0, 500), runtime.consecutiveFailures, shouldDisable ? 1 : 0, disabledReason, now, runtime.sourceKey]
  );

  if (shouldDisable) {
    runtime.disabledReason = disabledReason;
    console.error(`[signal] ${runtime.sourceKey} 连续失败 ${runtime.consecutiveFailures} 次，已暂停采集`);
  } else {
    console.warn(
      `[signal] ${runtime.sourceKey} 采集失败第 ${runtime.consecutiveFailures} 次：${message.slice(0, 200)}`
    );
  }
};

const collectOnce = async (runtime: SourceRuntime): Promise<{ collected: number; partial: number } | null> => {
  if (runtime.running || runtime.disabledReason) return null;
  runtime.running = true;
  const cycleStartedAt = Date.now();
  try {
    // 已经完整入库的跳过详情页；仍缺正文的（partial）不在集合里，会被继续补抓，
    // 每轮受 DETAIL_FETCH_BUDGET 限制，几轮之后自然补齐。
    const completeIds = await loadCompleteIds(runtime.sourceKey);
    const pendingIds = await loadPendingEnrichmentIds(runtime.sourceKey);

    const signals = await runtime.adapter.fetchLatest({
      knownExternalIds: completeIds,
      maxDetailFetches: DETAIL_FETCH_BUDGET,
      beforeRequest: buildThrottle(runtime)
    });

    const summary = await ingestCollectedSignals(signals, { sourceId: runtime.sourceId });
    await recordSuccess(runtime);
    console.log(
      `[signal] ${runtime.sourceKey} 采集 ${summary.collected} 条：新增原始 ${summary.rawInserted}，`
      + `更新 ${summary.rawUpdated}，新事件 ${summary.normalizedInserted}，`
      + `合并 ${summary.normalizedMerged}（其中跨采集器 ${summary.crossSourceMatches}），`
      + `本轮待补 ${summary.partial}（库内已完整 ${completeIds.size} / 待补 ${pendingIds.size}）`
    );
    if (summary.analyzed > 0) {
      console.log(
        `[signal] ${runtime.sourceKey} 分析 ${summary.analyzed} 条：`
        + Object.entries(summary.profit_status).map(([key, value]) => `${key}=${value}`).join(", ")
      );
    }
    return { collected: summary.collected, partial: summary.partial };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordFailure(runtime, message);
    return null;
  } finally {
    runtime.running = false;
    scheduleNext(runtime, cycleStartedAt);
  }
};

const tick = async () => {
  if (stopping) return;
  const now = Date.now();
  for (const runtime of runtimeBySource.values()) {
    if (runtime.disabledReason || runtime.running) continue;
    if (now < runtime.nextRunAt) continue;
    // 逐个源顺序执行，避免同时打三个站点。
    await collectOnce(runtime);
  }
};

const loadSources = async (): Promise<boolean> => {
  const db = await getDb();
  const enabledSetting = await db.get(
    "SELECT setting_value FROM signal_settings WHERE setting_key = 'collector_enabled'"
  );
  if (String(enabledSetting?.setting_value ?? "1") !== "1") {
    console.log("[signal] 采集总开关关闭（signal_settings.collector_enabled != 1），跳过启动");
    return false;
  }

  const rows = await db.all(
    `SELECT id, source_key, name, poll_interval, min_request_interval
       FROM signal_source
      WHERE enabled = 1
      ORDER BY id`
  );

  for (const row of rows as Array<{ id: number; source_key: string; name: string; poll_interval: number; min_request_interval: number }>) {
    const factory = ADAPTER_FACTORIES[row.source_key];
    if (!factory) {
      console.warn(`[signal] 源 ${row.source_key} 没有对应 Adapter，跳过`);
      continue;
    }
    const pollSeconds = Math.max(10, Number(row.poll_interval) || 60);
    const minRequestSeconds = Math.max(5, Number(row.min_request_interval) || 5);
    runtimeBySource.set(row.source_key, {
      sourceKey: row.source_key,
      sourceId: Number(row.id),
      name: row.name,
      adapter: factory(),
      pollIntervalMs: pollSeconds * 1000,
      minRequestIntervalMs: minRequestSeconds * 1000,
      // 错开启动，避免开机瞬间三个源一起打。
      nextRunAt: Date.now() + 3000 + runtimeBySource.size * 2000,
      running: false,
      consecutiveFailures: 0,
      lastRequestAt: 0,
      disabledReason: null
    });
  }

  if (runtimeBySource.size > 0) {
    console.log(
      `[signal] 采集调度启动：${[...runtimeBySource.values()]
        .map(item => `${item.sourceKey}(${item.pollIntervalMs / 1000}s)`)
        .join(", ")}`
    );
  }
  return runtimeBySource.size > 0;
};

export const startSignalCollectorScheduler = async () => {
  if (timer) return;
  stopping = false;
  const hasSources = await loadSources().catch(error => {
    console.error("[signal] 采集调度初始化失败：", error instanceof Error ? error.message : error);
    return false;
  });
  if (!hasSources) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  setTimeout(() => void tick(), 4000);
};

export const stopSignalCollectorScheduler = () => {
  stopping = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  runtimeBySource.clear();
};

/** 供后台「立即采集一次」按钮使用，绕过节流周期但仍遵守最短请求间隔。 */
export const triggerSignalCollectorOnce = async (sourceKey: string) => {
  const runtime = runtimeBySource.get(sourceKey);
  if (!runtime) return null;
  return collectOnce(runtime);
};

export const getSignalCollectorStatus = () => [...runtimeBySource.values()].map(runtime => ({
  source_key: runtime.sourceKey,
  name: runtime.name,
  running: runtime.running,
  consecutive_failures: runtime.consecutiveFailures,
  next_run_at: new Date(runtime.nextRunAt).toISOString(),
  disabled_reason: runtime.disabledReason,
  poll_interval_seconds: runtime.pollIntervalMs / 1000
}));
