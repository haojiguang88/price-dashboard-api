import getDb from "../config/database";
import { buildWorkspaceFilter, normalizeWorkspace } from "../utils/workspace";
import { WorkspaceCenterError } from "./workspaceCenterErrors";

export const getScopedTaskFilter = (id: string, workspaceInput: unknown) => {
  const workspace = normalizeWorkspace(workspaceInput);
  if (!workspace) throw new WorkspaceCenterError(400, "缺少有效工作区");
  return {
    whereClause: "id = ? AND workspace = ?",
    params: [id, workspace],
    workspace
  };
};

export const getTaskCenterSnapshot = async (workspaceInput: unknown, compactInput: unknown) => {
  const db = await getDb();
  const compactRuns = ["1", "true", "yes"].includes(String(compactInput || "").toLowerCase());
  const taskFilter = buildWorkspaceFilter(workspaceInput, "t.workspace");
  const tasks = await db.all(
    `SELECT
       t.*,
       COALESCE(
         (SELECT r.status FROM task_center_runs r WHERE r.task_key = t.task_key AND r.workspace = t.workspace ORDER BY datetime(REPLACE(r.started_at, 'T', ' ')) DESC, r.id DESC LIMIT 1),
         t.last_status
       ) AS last_status,
       COALESCE(
         (SELECT r.message FROM task_center_runs r WHERE r.task_key = t.task_key AND r.workspace = t.workspace ORDER BY datetime(REPLACE(r.started_at, 'T', ' ')) DESC, r.id DESC LIMIT 1),
         t.last_message
       ) AS last_message,
       COALESCE(
         (SELECT COALESCE(r.finished_at, r.started_at) FROM task_center_runs r WHERE r.task_key = t.task_key AND r.workspace = t.workspace ORDER BY datetime(REPLACE(r.started_at, 'T', ' ')) DESC, r.id DESC LIMIT 1),
         t.last_run_at
       ) AS last_run_at
     FROM task_center_tasks t
     ${taskFilter.whereClause ? `WHERE ${taskFilter.whereClause}` : ""}
     ORDER BY t.schedule_time ASC, t.priority ASC, t.id ASC`,
    taskFilter.params
  );
  const runFilter = buildWorkspaceFilter(taskFilter.workspace);
  const runs = await db.all(
    compactRuns
      ? `SELECT id, task_id, task_key, domain, workspace, trigger_type, status, message, started_at, finished_at
         FROM task_center_runs
         ${runFilter.whereClause ? `WHERE ${runFilter.whereClause}` : ""}
         ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC
         LIMIT 30`
      : `SELECT * FROM task_center_runs
         ${runFilter.whereClause ? `WHERE ${runFilter.whereClause}` : ""}
         ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC
         LIMIT 30`,
    runFilter.params
  );
  return { tasks, runs };
};

export const getTaskCenterTask = async (id: string, workspaceInput: unknown) => {
  const db = await getDb();
  const scopedTaskFilter = getScopedTaskFilter(id, workspaceInput);
  const task = await db.get(`SELECT * FROM task_center_tasks WHERE ${scopedTaskFilter.whereClause}`, scopedTaskFilter.params);
  if (!task) throw new WorkspaceCenterError(404, "任务不存在");
  return task;
};

export const updateTaskCenterTask = async (
  id: string,
  body: Record<string, any>,
  workspaceInput: unknown
) => {
  const db = await getDb();
  const enabled = body.enabled === undefined ? undefined : (body.enabled ? 1 : 0);
  const scheduleTime = String(body.schedule_time || "").trim();
  const configJson = body.config_json;
  const workspace = body.workspace === undefined ? undefined : normalizeWorkspace(body.workspace);
  const domain = body.domain === undefined ? undefined : String(body.domain || "").trim();

  if (body.workspace !== undefined && !workspace) {
    throw new WorkspaceCenterError(400, "无效的工作区");
  }
  if (body.domain !== undefined && !domain) {
    throw new WorkspaceCenterError(400, "无效的任务域");
  }

  const scopedTaskFilter = getScopedTaskFilter(id, workspaceInput ?? body.workspace);
  const existingTask = await db.get(
    `SELECT id FROM task_center_tasks WHERE ${scopedTaskFilter.whereClause}`,
    scopedTaskFilter.params
  );
  if (!existingTask) throw new WorkspaceCenterError(404, "任务不存在");

  const fields: string[] = [];
  const params: any[] = [];
  if (enabled !== undefined) {
    fields.push("enabled = ?");
    params.push(enabled);
  }
  if (/^\d{2}:\d{2}$/.test(scheduleTime)) {
    fields.push("schedule_time = ?");
    params.push(scheduleTime);
  }
  if (configJson !== undefined) {
    fields.push("config_json = ?");
    params.push(typeof configJson === "string" ? configJson : JSON.stringify(configJson));
  }
  if (workspace) {
    fields.push("workspace = ?");
    params.push(workspace);
  }
  if (domain) {
    fields.push("domain = ?");
    params.push(domain);
  }
  fields.push("updated_at = ?");
  params.push(new Date().toISOString(), ...scopedTaskFilter.params);

  const result = await db.run(
    `UPDATE task_center_tasks SET ${fields.join(", ")} WHERE ${scopedTaskFilter.whereClause}`,
    params
  );
  if (!result.changes) throw new WorkspaceCenterError(404, "任务不存在");
};

export const deleteTaskCenterTask = async (id: string, workspaceInput: unknown) => {
  const db = await getDb();
  const task = await getTaskCenterTask(id, workspaceInput);
  const running = await db.get(
    `SELECT id, started_at
     FROM task_center_runs
     WHERE task_id = ? AND status = 'running' AND workspace = ?
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 1`,
    [task.id, task.workspace]
  );
  if (running) throw new WorkspaceCenterError(409, "任务正在执行中，完成后再删除");

  await db.run("BEGIN");
  let runsDeleted = 0;
  try {
    const runResult = await db.run(
      `DELETE FROM task_center_runs
       WHERE (task_id = ? OR task_key = ?) AND workspace = ?`,
      [task.id, task.task_key, task.workspace]
    );
    runsDeleted = Number(runResult?.changes || 0);

    await db.run("DELETE FROM task_center_tasks WHERE id = ? AND workspace = ?", [task.id, task.workspace]);
    await db.run("COMMIT");
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
  }

  return {
    task,
    runsDeleted
  };
};
