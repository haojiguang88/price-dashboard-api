import getDb from "../config/database";
import { normalizeWorkspace, resolveDomainForWorkspace, type WorkspaceKey } from "../utils/workspace";
import { isUniqueConstraintError, WorkspaceCenterError } from "./workspaceCenterErrors";

type EntityType = "category" | "object" | "variant";

type DefaultTag = {
  name: string;
  tagGroup: string;
  color: string;
  description?: string;
  applicableScopes: EntityType[];
};

const VALID_ENTITY_TYPES = new Set<EntityType>(["category", "object", "variant"]);

const defaultTagsByWorkspace: Record<WorkspaceKey, DefaultTag[]> = {
  business: [
    { name: "龙头", tagGroup: "角色", color: "emerald", applicableScopes: ["object", "variant"] },
    { name: "次龙头", tagGroup: "角色", color: "emerald", applicableScopes: ["object", "variant"] },
    { name: "低吸候选", tagGroup: "交易", color: "blue", applicableScopes: ["object", "variant"] },
    { name: "A仓候选", tagGroup: "交易", color: "indigo", applicableScopes: ["object", "variant"] },
    { name: "只观察", tagGroup: "交易", color: "gray", applicableScopes: ["category", "object", "variant"] },
    { name: "禁区", tagGroup: "交易", color: "red", applicableScopes: ["category", "object", "variant"] },
    { name: "强市追高风险", tagGroup: "风险", color: "orange", applicableScopes: ["object", "variant"] },
    { name: "供给未明", tagGroup: "风险", color: "amber", applicableScopes: ["category", "object", "variant"] },
    { name: "流动性差", tagGroup: "风险", color: "red", applicableScopes: ["object", "variant"] },
    { name: "价格失真", tagGroup: "风险", color: "amber", applicableScopes: ["variant"] },
    { name: "贵金属锚", tagGroup: "结构", color: "cyan", applicableScopes: ["category", "object"] },
    { name: "情绪周期", tagGroup: "结构", color: "purple", applicableScopes: ["category", "object"] },
    { name: "裸币", tagGroup: "结构", color: "slate", applicableScopes: ["variant"] },
    { name: "评级", tagGroup: "结构", color: "slate", applicableScopes: ["variant"] },
    { name: "靓号", tagGroup: "结构", color: "purple", applicableScopes: ["variant"] },
    { name: "停止采集", tagGroup: "风险", color: "gray", applicableScopes: ["variant"] }
  ]
};

const DEFAULT_APPLICABLE_SCOPES: EntityType[] = ["category", "object", "variant"];

export const normalizeTagWorkspace = (value: unknown): WorkspaceKey => {
  const workspace = normalizeWorkspace(value);
  return workspace || "business";
};

const normalizeTagGroup = (value: unknown) => {
  const group = String(value || "").trim();
  return group || "交易";
};

const normalizeTagColor = (value: unknown) => {
  const color = String(value || "").trim();
  return color || "indigo";
};

const normalizeDescription = (value: unknown) => String(value || "").trim();

const normalizeApplicableScopes = (value: unknown): EntityType[] => {
  const rawList = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim()
      ? (() => {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : value.split(/[、,，\s]+/);
        } catch {
          return value.split(/[、,，\s]+/);
        }
      })()
      : DEFAULT_APPLICABLE_SCOPES;
  const scopes = Array.from(new Set(rawList.map((item) => String(item || "").trim()).filter((item): item is EntityType => VALID_ENTITY_TYPES.has(item as EntityType))));
  return scopes.length > 0 ? scopes : DEFAULT_APPLICABLE_SCOPES;
};

const serializeScopes = (value: unknown) => JSON.stringify(normalizeApplicableScopes(value));

const normalizeEntityType = (value: unknown): EntityType => {
  const entityType = String(value || "").trim() as EntityType;
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    throw new WorkspaceCenterError(400, "实体类型必须是 category / object / variant");
  }
  return entityType;
};

const normalizeIdList = (value: unknown) => {
  const rawList = Array.isArray(value) ? value : [];
  return Array.from(new Set(rawList.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)));
};

const ensureTagSchema = async (db: any) => {
  const columns = await db.all("PRAGMA table_info(workspace_tags)");
  const existingColumns = new Set(columns.map((column: any) => column.name));
  const addColumn = async (column: string, definition: string) => {
    if (!existingColumns.has(column)) {
      await db.exec(`ALTER TABLE workspace_tags ADD COLUMN ${column} ${definition}`);
    }
  };
  await addColumn("tag_group", "TEXT NOT NULL DEFAULT '交易'");
  await addColumn("color", "TEXT NOT NULL DEFAULT 'indigo'");
  await addColumn("description", "TEXT NOT NULL DEFAULT ''");
  await addColumn("applicable_scopes", "TEXT NOT NULL DEFAULT '[\"category\",\"object\",\"variant\"]'");
  await addColumn("status", "TEXT NOT NULL DEFAULT 'active'");
  await db.exec(`
    CREATE TABLE IF NOT EXISTS entity_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL DEFAULT 'business',
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace, entity_type, entity_id, tag_id),
      FOREIGN KEY (tag_id) REFERENCES workspace_tags(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_entity_tags_lookup ON entity_tags(workspace, entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(workspace, tag_id);
  `);
};

const ensureDefaultTags = async (db: any, workspace: WorkspaceKey) => {
  await ensureTagSchema(db);
  const domain = resolveDomainForWorkspace(undefined, workspace);
  const now = new Date().toISOString();
  for (const tag of defaultTagsByWorkspace[workspace] || []) {
    await db.run(
      `INSERT OR IGNORE INTO workspace_tags
        (name, domain, workspace, tag_group, color, description, applicable_scopes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [tag.name, domain, workspace, tag.tagGroup, tag.color, tag.description || "", serializeScopes(tag.applicableScopes), now, now]
    );
  }
};

export const listWorkspaceTags = async (workspaceInput: unknown) => {
  const db = await getDb();
  const workspace = normalizeTagWorkspace(workspaceInput);
  await ensureTagSchema(db);
  await ensureDefaultTags(db, workspace);
  return db.all(
    `SELECT id, name, domain, workspace, tag_group, color, description, applicable_scopes, status, created_at, updated_at
     FROM workspace_tags
     WHERE workspace = ?
     ORDER BY tag_group ASC, id ASC`,
    [workspace]
  );
};

export const createWorkspaceTag = async (input: { name?: unknown; domain?: unknown; workspace?: unknown; tag_group?: unknown; color?: unknown; description?: unknown; applicable_scopes?: unknown }) => {
  const name = String(input.name || "").trim();
  if (!name) throw new WorkspaceCenterError(400, "缺少标签名");

  const db = await getDb();
  await ensureTagSchema(db);
  const workspace = normalizeTagWorkspace(input.workspace);
  const domain = resolveDomainForWorkspace(input.domain, workspace);
  const now = new Date().toISOString();
  try {
    const result = await db.run(
      `INSERT INTO workspace_tags
        (name, domain, workspace, tag_group, color, description, applicable_scopes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [name, domain, workspace, normalizeTagGroup(input.tag_group), normalizeTagColor(input.color), normalizeDescription(input.description), serializeScopes(input.applicable_scopes), now, now]
    );
    return db.get(
      `SELECT id, name, domain, workspace, tag_group, color, description, applicable_scopes, status, created_at, updated_at FROM workspace_tags WHERE id = ? AND workspace = ?`,
      [result.lastID, workspace]
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new WorkspaceCenterError(409, "标签已存在");
    throw error;
  }
};

export const updateWorkspaceTag = async (id: string, input: { name?: unknown; workspace?: unknown; tag_group?: unknown; color?: unknown; description?: unknown; applicable_scopes?: unknown; status?: unknown }) => {
  const name = String(input.name || "").trim();
  if (!name) throw new WorkspaceCenterError(400, "缺少标签名");

  const db = await getDb();
  await ensureTagSchema(db);
  const workspace = normalizeTagWorkspace(input.workspace);
  try {
    const result = await db.run(
      `UPDATE workspace_tags
       SET name = ?, tag_group = ?, color = ?, description = ?, applicable_scopes = ?, status = ?, updated_at = ?
       WHERE id = ? AND workspace = ?`,
      [name, normalizeTagGroup(input.tag_group), normalizeTagColor(input.color), normalizeDescription(input.description), serializeScopes(input.applicable_scopes), String(input.status || "active"), new Date().toISOString(), id, workspace]
    );
    if (!result.changes) throw new WorkspaceCenterError(404, "标签不存在");
    return db.get(
      `SELECT id, name, domain, workspace, tag_group, color, description, applicable_scopes, status, created_at, updated_at FROM workspace_tags WHERE id = ? AND workspace = ?`,
      [id, workspace]
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new WorkspaceCenterError(409, "标签已存在");
    throw error;
  }
};

export const deleteWorkspaceTag = async (id: string, workspaceInput: unknown) => {
  const db = await getDb();
  await ensureTagSchema(db);
  const workspace = normalizeTagWorkspace(workspaceInput);
  await db.run("DELETE FROM entity_tags WHERE tag_id = ? AND workspace = ?", [id, workspace]);
  const result = await db.run(
    "DELETE FROM workspace_tags WHERE id = ? AND workspace = ?",
    [id, workspace]
  );
  if (!result.changes) throw new WorkspaceCenterError(404, "标签不存在");
  return { id, changes: result.changes };
};

export const listEntityTags = async (input: { workspace?: unknown; entity_type?: unknown; entity_id?: unknown }) => {
  const db = await getDb();
  await ensureTagSchema(db);
  const workspace = normalizeTagWorkspace(input.workspace);
  const params: any[] = [workspace];
  const where = ["et.workspace = ?"];
  if (input.entity_type) {
    where.push("et.entity_type = ?");
    params.push(normalizeEntityType(input.entity_type));
  }
  if (input.entity_id) {
    where.push("et.entity_id = ?");
    params.push(Number(input.entity_id));
  }
  return db.all(
    `SELECT et.id, et.workspace, et.entity_type, et.entity_id, et.tag_id, et.note,
            wt.name, wt.tag_group, wt.color, wt.description, wt.applicable_scopes, wt.status,
            et.created_at, et.updated_at
     FROM entity_tags et
     JOIN workspace_tags wt ON wt.id = et.tag_id
     WHERE ${where.join(" AND ")}
     ORDER BY wt.tag_group ASC, wt.id ASC`,
    params
  );
};

export const setEntityTags = async (
  entityTypeInput: unknown,
  entityIdInput: unknown,
  input: { workspace?: unknown; tag_ids?: unknown }
) => {
  const db = await getDb();
  await ensureTagSchema(db);
  const workspace = normalizeTagWorkspace(input.workspace);
  const entityType = normalizeEntityType(entityTypeInput);
  const entityId = Number(entityIdInput);
  if (!Number.isInteger(entityId) || entityId <= 0) throw new WorkspaceCenterError(400, "实体 ID 无效");
  const tagIds = normalizeIdList(input.tag_ids);
  if (tagIds.length > 0) {
    const placeholders = tagIds.map(() => "?").join(",");
    const rows = await db.all(
      `SELECT id FROM workspace_tags
       WHERE workspace = ? AND status = 'active' AND id IN (${placeholders})`,
      [workspace, ...tagIds]
    );
    if (rows.length !== tagIds.length) throw new WorkspaceCenterError(400, "存在无效或停用标签");
  }

  const now = new Date().toISOString();
  await db.run("BEGIN");
  try {
    await db.run(
      "DELETE FROM entity_tags WHERE workspace = ? AND entity_type = ? AND entity_id = ?",
      [workspace, entityType, entityId]
    );
    for (const tagId of tagIds) {
      await db.run(
        `INSERT INTO entity_tags (workspace, entity_type, entity_id, tag_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [workspace, entityType, entityId, tagId, now, now]
      );
    }
    await db.run("COMMIT");
  } catch (error) {
    await db.run("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return {
    entity_type: entityType,
    entity_id: entityId,
    tag_ids: tagIds,
    tags: await listEntityTags({ workspace, entity_type: entityType, entity_id: entityId })
  };
};
