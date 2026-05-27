const workspaceCenterPhysicalTables = [
  {
    sourceTable: 'manual_todos',
    finalTables: {
      business: 'manual_todos',
      trading: 'manual_todos'
    },
    sameDbPreviewTables: {
      business: 'business_manual_todos_preview',
      trading: 'trading_manual_todos_preview'
    },
    splitColumn: 'workspace',
    splitValue: {
      business: 'business',
      trading: 'trading'
    },
    dependency: 'independent',
    note: 'Manual todos are copied by workspace. Final separate DBs keep the same table name so route/service SQL does not need a runtime rename.'
  },
  {
    sourceTable: 'task_center_tasks',
    finalTables: {
      business: 'task_center_tasks',
      trading: 'task_center_tasks'
    },
    sameDbPreviewTables: {
      business: 'business_task_center_tasks_preview',
      trading: 'trading_task_center_tasks_preview'
    },
    splitColumn: 'workspace',
    splitValue: {
      business: 'business',
      trading: 'trading'
    },
    dependency: 'parent of task_center_runs',
    note: 'Task definitions are copied by workspace. Keep task ids/task_keys stable inside each final DB.'
  },
  {
    sourceTable: 'task_center_runs',
    finalTables: {
      business: 'task_center_runs',
      trading: 'task_center_runs'
    },
    sameDbPreviewTables: {
      business: 'business_task_center_runs_preview',
      trading: 'trading_task_center_runs_preview'
    },
    splitColumn: 'workspace',
    splitValue: {
      business: 'business',
      trading: 'trading'
    },
    dependency: 'child of task_center_tasks',
    note: 'Task runs are copied by workspace after task_center_tasks. Unknown workspace rows must be fixed before physical promotion.'
  },
  {
    sourceTable: 'audit_logs',
    finalTables: {
      business: 'audit_logs',
      trading: 'audit_logs'
    },
    sameDbPreviewTables: {
      business: 'business_audit_logs_preview',
      trading: 'trading_audit_logs_preview'
    },
    splitColumn: 'workspace',
    splitValue: {
      business: 'business',
      trading: 'trading'
    },
    dependency: 'independent',
    note: 'Audit logs are copied by workspace. Keep ids stable for traceability.'
  },
  {
    sourceTable: 'workspace_tags',
    finalTables: {
      business: 'workspace_tags',
      trading: 'workspace_tags'
    },
    sameDbPreviewTables: {
      business: 'business_workspace_tags_preview',
      trading: 'trading_workspace_tags_preview'
    },
    splitColumn: 'workspace',
    splitValue: {
      business: 'business',
      trading: 'trading'
    },
    dependency: 'independent',
    note: 'Workspace tags are copied by workspace. UNIQUE(workspace, name) can remain during transition; after physical split it may later become UNIQUE(name).'
  }
];

module.exports = {
  workspaceCenterPhysicalTables
};
