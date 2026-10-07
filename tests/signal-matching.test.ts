import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
import { initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";
import {
  buildSkuDictionary,
  invalidateSkuDictionary,
  matchSignalToSku
} from "../src/services/signal/signalSkuMatcher";
import { resolveRecyclePrice } from "../src/services/signal/recyclePriceService";
import { analyzeNormalizedSignals, inferExecutionFields, loadSignalSettings } from "../src/services/signal/signalAnalysisService";

const seedCatalog = async (db: any) => {
  const ensure = async (categoryName: string, objectName: string, variants: string[]) => {
    await db.run("INSERT OR IGNORE INTO categories (name) VALUES (?)", [categoryName]);
    const category = await db.get("SELECT id FROM categories WHERE name = ?", [categoryName]);
    await db.run("INSERT OR IGNORE INTO objects (category_id, name) VALUES (?, ?)", [category.id, objectName]);
    const object = await db.get("SELECT id FROM objects WHERE category_id = ? AND name = ?", [category.id, objectName]);
    for (const variant of variants) {
      await db.run("INSERT OR IGNORE INTO variants (object_id, name) VALUES (?, ?)", [object.id, variant]);
    }
    return { categoryId: Number(category.id), objectId: Number(object.id) };
  };

  await ensure("泡泡玛特", "Zsiga", ["向往之处", "姜饼人"]);
  await ensure("泡泡玛特", "MOKOKO系列", ["大春花", "万圣节"]);
  await ensure("游戏机", "PS5国行数字slim", []);
  await ensure("苹果手机", "iPhone 18 Pro Max 256G", []);
  await ensure("纪念币", "龙银币", ["2025年", "2026年"]);
  await ensure("纪念币", "马年银币", ["15g小马"]);
  await ensure("纪念币", "农行卡", []);

  // 让这些 SKU 变成「正在采价的目标 SKU」
  const priceRows: Array<[string, string, string, number]> = [
    ["泡泡玛特", "Zsiga", "向往之处", 588],
    ["泡泡玛特", "MOKOKO系列", "大春花", 129],
    ["游戏机", "PS5国行数字slim", "", 2999],
    ["苹果手机", "iPhone 18 Pro Max 256G", "", 9999],
    ["纪念币", "龙银币", "2025年", 500],
    ["纪念币", "马年银币", "15g小马", 610],
    ["纪念币", "农行卡", "", 900]
  ];
  for (const [category, object, variant, price] of priceRows) {
    await db.run(
      `INSERT INTO price_records (date, category, object_name, variant, price, source, created_at, updated_at)
       VALUES ('2026-10-01', ?, ?, ?, ?, '测试来源', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [category, object, variant, price]
    );
  }

  // 采集侧别名
  const zsiga = await db.get("SELECT id FROM objects WHERE name = 'Zsiga'");
  const zsigaVariant = await db.get("SELECT id FROM variants WHERE object_id = ? AND name = '向往之处'", [zsiga.id]);
  await db.run(
    `INSERT INTO source_mappings (source_key, source_name, external_key, external_name, category_name, object_name, variant_name, variant_id, status)
     VALUES ('qiandao_popmart', '千岛', 'spu-1', 'Zsiga 向往之处', '泡泡玛特', 'Zsiga', '向往之处', ?, 'enabled')`,
    [zsigaVariant.id]
  );
};

const withDatabase = async (callback: (db: Database) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-signal-match-"));
  const filename = path.join(directory, "business.db");
  const db = await open({ filename, driver: sqlite3.Database });
  invalidateSkuDictionary();
  try {
    // 真实建库路径：基础表 + 全部迁移，测试用的是真 schema，不是手写替身。
    await initializeBusinessBaseSchema(db);
    await runMigrations(filename);
    await seedCatalog(db);
    invalidateSkuDictionary();
    await callback(db);
  } finally {
    invalidateSkuDictionary();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("SKU 匹配：变体优先于父对象，短中文名也能命中", async () => {
  await withDatabase(async db => {
    const dictionary = await buildSkuDictionary(db, { force: true });

    const variant = matchSignalToSku("Zsiga 向往之处 到手399元", "", dictionary);
    assert.equal(variant.match_status, "matched");
    assert.equal(variant.sku, "泡泡玛特/Zsiga/向往之处");

    // 只提到系列、没提到具体款 → 命中的是系列
    const series = matchSignalToSku("泡泡玛特 Zsiga 上新了", "", dictionary);
    assert.equal(series.match_status, "matched");
    assert.equal(series.sku, "泡泡玛特/Zsiga");

    // 3 个汉字是很强的判别词，不能被长度门槛误杀
    const silver = matchSignalToSku("龙银币 封装 560元", "", dictionary);
    assert.equal(silver.match_status, "matched");
    assert.equal(silver.sku, "纪念币/龙银币");

    const phone = matchSignalToSku("iPhone 18 Pro Max 256G 到手9999元", "", dictionary);
    assert.equal(phone.sku, "苹果手机/iPhone 18 Pro Max 256G");

    const console_ = matchSignalToSku("PS5国行数字slim 2999元", "", dictionary);
    assert.equal(console_.sku, "游戏机/PS5国行数字slim");
  });
});

test("SKU 匹配：无关线报必须 unmatched，跨对象冲突必须 ambiguous", async () => {
  await withDatabase(async db => {
    const dictionary = await buildSkuDictionary(db, { force: true });

    const unrelated = matchSignalToSku("蒙牛纯牛奶250ml*24盒 39.9元", "", dictionary);
    assert.equal(unrelated.match_status, "unmatched");
    assert.equal(unrelated.sku, null);

    const joke = matchSignalToSku("通知：所有人把手机日历调回9月31号", "", dictionary);
    assert.equal(joke.match_status, "unmatched");

    // 同时提到两个不同对象且都很强 → 不能替人做决定
    const conflict = matchSignalToSku("iPhone 18 Pro Max 256G 与 PS5国行数字slim 一起买", "", dictionary);
    assert.equal(conflict.match_status, "ambiguous");
    assert.equal(conflict.sku, null);
    assert.ok(conflict.candidates.length >= 2);
  });
});

test("SKU 匹配：外部别名能落到同一个 SKU", async () => {
  await withDatabase(async db => {
    const dictionary = await buildSkuDictionary(db, { force: true });
    const result = matchSignalToSku("千岛同款 Zsiga 向往之处 特价", "", dictionary);
    assert.equal(result.match_status, "matched");
    assert.equal(result.sku, "泡泡玛特/Zsiga/向往之处");
  });
});

test("回收价 provider：千岛收购价 / 回收商报价 / 退到对象级 / 取不到就 null", async () => {
  await withDatabase(async db => {
    // 千岛买盘
    await db.run(
      `INSERT INTO market_book_snapshots (category, object_name, variant, date, source_key, bid_price, bid_qty, price_kind, captured_at)
       VALUES ('泡泡玛特', 'Zsiga', '向往之处', '2026-10-06', 'qiandao_popmart', 560, 3, 'flash_min', '2026-10-06T10:00:00+08:00')`
    );
    const bid = await resolveRecyclePrice(db, { category_name: "泡泡玛特", object_name: "Zsiga", variant_name: "向往之处" });
    assert.equal(bid?.price, 560);
    assert.equal(bid?.provider, "qiandao_bid");
    assert.equal(bid?.precision, "variant");

    // 电子产品走回收商报价
    await db.run(
      `INSERT INTO price_records (date, category, object_name, variant, price, source, created_at, updated_at)
       VALUES ('2026-10-05', '游戏机', 'PS5国行数字slim', '', 3100, '东旭游戏机档口', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    );
    const dealer = await resolveRecyclePrice(db, { category_name: "游戏机", object_name: "PS5国行数字slim" });
    assert.equal(dealer?.price, 3100);
    assert.equal(dealer?.provider, "dongxu_dealer");

    // 变体没有专门报价 → 退到对象级，置信度打折
    await db.run(
      `INSERT INTO price_records (date, category, object_name, variant, price, source, created_at, updated_at)
       VALUES ('2026-10-04', '纪念币', '龙银币', '', 520, '爱藏龙银币', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    );
    const fallback = await resolveRecyclePrice(db, { category_name: "纪念币", object_name: "龙银币", variant_name: "2025年" });
    assert.equal(fallback?.price, 520);
    assert.equal(fallback?.precision, "object");
    assert.ok((fallback?.confidence ?? 1) < 0.7, "退回对象级要打折");

    // 没有可用来源 → null（上层标待回收价确认，不拿卖价冒充）
    const none = await resolveRecyclePrice(db, { category_name: "泡泡玛特", object_name: "MOKOKO系列", variant_name: "大春花" });
    assert.equal(none, null);
  });
});

test("可执行性推断：学生认证/限购/地区会抬高门槛", () => {
  const hard = inferExecutionFields("某商品 1.3元", "需学生号，限购1件，仅限广东地区", null);
  assert.equal(hard.executionLevel, "C");
  assert.match(String(hard.qualificationRequirement), /学生认证/);
  assert.equal(hard.purchaseLimit, "限购 1");
  assert.ok(String(hard.regionRequirement).includes("广东"));

  const easy = inferExecutionFields("某商品 99元", "不限新老用户，直接下单", null);
  assert.equal(easy.accountRequirement, "不限");
  assert.equal(easy.executionLevel, "A");

  const unknown = inferExecutionFields("某商品 99元", "", null);
  assert.equal(unknown.executionLevel, "B");
  assert.equal(unknown.accountRisk, "UNKNOWN", "风控不能凭空推断");
});

const insertNormalized = async (db: any, input: {
  title: string;
  content?: string;
  finalBuyPrice?: number | null;
  priceStatus?: string;
  dealUrl?: string | null;
  sourceCount?: number;
  firstSeenAt?: string;
}) => {
  const result = await db.run(
    `INSERT INTO normalized_signal
       (dedupe_hash, origin_source, title, content, deal_url, published_at, first_seen_at, last_seen_at,
        first_seen_source, source_count, collectors_json, observations_json,
        content_hash, normalized_hash, price_status, final_buy_price, created_at, updated_at)
     VALUES (?, '好单', ?, ?, ?, '2026-10-07T10:00:00+08:00', ?, ?, 'xianbaoku', ?, '["xianbaoku"]', '[]',
             'c', 'n', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      `hash-${Math.random().toString(16).slice(2)}`,
      input.title,
      input.content ?? "",
      input.dealUrl ?? null,
      input.firstSeenAt ?? "2026-10-07T10:00:00+08:00",
      input.firstSeenAt ?? "2026-10-07T10:00:00+08:00",
      input.sourceCount ?? 1,
      input.priceStatus ?? "parsed",
      input.finalBuyPrice ?? null
    ]
  );
  return Number(result.lastID);
};

test("分析规则：未匹配 / 待价格 / 待回收价 / 无利润 / 有空间 / 高价值", async () => {
  await withDatabase(async db => {
    await db.run(
      `INSERT INTO market_book_snapshots (category, object_name, variant, date, source_key, bid_price, price_kind, captured_at)
       VALUES ('泡泡玛特', 'Zsiga', '向往之处', '2026-10-06', 'qiandao_popmart', 560, 'flash_min', '2026-10-06T10:00:00+08:00')`
    );

    const unmatched = await insertNormalized(db, { title: "蒙牛纯牛奶 39.9元", finalBuyPrice: 39.9 });
    const pendingPrice = await insertNormalized(db, { title: "Zsiga 向往之处 上新", finalBuyPrice: null, priceStatus: "manual_review" });
    const noRecycle = await insertNormalized(db, { title: "MOKOKO系列 大春花 129元", finalBuyPrice: 129 });
    const noProfit = await insertNormalized(db, { title: "Zsiga 向往之处 到手600元", finalBuyPrice: 600 });
    // 低于阈值的空间（default minimum_profit = 100）
    const profitable = await insertNormalized(db, { title: "Zsiga 向往之处 到手490元", finalBuyPrice: 490 });
    // 达到阈值
    const highValue = await insertNormalized(db, { title: "Zsiga 向往之处 到手399元", finalBuyPrice: 399, dealUrl: "https://u.jd.com/abc" });

    const result = await analyzeNormalizedSignals({ db, ids: [unmatched, pendingPrice, noRecycle, noProfit, profitable, highValue] });
    assert.equal(result.analyzed, 6);

    const statusOf = async (id: number) => (await db.get("SELECT * FROM normalized_signal WHERE id = ?", [id]));
    assert.equal((await statusOf(unmatched)).profit_status, "UNMATCHED");
    assert.equal((await statusOf(pendingPrice)).profit_status, "PENDING_PRICE");
    assert.equal((await statusOf(noRecycle)).profit_status, "PENDING_RECYCLE");
    assert.equal((await statusOf(noProfit)).profit_status, "NO_PROFIT");

    const profitableRow = await statusOf(profitable);
    assert.equal(profitableRow.profit_status, "PROFITABLE_CANDIDATE");
    assert.equal(profitableRow.gross_spread, 70);
    assert.equal(profitableRow.sku, "泡泡玛特/Zsiga/向往之处");
    assert.equal(profitableRow.current_recycle_price, 560);
    assert.equal(profitableRow.recycle_source, "千岛收购价");

    const highRow = await statusOf(highValue);
    assert.equal(highRow.profit_status, "HIGH_VALUE_CANDIDATE");
    assert.equal(highRow.gross_spread, 161);
    assert.ok(highRow.gross_margin_rate > 0.4);
    assert.ok(highRow.product_price_hash, "算完利润必须回填商品+价格哈希");
  });
});

test("私家车只是候选标记，且要满足时间与独占条件", async () => {
  await withDatabase(async db => {
    await db.run(
      `INSERT INTO market_book_snapshots (category, object_name, variant, date, source_key, bid_price, price_kind, captured_at)
       VALUES ('泡泡玛特', 'Zsiga', '向往之处', '2026-10-06', 'qiandao_popmart', 560, 'flash_min', '2026-10-06T10:00:00+08:00')`
    );

    const fresh = await insertNormalized(db, {
      title: "Zsiga 向往之处 到手399元",
      finalBuyPrice: 399,
      dealUrl: "https://u.jd.com/abc",
      firstSeenAt: new Date().toISOString()
    });
    const old = await insertNormalized(db, {
      title: "Zsiga 向往之处 到手399元",
      finalBuyPrice: 399,
      dealUrl: "https://u.jd.com/abc",
      firstSeenAt: "2020-01-01T00:00:00+08:00"
    });
    const shared = await insertNormalized(db, {
      title: "Zsiga 向往之处 到手399元",
      finalBuyPrice: 399,
      dealUrl: "https://u.jd.com/abc",
      firstSeenAt: "2020-01-01T00:00:00+08:00",
      sourceCount: 3
    });
    const noDealUrl = await insertNormalized(db, {
      title: "Zsiga 向往之处 到手399元",
      finalBuyPrice: 399,
      firstSeenAt: "2020-01-01T00:00:00+08:00"
    });

    await analyzeNormalizedSignals({ db, ids: [fresh, old, shared, noDealUrl] });
    const flag = async (id: number) => Number((await db.get("SELECT private_candidate FROM normalized_signal WHERE id = ?", [id]))?.private_candidate);

    assert.equal(await flag(fresh), 0, "刚发现还没过观察窗口，不能标候选");
    assert.equal(await flag(old), 1, "独占且过了窗口才算候选");
    assert.equal(await flag(shared), 0, "已被多个采集器看到，不算私家车");
    assert.equal(await flag(noDealUrl), 0, "没有明确操作路径不算");
  });
});

test("阈值来自 signal_settings，改了立刻生效", async () => {
  await withDatabase(async db => {
    await db.run(
      `INSERT INTO market_book_snapshots (category, object_name, variant, date, source_key, bid_price, price_kind, captured_at)
       VALUES ('泡泡玛特', 'Zsiga', '向往之处', '2026-10-06', 'qiandao_popmart', 560, 'flash_min', '2026-10-06T10:00:00+08:00')`
    );
    const id = await insertNormalized(db, { title: "Zsiga 向往之处 到手490元", finalBuyPrice: 490 });

    await analyzeNormalizedSignals({ db, ids: [id] });
    assert.equal((await db.get("SELECT profit_status FROM normalized_signal WHERE id = ?", [id]))?.profit_status, "PROFITABLE_CANDIDATE");

    await db.run("UPDATE signal_settings SET setting_value = '50' WHERE setting_key = 'minimum_profit'");
    const settings = await loadSignalSettings(db);
    assert.equal(settings.minimum_profit, 50);

    await analyzeNormalizedSignals({ db, ids: [id] });
    assert.equal((await db.get("SELECT profit_status FROM normalized_signal WHERE id = ?", [id]))?.profit_status, "HIGH_VALUE_CANDIDATE");
  });
});
