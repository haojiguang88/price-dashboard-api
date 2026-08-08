import getDb from "../config/database";
import { buildWorkspaceFilter, normalizeWorkspace } from "../utils/workspace";
import { WorkspaceCenterError } from "./workspaceCenterErrors";

const COMPACT_RESULT_ARRAY_PREVIEW_LIMIT = 5;
const COMPACT_RESULT_ARRAY_KEYS = new Set([
  "records",
  "raw_records",
  "source_records",
  "price_records",
  "matched_records",
  "created_records",
  "updated_records",
  "skipped_records",
  "items"
]);

const shouldCompactResultArray = (key: string, value: unknown[]) => (
  COMPACT_RESULT_ARRAY_KEYS.has(key) || value.length > 50
);

const compactRunResultValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => compactRunResultValue(item));
  }
  if (value && typeof value === "object") {
    const compacted: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
      if (Array.isArray(item) && shouldCompactResultArray(key, item)) {
        compacted[key] = item
          .slice(0, COMPACT_RESULT_ARRAY_PREVIEW_LIMIT)
          .map((entry) => compactRunResultValue(entry));
        compacted[`${key}_total_count`] = item.length;
        compacted[`${key}_truncated`] = item.length > COMPACT_RESULT_ARRAY_PREVIEW_LIMIT;
        return;
      }
      compacted[key] = compactRunResultValue(item);
    });
    return compacted;
  }
  return value;
};

const compactTaskRunResultJson = (resultJson?: string | null) => {
  if (!resultJson) return resultJson;
  try {
    const parsed = JSON.parse(resultJson);
    return JSON.stringify(compactRunResultValue(parsed));
  } catch {
    return resultJson.length > 1200
      ? JSON.stringify({
        raw_result_preview: resultJson.slice(0, 1200),
        raw_result_total_length: resultJson.length,
        raw_result_truncated: true
      })
      : resultJson;
  }
};

const compactTaskRunRows = (runs: any[]) => runs.map((run) => {
  const originalResultJson = typeof run.result_json === "string" ? run.result_json : null;
  return {
    ...run,
    message: run.status === "error" ? run.message : null,
    result_json: compactTaskRunResultJson(originalResultJson),
    result_json_size: originalResultJson?.length || 0
  };
});

export const getScopedTaskFilter = (id: string, workspaceInput: unknown) => {
  const workspace = normalizeWorkspace(workspaceInput);
  if (!workspace) throw new WorkspaceCenterError(400, "缺少有效工作区");
  return {
    whereClause: "id = ? AND workspace = ?",
    params: [id, workspace],
    workspace
  };
};

const isValidScheduleTime = (value: string) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
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
      ? `SELECT id, task_id, task_key, domain, workspace, trigger_type, status, message, result_json, started_at, finished_at
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
  const snapshotTasks = compactRuns
    ? tasks.map((task: any) => ({
      ...task,
      last_message: task.last_status === "error" ? task.last_message : null
    }))
    : tasks;
  return { tasks: snapshotTasks, runs: compactRuns ? compactTaskRunRows(runs) : runs };
};

const parseJson = (value?: string | null) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const getChinaDateKey = (value: Date | string = new Date()) => {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
};

const parseScheduleTime = (value: string) => {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
};

const getChinaDateParts = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day)
  };
};

const getDueTime = (scheduleTime: string, now = new Date()) => {
  const parsed = parseScheduleTime(scheduleTime);
  if (!parsed) return null;
  const { year, month, day } = getChinaDateParts(now);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day, parsed.hour - 8, parsed.minute, 0, 0));
};

const getFreshnessThresholdHours = (scheduleDays: string) => (
  scheduleDays === "work_days" ? 84 : 36
);

const getTaskFreshness = (task: any, lastSuccessRun: any, now = new Date()) => {
  if (Number(task.enabled) !== 1) {
    return { status: "disabled", label: "已关闭", age_hours: null, threshold_hours: getFreshnessThresholdHours(task.schedule_days) };
  }

  const successAtText = lastSuccessRun?.finished_at || lastSuccessRun?.started_at || "";
  const successAt = successAtText ? new Date(successAtText) : null;
  const thresholdHours = getFreshnessThresholdHours(task.schedule_days);
  if (!successAt || !Number.isFinite(successAt.getTime())) {
    return { status: "unknown", label: "无成功记录", age_hours: null, threshold_hours: thresholdHours };
  }

  const ageHours = Math.max(0, Math.round((now.getTime() - successAt.getTime()) / 36_000) / 100);
  if (ageHours > thresholdHours) {
    return { status: "stale", label: `距上次成功 ${ageHours.toFixed(1)} 小时`, age_hours: ageHours, threshold_hours: thresholdHours };
  }

  return { status: "fresh", label: `距上次成功 ${ageHours.toFixed(1)} 小时`, age_hours: ageHours, threshold_hours: thresholdHours };
};

const countArray = (value: unknown) => Array.isArray(value) ? value.length : 0;
const toNumber = (value: unknown) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
};

const TASK_SOURCE_MAPPINGS: Record<string, { source_key: string; source_name: string }> = {
  commodity_metals_price_update: { source_key: "jijinhao_recycle_metals", source_name: "金投网贵金属回收" },
  iphone_price_update: { source_key: "cshrich_iphone_backup", source_name: "潮收汇苹果备用报价" },
  video_game_machine_price_update: { source_key: "dongxu_game_console", source_name: "东旭游戏机档口" },
  popmart_price_update: { source_key: "qiandao_popmart", source_name: "千岛泡泡玛特" },
  longyinbi_price_update: { source_key: "airmb_longyinbi_presale", source_name: "爱藏龙银币" },
  longchao_price_update: { source_key: "airmb_longchao_presale", source_name: "爱藏龙钞" }
};

const tableExists = async (db: any, tableName: string) => {
  const row = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
  return Boolean(row);
};

const activeSourceMappingJoins = `
  FROM source_mappings sm
  LEFT JOIN categories c_id ON sm.category_id = c_id.id
  LEFT JOIN categories c_name
    ON (sm.category_id IS NULL OR sm.category_id = 0)
   AND TRIM(COALESCE(sm.category_name, '')) != ''
   AND c_name.name = sm.category_name
  LEFT JOIN objects o_id ON sm.object_id = o_id.id
  LEFT JOIN objects o_name
    ON (sm.object_id IS NULL OR sm.object_id = 0)
   AND TRIM(COALESCE(sm.object_name, '')) != ''
   AND o_name.name = sm.object_name
   AND (
        COALESCE(c_id.id, c_name.id) IS NULL
        OR o_name.category_id = COALESCE(c_id.id, c_name.id)
   )
  LEFT JOIN variants v_id ON sm.variant_id = v_id.id
  LEFT JOIN variants v_name
    ON (sm.variant_id IS NULL OR sm.variant_id = 0)
   AND TRIM(COALESCE(sm.variant_name, '')) != ''
   AND v_name.name = sm.variant_name
   AND (
        COALESCE(o_id.id, o_name.id) IS NULL
        OR v_name.object_id = COALESCE(o_id.id, o_name.id)
   )
`;

const activeSourceMappingFilter = `
  WHERE COALESCE(c_id.is_archived, c_name.is_archived, 0) = 0
    AND COALESCE(o_id.is_archived, o_name.is_archived, 0) = 0
    AND COALESCE(v_id.is_archived, v_name.is_archived, 0) = 0
`;

const getSourceMappingSummaries = async (db: any) => {
  const summaries = new Map<string, any>();
  if (!(await tableExists(db, "source_mappings"))) return summaries;

  const rows = await db.all(`
    SELECT
      sm.source_key,
      MAX(sm.source_name) AS source_name,
      COUNT(1) AS total_count,
      SUM(CASE WHEN sm.status = 'enabled' THEN 1 ELSE 0 END) AS enabled_count,
      SUM(CASE WHEN sm.status = 'disabled' THEN 1 ELSE 0 END) AS disabled_count,
      SUM(CASE WHEN sm.status = 'unmapped' THEN 1 ELSE 0 END) AS unmapped_count,
      SUM(CASE WHEN sm.status = 'missing_source' THEN 1 ELSE 0 END) AS missing_source_count,
      SUM(CASE WHEN sm.last_error IS NOT NULL AND TRIM(sm.last_error) != '' THEN 1 ELSE 0 END) AS last_error_count,
      MAX(sm.last_seen_at) AS last_seen_at,
      MAX(sm.last_matched_at) AS last_matched_at,
      MAX(sm.updated_at) AS updated_at
    ${activeSourceMappingJoins}
    ${activeSourceMappingFilter}
    GROUP BY sm.source_key
  `);

  for (const row of rows) {
    summaries.set(row.source_key, {
      source_key: row.source_key,
      source_name: row.source_name,
      total_count: toNumber(row.total_count),
      enabled_count: toNumber(row.enabled_count),
      disabled_count: toNumber(row.disabled_count),
      unmapped_count: toNumber(row.unmapped_count),
      missing_source_count: toNumber(row.missing_source_count),
      last_error_count: toNumber(row.last_error_count),
      last_seen_at: row.last_seen_at || null,
      last_matched_at: row.last_matched_at || null,
      updated_at: row.updated_at || null,
      path: `/price/source-mappings?source_key=${encodeURIComponent(row.source_key)}`
    });
  }

  return summaries;
};

type TaskDataStatus = "updated" | "no_change" | "no_source_data" | "mapping_gap" | "source_error" | "unknown";

interface TaskRunDataSummary {
  inserted: number;
  updated: number;
  skipped: number;
  source_count: number;
  matched_count: number;
  filtered_count: number;
  mapping_gap_count: number;
  source_error_count: number;
  data_status: TaskDataStatus;
}

const summarizeDirectTaskRunPayload = (payload: any): Omit<TaskRunDataSummary, "data_status"> => {
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const inserted = toNumber(payload?.inserted_count ?? payload?.insertedCount ?? payload?.inserted);
  const updated = toNumber(payload?.updated_count ?? payload?.updatedCount ?? payload?.updated);
  const skipped = toNumber(payload?.skipped_count ?? payload?.skippedCount ?? payload?.skipped);
  const sourceCount = toNumber(payload?.source_count ?? payload?.sourceCount);
  const matchedCount = toNumber(payload?.matched_count ?? payload?.matchedCount) || records.length;
  const filteredCount = toNumber(payload?.filtered_count ?? payload?.filteredCount);
  const mappingGapCount = countArray(payload?.unmapped_enabled_objects)
    + countArray(payload?.missing_source_objects)
    + countArray(payload?.skipped_symbols);
  const sourceErrorCount = countArray(payload?.source_errors)
    + countArray(payload?.failed_symbols)
    + toNumber(payload?.failed_count ?? payload?.failedCount);

  return {
    inserted,
    updated,
    skipped,
    source_count: sourceCount,
    matched_count: matchedCount,
    filtered_count: filteredCount,
    mapping_gap_count: mappingGapCount,
    source_error_count: sourceErrorCount
  };
};

const addTaskRunSummaries = (
  base: Omit<TaskRunDataSummary, "data_status">,
  extra: Omit<TaskRunDataSummary, "data_status">
) => ({
  inserted: base.inserted + extra.inserted,
  updated: base.updated + extra.updated,
  skipped: base.skipped + extra.skipped,
  source_count: base.source_count + extra.source_count,
  matched_count: base.matched_count + extra.matched_count,
  filtered_count: base.filtered_count + extra.filtered_count,
  mapping_gap_count: base.mapping_gap_count + extra.mapping_gap_count,
  source_error_count: base.source_error_count + extra.source_error_count
});

const emptyTaskRunSummary = (): Omit<TaskRunDataSummary, "data_status"> => ({
  inserted: 0,
  updated: 0,
  skipped: 0,
  source_count: 0,
  matched_count: 0,
  filtered_count: 0,
  mapping_gap_count: 0,
  source_error_count: 0
});

const getTaskDataStatus = (
  summary: Omit<TaskRunDataSummary, "data_status">,
  hasPayload: boolean
): TaskDataStatus => {
  if (summary.source_error_count > 0) return "source_error";
  if (summary.inserted + summary.updated > 0) return "updated";
  if (summary.mapping_gap_count > 0) return "mapping_gap";
  if (summary.source_count > 0 || summary.matched_count > 0 || summary.skipped > 0 || summary.filtered_count > 0) {
    return "no_change";
  }
  return hasPayload ? "no_source_data" : "unknown";
};

export const summarizeTaskRunPayload = (payload: any): TaskRunDataSummary => {
  const direct = summarizeDirectTaskRunPayload(payload);
  const nestedPayloads = [
    payload?.primary,
    payload?.backup,
    ...(Array.isArray(payload?.steps) ? payload.steps.map((step: any) => step?.data) : [])
  ].filter(Boolean);
  const nested = nestedPayloads.reduce((summary, child) => {
    const childSummary = summarizeTaskRunPayload(child);
    return addTaskRunSummaries(summary, childSummary);
  }, emptyTaskRunSummary());
  const hasDirectCounts = Object.values(direct).some(value => value > 0);
  const combined = hasDirectCounts
    ? {
      inserted: Math.max(direct.inserted, nested.inserted),
      updated: Math.max(direct.updated, nested.updated),
      skipped: Math.max(direct.skipped, nested.skipped),
      source_count: Math.max(direct.source_count, nested.source_count),
      matched_count: Math.max(direct.matched_count, nested.matched_count),
      filtered_count: Math.max(direct.filtered_count, nested.filtered_count),
      mapping_gap_count: Math.max(direct.mapping_gap_count, nested.mapping_gap_count),
      source_error_count: Math.max(direct.source_error_count, nested.source_error_count)
    }
    : nested;

  return {
    ...combined,
    data_status: getTaskDataStatus(combined, Boolean(payload))
  };
};

const getHealthStatus = (task: any, latestRun: any, lastSuccessRun: any, now = new Date()) => {
  if (Number(task.enabled) !== 1) {
    return { status: "disabled", severity: "muted", reason: "自动定时已关闭" };
  }
  if (!latestRun) {
    return { status: "never_run", severity: "warning", reason: "尚未执行过" };
  }
  if (latestRun.status === "running") {
    return { status: "running", severity: "info", reason: "任务正在执行" };
  }
  if (latestRun.status === "error") {
    return { status: "failed", severity: "critical", reason: latestRun.message || "最近一次执行失败" };
  }

  const todayKey = getChinaDateKey(now);
  const lastSuccessKey = lastSuccessRun?.finished_at || lastSuccessRun?.started_at
    ? getChinaDateKey(lastSuccessRun.finished_at || lastSuccessRun.started_at)
    : "";
  const dueTime = getDueTime(task.schedule_time, now);
  const dueToday = Boolean(dueTime && now >= dueTime);
  if (dueToday && lastSuccessKey !== todayKey) {
    return { status: "due_not_run", severity: "warning", reason: "今天已到执行时间，但还没有成功执行记录" };
  }

  if (latestRun.status === "skipped") {
    return { status: "skipped", severity: "ok", reason: "任务按规则跳过，本次未写入数据" };
  }

  const payloadSummary = summarizeTaskRunPayload(parseJson(latestRun.result_json));
  if (payloadSummary.data_status === "source_error") {
    return { status: "source_error", severity: "warning", reason: `任务执行完成，但有 ${payloadSummary.source_error_count} 个来源异常` };
  }
  if (payloadSummary.data_status === "mapping_gap") {
    return { status: "mapping_gap", severity: "warning", reason: `任务执行完成，但有 ${payloadSummary.mapping_gap_count} 个映射缺口或来源缺失` };
  }
  if (payloadSummary.data_status === "no_source_data") {
    return { status: "no_source_data", severity: "warning", reason: "任务执行完成，但没有获得有效来源数据，也没有新增或更新" };
  }
  if (payloadSummary.data_status === "updated") {
    return { status: "healthy", severity: "ok", reason: `任务执行正常：新增 ${payloadSummary.inserted}，更新 ${payloadSummary.updated}` };
  }
  return { status: "healthy", severity: "ok", reason: "任务执行正常，本次没有新增或更新" };
};

export const getTaskCenterHealth = async (workspaceInput: unknown) => {
  const db = await getDb();
  const taskFilter = buildWorkspaceFilter(workspaceInput, "workspace");
  const tasks = await db.all(
    `SELECT *
     FROM task_center_tasks
     ${taskFilter.whereClause ? `WHERE ${taskFilter.whereClause}` : ""}
     ORDER BY schedule_time ASC, priority ASC, id ASC`,
    taskFilter.params
  );
  const runFilter = buildWorkspaceFilter(taskFilter.workspace, "workspace");
  const runs = await db.all(
    `SELECT id, task_id, task_key, domain, workspace, trigger_type, status, message, result_json, started_at, finished_at
     FROM task_center_runs
     ${runFilter.whereClause ? `WHERE ${runFilter.whereClause}` : ""}
     ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
     LIMIT 300`,
    runFilter.params
  );
  const sourceMappingSummaries = await getSourceMappingSummaries(db);

  const runsByTaskKey = new Map<string, any[]>();
  for (const run of runs) {
    const key = String(run.task_key || "");
    if (!runsByTaskKey.has(key)) runsByTaskKey.set(key, []);
    runsByTaskKey.get(key)?.push(run);
  }

  const now = new Date();
  const healthTasks = tasks.map((task: any) => {
    const taskRuns = runsByTaskKey.get(task.task_key) || [];
    const latestRun = taskRuns[0] || null;
    const lastSuccessRun = taskRuns.find((run: any) => ["success", "skipped"].includes(run.status)) || null;
    const freshness = getTaskFreshness(task, lastSuccessRun, now);
    const recentRuns = taskRuns.slice(0, 10);
    const recentFailures = recentRuns.filter((run: any) => run.status === "error").length;
    const latestPayload = latestRun ? parseJson(latestRun.result_json) : null;
    const dataSummary = summarizeTaskRunPayload(latestPayload);
    const sourceMappingConfig = TASK_SOURCE_MAPPINGS[task.task_key] || TASK_SOURCE_MAPPINGS[task.task_type];
    const sourceMappingSummary = sourceMappingConfig
      ? {
        ...sourceMappingConfig,
        total_count: 0,
        enabled_count: 0,
        disabled_count: 0,
        unmapped_count: 0,
        missing_source_count: 0,
        last_error_count: 0,
        last_seen_at: null,
        last_matched_at: null,
        updated_at: null,
        path: `/price/source-mappings?source_key=${encodeURIComponent(sourceMappingConfig.source_key)}`,
        ...(sourceMappingSummaries.get(sourceMappingConfig.source_key) || {})
      }
      : null;
    let health = getHealthStatus(task, latestRun, lastSuccessRun, now);
    if (
      sourceMappingSummary
      && health.severity === "ok"
      && (sourceMappingSummary.unmapped_count > 0 || sourceMappingSummary.last_error_count > 0)
    ) {
      health = {
        status: "mapping_gap",
        severity: "warning",
        reason: "任务最近执行正常，但数据源映射里仍有未映射或来源错误"
      };
    }

    return {
      id: task.id,
      task_key: task.task_key,
      name: task.name,
      domain: task.domain,
      workspace: task.workspace,
      task_type: task.task_type,
      enabled: Number(task.enabled) === 1,
      schedule_time: task.schedule_time,
      schedule_days: task.schedule_days,
      priority: task.priority,
      health_status: health.status,
      severity: health.severity,
      reason: health.reason,
      latest_run: latestRun ? {
        id: latestRun.id,
        status: latestRun.status,
        trigger_type: latestRun.trigger_type,
        message: latestRun.status === "error" ? latestRun.message : undefined,
        started_at: latestRun.started_at,
        finished_at: latestRun.finished_at
      } : null,
      last_success_at: lastSuccessRun?.finished_at || lastSuccessRun?.started_at || null,
      freshness,
      recent_failures: recentFailures,
      source_mapping: sourceMappingSummary,
      data_summary: dataSummary
    };
  });

  const summary = healthTasks.reduce((acc: Record<string, number>, task: any) => {
    acc.total += 1;
    acc[task.severity] = (acc[task.severity] || 0) + 1;
    acc[task.health_status] = (acc[task.health_status] || 0) + 1;
    if (task.enabled) acc.enabled += 1;
    return acc;
  }, { total: 0, enabled: 0, ok: 0, warning: 0, critical: 0, muted: 0, info: 0 });

  return {
    generated_at: now.toISOString(),
    summary,
    tasks: healthTasks
  };
};

export const getTaskCenterTask = async (id: string, workspaceInput: unknown) => {
  const db = await getDb();
  const scopedTaskFilter = getScopedTaskFilter(id, workspaceInput);
  const task = await db.get(`SELECT * FROM task_center_tasks WHERE ${scopedTaskFilter.whereClause}`, scopedTaskFilter.params);
  if (!task) throw new WorkspaceCenterError(404, "任务不存在");
  return task;
};

export const getTaskCenterRun = async (id: string, workspaceInput: unknown) => {
  const db = await getDb();
  const workspace = normalizeWorkspace(workspaceInput);
  if (!workspace) throw new WorkspaceCenterError(400, "缺少有效工作区");
  const run = await db.get(
    `SELECT id, task_id, task_key, domain, workspace, trigger_type, status, message, result_json, started_at, finished_at
     FROM task_center_runs
     WHERE id = ? AND workspace = ?`,
    [id, workspace]
  );
  if (!run) throw new WorkspaceCenterError(404, "任务执行记录不存在");
  return {
    ...run,
    result_json_size: typeof run.result_json === "string" ? run.result_json.length : 0
  };
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
  if (body.schedule_time !== undefined) {
    if (!isValidScheduleTime(scheduleTime)) {
      throw new WorkspaceCenterError(400, "任务时间格式错误，应为 00:00-23:59");
    }
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
