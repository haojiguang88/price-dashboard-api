import { getFinancePlanProfileConfig, getFinanceStructureProfileConfig } from './financePlanProfile';
import { getLatestCoveredTradeDate } from '../utils/financeTradeDate';

export type StockRuleGateStatus = 'passed' | 'failed' | 'not_applicable';

export interface StockRuleDailyPrice {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

export interface StockStructureSnapshot {
  structure_status: string;
  safe_zone_status: string;
  distance_to_ma60: number;
  above_ma60_days: number;
}

export interface CandidatePriorityResult {
  priority: 'high' | 'medium' | 'low';
  priority_score: number;
  forbidden_reason: string | null;
  downgrade_reason: string | null;
  risk_note: string | null;
}

export interface RecentRiskProfile {
  forbidden_reasons: string[];
  downgrade_reasons: string[];
  risk_note: string | null;
  max_drawdown_20: number | null;
  pullback_from_20_high: number | null;
  range_20: number | null;
  latest_change: number | null;
}

export interface StockTradeQualification {
  data_freshness: {
    status: StockRuleGateStatus;
    blocking: boolean;
    reason: string;
    forbidden_reason: string | null;
    note: string;
    latest_trade_date: string | null;
    market_trade_date: string | null;
  };
  liquidity: {
    passed: boolean;
    reason: string;
    forbidden_reason: string | null;
    note: string;
    avg20_amount_yuan: number | null;
    min5_amount_yuan: number | null;
  };
  market_cap: {
    status: StockRuleGateStatus;
    blocking: boolean;
    reason: string;
    forbidden_reason: string | null;
    note: string;
    circ_mv_yuan: number | null;
    total_mv_yuan: number | null;
  };
  extreme_trade: {
    passed: boolean;
    reason: string;
    forbidden_reason: string | null;
    note: string;
  };
  forbidden_reason: string | null;
  note: string | null;
}

export interface StockIndustryStrengthItem {
  known: boolean;
  code: string | null;
  name: string | null;
  trade_date: string | null;
  ret_5d: number | null;
  ret_20d: number | null;
  ret_60d: number | null;
  amount_ratio_5_20: number | null;
  ret20_rank_score: number | null;
  strength_score: number;
  strength_status: string;
  strength_label: string;
  reason: string;
  forbidden_reason: string | null;
  downgrade_reason: string | null;
}

export interface StockIndustryStrengthContext {
  asOfTradeDate: string | null;
  memberMap: Map<string, { code: string; name: string | null }>;
  industryMap: Map<string, any>;
}

export type OpportunityTypeCode =
  | 'DEFENSIVE'
  | 'REPAIR'
  | 'TREND'
  | 'SLOW_GRIND_ATTACK'
  | 'CONTROLLED_ATTACK'
  | 'EMOTIONAL'
  | 'EARLY_LEADER_WATCH'
  | 'NOT_APPLICABLE';

export interface OpportunityTypeTag {
  code: OpportunityTypeCode;
  label: string;
  tone: 'neutral' | 'warn' | 'good';
  reason: string;
}

const STOCK_AVG20_AMOUNT_MIN_YUAN = 100_000_000;
const STOCK_MIN5_AMOUNT_MIN_YUAN = 30_000_000;
const STOCK_CIRC_MARKET_CAP_MIN_YUAN = 5_000_000_000;

function joinReasonParts(...parts: Array<string | null | undefined>): string | null {
  const values = parts.filter((part): part is string => Boolean(part));
  return values.length > 0 ? values.join('；') : null;
}

function roundValue(value: number | null | undefined, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function toNullableNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function normalizeAmountToYuan(amount: unknown, source?: string): number {
  const value = Number(amount || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (source === 'tushare') return value * 1000;
  if (source === 'akshare' || source === 'mock') return value;
  return value < 100_000_000 ? value * 1000 : value;
}

function formatCnyAmount(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '--';
  const amount = Number(value);
  if (amount >= 100_000_000) return `${(amount / 100_000_000).toFixed(2)}亿`;
  if (amount >= 10_000) return `${(amount / 10_000).toFixed(0)}万`;
  return `${amount.toFixed(0)}元`;
}

function getLimitLikeThreshold(symbol: string): number {
  if (/^(8|4|920)/.test(symbol)) return 0.295;
  if (/^(688|300|301)/.test(symbol)) return 0.195;
  return 0.095;
}

function calculateWindowMaxDrawdown(prices: StockRuleDailyPrice[]): number | null {
  if (prices.length < 2) return null;
  let peak = prices[0].high;
  let maxDrawdown = 0;

  for (const price of prices) {
    peak = Math.max(peak, price.high);
    if (peak > 0) {
      maxDrawdown = Math.min(maxDrawdown, price.low / peak - 1);
    }
  }

  return Math.round(maxDrawdown * 10000) / 10000;
}

function calculateStockDataFreshnessGate(
  prices: StockRuleDailyPrice[],
  latestMarketDate?: string | null
): StockTradeQualification['data_freshness'] {
  const latest = prices[prices.length - 1];
  const latestTradeDate = latest?.trade_date || null;
  const marketTradeDate = latestMarketDate || null;
  const stale = Boolean(marketTradeDate && latestTradeDate && latestTradeDate < marketTradeDate);
  const note = marketTradeDate
    ? `本地最新 ${latestTradeDate || '--'}，市场最新交易日 ${marketTradeDate}。`
    : `本地最新 ${latestTradeDate || '--'}，市场最新交易日未确认。`;
  const reason = stale
    ? `本地日线没有同步到市场最新交易日。${note}节假日没有交易数据，不需要补；只需要补齐缺失的实际交易日。`
    : `${note}日线同步满足当前扫描要求。`;

  return {
    status: stale ? 'failed' : 'passed',
    blocking: stale,
    reason,
    forbidden_reason: stale ? reason : null,
    note,
    latest_trade_date: latestTradeDate,
    market_trade_date: marketTradeDate
  };
}

function calculateStockLiquidityGate(prices: StockRuleDailyPrice[], source: string): StockTradeQualification['liquidity'] {
  const last20 = prices.slice(-20);
  const last5 = prices.slice(-5);
  const last20Amounts = last20.map(price => normalizeAmountToYuan(price.amount, source));
  const last5Amounts = last5.map(price => normalizeAmountToYuan(price.amount, source));
  const avg20Amount = last20Amounts.length > 0
    ? last20Amounts.reduce((sum, value) => sum + value, 0) / last20Amounts.length
    : 0;
  const min5Amount = last5Amounts.length > 0 ? Math.min(...last5Amounts) : 0;

  const failures: string[] = [];
  if (avg20Amount < STOCK_AVG20_AMOUNT_MIN_YUAN) {
    failures.push(`近20日平均成交额 ${formatCnyAmount(avg20Amount)}，低于 ${formatCnyAmount(STOCK_AVG20_AMOUNT_MIN_YUAN)} 硬门槛`);
  }
  if (min5Amount < STOCK_MIN5_AMOUNT_MIN_YUAN) {
    failures.push(`近5日最低成交额 ${formatCnyAmount(min5Amount)}，低于 ${formatCnyAmount(STOCK_MIN5_AMOUNT_MIN_YUAN)} 硬门槛`);
  }

  const note = `近20日平均成交额 ${formatCnyAmount(avg20Amount)}；近5日最低成交额 ${formatCnyAmount(min5Amount)}。`;
  return {
    passed: failures.length === 0,
    reason: failures.length > 0 ? failures.join('；') : `${note}流动性满足个股交易资格。`,
    forbidden_reason: failures.length > 0 ? failures.join('；') : null,
    note,
    avg20_amount_yuan: Math.round(avg20Amount),
    min5_amount_yuan: Math.round(min5Amount)
  };
}

async function getStockMarketCapSnapshot(db: any, symbol: string, source: string) {
  return db.get(
    `SELECT trade_date, total_mv_yuan, circ_mv_yuan, turnover_rate, pe, pb
     FROM financial_stock_basic_metrics
     WHERE symbol = ? AND source = ?
     ORDER BY trade_date DESC
     LIMIT 1`,
    [symbol, source]
  );
}

function calculateStockMarketCapGate(snapshot: any): StockTradeQualification['market_cap'] {
  if (!snapshot) {
    const reason = '本地暂未落流通市值快照，无法确认50亿市值门槛，按个股交易资格未通过处理。';
    return {
      status: 'failed',
      blocking: true,
      reason,
      forbidden_reason: reason,
      note: reason,
      circ_mv_yuan: null,
      total_mv_yuan: null
    };
  }

  const circMv = Number(snapshot.circ_mv_yuan || 0) || null;
  const totalMv = Number(snapshot.total_mv_yuan || 0) || null;
  const comparableMv = circMv || totalMv || 0;
  const passed = comparableMv >= STOCK_CIRC_MARKET_CAP_MIN_YUAN;
  const metricName = circMv ? '流通市值' : '总市值';
  const note = `${metricName} ${formatCnyAmount(comparableMv)}，市值快照日期 ${snapshot.trade_date}。`;
  const forbiddenReason = passed ? null : `${metricName} ${formatCnyAmount(comparableMv)}，低于 ${formatCnyAmount(STOCK_CIRC_MARKET_CAP_MIN_YUAN)} 硬门槛。`;

  return {
    status: passed ? 'passed' : 'failed',
    blocking: !passed,
    reason: forbiddenReason || `${note}满足个股交易资格。`,
    forbidden_reason: forbiddenReason,
    note,
    circ_mv_yuan: circMv,
    total_mv_yuan: totalMv
  };
}

function calculateStockExtremeTradeGate(
  prices: StockRuleDailyPrice[],
  symbol: string
): StockTradeQualification['extreme_trade'] {
  const last10 = prices.slice(-11);
  const threshold = getLimitLikeThreshold(symbol);
  const failures: string[] = [];
  let recentLimitLikeCount = 0;
  let oneLineBoardCount = 0;
  let maxConsecutiveLimitLike = 0;
  let currentConsecutiveLimitLike = 0;

  for (let index = 1; index < last10.length; index += 1) {
    const previous = last10[index - 1];
    const current = last10[index];
    const change = previous.close > 0 ? current.close / previous.close - 1 : 0;
    const limitLike = Math.abs(change) >= threshold;
    const oneLineBoard = limitLike && current.close > 0 && Math.abs(current.high - current.low) / current.close <= 0.002;

    if (limitLike) {
      recentLimitLikeCount += 1;
      currentConsecutiveLimitLike += 1;
      maxConsecutiveLimitLike = Math.max(maxConsecutiveLimitLike, currentConsecutiveLimitLike);
    } else {
      currentConsecutiveLimitLike = 0;
    }
    if (oneLineBoard) {
      oneLineBoardCount += 1;
    }
  }

  if (maxConsecutiveLimitLike >= 2) {
    failures.push(`近10日出现连续${maxConsecutiveLimitLike}天涨跌停级别波动`);
  }
  if (recentLimitLikeCount >= 3) {
    failures.push(`近10日涨跌停级别波动 ${recentLimitLikeCount} 次，情绪波动过强`);
  }
  if (oneLineBoardCount > 0) {
    failures.push(`近10日出现 ${oneLineBoardCount} 次疑似一字板`);
  }

  const note = `近10日涨跌停级别波动 ${recentLimitLikeCount} 次，最大连续 ${maxConsecutiveLimitLike} 天，疑似一字板 ${oneLineBoardCount} 次。`;
  return {
    passed: failures.length === 0,
    reason: failures.length > 0 ? failures.join('；') : `${note}未见极端交易状态。`,
    forbidden_reason: failures.length > 0 ? failures.join('；') : null,
    note
  };
}

export async function calculateStockTradeQualification(
  db: any,
  symbol: string,
  source: string,
  prices: StockRuleDailyPrice[]
): Promise<StockTradeQualification> {
  const latestMarketTradeDate = await getLatestCoveredTradeDate(db, { source, assetTypes: ['index'] });
  const marketCapSnapshot = await getStockMarketCapSnapshot(db, symbol, source);
  const dataFreshness = calculateStockDataFreshnessGate(prices, latestMarketTradeDate || null);
  const liquidity = calculateStockLiquidityGate(prices, source);
  const marketCap = calculateStockMarketCapGate(marketCapSnapshot);
  const extremeTrade = calculateStockExtremeTradeGate(prices, symbol);
  const forbiddenReasons = [
    dataFreshness.forbidden_reason,
    liquidity.forbidden_reason,
    marketCap.forbidden_reason,
    extremeTrade.forbidden_reason
  ].filter((reason): reason is string => Boolean(reason));
  const notes = [dataFreshness.note, liquidity.note, marketCap.note, extremeTrade.note].filter(Boolean);

  return {
    data_freshness: dataFreshness,
    liquidity,
    market_cap: marketCap,
    extreme_trade: extremeTrade,
    forbidden_reason: forbiddenReasons.length > 0 ? forbiddenReasons.join('；') : null,
    note: notes.length > 0 ? notes.join('；') : null
  };
}

export function calculateRecentRiskProfile(
  prices: StockRuleDailyPrice[],
  structure: StockStructureSnapshot,
  _assetType: string,
  planProfileKey?: string | null
): RecentRiskProfile {
  const profile = getFinanceStructureProfileConfig(planProfileKey);
  const last20 = prices.slice(-20);
  const latest = prices[prices.length - 1];
  const previous = prices[prices.length - 2];
  const high20 = Math.max(...last20.map((price) => price.high));
  const low20 = Math.min(...last20.map((price) => price.low));
  const maxDrawdown20 = calculateWindowMaxDrawdown(last20);
  const pullbackFrom20High = high20 > 0 ? Math.round((latest.close / high20 - 1) * 10000) / 10000 : null;
  const range20 = low20 > 0 ? Math.round((high20 / low20 - 1) * 10000) / 10000 : null;
  const latestChange = previous?.close > 0 ? Math.round((latest.close / previous.close - 1) * 10000) / 10000 : null;
  const thresholds = {
    hardPullback: -profile.drawdownWatchMax,
    warnPullback: -profile.drawdownGoodMax,
    hardDrawdown: -profile.drawdownWeakMax,
    warnDrawdown: -profile.drawdownWatchMax,
    warnRange: profile.amplitudeWatchMax,
    warnLatestSurge: profile.emotionalAmplitudeMin / 3,
    fakeBreakPullback: -Math.max(profile.drawdownGoodMax * 0.8, 0.02)
  };

  const forbiddenReasons: string[] = [];
  const downgradeReasons: string[] = [];

  if (pullbackFrom20High !== null && pullbackFrom20High <= thresholds.hardPullback) {
    forbiddenReasons.push(`距离20日高点回落${Math.abs(pullbackFrom20High * 100).toFixed(1)}%，疑似冲高回落`);
  } else if (pullbackFrom20High !== null && pullbackFrom20High <= thresholds.warnPullback) {
    downgradeReasons.push(`距离20日高点回落${Math.abs(pullbackFrom20High * 100).toFixed(1)}%，强结构降级观察`);
  }

  if (maxDrawdown20 !== null && maxDrawdown20 <= thresholds.hardDrawdown) {
    forbiddenReasons.push(`20日最大回撤${Math.abs(maxDrawdown20 * 100).toFixed(1)}%，波动风险过高`);
  } else if (maxDrawdown20 !== null && maxDrawdown20 <= thresholds.warnDrawdown) {
    downgradeReasons.push(`20日最大回撤${Math.abs(maxDrawdown20 * 100).toFixed(1)}%，安全垫不足`);
  }

  if (
    structure.above_ma60_days <= 5 &&
    pullbackFrom20High !== null &&
    pullbackFrom20High <= thresholds.fakeBreakPullback
  ) {
    forbiddenReasons.push('刚站上MA60但已从20日高点明显回落，按假突破风险处理');
  }

  if (range20 !== null && range20 >= thresholds.warnRange) {
    downgradeReasons.push(`20日振幅${(range20 * 100).toFixed(1)}%，波动偏大`);
  }

  if (latestChange !== null && latestChange >= thresholds.warnLatestSurge) {
    downgradeReasons.push(`最近单日上涨${(latestChange * 100).toFixed(1)}%，避免急涨后追入`);
  }

  const noteParts = [
    maxDrawdown20 !== null ? `20日最大回撤 ${(maxDrawdown20 * 100).toFixed(1)}%` : null,
    pullbackFrom20High !== null ? `距20日高点 ${(pullbackFrom20High * 100).toFixed(1)}%` : null,
    range20 !== null ? `20日振幅 ${(range20 * 100).toFixed(1)}%` : null,
    latestChange !== null ? `最近日涨跌 ${(latestChange * 100).toFixed(1)}%` : null
  ].filter(Boolean);

  return {
    forbidden_reasons: forbiddenReasons,
    downgrade_reasons: downgradeReasons,
    risk_note: noteParts.length > 0 ? noteParts.join('；') : null,
    max_drawdown_20: maxDrawdown20,
    pullback_from_20_high: pullbackFrom20High,
    range_20: range20,
    latest_change: latestChange
  };
}

export function calculateCandidatePriority(
  structure: StockStructureSnapshot,
  marketEntryPermission?: string,
  trendPhaseCode?: string,
  riskProfile?: RecentRiskProfile,
  planProfileKey?: string | null,
  marketDowngradeReasons: string[] = []
): CandidatePriorityResult {
  const profile = getFinanceStructureProfileConfig(planProfileKey);
  const forbiddenReasons: string[] = [];
  const downgradeReasons: string[] = [];
  let score = 0;

  if (marketEntryPermission !== 'ALLOW_STRUCTURE_CHECK') {
    forbiddenReasons.push('市场环境未开放单标的判断');
  } else {
    score += 20;
    if (marketDowngradeReasons.length > 0) {
      score -= Math.min(15, marketDowngradeReasons.length * 5);
      downgradeReasons.push(`组合总闸观察/降权：${marketDowngradeReasons.join('；')}`);
    }
  }

  if (structure.structure_status === 'STRUCTURE_CONFIRMED') {
    score += 25;
  } else if (structure.structure_status === 'STRUCTURE_WATCH') {
    score += 10;
    downgradeReasons.push('结构仍在观察，未完全成立');
  } else {
    forbiddenReasons.push('结构破坏或数据不足');
  }

  if (structure.safe_zone_status === 'SAFE_ZONE') {
    score += 20;
  } else if (structure.safe_zone_status === 'NEUTRAL_ZONE') {
    score += 8;
    downgradeReasons.push('位置中性，安全垫不足');
  } else if (structure.safe_zone_status === 'HIGH_RISK_CHASE') {
    forbiddenReasons.push('处于追高区，不进入备选池');
  } else if (structure.safe_zone_status === 'BROKEN_ZONE') {
    forbiddenReasons.push('处于破位区，不进入备选池');
  }

  if (structure.distance_to_ma60 >= -0.01 && structure.distance_to_ma60 <= profile.distanceTightMax) {
    score += 15;
  } else if (structure.distance_to_ma60 >= profile.safeZoneMin && structure.distance_to_ma60 <= profile.safeZoneMax) {
    score += 10;
  } else if (structure.distance_to_ma60 > profile.safeZoneMax) {
    score -= 8;
    downgradeReasons.push(`距离 MA60 超出${profile.label}安全区，追高风险上升`);
  }

  if (structure.above_ma60_days >= Math.max(10, profile.minAboveMa60Days * 3)) {
    score += 10;
  } else if (structure.above_ma60_days >= profile.minAboveMa60Days) {
    score += 6;
  } else {
    downgradeReasons.push('站上 MA60 时间偏短');
  }

  switch (trendPhaseCode) {
    case 'SLOW_GRIND_UP':
    case 'BREAKOUT':
      score += 10;
      break;
    case 'RECOVERY':
      score += 7;
      downgradeReasons.push('修复阶段，等待结构进一步确认');
      break;
    case 'TREND_UP':
      score += 7;
      downgradeReasons.push('趋势上行但波动偏大，等待回踩稳定');
      break;
    case 'TREND_TRANSITION':
    case 'CONSOLIDATION':
    case 'SIDEWAYS':
      score += 3;
      downgradeReasons.push('走势阶段偏观察');
      break;
    case 'HIGH_BASE':
      score -= 10;
      downgradeReasons.push('高位横盘，降低优先级');
      break;
    case 'SURGE':
      forbiddenReasons.push('急涨阶段不追，等待回踩');
      break;
    case 'REBOUND':
      forbiddenReasons.push('反抽阶段只观察，不进入备选池');
      break;
    case 'SLOW_BLEED':
      forbiddenReasons.push('阴跌阶段禁止入池');
      break;
    case 'CRASH_DROP':
      forbiddenReasons.push('暴跌阶段禁止入池');
      break;
    default:
      downgradeReasons.push('走势阶段未确认');
      break;
  }

  if (riskProfile) {
    forbiddenReasons.push(...riskProfile.forbidden_reasons);
    downgradeReasons.push(...riskProfile.downgrade_reasons);
    if (riskProfile.forbidden_reasons.length > 0) {
      score = Math.min(score, 45);
    } else if (riskProfile.downgrade_reasons.length > 0) {
      score -= Math.min(20, riskProfile.downgrade_reasons.length * 6);
    }
  }

  const priorityScore = Math.max(0, Math.min(100, Math.round(score)));
  const priority = priorityScore >= 80 ? 'high' : priorityScore >= 60 ? 'medium' : 'low';

  return {
    priority,
    priority_score: priorityScore,
    forbidden_reason: forbiddenReasons.length > 0 ? forbiddenReasons.join('；') : null,
    downgrade_reason: downgradeReasons.length > 0 ? Array.from(new Set(downgradeReasons)).join('；') : null,
    risk_note: riskProfile?.risk_note || null
  };
}

export function classifyOpportunityType(input: any): OpportunityTypeTag {
  const trendPhaseCode = String(input?.trend_phase_code || input?.trend_phase?.trend_phase_code || 'UNKNOWN');
  const assetType = String(input?.asset_type || 'stock');
  const structureStatus = String(input?.structure_status || input?.structure?.structure_status || '');
  const safeZoneStatus = String(input?.safe_zone_status || input?.structure?.safe_zone_status || '');
  const distanceToMa60 = toNullableNumber(input?.distance_to_ma60 ?? input?.structure?.distance_to_ma60);
  const aboveMa60Days = toNullableNumber(input?.above_ma60_days ?? input?.structure?.above_ma60_days) ?? 0;
  const amplitudeOrRange = toNullableNumber(input?.amplitude_20 ?? input?.range_20);
  const ma20Slope = String(input?.ma20_slope || input?.structure_score?.metrics?.ma20_slope || '');
  const ma60Slope = String(input?.ma60_slope || input?.structure_score?.metrics?.ma60_slope || input?.structure?.ma60_slope || '');
  const structureConfirmed = structureStatus === 'STRUCTURE_CONFIRMED';
  const safeZone = safeZoneStatus === 'SAFE_ZONE';
  const profile = getFinanceStructureProfileConfig(input?.plan_profile || input?.profile_key);
  const distanceComfortable = distanceToMa60 !== null && distanceToMa60 >= profile.safeZoneMin && distanceToMa60 <= profile.distanceComfortMax;
  const distanceClose = distanceToMa60 !== null && distanceToMa60 >= profile.safeZoneMin && distanceToMa60 <= profile.distanceTightMax;
  const lowVolatility = amplitudeOrRange !== null && amplitudeOrRange <= profile.lowVolatilityMax;

  if (!['stock', 'etf'].includes(assetType)) {
    return {
      code: 'NOT_APPLICABLE',
      label: '不适用型',
      tone: 'neutral',
      reason: '资产类型不匹配当前权益池，先进入资产路由，不作为硬闸门外的交易许可。'
    };
  }

  if (
    trendPhaseCode === 'SURGE' ||
    (amplitudeOrRange !== null && amplitudeOrRange >= profile.emotionalAmplitudeMin && !distanceClose)
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
    trendPhaseCode === 'SLOW_GRIND_UP'
  ) {
    return {
      code: 'SLOW_GRIND_ATTACK',
      label: '慢涨进攻型',
      tone: 'good',
      reason: '体系内进攻：安全区、结构成立且进入慢涨，优先看真实计划候选，但仍需总闸、失效线、仓位和人工确认。'
    };
  }

  if (
    safeZone &&
    structureConfirmed &&
    distanceComfortable &&
    trendPhaseCode === 'BREAKOUT'
  ) {
    return {
      code: 'CONTROLLED_ATTACK',
      label: '突破试探型',
      tone: 'warn',
      reason: '结构突破但不能追涨，适合小仓或观察仓试探，等待入场触发和回踩确认后再进入计划。'
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
    !structureConfirmed &&
    distanceComfortable &&
    aboveMa60Days >= 1 &&
    ['BREAKOUT', 'SLOW_GRIND_UP', 'TREND_UP', 'RECOVERY'].includes(trendPhaseCode)
  ) {
    return {
      code: 'EARLY_LEADER_WATCH',
      label: '早期主线观察',
      tone: 'warn',
      reason: '走势已有早期主线信号，但MA60结构或安全区尚未完全确认，只进入观察层，不生成买入计划。'
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

export async function buildStockIndustryStrengthContext(
  db: any,
  options: { asOfTradeDate?: string | null } = {}
): Promise<StockIndustryStrengthContext> {
  const asOfTradeDate = options.asOfTradeDate
    || await getLatestCoveredTradeDate(db, { source: 'tushare', assetTypes: ['stock', 'index'] });
  const memberRows = await db.all(
    `SELECT symbol, l1_code, l1_name, l2_code, l2_name
     FROM financial_sw_industry_members
     WHERE symbol IS NOT NULL
       AND symbol <> ''
       AND (
         COALESCE(is_new, 'Y') = 'Y'
         OR out_date IS NULL
         OR out_date = ''
         OR out_date >= COALESCE(?, out_date)
       )
     ORDER BY CASE COALESCE(is_new, 'Y') WHEN 'Y' THEN 0 ELSE 1 END, id DESC`,
    [asOfTradeDate]
  );
  const memberMap = new Map<string, { code: string; name: string | null }>();
  for (const row of memberRows) {
    const code = row.l2_code || row.l1_code;
    if (!row.symbol || !code || memberMap.has(row.symbol)) continue;
    memberMap.set(String(row.symbol), {
      code: String(code),
      name: row.l2_name || row.l1_name || null
    });
  }

  const industryRows = await db.all(
    `WITH metrics AS (
       SELECT index_code, name, trade_date, close, amount,
              close / NULLIF(LAG(close, 5) OVER industry_window, 0) - 1 AS ret_5d,
              close / NULLIF(LAG(close, 20) OVER industry_window, 0) - 1 AS ret_20d,
              close / NULLIF(LAG(close, 60) OVER industry_window, 0) - 1 AS ret_60d,
              AVG(amount) OVER amount5_window / NULLIF(AVG(amount) OVER amount20_window, 0) - 1 AS amount_ratio_5_20
       FROM financial_sw_industry_daily
       WHERE trade_date <= COALESCE(?, trade_date)
         AND close IS NOT NULL
         AND close > 0
       WINDOW
         industry_window AS (PARTITION BY index_code ORDER BY trade_date),
         amount5_window AS (PARTITION BY index_code ORDER BY trade_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW),
         amount20_window AS (PARTITION BY index_code ORDER BY trade_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)
     ),
     latest AS (
       SELECT *
       FROM metrics
       WHERE trade_date = (SELECT MAX(trade_date) FROM metrics)
         AND ret_20d IS NOT NULL
     ),
     ranked AS (
       SELECT latest.*,
              RANK() OVER (ORDER BY ret_20d DESC) AS ret20_rank,
              COUNT(*) OVER () AS industry_count
       FROM latest
     )
     SELECT *,
            CASE
              WHEN industry_count > 1 THEN 1.0 - ((ret20_rank - 1.0) / NULLIF(industry_count - 1.0, 0))
              ELSE 0.5
            END AS ret20_rank_score
     FROM ranked`,
    [asOfTradeDate]
  );
  const industryMap = new Map<string, any>();
  for (const row of industryRows) {
    if (row.index_code) industryMap.set(String(row.index_code), row);
  }

  return { asOfTradeDate, memberMap, industryMap };
}

export function evaluateStockIndustryStrength(symbol: string, context?: StockIndustryStrengthContext): StockIndustryStrengthItem {
  const member = context?.memberMap.get(symbol);
  if (!member) {
    return {
      known: false,
      code: null,
      name: null,
      trade_date: context?.asOfTradeDate || null,
      ret_5d: null,
      ret_20d: null,
      ret_60d: null,
      amount_ratio_5_20: null,
      ret20_rank_score: null,
      strength_score: 50,
      strength_status: 'UNKNOWN',
      strength_label: '行业未知',
      reason: '未匹配到申万行业，行业强弱不参与硬拦截。',
      forbidden_reason: null,
      downgrade_reason: '行业归属未知，优先级按中性偏谨慎处理'
    };
  }
  const row = context?.industryMap.get(member.code);
  if (!row) {
    return {
      known: false,
      code: member.code,
      name: member.name,
      trade_date: context?.asOfTradeDate || null,
      ret_5d: null,
      ret_20d: null,
      ret_60d: null,
      amount_ratio_5_20: null,
      ret20_rank_score: null,
      strength_score: 50,
      strength_status: 'NO_DATA',
      strength_label: '行业数据不足',
      reason: `${member.name || member.code} 行业日线不足，行业强弱不参与硬拦截。`,
      forbidden_reason: null,
      downgrade_reason: '行业强弱数据不足，优先级按中性偏谨慎处理'
    };
  }

  const ret20 = Number(row.ret_20d);
  const ret60 = Number(row.ret_60d);
  const amountRatio = Number(row.amount_ratio_5_20);
  const rankScore = Number(row.ret20_rank_score);
  let score = 45;
  const reasons: string[] = [];
  if (Number.isFinite(rankScore)) {
    score += rankScore >= 0.8 ? 30 : rankScore >= 0.6 ? 22 : rankScore >= 0.4 ? 12 : rankScore >= 0.2 ? 2 : -8;
    reasons.push(`20日行业排名 ${(rankScore * 100).toFixed(0)}分位`);
  }
  if (Number.isFinite(ret20)) {
    if (ret20 >= 0.06) score += 12;
    else if (ret20 >= 0.02) score += 7;
    else if (ret20 <= -0.06) score -= 12;
    else if (ret20 <= -0.03) score -= 7;
    reasons.push(`20日涨跌 ${(ret20 * 100).toFixed(1)}%`);
  }
  if (Number.isFinite(ret60)) {
    if (ret60 >= 0.08) score += 8;
    else if (ret60 <= -0.08) score -= 8;
  }
  if (Number.isFinite(amountRatio)) {
    if (amountRatio >= 0.2) score += 5;
    else if (amountRatio <= -0.25) score -= 5;
    reasons.push(`量能变化 ${(amountRatio * 100).toFixed(1)}%`);
  }
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  const deeplyWeak = (Number.isFinite(rankScore) && rankScore < 0.2 && Number.isFinite(ret20) && ret20 <= -0.05)
    || (Number.isFinite(ret60) && ret60 <= -0.12 && Number.isFinite(ret20) && ret20 <= -0.03);
  const weak = !deeplyWeak && (
    (Number.isFinite(rankScore) && rankScore < 0.35)
    || (Number.isFinite(ret20) && ret20 <= -0.03)
  );
  const strong = boundedScore >= 75 || (Number.isFinite(rankScore) && rankScore >= 0.75 && Number.isFinite(ret20) && ret20 > 0);
  const status = deeplyWeak ? 'WEAK_DEEP_DOWNGRADE' : strong ? 'STRONG' : weak ? 'WEAK_DOWNGRADE' : 'NEUTRAL';
  const label = deeplyWeak ? '行业弱势降权' : strong ? '行业强势' : weak ? '行业偏弱' : '行业中性';
  const reason = `${member.name || member.code}：${reasons.join('；') || '行业强弱中性。'}`;
  const downgradeReason = deeplyWeak
    ? `${reason}，行业处于弱势末端，本轮只大幅降权观察，不作为硬拦截。`
    : weak
      ? `${reason}，行业偏弱，本轮只降权观察。`
      : null;

  return {
    known: true,
    code: member.code,
    name: member.name,
    trade_date: row.trade_date || context?.asOfTradeDate || null,
    ret_5d: roundValue(row.ret_5d),
    ret_20d: roundValue(row.ret_20d),
    ret_60d: roundValue(row.ret_60d),
    amount_ratio_5_20: roundValue(row.amount_ratio_5_20),
    ret20_rank_score: roundValue(row.ret20_rank_score),
    strength_score: boundedScore,
    strength_status: status,
    strength_label: label,
    reason,
    forbidden_reason: null,
    downgrade_reason: downgradeReason
  };
}

export function adjustPriorityWithStockIndustry(
  priorityResult: CandidatePriorityResult,
  industry: StockIndustryStrengthItem | null
): CandidatePriorityResult {
  if (!industry) return priorityResult;
  let score = priorityResult.priority_score;
  if (industry.strength_status === 'STRONG') score += 6;
  if (industry.strength_status === 'WEAK_DOWNGRADE') score -= 10;
  if (industry.strength_status === 'WEAK_DEEP_DOWNGRADE') score = Math.min(score, 55);
  if (industry.strength_status === 'UNKNOWN' || industry.strength_status === 'NO_DATA') score -= 3;
  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...priorityResult,
    priority_score: boundedScore,
    priority: boundedScore >= 80 ? 'high' : boundedScore >= 60 ? 'medium' : 'low',
    forbidden_reason: joinReasonParts(priorityResult.forbidden_reason, industry.forbidden_reason),
    downgrade_reason: joinReasonParts(priorityResult.downgrade_reason, industry.downgrade_reason)
  };
}
