import type { Express, RequestHandler } from "express";

export type DeploymentMode = "local" | "remote";

export interface ServerSecurityConfig {
  nodeEnv: string;
  deploymentMode: DeploymentMode;
  host: string;
  port: number;
  publicBaseUrl: string | null;
  trustProxy: false | "loopback";
  authMode: "none" | "trusted_reverse_proxy";
  identityHeader: string | null;
}

export class ServerSecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerSecurityConfigError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_DEVELOPMENT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://[::1]:5173"
];

const normalizeHost = (value: string) => {
  const normalized = value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
};

export const isLoopbackHost = (value: string) => LOOPBACK_HOSTS.has(normalizeHost(value));

export const resolveAllowedCorsOrigins = (
  config: ServerSecurityConfig,
  configuredOrigins: string[]
) => new Set([
  ...(config.deploymentMode === "local" ? LOCAL_DEVELOPMENT_ORIGINS : []),
  ...configuredOrigins
]);

const parsePort = (value: string | undefined) => {
  const port = Number(value || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServerSecurityConfigError("PORT must be an integer between 1 and 65535");
  }
  return port;
};

const parseDeploymentMode = (value: string | undefined, isProduction: boolean): DeploymentMode => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    if (isProduction) {
      throw new ServerSecurityConfigError("Production requires an explicit DEPLOYMENT_MODE=local or remote");
    }
    return "local";
  }
  if (normalized !== "local" && normalized !== "remote") {
    throw new ServerSecurityConfigError("DEPLOYMENT_MODE must be local or remote");
  }
  return normalized;
};

const parseHttpsPublicBaseUrl = (value: string | undefined) => {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new ServerSecurityConfigError("Remote deployment requires PUBLIC_BASE_URL");
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:") {
      throw new ServerSecurityConfigError("Remote PUBLIC_BASE_URL must use HTTPS");
    }
    return parsed.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof ServerSecurityConfigError) throw error;
    throw new ServerSecurityConfigError("PUBLIC_BASE_URL must be a valid HTTPS URL");
  }
};

const parseIdentityHeader = (value: string | undefined) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || !/^[a-z0-9-]+$/.test(normalized)) {
    throw new ServerSecurityConfigError("Remote deployment requires a valid AUTH_IDENTITY_HEADER");
  }
  return normalized;
};

const assertRemoteCorsOriginsUseHttps = (value: string | undefined) => {
  const origins = String(value || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new ServerSecurityConfigError("Remote deployment requires explicit CORS_ORIGINS");
  }
  for (const origin of origins) {
    try {
      if (new URL(origin).protocol !== "https:") {
        throw new ServerSecurityConfigError("Remote CORS_ORIGINS must use HTTPS");
      }
    } catch (error) {
      if (error instanceof ServerSecurityConfigError) throw error;
      throw new ServerSecurityConfigError("Remote CORS_ORIGINS contains an invalid URL");
    }
  }
};

export const resolveServerSecurityConfig = (
  env: NodeJS.ProcessEnv = process.env
): ServerSecurityConfig => {
  const nodeEnv = String(env.NODE_ENV || "development").trim().toLowerCase();
  const isProduction = nodeEnv === "production";
  const deploymentMode = parseDeploymentMode(env.DEPLOYMENT_MODE, isProduction);
  const host = String(env.HOST || "127.0.0.1").trim();
  const port = parsePort(env.PORT);

  if (isProduction && !isLoopbackHost(host)) {
    throw new ServerSecurityConfigError(
      "Production API must bind to loopback and be exposed only through an authenticated HTTPS reverse proxy"
    );
  }

  if (deploymentMode === "local") {
    if (isProduction && !isLoopbackHost(host)) {
      throw new ServerSecurityConfigError("Local production mode requires a loopback HOST");
    }
    return {
      nodeEnv,
      deploymentMode,
      host,
      port,
      publicBaseUrl: null,
      trustProxy: false,
      authMode: "none",
      identityHeader: null
    };
  }

  if (!isLoopbackHost(host)) {
    throw new ServerSecurityConfigError("Remote mode still requires a loopback HOST behind the reverse proxy");
  }
  if (String(env.TRUST_PROXY || "").trim().toLowerCase() !== "loopback") {
    throw new ServerSecurityConfigError("Remote mode requires TRUST_PROXY=loopback");
  }
  if (String(env.SERVER_AUTH_MODE || "").trim().toLowerCase() !== "trusted_reverse_proxy") {
    throw new ServerSecurityConfigError(
      "Remote mode requires SERVER_AUTH_MODE=trusted_reverse_proxy; frontend tokens are not accepted"
    );
  }

  assertRemoteCorsOriginsUseHttps(env.CORS_ORIGINS);
  return {
    nodeEnv,
    deploymentMode,
    host,
    port,
    publicBaseUrl: parseHttpsPublicBaseUrl(env.PUBLIC_BASE_URL),
    trustProxy: "loopback",
    authMode: "trusted_reverse_proxy",
    identityHeader: parseIdentityHeader(env.AUTH_IDENTITY_HEADER)
  };
};

const isDirectLoopbackHealthRequest = (req: Parameters<RequestHandler>[0]) => {
  const remoteAddress = normalizeHost(String(req.socket.remoteAddress || ""));
  return req.path === "/health"
    && isLoopbackHost(remoteAddress)
    && !req.headers["x-forwarded-for"];
};

export const applyServerSecurity = (app: Express, config: ServerSecurityConfig) => {
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
};

export const createRemoteAuthenticationMiddleware = (
  config: ServerSecurityConfig
): RequestHandler => {
  if (config.deploymentMode !== "remote") {
    return (_req, _res, next) => next();
  }

  const identityHeader = config.identityHeader as string;
  return (req, res, next) => {
    if (isDirectLoopbackHealthRequest(req)) {
      next();
      return;
    }
    if (!req.secure) {
      res.status(426).json({ status: "error", code: "https_required", message: "HTTPS is required" });
      return;
    }
    if (!req.headers["x-forwarded-for"]) {
      res.status(403).json({
        status: "error",
        code: "reverse_proxy_required",
        message: "Authenticated reverse proxy required"
      });
      return;
    }

    const identity = String(req.get(identityHeader) || "").trim();
    if (!identity) {
      res.status(401).json({ status: "error", code: "authentication_required", message: "Authentication required" });
      return;
    }

    res.locals.authenticatedIdentity = identity;
    next();
  };
};
