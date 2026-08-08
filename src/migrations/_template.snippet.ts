/**
 * Copy this object into the `migrations` array in `./index.ts` (append at the end).
 * Do NOT import this file at runtime — it is a copy-paste template only.
 *
 * Rules:
 * - New DDL belongs here (migrations), not in src/config/database.ts initDatabase.
 * - Prefer CREATE TABLE IF NOT EXISTS / idempotent UPDATEs.
 * - id format: YYYYMMDD_NNN_short_snake
 *
 * @example
 * {
 *   id: '20260808_003_example_add_widget_notes',
 *   name: 'Add widget_notes table',
 *   sql: `
 *     CREATE TABLE IF NOT EXISTS widget_notes (
 *       id INTEGER PRIMARY KEY AUTOINCREMENT,
 *       body TEXT NOT NULL,
 *       created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 *     );
 *   `
 * }
 *
 * @example
 * {
 *   id: '20260808_004_example_add_column',
 *   name: 'Add note column to widgets',
 *   run: async (db: any) => {
 *     await ensureMigrationColumn(db, 'widgets', 'note', 'TEXT');
 *   }
 * }
 */

export const MIGRATION_TEMPLATE_PLACEHOLDER = true;
