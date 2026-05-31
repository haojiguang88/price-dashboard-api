import express from 'express';
import getDb from '../config/database';
import { validateOptionalDateOnly } from '../utils/dateValidation';
import { normalizeQueryText, parsePagination, toLikePattern } from '../utils/listQuery';

const router = express.Router();

// 错过项目复盘相关接口

// 新增错过项目复盘
router.post('/missed-projects', async (req, res) => {
  try {
    const db = await getDb();
    const { project_name, source, review_date, miss_type, signal, reason, trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson, note } = req.body;
    const title = normalizeQueryText(req.body?.title);
    const track = normalizeQueryText(req.body?.track);
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    const reviewDate = validateOptionalDateOnly(review_date, '复盘日期');
    if (!reviewDate.ok) {
      return res.status(400).json({ success: false, message: reviewDate.message });
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO missed_projects (title, track, project_name, source, review_date, miss_type, signal, reason, trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, track, project_name, source, reviewDate.value, miss_type, signal, reason, trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson, note, 0, now, now]
    );
    const createdRecord = await db.get(
      'SELECT id, title, track, project_name, source, review_date, miss_type, signal, reason, trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson, note, created_at, updated_at FROM missed_projects WHERE id = ? AND is_deleted = 0',
      [result.lastID]
    );
    res.json({ success: true, data: createdRecord || { id: result.lastID } });
  } catch (error) {
    console.error('Error creating missed project record:', error);
    res.status(500).json({ success: false, message: '新增错过项目复盘失败' });
  }
});

// 编辑错过项目复盘
router.put('/missed-projects/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { project_name, source, review_date, miss_type, signal, reason, trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson, note } = req.body;
    const title = normalizeQueryText(req.body?.title);
    const track = normalizeQueryText(req.body?.track);
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    const reviewDate = validateOptionalDateOnly(review_date, '复盘日期');
    if (!reviewDate.ok) {
      return res.status(400).json({ success: false, message: reviewDate.message });
    }
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM missed_projects WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '错过项目复盘不存在' });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE missed_projects SET title = ?, track = ?, project_name = ?, source = ?, review_date = ?, miss_type = ?, signal = ?, reason = ?, trend = ?, exposed_problem = ?, extracted_lesson = ?, summary_conclusion = ?, short_lesson = ?, note = ?, updated_at = ? WHERE id = ?',
      [title, track, project_name, source, reviewDate.value, miss_type, signal, reason, trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson, note, now, id]
    );
    const updatedRecord = await db.get(
      'SELECT id, title, track, project_name, source, review_date, miss_type, signal, reason, trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson, note, created_at, updated_at FROM missed_projects WHERE id = ? AND is_deleted = 0',
      [id]
    );
    res.json({ success: true, data: updatedRecord ? { ...updatedRecord, changes: result.changes } : { changes: result.changes } });
  } catch (error) {
    console.error('Error updating missed project record:', error);
    res.status(500).json({ success: false, message: '编辑错过项目复盘失败' });
  }
});

// 删除错过项目复盘
router.delete('/missed-projects/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM missed_projects WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '错过项目复盘不存在' });
    }
    
    // 软删除记录
    const now = new Date().toISOString();
    const result = await db.run('UPDATE missed_projects SET is_deleted = 1, updated_at = ? WHERE id = ?', [now, id]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting missed project record:', error);
    res.status(500).json({ success: false, message: '删除错过项目复盘失败' });
  }
});

// 获取错过项目复盘列表
router.get('/missed-projects', async (req, res) => {
  try {
    const db = await getDb();
    const { track, start_date, end_date, q, page, pageSize } = req.query;
    const trackFilter = normalizeQueryText(track);
    const keyword = normalizeQueryText(q);
    const pagination = parsePagination(page, pageSize);
    
    const selectClause = 'SELECT id, title, track, project_name, source, review_date, miss_type, signal, reason, trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson, note, created_at, updated_at FROM missed_projects';
    let whereClause = 'WHERE is_deleted = 0';
    const params: any[] = [];
    const startDate = validateOptionalDateOnly(start_date, '开始日期');
    if (!startDate.ok) {
      return res.status(400).json({ success: false, message: startDate.message });
    }
    const endDate = validateOptionalDateOnly(end_date, '结束日期');
    if (!endDate.ok) {
      return res.status(400).json({ success: false, message: endDate.message });
    }
    
    if (trackFilter) {
      whereClause += ' AND track = ?';
      params.push(trackFilter);
    }
    if (startDate.value) {
      whereClause += ' AND review_date >= ?';
      params.push(startDate.value);
    }
    if (endDate.value) {
      whereClause += ' AND review_date <= ?';
      params.push(endDate.value);
    }
    if (keyword) {
      const like = toLikePattern(keyword);
      whereClause += ' AND (title LIKE ? OR track LIKE ? OR project_name LIKE ? OR source LIKE ? OR miss_type LIKE ? OR reason LIKE ? OR summary_conclusion LIKE ? OR short_lesson LIKE ? OR note LIKE ?)';
      params.push(like, like, like, like, like, like, like, like, like);
    }
    
    const totalRow = await db.get(`SELECT COUNT(1) as total FROM missed_projects ${whereClause}`, params);
    const records = await db.all(
      `${selectClause} ${whereClause} ORDER BY review_date DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, pagination.limit, pagination.offset]
    );
    
    res.json({
      success: true,
      data: {
        items: records,
        total: Number(totalRow?.total || 0),
        page: pagination.page,
        pageSize: pagination.pageSize
      }
    });
  } catch (error) {
    console.error('Error fetching missed project records:', error);
    res.status(500).json({ success: false, message: '获取错过项目复盘列表失败' });
  }
});

// 获取错过项目复盘详情
router.get('/missed-projects/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 获取记录详情
    const record = await db.get('SELECT id, title, track, project_name, source, review_date, miss_type, signal, reason, trend, exposed_problem, extracted_lesson, summary_conclusion, short_lesson, note, created_at, updated_at FROM missed_projects WHERE id = ? AND is_deleted = 0', [id]);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '错过项目复盘不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error fetching missed project record details:', error);
    res.status(500).json({ success: false, message: '获取错过项目复盘详情失败' });
  }
});

export default router;
