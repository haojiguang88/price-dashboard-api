import express from "express";
import getDb from "../config/database";

const router = express.Router();

// 列表接口
router.get("/selling-plans", async (req, res) => {
  try {
    const db = await getDb();
    const plans = await db.all("SELECT * FROM selling_plans ORDER BY created_at DESC");
    res.json({ status: "success", data: plans });
  } catch (error) {
    res.status(500).json({ status: "error", message: "获取卖出计划列表失败", error: error.message });
  }
});

// 新增接口
router.post("/selling-plans", async (req, res) => {
  try {
    const db = await getDb();
    const { plan_name, category_name, object_name, variant_name, target_price, plan_quantity, note } = req.body;
    
    // 校验字段
    if (!plan_name || !category_name || !object_name || !target_price || !plan_quantity) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: plan_name, category_name, object_name, target_price, plan_quantity" });
    }
    
    // 校验价格是否为数字
    if (typeof target_price !== 'number') {
      return res.status(400).json({ status: "error", message: "目标价格必须是数字" });
    }
    
    // 校验数量是否为整数且大于 0
    if (!Number.isInteger(plan_quantity) || plan_quantity <= 0) {
      return res.status(400).json({ status: "error", message: "计划数量必须是整数且大于 0" });
    }
    
    // 标准化 variant_name
    const variant = variant_name || '';
    
    // 计算总金额
    const total_amount = target_price * plan_quantity;
    
    // 校验主数据是否存在
    const category = await db.get("SELECT * FROM categories WHERE name = ?", [category_name]);
    if (!category) {
      return res.status(400).json({ status: "error", message: "品类不存在" });
    }
    
    const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ?", [category.id, object_name]);
    if (!object) {
      return res.status(400).json({ status: "error", message: "对象不存在" });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (variant_name) {
      const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ?", [object.id, variant_name]);
      if (!variant) {
        return res.status(400).json({ status: "error", message: "变体不存在" });
      }
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run(
      "INSERT INTO selling_plans (plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [plan_name, category_name, object_name, variant, target_price, plan_quantity, total_amount, note, now, now]
    );
    res.json({ status: "success", message: "新增卖出计划成功", id: result.lastID });
  } catch (error) {
    res.status(500).json({ status: "error", message: "新增卖出计划失败", error: error.message });
  }
});

// 编辑接口
router.put("/selling-plans/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { plan_name, category_name, object_name, variant_name, target_price, plan_quantity, note } = req.body;
    
    // 校验字段
    if (!plan_name || !category_name || !object_name || !target_price || !plan_quantity) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: plan_name, category_name, object_name, target_price, plan_quantity" });
    }
    
    // 校验价格是否为数字
    if (typeof target_price !== 'number') {
      return res.status(400).json({ status: "error", message: "目标价格必须是数字" });
    }
    
    // 校验数量是否为整数且大于 0
    if (!Number.isInteger(plan_quantity) || plan_quantity <= 0) {
      return res.status(400).json({ status: "error", message: "计划数量必须是整数且大于 0" });
    }
    
    // 标准化 variant_name
    const variant = variant_name || '';
    
    // 计算总金额
    const total_amount = target_price * plan_quantity;
    
    // 校验主数据是否存在
    const category = await db.get("SELECT * FROM categories WHERE name = ?", [category_name]);
    if (!category) {
      return res.status(400).json({ status: "error", message: "品类不存在" });
    }
    
    const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ?", [category.id, object_name]);
    if (!object) {
      return res.status(400).json({ status: "error", message: "对象不存在" });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (variant_name) {
      const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ?", [object.id, variant_name]);
      if (!variant) {
        return res.status(400).json({ status: "error", message: "变体不存在" });
      }
    }
    
    // 检查计划是否存在
    const existingPlan = await db.get("SELECT * FROM selling_plans WHERE id = ?", [id]);
    if (!existingPlan) {
      return res.status(404).json({ status: "error", message: "卖出计划不存在" });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      "UPDATE selling_plans SET plan_name = ?, category_name = ?, object_name = ?, variant_name = ?, target_price = ?, plan_quantity = ?, total_amount = ?, note = ?, updated_at = ? WHERE id = ?",
      [plan_name, category_name, object_name, variant, target_price, plan_quantity, total_amount, note, now, id]
    );
    res.json({ status: "success", message: "编辑卖出计划成功", changes: result.changes });
  } catch (error) {
    res.status(500).json({ status: "error", message: "编辑卖出计划失败", error: error.message });
  }
});

// 删除接口
router.delete("/selling-plans/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查计划是否存在
    const existingPlan = await db.get("SELECT * FROM selling_plans WHERE id = ?", [id]);
    if (!existingPlan) {
      return res.status(404).json({ status: "error", message: "卖出计划不存在" });
    }
    
    // 删除记录
    const result = await db.run("DELETE FROM selling_plans WHERE id = ?", [id]);
    res.json({ status: "success", message: "删除卖出计划成功", changes: result.changes });
  } catch (error) {
    res.status(500).json({ status: "error", message: "删除卖出计划失败", error: error.message });
  }
});

export default router;