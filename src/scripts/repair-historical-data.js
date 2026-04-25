const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 数据库路径
const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'db', 'price_dashboard_dev.db');

/**
 * 修复历史数据：关联 sell_records 和 ended_positions
 */
async function repairHistoricalData() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }

      console.log('开始修复历史数据...');

      // 步骤1：获取所有已结束仓位
      db.all('SELECT id, category_name, object_name, variant_name FROM ended_positions', (err, endedPositions) => {
        if (err) {
          db.close();
          reject(err);
          return;
        }

        let processed = 0;
        let total = endedPositions.length;

        if (total === 0) {
          console.log('没有已结束仓位记录，无需修复');
          db.close();
          resolve();
          return;
        }

        console.log(`找到 ${total} 条已结束仓位记录`);

        // 步骤2：为每个已结束仓位关联对应的卖出记录
        endedPositions.forEach((position) => {
          // 按 category_name, object_name, variant_name 匹配 sell_records
          db.run(
            `UPDATE sell_records 
             SET ended_position_id = ? 
             WHERE category_name = ? 
               AND object_name = ? 
               AND variant_name = ? 
               AND ended_position_id IS NULL`,
            [position.id, position.category_name, position.object_name, position.variant_name || ''],
            (err) => {
              if (err) {
                console.error(`修复仓位 ${position.id} 时出错:`, err);
              } else {
                console.log(`已关联仓位 ${position.id} 的卖出记录`);
              }

              processed++;
              if (processed === total) {
                console.log('历史数据修复完成');
                db.close();
                resolve();
              }
            }
          );
        });
      });
    });
  });
}

// 执行修复
if (require.main === module) {
  repairHistoricalData()
    .then(() => {
      console.log('修复完成');
      process.exit(0);
    })
    .catch((error) => {
      console.error('修复失败:', error);
      process.exit(1);
    });
}

module.exports = repairHistoricalData;
