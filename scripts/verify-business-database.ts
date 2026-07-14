import dotenv from "dotenv";
dotenv.config();

import { getExpectedMigrationIds } from "../src/migrations";
import { resolveDatabaseFilePolicy, validateDatabaseFilePolicy } from "../src/config/databasePolicy";
import { verifyBusinessDatabaseReadiness } from "../src/config/databaseValidation";

const main = async () => {
  const policy = resolveDatabaseFilePolicy();
  const fileState = validateDatabaseFilePolicy(policy);
  if (!fileState.exists) {
    throw new Error("Database verification requires an existing database file");
  }

  const report = await verifyBusinessDatabaseReadiness(policy.filename, getExpectedMigrationIds());
  process.stdout.write(`${JSON.stringify({ status: "ready", ...report }, null, 2)}\n`);
};

main().catch(error => {
  const message = error instanceof Error ? error.message : "Database verification failed";
  process.stderr.write(`${JSON.stringify({ status: "error", message })}\n`);
  process.exit(1);
});
