import express from 'express';
import getDb from '../config/database';

const router = express.Router();

const validActions = new Set(['create', 'update', 'delete', 'execute', 'status']);
const validStatuses = new Set(['success', 'failed']);

interface AuditLogInput {
  id?: string;
  timestamp?: string;
  module?: string;
  action?: string;
  target?: string;
  status?: string;
  detail?: string;
  entity_id?: string | number;
  entityId?: string | number;
  path?: string;
}

const makeAuditId = () => `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const normalizeAuditLog = (body: AuditLogInput) => ({
  id: String(body.id || makeAuditId()).trim(),
  timestamp: String(body.timestamp || new Date().toISOString()).trim(),
  module: String(body.module || '').trim(),
  action: String(body.action || '').trim(),
  target: String(body.target || '').trim(),
  status: String(body.status || '').trim(),
  detail: body.detail === undefined ? null : String(body.detail),
  entityId: body.entity_id === undefined && body.entityId === undefined ? null : String(body.entity_id ?? body.entityId),
  path: body.path === undefined ? null : String(body.path)
});

const validateAuditLog = (entry: ReturnType<typeof normalizeAuditLog>) => {
  if (!entry.id) return '缺少必填字段: id';
  if (!entry.timestamp) return '缺少必填字段: timestamp';
  if (!entry.module) return '缺少必填字段: module';
  if (!entry.action) return '缺少必填字段: action';
  if (!validActions.has(entry.action)) return '无效的 action';
  if (!entry.target) return '缺少必填字段: target';
  if (!entry.status) return '缺少必填字段: status';
  if (!validStatuses.has(entry.status)) return '无效的 status';
  return '';
};

const upsertAuditLog = async (db: any, entry: ReturnType<typeof normalizeAuditLog>) => {
  const now = new Date().toISOString();
  await db.run(
    `
      INSERT INTO audit_logs
        (id, timestamp, module, action, target, status, detail, entity_id, path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id)
      DO UPDATE SET
        timestamp = excluded.timestamp,
        module = excluded.module,
        action = excluded.action,
        target = excluded.target,
        status = excluded.status,
        detail = excluded.detail,
        entity_id = excluded.entity_id,
        path = excluded.path,
        updated_at = excluded.updated_at
    `,
    [
      entry.id,
      entry.timestamp,
      entry.module,
      entry.action,
      entry.target,
      entry.status,
      entry.detail,
      entry.entityId,
      entry.path,
      now,
      now
    ]
  );

  return db.get(
    `
      SELECT id, timestamp, module, action, target, status, detail, entity_id, path, created_at, updated_at
      FROM audit_logs
      WHERE id = ?
    `,
    [entry.id]
  );
};

router.get('/audit-logs', async (req, res) => {
  try {
    const db = await getDb();
    const { module, action, status } = req.query;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '500'), 10) || 500, 1), 1000);
    const where: string[] = [];
    const params: string[] = [];

    if (module) {
      where.push('module = ?');
      params.push(String(module));
    }
    if (action) {
      where.push('action = ?');
      params.push(String(action));
    }
    if (status) {
      where.push('status = ?');
      params.push(String(status));
    }

    const rows = await db.all(
      `
        SELECT id, timestamp, module, action, target, status, detail, entity_id, path, created_at, updated_at
        FROM audit_logs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY datetime(timestamp) DESC, datetime(created_at) DESC
        LIMIT ?
      `,
      [...params, limit]
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ success: false, message: '获取审计日志失败' });
  }
});

router.post('/audit-logs', async (req, res) => {
  try {
    const db = await getDb();
    const entry = normalizeAuditLog(req.body || {});
    const error = validateAuditLog(entry);
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const row = await upsertAuditLog(db, entry);
    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Error creating audit log:', error);
    res.status(500).json({ success: false, message: '写入审计日志失败' });
  }
});

router.post('/audit-logs/bulk', async (req, res) => {
  const entries = Array.isArray(req.body?.logs) ? req.body.logs : [];
  if (entries.length === 0) {
    return res.status(400).json({ success: false, message: '缺少批量审计日志数据' });
  }

  try {
    const db = await getDb();
    const normalized = entries.map((item: AuditLogInput) => normalizeAuditLog(item));
    const invalid = normalized.map(validateAuditLog).find(Boolean);
    if (invalid) {
      return res.status(400).json({ success: false, message: invalid });
    }

    await db.exec('BEGIN');
    try {
      const rows = [];
      for (const entry of normalized) {
        rows.push(await upsertAuditLog(db, entry));
      }
      await db.exec('COMMIT');
      res.json({ success: true, data: rows });
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error bulk creating audit logs:', error);
    res.status(500).json({ success: false, message: '批量写入审计日志失败' });
  }
});

export default router;
