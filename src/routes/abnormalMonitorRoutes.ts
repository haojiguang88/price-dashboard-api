import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 规则类型优先级
const rulePriority: Record<string, number> = {
  new_high: 90,
  new_low: 90,
  price_change_period: 80,
  consecutive_change: 75,
  price_change_daily: 70,
  amplitude: 60
};

// 规则方向映射
const ruleDirectionMap: Record<string, Record<string, string>> = {
  price_change_daily: {
    up: 'bullish',
    down: 'bearish'
  },
  price_change_period: {
    up: 'bullish',
    down: 'bearish'
  },
  consecutive_change: {
    up: 'bullish',
    down: 'bearish'
  },
  new_high: {
    default: 'bullish'
  },
  new_low: {
    default: 'bearish'
  },
  amplitude: {
    default: 'neutral'
  }
};

// 获取价格记录
const getPriceRecords = async (db: any, categoryId?: string) => {
  let query = `
    SELECT 
      category as category_name, 
      object_name, 
      COALESCE(variant, '') as variant_name, 
      price as current_price, 
      date as effective_date
    FROM price_records
    WHERE 1=1
  `;
  const params: any[] = [];

  if (categoryId) {
    // 这里需要根据实际情况调整，可能需要 join 分类表
    query += ' AND category_id = ?';
    params.push(categoryId);
  }

  query += ' ORDER BY category, object_name, variant, date DESC';

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

// 获取启用的规则（支持按对象和品类获取）
const getEnabledRules = async (db: any, categoryId?: string, objectId?: string) => {
  // 获取全局规则
  const globalRules = await db.all('SELECT * FROM monitor_rules WHERE status = ? AND scope_type = ?', ['enabled', 'global']);
  
  // 获取品类规则
  const categoryRules = categoryId ? 
    await db.all('SELECT * FROM monitor_rules WHERE status = ? AND scope_type = ? AND scope_id = ?', ['enabled', 'category', categoryId]) : 
    [];
  
  // 获取对象规则
  const objectRules = objectId ? 
    await db.all('SELECT * FROM monitor_rules WHERE status = ? AND scope_type = ? AND scope_id = ?', ['enabled', 'object', objectId]) : 
    [];
  
  // 定义规则类型
interface MonitorRule {
  id: number;
  rule_code: string;
  rule_name: string;
  rule_type: string;
  scope_type: string;
  scope_id: number | null;
  params_json: string;
  action_text: string | null;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

// 合并规则，对象规则覆盖品类规则，品类规则覆盖全局规则
  const mergedRules: MonitorRule[] = [];
  const ruleTypes: Set<string> = new Set();
  
  // 先添加对象规则
  objectRules.forEach((rule: MonitorRule) => {
    mergedRules.push(rule);
    ruleTypes.add(rule.rule_type);
  });
  
  // 再添加品类规则（排除已被对象规则覆盖的类型）
  categoryRules.forEach((rule: MonitorRule) => {
    if (!ruleTypes.has(rule.rule_type)) {
      mergedRules.push(rule);
      ruleTypes.add(rule.rule_type);
    }
  });
  
  // 再添加全局规则（排除已被覆盖的类型）
  globalRules.forEach((rule: MonitorRule) => {
    if (!ruleTypes.has(rule.rule_type)) {
      mergedRules.push(rule);
    }
  });
  
  return mergedRules;
};

// 计算单日涨跌幅
const calculateDailyChange = (prices: number[]) => {
  if (prices.length < 2) return null;
  return ((prices[0] - prices[1]) / prices[1]) * 100;
};

// 计算区间涨跌幅
const calculatePeriodChange = (prices: number[]) => {
  if (prices.length < 2) return null;
  return ((prices[0] - prices[prices.length - 1]) / prices[prices.length - 1]) * 100;
};

// 计算连续涨跌
const calculateConsecutiveChange = (prices: number[]) => {
  if (prices.length < 2) return { direction: null, count: 0 };

  let direction = prices[0] > prices[1] ? 'up' : prices[0] < prices[1] ? 'down' : null;
  let count = direction ? 1 : 0;

  for (let i = 1; i < prices.length - 1; i++) {
    const currentDirection = prices[i] > prices[i + 1] ? 'up' : prices[i] < prices[i + 1] ? 'down' : null;
    if (currentDirection === direction && currentDirection !== null) {
      count++;
    } else {
      break;
    }
  }

  return { direction, count };
};

// 计算区间振幅
const calculateAmplitude = (prices: number[]) => {
  if (prices.length < 2) return null;
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const avg = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  return ((max - min) / avg) * 100;
};

// 检查是否新高
const isNewHigh = (prices: number[]) => {
  if (prices.length < 2) return false;
  const currentPrice = prices[0];
  const previousPrices = prices.slice(1);
  return currentPrice >= Math.max(...previousPrices);
};

// 检查是否新低
const isNewLow = (prices: number[]) => {
  if (prices.length < 2) return false;
  const currentPrice = prices[0];
  const previousPrices = prices.slice(1);
  return currentPrice <= Math.min(...previousPrices);
};

// 计算提醒等级
const calculateAlertLevel = (value: number): string => {
  const absValue = Math.abs(value);
  if (absValue < 10) {
    return 'normal';
  } else if (absValue >= 10 && absValue < 20) {
    return 'important';
  } else {
    return 'critical';
  }
};

// 执行规则命中
const executeRules = (target: any, prices: number[], rules: any[]) => {
  const hits: any[] = [];

  rules.forEach(rule => {
    try {
      const params = JSON.parse(rule.params_json);
      const days = params.days || 7;
      const threshold = params.threshold || 5;
      const direction = params.direction;

      // 只取最近 N 条记录
      const recentPrices = prices.slice(0, days);
      if (recentPrices.length < 2) return;

      let hit = false;
      let hitDirection = 'neutral';
      let actualChangeValue: number | null = null;

      switch (rule.rule_type) {
        case 'price_change_daily': {
          const change = calculateDailyChange(recentPrices);
          if (change !== null) {
            actualChangeValue = change;
            if (direction === 'up' && change >= threshold) {
              hit = true;
              hitDirection = 'bullish';
            } else if (direction === 'down' && change <= -threshold) {
              hit = true;
              hitDirection = 'bearish';
            }
          }
          break;
        }
        case 'price_change_period': {
          const change = calculatePeriodChange(recentPrices);
          if (change !== null) {
            actualChangeValue = change;
            if (direction === 'up' && change >= threshold) {
              hit = true;
              hitDirection = 'bullish';
            } else if (direction === 'down' && change <= -threshold) {
              hit = true;
              hitDirection = 'bearish';
            }
          }
          break;
        }
        case 'consecutive_change': {
          const consecutive = calculateConsecutiveChange(recentPrices);
          if (consecutive.direction && consecutive.count >= (params.days || 3)) {
            hit = true;
            hitDirection = consecutive.direction === 'up' ? 'bullish' : 'bearish';
          }
          break;
        }
        case 'new_high': {
          if (isNewHigh(recentPrices)) {
            hit = true;
            hitDirection = 'bullish';
          }
          break;
        }
        case 'new_low': {
          if (isNewLow(recentPrices)) {
            hit = true;
            hitDirection = 'bearish';
          }
          break;
        }
        case 'amplitude': {
          const amplitude = calculateAmplitude(recentPrices);
          if (amplitude !== null && amplitude >= threshold) {
            actualChangeValue = amplitude;
            hit = true;
            hitDirection = 'neutral';
          }
          break;
        }
      }

      if (hit) {
        hits.push({
          rule_id: rule.id,
          rule_code: rule.rule_code,
          rule_name: rule.rule_name,
          rule_type: rule.rule_type,
          direction: hitDirection,
          priority: rulePriority[rule.rule_type] || 0,
          action_text: rule.action_text,
          description: rule.description,
          params_json: rule.params_json,
          actual_change_value: actualChangeValue,
          alert_level: actualChangeValue !== null ? calculateAlertLevel(actualChangeValue) : 'normal'
        });
      }
    } catch (error) {
      console.error('Error executing rule:', error);
    }
  });

  return hits;
};

// 计算信号状态
const calculateSignalState = (hits: any[]) => {
  if (hits.length === 0) return null;
  if (hits.length === 1) return 'single_signal';

  const directions = hits.map(hit => hit.direction);
  const hasBullish = directions.includes('bullish');
  const hasBearish = directions.includes('bearish');
  const hasNeutral = directions.includes('neutral');

  if (hasBullish && hasBearish) {
    return 'divergent_signal';
  } else if (hasBullish) {
    return 'multi_signal_bullish';
  } else if (hasBearish) {
    return 'multi_signal_bearish';
  } else {
    return 'multi_signal_neutral';
  }
};

// 生成 read_key
const generateReadKey = (result: any): string => {
  const targetType = result.target_type || 'object';
  const categoryName = result.category_name || '';
  const objectName = result.object_name || '';
  const variantName = result.variant_name || '';
  const ruleCode = result.primary_rule?.rule_code || '';
  const effectiveDate = result.effective_date || '';
  
  return `${targetType}|${categoryName}|${objectName}|${variantName}|${ruleCode}|${effectiveDate}`;
};

// 聚合结果
const aggregateResults = async (db: any, groupedRecords: Record<string, any[]>) => {
  const results: any[] = [];

  for (const key of Object.keys(groupedRecords)) {
    const records = groupedRecords[key];
    if (records.length === 0) continue;

    const target = records[0];
    const prices = records.map(record => record.current_price);

    // 获取主数据 ID
    let categoryId = null;
    let objectId = null;
    let variantId = null;
    try {
      // 查询品类 ID
      const category = await db.get('SELECT id FROM categories WHERE name = ?', [target.category_name]);
      if (category) {
        categoryId = category.id;
        
        // 查询对象 ID
        const object = await db.get('SELECT id FROM objects WHERE category_id = ? AND name = ?', [categoryId, target.object_name]);
        if (object) {
          objectId = object.id;
          
          // 查询变体 ID（如果有）
          if (target.variant_name) {
            const variant = await db.get('SELECT id FROM variants WHERE object_id = ? AND name = ?', [objectId, target.variant_name]);
            if (variant) {
              variantId = variant.id;
            }
          }
        }
      }
    } catch (error) {
      console.error('Error getting master data IDs:', error);
    }

    // 获取启用的规则（对象规则覆盖品类规则，品类规则覆盖全局规则）
    const rules = await getEnabledRules(db, categoryId, objectId);

    const hits = executeRules(target, prices, rules);
    if (hits.length === 0) continue;

    // 按优先级排序，选择主规则
    hits.sort((a, b) => b.priority - a.priority);
    const primaryRule = hits[0];
    const secondaryRules = hits.slice(1);

    const signalState = calculateSignalState(hits);

    // 计算目标级别的实际异动幅度和提醒等级（取主规则的值）
    const actualChangeValue = primaryRule.actual_change_value || 0;
    const alertLevel = primaryRule.alert_level || 'normal';

    const result: any = {
    target_type: 'object', // 暂时默认为 object
    category_id: categoryId,
    category_name: target.category_name,
    object_id: objectId,
    object_name: target.object_name,
    variant_id: variantId,
    variant_name: target.variant_name,
    current_price: target.current_price,
    effective_date: target.effective_date,
    hit_count: hits.length,
    actual_change_value: actualChangeValue,
    alert_level: alertLevel,
    primary_rule: primaryRule,
    secondary_rules: secondaryRules,
    signal_state: signalState,
    read_key: '',
    is_read: false
  };

  // 生成 read_key
  result.read_key = generateReadKey(result);

    results.push(result);
  }

  return results;
};

// 排序结果
const sortResults = (results: any[], sortBy: string) => {
  switch (sortBy) {
    case 'hit_count':
      return results.sort((a, b) => b.hit_count - a.hit_count);
    case 'priority':
      return results.sort((a, b) => b.primary_rule.priority - a.primary_rule.priority);
    case 'date':
      return results.sort((a, b) => new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime());
    default:
      // 默认排序：hit_count DESC, priority DESC, effective_date DESC
      return results.sort((a, b) => {
        if (b.hit_count !== a.hit_count) {
          return b.hit_count - a.hit_count;
        }
        if (b.primary_rule.priority !== a.primary_rule.priority) {
          return b.primary_rule.priority - a.primary_rule.priority;
        }
        return new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime();
      });
  }
};

// 异动监控接口
router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const { category_id, signal_state, rule_type, sort_by = 'default' } = req.query;

    // 获取价格记录
    const groupedRecords = await getPriceRecords(db, category_id as string);

    // 执行规则命中
    let results = await aggregateResults(db, groupedRecords);

    // 过滤已读结果
    if (results.length > 0) {
      const readKeys = results.map(result => result.read_key);
      const placeholders = readKeys.map(() => '?').join(',');
      const readRecords = await db.all(
        `SELECT read_key FROM abnormal_monitor_reads WHERE read_key IN (${placeholders})`,
        readKeys
      );
      const readKeySet = new Set(readRecords.map((record: any) => record.read_key));
      results = results.filter(result => !readKeySet.has(result.read_key));
    }

    // 过滤结果
    if (signal_state) {
      results = results.filter(result => result.signal_state === signal_state);
    }

    if (rule_type) {
      results = results.filter(result => 
        result.primary_rule.rule_type === rule_type ||
        result.secondary_rules.some((rule: any) => rule.rule_type === rule_type)
      );
    }

    // 排序结果
    results = sortResults(results, sort_by as string);

    res.json({
      status: "success",
      data: results
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取异动监控结果失败", error: errorMessage });
  }
});

// 标记已读接口
router.post('/read', async (req, res) => {
  try {
    const db = await getDb();
    const { read_key } = req.body;

    if (!read_key) {
      res.status(400).json({ status: "error", message: "read_key 必填" });
      return;
    }

    // 解析 read_key 提取信息
    const parts = read_key.split('|');
    if (parts.length !== 6) {
      res.status(400).json({ status: "error", message: "read_key 格式错误" });
      return;
    }

    const [target_type, category_name, object_name, variant_name, rule_code, effective_date] = parts;

    // 写入已读记录（幂等处理）
    try {
      await db.run(
        `INSERT OR IGNORE INTO abnormal_monitor_reads 
         (read_key, target_type, category_name, object_name, variant_name, rule_code, effective_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [read_key, target_type, category_name, object_name, variant_name, rule_code, effective_date]
      );
    } catch (error) {
      console.error('Error inserting read record:', error);
    }

    res.json({
      status: "success",
      message: "已标记为已读"
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "标记已读失败", error: errorMessage });
  }
});

export default router;
