import { createHash } from "node:crypto";

/**
 * 线报文本归一化与去重哈希。
 *
 * 三层哈希（对应实验要求的三个层次）：
 *   content_hash       原始标题+正文，仅去多余空白，用于「完全同一条」判定
 *   normalized_hash    再抹掉全角/大小写/标点/表情/营销噪声，用于「几乎同一条」判定
 *   product_price_hash SKU + 到手价 + 时间窗，SKU 匹配之后才算，用于「同一件事的不同说法」
 *
 * 跨采集器合并键 dedupe_hash 单独一层：优先用正文里的外链（同一个京东短链就是同一个车），
 * 没有外链才退回 normalized_hash。
 */

export const sha1 = (value: string): string => createHash("sha1").update(value).digest("hex");

/** 全角转半角，只处理 ASCII 可见区，避免动到中文。 */
const toHalfWidth = (value: string): string => value.replace(/[\uFF01-\uFF5E]/g, char => (
  String.fromCharCode(char.charCodeAt(0) - 0xfee0)
)).replace(/\u3000/g, " ");

export const collapseWhitespace = (value: unknown): string => String(value ?? "")
  .replace(/\r\n?/g, "\n")
  .replace(/[ \t\u00a0]+/g, " ")
  .replace(/\n{2,}/g, "\n")
  .trim();

/** 去掉 HTML 标签，保留文本；<br> 转成换行，链接保留其 href。 */
export const htmlToText = (value: unknown): string => String(value ?? "")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(p|div|li|tr)>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, "\"")
  .replace(/&#39;/gi, "'");

const EMOJI_AND_SYMBOLS = /[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3\uE000-\uF8FF]/g;

/**
 * 归一化文本：抹掉大小写、全角、标点、表情和常见营销噪声。
 * 故意不删数字和商品词，避免把不同价格的线报误判成同一条。
 */
export const normalizeSignalText = (value: unknown): string => collapseWhitespace(toHalfWidth(htmlToText(value)))
  .toLowerCase()
  .replace(EMOJI_AND_SYMBOLS, "")
  .replace(/[\s]+/g, "")
  .replace(/[，。、；：！？~～…·•\-—_+*/\\|"'“”‘’（）()【】\[\]{}<>《》]/g, "")
  .replace(/(到手价|到手|券后|券前|原价|活动价|折后|包邮|限购|线报|快撸|手慢无)/g, "");

export const contentHashOf = (title: unknown, content: unknown): string => (
  sha1([collapseWhitespace(title), collapseWhitespace(content)].filter(Boolean).join("\n"))
);

export const normalizedHashOf = (title: unknown, content: unknown): string => (
  sha1([normalizeSignalText(title), normalizeSignalText(content)].filter(Boolean).join("\n"))
);

export const productPriceHashOf = (sku: unknown, finalPrice: unknown, publishedAt: unknown): string | null => {
  const skuKey = String(sku ?? "").trim();
  const price = Number(finalPrice);
  if (!skuKey || !Number.isFinite(price) || price <= 0) return null;
  const day = String(publishedAt ?? "").slice(0, 10);
  return sha1(`${skuKey}|${price.toFixed(2)}|${day}`);
};

/** 详情页/短链之外的自有域名，用于识别「同一条线报的外链」。 */
const NON_DEAL_HOSTS = [
  "ixbk.net", "jiujiuxb.com", "zuankeba.cn", "360buyimg.com", "jd.com/ads",
  "weibo.com", "weibo.cn", "t.cn", "qq.com", "weixin.qq.com"
];

const isDealUrl = (url: string): boolean => {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !NON_DEAL_HOSTS.some(blocked => host === blocked || host.endsWith(`.${blocked}`));
  } catch {
    return false;
  }
};

/** 清理 URL 候选：去 JSON 转义残留、HTML 实体和尾部标点。 */
export const cleanUrlCandidate = (value: unknown): string => String(value ?? "")
  .replace(/\\+$/, "")
  .replace(/\\\//g, "/")
  // 源站自己就转义过一层（&amp;amp;），所以解两遍
  .replace(/&amp;/gi, "&")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, "\"")
  .replace(/&#39;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/[.,;。，、）)】\]"'<>]+$/, "")
  .trim();

/**
 * 从正文/HTML 里抽出「这个车指向哪」的外链，作为跨采集器合并键的第一顺位。
 * 同一批聚合站转发同一条线报时，京东短链/淘口令落地页通常完全一致。
 */
export const extractDealUrl = (content: unknown, contentHtml: unknown, fallbackUrl: unknown): string | null => {
  const haystack = [String(contentHtml ?? ""), String(content ?? "")].join("\n");
  const candidates: string[] = [];

  for (const match of haystack.matchAll(/href=["']([^"']+)["']/gi)) {
    candidates.push(match[1]);
  }
  for (const match of haystack.matchAll(/https?:\/\/[^\s"'<>）)】\\]+/gi)) {
    candidates.push(match[0]);
  }

  const cleaned = candidates
    .map(cleanUrlCandidate)
    .filter(isDealUrl);

  if (cleaned.length > 0) return cleaned[0];

  const fallback = cleanUrlCandidate(fallbackUrl);
  return isDealUrl(fallback) ? fallback : null;
};

/** Adapter 专用：直接从自己的原始 HTML 字段里取第一个真实 href，避开 JSON 转义。 */
export const extractDealUrlFromHtml = (html: unknown): string | null => {
  const text = String(html ?? "");
  if (!text) return null;
  for (const match of text.matchAll(/href=["']([^"']+)["']/gi)) {
    const candidate = cleanUrlCandidate(match[1]);
    if (isDealUrl(candidate)) return candidate;
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>）)】\\]+/gi)) {
    const candidate = cleanUrlCandidate(match[0]);
    if (isDealUrl(candidate)) return candidate;
  }
  return null;
};

/**
 * URL 归一化：去掉协议、www、跟踪参数和末尾斜杠，避免同一条详情页被判成两条。
 */
export const normalizeUrl = (value: unknown): string => {
  const raw = cleanUrlCandidate(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const keep = new URLSearchParams();
    const dropKeys = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "spm", "from", "share_token", "t"]);
    url.searchParams.forEach((paramValue, key) => {
      if (!dropKeys.has(key.toLowerCase())) keep.append(key, paramValue);
    });
    const search = keep.toString();
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    return `${host}${path}${search ? `?${search}` : ""}`.toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
};

export interface SignalDedupeInput {
  sourceKey: string;
  externalId?: unknown;
  url?: unknown;
  dealUrl?: unknown;
  title: unknown;
  content: unknown;
}

export interface SignalDedupeResult {
  contentHash: string;
  normalizedHash: string;
  /** 采集器内去重键：同源同一条只保留一行。 */
  sourceDedupeKey: string;
  /** 跨采集器合并键：三个源看到同一条线报时归一到同一个事件。 */
  crossSourceDedupeHash: string;
  dealUrl: string | null;
}

export const buildDedupeKeys = (input: SignalDedupeInput): SignalDedupeResult => {
  const contentHash = contentHashOf(input.title, input.content);
  const normalizedHash = normalizedHashOf(input.title, input.content);
  const dealUrl = normalizeUrl(input.dealUrl) || null;

  const externalId = String(input.externalId ?? "").trim();
  const normalizedPageUrl = normalizeUrl(input.url);

  // 源内：external_id 最可靠，其次详情页 URL，最后才用文本哈希。
  const sourceDedupeKey = externalId
    ? `ext:${externalId}`
    : normalizedPageUrl
      ? `url:${normalizedPageUrl}`
      : `hash:${normalizedHash}`;

  // 跨源：外链（同一个车）最可靠，其次归一化文本。
  const crossSourceDedupeHash = dealUrl ? `deal:${sha1(dealUrl)}` : `text:${normalizedHash}`;

  return { contentHash, normalizedHash, sourceDedupeKey, crossSourceDedupeHash, dealUrl };
};
