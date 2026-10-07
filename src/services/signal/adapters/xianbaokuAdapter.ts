import { extractDealUrlFromHtml } from "../signalText";
import {
  httpGet,
  truncateRawData,
  type CollectedSignal,
  type FetchLatestOptions,
  type SignalAdapter
} from "../signalTypes";

/**
 * Source 1：线报酷（优先级 S）。
 *
 * 只用官方公开 JSON 接口：
 *   总接口     /plus/json/push.json
 *   分类接口   /plus/json/push_<cateid>.json
 * 官方限制最快 5 秒一次，所以分类接口按轮转逐个抓，绝不并发轰炸。
 */

export const XIANBAOKU_SOURCE_KEY = "xianbaoku";
export const XIANBAOKU_BASE_URL = "https://new.ixbk.net";

/** 重点分类：赚客吧 / 新赚吧 / 微博 / 小嘀咕 / 好单线报 / 值得买 / 豆瓣线报 / 线报酷。 */
export const XIANBAOKU_CATEGORY_ENDPOINTS: Array<{ cateId: string; label: string }> = [
  { cateId: "16", label: "赚客吧" },
  { cateId: "18", label: "新赚吧" },
  { cateId: "10", label: "微博" },
  { cateId: "11", label: "小嘀咕" },
  { cateId: "30", label: "好单线报" },
  { cateId: "19", label: "值得买" },
  { cateId: "23", label: "豆瓣线报" },
  { cateId: "26", label: "线报酷" }
];

/**
 * catename 形如「好单线报-日用-京东」「微博-数码」，第一段才是原始来源。
 * 映射到实验约定的 origin_source 词表。
 */
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

export const resolveOriginSource = (cateName: unknown): string => {
  const text = String(cateName ?? "").trim();
  if (!text) return "未知";
  for (const [pattern, label] of ORIGIN_ALIASES) {
    if (pattern.test(text)) return label;
  }
  const first = text.split(/[-—|/]/)[0].trim();
  return first || "未知";
};

interface XianbaokuItem {
  id?: number | string;
  title?: string;
  content?: string;
  content_html?: string;
  datetime?: string;
  shorttime?: string;
  shijianchuo?: number;
  cateid?: string | number;
  catename?: string;
  price?: number | string | null;
  url?: string;
  louzhu?: string;
}

const buildPublishedAt = (item: XianbaokuItem): string | null => {
  const timestamp = Number(item.shijianchuo);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    // 线报酷的 shijianchuo 是秒级时间戳。
    const millis = timestamp > 1e12 ? timestamp : timestamp * 1000;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) {
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}+08:00`;
    }
  }
  const date = String(item.datetime ?? "").trim();
  const time = String(item.shorttime ?? "").trim() || "00:00";
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return `${date}T${/^\d{1,2}:\d{2}$/.test(time) ? `${time.padStart(5, "0")}:00` : "00:00:00"}+08:00`;
  }
  return null;
};

export const parseXianbaokuPayload = (
  payloadText: string,
  options: { collectedAt: string; endpointLabel?: string } = { collectedAt: new Date().toISOString() }
): CollectedSignal[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed as XianbaokuItem[] : [];
  const signals: CollectedSignal[] = [];

  for (const item of items) {
    const title = String(item.title ?? "").trim();
    if (!title) continue;
    const externalId = item.id === undefined || item.id === null ? null : String(item.id);
    const rawUrl = String(item.url ?? "").trim();
    const price = Number(item.price);

    signals.push({
      collectorSource: XIANBAOKU_SOURCE_KEY,
      originSource: resolveOriginSource(item.catename ?? options.endpointLabel),
      externalId,
      title,
      content: String(item.content ?? "").trim(),
      url: rawUrl ? (rawUrl.startsWith("http") ? rawUrl : `${XIANBAOKU_BASE_URL}${rawUrl}`) : null,
      publishedAt: buildPublishedAt(item),
      collectedAt: options.collectedAt,
      rawData: truncateRawData(JSON.stringify(item)),
      sourcePrice: Number.isFinite(price) && price > 0 ? price : null,
      dealUrl: extractDealUrlFromHtml(item.content_html),
      platform: null
    });
  }

  return signals;
};

export const createXianbaokuAdapter = (options: { categoryRotation?: number } = {}): SignalAdapter => {
  let rotation = Number.isFinite(options.categoryRotation) ? Number(options.categoryRotation) : 0;

  return {
    sourceKey: XIANBAOKU_SOURCE_KEY,
    sourceName: "线报酷",
    collectorSource: XIANBAOKU_SOURCE_KEY,
    baseUrl: XIANBAOKU_BASE_URL,
    async fetchLatest(fetchOptions: FetchLatestOptions = {}): Promise<CollectedSignal[]> {
      const collectedAt = new Date().toISOString();
      const endpoints: Array<{ path: string; label?: string }> = [{ path: "/plus/json/push.json" }];
      if (XIANBAOKU_CATEGORY_ENDPOINTS.length > 0) {
        const category = XIANBAOKU_CATEGORY_ENDPOINTS[rotation % XIANBAOKU_CATEGORY_ENDPOINTS.length];
        endpoints.push({ path: `/plus/json/push_${category.cateId}.json`, label: category.label });
        rotation += 1;
      }

      const collected: CollectedSignal[] = [];
      const failures: string[] = [];
      let successCount = 0;

      for (const endpoint of endpoints) {
        try {
          await fetchOptions.beforeRequest?.();
          const response = await httpGet(`${XIANBAOKU_BASE_URL}${endpoint.path}`, {
            headers: { Referer: `${XIANBAOKU_BASE_URL}/` },
            signal: fetchOptions.signal
          });
          if (!response.ok) {
            failures.push(`${endpoint.path} HTTP ${response.status}${response.error ? ` ${response.error}` : ""}`);
            continue;
          }
          successCount += 1;
          collected.push(...parseXianbaokuPayload(response.body, { collectedAt, endpointLabel: endpoint.label }));
        } catch (error) {
          failures.push(`${endpoint.path} ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 部分接口失败不算整源失败：已经拿到的数据照常入库，失败详情交给调度器记错误。
      if (successCount === 0) {
        throw new Error(`线报酷接口全部失败：${failures.join("；")}`);
      }
      if (failures.length > 0) {
        console.warn(`[signal] 线报酷部分接口失败（已保留成功数据）：${failures.join("；")}`);
      }

      return collected;
    }
  };
};
