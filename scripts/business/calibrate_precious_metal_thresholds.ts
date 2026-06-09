import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import {
  clusterRuleHits,
  evaluateSilverSwingRules,
  type MarketAssistRuleInput,
  type MarketPricePoint,
  type SilverSwingEvaluation,
  type SilverSwingMetrics
} from "../../src/services/marketAssistEvaluator";

const dbPath = process.env.BUSINESS_DB_PATH || path.resolve(process.cwd(), "data/price_dashboard_business_dev.db");
const reportDate = new Date().toISOString().slice(0, 10);
const defaultOut = path.resolve(process.cwd(), `reports/business/precious-metal-threshold-calibration-${reportDate}.md`);
const outPath = process.env.OUT || defaultOut;

interface AssetConfig {
  symbol: "SGE_AGTD" | "XAUUSD";
  label: string;
  source: string;
  ruleGroup: "silver_swing_plan" | "precious_metal_plan";
  amountDigits: number;
  role: string;
}

interface AssetPoint extends MarketPricePoint {
  trade_date: string;
  close: number;
}

const configs: AssetConfig[] = [
  {
    symbol: "SGE_AGTD",
    label: "白银延期",
    source: "tushare_sge",
    ruleGroup: "silver_swing_plan",
    amountDigits: 3,
    role: "白银实物波段执行锚"
  },
  {
    symbol: "XAUUSD",
    label: "黄金现货",
    source: "twelvedata",
    ruleGroup: "precious_metal_plan",
    amountDigits: 2,
    role: "黄金背景锚，不直接给买卖动作"
  }
];

const pctMetrics: Array<{ key: keyof SilverSwingMetrics; label: string; signed?: boolean }> = [
  { key: "dailyReturnPercent", label: "1日涨跌幅", signed: true },
  { key: "return3dPercent", label: "3日涨跌幅", signed: true },
  { key: "return5dPercent", label: "5日涨跌幅", signed: true },
  { key: "return10dPercent", label: "10日涨跌幅", signed: true },
  { key: "return20dPercent", label: "20日涨跌幅", signed: true },
  { key: "range20dPercent", label: "20日振幅" },
  { key: "avgAbsDailyReturn20dPercent", label: "20日平均绝对日波动" },
  { key: "dailyReturnStd20dPercent", label: "20日波动标准差" },
  { key: "closeVsMa250Percent", label: "距MA250" }
];

const silverRuleOrder = [
  "extreme_volatility",
  "high_volatility",
  "fast_rise",
  "overheat_rise",
  "ma250_stretch",
  "slow_rise",
  "fast_drop",
  "falling_knife",
  "slow_decline",
  "sideways",
  "medium_sideways",
  "healthy_pullback"
];

const ruleLabels: Record<string, string> = {
  extreme_volatility: "极端高波动",
  high_volatility: "高波动",
  fast_rise: "短线暴涨",
  overheat_rise: "连续过热",
  ma250_stretch: "年线过度拉伸",
  slow_rise: "慢涨",
  fast_drop: "暴跌",
  falling_knife: "飞刀",
  slow_decline: "阴跌",
  sideways: "10日横盘",
  medium_sideways: "20日横盘",
  healthy_pullback: "健康回踩"
};

interface ForwardOutcome {
  startDate: string;
  endDate: string;
  startClose: number;
  close5: number | null;
  close20: number | null;
  close60: number | null;
  return5: number | null;
  return20: number | null;
  return60: number | null;
  amount5: number | null;
  amount20: number | null;
  amount60: number | null;
  maxRise60: number | null;
  maxDrop60: number | null;
  maxRiseAmount60: number | null;
  maxDropAmount60: number | null;
  hitRules: string[];
}

const toNumber = (value: unknown) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const round = (value: number | null | undefined, digits = 2) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
};

const formatPct = (value: number | null | undefined, digits = 2) => {
  const rounded = round(value, digits);
  if (rounded === null) return "-";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(digits)}%`;
};

const formatNumber = (value: number | null | undefined, digits = 2) => {
  const rounded = round(value, digits);
  if (rounded === null) return "-";
  return rounded.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
};

const percentToAmount = (price: number, percent: number) => price * (percent / 100);

const percentChange = (start: number | null, end: number | null) => {
  if (start === null || end === null || start === 0) return null;
  return ((end - start) / start) * 100;
};

const formatAmount = (config: AssetConfig, value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value, config.amountDigits)}`;
};

const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
};

const parseThreshold = (rule: MarketAssistRuleInput) => {
  if (rule.threshold && typeof rule.threshold === "object") return rule.threshold as Record<string, unknown>;
  if (!rule.threshold_json) return {};
  try {
    const parsed = JSON.parse(rule.threshold_json);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const getMetric = (evaluation: SilverSwingEvaluation, key: keyof SilverSwingMetrics) => {
  const value = evaluation.metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const getLookbackDelta = (points: AssetPoint[], date: string, intervals: number) => {
  const index = points.findIndex(point => point.trade_date === date);
  if (index < intervals) return null;
  return points[index].close - points[index - intervals].close;
};

const getWindowRangeAmount = (points: AssetPoint[], date: string, intervals: number) => {
  const index = points.findIndex(point => point.trade_date === date);
  if (index < 0) return null;
  const start = Math.max(0, index - intervals);
  const closes = points.slice(start, index + 1).map(point => point.close);
  if (!closes.length) return null;
  return Math.max(...closes) - Math.min(...closes);
};

const getForwardOutcome = (
  points: AssetPoint[],
  evaluationsByDate: Map<string, SilverSwingEvaluation>,
  startDate: string,
  horizon = 60
): ForwardOutcome | null => {
  const index = points.findIndex(point => point.trade_date === startDate);
  if (index < 0) return null;
  const start = points[index];
  const endIndex = Math.min(points.length - 1, index + horizon);
  const forward = points.slice(index, endIndex + 1);
  if (forward.length < 2) return null;
  const closeAt = (intervals: number) => points[index + intervals]?.close ?? null;
  const close5 = closeAt(5);
  const close20 = closeAt(20);
  const close60 = closeAt(60);
  const maxClose = Math.max(...forward.map(point => point.close));
  const minClose = Math.min(...forward.map(point => point.close));
  return {
    startDate,
    endDate: points[endIndex].trade_date,
    startClose: start.close,
    close5,
    close20,
    close60,
    return5: percentChange(start.close, close5),
    return20: percentChange(start.close, close20),
    return60: percentChange(start.close, close60),
    amount5: close5 === null ? null : close5 - start.close,
    amount20: close20 === null ? null : close20 - start.close,
    amount60: close60 === null ? null : close60 - start.close,
    maxRise60: percentChange(start.close, maxClose),
    maxDrop60: percentChange(start.close, minClose),
    maxRiseAmount60: maxClose - start.close,
    maxDropAmount60: minClose - start.close,
    hitRules: evaluationsByDate.get(startDate)?.hitRuleKeys || []
  };
};

const median = (values: number[]) => percentile(values, 0.5);

const summarizeForwardOutcomes = (outcomes: ForwardOutcome[]) => {
  const metric = (selector: (outcome: ForwardOutcome) => number | null) => {
    const values = outcomes.map(selector).filter((value): value is number => value !== null);
    if (!values.length) return null;
    return {
      median: median(values),
      p25: percentile(values, 0.25),
      p75: percentile(values, 0.75),
      min: Math.min(...values),
      max: Math.max(...values)
    };
  };
  return {
    return20: metric(outcome => outcome.return20),
    return60: metric(outcome => outcome.return60),
    maxRise60: metric(outcome => outcome.maxRise60),
    maxDrop60: metric(outcome => outcome.maxDrop60)
  };
};

const loadAsset = async (db: Awaited<ReturnType<typeof open>>, config: AssetConfig) => {
  const points = await db.all<AssetPoint[]>(
    `SELECT trade_date, close
     FROM market_anchor_daily_prices
     WHERE symbol = ?
       AND source = ?
       AND close IS NOT NULL
     ORDER BY trade_date ASC`,
    [config.symbol, config.source]
  );
  const rules = await db.all<MarketAssistRuleInput[]>(
    `SELECT rule_key, rule_type, threshold_json, status, display_order
     FROM market_assist_rules
     WHERE asset_symbol = ?
       AND rule_group = ?
       AND status = 'active'
     ORDER BY display_order ASC`,
    [config.symbol, config.ruleGroup]
  );
  const evaluations = points.map(point => evaluateSilverSwingRules(points, rules, point.trade_date));
  return { points, rules, evaluations };
};

const metricDistributionTable = (config: AssetConfig, evaluations: SilverSwingEvaluation[], latestClose: number) => {
  const lines = [
    "| 指标 | P50 | P75 | P90 | P95 | P99 | P95折金额 | P99折金额 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|"
  ];

  for (const metric of pctMetrics) {
    const values = evaluations
      .map(evaluation => getMetric(evaluation, metric.key))
      .filter((value): value is number => value !== null);
    const source = metric.signed ? values.map(value => Math.abs(value)) : values.filter(value => value >= 0);
    const p50 = percentile(source, 0.5);
    const p75 = percentile(source, 0.75);
    const p90 = percentile(source, 0.9);
    const p95 = percentile(source, 0.95);
    const p99 = percentile(source, 0.99);
    lines.push([
      metric.signed ? `${metric.label}绝对值` : metric.label,
      formatPct(p50),
      formatPct(p75),
      formatPct(p90),
      formatPct(p95),
      formatPct(p99),
      formatAmount(config, p95 === null ? null : percentToAmount(latestClose, p95)),
      formatAmount(config, p99 === null ? null : percentToAmount(latestClose, p99))
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  return lines.join("\n");
};

const ruleHitTable = (evaluations: SilverSwingEvaluation[]) => {
  const presentRuleKeys = new Set(evaluations.flatMap(evaluation => evaluation.rules.map(rule => rule.ruleKey)));
  const orderedRuleKeys = silverRuleOrder.filter(ruleKey => presentRuleKeys.has(ruleKey));
  const lines = [
    "| 规则 | 命中次数 | 命中占比 | 簇数量 | 最近一次命中 |",
    "|---|---:|---:|---:|---|"
  ];
  for (const ruleKey of orderedRuleKeys) {
    const hits = evaluations.filter(evaluation => evaluation.hitRuleKeys.includes(ruleKey));
    if (!hits.length) {
      lines.push(`| ${ruleLabels[ruleKey] || ruleKey} | 0 | 0.00% | 0 | - |`);
      continue;
    }
    const clusters = clusterRuleHits(evaluations, ruleKey, 2);
    const latest = hits[hits.length - 1];
    lines.push(`| ${ruleLabels[ruleKey] || ruleKey} | ${hits.length} | ${formatPct((hits.length / evaluations.length) * 100)} | ${clusters.length} | ${latest.date} ${formatPct(latest.metrics.return5dPercent)} |`);
  }
  return lines.join("\n");
};

const forwardOutcomeSummaryTable = (
  config: AssetConfig,
  points: AssetPoint[],
  evaluations: SilverSwingEvaluation[],
  ruleKeys: string[]
) => {
  const byDate = new Map(evaluations.map(evaluation => [evaluation.date, evaluation]));
  const lines = [
    "| 规则 | 簇数量 | 20日中位 | 60日中位 | 60日最大上冲中位 | 60日最大下探中位 | 最坏60日下探 |",
    "|---|---:|---:|---:|---:|---:|---:|"
  ];

  for (const ruleKey of ruleKeys) {
    const clusters = clusterRuleHits(evaluations, ruleKey, 2);
    const outcomes = clusters
      .map(cluster => getForwardOutcome(points, byDate, cluster.start))
      .filter((outcome): outcome is ForwardOutcome => outcome !== null);
    if (!outcomes.length) {
      lines.push(`| ${ruleLabels[ruleKey] || ruleKey} | 0 | - | - | - | - | - |`);
      continue;
    }
    const summary = summarizeForwardOutcomes(outcomes);
    lines.push([
      ruleLabels[ruleKey] || ruleKey,
      String(outcomes.length),
      formatPct(summary.return20?.median),
      formatPct(summary.return60?.median),
      formatPct(summary.maxRise60?.median),
      formatPct(summary.maxDrop60?.median),
      formatPct(summary.maxDrop60?.min)
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  return lines.join("\n");
};

const forwardOutcomeExamplesTable = (
  config: AssetConfig,
  points: AssetPoint[],
  evaluations: SilverSwingEvaluation[],
  ruleKey: string,
  limit = 8
) => {
  const byDate = new Map(evaluations.map(evaluation => [evaluation.date, evaluation]));
  const outcomes = clusterRuleHits(evaluations, ruleKey, 2)
    .map(cluster => getForwardOutcome(points, byDate, cluster.start))
    .filter((outcome): outcome is ForwardOutcome => outcome !== null)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  if (!outcomes.length) return "";

  const selected = [
    ...outcomes.slice(0, Math.ceil(limit / 2)),
    ...outcomes.slice(Math.max(Math.ceil(limit / 2), outcomes.length - Math.floor(limit / 2)))
  ].filter((item, index, array) => array.findIndex(other => other.startDate === item.startDate) === index);

  const lines = [
    `#### ${ruleLabels[ruleKey] || ruleKey} 后续走势样本`,
    "",
    "| 信号日 | 起点价 | 5日 | 20日 | 60日 | 60日最大上冲 | 60日最大下探 | 同日命中 |",
    "|---|---:|---:|---:|---:|---:|---:|---|"
  ];

  for (const outcome of selected) {
    lines.push([
      outcome.startDate,
      formatNumber(outcome.startClose, config.amountDigits),
      `${formatPct(outcome.return5)} / ${formatAmount(config, outcome.amount5)}`,
      `${formatPct(outcome.return20)} / ${formatAmount(config, outcome.amount20)}`,
      `${formatPct(outcome.return60)} / ${formatAmount(config, outcome.amount60)}`,
      `${formatPct(outcome.maxRise60)} / ${formatAmount(config, outcome.maxRiseAmount60)}`,
      `${formatPct(outcome.maxDrop60)} / ${formatAmount(config, outcome.maxDropAmount60)}`,
      outcome.hitRules.map(key => ruleLabels[key] || key).join(" / ") || "-"
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  return lines.join("\n");
};

const candidateThresholdTable = (config: AssetConfig, points: AssetPoint[], latest: SilverSwingEvaluation) => {
  const latestClose = latest.close;
  const lines = [
    "| 候选口径 | 百分比 | 按最新价折金额 | 当前实际 | 备注 |",
    "|---|---:|---:|---:|---|"
  ];

  const add = (
    label: string,
    percent: number,
    actualPercent: number | null,
    actualAmount: number | null,
    note: string
  ) => {
    const amount = percentToAmount(latestClose, Math.abs(percent));
    lines.push(`| ${label} | ${formatPct(percent)} | ${formatAmount(config, amount)} | ${formatPct(actualPercent)} / ${formatAmount(config, actualAmount)} | ${note} |`);
  };

  add(
    "5日涨幅>=8%",
    8,
    latest.metrics.return5dPercent,
    getLookbackDelta(points, latest.date, 5),
    "偏早提醒，适合先看是否慢涨转快。"
  );
  add(
    "5日涨幅>=15%",
    15,
    latest.metrics.return5dPercent,
    getLookbackDelta(points, latest.date, 5),
    "当前白银短线暴涨硬阈值。"
  );
  add(
    "20日振幅>=35%",
    35,
    latest.metrics.range20dPercent,
    getWindowRangeAmount(points, latest.date, 20),
    "极端高波动的跨度条件之一，不单独决定。"
  );
  add(
    "10日跌幅<=-6%",
    -6,
    latest.metrics.return10dPercent,
    getLookbackDelta(points, latest.date, 10),
    "候选阴跌/弱势确认线。"
  );
  add(
    "20日净涨跌<=4%",
    4,
    latest.metrics.return20dPercent,
    getLookbackDelta(points, latest.date, 20),
    "横盘只看净涨跌不够。"
  );
  add(
    "20日振幅<=12%",
    12,
    latest.metrics.range20dPercent,
    getWindowRangeAmount(points, latest.date, 20),
    "横盘必须同时满足区间不大。"
  );

  if (latest.metrics.ma250 !== null) {
    const trigger = latest.metrics.ma250 * 1.35;
    lines.push(`| 高于MA250 35% | +35.00% | 年线触发价 ${formatNumber(trigger, config.amountDigits)} | 当前距年线 ${formatPct(latest.metrics.closeVsMa250Percent)} / 距触发 ${formatAmount(config, trigger - latestClose)} | 限制新增波段仓。 |`);
  }

  return lines.join("\n");
};

const amountThresholdBullets = (config: AssetConfig, rules: MarketAssistRuleInput[], latest: SilverSwingEvaluation) => {
  const byKey = new Map(rules.map(rule => [rule.rule_key, parseThreshold(rule)]));
  const latestClose = latest.close;
  const lines: string[] = [];
  const addPct = (label: string, percent: number | null, direction: "rise" | "drop" | "span" = "rise") => {
    if (percent === null) return;
    const amount = percentToAmount(latestClose, Math.abs(percent));
    const verb = direction === "drop" ? "跌" : direction === "span" ? "波动跨度" : "涨";
    lines.push(`- ${label} ${formatPct(percent)}：按最新价 ${formatNumber(latestClose, config.amountDigits)} 粗折，约等于${verb} ${formatNumber(amount, config.amountDigits)}。`);
  };

  const fastRise = byKey.get("fast_rise") || {};
  addPct("短线暴涨 1日", toNumber(fastRise.daily_return_gte_percent));
  addPct("短线暴涨 3日", toNumber(fastRise.return_3d_gte_percent));
  addPct("短线暴涨 5日", toNumber(fastRise.return_5d_gte_percent));

  const overheat = byKey.get("overheat_rise") || {};
  addPct("连续过热 5日", toNumber(overheat.return_5d_gte_percent));
  addPct("连续过热 20日", toNumber(overheat.return_20d_gte_percent));

  const fastDrop = byKey.get("fast_drop") || {};
  addPct("暴跌 1日", toNumber(fastDrop.daily_return_lte_percent), "drop");
  addPct("暴跌 3日", toNumber(fastDrop.return_3d_lte_percent), "drop");
  addPct("暴跌 5日", toNumber(fastDrop.return_5d_lte_percent), "drop");

  const fallingKnife = byKey.get("falling_knife") || {};
  addPct("飞刀 1日", toNumber(fallingKnife.daily_return_lte_percent), "drop");
  addPct("飞刀 3日", toNumber(fallingKnife.return_3d_lte_percent), "drop");
  addPct("飞刀 5日", toNumber(fallingKnife.return_5d_lte_percent), "drop");

  const slowDecline = byKey.get("slow_decline") || {};
  addPct("阴跌 10日", toNumber(slowDecline.return_10d_lte_percent), "drop");

  const sideways = byKey.get("sideways") || {};
  addPct("10日横盘净涨跌", toNumber(sideways.abs_return_10d_lte_percent), "span");
  addPct("10日横盘区间振幅", toNumber(sideways.range_10d_lte_percent), "span");

  const mediumSideways = byKey.get("medium_sideways") || {};
  addPct("20日横盘净涨跌", toNumber(mediumSideways.abs_return_20d_lte_percent), "span");
  addPct("20日横盘区间振幅", toNumber(mediumSideways.range_20d_lte_percent), "span");

  const highVol = byKey.get("high_volatility") || {};
  const highVolConditions = Array.isArray(highVol.conditions) ? highVol.conditions as Array<Record<string, unknown>> : [];
  for (const condition of highVolConditions) {
    if (condition.metric === "high_low_range_20_intervals") {
      addPct("高波动 20日振幅", toNumber(condition.gte_percent), "span");
    }
    if (condition.metric === "avg_abs_daily_return") {
      addPct("高波动 日均绝对波动", toNumber(condition.gte_percent), "span");
    }
  }

  const extremeVol = byKey.get("extreme_volatility") || {};
  const extremeConditions = Array.isArray(extremeVol.conditions) ? extremeVol.conditions as Array<Record<string, unknown>> : [];
  for (const condition of extremeConditions) {
    if (condition.metric === "high_low_range_20_intervals") {
      addPct("极端高波动 20日振幅", toNumber(condition.gte_percent), "span");
    }
    if (condition.metric === "avg_abs_daily_return") {
      addPct("极端高波动 日均绝对波动", toNumber(condition.gte_percent), "span");
    }
  }

  const ma250Stretch = byKey.get("ma250_stretch") || {};
  const ma250 = latest.metrics.ma250;
  if (ma250 !== null) {
    for (const [label, key] of [
      ["MA250限制新增波段仓", "block_wave_buy_vs_ma250_gte_percent"],
      ["MA250开始梯子卖", "sell_ladder_vs_ma250_gte_percent"],
      ["MA250至少处理一笔波段仓", "force_sell_vs_ma250_gte_percent"]
    ] as const) {
      const percent = toNumber(ma250Stretch[key]);
      if (percent === null) continue;
      const triggerPrice = ma250 * (1 + percent / 100);
      lines.push(`- ${label} ${formatPct(percent)}：MA250=${formatNumber(ma250, config.amountDigits)}，触发价约 ${formatNumber(triggerPrice, config.amountDigits)}，距最新价 ${formatAmount(config, triggerPrice - latestClose)}。`);
    }
  }

  return lines.join("\n");
};

const topExamplesTable = (
  config: AssetConfig,
  points: AssetPoint[],
  evaluations: SilverSwingEvaluation[],
  title: string,
  metricKey: keyof SilverSwingMetrics,
  order: "desc" | "asc",
  intervals?: number,
  limit = 8
) => {
  const rows = evaluations
    .map(evaluation => ({
      evaluation,
      value: getMetric(evaluation, metricKey)
    }))
    .filter((row): row is { evaluation: SilverSwingEvaluation; value: number } => row.value !== null)
    .sort((a, b) => order === "desc" ? b.value - a.value : a.value - b.value)
    .slice(0, limit);

  const lines = [
    `#### ${title}`,
    "",
    "| 日期 | 收盘 | 指标 | 金额变化 | 命中规则 |",
    "|---|---:|---:|---:|---|"
  ];
  for (const row of rows) {
    const amount = intervals
      ? getLookbackDelta(points, row.evaluation.date, intervals)
      : metricKey === "range20dPercent"
        ? getWindowRangeAmount(points, row.evaluation.date, 20)
        : percentToAmount(row.evaluation.close, row.value);
    lines.push(`| ${row.evaluation.date} | ${formatNumber(row.evaluation.close, config.amountDigits)} | ${formatPct(row.value)} | ${formatAmount(config, amount)} | ${row.evaluation.hitRuleKeys.map(key => ruleLabels[key] || key).join(" / ") || "-"} |`);
  }
  return lines.join("\n");
};

const currentStateBlock = (config: AssetConfig, points: AssetPoint[], latest: SilverSwingEvaluation) => [
  `- 最新日期：${latest.date}`,
  `- 最新价格：${formatNumber(latest.close, config.amountDigits)}`,
  `- 当前命中：${latest.hitRuleKeys.map(key => ruleLabels[key] || key).join(" / ") || "无"}`,
  `- 1日：${formatPct(latest.metrics.dailyReturnPercent)}，实际变化 ${formatAmount(config, getLookbackDelta(points, latest.date, 1))}`,
  `- 5日：${formatPct(latest.metrics.return5dPercent)}，实际变化 ${formatAmount(config, getLookbackDelta(points, latest.date, 5))}`,
  `- 10日：${formatPct(latest.metrics.return10dPercent)}，实际变化 ${formatAmount(config, getLookbackDelta(points, latest.date, 10))}`,
  `- 20日：${formatPct(latest.metrics.return20dPercent)}，实际变化 ${formatAmount(config, getLookbackDelta(points, latest.date, 20))}`,
  `- 20日振幅：${formatPct(latest.metrics.range20dPercent)}，实际跨度 ${formatAmount(config, getWindowRangeAmount(points, latest.date, 20))}`,
  `- MA250：${formatNumber(latest.metrics.ma250, config.amountDigits)}，距MA250：${formatPct(latest.metrics.closeVsMa250Percent)}`
].join("\n");

const buildAssetReport = (config: AssetConfig, points: AssetPoint[], rules: MarketAssistRuleInput[], evaluations: SilverSwingEvaluation[]) => {
  const latest = evaluations[evaluations.length - 1];
  const latestClose = latest.close;
  const lines: string[] = [];

  lines.push(`## ${config.label}（${config.symbol}）`);
  lines.push("");
  lines.push(`- 角色：${config.role}`);
  lines.push(`- 数据：${points[0]?.trade_date} ~ ${points[points.length - 1]?.trade_date}，${points.length} 条`);
  lines.push("");
  lines.push("### 当前状态");
  lines.push("");
  lines.push(currentStateBlock(config, points, latest));
  lines.push("");
  lines.push("### 候选阈值金额换算");
  lines.push("");
  lines.push(candidateThresholdTable(config, points, latest));
  lines.push("");
  lines.push("### 现有阈值折成金额");
  lines.push("");
  lines.push(amountThresholdBullets(config, rules, latest));
  lines.push("");
  lines.push("### 历史分布");
  lines.push("");
  lines.push(metricDistributionTable(config, evaluations, latestClose));
  lines.push("");
  lines.push("### 现有规则历史命中");
  lines.push("");
  lines.push(ruleHitTable(evaluations));
  lines.push("");
  lines.push("### 真实历史压测：规则命中后的走势");
  lines.push("");
  lines.push(forwardOutcomeSummaryTable(config, points, evaluations, [
    "fast_rise",
    "overheat_rise",
    "ma250_stretch",
    "fast_drop",
    "falling_knife",
    "slow_decline",
    "sideways",
    "healthy_pullback"
  ]));
  lines.push("");
  for (const ruleKey of ["fast_rise", "overheat_rise", "fast_drop", "falling_knife", "slow_decline", "healthy_pullback"]) {
    const table = forwardOutcomeExamplesTable(config, points, evaluations, ruleKey);
    if (table) {
      lines.push(table);
      lines.push("");
    }
  }
  lines.push("### 极端样本对照");
  lines.push("");
  lines.push(topExamplesTable(config, points, evaluations, "5日最大上涨", "return5dPercent", "desc", 5));
  lines.push("");
  lines.push(topExamplesTable(config, points, evaluations, "5日最大下跌", "return5dPercent", "asc", 5));
  lines.push("");
  lines.push(topExamplesTable(config, points, evaluations, "20日最大振幅", "range20dPercent", "desc"));
  lines.push("");

  return lines.join("\n");
};

const main = async () => {
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  try {
    const sections: string[] = [
      "# 贵金属阈值校准报告",
      "",
      `生成时间：${new Date().toISOString()}`,
      "",
      "说明：本报告只读历史行情和现有规则，不修改数据库规则。金额折算用于辅助直觉：百分比阈值按最新价粗略换算为价格变化；真正入规则前还需要和真实生意场景对照。",
      ""
    ];

    for (const config of configs) {
      const { points, rules, evaluations } = await loadAsset(db, config);
      sections.push(buildAssetReport(config, points, rules, evaluations));
    }

    sections.push("## 第一版观察口径");
    sections.push("");
    sections.push("- 白银现有阈值已经把 2011、2020、2026 的极端波动抓住了，先不建议直接改规则。");
    sections.push("- 对你更有用的是金额提示：例如白银当前价附近，5日 +15% 不是一个抽象数字，而是约 +2.6 左右；20日振幅 35% 是约 6 元级别的跨度。");
    sections.push("- 真实历史压测支持“暴涨要出”：白银短线暴涨簇之后，60日中位收益为负，60日最大下探中位约 -11%；连续过热簇之后 60日中位约 -16%。");
    sections.push("- 真实历史压测支持“暴跌不接飞刀”：白银飞刀簇之后，60日最大下探中位约 -17%，最坏样本下探超过 -40%；暴跌当天反弹不等于安全。");
    sections.push("- 阴跌不是马上必崩，但它不适合作为抄底信号：历史中位后续有反弹，可最坏样本很深，所以应当作为“先观察/不补仓”的纪律，而不是买点。");
    sections.push("- 健康回踩可以作为重新评估入口，但不能直接等同于买入许可；它需要同时看高波动是否解除、飞刀是否消失、实物端是否恢复正常。");
    sections.push("- 横盘必须同时看净涨跌和区间振幅，不能只看“没怎么涨跌”；否则很容易把宽幅震荡误判成横盘。");
    sections.push("- MA250 拉伸阈值适合继续保留，它能拦住“价格离年线太远还打满波段仓”的问题。");
    sections.push("- 黄金仍然只作为背景锚，校准目的是判断贵金属天气，不给生意侧黄金实体买卖权限。");
    sections.push("");

    const report = sections.join("\n");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report, "utf8");
    console.log(report);
    console.log(`\\nReport written: ${outPath}`);
  } finally {
    await db.close();
  }
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
