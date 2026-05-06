import express from 'express';
import getDb from '../config/database';

const router = express.Router();

type PlanKind = 'buying' | 'selling';

interface PlanConfig {
  kind: PlanKind;
  endpoint: string;
  tableName: string;
  label: string;
}

interface PlanBatchInput {
  id?: string;
  target_price?: number | string;
  plan_quantity?: number | string;
  completed_quantity?: number | string;
  note?: string;
}

interface PlanBatch {
  id: string;
  target_price: number;
  plan_quantity: number;
  completed_quantity: number;
  remaining_quantity: number;
  amount: number;
  status: string;
  note: string;
}

const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];

const planConfigs: PlanConfig[] = [
  { kind: 'buying', endpoint: 'buying-plans', tableName: 'buying_plans', label: '买入计划' },
  { kind: 'selling', endpoint: 'selling-plans', tableName: 'selling_plans', label: '卖出计划' }
];

const toNumber = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : NaN;
};

const roundNumber = (value: number): number => Math.round(value * 10000) / 10000;

const deriveBatchStatus = (completedQuantity: number, planQuantity: number): string => {
  if (completedQuantity <= 0) return 'pending';
  if (completedQuantity >= planQuantity) return 'completed';
  return 'in_progress';
};

const normalizeBatches = (
  rawBatches: unknown,
  fallbackPrice: unknown,
  fallbackQuantity: unknown,
  fallbackStatus = 'pending'
): { batches: PlanBatch[]; error?: string } => {
  const inputBatches = Array.isArray(rawBatches) && rawBatches.length > 0
    ? rawBatches as PlanBatchInput[]
    : [{
        id: undefined,
        target_price: fallbackPrice,
        plan_quantity: fallbackQuantity,
        completed_quantity: fallbackStatus === 'completed' ? fallbackQuantity : 0,
        note: ''
      } as PlanBatchInput];

  if (!inputBatches.length) {
    return { batches: [], error: '至少需要 1 个计划批次' };
  }

  const batches: PlanBatch[] = [];
  for (let index = 0; index < inputBatches.length; index += 1) {
    const item = inputBatches[index] || {};
    const targetPrice = toNumber(item.target_price);
    const planQuantity = toNumber(item.plan_quantity);
    const completedQuantity = toNumber(item.completed_quantity);

    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      return { batches: [], error: `第 ${index + 1} 个批次的目标价格必须大于 0` };
    }
    if (!Number.isFinite(planQuantity) || planQuantity <= 0) {
      return { batches: [], error: `第 ${index + 1} 个批次的计划数量必须大于 0` };
    }
    if (!Number.isFinite(completedQuantity) || completedQuantity < 0) {
      return { batches: [], error: `第 ${index + 1} 个批次的已完成数量不能小于 0` };
    }
    if (completedQuantity > planQuantity) {
      return { batches: [], error: `第 ${index + 1} 个批次的已完成数量不能超过计划数量` };
    }

    const normalizedCompleted = roundNumber(completedQuantity);
    const normalizedQuantity = roundNumber(planQuantity);
    batches.push({
      id: item.id ? String(item.id) : `batch-${Date.now()}-${index + 1}`,
      target_price: roundNumber(targetPrice),
      plan_quantity: normalizedQuantity,
      completed_quantity: normalizedCompleted,
      remaining_quantity: roundNumber(normalizedQuantity - normalizedCompleted),
      amount: roundNumber(targetPrice * planQuantity),
      status: deriveBatchStatus(normalizedCompleted, normalizedQuantity),
      note: item.note ? String(item.note) : ''
    });
  }

  return { batches };
};

const summarizeBatches = (batches: PlanBatch[]) => {
  const planQuantity = batches.reduce((sum, batch) => sum + batch.plan_quantity, 0);
  const totalAmount = batches.reduce((sum, batch) => sum + batch.amount, 0);
  const completedQuantity = batches.reduce((sum, batch) => sum + batch.completed_quantity, 0);
  const remainingQuantity = batches.reduce((sum, batch) => sum + batch.remaining_quantity, 0);
  const weightedTargetPrice = planQuantity > 0 ? totalAmount / planQuantity : 0;
  const progressPercent = planQuantity > 0 ? (completedQuantity / planQuantity) * 100 : 0;

  return {
    target_price: roundNumber(weightedTargetPrice),
    plan_quantity: roundNumber(planQuantity),
    total_amount: roundNumber(totalAmount),
    completed_quantity: roundNumber(completedQuantity),
    remaining_quantity: roundNumber(remainingQuantity),
    progress_percent: roundNumber(progressPercent),
    batch_count: batches.length
  };
};

const derivePlanStatus = (batches: PlanBatch[], currentStatus?: string, requestedStatus?: string): string => {
  if (requestedStatus === 'cancelled') return 'cancelled';
  if (requestedStatus && requestedStatus !== 'in_progress') return requestedStatus;
  if (currentStatus === 'cancelled' && !requestedStatus) return 'cancelled';

  const summary = summarizeBatches(batches);
  if (summary.completed_quantity <= 0) return requestedStatus === 'in_progress' ? 'in_progress' : 'pending';
  if (summary.remaining_quantity <= 0) return 'completed';
  return 'in_progress';
};

const parseStoredBatches = (plan: any): PlanBatch[] => {
  if (plan?.batches) {
    try {
      const parsed = JSON.parse(plan.batches);
      const normalized = normalizeBatches(parsed, plan.target_price, plan.plan_quantity, plan.status);
      if (!normalized.error && normalized.batches.length > 0) {
        return normalized.batches;
      }
    } catch (error) {
      console.warn('Failed to parse plan batches, falling back to legacy fields:', error);
    }
  }

  const fallback = normalizeBatches([], plan?.target_price, plan?.plan_quantity, plan?.status);
  return fallback.batches;
};

const serializePlan = (plan: any, kind: PlanKind) => {
  const batches = parseStoredBatches(plan);
  const summary = summarizeBatches(batches);

  return {
    id: String(plan.id),
    plan_name: plan.plan_name,
    category_name: plan.category_name,
    object_name: plan.object_name,
    variant_name: plan.variant_name || '',
    plan_type: kind,
    target_price: summary.target_price,
    plan_quantity: summary.plan_quantity,
    total_amount: summary.total_amount,
    completed_quantity: summary.completed_quantity,
    remaining_quantity: summary.remaining_quantity,
    progress_percent: summary.progress_percent,
    batch_count: summary.batch_count,
    batches,
    status: plan.status,
    note: plan.note || '',
    track: plan.track,
    type: plan.type,
    market_type_preset: plan.market_type_preset,
    created_at: plan.created_at,
    updated_at: plan.updated_at
  };
};

const validateMasterData = async (db: any, categoryName: string, objectName: string, variantName?: string) => {
  const category = await db.get('SELECT * FROM categories WHERE name = ?', [categoryName]);
  if (!category) return '品类不存在';

  const object = await db.get('SELECT * FROM objects WHERE category_id = ? AND name = ?', [category.id, objectName]);
  if (!object) return '对象不存在';

  if (variantName) {
    const variant = await db.get('SELECT * FROM variants WHERE object_id = ? AND name = ?', [object.id, variantName]);
    if (!variant) return '变体不存在';
  }

  return null;
};

const buildPlanPayload = async (db: any, reqBody: any, existingPlan?: any) => {
  const {
    plan_name,
    category_name,
    object_name,
    variant_name,
    target_price,
    plan_quantity,
    note
  } = reqBody;

  if (!plan_name || !category_name || !object_name) {
    return { error: '缺少必填字段: plan_name, category_name, object_name' };
  }

  const normalizedBatches = normalizeBatches(reqBody.batches, target_price, plan_quantity, existingPlan?.status || 'pending');
  if (normalizedBatches.error) {
    return { error: normalizedBatches.error };
  }

  const masterDataError = await validateMasterData(db, category_name, object_name, variant_name);
  if (masterDataError) {
    return { error: masterDataError };
  }

  const summary = summarizeBatches(normalizedBatches.batches);
  const status = derivePlanStatus(normalizedBatches.batches, existingPlan?.status, reqBody.status);

  return {
    payload: {
      plan_name,
      category_name,
      object_name,
      variant_name: variant_name || '',
      target_price: summary.target_price,
      plan_quantity: summary.plan_quantity,
      total_amount: summary.total_amount,
      completed_quantity: summary.completed_quantity,
      remaining_quantity: summary.remaining_quantity,
      progress_percent: summary.progress_percent,
      batch_count: summary.batch_count,
      batches: normalizedBatches.batches,
      batchesJson: JSON.stringify(normalizedBatches.batches),
      note,
      track: reqBody.track || null,
      type: reqBody.type || existingPlan?.type || 'manual',
      market_type_preset: reqBody.market_type_preset || existingPlan?.market_type_preset || 'standard',
      status
    }
  };
};

const setBatchCompletionForStatus = (batches: PlanBatch[], status: string): PlanBatch[] => {
  if (status === 'completed') {
    return batches.map(batch => ({
      ...batch,
      completed_quantity: batch.plan_quantity,
      remaining_quantity: 0,
      status: 'completed'
    }));
  }

  if (status === 'pending') {
    return batches.map(batch => ({
      ...batch,
      completed_quantity: 0,
      remaining_quantity: batch.plan_quantity,
      status: 'pending'
    }));
  }

  return batches;
};

const registerPlanRoutes = (config: PlanConfig) => {
  router.post(`/${config.endpoint}`, async (req, res) => {
    try {
      const db = await getDb();
      const result = await buildPlanPayload(db, req.body);
      if (result.error || !result.payload) {
        return res.status(400).json({ success: false, message: result.error });
      }

      const now = new Date().toISOString();
      const payload = result.payload;
      const insertResult = await db.run(
        `INSERT INTO ${config.tableName} (plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, note, track, type, market_type_preset, status, batches, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          payload.plan_name,
          payload.category_name,
          payload.object_name,
          payload.variant_name,
          payload.target_price,
          payload.plan_quantity,
          payload.total_amount,
          payload.note,
          payload.track,
          payload.type,
          payload.market_type_preset,
          payload.status,
          payload.batchesJson,
          now,
          now
        ]
      );

      res.json({ success: true, data: { id: insertResult.lastID } });
    } catch (error) {
      console.error(`Error creating ${config.endpoint}:`, error);
      res.status(500).json({ success: false, message: `新增${config.label}失败` });
    }
  });

  router.put(`/${config.endpoint}/:id`, async (req, res) => {
    try {
      const db = await getDb();
      const { id } = req.params;
      const existingPlan = await db.get(`SELECT * FROM ${config.tableName} WHERE id = ?`, [id]);
      if (!existingPlan) {
        return res.status(404).json({ success: false, message: `${config.label}不存在` });
      }

      const result = await buildPlanPayload(db, req.body, existingPlan);
      if (result.error || !result.payload) {
        return res.status(400).json({ success: false, message: result.error });
      }

      const payload = result.payload;
      const now = new Date().toISOString();
      const updateResult = await db.run(
        `UPDATE ${config.tableName} SET plan_name = ?, category_name = ?, object_name = ?, variant_name = ?, target_price = ?, plan_quantity = ?, total_amount = ?, note = ?, track = ?, type = ?, market_type_preset = ?, status = ?, batches = ?, updated_at = ? WHERE id = ?`,
        [
          payload.plan_name,
          payload.category_name,
          payload.object_name,
          payload.variant_name,
          payload.target_price,
          payload.plan_quantity,
          payload.total_amount,
          payload.note,
          payload.track,
          payload.type,
          payload.market_type_preset,
          payload.status,
          payload.batchesJson,
          now,
          id
        ]
      );

      res.json({ success: true, data: { changes: updateResult.changes } });
    } catch (error) {
      console.error(`Error updating ${config.endpoint}:`, error);
      res.status(500).json({ success: false, message: `编辑${config.label}失败` });
    }
  });

  router.delete(`/${config.endpoint}/:id`, async (req, res) => {
    try {
      const db = await getDb();
      const { id } = req.params;
      const existingPlan = await db.get(`SELECT * FROM ${config.tableName} WHERE id = ?`, [id]);
      if (!existingPlan) {
        return res.status(404).json({ success: false, message: `${config.label}不存在` });
      }

      const result = await db.run(`DELETE FROM ${config.tableName} WHERE id = ?`, [id]);
      res.json({ success: true, data: { changes: result.changes } });
    } catch (error) {
      console.error(`Error deleting ${config.endpoint}:`, error);
      res.status(500).json({ success: false, message: `删除${config.label}失败` });
    }
  });

  router.get(`/${config.endpoint}`, async (req, res) => {
    try {
      const db = await getDb();
      const { status } = req.query;
      const params: any[] = [];
      let query = `SELECT * FROM ${config.tableName}`;

      if (status) {
        query += ' WHERE status = ?';
        params.push(status);
      }

      query += ' ORDER BY created_at DESC, id DESC';
      const plans = await db.all(query, params);
      res.json({ success: true, data: plans.map((plan: any) => serializePlan(plan, config.kind)) });
    } catch (error) {
      console.error(`Error fetching ${config.endpoint}:`, error);
      res.status(500).json({ success: false, message: `获取${config.label}列表失败` });
    }
  });

  router.get(`/${config.endpoint}/:id`, async (req, res) => {
    try {
      const db = await getDb();
      const { id } = req.params;
      const plan = await db.get(`SELECT * FROM ${config.tableName} WHERE id = ?`, [id]);

      if (!plan) {
        return res.status(404).json({ success: false, message: `${config.label}不存在` });
      }

      res.json({ success: true, data: serializePlan(plan, config.kind) });
    } catch (error) {
      console.error(`Error fetching ${config.endpoint} details:`, error);
      res.status(500).json({ success: false, message: `获取${config.label}详情失败` });
    }
  });

  router.put(`/${config.endpoint}/:id/status`, async (req, res) => {
    try {
      const db = await getDb();
      const { id } = req.params;
      const { status } = req.body;

      if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: '无效的状态值' });
      }

      const currentPlan = await db.get(`SELECT * FROM ${config.tableName} WHERE id = ?`, [id]);
      if (!currentPlan) {
        return res.status(404).json({ success: false, message: `${config.label}不存在` });
      }

      const currentBatches = parseStoredBatches(currentPlan);
      const nextBatches = setBatchCompletionForStatus(currentBatches, status);
      const summary = summarizeBatches(nextBatches);
      const updatedAt = new Date().toISOString();

      await db.run(
        `UPDATE ${config.tableName} SET status = ?, target_price = ?, plan_quantity = ?, total_amount = ?, batches = ?, updated_at = ? WHERE id = ?`,
        [
          status,
          summary.target_price,
          summary.plan_quantity,
          summary.total_amount,
          JSON.stringify(nextBatches),
          updatedAt,
          id
        ]
      );

      res.json({
        success: true,
        data: {
          id: parseInt(id, 10),
          status,
          completed_quantity: summary.completed_quantity,
          remaining_quantity: summary.remaining_quantity,
          progress_percent: summary.progress_percent,
          updated_at: updatedAt
        }
      });
    } catch (error) {
      console.error(`Error updating ${config.endpoint} status:`, error);
      res.status(500).json({ success: false, message: `更新${config.label}状态失败` });
    }
  });

  router.post(`/${config.endpoint}/:id/copy`, async (req, res) => {
    try {
      const db = await getDb();
      const { id } = req.params;
      const originalPlan = await db.get(`SELECT * FROM ${config.tableName} WHERE id = ?`, [id]);
      if (!originalPlan) {
        return res.status(404).json({ success: false, message: `${config.label}不存在` });
      }

      const originalBatches = parseStoredBatches(originalPlan).map(batch => ({
        ...batch,
        completed_quantity: 0,
        remaining_quantity: batch.plan_quantity,
        status: 'pending'
      }));
      const copyBody = {
        ...originalPlan,
        ...req.body,
        plan_name: req.body.plan_name || `${originalPlan.plan_name} (复制)`,
        batches: req.body.batches || originalBatches,
        status: 'pending'
      };
      const result = await buildPlanPayload(db, copyBody, { ...originalPlan, status: 'pending' });
      if (result.error || !result.payload) {
        return res.status(400).json({ success: false, message: result.error });
      }

      const payload = result.payload;
      const now = new Date().toISOString();
      const insertResult = await db.run(
        `INSERT INTO ${config.tableName} (plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, note, track, type, market_type_preset, status, batches, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          payload.plan_name,
          payload.category_name,
          payload.object_name,
          payload.variant_name,
          payload.target_price,
          payload.plan_quantity,
          payload.total_amount,
          payload.note,
          payload.track,
          payload.type,
          payload.market_type_preset,
          'pending',
          payload.batchesJson,
          now,
          now
        ]
      );

      res.json({ success: true, data: { id: insertResult.lastID } });
    } catch (error) {
      console.error(`Error copying ${config.endpoint}:`, error);
      res.status(500).json({ success: false, message: `复制${config.label}失败` });
    }
  });
};

planConfigs.forEach(registerPlanRoutes);

router.get('/plans/stats', async (req, res) => {
  try {
    const db = await getDb();

    const buyStats = await db.get(
      'SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as amount FROM buying_plans WHERE status IN (?, ?)',
      ['pending', 'in_progress']
    );

    const sellStats = await db.get(
      'SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as amount FROM selling_plans WHERE status IN (?, ?)',
      ['pending', 'in_progress']
    );

    const buyStatsByCategory = await db.all(
      'SELECT category_name, COUNT(*) as count, COALESCE(SUM(total_amount), 0) as amount FROM buying_plans WHERE status IN (?, ?) GROUP BY category_name',
      ['pending', 'in_progress']
    );

    const sellStatsByCategory = await db.all(
      'SELECT category_name, COUNT(*) as count, COALESCE(SUM(total_amount), 0) as amount FROM selling_plans WHERE status IN (?, ?) GROUP BY category_name',
      ['pending', 'in_progress']
    );

    res.json({
      success: true,
      data: {
        total_count: buyStats.count + sellStats.count,
        total_amount: buyStats.amount + sellStats.amount,
        buy_count: buyStats.count,
        buy_amount: buyStats.amount,
        sell_count: sellStats.count,
        sell_amount: sellStats.amount,
        buy_stats_by_category: buyStatsByCategory,
        sell_stats_by_category: sellStatsByCategory
      }
    });
  } catch (error) {
    console.error('Error getting plan stats:', error);
    res.status(500).json({ success: false, message: '获取计划统计数据失败' });
  }
});

export default router;
