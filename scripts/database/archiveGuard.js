function requireArchivedSplitToolConfirmation(toolName) {
  if (process.env.CONFIRM_ARCHIVED_SPLIT_TOOL === 'YES') return;

  console.error(`[${toolName}] archived split/prune tool blocked.`);
  console.error('These tools target the historical single-database split workflow.');
  console.error('Stop writers, back up stable DBs, then rerun with CONFIRM_ARCHIVED_SPLIT_TOOL=YES if recovery is intentional.');
  process.exit(1);
}

module.exports = { requireArchivedSplitToolConfirmation };
