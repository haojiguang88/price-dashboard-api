import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskChildEnv, resolveTaskPython } from "../src/utils/taskExecutionEnv";

test("task python ignores config.python and prefers TASK_CENTER_PYTHON", () => {
  const previousTaskPython = process.env.TASK_CENTER_PYTHON;
  const previousPythonBin = process.env.PYTHON_BIN;
  try {
    process.env.TASK_CENTER_PYTHON = "/opt/task-python/bin/python";
    process.env.PYTHON_BIN = "/usr/bin/python3";
    assert.equal(
      resolveTaskPython({ python: "/tmp/malicious-binary" }),
      "/opt/task-python/bin/python"
    );
  } finally {
    if (previousTaskPython === undefined) delete process.env.TASK_CENTER_PYTHON;
    else process.env.TASK_CENTER_PYTHON = previousTaskPython;
    if (previousPythonBin === undefined) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = previousPythonBin;
  }
});

test("task python defaults to the project task virtualenv instead of PATH python3", () => {
  const previousTaskPython = process.env.TASK_CENTER_PYTHON;
  const previousPythonBin = process.env.PYTHON_BIN;
  try {
    delete process.env.TASK_CENTER_PYTHON;
    delete process.env.PYTHON_BIN;
    assert.equal(resolveTaskPython(), ".venv/bin/python");
  } finally {
    if (previousTaskPython === undefined) delete process.env.TASK_CENTER_PYTHON;
    else process.env.TASK_CENTER_PYTHON = previousTaskPython;
    if (previousPythonBin === undefined) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = previousPythonBin;
  }
});

test("task child env keeps allowlisted keys and drops secrets outside the list", () => {
  const env = buildTaskChildEnv({
    PATH: "/usr/bin",
    BUSINESS_DB_PATH: "/tmp/business.db",
    AIRMB_COOKIE: "cookie-value",
    AUTH_SESSION_SECRET: "should-not-pass",
    AWS_SECRET_ACCESS_KEY: "should-not-pass",
    RANDOM_SECRET: "should-not-pass"
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.BUSINESS_DB_PATH, "/tmp/business.db");
  assert.equal(env.AIRMB_COOKIE, "cookie-value");
  assert.equal(env.AUTH_SESSION_SECRET, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.RANDOM_SECRET, undefined);
});
