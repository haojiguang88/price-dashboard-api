#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { workspaceCenterPhysicalTables } = require('./workspace_center_table_boundary_plan');

const DEFAULT_BUSINESS_DB_PATH = '/Volumes/7100/price-dashboard-data/db/price_dashboard_business_dev.db';
const DEFAULT_TRADING_DB_PATH = '/Volumes/7100/price-dashboard-data/db/price_dashboard_trading_dev.db';

const businessDbPath = process.env.BUSINESS_DB_PATH || DEFAULT_BUSINESS_DB_PATH;
const tradingDbPath = process.env.TRADING_DB_PATH || DEFAULT_TRADING_DB_PATH;
const outputDir = process.env.WORKSPACE_CENTER_TABLE_BOUNDARY_OUTPUT_DIR
  || path.join(path.dirname(businessDbPath), 'split-preview');

const quoteIdentifier = (name) => `"${String(name).replace(/"/g, '""')}"`;
const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

const openReadonlyDb = (filename) => new sqlite3.Database(filename, sqlite3.OPEN_READONLY);

const all = (db, sql, params = []) => (
  new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  })
);

const get = (db, sql, params = []) => (
  new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
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

async function tableExists(db, tableName) {
  const row = await get(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName]
  );
  return Boolean(row);
}

async function getColumns(db, tableName) {
  return all(db, `PRAGMA table_info(${quoteIdentifier(tableName)})`);
}

async function getCreateSql(db, tableName) {
  const row = await get(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName]
  );
  return row?.sql || null;
}

async function countRows(db, tableName, where = '', params = []) {
  const row = await get(
    db,
    `SELECT COUNT(1) AS count FROM ${quoteIdentifier(tableName)}${where ? ` WHERE ${where}` : ''}`,
    params
  );
  return Number(row?.count || 0);
}

async function collectSidePlan(db, side, dbPath) {
  const tables = [];
  const blockers = [];

  for (const tablePlan of workspaceCenterPhysicalTables) {
    const sourceTable = tablePlan.sourceTable;
    const exists = await tableExists(db, sourceTable);
    if (!exists) {
      const issue = `${sourceTable}: missing in ${side} db`;
      blockers.push(issue);
      tables.push({
        ...tablePlan,
        side,
        db_path: dbPath,
        exists: false,
        total_rows: 0,
        keep_rows: 0,
        other_workspace_rows: 0,
        unknown_workspace_rows: 0,
        blocker: issue
      });
      continue;
    }

    const columns = await getColumns(db, sourceTable);
    const columnNames = new Set(columns.map((column) => column.name));
    const hasWorkspace = columnNames.has(tablePlan.splitColumn);
    if (!hasWorkspace) {
      blockers.push(`${sourceTable}: missing ${tablePlan.splitColumn} column`);
    }

    const splitValue = tablePlan.splitValue[side];
    const totalRows = await countRows(db, sourceTable);
    const keepRows = hasWorkspace
      ? await countRows(db, sourceTable, `${quoteIdentifier(tablePlan.splitColumn)} = ?`, [splitValue])
      : 0;
    const otherRows = hasWorkspace
      ? await countRows(
        db,
        sourceTable,
        `${quoteIdentifier(tablePlan.splitColumn)} IS NOT NULL AND ${quoteIdentifier(tablePlan.splitColumn)} <> ?`,
        [splitValue]
      )
      : totalRows;
    const unknownRows = hasWorkspace
      ? await countRows(
        db,
        sourceTable,
        `${quoteIdentifier(tablePlan.splitColumn)} IS NULL OR TRIM(${quoteIdentifier(tablePlan.splitColumn)}) = ''`
      )
      : totalRows;

    if (otherRows > 0) {
      blockers.push(`${sourceTable}: ${otherRows} rows belong to the other workspace in ${side} db`);
    }
    if (unknownRows > 0) {
      blockers.push(`${sourceTable}: ${unknownRows} rows have unknown workspace in ${side} db`);
    }

    tables.push({
      ...tablePlan,
      side,
      db_path: dbPath,
      exists: true,
      total_rows: totalRows,
      keep_rows: keepRows,
      other_workspace_rows: otherRows,
      unknown_workspace_rows: unknownRows,
      create_sql: await getCreateSql(db, sourceTable)
    });
  }

  return { side, db_path: dbPath, tables, blockers };
}

function buildDryRunSql(sidePlan) {
  const lines = [
    '-- Price Dashboard workspace-center physical table boundary dry-run',
    `-- Target side: ${sidePlan.side}`,
    `-- Source DB: ${sidePlan.db_path}`,
    `-- Generated at: ${new Date().toISOString()}`,
    '--',
    '-- This SQL is for review only. It uses TEMP preview tables and does not persist changes to the DB file.',
    '-- Final physical split keeps the runtime table names unchanged inside each independent DB.',
    ''
  ];

  for (const table of sidePlan.tables) {
    const sourceTable = quoteIdentifier(table.sourceTable);
    const previewTable = quoteIdentifier(table.sameDbPreviewTables[sidePlan.side]);
    const finalTable = quoteIdentifier(table.finalTables[sidePlan.side]);
    const splitColumn = quoteIdentifier(table.splitColumn);
    const splitValue = sqlString(table.splitValue[sidePlan.side]);

    lines.push(
      `-- ${table.sourceTable}`,
      `-- final_runtime_table: ${finalTable}`,
      `-- same_db_preview_table: ${previewTable}`,
      `-- dependency: ${table.dependency}`,
      `-- rows: total=${table.total_rows}, keep=${table.keep_rows}, other_workspace=${table.other_workspace_rows}, unknown_workspace=${table.unknown_workspace_rows}`,
      `-- note: ${table.note}`
    );

    if (!table.exists) {
      lines.push(`-- SKIP: ${table.sourceTable} is missing in this DB.`, '');
      continue;
    }

    lines.push(
      `DROP TABLE IF EXISTS temp.${previewTable};`,
      `CREATE TEMP TABLE ${previewTable} AS`,
      `SELECT *`,
      `FROM ${sourceTable}`,
      `WHERE ${splitColumn} = ${splitValue};`,
      `-- Expected preview rows: ${table.keep_rows}`,
      ''
    );
  }

  return `${lines.join('\n')}\n`;
}

function buildMarkdown(summary) {
  const lines = [
    '# Workspace Center Physical Table Boundary Dry-Run',
    '',
    `Generated at: ${summary.generated_at}`,
    '',
    '## Naming Plan',
    '',
    '| Source table | Business final table | Trading final table | Business same-DB preview | Trading same-DB preview | Split condition | Dependency |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];

  for (const plan of summary.naming_plan) {
    lines.push(
      `| ${plan.source_table} | ${plan.business_final_table} | ${plan.trading_final_table} | ${plan.business_preview_table} | ${plan.trading_preview_table} | ${plan.split_condition} | ${plan.dependency} |`
    );
  }

  lines.push('', '## Row Boundary Check', '');
  for (const side of ['business', 'trading']) {
    lines.push(`### ${side}`, '');
    lines.push('| Table | Total rows | Keep rows | Other workspace rows | Unknown workspace rows | Status |');
    lines.push('| --- | ---: | ---: | ---: | ---: | --- |');
    for (const table of summary[side].tables) {
      const status = table.other_workspace_rows === 0 && table.unknown_workspace_rows === 0 && table.exists
        ? 'ready'
        : 'review';
      lines.push(
        `| ${table.sourceTable} | ${table.total_rows} | ${table.keep_rows} | ${table.other_workspace_rows} | ${table.unknown_workspace_rows} | ${status} |`
      );
    }
    lines.push('');
  }

  lines.push(
    '## Decision',
    '',
    '- Final independent business/trading DBs keep the original table names.',
    '- Same-DB prefixed names are preview-only and should not become runtime names unless the project explicitly chooses a long transition period inside one DB.',
    '- Keep `workspace` and `domain` columns during the first physical split for audit/debugging; consider dropping or relaxing them only after both apps run independently for a while.',
    ''
  );

  return `${lines.join('\n')}\n`;
}

async function main() {
  for (const filePath of [businessDbPath, tradingDbPath]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Database file not found: ${filePath}`);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const businessDb = openReadonlyDb(businessDbPath);
  const tradingDb = openReadonlyDb(tradingDbPath);
  try {
    const business = await collectSidePlan(businessDb, 'business', businessDbPath);
    const trading = await collectSidePlan(tradingDb, 'trading', tradingDbPath);

    const generatedAt = new Date().toISOString();
    const namingPlan = workspaceCenterPhysicalTables.map((table) => ({
      source_table: table.sourceTable,
      business_final_table: table.finalTables.business,
      trading_final_table: table.finalTables.trading,
      business_preview_table: table.sameDbPreviewTables.business,
      trading_preview_table: table.sameDbPreviewTables.trading,
      split_condition: `${table.splitColumn} = business/trading`,
      dependency: table.dependency,
      note: table.note
    }));

    const summary = {
      generated_at: generatedAt,
      mode: 'dry_run_sql_only',
      executed: false,
      output_dir: outputDir,
      naming_strategy: {
        final_independent_db: 'keep same runtime table names in each DB',
        same_db_transition: 'use *_preview table names only for temp dry-run rehearsal'
      },
      inputs: {
        business_db: businessDbPath,
        trading_db: tradingDbPath
      },
      naming_plan: namingPlan,
      business,
      trading,
      blockers: [...business.blockers, ...trading.blockers]
    };

    const businessSqlPath = path.join(outputDir, 'workspace_center_business_table_boundary_dry_run.sql');
    const tradingSqlPath = path.join(outputDir, 'workspace_center_trading_table_boundary_dry_run.sql');
    const summaryPath = path.join(outputDir, 'workspace_center_table_boundary_dry_run_summary.json');
    const planPath = path.join(outputDir, 'workspace_center_table_boundary_plan.md');

    fs.writeFileSync(businessSqlPath, buildDryRunSql(business));
    fs.writeFileSync(tradingSqlPath, buildDryRunSql(trading));
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(planPath, buildMarkdown(summary));

    console.log('Workspace center physical table boundary dry-run generated.');
    console.log(`  plan:     ${planPath}`);
    console.log(`  business: ${businessSqlPath}`);
    console.log(`  trading:  ${tradingSqlPath}`);
    console.log(`  summary:  ${summaryPath}`);
    console.log(`Business blockers: ${business.blockers.length}`);
    console.log(`Trading blockers:  ${trading.blockers.length}`);
    if (summary.blockers.length > 0) {
      console.log('Status: NEEDS_REVIEW');
      process.exitCode = 2;
    } else {
      console.log('Status: READY_FOR_PHYSICAL_TABLE_BOUNDARY');
    }
  } finally {
    await Promise.all([close(businessDb), close(tradingDb)]);
  }
}

main().catch((error) => {
  console.error(`[workspace-center-table-boundary-dry-run] ${error.message}`);
  process.exit(1);
});
