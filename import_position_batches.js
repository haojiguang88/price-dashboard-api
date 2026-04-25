const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

// 读取导出的 JSON 文件
const positionsData = JSON.parse(fs.readFileSync('positions_export.json', 'utf8'));

// 连接数据库
const db = new sqlite3.Database('./db/price_dashboard_dev.db');

db.serialize(() => {
  // 导入前清空表，避免重复导入
  db.run('DELETE FROM position_batches', (err) => {
    if (err) {
      console.error('Error clearing table:', err);
      return;
    }
    console.log('Table cleared successfully');

    // 批量插入数据
    let successCount = 0;
    let errorCount = 0;

    positionsData.forEach((position, positionIndex) => {
      // 查找对应的 position_id
      db.get('SELECT id FROM positions WHERE category_name = ? AND object_name = ? AND variant_name = ?', 
        [position.category, position.object, position.variant || ''], 
        (err, positionRow) => {
          if (err) {
            console.error('Error finding position:', err);
            errorCount++;
            return;
          }

          if (!positionRow) {
            console.error(`Position not found for: ${position.category} - ${position.object} - ${position.variant}`);
            errorCount++;
            return;
          }

          const positionId = positionRow.id;

          // 处理批次数据
          if (position.batches && position.batches.length > 0) {
            position.batches.forEach((batch, batchIndex) => {
              // 字段校验和类型转换
              const batchPrice = parseFloat(batch.price) || 0;
              const batchQuantity = parseInt(batch.quantity) || 0;
              const batchAmount = parseFloat(batch.amount) || 0;
              const remainingQuantity = batchQuantity; // 初始剩余数量等于批次数量

              // 关键字段校验
              if (!batch.date || !batchPrice || !batchQuantity) {
                console.error(`Missing required fields for batch ${batchIndex} in position ${positionIndex}:`, batch);
                errorCount++;
                return;
              }

              db.run(
                `INSERT INTO position_batches (source_id, position_id, batch_date, batch_price, batch_quantity, batch_amount, remaining_quantity, note) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  batch.id || null,
                  positionId,
                  batch.date,
                  batchPrice,
                  batchQuantity,
                  batchAmount,
                  remainingQuantity,
                  batch.note || ''
                ],
                function(err) {
                  if (err) {
                    console.error('Error inserting batch:', err);
                    errorCount++;
                  } else {
                    successCount++;
                  }
                }
              );
            });
          }
        }
      );
    });

    // 打印导入结果
    setTimeout(() => {
      console.log(`Import completed: ${successCount} success, ${errorCount} error`);
      db.close();
    }, 2000);
  });
});