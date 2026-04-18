import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 年度计划子项变更相关接口

// 新增年度计划子项变更记录
router.post('/annual-plan-item-changes', async (req, res) => {
  try {
    const db = await getDb();
    const { plan_item_id, change_date, change_type, old_role, new_role, old_action, new_action, old_status, new_status, reason, trigger_condition, evidence_note, decision_note, next_action } = req.body;
    
    if (!plan_item_id || !change_date) {
      return res.status(400).json({ success: false, message: '缺少必填字段: plan_item_id, change_date' });
    }
    
    // 验证子项是否存在
    const itemExists = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [plan_item_id]);
    if (!itemExists) {
      return res.status(404).json({ success: false, message: '关联的年度计划子项不存在' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO annual_plan_item_changes (plan_item_id, change_date, change_type, old_role, new_role, old_action, new_action, old_status, new_status, reason, trigger_condition, evidence_note, decision_note, next_action, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [plan_item_id, change_date, change_type, old_role, new_role, old_action, new_action, old_status, new_status, reason, trigger_condition, evidence_note, decision_note, next_action, now, now]
    );
    
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error creating annual plan item change:', error);
    res.status(500).json({ success: false, message: '新增年度计划子项变更记录失败' });
  }
});

// 获取年度计划子项变更记录列表
router.get('/annual-plan-item-changes', async (req, res) => {
  try {
    const db = await getDb();
    const { plan_item_id } = req.query;
    
    let query = 'SELECT * FROM annual_plan_item_changes';
    const params: any[] = [];
    
    if (plan_item_id) {
      query += ' WHERE plan_item_id = ?';
      params.push(plan_item_id);
    }
    
    query += ' ORDER BY change_date DESC, created_at DESC';
    
    const records = await db.all(query, params);
    res.json({ success: true, data: records });
  } catch (error) {
    console.error('Error getting annual plan item changes:', error);
    res.status(500).json({ success: false, message: '获取年度计划子项变更记录列表失败' });
  }
});

// 获取年度计划子项变更记录详情
router.get('/annual-plan-item-changes/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const record = await db.get('SELECT * FROM annual_plan_item_changes WHERE id = ?', [id]);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '年度计划子项变更记录不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error getting annual plan item change:', error);
    res.status(500).json({ success: false, message: '获取年度计划子项变更记录详情失败' });
  }
});

// 更新年度计划子项变更记录
router.put('/annual-plan-item-changes/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { change_date, change_type, old_role, new_role, old_action, new_action, old_status, new_status, reason, trigger_condition, evidence_note, decision_note, next_action } = req.body;
    
    if (!change_date) {
      return res.status(400).json({ success: false, message: '缺少必填字段: change_date' });
    }
    
    // 验证记录是否存在
    const existingRecord = await db.get('SELECT * FROM annual_plan_item_changes WHERE id = ?', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '年度计划子项变更记录不存在' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE annual_plan_item_changes SET change_date = ?, change_type = ?, old_role = ?, new_role = ?, old_action = ?, new_action = ?, old_status = ?, new_status = ?, reason = ?, trigger_condition = ?, evidence_note = ?, decision_note = ?, next_action = ?, updated_at = ? WHERE id = ?',
      [change_date, change_type, old_role, new_role, old_action, new_action, old_status, new_status, reason, trigger_condition, evidence_note, decision_note, next_action, now, id]
    );
    
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error updating annual plan item change:', error);
    res.status(500).json({ success: false, message: '更新年度计划子项变更记录失败' });
  }
});

// 删除年度计划子项变更记录
router.delete('/annual-plan-item-changes/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    const existingRecord = await db.get('SELECT * FROM annual_plan_item_changes WHERE id = ?', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '年度计划子项变更记录不存在' });
    }
    
    const result = await db.run('DELETE FROM annual_plan_item_changes WHERE id = ?', [id]);
    
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting annual plan item change:', error);
    res.status(500).json({ success: false, message: '删除年度计划子项变更记录失败' });
  }
});

export default router;