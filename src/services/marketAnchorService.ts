import { execFile } from "child_process";
import path from "path";
import getDb, { getDatabasePath } from "../config/database";

const SILVER_ANCHOR = {
  symbol: "SGE_AGTD",
  source: "tushare_sge",
  label: "白银延期 Ag(T+D)"
};

const DEFAULT_TASK_PYTHON = "python3";
const DEFAULT_REFRESH_TIMEOUT_MS = 5 * 60 * 1000;
const STALE_CHECK_MS = 4 * 60 * 60 * 1000;

type RefreshMode = "none" | "stale" | "force";

type AnchorRow = {
  trade_date?: string;
  close?: number | null;
  name?: string;
  source_label?: string;
  updated_at?: string;
};

type TaskStatusRow = {
  last_status?: string | null;
  last_message?: string | null;
  last_run_at?: string | null;
};

type RefreshResult = {
  status: "not_requested" | "skipped" | "success" | "failed";
  message: string;
  data?: unknown;
};

export type SilverAnchorEvidence = {
  symbol: string;
  label: string;
  source: string;
  source_label: string;
  latest_date: string;
  latest_close: number | null;
  previous_close: number | null;
  day_change_percent: number | null;
  change_5d_percent: number | null;
  change_20d_percent: number | null;
  change_60d_percent: number | null;
  high_60d: number | null;
  low_60d: number | null;
  sample_count_60d: number;
  task_status: TaskStatusRow | null;
  checked_at: string;
  latest_checked_at: string;
  freshness_status: "missing" | "fresh" | "stale";
  freshness_label: string;
  refresh_status: RefreshResult["status"];
  refresh_message: string;
  evidence_note: string;
  risk_reference_note: string;
};

const percentChange = (current: unknown, previous: unknown) => {
  const currentNumber = Number(current);
  const previousNumber = Number(previous);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(previousNumber) || previousNumber === 0) {
    return null;
  }
  return ((currentNumber - previousNumber) / previousNumber) * 100;
};

const toTime = (value?: string | null) => {
  if (!value) return 0;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const time = new Date(normalized).getTime();
  return Number.isFinite(time) ? time : 0;
};

const getTaskPython = () => (
  process.env.TASK_CENTER_PYTHON ||
  process.env.PYTHON_BIN ||
  DEFAULT_TASK_PYTHON
);

const shouldRefresh = (evidence: SilverAnchorEvidence, mode: RefreshMode) => {
  if (mode === "force") return true;
  if (mode !== "stale") return false;
  return evidence.freshness_status === "missing" || evidence.freshness_status === "stale";
};

const buildSilverAnchorRiskReferenceNote = (anchor: {
  latestDate?: string | null;
  latestClose?: number | null;
  dayChangePercent?: number | null;
  change20dPercent?: number | null;
  change60dPercent?: number | null;
}) => {
  if (!anchor.latestDate || anchor.latestClose === null || anchor.latestClose === undefined) {
    return "银价锚缺失，纪念币风控只能先依赖品种档案、发行价锚和成交承接，不能把银价作为背景依据。";
  }

  const dayChange = anchor.dayChangePercent;
  const change20d = anchor.change20dPercent;
  const change60d = anchor.change60dPercent;
  const notes: string[] = [];

  if (change20d !== null && change20d !== undefined && change60d !== null && change60d !== undefined && change20d >= 5 && change60d >= 0) {
    notes.push("银价短中期同步走强，银币成本线和发行价预期有抬升背景。");
  } else if (change20d !== null && change20d !== undefined && change20d >= 5 && change60d !== null && change60d !== undefined && change60d < 0) {
    notes.push("银价短期反弹但60日仍偏弱，可作为修复信号之一，不能直接当作趋势确认。");
  } else if (
    (change20d !== null && change20d !== undefined && change20d <= -5) ||
    (change60d !== null && change60d !== undefined && change60d <= -10)
  ) {
    notes.push("银价阶段偏弱或回撤较深，老品错杀可以观察，但新品、高溢价和闷包溢价要收紧。");
  } else {
    notes.push("银价锚暂无极端变化，重点仍回到题材、发行量、首发评级、价格锚和成交承接。");
  }

  if (dayChange !== null && dayChange !== undefined && dayChange >= 2) {
    notes.push("单日拉升偏快，过风控时要区分银价脉冲和品种自身承接。");
  } else if (dayChange !== null && dayChange !== undefined && dayChange <= -2) {
    notes.push("单日下杀明显，避免把短期恐慌直接当成可买底部。");
  }

  return notes.join("");
};

export const usesSilverAnchorEvidence = (categoryName?: string, categoryRiskType?: string) => {
  const category = String(categoryName || "").trim();
  const riskType = String(categoryRiskType || "").trim();
  return category === "纪念币" ||
    category === "贵金属" ||
    riskType === "commemorative_coin" ||
    riskType === "precious_metal";
};

const runMarketAnchorRefresh = async (timeoutMs = DEFAULT_REFRESH_TIMEOUT_MS): Promise<RefreshResult> => {
  const scriptPath = path.join(__dirname, "../../scripts/business/precious_metal_market.py");
  const pythonBin = getTaskPython();
  const args = [
    scriptPath,
    "--db",
    getDatabasePath(),
    "--mode",
    "update",
    "--symbols",
    "XAUUSD,SGE_AGTD"
  ];

  return new Promise((resolve) => {
    execFile(pythonBin, args, {
      cwd: path.join(__dirname, "../.."),
      env: process.env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 10
    }, async (error, stdout, stderr) => {
      const stdoutText = String(stdout || "");
      const stderrText = String(stderr || "");
      const lines = stdoutText.trim().split("\n").filter(Boolean);
      let parsed: any = null;
      try {
        parsed = JSON.parse(lines[lines.length - 1] || "{}");
      } catch {
        parsed = null;
      }

      const db = await getDb().catch(() => null);
      if (db) {
        const now = new Date().toISOString();
        const status = error || parsed?.success === false ? "error" : "success";
        const message = parsed?.message || stderrText.trim() || (error ? String(error.message || error) : "贵金属大盘行情更新完成");
        await db.run(
          `UPDATE task_center_tasks
           SET last_run_at = ?, last_status = ?, last_message = ?, updated_at = CURRENT_TIMESTAMP
           WHERE task_key = 'precious_metal_market_update'`,
          [now, status, message]
        ).catch(() => undefined);
      }

      if (error || parsed?.success === false) {
        resolve({
          status: "failed",
          message: parsed?.message || stderrText.trim() || String((error as Error | null)?.message || "贵金属大盘行情刷新失败"),
          data: parsed || null
        });
        return;
      }

      resolve({
        status: "success",
        message: parsed?.message || "贵金属大盘行情更新完成",
        data: parsed || null
      });
    });
  });
};

const loadSilverAnchorEvidence = async (refreshResult?: RefreshResult): Promise<SilverAnchorEvidence> => {
  const db = await getDb();
  const rows = await db.all(
    `SELECT trade_date, close, name, source_label, updated_at
     FROM market_anchor_daily_prices
     WHERE symbol = ? AND source = ?
     ORDER BY trade_date DESC, id DESC
     LIMIT 61`,
    [SILVER_ANCHOR.symbol, SILVER_ANCHOR.source]
  ) as AnchorRow[];
  const taskStatus = await db.get(
    `SELECT last_status, last_message, last_run_at
     FROM task_center_tasks
     WHERE task_key = 'precious_metal_market_update'
     LIMIT 1`
  ) as TaskStatusRow | undefined;

  const latest = rows[0] || {};
  const latestClose = latest.close ?? null;
  const previousClose = rows[1]?.close ?? null;
  const now = new Date();
  const lastCheckedAt = taskStatus?.last_run_at || latest.updated_at || "";
  const lastCheckedMs = toTime(lastCheckedAt);
  const isFresh = lastCheckedMs > 0 && now.getTime() - lastCheckedMs <= STALE_CHECK_MS;
  const freshnessStatus = !latest.trade_date ? "missing" : isFresh ? "fresh" : "stale";
  const closes = rows
    .map(row => Number(row.close))
    .filter(value => Number.isFinite(value));
  const high60 = closes.length > 0 ? Math.max(...closes) : null;
  const low60 = closes.length > 0 ? Math.min(...closes) : null;
  const refresh = refreshResult || { status: "not_requested", message: "未触发刷新" };
  const dayChangePercent = percentChange(latestClose, previousClose);
  const change5dPercent = percentChange(latestClose, rows[5]?.close);
  const change20dPercent = percentChange(latestClose, rows[20]?.close);
  const change60dPercent = percentChange(latestClose, rows[60]?.close);

  return {
    symbol: SILVER_ANCHOR.symbol,
    label: latest.name || SILVER_ANCHOR.label,
    source: SILVER_ANCHOR.source,
    source_label: latest.source_label || "Tushare 上金所 Ag(T+D)",
    latest_date: latest.trade_date || "",
    latest_close: latestClose,
    previous_close: previousClose,
    day_change_percent: dayChangePercent,
    change_5d_percent: change5dPercent,
    change_20d_percent: change20dPercent,
    change_60d_percent: change60dPercent,
    high_60d: high60,
    low_60d: low60,
    sample_count_60d: closes.length,
    task_status: taskStatus || null,
    checked_at: now.toISOString(),
    latest_checked_at: lastCheckedAt,
    freshness_status: freshnessStatus,
    freshness_label: freshnessStatus === "fresh"
      ? "已校验"
      : freshnessStatus === "missing"
        ? "无银价锚数据"
        : "待刷新",
    refresh_status: refresh.status,
    refresh_message: refresh.message,
    evidence_note: "银价锚只作为纪念币/贵金属背景证据，辅助判断银价成本线和大盘环境，不直接给买卖结论。",
    risk_reference_note: buildSilverAnchorRiskReferenceNote({
      latestDate: latest.trade_date,
      latestClose,
      dayChangePercent,
      change20dPercent,
      change60dPercent
    })
  };
};

export const getSilverAnchorEvidence = async (options: {
  refresh?: RefreshMode;
  timeoutMs?: number;
} = {}) => {
  const mode = options.refresh || "none";
  const before = await loadSilverAnchorEvidence();
  if (!shouldRefresh(before, mode)) {
    return {
      ...before,
      refresh_status: mode === "none" ? "not_requested" : "skipped",
      refresh_message: mode === "none" ? "未触发刷新" : "银价锚最近已校验，跳过刷新"
    } satisfies SilverAnchorEvidence;
  }

  const refreshResult = await runMarketAnchorRefresh(options.timeoutMs);
  return loadSilverAnchorEvidence(refreshResult);
};

export const buildSilverAnchorItemValue = (anchor: SilverAnchorEvidence) => {
  if (!anchor.latest_date || anchor.latest_close === null) {
    return "暂无银价锚数据";
  }
  const parts = [
    `${anchor.latest_date} ${anchor.label} ${Number(anchor.latest_close).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`,
    `日变动 ${anchor.day_change_percent === null ? "--" : `${anchor.day_change_percent.toFixed(2)}%`}`,
    `20日 ${anchor.change_20d_percent === null ? "--" : `${anchor.change_20d_percent.toFixed(2)}%`}`,
    anchor.freshness_label
  ];
  return parts.join("；");
};
