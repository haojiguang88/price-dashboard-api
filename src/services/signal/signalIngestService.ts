import getDb from "../../config/database";
import {
  buildDedupeKeys,
  extractDealUrl,
  productPriceHashOf
} from "./signalText";
import { extractSignalPrice, inferPlatform } from "./signalPrice";
import { analyzeNormalizedSignals } from "./signalAnalysisService";
import type { CollectedSignal } from "./signalTypes";

/**
 * 采集结果入库：raw_signal 保留原始数据，normalized_signal 做跨采集器合并。
 *
 * 关键点：
 * - raw_signal 按 (source_key, dedupe_key) 唯一：同一条线报被轮询抓到 N 次只累加 seen_count，
 *   不会把库撑爆，但原始 JSON/HTML 一定留着，方便以后重解析。
 * - normalized_signal 按 dedupe_hash 唯一：三个采集器看到同一条车时合并成一条事件，
 *   记录 source_count / collectors / 首次发现者与时间，服务「这个信息最早出现在哪」。
 * - 这一层只做「采集 → 归一 → 价格提取」，SKU 匹配与回收价在后续阶段回填。
 */

export interface IngestSummary {
  collected: number;
  rawInserted: number;
  rawUpdated: number;
  normalizedInserted: number;
  normalizedMerged: number;
  /** 正文缺失、需要下一轮补详情页的条数。 */
  partial: number;
  crossSourceMatches: number;
  /** 本次触发重新分析的归一线报数，以及落到的利润状态分布。 */
  analyzed: number;
  profit_status: Record<string, number>;
}

interface Observation {
  collector: string;
  collected_at: string;
  published_at: string | null;
  external_id: string | null;
  url: string | null;
  title: string;
}

const parseJsonArray = <T>(value: unknown, fallback: T[]): T[] => {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
};

export const ingestCollectedSignals = async (
  signals: CollectedSignal[],
  options: { sourceId?: number } = {}
): Promise<IngestSummary> => {
  const db = await getDb();
  const summary: IngestSummary = {
    collected: signals.length,
    rawInserted: 0,
    rawUpdated: 0,
    normalizedInserted: 0,
    normalizedMerged: 0,
    partial: 0,
    crossSourceMatches: 0,
    analyzed: 0,
    profit_status: {}
  };
  if (signals.length === 0) return summary;

  const now = new Date().toISOString();
  const touchedNormalizedIds: number[] = [];

  for (const signal of signals) {
    const sourceRow = await db.get(
      "SELECT id FROM signal_source WHERE source_key = ?",
      [signal.collectorSource]
    );
    const sourceId = options.sourceId ?? sourceRow?.id ?? null;
    if (!sourceId) continue;

    const dealUrl = signal.dealUrl ?? extractDealUrl(signal.content, signal.rawData, signal.url);
    const dedupe = buildDedupeKeys({
      sourceKey: signal.collectorSource,
      externalId: signal.externalId,
      url: signal.url,
      dealUrl,
      title: signal.title,
      content: signal.content
    });

    const price = extractSignalPrice(signal.title, signal.content);
    const finalPrice = price.finalBuyPrice ?? signal.sourcePrice ?? null;
    const priceStatus = price.finalBuyPrice !== null
      ? price.priceStatus
      : (signal.sourcePrice ? "parsed" : price.priceStatus);

    const hasBody = Boolean(String(signal.content ?? "").trim());
    const status = hasBody && signal.publishedAt ? "ingested" : "partial";
    if (status === "partial") summary.partial += 1;

    const existingRaw = await db.get(
      "SELECT id, seen_count, content, published_at FROM raw_signal WHERE source_key = ? AND dedupe_key = ?",
      [signal.collectorSource, dedupe.sourceDedupeKey]
    );

    let rawId: number;
    if (existingRaw) {
      // 重复看到：只累加 seen_count 与 last_collected_at；若这次补到了正文/时间就补写。
      const nextContent = hasBody && !String(existingRaw.content ?? "").trim() ? signal.content : existingRaw.content;
      const nextPublished = signal.publishedAt || existingRaw.published_at || null;
      await db.run(
        `UPDATE raw_signal
            SET last_collected_at = ?, seen_count = seen_count + 1, status = ?,
                content = ?, published_at = ?, raw_data = ?, updated_at = ?
          WHERE id = ?`,
        [signal.collectedAt || now, hasBody ? "ingested" : "partial", nextContent, nextPublished, signal.rawData, now, existingRaw.id]
      );
      rawId = Number(existingRaw.id);
      summary.rawUpdated += 1;
    } else {
      const insert = await db.run(
        `INSERT INTO raw_signal
           (source_id, source_key, collector_source, origin_source, external_id, title, content, url,
            published_at, first_collected_at, last_collected_at, seen_count, raw_data,
            content_hash, normalized_hash, dedupe_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sourceId,
          signal.collectorSource,
          signal.collectorSource,
          signal.originSource || "未知",
          signal.externalId,
          signal.title,
          signal.content,
          signal.url,
          signal.publishedAt,
          signal.collectedAt || now,
          signal.collectedAt || now,
          signal.rawData,
          dedupe.contentHash,
          dedupe.normalizedHash,
          dedupe.sourceDedupeKey,
          status,
          now,
          now
        ]
      );
      rawId = Number(insert.lastID);
      summary.rawInserted += 1;
    }

    const productPriceHash = productPriceHashOf(null, finalPrice, signal.publishedAt);
    const existingNormalized = await db.get(
      "SELECT id, source_count, collectors_json, observations_json, origin_source FROM normalized_signal WHERE dedupe_hash = ?",
      [dedupe.crossSourceDedupeHash]
    );

    if (!existingNormalized) {
      const observation: Observation = {
        collector: signal.collectorSource,
        collected_at: signal.collectedAt || now,
        published_at: signal.publishedAt,
        external_id: signal.externalId,
        url: signal.url,
        title: signal.title
      };
      const normalizedInsert = await db.run(
        `INSERT INTO normalized_signal
           (raw_signal_id, dedupe_hash, origin_source, title, content, url, deal_url, published_at,
            first_seen_at, last_seen_at, first_seen_source, source_count, collectors_json, observations_json,
            content_hash, normalized_hash, product_price_hash, platform, raw_price_text, price_status,
            final_price, final_buy_price, quantity, price_detail_json, review_status, profit_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'UNMATCHED', ?, ?)`,
        [
          rawId,
          dedupe.crossSourceDedupeHash,
          signal.originSource || "未知",
          signal.title,
          signal.content,
          signal.url,
          dedupe.dealUrl,
          signal.publishedAt,
          signal.collectedAt || now,
          signal.collectedAt || now,
          signal.collectorSource,
          JSON.stringify([signal.collectorSource]),
          JSON.stringify([observation]),
          dedupe.contentHash,
          dedupe.normalizedHash,
          productPriceHash,
          inferPlatform(`${signal.title} ${signal.content}`, signal.originSource),
          price.rawPriceText,
          priceStatus,
          price.finalPrice,
          finalPrice,
          price.quantity,
          JSON.stringify(price.detail),
          now,
          now
        ]
      );
      const normalizedId = Number(normalizedInsert.lastID);
      await db.run("UPDATE raw_signal SET normalized_signal_id = ? WHERE id = ?", [normalizedId, rawId]);
      touchedNormalizedIds.push(normalizedId);
      summary.normalizedInserted += 1;
      continue;
    }

    // 已知事件：可能是同一个采集器再次看到，也可能是另一个采集器也看到了它。
    const collectors = parseJsonArray<string>(existingNormalized.collectors_json, []);
    const observations = parseJsonArray<Observation>(existingNormalized.observations_json, []);
    const isNewCollector = !collectors.includes(signal.collectorSource);

    if (isNewCollector) {
      collectors.push(signal.collectorSource);
      observations.push({
        collector: signal.collectorSource,
        collected_at: signal.collectedAt || now,
        published_at: signal.publishedAt,
        external_id: signal.externalId,
        url: signal.url,
        title: signal.title
      });
      summary.crossSourceMatches += 1;
    }

    // 首次发现者与最早发布时间：published_at 更早的采集器更能说明「这个信息最早出现在哪」。
    // first_seen_source / first_seen_at 只在插入时写定，合并时不动，保证它是真正的首次。
    await db.run(
      `UPDATE normalized_signal
          SET source_count = ?, collectors_json = ?, observations_json = ?,
              last_seen_at = ?, updated_at = ?,
              content = CASE WHEN COALESCE(content, '') = '' THEN ? ELSE content END,
              url = COALESCE(url, ?), deal_url = COALESCE(deal_url, ?),
              published_at = CASE WHEN published_at IS NULL OR published_at > ? THEN ? ELSE published_at END,
              raw_price_text = CASE WHEN COALESCE(raw_price_text, '') = '' THEN ? ELSE raw_price_text END,
              price_status = CASE WHEN COALESCE(price_status, 'unparsed') = 'unparsed' THEN ? ELSE price_status END,
              final_price = COALESCE(final_price, ?), final_buy_price = COALESCE(final_buy_price, ?),
              product_price_hash = COALESCE(product_price_hash, ?)
        WHERE id = ?`,
      [
        collectors.length,
        JSON.stringify(collectors),
        JSON.stringify(observations),
        signal.collectedAt || now,
        now,
        signal.content,
        signal.url,
        dedupe.dealUrl,
        signal.publishedAt,
        signal.publishedAt,
        price.rawPriceText,
        priceStatus,
        price.finalPrice,
        finalPrice,
        productPriceHash,
        existingNormalized.id
      ]
    );
    await db.run("UPDATE raw_signal SET normalized_signal_id = ? WHERE id = ?", [existingNormalized.id, rawId]);
    touchedNormalizedIds.push(Number(existingNormalized.id));
    summary.normalizedMerged += 1;
  }

  // 入库后立刻跑匹配与理论空间，保证审核页看到的就是最新结论。
  if (touchedNormalizedIds.length > 0) {
    const analysis = await analyzeNormalizedSignals({ ids: touchedNormalizedIds });
    summary.analyzed = analysis.analyzed;
    summary.profit_status = analysis.by_status;
  }

  return summary;
};

/** 仍缺正文/发布时间、需要下一轮补详情页的源内 ID。 */
export const loadPendingEnrichmentIds = async (sourceKey: string): Promise<Set<string>> => {
  const db = await getDb();
  const rows = await db.all(
    `SELECT external_id FROM raw_signal
      WHERE source_key = ? AND status = 'partial' AND external_id IS NOT NULL`,
    [sourceKey]
  );
  return new Set(rows.map((row: { external_id: string }) => String(row.external_id)));
};

/** 已经完整入库的源内 ID，用于增量抓取时跳过详情页。 */
export const loadCompleteIds = async (sourceKey: string): Promise<Set<string>> => {
  const db = await getDb();
  const rows = await db.all(
    `SELECT external_id FROM raw_signal
      WHERE source_key = ? AND status = 'ingested' AND external_id IS NOT NULL`,
    [sourceKey]
  );
  return new Set(rows.map((row: { external_id: string }) => String(row.external_id)));
};
