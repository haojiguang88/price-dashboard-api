import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 卖出记录相关接口

// 获取卖出记录列表
router.get('/sell-records', async (req, res) => {
  try {
    const db = await getDb();
    const records = await db.all('SELECT * FROM sell_records ORDER BY sell_date DESC, created_at DESC');
    res.json({ status: 'success', data: records });
  } catch (error) {
    console.error('Error getting sell records:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: 'error', message: '获取卖出记录列表失败', error: errorMessage });
  }
});

export default router;