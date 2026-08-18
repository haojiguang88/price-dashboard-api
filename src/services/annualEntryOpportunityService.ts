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

export interface AnnualEntryOpportunityItem {
  trade_date: string;
  close: number;
  permission_layer: "P2" | "P3" | "P4";
  permission_label: string;
  entry_type: "small_batch" | "normal_plan";
  entry_label: "小仓" | "正式入场";
  state_key: string;
  state_label: string;
  normal_plan_entered_on: string | null;
}

export interface AnnualEntryOpportunityReport {
  year: number;
  available_years: number[];
  trade_day_count: number;
  small_batch_count: number;
  normal_plan_count: number;
  items: AnnualEntryOpportunityItem[];
}

interface AnnualEntryOpportunityInput {
  year: number;
  silverPoints: MarketOhlcvPoint[];
  silverRules: MarketAssistRuleInput[];
  goldPoints?: MarketOhlcvPoint[];
  goldRules?: MarketAssistRuleInput[];
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
      year,
      available_years: availableYears,
      trade_day_count: tradeDayCount,
      small_batch_count: 0,
      normal_plan_count: 0,
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
      normal_plan_entered_on: interpretation.normal_plan_state.entered_on
    });
  });

  return {
    year,
    available_years: availableYears,
    trade_day_count: tradeDayCount,
    small_batch_count: items.filter(item => item.entry_type === "small_batch").length,
    normal_plan_count: items.filter(item => item.entry_type === "normal_plan").length,
    items
  };
};
