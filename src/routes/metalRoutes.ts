import express, { Request, Response } from 'express';
import { exec, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import getDb, { getDatabasePath } from '../config/database';

const router = express.Router();
const metalTrainingRoot = process.env.MODEL_TRAINING_ROOT || '/Volumes/7100/model-training';
const metalTrainingPython = process.env.MODEL_TRAINING_PYTHON || path.join(metalTrainingRoot, 'venv', 'bin', 'python');
const preciousMetalTrainingRoot = path.join(metalTrainingRoot, 'precious-metals');

export interface MetalDailyPrice {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  amount: number | null;
}

export interface MetalBehaviorTag {
  code: string;
  label: string;
  tone: 'good' | 'warn' | 'risk' | 'neutral';
  reason: string;
}

export interface MetalRegime {
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
  state_continuation_days?: number;
  safe_confirmation_days?: number;
  safe_zone_days?: number;
  signal_maturity?: string;
  signal_maturity_label?: string;
  signal_maturity_reason?: string;
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

function isValidMetalTradingDate(tradeDate?: string | null): boolean {
  const match = String(tradeDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match;
  const weekday = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

export function filterMetalTradingPrices(prices: MetalDailyPrice[]): MetalDailyPrice[] {
  return prices.filter((price) => isValidMetalTradingDate(price.trade_date));
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

const SAFE_ZONE_STATES = new Set(['SAFE_CANDIDATE', 'SAFE_CONFIRMED']);

function getSafeConfirmationMaturity(safeConfirmationDays: number, stateCode: string) {
  if (stateCode === 'SAFE_CANDIDATE') {
    return {
      signal_maturity: 'CANDIDATE',
      signal_maturity_label: '候选观察',
      signal_maturity_reason: '安全区候选只说明结构接近确认，仍要等收盘确认，不盘中冲动。'
    };
  }

  if (stateCode !== 'SAFE_CONFIRMED' || safeConfirmationDays <= 0) {
    return {
      signal_maturity: 'NOT_CONFIRMED',
      signal_maturity_label: '未确认',
      signal_maturity_reason: '当前还不是安全区确认，不抄底、不接飞刀，等待低点不再破、波动收敛和结构重建。'
    };
  }

  if (safeConfirmationDays >= 10) {
    return {
      signal_maturity: 'STABLE_CONFIRMED',
      signal_maturity_label: '稳定确认',
      signal_maturity_reason: `安全区已连续确认 ${safeConfirmationDays} 天，信号存活时间较充分，但仍需仓位纪律。`
    };
  }

  if (safeConfirmationDays >= 5) {
    return {
      signal_maturity: 'EFFECTIVE_CONFIRMED',
      signal_maturity_label: '有效确认',
      signal_maturity_reason: `安全区已连续确认 ${safeConfirmationDays} 天，历史上比刚触发的信号更稳。`
    };
  }

  if (safeConfirmationDays >= 3) {
    return {
      signal_maturity: 'RECHECKING',
      signal_maturity_label: '复核中',
      signal_maturity_reason: `安全区已连续确认 ${safeConfirmationDays} 天，继续看能否活过 5 个收盘。`
    };
  }

  return {
    signal_maturity: 'NEW_CONFIRMED',
    signal_maturity_label: '新确认',
    signal_maturity_reason: `安全区刚确认 ${safeConfirmationDays} 天，先观察，不急于把刚触发当强信号。`
  };
}

export const METAL_ASSETS: Record<string, {
  symbol: string;
  name: string;
  market: string;
  source: string;
  dataSourceLabel: string;
}> = {
  XAUUSD: {
    symbol: 'XAUUSD',
    name: 'Gold Spot',
    market: 'global',
    source: 'twelvedata',
    dataSourceLabel: 'Twelve Data'
  },
  SGE_AGTD: {
    symbol: 'SGE_AGTD',
    name: '白银延期 Ag(T+D)',
    market: 'sge',
    source: 'tushare_sge',
    dataSourceLabel: 'Tushare SGE'
  }
};

export function getMetalAsset(symbol?: string) {
  if (!symbol) return null;
  return METAL_ASSETS[symbol] || null;
}

function getSupportedMetalMessage() {
  return `Invalid symbol. Must be one of: ${Object.keys(METAL_ASSETS).join(', ')}`;
}

function getMetalTrainingDomain(symbol: string) {
  if (symbol === 'XAUUSD') return 'metal:gold';
  if (symbol === 'SGE_AGTD') return 'metal:silver';
  return `metal:${symbol.toLowerCase()}`;
}

function getMetalTrainingBoundary(symbol: string) {
  if (symbol === 'XAUUSD') {
    return {
      allowed: true,
      label: '黄金先训练',
      reason: '黄金作为贵金属主锚，先用完整信号样本训练存活、短命和回撤风险概率。'
    };
  }

  if (symbol === 'SGE_AGTD') {
    return {
      allowed: false,
      label: '白银先分层',
      reason: '白银先继续按黄金主锚分层：黄金通过后的白银信号、黄金未稳拦截样本和对照样本；主样本稳定后再训练。'
    };
  }

  return {
    allowed: false,
    label: '暂不支持',
    reason: '当前贵金属模型实验只支持黄金主锚训练。'
  };
}

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

function calculateMetalSignalContinuity(
  prices: MetalDailyPrice[],
  source: string,
  currentStateCode: string
) {
  const tradingPrices = filterMetalTradingPrices(prices);
  let stateContinuationDays = 0;
  let safeConfirmationDays = 0;
  let safeZoneDays = 0;
  let stateOpen = true;
  let confirmationOpen = true;
  let safeZoneOpen = true;

  for (let index = tradingPrices.length - 1; index >= 0; index--) {
    const regime = calculateMetalRegime(tradingPrices.slice(0, index + 1), source);
    const stateCode = regime.state_code;

    if (stateOpen && stateCode === currentStateCode) {
      stateContinuationDays += 1;
    } else {
      stateOpen = false;
    }

    if (confirmationOpen && stateCode === 'SAFE_CONFIRMED') {
      safeConfirmationDays += 1;
    } else {
      confirmationOpen = false;
    }

    if (safeZoneOpen && SAFE_ZONE_STATES.has(stateCode)) {
      safeZoneDays += 1;
    } else {
      safeZoneOpen = false;
    }

    if (!stateOpen && !confirmationOpen && !safeZoneOpen) break;
  }

  return {
    state_continuation_days: stateContinuationDays,
    safe_confirmation_days: safeConfirmationDays,
    safe_zone_days: safeZoneDays,
    ...getSafeConfirmationMaturity(safeConfirmationDays, currentStateCode)
  };
}

function isMetalSafeOrTrend(stateCode?: string) {
  return stateCode === 'SAFE_CONFIRMED' || stateCode === 'TREND';
}

function isMetalSignalCandidate(stateCode?: string) {
  return stateCode === 'STRUCTURE_FORMING' || stateCode === 'SAFE_CANDIDATE' || stateCode === 'SAFE_CONFIRMED' || stateCode === 'TREND';
}

function getFutureReturn(prices: MetalDailyPrice[], currentIndex: number, days: number): number | null {
  const currentClose = Number(prices[currentIndex]?.close);
  const futureClose = Number(prices[currentIndex + days]?.close);
  if (!Number.isFinite(currentClose) || currentClose <= 0 || !Number.isFinite(futureClose)) return null;
  return roundNumber(futureClose / currentClose - 1, 4);
}

function getFutureMaxDrawdown(prices: MetalDailyPrice[], currentIndex: number, days: number): number | null {
  const currentClose = Number(prices[currentIndex]?.close);
  if (!Number.isFinite(currentClose) || currentClose <= 0) return null;
  const futurePrices = prices.slice(currentIndex + 1, currentIndex + days + 1);
  if (!futurePrices.length) return null;
  const futureLow = minLow(futurePrices);
  return futureLow !== null ? roundNumber(futureLow / currentClose - 1, 4) : null;
}

function breaksRecentLow(prices: MetalDailyPrice[], currentIndex: number, horizonDays: number, lookbackDays: number): boolean | null {
  const history = prices.slice(Math.max(0, currentIndex - lookbackDays + 1), currentIndex + 1);
  const future = prices.slice(currentIndex + 1, currentIndex + horizonDays + 1);
  if (!history.length || future.length < Math.min(horizonDays, 1)) return null;
  const historyLow = minLow(history);
  const futureLow = minLow(future);
  if (historyLow === null || futureLow === null) return null;
  return futureLow < historyLow;
}

function classifyMetalRuleAction(
  regime: MetalRegime,
  safeConfirmationDays: number,
  goldGatePass: boolean,
  noFlyingKnifeBlocked: boolean
) {
  if (!goldGatePass) {
    return {
      rule_action: 'GOLD_GATE_BLOCK',
      rule_action_label: '黄金未稳，只记录',
      rule_action_reason: '白银信号必须先经过黄金主锚约束，黄金未稳定时不放行。'
    };
  }

  if (noFlyingKnifeBlocked) {
    return {
      rule_action: 'NO_FLYING_KNIFE',
      rule_action_label: '不接飞刀',
      rule_action_reason: '暴跌、低点下移或风险区信号只做样本，不把反抽当止跌。'
    };
  }

  if (safeConfirmationDays >= 5) {
    return {
      rule_action: 'EFFECTIVE_REVIEW',
      rule_action_label: '有效复核',
      rule_action_reason: '安全区连续确认达到 5 天，可作为高质量观察样本。'
    };
  }

  if (safeConfirmationDays >= 3) {
    return {
      rule_action: 'RECHECK',
      rule_action_label: '复核中',
      rule_action_reason: '安全区连续确认达到 3 天，继续观察能否活过 5 个收盘。'
    };
  }

  if (regime.state_code === 'SAFE_CONFIRMED') {
    return {
      rule_action: 'NEW_SIGNAL',
      rule_action_label: '新触发',
      rule_action_reason: '刚进入安全区确认，先观察，不直接当强信号。'
    };
  }

  if (regime.state_code === 'SAFE_CANDIDATE' || regime.state_code === 'STRUCTURE_FORMING') {
    return {
      rule_action: 'CANDIDATE_ONLY',
      rule_action_label: '候选观察',
      rule_action_reason: '结构接近确认，但还没有形成稳定安全区信号。'
    };
  }

  return {
    rule_action: 'RECORD_ONLY',
    rule_action_label: '仅记录',
    rule_action_reason: '当前没有形成可复核的贵金属规则信号。'
  };
}

function buildMetalRegimeTimeline(prices: MetalDailyPrice[], source: string) {
  const tradingPrices = filterMetalTradingPrices(prices);
  const items: Array<{
    index: number;
    price: MetalDailyPrice;
    regime: MetalRegime;
    state_continuation_days: number;
    safe_confirmation_days: number;
    safe_zone_days: number;
    signal_maturity: string;
    signal_maturity_label: string;
    signal_maturity_reason: string;
  }> = [];

  let previousStateCode = '';
  let stateContinuationDays = 0;
  let safeConfirmationDays = 0;
  let safeZoneDays = 0;

  for (let index = 0; index < tradingPrices.length; index++) {
    if (index < 59) continue;

    const historyPrices = tradingPrices.slice(0, index + 1);
    const regime = calculateMetalRegime(historyPrices, source);

    if (regime.state_code === previousStateCode) {
      stateContinuationDays += 1;
    } else {
      previousStateCode = regime.state_code;
      stateContinuationDays = 1;
    }

    safeConfirmationDays = regime.state_code === 'SAFE_CONFIRMED' ? safeConfirmationDays + 1 : 0;
    safeZoneDays = SAFE_ZONE_STATES.has(regime.state_code) ? safeZoneDays + 1 : 0;

    items.push({
      index,
      price: tradingPrices[index],
      regime,
      state_continuation_days: stateContinuationDays,
      safe_confirmation_days: safeConfirmationDays,
      safe_zone_days: safeZoneDays,
      ...getSafeConfirmationMaturity(safeConfirmationDays, regime.state_code)
    });
  }

  return items;
}

async function buildMetalRuleReplay(db: any, options: {
  symbol?: string;
  start_date?: string;
  end_date?: string;
  limit?: number | string;
}) {
  const symbol = options.symbol || 'SGE_AGTD';
  const asset = getMetalAsset(symbol);
  const requestedEndDate = options.end_date;
  const requestedStartDate = options.start_date;
  const maxItems = Math.min(Math.max(Number(options.limit || 360), 30), 1500);

  if (!asset) {
    throw new Error(getSupportedMetalMessage());
  }

  const allPrices: MetalDailyPrice[] = filterMetalTradingPrices(await db.all(
    `SELECT trade_date, open, high, low, close, volume, amount
     FROM financial_daily_prices
     WHERE symbol = ? AND source = ?
     ORDER BY trade_date ASC`,
    [symbol, asset.source]
  ));

  if (allPrices.length < 80) {
    throw new Error(`本地数据不足（当前${allPrices.length}条），需要至少80条数据。`);
  }

  const latestTradeDate = allPrices[allPrices.length - 1].trade_date;
  const defaultStartIndex = Math.max(0, allPrices.length - maxItems);
  const startDate = requestedStartDate || allPrices[defaultStartIndex].trade_date;
  const endDate = requestedEndDate || latestTradeDate;

  const timeline = buildMetalRegimeTimeline(allPrices, asset.source);
  const timelineByIndex = new Map(timeline.map(item => [item.index, item]));

  let goldTimelineByDate = new Map<string, ReturnType<typeof buildMetalRegimeTimeline>[number]>();
  if (symbol === 'SGE_AGTD') {
    const goldAsset = getMetalAsset('XAUUSD');
    const goldPrices: MetalDailyPrice[] = goldAsset ? filterMetalTradingPrices(await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount
       FROM financial_daily_prices
       WHERE symbol = ? AND source = ?
       ORDER BY trade_date ASC`,
      ['XAUUSD', goldAsset.source]
    )) : [];
    goldTimelineByDate = new Map(
      buildMetalRegimeTimeline(goldPrices, goldAsset?.source || 'twelvedata').map(item => [item.price.trade_date, item])
    );
  }

  const inRangeTimeline = timeline
    .filter(item => item.price.trade_date >= startDate && item.price.trade_date <= endDate)
    .slice(-maxItems);

  const items = inRangeTimeline.map((item) => {
    const regime = item.regime;
    const currentIndex = item.index;
    const future3 = timelineByIndex.get(currentIndex + 3)?.regime;
    const future5 = timelineByIndex.get(currentIndex + 5)?.regime;
    const future10 = timelineByIndex.get(currentIndex + 10)?.regime;
    const future20 = timelineByIndex.get(currentIndex + 20)?.regime;
    const breakLow3 = breaksRecentLow(allPrices, currentIndex, 3, 20);
    const breakLow5 = breaksRecentLow(allPrices, currentIndex, 5, 20);
    const breakLow20 = breaksRecentLow(allPrices, currentIndex, 20, 20);
    const goldTimeline = symbol === 'SGE_AGTD' ? goldTimelineByDate.get(item.price.trade_date) : item;
    const goldStateCode = goldTimeline?.regime.state_code || null;
    const goldGatePass = symbol !== 'SGE_AGTD' || isMetalSafeOrTrend(goldStateCode || undefined);
    const latestChange = regime.latest_change ?? 0;
    const noFlyingKnifeBlocked = regime.state_code === 'RISK'
      || (regime.abnormal_move && latestChange <= -0.04)
      || Boolean(regime.lower_low && (regime.drawdown_20 ?? 0) <= -0.06);
    const survived3d = future3 ? Boolean(isMetalSafeOrTrend(future3.state_code) && breakLow3 === false) : null;
    const survived5d = future5 ? Boolean(isMetalSafeOrTrend(future5.state_code) && breakLow5 === false) : null;
    const signalCandidate = isMetalSignalCandidate(regime.state_code);
    const shortLivedSignal = signalCandidate && survived5d === false;
    const action = classifyMetalRuleAction(regime, item.safe_confirmation_days, goldGatePass, noFlyingKnifeBlocked);

    return {
      symbol,
      asset_name: asset.name,
      source: asset.source,
      trade_date: regime.trade_date,
      close: regime.close,
      state_code: regime.state_code,
      state_label: METAL_STATE_CODES.includes(regime.state_code) ? regime.state_code : 'UNKNOWN',
      state_reason: regime.state_reason,
      short_label: regime.short_label,
      mid_label: regime.mid_label,
      long_label: regime.long_label,
      cycle_label: regime.cycle_label,
      distance_to_ma60: regime.distance_to_ma60,
      recent_return_5: regime.recent_return_5,
      recent_return_20: regime.recent_return_20,
      drawdown_20: regime.drawdown_20,
      range_ratio_5: regime.range_ratio_5,
      range_ratio_20: regime.range_ratio_20,
      lower_low: regime.lower_low,
      abnormal_move: regime.abnormal_move,
      behavior_tags: regime.behavior_tags,
      state_continuation_days: item.state_continuation_days,
      safe_confirmation_days: item.safe_confirmation_days,
      safe_zone_days: item.safe_zone_days,
      signal_maturity: item.signal_maturity,
      signal_maturity_label: item.signal_maturity_label,
      signal_maturity_reason: item.signal_maturity_reason,
      gold_gate_pass: goldGatePass,
      gold_state_code: goldStateCode,
      no_flying_knife_blocked: noFlyingKnifeBlocked,
      rule_signal: signalCandidate ? 'SIGNAL_CANDIDATE' : 'NO_SIGNAL',
      ...action,
      labels: {
        label_status: future20 ? 'complete' : future5 ? 'partial' : 'pending',
        future_return_3d: getFutureReturn(allPrices, currentIndex, 3),
        future_return_5d: getFutureReturn(allPrices, currentIndex, 5),
        future_return_10d: getFutureReturn(allPrices, currentIndex, 10),
        future_return_20d: getFutureReturn(allPrices, currentIndex, 20),
        future_max_drawdown_20d: getFutureMaxDrawdown(allPrices, currentIndex, 20),
        break_recent_low_20d: breakLow20,
        survived_3d: survived3d,
        survived_5d: survived5d,
        short_lived_signal: shortLivedSignal,
        future_state_3d: future3?.state_code || null,
        future_state_5d: future5?.state_code || null,
        future_state_10d: future10?.state_code || null,
        future_state_20d: future20?.state_code || null
      }
    };
  });

  const completeItems = items.filter(item => item.labels.label_status === 'complete');
  const safeConfirmedItems = items.filter(item => item.state_code === 'SAFE_CONFIRMED');
  const effectiveItems = items.filter(item => item.safe_confirmation_days >= 5);
  const return20Values = safeConfirmedItems
    .map(item => item.labels.future_return_20d)
    .filter((value): value is number => typeof value === 'number');

  return {
    symbol,
    asset_name: asset.name,
    source: asset.source,
    rule_version: 'metal_rule_lab_v0.1',
    start_date: startDate,
    end_date: endDate,
    no_lookahead_note: '规则信号只使用截面日及以前数据；未来收益、回撤、破低和存活状态仅作为后验标签。',
    summary: {
      total_samples: items.length,
      complete_label_count: completeItems.length,
      signal_candidate_count: items.filter(item => item.rule_signal === 'SIGNAL_CANDIDATE').length,
      safe_confirmed_count: safeConfirmedItems.length,
      effective_confirmed_count: effectiveItems.length,
      short_lived_count: items.filter(item => item.labels.short_lived_signal).length,
      no_flying_knife_block_count: items.filter(item => item.no_flying_knife_blocked).length,
      gold_gate_block_count: items.filter(item => !item.gold_gate_pass).length,
      avg_safe_confirmed_return_20d: return20Values.length ? roundNumber(average(return20Values), 4) : null
    },
    items
  };
}

function dbBool(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function toMetricNumber(value: any, digits = 4): number | null {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  return roundNumber(numericValue, digits);
}

function buildMetalSampleReadiness(row: any) {
  const totalSamples = Number(row.total_samples || 0);
  const completeLabels = Number(row.complete_label_count || 0);
  const signalCandidates = Number(row.signal_candidate_count || 0);
  const safeConfirmed = Number(row.safe_confirmed_count || 0);
  const effectiveConfirmed = Number(row.effective_confirmed_count || 0);
  const shortLivedSignals = Number(row.short_lived_count || 0);
  const goldGateBlocks = Number(row.gold_gate_block_count || 0);
  const completionRate = totalSamples ? completeLabels / totalSamples : 0;
  const shortLivedRate = signalCandidates ? shortLivedSignals / signalCandidates : 0;
  const goldGateBlockRate = totalSamples ? goldGateBlocks / totalSamples : 0;

  if (!totalSamples) {
    return {
      status: 'empty',
      label: '暂无样本',
      reason: '样本库还没有这个标的的回放样本，先跑规则回放并落库。'
    };
  }

  if (completeLabels < 300) {
    return {
      status: 'not_ready',
      label: '未达训练',
      reason: `后验完整样本只有 ${completeLabels} 条，先补历史到至少 300 条以上。`
    };
  }

  if (completionRate < 0.75) {
    return {
      status: 'not_ready',
      label: '标签不足',
      reason: `完整标签占比 ${(completionRate * 100).toFixed(1)}%，近期样本太多会缺少 20 日后验。`
    };
  }

  if (signalCandidates < 50) {
    return {
      status: 'not_ready',
      label: '信号太少',
      reason: `规则候选只有 ${signalCandidates} 条，模型会学不到有效信号和假信号边界。`
    };
  }

  if (safeConfirmed < 20) {
    return {
      status: 'watch',
      label: '仅可观察',
      reason: `安全确认样本只有 ${safeConfirmed} 条，可以先做规则复核，不适合正式训练。`
    };
  }

  if (effectiveConfirmed < 10) {
    return {
      status: 'watch',
      label: '等待稳定样本',
      reason: `连续确认 5 天以上的稳定样本只有 ${effectiveConfirmed} 条，先扩大回放区间。`
    };
  }

  const qualityWarnings: string[] = [];
  if (shortLivedRate >= 0.6) {
    qualityWarnings.push(`信号候选里短命占比 ${(shortLivedRate * 100).toFixed(1)}%`);
  }
  if (goldGateBlockRate >= 0.6) {
    qualityWarnings.push(`黄金主锚拦截占比 ${(goldGateBlockRate * 100).toFixed(1)}%`);
  }

  if (qualityWarnings.length) {
    return {
      status: 'watch',
      label: '先复核规则',
      reason: `${qualityWarnings.join('，')}，样本数量够，但需要先分层复核，避免模型只学到噪声或黄金拦截。`
    };
  }

  return {
    status: 'ready',
    label: '可做实验训练',
    reason: '样本数量、完整标签和有效信号已达到第一版实验门槛，仍需按年份切分验证。'
  };
}

function normalizeMetalHealthRow(row: any, actionBuckets: any[]) {
  const totalSamples = Number(row.total_samples || 0);
  const completeLabels = Number(row.complete_label_count || 0);
  const signalCandidates = Number(row.signal_candidate_count || 0);
  const shortLived = Number(row.short_lived_count || 0);

  return {
    symbol: row.symbol,
    asset_name: row.asset_name,
    source: row.source,
    start_date: row.start_date,
    end_date: row.end_date,
    latest_updated_at: row.latest_updated_at,
    total_samples: totalSamples,
    complete_label_count: completeLabels,
    partial_label_count: Number(row.partial_label_count || 0),
    pending_label_count: Number(row.pending_label_count || 0),
    completion_rate: totalSamples ? roundNumber(completeLabels / totalSamples, 4) : 0,
    signal_candidate_count: signalCandidates,
    safe_confirmed_count: Number(row.safe_confirmed_count || 0),
    effective_confirmed_count: Number(row.effective_confirmed_count || 0),
    short_lived_count: shortLived,
    short_lived_rate: signalCandidates ? roundNumber(shortLived / signalCandidates, 4) : 0,
    no_flying_knife_block_count: Number(row.no_flying_knife_block_count || 0),
    gold_gate_block_count: Number(row.gold_gate_block_count || 0),
    avg_return_20d: toMetricNumber(row.avg_return_20d),
    avg_drawdown_20d: toMetricNumber(row.avg_drawdown_20d),
    signal_avg_return_20d: signalCandidates ? toMetricNumber(row.signal_avg_return_20d) : null,
    signal_avg_drawdown_20d: signalCandidates ? toMetricNumber(row.signal_avg_drawdown_20d) : null,
    safe_confirmed_avg_return_20d: toMetricNumber(row.safe_confirmed_avg_return_20d),
    safe_confirmed_avg_drawdown_20d: toMetricNumber(row.safe_confirmed_avg_drawdown_20d),
    short_lived_avg_return_20d: toMetricNumber(row.short_lived_avg_return_20d),
    short_lived_avg_drawdown_20d: toMetricNumber(row.short_lived_avg_drawdown_20d),
    flying_knife_block_avg_return_20d: toMetricNumber(row.flying_knife_block_avg_return_20d),
    flying_knife_block_avg_drawdown_20d: toMetricNumber(row.flying_knife_block_avg_drawdown_20d),
    gold_gate_block_avg_return_20d: toMetricNumber(row.gold_gate_block_avg_return_20d),
    gold_gate_block_avg_drawdown_20d: toMetricNumber(row.gold_gate_block_avg_drawdown_20d),
    training_readiness: buildMetalSampleReadiness(row),
    action_buckets: actionBuckets
  };
}

function getSilverSegmentMeta(segmentCode: string) {
  const metaMap: Record<string, { label: string; usage: string; tone: string }> = {
    GOLD_PASS_SILVER_SIGNAL: {
      label: '黄金通过后的白银信号',
      usage: '主训练样本',
      tone: 'signal'
    },
    GOLD_NOT_STABLE_BLOCK: {
      label: '黄金未稳拦截样本',
      usage: '拦截验证样本',
      tone: 'block'
    },
    GOLD_PASS_NO_SIGNAL: {
      label: '黄金通过但白银未触发',
      usage: '对照样本',
      tone: 'neutral'
    },
    UNKNOWN: {
      label: '未分层样本',
      usage: '待检查',
      tone: 'neutral'
    }
  };

  return metaMap[segmentCode] || metaMap.UNKNOWN;
}

function buildSilverSegmentReadiness(row: any) {
  const segmentCode = String(row.segment_code || 'UNKNOWN');
  const totalSamples = Number(row.total_samples || 0);
  const completeLabels = Number(row.complete_label_count || 0);
  const signalCandidates = Number(row.signal_candidate_count || 0);
  const shortLived = Number(row.short_lived_count || 0);
  const shortLivedRate = signalCandidates ? shortLived / signalCandidates : 0;

  if (segmentCode === 'GOLD_NOT_STABLE_BLOCK') {
    return {
      status: 'control',
      label: '只做拦截验证',
      reason: '这层不拿来训练白银入场，只验证“黄金不稳白银不动”是否真的减少回撤和短命信号。'
    };
  }

  if (segmentCode === 'GOLD_PASS_NO_SIGNAL') {
    return {
      status: 'control',
      label: '只做对照',
      reason: '黄金通过但白银没触发，用来观察规则是否漏掉机会，不作为正样本。'
    };
  }

  if (completeLabels < 120 || signalCandidates < 80) {
    return {
      status: 'not_ready',
      label: '主样本偏少',
      reason: `黄金通过后的白银信号完整标签 ${completeLabels} 条、候选 ${signalCandidates} 条，先继续积累或调宽回放区间。`
    };
  }

  if (shortLivedRate >= 0.6) {
    return {
      status: 'watch',
      label: '短命偏高',
      reason: `这一层短命信号占比 ${(shortLivedRate * 100).toFixed(1)}%，训练前要先复核连续确认和不接飞刀规则。`
    };
  }

  return {
    status: 'ready',
    label: '可作为主样本',
    reason: '黄金过滤后仍保留了足够白银信号，可以作为后续模型训练的主样本层。'
  };
}

function normalizeSilverSegmentRow(row: any) {
  const totalSamples = Number(row.total_samples || 0);
  const completeLabels = Number(row.complete_label_count || 0);
  const signalCandidates = Number(row.signal_candidate_count || 0);
  const shortLived = Number(row.short_lived_count || 0);
  const meta = getSilverSegmentMeta(row.segment_code || 'UNKNOWN');

  return {
    segment_code: row.segment_code || 'UNKNOWN',
    segment_label: meta.label,
    segment_usage: meta.usage,
    segment_tone: meta.tone,
    total_samples: totalSamples,
    complete_label_count: completeLabels,
    completion_rate: totalSamples ? roundNumber(completeLabels / totalSamples, 4) : 0,
    signal_candidate_count: signalCandidates,
    safe_confirmed_count: Number(row.safe_confirmed_count || 0),
    effective_confirmed_count: Number(row.effective_confirmed_count || 0),
    short_lived_count: shortLived,
    short_lived_rate: signalCandidates ? roundNumber(shortLived / signalCandidates, 4) : 0,
    avg_return_20d: toMetricNumber(row.avg_return_20d),
    avg_drawdown_20d: toMetricNumber(row.avg_drawdown_20d),
    signal_avg_return_20d: signalCandidates ? toMetricNumber(row.signal_avg_return_20d) : null,
    signal_avg_drawdown_20d: signalCandidates ? toMetricNumber(row.signal_avg_drawdown_20d) : null,
    safe_confirmed_avg_return_20d: toMetricNumber(row.safe_confirmed_avg_return_20d),
    safe_confirmed_avg_drawdown_20d: toMetricNumber(row.safe_confirmed_avg_drawdown_20d),
    short_lived_avg_return_20d: toMetricNumber(row.short_lived_avg_return_20d),
    short_lived_avg_drawdown_20d: toMetricNumber(row.short_lived_avg_drawdown_20d),
    readiness: buildSilverSegmentReadiness(row)
  };
}

function buildSilverLayerConclusion(rows: any[]) {
  const rowBySegment = new Map(rows.map(row => [String(row.segment_code || 'UNKNOWN'), row]));
  const main = rowBySegment.get('GOLD_PASS_SILVER_SIGNAL') || {};
  const blocked = rowBySegment.get('GOLD_NOT_STABLE_BLOCK') || {};
  const control = rowBySegment.get('GOLD_PASS_NO_SIGNAL') || {};
  const mainSignals = Number(main.signal_candidate_count || 0);
  const mainShortRate = mainSignals ? Number(main.signal_short_lived_count || 0) / mainSignals : 0;
  const blockedSignals = Number(blocked.signal_candidate_count || 0);
  const blockedShortRate = blockedSignals ? Number(blocked.signal_short_lived_count || 0) / blockedSignals : 0;
  const controlBigUpRate = Number(control.complete_label_count || 0)
    ? Number(control.big_up_count || 0) / Number(control.complete_label_count || 0)
    : 0;

  const warnings: string[] = [];
  if (mainShortRate >= 0.6) {
    warnings.push(`黄金通过后的白银信号短命率 ${(mainShortRate * 100).toFixed(1)}%，主样本还偏抖。`);
  }
  if (blockedSignals >= 30 && blockedShortRate >= 0.5) {
    warnings.push(`黄金未稳拦截层里候选信号短命率 ${(blockedShortRate * 100).toFixed(1)}%，黄金主锚有过滤价值。`);
  }
  if (controlBigUpRate >= 0.2) {
    warnings.push(`黄金通过但白银未触发层有 ${(controlBigUpRate * 100).toFixed(1)}% 后续大涨样本，要复核是否漏掉慢启动机会。`);
  }

  if (!mainSignals || mainSignals < 120) {
    return {
      status: 'watch',
      label: '继续分层',
      reason: `黄金通过后的白银信号 ${mainSignals} 条，先继续验收，不进入训练。${warnings.join('')}`
    };
  }

  if (mainShortRate >= 0.6) {
    return {
      status: 'watch',
      label: '短命偏高',
      reason: `主样本短命率偏高，先调规则验收连续确认、不接飞刀和波动收敛，再谈训练。${warnings.join('')}`
    };
  }

  return {
    status: 'ready_later',
    label: '可继续观察',
    reason: warnings.length
      ? warnings.join('')
      : '白银分层暂未出现明显异常，但仍先做验收，不急着训练。'
  };
}

function normalizeSilverValidationRow(row: any) {
  const meta = getSilverSegmentMeta(row.segment_code || 'UNKNOWN');
  const totalSamples = Number(row.total_samples || 0);
  const completeLabels = Number(row.complete_label_count || 0);
  const signalCandidates = Number(row.signal_candidate_count || 0);
  const signalShortLived = Number(row.signal_short_lived_count || 0);
  const deepDrawdownCount = Number(row.deep_drawdown_count || 0);
  const signalDeepDrawdownCount = Number(row.signal_deep_drawdown_count || 0);
  const bigUpCount = Number(row.big_up_count || 0);
  const signalBigUpCount = Number(row.signal_big_up_count || 0);

  return {
    segment_code: row.segment_code || 'UNKNOWN',
    segment_label: meta.label,
    segment_usage: meta.usage,
    segment_tone: meta.tone,
    total_samples: totalSamples,
    complete_label_count: completeLabels,
    completion_rate: totalSamples ? roundNumber(completeLabels / totalSamples, 4) : 0,
    signal_candidate_count: signalCandidates,
    signal_short_lived_count: signalShortLived,
    signal_short_lived_rate: signalCandidates ? roundNumber(signalShortLived / signalCandidates, 4) : 0,
    safe_confirmed_count: Number(row.safe_confirmed_count || 0),
    effective_confirmed_count: Number(row.effective_confirmed_count || 0),
    avg_return_20d: toMetricNumber(row.avg_return_20d),
    avg_drawdown_20d: toMetricNumber(row.avg_drawdown_20d),
    signal_avg_return_20d: signalCandidates ? toMetricNumber(row.signal_avg_return_20d) : null,
    signal_avg_drawdown_20d: signalCandidates ? toMetricNumber(row.signal_avg_drawdown_20d) : null,
    big_up_count: bigUpCount,
    big_up_rate: completeLabels ? roundNumber(bigUpCount / completeLabels, 4) : 0,
    signal_big_up_count: signalBigUpCount,
    signal_big_up_rate: signalCandidates ? roundNumber(signalBigUpCount / signalCandidates, 4) : 0,
    deep_drawdown_count: deepDrawdownCount,
    deep_drawdown_rate: completeLabels ? roundNumber(deepDrawdownCount / completeLabels, 4) : 0,
    signal_deep_drawdown_count: signalDeepDrawdownCount,
    signal_deep_drawdown_rate: signalCandidates ? roundNumber(signalDeepDrawdownCount / signalCandidates, 4) : 0,
    readiness: buildSilverSegmentReadiness(row)
  };
}

function normalizeSilverValidationYearRow(row: any) {
  const signalCandidates = Number(row.signal_candidate_count || 0);
  return {
    year: row.year,
    segment_code: row.segment_code || 'UNKNOWN',
    segment_label: getSilverSegmentMeta(row.segment_code || 'UNKNOWN').label,
    complete_label_count: Number(row.complete_label_count || 0),
    signal_candidate_count: Number(row.signal_candidate_count || 0),
    signal_short_lived_count: Number(row.signal_short_lived_count || 0),
    signal_short_lived_rate: Number(row.signal_candidate_count || 0)
      ? roundNumber(Number(row.signal_short_lived_count || 0) / Number(row.signal_candidate_count || 0), 4)
      : 0,
    avg_return_20d: toMetricNumber(row.avg_return_20d),
    avg_drawdown_20d: toMetricNumber(row.avg_drawdown_20d),
    signal_avg_return_20d: signalCandidates ? toMetricNumber(row.signal_avg_return_20d) : null,
    signal_avg_drawdown_20d: signalCandidates ? toMetricNumber(row.signal_avg_drawdown_20d) : null
  };
}

function normalizeSilverFxBucketRow(row: any) {
  const signalCandidates = Number(row.signal_candidate_count || 0);
  const completeLabels = Number(row.complete_label_count || 0);
  const signalShortLived = Number(row.signal_short_lived_count || 0);

  return {
    segment_code: row.segment_code || 'UNKNOWN',
    segment_label: getSilverSegmentMeta(row.segment_code || 'UNKNOWN').label,
    cny_state: row.cny_state || '无汇率',
    fx_tailwind_for_silver: row.fx_tailwind_for_silver || '无汇率',
    complete_label_count: completeLabels,
    signal_candidate_count: signalCandidates,
    signal_short_lived_count: signalShortLived,
    signal_short_lived_rate: signalCandidates ? roundNumber(signalShortLived / signalCandidates, 4) : 0,
    avg_return_20d: toMetricNumber(row.avg_return_20d),
    avg_drawdown_20d: toMetricNumber(row.avg_drawdown_20d),
    signal_avg_return_20d: signalCandidates ? toMetricNumber(row.signal_avg_return_20d) : null,
    signal_avg_drawdown_20d: signalCandidates ? toMetricNumber(row.signal_avg_drawdown_20d) : null,
    deep_drawdown_count: Number(row.deep_drawdown_count || 0),
    deep_drawdown_rate: completeLabels ? roundNumber(Number(row.deep_drawdown_count || 0) / completeLabels, 4) : 0,
    signal_deep_drawdown_count: Number(row.signal_deep_drawdown_count || 0),
    signal_deep_drawdown_rate: signalCandidates
      ? roundNumber(Number(row.signal_deep_drawdown_count || 0) / signalCandidates, 4)
      : 0
  };
}

function normalizeLatestFxRow(row: any) {
  if (!row) return null;
  return {
    trade_date: row.trade_date,
    ts_code: row.ts_code,
    source: row.source,
    usd_cny_mid: toMetricNumber(row.usd_cny_mid, 6),
    usd_cny_change_5d: toMetricNumber(row.usd_cny_change_5d),
    usd_cny_change_20d: toMetricNumber(row.usd_cny_change_20d),
    cny_state: row.cny_state,
    fx_tailwind_for_silver: row.fx_tailwind_for_silver
  };
}

function normalizeSilverValidationCase(row: any) {
  const caseMeta: Record<string, { title: string; reason: string; tone: string }> = {
    blocked_short_lived: {
      title: '拦截命中：黄金未稳且白银短命',
      reason: '这类样本说明黄金主锚拦截确实挡住了一部分短命信号。',
      tone: 'good'
    },
    blocked_big_up: {
      title: '拦截误杀：黄金未稳但白银后续大涨',
      reason: '这类样本用来复核黄金主锚是否过严，不能直接倒推当时一定该做。',
      tone: 'warn'
    },
    main_short_lived: {
      title: '主样本短命：黄金通过但白银没活住',
      reason: '这类样本是后续白银辅助模型最重要的反例来源。',
      tone: 'risk'
    },
    main_success: {
      title: '主样本成功：黄金通过且白银存活',
      reason: '这类样本用来提炼白银真正有效的路径特征。',
      tone: 'good'
    },
    control_big_up: {
      title: '对照组漏机会：黄金通过但白银未触发',
      reason: '这类样本检查白银规则是否漏掉慢启动或低噪声机会。',
      tone: 'warn'
    }
  };
  const meta = caseMeta[row.case_type] || {
    title: row.case_type || '样本案例',
    reason: '用于分层验收。',
    tone: 'neutral'
  };

  return {
    id: row.id,
    case_type: row.case_type,
    case_title: meta.title,
    case_reason: meta.reason,
    case_tone: meta.tone,
    trade_date: row.trade_date,
    close: toMetricNumber(row.close, 3),
    state_code: row.state_code,
    state_label: row.state_label,
    rule_action: row.rule_action,
    rule_action_label: row.rule_action_label,
    rule_signal: row.rule_signal,
    segment_code: row.segment_code,
    segment_label: getSilverSegmentMeta(row.segment_code || 'UNKNOWN').label,
    gold_state_code: row.gold_state_code,
    cny_state: row.cny_state || null,
    fx_tailwind_for_silver: row.fx_tailwind_for_silver || null,
    usd_cny_mid: toMetricNumber(row.usd_cny_mid, 6),
    usd_cny_change_5d: toMetricNumber(row.usd_cny_change_5d),
    usd_cny_change_20d: toMetricNumber(row.usd_cny_change_20d),
    safe_confirmation_days: Number(row.safe_confirmation_days || 0),
    signal_maturity_label: row.signal_maturity_label,
    future_return_20d: toMetricNumber(row.future_return_20d),
    future_max_drawdown_20d: toMetricNumber(row.future_max_drawdown_20d),
    survived_5d: row.survived_5d === null || row.survived_5d === undefined ? null : Boolean(row.survived_5d),
    short_lived_signal: Boolean(row.short_lived_signal)
  };
}

async function ensureMetalRuleContrastReportTable(db: any) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS metal_rule_contrast_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      report_key TEXT NOT NULL,
      report_date TEXT,
      rule_version TEXT NOT NULL,
      status TEXT NOT NULL,
      conclusion_label TEXT,
      conclusion_text TEXT,
      metrics_json TEXT,
      checks_json TEXT,
      report_json TEXT NOT NULL,
      saved_from TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_metal_rule_contrast_reports_scope
    ON metal_rule_contrast_reports(symbol, report_key, created_at DESC);
  `);
}

function rate(count: number, total: number): number | null {
  if (!total) return null;
  return roundNumber(count / total, 4);
}

function normalizeGoldRuleMetric(row: any, meta: { key: string; label: string; description: string }) {
  const sampleCount = Number(row.sample_count || 0);
  const survived3 = Number(row.survived_3d_count || 0);
  const survived5 = Number(row.survived_5d_count || 0);
  const shortLived = Number(row.short_lived_count || 0);
  const positive20 = Number(row.positive_20d_count || 0);
  const breakLow20 = Number(row.break_recent_low_20d_count || 0);
  const deepDrawdown20 = Number(row.deep_drawdown_20d_count || 0);

  return {
    key: meta.key,
    label: meta.label,
    description: meta.description,
    sample_count: sampleCount,
    survived_3d_count: survived3,
    survived_3d_rate: rate(survived3, sampleCount),
    survived_5d_count: survived5,
    survived_5d_rate: rate(survived5, sampleCount),
    short_lived_count: shortLived,
    short_lived_rate: rate(shortLived, sampleCount),
    positive_20d_count: positive20,
    positive_20d_rate: rate(positive20, sampleCount),
    break_recent_low_20d_count: breakLow20,
    break_recent_low_20d_rate: rate(breakLow20, sampleCount),
    deep_drawdown_20d_count: deepDrawdown20,
    deep_drawdown_20d_rate: rate(deepDrawdown20, sampleCount),
    avg_return_5d: toMetricNumber(row.avg_return_5d),
    avg_return_10d: toMetricNumber(row.avg_return_10d),
    avg_return_20d: toMetricNumber(row.avg_return_20d),
    avg_drawdown_20d: toMetricNumber(row.avg_drawdown_20d),
    min_drawdown_20d: toMetricNumber(row.min_drawdown_20d),
    latest_trade_date: row.latest_trade_date || null
  };
}

async function queryGoldRuleMetric(db: any, meta: { key: string; label: string; description: string; where: string }) {
  const row = await db.get(
    `SELECT
      COUNT(*) as sample_count,
      MAX(trade_date) as latest_trade_date,
      SUM(CASE WHEN survived_3d = 1 THEN 1 ELSE 0 END) as survived_3d_count,
      SUM(CASE WHEN survived_5d = 1 THEN 1 ELSE 0 END) as survived_5d_count,
      SUM(CASE WHEN short_lived_signal = 1 THEN 1 ELSE 0 END) as short_lived_count,
      SUM(CASE WHEN future_return_20d > 0 THEN 1 ELSE 0 END) as positive_20d_count,
      SUM(CASE WHEN break_recent_low_20d = 1 THEN 1 ELSE 0 END) as break_recent_low_20d_count,
      SUM(CASE WHEN future_max_drawdown_20d <= -0.05 THEN 1 ELSE 0 END) as deep_drawdown_20d_count,
      AVG(future_return_5d) as avg_return_5d,
      AVG(future_return_10d) as avg_return_10d,
      AVG(future_return_20d) as avg_return_20d,
      AVG(future_max_drawdown_20d) as avg_drawdown_20d,
      MIN(future_max_drawdown_20d) as min_drawdown_20d
     FROM metal_rule_lab_samples
     WHERE symbol = 'XAUUSD'
       AND label_status = 'complete'
       AND ${meta.where}`
  );

  return normalizeGoldRuleMetric(row || {}, meta);
}

function metricValue(metrics: Map<string, any>, key: string, field: string): number | null {
  const value = metrics.get(key)?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildGoldRuleConclusion(metrics: any[]) {
  const byKey = new Map(metrics.map(item => [item.key, item]));
  const baseline = byKey.get('baseline_all') || {};
  const signal = byKey.get('signal_candidate') || {};
  const effective = byKey.get('confirmed_5d') || {};
  const stable = byKey.get('confirmed_10d') || {};
  const noKnife = byKey.get('no_flying_knife_block') || {};

  const completeSamples = Number(baseline.sample_count || 0);
  const signalSamples = Number(signal.sample_count || 0);
  const effectiveSamples = Number(effective.sample_count || 0);
  const stableSamples = Number(stable.sample_count || 0);
  const noKnifeSamples = Number(noKnife.sample_count || 0);
  const shortLivedEdge = metricValue(byKey, 'signal_candidate', 'short_lived_rate') !== null
    && metricValue(byKey, 'confirmed_5d', 'short_lived_rate') !== null
      ? roundNumber((signal.short_lived_rate || 0) - (effective.short_lived_rate || 0), 4)
      : null;
  const drawdownEdge = metricValue(byKey, 'signal_candidate', 'avg_drawdown_20d') !== null
    && metricValue(byKey, 'confirmed_5d', 'avg_drawdown_20d') !== null
      ? roundNumber((effective.avg_drawdown_20d || 0) - (signal.avg_drawdown_20d || 0), 4)
      : null;
  const noKnifeShortEdge = metricValue(byKey, 'no_flying_knife_block', 'short_lived_rate') !== null
    && metricValue(byKey, 'signal_candidate', 'short_lived_rate') !== null
      ? roundNumber((noKnife.short_lived_rate || 0) - (signal.short_lived_rate || 0), 4)
      : null;
  const noKnifeDrawdownEdge = metricValue(byKey, 'signal_candidate', 'avg_drawdown_20d') !== null
    && metricValue(byKey, 'no_flying_knife_block', 'avg_drawdown_20d') !== null
      ? roundNumber((signal.avg_drawdown_20d || 0) - (noKnife.avg_drawdown_20d || 0), 4)
      : null;

  const checks = [
    {
      key: 'sample_size',
      label: '黄金完整样本量',
      passed: completeSamples >= 300 && signalSamples >= 50,
      actual: { complete_samples: completeSamples, signal_samples: signalSamples },
      threshold: { complete_samples: 300, signal_samples: 50 },
      note: '样本量先过线，后续模型或规则对照才不容易被少数年份带偏。'
    },
    {
      key: 'effective_confirmation_size',
      label: '连续确认5天样本量',
      passed: effectiveSamples >= 30,
      actual: effectiveSamples,
      threshold: 30,
      note: '这是“等低点不再破、波动收敛、结构重建”的主验收组。'
    },
    {
      key: 'confirmation_edge',
      label: '连续确认过滤价值',
      passed: (shortLivedEdge !== null && shortLivedEdge >= 0.03) || (drawdownEdge !== null && drawdownEdge >= 0.005),
      actual: { short_lived_edge: shortLivedEdge, drawdown_edge: drawdownEdge },
      threshold: { short_lived_edge: 0.03, drawdown_edge: 0.005 },
      note: '连续确认5天相比全部信号，短命率更低或未来20日回撤更轻，就说明“防抖”有价值。'
    },
    {
      key: 'no_flying_knife_value',
      label: '不接飞刀拦截价值',
      passed: noKnifeSamples >= 30 && (
        (noKnifeShortEdge !== null && noKnifeShortEdge >= 0.03)
        || (noKnifeDrawdownEdge !== null && noKnifeDrawdownEdge >= 0.005)
      ),
      actual: { samples: noKnifeSamples, short_lived_edge: noKnifeShortEdge, drawdown_edge: noKnifeDrawdownEdge },
      threshold: { samples: 30, short_lived_edge: 0.03, drawdown_edge: 0.005 },
      note: '被不接飞刀规则挡住的样本，应该更短命或回撤更深，否则规则需要复核。'
    },
    {
      key: 'stable_confirmation_pool',
      label: '稳定确认样本储备',
      passed: stableSamples >= 10,
      actual: stableSamples,
      threshold: 10,
      note: '连续确认10天样本是更稳的对照组，数量不足时先只做辅助参考。'
    }
  ];

  const passedCount = checks.filter(check => check.passed).length;
  let status = 'watch';
  let label = '继续验收';
  let text = '黄金规则已有可读样本，但还需要继续验收连续确认和不接飞刀的稳定区分度。';

  if (!checks[0].passed) {
    status = 'insufficient';
    label = '样本不足';
    text = '黄金完整样本或信号候选样本不足，先继续补历史与每日落库，不急着看模型结论。';
  } else if (checks[1].passed && checks[2].passed && checks[3].passed) {
    status = 'validated';
    label = '规则有效';
    text = '黄金连续确认和不接飞刀规则都有过滤价值：先等确认、再看模型，不能把刚触发当强信号。';
  } else if (passedCount >= 3) {
    status = 'watch';
    label = '规则偏有效';
    text = '黄金规则已有部分过滤价值，当前更适合做固定复核报告，模型只能辅助解释。';
  } else {
    status = 'needs_review';
    label = '需要复核';
    text = '黄金规则的连续确认或不接飞刀优势还不稳定，先复核阈值，不急着强化模型权重。';
  }

  return {
    status,
    label,
    text,
    metrics: {
      complete_samples: completeSamples,
      signal_samples: signalSamples,
      effective_samples: effectiveSamples,
      stable_samples: stableSamples,
      no_flying_knife_samples: noKnifeSamples,
      short_lived_edge: shortLivedEdge,
      drawdown_edge: drawdownEdge,
      no_flying_knife_short_lived_edge: noKnifeShortEdge,
      no_flying_knife_drawdown_edge: noKnifeDrawdownEdge
    },
    checks,
    action_rules: [
      '新触发只观察，不直接当强信号。',
      '连续确认3天进入复核，连续确认5天才算有效复核。',
      '暴跌、低点下移、波动放大时继续执行不接飞刀。',
      '模型只做概率解释，不覆盖安全区、结构成立和人工确认。'
    ]
  };
}

async function buildGoldRuleContrastReport(db: any) {
  await ensureMetalRuleContrastReportTable(db);
  const groups = [
    {
      key: 'baseline_all',
      label: '全部完整样本',
      description: '黄金所有已具备20日后验标签的交易日，作为基准。',
      where: '1 = 1'
    },
    {
      key: 'signal_candidate',
      label: '规则候选',
      description: '结构形成、安全区候选、安全区确认或趋势运行的全部候选信号。',
      where: "rule_signal = 'SIGNAL_CANDIDATE'"
    },
    {
      key: 'safe_confirmed_new',
      label: '新确认',
      description: '刚进入安全区确认1-2天，用来观察刚触发信号有多抖。',
      where: "state_code = 'SAFE_CONFIRMED' AND safe_confirmation_days BETWEEN 1 AND 2"
    },
    {
      key: 'confirmed_3d',
      label: '连续确认≥3天',
      description: '次日复核后继续存活，开始进入有效观察。',
      where: 'safe_confirmation_days >= 3'
    },
    {
      key: 'confirmed_5d',
      label: '连续确认≥5天',
      description: '主规则组：低点不再破、波动收敛、结构重建后再考虑。',
      where: 'safe_confirmation_days >= 5'
    },
    {
      key: 'confirmed_10d',
      label: '连续确认≥10天',
      description: '稳定确认组，用来观察长一点的防抖价值。',
      where: 'safe_confirmation_days >= 10'
    },
    {
      key: 'no_flying_knife_block',
      label: '不接飞刀拦截',
      description: '风险区、暴跌或低点下移时被规则挡住的样本。',
      where: 'no_flying_knife_blocked = 1'
    },
    {
      key: 'structure_before_safe',
      label: '结构未完全确认',
      description: '结构形成或安全区候选，还没进入安全区确认。',
      where: "state_code IN ('STRUCTURE_FORMING', 'SAFE_CANDIDATE')"
    }
  ];
  const metrics = await Promise.all(groups.map(group => queryGoldRuleMetric(db, group)));
  const conclusion = buildGoldRuleConclusion(metrics);
  const latestTradeDate = metrics
    .map(item => item.latest_trade_date)
    .filter(Boolean)
    .sort()
    .pop() || null;

  return {
    symbol: 'XAUUSD',
    asset_name: 'Gold Spot',
    report_key: 'gold_rule_contrast',
    rule_version: 'gold_rule_contrast_v0.1',
    generated_at: new Date().toISOString(),
    report_date: latestTradeDate,
    no_lookahead_note: '规则分组只使用截面日及以前数据；未来5/10/20日收益、回撤、破低和存活只作为后验标签。',
    conclusion,
    metrics
  };
}

async function persistGoldRuleContrastReport(db: any, report: Awaited<ReturnType<typeof buildGoldRuleContrastReport>>, savedFrom: string) {
  await ensureMetalRuleContrastReportTable(db);
  await db.run(
    `INSERT INTO metal_rule_contrast_reports (
      symbol, report_key, report_date, rule_version, status, conclusion_label,
      conclusion_text, metrics_json, checks_json, report_json, saved_from,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      report.symbol,
      report.report_key,
      report.report_date,
      report.rule_version,
      report.conclusion.status,
      report.conclusion.label,
      report.conclusion.text,
      JSON.stringify(report.metrics || []),
      JSON.stringify(report.conclusion.checks || []),
      JSON.stringify(report),
      savedFrom
    ]
  );
}

function normalizeGoldRuleReportRow(row: any, options: { includeReport?: boolean } = {}) {
  if (!row) return null;
  const includeReport = options.includeReport !== false;
  return {
    id: row.id,
    symbol: row.symbol,
    report_key: row.report_key,
    report_date: row.report_date,
    rule_version: row.rule_version,
    status: row.status,
    conclusion_label: row.conclusion_label,
    conclusion_text: row.conclusion_text,
    metrics: safeJsonParse(row.metrics_json, []),
    checks: safeJsonParse(row.checks_json, []),
    ...(includeReport ? { report: safeJsonParse(row.report_json, null) } : {}),
    saved_from: row.saved_from,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function ensureMetalModelValidationReportTable(db: any) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS metal_model_validation_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      domain TEXT NOT NULL,
      model_run_id INTEGER,
      report_key TEXT NOT NULL,
      status TEXT NOT NULL,
      conclusion_label TEXT,
      conclusion_text TEXT,
      metrics_json TEXT,
      checks_json TEXT,
      report_json TEXT NOT NULL,
      saved_from TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_metal_model_validation_reports_scope
    ON metal_model_validation_reports(symbol, report_key, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_metal_model_validation_reports_run
    ON metal_model_validation_reports(domain, model_run_id, created_at DESC);
  `);
}

function compactGoldModelValidationMetrics(report: any) {
  const validation = report?.validation || {};
  const targets = validation.targets || {};
  return {
    sample_count: validation.sample_count || 0,
    survival_high_count: targets.survival_5d?.high_bucket?.count ?? null,
    survival_high_actual_rate: targets.survival_5d?.high_bucket?.actual_rate ?? null,
    survival_baseline_rate: targets.survival_5d?.baseline_rate ?? null,
    survival_edge: targets.survival_5d?.high_edge_vs_baseline ?? null,
    short_lived_high_count: targets.short_lived_5d?.high_bucket?.count ?? null,
    short_lived_high_actual_rate: targets.short_lived_5d?.high_bucket?.actual_rate ?? null,
    short_lived_baseline_rate: targets.short_lived_5d?.baseline_rate ?? null,
    short_lived_edge: targets.short_lived_5d?.high_edge_vs_baseline ?? null,
    drawdown_high_count: targets.drawdown_risk_20d?.high_bucket?.count ?? null,
    drawdown_high_actual_rate: targets.drawdown_risk_20d?.high_bucket?.actual_rate ?? null,
    drawdown_baseline_rate: targets.drawdown_risk_20d?.baseline_rate ?? null,
    drawdown_edge: targets.drawdown_risk_20d?.high_edge_vs_baseline ?? null
  };
}

async function buildGoldModelValidationReport(caseLimit = 8) {
  const payload = await runMetalScoringWorker('XAUUSD', caseLimit);
  const conclusion = payload?.validation?.conclusion || {
    status: 'unknown',
    label: '暂无结论',
    text: '黄金模型验收报告暂未生成。'
  };
  return {
    ...payload,
    report_key: 'gold_model_validation',
    generated_at: new Date().toISOString(),
    conclusion,
    validation_metrics: compactGoldModelValidationMetrics(payload)
  };
}

async function persistGoldModelValidationReport(db: any, report: any, savedFrom: string) {
  await ensureMetalModelValidationReportTable(db);
  const conclusion = report.conclusion || report.validation?.conclusion || {};
  await db.run(
    `INSERT INTO metal_model_validation_reports (
      symbol, domain, model_run_id, report_key, status, conclusion_label,
      conclusion_text, metrics_json, checks_json, report_json, saved_from,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      report.symbol || 'XAUUSD',
      report.domain || 'metal:gold',
      report.run?.id || null,
      report.report_key || 'gold_model_validation',
      conclusion.status || 'unknown',
      conclusion.label || '',
      conclusion.text || '',
      JSON.stringify(report.validation_metrics || compactGoldModelValidationMetrics(report)),
      JSON.stringify(conclusion.checks || []),
      JSON.stringify(report),
      savedFrom
    ]
  );
}

function normalizeGoldModelValidationReportRow(row: any, options: { includeReport?: boolean } = {}) {
  if (!row) return null;
  const includeReport = options.includeReport !== false;
  return {
    id: row.id,
    symbol: row.symbol,
    domain: row.domain,
    model_run_id: row.model_run_id,
    report_key: row.report_key,
    status: row.status,
    conclusion_label: row.conclusion_label,
    conclusion_text: row.conclusion_text,
    metrics: safeJsonParse(row.metrics_json, {}),
    checks: safeJsonParse(row.checks_json, []),
    ...(includeReport ? { report: safeJsonParse(row.report_json, null) } : {}),
    saved_from: row.saved_from,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function saveMetalRuleReplaySamples(db: any, replay: Awaited<ReturnType<typeof buildMetalRuleReplay>>, savedFrom: string) {
  let inserted = 0;
  let updated = 0;

  for (const item of replay.items) {
    const existing = await db.get(
      `SELECT id FROM metal_rule_lab_samples WHERE symbol = ? AND trade_date = ? AND rule_version = ?`,
      [item.symbol, item.trade_date, replay.rule_version]
    );

    await db.run(
      `INSERT INTO metal_rule_lab_samples (
        symbol, asset_name, source, trade_date, rule_version, close,
        state_code, state_label, state_reason, short_label, mid_label, long_label, cycle_label,
        distance_to_ma60, recent_return_5, recent_return_20, drawdown_20, range_ratio_5, range_ratio_20,
        lower_low, abnormal_move, behavior_tags_json,
        state_continuation_days, safe_confirmation_days, safe_zone_days, signal_maturity, signal_maturity_label,
        gold_gate_pass, gold_state_code, no_flying_knife_blocked,
        rule_signal, rule_action, rule_action_label, rule_action_reason,
        label_status, future_return_3d, future_return_5d, future_return_10d, future_return_20d,
        future_max_drawdown_20d, break_recent_low_20d, survived_3d, survived_5d, short_lived_signal,
        future_state_3d, future_state_5d, future_state_10d, future_state_20d,
        snapshot_json, saved_from, replay_start_date, replay_end_date
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(symbol, trade_date, rule_version) DO UPDATE SET
        asset_name = excluded.asset_name,
        source = excluded.source,
        close = excluded.close,
        state_code = excluded.state_code,
        state_label = excluded.state_label,
        state_reason = excluded.state_reason,
        short_label = excluded.short_label,
        mid_label = excluded.mid_label,
        long_label = excluded.long_label,
        cycle_label = excluded.cycle_label,
        distance_to_ma60 = excluded.distance_to_ma60,
        recent_return_5 = excluded.recent_return_5,
        recent_return_20 = excluded.recent_return_20,
        drawdown_20 = excluded.drawdown_20,
        range_ratio_5 = excluded.range_ratio_5,
        range_ratio_20 = excluded.range_ratio_20,
        lower_low = excluded.lower_low,
        abnormal_move = excluded.abnormal_move,
        behavior_tags_json = excluded.behavior_tags_json,
        state_continuation_days = excluded.state_continuation_days,
        safe_confirmation_days = excluded.safe_confirmation_days,
        safe_zone_days = excluded.safe_zone_days,
        signal_maturity = excluded.signal_maturity,
        signal_maturity_label = excluded.signal_maturity_label,
        gold_gate_pass = excluded.gold_gate_pass,
        gold_state_code = excluded.gold_state_code,
        no_flying_knife_blocked = excluded.no_flying_knife_blocked,
        rule_signal = excluded.rule_signal,
        rule_action = excluded.rule_action,
        rule_action_label = excluded.rule_action_label,
        rule_action_reason = excluded.rule_action_reason,
        label_status = excluded.label_status,
        future_return_3d = excluded.future_return_3d,
        future_return_5d = excluded.future_return_5d,
        future_return_10d = excluded.future_return_10d,
        future_return_20d = excluded.future_return_20d,
        future_max_drawdown_20d = excluded.future_max_drawdown_20d,
        break_recent_low_20d = excluded.break_recent_low_20d,
        survived_3d = excluded.survived_3d,
        survived_5d = excluded.survived_5d,
        short_lived_signal = excluded.short_lived_signal,
        future_state_3d = excluded.future_state_3d,
        future_state_5d = excluded.future_state_5d,
        future_state_10d = excluded.future_state_10d,
        future_state_20d = excluded.future_state_20d,
        snapshot_json = excluded.snapshot_json,
        saved_from = excluded.saved_from,
        replay_start_date = excluded.replay_start_date,
        replay_end_date = excluded.replay_end_date,
        updated_at = CURRENT_TIMESTAMP`,
      [
        item.symbol,
        item.asset_name,
        item.source,
        item.trade_date,
        replay.rule_version,
        item.close,
        item.state_code,
        item.state_label,
        item.state_reason,
        item.short_label,
        item.mid_label,
        item.long_label,
        item.cycle_label,
        item.distance_to_ma60,
        item.recent_return_5,
        item.recent_return_20,
        item.drawdown_20,
        item.range_ratio_5,
        item.range_ratio_20,
        dbBool(item.lower_low),
        dbBool(item.abnormal_move),
        JSON.stringify(item.behavior_tags || []),
        item.state_continuation_days,
        item.safe_confirmation_days,
        item.safe_zone_days,
        item.signal_maturity,
        item.signal_maturity_label,
        dbBool(item.gold_gate_pass),
        item.gold_state_code,
        dbBool(item.no_flying_knife_blocked),
        item.rule_signal,
        item.rule_action,
        item.rule_action_label,
        item.rule_action_reason,
        item.labels.label_status,
        item.labels.future_return_3d,
        item.labels.future_return_5d,
        item.labels.future_return_10d,
        item.labels.future_return_20d,
        item.labels.future_max_drawdown_20d,
        dbBool(item.labels.break_recent_low_20d),
        dbBool(item.labels.survived_3d),
        dbBool(item.labels.survived_5d),
        dbBool(item.labels.short_lived_signal),
        item.labels.future_state_3d,
        item.labels.future_state_5d,
        item.labels.future_state_10d,
        item.labels.future_state_20d,
        JSON.stringify(item),
        savedFrom,
        replay.start_date,
        replay.end_date
      ]
    );

    if (existing) {
      updated += 1;
    } else {
      inserted += 1;
    }
  }

  return { inserted, updated, total: replay.items.length };
}

async function readJsonFile(filePath: string) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function safeJsonParse(value: any, fallback: any = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function compactPreciousMetalPipelineResult(result: any) {
  if (!result || typeof result !== 'object') return null;
  return {
    summary: result.summary || null,
    steps: Array.isArray(result.steps)
      ? result.steps.map((step: any) => ({
        key: step.key,
        label: step.label,
        status: step.status,
        message: step.message,
        started_at: step.started_at,
        finished_at: step.finished_at,
        duration_ms: step.duration_ms
      }))
      : [],
    silver_gate: result.silver_gate ? {
      status: result.silver_gate.status,
      passed: Boolean(result.silver_gate.passed),
      reason: result.silver_gate.reason,
      message: result.silver_gate.message,
      metrics: result.silver_gate.metrics || {},
      checks: result.silver_gate.checks || [],
      thresholds: result.silver_gate.thresholds || {},
      created_at: result.silver_gate.created_at,
      updated_at: result.silver_gate.updated_at,
      generated_at: result.silver_gate.generated_at
    } : null
  };
}

async function getLatestMetalTrainingSummary(db: any, symbol: string) {
  const domain = getMetalTrainingDomain(symbol);
  const boundary = getMetalTrainingBoundary(symbol);
  const run = await db.get(
    `SELECT id, domain, status, output_dir, source_row_count, started_at, finished_at, message, updated_at
     FROM model_training_runs
     WHERE domain = ?
     ORDER BY id DESC
     LIMIT 1`,
    [domain]
  );
  const artifacts = await db.all(
    `SELECT model_key, target, model_type, model_file, model_json_file, metrics_file,
            run_id, validation_auc, test_auc, sample_limits_json, updated_at
     FROM model_training_artifacts
     WHERE domain = ?
     ORDER BY
       CASE
         WHEN model_key LIKE '%lightgbm_model' THEN 1
         WHEN model_key LIKE '%random_forest' THEN 2
         WHEN model_key LIKE '%logistic_regression' THEN 3
         ELSE 9
       END,
       model_key`,
    [domain]
  );
  const summary = run?.output_dir ? await readJsonFile(path.join(run.output_dir, 'summary.json')) : null;

  return {
    symbol,
    domain,
    boundary,
    status: run?.status || 'empty',
    run: run || null,
    summary,
    artifacts: artifacts.map((row: any) => ({
      model_key: row.model_key,
      target: row.target,
      model_type: row.model_type,
      model_file: row.model_file,
      model_json_file: row.model_json_file,
      metrics_file: row.metrics_file,
      run_id: row.run_id,
      validation_auc: toMetricNumber(row.validation_auc),
      test_auc: toMetricNumber(row.test_auc),
      sample_limits: typeof row.sample_limits_json === 'string' ? JSON.parse(row.sample_limits_json || '{}') : null,
      updated_at: row.updated_at
    }))
  };
}

function runMetalTrainingWorker(symbol: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'train_precious_metal_models.py');
    const args = [
      scriptPath,
      '--db', getDatabasePath(),
      '--symbol', symbol,
      '--output-root', preciousMetalTrainingRoot
    ];

    const child = spawn(metalTrainingPython, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('贵金属本地模型训练超过 3 分钟未返回，已中断本次请求。'));
    }, 180000);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      const lines = stdout.trim().split('\n').filter(Boolean);
      const text = lines[lines.length - 1] || '';
      try {
        const payload = JSON.parse(text || '{}');
        if (code === 0 && payload.success) {
          resolve(payload.data);
          return;
        }
        reject(new Error(payload.message || stderr || `贵金属训练脚本退出：${code}`));
      } catch (error) {
        reject(new Error(stderr || text || `贵金属训练脚本输出无法解析：${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function runMetalScoringWorker(symbol: string, caseLimit: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'score_precious_metal_models.py');
    const args = [
      scriptPath,
      '--db', getDatabasePath(),
      '--symbol', symbol,
      '--case-limit', String(caseLimit)
    ];

    const child = spawn(metalTrainingPython, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('贵金属模型评分超过 60 秒未返回，已中断本次请求。'));
    }, 60000);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      const lines = stdout.trim().split('\n').filter(Boolean);
      const text = lines[lines.length - 1] || '';
      try {
        const payload = JSON.parse(text || '{}');
        if (code === 0 && payload.success) {
          resolve(payload.data);
          return;
        }
        reject(new Error(payload.message || stderr || `贵金属评分脚本退出：${code}`));
      } catch (error) {
        reject(new Error(stderr || text || `贵金属评分脚本输出无法解析：${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

async function fetchAndUpdateMetalData(db: any, symbol: string, forceUpdate: boolean = false): Promise<{ success: boolean; message: string; updated: boolean }> {
  const now = new Date();
  const asset = getMetalAsset(symbol);

  if (!asset) {
    return { success: false, message: getSupportedMetalMessage(), updated: false };
  }
  
  const lastUpdateResult = await db.get(
    `SELECT MAX(updated_at) as last_updated
     FROM financial_daily_prices 
     WHERE symbol = ? AND source = ?`,
    [symbol, asset.source]
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
  
  logUpdate(`开始从 ${asset.dataSourceLabel} 获取数据`, symbol);
  
  const result = await new Promise<{ success: boolean; data?: any; message?: string }>((resolve) => {
    exec(`/usr/bin/python3 "${scriptPath}" ${symbol} --source ${asset.source}`, (error, stdout, stderr) => {
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
  const source = data.source || asset.source;
  
  let insertedCount = 0;
  let updatedCount = 0;
  let skippedNonTradingDayCount = 0;
  
  for (const item of data.items) {
    if (!isValidMetalTradingDate(item.trade_date)) {
      skippedNonTradingDayCount++;
      continue;
    }

    const existing = await db.get(
      `SELECT 1 FROM financial_daily_prices 
       WHERE symbol = ? AND trade_date = ? AND source = ?`,
      [symbol, item.trade_date, source]
    );
    
    await db.run(
      `INSERT OR REPLACE INTO financial_daily_prices 
       (symbol, name, market, asset_type, trade_date, open, high, low, close, volume, amount, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        symbol,
        data.name || asset.name,
        asset.market,
        'metal_anchor',
        item.trade_date,
        item.open,
        item.high,
        item.low,
        item.close,
        item.volume,
        item.amount,
        source
      ]
    );
    
    if (existing) {
      updatedCount++;
    } else {
      insertedCount++;
    }
  }
  
  const skipText = skippedNonTradingDayCount ? `，跳过非交易日 ${skippedNonTradingDayCount} 条` : '';
  const statusMsg = `数据更新完成：新增 ${insertedCount} 条，更新 ${updatedCount} 条${skipText}`;
  logUpdate(statusMsg, symbol);
  
  return { success: true, message: statusMsg, updated: true };
}

export function calculateMetalRegime(prices: MetalDailyPrice[], source: string = 'twelvedata'): MetalRegime {
  prices = filterMetalTradingPrices(prices);
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
      source
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
    source
  };
}

router.post('/update', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.body.symbol;
    const forceUpdate = req.body.force_update || false;
    const asset = getMetalAsset(symbol);

    if (!asset) {
      return res.status(400).json({
        success: false,
        message: getSupportedMetalMessage()
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
       WHERE symbol = ? AND source = ?
         AND strftime('%w', trade_date) NOT IN ('0', '6')`,
      [symbol, asset.source]
    );

    const status = statusResult[0] || {};

    res.json({
      success: true,
      message: updateResult.updated ? updateResult.message : '距离上次更新不足60秒，已返回本地最新结果。',
      data: {
        symbol,
        source: asset.source,
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
    const asset = getMetalAsset(symbol);

    if (!asset) {
      return res.status(400).json({
        success: false,
        message: getSupportedMetalMessage()
      });
    }

    logRead(`获取贵金属数据状态: ${symbol}`, symbol);

    const result = await db.get(
      `SELECT COUNT(*) as total_count, 
              MIN(trade_date) as first_trade_date, 
              MAX(trade_date) as last_trade_date,
              MAX(updated_at) as last_updated
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = ?
         AND strftime('%w', trade_date) NOT IN ('0', '6')`,
      [symbol, asset.source]
    );

    const totalCount = result?.total_count || 0;

    res.json({
      success: true,
      data: {
        symbol,
        source: asset.source,
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
    const asset = getMetalAsset(symbol);

    if (!asset) {
      return res.status(400).json({
        success: false,
        message: getSupportedMetalMessage()
      });
    }

    logRead(`获取贵金属日线数据: ${symbol} limit=${limit}`, symbol);

    const prices = await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount 
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = ? 
         AND strftime('%w', trade_date) NOT IN ('0', '6')
       ORDER BY trade_date DESC 
       LIMIT ?`,
      [symbol, asset.source, limit]
    );

    res.json({
      success: true,
      data: {
        symbol,
        source: asset.source,
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
    const asset = getMetalAsset(symbol);

    if (!asset) {
      return res.status(400).json({
        success: false,
        message: getSupportedMetalMessage()
      });
    }

    logRead(`获取贵金属最新状态: ${symbol}`, symbol);

    const prices = filterMetalTradingPrices(await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount 
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = ? 
       ORDER BY trade_date ASC`,
      [symbol, asset.source]
    ));

    if (prices.length === 0) {
      return res.json({
        success: true,
        data: {
          symbol,
          message: '暂无数据，请先更新日线数据',
          state_code: 'UNKNOWN',
          state_continuation_days: 0,
          safe_confirmation_days: 0,
          safe_zone_days: 0,
          signal_maturity: 'NOT_CONFIRMED',
          signal_maturity_label: '未确认',
          signal_maturity_reason: '暂无数据，不能确认安全区。',
          source: asset.source
        }
      });
    }

    const regime = calculateMetalRegime(prices, asset.source);
    const continuity = calculateMetalSignalContinuity(prices, asset.source, regime.state_code);
    
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
        state_continuation_days: continuity.state_continuation_days,
        safe_confirmation_days: continuity.safe_confirmation_days,
        safe_zone_days: continuity.safe_zone_days,
        signal_maturity: continuity.signal_maturity,
        signal_maturity_label: continuity.signal_maturity_label,
        signal_maturity_reason: continuity.signal_maturity_reason,
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
    const asset = getMetalAsset(symbol);

    if (!asset) {
      return res.status(400).json({
        success: false,
        message: getSupportedMetalMessage()
      });
    }

    if (!startDate) {
      return res.status(400).json({
        success: false,
        message: 'start_date is required'
      });
    }

    logRead(`贵金属历史回放: ${symbol} ${startDate} - ${endDate}`, symbol);

    const allPrices = filterMetalTradingPrices(await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount 
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = ? 
       ORDER BY trade_date ASC`,
      [symbol, asset.source]
    ));

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
      const regime = calculateMetalRegime(historyPrices, asset.source);

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

router.post('/rule-lab/replay', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.body.symbol || 'SGE_AGTD';
    const asset = getMetalAsset(symbol);
    const requestedEndDate = req.body.end_date;
    const requestedStartDate = req.body.start_date;
    const maxItems = Math.min(Math.max(Number(req.body.limit || 360), 30), 1500);

    if (!asset) {
      return res.status(400).json({
        success: false,
        message: getSupportedMetalMessage()
      });
    }

    logRead(`贵金属规则实验回放: ${symbol}`, symbol);

    const allPrices: MetalDailyPrice[] = filterMetalTradingPrices(await db.all(
      `SELECT trade_date, open, high, low, close, volume, amount 
       FROM financial_daily_prices 
       WHERE symbol = ? AND source = ? 
       ORDER BY trade_date ASC`,
      [symbol, asset.source]
    ));

    if (allPrices.length < 80) {
      return res.status(400).json({
        success: false,
        message: `本地数据不足（当前${allPrices.length}条），需要至少80条数据。`
      });
    }

    const latestTradeDate = allPrices[allPrices.length - 1].trade_date;
    const defaultStartIndex = Math.max(0, allPrices.length - maxItems);
    const startDate = requestedStartDate || allPrices[defaultStartIndex].trade_date;
    const endDate = requestedEndDate || latestTradeDate;

    const timeline = buildMetalRegimeTimeline(allPrices, asset.source);
    const timelineByIndex = new Map(timeline.map(item => [item.index, item]));
    const timelineByDate = new Map(timeline.map(item => [item.price.trade_date, item]));

    let goldTimelineByDate = new Map<string, ReturnType<typeof buildMetalRegimeTimeline>[number]>();
    if (symbol === 'SGE_AGTD') {
      const goldAsset = getMetalAsset('XAUUSD');
      const goldPrices: MetalDailyPrice[] = goldAsset ? filterMetalTradingPrices(await db.all(
        `SELECT trade_date, open, high, low, close, volume, amount 
         FROM financial_daily_prices 
         WHERE symbol = ? AND source = ? 
         ORDER BY trade_date ASC`,
        ['XAUUSD', goldAsset.source]
      )) : [];
      goldTimelineByDate = new Map(buildMetalRegimeTimeline(goldPrices, goldAsset?.source || 'twelvedata').map(item => [item.price.trade_date, item]));
    }

    const inRangeTimeline = timeline
      .filter(item => item.price.trade_date >= startDate && item.price.trade_date <= endDate)
      .slice(-maxItems);

    const items = inRangeTimeline.map((item) => {
      const regime = item.regime;
      const currentIndex = item.index;
      const future3 = timelineByIndex.get(currentIndex + 3)?.regime;
      const future5 = timelineByIndex.get(currentIndex + 5)?.regime;
      const future10 = timelineByIndex.get(currentIndex + 10)?.regime;
      const future20 = timelineByIndex.get(currentIndex + 20)?.regime;
      const breakLow3 = breaksRecentLow(allPrices, currentIndex, 3, 20);
      const breakLow5 = breaksRecentLow(allPrices, currentIndex, 5, 20);
      const breakLow20 = breaksRecentLow(allPrices, currentIndex, 20, 20);
      const goldTimeline = symbol === 'SGE_AGTD' ? goldTimelineByDate.get(item.price.trade_date) : item;
      const goldStateCode = goldTimeline?.regime.state_code || null;
      const goldGatePass = symbol !== 'SGE_AGTD' || isMetalSafeOrTrend(goldStateCode || undefined);
      const latestChange = regime.latest_change ?? 0;
      const noFlyingKnifeBlocked = regime.state_code === 'RISK'
        || (regime.abnormal_move && latestChange <= -0.04)
        || Boolean(regime.lower_low && (regime.drawdown_20 ?? 0) <= -0.06);
      const survived3d = future3 ? Boolean(isMetalSafeOrTrend(future3.state_code) && breakLow3 === false) : null;
      const survived5d = future5 ? Boolean(isMetalSafeOrTrend(future5.state_code) && breakLow5 === false) : null;
      const signalCandidate = isMetalSignalCandidate(regime.state_code);
      const shortLivedSignal = signalCandidate && survived5d === false;
      const action = classifyMetalRuleAction(regime, item.safe_confirmation_days, goldGatePass, noFlyingKnifeBlocked);

      return {
        symbol,
        trade_date: regime.trade_date,
        close: regime.close,
        state_code: regime.state_code,
        state_label: METAL_STATE_CODES.includes(regime.state_code) ? regime.state_code : 'UNKNOWN',
        state_reason: regime.state_reason,
        short_label: regime.short_label,
        mid_label: regime.mid_label,
        long_label: regime.long_label,
        cycle_label: regime.cycle_label,
        distance_to_ma60: regime.distance_to_ma60,
        recent_return_5: regime.recent_return_5,
        recent_return_20: regime.recent_return_20,
        drawdown_20: regime.drawdown_20,
        range_ratio_5: regime.range_ratio_5,
        range_ratio_20: regime.range_ratio_20,
        lower_low: regime.lower_low,
        abnormal_move: regime.abnormal_move,
        behavior_tags: regime.behavior_tags,
        state_continuation_days: item.state_continuation_days,
        safe_confirmation_days: item.safe_confirmation_days,
        safe_zone_days: item.safe_zone_days,
        signal_maturity: item.signal_maturity,
        signal_maturity_label: item.signal_maturity_label,
        signal_maturity_reason: item.signal_maturity_reason,
        gold_gate_pass: goldGatePass,
        gold_state_code: goldStateCode,
        no_flying_knife_blocked: noFlyingKnifeBlocked,
        rule_signal: signalCandidate ? 'SIGNAL_CANDIDATE' : 'NO_SIGNAL',
        ...action,
        labels: {
          label_status: future20 ? 'complete' : future5 ? 'partial' : 'pending',
          future_return_3d: getFutureReturn(allPrices, currentIndex, 3),
          future_return_5d: getFutureReturn(allPrices, currentIndex, 5),
          future_return_10d: getFutureReturn(allPrices, currentIndex, 10),
          future_return_20d: getFutureReturn(allPrices, currentIndex, 20),
          future_max_drawdown_20d: getFutureMaxDrawdown(allPrices, currentIndex, 20),
          break_recent_low_20d: breakLow20,
          survived_3d: survived3d,
          survived_5d: survived5d,
          short_lived_signal: shortLivedSignal,
          future_state_3d: future3?.state_code || null,
          future_state_5d: future5?.state_code || null,
          future_state_10d: future10?.state_code || null,
          future_state_20d: future20?.state_code || null
        }
      };
    });

    const completeItems = items.filter(item => item.labels.label_status === 'complete');
    const safeConfirmedItems = items.filter(item => item.state_code === 'SAFE_CONFIRMED');
    const effectiveItems = items.filter(item => item.safe_confirmation_days >= 5);
    const return20Values = safeConfirmedItems
      .map(item => item.labels.future_return_20d)
      .filter((value): value is number => typeof value === 'number');

    res.json({
      success: true,
      data: {
        symbol,
        asset_name: asset.name,
        rule_version: 'metal_rule_lab_v0.1',
        start_date: startDate,
        end_date: endDate,
        no_lookahead_note: '规则信号只使用截面日及以前数据；未来收益、回撤、破低和存活状态仅作为后验标签。',
        summary: {
          total_samples: items.length,
          complete_label_count: completeItems.length,
          signal_candidate_count: items.filter(item => item.rule_signal === 'SIGNAL_CANDIDATE').length,
          safe_confirmed_count: safeConfirmedItems.length,
          effective_confirmed_count: effectiveItems.length,
          short_lived_count: items.filter(item => item.labels.short_lived_signal).length,
          no_flying_knife_block_count: items.filter(item => item.no_flying_knife_blocked).length,
          gold_gate_block_count: items.filter(item => !item.gold_gate_pass).length,
          avg_safe_confirmed_return_20d: return20Values.length ? roundNumber(average(return20Values), 4) : null
        },
        items
      }
    });
  } catch (error) {
    logRead(`贵金属规则实验回放失败: ${(error as Error).message}`, req.body.symbol);
    console.error('Error running metal rule lab replay:', error);
    res.status(500).json({
      success: false,
      message: `规则实验回放失败: ${(error as Error).message}`
    });
  }
});

router.post('/rule-lab/samples/save', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = req.body.symbol || 'SGE_AGTD';
    logUpdate(`贵金属规则样本落库: ${symbol}`, symbol);

    const replay = await buildMetalRuleReplay(db, {
      symbol,
      start_date: req.body.start_date,
      end_date: req.body.end_date,
      limit: req.body.limit
    });
    const saveResult = await saveMetalRuleReplaySamples(db, replay, req.body.saved_from || 'manual_replay');

    res.json({
      success: true,
      message: `贵金属规则样本已落库：新增 ${saveResult.inserted} 条，更新 ${saveResult.updated} 条`,
      data: {
        ...saveResult,
        symbol: replay.symbol,
        asset_name: replay.asset_name,
        rule_version: replay.rule_version,
        start_date: replay.start_date,
        end_date: replay.end_date,
        summary: replay.summary
      }
    });
  } catch (error) {
    logUpdate(`贵金属规则样本落库失败: ${(error as Error).message}`, req.body.symbol);
    console.error('Error saving metal rule lab samples:', error);
    res.status(500).json({
      success: false,
      message: `样本落库失败: ${(error as Error).message}`
    });
  }
});

router.get('/rule-lab/samples/health', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = String(req.query.symbol || 'all');
    const conditions: string[] = [];
    const params: any[] = [];
    const silverSegmentCase = `CASE
      WHEN gold_gate_pass = 1 AND rule_signal = 'SIGNAL_CANDIDATE' THEN 'GOLD_PASS_SILVER_SIGNAL'
      WHEN gold_gate_pass = 0 THEN 'GOLD_NOT_STABLE_BLOCK'
      WHEN gold_gate_pass = 1 THEN 'GOLD_PASS_NO_SIGNAL'
      ELSE 'UNKNOWN'
    END`;

    if (symbol && symbol !== 'all') {
      conditions.push('symbol = ?');
      params.push(symbol);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.all(
      `SELECT
        symbol,
        MAX(asset_name) as asset_name,
        MAX(source) as source,
        MIN(trade_date) as start_date,
        MAX(trade_date) as end_date,
        MAX(updated_at) as latest_updated_at,
        COUNT(*) as total_samples,
        SUM(CASE WHEN label_status = 'complete' THEN 1 ELSE 0 END) as complete_label_count,
        SUM(CASE WHEN label_status = 'partial' THEN 1 ELSE 0 END) as partial_label_count,
        SUM(CASE WHEN label_status = 'pending' THEN 1 ELSE 0 END) as pending_label_count,
        SUM(CASE WHEN rule_signal = 'SIGNAL_CANDIDATE' THEN 1 ELSE 0 END) as signal_candidate_count,
        SUM(CASE WHEN state_code = 'SAFE_CONFIRMED' THEN 1 ELSE 0 END) as safe_confirmed_count,
        SUM(CASE WHEN safe_confirmation_days >= 5 THEN 1 ELSE 0 END) as effective_confirmed_count,
        SUM(CASE WHEN short_lived_signal = 1 THEN 1 ELSE 0 END) as short_lived_count,
        SUM(CASE WHEN no_flying_knife_blocked = 1 THEN 1 ELSE 0 END) as no_flying_knife_block_count,
        SUM(CASE WHEN gold_gate_pass = 0 THEN 1 ELSE 0 END) as gold_gate_block_count,
        AVG(CASE WHEN label_status = 'complete' THEN future_return_20d ELSE NULL END) as avg_return_20d,
        AVG(CASE WHEN label_status = 'complete' THEN future_max_drawdown_20d ELSE NULL END) as avg_drawdown_20d,
        AVG(CASE WHEN rule_signal = 'SIGNAL_CANDIDATE' THEN future_return_20d ELSE NULL END) as signal_avg_return_20d,
        AVG(CASE WHEN rule_signal = 'SIGNAL_CANDIDATE' THEN future_max_drawdown_20d ELSE NULL END) as signal_avg_drawdown_20d,
        AVG(CASE WHEN state_code = 'SAFE_CONFIRMED' THEN future_return_20d ELSE NULL END) as safe_confirmed_avg_return_20d,
        AVG(CASE WHEN state_code = 'SAFE_CONFIRMED' THEN future_max_drawdown_20d ELSE NULL END) as safe_confirmed_avg_drawdown_20d,
        AVG(CASE WHEN short_lived_signal = 1 THEN future_return_20d ELSE NULL END) as short_lived_avg_return_20d,
        AVG(CASE WHEN short_lived_signal = 1 THEN future_max_drawdown_20d ELSE NULL END) as short_lived_avg_drawdown_20d,
        AVG(CASE WHEN no_flying_knife_blocked = 1 THEN future_return_20d ELSE NULL END) as flying_knife_block_avg_return_20d,
        AVG(CASE WHEN no_flying_knife_blocked = 1 THEN future_max_drawdown_20d ELSE NULL END) as flying_knife_block_avg_drawdown_20d,
        AVG(CASE WHEN gold_gate_pass = 0 THEN future_return_20d ELSE NULL END) as gold_gate_block_avg_return_20d,
        AVG(CASE WHEN gold_gate_pass = 0 THEN future_max_drawdown_20d ELSE NULL END) as gold_gate_block_avg_drawdown_20d
       FROM metal_rule_lab_samples
       ${whereClause}
       GROUP BY symbol
       ORDER BY symbol`,
      params
    );

    const bucketRows = await db.all(
      `SELECT
        symbol,
        rule_action,
        MAX(rule_action_label) as rule_action_label,
        COUNT(*) as total_samples,
        SUM(CASE WHEN label_status = 'complete' THEN 1 ELSE 0 END) as complete_label_count,
        SUM(CASE WHEN short_lived_signal = 1 THEN 1 ELSE 0 END) as short_lived_count,
        AVG(CASE WHEN label_status = 'complete' THEN future_return_20d ELSE NULL END) as avg_return_20d,
        AVG(CASE WHEN label_status = 'complete' THEN future_max_drawdown_20d ELSE NULL END) as avg_drawdown_20d
       FROM metal_rule_lab_samples
       ${whereClause}
       GROUP BY symbol, rule_action
       ORDER BY symbol, total_samples DESC`,
      params
    );

    const bucketsBySymbol = bucketRows.reduce((acc: Record<string, any[]>, row: any) => {
      const actionBucket = {
        rule_action: row.rule_action,
        rule_action_label: row.rule_action_label || row.rule_action,
        total_samples: Number(row.total_samples || 0),
        complete_label_count: Number(row.complete_label_count || 0),
        short_lived_count: Number(row.short_lived_count || 0),
        short_lived_rate: Number(row.total_samples || 0)
          ? roundNumber(Number(row.short_lived_count || 0) / Number(row.total_samples || 0), 4)
          : 0,
        avg_return_20d: toMetricNumber(row.avg_return_20d),
        avg_drawdown_20d: toMetricNumber(row.avg_drawdown_20d)
      };
      if (!acc[row.symbol]) acc[row.symbol] = [];
      acc[row.symbol].push(actionBucket);
      return acc;
    }, {});

    const silverSegmentRows = symbol === 'XAUUSD' ? [] : await db.all(
      `SELECT
        ${silverSegmentCase} as segment_code,
        COUNT(*) as total_samples,
        SUM(CASE WHEN label_status = 'complete' THEN 1 ELSE 0 END) as complete_label_count,
        SUM(CASE WHEN rule_signal = 'SIGNAL_CANDIDATE' THEN 1 ELSE 0 END) as signal_candidate_count,
        SUM(CASE WHEN state_code = 'SAFE_CONFIRMED' THEN 1 ELSE 0 END) as safe_confirmed_count,
        SUM(CASE WHEN safe_confirmation_days >= 5 THEN 1 ELSE 0 END) as effective_confirmed_count,
        SUM(CASE WHEN short_lived_signal = 1 THEN 1 ELSE 0 END) as short_lived_count,
        AVG(CASE WHEN label_status = 'complete' THEN future_return_20d ELSE NULL END) as avg_return_20d,
        AVG(CASE WHEN label_status = 'complete' THEN future_max_drawdown_20d ELSE NULL END) as avg_drawdown_20d,
        AVG(CASE WHEN rule_signal = 'SIGNAL_CANDIDATE' THEN future_return_20d ELSE NULL END) as signal_avg_return_20d,
        AVG(CASE WHEN rule_signal = 'SIGNAL_CANDIDATE' THEN future_max_drawdown_20d ELSE NULL END) as signal_avg_drawdown_20d,
        AVG(CASE WHEN state_code = 'SAFE_CONFIRMED' THEN future_return_20d ELSE NULL END) as safe_confirmed_avg_return_20d,
        AVG(CASE WHEN state_code = 'SAFE_CONFIRMED' THEN future_max_drawdown_20d ELSE NULL END) as safe_confirmed_avg_drawdown_20d,
        AVG(CASE WHEN short_lived_signal = 1 THEN future_return_20d ELSE NULL END) as short_lived_avg_return_20d,
        AVG(CASE WHEN short_lived_signal = 1 THEN future_max_drawdown_20d ELSE NULL END) as short_lived_avg_drawdown_20d
       FROM metal_rule_lab_samples
       WHERE symbol = 'SGE_AGTD'
       GROUP BY segment_code
       ORDER BY
        CASE segment_code
          WHEN 'GOLD_PASS_SILVER_SIGNAL' THEN 1
          WHEN 'GOLD_NOT_STABLE_BLOCK' THEN 2
          WHEN 'GOLD_PASS_NO_SIGNAL' THEN 3
          ELSE 4
        END`
    );

    res.json({
      success: true,
      data: {
        symbol,
        generated_at: new Date().toISOString(),
        items: rows.map((row: any) => normalizeMetalHealthRow(row, bucketsBySymbol[row.symbol] || [])),
        silver_segments: silverSegmentRows.map(normalizeSilverSegmentRow)
      }
    });
  } catch (error) {
    console.error('Error getting metal rule lab sample health:', error);
    res.status(500).json({
      success: false,
      message: `获取贵金属样本体检失败: ${(error as Error).message}`
    });
  }
});

router.get('/rule-lab/silver-validation', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const caseLimit = Math.min(Math.max(Number(req.query.case_limit || 5), 1), 20);
    const bigUpThreshold = Number.isFinite(Number(req.query.big_up_threshold))
      ? Number(req.query.big_up_threshold)
      : 0.08;
    const drawdownLine = Number.isFinite(Number(req.query.drawdown_line))
      ? Number(req.query.drawdown_line)
      : -0.06;
    const silverSegmentCase = `CASE
      WHEN s.gold_gate_pass = 1 AND s.rule_signal = 'SIGNAL_CANDIDATE' THEN 'GOLD_PASS_SILVER_SIGNAL'
      WHEN s.gold_gate_pass = 0 THEN 'GOLD_NOT_STABLE_BLOCK'
      WHEN s.gold_gate_pass = 1 THEN 'GOLD_PASS_NO_SIGNAL'
      ELSE 'UNKNOWN'
    END`;
    const segmentedCte = `WITH segmented AS (
      SELECT
        ${silverSegmentCase} as segment_code,
        s.*,
        fx.usd_cny_mid,
        fx.usd_cny_change_5d,
        fx.usd_cny_change_20d,
        fx.cny_state,
        fx.fx_tailwind_for_silver
      FROM metal_rule_lab_samples s
      LEFT JOIN fx_daily_rates fx
        ON fx.trade_date = s.trade_date
       AND fx.ts_code = 'USDCNH.FXCM'
       AND fx.source = 'tushare_fxcm'
      WHERE s.symbol = 'SGE_AGTD'
    )`;

    const segmentRows = await db.all(
      `${segmentedCte}
       SELECT
        segment_code,
        COUNT(*) as total_samples,
        SUM(CASE WHEN label_status = 'complete' THEN 1 ELSE 0 END) as complete_label_count,
        SUM(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' THEN 1 ELSE 0 END) as signal_candidate_count,
        SUM(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' AND short_lived_signal = 1 THEN 1 ELSE 0 END) as signal_short_lived_count,
        SUM(CASE WHEN label_status = 'complete' AND state_code = 'SAFE_CONFIRMED' THEN 1 ELSE 0 END) as safe_confirmed_count,
        SUM(CASE WHEN label_status = 'complete' AND safe_confirmation_days >= 5 THEN 1 ELSE 0 END) as effective_confirmed_count,
        AVG(CASE WHEN label_status = 'complete' THEN future_return_20d ELSE NULL END) as avg_return_20d,
        AVG(CASE WHEN label_status = 'complete' THEN future_max_drawdown_20d ELSE NULL END) as avg_drawdown_20d,
        AVG(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' THEN future_return_20d ELSE NULL END) as signal_avg_return_20d,
        AVG(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' THEN future_max_drawdown_20d ELSE NULL END) as signal_avg_drawdown_20d,
        SUM(CASE WHEN label_status = 'complete' AND future_return_20d >= ? THEN 1 ELSE 0 END) as big_up_count,
        SUM(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' AND future_return_20d >= ? THEN 1 ELSE 0 END) as signal_big_up_count,
        SUM(CASE WHEN label_status = 'complete' AND future_max_drawdown_20d <= ? THEN 1 ELSE 0 END) as deep_drawdown_count,
        SUM(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' AND future_max_drawdown_20d <= ? THEN 1 ELSE 0 END) as signal_deep_drawdown_count
       FROM segmented
       GROUP BY segment_code
       ORDER BY
        CASE segment_code
          WHEN 'GOLD_PASS_SILVER_SIGNAL' THEN 1
          WHEN 'GOLD_NOT_STABLE_BLOCK' THEN 2
          WHEN 'GOLD_PASS_NO_SIGNAL' THEN 3
          ELSE 4
        END`,
      [bigUpThreshold, bigUpThreshold, drawdownLine, drawdownLine]
    );

    const yearRows = await db.all(
      `${segmentedCte}
       SELECT
        strftime('%Y', trade_date) as year,
        segment_code,
        SUM(CASE WHEN label_status = 'complete' THEN 1 ELSE 0 END) as complete_label_count,
        SUM(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' THEN 1 ELSE 0 END) as signal_candidate_count,
        SUM(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' AND short_lived_signal = 1 THEN 1 ELSE 0 END) as signal_short_lived_count,
        AVG(CASE WHEN label_status = 'complete' THEN future_return_20d ELSE NULL END) as avg_return_20d,
        AVG(CASE WHEN label_status = 'complete' THEN future_max_drawdown_20d ELSE NULL END) as avg_drawdown_20d,
        AVG(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' THEN future_return_20d ELSE NULL END) as signal_avg_return_20d,
        AVG(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' THEN future_max_drawdown_20d ELSE NULL END) as signal_avg_drawdown_20d
       FROM segmented
       WHERE label_status = 'complete'
       GROUP BY year, segment_code
       ORDER BY year DESC,
        CASE segment_code
          WHEN 'GOLD_PASS_SILVER_SIGNAL' THEN 1
          WHEN 'GOLD_NOT_STABLE_BLOCK' THEN 2
          WHEN 'GOLD_PASS_NO_SIGNAL' THEN 3
          ELSE 4
        END`
    );

    const actionRows = await db.all(
      `${segmentedCte}
       SELECT
        segment_code,
        rule_action,
        MAX(rule_action_label) as rule_action_label,
        COUNT(*) as total_samples,
        SUM(CASE WHEN label_status = 'complete' THEN 1 ELSE 0 END) as complete_label_count,
        SUM(CASE WHEN label_status = 'complete' AND short_lived_signal = 1 THEN 1 ELSE 0 END) as short_lived_count,
        AVG(CASE WHEN label_status = 'complete' THEN future_return_20d ELSE NULL END) as avg_return_20d,
        AVG(CASE WHEN label_status = 'complete' THEN future_max_drawdown_20d ELSE NULL END) as avg_drawdown_20d
       FROM segmented
       GROUP BY segment_code, rule_action
       ORDER BY segment_code, total_samples DESC`
    );

    const fxBucketRows = await db.all(
      `${segmentedCte}
       SELECT
        segment_code,
        COALESCE(cny_state, '无汇率') as cny_state,
        COALESCE(fx_tailwind_for_silver, '无汇率') as fx_tailwind_for_silver,
        SUM(CASE WHEN label_status = 'complete' THEN 1 ELSE 0 END) as complete_label_count,
        SUM(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' THEN 1 ELSE 0 END) as signal_candidate_count,
        SUM(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' AND short_lived_signal = 1 THEN 1 ELSE 0 END) as signal_short_lived_count,
        AVG(CASE WHEN label_status = 'complete' THEN future_return_20d ELSE NULL END) as avg_return_20d,
        AVG(CASE WHEN label_status = 'complete' THEN future_max_drawdown_20d ELSE NULL END) as avg_drawdown_20d,
        AVG(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' THEN future_return_20d ELSE NULL END) as signal_avg_return_20d,
        AVG(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' THEN future_max_drawdown_20d ELSE NULL END) as signal_avg_drawdown_20d,
        SUM(CASE WHEN label_status = 'complete' AND future_max_drawdown_20d <= ? THEN 1 ELSE 0 END) as deep_drawdown_count,
        SUM(CASE WHEN label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' AND future_max_drawdown_20d <= ? THEN 1 ELSE 0 END) as signal_deep_drawdown_count
       FROM segmented
       WHERE label_status = 'complete'
       GROUP BY segment_code, fx_tailwind_for_silver, cny_state
       ORDER BY
        CASE segment_code
          WHEN 'GOLD_PASS_SILVER_SIGNAL' THEN 1
          WHEN 'GOLD_NOT_STABLE_BLOCK' THEN 2
          WHEN 'GOLD_PASS_NO_SIGNAL' THEN 3
          ELSE 4
        END,
        CASE fx_tailwind_for_silver
          WHEN '顺风' THEN 1
          WHEN '中性' THEN 2
          WHEN '逆风' THEN 3
          ELSE 4
        END`,
      [drawdownLine, drawdownLine]
    );

    const latestFx = await db.get(
      `SELECT trade_date, ts_code, source, usd_cny_mid, usd_cny_change_5d, usd_cny_change_20d,
              cny_state, fx_tailwind_for_silver
       FROM fx_daily_rates
       WHERE ts_code = 'USDCNH.FXCM' AND source = 'tushare_fxcm'
       ORDER BY trade_date DESC
       LIMIT 1`
    );

    const fxCoverage = await db.get(
      `${segmentedCte}
       SELECT
        COUNT(*) as total_samples,
        SUM(CASE WHEN usd_cny_mid IS NOT NULL THEN 1 ELSE 0 END) as matched_samples,
        SUM(CASE WHEN label_status = 'complete' THEN 1 ELSE 0 END) as complete_label_count,
        SUM(CASE WHEN label_status = 'complete' AND usd_cny_mid IS NOT NULL THEN 1 ELSE 0 END) as matched_complete_count
       FROM segmented`
    );

    const caseSelect = `SELECT
        ? as case_type,
        id, trade_date, close, state_code, state_label, rule_action, rule_action_label,
        rule_signal, segment_code, gold_state_code, safe_confirmation_days, signal_maturity_label,
        cny_state, fx_tailwind_for_silver, usd_cny_mid, usd_cny_change_5d, usd_cny_change_20d,
        future_return_20d, future_max_drawdown_20d, survived_5d, short_lived_signal
       FROM segmented`;
    const caseQueries = [
      {
        type: 'blocked_short_lived',
        where: `segment_code = 'GOLD_NOT_STABLE_BLOCK' AND label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' AND short_lived_signal = 1`,
        order: 'future_max_drawdown_20d ASC, trade_date DESC'
      },
      {
        type: 'blocked_big_up',
        where: `segment_code = 'GOLD_NOT_STABLE_BLOCK' AND label_status = 'complete' AND rule_signal = 'SIGNAL_CANDIDATE' AND future_return_20d >= ?`,
        order: 'future_return_20d DESC, trade_date DESC',
        extraParams: [bigUpThreshold]
      },
      {
        type: 'main_short_lived',
        where: `segment_code = 'GOLD_PASS_SILVER_SIGNAL' AND label_status = 'complete' AND short_lived_signal = 1`,
        order: 'future_max_drawdown_20d ASC, trade_date DESC'
      },
      {
        type: 'main_success',
        where: `segment_code = 'GOLD_PASS_SILVER_SIGNAL' AND label_status = 'complete' AND survived_5d = 1 AND future_return_20d > 0`,
        order: 'future_return_20d DESC, trade_date DESC'
      },
      {
        type: 'control_big_up',
        where: `segment_code = 'GOLD_PASS_NO_SIGNAL' AND label_status = 'complete' AND future_return_20d >= ?`,
        order: 'future_return_20d DESC, trade_date DESC',
        extraParams: [bigUpThreshold]
      }
    ];
    const caseGroups = await Promise.all(caseQueries.map(item => db.all(
      `${segmentedCte}
       ${caseSelect}
       WHERE ${item.where}
       ORDER BY ${item.order}
       LIMIT ?`,
      [item.type, ...(item.extraParams || []), caseLimit]
    )));
    const cases = caseGroups.flat().map(normalizeSilverValidationCase);
    const actionBuckets = actionRows.map((row: any) => ({
      segment_code: row.segment_code || 'UNKNOWN',
      segment_label: getSilverSegmentMeta(row.segment_code || 'UNKNOWN').label,
      rule_action: row.rule_action,
      rule_action_label: row.rule_action_label || row.rule_action,
      total_samples: Number(row.total_samples || 0),
      complete_label_count: Number(row.complete_label_count || 0),
      short_lived_count: Number(row.short_lived_count || 0),
      short_lived_rate: Number(row.complete_label_count || 0)
        ? roundNumber(Number(row.short_lived_count || 0) / Number(row.complete_label_count || 0), 4)
        : 0,
      avg_return_20d: toMetricNumber(row.avg_return_20d),
      avg_drawdown_20d: toMetricNumber(row.avg_drawdown_20d)
    }));

    res.json({
      success: true,
      data: {
        symbol: 'SGE_AGTD',
        generated_at: new Date().toISOString(),
        thresholds: {
          big_up_20d: bigUpThreshold,
          deep_drawdown_20d: drawdownLine
        },
        no_training_note: '白银当前只做分层验收：黄金通过后的主样本、黄金未稳拦截样本、黄金通过但白银未触发的对照样本。暂不启动白银训练。',
        fx_note: '汇率字段来自 Tushare USDCNH.FXCM，按 bid/ask close 计算离岸人民币市场中间价；这里只作为白银分层辅助风向，不给入场权限。',
        latest_fx: normalizeLatestFxRow(latestFx),
        fx_coverage: {
          total_samples: Number(fxCoverage?.total_samples || 0),
          matched_samples: Number(fxCoverage?.matched_samples || 0),
          complete_label_count: Number(fxCoverage?.complete_label_count || 0),
          matched_complete_count: Number(fxCoverage?.matched_complete_count || 0),
          matched_rate: Number(fxCoverage?.total_samples || 0)
            ? roundNumber(Number(fxCoverage?.matched_samples || 0) / Number(fxCoverage?.total_samples || 0), 4)
            : 0
        },
        conclusion: buildSilverLayerConclusion(segmentRows),
        segments: segmentRows.map(normalizeSilverValidationRow),
        fx_buckets: fxBucketRows.map(normalizeSilverFxBucketRow),
        yearly: yearRows.map(normalizeSilverValidationYearRow),
        action_buckets: actionBuckets,
        cases
      }
    });
  } catch (error) {
    console.error('Error getting silver layer validation:', error);
    res.status(500).json({
      success: false,
      message: `获取白银分层验收失败: ${(error as Error).message}`
    });
  }
});

router.get('/rule-lab/samples', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const page = Math.max(Number(req.query.page || 1), 1);
    const pageSize = Math.min(Math.max(Number(req.query.page_size || 20), 5), 100);
    const offset = (page - 1) * pageSize;
    const symbol = String(req.query.symbol || 'SGE_AGTD');
    const labelStatus = String(req.query.label_status || '');
    const ruleSignal = String(req.query.rule_signal || '');
    const ruleAction = String(req.query.rule_action || '');

    const conditions: string[] = [];
    const params: any[] = [];

    if (symbol && symbol !== 'all') {
      conditions.push('symbol = ?');
      params.push(symbol);
    }
    if (labelStatus && labelStatus !== 'all') {
      conditions.push('label_status = ?');
      params.push(labelStatus);
    }
    if (ruleSignal && ruleSignal !== 'all') {
      conditions.push('rule_signal = ?');
      params.push(ruleSignal);
    }
    if (ruleAction && ruleAction !== 'all') {
      conditions.push('rule_action = ?');
      params.push(ruleAction);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalRow = await db.get(
      `SELECT COUNT(*) as total FROM metal_rule_lab_samples ${whereClause}`,
      params
    );
    const items = await db.all(
      `SELECT
        id, symbol, asset_name, source, trade_date, rule_version, close,
        state_code, state_label, short_label, mid_label, long_label, cycle_label,
        distance_to_ma60, recent_return_5, recent_return_20, drawdown_20, range_ratio_20,
        state_continuation_days, safe_confirmation_days, safe_zone_days,
        signal_maturity, signal_maturity_label, gold_gate_pass, gold_state_code,
        no_flying_knife_blocked, rule_signal, rule_action, rule_action_label, rule_action_reason,
        label_status, future_return_3d, future_return_5d, future_return_10d, future_return_20d,
        future_max_drawdown_20d, break_recent_low_20d, survived_3d, survived_5d,
        short_lived_signal, future_state_3d, future_state_5d, future_state_10d, future_state_20d,
        saved_from, replay_start_date, replay_end_date, created_at, updated_at
       FROM metal_rule_lab_samples
       ${whereClause}
       ORDER BY trade_date DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    const summary = await db.get(
      `SELECT
        COUNT(*) as total_samples,
        SUM(CASE WHEN label_status = 'complete' THEN 1 ELSE 0 END) as complete_label_count,
        SUM(CASE WHEN rule_signal = 'SIGNAL_CANDIDATE' THEN 1 ELSE 0 END) as signal_candidate_count,
        SUM(CASE WHEN state_code = 'SAFE_CONFIRMED' THEN 1 ELSE 0 END) as safe_confirmed_count,
        SUM(CASE WHEN safe_confirmation_days >= 5 THEN 1 ELSE 0 END) as effective_confirmed_count,
        SUM(CASE WHEN short_lived_signal = 1 THEN 1 ELSE 0 END) as short_lived_count,
        SUM(CASE WHEN no_flying_knife_blocked = 1 THEN 1 ELSE 0 END) as no_flying_knife_block_count,
        SUM(CASE WHEN gold_gate_pass = 0 THEN 1 ELSE 0 END) as gold_gate_block_count,
        AVG(CASE WHEN state_code = 'SAFE_CONFIRMED' THEN future_return_20d ELSE NULL END) as avg_safe_confirmed_return_20d
       FROM metal_rule_lab_samples
       ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: {
        items,
        summary,
        pagination: {
          page,
          page_size: pageSize,
          total: totalRow?.total || 0,
          total_pages: Math.ceil((totalRow?.total || 0) / pageSize)
        }
      }
    });
  } catch (error) {
    console.error('Error getting metal rule lab samples:', error);
    res.status(500).json({
      success: false,
      message: `获取贵金属规则样本失败: ${(error as Error).message}`
    });
  }
});

router.get('/rule-lab/gold-rule-report', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const report = await buildGoldRuleContrastReport(db);
    const latestSaved = await db.get(
      `SELECT id, symbol, report_key, report_date, rule_version, status,
              conclusion_label, conclusion_text, metrics_json, checks_json,
              report_json, saved_from, created_at, updated_at
       FROM metal_rule_contrast_reports
       WHERE symbol = 'XAUUSD'
         AND report_key = 'gold_rule_contrast'
       ORDER BY id DESC
       LIMIT 1`
    );

    res.json({
      success: true,
      data: {
        report,
        latest_saved: normalizeGoldRuleReportRow(latestSaved)
      }
    });
  } catch (error) {
    console.error('Error getting gold rule contrast report:', error);
    res.status(500).json({
      success: false,
      message: `获取黄金规则对照报告失败: ${(error as Error).message}`
    });
  }
});

router.post('/rule-lab/gold-rule-report/generate', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const report = await buildGoldRuleContrastReport(db);
    await persistGoldRuleContrastReport(db, report, req.body?.saved_from || 'manual_generate');

    res.json({
      success: true,
      message: `黄金规则对照报告已生成：${report.conclusion.label}`,
      data: {
        report
      }
    });
  } catch (error) {
    console.error('Error generating gold rule contrast report:', error);
    res.status(500).json({
      success: false,
      message: `生成黄金规则对照报告失败: ${(error as Error).message}`
    });
  }
});

router.get('/rule-lab/training/pipeline-status', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureMetalRuleContrastReportTable(db);
    await ensureMetalModelValidationReportTable(db);
    const includeDetail = String(req.query.detail || '') === 'full';
    const taskKey = 'precious_metals_training_pipeline';
    const task = await db.get(
      `SELECT id, task_key, name, domain, task_type, enabled, schedule_time, schedule_days,
              priority, config_json, last_status, last_message, last_run_at, updated_at
       FROM task_center_tasks
       WHERE task_key = ?`,
      [taskKey]
    );
    const latestRun = await db.get(
      `SELECT id, task_key, trigger_type, status, started_at, finished_at, message, result_json
       FROM task_center_runs
       WHERE task_key = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
      [taskKey]
    );
    const recentRuns = await db.all(
      `SELECT id, trigger_type, status, started_at, finished_at, message
       FROM task_center_runs
       WHERE task_key = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 8`,
      [taskKey]
    );
    const latestGate = await db.get(
      `SELECT id, symbol, gate_key, status, passed, metrics_json, checks_json,
              thresholds_json, reason, created_at, updated_at
       FROM metal_training_gate_runs
       WHERE symbol = 'SGE_AGTD'
         AND gate_key = 'silver_auxiliary_training_gate'
       ORDER BY id DESC
       LIMIT 1`
    );
    const latestGoldReport = await db.get(
      `SELECT id, symbol, report_key, report_date, rule_version, status,
              conclusion_label, conclusion_text, metrics_json, checks_json,
              report_json, saved_from, created_at, updated_at
       FROM metal_rule_contrast_reports
       WHERE symbol = 'XAUUSD'
         AND report_key = 'gold_rule_contrast'
       ORDER BY id DESC
       LIMIT 1`
    );
    const latestGoldModelReport = await db.get(
      `SELECT id, symbol, domain, model_run_id, report_key, status,
              conclusion_label, conclusion_text, metrics_json, checks_json,
              report_json, saved_from, created_at, updated_at
       FROM metal_model_validation_reports
       WHERE symbol = 'XAUUSD'
         AND report_key = 'gold_model_validation'
       ORDER BY id DESC
       LIMIT 1`
    );

    res.json({
      success: true,
      data: {
        generated_at: new Date().toISOString(),
        task: task ? {
          ...task,
          enabled: Boolean(task.enabled),
          config: safeJsonParse(task.config_json, {})
        } : null,
        latest_run: latestRun ? {
          ...latestRun,
          result: includeDetail
            ? safeJsonParse(latestRun.result_json, null)
            : compactPreciousMetalPipelineResult(safeJsonParse(latestRun.result_json, null))
        } : null,
        recent_runs: recentRuns,
        latest_gate: latestGate ? {
          id: latestGate.id,
          symbol: latestGate.symbol,
          gate_key: latestGate.gate_key,
          status: latestGate.status,
          passed: Boolean(latestGate.passed),
          metrics: safeJsonParse(latestGate.metrics_json, {}),
          checks: safeJsonParse(latestGate.checks_json, []),
          thresholds: safeJsonParse(latestGate.thresholds_json, {}),
          reason: latestGate.reason,
          created_at: latestGate.created_at,
          updated_at: latestGate.updated_at
        } : null,
        latest_gold_report: normalizeGoldRuleReportRow(latestGoldReport, { includeReport: includeDetail }),
        latest_gold_model_report: normalizeGoldModelValidationReportRow(latestGoldModelReport, { includeReport: includeDetail })
      }
    });
  } catch (error) {
    console.error('Error getting precious metal training pipeline status:', error);
    res.status(500).json({
      success: false,
      message: `获取贵金属训练流水线状态失败: ${(error as Error).message}`
    });
  }
});

router.get('/rule-lab/training/gold-validation-report', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureMetalModelValidationReportTable(db);
    const latestSaved = await db.get(
      `SELECT id, symbol, domain, model_run_id, report_key, status,
              conclusion_label, conclusion_text, metrics_json, checks_json,
              report_json, saved_from, created_at, updated_at
       FROM metal_model_validation_reports
       WHERE symbol = 'XAUUSD'
         AND report_key = 'gold_model_validation'
       ORDER BY id DESC
       LIMIT 1`
    );

    const latestSavedReport = normalizeGoldModelValidationReportRow(latestSaved);

    res.json({
      success: true,
      data: {
        report: latestSavedReport?.report || null,
        latest_saved: latestSavedReport
      }
    });
  } catch (error) {
    console.error('Error getting gold model validation report:', error);
    res.status(500).json({
      success: false,
      message: `获取黄金模型验收报告失败: ${(error as Error).message}`
    });
  }
});

router.post('/rule-lab/training/gold-validation-report/generate', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const caseLimit = Math.min(Math.max(Number(req.body?.case_limit || 8), 1), 20);
    const report = await buildGoldModelValidationReport(caseLimit);
    await persistGoldModelValidationReport(db, report, req.body?.saved_from || 'manual_generate');

    res.json({
      success: true,
      message: `黄金模型验收报告已生成：${report.conclusion?.label || '暂无结论'}`,
      data: {
        report
      }
    });
  } catch (error) {
    console.error('Error generating gold model validation report:', error);
    res.status(500).json({
      success: false,
      message: `生成黄金模型验收报告失败: ${(error as Error).message}`
    });
  }
});

router.get('/rule-lab/training/summary', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const symbol = String(req.query.symbol || 'all');
    const symbols = symbol === 'all' ? ['XAUUSD', 'SGE_AGTD'] : [symbol];
    const items = await Promise.all(symbols.map(async item => getLatestMetalTrainingSummary(db, item)));

    res.json({
      success: true,
      data: {
        symbol,
        generated_at: new Date().toISOString(),
        output_root: preciousMetalTrainingRoot,
        no_lookahead_note: '训练特征只来自截面日及以前；未来收益、回撤、破低和存活只作为后验标签。模型只做概率解释，不给交易许可。',
        items
      }
    });
  } catch (error) {
    console.error('Error getting metal model training summary:', error);
    res.status(500).json({
      success: false,
      message: `获取贵金属模型训练摘要失败: ${(error as Error).message}`
    });
  }
});

router.get('/rule-lab/training/score', async (req: Request, res: Response) => {
  try {
    const symbol = String(req.query.symbol || 'XAUUSD');
    const caseLimit = Math.min(Math.max(Number(req.query.case_limit || 6), 1), 20);
    const boundary = getMetalTrainingBoundary(symbol);

    if (!boundary.allowed) {
      res.status(400).json({
        success: false,
        message: boundary.reason,
        data: {
          symbol,
          boundary
        }
      });
      return;
    }

    logRead('读取贵金属模型评分与历史验收', symbol);
    const result = await runMetalScoringWorker(symbol, caseLimit);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error scoring metal model:', error);
    res.status(500).json({
      success: false,
      message: `贵金属模型评分失败: ${(error as Error).message}`
    });
  }
});

router.post('/rule-lab/training/run', async (req: Request, res: Response) => {
  try {
    const symbol = String(req.body.symbol || 'XAUUSD');
    const boundary = getMetalTrainingBoundary(symbol);

    if (!boundary.allowed) {
      res.status(400).json({
        success: false,
        message: boundary.reason,
        data: {
          symbol,
          boundary
        }
      });
      return;
    }

    logUpdate('开始贵金属本地模型训练', symbol);
    const result = await runMetalTrainingWorker(symbol);
    const db = await getDb();
    const latest = await getLatestMetalTrainingSummary(db, symbol);

    res.json({
      success: true,
      message: '黄金本地模型实验训练完成',
      data: {
        result,
        latest
      }
    });
  } catch (error) {
    console.error('Error running metal model training:', error);
    res.status(500).json({
      success: false,
      message: `贵金属模型训练失败: ${(error as Error).message}`
    });
  }
});

export default router;
