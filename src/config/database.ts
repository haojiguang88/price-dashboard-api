import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import path from "path";

const dbPath = process.env.DB_PATH || path.join(process.cwd(), "db", "price_dashboard_dev.db");

console.log(`Database path: ${dbPath}`);

// 初始化数据库表结构
const initDatabase = async (db: Database) => {
  await db.exec("PRAGMA foreign_keys = ON;");

  const ensureColumn = async (tableName: string, columnName: string, definition: string) => {
    const columns = await db.all(`PRAGMA table_info(${tableName})`);
    const exists = columns.some((column: any) => column.name === columnName);
    if (!exists) {
      await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  };
  
  await db.exec("CREATE TABLE IF NOT EXISTS price_records (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, category TEXT NOT NULL, object_name TEXT NOT NULL, variant TEXT, price REAL NOT NULL, source TEXT, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE TABLE IF NOT EXISTS objects (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE, UNIQUE(category_id, name))");
  await db.exec("CREATE TABLE IF NOT EXISTS variants (id INTEGER PRIMARY KEY AUTOINCREMENT, object_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE, UNIQUE(object_id, name))");
  await db.exec("CREATE TABLE IF NOT EXISTS buying_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_name TEXT NOT NULL, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, target_price REAL NOT NULL, plan_quantity INTEGER NOT NULL, total_amount REAL NOT NULL, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE TABLE IF NOT EXISTS selling_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_name TEXT NOT NULL, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, target_price REAL NOT NULL, plan_quantity INTEGER NOT NULL, total_amount REAL NOT NULL, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await ensureColumn("buying_plans", "batches", "TEXT");
  await ensureColumn("selling_plans", "batches", "TEXT");

  await db.exec("CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY AUTOINCREMENT, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, total_quantity INTEGER NOT NULL, total_cost REAL NOT NULL, avg_price REAL NOT NULL, current_price REAL, total_profit REAL, profit_rate REAL, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE TABLE IF NOT EXISTS follows (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, object_id INTEGER NOT NULL, variant_id INTEGER NOT NULL DEFAULT 0 CHECK (TRIM(CAST(variant_id AS TEXT)) != '' AND TRIM(CAST(variant_id AS TEXT)) NOT GLOB '*[^0-9]*'), category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT NOT NULL, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(category_id, object_id, variant_id), FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE, FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE)");

  await db.exec("CREATE TABLE IF NOT EXISTS watchlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, object_id INTEGER NOT NULL, variant_id INTEGER NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, reason TEXT NOT NULL, watch_points TEXT, risks TEXT, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE, FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE)");

  await db.exec("CREATE TABLE IF NOT EXISTS manual_todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL, due_date TEXT, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

  await db.exec("CREATE TABLE IF NOT EXISTS ended_positions (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, quantity INTEGER NOT NULL, amount REAL NOT NULL, cost REAL NOT NULL, profit REAL NOT NULL, sell_date TEXT NOT NULL, buy_date TEXT NOT NULL, holding_period TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

  await db.exec("CREATE TABLE IF NOT EXISTS sell_records (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, quantity INTEGER NOT NULL, price REAL NOT NULL, amount REAL NOT NULL, cost REAL NOT NULL, profit REAL NOT NULL, sell_date TEXT NOT NULL, buy_date TEXT NOT NULL, holding_period TEXT, note TEXT, batch_id TEXT, position_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

  await db.exec("CREATE TABLE IF NOT EXISTS position_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT, position_id INTEGER NOT NULL, batch_date TEXT NOT NULL, batch_price REAL NOT NULL, batch_quantity INTEGER NOT NULL, batch_amount REAL NOT NULL, remaining_quantity INTEGER NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE)");

  await db.exec("UPDATE follows SET variant_id = 0 WHERE variant_id IS NULL OR TRIM(CAST(variant_id AS TEXT)) = '' OR TRIM(CAST(variant_id AS TEXT)) GLOB '*[^0-9]*'");
  await db.exec("DROP TRIGGER IF EXISTS follows_variant_id_no_blank_insert");
  await db.exec("DROP TRIGGER IF EXISTS follows_variant_id_no_blank_update");
  await db.exec("CREATE TRIGGER follows_variant_id_no_blank_insert BEFORE INSERT ON follows WHEN NEW.variant_id IS NULL OR TRIM(CAST(NEW.variant_id AS TEXT)) = '' OR TRIM(CAST(NEW.variant_id AS TEXT)) GLOB '*[^0-9]*' BEGIN SELECT RAISE(ABORT, 'follows.variant_id must be integer id or 0, not blank'); END");
  await db.exec("CREATE TRIGGER follows_variant_id_no_blank_update BEFORE UPDATE OF variant_id ON follows WHEN NEW.variant_id IS NULL OR TRIM(CAST(NEW.variant_id AS TEXT)) = '' OR TRIM(CAST(NEW.variant_id AS TEXT)) GLOB '*[^0-9]*' BEGIN SELECT RAISE(ABORT, 'follows.variant_id must be integer id or 0, not blank'); END");

  // 风控检查记录表（当前新风控链路使用）
  await db.exec("CREATE TABLE IF NOT EXISTS risk_check_records (id INTEGER PRIMARY KEY AUTOINCREMENT, review_type TEXT NOT NULL DEFAULT 'general_filter', category_name TEXT, object_name TEXT, variant_name TEXT, category_risk_type TEXT, rule_version TEXT DEFAULT 'v1', system_result TEXT NOT NULL, result_reason TEXT, summary TEXT, extra_result_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE TABLE IF NOT EXISTS risk_check_record_items (id INTEGER PRIMARY KEY AUTOINCREMENT, record_id INTEGER NOT NULL, item_key TEXT, item_label TEXT NOT NULL, group_name TEXT, item_value TEXT, trigger_type TEXT DEFAULT 'none', trigger_reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (record_id) REFERENCES risk_check_records(id) ON DELETE CASCADE)");

  await db.exec("CREATE TABLE IF NOT EXISTS analysis_annotations (id INTEGER PRIMARY KEY AUTOINCREMENT, module TEXT NOT NULL, entity_type TEXT NOT NULL, entity_key TEXT NOT NULL, annotation_key TEXT NOT NULL, annotation_value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(module, entity_type, entity_key, annotation_key))");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_analysis_annotations_scope ON analysis_annotations(module, entity_type, annotation_key)");
  await db.exec("CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, module TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, entity_id TEXT, path TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_audit_logs_module ON audit_logs(module, action, status)");

  console.log("SQLite database connected and base tables created if not exists");
  console.log("Record tables will be created via migrations");
};

// 首次初始化
let initialized = false;
const getDb = async () => {
  const db = await open({ filename: dbPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE });
  await db.exec("PRAGMA busy_timeout = 60000;");
  
  if (!initialized) {
    await initDatabase(db);
    initialized = true;
  } else {
    await db.exec("PRAGMA foreign_keys = ON;");
  }
  
  return db;
};

export default getDb;
