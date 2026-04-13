import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import getDb from "./config/database";
import priceRoutes from "./routes/priceRoutes";
import masterDataRoutes from "./routes/masterDataRoutes";
import positionRoutes from "./routes/positionRoutes";
import followRoutes from "./routes/followRoutes";
import planRoutes from "./routes/planRoutes";
import watchlistRoutes from "./routes/watchlistRoutes";
import todoCenterRoutes from "./routes/todoCenterRoutes";

const app = express();
const port = process.env.PORT || 3001;

// 配置 CORS
app.use(cors({ origin: "http://localhost:5173" }));

app.use(express.json());
app.use("/api", priceRoutes);
app.use("/api", masterDataRoutes);
app.use("/api", positionRoutes);
app.use("/api", followRoutes);
app.use("/api", planRoutes);
app.use("/api", watchlistRoutes);
app.use("/api", todoCenterRoutes);

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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Failed to initialize database:", errorMessage);
  }
};

// 启动服务器
initDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
});
