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

