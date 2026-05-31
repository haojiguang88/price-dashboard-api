import express from "express";
import getDb from "../config/database";
import { validateActiveMasterTargetByIds } from "../utils/masterData";

const router = express.Router();

type ParsedFollowId = { value: number; error?: never } | { value?: never; error: string };

const parseFollowId = (value: unknown, fieldName: string): ParsedFollowId => {
  const numericValue = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    return { error: `${fieldName} 必须是正整数` };
  }
  return { value: numericValue };
};

const parseFollowVariantId = (value: unknown): ParsedFollowId => {
  if (value === undefined) {
    return { error: "缺少必填字段: variant_id；无变体请传 0" };
  }
  if (value === null || (typeof value === "string" && value.trim() === "")) {
    return { error: "variant_id 禁止传空字符串；无变体请传 0" };
  }

  const numericValue = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isInteger(numericValue) || numericValue < 0) {
    return { error: "variant_id 必须是整数；有变体传整数 id，无变体传 0" };
  }
  return { value: numericValue };
};

// 获取关注列表接口
router.get("/follows", async (req, res) => {
  try {
    const db = await getDb();
    const follows = await db.all(`
      SELECT f.id, f.category_id, f.object_id,
             CASE WHEN f.variant_id IS NULL OR TRIM(CAST(f.variant_id AS TEXT)) = '' THEN 0 ELSE CAST(f.variant_id AS INTEGER) END as variant_id,
             c.name AS category_name,
             o.name AS object_name,
             CASE WHEN CAST(f.variant_id AS INTEGER) = 0 THEN '' ELSE v.name END AS variant_name,
             NULL as track, 'manual' as type, 'standard' as market_type_preset, f.created_at
      FROM follows f
      JOIN categories c ON f.category_id = c.id AND COALESCE(c.is_archived, 0) = 0
      JOIN objects o ON f.object_id = o.id AND o.category_id = c.id AND COALESCE(o.is_archived, 0) = 0
      LEFT JOIN variants v ON CAST(f.variant_id AS INTEGER) = v.id AND v.object_id = o.id AND COALESCE(v.is_archived, 0) = 0
      WHERE CAST(f.variant_id AS INTEGER) = 0 OR v.id IS NOT NULL
      ORDER BY f.created_at DESC
    `);
    res.json({ status: "success", data: follows });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取关注列表失败", error: errorMessage });
  }
});

// 新增关注接口
router.post("/follows", async (req, res) => {
  try {
    const db = await getDb();
    const categoryIdResult = parseFollowId(req.body.category_id, "category_id");
    if (categoryIdResult.error) {
      return res.status(400).json({ status: "error", message: categoryIdResult.error });
    }

    const objectIdResult = parseFollowId(req.body.object_id, "object_id");
    if (objectIdResult.error) {
      return res.status(400).json({ status: "error", message: objectIdResult.error });
    }

    const variantIdResult = parseFollowVariantId(req.body.variant_id);
    if (variantIdResult.error) {
      return res.status(400).json({ status: "error", message: variantIdResult.error });
    }

    const category_id = categoryIdResult.value as number;
    const object_id = objectIdResult.value as number;
    const variant_id = variantIdResult.value as number;
    
    const masterTarget = await validateActiveMasterTargetByIds(db, category_id, object_id, variant_id);
    if (!masterTarget.ok) {
      return res.status(400).json({ status: "error", message: masterTarget.message });
    }
    
    // 检查是否已关注（幂等处理）
    const existingFollow = await db.get(
      "SELECT * FROM follows WHERE category_id = ? AND object_id = ? AND variant_id = ?",
      [masterTarget.target.category_id, masterTarget.target.object_id, masterTarget.target.variant_id]
    );
    
    if (existingFollow) {
      // 已关注，返回成功状态
      return res.json({ status: "success", message: "已关注", already_followed: true });
    }
    
    // 插入关注记录
    try {
      const result = await db.run(
        "INSERT INTO follows (category_id, object_id, variant_id, category_name, object_name, variant_name) VALUES (?, ?, ?, ?, ?, ?)",
        [
          masterTarget.target.category_id,
          masterTarget.target.object_id,
          masterTarget.target.variant_id,
          masterTarget.target.category_name,
          masterTarget.target.object_name,
          masterTarget.target.variant_name
        ]
      );
      res.json({ status: "success", message: "已关注", id: result.lastID });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("UNIQUE constraint failed")) {
        // 重复关注，返回已关注状态
        return res.json({ status: "success", message: "已关注", already_followed: true });
      }
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "关注失败", error: errorMessage });
  }
});

// 取消关注接口
router.delete("/follows", async (req, res) => {
  try {
    const db = await getDb();
    const categoryIdResult = parseFollowId(req.body.category_id, "category_id");
    if (categoryIdResult.error) {
      return res.status(400).json({ status: "error", message: categoryIdResult.error });
    }

    const objectIdResult = parseFollowId(req.body.object_id, "object_id");
    if (objectIdResult.error) {
      return res.status(400).json({ status: "error", message: objectIdResult.error });
    }

    const variantIdResult = parseFollowVariantId(req.body.variant_id);
    if (variantIdResult.error) {
      return res.status(400).json({ status: "error", message: variantIdResult.error });
    }

    const category_id = categoryIdResult.value as number;
    const object_id = objectIdResult.value as number;
    const variant_id = variantIdResult.value as number;
    
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "取消关注失败", error: errorMessage });
  }
});

// 获取关注卡片接口
router.get("/follow-cards", async (req, res) => {
  try {
    const db = await getDb();
    
    // 查询所有品类
    const categories = await db.all("SELECT id, name FROM categories WHERE COALESCE(is_archived, 0) = 0 ORDER BY name ASC");
    
    const result = [];
    
    for (const category of categories) {
      // 查询该品类下的所有关注记录
      const follows = await db.all(
        `SELECT f.id, f.category_id, f.object_id,
                CASE WHEN f.variant_id IS NULL OR TRIM(CAST(f.variant_id AS TEXT)) = '' THEN 0 ELSE CAST(f.variant_id AS INTEGER) END as variant_id,
                c.name AS category_name,
                o.name AS object_name,
                CASE WHEN CAST(f.variant_id AS INTEGER) = 0 THEN '' ELSE v.name END AS variant_name,
                NULL as track, 'manual' as type, 'standard' as market_type_preset, f.created_at
         FROM follows f
         JOIN categories c ON f.category_id = c.id AND COALESCE(c.is_archived, 0) = 0
         JOIN objects o ON f.object_id = o.id AND o.category_id = c.id AND COALESCE(o.is_archived, 0) = 0
         LEFT JOIN variants v ON CAST(f.variant_id AS INTEGER) = v.id AND v.object_id = o.id AND COALESCE(v.is_archived, 0) = 0
         WHERE f.category_id = ? AND (CAST(f.variant_id AS INTEGER) = 0 OR v.id IS NOT NULL)`,
        [category.id]
      );
      
      const items = [];
      let latestDate = "";
      
      for (const follow of follows) {
        // 查询价格记录，按最新录入优先排序
        const priceRecords = await db.all(
          "SELECT * FROM price_records WHERE category = ? AND object_name = ? AND COALESCE(variant, '') = ? ORDER BY date DESC, created_at DESC, id DESC",
          [follow.category_name, follow.object_name, follow.variant_name]
        );
        
        if (priceRecords.length > 0) {
          // 计算价格信息
          const highestPrice = Math.max(...priceRecords.map((r: any) => r.price));
          const lowestPrice = Math.min(...priceRecords.map((r: any) => r.price));
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
          
          // priceRecords 已按最新优先排序，find 返回最近一次出现记录。
          const highestPriceRecord = priceRecords.find((record: any) => record.price === highestPrice);
          const highestDate = highestPriceRecord ? highestPriceRecord.date : currentDate;
          
          const lowestPriceRecord = priceRecords.find((record: any) => record.price === lowestPrice);
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取关注卡片失败", error: errorMessage });
  }
});

export default router;
