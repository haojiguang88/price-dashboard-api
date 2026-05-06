// 迁移管理模块

interface Migration {
  id: string;
  name: string;
  sql: string;
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
          'finance_daily_close_update',
          'A股每日收盘更新',
          'finance',
          'daily_close_update',
          0,
          '16:00',
          'trade_days',
          10,
          '{"source":"tushare","candidate_limit":20,"universe_limit":50,"interval_ms":1200}',
          'pending',
          '收盘后更新A股日线，优先更新备选池并刷新备选池'
        ),
        (
          'metals_daily_update',
          '贵金属每日行情更新',
          'metals',
          'metals_daily_update',
          0,
          '16:10',
          'every_day',
          30,
          '{"symbols":["XAUUSD"]}',
          'pending',
          '收盘后更新XAUUSD贵金属日线并刷新贵金属状态'
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
    name: 'Create secondary confirmation scan task',
    sql: `
      INSERT OR IGNORE INTO task_center_tasks
        (task_key, name, domain, task_type, enabled, schedule_time, schedule_days, priority, config_json, last_status, last_message)
      VALUES
        (
          'finance_secondary_confirmation_scan',
          '金融二次确认扫描',
          'finance',
          'secondary_confirmation_scan',
          0,
          '09:20',
          'trade_days',
          15,
          '{"limit":80}',
          'pending',
          '扫描等待二次确认和入场观察记录，只更新状态，不自动生成买入计划'
        );
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
          '{"source":"tushare","active_plan_limit":50,"candidate_limit":20,"universe_limit":50,"interval_ms":1200,"secondary_scan_limit":80,"market_symbols":["000300","000905","399006","000688"]}',
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
            WHEN config_json IS NULL OR config_json = '{}' OR config_json = '' THEN '{"symbols":["XAUUSD"]}'
            ELSE config_json
          END,
          last_status = CASE
            WHEN last_message = '任务已创建，执行器待接入' THEN 'pending'
            ELSE last_status
          END,
          last_message = CASE
            WHEN last_message = '任务已创建，执行器待接入' THEN '收盘后更新XAUUSD贵金属日线并刷新贵金属状态'
            ELSE last_message
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE task_key = 'metals_daily_update';
    `
  }
];

// 执行迁移
export async function runMigrations(dbPath: string): Promise<void> {
  const sqlite3 = require('sqlite3').verbose();
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err: any) => {
      if (err) {
        reject(err);
        return;
      }

      // 确保迁移表存在
      db.run(
        `CREATE TABLE IF NOT EXISTS migrations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        (createErr: any) => {
          if (createErr) {
            db.close();
            reject(createErr);
            return;
          }

          // 执行每个迁移
          let completed = 0;
          let errorOccurred = false;

          migrations.forEach((migration) => {
            db.get(
              'SELECT id FROM migrations WHERE id = ?',
              [migration.id],
              (getErr: any, row: any) => {
                if (errorOccurred) return;
                
                if (getErr) {
                  errorOccurred = true;
                  db.close();
                  reject(getErr);
                  return;
                }

                if (!row) {
                  console.log(`Executing migration: ${migration.name} (${migration.id})`);
                  // 执行迁移
                  db.exec(migration.sql, (execErr: any) => {
                    if (errorOccurred) return;
                    
                    if (execErr) {
                      errorOccurred = true;
                      db.close();
                      reject(execErr);
                      return;
                    }

                    // 记录迁移
                    db.run(
                      'INSERT INTO migrations (id, name) VALUES (?, ?)',
                      [migration.id, migration.name],
                      (insertErr: any) => {
                        if (errorOccurred) return;
                        
                        if (insertErr) {
                          errorOccurred = true;
                          db.close();
                          reject(insertErr);
                          return;
                        }

                        console.log(`Migration ${migration.id} executed successfully`);
                        completed++;
                        if (completed === migrations.length) {
                          db.close();
                          resolve();
                        }
                      }
                    );
                  });
                } else {
                  console.log(`Migration ${migration.id} already executed, skipping`);
                  completed++;
                  if (completed === migrations.length) {
                    db.close();
                    resolve();
                  }
                }
              }
            );
          });
        }
      );
    });
  });
}
