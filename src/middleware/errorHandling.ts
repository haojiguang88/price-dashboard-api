import { randomUUID } from "crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";

const safeErrorCode = (value: unknown) => {
  const normalized = String(value || "").trim();
  return /^[a-z0-9_-]{1,80}$/i.test(normalized) ? normalized : "internal_error";
};

const SENSITIVE_ERROR_KEYS = new Set([
  "stack",
  "db_path",
  "database_path",
  "file_path",
  "filename"
]);

const redactFilesystemPaths = (value: string) => value
  .replace(/\/(?:Users|home|var|private|Volumes|www|srv|opt|etc|tmp)\/[^\s"'<>]+/g, "[redacted-path]")
  .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "[redacted-path]");

const sanitizePublicErrorValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactFilesystemPaths(value);
  if (Array.isArray(value)) return value.map(item => sanitizePublicErrorValue(item));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_ERROR_KEYS.has(key.toLowerCase()))
      .map(([key, item]) => [key, sanitizePublicErrorValue(item)])
  );
};

export const requestIdMiddleware: RequestHandler = (_req, res, next) => {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
};

export const createProductionJsonSanitizer = (isProduction: boolean): RequestHandler => {
  if (!isProduction) return (_req, _res, next) => next();

  return (_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode < 400) return originalJson(body);
      if (res.statusCode < 500) return originalJson(sanitizePublicErrorValue(body));
      const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
      return originalJson({
        status: "error",
        code: safeErrorCode(record.code),
        message: "Internal server error",
        request_id: res.locals.requestId
      });
    }) as typeof res.json;
    next();
  };
};

export const jsonNotFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({
    status: "error",
    code: "not_found",
    message: "Resource not found"
  });
};

const resolveGlobalError = (error: unknown) => {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const rawStatus = Number(candidate.status || candidate.statusCode || 500);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  if (candidate.type === "entity.parse.failed") {
    return { status: 400, code: "invalid_json", message: "Request body must contain valid JSON" };
  }
  if (status === 413) {
    return { status, code: "payload_too_large", message: "Request body is too large" };
  }
  if (error instanceof Error && error.message.startsWith("CORS origin not allowed")) {
    return { status: 403, code: "cors_forbidden", message: "Origin is not allowed" };
  }
  if (status >= 500) {
    return { status, code: "internal_error", message: "Internal server error" };
  }
  return { status, code: "request_rejected", message: "Request rejected" };
};

export const jsonErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const resolved = resolveGlobalError(error);
  console.error("Unhandled request error", {
    requestId: res.locals.requestId,
    status: resolved.status,
    error
  });
  res.status(resolved.status).json({
    status: "error",
    code: resolved.code,
    message: resolved.message,
    request_id: res.locals.requestId
  });
};
