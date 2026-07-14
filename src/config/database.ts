import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import { AsyncLocalStorage } from "async_hooks";
import {
  resolveDatabaseFilePolicy,
  validateDatabaseFilePolicy,
  type DatabaseFilePolicy
} from "./databasePolicy";
import {
  ensureBusinessDatabaseMetadata,
  validateExistingBusinessDatabase
} from "./databaseValidation";

// 初始化数据库表结构
const initDatabase = async (db: Database) => {
  await db.exec("PRAGMA foreign_keys = ON;");
  await ensureBusinessDatabaseMetadata(db);

  const ensureColumn = async (tableName: string, columnName: string, definition: string) => {
    const columns = await db.all(`PRAGMA table_info(${tableName})`);
    const exists = columns.some((column: any) => column.name === columnName);
    if (!exists) {
      await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
      return true;
    }
    return false;
  };

  const shouldInitializeBusinessTables = true;
  
  if (shouldInitializeBusinessTables) {
	  await db.exec("CREATE TABLE IF NOT EXISTS price_records (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, category TEXT NOT NULL, object_name TEXT NOT NULL, variant TEXT, price REAL NOT NULL, source TEXT, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
	  await db.exec("CREATE TABLE IF NOT EXISTS price_quality_alert_reviews (alert_key TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', note TEXT, reviewed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
	  await db.exec("CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE TABLE IF NOT EXISTS objects (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE, UNIQUE(category_id, name))");
  await db.exec("CREATE TABLE IF NOT EXISTS variants (id INTEGER PRIMARY KEY AUTOINCREMENT, object_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE, UNIQUE(object_id, name))");
  await db.exec("CREATE TABLE IF NOT EXISTS category_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER, category_name TEXT NOT NULL, object_name TEXT, variant_name TEXT, business_style TEXT, operation_scene TEXT, supply_mode TEXT, sales_mode TEXT, price_pattern TEXT, risk_points TEXT, operating_discipline TEXT, data_caliber TEXT, experience_notes TEXT, decision_notes TEXT, extra_json TEXT DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active', note TEXT, is_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL)");
  await db.exec("CREATE TABLE IF NOT EXISTS lucky_number_records (id INTEGER PRIMARY KEY AUTOINCREMENT, product_name TEXT NOT NULL, number_code TEXT NOT NULL, year TEXT NOT NULL DEFAULT '2025年', raw_type TEXT NOT NULL DEFAULT '', rating_type TEXT NOT NULL DEFAULT '', rating_score TEXT NOT NULL DEFAULT '', source_raw TEXT, note TEXT, is_sold INTEGER NOT NULL DEFAULT 0, sold_at TEXT, is_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE TABLE IF NOT EXISTS buying_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_name TEXT NOT NULL, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, target_price REAL NOT NULL, plan_quantity INTEGER NOT NULL, total_amount REAL NOT NULL, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE TABLE IF NOT EXISTS selling_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_name TEXT NOT NULL, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, target_price REAL NOT NULL, plan_quantity INTEGER NOT NULL, total_amount REAL NOT NULL, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE TABLE IF NOT EXISTS plan_execution_events (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_type TEXT NOT NULL, plan_id INTEGER NOT NULL, status_from TEXT, status_to TEXT NOT NULL, reason_code TEXT, reason_text TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await ensureColumn("categories", "is_archived", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("categories", "archived_at", "TEXT");
  await ensureColumn("objects", "is_archived", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("objects", "archived_at", "TEXT");
  await ensureColumn("variants", "is_archived", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("variants", "archived_at", "TEXT");
	  await ensureColumn("variants", "note", "TEXT");
	  await ensureColumn(
	    "variants",
	    "xianyu_heat_level",
	    "TEXT NOT NULL DEFAULT 'none' CHECK (xianyu_heat_level IN ('none', 'low', 'medium', 'high', 'very_high'))"
	  );
	  await ensureColumn("variants", "xianyu_heat_updated_at", "TEXT");
  await ensureColumn("category_profiles", "object_name", "TEXT");
  await ensureColumn("category_profiles", "variant_name", "TEXT");
  await ensureColumn("buying_plans", "batches", "TEXT");
  await ensureColumn("selling_plans", "batches", "TEXT");
  await ensureColumn("buying_plans", "annual_plan_item_id", "INTEGER");
  await ensureColumn("selling_plans", "annual_plan_item_id", "INTEGER");
  await ensureColumn("lucky_number_records", "rating_type", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("lucky_number_records", "rating_score", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("lucky_number_records", "is_sold", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("lucky_number_records", "sold_at", "TEXT");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_categories_archive ON categories(is_archived, name)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_objects_archive ON objects(is_archived, category_id, name)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_variants_archive ON variants(is_archived, object_id, name)");
	  await db.exec("CREATE INDEX IF NOT EXISTS idx_category_profiles_category ON category_profiles(category_id, category_name, status, is_deleted)");
	  await db.exec("CREATE INDEX IF NOT EXISTS idx_category_profiles_object ON category_profiles(category_name, object_name, variant_name, status, is_deleted)");
	  await db.exec("CREATE INDEX IF NOT EXISTS idx_lucky_number_records_lookup ON lucky_number_records(product_name, year, is_deleted, number_code)");
	  await db.exec("CREATE INDEX IF NOT EXISTS idx_lucky_number_records_updated ON lucky_number_records(is_deleted, updated_at DESC, id DESC)");
	  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_lucky_number_records_active ON lucky_number_records(product_name, number_code, year, raw_type) WHERE is_deleted = 0");
	  await db.exec("CREATE INDEX IF NOT EXISTS idx_buying_plans_annual_plan_item ON buying_plans(annual_plan_item_id)");
	  await db.exec("CREATE INDEX IF NOT EXISTS idx_selling_plans_annual_plan_item ON selling_plans(annual_plan_item_id)");
	  await db.exec("CREATE INDEX IF NOT EXISTS idx_plan_execution_events_plan ON plan_execution_events(plan_type, plan_id, created_at DESC, id DESC)");
	  await db.exec("CREATE INDEX IF NOT EXISTS idx_price_records_series_date ON price_records(category, object_name, variant, date, id)");
	  await db.exec("CREATE INDEX IF NOT EXISTS idx_price_quality_alert_reviews_status ON price_quality_alert_reviews(status, updated_at DESC)");

  await db.exec("CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY AUTOINCREMENT, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, total_quantity REAL NOT NULL, total_cost REAL NOT NULL, avg_price REAL NOT NULL, current_price REAL, total_profit REAL, profit_rate REAL, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE TABLE IF NOT EXISTS follows (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, object_id INTEGER NOT NULL, variant_id INTEGER NOT NULL DEFAULT 0 CHECK (TRIM(CAST(variant_id AS TEXT)) != '' AND TRIM(CAST(variant_id AS TEXT)) NOT GLOB '*[^0-9]*'), category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT NOT NULL, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(category_id, object_id, variant_id), FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE, FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE)");

  await db.exec("CREATE TABLE IF NOT EXISTS watchlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, object_id INTEGER NOT NULL, variant_id INTEGER NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, reason TEXT NOT NULL, watch_points TEXT, risks TEXT, note TEXT, track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE, FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE CASCADE)");
  await ensureColumn("watchlist_items", "annual_plan_item_id", "INTEGER");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_watchlist_items_annual_plan_item ON watchlist_items(annual_plan_item_id)");
  }

  await db.exec("CREATE TABLE IF NOT EXISTS manual_todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL, due_date TEXT, note TEXT, domain TEXT NOT NULL DEFAULT 'business', workspace TEXT NOT NULL DEFAULT 'business', track TEXT, type TEXT DEFAULT 'manual', market_type_preset TEXT DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await ensureColumn("manual_todos", "domain", "TEXT NOT NULL DEFAULT 'business'");
  await ensureColumn("manual_todos", "workspace", "TEXT NOT NULL DEFAULT 'business'");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_manual_todos_workspace_status ON manual_todos(workspace, status, updated_at DESC)");

  if (shouldInitializeBusinessTables) {
  await db.exec("CREATE TABLE IF NOT EXISTS ended_positions (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, quantity REAL NOT NULL, amount REAL NOT NULL, cost REAL NOT NULL, profit REAL NOT NULL, sell_date TEXT NOT NULL, buy_date TEXT NOT NULL, holding_period TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

  await db.exec("CREATE TABLE IF NOT EXISTS sell_records (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT, quantity REAL NOT NULL, price REAL NOT NULL, amount REAL NOT NULL, cost REAL NOT NULL, profit REAL NOT NULL, sell_date TEXT NOT NULL, buy_date TEXT NOT NULL, holding_period TEXT, note TEXT, batch_id TEXT, position_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

  await db.exec("CREATE TABLE IF NOT EXISTS position_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT, position_id INTEGER NOT NULL, batch_date TEXT NOT NULL, batch_price REAL NOT NULL, batch_quantity REAL NOT NULL, batch_cost REAL NOT NULL, remaining_quantity REAL NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE)");
  const addedBatchCostColumn = await ensureColumn("position_batches", "batch_cost", "REAL NOT NULL DEFAULT 0");
  const positionBatchColumns = await db.all("PRAGMA table_info(position_batches)");
  const hasBatchAmountColumn = positionBatchColumns.some((column: any) => column.name === "batch_amount");
  if (addedBatchCostColumn && hasBatchAmountColumn) {
    await db.exec("UPDATE position_batches SET batch_cost = batch_amount WHERE batch_amount IS NOT NULL");
  }

  await db.exec("UPDATE follows SET variant_id = 0 WHERE variant_id IS NULL OR TRIM(CAST(variant_id AS TEXT)) = '' OR TRIM(CAST(variant_id AS TEXT)) GLOB '*[^0-9]*'");
  await db.exec("DROP TRIGGER IF EXISTS follows_variant_id_no_blank_insert");
  await db.exec("DROP TRIGGER IF EXISTS follows_variant_id_no_blank_update");
  await db.exec("CREATE TRIGGER follows_variant_id_no_blank_insert BEFORE INSERT ON follows WHEN NEW.variant_id IS NULL OR TRIM(CAST(NEW.variant_id AS TEXT)) = '' OR TRIM(CAST(NEW.variant_id AS TEXT)) GLOB '*[^0-9]*' BEGIN SELECT RAISE(ABORT, 'follows.variant_id must be integer id or 0, not blank'); END");
  await db.exec("CREATE TRIGGER follows_variant_id_no_blank_update BEFORE UPDATE OF variant_id ON follows WHEN NEW.variant_id IS NULL OR TRIM(CAST(NEW.variant_id AS TEXT)) = '' OR TRIM(CAST(NEW.variant_id AS TEXT)) GLOB '*[^0-9]*' BEGIN SELECT RAISE(ABORT, 'follows.variant_id must be integer id or 0, not blank'); END");

  // 风控检查记录表（当前新风控链路使用）
  await db.exec("CREATE TABLE IF NOT EXISTS risk_check_records (id INTEGER PRIMARY KEY AUTOINCREMENT, review_type TEXT NOT NULL DEFAULT 'general_filter', category_name TEXT, object_name TEXT, variant_name TEXT, category_risk_type TEXT, rule_version TEXT DEFAULT 'v1', system_result TEXT NOT NULL, result_reason TEXT, summary TEXT, extra_result_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE TABLE IF NOT EXISTS risk_check_record_items (id INTEGER PRIMARY KEY AUTOINCREMENT, record_id INTEGER NOT NULL, item_key TEXT, item_label TEXT NOT NULL, group_name TEXT, item_value TEXT, trigger_type TEXT DEFAULT 'none', trigger_reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (record_id) REFERENCES risk_check_records(id) ON DELETE CASCADE)");

  await db.exec("CREATE TABLE IF NOT EXISTS speculation_cycle_records (id INTEGER PRIMARY KEY AUTOINCREMENT, category_name TEXT NOT NULL, object_name TEXT NOT NULL, variant_name TEXT DEFAULT '', launch_date TEXT, official_price REAL, open_price REAL, high_price REAL, low_price REAL, current_price REAL, open_level TEXT DEFAULT '中开', release_quantity TEXT DEFAULT '未知', total_quantity TEXT DEFAULT '未知', first_release_quantity TEXT DEFAULT '未知', first_release_status TEXT DEFAULT '未知', official_first_release TEXT DEFAULT '未知', market_background TEXT DEFAULT '未知', cycle_stage TEXT, cycle_pattern TEXT, rise_nature TEXT, main_participants TEXT, expected_arrival_date TEXT, actual_arrival_date TEXT, arrival_scale TEXT, supply_release_type TEXT, high_level_real_demand TEXT, final_result TEXT, future_action_rule TEXT, experience_tags TEXT, summary TEXT, lesson TEXT, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  await ensureColumn("speculation_cycle_records", "open_level", "TEXT DEFAULT '中开'");
  await ensureColumn("speculation_cycle_records", "release_quantity", "TEXT DEFAULT '未知'");
  await ensureColumn("speculation_cycle_records", "total_quantity", "TEXT DEFAULT '未知'");
  await ensureColumn("speculation_cycle_records", "first_release_quantity", "TEXT DEFAULT '未知'");
  await ensureColumn("speculation_cycle_records", "first_release_status", "TEXT DEFAULT '未知'");
  await ensureColumn("speculation_cycle_records", "official_first_release", "TEXT DEFAULT '未知'");
  await ensureColumn("speculation_cycle_records", "market_background", "TEXT DEFAULT '未知'");
  await ensureColumn("speculation_cycle_records", "experience_tags", "TEXT");
  await db.exec("CREATE TABLE IF NOT EXISTS speculation_cycle_events (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id INTEGER NOT NULL, record_time TEXT NOT NULL, price REAL, bid_price_band TEXT, price_type TEXT, stage TEXT, market_action TEXT, sentiment_level TEXT, participation_level TEXT, buyer_strength TEXT, seller_pressure TEXT, discussion_heat TEXT, wall_pressure TEXT, sweep_strength TEXT, trigger_event TEXT, risk_signal TEXT, experience_tags TEXT, source TEXT, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (cycle_id) REFERENCES speculation_cycle_records(id) ON DELETE CASCADE)");
  await ensureColumn("speculation_cycle_events", "bid_price_band", "TEXT");
  await ensureColumn("speculation_cycle_events", "experience_tags", "TEXT");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_speculation_cycle_records_pattern ON speculation_cycle_records(cycle_pattern, cycle_stage, category_name)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_speculation_cycle_events_cycle_time ON speculation_cycle_events(cycle_id, record_time)");
  }

  await db.exec("CREATE TABLE IF NOT EXISTS market_anchor_daily_prices (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, name TEXT NOT NULL, market TEXT, asset_type TEXT NOT NULL DEFAULT 'precious_metal_anchor', trade_date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, volume REAL, amount REAL, source TEXT NOT NULL, source_label TEXT, raw_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(symbol, trade_date, source))");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_market_anchor_daily_symbol_date ON market_anchor_daily_prices(symbol, source, trade_date DESC)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_market_anchor_daily_asset_date ON market_anchor_daily_prices(asset_type, trade_date DESC)");
  await db.exec("CREATE TABLE IF NOT EXISTS market_assist_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_symbol TEXT NOT NULL, asset_label TEXT NOT NULL, rule_group TEXT NOT NULL, group_label TEXT NOT NULL, rule_key TEXT NOT NULL, rule_name TEXT NOT NULL, rule_type TEXT NOT NULL DEFAULT 'threshold', priority TEXT NOT NULL DEFAULT 'medium', threshold_json TEXT NOT NULL DEFAULT '{}', action_hint TEXT, display_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', note TEXT, evidence_window TEXT, source_note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(asset_symbol, rule_group, rule_key))");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_market_assist_rules_scope ON market_assist_rules(asset_symbol, rule_group, status, display_order)");
  await db.exec("CREATE TABLE IF NOT EXISTS market_assist_rule_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_symbol TEXT NOT NULL, asset_label TEXT NOT NULL, rule_group TEXT NOT NULL, group_label TEXT NOT NULL, version_key TEXT NOT NULL, version_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', effective_date TEXT, change_reason TEXT, threshold_summary TEXT, sample_window TEXT, regression_command TEXT, regression_summary TEXT, snapshot_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(asset_symbol, rule_group, version_key))");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_market_assist_rule_versions_scope ON market_assist_rule_versions(asset_symbol, rule_group, status, effective_date DESC, id DESC)");
  await db.exec("CREATE TABLE IF NOT EXISTS market_physical_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_symbol TEXT NOT NULL, asset_label TEXT NOT NULL, observation_date TEXT NOT NULL, reference_close REAL, merchant_sell_price REAL, merchant_sell_premium REAL, buyback_price REAL, buyback_premium REAL, supply_status TEXT NOT NULL DEFAULT 'unknown', transaction_heat TEXT NOT NULL DEFAULT 'unknown', social_heat TEXT NOT NULL DEFAULT 'unknown', reliability TEXT NOT NULL DEFAULT 'manual_limited', source_note TEXT, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_market_physical_observations_symbol_date ON market_physical_observations(asset_symbol, observation_date DESC, id DESC)");

  await db.exec("CREATE TABLE IF NOT EXISTS analysis_annotations (id INTEGER PRIMARY KEY AUTOINCREMENT, module TEXT NOT NULL, entity_type TEXT NOT NULL, entity_key TEXT NOT NULL, annotation_key TEXT NOT NULL, annotation_value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(module, entity_type, entity_key, annotation_key))");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_analysis_annotations_scope ON analysis_annotations(module, entity_type, annotation_key)");
  await db.exec("CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, module TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, entity_id TEXT, path TEXT, domain TEXT NOT NULL DEFAULT 'business', workspace TEXT NOT NULL DEFAULT 'business', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await ensureColumn("audit_logs", "domain", "TEXT NOT NULL DEFAULT 'business'");
  await ensureColumn("audit_logs", "workspace", "TEXT NOT NULL DEFAULT 'business'");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_audit_logs_module ON audit_logs(module, action, status)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace_timestamp ON audit_logs(workspace, timestamp DESC, created_at DESC)");
  await db.exec("CREATE TABLE IF NOT EXISTS workspace_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'business', workspace TEXT NOT NULL DEFAULT 'business', tag_group TEXT NOT NULL DEFAULT '交易', color TEXT NOT NULL DEFAULT 'indigo', description TEXT NOT NULL DEFAULT '', applicable_scopes TEXT NOT NULL DEFAULT '[\"category\",\"object\",\"variant\"]', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(workspace, name))");
  await ensureColumn("workspace_tags", "tag_group", "TEXT NOT NULL DEFAULT '交易'");
  await ensureColumn("workspace_tags", "color", "TEXT NOT NULL DEFAULT 'indigo'");
  await ensureColumn("workspace_tags", "description", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("workspace_tags", "applicable_scopes", "TEXT NOT NULL DEFAULT '[\"category\",\"object\",\"variant\"]'");
  await ensureColumn("workspace_tags", "status", "TEXT NOT NULL DEFAULT 'active'");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_workspace_tags_workspace_name ON workspace_tags(workspace, name)");
  await db.exec("CREATE TABLE IF NOT EXISTS entity_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL DEFAULT 'business', entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(workspace, entity_type, entity_id, tag_id), FOREIGN KEY (tag_id) REFERENCES workspace_tags(id) ON DELETE CASCADE)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_entity_tags_lookup ON entity_tags(workspace, entity_type, entity_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(workspace, tag_id)");
  await db.exec("CREATE TABLE IF NOT EXISTS user_preferences (id INTEGER PRIMARY KEY AUTOINCREMENT, user_key TEXT NOT NULL DEFAULT 'default', preference_key TEXT NOT NULL, preference_value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_key, preference_key))");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_user_preferences_user_key ON user_preferences(user_key, preference_key)");
  await db.exec("CREATE TABLE IF NOT EXISTS dashboard_action_statuses (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL DEFAULT 'business', action_key TEXT NOT NULL, action_title TEXT NOT NULL DEFAULT '', action_source TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('handled', 'ignored')), note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(workspace, action_key))");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_dashboard_action_statuses_scope ON dashboard_action_statuses(workspace, status, updated_at DESC)");

  console.log("SQLite database connected and base tables created if not exists");
  console.log("Record tables will be created via migrations");
};

export const initializeBusinessBaseSchema = initDatabase;

export interface RequestDatabaseContext {
  connectionPromise: Promise<Database> | null;
  closed: boolean;
}

export interface DatabaseManagerOptions {
  filename: string;
  allowCreate: boolean;
  initialize?: (db: Database) => Promise<void>;
}

export class DatabaseManager {
  private readonly filename: string;
  private readonly allowCreate: boolean;
  private readonly initialize?: (db: Database) => Promise<void>;
  private readonly requestStorage = new AsyncLocalStorage<RequestDatabaseContext>();
  private baseConnectionPromise: Promise<Database> | null = null;
  private initialized = false;

  constructor(options: DatabaseManagerOptions) {
    this.filename = options.filename;
    this.allowCreate = options.allowCreate;
    this.initialize = options.initialize;
  }

  private async openConnection(allowCreate: boolean) {
    const mode = sqlite3.OPEN_READWRITE | (allowCreate ? sqlite3.OPEN_CREATE : 0);
    const db = await open({ filename: this.filename, driver: sqlite3.Database, mode });
    await db.exec("PRAGMA busy_timeout = 60000;");
    await db.exec("PRAGMA foreign_keys = ON;");
    await db.exec("PRAGMA synchronous = NORMAL;");
    return db;
  }

  private async getBaseConnection() {
    if (this.baseConnectionPromise) return this.baseConnectionPromise;

    this.baseConnectionPromise = (async () => {
      const db = await this.openConnection(this.allowCreate);
      try {
        await db.exec("PRAGMA journal_mode = WAL;");
        if (!this.initialized && this.initialize) {
          await this.initialize(db);
          this.initialized = true;
        }
        return db;
      } catch (error) {
        await db.close().catch(() => undefined);
        throw error;
      }
    })().catch((error) => {
      this.baseConnectionPromise = null;
      throw error;
    });

    return this.baseConnectionPromise;
  }

  async getDb() {
    const requestContext = this.requestStorage.getStore();
    if (!requestContext) return this.getBaseConnection();
    if (requestContext.closed) throw new Error("Request database context is already closed");

    await this.getBaseConnection();
    if (!requestContext.connectionPromise) {
      requestContext.connectionPromise = this.openConnection(false);
    }
    return requestContext.connectionPromise;
  }

  createRequestContext(): RequestDatabaseContext {
    return { connectionPromise: null, closed: false };
  }

  runWithRequestContext<T>(context: RequestDatabaseContext, callback: () => T): T {
    return this.requestStorage.run(context, callback);
  }

  async closeRequestContext(context: RequestDatabaseContext) {
    if (context.closed) return;
    context.closed = true;
    if (!context.connectionPromise) return;
    const db = await context.connectionPromise;
    await db.close();
  }

  async runInRequestContext<T>(callback: () => Promise<T>): Promise<T> {
    const context = this.createRequestContext();
    return this.runWithRequestContext(context, async () => {
      try {
        return await callback();
      } finally {
        await this.closeRequestContext(context);
      }
    });
  }

  async withTransaction<T>(
    callback: (db: Database) => Promise<T>,
    mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE" = "IMMEDIATE"
  ): Promise<T> {
    await this.getBaseConnection();
    const db = await this.openConnection(false);
    let transactionStarted = false;
    try {
      await db.exec(`BEGIN ${mode} TRANSACTION`);
      transactionStarted = true;
      const result = await callback(db);
      await db.exec("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        await db.exec("ROLLBACK").catch(() => undefined);
      }
      throw error;
    } finally {
      await db.close();
    }
  }

  async close() {
    if (!this.baseConnectionPromise) return;
    const db = await this.baseConnectionPromise;
    this.baseConnectionPromise = null;
    this.initialized = false;
    await db.close();
  }
}

let defaultPolicy: DatabaseFilePolicy | null = null;
let defaultManager: DatabaseManager | null = null;
let defaultPreflightPromise: Promise<void> | null = null;

const getDefaultPolicy = () => {
  if (!defaultPolicy) defaultPolicy = resolveDatabaseFilePolicy();
  return defaultPolicy;
};

const getDefaultManager = () => {
  if (!defaultManager) {
    const policy = getDefaultPolicy();
    defaultManager = new DatabaseManager({
      filename: policy.filename,
      allowCreate: policy.allowCreate,
      initialize: initDatabase
    });
  }
  return defaultManager;
};

const ensureDefaultDatabasePreflight = async () => {
  if (defaultPreflightPromise) return defaultPreflightPromise;
  defaultPreflightPromise = (async () => {
    const policy = getDefaultPolicy();
    const fileState = validateDatabaseFilePolicy(policy);
    if (fileState.exists) {
      await validateExistingBusinessDatabase(policy.filename, {
        allowEmpty: policy.allowCreate && fileState.isEmpty
      });
    }
  })().catch((error) => {
    defaultPreflightPromise = null;
    throw error;
  });
  return defaultPreflightPromise;
};

export const getDatabasePath = () => getDefaultPolicy().filename;

export const getDatabasePolicy = () => ({ ...getDefaultPolicy() });

const getDb = async () => {
  await ensureDefaultDatabasePreflight();
  return getDefaultManager().getDb();
};

export const createRequestDatabaseContext = () => getDefaultManager().createRequestContext();

export const runWithRequestDatabaseContext = <T>(context: RequestDatabaseContext, callback: () => T) => (
  getDefaultManager().runWithRequestContext(context, callback)
);

export const closeRequestDatabaseContext = (context: RequestDatabaseContext) => (
  getDefaultManager().closeRequestContext(context)
);

export const withTransaction = async <T>(
  callback: (db: Database) => Promise<T>,
  mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE" = "IMMEDIATE"
) => {
  await ensureDefaultDatabasePreflight();
  return getDefaultManager().withTransaction(callback, mode);
};

export const closeDatabase = async () => {
  if (!defaultManager) return;
  await defaultManager.close();
};

export default getDb;
