import {
  httpGet,
  parseLooseDateTime,
  truncateRawData,
  type CollectedSignal,
  type FetchLatestOptions,
  type SignalAdapter
} from "../signalTypes";
import { extractDealUrlFromHtml, htmlToText } from "../signalText";

/**
 * Source 2：86实时线报（优先级 S）。
 *
 * 只用公开页面：列表页 → 增量抓详情页补正文与精确发布时间。
 * 详情页里 og / JSON-LD Article 字段是结构化元数据，比猜 CSS 选择器稳。
 * 不登录、不绕验证码、不调用任何非公开接口。
 */

export const XB86_SOURCE_KEY = "xb86";
export const XB86_BASE_URL = "https://v.jiujiuxb.com";

const ORIGIN_ALIASES: Array<[RegExp, string]> = [
  [/赚客吧/, "赚客吧"],
  [/新赚吧/, "新赚吧"],
  [/微博/, "微博"],
  [/小嘀咕/, "小嘀咕"],
  [/好单/, "好单"],
  [/值得买|smzdm/i, "值得买"],
  [/葫芦侠/, "葫芦侠"],
  [/豆瓣/, "豆瓣"],
  [/线报酷/, "线报酷"],
  [/86/, "86api"]
];

export const resolveXb86Origin = (altText: unknown): string => {
  const text = htmlToText(String(altText ?? "")).replace(/线报$/, "").trim();
  if (!text) return "未知";
  for (const [pattern, label] of ORIGIN_ALIASES) {
    if (pattern.test(text)) return label;
  }
  return text || "未知";
};

const decodeEntities = (value: string): string => htmlToText(value).replace(/\s+/g, " ").trim();

export interface Xb86ListItem {
  externalId: string;
  title: string;
  url: string;
  originSource: string;
  publishedAt: string | null;
  pinned: boolean;
}

export const parseXb86List = (html: string, now: Date = new Date()): Xb86ListItem[] => {
  const items: Xb86ListItem[] = [];
  // 只按条目外层容器切块：不能写成 item[^"]*，否则 <div class="item-right"> 也会被当成分隔符，
  // 结果就是每条都拿不到发布时间。
  const blocks = html.split(/<div class="item(?:\s[^"]*)?">/i).slice(1);

  for (const block of blocks) {
    const linkMatch = block.match(/<a href="([^"]*\/item\/(\d+)\.html)"[^>]*class="item-title"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const [, url, externalId, rawTitle] = linkMatch;
    const title = decodeEntities(rawTitle);
    if (!title) continue;

    const iconMatch = block.match(/<img[^>]*class="cate-icon"[^>]*alt="([^"]*)"/i);
    const timeMatch = block.match(/<div class="item-right">[\s\S]*?<span>([^<]+)<\/span>/i);

    items.push({
      externalId,
      title,
      url,
      originSource: iconMatch ? resolveXb86Origin(iconMatch[1]) : "未知",
      publishedAt: timeMatch ? parseLooseDateTime(timeMatch[1], now) : null,
      pinned: /badge-top|item-top/i.test(block)
    });
  }

  return items;
};

export interface Xb86Detail {
  title: string | null;
  content: string;
  originSource: string;
  publishedAt: string | null;
}

const firstJsonLdArticle = (html: string): Record<string, unknown> | null => {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        if (candidate && typeof candidate === "object" && (candidate as Record<string, unknown>)["@type"] === "Article") {
          return candidate as Record<string, unknown>;
        }
      }
    } catch {
      // 单个 JSON-LD 坏掉不影响其它字段解析
    }
  }
  return null;
};

const metaContent = (html: string, property: string): string | null => {
  const pattern = new RegExp(`<meta[^>]*(?:property|name)="${property}"[^>]*content="([^"]*)"`, "i");
  const match = html.match(pattern);
  return match ? htmlToText(match[1]).trim() : null;
};

export const parseXb86Detail = (html: string, now: Date = new Date()): Xb86Detail => {
  const article = firstJsonLdArticle(html);
  const iconMatch = html.match(/<img[^>]*class="cate-icon"[^>]*alt="([^"]*)"/i);
  const timeTextMatch = html.match(/🕐\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/);

  const description = (article?.description as string | undefined)
    || metaContent(html, "og:description")
    || metaContent(html, "description")
    || "";

  const publishedRaw = (article?.datePublished as string | undefined)
    || (timeTextMatch ? timeTextMatch[1] : null)
    || metaContent(html, "og:article:published_time");

  return {
    title: (article?.headline as string | undefined) || metaContent(html, "og:title"),
    content: htmlToText(description).trim(),
    originSource: iconMatch ? resolveXb86Origin(iconMatch[1]) : "未知",
    publishedAt: publishedRaw ? parseLooseDateTime(publishedRaw, now) : null
  };
};

export const createXb86Adapter = (): SignalAdapter => ({
  sourceKey: XB86_SOURCE_KEY,
  sourceName: "86实时线报",
  collectorSource: XB86_SOURCE_KEY,
  baseUrl: XB86_BASE_URL,
  async fetchLatest(fetchOptions: FetchLatestOptions = {}): Promise<CollectedSignal[]> {
    const collectedAt = new Date().toISOString();
    const now = new Date();

    await fetchOptions.beforeRequest?.();
    const listResponse = await httpGet(`${XB86_BASE_URL}/`, {
      headers: { Referer: `${XB86_BASE_URL}/` },
      signal: fetchOptions.signal
    });
    if (!listResponse.ok) {
      throw new Error(`86列表页抓取失败：HTTP ${listResponse.status}${listResponse.error ? ` ${listResponse.error}` : ""}`);
    }

    const listItems = parseXb86List(listResponse.body, now).filter(item => !item.pinned);
    const known = fetchOptions.knownExternalIds ?? new Set<string>();
    const maxDetail = fetchOptions.maxDetailFetches ?? 5;

    const signals: CollectedSignal[] = [];
    let detailFetches = 0;

    for (const item of listItems) {
      let content = "";
      let publishedAt = item.publishedAt;
      let originSource = item.originSource;
      let rawDetail = "";
      let dealUrl: string | null = null;

      const shouldEnrich = !known.has(item.externalId) && detailFetches < maxDetail;
      if (shouldEnrich) {
        detailFetches += 1;
        await fetchOptions.beforeRequest?.();
        const detailResponse = await httpGet(item.url, {
          headers: { Referer: `${XB86_BASE_URL}/` },
          signal: fetchOptions.signal
        });
        if (detailResponse.ok) {
          const detail = parseXb86Detail(detailResponse.body, now);
          content = detail.content;
          publishedAt = detail.publishedAt || publishedAt;
          originSource = detail.originSource !== "未知" ? detail.originSource : originSource;
          dealUrl = extractDealUrlFromHtml(detailResponse.body);
          rawDetail = truncateRawData(detailResponse.body, 8000);
        }
      }

      signals.push({
        collectorSource: XB86_SOURCE_KEY,
        originSource,
        externalId: item.externalId,
        title: item.title,
        content,
        url: item.url,
        publishedAt,
        collectedAt,
        rawData: truncateRawData(JSON.stringify({
          list: { title: item.title, url: item.url, published_at: item.publishedAt, origin_source: item.originSource },
          detail_html: rawDetail || null
        })),
        dealUrl,
        platform: null
      });
    }

    return signals;
  }
});
