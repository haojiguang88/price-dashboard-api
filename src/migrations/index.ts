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
        my_interpretation TEXT,
        validation_result TEXT,
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
    name: 'Keep commodity metals task in business task center',
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
          source_raw TEXT,
          note TEXT,
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
