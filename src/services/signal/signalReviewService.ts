import getDb from "../../config/database";

/**
 * 人工审核与最终结果记录（实验里最重要的数据资产）。
 *
 * 约定：
 * - 人工判断（review_verdict）只有人能定：真车 / 假车 / 公交车 / 小利润 / 无法执行 / 格局 / 待观察；
 *   系统给的 private_candidate 只是候选提示，不等于判断。
 * - 最终结果（实际回收价、实际成本、实际利润）单独记录，用于算真实利润率。
 * - 失效时间一旦记录，同时算出 opportunity_window（首次发现 → 失效）。
 */

export const REVIEW_VERDICTS = ["真车", "假车", "公交车", "小利润", "无法执行", "格局", "待观察"] as const;
export const OUTCOME_STATUSES = ["VALID", "INVALID", "PARTIAL", "PENDING", "UNKNOWN"] as const;
export const EXPIRATION_REASONS = [
  "回收下降",
  "商品卖完",
  "活动结束",
  "被砍单",
  "线报失效",
  "公交后无利润",
  "来源错误",
  "其它"
] as const;
export const EXECUTION_LEVELS = ["A", "B", "C", "D", "UNKNOWN"] as const;
export const ACCOUNT_RISKS = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const;
export const ACCOUNT_REQUIREMENTS = ["新号", "老号", "低频号", "不限", "未知"] as const;

export class SignalReviewError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "SignalReviewError";
  }
}

const normalizeText = (value: unknown): string => String(value ?? "").trim();

const assertIn = (value: string, allowed: readonly string[], label: string) => {
  if (!allowed.includes(value)) {
    throw new SignalReviewError(400, `${label} 必须是：${allowed.join(" / ")}`);
  }
};

export interface ReviewInput {
  verdict?: string;
  note?: string;
  reviewer?: string;
  execution_level?: string;
  account_risk?: string;
  account_requirement?: string;
  purchase_limit?: string;
  region_requirement?: string;
  qualification_requirement?: string;
  inventory_status?: string;
}

export const reviewSignal = async (id: number | string, input: ReviewInput) => {
  const db = await getDb();
  const existing = await db.get("SELECT id FROM normalized_signal WHERE id = ?", [id]);
  if (!existing) throw new SignalReviewError(404, "线报不存在");

  const verdict = normalizeText(input.verdict);
  assertIn(verdict, REVIEW_VERDICTS, "人工判断");

  const updates: string[] = [
    "review_status = 'reviewed'",
    "review_verdict = ?",
    "review_note = ?",
    "reviewer = ?",
    "reviewed_at = ?"
  ];
  const params: unknown[] = [
    verdict,
    input.note === undefined ? null : normalizeText(input.note),
    input.reviewer === undefined ? null : normalizeText(input.reviewer),
    new Date().toISOString()
  ];

  const optionalFields: Array<[keyof ReviewInput, string, readonly string[] | null]> = [
    ["execution_level", "execution_level", EXECUTION_LEVELS],
    ["account_risk", "account_risk", ACCOUNT_RISKS],
    ["account_requirement", "account_requirement", ACCOUNT_REQUIREMENTS],
    ["purchase_limit", "purchase_limit", null],
    ["region_requirement", "region_requirement", null],
    ["qualification_requirement", "qualification_requirement", null],
    ["inventory_status", "inventory_status", null]
  ];

  for (const [inputKey, column, allowed] of optionalFields) {
    const value = input[inputKey];
    if (value === undefined) continue;
    const text = normalizeText(value);
    if (allowed) assertIn(text, allowed, column);
    updates.push(`${column} = ?`);
    params.push(text || null);
  }

  updates.push("updated_at = ?");
  params.push(new Date().toISOString());

  await db.run(`UPDATE normalized_signal SET ${updates.join(", ")} WHERE id = ?`, [...params, id]);
  return db.get("SELECT * FROM normalized_signal WHERE id = ?", [id]);
};

export interface OutcomeInput {
  outcome_status?: string;
  actual_recycle_price?: number | string | null;
  actual_cost?: number | string | null;
  actual_profit?: number | string | null;
  outcome_note?: string;
  actual_date?: string;
}

export const recordSignalOutcome = async (id: number | string, input: OutcomeInput) => {
  const db = await getDb();
  const existing = await db.get("SELECT * FROM normalized_signal WHERE id = ?", [id]);
  if (!existing) throw new SignalReviewError(404, "线报不存在");

  const outcomeStatus = normalizeText(input.outcome_status || "PENDING");
  assertIn(outcomeStatus, OUTCOME_STATUSES, "最终结果");

  const toNumberOrNull = (value: unknown): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new SignalReviewError(400, "金额必须是数字");
    return parsed;
  };

  const actualRecycle = toNumberOrNull(input.actual_recycle_price);
  const actualCost = toNumberOrNull(input.actual_cost);
  let actualProfit = toNumberOrNull(input.actual_profit);
  // 没填利润但有回收价和成本时直接算，不让人手算错。
  if (actualProfit === null && actualRecycle !== null && actualCost !== null) {
    actualProfit = Number((actualRecycle - actualCost).toFixed(2));
  }

  await db.run(
    `UPDATE normalized_signal
        SET outcome_status = ?, actual_recycle_price = ?, actual_cost = ?, actual_profit = ?,
            outcome_note = ?, updated_at = ?
      WHERE id = ?`,
    [
      outcomeStatus,
      actualRecycle,
      actualCost,
      actualProfit,
      input.outcome_note === undefined ? null : normalizeText(input.outcome_note),
      new Date().toISOString(),
      id
    ]
  );
  // 记了实际结果就不再算「待观察」，但人工判断仍然只有人能改。
  if (outcomeStatus === "VALID" || outcomeStatus === "INVALID") {
    await db.run(
      "UPDATE normalized_signal SET review_status = 'reviewed', reviewed_at = COALESCE(reviewed_at, ?) WHERE id = ?",
      [new Date().toISOString(), id]
    );
  }
  return db.get("SELECT * FROM normalized_signal WHERE id = ?", [id]);
};

export interface ExpireInput {
  expired_at?: string;
  expiration_reason?: string;
}

export const expireSignal = async (id: number | string, input: ExpireInput) => {
  const db = await getDb();
  const existing = await db.get("SELECT id, first_seen_at FROM normalized_signal WHERE id = ?", [id]);
  if (!existing) throw new SignalReviewError(404, "线报不存在");

  const reason = normalizeText(input.expiration_reason);
  assertIn(reason, EXPIRATION_REASONS, "失效原因");

  const expiredAt = normalizeText(input.expired_at) || new Date().toISOString();
  const expiredDate = new Date(expiredAt);
  if (Number.isNaN(expiredDate.getTime())) throw new SignalReviewError(400, "失效时间格式不正确");

  const firstSeen = new Date(String((existing as any).first_seen_at));
  const windowMinutes = Number.isNaN(firstSeen.getTime())
    ? null
    : Math.max(0, Math.round((expiredDate.getTime() - firstSeen.getTime()) / 60000));

  await db.run(
    `UPDATE normalized_signal
        SET expired_at = ?, expiration_reason = ?, opportunity_window_minutes = ?, updated_at = ?
      WHERE id = ?`,
    [expiredDate.toISOString(), reason, windowMinutes, new Date().toISOString(), id]
  );
  return { id: Number(id), expired_at: expiredDate.toISOString(), expiration_reason: reason, opportunity_window_minutes: windowMinutes };
};

export const updateSignalSettings = async (entries: Array<{ key: string; value: string }>) => {
  const db = await getDb();
  const now = new Date().toISOString();
  for (const entry of entries) {
    const key = normalizeText(entry.key);
    if (!key) throw new SignalReviewError(400, "setting key 不能为空");
    const value = normalizeText(entry.value);
    await db.run(
      `INSERT INTO signal_settings (setting_key, setting_value, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
      [key, value, now, now]
    );
  }
  return db.all("SELECT setting_key, setting_value, note FROM signal_settings ORDER BY setting_key");
};

export const updateSignalSource = async (
  sourceKey: string,
  input: { enabled?: boolean | number; poll_interval?: number; note?: string }
) => {
  const db = await getDb();
  const existing = await db.get("SELECT * FROM signal_source WHERE source_key = ?", [sourceKey]);
  if (!existing) throw new SignalReviewError(404, "采集源不存在");

  const updates: string[] = [];
  const params: unknown[] = [];

  if (input.enabled !== undefined) {
    const enabled = input.enabled === true || Number(input.enabled) === 1 ? 1 : 0;
    updates.push("enabled = ?");
    params.push(enabled);
    // 手工恢复时清掉自动暂停的痕迹，让调度器重新开始
    if (enabled === 1) {
      updates.push("consecutive_failures = 0", "disabled_reason = NULL", "last_error_message = NULL");
    }
  }
  if (input.poll_interval !== undefined) {
    const interval = Math.max(5, Number(input.poll_interval) || 0);
    if (!interval) throw new SignalReviewError(400, "采集间隔必须是数字");
    updates.push("poll_interval = ?");
    params.push(interval);
  }
  if (input.note !== undefined) {
    updates.push("note = ?");
    params.push(normalizeText(input.note));
  }

  if (updates.length === 0) throw new SignalReviewError(400, "没有需要更新的字段");

  updates.push("updated_at = ?");
  params.push(new Date().toISOString());

  await db.run(`UPDATE signal_source SET ${updates.join(", ")} WHERE source_key = ?`, [...params, sourceKey]);
  return db.get("SELECT * FROM signal_source WHERE source_key = ?", [sourceKey]);
};
