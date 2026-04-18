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
