import express from 'express';
import getDb from '../config/database';
import {
  buildSilverAnchorItemValue,
  getSilverAnchorEvidence,
  usesSilverAnchorEvidence
} from '../services/marketAnchorService';
import {
  buildCoinSilverPremiumItemValue,
  getCoinSilverPremiumContext,
  type CoinSilverPremiumInput
} from '../services/coinSilverPremiumService';

const router = express.Router();

const ALLOWED_SYSTEM_RESULTS = ['reject', 'watch', 'need_category_risk', 'pass'];

const normalizeText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const normalizeOptionalId = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseRecordExtra = (record: any) => {
  if (!record) return record;
  if (!record.extra_result_json) {
    return { ...record, extra_result: null };
  }
  try {
    return { ...record, extra_result: JSON.parse(record.extra_result_json) };
  } catch {
    return { ...record, extra_result: null };
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const attachSilverAnchorEvidence = async (
  categoryName: string,
  categoryRiskType: string,
  objectName: string,
  variantName: string,
  extraResult: unknown,
  items: any[]
) => {
  if (!usesSilverAnchorEvidence(categoryName, categoryRiskType)) {
    return {
      extraResult: isPlainObject(extraResult) ? extraResult : null,
      items
    };
  }

  const anchor = await getSilverAnchorEvidence({ refresh: 'stale' });
  const nextExtraResult: Record<string, unknown> = isPlainObject(extraResult)
    ? { ...extraResult }
    : {};
  const snapshot = isPlainObject(nextExtraResult.risk_evidence_snapshot)
    ? { ...nextExtraResult.risk_evidence_snapshot }
    : null;

  if (snapshot) {
    nextExtraResult.risk_evidence_snapshot = {
      ...snapshot,
      market_anchor: {
        ...(isPlainObject(snapshot.market_anchor) ? snapshot.market_anchor : {}),
        silver_anchor: anchor
      }
    };
  }
  nextExtraResult.market_anchor_snapshot = {
    ...(isPlainObject(nextExtraResult.market_anchor_snapshot) ? nextExtraResult.market_anchor_snapshot : {}),
    silver_anchor: anchor
  };

  const rawPremiumInput = isPlainObject(nextExtraResult.coin_silver_premium_input)
    ? nextExtraResult.coin_silver_premium_input
    : null;
  const premiumInput: CoinSilverPremiumInput | undefined = rawPremiumInput
    ? {
        reference_price: rawPremiumInput.reference_price === null || rawPremiumInput.reference_price === undefined
          ? null
          : Number(rawPremiumInput.reference_price),
        silver_grams: rawPremiumInput.silver_grams === null || rawPremiumInput.silver_grams === undefined
          ? null
          : Number(rawPremiumInput.silver_grams),
        price_source: normalizeText(rawPremiumInput.price_source),
        price_effective_date: normalizeText(rawPremiumInput.price_effective_date),
        weight_basis: normalizeText(rawPremiumInput.weight_basis)
      }
    : undefined;
  const premiumContext = categoryName === '纪念币' || categoryRiskType === 'commemorative_coin'
    ? await getCoinSilverPremiumContext({
        objectName,
        variantName,
        input: premiumInput,
        anchor,
        marketValues: Object.fromEntries(
          items
            .filter(item => normalizeText(item?.item_key))
            .map(item => [normalizeText(item.item_key), item?.item_value])
        )
      })
    : null;
  const premiumSnapshot = premiumContext?.calculation || null;

  if (premiumSnapshot) {
    nextExtraResult.coin_silver_premium_snapshot = premiumSnapshot;
    if (snapshot && isPlainObject(nextExtraResult.risk_evidence_snapshot)) {
      const nextSnapshot = nextExtraResult.risk_evidence_snapshot;
      nextExtraResult.risk_evidence_snapshot = {
        ...nextSnapshot,
        market_anchor: {
          ...(isPlainObject(nextSnapshot.market_anchor) ? nextSnapshot.market_anchor : {}),
          silver_anchor: anchor,
          coin_silver_premium: premiumSnapshot
        }
      };
    }
  }

  const hasSilverAnchorItem = items.some(item => item?.item_key === 'silver_market_anchor');
  const hasCoinPremiumItem = items.some(item => item?.item_key === 'coin_silver_premium');
  const augmentedItems = hasSilverAnchorItem
    ? [...items]
    : [
        ...items,
        {
          item_key: 'silver_market_anchor',
          item_label: '银价锚背景',
          group_name: '行情锚点',
          item_value: buildSilverAnchorItemValue(anchor),
          trigger_type: 'none',
          trigger_reason: anchor.risk_reference_note || anchor.evidence_note
        }
      ];
  if (premiumSnapshot && !hasCoinPremiumItem) {
    augmentedItems.push({
      item_key: 'coin_silver_premium',
      item_label: '银本体溢价',
      group_name: '行情锚点',
      item_value: buildCoinSilverPremiumItemValue(premiumSnapshot),
      trigger_type: 'none',
      trigger_reason: premiumSnapshot.risk_note
    });
  }

  return {
    extraResult: nextExtraResult,
    items: augmentedItems
  };
};

// ========== 风控检查记录接口 ==========
// 1. 保存风控总过滤
router.post('/check-records/general-filter', async (req, res) => {
  const db = await getDb();
  try {
    const {
      category_name = '',
      object_name = '',
      variant_name = '',
      system_result,
      result_reason = '',
      summary = '',
      items = [],
      rule_version = 'v1'
    } = req.body;

    // 必填校验
    if (!system_result || !ALLOWED_SYSTEM_RESULTS.includes(system_result)) {
      return res.status(400).json({ success: false, message: `system_result 必须是 ${ALLOWED_SYSTEM_RESULTS.join(', ')} 之一` });
    }
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'items 必须是数组' });
    }

    // 事务处理
    await db.run('BEGIN TRANSACTION');

    // 插入主记录
    const recordResult = await db.run(`
      INSERT INTO risk_check_records (
        review_type, category_name, object_name, variant_name,
        category_risk_type, parent_record_id, system_result, result_reason, summary,
        extra_result_json, rule_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'general_filter',
      normalizeText(category_name),
      normalizeText(object_name),
      normalizeText(variant_name),
      '', // category_risk_type
      null,
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
    await db.run('ROLLBACK').catch(() => undefined);
    console.error('保存风控总过滤记录失败:', error);
    res.status(500).json({ success: false, message: error instanceof Error ? error.message : '保存风控总过滤记录失败' });
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
      parent_record_id = null,
      rule_version = 'v1'
    } = req.body;
    const parentRecordId = normalizeOptionalId(parent_record_id);

    // 必填校验
    if (!category_name) {
      return res.status(400).json({ success: false, message: '品类名称不能为空' });
    }
    if (!system_result || !ALLOWED_SYSTEM_RESULTS.includes(system_result)) {
      return res.status(400).json({ success: false, message: `system_result 必须是 ${ALLOWED_SYSTEM_RESULTS.join(', ')} 之一` });
    }
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'items 必须是数组' });
    }
    if (parentRecordId) {
      const parentRecord = await db.get(
        "SELECT id FROM risk_check_records WHERE id = ? AND review_type = 'general_filter'",
        [parentRecordId]
      );
      if (!parentRecord) {
        return res.status(400).json({ success: false, message: '关联的风控总过滤记录不存在' });
      }
    }

    const augmented = await attachSilverAnchorEvidence(
      normalizeText(category_name),
      normalizeText(category_risk_type),
      normalizeText(object_name),
      normalizeText(variant_name),
      extra_result,
      items
    );
    const recordItems = augmented.items;

    // 处理 extra_result_json
    const extra_result_json = augmented.extraResult ? JSON.stringify(augmented.extraResult) : null;

    // 事务处理
    await db.run('BEGIN TRANSACTION');

    // 插入主记录
    const recordResult = await db.run(`
      INSERT INTO risk_check_records (
        review_type, category_name, object_name, variant_name,
        category_risk_type, parent_record_id, system_result, result_reason, summary,
        extra_result_json, rule_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'category_risk',
      normalizeText(category_name),
      normalizeText(object_name),
      normalizeText(variant_name),
      category_risk_type,
      parentRecordId,
      system_result,
      result_reason,
      summary,
      extra_result_json,
      rule_version
    ]);

    const recordId = recordResult.lastID;

    // 插入检查项
    for (const item of recordItems) {
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

    if (parentRecordId) {
      await db.run(`
        UPDATE risk_check_records
        SET
          category_name = CASE WHEN category_name IS NULL OR category_name = '' THEN ? ELSE category_name END,
          object_name = CASE WHEN object_name IS NULL OR object_name = '' THEN ? ELSE object_name END,
          variant_name = CASE WHEN variant_name IS NULL OR variant_name = '' THEN ? ELSE variant_name END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        normalizeText(category_name),
        normalizeText(object_name),
        normalizeText(variant_name),
        parentRecordId
      ]);
    }

    await db.run('COMMIT');

    res.json({
      success: true,
      message: '品类风控记录保存成功',
      data: { id: recordId, system_result }
    });
  } catch (error) {
    await db.run('ROLLBACK').catch(() => undefined);
    console.error('保存品类风控记录失败:', error);
    res.status(500).json({ success: false, message: error instanceof Error ? error.message : '保存品类风控记录失败' });
  }
});

// 3. 查询风控检查记录列表
router.get('/check-records', async (req, res) => {
  try {
    const db = await getDb();
    const {
      review_type,
      category_name,
      object_name,
      variant_name,
      category_risk_type,
      system_result,
      date_from,
      date_to
    } = req.query;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 100)
      : null;

    let query = `
      SELECT r.id, r.review_type, r.category_name, r.object_name, r.variant_name,
             c.id AS category_id, o.id AS object_id, COALESCE(v.id, 0) AS variant_id,
             r.category_risk_type, r.parent_record_id, r.system_result, r.result_reason,
             r.summary, r.extra_result_json, r.rule_version, r.created_at, r.updated_at,
             (
               SELECT COUNT(1)
               FROM risk_check_records child
               WHERE child.parent_record_id = r.id
             ) AS child_record_count,
             (
               SELECT MAX(child.id)
               FROM risk_check_records child
               WHERE child.parent_record_id = r.id
             ) AS latest_child_record_id
      FROM risk_check_records r
      LEFT JOIN categories c ON c.name = r.category_name AND COALESCE(c.is_archived, 0) = 0
      LEFT JOIN objects o ON o.category_id = c.id AND o.name = r.object_name AND COALESCE(o.is_archived, 0) = 0
      LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(r.variant_name, '') AND COALESCE(v.is_archived, 0) = 0
      WHERE 1=1
    `;
    const params: any[] = [];

    if (review_type) {
      query += ' AND r.review_type = ?';
      params.push(review_type);
    }
    if (category_name) {
      query += ' AND r.category_name = ?';
      params.push(category_name);
    }
    if (object_name) {
      query += " AND (r.object_name = ? OR r.object_name IS NULL OR r.object_name = '')";
      params.push(object_name);
    }
    if (variant_name) {
      query += " AND (r.variant_name = ? OR r.variant_name IS NULL OR r.variant_name = '')";
      params.push(variant_name);
    }
    if (category_risk_type) {
      query += ' AND r.category_risk_type = ?';
      params.push(category_risk_type);
    }
    if (system_result) {
      query += ' AND r.system_result = ?';
      params.push(system_result);
    }
    if (date_from) {
      query += ' AND r.created_at >= ?';
      params.push(date_from);
    }
    if (date_to) {
      query += ' AND r.created_at <= ?';
      params.push(date_to);
    }

    query += ' ORDER BY r.created_at DESC';
    if (limit) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    const records = await db.all(query, params);

    // 解析 extra_result_json
    const result = records.map(parseRecordExtra);

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('查询风控检查记录列表失败:', error);
    res.status(500).json({ success: false, message: error instanceof Error ? error.message : '查询风控检查记录列表失败' });
  }
});

// 4. 查询风控检查记录详情
router.get('/check-records/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;

    const record = await db.get(`
      SELECT r.*, c.id AS category_id, o.id AS object_id, COALESCE(v.id, 0) AS variant_id
      FROM risk_check_records r
      LEFT JOIN categories c ON c.name = r.category_name AND COALESCE(c.is_archived, 0) = 0
      LEFT JOIN objects o ON o.category_id = c.id AND o.name = r.object_name AND COALESCE(o.is_archived, 0) = 0
      LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(r.variant_name, '') AND COALESCE(v.is_archived, 0) = 0
      WHERE r.id = ?
    `, [id]);
    if (!record) {
      return res.status(404).json({ success: false, message: '风控检查记录不存在' });
    }

    const items = await db.all(`
      SELECT id, item_key, item_label, group_name, item_value,
             trigger_type, trigger_reason
      FROM risk_check_record_items
      WHERE record_id = ?
      ORDER BY id ASC
    `, [id]);

    const parentRecord = record.parent_record_id
      ? await db.get(`
        SELECT id, review_type, category_name, object_name, variant_name,
               category_risk_type, parent_record_id, system_result, result_reason,
               summary, extra_result_json, rule_version, created_at, updated_at
        FROM risk_check_records
        WHERE id = ?
      `, [record.parent_record_id])
      : null;

    const childRecords = await db.all(`
      SELECT id, review_type, category_name, object_name, variant_name,
             category_risk_type, parent_record_id, system_result, result_reason,
             summary, extra_result_json, rule_version, created_at, updated_at
      FROM risk_check_records
      WHERE parent_record_id = ?
      ORDER BY created_at DESC
    `, [id]);

    res.json({
      success: true,
      data: {
        record: parseRecordExtra(record),
        items,
        parent_record: parseRecordExtra(parentRecord),
        child_records: childRecords.map(parseRecordExtra)
      }
    });
  } catch (error) {
    console.error('查询风控检查记录详情失败:', error);
    res.status(500).json({ success: false, message: error instanceof Error ? error.message : '查询风控检查记录详情失败' });
  }
});

// 5. 删除风控检查记录
router.delete('/check-records/:id', async (req, res) => {
  const db = await getDb();
  let transactionStarted = false;
  try {
    const { id } = req.params;

    // 检查记录是否存在
    const record = await db.get('SELECT id FROM risk_check_records WHERE id = ?', [id]);
    if (!record) {
      return res.status(404).json({ success: false, message: '风控检查记录不存在' });
    }

    // 事务处理
    await db.run('BEGIN TRANSACTION');
    transactionStarted = true;

    // 先删除关联项
    await db.run('DELETE FROM risk_check_record_items WHERE record_id = ?', [id]);

    // 保留子记录本身，断开已经删除的父记录引用
    await db.run('UPDATE risk_check_records SET parent_record_id = NULL WHERE parent_record_id = ?', [id]);

    // 再删除主记录
    await db.run('DELETE FROM risk_check_records WHERE id = ?', [id]);

    await db.run('COMMIT');
    transactionStarted = false;

    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    if (transactionStarted) {
      await db.run('ROLLBACK');
    }
    console.error('删除风控检查记录失败:', error);
    res.status(500).json({ success: false, message: error instanceof Error ? error.message : '删除风控检查记录失败' });
  }
});

export default router;
