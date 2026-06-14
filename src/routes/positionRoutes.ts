import express from "express";
import getDb from "../config/database";
import { isValidDateOnly } from "../utils/dateValidation";
import { validateActiveMasterTargetByIds, validateActiveMasterTargetByNames } from "../utils/masterData";

const router = express.Router();

interface PositionInsightRow {
  id: number;
  category_name: string;
  object_name: string;
  variant_name: string;
  total_quantity: number;
  total_cost: number;
  avg_price: number;
  current_price: number | null;
  latest_price_date: string | null;
  first_buy_date: string | null;
  last_buy_date: string | null;
  batch_count: number;
  category_id: number | null;
  object_id: number | null;
  variant_id: number | null;
}

interface PositionInsightItem extends PositionInsightRow {
  label: string;
  current_value: number | null;
  total_profit: number | null;
  profit_rate: number | null;
  cost_percent: number;
  days_since_price_update: number | null;
}

const POSITION_DAY_MS = 24 * 60 * 60 * 1000;

const toFiniteNumber = (value: any, fallback = 0) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const roundMetric = (value: number | null, digits = 2) => {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
};

const QUANTITY_EPSILON = 0.000001;

const roundQuantity = (value: number) => Number(value.toFixed(2));

const parseQuantityInput = (value: any) => {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;

  const numberValue = Number(text);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null;

  return roundQuantity(numberValue);
};

const toDateValue = (date: string) => new Date(`${date}T00:00:00`).getTime();

const diffDays = (fromDate: string, toDate: string) => {
  return Math.round((toDateValue(toDate) - toDateValue(fromDate)) / POSITION_DAY_MS);
};

const buildPositionLabel = (item: { category_name: string; object_name: string; variant_name?: string }) => {
  return [item.category_name, item.object_name, item.variant_name].filter(Boolean).join(' / ');
};

const refreshPositionAggregate = async (db: any, positionId: number | string, now = new Date().toISOString()) => {
  const summary = await db.get(
    `SELECT
       COALESCE(SUM(remaining_quantity), 0) AS total_quantity,
       COALESCE(SUM(batch_price * remaining_quantity), 0) AS total_cost
     FROM position_batches
     WHERE position_id = ? AND remaining_quantity > 0`,
    [positionId]
  );
  const totalQuantity = toFiniteNumber(summary?.total_quantity, 0);
  const totalCost = toFiniteNumber(summary?.total_cost, 0);
  const avgPrice = totalQuantity > 0 ? totalCost / totalQuantity : 0;

  await db.run(
    "UPDATE positions SET total_quantity = ?, total_cost = ?, avg_price = ?, updated_at = ? WHERE id = ?",
    [totalQuantity, totalCost, avgPrice, now, positionId]
  );
};

const compactPositionItem = (item: PositionInsightItem) => ({
  id: item.id,
  label: item.label,
  category_name: item.category_name,
  object_name: item.object_name,
  variant_name: item.variant_name,
  category_id: item.category_id,
  object_id: item.object_id,
  variant_id: item.variant_id,
  total_quantity: roundMetric(item.total_quantity, 2),
  total_cost: roundMetric(item.total_cost),
  avg_price: roundMetric(item.avg_price),
  current_price: roundMetric(item.current_price),
  current_value: roundMetric(item.current_value),
  total_profit: roundMetric(item.total_profit),
  profit_rate: roundMetric(item.profit_rate),
  cost_percent: roundMetric(item.cost_percent),
  latest_price_date: item.latest_price_date,
  days_since_price_update: item.days_since_price_update,
  first_buy_date: item.first_buy_date,
  last_buy_date: item.last_buy_date,
  batch_count: item.batch_count
});

const buildPositionInsights = (rows: PositionInsightRow[], referenceLatestDate?: string | null) => {
  const latestPositionPriceDates = rows
    .map(row => row.latest_price_date)
    .filter((date): date is string => Boolean(date))
    .sort((a, b) => toDateValue(a) - toDateValue(b));
  const latestPositionPriceDate = latestPositionPriceDates.length > 0 ? latestPositionPriceDates[latestPositionPriceDates.length - 1] : null;
  const latestPriceDateValue = referenceLatestDate || latestPositionPriceDate;

  const totalCost = rows.reduce((sum, row) => sum + toFiniteNumber(row.total_cost), 0);
  const items: PositionInsightItem[] = rows.map(row => {
    const totalQuantity = toFiniteNumber(row.total_quantity);
    const totalCostValue = toFiniteNumber(row.total_cost);
    const currentPrice = row.current_price === null ? null : toFiniteNumber(row.current_price);
    const currentValue = currentPrice === null ? null : currentPrice * totalQuantity;
    const totalProfit = currentValue === null ? null : currentValue - totalCostValue;
    const profitRate = totalCostValue > 0 && totalProfit !== null ? (totalProfit / totalCostValue) * 100 : null;

    return {
      ...row,
      total_quantity: totalQuantity,
      total_cost: totalCostValue,
      avg_price: toFiniteNumber(row.avg_price),
      current_price: currentPrice,
      current_value: currentValue,
      total_profit: totalProfit,
      profit_rate: profitRate,
      cost_percent: totalCost > 0 ? (totalCostValue / totalCost) * 100 : 0,
      days_since_price_update: row.latest_price_date && latestPriceDateValue ? diffDays(row.latest_price_date, latestPriceDateValue) : null,
      label: buildPositionLabel(row)
    };
  });

  const pricedItems = items.filter(item => item.current_value !== null);
  const currentMarketValue = pricedItems.reduce((sum, item) => sum + (item.current_value || 0), 0);
  const totalProfit = pricedItems.reduce((sum, item) => sum + (item.total_profit || 0), 0);
  const pricedCost = pricedItems.reduce((sum, item) => sum + item.total_cost, 0);
  const staleItems = items.filter(item => (item.days_since_price_update || 0) >= 14);
  const missingPriceItems = items.filter(item => item.current_price === null);

  const categoryMap = new Map<string, {
    category_name: string;
    position_count: number;
    total_cost: number;
    current_value: number;
    total_profit: number;
  }>();

  items.forEach(item => {
    const current = categoryMap.get(item.category_name) || {
      category_name: item.category_name,
      position_count: 0,
      total_cost: 0,
      current_value: 0,
      total_profit: 0
    };
    current.position_count += 1;
    current.total_cost += item.total_cost;
    current.current_value += item.current_value || 0;
    current.total_profit += item.total_profit || 0;
    categoryMap.set(item.category_name, current);
  });

  const categoryExposure = [...categoryMap.values()]
    .map(category => ({
      ...category,
      cost_percent: totalCost > 0 ? roundMetric((category.total_cost / totalCost) * 100) : 0,
      profit_rate: category.total_cost > 0 ? roundMetric((category.total_profit / category.total_cost) * 100) : null,
      total_cost: roundMetric(category.total_cost),
      current_value: roundMetric(category.current_value),
      total_profit: roundMetric(category.total_profit)
    }))
    .sort((a, b) => (b.total_cost || 0) - (a.total_cost || 0));

  const actionItems = [
    ...items
      .filter(item => item.cost_percent >= 15)
      .map(item => ({
        type: 'high_exposure',
        severity: item.cost_percent >= 25 ? 'critical' : 'important',
        title: '单仓占比偏高',
        reason: `成本占比 ${roundMetric(item.cost_percent, 1)}%`,
        item: compactPositionItem(item)
      })),
    ...items
      .filter(item => item.days_since_price_update !== null && item.days_since_price_update >= 14 && item.cost_percent >= 2)
      .map(item => ({
        type: 'stale_price',
        severity: (item.days_since_price_update || 0) >= 30 ? 'critical' : 'important',
        title: '价格更新过期',
        reason: `最近价格距最新记录 ${item.days_since_price_update} 天`,
        item: compactPositionItem(item)
      })),
    ...items
      .filter(item => item.total_profit !== null && ((item.profit_rate || 0) <= -15 || (item.total_profit || 0) <= -5000))
      .map(item => ({
        type: 'heavy_loss',
        severity: (item.profit_rate || 0) <= -30 || (item.total_profit || 0) <= -8000 ? 'critical' : 'important',
        title: '浮亏压力较大',
        reason: `浮盈亏 ${roundMetric(item.total_profit)} / ${roundMetric(item.profit_rate, 1)}%`,
        item: compactPositionItem(item)
      })),
    ...items
      .filter(item => item.total_profit !== null && ((item.profit_rate || 0) >= 10 || (item.total_profit || 0) >= 3000))
      .map(item => ({
        type: 'profit_take',
        severity: 'normal',
        title: '已有可兑现浮盈',
        reason: `浮盈 ${roundMetric(item.total_profit)} / ${roundMetric(item.profit_rate, 1)}%`,
        item: compactPositionItem(item)
      })),
    ...missingPriceItems.map(item => ({
      type: 'missing_price',
      severity: 'critical',
      title: '缺少当前参考价',
      reason: '无法计算当前盈亏',
      item: compactPositionItem(item)
    }))
  ]
    .sort((a, b) => {
      const severityRank: Record<string, number> = { critical: 3, important: 2, normal: 1 };
      return (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0)
        || ((b.item.total_cost || 0) - (a.item.total_cost || 0));
    })
    .slice(0, 16);

  const qualityBuckets = [
    {
      key: 'profit',
      label: '盈利仓位',
      items: items.filter(item => (item.total_profit || 0) > 0)
    },
    {
      key: 'light_loss',
      label: '轻度亏损',
      items: items.filter(item => item.profit_rate !== null && item.profit_rate < 0 && item.profit_rate > -15)
    },
    {
      key: 'heavy_loss',
      label: '重度亏损',
      items: items.filter(item => item.profit_rate !== null && item.profit_rate <= -15)
    },
    {
      key: 'stale_price',
      label: '价格过期',
      items: staleItems
    },
    {
      key: 'missing_price',
      label: '缺少价格',
      items: missingPriceItems
    }
  ].map(bucket => ({
    key: bucket.key,
    label: bucket.label,
    count: bucket.items.length,
    total_cost: roundMetric(bucket.items.reduce((sum, item) => sum + item.total_cost, 0)),
    total_profit: roundMetric(bucket.items.reduce((sum, item) => sum + (item.total_profit || 0), 0))
  }));

  const stressTests = [-10, -5, 5, 10].map(changePercent => {
    const multiplier = 1 + changePercent / 100;
    const stressedValue = pricedItems.reduce((sum, item) => sum + (item.current_value || 0) * multiplier, 0);
    const stressedProfit = stressedValue - pricedCost;
    return {
      change_percent: changePercent,
      market_value: roundMetric(stressedValue),
      total_profit: roundMetric(stressedProfit),
      profit_rate: pricedCost > 0 ? roundMetric((stressedProfit / pricedCost) * 100) : null,
      profit_change: roundMetric(stressedProfit - totalProfit)
    };
  });

  return {
    overview: {
      position_count: items.length,
      category_count: categoryMap.size,
      total_cost: roundMetric(totalCost),
      priced_cost: roundMetric(pricedCost),
      current_market_value: roundMetric(currentMarketValue),
      total_profit: roundMetric(totalProfit),
      profit_rate: pricedCost > 0 ? roundMetric((totalProfit / pricedCost) * 100) : null,
      missing_price_count: missingPriceItems.length,
      stale_price_count: staleItems.length,
      latest_price_date: latestPriceDateValue,
      latest_position_price_date: latestPositionPriceDate,
      largest_position_percent: items.length > 0 ? roundMetric(Math.max(...items.map(item => item.cost_percent))) : 0
    },
    category_exposure: categoryExposure,
    top_exposures: [...items].sort((a, b) => b.total_cost - a.total_cost).slice(0, 10).map(compactPositionItem),
    profit_leaders: [...items].filter(item => item.total_profit !== null).sort((a, b) => (b.total_profit || 0) - (a.total_profit || 0)).slice(0, 8).map(compactPositionItem),
    loss_leaders: [...items].filter(item => item.total_profit !== null).sort((a, b) => (a.total_profit || 0) - (b.total_profit || 0)).slice(0, 8).map(compactPositionItem),
    stale_prices: staleItems.sort((a, b) => (b.days_since_price_update || 0) - (a.days_since_price_update || 0)).slice(0, 10).map(compactPositionItem),
    action_items: actionItems,
    quality_buckets: qualityBuckets,
    stress_tests: stressTests
  };
};



// 持仓列表接口
router.get("/positions", async (req, res) => {
  try {
    const db = await getDb();
    const positions = await db.all(`
      SELECT 
        p.id, 
        p.category_name, 
        p.object_name, 
        p.variant_name, 
        SUM(pb.remaining_quantity) as total_quantity, 
        SUM(pb.batch_price * pb.remaining_quantity) as total_cost, 
        CASE WHEN SUM(pb.remaining_quantity) > 0 
          THEN SUM(pb.batch_price * pb.remaining_quantity) / SUM(pb.remaining_quantity) 
          ELSE 0 
        END as avg_price, 
        pr.price as current_price, 
        CASE WHEN pr.price IS NOT NULL AND SUM(pb.remaining_quantity) > 0 
          THEN (pr.price * SUM(pb.remaining_quantity)) - SUM(pb.batch_price * pb.remaining_quantity) 
          ELSE NULL 
        END as total_profit, 
        CASE WHEN pr.price IS NOT NULL AND SUM(pb.batch_price * pb.remaining_quantity) > 0 
          THEN ((pr.price * SUM(pb.remaining_quantity)) - SUM(pb.batch_price * pb.remaining_quantity)) / SUM(pb.batch_price * pb.remaining_quantity) * 100 
          ELSE NULL 
        END as profit_rate, 
        p.created_at, 
        p.updated_at 
      FROM positions p 
      JOIN position_batches pb ON p.id = pb.position_id 
      LEFT JOIN (
        SELECT 
          category, 
          object_name, 
          COALESCE(variant, '') as variant, 
          price, 
          date 
        FROM (
          SELECT 
            category, 
            object_name, 
            COALESCE(variant, '') as variant, 
            price, 
            date, 
            ROW_NUMBER() OVER (PARTITION BY category, object_name, COALESCE(variant, '') ORDER BY date DESC, created_at DESC, id DESC) as rn 
          FROM price_records 
        ) as latest_prices 
        WHERE rn = 1 
      ) as pr ON p.category_name = pr.category AND p.object_name = pr.object_name AND COALESCE(p.variant_name, '') = pr.variant 
      JOIN categories c ON c.name = p.category_name AND COALESCE(c.is_archived, 0) = 0
      JOIN objects o ON o.category_id = c.id AND o.name = p.object_name AND COALESCE(o.is_archived, 0) = 0
      LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(p.variant_name, '') AND COALESCE(p.variant_name, '') <> '' AND COALESCE(v.is_archived, 0) = 0
      WHERE COALESCE(p.variant_name, '') = '' OR v.id IS NOT NULL
      GROUP BY 
        p.id, 
        p.category_name, 
        p.object_name, 
        p.variant_name, 
        pr.price, 
        p.created_at, 
        p.updated_at 
      HAVING SUM(pb.remaining_quantity) > 0 
      ORDER BY p.created_at DESC 
    `);
    res.json({ status: "success", data: positions });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取持仓列表失败", error: errorMessage });
  }
});

// 持仓洞察接口：用于可视化分析页，只读
router.get("/positions/insights", async (req, res) => {
  try {
    const db = await getDb();
    const [rows, latestPriceRow] = await Promise.all([
      db.all(`
      WITH latest_prices AS (
        SELECT 
          category,
          object_name,
          COALESCE(variant, '') as variant,
          price,
          date
        FROM (
          SELECT 
            pr.category,
            pr.object_name,
            COALESCE(pr.variant, '') as variant,
            pr.price,
            pr.date,
            ROW_NUMBER() OVER (
              PARTITION BY pr.category, pr.object_name, COALESCE(pr.variant, '') 
              ORDER BY pr.date DESC, pr.created_at DESC, pr.id DESC
            ) as rn
          FROM price_records pr
          LEFT JOIN categories c ON c.name = pr.category
          LEFT JOIN objects o ON o.category_id = c.id AND o.name = pr.object_name
          LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(pr.variant, '') AND COALESCE(pr.variant, '') <> ''
          WHERE COALESCE(c.is_archived, 0) = 0
            AND COALESCE(o.is_archived, 0) = 0
            AND (COALESCE(pr.variant, '') = '' OR COALESCE(v.is_archived, 0) = 0)
        )
        WHERE rn = 1
      ),
      position_summary AS (
        SELECT
          p.id,
          p.category_name,
          p.object_name,
          COALESCE(p.variant_name, '') as variant_name,
          SUM(pb.remaining_quantity) as total_quantity,
          SUM(pb.batch_price * pb.remaining_quantity) as total_cost,
          CASE WHEN SUM(pb.remaining_quantity) > 0
            THEN SUM(pb.batch_price * pb.remaining_quantity) / SUM(pb.remaining_quantity)
            ELSE 0
          END as avg_price,
          MIN(pb.batch_date) as first_buy_date,
          MAX(pb.batch_date) as last_buy_date,
          COUNT(pb.id) as batch_count
        FROM positions p
        JOIN position_batches pb ON p.id = pb.position_id
        GROUP BY p.id, p.category_name, p.object_name, COALESCE(p.variant_name, '')
        HAVING SUM(pb.remaining_quantity) > 0
      )
      SELECT
        ps.*,
        lp.price as current_price,
        lp.date as latest_price_date,
        c.id as category_id,
        o.id as object_id,
        v.id as variant_id
      FROM position_summary ps
      LEFT JOIN latest_prices lp
        ON ps.category_name = lp.category
        AND ps.object_name = lp.object_name
        AND ps.variant_name = lp.variant
      LEFT JOIN categories c ON c.name = ps.category_name
      LEFT JOIN objects o ON o.category_id = c.id AND o.name = ps.object_name
      LEFT JOIN variants v ON v.object_id = o.id AND v.name = ps.variant_name AND ps.variant_name <> ''
      WHERE COALESCE(c.is_archived, 0) = 0
        AND COALESCE(o.is_archived, 0) = 0
        AND (ps.variant_name = '' OR COALESCE(v.is_archived, 0) = 0)
      ORDER BY ps.total_cost DESC, ps.id DESC
    `),
      db.get('SELECT MAX(date) as latest_date FROM price_records')
    ]);

    const normalizedRows: PositionInsightRow[] = rows.map((row: any) => ({
      id: Number(row.id),
      category_name: String(row.category_name || ''),
      object_name: String(row.object_name || ''),
      variant_name: String(row.variant_name || ''),
      total_quantity: toFiniteNumber(row.total_quantity),
      total_cost: toFiniteNumber(row.total_cost),
      avg_price: toFiniteNumber(row.avg_price),
      current_price: row.current_price === null || row.current_price === undefined ? null : toFiniteNumber(row.current_price),
      latest_price_date: row.latest_price_date || null,
      first_buy_date: row.first_buy_date || null,
      last_buy_date: row.last_buy_date || null,
      batch_count: Number(row.batch_count) || 0,
      category_id: row.category_id === null || row.category_id === undefined ? null : Number(row.category_id),
      object_id: row.object_id === null || row.object_id === undefined ? null : Number(row.object_id),
      variant_id: row.variant_id === null || row.variant_id === undefined ? null : Number(row.variant_id)
    }));

    res.json({ status: "success", data: buildPositionInsights(normalizedRows, latestPriceRow?.latest_date || null) });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取持仓洞察失败", error: errorMessage });
  }
});

// 根据仓位 ID 获取批次列表接口
router.get("/positions/:id/batches", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 验证仓位是否存在
    const position = await db.get("SELECT * FROM positions WHERE id = ?", [id]);
    if (!position) {
      return res.status(404).json({ status: "error", message: "仓位不存在" });
    }
    
    // 获取该仓位的所有批次，按 batch_date 升序
    const batches = await db.all(
      `SELECT id, source_id, position_id, batch_date, batch_price, batch_quantity, batch_cost, remaining_quantity, note, created_at, updated_at 
       FROM position_batches 
       WHERE position_id = ? 
       ORDER BY batch_date ASC`,
      [id]
    );
    
    res.json({ status: "success", data: batches });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取批次列表失败", error: errorMessage });
  }
});

// 批次列表接口
router.get("/position-batches", async (req, res) => {
  try {
    const db = await getDb();
    const batches = await db.all(`
      SELECT pb.*, p.category_name, p.object_name, p.variant_name
      FROM position_batches pb
      JOIN positions p ON pb.position_id = p.id
      ORDER BY pb.created_at DESC
    `);
    res.json({ status: "success", data: batches });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取批次列表失败", error: errorMessage });
  }
});

// 新增批次接口
router.post("/position-batches", async (req, res) => {
  try {
    const db = await getDb();
    const { category_name, object_name, variant_name, category_id, object_id, variant_id, batch_price, batch_quantity, batch_date, note } = req.body;
    
    // 校验价格是否为正数
    if (typeof batch_price !== 'number' || !Number.isFinite(batch_price) || batch_price <= 0) {
      return res.status(400).json({ status: "error", message: "批次价格必须是大于 0 的数字" });
    }
    
    const normalizedBatchQuantity = parseQuantityInput(batch_quantity);
    if (normalizedBatchQuantity === null) {
      return res.status(400).json({ status: "error", message: "批次数量必须大于 0，最多保留 2 位小数" });
    }
    
    // 校验日期
    if (!batch_date) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: batch_date" });
    }
    
    // 处理两种口径
    let final_category_name = '';
    let final_object_name = '';
    let final_variant_name = '';
    
    if (category_id && object_id) {
      const masterTarget = await validateActiveMasterTargetByIds(db, category_id, object_id, variant_id);
      if (!masterTarget.ok) {
        return res.status(400).json({ status: "error", message: masterTarget.message });
      }
      final_category_name = masterTarget.target.category_name;
      final_object_name = masterTarget.target.object_name;
      final_variant_name = masterTarget.target.variant_name;
    } else if (category_name && object_name) {
      const masterTarget = await validateActiveMasterTargetByNames(db, category_name, object_name, variant_name);
      if (!masterTarget.ok) {
        return res.status(400).json({ status: "error", message: masterTarget.message });
      }
      final_category_name = masterTarget.target.category_name;
      final_object_name = masterTarget.target.object_name;
      final_variant_name = masterTarget.target.variant_name;
    } else {
      // 两种口径都没有
      return res.status(400).json({ status: "error", message: "缺少必填字段: 请提供 category_name/object_name 或 category_id/object_id" });
    }
    
    // 标准化 variant_name
    const variant = final_variant_name || '';
    
    if (!isValidDateOnly(String(batch_date).trim())) {
      return res.status(400).json({ status: "error", message: "批次日期格式错误" });
    }

    // 计算批次成本
    const batch_cost = batch_price * normalizedBatchQuantity;
    
    // 开始事务
    await db.run("BEGIN TRANSACTION");
    
    try {
      // 查找或创建持仓记录
      let position = await db.get(
        "SELECT * FROM positions WHERE category_name = ? AND object_name = ? AND variant_name = ?",
        [final_category_name, final_object_name, variant]
      );
      
      if (!position) {
        // 创建新持仓记录
        const now = new Date().toISOString();
        const result = await db.run(
          "INSERT INTO positions (category_name, object_name, variant_name, total_quantity, total_cost, avg_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [final_category_name, final_object_name, variant, 0, 0, 0, now, now]
        );
        position = { id: result.lastID };
      }
      
      // 插入批次记录，确保 remaining_quantity 初始等于 batch_quantity
      const now = new Date().toISOString();
      const batchResult = await db.run(
        "INSERT INTO position_batches (position_id, batch_price, batch_quantity, batch_cost, remaining_quantity, batch_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [position.id, batch_price, normalizedBatchQuantity, batch_cost, normalizedBatchQuantity, String(batch_date).trim(), note, now, now]
      );
      await refreshPositionAggregate(db, position.id, now);
      
      // 提交事务
      await db.run("COMMIT");
      
      res.json({ 
        status: "success", 
        message: "新增持仓批次成功", 
        id: batchResult.lastID,
        data: {
          position_id: position.id
        }
      });
    } catch (error) {
      // 回滚事务
      await db.run("ROLLBACK");
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "新增持仓批次失败", error: errorMessage });
  }
});

// 编辑批次接口
router.put("/position-batches/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { batch_price, batch_quantity, batch_date, note } = req.body;
    
    // 检查批次是否存在
    const existingBatch = await db.get("SELECT * FROM position_batches WHERE id = ?", [id]);
    if (!existingBatch) {
      return res.status(404).json({ status: "error", message: "批次不存在" });
    }
    
    // 检查批次是否有关联的卖出记录
    const hasSellRecords = await db.get("SELECT COUNT(*) as count FROM sell_records WHERE batch_id = ?", [id]);
    if (hasSellRecords && hasSellRecords.count > 0) {
      // 已有关联卖出记录，只允许修改 note
      if (note === undefined || note === null) {
        return res.status(400).json({ status: "error", message: "已有关联卖出记录，仅允许修改备注" });
      }
    } else {
      // 无关联卖出记录，允许修改所有字段
      if (batch_price === undefined || batch_price === null || !batch_quantity || !batch_date) {
        return res.status(400).json({ status: "error", message: "缺少必填字段: batch_price, batch_quantity, batch_date" });
      }

      if (typeof batch_price !== 'number' || !Number.isFinite(batch_price) || batch_price <= 0) {
        return res.status(400).json({ status: "error", message: "批次价格必须是大于 0 的数字" });
      }

      const normalizedBatchQuantity = parseQuantityInput(batch_quantity);
      if (normalizedBatchQuantity === null) {
        return res.status(400).json({ status: "error", message: "批次数量必须大于 0，最多保留 2 位小数" });
      }

      if (!isValidDateOnly(String(batch_date).trim())) {
        return res.status(400).json({ status: "error", message: "批次日期格式错误" });
      }
    }
    
    // 开始事务
    await db.run("BEGIN TRANSACTION");
    
    try {
      if (hasSellRecords && hasSellRecords.count > 0) {
        // 更新批次记录（只更新 note）
        const now = new Date().toISOString();
        await db.run(
          "UPDATE position_batches SET note = ?, updated_at = ? WHERE id = ?",
          [String(note), now, id]
        );
      } else {
        // 计算批次成本
        const normalizedBatchQuantity = parseQuantityInput(batch_quantity);
        if (normalizedBatchQuantity === null) {
          throw new Error("批次数量必须大于 0，最多保留 2 位小数");
        }
        const batch_cost = batch_price * normalizedBatchQuantity;
        
        // 更新批次记录
        const now = new Date().toISOString();
        await db.run(
          "UPDATE position_batches SET batch_price = ?, batch_quantity = ?, batch_cost = ?, remaining_quantity = ?, batch_date = ?, note = ?, updated_at = ? WHERE id = ?",
          [batch_price, normalizedBatchQuantity, batch_cost, normalizedBatchQuantity, String(batch_date).trim(), note, now, id]
        );
        await refreshPositionAggregate(db, existingBatch.position_id, now);
      }
      
      // 提交事务
      await db.run("COMMIT");
      
      // 获取更新后的批次数据
      const updatedBatch = await db.get("SELECT * FROM position_batches WHERE id = ?", [id]);
      
      res.json({ 
        status: "success", 
        message: "编辑持仓批次成功", 
        data: {
          batch: updatedBatch
        }
      });
    } catch (error) {
      // 回滚事务
      await db.run("ROLLBACK");
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "编辑持仓批次失败", error: errorMessage });
  }
});

// 复制批次接口
router.post("/position-batches/:id/copy", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查批次是否存在
    const existingBatch = await db.get("SELECT * FROM position_batches WHERE id = ?", [id]);
    if (!existingBatch) {
      return res.status(404).json({ status: "error", message: "批次不存在" });
    }
    
    // 获取持仓信息
    const position = await db.get("SELECT * FROM positions WHERE id = ?", [existingBatch.position_id]);
    if (!position) {
      return res.status(404).json({ status: "error", message: "持仓不存在" });
    }
    
    // 开始事务
    await db.run("BEGIN TRANSACTION");
    
    try {
      // 插入新批次记录，确保 remaining_quantity 初始等于 batch_quantity
      const now = new Date().toISOString();
      const batchResult = await db.run(
        "INSERT INTO position_batches (position_id, batch_price, batch_quantity, batch_cost, remaining_quantity, batch_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [existingBatch.position_id, existingBatch.batch_price, existingBatch.batch_quantity, existingBatch.batch_cost, existingBatch.batch_quantity, existingBatch.batch_date, existingBatch.note, now, now]
      );
      await refreshPositionAggregate(db, existingBatch.position_id, now);
      
      // 提交事务
      await db.run("COMMIT");
      
      res.json({ status: "success", message: "复制持仓批次成功", id: batchResult.lastID });
    } catch (error) {
      // 回滚事务
      await db.run("ROLLBACK");
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "复制持仓批次失败", error: errorMessage });
  }
});

// 卖出接口
router.post("/positions/:id/sell", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { batch_id, quantity, price, sell_date, note } = req.body;
    
    // 校验参数
    if (!batch_id || !quantity || price === undefined || price === null || !sell_date) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: batch_id, quantity, price, sell_date" });
    }
    
    const normalizedSellQuantity = parseQuantityInput(quantity);
    if (normalizedSellQuantity === null) {
      return res.status(400).json({ status: "error", message: "卖出数量必须大于 0，最多保留 2 位小数" });
    }
    
    // 校验卖出价格是否为正数
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ status: "error", message: "卖出价格必须是正数" });
    }

    if (!isValidDateOnly(String(sell_date).trim())) {
      return res.status(400).json({ status: "error", message: "卖出日期格式错误" });
    }
    
    // 开始事务
    await db.run("BEGIN TRANSACTION");
    
    try {
      // 检查批次是否存在且属于指定仓位
      const batch = await db.get("SELECT * FROM position_batches WHERE id = ? AND position_id = ?", [batch_id, id]);
      if (!batch) {
        throw new Error("批次不存在或不属于指定仓位");
      }
      
      // 检查批次剩余数量是否足够
      const remainingQuantity = roundQuantity(toFiniteNumber(batch.remaining_quantity, 0));
      if (remainingQuantity + QUANTITY_EPSILON < normalizedSellQuantity) {
        throw new Error("批次剩余数量不足");
      }
      
      // 获取仓位信息
      const position = await db.get("SELECT category_name, object_name, variant_name FROM positions WHERE id = ?", [id]);
      if (!position) {
        throw new Error("仓位不存在");
      }
      
      // 计算卖出金额、成本和利润
      const sell_amount = normalizedSellQuantity * price;
      const sell_cost = normalizedSellQuantity * batch.batch_price;
      const profit = sell_amount - sell_cost;
      
      // 创建卖出记录
      const now = new Date().toISOString();
      await db.run(
        "INSERT INTO sell_records (category_name, object_name, variant_name, quantity, price, amount, cost, profit, sell_date, buy_date, batch_id, position_id, note, ended_position_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [position.category_name, position.object_name, position.variant_name, normalizedSellQuantity, price, sell_amount, sell_cost, profit, String(sell_date).trim(), batch.batch_date, batch_id, id, note, null, now, now]
      );
      
      // 扣减批次剩余数量
      const new_remaining_quantity = roundQuantity(remainingQuantity - normalizedSellQuantity);
      const final_remaining_quantity = new_remaining_quantity <= QUANTITY_EPSILON ? 0 : new_remaining_quantity;
      await db.run(
        "UPDATE position_batches SET remaining_quantity = ?, updated_at = ? WHERE id = ?",
        [final_remaining_quantity, now, batch_id]
      );
      
      // 删除空批次
      if (final_remaining_quantity === 0) {
        await db.run("DELETE FROM position_batches WHERE id = ?", [batch_id]);
      }
      await refreshPositionAggregate(db, id, now);
      
      // 更新 ended_positions：按原持仓 id 聚合同一轮生命周期，避免同一对象后续重新建仓被合并。
      let endedPosition = await db.get(
        "SELECT * FROM ended_positions WHERE source_id = ?",
        [String(id)]
      );
      if (!endedPosition) {
        endedPosition = await db.get(
          `SELECT ep.*
           FROM ended_positions ep
           JOIN sell_records sr ON sr.ended_position_id = ep.id
           WHERE sr.position_id = ?
           ORDER BY ep.id DESC
           LIMIT 1`,
          [id]
        );
        if (endedPosition && !endedPosition.source_id) {
          await db.run("UPDATE ended_positions SET source_id = ?, updated_at = ? WHERE id = ?", [String(id), now, endedPosition.id]);
        }
      }
      
      if (endedPosition) {
        // 更新现有记录
        await db.run(
          "UPDATE ended_positions SET quantity = quantity + ?, amount = amount + ?, cost = cost + ?, profit = profit + ?, updated_at = ? WHERE id = ?",
          [normalizedSellQuantity, sell_amount, sell_cost, profit, now, endedPosition.id]
        );
      } else {
        // 创建新记录
        await db.run(
          "INSERT INTO ended_positions (source_id, category_name, object_name, variant_name, quantity, amount, cost, profit, sell_date, buy_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [String(id), position.category_name, position.object_name, position.variant_name || '', normalizedSellQuantity, sell_amount, sell_cost, profit, String(sell_date).trim(), batch.batch_date, now, now]
        );
        // 获取新创建的记录 ID
        const newEndedPosition = await db.get(
          "SELECT id FROM ended_positions WHERE source_id = ? ORDER BY id DESC LIMIT 1",
          [String(id)]
        );
        endedPosition = newEndedPosition;
      }
      await db.run(
        "UPDATE sell_records SET ended_position_id = ? WHERE position_id = ? AND ended_position_id IS NULL",
        [endedPosition.id, id]
      );

      // 每次卖出都以 sell_records 为真相源重算结束仓位汇总，避免部分卖出时日期停留在旧值。
      const endedSummary = await db.get(
        "SELECT SUM(quantity) as total_quantity, SUM(amount) as total_amount, SUM(cost) as total_cost, SUM(profit) as total_profit, MAX(sell_date) as final_sell_date, MIN(buy_date) as first_buy_date FROM sell_records WHERE ended_position_id = ?",
        [endedPosition.id]
      );

      await db.run(
        "UPDATE ended_positions SET quantity = ?, amount = ?, cost = ?, profit = ?, sell_date = ?, buy_date = ?, updated_at = ? WHERE id = ?",
        [
          endedSummary.total_quantity,
          endedSummary.total_amount,
          endedSummary.total_cost,
          endedSummary.total_profit,
          endedSummary.final_sell_date,
          endedSummary.first_buy_date,
          now,
          endedPosition.id
        ]
      );
      
      // 检查仓位是否为空（通过批次真相源判断）
      const batchCount = await db.get(
        "SELECT COUNT(*) as count FROM position_batches WHERE position_id = ? AND remaining_quantity > 0",
        [id]
      );
      
      // 删除空仓位
      if (batchCount && batchCount.count === 0) {
        // 回填该仓位所有未关联的卖出记录
        await db.run(
          "UPDATE sell_records SET ended_position_id = ? WHERE position_id = ? AND ended_position_id IS NULL",
          [endedPosition.id, id]
        );

        await db.run("DELETE FROM positions WHERE id = ?", [id]);
      }
      
      // 提交事务
      await db.run("COMMIT");
      
      res.json({ 
        status: "success", 
        message: "卖出成功", 
        data: {
          batch_id,
          quantity: normalizedSellQuantity,
          price,
          sell_date,
          sell_amount,
          sell_cost,
          profit
        }
      });
    } catch (error) {
      // 回滚事务
      await db.run("ROLLBACK");
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.status(400).json({ status: "error", message: errorMessage });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "卖出失败", error: errorMessage });
  }
});

export default router;
