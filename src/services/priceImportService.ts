import { createHash } from "node:crypto";
import { isValidDateOnly } from "../utils/dateValidation";

export type PriceImportAction = "create" | "update" | "skip" | "conflict" | "error";

export interface PriceImportInput {
  date: string;
  category_name: string;
  object_name: string;
  variant_name: string;
  price: number;
  source: string;
  note: string;
}

export interface PriceImportPreviewItem extends PriceImportInput {
  row_index: number;
  action: PriceImportAction;
  reason: string;
  message: string;
  existing_record_id: number | null;
}

export interface PriceImportPreview {
  total_count: number;
  new_count: number;
  update_count: number;
  skipped_count: number;
  conflict_count: number;
  error_count: number;
  records: PriceImportPreviewItem[];
}

export interface PriceImportCommitResult extends PriceImportPreview {
  success_count: number;
  created_count: number;
  updated_count: number;
  warning_count: number;
  warning_records: unknown[];
  skipped_records: PriceImportPreviewItem[];
  failed_records: PriceImportPreviewItem[];
}

export class PriceImportValidationError extends Error {
  readonly preview: PriceImportPreview;

  constructor(preview: PriceImportPreview) {
    super("导入内容仍有冲突或错误，请修正后重新预览");
    this.name = "PriceImportValidationError";
    this.preview = preview;
  }
}

export class PriceImportBatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceImportBatchConflictError";
  }
}

export interface ExecutePriceImportBatchOptions {
  collectWarnings?: (record: PriceImportPreviewItem) => Promise<unknown[] | null | undefined>;
}

const toText = (value: unknown) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const emptyInput = (): PriceImportInput => ({
  date: "",
  category_name: "",
  object_name: "",
  variant_name: "",
  price: Number.NaN,
  source: "",
  note: ""
});

const normalizeInput = (value: unknown): PriceImportInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyInput();
  const record = value as Record<string, unknown>;
  return {
    date: toText(record.date),
    category_name: toText(record.category_name),
    object_name: toText(record.object_name),
    variant_name: toText(record.variant_name),
    price: typeof record.price === "number" ? record.price : Number.NaN,
    source: toText(record.source),
    note: toText(record.note)
  };
};

const recordKey = (record: PriceImportInput) => (
  `${record.date}\u0000${record.category_name}\u0000${record.object_name}\u0000${record.variant_name}`
);

const recordContent = (record: PriceImportInput) => JSON.stringify({
  price: record.price,
  source: record.source,
  note: record.note
});

const previewItem = (
  input: PriceImportInput,
  rowIndex: number,
  action: PriceImportAction,
  reason: string,
  message: string,
  existingRecordId: number | null = null
): PriceImportPreviewItem => ({
  ...input,
  row_index: rowIndex,
  action,
  reason,
  message,
  existing_record_id: existingRecordId
});

const summarizePreview = (records: PriceImportPreviewItem[], totalCount: number): PriceImportPreview => ({
  total_count: totalCount,
  new_count: records.filter(record => record.action === "create").length,
  update_count: records.filter(record => record.action === "update").length,
  skipped_count: records.filter(record => record.action === "skip").length,
  conflict_count: records.filter(record => record.action === "conflict").length,
  error_count: records.filter(record => record.action === "error").length,
  records: [...records].sort((left, right) => left.row_index - right.row_index)
});

const validateInput = (rawValue: unknown, record: PriceImportInput) => {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return { reason: "INVALID_RECORD", message: "每条导入数据必须是对象" };
  }

  const rawRecord = rawValue as Record<string, unknown>;
  const requiredFields = ["date", "category_name", "object_name", "price", "source"];
  if (requiredFields.some(field => !(field in rawRecord))) {
    return { reason: "MISSING_REQUIRED_FIELD", message: "缺少必填字段: date, category_name, object_name, price, source" };
  }
  for (const field of ["date", "category_name", "object_name", "source"]) {
    if (typeof rawRecord[field] !== "string" || !toText(rawRecord[field])) {
      return { reason: "INVALID_FIELD_TYPE", message: `${field} 必须是非空字符串` };
    }
  }
  if (rawRecord.variant_name !== undefined && typeof rawRecord.variant_name !== "string") {
    return { reason: "INVALID_FIELD_TYPE", message: "variant_name 必须是字符串" };
  }
  if (rawRecord.note !== undefined && typeof rawRecord.note !== "string") {
    return { reason: "INVALID_FIELD_TYPE", message: "note 必须是字符串" };
  }
  if (!Number.isFinite(record.price) || record.price <= 0) {
    return { reason: "INVALID_PRICE", message: "price 必须是大于 0 的数字" };
  }
  if (!isValidDateOnly(record.date)) {
    return { reason: "INVALID_DATE", message: "日期无效，请使用真实的 YYYY-MM-DD 日期" };
  }
  return null;
};

export const hashPriceImportPayload = (records: unknown[]) => createHash("sha256")
  .update(JSON.stringify(records.map(normalizeInput)))
  .digest("hex");

export const buildPriceImportPreview = async (db: any, rawRecords: unknown[]): Promise<PriceImportPreview> => {
  const results: PriceImportPreviewItem[] = [];
  const validRows: Array<{ input: PriceImportInput; rowIndex: number }> = [];

  rawRecords.forEach((rawRecord, index) => {
    const rowIndex = index + 1;
    const input = normalizeInput(rawRecord);
    const issue = validateInput(rawRecord, input);
    if (issue) {
      results.push(previewItem(input, rowIndex, "error", issue.reason, issue.message));
      return;
    }
    validRows.push({ input, rowIndex });
  });

  const grouped = new Map<string, Array<{ input: PriceImportInput; rowIndex: number }>>();
  for (const row of validRows) {
    const key = recordKey(row.input);
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }

  const candidates: Array<{ input: PriceImportInput; rowIndex: number }> = [];
  for (const rows of grouped.values()) {
    const signatures = new Set(rows.map(row => recordContent(row.input)));
    if (signatures.size > 1) {
      for (const row of rows) {
        results.push(previewItem(
          row.input,
          row.rowIndex,
          "conflict",
          "BATCH_RECORD_CONFLICT",
          "同一日期和对象在本批次中出现不同价格或来源，请保留一条"
        ));
      }
      continue;
    }

    candidates.push(rows[0]);
    for (const duplicate of rows.slice(1)) {
      results.push(previewItem(
        duplicate.input,
        duplicate.rowIndex,
        "skip",
        "BATCH_RECORD_DUPLICATE",
        "本批次内存在完全相同记录，将跳过"
      ));
    }
  }

  const categoryCache = new Map<string, any>();
  const objectCache = new Map<string, any>();
  const variantCache = new Map<string, any>();

  for (const candidate of candidates) {
    const { input, rowIndex } = candidate;
    let category = categoryCache.get(input.category_name);
    if (category === undefined) {
      category = await db.get(
        "SELECT id FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0",
        [input.category_name]
      ) || null;
      categoryCache.set(input.category_name, category);
    }
    if (!category) {
      results.push(previewItem(input, rowIndex, "error", "MASTER_DATA_NOT_FOUND", "未找到对应品类主数据"));
      continue;
    }

    const objectKey = `${category.id}\u0000${input.object_name}`;
    let object = objectCache.get(objectKey);
    if (object === undefined) {
      object = await db.get(
        "SELECT id FROM objects WHERE category_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
        [category.id, input.object_name]
      ) || null;
      objectCache.set(objectKey, object);
    }
    if (!object) {
      results.push(previewItem(input, rowIndex, "error", "MASTER_DATA_NOT_FOUND", "未找到对应对象主数据"));
      continue;
    }

    if (input.variant_name) {
      const variantKey = `${object.id}\u0000${input.variant_name}`;
      let variant = variantCache.get(variantKey);
      if (variant === undefined) {
        variant = await db.get(
          "SELECT id FROM variants WHERE object_id = ? AND name = ? AND COALESCE(is_archived, 0) = 0",
          [object.id, input.variant_name]
        ) || null;
        variantCache.set(variantKey, variant);
      }
      if (!variant) {
        results.push(previewItem(input, rowIndex, "error", "MASTER_DATA_NOT_FOUND", "未找到对应变体主数据"));
        continue;
      }
    }

    const existingRecords = await db.all(
      `SELECT id, price, COALESCE(source, '') AS source, COALESCE(note, '') AS note
       FROM price_records
       WHERE date = ? AND category = ? AND object_name = ? AND COALESCE(variant, '') = ?
       ORDER BY id`,
      [input.date, input.category_name, input.object_name, input.variant_name]
    );

    if (existingRecords.length > 1) {
      results.push(previewItem(
        input,
        rowIndex,
        "conflict",
        "EXISTING_RECORD_CONFLICT",
        `数据库中已有 ${existingRecords.length} 条同日记录，请先在价格工作台合并或修正`
      ));
      continue;
    }

    const existing = existingRecords[0];

    if (!existing) {
      results.push(previewItem(input, rowIndex, "create", "NEW_RECORD", "将新增价格记录"));
      continue;
    }

    const unchanged = Number(existing.price) === input.price
      && toText(existing.source) === input.source
      && toText(existing.note) === input.note;
    results.push(previewItem(
      input,
      rowIndex,
      unchanged ? "skip" : "update",
      unchanged ? "RECORD_UNCHANGED" : "EXISTING_RECORD_CHANGED",
      unchanged ? "数据库中已有完全相同记录，将跳过" : "数据库中已有同日记录，将更新价格、来源和备注",
      Number(existing.id)
    ));
  }

  return summarizePreview(results, rawRecords.length);
};

export const applyPriceImportPreview = async (db: any, preview: PriceImportPreview) => {
  const now = new Date().toISOString();
  for (const record of preview.records) {
    if (record.action === "create") {
      await db.run(
        `INSERT INTO price_records
         (date, category, object_name, variant, price, source, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.date,
          record.category_name,
          record.object_name,
          record.variant_name,
          record.price,
          record.source,
          record.note,
          now,
          now
        ]
      );
    } else if (record.action === "update" && record.existing_record_id) {
      await db.run(
        `UPDATE price_records
         SET price = ?, source = ?, note = ?, updated_at = ?
         WHERE id = ?`,
        [record.price, record.source, record.note, now, record.existing_record_id]
      );
    }
  }
};

export const buildPriceImportCommitResult = (
  preview: PriceImportPreview,
  warningRecords: unknown[] = []
): PriceImportCommitResult => ({
  ...preview,
  success_count: preview.new_count + preview.update_count,
  created_count: preview.new_count,
  updated_count: preview.update_count,
  warning_count: warningRecords.length,
  warning_records: warningRecords,
  skipped_records: preview.records.filter(record => record.action === "skip"),
  failed_records: preview.records.filter(record => record.action === "conflict" || record.action === "error")
});

export const executePriceImportBatch = async (
  db: any,
  batchId: string,
  rawRecords: unknown[],
  options: ExecutePriceImportBatchOptions = {}
) => {
  const payloadHash = hashPriceImportPayload(rawRecords);
  const existingBatch = await db.get(
    "SELECT payload_hash, status, result_json FROM price_import_batches WHERE batch_id = ?",
    [batchId]
  );

  if (existingBatch) {
    if (existingBatch.payload_hash !== payloadHash) {
      throw new PriceImportBatchConflictError("该批次号已用于另一份导入内容，请重新预览");
    }
    if (existingBatch.status === "completed" && existingBatch.result_json) {
      return {
        result: JSON.parse(existingBatch.result_json) as PriceImportCommitResult,
        idempotentReplay: true
      };
    }
    throw new PriceImportBatchConflictError("该批次尚未完成，请稍后重试");
  }

  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO price_import_batches (batch_id, payload_hash, status, created_at)
     VALUES (?, ?, 'processing', ?)`,
    [batchId, payloadHash, now]
  );

  const preview = await buildPriceImportPreview(db, rawRecords);
  if (preview.conflict_count > 0 || preview.error_count > 0) {
    throw new PriceImportValidationError(preview);
  }

  const warningRecords: unknown[] = [];
  if (options.collectWarnings) {
    for (const record of preview.records) {
      if (record.action !== "create" && record.action !== "update") continue;
      const warnings = await options.collectWarnings(record);
      if (warnings && warnings.length > 0) {
        warningRecords.push({
          row_index: record.row_index,
          date: record.date,
          category_name: record.category_name,
          object_name: record.object_name,
          variant_name: record.variant_name,
          price: record.price,
          warnings
        });
      }
    }
  }

  await applyPriceImportPreview(db, preview);
  const result = buildPriceImportCommitResult(preview, warningRecords);
  await db.run(
    `UPDATE price_import_batches
     SET status = 'completed', result_json = ?, completed_at = ?
     WHERE batch_id = ?`,
    [JSON.stringify(result), new Date().toISOString(), batchId]
  );

  return { result, idempotentReplay: false };
};
