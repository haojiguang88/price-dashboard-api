import express from "express";
import getDb from "../config/database";

const router = express.Router();

router.get("/categories", async (req, res) => {
  try {
    const db = await getDb();
    const categories = await db.all("SELECT * FROM categories");
    res.json({ success: true, data: categories });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取品类列表失败" });
  }
});

router.post("/categories", async (req, res) => {
  try {
    const db = await getDb();
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "品类名称不能为空" });
    }
    const now = new Date().toISOString();
    try {
      const result = await db.run("INSERT INTO categories (name, created_at, updated_at) VALUES (?, ?, ?)", [name.trim(), now, now]);
      res.json({ success: true, data: { id: result.lastID, message: "新增品类成功" } });
    } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("UNIQUE constraint failed")) {
      return res.status(409).json({ success: false, message: "该品类名称已存在" });
    }
    throw error;
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "新增品类失败" });
  }
});

router.put("/categories/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "品类名称不能为空" });
    }
    const now = new Date().toISOString();
    try {
      const result = await db.run("UPDATE categories SET name = ?, updated_at = ? WHERE id = ?", [name.trim(), now, id]);
      if (result.changes === 0) {
        return res.status(404).json({ success: false, message: "品类不存在" });
      }
      res.json({ success: true, data: { message: "编辑品类成功" } });
    } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("UNIQUE constraint failed")) {
      return res.status(409).json({ success: false, message: "该品类名称已存在" });
    }
    throw error;
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "编辑品类失败" });
  }
});

router.delete("/categories/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查品类是否存在
    const category = await db.get("SELECT * FROM categories WHERE id = ?", [id]);
    if (!category) {
      return res.status(404).json({ success: false, message: "品类不存在" });
    }
    
    // 检查该品类下是否还有对象
    const result = await db.get("SELECT COUNT(1) as count FROM objects WHERE category_id = ?", [id]);
    if (result.count > 0) {
      return res.status(409).json({ success: false, message: "该品类下仍有关联对象，无法删除" });
    }
    
    // 执行删除操作
    await db.run("DELETE FROM categories WHERE id = ?", [id]);
    res.json({ success: true, data: { message: "删除品类成功" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "删除品类失败" });
  }
});

router.get("/objects", async (req, res) => {
  try {
    const db = await getDb();
    const objects = await db.all("SELECT objects.id, objects.category_id, objects.name, categories.name as category_name, objects.created_at, objects.updated_at FROM objects JOIN categories ON objects.category_id = categories.id");
    res.json({ success: true, data: objects });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取对象列表失败" });
  }
});

router.post("/objects", async (req, res) => {
  try {
    const db = await getDb();
    const { category_id, name } = req.body;
    if (!category_id || !name || !name.trim()) {
      return res.status(400).json({ success: false, message: "品类 ID 和名称不能为空" });
    }
    const now = new Date().toISOString();
    try {
      const result = await db.run("INSERT INTO objects (category_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [category_id, name.trim(), now, now]);
      res.json({ success: true, data: { id: result.lastID, message: "新增对象成功" } });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("UNIQUE constraint failed")) {
        return res.status(409).json({ success: false, message: "该品类下已存在同名对象" });
      }
      throw error;
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "新增对象失败" });
  }
});

router.put("/objects/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { category_id, name } = req.body;
    if (!category_id || !name || !name.trim()) {
      return res.status(400).json({ success: false, message: "品类 ID 和名称不能为空" });
    }
    const now = new Date().toISOString();
    try {
      const result = await db.run("UPDATE objects SET category_id = ?, name = ?, updated_at = ? WHERE id = ?", [category_id, name.trim(), now, id]);
      if (result.changes === 0) {
        return res.status(404).json({ success: false, message: "对象不存在" });
      }
      res.json({ success: true, data: { message: "编辑对象成功" } });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("UNIQUE constraint failed")) {
        return res.status(409).json({ success: false, message: "该品类下已存在同名对象" });
      }
      throw error;
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "编辑对象失败" });
  }
});

router.delete("/objects/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查对象是否存在
    const object = await db.get("SELECT * FROM objects WHERE id = ?", [id]);
    if (!object) {
      return res.status(404).json({ success: false, message: "对象不存在" });
    }
    
    // 检查该对象下是否还有变体
    const result = await db.get("SELECT COUNT(1) as count FROM variants WHERE object_id = ?", [id]);
    if (result.count > 0) {
      return res.status(409).json({ success: false, message: "该对象下仍有关联变体，无法删除" });
    }
    
    // 执行删除操作
    await db.run("DELETE FROM objects WHERE id = ?", [id]);
    res.json({ success: true, data: { message: "删除对象成功" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "删除对象失败" });
  }
});

router.get("/variants", async (req, res) => {
  try {
    const db = await getDb();
    const variants = await db.all("SELECT variants.id, variants.object_id, variants.name, objects.name as object_name, objects.category_id, categories.name as category_name, variants.created_at, variants.updated_at FROM variants JOIN objects ON variants.object_id = objects.id JOIN categories ON objects.category_id = categories.id");
    res.json({ success: true, data: variants });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取变体列表失败" });
  }
});

router.post("/variants", async (req, res) => {
  try {
    const db = await getDb();
    const { object_id, name } = req.body;
    if (!object_id || !name || !name.trim()) {
      return res.status(400).json({ success: false, message: "对象 ID 和名称不能为空" });
    }
    const now = new Date().toISOString();
    try {
      const result = await db.run("INSERT INTO variants (object_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [object_id, name.trim(), now, now]);
      res.json({ success: true, data: { id: result.lastID, message: "新增变体成功" } });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("UNIQUE constraint failed")) {
        return res.status(409).json({ success: false, message: "该对象下已存在同名变体" });
      }
      throw error;
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "新增变体失败" });
  }
});

router.put("/variants/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { object_id, name } = req.body;
    if (!object_id || !name || !name.trim()) {
      return res.status(400).json({ success: false, message: "对象 ID 和名称不能为空" });
    }
    const now = new Date().toISOString();
    try {
      const result = await db.run("UPDATE variants SET object_id = ?, name = ?, updated_at = ? WHERE id = ?", [object_id, name.trim(), now, id]);
      if (result.changes === 0) {
        return res.status(404).json({ success: false, message: "变体不存在" });
      }
      res.json({ success: true, data: { message: "编辑变体成功" } });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("UNIQUE constraint failed")) {
        return res.status(409).json({ success: false, message: "该对象下已存在同名变体" });
      }
      throw error;
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "编辑变体失败" });
  }
});

router.delete("/variants/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查变体是否存在
    const variant = await db.get("SELECT * FROM variants WHERE id = ?", [id]);
    if (!variant) {
      return res.status(404).json({ success: false, message: "变体不存在" });
    }
    
    // 执行删除操作
    await db.run("DELETE FROM variants WHERE id = ?", [id]);
    res.json({ success: true, data: { message: "删除变体成功" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "删除变体失败" });
  }
});

export default router;