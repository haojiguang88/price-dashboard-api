import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import signalRoutes from "../src/routes/signalRoutes";
import getDb, { closeDatabase, getDatabasePath } from "../src/config/database";
import { runMigrations } from "../src/migrations";
import { invalidateSkuDictionary } from "../src/services/signal/signalSkuMatcher";
import { analyzeNormalizedSignals } from "../src/services/signal/signalAnalysisService";

const seed = async (db: any) => {
  // 历史迁移已经种过一部分目录，所以统一用 OR IGNORE 再回查，避免撞唯一约束。
  await db.run("INSERT OR IGNORE INTO categories (name) VALUES ('游戏机')");
  const category = await db.get("SELECT id FROM categories WHERE name = '游戏机'");
  await db.run("INSERT OR IGNORE INTO objects (category_id, name) VALUES (?, 'PS5国行数字slim')", [category.id]);
  await db.run("INSERT OR IGNORE INTO categories (name) VALUES ('纪念币')");
  const coinCategory = await db.get("SELECT id FROM categories WHERE name = '纪念币'");
  await db.run("INSERT OR IGNORE INTO objects (category_id, name) VALUES (?, '龙银币')", [coinCategory.id]);

  await db.run(
    `INSERT INTO price_records (date, category, object_name, variant, price, source, created_at, updated_at)
     VALUES
       ('2026-10-06', '游戏机', 'PS5国行数字slim', '', 3100, '东旭游戏机档口', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
       ('2026-10-06', '纪念币', '龙银币', '', 520, '爱藏龙银币', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  );
};

const insertSignal = async (db: any, title: string, finalBuyPrice: number | null, overrides: Record<string, unknown> = {}) => {
  const result = await db.run(
    `INSERT INTO normalized_signal
       (dedupe_hash, origin_source, title, content, deal_url, published_at, first_seen_at, last_seen_at,
        first_seen_source, source_count, collectors_json, observations_json,
        content_hash, normalized_hash, price_status, final_buy_price, created_at, updated_at)
     VALUES (?, ?, ?, '', 'https://u.jd.com/x', '2026-10-07T10:00:00+08:00', '2026-10-07T10:00:00+08:00', '2026-10-07T10:00:00+08:00',
             'xianbaoku', 1, '["xianbaoku"]', '[]', 'c', 'n', 'parsed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [`hash-${Math.random().toString(16).slice(2)}`, overrides.originSource ?? "好单", title, finalBuyPrice]
  );
  return Number(result.lastID);
};

test("线报监控 API：列表 / 详情 / 审核 / 结果 / 失效 / 统计 / 阈值 / 采集源", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-signal-api-"));
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

  const app = express();
  app.use(express.json());
  app.use("/api/signal", signalRoutes);
  const server = app.listen(0, "127.0.0.1");
  const baseUrl = async () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const url = await baseUrl();

    const db = await getDb();
    assert.equal(getDatabasePath(), filename, "必须落在临时库上");
    await runMigrations(filename);
    await seed(db);

    const highValueId = await insertSignal(db, "PS5国行数字slim 到手2900元", 2900);
    const profitableId = await insertSignal(db, "龙银币 封装 460元", 460);
    await insertSignal(db, "蒙牛纯牛奶 39.9元", 39.9);
    await analyzeNormalizedSignals({ db, ids: [highValueId, profitableId] });

    // --- 列表 ---
    const listResponse = await fetch(`${url}/api/signal/signals?only_with_profit=1&page_size=10`);
    const list = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(list.success, true);
    assert.equal(list.pagination.total, 2);
    assert.ok(list.data.every((row: any) => row.collectors.includes("xianbaoku")));

    const filtered = await (await fetch(`${url}/api/signal/signals?profit_status=HIGH_VALUE_CANDIDATE`)).json();
    assert.equal(filtered.pagination.total, 1);
    assert.equal(filtered.data[0].gross_spread, 200);

    const unmatchedList = await (await fetch(`${url}/api/signal/signals?match_status=unmatched&page_size=5`)).json();
    assert.equal(unmatchedList.pagination.total, 1);

    // --- 详情 ---
    const detailResponse = await fetch(`${url}/api/signal/signals/${highValueId}`);
    const detail = await detailResponse.json();
    assert.equal(detailResponse.status, 200);
    assert.equal(detail.data.sku, "游戏机/PS5国行数字slim");
    assert.equal(detail.data.current_recycle_price, 3100);
    assert.equal(detail.data.recycle_source, "东旭游戏机档口");
    // 首次发现已过观察窗口 + 只有单个采集器看到 + 有明确外链 → 标为私家车候选（只是提示，不是判断）
    assert.equal(detail.data.private_candidate, true);
    assert.deepEqual(detail.data.raw_signals, [], "这条还没挂原始记录");
    assert.equal(detail.data.settings.minimum_profit, 100);

    const missing = await fetch(`${url}/api/signal/signals/999999`);
    assert.equal(missing.status, 404);

    // --- 人工审核 ---
    const badVerdict = await fetch(`${url}/api/signal/signals/${highValueId}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "随便写的" })
    });
    assert.equal(badVerdict.status, 400);

    const review = await fetch(`${url}/api/signal/signals/${highValueId}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "真车", note: "已下单，等待到货", reviewer: "owner", execution_level: "B", account_risk: "LOW" })
    });
    const reviewed = await review.json();
    assert.equal(review.status, 200);
    assert.equal(reviewed.data.review_verdict, "真车");
    assert.equal(reviewed.data.review_status, "reviewed");
    assert.equal(reviewed.data.execution_level, "B");
    assert.equal(reviewed.data.account_risk, "LOW");

    // --- 最终结果 ---
    const outcome = await fetch(`${url}/api/signal/signals/${highValueId}/outcome`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome_status: "VALID", actual_recycle_price: 4210, actual_cost: 4005 })
    });
    const outcomePayload = await outcome.json();
    assert.equal(outcome.status, 200);
    assert.equal(outcomePayload.data.actual_profit, 205, "成本与回收价都在时应自动算利润");

    // --- 失效时间与机会窗口 ---
    const expire = await fetch(`${url}/api/signal/signals/${highValueId}/expire`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expired_at: "2026-10-07T10:43:00+08:00", expiration_reason: "回收下降" })
    });
    const expired = await expire.json();
    assert.equal(expire.status, 200);
    assert.equal(expired.data.opportunity_window_minutes, 43);

    const badReason = await fetch(`${url}/api/signal/signals/${highValueId}/expire`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiration_reason: "瞎写的" })
    });
    assert.equal(badReason.status, 400);

    // --- 概览与来源统计 ---
    const overview = await (await fetch(`${url}/api/signal/overview?date=2026-10-07`)).json();
    assert.equal(overview.data.collected, 3);
    assert.equal(overview.data.matched, 2);
    assert.equal(overview.data.valid, 1);
    assert.equal(overview.data.realized_profit, 205);
    assert.equal(overview.data.queue.pending_profitable, 1, "还有一条有空间但没审");

    const stats = await (await fetch(`${url}/api/signal/stats/sources`)).json();
    assert.equal(stats.success, true);
    const originRow = stats.data.by_origin_source.find((row: any) => row.key === "好单");
    assert.equal(originRow.collected, 3);
    assert.equal(originRow.matched, 2);
    assert.equal(originRow.valid, 1);
    assert.equal(originRow.avg_realized_profit, 205);
    assert.ok(originRow.sku_hit_rate > 0.6 && originRow.sku_hit_rate < 0.7);
    assert.ok(stats.data.recycle_providers.some((provider: any) => provider.id === "qiandao_bid"));

    // --- 采集源与阈值 ---
    const sources = await (await fetch(`${url}/api/signal/sources`)).json();
    assert.equal(sources.success, true);
    assert.equal(sources.data.length, 3);
    assert.equal(sources.data[0].source_key, "xianbaoku");
    assert.equal(sources.data[0].poll_interval, 30);

    const disable = await fetch(`${url}/api/signal/sources/xianbaoku`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: 0, poll_interval: 120 })
    });
    const disabled = await disable.json();
    assert.equal(disabled.data.enabled, 0);
    assert.equal(disabled.data.poll_interval, 120);

    const settingsPatch = await fetch(`${url}/api/signal/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: [{ key: "minimum_profit", value: "50" }] })
    });
    assert.equal(settingsPatch.status, 200);
    const settings = await (await fetch(`${url}/api/signal/settings`)).json();
    assert.equal(settings.data.minimum_profit, 50);

    // 阈值降低后重算，原本「有空间」的那条升级为高价值
    const recompute = await fetch(`${url}/api/signal/recompute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ only_pending: false, limit: 100 })
    });
    assert.equal(recompute.status, 200);
    const after = await (await fetch(`${url}/api/signal/signals/${profitableId}`)).json();
    assert.equal(after.data.profit_status, "HIGH_VALUE_CANDIDATE");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
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
