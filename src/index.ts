import express from "express";
import cors from "cors";
import getDb from "./config/database";
import priceRoutes from "./routes/priceRoutes";
import masterDataRoutes from "./routes/masterDataRoutes";
import positionRoutes from "./routes/positionRoutes";
import followRoutes from "./routes/followRoutes";
import planRoutes from "./routes/planRoutes";

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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
