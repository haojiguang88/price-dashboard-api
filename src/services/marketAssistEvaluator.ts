export const MARKET_ASSIST_EVALUATOR_VERSION = "silver-swing-v1.3";

export interface MarketPricePoint {
  trade_date?: string;
  date?: string;
  close: number | null;
}

export interface MarketAssistRuleInput {
  rule_key: string;
  rule_type?: string;
  threshold?: Record<string, unknown> | null;
  threshold_json?: string | null;
  status?: string;
  display_order?: number;
}

export interface NormalizedMarketAssistRule {
  ruleKey: string;
  ruleType: string;
  threshold: Record<string, unknown>;
  displayOrder: number;
}

export interface SilverSwingMetrics {
  dailyReturnPercent: number | null;
  return3dPercent: number | null;
  return5dPercent: number | null;
  return10dPercent: number | null;
  return20dPercent: number | null;
  upDays10d: number;
  downDays10d: number;
  bestSingleDayRise10dPercent: number | null;
  worstSingleDayDrop10dPercent: number | null;
  drawdownFrom20dHighPercent: number | null;
  recoveryFrom5dLowPercent: number | null;
  range10dPercent: number | null;
  range20dPercent: number | null;
  avgAbsDailyReturn20dPercent: number | null;
  dailyReturnStd20dPercent: number | null;
  daysAbsReturnGte4Pct20d: number;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  ma200: number | null;
  ma250: number | null;
  closeVsMa20Percent: number | null;
  closeVsMa60Percent: number | null;
  closeVsMa250Percent: number | null;
}

export interface SilverSwingRuleEvaluation {
  ruleKey: string;
  hit: boolean;
  score?: number;
  scoreTotal?: number;
}

export interface SilverSwingEvaluation {
  date: string;
  close: number;
  metrics: SilverSwingMetrics;
  rules: SilverSwingRuleEvaluation[];
  hitRuleKeys: string[];
}

interface NormalizedPricePoint {
  date: string;
  close: number;
}

const toNumber = (value: unknown) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const percentChange = (start: number | null, end: number | null) => {
  if (start === null || end === null || start === 0) return null;
  return ((end - start) / start) * 100;
};

const normalizePoints = (points: MarketPricePoint[]) => points
  .map(point => ({
    date: String(point.trade_date || point.date || ""),
    close: toNumber(point.close)
  }))
  .filter((point): point is NormalizedPricePoint => Boolean(point.date) && point.close !== null)
  .sort((a, b) => a.date.localeCompare(b.date));

const parseThreshold = (rule: MarketAssistRuleInput) => {
  if (rule.threshold && typeof rule.threshold === "object") return rule.threshold;
  if (!rule.threshold_json) return {};
  try {
    const parsed = JSON.parse(rule.threshold_json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

export const normalizeMarketAssistRules = (rules: MarketAssistRuleInput[]): NormalizedMarketAssistRule[] => rules
  .filter(rule => rule.status !== "archived")
  .map(rule => ({
    ruleKey: rule.rule_key,
    ruleType: String(rule.rule_type || ""),
    threshold: parseThreshold(rule),
    displayOrder: Number.isFinite(Number(rule.display_order)) ? Number(rule.display_order) : 0
  }))
  .sort((a, b) => a.displayOrder - b.displayOrder);

const getReturnAt = (points: NormalizedPricePoint[], index: number) => {
  if (index <= 0 || index >= points.length) return null;
  return percentChange(points[index - 1].close, points[index].close);
};

const getIntervalReturn = (points: NormalizedPricePoint[], index: number, intervals: number) => {
  if (index < intervals || index >= points.length) return null;
  return percentChange(points[index - intervals].close, points[index].close);
};

const getWindowReturns = (points: NormalizedPricePoint[], index: number, intervals: number) => {
  const returns: number[] = [];
  const start = Math.max(1, index - intervals + 1);
  for (let cursor = start; cursor <= index; cursor += 1) {
    const value = getReturnAt(points, cursor);
    if (value !== null) returns.push(value);
  }
  return returns;
};

const getWindowCloses = (points: NormalizedPricePoint[], index: number, intervals: number) => {
  const start = Math.max(0, index - intervals);
  return points.slice(start, index + 1).map(point => point.close);
};

const average = (values: number[]) => {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const standardDeviation = (values: number[]) => {
  if (!values.length) return null;
  const avg = average(values);
  if (avg === null) return null;
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length;
  return Math.sqrt(variance);
};

const rangePercent = (values: number[]) => {
  if (!values.length) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  return percentChange(low, high);
};

const movingAverage = (points: NormalizedPricePoint[], index: number, size: number) => {
  if (index < size - 1) return null;
  const closes = points.slice(index - size + 1, index + 1).map(point => point.close);
  return average(closes);
};

export const calculateSilverSwingMetrics = (
  pointsInput: MarketPricePoint[],
  targetDate?: string
): { point: NormalizedPricePoint; index: number; metrics: SilverSwingMetrics } => {
  const points = normalizePoints(pointsInput);
  if (!points.length) {
    throw new Error("No market price points to evaluate");
  }

  const index = targetDate
    ? points.findIndex(point => point.date === targetDate)
    : points.length - 1;
  if (index < 0) {
    throw new Error(`Target date not found: ${targetDate}`);
  }

  const point = points[index];
  const returns10d = getWindowReturns(points, index, 10);
  const returns20d = getWindowReturns(points, index, 20);
  const absReturns20d = returns20d.map(value => Math.abs(value));
  const closes5d = getWindowCloses(points, index, 5);
  const closes10d = getWindowCloses(points, index, 10);
  const closes20d = getWindowCloses(points, index, 20);
  const bestRise10d = returns10d.length ? Math.max(...returns10d) : null;
  const worstDrop10d = returns10d.length ? Math.min(...returns10d) : null;
  const recentHigh20d = closes20d.length ? Math.max(...closes20d) : null;
  const recentLow5d = closes5d.length ? Math.min(...closes5d) : null;
  const ma20 = movingAverage(points, index, 20);
  const ma60 = movingAverage(points, index, 60);
  const ma120 = movingAverage(points, index, 120);
  const ma200 = movingAverage(points, index, 200);
  const ma250 = movingAverage(points, index, 250);

  return {
    point: points[index],
    index,
    metrics: {
      dailyReturnPercent: getReturnAt(points, index),
      return3dPercent: getIntervalReturn(points, index, 3),
      return5dPercent: getIntervalReturn(points, index, 5),
      return10dPercent: getIntervalReturn(points, index, 10),
      return20dPercent: getIntervalReturn(points, index, 20),
      upDays10d: returns10d.filter(value => value > 0).length,
      downDays10d: returns10d.filter(value => value < 0).length,
      bestSingleDayRise10dPercent: bestRise10d,
      worstSingleDayDrop10dPercent: worstDrop10d,
      drawdownFrom20dHighPercent: percentChange(recentHigh20d, point.close),
      recoveryFrom5dLowPercent: percentChange(recentLow5d, point.close),
      range10dPercent: rangePercent(closes10d),
      range20dPercent: rangePercent(closes20d),
      avgAbsDailyReturn20dPercent: average(absReturns20d),
      dailyReturnStd20dPercent: standardDeviation(returns20d),
      daysAbsReturnGte4Pct20d: absReturns20d.filter(value => value >= 4).length,
      ma20,
      ma60,
      ma120,
      ma200,
      ma250,
      closeVsMa20Percent: percentChange(ma20, point.close),
      closeVsMa60Percent: percentChange(ma60, point.close),
      closeVsMa250Percent: percentChange(ma250, point.close)
    }
  };
};

const compareGte = (value: number | null, threshold: unknown) => {
  const thresholdNumber = toNumber(threshold);
  return value !== null && thresholdNumber !== null && value >= thresholdNumber;
};

const compareLte = (value: number | null, threshold: unknown) => {
  const thresholdNumber = toNumber(threshold);
  return value !== null && thresholdNumber !== null && value <= thresholdNumber;
};

const compareLt = (value: number | null, threshold: unknown) => {
  const thresholdNumber = toNumber(threshold);
  return value !== null && thresholdNumber !== null && value < thresholdNumber;
};

const getMetricValue = (metrics: SilverSwingMetrics, metric: string) => {
  switch (metric) {
    case "avg_abs_daily_return":
      return metrics.avgAbsDailyReturn20dPercent;
    case "daily_return_std":
      return metrics.dailyReturnStd20dPercent;
    case "high_low_range_20_intervals":
      return metrics.range20dPercent;
    case "days_abs_return_gte_4pct":
      return metrics.daysAbsReturnGte4Pct20d;
    default:
      return null;
  }
};

const evaluateScoreRule = (
  metrics: SilverSwingMetrics,
  threshold: Record<string, unknown>
): { hit: boolean; score: number; scoreTotal: number } => {
  const conditions = Array.isArray(threshold.conditions) ? threshold.conditions : [];
  const score = conditions.reduce((total, condition) => {
    if (!condition || typeof condition !== "object") return total;
    const conditionRecord = condition as Record<string, unknown>;
    const metricValue = getMetricValue(metrics, String(conditionRecord.metric || ""));
    if (conditionRecord.gte_percent !== undefined) {
      return total + (compareGte(metricValue, conditionRecord.gte_percent) ? 1 : 0);
    }
    if (conditionRecord.gte_days !== undefined) {
      return total + (compareGte(metricValue, conditionRecord.gte_days) ? 1 : 0);
    }
    return total;
  }, 0);
  const expectedScore = toNumber(threshold.score_gte) ?? 3;
  return { hit: score >= expectedScore, score, scoreTotal: conditions.length };
};

const evaluateRule = (
  metrics: SilverSwingMetrics,
  rule: NormalizedMarketAssistRule
): SilverSwingRuleEvaluation => {
  if (rule.ruleType === "discipline") {
    return { ruleKey: rule.ruleKey, hit: false };
  }

  const threshold = rule.threshold;

  switch (rule.ruleKey) {
    case "extreme_volatility":
    case "high_volatility": {
      const result = evaluateScoreRule(metrics, threshold);
      return { ruleKey: rule.ruleKey, ...result };
    }
    case "fast_rise":
      return {
        ruleKey: rule.ruleKey,
        hit: compareGte(metrics.dailyReturnPercent, threshold.daily_return_gte_percent)
          || compareGte(metrics.return3dPercent, threshold.return_3d_gte_percent)
          || compareGte(metrics.return5dPercent, threshold.return_5d_gte_percent)
      };
    case "overheat_rise":
      return {
        ruleKey: rule.ruleKey,
        hit: compareGte(metrics.return5dPercent, threshold.return_5d_gte_percent)
          || compareGte(metrics.return20dPercent, threshold.return_20d_gte_percent)
      };
    case "slow_rise": {
      const max20dReturn = threshold.return_20d_lte_percent;
      const maxSingleDayRise = threshold.max_single_day_rise_lt_percent;
      return {
        ruleKey: rule.ruleKey,
        hit: compareGte(metrics.return10dPercent, threshold.return_10d_gte_percent)
          && compareGte(metrics.return20dPercent, threshold.return_20d_gte_percent)
          && (max20dReturn === undefined || compareLte(metrics.return20dPercent, max20dReturn))
          && compareGte(metrics.upDays10d, threshold.up_days_10d_gte)
          && (maxSingleDayRise === undefined || compareLt(metrics.bestSingleDayRise10dPercent, maxSingleDayRise))
      };
    }
    case "ma250_stretch":
      return {
        ruleKey: rule.ruleKey,
        hit: compareGte(metrics.closeVsMa250Percent, threshold.block_wave_buy_vs_ma250_gte_percent)
      };
    case "fast_drop":
      return {
        ruleKey: rule.ruleKey,
        hit: compareLte(metrics.dailyReturnPercent, threshold.daily_return_lte_percent)
          || compareLte(metrics.return3dPercent, threshold.return_3d_lte_percent)
          || compareLte(metrics.return5dPercent, threshold.return_5d_lte_percent)
      };
    case "falling_knife":
      return {
        ruleKey: rule.ruleKey,
        hit: compareLte(metrics.dailyReturnPercent, threshold.daily_return_lte_percent)
          || compareLte(metrics.return3dPercent, threshold.return_3d_lte_percent)
          || compareLte(metrics.return5dPercent, threshold.return_5d_lte_percent)
      };
    case "slow_decline": {
      const maxDropThreshold = toNumber(threshold.max_single_day_drop_gt_percent);
      return {
        ruleKey: rule.ruleKey,
        hit: compareLte(metrics.return10dPercent, threshold.return_10d_lte_percent)
          && compareGte(metrics.downDays10d, threshold.down_days_10d_gte)
          && (
            maxDropThreshold === null
            || (
              metrics.worstSingleDayDrop10dPercent !== null
              && metrics.worstSingleDayDrop10dPercent > maxDropThreshold
            )
          )
      };
    }
    case "sideways":
      return {
        ruleKey: rule.ruleKey,
        hit: compareLte(metrics.return10dPercent === null ? null : Math.abs(metrics.return10dPercent), threshold.abs_return_10d_lte_percent)
          && compareLte(metrics.range10dPercent, threshold.range_10d_lte_percent)
      };
    case "medium_sideways":
      return {
        ruleKey: rule.ruleKey,
        hit: compareLte(metrics.return20dPercent === null ? null : Math.abs(metrics.return20dPercent), threshold.abs_return_20d_lte_percent)
          && compareLte(metrics.range20dPercent, threshold.range_20d_lte_percent)
      };
    case "healthy_pullback": {
      const drawdownRange = Array.isArray(threshold.drawdown_from_recent_high_between_percent)
        ? threshold.drawdown_from_recent_high_between_percent
        : [5, 12];
      const minDrawdown = toNumber(drawdownRange[0]) ?? 5;
      const maxDrawdown = toNumber(drawdownRange[1]) ?? 12;
      const drawdown = metrics.drawdownFrom20dHighPercent === null
        ? null
        : Math.abs(Math.min(metrics.drawdownFrom20dHighPercent, 0));
      return {
        ruleKey: rule.ruleKey,
        hit: compareGte(drawdown, minDrawdown)
          && compareLte(drawdown, maxDrawdown)
          && compareGte(metrics.closeVsMa20Percent, threshold.close_vs_ma20_gte_percent ?? -2)
          && compareGte(metrics.closeVsMa60Percent, threshold.close_vs_ma60_gte_percent ?? -1)
          && compareGte(metrics.recoveryFrom5dLowPercent, threshold.recovery_from_5d_low_gte_percent ?? 2.5)
      };
    }
    default:
      return { ruleKey: rule.ruleKey, hit: false };
  }
};

export const evaluateSilverSwingRules = (
  pointsInput: MarketPricePoint[],
  rulesInput: MarketAssistRuleInput[],
  targetDate?: string
): SilverSwingEvaluation => {
  const rules = normalizeMarketAssistRules(rulesInput);
  const { point, metrics } = calculateSilverSwingMetrics(pointsInput, targetDate);
  const rawEvaluations = rules.map(rule => evaluateRule(metrics, rule));
  const rawHitMap = new Map(rawEvaluations.map(item => [item.ruleKey, item.hit]));

  const evaluations = rawEvaluations.map(evaluation => {
    const rule = rules.find(item => item.ruleKey === evaluation.ruleKey);
    const excludedStates = Array.isArray(rule?.threshold.excluded_states)
      ? rule?.threshold.excluded_states.map(value => String(value))
      : [];
    if (excludedStates.some(ruleKey => rawHitMap.get(ruleKey))) {
      return { ...evaluation, hit: false };
    }
    return evaluation;
  });

  return {
    date: point.date,
    close: point.close,
    metrics,
    rules: evaluations,
    hitRuleKeys: evaluations.filter(item => item.hit).map(item => item.ruleKey)
  };
};

export const clusterRuleHits = (
  evaluations: SilverSwingEvaluation[],
  ruleKey: string,
  mergeGap = 0
) => {
  const clusters: Array<{ start: string; end: string; days: number }> = [];
  let current: string[] = [];
  let skipped = 0;

  for (const evaluation of evaluations) {
    const hit = evaluation.hitRuleKeys.includes(ruleKey);
    if (hit) {
      current.push(evaluation.date);
      skipped = 0;
      continue;
    }
    if (current.length && skipped < mergeGap) {
      skipped += 1;
      continue;
    }
    if (current.length) {
      clusters.push({ start: current[0], end: current[current.length - 1], days: current.length });
      current = [];
      skipped = 0;
    }
  }

  if (current.length) {
    clusters.push({ start: current[0], end: current[current.length - 1], days: current.length });
  }

  return clusters;
};
