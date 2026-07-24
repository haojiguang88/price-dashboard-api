import {
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual
} from "node:crypto";
import type { Response } from "express";

export const SESSION_COOKIE_NAME = "price_dashboard_session";

const PASSWORD_HASH_PREFIX = "scrypt-v1";
const SESSION_TOKEN_PREFIX = "v1";
const PASSWORD_KEY_LENGTH = 64;

export interface SessionAuthCredentials {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  secureCookie: boolean;
}

export interface SessionTokenPayload {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

const derivePasswordKey = (password: string, salt: Buffer) => (
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, PASSWORD_KEY_LENGTH, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  })
);

export const createPasswordHash = async (password: string) => {
  if (password.length < 12) {
    throw new Error("Password must contain at least 12 characters");
  }
  const salt = randomBytes(16);
  const derivedKey = await derivePasswordKey(password, salt);
  return [
    PASSWORD_HASH_PREFIX,
    salt.toString("base64url"),
    derivedKey.toString("base64url")
  ].join(":");
};

export const isSupportedPasswordHash = (passwordHash: string) => {
  const [prefix, encodedSalt, encodedKey, ...extra] = passwordHash.split(":");
  if (prefix !== PASSWORD_HASH_PREFIX || !encodedSalt || !encodedKey || extra.length > 0) {
    return false;
  }
  try {
    const salt = Buffer.from(encodedSalt, "base64url");
    const key = Buffer.from(encodedKey, "base64url");
    return salt.length >= 16 && key.length === PASSWORD_KEY_LENGTH;
  } catch {
    return false;
  }
};

export const verifyPassword = async (password: string, passwordHash: string) => {
  if (!isSupportedPasswordHash(passwordHash)) return false;
  const [, encodedSalt, encodedKey] = passwordHash.split(":");
  const salt = Buffer.from(encodedSalt, "base64url");
  const expectedKey = Buffer.from(encodedKey, "base64url");
  const actualKey = await derivePasswordKey(password, salt);
  return timingSafeEqual(actualKey, expectedKey);
};

const signSessionPayload = (encodedPayload: string, secret: string) => (
  createHmac("sha256", secret)
    .update(`${SESSION_TOKEN_PREFIX}.${encodedPayload}`)
    .digest("base64url")
);

export const createSessionToken = (
  credentials: SessionAuthCredentials,
  nowMs = Date.now()
) => {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload: SessionTokenPayload = {
    sub: credentials.username,
    iat: issuedAt,
    exp: issuedAt + credentials.sessionTtlSeconds,
    jti: randomBytes(12).toString("base64url")
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signSessionPayload(encodedPayload, credentials.sessionSecret);
  return `${SESSION_TOKEN_PREFIX}.${encodedPayload}.${signature}`;
};

export const verifySessionToken = (
  token: string,
  credentials: SessionAuthCredentials,
  nowMs = Date.now()
): SessionTokenPayload | null => {
  const [prefix, encodedPayload, encodedSignature, ...extra] = token.split(".");
  if (
    prefix !== SESSION_TOKEN_PREFIX
    || !encodedPayload
    || !encodedSignature
    || extra.length > 0
  ) {
    return null;
  }

  const expectedSignature = Buffer.from(
    signSessionPayload(encodedPayload, credentials.sessionSecret),
    "base64url"
  );
  let actualSignature: Buffer;
  try {
    actualSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  if (
    actualSignature.toString("base64url") !== encodedSignature
    || actualSignature.length !== expectedSignature.length
    || !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const payloadBuffer = Buffer.from(encodedPayload, "base64url");
    if (payloadBuffer.toString("base64url") !== encodedPayload) return null;
    const payload = JSON.parse(payloadBuffer.toString("utf8")) as Partial<SessionTokenPayload>;
    const nowSeconds = Math.floor(nowMs / 1000);
    if (
      payload.sub !== credentials.username
      || !Number.isInteger(payload.iat)
      || !Number.isInteger(payload.exp)
      || typeof payload.jti !== "string"
      || payload.exp! <= nowSeconds
      || payload.iat! > nowSeconds + 60
      || payload.exp! - payload.iat! > credentials.sessionTtlSeconds
    ) {
      return null;
    }
    return payload as SessionTokenPayload;
  } catch {
    return null;
  }
};

export const readCookie = (cookieHeader: string | undefined, name: string) => {
  if (!cookieHeader) return null;
  for (const item of cookieHeader.split(";")) {
    const separatorIndex = item.indexOf("=");
    if (separatorIndex < 0) continue;
    const cookieName = item.slice(0, separatorIndex).trim();
    if (cookieName !== name) continue;
    const value = item.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
};

const cookieOptions = (credentials: SessionAuthCredentials) => ({
  httpOnly: true,
  secure: credentials.secureCookie,
  sameSite: "strict" as const,
  path: "/"
});

export const setSessionCookie = (
  res: Response,
  token: string,
  credentials: SessionAuthCredentials
) => {
  res.cookie(SESSION_COOKIE_NAME, token, {
    ...cookieOptions(credentials),
    maxAge: credentials.sessionTtlSeconds * 1000
  });
};

export const clearSessionCookie = (
  res: Response,
  credentials: SessionAuthCredentials
) => {
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions(credentials));
};
