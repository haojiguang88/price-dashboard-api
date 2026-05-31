import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 卖出记录相关接口

// 获取卖出记录列表
router.get('/sell-records', async (req, res) => {
  try {
    const db = await getDb();
    const includeArchived = ['1', 'true'].includes(String(req.query.include_archived || '').toLowerCase());
    const records = includeArchived
      ? await db.all('SELECT * FROM sell_records ORDER BY sell_date DESC, created_at DESC')
      : await db.all(`
          SELECT sr.*
          FROM sell_records sr
          LEFT JOIN categories c ON c.name = sr.category_name
          LEFT JOIN objects o ON o.category_id = c.id AND o.name = sr.object_name
          LEFT JOIN variants v ON v.object_id = o.id AND v.name = COALESCE(sr.variant_name, '') AND COALESCE(sr.variant_name, '') <> ''
          WHERE COALESCE(c.is_archived, 0) = 0
            AND COALESCE(o.is_archived, 0) = 0
            AND (COALESCE(sr.variant_name, '') = '' OR COALESCE(v.is_archived, 0) = 0)
          ORDER BY sr.sell_date DESC, sr.created_at DESC
        `);
    res.json({ status: 'success', data: records });
  } catch (error) {
    console.error('Error getting sell records:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: 'error', message: '获取卖出记录列表失败', error: errorMessage });
  }
});

export default router;
