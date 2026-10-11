/**
 * 回收价匹配（可插拔 provider）。
 *
 * 现有系统里没有统一的「按 SKU 的回收行情」，所以按品类分通道，一个通道取不到就换下一个；
 * 全取不到时返回 null，由上层标「待回收价确认」，绝不拿卖价冒充回收价。
 *
 * 通道语义（都是现有系统里真实存在的来源，confidence 是对「这是不是回收价」的置信度）：
 *   千岛收购价        market_book_snapshots.bid_price（泡泡玛特等收藏品的买盘，最接近回收价）
 *   潮收汇电子产品报价 电子产品回收商日更报价
 *   潮收汇苹果备用报价 苹果手机回收商备用线路
 *   德璜小程序档口报价 档口收货价
 *   东旭游戏机档口    游戏机档口收货价
 *   爱藏龙银币/龙钞   钱币商收货价
 *   金投网贵金属回收   字面就是回收价
 */

export interface RecycleTarget {
  category_name: string | null;
  object_name: string | null;
  variant_name?: string | null;
}

export interface RecyclePriceQuote {
  price: number;
  effective_date: string | null;
  source: string;
  provider: string;
  confidence: number;
  /** variant = 精确到变体的报价；object = 退回到对象级报价，置信度打折 */
  precision: "variant" | "object";
  note: string;
}

interface ProviderHit {
  price: number;
  effective_date: string | null;
  source_label: string;
  precision: "variant" | "object";
  matched_variant: string;
}

interface RecycleProvider {
  id: string;
  label: string;
  confidence: number;
  categories: string[];
  lookup: (db: any, target: Required<RecycleTarget>) => Promise<ProviderHit | null>;
}

const toPositive = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const hitFromRow = (
  row: { price?: unknown; date?: string | null; source?: string | null } | undefined,
  sourceLabel: string,
  precision: ProviderHit["precision"],
  matchedVariant: string
): ProviderHit | null => {
  const price = toPositive(row?.price);
  if (price === null) return null;
  return {
    price,
    effective_date: row?.date || null,
    source_label: row?.source || sourceLabel,
    precision,
    matched_variant: matchedVariant
  };
};

/** 没有空变体报价时，用最近一日该对象各变体最低价当对象级。人工审核兜底，不因为没写颜色就丢掉。 */
const objectLevelFromLatestVariants = async (
  db: any,
  target: Required<RecycleTarget>,
  sourceLabels: string[],
  sourceLabel: string
): Promise<ProviderHit | null> => {
  const placeholders = sourceLabels.map(() => "?").join(", ");
  const latest = await db.get(
    `SELECT date
       FROM price_records
      WHERE category = ? AND object_name = ?
        AND source IN (${placeholders})
        AND CAST(price AS REAL) > 0
      ORDER BY date DESC, id DESC
      LIMIT 1`,
    [target.category_name, target.object_name, ...sourceLabels]
  );
  if (!latest?.date) return null;

  const cheapest = await db.get(
    `SELECT CAST(price AS REAL) AS price, date, source, COALESCE(variant, '') AS variant
       FROM price_records
      WHERE category = ? AND object_name = ?
        AND source IN (${placeholders})
        AND date = ?
        AND CAST(price AS REAL) > 0
      ORDER BY CAST(price AS REAL) ASC, id DESC
      LIMIT 1`,
    [target.category_name, target.object_name, ...sourceLabels, latest.date]
  );
  return hitFromRow(cheapest, sourceLabel, "object", "");
};

const priceRecordLookup = (
  sourceLabels: string[],
  sourceLabel: string
) => async (db: any, target: Required<RecycleTarget>): Promise<ProviderHit | null> => {
  const placeholders = sourceLabels.map(() => "?").join(", ");
  const query = `
    SELECT CAST(price AS REAL) AS price, date, source, COALESCE(variant, '') AS variant
    FROM price_records
    WHERE category = ? AND object_name = ?
      AND COALESCE(variant, '') = ?
      AND source IN (${placeholders})
      AND CAST(price AS REAL) > 0
    ORDER BY date DESC, id DESC
    LIMIT 1
  `;

  if (target.variant_name) {
    const exact = await db.get(query, [target.category_name, target.object_name, target.variant_name, ...sourceLabels]);
    const hit = hitFromRow(exact, sourceLabel, "variant", target.variant_name);
    if (hit) return hit;
  }

  const objectLevel = await db.get(query, [target.category_name, target.object_name, "", ...sourceLabels]);
  const emptyVariant = hitFromRow(objectLevel, sourceLabel, "object", "");
  if (emptyVariant) return emptyVariant;

  return objectLevelFromLatestVariants(db, target, sourceLabels, sourceLabel);
};

const QIANDAO_BID: RecycleProvider = {
  id: "qiandao_bid",
  label: "千岛收购价",
  confidence: 0.9,
  categories: ["泡泡玛特"],
  lookup: async (db, target) => {
    const query = `
      SELECT bid_price, date
      FROM market_book_snapshots
      WHERE category = ? AND object_name = ?
        AND COALESCE(variant, '') = ?
        AND bid_price IS NOT NULL AND CAST(bid_price AS REAL) > 0
      ORDER BY date DESC, id DESC
      LIMIT 1
    `;
    if (target.variant_name) {
      const exact = await db.get(query, [target.category_name, target.object_name, target.variant_name]);
      const price = toPositive(exact?.bid_price);
      if (price !== null) {
        return {
          price,
          effective_date: exact.date || null,
          source_label: "千岛收购价",
          precision: "variant",
          matched_variant: target.variant_name
        };
      }
    }
    const objectLevel = await db.get(query, [target.category_name, target.object_name, ""]);
    const emptyPrice = toPositive(objectLevel?.bid_price);
    if (emptyPrice !== null) {
      return {
        price: emptyPrice,
        effective_date: objectLevel.date || null,
        source_label: "千岛收购价",
        precision: "object",
        matched_variant: ""
      };
    }
    const latest = await db.get(
      `SELECT date FROM market_book_snapshots
        WHERE category = ? AND object_name = ?
          AND bid_price IS NOT NULL AND CAST(bid_price AS REAL) > 0
        ORDER BY date DESC, id DESC LIMIT 1`,
      [target.category_name, target.object_name]
    );
    if (!latest?.date) return null;
    const cheapest = await db.get(
      `SELECT bid_price, date FROM market_book_snapshots
        WHERE category = ? AND object_name = ? AND date = ?
          AND bid_price IS NOT NULL AND CAST(bid_price AS REAL) > 0
        ORDER BY CAST(bid_price AS REAL) ASC, id DESC LIMIT 1`,
      [target.category_name, target.object_name, latest.date]
    );
    const price = toPositive(cheapest?.bid_price);
    if (price === null) return null;
    return {
      price,
      effective_date: cheapest.date || null,
      source_label: "千岛收购价",
      precision: "object",
      matched_variant: ""
    };
  }
};

const ELECTRONICS_CATEGORIES = [
  "OPPO", "VIVO", "iQOO", "一加", "华为", "小米", "红米", "荣耀",
  "电脑", "电脑硬件", "影石", "佳能", "索尼", "索尼相机", "任天堂", "大疆", "三星"
];

const PROVIDERS: RecycleProvider[] = [
  QIANDAO_BID,
  {
    id: "cshrich_electronics",
    label: "潮收汇电子产品报价",
    confidence: 0.8,
    categories: ELECTRONICS_CATEGORIES,
    lookup: priceRecordLookup(["潮收汇电子产品报价"], "潮收汇电子产品报价")
  },
  {
    id: "cshrich_apple_backup",
    label: "潮收汇苹果备用报价",
    confidence: 0.8,
    categories: ["苹果手机"],
    lookup: priceRecordLookup(["潮收汇苹果备用报价"], "潮收汇苹果备用报价")
  },
  {
    id: "dehuang_dealer",
    label: "德璜小程序档口报价",
    confidence: 0.65,
    categories: ["苹果手机", ...ELECTRONICS_CATEGORIES],
    lookup: priceRecordLookup(["德璜小程序档口报价"], "德璜小程序档口报价")
  },
  {
    id: "dongxu_dealer",
    label: "东旭游戏机档口",
    confidence: 0.7,
    categories: ["游戏机"],
    lookup: priceRecordLookup(["东旭游戏机档口"], "东旭游戏机档口")
  },
  {
    id: "aizang_silver",
    label: "爱藏龙银币",
    confidence: 0.7,
    categories: ["纪念币"],
    lookup: priceRecordLookup(["爱藏龙银币"], "爱藏龙银币")
  },
  {
    id: "aizang_note",
    label: "爱藏龙钞",
    confidence: 0.7,
    categories: ["纪念钞"],
    lookup: priceRecordLookup(["爱藏龙钞"], "爱藏龙钞")
  },
  {
    id: "jijinhao_recycle",
    label: "金投网贵金属回收",
    confidence: 0.9,
    categories: ["贵金属"],
    lookup: priceRecordLookup(["金投网贵金属回收"], "金投网贵金属回收")
  }
];

/**
 * 品类 → 通道顺序。没登记的品类只走「来源名里带回收」的通用兜底，
 * 宁可不给回收价，也不拿别的品类的行情硬套。
 */
const CATEGORY_PROVIDER_ORDER: Record<string, string[]> = {
  贵金属: ["jijinhao_recycle"],
  泡泡玛特: ["qiandao_bid"],
  游戏机: ["dongxu_dealer"],
  纪念币: ["aizang_silver"],
  纪念钞: ["aizang_note"],
  苹果手机: ["cshrich_apple_backup", "dehuang_dealer"],
  ...Object.fromEntries(ELECTRONICS_CATEGORIES.map(category => [category, ["cshrich_electronics", "dehuang_dealer"]]))
};

const providerById = new Map(PROVIDERS.map(provider => [provider.id, provider]));

/** 通用兜底：任何来源名里带「回收」的报价都算回收口径。 */
const GENERIC_RECYCLE_PROVIDER: RecycleProvider = {
  id: "generic_recycle_source",
  label: "回收来源兜底",
  confidence: 0.6,
  categories: [],
  lookup: async (db, target) => {
    const query = `
      SELECT CAST(price AS REAL) AS price, date, source, COALESCE(variant, '') AS variant
      FROM price_records
      WHERE category = ? AND object_name = ?
        AND COALESCE(variant, '') = ?
        AND source LIKE '%回收%'
        AND CAST(price AS REAL) > 0
      ORDER BY date DESC, id DESC
      LIMIT 1
    `;
    if (target.variant_name) {
      const exact = await db.get(query, [target.category_name, target.object_name, target.variant_name]);
      const price = toPositive(exact?.price);
      if (price !== null) {
        return {
          price,
          effective_date: exact.date || null,
          source_label: exact.source || "回收来源",
          precision: "variant",
          matched_variant: target.variant_name
        };
      }
    }
    const objectLevel = await db.get(query, [target.category_name, target.object_name, ""]);
    const emptyPrice = toPositive(objectLevel?.price);
    if (emptyPrice !== null) {
      return {
        price: emptyPrice,
        effective_date: objectLevel.date || null,
        source_label: objectLevel.source || "回收来源",
        precision: "object",
        matched_variant: ""
      };
    }
    const latest = await db.get(
      `SELECT date FROM price_records
        WHERE category = ? AND object_name = ?
          AND source LIKE '%回收%'
          AND CAST(price AS REAL) > 0
        ORDER BY date DESC, id DESC LIMIT 1`,
      [target.category_name, target.object_name]
    );
    if (!latest?.date) return null;
    const cheapest = await db.get(
      `SELECT CAST(price AS REAL) AS price, date, source
         FROM price_records
        WHERE category = ? AND object_name = ?
          AND source LIKE '%回收%'
          AND date = ?
          AND CAST(price AS REAL) > 0
        ORDER BY CAST(price AS REAL) ASC, id DESC LIMIT 1`,
      [target.category_name, target.object_name, latest.date]
    );
    const price = toPositive(cheapest?.price);
    if (price === null) return null;
    return {
      price,
      effective_date: cheapest.date || null,
      source_label: cheapest.source || "回收来源",
      precision: "object",
      matched_variant: ""
    };
  }
};

export const listRecycleProviders = () => PROVIDERS.map(provider => ({
  id: provider.id,
  label: provider.label,
  confidence: provider.confidence,
  categories: provider.categories
}));

export const resolveRecyclePrice = async (
  db: any,
  target: RecycleTarget
): Promise<RecyclePriceQuote | null> => {
  const categoryName = String(target.category_name ?? "").trim();
  const objectName = String(target.object_name ?? "").trim();
  if (!categoryName || !objectName) return null;

  const normalized: Required<RecycleTarget> = {
    category_name: categoryName,
    object_name: objectName,
    variant_name: String(target.variant_name ?? "").trim()
  };

  const chain = (CATEGORY_PROVIDER_ORDER[categoryName] ?? [])
    .map(id => providerById.get(id))
    .filter((provider): provider is RecycleProvider => Boolean(provider));

  for (const provider of [...chain, GENERIC_RECYCLE_PROVIDER]) {
    const hit = await provider.lookup(db, normalized).catch(() => null);
    if (!hit) continue;
    const precisionFactor = hit.precision === "variant" ? 1 : 0.85;
    return {
      price: Number(hit.price.toFixed(2)),
      effective_date: hit.effective_date,
      source: hit.source_label,
      provider: provider.id,
      confidence: Number((provider.confidence * precisionFactor).toFixed(2)),
      precision: hit.precision,
      note: hit.precision === "variant"
        ? `按 ${hit.source_label} 的变体报价（${hit.matched_variant || "无变体"}）`
        : `该变体没有专门报价，退回 ${hit.source_label} 的对象级报价`
    };
  }

  return null;
};
