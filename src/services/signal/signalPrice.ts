/**
 * 线报价格提取（确定性规则，第一版不上模型）。
 *
 * 原则（对应实验要求第十一条）：
 * - 一律保留 raw_price_text，出了错能回看原文；
 * - 只在有明确口径标记（到手/券后/合…每件）时给出 final_buy_price；
 * - 多个互相冲突的价格且没有标记时，price_status = manual_review，不猜。
 */

export type SignalPriceStatus = "parsed" | "manual_review" | "unparsed";

export interface SignalPriceMention {
  value: number;
  index: number;
  role: "list" | "coupon" | "final" | "unknown";
  context: string;
}

export interface SignalPriceExtraction {
  rawPriceText: string;
  buyPrice: number | null;
  couponPrice: number | null;
  finalPrice: number | null;
  quantity: number | null;
  finalBuyPrice: number | null;
  priceStatus: SignalPriceStatus;
  detail: {
    mentions: SignalPriceMention[];
    quantityText: string | null;
    fullReductionText: string | null;
    firstPurchase: boolean;
    regionText: string | null;
    method: string;
  };
}

/**
 * 价格必须是「带货币标记的数字」或「带小数的数字」。
 * 裸整数不算价格——否则「任选7件」「80g」「18-18券」都会被当成钱。
 */
const CURRENCY_PREFIX = /(?:¥|￥)\s*(\d{1,7}(?:\.\d{1,2})?)/g;
const CURRENCY_SUFFIX = /(\d{1,7}(?:\.\d{1,2})?)\s*(?:元|块钱|块|rmb|人民币)/gi;
const BARE_DECIMAL = /(?<![\d.])(\d{1,6}\.\d{1,2})(?![\d])/g;
const PRICE_PROBE = /(?:¥|￥)\s*\d|\d{1,7}(?:\.\d{1,2})?\s*(?:元|块钱|块|rmb|人民币)|\d{1,6}\.\d{1,2}/i;

const LIST_MARKERS = ["原价", "券前", "标价", "吊牌价", "专柜价", "官方价", "零售价", "售价", "活动价"];
const COUPON_MARKERS = ["券后", "用券", "叠券", "凑券"];
const FINAL_MARKERS = ["到手", "合", "折合", "每件", "单价", "均价", "实付", "花了", "一共"];

const CONTEXT_RADIUS = 12;
/** 往数字前面看多少个字来判断口径（只看到紧邻的那一个标记）。 */
const MARKER_LOOKBACK = 8;

/**
 * 抽奖/免单类线报里的数字不是入手价（「抽10万份免单 最高免88元」的 88 是奖品上限）。
 * 命中这些词且就在价格旁边时，拒绝把它当成可执行入手价，交人工。
 */
const GIVEAWAY_MARKERS = /(免单|抽奖|抽取|抽\d|最高免|立减金|话费券|免单券|红包雨|免费领|签到领)/;
const GIVEAWAY_RADIUS = 25;

const toNumber = (value: string): number => Number(value);

/**
 * 口径标记取「紧挨在数字前面」的那一个，而不是整段上下文里出现过的任一标记。
 * 否则「券后129元，原价299元」里的 299 会被前面的「券后」污染成券后价。
 */
const classifyMention = (precedingText: string): SignalPriceMention["role"] => {
  const rules: Array<[string[], SignalPriceMention["role"]]> = [
    [COUPON_MARKERS, "coupon"],
    [FINAL_MARKERS, "final"],
    [LIST_MARKERS, "list"]
  ];
  let best: { role: SignalPriceMention["role"]; start: number } | null = null;

  for (const [markers, role] of rules) {
    for (const marker of markers) {
      const start = precedingText.lastIndexOf(marker);
      if (start >= 0 && (!best || start > best.start)) {
        best = { role, start };
      }
    }
  }

  return best ? best.role : "unknown";
};

export const extractPriceMentions = (text: string): SignalPriceMention[] => {
  const matches: Array<{ value: number; index: number; length: number }> = [];

  for (const pattern of [CURRENCY_PREFIX, CURRENCY_SUFFIX, BARE_DECIMAL]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = toNumber(match[1]);
      const index = match.index ?? 0;
      if (!Number.isFinite(value) || value <= 0) continue;
      matches.push({ value, index, length: match[0].length });
    }
  }

  // 同一位置的重复命中只保留一个。
  matches.sort((a, b) => a.index - b.index || b.length - a.length);
  const mentions: SignalPriceMention[] = [];
  let lastEnd = -1;
  for (const match of matches) {
    if (match.index < lastEnd) continue;
    lastEnd = match.index + match.length;
    const context = text.slice(Math.max(0, match.index - CONTEXT_RADIUS), match.index + match.length);
    const preceding = text.slice(Math.max(0, match.index - MARKER_LOOKBACK), match.index);
    mentions.push({
      value: match.value,
      index: match.index,
      role: classifyMention(preceding),
      context: context.trim()
    });
  }
  return mentions;
};

const pickQuantity = (text: string): { quantity: number | null; quantityText: string | null } => {
  const patterns = [
    /(?:买|拍|下|凑|购)\s*(\d{1,3})\s*(?:件|个|份|盒|套|瓶|箱|包)/,
    /(\d{1,3})\s*(?:件|个|份|盒|套|瓶|箱|包)\s*(?:装|起|组合|套餐)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const quantity = Number(match[1]);
      if (Number.isFinite(quantity) && quantity > 0) {
        return { quantity, quantityText: match[0] };
      }
    }
  }
  return { quantity: null, quantityText: null };
};

/** 保留含价格的句子片段，作为 raw_price_text 存档。 */
const buildRawPriceText = (text: string, mentions: SignalPriceMention[]): string => {
  if (mentions.length === 0) return "";
  const segments = text
    .split(/[\n。；;！!？?]/)
    .map(segment => segment.trim())
    .filter(segment => PRICE_PROBE.test(segment));
  return segments.slice(0, 6).join(" / ").slice(0, 400);
};


/** 命中抽奖语境时，这个数字不能当入手价。 */
const isGiveawayContext = (text: string, mention: SignalPriceMention | null): boolean => {
  if (!mention) return false;
  const window = text.slice(
    Math.max(0, mention.index - GIVEAWAY_RADIUS),
    mention.index + GIVEAWAY_RADIUS
  );
  return GIVEAWAY_MARKERS.test(window);
};

export const extractSignalPrice = (title: unknown, content: unknown): SignalPriceExtraction => {
  const text = [String(title ?? ""), String(content ?? "")].filter(Boolean).join("\n");
  const mentions = extractPriceMentions(text);
  const { quantity, quantityText } = pickQuantity(text);
  const fullReductionMatch = text.match(/满\s*(\d{1,6})\s*减\s*(\d{1,6})/);
  const regionMatch = text.match(/(限|仅限|只限)\s*([\u4e00-\u9fa5]{2,8}(?:地区|省|市|区|县)?)/);
  const firstPurchase = /(首购|首单|新人|新客)/.test(text);

  const listMentions = mentions.filter(item => item.role === "list");
  const couponMentions = mentions.filter(item => item.role === "coupon");
  const finalMentions = mentions.filter(item => item.role === "final");
  const distinctFinals = [...new Set(finalMentions.map(item => item.value))];

  const detail = {
    mentions,
    quantityText,
    fullReductionText: fullReductionMatch ? fullReductionMatch[0] : null,
    firstPurchase,
    regionText: regionMatch ? regionMatch[0].trim() : null,
    method: ""
  };

  const base = {
    rawPriceText: buildRawPriceText(text, mentions),
    buyPrice: listMentions.length > 0 ? Math.max(...listMentions.map(item => item.value)) : null,
    couponPrice: couponMentions.length > 0 ? Math.min(...couponMentions.map(item => item.value)) : null,
    quantity,
    detail
  };

  if (mentions.length === 0) {
    return {
      ...base,
      finalPrice: null,
      finalBuyPrice: null,
      priceStatus: "unparsed",
      detail: { ...detail, method: "no_price_found" }
    };
  }

  if (distinctFinals.length === 1) {
    const finalPrice = distinctFinals[0];
    const mention = finalMentions.find(item => item.value === finalPrice) || null;
    if (isGiveawayContext(text, mention)) {
      return {
        ...base,
        finalPrice: null,
        finalBuyPrice: null,
        priceStatus: "manual_review",
        detail: { ...detail, method: "promo_not_purchasable" }
      };
    }
    return {
      ...base,
      finalPrice,
      finalBuyPrice: finalPrice,
      priceStatus: "parsed",
      detail: { ...detail, method: "final_marker" }
    };
  }

  if (distinctFinals.length > 1) {
    // 同一篇里出现多个「到手/每件」，口径不明，交给人工。
    return {
      ...base,
      finalPrice: null,
      finalBuyPrice: null,
      priceStatus: "manual_review",
      detail: { ...detail, method: "conflicting_final_prices" }
    };
  }

  if (couponMentions.length === 1) {
    const mention = couponMentions[0];
    if (isGiveawayContext(text, mention)) {
      return {
        ...base,
        finalPrice: null,
        finalBuyPrice: null,
        priceStatus: "manual_review",
        detail: { ...detail, method: "promo_not_purchasable" }
      };
    }
    return {
      ...base,
      finalPrice: mention.value,
      finalBuyPrice: mention.value,
      priceStatus: "parsed",
      detail: { ...detail, method: "coupon_marker" }
    };
  }

  if (couponMentions.length > 1) {
    return {
      ...base,
      finalPrice: null,
      finalBuyPrice: null,
      priceStatus: "manual_review",
      detail: { ...detail, method: "conflicting_coupon_prices" }
    };
  }

  if (mentions.length === 1) {
    // 只有孤零零一个价格，且没有原价/券后干扰，可以当到手价用（抽奖语境除外）。
    const mention = mentions[0];
    if (isGiveawayContext(text, mention)) {
      return {
        ...base,
        finalPrice: null,
        finalBuyPrice: null,
        priceStatus: "manual_review",
        detail: { ...detail, method: "promo_not_purchasable" }
      };
    }
    return {
      ...base,
      finalPrice: mention.value,
      finalBuyPrice: mention.value,
      priceStatus: "parsed",
      detail: { ...detail, method: "single_price" }
    };
  }

  // 「活动售价59.9元，19.9元到手」这类：一个明确的原价标记 + 一个更低的无标记价，
  // 低者是券后/活动价。这是确定性规则，不是猜：必须同时满足「只有一个无标记价」且「低于原价」。
  const unmarkedMentions = mentions.filter(item => item.role === "unknown");
  const distinctUnmarked = [...new Set(unmarkedMentions.map(item => item.value))];
  if (listMentions.length > 0 && distinctUnmarked.length === 1) {
    const candidate = distinctUnmarked[0];
    const listMax = Math.max(...listMentions.map(item => item.value));
    if (candidate < listMax) {
      const mention = unmarkedMentions.find(item => item.value === candidate) || null;
      if (!isGiveawayContext(text, mention)) {
        return {
          ...base,
          finalPrice: candidate,
          finalBuyPrice: candidate,
          priceStatus: "parsed",
          detail: { ...detail, method: "below_list_price" }
        };
      }
    }
  }

  return {
    ...base,
    finalPrice: null,
    finalBuyPrice: null,
    priceStatus: "manual_review",
    detail: { ...detail, method: "ambiguous_multiple_prices" }
  };
};

/** 平台识别：只做确定性映射，识别不出就用原始来源名。 */
export const inferPlatform = (text: string, originSource: string): string | null => {
  const normalized = String(text ?? "");
  const rules: Array<[RegExp, string]> = [
    [/京东|jd\.com|自营|plus会员/i, "京东"],
    [/淘宝|天猫|tmall|淘口令/i, "淘宝天猫"],
    [/拼多多|pdd|百亿补贴/i, "拼多多"],
    [/抖音|douyin/i, "抖音"],
    [/美团|饿了么|外卖/i, "本地生活"],
    [/苏宁|唯品会|得物|小红书/i, "其它电商"]
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(normalized)) return label;
  }
  return originSource && originSource !== "未知" ? originSource : null;
};
