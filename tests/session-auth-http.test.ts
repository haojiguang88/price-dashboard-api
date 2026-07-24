import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  applyServerSecurity,
  createRemoteAuthenticationMiddleware,
  resolveServerSecurityConfig
} from "../src/config/serverSecurity";
import {
  registerProtectedAuthRoutes,
  registerPublicAuthRoutes
} from "../src/routes/authRoutes";
import { createPasswordHash } from "../src/services/sessionAuth";

test("session login protects API routes with a secure HttpOnly cookie", async () => {
  const password = "correct horse battery staple";
  const config = resolveServerSecurityConfig({
    NODE_ENV: "production",
    DEPLOYMENT_MODE: "remote",
    HOST: "127.0.0.1",
    PORT: "3001",
    CORS_ORIGINS: "https://business.example.com",
    PUBLIC_BASE_URL: "https://business.example.com",
    TRUST_PROXY: "loopback",
    SERVER_AUTH_MODE: "session",
    AUTH_USERNAME: "owner",
    AUTH_PASSWORD_HASH: await createPasswordHash(password),
    AUTH_SESSION_SECRET: "session-secret-that-is-longer-than-thirty-two-characters"
  });

  const app = express();
  applyServerSecurity(app, config);
  app.use(express.json());
  registerPublicAuthRoutes(app, config);
  app.use(createRemoteAuthenticationMiddleware(config));
  registerProtectedAuthRoutes(app, config);
  app.get("/api/protected", (_req, res) => {
    res.json({
      status: "success",
      identity: res.locals.authenticatedIdentity
    });
  });

  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const proxyHeaders = {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-For": "203.0.113.10"
    };

    const unauthenticatedSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
      headers: proxyHeaders
    });
    assert.equal(unauthenticatedSessionResponse.status, 200);
    assert.equal(
      (await unauthenticatedSessionResponse.json()).data.authenticated,
      false
    );

    const anonymousResponse = await fetch(`${baseUrl}/api/protected`, {
      headers: proxyHeaders
    });
    assert.equal(anonymousResponse.status, 401);

    const invalidLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        ...proxyHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username: "owner", password: "wrong password" })
    });
    assert.equal(invalidLoginResponse.status, 401);

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        ...proxyHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username: "owner", password })
    });
    assert.equal(loginResponse.status, 200);
    const setCookie = loginResponse.headers.get("set-cookie") || "";
    assert.match(setCookie, /price_dashboard_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(";")[0];

    const protectedResponse = await fetch(`${baseUrl}/api/protected`, {
      headers: {
        ...proxyHeaders,
        Cookie: cookie
      }
    });
    assert.equal(protectedResponse.status, 200);
    assert.equal((await protectedResponse.json()).identity, "owner");

    const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
      headers: {
        ...proxyHeaders,
        Cookie: cookie
      }
    });
    assert.equal(sessionResponse.status, 200);

    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        ...proxyHeaders,
        Cookie: cookie
      }
    });
    assert.equal(logoutResponse.status, 200);
    assert.match(
      logoutResponse.headers.get("set-cookie") || "",
      /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});
