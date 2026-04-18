import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 行情复盘相关接口

// 新增行情复盘
router.post('/market-reviews', async (req, res) => {
  try {
    const db = await getDb();
    const { title, track, project_name, review_date, market_type_preset, market_type_custom, summary_conclusion, short_lesson, background, market_start, market_evolution, key_turning_points, later_outcome, exposed_problem, extracted_lesson, note } = req.body;
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO market_reviews (title, track, project_name, review_date, market_type_preset, market_type_custom, summary_conclusion, short_lesson, background, market_start, market_evolution, key_turning_points, later_outcome, exposed_problem, extracted_lesson, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, track, project_name, review_date, market_type_preset, market_type_custom, summary_conclusion, short_lesson, background, market_start, market_evolution, key_turning_points, later_outcome, exposed_problem, extracted_lesson, note, 0, now, now]
    );
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error creating market review:', error);
    res.status(500).json({ success: false, message: '新增行情复盘失败' });
  }
});

// 编辑行情复盘
router.put('/market-reviews/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { title, track, project_name, review_date, market_type_preset, market_type_custom, summary_conclusion, short_lesson, background, market_start, market_evolution, key_turning_points, later_outcome, exposed_problem, extracted_lesson, note } = req.body;
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM market_reviews WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '行情复盘不存在' });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE market_reviews SET title = ?, track = ?, project_name = ?, review_date = ?, market_type_preset = ?, market_type_custom = ?, summary_conclusion = ?, short_lesson = ?, background = ?, market_start = ?, market_evolution = ?, key_turning_points = ?, later_outcome = ?, exposed_problem = ?, extracted_lesson = ?, note = ?, updated_at = ? WHERE id = ?',
      [title, track, project_name, review_date, market_type_preset, market_type_custom, summary_conclusion, short_lesson, background, market_start, market_evolution, key_turning_points, later_outcome, exposed_problem, extracted_lesson, note, now, id]
    );
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error updating market review:', error);
    res.status(500).json({ success: false, message: '编辑行情复盘失败' });
  }
});

// 删除行情复盘
router.delete('/market-reviews/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM market_reviews WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '行情复盘不存在' });
    }
    
    // 软删除记录
    const now = new Date().toISOString();
    const result = await db.run('UPDATE market_reviews SET is_deleted = 1, updated_at = ? WHERE id = ?', [now, id]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting market review:', error);
    res.status(500).json({ success: false, message: '删除行情复盘失败' });
  }
});

// 获取行情复盘列表
router.get('/market-reviews', async (req, res) => {
  try {
    const db = await getDb();
    const { track, start_date, end_date } = req.query;
    
    let query = 'SELECT id, title, track, project_name, review_date, market_type_preset, market_type_custom, summary_conclusion, short_lesson, background, market_start, market_evolution, key_turning_points, later_outcome, exposed_problem, extracted_lesson, note, created_at, updated_at FROM market_reviews WHERE is_deleted = 0';
    const params: any[] = [];
    
    if (track || start_date || end_date) {
      if (track) {
        query += ' AND track = ?';
        params.push(track);
      }
      if (start_date) {
        query += ' AND review_date >= ?';
        params.push(start_date);
      }
      if (end_date) {
        query += ' AND review_date <= ?';
        params.push(end_date);
      }
    }
    
    query += ' ORDER BY review_date DESC, created_at DESC, id DESC';
    
    const records = await db.all(query, params);
    res.json({ success: true, data: records });
  } catch (error) {
    console.error('Error fetching market reviews:', error);
    res.status(500).json({ success: false, message: '获取行情复盘列表失败' });
  }
});

// 获取行情复盘详情
router.get('/market-reviews/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 获取记录详情
    const record = await db.get('SELECT id, title, track, project_name, review_date, market_type_preset, market_type_custom, summary_conclusion, short_lesson, background, market_start, market_evolution, key_turning_points, later_outcome, exposed_problem, extracted_lesson, note, created_at, updated_at FROM market_reviews WHERE id = ? AND is_deleted = 0', [id]);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '行情复盘不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error fetching market review details:', error);
    res.status(500).json({ success: false, message: '获取行情复盘详情失败' });
  }
});

export default router;