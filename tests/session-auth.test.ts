import assert from "node:assert/strict";
import test from "node:test";
import {
  createPasswordHash,
  createSessionToken,
  isSupportedPasswordHash,
  readCookie,
  verifyPassword,
  verifySessionToken,
  type SessionAuthCredentials
} from "../src/services/sessionAuth";

const buildCredentials = async (): Promise<SessionAuthCredentials> => ({
  username: "owner",
  passwordHash: await createPasswordHash("correct horse battery staple"),
  sessionSecret: "a".repeat(64),
  sessionTtlSeconds: 12 * 60 * 60,
  secureCookie: true
});

test("password hashes verify without storing the plain password", async () => {
  const passwordHash = await createPasswordHash("correct horse battery staple");
  assert.equal(isSupportedPasswordHash(passwordHash), true);
  assert.equal(passwordHash.includes("correct horse battery staple"), false);
  assert.equal(await verifyPassword("correct horse battery staple", passwordHash), true);
  assert.equal(await verifyPassword("wrong password", passwordHash), false);
});

test("session tokens reject tampering and expiration", async () => {
  const credentials = await buildCredentials();
  const issuedAt = Date.UTC(2026, 6, 23, 10, 0, 0);
  const token = createSessionToken(credentials, issuedAt);

  assert.equal(
    verifySessionToken(token, credentials, issuedAt + 60_000)?.sub,
    credentials.username
  );
  assert.equal(
    verifySessionToken(`${token.slice(0, -1)}x`, credentials, issuedAt + 60_000),
    null
  );
  assert.equal(
    verifySessionToken(
      token,
      credentials,
      issuedAt + credentials.sessionTtlSeconds * 1000
    ),
    null
  );
});

test("cookie parsing returns only the requested cookie", () => {
  assert.equal(
    readCookie("theme=dark; price_dashboard_session=token-value; other=1", "price_dashboard_session"),
    "token-value"
  );
  assert.equal(readCookie("theme=dark", "price_dashboard_session"), null);
});
