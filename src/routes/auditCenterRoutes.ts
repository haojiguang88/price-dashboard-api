import express from "express";
import getDb from "../config/database";

const router = express.Router();

const parseSnapshotLimit = (value: unknown) => {
  const parsed = Number.parseInt(String(value || "80"), 10) || 80;
  return Math.min(100, Math.max(20, parsed));
};

router.get("/audit-center/snapshot", async (req, res) => {
  try {
    const db = await getDb();
    const limit = parseSnapshotLimit(req.query.limit);

    const tasks = await db.all(
      `SELECT id, task_key, name, domain, task_type, enabled, schedule_time, last_status, last_message, last_run_at
       FROM task_center_tasks
       WHERE COALESCE(workspace, 'business') = 'business'
       ORDER BY priority ASC, id ASC
       LIMIT ?`,
      [limit]
    );
    const runs = await db.all(
      `SELECT
         r.id,
         r.task_key,
         r.trigger_type,
         r.status,
         r.message,
         r.started_at,
         r.finished_at,
         t.name AS task_name
       FROM task_center_runs r
       LEFT JOIN task_center_tasks t ON t.id = r.task_id
       WHERE COALESCE(r.workspace, 'business') = 'business'
       ORDER BY datetime(r.started_at) DESC, r.id DESC
       LIMIT ?`,
      [limit]
    );
    const rules = await db.all(
      `SELECT id, rule_code, rule_name, rule_type, status, created_at, updated_at
       FROM monitor_rules
       ORDER BY datetime(updated_at) DESC, id DESC
       LIMIT ?`,
      [limit]
    );
    const buyingPlans = await db.all(
      `SELECT
         p.id,
         p.plan_name,
         p.category_name,
         p.object_name,
         COALESCE(p.variant_name, '') AS variant_name,
         p.status,
         p.created_at,
         p.updated_at,
         c.id AS category_id,
         o.id AS object_id,
         CASE WHEN COALESCE(p.variant_name, '') = '' THEN NULL ELSE v.id END AS variant_id
       FROM buying_plans p
       LEFT JOIN categories c ON c.name = p.category_name
       LEFT JOIN objects o ON o.category_id = c.id AND o.name = p.object_name
       LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(p.variant_name, '')
       ORDER BY datetime(p.updated_at) DESC, p.id DESC
       LIMIT ?`,
      [limit]
    );
    const sellingPlans = await db.all(
      `SELECT
         p.id,
         p.plan_name,
         p.category_name,
         p.object_name,
         COALESCE(p.variant_name, '') AS variant_name,
         p.status,
         p.created_at,
         p.updated_at,
         c.id AS category_id,
         o.id AS object_id,
         CASE WHEN COALESCE(p.variant_name, '') = '' THEN NULL ELSE v.id END AS variant_id
       FROM selling_plans p
       LEFT JOIN categories c ON c.name = p.category_name
       LEFT JOIN objects o ON o.category_id = c.id AND o.name = p.object_name
       LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(p.variant_name, '')
       ORDER BY datetime(p.updated_at) DESC, p.id DESC
       LIMIT ?`,
      [limit]
    );
    const priceRecords = await db.all(
      `SELECT
         p.id,
         p.date,
         p.category,
         p.object_name,
         COALESCE(p.variant, '') AS variant,
         CAST(p.price AS REAL) AS price,
         p.source,
         p.created_at,
         p.updated_at,
         c.id AS category_id,
         o.id AS object_id,
         CASE WHEN COALESCE(p.variant, '') = '' THEN NULL ELSE v.id END AS variant_id
       FROM price_records p
       LEFT JOIN categories c ON c.name = p.category
       LEFT JOIN objects o ON o.category_id = c.id AND o.name = p.object_name
       LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(p.variant, '')
       WHERE (c.id IS NULL OR COALESCE(c.is_archived, 0) = 0)
         AND (o.id IS NULL OR COALESCE(o.is_archived, 0) = 0)
         AND (COALESCE(p.variant, '') = '' OR v.id IS NULL OR COALESCE(v.is_archived, 0) = 0)
       ORDER BY datetime(p.updated_at) DESC, p.id DESC
       LIMIT ?`,
      [limit]
    );

    res.json({
      success: true,
      data: {
        generated_at: new Date().toISOString(),
        per_source_limit: limit,
        tasks,
        runs,
        rules,
        buying_plans: buyingPlans,
        selling_plans: sellingPlans,
        price_records: priceRecords
      }
    });
  } catch (error) {
    console.error("Error fetching audit center snapshot:", error);
    res.status(500).json({ success: false, message: "获取轻量审计快照失败" });
  }
});

export default router;
