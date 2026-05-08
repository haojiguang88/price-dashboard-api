export type FinancePlanProfileKey =
  | 'stock_equity'
  | 'etf_broad_equity'
  | 'etf_industry_equity'
  | 'etf_cross_border'
  | 'etf_commodity'
  | 'etf_bond_cash'
  | 'etf_special'
  | 'etf_unknown'
  | 'market_index';

export interface FinancePlanProfileConfig {
  key: FinancePlanProfileKey;
  label: string;
  note: string;
  allowsTradePlan: boolean;
  invalidationBufferPercent: number;
  nearInvalidationMax: number;
  chaseDistanceMax: number;
  dailyChangeChaseMax: number;
  battleZonePercent: number;
  deepBreakPercent: number;
  heavyBreakVolumeRatio: number;
  minTriggerScore: number;
  minStructureScore: number;
  maxRiskPercent: number;
  tightRiskPercent: number;
  defaultRatios: { base: number; tactical: number; observation: number };
  strongRatios: { base: number; tactical: number; observation: number };
  weakRatios: { base: number; tactical: number; observation: number };
}

const PROFILE_CONFIGS: Record<FinancePlanProfileKey, FinancePlanProfileConfig> = {
  stock_equity: {
    key: 'stock_equity',
    label: '个股权益计划',
    note: '个股波动和退市/ST风险更高，失效线按MA60执行，仓位更强调机动和观察。',
    allowsTradePlan: true,
    invalidationBufferPercent: 0,
    nearInvalidationMax: 0.04,
    chaseDistanceMax: 0.08,
    dailyChangeChaseMax: 0.04,
    battleZonePercent: 0.01,
    deepBreakPercent: 0.01,
    heavyBreakVolumeRatio: 1.5,
    minTriggerScore: 45,
    minStructureScore: 65,
    maxRiskPercent: 0.08,
    tightRiskPercent: 0.04,
    defaultRatios: { base: 0.4, tactical: 0.4, observation: 0.2 },
    strongRatios: { base: 0.5, tactical: 0.3, observation: 0.2 },
    weakRatios: { base: 0.25, tactical: 0.35, observation: 0.4 }
  },
  etf_broad_equity: {
    key: 'etf_broad_equity',
    label: '宽基权益ETF计划',
    note: '宽基ETF单价低且波动更平滑，失效线在MA60下方留1.5%缓冲，避免轻微噪声反复触发。',
    allowsTradePlan: true,
    invalidationBufferPercent: 0.015,
    nearInvalidationMax: 0.05,
    chaseDistanceMax: 0.07,
    dailyChangeChaseMax: 0.03,
    battleZonePercent: 0.006,
    deepBreakPercent: 0.008,
    heavyBreakVolumeRatio: 1.35,
    minTriggerScore: 42,
    minStructureScore: 62,
    maxRiskPercent: 0.09,
    tightRiskPercent: 0.05,
    defaultRatios: { base: 0.5, tactical: 0.3, observation: 0.2 },
    strongRatios: { base: 0.6, tactical: 0.25, observation: 0.15 },
    weakRatios: { base: 0.35, tactical: 0.3, observation: 0.35 }
  },
  etf_industry_equity: {
    key: 'etf_industry_equity',
    label: '行业/主题权益ETF计划',
    note: '行业ETF需要行业强度配合，失效线在MA60下方留2%缓冲，但仓位不如宽基激进。',
    allowsTradePlan: true,
    invalidationBufferPercent: 0.02,
    nearInvalidationMax: 0.055,
    chaseDistanceMax: 0.08,
    dailyChangeChaseMax: 0.035,
    battleZonePercent: 0.008,
    deepBreakPercent: 0.01,
    heavyBreakVolumeRatio: 1.4,
    minTriggerScore: 45,
    minStructureScore: 65,
    maxRiskPercent: 0.1,
    tightRiskPercent: 0.055,
    defaultRatios: { base: 0.45, tactical: 0.3, observation: 0.25 },
    strongRatios: { base: 0.55, tactical: 0.25, observation: 0.2 },
    weakRatios: { base: 0.3, tactical: 0.3, observation: 0.4 }
  },
  etf_cross_border: {
    key: 'etf_cross_border',
    label: 'QDII/跨境ETF观察',
    note: '跨境ETF需要海外市场、汇率、折溢价和交易时差专属规则，暂不走A股权益买入计划。',
    allowsTradePlan: false,
    invalidationBufferPercent: 0.025,
    nearInvalidationMax: 0.06,
    chaseDistanceMax: 0.08,
    dailyChangeChaseMax: 0.04,
    battleZonePercent: 0.01,
    deepBreakPercent: 0.012,
    heavyBreakVolumeRatio: 1.4,
    minTriggerScore: 50,
    minStructureScore: 70,
    maxRiskPercent: 0.1,
    tightRiskPercent: 0.055,
    defaultRatios: { base: 0.3, tactical: 0.25, observation: 0.45 },
    strongRatios: { base: 0.4, tactical: 0.25, observation: 0.35 },
    weakRatios: { base: 0.2, tactical: 0.2, observation: 0.6 }
  },
  etf_commodity: {
    key: 'etf_commodity',
    label: '商品/黄金ETF观察',
    note: '商品/黄金ETF走商品周期和贵金属逻辑，暂不套A股权益买入计划。',
    allowsTradePlan: false,
    invalidationBufferPercent: 0.025,
    nearInvalidationMax: 0.06,
    chaseDistanceMax: 0.08,
    dailyChangeChaseMax: 0.04,
    battleZonePercent: 0.01,
    deepBreakPercent: 0.012,
    heavyBreakVolumeRatio: 1.4,
    minTriggerScore: 50,
    minStructureScore: 70,
    maxRiskPercent: 0.1,
    tightRiskPercent: 0.055,
    defaultRatios: { base: 0.3, tactical: 0.25, observation: 0.45 },
    strongRatios: { base: 0.4, tactical: 0.25, observation: 0.35 },
    weakRatios: { base: 0.2, tactical: 0.2, observation: 0.6 }
  },
  etf_bond_cash: {
    key: 'etf_bond_cash',
    label: '债券/货币ETF配置观察',
    note: '债券/货币ETF不适合主升买入计划，只做配置和利率风险观察。',
    allowsTradePlan: false,
    invalidationBufferPercent: 0.005,
    nearInvalidationMax: 0.02,
    chaseDistanceMax: 0.03,
    dailyChangeChaseMax: 0.01,
    battleZonePercent: 0.003,
    deepBreakPercent: 0.004,
    heavyBreakVolumeRatio: 1.2,
    minTriggerScore: 60,
    minStructureScore: 75,
    maxRiskPercent: 0.03,
    tightRiskPercent: 0.015,
    defaultRatios: { base: 0.2, tactical: 0.2, observation: 0.6 },
    strongRatios: { base: 0.3, tactical: 0.2, observation: 0.5 },
    weakRatios: { base: 0.1, tactical: 0.1, observation: 0.8 }
  },
  etf_special: {
    key: 'etf_special',
    label: 'LOF/特殊基金观察',
    note: 'LOF/特殊基金要先看折溢价、流动性和申赎限制，暂不自动生成权益买入计划。',
    allowsTradePlan: false,
    invalidationBufferPercent: 0.02,
    nearInvalidationMax: 0.05,
    chaseDistanceMax: 0.08,
    dailyChangeChaseMax: 0.035,
    battleZonePercent: 0.008,
    deepBreakPercent: 0.01,
    heavyBreakVolumeRatio: 1.4,
    minTriggerScore: 55,
    minStructureScore: 70,
    maxRiskPercent: 0.08,
    tightRiskPercent: 0.05,
    defaultRatios: { base: 0.2, tactical: 0.2, observation: 0.6 },
    strongRatios: { base: 0.3, tactical: 0.2, observation: 0.5 },
    weakRatios: { base: 0.1, tactical: 0.1, observation: 0.8 }
  },
  etf_unknown: {
    key: 'etf_unknown',
    label: '未归类ETF观察',
    note: 'ETF底层资产未识别，先补资产路由，不生成买入计划。',
    allowsTradePlan: false,
    invalidationBufferPercent: 0.02,
    nearInvalidationMax: 0.05,
    chaseDistanceMax: 0.08,
    dailyChangeChaseMax: 0.035,
    battleZonePercent: 0.008,
    deepBreakPercent: 0.01,
    heavyBreakVolumeRatio: 1.4,
    minTriggerScore: 55,
    minStructureScore: 70,
    maxRiskPercent: 0.08,
    tightRiskPercent: 0.05,
    defaultRatios: { base: 0.2, tactical: 0.2, observation: 0.6 },
    strongRatios: { base: 0.3, tactical: 0.2, observation: 0.5 },
    weakRatios: { base: 0.1, tactical: 0.1, observation: 0.8 }
  },
  market_index: {
    key: 'market_index',
    label: '市场指数观察',
    note: '指数只做市场总闸和环境判断，不直接生成交易计划。',
    allowsTradePlan: false,
    invalidationBufferPercent: 0,
    nearInvalidationMax: 0.04,
    chaseDistanceMax: 0.08,
    dailyChangeChaseMax: 0.04,
    battleZonePercent: 0.01,
    deepBreakPercent: 0.01,
    heavyBreakVolumeRatio: 1.5,
    minTriggerScore: 60,
    minStructureScore: 75,
    maxRiskPercent: 0.08,
    tightRiskPercent: 0.04,
    defaultRatios: { base: 0.2, tactical: 0.2, observation: 0.6 },
    strongRatios: { base: 0.3, tactical: 0.2, observation: 0.5 },
    weakRatios: { base: 0.1, tactical: 0.1, observation: 0.8 }
  }
};

function splitUniverseTypes(value: string | null | undefined): string[] {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function getFinancePlanProfileConfig(key?: string | null): FinancePlanProfileConfig {
  return PROFILE_CONFIGS[(key || 'stock_equity') as FinancePlanProfileKey] || PROFILE_CONFIGS.stock_equity;
}

export function resolveFinancePlanProfile(input: {
  assetType?: string | null;
  universeType?: string | null;
  symbol?: string | null;
  name?: string | null;
}): FinancePlanProfileConfig {
  const assetType = String(input.assetType || '').trim();
  const symbol = String(input.symbol || '');
  const text = `${input.name || ''} ${symbol}`;
  const typeSet = new Set(splitUniverseTypes(input.universeType));

  if (assetType === 'stock') return PROFILE_CONFIGS.stock_equity;
  if (assetType === 'index') return PROFILE_CONFIGS.market_index;
  if (assetType !== 'etf') return PROFILE_CONFIGS.etf_unknown;

  if (typeSet.has('bond_cash_etf') || /货币|快线|现金(?!流)|债|国债|地债|政金|城投|信用债|可转债|短融|同业存单|存单/.test(text)) {
    return PROFILE_CONFIGS.etf_bond_cash;
  }
  if (typeSet.has('commodity_etf') || /黄金ETF|上海金|金ETF|白银|豆粕|商品|原油|能源化工|有色期货/.test(text)) {
    return PROFILE_CONFIGS.etf_commodity;
  }
  if (typeSet.has('cross_border_etf') || /QDII|纳指|纳斯达克|标普|德国|法国|日经|东证|恒生|港股|中概|海外|美国|亚太|东南亚|沙特|印度/.test(text) || symbol.startsWith('513')) {
    return PROFILE_CONFIGS.etf_cross_border;
  }
  if (typeSet.has('special_fund') || /LOF|封闭|REIT|REITS|基础设施|创新未来|定开/.test(text)) {
    return PROFILE_CONFIGS.etf_special;
  }
  if (typeSet.has('industry_etf')) return PROFILE_CONFIGS.etf_industry_equity;
  if (typeSet.has('broad_etf')) return PROFILE_CONFIGS.etf_broad_equity;

  return PROFILE_CONFIGS.etf_unknown;
}

export function calculateProfileInvalidationLine(
  profileKey: string | null | undefined,
  input: { ma60?: number | null }
) {
  const profile = getFinancePlanProfileConfig(profileKey);
  const ma60 = Number(input.ma60);
  if (!Number.isFinite(ma60) || ma60 <= 0) return null;
  const line = ma60 * (1 - profile.invalidationBufferPercent);
  const digits = profile.key.startsWith('etf_') ? 4 : 3;
  return Math.round(line * 10 ** digits) / 10 ** digits;
}
