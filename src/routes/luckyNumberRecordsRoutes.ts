import express from "express";
import getDb from "../config/database";

const router = express.Router();

const DEFAULT_YEAR = "2025年";
const SEED_PREFERENCE_KEY = "lucky_number_seed_version";
const RATING_TYPES = ["首日", "首期", "首年", "普通"];

const normalizeText = (value: unknown) => String(value ?? "").trim();

const normalizeYear = (value: unknown) => {
  const text = normalizeText(value);
  if (/^20\d{2}$/.test(text)) return `${text}年`;
  if (/^20\d{2}年$/.test(text)) return text;
  return DEFAULT_YEAR;
};

const normalizeRatingType = (value: unknown) => {
  const text = normalizeText(value);
  return RATING_TYPES.includes(text) ? text : "普通";
};

const serializeRecord = (row: any) => ({
  id: String(row.id),
  product_name: row.product_name || "",
  number_code: row.number_code || "",
  year: row.year || DEFAULT_YEAR,
  raw_type: row.raw_type || "",
  rating_type: row.rating_type || "普通",
  rating_score: row.rating_score || "",
  source_raw: row.source_raw || "",
  note: row.note || "",
  is_sold: Number(row.is_sold || 0),
  sold_at: row.sold_at || "",
  created_at: row.created_at || "",
  updated_at: row.updated_at || ""
});

const buildPayload = (body: Record<string, any>, existing?: any) => {
  const payload = {
    product_name: normalizeText(body.product_name ?? existing?.product_name),
    number_code: normalizeText(body.number_code ?? existing?.number_code),
    year: normalizeYear(body.year ?? existing?.year),
    raw_type: normalizeText(body.raw_type ?? existing?.raw_type),
    rating_type: normalizeRatingType(body.rating_type ?? existing?.rating_type),
    rating_score: normalizeText(body.rating_score ?? existing?.rating_score),
    source_raw: normalizeText(body.source_raw ?? existing?.source_raw),
    note: normalizeText(body.note ?? existing?.note)
  };

  if (!payload.product_name) {
    throw new Error("品种不能为空");
  }
  if (!payload.number_code) {
    throw new Error("号码不能为空");
  }

  return payload;
};

const loadRecord = async (db: any, id: string) => db.get(
  `SELECT *
   FROM lucky_number_records
   WHERE id = ? AND COALESCE(is_deleted, 0) = 0`,
  [id]
);

const writeLuckyAuditLog = async (db: any, action: string, record: any, detail = "") => {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO audit_logs
      (id, timestamp, module, action, target, status, detail, entity_id, path, domain, workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `lucky_number_${action}_${record.id || "batch"}_${Date.now()}`,
      now,
      "靓号统计",
      action,
      [record.product_name, record.number_code].filter(Boolean).join(" / ") || "批量种子",
      "success",
      detail || record.raw_type || "",
      String(record.id || ""),
      "/risk-control/lucky-number-stats",
      "business",
      "business",
      now,
      now
    ]
  ).catch(() => undefined);
};

const listRecords = async (db: any, query: Record<string, any> = {}) => {
  const where = ["COALESCE(is_deleted, 0) = 0"];
  const params: any[] = [];
  const q = normalizeText(query.q);
  const productName = normalizeText(query.product_name);
  const year = normalizeText(query.year);
  const includeSold = ["1", "true", "yes"].includes(normalizeText(query.include_sold).toLowerCase());

  if (!includeSold) {
    where.push("COALESCE(is_sold, 0) = 0");
  }

  if (q) {
    where.push("(product_name LIKE ? OR number_code LIKE ? OR raw_type LIKE ? OR note LIKE ?)");
    const likeValue = `%${q}%`;
    params.push(likeValue, likeValue, likeValue, likeValue);
  }
  if (productName) {
    where.push("product_name = ?");
    params.push(productName);
  }
  if (year) {
    where.push("year = ?");
    params.push(normalizeYear(year));
  }

  return db.all(
    `SELECT *
     FROM lucky_number_records
     WHERE ${where.join(" AND ")}
     ORDER BY id ASC`,
    params
  );
};

router.get("/lucky-number-records", async (req, res) => {
  try {
    const db = await getDb();
    const rows = await listRecords(db, req.query as Record<string, any>);
    res.json({ success: true, data: rows.map(serializeRecord), total: rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取靓号统计失败: ${(error as Error).message}` });
  }
});

router.post("/lucky-number-records", async (req, res) => {
  try {
    const db = await getDb();
    const payload = buildPayload(req.body || {});
    const now = new Date().toISOString();
    const result = await db.run(
      `INSERT INTO lucky_number_records
        (product_name, number_code, year, raw_type, rating_type, rating_score, source_raw, note, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        payload.product_name,
        payload.number_code,
        payload.year,
        payload.raw_type,
        payload.rating_type,
        payload.rating_score,
        payload.source_raw,
        payload.note,
        now,
        now
      ]
    );
    const record = await loadRecord(db, String(result.lastID));
    await writeLuckyAuditLog(db, "create", record);
    res.json({ success: true, data: serializeRecord(record), message: "新增靓号记录成功" });
  } catch (error) {
    res.status(400).json({ success: false, message: (error as Error).message || "新增靓号记录失败" });
  }
});

router.post("/lucky-number-records/batch", async (req, res) => {
  const seedVersion = normalizeText(req.body?.seed_version);
  const records = Array.isArray(req.body?.records) ? req.body.records : [];

  try {
    const db = await getDb();
    const existingPreference = seedVersion
      ? await db.get(
        "SELECT preference_value FROM user_preferences WHERE user_key = 'default' AND preference_key = ?",
        [SEED_PREFERENCE_KEY]
      )
      : null;

    if (seedVersion && existingPreference?.preference_value === seedVersion) {
      const rows = await listRecords(db);
      return res.json({
        success: true,
        data: rows.map(serializeRecord),
        total: rows.length,
        inserted: 0,
        skipped: records.length,
        message: "靓号种子数据已导入"
      });
    }

    const now = new Date().toISOString();
    let inserted = 0;
    let skipped = 0;

    for (const item of records) {
      let payload;
      try {
        payload = buildPayload(item || {});
      } catch {
        skipped += 1;
        continue;
      }

      const result = await db.run(
        `INSERT OR IGNORE INTO lucky_number_records
          (product_name, number_code, year, raw_type, rating_type, rating_score, source_raw, note, is_deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          payload.product_name,
          payload.number_code,
          payload.year,
          payload.raw_type,
          payload.rating_type,
          payload.rating_score,
          payload.source_raw,
          payload.note,
          now,
          now
        ]
      );

      if (result.changes && result.changes > 0) {
        inserted += 1;
      } else {
        skipped += 1;
      }
    }

    if (seedVersion) {
      await db.run(
        `INSERT INTO user_preferences (user_key, preference_key, preference_value, created_at, updated_at)
         VALUES ('default', ?, ?, ?, ?)
         ON CONFLICT(user_key, preference_key)
         DO UPDATE SET preference_value = excluded.preference_value, updated_at = excluded.updated_at`,
        [SEED_PREFERENCE_KEY, seedVersion, now, now]
      );
    }

    const rows = await listRecords(db);
    await writeLuckyAuditLog(db, "batch_seed", { id: "batch", product_name: "靓号统计", number_code: "" }, `新增 ${inserted} 条，跳过 ${skipped} 条`);
    res.json({
      success: true,
      data: rows.map(serializeRecord),
      total: rows.length,
      inserted,
      skipped,
      message: "批量写入靓号记录成功"
    });
  } catch (error) {
    res.status(400).json({ success: false, message: (error as Error).message || "批量写入靓号记录失败" });
  }
});

router.put("/lucky-number-records/:id", async (req, res) => {
  try {
    const db = await getDb();
    const existing = await loadRecord(db, String(req.params.id));
    if (!existing) {
      return res.status(404).json({ success: false, message: "靓号记录不存在" });
    }

    const payload = buildPayload(req.body || {}, existing);
    const now = new Date().toISOString();
    await db.run(
      `UPDATE lucky_number_records
       SET product_name = ?, number_code = ?, year = ?, raw_type = ?, rating_type = ?, rating_score = ?, source_raw = ?, note = ?, updated_at = ?
       WHERE id = ? AND COALESCE(is_deleted, 0) = 0`,
      [
        payload.product_name,
        payload.number_code,
        payload.year,
        payload.raw_type,
        payload.rating_type,
        payload.rating_score,
        payload.source_raw,
        payload.note,
        now,
        existing.id
      ]
    );

    const record = await loadRecord(db, String(existing.id));
    await writeLuckyAuditLog(db, "update", record);
    res.json({ success: true, data: serializeRecord(record), message: "编辑靓号记录成功" });
  } catch (error) {
    res.status(400).json({ success: false, message: (error as Error).message || "编辑靓号记录失败" });
  }
});

router.post("/lucky-number-records/:id/sell", async (req, res) => {
  try {
    const db = await getDb();
    const existing = await loadRecord(db, String(req.params.id));
    if (!existing) {
      return res.status(404).json({ success: false, message: "靓号记录不存在" });
    }

    const now = new Date().toISOString();
    if (!Number(existing.is_sold || 0)) {
      await db.run(
        `UPDATE lucky_number_records
         SET is_sold = 1, sold_at = ?, updated_at = ?
         WHERE id = ? AND COALESCE(is_deleted, 0) = 0`,
        [now, now, existing.id]
      );
    }

    const record = await loadRecord(db, String(existing.id));
    await writeLuckyAuditLog(db, "sell", record, "标记为已卖出，不再进入靓号统计看板");
    res.json({ success: true, data: serializeRecord(record), message: "靓号记录已标记卖出" });
  } catch (error) {
    res.status(400).json({ success: false, message: (error as Error).message || "标记卖出失败" });
  }
});

router.delete("/lucky-number-records/:id", async (req, res) => {
  try {
    const db = await getDb();
    const existing = await loadRecord(db, String(req.params.id));
    if (!existing) {
      return res.status(404).json({ success: false, message: "靓号记录不存在" });
    }

    await db.run(
      "UPDATE lucky_number_records SET is_deleted = 1, updated_at = ? WHERE id = ?",
      [new Date().toISOString(), existing.id]
    );
    await writeLuckyAuditLog(db, "delete", existing);
    res.json({ success: true, data: { id: String(existing.id) }, message: "删除靓号记录成功" });
  } catch (error) {
    res.status(500).json({ success: false, message: `删除靓号记录失败: ${(error as Error).message}` });
  }
});

export default router;
