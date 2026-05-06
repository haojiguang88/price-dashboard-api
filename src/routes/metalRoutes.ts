import express, { Request, Response } from 'express';
import { exec } from 'child_process';
import path from 'path';
import getDb from '../config/database';

const router = express.Router();

interface MetalDailyPrice {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  amount: number | null;
}

interface MetalBehaviorTag {
  code: string;
  label: string;
  tone: 'good' | 'warn' | 'risk' | 'neutral';
  reason: string;
}

interface MetalRegime {
  symbol: string;
  trade_date: string;
  close: number;
  ma20: number;
  ma60: number;
  ma120: number;
  ma250: number;
  ma20_slope: string;
  ma60_prev: number;
  ma120_prev: number;
  ma250_prev: number;
  ma60_slope: string;
  ma120_slope: string;
  ma250_slope: string;
  latest_change: number | null;
  distance_to_ma60: number;
  distance_to_ma250: number | null;
  low_60: number | null;
  low_120: number | null;
  recent_return_5: number | null;
  recent_return_10: number | null;
  recent_return_20: number | null;
  drawdown_20: number | null;
  drawdown_60: number | null;
  drawdown_120: number | null;
  range_ratio_5: number | null;
  range_ratio_20: number | null;
  higher_low: boolean;
  higher_high: boolean;
  lower_low: boolean;
  lower_high: boolean;
  sideways: boolean;
  up_days: number;
  down_days: number;
  abnormal_move: boolean;
  above_ma60_days: number;
  below_ma60_days: number;
  short_state: string;
  short_label: string;
  short_reason: string;
  mid_state: string;
  mid_label: string;
  mid_reason: string;
  long_state: string;
  long_label: string;
  long_reason: string;
  cycle_state: string;
  cycle_label: string;
  cycle_reason: string;
  behavior_tags: MetalBehaviorTag[];
  state_code: string;
  state_reason: string;
  entry_permission: string;
  entry_reason: string;
  rule_version: string;
  source: string;
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

const METAL_STATE_CODES = [
  'RISK',
  'REBOUND',
  'LOW_RANGE',
  'REPAIR_WATCH',
  'STRUCTURE_FORMING',
  'SAFE_CANDIDATE',
  'SAFE_CONFIRMED',
  'TREND',
  'OVERHEAT',
  'UNKNOWN'
];

function roundNumber(value: number | null, digits: number = 4): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function averageClose(prices: MetalDailyPrice[]): number | null {
  return average(prices.map(price => Number(price.close)));
}

function minLow(prices: MetalDailyPrice[]): number | null {
  const values = prices.map(price => Number(price.low ?? price.close)).filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

function maxHigh(prices: MetalDailyPrice[]): number | null {
  const values = prices.map(price => Number(price.high ?? price.close)).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function minClosePrice(prices: MetalDailyPrice[]): MetalDailyPrice | null {
  const valid = prices.filter(price => Number.isFinite(Number(price.close)));
  if (!valid.length) return null;
  return valid.reduce((min, price) => Number(price.close) < Number(min.close) ? price : min);
}

function maxClosePrice(prices: MetalDailyPrice[]): MetalDailyPrice | null {
  const valid = prices.filter(price => Number.isFinite(Number(price.close)));
  if (!valid.length) return null;
  return valid.reduce((max, price) => Number(price.close) > Number(max.close) ? price : max);
}

function getLongCyclePrices(prices: MetalDailyPrice[]): MetalDailyPrice[] {
  const lookback = prices.slice(-1260);
  if (!lookback.length) return [];

  let runningPeak = lookback[0];
  let latestBearResetIndex = -1;

  lookback.forEach((price, index) => {
    const close = Number(price.close);
    const peakClose = Number(runningPeak.close);
    if (Number.isFinite(close) && close > peakClose) {
      runningPeak = price;
    }
    const updatedPeakClose = Number(runningPeak.close);
    if (updatedPeakClose > 0 && close / updatedPeakClose - 1 <= -0.20) {
      latestBearResetIndex = index;
    }
  });

  if (latestBearResetIndex >= 0) {
    return lookback.slice(latestBearResetIndex);
  }

  return prices.slice(-504);
}

function averageRangeRatio(prices: MetalDailyPrice[]): number | null {
  const ratios = prices
    .map(price => {
      const high = Number(price.high ?? price.close);
      const low = Number(price.low ?? price.close);
      const close = Number(price.close);
      return close > 0 ? (high - low) / close : null;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return ratios.length ? average(ratios) : null;
}

function getReturn(prices: MetalDailyPrice[], days: number): number | null {
  if (prices.length <= days) return null;
  const latest = Number(prices[prices.length - 1].close);
  const previous = Number(prices[prices.length - 1 - days].close);
  return previous > 0 ? latest / previous - 1 : null;
}

function countConsecutiveMove(prices: MetalDailyPrice[], direction: 'up' | 'down'): number {
  let count = 0;
  for (let i = prices.length - 1; i > 0; i--) {
    const current = Number(prices[i].close);
    const previous = Number(prices[i - 1].close);
    const matched = direction === 'up' ? current > previous : current < previous;
    if (!matched) break;
    count++;
  }
  return count;
}

function countLargeMove(prices: MetalDailyPrice[], days: number, threshold: number, direction: 'up' | 'down'): number {
  const start = Math.max(1, prices.length - days);
  let count = 0;
  for (let i = start; i < prices.length; i++) {
    const current = Number(prices[i].close);
    const previous = Number(prices[i - 1].close);
    if (previous <= 0) continue;
    const change = current / previous - 1;
    if (direction === 'up' && change >= threshold) count++;
    if (direction === 'down' && change <= -threshold) count++;
  }
  return count;
}

async function fetchAndUpdateMetalData(db: any, symbol: string, forceUpdate: boolean = false): Promise<{ success: boolean; message: string; updated: boolean }> {
  const now = new Date();
  
  const lastUpdateResult = await db.get(
    `SELECT MAX(updated_at) as last_updated
     FROM financial_daily_prices 
     WHERE symbol = ? AND source = 'twelvedata'`,
    [symbol]
  );

  if (!forceUpdate && lastUpdateResult.last_updated) {
    const lastUpdated = new Date(lastUpdateResult.last_updated);
    const diffSeconds = (now.getTime() - lastUpdated.getTime()) / 1000;
    
    if (diffSeconds < 60) {
      logUpdate(`数据更新频率限制：距离上次更新不足60秒`, symbol);
      return { success: true, message: '距离上次更新不足60秒', updated: false };
    }
  }

  const scriptPath = path.join(__dirname, '../../scripts/finance/fetch_metal_daily.py');
  
  logUpdate(`开始从 Twelve Data 获取数据`, symbol);
  
  const result = await new Promise<{ success: boolean; data?: any; message?: string }>((resolve) => {
    exec(`/usr/bin/python3 "${scriptPath}" ${symbol} --source twelvedata`, (error, stdout, stderr) => {
      if (error) {
        const errorMsg = `获取数据失败: ${stderr || error.message}`;
        logUpdate(errorMsg, symbol);
        resolve({
          success: false,
          message: errorMsg
        });
        return;
      }
      try {
        const data = JSON.parse(stdout);
        if (data.success) {
          resolve({ success: true, data });
        } else {
          const errorMsg = data.message || 'Python脚本返回失败';
          logUpdate(errorMsg, symbol);
          resolve({ success: false, message: errorMsg });
        }
      } catch {
        const errorMsg = 'Python脚本返回无效响应';
        logUpdate(errorMsg, symbol);
        resolve({ success: false, message: errorMsg });
      }
    });
  });

  if (!result.success) {
    return { success: false, message: result.message || '获取数据失败', updated: false };
  }

  const data = result.data;
  
  let insertedCount = 0;
  let updatedCount = 0;
  
  for (const item of data.items) {
    const existing = await db.get(
      `SELECT 1 FROM financial_daily_prices 
       WHERE symbol = ? AND trade_date = ? AND source = 'twelvedata'`,
      [symbol, item.trade_date]
    );
    
    await db.run(
      `INSERT OR REPLACE INTO financial_daily_prices 
       (symbol, name, market, asset_type, trade_date, open, high, low, close, volume, amount, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        symbol,
        data.name || '',
        'global',
        'metal_anchor',
        item.trade_date,
        item.open,
        item.high,
        item.low,
        item.close,
        item.volume,
        item.amount,
        'twelvedata'
      ]
    );
    
    if (existing) {
      updatedCount++;
    } else {
      insertedCount++;
    }
  }
  
  const statusMsg = `数据更新完成：新增 ${insertedCount} 条，更新 ${updatedCount} 条`;
  logUpdate(statusMsg, symbol);
  
  return { success: true, message: statusMsg, updated: true };
}

function calculateMetalRegime(prices: MetalDailyPrice[]): MetalRegime {
  const symbol = prices.length > 0 ? prices[0].trade_date ? prices[prices.length - 1].trade_date : '' : '';
  const latestPrice = prices[prices.length - 1];
  const close = latestPrice?.close || 0;
  const trade_date = latestPrice?.trade_date || '';
  const ruleVersion = 'metal_regime_v2.2';

  if (prices.length < 60) {
    return {
      symbol: '',
      trade_date,
      close,
      ma20: 0,
      ma60: 0,
      ma120: 0,
      ma250: 0,
      ma20_slope: 'unknown',
      ma60_prev: 0,
      ma120_prev: 0,
      ma250_prev: 0,
      ma60_slope: 'unknown',
      ma120_slope: 'unknown',
      ma250_slope: 'unknown',
      latest_change: null,
      distance_to_ma60: 0,
      distance_to_ma250: null,
      low_60: null,
      low_120: null,
      recent_return_5: null,
      recent_return_10: null,
      recent_return_20: null,
      drawdown_20: null,
      drawdown_60: null,
      drawdown_120: null,
      range_ratio_5: null,
      range_ratio_20: null,
      higher_low: false,
      higher_high: false,
      lower_low: false,
      lower_high: false,
      sideways: false,
      up_days: 0,
      down_days: 0,
      abnormal_move: false,
      above_ma60_days: 0,
      below_ma60_days: 0,
      short_state: 'UNKNOWN',
      short_label: '短期未确认',
      short_reason: '历史数据不足，暂无法判断短期行为。',
      mid_state: 'UNKNOWN',
      mid_label: '中期未确认',
      mid_reason: '历史数据不足，暂无法判断中期结构。',
      long_state: 'UNKNOWN',
      long_label: '长期未确认',
      long_reason: '历史数据不足，暂无法判断长期牛熊。',
      cycle_state: 'UNKNOWN',
      cycle_label: '状态未确认',
      cycle_reason: '历史数据不足，暂无法判断大周期。',
      behavior_tags: [],
      state_code: 'UNKNOWN',
      state_reason: '历史数据不足60个交易日，暂无法判定状态。',
      entry_permission: 'OBSERVE_ONLY',
      entry_reason: '状态不明确，仅观察。',
      rule_version: ruleVersion,
      source: 'twelvedata'
    };
  }

  const last5Prices = prices.slice(-5);
  const last10Prices = prices.slice(-10);
  const prev10Prices = prices.slice(-20, -10);
  const last20Prices = prices.slice(-20);
  const prev20Prices = prices.slice(-40, -20);
  const last60Prices = prices.slice(-60);
  const prev60Prices = prices.slice(-61, -1);
  const last120Prices = prices.slice(-120);
  const prev120Prices = prices.slice(-121, -1);
  const last250Prices = prices.slice(-250);
  const prev250Prices = prices.slice(-251, -1);

  const ma20 = averageClose(last20Prices) || 0;
  const ma20_prev = averageClose(prices.slice(-21, -1)) || ma20;
  const ma60 = averageClose(last60Prices) || 0;
  const ma60_prev = averageClose(prev60Prices) || ma60;
  const ma120 = last120Prices.length >= 120 ? (averageClose(last120Prices) || 0) : 0;
  const ma120_prev = prev120Prices.length >= 120 ? (averageClose(prev120Prices) || ma120) : ma120;
  const ma250 = last250Prices.length >= 250 ? (averageClose(last250Prices) || 0) : 0;
  const ma250_prev = prev250Prices.length >= 250 ? (averageClose(prev250Prices) || ma250) : ma250;

  const getSlope = (current: number, previous: number): string => {
    if (!current || !previous) return 'unknown';
    if (current < previous * 0.999) return 'down';
    if (current > previous * 1.001) return 'up';
    return 'flat';
  };

  const ma20_slope = getSlope(ma20, ma20_prev);
  const ma60_slope = getSlope(ma60, ma60_prev);
  const ma120_slope = getSlope(ma120, ma120_prev);
  const ma250_slope = getSlope(ma250, ma250_prev);

  const low_10 = minLow(last10Prices);
  const high_10 = maxHigh(last10Prices);
  const prev_low_10 = minLow(prev10Prices);
  const prev_high_10 = maxHigh(prev10Prices);
  const prev_low_20 = minLow(prev20Prices);
  const low_20 = minLow(last20Prices);
  const high_20 = maxHigh(last20Prices);
  const low_60 = minLow(last60Prices);
  const low_120 = minLow(last120Prices);

  const previousClose = prices.length >= 2 ? Number(prices[prices.length - 2].close) : null;
  const latest_change = previousClose && previousClose > 0 ? close / previousClose - 1 : null;
  const recent_return_5 = getReturn(prices, 5);
  const recent_return_10 = getReturn(prices, 10);
  const recent_return_20 = getReturn(prices, 20);
  const drawdown_20 = recent_return_20;
  const drawdown_60 = getReturn(prices, 60);
  const drawdown_120 = getReturn(prices, 120);

  const range_ratio_5 = averageRangeRatio(last5Prices);
  const range_ratio_20 = averageRangeRatio(last20Prices);
  const distance_to_ma60 = ma60 > 0 ? (close - ma60) / ma60 : 0;
  const distance_to_ma250 = ma250 > 0 ? (close - ma250) / ma250 : null;
  const distance_to_ma20 = ma20 > 0 ? (close - ma20) / ma20 : 0;
  const latestLow = Number(latestPrice?.low ?? latestPrice?.close ?? 0);
  const channelRange20 = high_20 !== null && low_20 !== null && close > 0 ? (high_20 - low_20) / close : null;

  const higher_low = Boolean(low_10 !== null && prev_low_10 !== null && low_10 > prev_low_10 * 1.005);
  const higher_high = Boolean(high_10 !== null && prev_high_10 !== null && high_10 > prev_high_10 * 1.005);
  const lower_low = Boolean(low_10 !== null && prev_low_10 !== null && low_10 < prev_low_10 * 0.995);
  const lower_high = Boolean(high_10 !== null && prev_high_10 !== null && high_10 < prev_high_10 * 0.995);
  const noNewLow = Boolean(low_10 !== null && prev_low_20 !== null && low_10 >= prev_low_20 * 0.995);
  const volatilityExpanding = Boolean(
    range_ratio_5 !== null &&
    range_ratio_20 !== null &&
    range_ratio_5 > range_ratio_20 * 1.35 &&
    range_ratio_5 > 0.018
  );
  const volatilityContracting = Boolean(
    range_ratio_5 !== null &&
    range_ratio_20 !== null &&
    range_ratio_5 < range_ratio_20 * 0.9
  );
  const upDays = countConsecutiveMove(prices, 'up');
  const downDays = countConsecutiveMove(prices, 'down');
  const largeUpDays5 = countLargeMove(prices, 5, 0.025, 'up');
  const largeDownDays5 = countLargeMove(prices, 5, 0.025, 'down');
  const consecutiveBreakLow = Boolean(low_10 !== null && prev_low_20 !== null && low_10 < prev_low_20 * 0.99 && close < ma60);
  const reboundFromLow = Boolean(low_60 !== null && low_60 > 0 && close / low_60 - 1 >= 0.025);
  const sideways = Boolean(
    channelRange20 !== null &&
    channelRange20 <= 0.055 &&
    recent_return_20 !== null &&
    Math.abs(recent_return_20) <= 0.025 &&
    !higher_high &&
    !lower_low
  );
  const abnormal_move = volatilityExpanding || largeUpDays5 >= 2 || largeDownDays5 >= 2;

  const getMA60At = (index: number): number | null => {
    if (index < 59) return null;
    const slice = prices.slice(index - 59, index + 1);
    return slice.reduce((sum, p) => sum + p.close, 0) / 60;
  };

  let above_ma60_days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA60 = getMA60At(i);
    if (dayMA60 === null) break;
    if (prices[i].close > dayMA60) {
      above_ma60_days++;
    } else {
      break;
    }
  }

  let below_ma60_days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA60 = getMA60At(i);
    if (dayMA60 === null) break;
    if (prices[i].close < dayMA60) {
      below_ma60_days++;
    } else {
      break;
    }
  }

  const getMA250At = (index: number): number | null => {
    if (index < 249) return null;
    const slice = prices.slice(index - 249, index + 1);
    return averageClose(slice);
  };

  let above_ma250_days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA250 = getMA250At(i);
    if (dayMA250 === null) break;
    if (Number(prices[i].close) > dayMA250) {
      above_ma250_days++;
    } else {
      break;
    }
  }

  let below_ma250_days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA250 = getMA250At(i);
    if (dayMA250 === null) break;
    if (Number(prices[i].close) < dayMA250) {
      below_ma250_days++;
    } else {
      break;
    }
  }

  const ma250_60ago = prices.length >= 310 ? getMA250At(prices.length - 61) : null;
  const ma250_slope_60 = ma250 > 0 && ma250_60ago && ma250_60ago > 0 ? ma250 / ma250_60ago - 1 : null;
  const ma250_long_slope =
    ma250_slope_60 === null ? 'unknown' :
    ma250_slope_60 >= 0.01 ? 'up' :
    ma250_slope_60 <= -0.01 ? 'down' :
    'flat';

  let state_code = 'UNKNOWN';
  let state_reason = '当前数据暂不足以命中明确状态，暂列为状态未确认。';
  let entry_permission = 'OBSERVE_ONLY';
  let entry_reason = '状态不明确，仅观察，不做主动动作。';

  const isOverheat = close > ma60 && (
    distance_to_ma60 >= 0.10 ||
    (recent_return_10 !== null && recent_return_10 >= 0.08) ||
    (recent_return_20 !== null && recent_return_20 >= 0.14) ||
    largeUpDays5 >= 3 ||
    (upDays >= 5 && distance_to_ma60 >= 0.07)
  );
  const isRiskBackdrop = close < ma60 || ma60_slope === 'down' || below_ma60_days >= 3;
  const isHardRisk = (
    (close < ma60 && ma60_slope === 'down') ||
    below_ma60_days >= 3 ||
    consecutiveBreakLow ||
    largeDownDays5 >= 2 ||
    distance_to_ma60 <= -0.06 ||
    (drawdown_20 !== null && drawdown_20 <= -0.08) ||
    (drawdown_60 !== null && drawdown_60 <= -0.12)
  );
  const isRebound = isRiskBackdrop &&
    reboundFromLow &&
    (recent_return_5 !== null && recent_return_5 > 0.015) &&
    !(higher_low && higher_high && close > ma60 && ma60_slope !== 'down');
  const isLowRange = !isHardRisk &&
    close <= ma60 * 1.02 &&
    noNewLow &&
    !volatilityExpanding &&
    (low_60 !== null && low_60 > 0 && (close - low_60) / close <= 0.08);
  const isRepairWatch = noNewLow &&
    (higher_low || volatilityContracting) &&
    (close >= ma20 || Math.abs(distance_to_ma60) <= 0.035) &&
    !volatilityExpanding &&
    !(higher_low && higher_high && close > ma60 && ma60_slope !== 'down');
  const isStructureForming = higher_low &&
    (higher_high || close > ma20) &&
    ma20_slope !== 'down' &&
    !volatilityExpanding;
  const isStructureEstablished = isStructureForming &&
    close > ma60 &&
    ma60_slope !== 'down' &&
    above_ma60_days >= 3;
  const isSafeCandidate = isStructureEstablished &&
    distance_to_ma60 >= -0.005 &&
    distance_to_ma60 <= 0.055 &&
    latestLow >= ma60 * 0.985 &&
    !volatilityExpanding;
  const isSafeConfirmed = isSafeCandidate &&
    close >= ma20 &&
    ma20_slope !== 'down' &&
    above_ma60_days >= 5 &&
    (recent_return_5 === null || recent_return_5 >= -0.015);
  const isTrend = close > ma60 &&
    ma60_slope === 'up' &&
    above_ma60_days >= 8 &&
    higher_low &&
    (higher_high || distance_to_ma20 >= 0) &&
    !isOverheat;

  if (isOverheat) {
    state_code = 'OVERHEAT';
    state_reason = `情绪过热区：价格明显偏离MA60（${(distance_to_ma60 * 100).toFixed(2)}%）或短期连续大涨，有仓减仓/降速，无仓不追。`;
    entry_permission = 'NO_CHASE';
    entry_reason = '情绪过热，禁止冲动追涨；有仓只按纪律处理，空仓等待回踩。';
  } else if (isRebound) {
    state_code = 'REBOUND';
    state_reason = '反抽区：暴跌或风险背景后出现反弹，但低点/高点抬高结构尚未完整形成，反抽不等于止跌。';
    entry_permission = 'OBSERVE_ONLY';
    entry_reason = '只观察反抽质量，不把反弹当成安全区。';
  } else if (isHardRisk) {
    state_code = 'RISK';
    state_reason = '风险区：价格跌破MA60、MA60下行或连续破低/放大波动，不抄底，等待结构重建。';
    entry_permission = 'FREEZE';
    entry_reason = '不抄底，不接飞刀，等待低点不再破、波动收敛和结构重建。';
  } else if (isSafeConfirmed) {
    state_code = 'SAFE_CONFIRMED';
    state_reason = '安全区确认：结构成立后的回踩未破MA60，价格重新站稳MA20/MA60，波动未失控。';
    entry_permission = 'ALLOW_SYSTEM_CONSIDER';
    entry_reason = '允许按体系考虑，但仍需人工确认与仓位纪律；不是自动买入。';
  } else if (isSafeCandidate) {
    state_code = 'SAFE_CANDIDATE';
    state_reason = '安全区候选：结构成立后回踩不破，位置接近MA60，等待重新站稳确认。';
    entry_permission = 'WAIT_SAFE_CONFIRM';
    entry_reason = '只做安全区候选观察，等收盘确认，不盘中冲动。';
  } else if (isTrend) {
    state_code = 'TREND';
    state_reason = '趋势运行区：价格在MA60上方，MA60上行，高低点持续抬高；有仓按趋势纪律，空仓等回踩。';
    entry_permission = 'HOLD_OR_WAIT_PULLBACK';
    entry_reason = '趋势运行不等于追涨买入，等待安全区或回踩确认。';
  } else if (isStructureForming) {
    state_code = 'STRUCTURE_FORMING';
    state_reason = '结构初成区：低点抬高，高点或短均线结构开始改善，但仍需回踩与安全区确认。';
    entry_permission = 'WATCH_STRUCTURE';
    entry_reason = '结构开始形成，继续观察，不提前替系统开绿灯。';
  } else if (isRepairWatch) {
    state_code = 'REPAIR_WATCH';
    state_reason = '修复观察区：不再明显创新低，波动收敛或低点抬高，继续观察结构能否真正成立。';
    entry_permission = 'WATCH_FOR_REPAIR';
    entry_reason = '修复观察，不等于可以买；等待结构成立和安全区。';
  } else if (isLowRange) {
    state_code = 'LOW_RANGE';
    state_reason = '低位震荡区：价格在低位横住，暂未继续破位，但方向仍未确认。';
    entry_permission = 'OBSERVE_ONLY';
    entry_reason = '低位横住先观察，不能把横盘当成安全区。';
  }

  const behavior_tags: MetalBehaviorTag[] = [];
  const addTag = (code: string, label: string, tone: MetalBehaviorTag['tone'], reason: string) => {
    behavior_tags.push({ code, label, tone, reason });
  };

  const isSlowGrindUp = Boolean(
    close > ma20 &&
    ma20_slope !== 'down' &&
    higher_low &&
    recent_return_20 !== null &&
    recent_return_20 >= 0.025 &&
    recent_return_20 <= 0.10 &&
    largeUpDays5 === 0 &&
    !volatilityExpanding
  );
  const isSlowBleed = Boolean(
    (close < ma20 || close < ma60) &&
    lower_high &&
    recent_return_20 !== null &&
    recent_return_20 <= -0.025 &&
    recent_return_20 >= -0.10 &&
    largeDownDays5 === 0 &&
    !volatilityExpanding
  );

  if (latest_change !== null && latest_change >= 0.025) addTag('SURGE_DAY', '暴涨', 'warn', `单日涨幅 ${(latest_change * 100).toFixed(2)}%，情绪偏热。`);
  if (latest_change !== null && latest_change <= -0.025) addTag('CRASH_DAY', '暴跌', 'risk', `单日跌幅 ${(latest_change * 100).toFixed(2)}%，禁止冲动接飞刀。`);
  if (recent_return_5 !== null && recent_return_5 >= 0.06) addTag('FAST_UP_5D', '5日急涨', 'warn', `近5日涨幅 ${(recent_return_5 * 100).toFixed(2)}%，防追高。`);
  if (recent_return_5 !== null && recent_return_5 <= -0.06) addTag('FAST_DOWN_5D', '5日急跌', 'risk', `近5日跌幅 ${(recent_return_5 * 100).toFixed(2)}%，等待止跌结构。`);
  if (isSlowGrindUp) addTag('SLOW_GRIND_UP', '慢涨', 'good', '沿均线温和上行，低点抬高，波动未放大。');
  if (isSlowBleed) addTag('SLOW_BLEED', '阴跌', 'risk', '价格缓慢走弱，反弹高度下降，且未出现单日暴跌。');
  if (upDays >= 3) addTag('CONSECUTIVE_UP', '连续上涨', 'warn', `收盘价连续上涨 ${upDays} 天，注意节奏降速。`);
  if (downDays >= 3) addTag('CONSECUTIVE_DOWN', '连续下跌', 'risk', `收盘价连续下跌 ${downDays} 天，等待企稳确认。`);
  if (sideways) addTag('SIDEWAYS', '横盘震荡', 'neutral', '20日区间收敛且收益接近横盘，方向未打开。');
  if (higher_high) addTag('HIGHER_HIGH', '高点抬高', 'good', '近10日高点高于前10日高点，价格上沿抬高。');
  if (higher_low) addTag('HIGHER_LOW', '低点抬高', 'good', '近10日低点高于前10日低点，结构下沿抬高。');
  if (lower_high) addTag('LOWER_HIGH', '高点抬低', 'risk', '近10日高点低于前10日高点，反弹高度下降。');
  if (lower_low) addTag('LOWER_LOW', '低点抬低', 'risk', '近10日低点低于前10日低点，结构下沿下移。');
  if (volatilityExpanding) addTag('VOL_EXPAND', '波动放大', 'warn', '近5日平均波动显著高于20日，情绪扰动变大。');
  if (volatilityContracting) addTag('VOL_CONTRACT', '波动收敛', 'neutral', '近5日平均波动低于20日，修复或横盘观察价值提升。');
  if (distance_to_ma60 >= 0.10) addTag('FAR_ABOVE_MA60', '偏离MA60过大', 'warn', `偏离MA60 ${(distance_to_ma60 * 100).toFixed(2)}%，无仓不追。`);
  if (distance_to_ma60 <= -0.06) addTag('FAR_BELOW_MA60', '跌离MA60较深', 'risk', `偏离MA60 ${(distance_to_ma60 * 100).toFixed(2)}%，不抄底。`);

  let short_state = 'NEUTRAL';
  let short_label = '短期平稳';
  let short_reason = '短期没有命中明显异常行为，继续观察。';
  if (latest_change !== null && latest_change <= -0.025) {
    short_state = 'CRASH_DAY';
    short_label = '短期暴跌';
    short_reason = `单日跌幅 ${(latest_change * 100).toFixed(2)}%，短期情绪偏风险。`;
  } else if (latest_change !== null && latest_change >= 0.025) {
    short_state = 'SURGE_DAY';
    short_label = '短期暴涨';
    short_reason = `单日涨幅 ${(latest_change * 100).toFixed(2)}%，短期情绪偏热。`;
  } else if (isSlowBleed) {
    short_state = 'SLOW_BLEED';
    short_label = '短期阴跌';
    short_reason = '近20日缓慢走弱，高点下降但没有单日暴跌。';
  } else if (isSlowGrindUp) {
    short_state = 'SLOW_GRIND_UP';
    short_label = '短期慢涨';
    short_reason = '近20日温和上行，低点抬高且波动未放大。';
  } else if (sideways) {
    short_state = 'SIDEWAYS';
    short_label = '短期横盘';
    short_reason = '20日区间和收益都较收敛，短期方向未打开。';
  } else if (upDays >= 3) {
    short_state = 'CONSECUTIVE_UP';
    short_label = '短期连续上涨';
    short_reason = `连续上涨 ${upDays} 天，注意节奏降速。`;
  } else if (downDays >= 3) {
    short_state = 'CONSECUTIVE_DOWN';
    short_label = '短期连续下跌';
    short_reason = `连续下跌 ${downDays} 天，等待企稳。`;
  }

  const mid_state = state_code;
  const mid_labelMap: Record<string, string> = {
    RISK: '中期风险区',
    REBOUND: '中期反抽区',
    LOW_RANGE: '中期低位震荡',
    REPAIR_WATCH: '中期修复观察',
    STRUCTURE_FORMING: '中期结构初成',
    SAFE_CANDIDATE: '中期安全区候选',
    SAFE_CONFIRMED: '中期安全区确认',
    TREND: '中期趋势运行',
    OVERHEAT: '中期情绪过热',
    UNKNOWN: '中期未确认'
  };
  const mid_label = mid_labelMap[state_code] || state_code;
  const mid_reason = state_reason;

  let long_state = 'LONG_UNKNOWN';
  let long_label = '长期未确认';
  let long_reason = 'MA250数据不足或长期方向尚不明确。';
  if (ma250 > 0) {
    const distanceText = distance_to_ma250 === null ? '--' : `${(distance_to_ma250 * 100).toFixed(2)}%`;
    const slopeText = ma250_long_slope === 'up' ? '上行' : ma250_long_slope === 'down' ? '下行' : ma250_long_slope === 'flat' ? '走平' : '未知';
    const longCyclePrices = getLongCyclePrices(prices);
    const cycleLowClose = minClosePrice(longCyclePrices);
    const cycleHighClose = maxClosePrice(longCyclePrices);
    const riseFromCycleLow = cycleLowClose && Number(cycleLowClose.close) > 0 ? close / Number(cycleLowClose.close) - 1 : null;
    const drawdownFromCycleHigh = cycleHighClose && Number(cycleHighClose.close) > 0 ? close / Number(cycleHighClose.close) - 1 : null;
    const bullConfirmLine = cycleLowClose && Number(cycleLowClose.close) > 0 ? Number(cycleLowClose.close) * 1.20 : null;
    const bearConfirmLine = cycleHighClose && Number(cycleHighClose.close) > 0 ? Number(cycleHighClose.close) * 0.80 : null;
    const riseText = riseFromCycleLow === null ? '--' : `${(riseFromCycleLow * 100).toFixed(2)}%`;
    const drawdownText = drawdownFromCycleHigh === null ? '--' : `${(drawdownFromCycleHigh * 100).toFixed(2)}%`;
    const cycleLowText = cycleLowClose ? `${cycleLowClose.trade_date} ${Number(cycleLowClose.close).toFixed(2)}` : '--';
    const cycleHighText = cycleHighClose ? `${cycleHighClose.trade_date} ${Number(cycleHighClose.close).toFixed(2)}` : '--';
    const aboveBuffer = distance_to_ma250 !== null && distance_to_ma250 >= 0.02;
    const belowBuffer = distance_to_ma250 !== null && distance_to_ma250 <= -0.02;
    const marketBullMove = riseFromCycleLow !== null && riseFromCycleLow >= 0.20;
    const marketBearDrawdown = drawdownFromCycleHigh !== null && drawdownFromCycleHigh <= -0.20;
    const bullPullbackDrawdown = drawdownFromCycleHigh !== null && drawdownFromCycleHigh <= -0.10;
    const sustainedAbove = above_ma250_days >= 60;
    const sustainedBelow = below_ma250_days >= 60;
    let aboveBullConfirmDays = 0;
    if (bullConfirmLine !== null) {
      for (let i = prices.length - 1; i >= 0; i--) {
        if (Number(prices[i].close) >= bullConfirmLine) aboveBullConfirmDays++;
        else break;
      }
    }
    let belowBearConfirmDays = 0;
    if (bearConfirmLine !== null) {
      for (let i = prices.length - 1; i >= 0; i--) {
        if (Number(prices[i].close) <= bearConfirmLine) belowBearConfirmDays++;
        else break;
      }
    }
    const sustainedBullMove = aboveBullConfirmDays >= 42;
    const sustainedBearMove = belowBearConfirmDays >= 42;
    const confirmedBull = marketBullMove &&
      sustainedBullMove &&
      aboveBuffer &&
      sustainedAbove &&
      ma250_long_slope !== 'down' &&
      (ma120 === 0 || ma120_slope !== 'down') &&
      !marketBearDrawdown;
    const confirmedBear = marketBearDrawdown &&
      sustainedBearMove &&
      belowBuffer &&
      sustainedBelow &&
      ma250_long_slope === 'down' &&
      (ma120_slope === 'down' || lower_high || lower_low);
    const repairWatch = aboveBuffer &&
      above_ma250_days >= 20 &&
      ma250_long_slope !== 'down' &&
      (riseFromCycleLow === null || riseFromCycleLow >= 0.12) &&
      (higher_low || ma120_slope !== 'down');
    const weakenWatch = (
      (belowBuffer && below_ma250_days >= 20) ||
      (drawdownFromCycleHigh !== null && drawdownFromCycleHigh <= -0.12)
    ) &&
      ma250_long_slope !== 'up' &&
      (lower_high || lower_low || ma120_slope === 'down');

    if (confirmedBear) {
      long_state = 'LONG_BEAR';
      long_label = '长期熊市确认';
      long_reason = `从近3年高点 ${cycleHighText} 回撤 ${drawdownText}，20%熊市确认线下方已维持 ${belowBearConfirmDays} 天，价格在MA250下方且偏离 ${distanceText}，已连续跌破MA250 ${below_ma250_days} 天，MA250约60日斜率${slopeText}；满足长期熊市确认。`;
    } else if (confirmedBull && bullPullbackDrawdown) {
      long_state = 'LONG_BULL_PULLBACK';
      long_label = '长期牛市回撤';
      long_reason = `长期牛市背景仍在：从近3年低点 ${cycleLowText} 上涨 ${riseText}，20%牛市确认线上方已维持 ${aboveBullConfirmDays} 天，已连续站上MA250 ${above_ma250_days} 天，MA250约60日斜率${slopeText}；但从近3年高点 ${cycleHighText} 回撤 ${drawdownText}，当前按牛市中的中期回撤处理。`;
    } else if (confirmedBull) {
      long_state = 'LONG_BULL';
      long_label = '长期牛市确认';
      long_reason = `从近3年低点 ${cycleLowText} 上涨 ${riseText}，20%牛市确认线上方已维持 ${aboveBullConfirmDays} 天，价格在MA250上方且偏离 ${distanceText}，已连续站上MA250 ${above_ma250_days} 天，MA250约60日斜率${slopeText}；满足20%上涨和持续性条件，按长期牛市确认。`;
    } else if (repairWatch) {
      long_state = 'LONG_BEAR_TO_BULL';
      long_label = '长期转强观察';
      long_reason = `价格重新站上MA250并偏离 ${distanceText}，已连续站上 ${above_ma250_days} 天，从近3年低点 ${cycleLowText} 上涨 ${riseText}，MA250约60日斜率${slopeText}；先记为转强观察，等20%上涨和持续性条件都满足后再确认长期牛市。`;
    } else if (weakenWatch) {
      long_state = 'LONG_BULL_TO_BEAR';
      long_label = '长期转弱观察';
      long_reason = `从近3年高点 ${cycleHighText} 回撤 ${drawdownText}，价格相对MA250偏离 ${distanceText}，已连续跌破MA250 ${below_ma250_days} 天，MA250约60日斜率${slopeText}；先记为转弱观察，不把中期回撤直接等同长期熊市。`;
    } else if (close > ma250 && ma250_long_slope !== 'down') {
      long_state = 'LONG_BULL_PULLBACK';
      long_label = '长期多头背景';
      long_reason = `价格仍在MA250上方，当前偏离 ${distanceText}，MA250约60日斜率${slopeText}；但从近3年低点涨幅 ${riseText}、站上天数或持续性条件尚未完全满足，先按长期多头背景观察，不直接喊长期牛市。`;
    } else {
      long_state = 'LONG_TRANSITION';
      long_label = '长期均线争夺';
      long_reason = `价格在MA250附近或长期斜率未确认，当前偏离 ${distanceText}，不把MA250附近来回穿越直接判成牛熊转换。`;
    }
  }

  const cycle_state = long_state;
  const cycle_label = long_label;
  const cycle_reason = long_reason;

  return {
    symbol: '',
    trade_date,
    close: Math.round(close * 100) / 100,
    ma20: Math.round(ma20 * 100) / 100,
    ma60: Math.round(ma60 * 100) / 100,
    ma120: Math.round(ma120 * 100) / 100,
    ma250: Math.round(ma250 * 100) / 100,
    ma20_slope,
    ma60_prev: Math.round(ma60_prev * 100) / 100,
    ma120_prev: Math.round(ma120_prev * 100) / 100,
    ma250_prev: Math.round(ma250_prev * 100) / 100,
    ma60_slope,
    ma120_slope,
    ma250_slope,
    latest_change: roundNumber(latest_change, 4),
    distance_to_ma60: Math.round(distance_to_ma60 * 10000) / 10000,
    distance_to_ma250: roundNumber(distance_to_ma250, 4),
    low_60: roundNumber(low_60, 2),
    low_120: roundNumber(low_120, 2),
    recent_return_5: roundNumber(recent_return_5, 4),
    recent_return_10: roundNumber(recent_return_10, 4),
    recent_return_20: roundNumber(recent_return_20, 4),
    drawdown_20: roundNumber(drawdown_20, 4),
    drawdown_60: roundNumber(drawdown_60, 4),
    drawdown_120: roundNumber(drawdown_120, 4),
    range_ratio_5: roundNumber(range_ratio_5, 4),
    range_ratio_20: roundNumber(range_ratio_20, 4),
    higher_low,
    higher_high,
    lower_low,
    lower_high,
    sideways,
    up_days: upDays,
    down_days: downDays,
    abnormal_move,
    above_ma60_days,
    below_ma60_days,
    short_state,
    short_label,
    short_reason,
    mid_state,
    mid_label,
    mid_reason,
    long_state,
    long_label,
    long_reason,
    cycle_state,
    cycle_label,
    cycle_reason,
    behavior_tags,
    state_code,
    state_reason,
    entry_permission,
    entry_reason,
    rule_version: ruleVersion,
    source: 'twelvedata'
  };
}

router.post('/update', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.body.symbol;
    const forceUpdate = req.body.force_update || false;

    if (!symbol || !['XAUUSD', 'XAGUSD'].includes(symbol)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid symbol. Must be XAUUSD or XAGUSD'
      });
    }

    if (symbol === 'XAGUSD') {
      return res.status(403).json({
        success: false,
        message: '当前数据源权限不足，XAGUSD 暂不可用'
      });
    }

    logUpdate(`收到贵金属更新请求: ${symbol}`, symbol);

    const updateResult = await fetchAndUpdateMetalData(db, symbol, forceUpdate);
    
    if (!updateResult.success) {
      return res.status(500).json({
        success: false,
        message: updateResult.message
      });
    }

    const statusResult = await db.all(
      `SELECT COUNT(*) as total_count, 
              MIN(trade_date) as first_trade_date, 
              MAX(trade_date) as last_trade_date,
              MAX(updated_at) as last_updated
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = 'twelvedata'`,
      [symbol]
    );

    const status = statusResult[0] || {};

    res.json({
      success: true,
      message: updateResult.updated ? updateResult.message : '距离上次更新不足60秒，已返回本地最新结果。',
      data: {
        symbol,
        source: 'twelvedata',
        total_count: status.total_count || 0,
        first_trade_date: status.first_trade_date || null,
        last_trade_date: status.last_trade_date || null,
        last_updated: status.last_updated || null
      }
    });
  } catch (error) {
    logUpdate(`更新失败: ${(error as Error).message}`, req.body.symbol);
    console.error('Error updating metal data:', error);
    res.status(500).json({
      success: false,
      message: `更新失败: ${(error as Error).message}`
    });
  }
});

router.get('/data-status', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.query.symbol as string;

    if (!symbol || !['XAUUSD', 'XAGUSD'].includes(symbol)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid symbol. Must be XAUUSD or XAGUSD'
      });
    }

    logRead(`获取贵金属数据状态: ${symbol}`, symbol);

    const result = await db.get(
      `SELECT COUNT(*) as total_count, 
              MIN(trade_date) as first_trade_date, 
              MAX(trade_date) as last_trade_date,
              MAX(updated_at) as last_updated
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = 'twelvedata'`,
      [symbol]
    );

    const totalCount = result?.total_count || 0;

    res.json({
      success: true,
      data: {
        symbol,
        source: 'twelvedata',
        total_count: totalCount,
        first_trade_date: result?.first_trade_date || null,
        last_trade_date: result?.last_trade_date || null,
        last_updated: result?.last_updated || null,
        has_enough_60: totalCount >= 60,
        has_enough_120: totalCount >= 120
      }
    });
  } catch (error) {
    logRead(`获取状态失败: ${(error as Error).message}`, req.query.symbol as string);
    console.error('Error getting metal data status:', error);
    res.status(500).json({
      success: false,
      message: `获取状态失败: ${(error as Error).message}`
    });
  }
});

router.get('/daily-prices', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.query.symbol as string;
    const limit = parseInt(req.query.limit as string) || 120;

    if (!symbol || !['XAUUSD', 'XAGUSD'].includes(symbol)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid symbol. Must be XAUUSD or XAGUSD'
      });
    }

    logRead(`获取贵金属日线数据: ${symbol} limit=${limit}`, symbol);

    const prices = await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount 
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = 'twelvedata' 
       ORDER BY trade_date DESC 
       LIMIT ?`,
      [symbol, limit]
    );

    res.json({
      success: true,
      data: {
        symbol,
        source: 'twelvedata',
        items: prices.reverse()
      }
    });
  } catch (error) {
    logRead(`获取日线数据失败: ${(error as Error).message}`, req.query.symbol as string);
    console.error('Error getting metal daily prices:', error);
    res.status(500).json({
      success: false,
      message: `获取日线数据失败: ${(error as Error).message}`
    });
  }
});

router.get('/regime/latest', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.query.symbol as string;

    if (!symbol || !['XAUUSD', 'XAGUSD'].includes(symbol)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid symbol. Must be XAUUSD or XAGUSD'
      });
    }

    logRead(`获取贵金属最新状态: ${symbol}`, symbol);

    const prices = await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount 
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = 'twelvedata' 
       ORDER BY trade_date ASC`,
      [symbol]
    );

    if (prices.length === 0) {
      return res.json({
        success: true,
        data: {
          symbol,
          message: '暂无数据，请先更新日线数据',
          state_code: 'UNKNOWN',
          source: 'twelvedata'
        }
      });
    }

    const regime = calculateMetalRegime(prices);
    
    res.json({
      success: true,
      data: {
        symbol,
        trade_date: regime.trade_date,
        close: regime.close,
        ma20: regime.ma20,
        ma60: regime.ma60,
        ma120: regime.ma120,
        ma250: regime.ma250,
        ma20_slope: regime.ma20_slope,
        ma60_prev: regime.ma60_prev,
        ma120_prev: regime.ma120_prev,
        ma250_prev: regime.ma250_prev,
        ma60_slope: regime.ma60_slope,
        ma120_slope: regime.ma120_slope,
        ma250_slope: regime.ma250_slope,
        latest_change: regime.latest_change,
        distance_to_ma60: regime.distance_to_ma60,
        distance_to_ma250: regime.distance_to_ma250,
        low_60: regime.low_60,
        low_120: regime.low_120,
        recent_return_5: regime.recent_return_5,
        recent_return_10: regime.recent_return_10,
        recent_return_20: regime.recent_return_20,
        drawdown_20: regime.drawdown_20,
        drawdown_60: regime.drawdown_60,
        drawdown_120: regime.drawdown_120,
        range_ratio_5: regime.range_ratio_5,
        range_ratio_20: regime.range_ratio_20,
        higher_low: regime.higher_low,
        higher_high: regime.higher_high,
        lower_low: regime.lower_low,
        lower_high: regime.lower_high,
        sideways: regime.sideways,
        up_days: regime.up_days,
        down_days: regime.down_days,
        abnormal_move: regime.abnormal_move,
        above_ma60_days: regime.above_ma60_days,
        below_ma60_days: regime.below_ma60_days,
        short_state: regime.short_state,
        short_label: regime.short_label,
        short_reason: regime.short_reason,
        mid_state: regime.mid_state,
        mid_label: regime.mid_label,
        mid_reason: regime.mid_reason,
        long_state: regime.long_state,
        long_label: regime.long_label,
        long_reason: regime.long_reason,
        cycle_state: regime.cycle_state,
        cycle_label: regime.cycle_label,
        cycle_reason: regime.cycle_reason,
        behavior_tags: regime.behavior_tags,
        state_code: regime.state_code,
        state_reason: regime.state_reason,
        entry_permission: regime.entry_permission,
        entry_reason: regime.entry_reason,
        rule_version: regime.rule_version,
        source: regime.source
      }
    });
  } catch (error) {
    logRead(`获取状态失败: ${(error as Error).message}`, req.query.symbol as string);
    console.error('Error getting metal regime:', error);
    res.status(500).json({
      success: false,
      message: `获取状态失败: ${(error as Error).message}`
    });
  }
});

router.post('/regime/backtest', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.body.symbol;
    const startDate = req.body.start_date;
    const endDate = req.body.end_date || new Date().toISOString().split('T')[0];

    if (!symbol || !['XAUUSD', 'XAGUSD'].includes(symbol)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid symbol. Must be XAUUSD or XAGUSD'
      });
    }

    if (!startDate) {
      return res.status(400).json({
        success: false,
        message: 'start_date is required'
      });
    }

    logRead(`贵金属历史回放: ${symbol} ${startDate} - ${endDate}`, symbol);

    const allPrices = await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount 
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = 'twelvedata' 
       ORDER BY trade_date ASC`,
      [symbol]
    );

    if (allPrices.length < 60) {
      return res.status(400).json({
        success: false,
        message: `本地数据不足（当前${allPrices.length}条），需要至少60条数据。`
      });
    }

    const filteredPrices = allPrices.filter(p => p.trade_date >= startDate && p.trade_date <= endDate);

    if (filteredPrices.length === 0) {
      return res.status(400).json({
        success: false,
        message: `指定日期范围[${startDate}至${endDate}]内没有数据。`
      });
    }

    const resultItems: any[] = [];
    const summary: any = METAL_STATE_CODES.reduce((acc: any, code) => {
      acc[code] = 0;
      return acc;
    }, {});
    const shortSummary: Record<string, number> = {};
    const midSummary: Record<string, number> = {};
    const longSummary: Record<string, number> = {};
    const cycleSummary = longSummary;

    for (const filteredPrice of filteredPrices) {
      const currentIndex = allPrices.findIndex(p => p.trade_date === filteredPrice.trade_date);
      if (currentIndex === -1) continue;

      const historyPrices = allPrices.slice(0, currentIndex + 1);
      const regime = calculateMetalRegime(historyPrices);

      resultItems.push({
        trade_date: regime.trade_date,
        close: regime.close,
        ma20: regime.ma20,
        ma60: regime.ma60,
        ma120: regime.ma120,
        ma250: regime.ma250,
        ma20_slope: regime.ma20_slope,
        ma60_slope: regime.ma60_slope,
        ma120_slope: regime.ma120_slope,
        ma250_slope: regime.ma250_slope,
        latest_change: regime.latest_change,
        distance_to_ma60: regime.distance_to_ma60,
        distance_to_ma250: regime.distance_to_ma250,
        recent_return_5: regime.recent_return_5,
        recent_return_10: regime.recent_return_10,
        recent_return_20: regime.recent_return_20,
        drawdown_20: regime.drawdown_20,
        drawdown_60: regime.drawdown_60,
        drawdown_120: regime.drawdown_120,
        range_ratio_5: regime.range_ratio_5,
        range_ratio_20: regime.range_ratio_20,
        higher_low: regime.higher_low,
        higher_high: regime.higher_high,
        lower_low: regime.lower_low,
        lower_high: regime.lower_high,
        sideways: regime.sideways,
        up_days: regime.up_days,
        down_days: regime.down_days,
        abnormal_move: regime.abnormal_move,
        above_ma60_days: regime.above_ma60_days,
        below_ma60_days: regime.below_ma60_days,
        short_state: regime.short_state,
        short_label: regime.short_label,
        short_reason: regime.short_reason,
        mid_state: regime.mid_state,
        mid_label: regime.mid_label,
        mid_reason: regime.mid_reason,
        long_state: regime.long_state,
        long_label: regime.long_label,
        long_reason: regime.long_reason,
        cycle_state: regime.cycle_state,
        cycle_label: regime.cycle_label,
        cycle_reason: regime.cycle_reason,
        behavior_tags: regime.behavior_tags,
        state_code: regime.state_code,
        state_reason: regime.state_reason,
        entry_permission: regime.entry_permission,
        entry_reason: regime.entry_reason
      });

      if (summary[regime.state_code] !== undefined) {
        summary[regime.state_code]++;
      }
      shortSummary[regime.short_state] = (shortSummary[regime.short_state] || 0) + 1;
      midSummary[regime.mid_state] = (midSummary[regime.mid_state] || 0) + 1;
      longSummary[regime.long_state] = (longSummary[regime.long_state] || 0) + 1;
    }

    res.json({
      success: true,
      data: {
        symbol,
        rule_version: 'metal_regime_v2.2',
        start_date: startDate,
        end_date: endDate,
        summary,
        short_summary: shortSummary,
        mid_summary: midSummary,
        long_summary: longSummary,
        cycle_summary: cycleSummary,
        items: resultItems
      }
    });
  } catch (error) {
    logRead(`历史回放失败: ${(error as Error).message}`, req.body.symbol);
    console.error('Error running metal backtest:', error);
    res.status(500).json({
      success: false,
      message: `回测失败: ${(error as Error).message}`
    });
  }
});

export default router;
