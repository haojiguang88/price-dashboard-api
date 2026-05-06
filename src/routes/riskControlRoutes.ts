import express from 'express';
import getDb from '../config/database';

const router = express.Router();

const ALLOWED_SYSTEM_RESULTS = ['reject', 'watch', 'need_category_risk', 'pass'];

// ========== 风控检查记录接口 ==========
// 1. 保存风控总过滤
router.post('/check-records/general-filter', async (req, res) => {
  const db = await getDb();
  try {
    const {
      system_result,
      result_reason = '',
      summary = '',
      items = [],
      rule_version = 'v1'
    } = req.body;

    // 必填校验
    if (!system_result || !ALLOWED_SYSTEM_RESULTS.includes(system_result)) {
      return res.json({ success: false, message: `system_result 必须是 ${ALLOWED_SYSTEM_RESULTS.join(', ')} 之一` });
    }
    if (!Array.isArray(items)) {
      return res.json({ success: false, message: 'items 必须是数组' });
    }

    // 事务处理
    await db.run('BEGIN TRANSACTION');

    // 插入主记录
    const recordResult = await db.run(`
      INSERT INTO risk_check_records (
        review_type, category_name, object_name, variant_name,
        category_risk_type, system_result, result_reason, summary,
        extra_result_json, rule_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'general_filter',
      '', // category_name
      '', // object_name
      '', // variant_name
      '', // category_risk_type
      system_result,
      result_reason,
      summary,
      null, // extra_result_json
      rule_version
    ]);

    const recordId = recordResult.lastID;

    // 插入检查项
    for (const item of items) {
      await db.run(`
        INSERT INTO risk_check_record_items (
          record_id, item_key, item_label, group_name, item_value,
          trigger_type, trigger_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        recordId,
        item.item_key,
        item.item_label,
        item.group_name || '',
        item.item_value,
        item.trigger_type || 'none',
        item.trigger_reason || ''
      ]);
    }

    await db.run('COMMIT');

    res.json({
      success: true,
      message: '风控总过滤记录保存成功',
      data: { id: recordId }
    });
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('保存风控总过滤记录失败:', error);
    res.json({ success: false, message: error instanceof Error ? error.message : '保存风控总过滤记录失败' });
  }
});

// 2. 保存品类风控
router.post('/check-records/category-risk', async (req, res) => {
  const db = await getDb();
  try {
    const {
      category_name,
      object_name = '',
      variant_name = '',
      category_risk_type = '',
      system_result,
      result_reason = '',
      summary = '',
      items = [],
      extra_result = null,
      rule_version = 'v1'
    } = req.body;

    // 必填校验
    if (!category_name) {
      return res.json({ success: false, message: '品类名称不能为空' });
    }
    if (!system_result || !ALLOWED_SYSTEM_RESULTS.includes(system_result)) {
      return res.json({ success: false, message: `system_result 必须是 ${ALLOWED_SYSTEM_RESULTS.join(', ')} 之一` });
    }
    if (!Array.isArray(items)) {
      return res.json({ success: false, message: 'items 必须是数组' });
    }

    // 处理 extra_result_json
    const extra_result_json = extra_result ? JSON.stringify(extra_result) : null;

    // 事务处理
    await db.run('BEGIN TRANSACTION');

    // 插入主记录
    const recordResult = await db.run(`
      INSERT INTO risk_check_records (
        review_type, category_name, object_name, variant_name,
        category_risk_type, system_result, result_reason, summary,
        extra_result_json, rule_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'category_risk',
      category_name,
      object_name,
      variant_name,
      category_risk_type,
      system_result,
      result_reason,
      summary,
      extra_result_json,
      rule_version
    ]);

    const recordId = recordResult.lastID;

    // 插入检查项
    for (const item of items) {
      await db.run(`
        INSERT INTO risk_check_record_items (
          record_id, item_key, item_label, group_name, item_value,
          trigger_type, trigger_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        recordId,
        item.item_key,
        item.item_label,
        item.group_name || '',
        item.item_value,
        item.trigger_type || 'none',
        item.trigger_reason || ''
      ]);
    }

    await db.run('COMMIT');

    res.json({
      success: true,
      message: '品类风控记录保存成功',
      data: { id: recordId }
    });
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('保存品类风控记录失败:', error);
    res.json({ success: false, message: error instanceof Error ? error.message : '保存品类风控记录失败' });
  }
});

// 3. 查询风控检查记录列表
router.get('/check-records', async (req, res) => {
  try {
    const db = await getDb();
    const { review_type, category_name, category_risk_type, system_result, date_from, date_to } = req.query;

    let query = `
      SELECT id, review_type, category_name, object_name, variant_name,
             category_risk_type, system_result, result_reason, summary,
             extra_result_json, rule_version, created_at
      FROM risk_check_records
      WHERE 1=1
    `;
    const params: any[] = [];

    if (review_type) {
      query += ' AND review_type = ?';
      params.push(review_type);
    }
    if (category_name) {
      query += ' AND category_name = ?';
      params.push(category_name);
    }
    if (category_risk_type) {
      query += ' AND category_risk_type = ?';
      params.push(category_risk_type);
    }
    if (system_result) {
      query += ' AND system_result = ?';
      params.push(system_result);
    }
    if (date_from) {
      query += ' AND created_at >= ?';
      params.push(date_from);
    }
    if (date_to) {
      query += ' AND created_at <= ?';
      params.push(date_to);
    }

    query += ' ORDER BY created_at DESC';

    const records = await db.all(query, params);

    // 解析 extra_result_json
    const result = records.map(r => {
      if (r.extra_result_json) {
        try {
          return { ...r, extra_result: JSON.parse(r.extra_result_json) };
        } catch {
          return { ...r, extra_result: null };
        }
      }
      return { ...r, extra_result: null };
    });

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('查询风控检查记录列表失败:', error);
    res.json({ success: false, message: error instanceof Error ? error.message : '查询风控检查记录列表失败' });
  }
});

// 4. 查询风控检查记录详情
router.get('/check-records/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const record = await db.get('SELECT * FROM risk_check_records WHERE id = ?', [id]);
    if (!record) {
      return res.json({ success: false, message: '风控检查记录不存在' });
    }

    const items = await db.all(`
      SELECT id, item_key, item_label, group_name, item_value,
             trigger_type, trigger_reason
      FROM risk_check_record_items
      WHERE record_id = ?
      ORDER BY id ASC
    `, [id]);

    // 解析 extra_result_json
    const recordWithExtra = { ...record };
    if (record.extra_result_json) {
      try {
        recordWithExtra.extra_result = JSON.parse(record.extra_result_json);
      } catch {
        recordWithExtra.extra_result = null;
      }
    } else {
      recordWithExtra.extra_result = null;
    }

    res.json({ success: true, data: { record: recordWithExtra, items } });
  } catch (error) {
    console.error('查询风控检查记录详情失败:', error);
    res.json({ success: false, message: error instanceof Error ? error.message : '查询风控检查记录详情失败' });
  }
});

// 5. 删除风控检查记录
router.delete('/check-records/:id', async (req, res) => {
  const db = await getDb();
  try {
    const { id } = req.params;

    // 检查记录是否存在
    const record = await db.get('SELECT id FROM risk_check_records WHERE id = ?', [id]);
    if (!record) {
      return res.json({ success: false, message: '风控检查记录不存在' });
    }

    // 事务处理
    await db.run('BEGIN TRANSACTION');

    // 先删除关联项
    await db.run('DELETE FROM risk_check_record_items WHERE record_id = ?', [id]);

    // 再删除主记录
    await db.run('DELETE FROM risk_check_records WHERE id = ?', [id]);

    await db.run('COMMIT');

    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('删除风控检查记录失败:', error);
    res.json({ success: false, message: error instanceof Error ? error.message : '删除风控检查记录失败' });
  }
});

export default router;