type MasterDataRow = {
  id: number;
  name: string;
};

export type ActiveMasterTarget = {
  category_id: number;
  category_name: string;
  object_id: number;
  object_name: string;
  variant_id: number;
  variant_name: string;
};

type ValidationResult =
  | { ok: true; target: ActiveMasterTarget }
  | { ok: false; message: string };

type ScopeValidationResult =
  | { ok: true; normalizedScopeId: number | null }
  | { ok: false; message: string };

type ReferenceTarget =
  | { level: "category"; categoryId: number; categoryName: string }
  | { level: "object"; categoryId: number; categoryName: string; objectId: number; objectName: string }
  | { level: "variant"; categoryId: number; categoryName: string; objectId: number; objectName: string; variantId: number; variantName: string };

type RenameTarget = {
  oldCategoryId?: number;
  newCategoryId?: number;
  oldCategoryName: string;
  newCategoryName: string;
  oldObjectId?: number;
  newObjectId?: number;
  oldObjectName?: string;
  newObjectName?: string;
  oldVariantId?: number;
  newVariantId?: number;
  oldVariantName?: string;
  newVariantName?: string;
};

const normalizeText = (value: unknown) => String(value ?? "").trim();

const parsePositiveInteger = (value: unknown) => {
  const parsed = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseOptionalVariantId = (value: unknown) => {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const tableExists = async (db: any, tableName: string) => {
  const row = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
  return Boolean(row);
};

const tableHasColumn = async (db: any, tableName: string, columnName: string) => {
  if (!(await tableExists(db, tableName))) return false;
  const columns = await db.all(`PRAGMA table_info(${tableName})`);
  return columns.some((column: any) => column.name === columnName);
};

const countIfTableExists = async (db: any, tableName: string, whereClause: string, params: unknown[]) => {
  if (!(await tableExists(db, tableName))) return 0;
  const row = await db.get(`SELECT COUNT(1) AS count FROM ${tableName} WHERE ${whereClause}`, params);
  return Number(row?.count || 0);
};

const runIfTableExists = async (db: any, tableName: string, sql: string, params: unknown[]) => {
  if (!(await tableExists(db, tableName))) return;
  await db.run(sql, params);
};

const runNameUpdate = async (
  db: any,
  tableName: string,
  assignments: string,
  assignmentParams: unknown[],
  whereClause: string,
  whereParams: unknown[],
  now: string
) => {
  if (!(await tableExists(db, tableName))) return;
  const updatedAtAssignment = await tableHasColumn(db, tableName, "updated_at") ? ", updated_at = ?" : "";
  const finalParams = updatedAtAssignment
    ? [...assignmentParams, now, ...whereParams]
    : [...assignmentParams, ...whereParams];
  await db.run(`UPDATE ${tableName} SET ${assignments}${updatedAtAssignment} WHERE ${whereClause}`, finalParams);
};

export const validateActiveMasterTargetByNames = async (
  db: any,
  categoryName: unknown,
  objectName: unknown,
  variantName?: unknown
): Promise<ValidationResult> => {
  const normalizedCategoryName = normalizeText(categoryName);
  const normalizedObjectName = normalizeText(objectName);
  const normalizedVariantName = normalizeText(variantName);

  if (!normalizedCategoryName || !normalizedObjectName) {
    return { ok: false, message: "缺少必填字段: category_name, object_name" };
  }

  const category = await db.get(
    "SELECT id, name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
    [normalizedCategoryName]
  );
  if (!category) return { ok: false, message: "品类不存在或已归档" };

  const object = await db.get(
    "SELECT id, name FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
    [category.id, normalizedObjectName]
  );
  if (!object) return { ok: false, message: "对象不存在或已归档" };

  let variantId = 0;
  let finalVariantName = "";
  if (normalizedVariantName) {
    const variant = await db.get(
      "SELECT id, name FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
      [object.id, normalizedVariantName]
    );
    if (!variant) return { ok: false, message: "变体不存在或已归档" };
    variantId = variant.id;
    finalVariantName = variant.name;
  }

  return {
    ok: true,
    target: {
      category_id: category.id,
      category_name: category.name,
      object_id: object.id,
      object_name: object.name,
      variant_id: variantId,
      variant_name: finalVariantName
    }
  };
};

export const validateActiveMasterTargetByIds = async (
  db: any,
  categoryIdValue: unknown,
  objectIdValue: unknown,
  variantIdValue?: unknown
): Promise<ValidationResult> => {
  const categoryId = parsePositiveInteger(categoryIdValue);
  const objectId = parsePositiveInteger(objectIdValue);
  const variantId = parseOptionalVariantId(variantIdValue);

  if (!categoryId || !objectId || variantId === null) {
    return { ok: false, message: "品类、对象、变体 ID 不合法" };
  }

  const category = await db.get(
    "SELECT id, name FROM categories WHERE id = ? AND COALESCE(is_archived, 0) = 0",
    [categoryId]
  );
  if (!category) return { ok: false, message: "品类不存在或已归档" };

  const object = await db.get(
    "SELECT id, name FROM objects WHERE id = ? AND category_id = ? AND COALESCE(is_archived, 0) = 0",
    [objectId, category.id]
  );
  if (!object) return { ok: false, message: "对象不存在、已归档或不属于所选品类" };

  let finalVariantId = 0;
  let finalVariantName = "";
  if (variantId > 0) {
    const variant = await db.get(
      "SELECT id, name FROM variants WHERE id = ? AND object_id = ? AND COALESCE(is_archived, 0) = 0",
      [variantId, object.id]
    );
    if (!variant) return { ok: false, message: "变体不存在、已归档或不属于所选对象" };
    finalVariantId = variant.id;
    finalVariantName = variant.name;
  }

  return {
    ok: true,
    target: {
      category_id: category.id,
      category_name: category.name,
      object_id: object.id,
      object_name: object.name,
      variant_id: finalVariantId,
      variant_name: finalVariantName
    }
  };
};

export const validateActiveRuleScope = async (
  db: any,
  scopeType: string,
  scopeIdValue: unknown
): Promise<ScopeValidationResult> => {
  if (scopeType === "global") {
    return { ok: true, normalizedScopeId: null };
  }

  const scopeId = parsePositiveInteger(scopeIdValue);
  if (!scopeId) {
    return { ok: false, message: "scope_id 必须是正整数" };
  }

  if (scopeType === "category") {
    const category = await db.get(
      "SELECT id FROM categories WHERE id = ? AND COALESCE(is_archived, 0) = 0",
      [scopeId]
    );
    return category
      ? { ok: true, normalizedScopeId: scopeId }
      : { ok: false, message: "规则范围品类不存在或已归档" };
  }

  if (scopeType === "object") {
    const object = await db.get(
      `SELECT o.id
       FROM objects o
       JOIN categories c ON o.category_id = c.id
       WHERE o.id = ? AND COALESCE(o.is_archived, 0) = 0 AND COALESCE(c.is_archived, 0) = 0`,
      [scopeId]
    );
    return object
      ? { ok: true, normalizedScopeId: scopeId }
      : { ok: false, message: "规则范围对象不存在、已归档或所属品类已归档" };
  }

  return { ok: false, message: "无效的范围类型" };
};

export const cascadeMasterDataRename = async (db: any, target: RenameTarget) => {
  const now = new Date().toISOString();
  const updateCategoryOnly = !target.oldObjectName;
  const updateObject = Boolean(target.oldObjectName && !target.oldVariantName);
  const updateVariant = Boolean(target.oldObjectName && target.oldVariantName !== undefined);

  if (updateCategoryOnly) {
    await runNameUpdate(db, "price_records", "category = ?", [target.newCategoryName], "category = ?", [target.oldCategoryName], now);
    const tables = ["positions", "ended_positions", "sell_records", "buying_plans", "selling_plans", "risk_check_records", "speculation_cycle_records"];
    for (const tableName of tables) {
      await runNameUpdate(db, tableName, "category_name = ?", [target.newCategoryName], "category_name = ?", [target.oldCategoryName], now);
    }
    await runNameUpdate(db, "annual_plan_items", "category = ?", [target.newCategoryName], "category = ?", [target.oldCategoryName], now);
    await runNameUpdate(db, "abnormal_monitor_reads", "category_name = ?", [target.newCategoryName], "category_name = ?", [target.oldCategoryName], now);
    await runIfTableExists(db, "follows", "UPDATE follows SET category_name = ? WHERE category_id = ?", [target.newCategoryName, target.oldCategoryId]);
    await runNameUpdate(db, "original_price_records", "category_name = ?", [target.newCategoryName], "category_id = ?", [target.oldCategoryId], now);
    return;
  }

  if (updateObject) {
    await runNameUpdate(
      db,
      "price_records",
      "category = ?, object_name = ?",
      [target.newCategoryName, target.newObjectName],
      "category = ? AND object_name = ?",
      [target.oldCategoryName, target.oldObjectName],
      now
    );
    const tables = ["positions", "ended_positions", "sell_records", "buying_plans", "selling_plans", "risk_check_records", "speculation_cycle_records"];
    for (const tableName of tables) {
      await runNameUpdate(
        db,
        tableName,
        "category_name = ?, object_name = ?",
        [target.newCategoryName, target.newObjectName],
        "category_name = ? AND object_name = ?",
        [target.oldCategoryName, target.oldObjectName],
        now
      );
    }
    await runNameUpdate(
      db,
      "annual_plan_items",
      "category = ?, object_name = ?",
      [target.newCategoryName, target.newObjectName],
      "category = ? AND object_name = ?",
      [target.oldCategoryName, target.oldObjectName],
      now
    );
    await runNameUpdate(
      db,
      "abnormal_monitor_reads",
      "category_name = ?, object_name = ?",
      [target.newCategoryName, target.newObjectName],
      "category_name = ? AND object_name = ?",
      [target.oldCategoryName, target.oldObjectName],
      now
    );
    await runIfTableExists(
      db,
      "follows",
      "UPDATE follows SET category_id = ?, category_name = ?, object_name = ? WHERE object_id = ?",
      [target.newCategoryId, target.newCategoryName, target.newObjectName, target.oldObjectId]
    );
    await runNameUpdate(
      db,
      "original_price_records",
      "category_id = ?, category_name = ?, object_name = ?",
      [target.newCategoryId, target.newCategoryName, target.newObjectName],
      "object_id = ?",
      [target.oldObjectId],
      now
    );
    await runIfTableExists(
      db,
      "watchlist_items",
      "UPDATE watchlist_items SET category_id = ?, updated_at = ? WHERE object_id = ?",
      [target.newCategoryId, now, target.oldObjectId]
    );
    return;
  }

  if (updateVariant) {
    await runNameUpdate(
      db,
      "price_records",
      "category = ?, object_name = ?, variant = ?",
      [target.newCategoryName, target.newObjectName, target.newVariantName || ""],
      "category = ? AND object_name = ? AND COALESCE(variant, '') = ?",
      [target.oldCategoryName, target.oldObjectName, target.oldVariantName || ""],
      now
    );
    const tables = ["positions", "ended_positions", "sell_records", "buying_plans", "selling_plans", "risk_check_records", "speculation_cycle_records"];
    for (const tableName of tables) {
      await runNameUpdate(
        db,
        tableName,
        "category_name = ?, object_name = ?, variant_name = ?",
        [target.newCategoryName, target.newObjectName, target.newVariantName || ""],
        "category_name = ? AND object_name = ? AND COALESCE(variant_name, '') = ?",
        [target.oldCategoryName, target.oldObjectName, target.oldVariantName || ""],
        now
      );
    }
    await runNameUpdate(
      db,
      "abnormal_monitor_reads",
      "category_name = ?, object_name = ?, variant_name = ?",
      [target.newCategoryName, target.newObjectName, target.newVariantName || ""],
      "category_name = ? AND object_name = ? AND COALESCE(variant_name, '') = ?",
      [target.oldCategoryName, target.oldObjectName, target.oldVariantName || ""],
      now
    );
    await runIfTableExists(
      db,
      "follows",
      "UPDATE follows SET category_id = ?, object_id = ?, category_name = ?, object_name = ?, variant_name = ? WHERE variant_id = ?",
      [target.newCategoryId, target.newObjectId, target.newCategoryName, target.newObjectName, target.newVariantName || "", target.oldVariantId]
    );
    await runNameUpdate(
      db,
      "original_price_records",
      "category_id = ?, category_name = ?, object_id = ?, object_name = ?, variant_name = ?",
      [target.newCategoryId, target.newCategoryName, target.newObjectId, target.newObjectName, target.newVariantName || ""],
      "variant_id = ?",
      [target.oldVariantId],
      now
    );
    await runIfTableExists(
      db,
      "watchlist_items",
      "UPDATE watchlist_items SET category_id = ?, object_id = ?, updated_at = ? WHERE variant_id = ?",
      [target.newCategoryId, target.newObjectId, now, target.oldVariantId]
    );
  }
};

export const countMasterDataReferences = async (db: any, target: ReferenceTarget) => {
  const counts: { table: string; count: number }[] = [];
  const addCount = async (table: string, whereClause: string, params: unknown[]) => {
    const count = await countIfTableExists(db, table, whereClause, params);
    if (count > 0) counts.push({ table, count });
  };

  if (target.level === "category") {
    await addCount("price_records", "category = ?", [target.categoryName]);
    const tables = ["positions", "ended_positions", "sell_records", "buying_plans", "selling_plans", "risk_check_records", "speculation_cycle_records"];
    for (const tableName of tables) {
      await addCount(tableName, "category_name = ?", [target.categoryName]);
    }
    await addCount("annual_plan_items", "category = ? AND COALESCE(is_deleted, 0) = 0", [target.categoryName]);
    await addCount("original_price_records", "category_id = ? AND COALESCE(is_deleted, 0) = 0", [target.categoryId]);
    await addCount("follows", "category_id = ?", [target.categoryId]);
    await addCount("watchlist_items", "category_id = ?", [target.categoryId]);
    await addCount("monitor_rules", "scope_type = 'category' AND scope_id = ?", [target.categoryId]);
    return counts;
  }

  if (target.level === "object") {
    await addCount("price_records", "category = ? AND object_name = ?", [target.categoryName, target.objectName]);
    const tables = ["positions", "ended_positions", "sell_records", "buying_plans", "selling_plans", "risk_check_records", "speculation_cycle_records"];
    for (const tableName of tables) {
      await addCount(tableName, "category_name = ? AND object_name = ?", [target.categoryName, target.objectName]);
    }
    await addCount("annual_plan_items", "category = ? AND object_name = ? AND COALESCE(is_deleted, 0) = 0", [target.categoryName, target.objectName]);
    await addCount("original_price_records", "object_id = ? AND COALESCE(is_deleted, 0) = 0", [target.objectId]);
    await addCount("follows", "object_id = ?", [target.objectId]);
    await addCount("watchlist_items", "object_id = ?", [target.objectId]);
    await addCount("monitor_rules", "scope_type = 'object' AND scope_id = ?", [target.objectId]);
    return counts;
  }

  await addCount("price_records", "category = ? AND object_name = ? AND COALESCE(variant, '') = ?", [target.categoryName, target.objectName, target.variantName]);
  const tables = ["positions", "ended_positions", "sell_records", "buying_plans", "selling_plans", "risk_check_records", "speculation_cycle_records"];
  for (const tableName of tables) {
    await addCount(tableName, "category_name = ? AND object_name = ? AND COALESCE(variant_name, '') = ?", [target.categoryName, target.objectName, target.variantName]);
  }
  await addCount("original_price_records", "variant_id = ? AND COALESCE(is_deleted, 0) = 0", [target.variantId]);
  await addCount("follows", "variant_id = ?", [target.variantId]);
  await addCount("watchlist_items", "variant_id = ?", [target.variantId]);
  return counts;
};

export const formatReferenceBlockMessage = (references: { table: string; count: number }[]) => {
  const total = references.reduce((sum, item) => sum + item.count, 0);
  const summary = references.map(item => `${item.table}:${item.count}`).join(", ");
  return `已有 ${total} 条业务引用，不能硬删除；请先归档或清理引用。${summary}`;
};

/** Count open positions (remaining_quantity > 0) that still reference this master target. */
export const countOpenPositionsForMaster = async (
  db: any,
  target:
    | { level: "category"; categoryName: string }
    | { level: "object"; categoryName: string; objectName: string }
    | { level: "variant"; categoryName: string; objectName: string; variantName: string }
): Promise<number> => {
  if (!(await tableExists(db, "positions")) || !(await tableExists(db, "position_batches"))) {
    return 0;
  }

  if (target.level === "category") {
    const row = await db.get(
      `SELECT COUNT(DISTINCT p.id) AS count
       FROM positions p
       JOIN position_batches pb ON pb.position_id = p.id
       WHERE p.category_name = ?
         AND pb.remaining_quantity > 0`,
      [target.categoryName]
    );
    return Number(row?.count || 0);
  }

  if (target.level === "object") {
    const row = await db.get(
      `SELECT COUNT(DISTINCT p.id) AS count
       FROM positions p
       JOIN position_batches pb ON pb.position_id = p.id
       WHERE p.category_name = ?
         AND p.object_name = ?
         AND pb.remaining_quantity > 0`,
      [target.categoryName, target.objectName]
    );
    return Number(row?.count || 0);
  }

  const row = await db.get(
    `SELECT COUNT(DISTINCT p.id) AS count
     FROM positions p
     JOIN position_batches pb ON pb.position_id = p.id
     WHERE p.category_name = ?
       AND p.object_name = ?
       AND COALESCE(p.variant_name, '') = ?
       AND pb.remaining_quantity > 0`,
    [target.categoryName, target.objectName, target.variantName]
  );
  return Number(row?.count || 0);
};

export const formatOpenPositionArchiveBlockMessage = (count: number) =>
  `仍有 ${count} 个未平仓位引用该主数据，请先平仓或调仓后再归档。`;
