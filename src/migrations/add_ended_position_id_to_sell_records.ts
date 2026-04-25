import sqlite3 from 'sqlite3';

/**
 * Migration: Add ended_position_id field to sell_records table
 */
export const runMigration = (dbPath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }

      // Add ended_position_id field to sell_records table
      db.run(
        'ALTER TABLE sell_records ADD COLUMN ended_position_id INTEGER',
        (err) => {
          if (err) {
            // If the column already exists, ignore the error
            if (err.message.includes('duplicate column name')) {
              console.log('ended_position_id column already exists in sell_records table');
              resolve();
            } else {
              reject(err);
            }
          } else {
            console.log('Added ended_position_id column to sell_records table');
            resolve();
          }
          db.close();
        }
      );
    });
  });
};
