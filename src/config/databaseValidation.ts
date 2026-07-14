import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";

export const BUSINESS_DATABASE_IDENTITY = "price_dashboard_business";
export const BUSINESS_APP_WORKSPACE = "business";
export const BUSINESS_METADATA_TABLE = "app_metadata";

const LEGACY_CORE_TABLES = ["categories", "objects", "variants", "price_records"];
const LEGACY_SIGNAL_TABLES = [
  "annual_plans",
  "opinion_records",
  "rule_experiences",
  "source_mappings",
  "task_center_tasks"
];

export const REQUIRED_BUSINESS_TABLES = [
  BUSINESS_METADATA_TABLE,
  "migrations",
  "categories",
  "objects",
  "variants",
  "price_records",
  "source_mappings",
  "monitor_rules",
  "annual_plans",
  "task_center_tasks",
  "opinion_records",
  "audit_logs"
];

const REQUIRED_COLUMNS: Record<string, string[]> = {
  categories: ["id", "name", "is_archived"],
  objects: ["id", "category_id", "name", "is_archived"],
  variants: [
    "id",
    "object_id",
    "name",
    "is_archived",
    "xianyu_heat_level",
    "xianyu_heat_updated_at"
  ],
  price_records: ["id", "date", "category", "object_name", "price"]
};

export class DatabaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseValidationError";
  }
}

const openReadOnly = (filename: string) => open({
  filename,
  driver: sqlite3.Database,
  mode: sqlite3.OPEN_READONLY
});

const readTableNames = async (db: Database) => {
  const rows = await db.all<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  );
  return new Set(rows.map(row => String(row.name)));
};

const readMetadata = async (db: Database, tables: Set<string>) => {
  if (!tables.has(BUSINESS_METADATA_TABLE)) return new Map<string, string>();
  const rows = await db.all<{ key: string; value: string }[]>(
    `SELECT key, value FROM ${BUSINESS_METADATA_TABLE}`
  );
  return new Map(rows.map(row => [String(row.key), String(row.value)]));
};

const assertBusinessMetadata = (metadata: Map<string, string>) => {
  if (metadata.get("database_identity") !== BUSINESS_DATABASE_IDENTITY) {
    throw new DatabaseValidationError("Database identity does not match the business system");
  }
  if (metadata.get("app_workspace") !== BUSINESS_APP_WORKSPACE) {
    throw new DatabaseValidationError("Database workspace does not match the business system");
  }
};

const assertQuickCheck = async (db: Database) => {
  const row = await db.get<{ quick_check?: string }>("PRAGMA quick_check");
  if (String(row?.quick_check || "").toLowerCase() !== "ok") {
    throw new DatabaseValidationError("SQLite integrity check failed");
  }
};

export const validateExistingBusinessDatabase = async (
  filename: string,
  options: { allowEmpty: boolean }
) => {
  const db = await openReadOnly(filename);
  try {
    await assertQuickCheck(db);
    const tables = await readTableNames(db);
    if (tables.size === 0 && options.allowEmpty) {
      return { identity: "new" as const, tableCount: 0 };
    }

    const metadata = await readMetadata(db, tables);
    if (metadata.size > 0) {
      assertBusinessMetadata(metadata);
      return { identity: "marked" as const, tableCount: tables.size };
    }

    const hasCoreTables = LEGACY_CORE_TABLES.every(table => tables.has(table));
    const legacySignals = LEGACY_SIGNAL_TABLES.filter(table => tables.has(table));
    if (!hasCoreTables || legacySignals.length < 2) {
      throw new DatabaseValidationError("Existing database does not match the legacy business schema");
    }

    return { identity: "legacy_business" as const, tableCount: tables.size };
  } finally {
    await db.close();
  }
};

export const ensureBusinessDatabaseMetadata = async (db: Database) => {
  const now = new Date().toISOString();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${BUSINESS_METADATA_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await db.run(
    `INSERT OR IGNORE INTO ${BUSINESS_METADATA_TABLE} (key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    ["database_identity", BUSINESS_DATABASE_IDENTITY, now, now]
  );
  await db.run(
    `INSERT OR IGNORE INTO ${BUSINESS_METADATA_TABLE} (key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    ["app_workspace", BUSINESS_APP_WORKSPACE, now, now]
  );
};

export interface DatabaseReadinessReport {
  identity: string;
  workspace: string;
  tableCount: number;
  migrationCount: number;
  latestMigrationId: string | null;
  quickCheck: "ok";
}

export const verifyBusinessDatabaseReadiness = async (
  filename: string,
  expectedMigrationIds: string[]
): Promise<DatabaseReadinessReport> => {
  const db = await openReadOnly(filename);
  try {
    await assertQuickCheck(db);
    const tables = await readTableNames(db);
    const missingTables = REQUIRED_BUSINESS_TABLES.filter(table => !tables.has(table));
    if (missingTables.length > 0) {
      throw new DatabaseValidationError(`Business database is missing required tables: ${missingTables.join(", ")}`);
    }

    const metadata = await readMetadata(db, tables);
    assertBusinessMetadata(metadata);

    for (const [tableName, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
      const columns = await db.all<{ name: string }[]>(`PRAGMA table_info("${tableName}")`);
      const columnNames = new Set(columns.map(column => String(column.name)));
      const missingColumns = requiredColumns.filter(column => !columnNames.has(column));
      if (missingColumns.length > 0) {
        throw new DatabaseValidationError(
          `Business database table ${tableName} is missing columns: ${missingColumns.join(", ")}`
        );
      }
    }

    const migrationRows = await db.all<{ id: string }[]>("SELECT id FROM migrations");
    const appliedMigrations = new Set(migrationRows.map(row => String(row.id)));
    const missingMigrations = expectedMigrationIds.filter(id => !appliedMigrations.has(id));
    if (missingMigrations.length > 0) {
      throw new DatabaseValidationError(
        `Business database has unapplied migrations: ${missingMigrations.slice(0, 10).join(", ")}`
      );
    }

    return {
      identity: metadata.get("database_identity") || "",
      workspace: metadata.get("app_workspace") || "",
      tableCount: tables.size,
      migrationCount: appliedMigrations.size,
      latestMigrationId: expectedMigrationIds[expectedMigrationIds.length - 1] || null,
      quickCheck: "ok"
    };
  } finally {
    await db.close();
  }
};
