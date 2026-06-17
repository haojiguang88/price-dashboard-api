import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import {
  clusterRuleHits,
  evaluateSilverSwingRules,
  type MarketAssistRuleInput,
  type MarketPricePoint,
  type SilverSwingEvaluation
} from "../../src/services/marketAssistEvaluator";

const dbPath = process.env.BUSINESS_DB_PATH || path.resolve(process.cwd(), "data/price_dashboard_business_dev.db");
const reportDate = new Date().toISOString().slice(0, 10);
const defaultOut = path.resolve(process.cwd(), `reports/business/precious-metal-cycle-context-${reportDate}.md`);
const outPath = process.env.OUT || defaultOut;

type SymbolKey = "SGE_AGTD" | "XAUUSD";

interface AssetConfig {
  symbol: SymbolKey;
  label: string;
  ruleGroup: "silver_swing_plan" | "precious_metal_plan";
  role: string;
  swingThresholdPercent: number;
  digits: number;
  sampleWindows: Array<{ label: string; start: string; end: string }>;
}

interface AssetPoint extends MarketPricePoint {
  trade_date: string;
  close: number;
}

interface SwingSegment {
  from: string;
  fromClose: number;
  to: string;
  toClose: number;
  changePercent: number;
  days: number;
}

const configs: AssetConfig[] = [
  {
    symbol: "SGE_AGTD",
    label: "白银延期 Ag(T+D)",
    ruleGroup: "silver_swing_plan",
    role: "白银实物波段执行锚",
    swingThresholdPercent: 25,
    digits: 3,
    sampleWindows: [
      { label: "2008金融危机", start: "2008-01-01", end: "2008-12-31" },
      { label: "2011白银泡沫/长熊起点", start: "2011-01-01", end: "2011-12-31" },
      { label: "2020疫情冲击/修复", start: "2020-01-01", end: "2020-12-31" },
      { label: "2026本轮极端样本", start: "2026-01-01", end: "2026-12-31" }
    ]
  },
  {
    symbol: "XAUUSD",
    label: "黄金现货 XAUUSD",
    ruleGroup: "precious_metal_plan",
    role: "黄金背景锚，只作贵金属天气参考",
    swingThresholdPercent: 20,
    digits: 2,
    sampleWindows: [
      { label: "1980泡沫尾段", start: "1980-01-01", end: "1980-12-31" },
      { label: "2008金融危机", start: "2008-01-01", end: "2008-12-31" },
      { label: "2011高点/2013破位", start: "2011-01-01", end: "2013-12-31" },
      { label: "2020疫情冲击/修复", start: "2020-01-01", end: "2020-12-31" },
      { label: "2026本轮极端样本", start: "2026-01-01", end: "2026-12-31" }
    ]
  }
];

const ruleLabels: Record<string, string> = {
  extreme_volatility: "极端高波动",
  high_volatility: "高波动",
  fast_rise: "暴涨",
  overheat_rise: "连续过热",
  ma250_stretch: "远离年线",
  slow_rise: "慢涨",
  fast_drop: "暴跌",
  falling_knife: "飞刀",
  slow_decline: "阴跌",
  sideways: "横盘",
  medium_sideways: "中期横盘",
  healthy_pullback: "回踩不破"
};

const priorityOrder = [
  "extreme_volatility",
  "falling_knife",
  "fast_drop",
  "overheat_rise",
  "fast_rise",
  "ma250_stretch",
  "high_volatility",
  "slow_decline",
  "healthy_pullback",
  "medium_sideways",
  "sideways",
  "slow_rise"
];

const percentChange = (start: number | null | undefined, end: number | null | undefined) => {
  if (!start || end === null || end === undefined) return null;
  return ((end - start) / start) * 100;
};

const round = (value: number | null | undefined, digits = 2) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
};

const formatNumber = (value: number | null | undefined, digits = 2) => {
  const rounded = round(value, digits);
  if (rounded === null) return "-";
  return rounded.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
};

const formatPct = (value: number | null | undefined) => {
  const rounded = round(value, 2);
  if (rounded === null) return "-";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}%`;
};

const daysBetween = (start: string, end: string) => {
  const startTime = new Date(`${start}T00:00:00Z`).getTime();
  const endTime = new Date(`${end}T00:00:00Z`).getTime();
  return Math.round((endTime - startTime) / 86_400_000);
};

const hitLabels = (evaluation: SilverSwingEvaluation) => (
  evaluation.hitRuleKeys.map(key => ruleLabels[key] || key).join(" / ") || "无"
);

const primaryState = (evaluation: SilverSwingEvaluation) => {
  const hit = priorityOrder.find(ruleKey => evaluation.hitRuleKeys.includes(ruleKey));
  return hit ? ruleLabels[hit] || hit : "中性";
};

const permissionLayer = (evaluation: SilverSwingEvaluation) => {
  const hits = new Set(evaluation.hitRuleKeys);
  if (hits.has("extreme_volatility") || hits.has("falling_knife") || hits.has("fast_drop")) return "P0 买入关闭";
  if (hits.has("fast_rise") || hits.has("overheat_rise") || hits.has("ma250_stretch")) return "P5 只卖不买";
  if (hits.has("high_volatility") || hits.has("slow_decline")) return "P1 降权复核";
  if (hits.has("healthy_pullback") || hits.has("medium_sideways") || hits.has("sideways")) return "P2 小批次观察";
  if (hits.has("slow_rise")) return "P2 慢涨观察，不追";
  return "P4 正常计划复核";
};

const loadAsset = async (db: Awaited<ReturnType<typeof open>>, config: AssetConfig) => {
  const points = await db.all<AssetPoint[]>(
    `SELECT trade_date, close
     FROM market_anchor_daily_prices
     WHERE symbol = ?
       AND close IS NOT NULL
     ORDER BY trade_date ASC`,
    [config.symbol]
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

const yearlyTable = (config: AssetConfig, points: AssetPoint[], direction: "best" | "worst") => {
  const byYear = new Map<string, AssetPoint[]>();
  for (const point of points) {
    const year = point.trade_date.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) || []), point]);
  }

  const rows = [...byYear.entries()].map(([year, yearPoints]) => {
    const first = yearPoints[0];
    const last = yearPoints[yearPoints.length - 1];
    const low = yearPoints.reduce((candidate, point) => point.close < candidate.close ? point : candidate, yearPoints[0]);
    const high = yearPoints.reduce((candidate, point) => point.close > candidate.close ? point : candidate, yearPoints[0]);
    return {
      year,
      returnPercent: percentChange(first.close, last.close) || 0,
      amplitudePercent: percentChange(low.close, high.close) || 0,
      low,
      high
    };
  });

  rows.sort((a, b) => direction === "best"
    ? b.returnPercent - a.returnPercent
    : a.returnPercent - b.returnPercent
  );

  return [
    "| 年份 | 年收益 | 年内振幅 | 年内低点 | 年内高点 |",
    "|---|---:|---:|---:|---:|",
    ...rows.slice(0, 5).map(row => (
      `| ${row.year} | ${formatPct(row.returnPercent)} | ${formatPct(row.amplitudePercent)} | ${row.low.trade_date} ${formatNumber(row.low.close, config.digits)} | ${row.high.trade_date} ${formatNumber(row.high.close, config.digits)} |`
    ))
  ].join("\n");
};

const swingSegments = (points: AssetPoint[], thresholdPercent: number) => {
  if (!points.length) return [];
  const nodes: Array<{ type: "peak" | "trough"; date: string; close: number }> = [];
  let direction: "up" | "down" | null = null;
  let extreme = points[0];
  let startingType: "peak" | "trough" = "trough";

  for (const point of points.slice(1)) {
    if (!direction) {
      const change = percentChange(extreme.close, point.close) || 0;
      if (change >= thresholdPercent) {
        direction = "up";
        startingType = "trough";
        nodes.push({ type: startingType, date: extreme.trade_date, close: extreme.close });
        extreme = point;
      } else if (change <= -thresholdPercent) {
        direction = "down";
        startingType = "peak";
        nodes.push({ type: startingType, date: extreme.trade_date, close: extreme.close });
        extreme = point;
      } else if (point.close < extreme.close && startingType === "trough") {
        extreme = point;
      } else if (point.close > extreme.close && startingType === "peak") {
        extreme = point;
      }
      continue;
    }

    if (direction === "up") {
      if (point.close > extreme.close) {
        extreme = point;
      } else if ((percentChange(extreme.close, point.close) || 0) <= -thresholdPercent) {
        nodes.push({ type: "peak", date: extreme.trade_date, close: extreme.close });
        direction = "down";
        extreme = point;
      }
    } else if (point.close < extreme.close) {
      extreme = point;
    } else if ((percentChange(extreme.close, point.close) || 0) >= thresholdPercent) {
      nodes.push({ type: "trough", date: extreme.trade_date, close: extreme.close });
      direction = "up";
      extreme = point;
    }
  }

  if (direction) {
    nodes.push({ type: direction === "up" ? "peak" : "trough", date: extreme.trade_date, close: extreme.close });
  }

  const segments: SwingSegment[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const from = nodes[index - 1];
    const to = nodes[index];
    segments.push({
      from: from.date,
      fromClose: from.close,
      to: to.date,
      toClose: to.close,
      changePercent: percentChange(from.close, to.close) || 0,
      days: daysBetween(from.date, to.date)
    });
  }
  return segments;
};

const swingTable = (config: AssetConfig, segments: SwingSegment[], direction: "bull" | "bear") => {
  const rows = segments
    .filter(segment => direction === "bull" ? segment.changePercent > 0 : segment.changePercent < 0)
    .sort((a, b) => direction === "bull"
      ? b.changePercent - a.changePercent
      : a.changePercent - b.changePercent
    )
    .slice(0, 8);

  return [
    "| 起点 | 终点 | 幅度 | 天数 |",
    "|---|---|---:|---:|",
    ...rows.map(row => (
      `| ${row.from} ${formatNumber(row.fromClose, config.digits)} | ${row.to} ${formatNumber(row.toClose, config.digits)} | ${formatPct(row.changePercent)} | ${row.days} |`
    ))
  ].join("\n");
};

const allTimeBlock = (config: AssetConfig, points: AssetPoint[]) => {
  let low = points[0];
  let high = points[0];
  let maxRun = { from: points[0], to: points[0], changePercent: 0 };
  let maxDrawdown = { from: points[0], to: points[0], changePercent: 0 };

  for (const point of points) {
    if (point.close < low.close) low = point;
    const run = percentChange(low.close, point.close) || 0;
    if (run > maxRun.changePercent) maxRun = { from: low, to: point, changePercent: run };

    if (point.close > high.close) high = point;
    const drawdown = percentChange(high.close, point.close) || 0;
    if (drawdown < maxDrawdown.changePercent) maxDrawdown = { from: high, to: point, changePercent: drawdown };
  }

  return [
    `- 最大涨幅链：${maxRun.from.trade_date} ${formatNumber(maxRun.from.close, config.digits)} -> ${maxRun.to.trade_date} ${formatNumber(maxRun.to.close, config.digits)}，${formatPct(maxRun.changePercent)}`,
    `- 最大回撤链：${maxDrawdown.from.trade_date} ${formatNumber(maxDrawdown.from.close, config.digits)} -> ${maxDrawdown.to.trade_date} ${formatNumber(maxDrawdown.to.close, config.digits)}，${formatPct(maxDrawdown.changePercent)}`
  ].join("\n");
};

const firstHitIndexes = (evaluations: SilverSwingEvaluation[], ruleKey: string) => {
  const indexes: number[] = [];
  let previousHit = false;
  evaluations.forEach((evaluation, index) => {
    const hit = evaluation.hitRuleKeys.includes(ruleKey);
    if (hit && !previousHit) indexes.push(index);
    previousHit = hit;
  });
  return indexes;
};

const outcomeStats = (evaluations: SilverSwingEvaluation[], indexes: number[], days: number) => {
  const values = indexes
    .filter(index => index + days < evaluations.length)
    .map(index => percentChange(evaluations[index].close, evaluations[index + days].close))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  if (!values.length) {
    return { count: 0, average: null, median: null, worst: null, best: null };
  }

  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const median = values[Math.floor(values.length / 2)];
  return {
    count: values.length,
    average,
    median,
    worst: values[0],
    best: values[values.length - 1]
  };
};

const clusterStartIndexes = (evaluations: SilverSwingEvaluation[], ruleKey: string) => {
  const indexByDate = new Map(evaluations.map((evaluation, index) => [evaluation.date, index]));
  return clusterRuleHits(evaluations, ruleKey, 2)
    .map((cluster: { start: string }) => indexByDate.get(cluster.start))
    .filter((index): index is number => index !== undefined);
};

const windowedEvaluations = (
  evaluations: SilverSwingEvaluation[],
  window: { start: string; end: string }
) => evaluations.filter(evaluation => evaluation.date >= window.start && evaluation.date <= window.end);

const forwardOutcomeTable = (evaluations: SilverSwingEvaluation[]) => {
  const rules = ["fast_rise", "overheat_rise", "fast_drop", "falling_knife", "slow_decline", "sideways", "medium_sideways", "healthy_pullback"];
  return [
    "| 信号 | 起点数 | 后5日中位 | 后20日中位 | 后60日中位 | 后20日最差 |",
    "|---|---:|---:|---:|---:|---:|",
    ...rules.map(ruleKey => {
      const indexes = firstHitIndexes(evaluations, ruleKey);
      const d5 = outcomeStats(evaluations, indexes, 5);
      const d20 = outcomeStats(evaluations, indexes, 20);
      const d60 = outcomeStats(evaluations, indexes, 60);
      return `| ${ruleLabels[ruleKey] || ruleKey} | ${indexes.length} | ${formatPct(d5.median)} | ${formatPct(d20.median)} | ${formatPct(d60.median)} | ${formatPct(d20.worst)} |`;
    })
  ].join("\n");
};

const clusteredForwardOutcomeTable = (evaluations: SilverSwingEvaluation[]) => {
  const rules = ["fast_rise", "overheat_rise", "fast_drop", "falling_knife", "slow_decline", "sideways", "medium_sideways", "healthy_pullback"];
  return [
    "| 信号簇 | 簇数 | 后5日中位 | 后20日中位 | 后60日中位 | 后20日最差 |",
    "|---|---:|---:|---:|---:|---:|",
    ...rules.map(ruleKey => {
      const indexes = clusterStartIndexes(evaluations, ruleKey);
      const d5 = outcomeStats(evaluations, indexes, 5);
      const d20 = outcomeStats(evaluations, indexes, 20);
      const d60 = outcomeStats(evaluations, indexes, 60);
      return `| ${ruleLabels[ruleKey] || ruleKey} | ${indexes.length} | ${formatPct(d5.median)} | ${formatPct(d20.median)} | ${formatPct(d60.median)} | ${formatPct(d20.worst)} |`;
    })
  ].join("\n");
};

const fixedWindowTable = (config: AssetConfig, points: AssetPoint[], evaluations: SilverSwingEvaluation[]) => {
  return [
    "| 固定样本窗口 | 起止价格 | 区间涨跌 | 区间振幅 | 极端高波动簇 | 高波动簇 | 暴涨簇 | 暴跌/飞刀簇 | 当前用途 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---|",
    ...config.sampleWindows.map(window => {
      const windowPoints = points.filter(point => point.trade_date >= window.start && point.trade_date <= window.end);
      const windowEvaluations = windowedEvaluations(evaluations, window);
      if (!windowPoints.length || !windowEvaluations.length) {
        return `| ${window.label} | 无本地数据 | - | - | - | - | - | - | 不参与统计 |`;
      }

      const first = windowPoints[0];
      const last = windowPoints[windowPoints.length - 1];
      const low = windowPoints.reduce((candidate, point) => point.close < candidate.close ? point : candidate, windowPoints[0]);
      const high = windowPoints.reduce((candidate, point) => point.close > candidate.close ? point : candidate, windowPoints[0]);
      const fastDropClusters = clusterRuleHits(windowEvaluations, "fast_drop", 2).length
        + clusterRuleHits(windowEvaluations, "falling_knife", 2).length;
      const useCase = window.label.includes("2026")
        ? "当前新样本，先验证不调参"
        : "历史对照，防止只贴合当前";

      return [
        `| ${window.label}`,
        `${first.trade_date} ${formatNumber(first.close, config.digits)} -> ${last.trade_date} ${formatNumber(last.close, config.digits)}`,
        formatPct(percentChange(first.close, last.close)),
        formatPct(percentChange(low.close, high.close)),
        clusterRuleHits(windowEvaluations, "extreme_volatility", 2).length,
        clusterRuleHits(windowEvaluations, "high_volatility", 2).length,
        clusterRuleHits(windowEvaluations, "fast_rise", 2).length,
        fastDropClusters,
        `${useCase} |`
      ].join(" | ");
    })
  ].join("\n");
};

const clusterTable = (evaluations: SilverSwingEvaluation[], rules: string[]) => {
  const rows = rules.flatMap(ruleKey => (
    clusterRuleHits(evaluations, ruleKey, 2).map((cluster: { start: string; end: string; days: number }) => ({
      ruleKey,
      ...cluster
    }))
  ));
  rows.sort((a, b) => a.start.localeCompare(b.start));

  return [
    "| 规则簇 | 开始 | 结束 | 命中天数 |",
    "|---|---|---|---:|",
    ...rows.slice(-16).map(row => (
      `| ${ruleLabels[row.ruleKey] || row.ruleKey} | ${row.start} | ${row.end} | ${row.days} |`
    ))
  ].join("\n");
};

const findLastExtremeCluster = (evaluations: SilverSwingEvaluation[]) => (
  clusterRuleHits(evaluations, "extreme_volatility", 2).at(-1) || null
);

const findCurrentBullAndBear = (segments: SwingSegment[], latest: AssetPoint) => {
  const previousBull = [...segments]
    .filter(segment => segment.changePercent > 0 && segment.to <= latest.trade_date)
    .sort((a, b) => b.to.localeCompare(a.to))[0] || null;
  const currentBear = previousBull
    ? [...segments]
      .filter(segment => segment.changePercent < 0 && segment.from === previousBull.to)
      .sort((a, b) => b.to.localeCompare(a.to))[0] || null
    : null;
  return { previousBull, currentBear };
};

const currentNodeBlock = (config: AssetConfig, points: AssetPoint[], evaluations: SilverSwingEvaluation[], segments: SwingSegment[]) => {
  const latestPoint = points[points.length - 1];
  const latest = evaluations[evaluations.length - 1];
  const lastExtreme = findLastExtremeCluster(evaluations);
  const { previousBull, currentBear } = findCurrentBullAndBear(segments, latestPoint);
  const latestDrawdown = previousBull
    ? percentChange(previousBull.toClose, latestPoint.close)
    : null;

  const lines = [
    `- 最新节点：${latest.date}，价格 ${formatNumber(latest.close, config.digits)}`,
    `- 当前命中：${hitLabels(latest)}`,
    `- 主状态：${primaryState(latest)}；权限层：${permissionLayer(latest)}`,
    `- 5日 ${formatPct(latest.metrics.return5dPercent)}，20日 ${formatPct(latest.metrics.return20dPercent)}，20日振幅 ${formatPct(latest.metrics.range20dPercent)}，距MA250 ${formatPct(latest.metrics.closeVsMa250Percent)}`
  ];

  if (previousBull) {
    lines.push(`- 最近大牛段：${previousBull.from} ${formatNumber(previousBull.fromClose, config.digits)} -> ${previousBull.to} ${formatNumber(previousBull.toClose, config.digits)}，${formatPct(previousBull.changePercent)}`);
  }
  if (currentBear) {
    lines.push(`- 牛后回撤段：${currentBear.from} ${formatNumber(currentBear.fromClose, config.digits)} -> ${currentBear.to} ${formatNumber(currentBear.toClose, config.digits)}，${formatPct(currentBear.changePercent)}`);
  }
  if (latestDrawdown !== null) {
    lines.push(`- 最新价相对最近牛段高点回撤：${formatPct(latestDrawdown)}`);
  }
  if (lastExtreme) {
    lines.push(`- 最近极端高波动簇：${lastExtreme.start} ~ ${lastExtreme.end}，命中 ${lastExtreme.days} 天`);
  }

  if (config.symbol === "SGE_AGTD") {
    lines.push("");
    lines.push("当前接入历史坐标：超级牛市后、极端高波动长簇之后、崩盘反抽再回落的验证样本。它不是普通低位机会，后续每天主要验证是否从 P0/P1 风险区走进横盘/修复区。");
    lines.push("雷达口径：只提示风险层、阶段位置和需要继续观察的结构，不主动开车，不自动生成买卖许可。");
  }

  return lines.join("\n");
};

const buildAssetReport = (config: AssetConfig, points: AssetPoint[], evaluations: SilverSwingEvaluation[]) => {
  const segments = swingSegments(points, config.swingThresholdPercent);
  const lines: string[] = [];

  lines.push(`## ${config.label}`);
  lines.push("");
  lines.push(`- 角色：${config.role}`);
  lines.push(`- 数据：${points[0]?.trade_date} ~ ${points[points.length - 1]?.trade_date}，${points.length} 条`);
  lines.push("");
  lines.push("### 当前节点接入");
  lines.push("");
  lines.push(currentNodeBlock(config, points, evaluations, segments));
  lines.push("");
  lines.push("### 全历史极值链");
  lines.push("");
  lines.push(allTimeBlock(config, points));
  lines.push("");
  lines.push("### 牛市阶段表");
  lines.push("");
  lines.push(swingTable(config, segments, "bull"));
  lines.push("");
  lines.push("### 崩盘阶段表");
  lines.push("");
  lines.push(swingTable(config, segments, "bear"));
  lines.push("");
  lines.push("### 年度强弱榜");
  lines.push("");
  lines.push("#### 最强年份");
  lines.push("");
  lines.push(yearlyTable(config, points, "best"));
  lines.push("");
  lines.push("#### 最弱年份");
  lines.push("");
  lines.push(yearlyTable(config, points, "worst"));
  lines.push("");
  lines.push("### 近期规则簇");
  lines.push("");
  lines.push(clusterTable(evaluations, ["extreme_volatility", "high_volatility", "overheat_rise", "fast_rise", "fast_drop", "falling_knife"]));
  lines.push("");
  lines.push("### 固定样本窗口");
  lines.push("");
  lines.push(fixedWindowTable(config, points, evaluations));
  lines.push("");
  lines.push("### 按行情簇后验表");
  lines.push("");
  lines.push(clusteredForwardOutcomeTable(evaluations));
  lines.push("");
  lines.push("### 单日起点后验表（降权参考）");
  lines.push("");
  lines.push(forwardOutcomeTable(evaluations));
  lines.push("");

  return lines.join("\n");
};

const main = async () => {
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  try {
    const sections = [
      "# 贵金属周期节点上下文报告",
      "",
      `生成时间：${new Date().toISOString()}`,
      "",
      "说明：本报告只读本地行情锚点和现有规则评估器，不修改规则、不生成买卖建议。用途是把当前节点接入历史牛熊、崩盘和信号后验坐标，作为风险雷达辅助后续阈值验证。",
      "",
      "防过拟合约束：优先看行情簇而不是单日；固定样本窗口分开看，不把 2011、2020、2026 混成一个胜率；当前 2026 样本先进入验证，不因单轮行情直接改阈值。",
      ""
    ];

    for (const config of configs) {
      const { points, evaluations } = await loadAsset(db, config);
      sections.push(buildAssetReport(config, points, evaluations));
    }

    sections.push("## 使用口径");
    sections.push("");
    sections.push("- 当前节点不是孤立价格，要先挂到历史阶段：大牛段、崩盘段、反抽段、冷却段。");
    sections.push("- 优先看行情簇后验，单日起点后验只作降权参考，避免一轮行情被重复计数。");
    sections.push("- 固定样本窗口分开看：历史窗口用于防过拟合，当前窗口用于验证，不直接调参。");
    sections.push("- 暴涨、连续过热、飞刀、暴跌的后验只用于验证纪律，不用于预测下一天。");
    sections.push("- 白银实物侧只在高波动/飞刀/阴跌/远离年线等拦截解除后，才讨论横盘或回踩不破带来的小批次复核。");
    sections.push("- 黄金仍然只作贵金属天气锚，不能单独授予白银买卖权限。");
    sections.push("- 这份报告是雷达，不是方向盘；它负责发现风险和阶段位置，不负责主动开车。");
    sections.push("");

    const report = sections.join("\n");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report, "utf8");
    console.log(report);
    console.log(`\nReport written: ${outPath}`);
  } finally {
    await db.close();
  }
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
