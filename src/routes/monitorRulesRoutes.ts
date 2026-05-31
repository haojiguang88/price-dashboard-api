import express from 'express';
import getDb from '../config/database';
import { validateActiveRuleScope } from '../utils/masterData';

const router = express.Router();

// 合法的规则类型
const validRuleTypes = [
  'price_change_daily',
  'price_change_period',
  'consecutive_change',
  'new_high',
  'new_low',
  'historical_new_high',
  'historical_new_low',
  'amplitude',
  'volatility'
];

// 合法的范围类型
const validScopeTypes = ['global', 'category', 'object'];

// 合法的状态
const validStatuses = ['enabled', 'disabled'];

// 验证规则类型
const validateRuleType = (ruleType: string): boolean => {
  return validRuleTypes.includes(ruleType);
};

// 验证范围类型
const validateScopeType = (scopeType: string): boolean => {
  return validScopeTypes.includes(scopeType);
};

// 验证状态
const validateStatus = (status: string): boolean => {
  return validStatuses.includes(status);
};

const parseParamsJson = (jsonString: string): Record<string, any> | null => {
  try {
    const parsed = JSON.parse(jsonString);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isPositiveNumber = (value: unknown) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0;
};

const isIntegerAtLeast = (value: unknown, minimum: number) => {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue >= minimum;
};

const validateRuleParams = (ruleType: string, paramsJson: string): { ok: true } | { ok: false; message: string } => {
  const params = parseParamsJson(paramsJson);
  if (!params) return { ok: false, message: "无效的 params_json 格式" };

  if (ruleType === 'price_change_daily' || ruleType === 'price_change_period') {
    if (!isPositiveNumber(params.threshold)) {
      return { ok: false, message: "价格涨跌规则必须配置大于 0 的 threshold" };
    }
    if (params.direction !== 'up' && params.direction !== 'down') {
      return { ok: false, message: "价格涨跌规则 direction 必须是 up 或 down" };
    }
    if (params.threshold_unit !== 'percent' && params.threshold_unit !== 'amount') {
      return { ok: false, message: "价格涨跌规则 threshold_unit 必须是 percent 或 amount" };
    }
    if (ruleType === 'price_change_period' && !isIntegerAtLeast(params.period, 2)) {
      return { ok: false, message: "区间涨跌规则 period 必须是不小于 2 的整数" };
    }
    return { ok: true };
  }

  if (ruleType === 'consecutive_change') {
    return isIntegerAtLeast(params.days, 2)
      ? { ok: true }
      : { ok: false, message: "连续涨跌规则 days 必须是不小于 2 的整数" };
  }

  if (ruleType === 'new_high' || ruleType === 'new_low') {
    return isIntegerAtLeast(params.days, 2)
      ? { ok: true }
      : { ok: false, message: "阶段新高/新低规则 days 必须是不小于 2 的整数" };
  }

  if (ruleType === 'amplitude' || ruleType === 'volatility') {
    return isPositiveNumber(params.threshold)
      ? { ok: true }
      : { ok: false, message: "波动规则必须配置大于 0 的 threshold" };
  }

  if (ruleType === 'historical_new_high' || ruleType === 'historical_new_low') {
    return { ok: true };
  }

  return { ok: false, message: "无效的规则类型" };
};

// 获取规则列表
router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const { status, scope_type, scope_id } = req.query;
    
    let query = 'SELECT * FROM monitor_rules WHERE 1=1';
    const params: any[] = [];
    
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    
    if (scope_type) {
      query += ' AND scope_type = ?';
      params.push(scope_type);
      
      if (scope_id) {
        query += ' AND scope_id = ?';
        params.push(scope_id);
      }
    }
    
    query += ' ORDER BY created_at DESC';
    
    const rules = await db.all(query, params);
    
    res.json({
      status: "success",
      data: rules
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取规则列表失败", error: errorMessage });
  }
});

// 获取单个规则
router.get('/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    const rule = await db.get('SELECT * FROM monitor_rules WHERE id = ?', [id]);
    
    if (!rule) {
      res.status(404).json({ status: "error", message: "规则不存在" });
      return;
    }
    
    res.json({
      status: "success",
      data: rule
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取规则失败", error: errorMessage });
  }
});

// 创建规则
router.post('/', async (req, res) => {
  try {
    const db = await getDb();
    const {
      rule_name,
      rule_type,
      scope_type,
      scope_id,
      params_json,
      action_text,
      description,
      status = 'enabled'
    } = req.body;
    
    // 验证必填字段
    if (!rule_name || !rule_type || !scope_type || !params_json) {
      res.status(400).json({ status: "error", message: "缺少必填字段" });
      return;
    }
    
    // 验证规则类型
    if (!validateRuleType(rule_type)) {
      res.status(400).json({ status: "error", message: "无效的规则类型" });
      return;
    }
    
    // 验证范围类型
    if (!validateScopeType(scope_type)) {
      res.status(400).json({ status: "error", message: "无效的范围类型" });
      return;
    }
    
    // 验证状态
    if (!validateStatus(status)) {
      res.status(400).json({ status: "error", message: "无效的状态" });
      return;
    }
    
    const paramsValidation = validateRuleParams(rule_type, params_json);
    if (!paramsValidation.ok) {
      res.status(400).json({ status: "error", message: paramsValidation.message });
      return;
    }
    
    const scopeValidation = await validateActiveRuleScope(db, scope_type, scope_id);
    if (!scopeValidation.ok) {
      res.status(400).json({ status: "error", message: scopeValidation.message });
      return;
    }
    
    const now = new Date().toISOString();
    
    const tempRuleCode = `TEMP-${now}-${Math.random().toString(36).slice(2, 10)}`;
    await db.run("BEGIN IMMEDIATE TRANSACTION");
    let result;
    try {
      result = await db.run(
        `INSERT INTO monitor_rules
         (rule_code, rule_name, rule_type, scope_type, scope_id, params_json, action_text, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tempRuleCode, rule_name, rule_type, scope_type, scopeValidation.normalizedScopeId, params_json, action_text, description, status, now, now]
      );

      const ruleCode = 'R' + String(result.lastID).padStart(3, '0');
      await db.run(
        'UPDATE monitor_rules SET rule_code = ?, updated_at = ? WHERE id = ?',
        [ruleCode, now, result.lastID]
      );
      await db.run("COMMIT");
    } catch (error) {
      await db.run("ROLLBACK").catch(() => undefined);
      throw error;
    }
    
    const newRule = await db.get('SELECT * FROM monitor_rules WHERE id = ?', [result.lastID]);
    
    res.json({
      status: "success",
      message: "规则创建成功",
      data: newRule
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "创建规则失败", error: errorMessage });
  }
});

// 更新规则
router.put('/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const {
      rule_name,
      rule_type,
      scope_id,
      params_json,
      action_text,
      description
    } = req.body;
    
    // 检查规则是否存在
    const existingRule = await db.get('SELECT * FROM monitor_rules WHERE id = ?', [id]);
    if (!existingRule) {
      res.status(404).json({ status: "error", message: "规则不存在" });
      return;
    }
    
    // 验证必填字段
    if (!rule_name || !rule_type || !params_json) {
      res.status(400).json({ status: "error", message: "缺少必填字段" });
      return;
    }
    
    // 验证规则类型
    if (!validateRuleType(rule_type)) {
      res.status(400).json({ status: "error", message: "无效的规则类型" });
      return;
    }
    
    const paramsValidation = validateRuleParams(rule_type, params_json);
    if (!paramsValidation.ok) {
      res.status(400).json({ status: "error", message: paramsValidation.message });
      return;
    }
    
    const scopeValidation = await validateActiveRuleScope(db, existingRule.scope_type, scope_id);
    if (!scopeValidation.ok) {
      res.status(400).json({ status: "error", message: scopeValidation.message });
      return;
    }
    
    const now = new Date().toISOString();
    
    await db.run(
      `UPDATE monitor_rules SET 
       rule_name = ?, 
       rule_type = ?, 
       scope_id = ?, 
       params_json = ?, 
       action_text = ?, 
       description = ?, 
       updated_at = ? 
       WHERE id = ?`,
      [rule_name, rule_type, scopeValidation.normalizedScopeId, params_json, action_text, description, now, id]
    );
    
    const updatedRule = await db.get('SELECT * FROM monitor_rules WHERE id = ?', [id]);
    
    res.json({
      status: "success",
      message: "规则更新成功",
      data: updatedRule
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "更新规则失败", error: errorMessage });
  }
});

// 更新规则状态
router.patch('/:id/status', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { status } = req.body;
    
    // 检查规则是否存在
    const existingRule = await db.get('SELECT * FROM monitor_rules WHERE id = ?', [id]);
    if (!existingRule) {
      res.status(404).json({ status: "error", message: "规则不存在" });
      return;
    }
    
    // 验证状态
    if (!status || !validateStatus(status)) {
      res.status(400).json({ status: "error", message: "无效的状态" });
      return;
    }
    
    const now = new Date().toISOString();
    
    await db.run(
      'UPDATE monitor_rules SET status = ?, updated_at = ? WHERE id = ?',
      [status, now, id]
    );
    
    const updatedRule = await db.get('SELECT * FROM monitor_rules WHERE id = ?', [id]);
    
    res.json({
      status: "success",
      message: "规则状态更新成功",
      data: updatedRule
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "更新规则状态失败", error: errorMessage });
  }
});

// 删除规则
router.delete('/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查规则是否存在
    const existingRule = await db.get('SELECT * FROM monitor_rules WHERE id = ?', [id]);
    if (!existingRule) {
      res.status(404).json({ status: "error", message: "规则不存在" });
      return;
    }
    
    // 检查规则状态
    if (existingRule.status === 'enabled') {
      res.status(400).json({ status: "error", message: "启用中的规则不能删除，请先停用后再删除" });
      return;
    }
    
    // 删除规则
    await db.run('DELETE FROM monitor_rules WHERE id = ?', [id]);
    
    res.json({
      status: "success",
      message: "规则删除成功",
      data: { id: parseInt(id) }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "删除规则失败", error: errorMessage });
  }
});

export default router;
