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
 * Source 3：赚客吧（优先级 A）。
 *
 * 赚客吧自己就是聚合站（其推送服务页明确写「全网线报聚合」），
 * 所以 collector_source = zuankeba，而 origin_source 一律记「未知」：
 * 公开页面无法证明这条线报最初出自哪里，不能编。
 * 它的价值是第三个时间观察点 + 与线报酷 / 86 交叉验证同一条信息出现的先后。
 *
 * V1 只采公开首页（内嵌 JSON-LD ItemList）→ 增量抓详情页补正文与精确时间。
 */

export const ZUANKEBA_SOURCE_KEY = "zuankeba";
export const ZUANKEBA_BASE_URL = "https://www.zuankeba.cn";

export interface ZuankebaListItem {
  externalId: string;
  title: string;
  url: string;
}

const DETAIL_URL_PATTERN = /^https?:\/\/www\.zuankeba\.cn\/d\/([0-9a-f]+)\.html/i;

/** 首页内嵌的 JSON-LD ItemList 是「今日线报」清单，最稳的入口。 */
export const parseZuankebaHomepage = (html: string): ZuankebaListItem[] => {
  const items: ZuankebaListItem[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const list = parsed as { "@type"?: string; itemListElement?: Array<Record<string, unknown>> };
    if (list?.["@type"] !== "ItemList" || !Array.isArray(list.itemListElement)) continue;

    for (const element of list.itemListElement) {
      const url = String(element.url ?? "").trim();
      const title = htmlToText(String(element.name ?? "")).trim();
      const idMatch = url.match(DETAIL_URL_PATTERN);
      if (!idMatch || !title || seen.has(idMatch[1])) continue;
      seen.add(idMatch[1]);
      items.push({ externalId: idMatch[1], title, url });
    }
  }

  // 兜底：JSON-LD 结构变了就直接扫详情页链接。
  if (items.length === 0) {
    for (const match of html.matchAll(/href="(https?:\/\/www\.zuankeba\.cn\/d\/([0-9a-f]+)\.html)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const [, url, externalId, rawTitle] = match;
      const title = htmlToText(rawTitle).trim();
      if (!title || seen.has(externalId)) continue;
      seen.add(externalId);
      items.push({ externalId, title, url });
    }
  }

  return items;
};

export interface ZuankebaDetail {
  title: string | null;
  content: string;
  publishedAt: string | null;
}

const metaContent = (html: string, property: string): string | null => {
  const pattern = new RegExp(`<meta[^>]*(?:property|name)="${property}"[^>]*content="([^"]*)"`, "i");
  const match = html.match(pattern);
  return match ? htmlToText(match[1]).trim() : null;
};

/** 详情页的新闻类 JSON-LD，比 <h1> 可靠——页面顶部还有一个站点级 <h1>赚客吧</h1>。 */
const firstArticleJsonLd = (html: string): Record<string, unknown> | null => {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        const type = String((candidate as Record<string, unknown>)?.["@type"] ?? "");
        if (type === "NewsArticle" || type === "Article") return candidate as Record<string, unknown>;
      }
    } catch {
      // 坏掉的 JSON-LD 不影响其它字段
    }
  }
  return null;
};

export const parseZuankebaDetail = (html: string, now: Date = new Date()): ZuankebaDetail => {
  const article = firstArticleJsonLd(html);
  const proseMatch = html.match(/<div class="prose">([\s\S]*?)<\/div>/i);
  const timeMatch = html.match(/<time[^>]*datetime="([^"]+)"/i);
  const panelMatch = html.match(/<article[^>]*class="detail-panel"[^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i);

  const content = proseMatch
    ? htmlToText(proseMatch[1]).trim()
    : (metaContent(html, "og:description") || metaContent(html, "description") || "");

  const publishedRaw = (article?.datePublished as string | undefined)
    || timeMatch?.[1]
    || metaContent(html, "article:published_time");

  const headline = (article?.headline as string | undefined)
    || (panelMatch ? htmlToText(panelMatch[1]).trim() : "")
    || metaContent(html, "og:title")
    || null;

  return {
    title: headline ? headline.replace(/\s*-\s*赚客吧\s*$/, "").trim() : null,
    content,
    publishedAt: publishedRaw ? parseLooseDateTime(publishedRaw, now) : null
  };
};

export const createZuankebaAdapter = (): SignalAdapter => ({
  sourceKey: ZUANKEBA_SOURCE_KEY,
  sourceName: "赚客吧",
  collectorSource: ZUANKEBA_SOURCE_KEY,
  baseUrl: ZUANKEBA_BASE_URL,
  async fetchLatest(fetchOptions: FetchLatestOptions = {}): Promise<CollectedSignal[]> {
    const collectedAt = new Date().toISOString();
    const now = new Date();

    await fetchOptions.beforeRequest?.();
    const listResponse = await httpGet(`${ZUANKEBA_BASE_URL}/`, {
      headers: { Referer: `${ZUANKEBA_BASE_URL}/` },
      signal: fetchOptions.signal
    });
    if (!listResponse.ok) {
      throw new Error(`赚客吧首页抓取失败：HTTP ${listResponse.status}${listResponse.error ? ` ${listResponse.error}` : ""}`);
    }

    const listItems = parseZuankebaHomepage(listResponse.body);
    const known = fetchOptions.knownExternalIds ?? new Set<string>();
    const maxDetail = fetchOptions.maxDetailFetches ?? 5;

    const signals: CollectedSignal[] = [];
    let detailFetches = 0;

    for (const item of listItems) {
      let content = "";
      let publishedAt = null as string | null;
      let title = item.title;
      let rawDetail = "";
      let dealUrl: string | null = null;

      const shouldEnrich = !known.has(item.externalId) && detailFetches < maxDetail;
      if (shouldEnrich) {
        detailFetches += 1;
        await fetchOptions.beforeRequest?.();
        const detailResponse = await httpGet(item.url, {
          headers: { Referer: `${ZUANKEBA_BASE_URL}/` },
          signal: fetchOptions.signal
        });
        if (detailResponse.ok) {
          const detail = parseZuankebaDetail(detailResponse.body, now);
          content = detail.content;
          publishedAt = detail.publishedAt;
          title = detail.title || title;
          dealUrl = extractDealUrlFromHtml(detailResponse.body);
          rawDetail = truncateRawData(detailResponse.body, 8000);
        }
      }

      signals.push({
        collectorSource: ZUANKEBA_SOURCE_KEY,
        // 聚合站无法证明原始出处，按实验要求记「未知」，不做无依据推断。
        originSource: "未知",
        externalId: item.externalId,
        title,
        content,
        url: item.url,
        publishedAt,
        collectedAt,
        rawData: truncateRawData(JSON.stringify({
          list: { title: item.title, url: item.url },
          detail_html: rawDetail || null
        })),
        dealUrl,
        platform: null
      });
    }

    return signals;
  }
});
