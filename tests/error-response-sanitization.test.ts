import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  createProductionJsonSanitizer,
  jsonErrorHandler,
  jsonNotFoundHandler,
  requestIdMiddleware
} from "../src/middleware/errorHandling";

test("production 500 responses do not expose paths, stack traces or database details", async () => {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(createProductionJsonSanitizer(true));
  app.get("/leak", (_req, res) => {
    res.status(500).json({
      status: "error",
      message: "SQLITE_CANTOPEN /Users/example/private/business.db",
      stack: "Error at /Users/example/src/index.ts:10",
      db_path: "/Users/example/private/business.db"
    });
  });
  app.get("/bad-request", (_req, res) => {
    res.status(400).json({
      status: "error",
      message: "Invalid file /www/server/private/business.db",
      stack: "validation stack"
    });
  });
  app.use(jsonNotFoundHandler);
  app.use(jsonErrorHandler);

  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/leak`);
    const body = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 500);
    assert.match(response.headers.get("content-type") || "", /application\/json/);
    assert.equal(body.message, "Internal server error");
    assert.equal(body.code, "internal_error");
    assert.ok(body.request_id);
    assert.equal(JSON.stringify(body).includes("/Users/"), false);
    assert.equal("stack" in body, false);
    assert.equal("db_path" in body, false);

    const badRequestResponse = await fetch(`http://127.0.0.1:${address.port}/bad-request`);
    const badRequestBody = await badRequestResponse.json() as Record<string, unknown>;
    assert.equal(badRequestResponse.status, 400);
    assert.equal(String(badRequestBody.message).includes("/www/"), false);
    assert.equal(String(badRequestBody.message).includes("[redacted-path]"), true);
    assert.equal("stack" in badRequestBody, false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});
