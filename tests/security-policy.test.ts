import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { resolveDatabaseFilePolicy, validateDatabaseFilePolicy } from "../src/config/databasePolicy";
import {
  applyServerSecurity,
  createRemoteAuthenticationMiddleware,
  resolveAllowedCorsOrigins,
  resolveServerSecurityConfig
} from "../src/config/serverSecurity";

test("API defaults to loopback in local development", () => {
  const config = resolveServerSecurityConfig({ NODE_ENV: "development" });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.deploymentMode, "local");
  assert.equal(config.authMode, "none");
  assert.equal(resolveAllowedCorsOrigins(config, []).has("http://localhost:5173"), true);
});

test("production requires an explicit deployment mode and database path", () => {
  assert.throws(
    () => resolveServerSecurityConfig({ NODE_ENV: "production" }),
    /DEPLOYMENT_MODE/
  );
  assert.throws(
    () => resolveDatabaseFilePolicy({ NODE_ENV: "production" }),
    /BUSINESS_DB_PATH/
  );
  assert.throws(
    () => resolveDatabaseFilePolicy({
      NODE_ENV: "production",
      BUSINESS_DB_PATH: "./relative-production.db"
    }),
    /absolute path/
  );
});

test("a missing database is created only after explicit ALLOW_DB_CREATE", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-db-policy-"));
  const filename = path.join(tempDirectory, "nested", "business.db");
  try {
    const denied = resolveDatabaseFilePolicy({ BUSINESS_DB_PATH: filename }, tempDirectory);
    assert.throws(() => validateDatabaseFilePolicy(denied), /ALLOW_DB_CREATE=true/);

    const allowed = resolveDatabaseFilePolicy({
      BUSINESS_DB_PATH: filename,
      ALLOW_DB_CREATE: "true"
    }, tempDirectory);
    assert.deepEqual(validateDatabaseFilePolicy(allowed), { exists: false, isEmpty: true });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("production rejects a direct non-loopback API bind", () => {
  assert.throws(
    () => resolveServerSecurityConfig({
      NODE_ENV: "production",
      DEPLOYMENT_MODE: "remote",
      HOST: "0.0.0.0",
      PORT: "3001"
    }),
    /loopback/
  );
});

test("remote mode requires HTTPS reverse proxy and server-side identity", () => {
  assert.throws(
    () => resolveServerSecurityConfig({
      NODE_ENV: "production",
      DEPLOYMENT_MODE: "remote",
      HOST: "127.0.0.1",
      PORT: "3001",
      CORS_ORIGINS: "https://business.example.com",
      PUBLIC_BASE_URL: "https://business.example.com",
      TRUST_PROXY: "loopback"
    }),
    /SERVER_AUTH_MODE/
  );

  const config = resolveServerSecurityConfig({
    NODE_ENV: "production",
    DEPLOYMENT_MODE: "remote",
    HOST: "127.0.0.1",
    PORT: "3001",
    CORS_ORIGINS: "https://business.example.com",
    PUBLIC_BASE_URL: "https://business.example.com",
    TRUST_PROXY: "loopback",
    SERVER_AUTH_MODE: "trusted_reverse_proxy",
    AUTH_IDENTITY_HEADER: "X-Authenticated-User"
  });
  assert.equal(config.authMode, "trusted_reverse_proxy");
  assert.equal(config.identityHeader, "x-authenticated-user");
  assert.equal(config.publicBaseUrl, "https://business.example.com");
  assert.equal(resolveAllowedCorsOrigins(config, ["https://business.example.com"]).has("http://localhost:5173"), false);
});

test("remote session mode fails closed when server credentials are missing", () => {
  assert.throws(
    () => resolveServerSecurityConfig({
      NODE_ENV: "production",
      DEPLOYMENT_MODE: "remote",
      HOST: "127.0.0.1",
      PORT: "3001",
      CORS_ORIGINS: "https://business.example.com",
      PUBLIC_BASE_URL: "https://business.example.com",
      TRUST_PROXY: "loopback",
      SERVER_AUTH_MODE: "session"
    }),
    /AUTH_USERNAME/
  );
});

test("remote middleware rejects direct or anonymous access and accepts proxy identity", async () => {
  const config = resolveServerSecurityConfig({
    NODE_ENV: "production",
    DEPLOYMENT_MODE: "remote",
    HOST: "127.0.0.1",
    PORT: "3001",
    CORS_ORIGINS: "https://business.example.com",
    PUBLIC_BASE_URL: "https://business.example.com",
    TRUST_PROXY: "loopback",
    SERVER_AUTH_MODE: "trusted_reverse_proxy",
    AUTH_IDENTITY_HEADER: "X-Authenticated-User"
  });
  const app = express();
  applyServerSecurity(app, config);
  app.use(createRemoteAuthenticationMiddleware(config));
  app.get("/api/protected", (_req, res) => res.json({ status: "success" }));
  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/protected`;

    const directResponse = await fetch(url);
    assert.equal(directResponse.status, 426);

    const anonymousProxyResponse = await fetch(url, {
      headers: {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "203.0.113.10"
      }
    });
    assert.equal(anonymousProxyResponse.status, 401);

    const authenticatedResponse = await fetch(url, {
      headers: {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "203.0.113.10",
        "X-Authenticated-User": "verified-user"
      }
    });
    assert.equal(authenticatedResponse.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});
