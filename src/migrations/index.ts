import { DEFAULT_SELF_COGNITION_PROFILE } from "../services/selfCognitionProfileService";

// 迁移管理模块

interface Migration {
  id: string;
  name: string;
  sql?: string;
  run?: (db: any) => Promise<void>;
}

// 迁移列表
const migrations: Migration[] = [
{
    id: '20260416_001',
    name: 'Create record tables',
    sql: `
      -- 事件记录表
      CREATE TABLE IF NOT EXISTS event_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        track TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_type TEXT,
        description TEXT,
        related_object TEXT,
        impact TEXT,
        source TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- 观点记录表
      CREATE TABLE IF NOT EXISTS opinion_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        track TEXT NOT NULL,
        person_name TEXT,
        source_platform TEXT,
        opinion_date TEXT,
        validation_status TEXT,
        summary_result TEXT,
        original_opinion TEXT,
        judgment_basis TEXT,
        my_interpretation TEXT,
        validation_result TEXT,
        validation_note TEXT,
        validation_date TEXT,
        person_observation TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- 错过项目复盘表
      CREATE TABLE IF NOT EXISTS missed_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        track TEXT NOT NULL,
        project_name TEXT,
        source TEXT,
        review_date TEXT,
        miss_type TEXT,
        signal TEXT,
        reason TEXT,
        trend TEXT,
        exposed_problem TEXT,
        extracted_lesson TEXT,
        summary_conclusion TEXT,
        short_lesson TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- 买卖复盘表
      CREATE TABLE IF NOT EXISTS business_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        track TEXT NOT NULL,
        project_name TEXT,
        review_date TEXT,
        result_type TEXT,
        summary_conclusion TEXT,
        background TEXT,
        judgment_at_that_time TEXT,
        action_at_that_time TEXT,
        later_outcome TEXT,
        root_cause_type TEXT,
        exposed_problem TEXT,
        extracted_lesson TEXT,
        short_lesson TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- 挂树案例表
      CREATE TABLE IF NOT EXISTS tree_hanging_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        track TEXT NOT NULL,
        project_name TEXT,
        review_date TEXT,
        tree_type TEXT,
        summary_conclusion TEXT,
        background TEXT,
        judgment_at_that_time TEXT,
        action_at_that_time TEXT,
        later_outcome TEXT,
        root_cause_type TEXT,
        exposed_problem TEXT,
        extracted_lesson TEXT,
        short_lesson TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- 行情复盘表
      CREATE TABLE IF NOT EXISTS market_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        track TEXT NOT NULL,
        project_name TEXT,
        review_date TEXT,
        market_type_preset TEXT,
        market_type_custom TEXT,
        summary_conclusion TEXT,
        short_lesson TEXT,
        background TEXT,
        market_start TEXT,
        market_evolution TEXT,
        key_turning_points TEXT,
        later_outcome TEXT,
        exposed_problem TEXT,
        extracted_lesson TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- 规则经验表
      CREATE TABLE IF NOT EXISTS rule_experiences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        type TEXT,
        track TEXT,
        source_case TEXT,
        core_content TEXT,
        summary_conclusion TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `
  },
{
    id: '20260417_001',
    name: 'Create original price records table',
    sql: `
      -- 原始价格历史表
      CREATE TABLE IF NOT EXISTS original_price_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track TEXT NOT NULL,
        project_name TEXT NOT NULL,
        variant_name TEXT,
        original_price REAL NOT NULL,
        effective_date TEXT NOT NULL,
        source TEXT,
        reason TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `
  },
{
    id: '20260417_002',
    name: 'Update original price records table to use master data',
    sql: `
      -- 创建新表
      CREATE TABLE IF NOT EXISTS original_price_records_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        category_name TEXT NOT NULL,
        object_id INTEGER NOT NULL,
        object_name TEXT NOT NULL,
        variant_id INTEGER,
        variant_name TEXT,
        original_price REAL NOT NULL,
        effective_date TEXT NOT NULL,
        source TEXT,
        reason TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- 删除旧表
      DROP TABLE IF EXISTS original_price_records;
      
      -- 重命名新表
      ALTER TABLE original_price_records_new RENAME TO original_price_records;
    `
  },
{
    id: '20260418_001',
    name: 'Create annual plans tables',
    sql: `
      -- 年度计划主表
      CREATE TABLE IF NOT EXISTS annual_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year INTEGER NOT NULL,
        title TEXT NOT NULL,
        core_goal TEXT,
        overall_strategy TEXT,
        capital_principle TEXT,
        execution_principle TEXT,
        risk_note TEXT,
        status TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- 年度计划子项表
      CREATE TABLE IF NOT EXISTS annual_plan_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        category TEXT,
        object_name TEXT,
        role_type TEXT,
        action_type TEXT,
        reason TEXT,
        position_rule TEXT,
        exit_rule TEXT,
        priority_order INTEGER,
        status TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_id) REFERENCES annual_plans (id)
      );
    `
  },
{
    id: '20260418_002',
    name: 'Add annual plan item changes table and fields',
    run: async (db: any) => {
      await ensureMigrationColumn(db, 'annual_plan_items', 'downgrade_reason', 'TEXT');
      await ensureMigrationColumn(db, 'annual_plan_items', 'resume_condition', 'TEXT');
      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS annual_plan_item_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_item_id INTEGER NOT NULL,
        change_date TEXT NOT NULL,
        change_type TEXT,
        old_role_type TEXT,
        new_role_type TEXT,
        old_action_type TEXT,
        new_action_type TEXT,
        old_status TEXT,
        new_status TEXT,
        change_reason TEXT,
        trigger_condition TEXT,
        evidence_note TEXT,
        decision_note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_item_id) REFERENCES annual_plan_items (id)
      );
      `);
    }
  },
{
    id: '20260418_003',
    name: 'Reconstruct annual plans tables',
    sql: `
      -- 删除旧表
      DROP TABLE IF EXISTS annual_plan_item_changes;
      DROP TABLE IF EXISTS annual_plan_items;
      DROP TABLE IF EXISTS annual_plans;
      
      -- 年度计划主表
      CREATE TABLE IF NOT EXISTS annual_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year INTEGER NOT NULL,
        title TEXT NOT NULL,
        core_goal TEXT,
        overall_strategy TEXT,
        capital_principle TEXT,
        execution_principle TEXT,
        market_background TEXT,
        risk_note TEXT,
        status TEXT,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      
      -- 年度计划子项表
      CREATE TABLE IF NOT EXISTS annual_plan_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        scope_type TEXT,
        category TEXT,
        object_name TEXT,
        current_role TEXT,
        current_action TEXT,
        current_status TEXT,
        thesis TEXT,
        current_reason TEXT,
        position_rule TEXT,
        exit_rule TEXT,
        downgrade_reason TEXT,
        resume_condition TEXT,
        priority_order INTEGER,
        note TEXT,
        is_deleted INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_id) REFERENCES annual_plans (id)
      );
      
      -- 年度计划调整记录表
      CREATE TABLE IF NOT EXISTS annual_plan_item_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_item_id INTEGER NOT NULL,
        change_date TEXT NOT NULL,
        change_type TEXT,
        old_role TEXT,
        new_role TEXT,
        old_action TEXT,
        new_action TEXT,
        old_status TEXT,
        new_status TEXT,
        reason TEXT,
        trigger_condition TEXT,
        evidence_note TEXT,
        decision_note TEXT,
        next_action TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_item_id) REFERENCES annual_plan_items (id)
      );
    `
  },
{
    id: '20260423_001',
    name: 'Add ended_position_id to sell_records',
    run: async (db: any) => {
      await ensureMigrationColumn(db, 'sell_records', 'ended_position_id', 'INTEGER');
    }
  },
{
    id: '20260424_001',
    name: 'Create monitor rules table',
    sql: `
      -- 监控规则表
      CREATE TABLE IF NOT EXISTS monitor_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_code TEXT NOT NULL UNIQUE,
        rule_name TEXT NOT NULL,
        rule_type TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id INTEGER NULL,
        params_json TEXT NOT NULL,
        action_text TEXT NULL,
        description TEXT NULL,
        status TEXT NOT NULL DEFAULT 'enabled',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `
  },
{
    id: '20260425_001',
    name: 'Create abnormal monitor reads table',
    sql: `
      -- 异动监控已读表
      CREATE TABLE IF NOT EXISTS abnormal_monitor_reads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        read_key TEXT NOT NULL UNIQUE,
        target_type TEXT NOT NULL,
        category_name TEXT,
        object_name TEXT,
        variant_name TEXT,
        rule_code TEXT NOT NULL,
        effective_date TEXT NOT NULL,
        read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `
  },
{
    id: '20260425_001_seed_historical_rules',
    name: 'Seed global historical high/low monitor rules',
    sql: `
      INSERT INTO monitor_rules (
        rule_code, rule_name, rule_type, scope_type, scope_id,
        params_json, action_text, description, status, created_at, updated_at
      )
      SELECT
        'HIST_HIGH',
        '历史新高',
        'historical_new_high',
        'global',
        NULL,
        '{"scope":"all_history"}',
        '创历史新高，标记为强关注；不要机械追高，结合趋势和风险区判断。',
        '按该标的全部本地历史价格记录计算，最新价高于历史全部旧价格时触发。',
        'enabled',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      WHERE NOT EXISTS (
        SELECT 1 FROM monitor_rules
        WHERE rule_type = 'historical_new_high' AND scope_type = 'global'
      );

      INSERT INTO monitor_rules (
        rule_code, rule_name, rule_type, scope_type, scope_id,
        params_json, action_text, description, status, created_at, updated_at
      )
      SELECT
        'HIST_LOW',
        '历史新低',
        'historical_new_low',
        'global',
        NULL,
        '{"scope":"all_history"}',
        '创历史新低，标记为风险提醒；不抄底，等待结构修复。',
        '按该标的全部本地历史价格记录计算，最新价低于历史全部旧价格时触发。',
        'enabled',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      WHERE NOT EXISTS (
        SELECT 1 FROM monitor_rules
        WHERE rule_type = 'historical_new_low' AND scope_type = 'global'
      );
    `
  },
{
    id: '20260425_002',
    name: 'Add source_id to positions table',
    run: async (db: any) => {
      await ensureMigrationColumn(db, 'positions', 'source_id', 'TEXT');
    }
  },
{
    id: '20260501_007',
    name: 'Create task center tables',
    sql: `
      -- 任务中心：统一管理生意系统定时任务
      CREATE TABLE IF NOT EXISTS task_center_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        task_type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        schedule_time TEXT NOT NULL DEFAULT '16:00',
        schedule_days TEXT NOT NULL DEFAULT 'work_days',
        priority INTEGER NOT NULL DEFAULT 50,
        config_json TEXT,
        last_status TEXT NOT NULL DEFAULT 'pending',
        last_message TEXT,
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS task_center_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        task_key TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        result_json TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_task_center_tasks_enabled
      ON task_center_tasks(enabled, schedule_time);

      CREATE INDEX IF NOT EXISTS idx_task_center_runs_task
      ON task_center_runs(task_id, started_at);

    `
  },
{
    id: '20260507_001',
    name: 'Create analysis annotations',
    sql: `
      CREATE TABLE IF NOT EXISTS analysis_annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        annotation_key TEXT NOT NULL,
        annotation_value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(module, entity_type, entity_key, annotation_key)
      );

      CREATE INDEX IF NOT EXISTS idx_analysis_annotations_scope
      ON analysis_annotations(module, entity_type, annotation_key);
    `
  },
{
    id: '20260507_002',
    name: 'Create audit logs',
    sql: `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        module TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        entity_id TEXT,
        path TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp
      ON audit_logs(timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_audit_logs_module
      ON audit_logs(module, action, status);
    `
  },
{
    id: '20260507_003',
    name: 'Create user preferences',
    sql: `
      CREATE TABLE IF NOT EXISTS user_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key TEXT NOT NULL DEFAULT 'default',
        preference_key TEXT NOT NULL,
        preference_value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_key, preference_key)
      );

      CREATE INDEX IF NOT EXISTS idx_user_preferences_user_key
      ON user_preferences(user_key, preference_key);
    `
  },
{
    id: '20260507_004',
    name: 'Create rejected opportunities',
    sql: `
      CREATE TABLE IF NOT EXISTS rejected_opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        track TEXT,
        project_name TEXT,
        related_object TEXT,
        decision_date TEXT NOT NULL,
        decision_stage TEXT NOT NULL DEFAULT 'actively_rejected',
        risk_result TEXT,
        rejection_reason TEXT NOT NULL,
        information_snapshot TEXT,
        risk_rules_snapshot TEXT,
        risk_tolerance TEXT,
        execution_consistency TEXT,
        decision_quality TEXT NOT NULL DEFAULT 'valid',
        later_status TEXT NOT NULL DEFAULT 'not_tracked',
        later_summary TEXT,
        review_link TEXT,
        note TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_rejected_opportunities_decision_date
      ON rejected_opportunities(decision_date DESC);

      CREATE INDEX IF NOT EXISTS idx_rejected_opportunities_status
      ON rejected_opportunities(track, decision_quality, later_status);
    `
  },
{
    id: '20260507_006',
    name: 'Link risk control records',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'risk_check_records'))) return;
      await ensureMigrationColumn(db, 'risk_check_records', 'parent_record_id', 'INTEGER');
      await dbExec(db, `
        CREATE INDEX IF NOT EXISTS idx_risk_check_records_parent_record_id
        ON risk_check_records(parent_record_id);
      `);
    }
  },
{
    id: '20260512_002',
    name: 'Create product supply events',
    sql: `
      CREATE TABLE IF NOT EXISTS product_supply_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_name TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_date_label TEXT,
        event_type TEXT NOT NULL,
        channel_region TEXT,
        countdown_status TEXT NOT NULL DEFAULT '未记录',
        scale_note TEXT,
        date_certainty TEXT NOT NULL DEFAULT 'confirmed',
        participation_scope TEXT NOT NULL DEFAULT 'normal',
        source_note TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(product_name, event_date, event_type, channel_region)
      );

      CREATE INDEX IF NOT EXISTS idx_product_supply_events_product
      ON product_supply_events(product_name, event_date);

      CREATE INDEX IF NOT EXISTS idx_product_supply_events_event_date
      ON product_supply_events(event_date DESC);

      INSERT OR IGNORE INTO product_supply_events (
        product_name, event_date, event_date_label, event_type, channel_region,
        countdown_status, scale_note, date_certainty, participation_scope, source_note
      ) VALUES
        ('白裙子', '2024-03-08', '2024-03-08', '首发', '小程序送到家', '未记录', '单价159', 'confirmed', 'normal', '用户迁移样板'),
        ('白裙子', '2025-10-12', '2025-10-12', '补货', '新加坡、泰国', '未记录', '天量', 'confirmed', 'normal', '用户迁移样板'),
        ('大春花', '2024-03-08', '2024-03-08', '首发', '小程序送到家', '未记录', '单价499', 'confirmed', 'normal', '用户迁移样板'),
        ('大春花', '2025-10-12', '2025-10-12', '补货', '新加坡、泰国', '未记录', '天量', 'confirmed', 'normal', '用户迁移样板'),
        ('大小甜心', '2025-01-20', '2025-01-20', '首次记录/供给', '小程序送到家', '未记录', '单价399/99', 'confirmed', 'normal', '按迁移注意，暂不强写首发'),
        ('大小甜心', '2025-02-20', '2025-02-20', '补货', '小程序送到家', '未记录', '距上次31天', 'confirmed', 'normal', '用户迁移样板'),
        ('大小甜心', '2025-03-27', '2025-03-27', '补货', '小程序送到家', '未记录', '距上次35天', 'confirmed', 'normal', '用户迁移样板'),
        ('大小甜心', '2025-04-17', '2025-04-17', '补货', '小程序送到家', '未记录', '距上次21天', 'confirmed', 'normal', '用户迁移样板'),
        ('大小甜心', '2025-05-13', '2025-05-13', '补货', '小程序送到家', '未记录', '距上次26天', 'confirmed', 'normal', '用户迁移样板'),
        ('大小甜心', '2025-05-28', '2025-05-28', '补货', '小程序送到家', '未记录', '距上次15天', 'confirmed', 'normal', '用户迁移样板'),
        ('大小甜心', '2025-10-12', '2025-10-12', '补货', '新加坡、泰国', '未记录', '天量，距上次137天', 'confirmed', 'normal', '用户迁移样板'),
        ('大小甜心', '2025-12-25', '2025-12-25', '补货', '小程序送到家', '未记录', '距上次74天', 'confirmed', 'normal', '用户迁移样板'),
        ('大小甜心', '2026-01-19', '2026-01-19', '补货', '小程序送到家', '未记录', '距上次25天', 'confirmed', 'normal', '用户迁移样板'),
        ('大小甜心', '2026-02-03', '2026-02-03', '补货', '小程序送到家', '未记录', '距上次15天，春节前补货', 'confirmed', 'normal', '用户迁移样板'),
        ('毛球mokoko', '2025-10-09', '2025-10-09', '首发', '小程序送到家', '未记录', '单价199', 'confirmed', 'normal', '用户迁移样板'),
        ('毛球mokoko', '2025-10-12', '2025-10-12', '补货', '新加坡、泰国', '未记录', '天量，距首发3天', 'confirmed', 'normal', '用户迁移样板'),
        ('毛球mokoko', '2025-12-25', '2025-12-25左右', '补货', '国内', '未记录', '日期不完全确定，按回忆暂记', 'estimated', 'normal', '日期不完全确定'),
        ('晒晒', '2025-08-21', '2025-08-21', '首发', '小程序送到家', '未记录', '单价199', 'confirmed', 'normal', '用户迁移样板'),
        ('晒晒', '2025-10-12', '2025-10-12', '补货', '新加坡、泰国', '未记录', '天量，距首发52天', 'confirmed', 'normal', '用户迁移样板'),
        ('闪闪', '2024-11-28', '2024-11-28', '首发', '小程序送到家', '未记录', '单价159', 'confirmed', 'normal', '用户迁移样板'),
        ('闪闪', '2025-10-12', '2025-10-12', '补货', '新加坡、泰国', '未记录', '天量，距首发318天；中间国内是否补过不确定', 'confirmed', 'normal', '中间国内补货未确认'),
        ('圣诞mokoko', '2025-10-27', '2025-10-27', '首发/节日前供给', '小程序送到家', '未记录', '单价199，节日附近补', 'confirmed', 'normal', '用户迁移样板'),
        ('圣诞mokoko', '2025-11-01', '2025-11-01', '补货', '小程序送到家', '未记录', '距上次4天', 'confirmed', 'normal', '用户迁移样板'),
        ('醒醒', '2026-03-05', '2026-03-05', '首发', '小程序送到家', '未记录', '发售价499', 'confirmed', 'normal', '用户迁移样板'),
        ('醒醒', '2026-03-18', '2026-03-18', '补货', '国内送到家', '无倒计时', '突袭补货', 'confirmed', 'normal', '用户迁移样板'),
        ('醒醒', '2026-04-23T10:00:00', '2026-04-23 10:00', '补货', '国内送到家', '有倒计时', '量暂时看不出来', 'confirmed', 'normal', '用户迁移样板'),
        ('mokoko美人鱼', '2026-04-29', '2026-04-29', '首发', '送到家', '有倒计时', '量不大；低开后被人为拉盘暴涨', 'confirmed', 'record_only', '当前只记录，不参与买卖判断'),
        ('mokoko美人鱼', '2026-05-10', '2026-05-10', '补货', '送到家', '有倒计时', '量不大；补后价格被砸下去；当前只记录不参与', 'confirmed', 'record_only', '当前只记录，不参与买卖判断');
    `
  },
{
    id: '20260512_003',
    name: 'Create product supply products',
    sql: `
      CREATE TABLE IF NOT EXISTS product_supply_products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_name TEXT NOT NULL UNIQUE,
        product_note TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_product_supply_products_name
      ON product_supply_products(product_name);

      INSERT OR IGNORE INTO product_supply_products (product_name, product_note)
      SELECT DISTINCT product_name, '由补货时间线历史事件自动生成'
      FROM product_supply_events
      WHERE is_deleted = 0;
    `
  },
{
    id: '20260515_003_rejected_opportunity_review_category',
    name: 'Add review category to rejected opportunities',
    run: async (db: any) => {
      await ensureMigrationColumn(db, 'rejected_opportunities', 'review_category', "TEXT NOT NULL DEFAULT 'correct_reject'");
      await dbExec(db, `
        CREATE INDEX IF NOT EXISTS idx_rejected_opportunities_review_category
        ON rejected_opportunities(review_category, decision_quality, later_status);
      `);
    }
  },
{
    id: '20260516_002_iphone_price_task',
    name: 'Add iPhone commodity price update task',
    sql: `
      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'iphone_price_update',
          '苹果手机价格更新',
          'price',
          'iphone_price_update',
          1,
          '17:45',
          'every_day',
          33,
          '{"category":"苹果手机"}',
          'pending',
          '每天抓取德璜档口报价，仅写入系统已启用的苹果手机型号/颜色'
        );

      UPDATE task_center_tasks
      SET task_type = 'iphone_price_update',
          domain = 'price',
          schedule_time = CASE WHEN schedule_time IS NULL OR schedule_time = '' THEN '17:45' ELSE schedule_time END,
          schedule_days = 'every_day',
          config_json = CASE
            WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN '{"category":"苹果手机"}'
            ELSE config_json
          END,
          last_message = '每天抓取德璜档口报价，仅写入系统已启用的苹果手机型号/颜色',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'iphone_price_update';
    `
  },
{
    id: '20260516_003_video_game_machine_price_task',
    name: 'Add video game machine commodity price update task',
    sql: `
      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'video_game_machine_price_update',
          '游戏机价格更新',
          'price',
          'video_game_machine_price_update',
          1,
          '18:00',
          'every_day',
          34,
          '{"category":"游戏机"}',
          'pending',
          '每天抓取游戏机档口报价，仅写入系统已启用的游戏机型号'
        );

      UPDATE task_center_tasks
      SET task_type = 'video_game_machine_price_update',
          domain = 'price',
          schedule_time = CASE WHEN schedule_time IS NULL OR schedule_time = '' THEN '18:00' ELSE schedule_time END,
          schedule_days = 'every_day',
          config_json = CASE
            WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN '{"category":"游戏机"}'
            ELSE config_json
          END,
          last_message = '每天抓取游戏机档口报价，仅写入系统已启用的游戏机型号',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'video_game_machine_price_update';
    `
  },
{
    id: '20260516_004_popmart_price_task',
    name: 'Add Pop Mart commodity price update task',
    sql: `
      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'popmart_price_update',
          '泡泡玛特价格更新',
          'price',
          'popmart_price_update',
          1,
          '18:15',
          'every_day',
          35,
          '{"category":"泡泡玛特"}',
          'pending',
          '每天抓取千岛泡泡玛特价格，仅写入系统已启用且已确认映射的对象'
        );

      UPDATE task_center_tasks
      SET task_type = 'popmart_price_update',
          domain = 'price',
          schedule_time = CASE WHEN schedule_time IS NULL OR schedule_time = '' THEN '18:15' ELSE schedule_time END,
          schedule_days = 'every_day',
          config_json = CASE
            WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN '{"category":"泡泡玛特"}'
            ELSE config_json
          END,
          last_message = '每天抓取千岛泡泡玛特价格，仅写入系统已启用且已确认映射的对象',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'popmart_price_update';
    `
  },
{
    id: '20260525_003_normalize_task_timestamps',
    name: 'Normalize task center timestamps',
    run: async (db) => {
      const normalizeTimestampColumns = async (tableName: string, columnNames: string[]) => {
        const table = await dbGet<any>(
          db,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          [tableName]
        );
        if (!table) return;

        const columns = await dbAll<any>(db, `PRAGMA table_info(${quoteMigrationIdentifier(tableName)})`);
        const existingColumns = new Set(columns.map((column: any) => String(column.name)));
        for (const columnName of columnNames) {
          if (!existingColumns.has(columnName)) continue;
          const quotedColumn = quoteMigrationIdentifier(columnName);
          await dbRun(
            db,
            `UPDATE ${quoteMigrationIdentifier(tableName)}
             SET ${quotedColumn} = strftime('%Y-%m-%dT%H:%M:%fZ', REPLACE(REPLACE(${quotedColumn}, 'T', ' '), 'Z', ''))
             WHERE ${quotedColumn} IS NOT NULL
               AND TRIM(${quotedColumn}) != ''
               AND datetime(REPLACE(REPLACE(${quotedColumn}, 'T', ' '), 'Z', '')) IS NOT NULL
               AND (${quotedColumn} NOT LIKE '%T%' OR ${quotedColumn} NOT LIKE '%Z')`
          );
        }
      };

      await normalizeTimestampColumns('task_center_runs', ['started_at', 'finished_at', 'created_at']);
      await normalizeTimestampColumns('task_center_tasks', ['last_run_at', 'next_run_at', 'created_at', 'updated_at']);
      await dbExec(db, `
        CREATE INDEX IF NOT EXISTS idx_task_center_runs_task_started_at_normalized
        ON task_center_runs(task_key, started_at DESC, id DESC);
      `);
    }
  },
{
    id: '20260525_005_shared_table_workspaces',
    name: 'Set business workspace on task and todo tables',
    run: async (db: any) => {
      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS manual_todos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          priority TEXT NOT NULL,
          status TEXT NOT NULL,
          due_date TEXT,
          note TEXT,
          domain TEXT NOT NULL DEFAULT 'business',
          workspace TEXT NOT NULL DEFAULT 'business',
          track TEXT,
          type TEXT DEFAULT 'manual',
          market_type_preset TEXT DEFAULT 'standard',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await ensureMigrationColumn(db, 'task_center_tasks', 'workspace', "TEXT NOT NULL DEFAULT 'business'");
      await ensureMigrationColumn(db, 'task_center_runs', 'domain', 'TEXT');
      await ensureMigrationColumn(db, 'task_center_runs', 'workspace', "TEXT NOT NULL DEFAULT 'business'");
      await ensureMigrationColumn(db, 'manual_todos', 'domain', "TEXT NOT NULL DEFAULT 'business'");
      await ensureMigrationColumn(db, 'manual_todos', 'workspace', "TEXT NOT NULL DEFAULT 'business'");

      await dbExec(db, `
        UPDATE task_center_tasks
        SET workspace = 'business'
        WHERE workspace IS NULL OR workspace = '';

        UPDATE task_center_runs
        SET domain = COALESCE(
              NULLIF((
                SELECT t.domain
                FROM task_center_tasks t
                WHERE t.id = task_center_runs.task_id
                LIMIT 1
              ), ''),
              NULLIF(domain, ''),
              'business'
            ),
            workspace = 'business'
        WHERE EXISTS (
          SELECT 1 FROM task_center_tasks t WHERE t.id = task_center_runs.task_id
        );

        UPDATE task_center_runs
        SET domain = COALESCE(
              NULLIF((
                SELECT t.domain
                FROM task_center_tasks t
                WHERE t.task_key = task_center_runs.task_key
                LIMIT 1
              ), ''),
              NULLIF(domain, ''),
              'business'
            ),
            workspace = 'business'
        WHERE EXISTS (
          SELECT 1 FROM task_center_tasks t WHERE t.task_key = task_center_runs.task_key
        );

        UPDATE task_center_runs
        SET domain = COALESCE(NULLIF(domain, ''), 'business'),
            workspace = 'business'
        WHERE workspace IS NULL OR workspace = '';

        UPDATE manual_todos
        SET domain = COALESCE(NULLIF(domain, ''), 'business'),
            workspace = 'business'
        WHERE workspace IS NULL OR workspace = '';

        CREATE INDEX IF NOT EXISTS idx_task_center_tasks_workspace_schedule
        ON task_center_tasks(workspace, enabled, schedule_time, priority);

        CREATE INDEX IF NOT EXISTS idx_task_center_runs_workspace_started
        ON task_center_runs(workspace, started_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_manual_todos_workspace_status
        ON manual_todos(workspace, status, updated_at DESC);
      `);
    }
  },
{
    id: '20260525_006_audit_log_workspaces',
    name: 'Set business workspace on audit logs',
    run: async (db: any) => {
      await ensureMigrationColumn(db, 'audit_logs', 'domain', "TEXT NOT NULL DEFAULT 'business'");
      await ensureMigrationColumn(db, 'audit_logs', 'workspace', "TEXT NOT NULL DEFAULT 'business'");

      await dbExec(db, `
        UPDATE audit_logs
        SET domain = COALESCE(NULLIF(domain, ''), 'business'),
            workspace = 'business'
        WHERE workspace IS NULL OR workspace = '';

        CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace_timestamp
        ON audit_logs(workspace, timestamp DESC, created_at DESC);
      `);
    }
  },
{
    id: '20260526_001_workspace_tags',
    name: 'Create workspace scoped tags',
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        domain TEXT NOT NULL DEFAULT 'business',
        workspace TEXT NOT NULL DEFAULT 'business',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(workspace, name)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_tags_workspace_name
      ON workspace_tags(workspace, name);
    `
  },
{
    id: '20260530_001_remove_non_business_task_seed_residue',
    name: 'Remove non-business task seeds from business task center',
    sql: `
      DELETE FROM task_center_runs
      WHERE task_key IN ('metals_daily_update', 'lottery_daily_update')
         OR task_id IN (
           SELECT id FROM task_center_tasks
           WHERE task_key IN ('metals_daily_update', 'lottery_daily_update')
         );

      DELETE FROM task_center_tasks
      WHERE task_key IN ('metals_daily_update', 'lottery_daily_update');
    `
  },
{
    id: '20260530_002_remove_skipped_business_migration_markers',
    name: 'Remove skipped trading migration markers from business DB',
    sql: `
      DELETE FROM migrations
      WHERE name LIKE '[skipped:business] %';
    `
  },
{
    id: '20260530_003_remove_commodity_metals_task_from_business_db',
    name: 'No-op: commodity metals task belongs to business task center',
    sql: `
      SELECT 1;
    `
  },
{
    id: '20260530_004_rename_product_supply_participation_scope',
    name: 'Rename product supply participation scope',
    run: async (db: any) => {
      const columns = await dbAll<any>(db, 'PRAGMA table_info(product_supply_events)');
      const columnNames = new Set(columns.map((column: any) => String(column.name)));
      if (columnNames.has('trading_scope') && !columnNames.has('participation_scope')) {
        await dbExec(db, 'ALTER TABLE product_supply_events RENAME COLUMN trading_scope TO participation_scope');
      } else if (!columnNames.has('participation_scope')) {
        await dbExec(db, "ALTER TABLE product_supply_events ADD COLUMN participation_scope TEXT NOT NULL DEFAULT 'normal'");
      } else if (columnNames.has('trading_scope')) {
        await dbExec(db, `
          UPDATE product_supply_events
          SET participation_scope = COALESCE(NULLIF(participation_scope, ''), trading_scope, 'normal')
          WHERE participation_scope IS NULL OR participation_scope = '';
        `);
      }

      await dbExec(db, `
        UPDATE product_supply_events
        SET source_note = REPLACE(source_note, '当前只记录不参与交易', '当前只记录，不参与买卖判断'),
            updated_at = CURRENT_TIMESTAMP
        WHERE source_note LIKE '%当前只记录不参与交易%';
      `);
    }
  },
{
    id: '20260530_005_rename_trade_reviews_to_business_reviews',
    name: 'Rename trade reviews to business reviews',
    run: async (db: any) => {
      const oldTable = await dbGet<any>(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['trade_reviews']
      );
      const newTable = await dbGet<any>(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['business_reviews']
      );

      if (oldTable && !newTable) {
        await dbExec(db, 'ALTER TABLE trade_reviews RENAME TO business_reviews');
      } else if (!newTable) {
        await dbExec(db, `
          CREATE TABLE IF NOT EXISTS business_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            track TEXT NOT NULL,
            project_name TEXT,
            review_date TEXT,
            result_type TEXT,
            summary_conclusion TEXT,
            background TEXT,
            judgment_at_that_time TEXT,
            action_at_that_time TEXT,
            later_outcome TEXT,
            root_cause_type TEXT,
            exposed_problem TEXT,
            extracted_lesson TEXT,
            short_lesson TEXT,
            note TEXT,
            is_deleted INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
        `);
      }
    }
  },
{
    id: '20260530_006_normalize_task_center_work_days',
    name: 'Normalize task center work day schedule',
    sql: `
      UPDATE task_center_tasks
      SET schedule_days = 'work_days',
          updated_at = CURRENT_TIMESTAMP
      WHERE schedule_days = 'trade_days';
    `
  },
  {
    id: '20260530_007_normalize_annual_plan_change_columns',
    name: 'Normalize annual plan change columns',
    run: async (db: any) => {
      const table = await dbGet<any>(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['annual_plan_item_changes']
      );
      if (!table) return;

      await ensureMigrationColumn(db, 'annual_plan_item_changes', 'old_role', 'TEXT');
      await ensureMigrationColumn(db, 'annual_plan_item_changes', 'new_role', 'TEXT');
      await ensureMigrationColumn(db, 'annual_plan_item_changes', 'old_action', 'TEXT');
      await ensureMigrationColumn(db, 'annual_plan_item_changes', 'new_action', 'TEXT');
      await ensureMigrationColumn(db, 'annual_plan_item_changes', 'reason', 'TEXT');
      await ensureMigrationColumn(db, 'annual_plan_item_changes', 'next_action', 'TEXT');

      const columns = await dbAll<any>(db, 'PRAGMA table_info(annual_plan_item_changes)');
      const columnNames = new Set(columns.map((column: any) => String(column.name)));
      const copyPairs: Array<[string, string]> = [
        ['old_role_type', 'old_role'],
        ['new_role_type', 'new_role'],
        ['old_action_type', 'old_action'],
        ['new_action_type', 'new_action'],
        ['change_reason', 'reason']
      ];

      for (const [fromColumn, toColumn] of copyPairs) {
        if (!columnNames.has(fromColumn) || !columnNames.has(toColumn)) continue;
        await dbExec(db, `
          UPDATE annual_plan_item_changes
          SET ${toColumn} = COALESCE(NULLIF(${toColumn}, ''), ${fromColumn})
          WHERE ${toColumn} IS NULL OR ${toColumn} = '';
        `);
      }
    }
  },
  {
    id: '20260530_008_enforce_single_active_annual_plan',
    name: 'Enforce single active annual plan per year',
    sql: `
      UPDATE annual_plans
      SET status = '已归档',
          updated_at = CURRENT_TIMESTAMP
      WHERE is_deleted = 0
        AND status = '生效中'
        AND id NOT IN (
          SELECT keep_id FROM (
            SELECT year, MAX(id) AS keep_id
            FROM annual_plans
            WHERE is_deleted = 0 AND status = '生效中'
            GROUP BY year
          )
        );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_annual_plans_active_year
      ON annual_plans(year)
      WHERE is_deleted = 0 AND status = '生效中';
    `
  },
  {
    id: '20260530_009_clean_business_task_center_runtime_config',
    name: 'Clean business task center runtime config',
    run: async (db: any) => {
      const table = await dbGet<any>(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['task_center_tasks']
      );
      if (!table) return;

      const obsoleteTaskKeys = [
        'metals_daily_update',
        'lottery_daily_update'
      ];
      const placeholders = obsoleteTaskKeys.map(() => '?').join(', ');
      const runsTable = await dbGet<any>(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['task_center_runs']
      );
      if (runsTable) {
        await dbRun(
          db,
          `DELETE FROM task_center_runs
           WHERE task_key IN (${placeholders})
              OR task_id IN (
                SELECT id FROM task_center_tasks WHERE task_key IN (${placeholders})
              )`,
          [...obsoleteTaskKeys, ...obsoleteTaskKeys]
        );
      }
      await dbRun(
        db,
        `DELETE FROM task_center_tasks WHERE task_key IN (${placeholders})`,
        obsoleteTaskKeys
      );

      const rows = await dbAll<any>(
        db,
        `SELECT id, config_json
         FROM task_center_tasks
         WHERE config_json LIKE '%"db"%'
            OR config_json LIKE '%db_path%'
            OR config_json LIKE '%database_path%'
            OR config_json LIKE '%/Volumes%'
            OR config_json LIKE '%7100%'`
      );
      const runtimePathKeys = ['db', 'db_path', 'database_path'];
      for (const row of rows) {
        let config: Record<string, any>;
        try {
          config = JSON.parse(String(row.config_json || '{}'));
        } catch {
          continue;
        }
        let changed = false;
        for (const key of runtimePathKeys) {
          if (Object.prototype.hasOwnProperty.call(config, key)) {
            delete config[key];
            changed = true;
          }
        }
        if (!changed) continue;
        await dbRun(
          db,
          `UPDATE task_center_tasks
           SET config_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [JSON.stringify(config), row.id]
        );
      }
    }
  },
  {
    id: '20260530_010_restore_commodity_metals_price_task',
    name: 'Restore commodity metals price update task',
    sql: `
      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, workspace, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'commodity_metals_price_update',
          '商品贵金属价格更新',
          'price',
          'business',
          'commodity_metals_price_update',
          1,
          '17:35',
          'every_day',
          32,
          '{"targets":["黄金9999","白银"]}',
          'pending',
          '每天抓取德璜小程序黄金/白银价格，并写入商品价格工作台；黄金按整数，白银保留一位小数'
        );

      UPDATE task_center_tasks
      SET name = '商品贵金属价格更新',
          task_type = 'commodity_metals_price_update',
          domain = 'price',
          workspace = 'business',
          enabled = 1,
          schedule_time = CASE WHEN schedule_time IS NULL OR schedule_time = '' THEN '17:35' ELSE schedule_time END,
          schedule_days = 'every_day',
          priority = 32,
          config_json = CASE
            WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN '{"targets":["黄金9999","白银"]}'
            ELSE config_json
          END,
          last_message = '每天抓取德璜小程序黄金/白银价格，并写入商品价格工作台；黄金按整数，白银保留一位小数',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'commodity_metals_price_update';
    `
  },
  {
    id: '20260530_011_create_source_mappings',
    name: 'Create source mappings',
    run: async (db: any) => {
      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS source_mappings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_key TEXT NOT NULL,
          source_name TEXT NOT NULL,
          external_key TEXT NOT NULL,
          external_name TEXT,
          external_meta_json TEXT,
          category_id INTEGER,
          object_id INTEGER,
          variant_id INTEGER NOT NULL DEFAULT 0,
          category_name TEXT,
          object_name TEXT,
          variant_name TEXT,
          status TEXT NOT NULL DEFAULT 'enabled',
          last_seen_at TEXT,
          last_matched_at TEXT,
          last_error TEXT,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source_key, external_key)
        );

        CREATE INDEX IF NOT EXISTS idx_source_mappings_source_status
          ON source_mappings(source_key, status);

        CREATE INDEX IF NOT EXISTS idx_source_mappings_target
          ON source_mappings(category_id, object_id, variant_id);
      `);

      const rows = [
        {
          source_key: 'dehuang_metals',
          source_name: '德璜小程序贵金属',
          external_key: '黄金9999',
          external_name: '黄金9999',
          category_name: '贵金属',
          object_name: '黄金',
          variant_name: '',
          external_meta_json: { digits: 0 }
        },
        {
          source_key: 'dehuang_metals',
          source_name: '德璜小程序贵金属',
          external_key: '白银',
          external_name: '白银',
          category_name: '贵金属',
          object_name: '白银',
          variant_name: '',
          external_meta_json: { digits: 1 }
        },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '929006833488630705', external_name: 'XG限定', category_name: '泡泡玛特', object_name: 'XG限定', variant_name: '', external_meta_json: { query: 'XG限定', spu_id: '929006833488630705' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '789523968431240995', external_name: 'Magic of Pumpkin', category_name: '泡泡玛特', object_name: '万圣节', variant_name: '', external_meta_json: { query: 'Magic of Pumpkin', spu_id: '789523968431240995' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '875239228831738922', external_name: '向往之处', category_name: '泡泡玛特', object_name: '嘎子姐', variant_name: '', external_meta_json: { query: '向往之处', spu_id: '875239228831738922' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '704852597684613737', external_name: 'MOKOKO 春花', category_name: '泡泡玛特', object_name: '大春花', variant_name: '', external_meta_json: { query: 'MOKOKO 春花', spu_id: '704852597684613737' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '675597453717760702', external_name: '大甜心', category_name: '泡泡玛特', object_name: '大甜心', variant_name: '', external_meta_json: { query: '大甜心', spu_id: '675597453717760702' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '778075948925892646', external_name: '大米兰', category_name: '泡泡玛特', object_name: '大米兰', variant_name: '', external_meta_json: { query: '大米兰', spu_id: '778075948925892646' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '927988138113005044', external_name: '姜饼人1/8', category_name: '泡泡玛特', object_name: '姜饼人', variant_name: '', external_meta_json: { query: '姜饼人1/8', spu_id: '927988138113005044' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '672953785382971923', external_name: '小甜心', category_name: '泡泡玛特', object_name: '小甜心', variant_name: '', external_meta_json: { query: '小甜心', spu_id: '672953785382971923' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '681855448701274650', external_name: 'Catch Me If You Like Me', category_name: '泡泡玛特', object_name: '情人节', variant_name: '', external_meta_json: { query: 'Catch Me If You Like Me', spu_id: '681855448701274650' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '650794262396462371', external_name: '拿铁', category_name: '泡泡玛特', object_name: '拿铁', variant_name: '', external_meta_json: { query: '拿铁', spu_id: '650794262396462371' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '954718264364114252', external_name: '星星人礼盒', category_name: '泡泡玛特', object_name: '星星人礼盒', variant_name: '', external_meta_json: { query: '星星人礼盒', spu_id: '954718264364114252' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '897177903526088129', external_name: '晒晒', category_name: '泡泡玛特', object_name: '晒晒', variant_name: '', external_meta_json: { query: '晒晒', spu_id: '897177903526088129' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '915985249635145047', external_name: '毛球', category_name: '泡泡玛特', object_name: '毛球', variant_name: '', external_meta_json: { query: '毛球', spu_id: '915985249635145047' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '704906800172085180', external_name: 'FALL INTO SPRING', category_name: '泡泡玛特', object_name: '白裙子', variant_name: '', external_meta_json: { query: 'FALL INTO SPRING', spu_id: '704906800172085180' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '740254741795247881', external_name: 'The Blue Diamond', category_name: '泡泡玛特', object_name: '蓝裙子', variant_name: '', external_meta_json: { query: 'The Blue Diamond', spu_id: '740254741795247881' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '970617028555622512', external_name: '醒醒', category_name: '泡泡玛特', object_name: '醒醒', variant_name: '', external_meta_json: { query: '醒醒', spu_id: '970617028555622512' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '801090280999627960', external_name: '闪闪', category_name: '泡泡玛特', object_name: '闪闪', variant_name: '', external_meta_json: { query: '闪闪', spu_id: '801090280999627960' } },
        { source_key: 'qiandao_popmart', source_name: '千岛泡泡玛特', external_key: '593651152747287737', external_name: 'JUMP FOR JOY', category_name: '泡泡玛特', object_name: '飞行员', variant_name: '', external_meta_json: { query: 'JUMP FOR JOY', spu_id: '593651152747287737' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '任天堂|日版OLED|红蓝', external_name: 'Switch OLED日版红蓝', category_name: '游戏机', object_name: 'Switch OLED日版红蓝', variant_name: '', external_meta_json: { brand: '任天堂', name: '日版OLED', key: '红蓝' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '任天堂|日版OLED|白色', external_name: 'Switch OLED日版黑白', category_name: '游戏机', object_name: 'Switch OLED日版黑白', variant_name: '', external_meta_json: { brand: '任天堂', name: '日版OLED', key: '白色' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '任天堂|日版续航|灰色', external_name: 'Switch日版续航灰', category_name: '游戏机', object_name: 'Switch日版续航灰', variant_name: '', external_meta_json: { brand: '任天堂', name: '日版续航', key: '灰色' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '任天堂|日版续航|红蓝', external_name: 'Switch日版续航红蓝', category_name: '游戏机', object_name: 'Switch日版续航红蓝', variant_name: '', external_meta_json: { brand: '任天堂', name: '日版续航', key: '红蓝' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '任天堂|港版OLED|红蓝', external_name: 'Switch OLED港版红蓝', category_name: '游戏机', object_name: 'Switch OLED港版红蓝', variant_name: '', external_meta_json: { brand: '任天堂', name: '港版OLED', key: '红蓝' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '任天堂|港版OLED|白色', external_name: 'Switch OLED港版黑白', category_name: '游戏机', object_name: 'Switch OLED港版黑白', variant_name: '', external_meta_json: { brand: '任天堂', name: '港版OLED', key: '白色' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '任天堂|Switch2港版LCD|单机标准版', external_name: 'NS2港版单机原盒', category_name: '游戏机', object_name: 'NS2港版单机原盒', variant_name: '', external_meta_json: { brand: '任天堂', name: 'Switch2港版LCD', key: '单机标准版' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '任天堂|Switch2港版LCD|马里奥赛车世界套装', external_name: 'NS2港版捆绑马车同捆', category_name: '游戏机', object_name: 'NS2港版捆绑马车同捆', variant_name: '', external_meta_json: { brand: '任天堂', name: 'Switch2港版LCD', key: '马里奥赛车世界套装' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '任天堂|Switch2新加坡版|单机', external_name: 'NS2新加坡单机原盒', category_name: '游戏机', object_name: 'NS2新加坡单机原盒', variant_name: '', external_meta_json: { brand: '任天堂', name: 'Switch2新加坡版', key: '单机' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '任天堂|Switch2新加坡版|马里奥套装', external_name: 'NS2新加坡同捆', category_name: '游戏机', object_name: 'NS2新加坡同捆', variant_name: '', external_meta_json: { brand: '任天堂', name: 'Switch2新加坡版', key: '马里奥套装' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '索尼|PS5国行|光驱Slim', external_name: 'PS5国行光驱slim', category_name: '游戏机', object_name: 'PS5国行光驱slim', variant_name: '', external_meta_json: { brand: '索尼', name: 'PS5国行', key: '光驱Slim' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '索尼|PS5国行|数字Slim', external_name: 'PS5国行数字slim', category_name: '游戏机', object_name: 'PS5国行数字slim', variant_name: '', external_meta_json: { brand: '索尼', name: 'PS5国行', key: '数字Slim' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '索尼|PS5国行|PRO数字', external_name: 'PS5 Pro国行数字', category_name: '游戏机', object_name: 'PS5 Pro国行数字', variant_name: '', external_meta_json: { brand: '索尼', name: 'PS5国行', key: 'PRO数字' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '索尼|PS5日版|光驱Slim', external_name: 'PS5日版光驱slim', category_name: '游戏机', object_name: 'PS5日版光驱slim', variant_name: '', external_meta_json: { brand: '索尼', name: 'PS5日版', key: '光驱Slim' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '索尼|PS5日版|数字Slim', external_name: 'PS5日版数字slim', category_name: '游戏机', object_name: 'PS5日版数字slim', variant_name: '', external_meta_json: { brand: '索尼', name: 'PS5日版', key: '数字Slim' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '索尼|PS5日版|PRO数字', external_name: 'PS5 Pro日版数字', category_name: '游戏机', object_name: 'PS5 Pro日版数字', variant_name: '', external_meta_json: { brand: '索尼', name: 'PS5日版', key: 'PRO数字' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '索尼|PS5港版|光驱Slim', external_name: 'PS5港版光驱slim', category_name: '游戏机', object_name: 'PS5港版光驱slim', variant_name: '', external_meta_json: { brand: '索尼', name: 'PS5港版', key: '光驱Slim' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '索尼|PS5港版|数字Slim', external_name: 'PS5港版数字', category_name: '游戏机', object_name: 'PS5港版数字', variant_name: '', external_meta_json: { brand: '索尼', name: 'PS5港版', key: '数字Slim' } },
        { source_key: 'dongxu_game_console', source_name: '东旭游戏机档口', external_key: '索尼|PS5港版|PRO数字', external_name: 'PS5 Pro港版数字', category_name: '游戏机', object_name: 'PS5 Pro港版数字', variant_name: '', external_meta_json: { brand: '索尼', name: 'PS5港版', key: 'PRO数字' } }
      ];

      for (const row of rows) {
        const category = await dbGet<any>(
          db,
          "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
          [row.category_name]
        );
        const object = category
          ? await dbGet<any>(
            db,
            "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
            [category.id, row.object_name]
          )
          : null;
        const variant = object && row.variant_name
          ? await dbGet<any>(
            db,
            "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
            [object.id, row.variant_name]
          )
          : null;
        const status = category && object && (!row.variant_name || variant) ? 'enabled' : 'unmapped';
        await dbRun(
          db,
          `INSERT OR IGNORE INTO source_mappings
             (source_key, source_name, external_key, external_name, external_meta_json,
              category_id, object_id, variant_id, category_name, object_name, variant_name,
              status, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.source_key,
            row.source_name,
            row.external_key,
            row.external_name,
            JSON.stringify(row.external_meta_json || {}),
            category?.id || null,
            object?.id || null,
            variant?.id || 0,
            category?.name || row.category_name,
            object?.name || row.object_name,
            variant?.name || row.variant_name || '',
            status,
            status === 'enabled' ? '' : '初始化时未找到对应主数据，请在数据源映射页面确认'
          ]
        );
      }
    }
  },
  {
    id: '20260530_012_add_annual_plan_soft_links',
    name: 'Add annual plan soft links',
    run: async (db: any) => {
      const addAnnualPlanLink = async (tableName: string, indexName: string) => {
        if (!(await migrationTableExists(db, tableName))) return;
        await ensureMigrationColumn(db, tableName, 'annual_plan_item_id', 'INTEGER');
        await dbExec(
          db,
          `CREATE INDEX IF NOT EXISTS ${quoteMigrationIdentifier(indexName)}
           ON ${quoteMigrationIdentifier(tableName)}(annual_plan_item_id);`
        );
      };

      await addAnnualPlanLink('buying_plans', 'idx_buying_plans_annual_plan_item');
      await addAnnualPlanLink('selling_plans', 'idx_selling_plans_annual_plan_item');
      await addAnnualPlanLink('watchlist_items', 'idx_watchlist_items_annual_plan_item');
      await addAnnualPlanLink('business_reviews', 'idx_business_reviews_annual_plan_item');
    }
  },
  {
    id: '20260531_001_create_category_profiles',
    name: 'Create category profiles',
    run: async (db: any) => {
      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS category_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category_id INTEGER,
          category_name TEXT NOT NULL,
          object_name TEXT,
          variant_name TEXT,
          business_style TEXT,
          operation_scene TEXT,
          supply_mode TEXT,
          sales_mode TEXT,
          price_pattern TEXT,
          risk_points TEXT,
          operating_discipline TEXT,
          data_caliber TEXT,
          experience_notes TEXT,
          decision_notes TEXT,
          extra_json TEXT DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'active',
          note TEXT,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_category_profiles_category
          ON category_profiles(category_id, category_name, status, is_deleted);

        CREATE INDEX IF NOT EXISTS idx_category_profiles_object
          ON category_profiles(category_name, object_name, variant_name, status, is_deleted);
      `);
    }
  },
  {
    id: '20260531_002_create_price_quality_alert_reviews',
    name: 'Create price quality alert review states',
    run: async (db: any) => {
      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS price_quality_alert_reviews (
          alert_key TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          note TEXT,
          reviewed_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_price_records_series_date
          ON price_records(category, object_name, variant, date, id);

        CREATE INDEX IF NOT EXISTS idx_price_quality_alert_reviews_status
          ON price_quality_alert_reviews(status, updated_at DESC);
      `);
    }
  },
  {
    id: '20260531_003_seed_longchao_source_mapping',
    name: 'Seed Longchao source mapping',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'source_mappings'))) return;

      const category = await dbGet<any>(
        db,
        "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
        ['纪念钞']
      );
      const object = category
        ? await dbGet<any>(
          db,
          "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [category.id, '龙钞']
        )
        : null;
      const variant = object
        ? await dbGet<any>(
          db,
          "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [object.id, '散张']
        )
        : null;
      const status = category && object && variant ? 'enabled' : 'unmapped';

      await dbRun(
        db,
        `INSERT OR IGNORE INTO source_mappings
           (source_key, source_name, external_key, external_name, external_meta_json,
            category_id, object_id, variant_id, category_name, object_name, variant_name,
            status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'airmb_longchao_presale',
          '爱藏龙钞散张',
          '1|3|散张',
          '龙钞散张',
          JSON.stringify({ goods_id: '1', cat_id: '3', page_size: 100 }),
          category?.id || null,
          object?.id || null,
          variant?.id || 0,
          category?.name || '纪念钞',
          object?.name || '龙钞',
          variant?.name || '散张',
          status,
          status === 'enabled' ? '' : '初始化时未找到纪念钞/龙钞/散张主数据，请在数据源映射页面确认'
        ]
      );
    }
  },
  {
    id: '20260531_004_split_longchao_standard_10_variants',
    name: 'Split Longchao standard 10 variants',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'categories'))) return;
      if (!(await migrationTableExists(db, 'objects'))) return;
      if (!(await migrationTableExists(db, 'variants'))) return;

      const category = await dbGet<any>(
        db,
        "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
        ['纪念钞']
      );
      const object = category
        ? await dbGet<any>(
          db,
          "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [category.id, '龙钞']
        )
        : null;

      const sourceMappingsExists = await migrationTableExists(db, 'source_mappings');
      const renameVariant = async (fromName: string, toName: string) => {
        if (!object) return null;
        const from = await dbGet<any>(
          db,
          "SELECT id, name FROM variants WHERE object_id = ? AND name = ?",
          [object.id, fromName]
        );
        let to = await dbGet<any>(
          db,
          "SELECT id, name FROM variants WHERE object_id = ? AND name = ?",
          [object.id, toName]
        );

        if (from && !to) {
          await dbRun(
            db,
            "UPDATE variants SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [toName, from.id]
          );
          to = { ...from, name: toName };
        } else if (from && to && from.id !== to.id) {
          if (sourceMappingsExists) {
            await dbRun(
              db,
              `UPDATE source_mappings
               SET variant_id = ?,
                   variant_name = ?,
                   updated_at = CURRENT_TIMESTAMP
               WHERE variant_id = ?`,
              [to.id, toName, from.id]
            );
          }
          await dbRun(
            db,
            `UPDATE variants
             SET is_archived = 1,
                 archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP),
                 updated_at = CURRENT_TIMESTAMP,
                 note = TRIM(COALESCE(note, '') || CASE WHEN COALESCE(note, '') = '' THEN '' ELSE '\n' END || ?)
             WHERE id = ?`,
            [`已合并到${toName}`, from.id]
          );
        }

        return to;
      };

      const standardWith4 = await renameVariant('标十', '标10带4');
      await renameVariant('标十无4', '标10不带4');

      if (await migrationTableExists(db, 'price_records')) {
        await dbRun(
          db,
          `UPDATE price_records
           SET variant = '标10带4',
               updated_at = CURRENT_TIMESTAMP
           WHERE category = '纪念钞'
             AND object_name = '龙钞'
             AND variant = '标十'`
        );
        await dbRun(
          db,
          `UPDATE price_records
           SET variant = '标10不带4',
               updated_at = CURRENT_TIMESTAMP
           WHERE category = '纪念钞'
             AND object_name = '龙钞'
             AND variant = '标十无4'`
        );
      }

      if (sourceMappingsExists) {
        const newMapping = await dbGet<any>(
          db,
          "SELECT id FROM source_mappings WHERE source_key = ? AND external_key = ?",
          ['airmb_longchao_presale', '1|13|标10带4']
        );
        const oldMapping = await dbGet<any>(
          db,
          `SELECT id
           FROM source_mappings
           WHERE source_key = ?
             AND external_key IN ('1|13|标十', '1|13|标10', '1|13|标十带4')
           ORDER BY id
           LIMIT 1`,
          ['airmb_longchao_presale']
        );

        await dbRun(
          db,
          "UPDATE source_mappings SET source_name = ?, updated_at = CURRENT_TIMESTAMP WHERE source_key = ?",
          ['爱藏龙钞', 'airmb_longchao_presale']
        );
        await dbRun(
          db,
          `UPDATE source_mappings
           SET variant_name = '标10带4',
               external_name = CASE
                 WHEN external_name IN ('龙钞标十', '龙钞标10') THEN '龙钞标10带4'
                 ELSE REPLACE(external_name, '标十', '标10带4')
               END,
               updated_at = CURRENT_TIMESTAMP
           WHERE source_key = 'airmb_longchao_presale'
             AND variant_name IN ('标十', '标10')`
        );
        await dbRun(
          db,
          `UPDATE source_mappings
           SET variant_name = '标10不带4',
               external_name = REPLACE(REPLACE(external_name, '标十无4', '标10不带4'), '标10无4', '标10不带4'),
               updated_at = CURRENT_TIMESTAMP
           WHERE source_key = 'airmb_longchao_presale'
             AND variant_name IN ('标十无4', '标10无4')`
        );

        if (oldMapping && !newMapping) {
          await dbRun(
            db,
            `UPDATE source_mappings
             SET external_key = '1|13|标10带4',
                 external_name = '龙钞标10带4',
                 external_meta_json = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [JSON.stringify({ goods_id: '1', cat_id: '13', page_size: 100 }), oldMapping.id]
          );
        } else if (oldMapping && newMapping) {
          await dbRun(
            db,
            `UPDATE source_mappings
             SET status = 'disabled',
                 note = '已拆分为 1|13|标10带4，保留旧映射用于追溯',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [oldMapping.id]
          );
        }

        const mappingStatus = category && object && standardWith4 ? 'enabled' : 'unmapped';
        await dbRun(
          db,
          `INSERT OR IGNORE INTO source_mappings
             (source_key, source_name, external_key, external_name, external_meta_json,
              category_id, object_id, variant_id, category_name, object_name, variant_name,
              status, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'airmb_longchao_presale',
            '爱藏龙钞',
            '1|13|标10带4',
            '龙钞标10带4',
            JSON.stringify({ goods_id: '1', cat_id: '13', page_size: 100 }),
            category?.id || null,
            object?.id || null,
            standardWith4?.id || 0,
            category?.name || '纪念钞',
            object?.name || '龙钞',
            standardWith4?.name || '标10带4',
            mappingStatus,
            mappingStatus === 'enabled' ? '' : '初始化时未找到纪念钞/龙钞/标10带4主数据，请在数据源映射页面确认'
          ]
        );
        await dbRun(
          db,
          `UPDATE source_mappings
           SET source_name = ?,
               external_name = ?,
               external_meta_json = ?,
               category_id = ?,
               object_id = ?,
               variant_id = ?,
               category_name = ?,
               object_name = ?,
               variant_name = ?,
               status = ?,
               note = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE source_key = ?
             AND external_key = ?`,
          [
            '爱藏龙钞',
            '龙钞标10带4',
            JSON.stringify({ goods_id: '1', cat_id: '13', page_size: 100 }),
            category?.id || null,
            object?.id || null,
            standardWith4?.id || 0,
            category?.name || '纪念钞',
            object?.name || '龙钞',
            standardWith4?.name || '标10带4',
            mappingStatus,
            mappingStatus === 'enabled' ? '' : '初始化时未找到纪念钞/龙钞/标10带4主数据，请在数据源映射页面确认',
            'airmb_longchao_presale',
            '1|13|标10带4'
          ]
        );
      }

      if (await migrationTableExists(db, 'category_profiles')) {
        await dbRun(
          db,
          `UPDATE category_profiles
           SET business_style = REPLACE(REPLACE(business_style, '标十无4', '标10不带4'), '标十', '标10带4'),
               operation_scene = REPLACE(REPLACE(operation_scene, '标十无4', '标10不带4'), '标十', '标10带4'),
               supply_mode = REPLACE(REPLACE(supply_mode, '标十无4', '标10不带4'), '标十', '标10带4'),
               sales_mode = REPLACE(REPLACE(sales_mode, '标十无4', '标10不带4'), '标十', '标10带4'),
               price_pattern = REPLACE(REPLACE(price_pattern, '标十无4', '标10不带4'), '标十', '标10带4'),
               risk_points = REPLACE(REPLACE(risk_points, '标十无4', '标10不带4'), '标十', '标10带4'),
               operating_discipline = REPLACE(REPLACE(operating_discipline, '标十无4', '标10不带4'), '标十', '标10带4'),
               data_caliber = REPLACE(REPLACE(data_caliber, '标十无4', '标10不带4'), '标十', '标10带4'),
               experience_notes = REPLACE(REPLACE(experience_notes, '标十无4', '标10不带4'), '标十', '标10带4'),
               decision_notes = REPLACE(REPLACE(decision_notes, '标十无4', '标10不带4'), '标十', '标10带4'),
               extra_json = REPLACE(REPLACE(extra_json, '标十无4', '标10不带4'), '标十', '标10带4'),
               note = REPLACE(REPLACE(note, '标十无4', '标10不带4'), '标十', '标10带4'),
               updated_at = CURRENT_TIMESTAMP
           WHERE category_name = '纪念钞'`
        );
      }
    }
  },
  {
    id: '20260531_005_seed_longchao_standard_10_no4_source_mapping',
    name: 'Seed Longchao standard 10 no-4 source mapping',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'source_mappings'))) return;

      const category = await dbGet<any>(
        db,
        "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
        ['纪念钞']
      );
      const object = category
        ? await dbGet<any>(
          db,
          "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [category.id, '龙钞']
        )
        : null;
      const variant = object
        ? await dbGet<any>(
          db,
          "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [object.id, '标10不带4']
        )
        : null;
      const status = category && object && variant ? 'enabled' : 'unmapped';
      const metaJson = JSON.stringify({ goods_id: '1', cat_id: '63', page_size: 100 });

      const targetMapping = await dbGet<any>(
        db,
        "SELECT id FROM source_mappings WHERE source_key = ? AND external_key = ?",
        ['airmb_longchao_presale', '1|63|标10不带4']
      );
      const oldMapping = await dbGet<any>(
        db,
        `SELECT id
         FROM source_mappings
         WHERE source_key = ?
           AND external_key IN ('1|63|标10无四', '1|63|标10无4', '1|63|标十无4', '1|63|标十无四')
         ORDER BY id
         LIMIT 1`,
        ['airmb_longchao_presale']
      );

      await dbRun(
        db,
        "UPDATE source_mappings SET source_name = ?, updated_at = CURRENT_TIMESTAMP WHERE source_key = ?",
        ['爱藏龙钞', 'airmb_longchao_presale']
      );

      if (oldMapping && !targetMapping) {
        await dbRun(
          db,
          `UPDATE source_mappings
           SET external_key = '1|63|标10不带4',
               external_name = '龙钞标10无四',
               external_meta_json = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [metaJson, oldMapping.id]
        );
      } else if (oldMapping && targetMapping) {
        await dbRun(
          db,
          `UPDATE source_mappings
           SET status = 'disabled',
               note = '已拆分为 1|63|标10不带4，保留旧映射用于追溯',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [oldMapping.id]
        );
      }

      await dbRun(
        db,
        `INSERT OR IGNORE INTO source_mappings
           (source_key, source_name, external_key, external_name, external_meta_json,
            category_id, object_id, variant_id, category_name, object_name, variant_name,
            status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'airmb_longchao_presale',
          '爱藏龙钞',
          '1|63|标10不带4',
          '龙钞标10无四',
          metaJson,
          category?.id || null,
          object?.id || null,
          variant?.id || 0,
          category?.name || '纪念钞',
          object?.name || '龙钞',
          variant?.name || '标10不带4',
          status,
          status === 'enabled' ? '源头口径为标10无四；系统主数据统一为标10不带4' : '初始化时未找到纪念钞/龙钞/标10不带4主数据，请在数据源映射页面确认'
        ]
      );
      await dbRun(
        db,
        `UPDATE source_mappings
         SET source_name = ?,
             external_name = ?,
             external_meta_json = ?,
             category_id = ?,
             object_id = ?,
             variant_id = ?,
             category_name = ?,
             object_name = ?,
             variant_name = ?,
             status = ?,
             note = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE source_key = ?
           AND external_key = ?`,
        [
          '爱藏龙钞',
          '龙钞标10无四',
          metaJson,
          category?.id || null,
          object?.id || null,
          variant?.id || 0,
          category?.name || '纪念钞',
          object?.name || '龙钞',
          variant?.name || '标10不带4',
          status,
          status === 'enabled' ? '源头口径为标10无四；系统主数据统一为标10不带4' : '初始化时未找到纪念钞/龙钞/标10不带4主数据，请在数据源映射页面确认',
          'airmb_longchao_presale',
          '1|63|标10不带4'
        ]
      );
    }
  },
  {
    id: '20260531_006_remove_invalid_longchao_standard_10_sample_prices',
    name: 'Remove invalid Longchao standard 10 sample prices',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'price_records'))) return;

      await dbRun(
        db,
        `DELETE FROM price_records
         WHERE category = '纪念钞'
           AND object_name = '龙钞'
           AND variant IN ('标10带4', '标10不带4')
           AND source = '爱藏参考'
           AND price < 100`
      );
    }
  },
  {
    id: '20260531_007_seed_longyinbi_xintai_source_mapping',
    name: 'Seed Longyinbi Xintai source mapping',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'categories'))) return;
      if (!(await migrationTableExists(db, 'objects'))) return;
      if (!(await migrationTableExists(db, 'variants'))) return;
      if (!(await migrationTableExists(db, 'source_mappings'))) return;

      let category = await dbGet<any>(
        db,
        "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
        ['纪念币']
      );
      if (!category) {
        await dbRun(
          db,
          "INSERT INTO categories (name, created_at, updated_at) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          ['纪念币']
        );
        category = await dbGet<any>(
          db,
          "SELECT id, name FROM categories WHERE name = ?",
          ['纪念币']
        );
      }

      let object = category
        ? await dbGet<any>(
          db,
          "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [category.id, '龙银币']
        )
        : null;
      if (category && !object) {
        await dbRun(
          db,
          "INSERT OR IGNORE INTO objects (category_id, name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          [category.id, '龙银币']
        );
        object = await dbGet<any>(
          db,
          "SELECT id, name FROM objects WHERE category_id = ? AND name = ?",
          [category.id, '龙银币']
        );
      }

      let variant = object
        ? await dbGet<any>(
          db,
          "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [object.id, '2025年信泰评级']
        )
        : null;
      if (object && !variant) {
        await dbRun(
          db,
          "INSERT OR IGNORE INTO variants (object_id, name, created_at, updated_at, note) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)",
          [object.id, '2025年信泰评级', '源头为 2025 龙银币裸币，入库按信泰评级参考价=裸币+100']
        );
        variant = await dbGet<any>(
          db,
          "SELECT id, name FROM variants WHERE object_id = ? AND name = ?",
          [object.id, '2025年信泰评级']
        );
      }

      if (await migrationTableExists(db, 'price_records')) {
        await dbRun(
          db,
          `UPDATE price_records
           SET object_name = '龙银币',
               variant = '2025年信泰评级',
               note = TRIM(COALESCE(note, '') || CASE WHEN COALESCE(note, '') = '' THEN '' ELSE '\n' END || '历史口径从龙银币裸币/2025年迁移为龙银币/2025年信泰评级'),
               updated_at = CURRENT_TIMESTAMP
           WHERE category = '纪念币'
             AND object_name = '龙银币裸币'
             AND variant = '2025年'`
        );
      }

      const oldObject = category
        ? await dbGet<any>(
          db,
          "SELECT id FROM objects WHERE category_id = ? AND name = ?",
          [category.id, '龙银币裸币']
        )
        : null;
      if (oldObject) {
        await dbRun(
          db,
          `UPDATE variants
           SET is_archived = 1,
               archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP),
               note = TRIM(COALESCE(note, '') || CASE WHEN COALESCE(note, '') = '' THEN '' ELSE '\n' END || '已改用 龙银币 / 2025年信泰评级；裸币源头只作为加价参考'),
               updated_at = CURRENT_TIMESTAMP
           WHERE object_id = ?
             AND name = '2025年'`,
          [oldObject.id]
        );
      }

      const status = category && object && variant ? 'enabled' : 'unmapped';
      const externalKey = '7|1369|2025龙银币裸币|信泰+100';
      const metaJson = JSON.stringify({
        goods_id: '7',
        cat_id: '1369',
        page_size: 100,
        price_offset: 100,
        price_offset_reason: '信泰评级参考价=裸币源头价+100'
      });

      await dbRun(
        db,
        `INSERT OR IGNORE INTO source_mappings
           (source_key, source_name, external_key, external_name, external_meta_json,
            category_id, object_id, variant_id, category_name, object_name, variant_name,
            status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'airmb_longyinbi_presale',
          '爱藏龙银币',
          externalKey,
          '2025龙银币裸币',
          metaJson,
          category?.id || null,
          object?.id || null,
          variant?.id || 0,
          category?.name || '纪念币',
          object?.name || '龙银币',
          variant?.name || '2025年信泰评级',
          status,
          status === 'enabled' ? '源头为裸币；入库为信泰评级参考价，价格=裸币+100' : '初始化时未找到纪念币/龙银币/2025年信泰评级主数据，请在数据源映射页面确认'
        ]
      );
      await dbRun(
        db,
        `UPDATE source_mappings
         SET source_name = ?,
             external_name = ?,
             external_meta_json = ?,
             category_id = ?,
             object_id = ?,
             variant_id = ?,
             category_name = ?,
             object_name = ?,
             variant_name = ?,
             status = ?,
             note = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE source_key = ?
           AND external_key = ?`,
        [
          '爱藏龙银币',
          '2025龙银币裸币',
          metaJson,
          category?.id || null,
          object?.id || null,
          variant?.id || 0,
          category?.name || '纪念币',
          object?.name || '龙银币',
          variant?.name || '2025年信泰评级',
          status,
          status === 'enabled' ? '源头为裸币；入库为信泰评级参考价，价格=裸币+100' : '初始化时未找到纪念币/龙银币/2025年信泰评级主数据，请在数据源映射页面确认',
          'airmb_longyinbi_presale',
          externalKey
        ]
      );
    }
  },
  {
    id: '20260531_008_seed_longyinbi_price_task',
    name: 'Seed Longyinbi price update task',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'task_center_tasks'))) return;

      await dbRun(
        db,
        `INSERT OR IGNORE INTO task_center_tasks
           (task_key, name, domain, workspace, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'longyinbi_price_update',
          '龙银币价格更新',
          'price',
          'business',
          'longyinbi_price_update',
          1,
          '18:05',
          'every_day',
          33,
          JSON.stringify({ price_offset: 100 }),
          'pending',
          '每天抓取爱藏 2025 龙银币裸币价，并按信泰评级参考价=裸币+100 写入商品价格工作台'
        ]
      );
      await dbRun(
        db,
        `UPDATE task_center_tasks
         SET name = ?,
             task_type = ?,
             domain = ?,
             workspace = ?,
             enabled = 1,
             schedule_time = CASE WHEN schedule_time IS NULL OR schedule_time = '' THEN ? ELSE schedule_time END,
             schedule_days = ?,
             priority = ?,
             config_json = CASE
               WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN ?
               ELSE config_json
             END,
             last_message = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE task_key = ?`,
        [
          '龙银币价格更新',
          'longyinbi_price_update',
          'price',
          'business',
          '18:05',
          'every_day',
          33,
          JSON.stringify({ price_offset: 100 }),
          '每天抓取爱藏 2025 龙银币裸币价，并按信泰评级参考价=裸币+100 写入商品价格工作台',
          'longyinbi_price_update'
        ]
      );
    }
  },
  {
    id: '20260703_001_seed_longyinbi_2026_xintai_source_mapping',
    name: 'Seed Longyinbi 2026 Xintai source mapping',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'categories'))) return;
      if (!(await migrationTableExists(db, 'objects'))) return;
      if (!(await migrationTableExists(db, 'variants'))) return;
      if (!(await migrationTableExists(db, 'source_mappings'))) return;

      let category = await dbGet<any>(
        db,
        "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
        ['纪念币']
      );
      if (!category) {
        await dbRun(
          db,
          "INSERT INTO categories (name, created_at, updated_at) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          ['纪念币']
        );
        category = await dbGet<any>(
          db,
          "SELECT id, name FROM categories WHERE name = ?",
          ['纪念币']
        );
      }

      let object = category
        ? await dbGet<any>(
          db,
          "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [category.id, '龙银币']
        )
        : null;
      if (category && !object) {
        await dbRun(
          db,
          "INSERT OR IGNORE INTO objects (category_id, name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          [category.id, '龙银币']
        );
        object = await dbGet<any>(
          db,
          "SELECT id, name FROM objects WHERE category_id = ? AND name = ?",
          [category.id, '龙银币']
        );
      }

      let variant = object
        ? await dbGet<any>(
          db,
          "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [object.id, '2026年信泰评级']
        )
        : null;
      if (object && !variant) {
        await dbRun(
          db,
          "INSERT OR IGNORE INTO variants (object_id, name, created_at, updated_at, note) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)",
          [object.id, '2026年信泰评级', '源头为龙银币裸币，入库按 2026 信泰评级参考价=裸币-70']
        );
        variant = await dbGet<any>(
          db,
          "SELECT id, name FROM variants WHERE object_id = ? AND name = ?",
          [object.id, '2026年信泰评级']
        );
      }

      const status = category && object && variant ? 'enabled' : 'unmapped';
      const externalKey = '7|1369|2025龙银币裸币|2026信泰-70';
      const metaJson = JSON.stringify({
        goods_id: '7',
        cat_id: '1369',
        page_size: 100,
        price_offset: -70,
        price_offset_reason: '2026 信泰评级参考价=裸币源头价-70',
        start_date: '2026-07-05',
        start_date_reason: '2026 信泰评级旧历史来源不准，从 2026-07-05 起自动采集；旧历史由用户手工补'
      });
      const mappingNote = status === 'enabled'
        ? '源头为裸币；入库为 2026 年信泰评级参考价，价格=裸币-70'
        : '初始化时未找到纪念币/龙银币/2026年信泰评级主数据，请在数据源映射页面确认';

      await dbRun(
        db,
        `INSERT OR IGNORE INTO source_mappings
           (source_key, source_name, external_key, external_name, external_meta_json,
            category_id, object_id, variant_id, category_name, object_name, variant_name,
            status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'airmb_longyinbi_presale',
          '爱藏龙银币',
          externalKey,
          '2025龙银币裸币',
          metaJson,
          category?.id || null,
          object?.id || null,
          variant?.id || 0,
          category?.name || '纪念币',
          object?.name || '龙银币',
          variant?.name || '2026年信泰评级',
          status,
          mappingNote
        ]
      );
      await dbRun(
        db,
        `UPDATE source_mappings
         SET source_name = ?,
             external_name = ?,
             external_meta_json = ?,
             category_id = ?,
             object_id = ?,
             variant_id = ?,
             category_name = ?,
             object_name = ?,
             variant_name = ?,
             status = ?,
             note = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE source_key = ?
           AND external_key = ?`,
        [
          '爱藏龙银币',
          '2025龙银币裸币',
          metaJson,
          category?.id || null,
          object?.id || null,
          variant?.id || 0,
          category?.name || '纪念币',
          object?.name || '龙银币',
          variant?.name || '2026年信泰评级',
          status,
          mappingNote,
          'airmb_longyinbi_presale',
          externalKey
        ]
      );

      if (await migrationTableExists(db, 'task_center_tasks')) {
        const taskMessage = '每天抓取爱藏 2025 龙银币裸币价，并同步写入 2025年信泰评级=裸币+100、2026年信泰评级=裸币-70';
        await dbRun(
          db,
          `UPDATE task_center_tasks
           SET config_json = ?,
               last_message = CASE
                 WHEN last_status = 'pending' OR last_message LIKE '每天抓取爱藏%' THEN ?
                 ELSE last_message
               END,
               updated_at = CURRENT_TIMESTAMP
           WHERE task_key = ?`,
          [
            JSON.stringify({
              target_offsets: {
                '2025年信泰评级': 100,
                '2026年信泰评级': -70
              },
              target_start_dates: {
                '2026年信泰评级': '2026-07-05'
              }
            }),
            taskMessage,
            'longyinbi_price_update'
          ]
        );
      }
    }
  },
  {
    id: '20260531_009_refresh_longchao_profile_historical_validation',
    name: 'Refresh Longchao profile historical validation',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'category_profiles'))) return;
      if (!(await migrationTableExists(db, 'price_records'))) return;

      const profile = await dbGet<any>(
        db,
        `SELECT id, extra_json
         FROM category_profiles
         WHERE category_name = ?
           AND COALESCE(is_deleted, 0) = 0
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id
         LIMIT 1`,
        ['纪念钞']
      );
      if (!profile) return;

      const rows = await dbAll<any>(
        db,
        `SELECT
           pr.variant,
           COUNT(*) AS record_count,
           MIN(pr.date) AS first_date,
           MAX(pr.date) AS latest_date,
           MIN(pr.price) AS min_price,
           MAX(pr.price) AS max_price,
           ROUND(AVG(pr.price), 2) AS avg_price,
           (SELECT x.price
            FROM price_records x
            WHERE x.category = '纪念钞'
              AND x.object_name = '龙钞'
              AND x.variant = pr.variant
            ORDER BY x.date ASC, x.id ASC
            LIMIT 1) AS first_price,
           (SELECT x.price
            FROM price_records x
            WHERE x.category = '纪念钞'
              AND x.object_name = '龙钞'
              AND x.variant = pr.variant
            ORDER BY x.date DESC, x.id DESC
            LIMIT 1) AS latest_price,
           (SELECT x.date
            FROM price_records x
            WHERE x.category = '纪念钞'
              AND x.object_name = '龙钞'
              AND x.variant = pr.variant
            ORDER BY x.price DESC, x.date ASC, x.id ASC
            LIMIT 1) AS high_date,
           (SELECT x.date
            FROM price_records x
            WHERE x.category = '纪念钞'
              AND x.object_name = '龙钞'
              AND x.variant = pr.variant
            ORDER BY x.price ASC, x.date ASC, x.id ASC
            LIMIT 1) AS low_date
         FROM price_records pr
         WHERE pr.category = '纪念钞'
           AND pr.object_name = '龙钞'
           AND pr.variant IN ('散张', '标10带4', '标10不带4')
         GROUP BY pr.variant
         ORDER BY CASE pr.variant
           WHEN '散张' THEN 0
           WHEN '标10带4' THEN 1
           WHEN '标10不带4' THEN 2
           ELSE 3
         END`
      );
      if (rows.length === 0) return;

      const toNumber = (value: unknown) => Number(value) || 0;
      const formatPrice = (value: unknown) => {
        const number = toNumber(value);
        return Number.isInteger(number) ? String(number) : number.toFixed(2);
      };
      const drawdownPercent = (row: any) => {
        const maxPrice = toNumber(row.max_price);
        const latestPrice = toNumber(row.latest_price);
        if (!maxPrice) return 0;
        return Math.round(((maxPrice - latestPrice) / maxPrice) * 1000) / 10;
      };
      const gainPercent = (row: any) => {
        const firstPrice = toNumber(row.first_price);
        const maxPrice = toNumber(row.max_price);
        if (!firstPrice) return 0;
        return Math.round(((maxPrice - firstPrice) / firstPrice) * 1000) / 10;
      };

      const totalRecords = rows.reduce((sum: number, row: any) => sum + toNumber(row.record_count), 0);
      const dates = rows.flatMap((row: any) => [row.first_date, row.latest_date]).filter(Boolean).sort();
      const main = rows.find((row: any) => row.variant === '散张') || rows[0];
      const standardWith4 = rows.find((row: any) => row.variant === '标10带4');
      const standardNo4 = rows.find((row: any) => row.variant === '标10不带4');
      const standardSupports = [standardWith4, standardNo4]
        .filter(Boolean)
        .map((row: any) => `${row.variant} 从高点 ${row.high_date} 的 ${formatPrice(row.max_price)} 回到 ${row.latest_date} 的 ${formatPrice(row.latest_price)}，回撤约 ${drawdownPercent(row)}%，说明标10更多用于辅助观察溢价和方向，不适合当主战场。`);

      let extra: Record<string, any> = {};
      try {
        extra = JSON.parse(profile.extra_json || '{}') || {};
      } catch {
        extra = {};
      }

      extra.historical_validation = {
        confidence: toNumber(main.record_count) >= 200 ? 'high' : 'medium',
        confidence_label: toNumber(main.record_count) >= 200 ? '高' : '中',
        coverage: {
          record_count: totalRecords,
          date_range: dates.length ? `${dates[0]} 至 ${dates[dates.length - 1]}` : undefined,
          main_sources: ['爱藏龙钞'],
          variants: rows.map((row: any) => ({
            name: row.variant,
            record_count: toNumber(row.record_count),
            date_range: `${row.first_date} 至 ${row.latest_date}`,
            first_price: toNumber(row.first_price),
            high_price: toNumber(row.max_price),
            high_date: row.high_date,
            low_price: toNumber(row.min_price),
            low_date: row.low_date,
            latest_price: toNumber(row.latest_price),
            drawdown_from_high_percent: drawdownPercent(row),
            high_gain_from_first_percent: gainPercent(row)
          }))
        },
        summary: `本地价格已经能支持龙钞画像的核心判断：散张从 ${main.first_date} 的 ${formatPrice(main.first_price)} 拉到 ${main.high_date} 的 ${formatPrice(main.max_price)}，再回到 ${main.latest_date} 的 ${formatPrice(main.latest_price)}，高点回撤约 ${drawdownPercent(main)}%。它有题材弹性，也会在弱市里长时间阴跌；实战主看散张，标10只做辅助，高溢价靓号不纳入执行。`,
        supports: [
          `散张共有 ${main.record_count} 条记录，覆盖 ${main.first_date} 至 ${main.latest_date}，数据密度足够做画像反证。`,
          `散张从 ${formatPrice(main.first_price)} 到高点 ${formatPrice(main.max_price)} 的涨幅约 ${gainPercent(main)}%，支持“龙头、有题材、有弹性”的判断。`,
          `散张最新 ${formatPrice(main.latest_price)} 较高点回撤约 ${drawdownPercent(main)}%，支持“弱市/其它赛道暴雷下会一路阴跌，不能急着重仓”的纪律。`,
          ...standardSupports
        ],
        experience_only: [
          '币商持仓成本、专业人士信号、主播观点、歇夏、真实消耗仍主要来自用户经验/观点记录；价格数据只能验证走势和弹性，不能直接证明承接。',
          '高溢价整刀靓号/魅力刀波动极端，用户已明确不做，不能拿来推导散张建仓纪律。'
        ],
        data_quality: [
          '散张记录最完整，应作为实战主线；标10带4/标10不带4记录从 2024-08 开始，点位少于散张，只能辅助观察方向和溢价收缩。',
          '纪念钞价格是参考成交价，非股票式收盘价；同一日可能存在不同成交区间，执行前仍需人工确认真实盘口。'
        ],
        action_bias: {
          primary_variant: '散张',
          auxiliary_variants: ['标10带4', '标10不带4'],
          excluded_variants: ['整刀靓号', '魅力刀', '其它高溢价靓号'],
          default_decision: '底仓/观察，只有价格继续压出安全边际或专业信号确认后才考虑分批建仓'
        },
        last_analyzed_at: '2026-05-31'
      };

      await dbRun(
        db,
        `UPDATE category_profiles
         SET extra_json = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(extra), profile.id]
      );
    }
  },
  {
    id: '20260531_010_create_product_archives',
    name: 'Create product archives',
    run: async (db: any) => {
      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS product_archives (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category_id INTEGER NOT NULL,
          category_name TEXT NOT NULL,
          object_id INTEGER NOT NULL,
          object_name TEXT NOT NULL,
          variant_id INTEGER,
          variant_name TEXT DEFAULT '',
          archive_name TEXT NOT NULL,
          position_level TEXT NOT NULL DEFAULT 'watch',
          one_sentence_judgment TEXT NOT NULL,
          raw_description TEXT,
          issue_info TEXT,
          theme_design TEXT,
          trading_process TEXT,
          risk_basis TEXT,
          experience_note TEXT,
          pending_questions TEXT,
          confidence TEXT NOT NULL DEFAULT 'unknown',
          status TEXT NOT NULL DEFAULT 'draft',
          note TEXT,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
          FOREIGN KEY (object_id) REFERENCES objects(id) ON DELETE RESTRICT,
          FOREIGN KEY (variant_id) REFERENCES variants(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS product_archive_stages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          archive_id INTEGER NOT NULL,
          stage_name TEXT NOT NULL,
          time_text TEXT,
          stage_type TEXT,
          price_start REAL,
          price_high REAL,
          price_low REAL,
          price_end REAL,
          stage_summary TEXT NOT NULL,
          action_rule TEXT,
          evidence_note TEXT,
          confidence TEXT NOT NULL DEFAULT 'rough',
          sort_order INTEGER NOT NULL DEFAULT 0,
          note TEXT,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (archive_id) REFERENCES product_archives(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_product_archives_master
          ON product_archives(category_id, object_id, variant_id, status, is_deleted);

        CREATE INDEX IF NOT EXISTS idx_product_archives_position
          ON product_archives(position_level, status, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_product_archive_stages_archive
          ON product_archive_stages(archive_id, is_deleted, sort_order, id);
      `);
    }
  },
  {
    id: '20260531_011_seed_initial_product_archive_drafts',
    name: 'Seed initial product archive drafts',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'product_archives'))) return;
      if (!(await migrationTableExists(db, 'product_archive_stages'))) return;

      const findTarget = async (categoryName: string, objectName: string, variantName: string) => {
        const category = await dbGet<any>(
          db,
          "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
          [categoryName]
        );
        const object = category
          ? await dbGet<any>(
            db,
            "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
            [category.id, objectName]
          )
          : null;
        const variant = object && variantName
          ? await dbGet<any>(
            db,
            "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
            [object.id, variantName]
          )
          : null;
        if (!category || !object || (variantName && !variant)) return null;
        return { category, object, variant };
      };

      const seedArchive = async (input: {
        categoryName: string;
        objectName: string;
        variantName: string;
        positionLevel: string;
        judgment: string;
        rawDescription: string;
        issueInfo: string;
        themeDesign: string;
        tradingProcess: string;
        riskBasis: string;
        experienceNote: string;
        pendingQuestions: string;
        stage?: {
          name: string;
          time: string;
          type: string;
          summary: string;
          actionRule: string;
          evidenceNote: string;
        };
      }) => {
        const target = await findTarget(input.categoryName, input.objectName, input.variantName);
        if (!target) return;
        const existing = await dbGet<any>(
          db,
          `SELECT id FROM product_archives
           WHERE category_id = ?
             AND object_id = ?
             AND COALESCE(variant_id, 0) = COALESCE(?, 0)
             AND COALESCE(is_deleted, 0) = 0`,
          [target.category.id, target.object.id, target.variant?.id || null]
        );
        if (existing) return;
        const now = new Date().toISOString();
        const result = await new Promise<any>((resolve, reject) => {
          db.run(
            `INSERT INTO product_archives
              (category_id, category_name, object_id, object_name, variant_id, variant_name,
               archive_name, position_level, one_sentence_judgment, raw_description,
               issue_info, theme_design, trading_process, risk_basis, experience_note,
               pending_questions, confidence, status, note, is_deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rough', 'draft', ?, 0, ?, ?)`,
            [
              target.category.id,
              target.category.name,
              target.object.id,
              target.object.name,
              target.variant?.id || null,
              target.variant?.name || '',
              [target.category.name, target.object.name, target.variant?.name].filter(Boolean).join(' / '),
              input.positionLevel,
              input.judgment,
              input.rawDescription,
              input.issueInfo,
              input.themeDesign,
              input.tradingProcess,
              input.riskBasis,
              input.experienceNote,
              input.pendingQuestions,
              '系统根据已有价格、原始价格、复盘和规则经验预生成草稿，后续需要用户补真实承接、发行量和模糊阶段细节。',
              now,
              now
            ],
            function (this: any, error: any) {
              if (error) reject(error);
              else resolve(this);
            }
          );
        });
        if (input.stage && result?.lastID) {
          await dbRun(
            db,
            `INSERT INTO product_archive_stages
              (archive_id, stage_name, time_text, stage_type, stage_summary, action_rule,
               evidence_note, confidence, sort_order, note, is_deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'rough', 1, '', 0, ?, ?)`,
            [
              result.lastID,
              input.stage.name,
              input.stage.time,
              input.stage.type,
              input.stage.summary,
              input.stage.actionRule,
              input.stage.evidenceNote,
              now,
              now
            ]
          );
        }
      };

      await seedArchive({
        categoryName: '纪念币',
        objectName: '龙银币',
        variantName: '2025年信泰评级',
        positionLevel: 'main',
        judgment: '2025 龙银币以信泰评级为实战口径，裸币源头价加 100 作为参考，后续重点看银价、题材、评级溢价和回落承接。',
        rawDescription: '系统已有龙银币价格更新任务，源头为 2025 龙银币裸币，入库按信泰评级参考价=裸币+100。用户强调裸币有品相风险，实战不买裸币。',
        issueInfo: '发行价、发行总数、首发数量仍需用户补充；现有系统主要已有价格记录和信泰+100口径。',
        themeDesign: '龙题材，属于纪念币后续主力观察方向之一；具体设计、评级溢价和市场认可度还需用户补充。',
        tradingProcess: '已接入历史价格；用户提到发行后快速上行、回落、后续又可能受银价/题材/评级驱动。',
        riskBasis: '风险核心是裸币品相、银价下行、评级溢价收缩、高位追涨和承接不稳定。',
        experienceNote: '先用信泰评级口径，不把裸币价直接当可执行买入价。',
        pendingQuestions: '补发行总数、首发数量、首发热度、真实承接、关键阶段和币商成本线。',
        stage: {
          name: '首发后热度与回落再观察',
          time: '2025年发行后至当前',
          type: '首发脉冲 / 回落承接 / 银价驱动',
          summary: '用户指出这类品种可能先火热、再砸下去、后续又起来；龙银币裸币是典型，需要阶段化记录，不能把热度当静态属性。',
          actionRule: '不追高，优先等回落承接和银价环境确认；信泰评级口径按裸币+100参考。',
          evidenceNote: '来源：用户口述、龙银币价格记录、longyinbi.py 信泰+100 入库口径。'
        }
      });

      await seedArchive({
        categoryName: '纪念钞',
        objectName: '龙钞',
        variantName: '散张',
        positionLevel: 'watch',
        judgment: '龙钞只看标品，实战主看散张，标10辅助，高溢价靓号不做；当前以底仓和观察为主。',
        rawDescription: '龙钞是纪念钞核心标的，用户认为有龙头、题材、颜值、承接和真实消耗，但当前下跌受大环境和其它赛道暴雷影响。',
        issueInfo: '生肖纪念钞面值 20；其它原始价/市场口径以价格记录为主。',
        themeDesign: '龙题材，生肖纪念钞，文化共识和情绪溢价强。',
        tradingProcess: '历史价格显示散张从 33 拉到 102，再回到 52 附近；有弹性，也会在弱市中长时间阴跌。',
        riskBasis: '不要用整刀靓号/魅力刀推导散张纪律；执行前仍需确认真实成交和承接。',
        experienceNote: '底仓/观察，只有价格继续压出安全边际或专业信号确认后才考虑分批建仓。',
        pendingQuestions: '补币商成本线、专业人士信号、歇夏验证和真实消耗证据。',
        stage: {
          name: '强弹性后的弱市回落',
          time: '2024-2026',
          type: '常规趋势 / 弱市阴跌',
          summary: '散张历史价格支持“有题材弹性，但弱市可长期阴跌”的判断。',
          actionRule: '散张主看，标10辅助，靓号不做；只做分批建仓候选。',
          evidenceNote: '来源：龙钞散张、标10带4、标10不带4价格记录和画像历史价格验证摘要。'
        }
      });

      await seedArchive({
        categoryName: '纪念币',
        objectName: '工商卡',
        variantName: '2025年',
        positionLevel: 'watch',
        judgment: '2025 工商卡属于多因素叠加黑马案例，适合沉淀为 A 仓博黑马参考，不应机械套用为常态。',
        rawDescription: '系统已有 2025 工商龙复盘和原始价格历史；用户提到 530 成本后到 1800+ 卖出，是多因素叠加。',
        issueInfo: '现有原始价格历史记录 530、730、1071 等多个锚点，发行价/二次发售口径不唯一。',
        themeDesign: '卡类龙币，设计和同赛道重估对行情有影响。',
        tradingProcess: '曾出现高收益阶段，但后续也有纪律问题和回吐风险。',
        riskBasis: '规则经验指出发行价过高会削弱黑马潜力，同赛道后发定价会反向重估旧品。',
        experienceNote: '可作为黑马案例，不直接当常态；重点复盘触发条件、仓位和退出纪律。',
        pendingQuestions: '补当时真实首发数量、热度、成交体感、为什么能走出主升浪。',
        stage: {
          name: '多因素叠加黑马',
          time: '2025年银价起飞阶段',
          type: '资金炒作 / 银价驱动 / 题材扩散',
          summary: '低成本、题材、银价和市场情绪共同推动，后续需要拆成可复用和不可复制两部分。',
          actionRule: '只作为 A 仓博黑马研究样本，不作为重仓模板。',
          evidenceNote: '来源：2025工商龙复盘、原始价格历史、同赛道参考价重估规则。'
        }
      });

      await seedArchive({
        categoryName: '纪念币',
        objectName: '马年银币',
        variantName: '150g大黑马',
        positionLevel: 'watch',
        judgment: '150g 马年纪念币是高规格稀缺品错过样本：期货阶段真实收货/成交从 4200-4300 快速走到 6000+，后续爱藏实际成交到 12000，适合训练 A 仓黑马识别。',
        rawDescription: '这是 2026 丙午马年 150g 圆形银币/150g大黑马。用户确认开盘 4200-4300 是群里真实收货价和成交价，首发四五天左右仍处期货阶段；当时用户刚玩纪念币，不懂这个品类，精力在其它方向，6000+ 时觉得像忽悠接盘而没买。后续爱藏平台实际成交到 12000，用户帮别人卖过一枚现货 10000。',
        issueInfo: '原始价格历史记录官方价 3985、8000枚；错过复盘里记录发行价 3855。两种口径都保留：官方/发行锚点约 3855-3985，市场开盘 4200-4300。具体日期记不清，按首发后四五天、第二次发行等模糊阶段记录。',
        themeDesign: '马年生肖题材，150g 大规格，设计漂亮；兼具收藏、礼品和真实消耗需求。',
        tradingProcess: '低开后快速起飞：首发后四五天仍是期货，4200-4300 成交/收货；6000+ 时用户未敢接；后续上到 10000-12000。第二次发行时曾从 10000 出头回踩到 8000+，回踩不深，之后又拉升；当前弱市回落。',
        riskBasis: '高价稀缺品不能只因目标价夸张就判定为吹票。需要同时看发行量、设计题材、真实成交、收货价、平台成交、群内/一尘成交、直播间销售、收藏/礼品消耗和资金炒作。类似品更适合先进 A 仓候选，拆分证据后再决定是否参与。',
        experienceNote: '这条是“不会看稀缺性 + 害怕高位接盘 + 精力不在主线”的错过案例。关键不是追高，而是把听起来像吹牛的目标价拆成事实证据：真实收货、成交平台、承接来源、阶段位置、是否有二次发行回踩。',
        pendingQuestions: '后续可补：更精确的期货起飞日期、6000+ 时主要报价平台截图/群价、第二次发行时间、当前回落后的成交区间。',
        stage: {
          name: '期货低开后的主升浪错过',
          time: '首发后四五天至第二次发行后（具体日期模糊）',
          type: '期货首发脉冲 / 资金炒作 / 真实需求消耗 / 二次发行回踩',
          summary: '首发期货阶段四五天内仍在 4200-4300 真实成交/收货，6000+ 时用户因刚入门纪念币且担心接盘放弃。后续爱藏实际成交到 12000，用户帮别人卖过 10000；第二次发行出现 10000+ 到 8000+ 的浅回踩后继续拉升，说明真实承接和资金炒作同时存在。',
          actionRule: '未来遇到大规格、低发行量、设计好、真实收货持续上移的新品，不直接因目标价夸张否定；至少进入 A 仓候选，拆分真实成交、承接渠道、二次发行风险和回踩深度。',
          evidenceNote: '来源：用户确认的150g马年纪念币错过经历、错过复盘、商品原始价格历史；公开发行信息仅作为规格/发行量锚点。'
        }
      });
    }
  },
  {
    id: '20260601_001_create_plan_execution_events',
    name: 'Create plan execution events',
    run: async (db: any) => {
      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS plan_execution_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_type TEXT NOT NULL,
          plan_id INTEGER NOT NULL,
          status_from TEXT,
          status_to TEXT NOT NULL,
          reason_code TEXT,
          reason_text TEXT,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_plan_execution_events_plan
          ON plan_execution_events(plan_type, plan_id, created_at DESC, id DESC);
      `);
    }
  },
  {
    id: '20260601_002_create_lucky_number_records',
    name: 'Create lucky number records',
    run: async (db: any) => {
      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS lucky_number_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_name TEXT NOT NULL,
          number_code TEXT NOT NULL,
          year TEXT NOT NULL DEFAULT '2025年',
          raw_type TEXT NOT NULL DEFAULT '',
          rating_type TEXT NOT NULL DEFAULT '',
          rating_score TEXT NOT NULL DEFAULT '',
          source_raw TEXT,
          note TEXT,
          is_sold INTEGER NOT NULL DEFAULT 0,
          sold_at TEXT,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_lucky_number_records_lookup
          ON lucky_number_records(product_name, year, is_deleted, number_code);

        CREATE INDEX IF NOT EXISTS idx_lucky_number_records_updated
          ON lucky_number_records(is_deleted, updated_at DESC, id DESC);

        CREATE UNIQUE INDEX IF NOT EXISTS ux_lucky_number_records_active
          ON lucky_number_records(product_name, number_code, year, raw_type)
          WHERE is_deleted = 0;
      `);
    }
  },
  {
    id: '20260601_003_normalize_longchao_standard_10_references',
    name: 'Normalize Longchao standard 10 references',
    run: async (db: any) => {
      const updateVariantName = async (tableName: string, columnName = 'variant_name') => {
        if (!(await migrationTableExists(db, tableName))) return;
        await dbRun(
          db,
          `UPDATE ${quoteMigrationIdentifier(tableName)}
           SET ${quoteMigrationIdentifier(columnName)} = '标10不带4',
               updated_at = CURRENT_TIMESTAMP
           WHERE category_name = '纪念钞'
             AND object_name = '龙钞'
             AND ${quoteMigrationIdentifier(columnName)} = '标十无4'`
        );
        await dbRun(
          db,
          `UPDATE ${quoteMigrationIdentifier(tableName)}
           SET ${quoteMigrationIdentifier(columnName)} = '标10带4',
               updated_at = CURRENT_TIMESTAMP
           WHERE category_name = '纪念钞'
             AND object_name = '龙钞'
             AND ${quoteMigrationIdentifier(columnName)} = '标十'`
        );
      };

      if (await migrationTableExists(db, 'price_records')) {
        await dbRun(
          db,
          `UPDATE price_records
           SET variant = '标10不带4',
               updated_at = CURRENT_TIMESTAMP
           WHERE category = '纪念钞'
             AND object_name = '龙钞'
             AND variant = '标十无4'`
        );
        await dbRun(
          db,
          `UPDATE price_records
           SET variant = '标10带4',
               updated_at = CURRENT_TIMESTAMP
           WHERE category = '纪念钞'
             AND object_name = '龙钞'
             AND variant = '标十'`
        );
      }

      await updateVariantName('buying_plans');
      await updateVariantName('selling_plans');
      await updateVariantName('positions');
      await updateVariantName('ended_positions');
      await updateVariantName('sell_records');
      await updateVariantName('risk_check_records');
      await updateVariantName('risk_reviews');
      await updateVariantName('speculation_cycle_records');
      await updateVariantName('product_archives');
      await updateVariantName('original_price_records');
      await updateVariantName('source_mappings');

      if (await migrationTableExists(db, 'follows')) {
        const category = await dbGet<any>(
          db,
          "SELECT id FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
          ['纪念钞']
        );
        const object = category
          ? await dbGet<any>(
            db,
            "SELECT id FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
            [category.id, '龙钞']
          )
          : null;
        const standardWith4 = object
          ? await dbGet<any>(
            db,
            "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
            [object.id, '标10带4']
          )
          : null;
        const standardNo4 = object
          ? await dbGet<any>(
            db,
            "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
            [object.id, '标10不带4']
          )
          : null;

        if (category && object && standardNo4) {
          await dbRun(
            db,
            `DELETE FROM follows
             WHERE category_id = ?
               AND object_id = ?
               AND variant_name = '标十无4'
               AND EXISTS (
                 SELECT 1
                 FROM follows newer
                 WHERE newer.category_id = follows.category_id
                   AND newer.object_id = follows.object_id
                   AND newer.variant_id = ?
                   AND newer.id <> follows.id
               )`,
            [category.id, object.id, standardNo4.id]
          );
          await dbRun(
            db,
            `UPDATE follows
             SET variant_id = ?,
                 variant_name = ?
             WHERE category_id = ?
               AND object_id = ?
               AND variant_name = '标十无4'`,
            [standardNo4.id, standardNo4.name, category.id, object.id]
          );
        }

        if (category && object && standardWith4) {
          await dbRun(
            db,
            `DELETE FROM follows
             WHERE category_id = ?
               AND object_id = ?
               AND variant_name = '标十'
               AND EXISTS (
                 SELECT 1
                 FROM follows newer
                 WHERE newer.category_id = follows.category_id
                   AND newer.object_id = follows.object_id
                   AND newer.variant_id = ?
                   AND newer.id <> follows.id
               )`,
            [category.id, object.id, standardWith4.id]
          );
          await dbRun(
            db,
            `UPDATE follows
             SET variant_id = ?,
                 variant_name = ?
             WHERE category_id = ?
               AND object_id = ?
               AND variant_name = '标十'`,
            [standardWith4.id, standardWith4.name, category.id, object.id]
          );
        }
      }

      if (await migrationTableExists(db, 'abnormal_monitor_reads')) {
        await dbRun(
          db,
          `DELETE FROM abnormal_monitor_reads
           WHERE category_name = '纪念钞'
             AND object_name = '龙钞'
             AND variant_name = '标十无4'
             AND EXISTS (
               SELECT 1
               FROM abnormal_monitor_reads newer
               WHERE newer.read_key = REPLACE(abnormal_monitor_reads.read_key, '|标十无4|', '|标10不带4|')
             )`
        );
        await dbRun(
          db,
          `UPDATE abnormal_monitor_reads
           SET variant_name = '标10不带4',
               read_key = REPLACE(read_key, '|标十无4|', '|标10不带4|')
           WHERE category_name = '纪念钞'
             AND object_name = '龙钞'
             AND variant_name = '标十无4'`
        );
        await dbRun(
          db,
          `DELETE FROM abnormal_monitor_reads
           WHERE category_name = '纪念钞'
             AND object_name = '龙钞'
             AND variant_name = '标十'
             AND EXISTS (
               SELECT 1
               FROM abnormal_monitor_reads newer
               WHERE newer.read_key = REPLACE(abnormal_monitor_reads.read_key, '|标十|', '|标10带4|')
             )`
        );
        await dbRun(
          db,
          `UPDATE abnormal_monitor_reads
           SET variant_name = '标10带4',
               read_key = REPLACE(read_key, '|标十|', '|标10带4|')
           WHERE category_name = '纪念钞'
             AND object_name = '龙钞'
             AND variant_name = '标十'`
        );
      }
    }
  },
  {
    id: '20260602_001_add_category_profile_object_scope',
    name: 'Add object and variant scope to category profiles',
    run: async (db: any) => {
      await ensureMigrationColumn(db, 'category_profiles', 'object_name', 'TEXT');
      await ensureMigrationColumn(db, 'category_profiles', 'variant_name', 'TEXT');
      await dbExec(
        db,
        `CREATE INDEX IF NOT EXISTS idx_category_profiles_object
         ON category_profiles(category_name, object_name, variant_name, status, is_deleted)`
      );
    }
  },
  {
    id: '20260602_002_create_market_anchor_daily_prices',
    name: 'Create business market anchor daily prices',
    sql: `
      CREATE TABLE IF NOT EXISTS market_anchor_daily_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        market TEXT,
        asset_type TEXT NOT NULL DEFAULT 'precious_metal_anchor',
        trade_date TEXT NOT NULL,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        volume REAL,
        amount REAL,
        source TEXT NOT NULL,
        source_label TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, trade_date, source)
      );

      CREATE INDEX IF NOT EXISTS idx_market_anchor_daily_symbol_date
        ON market_anchor_daily_prices(symbol, source, trade_date DESC);

      CREATE INDEX IF NOT EXISTS idx_market_anchor_daily_asset_date
        ON market_anchor_daily_prices(asset_type, trade_date DESC);
    `
  },
  {
    id: '20260602_003_add_precious_metal_market_task',
    name: 'Add business precious metal market update task',
    sql: `
      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, workspace, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'precious_metal_market_update',
          '贵金属大盘行情更新',
          'market',
          'business',
          'precious_metal_market_update',
          1,
          '18:20',
          'every_day',
          34,
          '{"symbols":["XAUUSD","SGE_AGTD"],"task_timeout_minutes":30}',
          'pending',
          '每天拉取黄金现货和白银延期大盘价，写入生意侧行情锚点，不混入商品档口价格'
        );

      UPDATE task_center_tasks
      SET name = '贵金属大盘行情更新',
          domain = 'market',
          workspace = 'business',
          task_type = 'precious_metal_market_update',
          enabled = 1,
          schedule_time = CASE WHEN schedule_time IS NULL OR schedule_time = '' THEN '18:20' ELSE schedule_time END,
          schedule_days = 'every_day',
          priority = 34,
          config_json = CASE
            WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN '{"symbols":["XAUUSD","SGE_AGTD"],"task_timeout_minutes":30}'
            ELSE config_json
          END,
          last_message = '每天拉取黄金现货和白银延期大盘价，写入生意侧行情锚点，不混入商品档口价格',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'precious_metal_market_update';
    `
  },
  {
    id: '20260606_001_seed_business_boundary_cases',
    name: 'Seed business boundary case evidence',
    run: async (db: any) => {
      const now = new Date().toISOString();

      const upsertTreeCase = async (input: {
        title: string;
        track: string;
        projectName: string;
        reviewDate: string;
        treeType: string;
        summaryConclusion: string;
        background: string;
        judgmentAtThatTime: string;
        actionAtThatTime: string;
        laterOutcome: string;
        rootCauseType: string;
        exposedProblem: string;
        extractedLesson: string;
        shortLesson: string;
        note: string;
      }) => {
        if (!(await migrationTableExists(db, 'tree_hanging_cases'))) return;
        const existing = await dbGet<any>(
          db,
          'SELECT id FROM tree_hanging_cases WHERE title = ? AND COALESCE(is_deleted, 0) = 0',
          [input.title]
        );
        const params = [
          input.title,
          input.track,
          input.projectName,
          input.reviewDate,
          input.treeType,
          input.summaryConclusion,
          input.background,
          input.judgmentAtThatTime,
          input.actionAtThatTime,
          input.laterOutcome,
          input.rootCauseType,
          input.exposedProblem,
          input.extractedLesson,
          input.shortLesson,
          input.note,
          now
        ];
        if (existing) {
          await dbRun(
            db,
            `UPDATE tree_hanging_cases
             SET title = ?, track = ?, project_name = ?, review_date = ?, tree_type = ?,
                 summary_conclusion = ?, background = ?, judgment_at_that_time = ?,
                 action_at_that_time = ?, later_outcome = ?, root_cause_type = ?,
                 exposed_problem = ?, extracted_lesson = ?, short_lesson = ?, note = ?,
                 updated_at = ?
             WHERE id = ?`,
            [...params, existing.id]
          );
          return;
        }
        await dbRun(
          db,
          `INSERT INTO tree_hanging_cases
            (title, track, project_name, review_date, tree_type, summary_conclusion,
             background, judgment_at_that_time, action_at_that_time, later_outcome,
             root_cause_type, exposed_problem, extracted_lesson, short_lesson, note,
             is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [...params.slice(0, -1), now, now]
        );
      };

      const upsertCycleRecord = async (input: {
        categoryName: string;
        objectName: string;
        variantName: string;
        launchDate: string | null;
        officialPrice: number | null;
        openPrice: number | null;
        highPrice: number | null;
        lowPrice: number | null;
        currentPrice: number | null;
        openLevel: string;
        releaseQuantity: string;
        totalQuantity: string;
        firstReleaseQuantity: string;
        firstReleaseStatus: string;
        officialFirstRelease: string;
        marketBackground: string;
        cycleStage: string;
        cyclePattern: string;
        riseNature: string;
        mainParticipants: string;
        arrivalScale: string;
        supplyReleaseType: string;
        highLevelRealDemand: string;
        finalResult: string;
        futureActionRule: string;
        experienceTags: string;
        summary: string;
        lesson: string;
        note: string;
      }) => {
        if (!(await migrationTableExists(db, 'speculation_cycle_records'))) return;
        const existing = await dbGet<any>(
          db,
          `SELECT id FROM speculation_cycle_records
           WHERE category_name = ?
             AND object_name = ?
             AND COALESCE(variant_name, '') = ?
           LIMIT 1`,
          [input.categoryName, input.objectName, input.variantName]
        );
        const values = [
          input.categoryName,
          input.objectName,
          input.variantName,
          input.launchDate,
          input.officialPrice,
          input.openPrice,
          input.highPrice,
          input.lowPrice,
          input.currentPrice,
          input.openLevel,
          input.releaseQuantity,
          input.totalQuantity,
          input.firstReleaseQuantity,
          input.firstReleaseStatus,
          input.officialFirstRelease,
          input.marketBackground,
          input.cycleStage,
          input.cyclePattern,
          input.riseNature,
          input.mainParticipants,
          input.arrivalScale,
          input.supplyReleaseType,
          input.highLevelRealDemand,
          input.finalResult,
          input.futureActionRule,
          input.experienceTags,
          input.summary,
          input.lesson,
          input.note,
          now
        ];
        if (existing) {
          await dbRun(
            db,
            `UPDATE speculation_cycle_records
             SET category_name = ?, object_name = ?, variant_name = ?, launch_date = ?,
                 official_price = ?, open_price = ?, high_price = ?, low_price = ?,
                 current_price = ?, open_level = ?, release_quantity = ?,
                 total_quantity = ?, first_release_quantity = ?, first_release_status = ?,
                 official_first_release = ?, market_background = ?, cycle_stage = ?,
                 cycle_pattern = ?, rise_nature = ?, main_participants = ?,
                 arrival_scale = ?, supply_release_type = ?, high_level_real_demand = ?,
                 final_result = ?, future_action_rule = ?, experience_tags = ?,
                 summary = ?, lesson = ?, note = ?, updated_at = ?
             WHERE id = ?`,
            [...values, existing.id]
          );
          return;
        }
        await dbRun(
          db,
          `INSERT INTO speculation_cycle_records
            (category_name, object_name, variant_name, launch_date, official_price,
             open_price, high_price, low_price, current_price, open_level,
             release_quantity, total_quantity, first_release_quantity,
             first_release_status, official_first_release, market_background,
             cycle_stage, cycle_pattern, rise_nature, main_participants,
             arrival_scale, supply_release_type, high_level_real_demand,
             final_result, future_action_rule, experience_tags, summary, lesson,
             note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values.slice(0, -1), now, now]
        );
      };

      const findTarget = async (categoryName: string, objectName: string, variantName: string) => {
        const category = await dbGet<any>(
          db,
          "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
          [categoryName]
        );
        if (!category) return null;
        const object = await dbGet<any>(
          db,
          "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [category.id, objectName]
        );
        if (!object) return null;
        const variant = variantName
          ? await dbGet<any>(
            db,
            "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
            [object.id, variantName]
          )
          : null;
        if (variantName && !variant) return null;
        return { category, object, variant };
      };

      const upsertArchive = async (input: {
        categoryName: string;
        objectName: string;
        variantName: string;
        archiveName: string;
        positionLevel: string;
        judgment: string;
        rawDescription: string;
        issueInfo: string;
        themeDesign: string;
        tradingProcess: string;
        riskBasis: string;
        experienceNote: string;
        pendingQuestions: string;
        confidence: string;
        status: string;
        note: string;
      }) => {
        if (!(await migrationTableExists(db, 'product_archives'))) return null;
        const target = await findTarget(input.categoryName, input.objectName, input.variantName);
        const existing = await dbGet<any>(
          db,
          'SELECT id FROM product_archives WHERE archive_name = ? AND COALESCE(is_deleted, 0) = 0',
          [input.archiveName]
        );
        if (existing) {
          await dbRun(
            db,
            `UPDATE product_archives
             SET archive_name = ?, position_level = ?, one_sentence_judgment = ?,
                 raw_description = ?, issue_info = ?, theme_design = ?,
                 trading_process = ?, risk_basis = ?, experience_note = ?,
                 pending_questions = ?, confidence = ?, status = ?, note = ?,
                 updated_at = ?
             WHERE id = ?`,
            [
              input.archiveName,
              input.positionLevel,
              input.judgment,
              input.rawDescription,
              input.issueInfo,
              input.themeDesign,
              input.tradingProcess,
              input.riskBasis,
              input.experienceNote,
              input.pendingQuestions,
              input.confidence,
              input.status,
              input.note,
              now,
              existing.id
            ]
          );
          return existing.id;
        }
        if (!target) return null;
        await dbRun(
          db,
          `INSERT INTO product_archives
            (category_id, category_name, object_id, object_name, variant_id, variant_name,
             archive_name, position_level, one_sentence_judgment, raw_description,
             issue_info, theme_design, trading_process, risk_basis, experience_note,
             pending_questions, confidence, status, note, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            target.category.id,
            target.category.name,
            target.object.id,
            target.object.name,
            target.variant?.id || null,
            target.variant?.name || '',
            input.archiveName,
            input.positionLevel,
            input.judgment,
            input.rawDescription,
            input.issueInfo,
            input.themeDesign,
            input.tradingProcess,
            input.riskBasis,
            input.experienceNote,
            input.pendingQuestions,
            input.confidence,
            input.status,
            input.note,
            now,
            now
          ]
        );
        const created = await dbGet<any>(
          db,
          'SELECT id FROM product_archives WHERE archive_name = ? AND COALESCE(is_deleted, 0) = 0',
          [input.archiveName]
        );
        return created?.id || null;
      };

      const upsertStage = async (archiveId: number | null, input: {
        stageName: string;
        timeText: string;
        stageType: string;
        priceStart: number | null;
        priceHigh: number | null;
        priceLow: number | null;
        priceEnd: number | null;
        summary: string;
        actionRule: string;
        evidenceNote: string;
        confidence: string;
        sortOrder: number;
        note: string;
      }) => {
        if (!archiveId || !(await migrationTableExists(db, 'product_archive_stages'))) return;
        const existing = await dbGet<any>(
          db,
          `SELECT id FROM product_archive_stages
           WHERE archive_id = ? AND stage_name = ? AND COALESCE(is_deleted, 0) = 0`,
          [archiveId, input.stageName]
        );
        const values = [
          archiveId,
          input.stageName,
          input.timeText,
          input.stageType,
          input.priceStart,
          input.priceHigh,
          input.priceLow,
          input.priceEnd,
          input.summary,
          input.actionRule,
          input.evidenceNote,
          input.confidence,
          input.sortOrder,
          input.note,
          now
        ];
        if (existing) {
          await dbRun(
            db,
            `UPDATE product_archive_stages
             SET archive_id = ?, stage_name = ?, time_text = ?, stage_type = ?,
                 price_start = ?, price_high = ?, price_low = ?, price_end = ?,
                 stage_summary = ?, action_rule = ?, evidence_note = ?,
                 confidence = ?, sort_order = ?, note = ?, updated_at = ?
             WHERE id = ?`,
            [...values, existing.id]
          );
          return;
        }
        await dbRun(
          db,
          `INSERT INTO product_archive_stages
            (archive_id, stage_name, time_text, stage_type, price_start, price_high,
             price_low, price_end, stage_summary, action_rule, evidence_note,
             confidence, sort_order, note, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [...values.slice(0, -1), now, now]
        );
      };

      await upsertCycleRecord({
        categoryName: '泡泡玛特',
        objectName: '联名中娃',
        variantName: '三丽鸥/世界杯联名款',
        launchDate: '2026-03',
        officialPrice: 599,
        openPrice: 610,
        highPrice: 620,
        lowPrice: 540,
        currentPrice: 540,
        openLevel: '低开/微溢价',
        releaseQuantity: '未知',
        totalQuantity: '未知',
        firstReleaseQuantity: '未知',
        firstReleaseStatus: '已发售',
        officialFirstRelease: '未知',
        marketBackground: '泡泡玛特二级市场弱市，官方持续放货，真实消耗不足。',
        cycleStage: '破发钝化',
        cyclePattern: '低开失败 + 联名溢价失效 + 官方持续放货',
        riseNature: '联名轻微溢价，不是资金拉盘。',
        mainParticipants: '真实消费者、少量二级市场参与者',
        arrivalScale: '持续放货',
        supplyReleaseType: '官方一直放货，真实需求随时能买。',
        highLevelRealDemand: '中娃消耗弱于小娃和吊卡，体积大，不能挂包，真实需求不足。',
        finalResult: '开盘只加十几块，很快破发，后续约540附近。没有暴涨过也很难暴跌，因为没人高位囤货、没人集中砸盘，真正有需求的人随时可以买。',
        futureActionRule: '弱市普通/联名中娃低开不代表机会。没有真实热度、官方持续放货、形态消耗弱时，轻微溢价也不碰；这种品更可能是钝化阴跌，不是瀑布暴跌。',
        experienceTags: '低开失败,弱市低承接,联名溢价失效,官方持续放货,形态消耗弱,钝化阴跌,非暴涨品不瀑布',
        summary: '三丽鸥中娃和 Labubu 世界杯联名款是低开失败样本：原价599，比普通中娃贵100，开盘只加十几块，二级市场弱、官方持续放货、中娃消耗弱，最终破发到约540。',
        lesson: '低开不是机会本身。弱市里如果没有真实热度和承接，官方又持续放货，设计/联名只能轻微加分，不能支撑二级溢价。',
        note: '用户口述模糊案例；日期、精确价格和具体款式可后续补。'
      });

      await upsertCycleRecord({
        categoryName: '泡泡玛特',
        objectName: 'LABUBU系列',
        variantName: '3.0',
        launchDate: '2025-05',
        officialPrice: 596,
        openPrice: null,
        highPrice: 5000,
        lowPrice: null,
        currentPrice: null,
        openLevel: '轻微溢价后',
        releaseQuantity: '先控货，后多轮预售/铺货',
        totalQuantity: '未知',
        firstReleaseQuantity: '未知',
        firstReleaseStatus: '首发后爆火',
        officialFirstRelease: '未知',
        marketBackground: '国外明星带火、官方控货、千岛拉盘、全品类情绪共振。',
        cycleStage: '官方天量铺货后二级市场熊市',
        cyclePattern: '现象级强市拉盘 + 有限补货可消化 + 系列级无限放货反杀',
        riseNature: '明星带火/控货错配/千岛资金拉盘/真实粉丝承接共振',
        mainParticipants: '国外明星、线下玩家、千岛资金、粉丝、囤货者、二级市场参与者',
        arrivalScale: '线上线下长期随便买',
        supplyReleaseType: '前期有限补货可消化，后期 Labubu 三兄弟及其它娃进入官方无限制放货，线上线下长期随便买',
        highLevelRealDemand: '前期不只是千岛承接，也有粉丝真实购买、市场囤货和二级真实承接；后期无限制放货后溢价被供给打穿，但 Labubu 本体需求很硬，破发后仍有人原价购买。',
        finalResult: '高溢价分水岭出现在炒作后：整端从3000+补货一次砸到约2200，2200维持不到1天后继续陆续下跌；官方后续补预售仍有少量溢价。真正转折点不是只有3.0，而是 Labubu 三兄弟和其它相关娃都进入官方无限制放货，线上线下随便买且长期天天卖，随后又打击抖音非授权直播间，3.0、Labubu 三兄弟和整个泡泡玛特二级市场都被重创。',
        futureActionRule: '强市里有限补货不等于摁死，只要真实承接、粉丝购买、市场囤货和跑货速度还在，可以快进快出；但一旦出现系列级别官方无限制放货、线上线下随便买、连续天天卖，或非授权直播间被打击，就不是普通补货，而是供给结构和二级渠道同时反转，必须大幅降级、停止囤货、优先出货。若本体需求很硬，破发后仍可能有人原价买，但这只能说明真实消耗存在，不能说明二级溢价安全。',
        experienceTags: '现象级爆火,强市补货可消化,真实承接,粉丝真买,市场囤货,高溢价分水岭,补货砸盘,系列级无限制放货,Labubu三兄弟,线上线下随便买,非授权直播间打击,二级渠道失效,供给结构反转,真实消耗硬,原价需求仍在',
        summary: 'LABUBU 3.0 是“强市补货能消化，但系列级无限制放货会反杀”的核心样本。前期高热度、高溢价和真实承接让补货没有立刻打死行情，3000+补货砸到2200后仍能维持短暂溢价；但后期官方为了赚钱持续无限制放货，覆盖 Labubu 三兄弟和其它相关娃，线上线下长期随便买，再叠加打击抖音非授权直播间，二级市场的承接和渠道一起失效。这个品本体确实硬，破发后仍有人原价买，但二级炒作溢价已经不是同一套逻辑。',
        lesson: '判断补货不能只看“有没有补”，要看补货是否有限、是否连续、是否从单品变成系列级无限放货、是否线上线下长期随便买、是否还存在真实承接和二级渠道。强市有限补货可消化；系列级无限制放货 + 非授权直播渠道被打击，是泡泡玛特二级市场的摁死信号。真实消耗很硬只能保护原价附近需求，不能保护高溢价。',
        note: '用户口述模糊案例；关键价格锚：整端3000+后补货砸到约2200，2200维持不足1天后继续下跌；具体日期待补。'
      });

      await upsertTreeCase({
        title: '泡泡玛特便利店吊卡挂树案例',
        track: '泡泡玛特',
        projectName: '泡泡玛特便利店吊卡',
        reviewDate: '2025-08-01',
        treeType: '无限放货/慢跌未跑',
        summaryConclusion: '便利店吊卡是高开继续飞但最终挂树的极端强市样本：强市、量少和资金炒作可以把高开继续推高，但后续大规模无限制放货会让供给结构反转，二级价格快速坍塌；赚到必须按计划出，慢跌更要出。',
        background: '泡泡玛特最火阶段推出便利店吊卡，原价约99/199（待确认），首发就是高开，开盘1700+；后续因为量少、资金炒作和强市情绪，一路拉到5000左右，把空军拉爆。国内关店前一天仍在拉升，千岛999卖不动因为有人卡了几百单；国外开售后大规模无限制放货，供给结构反转，价格一路下跌。',
        judgmentAtThatTime: '当时容易把强市、量少和资金拉盘理解成还能继续飞，觉得按当时900左右的行情跑还有得赚，对后续大规模无限制放货的杀伤力判断不够。',
        actionAtThatTime: '慢跌没有及时大比例出货，后面从便利店开始被泡泡玛特背刺。',
        laterOutcome: '大规模无限制放货后，价格一路下跌，最终跌到约100/最低补货价附近，只能在很低的位置处理。',
        rootCauseType: '供给结构误判/执行问题',
        exposedProblem: '没有把“大规模无限制放货”当成根本逻辑变化，也没有把慢跌当成风险释放过程，错把还能赚钱当成继续等待的理由。',
        extractedLesson: '高开继续飞只可能是极端强市例外，不能作为常规追高依据；凡是非理性暴涨的品种，唯一正确动作是按计划出货；如果出现大规模无限制放货，供给结构已经变了，慢跌时即使不全出也要出大部分。',
        shortLesson: '高开飞得越狠，放货后跌得越狠；慢跌更要跑。',
        note: '用于“高开但继续飞”边界案例；不是普通追高许可，而是极端强市反面教材。'
      });

      const earthArchiveId = await upsertArchive({
        categoryName: '纪念币',
        objectName: '地球币',
        variantName: '500g',
        archiveName: '地球币500g弱市高金额低开未破发案例',
        positionLevel: 'do_not',
        judgment: '弱市里大克重高金额品天然降级，后续2.4-2.6万有承接也不改变当时风控摁死的合理性。',
        rawDescription: '用户口述新鲜案例：地球币，银币，2026年5月左右发生。500g地球币，面值150元，发行价20000（包含金币5000）。当时贵金属黄金白银处于弱市，总数2000，首发800。刚开始发售时有人溢价几百兜底，后来行情不好，兜底费降到约200。开盘从21000砸到20500闷包，属于低开；砸了几个小时后慢慢拉升到22000左右，后续涨到2.4-2.6万并且24000左右确实能卖出去。用户判断数量少，可能存在资金控盘或集中收货因素，但没有直接证据。',
        issueInfo: '发行价20000包含金币5000；面值150；总数2000、首发800；具体发行日、金币/银币组合口径和当前成交样本待补。',
        themeDesign: '题材还行，设计一般。大克重高金额品更依赖强市、资金承接和题材强度，不能按小规格低开黑马逻辑处理。',
        tradingProcess: '发售初期有几百元溢价兜底，弱市下兜底费降到约200；开盘从21000砸到20500闷包，低开后几个小时逐步拉升到22000附近，后续2.4-2.6万有成交承接。',
        riskBasis: '弱市 + 500g大克重 + 20000级别高金额 + 设计一般，是天然降级组合。即使首发800、总量2000、没有破发，后续甚至有人收、价格涨到约2.6万，也只能说明后面可能有资金或承接进来，不代表当时具备适合介入的风险收益比。数量少可能存在资金控盘或集中收货，但目前没有直接证据，不能把“可能控盘”写成确定判断。即使现在24000左右确实能卖出去，也只能说明当前有成交承接，不代表当时20000级别大金额投入的风险收益比合格。',
        experienceNote: '这条是风控摁死但后续市场走强的反事后诸葛亮案例。风控不是判断后面一定不会涨，而是判断这笔钱是否值得冒这个风险。如果重来一次，在当时弱市、大克重、高金额、设计一般、收益弹性不确定的条件下，仍然选择不碰。',
        pendingQuestions: '待补：准确发行日期、开盘成交截图、20500闷包成交依据、22000/24000/26000成交证据、是否有评级/首评因素、金币5000口径是否独立计算。',
        confidence: 'rough',
        status: 'active',
        note: '用户未参与，风控摁死。核心口径：结果涨了不等于当时应该做，有机会不等于值得做；当前24000可卖、疑似有资金控盘但无证据。'
      });
      await upsertStage(earthArchiveId, {
        stageName: '后续2.4-2.6万有承接但不推翻风控',
        timeText: '2026年6月初，后续行情更新',
        stageType: '反事后诸葛亮 / 大金额承接',
        priceStart: 22000,
        priceHigh: 26000,
        priceLow: 24000,
        priceEnd: 24000,
        summary: '后续地球币涨到约2.4-2.6万，并且24000左右确实能卖出去。用户判断数量少，可能存在资金控盘或集中收货因素，但没有直接证据。这个结果说明市场后续有承接，不代表当时风控摁死是错的。',
        actionRule: '风控看的是当时可见条件和风险收益比，不用后续涨跌倒推对错。同样场景再来一次，即使知道后续能卖到24000-26000，仍然不碰，因为单价太高、资金占用大、风险与收益不成正比。',
        evidenceNote: '用户口述更新：当前约2.4-2.6万，24000左右能卖；疑似后续资金控盘/集中收货，但无证据。用户明确表示同样场景仍选择风控。',
        confidence: 'rough',
        sortOrder: 50,
        note: '重要样本：结果赚钱不等于决策正确；可能控盘只能记为待证据判断，不能当放行依据。'
      });

      const gongshangArchiveId = await upsertArchive({
        categoryName: '纪念币',
        objectName: '工商卡',
        variantName: '2026年',
        archiveName: '2026工商卡低开首评闷包A仓案例',
        positionLevel: 'main',
        judgment: '弱市低开但具备首评窗口、题材颜值和闷包赌号预期，适合A仓参与；窗口结束和放货后溢价会自然回落。',
        rawDescription: '用户口述实战案例：2026工商纪念币，约2026年3月。背景是白银暴跌，其它纪念币也从高位跌下来，市场情绪恐慌。这个品是首发，总数约5万，首发应该约9000，可以做首评，颜值题材都不错，属于龙银币体系，设计也还行。用户喊人抽签，群里有人中签后轻微溢价收了3个闷包，成本约1050；开出一个金马卖了2200，另外两个普通号。',
        issueInfo: '总量约5万，首发约9000，具体发行日和首发数量待确认；价格记录已有2026-03-26至2026-04-17闷包走势。',
        themeDesign: '龙银币/工商卡，题材颜值不错，设计还行；首发可评级、首评窗口和靓号预期是核心加分。',
        tradingProcess: '低开后闷包价格一路上涨，基本一天涨100左右，从950附近涨到1550-1600附近后涨不动。闷包和裸币价差大，核心原因是闷包赌号和首评预期。连续几天上涨后，再收已来不及首评，窗口结束后价格自然回落；后续量大、其它银行发行、智能卡多银行渠道同时放货，也包含26工商龙后期放货，最终干破发。',
        riskBasis: '这条不是无脑黑马，而是窗口型机会：弱市低开提供安全垫，首评/闷包/靓号提供弹性。但总量5万、后续多银行渠道放货、首评窗口过期后，闷包溢价会坍塌。风控应允许A仓、小仓、原价抽签或轻微溢价，不允许后排追高。闷包赔率不能只看“有没有可能开靓号”，要看闷包和裸币价差、首评窗口、炒作阶段和普通品自身溢价。靓号要卖出很高价格，通常需要叠加首评、炒作、强市、热度、普通品本身有溢价、设计颜值在线等条件；如果只是普通/破发阶段，普通靓号溢价会明显收缩。极稀缺号码属于例外，如通天8、通天6，不管行情和品种都值钱，但概率极低，不能作为拆闷包的常规收益模型。2026年这次多银行几乎同时放货也是慢跌挂树样本：弱市里短短几天十几万枚货进入市场，期货早期轻微溢价不能代表实物到货后的真实承接；题材好、设计好也无法对抗集中供给。',
        experienceNote: '关键经验：有首评窗口的低开闷包可以A仓试错，但必须抢早期窗口；当价格连续涨几天、到1550-1600涨不动、再收来不及首评时，就不能继续追。拆闷包的第一原则是先看普通号兜底和价差。闷包与裸币差价小时，普通号亏损有限，可以用A仓赌首评/靓号弹性；闷包与裸币差价过大、首评窗口接近结束、炒作情绪透支时，就算有机会开出金马，也不划算。金马卖2200是窗口期个例，不能外推成稳定玩法。如果一个品遇到弱市、多银行/多渠道集中放货、短期供应量巨大，到货后价格一路阴跌，就不能用“颜值题材不错”安慰自己。',
        pendingQuestions: '待补：准确发行日期、首发数量是否9000、普通号后续处理价格、金马卖出平台/成交日期、其它银行放货具体日期。',
        confidence: 'rough',
        status: 'active',
        note: '用户真实参与案例。用于校准纪念币新品风控：弱市不等于全摁死，低开+首评+闷包弹性可A仓，但窗口结束必须退出。靓号高价需要多条件共振；极稀缺号独立于行情，但概率低到不能当模型。'
      });
      await upsertStage(gongshangArchiveId, {
        stageName: '轻微溢价收3个闷包',
        timeText: '低开后早期窗口',
        stageType: 'A仓实操 / 闷包赌号',
        priceStart: 1050,
        priceHigh: 2200,
        priceLow: null,
        priceEnd: null,
        summary: '用户喊人抽签，群里有人中签后轻微溢价收了3个闷包，成本约1050。开出一个金马，卖了2200；另外两个是普通号。这个金马只能当个例，它反映的是炒作/首评窗口里靓号溢价被放大的状态，不代表所有闷包平均收益。靓号高价需要首评、炒作、强市、热度、普通品有溢价和靓号属性叠加。',
        actionRule: '这种机会只适合A仓和小数量试错；开出靓号要果断兑现，不能把偶发好号当成常态收益，也不能用金马高价去倒推闷包平均胜率。拆包纪律：低价闷包、普通号下行有限时才适合拆；闷包价格高、和裸币差距大时不适合拆。除通天6/8等极稀缺号外，不能因为存在靓号概率就高价拆包。',
        evidenceNote: '用户真实交易口述；金马卖出价2200，成本约1050。普通/破发阶段若闷包约800、裸币约750，金马大概约1100；通天8、通天6等极稀缺号码不看行情也值钱，但概率极低，不进入常规赔率。',
        confidence: 'rough',
        sortOrder: 20,
        note: '靓号赔率只服务A仓纪律，不作为稳定收益模型。'
      });
      await upsertStage(gongshangArchiveId, {
        stageName: '多银行集中放货慢跌挂树',
        timeText: '2026年3月下旬至今，几家银行几乎同时发售后',
        stageType: '弱市集中放货 / 慢跌挂树',
        priceStart: 1600,
        priceHigh: 1600,
        priceLow: 950,
        priceEnd: 950,
        summary: '这次不是单个工商卡的问题，而是几家银行几乎同时放货，短短几天十几万枚货进入市场。期货一开始还有轻微溢价，但到货后一路阴跌到现在。弱市本身承接差，叠加集中放货后，设计好看、题材好也没用。',
        actionRule: '弱市中遇到多银行/多渠道集中放货，不能只看颜值题材和期货轻微溢价；到货前后应优先减仓或不追。慢跌不是还能等等，而是承接持续被供给消耗。',
        evidenceNote: '用户口述补充；本地价格记录可见2026工商卡闷包1600后逐步跌回950，智能卡/农行卡等也有零散价格记录。具体十几万枚总量和各银行放货节奏待补。',
        confidence: 'rough',
        sortOrder: 60,
        note: '用于“慢跌挂树”边界：弱市集中放货比单品题材更重要。'
      });

      await upsertTreeCase({
        title: '2026多银行纪念币集中放货慢跌挂树案例',
        track: '纪念币',
        projectName: '工商卡/智能卡/农行卡等多银行龙银币',
        reviewDate: '2026-06-06',
        treeType: '弱市集中放货/慢跌挂树',
        summaryConclusion: '弱市里几家银行几乎同时发售，短短几天十几万枚货砸进市场，期货一开始还有轻微溢价，但到货后一路阴跌到现在。设计好看、题材好也扛不住弱市和集中供给。',
        background: '当时整体就是弱市，几家银行又几乎同时放货，市场承接本来就弱，短时间十几万枚供应集中释放。期货早期仍有轻微溢价，容易让人误以为还有承接，但这只是到货前的短期价格。',
        judgmentAtThatTime: '如果只看题材、颜值或期货轻微溢价，容易低估“弱市 + 多渠道集中放货”的杀伤力。真正要看的不是单品好不好，而是市场能不能消化短期供给。',
        actionAtThatTime: '这种结构下不能因为设计好看、题材不错或期货有轻微溢价就追；如果已经参与，到货前后要优先跑，不能等阴跌慢慢确认。',
        laterOutcome: '等实物到货后，价格一路阴跌到现在。弱市承接被几家银行集中放货打穿，设计和题材都失效。',
        rootCauseType: '供给集中/弱市承接不足',
        exposedProblem: '没有把短时间十几万枚集中放货当成核心风险，也容易把期货轻微溢价误判成真实承接。慢跌不是安全，而是承接持续变弱。',
        extractedLesson: '弱市里多渠道集中放货是慢跌挂树信号。题材好、设计好只能加分，不能对抗供给集中和承接不足；期货轻微溢价不等于到货后还能卖。遇到这种结构，宁可少赚，也不能恋战。',
        shortLesson: '弱市集中放货，题材再好也要跑。',
        note: '用户口述案例；具体涉及银行、总发行量、各渠道放货日期和当前价格可后续补证。'
      });
    }
  },
  {
    id: '20260607_001_create_market_assist_rules',
    name: 'Create market assist rules for precious metal planning discipline',
    sql: `
      CREATE TABLE IF NOT EXISTS market_assist_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_symbol TEXT NOT NULL,
        asset_label TEXT NOT NULL,
        rule_group TEXT NOT NULL,
        group_label TEXT NOT NULL,
        rule_key TEXT NOT NULL,
        rule_name TEXT NOT NULL,
        rule_type TEXT NOT NULL DEFAULT 'threshold',
        priority TEXT NOT NULL DEFAULT 'medium',
        threshold_json TEXT NOT NULL DEFAULT '{}',
        action_hint TEXT,
        display_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        note TEXT,
        evidence_window TEXT,
        source_note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(asset_symbol, rule_group, rule_key)
      );

      CREATE INDEX IF NOT EXISTS idx_market_assist_rules_scope
        ON market_assist_rules(asset_symbol, rule_group, status, display_order);

      INSERT OR IGNORE INTO market_assist_rules
        (asset_symbol, asset_label, rule_group, group_label, rule_key, rule_name, rule_type, priority, threshold_json, action_hint, display_order, status, note, evidence_window, source_note)
      VALUES
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'extreme_volatility',
          '极端高波动',
          'state_gate',
          'high',
          '{"window_intervals":20,"close_points":21,"score_gte":3,"logic":"hit_at_least_3_of_4","conditions":[{"metric":"avg_abs_daily_return","gte_percent":3},{"metric":"daily_return_std","gte_percent":4.5},{"metric":"high_low_range_20_intervals","gte_percent":35},{"metric":"days_abs_return_gte_4pct","gte_days":6}]}',
          '买入权限关闭，卖出纪律打开；只处理仓位，不新增仓位。',
          10,
          'active',
          '极端高波动不是预测区，是纪律区。有仓按梯子卖或减仓，暴跌后禁止接飞刀，等高波动解除和结构修复后再评估买入。',
          '2026白银极端波动轮次：2026-01-05 至 2026-04-20',
          '由 SGE_AGTD 2025-12-01 至 2026-06-05 历史数据反推'
        ),
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'fast_rise',
          '暴涨',
          'threshold',
          'high',
          '{"logic":"any","daily_return_gte_percent":6,"return_3d_gte_percent":10,"return_5d_gte_percent":15}',
          '有仓开始卖出纪律；无仓禁止追涨。',
          20,
          'active',
          '暴涨先想卖，不把短线加速当永久趋势。',
          '2026白银波动样本',
          '由 SGE_AGTD 2025-12-01 至 2026-06-05 历史数据反推'
        ),
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'overheat_rise',
          '连续暴涨/过热',
          'threshold',
          'high',
          '{"logic":"any","return_5d_gte_percent":20,"return_20d_gte_percent":35}',
          '卖出优先，至少减波段仓；不再幻想继续直线飞。',
          30,
          'active',
          '连续暴涨属于利润兑现区，尤其配合实物端加价抢收、讨论热度爆炸时。',
          '2026白银波动样本',
          '由 SGE_AGTD 2025-12-01 至 2026-06-05 历史数据反推'
        ),
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'fast_drop',
          '暴跌',
          'threshold',
          'high',
          '{"logic":"any","daily_return_lte_percent":-5,"return_3d_lte_percent":-10,"return_5d_lte_percent":-12}',
          '买入权限关闭，先防接飞刀。',
          40,
          'active',
          '暴跌不是便宜提醒，是风险闸门。等止跌结构和实物端承接恢复。',
          '2026白银波动样本',
          '由 SGE_AGTD 2025-12-01 至 2026-06-05 历史数据反推'
        ),
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'falling_knife',
          '极端暴跌/飞刀',
          'threshold',
          'high',
          '{"logic":"any","daily_return_lte_percent":-8,"return_3d_lte_percent":-15,"return_5d_lte_percent":-20}',
          '绝对不补仓，等结构修复。',
          50,
          'active',
          '飞刀状态下不讨论抄底，只讨论已有仓位、现金和风险。',
          '2026白银波动样本',
          '由 SGE_AGTD 2025-12-01 至 2026-06-05 历史数据反推'
        ),
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'slow_decline',
          '阴跌',
          'threshold',
          'medium',
          '{"logic":"all","return_10d_lte_percent":-5,"down_days_10d_gte":6,"max_single_day_drop_gt_percent":-6}',
          '慢刀子割肉，不能抄底；有仓考虑慢慢出。',
          60,
          'active',
          '阴跌比单日暴跌更磨人，不能因为没有崩盘就当安全。',
          '2026白银波动样本',
          '由 SGE_AGTD 2025-12-01 至 2026-06-05 历史数据反推'
        ),
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'sideways',
          '横盘',
          'threshold',
          'medium',
          '{"logic":"all","abs_return_10d_lte_percent":2.5,"range_10d_lte_percent":8}',
          '真横盘才允许观察，不急着动作。',
          70,
          'active',
          '横盘要同时看净涨跌和振幅，只是跌慢了不等于横盘。',
          '2026白银波动样本',
          '由 SGE_AGTD 2025-12-01 至 2026-06-05 历史数据反推'
        ),
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'medium_sideways',
          '中期横盘',
          'threshold',
          'low',
          '{"logic":"all","abs_return_20d_lte_percent":4,"range_20d_lte_percent":12}',
          '中期安静区才观察，2026 这轮几乎没出现。',
          80,
          'active',
          '中期横盘要求更严，防止把高波动后的弱势拉扯误判成盘整。',
          '2026白银波动样本',
          '由 SGE_AGTD 2025-12-01 至 2026-06-05 历史数据反推'
        ),
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'healthy_pullback',
          '回踩不破',
          'structure',
          'medium',
          '{"logic":"all","drawdown_from_recent_high_between_percent":[5,12],"no_effective_break_ma":["MA20","MA60"],"recover_within_days":[3,5],"excluded_states":["extreme_volatility","falling_knife"]}',
          '才算健康回踩；暴跌和极端高波动下不适用。',
          90,
          'active',
          '回踩不破必须排除飞刀状态，需要看均线、恢复速度和实物端承接，不是跌了一截就叫回踩。',
          '2026白银波动样本',
          '由 SGE_AGTD 2025-12-01 至 2026-06-05 历史数据反推'
        );
    `
  },
  {
    id: '20260607_002_calibrate_silver_high_volatility_rule',
    name: 'Add calibrated high volatility rule for silver swing planning',
    sql: `
      INSERT INTO market_assist_rules
        (asset_symbol, asset_label, rule_group, group_label, rule_key, rule_name, rule_type, priority, threshold_json, action_hint, display_order, status, note, evidence_window, source_note)
      VALUES
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'high_volatility',
          '高波动',
          'state_gate',
          'high',
          '{"window_intervals":20,"close_points":21,"score_gte":3,"logic":"hit_at_least_3_of_4","conditions":[{"metric":"avg_abs_daily_return","gte_percent":2},{"metric":"daily_return_std","gte_percent":3},{"metric":"high_low_range_20_intervals","gte_percent":20},{"metric":"days_abs_return_gte_4pct","gte_days":3}],"excluded_states":["extreme_volatility"]}',
          '买入降权，不开大仓；有仓按纪律管理，等波动冷却和结构修复。',
          15,
          'active',
          '高波动不是普通横盘，也不是极端纪律区。它更像冷却/警戒区：可以观察和复盘，但不能把短暂反弹或两三天横住当成安全。',
          '2011、2020、2026 白银高波动样本；2026-05-18 至 2026-06-05 仍处高波动冷却区',
          '由 SGE_AGTD 2006-10-30 至 2026-06-05 历史数据校准；极端高波动命中 5 段，高波动用于承接极端前后和当前冷却段'
        )
      ON CONFLICT(asset_symbol, rule_group, rule_key) DO UPDATE SET
        rule_name = excluded.rule_name,
        rule_type = excluded.rule_type,
        priority = excluded.priority,
        threshold_json = excluded.threshold_json,
        action_hint = excluded.action_hint,
        display_order = excluded.display_order,
        status = excluded.status,
        note = excluded.note,
        evidence_window = excluded.evidence_window,
        source_note = excluded.source_note,
        updated_at = CURRENT_TIMESTAMP;
    `
  },
  {
    id: '20260608_001_refine_silver_extreme_volatility_discipline',
    name: 'Refine silver extreme volatility discipline rules',
    sql: `
      UPDATE market_assist_rules
      SET action_hint = '买入权限关闭，卖出纪律打开；只处理已有仓位，不新增仓位。',
          note = '极端高波动不是预测区，是纪律区。先按子纪律处理：买入锁定、卖出梯子、飞刀防守、恢复评估。暴涨时处理利润和波段仓，暴跌后禁止接飞刀，等高波动解除和结构修复后再评估买入。',
          updated_at = CURRENT_TIMESTAMP
      WHERE asset_symbol = 'SGE_AGTD'
        AND rule_group = 'silver_swing_plan'
        AND rule_key = 'extreme_volatility';

      INSERT INTO market_assist_rules
        (asset_symbol, asset_label, rule_group, group_label, rule_key, rule_name, rule_type, priority, threshold_json, action_hint, display_order, status, note, evidence_window, source_note)
      VALUES
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'extreme_buy_lock',
          '极端期买入锁定',
          'discipline',
          'high',
          '{"logic":"discipline_only","applies_when":["extreme_volatility"],"buy_permission":"closed","allowed_actions":["review_existing_position","sell_plan","cash_protection"],"blocked_actions":["new_buy","average_down","chase_rise"],"reopen_requires":["extreme_volatility_cleared","no_falling_knife","structure_repaired","physical_premium_normalized"]}',
          '不新开仓，不补仓，不追涨；只复核已有仓位、现金和卖出计划。',
          11,
          'active',
          '极端高波动里最容易把“机会”看成“必须上车”。纪律上先关买入权限，避免连续暴涨追进去，也避免暴跌后接飞刀。',
          '2011、2020、2026 极端高波动样本',
          '由用户口径“极端高波动时买入权限关闭，卖出纪律打开”细化'
        ),
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'extreme_sell_ladder',
          '极端期卖出梯子',
          'discipline',
          'high',
          '{"logic":"discipline_only","applies_when":["extreme_volatility","fast_rise","overheat_rise"],"sell_priority":["swing_position","profit_position","core_position_if_continuous_overheat"],"execution":["split_batches","lock_profit_first","avoid_top_guessing"],"core_position_exception":"continuous_overheat_can_sell_core_too"}',
          '大涨先卖波段仓，连续过热时底仓也可以按计划参与出货。',
          12,
          'active',
          '极端拉升时不要猜最高点。先落袋，再谈卖飞。若叠加实物端加价抢收、全网讨论、LOF/周边过热，卖出纪律优先级继续提高。',
          '2020八月拉升、2026一月拉升样本',
          '结合用户口径：暴涨要出货，底仓在连续暴涨机会里也能出'
        ),
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'extreme_crash_guard',
          '极端期飞刀防守',
          'discipline',
          'high',
          '{"logic":"discipline_only","applies_when":["extreme_volatility","fast_drop","falling_knife"],"buy_permission":"closed","wait_for":["no_new_low","fast_drop_cleared","physical_bid_recovered","premium_spread_normalized"],"blocked_actions":["catch_falling_knife","dense_average_down","use_core_cash_to_rescue"]}',
          '暴跌不接飞刀，不密集补仓；等止跌结构和实物收货恢复。',
          13,
          'active',
          '暴跌不是便宜提醒。尤其极端高波动里，第一段暴跌后可能还有第二段、第三段，商家补跌和情绪退潮也会滞后。',
          '2020疫情杀跌、2026二月和三月暴跌样本',
          '结合用户口径：暴跌不接飞刀，阴跌不抄底'
        ),
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'extreme_reentry_check',
          '极端后恢复评估',
          'discipline',
          'medium',
          '{"logic":"discipline_only","applies_after":["extreme_volatility"],"reentry_requires":["extreme_volatility_false","falling_knife_false","fast_drop_false","high_volatility_cooling","sideways_or_healthy_pullback","physical_market_can_buy_without_rush"],"position_action":"small_batch_only_after_recheck"}',
          '极端解除后也不立刻大买，只能小批次重新评估。',
          14,
          'active',
          '极端高波动结束不等于安全。要先看高波动是否冷却、飞刀是否解除、是否横住或回踩不破，以及实物端是否从抢购/补跌/没人要恢复到正常成交。',
          '2011反抽后继续阴跌、2020疫情修复、2026高波动冷却样本',
          '用于把极端状态之后的重新评估和仓位分层衔接起来'
        )
      ON CONFLICT(asset_symbol, rule_group, rule_key) DO UPDATE SET
        rule_name = excluded.rule_name,
        rule_type = excluded.rule_type,
        priority = excluded.priority,
        threshold_json = excluded.threshold_json,
        action_hint = excluded.action_hint,
        display_order = excluded.display_order,
        status = excluded.status,
        note = excluded.note,
        evidence_window = excluded.evidence_window,
        source_note = excluded.source_note,
        updated_at = CURRENT_TIMESTAMP;
    `
  },
  {
    id: '20260608_002_add_silver_slow_rise_rule',
    name: 'Add silver slow rise rule for swing planning',
    sql: `
      INSERT INTO market_assist_rules
        (asset_symbol, asset_label, rule_group, group_label, rule_key, rule_name, rule_type, priority, threshold_json, action_hint, display_order, status, note, evidence_window, source_note)
      VALUES
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银波段计划口径',
          'slow_rise',
          '慢涨',
          'threshold',
          'medium',
          '{"logic":"all","return_10d_gte_percent":4,"return_20d_gte_percent":8,"return_20d_lte_percent":30,"up_days_10d_gte":5,"max_single_day_rise_lt_percent":6,"excluded_states":["extreme_volatility","fast_rise","overheat_rise","fast_drop","falling_knife"]}',
          '慢涨不出，不追涨；有仓按计划持有观察，卖点提前挂好。',
          35,
          'active',
          '慢涨不是暴涨，也不是横盘。它更适合执行“慢涨不出”：有仓别急着一把卖飞，但也不因为涨得舒服就追高加仓。',
          '2025-12 白银温和上行段、2026-04 反弹段',
          '由 SGE_AGTD 历史数据和用户口径“慢涨不出”补充'
        )
      ON CONFLICT(asset_symbol, rule_group, rule_key) DO UPDATE SET
        rule_name = excluded.rule_name,
        rule_type = excluded.rule_type,
        priority = excluded.priority,
        threshold_json = excluded.threshold_json,
        action_hint = excluded.action_hint,
        display_order = excluded.display_order,
        status = excluded.status,
        note = excluded.note,
        evidence_window = excluded.evidence_window,
        source_note = excluded.source_note,
        updated_at = CURRENT_TIMESTAMP;
    `
  },
  {
    id: '20260608_003_refine_silver_healthy_pullback_rule',
    name: 'Refine silver healthy pullback rule for dynamic state line',
    sql: `
      UPDATE market_assist_rules
      SET threshold_json = '{"logic":"all","drawdown_from_recent_high_between_percent":[5,12],"close_vs_ma20_gte_percent":-2,"close_vs_ma60_gte_percent":-1,"recovery_from_5d_low_gte_percent":2.5,"excluded_states":["extreme_volatility","fast_drop","falling_knife"]}',
          action_hint = '才算健康回踩；暴跌和极端高波动下不适用。',
          note = '回踩不破必须同时满足：从近20日高点有适度回撤、没有有效跌破 MA20/MA60、且从近5日低点有修复。它不是跌了一截就抄底。',
          updated_at = CURRENT_TIMESTAMP
      WHERE asset_symbol = 'SGE_AGTD'
        AND rule_group = 'silver_swing_plan'
        AND rule_key = 'healthy_pullback';
    `
  },
  {
    id: '20260608_004_add_gold_background_anchor_rules',
    name: 'Add gold background anchor rules for precious metal market page',
    sql: `
      INSERT INTO market_assist_rules
        (asset_symbol, asset_label, rule_group, group_label, rule_key, rule_name, rule_type, priority, threshold_json, action_hint, display_order, status, note, evidence_window, source_note)
      VALUES
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'extreme_volatility',
          '极端高波动',
          'state_gate',
          'high',
          '{"window_intervals":20,"close_points":21,"score_gte":3,"logic":"hit_at_least_3_of_4","conditions":[{"metric":"avg_abs_daily_return","gte_percent":1.6},{"metric":"daily_return_std","gte_percent":2.2},{"metric":"high_low_range_20_intervals","gte_percent":18},{"metric":"days_abs_return_gte_4pct","gte_days":2}]}',
          '只作贵金属天气预报；白银和纪念币风控提高纪律权重。',
          10,
          'active',
          '黄金单价高，生意侧不直接做执行，只判断宏观和贵金属背景是否进入极端天气。',
          'XAUUSD 近多年高波动样本，服务黄金背景锚',
          '由 XAUUSD 历史价格按背景锚点口径配置，阈值低于白银执行版敏感度'
        ),
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'high_volatility',
          '高波动',
          'state_gate',
          'high',
          '{"window_intervals":20,"close_points":21,"score_gte":3,"logic":"hit_at_least_3_of_4","conditions":[{"metric":"avg_abs_daily_return","gte_percent":1},{"metric":"daily_return_std","gte_percent":1.4},{"metric":"high_low_range_20_intervals","gte_percent":10},{"metric":"days_abs_return_gte_4pct","gte_days":1}],"excluded_states":["extreme_volatility"]}',
          '宏观扰动未冷却，只提高背景风控敏感度。',
          15,
          'active',
          '高波动不是买卖信号，只说明黄金背景不安静，白银和纪念币计划不要忽略宏观扰动。',
          'XAUUSD 高波动和事件扰动样本',
          '黄金背景锚点口径'
        ),
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'fast_rise',
          '暴涨',
          'threshold',
          'medium',
          '{"logic":"any","daily_return_gte_percent":3.5,"return_3d_gte_percent":6,"return_5d_gte_percent":8}',
          '黄金情绪偏热，白银/纪念币同步过热时防回吐。',
          20,
          'active',
          '黄金暴涨只作为贵金属情绪升温提醒，不触发生意侧黄金买入。',
          'XAUUSD 短线加速样本',
          '黄金背景锚点口径'
        ),
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'overheat_rise',
          '连续暴涨/过热',
          'threshold',
          'medium',
          '{"logic":"any","return_5d_gte_percent":10,"return_20d_gte_percent":18}',
          '贵金属情绪过热，只提醒防追高和防利润回吐。',
          30,
          'active',
          '黄金连续过热时更像环境警报，尤其用来提醒白银和纪念币别把情绪高点当常态。',
          'XAUUSD 连续拉升样本',
          '黄金背景锚点口径'
        ),
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'slow_rise',
          '慢涨',
          'threshold',
          'medium',
          '{"logic":"all","return_10d_gte_percent":2.5,"return_20d_gte_percent":5,"return_20d_lte_percent":18,"up_days_10d_gte":5,"max_single_day_rise_lt_percent":3.5,"excluded_states":["extreme_volatility","fast_rise","overheat_rise","fast_drop","falling_knife"]}',
          '黄金背景偏暖，可作为白银和纪念币大方向加分项。',
          35,
          'active',
          '慢涨说明贵金属背景温和偏强，但仍不是黄金实体买入建议。',
          'XAUUSD 慢涨样本',
          '黄金背景锚点口径'
        ),
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'fast_drop',
          '暴跌',
          'threshold',
          'medium',
          '{"logic":"any","daily_return_lte_percent":-3.5,"return_3d_lte_percent":-6,"return_5d_lte_percent":-8}',
          '黄金背景转冷，不直接抄底，观察白银是否同步走坏。',
          40,
          'active',
          '黄金暴跌说明贵金属背景受冲击，生意侧用于降温，不用于接飞刀。',
          'XAUUSD 快速下杀样本',
          '黄金背景锚点口径'
        ),
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'falling_knife',
          '极端暴跌/飞刀',
          'threshold',
          'high',
          '{"logic":"any","daily_return_lte_percent":-5.5,"return_3d_lte_percent":-10,"return_5d_lte_percent":-14}',
          '黄金飞刀只作风险提示，白银和纪念币计划优先防守。',
          50,
          'active',
          '极端暴跌不是便宜提醒，是贵金属背景风险暴露。',
          'XAUUSD 极端下杀样本',
          '黄金背景锚点口径'
        ),
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'slow_decline',
          '阴跌',
          'threshold',
          'medium',
          '{"logic":"all","return_10d_lte_percent":-3.5,"down_days_10d_gte":6,"max_single_day_drop_gt_percent":-4}',
          '黄金背景偏冷，观察白银和纪念币是否同步承压。',
          60,
          'active',
          '黄金阴跌用于提示贵金属背景慢慢降温，不是单独动作信号。',
          'XAUUSD 阴跌样本',
          '黄金背景锚点口径'
        ),
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'sideways',
          '横盘',
          'threshold',
          'low',
          '{"logic":"all","abs_return_10d_lte_percent":1.8,"range_10d_lte_percent":5}',
          '黄金背景安静，继续看白银和纪念币自身结构。',
          70,
          'active',
          '黄金横盘说明大方向暂时没给强提示。',
          'XAUUSD 横盘样本',
          '黄金背景锚点口径'
        ),
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'medium_sideways',
          '中期横盘',
          'threshold',
          'low',
          '{"logic":"all","abs_return_20d_lte_percent":3,"range_20d_lte_percent":8}',
          '中期背景安静，只作参考。',
          80,
          'active',
          '中期横盘用于识别黄金背景没有明显方向的阶段。',
          'XAUUSD 中期横盘样本',
          '黄金背景锚点口径'
        ),
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'healthy_pullback',
          '回踩不破',
          'structure',
          'low',
          '{"logic":"all","drawdown_from_recent_high_between_percent":[3,8],"close_vs_ma20_gte_percent":-1.5,"close_vs_ma60_gte_percent":-1,"recovery_from_5d_low_gte_percent":1.5,"excluded_states":["extreme_volatility","fast_drop","falling_knife"]}',
          '黄金背景健康回踩，只作贵金属趋势参考。',
          90,
          'active',
          '黄金回踩不破只表示背景没有明显走坏，不直接给黄金实体动作。',
          'XAUUSD 回踩修复样本',
          '黄金背景锚点口径'
        )
      ON CONFLICT(asset_symbol, rule_group, rule_key) DO UPDATE SET
        rule_name = excluded.rule_name,
        rule_type = excluded.rule_type,
        priority = excluded.priority,
        threshold_json = excluded.threshold_json,
        action_hint = excluded.action_hint,
        display_order = excluded.display_order,
        status = excluded.status,
        note = excluded.note,
        evidence_window = excluded.evidence_window,
        source_note = excluded.source_note,
        updated_at = CURRENT_TIMESTAMP;
    `
  },
  {
    id: '20260608_005_add_silver_ma250_stretch_rule',
    name: 'Add silver MA250 stretch discipline rule',
    sql: `
      INSERT INTO market_assist_rules
        (asset_symbol, asset_label, rule_group, group_label, rule_key, rule_name, rule_type, priority, threshold_json, action_hint, display_order, status, note, evidence_window, source_note)
      VALUES
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银实物波段计划口径',
          'ma250_stretch',
          '远离年线/趋势拉伸',
          'structure',
          'high',
          '{"logic":"tiered","block_wave_buy_vs_ma250_gte_percent":35,"sell_ladder_vs_ma250_gte_percent":45,"sell_ladder_vs_ma20_gte_percent":8,"force_sell_vs_ma250_gte_percent":60}',
          '距年线过远时不再新增波段仓；45%+且短线偏热时开始挂梯子卖，60%+至少卖一笔波段。',
          32,
          'active',
          '这条不是猜顶，而是防止慢涨后离年线过远还继续打满。用于约束 2025-12 这种没有触发暴涨、但价格已经大幅跑赢年线的阶段。',
          'SGE_AGTD 2025-12 拉伸样本与 2026 极端波动前置阶段',
          '由白银实物波段模拟校准：35% 降低买入权限，45%+MA20偏热开始卖梯子，60% 强制至少处理一笔波段仓'
        )
      ON CONFLICT(asset_symbol, rule_group, rule_key) DO UPDATE SET
        rule_name = excluded.rule_name,
        rule_type = excluded.rule_type,
        priority = excluded.priority,
        threshold_json = excluded.threshold_json,
        action_hint = excluded.action_hint,
        display_order = excluded.display_order,
        status = excluded.status,
        note = excluded.note,
        evidence_window = excluded.evidence_window,
        source_note = excluded.source_note,
        updated_at = CURRENT_TIMESTAMP;
    `
  },
  {
    id: '20260609_001_create_market_assist_rule_versions',
    name: 'Create market assist rule version records',
    sql: `
      CREATE TABLE IF NOT EXISTS market_assist_rule_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_symbol TEXT NOT NULL,
        asset_label TEXT NOT NULL,
        rule_group TEXT NOT NULL,
        group_label TEXT NOT NULL,
        version_key TEXT NOT NULL,
        version_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        effective_date TEXT,
        change_reason TEXT,
        threshold_summary TEXT,
        sample_window TEXT,
        regression_command TEXT,
        regression_summary TEXT,
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(asset_symbol, rule_group, version_key)
      );

      CREATE INDEX IF NOT EXISTS idx_market_assist_rule_versions_scope
        ON market_assist_rule_versions(asset_symbol, rule_group, status, effective_date DESC, id DESC);

      INSERT INTO market_assist_rule_versions
        (asset_symbol, asset_label, rule_group, group_label, version_key, version_name, status, effective_date, change_reason, threshold_summary, sample_window, regression_command, regression_summary, snapshot_json)
      VALUES
        (
          'SGE_AGTD',
          '白银延期',
          'silver_swing_plan',
          '白银实物波段计划口径',
          'silver-swing-v1.3',
          '白银实物波段纪律 v1.3',
          'active',
          '2026-06-09',
          '锁定 2011、2020、2026 固定样本；细化高波动解除、MA250 拉伸、慢涨/阴跌/飞刀纪律。',
          '极端高波动按近20交易日 4 条口径 3 条命中识别；高波动按 4 条口径 3 条命中识别；飞刀/暴跌/阴跌/横盘/回踩不破/慢涨独立判断；MA250 拉伸约束波段仓新增和梯子卖出。',
          'SGE_AGTD 2006-10-30 ~ 当前最新；固定样本覆盖 2011、2020、2025-2026，并锁住 4 轮极端高波动簇。',
          'npm run test:precious-metal-assist',
          '白银 13 个固定样本 + 极端高波动簇；黄金 11 个背景锚样本；改阈值后必须先跑回归。',
          '{"evaluator_version":"silver-swing-v1.3","asset_role":"白银实物波段执行锚","hard_disciplines":["极端高波动时买入权限关闭，卖出纪律打开","暴跌/飞刀不接，阴跌不抄底","MA250 过度拉伸时不打满波段仓"],"core_thresholds":{"extreme_volatility":"近20交易日均绝对波动>=3%、波动标准差>=4.5%、区间振幅>=35%、大波动天数>=6，4中3命中","high_volatility":"近20交易日均绝对波动>=2%、波动标准差>=3%、区间振幅>=20%、大波动天数>=3，4中3命中","ma250_stretch":"距年线>=35%限制新增波段仓，>=45%且短线偏热开始梯子卖，>=60%至少处理一笔波段仓"},"regression_command":"npm run test:precious-metal-assist"}'
        ),
        (
          'XAUUSD',
          '黄金现货',
          'precious_metal_plan',
          '黄金背景锚点口径',
          'gold-anchor-v1.0',
          '黄金背景锚点 v1.0',
          'active',
          '2026-06-09',
          '黄金只做贵金属天气预报，不给生意侧黄金实体买卖结论；用于辅助白银和纪念币背景判断。',
          '黄金阈值比白银更敏感：极端高波动、高波动、暴涨、暴跌、阴跌、横盘、慢涨和回踩不破只作为背景状态。',
          'XAUUSD 1979-12-26 ~ 当前最新；固定样本覆盖 2011、2020、2025-2026。',
          'npm run test:precious-metal-assist',
          '黄金 11 个背景锚样本；只锁背景状态，不生成黄金实体执行动作。',
          '{"evaluator_version":"gold-anchor-v1.0","asset_role":"贵金属天气预报背景锚","hard_disciplines":["黄金不直接授予白银买入权限","黄金飞刀/暴跌只提高防守权重","黄金慢涨只作为贵金属背景加分"],"core_thresholds":{"extreme_volatility":"近20交易日 4 条口径 3 条命中，阈值低于白银执行版","fast_rise":"单日>=3.5%、3日>=6%、5日>=8% 任一命中","falling_knife":"单日<=-5.5%、3日<=-10%、5日<=-14% 任一命中"},"regression_command":"npm run test:precious-metal-assist"}'
        )
      ON CONFLICT(asset_symbol, rule_group, version_key) DO UPDATE SET
        version_name = excluded.version_name,
        status = excluded.status,
        effective_date = excluded.effective_date,
        change_reason = excluded.change_reason,
        threshold_summary = excluded.threshold_summary,
        sample_window = excluded.sample_window,
        regression_command = excluded.regression_command,
        regression_summary = excluded.regression_summary,
        snapshot_json = excluded.snapshot_json,
        updated_at = CURRENT_TIMESTAMP;
    `
  },
  {
    id: '20260609_002_create_market_physical_observations',
    name: 'Create lightweight physical market observations',
    sql: `
      CREATE TABLE IF NOT EXISTS market_physical_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_symbol TEXT NOT NULL,
        asset_label TEXT NOT NULL,
        observation_date TEXT NOT NULL,
        reference_close REAL,
        merchant_sell_price REAL,
        merchant_sell_premium REAL,
        buyback_price REAL,
        buyback_premium REAL,
        supply_status TEXT NOT NULL DEFAULT 'unknown',
        transaction_heat TEXT NOT NULL DEFAULT 'unknown',
        social_heat TEXT NOT NULL DEFAULT 'unknown',
        reliability TEXT NOT NULL DEFAULT 'manual_limited',
        source_note TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_market_physical_observations_symbol_date
        ON market_physical_observations(asset_symbol, observation_date DESC, id DESC);
    `
  },
  {
    id: '20260609_003_narrow_gold_anchor_wording',
    name: 'Narrow gold anchor wording to background-only usage',
    sql: `
      UPDATE market_assist_rules
      SET action_hint = CASE rule_key
            WHEN 'extreme_volatility' THEN '只作贵金属天气预报；白银和纪念币风控提高纪律权重，但不单独触发买卖。'
            WHEN 'high_volatility' THEN '宏观扰动未冷却，只提高背景风控敏感度，不生成执行动作。'
            WHEN 'fast_rise' THEN '黄金情绪偏热；白银/纪念币同步过热时只提高防回吐权重。'
            WHEN 'overheat_rise' THEN '贵金属情绪过热，只提醒防追高和防利润回吐，不单独触发出货。'
            WHEN 'slow_rise' THEN '黄金背景偏暖，只作为白银和纪念币大方向加分项。'
            WHEN 'fast_drop' THEN '黄金背景转冷，只提示风险，不直接抄底。'
            WHEN 'falling_knife' THEN '黄金飞刀只作风险提示，白银和纪念币计划优先防守。'
            WHEN 'slow_decline' THEN '黄金背景偏冷，观察白银和纪念币是否同步承压。'
            WHEN 'sideways' THEN '黄金背景安静，继续看白银和纪念币自身结构。'
            WHEN 'medium_sideways' THEN '中期背景安静，只作参考。'
            WHEN 'healthy_pullback' THEN '黄金背景健康回踩，只作贵金属趋势参考。'
            ELSE action_hint
          END,
          note = CASE rule_key
            WHEN 'extreme_volatility' THEN '黄金单价高，生意侧不直接做执行，只判断宏观和贵金属背景是否进入极端天气。'
            WHEN 'fast_rise' THEN '黄金暴涨只作为贵金属情绪升温提醒，不触发生意侧黄金买入，也不单独触发白银/纪念币卖出。'
            WHEN 'overheat_rise' THEN '黄金连续过热更像环境警报，用来提醒白银和纪念币别把情绪高点当常态。'
            WHEN 'slow_rise' THEN '慢涨说明贵金属背景温和偏强，但仍不是黄金实体买入建议。'
            WHEN 'fast_drop' THEN '黄金暴跌说明贵金属背景受冲击，生意侧用于降温，不用于接飞刀。'
            ELSE note
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE asset_symbol = 'XAUUSD'
        AND rule_group = 'precious_metal_plan';

      UPDATE market_assist_rule_versions
      SET change_reason = '黄金只做贵金属天气预报，不给生意侧黄金实体买卖结论；也不单独授予白银或纪念币买卖权限。',
          threshold_summary = '阈值不变；极端高波动、高波动、暴涨、暴跌、阴跌、横盘、慢涨和回踩不破只作为背景状态。',
          updated_at = CURRENT_TIMESTAMP
      WHERE asset_symbol = 'XAUUSD'
        AND rule_group = 'precious_metal_plan'
        AND version_key = 'gold-anchor-v1.0';
    `
  },
  {
    id: '20260613_001_create_dashboard_action_statuses',
    name: 'Create dashboard action queue handled ignored statuses',
    sql: `
      CREATE TABLE IF NOT EXISTS dashboard_action_statuses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL DEFAULT 'business',
        action_key TEXT NOT NULL,
        action_title TEXT NOT NULL DEFAULT '',
        action_source TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('handled', 'ignored')),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(workspace, action_key)
      );

      CREATE INDEX IF NOT EXISTS idx_dashboard_action_statuses_scope
        ON dashboard_action_statuses(workspace, status, updated_at DESC);
    `
  },
  {
    id: '20260627_001_switch_commodity_metals_to_jijinhao',
    name: 'Switch commodity metals task to Jijinhao recycle source',
    run: async (db: any) => {
      if (await migrationTableExists(db, 'task_center_tasks')) {
        const task = await dbGet<any>(
          db,
          `SELECT id, config_json
           FROM task_center_tasks
           WHERE task_key = ?`,
          ['commodity_metals_price_update']
        );

        if (task) {
          let config: Record<string, any> = {};
          try {
            config = JSON.parse(String(task.config_json || '{}'));
          } catch {
            config = {};
          }

          config.targets = Array.isArray(config.targets) && config.targets.length > 0
            ? config.targets
            : ['黄金9999', '白银'];
          config.source = 'jijinhao';
          config.history_days = Number.isFinite(Number(config.history_days ?? config.historyDays))
            ? Number(config.history_days ?? config.historyDays)
            : 30;
          delete config.historyDays;

          await dbRun(
            db,
            `UPDATE task_center_tasks
             SET config_json = ?,
                 last_message = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              JSON.stringify(config),
              '每天抓取金投网贵金属回收黄金/白银价格，并写入商品价格工作台；黄金按整数，白银保留两位小数',
              task.id
            ]
          );
        }
      }

      if (!(await migrationTableExists(db, 'source_mappings'))) return;

      const rows = [
        {
          source_key: 'jijinhao_recycle_metals',
          source_name: '金投网贵金属回收',
          external_key: 'JO_321453',
          external_name: '黄金回收价格',
          category_name: '贵金属',
          object_name: '黄金',
          external_meta_json: { code: 'JO_321453', digits: 0 }
        },
        {
          source_key: 'jijinhao_recycle_metals',
          source_name: '金投网贵金属回收',
          external_key: 'JO_321465',
          external_name: '足银回收价格',
          category_name: '贵金属',
          object_name: '白银',
          external_meta_json: { code: 'JO_321465', digits: 2 }
        }
      ];

      for (const row of rows) {
        const category = await dbGet<any>(
          db,
          "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
          [row.category_name]
        );
        const object = category
          ? await dbGet<any>(
            db,
            "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
            [category.id, row.object_name]
          )
          : null;
        const status = category && object ? 'enabled' : 'unmapped';

        await dbRun(
          db,
          `INSERT OR IGNORE INTO source_mappings
             (source_key, source_name, external_key, external_name, external_meta_json,
              category_id, object_id, variant_id, category_name, object_name, variant_name,
              status, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '', ?, ?)`,
          [
            row.source_key,
            row.source_name,
            row.external_key,
            row.external_name,
            JSON.stringify(row.external_meta_json),
            category?.id || null,
            object?.id || null,
            category?.name || row.category_name,
            object?.name || row.object_name,
            status,
            status === 'enabled'
              ? '主用源；金投网贵金属回收历史接口'
              : '初始化时未找到对应主数据，请在数据源映射页面确认'
          ]
        );

        await dbRun(
          db,
          `UPDATE source_mappings
           SET source_name = ?,
               external_name = ?,
               external_meta_json = ?,
               category_id = ?,
               object_id = ?,
               variant_id = 0,
               category_name = ?,
               object_name = ?,
               variant_name = '',
               status = ?,
               note = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE source_key = ?
             AND external_key = ?`,
          [
            row.source_name,
            row.external_name,
            JSON.stringify(row.external_meta_json),
            category?.id || null,
            object?.id || null,
            category?.name || row.category_name,
            object?.name || row.object_name,
            status,
            status === 'enabled'
              ? '主用源；金投网贵金属回收历史接口'
              : '初始化时未找到对应主数据，请在数据源映射页面确认',
            row.source_key,
            row.external_key
          ]
        );
      }
    }
  },
  {
    id: '20260627_002_add_lucky_number_rating_fields',
    name: 'Add lucky number rating fields',
    run: async (db: any) => {
      await ensureMigrationColumn(db, 'lucky_number_records', 'rating_type', "TEXT NOT NULL DEFAULT ''");
      await ensureMigrationColumn(db, 'lucky_number_records', 'rating_score', "TEXT NOT NULL DEFAULT ''");
    }
  },
  {
    id: '20260627_003_add_lucky_number_sold_status',
    name: 'Add lucky number sold status',
    run: async (db: any) => {
      await ensureMigrationColumn(db, 'lucky_number_records', 'is_sold', 'INTEGER NOT NULL DEFAULT 0');
      await ensureMigrationColumn(db, 'lucky_number_records', 'sold_at', 'TEXT');
    }
  },
  {
    id: '20260627_004_clear_lucky_number_default_rating_type',
    name: 'Clear lucky number default rating type',
    run: async (db: any) => {
      await db.run(
        `UPDATE lucky_number_records
         SET rating_type = '', updated_at = CURRENT_TIMESTAMP
         WHERE rating_type = '普通'`
      );
    }
  },
  {
    id: '20260629_001_normalize_auto_price_record_sources',
    name: 'Normalize automatic price record sources',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'price_records'))) return;
      await dbRun(
        db,
        `UPDATE price_records
         SET source = ?, updated_at = CURRENT_TIMESTAMP
         WHERE category = ?
           AND source = ?`,
        ['德璜小程序档口报价', '苹果手机', '档口报价']
      );
      await dbRun(
        db,
        `UPDATE price_records
         SET source = ?, updated_at = CURRENT_TIMESTAMP
         WHERE category = ?
           AND source = ?`,
        ['东旭游戏机档口', '游戏机', '档口报价']
      );
      await dbRun(
        db,
        `UPDATE price_records
         SET source = ?, updated_at = CURRENT_TIMESTAMP
         WHERE category = ?
           AND source = ?`,
        ['千岛泡泡玛特', '泡泡玛特', '千岛']
      );
    }
  },
  {
    id: '20260629_002_seed_ai_storage_cost_transmission_records',
    name: 'Seed AI storage cost transmission cognition records',
    run: async (db: any) => {
      if (await migrationTableExists(db, 'event_records')) {
        const eventTitle = 'AI需求推动存储价格上涨并向整机传导';
        const existingEvent = await dbGet<any>(
          db,
          'SELECT id FROM event_records WHERE title = ? AND COALESCE(is_deleted, 0) = 0 LIMIT 1',
          [eventTitle]
        );
        if (!existingEvent) {
          await dbRun(
            db,
            `INSERT INTO event_records
               (title, track, event_date, event_type, description, related_object, impact, source, note, is_deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              eventTitle,
              '电子产品',
              '2026-06-29',
              '宏观/产业事件',
              'AI算力需求持续增加，带动内存、硬盘、固态等上游资源紧张或涨价；价格先反映在单根内存条、SSD等零部件，再逐渐传导到笔记本、手机、游戏机等整机成本和二级价格。',
              '内存、硬盘、SSD、笔记本、手机、游戏机',
              '这是产业链成本传导事件，不是单品价格信号。它提示电子产品不能只按新款迭代导致旧款自然贬值来理解；关键零部件结构性涨价时，旧款、现货、高配版本可能短期获得支撑。',
              '用户观察/系统整理',
              '反证：电子产品仍受新品迭代、官方调价、平台补贴、库存释放影响。上游涨价只能作为背景证据，不能直接推出整机必涨。已有“内存条硬盘错过复盘”可作为第一阶段案例。'
            ]
          );
        }
      }

      if (await migrationTableExists(db, 'rule_experiences')) {
        const ruleTitle = '电子产品上游成本冲击不能只按迭代贬值看';
        const existingRule = await dbGet<any>(
          db,
          'SELECT id FROM rule_experiences WHERE title = ? AND COALESCE(is_deleted, 0) = 0 LIMIT 1',
          [ruleTitle]
        );
        if (!existingRule) {
          await dbRun(
            db,
            `INSERT INTO rule_experiences
               (title, type, track, source_case, core_content, summary_conclusion, note, is_deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              ruleTitle,
              '产业传导/反证规则',
              '电子产品',
              '内存条硬盘错过复盘；AI需求推动存储价格上涨并向整机传导',
              '电子产品不能只按“新款出来旧款自然跌价”看。当上游关键零部件出现结构性涨价时，旧款、现货、高配版本可能短期获得价格支撑，甚至出现反常上涨。判断时要先拆链路：上游涨价是否真实、涨价是否传导到零部件现货、整机端是否缺货或成本抬升、二级回收/成交是否跟随。',
              '上游成本冲击可以作为背景证据和观察线索，但不能直接变成整机价格结论。',
              '反证必须同时记录：新品迭代、官方调价、平台补贴、渠道库存释放、需求不足，都可能抵消上游涨价。该规则服务风控和认知，不构成操作指令。'
            ]
          );
        }
      }

      if (await migrationTableExists(db, 'speculation_cycle_records')) {
        const cyclePattern = '上游成本冲击 - 零部件涨价 - 整机价格传导型';
        const existingCycle = await dbGet<any>(
          db,
          `SELECT id
           FROM speculation_cycle_records
           WHERE category_name = ?
             AND object_name = ?
             AND cycle_pattern = ?
           LIMIT 1`,
          ['电子产品', '存储/整机传导', cyclePattern]
        );
        let cycleId = existingCycle?.id;
        if (!cycleId) {
          await dbRun(
            db,
            `INSERT INTO speculation_cycle_records
               (category_name, object_name, variant_name, open_level, market_background, cycle_stage,
                cycle_pattern, rise_nature, main_participants, supply_release_type, high_level_real_demand,
                final_result, future_action_rule, summary, lesson, note, created_at, updated_at)
             VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              '电子产品',
              '存储/整机传导',
              '不适用',
              'AI算力需求增加，存储资源和关键零部件出现涨价预期或现货涨价，电子产品二级市场可能从零部件先涨逐步传导到整机。',
              '产业传导观察期',
              cyclePattern,
              'AI需求推高上游资源成本，零部件涨价先行，整机价格可能滞后传导',
              'AI算力需求、存储厂商、渠道商、整机厂商、二级市场参与者',
              '上游资源紧张/渠道库存变化',
              '需要看真实成交和回收端是否跟随，不能只看新闻或单点报价',
              '观察中：已有内存条/硬盘先涨的错过复盘，后续需要继续观察笔记本、手机、游戏机等整机端是否真实传导。',
              '先确认传导链路，再判断单品；上游涨价不能直接推出整机必涨。电子产品仍要防新品迭代、补贴和库存释放反杀。',
              'AI需求增加后，存储类零部件先出现价格支撑或上涨，再可能向高配整机、现货整机和二级回收价格传导。这个模式可复用到“银价带动银币”“原材料带动成品”“核心零件带动整机”等场景。',
              '产业链传导要分阶段看：上游事实、零部件现货、整机端承接、二级成交四层都要确认。只有一层成立时，最多作为背景证据。',
              '第一阶段案例关联：内存条硬盘错过复盘。该记录是周期模式，不是单品买卖结论。'
            ]
          );
          const insertedCycle = await dbGet<any>(
            db,
            `SELECT id
             FROM speculation_cycle_records
             WHERE category_name = ?
               AND object_name = ?
               AND cycle_pattern = ?
             ORDER BY id DESC
             LIMIT 1`,
            ['电子产品', '存储/整机传导', cyclePattern]
          );
          cycleId = insertedCycle?.id;
        }

        if (cycleId && await migrationTableExists(db, 'speculation_cycle_events')) {
          const events = [
            {
              stage: '第一阶段：零部件先涨',
              trigger: 'AI算力需求推高存储资源预期',
              note: '内存条/硬盘/SSD 先出现涨价或价格支撑；已有“内存条硬盘错过复盘”作为第一阶段案例。'
            },
            {
              stage: '第二阶段：向整机传导观察',
              trigger: '零部件成本向整机端扩散',
              note: '观察笔记本、手机、游戏机等整机是否出现成本抬升、现货支撑或二级回收跟涨；必须防新品迭代、官方补贴、库存释放导致传导失败。'
            }
          ];

          for (const item of events) {
            const existingNode = await dbGet<any>(
              db,
              `SELECT id
               FROM speculation_cycle_events
               WHERE cycle_id = ?
                 AND stage = ?
                 AND trigger_event = ?
               LIMIT 1`,
              [cycleId, item.stage, item.trigger]
            );
            if (existingNode) continue;
            await dbRun(
              db,
              `INSERT INTO speculation_cycle_events
                 (cycle_id, record_time, stage, market_action, sentiment_level, participation_level,
                  trigger_event, risk_signal, source, note, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              [
                cycleId,
                '2026-06-29',
                item.stage,
                '观察传导链路，不直接下结论',
                '观察',
                '低',
                item.trigger,
                '上游涨价不等于整机必涨，需要真实成交和库存验证',
                '用户观察/系统整理',
                item.note
              ]
            );
          }
        }
      }
    }
  },
  {
    id: '20260701_001_refine_longchao_dragon_profile',
    name: 'Refine Longchao dragon note profile',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'product_archives'))) return;

      const archive = await dbGet<any>(
        db,
        `SELECT id, raw_description, theme_design, risk_basis, experience_note, pending_questions
         FROM product_archives
         WHERE category_name = ?
           AND object_name = ?
           AND COALESCE(variant_name, '') = ?
           AND COALESCE(is_deleted, 0) = 0
         LIMIT 1`,
        ['纪念钞', '龙钞', '散张']
      );
      if (!archive) return;

      const appendOnce = (current: unknown, marker: string, addition: string) => {
        const text = String(current || '').trim();
        if (text.includes(marker)) return text;
        return [text, addition].filter(Boolean).join('\n\n');
      };

      await dbRun(
        db,
        `UPDATE product_archives
         SET raw_description = ?,
             theme_design = ?,
             risk_basis = ?,
             experience_note = ?,
             pending_questions = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          appendOnce(
            archive.raw_description,
            '生肖纪念钞系列龙头',
            '补充：龙钞是生肖纪念钞系列龙头，第一轮定锚意义强。龙题材、颜值、设计和首发身份叠加，不能和后续蛇、马、羊等跟随品种简单等同。'
          ),
          appendOnce(
            archive.theme_design,
            '龙头属性强于后续跟随品',
            '龙头属性强于后续跟随品：后续生肖钞会提前发行并吃预期情绪，但龙钞的系列起点、题材辨识度和市场记忆更强。'
          ),
          appendOnce(
            archive.risk_basis,
            '大学生/新人集中冲入',
            '筹码风险：龙钞大量筹码在币商手里时更容易形成控盘和价格维护，也有真实承接；但大学生/新人集中冲入后，筹码会分散，且容易不计成本向市场抛货，可能快速破坏盘口和价格秩序。'
          ),
          appendOnce(
            archive.experience_note,
            '新人冲入不是强承接',
            '经验口径：新人冲入不是强承接信号，弱市里反而可能是筹码失控和无纪律抛压的前兆。龙钞可以等低位和专业信号，其它生肖钞主要作为市场温度参照。'
          ),
          appendOnce(
            archive.pending_questions,
            '币商持仓集中度',
            '待确认：币商持仓集中度、真实承接是否仍在、新人筹码是否开始分散、低价抛货是否放大。'
          ),
          archive.id
        ]
      );

      if (!(await migrationTableExists(db, 'product_archive_stages'))) return;
      const existingStage = await dbGet<any>(
        db,
        `SELECT id
         FROM product_archive_stages
         WHERE archive_id = ?
           AND stage_name = ?
           AND COALESCE(is_deleted, 0) = 0
         LIMIT 1`,
        [archive.id, '筹码集中与新人冲击']
      );
      if (existingStage) return;

      await dbRun(
        db,
        `INSERT INTO product_archive_stages
          (archive_id, stage_name, time_text, stage_type, stage_summary, action_rule,
           evidence_note, confidence, sort_order, note, is_deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'rough', 2, '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          archive.id,
          '筹码集中与新人冲击',
          '弱市和后续生肖钞发行阶段',
          '筹码结构 / 真实承接 / 新人抛压',
          '龙钞的龙头属性和真实承接仍然是核心优势；但当筹码从币商集中持有转向大学生/新人分散持有时，市场容易出现无纪律抛压，价格秩序会被快速打散。',
          '不要把新人热度直接当作强承接。重点观察币商是否继续护盘、真实成交是否稳定、低价抛货是否放大；其它生肖钞只做横向温度参照。',
          '来源：用户口述补充，龙钞画像/品种档案口径。'
        ]
      );
    }
  },
  {
    id: '20260703_001_seed_longchao_price_task',
    name: 'Seed Longchao price update task',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'task_center_tasks'))) return;

      const configJson = JSON.stringify({ page_size: 100, max_pages: 3 });
      await dbRun(
        db,
        `INSERT OR IGNORE INTO task_center_tasks
           (task_key, name, domain, workspace, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'longchao_price_update',
          '龙钞价格更新',
          'price',
          'business',
          'longchao_price_update',
          1,
          '18:10',
          'every_day',
          34,
          configJson,
          'pending',
          '每天抓取爱藏龙钞散张、标10带4、标10不带4价格，并写入商品价格工作台'
        ]
      );
      await dbRun(
        db,
        `UPDATE task_center_tasks
         SET name = ?,
             task_type = ?,
             domain = ?,
             workspace = ?,
             enabled = 1,
             schedule_time = CASE WHEN schedule_time IS NULL OR schedule_time = '' THEN ? ELSE schedule_time END,
             schedule_days = ?,
             priority = ?,
             config_json = CASE
               WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN ?
               ELSE config_json
             END,
             last_message = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE task_key = ?`,
        [
          '龙钞价格更新',
          'longchao_price_update',
          'price',
          'business',
          '18:10',
          'every_day',
          34,
          configJson,
          '每天抓取爱藏龙钞散张、标10带4、标10不带4价格，并写入商品价格工作台',
          'longchao_price_update'
        ]
      );
    }
  },
  {
    id: '20260704_001_add_longchao_summer_lull_profile',
    name: 'Add Longchao summer lull profile note',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'category_profiles'))) return;

      const profile = await dbGet<any>(
        db,
        `SELECT id, experience_notes, decision_notes, extra_json
         FROM category_profiles
         WHERE category_name = ?
           AND COALESCE(is_deleted, 0) = 0
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id
         LIMIT 1`,
        ['纪念钞']
      );
      if (!profile) return;

      const appendOnce = (current: string | null | undefined, marker: string, addition: string) => {
        const text = String(current || '').trim();
        if (text.includes(marker)) return text;
        return text ? `${text}\n\n${addition}` : addition;
      };

      let extra: Record<string, any> = {};
      try {
        extra = profile.extra_json ? JSON.parse(profile.extra_json) : {};
      } catch {
        extra = {};
      }

      const uncertainFactors = Array.isArray(extra.uncertain_factors) ? extra.uncertain_factors : [];
      extra.uncertain_factors = Array.from(
        new Set([
          ...uncertainFactors.filter((item: any) => item !== 'summer_lull_possible_needs_validation'),
          'summer_lull_may_to_early_sep'
        ])
      );
      extra.seasonality = {
        ...(extra.seasonality || {}),
        summer_lull: {
          label: '歇夏期',
          months: [5, 6, 7, 8],
          extension: '9月初',
          time_text: '5月、6月、7月、8月到9月初',
          caliber: '用户经验口径，先作为龙钞画像季节性观察，不直接生成操作结论',
          note: '这几个月份是歇夏期，市场活跃度和承接可能阶段性变弱；执行前仍看实际盘口、币商信号和价格弹性。'
        }
      };

      const experienceNotes = appendOnce(
        profile.experience_notes,
        '歇夏期',
        '季节性补充：龙钞存在歇夏期，5月、6月、7月、8月到9月初属于歇夏观察窗口；这属于用户经验口径，主要用于解释阶段性活跃度和承接变弱，不直接替代价格、币商信号和真实盘口。'
      );
      const decisionNotes = appendOnce(
        profile.decision_notes,
        '歇夏窗口',
        '计划辅助口径：歇夏窗口内更重视价格是否压出安全边际、币商是否护盘、真实成交是否恢复；不单独用季节性判断替代龙钞主线。'
      );

      await dbRun(
        db,
        `UPDATE category_profiles
         SET experience_notes = ?,
             decision_notes = ?,
             extra_json = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [experienceNotes, decisionNotes, JSON.stringify(extra), profile.id]
      );
    }
  },
  {
    id: '20260705_001_set_longyinbi_2026_xintai_start_date',
    name: 'Set Longyinbi 2026 Xintai source mapping start date',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'source_mappings'))) return;

      const row = await dbGet<any>(
        db,
        `SELECT id, external_meta_json, note
         FROM source_mappings
         WHERE source_key = ?
           AND category_name = ?
           AND object_name = ?
           AND variant_name = ?
         ORDER BY id DESC
         LIMIT 1`,
        ['airmb_longyinbi_presale', '纪念币', '龙银币', '2026年信泰评级']
      );
      if (!row) return;

      let meta: Record<string, any> = {};
      try {
        meta = row.external_meta_json ? JSON.parse(row.external_meta_json) : {};
      } catch {
        meta = {};
      }
      meta.start_date = '2026-07-05';
      meta.start_date_reason = '2026 信泰评级旧历史来源不准，从 2026-07-05 起自动采集；旧历史由用户手工补';

      const noteText = String(row.note || '').trim();
      const noteAddition = '自动采集从 2026-07-05 开始；此前历史由用户手工补。';
      const nextNote = noteText.includes('2026-07-05')
        ? noteText
        : noteText
          ? `${noteText}\n${noteAddition}`
          : noteAddition;

      await dbRun(
        db,
        `UPDATE source_mappings
         SET external_meta_json = ?,
             note = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(meta), nextNote, row.id]
      );

      if (await migrationTableExists(db, 'task_center_tasks')) {
        const task = await dbGet<any>(
          db,
          "SELECT id, config_json FROM task_center_tasks WHERE task_key = ?",
          ['longyinbi_price_update']
        );
        if (task) {
          let config: Record<string, any> = {};
          try {
            config = task.config_json ? JSON.parse(task.config_json) : {};
          } catch {
            config = {};
          }
          config.target_offsets = {
            ...(config.target_offsets || {}),
            '2025年信泰评级': 100,
            '2026年信泰评级': -70
          };
          config.target_start_dates = {
            ...(config.target_start_dates || {}),
            '2026年信泰评级': '2026-07-05'
          };
          await dbRun(
            db,
            `UPDATE task_center_tasks
             SET config_json = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [JSON.stringify(config), task.id]
          );
        }
      }
    }
  },
  {
    id: '20260709_001_extend_opinion_cognition_profiles',
    name: 'Extend opinion cognition sample fields',
    run: async (db: any) => {
      await ensureMigrationColumn(db, 'opinion_records', 'judgment_basis', 'TEXT');
      await ensureMigrationColumn(db, 'opinion_records', 'validation_note', 'TEXT');

      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS opinion_person_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          person_name TEXT NOT NULL UNIQUE,
          profile_intro TEXT,
          credibility_rating INTEGER NOT NULL DEFAULT 0 CHECK (credibility_rating >= 0 AND credibility_rating <= 5),
          display_order INTEGER,
          skill_tags TEXT,
          weak_tags TEXT,
          credibility_basis TEXT,
          ability_scores TEXT,
          behavior_strengths TEXT,
          behavior_biases TEXT,
          error_handling TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await ensureMigrationColumn(db, 'opinion_person_profiles', 'display_order', 'INTEGER');
      await ensureMigrationColumn(db, 'opinion_person_profiles', 'skill_tags', 'TEXT');
      await ensureMigrationColumn(db, 'opinion_person_profiles', 'weak_tags', 'TEXT');
      await ensureMigrationColumn(db, 'opinion_person_profiles', 'credibility_basis', 'TEXT');
      await ensureMigrationColumn(db, 'opinion_person_profiles', 'ability_scores', 'TEXT');
      await ensureMigrationColumn(db, 'opinion_person_profiles', 'behavior_strengths', 'TEXT');
      await ensureMigrationColumn(db, 'opinion_person_profiles', 'behavior_biases', 'TEXT');
      await ensureMigrationColumn(db, 'opinion_person_profiles', 'error_handling', 'TEXT');
      await dbExec(db, 'CREATE INDEX IF NOT EXISTS idx_opinion_person_profiles_order ON opinion_person_profiles(display_order, person_name)');
    }
  },
  {
    id: '20260709_002_extend_workspace_tags_for_master_data',
    name: 'Extend workspace tags for category object variant tagging',
    run: async (db: any) => {
      await ensureMigrationColumn(db, 'workspace_tags', 'tag_group', "TEXT NOT NULL DEFAULT '交易'");
      await ensureMigrationColumn(db, 'workspace_tags', 'color', "TEXT NOT NULL DEFAULT 'indigo'");
      await ensureMigrationColumn(db, 'workspace_tags', 'description', "TEXT NOT NULL DEFAULT ''");
      await ensureMigrationColumn(db, 'workspace_tags', 'applicable_scopes', "TEXT NOT NULL DEFAULT '[\"category\",\"object\",\"variant\"]'");
      await ensureMigrationColumn(db, 'workspace_tags', 'status', "TEXT NOT NULL DEFAULT 'active'");
      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS entity_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace TEXT NOT NULL DEFAULT 'business',
          entity_type TEXT NOT NULL,
          entity_id INTEGER NOT NULL,
          tag_id INTEGER NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(workspace, entity_type, entity_id, tag_id),
          FOREIGN KEY (tag_id) REFERENCES workspace_tags(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_entity_tags_lookup ON entity_tags(workspace, entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(workspace, tag_id);
      `);
    }
  },
  {
    id: '20260710_001_seed_longchao_false_kill_rebound_case',
    name: 'Seed Longchao false-kill rebound case',
    run: async (db: any) => {
      const appendOnce = (current: unknown, marker: string, addition: string) => {
        const text = String(current || '').trim();
        if (text.includes(marker)) return text;
        return [text, addition].filter(Boolean).join('\n\n');
      };

      if (await migrationTableExists(db, 'product_archives')) {
        const archive = await dbGet<any>(
          db,
          `SELECT id, experience_note, risk_basis, pending_questions
           FROM product_archives
           WHERE category_name = ?
             AND object_name = ?
             AND COALESCE(variant_name, '') = ?
             AND COALESCE(is_deleted, 0) = 0
           LIMIT 1`,
          ['纪念钞', '龙钞', '散张']
        );

        if (archive) {
          await dbRun(
            db,
            `UPDATE product_archives
             SET experience_note = ?,
                 risk_basis = ?,
                 pending_questions = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              appendOnce(
                archive.experience_note,
                '50元底仓、75元兑现',
                '实战案例：常关注主播看好龙钞，在弱市错杀区约50元建立几千张底仓，2026-07-10 左右约75元兑现，单张约+25元，收益约50%，周期不到两个月。这个案例验证：龙头品种弱市错杀时，如果仍有人持续惦记且有资金愿意推动，低位底仓的赔率很舒服；加速拉升后要考虑兑现，不把信仰当卖点。'
              ),
              appendOnce(
                archive.risk_basis,
                '整刀先拉不能直接倒推散张',
                '风险补充：弱市淡季里龙钞突然拉升，更像有资金主动推动。标10/整刀先强不能直接倒推散张全面承接，后续仍要看散张是否站稳、回踩是否破位、真实成交是否跟上。'
              ),
              appendOnce(
                archive.pending_questions,
                '拉盘后散张是否补涨确认',
                '待确认：拉盘后散张是否补涨确认，标10带4/不带4能否守住抬升后的价格区间，是否有真实成交而非单纯挂高报价。'
              ),
              archive.id
            ]
          );

          if (await migrationTableExists(db, 'product_archive_stages')) {
            const existingStage = await dbGet<any>(
              db,
              `SELECT id
               FROM product_archive_stages
               WHERE archive_id = ?
                 AND stage_name = ?
                 AND COALESCE(is_deleted, 0) = 0
               LIMIT 1`,
              [archive.id, '弱市错杀底仓到拉盘兑现']
            );

            if (!existingStage) {
              await dbRun(
                db,
                `INSERT INTO product_archive_stages
                  (archive_id, stage_name, time_text, stage_type, price_start, price_high, price_low, price_end,
                   stage_summary, action_rule, evidence_note, confidence, sort_order, note, is_deleted, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'case', 3, '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [
                  archive.id,
                  '弱市错杀底仓到拉盘兑现',
                  '2026年5月下旬至2026-07-10',
                  '弱市错杀 / 龙头资金记忆 / 拉盘兑现',
                  50,
                  75,
                  50,
                  75,
                  '弱市淡季中，龙钞仍有主播和资金持续惦记；50元附近错杀底仓，到75元附近兑现，不到两个月约50%收益。案例重点不是追涨，而是验证“有人愿意做的龙头”在错杀区的赔率。',
                  '错杀只做仍有人惦记、资金愿意推动的龙头；低位用底仓试错，拉升到40%-60%收益区间先考虑兑现一部分；加速后不把低吸逻辑变成追高逻辑。',
                  '来源：用户 2026-07-10 复盘口述，常关注主播实盘案例；75元为外部卖出案例，系统自动价格只作旁证。'
                ]
              );
            }
          }
        }
      }

      if (await migrationTableExists(db, 'category_profiles')) {
        const profile = await dbGet<any>(
          db,
          `SELECT id, experience_notes, decision_notes
           FROM category_profiles
           WHERE category_name = ?
             AND COALESCE(is_deleted, 0) = 0
           ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id
           LIMIT 1`,
          ['纪念钞']
        );

        if (profile) {
          await dbRun(
            db,
            `UPDATE category_profiles
             SET experience_notes = ?,
                 decision_notes = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              appendOnce(
                profile.experience_notes,
                '弱市错杀底仓到拉盘兑现',
                '错杀打法验证：2026-07-10 用户复盘提到，常关注主播看好龙钞，在约50元附近持有几千张底仓，约75元卖出，收益约50%，周期不到两个月。这个案例说明：弱市里不是买所有下跌，而是买仍有人惦记、资金愿意推动的龙头错杀。'
              ),
              appendOnce(
                profile.decision_notes,
                '弱市错杀买龙头',
                '规则口径：弱市错杀优先看龙头、资金记忆、专业关注和真实承接；低位底仓舒服，加速拉盘后新仓不追或只等回踩。达到40%-60%收益区间时，先考虑兑现一部分，不把长期看好变成短线恋战。'
              ),
              profile.id
            ]
          );
        }
      }

      if (await migrationTableExists(db, 'rule_experiences')) {
        const title = '龙钞弱市错杀底仓到拉盘兑现案例';
        const existingRule = await dbGet<any>(
          db,
          `SELECT id
           FROM rule_experiences
           WHERE title = ?
             AND COALESCE(is_deleted, 0) = 0
           LIMIT 1`,
          [title]
        );

        if (!existingRule) {
          await dbRun(
            db,
            `INSERT INTO rule_experiences
              (title, type, track, source_case, core_content, summary_conclusion, note, is_deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              title,
              'case_rule',
              '纪念钞 / 龙钞 / 弱市错杀',
              '常关注主播龙钞案例：约50元附近底仓几千张，2026-07-10 左右约75元兑现，不到两个月收益约50%。',
              '错杀不是买所有下跌品，而是买仍有人惦记、资金愿意推动、市场记忆强的龙头。低位底仓是赔率点，拉盘加速后要从“低吸逻辑”切换到“兑现纪律”。',
              '弱市错杀买龙头，拉盘兑现，不恋战；龙钞验证了“有人愿意做”的品种比单纯便宜的品种更有弹性。',
              '用户 2026-07-10 复盘口述；用于认知中心和规则经验召回。75元为外部卖出案例，不等同于系统自动采集散张价格。'
            ]
          );
        }
      }
    }
  },
  {
    id: '20260710_002_seed_emotional_pump_no_chase_rule',
    name: 'Seed emotional pump no-chase hard rule',
    run: async (db: any) => {
      const appendOnce = (current: unknown, marker: string, addition: string) => {
        const text = String(current || '').trim();
        if (text.includes(marker)) return text;
        return [text, addition].filter(Boolean).join('\n\n');
      };

      if (await migrationTableExists(db, 'rule_experiences')) {
        const title = '弱市情绪拉盘后手直接放弃';
        const existingRule = await dbGet<any>(
          db,
          `SELECT id
           FROM rule_experiences
           WHERE title = ?
             AND COALESCE(is_deleted, 0) = 0
           LIMIT 1`,
          [title]
        );

        if (!existingRule) {
          await dbRun(
            db,
            `INSERT INTO rule_experiences
              (title, type, track, source_case, core_content, summary_conclusion, note, is_deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              title,
              'hard_rule',
              '情绪品 / 龙头错杀 / 资金拉盘',
              '龙钞 2026-07-10 复盘：弱市淡季里标10/整刀快速拉升，低位底仓者兑现，后手追高大概率接盘。',
              '凡是弱市里突然被资金情绪拉起来的品种，低位底仓可兑现，后手追高直接放弃。低位是错杀赔率，拉盘是情绪兑现，后手进去是接盘风险区。',
              '情绪拉盘后手，不看，不追，不接。',
              '人工摁死规则，不走复杂评分。适用于龙钞、纪念币、泡泡玛特及其它情绪资金推动品种；如果只有资金情绪推动、没有新的基本面变化，后手不把低吸逻辑拿来追高。'
            ]
          );
        }
      }

      if (await migrationTableExists(db, 'category_profiles')) {
        const profile = await dbGet<any>(
          db,
          `SELECT id, decision_notes
           FROM category_profiles
           WHERE category_name = ?
             AND COALESCE(is_deleted, 0) = 0
           ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id
           LIMIT 1`,
          ['纪念钞']
        );

        if (profile) {
          await dbRun(
            db,
            `UPDATE category_profiles
             SET decision_notes = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              appendOnce(
                profile.decision_notes,
                '情绪拉盘后手',
                '人工红线：凡是弱市里突然被资金情绪拉起来的品种，低位底仓可兑现，后手追高直接放弃；情绪拉盘后手，不看，不追，不接。'
              ),
              profile.id
            ]
          );
        }
      }
    }
  },
  {
    id: '20260714_001_add_variant_xianyu_heat',
    name: 'Add manual Xianyu heat level to variants',
    run: async (db: any) => {
      await ensureMigrationColumn(
        db,
        'variants',
        'xianyu_heat_level',
        "TEXT NOT NULL DEFAULT 'none' CHECK (xianyu_heat_level IN ('none', 'low', 'medium', 'high', 'very_high'))"
      );
      await ensureMigrationColumn(db, 'variants', 'xianyu_heat_updated_at', 'TEXT');
    }
  },
  {
    id: '20260715_001_add_record_source_context',
    name: 'Preserve source context for derived business records',
    run: async (db: any) => {
      const tables = ['watchlist_items', 'business_reviews', 'rule_experiences', 'manual_todos'];
      for (const table of tables) {
        await ensureMigrationColumn(db, table, 'source_type', 'TEXT');
        await ensureMigrationColumn(db, table, 'source_id', 'TEXT');
        await ensureMigrationColumn(db, table, 'source_context_json', 'TEXT');
      }

      for (const table of tables) {
        if (await migrationTableExists(db, table)) {
          await dbExec(
            db,
            `CREATE INDEX IF NOT EXISTS ${quoteMigrationIdentifier(`idx_${table}_source`)} ON ${quoteMigrationIdentifier(table)}(source_type, source_id)`
          );
        }
      }
    }
  },
  {
    id: '20260715_002_extend_price_quality_alert_reviews',
    name: 'Bind quality alerts to corrections and immutable snapshots',
    run: async (db: any) => {
      const columns: Array<[string, string]> = [
        ['record_id', 'INTEGER'],
        ['alert_type', 'TEXT'],
        ['action', 'TEXT'],
        ['reviewed_by', 'TEXT'],
        ['correction_record_id', 'INTEGER'],
        ['basis_json', 'TEXT'],
        ['alert_snapshot_json', 'TEXT'],
        ['last_checked_at', 'TEXT']
      ];
      for (const [column, definition] of columns) {
        await ensureMigrationColumn(db, 'price_quality_alert_reviews', column, definition);
      }
      if (await migrationTableExists(db, 'price_quality_alert_reviews')) {
        await dbExec(db, 'CREATE INDEX IF NOT EXISTS idx_price_quality_alert_reviews_record ON price_quality_alert_reviews(record_id, alert_type, status)');
      }
    }
  },
  {
    id: '20260715_003_add_price_import_batches',
    name: 'Add idempotent price import batches',
    run: async (db: any) => {
      await dbExec(
        db,
        `CREATE TABLE IF NOT EXISTS price_import_batches (
          batch_id TEXT PRIMARY KEY,
          payload_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('processing', 'completed')),
          result_json TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        )`
      );
      await dbExec(db, 'CREATE INDEX IF NOT EXISTS idx_price_import_batches_created_at ON price_import_batches(created_at DESC)');
    }
  },
  {
    id: '20260716_001_add_manual_todo_completion_result',
    name: 'Add completion result to manual todos',
    run: async (db: any) => {
      await ensureMigrationColumn(db, 'manual_todos', 'completion_result', 'TEXT');
    }
  },
  {
    id: '20260716_002_add_price_import_previews',
    name: 'Persist price import previews for snapshot validation',
    run: async (db: any) => {
      await dbExec(
        db,
        `CREATE TABLE IF NOT EXISTS price_import_previews (
          batch_id TEXT PRIMARY KEY,
          payload_hash TEXT NOT NULL,
          preview_hash TEXT NOT NULL,
          preview_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          consumed_at TEXT
        )`
      );
      await dbExec(db, 'CREATE INDEX IF NOT EXISTS idx_price_import_previews_created_at ON price_import_previews(created_at DESC)');
    }
  },
  {
    id: '20260718_001_seed_crybaby_crying_bunny_source_mapping',
    name: 'Seed Crybaby crying bunny Qiandao source mapping',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'source_mappings'))) return;

      const category = await dbGet<any>(
        db,
        "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
        ['泡泡玛特']
      );
      const object = category
        ? await dbGet<any>(
          db,
          "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [category.id, '眼泪工厂']
        )
        : undefined;
      const variant = object
        ? await dbGet<any>(
          db,
          "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [object.id, '哭哭兔']
        )
        : undefined;
      const status = category && object && variant ? 'enabled' : 'unmapped';
      const note = status === 'enabled'
        ? '千岛眼泪工厂系列-搪胶脸毛绒盲盒；不要误接同名40元手办款'
        : '初始化时未找到泡泡玛特/眼泪工厂/哭哭兔主数据，请在数据源映射页面确认';
      const externalMeta = JSON.stringify({
        query: '眼泪工厂 哭哭兔',
        spu_id: '791072292330313271'
      });

      await dbRun(
        db,
        `INSERT OR IGNORE INTO source_mappings
           (source_key, source_name, external_key, external_name, external_meta_json,
            category_id, object_id, variant_id, category_name, object_name, variant_name,
            status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'qiandao_popmart',
          '千岛泡泡玛特',
          '791072292330313271',
          '哭哭兔',
          externalMeta,
          category?.id || null,
          object?.id || null,
          variant?.id || 0,
          category?.name || '泡泡玛特',
          object?.name || '眼泪工厂',
          variant?.name || '哭哭兔',
          status,
          note
        ]
      );

      await dbRun(
        db,
        `UPDATE source_mappings
         SET source_name = ?,
             external_name = ?,
             external_meta_json = ?,
             category_id = ?,
             object_id = ?,
             variant_id = ?,
             category_name = ?,
             object_name = ?,
             variant_name = ?,
             status = CASE WHEN status = 'disabled' THEN status ELSE ? END,
             note = CASE WHEN status = 'disabled' THEN note ELSE ? END,
             updated_at = CURRENT_TIMESTAMP
         WHERE source_key = ? AND external_key = ?`,
        [
          '千岛泡泡玛特',
          '哭哭兔',
          externalMeta,
          category?.id || null,
          object?.id || null,
          variant?.id || 0,
          category?.name || '泡泡玛特',
          object?.name || '眼泪工厂',
          variant?.name || '哭哭兔',
          status,
          note,
          'qiandao_popmart',
          '791072292330313271'
        ]
      );
    }
  },
  {
    id: '20260718_002_seed_crybaby_crying_bunny_history',
    name: 'Seed Crybaby crying bunny master data and price history',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'categories'))
        || !(await migrationTableExists(db, 'objects'))
        || !(await migrationTableExists(db, 'variants'))
        || !(await migrationTableExists(db, 'price_records'))) {
        return;
      }

      const now = new Date().toISOString();
      await dbRun(
        db,
        `INSERT OR IGNORE INTO categories (name, created_at, updated_at)
         VALUES (?, ?, ?)`,
        ['泡泡玛特', now, now]
      );
      const category = await dbGet<any>(
        db,
        "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
        ['泡泡玛特']
      );
      if (!category) return;

      await dbRun(
        db,
        `INSERT OR IGNORE INTO objects (category_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        [category.id, '眼泪工厂', now, now]
      );
      const object = await dbGet<any>(
        db,
        "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
        [category.id, '眼泪工厂']
      );
      if (!object) return;

      await dbRun(
        db,
        `INSERT OR IGNORE INTO variants (object_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        [object.id, '哭哭兔', now, now]
      );
      const variant = await dbGet<any>(
        db,
        "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
        [object.id, '哭哭兔']
      );
      if (!variant) return;

      const history: Array<[string, number]> = [
        ['2025-07-18', 220],
        ['2025-08-01', 210],
        ['2025-08-08', 172],
        ['2025-08-22', 150],
        ['2025-09-12', 142],
        ['2025-09-26', 132],
        ['2025-10-24', 129],
        ['2025-12-19', 128],
        ['2026-01-02', 142],
        ['2026-01-16', 154],
        ['2026-01-30', 171],
        ['2026-02-13', 186],
        ['2026-02-20', 193],
        ['2026-02-27', 174],
        ['2026-03-06', 155],
        ['2026-03-27', 161],
        ['2026-04-10', 141],
        ['2026-04-24', 138],
        ['2026-05-08', 154],
        ['2026-05-22', 178],
        ['2026-06-05', 177],
        ['2026-06-19', 189],
        ['2026-06-26', 206],
        ['2026-07-17', 238],
        ['2026-07-18', 240]
      ];

      for (const [date, price] of history) {
        await dbRun(
          db,
          `INSERT INTO price_records
             (date, category, object_name, variant, price, source, note, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1
             FROM price_records
             WHERE date = ?
               AND category = ?
               AND object_name = ?
               AND COALESCE(variant, '') = ?
           )`,
          [
            date,
            '泡泡玛特',
            '眼泪工厂',
            '哭哭兔',
            price,
            '',
            '',
            now,
            now,
            date,
            '泡泡玛特',
            '眼泪工厂',
            '哭哭兔'
          ]
        );
      }

      if (await migrationTableExists(db, 'source_mappings')) {
        await dbRun(
          db,
          `UPDATE source_mappings
           SET category_id = ?,
               object_id = ?,
               variant_id = ?,
               category_name = ?,
               object_name = ?,
               variant_name = ?,
               status = CASE WHEN status = 'disabled' THEN status ELSE 'enabled' END,
               note = CASE
                 WHEN status = 'disabled' THEN note
                 ELSE '千岛眼泪工厂系列-搪胶脸毛绒盲盒；不要误接同名40元手办款'
               END,
               updated_at = CURRENT_TIMESTAMP
           WHERE source_key = ? AND external_key = ?`,
          [
            category.id,
            object.id,
            variant.id,
            category.name,
            object.name,
            variant.name,
            'qiandao_popmart',
            '791072292330313271'
          ]
        );
      }
    }
  },
  {
    id: '20260718_003_add_gold_silver_ratio_fx_auxiliary',
    name: 'Add USD/CNH auxiliary source for display-only gold silver ratio',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'task_center_tasks'))) return;
      const task = await dbGet<any>(
        db,
        "SELECT config_json FROM task_center_tasks WHERE task_key = 'precious_metal_market_update' LIMIT 1"
      );
      if (!task) return;

      let config: Record<string, any> = {};
      try {
        config = JSON.parse(String(task.config_json || '{}')) || {};
      } catch {
        config = {};
      }
      const configuredSymbols = Array.isArray(config.symbols)
        ? config.symbols.map((value: unknown) => String(value || '').trim().toUpperCase()).filter(Boolean)
        : String(config.symbols || 'XAUUSD,SGE_AGTD').split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
      config.symbols = Array.from(new Set([...configuredSymbols, 'USDCNH']));
      if (!Number.isFinite(Number(config.task_timeout_minutes)) || Number(config.task_timeout_minutes) <= 0) {
        config.task_timeout_minutes = 30;
      }

      await dbRun(
        db,
        `UPDATE task_center_tasks
         SET config_json = ?,
             last_message = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE task_key = 'precious_metal_market_update'`,
        [
          JSON.stringify(config),
          '每天拉取黄金现货、白银延期和美元兑人民币辅助数据；金银比只展示相对过热，不单独决定买卖'
        ]
      );
    }
  },
  {
    id: '20260719_001_create_self_cognition_profile',
    name: 'Create editable self cognition profile and immutable version history',
    run: async (db: any) => {
      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS self_cognition_profiles (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version_label TEXT NOT NULL,
          profile_date TEXT NOT NULL,
          phase_title TEXT NOT NULL,
          phase_summary TEXT NOT NULL,
          content_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS self_cognition_profile_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL DEFAULT 1,
          version_label TEXT NOT NULL,
          profile_date TEXT NOT NULL,
          change_note TEXT NOT NULL,
          phase_title TEXT NOT NULL,
          phase_summary TEXT NOT NULL,
          content_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (profile_id) REFERENCES self_cognition_profiles(id)
        );

        CREATE INDEX IF NOT EXISTS idx_self_cognition_profile_versions_date
          ON self_cognition_profile_versions(profile_id, datetime(created_at) DESC, id DESC);
      `);

      const existing = await dbGet<any>(db, 'SELECT id FROM self_cognition_profiles WHERE id = 1');
      if (existing) return;

      const seed = DEFAULT_SELF_COGNITION_PROFILE;
      const now = new Date().toISOString();
      const contentJson = JSON.stringify(seed.content);
      await dbRun(
        db,
        `INSERT INTO self_cognition_profiles
          (id, version_label, profile_date, phase_title, phase_summary, content_json, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        [
          seed.versionLabel,
          seed.profileDate,
          seed.phaseTitle,
          seed.phaseSummary,
          contentJson,
          now,
          now
        ]
      );
      await dbRun(
        db,
        `INSERT INTO self_cognition_profile_versions
          (profile_id, version_label, profile_date, change_note, phase_title, phase_summary, content_json, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        [
          seed.versionLabel,
          seed.profileDate,
          seed.changeNote,
          seed.phaseTitle,
          seed.phaseSummary,
          contentJson,
          now
        ]
      );
    }
  },
  {
    id: '20260728_001_clear_automated_longyinbi_price_notes',
    name: 'Remove automated Longyinbi price offset notes',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'price_records'))) return;

      await dbRun(
        db,
        `UPDATE price_records
         SET note = '',
             updated_at = CURRENT_TIMESTAMP
         WHERE category = '纪念币'
           AND object_name = '龙银币'
           AND variant IN ('2025年信泰评级', '2026年信泰评级')
           AND (
             TRIM(COALESCE(note, '')) GLOB '裸币价 *；信泰+*'
             OR TRIM(COALESCE(note, '')) GLOB '裸币价 *；信泰-*'
        )`
      );
    }
  },
  {
    id: '20260731_001_create_human_case_library',
    name: 'Create human behavior case library and seed first pattern cards',
    run: async (db: any) => {
      await dbExec(db, `
        CREATE TABLE IF NOT EXISTS behavior_patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          axis TEXT NOT NULL CHECK (axis IN ('market', 'human')),
          category TEXT NOT NULL CHECK (
            category IN ('market_structure', 'human_bias', 'execution_error', 'positive_discipline')
          ),
          summary TEXT NOT NULL DEFAULT '',
          trigger_phrases_json TEXT NOT NULL DEFAULT '[]',
          observable_actions_json TEXT NOT NULL DEFAULT '[]',
          mechanism TEXT NOT NULL DEFAULT '',
          risk_chain TEXT NOT NULL DEFAULT '',
          counter_question TEXT NOT NULL DEFAULT '',
          protective_action TEXT NOT NULL DEFAULT '',
          positive_counterpart TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
          sort_order INTEGER NOT NULL DEFAULT 0,
          note TEXT NOT NULL DEFAULT '',
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE UNIQUE INDEX IF NOT EXISTS ux_behavior_patterns_active_name
          ON behavior_patterns(axis, name)
          WHERE is_deleted = 0;
        CREATE INDEX IF NOT EXISTS idx_behavior_patterns_display
          ON behavior_patterns(is_deleted, status, axis, category, sort_order, id);

        CREATE TABLE IF NOT EXISTS behavior_cases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          origin_type TEXT NOT NULL DEFAULT 'other' CHECK (
            origin_type IN ('self', 'other', 'public', 'unconfirmed')
          ),
          subject_alias TEXT NOT NULL DEFAULT '',
          source_note TEXT NOT NULL DEFAULT '',
          evidence_level TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (
            evidence_level IN ('first_hand', 'documented', 'second_hand', 'unconfirmed')
          ),
          case_date TEXT,
          track TEXT NOT NULL DEFAULT '',
          project_name TEXT NOT NULL DEFAULT '',
          background TEXT NOT NULL,
          visible_information TEXT NOT NULL DEFAULT '',
          pressure_context TEXT NOT NULL DEFAULT '',
          action_taken TEXT NOT NULL,
          result TEXT NOT NULL DEFAULT '',
          action_quality TEXT NOT NULL DEFAULT 'unknown' CHECK (
            action_quality IN ('good', 'flawed', 'bad', 'mixed', 'unknown')
          ),
          outcome_type TEXT NOT NULL DEFAULT 'unknown' CHECK (
            outcome_type IN ('profit', 'loss', 'avoided_loss', 'sold_early', 'ongoing', 'mixed', 'unknown')
          ),
          self_response TEXT NOT NULL,
          learn_to_keep TEXT NOT NULL DEFAULT '',
          learn_to_avoid TEXT NOT NULL DEFAULT '',
          applicability_boundary TEXT NOT NULL DEFAULT '',
          linked_rule_refs_json TEXT NOT NULL DEFAULT '[]',
          source_type TEXT NOT NULL DEFAULT '',
          source_id TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_behavior_cases_list
          ON behavior_cases(is_deleted, case_date DESC, updated_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_behavior_cases_origin
          ON behavior_cases(is_deleted, origin_type, action_quality, outcome_type);
        CREATE INDEX IF NOT EXISTS idx_behavior_cases_source
          ON behavior_cases(source_type, source_id, is_deleted);

        CREATE TABLE IF NOT EXISTS behavior_case_pattern_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          case_id INTEGER NOT NULL,
          pattern_id INTEGER NOT NULL,
          role TEXT NOT NULL DEFAULT 'secondary' CHECK (role IN ('primary', 'secondary')),
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(case_id, pattern_id),
          FOREIGN KEY (case_id) REFERENCES behavior_cases(id) ON DELETE CASCADE,
          FOREIGN KEY (pattern_id) REFERENCES behavior_patterns(id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_behavior_case_pattern_case
          ON behavior_case_pattern_links(case_id, role, pattern_id);
        CREATE INDEX IF NOT EXISTS idx_behavior_case_pattern_pattern
          ON behavior_case_pattern_links(pattern_id, role, case_id);
      `);

      const seedPatterns = [
        {
          name: '暴涨后崩跌',
          axis: 'market',
          category: 'market_structure',
          summary: '价格在情绪和资金推动下快速远离正常承接，随后因兑现、补货或增量买家不足而剧烈回落。',
          triggers: ['连续急涨', '价格远离正常消费逻辑', '全民讨论'],
          actions: ['高位追入', '把暴涨继续外推', '忽略退出流动性'],
          mechanism: '暴涨阶段的成交证明有人换手，不等于后续仍有足够增量资金承接。',
          riskChain: '急涨 → 情绪透支 → 后手接力变弱 → 高位回落 → 流动性收缩',
          counterQuestion: '如果今天没有这段涨幅，我还会认可当前价格和承接吗？',
          protectiveAction: '把急涨视为兑现窗口，重新检查增量买家、后续供给和退出深度。',
          positiveCounterpart: '分批兑现、保留主动权',
          sortOrder: 10
        },
        {
          name: '补货结构反转',
          axis: 'market',
          category: 'market_structure',
          summary: '供给从稀缺或慢放切换到连续、大范围或长期补货，原有稀缺逻辑失效。',
          triggers: ['多渠道补货', '无限制放货', '通货化'],
          actions: ['继续按稀缺品估值', '把补货当短期噪音'],
          mechanism: '供给结构变化会改变价格中枢，旧逻辑不能继续支撑原仓位。',
          riskChain: '补货扩大 → 稀缺溢价压缩 → 成交变慢 → 阴跌 → 库存挂树',
          counterQuestion: '现在支撑价格的还是稀缺，还是我不愿承认供给已经变了？',
          protectiveAction: '出现确定补货信号先减仓，再观察新供给下的真实承接。',
          positiveCounterpart: '逻辑变化时先降低风险',
          sortOrder: 20
        },
        {
          name: '弱市集中放量',
          axis: 'market',
          category: 'market_structure',
          summary: '市场承接偏弱时，多渠道或大批量供应在短期内集中释放。',
          triggers: ['弱市', '多渠道同时供货', '短期大量到货'],
          actions: ['只看题材和颜值', '把期货轻溢价当真实承接'],
          mechanism: '弱市资金有限，集中供给会优先打穿承接，题材加分无法抵消供需压力。',
          riskChain: '弱承接 → 集中到货 → 买盘不足 → 慢跌 → 被动退出',
          counterQuestion: '现有买盘真的能消化这批货，还是只在到货前维持表面价格？',
          protectiveAction: '优先看短期可流通量和到货节奏，必要时到货前主动退出。',
          positiveCounterpart: '先看承接容量，再看故事',
          sortOrder: 30
        },
        {
          name: '反抽不是止跌',
          axis: 'market',
          category: 'market_structure',
          summary: '下跌后的短期反弹只能证明出现买盘，不能单独证明结构已经反转。',
          triggers: ['暴跌后反弹', '单日大涨', '回到短期均线'],
          actions: ['把第一根反弹当反转', '忽略低点是否继续下移'],
          mechanism: '反抽可能来自空头回补、短线资金或流动性修复，结构确认需要后续路径。',
          riskChain: '深跌 → 技术反抽 → 误判反转 → 追入 → 再次下探',
          counterQuestion: '它只是弹了一下，还是已经证明止跌、承接和回踩质量？',
          protectiveAction: '继续观察后续几天走势、回踩质量和低点结构，不因单次反弹恢复权限。',
          positiveCounterpart: '等待结构确认',
          sortOrder: 40
        },
        {
          name: '资金拉盘',
          axis: 'market',
          category: 'market_structure',
          summary: '少量筹码、集中流量或资金推动造成短期价格快速抬升，真实成交不等于长期承接。',
          triggers: ['收货价持续抬高', '短期翻倍', '定向底货异常走强'],
          actions: ['把拉盘当基本面重估', '后手高位补票'],
          mechanism: '拉盘能制造成交和价格，但最终仍需要更晚的买家接住筹码。',
          riskChain: '筹码集中 → 快速抬价 → FOMO 接力 → 放量兑现 → 后手接盘',
          counterQuestion: '当前买家是终端需求，还是下一轮寻找接盘的资金？',
          protectiveAction: '低位仓可按计划兑现，后手不因真实成交而追高。',
          positiveCounterpart: '区分价格推动与真实需求',
          sortOrder: 50
        },
        {
          name: '贪婪与不兑现',
          axis: 'human',
          category: 'human_bias',
          summary: '盈利扩大后不断上调心理目标，把已经获得的主动权重新交给市场。',
          triggers: ['还能更高', '再多赚一点', '卖了就买不回来'],
          actions: ['暴涨不卖', '临时取消退出计划', '利润回吐后继续等'],
          mechanism: '浮盈会强化自我正确感，让人低估回撤和流动性变化。',
          riskChain: '盈利 → 自信增强 → 拒绝兑现 → 回撤 → 从主动卖出变成被迫处理',
          counterQuestion: '我是在执行原计划，还是因为已经赚钱而临时变得更贪？',
          protectiveAction: '上涨前写好阶梯退出，触发后不允许因为情绪上调全部目标。',
          positiveCounterpart: '分批兑现、接受卖飞',
          sortOrder: 110
        },
        {
          name: '恐惧与过度防守',
          axis: 'human',
          category: 'human_bias',
          summary: '上一轮损失或弱市背景压制新判断，把所有相似机会一票否决。',
          triggers: ['上次就被反撸', '这次肯定也不行', '还是别碰了'],
          actions: ['证据变化后仍拒绝重评', '把防守变成完全不观察'],
          mechanism: '近期痛苦经历会被高估，导致风险识别从保护升级为僵化回避。',
          riskChain: '旧损失阴影 → 拒绝重新观察 → 新证据被忽略 → 完全踏空',
          counterQuestion: '我是在识别当前风险，还是只是在躲避上一次的痛苦？',
          protectiveAction: '保留观察和小参与权，用当前证据重新判断，不用旧伤替代新分析。',
          positiveCounterpart: '风险敏感但允许重新验证',
          sortOrder: 120
        },
        {
          name: '沉没成本绑架决策',
          axis: 'human',
          category: 'human_bias',
          summary: '过去投入的时间、资金和情绪开始主导现在是否继续持有。',
          triggers: ['等回本', '已经拿这么久', '现在卖太亏', '再等等'],
          actions: ['死扛', '补仓摊平', '拒绝退出', '只谈成本不谈逻辑'],
          mechanism: '不甘心承认过去投入已经损失，把持有当成修复自尊而不是重新决策。',
          riskChain: '小亏 → 拖延 → 中亏 → 压力增加 → 被迫割肉 → 错过新机会',
          counterQuestion: '如果现在空仓，我还会在这个价格买入吗？',
          protectiveAction: '只按当前结构、未来概率、风险收益比和失效条件重新判断。',
          positiveCounterpart: '承认错误、归零判断、快速退出',
          sortOrder: 130
        },
        {
          name: '确认偏误与供给幻想',
          axis: 'human',
          category: 'human_bias',
          summary: '先相信不会补货或逻辑仍在，再主动寻找支持原判断的信息。',
          triggers: ['官方应该不会补', '这次只是小补', '价格还能扛住'],
          actions: ['忽略确定风险消息', '只关注有利信息', '用反弹证明自己正确'],
          mechanism: '持仓后更愿意保护原判断，容易把反证解释成暂时噪音。',
          riskChain: '先入为主 → 过滤反证 → 逻辑变化未处理 → 风险持续扩大',
          counterQuestion: '什么证据出现时，我愿意承认原判断已经失效？',
          protectiveAction: '持仓前写清反证条件，出现确定消息先减仓而不是先解释。',
          positiveCounterpart: '主动寻找反方证据',
          sortOrder: 140
        },
        {
          name: 'FOMO 与追高',
          axis: 'human',
          category: 'human_bias',
          summary: '因为别人赚钱、价格加速或错失感而在赔率恶化后补票。',
          triggers: ['大家都赚钱', '再不上就没机会', '原价没抢到只能追'],
          actions: ['高位补票', '忽略后续供给', '用上涨替代估值'],
          mechanism: '错失感会把“不参与的遗憾”放大，却压低高位接盘的真实风险。',
          riskChain: '看见暴涨 → 错失焦虑 → 高位追入 → 增量资金衰减 → 接盘',
          counterQuestion: '如果我没有看到别人已经赚钱，现在还愿意按这个价格参与吗？',
          protectiveAction: '错过原价不等于亏损，赔率不舒服时放弃后手补票。',
          positiveCounterpart: '允许踏空、等待下一次',
          sortOrder: 150
        },
        {
          name: '连续盈利后的自信膨胀',
          axis: 'human',
          category: 'human_bias',
          summary: '连续盈利后把概率兑现误当成能力得到证明，并主动扩大风险暴露。',
          triggers: ['这套方法已经证明了', '可以把仓位放大', '最近怎么做都对'],
          actions: ['超计划加仓', '降低风控标准', '把一次经验推广到所有场景'],
          mechanism: '近期盈利会让人低估运气和市场环境，高估判断的稳定性。',
          riskChain: '连续盈利 → 过度归因能力 → 扩仓 → 单次错误放大 → 回吐或打穿',
          counterQuestion: '我的能力真的提高了，还是当前环境刚好奖励了这套动作？',
          protectiveAction: '仓位上限与连续盈亏脱钩，扩容必须经过独立样本和边界验证。',
          positiveCounterpart: '盈利后仍保持原风控',
          sortOrder: 160
        },
        {
          name: '慢跌拖延与拒绝承认',
          axis: 'human',
          category: 'execution_error',
          summary: '没有单日暴跌就不断延后处理，把持续走弱误当成风险不大。',
          triggers: ['每天只跌一点', '损失还不大', '等反弹再卖'],
          actions: ['慢跌不减仓', '失效后继续观察', '用时间代替判断'],
          mechanism: '缓慢损失不够痛，容易让人持续推迟必须执行的动作。',
          riskChain: '轻微下跌 → 延后处理 → 承接继续变弱 → 仓位失去流动性 → 挂树',
          counterQuestion: '如果它今天一次性跌完这段幅度，我还会继续不处理吗？',
          protectiveAction: '按结构和连续弱化处理，不要求市场用暴跌提醒自己。',
          positiveCounterpart: '逻辑失效后及时降低风险',
          sortOrder: 210
        },
        {
          name: '快速退出与承认错误',
          axis: 'human',
          category: 'positive_discipline',
          summary: '核心条件失效时先降低风险，再复盘原因，不用自尊和沉没成本拖延。',
          triggers: ['逻辑失效', '风险边界被打穿', '证据与原判断冲突'],
          actions: ['先退出', '承认判断错误', '保留复盘记录'],
          mechanism: '把错误视为概率成本，而不是对个人能力的否定。',
          riskChain: '识别失效 → 快速退出 → 控制损失 → 复盘 → 保留下一次参与能力',
          counterQuestion: '现在最重要的是证明我对，还是保留重新决策的能力？',
          protectiveAction: '提前定义失效线，触发后优先执行，不在持仓中临时修改。',
          positiveCounterpart: '退出能力、错误修正',
          sortOrder: 310
        },
        {
          name: '按计划执行',
          axis: 'human',
          category: 'positive_discipline',
          summary: '在情绪最强时仍按照持仓前制定的分批、退出和风险计划行动。',
          triggers: ['达到计划价格', '风险条件触发', '仓位进入兑现区'],
          actions: ['分批卖出', '不临时上调全部目标', '接受卖飞'],
          mechanism: '用事前理性约束持仓后的贪婪、恐惧和自我证明。',
          riskChain: '事前计划 → 触发执行 → 控制回撤 → 结果复盘 → 纪律强化',
          counterQuestion: '这个动作是否来自持仓前的规则，而不是此刻的情绪？',
          protectiveAction: '保留计划快照，执行后按过程质量复盘，不用最高价倒推对错。',
          positiveCounterpart: '系统优先、接受不完美结果',
          sortOrder: 320
        },
        {
          name: '主动放弃与纪律优先',
          axis: 'human',
          category: 'positive_discipline',
          summary: '看懂机会但赔率、结构或能力边界不符合体系时，主动不参与。',
          triggers: ['不属于我的结构', '赔率不舒服', '证据不足'],
          actions: ['不追高', '保留观察', '等待更适合的机会'],
          mechanism: '不把每个看懂的机会都转化成仓位，接受踏空是风险成本。',
          riskChain: '识别边界 → 主动放弃 → 保留现金流 → 等待高赔率机会',
          counterQuestion: '我不参与是因为纪律成立，还是因为恐惧替代了判断？',
          protectiveAction: '记录放弃依据并后验复盘，区分正确放弃与过度防守。',
          positiveCounterpart: '等待、现金流保留',
          sortOrder: 330
        }
      ];

      for (const pattern of seedPatterns) {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO behavior_patterns
            (name, axis, category, summary, trigger_phrases_json, observable_actions_json,
             mechanism, risk_chain, counter_question, protective_action, positive_counterpart,
             status, sort_order, note, is_deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            pattern.name,
            pattern.axis,
            pattern.category,
            pattern.summary,
            JSON.stringify(pattern.triggers),
            JSON.stringify(pattern.actions),
            pattern.mechanism,
            pattern.riskChain,
            pattern.counterQuestion,
            pattern.protectiveAction,
            pattern.positiveCounterpart,
            pattern.sortOrder
          ]
        );
      }
    }
  },
  {
    id: '20260801_001_connect_human_case_sources',
    name: 'Connect human cases to immutable source snapshots',
    run: async (db: any) => {
      await ensureMigrationColumn(
        db,
        'behavior_cases',
        'source_snapshot_json',
        "TEXT NOT NULL DEFAULT '{}'"
      );
      await dbExec(db, `
        CREATE UNIQUE INDEX IF NOT EXISTS ux_behavior_cases_active_source
          ON behavior_cases(source_type, source_id)
          WHERE is_deleted = 0 AND source_type <> '' AND source_id <> '';
      `);
    }
  },
  {
    id: '20260801_002_make_decision_patterns_primary',
    name: 'Promote decision patterns and classify case evidence roles',
    run: async (db: any) => {
      await ensureMigrationColumn(
        db,
        'behavior_patterns',
        'maturity',
        "TEXT NOT NULL DEFAULT 'candidate'"
      );
      await ensureMigrationColumn(
        db,
        'behavior_cases',
        'evidence_role',
        "TEXT NOT NULL DEFAULT 'neutral'"
      );
      await dbExec(db, `
        CREATE INDEX IF NOT EXISTS idx_behavior_patterns_maturity
          ON behavior_patterns(is_deleted, status, category, maturity, sort_order, id);
        CREATE INDEX IF NOT EXISTS idx_behavior_cases_evidence_role
          ON behavior_cases(is_deleted, evidence_role, case_date DESC, id DESC);
      `);

      await dbRun(
        db,
        `UPDATE behavior_patterns
         SET name = 'FOMO（错失焦虑）',
             summary = '因为别人赚钱、价格加速或错失感而高估不参与的遗憾，低估高位接盘的风险。',
             updated_at = CURRENT_TIMESTAMP
         WHERE axis = 'human'
           AND name = 'FOMO 与追高'
           AND is_deleted = 0`
      );
      await dbRun(
        db,
        `UPDATE behavior_patterns
         SET name = '死扛与拖延',
             summary = '核心条件已经变弱或失效，却因为损失不够剧烈、等回本或不愿认错而持续拖延退出。',
             updated_at = CURRENT_TIMESTAMP
         WHERE axis = 'human'
           AND name = '慢跌拖延与拒绝承认'
           AND is_deleted = 0`
      );

      const decisionPatterns = [
        {
          name: '追高',
          summary: '在价格加速、赔率明显恶化以后，因为害怕错过而补票。',
          triggers: ['末端加速', '大家都赚钱', '再不上车就没机会'],
          actions: ['高位追入', '忽略回撤空间', '用上涨替代估值'],
          mechanism: '常由 FOMO、群体情绪和近期上涨共同触发。',
          riskChain: '价格加速 → 错失焦虑 → 高位追入 → 增量买家衰减 → 接盘或死扛',
          counterQuestion: '如果我没有看到别人已经赚钱，现在还愿意按这个价格参与吗？',
          protectiveAction: '重新计算盈亏比；末端加速不追，等待回踩或下一次机会。',
          counterpart: '允许踏空、等待确认',
          sortOrder: 210
        },
        {
          name: '过度下注',
          summary: '单次仓位超过现金流和退出容量，让一次普通判断错误升级成生存风险。',
          triggers: ['这次把握很大', '想一次赚够', '连续盈利后扩仓'],
          actions: ['重仓或满仓', '忽略退出容量', '用结果预期替代仓位边界'],
          mechanism: '过度自信会放大收益想象，却弱化对错误概率和流动性的感受。',
          riskChain: '高置信 → 过度下注 → 判断失误 → 无法从容退出 → 现金流受损',
          counterQuestion: '即使这次判断错了，这个仓位还允许我继续留在场内吗？',
          protectiveAction: '仓位服从现金流、退出容量和单次损失边界，不随情绪临时放大。',
          counterpart: '分批参与、保留现金流',
          sortOrder: 220
        },
        {
          name: '抢跑/没有等待',
          summary: '关键条件还没有得到确认，就因为看见机会而提前行动。',
          triggers: ['应该差不多了', '先进去再说', '怕确认后买不到'],
          actions: ['未确认止跌就买入', '供给未明就下注', '把猜测当证据'],
          mechanism: '行动冲动会把等待误解成错失，让人用仓位替代观察。',
          riskChain: '看到机会 → 跳过确认 → 提前入场 → 结构继续恶化 → 被动等待',
          counterQuestion: '我现在掌握的是证据，还是只是希望它成立？',
          protectiveAction: '列出必须出现的确认信号，信号未到只观察，不用仓位催促结果。',
          counterpart: '等待结构确认',
          sortOrder: 230
        },
        {
          name: '逻辑失效仍坚持',
          summary: '供给、需求、规则或市场结构已经改变，却继续沿用最初的持有理由。',
          triggers: ['只是暂时变化', '以后还会回来', '原逻辑长期没问题'],
          actions: ['忽略反证', '继续按旧中枢估值', '用反弹证明原判断'],
          mechanism: '确认偏误和路径依赖会保护旧判断，阻止人重新定价。',
          riskChain: '结构改变 → 拒绝更新 → 继续持有 → 新中枢下移 → 损失扩大',
          counterQuestion: '如果今天第一次看到这个标的，我还会使用原来的逻辑吗？',
          protectiveAction: '持有前写清失效条件；条件触发后归零重评，不能用成本维持旧逻辑。',
          counterpart: '主动寻找反证、归零判断',
          sortOrder: 240
        },
        {
          name: '没有退出机制',
          summary: '参与前只设计怎么买，没有提前规定何时兑现、何时认错和如何退出。',
          triggers: ['先买了再看', '涨到哪算哪', '跌了再研究'],
          actions: ['盈利不兑现', '失效后临时改规则', '退出全靠情绪'],
          mechanism: '持仓后贪婪和不甘心会接管决策，事后很难保持中立。',
          riskChain: '无退出计划 → 情绪持仓 → 错过主动窗口 → 回撤或流动性收缩 → 被迫处理',
          counterQuestion: '如果价格立刻朝两个方向运动，我分别准备怎么退出？',
          protectiveAction: '参与前同时写好兑现、失效和流动性退出方案，触发后按计划执行。',
          counterpart: '事前计划、分批兑现',
          sortOrder: 250
        }
      ];

      for (const pattern of decisionPatterns) {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO behavior_patterns
            (name, axis, category, summary, trigger_phrases_json, observable_actions_json,
             mechanism, risk_chain, counter_question, protective_action, positive_counterpart,
             maturity, status, sort_order, note, is_deleted, created_at, updated_at)
           VALUES (?, 'human', 'execution_error', ?, ?, ?, ?, ?, ?, ?, ?,
                   'candidate', 'active', ?, '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            pattern.name,
            pattern.summary,
            JSON.stringify(pattern.triggers),
            JSON.stringify(pattern.actions),
            pattern.mechanism,
            pattern.riskChain,
            pattern.counterQuestion,
            pattern.protectiveAction,
            pattern.counterpart,
            pattern.sortOrder
          ]
        );
      }
    }
  },
  {
    id: '20260801_003_separate_dead_hold_action_pattern',
    name: 'Separate dead-hold action from sunk-cost mechanism',
    run: async (db: any) => {
      await dbRun(
        db,
        `UPDATE behavior_patterns
         SET name = '沉没成本与拒绝承认',
             category = 'human_bias',
             summary = '已经投入时间、金钱或情绪后，不愿承认原判断失效，并不断寻找继续等待的理由。',
             updated_at = CURRENT_TIMESTAMP
         WHERE axis = 'human'
           AND name IN ('慢跌拖延与拒绝承认', '死扛与拖延')
           AND is_deleted = 0`
      );
      await dbRun(
        db,
        `INSERT OR IGNORE INTO behavior_patterns
          (name, axis, category, summary, trigger_phrases_json, observable_actions_json,
           mechanism, risk_chain, counter_question, protective_action, positive_counterpart,
           maturity, status, sort_order, note, is_deleted, created_at, updated_at)
         VALUES ('死扛', 'human', 'execution_error',
                 '原始逻辑已经变弱或失效，却因为不甘心、等回本或害怕认错而拒绝退出。',
                 '["等回本","已经拿这么久","现在卖太亏"]',
                 '["拒绝退出","无边界补仓","只谈成本不谈结构"]',
                 '沉没成本、损失厌恶和确认偏误共同让人把过去投入带进当前决策。',
                 '小亏 → 拖延 → 中亏 → 心理压力增加 → 被迫退出',
                 '如果现在空仓，我还会按当前价格和结构重新买入吗？',
                 '忽略历史成本，按当前结构、未来概率、风险收益比和失效条件归零重评。',
                 '承认错误、归零判断、快速退出',
                 'candidate', 'active', 215, '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      );
    }
  },
  {
    id: '20260801_004_merge_duplicate_sunk_cost_mechanism',
    name: 'Merge duplicate sunk-cost mechanism patterns',
    run: async (db: any) => {
      const canonical = await dbGet<{ id: number }>(
        db,
        `SELECT id
         FROM behavior_patterns
         WHERE name = '沉没成本绑架决策' AND is_deleted = 0
         ORDER BY id
         LIMIT 1`
      );
      const duplicate = await dbGet<{ id: number }>(
        db,
        `SELECT id
         FROM behavior_patterns
         WHERE name = '沉没成本与拒绝承认' AND is_deleted = 0
         ORDER BY id
         LIMIT 1`
      );

      if (!duplicate) {
        return;
      }

      if (!canonical) {
        await dbRun(
          db,
          `UPDATE behavior_patterns
           SET name = '沉没成本绑架决策', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [duplicate.id]
        );
        return;
      }

      await dbRun(
        db,
        `DELETE FROM behavior_case_pattern_links
         WHERE pattern_id = ?
           AND EXISTS (
             SELECT 1
             FROM behavior_case_pattern_links canonical_link
             WHERE canonical_link.case_id = behavior_case_pattern_links.case_id
               AND canonical_link.pattern_id = ?
           )`,
        [duplicate.id, canonical.id]
      );
      await dbRun(
        db,
        `UPDATE behavior_case_pattern_links
         SET pattern_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE pattern_id = ?`,
        [canonical.id, duplicate.id]
      );
      await dbRun(
        db,
        `UPDATE behavior_patterns
         SET status = 'archived', is_deleted = 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [duplicate.id]
      );
    }
  },
  {
    id: '20260808_001_switch_longyinbi_2026_to_price_record_line',
    name: 'Switch Longyinbi 2026 source to airmb price record line',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'source_mappings'))) return;

      const row = await dbGet<any>(
        db,
        `SELECT id, external_key, external_meta_json, note
         FROM source_mappings
         WHERE source_key = ?
           AND category_name = ?
           AND object_name = ?
           AND variant_name = ?
         ORDER BY id DESC
         LIMIT 1`,
        ['airmb_longyinbi_presale', '纪念币', '龙银币', '2026年信泰评级']
      );
      if (!row) return;

      const externalKey = '25|line|selectedTime=2|2026龙银币';
      const metaJson = JSON.stringify({
        api_mode: 'price_record_line',
        goods_id: '25',
        selected_time: '2',
        price_offset: 0,
        price_offset_reason: '2026 龙银币改用爱藏价格线直采，不再从 2025 裸币加减价',
        start_date: '2026-07-05',
        start_date_reason: '2026 信泰评级旧历史来源不准，从 2026-07-05 起自动采集；旧历史由用户手工补'
      });
      const mappingNote = '源头改为爱藏 2026 龙银币价格线（id=25, selectedTime=2）；直采入库到 2026年信泰评级，不再使用 2025 裸币-70。';

      const conflict = await dbGet<any>(
        db,
        `SELECT id FROM source_mappings
         WHERE source_key = ?
           AND external_key = ?
           AND id != ?
         LIMIT 1`,
        ['airmb_longyinbi_presale', externalKey, row.id]
      );
      if (conflict) {
        await dbRun(
          db,
          `UPDATE source_mappings
           SET status = 'disabled',
               note = TRIM(COALESCE(note, '') || CASE WHEN COALESCE(note, '') = '' THEN '' ELSE '\n' END || '已由 2026 价格线映射接管'),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [conflict.id]
        );
      }

      await dbRun(
        db,
        `UPDATE source_mappings
         SET external_key = ?,
             external_name = ?,
             external_meta_json = ?,
             note = ?,
             status = 'enabled',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [externalKey, '2026龙银币', metaJson, mappingNote, row.id]
      );

      if (await migrationTableExists(db, 'variants')) {
        await dbRun(
          db,
          `UPDATE variants
           SET note = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE name = ?
             AND object_id IN (
               SELECT o.id
               FROM objects o
               JOIN categories c ON c.id = o.category_id
               WHERE c.name = ? AND o.name = ?
             )`,
          [
            '源头为爱藏 2026 龙银币价格线直采，不再按 2025 裸币加减价',
            '2026年信泰评级',
            '纪念币',
            '龙银币'
          ]
        );
      }

      if (await migrationTableExists(db, 'task_center_tasks')) {
        const task = await dbGet<any>(
          db,
          "SELECT id, config_json FROM task_center_tasks WHERE task_key = ?",
          ['longyinbi_price_update']
        );
        if (task) {
          let config: Record<string, any> = {};
          try {
            config = task.config_json ? JSON.parse(task.config_json) : {};
          } catch {
            config = {};
          }
          config.target_offsets = {
            ...(config.target_offsets || {}),
            '2025年信泰评级': 100,
            '2026年信泰评级': 0
          };
          config.target_start_dates = {
            ...(config.target_start_dates || {}),
            '2026年信泰评级': '2026-07-05'
          };
          const taskMessage = '每天抓取爱藏龙银币：2025年信泰评级=裸币+100；2026年信泰评级改用价格线直采（id=25）';
          await dbRun(
            db,
            `UPDATE task_center_tasks
             SET config_json = ?,
                 last_message = CASE
                   WHEN last_status = 'pending' OR last_message LIKE '每天抓取爱藏%' THEN ?
                   ELSE last_message
                 END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [JSON.stringify(config), taskMessage, task.id]
          );
        }
      }
    }
  },
  {
    id: '20260808_002_archive_objects_with_only_archived_variants',
    name: 'Archive objects whose variants are all archived',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'objects'))) return;
      if (!(await migrationTableExists(db, 'variants'))) return;

      await dbRun(
        db,
        `UPDATE objects
         SET is_archived = 1,
             archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE COALESCE(is_archived, 0) = 0
           AND EXISTS (
             SELECT 1 FROM variants v WHERE v.object_id = objects.id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM variants v
             WHERE v.object_id = objects.id
               AND COALESCE(v.is_archived, 0) = 0
           )`
      );
    }
  },
  {
    id: '20260812_001_add_situational_awareness_risk_case',
    name: 'Add Situational Awareness leverage and liquidity risk case',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'behavior_cases'))) return;
      if (!(await migrationTableExists(db, 'behavior_patterns'))) return;
      if (!(await migrationTableExists(db, 'behavior_case_pattern_links'))) return;

      const title = 'Situational Awareness：看对大势却失去等待资格';
      let behaviorCase = await dbGet<{ id: number }>(
        db,
        `SELECT id
         FROM behavior_cases
         WHERE title = ? AND is_deleted = 0
         ORDER BY id
         LIMIT 1`,
        [title]
      );

      if (!behaviorCase) {
        await dbRun(
          db,
          `INSERT INTO behavior_cases
            (title, origin_type, subject_alias, source_note, evidence_level, case_date,
             track, project_name, background, visible_information, pressure_context,
             action_taken, result, action_quality, outcome_type, evidence_role,
             self_response, learn_to_keep, learn_to_avoid, applicability_boundary,
             linked_rule_refs_json, source_type, source_id, source_snapshot_json,
             note, is_deleted, created_at, updated_at)
           VALUES (?, 'public', ?, ?, 'documented', '2026-07-30',
                   'AI基础设施/公开股票', 'Situational Awareness基金', ?, ?, ?,
                   ?, ?, 'flawed', 'loss', 'negative',
                   ?, ?, ?, ?, ?, '', '', '{}', ?, 0,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            title,
            'Leopold Aschenbrenner（利奥波德·阿申布伦纳）',
            '公开报道：Reuters、Axios，2026-07-30。关于“华尔街联合围剿”及 Citadel 后续具体获利的说法未作为已证实事实写入。',
            '基金把“AI发展将持续推高芯片、存储、数据中心和电力需求”的宏观判断，直接转化为高度集中的AI基础设施公开股票组合。前期收益和规模快速上升，随后又提高了风险暴露。',
            '公开报道确认：AI相关股票剧烈下跌后，基金遭遇严重损失和保证金压力；其公开股票组合中由经纪商杠杆融资的部分被转让，公开股票组合的大部分最终出售给 Citadel。大方向是否长期失效，当时并未得到证明。',
            '前期极高收益、规模膨胀和“提前看懂AI大趋势”的明星光环，容易把认知优势误当成仓位与杠杆也同样正确；而集中持仓同步回撤时，流动性和保证金要求迅速压缩等待时间。',
            '在高集中度基础上使用显著杠杆放大AI基础设施方向的风险暴露；回撤和保证金压力出现后，被迫快速去杠杆并出售大部分公开股票组合。',
            '基金失去了继续持有公开股票、等待长期逻辑兑现的主动权。这个结果不等于AI基础设施长期判断必然错误，却证明正确方向也可能被错误的仓位、杠杆和资金结构提前终结。',
            '即使我对大势高度确信，也不使用会被保证金剥夺等待权的杠杆；仓位必须允许核心判断暂时逆风，现金流必须允许我活到逻辑兑现。',
            '吸收其把AI宏观趋势拆到芯片、存储、数据中心和电力等“卖铲子”环节的结构化认知；同时把产业判断与组合生存能力分开评价。',
            '避免把认知优势当成风险管理的替代品，避免在连续暴利后提高集中度和杠杆，避免让融资期限短于逻辑兑现周期。',
            '适用于杠杆、集中持仓、融资库存及所有“方向可能对但时间等不起”的场景；不用于否定无杠杆、现金流可承受且退出边界清楚的集中研究。具体杠杆倍数不是本案例成立的必要条件。',
            JSON.stringify([
              '认知优势不能替代风险管理',
              '看对大势只能决定有没有机会；仓位、杠杆和现金流决定有没有资格等到兑现'
            ]),
            '核心结论：方向正确不等于能够活到方向兑现。所谓“被围剿”缺少充分证据，本案例只记录公开可核对的集中、杠杆、回撤、保证金压力与被迫出售链条。'
          ]
        );
        behaviorCase = await dbGet<{ id: number }>(
          db,
          `SELECT id
           FROM behavior_cases
           WHERE title = ? AND is_deleted = 0
           ORDER BY id
           LIMIT 1`,
          [title]
        );
      }

      if (!behaviorCase) {
        throw new Error('Situational Awareness case could not be created');
      }

      const existingLinks = await dbGet<{ total: number }>(
        db,
        `SELECT COUNT(*) AS total
         FROM behavior_case_pattern_links
         WHERE case_id = ?`,
        [behaviorCase.id]
      );
      if (Number(existingLinks?.total || 0) === 0) {
        const patternLinks = [
          { name: '过度下注', role: 'primary' },
          { name: '暴涨后崩跌', role: 'secondary' },
          { name: '连续盈利后的自信膨胀', role: 'secondary' }
        ];

        for (const link of patternLinks) {
          const pattern = await dbGet<{ id: number }>(
            db,
            `SELECT id
             FROM behavior_patterns
             WHERE name = ? AND is_deleted = 0 AND status = 'active'
             ORDER BY id
             LIMIT 1`,
            [link.name]
          );
          if (!pattern) {
            throw new Error(`Required behavior pattern is missing: ${link.name}`);
          }
          await dbRun(
            db,
            `INSERT OR IGNORE INTO behavior_case_pattern_links
              (case_id, pattern_id, role, note, created_at, updated_at)
             VALUES (?, ?, ?, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [behaviorCase.id, pattern.id, link.role]
          );
        }
      }

      if (await migrationTableExists(db, 'audit_logs')) {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO audit_logs
            (id, timestamp, module, action, target, status, detail, entity_id,
             path, domain, workspace, created_at, updated_at)
           VALUES ('audit-human-case-situational-awareness-20260812', CURRENT_TIMESTAMP,
                   '人因案例库', 'create', ?, 'success', ?, ?, '/review/human-cases',
                   'business', 'business', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            title,
            JSON.stringify({
              originType: 'public',
              actionQuality: 'flawed',
              outcomeType: 'loss',
              primaryPattern: '过度下注'
            }),
            String(behaviorCase.id)
          ]
        );
      }
    }
  },
  {
    id: '20260812_002_merge_android_ai_supply_chain_case',
    name: 'Merge Android miss review with AI capacity crowding insight',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'behavior_patterns'))) return;

      await dbRun(
        db,
        `INSERT OR IGNORE INTO behavior_patterns
          (name, axis, category, summary, trigger_phrases_json, observable_actions_json,
           mechanism, risk_chain, counter_question, protective_action, positive_counterpart,
           maturity, status, sort_order, note, is_deleted, created_at, updated_at)
         VALUES ('产能挤占与二三阶传导', 'market', 'market_structure', ?, ?, ?, ?, ?, ?, ?, ?,
                 'candidate', 'active', 60, '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          '高利润的新需求抢占有限产能，即使相邻市场的需求没有增加，也可能因供给被挤出而短缺涨价，并继续向零部件、整机、渠道和二级市场传导。',
          JSON.stringify(['高利润需求抢产能', '厂商调整产能或资本开支', '渠道库存下降', '终端成本开始抬升']),
          JSON.stringify(['只看直接受益者', '把所有相关零部件当成同一逻辑', '看到终端涨价就反推单一原因']),
          '市场通常先关注新增需求本身，容易忽略厂商会把有限产能转向利润更高的产品；被挤出的相邻市场可能在需求不变时出现供给收缩。',
          '大趋势新增需求 → 高利润环节抢产能 → 相邻产品供给弹性下降 → 零部件涨价或短缺 → 整机成本与渠道库存变化 → 终端和二级市场反应',
          '这条链里哪些产能真正共享，谁被挤出，终端变化又有哪些独立证据？',
          '逐层验证需求、产能分配、现货价格、渠道库存和终端成交；同时排除汇率、官方调价、换代、关税、库存释放和渠道炒作。',
          '沿供需关系寻找二阶、三阶机会，并保留反证'
        ]
      );
      await dbRun(
        db,
        `UPDATE behavior_patterns
         SET summary = ?, trigger_phrases_json = ?, observable_actions_json = ?,
             mechanism = ?, risk_chain = ?, counter_question = ?, protective_action = ?,
             positive_counterpart = ?, updated_at = CURRENT_TIMESTAMP
         WHERE axis = 'market'
           AND name = '产能挤占与二三阶传导'
           AND is_deleted = 0`,
        [
          '高利润的新需求抢占有限产能，即使相邻市场的需求没有增加，也可能因供给被挤出而短缺涨价，并继续向零部件、整机、渠道和二级市场传导。',
          JSON.stringify(['高利润需求抢产能', '厂商调整产能或资本开支', '渠道库存下降', '终端成本开始抬升']),
          JSON.stringify(['只看直接受益者', '把所有相关零部件当成同一逻辑', '看到终端涨价就反推单一原因']),
          '市场通常先关注新增需求本身，容易忽略厂商会把有限产能转向利润更高的产品；被挤出的相邻市场可能在需求不变时出现供给收缩。',
          '大趋势新增需求 → 高利润环节抢产能 → 相邻产品供给弹性下降 → 零部件涨价或短缺 → 整机成本与渠道库存变化 → 终端和二级市场反应',
          '这条链里哪些产能真正共享，谁被挤出，终端变化又有哪些独立证据？',
          '逐层验证需求、产能分配、现货价格、渠道库存和终端成交；同时排除汇率、官方调价、换代、关税、库存释放和渠道炒作。',
          '沿供需关系寻找二阶、三阶机会，并保留反证'
        ]
      );

      await dbRun(
        db,
        `INSERT OR IGNORE INTO behavior_patterns
          (name, axis, category, summary, trigger_phrases_json, observable_actions_json,
           mechanism, risk_chain, counter_question, protective_action, positive_counterpart,
           maturity, status, sort_order, note, is_deleted, created_at, updated_at)
         VALUES ('推演链条过短', 'human', 'execution_error', ?, ?, ?, ?, ?, ?, ?, ?,
                 'candidate', 'active', 260, '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          '已经识别大趋势，却只推到直接需求，没有继续追踪产能挤占、供给瓶颈和二阶、三阶价格传导，直到机会在终端价格上变得明显。',
          JSON.stringify(['大方向已经看懂', '只研究直接受益者', '等终端涨价后才发现传导']),
          JSON.stringify(['推演停在第一层', '没有建立传导观察链', '机会起飞后才回头解释']),
          '直接需求最醒目、最容易理解，而供给重分配和跨环节传导更慢、更隐蔽，容易被风险记忆或研究边界提前截断。',
          '看见大趋势 → 只推直接需求 → 漏掉产能挤占 → 二三阶短缺逐步兑现 → 终端价格已经起飞 → 只能踏空或冒险追高',
          '如果这个趋势会消耗稀缺资源，谁得到更多产能，谁会被挤出，短缺最终会传到哪里？',
          '发现大趋势后用八问模板继续推演并进入观察层；逐层补证据，价格起飞后仍重新计算赔率，不用事后逻辑追高。',
          '完整推演、提前观察、起飞后守纪律'
        ]
      );
      await dbRun(
        db,
        `UPDATE behavior_patterns
         SET summary = ?, trigger_phrases_json = ?, observable_actions_json = ?,
             mechanism = ?, risk_chain = ?, counter_question = ?, protective_action = ?,
             positive_counterpart = ?, updated_at = CURRENT_TIMESTAMP
         WHERE axis = 'human'
           AND name = '推演链条过短'
           AND is_deleted = 0`,
        [
          '已经识别大趋势，却只推到直接需求，没有继续追踪产能挤占、供给瓶颈和二阶、三阶价格传导，直到机会在终端价格上变得明显。',
          JSON.stringify(['大方向已经看懂', '只研究直接受益者', '等终端涨价后才发现传导']),
          JSON.stringify(['推演停在第一层', '没有建立传导观察链', '机会起飞后才回头解释']),
          '直接需求最醒目、最容易理解，而供给重分配和跨环节传导更慢、更隐蔽，容易被风险记忆或研究边界提前截断。',
          '看见大趋势 → 只推直接需求 → 漏掉产能挤占 → 二三阶短缺逐步兑现 → 终端价格已经起飞 → 只能踏空或冒险追高',
          '如果这个趋势会消耗稀缺资源，谁得到更多产能，谁会被挤出，短缺最终会传到哪里？',
          '发现大趋势后用八问模板继续推演并进入观察层；逐层补证据，价格起飞后仍重新计算赔率，不用事后逻辑追高。',
          '完整推演、提前观察、起飞后守纪律'
        ]
      );

      const reviewTitle = '安卓机器：产业链推演只走一半，起飞后不追';
      let missedReview: { id: number } | undefined;
      if (await migrationTableExists(db, 'missed_projects')) {
        missedReview = await dbGet<{ id: number }>(
          db,
          `SELECT id
           FROM missed_projects
           WHERE COALESCE(is_deleted, 0) = 0
             AND (title IN (?, ?) OR project_name = '安卓机器')
           ORDER BY CASE WHEN title = ? THEN 0 WHEN title = ? THEN 1 ELSE 2 END, id
           LIMIT 1`,
          [reviewTitle, '安卓机器主动放弃复盘', reviewTitle, '安卓机器主动放弃复盘']
        );
        if (!missedReview) {
          await dbRun(
            db,
            `INSERT INTO missed_projects
              (title, track, project_name, source, review_date, miss_type, signal, reason,
               trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson,
               note, is_deleted, created_at, updated_at)
             VALUES (?, '电子产品', '安卓机器/消费级存储与整机', '本人复盘/产业链推演',
                     '2026-04-18', '前期推演不足；起飞后主动放弃', ?, ?, ?, ?, ?, ?, ?, ?,
                     0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              reviewTitle,
              '年前已判断AI会大量消耗算力、内存和存储；随后消费级存储、安卓手机等终端价格出现上行线索。',
              '推演只停在AI直接需要什么，没有继续追踪高利润需求如何挤占有限产能、消费级供给如何收缩以及价格如何向整机和二级市场传导；同时以前被安卓机器反撸的经历提高了参与门槛。',
              '二阶、三阶传导逐步被市场看见，早期低赔率窗口已经错过；价格起飞后选择不追，避免把认知踏空继续变成高位接盘。',
              '产业链推演能力只走了一半：看到了大趋势，却没有把“产能挤占 → 相邻供给收缩 → 终端涨价”变成持续观察链。',
              '大趋势出现后连续追问直接需求、上游依赖、最慢供给、产能挤出、短缺传导、最终标的、预期定价和风险边界；先进入观察，不因单点逻辑直接下结论。',
              '前期漏掉的是推演深度，后期守住的是不追高纪律；两件事要分开评价。',
              '大趋势只是入口，真正的机会往往藏在趋势造成的第二阶、第三阶供需变化里。',
              '2026-08-12合并原“安卓机器主动放弃复盘”和AI存储产能挤占复盘。CPU、GPU、HBM、DRAM、NAND的约束不同，不能统称AI抢产能；终端涨价还需排除汇率、官方调价、换代、关税、库存和炒作。'
            ]
          );
          missedReview = await dbGet<{ id: number }>(
            db,
            'SELECT id FROM missed_projects WHERE title = ? AND COALESCE(is_deleted, 0) = 0 ORDER BY id LIMIT 1',
            [reviewTitle]
          );
        } else {
          await dbRun(
            db,
            `UPDATE missed_projects
             SET title = ?, track = '电子产品', project_name = '安卓机器/消费级存储与整机',
                 source = '本人复盘/产业链推演', miss_type = '前期推演不足；起飞后主动放弃',
                 signal = ?, reason = ?, trend = ?, exposed_problem = ?, extracted_lesson = ?,
                 summary_conclusion = ?, short_lesson = ?, note = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              reviewTitle,
              '年前已判断AI会大量消耗算力、内存和存储；随后消费级存储、安卓手机等终端价格出现上行线索。',
              '推演只停在AI直接需要什么，没有继续追踪高利润需求如何挤占有限产能、消费级供给如何收缩以及价格如何向整机和二级市场传导；同时以前被安卓机器反撸的经历提高了参与门槛。',
              '二阶、三阶传导逐步被市场看见，早期低赔率窗口已经错过；价格起飞后选择不追，避免把认知踏空继续变成高位接盘。',
              '产业链推演能力只走了一半：看到了大趋势，却没有把“产能挤占 → 相邻供给收缩 → 终端涨价”变成持续观察链。',
              '大趋势出现后连续追问直接需求、上游依赖、最慢供给、产能挤出、短缺传导、最终标的、预期定价和风险边界；先进入观察，不因单点逻辑直接下结论。',
              '前期漏掉的是推演深度，后期守住的是不追高纪律；两件事要分开评价。',
              '大趋势只是入口，真正的机会往往藏在趋势造成的第二阶、第三阶供需变化里。',
              '2026-08-12合并原“安卓机器主动放弃复盘”和AI存储产能挤占复盘。CPU、GPU、HBM、DRAM、NAND的约束不同，不能统称AI抢产能；终端涨价还需排除汇率、官方调价、换代、关税、库存和炒作。',
              missedReview.id
            ]
          );
        }
      }

      if (missedReview && await migrationTableExists(db, 'behavior_cases')) {
        const legacyCaseTitle = '安卓机器：看懂也不追，纪律优先';
        const mergedCaseTitle = '安卓机器：大趋势只推演一半，起飞后仍不追';
        let behaviorCase = await dbGet<{ id: number }>(
          db,
          `SELECT id
           FROM behavior_cases
           WHERE is_deleted = 0
             AND ((source_type = 'missed_project' AND source_id = ?) OR title IN (?, ?))
           ORDER BY CASE WHEN source_type = 'missed_project' AND source_id = ? THEN 0 ELSE 1 END, id
           LIMIT 1`,
          [String(missedReview.id), mergedCaseTitle, legacyCaseTitle, String(missedReview.id)]
        );

        if (!behaviorCase) {
          const sourceSnapshot = JSON.stringify({
            sourceType: 'missed_project',
            sourceId: String(missedReview.id),
            sourceModule: '错过复盘',
            sourceTitle: reviewTitle,
            sourceDate: '2026-04-18',
            sourcePath: `/review/missed?recordId=${missedReview.id}`,
            capturedBy: 'migration-20260812_002'
          });
          await dbRun(
            db,
            `INSERT INTO behavior_cases
              (title, origin_type, subject_alias, source_note, evidence_level, case_date,
               track, project_name, background, visible_information, pressure_context,
               action_taken, result, action_quality, outcome_type, evidence_role,
               self_response, learn_to_keep, learn_to_avoid, applicability_boundary,
               linked_rule_refs_json, source_type, source_id, source_snapshot_json,
               note, is_deleted, created_at, updated_at)
             VALUES (?, 'self', '本人', ?, 'first_hand', '2026-04-18',
                     '电子产品', '安卓机器/消费级存储与整机', ?, ?, ?, ?, ?,
                     'mixed', 'mixed', 'boundary', ?, ?, ?, ?, ?,
                     'missed_project', ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              mergedCaseTitle,
              `合并自错过复盘#${missedReview.id}；2026-08-12补充产业链二三阶推演。`,
              '年前已经识别AI会大量消耗算力、内存和存储，但产业链推演停在直接需求，没有继续研究高利润产品挤占产能后，消费级存储和整机市场会发生什么。过去被安卓机器反撸的经历又提高了行动门槛。',
              '可见的第一层是AI服务器需要HBM、服务器级DRAM、NAND和更多基础设施；需要继续验证的后续链是产能与资本开支倾斜、消费级供给弹性下降、零部件现货变化、整机BOM与渠道库存变化，最终才是安卓手机、PC、游戏机等终端价格。',
              '旧亏损带来的防守心态，与终端行情逐步起飞后的错失感同时存在。最容易犯的错是：前期没有继续研究，后期又用“我早就看对AI”给追高找理由。',
              '前期没有建立产能挤占和终端传导观察链；等安卓机器行情已经明显后，选择不追高。',
              '错过了早期较舒服的研究和参与窗口，但守住了起飞后不追的纪律。后续终端涨价不能全部归因于AI，还需逐项排除汇率、官方调价、型号切换、关税、渠道库存和炒作。',
              '以后发现大趋势，先用八问模板把直接需求、上游依赖、供给瓶颈、产能挤出、短缺传导、最终标的、预期定价和风险边界走完，并进入观察层；如果等价格已经起飞，仍按当下赔率决定，不拿早期判断给追高开绿灯。',
              '保留对大趋势和上游变化的敏感度，也保留错过后不追高的纪律。',
              '避免推演只走第一层，避免把CPU、GPU、HBM、DRAM、NAND混成同一个供给逻辑，也避免用终端上涨事后反推单一原因。',
              '适用于大趋势造成供给重分配的跨品类机会；每条链都必须有共享产能、供给变化、渠道库存和真实成交证据。未经验证只进观察层，不自动形成买入结论。',
              JSON.stringify([
                '大趋势只是入口，真正的机会往往藏在趋势造成的第二阶、第三阶供需变化里',
                '先把因果链验证完整；价格起飞后仍不追高'
              ]),
              String(missedReview.id),
              sourceSnapshot,
              '合并原安卓主动放弃案例与AI存储传导复盘；前期能力缺口和后期正确纪律分开评价，不用事后涨幅否定当时不追高。'
            ]
          );
          behaviorCase = await dbGet<{ id: number }>(
            db,
            `SELECT id
             FROM behavior_cases
             WHERE source_type = 'missed_project' AND source_id = ? AND is_deleted = 0
             ORDER BY id LIMIT 1`,
            [String(missedReview.id)]
          );
        } else {
          await dbRun(
            db,
            `UPDATE behavior_cases
             SET title = ?, origin_type = 'self', subject_alias = '本人', source_note = ?,
                 evidence_level = 'first_hand', case_date = '2026-04-18', track = '电子产品',
                 project_name = '安卓机器/消费级存储与整机', background = ?,
                 visible_information = ?, pressure_context = ?, action_taken = ?, result = ?,
                 action_quality = 'mixed', outcome_type = 'mixed', evidence_role = 'boundary',
                 self_response = ?, learn_to_keep = ?, learn_to_avoid = ?,
                 applicability_boundary = ?, linked_rule_refs_json = ?,
                 source_type = 'missed_project', source_id = ?, note = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              mergedCaseTitle,
              `合并自错过复盘#${missedReview.id}；2026-08-12补充产业链二三阶推演。`,
              '年前已经识别AI会大量消耗算力、内存和存储，但产业链推演停在直接需求，没有继续研究高利润产品挤占产能后，消费级存储和整机市场会发生什么。过去被安卓机器反撸的经历又提高了行动门槛。',
              '可见的第一层是AI服务器需要HBM、服务器级DRAM、NAND和更多基础设施；需要继续验证的后续链是产能与资本开支倾斜、消费级供给弹性下降、零部件现货变化、整机BOM与渠道库存变化，最终才是安卓手机、PC、游戏机等终端价格。',
              '旧亏损带来的防守心态，与终端行情逐步起飞后的错失感同时存在。最容易犯的错是：前期没有继续研究，后期又用“我早就看对AI”给追高找理由。',
              '前期没有建立产能挤占和终端传导观察链；等安卓机器行情已经明显后，选择不追高。',
              '错过了早期较舒服的研究和参与窗口，但守住了起飞后不追的纪律。后续终端涨价不能全部归因于AI，还需逐项排除汇率、官方调价、型号切换、关税、渠道库存和炒作。',
              '以后发现大趋势，先用八问模板把直接需求、上游依赖、供给瓶颈、产能挤出、短缺传导、最终标的、预期定价和风险边界走完，并进入观察层；如果等价格已经起飞，仍按当下赔率决定，不拿早期判断给追高开绿灯。',
              '保留对大趋势和上游变化的敏感度，也保留错过后不追高的纪律。',
              '避免推演只走第一层，避免把CPU、GPU、HBM、DRAM、NAND混成同一个供给逻辑，也避免用终端上涨事后反推单一原因。',
              '适用于大趋势造成供给重分配的跨品类机会；每条链都必须有共享产能、供给变化、渠道库存和真实成交证据。未经验证只进观察层，不自动形成买入结论。',
              JSON.stringify([
                '大趋势只是入口，真正的机会往往藏在趋势造成的第二阶、第三阶供需变化里',
                '先把因果链验证完整；价格起飞后仍不追高'
              ]),
              String(missedReview.id),
              '合并原安卓主动放弃案例与AI存储传导复盘；前期能力缺口和后期正确纪律分开评价，不用事后涨幅否定当时不追高。',
              behaviorCase.id
            ]
          );
        }

        if (!behaviorCase) {
          throw new Error('Merged Android supply-chain case could not be created');
        }

        await dbRun(db, 'DELETE FROM behavior_case_pattern_links WHERE case_id = ?', [behaviorCase.id]);
        const patternLinks = [
          { name: '推演链条过短', role: 'primary' },
          { name: '产能挤占与二三阶传导', role: 'secondary' },
          { name: '恐惧与过度防守', role: 'secondary' }
        ];
        for (const link of patternLinks) {
          const pattern = await dbGet<{ id: number }>(
            db,
            `SELECT id
             FROM behavior_patterns
             WHERE name = ? AND is_deleted = 0 AND status = 'active'
             ORDER BY id LIMIT 1`,
            [link.name]
          );
          if (!pattern) throw new Error(`Required behavior pattern is missing: ${link.name}`);
          await dbRun(
            db,
            `INSERT INTO behavior_case_pattern_links
              (case_id, pattern_id, role, note, created_at, updated_at)
             VALUES (?, ?, ?, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [behaviorCase.id, pattern.id, link.role]
          );
        }

        if (await migrationTableExists(db, 'audit_logs')) {
          await dbRun(
            db,
            `INSERT OR IGNORE INTO audit_logs
              (id, timestamp, module, action, target, status, detail, entity_id,
               path, domain, workspace, created_at, updated_at)
             VALUES ('audit-human-case-android-ai-transmission-20260812', CURRENT_TIMESTAMP,
                     '人因案例库', 'update', ?, 'success', ?, ?, '/review/human-cases',
                     'business', 'business', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              mergedCaseTitle,
              JSON.stringify({
                merged: true,
                actionQuality: 'mixed',
                outcomeType: 'mixed',
                primaryPattern: '推演链条过短'
              }),
              String(behaviorCase.id)
            ]
          );
        }
      }

      if (await migrationTableExists(db, 'event_records')) {
        await dbRun(
          db,
          `UPDATE event_records
           SET description = ?, impact = ?, note = ?, updated_at = CURRENT_TIMESTAMP
           WHERE title = 'AI需求推动存储价格上涨并向整机传导'
             AND COALESCE(is_deleted, 0) = 0`,
          [
            'AI需求不只直接增加算力、存储和电力消耗，还可能通过高利润产品抢占有限产能：产能和资本开支向HBM、服务器级DRAM等环节倾斜后，消费级DRAM/NAND的供给弹性可能下降，再向内存、SSD、整机BOM、渠道库存和二级价格传导。',
            '真正需要追踪的是“产能挤占 → 相邻供给收缩 → 零部件现货变化 → 整机和二级成交”的证据链，而不是看到AI上涨就直接购买所有相关商品。',
            '该事件已与“安卓机器：产业链推演只走一半，起飞后不追”合并提炼。CPU、GPU、HBM、DRAM、NAND约束不同；终端变化还需排除汇率、官方调价、型号切换、关税、库存释放和渠道炒作。'
          ]
        );
      }

      if (await migrationTableExists(db, 'rule_experiences')) {
        const ruleTitle = '大趋势要继续推演产能挤占和二三阶供需变化';
        const oldRuleTitle = '电子产品上游成本冲击不能只按迭代贬值看';
        let rule = await dbGet<{ id: number }>(
          db,
          `SELECT id
           FROM rule_experiences
           WHERE title IN (?, ?) AND COALESCE(is_deleted, 0) = 0
           ORDER BY CASE WHEN title = ? THEN 0 ELSE 1 END, id
           LIMIT 1`,
          [ruleTitle, oldRuleTitle, ruleTitle]
        );
        if (!rule) {
          await dbRun(
            db,
            `INSERT INTO rule_experiences
              (title, type, track, source_case, core_content, summary_conclusion, note,
               is_deleted, created_at, updated_at)
             VALUES (?, '产业传导/机会推演规则', '跨品类/电子产品', ?, ?, ?, ?,
                     0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              ruleTitle,
              '安卓机器产业链推演踏空；AI需求推动存储价格上涨并向整机传导',
              '发现大趋势后依次追问八层：1.直接需要什么；2.这些东西又需要什么；3.哪里供给扩张最慢；4.产能倾斜后谁会被挤出；5.被挤出的市场是否短缺涨价；6.最终传到什么商品、公司或资产；7.预期是否已被价格打满；8.当前是否符合风险体系。',
              '大趋势只是入口，真正的机会往往藏在趋势造成的第二阶、第三阶供需变化里。',
              '模板只负责进入观察和补证据，不自动生成操作结论。必须验证共享产能和真实传导，并排除汇率、官方调价、型号切换、关税、渠道库存及炒作；价格已经起飞后仍重新计算赔率。'
            ]
          );
        } else {
          await dbRun(
            db,
            `UPDATE rule_experiences
             SET title = ?, type = '产业传导/机会推演规则', track = '跨品类/电子产品',
                 source_case = ?, core_content = ?, summary_conclusion = ?, note = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              ruleTitle,
              '安卓机器产业链推演踏空；AI需求推动存储价格上涨并向整机传导',
              '发现大趋势后依次追问八层：1.直接需要什么；2.这些东西又需要什么；3.哪里供给扩张最慢；4.产能倾斜后谁会被挤出；5.被挤出的市场是否短缺涨价；6.最终传到什么商品、公司或资产；7.预期是否已被价格打满；8.当前是否符合风险体系。',
              '大趋势只是入口，真正的机会往往藏在趋势造成的第二阶、第三阶供需变化里。',
              '模板只负责进入观察和补证据，不自动生成操作结论。必须验证共享产能和真实传导，并排除汇率、官方调价、型号切换、关税、渠道库存及炒作；价格已经起飞后仍重新计算赔率。',
              rule.id
            ]
          );
        }
      }

      if (await migrationTableExists(db, 'speculation_cycle_records')) {
        await dbRun(
          db,
          `UPDATE speculation_cycle_records
           SET cycle_pattern = '大趋势 - 产能挤占 - 二三阶供需传导型',
               rise_nature = 'AI高利润需求争夺有限产能，消费级供给弹性下降后再向零部件、整机和二级市场传导',
               final_result = '已观察到存储零部件和部分终端价格变化；安卓案例证明前期推演不足会踏空，但每个终端的真实因果仍需逐项验证。',
               future_action_rule = '用八问模板向外推演并先进入观察层；确认共享产能、供给变化、渠道库存和真实成交后再评估机会，价格起飞后不追。',
               summary = '大趋势的直接受益通常最先被市场看见，更隐蔽的机会可能来自高利润需求挤占产能后，对相邻市场造成的二阶、三阶供需变化。',
               lesson = '年前看到了AI吃算力、内存和存储，却没有继续追踪产能挤占、消费级供给变化和终端传导。能力缺口是推演深度，不是事后应该追高。',
               note = '关联案例：安卓机器产业链推演踏空。该记录只提供观察框架，不自动影响交易或生意决策。',
               updated_at = CURRENT_TIMESTAMP
           WHERE category_name = '电子产品'
             AND object_name = '存储/整机传导'`
        );
      }
    }
  },
  {
    id: '20260819_001_add_silver_market_late_refresh',
    name: 'Add late silver market catch-up task',
    sql: `
      INSERT INTO task_center_tasks
        (task_key, name, domain, workspace, task_type, enabled, schedule_time,
         schedule_days, priority, config_json, last_status, last_message,
         created_at, updated_at)
      VALUES
        (
          'precious_metal_silver_catchup',
          '白银大盘晚间补抓',
          'market',
          'business',
          'precious_metal_market_update',
          1,
          '21:10',
          'work_days',
          35,
          '{"symbols":["SGE_AGTD"],"freshness_symbols":["SGE_AGTD"],"require_current_date":true,"retry_when_stale":true,"retry_after_minutes":30,"task_timeout_minutes":30}',
          'pending',
          '晚间单独检查上金所白银；当天数据尚未发布时每30分钟重试',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      ON CONFLICT(task_key) DO UPDATE SET
        name = excluded.name,
        domain = excluded.domain,
        workspace = excluded.workspace,
        task_type = excluded.task_type,
        enabled = excluded.enabled,
        schedule_time = excluded.schedule_time,
        schedule_days = excluded.schedule_days,
        priority = excluded.priority,
        config_json = excluded.config_json,
        updated_at = CURRENT_TIMESTAMP;
    `
  },
  {
    id: '20260820_001_normalize_precious_metal_master_data',
    name: 'Normalize precious metal objects without placeholder variants',
    sql: `
      INSERT OR IGNORE INTO categories
        (name, is_archived, archived_at, created_at, updated_at)
      VALUES
        ('贵金属', 0, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      UPDATE categories
      SET is_archived = 0,
          archived_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE name = '贵金属';

      INSERT OR IGNORE INTO objects
        (category_id, name, is_archived, archived_at, created_at, updated_at)
      SELECT id, '黄金', 0, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM categories
      WHERE name = '贵金属';

      INSERT OR IGNORE INTO objects
        (category_id, name, is_archived, archived_at, created_at, updated_at)
      SELECT id, '白银', 0, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM categories
      WHERE name = '贵金属';

      INSERT OR IGNORE INTO objects
        (category_id, name, is_archived, archived_at, created_at, updated_at)
      SELECT id, '其它', 0, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM categories
      WHERE name = '贵金属';

      UPDATE objects
      SET is_archived = CASE WHEN name IN ('黄金', '白银', '其它') THEN 0 ELSE 1 END,
          archived_at = CASE
            WHEN name IN ('黄金', '白银', '其它') THEN NULL
            ELSE COALESCE(archived_at, CURRENT_TIMESTAMP)
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE category_id = (SELECT id FROM categories WHERE name = '贵金属');

      DELETE FROM variants
      WHERE object_id IN (
        SELECT o.id
        FROM objects o
        JOIN categories c ON c.id = o.category_id
        WHERE c.name = '贵金属'
          AND o.name IN ('黄金', '白银', '其它')
      );
    `
  },
  {
    id: '20260822_001_add_case_pricing_analysis_and_collectible_samples',
    name: 'Add case price formation analysis and collectible scarcity samples',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'behavior_cases'))) return;
      if (!(await migrationTableExists(db, 'behavior_patterns'))) return;
      if (!(await migrationTableExists(db, 'behavior_case_pattern_links'))) return;

      await ensureMigrationColumn(
        db,
        'behavior_cases',
        'pricing_analysis_json',
        "TEXT NOT NULL DEFAULT '{}'"
      );

      const oldResearchPattern = await dbGet<{ id: number }>(
        db,
        `SELECT id FROM behavior_patterns
         WHERE axis = 'human' AND name = '推演链条过短' AND is_deleted = 0
         ORDER BY id LIMIT 1`
      );
      const existingResearchPattern = await dbGet<{ id: number }>(
        db,
        `SELECT id FROM behavior_patterns
         WHERE axis = 'human' AND name = '研究与推演停在表层' AND is_deleted = 0
         ORDER BY id LIMIT 1`
      );

      let researchPatternId = existingResearchPattern?.id || oldResearchPattern?.id;
      if (oldResearchPattern && existingResearchPattern && oldResearchPattern.id !== existingResearchPattern.id) {
        await dbRun(
          db,
          `DELETE FROM behavior_case_pattern_links
           WHERE pattern_id = ?
             AND EXISTS (
               SELECT 1 FROM behavior_case_pattern_links canonical
               WHERE canonical.case_id = behavior_case_pattern_links.case_id
                 AND canonical.pattern_id = ?
             )`,
          [oldResearchPattern.id, existingResearchPattern.id]
        );
        await dbRun(
          db,
          `UPDATE behavior_case_pattern_links
           SET pattern_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE pattern_id = ?`,
          [existingResearchPattern.id, oldResearchPattern.id]
        );
        await dbRun(
          db,
          `UPDATE behavior_patterns
           SET status = 'archived', is_deleted = 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [oldResearchPattern.id]
        );
        researchPatternId = existingResearchPattern.id;
      }

      if (!researchPatternId) {
        await dbRun(
          db,
          `INSERT INTO behavior_patterns
            (name, axis, category, summary, trigger_phrases_json, observable_actions_json,
             mechanism, risk_chain, counter_question, protective_action, positive_counterpart,
             maturity, status, sort_order, note, is_deleted, created_at, updated_at)
           VALUES ('研究与推演停在表层', 'human', 'execution_error', '', '[]', '[]', '', '', '', '', '',
                   'candidate', 'active', 260, '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        );
        const inserted = await dbGet<{ id: number }>(
          db,
          `SELECT id FROM behavior_patterns
           WHERE axis = 'human' AND name = '研究与推演停在表层' AND is_deleted = 0
           ORDER BY id LIMIT 1`
        );
        researchPatternId = inserted?.id;
      }

      if (!researchPatternId) throw new Error('Research depth behavior pattern could not be created');
      await dbRun(
        db,
        `UPDATE behavior_patterns
         SET name = '研究与推演停在表层',
             category = 'execution_error',
             summary = ?, trigger_phrases_json = ?, observable_actions_json = ?,
             mechanism = ?, risk_chain = ?, counter_question = ?, protective_action = ?,
             positive_counterpart = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          '已经看见值得研究的方向，却停在基础价格、直接需求或表面标签，没有继续拆解价值层级、稀缺交集、供给结构和定价者，等高溢价出现后才看见完整机会。',
          JSON.stringify(['大方向已经看懂', '普通品就这个价', '这些标签应该差不多', '等价格出来再研究']),
          JSON.stringify(['研究停在第一层', '没有建立关键条件观察表', '机会起飞后才回头补逻辑']),
          '表层信息最容易取得，也最容易形成“已经理解”的错觉；真正决定赔率的条件交集、供给边界和定价结构没有进入持续观察。',
          '看见方向或标的 → 只研究基础层 → 漏掉关键条件交集 → 稀缺溢价被市场发现 → 只能踏空或冒险追高',
          '这个市场的价格由哪几层组成，哪些条件的交集决定稀缺，谁在定价，又由谁提供退出？',
          '发现方向后继续拆解价值层级、条件交集、真实供给、买家类型、实际成交和退出深度；未经验证先放观察层，价格起飞后仍不追高。',
          '持续深挖、结构拆解、提前观察、起飞后守纪律',
          researchPatternId
        ]
      );

      const upsertMarketPattern = async (pattern: {
        name: string;
        summary: string;
        triggers: string[];
        actions: string[];
        mechanism: string;
        riskChain: string;
        counterQuestion: string;
        protectiveAction: string;
        positiveCounterpart: string;
        sortOrder: number;
      }) => {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO behavior_patterns
            (name, axis, category, summary, trigger_phrases_json, observable_actions_json,
             mechanism, risk_chain, counter_question, protective_action, positive_counterpart,
             maturity, status, sort_order, note, is_deleted, created_at, updated_at)
           VALUES (?, 'market', 'market_structure', ?, ?, ?, ?, ?, ?, ?, ?,
                   'candidate', 'active', ?, '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            pattern.name,
            pattern.summary,
            JSON.stringify(pattern.triggers),
            JSON.stringify(pattern.actions),
            pattern.mechanism,
            pattern.riskChain,
            pattern.counterQuestion,
            pattern.protectiveAction,
            pattern.positiveCounterpart,
            pattern.sortOrder
          ]
        );
        await dbRun(
          db,
          `UPDATE behavior_patterns
           SET category = 'market_structure', summary = ?, trigger_phrases_json = ?,
               observable_actions_json = ?, mechanism = ?, risk_chain = ?,
               counter_question = ?, protective_action = ?, positive_counterpart = ?,
               sort_order = ?, updated_at = CURRENT_TIMESTAMP
           WHERE axis = 'market' AND name = ? AND is_deleted = 0`,
          [
            pattern.summary,
            JSON.stringify(pattern.triggers),
            JSON.stringify(pattern.actions),
            pattern.mechanism,
            pattern.riskChain,
            pattern.counterQuestion,
            pattern.protectiveAction,
            pattern.positiveCounterpart,
            pattern.sortOrder,
            pattern.name
          ]
        );
      };

      await upsertMarketPattern({
        name: '运营制造稀缺',
        summary: '通过专标、渠道门槛、粉丝身份和集中传播制造辨识度与稀缺叙事，再由组织化买盘逐级抬高价格。',
        triggers: ['网红或团队专标', '封闭粉丝渠道', '收货价连续抬高', '普通底货被重新命名'],
        actions: ['把运营标签当自然稀缺', '用单一团队持续收货证明长期需求', '高位跟随专标故事补票'],
        mechanism: '标签和流量可以真实改变短期需求，但溢价高度依赖运营方持续传播、收货和组织接力，退出流动性未必独立存在。',
        riskChain: '专标与渠道造势 → 低价首发 → 集中抬价收货 → 跟风盘进入 → 团队兑现或停止维护 → 买盘骤减',
        counterQuestion: '去掉专标名称、网红流量和核心团队收货，这件商品还有多少独立买家愿意按当前价接？',
        protectiveAction: '把运营溢价与底货价值分开；观察核心团队停手后的成交，不因公开高价收货追入。',
        positiveCounterpart: '识别运营定价、只做能力圈内低位参与',
        sortOrder: 52
      });
      await upsertMarketPattern({
        name: '组合稀缺与圈层定价',
        summary: '首日、满分、顶级号码等真实稀缺条件形成极小交集，价格由少数专业买家的边际报价决定，溢价可能非线性放大。',
        triggers: ['多个稀缺条件同时命中', '普通品与顶级组合价差巨大', '少数专业买家公开高价收货'],
        actions: ['把条件溢价简单相加', '把单个高价报价当普遍市场价', '忽略关键买家退出后的流动性'],
        mechanism: '组合交集可能接近孤品，稀缺性可以真实存在；但市场很薄时，一个边际买家也能定义价格，真实稀缺不自动等于稳定流动性。',
        riskChain: '真实条件交集 → 圈层识别价值 → 集中高价收货 → 报价形成锚点 → 跟风追入 → 核心买家退出后价差扩大',
        counterQuestion: '稀缺条件是否可核验，有几名互不关联的买家，实际成交和退出深度分别是什么？',
        protectiveAction: '同时验证稀缺性、买盘宽度和退出深度；单个收购报价只作观察证据，不直接当稳定估值。',
        positiveCounterpart: '理解组合稀缺，同时尊重薄市场流动性',
        sortOrder: 54
      });

      const findPatternId = async (name: string) => {
        const row = await dbGet<{ id: number }>(
          db,
          `SELECT id FROM behavior_patterns
           WHERE name = ? AND is_deleted = 0 AND status = 'active'
           ORDER BY id LIMIT 1`,
          [name]
        );
        if (!row) throw new Error(`Required behavior pattern is missing: ${name}`);
        return row.id;
      };
      const replaceCasePatterns = async (
        caseId: number,
        links: Array<{ name: string; role: 'primary' | 'secondary' }>
      ) => {
        await dbRun(db, 'DELETE FROM behavior_case_pattern_links WHERE case_id = ?', [caseId]);
        for (const link of links) {
          await dbRun(
            db,
            `INSERT INTO behavior_case_pattern_links
              (case_id, pattern_id, role, note, created_at, updated_at)
             VALUES (?, ?, ?, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [caseId, await findPatternId(link.name), link.role]
          );
        }
      };

      const luckyCaseTitle = '工商25龙：首日+70分+如意王的17倍收购观察';
      const luckyPricingAnalysis = JSON.stringify({
        basePriceLabel: '工商25龙普通卡当前参考价',
        basePrice: 1000,
        observedPriceLabel: '首日+70分+如意王公开收购报价',
        observedPriceLow: 17000,
        observedPriceHigh: 17000,
        priceSignalType: 'bid',
        conditionStack: ['首日', '评级70分', '如意王'],
        buyerBreadth: 'single',
        keyBuyerDependency: 'high',
        exitLiquidity: 'thin',
        verificationNote: '目前确认的是有人公开按17000元收购；尚未确认实际成交、独立买家数量以及核心收货人停止后还能否维持该价格。'
      });
      let luckyCase = await dbGet<{ id: number }>(
        db,
        `SELECT id FROM behavior_cases
         WHERE title = ? AND is_deleted = 0 ORDER BY id LIMIT 1`,
        [luckyCaseTitle]
      );
      if (!luckyCase) {
        await dbRun(
          db,
          `INSERT INTO behavior_cases
            (title, origin_type, subject_alias, source_note, evidence_level, case_date,
             track, project_name, background, visible_information, pressure_context,
             action_taken, result, action_quality, outcome_type, evidence_role,
             self_response, learn_to_keep, learn_to_avoid, applicability_boundary,
             linked_rule_refs_json, source_type, source_id, source_snapshot_json,
             pricing_analysis_json, note, is_deleted, created_at, updated_at)
           VALUES (?, 'self', '本人观察', ?, 'first_hand', '2026-08-22',
                   '纪念币/评级卡', '工商25龙银币智能卡', ?, ?, ?, ?, ?,
                   'mixed', 'ongoing', 'boundary', ?, ?, ?, ?, ?, '', '', ?, ?, ?,
                   0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            luckyCaseTitle,
            '来自本人看到的行业收货信息；17000元是收购报价，不按已成交或普遍市场价记录。评级机构、实际成交和独立买家数量仍待补证。',
            '工商25龙普通卡当前约1000元。此前主要关注普通品、评级和靓号的单独价值，没有把首日、70分和顶级靓号的条件交集作为独立市场持续研究。',
            '可见信息是：普通工商25龙约1000元；一张同时满足“首日+评级70分+如意王”的卡有人按17000元收购，约为普通品的17倍。该组合条件本身苛刻，背后同时存在集中收货和抬价力量。',
            '看见前两个月可能存在低位研究和布局窗口，容易产生后悔，并把当前高价倒推成“当时一定应该买”；公开高价报价也容易制造错失感和价格锚。',
            '前期没有建立复合条件观察清单；当前看到高价收购后不追入，先把基础品、首日、评级、号码、买盘和退出深度分层记录。',
            '案例仍在观察。当前只能确认一个17000元收购报价，不能确认广泛成交和稳定退出；后续需要跟踪独立买家、真实成交及核心买盘停手后的价格。',
            '以后进入小众评级品市场，先建立“底货价值→首日属性→评级分数→号码等级→组合稀缺→买家宽度→退出深度”的观察链；低位只做能力圈内的小参与，价格起飞后不因后悔追高。',
            '吸收专业玩家对首日、满分、顶级号码交集稀缺的识别能力，并提前维护观察样本。',
            '避免把单个高价收购当成稳定市价，避免用现在的17倍报价否定当时信息不足下的谨慎，也避免为了补课在高位追入。',
            '适用于首日、评级、靓号、专属标签等小众收藏品；普通通货和买家广泛的标准品不能照搬。基础品价格只提供底层参照，不直接决定顶级组合价。',
            JSON.stringify([
              '稀缺是真的，不等于价格和流动性都稳定',
              '单个高价收购只能证明一个买盘，不能代表普遍市场价',
              '研究要拆到价值层级和条件交集，起飞后仍不追高'
            ]),
            JSON.stringify({
              capturedBy: 'migration-20260822_001',
              observationType: 'market_bid',
              observedAt: '2026-08-22'
            }),
            luckyPricingAnalysis,
            '首版按观察案例落库。当地普通品和高价收购都存在几十元到更大幅度的市场波动，后续以真实成交补充，不把一次报价固化为估值模型。'
          ]
        );
        luckyCase = await dbGet<{ id: number }>(
          db,
          `SELECT id FROM behavior_cases
           WHERE title = ? AND is_deleted = 0 ORDER BY id LIMIT 1`,
          [luckyCaseTitle]
        );
      } else {
        await dbRun(
          db,
          `UPDATE behavior_cases
           SET pricing_analysis_json = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [luckyPricingAnalysis, luckyCase.id]
        );
      }
      if (!luckyCase) throw new Error('ICBC 2025 Longyinbi scarcity case could not be created');
      await replaceCasePatterns(luckyCase.id, [
        { name: '研究与推演停在表层', role: 'primary' },
        { name: '组合稀缺与圈层定价', role: 'secondary' },
        { name: '资金拉盘', role: 'secondary' }
      ]);

      let facaiCase = await dbGet<{ id: number }>(
        db,
        `SELECT id FROM behavior_cases
         WHERE is_deleted = 0
           AND (title = '发财龙网红专标：真成交≠真承接'
                OR title = '发财龙网红专标：运营制造稀缺，真成交不等于真承接'
                OR project_name = '发财龙（PMG网红专标）')
         ORDER BY id LIMIT 1`
      );
      if (!facaiCase) {
        await dbRun(
          db,
          `INSERT INTO behavior_cases
            (title, origin_type, subject_alias, source_note, evidence_level, case_date,
             track, project_name, background, visible_information, pressure_context,
             action_taken, result, action_quality, outcome_type, evidence_role,
             self_response, learn_to_keep, learn_to_avoid, applicability_boundary,
             linked_rule_refs_json, source_type, source_id, source_snapshot_json,
             pricing_analysis_json, note, is_deleted, created_at, updated_at)
           VALUES ('发财龙网红专标：运营制造稀缺，真成交不等于真承接',
                   'self', '本人', ?, 'first_hand', '2026-07-23',
                   '纪念钞', '发财龙（PMG网红专标）', ?, '', '', ?, '',
                   'good', 'ongoing', 'boundary', ?, '', '', '', '[]', '', '', ?,
                   '{}', '', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            '本人参与过首发资格判断，并持续观察网红专标的成交、抬价收货和后续供给。',
            '网红专标通过粉丝渠道、集中收货和持续传播形成短期高溢价。',
            '没有为了粉丝团门槛额外付费入场，价格拉高后也没有追入。',
            '先拆底货价值、运营溢价和核心团队买盘，再判断是否存在独立承接。',
            JSON.stringify({
              capturedBy: 'migration-20260822_001',
              observationType: 'operated_special_label'
            })
          ]
        );
        facaiCase = await dbGet<{ id: number }>(
          db,
          `SELECT id FROM behavior_cases
           WHERE project_name = '发财龙（PMG网红专标）' AND is_deleted = 0
           ORDER BY id LIMIT 1`
        );
      }
      if (facaiCase) {
        const facaiPricingAnalysis = JSON.stringify({
          basePriceLabel: '原始发售价',
          basePrice: 670,
          observedPriceLabel: '近期市场拉升区间',
          observedPriceLow: 6000,
          observedPriceHigh: 7000,
          priceSignalType: 'market_reference',
          conditionStack: ['PMG网红专标', '粉丝团渠道', '团队持续抬价收货'],
          buyerBreadth: 'concentrated',
          keyBuyerDependency: 'high',
          exitLiquidity: 'thin',
          verificationNote: '已有真实成交和持续拉升现象，但独立终端需求、后续13000套供给以及核心团队停手后的承接仍待验证。'
        });
        await dbRun(
          db,
          `UPDATE behavior_cases
           SET title = '发财龙网红专标：运营制造稀缺，真成交不等于真承接',
               background = ?, visible_information = ?, pressure_context = ?,
               action_taken = ?, result = ?, action_quality = 'good', outcome_type = 'ongoing',
               evidence_role = 'boundary', self_response = ?, learn_to_keep = ?,
               learn_to_avoid = ?, applicability_boundary = ?, pricing_analysis_json = ?,
               note = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            '团队申请PMG网红专标，借助千万级网红的粉丝影响力首轮按低价或市场价销售，再由一部分人持续在市场加价收货，逐级抬高价格并吸引跟风盘。行业里类似玩法还会更换为如意、比特、中华等不同专标名称。',
            '原价约670元，早期数日达到约2600元，近期又被推至约6000-7000元；首发约6000套，后续还有约13000套。成交可以真实存在，但价格形成高度依赖团队运营、粉丝渠道和持续抬价收货。',
            '真实成交、网红光环和连续上涨会让人产生“还有下一棒”的错觉；每个跟随者都容易相信自己不会成为最后接盘的人。',
            '没有为了粉丝团三级资格额外刷礼物入场；行情拉高后也不补票，转而拆解团队如何造势、抬价、吸引跟风，以及后续供给由谁承接。',
            '价格已经继续上冲到约6000-7000元，但后续13000套如何释放、核心团队何时停手、独立买家能否承接仍未完成验证。上涨扩大了案例价值，没有证明高位参与安全。',
            '专标先拆底货价值、运营溢价和核心团队买盘；真成交只证明当下有人换手。没有独立买家宽度和退出深度时，不把运营出来的稀缺价外推，更不在高位补票。',
            '吸收团队在标签、流量、渠道和价格节奏上的运营能力，同时学会识别谁在创造需求、谁在维持报价。',
            '避免把专标名称当成自然稀缺，避免因为真实成交和继续上涨就认为后续一定有人接盘。',
            '适用于网红专标、圈层专标和运营型小众收藏品；不用于否定首日、满分、顶级号码等可核验的真实组合稀缺，两类案例必须分开分析。',
            facaiPricingAnalysis,
            '后续重点验证：核心团队停止抬价后是否仍有独立买家，以及约13000套后续供给如何影响成交和价格。',
            facaiCase.id
          ]
        );
        await replaceCasePatterns(facaiCase.id, [
          { name: '主动放弃与纪律优先', role: 'primary' },
          { name: '运营制造稀缺', role: 'secondary' },
          { name: '资金拉盘', role: 'secondary' }
        ]);
      }

      if (await migrationTableExists(db, 'audit_logs')) {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO audit_logs
            (id, timestamp, module, action, target, status, detail, entity_id,
             path, domain, workspace, created_at, updated_at)
           VALUES ('audit-human-case-icbc-2025-scarcity-20260822', CURRENT_TIMESTAMP,
                   '人因案例库', 'create', ?, 'success', ?, ?, '/review/human-cases',
                   'business', 'business', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            luckyCaseTitle,
            JSON.stringify({
              priceSignalType: 'bid',
              basePrice: 1000,
              observedPrice: 17000,
              primaryPattern: '研究与推演停在表层'
            }),
            String(luckyCase.id)
          ]
        );
      }
    }
  },
  {
    id: '20260825_001_refine_icbc_lucky_number_circle_pricing_case',
    name: 'Refine ICBC lucky-number case with circle-specific pricing boundary',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'behavior_cases'))) return;
      if (!(await migrationTableExists(db, 'behavior_patterns'))) return;
      if (!(await migrationTableExists(db, 'behavior_case_pattern_links'))) return;

      const caseTitle = '工商25龙：首日+70分+如意王的17倍收购观察';
      const behaviorCase = await dbGet<{ id: number }>(
        db,
        `SELECT id
         FROM behavior_cases
         WHERE title = ? AND is_deleted = 0
         ORDER BY id LIMIT 1`,
        [caseTitle]
      );
      if (!behaviorCase) {
        throw new Error('ICBC 2025 lucky-number circle-pricing case is missing');
      }

      const circlePattern = await dbGet<{ id: number }>(
        db,
        `SELECT id
         FROM behavior_patterns
         WHERE axis = 'market'
           AND name = '组合稀缺与圈层定价'
           AND is_deleted = 0
         ORDER BY id LIMIT 1`
      );
      if (!circlePattern) {
        throw new Error('Circle-specific collectible pricing pattern is missing');
      }

      await dbRun(
        db,
        `UPDATE behavior_patterns
         SET summary = ?,
             trigger_phrases_json = ?,
             observable_actions_json = ?,
             mechanism = ?,
             risk_chain = ?,
             counter_question = ?,
             protective_action = ?,
             positive_counterpart = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          '基础稀缺条件只提供入场券，真正放大价格的是特定号码被固定玩家圈层认可并持续收货；同条件下非圈层目标号码可能低很多。',
          JSON.stringify([
            '龙头、首日、70分和靓号等条件同时命中',
            '特定号码被固定圈层反复收货',
            '同等级不同号码价格差距巨大',
            '圈内报价显著高于圈外成交'
          ]),
          JSON.stringify([
            '把所有靓号视为同一等级',
            '把圈内目标号报价外推为普遍市价',
            '圈外人在价格抬高后追入',
            '按稀缺倍数而不是买家宽度决定仓位'
          ]),
          '龙头、首日、满分和靓号提供可核验的基础稀缺，特定玩家圈层决定真正追逐的号码与边际报价。额外溢价依赖圈层共识和持续承接，并非所有靓号共享；圈层停止收货后，价格可能回落到普通70分或普通靓号价格带。',
          '基础条件稀缺 → 特定圈层锁定目标号码 → 提前埋伏并持续收货 → 圈内报价抬高 → 圈外跟价追入 → 圈层停收 → 高位买家退出困难',
          '这个号码是否是圈层长期认可的目标号？有多少互不关联的真实买家？去掉核心圈层收货后，同条件非目标号码实际成交多少？',
          '圈外只允许前期低价、小量埋伏，把它当研究性参与权；高位不追。只有圈层偏好、真实成交和退出对象同时明确时，才承认额外溢价，仓位按买家宽度而不是稀缺倍数控制。',
          '提前识别圈层目标号、小量研究性埋伏、先确认退出对象',
          circlePattern.id
        ]
      );

      const pricingAnalysis = JSON.stringify({
        basePriceLabel: '工商25龙普通卡当前参考价',
        basePrice: 1000,
        observedPriceLabel: '首日+70分+圈层目标号“如意王”收购报价',
        observedPriceLow: 17000,
        observedPriceHigh: 17000,
        priceSignalType: 'bid',
        conditionStack: ['龙头', '首日', '评级70分', '圈层目标号：如意王'],
        buyerBreadth: 'concentrated',
        keyBuyerDependency: 'high',
        exitLiquidity: 'thin',
        verificationNote: '已确认有一批玩家专门交易特定靓号，17000元是圈层目标号“如意王”的收购报价；同样龙头、70分和靓号条件下，非圈层目标号码价格低很多。仍需继续验证独立买家数量、真实成交以及圈层停止收货后的退出价格。'
      });

      await dbRun(
        db,
        `UPDATE behavior_cases
         SET source_note = ?,
             background = ?,
             visible_information = ?,
             pressure_context = ?,
             action_taken = ?,
             result = ?,
             self_response = ?,
             learn_to_keep = ?,
             learn_to_avoid = ?,
             applicability_boundary = ?,
             linked_rule_refs_json = ?,
             pricing_analysis_json = ?,
             note = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          '来自本人持续观察的行业收货信息。17000元是特定圈层目标号的收购报价，不按普遍市场价记录；同条件非目标靓号价格明显更低，实际成交与圈层停收后的退出深度仍待持续验证。',
          '工商25龙是龙银币智能卡龙头，普通卡当前约1000元。首日、70分和靓号是基础稀缺条件，但后续确认同样条件下不同号码价格差异巨大；此前没有识别“特定号码玩家圈层”这一层定价结构。',
          '可见信息是：工商25龙普通卡约1000元；一张同时满足“龙头+首日+评级70分+如意王”的卡有人按17000元收购。行业里有一批玩家专门交易特定靓号，收货和定价集中在他们认可的号码；同样是龙头、70分和靓号，但不是圈层目标号，价格会低很多。',
          '看见17倍报价和此前可能存在的低位窗口，容易产生错失感，并把“龙头+首日+70分+靓号”误记成机械翻倍公式；连续抬价还会诱使圈外参与者相信自己不会接最后一棒。',
          '前期没有建立圈层目标号观察清单；当前不追入，改为拆分记录底货、首日、评级、普通靓号、圈层目标号、买家宽度和退出深度。以后圈外只考虑前期低价、小量研究性埋伏。',
          '案例仍在观察。17000元报价证明特定圈层愿意为目标号给出高价，不证明所有靓号都有同等价值，也不证明高位存在稳定退出；圈层承接停止后，额外溢价可能迅速收缩。',
          '以后按“底货价值→首日属性→评级分数→号码等级→是否圈层目标号→买家宽度→退出深度”逐层判断。目标号与非目标号必须建立对照样本，圈外高位不追。',
          '学习识别固定玩家圈层真正认可的号码、收货节奏和退出对象；前期低价时只用小仓收集研究样本。',
          '避免把龙头+首日+70分+靓号当成翻倍公式，避免把圈内目标号报价外推到所有靓号，更不在圈层抬价后以大仓追入。',
          '适用于首日、评级、号码等条件共同定价的小众收藏品。只有特定号码偏好、圈层买家和真实退出路径可以核验时，才承认圈层溢价；普通靓号、标准品和买家广泛的通货不能照搬。',
          JSON.stringify([
            '龙头+首日+70分+靓号只是稀缺入场券，不是翻倍公式',
            '特定圈层认可、持续收货和真实成交同时成立，才承认额外溢价',
            '圈外只做前期低价小量埋伏；高位不追，仓位按买家宽度控制',
            '圈层停收后，价格可能回落到普通70分或普通靓号价格带'
          ]),
          pricingAnalysis,
          '2026-08-25校准：将案例从泛化的“组合条件自动放大”修正为“特定号码圈层定价”。后续重点对照目标号与非目标号成交，并观察核心圈层停收后的真实退出价格。',
          behaviorCase.id
        ]
      );

      const existingCircleLink = await dbGet<{ case_id: number }>(
        db,
        `SELECT case_id
         FROM behavior_case_pattern_links
         WHERE case_id = ? AND pattern_id = ?`,
        [behaviorCase.id, circlePattern.id]
      );
      if (existingCircleLink) {
        await dbRun(
          db,
          `UPDATE behavior_case_pattern_links
           SET role = 'secondary', note = ?, updated_at = CURRENT_TIMESTAMP
           WHERE case_id = ? AND pattern_id = ?`,
          [
            '核心市场结构：额外溢价来自特定号码玩家圈层，不适用于所有靓号。',
            behaviorCase.id,
            circlePattern.id
          ]
        );
      } else {
        await dbRun(
          db,
          `INSERT INTO behavior_case_pattern_links
            (case_id, pattern_id, role, note, created_at, updated_at)
           VALUES (?, ?, 'secondary', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            behaviorCase.id,
            circlePattern.id,
            '核心市场结构：额外溢价来自特定号码玩家圈层，不适用于所有靓号。'
          ]
        );
      }

      if (await migrationTableExists(db, 'audit_logs')) {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO audit_logs
            (id, timestamp, module, action, target, status, detail, entity_id,
             path, domain, workspace, created_at, updated_at)
           VALUES ('audit-human-case-icbc-2025-circle-pricing-20260825', CURRENT_TIMESTAMP,
                   '人因案例库', 'update', ?, 'success', ?, ?, '/review/human-cases',
                   'business', 'business', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            caseTitle,
            JSON.stringify({
              correction: '特定号码圈层定价，不外推为所有靓号的稳定溢价',
              priceSignalType: 'bid',
              observedPrice: 17000,
              buyerBreadth: 'concentrated',
              marketPattern: '组合稀缺与圈层定价'
            }),
            String(behaviorCase.id)
          ]
        );
      }
    }
  },
  {
    id: '20260831_001_add_event_transmission_analysis',
    name: 'Add structured transmission analysis to event records',
    run: async db => {
      await ensureMigrationColumn(db, 'event_records', 'transmission_analysis_json', 'TEXT');
    }
  },
  {
    id: '20260831_002_seed_android_event_transmission',
    name: 'Connect Android supply-chain event to existing reviews and evidence',
    run: async db => {
      if (!(await migrationTableExists(db, 'event_records'))) return;

      const event = await dbGet<{ id: number; transmission_analysis_json?: string | null }>(
        db,
        `SELECT id, transmission_analysis_json
         FROM event_records
         WHERE title = 'AI需求推动存储价格上涨并向整机传导'
           AND COALESCE(is_deleted, 0) = 0
         ORDER BY id LIMIT 1`
      );
      if (!event || String(event.transmission_analysis_json || '').trim()) return;

      const missedReview = await dbGet<{ id: number; title: string }>(
        db,
        `SELECT id, title
         FROM missed_projects
         WHERE COALESCE(is_deleted, 0) = 0
           AND (title = '安卓机器：产业链推演只走一半，起飞后不追'
             OR project_name = '安卓机器/消费级存储与整机')
         ORDER BY id LIMIT 1`
      );
      const behaviorCase = missedReview
        ? await dbGet<{ id: number; title: string }>(
            db,
            `SELECT id, title
             FROM behavior_cases
             WHERE is_deleted = 0
               AND source_type = 'missed_project'
               AND source_id = ?
             ORDER BY id LIMIT 1`,
            [String(missedReview.id)]
          )
        : undefined;
      const rule = await dbGet<{ id: number; title: string }>(
        db,
        `SELECT id, title
         FROM rule_experiences
         WHERE COALESCE(is_deleted, 0) = 0
           AND title = '大趋势要继续推演产能挤占和二三阶供需变化'
         ORDER BY id LIMIT 1`
      );

      const evidenceReferences = [
        missedReview ? {
          sourceType: 'missed_project',
          sourceId: String(missedReview.id),
          title: missedReview.title,
          path: `/review/missed?recordId=${missedReview.id}`,
          relation: '原始复盘'
        } : null,
        missedReview && behaviorCase ? {
          sourceType: 'behavior_case',
          sourceId: String(behaviorCase.id),
          title: behaviorCase.title,
          path: `/review/human-cases?view=cases&sourceType=missed_project&sourceId=${missedReview.id}&mode=distill`,
          relation: '提炼案例'
        } : null,
        rule ? {
          sourceType: 'rule_experience',
          sourceId: String(rule.id),
          title: rule.title,
          path: `/review/rule?recordId=${rule.id}`,
          relation: '沉淀规则'
        } : null
      ].filter(Boolean);

      const transmissionAnalysis = {
        status: 'partially_verified',
        directImpact: 'AI资本开支扩张，HBM、服务器级DRAM和NAND等高利润需求增加。',
        secondOrderImpact: '存储厂商把更多产能和资本开支转向高利润产品，消费级DRAM和NAND的供给弹性可能下降。',
        thirdOrderImpact: '内存、SSD的成本和库存变化继续向安卓手机、PC、游戏机等整机及二级市场价格传导。',
        changedLink: '消费级存储零部件和部分安卓终端已经出现价格上涨或价格支撑。',
        pendingRepricingLink: '具体安卓SKU、PC和游戏机是否继续传导，仍需按商品价格、库存与回收价分别确认。',
        expectedLag: '零部件、渠道库存和整机逐级传导，时滞不固定。',
        validationIndicators: '消费级DRAM/NAND现货价；内存和SSD渠道价；厂商产能配置；安卓手机、PC、游戏机库存、成交价和回收价。',
        counterEvidence: '消费级供给恢复、库存集中释放，或终端变化主要由汇率、官方调价、型号切换、关税、补贴和渠道炒作解释。',
        reviewDate: '',
        validationNote: '已有存储零部件和部分终端价格变化作为阶段证据；安卓机器案例说明前期推演不足会踏空，但每个终端的真实因果仍需逐项验证。',
        targets: [],
        evidenceReferences
      };

      await dbRun(
        db,
        `UPDATE event_records
         SET transmission_analysis_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND (transmission_analysis_json IS NULL OR TRIM(transmission_analysis_json) = '')`,
        [JSON.stringify(transmissionAnalysis), event.id]
      );
    }
  },
  {
    id: '20260903_001_seed_fuyao_trading_survival_case',
    name: 'Add Fuyao trading survival and discipline rebuilding case',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'behavior_cases'))) return;
      if (!(await migrationTableExists(db, 'behavior_patterns'))) return;
      if (!(await migrationTableExists(db, 'behavior_case_pattern_links'))) return;

      const title = '扶摇聊交易：从反复爆仓到“先不死”的账户重建';
      let behaviorCase = await dbGet<{ id: number }>(
        db,
        `SELECT id
         FROM behavior_cases
         WHERE title = ? AND is_deleted = 0
         ORDER BY id
         LIMIT 1`,
        [title]
      );

      if (!behaviorCase) {
        await dbRun(
          db,
          `INSERT INTO behavior_cases
            (title, origin_type, subject_alias, source_note, evidence_level, case_date,
             track, project_name, background, visible_information, pressure_context,
             action_taken, result, action_quality, outcome_type, evidence_role,
             self_response, learn_to_keep, learn_to_avoid, applicability_boundary,
             linked_rule_refs_json, source_type, source_id, source_snapshot_json,
             pricing_analysis_json, note, is_deleted, created_at, updated_at)
           VALUES (?, 'public', ?, ?, 'unconfirmed', NULL,
                   '杠杆交易（期货/外汇未确认）', '账户爆仓与纪律重建', ?, ?, ?,
                   ?, ?, 'mixed', 'mixed', 'boundary',
                   ?, ?, ?, ?, ?, '', '', ?, '{}', ?, 0,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            title,
            '扶摇聊交易',
            '抖音平台本人公开口述，由用户转述。原视频链接尚未保存；具体交易品种、时间线、金额和后续账户结果均未独立核验。',
            '其自述从约100美元的小账户起步，曾做到接近1万美元。早期盈利强化了暴富想象，随后不断放大仓位和杠杆；具体交易载体可能是期货或外汇，目前未确认。',
            '账户曾从约100美元快速增长到接近1万美元；随着仓位和情绪同步放大，交易从小额试错变成重仓梭哈。爆仓后没有先缩减风险，而是试图用更重的下一笔把亏损翻回来。',
            '连续盈利带来自我证明和暴富幻想；爆仓后的回本冲动、债务压力和绝望又激活赌性。后来他从激进摆向过度防守，不敢承受正常浮亏，并在出现浮盈时过早离场。',
            '1. 小仓尝到甜头后逐步放大仓位，转向高杠杆、重仓和梭哈。\n2. 爆仓后继续加码，亏损越大下一次仓位越重，并开始借钱交易。\n3. 账户只剩约100美元时制定重建计划：不再乱做，只做系统内机会；每笔最多亏3美元；每天最多3单；严格执行止损。\n4. 账户做到约170美元后逐步恢复信心；即使连续亏损10次，仍按规则运行，不再用恐惧或加仓翻本回应。\n5. 后续从姐姐处借入2万元人民币扩大资金，据其自述账户后来约7000美元并逐步恢复盈利。',
            '前期多次爆仓并最终亏完，据其自述最高负债约47万元人民币。重建阶段，约100美元先做到170美元，后续账户据称达到约7000美元并慢慢恢复盈利。真正发生改变的不是交易载体，而是从“靠一把翻身”转向“先不死、让规则重复”。以上金额与结果均待独立核验。',
            '如果换成我，不把任何一次盈利当作扩大赌注的许可证。参与前先确定单次最大损失、每日次数、总仓位和停止条件，只做体系内机会；连续亏损时减频复盘，不加码翻本；连续盈利时也不突破仓位边界。借款不用于高杠杆交易，现金流与生存权优先。',
            '吸收他后期的账户重建能力：承认原来的方式失败，把目标从暴富改成存活；严格止损、限制交易次数、只做系统内机会；连续亏损仍不激活赌性，并先用小账户验证过程。',
            '避免把小样本盈利当成能力证明；避免亏损后加倍下注、借钱翻本和重仓梭哈；也避免从激进直接摆到畏首畏尾，用恐惧代替规则。',
            '适用于所有带杠杆、保证金或可快速放大仓位的交易，也可迁移到库存生意和普通投资中的重仓、负债决策。案例不能证明其交易策略本身有效，后期借钱扩大账户也不是可复制的正面动作；可复制的是损失边界和纪律，不是借款或仓位规模。',
            JSON.stringify([
              '先不死，保住本金',
              '单次损失必须事先限定并可承受',
              '只做交易系统内的机会',
              '亏损后禁止加码翻本',
              '连续盈利不得突破仓位边界'
            ]),
            JSON.stringify({
              capturedBy: 'migration-20260903_001',
              sourcePlatform: '抖音',
              sourceAccount: '扶摇聊交易',
              sourceEvidence: 'user_relay_of_public_self_report',
              capturedAt: '2026-09-03',
              verificationStatus: 'unconfirmed'
            }),
            '核心不是期货或外汇，而是账户从赌性驱动转向生存优先的过程。其“先不死，保住本金”和“从1到10、从10到100没有想象中差距那么大”只记录为本人总结，不作为收益承诺。'
          ]
        );
        behaviorCase = await dbGet<{ id: number }>(
          db,
          `SELECT id
           FROM behavior_cases
           WHERE title = ? AND is_deleted = 0
           ORDER BY id
           LIMIT 1`,
          [title]
        );
      }

      if (!behaviorCase) {
        throw new Error('Fuyao trading survival case could not be created');
      }

      const patternLinks = [
        { name: '过度下注', role: 'primary' },
        { name: '连续盈利后的自信膨胀', role: 'secondary' },
        { name: '恐惧与过度防守', role: 'secondary' }
      ];
      for (const link of patternLinks) {
        const pattern = await dbGet<{ id: number }>(
          db,
          `SELECT id
           FROM behavior_patterns
           WHERE name = ? AND is_deleted = 0 AND status = 'active'
           ORDER BY id
           LIMIT 1`,
          [link.name]
        );
        if (!pattern) {
          throw new Error(`Required behavior pattern is missing: ${link.name}`);
        }
        await dbRun(
          db,
          `INSERT OR IGNORE INTO behavior_case_pattern_links
            (case_id, pattern_id, role, note, created_at, updated_at)
           VALUES (?, ?, ?, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [behaviorCase.id, pattern.id, link.role]
        );
      }

      if (await migrationTableExists(db, 'audit_logs')) {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO audit_logs
            (id, timestamp, module, action, target, status, detail, entity_id,
             path, domain, workspace, created_at, updated_at)
           VALUES ('audit-human-case-fuyao-trading-survival-20260903', CURRENT_TIMESTAMP,
                   '人因案例库', 'create', ?, 'success', ?, ?, '/review/human-cases',
                   'business', 'business', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            title,
            JSON.stringify({
              originType: 'public',
              evidenceLevel: 'unconfirmed',
              actionQuality: 'mixed',
              outcomeType: 'mixed',
              primaryPattern: '过度下注'
            }),
            String(behaviorCase.id)
          ]
        );
      }
    }
  },
  {
    id: '20260903_002_seed_creator_audience_pressure_exit_case',
    name: 'Add creator audience pressure and failed exit discipline case',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'behavior_cases'))) return;
      if (!(await migrationTableExists(db, 'behavior_patterns'))) return;
      if (!(await migrationTableExists(db, 'behavior_case_pattern_links'))) return;

      await dbRun(
        db,
        `INSERT OR IGNORE INTO behavior_patterns
          (name, axis, category, summary, trigger_phrases_json, observable_actions_json,
           mechanism, risk_chain, counter_question, protective_action, positive_counterpart,
           maturity, status, sort_order, note, is_deleted, created_at, updated_at)
         VALUES ('外部评价绑架决策', 'human', 'human_bias', ?, ?, ?, ?, ?, ?, ?, ?,
                 'candidate', 'active', 170, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          '因为担心粉丝、群体、合作方或旁观者评价，放弃原本符合自身风险边界的决策。',
          JSON.stringify(['粉丝会骂', '已经公开看多', '现在走显得没格局', '别人会怎么看']),
          JSON.stringify(['该退出时拖延', '为维持人设继续持有', '让他人情绪替代自己的计划']),
          '公开表达、身份一致性和声誉压力会提高退出的心理成本，但围观者并不承担账户回撤、债务和机会成本。',
          '产生退出判断 → 担心外部评价 → 放弃或推迟执行 → 行情反转 → 浮盈大幅回撤 → 用结果继续强化心理压力',
          '这些评价我的人，会替我承担回撤、债务和错失下一次机会的成本吗？',
          '公开观点与个人仓位分开；交易只服从事前退出条件，触发后分批执行，不把人设一致性当作持有理由。',
          '独立决策、按计划分批退出',
          '这是影响动作的心理机制，不等于所有公开分享者都应忽略对受众的说明责任。'
        ]
      );

      const title = '小张小张吃饭用缸：粉丝评价绑架退出，盈利仍大幅回撤';
      let behaviorCase = await dbGet<{ id: number }>(
        db,
        `SELECT id
         FROM behavior_cases
         WHERE title = ? AND is_deleted = 0
         ORDER BY id
         LIMIT 1`,
        [title]
      );

      if (!behaviorCase) {
        await dbRun(
          db,
          `INSERT INTO behavior_cases
            (title, origin_type, subject_alias, source_note, evidence_level, case_date,
             track, project_name, background, visible_information, pressure_context,
             action_taken, result, action_quality, outcome_type, evidence_role,
             self_response, learn_to_keep, learn_to_avoid, applicability_boundary,
             linked_rule_refs_json, source_type, source_id, source_snapshot_json,
             pricing_analysis_json, note, is_deleted, created_at, updated_at)
           VALUES (?, 'public', ?, ?, 'unconfirmed', NULL,
                   '科技ETF（具体品种未确认）', '科技局部牛市高位未兑现', ?, ?, ?,
                   ?, ?, 'flawed', 'profit', 'negative',
                   ?, ?, ?, ?, ?, '', '', ?, '{}', ?, 0,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            title,
            '小张小张吃饭用缸',
            '自媒体博主公开经历，由用户转述，未保存原视频或原帖链接。具体ETF、交易流水、500万元本金、1900万元阶段高点和回撤幅度均未独立核验。',
            '据转述，其以约500万元本金提前布局科技类ETF，随后赶上科技局部牛市。传播口径为阶段最高约1900万元，但该数字究竟指账户总额还是累计盈利尚不明确。',
            '可以确认的叙事链是：提前入场后获得大幅浮盈；阶段高位本人已经产生退出想法；因为担心自己作为较大博主卖出后被粉丝指责，最终没有执行；7月科技板块大跌后账户出现明显回撤，但总体仍处于盈利。具体持仓、成交和净值曲线不可得。',
            '公开看多形成的人设一致性、对粉丝评价的担忧，以及“我先走会不会被骂”的责任压力，让本来属于账户风控的退出动作变成了舆论选择。',
            '1. 用较大本金提前布局科技类ETF，并在局部牛市中持续持有。\n2. 账户出现大幅浮盈后曾想退出，但没有按自己的风险判断分批兑现。\n3. 不退出的关键理由不是市场结构，而是担心自己先走后遭到粉丝指责。\n4. 7月科技板块大跌后，账户大幅回撤，但据转述最终仍保持总体盈利。',
            '虽然结果仍是盈利，但阶段浮盈发生了显著回撤。这个结果不能证明最高点能够提前判断，却说明一旦把退出权交给粉丝评价，正确的早期布局也可能失去主动兑现窗口。',
            '如果换成我，末端加速、赔率明显恶化或体系退出条件出现时就分批兑现。我只对自己的本金、现金流和风险边界负责；后面继续上涨就接受卖飞，粉丝是否指责也不能替代退出纪律。',
            '吸收他提前识别科技机会、敢于在行情启动前布局，并能持有到趋势明显扩张的能力。公开分享可以保持诚实，但观点、仓位和退出节奏必须允许动态变化。',
            '避免为了维持人设或取悦粉丝放弃退出；避免把“总体仍盈利”当成动作正确的证明；也避免用7月下跌事后倒推阶段最高点一定可精确卖出。',
            '适用于公开荐股、社群喊单、带货、合伙决策及任何“别人怎么看”开始影响仓位的场景。若涉及代客、跟单或法定受托责任，应另按相应义务处理。本案例只讨论自有账户的决策边界，金额和收益真实性不作为模式成立的前提。',
            JSON.stringify([
              '公开表达不能替代退出纪律',
              '末端加速分批兑现，接受卖飞',
              '别人不承担我的回撤，不能替我决定仓位'
            ]),
            JSON.stringify({
              capturedBy: 'migration-20260903_002',
              sourcePlatform: '自媒体平台（具体入口未保存）',
              sourceAccount: '小张小张吃饭用缸',
              sourceEvidence: 'user_relay_of_public_self_report',
              capturedAt: '2026-09-03',
              verificationStatus: 'unconfirmed'
            }),
            '核心不是科技ETF最终涨跌，而是本人已有退出判断时，是否仍能把自己的资金安全放在外部评价之前。500万元、1900万元和回撤幅度均保留为待核验口述数据。'
          ]
        );
        behaviorCase = await dbGet<{ id: number }>(
          db,
          `SELECT id
           FROM behavior_cases
           WHERE title = ? AND is_deleted = 0
           ORDER BY id
           LIMIT 1`,
          [title]
        );
      }

      if (!behaviorCase) {
        throw new Error('Creator audience pressure exit case could not be created');
      }

      const patternLinks = [
        { name: '没有退出机制', role: 'primary' },
        { name: '外部评价绑架决策', role: 'secondary' },
        { name: '暴涨后崩跌', role: 'secondary' }
      ];
      for (const link of patternLinks) {
        const pattern = await dbGet<{ id: number }>(
          db,
          `SELECT id
           FROM behavior_patterns
           WHERE name = ? AND is_deleted = 0 AND status = 'active'
           ORDER BY id
           LIMIT 1`,
          [link.name]
        );
        if (!pattern) {
          throw new Error(`Required behavior pattern is missing: ${link.name}`);
        }
        await dbRun(
          db,
          `INSERT OR IGNORE INTO behavior_case_pattern_links
            (case_id, pattern_id, role, note, created_at, updated_at)
           VALUES (?, ?, ?, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [behaviorCase.id, pattern.id, link.role]
        );
      }

      if (await migrationTableExists(db, 'audit_logs')) {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO audit_logs
            (id, timestamp, module, action, target, status, detail, entity_id,
             path, domain, workspace, created_at, updated_at)
           VALUES ('audit-human-case-creator-audience-pressure-20260903', CURRENT_TIMESTAMP,
                   '人因案例库', 'create', ?, 'success', ?, ?, '/review/human-cases',
                   'business', 'business', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            title,
            JSON.stringify({
              originType: 'public',
              evidenceLevel: 'unconfirmed',
              actionQuality: 'flawed',
              outcomeType: 'profit',
              primaryPattern: '没有退出机制',
              secondaryMechanism: '外部评价绑架决策'
            }),
            String(behaviorCase.id)
          ]
        );
      }
    }
  },
  {
    id: '20260903_003_seed_li_yien_long_term_narrative_boundary_case',
    name: 'Add Li Yien long-term thesis and late-entry risk boundary case',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'behavior_cases'))) return;
      if (!(await migrationTableExists(db, 'behavior_patterns'))) return;
      if (!(await migrationTableExists(db, 'behavior_case_pattern_links'))) return;

      await dbRun(
        db,
        `INSERT OR IGNORE INTO behavior_patterns
          (name, axis, category, summary, trigger_phrases_json, observable_actions_json,
           mechanism, risk_chain, counter_question, protective_action, positive_counterpart,
           maturity, status, sort_order, note, is_deleted, created_at, updated_at)
         VALUES ('长期叙事替代入场与风控', 'human', 'human_bias', ?, ?, ?, ?, ?, ?, ?, ?,
                 'candidate', 'active', 180, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          '把长期方向可能正确，误当成任何价格都能参与、任何仓位都能承受且所有人都该继续持有的理由。',
          JSON.stringify(['时间会证明', '拿着别动', '长期一定没问题', '跌了只是洗盘']),
          JSON.stringify(['高位补票后照搬低位持有逻辑', '不区分成本和仓位', '用产业逻辑覆盖回撤与退出边界']),
          '长期产业逻辑无法直接回答当前赔率；低位布局者与高位跟随者的成本、现金流、期限和最大回撤承受力完全不同。',
          '长期故事成立 → 价格上涨形成权威口号 → 后期追入 → 回撤时继续用长期逻辑解释 → 风险承受能力先于逻辑兑现耗尽',
          '如果我今天没有仓位，还会按当前价格、当前仓位重新买入，并能承受同样深度和时长的回撤吗？',
          '把方向、价格、仓位和期限分开判断；未经自身体系确认只进入观察层，长期看好不能取消入场和退出纪律。',
          '长期逻辑与当下赔率分开',
          '该模式不否定长期持有本身，只否定脱离成本、仓位和承受力后机械复制“拿着不动”。'
        ]
      );

      const title = '李一恩“拿着别动”：长期逻辑不能替代入场与风控';
      let behaviorCase = await dbGet<{ id: number }>(
        db,
        `SELECT id
         FROM behavior_cases
         WHERE title = ? AND is_deleted = 0
         ORDER BY id
         LIMIT 1`,
        [title]
      );

      if (!behaviorCase) {
        await dbRun(
          db,
          `INSERT INTO behavior_cases
            (title, origin_type, subject_alias, source_note, evidence_level, case_date,
             track, project_name, background, visible_information, pressure_context,
             action_taken, result, action_quality, outcome_type, evidence_role,
             self_response, learn_to_keep, learn_to_avoid, applicability_boundary,
             linked_rule_refs_json, source_type, source_id, source_snapshot_json,
             pricing_analysis_json, note, is_deleted, created_at, updated_at)
           VALUES (?, 'public', ?, ?, 'second_hand', '2026-07-01',
                   '科技ETF/光模块与算力', '长期逻辑与高位跟随风险', ?, ?, ?,
                   ?, ?, 'mixed', 'ongoing', 'boundary',
                   ?, ?, ?, ?, ?, '', '', ?, '{}', ?, 0,
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            title,
            '李一恩',
            '公开表述已有出处：2026-06-26、06-29抖音内容及2026-07-01直播转录均出现“拿着别动/时间会证明光模块和算力”；同一份07-01转录也明确提示位置已高、不要追。后期跟随者高位被套来自用户观察，未取得账户级证据。',
            '李一恩长期看好光模块与算力，并把“拿着别动，时间会证明光模块和算力”形成了高度传播的表达。该判断可能适合较早完成研究、低位布局且能承受波动的人，但不能自动转化为任何时点的参与许可。',
            '公开资料能核到两组同时存在的信息：一是反复强调光模块与算力的长期逻辑和持有；二是明确表示当时位置已经较高、上涨后不要追。2026-08-14相关回放摘要也区分了“有仓位持有”和“没仓位不急于追高”。用户观察到部分后期高位跟随者在7月科技回撤后被套，但具体人数、成本和亏损未独立核验。',
            '一句容易传播的长期口号，会压缩掉入场时间、成本、仓位、期限和回撤承受力。后期参与者既怕错过，也容易借用早期布局者的信念给自己的高位买入寻找安全感。',
            '1. 早期研究和布局者按长期产业逻辑持有光模块与算力方向。\n2. 公开传播中，“拿着别动，时间会证明”逐渐成为最醒目的记忆点。\n3. 部分后期参与者据用户观察在高位追入，并在回撤后继续套用长期持有口径。\n4. 完整公开内容其实也包含“位置已高、不要追”等边界，但这些限制条件不如口号容易传播。',
            '长期产业判断目前不能仅凭一次回撤判定对错，案例仍在观察。可以确认的是：同一句“拿着别动”，对低成本、轻仓、长期资金和高位、重仓、短期资金不是同一个动作；高位跟随者即使最终等到反转，也可能先被现金流、情绪和回撤承受力淘汰。',
            '如果是我，长期方向只决定是否进入研究和观察，不直接决定现在买不买。末端加速后不追；需要参与时按自身体系等待、分批并限定仓位。已经持有也按自己的成本、现金流和退出规则处理，不机械复制任何人的“拿着别动”。',
            '吸收其对光模块、算力产业趋势的长期研究视角，也保留低频持有、避免追涨杀跌的价值；尤其要保留其完整表述中“位置高、不要追”的限制条件。',
            '避免只记住一句传播性最强的口号；避免把别人的低位成本和长期资金条件移植到自己的高位买入；避免用“未来可能正确”掩盖当前盈亏比和仓位不合适。',
            '适用于科技成长、贵金属、主题基金及所有长期逻辑很强但短期波动巨大的资产。该案例不评价光模块与算力最终方向，也不把7月回撤当成长逻辑失效；公开内容存在明确的不追高提醒，因此不能把后期所有追高损失简单归责于博主。跟随者实际盈亏仍待验证。',
            JSON.stringify([
              '长期方向、入场价格、仓位和持有期限必须分开判断',
              '低位布局者的持有逻辑不能直接移植给高位追入者',
              '外部观点只进观察层，最终动作服从自己的体系'
            ]),
            JSON.stringify({
              capturedBy: 'migration-20260903_003',
              sourcePlatform: '抖音/B站公开转录',
              sourceAccount: '李一恩',
              capturedAt: '2026-09-03',
              verificationStatus: 'partially_documented',
              documentedClaims: [
                '反复表达拿着别动、时间会证明光模块和算力',
                '同时明确提醒位置已高、不要追'
              ],
              unverifiedClaims: [
                '后期高位跟随者的具体成本、数量和账户亏损'
              ],
              references: [
                'https://www.douyin.com/video/7655558755681483173',
                'https://www.douyin.com/video/7656676101032694651',
                'https://www.bilibili.com/opus/1219986882081849350',
                'https://www.bilibili.com/video/BV1F4gK6LELK/'
              ]
            }),
            '这是一条“同一长期判断在不同成本和承受力下含义不同”的边界案例。保留完整上下文，不把口号单独截出来定罪，也不因长期逻辑可能成立就给高位追入开绿灯。'
          ]
        );
        behaviorCase = await dbGet<{ id: number }>(
          db,
          `SELECT id
           FROM behavior_cases
           WHERE title = ? AND is_deleted = 0
           ORDER BY id
           LIMIT 1`,
          [title]
        );
      }

      if (!behaviorCase) {
        throw new Error('Li Yien long-term narrative boundary case could not be created');
      }

      const patternLinks = [
        { name: '追高', role: 'primary' },
        { name: 'FOMO（错失焦虑）', role: 'secondary' },
        { name: '长期叙事替代入场与风控', role: 'secondary' }
      ];
      for (const link of patternLinks) {
        const pattern = await dbGet<{ id: number }>(
          db,
          `SELECT id
           FROM behavior_patterns
           WHERE name = ? AND is_deleted = 0 AND status = 'active'
           ORDER BY id
           LIMIT 1`,
          [link.name]
        );
        if (!pattern) {
          throw new Error(`Required behavior pattern is missing: ${link.name}`);
        }
        await dbRun(
          db,
          `INSERT OR IGNORE INTO behavior_case_pattern_links
            (case_id, pattern_id, role, note, created_at, updated_at)
           VALUES (?, ?, ?, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [behaviorCase.id, pattern.id, link.role]
        );
      }

      if (await migrationTableExists(db, 'audit_logs')) {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO audit_logs
            (id, timestamp, module, action, target, status, detail, entity_id,
             path, domain, workspace, created_at, updated_at)
           VALUES ('audit-human-case-li-yien-long-term-boundary-20260903', CURRENT_TIMESTAMP,
                   '人因案例库', 'create', ?, 'success', ?, ?, '/review/human-cases',
                   'business', 'business', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            title,
            JSON.stringify({
              originType: 'public',
              evidenceLevel: 'second_hand',
              actionQuality: 'mixed',
              outcomeType: 'ongoing',
              primaryPattern: '追高',
              boundary: '公开内容同时包含长期持有与不要追高'
            }),
            String(behaviorCase.id)
          ]
        );
      }
    }
  },
  {
    id: '20260904_001_seed_ps5_price_repricing_v01_market_case',
    name: 'Freeze PS5 price repricing ongoing market case V0.1',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'market_reviews'))) return;

      const title = '2026 PS5 系列价格重估 / PS5 Pro异常加速（进行中 V0.1）';
      let marketReview = await dbGet<{ id: number }>(
        db,
        `SELECT id
         FROM market_reviews
         WHERE title = ? AND is_deleted = 0
         ORDER BY id
         LIMIT 1`,
        [title]
      );

      if (!marketReview) {
        await dbRun(
          db,
          `INSERT INTO market_reviews
            (title, track, project_name, review_date, market_type_preset,
             market_type_custom, summary_conclusion, short_lesson, background,
             market_start, market_evolution, key_turning_points, later_outcome,
             exposed_problem, extracted_lesson, note, is_deleted, created_at, updated_at)
           VALUES (?, '游戏机', 'PS5系列 / PS5 Pro', '2026-09-04', '自定义', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            title,
            '趋势强 / 基本面存在支撑 / 疑似末端加速',
            '截至2026-09-04，PS5系列处于价格中枢明显抬升阶段，PS5 Pro斜率尤其陡。当前只定义为“趋势强、基本面存在支撑、疑似末端加速”；不预测顶部，也没有参与计划。',
            '价格高并不证明马上下跌，但当前风险收益结构已经不适合追货。',
            '一、现象\n\n2026年3月至9月，国内PS5系列二手档口回收价整体明显上涨。PS5 Slim多数版本较3月低位上涨约20%～40%；本地档口记录中，PS5 Pro日版数字版由约4800元升至9000元，港版数字版由约5300元升至9300元，出现明显斜率加速。\n\n同期Switch OLED国内价格总体横盘偏弱，NS2港版单机原盒约在3230～3365元窄幅波动，明显弱于PS5，说明不能简单用“整个游戏硬件行业共同涨价”解释。',
            '二、当前推测的传导链\n\nAI/数据中心推动存储需求及资源重新配置\n→ 消费级存储及相关BOM成本压力\n→ Sony自身成本压力\n→ 官方全球调价\n→ PS5整体价格中枢抬升\n→ 部分型号供应与需求错配\n→ 官方价格与二级市场价格倒挂\n→ 消费者、渠道、套利资金共同抢货\n→ 补货快速售罄\n→ 流通库存进一步下降\n→ 二级市场继续抬价。\n\nPS5 Pro在上述共同因素之外，可能额外叠加高性能版本需求、GTA 6预期、严重缺货、惜售及套利正反馈，因此涨幅显著超过普通PS5。以上均为截至冻结日的待验证推测，不作为已确认因果。',
            '三、控制组\n\nSwitch OLED国内半年总体横盘偏弱；NS2港版单机原盒约在3230～3365元窄幅波动。日本Switch 2回收价格虽可能有温和上涨，但明显弱于日本PS5 Slim和PS5 Pro。\n\n因此目前暂不支持“单纯存储涨价导致所有游戏机普涨”的解释，PlayStation自身的定价、供应和需求因素权重更高。\n\n四、当前风险状态\n\nPS5 Pro国内档口价格已出现明显斜率加速，当前定义为：\n\n趋势强 / 基本面存在支撑 / 疑似末端加速 / 不预测顶部 / 无参与计划。\n\n价格高并不证明马上下跌，但当前风险收益结构已经不适合追货。',
            '五、待验证假设\n\n当前尚未确认供应拐点，后续只按新出现的日期和证据追加：\n\n1. Sony持续补货后，官方渠道能否从“秒空”变成持续库存；\n2. 日本買取价格是否率先停止创新高；\n3. 国内档口是否随后停止提价、开始降价或限收；\n4. Pro回落是否领先或滞后于Slim；\n5. 官方价与二级市场价差缩窄后，套利需求是否快速退出；\n6. 如果供应恢复，价格最终回到什么新中枢；\n7. 本轮存储成本、官方调价、真实消费需求和套利资金各自贡献到底有多大。',
            '六、当前不能下的结论\n\n本案例仍在进行中，V0.1不写结局：\n\n1. 不确认9000元附近为顶部；\n2. 不确认后续一定暴跌；\n3. 不确认存储涨价是唯一主因；\n4. 不确认GTA 6是主要原因；\n5. 不把官方偶发补货等同于供应恢复。',
            '当前无法拆清存储成本、Sony官方调价、真实消费需求、GTA 6预期、渠道惜售和套利资金各自贡献。所有传导关系都停留在待验证层，不用结果倒推原因，也不拿单次补货或单日价格变化宣布拐点。',
            '七、案例价值\n\n用于研究标准化工业品在“成本变化—厂商调价—供需错配—官方/市场价格倒挂—套利资金进入—价格加速—厂商补产—套利退出—价格修复”过程中的完整价格行为。\n\nV0.1保存的是2026-09-04当时真实可见的信息集和推理过程，用于以后检验判断是否具有前瞻性，而不是拿未来答案解释过去。该结构以后可复用于硬盘、手机、茅台、纪念币及大宗商品案例。',
            '版本：V0.1\n状态：进行中\n认知冻结日：2026-09-04\n价格数据截止日：2026-09-03\n数据口径：本地游戏机档口回收价；原因链条属于人工推测，尚未完成因果验证。\n\n更新纪律：\n1. 供应拐点或其他关键变化出现后，只新增“2026-XX-XX：第一次关键状态变化”等带日期记录，形成V0.2，不改写V0.1原判断；\n2. 行情彻底结束后再形成V1.0复盘，分别回答“哪些判断对了、哪些判断错了、什么指标最有领先价值”；\n3. 在结局出现前，不补写顶部、暴跌或最终中枢。'
          ]
        );
        marketReview = await dbGet<{ id: number }>(
          db,
          `SELECT id
           FROM market_reviews
           WHERE title = ? AND is_deleted = 0
           ORDER BY id
           LIMIT 1`,
          [title]
        );
      }

      if (!marketReview) {
        throw new Error('PS5 price repricing ongoing market case V0.1 could not be created');
      }

      if (await migrationTableExists(db, 'audit_logs')) {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO audit_logs
            (id, timestamp, module, action, target, status, detail, entity_id,
             path, domain, workspace, created_at, updated_at)
           VALUES ('audit-market-review-ps5-repricing-v01-20260904', CURRENT_TIMESTAMP,
                   '行情复盘', 'create', ?, 'success', ?, ?, '/review/market',
                   'business', 'business', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            title,
            JSON.stringify({
              version: 'V0.1',
              status: 'ongoing',
              cognitionFrozenAt: '2026-09-04',
              priceDataThrough: '2026-09-03',
              conclusionPolicy: 'freeze-current-information-without-writing-outcome'
            }),
            String(marketReview.id)
          ]
        );
      }
    }
  },
  {
    id: '20260906_001_refine_gazijie_supply_floor_archive',
    name: 'Refine Gazijie supply pressure floors and anniversary release archive',
    run: async (db: any) => {
      if (!(await migrationTableExists(db, 'product_archives'))) return;

      const archive = await dbGet<any>(
        db,
        `SELECT id, issue_info, risk_basis, experience_note, pending_questions
         FROM product_archives
         WHERE category_name = '泡泡玛特'
           AND object_name = '嘎子姐'
           AND COALESCE(is_deleted, 0) = 0
         ORDER BY id
         LIMIT 1`
      );
      if (!archive) return;

      const appendOnce = (current: unknown, marker: string, addition: string) => {
        const text = String(current || '').trim();
        if (text.includes(marker)) return text;
        return [text, addition].filter(Boolean).join('\n\n');
      };

      const legacyExperience = '之前也有过门店轮动补货，但不是通货补，当时把价格砸到450以下了。，然后就不咋补货了，零零散散的有补货，后来长时间横盘以后就涨上去了';
      const cleanedExperience = String(archive.experience_note || '')
        .replace(legacyExperience, '')
        .trim();
      const experienceNote = appendOnce(
        cleanedExperience,
        '历史供给压力锚（日期待核）',
        '历史供给压力锚（日期待核）：官方曾连续多日进行阶段性大规模补货，市场价格一度跌到400元出头；具体日期和精确价格没有留存，因此不补造价格记录。这种阶段性大补不等于线上线下持续数月、随处可买的“通货补”。该轮结束后，官方未再出现同等级的大规模补货，只陆续进行过小规模补货；此后价格没有再跌破500元，并随着供给收缩和真实需求一路抬升。'
      );

      await dbRun(
        db,
        `UPDATE product_archives
         SET issue_info = ?,
             risk_basis = ?,
             experience_note = ?,
             pending_questions = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          appendOnce(
            archive.issue_info,
            '阶段性大规模补货和通货补必须分开判断',
            '供给口径补充：阶段性大规模补货和通货补必须分开判断。连续多日集中放量可以短期打开极端压力位，但只有线上线下随处可买并持续至少一个月甚至数月，才属于会改变长期结构的通货补。'
          ),
          appendOnce(
            archive.risk_basis,
            '供给形态决定价格底部的层级',
            '供给形态决定价格底部的层级：400元出头仅是历史上连续多日大规模补货形成的极端压力锚；官方未持续大补后的价格记录显示，500元附近更接近正常供给环境下的观察底部。若未来重新出现同等级连续大补，400元出头的尾部风险会重新打开。'
          ),
          experienceNote,
          appendOnce(
            archive.pending_questions,
            '周年庆线上货的实际规模',
            '当前待确认：周年庆线上货的实际规模、集中卖盘何时消化、后续是否还有新一轮补货、群内约510元收货价能否持续，以及真爱粉和其他买家的真实承接是否足够稳定。'
          ),
          archive.id
        ]
      );

      if (await migrationTableExists(db, 'product_archive_stages')) {
        const stages = [
          {
            name: '连续大规模补货压力底',
            time: '具体日期待核（早于现有完整价格序列）',
            type: '阶段性大规模补货 / 极端供给压力',
            priceStart: null,
            priceHigh: null,
            priceLow: null,
            priceEnd: null,
            summary: '官方曾连续多日进行大规模补货，市场价一度跌到400元出头。具体日期和精确价格未留存；该轮结束后未再出现同等级大补，后续仅有小规模补货，价格此后未再跌破500元并逐步抬升。',
            actionRule: '400元出头只作为极端供给压力锚，不作为日常抄底线。先判断是阶段性集中放量还是持续数月的通货补；若是后者，原有稀缺结构失效，停止参与。',
            evidence: '证据来自用户亲历和市场观察，日期及精确低价待核。系统自2026-03-30起的147条记录最低为508元，可支持“此后未再跌破500元附近”的后半段，但不能反证更早的400元出头低位。',
            sortOrder: 1,
            note: '不向价格历史补写虚构日期或精确价格。'
          },
          {
            name: '2026周年庆线上放货消化',
            time: '2026-08-24至2026-09-05（进行中）',
            type: '线上放货 / 集中到货 / 真实承接观察',
            priceStart: 689,
            priceHigh: 689,
            priceLow: 511,
            priceEnd: 511,
            summary: '周年庆采用线上直接放货，不产生门店自提码。系统记录从8月24日689元回落至9月5日511元，用户观察群内收货价也约为510元，说明当前价格中枢具有市场印证。推测周年庆货源近期集中流入千岛，本轮放量看起来不小，但真爱粉购买形成了真实承接；暂未看到继续补货迹象，后续供给仍未知。',
            actionRule: '当前只定义为正常供给底附近的消化观察，不把511元当作绝对历史底。观察群收价是否撤低、千岛是否继续创新低、集中卖盘是否衰减；若供给停止后承接稳定，再重新评估，若转为连续大补则继续等待。',
            evidence: '价格证据：本地千岛记录2026-08-24为689元、2026-08-28备注周年庆补货并报582元、2026-09-05报511元；市场证据：用户观察群内收货约510元。补货规模和后续安排尚无精确数据。',
            sortOrder: 2,
            note: '线上放货与门店轮动补货分开解释，本阶段不使用自提码作为信号。'
          }
        ];

        for (const stage of stages) {
          const existingStage = await dbGet<{ id: number }>(
            db,
            `SELECT id
             FROM product_archive_stages
             WHERE archive_id = ?
               AND stage_name = ?
               AND COALESCE(is_deleted, 0) = 0
             LIMIT 1`,
            [archive.id, stage.name]
          );
          if (existingStage) continue;
          await dbRun(
            db,
            `INSERT INTO product_archive_stages
              (archive_id, stage_name, time_text, stage_type, price_start, price_high,
               price_low, price_end, stage_summary, action_rule, evidence_note,
               confidence, sort_order, note, is_deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rough', ?, ?, 0,
                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              archive.id,
              stage.name,
              stage.time,
              stage.type,
              stage.priceStart,
              stage.priceHigh,
              stage.priceLow,
              stage.priceEnd,
              stage.summary,
              stage.actionRule,
              stage.evidence,
              stage.sortOrder,
              stage.note
            ]
          );
        }
      }

      if (await migrationTableExists(db, 'audit_logs')) {
        await dbRun(
          db,
          `INSERT OR IGNORE INTO audit_logs
            (id, timestamp, module, action, target, status, detail, entity_id,
             path, domain, workspace, created_at, updated_at)
           VALUES ('audit-product-archive-gazijie-supply-floor-20260906', CURRENT_TIMESTAMP,
                   '品种档案', 'update', '嘎子姐', 'success', ?, ?,
                   '/risk-control/product-archives', 'business', 'business',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            JSON.stringify({
              change: 'refine-supply-pressure-floors-and-anniversary-online-release',
              historicalStressFloor: '400元出头，日期与精确价格待核',
              postReleaseObservedFloor: '500元附近',
              currentObservationDate: '2026-09-05',
              currentQiandaoPrice: 511,
              currentGroupBidApprox: 510
            }),
            String(archive.id)
          ]
        );
      }
    }
  }
];

function dbRun(db: any, sql: string, params: any[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error: any) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function dbGet<T = any>(db: any, sql: string, params: any[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error: any, row: T) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row);
    });
  });
}

function dbAll<T = any>(db: any, sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error: any, rows: T[]) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows || []);
    });
  });
}

function dbExec(db: any, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error: any) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function dbClose(db: any): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error: any) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const quoteMigrationIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

async function migrationTableExists(db: any, tableName: string): Promise<boolean> {
  const table = await dbGet<any>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName]
  );
  return Boolean(table);
}

async function ensureMigrationColumn(db: any, tableName: string, column: string, definition: string): Promise<void> {
  if (!(await migrationTableExists(db, tableName))) return;
  const columns = await dbAll<any>(db, `PRAGMA table_info(${quoteMigrationIdentifier(tableName)})`);
  const exists = columns.some((item: any) => String(item.name) === column);
  if (!exists) {
    await dbExec(db, `ALTER TABLE ${quoteMigrationIdentifier(tableName)} ADD COLUMN ${quoteMigrationIdentifier(column)} ${definition}`);
  }
}

export const getMigrationManifest = () => migrations.map(({ id, name }) => ({ id, name }));

export const getExpectedMigrationIds = () => migrations.map(migration => migration.id);

// 执行迁移
export async function runMigrations(dbPath: string): Promise<void> {
  const sqlite3 = require('sqlite3').verbose();
  const db = await new Promise<any>((resolve, reject) => {
    let instance: any;
    instance = new sqlite3.Database(dbPath, (error: any) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(instance);
    });
  });

  try {
    await dbRun(
      db,
      `CREATE TABLE IF NOT EXISTS migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    );

    for (const migration of migrations) {
      const row = await dbGet(db, 'SELECT id FROM migrations WHERE id = ?', [migration.id]);
      if (row) {
        continue;
      }

      let transactionStarted = false;
      try {
        await dbExec(db, 'BEGIN IMMEDIATE TRANSACTION');
        transactionStarted = true;

        if (migration.run) {
          await migration.run(db);
        } else if (migration.sql) {
          await dbExec(db, migration.sql);
        }

        await dbRun(db, 'INSERT INTO migrations (id, name) VALUES (?, ?)', [migration.id, migration.name]);
        await dbExec(db, 'COMMIT');
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) {
          await dbExec(db, 'ROLLBACK').catch(() => undefined);
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${migration.id} (${migration.name}) failed: ${detail}`);
      }
    }
  } finally {
    await dbClose(db);
  }
}
