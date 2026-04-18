import sqlite3 from "sqlite3";import { open, Database } from "sqlite";import path from "path";

const dbPath = process.env.DB_PATH || path.join(process.cwd(), "db", "price_dashboard_dev.db");

console.log(`Database path: ${dbPath}`);

let dbInstance: Database | null = null;
const getDb = async () => {
if (!dbInstance) {
dbInstance = await open({ filename: dbPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE });
await dbInstance.exec("PRAGMA foreign_keys = ON;");
// 基础表结构 - 非记录型模块
await dbInstance.exec("CREATE TABLE IF NOT EXISTS price_records (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, category TEXT NOT NULL, object_name TEXT NOT NULL, variant TEXT, price REAL NOT NULL, source TEXT, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
await dbInstance.exec("CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
await dbInstance.exec("CREATE TABLE IF NOT EXISTS objects (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE, UNIQUE(category_id, name))");
await dbInstance.exec("CREATE TABLE IF NOT EXISTS variants (id INTEGER PRIMARY KEY AUTOINCREMENT, object_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE, UNIQUE(object_id, name))");
await dbInstance.exec("CREATE TABLE IF NOT EXISTS buying_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_name TEXT NOT NULL, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, target_price REAL NOT NULL, plan_quantity INTEGER NOT NULL, total_amount REAL NOT NULL, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
await dbInstance.exec("CREATE TABLE IF NOT EXISTS selling_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_name TEXT NOT NULL, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, target_price REAL NOT NULL, plan_quantity INTEGER NOT NULL, total_amount REAL NOT NULL, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

await dbInstance.exec("CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY AUTOINCREMENT, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, total_quantity INTEGER NOT NULL, total_cost REAL NOT NULL, avg_price REAL NOT NULL, current_price REAL, total_profit REAL, profit_rate REAL, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
await dbInstance.exec("CREATE TABLE IF NOT EXISTS position_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, position_id INTEGER NOT NULL, batch_price REAL NOT NULL, batch_quantity INTEGER NOT NULL, batch_cost REAL NOT NULL, batch_date TEXT NOT NULL, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE)");
await dbInstance.exec("CREATE TABLE IF NOT EXISTS follows (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, object_id INTEGER NOT NULL, variant_id INTEGER NOT NULL, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT NOT NULL, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(category_id, object_id, variant_id), FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE, FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE)");

await dbInstance.exec("CREATE TABLE IF NOT EXISTS watchlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, object_id INTEGER NOT NULL, variant_id INTEGER NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, reason TEXT NOT NULL, watch_points TEXT, risks TEXT, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE, FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE)");

await dbInstance.exec("CREATE TABLE IF NOT EXISTS manual_todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL, due_date TEXT, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

console.log("SQLite database connected and base tables created if not exists");
console.log("Record tables will be created via migrations");}return dbInstance;};export default getDb;
