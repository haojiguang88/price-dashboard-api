import { getLatestCoveredTradeDate } from './financeTradeDate';

type FreshMarketRegimeOptions = {
  source?: string;
  assetTypes?: string[];
  symbol?: string;
};

const COMPOSITE_CONFIRM_SYMBOLS = ['000905', '399006', '000688'];

export type CompositeMarketGatePolicyKey = 'strict_v1' | 'split_v2' | 'hard_only';

type CompositeMarketGatePolicy = {
  key: CompositeMarketGatePolicyKey;
  ruleVersion: string;
  label: string;
  note: string;
  hard: {
    legacyBreadthMa60Ratio?: number;
    legacyDownRatio?: number;
    legacySecondaryAllWeak?: boolean;
    breadthCrashMa60Ratio?: number;
    breadthWeakMa60Ratio?: number;
    panicDownRatio?: number;
    panicBreadthMa60Ratio?: number;
    secondaryWeakBreadthMa60Ratio?: number;
    secondaryWeakDownRatio?: number;
  };
  observe: {
    breadthWarnMa60Ratio: number;
    downRatioWarn: number;
    secondaryAllWeakWarn: boolean;
    singleSecondaryWarn: boolean;
  };
};

export type CompositeMarketGateDecision = {
  policy: {
    key: CompositeMarketGatePolicyKey;
    ruleVersion: string;
    label: string;
    note: string;
  };
  decision: 'allow' | 'downgrade_observe' | 'hard_block' | 'primary_block';
  hardBlockers: string[];
  observeWarnings: string[];
  downgradeReasons: string[];
  blocked: boolean;
  warned: boolean;
};

export const DEFAULT_COMPOSITE_MARKET_GATE_POLICY_KEY: CompositeMarketGatePolicyKey = 'split_v2';

export const COMPOSITE_MARKET_GATE_POLICIES: Record<CompositeMarketGatePolicyKey, CompositeMarketGatePolicy> = {
  strict_v1: {
    key: 'strict_v1',
    ruleVersion: 'composite_market_gate_v1_strict_replay',
    label: '旧硬闸回放',
    note: '旧口径：宽度<35%、下跌家数>=60%、确认指数全弱任一命中就硬封锁，只用于验收对照。',
    hard: {
      legacyBreadthMa60Ratio: 0.35,
      legacyDownRatio: 0.6,
      legacySecondaryAllWeak: true
    },
    observe: {
      breadthWarnMa60Ratio: 0.45,
      downRatioWarn: 0.6,
      secondaryAllWeakWarn: true,
      singleSecondaryWarn: true
    }
  },
  split_v2: {
    key: 'split_v2',
    ruleVersion: 'composite_market_gate_v2_split',
    label: '硬封锁 + 降权观察',
    note: '沪深300原总闸仍是铁律；组合条件只有多重系统性风险叠加才硬封锁，单项分化改为降权/观察。',
    hard: {
      breadthCrashMa60Ratio: 0.25,
      breadthWeakMa60Ratio: 0.35,
      panicDownRatio: 0.72,
      panicBreadthMa60Ratio: 0.4,
      secondaryWeakBreadthMa60Ratio: 0.35,
      secondaryWeakDownRatio: 0.65
    },
    observe: {
      breadthWarnMa60Ratio: 0.45,
      downRatioWarn: 0.6,
      secondaryAllWeakWarn: true,
      singleSecondaryWarn: true
    }
  },
  hard_only: {
    key: 'hard_only',
    ruleVersion: 'composite_market_gate_v2_hard_only_replay',
    label: '极端硬封锁回放',
    note: '只拦截极端宽度塌陷和恐慌共振，其余全部作为观察降权，用于检查硬封锁是否过宽。',
    hard: {
      breadthCrashMa60Ratio: 0.2,
      breadthWeakMa60Ratio: 0.3,
      panicDownRatio: 0.78,
      panicBreadthMa60Ratio: 0.35,
      secondaryWeakBreadthMa60Ratio: 0.3,
      secondaryWeakDownRatio: 0.7
    },
    observe: {
      breadthWarnMa60Ratio: 0.45,
      downRatioWarn: 0.6,
      secondaryAllWeakWarn: true,
      singleSecondaryWarn: true
    }
  }
};

export function resolveCompositeMarketGatePolicy(policyKey?: string | null) {
  const key = String(policyKey || DEFAULT_COMPOSITE_MARKET_GATE_POLICY_KEY) as CompositeMarketGatePolicyKey;
  return COMPOSITE_MARKET_GATE_POLICIES[key] || COMPOSITE_MARKET_GATE_POLICIES[DEFAULT_COMPOSITE_MARKET_GATE_POLICY_KEY];
}

function normalizeRatio(value: any): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function formatRatioText(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

export function evaluateCompositeMarketGateDecision(
  input: {
    primaryAllowed: boolean;
    secondaryAllowCount: number;
    secondaryTotal: number;
    breadthAboveMa60: number | null;
    breadthDownRatio: number | null;
  },
  policyInput?: CompositeMarketGatePolicy | string | null
): CompositeMarketGateDecision {
  const policy = typeof policyInput === 'string' || !policyInput
    ? resolveCompositeMarketGatePolicy(policyInput)
    : policyInput;
  const hardBlockers: string[] = [];
  const observeWarnings: string[] = [];
  const downgradeReasons: string[] = [];
  const breadthAboveMa60 = normalizeRatio(input.breadthAboveMa60);
  const breadthDownRatio = normalizeRatio(input.breadthDownRatio);
  const secondaryAllWeak = input.secondaryTotal >= 2 && input.secondaryAllowCount === 0;

  if (!input.primaryAllowed) {
    return {
      policy: {
        key: policy.key,
        ruleVersion: policy.ruleVersion,
        label: policy.label,
        note: policy.note
      },
      decision: 'primary_block',
      hardBlockers,
      observeWarnings,
      downgradeReasons,
      blocked: false,
      warned: false
    };
  }

  if (policy.key === 'strict_v1') {
    if (breadthAboveMa60 !== null && breadthAboveMa60 > 0 && breadthAboveMa60 < Number(policy.hard.legacyBreadthMa60Ratio)) {
      hardBlockers.push(`市场宽度过弱：仅 ${formatRatioText(breadthAboveMa60)} 个股站上MA60，低于 ${(Number(policy.hard.legacyBreadthMa60Ratio) * 100).toFixed(0)}% 旧硬闸。`);
    }
    if (breadthDownRatio !== null && breadthDownRatio >= Number(policy.hard.legacyDownRatio)) {
      hardBlockers.push(`下跌家数占比 ${formatRatioText(breadthDownRatio)}，触发旧硬闸。`);
    }
    if (policy.hard.legacySecondaryAllWeak && secondaryAllWeak) {
      hardBlockers.push('中证500、创业板、科创等确认指数均未开放结构判断，旧口径一票封锁。');
    }
  } else {
    const hard = policy.hard;
    const breadthCrash = breadthAboveMa60 !== null && breadthAboveMa60 > 0 && breadthAboveMa60 < Number(hard.breadthCrashMa60Ratio);
    const breadthWeak = breadthAboveMa60 !== null && breadthAboveMa60 > 0 && breadthAboveMa60 < Number(hard.breadthWeakMa60Ratio);
    const panicSelloff = breadthDownRatio !== null && breadthDownRatio >= Number(hard.panicDownRatio);
    const broadSelloff = breadthDownRatio !== null && breadthDownRatio >= Number(hard.secondaryWeakDownRatio);
    const panicWithWeakBreadth = panicSelloff
      && breadthAboveMa60 !== null
      && breadthAboveMa60 > 0
      && breadthAboveMa60 < Number(hard.panicBreadthMa60Ratio);
    const secondaryWeakWithBadBreadth = secondaryAllWeak
      && breadthAboveMa60 !== null
      && breadthAboveMa60 > 0
      && breadthAboveMa60 < Number(hard.secondaryWeakBreadthMa60Ratio);

    if (breadthCrash) {
      hardBlockers.push(`硬封锁：市场宽度塌陷，仅 ${formatRatioText(breadthAboveMa60)} 个股站上MA60。`);
    }
    if (panicWithWeakBreadth) {
      hardBlockers.push(`硬封锁：下跌家数 ${formatRatioText(breadthDownRatio as number)} 且宽度低于 ${(Number(hard.panicBreadthMa60Ratio) * 100).toFixed(0)}%，恐慌和弱宽度共振。`);
    }
    if (secondaryWeakWithBadBreadth || (secondaryAllWeak && broadSelloff && breadthWeak)) {
      hardBlockers.push('硬封锁：确认指数全弱且市场宽度/下跌家数同步恶化，沪深300单独走强不放行。');
    }
  }

  if (hardBlockers.length === 0) {
    const observe = policy.observe;
    if (breadthAboveMa60 !== null && breadthAboveMa60 > 0 && breadthAboveMa60 < observe.breadthWarnMa60Ratio) {
      const text = `市场宽度偏弱：${formatRatioText(breadthAboveMa60)} 个股站上MA60，进入更严格筛选。`;
      observeWarnings.push(text);
      downgradeReasons.push(text);
    }
    if (breadthDownRatio !== null && breadthDownRatio >= observe.downRatioWarn) {
      const text = `下跌家数占比 ${formatRatioText(breadthDownRatio)}，当天分歧偏大，入池优先级降权。`;
      observeWarnings.push(text);
      downgradeReasons.push(text);
    }
    if (observe.secondaryAllWeakWarn && secondaryAllWeak) {
      const text = '确认指数全弱，市场风格没有扩散，只允许观察/降权推进。';
      observeWarnings.push(text);
      downgradeReasons.push(text);
    } else if (observe.singleSecondaryWarn && input.secondaryTotal >= 2 && input.secondaryAllowCount === 1) {
      const text = '只有一个确认指数开放结构判断，市场风格仍偏分化，候选优先级降权。';
      observeWarnings.push(text);
      downgradeReasons.push(text);
    }
  }

  return {
    policy: {
      key: policy.key,
      ruleVersion: policy.ruleVersion,
      label: policy.label,
      note: policy.note
    },
    decision: hardBlockers.length > 0 ? 'hard_block' : observeWarnings.length > 0 ? 'downgrade_observe' : 'allow',
    hardBlockers,
    observeWarnings,
    downgradeReasons,
    blocked: hardBlockers.length > 0,
    warned: observeWarnings.length > 0
  };
}

function isEntryAllowed(permission?: string | null) {
  return permission === 'ALLOW_STRUCTURE_CHECK';
}

function marketRowToComponent(row: any) {
  return {
    symbol: row?.symbol || null,
    name: row?.name || null,
    trade_date: row?.trade_date || null,
    market_regime: row?.market_regime || 'UNKNOWN',
    entry_permission: row?.entry_permission || 'OBSERVE_ONLY'
  };
}

async function getLatestMarketRows(db: any, symbols: string[]) {
  if (!symbols.length) return [];
  const placeholders = symbols.map(() => '?').join(',');
  return db.all(
    `SELECT r.symbol, r.name, r.trade_date, r.market_regime, r.entry_permission, r.result_reason, r.entry_reason
     FROM financial_market_regime r
     WHERE r.symbol IN (${placeholders})
       AND r.id = (
         SELECT r2.id
         FROM financial_market_regime r2
         WHERE r2.symbol = r.symbol
         ORDER BY r2.trade_date DESC, r2.id DESC
         LIMIT 1
       )`,
    symbols
  );
}

async function getLatestBreadthRow(db: any, targetTradeDate?: string | null) {
  const dateClause = targetTradeDate ? 'WHERE trade_date <= ?' : '';
  return db.get(
    `SELECT trade_date, up_ratio, down_ratio, limit_up_ratio, limit_down_ratio,
            above_ma20_ratio, above_ma60_ratio, above_ma120_ratio, amount_ratio_5_20
     FROM financial_market_breadth_daily
     ${dateClause}
     ORDER BY trade_date DESC, id DESC
     LIMIT 1`,
    targetTradeDate ? [targetTradeDate] : []
  );
}

async function buildCompositeMarketGate(db: any, primaryRow: any, targetTradeDate: string | null) {
  const symbols = Array.from(new Set([primaryRow?.symbol || '000300', ...COMPOSITE_CONFIRM_SYMBOLS]));
  const rows = await getLatestMarketRows(db, symbols);
  const componentMap = new Map(rows.map((row: any) => [String(row.symbol), row]));
  const primarySymbol = String(primaryRow?.symbol || '000300');
  const secondaryRows = COMPOSITE_CONFIRM_SYMBOLS
    .map(symbol => componentMap.get(symbol))
    .filter(Boolean);
  const secondaryAllowCount = secondaryRows.filter((row: any) => isEntryAllowed(row.entry_permission)).length;
  const breadth = await getLatestBreadthRow(db, targetTradeDate || primaryRow?.trade_date || null);
  const breadthAboveMa60 = breadth?.above_ma60_ratio === null || breadth?.above_ma60_ratio === undefined
    ? null
    : Number(breadth.above_ma60_ratio);
  const breadthDownRatio = breadth?.down_ratio === null || breadth?.down_ratio === undefined
    ? null
    : Number(breadth.down_ratio);
  const decision = evaluateCompositeMarketGateDecision({
    primaryAllowed: isEntryAllowed(primaryRow?.entry_permission),
    secondaryAllowCount,
    secondaryTotal: secondaryRows.length,
    breadthAboveMa60,
    breadthDownRatio
  });

  return {
    rule_version: decision.policy.ruleVersion,
    policy: decision.policy,
    decision: decision.decision,
    primary_symbol: primarySymbol,
    primary: marketRowToComponent(primaryRow),
    components: symbols.map(symbol => marketRowToComponent(componentMap.get(symbol) || (symbol === primarySymbol ? primaryRow : { symbol }))),
    breadth: breadth ? {
      trade_date: breadth.trade_date || null,
      up_ratio: breadth.up_ratio === null || breadth.up_ratio === undefined ? null : Number(breadth.up_ratio),
      down_ratio: breadthDownRatio,
      limit_up_ratio: breadth.limit_up_ratio === null || breadth.limit_up_ratio === undefined ? null : Number(breadth.limit_up_ratio),
      limit_down_ratio: breadth.limit_down_ratio === null || breadth.limit_down_ratio === undefined ? null : Number(breadth.limit_down_ratio),
      above_ma20_ratio: breadth.above_ma20_ratio === null || breadth.above_ma20_ratio === undefined ? null : Number(breadth.above_ma20_ratio),
      above_ma60_ratio: breadthAboveMa60,
      above_ma120_ratio: breadth.above_ma120_ratio === null || breadth.above_ma120_ratio === undefined ? null : Number(breadth.above_ma120_ratio),
      amount_ratio_5_20: breadth.amount_ratio_5_20 === null || breadth.amount_ratio_5_20 === undefined ? null : Number(breadth.amount_ratio_5_20)
    } : null,
    secondary_allow_count: secondaryAllowCount,
    secondary_total: secondaryRows.length,
    hard_blockers: decision.hardBlockers,
    observe_warnings: decision.observeWarnings,
    downgrade_reasons: decision.downgradeReasons,
    blockers: decision.hardBlockers,
    warnings: decision.observeWarnings,
    blocked: decision.blocked,
    warned: decision.warned
  };
}

export async function getFreshMarketRegime(db: any, options: FreshMarketRegimeOptions = {}) {
  const symbol = options.symbol || '000300';
  const source = options.source || 'tushare';
  const targetTradeDate = await getLatestCoveredTradeDate(db, {
    source,
    assetTypes: options.assetTypes || ['stock', 'etf', 'index']
  });
  const row = await db.get(
    `SELECT market_regime, entry_permission, trade_date, result_reason, entry_reason, rule_version, updated_at
     FROM financial_market_regime
     WHERE symbol = ?
     ORDER BY trade_date DESC, id DESC
     LIMIT 1`,
    [symbol]
  );
  const regimeTradeDate = row?.trade_date ? String(row.trade_date) : null;
  const stale = Boolean(targetTradeDate && (!regimeTradeDate || regimeTradeDate < targetTradeDate));
  const freshnessReason = stale
    ? `市场总闸口径 ${regimeTradeDate || '无'} 落后行情覆盖日 ${targetTradeDate}，已按观察处理，请先刷新市场状态或运行金融日终流水线。`
    : regimeTradeDate
      ? `市场总闸口径 ${regimeTradeDate} 与当前行情覆盖日一致。`
      : '暂无市场总闸记录，已按观察处理。';

  const compositeGate = await buildCompositeMarketGate(db, row, targetTradeDate);
  const compositeBlocked = Boolean(!stale && isEntryAllowed(row?.entry_permission) && compositeGate.blocked);
  const compositeWarningText = !compositeBlocked && !stale && isEntryAllowed(row?.entry_permission) && compositeGate.warnings.length > 0
    ? compositeGate.warnings.join('；')
    : '';
  const compositeBlockText = compositeBlocked ? compositeGate.blockers.join('；') : '';
  const finalMarketRegime = stale
    ? 'UNKNOWN'
    : compositeBlocked
      ? 'RISK'
      : row?.market_regime || 'UNKNOWN';
  const finalEntryPermission = stale
    ? 'OBSERVE_ONLY'
    : compositeBlocked
      ? 'OBSERVE_ONLY'
      : row?.entry_permission || 'OBSERVE_ONLY';
  const finalEntryReason = stale
    ? freshnessReason
    : compositeBlocked
      ? `组合总闸未通过：${compositeBlockText}`
      : compositeWarningText
        ? `${row?.entry_reason || '允许进入个股/ETF结构判断。'}；组合总闸提示：${compositeWarningText}`
        : row?.entry_reason || 'OBSERVE_ONLY';
  const finalResultReason = stale
    ? freshnessReason
    : compositeBlocked
      ? `组合总闸把市场从 ${row?.market_regime || 'UNKNOWN'} 降为 RISK：${compositeBlockText}`
      : compositeWarningText
        ? `${row?.result_reason || ''} 组合总闸提示：${compositeWarningText}`.trim()
        : row?.result_reason || null;

  return {
    ...(row || {}),
    source_market_regime: row?.market_regime || null,
    source_entry_permission: row?.entry_permission || null,
    market_regime: finalMarketRegime,
    entry_permission: finalEntryPermission,
    result_reason: finalResultReason,
    entry_reason: finalEntryReason,
    composite_gate: compositeGate,
    trade_date: regimeTradeDate,
    target_trade_date: targetTradeDate,
    stale,
    freshness_status: stale ? 'stale' : regimeTradeDate ? 'fresh' : 'missing',
    freshness_reason: freshnessReason
  };
}
