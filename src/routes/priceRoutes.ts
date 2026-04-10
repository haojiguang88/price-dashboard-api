import express from "express";
import getDb from "../config/database";

const router = express.Router();

router.get("/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const priceRecords = await db.all("SELECT * FROM price_records");
    res.json({ status: "success", data: priceRecords });
  } catch (error) {
    res.status(500).json({ status: "error", message: "Failed to fetch price records", error: error.message });
  }
});

router.post("/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const { date, category_name, object_name, variant_name, price, source, note } = req.body;
    
    // 校验字段
    if (!category_name || !object_name || !price || !date) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: category_name, object_name, price, date" });
    }
    
    // 校验价格是否为数字
    if (typeof price !== 'number') {
      return res.status(400).json({ status: "error", message: "价格必须是数字" });
    }
    
    // 校验日期格式
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ status: "error", message: "日期格式不正确，应为 YYYY-MM-DD" });
    }
    
    // 标准化 variant_name
    const variant = variant_name || '';
    
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
    const result = await db.run("INSERT INTO price_records (date, category, object_name, variant, price, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [date, category_name, object_name, variant, price, source, note, now, now]);
    res.json({ status: "success", message: "价格记录新增成功", id: result.lastID });
  } catch (error) {
    res.status(500).json({ status: "error", message: "新增价格记录失败", error: error.message });
  }
});

router.put("/price-records/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { date, category_name, object_name, variant_name, price, source, note } = req.body;
    
    // 校验字段
    if (!category_name || !object_name || !price || !date) {
      return res.status(400).json({ status: "error", message: "缺少必填字段: category_name, object_name, price, date" });
    }
    
    // 校验价格是否为数字
    if (typeof price !== 'number') {
      return res.status(400).json({ status: "error", message: "价格必须是数字" });
    }
    
    // 校验日期格式
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ status: "error", message: "日期格式不正确，应为 YYYY-MM-DD" });
    }
    
    // 标准化 variant_name
    const variant = variant_name || '';
    
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
    
    const now = new Date().toISOString();
    const result = await db.run("UPDATE price_records SET date = ?, category = ?, object_name = ?, variant = ?, price = ?, source = ?, note = ?, updated_at = ? WHERE id = ?", [date, category_name, object_name, variant, price, source, note, now, id]);
    res.json({ status: "success", message: "价格记录编辑成功", changes: result.changes });
  } catch (error) {
    res.status(500).json({ status: "error", message: "编辑价格记录失败", error: error.message });
  }
});

router.post("/import/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const records = req.body;
    
    if (!Array.isArray(records)) {
      return res.status(400).json({ status: "error", message: "请求体必须是 JSON 数组" });
    }
    
    let total = records.length;
    let success = 0;
    let skipped = 0;
    let failed = 0;
    const failed_records = [];
    
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      
      // 校验字段
      if (!record.category_name || !record.object_name || !record.price || !record.date) {
        failed++;
        failed_records.push({
          index: i,
          record: record,
          error: "缺少必填字段: category_name, object_name, price, date"
        });
        continue;
      }
      
      // 校验价格是否为数字
      if (typeof record.price !== 'number') {
        failed++;
        failed_records.push({
          index: i,
          record: record,
          error: "价格必须是数字"
        });
        continue;
      }
      
      // 校验日期格式
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(record.date)) {
        failed++;
        failed_records.push({
          index: i,
          record: record,
          error: "日期格式不正确，应为 YYYY-MM-DD"
        });
        continue;
      }
      
      // 标准化 variant_name
      const variant_name = record.variant_name || '';
      
      // 校验主数据是否存在
      const category = await db.get("SELECT * FROM categories WHERE name = ?", [record.category_name]);
      if (!category) {
        failed++;
        failed_records.push({
          index: i,
          record: record,
          error: "品类不存在"
        });
        continue;
      }
      
      const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ?", [category.id, record.object_name]);
      if (!object) {
        failed++;
        failed_records.push({
          index: i,
          record: record,
          error: "对象不存在"
        });
        continue;
      }
      
      // 如果 variant_name 不为空，校验变体是否存在
      if (variant_name) {
        const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ?", [object.id, variant_name]);
        if (!variant) {
          failed++;
          failed_records.push({
            index: i,
            record: record,
            error: "变体不存在"
          });
          continue;
        }
      }
      
      // 检查是否重复
      const source = record.source || '';
      const existingRecord = await db.get(
        "SELECT * FROM price_records WHERE category = ? AND object_name = ? AND variant = ? AND date = ? AND source = ? AND price = ?",
        [record.category_name, record.object_name, variant_name, record.date, source, record.price]
      );
      
      if (existingRecord) {
        skipped++;
        continue;
      }
      
      // 插入记录
      try {
        const now = new Date().toISOString();
        await db.run(
          "INSERT INTO price_records (date, category, object_name, variant, price, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [record.date, record.category_name, record.object_name, variant_name, record.price, source, record.note || '', now, now]
        );
        success++;
      } catch (error) {
        failed++;
        failed_records.push({
          index: i,
          record: record,
          error: `插入失败: ${error.message}`
        });
      }
    }
    
    res.json({
      status: "success",
      data: {
        total,
        success,
        skipped,
        failed,
        failed_records
      }
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: "导入失败", error: error.message });
  }
});

export default router;
