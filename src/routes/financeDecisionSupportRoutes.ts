import { Router, Request, Response } from 'express';
import getDb from '../config/database';
import { buildFinancePlanQuality } from '../services/financePlanQuality';

const router = Router();

const DECISION_SUPPORT_RULE_VERSION = 'decision_support_v1.1';
let decisionSupportSchemaReady = false;

type ForwardMetrics = {
  ret5: number | null;
  ret10: number | null;
  ret20: number | null;
  maxDrawdown20: number | null;
  brokeInvalidation: boolean;
  latestTradeDate: string | null;
};

const MODEL_BOUNDARY = [
  { key: 'signal_score', label: '信号质量打分', allowed: true, note: '模型可以给候选和计划做辅助打分。' },
  { key: 'similar_cases', label: '相似历史案例', allowed: true, note: '模型可以提示相似失败/成功样本。' },
  { key: 'risk_warning', label: '失败风险提示', allowed: true, note: '模型可以提示假突破、追高和数据冲突。' },
  { key: 'review_summary', label: '复盘总结', allowed: true, note: '模型可以帮助整理复盘，不替代纪律。' },
  { key: 'open_permission', label: '直接开仓许可', allowed: false, note: '模型不能覆盖安全区、失效线、市场总闸和账户风控。' },
  { key: 'override_risk_line', label: '覆盖失效线', allowed: false, note: '模型不能直接修改风险边界。' },
  { key: 'override_market_gate', label: '覆盖市场总闸', allowed: false, note: '市场状态和账户状态仍是硬约束。' }
];

const PERMISSION_STAGES = [
  { key: 'ignore', label: '不看', allowedActions: ['记录原因'], blockedActions: ['入池', '建计划', '开仓'], note: '资产类型或风险状态不适合当前流程。' },
  { key: 'observe', label: '观察', allowedActions: ['补数据', '继续观察', '记录样本'], blockedActions: ['建计划', '开仓'], note: '信息还不够，不能直接升级。' },
  { key: 'candidate', label: '备选', allowedActions: ['二次确认', '样本跟踪'], blockedActions: ['开仓'], note: '只说明进入备选，不等于可以买。' },
  { key: 'plan', label: '计划', allowedActions: ['生成计划', '评分', '确认失效线'], blockedActions: ['自动开仓'], note: '计划用于模拟和纪律准备。' },
  { key: 'ready', label: '准备', allowedActions: ['按批次执行', '确认账户风控'], blockedActions: ['忽略失效线'], note: '只有准备状态才具备人工执行条件。' },
  { key: 'holding', label: '持仓', allowedActions: ['跟踪', '减仓', '止损', '复盘'], blockedActions: ['无计划加仓'], note: '持仓必须受退出纪律约束。' },
  { key: 'exit', label: '退出', allowedActions: ['确认退出', '生成复盘'], blockedActions: ['继续加仓'], note: '退出后沉淀为样本。' },
  { key: 'cooldown', label: '冷却', allowedActions: ['复盘', '降风险'], blockedActions: ['新增实仓'], note: '账户或标的进入冷却时只允许降风险。' }
];

const ACCOUNT_RISK_CONFIG_DEFAULTS = [
  { key: 'consecutive_failures_warn', label: '连续失败预警', value: 2, unit: '次', note: '达到后新计划降级。' },
  { key: 'consecutive_failures_block', label: '连续失败冷却', value: 3, unit: '次', note: '达到后暂停新增实仓。' },
  { key: 'monthly_loss_warn', label: '近30日亏损预警', value: 0, unit: '元', note: '低于该值后降低计划金额。' },
  { key: 'monthly_loss_block', label: '近30日亏损冷却', value: -10000, unit: '元', note: '低于该值后进入账户冷却。' },
  { key: 'largest_position_warn', label: '最大单计划占比预警', value: 0.45, unit: '比例', note: '当前暴露中单计划占比过高时提示。' },
  { key: 'active_plan_count_warn', label: '活跃计划数预警', value: 12, unit: '个', note: '同时跟踪计划太多会降低执行质量。' },
  { key: 'same_asset_type_count_warn', label: '同类资产计划数预警', value: 5, unit: '个', note: '同一资产类型过度集中时提示。' }
];

async function ensureFinanceDecisionSupportSchema(db: any) {
  if (decisionSupportSchemaReady) return;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS finance_failure_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      sample_type TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      asset_type TEXT,
      source TEXT,
      trade_date TEXT,
      status TEXT,
      reason TEXT,
      score_json TEXT,
      context_json TEXT,
      outcome_json TEXT,
      followup_status TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_failure_samples_unique
      ON finance_failure_samples(source_type, source_id, sample_type);

    CREATE INDEX IF NOT EXISTS idx_finance_failure_samples_symbol
      ON finance_failure_samples(symbol, asset_type, source);

    CREATE TABLE IF NOT EXISTS finance_sample_validation_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_sample_validation_snapshots_day
      ON finance_sample_validation_snapshots(snapshot_date, rule_version);

    CREATE TABLE IF NOT EXISTS finance_account_risk_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      numeric_value REAL NOT NULL,
      unit TEXT,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  for (const item of ACCOUNT_RISK_CONFIG_DEFAULTS) {
    await db.run(
      `INSERT OR IGNORE INTO finance_account_risk_config
        (config_key, label, numeric_value, unit, note)
       VALUES (?, ?, ?, ?, ?)`,
      [item.key, item.label, item.value, item.unit, item.note]
    );
  }

  decisionSupportSchemaReady = true;
}

async function getAccountRiskConfig(db: any) {
  await ensureFinanceDecisionSupportSchema(db);
  const rows = await db.all(
    `SELECT config_key, label, numeric_value, unit, note, updated_at
     FROM finance_account_risk_config
     ORDER BY id ASC`
  );
  const byKey = new Map<string, any>(rows.map((row: any) => [row.config_key, row]));
  return {
    rows,
    values: Object.fromEntries(
      ACCOUNT_RISK_CONFIG_DEFAULTS.map(item => {
        const row = byKey.get(item.key);
        return [item.key, toNumber(row?.numeric_value, item.value)];
      })
    )
  };
}

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

function getPlanScoreBucket(score: number | null | undefined) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) {
    return { key: 'unknown', label: '未知分' };
  }
  if (Number(score) >= 80) return { key: '80-100', label: '80分以上' };
  if (Number(score) >= 65) return { key: '65-79', label: '65-79分' };
  if (Number(score) >= 50) return { key: '50-64', label: '50-64分' };
  return { key: '0-49', label: '50分以下' };
}

function summarizeScoreBuckets(items: any[], getScore: (item: any) => number | null | undefined) {
  const order = ['80-100', '65-79', '50-64', '0-49', 'unknown'];
  const bucketMap = new Map<string, any[]>();
  items.forEach(item => {
    const bucket = getPlanScoreBucket(getScore(item));
    bucketMap.set(bucket.key, [...(bucketMap.get(bucket.key) || []), item]);
  });

  return order
    .map(key => {
      const rows = bucketMap.get(key) || [];
      const label = getPlanScoreBucket(
        key === '80-100' ? 80 : key === '65-79' ? 65 : key === '50-64' ? 50 : key === '0-49' ? 0 : null
      ).label;
      return {
        key,
        label,
        total: rows.length,
        invalidated: rows.filter(item => item.metrics?.brokeInvalidation).length,
        summary: summarize(rows)
      };
    })
    .filter(row => row.total > 0);
}

function compactSample(row: any, metrics: ForwardMetrics) {
  const planQuality = row.plan_quality || null;
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    assetType: row.asset_type,
    source: row.source,
    tradeDate: row.trade_date,
    status: row.pool_status || row.status || row.review_status,
    score: row.priority_score ?? row.structure_score ?? null,
    structureScore: row.structure_score ?? null,
    triggerScore: row.trigger_score ?? null,
    planQualityScore: planQuality?.score ?? null,
    planQualityLabel: planQuality?.label ?? null,
    invalidationLine: row.invalidation_line ?? null,
    entryPrice: row.close ?? row.close_price ?? null,
    maxLossPercent: row.max_loss_percent ?? null,
    trendPhase: row.trend_phase_code || null,
    perf20d: row.perf_20d ?? null,
    stoppedOut: row.stopped_out === 1,
    falseBreakout: row.false_breakout === 1,
    chasedHigh: row.chased_high === 1,
    modelProbability: row.model_probability ?? null,
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

function getRouteV2Metadata(routeKey: string) {
  switch (routeKey) {
    case 'stock':
      return {
        strategyPool: '个股权益池',
        permissionStage: '备选',
        dedicatedRules: ['流动性过滤', '流通市值', '极端交易状态', '安全区', '结构成立', '账户风控'],
        modelUse: ['信号质量打分', '失败风险提示', '相似案例'],
        hardBlocks: ['ST/退市', '本地日线断档', '成交额过低', '流通市值过小', '极端交易状态'],
        nextAction: '符合条件后进入备选池，再走入场触发和计划质量评分。'
      };
    case 'broad_etf':
      return {
        strategyPool: '宽基权益ETF池',
        permissionStage: '备选',
        dedicatedRules: ['市场总闸', '宽基本身结构', '安全区', '成交额'],
        modelUse: ['辅助评分', '波动风险提示'],
        hardBlocks: ['市场总闸冻结', '趋势阶段不适合', '本地日线断档'],
        nextAction: '宽基不看行业强度，重点看总闸和自身结构。'
      };
    case 'industry_etf':
      return {
        strategyPool: '行业/主题ETF池',
        permissionStage: '备选',
        dedicatedRules: ['行业强度', '相对沪深300强度', '自身结构', '安全区', '成交额'],
        modelUse: ['行业强弱提示', '失败风险提示'],
        hardBlocks: ['行业强度不足', '趋势阶段不适合', '本地日线断档'],
        nextAction: '行业/主题ETF先过行业强度，再过自身结构。'
      };
    case 'commodity_etf':
      return {
        strategyPool: '商品/贵金属池',
        permissionStage: '观察',
        dedicatedRules: ['商品周期', '美元/利率', '避险状态', '期现结构', '流动性'],
        modelUse: ['风险提示', '相似阶段参考'],
        hardBlocks: ['未接入商品专属规则池', '折溢价/期现结构缺失'],
        nextAction: '先进入商品/贵金属观察，不自动套A股权益入池。'
      };
    case 'cross_border_etf':
      return {
        strategyPool: 'QDII/跨境ETF池',
        permissionStage: '观察',
        dedicatedRules: ['海外市场趋势', '汇率', '折溢价', '额度/暂停申购', '交易时差'],
        modelUse: ['折溢价风险提示', '海外市场联动提示'],
        hardBlocks: ['折溢价缺失', '海外市场未接入', '额度/申购状态未知'],
        nextAction: '先补跨境专属检查，不直接进入A股权益主升池。'
      };
    case 'special_fund':
      return {
        strategyPool: 'LOF/特殊基金池',
        permissionStage: '观察',
        dedicatedRules: ['折溢价', '场内流动性', '基金结构', '申赎限制'],
        modelUse: ['高溢价风险提示'],
        hardBlocks: ['高溢价', '流动性不足', '申赎限制不清'],
        nextAction: '高溢价一票否决，先补基金结构信息。'
      };
    case 'bond_cash_etf':
      return {
        strategyPool: '债券/货币配置池',
        permissionStage: '不看',
        dedicatedRules: ['利率环境', '久期风险', '信用风险', '流动性'],
        modelUse: ['配置风险提示'],
        hardBlocks: ['不适用主升策略'],
        nextAction: '不进入主升交易池，只做配置观察。'
      };
    default:
      return {
        strategyPool: '待归类池',
        permissionStage: '不看',
        dedicatedRules: ['补资产类型', '确认底层资产', '定义策略池'],
        modelUse: ['暂不使用模型给交易许可'],
        hardBlocks: ['未定义专属规则池'],
        nextAction: '先补资产路由，再决定是否进入观察或备选。'
      };
  }
}

function getFailureTypeLabel(type: string) {
  switch (type) {
    case 'plan_invalidated': return '计划跌破失效线';
    case 'plan_negative_20d': return '计划20日负收益';
    case 'false_breakout': return '假突破';
    case 'chased_high': return '追高失败';
    case 'blocked_then_rallied': return '风控拦截后上涨';
    case 'blocked_validated': return '风控拦截被验证';
    case 'model_high_rule_failed': return '模型高分但规则失败';
    default: return type;
  }
}

function parseJson(value: any, fallback: any = null) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildFailureFollowupStatus(sampleType: string, metrics: ForwardMetrics) {
  if (sampleType === 'blocked_then_rallied') return 'needs_review';
  if (sampleType === 'blocked_validated') return 'validated';
  if (metrics.brokeInvalidation) return 'invalidated';
  if (metrics.ret20 !== null && metrics.ret20 < 0) return 'failed';
  if (metrics.ret20 !== null && metrics.ret20 > 0) return 'recovered';
  return 'tracking';
}

async function upsertFailureSample(db: any, item: any, sampleType: string, reason: string) {
  await db.run(
    `INSERT INTO finance_failure_samples
      (source_type, source_id, sample_type, symbol, name, asset_type, source, trade_date, status, reason,
       score_json, context_json, outcome_json, followup_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(source_type, source_id, sample_type) DO UPDATE SET
       symbol = excluded.symbol,
       name = excluded.name,
       asset_type = excluded.asset_type,
       source = excluded.source,
       trade_date = excluded.trade_date,
       status = excluded.status,
       reason = excluded.reason,
       score_json = excluded.score_json,
       context_json = excluded.context_json,
       outcome_json = excluded.outcome_json,
       followup_status = excluded.followup_status,
       updated_at = CURRENT_TIMESTAMP`,
    [
      item.sourceType || 'sample_validation',
      item.id,
      sampleType,
      item.symbol,
      item.name || '',
      item.assetType || item.asset_type || 'stock',
      item.source || 'tushare',
      item.tradeDate || item.trade_date || null,
      item.status || null,
      reason,
      JSON.stringify({
        score: item.score ?? null,
        structureScore: item.structureScore ?? null,
        triggerScore: item.triggerScore ?? null,
        planQualityScore: item.planQualityScore ?? null,
        modelProbability: item.modelProbability ?? null
      }),
      JSON.stringify({
        trendPhase: item.trendPhase ?? null,
        invalidationLine: item.invalidationLine ?? null,
        maxLossPercent: item.maxLossPercent ?? null,
        entryPrice: item.entryPrice ?? null,
        reason: item.reason || ''
      }),
      JSON.stringify(item.metrics || {}),
      buildFailureFollowupStatus(sampleType, item.metrics || {})
    ]
  );
}

async function syncFailureSamplesFromSummary(db: any, payload: { plans: any[]; blockedCandidates: any[]; modelConflicts: any[] }) {
  await ensureFinanceDecisionSupportSchema(db);
  let processed = 0;

  for (const plan of payload.plans) {
    const sampleTypes: Array<{ type: string; reason: string }> = [];
    if (plan.stoppedOut || plan.status === 'invalidated' || plan.metrics?.brokeInvalidation) {
      sampleTypes.push({ type: 'plan_invalidated', reason: '计划跌破失效线或已确认失效，沉淀为失败样本。' });
    }
    if (plan.falseBreakout) sampleTypes.push({ type: 'false_breakout', reason: '计划反馈标记为假突破。' });
    if (plan.chasedHigh) sampleTypes.push({ type: 'chased_high', reason: '计划反馈标记为追高失败。' });
    if (plan.metrics?.ret20 !== null && plan.metrics?.ret20 < 0) {
      sampleTypes.push({ type: 'plan_negative_20d', reason: '进入计划后20个交易日仍为负收益。' });
    }

    for (const sample of sampleTypes) {
      await upsertFailureSample(db, { ...plan, sourceType: 'trade_plan' }, sample.type, sample.reason);
      processed += 1;
    }
  }

  for (const candidate of payload.blockedCandidates) {
    const rallied = (candidate.metrics?.ret20 !== null && candidate.metrics?.ret20 >= 0.1) || (candidate.metrics?.ret10 !== null && candidate.metrics?.ret10 >= 0.06);
    const validated = candidate.metrics?.ret20 !== null && candidate.metrics?.ret20 <= 0;
    if (!rallied && !validated) continue;
    await upsertFailureSample(
      db,
      { ...candidate, sourceType: 'candidate_pool' },
      rallied ? 'blocked_then_rallied' : 'blocked_validated',
      rallied ? '风控/规则拦截后后续上涨，需要复盘当时拦截是否合理。' : '风控/规则拦截后后续走弱，拦截效果被样本验证。'
    );
    processed += 1;
  }

  for (const item of payload.modelConflicts) {
    await upsertFailureSample(
      db,
      { ...item, sourceType: 'candidate_review' },
      'model_high_rule_failed',
      '模型高分但安全区/结构/规则未通过，只能作为复核和训练样本，不给开仓许可。'
    );
    processed += 1;
  }

  return { processed };
}

async function getFailureSampleSummary(db: any) {
  await ensureFinanceDecisionSupportSchema(db);
  const rows = await db.all(
    `SELECT *
     FROM finance_failure_samples
     ORDER BY updated_at DESC
     LIMIT 120`
  );
  const groups = new Map<string, any[]>();
  rows.forEach((row: any) => groups.set(row.sample_type, [...(groups.get(row.sample_type) || []), row]));
  return {
    total: rows.length,
    groups: Array.from(groups.entries()).map(([type, items]) => ({
      type,
      label: getFailureTypeLabel(type),
      total: items.length
    })),
    items: rows.slice(0, 40).map((row: any) => ({
      id: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sampleType: row.sample_type,
      sampleTypeLabel: getFailureTypeLabel(row.sample_type),
      symbol: row.symbol,
      name: row.name,
      assetType: row.asset_type,
      tradeDate: row.trade_date,
      status: row.status,
      reason: row.reason,
      scores: parseJson(row.score_json, {}),
      context: parseJson(row.context_json, {}),
      outcome: parseJson(row.outcome_json, {}),
      followupStatus: row.followup_status,
      updatedAt: row.updated_at
    }))
  };
}

async function getSampleValidationSnapshots(db: any) {
  await ensureFinanceDecisionSupportSchema(db);
  const rows = await db.all(
    `SELECT id, snapshot_date, rule_version, summary_json, created_at, updated_at
     FROM finance_sample_validation_snapshots
     ORDER BY snapshot_date DESC, id DESC
     LIMIT 20`
  );
  return rows.map((row: any) => ({
    id: row.id,
    snapshotDate: row.snapshot_date,
    ruleVersion: row.rule_version,
    summary: parseJson(row.summary_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function compactSnapshotSummary(summary: any) {
  return {
    cards: summary.cards,
    planScoreBuckets: summary.planScoreBuckets,
    scoreBucketGroups: summary.scoreBucketGroups,
    trendFailure: summary.trendFailure,
    failureSamples: {
      total: summary.failureSamples?.total || 0,
      groups: summary.failureSamples?.groups || []
    },
    createdAt: new Date().toISOString()
  };
}

async function buildSampleValidationSummary(db: any) {
  await ensureFinanceDecisionSupportSchema(db);
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
            max_loss_percent, suggested_entry_zone, trigger_type, trigger_reason, entry_reason,
            perf_5d, perf_10d, perf_20d, stopped_out, false_breakout, chased_high,
            created_at, updated_at
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
  const plans = await Promise.all(planRows.map(async (row: any) => {
    const planQuality = buildFinancePlanQuality(row);
    return compactSample({ ...row, plan_quality: planQuality }, await getForwardMetrics(db, row));
  }));
  const modelConflicts = await Promise.all(modelConflictRows.map(async (row: any) => compactSample(row, await getForwardMetrics(db, row))));

  const enteredCandidates = candidates.filter(item => ['active', 'planned'].includes(String(item.status)));
  const blockedCandidates = candidates.filter(item => String(item.status) === 'expired');
  const planInvalidations = plans.filter(item => item.metrics.brokeInvalidation || item.status === 'invalidated' || item.stoppedOut);
  const planFailures = plans.filter(item => item.metrics.brokeInvalidation || item.stoppedOut || (item.metrics.ret20 !== null && item.metrics.ret20 < 0));
  const syncResult = await syncFailureSamplesFromSummary(db, { plans, blockedCandidates, modelConflicts });

  const summary = {
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
      planInvalidations: { title: '跌破失效线计划', summary: summarize(planInvalidations), items: planInvalidations.slice(0, 30) },
      modelConflicts: { title: '模型高分但规则未通过', summary: summarize(modelConflicts), items: modelConflicts.slice(0, 30) },
      planFailures: { title: '计划失败样本', summary: summarize(planFailures), items: planFailures.slice(0, 30) }
    },
    scoreBucketGroups: [
      {
        key: 'triggerScore',
        title: '触发分桶验证',
        note: '更偏执行触发质量，能观察“触发偏弱是否更容易跌破失效线”。',
        buckets: summarizeScoreBuckets(plans, item => item.triggerScore)
      },
      {
        key: 'structureScore',
        title: '结构分桶验证',
        note: '更偏结构质量，能观察“结构分低是否更容易失败”。',
        buckets: summarizeScoreBuckets(plans, item => item.structureScore)
      },
      {
        key: 'planQualityScore',
        title: '计划质量分桶验证',
        note: '复用金融买入计划的综合计划质量分。',
        buckets: summarizeScoreBuckets(plans, item => item.planQualityScore)
      }
    ],
    planScoreBuckets: summarizeScoreBuckets(plans, item => item.planQualityScore),
    trendFailure: groupByTrend([...plans, ...blockedCandidates].filter(item => item.metrics.brokeInvalidation || (item.metrics.ret20 !== null && item.metrics.ret20 < 0))),
    rejectedOpportunities: {
      total: rejectedRows.length,
      reviewNeeded: rejectedRows.filter((row: any) => row.decision_quality === 'needs_review' || row.later_status === 'trigger_review').length,
      items: rejectedRows.slice(0, 20)
    },
    failureSamples: await getFailureSampleSummary(db),
    snapshots: await getSampleValidationSnapshots(db),
    permissionStages: PERMISSION_STAGES,
    modelBoundary: MODEL_BOUNDARY,
    syncResult
  };

  return summary;
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
      const baseRoute = classifyAssetRoute(row);
      const route = { ...baseRoute, ...getRouteV2Metadata(baseRoute.key) };
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
        strategyPool: route.strategyPool,
        permissionStage: route.permissionStage,
        dedicatedRules: route.dedicatedRules,
        modelUse: route.modelUse,
        hardBlocks: route.hardBlocks,
        nextAction: route.nextAction,
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
        },
        permissionStages: PERMISSION_STAGES,
        modelBoundary: MODEL_BOUNDARY
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取资产类型路由失败：${(error as Error).message}` });
  }
});

router.get('/sample-validation/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const data = await buildSampleValidationSummary(db);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取样本验证失败：${(error as Error).message}` });
  }
});

router.post('/sample-validation/snapshot', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceDecisionSupportSchema(db);
    const summary = await buildSampleValidationSummary(db);
    const dateRow = await db.get(`SELECT date('now', 'localtime') as snapshot_date`);
    const snapshotDate = dateRow?.snapshot_date || new Date().toISOString().slice(0, 10);
    await db.run(
      `INSERT INTO finance_sample_validation_snapshots
        (snapshot_date, rule_version, summary_json, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(snapshot_date, rule_version) DO UPDATE SET
         summary_json = excluded.summary_json,
         updated_at = CURRENT_TIMESTAMP`,
      [snapshotDate, DECISION_SUPPORT_RULE_VERSION, JSON.stringify(compactSnapshotSummary(summary))]
    );
    res.json({
      success: true,
      data: {
        snapshotDate,
        ruleVersion: DECISION_SUPPORT_RULE_VERSION,
        snapshots: await getSampleValidationSnapshots(db)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `保存样本快照失败：${(error as Error).message}` });
  }
});

router.post('/failure-samples/sync', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const summary = await buildSampleValidationSummary(db);
    res.json({
      success: true,
      data: {
        syncResult: summary.syncResult,
        failureSamples: summary.failureSamples
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `同步失败样本失败：${(error as Error).message}` });
  }
});

router.get('/account-risk/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceDecisionSupportSchema(db);
    const riskConfig = await getAccountRiskConfig(db);
    const config = riskConfig.values;
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
    const maxAssetTypeCount = byAssetType.reduce((max, row) => Math.max(max, row.count), 0);
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
        status: latestFailures.length >= config.consecutive_failures_block ? 'block' : latestFailures.length >= config.consecutive_failures_warn ? 'warn' : 'pass',
        value: latestFailures.length,
        message: latestFailures.length >= config.consecutive_failures_block
          ? `连续失败达到${config.consecutive_failures_block}次，建议进入账户冷却，只允许复盘和减风险。`
          : latestFailures.length >= config.consecutive_failures_warn
            ? `连续失败达到${config.consecutive_failures_warn}次，新开仓降级。`
            : '没有触发连续失败冷却。'
      },
      {
        key: 'monthly_loss',
        label: '近30日已结束盈亏',
        status: recentEndedProfit <= config.monthly_loss_block ? 'block' : recentEndedProfit < config.monthly_loss_warn ? 'warn' : 'pass',
        value: roundMetric(recentEndedProfit, 2),
        message: recentEndedProfit <= config.monthly_loss_block
          ? '近30日亏损较大，暂停新增实仓。'
          : recentEndedProfit < config.monthly_loss_warn
            ? '近30日为亏损，降低单笔计划金额。'
            : '近30日已结束仓位未触发亏损限制。'
      },
      {
        key: 'largest_position',
        label: '最大单计划暴露',
        status: totalExposure > 0 && largest && toNumber(largest.current_amount) / totalExposure >= config.largest_position_warn ? 'warn' : 'pass',
        value: totalExposure > 0 && largest ? roundMetric(toNumber(largest.current_amount) / totalExposure) : null,
        message: totalExposure > 0 && largest && toNumber(largest.current_amount) / totalExposure >= config.largest_position_warn ? '最大单计划占比偏高，继续新增前先考虑退出路径。' : '单计划暴露没有明显过度集中。'
      },
      {
        key: 'active_plan_count',
        label: '同时跟踪计划数',
        status: activePlans.length >= config.active_plan_count_warn ? 'warn' : 'pass',
        value: activePlans.length,
        message: activePlans.length >= config.active_plan_count_warn ? '同时跟踪计划过多，容易执行分散，建议清理低质量计划。' : '同时跟踪计划数量可控。'
      },
      {
        key: 'same_asset_type_count',
        label: '同类资产集中',
        status: maxAssetTypeCount >= config.same_asset_type_count_warn ? 'warn' : 'pass',
        value: maxAssetTypeCount,
        message: maxAssetTypeCount >= config.same_asset_type_count_warn ? '同一资产类型计划数量偏多，新计划先确认是否重复暴露。' : '同类资产计划数量可控。'
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
        rules,
        config: riskConfig.rows,
        permissionStages: PERMISSION_STAGES,
        modelBoundary: MODEL_BOUNDARY
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取账户级风控失败：${(error as Error).message}` });
  }
});

router.patch('/account-risk/config', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceDecisionSupportSchema(db);
    const updates = Array.isArray(req.body?.items) ? req.body.items : [];
    const allowedKeys = new Set(ACCOUNT_RISK_CONFIG_DEFAULTS.map(item => item.key));

    for (const item of updates) {
      const key = String(item?.config_key || item?.key || '');
      if (!allowedKeys.has(key)) continue;
      const value = Number(item?.numeric_value ?? item?.value);
      if (!Number.isFinite(value)) continue;
      await db.run(
        `UPDATE finance_account_risk_config
         SET numeric_value = ?, updated_at = CURRENT_TIMESTAMP
         WHERE config_key = ?`,
        [value, key]
      );
    }

    const data = await getAccountRiskConfig(db);
    res.json({ success: true, data: { config: data.rows } });
  } catch (error) {
    res.status(500).json({ success: false, message: `更新账户风控配置失败：${(error as Error).message}` });
  }
});

export default router;
