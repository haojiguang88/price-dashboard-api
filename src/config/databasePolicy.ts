import fs from "fs";
import path from "path";

const parseBoolean = (value: string | undefined) => String(value || "").trim().toLowerCase() === "true";

export interface DatabaseFilePolicy {
  filename: string;
  allowCreate: boolean;
  isProduction: boolean;
}

export class DatabasePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabasePolicyError";
  }
}

export const resolveDatabaseFilePolicy = (
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): DatabaseFilePolicy => {
  const isProduction = env.NODE_ENV === "production";
  const configuredPath = String(env.BUSINESS_DB_PATH || "").trim();

  if (isProduction && !configuredPath) {
    throw new DatabasePolicyError("Production requires an explicit BUSINESS_DB_PATH");
  }
  if (isProduction && configuredPath && !path.isAbsolute(configuredPath)) {
    throw new DatabasePolicyError("Production BUSINESS_DB_PATH must be an absolute path");
  }

  const rawPath = configuredPath || path.join("data", "price_dashboard_business.db");
  const filename = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
  return {
    filename,
    allowCreate: parseBoolean(env.ALLOW_DB_CREATE),
    isProduction
  };
};

export const validateDatabaseFilePolicy = (policy: DatabaseFilePolicy) => {
  if (fs.existsSync(policy.filename)) {
    const stat = fs.statSync(policy.filename);
    if (!stat.isFile()) {
      throw new DatabasePolicyError("BUSINESS_DB_PATH must point to a regular SQLite file");
    }
    return { exists: true, isEmpty: stat.size === 0 };
  }

  if (!policy.allowCreate) {
    throw new DatabasePolicyError(
      "Database file does not exist. Set ALLOW_DB_CREATE=true only when creating a new business database intentionally"
    );
  }

  const parentDirectory = path.dirname(policy.filename);
  fs.mkdirSync(parentDirectory, { recursive: true });
  return { exists: false, isEmpty: true };
};
