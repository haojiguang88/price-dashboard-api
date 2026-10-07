import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import getDb, { closeDatabase, getDatabasePath } from "../src/config/database";
import { runMigrations } from "../src/migrations";
import { ingestCollectedSignals } from "../src/services/signal/signalIngestService";
import { invalidateSkuDictionary } from "../src/services/signal/signalSkuMatcher";
import type { CollectedSignal } from "../src/services/signal/signalTypes";

const buildSignal = (overrides: Partial<CollectedSignal> = {}): CollectedSignal => ({
  collectorSource: "xb86",
  originSource: "好单",
  externalId: "900001",
  title: "某商品 99元",
  content: "某商品 99元，京东自营，戳 https://u.jd.com/abc123",
  url: "https://v.jiujiuxb.com/item/900001.html",
  publishedAt: "2026-10-07T19:13:51+08:00",
  collectedAt: new Date().toISOString(),
  rawData: "<html>detail</html>",
  ...overrides
});

test("原始记录状态按合并后的事实判定，本轮缺详情不能把已完整的行降级", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-signal-ingest-"));
  const filename = path.join(directory, "business.db");

  const previousEnv = {
    BUSINESS_DB_PATH: process.env.BUSINESS_DB_PATH,
    ALLOW_DB_CREATE: process.env.ALLOW_DB_CREATE,
    NODE_ENV: process.env.NODE_ENV
  };
  process.env.BUSINESS_DB_PATH = filename;
  process.env.ALLOW_DB_CREATE = "true";
  process.env.NODE_ENV = "development";
  invalidateSkuDictionary();

  try {
    const db = await getDb();
    assert.equal(getDatabasePath(), filename);
    await runMigrations(filename);

    // 第一轮：只有标题，没有正文 → partial
    const firstRound = await ingestCollectedSignals([buildSignal({ content: "" })]);
    assert.equal(firstRound.rawInserted, 1);
    assert.equal(firstRound.partial, 1, "缺正文应记为本轮待补");
    let row = await db.get("SELECT status, seen_count, COALESCE(content,'') content FROM raw_signal WHERE external_id = '900001'");
    assert.equal(row.status, "partial");
    assert.equal(row.seen_count, 1);

    // 第二轮：补到详情页 → ingested
    const secondRound = await ingestCollectedSignals([buildSignal()]);
    assert.equal(secondRound.rawUpdated, 1);
    assert.equal(secondRound.partial, 0);
    row = await db.get("SELECT status, seen_count, content FROM raw_signal WHERE external_id = '900001'");
    assert.equal(row.status, "ingested");
    assert.equal(row.seen_count, 2);
    assert.match(row.content, /京东自营/);

    // 第三轮：这一轮详情页配额用完了（载荷没有正文），库里仍是完整的，不能降级
    const thirdRound = await ingestCollectedSignals([buildSignal({ content: "" })]);
    assert.equal(thirdRound.rawUpdated, 1);
    assert.equal(thirdRound.partial, 0, "本轮没补到详情不代表这条不完整");
    row = await db.get("SELECT status, seen_count, content FROM raw_signal WHERE external_id = '900001'");
    assert.equal(row.status, "ingested", "已完整的原始记录不能被降级");
    assert.equal(row.seen_count, 3);
    assert.match(row.content, /京东自营/, "已抓到的正文必须保留");

    // 归一线报也保留正文，链接被抓成抢购链接
    const normalized = await db.get("SELECT content, deal_url FROM normalized_signal ORDER BY id DESC LIMIT 1");
    assert.match(String(normalized.content), /京东自营/);
    assert.equal(normalized.deal_url, "https://u.jd.com/abc123");

    // 合并键漂移不能重复建事件：先按 text: 建事件，补到外链后键变成 deal:，
    // 如果只按合并键查就会再建一条，旧的那条变成孤儿在审核台重复出现。
    const beforeCount = Number((await db.get("SELECT COUNT(*) n FROM normalized_signal")).n);
    await ingestCollectedSignals([buildSignal({
      externalId: "900002",
      title: "某商品 88元",
      content: "",
      url: "https://v.jiujiuxb.com/item/900002.html",
      rawData: "<html>list-only</html>"
    })]);
    const midCount = Number((await db.get("SELECT COUNT(*) n FROM normalized_signal")).n);
    assert.equal(midCount, beforeCount + 1);

    await ingestCollectedSignals([buildSignal({
      externalId: "900002",
      title: "某商品 88元",
      content: "某商品 88元 戳 https://u.jd.com/xyz789",
      url: "https://v.jiujiuxb.com/item/900002.html",
      rawData: "<html>detail</html>"
    })]);
    const afterCount = Number((await db.get("SELECT COUNT(*) n FROM normalized_signal")).n);
    assert.equal(afterCount, midCount, "合并键变化后不能重复建事件");

    const drifted = await db.get("SELECT dedupe_hash, deal_url, content FROM normalized_signal ORDER BY id DESC LIMIT 1");
    assert.match(String(drifted.dedupe_hash), /^deal:/, "合并键应更新为外链口径");
    assert.equal(drifted.deal_url, "https://u.jd.com/xyz789");
    assert.match(String(drifted.content), /88元/);

    // 每个归一事件都必须有原始记录指向它（没有孤儿的判定标准）
    const orphans = Number((await db.get(
      "SELECT COUNT(*) n FROM normalized_signal WHERE id NOT IN (SELECT normalized_signal_id FROM raw_signal WHERE normalized_signal_id IS NOT NULL)"
    )).n);
    assert.equal(orphans, 0);
  } finally {
    invalidateSkuDictionary();
    await closeDatabase();
    if (previousEnv.BUSINESS_DB_PATH === undefined) delete process.env.BUSINESS_DB_PATH;
    else process.env.BUSINESS_DB_PATH = previousEnv.BUSINESS_DB_PATH;
    if (previousEnv.ALLOW_DB_CREATE === undefined) delete process.env.ALLOW_DB_CREATE;
    else process.env.ALLOW_DB_CREATE = previousEnv.ALLOW_DB_CREATE;
    if (previousEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv.NODE_ENV;
    await rm(directory, { recursive: true, force: true });
  }
});
