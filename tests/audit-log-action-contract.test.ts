import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createAuditLogRoutes } from "../src/routes/auditLogRoutes";
import { businessWorkspaceCenterServices } from "../src/services/workspaceCenterScopedServices";
import getDb, { closeDatabase, getDatabasePath } from "../src/config/database";
import { runMigrations } from "../src/migrations";

const postAuditLog = (baseUrl: string, body: Record<string, unknown>) => (
  fetch(`${baseUrl}/api/business/audit-logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      module: "买入计划",
      target: "已完成的买入计划",
      status: "success",
      workspace: "business",
      path: "/plan/buy",
      ...body
    })
  })
);

test("audit logs accept archive and restore actions and still reject unknown ones", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-audit-action-"));
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
  app.use("/api/business", createAuditLogRoutes(businessWorkspaceCenterServices.audit));
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

    for (const action of ["archive", "restore"]) {
      const response = await postAuditLog(baseUrl, {
        id: `audit-plan-${action}-1`,
        action,
        detail: action === "archive" ? "买入计划已归档" : "买入计划已恢复"
      });
      const payload = await response.json();
      assert.equal(response.status, 200, `${action} 应被接受：${JSON.stringify(payload)}`);
      assert.equal(payload.success, true);
      assert.equal(payload.data.action, action);

      const stored = await db.get("SELECT action, target FROM audit_logs WHERE id = ?", [`audit-plan-${action}-1`]);
      assert.equal(stored?.action, action);
    }

    const unknown = await postAuditLog(baseUrl, { id: "audit-plan-bogus-1", action: "bogus" });
    const unknownPayload = await unknown.json();
    assert.equal(unknown.status, 400);
    assert.equal(unknownPayload.message, "无效的 action");

    const listed = await fetch(`${baseUrl}/api/business/audit-logs?action=archive&workspace=business`);
    const listedPayload = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listedPayload.data.length, 1);
    assert.equal(listedPayload.data[0].action, "archive");
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
