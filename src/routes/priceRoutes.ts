import express from "express";
import getDb from "../config/database";

const router = express.Router();

router.get("/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const { category, object_name, variant } = req.query;
    
    let query = "SELECT * FROM price_records";
    const params = [];
    
    if (category || object_name || variant) {
      query += " WHERE";
      if (category) {
        query += " category = ?";
        params.push(category);
      }
      if (object_name) {
        query += params.length > 0 ? " AND" : "";
        query += " object_name = ?";
        params.push(object_name);
      }
      if (variant) {
        query += params.length > 0 ? " AND" : "";
        query += " variant = ?";
        params.push(variant);
      }
    }
    
    const priceRecords = await db.all(query, params);
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
      return res.status(400).json({ 
        success: false, 
        message: "缺少必填字段", 
        error_code: "MISSING_REQUIRED_FIELD", 
        data: null 
      });
    }
    
    // 校验价格是否为数字
    if (typeof price !== 'number') {
      return res.status(400).json({ 
        success: false, 
        message: "price 字段格式错误", 
        error_code: "INVALID_PRICE", 
        data: null 
      });
    }
    
    // 校验日期格式
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ 
        success: false, 
        message: "日期格式错误", 
        error_code: "INVALID_DATE", 
        data: null 
      });
    }
    
    // 标准化 variant_name
    const variant = variant_name || '';
    
    // 校验主数据是否存在
    const category = await db.get("SELECT * FROM categories WHERE name = ?", [category_name]);
    if (!category) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ?", [category.id, object_name]);
    if (!object) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (variant_name) {
      const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ?", [object.id, variant_name]);
      if (!variant) {
        return res.status(400).json({ 
          success: false, 
          message: "未找到对应主数据", 
          error_code: "MASTER_DATA_NOT_FOUND", 
          data: null 
        });
      }
    }
    
    // 检查是否已存在相同记录
    const existingRecord = await db.get(
      "SELECT * FROM price_records WHERE date = ? AND category = ? AND object_name = ? AND variant = ?",
      [date, category_name, object_name, variant]
    );
    
    if (existingRecord) {
      return res.status(400).json({
        success: false,
        message: "该对象在该日期已有价格记录，请使用编辑功能修改",
        error_code: "PRICE_RECORD_DUPLICATE",
        data: null
      });
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run("INSERT INTO price_records (date, category, object_name, variant, price, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [date, category_name, object_name, variant, price, source, note, now, now]);
    
    // 返回新增后的数据
    const newRecord = await db.get("SELECT * FROM price_records WHERE id = ?", [result.lastID]);
    res.json({
      success: true,
      message: "价格记录新增成功",
      data: {
        id: newRecord.id,
        date: newRecord.date,
        category_name: newRecord.category,
        object_name: newRecord.object_name,
        variant_name: newRecord.variant,
        price: newRecord.price,
        source: newRecord.source,
        note: newRecord.note
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "未知错误，请联系开发排查", 
      error_code: "UNKNOWN_ERROR", 
      data: null 
    });
  }
});

router.put("/price-records/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { date, category_name, object_name, variant_name, price, source, note } = req.body;
    
    // 标准化字段
    const normalizedDate = date ? date.trim() : '';
    const normalizedCategoryName = category_name ? category_name.trim() : '';
    const normalizedObjectName = object_name ? object_name.trim() : '';
    const normalizedVariantName = variant_name ? variant_name.trim() : '';
    const normalizedSource = source ? source.trim() : '';
    const normalizedNote = note ? note.trim() : '';
    
    // 校验必填字段
    if (!normalizedCategoryName || !normalizedObjectName || price === undefined || !normalizedDate) {
      return res.status(400).json({ 
        success: false, 
        message: "缺少必填字段", 
        error_code: "MISSING_REQUIRED_FIELD", 
        data: null 
      });
    }
    
    // 校验价格是否为数字
    if (typeof price !== 'number') {
      return res.status(400).json({ 
        success: false, 
        message: "price 字段格式错误", 
        error_code: "INVALID_PRICE", 
        data: null 
      });
    }
    
    // 校验日期格式
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(normalizedDate)) {
      return res.status(400).json({ 
        success: false, 
        message: "日期格式错误", 
        error_code: "INVALID_DATE", 
        data: null 
      });
    }
    
    // 校验主数据是否存在
    const category = await db.get("SELECT * FROM categories WHERE name = ?", [normalizedCategoryName]);
    if (!category) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ?", [category.id, normalizedObjectName]);
    if (!object) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (normalizedVariantName) {
      const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ?", [object.id, normalizedVariantName]);
      if (!variant) {
        return res.status(400).json({ 
          success: false, 
          message: "未找到对应主数据", 
          error_code: "MASTER_DATA_NOT_FOUND", 
          data: null 
        });
      }
    }
    
    // 检查是否已存在相同记录（排除当前记录自身）
    const existingRecord = await db.get(
      "SELECT * FROM price_records WHERE date = ? AND category = ? AND object_name = ? AND variant = ? AND id != ?",
      [normalizedDate, normalizedCategoryName, normalizedObjectName, normalizedVariantName, id]
    );
    
    if (existingRecord) {
      return res.status(400).json({
        success: false,
        message: "该对象在该日期已有其它价格记录，请检查后修改",
        error_code: "PRICE_RECORD_DUPLICATE",
        data: null
      });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      "UPDATE price_records SET date = ?, category = ?, object_name = ?, variant = ?, price = ?, source = ?, note = ?, updated_at = ? WHERE id = ?", 
      [normalizedDate, normalizedCategoryName, normalizedObjectName, normalizedVariantName, price, normalizedSource, normalizedNote, now, id]
    );
    
    // 检查记录是否存在
    if (result.changes === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "记录不存在", 
        error_code: "UNKNOWN_ERROR", 
        data: null 
      });
    }
    
    // 返回更新后的数据
    const updatedRecord = await db.get("SELECT * FROM price_records WHERE id = ?", [id]);
    res.json({
      success: true,
      message: "修改成功",
      data: {
        id: updatedRecord.id,
        date: updatedRecord.date,
        category_name: updatedRecord.category,
        object_name: updatedRecord.object_name,
        variant_name: updatedRecord.variant,
        price: updatedRecord.price,
        source: updatedRecord.source,
        note: updatedRecord.note
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "未知错误，请联系开发排查", 
      error_code: "UNKNOWN_ERROR", 
      data: null 
    });
  }
});

router.post("/import/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const records = req.body;
    
    if (!Array.isArray(records)) {
      return res.status(400).json({ 
        success: false, 
        message: "导入失败：请求体格式错误", 
        data: null 
      });
    }
    
    let success = 0;
    let skipped = 0;
    let failed = 0;
    const failed_records = [];
    const skipped_records = [];
    
    // 用于跟踪本批已处理的记录，避免包内重复
    const processedRecords = new Set();
    
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      
      // 标准化字段
      const date = record.date ? record.date.trim() : '';
      const category_name = record.category_name ? record.category_name.trim() : '';
      const object_name = record.object_name ? record.object_name.trim() : '';
      const variant_name = record.variant_name ? record.variant_name.trim() : '';
      const price = record.price;
      const source = record.source ? record.source.trim() : '';
      const note = record.note ? record.note.trim() : '';
      
      // 校验必填字段
      if (!category_name || !object_name || price === undefined || !date) {
        failed++;
        failed_records.push({
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "MISSING_REQUIRED_FIELD",
          message: "缺少必填字段"
        });
        continue;
      }
      
      // 校验价格是否为数字
      if (typeof price !== 'number') {
        failed++;
        failed_records.push({
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "INVALID_PRICE",
          message: "price 字段格式错误"
        });
        continue;
      }
      
      // 校验日期格式
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        failed++;
        failed_records.push({
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "INVALID_DATE",
          message: "日期格式错误"
        });
        continue;
      }
      
      // 检查本批数据内部重复
      const recordKey = `${date}|${category_name}|${object_name}|${variant_name}`;
      if (processedRecords.has(recordKey)) {
        skipped++;
        skipped_records.push({
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "PRICE_RECORD_DUPLICATE",
          message: "该对象在该日期已有价格记录，已跳过"
        });
        continue;
      }
      
      // 校验主数据是否存在
      try {
        const category = await db.get("SELECT * FROM categories WHERE name = ?", [category_name]);
        if (!category) {
          failed++;
          failed_records.push({
            date: date,
            category_name: category_name,
            object_name: object_name,
            variant_name: variant_name,
            reason: "MASTER_DATA_NOT_FOUND",
            message: "未找到对应主数据"
          });
          continue;
        }
        
        const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ?", [category.id, object_name]);
        if (!object) {
          failed++;
          failed_records.push({
            date: date,
            category_name: category_name,
            object_name: object_name,
            variant_name: variant_name,
            reason: "MASTER_DATA_NOT_FOUND",
            message: "未找到对应主数据"
          });
          continue;
        }
        
        // 如果 variant_name 不为空，校验变体是否存在
        if (variant_name) {
          const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ?", [object.id, variant_name]);
          if (!variant) {
            failed++;
            failed_records.push({
              date: date,
              category_name: category_name,
              object_name: object_name,
              variant_name: variant_name,
              reason: "MASTER_DATA_NOT_FOUND",
              message: "未找到对应主数据"
            });
            continue;
          }
        }
        
        // 检查数据库中是否已存在
        const existingRecord = await db.get(
          "SELECT * FROM price_records WHERE date = ? AND category = ? AND object_name = ? AND variant = ?",
          [date, category_name, object_name, variant_name]
        );
        
        if (existingRecord) {
          skipped++;
          skipped_records.push({
            date: date,
            category_name: category_name,
            object_name: object_name,
            variant_name: variant_name,
            reason: "PRICE_RECORD_DUPLICATE",
            message: "该对象在该日期已有价格记录，已跳过"
          });
          continue;
        }
        
        // 插入记录
        const now = new Date().toISOString();
        await db.run(
          "INSERT INTO price_records (date, category, object_name, variant, price, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [date, category_name, object_name, variant_name, price, source, note, now, now]
        );
        success++;
        processedRecords.add(recordKey);
      } catch (error) {
        failed++;
        failed_records.push({
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "UNKNOWN_ERROR",
          message: "未知错误，请联系开发排查"
        });
      }
    }
    
    res.json({
      success: true,
      message: "导入完成",
      data: {
        success_count: success,
        skipped_count: skipped,
        failed_count: failed,
        skipped_records: skipped_records,
        failed_records: failed_records
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "导入失败：服务端异常", 
      data: null 
    });
  }
});

export default router;
