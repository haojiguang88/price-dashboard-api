import express from "express";
import getDb from "../config/database";

const router = express.Router();

const includeArchived = (req: express.Request) => {
  const value = String(req.query.include_archived || "").toLowerCase();
  return value === "1" || value === "true";
};

const archiveField = (tableAlias: string) => `COALESCE(${tableAlias}.is_archived, 0)`;

const archiveResponse = async (
  db: any,
  tableName: "categories" | "objects" | "variants",
  id: string,
  archived: boolean
) => {
  const now = new Date().toISOString();
  const result = await db.run(
    `UPDATE ${tableName} SET is_archived = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
    [archived ? 1 : 0, archived ? now : null, now, id]
  );
  return result.changes;
};

router.get("/categories", async (req, res) => {
  try {
    const db = await getDb();
    const where = includeArchived(req) ? "" : "WHERE COALESCE(is_archived, 0) = 0";
    const categories = await db.all(`
      SELECT id, name, COALESCE(is_archived, 0) AS is_archived, archived_at, created_at, updated_at
      FROM categories
      ${where}
      ORDER BY COALESCE(is_archived, 0) ASC, name ASC
    `);
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

router.patch("/categories/:id/archive", async (req, res) => {
  try {
    const db = await getDb();
    const changes = await archiveResponse(db, "categories", req.params.id, true);
    if (changes === 0) return res.status(404).json({ success: false, message: "品类不存在" });
    res.json({ success: true, data: { message: "品类已归档" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "归档品类失败" });
  }
});

router.patch("/categories/:id/restore", async (req, res) => {
  try {
    const db = await getDb();
    const changes = await archiveResponse(db, "categories", req.params.id, false);
    if (changes === 0) return res.status(404).json({ success: false, message: "品类不存在" });
    res.json({ success: true, data: { message: "品类已恢复" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "恢复品类失败" });
  }
});

router.delete("/categories/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const category = await db.get("SELECT * FROM categories WHERE id = ?", [id]);
    if (!category) return res.status(404).json({ success: false, message: "品类不存在" });
    const result = await db.get("SELECT COUNT(1) as count FROM objects WHERE category_id = ?", [id]);
    if (result.count > 0) return res.status(409).json({ success: false, message: "该品类下仍有关联对象，无法删除" });
    await db.run("DELETE FROM categories WHERE id = ?", [id]);
    res.json({ success: true, data: { message: "删除品类成功" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "删除品类失败" });
  }
});

router.get("/objects", async (req, res) => {
  try {
    const db = await getDb();
    const where = includeArchived(req)
      ? ""
      : `WHERE ${archiveField("o")} = 0 AND ${archiveField("c")} = 0`;
    const objects = await db.all(`
      SELECT o.id, o.category_id, o.name, c.name AS category_name,
        COALESCE(o.is_archived, 0) AS is_archived, o.archived_at,
        COALESCE(c.is_archived, 0) AS category_is_archived,
        o.created_at, o.updated_at
      FROM objects o
      JOIN categories c ON o.category_id = c.id
      ${where}
      ORDER BY COALESCE(c.is_archived, 0) ASC, c.name ASC, COALESCE(o.is_archived, 0) ASC, o.name ASC
    `);
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
    const category = await db.get("SELECT * FROM categories WHERE id = ? AND COALESCE(is_archived, 0) = 0", [category_id]);
    if (!category) return res.status(400).json({ success: false, message: "品类不存在或已归档" });
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
    const category = await db.get("SELECT * FROM categories WHERE id = ? AND COALESCE(is_archived, 0) = 0", [category_id]);
    if (!category) return res.status(400).json({ success: false, message: "品类不存在或已归档" });
    const now = new Date().toISOString();
    try {
      const result = await db.run("UPDATE objects SET category_id = ?, name = ?, updated_at = ? WHERE id = ?", [category_id, name.trim(), now, id]);
      if (result.changes === 0) return res.status(404).json({ success: false, message: "对象不存在" });
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

router.patch("/objects/:id/archive", async (req, res) => {
  try {
    const db = await getDb();
    const changes = await archiveResponse(db, "objects", req.params.id, true);
    if (changes === 0) return res.status(404).json({ success: false, message: "对象不存在" });
    res.json({ success: true, data: { message: "对象已归档" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "归档对象失败" });
  }
});

router.patch("/objects/:id/restore", async (req, res) => {
  try {
    const db = await getDb();
    const object = await db.get(`
      SELECT o.id FROM objects o
      JOIN categories c ON o.category_id = c.id
      WHERE o.id = ? AND COALESCE(c.is_archived, 0) = 0
    `, [req.params.id]);
    if (!object) return res.status(400).json({ success: false, message: "对象不存在或所属品类已归档" });
    const changes = await archiveResponse(db, "objects", req.params.id, false);
    if (changes === 0) return res.status(404).json({ success: false, message: "对象不存在" });
    res.json({ success: true, data: { message: "对象已恢复" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "恢复对象失败" });
  }
});

router.delete("/objects/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const object = await db.get("SELECT * FROM objects WHERE id = ?", [id]);
    if (!object) return res.status(404).json({ success: false, message: "对象不存在" });
    const result = await db.get("SELECT COUNT(1) as count FROM variants WHERE object_id = ?", [id]);
    if (result.count > 0) return res.status(409).json({ success: false, message: "该对象下仍有关联变体，无法删除" });
    await db.run("DELETE FROM objects WHERE id = ?", [id]);
    res.json({ success: true, data: { message: "删除对象成功" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "删除对象失败" });
  }
});

router.get("/variants", async (req, res) => {
  try {
    const db = await getDb();
    const where = includeArchived(req)
      ? ""
      : `WHERE ${archiveField("v")} = 0 AND ${archiveField("o")} = 0 AND ${archiveField("c")} = 0`;
    const variants = await db.all(`
      SELECT v.id, v.object_id, v.name, COALESCE(v.note, '') AS note,
        o.name AS object_name, o.category_id, c.name AS category_name,
        COALESCE(v.is_archived, 0) AS is_archived, v.archived_at,
        COALESCE(o.is_archived, 0) AS object_is_archived,
        COALESCE(c.is_archived, 0) AS category_is_archived,
        v.created_at, v.updated_at
      FROM variants v
      JOIN objects o ON v.object_id = o.id
      JOIN categories c ON o.category_id = c.id
      ${where}
      ORDER BY COALESCE(c.is_archived, 0) ASC, c.name ASC, COALESCE(o.is_archived, 0) ASC, o.name ASC, COALESCE(v.is_archived, 0) ASC, v.name ASC
    `);
    res.json({ success: true, data: variants });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取变体列表失败" });
  }
});

router.post("/variants", async (req, res) => {
  try {
    const db = await getDb();
    const { object_id, name, note } = req.body;
    if (!object_id || !name || !name.trim()) {
      return res.status(400).json({ success: false, message: "对象 ID 和名称不能为空" });
    }
    const object = await db.get(`
      SELECT o.id FROM objects o
      JOIN categories c ON o.category_id = c.id
      WHERE o.id = ? AND COALESCE(o.is_archived, 0) = 0 AND COALESCE(c.is_archived, 0) = 0
    `, [object_id]);
    if (!object) return res.status(400).json({ success: false, message: "对象不存在或已归档" });
    const now = new Date().toISOString();
    try {
      const result = await db.run("INSERT INTO variants (object_id, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [object_id, name.trim(), typeof note === "string" ? note : "", now, now]);
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

router.patch("/variants/:id/note", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { note } = req.body;
    if (typeof note !== "string") {
      return res.status(400).json({ success: false, message: "备注必须是文本" });
    }
    const now = new Date().toISOString();
    const result = await db.run("UPDATE variants SET note = ?, updated_at = ? WHERE id = ?", [note, now, id]);
    if (result.changes === 0) return res.status(404).json({ success: false, message: "变体不存在" });
    res.json({ success: true, data: { message: "保存备注成功", updated_at: now } });
  } catch (error) {
    res.status(500).json({ success: false, message: "保存变体备注失败" });
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
    const object = await db.get(`
      SELECT o.id FROM objects o
      JOIN categories c ON o.category_id = c.id
      WHERE o.id = ? AND COALESCE(o.is_archived, 0) = 0 AND COALESCE(c.is_archived, 0) = 0
    `, [object_id]);
    if (!object) return res.status(400).json({ success: false, message: "对象不存在或已归档" });
    const now = new Date().toISOString();
    try {
      const result = await db.run("UPDATE variants SET object_id = ?, name = ?, updated_at = ? WHERE id = ?", [object_id, name.trim(), now, id]);
      if (result.changes === 0) return res.status(404).json({ success: false, message: "变体不存在" });
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

router.patch("/variants/:id/archive", async (req, res) => {
  try {
    const db = await getDb();
    const changes = await archiveResponse(db, "variants", req.params.id, true);
    if (changes === 0) return res.status(404).json({ success: false, message: "变体不存在" });
    res.json({ success: true, data: { message: "变体已归档" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "归档变体失败" });
  }
});

router.patch("/variants/:id/restore", async (req, res) => {
  try {
    const db = await getDb();
    const variant = await db.get(`
      SELECT v.id FROM variants v
      JOIN objects o ON v.object_id = o.id
      JOIN categories c ON o.category_id = c.id
      WHERE v.id = ? AND COALESCE(o.is_archived, 0) = 0 AND COALESCE(c.is_archived, 0) = 0
    `, [req.params.id]);
    if (!variant) return res.status(400).json({ success: false, message: "变体不存在或上级已归档" });
    const changes = await archiveResponse(db, "variants", req.params.id, false);
    if (changes === 0) return res.status(404).json({ success: false, message: "变体不存在" });
    res.json({ success: true, data: { message: "变体已恢复" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "恢复变体失败" });
  }
});

router.delete("/variants/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const variant = await db.get("SELECT * FROM variants WHERE id = ?", [id]);
    if (!variant) return res.status(404).json({ success: false, message: "变体不存在" });
    await db.run("DELETE FROM variants WHERE id = ?", [id]);
    res.json({ success: true, data: { message: "删除变体成功" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "删除变体失败" });
  }
});

export default router;
