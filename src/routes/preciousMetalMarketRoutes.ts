import express from "express";
import getDb, { getDatabasePath } from "../config/database";
import { getSilverAnchorEvidence } from "../services/marketAnchorService";
import { loadGoldSilverRatioSummary } from "../services/goldSilverRatioService";
import { getCoinSilverPremiumContext } from "../services/coinSilverPremiumService";
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

const MARKET_CYCLE_PREF_KEY = "precious_metal_macro_cycle";
const VALID_MARKET_CYCLE_STATES = new Set(["unknown", "bull", "bear"]);

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

const normalizeText = (value: unknown) => String(value ?? "").trim();

const parseOptionalNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const normalizeDate = (value: unknown) => {
  const text = normalizeText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return new Date().toISOString().slice(0, 10);
};

const roundNumber = (value: number | null, digits = 3) => {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const serializePhysicalObservation = (row: any) => ({
  id: Number(row.id),
  asset_symbol: row.asset_symbol,
  asset_label: row.asset_label,
  observation_date: row.observation_date,
  reference_close: row.reference_close === null || row.reference_close === undefined ? null : Number(row.reference_close),
  merchant_sell_price: row.merchant_sell_price === null || row.merchant_sell_price === undefined ? null : Number(row.merchant_sell_price),
  merchant_sell_premium: row.merchant_sell_premium === null || row.merchant_sell_premium === undefined ? null : Number(row.merchant_sell_premium),
  buyback_price: row.buyback_price === null || row.buyback_price === undefined ? null : Number(row.buyback_price),
  buyback_premium: row.buyback_premium === null || row.buyback_premium === undefined ? null : Number(row.buyback_premium),
  supply_status: row.supply_status || "unknown",
  transaction_heat: row.transaction_heat || "unknown",
  social_heat: row.social_heat || "unknown",
  reliability: row.reliability || "manual_limited",
  source_note: row.source_note || "",
  note: row.note || "",
  created_at: row.created_at || "",
  updated_at: row.updated_at || ""
});

const normalizeMarketCycleState = (value: unknown) => {
  const state = normalizeText(value);
  return VALID_MARKET_CYCLE_STATES.has(state) ? state : "unknown";
};

const serializeMarketCyclePreference = (preferenceValue: unknown) => {
  const parsed = parseJsonValue(preferenceValue) || {};
  return {
    cycle_state: normalizeMarketCycleState(parsed.cycle_state),
    note: normalizeText(parsed.note),
    confirmed_at: normalizeText(parsed.confirmed_at),
    confirmed_by: normalizeText(parsed.confirmed_by) || "manual",
    updated_at: normalizeText(parsed.updated_at)
  };
};

const loadMarketCyclePreference = async (db: any) => {
  const row = await db.get(
    `SELECT preference_value, updated_at
     FROM user_preferences
     WHERE user_key = 'default'
       AND preference_key = ?
     LIMIT 1`,
    [MARKET_CYCLE_PREF_KEY]
  );
  const preference = serializeMarketCyclePreference(row?.preference_value);
  return {
    ...preference,
    updated_at: preference.updated_at || row?.updated_at || ""
  };
};

const saveMarketCyclePreference = async (db: any, input: { cycle_state: string; note: string }) => {
  const now = new Date().toISOString();
  const payload = {
    cycle_state: normalizeMarketCycleState(input.cycle_state),
    note: normalizeText(input.note),
    confirmed_at: now,
    confirmed_by: "manual",
    updated_at: now
  };
  await db.run(
    `INSERT INTO user_preferences
       (user_key, preference_key, preference_value, created_at, updated_at)
     VALUES ('default', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(user_key, preference_key) DO UPDATE SET
       preference_value = excluded.preference_value,
       updated_at = CURRENT_TIMESTAMP`,
    [MARKET_CYCLE_PREF_KEY, JSON.stringify(payload)]
  );
  return payload;
};

const buildPhysicalGuidance = (observation: ReturnType<typeof serializePhysicalObservation> | null) => {
  if (!observation) {
    return {
      key: "missing",
      label: "缺少实物端观察",
      tone: "neutral",
      summary: "当前只看盘面状态；实物端加价、回收价和成交热度需要人工补充。",
      action_hint: "不影响盘面判断。"
    };
  }

  const sellPremium = Number(observation.merchant_sell_premium);
  const buybackPremium = Number(observation.buyback_premium);
  const hotSocial = ["crowded", "high"].includes(observation.social_heat);
  const hotTransaction = ["hot", "warm"].includes(observation.transaction_heat);
  const hardToBuy = ["need_grab", "limited"].includes(observation.supply_status);
  const easyToBuy = ["easy_buy", "normal"].includes(observation.supply_status);
  const coldTransaction = ["cold", "quiet"].includes(observation.transaction_heat);

  if ((Number.isFinite(buybackPremium) && buybackPremium >= 2)
    || (Number.isFinite(sellPremium) && sellPremium >= 3)
    || hotSocial
    || (hotTransaction && hardToBuy)) {
    return {
      key: "physical_hot",
      label: "实物端偏热",
      tone: "watch",
      summary: "实物端出现加价、抢货或讨论升温，只能提高卖出纪律和防追高权重。",
      action_hint: "有仓优先检查梯子卖点；无仓不因实物端热度追买。"
    };
  }

  if (easyToBuy && coldTransaction) {
    return {
      key: "physical_cooling",
      label: "实物端转冷",
      tone: "weak",
      summary: "供给变容易、成交热度下降，说明盘面修复需要更多确认。",
      action_hint: "不急着补仓，等待盘面高波动解除和结构修复。"
    };
  }

  return {
    key: "physical_neutral",
    label: "实物端中性",
    tone: "neutral",
    summary: "实物端没有给出强烈背离，只作为盘面判断的现场补充。",
    action_hint: "继续以盘面状态线和仓位计划为主。"
  };
};

const writePhysicalObservationAuditLog = async (db: any, record: any) => {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO audit_logs
      (id, timestamp, module, action, target, status, detail, entity_id, path, domain, workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `physical_observation_create_${record.id}_${Date.now()}`,
      now,
      "贵金属实物端观察",
      "create",
      `${record.asset_label} / ${record.observation_date}`,
      "success",
      record.note || record.source_note || "手动记录实物端辅助信息",
      String(record.id),
      "/market/precious-metals",
      "business",
      "business",
      now,
      now
    ]
  ).catch(() => undefined);
};

const writeMarketCycleAuditLog = async (db: any, record: { cycle_state: string; note: string }) => {
  const now = new Date().toISOString();
  const stateLabel = record.cycle_state === "bull" ? "牛市" : record.cycle_state === "bear" ? "熊市" : "未确认";
  await db.run(
    `INSERT INTO audit_logs
      (id, timestamp, module, action, target, status, detail, entity_id, path, domain, workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `precious_metal_market_cycle_${Date.now()}`,
      now,
      "贵金属大周期",
      "update",
      stateLabel,
      "success",
      record.note || "手动确认贵金属大周期状态",
      MARKET_CYCLE_PREF_KEY,
      "/market/precious-metals",
      "business",
      "business",
      now,
      now
    ]
  ).catch(() => undefined);
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
  { key: "rebound", label: "反抽", color: "#93c5fd", tone: "watch" },
  { key: "rebound_repair", label: "反抽修复", color: "#60a5fa", tone: "watch" },
  { key: "falling_knife", label: "飞刀", color: "#ef4444", tone: "danger" }
];

const getHitSet = (evaluation: SilverSwingEvaluation) => new Set(evaluation.hitRuleKeys);

const getReboundDisplayThresholds = (symbol: string) => (
  symbol === "XAUUSD"
    ? {
      rebound: {
        return3dGte: 5,
        dailyReturnGte: 2.5,
        recovery5dGte: 4,
        return5dLte: 8,
        worstDrop10dLte: -3,
        return10dLte: -3,
        drawdown20dLte: -5
      },
      repair: {
        closeVsMa20Gte: -1,
        closeVsMa60Gte: -2,
        recovery5dGte: 3,
        return5dGte: -1,
        range10dVs20dLte: 0.75
      }
    }
    : {
      rebound: {
        return3dGte: 5,
        dailyReturnGte: 3,
        recovery5dGte: 5,
        return5dLte: 8,
        worstDrop10dLte: -3.5,
        return10dLte: -4,
        drawdown20dLte: -6
      },
      repair: {
        closeVsMa20Gte: -1.5,
        closeVsMa60Gte: -2.5,
        recovery5dGte: 4,
        return5dGte: -1,
        range10dVs20dLte: 0.75
      }
    }
);

const buildDisplayOnlyStep = (stepKey: string, evaluation: SilverSwingEvaluation, symbol: string) => {
  if (stepKey !== "rebound" && stepKey !== "rebound_repair") return null;

  const metrics = evaluation.metrics;
  const thresholds = getReboundDisplayThresholds(symbol);
  const reboundThresholds = thresholds.rebound;
  const repairThresholds = thresholds.repair;
  const return3d = metrics.return3dPercent;
  const return5d = metrics.return5dPercent;
  const return10d = metrics.return10dPercent;
  const worstDrop10d = metrics.worstSingleDayDrop10dPercent;
  const drawdown20d = metrics.drawdownFrom20dHighPercent;
  const recovery5d = metrics.recoveryFrom5dLowPercent;
  const shortRebound = (return3d !== null && return3d >= reboundThresholds.return3dGte)
    || (
      metrics.dailyReturnPercent !== null
      && metrics.dailyReturnPercent >= reboundThresholds.dailyReturnGte
      && recovery5d !== null
      && recovery5d >= reboundThresholds.recovery5dGte
    );
  const notTrendContinuation = return5d === null || return5d <= reboundThresholds.return5dLte;
  const priorShock = (worstDrop10d !== null && worstDrop10d <= reboundThresholds.worstDrop10dLte)
    || (return10d !== null && return10d <= reboundThresholds.return10dLte)
    || (drawdown20d !== null && drawdown20d <= reboundThresholds.drawdown20dLte);
  const reboundActive = shortRebound && notTrendContinuation && priorShock;

  if (stepKey === "rebound") {
    return {
      active: reboundActive,
      action_hint: symbol === "XAUUSD"
        ? "展示节点：黄金前面出现暴跌/阴跌/回落后，1-3日快速反弹；只作观察，不改变买卖权限。"
        : "展示节点：前面出现暴跌/阴跌/回落后，1-3日快速反弹；只作观察，不改变买卖权限。",
      note: `1日 ${formatSignedPercent(metrics.dailyReturnPercent)}，3日 ${formatSignedPercent(return3d)}，5日 ${formatSignedPercent(return5d)}，10日最深单日 ${formatSignedPercent(worstDrop10d)}，距20日高点 ${formatSignedPercent(drawdown20d)}。`
    };
  }

  const closeVsMa20 = metrics.closeVsMa20Percent;
  const closeVsMa60 = metrics.closeVsMa60Percent;
  const range10d = metrics.range10dPercent;
  const range20d = metrics.range20dPercent;
  const nearKeyAverage = (closeVsMa20 !== null && closeVsMa20 >= repairThresholds.closeVsMa20Gte)
    || (closeVsMa60 !== null && closeVsMa60 >= repairThresholds.closeVsMa60Gte);
  const noFreshLow = recovery5d !== null && recovery5d >= repairThresholds.recovery5dGte;
  const shortTrendStabilized = return5d === null || return5d >= repairThresholds.return5dGte;
  const volatilityContracting = range10d !== null
    && range20d !== null
    && range20d > 0
    && range10d <= range20d * repairThresholds.range10dVs20dLte;
  const repairActive = priorShock
    && (reboundActive || noFreshLow)
    && nearKeyAverage
    && noFreshLow
    && shortTrendStabilized
    && volatilityContracting;

  return {
    active: repairActive,
    action_hint: symbol === "XAUUSD"
      ? "展示节点：黄金反抽后重新靠近/站回 MA20 或 MA60，且没有继续创新低、波动开始收敛；只提升背景状态，不给黄金实体买入，也不直接放行白银/纪念币。"
      : "展示节点：反抽后重新靠近/站回 MA20 或 MA60，且没有继续创新低、波动开始收敛；只降低悲观，不直接放行买入。",
    note: `5日 ${formatSignedPercent(return5d)}，距MA20 ${formatSignedPercent(closeVsMa20)}，距MA60 ${formatSignedPercent(closeVsMa60)}，离5日低点 ${formatSignedPercent(recovery5d)}，10日振幅 ${formatSignedPercent(range10d)} / 20日振幅 ${formatSignedPercent(range20d)}。`
  };
};

const getEvaluationRule = (evaluation: SilverSwingEvaluation, ruleKey: string) => (
  evaluation.rules.find(rule => rule.ruleKey === ruleKey)
);

const getRuleScore = (evaluation: SilverSwingEvaluation, ruleKey: string) => {
  const rule = getEvaluationRule(evaluation, ruleKey);
  return Number.isFinite(Number(rule?.score)) ? Number(rule?.score) : null;
};

const isHighVolatilityLike = (evaluation: SilverSwingEvaluation) => {
  const hits = getHitSet(evaluation);
  return hits.has("high_volatility") || hits.has("extreme_volatility");
};

const countBackwardWhile = (
  evaluations: SilverSwingEvaluation[],
  predicate: (evaluation: SilverSwingEvaluation) => boolean
) => {
  let count = 0;
  for (let index = evaluations.length - 1; index >= 0; index -= 1) {
    if (!predicate(evaluations[index])) break;
    count += 1;
  }
  return count;
};

const buildVolatilityRestoreConditions = (
  evaluation: SilverSwingEvaluation,
  clearStreakDays: number
) => {
  const hits = getHitSet(evaluation);
  const noExtreme = !hits.has("extreme_volatility");
  const noHighVolatility = !hits.has("high_volatility");
  const noFallingKnife = !hits.has("falling_knife") && !hits.has("fast_drop");
  const noOverheat = !hits.has("overheat_rise") && !hits.has("fast_rise");
  const enoughCoolingDays = clearStreakDays >= 5;
  const structureRepaired = hits.has("sideways")
    || hits.has("medium_sideways")
    || hits.has("healthy_pullback")
    || (hits.has("slow_rise") && noOverheat);

  const statusOf = (passed: boolean, blocked = false) => (
    passed ? "passed" : blocked ? "blocked" : "pending"
  );

  return [
    {
      key: "extreme_cleared",
      label: "极端高波动未命中",
      status: statusOf(noExtreme, !noExtreme),
      text: noExtreme ? "极端纪律区已离开。" : "仍在极端高波动，买入权限关闭。"
    },
    {
      key: "high_volatility_cleared",
      label: "高波动未命中",
      status: statusOf(noHighVolatility),
      text: noHighVolatility ? "高波动主规则暂未命中。" : "仍在高波动，买入只能降权观察。"
    },
    {
      key: "falling_knife_cleared",
      label: "暴跌/飞刀未命中",
      status: statusOf(noFallingKnife, !noFallingKnife),
      text: noFallingKnife ? "没有暴跌/飞刀拦截。" : "仍有暴跌/飞刀信号，不接。"
    },
    {
      key: "overheat_cleared",
      label: "暴涨/过热未命中",
      status: statusOf(noOverheat),
      text: noOverheat ? "没有追涨拦截。" : "仍有暴涨/过热信号，先看卖出纪律。"
    },
    {
      key: "cooling_days",
      label: "解除观察至少5个交易日",
      status: statusOf(enoughCoolingDays),
      text: enoughCoolingDays
        ? `已连续 ${clearStreakDays} 个交易日未命中高波动/极端。`
        : `当前仅连续 ${clearStreakDays} 个交易日未命中高波动/极端。`
    },
    {
      key: "structure_repaired",
      label: "结构有修复证据",
      status: statusOf(structureRepaired),
      text: structureRepaired
        ? "横盘、回踩不破或温和慢涨给出结构修复证据。"
        : "暂未看到横盘、回踩不破或温和慢涨的结构证据。"
    }
  ];
};

const buildVolatilityPhase = (
  evaluation: SilverSwingEvaluation,
  recentEvaluations: SilverSwingEvaluation[]
) => {
  const hits = getHitSet(evaluation);
  const highRule = getEvaluationRule(evaluation, "high_volatility");
  const highScore = getRuleScore(evaluation, "high_volatility");
  const previousEvaluation = recentEvaluations.length > 1
    ? recentEvaluations[recentEvaluations.length - 2]
    : null;
  const previousHighScore = previousEvaluation ? getRuleScore(previousEvaluation, "high_volatility") : null;
  const scoreRequired = Number.isFinite(Number(highRule?.scoreRequired)) ? Number(highRule?.scoreRequired) : 3;
  const scoreTotal = Number.isFinite(Number(highRule?.scoreTotal)) ? Number(highRule?.scoreTotal) : null;
  const highVolatilityStreakDays = countBackwardWhile(recentEvaluations, isHighVolatilityLike);
  const clearStreakDays = countBackwardWhile(recentEvaluations, evaluationItem => !isHighVolatilityLike(evaluationItem));
  const recentWindow = recentEvaluations.slice(-20);
  const recentHighVolatilityDays20 = recentWindow.filter(isHighVolatilityLike).length;
  const hasDirectionalShock = hits.has("fast_drop")
    || hits.has("falling_knife")
    || hits.has("fast_rise")
    || hits.has("overheat_rise");
  const highHit = hits.has("high_volatility");
  const extremeHit = hits.has("extreme_volatility");
  const scoreCooling = highScore !== null
    && highScore <= scoreRequired
    && previousHighScore !== null
    && previousHighScore >= highScore;

  let key = "quiet";
  let label = "波动平稳";
  let tone = "neutral";
  let summary = "当前没有高波动/极端高波动命中，但仍按计划价格、仓位和实物端信息复核。";
  let buyPermissionHint = "恢复复核权限，不等于自动买入。";

  if (extremeHit) {
    key = "extreme";
    label = "极端高波动";
    tone = "danger";
    summary = "仍在极端纪律区，买入权限关闭，优先已有仓位、现金和卖出纪律。";
    buyPermissionHint = "关闭买入权限。";
  } else if (highHit) {
    if (highVolatilityStreakDays <= 3) {
      key = "starting";
      label = "高波动刚开始";
      tone = "watch";
      summary = "高波动刚进入命中区，先别把短暂反弹或快速下跌当成稳定结构。";
    } else if (scoreCooling && !hasDirectionalShock) {
      key = "cooling";
      label = "高波动冷却中";
      tone = "watch";
      summary = "高波动仍命中，但分数已贴近阈值且没有方向性冲击，进入观察冷却阶段。";
    } else {
      key = "continuing";
      label = "高波动延续";
      tone = "watch";
      summary = "高波动还在延续，买入继续降权；有仓按纪律管理，不急着判断已经安全。";
    }
    buyPermissionHint = "买入降权，只允许观察或小批次复核。";
  } else if (recentHighVolatilityDays20 > 0 && clearStreakDays < 5) {
    key = "cooling";
    label = "高波动解除观察中";
    tone = "watch";
    summary = "高波动主规则暂未命中，但解除天数还短，先看是否反复。";
    buyPermissionHint = "只恢复观察，不恢复大仓权限。";
  } else if (recentHighVolatilityDays20 > 0 && clearStreakDays >= 5) {
    key = "basically_cleared";
    label = "高波动基本解除";
    tone = "opportunity";
    summary = "高波动已连续多日未命中，可以恢复计划复核；仍需看价格区间、实物端和仓位纪律。";
    buyPermissionHint = "恢复复核权限，不等于自动买入。";
  }

  return {
    key,
    label,
    tone,
    summary,
    buy_permission_hint: buyPermissionHint,
    high_volatility_score: highScore,
    high_volatility_score_total: scoreTotal,
    high_volatility_score_required: scoreRequired,
    previous_high_volatility_score: previousHighScore,
    high_volatility_streak_days: highVolatilityStreakDays,
    clear_streak_days: clearStreakDays,
    recent_high_volatility_days_20: recentHighVolatilityDays20,
    restore_conditions: buildVolatilityRestoreConditions(evaluation, clearStreakDays)
  };
};

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
      position_hint: "黄金进入极端波动天气，只作贵金属大方向风险提示；白银和纪念币计划要提高纪律权重，不能单独触发买卖。",
      summary: `黄金背景锚进入极端高波动。${metricText}。`
    };
  }
  if (hits.has("falling_knife") || hits.has("fast_drop")) {
    return {
      buy_permission: "background_only",
      sell_discipline: "no_execution",
      position_hint: "黄金快速下杀，说明贵金属背景转冷或事件冲击加剧；只提示背景风险，不直接给买入结论。",
      summary: `黄金背景锚出现暴跌/飞刀。${metricText}。`
    };
  }
  if (hits.has("overheat_rise") || hits.has("fast_rise")) {
    return {
      buy_permission: "background_only",
      sell_discipline: "no_execution",
      position_hint: "黄金短线过热，贵金属情绪偏热；白银/纪念币若同步过热，只提高防回吐权重，不单独触发卖出。",
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
      position_hint: "黄金慢涨，贵金属背景偏暖；只能作为白银和纪念币大方向的加分项。",
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
  ruleGroup: string,
  recentEvaluations: SilverSwingEvaluation[] = [evaluation]
) => {
  const primaryState = pickPrimaryState(evaluation);
  const actionBias = ruleGroup === "precious_metal_plan" || symbolConfig.symbol === "XAUUSD"
    ? buildGoldAnchorBias(evaluation)
    : buildActionBias(evaluation, rules);
  const hitSet = new Set(evaluation.hitRuleKeys);
  const ruleMap = new Map(rules.map((rule: any) => [rule.rule_key, rule]));
  const stateSteps = stateStepConfigs.map(config => {
    const rule = ruleMap.get(config.key);
    const displayOnlyStep = buildDisplayOnlyStep(config.key, evaluation, symbolConfig.symbol);
    const active = displayOnlyStep
      ? displayOnlyStep.active
      : config.key === "sideways"
        ? hitSet.has("sideways") || hitSet.has("medium_sideways")
        : hitSet.has(config.key);
    return {
      ...config,
      active,
      rule_name: rule?.rule_name || config.label,
      action_hint: displayOnlyStep?.action_hint || rule?.action_hint || "",
      note: displayOnlyStep?.note || rule?.note || ""
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
    rule_evaluations: evaluation.rules,
    volatility_phase: symbolConfig.symbol === "SGE_AGTD"
      ? buildVolatilityPhase(evaluation, recentEvaluations.length ? recentEvaluations : [evaluation])
      : null,
    state_steps: stateSteps,
    metrics: evaluation.metrics
  };
};

router.get("/precious-metal-market/overview", async (_req, res) => {
  try {
    const db = await getDb();
    const [mainQuotes, coverageRows, latestTask, marketCycle, goldSilverRatio] = await Promise.all([
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
         WHERE symbol IN ('XAUUSD', 'SGE_AGTD', 'USDCNH')
         GROUP BY symbol, source
         ORDER BY CASE symbol WHEN 'XAUUSD' THEN 1 WHEN 'SGE_AGTD' THEN 2 WHEN 'USDCNH' THEN 3 ELSE 99 END`
      ),
      db.get(
        `SELECT last_status, last_message, last_run_at
         FROM task_center_tasks
         WHERE task_key = 'precious_metal_market_update'
         LIMIT 1`
      ),
      loadMarketCyclePreference(db),
      loadGoldSilverRatioSummary(db)
    ]);

    const layerCoverages = coverageRows.map((row: any) => ({
      layer: row.symbol === "USDCNH" ? "换算辅助数据" : "生意行情锚点",
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
        market_cycle: marketCycle,
        gold_silver_ratio: goldSilverRatio,
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
        market_cycle: serializeMarketCyclePreference(null),
        gold_silver_ratio: null,
        task_status: null
      }
    });
  }
});

router.post("/precious-metal-market/market-cycle", async (req, res) => {
  try {
    const db = await getDb();
    const body = req.body || {};
    const cycleState = normalizeMarketCycleState(body.cycle_state);
    const note = normalizeText(body.note);
    const item = await saveMarketCyclePreference(db, { cycle_state: cycleState, note });
    await writeMarketCycleAuditLog(db, item);
    res.json({
      success: true,
      message: "贵金属大周期状态已保存",
      data: item
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: (error as Error).message || "保存贵金属大周期状态失败",
      data: null
    });
  }
});

router.get("/precious-metal-market/assist-rules", async (req, res) => {
  try {
    const db = await getDb();
    const requestedSymbol = String(req.query.symbol || "SGE_AGTD").trim().toUpperCase();
    const symbolConfig = MAIN_PRICE_SYMBOLS.find(item => item.symbol === requestedSymbol) || MAIN_PRICE_SYMBOLS[1];
    const defaultRuleGroup = symbolConfig.symbol === "XAUUSD" ? "precious_metal_plan" : "silver_swing_plan";
    const ruleGroup = String(req.query.rule_group || defaultRuleGroup).trim();
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

router.get("/precious-metal-market/rule-versions", async (req, res) => {
  try {
    const db = await getDb();
    const requestedSymbol = String(req.query.symbol || "SGE_AGTD").trim().toUpperCase();
    const symbolConfig = MAIN_PRICE_SYMBOLS.find(item => item.symbol === requestedSymbol) || MAIN_PRICE_SYMBOLS[1];
    const defaultRuleGroup = symbolConfig.symbol === "XAUUSD" ? "precious_metal_plan" : "silver_swing_plan";
    const ruleGroup = String(req.query.rule_group || defaultRuleGroup).trim();
    const includeArchived = String(req.query.include_archived || "").trim() === "1";
    const requestedLimit = Number(req.query.limit || 5);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 20) : 5;
    const rows = await db.all(
      `SELECT id,
              asset_symbol,
              asset_label,
              rule_group,
              group_label,
              version_key,
              version_name,
              status,
              effective_date,
              change_reason,
              threshold_summary,
              sample_window,
              regression_command,
              regression_summary,
              snapshot_json,
              updated_at
       FROM market_assist_rule_versions
       WHERE asset_symbol = ?
         AND rule_group = ?
         ${includeArchived ? "" : "AND status <> 'archived'"}
       ORDER BY effective_date DESC, id DESC
       LIMIT ?`,
      [symbolConfig.symbol, ruleGroup, limit]
    );

    res.json({
      success: true,
      data: {
        symbol: symbolConfig,
        rule_group: ruleGroup,
        evaluator_version: getEvaluatorVersion(symbolConfig.symbol, ruleGroup),
        items: rows.map((row: any) => ({
          ...row,
          snapshot: parseJsonValue(row.snapshot_json)
        }))
      }
    });
  } catch (error) {
    res.status(200).json({
      success: false,
      message: (error as Error).message || "贵金属阈值版本记录读取失败",
      data: { items: [] }
    });
  }
});

router.get("/precious-metal-market/physical-observations", async (req, res) => {
  try {
    const db = await getDb();
    const requestedSymbol = String(req.query.symbol || "SGE_AGTD").trim().toUpperCase();
    const symbolConfig = MAIN_PRICE_SYMBOLS.find(item => item.symbol === requestedSymbol) || MAIN_PRICE_SYMBOLS[1];
    const requestedLimit = Number(req.query.limit || 8);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 30) : 8;
    const rows = await db.all(
      `SELECT *
       FROM market_physical_observations
       WHERE asset_symbol = ?
       ORDER BY observation_date DESC, id DESC
       LIMIT ?`,
      [symbolConfig.symbol, limit]
    );
    const latestMarket = await db.get(
      `SELECT trade_date, close
       FROM market_anchor_daily_prices
       WHERE symbol = ?
         AND source = ?
         AND close IS NOT NULL
       ORDER BY trade_date DESC, id DESC
       LIMIT 1`,
      [symbolConfig.symbol, symbolConfig.source]
    );
    const items = rows.map(serializePhysicalObservation);
    const latest = items[0] || null;

    res.json({
      success: true,
      data: {
        symbol: symbolConfig,
        latest_market: latestMarket
          ? { trade_date: latestMarket.trade_date, close: Number(latestMarket.close) }
          : null,
        latest,
        guidance: buildPhysicalGuidance(latest),
        items
      }
    });
  } catch (error) {
    res.status(200).json({
      success: false,
      message: (error as Error).message || "贵金属实物端观察读取失败",
      data: { items: [], latest: null, guidance: buildPhysicalGuidance(null) }
    });
  }
});

router.post("/precious-metal-market/physical-observations", async (req, res) => {
  try {
    const db = await getDb();
    const body = req.body || {};
    const requestedSymbol = String(body.symbol || "SGE_AGTD").trim().toUpperCase();
    const symbolConfig = MAIN_PRICE_SYMBOLS.find(item => item.symbol === requestedSymbol) || MAIN_PRICE_SYMBOLS[1];
    const observationDate = normalizeDate(body.observation_date);
    const latestMarket = await db.get(
      `SELECT trade_date, close
       FROM market_anchor_daily_prices
       WHERE symbol = ?
         AND source = ?
         AND close IS NOT NULL
       ORDER BY trade_date DESC, id DESC
       LIMIT 1`,
      [symbolConfig.symbol, symbolConfig.source]
    );
    const referenceClose = parseOptionalNumber(body.reference_close) ?? (
      latestMarket?.close === null || latestMarket?.close === undefined ? null : Number(latestMarket.close)
    );
    const merchantSellPrice = parseOptionalNumber(body.merchant_sell_price);
    const buybackPrice = parseOptionalNumber(body.buyback_price);
    const merchantSellPremium = parseOptionalNumber(body.merchant_sell_premium)
      ?? (merchantSellPrice !== null && referenceClose !== null ? roundNumber(merchantSellPrice - referenceClose) : null);
    const buybackPremium = parseOptionalNumber(body.buyback_premium)
      ?? (buybackPrice !== null && referenceClose !== null ? roundNumber(buybackPrice - referenceClose) : null);
    const supplyStatus = normalizeText(body.supply_status) || "unknown";
    const transactionHeat = normalizeText(body.transaction_heat) || "unknown";
    const socialHeat = normalizeText(body.social_heat) || "unknown";
    const sourceNote = normalizeText(body.source_note);
    const note = normalizeText(body.note);

    if (!note && !sourceNote && merchantSellPrice === null && buybackPrice === null && supplyStatus === "unknown" && transactionHeat === "unknown" && socialHeat === "unknown") {
      res.status(400).json({ success: false, message: "至少补一项实物端观察", data: null });
      return;
    }

    const result = await db.run(
      `INSERT INTO market_physical_observations
        (asset_symbol, asset_label, observation_date, reference_close, merchant_sell_price, merchant_sell_premium, buyback_price, buyback_premium, supply_status, transaction_heat, social_heat, reliability, source_note, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        symbolConfig.symbol,
        symbolConfig.label,
        observationDate,
        referenceClose,
        merchantSellPrice,
        merchantSellPremium,
        buybackPrice,
        buybackPremium,
        supplyStatus,
        transactionHeat,
        socialHeat,
        "manual_limited",
        sourceNote,
        note
      ]
    );
    const created = await db.get(
      `SELECT *
       FROM market_physical_observations
       WHERE id = ?`,
      [result.lastID]
    );
    const item = serializePhysicalObservation(created);
    await writePhysicalObservationAuditLog(db, item);

    res.json({
      success: true,
      message: "实物端观察已记录",
      data: {
        item,
        guidance: buildPhysicalGuidance(item)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: (error as Error).message || "贵金属实物端观察保存失败",
      data: null
    });
  }
});

router.get("/precious-metal-market/current-signal", async (req, res) => {
  try {
    const db = await getDb();
    const requestedSymbol = String(req.query.symbol || "SGE_AGTD").trim().toUpperCase();
    const symbolConfig = MAIN_PRICE_SYMBOLS.find(item => item.symbol === requestedSymbol) || MAIN_PRICE_SYMBOLS[1];
    const defaultRuleGroup = symbolConfig.symbol === "XAUUSD" ? "precious_metal_plan" : "silver_swing_plan";
    const ruleGroup = String(req.query.rule_group || defaultRuleGroup).trim();
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
          volatility_phase: null,
          state_steps: [],
          metrics: null
        }
      });
      return;
    }

    const evaluation = evaluateSilverSwingRules(points, rules);
    const recentTargetDates = points.slice(-45).map(point => String(point.trade_date || point.date || ""));
    const recentEvaluations = recentTargetDates
      .filter(Boolean)
      .map(date => evaluateSilverSwingRules(points, rules, date));
    res.json({
      success: true,
      data: buildCurrentSignalPayload(symbolConfig, evaluation, ruleRows, ruleGroup, recentEvaluations)
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

router.get("/precious-metal-market/coin-silver-premium-context", async (req, res) => {
  try {
    const refreshParam = String(req.query.refresh || "none").trim();
    const refresh = refreshParam === "force"
      ? "force"
      : refreshParam === "stale"
        ? "stale"
        : "none";
    const data = await getCoinSilverPremiumContext({
      objectName: normalizeText(req.query.object_name),
      variantName: normalizeText(req.query.variant_name),
      refresh
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(200).json({
      success: false,
      message: (error as Error).message || "纪念币银本体溢价上下文读取失败",
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
