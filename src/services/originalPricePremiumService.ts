/**
 * 原始价格溢价率（商品价格工作台概览用）。
 *
 * 口径：(当前商品价 − 最新登记的原始价格) ÷ 原始价格 × 100%。
 * 这是一条与「纪念币白银类按银值算的溢价率」并行、互不影响的独立口径：
 * 白银那条走 coinSilverPremiumService，这里只认 original_price_records。
 *
 * 原始价格按对象/变体登记在 original_price_records，命中规则：
 * 先按变体精确匹配，找不到再退回该对象的对象级（无变体）原始价。
 */

export type OriginalPricePremiumStatus = "calculated" | "unavailable";

export interface LatestOriginalPriceRecord {
  id: number;
  original_price: number;
  effective_date: string;
  source: string | null;
  variant_name: string | null;
}

export interface OriginalPricePremiumSnapshot {
  version: "original-price-v1";
  status: OriginalPricePremiumStatus;
  basis: "original_price";
  original_price: number | null;
  original_price_source: string;
  original_price_effective_date: string;
  original_price_record_id: number | null;
  original_price_variant_name: string;
  current_price: number | null;
  current_price_date: string;
  premium_amount: number | null;
  premium_percent: number | null;
  premium_label: string;
  note: string;
}

const normalizeText = (value: unknown): string => String(value ?? "").trim();

const toPositiveNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const resolveOriginalPricePremiumLabel = (premiumPercent: number | null): string => {
  if (premiumPercent === null) return "暂无法计算";
  if (premiumPercent <= -10) return "明显破发";
  if (premiumPercent < 0) return "小幅破发";
  if (premiumPercent < 30) return "低溢价";
  if (premiumPercent < 60) return "中等溢价";
  if (premiumPercent < 100) return "高溢价";
  return "超高溢价";
};

const ORIGINAL_PRICE_SELECT = `
  SELECT id, original_price, effective_date, source, variant_name
  FROM original_price_records
  WHERE is_deleted = 0
    AND category_name = ?
    AND object_name = ?
`;

/**
 * 取该对象/变体当前生效的原始价格：变体精确匹配优先，其次对象级原始价。
 * 没有登记过原始价格时返回 null（调用方据此决定不展示溢价率）。
 */
export const loadLatestOriginalPriceRecord = async (
  db: any,
  input: { category_name?: unknown; object_name?: unknown; variant_name?: unknown }
): Promise<LatestOriginalPriceRecord | null> => {
  const categoryName = normalizeText(input.category_name);
  const objectName = normalizeText(input.object_name);
  const variantName = normalizeText(input.variant_name);
  if (!categoryName || !objectName) return null;

  if (variantName) {
    const variantMatch = await db.get(
      `${ORIGINAL_PRICE_SELECT}
         AND COALESCE(variant_name, '') = ?
       ORDER BY date(effective_date) DESC, id DESC
       LIMIT 1`,
      [categoryName, objectName, variantName]
    );
    if (variantMatch) return variantMatch as LatestOriginalPriceRecord;
  }

  const objectLevelMatch = await db.get(
    `${ORIGINAL_PRICE_SELECT}
       AND COALESCE(variant_name, '') = ''
     ORDER BY date(effective_date) DESC, id DESC
     LIMIT 1`,
    [categoryName, objectName]
  );
  return (objectLevelMatch as LatestOriginalPriceRecord) || null;
};

export const buildOriginalPricePremiumSnapshot = (input: {
  original_price?: unknown;
  original_price_source?: unknown;
  original_price_effective_date?: unknown;
  original_price_record_id?: unknown;
  original_price_variant_name?: unknown;
  current_price?: unknown;
  current_price_date?: unknown;
}): OriginalPricePremiumSnapshot => {
  const originalPrice = toPositiveNumber(input.original_price);
  const currentPrice = toPositiveNumber(input.current_price);
  const recordId = Number(input.original_price_record_id);

  const base = {
    version: "original-price-v1" as const,
    basis: "original_price" as const,
    original_price: originalPrice === null ? null : round(originalPrice),
    original_price_source: normalizeText(input.original_price_source),
    original_price_effective_date: normalizeText(input.original_price_effective_date).slice(0, 10),
    original_price_record_id: Number.isFinite(recordId) && recordId > 0 ? recordId : null,
    original_price_variant_name: normalizeText(input.original_price_variant_name),
    current_price: currentPrice === null ? null : round(currentPrice),
    current_price_date: normalizeText(input.current_price_date).slice(0, 10)
  };

  if (originalPrice === null) {
    return {
      ...base,
      status: "unavailable",
      premium_amount: null,
      premium_percent: null,
      premium_label: "无原始价格",
      note: "该对象还没有登记原始价格，暂时无法计算溢价率。"
    };
  }

  if (currentPrice === null) {
    return {
      ...base,
      status: "unavailable",
      premium_amount: null,
      premium_percent: null,
      premium_label: "暂无法计算",
      note: "当前商品价格缺失，暂时无法计算溢价率。"
    };
  }

  const premiumAmount = round(currentPrice - originalPrice);
  const premiumPercent = round((currentPrice / originalPrice - 1) * 100, 1);

  return {
    ...base,
    status: "calculated",
    premium_amount: premiumAmount,
    premium_percent: premiumPercent,
    premium_label: resolveOriginalPricePremiumLabel(premiumPercent),
    note: "按最新商品价与最新登记的原始价格计算。"
  };
};

/** 概览用：查最新原始价 + 套最新商品价算出一条快照；没登记过原始价返回 null。 */
export const resolveOriginalPricePremium = async (
  db: any,
  input: {
    category_name?: unknown;
    object_name?: unknown;
    variant_name?: unknown;
    current_price?: unknown;
    current_price_date?: unknown;
  }
): Promise<OriginalPricePremiumSnapshot | null> => {
  const record = await loadLatestOriginalPriceRecord(db, input);
  if (!record) return null;
  return buildOriginalPricePremiumSnapshot({
    original_price: record.original_price,
    original_price_source: record.source,
    original_price_effective_date: record.effective_date,
    original_price_record_id: record.id,
    original_price_variant_name: record.variant_name,
    current_price: input.current_price,
    current_price_date: input.current_price_date
  });
};
