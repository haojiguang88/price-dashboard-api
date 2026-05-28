# Database Scripts

This project now runs on the stable business database:

`/Volumes/7100/price-dashboard-data/db/price_dashboard_business_dev.db`

The old split/prune/promote scripts are kept only as archived recovery tools for the
historical single-database split process. They still default to the old combined DB
unless explicit environment variables are provided, so they are intentionally exposed
under `db:archive:*` package scripts instead of normal workflow commands.

Current low-risk planning tool:

```bash
npm run db:workspace-center-table-dry-run
```

Archived recovery tools:

```bash
npm run db:archive:split-preview
npm run db:archive:split-validate
npm run db:archive:prune-dry-run
npm run db:archive:split-pruned-copy
npm run db:archive:promote-pruned-rehearsal
```

Final validation gate before any future DB promotion:

1. Stop all API/task writers first.
2. Back up the current stable DBs to the external disk.
3. Regenerate split preview, validation, prune SQL, pruned copies, and promotion rehearsal in one fresh run.
4. Confirm `integrity_check` or `quick_check(1)` is `ok` for both stable targets.
5. Confirm `manual_todos`, `task_center_tasks`, `task_center_runs`, `audit_logs`, and `workspace_tags` contain only their own workspace rows.
6. Run full `foreign_key_check` in the final freeze window. Do not put that slow check into every lightweight smoke run.
