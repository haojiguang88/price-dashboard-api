import express from "express";
import getDb from "../config/database";
import {
  annualPlanLinkJoins,
  annualPlanLinkSelectFields,
  serializeAnnualPlanLink,
  validateOptionalAnnualPlanItemLink
} from "../utils/annualPlanLinks";
import { validateActiveMasterTargetByIds } from "../utils/masterData";
import { normalizeSourceContext, serializeSourceContext } from "../utils/sourceContext";

const router = express.Router();

// 验证状态枚举
const validStatuses = ["watching", "waiting_price", "waiting_signal", "archived"];
// 验证优先级枚举
const validPriorities = ["high", "medium", "low"];

const serializeWatchItem = (item: any) => serializeSourceContext({
  ...item,
  annual_plan_item_id: item.annual_plan_item_id ? String(item.annual_plan_item_id) : "",
  annual_plan_item: serializeAnnualPlanLink(item)
});

// 获取列表
router.get("/watchlist", async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.all(`
      SELECT 
        w.id, 
        w.category_id, 
        w.object_id, 
        w.variant_id, 
        w.annual_plan_item_id,
        c.name as category_name, 
        o.name as object_name, 
        CASE WHEN w.variant_id = 0 THEN '' ELSE v.name END as variant_name, 
        w.status, 
        w.priority, 
        w.reason, 
        w.source_type,
        w.source_id,
        w.source_context_json,
        w.updated_at,
        ${annualPlanLinkSelectFields}
      FROM watchlist_items w
      JOIN categories c ON w.category_id = c.id AND COALESCE(c.is_archived, 0) = 0
      JOIN objects o ON w.object_id = o.id AND o.category_id = c.id AND COALESCE(o.is_archived, 0) = 0
      LEFT JOIN variants v ON w.variant_id = v.id AND v.object_id = o.id AND COALESCE(v.is_archived, 0) = 0
      ${annualPlanLinkJoins('w')}
      WHERE w.variant_id = 0 OR v.id IS NOT NULL
      ORDER BY w.updated_at DESC
    `);
    
    res.json({ success: true, data: rows.map(serializeWatchItem), message: "获取观察池列表成功" });
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
        w.annual_plan_item_id,
        c.name as category_name, 
        o.name as object_name, 
        CASE WHEN w.variant_id = 0 THEN '' ELSE v.name END as variant_name, 
        w.status, 
        w.priority, 
        w.reason, 
        w.watch_points, 
        w.risks, 
        w.note, 
        w.source_type,
        w.source_id,
        w.source_context_json,
        w.created_at, 
        w.updated_at,
        ${annualPlanLinkSelectFields}
      FROM watchlist_items w
      JOIN categories c ON w.category_id = c.id AND COALESCE(c.is_archived, 0) = 0
      JOIN objects o ON w.object_id = o.id AND o.category_id = c.id AND COALESCE(o.is_archived, 0) = 0
      LEFT JOIN variants v ON w.variant_id = v.id AND v.object_id = o.id AND COALESCE(v.is_archived, 0) = 0
      ${annualPlanLinkJoins('w')}
      WHERE w.id = ? AND (w.variant_id = 0 OR v.id IS NOT NULL)
    `, [id]);
    
    if (!item) {
      return res.status(404).json({ success: false, message: "观察池项目不存在" });
    }
    
    res.json({ success: true, data: serializeWatchItem(item), message: "获取观察池项目详情成功" });
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
      note,
      annual_plan_item_id,
      source_type,
      source_id,
      source_context
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
    const masterTarget = await validateActiveMasterTargetByIds(db, category_id, object_id, variant_id);
    if (!masterTarget.ok) {
      return res.status(400).json({ success: false, message: masterTarget.message });
    }

    const annualPlanLink = await validateOptionalAnnualPlanItemLink(db, annual_plan_item_id);
    if (!annualPlanLink.ok) {
      return res.status(400).json({ success: false, message: annualPlanLink.message });
    }
    const source = normalizeSourceContext({ source_type, source_id, source_context });

    const duplicateItem = await db.get(
      `SELECT id FROM watchlist_items
       WHERE category_id = ? AND object_id = ? AND variant_id = ?
       LIMIT 1`,
      [masterTarget.target.category_id, masterTarget.target.object_id, masterTarget.target.variant_id]
    );
    if (duplicateItem) {
      return res.status(409).json({ success: false, message: "该对象已在观察池中" });
    }
    
    const result = await db.run(
      `INSERT INTO watchlist_items 
       (category_id, object_id, variant_id, annual_plan_item_id, status, priority, reason, watch_points, risks, note, source_type, source_id, source_context_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        masterTarget.target.category_id,
        masterTarget.target.object_id,
        masterTarget.target.variant_id,
        annualPlanLink.value,
        status,
        priority,
        reason,
        watch_points,
        risks,
        note,
        source.sourceType,
        source.sourceId,
        source.sourceContextJson,
        now,
        now
      ]
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
      note,
      annual_plan_item_id,
      source_type,
      source_id,
      source_context
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
    const existingItem = await db.get("SELECT id, annual_plan_item_id, source_type, source_id, source_context_json FROM watchlist_items WHERE id = ?", [id]);
    if (!existingItem) {
      return res.status(404).json({ success: false, message: "观察池项目不存在" });
    }

    const masterTarget = await validateActiveMasterTargetByIds(db, category_id, object_id, variant_id);
    if (!masterTarget.ok) {
      return res.status(400).json({ success: false, message: masterTarget.message });
    }

    const annualPlanItemIdInput = Object.prototype.hasOwnProperty.call(req.body, 'annual_plan_item_id')
      ? annual_plan_item_id
      : existingItem.annual_plan_item_id;
    const annualPlanLink = await validateOptionalAnnualPlanItemLink(db, annualPlanItemIdInput);
    if (!annualPlanLink.ok) {
      return res.status(400).json({ success: false, message: annualPlanLink.message });
    }
    const hasSourceInput = ['source_type', 'source_id', 'source_context']
      .some(key => Object.prototype.hasOwnProperty.call(req.body, key));
    const source = hasSourceInput
      ? normalizeSourceContext({ source_type, source_id, source_context })
      : {
          sourceType: existingItem.source_type || null,
          sourceId: existingItem.source_id || null,
          sourceContextJson: existingItem.source_context_json || null
        };

    const duplicateItem = await db.get(
      `SELECT id FROM watchlist_items
       WHERE category_id = ? AND object_id = ? AND variant_id = ? AND id != ?
       LIMIT 1`,
      [masterTarget.target.category_id, masterTarget.target.object_id, masterTarget.target.variant_id, id]
    );
    if (duplicateItem) {
      return res.status(409).json({ success: false, message: "该对象已在观察池中" });
    }
    
    const result = await db.run(
      `UPDATE watchlist_items 
       SET category_id = ?, object_id = ?, variant_id = ?, annual_plan_item_id = ?, status = ?, priority = ?, reason = ?, watch_points = ?, risks = ?, note = ?, source_type = ?, source_id = ?, source_context_json = ?, updated_at = ?
       WHERE id = ?`,
      [
        masterTarget.target.category_id,
        masterTarget.target.object_id,
        masterTarget.target.variant_id,
        annualPlanLink.value,
        status,
        priority,
        reason,
        watch_points,
        risks,
        note,
        source.sourceType,
        source.sourceId,
        source.sourceContextJson,
        now,
        id
      ]
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
