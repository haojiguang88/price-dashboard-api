import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Freeze list for CREATE TABLE inside src/config/database.ts initDatabase.
 * New tables/columns must go through src/migrations/index.ts instead.
 * If you intentionally change init (rare), update this snapshot and docs/migration-howto.md.
 */
const FROZEN_INIT_TABLES = [
  "analysis_annotations",
  "audit_logs",
  "buying_plans",
  "categories",
  "category_profiles",
  "dashboard_action_statuses",
  "ended_positions",
  "entity_tags",
  "follows",
  "lucky_number_records",
  "manual_todos",
  "market_anchor_daily_prices",
  "market_assist_rule_versions",
  "market_assist_rules",
  "market_physical_observations",
  "objects",
  "plan_execution_events",
  "position_batches",
  "positions",
  "price_import_batches",
  "price_import_previews",
  "price_quality_alert_reviews",
  "price_records",
  "risk_check_record_items",
  "risk_check_records",
  "sell_records",
  "selling_plans",
  "speculation_cycle_events",
  "speculation_cycle_records",
  "user_preferences",
  "variants",
  "watchlist_items",
  "workspace_tags"
].sort();

test("database.ts initDatabase CREATE TABLE set is frozen", () => {
  const source = readFileSync(
    path.join(__dirname, "../src/config/database.ts"),
    "utf8"
  );
  const tables = [...source.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)/g)]
    .map((match) => match[1])
    .sort();
  const unique = [...new Set(tables)];

  assert.deepEqual(
    unique,
    FROZEN_INIT_TABLES,
    "Do not add CREATE TABLE to database.ts — append a migration in src/migrations/index.ts (see docs/migration-howto.md)."
  );
});
