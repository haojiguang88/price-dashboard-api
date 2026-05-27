#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEFAULT_DATABASE_PATH = '/Volumes/7100/price-dashboard-data/db/price_dashboard_dev.db';
const sourcePath = process.env.DB_PATH || DEFAULT_DATABASE_PATH;
const outputDir = process.env.SPLIT_DB_OUTPUT_DIR || path.join(path.dirname(sourcePath), 'split-preview');
const defaultReportPath = path.join(outputDir, 'split_validation_report.json');
const reportPath = process.env.SPLIT_VALIDATION_REPORT_PATH || defaultReportPath;

const quoteIdentifier = (name) => `"${String(name).replace(/"/g, '""')}"`;
const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

const isEmptyArray = (value) => Array.isArray(value) && value.length === 0;

function ensureReadyForDryRun(report) {
  const checks = report.checks || {};
  const blocking = [];

  if (!isEmptyArray(checks.missing_in_manifest)) blocking.push('manifest has missing tables');
  if (!isEmptyArray(checks.missing_in_business_copy)) blocking.push('business copy is missing tables');
  if (!isEmptyArray(checks.missing_in_trading_copy)) blocking.push('trading copy is missing tables');
  if (!isEmptyArray(checks.copy_row_count_mismatches)) blocking.push('business/trading copy row counts differ');
  if (!isEmptyArray(checks.cross_owner_foreign_keys)) blocking.push('cross-owner foreign keys need manual handling');

  const dirtyWorkspaceTables = (report.workspace_table_plan || [])
    .filter((plan) => Number(plan.unknown_rows || 0) > 0)
    .map((plan) => `${plan.table} unknown_rows=${plan.unknown_rows}`);
  if (dirtyWorkspaceTables.length > 0) {
    blocking.push(`workspace tables contain unclassified rows: ${dirtyWorkspaceTables.join(', ')}`);
  }

  if (blocking.length > 0) {
    throw new Error(`Split validation is not ready for prune dry-run: ${blocking.join('; ')}`);
  }
}

function getWorkspaceDeleteCondition(plan, side) {
  if (plan.split_by === 'workspace') {
    return `${quoteIdentifier('workspace')} <> ${sqlString(side)}`;
  }
  if (plan.split_by === 'domain') {
    if (side === 'business') {
      return `${quoteIdentifier('domain')} <> 'business'`;
    }
    return `${quoteIdentifier('domain')} NOT IN ('finance', 'trading', 'metals', 'model_training')`;
  }
  return null;
}

function buildSqlForSide(report, side) {
  const otherSide = side === 'business' ? 'trading' : 'business';
  const prunePlan = report.prune_plan || [];
  const workspacePlans = new Map((report.workspace_table_plan || []).map((plan) => [plan.table, plan]));
  const sharedPlans = new Map((report.shared_table_plan || []).map((plan) => [plan.table, plan]));
  const dropTables = prunePlan
    .filter((item) => item[`${side}_action`] === 'drop_table')
    .map((item) => item.table)
    .sort((a, b) => a.localeCompare(b));
  const workspaceTables = prunePlan
    .filter((item) => item[`${side}_action`] === 'keep_table_filter_rows')
    .map((item) => item.table)
    .sort((a, b) => a.localeCompare(b));
  const sharedTables = prunePlan
    .filter((item) => ['copy_to_both', 'keep_in_both'].includes(item[`${side}_action`]))
    .map((item) => item.table)
    .sort((a, b) => a.localeCompare(b));

  const lines = [
    '-- Price Dashboard split prune dry-run',
    `-- Target side: ${side}`,
    `-- Target DB copy: ${side === 'business' ? report.business_db : report.trading_db}`,
    `-- Generated at: ${new Date().toISOString()}`,
    `-- Validation report: ${reportPath}`,
    '--',
    '-- This file is generated only. It has NOT been executed.',
    '-- Review it, regenerate the split preview after pausing writers, then execute only after explicit approval.',
    ''
  ];

  const sourceDrift = report.checks?.source_drift_after_preview || [];
  if (sourceDrift.length > 0) {
    lines.push(
      `-- WARNING: live source changed after the preview was created (${sourceDrift.length} tables drifted).`,
      '-- Before real execution: stop backend/scheduler, rerun db:split-preview and db:split-validate, then regenerate this dry-run.',
      ''
    );
  }

  lines.push(
    'PRAGMA foreign_keys = OFF;',
    'BEGIN IMMEDIATE;',
    ''
  );

  lines.push('-- 1. Keep shared tables in this copy.');
  if (sharedTables.length === 0) {
    lines.push('-- No shared tables are marked for this side.');
  } else {
    for (const table of sharedTables) {
      const plan = sharedPlans.get(table);
      const action = plan?.suggested_action || 'copy_to_both';
      lines.push(`-- ${quoteIdentifier(table)}: ${action}; ${plan?.detail || 'retain in both split databases.'}`);
    }
  }
  lines.push('');

  lines.push(`-- 2. Prune workspace rows not belonging to ${side}.`);
  if (workspaceTables.length === 0) {
    lines.push('-- No workspace tables require row pruning.');
  } else {
    for (const table of workspaceTables) {
      const plan = workspacePlans.get(table);
      const condition = plan ? getWorkspaceDeleteCondition(plan, side) : null;
      if (!condition) {
        lines.push(`-- REVIEW REQUIRED: ${quoteIdentifier(table)} has no safe automatic split condition.`);
        continue;
      }
      lines.push(`-- ${quoteIdentifier(table)} keep ${side}_rows=${plan?.[`${side}_rows`] ?? 'unknown'}, delete ${otherSide} side rows.`);
      lines.push(`DELETE FROM ${quoteIdentifier(table)} WHERE ${condition};`);
    }
  }
  lines.push('');

  lines.push(`-- 3. Drop ${otherSide} owned tables from ${side} copy.`);
  if (dropTables.length === 0) {
    lines.push('-- No owned tables to drop.');
  } else {
    for (const table of dropTables) {
      lines.push(`DROP TABLE IF EXISTS ${quoteIdentifier(table)};`);
    }
  }
  lines.push('');

  lines.push(
    'COMMIT;',
    'PRAGMA foreign_keys = ON;',
    'VACUUM;',
    ''
  );

  lines.push(
    '-- Suggested verification after execution on a throwaway copy:',
    '-- PRAGMA foreign_key_check;',
    "-- SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    ''
  );

  return {
    sql: `${lines.join('\n')}\n`,
    dropTables,
    workspaceTables,
    sharedTables
  };
}

function main() {
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Validation report not found: ${reportPath}. Run npm run db:split-validate first.`);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  ensureReadyForDryRun(report);

  const business = buildSqlForSide(report, 'business');
  const trading = buildSqlForSide(report, 'trading');

  const businessSqlPath = path.join(path.dirname(reportPath), 'prune_business_dry_run.sql');
  const tradingSqlPath = path.join(path.dirname(reportPath), 'prune_trading_dry_run.sql');
  const summaryPath = path.join(path.dirname(reportPath), 'prune_dry_run_summary.json');

  fs.writeFileSync(businessSqlPath, business.sql);
  fs.writeFileSync(tradingSqlPath, trading.sql);

  const summary = {
    generated_at: new Date().toISOString(),
    validation_report: reportPath,
    mode: 'dry_run_sql_only',
    executed: false,
    source_drift_after_preview_count: report.checks?.source_drift_after_preview?.length || 0,
    outputs: {
      business_sql: businessSqlPath,
      trading_sql: tradingSqlPath
    },
    business: {
      drop_table_count: business.dropTables.length,
      workspace_prune_table_count: business.workspaceTables.length,
      shared_table_count: business.sharedTables.length,
      drop_tables: business.dropTables,
      workspace_tables: business.workspaceTables,
      shared_tables: business.sharedTables
    },
    trading: {
      drop_table_count: trading.dropTables.length,
      workspace_prune_table_count: trading.workspaceTables.length,
      shared_table_count: trading.sharedTables.length,
      drop_tables: trading.dropTables,
      workspace_tables: trading.workspaceTables,
      shared_tables: trading.sharedTables
    }
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log('Prune dry-run SQL generated.');
  console.log(`  business: ${businessSqlPath}`);
  console.log(`  trading:  ${tradingSqlPath}`);
  console.log(`  summary:  ${summaryPath}`);
  console.log(`Business: drop ${business.dropTables.length} tables, prune ${business.workspaceTables.length} workspace tables.`);
  console.log(`Trading:  drop ${trading.dropTables.length} tables, prune ${trading.workspaceTables.length} workspace tables.`);
  if (summary.source_drift_after_preview_count > 0) {
    console.log(`WARNING: source drift after preview: ${summary.source_drift_after_preview_count} tables. Regenerate preview before real execution.`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[generate-prune-dry-run] ${error.message}`);
  process.exit(1);
}
