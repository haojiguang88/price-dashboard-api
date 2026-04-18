import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 年度计划主表相关接口

// 新增年度计划
router.post('/annual-plans', async (req, res) => {
  try {
    const db = await getDb();
    const { year, title, core_goal, overall_strategy, capital_principle, execution_principle, market_background, risk_note, status, note } = req.body;
    
    if (!year || !title) {
      return res.status(400).json({ success: false, message: '缺少必填字段: year, title' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO annual_plans (year, title, core_goal, overall_strategy, capital_principle, execution_principle, market_background, risk_note, status, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [year, title, core_goal, overall_strategy, capital_principle, execution_principle, market_background, risk_note, status, note, 0, now, now]
    );
    
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error creating annual plan:', error);
    res.status(500).json({ success: false, message: '新增年度计划失败' });
  }
});

// 获取年度计划列表
router.get('/annual-plans', async (req, res) => {
  try {
    const db = await getDb();
    const records = await db.all('SELECT * FROM annual_plans WHERE is_deleted = 0 ORDER BY year DESC, created_at DESC');
    res.json({ success: true, data: records });
  } catch (error) {
    console.error('Error getting annual plans:', error);
    res.status(500).json({ success: false, message: '获取年度计划列表失败' });
  }
});

// 获取年度计划详情
router.get('/annual-plans/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const record = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [id]);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '年度计划不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error getting annual plan:', error);
    res.status(500).json({ success: false, message: '获取年度计划详情失败' });
  }
});

// 更新年度计划
router.put('/annual-plans/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { year, title, core_goal, overall_strategy, capital_principle, execution_principle, market_background, risk_note, status, note } = req.body;
    
    if (!year || !title) {
      return res.status(400).json({ success: false, message: '缺少必填字段: year, title' });
    }
    
    const existingRecord = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '年度计划不存在' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE annual_plans SET year = ?, title = ?, core_goal = ?, overall_strategy = ?, capital_principle = ?, execution_principle = ?, market_background = ?, risk_note = ?, status = ?, note = ?, updated_at = ? WHERE id = ? AND is_deleted = 0',
      [year, title, core_goal, overall_strategy, capital_principle, execution_principle, market_background, risk_note, status, note, now, id]
    );
    
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error updating annual plan:', error);
    res.status(500).json({ success: false, message: '更新年度计划失败' });
  }
});

// 软删除年度计划
router.delete('/annual-plans/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    const existingRecord = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '年度计划不存在' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run('UPDATE annual_plans SET is_deleted = 1, updated_at = ? WHERE id = ? AND is_deleted = 0', [now, id]);
    
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting annual plan:', error);
    res.status(500).json({ success: false, message: '删除年度计划失败' });
  }
});

export default router;