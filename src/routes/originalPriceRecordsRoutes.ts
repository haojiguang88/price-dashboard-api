import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 新增原始价格记录
router.post('/original-price-records', async (req, res) => {
  try {
    const db = await getDb();
    const { category_id, category_name, object_id, object_name, variant_id, variant_name, original_price, effective_date, source, reason, note } = req.body;
    
    if (!category_id || !category_name || !object_id || !object_name || original_price === undefined || !effective_date) {
      return res.status(400).json({ success: false, message: '缺少必填字段: category_id, category_name, object_id, object_name, original_price, effective_date' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO original_price_records (category_id, category_name, object_id, object_name, variant_id, variant_name, original_price, effective_date, source, reason, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [category_id, category_name, object_id, object_name, variant_id, variant_name, parseFloat(original_price), effective_date, source, reason, note, 0, now, now]
    );
    
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error creating original price record:', error);
    res.status(500).json({ success: false, message: '新增原始价格记录失败' });
  }
});

// 获取原始价格记录列表
router.get('/original-price-records', async (req, res) => {
  try {
    const db = await getDb();
    const records = await db.all('SELECT * FROM original_price_records WHERE is_deleted = 0 ORDER BY created_at DESC');
    res.json({ success: true, data: records });
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
    const record = await db.get('SELECT * FROM original_price_records WHERE id = ? AND is_deleted = 0', [id]);
    
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
    const { category_id, category_name, object_id, object_name, variant_id, variant_name, original_price, effective_date, source, reason, note } = req.body;
    
    if (!category_id || !category_name || !object_id || !object_name || original_price === undefined || !effective_date) {
      return res.status(400).json({ success: false, message: '缺少必填字段: category_id, category_name, object_id, object_name, original_price, effective_date' });
    }
    
    const existingRecord = await db.get('SELECT * FROM original_price_records WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '原始价格记录不存在' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE original_price_records SET category_id = ?, category_name = ?, object_id = ?, object_name = ?, variant_id = ?, variant_name = ?, original_price = ?, effective_date = ?, source = ?, reason = ?, note = ?, updated_at = ? WHERE id = ? AND is_deleted = 0',
      [category_id, category_name, object_id, object_name, variant_id, variant_name, parseFloat(original_price), effective_date, source, reason, note, now, id]
    );
    
    res.json({ success: true, data: { changes: result.changes } });
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
