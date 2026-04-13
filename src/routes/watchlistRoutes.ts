import express from "express";
import getDb from "../config/database";

const router = express.Router();

// 验证状态枚举
const validStatuses = ["watching", "waiting_price", "waiting_signal", "archived"];
// 验证优先级枚举
const validPriorities = ["high", "medium", "low"];

// 获取列表
router.get("/watchlist", async (req, res) => {
  try {
    const db = await getDb();
    const items = await db.all(`
      SELECT 
        w.id, 
        w.category_id, 
        w.object_id, 
        w.variant_id, 
        c.name as category_name, 
        o.name as object_name, 
        CASE WHEN w.variant_id = 0 THEN '' ELSE v.name END as variant_name, 
        w.status, 
        w.priority, 
        w.reason, 
        w.updated_at
      FROM watchlist_items w
      LEFT JOIN categories c ON w.category_id = c.id
      LEFT JOIN objects o ON w.object_id = o.id
      LEFT JOIN variants v ON w.variant_id = v.id
      ORDER BY w.updated_at DESC
    `);
    
    res.json({ success: true, data: items, message: "获取观察池列表成功" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "获取观察池列表失败", error: errorMessage });
  }
});

// 获取详情
router.get("/watchlist/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    
    const item = await db.get(`
      SELECT 
        w.id, 
        w.category_id, 
        w.object_id, 
        w.variant_id, 
        c.name as category_name, 
        o.name as object_name, 
        CASE WHEN w.variant_id = 0 THEN '' ELSE v.name END as variant_name, 
        w.status, 
        w.priority, 
        w.reason, 
        w.watch_points, 
        w.risks, 
        w.note, 
        w.created_at, 
        w.updated_at
      FROM watchlist_items w
      LEFT JOIN categories c ON w.category_id = c.id
      LEFT JOIN objects o ON w.object_id = o.id
      LEFT JOIN variants v ON w.variant_id = v.id
      WHERE w.id = ?
    `, [id]);
    
    if (!item) {
      return res.status(404).json({ success: false, message: "观察池项目不存在" });
    }
    
    res.json({ success: true, data: item, message: "获取观察池项目详情成功" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "获取观察池项目详情失败", error: errorMessage });
  }
});

// 新增
router.post("/watchlist", async (req, res) => {
  try {
    const {
      category_id,
      object_id,
      variant_id,
      status,
      priority,
      reason,
      watch_points,
      risks,
      note
    } = req.body;
    
    // 基础校验
    if (category_id === undefined || object_id === undefined || variant_id === undefined || !status || !priority || !reason) {
      return res.status(400).json({ success: false, message: "缺少必填字段" });
    }
    
    // 枚举校验
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "无效的状态值" });
    }
    
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({ success: false, message: "无效的优先级值" });
    }
    
    const now = new Date().toISOString();
    const db = await getDb();
    
    const result = await db.run(
      `INSERT INTO watchlist_items 
       (category_id, object_id, variant_id, status, priority, reason, watch_points, risks, note, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [category_id, object_id, variant_id, status, priority, reason, watch_points, risks, note, now, now]
    );
    
    res.json({ success: true, data: { id: result.lastID }, message: "新增观察池项目成功" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "新增观察池项目失败", error: errorMessage });
  }
});

// 编辑
router.put("/watchlist/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      category_id,
      object_id,
      variant_id,
      status,
      priority,
      reason,
      watch_points,
      risks,
      note
    } = req.body;
    
    // 基础校验
    if (category_id === undefined || object_id === undefined || variant_id === undefined || !status || !priority || !reason) {
      return res.status(400).json({ success: false, message: "缺少必填字段" });
    }
    
    // 枚举校验
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "无效的状态值" });
    }
    
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({ success: false, message: "无效的优先级值" });
    }
    
    const now = new Date().toISOString();
    const db = await getDb();
    
    // 检查项目是否存在
    const existingItem = await db.get("SELECT id FROM watchlist_items WHERE id = ?", [id]);
    if (!existingItem) {
      return res.status(404).json({ success: false, message: "观察池项目不存在" });
    }
    
    const result = await db.run(
      `UPDATE watchlist_items 
       SET category_id = ?, object_id = ?, variant_id = ?, status = ?, priority = ?, reason = ?, watch_points = ?, risks = ?, note = ?, updated_at = ? 
       WHERE id = ?`,
      [category_id, object_id, variant_id, status, priority, reason, watch_points, risks, note, now, id]
    );
    
    res.json({ success: true, data: { id, changes: result.changes }, message: "编辑观察池项目成功" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "编辑观察池项目失败", error: errorMessage });
  }
});

// 删除
router.delete("/watchlist/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    
    // 检查项目是否存在
    const existingItem = await db.get("SELECT id FROM watchlist_items WHERE id = ?", [id]);
    if (!existingItem) {
      return res.status(404).json({ success: false, message: "观察池项目不存在" });
    }
    
    const result = await db.run("DELETE FROM watchlist_items WHERE id = ?", [id]);
    
    res.json({ success: true, data: { id, changes: result.changes }, message: "删除观察池项目成功" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "删除观察池项目失败", error: errorMessage });
  }
});

export default router;