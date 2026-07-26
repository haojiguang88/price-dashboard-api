import getDb from "../config/database";
import {
  getSilverAnchorEvidence,
  type SilverAnchorEvidence
} from "./marketAnchorService";

export type CoinSilverPremiumBand =
  | "below_melt"
  | "low"
  | "medium"
  | "high"
  | "very_high";

export type CoinSilverTrendRisk =
  | "supportive"
  | "neutral"
  | "watch"
  | "high_risk"
  | "unknown";

export type CoinSilverPremiumDecision = "neutral" | "watch" | "incomplete";

export type CoinSilverMarketHeatLevel = "strong" | "mixed" | "weak" | "unknown";

export type CoinSilverMarketHeatSnapshot = {
  level: CoinSilverMarketHeatLevel;
  label: string;
  evidence: string[];
  note: string;
};

export type CoinSilverPremiumInput = {
  reference_price?: number | null;
  silver_grams?: number | null;
  price_source?: string | null;
  price_effective_date?: string | null;
  weight_basis?: string | null;
};

export type CoinSilverPremiumSnapshot = {
  version: "v1";
  calculated_at: string;
  reference_price: number;
  silver_grams: number;
  price_source: string;
  price_effective_date: string;
  weight_basis: string;
  silver_anchor_date: string;
  silver_price_per_gram: number;
  silver_content_value: number;
  premium_amount: number;
  premium_percent: number;
  premium_band: CoinSilverPremiumBand;
  premium_label: string;
  trend_risk: CoinSilverTrendRisk;
  trend_label: string;
  decision: CoinSilverPremiumDecision;
  decision_label: string;
  risk_note: string;
  calculation_note: string;
  market_heat: CoinSilverMarketHeatSnapshot;
  silver_trend: {
    trend_phase: string;
    recent_move: string;
    data_freshness: string;
    change_5d_percent: number | null;
    change_20d_percent: number | null;
    change_60d_percent: number | null;
  };
};

export type HistoricalCoinSilverPremiumSnapshot = {
  version: "historical-v1";
  reference_price: number;
  price_effective_date: string;
  silver_grams: number;
  weight_basis: string;
  silver_anchor_date: string;
  silver_price_per_gram: number;
  silver_content_value: number;
  premium_amount: number;
  premium_percent: number;
  premium_band: CoinSilverPremiumBand;
  premium_label: string;
  anchor_match: "same_day" | "previous_trading_day";
  anchor_gap_days: number | null;
  calculation_note: string;
};

type OriginalPriceRow = {
  id: number;
  object_name?: string | null;
  variant_name?: string | null;
  original_price?: number | null;
  effective_date?: string | null;
  source?: string | null;
  reason?: string | null;
  note?: string | null;
};

export type CoinSilverPremiumContext = {
  object_name: string;
  variant_name: string;
  latest_original_price_record: OriginalPriceRow | null;
  suggested_input: CoinSilverPremiumInput;
  calculation: CoinSilverPremiumSnapshot | null;
  silver_anchor: SilverAnchorEvidence;
};

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const positiveNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const normalizeText = (value: unknown) => String(value || "").trim();

export const deriveCoinSilverMarketHeat = (
  values: Record<string, unknown> = {}
): CoinSilverMarketHeatSnapshot => {
  const heat = normalizeText(values.has_market_heat);
  const capital = normalizeText(values.has_capital_attention);
  const bidSupport = normalizeText(values.has_continuous_bid_support);
  const dealBand = normalizeText(values.deal_band_stable);
  const hypeOnly = normalizeText(values.only_hype_no_real_demand);
  const evidence = [
    heat ? `市场热度：${heat}` : "",
    capital ? `资金关注：${capital}` : "",
    bidSupport ? `持续收货：${bidSupport}` : "",
    dealBand ? `成交带稳定：${dealBand}` : "",
    hypeOnly ? `仅喊价无承接：${hypeOnly}` : ""
  ].filter(Boolean);
  const weak = heat === "否"
    || bidSupport === "否"
    || dealBand === "否"
    || hypeOnly === "是";
  const strong = heat === "是"
    && bidSupport === "是"
    && dealBand === "是"
    && hypeOnly === "否";

  if (weak) {
    return {
      level: "weak",
      label: "真实热度/承接偏弱",
      evidence,
      note: "热度、持续收货、成交带或真实承接中已有弱项，市场未充分证明能承接非银溢价。"
    };
  }
  if (strong) {
    return {
      level: "strong",
      label: "真实热度与承接成立",
      evidence,
      note: "有真实热度、持续收货和稳定成交带，且不是单纯喊价，市场对非银价值已有实际承接。"
    };
  }
  if (evidence.length > 0) {
    return {
      level: "mixed",
      label: "真实热度待继续确认",
      evidence,
      note: "已有部分热度或承接信息，但尚不足以确认市场已经稳定接受非银溢价。"
    };
  }
  return {
    level: "unknown",
    label: "真实热度未记录",
    evidence: [],
    note: "当前场景没有可用的真实热度、持续收货和成交带信息。"
  };
};

export const inferCommemorativeCoinSilverWeight = (
  objectName?: string,
  variantName?: string,
  evidenceText?: string
): { grams: number | null; basis: string } => {
  const explicitText = [variantName, objectName, evidenceText]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
  const explicitMatch = explicitText.match(/(\d+(?:\.\d+)?)\s*(?:g|克)/i);
  const explicitGrams = positiveNumber(explicitMatch?.[1]);
  if (explicitGrams !== null) {
    return {
      grams: explicitGrams,
      basis: `从本地名称/记录识别 ${round(explicitGrams, 3)}g`
    };
  }

  const knownOneOunceObjects = /交通卡|农行卡|工商卡|招商|邮政|智能卡|封装龙|龙银币/;
  if (knownOneOunceObjects.test(normalizeText(objectName))) {
    return {
      grams: 31,
      basis: "按本地龙银币/卡类 1 盎司（31g）口径估算，可手动修改"
    };
  }

  return {
    grams: null,
    basis: "本地记录未识别含银重量，需要手动填写"
  };
};

const getPremiumBand = (premiumPercent: number): {
  band: CoinSilverPremiumBand;
  label: string;
} => {
  if (premiumPercent <= 0) return { band: "below_melt", label: "低于银本体价值" };
  if (premiumPercent <= 30) return { band: "low", label: "低溢价" };
  if (premiumPercent <= 60) return { band: "medium", label: "中等溢价" };
  if (premiumPercent <= 100) return { band: "high", label: "高溢价" };
  return { band: "very_high", label: "超高溢价" };
};

const dateOnlyToUtc = (value: string): number | null => {
  const match = normalizeText(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return timestamp;
};

export const calculateHistoricalCoinSilverPremiumSnapshot = (
  input: CoinSilverPremiumInput,
  anchor: { trade_date?: string | null; close?: number | null }
): HistoricalCoinSilverPremiumSnapshot | null => {
  const referencePrice = positiveNumber(input.reference_price);
  const silverGrams = positiveNumber(input.silver_grams);
  const silverClose = positiveNumber(anchor.close);
  const effectiveDate = normalizeText(input.price_effective_date).slice(0, 10);
  const anchorDate = normalizeText(anchor.trade_date).slice(0, 10);
  if (
    referencePrice === null
    || silverGrams === null
    || silverClose === null
    || !effectiveDate
    || !anchorDate
  ) {
    return null;
  }

  const effectiveTimestamp = dateOnlyToUtc(effectiveDate);
  const anchorTimestamp = dateOnlyToUtc(anchorDate);
  const anchorGapDays = effectiveTimestamp !== null && anchorTimestamp !== null
    ? Math.round((effectiveTimestamp - anchorTimestamp) / 86400000)
    : null;
  if (anchorGapDays !== null && anchorGapDays < 0) return null;

  const silverContentValue = silverGrams * silverClose;
  const premiumAmount = referencePrice - silverContentValue;
  const premiumPercent = (referencePrice / silverContentValue - 1) * 100;
  const premium = getPremiumBand(premiumPercent);

  return {
    version: "historical-v1",
    reference_price: round(referencePrice),
    price_effective_date: effectiveDate,
    silver_grams: round(silverGrams, 3),
    weight_basis: normalizeText(input.weight_basis) || "人工填写",
    silver_anchor_date: anchorDate,
    silver_price_per_gram: round(silverClose, 3),
    silver_content_value: round(silverContentValue),
    premium_amount: round(premiumAmount),
    premium_percent: round(premiumPercent, 1),
    premium_band: premium.band,
    premium_label: premium.label,
    anchor_match: anchorDate === effectiveDate ? "same_day" : "previous_trading_day",
    anchor_gap_days: anchorGapDays,
    calculation_note: "按发售/生效日或此前最近交易日的 Ag(T+D) 收盘价 × 含银克重计算；不计包装、评级、渠道费用和成色微差。"
  };
};

const getTrendRisk = (anchor: SilverAnchorEvidence): {
  risk: CoinSilverTrendRisk;
  label: string;
  note: string;
} => {
  const suggestion = anchor.trend_suggestion;
  if (
    !anchor.latest_date ||
    anchor.latest_close === null ||
    !suggestion ||
    ["缺失", "不确定"].includes(suggestion.data_freshness)
  ) {
    return {
      risk: "unknown",
      label: "银价走势未知",
      note: "银价数据缺失或过旧，当前溢价只能做静态参考。"
    };
  }

  if (
    suggestion.recent_move === "连续阴跌" ||
    suggestion.trend_phase === "熊市" ||
    suggestion.trend_phase === "牛转熊"
  ) {
    return {
      risk: "high_risk",
      label: "银本体承压",
      note: "银价处于熊市、牛转熊或连续阴跌阶段，银本体成本线可能继续下移。"
    };
  }

  if (suggestion.recent_move === "连续暴涨") {
    return {
      risk: "watch",
      label: "银价脉冲偏热",
      note: "银价连续暴涨会暂时抬高含银价值，低溢价或负溢价不能单独视为便宜。"
    };
  }

  if (suggestion.trend_phase === "熊转牛") {
    return {
      risk: "watch",
      label: "银价修复待确认",
      note: "银价处于熊转牛候选阶段，只能作为修复背景，不能直接授予纪念币买入权限。"
    };
  }

  if (
    suggestion.trend_phase === "牛市" &&
    ["温和上涨", "横盘"].includes(suggestion.recent_move)
  ) {
    return {
      risk: "supportive",
      label: "银价背景稳定",
      note: "银价牛市且近期温和上涨或横盘，银本体提供相对稳定的成本背景。"
    };
  }

  return {
    risk: "neutral",
    label: "银价背景中性",
    note: "银价暂未形成足以单独改变纪念币判断的明确背景。"
  };
};

export const calculateCoinSilverPremiumSnapshot = (
  input: CoinSilverPremiumInput,
  anchor: SilverAnchorEvidence,
  calculatedAt = new Date().toISOString(),
  marketValues: Record<string, unknown> = {}
): CoinSilverPremiumSnapshot | null => {
  const referencePrice = positiveNumber(input.reference_price);
  const silverGrams = positiveNumber(input.silver_grams);
  const silverClose = positiveNumber(anchor.latest_close);
  if (referencePrice === null || silverGrams === null || silverClose === null || !anchor.latest_date) {
    return null;
  }

  const silverContentValue = silverGrams * silverClose;
  const premiumAmount = referencePrice - silverContentValue;
  const premiumPercent = (referencePrice / silverContentValue - 1) * 100;
  const premium = getPremiumBand(premiumPercent);
  const trend = getTrendRisk(anchor);
  const marketHeat = deriveCoinSilverMarketHeat(marketValues);
  const pressureReasons: string[] = [];

  if (premium.band === "very_high") {
    pressureReasons.push("相对白银本体溢价超过 100%");
  } else if (premium.band === "high") {
    pressureReasons.push("相对白银本体溢价偏高");
  }

  if (trend.risk === "high_risk") {
    pressureReasons.push(trend.note);
  } else if (trend.risk === "watch" && ["high", "very_high", "below_melt"].includes(premium.band)) {
    pressureReasons.push(trend.note);
  }

  const hasPressure = pressureReasons.length > 0;
  const decision: CoinSilverPremiumDecision = hasPressure && marketHeat.level === "weak"
    ? "watch"
    : hasPressure && ["mixed", "unknown"].includes(marketHeat.level)
      ? "incomplete"
      : "neutral";
  const decisionLabel = decision === "watch"
    ? "溢价/银价与弱承接形成组合提示"
    : decision === "incomplete"
      ? "需补真实热度后解释溢价"
      : "背景证据，不单独改变结果";
  const riskNote = hasPressure
    ? marketHeat.level === "strong"
      ? `${pressureReasons.join("；")}，但真实热度与成交承接成立；记录为背景证据，不单独改变风控结果。`
      : `${pressureReasons.join("；")}；${marketHeat.note}该组合只作风险提示，最终仍以其它风控项为准。`
    : `${premium.label}；${trend.note}${marketHeat.note}银本体只作为背景证据，不能单独决定买卖。`;

  return {
    version: "v1",
    calculated_at: calculatedAt,
    reference_price: round(referencePrice),
    silver_grams: round(silverGrams, 3),
    price_source: normalizeText(input.price_source) || "人工填写",
    price_effective_date: normalizeText(input.price_effective_date),
    weight_basis: normalizeText(input.weight_basis) || "人工填写",
    silver_anchor_date: anchor.latest_date,
    silver_price_per_gram: round(silverClose, 3),
    silver_content_value: round(silverContentValue),
    premium_amount: round(premiumAmount),
    premium_percent: round(premiumPercent, 1),
    premium_band: premium.band,
    premium_label: premium.label,
    trend_risk: trend.risk,
    trend_label: trend.label,
    decision,
    decision_label: decisionLabel,
    risk_note: riskNote,
    calculation_note: "按含银克重 × Ag(T+D) 收盘价估算银本体价值；不计包装、评级、渠道费用和成色微差。",
    market_heat: marketHeat,
    silver_trend: {
      trend_phase: anchor.trend_suggestion?.trend_phase || "不确定",
      recent_move: anchor.trend_suggestion?.recent_move || "不确定",
      data_freshness: anchor.trend_suggestion?.data_freshness || "不确定",
      change_5d_percent: anchor.change_5d_percent,
      change_20d_percent: anchor.change_20d_percent,
      change_60d_percent: anchor.change_60d_percent
    }
  };
};

const findLatestOriginalPriceRecord = async (
  objectName: string,
  variantName: string
): Promise<OriginalPriceRow | null> => {
  if (!objectName) return null;
  const db = await getDb();
  const params: unknown[] = [objectName];
  let variantClause = "";
  if (variantName) {
    variantClause = " AND COALESCE(variant_name, '') = ?";
    params.push(variantName);
  }
  const row = await db.get<OriginalPriceRow>(
    `SELECT id, object_name, variant_name, original_price, effective_date, source, reason, note
     FROM original_price_records
     WHERE is_deleted = 0
       AND category_name = '纪念币'
       AND object_name = ?
       ${variantClause}
     ORDER BY date(effective_date) DESC, datetime(created_at) DESC, id DESC
     LIMIT 1`,
    params
  );
  return row || null;
};

export const getCoinSilverPremiumContext = async (options: {
  objectName?: string;
  variantName?: string;
  input?: CoinSilverPremiumInput;
  anchor?: SilverAnchorEvidence;
  marketValues?: Record<string, unknown>;
  refresh?: "none" | "stale" | "force";
} = {}): Promise<CoinSilverPremiumContext> => {
  const objectName = normalizeText(options.objectName);
  const variantName = normalizeText(options.variantName);
  const anchor = options.anchor || await getSilverAnchorEvidence({ refresh: options.refresh || "none" });
  const originalPriceRecord = await findLatestOriginalPriceRecord(objectName, variantName);
  const evidenceText = [
    originalPriceRecord?.reason,
    originalPriceRecord?.note
  ].map(normalizeText).filter(Boolean).join(" ");
  const inferredWeight = inferCommemorativeCoinSilverWeight(objectName, variantName, evidenceText);
  const hasProvidedInput = options.input !== undefined;
  const providedInput = options.input || {};
  const referencePrice = hasProvidedInput
    ? positiveNumber(providedInput.reference_price)
    : positiveNumber(originalPriceRecord?.original_price);
  const silverGrams = hasProvidedInput
    ? positiveNumber(providedInput.silver_grams)
    : inferredWeight.grams;
  const suggestedInput: CoinSilverPremiumInput = {
    reference_price: referencePrice,
    silver_grams: silverGrams,
    price_source: normalizeText(providedInput.price_source)
      || (originalPriceRecord ? `商品原始价格 #${originalPriceRecord.id}` : "人工填写"),
    price_effective_date: normalizeText(providedInput.price_effective_date)
      || normalizeText(originalPriceRecord?.effective_date),
    weight_basis: normalizeText(providedInput.weight_basis) || inferredWeight.basis
  };

  return {
    object_name: objectName,
    variant_name: variantName,
    latest_original_price_record: originalPriceRecord,
    suggested_input: suggestedInput,
    calculation: calculateCoinSilverPremiumSnapshot(
      suggestedInput,
      anchor,
      new Date().toISOString(),
      options.marketValues
    ),
    silver_anchor: anchor
  };
};

export const buildCoinSilverPremiumItemValue = (snapshot: CoinSilverPremiumSnapshot) => (
  `参考价 ¥${snapshot.reference_price.toFixed(2)}；${snapshot.silver_grams}g × 银价 ¥${snapshot.silver_price_per_gram.toFixed(3)}/g`
  + ` = 银本体 ¥${snapshot.silver_content_value.toFixed(2)}；溢价 ${snapshot.premium_percent >= 0 ? "+" : ""}${snapshot.premium_percent.toFixed(1)}%`
  + `；${snapshot.trend_label}；${snapshot.market_heat.label}；${snapshot.decision_label}`
);
