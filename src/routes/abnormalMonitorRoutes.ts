import express from 'express';
import getDb from '../config/database';

const router = express.Router();

const isDebugEnabled = (value?: string) => (
  ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase())
);

const debugAbnormalMonitorLog = (message: string, payload?: unknown) => {
  if (!isDebugEnabled(process.env.DEBUG_ABNORMAL_MONITOR)) return;
  if (payload === undefined) {
    console.log(message);
    return;
  }
  console.log(message, payload);
};

const encodeReadKeyPart = (value: unknown) => encodeURIComponent(String(value || ''));
const decodeReadKeyPart = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const firstQueryValue = (value: unknown): string | undefined => {
  if (Array.isArray(value)) return firstQueryValue(value[0]);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

// 规则类型优先级
const rulePriority: Record<string, number> = {
  historical_new_high: 95,
  historical_new_low: 95,
  new_high: 90,
  new_low: 90,
  price_change_period: 80,
  consecutive_change: 75,
  price_change_daily: 70,
  amplitude: 60,
  volatility: 60
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
  historical_new_high: {
    default: 'bullish'
  },
  historical_new_low: {
    default: 'bearish'
  },
  amplitude: {
    default: 'neutral'
  },
  volatility: {
    default: 'neutral'
  }
};

// 获取价格记录
const getPriceRecords = async (db: any, categoryFilter?: { categoryId?: string; categoryName?: string }) => {
  let query = `
    SELECT 
      pr.category as category_name, 
      pr.object_name, 
      COALESCE(pr.variant, '') as variant_name, 
      pr.price as current_price, 
      pr.date as effective_date
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
  const categoryId = categoryFilter?.categoryId;
  const categoryName = categoryFilter?.categoryName;

  if (categoryId) {
    query += ' AND c.id = ?';
    params.push(categoryId);
  } else if (categoryName) {
    query += ' AND c.name = ?';
    params.push(categoryName);
  }

  query += ' ORDER BY pr.category, pr.object_name, pr.variant, pr.date DESC, pr.created_at DESC, pr.id DESC';

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
  
  // 构建规则映射，按优先级排序：对象规则 > 品类规则 > 全局规则
  const ruleMap: Record<string, MonitorRule[]> = {};
  
  // 先添加对象规则（优先级最高）
  objectRules.forEach((rule: MonitorRule) => {
    if (!ruleMap[rule.rule_type]) {
      ruleMap[rule.rule_type] = [];
    }
    ruleMap[rule.rule_type].push(rule);
  });
  
  // 再添加品类规则（优先级次之）
  categoryRules.forEach((rule: MonitorRule) => {
    if (!ruleMap[rule.rule_type]) {
      ruleMap[rule.rule_type] = [];
    }
    ruleMap[rule.rule_type].push(rule);
  });
  
  // 最后添加全局规则（优先级最低）
  globalRules.forEach((rule: MonitorRule) => {
    if (!ruleMap[rule.rule_type]) {
      ruleMap[rule.rule_type] = [];
    }
    ruleMap[rule.rule_type].push(rule);
  });
  
  return ruleMap;
};

// 计算单日涨跌幅
const calculateDailyChange = (prices: number[]) => {
  if (prices.length < 2) return null;
  return ((prices[0] - prices[1]) / prices[1]) * 100;
};

// 计算单日价格差额
const calculateDailyChangeAmount = (prices: number[]) => {
  if (prices.length < 2) return null;
  return prices[0] - prices[1];
};

// 计算区间涨跌幅
const calculatePeriodChange = (prices: number[]) => {
  if (prices.length < 2) return null;
  return ((prices[0] - prices[prices.length - 1]) / prices[prices.length - 1]) * 100;
};

// 计算区间价格差额
const calculatePeriodChangeAmount = (prices: number[]) => {
  if (prices.length < 2) return null;
  return prices[0] - prices[prices.length - 1];
};

const getThresholdUnit = (params: any): 'percent' | 'amount' => {
  const explicitUnit = params.threshold_unit || params.unit || params.thresholdUnit;
  if (explicitUnit === 'amount' || explicitUnit === 'price_amount') return 'amount';
  if (explicitUnit === 'percent' || explicitUnit === 'percentage') return 'percent';

  // 兼容旧数据：百分比规则通常是 5/10；像“单日上涨超过30”更像价格差额。
  return Number(params.threshold) >= 20 ? 'amount' : 'percent';
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
  return currentPrice > Math.max(...previousPrices);
};

// 检查是否新低
const isNewLow = (prices: number[]) => {
  if (prices.length < 2) return false;
  const currentPrice = prices[0];
  const previousPrices = prices.slice(1);
  return currentPrice < Math.min(...previousPrices);
};

const calculateHistoricalBreak = (prices: number[], direction: 'high' | 'low') => {
  if (prices.length < 2) return null;
  const currentPrice = prices[0];
  const previousPrices = prices.slice(1);
  const historyExtreme = direction === 'high'
    ? Math.max(...previousPrices)
    : Math.min(...previousPrices);

  const hit = direction === 'high'
    ? currentPrice > historyExtreme
    : currentPrice < historyExtreme;

  if (!hit || historyExtreme === 0) {
    return null;
  }

  return {
    hit,
    historyExtreme,
    breakRate: ((currentPrice - historyExtreme) / historyExtreme) * 100
  };
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
const executeRules = (target: any, prices: number[], ruleMap: Record<string, MonitorRule[]>) => {
  const hits: any[] = [];

  // 遍历每种规则类型
  Object.keys(ruleMap).forEach(ruleType => {
    const rules = ruleMap[ruleType];
    let hitFound = false;

    // 按优先级从高到低执行规则（对象规则 > 品类规则 > 全局规则）
    for (const rule of rules) {
      try {
        const params = JSON.parse(rule.params_json);
        const days = Math.max(2, Number(params.days || params.period || 7) || 7);
        const threshold = params.threshold || 5;
        const thresholdUnit = getThresholdUnit(params);
        const direction = params.direction;

        // 只取最近 N 条记录
        const recentPrices = prices.slice(0, days);
        if (recentPrices.length < 2) continue;

        let hit = false;
        let hitDirection = 'neutral';
        let actualChangeValue: number | null = null;
        let actualChangeUnit: 'percent' | 'amount' = 'percent';

        switch (rule.rule_type) {
          case 'price_change_daily': {
            const change = thresholdUnit === 'amount'
              ? calculateDailyChangeAmount(recentPrices)
              : calculateDailyChange(recentPrices);
            if (change !== null) {
              actualChangeValue = change;
              actualChangeUnit = thresholdUnit;
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
            const change = thresholdUnit === 'amount'
              ? calculatePeriodChangeAmount(recentPrices)
              : calculatePeriodChange(recentPrices);
            if (change !== null) {
              actualChangeValue = change;
              actualChangeUnit = thresholdUnit;
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
              // 计算实际异动幅度
              if (recentPrices.length >= 2) {
                const currentPrice = recentPrices[0];
                const previousPrice = recentPrices[1];
                if (previousPrice !== 0) {
                  actualChangeValue = ((currentPrice - previousPrice) / previousPrice) * 100;
                }
              }
            }
            break;
          }
          case 'new_low': {
            if (isNewLow(recentPrices)) {
              hit = true;
              hitDirection = 'bearish';
              // 计算实际异动幅度
              if (recentPrices.length >= 2) {
                const currentPrice = recentPrices[0];
                const previousPrice = recentPrices[1];
                if (previousPrice !== 0) {
                  actualChangeValue = ((currentPrice - previousPrice) / previousPrice) * 100;
                }
              }
            }
            break;
          }
          case 'historical_new_high': {
            const result = calculateHistoricalBreak(prices, 'high');
            if (result?.hit) {
              hit = true;
              hitDirection = 'bullish';
              actualChangeValue = result.breakRate;
            }
            break;
          }
          case 'historical_new_low': {
            const result = calculateHistoricalBreak(prices, 'low');
            if (result?.hit) {
              hit = true;
              hitDirection = 'bearish';
              actualChangeValue = result.breakRate;
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
          case 'volatility': {
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
            actual_change_unit: actualChangeUnit,
            alert_level: actualChangeValue !== null ? calculateAlertLevel(actualChangeValue) : 'normal'
          });
          hitFound = true;
          break; // 高优先级规则命中，停止该规则类型的后续判断
        }
      } catch (error) {
        console.error('Error executing rule:', error);
      }
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
  
  return [targetType, categoryName, objectName, variantName, ruleCode, effectiveDate]
    .map(encodeReadKeyPart)
    .join('|');
};

const generateLegacyReadKey = (result: any): string => {
  const targetType = result.target_type || 'object';
  const categoryName = result.category_name || '';
  const objectName = result.object_name || '';
  const variantName = result.variant_name || '';
  const ruleCode = result.primary_rule?.rule_code || '';
  const effectiveDate = result.effective_date || '';

  return [targetType, categoryName, objectName, variantName, ruleCode, effectiveDate]
    .map(value => String(value || ''))
    .join('|');
};

const getReadKeyVariants = (result: any) => Array.from(new Set([
  result.read_key,
  generateLegacyReadKey(result)
].filter(Boolean)));

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

    // 获取启用的规则（按优先级：对象规则 > 品类规则 > 全局规则）
    const ruleMap = await getEnabledRules(db, categoryId, objectId);

    debugAbnormalMonitorLog('Target:', target);
    debugAbnormalMonitorLog('Category ID:', categoryId);
    debugAbnormalMonitorLog('Object ID:', objectId);
    debugAbnormalMonitorLog('Rule Map:', ruleMap);

    const hits = executeRules(target, prices, ruleMap);
    
    debugAbnormalMonitorLog('Hits:', hits);
    if (hits.length === 0) continue;

    // 按优先级排序，选择主规则
    hits.sort((a, b) => b.priority - a.priority);
    const primaryRule = hits[0];
    const secondaryRules = hits.slice(1);

    const signalState = calculateSignalState(hits);

    // 计算目标级别的实际异动幅度和提醒等级（取主规则的值）
    const actualChangeValue = primaryRule.actual_change_value || 0;
    const actualChangeUnit = primaryRule.actual_change_unit || 'percent';
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
    actual_change_unit: actualChangeUnit,
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
const normalizeSortBy = (sortBy: string) => {
  const aliases: Record<string, string> = {
    hit_rule_count: 'hit_count',
    primary_rule_priority: 'priority',
    price_date: 'date',
    latest: 'date'
  };
  return aliases[sortBy] || sortBy;
};

const sortResults = (results: any[], sortBy: string) => {
  switch (normalizeSortBy(sortBy)) {
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
    const categoryId = firstQueryValue(req.query.category_id);
    const legacyCategory = firstQueryValue(req.query.category);
    const signalState = firstQueryValue(req.query.signal_state) || firstQueryValue(req.query.signal_status);
    const ruleType = firstQueryValue(req.query.rule_type);
    const sortBy = firstQueryValue(req.query.sort_by) || 'default';
    const categoryFilter = categoryId
      ? { categoryId }
      : legacyCategory
        ? /^\d+$/.test(legacyCategory)
          ? { categoryId: legacyCategory }
          : { categoryName: legacyCategory }
        : undefined;

    // 获取价格记录
    const groupedRecords = await getPriceRecords(db, categoryFilter);

    // 执行规则命中
    let results = await aggregateResults(db, groupedRecords);

    // 过滤已读结果
    if (results.length > 0) {
      const readKeys = Array.from(new Set(results.flatMap(getReadKeyVariants)));
      const placeholders = readKeys.map(() => '?').join(',');
      const readRecords = await db.all(
        `SELECT read_key FROM abnormal_monitor_reads WHERE read_key IN (${placeholders})`,
        readKeys
      );
      const readKeySet = new Set(readRecords.map((record: any) => record.read_key));
      results = results.filter(result => !getReadKeyVariants(result).some(key => readKeySet.has(key)));
    }

    // 过滤结果
    if (signalState) {
      results = results.filter(result => result.signal_state === signalState);
    }

    if (ruleType) {
      results = results.filter(result => 
        result.primary_rule.rule_type === ruleType ||
        result.secondary_rules.some((rule: any) => rule.rule_type === ruleType)
      );
    }

    // 排序结果
    results = sortResults(results, sortBy);

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

    const [target_type, category_name, object_name, variant_name, rule_code, effective_date] = parts.map(decodeReadKeyPart);
    const canonicalReadKey = [
      target_type,
      category_name,
      object_name,
      variant_name,
      rule_code,
      effective_date
    ].map(encodeReadKeyPart).join('|');

    // 写入已读记录（幂等处理）
    await db.run(
      `INSERT OR IGNORE INTO abnormal_monitor_reads
       (read_key, target_type, category_name, object_name, variant_name, rule_code, effective_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [canonicalReadKey, target_type, category_name, object_name, variant_name, rule_code, effective_date]
    );

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
