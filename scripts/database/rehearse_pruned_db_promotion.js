#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const DEFAULT_DB_DIR = '/Volumes/7100/price-dashboard-data/db';
const dbDir = process.env.PRICE_DASHBOARD_DB_DIR || DEFAULT_DB_DIR;
const splitPreviewDir = process.env.SPLIT_DB_OUTPUT_DIR || path.join(dbDir, 'split-preview');
const stableBusinessPath = process.env.BUSINESS_STABLE_DB_PATH || path.join(dbDir, 'price_dashboard_business_dev.db');
const stableTradingPath = process.env.TRADING_STABLE_DB_PATH || path.join(dbDir, 'price_dashboard_trading_dev.db');
const explicitReportPath = process.env.PRUNED_SPLIT_REPORT || process.env.PRUNED_SPLIT_REPORT_PATH;
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const rehearsalDir = process.env.PROMOTION_REHEARSAL_DIR || path.join(splitPreviewDir, `promotion-rehearsal-${timestamp}`);

const openReadonlyDb = (filename) => new sqlite3.Database(filename, sqlite3.OPEN_READONLY);

const all = (db, sql, params = []) => (
  new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
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

function walkFiles(dir, maxDepth = 2, depth = 0) {
  if (!fs.existsSync(dir) || depth > maxDepth) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, maxDepth, depth + 1));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function findLatestPrunedReport() {
  const reports = walkFiles(splitPreviewDir, 2)
    .filter((filePath) => path.basename(filePath) === 'pruned_split_report.json')
    .sort();
  return reports[reports.length - 1];
}

function readJson(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath || '(empty)'}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getFileInfo(filePath) {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    size_bytes: stat.size,
    size_gb: Number((stat.size / 1024 / 1024 / 1024).toFixed(3)),
    mtime: stat.mtime.toISOString()
  };
}

function assertVerifiedSide(report, side) {
  const verification = report.verification?.[side];
  const outputPath = report.outputs?.[side];
  if (!outputPath || !fs.existsSync(outputPath)) {
    throw new Error(`${side} pruned DB not found: ${outputPath || '(empty)'}`);
  }
  if (!verification) {
    throw new Error(`${side} verification block missing in pruned report.`);
  }
  if (Number(verification.foreign_key_issue_count || 0) !== 0) {
    throw new Error(`${side} pruned DB has foreign key issues: ${verification.foreign_key_issue_count}`);
  }
  if ((verification.dropped_tables_still_present || []).length > 0) {
    throw new Error(`${side} pruned DB still has dropped tables: ${verification.dropped_tables_still_present.join(', ')}`);
  }
  if ((verification.workspace_row_issues || []).length > 0) {
    throw new Error(`${side} pruned DB has workspace row issues: ${verification.workspace_row_issues.join('; ')}`);
  }
}

async function inspectSqliteDb(filePath) {
  const db = openReadonlyDb(filePath);
  try {
    const integrityRows = await all(db, 'PRAGMA integrity_check');
    const integrityValues = integrityRows.map((row) => Object.values(row)[0]);
    const foreignKeyRows = await all(db, 'PRAGMA foreign_key_check');
    const tableRows = await all(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
    );
    return {
      integrity_check: integrityValues,
      integrity_ok: integrityValues.length === 1 && integrityValues[0] === 'ok',
      foreign_key_issue_count: foreignKeyRows.length,
      table_count: tableRows.length,
      tables: tableRows.map((row) => row.name)
    };
  } finally {
    await close(db);
  }
}

function copyForRehearsal(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  const sourceInfo = getFileInfo(sourcePath);
  const targetInfo = getFileInfo(targetPath);
  if (sourceInfo.size_bytes !== targetInfo.size_bytes) {
    throw new Error(`Copy size mismatch: ${sourcePath} -> ${targetPath}`);
  }
  return { source: sourceInfo, target: targetInfo };
}

function writePromotionScript({
  prunedBusinessPath,
  prunedTradingPath,
  backupDir,
  scriptPath
}) {
  const content = `#!/usr/bin/env bash
set -euo pipefail

# Generated rehearsal artifact. Review before running.
# This promotes pruned split DBs to stable paths.

BUSINESS_SOURCE=${JSON.stringify(prunedBusinessPath)}
TRADING_SOURCE=${JSON.stringify(prunedTradingPath)}
BUSINESS_TARGET=${JSON.stringify(stableBusinessPath)}
TRADING_TARGET=${JSON.stringify(stableTradingPath)}
BACKUP_DIR=${JSON.stringify(backupDir)}

mkdir -p "$BACKUP_DIR"

backup_if_exists() {
  local target="$1"
  local name="$2"
  if [ -f "$target" ]; then
    cp -p "$target" "$BACKUP_DIR/$name"
  fi
}

promote_one() {
  local source="$1"
  local target="$2"
  local tmp="$target.tmp-promote-$$"
  if [ ! -f "$source" ]; then
    echo "Source DB not found: $source" >&2
    exit 1
  fi
  cp -p "$source" "$tmp"
  mv "$tmp" "$target"
}

echo "Before running this script:"
echo "  1. Stop business/trading API/frontend launchd services."
echo "  2. Confirm no writer is using the stable split DB targets."
echo "  3. Confirm the pruned report was regenerated after stopping writers."

backup_if_exists "$BUSINESS_TARGET" "price_dashboard_business_dev.db.bak"
backup_if_exists "$TRADING_TARGET" "price_dashboard_trading_dev.db.bak"

promote_one "$BUSINESS_SOURCE" "$BUSINESS_TARGET"
promote_one "$TRADING_SOURCE" "$TRADING_TARGET"

echo "Promotion copied:"
echo "  $BUSINESS_TARGET"
echo "  $TRADING_TARGET"
`;
  fs.writeFileSync(scriptPath, content);
  fs.chmodSync(scriptPath, 0o755);
}

function writeRollbackScript({ backupDir, scriptPath }) {
  const content = `#!/usr/bin/env bash
set -euo pipefail

# Generated rehearsal artifact. Review before running.

BUSINESS_TARGET=${JSON.stringify(stableBusinessPath)}
TRADING_TARGET=${JSON.stringify(stableTradingPath)}
BACKUP_DIR=${JSON.stringify(backupDir)}

restore_one() {
  local backup="$1"
  local target="$2"
  if [ -f "$backup" ]; then
    cp -p "$backup" "$target"
    echo "Restored $target"
  else
    echo "Backup not found, leaving target unchanged: $backup"
  fi
}

restore_one "$BACKUP_DIR/price_dashboard_business_dev.db.bak" "$BUSINESS_TARGET"
restore_one "$BACKUP_DIR/price_dashboard_trading_dev.db.bak" "$TRADING_TARGET"
`;
  fs.writeFileSync(scriptPath, content);
  fs.chmodSync(scriptPath, 0o755);
}

function writeMarkdownPlan({
  planPath,
  reportPath,
  prunedReportPath,
  backupDir,
  promotionScriptPath,
  rollbackScriptPath,
  businessCopy,
  tradingCopy
}) {
  const content = `# Pruned DB Promotion Rehearsal

This is a rehearsal artifact. The stable DB paths were not overwritten.

## Inputs

- Pruned report: \`${prunedReportPath}\`
- Business pruned DB: \`${businessCopy.source.path}\`
- Trading pruned DB: \`${tradingCopy.source.path}\`

## Stable Targets For Real Promotion

- Business stable DB: \`${stableBusinessPath}\`
- Trading stable DB: \`${stableTradingPath}\`
- Backup dir for real promotion: \`${backupDir}\`

## Rehearsal Copies

- Business rehearsal copy: \`${businessCopy.target.path}\`
- Trading rehearsal copy: \`${tradingCopy.target.path}\`

## Generated Scripts

- Promotion script: \`${promotionScriptPath}\`
- Rollback script: \`${rollbackScriptPath}\`
- Rehearsal report: \`${reportPath}\`

## Real Promotion Gate

Before running the generated promotion script:

1. Stop business/trading API/frontend launchd services.
2. Stop any local dev or dry-run API processes.
3. Regenerate split preview, validate it, regenerate prune SQL, and materialize a fresh pruned copy after writers are stopped.
4. Re-run \`npm run db:promote-pruned-rehearsal\`.
5. Review the new report and generated scripts.
6. Only then run the generated promotion script manually.
7. Start business/trading services and run health + boundary smoke tests.

## Rollback Gate

If promotion has to be rolled back, stop the split services first, then run the generated rollback script.
`;
  fs.writeFileSync(planPath, content);
}

async function main() {
  const prunedReportPath = explicitReportPath || findLatestPrunedReport();
  const prunedReport = readJson(prunedReportPath, 'Pruned split report');

  assertVerifiedSide(prunedReport, 'business');
  assertVerifiedSide(prunedReport, 'trading');

  fs.mkdirSync(rehearsalDir, { recursive: true });
  const rehearsalStableDir = path.join(rehearsalDir, 'stable-targets');
  const backupDir = path.join(dbDir, 'promotion-backups', timestamp);

  const prunedBusinessPath = prunedReport.outputs.business;
  const prunedTradingPath = prunedReport.outputs.trading;
  const businessRehearsalPath = path.join(rehearsalStableDir, path.basename(stableBusinessPath));
  const tradingRehearsalPath = path.join(rehearsalStableDir, path.basename(stableTradingPath));

  const businessCopy = copyForRehearsal(prunedBusinessPath, businessRehearsalPath);
  const tradingCopy = copyForRehearsal(prunedTradingPath, tradingRehearsalPath);

  const [businessInspection, tradingInspection] = await Promise.all([
    inspectSqliteDb(businessRehearsalPath),
    inspectSqliteDb(tradingRehearsalPath)
  ]);

  if (!businessInspection.integrity_ok || businessInspection.foreign_key_issue_count > 0) {
    throw new Error('Business rehearsal DB inspection failed.');
  }
  if (!tradingInspection.integrity_ok || tradingInspection.foreign_key_issue_count > 0) {
    throw new Error('Trading rehearsal DB inspection failed.');
  }

  const promotionScriptPath = path.join(rehearsalDir, 'promote_pruned_dbs.sh');
  const rollbackScriptPath = path.join(rehearsalDir, 'rollback_pruned_dbs.sh');
  const reportPath = path.join(rehearsalDir, 'promotion_rehearsal_report.json');
  const planPath = path.join(rehearsalDir, 'PROMOTION_REHEARSAL.md');

  writePromotionScript({
    prunedBusinessPath,
    prunedTradingPath,
    backupDir,
    scriptPath: promotionScriptPath
  });
  writeRollbackScript({ backupDir, scriptPath: rollbackScriptPath });

  const report = {
    generated_at: new Date().toISOString(),
    mode: 'rehearsal_only',
    stable_targets_not_modified: true,
    pruned_report: prunedReportPath,
    rehearsal_dir: rehearsalDir,
    stable_targets: {
      business: {
        path: stableBusinessPath,
        exists_now: fs.existsSync(stableBusinessPath),
        current_file: fs.existsSync(stableBusinessPath) ? getFileInfo(stableBusinessPath) : null
      },
      trading: {
        path: stableTradingPath,
        exists_now: fs.existsSync(stableTradingPath),
        current_file: fs.existsSync(stableTradingPath) ? getFileInfo(stableTradingPath) : null
      }
    },
    rehearsal_copies: {
      business: businessCopy,
      trading: tradingCopy
    },
    sqlite_inspection: {
      business: {
        integrity_ok: businessInspection.integrity_ok,
        integrity_check: businessInspection.integrity_check,
        foreign_key_issue_count: businessInspection.foreign_key_issue_count,
        table_count: businessInspection.table_count
      },
      trading: {
        integrity_ok: tradingInspection.integrity_ok,
        integrity_check: tradingInspection.integrity_check,
        foreign_key_issue_count: tradingInspection.foreign_key_issue_count,
        table_count: tradingInspection.table_count
      }
    },
    generated_scripts: {
      promotion: promotionScriptPath,
      rollback: rollbackScriptPath
    },
    real_promotion_backup_dir: backupDir,
    next_gate: 'Stop writers, regenerate fresh split/pruned DBs, rerun this rehearsal, then manually run the generated promotion script only after approval.'
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeMarkdownPlan({
    planPath,
    reportPath,
    prunedReportPath,
    backupDir,
    promotionScriptPath,
    rollbackScriptPath,
    businessCopy,
    tradingCopy
  });

  console.log('Pruned DB promotion rehearsal completed.');
  console.log(`  rehearsal: ${rehearsalDir}`);
  console.log(`  report:    ${reportPath}`);
  console.log(`  plan:      ${planPath}`);
  console.log(`  business rehearsal tables=${businessInspection.table_count}, fk=${businessInspection.foreign_key_issue_count}`);
  console.log(`  trading rehearsal tables=${tradingInspection.table_count}, fk=${tradingInspection.foreign_key_issue_count}`);
  console.log('Stable target DB paths were NOT modified.');
}

main().catch((error) => {
  console.error(`[rehearse-pruned-db-promotion] ${error.message}`);
  process.exit(1);
});
