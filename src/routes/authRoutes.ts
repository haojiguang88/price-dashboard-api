import type { Express, Request, Response } from "express";
import {
  enforceRemoteRequestBoundary,
  type ServerSecurityConfig
} from "../config/serverSecurity";
import {
  clearSessionCookie,
  createSessionToken,
  readCookie,
  SESSION_COOKIE_NAME,
  setSessionCookie,
  verifyPassword,
  verifySessionToken
} from "../services/sessionAuth";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;

interface LoginAttempt {
  failures: number;
  resetAt: number;
}

const loginAttempts = new Map<string, LoginAttempt>();

const disableAuthResponseCaching = (res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
};

const getClientKey = (req: Request) => (
  String(req.ip || req.socket.remoteAddress || "unknown")
);

const getActiveAttempt = (clientKey: string, now = Date.now()) => {
  const current = loginAttempts.get(clientKey);
  if (!current || current.resetAt <= now) {
    loginAttempts.delete(clientKey);
    return null;
  }
  return current;
};

const recordLoginFailure = (clientKey: string, now = Date.now()) => {
  const current = getActiveAttempt(clientKey, now);
  const next = current
    ? { ...current, failures: current.failures + 1 }
    : { failures: 1, resetAt: now + LOGIN_WINDOW_MS };
  loginAttempts.set(clientKey, next);
  return next;
};

const sendRateLimitResponse = (
  res: Response,
  attempt: LoginAttempt
) => {
  const retryAfterSeconds = Math.max(1, Math.ceil((attempt.resetAt - Date.now()) / 1000));
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    status: "error",
    code: "login_rate_limited",
    message: "登录尝试过多，请稍后再试"
  });
};

export const registerPublicAuthRoutes = (
  app: Express,
  config: ServerSecurityConfig
) => {
  app.get("/api/auth/session", (req, res) => {
    disableAuthResponseCaching(res);
    if (!enforceRemoteRequestBoundary(req, res, config)) return;

    if (config.authMode === "none") {
      res.json({
        status: "success",
        message: "Authentication is not required",
        data: {
          authenticated: true,
          identity: "local-user",
          auth_mode: config.authMode
        }
      });
      return;
    }

    if (config.authMode === "trusted_reverse_proxy") {
      const identity = String(req.get(config.identityHeader as string) || "").trim();
      res.json({
        status: "success",
        message: identity ? "Session is active" : "Authentication is required",
        data: {
          authenticated: Boolean(identity),
          identity: identity || null,
          auth_mode: config.authMode
        }
      });
      return;
    }

    const credentials = config.sessionAuth!;
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    const session = token ? verifySessionToken(token, credentials) : null;
    res.json({
      status: "success",
      message: session ? "Session is active" : "Authentication is required",
      data: {
        authenticated: Boolean(session),
        identity: session?.sub || null,
        auth_mode: config.authMode
      }
    });
  });

  app.post("/api/auth/login", async (req, res, next) => {
    disableAuthResponseCaching(res);
    if (config.authMode !== "session" || !config.sessionAuth) {
      res.status(404).json({
        status: "error",
        code: "session_login_unavailable",
        message: "Session login is not enabled"
      });
      return;
    }
    if (!enforceRemoteRequestBoundary(req, res, config)) return;

    const clientKey = getClientKey(req);
    const activeAttempt = getActiveAttempt(clientKey);
    if (activeAttempt && activeAttempt.failures >= MAX_LOGIN_FAILURES) {
      sendRateLimitResponse(res, activeAttempt);
      return;
    }

    const username = typeof req.body?.username === "string"
      ? req.body.username.trim()
      : "";
    const password = typeof req.body?.password === "string"
      ? req.body.password
      : "";

    if (!username || !password || username.length > 100 || password.length > 512) {
      const failedAttempt = recordLoginFailure(clientKey);
      if (failedAttempt.failures >= MAX_LOGIN_FAILURES) {
        sendRateLimitResponse(res, failedAttempt);
        return;
      }
      res.status(401).json({
        status: "error",
        code: "invalid_credentials",
        message: "账号或密码不正确"
      });
      return;
    }

    try {
      const passwordMatches = await verifyPassword(
        password,
        config.sessionAuth.passwordHash
      );
      if (username !== config.sessionAuth.username || !passwordMatches) {
        const failedAttempt = recordLoginFailure(clientKey);
        if (failedAttempt.failures >= MAX_LOGIN_FAILURES) {
          sendRateLimitResponse(res, failedAttempt);
          return;
        }
        res.status(401).json({
          status: "error",
          code: "invalid_credentials",
          message: "账号或密码不正确"
        });
        return;
      }

      loginAttempts.delete(clientKey);
      const token = createSessionToken(config.sessionAuth);
      setSessionCookie(res, token, config.sessionAuth);
      res.json({
        status: "success",
        message: "登录成功",
        data: {
          authenticated: true,
          identity: config.sessionAuth.username,
          auth_mode: config.authMode
        }
      });
    } catch (error) {
      next(error);
    }
  });
};

export const registerProtectedAuthRoutes = (
  app: Express,
  config: ServerSecurityConfig
) => {
  app.post("/api/auth/logout", (_req, res) => {
    disableAuthResponseCaching(res);
    if (config.authMode === "session" && config.sessionAuth) {
      clearSessionCookie(res, config.sessionAuth);
    }
    res.json({
      status: "success",
      message: "已退出登录",
      data: {
        authenticated: false
      }
    });
  });
};
