import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import getDb, { getDatabasePath, getDatabasePolicy } from "./config/database";
import { verifyBusinessDatabaseReadiness, type DatabaseReadinessReport } from "./config/databaseValidation";
import {
  applyServerSecurity,
  createRemoteAuthenticationMiddleware,
  isLoopbackHost,
  resolveAllowedCorsOrigins,
  resolveServerSecurityConfig
} from "./config/serverSecurity";
import { getExpectedMigrationIds, runMigrations } from "./migrations";
import { cleanupTaskCenterStartupState, startTaskCenterScheduler } from "./services/taskCenterScheduler";
import { registerApiRoutes } from "./routes/apiRouteRegistry";
import {
  registerProtectedAuthRoutes,
  registerPublicAuthRoutes
} from "./routes/authRoutes";
import { requestDatabaseContextMiddleware } from "./middleware/databaseContext";
import {
  createProductionJsonSanitizer,
  jsonErrorHandler,
  jsonNotFoundHandler,
  requestIdMiddleware
} from "./middleware/errorHandling";

const appWorkspace = "business";
const securityConfig = resolveServerSecurityConfig();
const isProduction = securityConfig.nodeEnv === "production";

if (process.env.APP_WORKSPACE && process.env.APP_WORKSPACE !== appWorkspace) {
  throw new Error("APP_WORKSPACE must be business for the business API");
}

const app = express();
app.disable("x-powered-by");
applyServerSecurity(app, securityConfig);

let databaseReady = false;
let databaseReadiness: DatabaseReadinessReport | null = null;

const getStorageLocation = (dbPath: string) => (
  dbPath.startsWith(process.cwd()) ? "project_data" : "custom_path"
);

const configuredCorsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

const allowedCorsOrigins = resolveAllowedCorsOrigins(securityConfig, configuredCorsOrigins);

const isLoopbackOrigin = (origin: string) => {
  try {
    const { hostname, protocol } = new URL(origin);
    return ["http:", "https:"].includes(protocol) && isLoopbackHost(hostname);
  } catch {
    return false;
  }
};

const allowLoopbackCors = !isProduction;

app.use(requestIdMiddleware);
app.use(createProductionJsonSanitizer(isProduction));
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedCorsOrigins.has(origin) || (allowLoopbackCors && isLoopbackOrigin(origin))) {
      callback(null, true);
      return;
    }
    const error = new Error("CORS origin not allowed");
    (error as Error & { status?: number }).status = 403;
    callback(error);
  }
}));
app.use(express.json({ limit: "20mb" }));
registerPublicAuthRoutes(app, securityConfig);
app.use(createRemoteAuthenticationMiddleware(securityConfig));
registerProtectedAuthRoutes(app, securityConfig);
app.use(requestDatabaseContextMiddleware);

if (!isProduction) {
  app.get("/db-test", async (_req, res, next) => {
    try {
      const db = await getDb();
      const result = await db.get("SELECT 1 + 1 as result");
      res.json({ status: "success", message: "Database connection established", result });
    } catch (error) {
      next(error);
    }
  });
}

app.get("/", (_req, res) => {
  res.json({
    message: "Price Dashboard API",
    status: "running",
    version: "1.0.0",
    app_workspace: appWorkspace,
    deployment_mode: securityConfig.deploymentMode
  });
});

app.get("/health", async (_req, res) => {
  try {
    const db = await getDb();
    await db.get("SELECT 1 as ok");
    const response: Record<string, unknown> = {
      status: databaseReady ? "healthy" : "starting",
      app_workspace: appWorkspace,
      database_ready: databaseReady,
      database_identity: databaseReadiness?.identity || null,
      migration_count: databaseReadiness?.migrationCount || 0,
      latest_migration_id: databaseReadiness?.latestMigrationId || null,
      required_tables_ready: Boolean(databaseReadiness)
    };
    if (!isProduction) {
      const dbPath = getDatabasePath();
      response.db_path = dbPath;
      response.storage_location = getStorageLocation(dbPath);
    }
    res.status(databaseReady ? 200 : 503).json(response);
  } catch {
    res.status(503).json({
      status: "unhealthy",
      code: "database_unavailable",
      app_workspace: appWorkspace,
      database_ready: false
    });
  }
});

registerApiRoutes(app);
app.use(jsonNotFoundHandler);
app.use(jsonErrorHandler);

const initDatabase = async () => {
  databaseReady = false;
  const databasePolicy = getDatabasePolicy();
  await getDb();
  console.log("Database initialized successfully", {
    storageLocation: getStorageLocation(databasePolicy.filename),
    allowCreate: databasePolicy.allowCreate
  });

  await runMigrations(databasePolicy.filename);
  databaseReadiness = await verifyBusinessDatabaseReadiness(
    databasePolicy.filename,
    getExpectedMigrationIds()
  );
  console.log("Database readiness verified", databaseReadiness);

  await cleanupTaskCenterStartupState();
  databaseReady = true;
};

initDatabase().then(() => {
  app.listen(securityConfig.port, securityConfig.host, () => {
    console.log("Server started", {
      host: securityConfig.host,
      port: securityConfig.port,
      deploymentMode: securityConfig.deploymentMode,
      authMode: securityConfig.authMode
    });
    if (!isProduction && !isLoopbackHost(securityConfig.host)) {
      console.warn("Development API is explicitly bound to a non-loopback HOST");
    }
    startTaskCenterScheduler();
  });
}).catch((error) => {
  const errorMessage = error instanceof Error ? error.message : "Unknown startup error";
  console.error("Failed to initialize business API:", errorMessage);
  process.exit(1);
});
