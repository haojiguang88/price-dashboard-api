import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 年度计划主表相关接口
const validAnnualPlanStatuses = ['生效中', '已归档'];

const normalizeAnnualPlanOverview = (body: any) => {
  const year = Number(body.year);
  const title = String(body.title || '').trim();
  const status = String(body.status || '生效中').trim();

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { error: 'year 必须是 2000 到 2100 之间的整数' };
  }
  if (!title) {
    return { error: 'title 不能为空' };
  }
  if (!validAnnualPlanStatuses.includes(status)) {
    return { error: '年度计划状态不合法' };
  }

  return { value: { year, title, status } };
};

const archiveActiveAnnualPlansForYear = async (db: any, year: number, now: string, excludedPlanId?: number | string) => {
  let query = "UPDATE annual_plans SET status = '已归档', updated_at = ? WHERE year = ? AND status = '生效中' AND is_deleted = 0";
  const params: Array<string | number> = [now, year];
  if (excludedPlanId !== undefined) {
    query += ' AND id != ?';
    params.push(excludedPlanId);
  }
  await db.run(query, params);
};

const findCarryOverSourcePlan = async (db: any, year: number) => {
  return db.get(
    `SELECT *
     FROM annual_plans
     WHERE is_deleted = 0
       AND year < ?
     ORDER BY year DESC,
              CASE WHEN status = '生效中' THEN 0 ELSE 1 END,
              created_at DESC
     LIMIT 1`,
    [year]
  );
};

const carryOverAnnualPlanItems = async (db: any, sourcePlanId: number | string, targetPlanId: number | string, now: string) => {
  const sourceItems = await db.all(
    `SELECT scope_type,
            category,
            object_name,
            current_role,
            current_action,
            current_status,
            thesis,
            current_reason,
            position_rule,
            exit_rule,
            downgrade_reason,
            resume_condition,
            priority_order,
            note
     FROM annual_plan_items
     WHERE plan_id = ?
       AND is_deleted = 0
     ORDER BY COALESCE(priority_order, 999999), id`,
    [sourcePlanId]
  );

  for (const item of sourceItems) {
    await db.run(
      `INSERT INTO annual_plan_items (
        plan_id,
        scope_type,
        category,
        object_name,
        current_role,
        current_action,
        current_status,
        thesis,
        current_reason,
        position_rule,
        exit_rule,
        downgrade_reason,
        resume_condition,
        priority_order,
        note,
        is_deleted,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        targetPlanId,
        item.scope_type,
        item.category,
        item.object_name,
        item.current_role,
        item.current_action,
        item.current_status,
        item.thesis,
        item.current_reason,
        item.position_rule,
        item.exit_rule,
        item.downgrade_reason,
        item.resume_condition,
        item.priority_order,
        item.note,
        now,
        now
      ]
    );
  }

  return sourceItems.length;
};

// 新增年度计划
router.post('/annual-plans', async (req, res) => {
  try {
    const db = await getDb();
    const {
      core_goal,
      overall_strategy,
      capital_principle,
      execution_principle,
      market_background,
      risk_note,
      note,
      carry_over_previous_items
    } = req.body;
    const normalized = normalizeAnnualPlanOverview(req.body);
    
    if ('error' in normalized) {
      return res.status(400).json({ success: false, message: normalized.error });
    }
    
    const now = new Date().toISOString();
    await db.run('BEGIN TRANSACTION');
    let result: any;
    let createdRecord: any;
    let carryOverResult = {
      copied_items_count: 0,
      source_plan_id: null as number | string | null,
      source_year: null as number | null
    };

    try {
      if (normalized.value.status === '生效中') {
        await archiveActiveAnnualPlansForYear(db, normalized.value.year, now);
      }
      result = await db.run(
        'INSERT INTO annual_plans (year, title, core_goal, overall_strategy, capital_principle, execution_principle, market_background, risk_note, status, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [normalized.value.year, normalized.value.title, core_goal, overall_strategy, capital_principle, execution_principle, market_background, risk_note, normalized.value.status, note, 0, now, now]
      );
      if (carry_over_previous_items) {
        const sourcePlan = await findCarryOverSourcePlan(db, normalized.value.year);
        if (sourcePlan) {
          const copiedItemsCount = await carryOverAnnualPlanItems(db, sourcePlan.id, result.lastID, now);
          carryOverResult = {
            copied_items_count: copiedItemsCount,
            source_plan_id: sourcePlan.id,
            source_year: Number(sourcePlan.year)
          };
        }
      }
      createdRecord = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [result.lastID]);
      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
    
    res.json({
      success: true,
      data: {
        ...(createdRecord || { id: result.lastID }),
        carry_over: carryOverResult
      }
    });
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
    const { core_goal, overall_strategy, capital_principle, execution_principle, market_background, risk_note, note } = req.body;
    const normalized = normalizeAnnualPlanOverview(req.body);
    
    if ('error' in normalized) {
      return res.status(400).json({ success: false, message: normalized.error });
    }
    
    const existingRecord = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '年度计划不存在' });
    }
    
    const now = new Date().toISOString();
    await db.run('BEGIN TRANSACTION');
    let result: any;
    let updatedRecord: any;

    try {
      if (normalized.value.status === '生效中') {
        await archiveActiveAnnualPlansForYear(db, normalized.value.year, now, id);
      }
      result = await db.run(
        'UPDATE annual_plans SET year = ?, title = ?, core_goal = ?, overall_strategy = ?, capital_principle = ?, execution_principle = ?, market_background = ?, risk_note = ?, status = ?, note = ?, updated_at = ? WHERE id = ? AND is_deleted = 0',
        [normalized.value.year, normalized.value.title, core_goal, overall_strategy, capital_principle, execution_principle, market_background, risk_note, normalized.value.status, note, now, id]
      );
      updatedRecord = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [id]);
      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
    
    res.json({ success: true, data: { ...updatedRecord, changes: result.changes } });
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
    await db.run('BEGIN TRANSACTION');
    let result;

    try {
      result = await db.run('UPDATE annual_plans SET is_deleted = 1, updated_at = ? WHERE id = ? AND is_deleted = 0', [now, id]);
      await db.run('UPDATE annual_plan_items SET is_deleted = 1, updated_at = ? WHERE plan_id = ? AND is_deleted = 0', [now, id]);
      await db.run('COMMIT');
    } catch (error) {
      await db.run('ROLLBACK');
      throw error;
    }
    
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting annual plan:', error);
    res.status(500).json({ success: false, message: '删除年度计划失败' });
  }
});

export default router;
