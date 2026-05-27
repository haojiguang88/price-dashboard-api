import getDb from "../config/database";
import { appendWorkspaceCondition, inferAuditWorkspace, resolveDomainForWorkspace } from "../utils/workspace";
import { WorkspaceCenterError } from "./workspaceCenterErrors";

const validActions = new Set(["create", "update", "delete", "execute", "status"]);
const validStatuses = new Set(["success", "failed"]);

export interface AuditLogInput {
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
  domain?: string;
  workspace?: string;
}

interface ListAuditLogOptions {
  module?: unknown;
  action?: unknown;
  status?: unknown;
  limit?: unknown;
  workspace?: unknown;
}

const makeAuditId = () => `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const normalizeAuditLog = (body: AuditLogInput) => {
  const workspace = inferAuditWorkspace(body);
  return {
    id: String(body.id || makeAuditId()).trim(),
    timestamp: String(body.timestamp || new Date().toISOString()).trim(),
    module: String(body.module || "").trim(),
    action: String(body.action || "").trim(),
    target: String(body.target || "").trim(),
    status: String(body.status || "").trim(),
    detail: body.detail === undefined ? null : String(body.detail),
    entityId: body.entity_id === undefined && body.entityId === undefined ? null : String(body.entity_id ?? body.entityId),
    path: body.path === undefined ? null : String(body.path),
    domain: resolveDomainForWorkspace(body.domain, workspace),
    workspace
  };
};

const validateAuditLog = (entry: ReturnType<typeof normalizeAuditLog>) => {
  if (!entry.id) return "缺少必填字段: id";
  if (!entry.timestamp) return "缺少必填字段: timestamp";
  if (!entry.module) return "缺少必填字段: module";
  if (!entry.action) return "缺少必填字段: action";
  if (!validActions.has(entry.action)) return "无效的 action";
  if (!entry.target) return "缺少必填字段: target";
  if (!entry.status) return "缺少必填字段: status";
  if (!validStatuses.has(entry.status)) return "无效的 status";
  return "";
};

const upsertAuditLog = async (db: any, entry: ReturnType<typeof normalizeAuditLog>) => {
  const now = new Date().toISOString();
  await db.run(
    `
      INSERT INTO audit_logs
        (id, timestamp, module, action, target, status, detail, entity_id, path, domain, workspace, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        domain = excluded.domain,
        workspace = excluded.workspace,
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
      entry.domain,
      entry.workspace,
      now,
      now
    ]
  );

  return db.get(
    `
      SELECT id, timestamp, module, action, target, status, detail, entity_id, path, domain, workspace, created_at, updated_at
      FROM audit_logs
      WHERE id = ?
    `,
    [entry.id]
  );
};

export const listAuditLogs = async (options: ListAuditLogOptions) => {
  const db = await getDb();
  const limit = Math.min(Math.max(parseInt(String(options.limit || "500"), 10) || 500, 1), 1000);
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.module) {
    where.push("module = ?");
    params.push(String(options.module));
  }
  if (options.action) {
    where.push("action = ?");
    params.push(String(options.action));
  }
  if (options.status) {
    where.push("status = ?");
    params.push(String(options.status));
  }
  appendWorkspaceCondition(where, params, options.workspace);

  return db.all(
    `
      SELECT id, timestamp, module, action, target, status, detail, entity_id, path, domain, workspace, created_at, updated_at
      FROM audit_logs
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY datetime(timestamp) DESC, datetime(created_at) DESC
      LIMIT ?
    `,
    [...params, limit]
  );
};

export const createAuditLog = async (input: AuditLogInput) => {
  const db = await getDb();
  const entry = normalizeAuditLog(input || {});
  const error = validateAuditLog(entry);
  if (error) throw new WorkspaceCenterError(400, error);
  return upsertAuditLog(db, entry);
};

export const createAuditLogs = async (entries: AuditLogInput[]) => {
  if (entries.length === 0) {
    throw new WorkspaceCenterError(400, "缺少批量审计日志数据");
  }

  const db = await getDb();
  const normalized = entries.map((item: AuditLogInput) => normalizeAuditLog(item));
  const invalid = normalized.map(validateAuditLog).find(Boolean);
  if (invalid) throw new WorkspaceCenterError(400, invalid);

  await db.exec("BEGIN");
  try {
    const rows = [];
    for (const entry of normalized) {
      rows.push(await upsertAuditLog(db, entry));
    }
    await db.exec("COMMIT");
    return rows;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
};
