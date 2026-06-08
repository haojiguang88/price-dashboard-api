import express from "express";
import getDb, { getDatabasePath } from "../config/database";
import { getSilverAnchorEvidence } from "../services/marketAnchorService";
import {
  evaluateSilverSwingRules,
  MARKET_ASSIST_EVALUATOR_VERSION,
  type MarketAssistRuleInput,
  type MarketPricePoint,
  type SilverSwingEvaluation
} from "../services/marketAssistEvaluator";

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

const parseJsonValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
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

const formatSignedPercent = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  const numberValue = Number(value);
  return `${numberValue > 0 ? "+" : ""}${numberValue.toFixed(2)}%`;
};

const getEvaluatorVersion = (symbol: string, ruleGroup: string) => (
  symbol === "XAUUSD" || ruleGroup === "precious_metal_plan"
    ? "gold-anchor-v1.0"
    : MARKET_ASSIST_EVALUATOR_VERSION
);

const stateStepConfigs = [
  { key: "extreme_volatility", label: "极端高波动", color: "#fb7185", tone: "danger" },
  { key: "high_volatility", label: "高波动", color: "#f59e0b", tone: "watch" },
  { key: "overheat_rise", label: "连续过热", color: "#fb923c", tone: "danger" },
  { key: "fast_rise", label: "暴涨", color: "#facc15", tone: "opportunity" },
  { key: "slow_rise", label: "慢涨", color: "#84cc16", tone: "opportunity" },
  { key: "ma250_stretch", label: "远离年线", color: "#38bdf8", tone: "watch" },
  { key: "sideways", label: "横盘", color: "#94a3b8", tone: "neutral" },
  { key: "healthy_pullback", label: "回踩不破", color: "#34d399", tone: "opportunity" },
  { key: "slow_decline", label: "阴跌", color: "#c084fc", tone: "watch" },
  { key: "fast_drop", label: "暴跌", color: "#f87171", tone: "danger" },
  { key: "falling_knife", label: "飞刀", color: "#ef4444", tone: "danger" }
];

const pickPrimaryState = (evaluation: SilverSwingEvaluation) => {
  const hits = new Set(evaluation.hitRuleKeys);
  if (hits.has("extreme_volatility") && (hits.has("fast_drop") || hits.has("falling_knife"))) {
    return { key: "extreme_crash", label: "极端高波动 + 飞刀", tone: "danger" };
  }
  if (hits.has("extreme_volatility") && (hits.has("overheat_rise") || hits.has("fast_rise"))) {
    return { key: "extreme_overheat", label: "极端高波动 + 过热", tone: "danger" };
  }
  if (hits.has("extreme_volatility")) {
    return { key: "extreme_volatility", label: "极端高波动", tone: "danger" };
  }
  if (hits.has("falling_knife")) return { key: "falling_knife", label: "飞刀", tone: "danger" };
  if (hits.has("fast_drop")) return { key: "fast_drop", label: "暴跌", tone: "danger" };
  if (hits.has("overheat_rise")) return { key: "overheat_rise", label: "连续过热", tone: "danger" };
  if (hits.has("fast_rise")) return { key: "fast_rise", label: "暴涨", tone: "opportunity" };
  if (hits.has("ma250_stretch")) return { key: "ma250_stretch", label: "远离年线", tone: "watch" };
  if (hits.has("high_volatility") && hits.has("slow_rise")) {
    return { key: "high_volatility_slow_rise", label: "高波动 + 慢涨", tone: "watch" };
  }
  if (hits.has("high_volatility") && hits.has("slow_decline")) {
    return { key: "high_volatility_slow_decline", label: "高波动 + 阴跌", tone: "watch" };
  }
  if (hits.has("high_volatility")) return { key: "high_volatility", label: "高波动冷却", tone: "watch" };
  if (hits.has("slow_rise")) return { key: "slow_rise", label: "慢涨观察", tone: "opportunity" };
  if (hits.has("slow_decline")) return { key: "slow_decline", label: "阴跌", tone: "watch" };
  if (hits.has("healthy_pullback")) return { key: "healthy_pullback", label: "回踩不破", tone: "opportunity" };
  if (hits.has("sideways") || hits.has("medium_sideways")) return { key: "sideways", label: "横盘观察", tone: "neutral" };
  return { key: "neutral", label: "中性观察", tone: "neutral" };
};

const buildActionBias = (evaluation: SilverSwingEvaluation, rules: any[] = []) => {
  const hits = new Set(evaluation.hitRuleKeys);
  const metrics = evaluation.metrics;
  const metricText = `1日 ${formatSignedPercent(metrics.dailyReturnPercent)}，5日 ${formatSignedPercent(metrics.return5dPercent)}，10日 ${formatSignedPercent(metrics.return10dPercent)}，20日 ${formatSignedPercent(metrics.return20dPercent)}，20日振幅 ${formatSignedPercent(metrics.range20dPercent)}，距年线 ${formatSignedPercent(metrics.closeVsMa250Percent)}`;
  const stretchRule = rules.find(rule => rule.rule_key === "ma250_stretch");
  const stretchThreshold = parseJsonValue(stretchRule?.threshold_json) || {};
  const blockWaveBuyVsMa250 = Number(stretchThreshold.block_wave_buy_vs_ma250_gte_percent ?? 35);
  const sellLadderVsMa250 = Number(stretchThreshold.sell_ladder_vs_ma250_gte_percent ?? 45);
  const sellLadderVsMa20 = Number(stretchThreshold.sell_ladder_vs_ma20_gte_percent ?? 8);
  const forceSellVsMa250 = Number(stretchThreshold.force_sell_vs_ma250_gte_percent ?? 60);

  if (hits.has("extreme_volatility")) {
    return {
      buy_permission: "closed",
      sell_discipline: "open",
      position_hint: "买入关闭；只处理已有仓位。暴涨优先落袋，暴跌禁止接飞刀。",
      summary: `极端高波动命中。${metricText}。`
    };
  }
  if (hits.has("falling_knife") || hits.has("fast_drop")) {
    return {
      buy_permission: "closed",
      sell_discipline: "defensive",
      position_hint: "不补仓，不接飞刀；先等止跌结构和高波动冷却。",
      summary: `暴跌/飞刀信号命中。${metricText}。`
    };
  }
  if (hits.has("overheat_rise")) {
    return {
      buy_permission: "blocked",
      sell_discipline: "open",
      position_hint: "卖出纪律优先；先动波段仓，连续过热时趋势仓和底仓也按计划参与。",
      summary: `连续暴涨/过热命中。${metricText}。`
    };
  }
  if (hits.has("fast_rise")) {
    return {
      buy_permission: "blocked",
      sell_discipline: "open",
      position_hint: "有仓开始搭梯子卖；无仓不追涨。",
      summary: `暴涨信号命中。${metricText}。`
    };
  }
  if (hits.has("ma250_stretch")) {
    const ma250Stretch = metrics.closeVsMa250Percent;
    const ma20Stretch = metrics.closeVsMa20Percent;
    const forceSell = ma250Stretch !== null && ma250Stretch >= forceSellVsMa250;
    const ladderSell = ma250Stretch !== null
      && ma250Stretch >= sellLadderVsMa250
      && ma20Stretch !== null
      && ma20Stretch >= sellLadderVsMa20;
    const buyReduced = ma250Stretch !== null && ma250Stretch >= blockWaveBuyVsMa250;

    if (forceSell) {
      return {
        buy_permission: "blocked",
        sell_discipline: "open",
        position_hint: "离年线过远，已有波段仓至少卖一笔；不再新增波段仓。",
        summary: `年线拉伸进入强纪律区。${metricText}，距MA20 ${formatSignedPercent(ma20Stretch)}。`
      };
    }
    if (ladderSell) {
      return {
        buy_permission: "blocked",
        sell_discipline: "open",
        position_hint: "开始挂卖出梯子；先处理波段仓，防止慢涨后突然回吐。",
        summary: `年线拉伸进入梯子卖区。${metricText}，距MA20 ${formatSignedPercent(ma20Stretch)}。`
      };
    }
    if (buyReduced) {
      return {
        buy_permission: "reduced",
        sell_discipline: "watch",
        position_hint: "只允许底仓/小仓观察，不新增波段仓，不一把打满。",
        summary: `价格已经明显跑在年线上方。${metricText}，距MA20 ${formatSignedPercent(ma20Stretch)}。`
      };
    }
  }
  if (hits.has("high_volatility") && hits.has("slow_rise")) {
    return {
      buy_permission: "reduced",
      sell_discipline: "watch",
      position_hint: "高波动里慢涨也不追；有仓不急着一把卖飞，但要保留梯子卖点。",
      summary: `高波动叠加慢涨。${metricText}。`
    };
  }
  if (hits.has("high_volatility") && hits.has("slow_decline")) {
    return {
      buy_permission: "reduced",
      sell_discipline: "watch",
      position_hint: "买入降权，不开大仓；阴跌不补，波段仓继续保守。",
      summary: `高波动冷却叠加阴跌。${metricText}。`
    };
  }
  if (hits.has("high_volatility")) {
    return {
      buy_permission: "reduced",
      sell_discipline: "watch",
      position_hint: "买入降权，只允许小批次复核；等待波动继续冷却。",
      summary: `高波动冷却区。${metricText}。`
    };
  }
  if (hits.has("slow_rise")) {
    return {
      buy_permission: "normal",
      sell_discipline: "watch",
      position_hint: "慢涨不出，不追涨；有仓按计划持有观察，卖点提前挂好。",
      summary: `慢涨信号命中。${metricText}。`
    };
  }
  if (hits.has("slow_decline")) {
    return {
      buy_permission: "reduced",
      sell_discipline: "watch",
      position_hint: "阴跌不补仓；波段仓降权，必要时慢慢出。",
      summary: `阴跌信号命中。${metricText}。`
    };
  }
  if (hits.has("sideways") || hits.has("healthy_pullback")) {
    return {
      buy_permission: "small_batch",
      sell_discipline: "normal",
      position_hint: "允许小批次重新评估，不一把打满。",
      summary: `结构进入观察修复区。${metricText}。`
    };
  }
  return {
    buy_permission: "normal",
    sell_discipline: "normal",
    position_hint: "未命中强纪律信号，按计划仓位和价格区间执行。",
    summary: `当前为中性观察。${metricText}。`
  };
};

const buildGoldAnchorBias = (evaluation: SilverSwingEvaluation) => {
  const hits = new Set(evaluation.hitRuleKeys);
  const metrics = evaluation.metrics;
  const metricText = `1日 ${formatSignedPercent(metrics.dailyReturnPercent)}，5日 ${formatSignedPercent(metrics.return5dPercent)}，10日 ${formatSignedPercent(metrics.return10dPercent)}，20日 ${formatSignedPercent(metrics.return20dPercent)}，20日振幅 ${formatSignedPercent(metrics.range20dPercent)}`;

  if (hits.has("extreme_volatility")) {
    return {
      buy_permission: "background_only",
      sell_discipline: "no_execution",
      position_hint: "黄金进入极端波动天气，只作贵金属大方向风险提示；白银和纪念币计划要提高纪律权重。",
      summary: `黄金背景锚进入极端高波动。${metricText}。`
    };
  }
  if (hits.has("falling_knife") || hits.has("fast_drop")) {
    return {
      buy_permission: "background_only",
      sell_discipline: "no_execution",
      position_hint: "黄金快速下杀，说明贵金属背景转冷或事件冲击加剧；不直接给买入结论。",
      summary: `黄金背景锚出现暴跌/飞刀。${metricText}。`
    };
  }
  if (hits.has("overheat_rise") || hits.has("fast_rise")) {
    return {
      buy_permission: "background_only",
      sell_discipline: "no_execution",
      position_hint: "黄金短线过热，贵金属情绪偏热；白银/纪念币若同步过热，要优先防回吐。",
      summary: `黄金背景锚偏热。${metricText}。`
    };
  }
  if (hits.has("high_volatility")) {
    return {
      buy_permission: "background_only",
      sell_discipline: "no_execution",
      position_hint: "黄金处在高波动背景，说明宏观/避险扰动还没冷却；只提高风控敏感度。",
      summary: `黄金背景锚处于高波动。${metricText}。`
    };
  }
  if (hits.has("slow_decline")) {
    return {
      buy_permission: "background_only",
      sell_discipline: "no_execution",
      position_hint: "黄金慢跌，贵金属背景偏冷；观察白银是否跟跌或出现背离。",
      summary: `黄金背景锚阴跌。${metricText}。`
    };
  }
  if (hits.has("slow_rise")) {
    return {
      buy_permission: "background_only",
      sell_discipline: "no_execution",
      position_hint: "黄金慢涨，贵金属背景偏暖；可作为白银和纪念币大方向的加分项。",
      summary: `黄金背景锚慢涨。${metricText}。`
    };
  }
  if (hits.has("sideways") || hits.has("medium_sideways") || hits.has("healthy_pullback")) {
    return {
      buy_permission: "background_only",
      sell_discipline: "no_execution",
      position_hint: "黄金结构相对平稳，只作为背景锚点观察，不单独触发动作。",
      summary: `黄金背景锚进入观察区。${metricText}。`
    };
  }
  return {
    buy_permission: "background_only",
    sell_discipline: "no_execution",
    position_hint: "黄金未命中强信号，继续作为贵金属天气预报和白银/纪念币背景参考。",
    summary: `黄金背景锚中性观察。${metricText}。`
  };
};

const buildCurrentSignalPayload = (
  symbolConfig: typeof MAIN_PRICE_SYMBOLS[number],
  evaluation: SilverSwingEvaluation,
  rules: any[],
  ruleGroup: string
) => {
  const primaryState = pickPrimaryState(evaluation);
  const actionBias = ruleGroup === "precious_metal_plan" || symbolConfig.symbol === "XAUUSD"
    ? buildGoldAnchorBias(evaluation)
    : buildActionBias(evaluation, rules);
  const hitSet = new Set(evaluation.hitRuleKeys);
  const ruleMap = new Map(rules.map((rule: any) => [rule.rule_key, rule]));
  const stateSteps = stateStepConfigs.map(config => {
    const rule = ruleMap.get(config.key);
    const active = config.key === "sideways"
      ? hitSet.has("sideways") || hitSet.has("medium_sideways")
      : hitSet.has(config.key);
    return {
      ...config,
      active,
      rule_name: rule?.rule_name || config.label,
      action_hint: rule?.action_hint || "",
      note: rule?.note || ""
    };
  });

  return {
    symbol: symbolConfig,
    evaluator_version: getEvaluatorVersion(symbolConfig.symbol, ruleGroup),
    generated_at: new Date().toISOString(),
    trade_date: evaluation.date,
    close: evaluation.close,
    primary_state: primaryState,
    action_bias: actionBias,
    hit_rule_keys: evaluation.hitRuleKeys,
    state_steps: stateSteps,
    metrics: evaluation.metrics
  };
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

router.get("/precious-metal-market/assist-rules", async (req, res) => {
  try {
    const db = await getDb();
    const requestedSymbol = String(req.query.symbol || "SGE_AGTD").trim().toUpperCase();
    const symbolConfig = MAIN_PRICE_SYMBOLS.find(item => item.symbol === requestedSymbol) || MAIN_PRICE_SYMBOLS[1];
    const ruleGroup = String(req.query.rule_group || "silver_swing_plan").trim();
    const includeArchived = String(req.query.include_archived || "").trim() === "1";
    const rows = await db.all(
      `SELECT id,
              asset_symbol,
              asset_label,
              rule_group,
              group_label,
              rule_key,
              rule_name,
              rule_type,
              priority,
              threshold_json,
              action_hint,
              display_order,
              status,
              note,
              evidence_window,
              source_note,
              updated_at
       FROM market_assist_rules
       WHERE asset_symbol = ?
         AND rule_group = ?
         ${includeArchived ? "" : "AND status <> 'archived'"}
       ORDER BY display_order ASC, id ASC`,
      [symbolConfig.symbol, ruleGroup]
    );

    res.json({
      success: true,
      data: {
        symbol: symbolConfig,
        rule_group: ruleGroup,
        evaluator_version: getEvaluatorVersion(symbolConfig.symbol, ruleGroup),
        items: rows.map((row: any) => ({
          ...row,
          threshold: parseJsonValue(row.threshold_json)
        }))
      }
    });
  } catch (error) {
    res.status(200).json({
      success: false,
      message: (error as Error).message || "贵金属计划口径读取失败",
      data: { items: [] }
    });
  }
});

router.get("/precious-metal-market/current-signal", async (req, res) => {
  try {
    const db = await getDb();
    const requestedSymbol = String(req.query.symbol || "SGE_AGTD").trim().toUpperCase();
    const symbolConfig = MAIN_PRICE_SYMBOLS.find(item => item.symbol === requestedSymbol) || MAIN_PRICE_SYMBOLS[1];
    const ruleGroup = String(req.query.rule_group || "silver_swing_plan").trim();
    const points = await db.all(
      `SELECT trade_date, close
       FROM market_anchor_daily_prices
       WHERE symbol = ?
         AND source = ?
         AND close IS NOT NULL
       ORDER BY trade_date ASC`,
      [symbolConfig.symbol, symbolConfig.source]
    ) as MarketPricePoint[];
    const rules = await db.all(
      `SELECT rule_key, rule_type, threshold_json, status, display_order
       FROM market_assist_rules
       WHERE asset_symbol = ?
         AND rule_group = ?
         AND status = 'active'
       ORDER BY display_order ASC`,
      [symbolConfig.symbol, ruleGroup]
    ) as MarketAssistRuleInput[];
    const ruleRows = await db.all(
      `SELECT rule_key, rule_name, rule_type, action_hint, note
       FROM market_assist_rules
       WHERE asset_symbol = ?
         AND rule_group = ?
         AND status = 'active'
       ORDER BY display_order ASC`,
      [symbolConfig.symbol, ruleGroup]
    );

    if (!points.length || !rules.length) {
      res.json({
        success: true,
        data: {
          symbol: symbolConfig,
          evaluator_version: getEvaluatorVersion(symbolConfig.symbol, ruleGroup),
          generated_at: new Date().toISOString(),
          trade_date: "",
          close: null,
          primary_state: { key: "unconfigured", label: "未配置", tone: "neutral" },
          action_bias: {
            buy_permission: "unknown",
            sell_discipline: "unknown",
            position_hint: "当前标的暂无动态辅助口径。",
            summary: "暂无足够数据或规则。"
          },
          hit_rule_keys: [],
          state_steps: [],
          metrics: null
        }
      });
      return;
    }

    const evaluation = evaluateSilverSwingRules(points, rules);
    res.json({
      success: true,
      data: buildCurrentSignalPayload(symbolConfig, evaluation, ruleRows, ruleGroup)
    });
  } catch (error) {
    res.status(200).json({
      success: false,
      message: (error as Error).message || "贵金属动态信号读取失败",
      data: null
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
