import getDb from "../../config/database";
import { productPriceHashOf } from "./signalText";
import { extractSignalPrice } from "./signalPrice";
import { resolveRecyclePrice } from "./recyclePriceService";
import {
  SIGNAL_EXCLUDED_CATEGORIES,
  buildSkuDictionary,
  matchSignalToSku,
  type SkuDictionary
} from "./signalSkuMatcher";

/**
 * 归一后分析：SKU 匹配 → 回收价 → 理论空间 → 可执行性。
 *
 * 实验要求第十二/十三/十六条：
 * - 只算「理论空间」，不叫利润（没扣运费、售后、回收价波动、资金占用、买入成功率）；
 * - 六条确定性规则决定 profit_status，阈值来自 signal_settings，不写死；
 * - 可执行性与风控第一版先做确定性推断，人工可覆盖，不自动认定私家车。
 */

export interface SignalSettings {
  minimum_profit: number;
  minimum_margin_rate: number;
  private_candidate_min_source_gap_minutes: number;
}

export type ProfitStatus =
  | "UNMATCHED"
  | "AMBIGUOUS"
  | "PENDING_PRICE"
  | "PENDING_RECYCLE"
  | "NO_PROFIT"
  | "PROFITABLE_CANDIDATE"
  | "HIGH_VALUE_CANDIDATE";

const DEFAULT_SETTINGS: SignalSettings = {
  minimum_profit: 100,
  minimum_margin_rate: 0.05,
  private_candidate_min_source_gap_minutes: 30
};

export const loadSignalSettings = async (db: any): Promise<SignalSettings> => {
  const rows = await db.all("SELECT setting_key, setting_value FROM signal_settings");
  const map = new Map<string, string>(
    (rows as Array<{ setting_key: string; setting_value: string }>).map(row => [row.setting_key, row.setting_value])
  );
  const numeric = (key: string, fallback: number) => {
    const parsed = Number(map.get(key));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    minimum_profit: numeric("minimum_profit", DEFAULT_SETTINGS.minimum_profit),
    minimum_margin_rate: numeric("minimum_margin_rate", DEFAULT_SETTINGS.minimum_margin_rate),
    private_candidate_min_source_gap_minutes: numeric(
      "private_candidate_min_source_gap_minutes",
      DEFAULT_SETTINGS.private_candidate_min_source_gap_minutes
    )
  };
};

/** 账号要求、地区、限购、资格：只做确定性关键词识别，识别不出就留「未知」等人工补。 */
export const inferExecutionFields = (title: string, content: string, regionFromPrice: string | null) => {
  const text = `${title}\n${content}`;

  let accountRequirement = "未知";
  // 顺序要紧：「不限新老用户」里含有「老用户」子串，必须先判不限，否则会被误判成老号。
  if (/(不限新老|新老用户均可|不限账号|新老皆可)/.test(text)) accountRequirement = "不限";
  else if (/(新号|首购|首单|新人|新客|新用户)/.test(text)) accountRequirement = "新号";
  else if (/(老号|老用户|老客|老会员)/.test(text)) accountRequirement = "老号";

  const limitMatch = text.match(/(?:限购|每人限|每户限|单个账号限)\s*(\d{1,3})\s*(?:件|个|份|台|瓶|盒|套)?/);
  const purchaseLimit = limitMatch ? `限购 ${limitMatch[1]}` : null;

  const qualifications: string[] = [];
  if (/(学生号|学生认证|学生身份|校园)/.test(text)) qualifications.push("需学生认证");
  if (/(PLUS会员|plus会员|会员专享|需会员|开会员)/i.test(text)) qualifications.push("需会员");
  if (/(信用卡|指定银行卡|储蓄卡|银行卡支付|工行|建行|农行|中行|招行)/.test(text)) qualifications.push("需指定银行卡");
  if (/(新客专享|邀请|助力|拉新)/.test(text)) qualifications.push("需邀请/助力");

  const regionFromText = text.match(/(限|仅限|只限)\s*([\u4e00-\u9fa5]{2,8}(?:地区|省|市|区|县|自治区))/);
  const regionRequirement = regionFromPrice || (regionFromText ? regionFromText[0].trim() : null);

  const hasQualification = qualifications.length > 0;

  let executionLevel = "UNKNOWN";
  if (regionRequirement || hasQualification || accountRequirement === "新号" || purchaseLimit === "限购 1") {
    executionLevel = "C";
  } else if (purchaseLimit || accountRequirement === "未知") {
    executionLevel = "B";
  } else {
    executionLevel = "A";
  }

  return {
    accountRequirement,
    accountRisk: "UNKNOWN" as const,
    regionRequirement,
    qualificationRequirement: hasQualification ? qualifications.join(" + ") : null,
    purchaseLimit,
    inventoryStatus: "UNKNOWN",
    executionLevel,
    inferred: true
  };
};

export interface AnalysisOutcome {
  id: number;
  profit_status: ProfitStatus;
  match_status: string;
  sku: string | null;
  gross_spread: number | null;
  gross_margin_rate: number | null;
  reason: string;
}

const analyzeRow = async (
  db: any,
  row: any,
  dictionary: SkuDictionary,
  settings: SignalSettings
): Promise<AnalysisOutcome> => {
  const title = String(row.title ?? "");
  const content = String(row.content ?? "");
  const price = extractSignalPrice(title, content);

  // 已有解析结果就以库里为准（可能是上一轮更完整的正文算出来的），否则用本次解析。
  const storedFinal = Number(row.final_buy_price);
  const finalBuyPrice = Number.isFinite(storedFinal) && storedFinal > 0
    ? storedFinal
    : (price.finalBuyPrice ?? null);

  const execution = inferExecutionFields(title, content, price.detail.regionText);

  const match = matchSignalToSku(title, content, dictionary);
  const baseUpdate = {
    match_status: match.match_status,
    match_confidence: match.confidence,
    matched_product_name: match.matched_product_name || null,
    sku: match.sku,
    category_name: match.category_name,
    object_name: match.object_name,
    variant_name: match.variant_name,
    account_requirement: execution.accountRequirement,
    account_risk: execution.accountRisk,
    region_requirement: execution.regionRequirement,
    qualification_requirement: execution.qualificationRequirement,
    purchase_limit: execution.purchaseLimit,
    inventory_status: execution.inventoryStatus,
    execution_level: execution.executionLevel
  };

  const finalize = async (
    profitStatus: ProfitStatus,
    extra: Record<string, unknown>,
    reason: string
  ): Promise<AnalysisOutcome> => {
    const now = new Date().toISOString();
    const privateCandidate = (
      (profitStatus === "PROFITABLE_CANDIDATE" || profitStatus === "HIGH_VALUE_CANDIDATE")
      && Number(row.source_count ?? 1) <= 1
      && Boolean(row.deal_url)
      && (Date.now() - new Date(String(row.first_seen_at)).getTime()) >= settings.private_candidate_min_source_gap_minutes * 60 * 1000
    ) ? 1 : 0;

    await db.run(
      `UPDATE normalized_signal
          SET match_status = ?, match_confidence = ?, matched_product_name = ?, sku = ?,
              category_name = ?, object_name = ?, variant_name = ?,
              account_requirement = ?, account_risk = ?, region_requirement = ?,
              qualification_requirement = ?, purchase_limit = ?, inventory_status = ?,
              execution_level = ?, profit_status = ?, private_candidate = ?,
              product_price_hash = ?, updated_at = ?
              ${Object.keys(extra).length > 0 ? `, ${Object.keys(extra).map(key => `${key} = ?`).join(", ")}` : ""}
        WHERE id = ?`,
      [
        baseUpdate.match_status,
        baseUpdate.match_confidence,
        baseUpdate.matched_product_name,
        baseUpdate.sku,
        baseUpdate.category_name,
        baseUpdate.object_name,
        baseUpdate.variant_name,
        baseUpdate.account_requirement,
        baseUpdate.account_risk,
        baseUpdate.region_requirement,
        baseUpdate.qualification_requirement,
        baseUpdate.purchase_limit,
        baseUpdate.inventory_status,
        baseUpdate.execution_level,
        profitStatus,
        privateCandidate,
        productPriceHashOf(match.sku, finalBuyPrice, row.published_at),
        now,
        ...Object.values(extra),
        row.id
      ]
    );

    return {
      id: Number(row.id),
      profit_status: profitStatus,
      match_status: baseUpdate.match_status,
      sku: match.sku,
      gross_spread: (extra.gross_spread as number | null) ?? null,
      gross_margin_rate: (extra.gross_margin_rate as number | null) ?? null,
      reason
    };
  };

  const clearRecycle = {
    current_recycle_price: null,
    recycle_price_updated_at: null,
    recycle_source: null,
    recycle_confidence: null,
    gross_spread: null,
    gross_margin_rate: null
  };

  // Rule 1：没有可靠 SKU → 未匹配线报，不参与利润计算
  if (match.match_status === "unmatched") {
    return finalize("UNMATCHED", clearRecycle, match.note);
  }
  if (match.match_status === "ambiguous") {
    return finalize("AMBIGUOUS", clearRecycle, match.note);
  }

  // Rule 2：匹配到 SKU 但没有可用价格 → 待人工价格确认
  if (finalBuyPrice === null || !(finalBuyPrice > 0)) {
    return finalize("PENDING_PRICE", clearRecycle, "已匹配 SKU 但没有可确定的入手价");
  }

  // Rule 3：有价格但没有回收价 → 待回收价确认
  const recycle = await resolveRecyclePrice(db, {
    category_name: match.category_name,
    object_name: match.object_name,
    variant_name: match.variant_name
  });
  if (!recycle) {
    return finalize("PENDING_RECYCLE", clearRecycle, "已匹配 SKU 且有价格，但没有可用的回收价来源");
  }

  const grossSpread = Number((recycle.price - finalBuyPrice).toFixed(2));
  const grossMarginRate = Number((grossSpread / finalBuyPrice).toFixed(4));
  const recycleFields = {
    current_recycle_price: recycle.price,
    recycle_price_updated_at: recycle.effective_date,
    recycle_source: recycle.source,
    recycle_confidence: recycle.confidence,
    gross_spread: grossSpread,
    gross_margin_rate: grossMarginRate
  };

  // Rule 4：理论空间 <= 0
  if (grossSpread <= 0) {
    return finalize("NO_PROFIT", recycleFields, `回收价 ${recycle.price} 未高于入手价 ${finalBuyPrice}`);
  }

  // Rule 6：达到阈值的重点候选
  if (grossSpread >= settings.minimum_profit && grossMarginRate >= settings.minimum_margin_rate) {
    return finalize(
      "HIGH_VALUE_CANDIDATE",
      recycleFields,
      `理论空间 ${grossSpread}（≥${settings.minimum_profit}）且利润率 ${(grossMarginRate * 100).toFixed(1)}%`
    );
  }

  // Rule 5：有空间但没到阈值
  return finalize("PROFITABLE_CANDIDATE", recycleFields, `理论空间 ${grossSpread}`);
};

export interface AnalyzeBatchResult {
  analyzed: number;
  by_status: Record<string, number>;
}

export const analyzeNormalizedSignals = async (
  options: { ids?: number[]; limit?: number; onlyPending?: boolean; db?: any } = {}
): Promise<AnalyzeBatchResult> => {
  const db = options.db ?? await getDb();
  const settings = await loadSignalSettings(db);
  const dictionary = await buildSkuDictionary(db);

  const where: string[] = [];
  const params: unknown[] = [];
  if (options.ids && options.ids.length > 0) {
    where.push(`id IN (${options.ids.map(() => "?").join(", ")})`);
    params.push(...options.ids);
  }
  if (options.onlyPending) {
    const excluded = SIGNAL_EXCLUDED_CATEGORIES.map(() => "?").join(", ");
    where.push(
      `(profit_status IN ('UNMATCHED', 'PENDING_PRICE', 'PENDING_RECYCLE') OR category_name IN (${excluded}))`
    );
    params.push(...SIGNAL_EXCLUDED_CATEGORIES);
  }
  const limit = Math.min(Math.max(Number(options.limit) || 500, 1), 5000);

  const rows = await db.all(
    `SELECT * FROM normalized_signal
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id DESC
      LIMIT ?`,
    [...params, limit]
  );

  const byStatus: Record<string, number> = {};
  let analyzed = 0;
  for (const row of rows as any[]) {
    const outcome = await analyzeRow(db, row, dictionary, settings);
    byStatus[outcome.profit_status] = (byStatus[outcome.profit_status] ?? 0) + 1;
    analyzed += 1;
  }

  return { analyzed, by_status: byStatus };
};
