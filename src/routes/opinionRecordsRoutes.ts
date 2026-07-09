import express from 'express';
import getDb from '../config/database';
import { validateOptionalDateOnly } from '../utils/dateValidation';
import { normalizeQueryText, parsePagination, toLikePattern } from '../utils/listQuery';

const router = express.Router();

const ensureColumns = async (db: any, tableName: string, columnDefinitions: Record<string, string>) => {
  const table = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
  if (!table) return;
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  const existingColumns = new Set(columns.map((column: any) => column.name));
  for (const [columnName, columnDefinition] of Object.entries(columnDefinitions)) {
    if (!existingColumns.has(columnName)) {
      await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
    }
  }
};

// 观点记录相关接口
const ensureOpinionPersonTables = async (db: any) => {
  await ensureColumns(db, 'opinion_records', {
    judgment_basis: 'TEXT',
    validation_note: 'TEXT'
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS opinion_blocked_persons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_name TEXT NOT NULL UNIQUE,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`
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
    )
  `);

  await ensureColumns(db, 'opinion_person_profiles', {
    display_order: 'INTEGER',
    skill_tags: 'TEXT',
    weak_tags: 'TEXT',
    credibility_basis: 'TEXT',
    ability_scores: 'TEXT',
    behavior_strengths: 'TEXT',
    behavior_biases: 'TEXT',
    error_handling: 'TEXT'
  });
  await db.exec('CREATE INDEX IF NOT EXISTS idx_opinion_person_profiles_order ON opinion_person_profiles(display_order, person_name)');
};

const normalizeCredibilityRating = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(5, Math.trunc(parsed)));
};

const normalizeText = (value: unknown) => String(value || '').trim();

const normalizeJsonText = (value: unknown) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  return JSON.stringify(value);
};

router.use(async (_req, _res, next) => {
  try {
    const db = await getDb();
    await ensureOpinionPersonTables(db);
    next();
  } catch (error) {
    next(error);
  }
});

// 新增观点记录
router.post('/opinions', async (req, res) => {
  try {
    const db = await getDb();
    const { person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, my_interpretation, validation_result, validation_date, person_observation, note } = req.body;
    const title = normalizeQueryText(req.body?.title);
    const track = normalizeQueryText(req.body?.track);
    const judgmentBasis = normalizeText(req.body?.judgment_basis);
    const validationNote = normalizeText(req.body?.validation_note);
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    const opinionDate = validateOptionalDateOnly(opinion_date, '观点日期');
    if (!opinionDate.ok) {
      return res.status(400).json({ success: false, message: opinionDate.message });
    }
    const validationDate = validateOptionalDateOnly(validation_date, '验证日期');
    if (!validationDate.ok) {
      return res.status(400).json({ success: false, message: validationDate.message });
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO opinion_records (title, track, person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, judgment_basis, my_interpretation, validation_result, validation_note, validation_date, person_observation, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, track, person_name, source_platform, opinionDate.value, validation_status, summary_result, original_opinion, judgmentBasis, my_interpretation, validation_result, validationNote, validationDate.value, person_observation, note, 0, now, now]
    );
    const createdRecord = await db.get(
      'SELECT id, title, track, person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, judgment_basis, my_interpretation, validation_result, validation_note, validation_date, person_observation, note, created_at, updated_at FROM opinion_records WHERE id = ? AND is_deleted = 0',
      [result.lastID]
    );
    res.json({ success: true, data: createdRecord || { id: result.lastID } });
  } catch (error) {
    console.error('Error creating opinion record:', error);
    res.status(500).json({ success: false, message: '新增观点记录失败' });
  }
});

// 编辑观点记录
router.put('/opinions/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, my_interpretation, validation_result, validation_date, person_observation, note } = req.body;
    const title = normalizeQueryText(req.body?.title);
    const track = normalizeQueryText(req.body?.track);
    const judgmentBasis = normalizeText(req.body?.judgment_basis);
    const validationNote = normalizeText(req.body?.validation_note);
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    const opinionDate = validateOptionalDateOnly(opinion_date, '观点日期');
    if (!opinionDate.ok) {
      return res.status(400).json({ success: false, message: opinionDate.message });
    }
    const validationDate = validateOptionalDateOnly(validation_date, '验证日期');
    if (!validationDate.ok) {
      return res.status(400).json({ success: false, message: validationDate.message });
    }
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM opinion_records WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '观点记录不存在' });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE opinion_records SET title = ?, track = ?, person_name = ?, source_platform = ?, opinion_date = ?, validation_status = ?, summary_result = ?, original_opinion = ?, judgment_basis = ?, my_interpretation = ?, validation_result = ?, validation_note = ?, validation_date = ?, person_observation = ?, note = ?, updated_at = ? WHERE id = ?',
      [title, track, person_name, source_platform, opinionDate.value, validation_status, summary_result, original_opinion, judgmentBasis, my_interpretation, validation_result, validationNote, validationDate.value, person_observation, note, now, id]
    );
    const updatedRecord = await db.get(
      'SELECT id, title, track, person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, judgment_basis, my_interpretation, validation_result, validation_note, validation_date, person_observation, note, created_at, updated_at FROM opinion_records WHERE id = ? AND is_deleted = 0',
      [id]
    );
    res.json({ success: true, data: updatedRecord ? { ...updatedRecord, changes: result.changes } : { changes: result.changes } });
  } catch (error) {
    console.error('Error updating opinion record:', error);
    res.status(500).json({ success: false, message: '编辑观点记录失败' });
  }
});

// 编辑人物档案
router.put('/opinions/persons/:personName/profile', async (req, res) => {
  try {
    const db = await getDb();
    const personName = decodeURIComponent(req.params.personName || '').trim();
    if (!personName) {
      return res.status(400).json({ success: false, message: '人物名称不能为空' });
    }

    const existingProfile = await db.get(
      'SELECT profile_intro, credibility_rating, display_order, skill_tags, weak_tags, credibility_basis, ability_scores, behavior_strengths, behavior_biases, error_handling FROM opinion_person_profiles WHERE person_name = ?',
      [personName]
    );
    const profileIntro = req.body?.profile_intro !== undefined
      ? String(req.body.profile_intro || '').trim()
      : existingProfile?.profile_intro || '';
    const credibilityRating = req.body?.credibility_rating !== undefined
      ? normalizeCredibilityRating(req.body.credibility_rating)
      : normalizeCredibilityRating(existingProfile?.credibility_rating);
    const skillTags = req.body?.skill_tags !== undefined ? normalizeJsonText(req.body.skill_tags) : existingProfile?.skill_tags || '';
    const weakTags = req.body?.weak_tags !== undefined ? normalizeJsonText(req.body.weak_tags) : existingProfile?.weak_tags || '';
    const credibilityBasis = req.body?.credibility_basis !== undefined ? normalizeText(req.body.credibility_basis) : existingProfile?.credibility_basis || '';
    const abilityScores = req.body?.ability_scores !== undefined ? normalizeJsonText(req.body.ability_scores) : existingProfile?.ability_scores || '';
    const behaviorStrengths = req.body?.behavior_strengths !== undefined ? normalizeText(req.body.behavior_strengths) : existingProfile?.behavior_strengths || '';
    const behaviorBiases = req.body?.behavior_biases !== undefined ? normalizeText(req.body.behavior_biases) : existingProfile?.behavior_biases || '';
    const errorHandling = req.body?.error_handling !== undefined ? normalizeText(req.body.error_handling) : existingProfile?.error_handling || '';
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO opinion_person_profiles (person_name, profile_intro, credibility_rating, skill_tags, weak_tags, credibility_basis, ability_scores, behavior_strengths, behavior_biases, error_handling, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(person_name) DO UPDATE SET
         profile_intro = excluded.profile_intro,
         credibility_rating = excluded.credibility_rating,
         skill_tags = excluded.skill_tags,
         weak_tags = excluded.weak_tags,
         credibility_basis = excluded.credibility_basis,
         ability_scores = excluded.ability_scores,
         behavior_strengths = excluded.behavior_strengths,
         behavior_biases = excluded.behavior_biases,
         error_handling = excluded.error_handling,
         updated_at = excluded.updated_at`,
      [personName, profileIntro, credibilityRating, skillTags, weakTags, credibilityBasis, abilityScores, behaviorStrengths, behaviorBiases, errorHandling, now, now]
    );

    const savedProfile = await db.get(
      'SELECT person_name, profile_intro, credibility_rating, display_order, skill_tags, weak_tags, credibility_basis, ability_scores, behavior_strengths, behavior_biases, error_handling, created_at, updated_at FROM opinion_person_profiles WHERE person_name = ?',
      [personName]
    );
    res.json({ success: true, data: savedProfile });
  } catch (error) {
    console.error('Error updating opinion person profile:', error);
    res.status(500).json({ success: false, message: '编辑人物档案失败' });
  }
});

// 保存人物卡片排序
router.put('/opinions/persons/order', async (req, res) => {
  const db = await getDb();
  const rawPersonNames = Array.isArray(req.body?.person_names) ? req.body.person_names : [];
  const personNames = rawPersonNames
    .map((name: unknown) => String(name || '').trim())
    .filter(Boolean);

  if (personNames.length === 0) {
    return res.status(400).json({ success: false, message: '人物排序不能为空' });
  }

  const uniquePersonNames = Array.from(new Set(personNames));
  const now = new Date().toISOString();

  try {
    await db.exec('BEGIN');
    for (const [index, personName] of uniquePersonNames.entries()) {
      await db.run(
        `INSERT INTO opinion_person_profiles (person_name, display_order, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(person_name) DO UPDATE SET
           display_order = excluded.display_order,
           updated_at = excluded.updated_at`,
        [personName, index + 1, now, now]
      );
    }
    await db.exec('COMMIT');
    res.json({ success: true, data: { person_names: uniquePersonNames } });
  } catch (error) {
    await db.exec('ROLLBACK');
    console.error('Error updating opinion person order:', error);
    res.status(500).json({ success: false, message: '保存人物排序失败' });
  }
});

// 删除观点记录
router.delete('/opinions/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM opinion_records WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '观点记录不存在' });
    }
    
    // 软删除记录
    const now = new Date().toISOString();
    const result = await db.run('UPDATE opinion_records SET is_deleted = 1, updated_at = ? WHERE id = ?', [now, id]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting opinion record:', error);
    res.status(500).json({ success: false, message: '删除观点记录失败' });
  }
});

// 拉黑人物
router.post('/opinions/persons/:personName/block', async (req, res) => {
  try {
    const db = await getDb();
    const personName = decodeURIComponent(req.params.personName || '').trim();
    const reason = req.body?.reason || '';
    if (!personName) {
      return res.status(400).json({ success: false, message: '人物名称不能为空' });
    }

    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO opinion_blocked_persons (person_name, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(person_name) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at`,
      [personName, reason, now, now]
    );
    res.json({ success: true, data: { person_name: personName } });
  } catch (error) {
    console.error('Error blocking opinion person:', error);
    res.status(500).json({ success: false, message: '拉黑人物失败' });
  }
});

// 取消拉黑人物
router.delete('/opinions/persons/:personName/block', async (req, res) => {
  try {
    const db = await getDb();
    const personName = decodeURIComponent(req.params.personName || '').trim();
    if (!personName) {
      return res.status(400).json({ success: false, message: '人物名称不能为空' });
    }

    const result = await db.run('DELETE FROM opinion_blocked_persons WHERE person_name = ?', [personName]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error unblocking opinion person:', error);
    res.status(500).json({ success: false, message: '取消拉黑失败' });
  }
});

// 删除人物的全部观点
router.delete('/opinions/persons/:personName', async (req, res) => {
  try {
    const db = await getDb();
    const personName = decodeURIComponent(req.params.personName || '').trim();
    if (!personName) {
      return res.status(400).json({ success: false, message: '人物名称不能为空' });
    }

    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE opinion_records SET is_deleted = 1, updated_at = ? WHERE person_name = ? AND is_deleted = 0',
      [now, personName]
    );
    await db.run('DELETE FROM opinion_blocked_persons WHERE person_name = ?', [personName]);
    await db.run('DELETE FROM opinion_person_profiles WHERE person_name = ?', [personName]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting opinion person:', error);
    res.status(500).json({ success: false, message: '删除人物失败' });
  }
});

// 获取观点记录列表
router.get('/opinions', async (req, res) => {
  try {
    const db = await getDb();
    const { q, source_platform, track, include_blocked, page, pageSize } = req.query;
    const keyword = normalizeQueryText(q);
    const sourcePlatformFilter = normalizeQueryText(source_platform);
    const trackFilter = normalizeQueryText(track);
    const pagination = parsePagination(page, pageSize);
    
    // 构建查询条件
    let whereClause = 'opinion_records.is_deleted = 0';
    const params: any[] = [];
    
    // 搜索条件
    if (keyword) {
      whereClause += ' AND (opinion_records.person_name LIKE ? OR title LIKE ? OR original_opinion LIKE ? OR judgment_basis LIKE ? OR my_interpretation LIKE ? OR validation_result LIKE ? OR validation_note LIKE ? OR person_observation LIKE ? OR opinion_person_profiles.profile_intro LIKE ? OR opinion_person_profiles.skill_tags LIKE ? OR opinion_person_profiles.weak_tags LIKE ? OR opinion_person_profiles.credibility_basis LIKE ? OR opinion_person_profiles.ability_scores LIKE ? OR opinion_person_profiles.behavior_strengths LIKE ? OR opinion_person_profiles.behavior_biases LIKE ? OR opinion_person_profiles.error_handling LIKE ? OR note LIKE ? OR source_platform LIKE ? OR track LIKE ?)';
      const searchTerm = toLikePattern(keyword);
      params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    // 精确筛选条件
    if (sourcePlatformFilter) {
      whereClause += ' AND source_platform = ?';
      params.push(sourcePlatformFilter);
    }
    
    if (trackFilter) {
      whereClause += ' AND track = ?';
      params.push(trackFilter);
    }

    if (include_blocked !== '1') {
      whereClause += ' AND opinion_records.person_name NOT IN (SELECT person_name FROM opinion_blocked_persons)';
    }
    
    // 获取总数
    const countQuery = `
      SELECT COUNT(*) as total
      FROM opinion_records
      LEFT JOIN opinion_person_profiles ON opinion_person_profiles.person_name = opinion_records.person_name
      WHERE ${whereClause}
    `;
    const countResult = await db.get(countQuery, params);
    const total = countResult.total || 0;
    
    // 获取分页数据
    const dataQuery = `
      SELECT opinion_records.id, title, track, opinion_records.person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, judgment_basis, my_interpretation, validation_result, validation_note, validation_date, person_observation, note, opinion_records.created_at, opinion_records.updated_at,
             opinion_person_profiles.profile_intro, opinion_person_profiles.credibility_rating, opinion_person_profiles.display_order,
             opinion_person_profiles.skill_tags, opinion_person_profiles.weak_tags, opinion_person_profiles.credibility_basis, opinion_person_profiles.ability_scores,
             opinion_person_profiles.behavior_strengths, opinion_person_profiles.behavior_biases, opinion_person_profiles.error_handling,
             CASE WHEN opinion_blocked_persons.id IS NULL THEN 0 ELSE 1 END AS is_person_blocked
      FROM opinion_records
      LEFT JOIN opinion_blocked_persons ON opinion_blocked_persons.person_name = opinion_records.person_name
      LEFT JOIN opinion_person_profiles ON opinion_person_profiles.person_name = opinion_records.person_name
      WHERE ${whereClause} 
      ORDER BY opinion_records.opinion_date DESC, opinion_records.created_at DESC, opinion_records.id DESC 
      LIMIT ? OFFSET ?
    `;
    
    const dataParams = [...params, pagination.limit, pagination.offset];
    const items = await db.all(dataQuery, dataParams);
    
    // 返回结果
    res.json({
      success: true,
      data: {
        items,
        total,
        page: pagination.page,
        pageSize: pagination.pageSize
      }
    });
  } catch (error) {
    console.error('Error fetching opinion records:', error);
    res.status(500).json({ success: false, message: '获取观点记录列表失败' });
  }
});

// 获取观点记录详情
router.get('/opinions/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 获取记录详情
    const record = await db.get(`
      SELECT opinion_records.id, title, track, opinion_records.person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, judgment_basis, my_interpretation, validation_result, validation_note, validation_date, person_observation, note, opinion_records.created_at, opinion_records.updated_at,
             opinion_person_profiles.profile_intro, opinion_person_profiles.credibility_rating, opinion_person_profiles.display_order,
             opinion_person_profiles.skill_tags, opinion_person_profiles.weak_tags, opinion_person_profiles.credibility_basis, opinion_person_profiles.ability_scores,
             opinion_person_profiles.behavior_strengths, opinion_person_profiles.behavior_biases, opinion_person_profiles.error_handling,
             CASE WHEN opinion_blocked_persons.id IS NULL THEN 0 ELSE 1 END AS is_person_blocked
      FROM opinion_records
      LEFT JOIN opinion_person_profiles ON opinion_person_profiles.person_name = opinion_records.person_name
      LEFT JOIN opinion_blocked_persons ON opinion_blocked_persons.person_name = opinion_records.person_name
      WHERE opinion_records.id = ? AND opinion_records.is_deleted = 0
    `, [id]);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '观点记录不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error fetching opinion record details:', error);
    res.status(500).json({ success: false, message: '获取观点记录详情失败' });
  }
});

export default router;
