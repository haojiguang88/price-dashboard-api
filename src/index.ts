import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import getDb from "./config/database";
import { runMigrations } from "./migrations";
import path from "path";
import priceRoutes from "./routes/priceRoutes";
import masterDataRoutes from "./routes/masterDataRoutes";
import positionRoutes from "./routes/positionRoutes";
import followRoutes from "./routes/followRoutes";
import planRoutes from "./routes/planRoutes";
import watchlistRoutes from "./routes/watchlistRoutes";
import todoCenterRoutes from "./routes/todoCenterRoutes";
import eventRecordsRoutes from "./routes/eventRecordsRoutes";
import opinionRecordsRoutes from "./routes/opinionRecordsRoutes";
import missedProjectsRoutes from "./routes/missedProjectsRoutes";
import tradeReviewsRoutes from "./routes/tradeReviewsRoutes";
import treeHangingCasesRoutes from "./routes/treeHangingCasesRoutes";
import marketReviewsRoutes from "./routes/marketReviewsRoutes";
import ruleExperiencesRoutes from "./routes/ruleExperiencesRoutes";
import originalPriceRecordsRoutes from "./routes/originalPriceRecordsRoutes";
import annualPlansRoutes from "./routes/annualPlansRoutes";
import annualPlanItemsRoutes from "./routes/annualPlanItemsRoutes";
import annualPlanItemChangesRoutes from "./routes/annualPlanItemChangesRoutes";
import endedPositionsRoutes from "./routes/endedPositionsRoutes";
import sellRecordsRoutes from "./routes/sellRecordsRoutes";
import dashboardRoutes from "./routes/dashboardRoutes";
import monitorRulesRoutes from "./routes/monitorRulesRoutes";
import abnormalMonitorRoutes from "./routes/abnormalMonitorRoutes";
import volatilityAnalysisRoutes from "./routes/volatilityAnalysisRoutes";
import elasticityAnalysisRoutes from "./routes/elasticityAnalysisRoutes";
import riskControlRoutes from "./routes/riskControlRoutes";
import financeRoutes from "./routes/financeRoutes";
import assetStructureRoutes from "./routes/assetStructureRoutes";
import metalRoutes from "./routes/metalRoutes";
import trendPhaseRoutes from "./routes/trendPhaseRoutes";
import candidatePoolRoutes from "./routes/candidatePoolRoutes";
import assetUniverseRoutes from "./routes/assetUniverseRoutes";
import taskCenterRoutes, { startTaskCenterScheduler } from "./routes/taskCenterRoutes";
import financialTradePlanRoutes from "./routes/financialTradePlanRoutes";
import footballLotteryRoutes from "./routes/footballLotteryRoutes";
import modelTrainingRoutes from "./routes/modelTrainingRoutes";
import analysisAnnotationRoutes from "./routes/analysisAnnotationRoutes";
import auditLogRoutes from "./routes/auditLogRoutes";

const app = express();
const port = process.env.PORT || 3001;

// 配置 CORS
app.use(cors({ origin: "http://localhost:5173" }));

app.use(express.json({ limit: "20mb" }));
app.use("/api", priceRoutes);
app.use("/api", masterDataRoutes);
app.use("/api", positionRoutes);
app.use("/api", followRoutes);
app.use("/api", planRoutes);
app.use("/api", watchlistRoutes);
app.use("/api", todoCenterRoutes);
app.use("/api", eventRecordsRoutes);
app.use("/api", opinionRecordsRoutes);
app.use("/api", missedProjectsRoutes);
app.use("/api", tradeReviewsRoutes);
app.use("/api", treeHangingCasesRoutes);
app.use("/api", marketReviewsRoutes);
app.use("/api", ruleExperiencesRoutes);
app.use("/api", originalPriceRecordsRoutes);
app.use("/api", annualPlansRoutes);
app.use("/api", annualPlanItemsRoutes);
app.use("/api", annualPlanItemChangesRoutes);
app.use("/api", endedPositionsRoutes);
app.use("/api", sellRecordsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/monitor-rules", monitorRulesRoutes);
app.use("/api/abnormal-monitor", abnormalMonitorRoutes);
app.use("/api/volatility-analysis", volatilityAnalysisRoutes);
app.use("/api/elasticity-analysis", elasticityAnalysisRoutes);
app.use("/api/risk", riskControlRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/finance/assets", assetStructureRoutes);
app.use("/api/finance/metals", metalRoutes);
app.use("/api/finance/trend-phase", trendPhaseRoutes);
app.use("/api/finance", candidatePoolRoutes);
app.use("/api/finance", assetUniverseRoutes);
app.use("/api/finance", financialTradePlanRoutes);
app.use("/api", taskCenterRoutes);
app.use("/api/football-lottery", footballLotteryRoutes);
app.use("/api/model-training", modelTrainingRoutes);
app.use("/api", analysisAnnotationRoutes);
app.use("/api", auditLogRoutes);

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
  res.json({ message: "Price Dashboard API", status: "running", version: "1.0.0" });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

// 初始化数据库连接
const initDatabase = async () => {
  try {
    await getDb();
    console.log("Database initialized successfully");
    
    // 执行迁移
    const dbPath = process.env.DB_PATH || path.join(process.cwd(), "db", "price_dashboard_dev.db");
    await runMigrations(dbPath);
    console.log("Migrations executed successfully");
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
