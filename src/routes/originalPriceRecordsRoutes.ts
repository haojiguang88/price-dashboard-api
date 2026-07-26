import express from 'express';
import getDb from '../config/database';
import { isValidDateOnly } from '../utils/dateValidation';
import { validateActiveMasterTargetByIds } from '../utils/masterData';
import {
  calculateHistoricalCoinSilverPremiumSnapshot,
  inferCommemorativeCoinSilverWeight,
} from '../services/coinSilverPremiumService';

const router = express.Router();

interface OriginalPriceRecordRow {
  id: number;
  category_name: string;
  object_name: string;
  variant_name?: string | null;
  original_price: number;
  effective_date: string;
  reason?: string | null;
  note?: string | null;
  silver_anchor_date?: string | null;
  silver_anchor_close?: number | null;
  [key: string]: unknown;
}

const ORIGINAL_PRICE_RECORD_SELECT = `
  SELECT opr.*,
         CASE WHEN opr.category_name = '纪念币' THEN (
           SELECT anchor.trade_date
           FROM market_anchor_daily_prices anchor
           WHERE anchor.symbol = 'SGE_AGTD'
             AND anchor.source = 'tushare_sge'
             AND anchor.trade_date <= opr.effective_date
           ORDER BY anchor.trade_date DESC, anchor.id DESC
           LIMIT 1
         ) END AS silver_anchor_date,
         CASE WHEN opr.category_name = '纪念币' THEN (
           SELECT anchor.close
           FROM market_anchor_daily_prices anchor
           WHERE anchor.symbol = 'SGE_AGTD'
             AND anchor.source = 'tushare_sge'
             AND anchor.trade_date <= opr.effective_date
           ORDER BY anchor.trade_date DESC, anchor.id DESC
           LIMIT 1
         ) END AS silver_anchor_close
  FROM original_price_records opr
`;

const decorateOriginalPriceRecord = (row: OriginalPriceRecordRow | undefined) => {
  if (!row) return undefined;
  const {
    silver_anchor_date: silverAnchorDate,
    silver_anchor_close: silverAnchorClose,
    ...record
  } = row;
  if (row.category_name !== '纪念币') {
    return { ...record, silver_premium: null };
  }

  const inferredWeight = inferCommemorativeCoinSilverWeight(
    row.object_name,
    row.variant_name || '',
    [row.reason, row.note].filter(Boolean).join(' '),
  );
  const silverPremium = calculateHistoricalCoinSilverPremiumSnapshot({
    reference_price: row.original_price,
    silver_grams: inferredWeight.grams,
    price_effective_date: row.effective_date,
    weight_basis: inferredWeight.basis,
    price_source: `商品原始价格 #${row.id}`,
  }, {
    trade_date: silverAnchorDate,
    close: silverAnchorClose,
  });

  return { ...record, silver_premium: silverPremium };
};

const getOriginalPriceRecordById = async (db: any, id: number | string) => {
  const row: OriginalPriceRecordRow | undefined = await db.get(
    `${ORIGINAL_PRICE_RECORD_SELECT}
     WHERE opr.id = ? AND opr.is_deleted = 0`,
    [id],
  );
  return decorateOriginalPriceRecord(row);
};

// 新增原始价格记录
router.post('/original-price-records', async (req, res) => {
  try {
    const db = await getDb();
    const { category_id, object_id, variant_id, original_price, effective_date, source, reason, note } = req.body;
    
    if (!category_id || !object_id || original_price === undefined || !effective_date) {
      return res.status(400).json({ success: false, message: '缺少必填字段: category_id, object_id, original_price, effective_date' });
    }

    const normalizedPrice = Number(original_price);
    if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
      return res.status(400).json({ success: false, message: '原始价格必须是大于 0 的数字' });
    }

    if (!isValidDateOnly(String(effective_date).trim())) {
      return res.status(400).json({ success: false, message: '生效日期格式错误' });
    }

    const masterTarget = await validateActiveMasterTargetByIds(db, category_id, object_id, variant_id);
    if (!masterTarget.ok) {
      return res.status(400).json({ success: false, message: masterTarget.message });
    }
    
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO original_price_records (category_id, category_name, object_id, object_name, variant_id, variant_name, original_price, effective_date, source, reason, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        masterTarget.target.category_id,
        masterTarget.target.category_name,
        masterTarget.target.object_id,
        masterTarget.target.object_name,
        masterTarget.target.variant_id || null,
        masterTarget.target.variant_name,
        normalizedPrice,
        String(effective_date).trim(),
        source,
        reason,
        note,
        0,
        now,
        now
      ]
    );

    if (result.lastID === undefined) {
      throw new Error('Failed to create original price record: missing inserted id');
    }
    const record = await getOriginalPriceRecordById(db, result.lastID);
    if (!record) {
      return res.status(500).json({ success: false, message: '新增原始价格记录后读取失败' });
    }
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error creating original price record:', error);
    res.status(500).json({ success: false, message: '新增原始价格记录失败' });
  }
});

// 获取原始价格记录列表
router.get('/original-price-records', async (req, res) => {
  try {
    const db = await getDb();
    const requestedPage = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(req.query.pageSize || '50'), 10) || 50));
    const countRow = await db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM original_price_records WHERE is_deleted = 0'
    );
    const total = Number(countRow?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = await db.all<OriginalPriceRecordRow[]>(
      `${ORIGINAL_PRICE_RECORD_SELECT}
       WHERE opr.is_deleted = 0
       ORDER BY opr.effective_date DESC, datetime(opr.created_at) DESC, opr.id DESC
       LIMIT ? OFFSET ?`,
      [pageSize, (page - 1) * pageSize]
    );
    const records = rows.map((row) => decorateOriginalPriceRecord(row));
    res.json({
      success: true,
      data: {
        items: records,
        total,
        page,
        pageSize
      }
    });
  } catch (error) {
    console.error('Error getting original price records:', error);
    res.status(500).json({ success: false, message: '获取原始价格记录失败' });
  }
});

// 获取原始价格记录详情
router.get('/original-price-records/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const record = await getOriginalPriceRecordById(db, id);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '原始价格记录不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error getting original price record:', error);
    res.status(500).json({ success: false, message: '获取原始价格记录失败' });
  }
});

// 更新原始价格记录
router.put('/original-price-records/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { category_id, object_id, variant_id, original_price, effective_date, source, reason, note } = req.body;
    
    if (!category_id || !object_id || original_price === undefined || !effective_date) {
      return res.status(400).json({ success: false, message: '缺少必填字段: category_id, object_id, original_price, effective_date' });
    }
    
    const existingRecord = await db.get('SELECT * FROM original_price_records WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '原始价格记录不存在' });
    }

    const normalizedPrice = Number(original_price);
    if (!Number.isFinite(normalizedPrice) || normalizedPrice <= 0) {
      return res.status(400).json({ success: false, message: '原始价格必须是大于 0 的数字' });
    }

    if (!isValidDateOnly(String(effective_date).trim())) {
      return res.status(400).json({ success: false, message: '生效日期格式错误' });
    }

    const masterTarget = await validateActiveMasterTargetByIds(db, category_id, object_id, variant_id);
    if (!masterTarget.ok) {
      return res.status(400).json({ success: false, message: masterTarget.message });
    }
    
    const now = new Date().toISOString();
    await db.run(
      'UPDATE original_price_records SET category_id = ?, category_name = ?, object_id = ?, object_name = ?, variant_id = ?, variant_name = ?, original_price = ?, effective_date = ?, source = ?, reason = ?, note = ?, updated_at = ? WHERE id = ? AND is_deleted = 0',
      [
        masterTarget.target.category_id,
        masterTarget.target.category_name,
        masterTarget.target.object_id,
        masterTarget.target.object_name,
        masterTarget.target.variant_id || null,
        masterTarget.target.variant_name,
        normalizedPrice,
        String(effective_date).trim(),
        source,
        reason,
        note,
        now,
        id
      ]
    );

    const record = await getOriginalPriceRecordById(db, id);
    if (!record) {
      return res.status(500).json({ success: false, message: '更新原始价格记录后读取失败' });
    }
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error updating original price record:', error);
    res.status(500).json({ success: false, message: '更新原始价格记录失败' });
  }
});

// 软删除原始价格记录
router.delete('/original-price-records/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    const existingRecord = await db.get('SELECT * FROM original_price_records WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '原始价格记录不存在' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run('UPDATE original_price_records SET is_deleted = 1, updated_at = ? WHERE id = ?', [now, id]);
    
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting original price record:', error);
    res.status(500).json({ success: false, message: '删除原始价格记录失败' });
  }
});

export default router;
