import express from "express";
import getDb from "../config/database";

const router = express.Router();

// 获取关注列表接口
router.get("/follows", async (req, res) => {
  try {
    const db = await getDb();
    const follows = await db.all("SELECT * FROM follows ORDER BY created_at DESC");
    res.json({ status: "success", data: follows });
  } catch (error) {
    res.status(500).json({ status: "error", message: "获取关注列表失败", error: error.message });
  }
});

// 新增关注接口
router.post("/follows", async (req, res) => {
  try {
    const db = await getDb();
    const { category_id, object_id, variant_id } = req.body;
    
    // 校验字段
    if (!category_id || !object_id || variant_id === undefined) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: category_id, object_id, variant_id" });
    }
    
    // 校验品类是否存在
    const category = await db.get("SELECT * FROM categories WHERE id = ?", [category_id]);
    if (!category) {
      return res.status(400).json({ status: "error", message: "品类不存在" });
    }
    
    // 校验对象是否存在且属于该品类
    const object = await db.get("SELECT * FROM objects WHERE id = ? AND category_id = ?", [object_id, category_id]);
    if (!object) {
      return res.status(400).json({ status: "error", message: "对象不存在或不属于该品类" });
    }
    
    // 校验变体
    let variant_name = "";
    if (variant_id > 0) {
      const variant = await db.get("SELECT * FROM variants WHERE id = ? AND object_id = ?", [variant_id, object_id]);
      if (!variant) {
        return res.status(400).json({ status: "error", message: "变体不存在或不属于该对象" });
      }
      variant_name = variant.name;
    }
    
    // 检查是否已关注（幂等处理）
    const existingFollow = await db.get(
      "SELECT * FROM follows WHERE category_id = ? AND object_id = ? AND variant_id = ?",
      [category_id, object_id, variant_id]
    );
    
    if (existingFollow) {
      // 已关注，返回成功状态
      return res.json({ status: "success", message: "已关注", already_followed: true });
    }
    
    // 插入关注记录
    try {
      const result = await db.run(
        "INSERT INTO follows (category_id, object_id, variant_id, category_name, object_name, variant_name) VALUES (?, ?, ?, ?, ?, ?)",
        [category_id, object_id, variant_id, category.name, object.name, variant_name]
      );
      res.json({ status: "success", message: "已关注", id: result.lastID });
    } catch (error) {
      if (error.message.includes("UNIQUE constraint failed")) {
        // 重复关注，返回已关注状态
        return res.json({ status: "success", message: "已关注", already_followed: true });
      }
      throw error;
    }
  } catch (error) {
    res.status(500).json({ status: "error", message: "关注失败", error: error.message });
  }
});

// 取消关注接口
router.delete("/follows", async (req, res) => {
  try {
    const db = await getDb();
    const { category_id, object_id, variant_id } = req.body;
    
    // 校验字段
    if (!category_id || !object_id || variant_id === undefined) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: category_id, object_id, variant_id" });
    }
    
    // 删除关注记录
    const result = await db.run(
      "DELETE FROM follows WHERE category_id = ? AND object_id = ? AND variant_id = ?",
      [category_id, object_id, variant_id]
    );
    
    if (result.changes === 0) {
      return res.json({ status: "success", message: "已取消关注", already_unfollowed: true });
    }
    
    res.json({ status: "success", message: "已取消关注" });
  } catch (error) {
    res.status(500).json({ status: "error", message: "取消关注失败", error: error.message });
  }
});

// 获取关注卡片接口
router.get("/follow-cards", async (req, res) => {
  try {
    const db = await getDb();
    
    // 查询所有品类
    const categories = await db.all("SELECT id, name FROM categories");
    
    const result = [];
    
    for (const category of categories) {
      // 查询该品类下的所有关注记录
      const follows = await db.all(
        "SELECT * FROM follows WHERE category_id = ?",
        [category.id]
      );
      
      const items = [];
      let latestDate = "";
      
      for (const follow of follows) {
        // 查询价格记录，按date DESC, id DESC排序
        const priceRecords = await db.all(
          "SELECT * FROM price_records WHERE category = ? AND object_name = ? AND (variant = ? OR variant IS NULL) ORDER BY date DESC, id DESC",
          [follow.category_name, follow.object_name, follow.variant_name]
        );
        
        if (priceRecords.length > 0) {
          // 计算价格信息
          const highestPrice = Math.max(...priceRecords.map(r => r.price));
          const lowestPrice = Math.min(...priceRecords.map(r => r.price));
          const currentPrice = priceRecords[0].price;
          const currentDate = priceRecords[0].date;
          
          // 记录最新日期
          if (!latestDate || currentDate > latestDate) {
            latestDate = currentDate;
          }
          
          // 计算上一次价格
          let previousPrice = null;
          let previousDate = "";
          let changeFromPrevious = null;
          
          if (priceRecords.length > 1) {
            previousPrice = priceRecords[1].price;
            previousDate = priceRecords[1].date;
            changeFromPrevious = currentPrice - previousPrice;
          }
          
          // 找到最高价格的最后一次出现记录
          let highestPriceRecord = null;
          for (const record of priceRecords) {
            if (record.price === highestPrice) {
              highestPriceRecord = record;
            }
          }
          const highestDate = highestPriceRecord ? highestPriceRecord.date : currentDate;
          
          // 找到最低价格的最后一次出现记录
          let lowestPriceRecord = null;
          for (const record of priceRecords) {
            if (record.price === lowestPrice) {
              lowestPriceRecord = record;
            }
          }
          const lowestDate = lowestPriceRecord ? lowestPriceRecord.date : currentDate;
          
          // 构建display_name
          let displayName = follow.object_name;
          if (follow.variant_name) {
            displayName += ` - ${follow.variant_name}`;
          }
          
          items.push({
            follow_id: follow.id,
            object_id: follow.object_id,
            object_name: follow.object_name,
            variant_id: follow.variant_id.toString(),
            variant_name: follow.variant_name,
            display_name: displayName,
            highest_price: highestPrice,
            highest_date: highestDate,
            lowest_price: lowestPrice,
            lowest_date: lowestDate,
            previous_price: priceRecords.length > 1 ? previousPrice : "-",
            previous_date: priceRecords.length > 1 ? previousDate : "",
            current_price: currentPrice,
            current_date: currentDate,
            change_from_previous: priceRecords.length > 1 ? changeFromPrevious : "-"
          });
        }
      }
      
      // 构建品类卡片数据
      result.push({
        category_id: category.id,
        category_name: category.name,
        updated_at_date: items.length > 0 ? latestDate : "",
        items: items
      });
    }
    
    res.json({ status: "success", data: result });
  } catch (error) {
    res.status(500).json({ status: "error", message: "获取关注卡片失败", error: error.message });
  }
});

export default router;