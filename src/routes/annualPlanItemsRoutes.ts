import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 年度计划子项相关接口

// 新增年度计划子项
router.post('/annual-plan-items', async (req, res) => {
  try {
    const db = await getDb();
    const { plan_id, scope_type, category, object_name, current_role, current_action, current_status, thesis, current_reason, position_rule, exit_rule, downgrade_reason, resume_condition, priority_order, note } = req.body;
    
    if (!plan_id) {
      return res.status(400).json({ success: false, message: '缺少必填字段: plan_id' });
    }
    
    // 验证计划是否存在
    const planExists = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [plan_id]);
    if (!planExists) {
      return res.status(404).json({ success: false, message: '关联的年度计划不存在' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO annual_plan_items (plan_id, scope_type, category, object_name, current_role, current_action, current_status, thesis, current_reason, position_rule, exit_rule, downgrade_reason, resume_condition, priority_order, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [plan_id, scope_type, category, object_name, current_role, current_action, current_status, thesis, current_reason, position_rule, exit_rule, downgrade_reason, resume_condition, priority_order, note, 0, now, now]
    );
    
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error creating annual plan item:', error);
    res.status(500).json({ success: false, message: '新增年度计划子项失败' });
  }
});

// 获取年度计划子项列表
router.get('/annual-plan-items', async (req, res) => {
  try {
    const db = await getDb();
    const { plan_id } = req.query;
    
    let query = 'SELECT * FROM annual_plan_items WHERE is_deleted = 0';
    const params: any[] = [];
    
    if (plan_id) {
      query += ' AND plan_id = ?';
      params.push(plan_id);
    }
    
    query += ' ORDER BY priority_order ASC, created_at DESC';
    
    const records = await db.all(query, params);
    res.json({ success: true, data: records });
  } catch (error) {
    console.error('Error getting annual plan items:', error);
    res.status(500).json({ success: false, message: '获取年度计划子项列表失败' });
  }
});

// 获取年度计划子项详情
router.get('/annual-plan-items/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const record = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error getting annual plan item:', error);
    res.status(500).json({ success: false, message: '获取年度计划子项详情失败' });
  }
});

// 获取年度计划子项的变更记录
router.get('/annual-plan-items/:id/changes', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 验证子项是否存在
    const itemExists = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);
    if (!itemExists) {
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }
    
    const changes = await db.all('SELECT * FROM annual_plan_item_changes WHERE plan_item_id = ? ORDER BY change_date DESC, created_at DESC', [id]);
    res.json({ success: true, data: changes });
  } catch (error) {
    console.error('Error getting annual plan item changes:', error);
    res.status(500).json({ success: false, message: '获取年度计划子项变更记录失败' });
  }
});

// 更新年度计划子项
router.put('/annual-plan-items/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { plan_id, scope_type, category, object_name, current_role, current_action, current_status, thesis, current_reason, position_rule, exit_rule, downgrade_reason, resume_condition, priority_order, note } = req.body;
    
    if (!plan_id) {
      return res.status(400).json({ success: false, message: '缺少必填字段: plan_id' });
    }
    
    // 验证记录是否存在
    const existingRecord = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }
    
    // 验证计划是否存在
    const planExists = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [plan_id]);
    if (!planExists) {
      return res.status(404).json({ success: false, message: '关联的年度计划不存在' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE annual_plan_items SET plan_id = ?, scope_type = ?, category = ?, object_name = ?, current_role = ?, current_action = ?, current_status = ?, thesis = ?, current_reason = ?, position_rule = ?, exit_rule = ?, downgrade_reason = ?, resume_condition = ?, priority_order = ?, note = ?, updated_at = ? WHERE id = ? AND is_deleted = 0',
      [plan_id, scope_type, category, object_name, current_role, current_action, current_status, thesis, current_reason, position_rule, exit_rule, downgrade_reason, resume_condition, priority_order, note, now, id]
    );
    
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error updating annual plan item:', error);
    res.status(500).json({ success: false, message: '更新年度计划子项失败' });
  }
});

// 软删除年度计划子项
router.delete('/annual-plan-items/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    const existingRecord = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run('UPDATE annual_plan_items SET is_deleted = 1, updated_at = ? WHERE id = ? AND is_deleted = 0', [now, id]);
    
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting annual plan item:', error);
    res.status(500).json({ success: false, message: '删除年度计划子项失败' });
  }
});

export default router;