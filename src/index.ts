import express from 'express';
import getDb from './config/database';

const app = express();
const port = process.env.PORT || 3001;

// 测试数据库连接
app.get('/db-test', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.get('SELECT 1 + 1 as result');
    res.json({
      status: 'success',
      message: 'Database connection established',
      result: result
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Database connection failed',
      error: error.message
    });
  }
});

// 基本路由
app.get('/', (req, res) => {
  res.json({
    message: 'Price Dashboard API',
    status: 'running',
    version: '1.0.0'
  });
});

// 健康检查路由
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy'
  });
});

// 启动服务器
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
