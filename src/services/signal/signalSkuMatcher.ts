import { normalizeSignalText } from "./signalText";

/**
 * 线报 → 现有 SKU（categories / objects / variants）确定性匹配。
 *
 * 实验要求第十条：能可靠匹配才给结果，匹配不上就 unmatched，不许硬凑。
 * 所以这里没有模型、没有模糊猜词，只有：
 *   1) 用现有 SKU 名 + source_mappings 里的外部别名建词典；
 *   2) 归一化后做包含匹配，按「别名长度 × 类型权重 + 品类上下文人 + 是否在采价」打分；
 *   3) 太短的对象名必须有品类上下文才允许命中（否则「邮政」「招商」这种词会到处误配）；
 *   4) 两个不同 SKU 分数接近 → ambiguous，同样不算命中。
 */

export type SkuMatchStatus = "matched" | "unmatched" | "ambiguous";

export interface SkuDictionaryEntry {
  aliasRaw: string;
  aliasNorm: string;
  kind: "variant" | "object" | "alias";
  skuKey: string;
  categoryName: string;
  objectName: string;
  variantName: string;
  categoryNorm: string;
  tracked: boolean;
}

export interface SkuDictionary {
  entries: SkuDictionaryEntry[];
  /**
   * 「这个对象确实被提到了」的证据词，按 品类|对象 归类。
   * 变体名（尤其颜色、规格这类属性词）单独出现时不足以认定 SKU ——
   * 「象牙白」不是商品，「iQOO 触控笔 2s 象牙白」才是。
   */
  objectEvidence: Record<string, string[]>;
  size: number;
  builtAt: string;
}

export interface SkuCandidate {
  sku: string;
  score: number;
  matched_alias: string;
  kind: SkuDictionaryEntry["kind"];
}

export interface SkuMatchResult {
  match_status: SkuMatchStatus;
  confidence: number;
  matched_product_name: string;
  sku: string | null;
  category_name: string | null;
  object_name: string | null;
  variant_name: string | null;
  candidates: SkuCandidate[];
  note: string;
}

const MIN_ALIAS_LENGTH = 3;
const MIN_SCORE = 5;
/**
 * 别名被多少个不同 SKU 共用：像变体「2026年」这种年份词会被十几个 SKU 共用，
 * 它不是商品判别词，直接踢出词典（够长的除外）。
 */
const MAX_SHARED_SKUS = 3;
const SHARED_ALIAS_EXEMPT_LENGTH = 8;
/** 3~4 字的对象名给一点折扣，让更长更具体的名字优先（仅针对未在采价的名字）。 */
const SHORT_NAME_PENALTY = 0.9;
const SHORT_NAME_LENGTH = 4;
/**
 * 一个汉字的信息量明显高于一个英文字母：3 个汉字（龙银币）已经是很强的商品判别词，
 * 而 3 个字母（R10）几乎不判别。按字符类型加权，避免用同一把尺子量中英文。
 */
const CJK_CHAR_WEIGHT = 1.4;
const AMBIGUITY_RATIO = 0.75;
/**
 * 强命中门槛：一条线报里出现两个以上「强命中」的不同对象，通常是清单式发帖
 * （「今日好单：iPhone…、PS5…」），不该替人挑一个。
 * 光靠分数比例不够——中英文名长度不同，长英文名天然压过短中文名。
 */
const STRONG_SCORE = 8;

const KIND_WEIGHT: Record<SkuDictionaryEntry["kind"], number> = {
  variant: 1.35,
  alias: 1.2,
  object: 1
};

/** 线报撸货不盯这些品类。泡泡玛特是二级行情生意，跟公开线报不是一套玩法。 */
export const SIGNAL_EXCLUDED_CATEGORIES = ["泡泡玛特"];

const isExcludedCategory = (categoryName: string) => (
  SIGNAL_EXCLUDED_CATEGORIES.includes(String(categoryName || "").trim())
);

export const buildSkuKey = (categoryName: string, objectName: string, variantName: string): string => (
  [categoryName, objectName, variantName].filter(Boolean).join("/")
);

/** 词典带缓存：SKU 变化不频繁，没必要每条线报都重建。 */
let cachedDictionary: SkuDictionary | null = null;
const DICTIONARY_TTL_MS = 10 * 60 * 1000;

export const invalidateSkuDictionary = () => {
  cachedDictionary = null;
};

export const buildSkuDictionary = async (db: any, options: { force?: boolean } = {}): Promise<SkuDictionary> => {
  if (!options.force && cachedDictionary
    && Date.now() - new Date(cachedDictionary.builtAt).getTime() < DICTIONARY_TTL_MS) {
    return cachedDictionary;
  }

  const entries: SkuDictionaryEntry[] = [];
  const seen = new Set<string>();
  const objectEvidence: Record<string, string[]> = {};
  const addObjectEvidence = (categoryName: string, objectName: string, value: unknown) => {
    const norm = normalizeSignalText(value);
    if (norm.length < MIN_ALIAS_LENGTH) return;
    const key = `${categoryName}|${objectName}`;
    const list = objectEvidence[key] ?? [];
    if (!list.includes(norm)) list.push(norm);
    objectEvidence[key] = list;
  };

  const push = (
    aliasRaw: unknown,
    kind: SkuDictionaryEntry["kind"],
    categoryName: string,
    objectName: string,
    variantName: string
  ) => {
    const alias = String(aliasRaw ?? "").trim();
    const aliasNorm = normalizeSignalText(alias);
    if (!alias || aliasNorm.length < MIN_ALIAS_LENGTH) return;
    const skuKey = buildSkuKey(categoryName, objectName, variantName);
    const dedupeKey = `${kind}|${aliasNorm}|${skuKey}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    entries.push({
      aliasRaw: alias,
      aliasNorm,
      kind,
      skuKey,
      categoryName,
      objectName,
      variantName,
      categoryNorm: normalizeSignalText(categoryName),
      tracked: false
    });
  };

  // 1) 现有 SKU 目录
  const catalog = await db.all(`
    SELECT c.name AS category_name, o.name AS object_name, COALESCE(v.name, '') AS variant_name
    FROM categories c
    JOIN objects o ON o.category_id = c.id AND COALESCE(o.is_archived, 0) = 0
    LEFT JOIN variants v ON v.object_id = o.id AND COALESCE(v.is_archived, 0) = 0
    WHERE COALESCE(c.is_archived, 0) = 0
  `);
  for (const row of catalog as Array<{ category_name: string; object_name: string; variant_name: string }>) {
    if (isExcludedCategory(row.category_name)) continue;
    addObjectEvidence(row.category_name, row.object_name, row.object_name);
    if (row.variant_name) push(row.variant_name, "variant", row.category_name, row.object_name, row.variant_name);
    push(row.object_name, "object", row.category_name, row.object_name, "");
  }

  // 2) 采集侧的外部别名（source_mappings）——同一件货在不同档口的叫法
  const mappings = await db.all(`
    SELECT external_name, category_name, object_name, COALESCE(variant_name, '') AS variant_name
    FROM source_mappings
    WHERE status = 'enabled' AND external_name IS NOT NULL AND TRIM(external_name) <> ''
  `);
  for (const row of mappings as Array<{ external_name: string; category_name: string; object_name: string; variant_name: string }>) {
    if (!row.category_name || !row.object_name) continue;
    if (isExcludedCategory(row.category_name)) continue;
    // 只有对象级别名才能证明「对象被提到」；变体级别名不能反向证明对象
    if (!row.variant_name) addObjectEvidence(row.category_name, row.object_name, row.external_name);
    push(row.external_name, "alias", row.category_name, row.object_name, row.variant_name || "");
  }

  // 3) 标记「正在采价的目标 SKU」——有价格记录的才给加分
  const tracked = await db.all(`
    SELECT DISTINCT category AS category_name, object_name, COALESCE(variant, '') AS variant_name
    FROM price_records
  `);
  const trackedKeys = new Set(
    (tracked as Array<{ category_name: string; object_name: string; variant_name: string }>)
      .map(row => buildSkuKey(row.category_name, row.object_name, row.variant_name))
  );
  const trackedObjectKeys = new Set(
    (tracked as Array<{ category_name: string; object_name: string }>).map(row => buildSkuKey(row.category_name, row.object_name, ""))
  );
  for (const entry of entries) {
    entry.tracked = trackedKeys.has(entry.skuKey)
      || (entry.kind === "object" && trackedObjectKeys.has(entry.skuKey));
  }

  // 共用别名过滤：同一个别名指向太多 SKU 时它没有判别力（年份、颜色、规格词）。
  const skusPerAlias = new Map<string, Set<string>>();
  for (const entry of entries) {
    const bucket = skusPerAlias.get(entry.aliasNorm) ?? new Set<string>();
    bucket.add(entry.skuKey);
    skusPerAlias.set(entry.aliasNorm, bucket);
  }
  const discriminative = entries.filter(entry => {
    const shared = skusPerAlias.get(entry.aliasNorm)?.size ?? 1;
    return shared <= MAX_SHARED_SKUS || entry.aliasNorm.length >= SHARED_ALIAS_EXEMPT_LENGTH;
  });

  cachedDictionary = {
    entries: discriminative,
    objectEvidence,
    size: discriminative.length,
    builtAt: new Date().toISOString()
  };
  return cachedDictionary;
};

const scoreEntry = (entry: SkuDictionaryEntry, textNorm: string): number | null => {
  if (!textNorm.includes(entry.aliasNorm)) return null;

  const categoryBonus = entry.categoryNorm && textNorm.includes(entry.categoryNorm) ? 3 : 0;
  const rawLength = entry.aliasNorm.length;
  const effectiveLength = [...entry.aliasNorm]
    .reduce((sum, char) => sum + (/[\u4e00-\u9fa5]/.test(char) ? CJK_CHAR_WEIGHT : 1), 0);
  // 越短越容易撞车，给折扣；未在采价的名字折得更狠。2 字以下在词典构建阶段已被挡掉。
  const lengthPenalty = rawLength <= SHORT_NAME_LENGTH && !entry.tracked ? SHORT_NAME_PENALTY : 1;

  const trackedBonus = entry.tracked ? 1 : 0;
  return (effectiveLength * KIND_WEIGHT[entry.kind] + categoryBonus + trackedBonus) * lengthPenalty;
};

export const matchSignalToSku = (
  title: unknown,
  content: unknown,
  dictionary: SkuDictionary
): SkuMatchResult => {
  const textNorm = normalizeSignalText(`${String(title ?? "")}\n${String(content ?? "")}`);

  if (!textNorm) {
    return {
      match_status: "unmatched",
      confidence: 0,
      matched_product_name: "",
      sku: null,
      category_name: null,
      object_name: null,
      variant_name: null,
      candidates: [],
      note: "文本为空"
    };
  }

  const bestBySku = new Map<string, { entry: SkuDictionaryEntry; score: number }>();
  const objectEvidence = dictionary.objectEvidence ?? {};
  for (const entry of dictionary.entries) {
    // 变体只有在「它所属的对象也被提到」时才算命中，避免颜色/规格词单独成 SKU。
    if (entry.kind === "variant") {
      const evidence = objectEvidence[`${entry.categoryName}|${entry.objectName}`] ?? [];
      if (!evidence.some(item => textNorm.includes(item))) continue;
    }
    const score = scoreEntry(entry, textNorm);
    if (score === null) continue;
    const current = bestBySku.get(entry.skuKey);
    if (!current || score > current.score) {
      bestBySku.set(entry.skuKey, { entry, score });
    }
  }

  const ranked = [...bestBySku.values()]
    .map(item => ({
      sku: item.entry.skuKey,
      score: Number(item.score.toFixed(2)),
      matched_alias: item.entry.aliasRaw,
      kind: item.entry.kind,
      entry: item.entry
    }))
    .sort((a, b) => b.score - a.score);

  const candidates: SkuCandidate[] = ranked
    .slice(0, 5)
    .map(item => ({ sku: item.sku, score: item.score, matched_alias: item.matched_alias, kind: item.kind }));

  if (ranked.length === 0) {
    return {
      match_status: "unmatched",
      confidence: 0,
      matched_product_name: "",
      sku: null,
      category_name: null,
      object_name: null,
      variant_name: null,
      candidates,
      note: "未命中任何现有 SKU 名称或别名"
    };
  }

  let best = ranked[0];
  if (best.score < MIN_SCORE) {
    return {
      match_status: "unmatched",
      confidence: 0,
      matched_product_name: "",
      sku: null,
      category_name: null,
      object_name: null,
      variant_name: null,
      candidates,
      note: `最高分 ${best.score} 低于阈值 ${MIN_SCORE}，不强行匹配`
    };
  }

  // 只命中对象级、但同一对象下还有变体也命中时，升级到最具体的变体。
  // 变体比父对象更精确，这不是冲突，是同一件货的更细粒度。
  if (!best.entry.variantName) {
    const sameObjectVariant = ranked.find(item => (
      item.entry.variantName
      && item.entry.categoryName === best.entry.categoryName
      && item.entry.objectName === best.entry.objectName
    ));
    if (sameObjectVariant) best = sameObjectVariant;
  }

  // 冲突只在「不同对象」之间判定：同一个对象下的对象级/变体级不是歧义。
  const runnerUp = ranked.find(item => (
    item.sku !== best.sku
    && !(item.entry.categoryName === best.entry.categoryName && item.entry.objectName === best.entry.objectName)
  ));

  const strongDistinctObjects = ranked.filter(item => (
    item.score >= STRONG_SCORE
    && !(item.entry.categoryName === best.entry.categoryName && item.entry.objectName === best.entry.objectName)
  ));

  if ((runnerUp && runnerUp.score >= best.score * AMBIGUITY_RATIO) || strongDistinctObjects.length >= 1) {
    return {
      match_status: "ambiguous",
      confidence: 0,
      matched_product_name: "",
      sku: null,
      category_name: null,
      object_name: null,
      variant_name: null,
      candidates,
      note: `同时命中 ${best.sku} 与 ${(runnerUp ?? strongDistinctObjects[0]).sku}，交人工`
    };
  }

  const margin = runnerUp ? best.score - runnerUp.score : best.score;
  const confidence = Math.min(0.98, Number((0.55 + best.score / 60 + Math.min(margin, 20) / 80).toFixed(2)));

  return {
    match_status: "matched",
    confidence,
    matched_product_name: best.entry.kind === "variant"
      ? `${best.entry.objectName} ${best.entry.variantName}`
      : best.entry.objectName,
    sku: best.sku,
    category_name: best.entry.categoryName,
    object_name: best.entry.objectName,
    variant_name: best.entry.variantName,
    candidates,
    note: `命中「${best.matched_alias}」（${best.kind}，分数 ${best.score}）`
  };
};
