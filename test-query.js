const sqlite3 = require('sqlite3').verbose();

// 连接到数据库
const db = new sqlite3.Database('./db/price_dashboard_dev.db');

// 测试查询
const category = '苹果手机';
const object_name = 'iPhone 16 128G';
const variant = '白色';

const query = `SELECT id, category, object_name, variant, price, date FROM price_records WHERE category = ? AND object_name = ? AND variant = ? ORDER BY date DESC, id DESC LIMIT 5`;

db.all(query, [category, object_name, variant], (err, rows) => {
  if (err) {
    console.error('Error executing query:', err);
  } else {
    console.log('Query results:', rows);
  }
  db.close();
});
