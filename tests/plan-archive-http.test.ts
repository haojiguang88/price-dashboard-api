import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import planRoutes from "../src/routes/planRoutes";
import getDb, { closeDatabase, getDatabasePath } from "../src/config/database";
import { runMigrations } from "../src/migrations";

interface PlanRow {
  id: string;
  plan_name: string;
  status: string;
  is_archived: boolean;
  archived_at: string | null;
}

const seedMasterData = async (db: any, categoryName: string, objectName: string, variantName: string) => {
  await db.run("INSERT OR IGNORE INTO categories (name) VALUES (?)", [categoryName]);
  const category = await db.get("SELECT id FROM categories WHERE name = ?", [categoryName]);
  await db.run("INSERT OR IGNORE INTO objects (category_id, name) VALUES (?, ?)", [category.id, objectName]);
  const object = await db.get("SELECT id FROM objects WHERE category_id = ? AND name = ?", [category.id, objectName]);
  await db.run("INSERT OR IGNORE INTO variants (object_id, name) VALUES (?, ?)", [object.id, variantName]);
};

const insertPlan = async (
  db: any,
  tableName: "buying_plans" | "selling_plans",
  input: { planName: string; status: string; category: string; object: string; variant: string }
) => {
  const result = await db.run(
    `INSERT INTO ${tableName}
       (plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.planName,
      input.category,
      input.object,
      input.variant,
      100,
      1,
      100,
      input.status,
      "2026-10-03T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z"
    ]
  );
  return Number(result.lastID);
};

const listPlans = async (baseUrl: string, endpoint: string, query = "") => {
  const response = await fetch(`${baseUrl}/api/${endpoint}${query}`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  return payload.data as PlanRow[];
};

test("plan archive endpoints guard by status, hide archived rows and stay restorable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-plan-archive-http-"));
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
  app.use("/api", planRoutes);
  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const db = await getDb();
    // 安全闸：确认所有写入都落在临时库上。
    assert.equal(getDatabasePath(), filename);
    await runMigrations(filename);
    // 新库会被历史迁移种下示例计划，先清空让断言只针对本测试的数据。
    await db.run("DELETE FROM buying_plans");
    await db.run("DELETE FROM selling_plans");
    await seedMasterData(db, "纪念币", "龙银币", "封装");
    await seedMasterData(db, "贵金属", "白银", "千克银条");

    const pendingBuyId = await insertPlan(db, "buying_plans", {
      planName: "待执行的买入计划",
      status: "pending",
      category: "纪念币",
      object: "龙银币",
      variant: "封装"
    });
    const completedBuyId = await insertPlan(db, "buying_plans", {
      planName: "已完成的买入计划",
      status: "completed",
      category: "纪念币",
      object: "龙银币",
      variant: "封装"
    });
    const completedSellId = await insertPlan(db, "selling_plans", {
      planName: "已完成的卖出计划",
      status: "completed",
      category: "贵金属",
      object: "白银",
      variant: "千克银条"
    });

    const initialBuyIds = (await listPlans(baseUrl, "buying-plans")).map(plan => String(plan.id));
    assert.deepEqual(initialBuyIds.sort(), [pendingBuyId, completedBuyId].map(String).sort());

    // 未完成的计划不能归档
    const rejectPending = await fetch(`${baseUrl}/api/buying-plans/${pendingBuyId}/archive`, { method: "PATCH" });
    const rejectPayload = await rejectPending.json();
    assert.equal(rejectPending.status, 400);
    assert.equal(rejectPayload.success, false);
    assert.match(rejectPayload.message, /只有已完成的买入计划才能归档/);

    const untouched = await db.get("SELECT is_archived, archived_at FROM buying_plans WHERE id = ?", [pendingBuyId]);
    assert.equal(Number(untouched.is_archived), 0);
    assert.equal(untouched.archived_at, null);

    // 已完成的计划可以归档
    const archive = await fetch(`${baseUrl}/api/buying-plans/${completedBuyId}/archive`, { method: "PATCH" });
    const archivePayload = await archive.json();
    assert.equal(archive.status, 200);
    assert.equal(archivePayload.success, true);
    assert.equal(archivePayload.data.is_archived, true);
    assert.equal(archivePayload.data.message, "买入计划已归档");

    const archivedRow = await db.get("SELECT is_archived, archived_at FROM buying_plans WHERE id = ?", [completedBuyId]);
    assert.equal(Number(archivedRow.is_archived), 1);
    assert.ok(archivedRow.archived_at);

    // 归档后默认不可见
    const afterArchive = await listPlans(baseUrl, "buying-plans");
    assert.deepEqual(afterArchive.map(plan => String(plan.id)), [String(pendingBuyId)]);

    // 显式要求时可见，并带归档标记
    const withArchived = await listPlans(baseUrl, "buying-plans", "?include_archived_plans=1");
    assert.deepEqual(withArchived.map(plan => String(plan.id)).sort(), [pendingBuyId, completedBuyId].map(String).sort());
    const archivedPlan = withArchived.find(plan => String(plan.id) === String(completedBuyId));
    assert.equal(archivedPlan?.is_archived, true);
    assert.ok(archivedPlan?.archived_at);

    // 归档的计划不能再编辑或改状态
    const editArchived = await fetch(`${baseUrl}/api/buying-plans/${completedBuyId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan_name: "改名尝试",
        category_name: "纪念币",
        object_name: "龙银币",
        variant_name: "封装",
        target_price: 120,
        plan_quantity: 1
      })
    });
    assert.equal(editArchived.status, 409);
    const editPayload = await editArchived.json();
    assert.match(editPayload.message, /已归档的买入计划不可编辑/);

    const statusArchived = await fetch(`${baseUrl}/api/buying-plans/${completedBuyId}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "pending" })
    });
    assert.equal(statusArchived.status, 409);

    // 卖出计划同样生效
    const archiveSell = await fetch(`${baseUrl}/api/selling-plans/${completedSellId}/archive`, { method: "PATCH" });
    assert.equal(archiveSell.status, 200);
    assert.deepEqual(await listPlans(baseUrl, "selling-plans"), []);

    // 重复归档是幂等的
    const repeatArchive = await fetch(`${baseUrl}/api/selling-plans/${completedSellId}/archive`, { method: "PATCH" });
    const repeatPayload = await repeatArchive.json();
    assert.equal(repeatArchive.status, 200);
    assert.equal(repeatPayload.data.changes, 0);

    // 恢复后重新回到默认列表
    const restoreSell = await fetch(`${baseUrl}/api/selling-plans/${completedSellId}/restore`, { method: "PATCH" });
    const restorePayload = await restoreSell.json();
    assert.equal(restoreSell.status, 200);
    assert.equal(restorePayload.data.is_archived, false);
    assert.equal(restorePayload.data.message, "卖出计划已恢复");

    const afterRestore = await listPlans(baseUrl, "selling-plans");
    assert.deepEqual(afterRestore.map(plan => String(plan.id)), [String(completedSellId)]);
    assert.equal(afterRestore[0].is_archived, false);
    assert.equal(afterRestore[0].archived_at, null);
    assert.equal(afterRestore[0].status, "completed");

    // 统计口径不受归档影响：只统计待执行/执行中
    const statsResponse = await fetch(`${baseUrl}/api/plans/stats`);
    const statsPayload = await statsResponse.json();
    assert.equal(statsResponse.status, 200);
    assert.equal(statsPayload.data.buy_count, 1);

    // 不存在的计划返回 404
    const missing = await fetch(`${baseUrl}/api/buying-plans/999999/archive`, { method: "PATCH" });
    const missingPayload = await missing.json();
    assert.equal(missing.status, 404);
    assert.equal(missingPayload.message, "买入计划不存在");
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
