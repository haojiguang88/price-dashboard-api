import express from "express";
import getDb from "../config/database";
import { searchGlobalRecords } from "../services/globalSearchService";

const router = express.Router();

router.get("/global-search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) {
      return res.json({ success: true, data: { query: "", items: [], total: 0 } });
    }
    if (query.length > 120) {
      return res.status(400).json({ success: false, message: "搜索关键词不能超过 120 个字符" });
    }
    const limit = Math.min(60, Math.max(1, Number.parseInt(String(req.query.limit || "40"), 10) || 40));
    const db = await getDb();
    const items = await searchGlobalRecords(db, query, limit);
    res.json({ success: true, data: { query, items, total: items.length } });
  } catch (error) {
    console.error("Error running global search:", error);
    res.status(500).json({ success: false, message: "全局搜索失败" });
  }
});

export default router;
