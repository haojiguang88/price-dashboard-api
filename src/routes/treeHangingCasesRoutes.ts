import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 挂树案例相关接口

// 新增挂树案例
router.post('/tree-hanging-cases', async (req, res) => {
  try {
    const db = await getDb();
    const { title, track, project_name, review_date, tree_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note } = req.body;
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO tree_hanging_cases (title, track, project_name, review_date, tree_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, track, project_name, review_date, tree_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, 0, now, now]
    );
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error creating tree hanging case:', error);
    res.status(500).json({ success: false, message: '新增挂树案例失败' });
  }
});

// 编辑挂树案例
router.put('/tree-hanging-cases/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { title, track, project_name, review_date, tree_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note } = req.body;
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM tree_hanging_cases WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '挂树案例不存在' });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE tree_hanging_cases SET title = ?, track = ?, project_name = ?, review_date = ?, tree_type = ?, summary_conclusion = ?, background = ?, judgment_at_that_time = ?, action_at_that_time = ?, later_outcome = ?, root_cause_type = ?, exposed_problem = ?, extracted_lesson = ?, short_lesson = ?, note = ?, updated_at = ? WHERE id = ?',
      [title, track, project_name, review_date, tree_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, now, id]
    );
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error updating tree hanging case:', error);
    res.status(500).json({ success: false, message: '编辑挂树案例失败' });
  }
});

// 删除挂树案例
router.delete('/tree-hanging-cases/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM tree_hanging_cases WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '挂树案例不存在' });
    }
    
    // 软删除记录
    const now = new Date().toISOString();
    const result = await db.run('UPDATE tree_hanging_cases SET is_deleted = 1, updated_at = ? WHERE id = ?', [now, id]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting tree hanging case:', error);
    res.status(500).json({ success: false, message: '删除挂树案例失败' });
  }
});

// 获取挂树案例列表
router.get('/tree-hanging-cases', async (req, res) => {
  try {
    const db = await getDb();
    const { track, start_date, end_date } = req.query;
    
    let query = 'SELECT id, title, track, project_name, review_date, tree_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, created_at, updated_at FROM tree_hanging_cases WHERE is_deleted = 0';
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
    console.error('Error fetching tree hanging cases:', error);
    res.status(500).json({ success: false, message: '获取挂树案例列表失败' });
  }
});

// 获取挂树案例详情
router.get('/tree-hanging-cases/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 获取记录详情
    const record = await db.get('SELECT id, title, track, project_name, review_date, tree_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, created_at, updated_at FROM tree_hanging_cases WHERE id = ? AND is_deleted = 0', [id]);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '挂树案例不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error fetching tree hanging case details:', error);
    res.status(500).json({ success: false, message: '获取挂树案例详情失败' });
  }
});

export default router;