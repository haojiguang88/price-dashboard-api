import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import getDb, { getDatabasePath } from "./config/database";
import { runMigrations } from "./migrations";
import { cleanupTaskCenterStartupState, startTaskCenterScheduler } from "./services/taskCenterScheduler";
import { registerApiRoutes } from "./routes/apiRouteRegistry";

const app = express();
const appWorkspace = "business";
const port = process.env.PORT || 3001;

// 配置 CORS
const configuredCorsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

const allowedLocalOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://[::1]:5173",
  ...configuredCorsOrigins
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedLocalOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS origin not allowed: ${origin}`));
  }
}));

app.use(express.json({ limit: "20mb" }));
registerApiRoutes(app);

app.get("/db-test", async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.get("SELECT 1 + 1 as result");
    res.json({ status: "success", message: "Database connection established", result: result });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "Database connection failed", error: errorMessage });
  }
});

app.get("/", (req, res) => {
  res.json({ message: "Price Dashboard API", status: "running", version: "1.0.0", app_workspace: appWorkspace });
});

app.get("/health", (req, res) => {
  const dbPath = getDatabasePath();
  res.json({
    status: "healthy",
    app_workspace: appWorkspace,
    db_path: dbPath,
    external_storage: dbPath.startsWith("/Volumes/")
  });
});

// 初始化数据库连接
const initDatabase = async () => {
  try {
    await getDb();
    console.log("Database initialized successfully");
    
    // 执行迁移
    const dbPath = getDatabasePath();
    await runMigrations(dbPath);
    console.log("Migrations executed successfully");
    await cleanupTaskCenterStartupState();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Failed to initialize database:", errorMessage);
  }
};

// 启动服务器
initDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    startTaskCenterScheduler();
  });
});
