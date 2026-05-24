import express from 'express';
import getDb from '../config/database';

const router = express.Router();

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

    // 计算分析数据
    const results: any[] = [];
    
    for (const key of Object.keys(groupedRecords)) {
      const records = groupedRecords[key];
      const target = records[0];
      
      if (records.length < 2) {
        // 记录不足的情况
        results.push({
          // 基础字段
          category_name: target.category_name,
          object_name: target.object_name,
          variant_name: target.variant_name,
          current_price: target.price,
          start_price: target.price,
          highest_price: target.price,
          lowest_price: target.price,
          start_date: target.date,
          current_date: target.date,
          highest_date: target.date,
          lowest_date: target.date,
          record_count: records.length,
          
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
          
          // 综合得分
          score: 0,
          rank_in_group: 1,
          
          // 硬度指标
          hardness: 100
        });
        continue;
      }

      const prices = records.map(record => record.price);
      const dates = records.map(record => record.date);
      const changes = calculatePriceChanges(prices);

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
      const elasticity = calculateElasticity(prices);
      
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
      
      // 计算综合得分
      const score = (
        highHoldRate * 0.35 +
        repairRate * 0.25 +
        positionRate * 0.2 +
        elasticity.elasticity_rate * 0.1 -
        postPeakDrawdownRate * 0.2
      );
      
      results.push({
        // 基础字段
        category_name: target.category_name,
        object_name: target.object_name,
        variant_name: target.variant_name,
        current_price: currentPrice,
        start_price: startPrice,
        highest_price: highestPrice,
        lowest_price: lowestPrice,
        start_date: dates[0],
        current_date: dates[dates.length - 1],
        highest_date: highestDate,
        lowest_date: lowestDate,
        record_count: records.length,
        
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
        action_hint: actionHint,
        
        // 综合得分
        score: parseFloat(score.toFixed(2)),
        rank_in_group: 1,
        
        // 硬度指标
        hardness: parseFloat(calculateHardness(prices).toFixed(2))
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
    
    // 对每个组内的变体按 score 排序并计算排名
    let finalResults: any[] = [];
    Object.values(objectGroups).forEach(group => {
      // 按 score 降序排序
      group.sort((a, b) => b.score - a.score);
      // 设置排名
      group.forEach((item, index) => {
        item.rank_in_group = index + 1;
      });
      finalResults.push(...group);
    });
    
    // 如果是变体对比模式，保持按对象分组的顺序
    if (compare_mode !== 'variant') {
      // 非变体对比模式，按 score 全局排序
      finalResults.sort((a, b) => b.score - a.score);
    }

    res.json({
      status: "success",
      data: finalResults
    });
  } catch (error) {
    console.error('elasticity-analysis error:', error);
    const errorMessage = error instanceof Error ? error.message : '弹性/硬度分析失败';
    res.status(500).json({ 
      status: "error", 
      message: errorMessage 
    });
  }
});

export default router;
