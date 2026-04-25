import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 已结束仓位相关接口

// 获取已结束仓位列表
router.get('/ended-positions', async (req, res) => {
  try {
    const db = await getDb();
    const positions = await db.all('SELECT * FROM ended_positions ORDER BY sell_date DESC, created_at DESC');
    res.json({ status: 'success', data: positions });
  } catch (error) {
    console.error('Error getting ended positions:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: 'error', message: '获取已结束仓位列表失败', error: errorMessage });
  }
});

export default router;