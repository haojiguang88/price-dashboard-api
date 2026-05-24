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
      
      -- 交易复盘表
      CREATE TABLE IF NOT EXISTS trade_reviews (
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
    sql: `
      -- 为年度计划子项表添加新字段
      ALTER TABLE annual_plan_items ADD COLUMN downgrade_reason TEXT;
      ALTER TABLE annual_plan_items ADD COLUMN resume_condition TEXT;
      
      -- 创建年度计划子项变更表
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
    `
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
    sql: `
      -- 为 sell_records 表添加 ended_position_id 字段
      ALTER TABLE sell_records ADD COLUMN ended_position_id INTEGER;
    `
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
    sql: `
      -- 为 positions 表添加 source_id 字段
      ALTER TABLE positions ADD COLUMN source_id TEXT;
    `
  },
  {
    id: '20260501_001',
    name: 'Add new fields for crash grading v1',
    sql: `
      -- 添加股灾分级v1所需字段
      ALTER TABLE financial_market_regime ADD COLUMN entry_permission TEXT;
      ALTER TABLE financial_market_regime ADD COLUMN entry_reason TEXT;
      ALTER TABLE financial_market_regime ADD COLUMN low_120 REAL;
      ALTER TABLE financial_market_regime ADD COLUMN drawdown_20 REAL;
      ALTER TABLE financial_market_regime ADD COLUMN drawdown_60 REAL;
      ALTER TABLE financial_market_regime ADD COLUMN drawdown_120 REAL;
      ALTER TABLE financial_market_regime ADD COLUMN distance_to_ma60 REAL;
      ALTER TABLE financial_market_regime ADD COLUMN below_ma60_days INTEGER;
      ALTER TABLE financial_market_regime ADD COLUMN rule_version TEXT DEFAULT 'market_regime_v1';
    `
  },
  {
    id: '20260501_002',
    name: 'Create trend phase results table',
    sql: `
      -- 趋势阶段结果表
      CREATE TABLE IF NOT EXISTS financial_trend_phase_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        source TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        close REAL,
        ma20 REAL,
        ma60 REAL,
        bias60 REAL,
        ret5 REAL,
        ret20 REAL,
        range20 REAL,
        cross60_10 INTEGER,
        trend_phase_code TEXT NOT NULL,
        trend_phase_reason TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, asset_type, source, trade_date, rule_version)
      );
      
      CREATE INDEX IF NOT EXISTS idx_trend_phase_symbol_date
      ON financial_trend_phase_results(symbol, trade_date);
    `
  },
  {
    id: '20260501_003',
    name: 'Add reason_code and reason_details fields to trend phase results',
    sql: `
      -- 添加 reason_code 字段
      ALTER TABLE financial_trend_phase_results 
      ADD COLUMN reason_code TEXT;
      
      -- 添加 reason_details 字段
      ALTER TABLE financial_trend_phase_results 
      ADD COLUMN reason_details TEXT;
    `
  },
  {
    id: '20260501_004',
    name: 'Create financial candidate pool table',
    sql: `
      -- 金融自动备选池
      CREATE TABLE IF NOT EXISTS financial_candidate_pool (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        name TEXT,
        asset_type TEXT NOT NULL,
        source TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        close REAL,
        ma20 REAL,
        ma60 REAL,
        ma120 REAL,
        distance_to_ma60 REAL,
        above_ma60_days INTEGER,
        structure_status TEXT NOT NULL,
        structure_reason TEXT,
        safe_zone_status TEXT NOT NULL,
        safe_zone_reason TEXT,
        trend_phase_code TEXT,
        trend_phase_reason TEXT,
        market_regime TEXT,
        entry_permission TEXT,
        plan_profile TEXT,
        plan_profile_label TEXT,
        final_status TEXT NOT NULL,
        pool_status TEXT NOT NULL DEFAULT 'active',
        priority TEXT NOT NULL DEFAULT 'medium',
        invalidation_line REAL,
        candidate_reason TEXT,
        risk_note TEXT,
        rule_version TEXT NOT NULL DEFAULT 'candidate_pool_v1',
        first_selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, asset_type, source, rule_version)
      );

      CREATE INDEX IF NOT EXISTS idx_financial_candidate_pool_status
      ON financial_candidate_pool(pool_status, last_checked_at);

      CREATE INDEX IF NOT EXISTS idx_financial_candidate_pool_symbol
      ON financial_candidate_pool(symbol, asset_type, source);
    `
  },
  {
    id: '20260501_005',
    name: 'Create financial asset universe table',
    sql: `
      -- 金融资产库/白名单：记录哪些标的需要拉取，哪些已经有本地数据
      CREATE TABLE IF NOT EXISTS financial_asset_universe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        name TEXT,
        asset_type TEXT NOT NULL,
        universe_type TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'tushare',
        enabled INTEGER NOT NULL DEFAULT 1,
        update_status TEXT NOT NULL DEFAULT 'pending',
        total_count INTEGER NOT NULL DEFAULT 0,
        first_trade_date TEXT,
        last_trade_date TEXT,
        last_updated TEXT,
        last_fetch_at TEXT,
        last_fetch_message TEXT,
        local_data_ready INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, asset_type, universe_type, source)
      );

      CREATE INDEX IF NOT EXISTS idx_financial_asset_universe_type
      ON financial_asset_universe(universe_type, asset_type, enabled);

      CREATE INDEX IF NOT EXISTS idx_financial_asset_universe_status
      ON financial_asset_universe(update_status, last_fetch_at);

      INSERT OR IGNORE INTO financial_asset_universe (symbol, name, asset_type, universe_type, source)
      VALUES
        ('000300', '沪深300', 'index', 'broad_index', 'tushare'),
        ('510300', '沪深300ETF', 'etf', 'broad_etf', 'tushare'),
        ('510500', '中证500ETF', 'etf', 'broad_etf', 'tushare'),
        ('159915', '创业板ETF', 'etf', 'broad_etf', 'tushare'),
        ('588000', '科创50ETF', 'etf', 'broad_etf', 'tushare'),
        ('512880', '证券ETF', 'etf', 'industry_etf', 'tushare'),
        ('512480', '半导体ETF', 'etf', 'industry_etf', 'tushare'),
        ('512170', '医疗ETF', 'etf', 'industry_etf', 'tushare'),
        ('515790', '光伏ETF', 'etf', 'industry_etf', 'tushare'),
        ('515030', '新能源车ETF', 'etf', 'industry_etf', 'tushare'),
        ('600519', '贵州茅台', 'stock', 'stock_whitelist', 'tushare'),
        ('300750', '宁德时代', 'stock', 'stock_whitelist', 'tushare'),
        ('601318', '中国平安', 'stock', 'stock_whitelist', 'tushare'),
        ('600036', '招商银行', 'stock', 'stock_whitelist', 'tushare');
    `
  },
  {
    id: '20260501_006',
    name: 'Seed small batch stock universe',
    sql: `
      -- 第二步小批量：先放入一组沪深300代表性成分，不直接全市场请求
      INSERT OR IGNORE INTO financial_asset_universe (symbol, name, asset_type, universe_type, source)
      VALUES
        ('600519', '贵州茅台', 'stock', 'hs300_component', 'tushare'),
        ('300750', '宁德时代', 'stock', 'hs300_component', 'tushare'),
        ('601318', '中国平安', 'stock', 'hs300_component', 'tushare'),
        ('600036', '招商银行', 'stock', 'hs300_component', 'tushare'),
        ('000858', '五粮液', 'stock', 'hs300_component', 'tushare'),
        ('000333', '美的集团', 'stock', 'hs300_component', 'tushare'),
        ('002594', '比亚迪', 'stock', 'hs300_component', 'tushare'),
        ('601899', '紫金矿业', 'stock', 'hs300_component', 'tushare'),
        ('600030', '中信证券', 'stock', 'hs300_component', 'tushare'),
        ('601166', '兴业银行', 'stock', 'hs300_component', 'tushare'),
        ('000651', '格力电器', 'stock', 'hs300_component', 'tushare'),
        ('300760', '迈瑞医疗', 'stock', 'hs300_component', 'tushare'),
        ('601398', '工商银行', 'stock', 'hs300_component', 'tushare'),
        ('600900', '长江电力', 'stock', 'hs300_component', 'tushare'),
        ('600276', '恒瑞医药', 'stock', 'hs300_component', 'tushare'),
        ('601288', '农业银行', 'stock', 'hs300_component', 'tushare'),
        ('601857', '中国石油', 'stock', 'hs300_component', 'tushare'),
        ('002475', '立讯精密', 'stock', 'hs300_component', 'tushare'),
        ('600309', '万华化学', 'stock', 'hs300_component', 'tushare'),
        ('300059', '东方财富', 'stock', 'hs300_component', 'tushare');
    `
  },
  {
    id: '20260501_007',
    name: 'Create task center tables',
    sql: `
      -- 任务中心：统一管理行情、备选池、贵金属、彩票等定时任务
      CREATE TABLE IF NOT EXISTS task_center_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        task_type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        schedule_time TEXT NOT NULL DEFAULT '16:00',
        schedule_days TEXT NOT NULL DEFAULT 'trade_days',
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

      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'metals_daily_update',
          '贵金属每日行情更新',
          'metals',
          'metals_daily_update',
          0,
          '16:10',
          'every_day',
          30,
          '{"symbols":["XAUUSD","SGE_AGTD"]}',
          'pending',
          '收盘后更新黄金与白银贵金属日线并刷新贵金属状态'
        ),
        (
          'lottery_daily_update',
          '彩票数据更新',
          'lottery',
          'placeholder',
          0,
          '21:30',
          'every_day',
          40,
          '{}',
          'pending',
          '预留任务：后续接入彩票开奖数据源'
        );
    `
  },
  {
    id: '20260501_008',
    name: 'Add candidate pool priority score and block reasons',
    sql: `
      ALTER TABLE financial_candidate_pool
      ADD COLUMN priority_score INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE financial_candidate_pool
      ADD COLUMN forbidden_reason TEXT;

      ALTER TABLE financial_candidate_pool
      ADD COLUMN downgrade_reason TEXT;

      UPDATE financial_candidate_pool
      SET priority_score = CASE priority
        WHEN 'high' THEN 80
        WHEN 'medium' THEN 65
        WHEN 'low' THEN 45
        ELSE 50
      END
      WHERE priority_score = 0;
    `
  },
  {
    id: '20260501_009',
    name: 'Create financial trade plans table',
    sql: `
      CREATE TABLE IF NOT EXISTS financial_trade_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT,
        asset_type TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'tushare',
        trade_date TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        total_capital REAL NOT NULL DEFAULT 0,
        base_amount REAL NOT NULL DEFAULT 0,
        tactical_amount REAL NOT NULL DEFAULT 0,
        observation_amount REAL NOT NULL DEFAULT 0,
        base_ratio INTEGER NOT NULL DEFAULT 0,
        tactical_ratio INTEGER NOT NULL DEFAULT 0,
        observation_ratio INTEGER NOT NULL DEFAULT 0,
        principle_snapshot TEXT,
        entry_action TEXT,
        trigger_score INTEGER NOT NULL DEFAULT 0,
        trigger_type TEXT,
        trigger_reason TEXT,
        structure_score INTEGER,
        structure_score_bucket TEXT,
        structure_level TEXT,
        structure_status TEXT,
        safe_zone_status TEXT,
        trend_phase_code TEXT,
        trend_action TEXT,
        market_regime TEXT,
        entry_permission TEXT,
        close_price REAL,
        ma20 REAL,
        ma60 REAL,
        invalidation_line REAL,
        max_loss_percent REAL,
        suggested_entry_zone TEXT,
        entry_reason TEXT,
        trigger_snapshot_json TEXT,
        is_bought INTEGER NOT NULL DEFAULT 0,
        buy_date TEXT,
        buy_price REAL,
        buy_amount REAL,
        perf_5d REAL,
        perf_10d REAL,
        perf_20d REAL,
        perf_60d REAL,
        stopped_out INTEGER NOT NULL DEFAULT 0,
        entered_main_rise INTEGER NOT NULL DEFAULT 0,
        false_breakout INTEGER NOT NULL DEFAULT 0,
        chased_high INTEGER NOT NULL DEFAULT 0,
        feedback_note TEXT,
        note TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_financial_trade_plans_symbol
      ON financial_trade_plans(symbol, asset_type, source);

      CREATE INDEX IF NOT EXISTS idx_financial_trade_plans_stats
      ON financial_trade_plans(structure_score_bucket, trend_phase_code, trigger_type);
    `
  },
  {
    id: '20260501_010',
    name: 'Create financial execution and action suggestion tables',
    sql: `
      CREATE TABLE IF NOT EXISTS financial_trade_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        action_type TEXT NOT NULL,
        sleeve_type TEXT NOT NULL,
        execution_date TEXT NOT NULL,
        execution_price REAL NOT NULL,
        execution_amount REAL NOT NULL,
        execution_quantity REAL,
        trigger_phase TEXT,
        trigger_rule TEXT,
        position_decision TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_id) REFERENCES financial_trade_plans(id)
      );

      CREATE INDEX IF NOT EXISTS idx_financial_trade_executions_plan
      ON financial_trade_executions(plan_id, execution_date);

      CREATE TABLE IF NOT EXISTS financial_action_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        trade_date TEXT,
        suggestion_date TEXT NOT NULL,
        action_code TEXT NOT NULL,
        action_label TEXT NOT NULL,
        action_reason TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        structure_score INTEGER,
        trend_phase_code TEXT,
        trigger_score INTEGER,
        entry_action TEXT,
        close_price REAL,
        invalidation_line REAL,
        base_position_amount REAL NOT NULL DEFAULT 0,
        tactical_position_amount REAL NOT NULL DEFAULT 0,
        observation_position_amount REAL NOT NULL DEFAULT 0,
        suggestion_snapshot_json TEXT,
        is_confirmed INTEGER NOT NULL DEFAULT 0,
        confirm_note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_id) REFERENCES financial_trade_plans(id)
      );

      CREATE INDEX IF NOT EXISTS idx_financial_action_suggestions_plan
      ON financial_action_suggestions(plan_id, suggestion_date);
    `
  },
  {
    id: '20260503_001',
    name: 'Create financial candidate review drafts',
    sql: `
      CREATE TABLE IF NOT EXISTS financial_candidate_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT,
        asset_type TEXT NOT NULL,
        source TEXT NOT NULL,
        trade_date TEXT,
        rule_version TEXT NOT NULL,
        model_key TEXT,
        model_target TEXT,
        model_probability REAL,
        lane_key TEXT,
        lane_label TEXT,
        suggested_action_key TEXT,
        suggested_action_label TEXT,
        review_status TEXT NOT NULL DEFAULT 'draft',
        draft_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_financial_candidate_reviews_candidate
      ON financial_candidate_reviews(candidate_id, created_at);
    `
  },
  {
    id: '20260503_002',
    name: 'Create financial entry trigger observations',
    sql: `
      CREATE TABLE IF NOT EXISTS financial_entry_trigger_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        name TEXT,
        asset_type TEXT NOT NULL,
        source TEXT NOT NULL,
        trade_date TEXT,
        observation_status TEXT NOT NULL DEFAULT 'watching',
        entry_action TEXT,
        action_label TEXT,
        trigger_score INTEGER,
        trigger_reason TEXT,
        structure_score INTEGER,
        trend_phase_code TEXT,
        market_regime TEXT,
        entry_permission TEXT,
        close_price REAL,
        ma20 REAL,
        ma60 REAL,
        invalidation_line REAL,
        snapshot_json TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_financial_entry_trigger_observations_symbol
      ON financial_entry_trigger_observations(symbol, asset_type, source, observation_status);
    `
  },
  {
    id: '20260503_003',
    name: 'Skip standalone secondary confirmation scan task',
    sql: `
      -- 金融日终流水线已包含二次确认扫描，避免新库再生成重复任务。
      SELECT 1;
    `
  },
  {
    id: '20260504_001',
    name: 'Create finance daily pipeline task',
    sql: `
      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'finance_daily_pipeline',
          '金融日终流水线',
          'finance',
          'finance_daily_pipeline',
          0,
          '16:30',
          'trade_days',
          8,
          '{"source":"tushare","active_plan_limit":50,"candidate_limit":20,"universe_limit":"all","interval_ms":1200,"secondary_scan_limit":80,"market_symbols":["000300","000905","399006","000688"]}',
          'pending',
          '一键串联市场总闸、日线更新、备选池、入场触发和持仓建议；只更新建议，不自动买卖'
        );
    `
  },
  {
    id: '20260506_002',
    name: 'Wire metals daily update task executor',
    sql: `
      UPDATE task_center_tasks
      SET task_type = 'metals_daily_update',
          config_json = CASE
            WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN '{"symbols":["XAUUSD","SGE_AGTD"]}'
            ELSE config_json
          END,
          last_status = CASE
            WHEN last_message = '任务已创建，执行器待接入' THEN 'pending'
            ELSE last_status
          END,
          last_message = CASE
            WHEN last_message = '任务已创建，执行器待接入' THEN '收盘后更新黄金与白银贵金属日线并刷新贵金属状态'
            ELSE last_message
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'metals_daily_update';
    `
  },
  {
    id: '20260506_003',
    name: 'Remove task center jobs covered by finance pipeline',
    sql: `
      DELETE FROM task_center_runs
      WHERE task_key IN ('finance_daily_close_update', 'finance_secondary_confirmation_scan');

      DELETE FROM task_center_tasks
      WHERE task_key IN ('finance_daily_close_update', 'finance_secondary_confirmation_scan');
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
    id: '20260507_005',
    name: 'Make finance daily pipeline cover full universe',
    sql: `
      UPDATE task_center_tasks
      SET config_json = '{"source":"tushare","active_plan_limit":50,"candidate_limit":20,"universe_limit":"all","interval_ms":1200,"secondary_scan_limit":80,"market_symbols":["000300","000905","399006","000688"]}',
          last_message = CASE
            WHEN task_key = 'finance_daily_pipeline'
            THEN '金融日终流水线已改为：先更新持仓/计划和备选池，最后全量补齐A股/ETF资产库日线'
            ELSE last_message
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'finance_daily_pipeline';
    `
  },
  {
    id: '20260507_006',
    name: 'Link risk control records',
    sql: `
      ALTER TABLE risk_check_records
      ADD COLUMN parent_record_id INTEGER;

      CREATE INDEX IF NOT EXISTS idx_risk_check_records_parent_record_id
      ON risk_check_records(parent_record_id);
    `
  },
  {
    id: '20260512_001',
    name: 'Unify finance funnel schedule after close',
    sql: `
      UPDATE task_center_tasks
      SET schedule_time = '16:45',
          last_message = '收盘后按同一日线口径补跑漏斗；日终流水线已包含该步骤，不自动建仓',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'finance_candidate_funnel_pipeline'
        AND schedule_time = '09:30';

      UPDATE task_center_tasks
      SET last_message = '金融日终流水线按收盘日线口径执行：先更新本地日线，再刷新市场总闸、备选池、入池漏斗、入场触发和持仓建议',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'finance_daily_pipeline';
    `
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
        trading_scope TEXT NOT NULL DEFAULT 'normal',
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
        countdown_status, scale_note, date_certainty, trading_scope, source_note
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
        ('mokoko美人鱼', '2026-04-29', '2026-04-29', '首发', '送到家', '有倒计时', '量不大；低开后被人为拉盘暴涨', 'confirmed', 'record_only', '当前只记录不参与交易'),
        ('mokoko美人鱼', '2026-05-10', '2026-05-10', '补货', '送到家', '有倒计时', '量不大；补后价格被砸下去；当前只记录不参与', 'confirmed', 'record_only', '当前只记录不参与交易');
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
    id: '20260513_001',
    name: 'Create Tushare supplemental finance data',
    sql: `
      CREATE TABLE IF NOT EXISTS financial_stock_basic_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'tushare',
        trade_date TEXT NOT NULL,
        total_mv_yuan REAL,
        circ_mv_yuan REAL,
        turnover_rate REAL,
        pe REAL,
        pb REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, source, trade_date)
      );

      CREATE INDEX IF NOT EXISTS idx_financial_stock_basic_metrics_symbol
      ON financial_stock_basic_metrics(symbol, source, trade_date);

      ALTER TABLE financial_stock_basic_metrics ADD COLUMN close REAL;
      ALTER TABLE financial_stock_basic_metrics ADD COLUMN turnover_rate_f REAL;
      ALTER TABLE financial_stock_basic_metrics ADD COLUMN volume_ratio REAL;
      ALTER TABLE financial_stock_basic_metrics ADD COLUMN pe_ttm REAL;
      ALTER TABLE financial_stock_basic_metrics ADD COLUMN ps REAL;
      ALTER TABLE financial_stock_basic_metrics ADD COLUMN ps_ttm REAL;
      ALTER TABLE financial_stock_basic_metrics ADD COLUMN dv_ratio REAL;
      ALTER TABLE financial_stock_basic_metrics ADD COLUMN dv_ttm REAL;
      ALTER TABLE financial_stock_basic_metrics ADD COLUMN total_share REAL;
      ALTER TABLE financial_stock_basic_metrics ADD COLUMN float_share REAL;
      ALTER TABLE financial_stock_basic_metrics ADD COLUMN free_share REAL;

      CREATE TABLE IF NOT EXISTS financial_moneyflow (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'tushare',
        trade_date TEXT NOT NULL,
        buy_sm_amount REAL,
        sell_sm_amount REAL,
        buy_md_amount REAL,
        sell_md_amount REAL,
        buy_lg_amount REAL,
        sell_lg_amount REAL,
        buy_elg_amount REAL,
        sell_elg_amount REAL,
        net_mf_amount REAL,
        net_mf_vol REAL,
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, source, trade_date)
      );

      CREATE INDEX IF NOT EXISTS idx_financial_moneyflow_symbol_date
      ON financial_moneyflow(symbol, source, trade_date);

      CREATE TABLE IF NOT EXISTS financial_moneyflow_ths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        name TEXT,
        source TEXT NOT NULL DEFAULT 'tushare',
        trade_date TEXT NOT NULL,
        latest REAL,
        pct_change REAL,
        net_amount REAL,
        net_amount_rate REAL,
        buy_lg_amount REAL,
        buy_lg_amount_rate REAL,
        buy_md_amount REAL,
        buy_md_amount_rate REAL,
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, source, trade_date)
      );

      CREATE INDEX IF NOT EXISTS idx_financial_moneyflow_ths_symbol_date
      ON financial_moneyflow_ths(symbol, source, trade_date);

      CREATE TABLE IF NOT EXISTS financial_limit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        name TEXT,
        source TEXT NOT NULL DEFAULT 'tushare',
        trade_date TEXT NOT NULL,
        limit_status TEXT,
        limit_type TEXT,
        close REAL,
        pct_chg REAL,
        first_time TEXT,
        last_time TEXT,
        open_times INTEGER,
        fd_amount REAL,
        fc_ratio REAL,
        fl_ratio REAL,
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, source, trade_date, limit_status)
      );

      CREATE INDEX IF NOT EXISTS idx_financial_limit_events_date
      ON financial_limit_events(trade_date, limit_status);

      CREATE TABLE IF NOT EXISTS financial_limit_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'tushare',
        trade_date TEXT NOT NULL,
        up_limit REAL,
        down_limit REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, source, trade_date)
      );

      CREATE INDEX IF NOT EXISTS idx_financial_limit_prices_symbol_date
      ON financial_limit_prices(symbol, source, trade_date);

      CREATE TABLE IF NOT EXISTS financial_sw_industries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        index_code TEXT NOT NULL,
        industry_name TEXT,
        level TEXT,
        parent_code TEXT,
        src TEXT NOT NULL DEFAULT 'SW2021',
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(index_code, src)
      );

      CREATE TABLE IF NOT EXISTS financial_sw_industry_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        name TEXT,
        l1_code TEXT,
        l1_name TEXT,
        l2_code TEXT,
        l2_name TEXT,
        l3_code TEXT,
        l3_name TEXT,
        in_date TEXT,
        out_date TEXT,
        is_new TEXT,
        src TEXT NOT NULL DEFAULT 'SW2021',
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, src, l1_code, l2_code, l3_code)
      );

      CREATE INDEX IF NOT EXISTS idx_financial_sw_members_symbol
      ON financial_sw_industry_members(symbol, src, is_new);

      CREATE TABLE IF NOT EXISTS financial_sw_industry_daily (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        index_code TEXT NOT NULL,
        name TEXT,
        source TEXT NOT NULL DEFAULT 'tushare',
        trade_date TEXT NOT NULL,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        pre_close REAL,
        change_amount REAL,
        pct_change REAL,
        volume REAL,
        amount REAL,
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(index_code, source, trade_date)
      );

      CREATE INDEX IF NOT EXISTS idx_financial_sw_daily_code_date
      ON financial_sw_industry_daily(index_code, source, trade_date);

      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'finance_tushare_supplemental_update',
          'Tushare辅助数据补全',
          'finance',
          'finance_tushare_supplemental_update',
          1,
          '17:00',
          'trade_days',
          12,
          '{"days":120,"sections":["daily_basic","moneyflow","moneyflow_ths","limits","sw"],"delay_seconds":0.15}',
          'pending',
          '收盘后补每日指标、资金流、涨跌停和申万行业数据，用于训练和辅助分析'
        );
    `
  },
  {
    id: '20260514_001_finance_experiment_prediction_snapshots',
    name: 'Create finance experiment prediction snapshots and future labels',
    sql: `
      CREATE TABLE IF NOT EXISTS finance_experiment_prediction_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_key TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT,
        asset_type TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        universe_type TEXT,
        trade_date TEXT NOT NULL,
        close REAL,
        market_regime TEXT,
        experiment_score INTEGER,
        rule_score INTEGER,
        model_probability REAL,
        model_score INTEGER,
        direction_probability REAL,
        direction_score INTEGER,
        hardness_probability REAL,
        hardness_score INTEGER,
        raw_hardness_probability REAL,
        raw_hardness_score INTEGER,
        raw_model_accept INTEGER NOT NULL DEFAULT 0,
        discipline_model_accept INTEGER NOT NULL DEFAULT 0,
        discipline_blocked INTEGER NOT NULL DEFAULT 0,
        discipline_adjustment REAL,
        feature_label TEXT,
        rotation_label TEXT,
        rotation_reason TEXT,
        discipline_label TEXT,
        discipline_reason TEXT,
        crowding_label TEXT,
        crowding_reason TEXT,
        feature_snapshot_json TEXT,
        artifact_json TEXT,
        no_lookahead_note TEXT,
        saved_from TEXT NOT NULL DEFAULT 'latest_prediction_pool',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(experiment_key, symbol, asset_type, source, trade_date, saved_from)
      );

      CREATE INDEX IF NOT EXISTS idx_finance_experiment_snapshots_scope
      ON finance_experiment_prediction_snapshots(experiment_key, saved_from, trade_date DESC, asset_type, source);

      CREATE INDEX IF NOT EXISTS idx_finance_experiment_snapshots_symbol
      ON finance_experiment_prediction_snapshots(symbol, asset_type, source, trade_date DESC, saved_from);

      CREATE INDEX IF NOT EXISTS idx_finance_experiment_snapshots_saved_from
      ON finance_experiment_prediction_snapshots(saved_from, experiment_key, market_regime, trade_date DESC);

      CREATE TABLE IF NOT EXISTS finance_experiment_prediction_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL,
        experiment_key TEXT NOT NULL,
        symbol TEXT NOT NULL,
        asset_type TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        trade_date TEXT NOT NULL,
        base_close REAL,
        horizon_days INTEGER NOT NULL DEFAULT 20,
        available_future_days INTEGER NOT NULL DEFAULT 0,
        horizon_end_date TEXT,
        forward_return_5d REAL,
        forward_return_10d REAL,
        forward_return_20d REAL,
        max_forward_return REAL,
        max_drawdown REAL,
        drawdown_discipline_hit INTEGER NOT NULL DEFAULT 0,
        direction_outcome TEXT,
        hardness_outcome TEXT,
        label_status TEXT NOT NULL DEFAULT 'pending',
        label_reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (snapshot_id) REFERENCES finance_experiment_prediction_snapshots(id) ON DELETE CASCADE,
        UNIQUE(snapshot_id, horizon_days)
      );

      CREATE INDEX IF NOT EXISTS idx_finance_experiment_labels_scope
      ON finance_experiment_prediction_labels(experiment_key, label_status, trade_date DESC);
    `
  },
  {
    id: '20260514_002_finance_pipeline_prediction_snapshots',
    name: 'Update finance daily pipeline task description for experiment prediction snapshots',
    sql: `
      UPDATE task_center_tasks
      SET last_message = '收盘后串联日线、市场总闸、备选池、入场触发、持仓建议、实验预测池落库和后验标签；只更新建议，不自动买卖',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'finance_daily_pipeline';
    `
  },
  {
    id: '20260514_003_finance_flow_auto_settlement',
    name: 'Make finance flow queues auto settle after close',
    sql: `
      UPDATE task_center_tasks
      SET config_json = '{"source":"tushare","active_plan_limit":50,"candidate_limit":300,"universe_limit":"all","interval_ms":1200,"secondary_scan_limit":200,"model_recheck_limit":200,"market_symbols":["000300","000905","399006","000688"],"prediction_pool_limit":40,"prediction_label_limit":600,"prediction_horizon_days":20}',
          last_message = '收盘后自动串联日线、市场总闸、备选池、模型复核、入池漏斗、入场触发、持仓建议、实验预测池和后验标签；计划生成与仓位填写仍保留人工确认',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'finance_daily_pipeline';

      UPDATE task_center_tasks
      SET config_json = '{"source":"tushare","candidate_limit":300,"secondary_scan_limit":200}',
          last_message = '收盘后自动推进走势阶段、单标的判断和入场触发观察；不自动生成买入计划',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'finance_candidate_funnel_pipeline';
    `
  },
  {
    id: '20260515_001_finance_pipeline_after_supplemental',
    name: 'Move finance daily pipeline after supplemental data update',
    sql: `
      UPDATE task_center_tasks
      SET schedule_time = '17:10',
          last_message = '17:10 收盘后执行：先等 Tushare 辅助数据补全，再串联日线、市场总闸、备选池、模型复核、入池漏斗、入场触发、持仓建议、实验预测池和后验标签；计划生成与仓位填写仍保留人工确认',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'finance_daily_pipeline';

      UPDATE task_center_tasks
      SET schedule_time = '17:25',
          last_message = '17:25 收盘后兜底补跑漏斗；日终流水线已包含该步骤，不自动生成买入计划',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'finance_candidate_funnel_pipeline';
    `
  },
  {
    id: '20260515_002_finance_research_inputs',
    name: 'Create finance research input records',
    sql: `
      CREATE TABLE IF NOT EXISTS finance_research_inputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        name TEXT,
        asset_type TEXT NOT NULL DEFAULT 'stock',
        visible_date TEXT NOT NULL,
        report_date TEXT,
        source_type TEXT,
        finance_change TEXT,
        industry_logic TEXT,
        capital_consensus TEXT,
        evidence_source TEXT,
        certainty TEXT NOT NULL DEFAULT 'unknown',
        tags_json TEXT,
        notes TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_finance_research_inputs_scope
      ON finance_research_inputs(visible_date DESC, symbol, asset_type, is_archived);
    `
  },
  {
    id: '20260515_003_rejected_opportunity_review_category',
    name: 'Add review category to rejected opportunities',
    sql: `
      ALTER TABLE rejected_opportunities
      ADD COLUMN review_category TEXT NOT NULL DEFAULT 'correct_reject';

      CREATE INDEX IF NOT EXISTS idx_rejected_opportunities_review_category
      ON rejected_opportunities(review_category, decision_quality, later_status);
    `
  },
  {
    id: '20260516_001_commodity_metals_price_task',
    name: 'Add commodity metals price update task',
    sql: `
      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'commodity_metals_price_update',
          '商品贵金属价格更新',
          'price',
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
      SET task_type = 'commodity_metals_price_update',
          domain = 'price',
          schedule_time = CASE WHEN schedule_time IS NULL OR schedule_time = '' THEN '17:35' ELSE schedule_time END,
          schedule_days = 'every_day',
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
    id: '20260517_001_metal_rule_lab_samples',
    name: 'Create precious metal rule lab samples',
    sql: `
      CREATE TABLE IF NOT EXISTS metal_rule_lab_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        asset_name TEXT,
        source TEXT,
        trade_date TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        close REAL,
        state_code TEXT,
        state_label TEXT,
        state_reason TEXT,
        short_label TEXT,
        mid_label TEXT,
        long_label TEXT,
        cycle_label TEXT,
        distance_to_ma60 REAL,
        recent_return_5 REAL,
        recent_return_20 REAL,
        drawdown_20 REAL,
        range_ratio_5 REAL,
        range_ratio_20 REAL,
        lower_low INTEGER,
        abnormal_move INTEGER,
        behavior_tags_json TEXT,
        state_continuation_days INTEGER,
        safe_confirmation_days INTEGER,
        safe_zone_days INTEGER,
        signal_maturity TEXT,
        signal_maturity_label TEXT,
        gold_gate_pass INTEGER,
        gold_state_code TEXT,
        no_flying_knife_blocked INTEGER,
        rule_signal TEXT,
        rule_action TEXT,
        rule_action_label TEXT,
        rule_action_reason TEXT,
        label_status TEXT,
        future_return_3d REAL,
        future_return_5d REAL,
        future_return_10d REAL,
        future_return_20d REAL,
        future_max_drawdown_20d REAL,
        break_recent_low_20d INTEGER,
        survived_3d INTEGER,
        survived_5d INTEGER,
        short_lived_signal INTEGER,
        future_state_3d TEXT,
        future_state_5d TEXT,
        future_state_10d TEXT,
        future_state_20d TEXT,
        snapshot_json TEXT NOT NULL,
        saved_from TEXT NOT NULL DEFAULT 'manual_replay',
        replay_start_date TEXT,
        replay_end_date TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, trade_date, rule_version)
      );

      CREATE INDEX IF NOT EXISTS idx_metal_rule_lab_samples_scope
      ON metal_rule_lab_samples(symbol, trade_date DESC, rule_version);

      CREATE INDEX IF NOT EXISTS idx_metal_rule_lab_samples_labels
      ON metal_rule_lab_samples(symbol, label_status, rule_signal, rule_action, trade_date DESC);

      CREATE INDEX IF NOT EXISTS idx_metal_rule_lab_samples_outcomes
      ON metal_rule_lab_samples(symbol, short_lived_signal, no_flying_knife_blocked, gold_gate_pass, trade_date DESC);
    `
  },
  {
    id: '20260517_002_finance_latest_date_indexes',
    name: 'Add finance latest-date indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_financial_daily_prices_scope_date
      ON financial_daily_prices(source, asset_type, trade_date DESC);
    `
  },
  {
    id: '20260518_001_finance_experiment_prediction_saved_from_unique',
    name: 'Upgrade experiment prediction snapshot unique key with saved_from',
    run: migratePredictionSnapshotSavedFromUnique
  },
  {
    id: '20260518_002_finance_supplemental_after_close',
    name: 'Move finance supplemental data update after 17:00 close window',
    sql: `
      UPDATE task_center_tasks
      SET schedule_time = '17:00',
          last_message = '17:00 收盘后补每日指标、资金流、涨跌停和申万行业数据；日终流水线 17:10 接着统一流转',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'finance_tushare_supplemental_update'
        AND schedule_time < '17:00';
    `
  },
  {
    id: '20260518_003_finance_rejected_candidate_cleanup',
    name: 'Set rejected active finance candidates to expired',
    sql: `
      UPDATE financial_candidate_pool
      SET pool_status = 'expired',
          final_status = CASE
            WHEN COALESCE(final_status, '') = '' THEN 'REJECTED'
            ELSE final_status
          END,
          review_action = CASE
            WHEN COALESCE(review_action, '') = '' THEN 'auto_status_cleanup'
            ELSE review_action
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE pool_status = 'active'
        AND asset_type IN ('stock', 'etf')
        AND COALESCE(review_status, '') = 'rejected';
    `
  },
  {
    id: '20260518_004_fx_daily_rates',
    name: 'Create FX daily rates and USD CNY auxiliary task',
    sql: `
      CREATE TABLE IF NOT EXISTS fx_daily_rates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        ts_code TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'tushare_fxcm',
        usd_cny_mid REAL NOT NULL,
        bid_open REAL,
        bid_close REAL,
        bid_high REAL,
        bid_low REAL,
        ask_open REAL,
        ask_close REAL,
        ask_high REAL,
        ask_low REAL,
        tick_qty REAL,
        usd_cny_change_5d REAL,
        usd_cny_change_20d REAL,
        cny_state TEXT NOT NULL DEFAULT '人民币震荡',
        fx_tailwind_for_silver TEXT NOT NULL DEFAULT '中性',
        raw_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(trade_date, ts_code, source)
      );

      CREATE INDEX IF NOT EXISTS idx_fx_daily_rates_scope
      ON fx_daily_rates(ts_code, source, trade_date DESC);

      CREATE INDEX IF NOT EXISTS idx_fx_daily_rates_tailwind
      ON fx_daily_rates(fx_tailwind_for_silver, cny_state, trade_date DESC);

      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'fx_daily_rates_update',
          'USD/CNY汇率辅助更新',
          'finance',
          'fx_daily_rates_update',
          1,
          '17:25',
          'every_day',
          36,
          '{"ts_code":"USDCNH.FXCM","source":"tushare_fxcm"}',
          'pending',
          '每天从 Tushare 拉取 USDCNH.FXCM，生成人民币升贬值与白银汇率顺风/逆风标签'
        );

      UPDATE task_center_tasks
      SET task_type = 'fx_daily_rates_update',
          domain = 'finance',
          schedule_time = CASE WHEN schedule_time IS NULL OR schedule_time = '' THEN '17:25' ELSE schedule_time END,
          schedule_days = 'every_day',
          config_json = CASE
            WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN '{"ts_code":"USDCNH.FXCM","source":"tushare_fxcm"}'
            ELSE config_json
          END,
          last_message = '每天从 Tushare 拉取 USDCNH.FXCM，生成人民币升贬值与白银汇率顺风/逆风标签',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'fx_daily_rates_update';
    `
  },
  {
    id: '20260518_005_finance_market_regime_dedupe',
    name: 'Deduplicate finance market regime rows and enforce unique daily regime',
    sql: `
      UPDATE financial_market_regime
      SET rule_version = 'market_regime_v1'
      WHERE rule_version IS NULL OR TRIM(rule_version) = '';

      DELETE FROM financial_market_regime
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM financial_market_regime
        GROUP BY symbol, trade_date, rule_version
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_market_regime_unique_daily
      ON financial_market_regime(symbol, trade_date, rule_version);
    `
  },
  {
    id: '20260518_006_finance_daily_pipeline_wait_full_universe',
    name: 'Make finance daily pipeline wait for full universe daily close update',
    run: async (db: any) => {
      const taskTable = await dbGet<{ name: string }>(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_center_tasks'"
      );
      if (!taskTable) return;

      const task = await dbGet<{ config_json?: string | null }>(
        db,
        "SELECT config_json FROM task_center_tasks WHERE task_key = 'finance_daily_pipeline'"
      );
      if (!task) return;

      let config: Record<string, any> = {};
      try {
        config = task.config_json ? JSON.parse(task.config_json) : {};
      } catch {
        config = {};
      }
      config.wait_full_universe = true;

	      await dbRun(
	        db,
	        `UPDATE task_center_tasks
	         SET config_json = ?,
	             last_message = CASE
	               WHEN COALESCE(last_status, 'pending') IN ('pending', '')
	                 OR last_message IS NULL
	                 OR last_message LIKE '17:%'
	                 OR last_message LIKE '收盘后%'
	                 THEN '17:10 收盘后等待全市场日线补齐完成，再扫候选、模型复核、漏斗、实验预测池和后验标签；计划生成与仓位填写仍人工确认'
	               ELSE last_message
	             END,
	             updated_at = CURRENT_TIMESTAMP
	         WHERE task_key = 'finance_daily_pipeline'`,
	        [JSON.stringify(config)]
      );
    }
  },
  {
    id: '20260518_007_finance_decision_snapshots_trade_date',
    name: 'Clamp finance decision sample snapshots to latest trading date',
    run: async (db: any) => {
      const snapshotTable = await dbGet<{ name: string }>(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'finance_decision_sample_snapshots'"
      );
      if (!snapshotTable) return;

      const latest = await dbGet<{ trade_date?: string | null }>(
        db,
        `SELECT MAX(trade_date) AS trade_date
         FROM (
           SELECT trade_date
           FROM financial_daily_prices
           WHERE trade_date IS NOT NULL
             AND COALESCE(source, 'tushare') = 'tushare'
             AND asset_type IN ('stock', 'etf')
           UNION ALL
           SELECT trade_date
           FROM financial_market_regime
           WHERE trade_date IS NOT NULL
         )`
      );
      const targetDate = latest?.trade_date;
      if (!targetDate) return;

      await dbExec(db, 'BEGIN TRANSACTION');
      try {
        await dbRun(
          db,
          `DELETE FROM finance_decision_sample_snapshots
           WHERE snapshot_date = ?
             AND sample_id IN (
               SELECT sample_id
               FROM finance_decision_sample_snapshots
               WHERE snapshot_date > ?
             )`,
          [targetDate, targetDate]
        );
        await dbRun(
          db,
          `UPDATE finance_decision_sample_snapshots
           SET snapshot_date = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE snapshot_date > ?`,
          [targetDate, targetDate]
        );
        await dbExec(db, 'COMMIT');
      } catch (error) {
        await dbExec(db, 'ROLLBACK');
        throw error;
      }
    }
  },
  {
    id: '20260519_001_finance_candidate_final_status_alignment',
    name: 'Align active finance candidate final status with review status',
    sql: `
      UPDATE financial_candidate_pool
      SET final_status = 'WAIT',
          updated_at = CURRENT_TIMESTAMP
      WHERE pool_status = 'active'
        AND asset_type IN ('stock', 'etf')
        AND review_status IN ('trend_blocked', 'structure_watch', 'wait_confirmation', 'unreviewed', 'drafted')
        AND final_status = 'READY_FOR_PLAN';
    `
  },
  {
    id: '20260519_003_finance_model_recheck_settled_alignment',
    name: 'Align settled model recheck candidates with rejected final status',
    sql: `
      UPDATE financial_candidate_pool
      SET final_status = 'REJECTED',
          updated_at = CURRENT_TIMESTAMP
      WHERE review_action = 'auto_model_recheck_settled'
        AND review_status = 'rejected'
        AND final_status = 'READY_FOR_PLAN';
    `
  },
  {
    id: '20260519_004_finance_expired_candidate_final_status_alignment',
    name: 'Align expired finance candidate final status as rejected',
    sql: `
      UPDATE financial_candidate_pool
      SET final_status = 'REJECTED',
          updated_at = CURRENT_TIMESTAMP
      WHERE pool_status = 'expired'
        AND asset_type IN ('stock', 'etf')
        AND COALESCE(final_status, '') <> 'REJECTED';
    `
  },
  {
    id: '20260519_002_precious_metals_training_pipeline',
    name: 'Create precious metals training pipeline task and silver gate audit',
    sql: `
      CREATE TABLE IF NOT EXISTS metal_training_gate_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        gate_key TEXT NOT NULL,
        status TEXT NOT NULL,
        passed INTEGER NOT NULL DEFAULT 0,
        metrics_json TEXT,
        checks_json TEXT,
        thresholds_json TEXT,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_metal_training_gate_runs_symbol
      ON metal_training_gate_runs(symbol, gate_key, created_at DESC);

      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'precious_metals_training_pipeline',
          '贵金属训练流水线',
          'metals',
          'precious_metals_training_pipeline',
          1,
          '18:10',
          'every_day',
          38,
          '{"symbols":["XAUUSD","SGE_AGTD"],"refresh_prices":true,"refresh_fx":true,"replay_limit":1500,"train_gold":true,"train_silver_if_gate_pass":false,"silver_gate":{"min_main_signal_count":300,"min_block_signal_count":300,"min_short_lived_edge":0.03,"min_drawdown_edge":0.005,"min_fx_coverage":0.8}}',
          'pending',
          '独立贵金属训练流水线：更新行情/汇率、回放落库、白银分层验收、黄金训练；白银必须过训练闸门才允许后续辅助模型训练'
        );

      UPDATE task_center_tasks
      SET domain = 'metals',
          task_type = 'precious_metals_training_pipeline',
          schedule_time = CASE WHEN schedule_time IS NULL OR schedule_time = '' THEN '18:10' ELSE schedule_time END,
          schedule_days = CASE WHEN schedule_days IS NULL OR schedule_days = '' THEN 'every_day' ELSE schedule_days END,
          config_json = CASE
            WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN '{"symbols":["XAUUSD","SGE_AGTD"],"refresh_prices":true,"refresh_fx":true,"replay_limit":1500,"train_gold":true,"train_silver_if_gate_pass":false,"silver_gate":{"min_main_signal_count":300,"min_block_signal_count":300,"min_short_lived_edge":0.03,"min_drawdown_edge":0.005,"min_fx_coverage":0.8}}'
            ELSE config_json
          END,
          last_message = CASE
            WHEN last_status IS NULL OR last_status = 'pending' THEN '独立贵金属训练流水线：更新行情/汇率、回放落库、白银分层验收、黄金训练；白银必须过训练闸门才允许后续辅助模型训练'
            ELSE last_message
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'precious_metals_training_pipeline';
    `
  },
  {
    id: '20260520_001_gold_rule_contrast_reports',
    name: 'Create gold rule contrast reports',
    sql: `
      CREATE TABLE IF NOT EXISTS metal_rule_contrast_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        report_key TEXT NOT NULL,
        report_date TEXT,
        rule_version TEXT NOT NULL,
        status TEXT NOT NULL,
        conclusion_label TEXT,
        conclusion_text TEXT,
        metrics_json TEXT,
        checks_json TEXT,
        report_json TEXT NOT NULL,
        saved_from TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_metal_rule_contrast_reports_scope
      ON metal_rule_contrast_reports(symbol, report_key, created_at DESC);
    `
  },
  {
    id: '20260520_002_gold_model_validation_reports',
    name: 'Create gold model validation reports',
    sql: `
      CREATE TABLE IF NOT EXISTS metal_model_validation_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        domain TEXT NOT NULL,
        model_run_id INTEGER,
        report_key TEXT NOT NULL,
        status TEXT NOT NULL,
        conclusion_label TEXT,
        conclusion_text TEXT,
        metrics_json TEXT,
        checks_json TEXT,
        report_json TEXT NOT NULL,
        saved_from TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_metal_model_validation_reports_scope
      ON metal_model_validation_reports(symbol, report_key, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_metal_model_validation_reports_run
      ON metal_model_validation_reports(domain, model_run_id, created_at DESC);
    `
  },
  {
    id: '20260522_001_finance_experiment_prediction_task',
    name: 'Add independent finance experiment prediction snapshot task',
    sql: `
      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'finance_experiment_prediction_snapshots',
          '五模型实验预测池落库',
          'finance',
          'finance_experiment_prediction_snapshots',
          1,
          '17:35',
          'trade_days',
          42,
          '{"prediction_pool_limit":40,"prediction_label_limit":600,"prediction_horizon_days":20}',
          'pending',
          '金融日终流水线的独立兜底任务：只滚动五模型 latest_prediction_pool 和后验标签，不推进备选池、入场触发或买入计划。'
        );

      UPDATE task_center_tasks
      SET name = '五模型实验预测池落库',
          domain = 'finance',
          task_type = 'finance_experiment_prediction_snapshots',
          enabled = 1,
          schedule_time = CASE WHEN schedule_time IS NULL OR schedule_time = '' THEN '17:35' ELSE schedule_time END,
          schedule_days = 'trade_days',
          priority = 42,
          config_json = CASE
            WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN '{"prediction_pool_limit":40,"prediction_label_limit":600,"prediction_horizon_days":20}'
            ELSE config_json
          END,
          last_message = '金融日终流水线的独立兜底任务：只滚动五模型 latest_prediction_pool 和后验标签，不推进备选池、入场触发或买入计划。',
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'finance_experiment_prediction_snapshots';
    `
  },
  {
    id: '20260523_001_finance_workflow_summary_indexes',
    name: 'Add finance workflow summary date indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_financial_stock_basic_metrics_trade_date
      ON financial_stock_basic_metrics(trade_date DESC, source);

      CREATE INDEX IF NOT EXISTS idx_financial_sw_industry_daily_trade_date
      ON financial_sw_industry_daily(trade_date DESC, source);

      CREATE INDEX IF NOT EXISTS idx_financial_market_breadth_daily_trade_date
      ON financial_market_breadth_daily(trade_date DESC);

      CREATE INDEX IF NOT EXISTS idx_financial_limit_events_trade_date
      ON financial_limit_events(trade_date DESC);

      CREATE INDEX IF NOT EXISTS idx_financial_market_regime_trade_date
      ON financial_market_regime(trade_date DESC);
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

async function ensurePredictionSnapshotMigrationColumn(db: any, column: string, definition: string): Promise<void> {
  const columns = await dbAll<any>(db, `PRAGMA table_info(finance_experiment_prediction_snapshots)`);
  const exists = columns.some((item: any) => String(item.name) === column);
  if (!exists) {
    await dbExec(db, `ALTER TABLE finance_experiment_prediction_snapshots ADD COLUMN ${quoteMigrationIdentifier(column)} ${definition}`);
  }
}

async function hasPredictionSnapshotSavedFromUnique(db: any): Promise<boolean> {
  const indexes = await dbAll<any>(db, `PRAGMA index_list(finance_experiment_prediction_snapshots)`);
  const expectedColumns = new Set(['experiment_key', 'symbol', 'asset_type', 'source', 'trade_date', 'saved_from']);
  for (const index of indexes) {
    if (!Number(index.unique)) continue;
    const columns = await dbAll<any>(db, `PRAGMA index_info(${quoteMigrationIdentifier(String(index.name))})`);
    const names = columns.map((column: any) => String(column.name));
    if (names.length === expectedColumns.size && names.every((name: string) => expectedColumns.has(name))) {
      return true;
    }
  }
  return false;
}

async function recreatePredictionSnapshotMigrationIndexes(db: any): Promise<void> {
  await dbExec(db, `
    DROP INDEX IF EXISTS idx_finance_experiment_snapshots_scope;
    DROP INDEX IF EXISTS idx_finance_experiment_snapshots_symbol;
    DROP INDEX IF EXISTS idx_finance_experiment_snapshots_saved_from;

    CREATE INDEX IF NOT EXISTS idx_finance_experiment_snapshots_scope
    ON finance_experiment_prediction_snapshots(experiment_key, saved_from, trade_date DESC, asset_type, source);

    CREATE INDEX IF NOT EXISTS idx_finance_experiment_snapshots_symbol
    ON finance_experiment_prediction_snapshots(symbol, asset_type, source, trade_date DESC, saved_from);

    CREATE INDEX IF NOT EXISTS idx_finance_experiment_snapshots_saved_from
    ON finance_experiment_prediction_snapshots(saved_from, experiment_key, market_regime, trade_date DESC);
  `);
}

async function migratePredictionSnapshotSavedFromUnique(db: any): Promise<void> {
  await dbExec(db, `
    CREATE TABLE IF NOT EXISTS finance_experiment_prediction_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_key TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      asset_type TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      universe_type TEXT,
      trade_date TEXT NOT NULL,
      close REAL,
      market_regime TEXT,
      experiment_score INTEGER,
      rule_score INTEGER,
      model_probability REAL,
      model_score INTEGER,
      direction_probability REAL,
      direction_score INTEGER,
      hardness_probability REAL,
      hardness_score INTEGER,
      raw_hardness_probability REAL,
      raw_hardness_score INTEGER,
      raw_model_accept INTEGER NOT NULL DEFAULT 0,
      discipline_model_accept INTEGER NOT NULL DEFAULT 0,
      discipline_blocked INTEGER NOT NULL DEFAULT 0,
      discipline_adjustment REAL,
      feature_label TEXT,
      rotation_label TEXT,
      rotation_reason TEXT,
      discipline_label TEXT,
      discipline_reason TEXT,
      crowding_label TEXT,
      crowding_reason TEXT,
      feature_snapshot_json TEXT,
      artifact_json TEXT,
      no_lookahead_note TEXT,
      saved_from TEXT NOT NULL DEFAULT 'latest_prediction_pool',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(experiment_key, symbol, asset_type, source, trade_date, saved_from)
    );
  `);

  const requiredColumns = [
    ['saved_from', "TEXT NOT NULL DEFAULT 'latest_prediction_pool'"],
    ['raw_hardness_probability', 'REAL'],
    ['raw_hardness_score', 'INTEGER'],
    ['raw_model_accept', 'INTEGER NOT NULL DEFAULT 0'],
    ['discipline_model_accept', 'INTEGER NOT NULL DEFAULT 0'],
    ['discipline_blocked', 'INTEGER NOT NULL DEFAULT 0'],
    ['discipline_adjustment', 'REAL']
  ];
  for (const [column, definition] of requiredColumns) {
    await ensurePredictionSnapshotMigrationColumn(db, column, definition);
  }

  const hasSavedFromUnique = await hasPredictionSnapshotSavedFromUnique(db);
  if (hasSavedFromUnique) {
    await recreatePredictionSnapshotMigrationIndexes(db);
    return;
  }

  await dbExec(db, 'PRAGMA foreign_keys = OFF');
  try {
    await dbExec(db, 'BEGIN TRANSACTION');
    await dbExec(db, `
      DROP TABLE IF EXISTS finance_experiment_prediction_snapshots_next;

      CREATE TABLE finance_experiment_prediction_snapshots_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_key TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT,
        asset_type TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        universe_type TEXT,
        trade_date TEXT NOT NULL,
        close REAL,
        market_regime TEXT,
        experiment_score INTEGER,
        rule_score INTEGER,
        model_probability REAL,
        model_score INTEGER,
        direction_probability REAL,
        direction_score INTEGER,
        hardness_probability REAL,
        hardness_score INTEGER,
        raw_hardness_probability REAL,
        raw_hardness_score INTEGER,
        raw_model_accept INTEGER NOT NULL DEFAULT 0,
        discipline_model_accept INTEGER NOT NULL DEFAULT 0,
        discipline_blocked INTEGER NOT NULL DEFAULT 0,
        discipline_adjustment REAL,
        feature_label TEXT,
        rotation_label TEXT,
        rotation_reason TEXT,
        discipline_label TEXT,
        discipline_reason TEXT,
        crowding_label TEXT,
        crowding_reason TEXT,
        feature_snapshot_json TEXT,
        artifact_json TEXT,
        no_lookahead_note TEXT,
        saved_from TEXT NOT NULL DEFAULT 'latest_prediction_pool',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(experiment_key, symbol, asset_type, source, trade_date, saved_from)
      );

      INSERT INTO finance_experiment_prediction_snapshots_next (
        id, experiment_key, symbol, name, asset_type, source, universe_type, trade_date, close,
        market_regime, experiment_score, rule_score, model_probability, model_score,
        direction_probability, direction_score, hardness_probability, hardness_score,
        raw_hardness_probability, raw_hardness_score, raw_model_accept, discipline_model_accept,
        discipline_blocked, discipline_adjustment,
        feature_label, rotation_label, rotation_reason, discipline_label, discipline_reason,
        crowding_label, crowding_reason, feature_snapshot_json, artifact_json, no_lookahead_note,
        saved_from, created_at, updated_at
      )
      SELECT
        id, experiment_key, symbol, name, COALESCE(asset_type, ''), COALESCE(source, ''), universe_type, trade_date, close,
        market_regime, experiment_score, rule_score, model_probability, model_score,
        direction_probability, direction_score, hardness_probability, hardness_score,
        raw_hardness_probability, raw_hardness_score, COALESCE(raw_model_accept, 0), COALESCE(discipline_model_accept, 0),
        COALESCE(discipline_blocked, 0), discipline_adjustment,
        feature_label, rotation_label, rotation_reason, discipline_label, discipline_reason,
        crowding_label, crowding_reason, feature_snapshot_json, artifact_json, no_lookahead_note,
        COALESCE(NULLIF(saved_from, ''), 'latest_prediction_pool'), created_at, updated_at
      FROM finance_experiment_prediction_snapshots;

      DROP TABLE finance_experiment_prediction_snapshots;
      ALTER TABLE finance_experiment_prediction_snapshots_next RENAME TO finance_experiment_prediction_snapshots;
      COMMIT;
    `);
  } catch (error) {
    await dbExec(db, 'ROLLBACK');
    throw error;
  } finally {
    await dbExec(db, 'PRAGMA foreign_keys = ON');
  }

  await recreatePredictionSnapshotMigrationIndexes(db);
  const foreignKeyIssues = await dbAll<any>(db, 'PRAGMA foreign_key_check');
  if (foreignKeyIssues.length) {
    throw new Error(`finance_experiment_prediction_snapshots 外键检查失败：${foreignKeyIssues.length} 条`);
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
        console.log(`Migration ${migration.id} already executed, skipping`);
        continue;
      }

      console.log(`Executing migration: ${migration.name} (${migration.id})`);
      if (migration.run) {
        await migration.run(db);
      } else if (migration.sql) {
        await dbExec(db, migration.sql);
      }

      await dbRun(db, 'INSERT INTO migrations (id, name) VALUES (?, ?)', [migration.id, migration.name]);
      console.log(`Migration ${migration.id} executed successfully`);
    }
  } finally {
    await dbClose(db);
  }
}
