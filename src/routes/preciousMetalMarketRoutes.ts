import express from "express";
import getDb, { getDatabasePath } from "../config/database";
import { getSilverAnchorEvidence } from "../services/marketAnchorService";

const router = express.Router();

const MAIN_PRICE_SYMBOLS = [
  {
    symbol: "XAUUSD",
    label: "黄金现货",
    source: "twelvedata",
    sourceLabel: "Twelve Data / XAU/USD",
    role: "黄金主锚，判断贵金属大方向"
  },
  {
    symbol: "SGE_AGTD",
    label: "白银延期",
    source: "tushare_sge",
    sourceLabel: "Tushare 上金所 Ag(T+D)",
    role: "白银实物参考锚，服务纪念银币成本线和趋势背景"
  }
];

const parseRangeDays = (value: unknown) => {
  const text = String(value ?? "365").trim();
  if (text === "all") return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return 365;
  return Math.min(Math.floor(parsed), 3650);
};

const percentChange = (current: unknown, previous: unknown) => {
  const currentNumber = Number(current);
  const previousNumber = Number(previous);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(previousNumber) || previousNumber === 0) {
    return null;
  }
  return ((currentNumber - previousNumber) / previousNumber) * 100;
};

const loadMainQuoteSummaries = async (db: any) => {
  const summaries = [];

  for (const config of MAIN_PRICE_SYMBOLS) {
    const row = await db.get(
      `SELECT COUNT(1) AS total_count,
              MIN(trade_date) AS min_date,
              MAX(trade_date) AS max_date,
              MAX(name) AS name,
              MAX(source_label) AS source_label,
              (SELECT close FROM market_anchor_daily_prices WHERE symbol = ? AND source = ? ORDER BY trade_date DESC, id DESC LIMIT 1) AS latest_close,
              (SELECT trade_date FROM market_anchor_daily_prices WHERE symbol = ? AND source = ? ORDER BY trade_date DESC, id DESC LIMIT 1) AS latest_date,
              (SELECT close FROM market_anchor_daily_prices WHERE symbol = ? AND source = ? ORDER BY trade_date DESC, id DESC LIMIT 1 OFFSET 1) AS previous_close
       FROM market_anchor_daily_prices
       WHERE symbol = ? AND source = ?`,
      [
        config.symbol,
        config.source,
        config.symbol,
        config.source,
        config.symbol,
        config.source,
        config.symbol,
        config.source
      ]
    );
    summaries.push({
      ...config,
      name: row?.name || config.label,
      sourceLabel: row?.source_label || config.sourceLabel,
      count: Number(row?.total_count || 0),
      min_date: row?.min_date || "",
      max_date: row?.max_date || "",
      latest_date: row?.latest_date || "",
      latest_close: row?.latest_close ?? null,
      previous_close: row?.previous_close ?? null,
      latest_change_percent: percentChange(row?.latest_close, row?.previous_close)
    });
  }

  return summaries;
};

router.get("/precious-metal-market/overview", async (_req, res) => {
  try {
    const db = await getDb();
    const [mainQuotes, coverageRows, latestTask] = await Promise.all([
      loadMainQuoteSummaries(db),
      db.all(
        `SELECT symbol,
                MAX(name) AS name,
                MAX(source) AS source,
                MAX(source_label) AS source_label,
                COUNT(1) AS total_count,
                MIN(trade_date) AS min_date,
                MAX(trade_date) AS max_date
         FROM market_anchor_daily_prices
         WHERE symbol IN ('XAUUSD', 'SGE_AGTD')
         GROUP BY symbol, source
         ORDER BY CASE symbol WHEN 'XAUUSD' THEN 1 WHEN 'SGE_AGTD' THEN 2 ELSE 99 END`
      ),
      db.get(
        `SELECT last_status, last_message, last_run_at
         FROM task_center_tasks
         WHERE task_key = 'precious_metal_market_update'
         LIMIT 1`
      )
    ]);

    const layerCoverages = coverageRows.map((row: any) => ({
      layer: "生意行情锚点",
      table: "market_anchor_daily_prices",
      label: `${row.name || row.symbol} · ${row.source_label || row.source}`,
      count: Number(row.total_count || 0),
      min_date: row.min_date || "",
      max_date: row.max_date || ""
    }));

    res.json({
      success: true,
      data: {
        business_db_path: getDatabasePath(),
        generated_at: new Date().toISOString(),
        main_quotes: mainQuotes,
        layer_coverages: layerCoverages,
        latest_actions: [],
        model_scores: [],
        training_gates: [],
        task_status: latestTask || null
      }
    });
  } catch (error) {
    res.status(200).json({
      success: false,
      message: (error as Error).message || "贵金属大盘行情读取失败",
      data: {
        business_db_path: getDatabasePath(),
        main_quotes: [],
        layer_coverages: [],
        latest_actions: [],
        model_scores: [],
        training_gates: [],
        task_status: null
      }
    });
  }
});

router.get("/precious-metal-market/silver-anchor", async (req, res) => {
  try {
    const refreshParam = String(req.query.refresh || "none").trim();
    const refresh = refreshParam === "force"
      ? "force"
      : refreshParam === "stale"
        ? "stale"
        : "none";
    const data = await getSilverAnchorEvidence({ refresh });
    res.json({ success: true, data });
  } catch (error) {
    res.status(200).json({
      success: false,
      message: (error as Error).message || "银价锚读取失败",
      data: null
    });
  }
});

router.get("/precious-metal-market/prices", async (req, res) => {
  try {
    const db = await getDb();
    const requestedSymbol = String(req.query.symbol || "SGE_AGTD").trim().toUpperCase();
    const symbolConfig = MAIN_PRICE_SYMBOLS.find(item => item.symbol === requestedSymbol) || MAIN_PRICE_SYMBOLS[1];
    const rangeDays = parseRangeDays(req.query.range);
    const params = rangeDays
      ? [symbolConfig.symbol, symbolConfig.source, symbolConfig.symbol, symbolConfig.source, `-${rangeDays} day`]
      : [symbolConfig.symbol, symbolConfig.source];
    const rangeDateClause = rangeDays
      ? "AND trade_date >= date((SELECT MAX(trade_date) FROM market_anchor_daily_prices WHERE symbol = ? AND source = ?), ?)"
      : "";

    const rows = await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount, source
       FROM market_anchor_daily_prices
       WHERE symbol = ?
         AND source = ?
         ${rangeDateClause}
       ORDER BY trade_date ASC`,
      params
    );
    res.json({ success: true, data: { symbol: symbolConfig, rows } });
  } catch (error) {
    res.status(200).json({
      success: false,
      message: (error as Error).message || "贵金属价格曲线读取失败",
      data: { rows: [] }
    });
  }
});

export default router;
