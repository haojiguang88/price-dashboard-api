import getDb from "../config/database";
import { buildWorkspaceFilter, inferManualWorkspace, normalizeWorkspace, resolveDomainForWorkspace } from "../utils/workspace";
import { WorkspaceCenterError } from "./workspaceCenterErrors";
import { normalizeSourceContext, serializeSourceContext } from "../utils/sourceContext";

const validPriorities = ["high", "medium", "low"];
const validStatuses = ["pending", "in_progress", "completed", "cancelled"];

type ManualTodoInput = {
  title?: unknown;
  priority?: unknown;
  status?: unknown;
  due_date?: unknown;
  note?: unknown;
  domain?: unknown;
  workspace?: unknown;
  source_type?: unknown;
  source_id?: unknown;
  source_context?: unknown;
  completion_result?: unknown;
};

const getScopedIdFilter = (id: string, workspaceInput: unknown) => {
  const workspace = normalizeWorkspace(workspaceInput);
  if (!workspace) throw new WorkspaceCenterError(400, "缺少有效工作区");
  return {
    whereClause: "id = ? AND workspace = ?",
    params: [id, workspace],
    workspace
  };
};

const validateManualTodoInput = (input: ManualTodoInput) => {
  const title = String(input.title || "").trim();
  const priority = String(input.priority || "").trim();
  const status = String(input.status || "").trim();

  if (!title || !priority || !status) {
    throw new WorkspaceCenterError(400, "缺少必填字段");
  }
  if (!validPriorities.includes(priority)) {
    throw new WorkspaceCenterError(400, "无效的优先级值");
  }
  if (!validStatuses.includes(status)) {
    throw new WorkspaceCenterError(400, "无效的状态值");
  }

  return {
    title,
    priority,
    status,
    dueDate: input.due_date === undefined ? null : input.due_date,
    note: input.note === undefined ? null : input.note,
    completionResult: input.completion_result === undefined ? null : input.completion_result
  };
};

export const getTodoCenterData = async (workspaceInput: unknown) => {
  const db = await getDb();
  const workspace = normalizeWorkspace(workspaceInput);
  const includeBusinessModules = !workspace || workspace === "business";

  const buyingPlanTodos = includeBusinessModules ? await db.all(`
    SELECT
      bp.id as source_id,
      bp.plan_name as title,
      'buying_plan' as source_module,
      bp.category_name || ' / ' || bp.object_name || (CASE WHEN bp.variant_name IS NOT NULL THEN ' / ' || bp.variant_name ELSE '' END) as related_label,
      'business' as domain,
      'business' as workspace,
      'medium' as priority,
      bp.status,
      NULL as due_date,
      bp.note,
      NULL as completion_result,
      bp.updated_at
    FROM buying_plans bp
    WHERE bp.status IN ('pending', 'in_progress')
  `) : [];

  const sellingPlanTodos = includeBusinessModules ? await db.all(`
    SELECT
      sp.id as source_id,
      sp.plan_name as title,
      'selling_plan' as source_module,
      sp.category_name || ' / ' || sp.object_name || (CASE WHEN sp.variant_name IS NOT NULL THEN ' / ' || sp.variant_name ELSE '' END) as related_label,
      'business' as domain,
      'business' as workspace,
      'medium' as priority,
      sp.status,
      NULL as due_date,
      sp.note,
      NULL as completion_result,
      sp.updated_at
    FROM selling_plans sp
    WHERE sp.status IN ('pending', 'in_progress')
  `) : [];

  const watchlistTodos = includeBusinessModules ? await db.all(`
    SELECT
      w.id as source_id,
      w.reason as title,
      'watchlist' as source_module,
      (SELECT c.name FROM categories c WHERE c.id = w.category_id) || ' / ' ||
      (SELECT o.name FROM objects o WHERE o.id = w.object_id) ||
      (CASE WHEN w.variant_id > 0 THEN ' / ' || (SELECT v.name FROM variants v WHERE v.id = w.variant_id) ELSE '' END) as related_label,
      'business' as domain,
      'business' as workspace,
      w.priority,
      w.status,
      NULL as due_date,
      w.note,
      NULL as completion_result,
      w.updated_at
    FROM watchlist_items w
    WHERE w.status IN ('watching', 'waiting_price', 'waiting_signal')
  `) : [];

  const manualFilter = buildWorkspaceFilter(workspace, "mt.workspace");
  const manualTodoRows = await db.all(`
    SELECT
      mt.id,
      mt.title,
      'manual_todo' as source_module,
      '' as related_label,
      mt.domain,
      mt.workspace,
      mt.priority,
      mt.status,
      mt.due_date,
      mt.note,
      mt.source_type,
      mt.source_id,
      mt.source_context_json,
      mt.completion_result,
      mt.updated_at
    FROM manual_todos mt
    WHERE ${manualFilter.whereClause ? `${manualFilter.whereClause} AND` : ""} mt.status IN ('pending', 'in_progress')
  `, manualFilter.params);
  const manualTodos = manualTodoRows.map(serializeSourceContext);

  const summary = [...buyingPlanTodos, ...sellingPlanTodos, ...watchlistTodos, ...manualTodos];
  summary.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const priorityDiff = priorityOrder[(a.priority as keyof typeof priorityOrder)] - priorityOrder[(b.priority as keyof typeof priorityOrder)];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  return {
    summary,
    buying_plan_todos: buyingPlanTodos,
    selling_plan_todos: sellingPlanTodos,
    watchlist_todos: watchlistTodos,
    manual_todos: manualTodos
  };
};

export const listManualTodos = async (workspaceInput: unknown) => {
  const db = await getDb();
  const filter = buildWorkspaceFilter(workspaceInput);
  const rows = await db.all(
    `SELECT * FROM manual_todos ${filter.whereClause ? `WHERE ${filter.whereClause}` : ""} ORDER BY updated_at DESC`,
    filter.params
  );
  return rows.map(serializeSourceContext);
};

export const getManualTodo = async (id: string, workspaceInput: unknown) => {
  const db = await getDb();
  const filter = getScopedIdFilter(id, workspaceInput);
  const todo = await db.get(`SELECT * FROM manual_todos WHERE ${filter.whereClause}`, filter.params);
  if (!todo) throw new WorkspaceCenterError(404, "手动待办不存在");
  return serializeSourceContext(todo);
};

export const createManualTodo = async (input: ManualTodoInput) => {
  const payload = validateManualTodoInput(input);
  const db = await getDb();
  const now = new Date().toISOString();
  const workspace = inferManualWorkspace({ workspace: input.workspace, domain: input.domain });
  const domain = resolveDomainForWorkspace(input.domain, workspace);
  const source = normalizeSourceContext(input as Record<string, unknown>);
  const result = await db.run(
    "INSERT INTO manual_todos (title, priority, status, due_date, note, completion_result, domain, workspace, source_type, source_id, source_context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [payload.title, payload.priority, payload.status, payload.dueDate, payload.note, payload.completionResult, domain, workspace, source.sourceType, source.sourceId, source.sourceContextJson, now, now]
  );
  return { id: result.lastID };
};

export const updateManualTodo = async (id: string, input: ManualTodoInput, scopeWorkspaceInput: unknown) => {
  const db = await getDb();
  const requestWorkspace = normalizeWorkspace(scopeWorkspaceInput ?? input.workspace);
  const existingFilter = getScopedIdFilter(id, requestWorkspace);
  const existingTodo = await db.get(
    `SELECT id, title, priority, status, due_date, note, completion_result, domain, workspace, source_type, source_id, source_context_json FROM manual_todos WHERE ${existingFilter.whereClause}`,
    existingFilter.params
  );
  if (!existingTodo) throw new WorkspaceCenterError(404, "手动待办不存在");

  const payload = validateManualTodoInput({
    title: input.title === undefined ? existingTodo.title : input.title,
    priority: input.priority === undefined ? existingTodo.priority : input.priority,
    status: input.status === undefined ? existingTodo.status : input.status,
    due_date: input.due_date === undefined ? existingTodo.due_date : input.due_date,
    note: input.note === undefined ? existingTodo.note : input.note,
    completion_result: input.completion_result === undefined ? existingTodo.completion_result : input.completion_result
  });

  const workspace = input.workspace === undefined
    ? (normalizeWorkspace(existingTodo.workspace) || "business")
    : inferManualWorkspace({ workspace: input.workspace, domain: input.domain ?? existingTodo.domain });
  const domain = input.domain === undefined
    ? (existingTodo.domain || resolveDomainForWorkspace(undefined, workspace))
    : resolveDomainForWorkspace(input.domain, workspace);
  const source = normalizeSourceContext({
    source_type: input.source_type === undefined ? existingTodo.source_type : input.source_type,
    source_id: input.source_id === undefined ? existingTodo.source_id : input.source_id,
    source_context: input.source_context === undefined
      ? (() => {
        try {
          return existingTodo.source_context_json ? JSON.parse(existingTodo.source_context_json) : null;
        } catch {
          return null;
        }
      })()
      : input.source_context
  });
  const updateFilter = getScopedIdFilter(id, requestWorkspace);
  const result = await db.run(
    `UPDATE manual_todos SET title = ?, priority = ?, status = ?, due_date = ?, note = ?, completion_result = ?, domain = ?, workspace = ?, source_type = ?, source_id = ?, source_context_json = ?, updated_at = ? WHERE ${updateFilter.whereClause}`,
    [payload.title, payload.priority, payload.status, payload.dueDate, payload.note, payload.completionResult, domain, workspace, source.sourceType, source.sourceId, source.sourceContextJson, new Date().toISOString(), ...updateFilter.params]
  );

  return { id, changes: result.changes };
};

export const deleteManualTodo = async (id: string, workspaceInput: unknown) => {
  const db = await getDb();
  const filter = getScopedIdFilter(id, workspaceInput);
  const existingTodo = await db.get(`SELECT id FROM manual_todos WHERE ${filter.whereClause}`, filter.params);
  if (!existingTodo) throw new WorkspaceCenterError(404, "手动待办不存在");
  const result = await db.run(`DELETE FROM manual_todos WHERE ${filter.whereClause}`, filter.params);
  return { id, changes: result.changes };
};
