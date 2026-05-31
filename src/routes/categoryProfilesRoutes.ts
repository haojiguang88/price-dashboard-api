import express from "express";
import getDb from "../config/database";

const router = express.Router();

const VALID_STATUSES = new Set(["active", "draft", "archived"]);

const PROFILE_FIELDS = [
  "business_style",
  "operation_scene",
  "supply_mode",
  "sales_mode",
  "price_pattern",
  "risk_points",
  "operating_discipline",
  "data_caliber",
  "experience_notes",
  "decision_notes",
  "note"
] as const;

const normalizeText = (value: unknown) => String(value ?? "").trim();

const parseOptionalPositiveInteger = (value: unknown) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeExtraJson = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      throw new Error("扩展信息必须是合法 JSON");
    }
  }
  return JSON.stringify(value);
};

const parseExtraJson = (value?: string | null) => {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const serializeProfile = (row: any) => ({
  ...row,
  id: String(row.id),
  category_id: row.category_id ? String(row.category_id) : "",
  extra: parseExtraJson(row.extra_json)
});

const writeProfileAuditLog = async (db: any, action: string, profile: any) => {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO audit_logs
      (id, timestamp, module, action, target, status, detail, entity_id, path, domain, workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `category_profile_${action}_${profile.id}_${Date.now()}`,
      now,
      "品类画像",
      action,
      profile.category_name,
      "success",
      profile.note || "",
      String(profile.id),
      "/risk-control/category-profiles",
      "business",
      "business",
      now,
      now
    ]
  ).catch(() => undefined);
};

const loadProfile = async (db: any, id: string) => db.get(
  `SELECT cp.*, c.name AS master_category_name, COALESCE(c.is_archived, 0) AS category_is_archived
   FROM category_profiles cp
   LEFT JOIN categories c ON cp.category_id = c.id
   WHERE cp.id = ? AND COALESCE(cp.is_deleted, 0) = 0`,
  [id]
);

const buildPayload = async (db: any, body: Record<string, any>, existing?: any) => {
  const categoryIdInput = Object.prototype.hasOwnProperty.call(body, "category_id")
    ? body.category_id
    : existing?.category_id;
  const categoryId = parseOptionalPositiveInteger(categoryIdInput);
  let categoryName = normalizeText(body.category_name ?? existing?.category_name);

  if (categoryId) {
    const category = await db.get(
      "SELECT id, name FROM categories WHERE id = ? AND COALESCE(is_archived, 0) = 0",
      [categoryId]
    );
    if (!category) {
      throw new Error("关联的主数据品类不存在或已归档");
    }
    categoryName = category.name;
  }

  if (!categoryName) {
    throw new Error("品类名称不能为空");
  }

  const status = normalizeText(body.status ?? existing?.status ?? "active");
  if (!VALID_STATUSES.has(status)) {
    throw new Error("画像状态只能是 active、draft、archived");
  }

  const duplicate = categoryId
    ? await db.get(
      `SELECT id FROM category_profiles
       WHERE COALESCE(is_deleted, 0) = 0 AND category_id = ? AND id != ?`,
      [categoryId, existing?.id || 0]
    )
    : await db.get(
      `SELECT id FROM category_profiles
       WHERE COALESCE(is_deleted, 0) = 0 AND category_id IS NULL AND category_name = ? AND id != ?`,
      [categoryName, existing?.id || 0]
    );
  if (duplicate) {
    throw new Error("这个品类已经有画像，请直接编辑原画像");
  }

  const payload: Record<string, any> = {
    category_id: categoryId,
    category_name: categoryName,
    status,
    extra_json: normalizeExtraJson(body.extra_json ?? existing?.extra_json),
    ...PROFILE_FIELDS.reduce<Record<string, string>>((acc, field) => {
      acc[field] = normalizeText(body[field] ?? existing?.[field]);
      return acc;
    }, {})
  };
  return payload;
};

router.get("/category-profiles", async (req, res) => {
  try {
    const db = await getDb();
    const where = ["COALESCE(cp.is_deleted, 0) = 0"];
    const params: any[] = [];
    const q = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    const categoryId = parseOptionalPositiveInteger(req.query.category_id);

    if (q) {
      where.push(`(
        cp.category_name LIKE ?
        OR cp.business_style LIKE ?
        OR cp.operation_scene LIKE ?
        OR cp.risk_points LIKE ?
        OR cp.decision_notes LIKE ?
      )`);
      const likeValue = `%${q}%`;
      params.push(likeValue, likeValue, likeValue, likeValue, likeValue);
    }
    if (status) {
      where.push("cp.status = ?");
      params.push(status);
    }
    if (categoryId) {
      where.push("cp.category_id = ?");
      params.push(categoryId);
    }

    const rows = await db.all(
      `SELECT cp.*, c.name AS master_category_name, COALESCE(c.is_archived, 0) AS category_is_archived
       FROM category_profiles cp
       LEFT JOIN categories c ON cp.category_id = c.id
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE cp.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
         datetime(cp.updated_at) DESC,
         cp.id DESC`,
      params
    );

    res.json({ success: true, data: rows.map(serializeProfile) });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取品类画像失败: ${(error as Error).message}` });
  }
});

router.get("/category-profiles/:id", async (req, res) => {
  try {
    const db = await getDb();
    const profile = await loadProfile(db, String(req.params.id));
    if (!profile) {
      return res.status(404).json({ success: false, message: "品类画像不存在" });
    }
    res.json({ success: true, data: serializeProfile(profile) });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取品类画像详情失败: ${(error as Error).message}` });
  }
});

router.post("/category-profiles", async (req, res) => {
  try {
    const db = await getDb();
    const payload = await buildPayload(db, req.body || {});
    const now = new Date().toISOString();
    const result = await db.run(
      `INSERT INTO category_profiles
        (category_id, category_name, business_style, operation_scene, supply_mode, sales_mode,
         price_pattern, risk_points, operating_discipline, data_caliber, experience_notes,
         decision_notes, extra_json, status, note, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        payload.category_id,
        payload.category_name,
        payload.business_style,
        payload.operation_scene,
        payload.supply_mode,
        payload.sales_mode,
        payload.price_pattern,
        payload.risk_points,
        payload.operating_discipline,
        payload.data_caliber,
        payload.experience_notes,
        payload.decision_notes,
        payload.extra_json,
        payload.status,
        payload.note,
        now,
        now
      ]
    );
    const profile = await loadProfile(db, String(result.lastID));
    await writeProfileAuditLog(db, "create", profile);
    res.json({ success: true, data: serializeProfile(profile), message: "新增品类画像成功" });
  } catch (error) {
    res.status(400).json({ success: false, message: (error as Error).message || "新增品类画像失败" });
  }
});

router.put("/category-profiles/:id", async (req, res) => {
  try {
    const db = await getDb();
    const existing = await loadProfile(db, String(req.params.id));
    if (!existing) {
      return res.status(404).json({ success: false, message: "品类画像不存在" });
    }
    const payload = await buildPayload(db, req.body || {}, existing);
    const now = new Date().toISOString();
    await db.run(
      `UPDATE category_profiles
       SET category_id = ?, category_name = ?, business_style = ?, operation_scene = ?,
           supply_mode = ?, sales_mode = ?, price_pattern = ?, risk_points = ?,
           operating_discipline = ?, data_caliber = ?, experience_notes = ?, decision_notes = ?,
           extra_json = ?, status = ?, note = ?, updated_at = ?
       WHERE id = ? AND COALESCE(is_deleted, 0) = 0`,
      [
        payload.category_id,
        payload.category_name,
        payload.business_style,
        payload.operation_scene,
        payload.supply_mode,
        payload.sales_mode,
        payload.price_pattern,
        payload.risk_points,
        payload.operating_discipline,
        payload.data_caliber,
        payload.experience_notes,
        payload.decision_notes,
        payload.extra_json,
        payload.status,
        payload.note,
        now,
        existing.id
      ]
    );
    const profile = await loadProfile(db, String(existing.id));
    await writeProfileAuditLog(db, "update", profile);
    res.json({ success: true, data: serializeProfile(profile), message: "编辑品类画像成功" });
  } catch (error) {
    res.status(400).json({ success: false, message: (error as Error).message || "编辑品类画像失败" });
  }
});

router.delete("/category-profiles/:id", async (req, res) => {
  try {
    const db = await getDb();
    const profile = await loadProfile(db, String(req.params.id));
    if (!profile) {
      return res.status(404).json({ success: false, message: "品类画像不存在" });
    }
    await db.run(
      "UPDATE category_profiles SET is_deleted = 1, updated_at = ? WHERE id = ?",
      [new Date().toISOString(), profile.id]
    );
    await writeProfileAuditLog(db, "delete", profile);
    res.json({ success: true, data: { id: String(profile.id) }, message: "删除品类画像成功" });
  } catch (error) {
    res.status(500).json({ success: false, message: `删除品类画像失败: ${(error as Error).message}` });
  }
});

export default router;
