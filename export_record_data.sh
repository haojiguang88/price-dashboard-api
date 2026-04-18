#!/bin/bash

# 导出记录型模块数据的脚本

DB_FILE="db/price_dashboard_dev.db"

# 事件记录
echo "-- 事件记录" > export_event_records.sql
sqlite3 "$DB_FILE" <<EOF
.mode list
.separator "|"
SELECT 'INSERT INTO event_records (title, track, event_date, event_type, description, related_object, impact, source, note, is_deleted, created_at, updated_at) VALUES (''' || 
       replace(title, '''', '''''') || ''', ''' || 
       replace(track, '''', '''''') || ''', ''' || 
       event_date || ''', ''' || 
       replace(event_type, '''', '''''') || ''', ''' || 
       replace(description, '''', '''''') || ''', ''' || 
       replace(related_object, '''', '''''') || ''', ''' || 
       replace(impact, '''', '''''') || ''', ''' || 
       replace(source, '''', '''''') || ''', ''' || 
       replace(note, '''', '''''') || ''', ' || 
       is_deleted || ', ''' || 
       created_at || ''', ''' || 
       updated_at || ''');' 
FROM event_records;
EOF

# 观点记录
echo "-- 观点记录" > export_opinion_records.sql
sqlite3 "$DB_FILE" <<EOF
.mode list
.separator "|"
SELECT 'INSERT INTO opinion_records (title, track, person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, my_interpretation, validation_result, validation_date, person_observation, note, is_deleted, created_at, updated_at) VALUES (''' || 
       replace(title, '''', '''''') || ''', ''' || 
       replace(track, '''', '''''') || ''', ''' || 
       replace(person_name, '''', '''''') || ''', ''' || 
       replace(source_platform, '''', '''''') || ''', ''' || 
       opinion_date || ''', ''' || 
       replace(validation_status, '''', '''''') || ''', ''' || 
       replace(summary_result, '''', '''''') || ''', ''' || 
       replace(original_opinion, '''', '''''') || ''', ''' || 
       replace(my_interpretation, '''', '''''') || ''', ''' || 
       replace(validation_result, '''', '''''') || ''', ''' || 
       validation_date || ''', ''' || 
       replace(person_observation, '''', '''''') || ''', ''' || 
       replace(note, '''', '''''') || ''', ' || 
       is_deleted || ', ''' || 
       created_at || ''', ''' || 
       updated_at || ''');' 
FROM opinion_records;
EOF

# 错过项目复盘
echo "-- 错过项目复盘" > export_missed_projects.sql
sqlite3 "$DB_FILE" <<EOF
.mode list
.separator "|"
SELECT 'INSERT INTO missed_projects (title, track, project_name, source, review_date, miss_type, signal, reason, trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson, note, is_deleted, created_at, updated_at) VALUES (''' || 
       replace(title, '''', '''''') || ''', ''' || 
       replace(track, '''', '''''') || ''', ''' || 
       replace(project_name, '''', '''''') || ''', ''' || 
       replace(source, '''', '''''') || ''', ''' || 
       review_date || ''', ''' || 
       replace(miss_type, '''', '''''') || ''', ''' || 
       replace(signal, '''', '''''') || ''', ''' || 
       replace(reason, '''', '''''') || ''', ''' || 
       replace(trend, '''', '''''') || ''', ''' || 
       replace(exposed_problem, '''', '''''') || ''', ''' || 
       replace(extracted_lesson, '''', '''''') || ''', ''' || 
       replace(summary_conclusion, '''', '''''') || ''', ''' || 
       replace(short_lesson, '''', '''''') || ''', ''' || 
       replace(note, '''', '''''') || ''', ' || 
       is_deleted || ', ''' || 
       created_at || ''', ''' || 
       updated_at || ''');' 
FROM missed_projects;
EOF

# 交易复盘
echo "-- 交易复盘" > export_trade_reviews.sql
sqlite3 "$DB_FILE" <<EOF
.mode list
.separator "|"
SELECT 'INSERT INTO trade_reviews (title, track, project_name, review_date, result_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, is_deleted, created_at, updated_at) VALUES (''' || 
       replace(title, '''', '''''') || ''', ''' || 
       replace(track, '''', '''''') || ''', ''' || 
       replace(project_name, '''', '''''') || ''', ''' || 
       review_date || ''', ''' || 
       replace(result_type, '''', '''''') || ''', ''' || 
       replace(summary_conclusion, '''', '''''') || ''', ''' || 
       replace(background, '''', '''''') || ''', ''' || 
       replace(judgment_at_that_time, '''', '''''') || ''', ''' || 
       replace(action_at_that_time, '''', '''''') || ''', ''' || 
       replace(later_outcome, '''', '''''') || ''', ''' || 
       replace(root_cause_type, '''', '''''') || ''', ''' || 
       replace(exposed_problem, '''', '''''') || ''', ''' || 
       replace(extracted_lesson, '''', '''''') || ''', ''' || 
       replace(short_lesson, '''', '''''') || ''', ''' || 
       replace(note, '''', '''''') || ''', ' || 
       is_deleted || ', ''' || 
       created_at || ''', ''' || 
       updated_at || ''');' 
FROM trade_reviews;
EOF

# 挂树案例
echo "-- 挂树案例" > export_tree_hanging_cases.sql
sqlite3 "$DB_FILE" <<EOF
.mode list
.separator "|"
SELECT 'INSERT INTO tree_hanging_cases (title, track, project_name, review_date, tree_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, is_deleted, created_at, updated_at) VALUES (''' || 
       replace(title, '''', '''''') || ''', ''' || 
       replace(track, '''', '''''') || ''', ''' || 
       replace(project_name, '''', '''''') || ''', ''' || 
       review_date || ''', ''' || 
       replace(tree_type, '''', '''''') || ''', ''' || 
       replace(summary_conclusion, '''', '''''') || ''', ''' || 
       replace(background, '''', '''''') || ''', ''' || 
       replace(judgment_at_that_time, '''', '''''') || ''', ''' || 
       replace(action_at_that_time, '''', '''''') || ''', ''' || 
       replace(later_outcome, '''', '''''') || ''', ''' || 
       replace(root_cause_type, '''', '''''') || ''', ''' || 
       replace(exposed_problem, '''', '''''') || ''', ''' || 
       replace(extracted_lesson, '''', '''''') || ''', ''' || 
       replace(short_lesson, '''', '''''') || ''', ''' || 
       replace(note, '''', '''''') || ''', ' || 
       is_deleted || ', ''' || 
       created_at || ''', ''' || 
       updated_at || ''');' 
FROM tree_hanging_cases;
EOF

# 行情复盘
echo "-- 行情复盘" > export_market_reviews.sql
sqlite3 "$DB_FILE" <<EOF
.mode list
.separator "|"
SELECT 'INSERT INTO market_reviews (title, track, project_name, review_date, market_type_preset, market_type_custom, summary_conclusion, short_lesson, background, market_start, market_evolution, key_turning_points, later_outcome, exposed_problem, extracted_lesson, note, is_deleted, created_at, updated_at) VALUES (''' || 
       replace(title, '''', '''''') || ''', ''' || 
       replace(track, '''', '''''') || ''', ''' || 
       replace(project_name, '''', '''''') || ''', ''' || 
       review_date || ''', ''' || 
       replace(market_type_preset, '''', '''''') || ''', ''' || 
       replace(market_type_custom, '''', '''''') || ''', ''' || 
       replace(summary_conclusion, '''', '''''') || ''', ''' || 
       replace(short_lesson, '''', '''''') || ''', ''' || 
       replace(background, '''', '''''') || ''', ''' || 
       replace(market_start, '''', '''''') || ''', ''' || 
       replace(market_evolution, '''', '''''') || ''', ''' || 
       replace(key_turning_points, '''', '''''') || ''', ''' || 
       replace(later_outcome, '''', '''''') || ''', ''' || 
       replace(exposed_problem, '''', '''''') || ''', ''' || 
       replace(extracted_lesson, '''', '''''') || ''', ''' || 
       replace(note, '''', '''''') || ''', ' || 
       is_deleted || ', ''' || 
       created_at || ''', ''' || 
       updated_at || ''');' 
FROM market_reviews;
EOF

# 规则经验
echo "-- 规则经验" > export_rule_experiences.sql
sqlite3 "$DB_FILE" <<EOF
.mode list
.separator "|"
SELECT 'INSERT INTO rule_experiences (title, type, track, source_case, core_content, summary_conclusion, note, is_deleted, created_at, updated_at) VALUES (''' || 
       replace(title, '''', '''''') || ''', ''' || 
       replace(type, '''', '''''') || ''', ''' || 
       replace(track, '''', '''''') || ''', ''' || 
       replace(source_case, '''', '''''') || ''', ''' || 
       replace(core_content, '''', '''''') || ''', ''' || 
       replace(summary_conclusion, '''', '''''') || ''', ''' || 
       replace(note, '''', '''''') || ''', ' || 
       is_deleted || ', ''' || 
       created_at || ''', ''' || 
       updated_at || ''');' 
FROM rule_experiences;
EOF

echo "数据导出完成！"
