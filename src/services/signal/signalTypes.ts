/**
 * 线报采集层的共享类型与抓取工具。
 *
 * 新增第四个源时只需要实现 SignalAdapter，核心业务逻辑（入库/去重/匹配/利润）不用改。
 */

export interface CollectedSignal {
  collectorSource: string;
  originSource: string;
  externalId: string | null;
  title: string;
  content: string;
  url: string | null;
  /** 原始来源发布时间（详情页能拿到精确值就用精确值）。 */
  publishedAt: string | null;
  collectedAt: string;
  /** 原始 JSON / HTML 片段，必须保留，方便以后重解析。 */
  rawData: string;
  /** 源站自己给出的价格字段（若有），仅作解析兜底，不作为唯一依据。 */
  sourcePrice?: number | null;
  /** Adapter 从自己的 HTML 字段里抽出的真实外链，优先级高于文本兜底扫描。 */
  dealUrl?: string | null;
  platform?: string | null;
}

export interface FetchLatestOptions {
  /** 已经入库过的 external_id，用于增量抓详情页，避免重复请求。 */
  knownExternalIds?: Set<string>;
  /** 单次最多补几个详情页。 */
  maxDetailFetches?: number;
  /** 每次请求前的节流回调（由调度器注入，保证不低于官方最短间隔）。 */
  beforeRequest?: () => Promise<void>;
  signal?: AbortSignal;
}

export interface SignalAdapter {
  sourceKey: string;
  sourceName: string;
  collectorSource: string;
  baseUrl: string;
  fetchLatest(options?: FetchLatestOptions): Promise<CollectedSignal[]>;
}

export const DEFAULT_USER_AGENT = "price-dashboard-signal-collector/1.0 (+internal experiment; low frequency)";

export interface HttpGetResult {
  ok: boolean;
  status: number;
  body: string;
  url: string;
  error?: string;
}

/**
 * 单次 GET，带超时、UA、referer。
 * 不重试、不绕限制——重试与退避由调度器统一负责。
 */
export const httpGet = async (
  url: string,
  options: { timeoutMs?: number; headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<HttpGetResult> => {
  const timeoutMs = options.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Accept: "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        ...options.headers
      }
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body, url: response.url || url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, body: "", url, error: message };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
};

/** 解析 "10-07 19:13" / "2026-10-07T19:13:51+08:00" 这类时间，无年份时按当前年份补全。 */
export const parseLooseDateTime = (value: unknown, now: Date = new Date()): string | null => {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const withYear = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日]?[T\s]*(\d{1,2})?:?(\d{2})?:?(\d{2})?/);
  if (withYear) {
    const [, year, month, day, hour = "0", minute = "0", second = "0"] = withYear;
    return formatLocalDateTime(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second));
  }

  const withoutYear = text.match(/(\d{1,2})[-/月](\d{1,2})[日]?[T\s]*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (withoutYear) {
    const [, month, day, hour, minute, second = "0"] = withoutYear;
    return formatLocalDateTime(now.getFullYear(), Number(month), Number(day), Number(hour), Number(minute), Number(second));
  }

  return null;
};

const formatLocalDateTime = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): string | null => {
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`;
};

/** raw_data 落库前截断，避免一条详情页把库撑爆。 */
export const truncateRawData = (value: string, limit = 20000): string => (
  value.length > limit ? `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]` : value
);

/** 去掉标签、压缩空白，用于把 HTML 片段存成可读文本。 */
export const stripTags = (value: string): string => value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
