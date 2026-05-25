import { getFinancePlanProfileConfig, getFinanceStructureProfileConfig } from './financePlanProfile';

export const ENTRY_READY_TREND_PHASES = new Set(['BREAKOUT', 'SLOW_GRIND_UP', 'RECOVERY']);
export const ENTRY_HARD_BLOCK_TREND_PHASES = new Set(['REBOUND', 'SLOW_BLEED', 'CRASH_DROP']);
export const ENTRY_TREND_PRIORITY: Record<string, number> = {
  SLOW_GRIND_UP: 0,
  BREAKOUT: 1,
  RECOVERY: 2
};

export interface DailyPrice {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

export type OpportunityTypeCode = 'DEFENSIVE' | 'REPAIR' | 'TREND' | 'EMOTIONAL' | 'NOT_APPLICABLE';

export interface OpportunityTypeTag {
  code: OpportunityTypeCode;
  label: string;
  tone: 'neutral' | 'warn' | 'good';
  reason: string;
}

export interface StructureCheckResult {
  symbol: string;
  name: string;
  asset_type: string;
  trade_date: string;
  close: number;
  ma20: number;
  ma60: number;
  ma120: number;
  ma60_prev: number;
  ma60_slope: string;
  distance_to_ma60: number;
  above_ma60_days: number;
  below_ma60_days: number;
  low_20: number | null;
  low_60: number | null;
  high_60: number | null;
  drawdown_20: number | null;
  drawdown_60: number | null;
  structure_status: string;
  structure_reason: string;
  safe_zone_status: string;
  safe_zone_reason: string;
  invalidation_line: number;
  market_regime: string;
  entry_permission: string;
  trend_phase_code?: string | null;
  trend_phase_reason?: string | null;
  trend_action?: string;
  trend_action_reason?: string;
  final_status: string;
  final_reason: string;
  data_source_used: string;
  available_sources: string[];
  structure_score?: StructureScoreResult;
  opportunity_type?: OpportunityTypeTag;
}

export function getTrendPhaseLabel(code?: string | null): string {
  switch (code) {
    case 'CRASH_DROP': return '暴跌';
    case 'SURGE': return '急涨';
    case 'REBOUND': return '反抽';
    case 'BREAKOUT': return '突破';
    case 'HIGH_BASE': return '高位横盘';
    case 'TREND_UP': return '趋势上行';
    case 'SLOW_GRIND_UP': return '慢涨';
    case 'RECOVERY': return '修复';
    case 'SIDEWAYS': return '横盘震荡';
    case 'SLOW_BLEED': return '阴跌';
    case 'CONSOLIDATION': return '震荡待确认';
    case 'TREND_TRANSITION': return '趋势转换中';
    case 'UNKNOWN': return '状态未确认';
    default: return code || '状态未确认';
  }
}

export function getEntryTrendPriority(code?: string | null): number {
  return ENTRY_TREND_PRIORITY[code || ''] ?? 9;
}

export function getEntryManualPriorityLevel(
  trendPhaseCode: string | null | undefined,
  triggerScore: number,
  structureScore: number,
  maxLossPercent: number | null,
  planProfileKey?: string | null
) {
  const profile = getFinancePlanProfileConfig(planProfileKey);
  if (!ENTRY_READY_TREND_PHASES.has(trendPhaseCode || '')) return 'OBSERVE';
  const riskOk = maxLossPercent !== null && maxLossPercent <= profile.maxRiskPercent;
  const riskTight = maxLossPercent !== null && maxLossPercent <= profile.tightRiskPercent;

  if (trendPhaseCode === 'SLOW_GRIND_UP' && triggerScore >= 75 && structureScore >= 75 && riskTight) {
    return 'A';
  }
  if (triggerScore >= 80 && structureScore >= 75 && riskOk) {
    return 'A';
  }
  if (trendPhaseCode === 'BREAKOUT' && triggerScore >= 70 && structureScore >= 75 && riskOk) {
    return 'A';
  }
  if (trendPhaseCode === 'SLOW_GRIND_UP' && triggerScore >= 55 && structureScore >= 70) {
    return 'B';
  }
  if (trendPhaseCode === 'RECOVERY' && triggerScore >= 70 && structureScore >= 70 && riskOk) {
    return 'B';
  }
  if (triggerScore >= 60 && structureScore >= 70) {
    return 'B';
  }
  return 'C';
}

export function getEntryManualPriorityScore(
  trendPhaseCode: string | null | undefined,
  triggerScore: number,
  structureScore: number,
  maxLossPercent: number | null,
  planProfileKey?: string | null
) {
  const profile = getFinancePlanProfileConfig(planProfileKey);
  const level = getEntryManualPriorityLevel(trendPhaseCode, triggerScore, structureScore, maxLossPercent, planProfileKey);
  const levelScore = level === 'A' ? 300 : level === 'B' ? 200 : level === 'C' ? 100 : 0;
  const trendScore = Math.max(0, 30 - getEntryTrendPriority(trendPhaseCode) * 10);
  const riskScore = maxLossPercent === null ? 0 : Math.max(0, Math.round((profile.maxRiskPercent - Math.min(maxLossPercent, profile.maxRiskPercent)) * 1000));
  return levelScore + trendScore + Math.round(triggerScore || 0) + Math.round((structureScore || 0) / 2) + riskScore;
}

export function getTrendAction(
  trendPhaseCode: string | null | undefined,
  structureScore: StructureScoreResult,
  structure: ReturnType<typeof calculateStructure>
): { action: string; reason: string } {
  if (structureScore.metrics.is_invalidated || structure.structure_status === 'STRUCTURE_BROKEN') {
    return {
      action: 'BLOCK',
      reason: '结构已失效，走势阶段只作记录，不进入后续流程。'
    };
  }

  switch (trendPhaseCode) {
    case 'SLOW_GRIND_UP':
      if (structureScore.score >= 75 && structure.safe_zone_status === 'SAFE_ZONE') {
        return { action: 'HIGH_PRIORITY', reason: '慢涨 + 安全区 + 结构分较高，可优先进入入场触发观察。' };
      }
      return { action: 'WATCH', reason: '慢涨阶段但结构分或安全区不足，继续观察。' };
    case 'BREAKOUT':
      return { action: structureScore.score >= 70 ? 'HIGH_PRIORITY' : 'WATCH', reason: '突破阶段优先看回踩是否不破，满足后再进入入场触发。' };
    case 'RECOVERY':
      return { action: structureScore.score >= 65 ? 'MEDIUM_HIGH_PRIORITY' : 'WATCH', reason: '修复阶段适合观察结构能否刚成立，不直接追。' };
    case 'TREND_UP':
      return { action: 'WATCH', reason: '趋势上行但波动高于慢涨标准，先观察回踩是否稳定，不直接提高到入场优先。' };
    case 'TREND_TRANSITION':
    case 'CONSOLIDATION':
    case 'SIDEWAYS':
      return { action: 'WATCH', reason: '走势仍偏观察，等待方向确认或触发条件出现。' };
    case 'SURGE':
      return { action: 'WAIT_PULLBACK', reason: '急涨阶段不追，等待回踩 MA20/MA60 或平台确认。' };
    case 'HIGH_BASE':
      return { action: 'LOWER_PRIORITY', reason: '高位横盘降低优先级，重点防止高位假突破。' };
    case 'REBOUND':
    case 'SLOW_BLEED':
    case 'CRASH_DROP':
      return { action: 'BLOCK', reason: `${getTrendPhaseLabel(trendPhaseCode)}阶段不进入买入计划，只保留观察。` };
    default:
      return { action: 'WATCH', reason: '走势阶段未确认，先按观察处理。' };
  }
}

export interface StructureScoreDetail {
  label: string;
  score: number;
  max_score: number;
  status: 'good' | 'neutral' | 'bad';
  reason: string;
}

export interface StructureScoreResult {
  score: number;
  level: 'STRONG' | 'GOOD' | 'WATCH' | 'WEAK' | 'BROKEN';
  level_label: string;
  conclusion: string;
  details: StructureScoreDetail[];
  penalty_reasons: string[];
  metrics: {
    ma20_slope: 'up' | 'flat' | 'down' | 'unknown';
    ma60_slope: 'up' | 'flat' | 'down' | 'unknown';
    max_drawdown_20: number | null;
    amplitude_20: number | null;
    box_position: 'lower' | 'middle' | 'upper' | 'unknown';
    box_position_ratio: number | null;
    has_breakout_pullback: boolean;
    is_invalidated: boolean;
  };
}

function toNullableNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function classifyOpportunityType(input: {
  asset_type?: string;
  plan_profile?: string | null;
  profile_key?: string | null;
  structure_status?: string | null;
  safe_zone_status?: string | null;
  trend_phase_code?: string | null;
  distance_to_ma60?: number | null;
  above_ma60_days?: number | null;
  ma20_slope?: string | null;
  ma60_slope?: string | null;
  amplitude_20?: number | null;
}): OpportunityTypeTag {
  const trendPhaseCode = String(input.trend_phase_code || 'UNKNOWN');
  const assetType = String(input.asset_type || 'stock');
  const distanceToMa60 = toNullableNumber(input.distance_to_ma60);
  const aboveMa60Days = toNullableNumber(input.above_ma60_days) ?? 0;
  const amplitude20 = toNullableNumber(input.amplitude_20);
  const structureConfirmed = input.structure_status === 'STRUCTURE_CONFIRMED';
  const safeZone = input.safe_zone_status === 'SAFE_ZONE';
  const ma20Slope = String(input.ma20_slope || '');
  const ma60Slope = String(input.ma60_slope || '');
  const profile = getFinanceStructureProfileConfig(input.plan_profile || input.profile_key);
  const distanceComfortable = distanceToMa60 !== null && distanceToMa60 >= profile.safeZoneMin && distanceToMa60 <= profile.distanceComfortMax;
  const distanceClose = distanceToMa60 !== null && distanceToMa60 >= profile.safeZoneMin && distanceToMa60 <= profile.distanceTightMax;
  const lowVolatility = amplitude20 !== null && amplitude20 <= profile.lowVolatilityMax;

  if (!['stock', 'etf'].includes(assetType)) {
    return {
      code: 'NOT_APPLICABLE',
      label: '不适用型',
      tone: 'neutral',
      reason: '资产类型不匹配当前权益池，先进入资产路由，不作为交易许可。'
    };
  }

  if (
    trendPhaseCode === 'SURGE' ||
    (amplitude20 !== null && amplitude20 >= profile.emotionalAmplitudeMin && !distanceClose)
  ) {
    return {
      code: 'EMOTIONAL',
      label: '情绪型/急涨型',
      tone: 'warn',
      reason: '短期急涨或波动过大，只作为解释层提示，不追涨，不直接放大计划。'
    };
  }

  if (
    safeZone &&
    structureConfirmed &&
    distanceComfortable &&
    (
      trendPhaseCode === 'SLOW_GRIND_UP' ||
      trendPhaseCode === 'BREAKOUT' ||
      (ma20Slope === 'up' && (ma60Slope === 'up' || ma60Slope === 'flat') && aboveMa60Days >= 10)
    )
  ) {
    return {
      code: 'TREND',
      label: '趋势型',
      tone: 'good',
      reason: '结构较强，可优先进入计划跟踪，仍需失效线和仓位控制。'
    };
  }

  if (
    trendPhaseCode === 'SIDEWAYS' ||
    trendPhaseCode === 'CONSOLIDATION' ||
    (distanceClose && aboveMa60Days >= 12 && (lowVolatility || trendPhaseCode === 'RECOVERY'))
  ) {
    return {
      code: 'DEFENSIVE',
      label: '防守型',
      tone: 'neutral',
      reason: '低波动或横盘属性更强，结构稳定但进攻性不足，适合观察或低仓训练。'
    };
  }

  if (
    trendPhaseCode === 'RECOVERY' ||
    trendPhaseCode === 'TREND_TRANSITION' ||
    trendPhaseCode === 'REBOUND' ||
    trendPhaseCode === 'HIGH_BASE' ||
    trendPhaseCode === 'UNKNOWN' ||
    !structureConfirmed ||
    aboveMa60Days < 10 ||
    ma60Slope === 'down'
  ) {
    return {
      code: 'REPAIR',
      label: '修复型',
      tone: 'warn',
      reason: '刚从下跌或震荡中修复，尚未证明趋势重启，等待二次确认。'
    };
  }

  return {
    code: 'DEFENSIVE',
    label: '防守型',
    tone: 'neutral',
    reason: '结构偏稳但进攻特征不强，适合观察或低仓训练。'
  };
}

export interface EntryTriggerItem {
  code: string;
  name: string;
  status: 'triggered' | 'waiting' | 'blocked';
  score: number;
  reason: string;
}

export interface EntryTriggerPlan {
  action: 'READY_TO_PLAN' | 'WAIT_TRIGGER' | 'WAIT_PULLBACK' | 'OBSERVE' | 'BLOCKED' | 'INVALIDATED';
  action_label: string;
  trigger_score: number;
  trigger_reason: string;
  triggered_items: EntryTriggerItem[];
  waiting_items: EntryTriggerItem[];
  blocked_reasons: string[];
  plan_draft: {
    entry_reason: string;
    trigger_condition: string;
    suggested_entry_zone: string;
    invalidation_line: number;
    max_loss_percent: number | null;
    plan_profile: string;
    plan_profile_label: string;
    plan_profile_note: string;
    position_suggestion: string;
    follow_up: string;
  };
  metrics: {
    distance_to_ma20: number | null;
    distance_to_ma60: number;
    latest_change: number | null;
    volume_ratio_5: number | null;
    recent_breakout_level: number | null;
    days_since_breakout: number | null;
    not_chasing: boolean;
    manual_priority_level: string;
    manual_priority_score: number;
    trend_priority_rank: number;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getMovingAverage(prices: DailyPrice[], period: number, endExclusive: number): number | null {
  const start = endExclusive - period;
  if (start < 0) return null;
  const closes = prices.slice(start, endExclusive).map((price) => Number(price.close)).filter(Number.isFinite);
  return closes.length === period ? average(closes) : null;
}

function getSlope(current: number | null, previous: number | null): 'up' | 'flat' | 'down' | 'unknown' {
  if (current === null || previous === null || previous === 0) return 'unknown';
  const change = (current - previous) / previous;
  if (change > 0.001) return 'up';
  if (change < -0.001) return 'down';
  return 'flat';
}

function getMaxDrawdown(prices: DailyPrice[]): number | null {
  if (prices.length < 2) return null;
  let peak = Number(prices[0].close);
  let maxDrawdown = 0;
  prices.forEach((price) => {
    const close = Number(price.close);
    if (!Number.isFinite(close)) return;
    peak = Math.max(peak, close);
    if (peak > 0) {
      maxDrawdown = Math.min(maxDrawdown, (close - peak) / peak);
    }
  });
  return Math.abs(maxDrawdown);
}

function getAmplitude(prices: DailyPrice[]): number | null {
  if (prices.length === 0) return null;
  const highs = prices.map((price) => Number(price.high)).filter(Number.isFinite);
  const lows = prices.map((price) => Number(price.low)).filter(Number.isFinite);
  if (highs.length === 0 || lows.length === 0) return null;
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  return low > 0 ? (high - low) / low : null;
}

function getBoxPosition(prices: DailyPrice[], close: number): { position: StructureScoreResult['metrics']['box_position']; ratio: number | null } {
  if (prices.length < 20) return { position: 'unknown', ratio: null };
  const highs = prices.map((price) => Number(price.high)).filter(Number.isFinite);
  const lows = prices.map((price) => Number(price.low)).filter(Number.isFinite);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  if (high <= low) return { position: 'unknown', ratio: null };
  const ratio = clamp((close - low) / (high - low), 0, 1);
  if (ratio <= 0.35) return { position: 'lower', ratio };
  if (ratio >= 0.7) return { position: 'upper', ratio };
  return { position: 'middle', ratio };
}

export function roundRatio(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

export function calculateStructureScore(
  structure: ReturnType<typeof calculateStructure>,
  prices: DailyPrice[],
  planProfileKey?: string | null
): StructureScoreResult {
  const profile = getFinanceStructureProfileConfig(planProfileKey);
  const latestIndex = prices.length;
  const recent20 = prices.slice(-20);
  const recent60 = prices.slice(-60);
  const recent120 = prices.slice(-120);

  const ma20Current = getMovingAverage(prices, 20, latestIndex) ?? structure.ma20;
  const ma20Previous = getMovingAverage(prices, 20, latestIndex - 1);
  const ma60Current = getMovingAverage(prices, 60, latestIndex) ?? structure.ma60;
  const ma60Previous = getMovingAverage(prices, 60, latestIndex - 1);
  const ma20Slope = getSlope(ma20Current, ma20Previous);
  const ma60Slope = getSlope(ma60Current, ma60Previous);
  const maxDrawdown20 = getMaxDrawdown(recent20);
  const amplitude20 = getAmplitude(recent20);
  const box = getBoxPosition(recent120.length >= 60 ? recent120 : recent60, structure.close);
  const isInvalidated = Boolean(structure.invalidation_line && structure.close < structure.invalidation_line);
  const previous20High = recent20.length >= 20 ? Math.max(...recent20.slice(0, -1).map((price) => Number(price.high)).filter(Number.isFinite)) : null;
  const hasBreakoutPullback = Boolean(
    previous20High &&
    structure.close >= structure.ma20 &&
    structure.close >= structure.ma60 &&
    structure.close <= previous20High * (1 + Math.min(profile.safeZoneMax, 0.06)) &&
    structure.close >= previous20High * (1 - Math.abs(profile.safeZoneMin))
  );

  const details: StructureScoreDetail[] = [];
  const addDetail = (detail: StructureScoreDetail) => details.push(detail);

  const aboveDaysScore = structure.above_ma60_days >= Math.max(20, profile.minAboveMa60Days * 5) ? 15 : structure.above_ma60_days >= Math.max(10, profile.minAboveMa60Days * 3) ? 12 : structure.above_ma60_days >= profile.minAboveMa60Days ? 8 : structure.above_ma60_days > 0 ? 4 : 0;
  addDetail({
    label: '站上MA60天数',
    score: aboveDaysScore,
    max_score: 15,
    status: aboveDaysScore >= 12 ? 'good' : aboveDaysScore >= 8 ? 'neutral' : 'bad',
    reason: `连续站上 MA60 ${structure.above_ma60_days} 天`
  });

  const ma60Score = ma60Slope === 'up' ? 15 : ma60Slope === 'flat' ? 8 : ma60Slope === 'unknown' ? 6 : 0;
  addDetail({
    label: 'MA60方向',
    score: ma60Score,
    max_score: 15,
    status: ma60Score >= 12 ? 'good' : ma60Score >= 6 ? 'neutral' : 'bad',
    reason: ma60Slope === 'up' ? 'MA60 上行' : ma60Slope === 'flat' ? 'MA60 走平' : ma60Slope === 'down' ? 'MA60 下行' : 'MA60 方向数据不足'
  });

  const ma20Score = ma20Slope === 'up' ? 10 : ma20Slope === 'flat' ? 6 : ma20Slope === 'unknown' ? 4 : 0;
  addDetail({
    label: 'MA20方向',
    score: ma20Score,
    max_score: 10,
    status: ma20Score >= 8 ? 'good' : ma20Score >= 4 ? 'neutral' : 'bad',
    reason: ma20Slope === 'up' ? 'MA20 开始上行' : ma20Slope === 'flat' ? 'MA20 走平' : ma20Slope === 'down' ? 'MA20 下行' : 'MA20 方向数据不足'
  });

  const distance = structure.distance_to_ma60;
  const distanceScore = distance < 0 ? 0 : distance <= profile.distanceComfortMax ? 15 : distance <= profile.distanceWatchMax ? 10 : distance <= profile.highRiskChaseMin * 2.5 ? 5 : 0;
  addDetail({
    label: '距离MA60',
    score: distanceScore,
    max_score: 15,
    status: distanceScore >= 12 ? 'good' : distanceScore >= 5 ? 'neutral' : 'bad',
    reason: distance < 0 ? '仍在 MA60 下方' : distance <= profile.distanceComfortMax ? `符合${profile.label}的MA60舒适距离` : distance <= profile.distanceWatchMax ? `距离 MA60 中等，仍在${profile.label}观察区` : '距离 MA60 偏远，有追高风险'
  });

  const drawdownScore = maxDrawdown20 === null ? 4 : maxDrawdown20 <= profile.drawdownGoodMax ? 10 : maxDrawdown20 <= profile.drawdownWatchMax ? 7 : maxDrawdown20 <= profile.drawdownWeakMax ? 3 : 0;
  addDetail({
    label: '20日最大回撤',
    score: drawdownScore,
    max_score: 10,
    status: drawdownScore >= 8 ? 'good' : drawdownScore >= 4 ? 'neutral' : 'bad',
    reason: maxDrawdown20 === null ? '20 日回撤数据不足' : `20 日最大回撤 ${(maxDrawdown20 * 100).toFixed(2)}%`
  });

  const amplitudeScore = amplitude20 === null ? 4 : amplitude20 <= profile.amplitudeGoodMax ? 10 : amplitude20 <= profile.amplitudeWatchMax ? 7 : amplitude20 <= profile.amplitudeWeakMax ? 3 : 0;
  addDetail({
    label: '20日振幅',
    score: amplitudeScore,
    max_score: 10,
    status: amplitudeScore >= 8 ? 'good' : amplitudeScore >= 4 ? 'neutral' : 'bad',
    reason: amplitude20 === null ? '20 日振幅数据不足' : `20 日振幅 ${(amplitude20 * 100).toFixed(2)}%`
  });

  addDetail({
    label: '突破后回踩',
    score: hasBreakoutPullback ? 10 : structure.structure_status === 'STRUCTURE_CONFIRMED' ? 6 : 2,
    max_score: 10,
    status: hasBreakoutPullback ? 'good' : structure.structure_status === 'STRUCTURE_CONFIRMED' ? 'neutral' : 'bad',
    reason: hasBreakoutPullback ? '接近突破位且未跌回 MA20/MA60' : '暂未识别出明确突破后回踩形态'
  });

  addDetail({
    label: '失效线',
    score: isInvalidated ? 0 : structure.below_ma60_days > 0 ? 3 : 10,
    max_score: 10,
    status: isInvalidated ? 'bad' : structure.below_ma60_days > 0 ? 'neutral' : 'good',
    reason: isInvalidated ? '已跌破失效线' : structure.below_ma60_days > 0 ? `连续跌破 MA60 ${structure.below_ma60_days} 天` : '未跌破失效线'
  });

  const boxScore = box.position === 'lower' ? 5 : box.position === 'middle' ? 4 : box.position === 'upper' ? 2 : 2;
  addDetail({
    label: '箱体位置',
    score: boxScore,
    max_score: 5,
    status: box.position === 'lower' || box.position === 'middle' ? 'good' : box.position === 'upper' ? 'neutral' : 'bad',
    reason: box.position === 'lower' ? '处于箱体下沿' : box.position === 'middle' ? '处于箱体中位' : box.position === 'upper' ? '处于箱体高位' : '箱体位置数据不足'
  });

  const score = clamp(Math.round(details.reduce((sum, detail) => sum + detail.score, 0)), 0, 100);
  const penaltyReasons = details
    .filter((detail) => detail.status === 'bad')
    .map((detail) => detail.reason)
    .slice(0, 4);

  let level: StructureScoreResult['level'] = 'WEAK';
  let levelLabel = '结构偏弱';
  let conclusion = '先观察，等待 MA60、MA20 和安全区继续修复。';
  if (isInvalidated || structure.structure_status === 'STRUCTURE_BROKEN') {
    level = 'BROKEN';
    levelLabel = '结构失效';
    conclusion = '结构已经失效，不进入买入计划。';
  } else if (score >= 80) {
    level = 'STRONG';
    levelLabel = '结构强';
    conclusion = '结构质量较高，可进入后续入场触发观察。';
  } else if (score >= 65) {
    level = 'GOOD';
    levelLabel = '结构良好';
    conclusion = '结构基本可用，等待更明确的入场触发。';
  } else if (score >= 50) {
    level = 'WATCH';
    levelLabel = '结构观察';
    conclusion = '结构正在修复，适合放观察池。';
  }

  return {
    score,
    level,
    level_label: levelLabel,
    conclusion,
    details,
    penalty_reasons: penaltyReasons,
    metrics: {
      ma20_slope: ma20Slope,
      ma60_slope: ma60Slope,
      max_drawdown_20: roundRatio(maxDrawdown20),
      amplitude_20: roundRatio(amplitude20),
      box_position: box.position,
      box_position_ratio: roundRatio(box.ratio),
      has_breakout_pullback: hasBreakoutPullback,
      is_invalidated: isInvalidated
    }
  };
}

function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return Number(value).toFixed(3);
}

function getVolumeRatio5(prices: DailyPrice[]): number | null {
  if (prices.length < 6) return null;
  const latest = Number(prices[prices.length - 1].volume);
  const previous5 = prices.slice(-6, -1).map((price) => Number(price.volume)).filter(Number.isFinite);
  const avg5 = average(previous5);
  if (!Number.isFinite(latest) || !avg5 || avg5 <= 0) return null;
  return roundRatio(latest / avg5);
}

function getRecentBreakout(prices: DailyPrice[]): { level: number | null; days: number | null } {
  if (prices.length < 25) return { level: null, days: null };
  const latestIndex = prices.length - 1;
  for (let index = latestIndex; index >= Math.max(20, latestIndex - 4); index--) {
    const previous20 = prices.slice(index - 20, index);
    const highs = previous20.map((price) => Number(price.high)).filter(Number.isFinite);
    if (highs.length < 20) continue;
    const level = Math.max(...highs);
    if (Number(prices[index].close) > level) {
      return { level, days: latestIndex - index };
    }
  }
  return { level: null, days: null };
}

export function calculateEntryTriggerPlan(
  structure: ReturnType<typeof calculateStructure>,
  structureScore: StructureScoreResult,
  prices: DailyPrice[],
  marketRegime: string,
  entryPermission: string,
  trendPhaseCode?: string | null,
  trendAction?: string,
  planProfileKey?: string | null
): EntryTriggerPlan {
  const planProfile = getFinancePlanProfileConfig(planProfileKey);
  const latest = prices[prices.length - 1];
  const previous = prices.length >= 2 ? prices[prices.length - 2] : null;
  const latestChange = previous && previous.close > 0 ? roundRatio((latest.close - previous.close) / previous.close) : null;
  const distanceToMa20 = structure.ma20 > 0 ? roundRatio((structure.close - structure.ma20) / structure.ma20) : null;
  const volumeRatio5 = getVolumeRatio5(prices);
  const recentBreakout = getRecentBreakout(prices);
  const notChasing = structure.distance_to_ma60 <= planProfile.chaseDistanceMax && (latestChange === null || latestChange <= planProfile.dailyChangeChaseMax);
  const nearInvalidation = structure.invalidation_line > 0
    ? (structure.close - structure.invalidation_line) / structure.close <= planProfile.nearInvalidationMax && structure.close > structure.invalidation_line
    : false;
  const maxLossPercent = structure.invalidation_line > 0 && structure.close > structure.invalidation_line
    ? roundRatio((structure.close - structure.invalidation_line) / structure.close)
    : null;

  const blockedReasons: string[] = [];
  const structureReadinessReasons: string[] = [];
  const trendReadinessReasons: string[] = [];
  if (!planProfile.allowsTradePlan) {
    blockedReasons.push(`${planProfile.label}：${planProfile.note}`);
  }
  if (entryPermission !== 'ALLOW_STRUCTURE_CHECK') {
    blockedReasons.push('市场权限未放行，当前只允许观察或等待修复。');
  }
  if (structureScore.metrics.is_invalidated || structure.structure_status === 'STRUCTURE_BROKEN') {
    blockedReasons.push('结构已跌破失效线或进入结构破坏。');
  }
  if (structure.structure_status !== 'STRUCTURE_CONFIRMED') {
    structureReadinessReasons.push('结构尚未成立');
  }
  if (structure.safe_zone_status !== 'SAFE_ZONE') {
    structureReadinessReasons.push('位置不在相对安全区');
  }
  const trendPhaseReady = ENTRY_READY_TREND_PHASES.has(trendPhaseCode || '');
  const trendPhaseHardBlocked = ENTRY_HARD_BLOCK_TREND_PHASES.has(trendPhaseCode || '');
  if (trendPhaseHardBlocked) {
    blockedReasons.push(`${getTrendPhaseLabel(trendPhaseCode)}阶段不生成买入计划。`);
  } else if (!trendPhaseReady) {
    const trendLabel = getTrendPhaseLabel(trendPhaseCode);
    if (trendPhaseCode === 'SURGE') {
      trendReadinessReasons.push('急涨阶段需要等待回踩确认');
    } else if (trendPhaseCode === 'HIGH_BASE') {
      trendReadinessReasons.push('高位横盘阶段只观察，防止假突破');
    } else if (trendPhaseCode === 'SIDEWAYS') {
      trendReadinessReasons.push('横盘震荡阶段方向未确认');
    } else if (trendPhaseCode === 'TREND_TRANSITION') {
      trendReadinessReasons.push('趋势转换中，尚未确认新方向');
    } else if (trendPhaseCode === 'CONSOLIDATION') {
      trendReadinessReasons.push('震荡待确认，尚未形成可执行趋势');
    } else {
      trendReadinessReasons.push(`走势阶段为${trendLabel}，未达到准备入场阶段`);
    }
  }

  const items: EntryTriggerItem[] = [
    {
      code: 'PULLBACK_MA60_HOLD',
      name: '回踩 MA60 不破',
      status: latest.low <= structure.ma60 * 1.025 && structure.close >= structure.ma60 && structure.distance_to_ma60 <= 0.05 ? 'triggered' : 'waiting',
      score: latest.low <= structure.ma60 * 1.025 && structure.close >= structure.ma60 && structure.distance_to_ma60 <= 0.05 ? 25 : 0,
      reason: `最低价 ${formatPrice(latest.low)}，MA60 ${formatPrice(structure.ma60)}，偏离 MA60 ${(structure.distance_to_ma60 * 100).toFixed(2)}%。`
    },
    {
      code: 'PULLBACK_MA20_HOLD',
      name: '回踩 MA20 不破',
      status: latest.low <= structure.ma20 * 1.02 && structure.close >= structure.ma20 && structureScore.metrics.ma20_slope !== 'down' ? 'triggered' : 'waiting',
      score: latest.low <= structure.ma20 * 1.02 && structure.close >= structure.ma20 && structureScore.metrics.ma20_slope !== 'down' ? 20 : 0,
      reason: `最低价 ${formatPrice(latest.low)}，MA20 ${formatPrice(structure.ma20)}，MA20方向：${structureScore.metrics.ma20_slope}。`
    },
    {
      code: 'BREAKOUT_CONFIRM_1_3',
      name: '突破后 1-3 天不跌回平台',
      status: recentBreakout.level && recentBreakout.days !== null && recentBreakout.days <= 3 && structure.close >= recentBreakout.level * 0.98 ? 'triggered' : 'waiting',
      score: recentBreakout.level && recentBreakout.days !== null && recentBreakout.days <= 3 && structure.close >= recentBreakout.level * 0.98 ? 20 : 0,
      reason: recentBreakout.level
        ? `近 ${recentBreakout.days} 天出现突破，平台位约 ${formatPrice(recentBreakout.level)}，当前未明显跌回。`
        : '近 5 个交易日未识别出明确平台突破。'
    },
    {
      code: 'SHORT_RECLAIM',
      name: '缩量回踩后重新站上短线',
      status: structure.close >= structure.ma20 && (volumeRatio5 === null || volumeRatio5 <= 1.15) && structureScore.metrics.ma20_slope !== 'down' ? 'triggered' : 'waiting',
      score: structure.close >= structure.ma20 && (volumeRatio5 === null || volumeRatio5 <= 1.15) && structureScore.metrics.ma20_slope !== 'down' ? 15 : 0,
      reason: volumeRatio5 === null
        ? '成交量数据不足，按价格重新站上 MA20 观察。'
        : `当前成交量约为 5 日均量 ${volumeRatio5.toFixed(2)} 倍。`
    },
    {
      code: 'NEAR_INVALIDATION_LINE',
      name: '距离失效线足够近',
      status: nearInvalidation ? 'triggered' : 'waiting',
      score: nearInvalidation ? 10 : 0,
      reason: maxLossPercent === null
        ? '当前价格未站在失效线之上。'
        : `到${planProfile.label}失效线的理论风险约 ${(maxLossPercent * 100).toFixed(2)}%。`
    },
    {
      code: 'NOT_CHASING_TODAY',
      name: '当天不是追高状态',
      status: notChasing ? 'triggered' : 'blocked',
      score: notChasing ? 10 : 0,
      reason: latestChange === null
        ? `偏离 MA60 ${(structure.distance_to_ma60 * 100).toFixed(2)}%，当前Profile允许追高上限 ${(planProfile.chaseDistanceMax * 100).toFixed(1)}%。`
        : `当日涨跌幅 ${(latestChange * 100).toFixed(2)}%，偏离 MA60 ${(structure.distance_to_ma60 * 100).toFixed(2)}%，当前Profile日涨幅追高上限 ${(planProfile.dailyChangeChaseMax * 100).toFixed(1)}%。`
    }
  ];

  if (!notChasing) {
    blockedReasons.push('当前位置偏离 MA60 较远或当日涨幅偏大，避免追高。');
  }
  if (structureScore.score < 50) {
    blockedReasons.push('结构评分低于 50，入场触发不可靠。');
  }
  const structureReady = structureReadinessReasons.length === 0;
  const trendReady = trendReadinessReasons.length === 0;

  const triggeredItems = items.filter((item) => item.status === 'triggered');
  const waitingItems = items.filter((item) => item.status === 'waiting');
  const triggerScore = clamp(Math.round(items.reduce((sum, item) => sum + item.score, 0)), 0, 100);
  const primaryTrigger = triggeredItems.find((item) => item.code !== 'NOT_CHASING_TODAY') || triggeredItems[0];

  let action: EntryTriggerPlan['action'] = 'WAIT_TRIGGER';
  let actionLabel = '等待触发';
  let triggerReason = '结构可以继续观察，但尚未出现足够明确的入场触发。';

  if (structureScore.metrics.is_invalidated || structure.structure_status === 'STRUCTURE_BROKEN') {
    action = 'INVALIDATED';
    actionLabel = '结构失效';
    triggerReason = '已跌破失效线或结构破坏，不生成买入计划。';
  } else if (blockedReasons.length > 0 && (!planProfile.allowsTradePlan || entryPermission !== 'ALLOW_STRUCTURE_CHECK' || trendPhaseHardBlocked || structureScore.score < 50)) {
    action = 'BLOCKED';
    actionLabel = '禁止入场';
    triggerReason = blockedReasons[0];
  } else if (!structureReady) {
    if (structure.structure_status === 'STRUCTURE_CONFIRMED' && (structure.safe_zone_status === 'HIGH_RISK_CHASE' || !notChasing)) {
      action = 'WAIT_PULLBACK';
      actionLabel = '等待回踩';
      triggerReason = '结构已成立但位置不在相对安全区，等待回踩后再确认。';
    } else {
      action = 'OBSERVE';
      actionLabel = '结构观察';
      triggerReason = `${structureReadinessReasons.join('，')}，不生成买入计划草案。`;
    }
  } else if (!trendReady) {
    if (trendPhaseCode === 'SURGE' || trendAction === 'WAIT_PULLBACK') {
      action = 'WAIT_PULLBACK';
      actionLabel = '等待回踩';
    } else {
      action = 'OBSERVE';
      actionLabel = '走势观察';
    }
    triggerReason = `${trendReadinessReasons.join('，')}，不生成买入计划草案。`;
  } else if (trendAction === 'WAIT_PULLBACK' || structure.safe_zone_status === 'HIGH_RISK_CHASE' || !notChasing) {
    action = 'WAIT_PULLBACK';
    actionLabel = '等待回踩';
    triggerReason = '当前更适合等回踩确认，不追高。';
  } else if (structureScore.score >= planProfile.minStructureScore && primaryTrigger && triggerScore >= planProfile.minTriggerScore) {
    action = 'READY_TO_PLAN';
    actionLabel = '可生成买入计划草案';
    triggerReason = `${primaryTrigger.name} 已触发，且结构评分达到 ${structureScore.score}；当前按${planProfile.label}参数生成计划。`;
  } else if (structureScore.score >= 50) {
    action = 'OBSERVE';
    actionLabel = '观察触发';
    triggerReason = '结构处于可观察区，等待 MA20/MA60 回踩不破或突破确认。';
  }

  const entryZoneLow = Math.min(structure.ma20, structure.ma60);
  const entryZoneHigh = Math.max(structure.ma20, structure.ma60) * 1.025;
  const manualPriorityLevel = getEntryManualPriorityLevel(
    trendPhaseCode,
    triggerScore,
    structureScore.score,
    maxLossPercent,
    planProfile.key
  );
  const manualPriorityScore = getEntryManualPriorityScore(
    trendPhaseCode,
    triggerScore,
    structureScore.score,
    maxLossPercent,
    planProfile.key
  );
  const positionSuggestion = action === 'READY_TO_PLAN'
    ? manualPriorityLevel === 'A' && trendPhaseCode === 'SLOW_GRIND_UP'
      ? '中等试仓上限，仍以失效线控制亏损；不加满，不追涨。'
      : manualPriorityLevel === 'A'
        ? '小到中等试仓，失效线清楚才执行，触发后继续复核。'
        : manualPriorityLevel === 'B'
          ? '小仓试探，确认延续后再考虑加仓。'
          : '最小观察仓试错，优先确认走势延续，不急于加仓。'
    : '暂不建仓，等待触发条件完成。';

  return {
    action,
    action_label: actionLabel,
    trigger_score: triggerScore,
    trigger_reason: triggerReason,
    triggered_items: triggeredItems,
    waiting_items: waitingItems,
    blocked_reasons: [...blockedReasons, ...structureReadinessReasons, ...trendReadinessReasons],
    plan_draft: {
      entry_reason: primaryTrigger ? `${primaryTrigger.name}；${triggerReason}` : triggerReason,
      trigger_condition: primaryTrigger ? primaryTrigger.name : '等待 MA20/MA60 回踩不破或突破后确认',
      suggested_entry_zone: `${formatPrice(entryZoneLow)} - ${formatPrice(entryZoneHigh)}`,
      invalidation_line: structure.invalidation_line,
      max_loss_percent: maxLossPercent,
      plan_profile: planProfile.key,
      plan_profile_label: planProfile.label,
      plan_profile_note: planProfile.note,
      position_suggestion: positionSuggestion,
      follow_up: '买入后跟踪 5/10/20/60 日表现，并记录是否跌破失效线、是否进入主升或是假突破。'
    },
    metrics: {
      distance_to_ma20: distanceToMa20,
      distance_to_ma60: structure.distance_to_ma60,
      latest_change: latestChange,
      volume_ratio_5: volumeRatio5,
      recent_breakout_level: recentBreakout.level ? Math.round(recentBreakout.level * 1000) / 1000 : null,
      days_since_breakout: recentBreakout.days,
      not_chasing: notChasing,
      manual_priority_level: manualPriorityLevel,
      manual_priority_score: manualPriorityScore,
      trend_priority_rank: getEntryTrendPriority(trendPhaseCode)
    }
  };
}

export function calculateStructure(prices: DailyPrice[], planProfileKey?: string | null): Omit<StructureCheckResult, 'symbol' | 'name' | 'asset_type' | 'market_regime' | 'entry_permission' | 'final_status' | 'final_reason' | 'data_source_used' | 'available_sources'> {
  const profile = getFinanceStructureProfileConfig(planProfileKey);
  const planProfile = getFinancePlanProfileConfig(planProfileKey);
  const latestPrice = prices[prices.length - 1];
  const close = latestPrice.close;
  const tradeDate = latestPrice.trade_date;

  const last20Prices = prices.slice(-20);
  const ma20 = last20Prices.reduce((sum, p) => sum + p.close, 0) / 20;

  const last60Prices = prices.slice(-60);
  const ma60 = last60Prices.reduce((sum, p) => sum + p.close, 0) / 60;

  const prev60Prices = prices.slice(-61, -1);
  const ma60Prev = prev60Prices.reduce((sum, p) => sum + p.close, 0) / 60;

  const ma60Slope = ma60 >= ma60Prev ? 'up' : 'down';

  const last120Prices = prices.slice(-120);
  const ma120 = last120Prices.length >= 120
    ? last120Prices.reduce((sum, p) => sum + p.close, 0) / 120
    : ma60;

  const distanceToMa60 = (close - ma60) / ma60;

  const getMA60At = (index: number): number | null => {
    if (index < 59) return null;
    const slice = prices.slice(index - 59, index + 1);
    return slice.reduce((sum, p) => sum + p.close, 0) / 60;
  };

  let aboveMa60Days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA60 = getMA60At(i);
    if (dayMA60 === null) break;
    if (prices[i].close > dayMA60) {
      aboveMa60Days++;
    } else {
      break;
    }
  }

  let belowMa60Days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA60 = getMA60At(i);
    if (dayMA60 === null) break;
    if (prices[i].close < dayMA60) {
      belowMa60Days++;
    } else {
      break;
    }
  }

  const low20 = last20Prices.length >= 20 ? Math.min(...last20Prices.map(p => p.close)) : null;
  const low60 = last60Prices.length >= 60 ? Math.min(...last60Prices.map(p => p.close)) : null;
  const high60 = last60Prices.length >= 60 ? Math.max(...last60Prices.map(p => p.close)) : null;

  const close20DaysAgo = prices.length >= 21 ? prices[prices.length - 21].close : null;
  const close60DaysAgo = prices.length >= 61 ? prices[prices.length - 61].close : null;

  const drawdown20 = close20DaysAgo !== null ? (close / close20DaysAgo) - 1 : null;
  const drawdown60 = close60DaysAgo !== null ? (close / close60DaysAgo) - 1 : null;

  let structureStatus: string;
  let structureReason: string;

  const ma60NotFalling = ma60 >= ma60Prev;
  if (close > ma60 && ma60NotFalling && aboveMa60Days >= profile.minAboveMa60Days) {
    structureStatus = 'STRUCTURE_CONFIRMED';
    structureReason = `按${profile.label}：收盘价站上MA60并连续站稳${profile.minAboveMa60Days}天，MA60未下弯。`;
  } else if (belowMa60Days >= profile.brokenBelowMa60Days) {
    structureStatus = 'STRUCTURE_BROKEN';
    structureReason = `按${profile.label}：收盘价连续跌破MA60达到${profile.brokenBelowMa60Days}天，结构破坏。`;
  } else {
    structureStatus = 'STRUCTURE_WATCH';
    const reasons: string[] = [];
    if (Math.abs(distanceToMa60) < profile.distanceTightMax) {
      reasons.push('价格接近MA60');
    }
    if (close > ma60 && aboveMa60Days < profile.minAboveMa60Days) {
      reasons.push('站上MA60但天数不足');
    }
    if (ma60 < ma60Prev) {
      reasons.push('MA60仍下弯');
    }
    structureReason = reasons.length > 0 ? reasons.join('，') + '。' : '继续观察结构变化。';
  }

  let safeZoneStatus: string;
  let safeZoneReason: string;

  if (distanceToMa60 >= profile.safeZoneMin && distanceToMa60 <= profile.safeZoneMax) {
    safeZoneStatus = 'SAFE_ZONE';
    safeZoneReason = `按${profile.label}：价格在MA60附近，处于相对安全区。`;
  } else if (distanceToMa60 > profile.highRiskChaseMin) {
    safeZoneStatus = 'HIGH_RISK_CHASE';
    safeZoneReason = `按${profile.label}：价格明显高于MA60，处于追高区。`;
  } else if (distanceToMa60 < profile.brokenZoneMax) {
    safeZoneStatus = 'BROKEN_ZONE';
    safeZoneReason = `按${profile.label}：价格明显跌破MA60，处于破位区。`;
  } else {
    safeZoneStatus = 'NEUTRAL_ZONE';
    if (distanceToMa60 > profile.safeZoneMax && distanceToMa60 <= profile.highRiskChaseMin) {
      safeZoneReason = '价格略高于MA60，但未进入明显追高区。';
    } else if (distanceToMa60 >= profile.brokenZoneMax && distanceToMa60 < profile.safeZoneMin) {
      safeZoneReason = '价格略低于MA60，但未进入明显破位区。';
    } else {
      safeZoneReason = '当前位置中性。';
    }
  }

  const invalidationLine = ma60 * (1 - planProfile.invalidationBufferPercent);
  const digits = planProfile.key.startsWith('etf_') ? 4 : 3;

  return {
    trade_date: tradeDate,
    close: Math.round(close * 1000) / 1000,
    ma20: Math.round(ma20 * 1000) / 1000,
    ma60: Math.round(ma60 * 1000) / 1000,
    ma120: Math.round(ma120 * 1000) / 1000,
    ma60_prev: Math.round(ma60Prev * 1000) / 1000,
    ma60_slope: ma60Slope,
    distance_to_ma60: Math.round(distanceToMa60 * 10000) / 10000,
    above_ma60_days: aboveMa60Days,
    below_ma60_days: belowMa60Days,
    low_20: low20 !== null ? Math.round(low20 * 1000) / 1000 : null,
    low_60: low60 !== null ? Math.round(low60 * 1000) / 1000 : null,
    high_60: high60 !== null ? Math.round(high60 * 1000) / 1000 : null,
    drawdown_20: drawdown20 !== null ? Math.round(drawdown20 * 10000) / 10000 : null,
    drawdown_60: drawdown60 !== null ? Math.round(drawdown60 * 10000) / 10000 : null,
    structure_status: structureStatus,
    structure_reason: structureReason,
    safe_zone_status: safeZoneStatus,
    safe_zone_reason: safeZoneReason,
    invalidation_line: Math.round(invalidationLine * 10 ** digits) / 10 ** digits
  };
}
