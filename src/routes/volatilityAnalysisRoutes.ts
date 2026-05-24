import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 获取价格记录
const getPriceRecords = async (db: any, period: number, categoryId?: string) => {
  let query = `
    SELECT 
      pr.category AS category_name, 
      pr.object_name, 
      COALESCE(pr.variant, '') AS variant_name, 
      pr.price AS current_price, 
      pr.date AS effective_date
    FROM price_records pr
    LEFT JOIN categories c ON c.name = pr.category
    LEFT JOIN objects o ON o.category_id = c.id AND o.name = pr.object_name
    LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(pr.variant, '') AND COALESCE(pr.variant, '') <> ''
    WHERE 1=1
      AND COALESCE(c.is_archived, 0) = 0
      AND COALESCE(o.is_archived, 0) = 0
      AND (COALESCE(pr.variant, '') = '' OR COALESCE(v.is_archived, 0) = 0)
      AND pr.date BETWEEN date('now', '-' || ? || ' days') AND date('now')
  `;
  const params: any[] = [period];

  // 暂时不支持 category_id 筛选，因为 price_records 表中没有 category_id 字段
  // 后续可以通过 join categories 表实现

  query += ' ORDER BY pr.category, pr.object_name, pr.variant, pr.date ASC, pr.created_at DESC, pr.id DESC';

  const records = await db.all(query, params);
  
  // 按目标分组
  const groupedRecords: Record<string, any[]> = {};
  records.forEach((record: any) => {
    const key = `${record.category_name}|${record.object_name}|${record.variant_name}`;
    if (!groupedRecords[key]) {
      groupedRecords[key] = [];
    }
    groupedRecords[key].push(record);
  });

  return groupedRecords;
};

// 计算最大回撤
const calculateMaxDrawdown = (prices: number[]): number => {
  if (prices.length < 2) return 0;
  
  let maxDrawdown = 0;
  let peak = prices[0];
  
  for (let i = 1; i < prices.length; i++) {
    const currentPrice = prices[i];
    const drawdown = (currentPrice - peak) / peak * 100;
    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown;
    }
    if (currentPrice > peak) {
      peak = currentPrice;
    }
  }
  
  return maxDrawdown;
};

// 计算修复时间
const calculateRepairTime = (prices: number[], dates: string[]): number => {
  if (prices.length < 2) return 0;
  
  let peak = prices[0];
  let peakDate = new Date(dates[0]);
  let repairTime = 0;
  
  for (let i = 1; i < prices.length; i++) {
    const currentPrice = prices[i];
    const currentDate = new Date(dates[i]);
    
    if (currentPrice > peak) {
      peak = currentPrice;
      peakDate = currentDate;
    } else if (currentPrice < peak) {
      // 寻找修复时间
      for (let j = i + 1; j < prices.length; j++) {
        if (prices[j] >= peak) {
          const repairDate = new Date(dates[j]);
          const days = Math.ceil((repairDate.getTime() - peakDate.getTime()) / (1000 * 60 * 60 * 24));
          if (days > repairTime) {
            repairTime = days;
          }
          break;
        }
      }
    }
  }
  
  return repairTime;
};

// 计算波动幅度
const calculateVolatility = (prices: number[]): { max_increase: number; max_decrease: number } => {
  if (prices.length < 2) return { max_increase: 0, max_decrease: 0 };
  
  let maxIncrease = 0;
  let maxDecrease = 0;
  
  for (let i = 1; i < prices.length; i++) {
    const change = (prices[i] - prices[i - 1]) / prices[i - 1] * 100;
    if (change > maxIncrease) {
      maxIncrease = change;
    } else if (change < maxDecrease) {
      maxDecrease = change;
    }
  }
  
  return { max_increase: maxIncrease, max_decrease: maxDecrease };
};

// 计算横盘时长
const calculateSidewaysDuration = (prices: number[], dates: string[], threshold: number = 2): number => {
  if (prices.length < 2) return 0;
  
  let sidewaysDuration = 0;
  let currentSideways = 1;
  
  for (let i = 1; i < prices.length; i++) {
    const change = Math.abs((prices[i] - prices[i - 1]) / prices[i - 1] * 100);
    if (change <= threshold) {
      currentSideways++;
    } else {
      if (currentSideways > sidewaysDuration) {
        sidewaysDuration = currentSideways;
      }
      currentSideways = 1;
    }
  }
  
  if (currentSideways > sidewaysDuration) {
    sidewaysDuration = currentSideways;
  }
  
  return sidewaysDuration;
};

// 波动性分析接口
router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const { period = 30, category_id } = req.query;
    const periodNum = Number(period) || 30;

    // 暂时忽略 category_id，因为 price_records 表中没有该字段
    // 后续可以通过 join categories 表实现

    // 获取价格记录
    const groupedRecords = await getPriceRecords(db, periodNum);

    // 计算波动性分析数据
    const results: any[] = [];
    
    for (const key of Object.keys(groupedRecords)) {
      const records = groupedRecords[key];
      if (records.length < 2) continue;

      const target = records[0];
      const prices = records.map(record => record.current_price);
      const dates = records.map(record => record.effective_date);

      const maxDrawdown = calculateMaxDrawdown(prices);
      const repairTime = calculateRepairTime(prices, dates);
      const volatility = calculateVolatility(prices);
      const sidewaysDuration = calculateSidewaysDuration(prices, dates);

      results.push({
        category_name: target.category_name,
        object_name: target.object_name,
        variant_name: target.variant_name,
        max_drawdown: parseFloat(maxDrawdown.toFixed(2)),
        repair_time: repairTime,
        volatility: {
          max_increase: parseFloat(volatility.max_increase.toFixed(2)),
          max_decrease: parseFloat(volatility.max_decrease.toFixed(2))
        },
        sideways_duration: sidewaysDuration
      });
    }

    res.json({
      status: "success",
      data: results
    });
  } catch (error) {
    console.error('volatility-analysis error:', error);
    const errorMessage = error instanceof Error ? error.message : '波动性分析失败';
    res.status(500).json({ 
      status: "error", 
      message: errorMessage 
    });
  }
});

export default router;
