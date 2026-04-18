-- 导出记录型模块数据的SQL脚本

-- 事件记录
db
.tables
.output export_event_records.sql
SELECT 'INSERT INTO event_records (title, track, event_date, event_type, description, related_object, impact, source, note, is_deleted, created_at, updated_at) VALUES ('''
       || REPLACE(title, '''', '''''') || ''', '''
       || REPLACE(track, '''', '''''') || ''', '''
       || event_date || ''', '''
       || REPLACE(event_type, '''', '''''') || ''', '''
       || REPLACE(description, '''', '''''') || ''', '''
       || REPLACE(related_object, '''', '''''') || ''', '''
       || REPLACE(impact, '''', '''''') || ''', '''
       || REPLACE(source, '''', '''''') || ''', '''
       || REPLACE(note, '''', '''''') || ''', '
       || is_deleted || ', '''
       || created_at || ''', '''
       || updated_at || ''');' 
FROM event_records;
.output stdout

-- 观点记录
.output export_opinion_records.sql
SELECT 'INSERT INTO opinion_records (title, track, person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, my_interpretation, validation_result, validation_date, person_observation, note, is_deleted, created_at, updated_at) VALUES ('''
       || REPLACE(title, '''', '''''') || ''', '''
       || REPLACE(track, '''', '''''') || ''', '''
       || REPLACE(person_name, '''', '''''') || ''', '''
       || REPLACE(source_platform, '''', '''''') || ''', '''
       || opinion_date || ''', '''
       || REPLACE(validation_status, '''', '''''') || ''', '''
       || REPLACE(summary_result, '''', '''''') || ''', '''
       || REPLACE(original_opinion, '''', '''''') || ''', '''
       || REPLACE(my_interpretation, '''', '''''') || ''', '''
       || REPLACE(validation_result, '''', '''''') || ''', '''
       || validation_date || ''', '''
       || REPLACE(person_observation, '''', '''''') || ''', '''
       || REPLACE(note, '''', '''''') || ''', '
       || is_deleted || ', '''
       || created_at || ''', '''
       || updated_at || ''');' 
FROM opinion_records;
.output stdout

-- 错过项目复盘
.output export_missed_projects.sql
SELECT 'INSERT INTO missed_projects (title, track, project_name, source, review_date, miss_type, signal, reason, trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson, note, is_deleted, created_at, updated_at) VALUES ('''
       || REPLACE(title, '''', '''''') || ''', '''
       || REPLACE(track, '''', '''''') || ''', '''
       || REPLACE(project_name, '''', '''''') || ''', '''
       || REPLACE(source, '''', '''''') || ''', '''
       || review_date || ''', '''
       || REPLACE(miss_type, '''', '''''') || ''', '''
       || REPLACE(signal, '''', '''''') || ''', '''
       || REPLACE(reason, '''', '''''') || ''', '''
       || REPLACE(trend, '''', '''''') || ''', '''
       || REPLACE(exposed_problem, '''', '''''') || ''', '''
       || REPLACE(extracted_lesson, '''', '''''') || ''', '''
       || REPLACE(summary_conclusion, '''', '''''') || ''', '''
       || REPLACE(short_lesson, '''', '''''') || ''', '''
       || REPLACE(note, '''', '''''') || ''', '
       || is_deleted || ', '''
       || created_at || ''', '''
       || updated_at || ''');' 
FROM missed_projects;
.output stdout

-- 交易复盘
.output export_trade_reviews.sql
SELECT 'INSERT INTO trade_reviews (title, track, project_name, review_date, result_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, is_deleted, created_at, updated_at) VALUES ('''
       || REPLACE(title, '''', '''''') || ''', '''
       || REPLACE(track, '''', '''''') || ''', '''
       || REPLACE(project_name, '''', '''''') || ''', '''
       || review_date || ''', '''
       || REPLACE(result_type, '''', '''''') || ''', '''
       || REPLACE(summary_conclusion, '''', '''''') || ''', '''
       || REPLACE(background, '''', '''''') || ''', '''
       || REPLACE(judgment_at_that_time, '''', '''''') || ''', '''
       || REPLACE(action_at_that_time, '''', '''''') || ''', '''
       || REPLACE(later_outcome, '''', '''''') || ''', '''
       || REPLACE(root_cause_type, '''', '''''') || ''', '''
       || REPLACE(exposed_problem, '''', '''''') || ''', '''
       || REPLACE(extracted_lesson, '''', '''''') || ''', '''
       || REPLACE(short_lesson, '''', '''''') || ''', '''
       || REPLACE(note, '''', '''''') || ''', '
       || is_deleted || ', '''
       || created_at || ''', '''
       || updated_at || ''');' 
FROM trade_reviews;
.output stdout

-- 挂树案例
.output export_tree_hanging_cases.sql
SELECT 'INSERT INTO tree_hanging_cases (title, track, project_name, review_date, tree_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, is_deleted, created_at, updated_at) VALUES ('''
       || REPLACE(title, '''', '''''') || ''', '''
       || REPLACE(track, '''', '''''') || ''', '''
       || REPLACE(project_name, '''', '''''') || ''', '''
       || review_date || ''', '''
       || REPLACE(tree_type, '''', '''''') || ''', '''
       || REPLACE(summary_conclusion, '''', '''''') || ''', '''
       || REPLACE(background, '''', '''''') || ''', '''
       || REPLACE(judgment_at_that_time, '''', '''''') || ''', '''
       || REPLACE(action_at_that_time, '''', '''''') || ''', '''
       || REPLACE(later_outcome, '''', '''''') || ''', '''
       || REPLACE(root_cause_type, '''', '''''') || ''', '''
       || REPLACE(exposed_problem, '''', '''''') || ''', '''
       || REPLACE(extracted_lesson, '''', '''''') || ''', '''
       || REPLACE(short_lesson, '''', '''''') || ''', '''
       || REPLACE(note, '''', '''''') || ''', '
       || is_deleted || ', '''
       || created_at || ''', '''
       || updated_at || ''');' 
FROM tree_hanging_cases;
.output stdout

-- 行情复盘
.output export_market_reviews.sql
SELECT 'INSERT INTO market_reviews (title, track, project_name, review_date, market_type_preset, market_type_custom, summary_conclusion, short_lesson, background, market_start, market_evolution, key_turning_points, later_outcome, exposed_problem, extracted_lesson, note, is_deleted, created_at, updated_at) VALUES ('''
       || REPLACE(title, '''', '''''') || ''', '''
       || REPLACE(track, '''', '''''') || ''', '''
       || REPLACE(project_name, '''', '''''') || ''', '''
       || review_date || ''', '''
       || REPLACE(market_type_preset, '''', '''''') || ''', '''
       || REPLACE(market_type_custom, '''', '''''') || ''', '''
       || REPLACE(summary_conclusion, '''', '''''') || ''', '''
       || REPLACE(short_lesson, '''', '''''') || ''', '''
       || REPLACE(background, '''', '''''') || ''', '''
       || REPLACE(market_start, '''', '''''') || ''', '''
       || REPLACE(market_evolution, '''', '''''') || ''', '''
       || REPLACE(key_turning_points, '''', '''''') || ''', '''
       || REPLACE(later_outcome, '''', '''''') || ''', '''
       || REPLACE(exposed_problem, '''', '''''') || ''', '''
       || REPLACE(extracted_lesson, '''', '''''') || ''', '''
       || REPLACE(note, '''', '''''') || ''', '
       || is_deleted || ', '''
       || created_at || ''', '''
       || updated_at || ''');' 
FROM market_reviews;
.output stdout

-- 规则经验
.output export_rule_experiences.sql
SELECT 'INSERT INTO rule_experiences (title, type, track, source_case, core_content, summary_conclusion, note, is_deleted, created_at, updated_at) VALUES ('''
       || REPLACE(title, '''', '''''') || ''', '''
       || REPLACE(type, '''', '''''') || ''', '''
       || REPLACE(track, '''', '''''') || ''', '''
       || REPLACE(source_case, '''', '''''') || ''', '''
       || REPLACE(core_content, '''', '''''') || ''', '''
       || REPLACE(summary_conclusion, '''', '''''') || ''', '''
       || REPLACE(note, '''', '''''') || ''', '
       || is_deleted || ', '''
       || created_at || ''', '''
       || updated_at || ''');' 
FROM rule_experiences;
.output stdout
