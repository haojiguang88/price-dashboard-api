export interface OptionalAnnualPlanItemLinkResult {
  ok: boolean;
  value: number | null;
  message?: string;
}

export const annualPlanLinkSelectFields = `
  annual_plan_item_link.id AS annual_plan_link_id,
  annual_plan_item_link.plan_id AS annual_plan_link_plan_id,
  annual_plan_overview_link.year AS annual_plan_link_year,
  annual_plan_overview_link.title AS annual_plan_link_title,
  annual_plan_item_link.scope_type AS annual_plan_link_scope_type,
  annual_plan_item_link.category AS annual_plan_link_category,
  annual_plan_item_link.object_name AS annual_plan_link_object_name,
  annual_plan_item_link.current_role AS annual_plan_link_current_role,
  annual_plan_item_link.current_action AS annual_plan_link_current_action,
  annual_plan_item_link.current_status AS annual_plan_link_current_status
`;

export const annualPlanLinkJoins = (ownerAlias: string) => `
  LEFT JOIN annual_plan_items annual_plan_item_link
    ON ${ownerAlias}.annual_plan_item_id = annual_plan_item_link.id
    AND COALESCE(annual_plan_item_link.is_deleted, 0) = 0
  LEFT JOIN annual_plans annual_plan_overview_link
    ON annual_plan_item_link.plan_id = annual_plan_overview_link.id
    AND COALESCE(annual_plan_overview_link.is_deleted, 0) = 0
`;

const normalizeOptionalAnnualPlanItemId = (value: unknown) => {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') {
    return { ok: true, value: null as number | null };
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, value: null as number | null };
  }

  return { ok: true, value: parsed };
};

export const validateOptionalAnnualPlanItemLink = async (
  db: any,
  value: unknown
): Promise<OptionalAnnualPlanItemLinkResult> => {
  const normalized = normalizeOptionalAnnualPlanItemId(value);
  if (!normalized.ok) {
    return { ok: false, value: null, message: '关联年度子计划不合法' };
  }

  if (!normalized.value) {
    return { ok: true, value: null };
  }

  const annualPlanItem = await db.get(
    'SELECT id FROM annual_plan_items WHERE id = ? AND COALESCE(is_deleted, 0) = 0',
    [normalized.value]
  );
  if (!annualPlanItem) {
    return { ok: false, value: null, message: '关联年度子计划不存在或已删除' };
  }

  return { ok: true, value: normalized.value };
};

export const serializeAnnualPlanLink = (record: any) => {
  if (!record?.annual_plan_link_id) return null;

  const categoryText = [
    record.annual_plan_link_scope_type,
    record.annual_plan_link_category,
    record.annual_plan_link_object_name
  ].filter(Boolean).join(' / ');
  const actionText = [
    record.annual_plan_link_current_role,
    record.annual_plan_link_current_action,
    record.annual_plan_link_current_status
  ].filter(Boolean).join(' · ');
  const planText = [
    record.annual_plan_link_year,
    record.annual_plan_link_title
  ].filter(Boolean).join(' · ');
  const label = [planText, categoryText, actionText].filter(Boolean).join('｜');

  return {
    id: String(record.annual_plan_link_id),
    plan_id: record.annual_plan_link_plan_id ? String(record.annual_plan_link_plan_id) : '',
    plan_year: record.annual_plan_link_year ?? null,
    plan_title: record.annual_plan_link_title || '',
    scope_type: record.annual_plan_link_scope_type || '',
    category: record.annual_plan_link_category || '',
    object_name: record.annual_plan_link_object_name || '',
    current_role: record.annual_plan_link_current_role || '',
    current_action: record.annual_plan_link_current_action || '',
    current_status: record.annual_plan_link_current_status || '',
    label
  };
};
