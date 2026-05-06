import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 观点记录相关接口
const ensureOpinionPersonTables = async (db: any) => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS opinion_blocked_persons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_name TEXT NOT NULL UNIQUE,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
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
    const { title, track, person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, my_interpretation, validation_result, validation_date, person_observation, note } = req.body;
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO opinion_records (title, track, person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, my_interpretation, validation_result, validation_date, person_observation, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, track, person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, my_interpretation, validation_result, validation_date, person_observation, note, 0, now, now]
    );
    res.json({ success: true, data: { id: result.lastID } });
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
    const { title, track, person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, my_interpretation, validation_result, validation_date, person_observation, note } = req.body;
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM opinion_records WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '观点记录不存在' });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE opinion_records SET title = ?, track = ?, person_name = ?, source_platform = ?, opinion_date = ?, validation_status = ?, summary_result = ?, original_opinion = ?, my_interpretation = ?, validation_result = ?, validation_date = ?, person_observation = ?, note = ?, updated_at = ? WHERE id = ?',
      [title, track, person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, my_interpretation, validation_result, validation_date, person_observation, note, now, id]
    );
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error updating opinion record:', error);
    res.status(500).json({ success: false, message: '编辑观点记录失败' });
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
    const { q, source_platform, track, include_blocked, page = 1, pageSize = 10 } = req.query;
    
    // 构建查询条件
    let whereClause = 'is_deleted = 0';
    const params: any[] = [];
    
    // 搜索条件
    if (q) {
      whereClause += ' AND (opinion_records.person_name LIKE ? OR title LIKE ? OR original_opinion LIKE ? OR my_interpretation LIKE ? OR validation_result LIKE ? OR person_observation LIKE ? OR note LIKE ? OR source_platform LIKE ? OR track LIKE ?)';
      const searchTerm = `%${q}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    // 精确筛选条件
    if (source_platform) {
      whereClause += ' AND source_platform = ?';
      params.push(source_platform);
    }
    
    if (track) {
      whereClause += ' AND track = ?';
      params.push(track);
    }

    if (include_blocked !== '1') {
      whereClause += ' AND opinion_records.person_name NOT IN (SELECT person_name FROM opinion_blocked_persons)';
    }
    
    // 计算分页
    const pageNum = parseInt(page as string) || 1;
    const size = parseInt(pageSize as string) || 10;
    const offset = (pageNum - 1) * size;
    
    // 获取总数
    const countQuery = `SELECT COUNT(*) as total FROM opinion_records WHERE ${whereClause}`;
    const countResult = await db.get(countQuery, params);
    const total = countResult.total || 0;
    
    // 获取分页数据
    const dataQuery = `
      SELECT opinion_records.id, title, track, opinion_records.person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, my_interpretation, validation_result, validation_date, person_observation, note, opinion_records.created_at, opinion_records.updated_at,
             CASE WHEN opinion_blocked_persons.id IS NULL THEN 0 ELSE 1 END AS is_person_blocked
      FROM opinion_records
      LEFT JOIN opinion_blocked_persons ON opinion_blocked_persons.person_name = opinion_records.person_name
      WHERE ${whereClause} 
      ORDER BY opinion_records.opinion_date DESC, opinion_records.created_at DESC, opinion_records.id DESC 
      LIMIT ? OFFSET ?
    `;
    
    const dataParams = [...params, size, offset];
    const items = await db.all(dataQuery, dataParams);
    
    // 返回结果
    res.json({
      success: true,
      data: {
        items,
        total,
        page: pageNum,
        pageSize: size
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
    const record = await db.get('SELECT id, title, track, person_name, source_platform, opinion_date, validation_status, summary_result, original_opinion, my_interpretation, validation_result, validation_date, person_observation, note, created_at, updated_at FROM opinion_records WHERE id = ? AND is_deleted = 0', [id]);
    
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
