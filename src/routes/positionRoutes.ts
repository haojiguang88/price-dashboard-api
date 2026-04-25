import express from "express";
import getDb from "../config/database";

const router = express.Router();



// 持仓列表接口
router.get("/positions", async (req, res) => {
  try {
    const db = await getDb();
    const positions = await db.all(`
      SELECT 
        p.id, 
        p.category_name, 
        p.object_name, 
        p.variant_name, 
        SUM(pb.remaining_quantity) as total_quantity, 
        SUM(pb.batch_price * pb.remaining_quantity) as total_cost, 
        CASE WHEN SUM(pb.remaining_quantity) > 0 
          THEN SUM(pb.batch_price * pb.remaining_quantity) / SUM(pb.remaining_quantity) 
          ELSE 0 
        END as avg_price, 
        pr.price as current_price, 
        CASE WHEN pr.price IS NOT NULL AND SUM(pb.remaining_quantity) > 0 
          THEN (pr.price * SUM(pb.remaining_quantity)) - SUM(pb.batch_price * pb.remaining_quantity) 
          ELSE NULL 
        END as total_profit, 
        CASE WHEN pr.price IS NOT NULL AND SUM(pb.batch_price * pb.remaining_quantity) > 0 
          THEN ((pr.price * SUM(pb.remaining_quantity)) - SUM(pb.batch_price * pb.remaining_quantity)) / SUM(pb.batch_price * pb.remaining_quantity) * 100 
          ELSE NULL 
        END as profit_rate, 
        p.created_at, 
        p.updated_at 
      FROM positions p 
      JOIN position_batches pb ON p.id = pb.position_id 
      LEFT JOIN (
        SELECT 
          category, 
          object_name, 
          COALESCE(variant, '') as variant, 
          price, 
          date 
        FROM (
          SELECT 
            category, 
            object_name, 
            COALESCE(variant, '') as variant, 
            price, 
            date, 
            ROW_NUMBER() OVER (PARTITION BY category, object_name, COALESCE(variant, '') ORDER BY date DESC) as rn 
          FROM price_records 
        ) as latest_prices 
        WHERE rn = 1 
      ) as pr ON p.category_name = pr.category AND p.object_name = pr.object_name AND COALESCE(p.variant_name, '') = pr.variant 
      GROUP BY 
        p.id, 
        p.category_name, 
        p.object_name, 
        p.variant_name, 
        pr.price, 
        p.created_at, 
        p.updated_at 
      HAVING SUM(pb.remaining_quantity) > 0 
      ORDER BY p.created_at DESC 
    `);
    res.json({ status: "success", data: positions });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取持仓列表失败", error: errorMessage });
  }
});

// 根据仓位 ID 获取批次列表接口
router.get("/positions/:id/batches", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 验证仓位是否存在
    const position = await db.get("SELECT * FROM positions WHERE id = ?", [id]);
    if (!position) {
      return res.status(404).json({ status: "error", message: "仓位不存在" });
    }
    
    // 获取该仓位的所有批次，按 batch_date 升序
    const batches = await db.all(
      `SELECT id, source_id, position_id, batch_date, batch_price, batch_quantity, batch_cost, remaining_quantity, note, created_at, updated_at 
       FROM position_batches 
       WHERE position_id = ? 
       ORDER BY batch_date ASC`,
      [id]
    );
    
    res.json({ status: "success", data: batches });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取批次列表失败", error: errorMessage });
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取批次列表失败", error: errorMessage });
  }
});

// 新增批次接口
router.post("/position-batches", async (req, res) => {
  try {
    const db = await getDb();
    const { category_name, object_name, variant_name, category_id, object_id, variant_id, batch_price, batch_quantity, batch_date, note } = req.body;
    
    // 校验价格是否为数字
    if (typeof batch_price !== 'number') {
      return res.status(400).json({ status: "error", message: "批次价格必须是数字" });
    }
    
    // 校验数量是否为整数且大于 0
    if (!Number.isInteger(batch_quantity) || batch_quantity <= 0) {
      return res.status(400).json({ status: "error", message: "批次数量必须是整数且大于 0" });
    }
    
    // 校验日期
    if (!batch_date) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: batch_date" });
    }
    
    // 处理两种口径
    let final_category_name, final_object_name, final_variant_name = '';
    
    if (category_id && object_id) {
      // id 口径
      // 根据 category_id 查 category_name
      const category = await db.get("SELECT * FROM categories WHERE id = ?", [category_id]);
      if (!category) {
        return res.status(400).json({ status: "error", message: "品类不存在" });
      }
      final_category_name = category.name;
      
      // 根据 object_id 查 object_name
      const object = await db.get("SELECT * FROM objects WHERE id = ?", [object_id]);
      if (!object) {
        return res.status(400).json({ status: "error", message: "对象不存在" });
      }
      final_object_name = object.name;
      
      // 如果 variant_id 非空，查 variant_name
      if (variant_id) {
        const variant = await db.get("SELECT * FROM variants WHERE id = ?", [variant_id]);
        if (!variant) {
          return res.status(400).json({ status: "error", message: "变体不存在" });
        }
        final_variant_name = variant.name;
      }
    } else if (category_name && object_name) {
      // name 口径
      final_category_name = category_name;
      final_object_name = object_name;
      final_variant_name = variant_name || '';
    } else {
      // 两种口径都没有
      return res.status(400).json({ status: "error", message: "缺少必填字段: 请提供 category_name/object_name 或 category_id/object_id" });
    }
    
    // 标准化 variant_name
    const variant = final_variant_name || '';
    
    // 计算批次成本
    const batch_cost = batch_price * batch_quantity;
    
    // 校验主数据是否存在（name 口径）
    if (!category_id && !object_id) {
      const category = await db.get("SELECT * FROM categories WHERE name = ?", [final_category_name]);
      if (!category) {
        return res.status(400).json({ status: "error", message: "品类不存在" });
      }
      
      const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ?", [category.id, final_object_name]);
      if (!object) {
        return res.status(400).json({ status: "error", message: "对象不存在" });
      }
      
      // 如果 variant_name 不为空，校验变体是否存在
      if (final_variant_name) {
        const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ?", [object.id, final_variant_name]);
        if (!variant) {
          return res.status(400).json({ status: "error", message: "变体不存在" });
        }
      }
    }
    
    // 开始事务
    await db.run("BEGIN TRANSACTION");
    
    try {
      // 查找或创建持仓记录
      let position = await db.get(
        "SELECT * FROM positions WHERE category_name = ? AND object_name = ? AND variant_name = ?",
        [final_category_name, final_object_name, variant]
      );
      
      if (!position) {
        // 创建新持仓记录
        const now = new Date().toISOString();
        const result = await db.run(
          "INSERT INTO positions (category_name, object_name, variant_name, total_quantity, total_cost, avg_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [final_category_name, final_object_name, variant, 0, 0, 0, now, now]
        );
        position = { id: result.lastID };
      }
      
      // 插入批次记录，确保 remaining_quantity 初始等于 batch_quantity
      const now = new Date().toISOString();
      const batchResult = await db.run(
        "INSERT INTO position_batches (position_id, batch_price, batch_quantity, batch_cost, remaining_quantity, batch_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [position.id, batch_price, batch_quantity, batch_cost, batch_quantity, batch_date, note, now, now]
      );
      
      // 提交事务
      await db.run("COMMIT");
      
      res.json({ 
        status: "success", 
        message: "新增持仓批次成功", 
        id: batchResult.lastID,
        data: {
          position_id: position.id
        }
      });
    } catch (error) {
      // 回滚事务
      await db.run("ROLLBACK");
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "新增持仓批次失败", error: errorMessage });
  }
});

// 编辑批次接口
router.put("/position-batches/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { batch_price, batch_quantity, batch_date, note } = req.body;
    
    // 检查批次是否存在
    const existingBatch = await db.get("SELECT * FROM position_batches WHERE id = ?", [id]);
    if (!existingBatch) {
      return res.status(404).json({ status: "error", message: "批次不存在" });
    }
    
    // 检查批次是否有关联的卖出记录
    const hasSellRecords = await db.get("SELECT COUNT(*) as count FROM sell_records WHERE batch_id = ?", [id]);
    
    // 开始事务
    await db.run("BEGIN TRANSACTION");
    
    try {
      if (hasSellRecords && hasSellRecords.count > 0) {
        // 已有关联卖出记录，只允许修改 note
        if (!note) {
          return res.status(400).json({ status: "error", message: "已有关联卖出记录，仅允许修改备注" });
        }
        
        // 更新批次记录（只更新 note）
        const now = new Date().toISOString();
        await db.run(
          "UPDATE position_batches SET note = ?, updated_at = ? WHERE id = ?",
          [note, now, id]
        );
      } else {
        // 无关联卖出记录，允许修改所有字段
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
        
        // 更新批次记录
        const now = new Date().toISOString();
        await db.run(
          "UPDATE position_batches SET batch_price = ?, batch_quantity = ?, batch_cost = ?, remaining_quantity = ?, batch_date = ?, note = ?, updated_at = ? WHERE id = ?",
          [batch_price, batch_quantity, batch_cost, batch_quantity, batch_date, note, now, id]
        );
      }
      
      // 提交事务
      await db.run("COMMIT");
      
      // 获取更新后的批次数据
      const updatedBatch = await db.get("SELECT * FROM position_batches WHERE id = ?", [id]);
      
      res.json({ 
        status: "success", 
        message: "编辑持仓批次成功", 
        data: {
          batch: updatedBatch
        }
      });
    } catch (error) {
      // 回滚事务
      await db.run("ROLLBACK");
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "编辑持仓批次失败", error: errorMessage });
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
    
    // 开始事务
    await db.run("BEGIN TRANSACTION");
    
    try {
      // 插入新批次记录，确保 remaining_quantity 初始等于 batch_quantity
      const now = new Date().toISOString();
      const batchResult = await db.run(
        "INSERT INTO position_batches (position_id, batch_price, batch_quantity, batch_cost, remaining_quantity, batch_date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [existingBatch.position_id, existingBatch.batch_price, existingBatch.batch_quantity, existingBatch.batch_cost, existingBatch.batch_quantity, existingBatch.batch_date, existingBatch.note, now, now]
      );
      
      // 提交事务
      await db.run("COMMIT");
      
      res.json({ status: "success", message: "复制持仓批次成功", id: batchResult.lastID });
    } catch (error) {
      // 回滚事务
      await db.run("ROLLBACK");
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "复制持仓批次失败", error: errorMessage });
  }
});

// 卖出接口
router.post("/positions/:id/sell", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { batch_id, quantity, price, sell_date, note } = req.body;
    
    // 校验参数
    if (!batch_id || !quantity || !price || !sell_date) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: batch_id, quantity, price, sell_date" });
    }
    
    // 校验卖出数量是否为正整数
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ status: "error", message: "卖出数量必须是正整数" });
    }
    
    // 校验卖出价格是否为正数
    if (typeof price !== 'number' || price <= 0) {
      return res.status(400).json({ status: "error", message: "卖出价格必须是正数" });
    }
    
    // 开始事务
    await db.run("BEGIN TRANSACTION");
    
    try {
      // 检查批次是否存在且属于指定仓位
      const batch = await db.get("SELECT * FROM position_batches WHERE id = ? AND position_id = ?", [batch_id, id]);
      if (!batch) {
        throw new Error("批次不存在或不属于指定仓位");
      }
      
      // 检查批次剩余数量是否足够
      if (batch.remaining_quantity < quantity) {
        throw new Error("批次剩余数量不足");
      }
      
      // 获取仓位信息
      const position = await db.get("SELECT category_name, object_name, variant_name FROM positions WHERE id = ?", [id]);
      if (!position) {
        throw new Error("仓位不存在");
      }
      
      // 计算卖出金额、成本和利润
      const sell_amount = quantity * price;
      const sell_cost = quantity * batch.batch_price;
      const profit = sell_amount - sell_cost;
      
      // 创建卖出记录
      const now = new Date().toISOString();
      await db.run(
        "INSERT INTO sell_records (category_name, object_name, variant_name, quantity, price, amount, cost, profit, sell_date, buy_date, batch_id, position_id, note, ended_position_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [position.category_name, position.object_name, position.variant_name, quantity, price, sell_amount, sell_cost, profit, sell_date, batch.batch_date, batch_id, id, note, null, now, now]
      );
      
      // 扣减批次剩余数量
      const new_remaining_quantity = batch.remaining_quantity - quantity;
      await db.run(
        "UPDATE position_batches SET remaining_quantity = ?, updated_at = ? WHERE id = ?",
        [new_remaining_quantity, now, batch_id]
      );
      
      // 删除空批次
      if (new_remaining_quantity === 0) {
        await db.run("DELETE FROM position_batches WHERE id = ?", [batch_id]);
      }
      
      // 更新 ended_positions
      let endedPosition = await db.get(
        "SELECT * FROM ended_positions WHERE category_name = ? AND object_name = ? AND variant_name = ?",
        [position.category_name, position.object_name, position.variant_name || '']
      );
      
      if (endedPosition) {
        // 更新现有记录
        await db.run(
          "UPDATE ended_positions SET quantity = quantity + ?, amount = amount + ?, cost = cost + ?, profit = profit + ?, updated_at = ? WHERE id = ?",
          [quantity, sell_amount, sell_cost, profit, now, endedPosition.id]
        );
      } else {
        // 创建新记录
        await db.run(
          "INSERT INTO ended_positions (category_name, object_name, variant_name, quantity, amount, cost, profit, sell_date, buy_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [position.category_name, position.object_name, position.variant_name || '', quantity, sell_amount, sell_cost, profit, sell_date, batch.batch_date, now, now]
        );
        // 获取新创建的记录 ID
        const newEndedPosition = await db.get(
          "SELECT id FROM ended_positions WHERE category_name = ? AND object_name = ? AND variant_name = ? ORDER BY id DESC LIMIT 1",
          [position.category_name, position.object_name, position.variant_name || '']
        );
        endedPosition = newEndedPosition;
      }
      
      // 检查仓位是否为空（通过批次真相源判断）
      const batchCount = await db.get(
        "SELECT COUNT(*) as count FROM position_batches WHERE position_id = ? AND remaining_quantity > 0",
        [id]
      );
      
      // 删除空仓位
      if (batchCount && batchCount.count === 0) {
        // 回填该仓位所有未关联的卖出记录
        await db.run(
          "UPDATE sell_records SET ended_position_id = ? WHERE position_id = ? AND ended_position_id IS NULL",
          [endedPosition.id, id]
        );
        
        // 基于 sell_records 重算 ended_positions 汇总数据
        const summary = await db.get(
          "SELECT SUM(quantity) as total_quantity, SUM(amount) as total_amount, SUM(cost) as total_cost, SUM(profit) as total_profit, MAX(sell_date) as final_sell_date, MIN(buy_date) as first_buy_date FROM sell_records WHERE ended_position_id = ?",
          [endedPosition.id]
        );
        
        // 用重算结果覆盖更新 ended_positions
        await db.run(
          "UPDATE ended_positions SET quantity = ?, amount = ?, cost = ?, profit = ?, sell_date = ?, buy_date = ?, updated_at = ? WHERE id = ?",
          [
            summary.total_quantity,
            summary.total_amount,
            summary.total_cost,
            summary.total_profit,
            summary.final_sell_date,
            summary.first_buy_date,
            now,
            endedPosition.id
          ]
        );
        
        await db.run("DELETE FROM positions WHERE id = ?", [id]);
      }
      
      // 提交事务
      await db.run("COMMIT");
      
      res.json({ 
        status: "success", 
        message: "卖出成功", 
        data: {
          batch_id,
          quantity,
          price,
          sell_date,
          sell_amount,
          sell_cost,
          profit
        }
      });
    } catch (error) {
      // 回滚事务
      await db.run("ROLLBACK");
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.status(400).json({ status: "error", message: errorMessage });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "卖出失败", error: errorMessage });
  }
});

export default router;