import {
  evaluateSilverSwingRules,
  type MarketAssistRuleInput
} from "./marketAssistEvaluator";
import {
  buildSilverRealtimeInterpretation,
  resolveMarketPrimaryState,
  type MarketOhlcvPoint,
  type MarketPermissionLayer,
  type SilverPermissionHistoryPoint
} from "./marketRealtimeInterpretation";

const REPLAY_HISTORY_DAYS = 120;
const ENTRY_PERMISSION_LAYERS = new Set<MarketPermissionLayer>(["P2", "P3", "P4"]);
const GOLD_REPLAY_HISTORY_DAYS = 320;
const GOLD_OBSERVATION_BLOCKERS = new Set([
  "extreme_volatility",
  "high_volatility",
  "overheat_rise",
  "fast_rise",
  "slow_decline",
  "fast_drop",
  "falling_knife"
]);
const GOLD_REPAIR_FAILURE_BLOCKERS = new Set(["slow_decline", "fast_drop", "falling_knife"]);
const GOLD_REPAIR_ACCELERATION_STATES = new Set(["overheat_rise", "fast_rise"]);
const GOLD_DEEP_REPAIR_THRESHOLDS = {
  drawdown120dLtePercent: -10,
  daysSince20dLowGte: 4,
  closeVsMa20GtePercent: -1,
  return5dGtePercent: -1,
  range10To20RatioLte: 0.85,
  candidateDaysSince20dLowGte: 10,
  candidateRange10To20RatioLte: 0.70,
  failedCloseVsMa20LtePercent: -2,
  failedReturn5dLtePercent: -2.5,
  inactiveGraceDays: 5
} as const;
const GOLD_BULL_PULLBACK_THRESHOLDS = {
  drawdown120dLtePercent: -3,
  drawdown120dGtPercent: -10,
  daysSince20dLowGte: 5,
  range10To20RatioLte: 0.75,
  return5dGtePercent: 0,
  closeVsMa20GtePercent: 0,
  closeVsMa60GtePercent: -1
} as const;

export type AnnualOpportunityAsset = "silver" | "gold";
export type AnnualOpportunityMode = "entry_permission" | "observation";

export interface AnnualEntryOpportunityItem {
  trade_date: string;
  close: number;
  permission_layer: "P2" | "P3" | "P4" | null;
  permission_label: string;
  entry_type: "small_batch" | "normal_plan" | "value_improving" | "candidate_pool" | "repair_withdrawn";
  entry_label: "小仓" | "正式入场" | "性价比改善" | "进入候选池" | "修复撤销";
  state_key: string;
  state_label: string;
  normal_plan_entered_on: string | null;
  conclusion_reason: string;
  observation_path: "regular_pullback" | "bull_market_pullback" | "deep_drawdown_repair" | null;
  transition_from_date: string | null;
}

export interface AnnualEntryOpportunityReport {
  asset: AnnualOpportunityAsset;
  result_mode: AnnualOpportunityMode;
  year: number;
  available_years: number[];
  trade_day_count: number;
  small_batch_count: number;
  normal_plan_count: number;
  value_improving_count: number;
  candidate_pool_count: number;
  repair_withdrawn_count: number;
  items: AnnualEntryOpportunityItem[];
}

interface AnnualEntryOpportunityInput {
  year: number;
  silverPoints: MarketOhlcvPoint[];
  silverRules: MarketAssistRuleInput[];
  goldPoints?: MarketOhlcvPoint[];
  goldRules?: MarketAssistRuleInput[];
}

interface GoldAnnualObservationInput {
  year: number;
  goldPoints: MarketOhlcvPoint[];
  goldRules: MarketAssistRuleInput[];
}

const pointDate = (point: MarketOhlcvPoint) => String(point.trade_date || point.date || "");

const normalizePoints = (points: MarketOhlcvPoint[]) => points
  .filter(point => (
    Boolean(pointDate(point))
    && point.close !== null
    && point.close !== undefined
    && Number.isFinite(Number(point.close))
  ))
  .sort((a, b) => pointDate(a).localeCompare(pointDate(b)));

export const parseAnnualEntryOpportunityYear = (
  value: unknown,
  maximumYear = new Date().getFullYear()
) => {
  const text = String(value ?? "").trim();
  if (!/^\d{4}$/.test(text)) {
    throw new Error("year 必须使用四位年份");
  }
  const year = Number(text);
  if (!Number.isInteger(year) || year < 1900 || year > maximumYear) {
    throw new Error(`year 必须在 1900-${maximumYear} 之间`);
  }
  return year;
};

export const parseAnnualOpportunityAsset = (value: unknown): AnnualOpportunityAsset => {
  const text = String(value ?? "silver").trim().toLowerCase();
  if (text === "silver" || text === "sge_agtd") return "silver";
  if (text === "gold" || text === "xauusd") return "gold";
  throw new Error("asset 只支持 gold 或 silver");
};

const evaluateGoldAtDate = (
  points: MarketOhlcvPoint[],
  rules: MarketAssistRuleInput[],
  date: string
) => {
  if (!points.length || !rules.length) return null;
  return evaluateSilverSwingRules(points, rules, date);
};

const latestPointAtDate = (points: MarketOhlcvPoint[], date: string) => {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (pointDate(points[index]) <= date) return points[index];
  }
  return null;
};

export const buildAnnualEntryOpportunityReport = ({
  year,
  silverPoints: silverPointsInput,
  silverRules,
  goldPoints: goldPointsInput = [],
  goldRules = []
}: AnnualEntryOpportunityInput): AnnualEntryOpportunityReport => {
  const yearPrefix = `${year}-`;
  const yearEnd = `${year}-12-31`;
  const silverPoints = normalizePoints(silverPointsInput).filter(point => pointDate(point) <= yearEnd);
  const goldPoints = normalizePoints(goldPointsInput).filter(point => pointDate(point) <= yearEnd);
  const availableYears = [...new Set(
    normalizePoints(silverPointsInput).map(point => Number(pointDate(point).slice(0, 4)))
  )]
    .filter(item => Number.isInteger(item) && item <= new Date().getFullYear())
    .sort((a, b) => b - a);
  const firstTargetIndex = silverPoints.findIndex(point => pointDate(point).startsWith(yearPrefix));
  const tradeDayCount = silverPoints.filter(point => pointDate(point).startsWith(yearPrefix)).length;

  if (firstTargetIndex < 0 || !tradeDayCount || !silverRules.length) {
    return {
      asset: "silver",
      result_mode: "entry_permission",
      year,
      available_years: availableYears,
      trade_day_count: tradeDayCount,
      small_batch_count: 0,
      normal_plan_count: 0,
      value_improving_count: 0,
      candidate_pool_count: 0,
      repair_withdrawn_count: 0,
      items: []
    };
  }

  const replayStartIndex = Math.max(0, firstTargetIndex - (REPLAY_HISTORY_DAYS - 1));
  const replayPoints = silverPoints.slice(replayStartIndex);
  const permissionHistory: SilverPermissionHistoryPoint[] = replayPoints.map(point => {
    const date = pointDate(point);
    return {
      evaluation: evaluateSilverSwingRules(silverPoints, silverRules, date),
      goldEvaluation: evaluateGoldAtDate(goldPoints, goldRules, date)
    };
  });

  const items: AnnualEntryOpportunityItem[] = [];
  permissionHistory.forEach((historyPoint, index) => {
    const evaluation = historyPoint.evaluation;
    if (!evaluation.date.startsWith(yearPrefix)) return;

    const historyWindow = permissionHistory.slice(
      Math.max(0, index - (REPLAY_HISTORY_DAYS - 1)),
      index + 1
    );
    const interpretation = buildSilverRealtimeInterpretation({
      evaluation,
      pricePoints: silverPoints,
      primaryState: resolveMarketPrimaryState(evaluation),
      goldContext: historyPoint.goldEvaluation
        ? {
          evaluation: historyPoint.goldEvaluation,
          latestPoint: latestPointAtDate(goldPoints, evaluation.date)
        }
        : null,
      permissionHistory: historyWindow,
      historicalReplay: true,
      requestedAsOfDate: evaluation.date
    });
    const layer = interpretation.permission_layer;
    if (!ENTRY_PERMISSION_LAYERS.has(layer)) return;

    const normalPlan = layer === "P4";
    items.push({
      trade_date: evaluation.date,
      close: evaluation.close,
      permission_layer: layer as AnnualEntryOpportunityItem["permission_layer"],
      permission_label: interpretation.permission_label,
      entry_type: normalPlan ? "normal_plan" : "small_batch",
      entry_label: normalPlan ? "正式入场" : "小仓",
      state_key: interpretation.raw_state.key,
      state_label: interpretation.raw_state.label,
      normal_plan_entered_on: interpretation.normal_plan_state.entered_on,
      conclusion_reason: interpretation.summary,
      observation_path: null,
      transition_from_date: null
    });
  });

  return {
    asset: "silver",
    result_mode: "entry_permission",
    year,
    available_years: availableYears,
    trade_day_count: tradeDayCount,
    small_batch_count: items.filter(item => item.entry_type === "small_batch").length,
    normal_plan_count: items.filter(item => item.entry_type === "normal_plan").length,
    value_improving_count: 0,
    candidate_pool_count: 0,
    repair_withdrawn_count: 0,
    items
  };
};

const hasGoldObservationBlocker = (hitRuleKeys: string[]) => (
  hitRuleKeys.some(key => GOLD_OBSERVATION_BLOCKERS.has(key))
);

type GoldObservationPath = "regular_pullback" | "bull_market_pullback" | "deep_drawdown_repair";

interface GoldObservationConclusion {
  entry_type: "value_improving" | "candidate_pool";
  entry_label: "性价比改善" | "进入候选池";
  reason: string;
  path: GoldObservationPath;
}

interface GoldDeepRepairMetrics {
  drawdown120dPercent: number;
  daysSince20dLow: number;
  range10To20Ratio: number;
  ma60GapImproving: boolean;
  ma250Rising: boolean;
  referenceLow20d: number;
}

interface ActiveGoldRepair {
  startedOn: string;
  path: GoldObservationPath;
  referenceLow: number;
  lastPositiveIndex: number;
}

const formatSignedPercent = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;

const buildGoldDeepRepairMetrics = (
  evaluations: ReturnType<typeof evaluateSilverSwingRules>[],
  index: number
): GoldDeepRepairMetrics | null => {
  if (index < 119) return null;
  const current = evaluations[index];
  const window120d = evaluations.slice(index - 119, index + 1);
  const window20d = evaluations.slice(Math.max(0, index - 19), index + 1);
  const high120d = Math.max(...window120d.map(item => item.close));
  const referenceLow20d = Math.min(...window20d.map(item => item.close));
  const lowIndex = window20d.map(item => item.close).lastIndexOf(referenceLow20d);
  const range10d = current.metrics.range10dPercent;
  const range20d = current.metrics.range20dPercent;
  const fiveDaysAgo = evaluations[index - 5];
  const twentyDaysAgo = evaluations[index - 20];
  if (!high120d || range10d === null || range20d === null || range20d <= 0) return null;

  return {
    drawdown120dPercent: ((current.close - high120d) / high120d) * 100,
    daysSince20dLow: window20d.length - 1 - lowIndex,
    range10To20Ratio: range10d / range20d,
    ma60GapImproving: current.metrics.closeVsMa60Percent !== null
      && fiveDaysAgo?.metrics.closeVsMa60Percent !== null
      && fiveDaysAgo?.metrics.closeVsMa60Percent !== undefined
      && current.metrics.closeVsMa60Percent > fiveDaysAgo.metrics.closeVsMa60Percent,
    ma250Rising: current.metrics.ma250 !== null
      && twentyDaysAgo?.metrics.ma250 !== null
      && twentyDaysAgo?.metrics.ma250 !== undefined
      && current.metrics.ma250 >= twentyDaysAgo.metrics.ma250,
    referenceLow20d
  };
};

const resolveRegularGoldObservationConclusion = (
  evaluation: ReturnType<typeof evaluateSilverSwingRules>
): GoldObservationConclusion | null => {
  const hits = new Set(evaluation.hitRuleKeys);
  const metrics = evaluation.metrics;

  if (hits.has("healthy_pullback")) {
    const longCycleSupported = metrics.ma200 !== null
      && metrics.ma250 !== null
      && evaluation.close >= metrics.ma200
      && evaluation.close >= metrics.ma250;
    if (longCycleSupported) {
      return {
        entry_type: "value_improving" as const,
        entry_label: "性价比改善" as const,
        reason: "普通回踩后仍站在 MA200/MA250 上方，长期结构没有破坏；但折价和修复证据不足以升级候选池。",
        path: "regular_pullback" as const
      };
    }
    return {
      entry_type: "value_improving" as const,
      entry_label: "性价比改善" as const,
      reason: "回撤后已经出现回踩修复，但中长期结构仍需继续确认；不构成买入许可。",
      path: "regular_pullback" as const
    };
  }

  const drawdown = metrics.drawdownFrom20dHighPercent;
  const recovery = metrics.recoveryFrom5dLowPercent;
  const closeVsMa60 = metrics.closeVsMa60Percent;
  const isRepairingPlatform = (hits.has("medium_sideways") || hits.has("sideways"))
    && drawdown !== null
    && drawdown <= -2.5
    && recovery !== null
    && recovery >= 0.8
    && closeVsMa60 !== null
    && closeVsMa60 >= -2;
  if (!isRepairingPlatform) return null;

  return {
    entry_type: "value_improving" as const,
    entry_label: "性价比改善" as const,
    reason: "从近20日高位回撤后形成横盘并出现低位修复，性价比开始改善；仍需等待载体价差和执行条件。",
    path: "regular_pullback" as const
  };
};

const resolveDeepGoldObservationConclusion = (
  evaluation: ReturnType<typeof evaluateSilverSwingRules>,
  deepMetrics: GoldDeepRepairMetrics | null
): GoldObservationConclusion | null => {
  if (!deepMetrics) return null;
  const hits = new Set(evaluation.hitRuleKeys);
  const metrics = evaluation.metrics;
  const isPlatform = hits.has("medium_sideways") || hits.has("sideways");
  const basicRepair = isPlatform
    && deepMetrics.drawdown120dPercent <= GOLD_DEEP_REPAIR_THRESHOLDS.drawdown120dLtePercent
    && deepMetrics.daysSince20dLow >= GOLD_DEEP_REPAIR_THRESHOLDS.daysSince20dLowGte
    && metrics.closeVsMa20Percent !== null
    && metrics.closeVsMa20Percent >= GOLD_DEEP_REPAIR_THRESHOLDS.closeVsMa20GtePercent
    && metrics.return5dPercent !== null
    && metrics.return5dPercent >= GOLD_DEEP_REPAIR_THRESHOLDS.return5dGtePercent
    && deepMetrics.range10To20Ratio <= GOLD_DEEP_REPAIR_THRESHOLDS.range10To20RatioLte;
  if (!basicRepair) return null;

  const candidate = deepMetrics.daysSince20dLow >= GOLD_DEEP_REPAIR_THRESHOLDS.candidateDaysSince20dLowGte
    && metrics.closeVsMa20Percent !== null
    && metrics.closeVsMa20Percent >= 0
    && metrics.return5dPercent !== null
    && metrics.return5dPercent >= 0
    && deepMetrics.range10To20Ratio <= GOLD_DEEP_REPAIR_THRESHOLDS.candidateRange10To20RatioLte
    && deepMetrics.ma60GapImproving
    && deepMetrics.ma250Rising;
  const evidence = `近120日高点回撤 ${formatSignedPercent(deepMetrics.drawdown120dPercent)}，低点后 ${deepMetrics.daysSince20dLow} 个交易日未创新低，10/20日振幅比 ${(deepMetrics.range10To20Ratio * 100).toFixed(0)}%`;

  if (candidate) {
    return {
      entry_type: "candidate_pool",
      entry_label: "进入候选池",
      reason: `${evidence}，MA20 已修复且 MA60 距离持续收窄，长期均线方向仍向上；只进入候选池，不构成买入许可。`,
      path: "deep_drawdown_repair"
    };
  }
  return {
    entry_type: "value_improving",
    entry_label: "性价比改善",
    reason: `${evidence}，深跌后的低位平台开始修复；仍可能再次破位，只保留观察资格。`,
    path: "deep_drawdown_repair"
  };
};

const resolveBullMarketPullbackConclusion = (
  evaluation: ReturnType<typeof evaluateSilverSwingRules>,
  deepMetrics: GoldDeepRepairMetrics | null
): GoldObservationConclusion | null => {
  if (!deepMetrics) return null;
  const hits = new Set(evaluation.hitRuleKeys);
  const metrics = evaluation.metrics;
  const isRepairingPlatform = hits.has("healthy_pullback")
    || hits.has("medium_sideways")
    || hits.has("sideways");
  const longCycleSupported = metrics.ma60 !== null
    && metrics.ma200 !== null
    && metrics.ma250 !== null
    && evaluation.close >= metrics.ma200
    && evaluation.close >= metrics.ma250
    && metrics.ma60 >= metrics.ma250
    && deepMetrics.ma250Rising;
  const candidate = isRepairingPlatform
    && longCycleSupported
    && deepMetrics.drawdown120dPercent <= GOLD_BULL_PULLBACK_THRESHOLDS.drawdown120dLtePercent
    && deepMetrics.drawdown120dPercent > GOLD_BULL_PULLBACK_THRESHOLDS.drawdown120dGtPercent
    && deepMetrics.daysSince20dLow >= GOLD_BULL_PULLBACK_THRESHOLDS.daysSince20dLowGte
    && deepMetrics.range10To20Ratio <= GOLD_BULL_PULLBACK_THRESHOLDS.range10To20RatioLte
    && metrics.return5dPercent !== null
    && metrics.return5dPercent >= GOLD_BULL_PULLBACK_THRESHOLDS.return5dGtePercent
    && metrics.closeVsMa20Percent !== null
    && metrics.closeVsMa20Percent >= GOLD_BULL_PULLBACK_THRESHOLDS.closeVsMa20GtePercent
    && metrics.closeVsMa60Percent !== null
    && metrics.closeVsMa60Percent >= GOLD_BULL_PULLBACK_THRESHOLDS.closeVsMa60GtePercent
    && deepMetrics.ma60GapImproving;
  if (!candidate) return null;

  return {
    entry_type: "candidate_pool",
    entry_label: "进入候选池",
    reason: `长期均线仍保持牛市结构，近120日高点回撤 ${formatSignedPercent(deepMetrics.drawdown120dPercent)}，低点后 ${deepMetrics.daysSince20dLow} 个交易日未创新低，10/20日振幅比 ${(deepMetrics.range10To20Ratio * 100).toFixed(0)}%，并已重新站上 MA20、接近 MA60；属于牛市健康回踩候选，只作中期观察，不构成买入许可。`,
    path: "bull_market_pullback"
  };
};

const resolveGoldObservationConclusion = (
  evaluation: ReturnType<typeof evaluateSilverSwingRules>,
  deepMetrics: GoldDeepRepairMetrics | null
): GoldObservationConclusion | null => {
  if (hasGoldObservationBlocker(evaluation.hitRuleKeys)) return null;
  const regularConclusion = resolveRegularGoldObservationConclusion(evaluation);
  const deepConclusion = resolveDeepGoldObservationConclusion(evaluation, deepMetrics);
  const bullPullbackConclusion = resolveBullMarketPullbackConclusion(evaluation, deepMetrics);
  if (deepConclusion?.entry_type === "candidate_pool") return deepConclusion;
  if (bullPullbackConclusion) return bullPullbackConclusion;
  return deepConclusion || regularConclusion;
};

const resolveGoldRepairWithdrawalReason = (
  evaluation: ReturnType<typeof evaluateSilverSwingRules>,
  activeRepair: ActiveGoldRepair
) => {
  const hits = new Set(evaluation.hitRuleKeys);
  const failureStates = [...GOLD_REPAIR_FAILURE_BLOCKERS].filter(key => hits.has(key));
  const madeNewLow = evaluation.close < activeRepair.referenceLow;
  const lostShortStructure = evaluation.metrics.closeVsMa20Percent !== null
    && evaluation.metrics.return5dPercent !== null
    && evaluation.metrics.closeVsMa20Percent <= GOLD_DEEP_REPAIR_THRESHOLDS.failedCloseVsMa20LtePercent
    && evaluation.metrics.return5dPercent <= GOLD_DEEP_REPAIR_THRESHOLDS.failedReturn5dLtePercent;
  if (!failureStates.length && !madeNewLow && !lostShortStructure) return null;

  const reasons: string[] = [];
  if (madeNewLow) reasons.push(`收盘价跌破修复窗口参考低点 ${activeRepair.referenceLow.toFixed(2)}`);
  if (lostShortStructure) {
    reasons.push(`距MA20 ${formatSignedPercent(evaluation.metrics.closeVsMa20Percent!)}、5日 ${formatSignedPercent(evaluation.metrics.return5dPercent!)}`);
  }
  if (failureStates.length) reasons.push(`命中 ${failureStates.join("/")}`);
  return `此前从 ${activeRepair.startedOn} 开始的修复观察已失效：${reasons.join("，")}；撤销改善/候选状态，回到继续观察。`;
};

export const buildGoldAnnualObservationReport = ({
  year,
  goldPoints: goldPointsInput,
  goldRules
}: GoldAnnualObservationInput): AnnualEntryOpportunityReport => {
  const yearPrefix = `${year}-`;
  const yearEnd = `${year}-12-31`;
  const normalizedInput = normalizePoints(goldPointsInput);
  const goldPoints = normalizedInput.filter(point => pointDate(point) <= yearEnd);
  const availableYears = [...new Set(
    normalizedInput.map(point => Number(pointDate(point).slice(0, 4)))
  )]
    .filter(item => Number.isInteger(item) && item <= new Date().getFullYear())
    .sort((a, b) => b - a);
  const firstTargetIndex = goldPoints.findIndex(point => pointDate(point).startsWith(yearPrefix));
  const tradeDayCount = goldPoints.filter(point => pointDate(point).startsWith(yearPrefix)).length;

  if (firstTargetIndex < 0 || !tradeDayCount || !goldRules.length) {
    return {
      asset: "gold",
      result_mode: "observation",
      year,
      available_years: availableYears,
      trade_day_count: tradeDayCount,
      small_batch_count: 0,
      normal_plan_count: 0,
      value_improving_count: 0,
      candidate_pool_count: 0,
      repair_withdrawn_count: 0,
      items: []
    };
  }

  const replayStartIndex = Math.max(0, firstTargetIndex - GOLD_REPLAY_HISTORY_DAYS);
  const replayPoints = goldPoints.slice(replayStartIndex);
  const evaluations = replayPoints.map(point => (
    evaluateSilverSwingRules(replayPoints, goldRules, pointDate(point))
  ));
  const items: AnnualEntryOpportunityItem[] = [];
  let activeRepair: ActiveGoldRepair | null = null;

  evaluations.forEach((evaluation, index) => {
    const date = evaluation.date;
    const deepMetrics = buildGoldDeepRepairMetrics(evaluations, index);
    const conclusion = resolveGoldObservationConclusion(evaluation, deepMetrics);
    const state = resolveMarketPrimaryState(evaluation);

    if (conclusion) {
      if (!activeRepair || activeRepair.path !== conclusion.path) {
        activeRepair = {
          startedOn: date,
          path: conclusion.path,
          referenceLow: deepMetrics?.referenceLow20d ?? evaluation.close,
          lastPositiveIndex: index
        };
      } else {
        activeRepair.lastPositiveIndex = index;
        activeRepair.referenceLow = Math.min(activeRepair.referenceLow, deepMetrics?.referenceLow20d ?? evaluation.close);
      }

      if (!date.startsWith(yearPrefix)) return;
      items.push({
        trade_date: evaluation.date,
        close: evaluation.close,
        permission_layer: null,
        permission_label: "观察结论，不构成买入许可",
        entry_type: conclusion.entry_type,
        entry_label: conclusion.entry_label,
        state_key: state.key,
        state_label: state.label,
        normal_plan_entered_on: null,
        conclusion_reason: conclusion.reason,
        observation_path: conclusion.path,
        transition_from_date: activeRepair.startedOn
      });
      return;
    }

    if (!activeRepair) return;
    const withdrawalReason = resolveGoldRepairWithdrawalReason(evaluation, activeRepair);
    if (withdrawalReason) {
      if (date.startsWith(yearPrefix)) {
        items.push({
          trade_date: evaluation.date,
          close: evaluation.close,
          permission_layer: null,
          permission_label: "观察结论，不构成买入许可",
          entry_type: "repair_withdrawn",
          entry_label: "修复撤销",
          state_key: state.key,
          state_label: state.label,
          normal_plan_entered_on: null,
          conclusion_reason: withdrawalReason,
          observation_path: activeRepair.path,
          transition_from_date: activeRepair.startedOn
        });
      }
      activeRepair = null;
      return;
    }

    if (
      evaluation.hitRuleKeys.some(key => GOLD_REPAIR_ACCELERATION_STATES.has(key))
      || index - activeRepair.lastPositiveIndex > GOLD_DEEP_REPAIR_THRESHOLDS.inactiveGraceDays
    ) {
      activeRepair = null;
    }
  });

  return {
    asset: "gold",
    result_mode: "observation",
    year,
    available_years: availableYears,
    trade_day_count: tradeDayCount,
    small_batch_count: 0,
    normal_plan_count: 0,
    value_improving_count: items.filter(item => item.entry_type === "value_improving").length,
    candidate_pool_count: items.filter(item => item.entry_type === "candidate_pool").length,
    repair_withdrawn_count: items.filter(item => item.entry_type === "repair_withdrawn").length,
    items
  };
};
