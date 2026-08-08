# 生意库 Migration 写法（DDL 单一来源）

## 规则

1. **新表 / 新列 / 数据修补只进** `src/migrations/index.ts`。
2. **禁止**在 `src/config/database.ts` 的 `initDatabase` 里再加 `CREATE TABLE` / `ALTER TABLE`（历史双轨先冻结；有测试锁表名单）。
3. 每个 migration 由 `runMigrations` 包在 `BEGIN IMMEDIATE … COMMIT` 中；`run()` 内不要自行嵌套另一层事务，除非你非常确定。
4. `run()` 必须尽量幂等：表/列已存在则跳过；数据修补用条件更新。

## 新增步骤

1. 复制 `src/migrations/_template.snippet.ts` 里的对象。
2. `id` 用 `YYYYMMDD_NNN_short_snake`（接在现有最大日期之后）。
3. 粘贴到 `migrations` 数组**末尾**（在 `];` 前）。
4. 本地跑一次 API 启动或 `runMigrations`，确认 `migrations` 表有新 id。
5. 若只加列：优先 `ensureMigrationColumn`（已在 `index.ts` 底部工具函数）。

## 最小示例

见 `_template.snippet.ts`。常见形态：

- SQL 字符串：`sql: \`CREATE TABLE IF NOT EXISTS ...\``
- 复杂逻辑：`run: async (db) => { ... }`，内部用 `dbRun` / `dbGet` / `migrationTableExists` / `ensureMigrationColumn`
