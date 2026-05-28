#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { requireArchivedSplitToolConfirmation } = require('./archiveGuard');

requireArchivedSplitToolConfirmation('validate_split_preview');

const DEFAULT_DATABASE_PATH = '/Volumes/7100/price-dashboard-data/db/price_dashboard_dev.db';
const sourcePath = process.env.DB_PATH || DEFAULT_DATABASE_PATH;
const outputDir = process.env.SPLIT_DB_OUTPUT_DIR || path.join(path.dirname(sourcePath), 'split-preview');
const defaultManifestPath = path.join(outputDir, 'split_manifest.json');
const manifestPath = process.env.SPLIT_MANIFEST_PATH || defaultManifestPath;

const workspaceOwners = new Set(['workspace-split']);
const sharedOwners = new Set(['shared']);
const appOwners = new Set(['business', 'trading']);
const infraTables = new Set(['migrations', 'schema_migrations', 'sqlite_sequence']);

const openReadonlyDb = (filename) => (
  new sqlite3.Database(filename, sqlite3.OPEN_READONLY)
);

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

const tableExists = async (db, tableName) => {
  const row = await get(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [tableName]
  );
  return Boolean(row);
};

const getTables = async (db) => (
  all(
    db,
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
     ORDER BY name ASC`
  )
);

const getColumns = async (db, tableName) => (
  all(db, `PRAGMA table_info(${JSON.stringify(tableName)})`)
);

const getRowCount = async (db, tableName, where = '', params = []) => {
  const row = await get(
    db,
    `SELECT COUNT(*) AS count FROM "${tableName}"${where ? ` WHERE ${where}` : ''}`,
    params
  );
  return Number(row?.count || 0);
};

const getTableOwner = (manifest, tableName) => (
  manifest.tables.find((table) => table.name === tableName)?.owner || 'unclassified'
);

const ownerForDependency = (owner) => {
  if (appOwners.has(owner)) return owner;
  if (workspaceOwners.has(owner)) return 'workspace';
  if (sharedOwners.has(owner)) return 'shared';
  return 'unclassified';
};

const isLikelyTradingText = (value) => (
  /finance|financial|trading|trade|asset|candidate|entry|model|experiment|metal|tushare|market|stock|etf/i.test(String(value || ''))
);

const printSection = (title) => {
  console.log(`\n## ${title}`);
};

async function collectWorkspaceTablePlan(db, tableName) {
  const columns = await getColumns(db, tableName);
  const columnNames = new Set(columns.map((column) => column.name));
  const total = await getRowCount(db, tableName);
  const result = {
    table: tableName,
    total,
    split_by: null,
    business_rows: 0,
    trading_rows: 0,
    unknown_rows: 0,
    recommendation: ''
  };

  if (columnNames.has('workspace')) {
    result.split_by = 'workspace';
    result.business_rows = await getRowCount(db, tableName, `workspace = 'business'`);
    result.trading_rows = await getRowCount(db, tableName, `workspace = 'trading'`);
    result.unknown_rows = total - result.business_rows - result.trading_rows;
  } else if (columnNames.has('domain')) {
    result.split_by = 'domain';
    result.business_rows = await getRowCount(db, tableName, `domain = 'business'`);
    result.trading_rows = await getRowCount(db, tableName, `domain IN ('finance', 'trading', 'metals', 'model_training')`);
    result.unknown_rows = total - result.business_rows - result.trading_rows;
  } else {
    result.split_by = 'manual';
    result.unknown_rows = total;
  }

  result.recommendation = result.unknown_rows > 0
    ? '先补 workspace/domain，再拆成两套；否则可能丢历史记录。'
    : '可按 workspace/domain 分别保留到 business/trading 副本。';

  return result;
}

async function collectSharedTablePlan(db, tableName) {
  const columns = await getColumns(db, tableName);
  const columnNames = new Set(columns.map((column) => column.name));
  const total = await getRowCount(db, tableName);
  const result = {
    table: tableName,
    total,
    suggested_action: 'copy_to_both',
    detail: ''
  };

  if (infraTables.has(tableName)) {
    result.suggested_action = 'keep_in_both';
    result.detail = '迁移/自增等基础表，两边都需要保留。';
    return result;
  }

  if (tableName === 'analysis_annotations' && columnNames.has('module')) {
    const rows = await all(
      db,
      `SELECT module, COUNT(*) AS count
       FROM analysis_annotations
       GROUP BY module
       ORDER BY count DESC, module ASC`
    );
    const tradingRows = rows.filter((row) => isLikelyTradingText(row.module));
    const businessRows = rows.filter((row) => !isLikelyTradingText(row.module));
    result.detail = `module 可粗分：business ${businessRows.reduce((sum, row) => sum + Number(row.count || 0), 0)}，trading ${tradingRows.reduce((sum, row) => sum + Number(row.count || 0), 0)}。建议先复制两边，再按 module 清理。`;
    return result;
  }

  if (tableName === 'user_preferences' && columnNames.has('preference_key')) {
    const rows = await all(
      db,
      `SELECT preference_key, COUNT(*) AS count
       FROM user_preferences
       GROUP BY preference_key
       ORDER BY count DESC, preference_key ASC
       LIMIT 20`
    );
    const tradingCount = rows
      .filter((row) => isLikelyTradingText(row.preference_key))
      .reduce((sum, row) => sum + Number(row.count || 0), 0);
    result.detail = `偏好 key 没有强业务约束，Top20 里疑似 trading ${tradingCount} 条；建议先复制两边，再让前端 key 加 workspace/app 前缀。`;
    return result;
  }

  result.detail = '无法可靠按业务自动拆，建议先复制两边，再人工确认清理规则。';
  return result;
}

async function collectForeignKeyIssues(db, manifest) {
  const issues = [];
  for (const table of manifest.tables) {
    if (!(await tableExists(db, table.name))) continue;
    const foreignKeys = await all(db, `PRAGMA foreign_key_list(${JSON.stringify(table.name)})`);
    for (const foreignKey of foreignKeys) {
      const fromOwner = getTableOwner(manifest, table.name);
      const toOwner = getTableOwner(manifest, foreignKey.table);
      const fromDependency = ownerForDependency(fromOwner);
      const toDependency = ownerForDependency(toOwner);
      const allowed =
        fromDependency === toDependency ||
        toDependency === 'shared' ||
        fromDependency === 'workspace' ||
        toDependency === 'workspace';
      if (!allowed) {
        issues.push({
          table: table.name,
          owner: fromOwner,
          references: foreignKey.table,
          referenced_owner: toOwner,
          from_column: foreignKey.from,
          to_column: foreignKey.to
        });
      }
    }
  }
  return issues;
}

async function collectCopyConsistency(sourceDb, businessDb, tradingDb, manifest) {
  const copyMismatches = [];
  const sourceDrift = [];
  for (const table of manifest.tables) {
    const sourceCount = await getRowCount(sourceDb, table.name);
    const businessCount = await getRowCount(businessDb, table.name);
    const tradingCount = await getRowCount(tradingDb, table.name);
    if (businessCount !== tradingCount) {
      copyMismatches.push({
        table: table.name,
        business_copy: businessCount,
        trading_copy: tradingCount
      });
    }
    if (sourceCount !== businessCount || sourceCount !== tradingCount) {
      sourceDrift.push({
        table: table.name,
        source: sourceCount,
        business_copy: businessCount,
        trading_copy: tradingCount
      });
    }
  }
  return { copyMismatches, sourceDrift };
}

function buildPrunePlan(manifest, workspacePlans, sharedPlans) {
  const workspacePlanByTable = new Map(workspacePlans.map((plan) => [plan.table, plan]));
  const sharedPlanByTable = new Map(sharedPlans.map((plan) => [plan.table, plan]));

  return manifest.tables.map((table) => {
    if (table.owner === 'business') {
      return {
        table: table.name,
        owner: table.owner,
        business_action: 'keep_table',
        trading_action: 'drop_table'
      };
    }
    if (table.owner === 'trading') {
      return {
        table: table.name,
        owner: table.owner,
        business_action: 'drop_table',
        trading_action: 'keep_table'
      };
    }
    if (table.owner === 'workspace-split') {
      const plan = workspacePlanByTable.get(table.name);
      return {
        table: table.name,
        owner: table.owner,
        business_action: plan?.unknown_rows ? 'hold_until_workspace_clean' : 'keep_table_filter_rows',
        trading_action: plan?.unknown_rows ? 'hold_until_workspace_clean' : 'keep_table_filter_rows',
        split_by: plan?.split_by || 'unknown',
        business_keep_rows: plan?.business_rows ?? null,
        trading_keep_rows: plan?.trading_rows ?? null,
        unknown_rows: plan?.unknown_rows ?? null
      };
    }
    const sharedPlan = sharedPlanByTable.get(table.name);
    return {
      table: table.name,
      owner: table.owner,
      business_action: sharedPlan?.suggested_action || 'copy_to_both',
      trading_action: sharedPlan?.suggested_action || 'copy_to_both',
      note: sharedPlan?.detail || ''
    };
  });
}

async function main() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Split manifest not found: ${manifestPath}. Run npm run db:archive:split-preview first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const businessPath = manifest.outputs?.business;
  const tradingPath = manifest.outputs?.trading;
  const resolvedSourcePath = manifest.source_db || sourcePath;

  for (const filePath of [resolvedSourcePath, businessPath, tradingPath]) {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Database file not found: ${filePath}`);
    }
  }

  const sourceDb = openReadonlyDb(resolvedSourcePath);
  const businessDb = openReadonlyDb(businessPath);
  const tradingDb = openReadonlyDb(tradingPath);
  try {
    const sourceTables = await getTables(sourceDb);
    const manifestTableNames = new Set(manifest.tables.map((table) => table.name));
    const missingInManifest = sourceTables
      .map((row) => row.name)
      .filter((name) => !manifestTableNames.has(name));
    const missingInBusiness = [];
    const missingInTrading = [];

    for (const table of manifest.tables) {
      if (!(await tableExists(businessDb, table.name))) missingInBusiness.push(table.name);
      if (!(await tableExists(tradingDb, table.name))) missingInTrading.push(table.name);
    }

    const ownerCounts = manifest.tables.reduce((acc, table) => {
      acc[table.owner] = (acc[table.owner] || 0) + 1;
      return acc;
    }, {});
    const { copyMismatches, sourceDrift } = await collectCopyConsistency(sourceDb, businessDb, tradingDb, manifest);
    const foreignKeyIssues = await collectForeignKeyIssues(sourceDb, manifest);
    const workspacePlans = [];
    const sharedPlans = [];

    for (const table of manifest.tables) {
      if (workspaceOwners.has(table.owner)) {
        workspacePlans.push(await collectWorkspaceTablePlan(businessDb, table.name));
      } else if (sharedOwners.has(table.owner)) {
        sharedPlans.push(await collectSharedTablePlan(businessDb, table.name));
      }
    }

    const prunePlan = buildPrunePlan(manifest, workspacePlans, sharedPlans);
    const strictSourceCompare = String(process.env.STRICT_SOURCE_COMPARE || '').trim() === '1';

    const report = {
      generated_at: new Date().toISOString(),
      manifest: manifestPath,
      source_db: resolvedSourcePath,
      business_db: businessPath,
      trading_db: tradingPath,
      owner_counts: ownerCounts,
      checks: {
        missing_in_manifest: missingInManifest,
        missing_in_business_copy: missingInBusiness,
        missing_in_trading_copy: missingInTrading,
        copy_row_count_mismatches: copyMismatches,
        source_drift_after_preview: sourceDrift,
        cross_owner_foreign_keys: foreignKeyIssues
      },
      workspace_table_plan: workspacePlans,
      shared_table_plan: sharedPlans,
      prune_plan: prunePlan,
      next_cutover_decision: {
        business_db_keep: ['business', 'workspace-split rows where workspace/domain = business', 'shared infra and copied preferences/annotations'],
        trading_db_keep: ['trading', 'workspace-split rows where workspace/domain = trading', 'shared infra and copied preferences/annotations'],
        strict_source_compare: strictSourceCompare,
        do_not_write_before: [
          'workspace_table_plan unknown_rows = 0',
          'cross_owner_foreign_keys is empty or manually accepted',
          'copy_row_count_mismatches is empty',
          'runtime API smoke tests pass against each DB',
          'source_drift_after_preview is accepted or preview regenerated'
        ]
      }
    };

    fs.writeFileSync(
      path.join(path.dirname(manifestPath), 'split_validation_report.json'),
      `${JSON.stringify(report, null, 2)}\n`
    );

    printSection('Split Preview Validation');
    console.log(`source:   ${resolvedSourcePath}`);
    console.log(`business: ${businessPath}`);
    console.log(`trading:  ${tradingPath}`);
    console.log(`owners:   ${JSON.stringify(ownerCounts)}`);

    printSection('Copy Checks');
    console.log(`missing in manifest: ${missingInManifest.length}`);
    console.log(`missing in business copy: ${missingInBusiness.length}`);
    console.log(`missing in trading copy: ${missingInTrading.length}`);
    console.log(`copy row count mismatches: ${copyMismatches.length}`);
    console.log(`source drift after preview: ${sourceDrift.length}`);
    console.log(`cross-owner foreign keys: ${foreignKeyIssues.length}`);

    printSection('Workspace Tables');
    for (const plan of workspacePlans) {
      console.log(`${plan.table}: total=${plan.total}, by=${plan.split_by}, business=${plan.business_rows}, trading=${plan.trading_rows}, unknown=${plan.unknown_rows} -> ${plan.recommendation}`);
    }

    printSection('Shared Tables');
    for (const plan of sharedPlans) {
      console.log(`${plan.table}: total=${plan.total}, action=${plan.suggested_action}; ${plan.detail}`);
    }

    console.log(`\nReport written: ${path.join(path.dirname(manifestPath), 'split_validation_report.json')}`);

    const hasBlockingIssue = (
      missingInManifest.length > 0 ||
      missingInBusiness.length > 0 ||
      missingInTrading.length > 0 ||
      copyMismatches.length > 0 ||
      (strictSourceCompare && sourceDrift.length > 0) ||
      workspacePlans.some((plan) => plan.unknown_rows > 0) ||
      foreignKeyIssues.length > 0
    );

    if (hasBlockingIssue) {
      console.log('\nStatus: NEEDS_REVIEW');
      process.exitCode = 2;
    } else {
      console.log('\nStatus: READY_FOR_PRUNE_DRY_RUN');
    }
  } finally {
    await Promise.all([close(sourceDb), close(businessDb), close(tradingDb)]);
  }
}

main().catch((error) => {
  console.error(`[validate-split-preview] ${error.message}`);
  process.exit(1);
});
