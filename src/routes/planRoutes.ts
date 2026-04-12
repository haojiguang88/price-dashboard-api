import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 买入计划相关接口

// 新增买入计划
router.post('/buying-plans', async (req, res) => {
  try {
    const db = await getDb();
    const { plan_name, category_name, object_name, variant_name, target_price, plan_quantity, note } = req.body;
    
    // 校验字段
    if (!plan_name || !category_name || !object_name || !target_price || !plan_quantity) {
      return res.status(400).json({ success: false, message: '缺少必填字段: plan_name, category_name, object_name, target_price, plan_quantity' });
    }
    
    // 校验价格是否为数字
    if (typeof target_price !== 'number') {
      return res.status(400).json({ success: false, message: '目标价格必须是数字' });
    }
    
    // 校验数量是否为整数且大于 0
    if (!Number.isInteger(plan_quantity) || plan_quantity <= 0) {
      return res.status(400).json({ success: false, message: '计划数量必须是整数且大于 0' });
    }
    
    // 标准化 variant_name
    const variant = variant_name || '';
    
    // 计算总金额
    const total_amount = target_price * plan_quantity;
    
    // 校验主数据是否存在
    const category = await db.get('SELECT * FROM categories WHERE name = ?', [category_name]);
    if (!category) {
      return res.status(400).json({ success: false, message: '品类不存在' });
    }
    
    const object = await db.get('SELECT * FROM objects WHERE category_id = ? AND name = ?', [category.id, object_name]);
    if (!object) {
      return res.status(400).json({ success: false, message: '对象不存在' });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (variant_name) {
      const variant = await db.get('SELECT * FROM variants WHERE object_id = ? AND name = ?', [object.id, variant_name]);
      if (!variant) {
        return res.status(400).json({ success: false, message: '变体不存在' });
      }
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO buying_plans (plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [plan_name, category_name, object_name, variant, target_price, plan_quantity, total_amount, note, 'pending', now, now]
    );
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error creating buying plan:', error);
    res.status(500).json({ success: false, message: '新增买入计划失败' });
  }
});

// 编辑买入计划
router.put('/buying-plans/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { plan_name, category_name, object_name, variant_name, target_price, plan_quantity, note } = req.body;
    
    // 校验字段
    if (!plan_name || !category_name || !object_name || !target_price || !plan_quantity) {
      return res.status(400).json({ success: false, message: '缺少必填字段: plan_name, category_name, object_name, target_price, plan_quantity' });
    }
    
    // 校验价格是否为数字
    if (typeof target_price !== 'number') {
      return res.status(400).json({ success: false, message: '目标价格必须是数字' });
    }
    
    // 校验数量是否为整数且大于 0
    if (!Number.isInteger(plan_quantity) || plan_quantity <= 0) {
      return res.status(400).json({ success: false, message: '计划数量必须是整数且大于 0' });
    }
    
    // 标准化 variant_name
    const variant = variant_name || '';
    
    // 计算总金额
    const total_amount = target_price * plan_quantity;
    
    // 校验主数据是否存在
    const category = await db.get('SELECT * FROM categories WHERE name = ?', [category_name]);
    if (!category) {
      return res.status(400).json({ success: false, message: '品类不存在' });
    }
    
    const object = await db.get('SELECT * FROM objects WHERE category_id = ? AND name = ?', [category.id, object_name]);
    if (!object) {
      return res.status(400).json({ success: false, message: '对象不存在' });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (variant_name) {
      const variant = await db.get('SELECT * FROM variants WHERE object_id = ? AND name = ?', [object.id, variant_name]);
      if (!variant) {
        return res.status(400).json({ success: false, message: '变体不存在' });
      }
    }
    
    // 检查计划是否存在
    const existingPlan = await db.get('SELECT * FROM buying_plans WHERE id = ?', [id]);
    if (!existingPlan) {
      return res.status(404).json({ success: false, message: '买入计划不存在' });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE buying_plans SET plan_name = ?, category_name = ?, object_name = ?, variant_name = ?, target_price = ?, plan_quantity = ?, total_amount = ?, note = ?, updated_at = ? WHERE id = ?',
      [plan_name, category_name, object_name, variant, target_price, plan_quantity, total_amount, note, now, id]
    );
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error updating buying plan:', error);
    res.status(500).json({ success: false, message: '编辑买入计划失败' });
  }
});

// 删除买入计划
router.delete('/buying-plans/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查计划是否存在
    const existingPlan = await db.get('SELECT * FROM buying_plans WHERE id = ?', [id]);
    if (!existingPlan) {
      return res.status(404).json({ success: false, message: '买入计划不存在' });
    }
    
    // 删除记录
    const result = await db.run('DELETE FROM buying_plans WHERE id = ?', [id]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting buying plan:', error);
    res.status(500).json({ success: false, message: '删除买入计划失败' });
  }
});

// 获取买入计划列表
router.get('/buying-plans', async (req, res) => {
  try {
    const db = await getDb();
    const { status } = req.query;
    
    let query = 'SELECT id, plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, status, created_at FROM buying_plans';
    const params: any[] = [];
    
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC, id DESC';
    
    const plans = await db.all(query, params);
    res.json({ success: true, data: plans });
  } catch (error) {
    console.error('Error fetching buying plans:', error);
    res.status(500).json({ success: false, message: '获取买入计划列表失败' });
  }
});

// 获取买入计划详情
router.get('/buying-plans/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 获取计划详情
    const plan = await db.get('SELECT id, plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, status, note, created_at, updated_at FROM buying_plans WHERE id = ?', [id]);
    
    if (!plan) {
      return res.status(404).json({ success: false, message: '买入计划不存在' });
    }
    
    res.json({
      success: true,
      data: {
        plan_name: plan.plan_name,
        category_name: plan.category_name,
        object_name: plan.object_name,
        variant_name: plan.variant_name,
        plan_type: 'buying',
        target_price: plan.target_price,
        plan_quantity: plan.plan_quantity,
        total_amount: plan.total_amount,
        status: plan.status,
        note: plan.note
      }
    });
  } catch (error) {
    console.error('Error fetching buying plan details:', error);
    res.status(500).json({ success: false, message: '获取买入计划详情失败' });
  }
});

// 修改买入计划状态
router.put('/buying-plans/:id/status', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { status } = req.body;
    
    // 验证状态值
    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: '无效的状态值' });
    }
    
    // 检查计划是否存在
    const currentPlan = await db.get('SELECT status FROM buying_plans WHERE id = ?', [id]);
    if (!currentPlan) {
      return res.status(404).json({ success: false, message: '买入计划不存在' });
    }
    
    // 更新状态
    const updatedAt = new Date().toISOString();
    await db.run('UPDATE buying_plans SET status = ?, updated_at = ? WHERE id = ?', [status, updatedAt, id]);
    
    // 返回更新后的状态信息
    res.json({
      success: true,
      data: {
        id: parseInt(id),
        status,
        updated_at: updatedAt
      }
    });
  } catch (error) {
    console.error('Error updating buying plan status:', error);
    res.status(500).json({ success: false, message: '更新买入计划状态失败' });
  }
});



// 复制买入计划
router.post('/buying-plans/:id/copy', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { plan_name, target_price, plan_quantity, note } = req.body;
    
    // 检查计划是否存在
    const originalPlan = await db.get('SELECT * FROM buying_plans WHERE id = ?', [id]);
    if (!originalPlan) {
      return res.status(404).json({ success: false, message: '买入计划不存在' });
    }
    
    // 准备复制的字段
    const newPlanName = plan_name || `${originalPlan.plan_name} (复制)`;
    const newTargetPrice = target_price || originalPlan.target_price;
    const newPlanQuantity = plan_quantity || originalPlan.plan_quantity;
    const newNote = note || originalPlan.note;
    
    // 计算总金额
    const total_amount = newTargetPrice * newPlanQuantity;
    
    // 插入新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO buying_plans (plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [newPlanName, originalPlan.category_name, originalPlan.object_name, originalPlan.variant_name, newTargetPrice, newPlanQuantity, total_amount, newNote, 'pending', now, now]
    );
    
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error copying buying plan:', error);
    res.status(500).json({ success: false, message: '复制买入计划失败' });
  }
});

// 卖出计划相关接口

// 新增卖出计划
router.post('/selling-plans', async (req, res) => {
  try {
    const db = await getDb();
    const { plan_name, category_name, object_name, variant_name, target_price, plan_quantity, note } = req.body;
    
    // 校验字段
    if (!plan_name || !category_name || !object_name || !target_price || !plan_quantity) {
      return res.status(400).json({ success: false, message: '缺少必填字段: plan_name, category_name, object_name, target_price, plan_quantity' });
    }
    
    // 校验价格是否为数字
    if (typeof target_price !== 'number') {
      return res.status(400).json({ success: false, message: '目标价格必须是数字' });
    }
    
    // 校验数量是否为整数且大于 0
    if (!Number.isInteger(plan_quantity) || plan_quantity <= 0) {
      return res.status(400).json({ success: false, message: '计划数量必须是整数且大于 0' });
    }
    
    // 标准化 variant_name
    const variant = variant_name || '';
    
    // 计算总金额
    const total_amount = target_price * plan_quantity;
    
    // 校验主数据是否存在
    const category = await db.get('SELECT * FROM categories WHERE name = ?', [category_name]);
    if (!category) {
      return res.status(400).json({ success: false, message: '品类不存在' });
    }
    
    const object = await db.get('SELECT * FROM objects WHERE category_id = ? AND name = ?', [category.id, object_name]);
    if (!object) {
      return res.status(400).json({ success: false, message: '对象不存在' });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (variant_name) {
      const variant = await db.get('SELECT * FROM variants WHERE object_id = ? AND name = ?', [object.id, variant_name]);
      if (!variant) {
        return res.status(400).json({ success: false, message: '变体不存在' });
      }
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO selling_plans (plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [plan_name, category_name, object_name, variant, target_price, plan_quantity, total_amount, note, 'pending', now, now]
    );
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error creating selling plan:', error);
    res.status(500).json({ success: false, message: '新增卖出计划失败' });
  }
});

// 编辑卖出计划
router.put('/selling-plans/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { plan_name, category_name, object_name, variant_name, target_price, plan_quantity, note } = req.body;
    
    // 校验字段
    if (!plan_name || !category_name || !object_name || !target_price || !plan_quantity) {
      return res.status(400).json({ success: false, message: '缺少必填字段: plan_name, category_name, object_name, target_price, plan_quantity' });
    }
    
    // 校验价格是否为数字
    if (typeof target_price !== 'number') {
      return res.status(400).json({ success: false, message: '目标价格必须是数字' });
    }
    
    // 校验数量是否为整数且大于 0
    if (!Number.isInteger(plan_quantity) || plan_quantity <= 0) {
      return res.status(400).json({ success: false, message: '计划数量必须是整数且大于 0' });
    }
    
    // 标准化 variant_name
    const variant = variant_name || '';
    
    // 计算总金额
    const total_amount = target_price * plan_quantity;
    
    // 校验主数据是否存在
    const category = await db.get('SELECT * FROM categories WHERE name = ?', [category_name]);
    if (!category) {
      return res.status(400).json({ success: false, message: '品类不存在' });
    }
    
    const object = await db.get('SELECT * FROM objects WHERE category_id = ? AND name = ?', [category.id, object_name]);
    if (!object) {
      return res.status(400).json({ success: false, message: '对象不存在' });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (variant_name) {
      const variant = await db.get('SELECT * FROM variants WHERE object_id = ? AND name = ?', [object.id, variant_name]);
      if (!variant) {
        return res.status(400).json({ success: false, message: '变体不存在' });
      }
    }
    
    // 检查计划是否存在
    const existingPlan = await db.get('SELECT * FROM selling_plans WHERE id = ?', [id]);
    if (!existingPlan) {
      return res.status(404).json({ success: false, message: '卖出计划不存在' });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE selling_plans SET plan_name = ?, category_name = ?, object_name = ?, variant_name = ?, target_price = ?, plan_quantity = ?, total_amount = ?, note = ?, updated_at = ? WHERE id = ?',
      [plan_name, category_name, object_name, variant, target_price, plan_quantity, total_amount, note, now, id]
    );
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error updating selling plan:', error);
    res.status(500).json({ success: false, message: '编辑卖出计划失败' });
  }
});

// 删除卖出计划
router.delete('/selling-plans/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查计划是否存在
    const existingPlan = await db.get('SELECT * FROM selling_plans WHERE id = ?', [id]);
    if (!existingPlan) {
      return res.status(404).json({ success: false, message: '卖出计划不存在' });
    }
    
    // 删除记录
    const result = await db.run('DELETE FROM selling_plans WHERE id = ?', [id]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting selling plan:', error);
    res.status(500).json({ success: false, message: '删除卖出计划失败' });
  }
});

// 获取卖出计划列表
router.get('/selling-plans', async (req, res) => {
  try {
    const db = await getDb();
    const { status } = req.query;
    
    let query = 'SELECT id, plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, status, created_at FROM selling_plans';
    const params: any[] = [];
    
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC, id DESC';
    
    const plans = await db.all(query, params);
    res.json({ success: true, data: plans });
  } catch (error) {
    console.error('Error fetching selling plans:', error);
    res.status(500).json({ success: false, message: '获取卖出计划列表失败' });
  }
});

// 获取卖出计划详情
router.get('/selling-plans/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 获取计划详情
    const plan = await db.get('SELECT id, plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, status, note, created_at, updated_at FROM selling_plans WHERE id = ?', [id]);
    
    if (!plan) {
      return res.status(404).json({ success: false, message: '卖出计划不存在' });
    }
    
    res.json({
      success: true,
      data: {
        plan_name: plan.plan_name,
        category_name: plan.category_name,
        object_name: plan.object_name,
        variant_name: plan.variant_name,
        plan_type: 'selling',
        target_price: plan.target_price,
        plan_quantity: plan.plan_quantity,
        total_amount: plan.total_amount,
        status: plan.status,
        note: plan.note
      }
    });
  } catch (error) {
    console.error('Error fetching selling plan details:', error);
    res.status(500).json({ success: false, message: '获取卖出计划详情失败' });
  }
});

// 修改卖出计划状态
router.put('/selling-plans/:id/status', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { status } = req.body;
    
    // 验证状态值
    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: '无效的状态值' });
    }
    
    // 检查计划是否存在
    const currentPlan = await db.get('SELECT status FROM selling_plans WHERE id = ?', [id]);
    if (!currentPlan) {
      return res.status(404).json({ success: false, message: '卖出计划不存在' });
    }
    
    // 更新状态
    const updatedAt = new Date().toISOString();
    await db.run('UPDATE selling_plans SET status = ?, updated_at = ? WHERE id = ?', [status, updatedAt, id]);
    
    // 返回更新后的状态信息
    res.json({
      success: true,
      data: {
        id: parseInt(id),
        status,
        updated_at: updatedAt
      }
    });
  } catch (error) {
    console.error('Error updating selling plan status:', error);
    res.status(500).json({ success: false, message: '更新卖出计划状态失败' });
  }
});



// 复制卖出计划
router.post('/selling-plans/:id/copy', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { plan_name, target_price, plan_quantity, note } = req.body;
    
    // 检查计划是否存在
    const originalPlan = await db.get('SELECT * FROM selling_plans WHERE id = ?', [id]);
    if (!originalPlan) {
      return res.status(404).json({ success: false, message: '卖出计划不存在' });
    }
    
    // 准备复制的字段
    const newPlanName = plan_name || `${originalPlan.plan_name} (复制)`;
    const newTargetPrice = target_price || originalPlan.target_price;
    const newPlanQuantity = plan_quantity || originalPlan.plan_quantity;
    const newNote = note || originalPlan.note;
    
    // 计算总金额
    const total_amount = newTargetPrice * newPlanQuantity;
    
    // 插入新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO selling_plans (plan_name, category_name, object_name, variant_name, target_price, plan_quantity, total_amount, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [newPlanName, originalPlan.category_name, originalPlan.object_name, originalPlan.variant_name, newTargetPrice, newPlanQuantity, total_amount, newNote, 'pending', now, now]
    );
    
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error copying selling plan:', error);
    res.status(500).json({ success: false, message: '复制卖出计划失败' });
  }
});

// 计划总览统计
router.get('/plans/stats', async (req, res) => {
  try {
    const db = await getDb();
    
    // 统计买入计划
    const buyStats = await db.get(
      'SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as amount FROM buying_plans WHERE status IN (?, ?)',
      ['pending', 'in_progress']
    );
    
    // 统计卖出计划
    const sellStats = await db.get(
      'SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as amount FROM selling_plans WHERE status IN (?, ?)',
      ['pending', 'in_progress']
    );
    
    // 计算全局待处理摘要
    const totalCount = buyStats.count + sellStats.count;
    const totalAmount = buyStats.amount + sellStats.amount;
    
    // 按品类统计买入计划
    const buyStatsByCategory = await db.all(
      'SELECT category_name, COUNT(*) as count, COALESCE(SUM(total_amount), 0) as amount FROM buying_plans WHERE status IN (?, ?) GROUP BY category_name',
      ['pending', 'in_progress']
    );
    
    // 按品类统计卖出计划
    const sellStatsByCategory = await db.all(
      'SELECT category_name, COUNT(*) as count, COALESCE(SUM(total_amount), 0) as amount FROM selling_plans WHERE status IN (?, ?) GROUP BY category_name',
      ['pending', 'in_progress']
    );
    
    res.json({
      success: true,
      data: {
        // 全局待处理摘要
        total_count: totalCount,
        total_amount: totalAmount,
        buy_count: buyStats.count,
        buy_amount: buyStats.amount,
        sell_count: sellStats.count,
        sell_amount: sellStats.amount,
        // 按品类统计
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