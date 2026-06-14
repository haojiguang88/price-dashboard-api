import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 已结束仓位相关接口

interface EndedInsightRow {
  id: number;
  category_name: string;
  object_name: string;
  variant_name: string;
  quantity: number;
  amount: number;
  cost: number;
  profit: number;
  sell_date: string;
  buy_date: string;
  category_id: number | null;
  object_id: number | null;
  variant_id: number | null;
}

interface SellInsightRow {
  id: number;
  ended_position_id: number | null;
  category_name: string;
  object_name: string;
  variant_name: string;
  quantity: number;
  price: number;
  amount: number;
  cost: number;
  profit: number;
  sell_date: string;
  buy_date: string;
}

const toNumber = (value: any, fallback = 0) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const roundValue = (value: number | null, digits = 2) => {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
};

const targetLabel = (item: { category_name: string; object_name: string; variant_name?: string }) => {
  return [item.category_name, item.object_name, item.variant_name].filter(Boolean).join(' / ');
};

const compactEndedItem = (item: EndedInsightRow) => {
  const cost = toNumber(item.cost);
  const profit = toNumber(item.profit);
  return {
    id: item.id,
    label: targetLabel(item),
    category_name: item.category_name,
    object_name: item.object_name,
    variant_name: item.variant_name,
    category_id: item.category_id,
    object_id: item.object_id,
    variant_id: item.variant_id,
    quantity: roundValue(toNumber(item.quantity), 2),
    amount: roundValue(toNumber(item.amount)),
    cost: roundValue(cost),
    profit: roundValue(profit),
    return_rate: cost > 0 ? roundValue((profit / cost) * 100) : null,
    sell_date: item.sell_date,
    buy_date: item.buy_date
  };
};

const buildEndedPositionInsights = (positions: EndedInsightRow[], sellRecords: SellInsightRow[]) => {
  const totalProfit = positions.reduce((sum, item) => sum + toNumber(item.profit), 0);
  const grossProfit = positions.filter(item => toNumber(item.profit) > 0).reduce((sum, item) => sum + toNumber(item.profit), 0);
  const grossLoss = positions.filter(item => toNumber(item.profit) < 0).reduce((sum, item) => sum + toNumber(item.profit), 0);
  const totalCost = positions.reduce((sum, item) => sum + toNumber(item.cost), 0);
  const wins = positions.filter(item => toNumber(item.profit) > 0);
  const losses = positions.filter(item => toNumber(item.profit) < 0);
  const draws = positions.filter(item => toNumber(item.profit) === 0);
  const biggestLoss = [...positions].sort((a, b) => toNumber(a.profit) - toNumber(b.profit))[0] || null;
  const biggestWin = [...positions].sort((a, b) => toNumber(b.profit) - toNumber(a.profit))[0] || null;

  const buildGroup = (getKey: (item: EndedInsightRow) => string, getLabel: (item: EndedInsightRow) => string) => {
    const groupMap = new Map<string, {
      label: string;
      count: number;
      quantity: number;
      amount: number;
      cost: number;
      profit: number;
    }>();

    positions.forEach(item => {
      const key = getKey(item);
      const current = groupMap.get(key) || {
        label: getLabel(item),
        count: 0,
        quantity: 0,
        amount: 0,
        cost: 0,
        profit: 0
      };
      current.count += 1;
      current.quantity += toNumber(item.quantity);
      current.amount += toNumber(item.amount);
      current.cost += toNumber(item.cost);
      current.profit += toNumber(item.profit);
      groupMap.set(key, current);
    });

    return [...groupMap.values()]
      .map(group => ({
        ...group,
        quantity: roundValue(group.quantity, 2),
        amount: roundValue(group.amount),
        cost: roundValue(group.cost),
        profit: roundValue(group.profit),
        return_rate: group.cost > 0 ? roundValue((group.profit / group.cost) * 100) : null,
        profit_share: totalProfit !== 0 ? roundValue((group.profit / totalProfit) * 100) : null
      }))
      .sort((a, b) => Math.abs(b.profit || 0) - Math.abs(a.profit || 0));
  };

  const monthMap = new Map<string, {
    month: string;
    count: number;
    cost: number;
    profit: number;
    wins: number;
    losses: number;
  }>();

  positions.forEach(item => {
    const month = String(item.sell_date || '').slice(0, 7) || '未记录';
    const current = monthMap.get(month) || { month, count: 0, cost: 0, profit: 0, wins: 0, losses: 0 };
    const profit = toNumber(item.profit);
    current.count += 1;
    current.cost += toNumber(item.cost);
    current.profit += profit;
    if (profit > 0) current.wins += 1;
    if (profit < 0) current.losses += 1;
    monthMap.set(month, current);
  });

  const sellRecordsByEndedId = new Map<string, SellInsightRow[]>();
  sellRecords.forEach(record => {
    if (!record.ended_position_id) return;
    const key = String(record.ended_position_id);
    if (!sellRecordsByEndedId.has(key)) {
      sellRecordsByEndedId.set(key, []);
    }
    sellRecordsByEndedId.get(key)?.push(record);
  });

  const execution_quality = positions.map(position => {
    const records = sellRecordsByEndedId.get(String(position.id)) || [];
    const sellPrices = records.map(record => toNumber(record.price)).filter(price => Number.isFinite(price));
    const minSellPrice = sellPrices.length > 0 ? Math.min(...sellPrices) : null;
    const maxSellPrice = sellPrices.length > 0 ? Math.max(...sellPrices) : null;
    const sellPriceSpreadPercent = minSellPrice && maxSellPrice ? ((maxSellPrice - minSellPrice) / minSellPrice) * 100 : null;
    const sortedRecords = [...records].sort((a, b) => String(a.sell_date).localeCompare(String(b.sell_date)) || a.id - b.id);
    const firstSell = sortedRecords[0] || null;
    const lastSell = sortedRecords[sortedRecords.length - 1] || null;
    const trendAmount = firstSell && lastSell ? toNumber(lastSell.price) - toNumber(firstSell.price) : null;

    return {
      ...compactEndedItem(position),
      sell_record_count: records.length,
      min_sell_price: roundValue(minSellPrice),
      max_sell_price: roundValue(maxSellPrice),
      sell_price_spread_percent: roundValue(sellPriceSpreadPercent),
      first_sell_price: firstSell ? roundValue(toNumber(firstSell.price)) : null,
      last_sell_price: lastSell ? roundValue(toNumber(lastSell.price)) : null,
      sell_trend_amount: roundValue(trendAmount)
    };
  }).sort((a, b) => (b.sell_record_count - a.sell_record_count) || Math.abs(b.profit || 0) - Math.abs(a.profit || 0));

  const insightFlags = [];
  if (positions.length > 0 && wins.length / positions.length >= 0.6 && totalProfit < 0) {
    insightFlags.push({
      type: 'high_win_rate_net_loss',
      severity: 'critical',
      title: '胜率较高但净结果为负',
      detail: '小盈利较多，但单笔或少数大亏吞掉了收益。'
    });
  }
  if (biggestLoss && totalProfit < 0 && Math.abs(toNumber(biggestLoss.profit)) >= Math.abs(totalProfit) * 0.8) {
    insightFlags.push({
      type: 'single_loss_dominates',
      severity: 'critical',
      title: '单一亏损主导整体结果',
      detail: `${targetLabel(biggestLoss)} 亏损 ${roundValue(toNumber(biggestLoss.profit))}，需要单独复盘。`
    });
  }
  if (grossLoss < 0 && grossProfit / Math.abs(grossLoss) < 0.5) {
    insightFlags.push({
      type: 'weak_profit_factor',
      severity: 'important',
      title: '利润因子偏弱',
      detail: `盈利总额 / 亏损总额 = ${roundValue(grossProfit / Math.abs(grossLoss), 2)}。`
    });
  }
  const wideExecution = execution_quality.find(item => (item.sell_price_spread_percent || 0) >= 50);
  if (wideExecution) {
    insightFlags.push({
      type: 'wide_sell_spread',
      severity: 'important',
      title: '分批卖出价格跨度过大',
      detail: `${wideExecution.label} 卖出价跨度 ${wideExecution.sell_price_spread_percent}%，需要确认是否存在异常卖价或拆分口径问题。`
    });
  }

  return {
    overview: {
      ended_count: positions.length,
      total_profit: roundValue(totalProfit),
      gross_profit: roundValue(grossProfit),
      gross_loss: roundValue(grossLoss),
      total_cost: roundValue(totalCost),
      return_rate: totalCost > 0 ? roundValue((totalProfit / totalCost) * 100) : null,
      win_rate: positions.length > 0 ? roundValue((wins.length / positions.length) * 100) : null,
      win_count: wins.length,
      loss_count: losses.length,
      draw_count: draws.length,
      profit_factor: grossLoss < 0 ? roundValue(grossProfit / Math.abs(grossLoss), 2) : null,
      avg_win: wins.length > 0 ? roundValue(grossProfit / wins.length) : null,
      avg_loss: losses.length > 0 ? roundValue(grossLoss / losses.length) : null,
      biggest_win: biggestWin ? compactEndedItem(biggestWin) : null,
      biggest_loss: biggestLoss ? compactEndedItem(biggestLoss) : null
    },
    category_results: buildGroup(item => item.category_name, item => item.category_name),
    object_results: buildGroup(item => targetLabel(item), item => targetLabel(item)),
    monthly_results: [...monthMap.values()]
      .map(month => ({
        ...month,
        cost: roundValue(month.cost),
        profit: roundValue(month.profit),
        return_rate: month.cost > 0 ? roundValue((month.profit / month.cost) * 100) : null,
        win_rate: month.count > 0 ? roundValue((month.wins / month.count) * 100) : null
      }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    top_winners: [...positions].sort((a, b) => toNumber(b.profit) - toNumber(a.profit)).slice(0, 8).map(compactEndedItem),
    top_losers: [...positions].sort((a, b) => toNumber(a.profit) - toNumber(b.profit)).slice(0, 8).map(compactEndedItem),
    execution_quality: execution_quality.slice(0, 10),
    insight_flags: insightFlags
  };
};

// 已结束仓位洞察接口：用于可视化分析页，只读
router.get('/ended-positions/insights', async (req, res) => {
  try {
    const db = await getDb();
    const [positions, sellRecords] = await Promise.all([
      db.all(`
        SELECT
          ep.*,
          c.id as category_id,
          o.id as object_id,
          v.id as variant_id
        FROM ended_positions ep
        LEFT JOIN categories c ON c.name = ep.category_name
        LEFT JOIN objects o ON o.category_id = c.id AND o.name = ep.object_name
        LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(ep.variant_name, '') AND COALESCE(ep.variant_name, '') <> ''
        WHERE COALESCE(c.is_archived, 0) = 0
          AND COALESCE(o.is_archived, 0) = 0
          AND (COALESCE(ep.variant_name, '') = '' OR COALESCE(v.is_archived, 0) = 0)
        ORDER BY ep.sell_date DESC, ep.created_at DESC
      `),
      db.all(`
        SELECT sr.*
        FROM sell_records sr
        LEFT JOIN categories c ON c.name = sr.category_name
        LEFT JOIN objects o ON o.category_id = c.id AND o.name = sr.object_name
        LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(sr.variant_name, '') AND COALESCE(sr.variant_name, '') <> ''
        WHERE COALESCE(c.is_archived, 0) = 0
          AND COALESCE(o.is_archived, 0) = 0
          AND (COALESCE(sr.variant_name, '') = '' OR COALESCE(v.is_archived, 0) = 0)
        ORDER BY sr.sell_date ASC, sr.created_at ASC, sr.id ASC
      `)
    ]);

    const normalizedPositions: EndedInsightRow[] = positions.map((row: any) => ({
      id: Number(row.id),
      category_name: String(row.category_name || ''),
      object_name: String(row.object_name || ''),
      variant_name: String(row.variant_name || ''),
      quantity: toNumber(row.quantity),
      amount: toNumber(row.amount),
      cost: toNumber(row.cost),
      profit: toNumber(row.profit),
      sell_date: row.sell_date || '',
      buy_date: row.buy_date || '',
      category_id: row.category_id === null || row.category_id === undefined ? null : Number(row.category_id),
      object_id: row.object_id === null || row.object_id === undefined ? null : Number(row.object_id),
      variant_id: row.variant_id === null || row.variant_id === undefined ? null : Number(row.variant_id)
    }));

    const normalizedSellRecords: SellInsightRow[] = sellRecords.map((row: any) => ({
      id: Number(row.id),
      ended_position_id: row.ended_position_id === null || row.ended_position_id === undefined ? null : Number(row.ended_position_id),
      category_name: String(row.category_name || ''),
      object_name: String(row.object_name || ''),
      variant_name: String(row.variant_name || ''),
      quantity: toNumber(row.quantity),
      price: toNumber(row.price),
      amount: toNumber(row.amount),
      cost: toNumber(row.cost),
      profit: toNumber(row.profit),
      sell_date: row.sell_date || '',
      buy_date: row.buy_date || ''
    }));

    res.json({ status: 'success', data: buildEndedPositionInsights(normalizedPositions, normalizedSellRecords) });
  } catch (error) {
    console.error('Error getting ended position insights:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: 'error', message: '获取已结束仓位洞察失败', error: errorMessage });
  }
});

// 获取已结束仓位列表
router.get('/ended-positions', async (req, res) => {
  try {
    const db = await getDb();
    const includeArchived = ['1', 'true'].includes(String(req.query.include_archived || '').toLowerCase());
    const positions = includeArchived
      ? await db.all('SELECT * FROM ended_positions ORDER BY sell_date DESC, created_at DESC')
      : await db.all(`
          SELECT ep.*
          FROM ended_positions ep
          LEFT JOIN categories c ON c.name = ep.category_name
          LEFT JOIN objects o ON o.category_id = c.id AND o.name = ep.object_name
          LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(ep.variant_name, '') AND COALESCE(ep.variant_name, '') <> ''
          WHERE COALESCE(c.is_archived, 0) = 0
            AND COALESCE(o.is_archived, 0) = 0
            AND (COALESCE(ep.variant_name, '') = '' OR COALESCE(v.is_archived, 0) = 0)
          ORDER BY ep.sell_date DESC, ep.created_at DESC
        `);
    res.json({ status: 'success', data: positions });
  } catch (error) {
    console.error('Error getting ended positions:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: 'error', message: '获取已结束仓位列表失败', error: errorMessage });
  }
});

export default router;
