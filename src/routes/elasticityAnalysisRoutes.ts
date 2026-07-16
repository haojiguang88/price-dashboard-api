import express from 'express';
import getDb from '../config/database';

const router = express.Router();

const DUAL_SCORE_MODEL_VERSION = 'dual-score-v5';
const ABSOLUTE_ELASTICITY_REFERENCE_RATE = 30;

const CATEGORY_ELASTICITY_REFERENCE_RATE: Record<string, number> = {
  '苹果手机': 3,
  '游戏机': 10,
  '泡泡玛特': 22,
  '纪念币': 15,
  '纪念钞': 30,
  '贵金属': 15
};

const CATEGORY_MEANINGFUL_SWING_THRESHOLD_RATE: Record<string, number> = {
  '苹果手机': 0.6,
  '游戏机': 1,
  '泡泡玛特': 1.2,
  '纪念币': 1.5,
  '纪念钞': 2,
  '贵金属': 1
};

const CATEGORY_EFFECTIVE_SWING_TARGET_RATE: Record<string, number> = {
  '苹果手机': 1.5,
  '游戏机': 2.5,
  '泡泡玛特': 3,
  '纪念币': 3,
  '纪念钞': 4,
  '贵金属': 2.5
};

const CATEGORY_MINIMUM_TRADABLE_RANGE_AMOUNT: Record<string, number> = {
  '苹果手机': 150,
  '游戏机': 100,
  '泡泡玛特': 30,
  '纪念币': 30,
  '纪念钞': 5,
  '贵金属': 0
};

const CATEGORY_MINIMUM_TRADABLE_RANGE_RATE: Record<string, number> = {
  '苹果手机': 2,
  '游戏机': 3,
  '泡泡玛特': 8,
  '纪念币': 6,
  '纪念钞': 8,
  '贵金属': 3
};

const clampScore = (value: number) => Math.max(0, Math.min(100, value));

const getCategoryElasticityReferenceRate = (categoryName: string) => (
  CATEGORY_ELASTICITY_REFERENCE_RATE[categoryName] || 15
);

const getMeaningfulSwingThresholdRate = (categoryName: string) => (
  CATEGORY_MEANINGFUL_SWING_THRESHOLD_RATE[categoryName] || 1.2
);

const getEffectiveSwingTargetRate = (categoryName: string) => (
  CATEGORY_EFFECTIVE_SWING_TARGET_RATE[categoryName] || 5
);

const getMinimumTradableRangeAmount = (categoryName: string) => (
  CATEGORY_MINIMUM_TRADABLE_RANGE_AMOUNT[categoryName] ?? 30
);

const getMinimumTradableRangeRate = (categoryName: string) => (
  CATEGORY_MINIMUM_TRADABLE_RANGE_RATE[categoryName] ?? 5
);

const scoreRateByCategory = (rate: number, categoryName: string) => {
  const categoryReference = getCategoryElasticityReferenceRate(categoryName);
  const categoryRelativeScore = clampScore((rate / categoryReference) * 100);
  const absoluteScore = clampScore((rate / ABSOLUTE_ELASTICITY_REFERENCE_RATE) * 100);
  return clampScore(categoryRelativeScore * 0.4 + absoluteScore * 0.6);
};

const scoreEffectiveSwingRate = (rate: number, categoryName: string) => (
  clampScore((rate / getEffectiveSwingTargetRate(categoryName)) * 100)
);

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const subtractIsoDays = (isoDate: string, days: number) => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

const calculateStrengthStructureMetrics = (prices: number[]) => {
  if (prices.length < 2) {
    return {
      high_zone_occupancy_rate: 0,
      drawdown_resistance_score: 0
    };
  }

  const lowestPrice = Math.min(...prices);
  const highestPrice = Math.max(...prices);
  const priceRange = highestPrice - lowestPrice;

  // 完全横盘只能证明稳定，不能证明处于高位，按中性证据处理。
  if (priceRange <= 0) {
    return {
      high_zone_occupancy_rate: 50,
      drawdown_resistance_score: 50
    };
  }

  const highZoneThreshold = lowestPrice + priceRange * 0.7;
  const highZoneCount = prices.filter(price => price >= highZoneThreshold).length;
  const highZoneOccupancyRate = highZoneCount / prices.length * 100;

  const peakIndex = prices.indexOf(highestPrice);
  const pricesAfterPeak = prices.slice(peakIndex);
  const normalizedPostPeakPositions = pricesAfterPeak.map(price => (
    (price - lowestPrice) / priceRange * 100
  ));
  const averagePostPeakPosition = normalizedPostPeakPositions.reduce((sum, value) => sum + value, 0)
    / normalizedPostPeakPositions.length;
  const postPeakHighZoneRate = pricesAfterPeak.filter(price => price >= highZoneThreshold).length
    / pricesAfterPeak.length * 100;
  const drawdownResistanceScore = clampScore(
    averagePostPeakPosition * 0.6 + postPeakHighZoneRate * 0.4
  );

  return {
    high_zone_occupancy_rate: highZoneOccupancyRate,
    drawdown_resistance_score: drawdownResistanceScore
  };
};

// 获取价格记录
const getPriceRecords = async (db: any, period: number | 'all', filters: {
  category_name?: string;
  object_name?: string;
  variant_name?: string;
}) => {
  let query = `
    SELECT 
      pr.id, 
      pr.date, 
      pr.category AS category_name, 
      pr.object_name, 
      COALESCE(pr.variant, '') AS variant_name, 
      c.id AS category_id,
      o.id AS object_id,
      COALESCE(v.id, 0) AS variant_id,
      pr.price, 
      pr.created_at
    FROM price_records pr
    LEFT JOIN categories c ON c.name = pr.category
    LEFT JOIN objects o ON o.category_id = c.id AND o.name = pr.object_name
    LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(pr.variant, '') AND COALESCE(pr.variant, '') <> ''
    WHERE 1=1
      AND COALESCE(c.is_archived, 0) = 0
      AND COALESCE(o.is_archived, 0) = 0
      AND (COALESCE(pr.variant, '') = '' OR COALESCE(v.is_archived, 0) = 0)
  `;
  const params: any[] = [];

  // 日期筛选
  if (period !== 'all' && typeof period === 'number') {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - period);
    const startDateStr = startDate.toISOString().slice(0, 10);
    query += ' AND pr.date >= ?';
    params.push(startDateStr);
  }

  // 品类筛选
  if (filters.category_name) {
    query += ' AND pr.category = ?';
    params.push(filters.category_name);
  }

  // 对象筛选
  if (filters.object_name) {
    query += ' AND pr.object_name = ?';
    params.push(filters.object_name);
  }

  // 变体筛选
  if (filters.variant_name) {
    query += ' AND pr.variant = ?';
    params.push(filters.variant_name);
  }

  query += ' ORDER BY pr.category ASC, pr.object_name ASC, COALESCE(pr.variant, \'\') ASC, pr.date ASC, pr.created_at ASC, pr.id ASC';

  const records = await db.all(query, params);
  
  // 按目标分组，并处理同一天多条记录的情况
  const groupedRecords: Record<string, any[]> = {};
  const dailyLastRecords: Record<string, any> = {};
  
  records.forEach((record: any) => {
    const key = `${record.category_name}|${record.object_name}|${record.variant_name}`;
    const dailyKey = `${key}|${record.date}`;
    
    // 保留同一天最后一条记录
    if (!dailyLastRecords[dailyKey] || 
        new Date(record.created_at) > new Date(dailyLastRecords[dailyKey].created_at)) {
      dailyLastRecords[dailyKey] = record;
    }
  });
  
  // 重新组织分组
  Object.values(dailyLastRecords).forEach((record: any) => {
    const key = `${record.category_name}|${record.object_name}|${record.variant_name}`;
    if (!groupedRecords[key]) {
      groupedRecords[key] = [];
    }
    groupedRecords[key].push(record);
  });

  return groupedRecords;
};

// 计算相邻价格变化
const calculatePriceChanges = (prices: number[]) => {
  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const change = (prices[i] - prices[i - 1]) / prices[i - 1] * 100;
    changes.push(change);
  }
  return changes;
};

const calculateSwingMetrics = (prices: number[], categoryName: string) => {
  const meaningfulThresholdRate = getMeaningfulSwingThresholdRate(categoryName);
  const effectiveSwingTargetRate = getEffectiveSwingTargetRate(categoryName);
  const minimumTradableRangeAmount = getMinimumTradableRangeAmount(categoryName);
  const minimumTradableRangeRate = getMinimumTradableRangeRate(categoryName);
  const emptyResult = {
    swing_run_count: 0,
    completed_swing_count: 0,
    direction_change_count: 0,
    median_up_swing_rate: 0,
    median_down_swing_rate: 0,
    effective_swing_amount: 0,
    effective_swing_rate: 0,
    two_way_balance_rate: 0,
    meaningful_swing_threshold_rate: meaningfulThresholdRate,
    effective_swing_target_rate: effectiveSwingTargetRate,
    minimum_tradable_range_amount: minimumTradableRangeAmount,
    minimum_tradable_range_rate: minimumTradableRangeRate,
    tradable_space_passed: false,
    tradable_space_hint: '暂无完整跌后反弹，不能形成可做空间。',
    elasticity_pattern: '无有效跌后反弹'
  };

  if (prices.length < 2 || prices.some(price => price <= 0)) return emptyResult;

  type Pivot = { index: number; price: number };
  type Direction = 'up' | 'down';
  const pivots: Pivot[] = [];
  let trend: Direction | null = null;
  let candidateHigh: Pivot = { index: 0, price: prices[0] };
  let candidateLow: Pivot = { index: 0, price: prices[0] };
  let extreme: Pivot = { index: 0, price: prices[0] };

  for (let index = 1; index < prices.length; index++) {
    const current: Pivot = { index, price: prices[index] };

    if (trend === null) {
      if (current.price > candidateHigh.price) candidateHigh = current;
      if (current.price < candidateLow.price) candidateLow = current;

      const riseRate = candidateLow.index < candidateHigh.index
        ? (candidateHigh.price - candidateLow.price) / candidateLow.price * 100
        : 0;
      const dropRate = candidateHigh.index < candidateLow.index
        ? (candidateHigh.price - candidateLow.price) / candidateHigh.price * 100
        : 0;

      if (riseRate >= meaningfulThresholdRate) {
        pivots.push(candidateLow);
        trend = 'up';
        extreme = candidateHigh;
      } else if (dropRate >= meaningfulThresholdRate) {
        pivots.push(candidateHigh);
        trend = 'down';
        extreme = candidateLow;
      }
      continue;
    }

    if (trend === 'up') {
      if (current.price >= extreme.price) {
        extreme = current;
        continue;
      }

      const reversalRate = (extreme.price - current.price) / extreme.price * 100;
      if (reversalRate >= meaningfulThresholdRate) {
        pivots.push(extreme);
        trend = 'down';
        extreme = current;
      }
      continue;
    }

    if (current.price <= extreme.price) {
      extreme = current;
      continue;
    }

    const reversalRate = (current.price - extreme.price) / extreme.price * 100;
    if (reversalRate >= meaningfulThresholdRate) {
      pivots.push(extreme);
      trend = 'up';
      extreme = current;
    }
  }

  if (trend !== null && pivots[pivots.length - 1]?.index !== extreme.index) {
    pivots.push(extreme);
  }

  const legs: Array<{ direction: Direction; amount: number; rate: number }> = [];
  for (let index = 1; index < pivots.length; index++) {
    const start = pivots[index - 1];
    const end = pivots[index];
    const direction: Direction = end.price > start.price ? 'up' : 'down';
    const amount = Math.abs(end.price - start.price);
    const rate = direction === 'up'
      ? (end.price - start.price) / start.price * 100
      : (start.price - end.price) / start.price * 100;
    legs.push({ direction, amount, rate });
  }

  const cycles: Array<{
    dropRate: number;
    reboundRate: number;
    effectiveAmount: number;
    effectiveRate: number;
    balanceRate: number;
  }> = [];
  for (let index = 0; index < legs.length - 1; index++) {
    const dropLeg = legs[index];
    const reboundLeg = legs[index + 1];
    if (dropLeg.direction !== 'down' || reboundLeg.direction !== 'up') continue;

    const effectiveAmount = Math.min(dropLeg.amount, reboundLeg.amount);
    const effectiveRate = Math.min(dropLeg.rate, reboundLeg.rate);
    const balanceRate = Math.max(dropLeg.rate, reboundLeg.rate) > 0
      ? effectiveRate / Math.max(dropLeg.rate, reboundLeg.rate) * 100
      : 0;
    cycles.push({
      dropRate: dropLeg.rate,
      reboundRate: reboundLeg.rate,
      effectiveAmount,
      effectiveRate,
      balanceRate
    });
  }

  const completedSwingCount = cycles.length;
  const effectiveSwingAmount = median(cycles.map(cycle => cycle.effectiveAmount));
  const effectiveSwingRate = median(cycles.map(cycle => cycle.effectiveRate));
  const highestPrice = Math.max(...prices);
  const lowestPrice = Math.min(...prices);
  const observedRangeAmount = highestPrice - lowestPrice;
  const observedRangeRate = lowestPrice > 0 ? observedRangeAmount / lowestPrice * 100 : 0;
  const tradableSpacePassed = completedSwingCount > 0
    && observedRangeAmount >= minimumTradableRangeAmount
    && observedRangeRate >= minimumTradableRangeRate;
  const rangeThresholdText = minimumTradableRangeAmount > 0
    ? `金额 ¥${minimumTradableRangeAmount.toFixed(2)}、比例 ${minimumTradableRangeRate.toFixed(2)}%`
    : `金额不限、比例 ${minimumTradableRangeRate.toFixed(2)}%`;
  const tradableSpaceHint = completedSwingCount === 0
    ? '暂无完整跌后反弹，不能形成可做空间。'
    : tradableSpacePassed
      ? `观察窗口上下限 ¥${observedRangeAmount.toFixed(2)} / ${observedRangeRate.toFixed(2)}%，已达到${categoryName}门槛：${rangeThresholdText}。`
      : `有往返但上下限空间不足：当前 ¥${observedRangeAmount.toFixed(2)} / ${observedRangeRate.toFixed(2)}%，未同时达到${categoryName}门槛：${rangeThresholdText}。`;
  return {
    swing_run_count: legs.length,
    completed_swing_count: completedSwingCount,
    direction_change_count: Math.max(0, legs.length - 1),
    median_up_swing_rate: median(cycles.map(cycle => cycle.reboundRate)),
    median_down_swing_rate: median(cycles.map(cycle => cycle.dropRate)),
    effective_swing_amount: effectiveSwingAmount,
    effective_swing_rate: effectiveSwingRate,
    two_way_balance_rate: median(cycles.map(cycle => cycle.balanceRate)),
    meaningful_swing_threshold_rate: meaningfulThresholdRate,
    effective_swing_target_rate: effectiveSwingTargetRate,
    minimum_tradable_range_amount: minimumTradableRangeAmount,
    minimum_tradable_range_rate: minimumTradableRangeRate,
    tradable_space_passed: tradableSpacePassed,
    tradable_space_hint: tradableSpaceHint,
    elasticity_pattern: completedSwingCount === 0
      ? '无有效跌后反弹'
      : !tradableSpacePassed
        ? '有往返但空间不足'
        : completedSwingCount >= 2 ? '可重复弹性' : '单次跌后反弹'
  };
};

// 计算弹性指标（业务定义）
const calculateElasticity = (prices: number[]) => {
  if (prices.length < 2) return { elasticity_amount: 0, elasticity_rate: 0 };
  
  const highestPrice = Math.max(...prices);
  const lowestPrice = Math.min(...prices);
  const elasticity_amount = highestPrice - lowestPrice;
  const elasticity_rate = lowestPrice > 0 ? (elasticity_amount / lowestPrice) * 100 : 0;
  
  return { elasticity_amount, elasticity_rate };
};

// 计算硬度指标（价格稳定性）
const calculateHardness = (prices: number[]) => {
  if (prices.length < 2) return 0;
  
  const changes = calculatePriceChanges(prices);
  const volatility = changes.length > 0 
    ? changes.reduce((sum, c) => sum + Math.abs(c), 0) / changes.length 
    : 0;
  
  // 硬度 = 100 - 波动率（越高越稳定）
  return Math.max(0, 100 - volatility);
};

// 计算横盘分析
const calculateSideways = (
  prices: number[], 
  dates: string[], 
  mode: 'amount' | 'percent', 
  thresholdAmount: number, 
  thresholdPercent: number, 
  minCount: number
) => {
  if (prices.length < minCount) {
    return {
      isSideways: false,
      sideways_count: 0,
      sideways_days: 0,
      sideways_start_date: null,
      sideways_end_date: null,
      sideways_price_low: 0,
      sideways_price_high: 0,
      sideways_center_price: 0,
      sideways_position: 'unknown',
      sideways_break_direction: '未突破',
      sideways_break_amount: 0,
      sideways_break_rate: 0
    };
  }
  
  // 计算弹性金额
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  const elasticity_amount = maxPrice - minPrice;
  
  // 阈值过大保护
  if (mode === 'amount') {
    if (thresholdAmount * 2 >= elasticity_amount * 0.5) {
      return {
        isSideways: false,
        sideways_count: 0,
        sideways_days: 0,
        sideways_start_date: null,
        sideways_end_date: null,
        sideways_price_low: null,
        sideways_price_high: null,
        sideways_center_price: null,
        sideways_position: '阈值过大',
        sideways_break_direction: '无法判断',
        sideways_break_amount: null,
        sideways_break_rate: null
      };
    }
  } else {
    if (thresholdPercent >= 20) {
      return {
        isSideways: false,
        sideways_count: 0,
        sideways_days: 0,
        sideways_start_date: null,
        sideways_end_date: null,
        sideways_price_low: null,
        sideways_price_high: null,
        sideways_center_price: null,
        sideways_position: '阈值过大',
        sideways_break_direction: '无法判断',
        sideways_break_amount: null,
        sideways_break_rate: null
      };
    }
  }
  
  const segments: any[] = [];
  let currentSegment: any = {
    startIndex: 0,
    startDate: dates[0],
    prices: [prices[0]]
  };
  
  for (let i = 1; i < prices.length; i++) {
    let isSideways = false;
    
    if (mode === 'amount') {
      const segmentMax = Math.max(...currentSegment.prices, prices[i]);
      const segmentMin = Math.min(...currentSegment.prices, prices[i]);
      isSideways = segmentMax - segmentMin <= thresholdAmount * 2;
    } else {
      const segmentPrices = [...currentSegment.prices, prices[i]];
      const avgPrice = segmentPrices.reduce((sum, p) => sum + p, 0) / segmentPrices.length;
      const segmentMax = Math.max(...segmentPrices);
      const segmentMin = Math.min(...segmentPrices);
      isSideways = avgPrice > 0 && ((segmentMax - segmentMin) / avgPrice) * 100 <= thresholdPercent;
    }
    
    if (isSideways) {
      currentSegment.prices.push(prices[i]);
    } else {
      if (currentSegment.prices.length >= minCount) {
        const segmentMax = Math.max(...currentSegment.prices);
        const segmentMin = Math.min(...currentSegment.prices);
        const segmentCenter = (segmentMax + segmentMin) / 2;
        segments.push({
          startIndex: currentSegment.startIndex,
          endIndex: i - 1,
          startDate: currentSegment.startDate,
          endDate: dates[i - 1],
          prices: currentSegment.prices,
          priceLow: segmentMin,
          priceHigh: segmentMax,
          centerPrice: segmentCenter
        });
      }
      currentSegment = {
        startIndex: i,
        startDate: dates[i],
        prices: [prices[i]]
      };
    }
  }
  
  // 检查最后一段
  if (currentSegment.prices.length >= minCount) {
    const segmentMax = Math.max(...currentSegment.prices);
    const segmentMin = Math.min(...currentSegment.prices);
    const segmentCenter = (segmentMax + segmentMin) / 2;
    segments.push({
      startIndex: currentSegment.startIndex,
      endIndex: prices.length - 1,
      startDate: currentSegment.startDate,
      endDate: dates[dates.length - 1],
      prices: currentSegment.prices,
      priceLow: segmentMin,
      priceHigh: segmentMax,
      centerPrice: segmentCenter
    });
  }
  
  if (segments.length === 0) {
    return {
      isSideways: false,
      sideways_count: 0,
      sideways_days: 0,
      sideways_start_date: null,
      sideways_end_date: null,
      sideways_price_low: 0,
      sideways_price_high: 0,
      sideways_center_price: 0,
      sideways_position: 'unknown',
      sideways_break_direction: '未突破',
      sideways_break_amount: 0,
      sideways_break_rate: 0
    };
  }
  
  // 取最近的横盘段
  const latestSegment = segments[segments.length - 1];
  const lowestPrice = Math.min(...prices);
  const highestPrice = Math.max(...prices);
  const priceRange = highestPrice - lowestPrice;
  
  let sidewaysPosition = 'unknown';
  if (priceRange > 0) {
    const sidewaysPositionRate = (latestSegment.centerPrice - lowestPrice) / priceRange * 100;
    if (sidewaysPositionRate >= 70) {
      sidewaysPosition = '高位';
    } else if (sidewaysPositionRate >= 40) {
      sidewaysPosition = '中位';
    } else {
      sidewaysPosition = '低位';
    }
  }
  
  // 计算突破方向
  let breakDirection = '未突破';
  let breakAmount = 0;
  let breakRate = 0;
  
  if (latestSegment.endIndex < prices.length - 1) {
    const nextPrice = prices[latestSegment.endIndex + 1];
    let threshold = thresholdAmount;
    if (mode === 'percent') {
      threshold = latestSegment.centerPrice * thresholdPercent / 100;
    }
    
    if (nextPrice > latestSegment.priceHigh + threshold) {
      breakDirection = '向上突破';
    } else if (nextPrice < latestSegment.priceLow - threshold) {
      breakDirection = '向下破位';
    }
    
    breakAmount = nextPrice - latestSegment.centerPrice;
    breakRate = latestSegment.centerPrice > 0 ? (breakAmount / latestSegment.centerPrice) * 100 : 0;
  }
  
  // 计算横盘天数
  const startDate = new Date(latestSegment.startDate);
  const endDate = new Date(latestSegment.endDate);
  const sidewaysDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  
  return {
    isSideways: true,
    sideways_count: latestSegment.prices.length,
    sideways_segment_count: segments.length,
    sideways_days: sidewaysDays,
    sideways_start_date: latestSegment.startDate,
    sideways_end_date: latestSegment.endDate,
    sideways_price_low: latestSegment.priceLow,
    sideways_price_high: latestSegment.priceHigh,
    sideways_center_price: latestSegment.centerPrice,
    sideways_position: sidewaysPosition,
    sideways_break_direction: breakDirection,
    sideways_break_amount: breakAmount,
    sideways_break_rate: breakRate
  };
};

// 计算价格位置
const calculatePricePosition = (prices: number[]) => {
  if (prices.length < 2) return 'unknown';
  
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const currentPrice = prices[prices.length - 1];
  const range = maxPrice - minPrice;
  
  if (range === 0) return 'middle';
  
  const position = (currentPrice - minPrice) / range;
  if (position >= 0.7) return 'high';
  if (position <= 0.3) return 'low';
  return 'middle';
};

// 计算当前区间位置率
const calculatePositionRate = (prices: number[]) => {
  if (prices.length < 2) return 50;
  
  const lowestPrice = Math.min(...prices);
  const highestPrice = Math.max(...prices);
  const currentPrice = prices[prices.length - 1];
  const range = highestPrice - lowestPrice;
  
  if (range === 0) return 50;
  
  return ((currentPrice - lowestPrice) / range) * 100;
};

// 计算高位保持率
const calculateHighHoldRate = (prices: number[]) => {
  if (prices.length < 2) return 0;
  
  const highestPrice = Math.max(...prices);
  const currentPrice = prices[prices.length - 1];
  
  return highestPrice > 0 ? (currentPrice / highestPrice) * 100 : 0;
};

// 计算上涨后回撤率
const calculatePostPeakDrawdownRate = (prices: number[]) => {
  if (prices.length < 2) return 0;
  
  const highestPrice = Math.max(...prices);
  const currentPrice = prices[prices.length - 1];
  
  return highestPrice > 0 ? ((highestPrice - currentPrice) / highestPrice) * 100 : 0;
};

// 计算修复率
const calculateRepairRate = (prices: number[]) => {
  if (prices.length < 2) return 0;
  
  const lowestPrice = Math.min(...prices);
  const lowestIndex = prices.indexOf(lowestPrice);
  const highestPrice = Math.max(...prices);
  const priceRange = highestPrice - lowestPrice;
  
  if (priceRange === 0) return 0;
  
  const pricesAfterLow = prices.slice(lowestIndex);
  const afterLowHighestPrice = Math.max(...pricesAfterLow);
  
  return ((afterLowHighestPrice - lowestPrice) / priceRange) * 100;
};

// 计算相邻价格差分析
const calculatePriceDifferences = (prices: number[], dates: string[]) => {
  if (prices.length < 2) {
    return {
      last_change_amount: 0,
      last_change_rate: 0,
      max_adjacent_change_amount: 0,
      max_adjacent_change_rate: 0,
      max_adjacent_change_direction: '持平',
      max_adjacent_change_from_date: null,
      max_adjacent_change_to_date: null,
      max_adjacent_change_from_price: null,
      max_adjacent_change_to_price: null,
      max_single_rise_amount: 0,
      max_single_rise_rate: 0,
      max_single_drop_amount: 0,
      max_single_drop_rate: 0,
      avg_change_amount: 0,
      rise_count: 0,
      drop_count: 0,
      flat_count: 0
    };
  }
  
  const changes: {
    amount: number;
    rate: number;
    fromDate: string;
    toDate: string;
    fromPrice: number;
    toPrice: number;
  }[] = [];
  let riseCount = 0;
  let dropCount = 0;
  let flatCount = 0;
  
  for (let i = 1; i < prices.length; i++) {
    const changeAmount = prices[i] - prices[i - 1];
    const changeRate = prices[i - 1] > 0 ? (changeAmount / prices[i - 1]) * 100 : 0;
    
    changes.push({
      amount: changeAmount,
      rate: changeRate,
      fromDate: dates[i - 1],
      toDate: dates[i],
      fromPrice: prices[i - 1],
      toPrice: prices[i]
    });
    
    if (changeAmount > 0) {
      riseCount++;
    } else if (changeAmount < 0) {
      dropCount++;
    } else {
      flatCount++;
    }
  }
  
  const lastChange = changes[changes.length - 1];
  const positiveChanges = changes.filter(c => c.amount > 0);
  const negativeChanges = changes.filter(c => c.amount < 0);
  
  const maxSingleRise = positiveChanges.length > 0 
    ? positiveChanges.reduce((max, c) => c.amount > max.amount ? c : max, positiveChanges[0]) 
    : { amount: 0, rate: 0 };
  
  const maxSingleDrop = negativeChanges.length > 0 
    ? negativeChanges.reduce((min, c) => c.amount < min.amount ? c : min, negativeChanges[0]) 
    : { amount: 0, rate: 0 };

  const maxAdjacentChange = changes.reduce((max, c) => (
    Math.abs(c.amount) > Math.abs(max.amount) ? c : max
  ), changes[0]);
  
  const avgChangeAmount = changes.length > 0 
    ? changes.reduce((sum, c) => sum + c.amount, 0) / changes.length 
    : 0;
  
  return {
    last_change_amount: lastChange.amount,
    last_change_rate: lastChange.rate,
    max_adjacent_change_amount: Math.abs(maxAdjacentChange.amount),
    max_adjacent_change_rate: Math.abs(maxAdjacentChange.rate),
    max_adjacent_change_direction: maxAdjacentChange.amount > 0 ? '上涨' : maxAdjacentChange.amount < 0 ? '下跌' : '持平',
    max_adjacent_change_from_date: maxAdjacentChange.fromDate,
    max_adjacent_change_to_date: maxAdjacentChange.toDate,
    max_adjacent_change_from_price: maxAdjacentChange.fromPrice,
    max_adjacent_change_to_price: maxAdjacentChange.toPrice,
    max_single_rise_amount: maxSingleRise.amount,
    max_single_rise_rate: maxSingleRise.rate,
    max_single_drop_amount: maxSingleDrop.amount,
    max_single_drop_rate: maxSingleDrop.rate,
    avg_change_amount: avgChangeAmount,
    rise_count: riseCount,
    drop_count: dropCount,
    flat_count: flatCount
  };
};

// 计算高点低点变化趋势
const calculateHighLowTrends = (prices: number[]) => {
  if (prices.length < 4) {
    return {
      front_low: 0,
      back_low: 0,
      front_high: 0,
      back_high: 0,
      low_trend: '持平',
      high_trend: '持平'
    };
  }
  
  const midPoint = Math.floor(prices.length / 2);
  const frontHalf = prices.slice(0, midPoint);
  const backHalf = prices.slice(midPoint);
  
  const frontLow = Math.min(...frontHalf);
  const backLow = Math.min(...backHalf);
  const frontHigh = Math.max(...frontHalf);
  const backHigh = Math.max(...backHalf);
  
  let lowTrend = '持平';
  let highTrend = '持平';
  
  if (backLow > frontLow) {
    lowTrend = '低点抬升';
  } else if (backLow < frontLow) {
    lowTrend = '低点下移';
  }
  
  if (backHigh > frontHigh) {
    highTrend = '高点抬升';
  } else if (backHigh < frontHigh) {
    highTrend = '高点下移';
  }
  
  return {
    front_low: frontLow,
    back_low: backLow,
    front_high: frontHigh,
    back_high: backHigh,
    low_trend: lowTrend,
    high_trend: highTrend
  };
};

const calculateTrendStrengthScore = (lowTrend: string, highTrend: string) => {
  const lowUp = lowTrend.includes('抬升');
  const lowDown = lowTrend.includes('下移');
  const highUp = highTrend.includes('抬升');
  const highDown = highTrend.includes('下移');

  if (lowUp && highUp) return 100;
  if ((lowUp && !highDown) || (highUp && !lowDown)) return 88;
  if (lowDown && highDown) return 20;
  if (lowDown || highDown) return 45;
  return 75;
};

const calculateDualScores = ({
  categoryName,
  recordCount,
  elasticityRate,
  elasticityAmount,
  effectiveSwingRate,
  completedSwingCount,
  tradableSpacePassed,
  twoWayBalanceRate,
  maxAdjacentChangeAmount,
  highZoneOccupancyRate,
  drawdownResistanceScore,
  hardness,
  lowTrend,
  highTrend
}: {
  categoryName: string;
  recordCount: number;
  elasticityRate: number;
  elasticityAmount: number;
  effectiveSwingRate: number;
  completedSwingCount: number;
  tradableSpacePassed: boolean;
  twoWayBalanceRate: number;
  maxAdjacentChangeAmount: number;
  highZoneOccupancyRate: number;
  drawdownResistanceScore: number;
  hardness: number;
  lowTrend: string;
  highTrend: string;
}) => {
  const sampleConfidence = clampScore(((recordCount - 1) / 9) * 100);
  const stabilityScore = clampScore((hardness - 80) * 5);
  const trendStrengthScore = calculateTrendStrengthScore(lowTrend, highTrend);
  const strengthScore = clampScore(
    highZoneOccupancyRate * 0.35
    + drawdownResistanceScore * 0.25
    + trendStrengthScore * 0.25
    + stabilityScore * 0.15
  );

  const rangeElasticityScore = scoreRateByCategory(elasticityRate, categoryName);
  const effectiveSwingScore = scoreEffectiveSwingRate(effectiveSwingRate, categoryName);
  const repeatabilityScore = clampScore((completedSwingCount / 3) * 100);
  const jumpConcentrationRate = elasticityAmount > 0
    ? clampScore((maxAdjacentChangeAmount / elasticityAmount) * 100)
    : 0;
  const singleJumpPenalty = jumpConcentrationRate > 65
    ? clampScore(((jumpConcentrationRate - 65) / 35) * 15)
    : 0;
  // 重心下移属于风险和动作层，不抹掉真实存在的可重复跌后反弹。
  const downTrendPenalty = 0;
  const elasticityCycleCap = completedSwingCount === 0 ? 20 : completedSwingCount === 1 ? 59 : 100;
  const tradableSpaceCap = completedSwingCount > 0 && !tradableSpacePassed ? 39 : 100;
  const rawElasticityScore = clampScore(
    rangeElasticityScore * 0.1
    + effectiveSwingScore * 0.4
    + repeatabilityScore * 0.35
    + twoWayBalanceRate * 0.15
    - singleJumpPenalty
  );
  const elasticityScore = Math.min(rawElasticityScore, elasticityCycleCap, tradableSpaceCap);

  return {
    strength_score: strengthScore,
    elasticity_score: elasticityScore,
    sample_confidence: sampleConfidence,
    high_zone_occupancy_rate: highZoneOccupancyRate,
    drawdown_resistance_score: drawdownResistanceScore,
    stability_score: stabilityScore,
    trend_strength_score: trendStrengthScore,
    range_elasticity_score: rangeElasticityScore,
    effective_swing_score: effectiveSwingScore,
    repeatability_score: repeatabilityScore,
    jump_concentration_rate: jumpConcentrationRate,
    single_jump_penalty: singleJumpPenalty,
    down_trend_penalty: downTrendPenalty,
    elasticity_cycle_cap: elasticityCycleCap,
    tradable_space_cap: tradableSpaceCap,
    category_elasticity_reference_rate: getCategoryElasticityReferenceRate(categoryName)
  };
};

const getStrengthLevel = (score: number, recordCount: number) => {
  if (recordCount < 4) return '样本不足';
  return score >= 75 ? '高强度' : score >= 50 ? '中强度' : '低强度';
};

const getElasticityLevel = (score: number) => (
  score >= 60 ? '高弹性' : score >= 40 ? '中弹性' : '低弹性'
);

const buildStrategyAssessment = ({
  recordCount,
  strengthScore,
  elasticityScore,
  completedSwingCount,
  tradableSpacePassed,
  tradableSpaceHint,
  positionRate,
  lowTrend,
  highTrend
}: {
  recordCount: number;
  strengthScore: number;
  elasticityScore: number;
  completedSwingCount: number;
  tradableSpacePassed: boolean;
  tradableSpaceHint: string;
  positionRate: number;
  lowTrend: string;
  highTrend: string;
}) => {
  if (recordCount < 4) {
    return {
      strategy_tag: '样本待积累',
      strategy_hint: '价格记录太少，暂不按强度或弹性安排批量动作。'
    };
  }

  if (completedSwingCount > 0 && !tradableSpacePassed) {
    return {
      strategy_tag: '低优先级',
      strategy_hint: `${tradableSpaceHint} 暂不占用批量资金。`
    };
  }

  const isDownTrend = lowTrend.includes('下移') && highTrend.includes('下移');
  if (isDownTrend && positionRate < 40) {
    return {
      strategy_tag: elasticityScore >= 60 ? '高弹性阴跌观察' : '单边阴跌排后',
      strategy_hint: '弹性不能覆盖高低点同步下移，先等止跌和低点不再下移，不接飞刀。'
    };
  }

  if (elasticityScore >= 60) {
    if (positionRate < 40) {
      return {
        strategy_tag: '高弹性低位候选',
        strategy_hint: '具备重复波段空间且当前偏低，可进入批量拿货观察，仍需核对成交和供给。'
      };
    }
    if (positionRate >= 70) {
      return {
        strategy_tag: '高弹性高位兑现',
        strategy_hint: '弹性仍在但当前位置偏高，已有货优先分批兑现，新货不追。'
      };
    }
    return {
      strategy_tag: '高弹性中位等待',
      strategy_hint: '波段空间成立，但当前位置不够舒服，等回到低位区再考虑批量拿货。'
    };
  }

  if (strengthScore >= 75 && elasticityScore < 40) {
    return {
      strategy_tag: '高强度平台差价',
      strategy_hint: '价格结构稳定、风险相对低，只适合平台活动或渠道价差，利润和规模预期要压低。'
    };
  }

  if (elasticityScore >= 40) {
    return {
      strategy_tag: positionRate < 40 ? '中弹性低位观察' : '中弹性继续观察',
      strategy_hint: positionRate < 40
        ? '位置开始接近低位，但弹性证据还不够强，先小样本观察。'
        : '有一定波动空间，等待更低位置或更多完整波段样本。'
    };
  }

  return {
    strategy_tag: strengthScore >= 75 ? '高强度低弹性' : '低优先级',
    strategy_hint: strengthScore >= 75
      ? '结构稳定但波段空间不足，除平台差价外不作为批量拿货重点。'
      : '强度和弹性都不足，暂不进入重点观察。'
  };
};

// 弹性/硬度分析接口
router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    
    // 解析参数
    const { 
      period = 30, 
      category_name, 
      object_name, 
      variant_name, 
      sideways_mode = 'amount', 
      sideways_threshold_amount = 30, 
      sideways_threshold_percent = 2, 
      min_sideways_count = 3, 
      compare_mode = 'all'
    } = req.query;
    
    // 处理 period 参数
    let periodValue: number | 'all' = 'all';
    if (period !== 'all') {
      periodValue = Number(period) || 30;
    }
    
    // 获取价格记录
    const groupedRecords = await getPriceRecords(db, periodValue, {
      category_name: category_name as string,
      object_name: object_name as string,
      variant_name: variant_name as string
    });

    const allRecords = Object.values(groupedRecords).flat();
    const analysisEndDate = allRecords.reduce((latest: string, record: any) => (
      !latest || record.date > latest ? record.date : latest
    ), '');
    const elasticityScoringWindowDays = periodValue === 'all'
      ? 30
      : Math.max(1, Math.min(periodValue, 30));
    const elasticityScoringStartDate = analysisEndDate
      ? subtractIsoDays(analysisEndDate, elasticityScoringWindowDays - 1)
      : '';

    // 计算分析数据
    const results: any[] = [];
    
    for (const key of Object.keys(groupedRecords)) {
      const records = groupedRecords[key];
      const target = records[0];
      const elasticityWindowRecords = elasticityScoringStartDate
        ? records.filter((record: any) => record.date >= elasticityScoringStartDate && record.date <= analysisEndDate)
        : [];
      
      if (records.length < 2) {
        // 记录不足的情况
        results.push({
          // 基础字段
          category_name: target.category_name,
          object_name: target.object_name,
          variant_name: target.variant_name,
          category_id: target.category_id,
          object_id: target.object_id,
          variant_id: target.variant_id,
          current_price: target.price,
          start_price: target.price,
          highest_price: target.price,
          lowest_price: target.price,
          start_date: target.date,
          current_date: target.date,
          highest_date: target.date,
          lowest_date: target.date,
          record_count: records.length,
          elasticity_window_days: elasticityScoringWindowDays,
          elasticity_window_record_count: elasticityWindowRecords.length,
          elasticity_window_start_date: elasticityScoringStartDate || null,
          elasticity_window_end_date: analysisEndDate || null,
          
          // 区间涨跌
          range_change_amount: 0,
          range_change_rate: 0,
          
          // 区间弹性
          elasticity_amount: 0,
          elasticity_rate: 0,
          
          // 当前区间位置
          position_rate: 50,
          position_level: '中位',
          
          // 高位保持率
          high_hold_rate: 100,
          
          // 上涨后回撤率
          post_peak_drawdown_rate: 0,
          
          // 修复率
          repair_rate: 0,
          
          // 相邻价格差分析
          last_change_amount: 0,
          last_change_rate: 0,
          max_adjacent_change_amount: 0,
          max_adjacent_change_rate: 0,
          max_adjacent_change_direction: '持平',
          max_adjacent_change_from_date: null,
          max_adjacent_change_to_date: null,
          max_adjacent_change_from_price: null,
          max_adjacent_change_to_price: null,
          max_single_rise_amount: 0,
          max_single_rise_rate: 0,
          max_single_drop_amount: 0,
          max_single_drop_rate: 0,
          avg_change_amount: 0,
          rise_count: 0,
          drop_count: 0,
          flat_count: 0,
          
          // 横盘分析
          sideways_count: 0,
          sideways_days: 0,
          sideways_start_date: null,
          sideways_end_date: null,
          sideways_price_low: 0,
          sideways_price_high: 0,
          sideways_center_price: 0,
          sideways_position: 'unknown',
          sideways_break_direction: '未突破',
          sideways_break_amount: 0,
          sideways_break_rate: 0,
          
          // 高点低点变化
          front_low: 0,
          back_low: 0,
          front_high: 0,
          back_high: 0,
          low_trend: '持平',
          high_trend: '持平',
          
          // 系统标签
          analysis_tag: '数据不足',
          action_hint: '历史价格记录不足，暂无法判断弹性',
          strategy_tag: '样本待积累',
          strategy_hint: '价格记录太少，暂不按强度或弹性安排批量动作。',
          
          // 双层评分
          score: 0,
          strength_score: 0,
          elasticity_score: 0,
          strength_level: '未评分',
          elasticity_level: '未评分',
          effective_swing_amount: 0,
          effective_swing_rate: 0,
          swing_run_count: 0,
          completed_swing_count: 0,
          direction_change_count: 0,
          median_up_swing_rate: 0,
          median_down_swing_rate: 0,
          two_way_balance_rate: 0,
          meaningful_swing_threshold_rate: getMeaningfulSwingThresholdRate(target.category_name),
          effective_swing_target_rate: getEffectiveSwingTargetRate(target.category_name),
          minimum_tradable_range_amount: getMinimumTradableRangeAmount(target.category_name),
          minimum_tradable_range_rate: getMinimumTradableRangeRate(target.category_name),
          tradable_space_passed: false,
          tradable_space_hint: '暂无完整跌后反弹，不能形成可做空间。',
          elasticity_pattern: '样本不足',
          sample_confidence: 0,
          high_zone_occupancy_rate: 0,
          drawdown_resistance_score: 0,
          stability_score: 0,
          trend_strength_score: 0,
          range_elasticity_score: 0,
          effective_swing_score: 0,
          repeatability_score: 0,
          jump_concentration_rate: 0,
          single_jump_penalty: 0,
          down_trend_penalty: 0,
          elasticity_cycle_cap: 0,
          tradable_space_cap: 0,
          category_elasticity_reference_rate: getCategoryElasticityReferenceRate(target.category_name),
          score_model_version: DUAL_SCORE_MODEL_VERSION,
          rank_in_group: 1,
          
          // 硬度指标
          hardness: 100
        });
        continue;
      }

      const prices = records.map(record => record.price);
      const dates = records.map(record => record.date);
      const changes = calculatePriceChanges(prices);
      const elasticityWindowPrices = elasticityWindowRecords.map((record: any) => record.price);
      const elasticityWindowDates = elasticityWindowRecords.map((record: any) => record.date);

      // 计算各种指标
      const currentPrice = prices[prices.length - 1];
      const startPrice = prices[0];
      const lowestPrice = Math.min(...prices);
      const highestPrice = Math.max(...prices);
      const lowestIndex = prices.indexOf(lowestPrice);
      const highestIndex = prices.indexOf(highestPrice);
      const lowestDate = dates[lowestIndex];
      const highestDate = dates[highestIndex];
      
      // 区间涨跌
      const rangeChangeAmount = currentPrice - startPrice;
      const rangeChangeRate = startPrice > 0 ? (rangeChangeAmount / startPrice) * 100 : 0;
      
      // 弹性指标
      const elasticity = calculateElasticity(elasticityWindowPrices);
      const swingMetrics = calculateSwingMetrics(elasticityWindowPrices, target.category_name);
      const elasticityPriceDifferences = calculatePriceDifferences(elasticityWindowPrices, elasticityWindowDates);
      const strengthStructureMetrics = calculateStrengthStructureMetrics(prices);
      const hardness = calculateHardness(prices);
      
      // 位置率
      const positionRate = calculatePositionRate(prices);
      
      // 高位保持率
      const highHoldRate = calculateHighHoldRate(prices);
      
      // 上涨后回撤率
      const postPeakDrawdownRate = calculatePostPeakDrawdownRate(prices);
      
      // 修复率
      const repairRate = calculateRepairRate(prices);
      
      // 相邻价格差分析
      const priceDifferences = calculatePriceDifferences(prices, dates);
      
      // 横盘分析
      const sideways = calculateSideways(
        prices, 
        dates, 
        sideways_mode as 'amount' | 'percent',
        Number(sideways_threshold_amount),
        Number(sideways_threshold_percent),
        Number(min_sideways_count)
      );
      
      // 高点低点趋势
      const highLowTrends = calculateHighLowTrends(prices);

      const dualScores = calculateDualScores({
        categoryName: target.category_name,
        recordCount: elasticityWindowRecords.length,
        elasticityRate: elasticity.elasticity_rate,
        elasticityAmount: elasticity.elasticity_amount,
        effectiveSwingRate: swingMetrics.effective_swing_rate,
        completedSwingCount: swingMetrics.completed_swing_count,
        tradableSpacePassed: swingMetrics.tradable_space_passed,
        twoWayBalanceRate: swingMetrics.two_way_balance_rate,
        maxAdjacentChangeAmount: elasticityPriceDifferences.max_adjacent_change_amount,
        highZoneOccupancyRate: strengthStructureMetrics.high_zone_occupancy_rate,
        drawdownResistanceScore: strengthStructureMetrics.drawdown_resistance_score,
        hardness,
        lowTrend: highLowTrends.low_trend,
        highTrend: highLowTrends.high_trend
      });
      const strategyAssessment = buildStrategyAssessment({
        recordCount: elasticityWindowRecords.length,
        strengthScore: dualScores.strength_score,
        elasticityScore: dualScores.elasticity_score,
        completedSwingCount: swingMetrics.completed_swing_count,
        tradableSpacePassed: swingMetrics.tradable_space_passed,
        tradableSpaceHint: swingMetrics.tradable_space_hint,
        positionRate,
        lowTrend: highLowTrends.low_trend,
        highTrend: highLowTrends.high_trend
      });
      
      // 价格位置分档
      let positionLevel = '中位';
      if (positionRate >= 70) {
        positionLevel = '高位';
      } else if (positionRate < 40) {
        positionLevel = '低位';
      }
      
      // 计算系统标签和操作提示
      let analysisTag = '中位震荡';
      let actionHint = '当前方向不明确，继续观察结构变化。';
      
      // 标签优先级从上到下匹配
      if (sideways.sideways_position !== '阈值过大' && sideways.sideways_position === '高位' && sideways.sideways_break_direction === '向下破位') {
        analysisTag = '高位横盘破位';
        actionHint = '高位横盘后向下破位，短期风控优先，暂不追。';
      } else if (sideways.sideways_position !== '阈值过大' && sideways.sideways_position === '低位' && sideways.sideways_break_direction === '向上突破') {
        analysisTag = '低位横盘修复';
        actionHint = '低位横盘后向上突破，可能进入修复阶段，可加入观察。';
      } else if (highLowTrends.low_trend === '低点下移' && highLowTrends.high_trend === '高点下移' && positionRate < 40) {
        analysisTag = '单边阴跌型';
        actionHint = '高低点同步下移，当前接近低位，弱市优先排除，不接飞刀。';
      } else if (sideways.sideways_position !== '阈值过大' && sideways.sideways_position === '低位' && sideways.sideways_count >= Number(min_sideways_count) && positionRate < 40) {
        analysisTag = '低位横盘型';
        actionHint = '低位横盘起不来，暂时缺少弹性，先观察。';
      } else if (elasticity.elasticity_rate >= 30 && postPeakDrawdownRate >= 20) {
        analysisTag = '尖峰脉冲型';
        actionHint = '出现过明显尖峰，但高点回落较大，不能把尖峰价当常态，不适合追高。';
      } else if (highHoldRate >= 97 && postPeakDrawdownRate <= 3 && positionRate >= 70) {
        analysisTag = '高位强横盘';
        actionHint = '涨后高位保持较好，同组偏强，可重点观察，但仍不追高。';
      } else if (highHoldRate >= 92 && postPeakDrawdownRate <= 8 && positionRate >= 70) {
        analysisTag = '高位横盘偏强';
        actionHint = '有一定回落但仍处高位区间，承接尚可。';
      } else if (repairRate >= 80 && positionRate >= 70) {
        analysisTag = '强修复偏硬型';
        actionHint = '下跌后修复能力较强，当前处于高位区间，可重点观察。';
      } else if (elasticity.elasticity_rate >= 20 && positionRate >= 40 && !(highLowTrends.low_trend === '低点下移' && highLowTrends.high_trend === '高点下移')) {
        analysisTag = '高弹性波段型';
        actionHint = '区间弹性较大，有波段空间，适合低吸高抛，不追高。';
      } else if (elasticity.elasticity_rate < 5) {
        analysisTag = '窄幅震荡型';
        actionHint = '价格波动空间较小，弹性不足，暂不适合作为波段重点。';
      }
      
      results.push({
        // 基础字段
        category_name: target.category_name,
        object_name: target.object_name,
        variant_name: target.variant_name,
        category_id: target.category_id,
        object_id: target.object_id,
        variant_id: target.variant_id,
        current_price: currentPrice,
        start_price: startPrice,
        highest_price: highestPrice,
        lowest_price: lowestPrice,
        start_date: dates[0],
        current_date: dates[dates.length - 1],
        highest_date: highestDate,
        lowest_date: lowestDate,
        record_count: records.length,
        elasticity_window_days: elasticityScoringWindowDays,
        elasticity_window_record_count: elasticityWindowRecords.length,
        elasticity_window_start_date: elasticityScoringStartDate || null,
        elasticity_window_end_date: analysisEndDate || null,
        
        // 区间涨跌
        range_change_amount: rangeChangeAmount,
        range_change_rate: parseFloat(rangeChangeRate.toFixed(2)),
        
        // 区间弹性
        elasticity_amount: elasticity.elasticity_amount,
        elasticity_rate: parseFloat(elasticity.elasticity_rate.toFixed(2)),
        
        // 当前区间位置
        position_rate: parseFloat(positionRate.toFixed(2)),
        position_level: positionLevel,
        
        // 高位保持率
        high_hold_rate: parseFloat(highHoldRate.toFixed(2)),
        
        // 上涨后回撤率
        post_peak_drawdown_rate: parseFloat(postPeakDrawdownRate.toFixed(2)),
        
        // 修复率
        repair_rate: parseFloat(repairRate.toFixed(2)),
        
        // 相邻价格差分析
        last_change_amount: priceDifferences.last_change_amount,
        last_change_rate: parseFloat(priceDifferences.last_change_rate.toFixed(2)),
        max_adjacent_change_amount: parseFloat(priceDifferences.max_adjacent_change_amount.toFixed(2)),
        max_adjacent_change_rate: parseFloat(priceDifferences.max_adjacent_change_rate.toFixed(2)),
        max_adjacent_change_direction: priceDifferences.max_adjacent_change_direction,
        max_adjacent_change_from_date: priceDifferences.max_adjacent_change_from_date,
        max_adjacent_change_to_date: priceDifferences.max_adjacent_change_to_date,
        max_adjacent_change_from_price: priceDifferences.max_adjacent_change_from_price,
        max_adjacent_change_to_price: priceDifferences.max_adjacent_change_to_price,
        max_single_rise_amount: priceDifferences.max_single_rise_amount,
        max_single_rise_rate: parseFloat(priceDifferences.max_single_rise_rate.toFixed(2)),
        max_single_drop_amount: priceDifferences.max_single_drop_amount,
        max_single_drop_rate: parseFloat(priceDifferences.max_single_drop_rate.toFixed(2)),
        avg_change_amount: parseFloat(priceDifferences.avg_change_amount.toFixed(2)),
        rise_count: priceDifferences.rise_count,
        drop_count: priceDifferences.drop_count,
        flat_count: priceDifferences.flat_count,
        
        // 横盘分析
        sideways_count: sideways.sideways_count,
        sideways_days: sideways.sideways_days,
        sideways_start_date: sideways.sideways_start_date,
        sideways_end_date: sideways.sideways_end_date,
        sideways_price_low: sideways.sideways_price_low,
        sideways_price_high: sideways.sideways_price_high,
        sideways_center_price: sideways.sideways_center_price,
        sideways_position: sideways.sideways_position,
        sideways_break_direction: sideways.sideways_break_direction,
        sideways_break_amount: sideways.sideways_break_amount,
        sideways_break_rate: sideways.sideways_break_rate !== null ? parseFloat(sideways.sideways_break_rate.toFixed(2)) : 0,
        
        // 高点低点变化
        front_low: highLowTrends.front_low,
        back_low: highLowTrends.back_low,
        front_high: highLowTrends.front_high,
        back_high: highLowTrends.back_high,
        low_trend: highLowTrends.low_trend,
        high_trend: highLowTrends.high_trend,
        
        // 系统标签
        analysis_tag: analysisTag,
        action_hint: strategyAssessment.strategy_hint,
        structure_action_hint: actionHint,
        strategy_tag: strategyAssessment.strategy_tag,
        strategy_hint: strategyAssessment.strategy_hint,
        
        // 双层评分；score 保留为弹性分别名，兼容旧调用方
        score: parseFloat(dualScores.elasticity_score.toFixed(2)),
        strength_score: parseFloat(dualScores.strength_score.toFixed(2)),
        elasticity_score: parseFloat(dualScores.elasticity_score.toFixed(2)),
        strength_level: getStrengthLevel(dualScores.strength_score, records.length),
        elasticity_level: getElasticityLevel(dualScores.elasticity_score),
        effective_swing_amount: parseFloat(swingMetrics.effective_swing_amount.toFixed(2)),
        effective_swing_rate: parseFloat(swingMetrics.effective_swing_rate.toFixed(2)),
        swing_run_count: swingMetrics.swing_run_count,
        completed_swing_count: swingMetrics.completed_swing_count,
        direction_change_count: swingMetrics.direction_change_count,
        median_up_swing_rate: parseFloat(swingMetrics.median_up_swing_rate.toFixed(2)),
        median_down_swing_rate: parseFloat(swingMetrics.median_down_swing_rate.toFixed(2)),
        two_way_balance_rate: parseFloat(swingMetrics.two_way_balance_rate.toFixed(2)),
        meaningful_swing_threshold_rate: swingMetrics.meaningful_swing_threshold_rate,
        effective_swing_target_rate: swingMetrics.effective_swing_target_rate,
        minimum_tradable_range_amount: swingMetrics.minimum_tradable_range_amount,
        minimum_tradable_range_rate: swingMetrics.minimum_tradable_range_rate,
        tradable_space_passed: swingMetrics.tradable_space_passed,
        tradable_space_hint: swingMetrics.tradable_space_hint,
        elasticity_pattern: swingMetrics.elasticity_pattern,
        sample_confidence: parseFloat(dualScores.sample_confidence.toFixed(2)),
        high_zone_occupancy_rate: parseFloat(dualScores.high_zone_occupancy_rate.toFixed(2)),
        drawdown_resistance_score: parseFloat(dualScores.drawdown_resistance_score.toFixed(2)),
        stability_score: parseFloat(dualScores.stability_score.toFixed(2)),
        trend_strength_score: parseFloat(dualScores.trend_strength_score.toFixed(2)),
        range_elasticity_score: parseFloat(dualScores.range_elasticity_score.toFixed(2)),
        effective_swing_score: parseFloat(dualScores.effective_swing_score.toFixed(2)),
        repeatability_score: parseFloat(dualScores.repeatability_score.toFixed(2)),
        jump_concentration_rate: parseFloat(dualScores.jump_concentration_rate.toFixed(2)),
        single_jump_penalty: parseFloat(dualScores.single_jump_penalty.toFixed(2)),
        down_trend_penalty: parseFloat(dualScores.down_trend_penalty.toFixed(2)),
        elasticity_cycle_cap: dualScores.elasticity_cycle_cap,
        tradable_space_cap: dualScores.tradable_space_cap,
        category_elasticity_reference_rate: dualScores.category_elasticity_reference_rate,
        score_model_version: DUAL_SCORE_MODEL_VERSION,
        rank_in_group: 1,
        
        // 硬度指标
        hardness: parseFloat(hardness.toFixed(2))
      });
    }

    // 计算同组排名
    const objectGroups: Record<string, any[]> = {};
    results.forEach(item => {
      const objectKey = `${item.category_name}|${item.object_name}`;
      if (!objectGroups[objectKey]) {
        objectGroups[objectKey] = [];
      }
      objectGroups[objectKey].push(item);
    });
    
    // 对每个组内的变体按弹性分排序并计算排名
    let finalResults: any[] = [];
    Object.values(objectGroups).forEach(group => {
      group.sort((a, b) => b.elasticity_score - a.elasticity_score);
      // 设置排名
      group.forEach((item, index) => {
        item.rank_in_group = index + 1;
      });
      finalResults.push(...group);
    });
    
    // 如果是变体对比模式，保持按对象分组的顺序
    if (compare_mode !== 'variant') {
      finalResults.sort((a, b) => b.elasticity_score - a.elasticity_score);
    }

    res.json({
      status: "success",
      data: finalResults,
      meta: {
        score_model_version: DUAL_SCORE_MODEL_VERSION,
        strength_judges: '周期内高位停留、冲高后回撤抵抗、高低点结构和稳定性；样本量只决定可信度，不参与加分。',
        elasticity_judges: '先识别跌下来后又弹上去的完整波段，再按品类同时核对观察窗口上下限金额和比例；可做空间不足时弹性分封顶 39。零次不能算高弹性，一次最多中弹性。',
        position_affects_action: '低位用于拿货观察，中位等待，高位兑现或不追。',
        elasticity_scoring_window_days: elasticityScoringWindowDays,
        elasticity_scoring_start_date: elasticityScoringStartDate || null,
        elasticity_scoring_end_date: analysisEndDate || null
      }
    });
  } catch (error) {
    console.error('elasticity-analysis error:', error);
    const errorMessage = error instanceof Error ? error.message : '强度/弹性分析失败';
    res.status(500).json({ 
      status: "error", 
      message: errorMessage 
    });
  }
});

export default router;
