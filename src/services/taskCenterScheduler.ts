import {
  cleanupOrphanedTaskRunsOnStartup,
  runTaskCenterSchedulerTick
} from "../routes/taskCenterRoutes";

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerRunning = false;

async function guardedSchedulerTick() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    await runTaskCenterSchedulerTick();
  } finally {
    schedulerRunning = false;
  }
}

export { cleanupOrphanedTaskRunsOnStartup };

function isTaskCenterSchedulerDisabled() {
  return String(process.env.TASK_CENTER_SCHEDULER_DISABLED || "").trim() === "1";
}

export async function cleanupTaskCenterStartupState() {
  if (isTaskCenterSchedulerDisabled()) return;
  await cleanupOrphanedTaskRunsOnStartup();
}

export function startTaskCenterScheduler() {
  if (isTaskCenterSchedulerDisabled()) {
    console.log("Task center scheduler disabled by TASK_CENTER_SCHEDULER_DISABLED=1");
    return;
  }
  if (schedulerTimer) return;
  schedulerTimer = setInterval(guardedSchedulerTick, 60 * 1000);
  setTimeout(guardedSchedulerTick, 5000);
  console.log("Task center scheduler started");
}
