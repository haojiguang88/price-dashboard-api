// 趋势阶段结果表迁移
export const migration = {
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
};

export default migration;
