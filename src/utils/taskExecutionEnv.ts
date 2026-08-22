export const DEFAULT_TASK_PYTHON = ".venv/bin/python";

const TASK_CHILD_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "PYTHONPATH",
  "PYTHONHOME",
  "VIRTUAL_ENV",
  "BUSINESS_DB_PATH",
  "DB_PATH",
  "TRADING_DB_PATH",
  "PRICE_DASHBOARD_TRADING_DB_PATH",
  "TWELVE_DATA_API_KEY",
  "TUSHARE_TOKEN",
  "AIRMB_USER_ID",
  "AIRMB_ACCESS_TOKEN",
  "AIRMB_OUT_SOURCE",
  "AIRMB_COOKIE",
  "BUSINESS_API_PUBLIC_URL",
  "BUSINESS_FRONTEND_DOMAIN",
  "SERVER_HOST",
  "BUSINESS_API_PORT",
  "TASK_CENTER_PYTHON",
  "PYTHON_BIN"
]);

const TASK_CHILD_ENV_PREFIXES = ["AIRMB_", "LC_"];

/** Never honor DB/API config.python — that field is attacker-controlled via task config updates. */
export function resolveTaskPython(config?: { python?: unknown } | null) {
  void config?.python;
  return String(
    process.env.TASK_CENTER_PYTHON ||
    process.env.PYTHON_BIN ||
    DEFAULT_TASK_PYTHON
  );
}

export function buildTaskChildEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (
      TASK_CHILD_ENV_ALLOWLIST.has(key)
      || TASK_CHILD_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  if (!env.PATH) {
    env.PATH = "/usr/local/bin:/usr/bin:/bin";
  }
  return env;
}
