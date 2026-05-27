import getDb from "../config/database";
import { normalizeWorkspace, resolveDomainForWorkspace, type WorkspaceKey } from "../utils/workspace";
import { isUniqueConstraintError, WorkspaceCenterError } from "./workspaceCenterErrors";

const defaultTagsByWorkspace: Record<WorkspaceKey, string[]> = {
  business: ["挂树", "卖飞", "贪心", "偏离计划", "执行到位", "A仓有效", "买点不舒服", "高开", "补货", "火力集中"]
};

export const normalizeTagWorkspace = (value: unknown): WorkspaceKey => {
  const workspace = normalizeWorkspace(value);
  return workspace || "business";
};

const ensureDefaultTags = async (db: any, workspace: WorkspaceKey) => {
  const row = await db.get("SELECT COUNT(1) AS count FROM workspace_tags WHERE workspace = ?", [workspace]);
  if (Number(row?.count || 0) > 0) return;

  const domain = resolveDomainForWorkspace(undefined, workspace);
  const now = new Date().toISOString();
  for (const name of defaultTagsByWorkspace[workspace]) {
    await db.run(
      `INSERT OR IGNORE INTO workspace_tags (name, domain, workspace, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [name, domain, workspace, now, now]
    );
  }
};

export const listWorkspaceTags = async (workspaceInput: unknown) => {
  const db = await getDb();
  const workspace = normalizeTagWorkspace(workspaceInput);
  await ensureDefaultTags(db, workspace);
  return db.all(
    `SELECT id, name, domain, workspace, created_at, updated_at
     FROM workspace_tags
     WHERE workspace = ?
     ORDER BY id ASC`,
    [workspace]
  );
};

export const createWorkspaceTag = async (input: { name?: unknown; domain?: unknown; workspace?: unknown }) => {
  const name = String(input.name || "").trim();
  if (!name) throw new WorkspaceCenterError(400, "缺少标签名");

  const db = await getDb();
  const workspace = normalizeTagWorkspace(input.workspace);
  const domain = resolveDomainForWorkspace(input.domain, workspace);
  const now = new Date().toISOString();
  try {
    const result = await db.run(
      `INSERT INTO workspace_tags (name, domain, workspace, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [name, domain, workspace, now, now]
    );
    return db.get(
      `SELECT id, name, domain, workspace, created_at, updated_at FROM workspace_tags WHERE id = ?`,
      [result.lastID]
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new WorkspaceCenterError(409, "标签已存在");
    throw error;
  }
};

export const updateWorkspaceTag = async (id: string, input: { name?: unknown; workspace?: unknown }) => {
  const name = String(input.name || "").trim();
  if (!name) throw new WorkspaceCenterError(400, "缺少标签名");

  const db = await getDb();
  const workspace = normalizeTagWorkspace(input.workspace);
  try {
    const result = await db.run(
      `UPDATE workspace_tags
       SET name = ?, updated_at = ?
       WHERE id = ? AND workspace = ?`,
      [name, new Date().toISOString(), id, workspace]
    );
    if (!result.changes) throw new WorkspaceCenterError(404, "标签不存在");
    return db.get(
      `SELECT id, name, domain, workspace, created_at, updated_at FROM workspace_tags WHERE id = ? AND workspace = ?`,
      [id, workspace]
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new WorkspaceCenterError(409, "标签已存在");
    throw error;
  }
};

export const deleteWorkspaceTag = async (id: string, workspaceInput: unknown) => {
  const db = await getDb();
  const workspace = normalizeTagWorkspace(workspaceInput);
  const result = await db.run(
    "DELETE FROM workspace_tags WHERE id = ? AND workspace = ?",
    [id, workspace]
  );
  if (!result.changes) throw new WorkspaceCenterError(404, "标签不存在");
  return { id, changes: result.changes };
};
