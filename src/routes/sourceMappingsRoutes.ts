import express from "express";
import getDb from "../config/database";
import { validateActiveMasterTargetByIds } from "../utils/masterData";

const router = express.Router();

const VALID_STATUSES = new Set(["enabled", "disabled", "unmapped", "missing_source"]);

const normalizeText = (value: unknown) => String(value ?? "").trim();

const parseOptionalPositiveInteger = (value: unknown) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseOptionalVariantId = (value: unknown) => {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const normalizeMetaJson = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "{}";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      throw new Error("来源扩展信息必须是合法 JSON");
    }
  }
  return JSON.stringify(value);
};

const fetchMapping = async (db: any, id: string) => db.get(
  `SELECT *
   FROM source_mappings
   WHERE id = ?`,
  [id]
);

const buildTargetPayload = async (db: any, body: Record<string, any>) => {
  const categoryId = parseOptionalPositiveInteger(body.category_id);
  const objectId = parseOptionalPositiveInteger(body.object_id);
  const variantId = parseOptionalVariantId(body.variant_id);

  if (!categoryId && !objectId && (variantId === 0 || variantId === null)) {
    return {
      hasTarget: false,
      category_id: null,
      object_id: null,
      variant_id: 0,
      category_name: normalizeText(body.category_name),
      object_name: normalizeText(body.object_name),
      variant_name: normalizeText(body.variant_name)
    };
  }

  if (!categoryId || !objectId || variantId === null) {
    throw new Error("选择映射目标时，品类和对象必须同时有效");
  }

  const validation = await validateActiveMasterTargetByIds(db, categoryId, objectId, variantId);
  if (!validation.ok) throw new Error(validation.message);

  return {
    hasTarget: true,
    ...validation.target
  };
};

const normalizePayload = async (db: any, body: Record<string, any>, existing?: any) => {
  const sourceKey = normalizeText(body.source_key ?? existing?.source_key);
  const sourceName = normalizeText(body.source_name ?? existing?.source_name);
  const externalKey = normalizeText(body.external_key ?? existing?.external_key);
  const externalName = normalizeText(body.external_name ?? existing?.external_name);

  if (!sourceKey || !sourceName || !externalKey) {
    throw new Error("来源标识、来源名称、外部标识不能为空");
  }

  const target = await buildTargetPayload(db, {
    category_id: body.category_id ?? existing?.category_id,
    object_id: body.object_id ?? existing?.object_id,
    variant_id: body.variant_id ?? existing?.variant_id ?? 0,
    category_name: body.category_name ?? existing?.category_name,
    object_name: body.object_name ?? existing?.object_name,
    variant_name: body.variant_name ?? existing?.variant_name
  });
  const status = normalizeText(body.status ?? existing?.status ?? (target.hasTarget ? "enabled" : "unmapped"));
  if (!VALID_STATUSES.has(status)) {
    throw new Error("映射状态只能是 enabled、disabled、unmapped、missing_source");
  }

  return {
    source_key: sourceKey,
    source_name: sourceName,
    external_key: externalKey,
    external_name: externalName,
    external_meta_json: normalizeMetaJson(body.external_meta_json ?? existing?.external_meta_json),
    category_id: target.category_id,
    object_id: target.object_id,
    variant_id: target.variant_id || 0,
    category_name: target.category_name,
    object_name: target.object_name,
    variant_name: target.variant_name || "",
    status,
    last_seen_at: normalizeText(body.last_seen_at ?? existing?.last_seen_at),
    last_matched_at: normalizeText(body.last_matched_at ?? existing?.last_matched_at),
    last_error: normalizeText(body.last_error ?? existing?.last_error),
    note: normalizeText(body.note ?? existing?.note)
  };
};

router.get("/source-mappings/sources", async (_req, res) => {
  try {
    const db = await getDb();
    const rows = await db.all(`
      SELECT
        source_key,
        MAX(source_name) AS source_name,
        COUNT(1) AS total_count,
        SUM(CASE WHEN status = 'enabled' THEN 1 ELSE 0 END) AS enabled_count,
        SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled_count,
        SUM(CASE WHEN status = 'unmapped' THEN 1 ELSE 0 END) AS unmapped_count,
        SUM(CASE WHEN status = 'missing_source' THEN 1 ELSE 0 END) AS missing_source_count,
        SUM(CASE WHEN last_error IS NOT NULL AND TRIM(last_error) != '' THEN 1 ELSE 0 END) AS last_error_count,
        MAX(last_seen_at) AS last_seen_at,
        MAX(last_matched_at) AS last_matched_at,
        MAX(updated_at) AS updated_at
      FROM source_mappings
      GROUP BY source_key
      ORDER BY source_key ASC
    `);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取来源列表失败: ${(error as Error).message}` });
  }
});

router.get("/source-mappings", async (req, res) => {
  try {
    const db = await getDb();
    const where: string[] = [];
    const params: any[] = [];
    const sourceKey = normalizeText(req.query.source_key);
    const status = normalizeText(req.query.status);
    const q = normalizeText(req.query.q);
    const issueOnly = ["1", "true", "yes"].includes(normalizeText(req.query.issue).toLowerCase());

    if (sourceKey) {
      where.push("source_key = ?");
      params.push(sourceKey);
    }
    if (status === "has_error") {
      where.push("last_error IS NOT NULL AND TRIM(last_error) != ''");
    } else if (status) {
      where.push("status = ?");
      params.push(status);
    }
    if (issueOnly) {
      where.push(`(
        status IN ('unmapped', 'missing_source')
        OR (last_error IS NOT NULL AND TRIM(last_error) != '')
      )`);
    }
    if (q) {
      where.push(`(
        source_key LIKE ?
        OR source_name LIKE ?
        OR external_key LIKE ?
        OR external_name LIKE ?
        OR category_name LIKE ?
        OR object_name LIKE ?
        OR variant_name LIKE ?
      )`);
      const likeValue = `%${q}%`;
      params.push(likeValue, likeValue, likeValue, likeValue, likeValue, likeValue, likeValue);
    }

    const rows = await db.all(
      `SELECT *
       FROM source_mappings
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY source_key ASC, status ASC, object_name ASC, external_name ASC, id ASC`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取数据源映射失败: ${(error as Error).message}` });
  }
});

router.post("/source-mappings", async (req, res) => {
  try {
    const db = await getDb();
    const payload = await normalizePayload(db, req.body || {});
    const now = new Date().toISOString();
    const result = await db.run(
      `INSERT INTO source_mappings
        (source_key, source_name, external_key, external_name, external_meta_json,
         category_id, object_id, variant_id, category_name, object_name, variant_name,
         status, last_seen_at, last_matched_at, last_error, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.source_key,
        payload.source_name,
        payload.external_key,
        payload.external_name,
        payload.external_meta_json,
        payload.category_id,
        payload.object_id,
        payload.variant_id,
        payload.category_name,
        payload.object_name,
        payload.variant_name,
        payload.status,
        payload.last_seen_at || null,
        payload.last_matched_at || null,
        payload.last_error || null,
        payload.note,
        now,
        now
      ]
    );
    const mapping = await fetchMapping(db, String(result.lastID));
    res.json({ success: true, data: mapping, message: "数据源映射已新增" });
  } catch (error) {
    const message = (error as Error).message;
    const statusCode = message.includes("UNIQUE constraint failed") ? 409 : 400;
    res.status(statusCode).json({ success: false, message: `新增数据源映射失败: ${message}` });
  }
});

router.post("/source-mappings/:id/clear-error", async (req, res) => {
  try {
    const db = await getDb();
    const existing = await fetchMapping(db, String(req.params.id));
    if (!existing) return res.status(404).json({ success: false, message: "数据源映射不存在" });

    const now = new Date().toISOString();
    await db.run(
      `UPDATE source_mappings
       SET last_error = NULL,
           updated_at = ?
       WHERE id = ?`,
      [now, req.params.id]
    );
    const mapping = await fetchMapping(db, String(req.params.id));
    res.json({ success: true, data: mapping, message: "来源错误已清除" });
  } catch (error) {
    res.status(500).json({ success: false, message: `清除来源错误失败: ${(error as Error).message}` });
  }
});

router.patch("/source-mappings/:id/status", async (req, res) => {
  try {
    const db = await getDb();
    const existing = await fetchMapping(db, String(req.params.id));
    if (!existing) return res.status(404).json({ success: false, message: "数据源映射不存在" });

    const status = normalizeText(req.body?.status);
    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({ success: false, message: "映射状态只能是 enabled、disabled、unmapped、missing_source" });
    }

    const now = new Date().toISOString();
    const clearError = req.body?.clear_error !== false;
    await db.run(
      `UPDATE source_mappings
       SET status = ?,
           last_error = CASE WHEN ? THEN NULL ELSE last_error END,
           updated_at = ?
       WHERE id = ?`,
      [status, clearError ? 1 : 0, now, req.params.id]
    );
    const mapping = await fetchMapping(db, String(req.params.id));
    res.json({ success: true, data: mapping, message: "映射状态已更新" });
  } catch (error) {
    res.status(500).json({ success: false, message: `更新映射状态失败: ${(error as Error).message}` });
  }
});

router.put("/source-mappings/:id", async (req, res) => {
  try {
    const db = await getDb();
    const existing = await fetchMapping(db, String(req.params.id));
    if (!existing) return res.status(404).json({ success: false, message: "数据源映射不存在" });

    const payload = await normalizePayload(db, req.body || {}, existing);
    const now = new Date().toISOString();
    await db.run(
      `UPDATE source_mappings
       SET source_key = ?,
           source_name = ?,
           external_key = ?,
           external_name = ?,
           external_meta_json = ?,
           category_id = ?,
           object_id = ?,
           variant_id = ?,
           category_name = ?,
           object_name = ?,
           variant_name = ?,
           status = ?,
           last_seen_at = ?,
           last_matched_at = ?,
           last_error = ?,
           note = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        payload.source_key,
        payload.source_name,
        payload.external_key,
        payload.external_name,
        payload.external_meta_json,
        payload.category_id,
        payload.object_id,
        payload.variant_id,
        payload.category_name,
        payload.object_name,
        payload.variant_name,
        payload.status,
        payload.last_seen_at || null,
        payload.last_matched_at || null,
        payload.last_error || null,
        payload.note,
        now,
        req.params.id
      ]
    );
    const mapping = await fetchMapping(db, String(req.params.id));
    res.json({ success: true, data: mapping, message: "数据源映射已更新" });
  } catch (error) {
    const message = (error as Error).message;
    const statusCode = message.includes("UNIQUE constraint failed") ? 409 : 400;
    res.status(statusCode).json({ success: false, message: `更新数据源映射失败: ${message}` });
  }
});

router.delete("/source-mappings/:id", async (req, res) => {
  try {
    const db = await getDb();
    const existing = await fetchMapping(db, String(req.params.id));
    if (!existing) return res.status(404).json({ success: false, message: "数据源映射不存在" });
    await db.run("DELETE FROM source_mappings WHERE id = ?", [req.params.id]);
    res.json({ success: true, data: existing, message: "数据源映射已删除" });
  } catch (error) {
    res.status(500).json({ success: false, message: `删除数据源映射失败: ${(error as Error).message}` });
  }
});

export default router;
