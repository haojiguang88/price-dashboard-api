import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
import {
  buildOriginalPricePremiumSnapshot,
  loadLatestOriginalPriceRecord,
  resolveOriginalPricePremium,
  resolveOriginalPricePremiumLabel
} from "../src/services/originalPricePremiumService";
import priceRoutes from "../src/routes/priceRoutes";
import getDb, { closeDatabase, getDatabasePath } from "../src/config/database";
import { runMigrations } from "../src/migrations";

const setupOriginalPriceTable = async (filename: string) => {
  const db = await open({ filename, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE original_price_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL DEFAULT 0,
      category_name TEXT NOT NULL,
      object_id INTEGER NOT NULL DEFAULT 0,
      object_name TEXT NOT NULL,
      variant_id INTEGER,
      variant_name TEXT,
      original_price REAL NOT NULL,
      effective_date TEXT NOT NULL,
      source TEXT,
      reason TEXT,
      note TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
};

const insertOriginalPrice = async (
  db: Database,
  input: {
    category: string;
    object: string;
    variant?: string | null;
    price: number;
    date: string;
    source?: string;
    deleted?: number;
  }
) => {
  const result = await db.run(
    `INSERT INTO original_price_records
       (category_name, object_name, variant_name, original_price, effective_date, source, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.category,
      input.object,
      input.variant === undefined ? null : input.variant,
      input.price,
      input.date,
      input.source || "官方价",
      input.deleted ?? 0
    ]
  );
  return Number(result.lastID);
};

const withTempDatabase = async (callback: (db: Database) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-original-premium-"));
  const filename = path.join(directory, "original-price.db");
  const db = await setupOriginalPriceTable(filename);
  try {
    await callback(db);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("premium percent is measured against the original price", () => {
  const snapshot = buildOriginalPricePremiumSnapshot({
    original_price: 399,
    original_price_source: "官方价",
    original_price_effective_date: "2026-10-03",
    original_price_record_id: 38,
    original_price_variant_name: "向往之处",
    current_price: 588,
    current_price_date: "2026-10-02"
  });

  assert.equal(snapshot.status, "calculated");
  assert.equal(snapshot.basis, "original_price");
  assert.equal(snapshot.premium_percent, 47.4);
  assert.equal(snapshot.premium_amount, 189);
  assert.equal(snapshot.premium_label, "中等溢价");
  assert.equal(snapshot.original_price, 399);
  assert.equal(snapshot.original_price_record_id, 38);
  assert.equal(snapshot.current_price, 588);
});

test("a price at or below the original price is reported as no premium or a break", () => {
  const flat = buildOriginalPricePremiumSnapshot({ original_price: 129, current_price: 129 });
  assert.equal(flat.premium_percent, 0);
  assert.equal(flat.premium_amount, 0);
  assert.equal(flat.premium_label, "低溢价");

  const smallBreak = buildOriginalPricePremiumSnapshot({ original_price: 399, current_price: 380 });
  assert.equal(smallBreak.premium_percent, -4.8);
  assert.equal(smallBreak.premium_label, "小幅破发");

  const deepBreak = buildOriginalPricePremiumSnapshot({ original_price: 399, current_price: 300 });
  assert.equal(deepBreak.premium_label, "明显破发");
  assert.ok(Number(deepBreak.premium_percent) < -10);
});

test("premium bands stay aligned with the silver premium wording", () => {
  assert.equal(resolveOriginalPricePremiumLabel(0), "低溢价");
  assert.equal(resolveOriginalPricePremiumLabel(29.9), "低溢价");
  assert.equal(resolveOriginalPricePremiumLabel(30), "中等溢价");
  assert.equal(resolveOriginalPricePremiumLabel(59.9), "中等溢价");
  assert.equal(resolveOriginalPricePremiumLabel(60), "高溢价");
  assert.equal(resolveOriginalPricePremiumLabel(99.9), "高溢价");
  assert.equal(resolveOriginalPricePremiumLabel(100), "超高溢价");
  assert.equal(resolveOriginalPricePremiumLabel(null), "暂无法计算");
});

test("missing original price or missing current price is reported instead of a fake number", () => {
  const noOriginal = buildOriginalPricePremiumSnapshot({ current_price: 588 });
  assert.equal(noOriginal.status, "unavailable");
  assert.equal(noOriginal.premium_percent, null);
  assert.equal(noOriginal.premium_label, "无原始价格");

  const noCurrent = buildOriginalPricePremiumSnapshot({ original_price: 399 });
  assert.equal(noCurrent.status, "unavailable");
  assert.equal(noCurrent.premium_percent, null);
  assert.equal(noCurrent.premium_label, "暂无法计算");

  const zeroOriginal = buildOriginalPricePremiumSnapshot({ original_price: 0, current_price: 588 });
  assert.equal(zeroOriginal.status, "unavailable");
  assert.equal(zeroOriginal.premium_label, "无原始价格");
});

test("the latest effective original price wins, per variant", async () => {
  await withTempDatabase(async db => {
    await insertOriginalPrice(db, {
      category: "泡泡玛特",
      object: "Zsiga",
      variant: "向往之处",
      price: 350,
      date: "2026-01-01"
    });
    await insertOriginalPrice(db, {
      category: "泡泡玛特",
      object: "Zsiga",
      variant: "向往之处",
      price: 399,
      date: "2026-10-03",
      source: "官方价"
    });
    await insertOriginalPrice(db, {
      category: "泡泡玛特",
      object: "Zsiga",
      variant: "姜饼人",
      price: 299,
      date: "2026-05-01"
    });

    const record = await loadLatestOriginalPriceRecord(db, {
      category_name: "泡泡玛特",
      object_name: "Zsiga",
      variant_name: "向往之处"
    });
    assert.equal(record?.original_price, 399);
    assert.equal(record?.effective_date, "2026-10-03");

    const other = await loadLatestOriginalPriceRecord(db, {
      category_name: "泡泡玛特",
      object_name: "Zsiga",
      variant_name: "姜饼人"
    });
    assert.equal(other?.original_price, 299);
  });
});

test("deleted records are ignored and object-level price is the fallback", async () => {
  await withTempDatabase(async db => {
    await insertOriginalPrice(db, {
      category: "泡泡玛特",
      object: "大娃",
      variant: "mega400%漫漫花落-绒",
      price: 999,
      date: "2026-09-01",
      deleted: 1
    });
    await insertOriginalPrice(db, {
      category: "泡泡玛特",
      object: "大娃",
      variant: null,
      price: 899,
      date: "2026-08-01"
    });

    const record = await loadLatestOriginalPriceRecord(db, {
      category_name: "泡泡玛特",
      object_name: "大娃",
      variant_name: "mega400%漫漫花落-绒"
    });
    assert.equal(record?.original_price, 899);
    assert.equal(record?.variant_name, null);
  });
});

test("objects without any original price resolve to null instead of a zero premium", async () => {
  await withTempDatabase(async db => {
    await insertOriginalPrice(db, {
      category: "泡泡玛特",
      object: "Zsiga",
      variant: "向往之处",
      price: 399,
      date: "2026-10-03"
    });

    const missing = await resolveOriginalPricePremium(db, {
      category_name: "泡泡玛特",
      object_name: "MOKOKO系列",
      variant_name: "万圣节",
      current_price: 100,
      current_price_date: "2026-10-02"
    });
    assert.equal(missing, null);

    const resolved = await resolveOriginalPricePremium(db, {
      category_name: "泡泡玛特",
      object_name: "Zsiga",
      variant_name: "向往之处",
      current_price: 588,
      current_price_date: "2026-10-02"
    });
    assert.equal(resolved?.status, "calculated");
    assert.equal(resolved?.premium_percent, 47.4);
    assert.equal(resolved?.original_price_source, "官方价");
  });
});

test("the price workbench summary exposes the original-price premium", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-original-premium-http-"));
  const filename = path.join(directory, "business.db");

  const previousEnv = {
    BUSINESS_DB_PATH: process.env.BUSINESS_DB_PATH,
    ALLOW_DB_CREATE: process.env.ALLOW_DB_CREATE,
    NODE_ENV: process.env.NODE_ENV
  };
  process.env.BUSINESS_DB_PATH = filename;
  process.env.ALLOW_DB_CREATE = "true";
  process.env.NODE_ENV = "development";

  const app = express();
  app.use(express.json());
  app.use("/api", priceRoutes);
  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const db = await getDb();
    assert.equal(getDatabasePath(), filename);
    await runMigrations(filename);

    await db.run("INSERT OR IGNORE INTO categories (name) VALUES ('泡泡玛特')");
    const category = await db.get("SELECT id FROM categories WHERE name = '泡泡玛特'");
    await db.run("INSERT OR IGNORE INTO objects (category_id, name) VALUES (?, 'Zsiga')", [category.id]);
    const object = await db.get("SELECT id FROM objects WHERE category_id = ? AND name = 'Zsiga'", [category.id]);
    await db.run("INSERT OR IGNORE INTO variants (object_id, name) VALUES (?, '向往之处')", [object.id]);

    await db.run(
      `INSERT INTO price_records (date, category, object_name, variant, price, source)
       VALUES ('2026-10-02', '泡泡玛特', 'Zsiga', '向往之处', 588, '千岛泡泡玛特')`
    );
    await db.run(
      `INSERT INTO original_price_records
         (category_id, category_name, object_id, object_name, variant_id, variant_name,
          original_price, effective_date, source, is_deleted)
       VALUES (?, '泡泡玛特', ?, 'Zsiga', NULL, '向往之处', 399, '2026-10-03', '官方价', 0)`,
      [category.id, object.id]
    );

    const premiumResponse = await fetch(
      `${baseUrl}/api/price-records?paged=1&category=${encodeURIComponent("泡泡玛特")}&object_name=Zsiga&variant=${encodeURIComponent("向往之处")}`
    );
    assert.equal(premiumResponse.status, 200);
    const premiumPayload = await premiumResponse.json();
    assert.equal(premiumPayload.status, "success");
    assert.equal(premiumPayload.summary.coin_silver_premium, null, "银色口径不应在泡泡玛特上出现");
    const premium = premiumPayload.summary.original_price_premium;
    assert.equal(premium.status, "calculated");
    assert.equal(premium.premium_percent, 47.4);
    assert.equal(premium.original_price, 399);
    assert.equal(premium.original_price_effective_date, "2026-10-03");
    assert.equal(premium.current_price, 588);

    // 对象级原始价作为兜底：同对象下没有专门登记原始价的变体也能拿到溢价率
    await db.run("INSERT OR IGNORE INTO variants (object_id, name) VALUES (?, '姜饼人')", [object.id]);
    await db.run(
      `INSERT INTO price_records (date, category, object_name, variant, price, source)
       VALUES ('2026-10-02', '泡泡玛特', 'Zsiga', '姜饼人', 300, '千岛泡泡玛特')`
    );
    await db.run(
      `INSERT INTO original_price_records
         (category_id, category_name, object_id, object_name, variant_id, variant_name,
          original_price, effective_date, source, is_deleted)
       VALUES (?, '泡泡玛特', ?, 'Zsiga', NULL, '', 200, '2026-01-01', '官方价', 0)`,
      [category.id, object.id]
    );
    const fallbackResponse = await fetch(
      `${baseUrl}/api/price-records?paged=1&category=${encodeURIComponent("泡泡玛特")}&object_name=Zsiga&variant=${encodeURIComponent("姜饼人")}`
    );
    const fallbackPayload = await fallbackResponse.json();
    const fallback = fallbackPayload.summary.original_price_premium;
    assert.equal(fallback.status, "calculated");
    assert.equal(fallback.original_price, 200);
    assert.equal(fallback.premium_percent, 50);

    // 没登记原始价格的对象不带这个字段
    const noneResponse = await fetch(
      `${baseUrl}/api/price-records?paged=1&category=${encodeURIComponent("泡泡玛特")}&object_name=${encodeURIComponent("MOKOKO系列")}`
    );
    const nonePayload = await noneResponse.json();
    assert.equal(nonePayload.summary.original_price_premium, null);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
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
