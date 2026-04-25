import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 已实现盈亏 TOP 接口
router.get('/realized-top', async (req, res) => {
  try {
    const db = await getDb();
    
    // 聚合计算每个品类/对象/变体的盈亏数据
    const realizedData = await db.all(`
      SELECT 
        category_name, 
        object_name, 
        COALESCE(variant_name, '') as variant_name, 
        SUM(quantity) as total_quantity, 
        SUM(amount) as total_amount, 
        SUM(cost) as total_cost, 
        SUM(profit) as total_profit
      FROM sell_records
      GROUP BY category_name, object_name, COALESCE(variant_name, '')
      HAVING SUM(profit) IS NOT NULL
    `);
    
    // 按盈亏排序，提取 TOP 10
    const topProfit = [...realizedData]
      .filter(item => item.total_profit > 0)
      .sort((a, b) => b.total_profit - a.total_profit)
      .slice(0, 10);
    
    const topLoss = [...realizedData]
      .filter(item => item.total_profit < 0)
      .sort((a, b) => a.total_profit - b.total_profit)
      .slice(0, 10);
    
    res.json({
      status: "success",
      data: {
        top_profit: topProfit,
        top_loss: topLoss
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取已实现盈亏 TOP 失败", error: errorMessage });
  }
});

export default router;
