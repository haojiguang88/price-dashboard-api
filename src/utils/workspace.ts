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

const BUSINESS_DOMAINS = new Set(['business', 'price', 'commodity']);

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
  workspace: WorkspaceKey
) {
  const domain = String(domainInput || '').trim().toLowerCase();
  if (BUSINESS_DOMAINS.has(domain)) return domain;
  return workspace;
}

export function inferManualWorkspace(input: WorkspaceInput): WorkspaceKey {
  const explicit = normalizeWorkspace(input.workspace);
  if (explicit) return explicit;
  return 'business';
}

export function inferTaskWorkspace(task: TaskWorkspaceInput): WorkspaceKey {
  const explicit = normalizeWorkspace(task.workspace);
  if (explicit) return explicit;
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
  return 'business';
}
