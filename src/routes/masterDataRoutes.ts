import express from "express";
import getDb from "../config/database";
import {
  cascadeMasterDataRename,
  countMasterDataReferences,
  countOpenPositionsForMaster,
  formatOpenPositionArchiveBlockMessage,
  formatReferenceBlockMessage
} from "../utils/masterData";
import { parseVariantXianyuHeatLevel } from "../utils/variantHeat";

const router = express.Router();

const includeArchived = (req: express.Request) => {
  const value = String(req.query.include_archived || "").toLowerCase();
  return value === "1" || value === "true";
};

const archiveField = (tableAlias: string) => `COALESCE(${tableAlias}.is_archived, 0)`;
const normalizeText = (value: unknown) => String(value ?? "").trim();

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

const objectHasActiveVariants = async (db: any, objectId: number | string) => {
  const row = await db.get(
    `SELECT COUNT(1) AS count
     FROM variants
     WHERE object_id = ?
       AND COALESCE(is_archived, 0) = 0`,
    [objectId]
  );
  return Number(row?.count || 0) > 0;
};

const objectHasAnyVariants = async (db: any, objectId: number | string) => {
  const row = await db.get(
    `SELECT COUNT(1) AS count FROM variants WHERE object_id = ?`,
    [objectId]
  );
  return Number(row?.count || 0) > 0;
};

const ACTIVE_OBJECT_LIST_FILTER = `
  ${archiveField("o")} = 0
  AND ${archiveField("c")} = 0
  AND (
    NOT EXISTS (SELECT 1 FROM variants v0 WHERE v0.object_id = o.id)
    OR EXISTS (
      SELECT 1 FROM variants v1
      WHERE v1.object_id = o.id
        AND COALESCE(v1.is_archived, 0) = 0
    )
  )
`;

router.get("/categories", async (req, res) => {
  try {
    const db = await getDb();
    const where = includeArchived(req) ? "" : "WHERE COALESCE(is_archived, 0) = 0";
    const categories = await db.all(`
      SELECT id, name, COALESCE(is_archived, 0) AS is_archived, archived_at,
             COALESCE(tracking_mode, 'active') AS tracking_mode, created_at, updated_at
      FROM categories
      ${where}
      ORDER BY COALESCE(is_archived, 0) ASC, name ASC
    `);
    res.json({ success: true, data: categories });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取品类列表失败" });
  }
});

const CORE_ACTIVE_CATEGORIES = new Set(["苹果手机", "游戏机", "泡泡玛特", "纪念币", "纪念钞", "贵金属"]);
const ARCHIVE_SKIP_REASON = "品类已归档，停止日常采集";
export const STALE_PRICE_DAYS = 30;

export const chinaDateKey = (now = new Date()) => (
  now.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })
);

export const daysSincePriceDate = (dateText: string | null | undefined, today = chinaDateKey()) => {
  const raw = String(dateText || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const from = Date.parse(`${raw}T00:00:00+08:00`);
  const to = Date.parse(`${today}T00:00:00+08:00`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.round((to - from) / 86_400_000));
};

export const classifyCategoryLiquidity = (row: {
  is_archived?: number;
  name: string;
  last_price_date?: string | null;
  open_position_count?: number;
  buying_plan_count?: number;
  selling_plan_count?: number;
  watchlist_count?: number;
}, today = chinaDateKey()) => {
  const ageDays = daysSincePriceDate(row.last_price_date, today);
  let liquidity: "none" | "stale" | "ok" = "ok";
  let liquidityReason = "";
  if (!row.last_price_date) {
    liquidity = "none";
    liquidityReason = "无可用价格";
  } else if (ageDays !== null && ageDays > STALE_PRICE_DAYS) {
    liquidity = "stale";
    liquidityReason = `最近价格 ${String(row.last_price_date).slice(0, 10)}，已 ${ageDays} 天`;
  }

  const inUse = (
    Number(row.open_position_count || 0) > 0
    || Number(row.buying_plan_count || 0) > 0
    || Number(row.selling_plan_count || 0) > 0
    || Number(row.watchlist_count || 0) > 0
  );
  const archiveCandidate = (
    Number(row.is_archived || 0) !== 1
    && !CORE_ACTIVE_CATEGORIES.has(row.name)
    && !inUse
    && (liquidity === "none" || liquidity === "stale")
  );

  return {
    last_price_age_days: ageDays,
    liquidity,
    liquidity_reason: liquidityReason,
    archive_candidate: archiveCandidate
  };
};

const syncCshrichCatalogTracking = async (db: any, categoryName: string, archived: boolean) => {
  const table = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cshrich_catalog_categories'"
  );
  if (!table) return;
  if (archived) {
    await db.run(
      `UPDATE cshrich_catalog_categories
       SET tracked = 0,
           skip_reason = CASE WHEN skip_reason = '' THEN ? ELSE skip_reason END,
           updated_at = CURRENT_TIMESTAMP
       WHERE system_category_name = ? AND source_key = 'cshrich_electronics'`,
      [ARCHIVE_SKIP_REASON, categoryName]
    );
    return;
  }
  await db.run(
    `UPDATE cshrich_catalog_categories
     SET tracked = CASE
           WHEN skip_reason IN ('', ?) THEN 1
           ELSE 0
         END,
         skip_reason = CASE WHEN skip_reason = ? THEN '' ELSE skip_reason END,
         updated_at = CURRENT_TIMESTAMP
     WHERE system_category_name = ? AND source_key = 'cshrich_electronics'`,
    [ARCHIVE_SKIP_REASON, ARCHIVE_SKIP_REASON, categoryName]
  );
};

const suggestCategoryTracking = (row: {
  is_archived: number;
  name: string;
  open_position_count: number;
  buying_plan_count: number;
  selling_plan_count: number;
  watchlist_count: number;
}) => {
  if (Number(row.is_archived) === 1) return "archived";
  if (CORE_ACTIVE_CATEGORIES.has(row.name)) return "active";
  if (
    Number(row.open_position_count) > 0
    || Number(row.buying_plan_count) > 0
    || Number(row.selling_plan_count) > 0
    || Number(row.watchlist_count) > 0
  ) {
    return "active";
  }
  return "observe";
};

router.get("/categories/review", async (req, res) => {
  try {
    const db = await getDb();
    const where = includeArchived(req) ? "" : "WHERE COALESCE(c.is_archived, 0) = 0";
    const rows = await db.all(`
      SELECT
        c.id,
        c.name,
        COALESCE(c.is_archived, 0) AS is_archived,
        c.archived_at,
        COALESCE(c.tracking_mode, 'active') AS tracking_mode,
        (
          SELECT COUNT(1) FROM objects o
          WHERE o.category_id = c.id AND COALESCE(o.is_archived, 0) = 0
        ) AS active_object_count,
        (
          SELECT COUNT(1) FROM objects o
          WHERE o.category_id = c.id AND COALESCE(o.is_archived, 0) = 1
        ) AS archived_object_count,
        (
          SELECT MAX(pr.date) FROM price_records pr WHERE pr.category = c.name
        ) AS last_price_date,
        (
          SELECT COUNT(DISTINCT pr.object_name) FROM price_records pr WHERE pr.category = c.name
        ) AS priced_object_count,
        (
          SELECT COUNT(1) FROM positions p
          WHERE p.category_name = c.name AND COALESCE(p.total_quantity, 0) > 0
        ) AS open_position_count,
        (
          SELECT COUNT(1) FROM buying_plans bp
          WHERE bp.category_name = c.name AND bp.status IN ('pending', 'in_progress')
        ) AS buying_plan_count,
        (
          SELECT COUNT(1) FROM selling_plans sp
          WHERE sp.category_name = c.name AND sp.status IN ('pending', 'in_progress')
        ) AS selling_plan_count,
        (
          SELECT COUNT(1) FROM watchlist_items w
          WHERE w.category_id = c.id AND w.status IN ('watching', 'waiting_price', 'waiting_signal')
        ) AS watchlist_count
      FROM categories c
      ${where}
      ORDER BY COALESCE(c.is_archived, 0) ASC, c.name ASC
    `);
    res.json({
      success: true,
      data: rows.map((row: any) => ({
        ...row,
        suggested_tracking: suggestCategoryTracking(row),
        ...classifyCategoryLiquidity(row)
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取品类跟踪口径失败" });
  }
});

router.patch("/categories/:id/tracking", async (req, res) => {
  try {
    const db = await getDb();
    const trackingMode = String(req.body?.tracking_mode || "").trim();
    if (trackingMode !== "active" && trackingMode !== "observe") {
      return res.status(400).json({ success: false, message: "跟踪口径只能是活跃或观察" });
    }
    const category = await db.get(
      "SELECT id, name, COALESCE(is_archived, 0) AS is_archived FROM categories WHERE id = ?",
      [req.params.id]
    );
    if (!category) return res.status(404).json({ success: false, message: "品类不存在" });
    if (Number(category.is_archived) === 1) {
      return res.status(409).json({ success: false, message: "已归档品类请先恢复，再改跟踪口径" });
    }
    const now = new Date().toISOString();
    await db.run(
      "UPDATE categories SET tracking_mode = ?, updated_at = ? WHERE id = ?",
      [trackingMode, now, req.params.id]
    );
    res.json({ success: true, data: { message: trackingMode === "observe" ? "已设为观察" : "已设为活跃" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "更新品类跟踪口径失败" });
  }
});

router.post("/categories", async (req, res) => {
  try {
    const db = await getDb();
    const name = normalizeText(req.body?.name);
    if (!name) {
      return res.status(400).json({ success: false, message: "品类名称不能为空" });
    }
    const now = new Date().toISOString();
    try {
      const result = await db.run("INSERT INTO categories (name, created_at, updated_at) VALUES (?, ?, ?)", [name, now, now]);
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
    const name = normalizeText(req.body?.name);
    if (!name) {
      return res.status(400).json({ success: false, message: "品类名称不能为空" });
    }
    const existingCategory = await db.get("SELECT id, name FROM categories WHERE id = ? AND COALESCE(is_archived, 0) = 0", [id]);
    if (!existingCategory) {
      return res.status(404).json({ success: false, message: "品类不存在或已归档" });
    }

    const now = new Date().toISOString();
    try {
      await db.run("BEGIN TRANSACTION");
      await db.run("UPDATE categories SET name = ?, updated_at = ? WHERE id = ?", [name, now, id]);
      await cascadeMasterDataRename(db, {
        oldCategoryId: existingCategory.id,
        oldCategoryName: existingCategory.name,
        newCategoryName: name
      });
      await db.run("COMMIT");
      res.json({ success: true, data: { message: "编辑品类成功" } });
    } catch (error) {
      await db.run("ROLLBACK").catch(() => undefined);
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

export const archiveCategoryRecord = async (db: any, categoryId: string | number) => {
  const category = await db.get(
    "SELECT id, name, COALESCE(is_archived, 0) AS is_archived FROM categories WHERE id = ?",
    [categoryId]
  );
  if (!category) {
    return { ok: false as const, status: 404, message: "品类不存在" };
  }
  if (Number(category.is_archived) === 1) {
    return { ok: true as const, skipped: true, name: category.name };
  }
  const openPositions = await countOpenPositionsForMaster(db, {
    level: "category",
    categoryName: category.name
  });
  if (openPositions > 0) {
    return {
      ok: false as const,
      status: 409,
      message: `${category.name}：${formatOpenPositionArchiveBlockMessage(openPositions)}`
    };
  }

  const now = new Date().toISOString();
  try {
    await db.run("BEGIN IMMEDIATE TRANSACTION");
    await db.run(
      "UPDATE categories SET is_archived = 1, archived_at = ?, updated_at = ? WHERE id = ?",
      [now, now, category.id]
    );
    await db.run(
      `UPDATE objects
       SET is_archived = 1, archived_at = ?, updated_at = ?
       WHERE category_id = ? AND COALESCE(is_archived, 0) = 0`,
      [now, now, category.id]
    );
    await db.run(
      `UPDATE variants
       SET is_archived = 1, archived_at = ?, updated_at = ?
       WHERE object_id IN (SELECT id FROM objects WHERE category_id = ?)
         AND COALESCE(is_archived, 0) = 0`,
      [now, now, category.id]
    );
    await db.run("COMMIT");
  } catch (error) {
    await db.run("ROLLBACK").catch(() => undefined);
    throw error;
  }
  await syncCshrichCatalogTracking(db, category.name, true);
  return { ok: true as const, skipped: false, name: category.name };
};

router.patch("/categories/:id/archive", async (req, res) => {
  try {
    const db = await getDb();
    const result = await archiveCategoryRecord(db, req.params.id);
    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message });
    }
    res.json({ success: true, data: { message: "品类已归档" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "归档品类失败" });
  }
});

router.post("/categories/archive-batch", async (req, res) => {
  try {
    const db = await getDb();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!ids) {
      return res.status(400).json({ success: false, message: "ids 必须是数组" });
    }
    if (ids.length === 0) {
      return res.status(400).json({ success: false, message: "请选择要归档的品类" });
    }
    const archived: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      const result = await archiveCategoryRecord(db, id);
      if (!result.ok) {
        failed.push(result.message);
        continue;
      }
      if (result.skipped) skipped.push(result.name);
      else archived.push(result.name);
    }
    if (archived.length === 0 && failed.length > 0) {
      return res.status(409).json({
        success: false,
        message: failed.join("；"),
        data: { archived, skipped, failed }
      });
    }
    res.json({
      success: true,
      data: {
        message: `已归档 ${archived.length} 个品类`,
        archived,
        skipped,
        failed
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "批量归档品类失败" });
  }
});

router.patch("/categories/:id/restore", async (req, res) => {
  try {
    const db = await getDb();
    const category = await db.get("SELECT id, name FROM categories WHERE id = ?", [req.params.id]);
    if (!category) return res.status(404).json({ success: false, message: "品类不存在" });
    const changes = await archiveResponse(db, "categories", req.params.id, false);
    if (changes === 0) return res.status(404).json({ success: false, message: "品类不存在" });
    await syncCshrichCatalogTracking(db, category.name, false);
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
    const references = await countMasterDataReferences(db, {
      level: "category",
      categoryId: Number(category.id),
      categoryName: category.name
    });
    if (references.length > 0) {
      return res.status(409).json({ success: false, message: formatReferenceBlockMessage(references) });
    }
    await db.run("DELETE FROM categories WHERE id = ?", [id]);
    res.json({ success: true, data: { message: "删除品类成功" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "删除品类失败" });
  }
});

router.get("/objects", async (req, res) => {
  try {
    const db = await getDb();
    // 默认列表：对象本身未归档，且若已有变体则至少保留一个未归档变体。
    // 避免“颜色全归档、对象还挂在价格工作台”的空壳对象。
    const where = includeArchived(req) ? "" : `WHERE ${ACTIVE_OBJECT_LIST_FILTER}`;
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
    const { category_id } = req.body;
    const name = normalizeText(req.body?.name);
    if (!category_id || !name) {
      return res.status(400).json({ success: false, message: "品类 ID 和名称不能为空" });
    }
    const category = await db.get("SELECT * FROM categories WHERE id = ? AND COALESCE(is_archived, 0) = 0", [category_id]);
    if (!category) return res.status(400).json({ success: false, message: "品类不存在或已归档" });
    const now = new Date().toISOString();
    try {
      const result = await db.run("INSERT INTO objects (category_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [category_id, name, now, now]);
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
    const { category_id } = req.body;
    const name = normalizeText(req.body?.name);
    if (!category_id || !name) {
      return res.status(400).json({ success: false, message: "品类 ID 和名称不能为空" });
    }
    const existingObject = await db.get(`
      SELECT o.id, o.name, o.category_id, c.name AS category_name
      FROM objects o
      JOIN categories c ON o.category_id = c.id
      WHERE o.id = ? AND COALESCE(o.is_archived, 0) = 0 AND COALESCE(c.is_archived, 0) = 0
    `, [id]);
    if (!existingObject) return res.status(404).json({ success: false, message: "对象不存在或已归档" });

    const category = await db.get("SELECT * FROM categories WHERE id = ? AND COALESCE(is_archived, 0) = 0", [category_id]);
    if (!category) return res.status(400).json({ success: false, message: "品类不存在或已归档" });
    const now = new Date().toISOString();
    try {
      await db.run("BEGIN TRANSACTION");
      await db.run("UPDATE objects SET category_id = ?, name = ?, updated_at = ? WHERE id = ?", [category_id, name, now, id]);
      await cascadeMasterDataRename(db, {
        oldCategoryId: Number(existingObject.category_id),
        newCategoryId: Number(category.id),
        oldCategoryName: existingObject.category_name,
        newCategoryName: category.name,
        oldObjectId: Number(existingObject.id),
        newObjectId: Number(existingObject.id),
        oldObjectName: existingObject.name,
        newObjectName: name
      });
      await db.run("COMMIT");
      res.json({ success: true, data: { message: "编辑对象成功" } });
    } catch (error) {
      await db.run("ROLLBACK").catch(() => undefined);
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
    const object = await db.get(`
      SELECT o.id, o.name AS object_name, c.name AS category_name
      FROM objects o
      JOIN categories c ON o.category_id = c.id
      WHERE o.id = ?
    `, [req.params.id]);
    if (!object) return res.status(404).json({ success: false, message: "对象不存在" });

    const openPositions = await countOpenPositionsForMaster(db, {
      level: "object",
      categoryName: object.category_name,
      objectName: object.object_name
    });
    if (openPositions > 0) {
      return res.status(409).json({
        success: false,
        message: formatOpenPositionArchiveBlockMessage(openPositions)
      });
    }

    const now = new Date().toISOString();
    try {
      await db.run("BEGIN IMMEDIATE TRANSACTION");
      await db.run(
        "UPDATE objects SET is_archived = 1, archived_at = ?, updated_at = ? WHERE id = ?",
        [now, now, req.params.id]
      );
      await db.run(
        `UPDATE variants
         SET is_archived = 1, archived_at = ?, updated_at = ?
         WHERE object_id = ? AND COALESCE(is_archived, 0) = 0`,
        [now, now, req.params.id]
      );
      await db.run("COMMIT");
    } catch (error) {
      await db.run("ROLLBACK").catch(() => undefined);
      throw error;
    }

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
    const object = await db.get(`
      SELECT o.*, c.name AS category_name
      FROM objects o
      JOIN categories c ON o.category_id = c.id
      WHERE o.id = ?
    `, [id]);
    if (!object) return res.status(404).json({ success: false, message: "对象不存在" });
    const result = await db.get("SELECT COUNT(1) as count FROM variants WHERE object_id = ?", [id]);
    if (result.count > 0) return res.status(409).json({ success: false, message: "该对象下仍有关联变体，无法删除" });
    const references = await countMasterDataReferences(db, {
      level: "object",
      categoryId: Number(object.category_id),
      categoryName: object.category_name,
      objectId: Number(object.id),
      objectName: object.name
    });
    if (references.length > 0) {
      return res.status(409).json({ success: false, message: formatReferenceBlockMessage(references) });
    }
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
        COALESCE(v.xianyu_heat_level, 'none') AS xianyu_heat_level,
        v.xianyu_heat_updated_at,
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
    const { object_id, note } = req.body;
    const name = normalizeText(req.body?.name);
    if (!object_id || !name) {
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
      const result = await db.run("INSERT INTO variants (object_id, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [object_id, name, typeof note === "string" ? note : "", now, now]);
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
    const existingVariant = await db.get(`
      SELECT v.id
      FROM variants v
      JOIN objects o ON v.object_id = o.id
      JOIN categories c ON o.category_id = c.id
      WHERE v.id = ? AND COALESCE(v.is_archived, 0) = 0 AND COALESCE(o.is_archived, 0) = 0 AND COALESCE(c.is_archived, 0) = 0
    `, [id]);
    if (!existingVariant) return res.status(404).json({ success: false, message: "变体不存在或已归档" });
    const now = new Date().toISOString();
    const result = await db.run("UPDATE variants SET note = ?, updated_at = ? WHERE id = ?", [note, now, id]);
    if (result.changes === 0) return res.status(404).json({ success: false, message: "变体不存在" });
    res.json({ success: true, data: { message: "保存备注成功", updated_at: now } });
  } catch (error) {
    res.status(500).json({ success: false, message: "保存变体备注失败" });
  }
});

router.patch("/variants/:id/xianyu-heat", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const heatLevel = parseVariantXianyuHeatLevel(req.body?.level);
    if (!heatLevel) {
      return res.status(400).json({ success: false, message: "闲鱼热度等级无效" });
    }

    const existingVariant = await db.get(`
      SELECT v.id
      FROM variants v
      JOIN objects o ON v.object_id = o.id
      JOIN categories c ON o.category_id = c.id
      WHERE v.id = ?
        AND COALESCE(v.is_archived, 0) = 0
        AND COALESCE(o.is_archived, 0) = 0
        AND COALESCE(c.is_archived, 0) = 0
    `, [id]);
    if (!existingVariant) {
      return res.status(404).json({ success: false, message: "变体不存在或已归档" });
    }

    const now = new Date().toISOString();
    const result = await db.run(
      `UPDATE variants
       SET xianyu_heat_level = ?, xianyu_heat_updated_at = ?, updated_at = ?
       WHERE id = ?`,
      [heatLevel, now, now, id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: "变体不存在" });
    }

    res.json({
      success: true,
      data: {
        xianyu_heat_level: heatLevel,
        xianyu_heat_updated_at: now,
        updated_at: now,
        message: heatLevel === "none" ? "闲鱼热度已清空" : "闲鱼热度已更新"
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "保存闲鱼热度失败" });
  }
});

router.put("/variants/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { object_id } = req.body;
    const name = normalizeText(req.body?.name);
    if (!object_id || !name) {
      return res.status(400).json({ success: false, message: "对象 ID 和名称不能为空" });
    }
    const existingVariant = await db.get(`
      SELECT v.id, v.name, v.object_id, o.name AS object_name, o.category_id, c.name AS category_name
      FROM variants v
      JOIN objects o ON v.object_id = o.id
      JOIN categories c ON o.category_id = c.id
      WHERE v.id = ? AND COALESCE(v.is_archived, 0) = 0 AND COALESCE(o.is_archived, 0) = 0 AND COALESCE(c.is_archived, 0) = 0
    `, [id]);
    if (!existingVariant) return res.status(404).json({ success: false, message: "变体不存在或已归档" });

    const object = await db.get(`
      SELECT o.id, o.name, o.category_id, c.name AS category_name FROM objects o
      JOIN categories c ON o.category_id = c.id
      WHERE o.id = ? AND COALESCE(o.is_archived, 0) = 0 AND COALESCE(c.is_archived, 0) = 0
    `, [object_id]);
    if (!object) return res.status(400).json({ success: false, message: "对象不存在或已归档" });
    const now = new Date().toISOString();
    try {
      await db.run("BEGIN TRANSACTION");
      await db.run("UPDATE variants SET object_id = ?, name = ?, updated_at = ? WHERE id = ?", [object_id, name, now, id]);
      await cascadeMasterDataRename(db, {
        oldCategoryId: Number(existingVariant.category_id),
        newCategoryId: Number(object.category_id),
        oldCategoryName: existingVariant.category_name,
        newCategoryName: object.category_name,
        oldObjectId: Number(existingVariant.object_id),
        newObjectId: Number(object.id),
        oldObjectName: existingVariant.object_name,
        newObjectName: object.name,
        oldVariantId: Number(existingVariant.id),
        newVariantId: Number(existingVariant.id),
        oldVariantName: existingVariant.name,
        newVariantName: name
      });
      await db.run("COMMIT");
      res.json({ success: true, data: { message: "编辑变体成功" } });
    } catch (error) {
      await db.run("ROLLBACK").catch(() => undefined);
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
    const variant = await db.get(
      `SELECT v.id, v.object_id, v.name AS variant_name,
              o.name AS object_name, c.name AS category_name
       FROM variants v
       JOIN objects o ON v.object_id = o.id
       JOIN categories c ON o.category_id = c.id
       WHERE v.id = ?`,
      [req.params.id]
    );
    if (!variant) return res.status(404).json({ success: false, message: "变体不存在" });

    const openPositions = await countOpenPositionsForMaster(db, {
      level: "variant",
      categoryName: variant.category_name,
      objectName: variant.object_name,
      variantName: variant.variant_name
    });
    if (openPositions > 0) {
      return res.status(409).json({
        success: false,
        message: formatOpenPositionArchiveBlockMessage(openPositions)
      });
    }

    try {
      await db.run("BEGIN IMMEDIATE TRANSACTION");
      const changes = await archiveResponse(db, "variants", req.params.id, true);
      if (changes === 0) {
        await db.run("ROLLBACK").catch(() => undefined);
        return res.status(404).json({ success: false, message: "变体不存在" });
      }

      // 该对象下变体已全部归档时，同步归档对象，避免工作台/下拉继续露出空壳对象。
      if (
        (await objectHasAnyVariants(db, variant.object_id))
        && !(await objectHasActiveVariants(db, variant.object_id))
      ) {
        await archiveResponse(db, "objects", String(variant.object_id), true);
      }
      await db.run("COMMIT");
    } catch (error) {
      await db.run("ROLLBACK").catch(() => undefined);
      throw error;
    }

    res.json({ success: true, data: { message: "变体已归档" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "归档变体失败" });
  }
});

router.patch("/variants/:id/restore", async (req, res) => {
  try {
    const db = await getDb();
    const variant = await db.get(`
      SELECT v.id, v.object_id, COALESCE(o.is_archived, 0) AS object_is_archived
      FROM variants v
      JOIN objects o ON v.object_id = o.id
      JOIN categories c ON o.category_id = c.id
      WHERE v.id = ? AND COALESCE(c.is_archived, 0) = 0
    `, [req.params.id]);
    if (!variant) return res.status(400).json({ success: false, message: "变体不存在或所属品类已归档" });

    // 恢复变体时，若对象已归档则一并恢复，否则无法重新进入工作台。
    if (Number(variant.object_is_archived) === 1) {
      await archiveResponse(db, "objects", String(variant.object_id), false);
    }

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
    const variant = await db.get(`
      SELECT v.*, o.name AS object_name, o.category_id, c.name AS category_name
      FROM variants v
      JOIN objects o ON v.object_id = o.id
      JOIN categories c ON o.category_id = c.id
      WHERE v.id = ?
    `, [id]);
    if (!variant) return res.status(404).json({ success: false, message: "变体不存在" });
    const references = await countMasterDataReferences(db, {
      level: "variant",
      categoryId: Number(variant.category_id),
      categoryName: variant.category_name,
      objectId: Number(variant.object_id),
      objectName: variant.object_name,
      variantId: Number(variant.id),
      variantName: variant.name
    });
    if (references.length > 0) {
      return res.status(409).json({ success: false, message: formatReferenceBlockMessage(references) });
    }
    await db.run("DELETE FROM variants WHERE id = ?", [id]);
    res.json({ success: true, data: { message: "删除变体成功" } });
  } catch (error) {
    res.status(500).json({ success: false, message: "删除变体失败" });
  }
});

export default router;
