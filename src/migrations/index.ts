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

      if (migration.run) {
        await migration.run(db);
      } else if (migration.sql) {
        await dbExec(db, migration.sql);
      }

      await dbRun(db, 'INSERT INTO migrations (id, name) VALUES (?, ?)', [migration.id, migration.name]);
    }
  } finally {
    await dbClose(db);
  }
}
