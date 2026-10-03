/**
 * 买入/卖出计划归档。
 *
 * 归档是「默认不可见」，不是删除：数据继续保留，历史与审计仍可查。
 * 业务规则：只有已完成的计划才允许归档，避免把还在执行的计划藏起来。
 */

export const PLAN_ARCHIVE_TABLES = ['buying_plans', 'selling_plans'] as const;

export type PlanArchiveTable = (typeof PLAN_ARCHIVE_TABLES)[number];

/** 列表/统计默认排除已归档计划。 */
export const planArchivedFilter = (tableAlias: string) => `COALESCE(${tableAlias}.is_archived, 0) = 0`;

/** 已视为「完成」的状态值，兼容历史数据里的 done / 已完成。 */
const PLAN_COMPLETED_STATUSES = ['completed', 'done', '已完成'];

export const isPlanArchivableStatus = (status: unknown): boolean => {
  const value = String(status ?? '').trim();
  if (!value) return false;
  return PLAN_COMPLETED_STATUSES.includes(value) || PLAN_COMPLETED_STATUSES.includes(value.toLowerCase());
};

export const parseIncludeArchivedPlans = (value: unknown): boolean => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

export interface SetPlanArchivedInput {
  tableName: PlanArchiveTable;
  /** 面向用户的中文名，例如「买入计划」。 */
  label: string;
  id: string | number;
  archived: boolean;
}

export type SetPlanArchivedResult =
  | { ok: true; changes: number; archived: boolean; message: string }
  | { ok: false; status: number; message: string };

export const setPlanArchived = async (db: any, input: SetPlanArchivedInput): Promise<SetPlanArchivedResult> => {
  const { tableName, label, id, archived } = input;

  const plan = await db.get(
    `SELECT id, plan_name, status, COALESCE(is_archived, 0) AS is_archived
     FROM ${tableName}
     WHERE id = ?`,
    [id]
  );
  if (!plan) {
    return { ok: false, status: 404, message: `${label}不存在` };
  }

  const alreadyArchived = Number(plan.is_archived) === 1;

  if (archived) {
    if (!isPlanArchivableStatus(plan.status)) {
      return { ok: false, status: 400, message: `只有已完成的${label}才能归档` };
    }
    if (alreadyArchived) {
      return { ok: true, changes: 0, archived: true, message: `${label}已归档` };
    }
  } else if (!alreadyArchived) {
    return { ok: true, changes: 0, archived: false, message: `${label}未归档` };
  }

  const now = new Date().toISOString();
  const result = await db.run(
    `UPDATE ${tableName} SET is_archived = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
    [archived ? 1 : 0, archived ? now : null, now, id]
  );

  return {
    ok: true,
    changes: result.changes,
    archived,
    message: archived ? `${label}已归档` : `${label}已恢复`
  };
};
