import express from "express";
import getDb from "../config/database";

const router = express.Router();

// 辅助函数：计算并更新持仓汇总
const updatePositionSummary = async (db, positionId) => {
  // 获取该持仓的所有批次
  const batches = await db.all("SELECT batch_quantity, batch_cost FROM position_batches WHERE position_id = ?", [positionId]);
  
  // 计算汇总数据
  let totalQuantity = 0;
  let totalCost = 0;
  
  batches.forEach(batch => {
    totalQuantity += batch.batch_quantity;
    totalCost += batch.batch_cost;
  });
  
  const avgPrice = totalQuantity > 0 ? totalCost / totalQuantity : 0;
  
  // 获取当前参考价
  const position = await db.get("SELECT category_name, object_name, variant_name FROM positions WHERE id = ?", [positionId]);
  let currentPrice = null;
  
  if (position) {
    const { category_name, object_name, variant_name } = position;
    const variant = variant_name || '';
    
    // 从价格记录中取最新价
    const latestPrice = await db.get(
      "SELECT price FROM price_records WHERE category = ? AND object_name = ? AND variant = ? ORDER BY date DESC LIMIT 1",
      [category_name, object_name, variant]
    );
    
    if (latestPrice) {
      currentPrice = latestPrice.price;
    }
  }
  
  // 计算盈亏
  let totalProfit = null;
  let profitRate = null;
  
  if (currentPrice && totalQuantity > 0) {
    totalProfit = (currentPrice - avgPrice) * totalQuantity;
    profitRate = totalCost > 0 ? (totalProfit / totalCost) * 100 : 0;
  }
  
  // 更新持仓汇总
  await db.run(
    "UPDATE positions SET total_quantity = ?, total_cost = ?, avg_price = ?, current_price = ?, total_profit = ?, profit_rate = ?, updated_at = ? WHERE id = ?",
    [totalQuantity, totalCost, avgPrice, currentPrice, totalProfit, profitRate, new Date().toISOString(), positionId]
  );
};

// 持仓列表接口
router.get("/positions", async (req, res) => {
  try {
    const db = await getDb();
    const positions = await db.all("SELECT * FROM positions ORDER BY created_at DESC");
    res.json({ status: "success", data: positions });
  } catch (error) {
    res.status(500).json({ status: "error", message: "获取持仓列表失败", error: error.message });
  }
});

// 批次列表接口
router.get("/position-batches", async (req, res) => {
  try {
    const db = await getDb();
    const batches = await db.all(`
      SELECT pb.*, p.category_name, p.object_name, p.variant_name
      FROM position_batches pb
      JOIN positions p ON pb.position_id = p.id
      ORDER BY pb.created_at DESC
    `);
    res.json({ status: "success", data: batches });
  } catch (error) {
    res.status(500).json({ status: "error", message: "获取批次列表失败", error: error.message });
  }
});

// 新增批次接口
router.post("/position-batches", async (req, res) => {
  try {
    const db = await getDb();
    const { category_name, object_name, variant_name, batch_price, batch_quantity, batch_date, note } = req.body;
    
    // 校验字段
    if (!category_name || !object_name || !batch_price || !batch_quantity || !batch_date) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: category_name, object_name, batch_price, batch_quantity, batch_date" });
    }
    
    // 校验价格是否为数字
    if (typeof batch_price !== 'number') {
      return res.status(400).json({ status: "error", message: "批次价格必须是数字" });
    }
    
    // 校验数量是否为整数且大于 0
    if (!Number.isInteger(batch_quantity) || batch_quantity <= 0) {
      return res.status(400).json({ status: "error", message: "批次数量必须是整数且大于 0" });
    }
    
    // 标准化 variant_name
    const variant = variant_name || '';
    
    // 计算批次成本
    const batch_cost = batch_price * batch_quantity;
    
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
    
    // 查找或创建持仓记录
    let position = await db.get(
      "SELECT * FROM positions WHERE category_name = ? AND object_name = ? AND variant_name = ?",
      [category_name, object_name, variant]
    );
    
    if (!position) {
      // 创建新持仓记录
      const now = new Date().toISOString();
      const result = await db.run(
        "INSERT INTO positions (category_name, object_name, variant_name, total_quantity, total_cost, avg_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [category_name, object_name, variant, 0, 0, 0, now, now]
      );
      position = { id: result.lastID };
    }
    
    // 插入批次记录
    const now = new Date().toISOString();
    const batchResult = await db.run(
      "INSERT INTO position_batches (position_id, batch_price, batch_quantity, batch_cost, batch_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [position.id, batch_price, batch_quantity, batch_cost, batch_date, note, now, now]
    );
    
    // 更新持仓汇总
    await updatePositionSummary(db, position.id);
    
    res.json({ status: "success", message: "新增持仓批次成功", id: batchResult.lastID });
  } catch (error) {
    res.status(500).json({ status: "error", message: "新增持仓批次失败", error: error.message });
  }
});

// 编辑批次接口
router.put("/position-batches/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { batch_price, batch_quantity, batch_date, note } = req.body;
    
    // 校验字段
    if (!batch_price || !batch_quantity || !batch_date) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: batch_price, batch_quantity, batch_date" });
    }
    
    // 校验价格是否为数字
    if (typeof batch_price !== 'number') {
      return res.status(400).json({ status: "error", message: "批次价格必须是数字" });
    }
    
    // 校验数量是否为整数且大于 0
    if (!Number.isInteger(batch_quantity) || batch_quantity <= 0) {
      return res.status(400).json({ status: "error", message: "批次数量必须是整数且大于 0" });
    }
    
    // 计算批次成本
    const batch_cost = batch_price * batch_quantity;
    
    // 检查批次是否存在
    const existingBatch = await db.get("SELECT * FROM position_batches WHERE id = ?", [id]);
    if (!existingBatch) {
      return res.status(404).json({ status: "error", message: "批次不存在" });
    }
    
    // 更新批次记录
    const now = new Date().toISOString();
    await db.run(
      "UPDATE position_batches SET batch_price = ?, batch_quantity = ?, batch_cost = ?, batch_date = ?, note = ?, updated_at = ? WHERE id = ?",
      [batch_price, batch_quantity, batch_cost, batch_date, note, now, id]
    );
    
    // 更新持仓汇总
    await updatePositionSummary(db, existingBatch.position_id);
    
    res.json({ status: "success", message: "编辑持仓批次成功", changes: 1 });
  } catch (error) {
    res.status(500).json({ status: "error", message: "编辑持仓批次失败", error: error.message });
  }
});

// 复制批次接口
router.post("/position-batches/:id/copy", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查批次是否存在
    const existingBatch = await db.get("SELECT * FROM position_batches WHERE id = ?", [id]);
    if (!existingBatch) {
      return res.status(404).json({ status: "error", message: "批次不存在" });
    }
    
    // 获取持仓信息
    const position = await db.get("SELECT * FROM positions WHERE id = ?", [existingBatch.position_id]);
    if (!position) {
      return res.status(404).json({ status: "error", message: "持仓不存在" });
    }
    
    // 插入新批次记录
    const now = new Date().toISOString();
    const batchResult = await db.run(
      "INSERT INTO position_batches (position_id, batch_price, batch_quantity, batch_cost, batch_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [existingBatch.position_id, existingBatch.batch_price, existingBatch.batch_quantity, existingBatch.batch_cost, existingBatch.batch_date, existingBatch.note, now, now]
    );
    
    // 更新持仓汇总
    await updatePositionSummary(db, existingBatch.position_id);
    
    res.json({ status: "success", message: "复制持仓批次成功", id: batchResult.lastID });
  } catch (error) {
    res.status(500).json({ status: "error", message: "复制持仓批次失败", error: error.message });
  }
});

export default router;