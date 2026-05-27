#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const DEFAULT_DATABASE_PATH = '/Volumes/7100/price-dashboard-data/db/price_dashboard_dev.db';
const sourcePath = process.env.DB_PATH || DEFAULT_DATABASE_PATH;
const outputDir = process.env.SPLIT_DB_OUTPUT_DIR || path.join(path.dirname(sourcePath), 'split-preview');

const businessDbPath = path.join(outputDir, 'price_dashboard_business_dev.db');
const tradingDbPath = path.join(outputDir, 'price_dashboard_trading_dev.db');
const manifestPath = path.join(outputDir, 'split_manifest.json');

const workspaceTables = new Set([
  'manual_todos',
  'task_center_tasks',
  'task_center_runs',
  'audit_logs',
  'workspace_tags'
]);

const sharedTables = new Set([
  'analysis_annotations',
  'user_preferences',
  'schema_migrations',
  'migrations',
  'sqlite_sequence'
]);

const explicitTradingTables = new Set([
  'fx_daily_rates'
]);

const tradingTablePatterns = [
  /^financial_/,
  /^finance_/,
  /^model_training_/,
  /^experiment_/,
  /^market_breadth$/,
  /^market_indices/,
  /^index_daily/,
  /^asset_/,
  /^etf_/,
  /^stock_/,
  /metal/i
];

const classifyTable = (tableName) => {
  if (workspaceTables.has(tableName)) return 'workspace-split';
  if (sharedTables.has(tableName)) return 'shared';
  if (explicitTradingTables.has(tableName)) return 'trading';
  if (tradingTablePatterns.some((pattern) => pattern.test(tableName))) return 'trading';
  return 'business';
};

const escapeSqlString = (value) => String(value).replace(/'/g, "''");

const openDb = (filename) => new sqlite3.Database(filename);

const all = (db, sql, params = []) => (
  new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  })
);

const run = (db, sql) => (
  new Promise((resolve, reject) => {
    db.run(sql, (error) => {
      if (error) reject(error);
      else resolve();
    });
  })
);

const close = (db) => (
  new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  })
);

async function vacuumInto(db, targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath);
  }
  await run(db, `VACUUM INTO '${escapeSqlString(targetPath)}'`);
}

async function main() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source database does not exist: ${sourcePath}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const db = openDb(sourcePath);
  try {
    await run(db, 'PRAGMA wal_checkpoint(FULL)');
    await vacuumInto(db, businessDbPath);
    await vacuumInto(db, tradingDbPath);

    const tables = await all(
      db,
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`
    );

    const manifest = {
      generated_at: new Date().toISOString(),
      source_db: sourcePath,
      output_dir: outputDir,
      outputs: {
        business: businessDbPath,
        trading: tradingDbPath
      },
      mode: 'preview_copy_only',
      note: 'The generated databases are full physical copies. Table deletion and runtime cutover are intentionally separate steps.',
      tables: tables.map((row) => ({
        name: row.name,
        owner: classifyTable(row.name)
      }))
    };

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Split preview databases created:
  business: ${businessDbPath}
  trading:  ${tradingDbPath}
  manifest: ${manifestPath}`);
  } finally {
    await close(db);
  }
}

main().catch((error) => {
  console.error(`[split-database-preview] ${error.message}`);
  process.exit(1);
});
