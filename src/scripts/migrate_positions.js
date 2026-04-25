const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// 数据库路径（使用开发环境数据库）
const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'db', 'price_dashboard_dev.db');

// 备份文件路径
const backupFilePath = path.join(process.cwd(), 'positions_backup.json');

// 统计信息
let stats = {
  positions: { imported: 0, skipped: 0 },
  batches: { imported: 0, skipped: 0 }
};

// 运行迁移
async function runMigrations() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }

      // 确保迁移表存在
      db.run(
        `CREATE TABLE IF NOT EXISTS migrations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        (createErr) => {
          if (createErr) {
            db.close();
            reject(createErr);
            return;
          }

          // 检查是否已执行过添加 source_id 的迁移
          db.get(
            'SELECT id FROM migrations WHERE id = ?',
            ['20260425_002'],
            (getErr, row) => {
              if (getErr) {
                db.close();
                reject(getErr);
                return;
              }

              if (!row) {
                console.log('Executing migration: Add source_id to positions table');
                // 执行迁移
                db.exec(
                  'ALTER TABLE positions ADD COLUMN source_id TEXT;',
                  (execErr) => {
                    if (execErr) {
                      db.close();
                      reject(execErr);
                      return;
                    }

                    // 记录迁移
                    db.run(
                      'INSERT INTO migrations (id, name) VALUES (?, ?)',
                      ['20260425_002', 'Add source_id to positions table'],
                      (insertErr) => {
                        if (insertErr) {
                          db.close();
                          reject(insertErr);
                          return;
                        }

                        console.log('Migration executed successfully');
                        db.close();
                        resolve();
                      }
                    );
                  }
                );
              } else {
                console.log('Migration already executed, skipping');
                db.close();
                resolve();
              }
            }
          );
        }
      );
    });
  });
}

// 导入 positions 数据
async function importPositions() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }

      // 读取备份文件
      fs.readFile(backupFilePath, 'utf8', (readErr, data) => {
        if (readErr) {
          db.close();
          reject(readErr);
          return;
        }

        try {
          const positions = JSON.parse(data);
          let processed = 0;

          // 处理每个仓位
          positions.forEach((position) => {
            // 检查仓位是否已存在
            db.get(
              'SELECT id FROM positions WHERE source_id = ?',
              [position.id],
              (getErr, row) => {
                if (getErr) {
                  db.close();
                  reject(getErr);
                  return;
                }

                if (row) {
                  // 已存在，跳过
                  stats.positions.skipped++;
                } else {
                  // 不存在，插入
                  db.run(
                    `INSERT INTO positions (
                      category_name, object_name, variant_name, total_quantity, 
                      total_cost, avg_price, source_id, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                      position.category,
                      position.object,
                      position.variant || '',
                      position.quantity,
                      position.totalCost,
                      position.averagePrice,
                      position.id,
                      new Date().toISOString(),
                      new Date().toISOString()
                    ],
                    (insertErr) => {
                      if (insertErr) {
                        db.close();
                        reject(insertErr);
                        return;
                      }
                      stats.positions.imported++;
                    }
                  );
                }

                processed++;
                if (processed === positions.length) {
                  resolve();
                }
              }
            );
          });
        } catch (parseErr) {
          db.close();
          reject(parseErr);
        }
      });
    });
  });
}

// 导入 position_batches 数据
async function importBatches() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }

      // 读取备份文件
      fs.readFile(backupFilePath, 'utf8', (readErr, data) => {
        if (readErr) {
          db.close();
          reject(readErr);
          return;
        }

        try {
          const positions = JSON.parse(data);
          let totalBatches = 0;
          let processedBatches = 0;

          // 计算总批次数
          positions.forEach(position => {
            if (position.batches && position.batches.length > 0) {
              totalBatches += position.batches.length;
            }
          });

          if (totalBatches === 0) {
            db.close();
            resolve();
            return;
          }

          // 处理每个仓位的批次
          positions.forEach((position) => {
            if (position.batches && position.batches.length > 0) {
              position.batches.forEach((batch) => {
                // 查找对应的 position_id
                db.get(
                  'SELECT id FROM positions WHERE source_id = ?',
                  [position.id],
                  (posErr, posRow) => {
                    if (posErr) {
                      db.close();
                      reject(posErr);
                      return;
                    }

                    if (posRow) {
                      // 检查批次是否已存在
                      db.get(
                        'SELECT id FROM position_batches WHERE source_id = ?',
                        [batch.id],
                        (getErr, row) => {
                          if (getErr) {
                            db.close();
                            reject(getErr);
                            return;
                          }

                          if (row) {
                            // 已存在，跳过
                            stats.batches.skipped++;
                          } else {
                            // 插入批次
                            db.run(
                              `INSERT INTO position_batches (
                                position_id, batch_date, batch_price, batch_quantity, 
                                batch_amount, remaining_quantity, source_id, note, 
                                created_at, updated_at
                              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                              [
                                posRow.id,
                                batch.date,
                                batch.price,
                                batch.quantity,
                                batch.totalAmount,
                                batch.quantity, // remaining_quantity = batch_quantity
                                batch.id,
                                batch.note || '',
                                new Date().toISOString(),
                                new Date().toISOString()
                              ],
                              (insertErr) => {
                                if (insertErr) {
                                  db.close();
                                  reject(insertErr);
                                  return;
                                }
                                stats.batches.imported++;
                              }
                            );
                          }

                          processedBatches++;
                          if (processedBatches === totalBatches) {
                            db.close();
                            resolve();
                          }
                        }
                      );
                    } else {
                      // 仓位不存在，跳过批次
                      stats.batches.skipped++;
                      processedBatches++;
                      if (processedBatches === totalBatches) {
                        db.close();
                        resolve();
                      }
                    }
                  }
                );
              });
            }
          });
        } catch (parseErr) {
          db.close();
          reject(parseErr);
        }
      });
    });
  });
}

// 主函数
async function main() {
  try {
    console.log('Starting migration...');
    
    // 运行迁移
    await runMigrations();
    console.log('Migrations completed');
    
    // 导入 positions
    await importPositions();
    console.log('Positions import completed');
    
    // 导入 batches
    await importBatches();
    console.log('Batches import completed');
    
    // 打印统计信息
    console.log('\nMigration Statistics:');
    console.log(`Positions: ${stats.positions.imported} imported, ${stats.positions.skipped} skipped`);
    console.log(`Batches: ${stats.batches.imported} imported, ${stats.batches.skipped} skipped`);
    console.log('\nMigration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// 执行主函数
main();