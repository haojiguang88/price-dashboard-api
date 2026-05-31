import express from 'express';
import getDb from '../config/database';
import { validateActiveMasterTargetByNames } from '../utils/masterData';
import { isValidDateOnly } from '../utils/dateValidation';

const router = express.Router();

// 年度计划子项相关接口
const validScopeTypes = ['赛道', '品类', '对象'];
const validRoles = ['主线', '次主线', '观察', '试错', '禁区'];
const validActions = ['主做', '轻仓参与', '只观察', '快进快出', '暂停', '不碰'];
const validStatuses = ['生效中', '已降级', '已停用', '已替换'];

const normalizePriorityOrder = (value: unknown) => {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: null as number | null };
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, value: null as number | null };
  }

  return { ok: true, value: parsed };
};

const normalizeAnnualPlanItemPayload = async (db: any, body: any) => {
  const scopeType = String(body.scope_type || '').trim();
  const category = String(body.category || '').trim();
  const objectName = String(body.object_name || '').trim();
  const currentRole = String(body.current_role || '').trim();
  const currentAction = String(body.current_action || '').trim();
  const currentStatus = String(body.current_status || '').trim();

  if (!validScopeTypes.includes(scopeType)) {
    return { error: '范围类型不合法' };
  }
  if (!category) {
    return { error: '品类不能为空' };
  }
  if (!validRoles.includes(currentRole)) {
    return { error: '当前角色不合法' };
  }
  if (!validActions.includes(currentAction)) {
    return { error: '当前动作不合法' };
  }
  if (!validStatuses.includes(currentStatus)) {
    return { error: '当前状态不合法' };
  }

  if (scopeType === '品类') {
    const categoryRecord = await db.get(
      'SELECT name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0',
      [category]
    );
    if (!categoryRecord) {
      return { error: '品类不存在或已归档' };
    }
    return { value: { scopeType, category: categoryRecord.name, objectName: '', currentRole, currentAction, currentStatus } };
  }

  if (scopeType === '对象') {
    if (!objectName) {
      return { error: '对象范围必须填写对象名称' };
    }
    const masterTarget = await validateActiveMasterTargetByNames(db, category, objectName);
    if (!masterTarget.ok) {
      return { error: masterTarget.message };
    }
    return {
      value: {
        scopeType,
        category: masterTarget.target.category_name,
        objectName: masterTarget.target.object_name,
        currentRole,
        currentAction,
        currentStatus
      }
    };
  }

  return { value: { scopeType, category, objectName, currentRole, currentAction, currentStatus } };
};

const rolePriority = ['主线', '次主线', '观察', '试错', '禁区'];
const actionPriority = ['主做', '轻仓参与', '快进快出', '只观察', '暂停', '不碰'];

const inferAnnualPlanChangeType = (existingRecord: any, normalizedItem: any) => {
  if (existingRecord.current_status !== normalizedItem.currentStatus) {
    if (normalizedItem.currentStatus === '已降级') return '降级';
    if (normalizedItem.currentStatus === '已停用') return '暂停';
    if (
      normalizedItem.currentStatus === '生效中' &&
      ['已降级', '已停用'].includes(existingRecord.current_status)
    ) {
      return '恢复';
    }
    return '状态调整';
  }

  if (existingRecord.current_role !== normalizedItem.currentRole) {
    const oldRoleIndex = rolePriority.indexOf(existingRecord.current_role);
    const newRoleIndex = rolePriority.indexOf(normalizedItem.currentRole);
    if (oldRoleIndex >= 0 && newRoleIndex >= 0) {
      if (newRoleIndex > oldRoleIndex) return '降级';
      if (newRoleIndex < oldRoleIndex) return '升级';
    }
    return '修正';
  }

  if (existingRecord.current_action !== normalizedItem.currentAction) {
    const oldActionIndex = actionPriority.indexOf(existingRecord.current_action);
    const newActionIndex = actionPriority.indexOf(normalizedItem.currentAction);
    if (oldActionIndex >= 0 && newActionIndex >= 0) {
      if (newActionIndex > oldActionIndex) return '降级';
      if (newActionIndex < oldActionIndex) return '升级';
    }
    return '修正';
  }

  return '状态调整';
};

// 新增年度计划子项
router.post('/annual-plan-items', async (req, res) => {
  try {
    const db = await getDb();
    const { plan_id, thesis, current_reason, position_rule, exit_rule, downgrade_reason, resume_condition, priority_order, note } = req.body;
    
    if (!plan_id) {
      return res.status(400).json({ success: false, message: '缺少必填字段: plan_id' });
    }
    
    // 验证计划是否存在
    const planExists = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [plan_id]);
    if (!planExists) {
      return res.status(404).json({ success: false, message: '关联的年度计划不存在' });
    }

    const normalizedPriorityOrder = normalizePriorityOrder(priority_order);
    if (!normalizedPriorityOrder.ok) {
      return res.status(400).json({ success: false, message: '优先级必须是正整数或留空' });
    }

    const normalizedItem = await normalizeAnnualPlanItemPayload(db, req.body);
    if ('error' in normalizedItem) {
      return res.status(400).json({ success: false, message: normalizedItem.error });
    }
    
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO annual_plan_items (plan_id, scope_type, category, object_name, current_role, current_action, current_status, thesis, current_reason, position_rule, exit_rule, downgrade_reason, resume_condition, priority_order, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        plan_id,
        normalizedItem.value.scopeType,
        normalizedItem.value.category,
        normalizedItem.value.objectName,
        normalizedItem.value.currentRole,
        normalizedItem.value.currentAction,
        normalizedItem.value.currentStatus,
        thesis,
        current_reason,
        position_rule,
        exit_rule,
        downgrade_reason,
        resume_condition,
        normalizedPriorityOrder.value,
        note,
        0,
        now,
        now
      ]
    );
    const createdRecord = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [result.lastID]);
    
    res.json({ success: true, data: createdRecord || { id: result.lastID } });
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
    
    query += ' ORDER BY CASE WHEN priority_order IS NULL THEN 1 ELSE 0 END, priority_order ASC, created_at DESC';
    
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
  let db: any;
  let transactionStarted = false;
  try {
    db = await getDb();
    const { id } = req.params;
    const body = req.body || {};
    
    // 验证记录是否存在
    const existingRecord = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }

    const pickValue = (key: string, fallback: any) => (
      Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
    );
    const planId = pickValue('plan_id', existingRecord.plan_id);
    if (planId === undefined || planId === null || String(planId).trim() === '') {
      return res.status(400).json({ success: false, message: '缺少必填字段: plan_id' });
    }
    
    // 验证计划是否存在
    const planExists = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [planId]);
    if (!planExists) {
      return res.status(404).json({ success: false, message: '关联的年度计划不存在' });
    }

    const mergedItemPayload = {
      scope_type: pickValue('scope_type', existingRecord.scope_type),
      category: pickValue('category', existingRecord.category),
      object_name: pickValue('object_name', existingRecord.object_name),
      current_role: pickValue('current_role', existingRecord.current_role),
      current_action: pickValue('current_action', existingRecord.current_action),
      current_status: pickValue('current_status', existingRecord.current_status)
    };
    const thesisValue = pickValue('thesis', existingRecord.thesis);
    const currentReasonValue = pickValue('current_reason', existingRecord.current_reason);
    const positionRuleValue = pickValue('position_rule', existingRecord.position_rule);
    const exitRuleValue = pickValue('exit_rule', existingRecord.exit_rule);
    const downgradeReasonValue = pickValue('downgrade_reason', existingRecord.downgrade_reason);
    const resumeConditionValue = pickValue('resume_condition', existingRecord.resume_condition);
    const noteValue = pickValue('note', existingRecord.note);

    const normalizedPriorityOrder = normalizePriorityOrder(pickValue('priority_order', existingRecord.priority_order));
    if (!normalizedPriorityOrder.ok) {
      return res.status(400).json({ success: false, message: '优先级必须是正整数或留空' });
    }

    const normalizedItem = await normalizeAnnualPlanItemPayload(db, mergedItemPayload);
    if ('error' in normalizedItem) {
      return res.status(400).json({ success: false, message: normalizedItem.error });
    }
    
    const roleChanged = existingRecord.current_role !== normalizedItem.value.currentRole;
    const actionChanged = existingRecord.current_action !== normalizedItem.value.currentAction;
    const statusChanged = existingRecord.current_status !== normalizedItem.value.currentStatus;
    const shouldCreateChangeRecord = Boolean(roleChanged || actionChanged || statusChanged);
    const changeRecord = req.body?.adjustment_record ?? {};
    const changeDate = String(changeRecord.change_date || new Date().toISOString().slice(0, 10)).trim();
    if (shouldCreateChangeRecord && !isValidDateOnly(changeDate)) {
      return res.status(400).json({ success: false, message: '变更日期格式错误' });
    }

    const now = new Date().toISOString();
    await db.run('BEGIN TRANSACTION');
    transactionStarted = true;
    const result = await db.run(
      'UPDATE annual_plan_items SET plan_id = ?, scope_type = ?, category = ?, object_name = ?, current_role = ?, current_action = ?, current_status = ?, thesis = ?, current_reason = ?, position_rule = ?, exit_rule = ?, downgrade_reason = ?, resume_condition = ?, priority_order = ?, note = ?, updated_at = ? WHERE id = ? AND is_deleted = 0',
      [
        planId,
        normalizedItem.value.scopeType,
        normalizedItem.value.category,
        normalizedItem.value.objectName,
        normalizedItem.value.currentRole,
        normalizedItem.value.currentAction,
        normalizedItem.value.currentStatus,
        thesisValue,
        currentReasonValue,
        positionRuleValue,
        exitRuleValue,
        downgradeReasonValue,
        resumeConditionValue,
        normalizedPriorityOrder.value,
        noteValue,
        now,
        id
      ]
    );

    if ((result.changes ?? 0) === 0) {
      await db.run('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }

    if (shouldCreateChangeRecord) {
      await db.run(
        `INSERT INTO annual_plan_item_changes (
          plan_item_id, change_date, change_type,
          old_role, new_role, old_action, new_action, old_status, new_status,
          reason, trigger_condition, evidence_note, decision_note, next_action,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          changeDate,
          changeRecord.change_type || inferAnnualPlanChangeType(existingRecord, normalizedItem.value),
          existingRecord.current_role,
          normalizedItem.value.currentRole,
          existingRecord.current_action,
          normalizedItem.value.currentAction,
          existingRecord.current_status,
          normalizedItem.value.currentStatus,
          changeRecord.reason ?? currentReasonValue ?? '',
          changeRecord.trigger_condition ?? '',
          changeRecord.evidence_note ?? '',
          changeRecord.decision_note ?? '',
          changeRecord.next_action ?? '',
          now,
          now
        ]
      );
    }

    await db.run('COMMIT');
    transactionStarted = false;

    const updatedRecord = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);
    
    res.json({ success: true, data: updatedRecord });
  } catch (error) {
    if (transactionStarted && db) {
      try {
        await db.run('ROLLBACK');
      } catch (rollbackError) {
        console.error('Error rolling back annual plan item update:', rollbackError);
      }
    }
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
