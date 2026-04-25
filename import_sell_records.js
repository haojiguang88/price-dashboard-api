const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

// 读取导出的 JSON 文件
const data = JSON.parse(fs.readFileSync('sell_records_export.json', 'utf8'));

// 连接数据库
const db = new sqlite3.Database('./db/price_dashboard_dev.db');

db.serialize(() => {
  // 导入前清空表，避免重复导入
  db.run('DELETE FROM sell_records', (err) => {
    if (err) {
      console.error('Error clearing table:', err);
      return;
    }
    console.log('Table cleared successfully');

    // 批量插入数据
    let successCount = 0;
    let errorCount = 0;

    data.forEach((item, index) => {
      // 字段校验和类型转换
      const quantity = parseInt(item.quantity) || 0;
      const price = parseFloat(item.price) || 0;
      const amount = parseFloat(item.amount) || 0;
      const cost = parseFloat(item.cost) || 0;
      const profit = parseFloat(item.profit) || 0;
      const buyDate = item.buyDate || '';
      const sellDate = item.sellDate || '';

      // 关键字段校验
      if (!item.category || !item.object || !buyDate || !sellDate) {
        console.error(`Missing required fields for record ${index}:`, item);
        errorCount++;
        return;
      }

      db.run(
        `INSERT INTO sell_records (source_id, category_name, object_name, variant_name, quantity, price, amount, cost, profit, sell_date, buy_date, holding_period, note, batch_id, position_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id || null,
          item.category,
          item.object,
          item.variant || '',
          quantity,
          price,
          amount,
          cost,
          profit,
          sellDate,
          buyDate,
          item.holdingPeriod || '',
          item.note || '',
          item.batchId || '',
          item.positionId || ''
        ],
        function(err) {
          if (err) {
            console.error('Error inserting record:', err);
            errorCount++;
          } else {
            successCount++;
          }
        }
      );
    });

    // 打印导入结果
    setTimeout(() => {
      console.log(`Import completed: ${successCount} success, ${errorCount} error`);
      db.close();
    }, 1000);
  });
});