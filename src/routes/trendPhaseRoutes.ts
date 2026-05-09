import express, { Request, Response } from 'express';
import getDb from '../config/database';
import { resolveFinancePlanProfile } from '../services/financePlanProfile';

const router = express.Router();

const TREND_PHASE_VERSION = 'trend_phase_v1.1';
const READY_TREND_PHASE_CODES = new Set(['BREAKOUT', 'SLOW_GRIND_UP', 'RECOVERY']);
const REJECT_TREND_PHASE_CODES = new Set(['CRASH_DROP', 'SLOW_BLEED', 'SURGE', 'REBOUND']);
const READY_TREND_PHASE_SQL = `'BREAKOUT', 'SLOW_GRIND_UP', 'RECOVERY'`;
const REJECT_TREND_PHASE_SQL = `'CRASH_DROP', 'SLOW_BLEED', 'SURGE', 'REBOUND'`;

function getTrendQueueStatus(code?: string | null, reviewStatus?: string | null) {
  const trendCode = code || 'UNKNOWN';
  if (READY_TREND_PHASE_CODES.has(trendCode)) {
    return {
      key: 'ready_to_advance',
      label: reviewStatus === 'trend_blocked' ? '已转好，待流水线推进' : '可推进',
      tone: 'success'
    };
  }
  if (trendCode === 'UNKNOWN') {
    return { key: 'waiting_data', label: '等待走势确认', tone: 'neutral' };
  }
  if (REJECT_TREND_PHASE_CODES.has(trendCode)) {
    return { key: 'should_reject', label: '应踢出本轮', tone: 'danger' };
  }
  return { key: 'trend_blocked', label: '留在走势队列', tone: 'warning' };
}

interface TrendThresholds {
  label: string;
  CRASH_5D: number;
  CRASH_20D: number;
  BLEED_20D: number;
  BLEED_DOWN_DAY_RATIO: number;
  SIDEWAYS_RET20_ABS: number;
  SIDEWAYS_RANGE20: number;
  SIDEWAYS_RANGE20_WIDE: number;
  SIDEWAYS_BIAS60_ABS: number;
  SLOW_UP_20D: number;
  SLOW_UP_MAX_DRAWDOWN20: number;
  SLOW_UP_MAX_RANGE20: number;
  REBOUND_5D: number;
  RECOVERY_BIAS60_ABS: number;
  RECOVERY_MA60_SLOPE_ABS_5D: number;
  BREAKOUT_MARGIN: number;
  BREAKOUT_BASE_RANGE20: number;
  SURGE_5D: number;
  SURGE_1D: number;
  HIGH_BASE_BIAS60: number;
}

const THRESHOLD_PROFILES: Record<string, TrendThresholds> = {
  index: {
    label: '宽基指数',
    CRASH_5D: -0.035,
    CRASH_20D: -0.07,
    BLEED_20D: -0.04,
    BLEED_DOWN_DAY_RATIO: 0.58,
    SIDEWAYS_RET20_ABS: 0.025,
    SIDEWAYS_RANGE20: 0.05,
    SIDEWAYS_RANGE20_WIDE: 0.07,
    SIDEWAYS_BIAS60_ABS: 0.035,
    SLOW_UP_20D: 0.03,
    SLOW_UP_MAX_DRAWDOWN20: 0.035,
    SLOW_UP_MAX_RANGE20: 0.09,
    REBOUND_5D: 0.03,
    RECOVERY_BIAS60_ABS: 0.025,
    RECOVERY_MA60_SLOPE_ABS_5D: 0.004,
    BREAKOUT_MARGIN: 0.003,
    BREAKOUT_BASE_RANGE20: 0.06,
    SURGE_5D: 0.045,
    SURGE_1D: 0.022,
    HIGH_BASE_BIAS60: 0.035
  },
  etf: {
    label: 'ETF',
    CRASH_5D: -0.05,
    CRASH_20D: -0.10,
    BLEED_20D: -0.06,
    BLEED_DOWN_DAY_RATIO: 0.58,
    SIDEWAYS_RET20_ABS: 0.04,
    SIDEWAYS_RANGE20: 0.08,
    SIDEWAYS_RANGE20_WIDE: 0.11,
    SIDEWAYS_BIAS60_ABS: 0.05,
    SLOW_UP_20D: 0.05,
    SLOW_UP_MAX_DRAWDOWN20: 0.055,
    SLOW_UP_MAX_RANGE20: 0.14,
    REBOUND_5D: 0.045,
    RECOVERY_BIAS60_ABS: 0.035,
    RECOVERY_MA60_SLOPE_ABS_5D: 0.007,
    BREAKOUT_MARGIN: 0.006,
    BREAKOUT_BASE_RANGE20: 0.10,
    SURGE_5D: 0.075,
    SURGE_1D: 0.04,
    HIGH_BASE_BIAS60: 0.06
  },
  stock: {
    label: 'A股个股',
    CRASH_5D: -0.08,
    CRASH_20D: -0.16,
    BLEED_20D: -0.10,
    BLEED_DOWN_DAY_RATIO: 0.60,
    SIDEWAYS_RET20_ABS: 0.06,
    SIDEWAYS_RANGE20: 0.14,
    SIDEWAYS_RANGE20_WIDE: 0.18,
    SIDEWAYS_BIAS60_ABS: 0.08,
    SLOW_UP_20D: 0.08,
    SLOW_UP_MAX_DRAWDOWN20: 0.09,
    SLOW_UP_MAX_RANGE20: 0.24,
    REBOUND_5D: 0.07,
    RECOVERY_BIAS60_ABS: 0.05,
    RECOVERY_MA60_SLOPE_ABS_5D: 0.012,
    BREAKOUT_MARGIN: 0.012,
    BREAKOUT_BASE_RANGE20: 0.16,
    SURGE_5D: 0.12,
    SURGE_1D: 0.07,
    HIGH_BASE_BIAS60: 0.10
  }
};

THRESHOLD_PROFILES.etf_broad_equity = {
  ...THRESHOLD_PROFILES.etf,
  label: '宽基ETF',
  CRASH_5D: -0.045,
  CRASH_20D: -0.09,
  BLEED_20D: -0.055,
  SIDEWAYS_RET20_ABS: 0.035,
  SIDEWAYS_RANGE20: 0.07,
  SIDEWAYS_RANGE20_WIDE: 0.1,
  SLOW_UP_20D: 0.045,
  SLOW_UP_MAX_DRAWDOWN20: 0.05,
  SLOW_UP_MAX_RANGE20: 0.12,
  SURGE_5D: 0.065,
  SURGE_1D: 0.035,
  HIGH_BASE_BIAS60: 0.055
};

THRESHOLD_PROFILES.etf_industry_equity = {
  ...THRESHOLD_PROFILES.etf,
  label: '行业/主题ETF',
  CRASH_5D: -0.055,
  CRASH_20D: -0.11,
  BLEED_20D: -0.065,
  SIDEWAYS_RET20_ABS: 0.045,
  SIDEWAYS_RANGE20: 0.09,
  SIDEWAYS_RANGE20_WIDE: 0.13,
  SLOW_UP_20D: 0.055,
  SLOW_UP_MAX_DRAWDOWN20: 0.065,
  SLOW_UP_MAX_RANGE20: 0.16,
  SURGE_5D: 0.085,
  SURGE_1D: 0.045,
  HIGH_BASE_BIAS60: 0.07
};

THRESHOLD_PROFILES.etf_bond_cash = {
  ...THRESHOLD_PROFILES.index,
  label: '债券/货币ETF',
  CRASH_5D: -0.015,
  CRASH_20D: -0.03,
  BLEED_20D: -0.018,
  SIDEWAYS_RET20_ABS: 0.01,
  SIDEWAYS_RANGE20: 0.02,
  SIDEWAYS_RANGE20_WIDE: 0.035,
  SLOW_UP_20D: 0.012,
  SLOW_UP_MAX_DRAWDOWN20: 0.015,
  SLOW_UP_MAX_RANGE20: 0.04,
  REBOUND_5D: 0.012,
  RECOVERY_BIAS60_ABS: 0.01,
  BREAKOUT_MARGIN: 0.001,
  BREAKOUT_BASE_RANGE20: 0.025,
  SURGE_5D: 0.02,
  SURGE_1D: 0.01,
  HIGH_BASE_BIAS60: 0.015
};

THRESHOLD_PROFILES.etf_cross_border = {
  ...THRESHOLD_PROFILES.etf_industry_equity,
  label: '跨境ETF',
  CRASH_5D: -0.06,
  CRASH_20D: -0.12,
  SURGE_5D: 0.09,
  SURGE_1D: 0.05
};

THRESHOLD_PROFILES.etf_commodity = {
  ...THRESHOLD_PROFILES.etf_industry_equity,
  label: '商品ETF',
  CRASH_5D: -0.06,
  CRASH_20D: -0.12,
  SURGE_5D: 0.09,
  SURGE_1D: 0.05
};

THRESHOLD_PROFILES.etf_special = {
  ...THRESHOLD_PROFILES.etf,
  label: '特殊基金/LOF'
};

THRESHOLD_PROFILES.etf_unknown = {
  ...THRESHOLD_PROFILES.etf,
  label: '未归类ETF'
};

function getThresholds(assetType: string, profileKey?: string | null): TrendThresholds {
  if (profileKey && THRESHOLD_PROFILES[profileKey]) return THRESHOLD_PROFILES[profileKey];
  return THRESHOLD_PROFILES[assetType] || THRESHOLD_PROFILES.etf;
}

interface DailyPrice {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface TrendPhaseResult {
  symbol: string;
  asset_type: string;
  source: string;
  trade_date: string;
  close: number;
  ma20: number;
  ma60: number;
  bias60: number;
  ret5: number | null;
  ret20: number | null;
  range20: number;
  cross60_10: number;
  trend_phase_code: string;
  trend_phase_reason: string;
  reason_code: string;
  reason_details: string;
  rule_version: string;
}

function logRead(message: string, symbol?: string) {
  const timestamp = new Date().toISOString();
  const prefix = symbol ? `[${symbol}]` : '';
  console.log(`${timestamp} [READ_ONLY] ${prefix} ${message}`);
}

function logUpdate(message: string, symbol?: string) {
  const timestamp = new Date().toISOString();
  const prefix = symbol ? `[${symbol}]` : '';
  console.log(`${timestamp} [UPDATE] ${prefix} ${message}`);
}

function calculateMA(prices: DailyPrice[], days: number, index: number): number | null {
  if (index < days - 1) return null;
  const slice = prices.slice(index - days + 1, index + 1);
  return slice.reduce((sum, p) => sum + p.close, 0) / days;
}

function calculateRet(prices: DailyPrice[], days: number, index: number): number | null {
  if (index < days) return null;
  return (prices[index].close / prices[index - days].close) - 1;
}

function calculateRange20(prices: DailyPrice[], index: number): number {
  if (index < 19) return 0;
  const slice = prices.slice(index - 19, index + 1);
  const high = Math.max(...slice.map(p => p.high !== null ? p.high : p.close));
  const low = Math.min(...slice.map(p => p.low !== null ? p.low : p.close));
  return (high - low) / low;
}

function calculateMaxDrawdown(prices: DailyPrice[], index: number, days: number): number {
  if (index < 1) return 0;
  const startIndex = Math.max(0, index - days + 1);
  let peak = prices[startIndex].close;
  let maxDrawdown = 0;

  for (let i = startIndex; i <= index; i++) {
    peak = Math.max(peak, prices[i].close);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - prices[i].close) / peak);
    }
  }

  return maxDrawdown;
}

function calculateMaSlope(prices: DailyPrice[], days: number, index: number, lookback: number): number | null {
  const ma = calculateMA(prices, days, index);
  const prev = calculateMA(prices, days, Math.max(0, index - lookback));
  if (ma === null || prev === null || prev === 0) return null;
  return (ma - prev) / prev;
}

function calculateCross60(prices: DailyPrice[], index: number): number {
  if (index < 10) return 0;
  
  let crossCount = 0;
  const startIndex = Math.max(0, index - 9);
  
  for (let i = startIndex + 1; i <= index; i++) {
    const ma60Prev = calculateMA(prices, 60, i - 1);
    const ma60Curr = calculateMA(prices, 60, i);
    
    if (ma60Prev === null || ma60Curr === null) continue;
    
    const prevDiff = prices[i - 1].close - ma60Prev;
    const currDiff = prices[i].close - ma60Curr;
    
    if (prevDiff * currDiff < 0) {
      crossCount++;
    }
  }
  
  return crossCount;
}

function wasCrashDrop(prices: DailyPrice[], index: number, th: TrendThresholds): boolean {
  const startIdx = Math.max(0, index - 19);
  
  for (let i = startIdx; i <= index; i++) {
    const ret5 = calculateRet(prices, 5, i);
    const ret20 = calculateRet(prices, 20, i);
    
    if ((ret5 !== null && ret5 <= th.CRASH_5D) || 
        (ret20 !== null && ret20 <= th.CRASH_20D)) {
      return true;
    }
  }
  
  return false;
}

function wasBaseLike(prices: DailyPrice[], index: number, th: TrendThresholds): boolean {
  const startIdx = Math.max(0, index - 19);
  
  for (let i = startIdx; i <= index; i++) {
    const ret20 = calculateRet(prices, 20, i);
    const range20 = calculateRange20(prices, i);
    
    if (ret20 !== null && 
        Math.abs(ret20) <= th.SIDEWAYS_RET20_ABS && 
        range20 <= th.BREAKOUT_BASE_RANGE20) {
      return true;
    }
  }
  
  return false;
}

function countDownDays(prices: DailyPrice[], index: number): number {
  if (index < 19) return 0;
  const slice = prices.slice(index - 19, index + 1);
  return slice.filter((p, i, arr) => i > 0 && p.close < arr[i - 1].close).length;
}

function getMaxClose(prices: DailyPrice[], index: number): number {
  if (index < 19) return prices[index].close;
  const slice = prices.slice(index - 19, index);
  return Math.max(...slice.map(p => p.close));
}

function calculateTrendPhase(prices: DailyPrice[], index: number, assetType: string, profileKey?: string | null): { code: string; reason: string; reason_code: string; reason_details: string } {
  const th = getThresholds(assetType, profileKey);
  const close = prices[index].close;
  const ma20 = calculateMA(prices, 20, index);
  const ma60 = calculateMA(prices, 60, index);
  const ret1 = calculateRet(prices, 1, index);
  const ret5 = calculateRet(prices, 5, index);
  const ret20 = calculateRet(prices, 20, index);
  const range20 = calculateRange20(prices, index);
  const cross60_10 = calculateCross60(prices, index);
  
  const unmetConditions: string[] = [];
  
  console.log(`[趋势阶段判定] 开始 - 日期: ${prices[index].trade_date}, 索引: ${index}`);
  
  if (ma60 === null) {
    console.log(`[趋势阶段判定] 数据不足：MA60无法计算，当前索引=${index}，需要至少60个交易日数据`);
    return { 
      code: 'UNKNOWN', 
      reason: '状态未确认：当前数据未能满足足够的趋势阶段判定条件，等待市场确认。',
      reason_code: 'DATA_INSUFFICIENT',
      reason_details: 'MA60计算数据不足，至少需要60个交易日数据。'
    };
  }
  
  if (close <= 0) {
    console.log(`[趋势阶段判定] 数据验证失败：收盘价无效 (close=${close})`);
    return { 
      code: 'UNKNOWN', 
      reason: '状态未确认：数据验证失败。',
      reason_code: 'INVALID_DATA',
      reason_details: `收盘价无效：${close}`
    };
  }
  
  const bias60 = (close - ma60) / ma60;
  
  const ma60_prev5 = calculateMA(prices, 60, Math.max(0, index - 5));
  const ma60_slope_abs_5d = ma60_prev5 !== null ? Math.abs(ma60 - ma60_prev5) / ma60 : 1;
  const ma20_slope_5d = calculateMaSlope(prices, 20, index, 5);
  const max_drawdown20 = calculateMaxDrawdown(prices, index, 20);
  
  const max_close_20 = getMaxClose(prices, index);
  const breakout_condition = close > max_close_20 * (1 + th.BREAKOUT_MARGIN);
  
  const down_day_ratio = countDownDays(prices, index) / 20;
  
  console.log(`[趋势阶段判定] 基础指标计算完成 - profile: ${th.label}, close: ${close.toFixed(2)}, ma60: ${ma60.toFixed(2)}, bias60: ${(bias60 * 100).toFixed(2)}%, ret5: ${ret5 !== null ? (ret5 * 100).toFixed(2) : 'null'}%, ret20: ${ret20 !== null ? (ret20 * 100).toFixed(2) : 'null'}%, range20: ${(range20 * 100).toFixed(2)}%, max_drawdown20: ${(max_drawdown20 * 100).toFixed(2)}%, cross60_10: ${cross60_10}, ma60_slope_abs_5d: ${(ma60_slope_abs_5d * 100).toFixed(3)}%`);
  
  if ((ret5 !== null && ret5 <= th.CRASH_5D) || 
      (ret20 !== null && ret20 <= th.CRASH_20D)) {
    const evidence = ret5 !== null && ret5 <= th.CRASH_5D 
      ? `5日回撤${(ret5 * 100).toFixed(1)}%` 
      : `20日回撤${(ret20! * 100).toFixed(1)}%`;
    const details = ret5 !== null && ret5 <= th.CRASH_5D 
      ? `5日回撤=${(ret5 * 100).toFixed(1)}% ≤ ${(th.CRASH_5D * 100).toFixed(1)}%（${th.label}阈值）` 
      : `20日回撤=${(ret20! * 100).toFixed(1)}% ≤ ${(th.CRASH_20D * 100).toFixed(1)}%（${th.label}阈值）`;
    console.log(`[趋势阶段判定] 命中暴跌阶段 - ${details}`);
    return { 
      code: 'CRASH_DROP', 
      reason: `暴跌：${evidence}，触发暴跌阈值。`,
      reason_code: '暴跌',
      reason_details: details
    };
  } else {
    if (ret5 === null) unmetConditions.push('暴跌: 5日回撤数据不足');
    else if (ret5 > th.CRASH_5D) unmetConditions.push(`暴跌: 5日回撤=${(ret5 * 100).toFixed(1)}% > ${(th.CRASH_5D * 100).toFixed(1)}%`);
    if (ret20 === null) unmetConditions.push('暴跌: 20日回撤数据不足');
    else if (ret20 > th.CRASH_20D) unmetConditions.push(`暴跌: 20日回撤=${(ret20 * 100).toFixed(1)}% > ${(th.CRASH_20D * 100).toFixed(1)}%`);
  }
  
  if ((ret5 !== null && ret5 >= th.SURGE_5D) || 
      (ret1 !== null && ret1 >= th.SURGE_1D)) {
    const evidence = ret5 !== null && ret5 >= th.SURGE_5D 
      ? `5日涨幅${(ret5 * 100).toFixed(1)}%` 
      : `单日涨幅${(ret1! * 100).toFixed(1)}%`;
    const details = ret5 !== null && ret5 >= th.SURGE_5D 
      ? `5日涨幅=${(ret5 * 100).toFixed(1)}% ≥ ${(th.SURGE_5D * 100).toFixed(1)}%（${th.label}阈值）` 
      : `单日涨幅=${(ret1! * 100).toFixed(1)}% ≥ ${(th.SURGE_1D * 100).toFixed(1)}%（${th.label}阈值）`;
    console.log(`[趋势阶段判定] 命中急涨阶段 - ${details}`);
    return { 
      code: 'SURGE', 
      reason: `急涨：${evidence}，触发急涨阈值。`,
      reason_code: '急涨',
      reason_details: details
    };
  } else {
    if (ret5 === null) unmetConditions.push('急涨: 5日涨幅数据不足');
    else if (ret5 < th.SURGE_5D) unmetConditions.push(`急涨: 5日涨幅=${(ret5 * 100).toFixed(1)}% < ${(th.SURGE_5D * 100).toFixed(1)}%`);
    if (ret1 === null) unmetConditions.push('急涨: 单日涨幅数据不足');
    else if (ret1 < th.SURGE_1D) unmetConditions.push(`急涨: 单日涨幅=${(ret1 * 100).toFixed(1)}% < ${(th.SURGE_1D * 100).toFixed(1)}%`);
  }
  
  const hasCrashDrop = wasCrashDrop(prices, index, th);
  const hasReboundRet = ret5 !== null && ret5 >= th.REBOUND_5D;
  const belowMa60OrDown = close < ma60 || (ma60_prev5 !== null && ma60 < ma60_prev5);
  
  if (hasCrashDrop && hasReboundRet && belowMa60OrDown) {
    console.log(`[趋势阶段判定] 命中反抽阶段 - 近期暴跌=${hasCrashDrop}, 5日涨幅=${(ret5! * 100).toFixed(1)}% ≥ 4%, 收盘价在MA60下方或MA60下行=${belowMa60OrDown}`);
    return { 
      code: 'REBOUND', 
      reason: `反抽：近期出现暴跌后，5日涨幅${(ret5! * 100).toFixed(1)}%，但仍在MA60下方或MA60继续下行。`,
      reason_code: '反抽',
      reason_details: `5日涨幅=${(ret5! * 100).toFixed(1)}% ≥ 4%，收盘价仍在MA60下方`
    };
  } else {
    if (!hasCrashDrop) unmetConditions.push('反抽: 近期无暴跌记录');
    if (!hasReboundRet) unmetConditions.push(`反抽: 5日涨幅=${ret5 !== null ? (ret5 * 100).toFixed(1) : 'null'}% < 4%`);
    if (!belowMa60OrDown) unmetConditions.push('反抽: 收盘价已站上MA60且MA60上行');
  }
  
  const hasBaseLike = wasBaseLike(prices, index, th);
  const ma20Upward = ma20_slope_5d !== null && ma20_slope_5d >= -0.003;
  
  if (hasBaseLike && breakout_condition && close > ma60 && ma20 !== null && close >= ma20 && ma20Upward) {
    console.log(`[趋势阶段判定] 命中突破阶段 - 前期收敛整理=${hasBaseLike}, 突破前20日高点=${breakout_condition}, 收盘价>MA60=${close > ma60}, MA20不下行=${ma20Upward}`);
    return { 
      code: 'BREAKOUT', 
      reason: `突破：前期收敛整理后，收盘价突破前20日高点${(th.BREAKOUT_MARGIN * 100).toFixed(1)}%，并站上MA20/MA60。`,
      reason_code: '突破',
      reason_details: `按${th.label}阈值：收盘价突破前20日高点${(th.BREAKOUT_MARGIN * 100).toFixed(1)}%，前期20日波动收敛，且收盘价>MA20/MA60`
    };
  } else {
    if (!hasBaseLike) unmetConditions.push('突破: 前期未形成收敛整理');
    if (!breakout_condition) unmetConditions.push(`突破: 收盘价未突破前20日高点0.5%`);
    if (!(close > ma60)) unmetConditions.push(`突破: 收盘价(${close.toFixed(2)}) ≤ MA60(${ma60.toFixed(2)})`);
    if (!(ma20 !== null && close >= ma20)) unmetConditions.push('突破: 收盘价未站上MA20');
    if (!ma20Upward) unmetConditions.push('突破: MA20仍明显下行');
  }
  
  if (close > ma60 && bias60 >= th.HIGH_BASE_BIAS60 && range20 <= th.SIDEWAYS_RANGE20_WIDE && ret20 !== null && ret20 >= -th.SIDEWAYS_RET20_ABS) {
    console.log(`[趋势阶段判定] 命中高位横盘阶段 - 收盘价>MA60=${close > ma60}, bias60=${(bias60 * 100).toFixed(1)}%, 20日振幅=${(range20 * 100).toFixed(1)}%`);
    return { 
      code: 'HIGH_BASE', 
      reason: `高位横盘：价格在MA60上方${(bias60 * 100).toFixed(1)}%，20日波动收敛但未继续加速。`,
      reason_code: '高位横盘',
      reason_details: `按${th.label}阈值：bias60=${(bias60 * 100).toFixed(1)}%，20日振幅=${(range20 * 100).toFixed(1)}%，价格仍在MA60上方`
    };
  } else {
    if (!(close > ma60)) unmetConditions.push(`高位横盘: 收盘价(${close.toFixed(2)}) ≤ MA60(${ma60.toFixed(2)})`);
    if (bias60 < th.HIGH_BASE_BIAS60) unmetConditions.push(`高位横盘: bias60=${(bias60 * 100).toFixed(1)}% < ${(th.HIGH_BASE_BIAS60 * 100).toFixed(1)}%`);
    if (range20 > th.SIDEWAYS_RANGE20_WIDE) unmetConditions.push(`高位横盘: 20日振幅=${(range20 * 100).toFixed(1)}%过大`);
  }
  
  const hasSlowUpRet = ret20 !== null && ret20 >= th.SLOW_UP_20D;
  const closeAboveMa60 = close >= ma60;
  const ma60Upward = ma60_prev5 !== null && ma60 > ma60_prev5;
  
  const slowUpControlled = max_drawdown20 <= th.SLOW_UP_MAX_DRAWDOWN20 && range20 <= th.SLOW_UP_MAX_RANGE20;
  
  if (hasSlowUpRet && closeAboveMa60 && ma60Upward && slowUpControlled) {
    console.log(`[趋势阶段判定] 命中慢涨阶段 - 20日涨幅=${(ret20! * 100).toFixed(1)}%, 收盘价≥MA60=${closeAboveMa60}, MA60上行=${ma60Upward}, 回撤和波动可控=${slowUpControlled}`);
    return { 
      code: 'SLOW_GRIND_UP', 
      reason: `慢涨：20日涨幅${(ret20! * 100).toFixed(1)}%，收盘价站上MA60，MA60上行，且回撤和波动未过热。`,
      reason_code: '慢涨',
      reason_details: `按${th.label}阈值：20日涨幅=${(ret20! * 100).toFixed(1)}% ≥ ${(th.SLOW_UP_20D * 100).toFixed(1)}%，20日最大回撤=${(max_drawdown20 * 100).toFixed(1)}%，20日振幅=${(range20 * 100).toFixed(1)}%`
    };
  } else {
    if (!hasSlowUpRet) unmetConditions.push(`慢涨: 20日涨幅=${ret20 !== null ? (ret20 * 100).toFixed(1) : 'null'}% < ${(th.SLOW_UP_20D * 100).toFixed(1)}%`);
    if (!closeAboveMa60) unmetConditions.push(`慢涨: 收盘价(${close.toFixed(2)}) < MA60(${ma60.toFixed(2)})`);
    if (!ma60Upward) unmetConditions.push(`慢涨: MA60未上行(当前=${ma60.toFixed(2)}, 5日前=${ma60_prev5 !== null ? ma60_prev5.toFixed(2) : 'null'})`);
    if (!slowUpControlled) unmetConditions.push(`慢涨: 20日回撤或振幅过大(回撤${(max_drawdown20 * 100).toFixed(1)}%，振幅${(range20 * 100).toFixed(1)}%)`);
  }

  const trendUpVolatilityOk =
    max_drawdown20 <= th.SLOW_UP_MAX_DRAWDOWN20 * 1.8 &&
    range20 <= th.SLOW_UP_MAX_RANGE20 * 1.6;
  if (hasSlowUpRet && closeAboveMa60 && ma60Upward && trendUpVolatilityOk) {
    console.log(`[趋势阶段判定] 命中趋势上行阶段 - 20日涨幅=${(ret20! * 100).toFixed(1)}%, 收盘价≥MA60=${closeAboveMa60}, MA60上行=${ma60Upward}, 波动高于慢涨但未失控=${trendUpVolatilityOk}`);
    return {
      code: 'TREND_UP',
      reason: `趋势上行：20日涨幅${(ret20! * 100).toFixed(1)}%，收盘价站上MA60且MA60上行；但20日回撤或振幅高于慢涨标准，按趋势上行观察。`,
      reason_code: '趋势上行',
      reason_details: `按${th.label}阈值：20日涨幅=${(ret20! * 100).toFixed(1)}% ≥ ${(th.SLOW_UP_20D * 100).toFixed(1)}%，20日最大回撤=${(max_drawdown20 * 100).toFixed(1)}%，20日振幅=${(range20 * 100).toFixed(1)}%；波动高于慢涨，但未达到失控区间`
    };
  } else {
    if (hasSlowUpRet && closeAboveMa60 && ma60Upward && !trendUpVolatilityOk) {
      unmetConditions.push(`趋势上行: 20日回撤或振幅已超趋势上行容忍区(回撤${(max_drawdown20 * 100).toFixed(1)}%，振幅${(range20 * 100).toFixed(1)}%)`);
    }
  }
  
  const hasBleedRet = ret20 !== null && ret20 <= th.BLEED_20D;
  const hasHighDownRatio = down_day_ratio >= th.BLEED_DOWN_DAY_RATIO;
  
  if (hasBleedRet && hasHighDownRatio) {
    console.log(`[趋势阶段判定] 命中阴跌阶段 - 20日回撤=${(ret20! * 100).toFixed(1)}% ≤ -5%, 下跌天数占比=${(down_day_ratio * 100).toFixed(0)}% ≥ 55%`);
    return { 
      code: 'SLOW_BLEED', 
      reason: `阴跌：20日回撤${(ret20! * 100).toFixed(1)}%，下跌天数占比${(down_day_ratio * 100).toFixed(0)}%，呈持续下跌态势。`,
      reason_code: '阴跌',
      reason_details: `20日回撤=${(ret20! * 100).toFixed(1)}% ≤ -5%，下跌天数占比=${(down_day_ratio * 100).toFixed(0)}% ≥ 55%`
    };
  } else {
    if (!hasBleedRet) unmetConditions.push(`阴跌: 20日回撤=${ret20 !== null ? (ret20 * 100).toFixed(1) : 'null'}% > -5%`);
    if (!hasHighDownRatio) unmetConditions.push(`阴跌: 下跌天数占比=${(down_day_ratio * 100).toFixed(0)}% < 55%`);
  }
  
  const biasInRange = Math.abs(bias60) <= th.RECOVERY_BIAS60_ABS;
  const slopeFlat = ma60_slope_abs_5d < th.RECOVERY_MA60_SLOPE_ABS_5D;
  const recoveryRetOk = ret20 !== null && ret20 > th.BLEED_20D && ret20 < th.SLOW_UP_20D;
  
  if (biasInRange && slopeFlat && recoveryRetOk) {
    console.log(`[趋势阶段判定] 命中修复阶段 - bias60=${(bias60 * 100).toFixed(1)}%, MA60斜率=${(ma60_slope_abs_5d * 100).toFixed(2)}%, ret20=${ret20 !== null ? (ret20 * 100).toFixed(1) : 'null'}%`);
    return { 
      code: 'RECOVERY', 
      reason: `修复：价格回到MA60附近，MA60趋于平缓，短期跌势缓和但尚未形成慢涨。`,
      reason_code: '修复',
      reason_details: `按${th.label}阈值：价格偏离MA60=${(bias60 * 100).toFixed(1)}%，MA60斜率平缓，20日收益介于阴跌和慢涨之间`
    };
  } else {
    if (!biasInRange) unmetConditions.push(`修复: 价格偏离MA60=${(bias60 * 100).toFixed(1)}%超出${(th.RECOVERY_BIAS60_ABS * 100).toFixed(1)}%`);
    if (!slopeFlat) unmetConditions.push(`修复: MA60斜率=${(ma60_slope_abs_5d * 100).toFixed(2)}% ≥ ${(th.RECOVERY_MA60_SLOPE_ABS_5D * 100).toFixed(2)}%`);
    if (!recoveryRetOk) unmetConditions.push('修复: 20日收益未处于修复区间');
  }
  
  const ret20InRange = ret20 !== null && Math.abs(ret20) <= th.SIDEWAYS_RET20_ABS;
  const rangeInLimit = range20 <= th.SIDEWAYS_RANGE20;
  const biasSidewaysOk = Math.abs(bias60) <= th.SIDEWAYS_BIAS60_ABS;
  
  if (ret20InRange && rangeInLimit && biasSidewaysOk) {
    console.log(`[趋势阶段判定] 命中横盘震荡阶段 - 20日振幅=${(range20 * 100).toFixed(1)}%, 20日收益=${ret20 !== null ? (ret20 * 100).toFixed(1) : 'null'}%, bias60=${(bias60 * 100).toFixed(1)}%`);
    return { 
      code: 'SIDEWAYS', 
      reason: `横盘震荡：20日收益和振幅都处于收敛区间，价格没有明显单边方向。`,
      reason_code: '横盘震荡',
      reason_details: `按${th.label}阈值：20日收益绝对值≤${(th.SIDEWAYS_RET20_ABS * 100).toFixed(1)}%，20日振幅≤${(th.SIDEWAYS_RANGE20 * 100).toFixed(1)}%，价格未明显偏离MA60`
    };
  } else {
    if (!ret20InRange) unmetConditions.push(`横盘震荡: 20日收益绝对值=${ret20 !== null ? Math.abs(ret20 * 100).toFixed(1) : 'null'}% > ${(th.SIDEWAYS_RET20_ABS * 100).toFixed(1)}%`);
    if (!rangeInLimit) unmetConditions.push(`横盘震荡: 20日振幅=${(range20 * 100).toFixed(1)}% > ${(th.SIDEWAYS_RANGE20 * 100).toFixed(1)}%`);
    if (!biasSidewaysOk) unmetConditions.push(`横盘震荡: 价格偏离MA60=${(bias60 * 100).toFixed(1)}%过大`);
  }
  
  const hitSlowGrindUp = hasSlowUpRet && closeAboveMa60 && ma60Upward;
  const hitHighBase = close > ma60 && bias60 >= th.HIGH_BASE_BIAS60 && range20 <= th.SIDEWAYS_RANGE20_WIDE;
  const hitSideways = ret20InRange && rangeInLimit && biasSidewaysOk;
  const hitRecovery = biasInRange && slopeFlat && recoveryRetOk;
  const hitSlowBleed = hasBleedRet && hasHighDownRatio;
  
  const trendTransA = close >= ma60 &&
                     bias60 >= 0 && bias60 <= Math.max(th.HIGH_BASE_BIAS60 * 1.4, th.SIDEWAYS_BIAS60_ABS) &&
                     ret20 !== null && ret20 >= -th.SIDEWAYS_RET20_ABS && ret20 < th.SLOW_UP_20D &&
                     !hitSlowGrindUp && !hitHighBase && !hitSideways && !hitRecovery;
  
  if (trendTransA) {
    console.log(`[趋势阶段判定] 命中趋势转换中阶段(上涨动能衰减) - close>=MA60=${close >= ma60}, bias60=${(bias60 * 100).toFixed(1)}%(0~10%), ret20=${(ret20! * 100).toFixed(1)}%(-2%~5%)`);
    return { 
      code: 'TREND_TRANSITION', 
      reason: `趋势转换中（上涨动能衰减）：价格仍在MA60上方，但20日收益未达到慢涨标准，处于趋势转换观察期。`,
      reason_code: '趋势转换中',
      reason_details: `上涨动能衰减：价格仍在MA60上方，但20日收益未达到慢涨标准，处于趋势转换观察期`
    };
  }
  
  const trendTransB = close >= ma60 &&
                     bias60 >= th.HIGH_BASE_BIAS60 && bias60 <= th.HIGH_BASE_BIAS60 * 1.8 &&
                     ret20 !== null && ret20 >= 0 && ret20 < th.SLOW_UP_20D &&
                     cross60_10 <= 1 &&
                     !hitSlowGrindUp;
  
  if (trendTransB) {
    console.log(`[趋势阶段判定] 命中趋势转换中阶段(高位滞涨) - close>=MA60=${close >= ma60}, bias60=${(bias60 * 100).toFixed(1)}%(5%~10%), ret20=${(ret20! * 100).toFixed(1)}%(0~5%), cross60_10=${cross60_10} ≤ 1`);
    return { 
      code: 'TREND_TRANSITION', 
      reason: `趋势转换中（高位滞涨）：价格明显高于MA60，但20日收益不足5%，上涨动能不足。`,
      reason_code: '高位滞涨',
      reason_details: `高位滞涨：价格明显高于MA60，但20日收益不足5%，上涨动能不足，暂归为趋势转换中`
    };
  }
  
  const trendTransC = Math.abs(bias60) <= th.RECOVERY_BIAS60_ABS &&
                     ret20 !== null && Math.abs(ret20) <= th.SIDEWAYS_RET20_ABS &&
                     cross60_10 < 2 &&
                     !hitRecovery && !hitSideways && !hitSlowBleed && !hitSlowGrindUp;
  
  if (trendTransC) {
    console.log(`[趋势阶段判定] 命中趋势转换中阶段(MA60附近方向未定) - abs(bias60)=${Math.abs(bias60 * 100).toFixed(1)}% ≤ 2%, ret20=${(ret20! * 100).toFixed(1)}%(-3%~3%), cross60_10=${cross60_10} < 2`);
    return { 
      code: 'TREND_TRANSITION', 
      reason: `趋势转换中（方向未定型）：价格贴近MA60，但尚未形成修复、横盘、阴跌或重新上涨。`,
      reason_code: '趋势转换中',
      reason_details: `MA60附近方向未定型：价格贴近MA60，但尚未形成修复、横盘、阴跌或重新上涨`
    };
  }
  
  const trendTransD = close >= ma60 &&
                     bias60 >= 0 && bias60 <= th.HIGH_BASE_BIAS60 &&
                     ret20 !== null && ret20 >= th.SLOW_UP_20D &&
                     cross60_10 <= 1 &&
                     !hitSlowGrindUp;
  
  if (trendTransD) {
    console.log(`[趋势阶段判定] 命中趋势转换中阶段(上行确认前) - close>=MA60=${close >= ma60}, bias60=${(bias60 * 100).toFixed(1)}%(0~${(th.HIGH_BASE_BIAS60 * 100).toFixed(1)}%), ret20=${(ret20! * 100).toFixed(1)}% ≥ ${(th.SLOW_UP_20D * 100).toFixed(1)}%, cross60_10=${cross60_10} ≤ 1`);
    return { 
      code: 'TREND_TRANSITION', 
      reason: `趋势转换中（上行确认前）：价格站上MA60，20日收益已明显转强，但尚未满足慢涨完整确认条件。`,
      reason_code: '上行确认前',
      reason_details: `上行确认前：价格站上MA60，20日收益已明显转强，但尚未满足慢涨完整确认条件`
    };
  }
  
  const trendTransE = close < ma60 &&
                     bias60 <= 0 && bias60 >= -th.SIDEWAYS_BIAS60_ABS &&
                     ret20 !== null && ret20 <= -th.SIDEWAYS_RET20_ABS && ret20 > th.BLEED_20D &&
                     !hitSlowBleed;
  
  if (trendTransE) {
    console.log(`[趋势阶段判定] 命中趋势转换中阶段(弱势转换中) - close<MA60=${close < ma60}, bias60=${(bias60 * 100).toFixed(1)}%(-6%~0), ret20=${(ret20! * 100).toFixed(1)}%(-6%~-3%)`);
    return { 
      code: 'TREND_TRANSITION', 
      reason: `趋势转换中（弱势转换中）：价格位于MA60下方，20日收益为负，但尚未满足阴跌或暴跌条件。`,
      reason_code: '弱势转换中',
      reason_details: `弱势转换中：价格位于MA60下方，20日收益为负，但尚未满足阴跌或暴跌条件`
    };
  }
  
  const trendTransF = Math.abs(bias60) <= th.SIDEWAYS_BIAS60_ABS &&
                     ret20 !== null && ret20 <= -th.SIDEWAYS_RET20_ABS && ret20 > th.BLEED_20D &&
                     cross60_10 <= 1 &&
                     !hitSlowBleed && !hitSideways && !hitRecovery;
  
  if (trendTransF) {
    console.log(`[趋势阶段判定] 命中趋势转换中阶段(MA60附近偏弱震荡) - abs(bias60)=${Math.abs(bias60 * 100).toFixed(1)}% ≤ 3%, ret20=${(ret20! * 100).toFixed(1)}%(-5.5%~-3%), cross60_10=${cross60_10} ≤ 1`);
    return { 
      code: 'TREND_TRANSITION', 
      reason: `趋势转换中（偏弱震荡）：价格处于MA60附近，20日收益偏弱但尚未确认阴跌。`,
      reason_code: '偏弱震荡',
      reason_details: `偏弱震荡：价格处于MA60附近，20日收益偏弱但尚未确认阴跌，暂归为趋势转换中`
    };
  }
  
  const trendTransG = close < ma60 &&
                     bias60 < 0 && bias60 >= -th.RECOVERY_BIAS60_ABS &&
                     ret20 !== null && ret20 >= th.SLOW_UP_20D && ret20 < th.SURGE_5D;
  
  if (trendTransG) {
    console.log(`[趋势阶段判定] 命中趋势转换中阶段(上穿前修复) - close<MA60=${close < ma60}, bias60=${(bias60 * 100).toFixed(1)}%(-2%~0), ret20=${(ret20! * 100).toFixed(1)}%(5%~10%)`);
    return { 
      code: 'TREND_TRANSITION', 
      reason: `趋势转换中（上穿前修复）：价格仍略低于MA60，但20日收益已明显转强。`,
      reason_code: '上穿前修复',
      reason_details: `上穿前修复：价格仍略低于MA60，但20日收益已明显转强，处于上穿MA60前的修复确认阶段`
    };
  }

  const trendTransH = close < ma60 &&
                     Math.abs(bias60) <= th.SIDEWAYS_BIAS60_ABS * 1.5 &&
                     ret20 !== null && ret20 > th.CRASH_20D && ret20 < th.SLOW_UP_20D &&
                     range20 <= th.SIDEWAYS_RANGE20_WIDE * 1.3 &&
                     cross60_10 <= 1 &&
                     !hitSlowBleed && !hitSideways && !hitRecovery;

  if (trendTransH) {
    console.log(`[趋势阶段判定] 命中趋势转换中阶段(弱势整理中) - close<MA60=${close < ma60}, bias60=${(bias60 * 100).toFixed(1)}%, ret20=${(ret20! * 100).toFixed(1)}%, range20=${(range20 * 100).toFixed(1)}%`);
    return {
      code: 'TREND_TRANSITION',
      reason: `趋势转换中（弱势整理中）：价格位于MA60下方，20日收益和振幅尚未触发暴跌或阴跌，等待重新修复确认。`,
      reason_code: '弱势整理中',
      reason_details: `弱势整理中：价格位于MA60下方，20日收益未触发暴跌，振幅未明显失控，暂归为趋势转换中`
    };
  }
  
  const consolConditionA = Math.abs(bias60) <= th.SIDEWAYS_BIAS60_ABS &&
                          ret20 !== null && Math.abs(ret20) <= th.SIDEWAYS_RET20_ABS &&
                          range20 <= th.SIDEWAYS_RANGE20_WIDE &&
                          !hitSideways && !hitRecovery;
  
  if (consolConditionA) {
    console.log(`[趋势阶段判定] 命中震荡待确认阶段(普通震荡) - abs(bias60)=${Math.abs(bias60 * 100).toFixed(1)}% ≤ 4%, ret20=${(ret20! * 100).toFixed(1)}%(-4%~4%), range20=${(range20 * 100).toFixed(1)}% ≤ 8%`);
    return { 
      code: 'CONSOLIDATION', 
      reason: `震荡待确认：价格处于MA60附近，20日收益和振幅均不极端，但尚未满足横盘震荡或修复条件。`,
      reason_code: '震荡待确认',
      reason_details: `震荡待确认：价格处于MA60附近，20日收益和振幅均不极端，但尚未满足横盘震荡或修复条件`
    };
  }
  
  const consolConditionB = Math.abs(bias60) <= th.SIDEWAYS_BIAS60_ABS &&
                          ret20 !== null && Math.abs(ret20) <= th.SIDEWAYS_RET20_ABS &&
                          range20 <= th.SIDEWAYS_RANGE20_WIDE &&
                          cross60_10 <= 1 &&
                          !hitSideways && !hitRecovery;
  
  if (consolConditionB) {
    console.log(`[趋势阶段判定] 命中震荡待确认阶段(浅度横盘) - abs(bias60)=${Math.abs(bias60 * 100).toFixed(1)}% ≤ 4%, ret20=${(ret20! * 100).toFixed(1)}%(-3%~3%), range20=${(range20 * 100).toFixed(1)}% ≤ 10%, cross60_10=${cross60_10} ≤ 1`);
    return { 
      code: 'CONSOLIDATION', 
      reason: `震荡待确认（浅度横盘）：价格波动不大但未满足严格横盘条件。`,
      reason_code: '浅度横盘',
      reason_details: `浅度横盘：价格波动不大但未满足严格横盘条件，暂归为震荡待确认`
    };
  }
  
  console.log(`[趋势阶段判定] 未命中任何阶段，返回UNKNOWN - 未满足的条件: ${unmetConditions.join('; ')}`);
  return { 
    code: 'UNKNOWN', 
    reason: '状态未确认：当前数据未能命中任何趋势阶段判定条件。',
    reason_code: '未命中',
    reason_details: `未命中任何趋势阶段：请检查是否需要新增规则或放宽现有阈值`
  };
}

router.post('/recalc', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { symbol, asset_type, source, start_date, end_date } = req.body;

    if (!symbol || !asset_type || !source) {
      return res.status(400).json({
        success: false,
        message: 'symbol, asset_type, source are required'
      });
    }

    logUpdate(`趋势阶段重算: ${symbol} ${asset_type} ${source}`, symbol);

    const assetMeta = await db.get(
      `SELECT COALESCE(MAX(NULLIF(name, '')), '') as name,
              GROUP_CONCAT(DISTINCT universe_type) as universe_type
       FROM financial_asset_universe
       WHERE symbol = ? AND asset_type = ? AND source = ?`,
      [symbol, asset_type, source]
    );
    const planProfile = resolveFinancePlanProfile({
      assetType: asset_type,
      symbol,
      name: assetMeta?.name || symbol,
      universeType: assetMeta?.universe_type || ''
    });

    const allPrices = await db.all(
      `SELECT trade_date, open, high, low, close 
       FROM financial_daily_prices 
       WHERE symbol = ? AND asset_type = ? AND source = ?
       ORDER BY trade_date ASC`,
      [symbol, asset_type, source]
    );

    if (allPrices.length < 60) {
      return res.status(400).json({
        success: false,
        message: `数据不足（当前${allPrices.length}条），至少需要60个交易日。`
      });
    }

    const prices: DailyPrice[] = allPrices.map(p => ({
      trade_date: p.trade_date,
      open: p.open || p.close,
      high: p.high || p.close,
      low: p.low || p.close,
      close: p.close
    }));

    let startIdx = 0;
    let endIdx = prices.length - 1;

    if (start_date) {
      startIdx = prices.findIndex(p => p.trade_date >= start_date);
      if (startIdx === -1) startIdx = prices.length - 1;
    }

    if (end_date) {
      endIdx = prices.findIndex(p => p.trade_date > end_date);
      if (endIdx === -1) endIdx = prices.length - 1;
      else endIdx = Math.max(59, endIdx - 1);
    }

    startIdx = Math.max(59, startIdx);

    if (startIdx > endIdx) {
      return res.status(400).json({
        success: false,
        message: '指定日期范围无效或数据不足。'
      });
    }

    let insertedCount = 0;
    let updatedCount = 0;

    for (let i = startIdx; i <= endIdx; i++) {
      const result = calculateTrendPhase(prices, i, asset_type, planProfile.key);
      const ma20 = calculateMA(prices, 20, i);
      const ma60 = calculateMA(prices, 60, i);
      const ret5 = calculateRet(prices, 5, i);
      const ret20 = calculateRet(prices, 20, i);
      const range20 = calculateRange20(prices, i);
      const cross60_10 = calculateCross60(prices, i);
      
      const bias60 = ma60 !== null ? (prices[i].close - ma60) / ma60 : null;

      const existing = await db.get(
        `SELECT 1 FROM financial_trend_phase_results 
         WHERE symbol = ? AND asset_type = ? AND source = ? AND trade_date = ? AND rule_version = ?`,
        [symbol, asset_type, source, prices[i].trade_date, TREND_PHASE_VERSION]
      );

      await db.run(
        `INSERT OR REPLACE INTO financial_trend_phase_results 
         (symbol, asset_type, source, trade_date, close, ma20, ma60, bias60, ret5, ret20, range20, cross60_10, trend_phase_code, trend_phase_reason, reason_code, reason_details, rule_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          symbol,
          asset_type,
          source,
          prices[i].trade_date,
          prices[i].close,
          ma20,
          ma60,
          bias60,
          ret5,
          ret20,
          range20,
          cross60_10,
          result.code,
          result.reason,
          result.reason_code,
          result.reason_details,
          TREND_PHASE_VERSION
        ]
      );

      if (existing) {
        updatedCount++;
      } else {
        insertedCount++;
      }
    }

    const firstDate = prices[startIdx].trade_date;
    const lastDate = prices[endIdx].trade_date;

    logUpdate(`趋势阶段计算完成：新增 ${insertedCount} 条，更新 ${updatedCount} 条`, symbol);

    res.json({
      success: true,
      message: `趋势阶段计算完成：新增 ${insertedCount} 条，更新 ${updatedCount} 条`,
      data: {
        symbol,
        asset_type,
        source,
        first_trade_date: firstDate,
        last_trade_date: lastDate,
        total_count: insertedCount + updatedCount,
        rule_version: TREND_PHASE_VERSION,
        profile_key: planProfile.key,
        profile_label: planProfile.label
      }
    });
  } catch (error) {
    logUpdate(`趋势阶段计算失败: ${(error as Error).message}`, req.body.symbol);
    console.error('Error calculating trend phase:', error);
    res.status(500).json({
      success: false,
      message: `计算失败: ${(error as Error).message}`
    });
  }
});

router.get('/queue', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const source = String(req.query.source || 'tushare');
    const limit = Math.max(Math.min(parseInt(req.query.limit as string) || 80, 300), 1);
    const assetType = String(req.query.asset_type || '').trim();

    const whereParts = [
      `c.pool_status = 'active'`,
      `c.asset_type IN ('stock', 'etf')`,
      `c.source = ?`,
      `COALESCE(c.review_status, 'unreviewed') NOT IN ('plan_ready', 'rejected')`,
      `(
        COALESCE(c.review_status, 'unreviewed') = 'trend_blocked'
        OR t.trend_phase_code IS NULL
        OR t.trend_phase_code NOT IN (${READY_TREND_PHASE_SQL})
      )`
    ];
    const whereParams: any[] = [source];

    if (assetType === 'stock' || assetType === 'etf') {
      whereParts.push(`c.asset_type = ?`);
      whereParams.push(assetType);
    }

    const latestTrendJoin = `
      LEFT JOIN financial_trend_phase_results t ON t.id = (
        SELECT t2.id
        FROM financial_trend_phase_results t2
        WHERE t2.symbol = c.symbol
          AND t2.asset_type = c.asset_type
          AND t2.source = c.source
          AND t2.rule_version = ?
        ORDER BY t2.trade_date DESC, t2.id DESC
        LIMIT 1
      )
    `;
    const whereSql = whereParts.join('\n      AND ');

    const countRow = await db.get(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN t.trend_phase_code IN (${READY_TREND_PHASE_SQL}) THEN 1 ELSE 0 END) as ready_count,
         SUM(CASE WHEN t.trend_phase_code IS NULL OR t.trend_phase_code = 'UNKNOWN' THEN 1 ELSE 0 END) as unknown_count,
         SUM(CASE WHEN t.trend_phase_code IN (${REJECT_TREND_PHASE_SQL}) THEN 1 ELSE 0 END) as reject_count,
         SUM(CASE
           WHEN t.trend_phase_code IS NOT NULL
            AND t.trend_phase_code != 'UNKNOWN'
            AND t.trend_phase_code NOT IN (${READY_TREND_PHASE_SQL})
            AND t.trend_phase_code NOT IN (${REJECT_TREND_PHASE_SQL})
           THEN 1 ELSE 0
         END) as blocked_count
       FROM financial_candidate_pool c
       ${latestTrendJoin}
       WHERE ${whereSql}`,
      [TREND_PHASE_VERSION, ...whereParams]
    );

    const rows = await db.all(
      `SELECT
         c.id,
         c.symbol,
         c.name,
         c.asset_type,
         c.source,
         c.priority_score,
         c.review_status,
         c.candidate_reason,
         (
           SELECT GROUP_CONCAT(DISTINCT u.universe_type)
           FROM financial_asset_universe u
           WHERE u.symbol = c.symbol
             AND u.asset_type = c.asset_type
             AND u.source = c.source
         ) AS universe_type,
         c.last_checked_at,
         c.updated_at,
         t.trade_date,
         t.close,
         t.bias60,
         t.ret20,
         t.trend_phase_code,
         t.trend_phase_reason
       FROM financial_candidate_pool c
       ${latestTrendJoin}
       WHERE ${whereSql}
       ORDER BY
         CASE
           WHEN COALESCE(c.review_status, 'unreviewed') = 'trend_blocked'
                AND t.trend_phase_code IN (${READY_TREND_PHASE_SQL}) THEN 0
           WHEN t.trend_phase_code IN (${REJECT_TREND_PHASE_SQL}) THEN 1
           WHEN COALESCE(c.review_status, 'unreviewed') = 'trend_blocked' THEN 1
           WHEN t.trend_phase_code IS NULL OR t.trend_phase_code = 'UNKNOWN' THEN 2
           ELSE 3
         END,
         c.priority_score DESC,
         COALESCE(c.updated_at, c.last_checked_at) DESC,
         c.id DESC
       LIMIT ?`,
      [TREND_PHASE_VERSION, ...whereParams, limit]
    );

    const items = rows.map((row: any) => {
      const planProfile = resolveFinancePlanProfile({
        assetType: row.asset_type,
        symbol: row.symbol,
        name: row.name,
        universeType: row.universe_type || ''
      });
      const stageStatus = getTrendQueueStatus(row.trend_phase_code, row.review_status);
      return {
        ...row,
        plan_profile: planProfile.key,
        plan_profile_label: planProfile.label,
        trend_phase_code: row.trend_phase_code || 'UNKNOWN',
        trend_phase_reason: row.trend_phase_reason || row.candidate_reason || '暂无走势阶段结果，等待流水线重算。',
        stage_status: stageStatus.key,
        stage_status_label: stageStatus.label,
        stage_status_tone: stageStatus.tone
      };
    });

    res.json({
      success: true,
      data: {
        items,
        summary: {
          total: Number(countRow?.total || 0),
          ready_count: Number(countRow?.ready_count || 0),
          blocked_count: Number(countRow?.blocked_count || 0),
          unknown_count: Number(countRow?.unknown_count || 0),
          reject_count: Number(countRow?.reject_count || 0)
        }
      }
    });
  } catch (error) {
    console.error('Error getting trend phase queue:', error);
    res.status(500).json({
      success: false,
      message: `获取走势阶段队列失败: ${(error as Error).message}`
    });
  }
});

router.get('/latest', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.query.symbol as string;
    const asset_type = req.query.asset_type as string;
    const source = req.query.source as string;

    if (!symbol || !asset_type || !source) {
      return res.status(400).json({
        success: false,
        message: 'symbol, asset_type, source are required'
      });
    }

    logRead(`获取趋势阶段最新结果: ${symbol} ${asset_type} ${source}`, symbol);

    const result = await db.get(
      `SELECT * FROM financial_trend_phase_results 
       WHERE symbol = ? AND asset_type = ? AND source = ? AND rule_version = ?
       ORDER BY trade_date DESC LIMIT 1`,
      [symbol, asset_type, source, TREND_PHASE_VERSION]
    );

    if (!result) {
      return res.json({
        success: true,
        data: null,
        message: '暂无趋势阶段数据，请先执行 recalc。'
      });
    }

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logRead(`获取趋势阶段失败: ${(error as Error).message}`, req.query.symbol as string);
    console.error('Error getting trend phase:', error);
    res.status(500).json({
      success: false,
      message: `获取失败: ${(error as Error).message}`
    });
  }
});

router.get('/list', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.query.symbol as string;
    const asset_type = req.query.asset_type as string;
    const source = req.query.source as string;
    const start_date = req.query.start_date as string;
    const end_date = req.query.end_date as string;

    if (!symbol || !asset_type || !source) {
      return res.status(400).json({
        success: false,
        message: 'symbol, asset_type, source are required'
      });
    }

    const pageNum = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 50;
    const offset = (pageNum - 1) * pageSize;

    logRead(`获取趋势阶段列表: ${symbol} ${asset_type} ${source}`, symbol);

    let query = `SELECT * FROM financial_trend_phase_results 
                 WHERE symbol = ? AND asset_type = ? AND source = ? AND rule_version = ?`;
    let params: any[] = [symbol, asset_type, source, TREND_PHASE_VERSION];

    if (start_date) {
      query += ' AND trade_date >= ?';
      params.push(start_date);
    }

    if (end_date) {
      query += ' AND trade_date <= ?';
      params.push(end_date);
    }

    query += ' ORDER BY trade_date DESC LIMIT ? OFFSET ?';
    params.push(pageSize, offset);

    const items = await db.all(query, params);

    let countQuery = `SELECT COUNT(*) as total FROM financial_trend_phase_results 
                      WHERE symbol = ? AND asset_type = ? AND source = ? AND rule_version = ?`;
    let countParams: any[] = [symbol, asset_type, source, TREND_PHASE_VERSION];

    if (start_date) {
      countQuery += ' AND trade_date >= ?';
      countParams.push(start_date);
    }

    if (end_date) {
      countQuery += ' AND trade_date <= ?';
      countParams.push(end_date);
    }

    const countResult = await db.get(countQuery, countParams);
    const total = countResult?.total || 0;

    res.json({
      success: true,
      data: {
        items,
        pagination: {
          page: pageNum,
          page_size: pageSize,
          total
        }
      }
    });
  } catch (error) {
    logRead(`获取趋势阶段列表失败: ${(error as Error).message}`, req.query.symbol as string);
    console.error('Error getting trend phase list:', error);
    res.status(500).json({
      success: false,
      message: `获取失败: ${(error as Error).message}`
    });
  }
});

export default router;
