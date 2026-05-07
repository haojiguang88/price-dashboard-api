import { Router, Request, Response } from 'express';
import getDb from '../config/database';

const router = Router();

type ForwardMetrics = {
  ret5: number | null;
  ret10: number | null;
  ret20: number | null;
  maxDrawdown20: number | null;
  brokeInvalidation: boolean;
  latestTradeDate: string | null;
};

function toNumber(value: any, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function roundMetric(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function avg(values: Array<number | null | undefined>): number | null {
  const clean = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

async function getForwardMetrics(db: any, row: any): Promise<ForwardMetrics> {
  const tradeDate = row.trade_date || row.created_at?.slice(0, 10);
  if (!row.symbol || !tradeDate) {
    return { ret5: null, ret10: null, ret20: null, maxDrawdown20: null, brokeInvalidation: false, latestTradeDate: null };
  }

  const prices = await db.all(
    `SELECT trade_date, close, low
     FROM financial_daily_prices
     WHERE symbol = ?
       AND asset_type = ?
       AND source = ?
       AND trade_date >= ?
     ORDER BY trade_date ASC
     LIMIT 26`,
    [row.symbol, row.asset_type || 'stock', row.source || 'tushare', tradeDate]
  );

  const entryClose = toNumber(row.close ?? row.close_price, toNumber(prices[0]?.close));
  if (!entryClose || prices.length < 2) {
    return { ret5: null, ret10: null, ret20: null, maxDrawdown20: null, brokeInvalidation: false, latestTradeDate: prices[0]?.trade_date || null };
  }

  const getReturn = (offset: number) => {
    const item = prices[offset];
    const close = toNumber(item?.close);
    return close > 0 ? roundMetric(close / entryClose - 1) : null;
  };
  const window20 = prices.slice(1, 21);
  const minLow = window20.length ? Math.min(...window20.map((item: any) => toNumber(item.low, toNumber(item.close)))) : null;
  const invalidationLine = toNumber(row.invalidation_line);

  return {
    ret5: getReturn(5),
    ret10: getReturn(10),
    ret20: getReturn(20),
    maxDrawdown20: minLow && minLow > 0 ? roundMetric(minLow / entryClose - 1) : null,
    brokeInvalidation: invalidationLine > 0 && window20.some((item: any) => toNumber(item.low, toNumber(item.close)) < invalidationLine),
    latestTradeDate: prices[prices.length - 1]?.trade_date || null
  };
}

function summarize(items: any[]) {
  const valid20 = items.filter(item => item.metrics?.ret20 !== null && item.metrics?.ret20 !== undefined);
  const wins20 = valid20.filter(item => Number(item.metrics.ret20) > 0);
  const invalidated = items.filter(item => item.metrics?.brokeInvalidation);
  return {
    total: items.length,
    evaluable20: valid20.length,
    winRate20: valid20.length ? roundMetric(wins20.length / valid20.length) : null,
    avgRet5: roundMetric(avg(items.map(item => item.metrics?.ret5))),
    avgRet10: roundMetric(avg(items.map(item => item.metrics?.ret10))),
    avgRet20: roundMetric(avg(items.map(item => item.metrics?.ret20))),
    avgMaxDrawdown20: roundMetric(avg(items.map(item => item.metrics?.maxDrawdown20))),
    invalidationBreakRate: items.length ? roundMetric(invalidated.length / items.length) : null
  };
}

function compactSample(row: any, metrics: ForwardMetrics) {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    assetType: row.asset_type,
    source: row.source,
    tradeDate: row.trade_date,
    status: row.pool_status || row.status || row.review_status,
    score: row.priority_score ?? row.structure_score ?? null,
    trendPhase: row.trend_phase_code || null,
    reason: row.first_blocking_gate_label || row.forbidden_reason || row.downgrade_reason || row.risk_note || row.trigger_reason || row.entry_reason || '',
    metrics
  };
}

function groupByTrend(items: any[]) {
  const groups = new Map<string, any[]>();
  items.forEach(item => {
    const key = item.trendPhase || 'UNKNOWN';
    groups.set(key, [...(groups.get(key) || []), item]);
  });
  return Array.from(groups.entries())
    .map(([trendPhase, rows]) => ({ trendPhase, ...summarize(rows) }))
    .sort((a, b) => b.total - a.total);
}

function splitUniverseTypes(value: string | null | undefined): string[] {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function classifyAssetRoute(row: any) {
  const symbol = String(row.symbol || '');
  const assetType = String(row.asset_type || '');
  const name = String(row.name || '');
  const text = `${name} ${symbol}`;
  const typeSet = new Set(splitUniverseTypes(row.universe_type));

  if (assetType === 'stock') {
    return {
      key: 'stock',
      label: 'A股个股',
      targetPool: '个股备选池',
      currentWorkflow: '个股安全区 + 结构 + 流动性/市值 + 模型辅助',
      currentPoolApplicable: true,
      requiredChecks: ['ST/退市过滤', '近20日成交额', '近5日最低成交额', '流通市值', '极端交易状态'],
      note: '个股可以进入当前权益流程，但必须先过流动性、市值和极端交易过滤。'
    };
  }

  if (assetType === 'index') {
    return {
      key: 'market_anchor',
      label: '市场锚/宽基指数',
      targetPool: '市场总闸',
      currentWorkflow: '只做环境判断，不直接生成买入计划',
      currentPoolApplicable: false,
      requiredChecks: ['市场阶段', '趋势方向', '风险开关'],
      note: '指数主要用于判断环境和总闸，不当作交易标的直接入池。'
    };
  }

  if (assetType !== 'etf') {
    return {
      key: 'other',
      label: '其它金融资产',
      targetPool: '待归类池',
      currentWorkflow: '暂不进入权益主升流程',
      currentPoolApplicable: false,
      requiredChecks: ['先补资产类型', '再定义策略池'],
      note: '资产类型未接入当前路由，需要先明确底层资产和退出规则。'
    };
  }

  if (typeSet.has('bond_cash_etf') || /货币|快线|现金(?!流)|债|国债|地债|政金|城投|信用债|可转债|短融|同业存单|存单/.test(text)) {
    return {
      key: 'bond_cash_etf',
      label: '债券/货币ETF',
      targetPool: '低波动/配置池',
      currentWorkflow: '不走权益主升策略',
      currentPoolApplicable: false,
      requiredChecks: ['利率环境', '久期风险', '信用风险', '流动性'],
      note: '债券/货币ETF不适合用主升结构筛选，后续应单独做配置型规则。'
    };
  }

  if (typeSet.has('commodity_etf') || /黄金ETF|上海金|金ETF|白银|豆粕|商品|原油|能源化工|有色期货/.test(text)) {
    return {
      key: 'commodity_etf',
      label: '商品/黄金ETF',
      targetPool: '商品/贵金属观察池',
      currentWorkflow: '走商品或贵金属逻辑，不走A股权益总闸',
      currentPoolApplicable: false,
      requiredChecks: ['商品周期', '美元/利率', '避险状态', '期现结构', '流动性'],
      note: '商品/黄金ETF需要独立路由，不能和权益ETF混在同一套入池规则里。'
    };
  }

  if (typeSet.has('cross_border_etf') || /QDII|纳指|纳斯达克|标普|德国|法国|日经|东证|恒生|港股|中概|海外|美国|亚太|东南亚|沙特|印度/.test(text) || symbol.startsWith('513')) {
    return {
      key: 'cross_border_etf',
      label: 'QDII/跨境ETF',
      targetPool: '跨境ETF观察池',
      currentWorkflow: '先处理海外市场、汇率和折溢价，再谈计划',
      currentPoolApplicable: false,
      requiredChecks: ['海外市场趋势', '汇率', '折溢价', '额度/暂停申购', '交易时差'],
      note: '跨境ETF不能直接套A股节奏，必须先过折溢价和海外市场检查。'
    };
  }

  if (typeSet.has('special_fund') || /LOF|封闭|REIT|REITS|基础设施|创新未来|定开/.test(text)) {
    return {
      key: 'special_fund',
      label: 'LOF/特殊基金',
      targetPool: '特殊基金观察池',
      currentWorkflow: '高溢价一票否决，结构只做辅助',
      currentPoolApplicable: false,
      requiredChecks: ['折溢价', '场内流动性', '基金结构', '申赎限制'],
      note: 'LOF/特殊基金要先处理折溢价和基金结构风险，不能只看日线形态。'
    };
  }

  if (typeSet.has('broad_etf')) {
    return {
      key: 'broad_etf',
      label: '宽基权益ETF',
      targetPool: '宽基结构池',
      currentWorkflow: '市场总闸 + 自身结构 + 安全区',
      currentPoolApplicable: true,
      requiredChecks: ['市场总闸', '自身结构', '安全区', '成交额'],
      note: '宽基ETF可以走当前权益流程，但不需要行业强度层。'
    };
  }

  if (typeSet.has('industry_etf')) {
    return {
      key: 'industry_etf',
      label: '行业/主题权益ETF',
      targetPool: '行业主题池',
      currentWorkflow: '行业强度 + 自身结构 + 安全区',
      currentPoolApplicable: true,
      requiredChecks: ['行业强度', '相对沪深300强度', '自身结构', '安全区', '成交额'],
      note: '行业/主题ETF要先看行业强度，再看自身结构，不和宽基完全同路。'
    };
  }

  return {
    key: 'unknown_etf',
    label: '未归类ETF',
    targetPool: '待归类池',
    currentWorkflow: '暂不进入权益主升流程',
    currentPoolApplicable: false,
    requiredChecks: ['补充ETF分组', '确认底层资产', '定义适用规则'],
    note: 'ETF未识别为宽基、行业、商品、跨境、债券/货币或特殊基金，先别让它自动进交易池。'
  };
}

router.get('/asset-routing/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const universeRows = await db.all(
      `SELECT symbol,
              COALESCE(MAX(NULLIF(name, '')), '') as name,
              asset_type,
              source,
              GROUP_CONCAT(DISTINCT universe_type) as universe_type,
              MAX(total_count) as total_count,
              MAX(last_trade_date) as last_trade_date,
              MAX(update_status) as update_status
       FROM financial_asset_universe
       WHERE enabled = 1
       GROUP BY symbol, asset_type, source`
    );
    const candidateRows = await db.all(
      `SELECT symbol, asset_type, source, COUNT(*) as active_count
       FROM financial_candidate_pool
       WHERE pool_status = 'active'
       GROUP BY symbol, asset_type, source`
    );
    const planRows = await db.all(
      `SELECT symbol, asset_type, source, COUNT(*) as active_count
       FROM financial_trade_plans
       WHERE is_deleted = 0
         AND status IN ('draft', 'watching', 'paper_tracking', 'active')
       GROUP BY symbol, asset_type, source`
    );

    const candidateMap = new Map(candidateRows.map((row: any) => [`${row.symbol}|${row.asset_type}|${row.source}`, toNumber(row.active_count)]));
    const planMap = new Map(planRows.map((row: any) => [`${row.symbol}|${row.asset_type}|${row.source}`, toNumber(row.active_count)]));
    const routeMap = new Map<string, any>();

    const items = universeRows.map((row: any) => {
      const route = classifyAssetRoute(row);
      const key = `${row.symbol}|${row.asset_type}|${row.source}`;
      const item = {
        symbol: row.symbol,
        name: row.name,
        assetType: row.asset_type,
        source: row.source,
        universeType: row.universe_type,
        totalCount: row.total_count,
        lastTradeDate: row.last_trade_date,
        updateStatus: row.update_status,
        activeCandidates: candidateMap.get(key) || 0,
        activePlans: planMap.get(key) || 0,
        route
      };
      const current = routeMap.get(route.key) || {
        key: route.key,
        label: route.label,
        targetPool: route.targetPool,
        currentWorkflow: route.currentWorkflow,
        currentPoolApplicable: route.currentPoolApplicable,
        requiredChecks: route.requiredChecks,
        note: route.note,
        total: 0,
        activeCandidates: 0,
        activePlans: 0,
        samples: []
      };
      current.total += 1;
      current.activeCandidates += item.activeCandidates;
      current.activePlans += item.activePlans;
      if (current.samples.length < 10) current.samples.push(item);
      routeMap.set(route.key, current);
      return item;
    });

    const routeOrder = ['stock', 'broad_etf', 'industry_etf', 'commodity_etf', 'cross_border_etf', 'special_fund', 'bond_cash_etf', 'market_anchor', 'unknown_etf', 'other'];
    const routes = Array.from(routeMap.values()).sort((a, b) => {
      const orderA = routeOrder.indexOf(a.key);
      const orderB = routeOrder.indexOf(b.key);
      return (orderA === -1 ? 99 : orderA) - (orderB === -1 ? 99 : orderB);
    });

    res.json({
      success: true,
      data: {
        routes,
        items: items
          .sort((a: any, b: any) => (b.activePlans + b.activeCandidates) - (a.activePlans + a.activeCandidates))
          .slice(0, 120),
        totals: {
          assets: items.length,
          currentWorkflowAssets: items.filter((item: any) => item.route.currentPoolApplicable).length,
          outsideWorkflowAssets: items.filter((item: any) => !item.route.currentPoolApplicable).length,
          activeCandidates: items.reduce((sum: number, item: any) => sum + item.activeCandidates, 0),
          activePlans: items.reduce((sum: number, item: any) => sum + item.activePlans, 0)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取资产类型路由失败：${(error as Error).message}` });
  }
});

router.get('/sample-validation/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const candidateRows = await db.all(
      `SELECT id, symbol, name, asset_type, source, trade_date, close, pool_status, review_status,
              priority_score, trend_phase_code, invalidation_line, first_blocking_gate_label,
              forbidden_reason, downgrade_reason, risk_note, created_at, updated_at
       FROM financial_candidate_pool
       WHERE asset_type IN ('stock', 'etf')
       ORDER BY COALESCE(last_checked_at, updated_at, created_at) DESC
       LIMIT 260`
    );
    const planRows = await db.all(
      `SELECT id, plan_name, symbol, name, asset_type, source, trade_date, close_price as close,
              status, structure_score, trigger_score, trend_phase_code, invalidation_line,
              trigger_reason, entry_reason, created_at, updated_at
       FROM financial_trade_plans
       WHERE is_deleted = 0
       ORDER BY created_at DESC
       LIMIT 220`
    );
    const modelConflictRows = await db.all(
      `SELECT r.id, r.symbol, r.name, r.asset_type, r.source, r.trade_date,
              c.close, c.pool_status, c.review_status, c.priority_score, c.trend_phase_code,
              c.invalidation_line, c.safe_zone_status, c.structure_status, c.forbidden_reason,
              c.downgrade_reason, c.risk_note, r.model_probability, r.lane_label, r.created_at
       FROM financial_candidate_reviews r
       LEFT JOIN financial_candidate_pool c
         ON c.symbol = r.symbol
        AND c.asset_type = r.asset_type
        AND c.source = r.source
       WHERE r.model_probability >= 0.65
         AND (
           COALESCE(c.safe_zone_status, '') <> 'SAFE_ZONE'
           OR COALESCE(c.structure_status, '') <> 'STRUCTURE_CONFIRMED'
           OR COALESCE(c.pool_status, '') = 'expired'
         )
       ORDER BY r.created_at DESC
       LIMIT 120`
    );
    const rejectedRows = await db.all(
      `SELECT id, title, project_name, track, decision_date, decision_stage,
              decision_quality, later_status, rejection_reason, risk_result
       FROM rejected_opportunities
       WHERE is_deleted = 0
       ORDER BY decision_date DESC, id DESC
       LIMIT 80`
    );

    const candidates = await Promise.all(candidateRows.map(async (row: any) => compactSample(row, await getForwardMetrics(db, row))));
    const plans = await Promise.all(planRows.map(async (row: any) => compactSample(row, await getForwardMetrics(db, row))));
    const modelConflicts = await Promise.all(modelConflictRows.map(async (row: any) => compactSample(row, await getForwardMetrics(db, row))));

    const enteredCandidates = candidates.filter(item => ['active', 'planned'].includes(String(item.status)));
    const blockedCandidates = candidates.filter(item => String(item.status) === 'expired');
    const planFailures = plans.filter(item => item.metrics.brokeInvalidation || (item.metrics.ret20 !== null && item.metrics.ret20 < 0));

    res.json({
      success: true,
      data: {
        cards: [
          { key: 'candidate', label: '备选池样本', value: enteredCandidates.length, summary: summarize(enteredCandidates) },
          { key: 'blocked', label: '规则拦截样本', value: blockedCandidates.length, summary: summarize(blockedCandidates) },
          { key: 'plan', label: '计划样本', value: plans.length, summary: summarize(plans) },
          { key: 'model_conflict', label: '模型冲突样本', value: modelConflicts.length, summary: summarize(modelConflicts) }
        ],
        sections: {
          enteredCandidates: { title: '进入备选池后的表现', summary: summarize(enteredCandidates), items: enteredCandidates.slice(0, 30) },
          blockedCandidates: { title: '被规则/风控拦截后的表现', summary: summarize(blockedCandidates), items: blockedCandidates.slice(0, 30) },
          plans: { title: '进入计划池后的表现', summary: summarize(plans), items: plans.slice(0, 30) },
          modelConflicts: { title: '模型高分但规则未通过', summary: summarize(modelConflicts), items: modelConflicts.slice(0, 30) },
          planFailures: { title: '计划失败样本', summary: summarize(planFailures), items: planFailures.slice(0, 30) }
        },
        trendFailure: groupByTrend([...plans, ...blockedCandidates].filter(item => item.metrics.brokeInvalidation || (item.metrics.ret20 !== null && item.metrics.ret20 < 0))),
        rejectedOpportunities: {
          total: rejectedRows.length,
          reviewNeeded: rejectedRows.filter((row: any) => row.decision_quality === 'needs_review' || row.later_status === 'trigger_review').length,
          items: rejectedRows.slice(0, 20)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取样本验证失败：${(error as Error).message}` });
  }
});

router.get('/account-risk/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const activePlans = await db.all(
      `SELECT p.id, p.plan_name, p.symbol, p.name, p.asset_type, p.status, p.total_capital,
              p.structure_score, p.trend_phase_code, p.max_loss_percent, p.updated_at,
              COALESCE(SUM(CASE
                WHEN e.action_type IN ('buy', 'add') THEN e.execution_amount
                WHEN e.action_type IN ('sell', 'reduce', 'stop_loss', 'exit') THEN -e.execution_amount
                ELSE 0
              END), 0) as current_amount
       FROM financial_trade_plans p
       LEFT JOIN financial_trade_executions e ON e.plan_id = p.id
       WHERE p.is_deleted = 0
         AND p.status IN ('draft', 'watching', 'paper_tracking', 'active')
       GROUP BY p.id
       ORDER BY p.updated_at DESC
       LIMIT 300`
    );
    const recentOutcomes = await db.all(
      `SELECT id, plan_name, symbol, name, asset_type, status, perf_20d, stopped_out,
              false_breakout, chased_high, updated_at
       FROM financial_trade_plans
       WHERE is_deleted = 0
         AND (
           status IN ('closed', 'invalidated')
           OR stopped_out = 1
           OR perf_20d IS NOT NULL
         )
       ORDER BY updated_at DESC
       LIMIT 30`
    );
    const endedRows = await db.all(
      `SELECT id, category_name, object_name, variant_name, profit, sell_date
       FROM ended_positions
       WHERE sell_date >= date('now', '-30 day')
       ORDER BY sell_date DESC
       LIMIT 100`
    );

    const totalExposure = activePlans.reduce((sum: number, row: any) => sum + Math.max(0, toNumber(row.current_amount)), 0);
    const plannedCapital = activePlans.reduce((sum: number, row: any) => sum + Math.max(0, toNumber(row.total_capital)), 0);
    const byAssetTypeMap = new Map<string, { assetType: string; count: number; exposure: number; planned: number }>();
    activePlans.forEach((row: any) => {
      const key = row.asset_type || 'unknown';
      const current = byAssetTypeMap.get(key) || { assetType: key, count: 0, exposure: 0, planned: 0 };
      current.count += 1;
      current.exposure += Math.max(0, toNumber(row.current_amount));
      current.planned += Math.max(0, toNumber(row.total_capital));
      byAssetTypeMap.set(key, current);
    });
    const byAssetType = Array.from(byAssetTypeMap.values()).sort((a, b) => b.exposure - a.exposure);
    const largest = [...activePlans].sort((a: any, b: any) => toNumber(b.current_amount) - toNumber(a.current_amount))[0] || null;
    const latestFailures: any[] = [];
    for (const row of recentOutcomes) {
      const failed = row.stopped_out === 1 || row.status === 'invalidated' || toNumber(row.perf_20d, 0) < 0;
      if (!failed) break;
      latestFailures.push(row);
    }
    const recentEndedProfit = endedRows.reduce((sum: number, row: any) => sum + toNumber(row.profit), 0);
    const recentEndedLossCount = endedRows.filter((row: any) => toNumber(row.profit) < 0).length;

    const rules = [
      {
        key: 'consecutive_failures',
        label: '连续计划失败',
        status: latestFailures.length >= 3 ? 'block' : latestFailures.length >= 2 ? 'warn' : 'pass',
        value: latestFailures.length,
        message: latestFailures.length >= 3 ? '连续失败达到3次，建议进入账户冷却，只允许复盘和减风险。' : latestFailures.length >= 2 ? '连续失败达到2次，新开仓降级。' : '没有触发连续失败冷却。'
      },
      {
        key: 'monthly_loss',
        label: '近30日已结束盈亏',
        status: recentEndedProfit <= -10000 ? 'block' : recentEndedProfit < 0 ? 'warn' : 'pass',
        value: roundMetric(recentEndedProfit, 2),
        message: recentEndedProfit <= -10000 ? '近30日亏损较大，暂停新增实仓。' : recentEndedProfit < 0 ? '近30日为亏损，降低单笔计划金额。' : '近30日已结束仓位未触发亏损限制。'
      },
      {
        key: 'largest_position',
        label: '最大单计划暴露',
        status: totalExposure > 0 && largest && toNumber(largest.current_amount) / totalExposure >= 0.45 ? 'warn' : 'pass',
        value: totalExposure > 0 && largest ? roundMetric(toNumber(largest.current_amount) / totalExposure) : null,
        message: totalExposure > 0 && largest && toNumber(largest.current_amount) / totalExposure >= 0.45 ? '最大单计划占比偏高，继续新增前先考虑退出路径。' : '单计划暴露没有明显过度集中。'
      },
      {
        key: 'active_plan_count',
        label: '同时跟踪计划数',
        status: activePlans.length >= 12 ? 'warn' : 'pass',
        value: activePlans.length,
        message: activePlans.length >= 12 ? '同时跟踪计划过多，容易执行分散，建议清理低质量计划。' : '同时跟踪计划数量可控。'
      }
    ];
    const hasBlock = rules.some(rule => rule.status === 'block');
    const hasWarn = rules.some(rule => rule.status === 'warn');

    res.json({
      success: true,
      data: {
        status: hasBlock ? 'COOLDOWN' : hasWarn ? 'LIMITED' : 'NORMAL',
        statusLabel: hasBlock ? '账户冷却' : hasWarn ? '限制开仓' : '正常',
        headline: hasBlock
          ? '账户层面触发冷却，先暂停新增实仓。'
          : hasWarn
            ? '账户层面有风险项，新计划要降金额或先做纸面跟踪。'
            : '账户层面未触发硬限制。',
        exposure: {
          activePlanCount: activePlans.length,
          totalExposure: roundMetric(totalExposure, 2),
          plannedCapital: roundMetric(plannedCapital, 2),
          largestPlan: largest ? {
            id: largest.id,
            name: largest.plan_name,
            symbol: largest.symbol,
            amount: roundMetric(toNumber(largest.current_amount), 2),
            percent: totalExposure > 0 ? roundMetric(toNumber(largest.current_amount) / totalExposure) : null
          } : null,
          byAssetType
        },
        recent: {
          consecutiveFailures: latestFailures.length,
          recentEndedProfit: roundMetric(recentEndedProfit, 2),
          recentEndedLossCount,
          latestFailures: latestFailures.slice(0, 6),
          endedRows: endedRows.slice(0, 8)
        },
        rules
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取账户级风控失败：${(error as Error).message}` });
  }
});

export default router;
