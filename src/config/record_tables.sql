-- 事件记录表
CREATE TABLE IF NOT EXISTS event_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  impact TEXT,
  follow_up TEXT,
  track TEXT NOT NULL,
  type TEXT DEFAULT 'manual',
  market_type_preset TEXT DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 观点记录表
CREATE TABLE IF NOT EXISTS opinion_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence TEXT,
  evidence TEXT,
  track TEXT NOT NULL,
  type TEXT DEFAULT 'manual',
  market_type_preset TEXT DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 错过项目复盘表
CREATE TABLE IF NOT EXISTS missed_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_name TEXT NOT NULL,
  category TEXT NOT NULL,
  missed_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  lesson_learned TEXT,
  future_action TEXT,
  track TEXT NOT NULL,
  type TEXT DEFAULT 'manual',
  market_type_preset TEXT DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 交易回顾表
CREATE TABLE IF NOT EXISTS trade_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL,
  category TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  trade_type TEXT NOT NULL,
  amount REAL NOT NULL,
  profit REAL,
  review_content TEXT NOT NULL,
  improvement TEXT,
  track TEXT NOT NULL,
  type TEXT DEFAULT 'manual',
  market_type_preset TEXT DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 树挂案例表
CREATE TABLE IF NOT EXISTS tree_hanging_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_name TEXT NOT NULL,
  category TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  description TEXT NOT NULL,
  root_cause TEXT,
  solution TEXT,
  track TEXT NOT NULL,
  type TEXT DEFAULT 'manual',
  market_type_preset TEXT DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 市场回顾表
CREATE TABLE IF NOT EXISTS market_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  review_date TEXT NOT NULL,
  market_summary TEXT NOT NULL,
  key_events TEXT,
  outlook TEXT,
  track TEXT NOT NULL,
  type TEXT DEFAULT 'manual',
  market_type_preset TEXT DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 规则经验表
CREATE TABLE IF NOT EXISTS rule_experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_name TEXT NOT NULL,
  category TEXT NOT NULL,
  established_date TEXT NOT NULL,
  description TEXT NOT NULL,
  application TEXT,
  effectiveness TEXT,
  track TEXT,
  type TEXT DEFAULT 'manual',
  market_type_preset TEXT DEFAULT 'standard',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
