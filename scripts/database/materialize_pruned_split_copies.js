#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { requireArchivedSplitToolConfirmation } = require('./archiveGuard');

requireArchivedSplitToolConfirmation('materialize_pruned_split_copies');

const DEFAULT_DATABASE_PATH = '/Volumes/7100/price-dashboard-data/db/price_dashboard_dev.db';
const sourcePath = process.env.DB_PATH || DEFAULT_DATABASE_PATH;
const splitOutputDir = process.env.SPLIT_DB_OUTPUT_DIR || path.join(path.dirname(sourcePath), 'split-preview');
const manifestPath = process.env.SPLIT_MANIFEST_PATH || path.join(splitOutputDir, 'split_manifest.json');
const validationReportPath = process.env.SPLIT_VALIDATION_REPORT_PATH || path.join(splitOutputDir, 'split_validation_report.json');
const dryRunSummaryPath = process.env.PRUNE_DRY_RUN_SUMMARY_PATH || path.join(splitOutputDir, 'prune_dry_run_summary.json');
const businessSqlPath = process.env.PRUNE_BUSINESS_SQL_PATH || path.join(splitOutputDir, 'prune_business_dry_run.sql');
const tradingSqlPath = process.env.PRUNE_TRADING_SQL_PATH || path.join(splitOutputDir, 'prune_trading_dry_run.sql');
const prunedOutputDir = process.env.PRUNED_SPLIT_OUTPUT_DIR || path.join(
  splitOutputDir,
  `pruned-copy-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}`
);

const workspaceOwnerTypes = new Set(['workspace-split']);

const openDb = (filename) => new sqlite3.Database(filename);

const all = (db, sql, params = []) => (
  new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  })
);

const exec = (db, sql) => (
  new Promise((resolve, reject) => {
    db.exec(sql, (error) => {
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

const requireJson = (filePath, label) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const requireFile = (filePath, label) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
};

const quoteIdentifier = (name) => `"${String(name).replace(/"/g, '""')}"`;

async function tableExists(db, tableName) {
  const rows = await all(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName]
  );
  return rows.length > 0;
}

async function getTableNames(db) {
  const rows = await all(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
  );
  return rows.map((row) => row.name);
}

async function applyPruneSql(dbPath, sqlPath) {
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const db = openDb(dbPath);
  try {
    await exec(db, sql);
  } finally {
    await close(db);
  }
}

async function verifyWorkspaceRows(db, workspacePlans, side) {
  const issues = [];

  for (const plan of workspacePlans) {
    if (!(await tableExists(db, plan.table))) continue;

    if (plan.split_by === 'workspace') {
      const rows = await all(
        db,
        `SELECT COUNT(1) AS count FROM ${quoteIdentifier(plan.table)} WHERE workspace <> ?`,
        [side]
      );
      if (Number(rows[0]?.count || 0) > 0) {
        issues.push(`${plan.table}: workspace rows outside ${side} = ${rows[0].count}`);
      }
      continue;
    }

    if (plan.split_by === 'domain') {
      const condition = side === 'business'
        ? "domain <> 'business'"
        : "domain NOT IN ('finance', 'trading', 'metals', 'model_training')";
      const rows = await all(
        db,
        `SELECT COUNT(1) AS count FROM ${quoteIdentifier(plan.table)} WHERE ${condition}`
      );
      if (Number(rows[0]?.count || 0) > 0) {
        issues.push(`${plan.table}: domain rows outside ${side} = ${rows[0].count}`);
      }
    }
  }

  return issues;
}

async function verifySide(dbPath, side, validationReport, dryRunSummary) {
  const db = openDb(dbPath);
  try {
    await exec(db, 'PRAGMA foreign_keys = ON;');

    const fkIssues = await all(db, 'PRAGMA foreign_key_check');
    const tableNames = await getTableNames(db);
    const tableSet = new Set(tableNames);
    const droppedTablesStillPresent = (dryRunSummary[side]?.drop_tables || [])
      .filter((tableName) => tableSet.has(tableName));
    const expectedWorkspaceTables = validationReport.workspace_table_plan || [];
    const workspaceRowIssues = await verifyWorkspaceRows(db, expectedWorkspaceTables, side);

    return {
      db_path: dbPath,
      table_count: tableNames.length,
      foreign_key_issue_count: fkIssues.length,
      dropped_tables_still_present: droppedTablesStillPresent,
      workspace_row_issues: workspaceRowIssues
    };
  } finally {
    await close(db);
  }
}

async function main() {
  const manifest = requireJson(manifestPath, 'Split manifest');
  const validationReport = requireJson(validationReportPath, 'Split validation report');
  const dryRunSummary = requireJson(dryRunSummaryPath, 'Prune dry-run summary');

  requireFile(manifest.outputs?.business || '', 'Business split DB copy');
  requireFile(manifest.outputs?.trading || '', 'Trading split DB copy');
  requireFile(businessSqlPath, 'Business prune SQL');
  requireFile(tradingSqlPath, 'Trading prune SQL');

  const workspaceTablesWithUnknownRows = (validationReport.workspace_table_plan || [])
    .filter((plan) => workspaceOwnerTypes.has(plan.owner) && Number(plan.unknown_rows || 0) > 0);
  if (workspaceTablesWithUnknownRows.length > 0) {
    throw new Error(`Workspace split still has unknown rows: ${workspaceTablesWithUnknownRows.map((plan) => plan.table).join(', ')}`);
  }

  fs.mkdirSync(prunedOutputDir, { recursive: true });

  const businessOutput = path.join(prunedOutputDir, 'price_dashboard_business_pruned.db');
  const tradingOutput = path.join(prunedOutputDir, 'price_dashboard_trading_pruned.db');

  fs.copyFileSync(manifest.outputs.business, businessOutput);
  fs.copyFileSync(manifest.outputs.trading, tradingOutput);

  await applyPruneSql(businessOutput, businessSqlPath);
  await applyPruneSql(tradingOutput, tradingSqlPath);

  const businessVerification = await verifySide(businessOutput, 'business', validationReport, dryRunSummary);
  const tradingVerification = await verifySide(tradingOutput, 'trading', validationReport, dryRunSummary);

  const report = {
    generated_at: new Date().toISOString(),
    mode: 'pruned_copy_only',
    source_manifest: manifestPath,
    validation_report: validationReportPath,
    dry_run_summary: dryRunSummaryPath,
    outputs: {
      business: businessOutput,
      trading: tradingOutput
    },
    verification: {
      business: businessVerification,
      trading: tradingVerification
    },
    note: 'SQL was executed only against newly copied DB files in this output directory. The live source DB and split preview copies were not modified.'
  };

  const reportPath = path.join(prunedOutputDir, 'pruned_split_report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const blockingIssues = [
    ...businessVerification.dropped_tables_still_present,
    ...tradingVerification.dropped_tables_still_present,
    ...businessVerification.workspace_row_issues,
    ...tradingVerification.workspace_row_issues
  ];

  console.log('Pruned split DB copies created.');
  console.log(`  business: ${businessOutput}`);
  console.log(`  trading:  ${tradingOutput}`);
  console.log(`  report:   ${reportPath}`);
  console.log(`Business: tables=${businessVerification.table_count}, fk_issues=${businessVerification.foreign_key_issue_count}`);
  console.log(`Trading:  tables=${tradingVerification.table_count}, fk_issues=${tradingVerification.foreign_key_issue_count}`);

  if (
    businessVerification.foreign_key_issue_count > 0 ||
    tradingVerification.foreign_key_issue_count > 0 ||
    blockingIssues.length > 0
  ) {
    console.error('Verification failed:');
    for (const issue of blockingIssues) console.error(`  - ${issue}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[materialize-pruned-split-copies] ${error.message}`);
  process.exit(1);
});
