export const WORKSPACES = ['business'] as const;

export type WorkspaceKey = typeof WORKSPACES[number];

export type WorkspaceInput = {
  workspace?: unknown;
  domain?: unknown;
};

export type TaskWorkspaceInput = WorkspaceInput & {
  task_key?: unknown;
  task_type?: unknown;
};

export type AuditWorkspaceInput = WorkspaceInput & {
  path?: unknown;
  module?: unknown;
  target?: unknown;
  detail?: unknown;
};

export function normalizeWorkspace(value: unknown): WorkspaceKey | null {
  const raw = String(value || '').trim().toLowerCase();
  return WORKSPACES.includes(raw as WorkspaceKey) ? raw as WorkspaceKey : null;
}

export function buildWorkspaceFilter(
  value: unknown,
  column = 'workspace'
): { workspace: WorkspaceKey | null; whereClause: string; params: WorkspaceKey[] } {
  const workspace = normalizeWorkspace(value);
  return {
    workspace,
    whereClause: workspace ? `${column} = ?` : '',
    params: workspace ? [workspace] : []
  };
}

export function appendWorkspaceCondition(
  where: string[],
  params: unknown[],
  value: unknown,
  column = 'workspace'
): WorkspaceKey | null {
  const workspace = normalizeWorkspace(value);
  if (workspace) {
    where.push(`${column} = ?`);
    params.push(workspace);
  }
  return workspace;
}

export function resolveDomainForWorkspace(
  domainInput: unknown,
  workspace: WorkspaceKey,
  _tradingDomain = 'finance'
) {
  const domain = String(domainInput || '').trim().toLowerCase();
  if (domain && domain !== 'trading') return domain;
  return workspace;
}

export function inferManualWorkspace(input: WorkspaceInput): WorkspaceKey {
  const explicit = normalizeWorkspace(input.workspace);
  if (explicit) return explicit;

  const domain = String(input.domain || '').trim().toLowerCase();
  if (['business', 'price', 'commodity'].includes(domain)) return 'business';
  return 'business';
}

export function inferTaskWorkspace(task: TaskWorkspaceInput): WorkspaceKey {
  const explicit = normalizeWorkspace(task.workspace);
  if (explicit) return explicit;

  const domain = String(task.domain || '').trim().toLowerCase();
  const taskKey = String(task.task_key || '').trim().toLowerCase();
  const taskType = String(task.task_type || '').trim().toLowerCase();
  if (
    ['business', 'price', 'commodity'].includes(domain)
    || ['iphone_price_update', 'video_game_machine_price_update', 'popmart_price_update', 'commodity_metals_price_update'].includes(taskKey)
    || taskType.startsWith('commodity_')
  ) {
    return 'business';
  }
  return 'business';
}

export function inferWorkspaceFromPath(pathInput: unknown): WorkspaceKey | null {
  const path = String(pathInput || '').trim().toLowerCase();
  if (
    path.startsWith('/business')
    || path.startsWith('/dashboard')
    || path.startsWith('/price')
    || path.startsWith('/plan')
    || path.startsWith('/position')
    || path.startsWith('/risk-control')
    || path.startsWith('/review')
    || path.startsWith('/rules')
  ) {
    return 'business';
  }
  return null;
}

export function inferAuditWorkspace(input: AuditWorkspaceInput): WorkspaceKey {
  const explicit = normalizeWorkspace(input.workspace);
  if (explicit) return explicit;

  const pathWorkspace = inferWorkspaceFromPath(input.path);
  if (pathWorkspace) return pathWorkspace;

  const text = `${input.module || ''} ${input.target || ''} ${input.detail || ''}`;
  if (text.includes('商品') || text.includes('价格')) {
    return 'business';
  }
  return 'business';
}
