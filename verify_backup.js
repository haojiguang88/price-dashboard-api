const sqlite3 = require('sqlite3').verbose();

// 连接到恢复测试数据库
const db = new sqlite3.Database('./db/price_dashboard.restore.test.db');

// 核心表列表
const coreTables = [
  'categories',
  'objects',
  'variants',
  'price_records',
  'positions',
  'position_batches',
  'buying_plans',
  'selling_plans',
  'follows'
];

// 验证核心表和数据
async function verifyBackup() {
  console.log('开始验证恢复测试数据库...');
  console.log('================================');
  
  for (const table of coreTables) {
    await new Promise((resolve, reject) => {
      db.get(`SELECT COUNT(*) as count FROM ${table}`, (err, row) => {
        if (err) {
          console.log(`表 ${table}: 不存在`);
          resolve();
        } else {
          console.log(`表 ${table}: 存在，数据条数: ${row.count}`);
          resolve();
        }
      });
    });
  }
  
  console.log('================================');
  console.log('验证完成');
  db.close();
}

verifyBackup();