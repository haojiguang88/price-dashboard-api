import express from "express";
import getDb from "../config/database";

const router = express.Router();

// 验证优先级枚举
const validPriorities = ["high", "medium", "low"];
// 验证状态枚举
const validStatuses = ["pending", "in_progress", "completed", "cancelled"];

// 待办中心聚合接口
router.get("/todo-center", async (req, res) => {
  try {
    const db = await getDb();
    
    // 获取买入计划待办
    const buyingPlanTodos = await db.all(`
      SELECT 
        bp.id as source_id, 
        bp.plan_name as title, 
        'buying_plan' as source_module, 
        bp.category_name || ' / ' || bp.object_name || (CASE WHEN bp.variant_name IS NOT NULL THEN ' / ' || bp.variant_name ELSE '' END) as related_label, 
        'medium' as priority, 
        bp.status, 
        NULL as due_date, 
        bp.note, 
        bp.updated_at
      FROM buying_plans bp
      WHERE bp.status IN ('pending', 'in_progress')
    `);
    
    // 获取卖出计划待办
    const sellingPlanTodos = await db.all(`
      SELECT 
        sp.id as source_id, 
        sp.plan_name as title, 
        'selling_plan' as source_module, 
        sp.category_name || ' / ' || sp.object_name || (CASE WHEN sp.variant_name IS NOT NULL THEN ' / ' || sp.variant_name ELSE '' END) as related_label, 
        'medium' as priority, 
        sp.status, 
        NULL as due_date, 
        sp.note, 
        sp.updated_at
      FROM selling_plans sp
      WHERE sp.status IN ('pending', 'in_progress')
    `);
    
    // 获取观察池待办
    const watchlistTodos = await db.all(`
      SELECT 
        w.id as source_id, 
        w.reason as title, 
        'watchlist' as source_module, 
        (SELECT c.name FROM categories c WHERE c.id = w.category_id) || ' / ' || 
        (SELECT o.name FROM objects o WHERE o.id = w.object_id) || 
        (CASE WHEN w.variant_id > 0 THEN ' / ' || (SELECT v.name FROM variants v WHERE v.id = w.variant_id) ELSE '' END) as related_label, 
        w.priority, 
        w.status, 
        NULL as due_date, 
        w.note, 
        w.updated_at
      FROM watchlist_items w
      WHERE w.status IN ('watching', 'waiting_price', 'waiting_signal')
    `);
    
    // 获取手动待办
    const manualTodos = await db.all(`
      SELECT 
        mt.id as source_id, 
        mt.title, 
        'manual_todo' as source_module, 
        '' as related_label, 
        mt.priority, 
        mt.status, 
        mt.due_date, 
        mt.note, 
        mt.updated_at
      FROM manual_todos mt
    `);
    
    // 合并所有待办，按优先级和更新时间排序
    const allTodos = [...buyingPlanTodos, ...sellingPlanTodos, ...watchlistTodos, ...manualTodos];
    allTodos.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const priorityDiff = priorityOrder[(a.priority as keyof typeof priorityOrder)] - priorityOrder[(b.priority as keyof typeof priorityOrder)];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
    
    const response = {
      success: true,
      data: {
        summary: allTodos,
        buying_plan_todos: buyingPlanTodos,
        selling_plan_todos: sellingPlanTodos,
        watchlist_todos: watchlistTodos,
        manual_todos: manualTodos
      },
      message: "获取待办中心数据成功"
    };
    
    res.json(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "获取待办中心数据失败", error: errorMessage });
  }
});

// 手动待办 - 获取列表
router.get("/manual-todos", async (req, res) => {
  try {
    const db = await getDb();
    const todos = await db.all("SELECT * FROM manual_todos ORDER BY updated_at DESC");
    res.json({ success: true, data: todos, message: "获取手动待办列表成功" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "获取手动待办列表失败", error: errorMessage });
  }
});

// 手动待办 - 获取详情
router.get("/manual-todos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const todo = await db.get("SELECT * FROM manual_todos WHERE id = ?", [id]);
    
    if (!todo) {
      return res.status(404).json({ success: false, message: "手动待办不存在" });
    }
    
    res.json({ success: true, data: todo, message: "获取手动待办详情成功" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "获取手动待办详情失败", error: errorMessage });
  }
});

// 手动待办 - 新增
router.post("/manual-todos", async (req, res) => {
  try {
    const { title, priority, status, due_date, note } = req.body;
    
    // 基础校验
    if (!title || !priority || !status) {
      return res.status(400).json({ success: false, message: "缺少必填字段" });
    }
    
    // 枚举校验
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({ success: false, message: "无效的优先级值" });
    }
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "无效的状态值" });
    }
    
    const now = new Date().toISOString();
    const db = await getDb();
    
    const result = await db.run(
      "INSERT INTO manual_todos (title, priority, status, due_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [title, priority, status, due_date, note, now, now]
    );
    
    res.json({ success: true, data: { id: result.lastID }, message: "新增手动待办成功" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "新增手动待办失败", error: errorMessage });
  }
});

// 手动待办 - 编辑
router.put("/manual-todos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, priority, status, due_date, note } = req.body;
    
    // 基础校验
    if (!title || !priority || !status) {
      return res.status(400).json({ success: false, message: "缺少必填字段" });
    }
    
    // 枚举校验
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({ success: false, message: "无效的优先级值" });
    }
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "无效的状态值" });
    }
    
    const now = new Date().toISOString();
    const db = await getDb();
    
    // 检查待办是否存在
    const existingTodo = await db.get("SELECT id FROM manual_todos WHERE id = ?", [id]);
    if (!existingTodo) {
      return res.status(404).json({ success: false, message: "手动待办不存在" });
    }
    
    const result = await db.run(
      "UPDATE manual_todos SET title = ?, priority = ?, status = ?, due_date = ?, note = ?, updated_at = ? WHERE id = ?",
      [title, priority, status, due_date, note, now, id]
    );
    
    res.json({ success: true, data: { id, changes: result.changes }, message: "编辑手动待办成功" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "编辑手动待办失败", error: errorMessage });
  }
});

// 手动待办 - 删除
router.delete("/manual-todos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    
    // 检查待办是否存在
    const existingTodo = await db.get("SELECT id FROM manual_todos WHERE id = ?", [id]);
    if (!existingTodo) {
      return res.status(404).json({ success: false, message: "手动待办不存在" });
    }
    
    const result = await db.run("DELETE FROM manual_todos WHERE id = ?", [id]);
    
    res.json({ success: true, data: { id, changes: result.changes }, message: "删除手动待办成功" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "删除手动待办失败", error: errorMessage });
  }
});

export default router;