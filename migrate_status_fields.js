const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

// 数据库路径
const backupPath = "./db/price_dashboard_备份.db";
const prodPath = "./db/price_dashboard_prod.db";

// 先从备份恢复数据
function restoreFromBackup() {
  return new Promise((resolve, reject) => {
    console.log('开始从备份恢复数据...');
    
    // 检查备份文件是否存在
    if (!fs.existsSync(backupPath)) {
      reject(new Error('备份文件不存在'));
      return;
    }
    
    // 复制备份文件到正式库
    try {
      fs.copyFileSync(backupPath, prodPath);
      console.log('数据恢复成功');
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

// 连接数据库
function connectToDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(prodPath, (err) => {
      if (err) {
        reject(err);
        return;
      }
      console.log('成功连接到数据库');
      resolve(db);
    });
  });
}

// 开始迁移
async function startMigration() {
  try {
    // 1. 从备份恢复数据
    await restoreFromBackup();
    
    // 2. 连接数据库
    const db = await connectToDatabase();
    
    // 3. 开始迁移
    await migrateDatabase(db);
    
    // 4. 关闭数据库连接
    db.close((err) => {
      if (err) {
        console.error('关闭数据库连接失败:', err.message);
      } else {
        console.log('数据库连接已关闭');
      }
    });
    
    console.log('\n迁移完成！');
  } catch (error) {
    console.error('迁移失败:', error.message);
  }
}

// 迁移函数
async function migrateDatabase(db) {
  try {
    // 1. 为 buying_plans 表添加 status 字段
    await addStatusField(db, 'buying_plans');
    
    // 2. 为 selling_plans 表添加 status 字段
    await addStatusField(db, 'selling_plans');
    
    // 3. 验证迁移结果
    await verifyMigration(db);
    
  } catch (error) {
    throw error;
  }
}

// 添加 status 字段的函数
function addStatusField(db, tableName) {
  return new Promise((resolve, reject) => {
    const sql = `ALTER TABLE ${tableName} ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`;
    
    db.run(sql, (err) => {
      if (err) {
        // 如果字段已存在，忽略错误
        if (err.message.includes('duplicate column name')) {
          console.log(`表 ${tableName} 的 status 字段已存在，跳过`);
          resolve();
        } else {
          reject(err);
        }
      } else {
        console.log(`成功为表 ${tableName} 添加 status 字段`);
        resolve();
      }
    });
  });
}

// 验证迁移结果
function verifyMigration(db) {
  return new Promise((resolve, reject) => {
    console.log('\n开始验证迁移结果...');
    
    // 检查 buying_plans 表结构
    db.all("PRAGMA table_info(buying_plans)", (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      
      console.log('\nbuying_plans 表结构:');
      rows.forEach(row => {
        console.log(`${row.name} (${row.type}) ${row.notnull ? 'NOT NULL' : ''} ${row.dflt_value ? `DEFAULT ${row.dflt_value}` : ''}`);
      });
      
      // 检查 selling_plans 表结构
      db.all("PRAGMA table_info(selling_plans)", (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        
        console.log('\nselling_plans 表结构:');
        rows.forEach(row => {
          console.log(`${row.name} (${row.type}) ${row.notnull ? 'NOT NULL' : ''} ${row.dflt_value ? `DEFAULT ${row.dflt_value}` : ''}`);
        });
        
        // 检查旧数据的 status 值
        db.get("SELECT COUNT(*) as count, status FROM buying_plans GROUP BY status", (err, result) => {
          if (err) {
            reject(err);
            return;
          }
          
          console.log('\nbuying_plans 表数据状态分布:');
          if (result) {
            console.log(`状态: ${result.status}, 数量: ${result.count}`);
          } else {
            console.log('表中无数据');
          }
          
          db.get("SELECT COUNT(*) as count, status FROM selling_plans GROUP BY status", (err, result) => {
            if (err) {
              reject(err);
              return;
            }
            
            console.log('\nselling_plans 表数据状态分布:');
            if (result) {
              console.log(`状态: ${result.status}, 数量: ${result.count}`);
            } else {
              console.log('表中无数据');
            }
            
            resolve();
          });
        });
      });
    });
  });
}

// 启动迁移
startMigration();
