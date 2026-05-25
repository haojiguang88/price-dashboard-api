import { getMarketAssetMeta } from './industryEtfStrengthService';

export interface DailyPrice {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  updated_at?: string;
}

export interface MarketBehaviorTag {
  code: string;
  label: string;
  tone: 'good' | 'warn' | 'risk' | 'neutral';
  reason: string;
}

export interface MarketRegime {
  symbol: string;
  name: string;
  trade_date: string;
  close: number;
  ma20: number | null;
  ma20_slope: string;
  ma60: number;
  ma60_prev: number;
  ma60_slope: string;
  ma120: number | null;
  ma120_prev: number | null;
  ma120_slope: string;
  ma250: number | null;
  ma250_prev: number | null;
  ma250_slope: string;
  low_60: number | null;
  low_120: number | null;
  cross_count_10: number;
  above_ma60_days: number;
  below_ma60_days: number;
  drawdown_20: number | null;
  drawdown_60: number | null;
  drawdown_120: number | null;
  latest_change: number | null;
  distance_to_ma60: number;
  distance_to_ma250: number | null;
  higher_high: boolean;
  higher_low: boolean;
  lower_high: boolean;
  lower_low: boolean;
  sideways: boolean;
  up_days: number;
  down_days: number;
  market_regime: string;
  result_reason: string;
  entry_permission: string;
  entry_reason: string;
  rule_version: string;
  cycle_layer_version: string;
  short_state: string;
  short_label: string;
  short_reason: string;
  mid_state: string;
  mid_label: string;
  mid_reason: string;
  long_state: string;
  long_label: string;
  long_reason: string;
  behavior_tags: MarketBehaviorTag[];
  is_mock?: boolean;
  source?: string;
}

function roundNumber(value: number | null | undefined, digits = 2): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function calculateCloseAverage(prices: DailyPrice[], window: number, endExclusive = prices.length): number | null {
  if (endExclusive < window) return null;
  const slice = prices.slice(endExclusive - window, endExclusive);
  if (slice.length < window) return null;
  return slice.reduce((sum, price) => sum + price.close, 0) / window;
}

function getSlope(current: number | null, previous: number | null): string {
  if (current === null || previous === null) return 'unknown';
  if (current > previous) return 'up';
  if (current < previous) return 'down';
  return 'flat';
}

function percentChange(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined || previous === 0) return null;
  return current / previous - 1;
}

function averageDailyRange(prices: DailyPrice[]): number | null {
  if (prices.length === 0) return null;
  const values = prices
    .map(price => {
      const close = price.close || 0;
      if (close <= 0) return null;
      const high = price.high || price.close;
      const low = price.low || price.close;
      return (high - low) / close;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countTrailingDirectionDays(prices: DailyPrice[], direction: 'up' | 'down'): number {
  let count = 0;
  for (let i = prices.length - 1; i > 0; i--) {
    const current = prices[i].close;
    const previous = prices[i - 1].close;
    if (direction === 'up' && current > previous) {
      count++;
      continue;
    }
    if (direction === 'down' && current < previous) {
      count++;
      continue;
    }
    break;
  }
  return count;
}

export function getMarketRegimeShortLabel(regime: string): string {
  switch (regime) {
    case 'NORMAL': return '中期正常区';
    case 'NORMAL_CONFIRMED': return '中期正常确认区';
    case 'RISK': return '中期风险区';
    case 'CRASH_WARNING': return '中期股灾预警';
    case 'CRASH': return '中期冻结区';
    case 'DEEP_CRASH': return '中期深度股灾区';
    case 'REBUILD_WATCH': return '中期修复观察区';
    case 'UNKNOWN': return '中期状态未确认';
    default: return regime;
  }
}

function addBehaviorTag(tags: MarketBehaviorTag[], tag: MarketBehaviorTag) {
  if (!tags.some(item => item.code === tag.code)) {
    tags.push(tag);
  }
}

export function calculateMarketRegime(prices: DailyPrice[], isMock: boolean, source: string, symbol = '000300'): MarketRegime {
  const name = getMarketAssetMeta(symbol).name;
  const ruleVersion = 'market_regime_v1.1';
  const cycleLayerVersion = 'market_cycle_layers_v1';
  
  if (prices.length < 120) {
    return {
      symbol,
      name,
      trade_date: prices.length > 0 ? prices[prices.length - 1].trade_date : '',
      close: prices.length > 0 ? prices[prices.length - 1].close : 0,
      ma20: null,
      ma20_slope: 'unknown',
      ma60: 0,
      ma60_prev: 0,
      ma60_slope: 'unknown',
      ma120: null,
      ma120_prev: null,
      ma120_slope: 'unknown',
      ma250: null,
      ma250_prev: null,
      ma250_slope: 'unknown',
      low_60: null,
      low_120: null,
      cross_count_10: 0,
      above_ma60_days: 0,
      below_ma60_days: 0,
      drawdown_20: 0,
      drawdown_60: 0,
      drawdown_120: 0,
      latest_change: null,
      distance_to_ma60: 0,
      distance_to_ma250: null,
      higher_high: false,
      higher_low: false,
      lower_high: false,
      lower_low: false,
      sideways: false,
      up_days: 0,
      down_days: 0,
      market_regime: 'UNKNOWN',
      result_reason: '历史数据不足120个交易日，暂无法完整判定股灾分级。',
      entry_permission: 'OBSERVE_ONLY',
      entry_reason: '状态不明确，仅观察。',
      rule_version: ruleVersion,
      cycle_layer_version: cycleLayerVersion,
      short_state: 'SHORT_UNKNOWN',
      short_label: '短期状态未确认',
      short_reason: '历史数据不足，暂不能识别短期行为。',
      mid_state: 'UNKNOWN',
      mid_label: '中期状态未确认',
      mid_reason: '历史数据不足120个交易日，暂无法完整判定中期总闸。',
      long_state: 'LONG_UNKNOWN',
      long_label: '长期牛熊未确认',
      long_reason: '历史数据不足250个交易日，暂不能用MA250判断长期牛熊。',
      behavior_tags: [],
      is_mock: isMock,
      source
    };
  }
  
  const latestPrice = prices[prices.length - 1];
  const close = latestPrice.close;
  const trade_date = latestPrice.trade_date;

  const ma20 = calculateCloseAverage(prices, 20);
  const ma20_prev = calculateCloseAverage(prices, 20, prices.length - 1);
  const ma120 = calculateCloseAverage(prices, 120);
  const ma120_prev = calculateCloseAverage(prices, 120, prices.length - 1);
  const ma250 = calculateCloseAverage(prices, 250);
  const ma250_prev = calculateCloseAverage(prices, 250, prices.length - 1);
  const ma20_slope = getSlope(ma20, ma20_prev);
  const ma120_slope = getSlope(ma120, ma120_prev);
  const ma250_slope = getSlope(ma250, ma250_prev);

  const last60Prices = prices.slice(-60);
  const ma60 = last60Prices.reduce((sum, p) => sum + p.close, 0) / 60;
  
  const prev60Prices = prices.slice(-61, -1);
  const ma60_prev = prev60Prices.reduce((sum, p) => sum + p.close, 0) / 60;
  
  let ma60_slope: string;
  if (ma60 < ma60_prev) {
    ma60_slope = 'down';
  } else if (ma60 > ma60_prev) {
    ma60_slope = 'up';
  } else {
    ma60_slope = 'flat';
  }
  
  const low_60 = Math.min(...last60Prices.map(p => p.close));
  
  const last120Prices = prices.slice(-120);
  const low_120 = Math.min(...last120Prices.map(p => p.close));

  const latest_change = prices.length >= 2 ? percentChange(close, prices[prices.length - 2].close) : null;
  const return_5d = prices.length >= 6 ? percentChange(close, prices[prices.length - 6].close) : null;
  
  const close_20_days_ago = prices.length >= 21 ? prices[prices.length - 21].close : null;
  const close_60_days_ago = prices.length >= 61 ? prices[prices.length - 61].close : null;
  const close_120_days_ago = prices.length >= 121 ? prices[prices.length - 121].close : null;
  
  const drawdown_20 = close_20_days_ago !== null ? (close / close_20_days_ago) - 1 : null;
  const drawdown_60 = close_60_days_ago !== null ? (close / close_60_days_ago) - 1 : null;
  const drawdown_120 = close_120_days_ago !== null ? (close / close_120_days_ago) - 1 : null;
  
  const distance_to_ma60 = (close - ma60) / ma60;
  const distance_to_ma250 = ma250 !== null ? percentChange(close, ma250) : null;

  const last20Prices = prices.slice(-20);
  const prev20Prices = prices.slice(-40, -20);
  const last20High = Math.max(...last20Prices.map(price => price.high || price.close));
  const last20Low = Math.min(...last20Prices.map(price => price.low || price.close));
  const prev20High = prev20Prices.length === 20 ? Math.max(...prev20Prices.map(price => price.high || price.close)) : null;
  const prev20Low = prev20Prices.length === 20 ? Math.min(...prev20Prices.map(price => price.low || price.close)) : null;
  const higher_high = prev20High !== null && last20High > prev20High * 1.005;
  const higher_low = prev20Low !== null && last20Low > prev20Low * 1.005;
  const lower_high = prev20High !== null && last20High < prev20High * 0.995;
  const lower_low = prev20Low !== null && last20Low < prev20Low * 0.995;
  const range_20d = last20Low > 0 ? (last20High - last20Low) / last20Low : null;
  const sideways = range_20d !== null && range_20d <= 0.06 && drawdown_20 !== null && Math.abs(drawdown_20) <= 0.025 && !higher_high && !lower_low;
  const up_days = countTrailingDirectionDays(prices, 'up');
  const down_days = countTrailingDirectionDays(prices, 'down');
  const recentRange = averageDailyRange(prices.slice(-5));
  const previousRange = averageDailyRange(prices.slice(-25, -5));
  const volatilityExpanding = recentRange !== null && previousRange !== null && recentRange > previousRange * 1.35 && recentRange > 0.015;
  const volatilityContracting = recentRange !== null && previousRange !== null && recentRange < previousRange * 0.75;
  
  const getMA60At = (index: number): number | null => {
    if (index < 59) return null;
    const slice = prices.slice(index - 59, index + 1);
    return slice.reduce((sum, p) => sum + p.close, 0) / 60;
  };
  
  let cross_count_10 = 0;
  const last10Prices = prices.slice(-10);
  let prevSide: 'above' | 'below' | null = null;
  
  for (let i = 0; i < last10Prices.length; i++) {
    const globalIndex = prices.length - 10 + i;
    const dayMA60 = getMA60At(globalIndex);
    
    if (dayMA60 === null) continue;
    
    let currentSide: 'above' | 'below' | 'equal';
    if (last10Prices[i].close > dayMA60) {
      currentSide = 'above';
    } else if (last10Prices[i].close < dayMA60) {
      currentSide = 'below';
    } else {
      currentSide = 'equal';
    }
    
    if (currentSide !== 'equal') {
      if (prevSide !== null && prevSide !== currentSide) {
        cross_count_10++;
      }
      prevSide = currentSide;
    }
  }
  
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
  
  let market_regime = 'UNKNOWN';
  let result_reason = '当前数据不满足明确状态，继续观察。';
  
  if ((drawdown_60 !== null && drawdown_60 <= -0.20) || 
      (drawdown_120 !== null && drawdown_120 <= -0.25) || 
      distance_to_ma60 <= -0.10) {
    market_regime = 'DEEP_CRASH';
    result_reason = '市场进入深度股灾区，极端机会开始出现，但禁止直接抄底，等待安全区 + 结构成立。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if ((close < ma60 && ma60 < ma60_prev && drawdown_20 !== null && drawdown_20 <= -0.10) || 
             (low_120 !== null && close < low_120) || 
             (drawdown_60 !== null && drawdown_60 <= -0.15)) {
    market_regime = 'CRASH';
    result_reason = '市场进入股灾/冻结区，不抄底，等待结构重建。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if ((close < ma60 && ma60 < ma60_prev) || 
             (low_60 !== null && close < low_60) || 
             (drawdown_20 !== null && drawdown_20 <= -0.08) || 
             below_ma60_days >= 3) {
    market_regime = 'CRASH_WARNING';
    result_reason = '市场进入股灾预警区，开始重点观察，但不抄底，不接飞刀。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if ((drawdown_120 !== null && drawdown_120 <= -0.08) && 
             close > ma60 && 
             above_ma60_days >= 3) {
    market_regime = 'REBUILD_WATCH';
    result_reason = '市场处于修复观察区，短期已站回MA60，但120日跌幅仍较深（-8%以内），不能直接视为正常确认。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if (cross_count_10 >= 2 || 
             (close < ma60 && ma60 >= ma60_prev) || 
             (drawdown_20 !== null && drawdown_20 <= -0.05 && drawdown_20 > -0.08)) {
    market_regime = 'RISK';
    result_reason = '市场处于风险区，只观察，降速，不急于建仓。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if (close > ma60 && ma60 >= ma60_prev && above_ma60_days >= 5 && cross_count_10 < 2 && 
             (drawdown_120 === null || drawdown_120 > -0.08)) {
    market_regime = 'NORMAL_CONFIRMED';
    result_reason = '收盘价站上MA60并连续站稳5天，MA60未下弯，120日跌幅已修复至-8%以内，市场进入正常确认区。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  } else if (close > ma60 && ma60 >= ma60_prev && cross_count_10 < 2 && 
             (drawdown_20 === null || drawdown_20 > -0.08) && 
             (drawdown_60 === null || drawdown_60 > -0.15) &&
             (drawdown_120 === null || drawdown_120 > -0.08)) {
    market_regime = 'NORMAL';
    result_reason = '市场处于正常观察区，可以继续观察个股/ETF结构。股灾分级只负责提醒机会和风险，不负责给买点；买点永远由安全区 + 结构成立决定。';
  }
  
  let entry_permission = 'OBSERVE_ONLY';
  let entry_reason = '状态不明确，仅观察。';
  
  if (market_regime === 'DEEP_CRASH' || market_regime === 'CRASH') {
    entry_permission = 'FREEZE';
    entry_reason = '市场冻结，不允许建仓，只观察，等待结构重建。';
  } else if (market_regime === 'CRASH_WARNING') {
    entry_permission = 'WATCH_FOR_REBUILD';
    entry_reason = '股灾预警，等待止跌和结构修复。';
  } else if (market_regime === 'REBUILD_WATCH') {
    entry_permission = 'WATCH_FOR_REBUILD';
    entry_reason = '市场处于深跌后的修复观察区，短期已有反弹，但长周期仍未完全修复，等待结构进一步确认。';
  } else if (market_regime === 'RISK') {
    entry_permission = 'OBSERVE_ONLY';
    entry_reason = '风险区，只观察，不主动扩大仓位。';
  } else if (market_regime === 'NORMAL' || market_regime === 'NORMAL_CONFIRMED') {
    entry_permission = 'ALLOW_STRUCTURE_CHECK';
    entry_reason = '允许进入个股/ETF结构判断，但仍需安全区 + 结构成立 + 失效线。';
  }

  const behavior_tags: MarketBehaviorTag[] = [];
  const hasFastUp = latest_change !== null && latest_change >= 0.03;
  const hasFastDown = latest_change !== null && latest_change <= -0.03;
  const hasFiveDayFastUp = return_5d !== null && return_5d >= 0.06;
  const hasFiveDayFastDown = return_5d !== null && return_5d <= -0.06;
  const isSlowGrindUp = drawdown_20 !== null
    && drawdown_20 >= 0.02
    && drawdown_20 <= 0.10
    && ma20 !== null
    && close > ma20
    && ma20_slope !== 'down'
    && higher_low
    && !volatilityExpanding;
  const isSlowBleed = drawdown_20 !== null
    && drawdown_20 <= -0.025
    && drawdown_20 >= -0.10
    && ma20 !== null
    && (close < ma20 || lower_high)
    && !hasFastDown
    && !volatilityExpanding;

  if (hasFastUp) {
    addBehaviorTag(behavior_tags, { code: 'SURGE', label: '暴涨', tone: 'warn', reason: '单日涨幅达到3%以上，防止情绪追高。' });
  }
  if (hasFastDown) {
    addBehaviorTag(behavior_tags, { code: 'CRASH_DAY', label: '暴跌', tone: 'risk', reason: '单日跌幅达到3%以上，优先观察是否破位。' });
  }
  if (hasFiveDayFastUp) {
    addBehaviorTag(behavior_tags, { code: 'FAST_UP_5D', label: '短期急涨', tone: 'warn', reason: '5日涨幅达到6%以上，注意短线拥挤。' });
  }
  if (hasFiveDayFastDown) {
    addBehaviorTag(behavior_tags, { code: 'FAST_DOWN_5D', label: '短期急跌', tone: 'risk', reason: '5日跌幅达到6%以上，先看风险释放和止跌结构。' });
  }
  if (up_days >= 4) {
    addBehaviorTag(behavior_tags, { code: 'CONSECUTIVE_UP', label: '连续上涨', tone: 'warn', reason: `已连续${up_days}个交易日收盘上涨，短期不宜追。` });
  }
  if (down_days >= 4) {
    addBehaviorTag(behavior_tags, { code: 'CONSECUTIVE_DOWN', label: '连续下跌', tone: 'risk', reason: `已连续${down_days}个交易日收盘下跌，等待止跌确认。` });
  }
  if (isSlowGrindUp) {
    addBehaviorTag(behavior_tags, { code: 'SLOW_GRIND_UP', label: '慢涨', tone: 'good', reason: '20日温和上行，低点抬高且波动未明显放大。' });
  }
  if (isSlowBleed) {
    addBehaviorTag(behavior_tags, { code: 'SLOW_BLEED', label: '阴跌', tone: 'risk', reason: '20日缓慢走弱，价格低于短均线或高点抬低。' });
  }
  if (sideways) {
    addBehaviorTag(behavior_tags, { code: 'SIDEWAYS', label: '横盘震荡', tone: 'neutral', reason: '近20日振幅和涨跌幅都较小，等待方向选择。' });
  }
  if (higher_high) {
    addBehaviorTag(behavior_tags, { code: 'HIGHER_HIGH', label: '高点抬高', tone: 'good', reason: '近20日高点高于前20日，攻击结构有改善。' });
  }
  if (higher_low) {
    addBehaviorTag(behavior_tags, { code: 'HIGHER_LOW', label: '低点抬高', tone: 'good', reason: '近20日低点高于前20日，承接结构有改善。' });
  }
  if (lower_high) {
    addBehaviorTag(behavior_tags, { code: 'LOWER_HIGH', label: '高点抬低', tone: 'risk', reason: '近20日高点低于前20日，反弹高度不足。' });
  }
  if (lower_low) {
    addBehaviorTag(behavior_tags, { code: 'LOWER_LOW', label: '低点抬低', tone: 'risk', reason: '近20日低点低于前20日，防止趋势转弱。' });
  }
  if (volatilityExpanding) {
    addBehaviorTag(behavior_tags, { code: 'VOL_EXPAND', label: '波动放大', tone: 'warn', reason: '近5日平均振幅明显高于前20日，仓位要降速。' });
  } else if (volatilityContracting) {
    addBehaviorTag(behavior_tags, { code: 'VOL_CONTRACT', label: '波动收敛', tone: 'neutral', reason: '近5日平均振幅低于前20日，等待突破或回踩确认。' });
  }

  let short_state = 'SHORT_NEUTRAL';
  let short_label = '短期中性';
  let short_reason = '短期行为没有明显极端特征，继续观察。';
  if (hasFastDown || hasFiveDayFastDown) {
    short_state = 'SHORT_FAST_DOWN';
    short_label = '短期急跌';
    short_reason = '出现单日或5日急跌，先看风险释放和止跌结构。';
  } else if (hasFastUp || hasFiveDayFastUp) {
    short_state = 'SHORT_FAST_UP';
    short_label = '短期急涨';
    short_reason = '出现单日或5日急涨，防追高，等待回踩不破。';
  } else if (isSlowBleed) {
    short_state = 'SHORT_SLOW_BLEED';
    short_label = '短期阴跌';
    short_reason = '价格缓慢走弱但未出现极端暴跌，先防慢性破位。';
  } else if (isSlowGrindUp) {
    short_state = 'SHORT_SLOW_GRIND_UP';
    short_label = '短期慢涨';
    short_reason = '温和上行、低点抬高且波动未失控，短期行为较健康。';
  } else if (sideways) {
    short_state = 'SHORT_SIDEWAYS';
    short_label = '短期横盘震荡';
    short_reason = '近20日方向不强，等待突破、回踩或跌破后的确认。';
  } else if (lower_high && lower_low) {
    short_state = 'SHORT_WEAK';
    short_label = '短期转弱';
    short_reason = '高点和低点同时抬低，短期偏弱。';
  } else if (higher_high && higher_low) {
    short_state = 'SHORT_UP';
    short_label = '短期走强';
    short_reason = '高点和低点同步抬高，短期结构改善。';
  } else if (up_days >= 4) {
    short_state = 'SHORT_CONSECUTIVE_UP';
    short_label = '短期连续上涨';
    short_reason = `已连续${up_days}个交易日上涨，注意短线追高风险。`;
  } else if (down_days >= 4) {
    short_state = 'SHORT_CONSECUTIVE_DOWN';
    short_label = '短期连续下跌';
    short_reason = `已连续${down_days}个交易日下跌，等待止跌确认。`;
  }

  const getMA250At = (index: number): number | null => {
    if (index < 249) return null;
    const slice = prices.slice(index - 249, index + 1);
    return slice.reduce((sum, price) => sum + price.close, 0) / 250;
  };

  let above_ma250_days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA250 = getMA250At(i);
    if (dayMA250 === null) break;
    if (prices[i].close > dayMA250) {
      above_ma250_days++;
    } else {
      break;
    }
  }

  let below_ma250_days = 0;
  for (let i = prices.length - 1; i >= 0; i--) {
    const dayMA250 = getMA250At(i);
    if (dayMA250 === null) break;
    if (prices[i].close < dayMA250) {
      below_ma250_days++;
    } else {
      break;
    }
  }

  const ma250_60ago = prices.length >= 310 ? getMA250At(prices.length - 61) : null;
  const ma250_slope_60 = ma250 !== null && ma250_60ago !== null && ma250_60ago > 0
    ? ma250 / ma250_60ago - 1
    : null;
  const ma250_long_slope =
    ma250_slope_60 === null ? 'unknown' :
    ma250_slope_60 >= 0.01 ? 'up' :
    ma250_slope_60 <= -0.01 ? 'down' :
    'flat';

  let long_state = 'LONG_UNKNOWN';
  let long_label = '长期牛熊未确认';
  let long_reason = '历史数据不足250个交易日，暂不能用MA250判断长期牛熊。';
  if (ma250 !== null) {
    const slopeText = ma250_long_slope === 'up' ? '上行' : ma250_long_slope === 'down' ? '下行' : ma250_long_slope === 'flat' ? '走平' : '未知';
    const ma120Text = ma120_slope === 'up' ? '上行' : ma120_slope === 'down' ? '下行' : ma120_slope === 'flat' ? '走平' : '未知';
    const distanceText = distance_to_ma250 === null ? '--' : `${(distance_to_ma250 * 100).toFixed(2)}%`;
    const aboveBuffer = distance_to_ma250 !== null && distance_to_ma250 >= 0.02;
    const belowBuffer = distance_to_ma250 !== null && distance_to_ma250 <= -0.02;
    const sustainedAbove = above_ma250_days >= 30;
    const sustainedBelow = below_ma250_days >= 30;
    const confirmedBull = aboveBuffer && sustainedAbove && ma250_long_slope !== 'down' && ma120_slope !== 'down';
    const confirmedBear = belowBuffer && sustainedBelow && ma250_long_slope === 'down' && (ma120_slope === 'down' || lower_high || lower_low);
    const repairWatch = aboveBuffer && above_ma250_days >= 10 && ma250_long_slope !== 'down' && (ma120_slope !== 'down' || higher_low);
    const weakenWatch = belowBuffer && below_ma250_days >= 10 && ma250_long_slope !== 'up' && (ma120_slope === 'down' || lower_high || lower_low);

    if (confirmedBull) {
      long_state = 'LONG_BULL';
      long_label = '长期牛市';
      long_reason = `收盘价在MA250上方且偏离 ${distanceText}，已连续站上MA250 ${above_ma250_days} 天，MA250约60日斜率${slopeText}，MA120${ma120Text}，长期背景偏牛。`;
    } else if (confirmedBear) {
      long_state = 'LONG_BEAR';
      long_label = '长期熊市';
      long_reason = `收盘价在MA250下方且偏离 ${distanceText}，已连续跌破MA250 ${below_ma250_days} 天，MA250约60日斜率${slopeText}，长期背景偏熊。`;
    } else if (repairWatch) {
      long_state = 'LONG_BEAR_TO_BULL';
      long_label = '长期转强观察';
      long_reason = `收盘价重新站上MA250并偏离 ${distanceText}，已连续站上 ${above_ma250_days} 天，MA250约60日斜率${slopeText}；先记为长期转强观察，不直接等同牛市确认。`;
    } else if (weakenWatch) {
      long_state = 'LONG_BULL_TO_BEAR';
      long_label = '长期转弱观察';
      long_reason = `收盘价跌破MA250并偏离 ${distanceText}，已连续跌破 ${below_ma250_days} 天，MA250约60日斜率${slopeText}；先记为长期转弱观察，不直接等同熊市确认。`;
    } else if (close > ma250 && ma250_long_slope !== 'down') {
      long_state = 'LONG_BULL_PULLBACK';
      long_label = '长期牛市回撤';
      long_reason = `价格仍在MA250上方，但连续站上天数/偏离或长期斜率还没满足牛市确认；先按MA250上方震荡或牛市回撤观察。`;
    } else {
      long_state = 'LONG_TRANSITION';
      long_label = '长期均线争夺';
      long_reason = `价格在MA250附近或长期斜率未确认，当前偏离 ${distanceText}；不把MA250附近来回穿越直接判成牛熊转换。`;
    }
  }
  
  return {
    symbol,
    name,
    trade_date,
    close,
    ma20: roundNumber(ma20, 2),
    ma20_slope,
    ma60: Math.round(ma60 * 100) / 100,
    ma60_prev: Math.round(ma60_prev * 100) / 100,
    ma60_slope,
    ma120: roundNumber(ma120, 2),
    ma120_prev: roundNumber(ma120_prev, 2),
    ma120_slope,
    ma250: roundNumber(ma250, 2),
    ma250_prev: roundNumber(ma250_prev, 2),
    ma250_slope,
    low_60: low_60 !== null ? Math.round(low_60 * 100) / 100 : null,
    low_120: low_120 !== null ? Math.round(low_120 * 100) / 100 : null,
    cross_count_10,
    above_ma60_days,
    below_ma60_days,
    drawdown_20: drawdown_20 !== null ? Math.round(drawdown_20 * 10000) / 10000 : null,
    drawdown_60: drawdown_60 !== null ? Math.round(drawdown_60 * 10000) / 10000 : null,
    drawdown_120: drawdown_120 !== null ? Math.round(drawdown_120 * 10000) / 10000 : null,
    latest_change: roundNumber(latest_change, 4),
    distance_to_ma60: Math.round(distance_to_ma60 * 10000) / 10000,
    distance_to_ma250: roundNumber(distance_to_ma250, 4),
    higher_high,
    higher_low,
    lower_high,
    lower_low,
    sideways,
    up_days,
    down_days,
    market_regime,
    result_reason,
    entry_permission,
    entry_reason,
    rule_version: ruleVersion,
    cycle_layer_version: cycleLayerVersion,
    short_state,
    short_label,
    short_reason,
    mid_state: market_regime,
    mid_label: getMarketRegimeShortLabel(market_regime),
    mid_reason: result_reason,
    long_state,
    long_label,
    long_reason,
    behavior_tags,
    is_mock: isMock,
    source
  };
}

