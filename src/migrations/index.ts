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
