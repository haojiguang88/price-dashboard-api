import { randomUUID } from "node:crypto";
import express from "express";
import getDb, { withTransaction } from "../config/database";
import { normalizeSelfCognitionProfileInput } from "../services/selfCognitionProfileService";

const router = express.Router();

const parseContent = (value: unknown) => {
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
};

const serializeCurrent = (row: any) => ({
  id: String(row.id),
  versionLabel: row.version_label,
  profileDate: row.profile_date,
  changeNote: row.change_note || "",
  phaseTitle: row.phase_title,
  phaseSummary: row.phase_summary,
  content: parseContent(row.content_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const serializeVersion = (row: any) => ({
  id: String(row.id),
  profileId: String(row.profile_id),
  versionLabel: row.version_label,
  profileDate: row.profile_date,
  changeNote: row.change_note,
  phaseTitle: row.phase_title,
  phaseSummary: row.phase_summary,
  content: parseContent(row.content_json),
  createdAt: row.created_at
});

const loadProfileBundle = async (db: any) => {
  const current = await db.get(
    `SELECT p.*,
            (SELECT v.change_note
             FROM self_cognition_profile_versions v
             WHERE v.profile_id = p.id
             ORDER BY datetime(v.created_at) DESC, v.id DESC
             LIMIT 1) AS change_note
     FROM self_cognition_profiles p
     WHERE p.id = 1`
  );
  if (!current) return null;

  const versions = await db.all(
    `SELECT id, profile_id, version_label, profile_date, change_note,
            phase_title, phase_summary, content_json, created_at
     FROM self_cognition_profile_versions
     WHERE profile_id = 1
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT 100`
  );

  return {
    current: serializeCurrent(current),
    versions: versions.map(serializeVersion)
  };
};

router.get("/self-cognition-profile", async (_req, res, next) => {
  try {
    const db = await getDb();
    const data = await loadProfileBundle(db);
    if (!data) {
      return res.status(404).json({ success: false, message: "本人画像尚未初始化" });
    }
    return res.json({ success: true, data, message: "获取本人画像成功" });
  } catch (error) {
    return next(error);
  }
});

router.put("/self-cognition-profile", async (req, res, next) => {
  try {
    let input;
    try {
      input = normalizeSelfCognitionProfileInput(req.body || {});
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : "画像内容不合法"
      });
    }

    const data = await withTransaction(async (db) => {
      const existing = await db.get("SELECT id FROM self_cognition_profiles WHERE id = 1");
      if (!existing) throw new Error("本人画像尚未初始化，请先执行数据库迁移");

      const now = new Date().toISOString();
      const contentJson = JSON.stringify(input.content);
      await db.run(
        `UPDATE self_cognition_profiles
         SET version_label = ?,
             profile_date = ?,
             phase_title = ?,
             phase_summary = ?,
             content_json = ?,
             updated_at = ?
         WHERE id = 1`,
        [
          input.versionLabel,
          input.profileDate,
          input.phaseTitle,
          input.phaseSummary,
          contentJson,
          now
        ]
      );

      await db.run(
        `INSERT INTO self_cognition_profile_versions
          (profile_id, version_label, profile_date, change_note, phase_title, phase_summary, content_json, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.versionLabel,
          input.profileDate,
          input.changeNote,
          input.phaseTitle,
          input.phaseSummary,
          contentJson,
          now
        ]
      );

      await db.run(
        `INSERT INTO audit_logs
          (id, timestamp, module, action, target, status, detail, entity_id, path, domain, workspace, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `audit-${randomUUID()}`,
          now,
          "本人画像",
          "update",
          input.versionLabel,
          "success",
          JSON.stringify({ changeNote: input.changeNote, phaseTitle: input.phaseTitle }),
          "1",
          "/cognition/self-profile",
          "business",
          "business",
          now,
          now
        ]
      );

      const bundle = await loadProfileBundle(db);
      if (!bundle) throw new Error("保存后读取本人画像失败");
      return bundle;
    });

    return res.json({ success: true, data, message: "本人画像已保存并生成版本快照" });
  } catch (error) {
    return next(error);
  }
});

export default router;
