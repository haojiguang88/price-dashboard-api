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

export interface MarketAssetMeta {
  symbol: string;
  name: string;
  role: string;
  label: string;
  category: string;
}

export interface IndustryEtfCandidate {
  symbol: string;
  name: string;
  source: string;
  universe_types: string;
  is_focus: number;
}

export interface BenchmarkReturns {
  ret5: number | null;
  ret10: number | null;
  ret20: number | null;
  ret60: number | null;
}

export interface IndustryEtfStrengthContext {
  scope: 'focus' | 'all';
  benchmarkSymbol: string;
  benchmarkReturns: BenchmarkReturns;
  benchmarkDataCount: number;
  candidateMap: Map<string, IndustryEtfCandidate>;
}

export interface IndustryEtfStrengthItem extends IndustryEtfCandidate {
  trade_date: string | null;
  close: number | null;
  data_count: number;
  return_5d?: number | null;
  return_10d?: number | null;
  return_20d?: number | null;
  return_60d?: number | null;
  relative_5d?: number | null;
  relative_10d?: number | null;
  relative_20d?: number | null;
  relative_60d?: number | null;
  ma20?: number | null;
  ma60?: number | null;
  ma20_slope: string;
  ma60_slope: string;
  distance_to_ma20?: number | null;
  distance_to_ma60?: number | null;
  drawdown_20?: number | null;
  drawdown_60?: number | null;
  activity_ratio_5_20?: number | null;
  strength_score: number;
  strength_status: string;
  strength_label: string;
  action_label: string;
  reason: string;
}

export const INDUSTRY_STRENGTH_ALLOWED_STATUSES = new Set(['LEADING', 'REPAIR']);

export const MARKET_ASSETS: MarketAssetMeta[] = [
  { symbol: '000300', name: '沪深300', role: 'core_large', label: '核心大盘环境', category: 'broad' },
  { symbol: '000905', name: '中证500', role: 'mid_small', label: '中小盘环境', category: 'broad' },
  { symbol: '399006', name: '创业板指', role: 'growth', label: '成长风格环境', category: 'style' },
  { symbol: '000688', name: '科创50', role: 'tech_volatility', label: '科技高波动风格', category: 'style' },
  { symbol: '512880', name: '证券ETF', role: 'industry_etf', label: '行业ETF', category: 'industry' },
  { symbol: '512480', name: '半导体ETF', role: 'industry_etf', label: '行业ETF', category: 'industry' },
  { symbol: '512170', name: '医疗ETF', role: 'industry_etf', label: '行业ETF', category: 'industry' },
  { symbol: '515790', name: '光伏ETF', role: 'industry_etf', label: '行业ETF', category: 'industry' },
  { symbol: '515030', name: '新能源车ETF', role: 'industry_etf', label: '行业ETF', category: 'industry' },
  { symbol: '159819', name: '人工智能ETF', role: 'industry_etf', label: '行业ETF', category: 'industry' },
  { symbol: '518880', name: '黄金ETF', role: 'industry_etf', label: '行业ETF', category: 'industry' },
  { symbol: '161226', name: '白银基金LOF', role: 'industry_etf', label: '行业ETF', category: 'industry' },
  { symbol: '561560', name: '电力ETF', role: 'industry_etf', label: '行业ETF', category: 'industry' },
  { symbol: '516510', name: '云计算ETF', role: 'industry_etf', label: '行业ETF', category: 'industry' }
];

const NON_EQUITY_ETF_NAME_PATTERN = /货币|快线|现金|债|国债|地债|政金|城投|信用债|可转债|短融|同业存单|存单|黄金ETF|上海金|金ETF|白银|豆粕|商品|原油/;

export function isNonEquityEtfName(name?: string | null): boolean {
  return NON_EQUITY_ETF_NAME_PATTERN.test(name || '');
}

export function getMarketAssetMeta(symbol: string): MarketAssetMeta {
  return MARKET_ASSETS.find(asset => asset.symbol === symbol) || {
    symbol,
    name: symbol,
    role: 'custom',
    label: '自定义市场',
    category: 'custom'
  };
}

export function getPreferredMarketSource(symbol: string): string {
  const meta = getMarketAssetMeta(symbol);
  if (meta.category === 'broad' || meta.category === 'style') return 'tushare';
  return meta.category === 'industry' || symbol.startsWith('5') || symbol.startsWith('1') ? 'tushare' : 'akshare';
}

export function roundMetric(value: number | null | undefined, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function getReturn(prices: DailyPrice[], days: number) {
  if (prices.length <= days) return null;
  const latest = prices[prices.length - 1];
  const base = prices[prices.length - 1 - days];
  if (!latest || !base || !base.close) return null;
  return latest.close / base.close - 1;
}

function getMovingAverage(prices: DailyPrice[], days: number, endOffset = 0) {
  const end = prices.length - endOffset;
  if (end < days) return null;
  const slice = prices.slice(end - days, end);
  return slice.reduce((sum, item) => sum + item.close, 0) / days;
}

function getActivityValue(item: DailyPrice) {
  return Number(item.amount || 0) > 0 ? Number(item.amount || 0) : Number(item.volume || 0);
}

function getAverageActivity(prices: DailyPrice[]) {
  const values = prices.map(getActivityValue).filter(value => Number.isFinite(value) && value > 0);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getMaxDrawdownToLatest(prices: DailyPrice[], days: number) {
  if (prices.length === 0) return null;
  const slice = prices.slice(-days);
  if (slice.length === 0) return null;
  const peak = Math.max(...slice.map(item => Math.max(item.close || 0, item.high || 0)));
  const latest = prices[prices.length - 1];
  if (!peak || !latest?.close) return null;
  return latest.close / peak - 1;
}

export async function getDailyPricesAnySource(db: any, symbol: string, preferredSource = 'tushare'): Promise<DailyPrice[]> {
  const preferred = await db.all(
    `SELECT trade_date, open, high, low, close, volume, amount, updated_at
     FROM financial_daily_prices
     WHERE symbol = ? AND source = ?
     ORDER BY trade_date ASC`,
    [symbol, preferredSource]
  );
  if (preferred.length > 0) return preferred;

  return db.all(
    `SELECT trade_date, open, high, low, close, volume, amount, updated_at
     FROM financial_daily_prices
     WHERE symbol = ?
     ORDER BY trade_date ASC`,
    [symbol]
  );
}

export async function getIndustryEtfCandidates(db: any, scope: 'focus' | 'all') {
  const focusMap = new Map<string, IndustryEtfCandidate>();
  MARKET_ASSETS
    .filter(asset => asset.category === 'industry')
    .forEach(asset => {
      if (!isNonEquityEtfName(asset.name)) {
        focusMap.set(asset.symbol, {
          symbol: asset.symbol,
          name: asset.name,
          source: getPreferredMarketSource(asset.symbol),
          universe_types: 'market_environment_focus',
          is_focus: 1
        });
      }
    });

  const universeWhere = scope === 'all'
    ? `asset_type = 'etf' AND enabled = 1 AND source = 'tushare'`
    : `asset_type = 'etf' AND enabled = 1 AND source = 'tushare' AND universe_type = 'industry_etf'`;
  const universeRows = await db.all(
    `SELECT symbol, MAX(name) as name, source, GROUP_CONCAT(DISTINCT universe_type) as universe_types
     FROM financial_asset_universe
     WHERE ${universeWhere}
     GROUP BY symbol, source`
  );

  for (const row of universeRows) {
    const name = row.name || getMarketAssetMeta(row.symbol).name || row.symbol;
    if (isNonEquityEtfName(name)) continue;
    focusMap.set(row.symbol, {
      symbol: row.symbol,
      name,
      source: row.source || 'tushare',
      universe_types: row.universe_types || 'industry_etf',
      is_focus: focusMap.has(row.symbol) ? 1 : 0
    });
  }

  return Array.from(focusMap.values());
}

export async function buildIndustryEtfStrengthContext(
  db: any,
  options: { scope?: 'focus' | 'all'; benchmarkSymbol?: string } = {}
): Promise<IndustryEtfStrengthContext> {
  const scope = options.scope || 'focus';
  const benchmarkSymbol = options.benchmarkSymbol || '000300';
  const benchmarkPrices = await getDailyPricesAnySource(db, benchmarkSymbol, getPreferredMarketSource(benchmarkSymbol));
  const benchmarkReturns = {
    ret5: getReturn(benchmarkPrices, 5),
    ret10: getReturn(benchmarkPrices, 10),
    ret20: getReturn(benchmarkPrices, 20),
    ret60: getReturn(benchmarkPrices, 60)
  };
  const candidates = await getIndustryEtfCandidates(db, scope);

  return {
    scope,
    benchmarkSymbol,
    benchmarkReturns,
    benchmarkDataCount: benchmarkPrices.length,
    candidateMap: new Map(candidates.map(candidate => [candidate.symbol, candidate]))
  };
}

export function calculateIndustryEtfStrength(
  item: IndustryEtfCandidate,
  prices: DailyPrice[],
  benchmarkReturns: BenchmarkReturns
): IndustryEtfStrengthItem {
  if (prices.length < 120) {
    return {
      ...item,
      trade_date: prices.length > 0 ? prices[prices.length - 1].trade_date : null,
      close: prices.length > 0 ? prices[prices.length - 1].close : null,
      data_count: prices.length,
      ma20_slope: 'unknown',
      ma60_slope: 'unknown',
      strength_score: 0,
      strength_status: 'NO_DATA',
      strength_label: '数据不足',
      action_label: '先补日线',
      reason: '本地日线不足120日，暂不参与行业强度排序。'
    };
  }

  const latest = prices[prices.length - 1];
  const ret5 = getReturn(prices, 5);
  const ret10 = getReturn(prices, 10);
  const ret20 = getReturn(prices, 20);
  const ret60 = getReturn(prices, 60);
  const rel5 = ret5 !== null && benchmarkReturns.ret5 !== null ? ret5 - benchmarkReturns.ret5 : null;
  const rel10 = ret10 !== null && benchmarkReturns.ret10 !== null ? ret10 - benchmarkReturns.ret10 : null;
  const rel20 = ret20 !== null && benchmarkReturns.ret20 !== null ? ret20 - benchmarkReturns.ret20 : null;
  const rel60 = ret60 !== null && benchmarkReturns.ret60 !== null ? ret60 - benchmarkReturns.ret60 : null;
  const ma20 = getMovingAverage(prices, 20);
  const ma60 = getMovingAverage(prices, 60);
  const ma20Prev = getMovingAverage(prices, 20, 1);
  const ma60Prev = getMovingAverage(prices, 60, 1);
  const ma20Slope = ma20 !== null && ma20Prev !== null ? (ma20 > ma20Prev ? 'up' : ma20 < ma20Prev ? 'down' : 'flat') : 'unknown';
  const ma60Slope = ma60 !== null && ma60Prev !== null ? (ma60 > ma60Prev ? 'up' : ma60 < ma60Prev ? 'down' : 'flat') : 'unknown';
  const distanceToMa20 = ma20 ? latest.close / ma20 - 1 : null;
  const distanceToMa60 = ma60 ? latest.close / ma60 - 1 : null;
  const drawdown20 = getMaxDrawdownToLatest(prices, 20);
  const drawdown60 = getMaxDrawdownToLatest(prices, 60);
  const recentActivity = getAverageActivity(prices.slice(-5));
  const baseActivity = getAverageActivity(prices.slice(-25, -5));
  const activityRatio = recentActivity !== null && baseActivity !== null && baseActivity > 0 ? recentActivity / baseActivity : null;

  let score = 50;
  const reasons: string[] = [];

  if (rel20 !== null) {
    if (rel20 >= 0.06) { score += 20; reasons.push('20日显著跑赢沪深300'); }
    else if (rel20 >= 0.03) { score += 14; reasons.push('20日跑赢沪深300'); }
    else if (rel20 >= 0) { score += 8; reasons.push('20日不弱于沪深300'); }
    else if (rel20 <= -0.06) { score -= 18; reasons.push('20日明显跑输沪深300'); }
    else if (rel20 <= -0.03) { score -= 10; reasons.push('20日跑输沪深300'); }
  }

  if (rel60 !== null) {
    if (rel60 >= 0.08) { score += 14; reasons.push('60日相对强度持续'); }
    else if (rel60 >= 0.03) { score += 8; reasons.push('60日相对占优'); }
    else if (rel60 <= -0.06) { score -= 12; reasons.push('60日相对弱势'); }
  }

  if (ma20 !== null && latest.close > ma20) score += 6;
  if (ma60 !== null && latest.close > ma60) score += 10;
  if (ma20Slope === 'up') score += 7;
  if (ma60Slope === 'up') score += 5;
  if (ma20 !== null && latest.close < ma20) score -= 6;
  if (ma60 !== null && latest.close < ma60) score -= 12;
  if (activityRatio !== null && activityRatio >= 1.25) score += 5;
  if (activityRatio !== null && activityRatio < 0.7) score -= 4;
  if (drawdown20 !== null && drawdown20 <= -0.12) score -= 12;
  else if (drawdown20 !== null && drawdown20 <= -0.08) score -= 6;

  const crowded = Boolean(
    (ret20 !== null && ret20 >= 0.16 && (activityRatio ?? 0) >= 1.6) ||
    (distanceToMa60 !== null && distanceToMa60 >= 0.14)
  );

  let strengthStatus = 'WATCH';
  let strengthLabel = '中性观察';
  let actionLabel = '只观察';

  if (crowded) {
    strengthStatus = 'CROWDED';
    strengthLabel = '高位拥挤';
    actionLabel = '防追高';
    score = Math.min(score, 72);
    reasons.push('短期涨幅或偏离较高，先防追高');
  } else if (score >= 78 && (rel20 ?? 0) >= 0.03 && latest.close > (ma20 || Infinity) && latest.close > (ma60 || Infinity) && ma20Slope === 'up') {
    strengthStatus = 'LEADING';
    strengthLabel = '强势主线';
    actionLabel = '可进入ETF结构筛选';
  } else if (score >= 65 && latest.close > (ma60 || Infinity) && (rel20 ?? 0) >= -0.01) {
    strengthStatus = 'REPAIR';
    strengthLabel = '修复候选';
    actionLabel = '等待结构确认';
  } else if (score < 45 || (latest.close < (ma60 || 0) && (rel20 ?? 0) < 0)) {
    strengthStatus = 'WEAK';
    strengthLabel = '弱势回避';
    actionLabel = '暂不进ETF筛选';
  }

  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  const reason = reasons.length > 0 ? reasons.join('；') : '相对强弱和趋势结构中性，继续观察。';

  return {
    ...item,
    trade_date: latest.trade_date,
    close: roundMetric(latest.close, 3),
    data_count: prices.length,
    return_5d: roundMetric(ret5),
    return_10d: roundMetric(ret10),
    return_20d: roundMetric(ret20),
    return_60d: roundMetric(ret60),
    relative_5d: roundMetric(rel5),
    relative_10d: roundMetric(rel10),
    relative_20d: roundMetric(rel20),
    relative_60d: roundMetric(rel60),
    ma20: roundMetric(ma20, 3),
    ma60: roundMetric(ma60, 3),
    ma20_slope: ma20Slope,
    ma60_slope: ma60Slope,
    distance_to_ma20: roundMetric(distanceToMa20),
    distance_to_ma60: roundMetric(distanceToMa60),
    drawdown_20: roundMetric(drawdown20),
    drawdown_60: roundMetric(drawdown60),
    activity_ratio_5_20: roundMetric(activityRatio, 2),
    strength_score: boundedScore,
    strength_status: strengthStatus,
    strength_label: strengthLabel,
    action_label: actionLabel,
    reason
  };
}

export function isIndustryStrengthAllowed(item?: IndustryEtfStrengthItem | null): boolean {
  return Boolean(item && INDUSTRY_STRENGTH_ALLOWED_STATUSES.has(item.strength_status));
}

export function buildIndustryStrengthGateReason(item?: IndustryEtfStrengthItem | null): string | null {
  if (!item) {
    return 'ETF未纳入行业强度层，先压出备选池。';
  }
  if (isIndustryStrengthAllowed(item)) return null;
  return `行业强度未过闸：${item.strength_label}（强度${item.strength_score}），${item.action_label}。原因：${item.reason}`;
}

export function formatIndustryStrengthNote(item?: IndustryEtfStrengthItem | null): string | null {
  if (!item) return null;
  return `行业强度：${item.strength_label}/${item.strength_score}分`;
}

export async function buildIndustryEtfStrengthResponse(
  db: any,
  options: { scope?: 'focus' | 'all'; limit?: number; benchmarkSymbol?: string } = {}
) {
  const scope = options.scope || 'focus';
  const limit = Math.min(Number(options.limit || 30), 200);
  const benchmarkSymbol = options.benchmarkSymbol || '000300';
  const context = await buildIndustryEtfStrengthContext(db, { scope, benchmarkSymbol });
  const items = [];

  for (const candidate of context.candidateMap.values()) {
    const prices = await getDailyPricesAnySource(db, candidate.symbol, candidate.source || 'tushare');
    items.push(calculateIndustryEtfStrength(candidate, prices, context.benchmarkReturns));
  }

  const sortedItems = items
    .sort((a, b) => {
      if ((b.strength_score || 0) !== (a.strength_score || 0)) {
        return (b.strength_score || 0) - (a.strength_score || 0);
      }
      return (b.relative_20d ?? -999) - (a.relative_20d ?? -999);
    })
    .slice(0, limit);

  const statusCounts = sortedItems.reduce((summary: Record<string, number>, item) => {
    summary[item.strength_status] = (summary[item.strength_status] || 0) + 1;
    return summary;
  }, {});

  return {
    rule_version: 'industry_etf_strength_v1',
    scope,
    benchmark: {
      symbol: benchmarkSymbol,
      name: getMarketAssetMeta(benchmarkSymbol).name,
      return_5d: roundMetric(context.benchmarkReturns.ret5),
      return_10d: roundMetric(context.benchmarkReturns.ret10),
      return_20d: roundMetric(context.benchmarkReturns.ret20),
      return_60d: roundMetric(context.benchmarkReturns.ret60),
      data_count: context.benchmarkDataCount
    },
    total: context.candidateMap.size,
    returned: sortedItems.length,
    status_counts: statusCounts,
    items: sortedItems
  };
}
