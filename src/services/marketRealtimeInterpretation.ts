import type { SilverSwingEvaluation } from "./marketAssistEvaluator";

export interface MarketOhlcvPoint {
  trade_date?: string;
  date?: string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close: number | null;
  volume?: number | null;
  updated_at?: string | null;
}

export type MarketPermissionLayer = "P0" | "P1" | "P2" | "P3" | "P4" | "P5";

interface PrimaryStateInput {
  key: string;
  label: string;
  tone: string;
}

interface GoldContextInput {
  evaluation: SilverSwingEvaluation;
  latestPoint?: MarketOhlcvPoint | null;
}

interface NormalizedMarketPoint {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  updated_at: string | null;
}

export interface MarketRealtimeInterpretation {
  version: string;
  raw_state: {
    key: string;
    label: string;
  };
  repair_quality: {
    key: string;
    label: string;
    tone: string;
  };
  permission_layer: MarketPermissionLayer;
  permission_label: string;
  buy_permission: "closed" | "blocked" | "review_only" | "small_batch" | "normal";
  summary: string;
  action_hint: string;
  evidence: string[];
  upgrade_conditions: string[];
  invalidation_conditions: string[];
  gold_context: {
    label: string;
    tone: string;
    summary: string;
  } | null;
  data_notes: string[];
}

const toNumber = (value: unknown) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const percentChange = (start: number | null, end: number | null) => {
  if (start === null || end === null || start === 0) return null;
  return ((end - start) / start) * 100;
};

const formatSignedPercent = (value: number | null, digits = 1) => {
  if (value === null) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
};

const formatPrice = (value: number | null, digits = 3) => (
  value === null ? "-" : value.toFixed(digits)
);

const normalizePoints = (points: MarketOhlcvPoint[]) => points
  .map(point => ({
    date: String(point.trade_date || point.date || ""),
    close: toNumber(point.close),
    open: toNumber(point.open),
    high: toNumber(point.high),
    low: toNumber(point.low),
    volume: toNumber(point.volume),
    updated_at: point.updated_at ? String(point.updated_at) : null
  }))
  .filter((point): point is NormalizedMarketPoint => Boolean(point.date) && point.close !== null)
  .sort((a, b) => a.date.localeCompare(b.date));

const resolveBasePermissionLayer = (evaluation: SilverSwingEvaluation): MarketPermissionLayer => {
  const hits = new Set(evaluation.hitRuleKeys);
  if (
    hits.has("extreme_volatility")
    || hits.has("falling_knife")
    || hits.has("fast_drop")
    || hits.has("extreme_buy_lock")
    || hits.has("extreme_crash_guard")
  ) {
    return "P0";
  }
  if (
    hits.has("overheat_rise")
    || hits.has("fast_rise")
    || hits.has("ma250_stretch")
    || hits.has("extreme_sell_ladder")
  ) {
    return "P5";
  }
  if (
    hits.has("high_volatility")
    || hits.has("slow_decline")
    || (hits.has("sideways") && !hits.has("medium_sideways"))
  ) {
    return "P1";
  }
  if (hits.has("healthy_pullback")) return "P3";
  if (hits.has("medium_sideways") || hits.has("slow_rise")) return "P2";
  return "P1";
};

const downgradePermission = (layer: MarketPermissionLayer): MarketPermissionLayer => {
  if (layer === "P4") return "P3";
  if (layer === "P3") return "P2";
  if (layer === "P2") return "P1";
  return layer;
};

const permissionCopy = (layer: MarketPermissionLayer) => {
  switch (layer) {
    case "P0":
      return {
        label: "买入关闭",
        buyPermission: "closed" as const,
        actionHint: "只观察和管理已有仓位，不新增、不补仓、不接飞刀。"
      };
    case "P1":
      return {
        label: "观察复评",
        buyPermission: "review_only" as const,
        actionHint: "只恢复观察和复评，不执行正式买入；等待结构继续修复。"
      };
    case "P2":
      return {
        label: "小批次观察",
        buyPermission: "small_batch" as const,
        actionHint: "只允许带退出条件的小批次试错，不一把打满。"
      };
    case "P3":
      return {
        label: "修复候选",
        buyPermission: "small_batch" as const,
        actionHint: "结构已有修复证据，可按计划小批次执行，仍不放大仓位。"
      };
    case "P4":
      return {
        label: "正常计划",
        buyPermission: "normal" as const,
        actionHint: "结构与背景均确认后，才按正常分层计划执行。"
      };
    case "P5":
      return {
        label: "卖出优先",
        buyPermission: "blocked" as const,
        actionHint: "不追涨；已有仓位优先执行卖出纪律。"
      };
  }
};

const buildGoldContext = (goldContext?: GoldContextInput | null) => {
  if (!goldContext) return null;
  const hits = new Set(goldContext.evaluation.hitRuleKeys);
  const metrics = goldContext.evaluation.metrics;
  const riskHit = hits.has("extreme_volatility")
    || hits.has("high_volatility")
    || hits.has("falling_knife")
    || hits.has("fast_drop")
    || hits.has("slow_decline");
  const belowMa20 = metrics.closeVsMa20Percent !== null && metrics.closeVsMa20Percent < 0;
  const weakFiveDays = metrics.return5dPercent !== null && metrics.return5dPercent < 0;

  if (riskHit) {
    return {
      risk: true,
      label: "黄金背景偏弱",
      tone: "watch",
      summary: `黄金命中风险/走弱状态，5日 ${formatSignedPercent(metrics.return5dPercent)}，距MA20 ${formatSignedPercent(metrics.closeVsMa20Percent)}；只降低白银权限，不授予买入。`
    };
  }
  if (belowMa20 && weakFiveDays) {
    return {
      risk: false,
      label: "黄金尚未确认修复",
      tone: "neutral",
      summary: `黄金5日 ${formatSignedPercent(metrics.return5dPercent)}，距MA20 ${formatSignedPercent(metrics.closeVsMa20Percent)}，暂未给白银增加确认。`
    };
  }
  return {
    risk: false,
    label: "黄金背景平稳",
    tone: "neutral",
    summary: "黄金暂未命中高风险状态，但只作背景锚，不直接提高白银买入权限。"
  };
};

export const buildSilverRealtimeInterpretation = ({
  evaluation,
  pricePoints,
  primaryState,
  goldContext,
  historicalReplay = false,
  requestedAsOfDate = ""
}: {
  evaluation: SilverSwingEvaluation;
  pricePoints: MarketOhlcvPoint[];
  primaryState: PrimaryStateInput;
  goldContext?: GoldContextInput | null;
  historicalReplay?: boolean;
  requestedAsOfDate?: string;
}): MarketRealtimeInterpretation => {
  // The interpretation must never inspect bars after the evaluated date.
  const points = normalizePoints(pricePoints).filter(point => point.date <= evaluation.date);
  const latest = points.length ? points[points.length - 1] : null;
  const previous = points.length > 1 ? points[points.length - 2] : null;
  const beforePrevious = points.length > 2 ? points[points.length - 3] : null;
  const metrics = evaluation.metrics;
  const hits = new Set(evaluation.hitRuleKeys);
  const previousReturn = previous && beforePrevious
    ? percentChange(beforePrevious.close, previous.close)
    : null;
  const currentReturn = metrics.dailyReturnPercent;
  const previousLossPoints = previous && beforePrevious && previous.close < beforePrevious.close
    ? beforePrevious.close - previous.close
    : null;
  const recoveredPoints = latest && previous && latest.close > previous.close
    ? latest.close - previous.close
    : null;
  const recoveryRatio = previousLossPoints !== null
    && previousLossPoints > 0
    && recoveredPoints !== null
      ? (recoveredPoints / previousLossPoints) * 100
      : null;
  const closeLocation = latest
    && latest.high !== null
    && latest.low !== null
    && latest.high > latest.low
      ? ((latest.close - latest.low) / (latest.high - latest.low)) * 100
      : null;
  const volumeChange = latest
    && previous
    && latest.volume !== null
    && previous.volume !== null
      ? percentChange(previous.volume, latest.volume)
      : null;
  const gold = buildGoldContext(goldContext);

  let permissionLayer = resolveBasePermissionLayer(evaluation);
  if (gold?.risk && ["P2", "P3", "P4"].includes(permissionLayer)) {
    permissionLayer = downgradePermission(permissionLayer);
  }
  const permission = permissionCopy(permissionLayer);

  const reboundAfterDrop = previousReturn !== null
    && previousReturn <= -2.5
    && currentReturn !== null
    && currentReturn > 0;
  const fragileRecovery = reboundAfterDrop
    && recoveryRatio !== null
    && recoveryRatio < 60;

  let repairQuality = {
    key: "unclear",
    label: "结构未明",
    tone: "neutral"
  };
  if (permissionLayer === "P0") {
    repairQuality = { key: "risk_dominant", label: "风险主导", tone: "danger" };
  } else if (permissionLayer === "P5") {
    repairQuality = { key: "overheat", label: "过热/卖出优先", tone: "watch" };
  } else if (fragileRecovery) {
    repairQuality = { key: "fragile_repair", label: "承接出现，修复偏弱", tone: "watch" };
  } else if (hits.has("healthy_pullback")) {
    repairQuality = { key: "confirmed_repair", label: "修复证据成立", tone: "opportunity" };
  } else if (hits.has("medium_sideways")) {
    repairQuality = { key: "medium_sideways", label: "中期横盘确认", tone: "opportunity" };
  } else if (hits.has("sideways")) {
    repairQuality = { key: "sideways_candidate", label: "横盘候选", tone: "neutral" };
  } else if (hits.has("slow_rise")) {
    repairQuality = { key: "slow_rise", label: "温和修复", tone: "opportunity" };
  } else if (hits.has("slow_decline")) {
    repairQuality = { key: "slow_decline", label: "阴跌未修复", tone: "watch" };
  }

  const evidence: string[] = [];
  if (currentReturn !== null) {
    evidence.push(`今日 ${formatSignedPercent(currentReturn)}${previousReturn !== null ? `，前一日 ${formatSignedPercent(previousReturn)}` : ""}`);
  }
  if (recoveryRatio !== null) {
    evidence.push(`仅收复前一日下跌点数约 ${recoveryRatio.toFixed(1)}%`);
  }
  if (closeLocation !== null) {
    evidence.push(`收盘位于日内区间约 ${closeLocation.toFixed(1)}% 位置`);
  }
  if (volumeChange !== null) {
    evidence.push(`成交量较前一日 ${formatSignedPercent(volumeChange)}`);
  }
  const maEvidence = [
    metrics.closeVsMa20Percent !== null ? `MA20 ${formatSignedPercent(metrics.closeVsMa20Percent)}` : "",
    metrics.closeVsMa60Percent !== null ? `MA60 ${formatSignedPercent(metrics.closeVsMa60Percent)}` : "",
    metrics.closeVsMa250Percent !== null ? `MA250 ${formatSignedPercent(metrics.closeVsMa250Percent)}` : ""
  ].filter(Boolean);
  if (maEvidence.length) evidence.push(`均线位置：${maEvidence.join("，")}`);

  let summary = `机械状态为“${primaryState.label}”，盘面修复质量仍需继续确认。`;
  if (fragileRecovery) {
    summary = `机械状态虽为“${primaryState.label}”，但这是前一日下跌后的首次修复：有承接，收复幅度和量能尚不足以确认反转。`;
  } else if (repairQuality.key === "confirmed_repair" || repairQuality.key === "medium_sideways") {
    summary = `机械状态与盘面修复相互印证，允许进入小批次计划复核，但仍不代表可以放大仓位。`;
  } else if (permissionLayer === "P0") {
    summary = "高风险状态仍在主导，任何修复信号都不能覆盖买入关闭纪律。";
  } else if (permissionLayer === "P5") {
    summary = "盘面处于过热或年线拉伸纪律区，重点是卖出和防回吐，不追涨。";
  }

  const upgradeConditions: string[] = [];
  const invalidationConditions: string[] = [];
  if (permissionLayer === "P1") {
    upgradeConditions.push("横盘继续维持，不再出现新低或快速下跌");
    if (metrics.ma20 !== null) {
      upgradeConditions.push(`重新站稳 MA20（${formatPrice(metrics.ma20)}）并形成更高低点`);
    }
    if (beforePrevious && fragileRecovery) {
      upgradeConditions.push(`逐步收复前一轮下跌起点（${formatPrice(beforePrevious.close)}）`);
    }
    upgradeConditions.push("升级为中期横盘或健康回踩后，再开放小批次");
  } else if (permissionLayer === "P2" || permissionLayer === "P3") {
    upgradeConditions.push("波动继续收敛，回踩不破关键均线或前低");
    upgradeConditions.push("实物端轻微溢价或无溢价、货源充足，可以从容买到");
  }
  if (latest && previous && latest.low !== null && previous.low !== null) {
    const recentLow = Math.min(latest.low, previous.low);
    invalidationConditions.push(`跌破最近两日低点（${formatPrice(recentLow)}）则修复失效`);
  }
  invalidationConditions.push("重新命中快速下跌、飞刀或高波动时，按更高风险权限执行");

  const dataNotes: string[] = historicalReplay
    ? [
      `当前规则历史回放：请求截止 ${requestedAsOfDate || evaluation.date}，实际按 ${evaluation.date} 及以前的日线计算，未使用后续行情。`,
      "历史回放不替代当时未记录的实物端回收价、溢价、货源和真实热度。"
    ]
    : [
      "盘面研判按最新入库日线动态计算，不替代实物端回收价、溢价、货源和真实热度。"
    ];
  if (
    !historicalReplay
    &&
    goldContext?.latestPoint
    && String(goldContext.latestPoint.trade_date || goldContext.latestPoint.date || "") === evaluation.date
  ) {
    dataNotes.push("黄金最新日线可能仍是盘中快照，收盘前背景判断只作临时参考。");
  }

  return {
    version: "silver-live-context-v1.0",
    raw_state: {
      key: primaryState.key,
      label: primaryState.label
    },
    repair_quality: repairQuality,
    permission_layer: permissionLayer,
    permission_label: permission.label,
    buy_permission: permission.buyPermission,
    summary,
    action_hint: permission.actionHint,
    evidence,
    upgrade_conditions: upgradeConditions,
    invalidation_conditions: invalidationConditions,
    gold_context: gold
      ? {
        label: gold.label,
        tone: gold.tone,
        summary: gold.summary
      }
      : null,
    data_notes: dataNotes
  };
};
