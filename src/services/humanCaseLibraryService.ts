import { isValidDateOnly } from "../utils/dateValidation";
import { HUMAN_CASE_SOURCE_TYPES } from "./humanCaseSourceService";

export const HUMAN_CASE_PATTERN_AXES = ["market", "human"] as const;
export const HUMAN_CASE_PATTERN_CATEGORIES = [
  "market_structure",
  "human_bias",
  "execution_error",
  "positive_discipline"
] as const;
export const HUMAN_CASE_ORIGIN_TYPES = ["self", "other", "public", "unconfirmed"] as const;
export const HUMAN_CASE_EVIDENCE_LEVELS = ["first_hand", "documented", "second_hand", "unconfirmed"] as const;
export const HUMAN_CASE_ACTION_QUALITIES = ["good", "flawed", "bad", "mixed", "unknown"] as const;
export const HUMAN_CASE_OUTCOME_TYPES = [
  "profit",
  "loss",
  "avoided_loss",
  "sold_early",
  "ongoing",
  "mixed",
  "unknown"
] as const;
export const HUMAN_CASE_PATTERN_ROLES = ["primary", "secondary"] as const;
export const HUMAN_CASE_PATTERN_MATURITIES = [
  "candidate",
  "recurring",
  "stable",
  "rule_ready"
] as const;
export const HUMAN_CASE_EVIDENCE_ROLES = [
  "negative",
  "positive",
  "boundary",
  "neutral"
] as const;
export const HUMAN_CASE_PRICE_SIGNAL_TYPES = [
  "bid",
  "ask",
  "transaction",
  "market_reference",
  "unconfirmed"
] as const;
export const HUMAN_CASE_BUYER_BREADTHS = [
  "unknown",
  "single",
  "concentrated",
  "multiple",
  "broad"
] as const;
export const HUMAN_CASE_DEPENDENCY_LEVELS = ["unknown", "high", "medium", "low"] as const;
export const HUMAN_CASE_EXIT_LIQUIDITIES = [
  "unknown",
  "thin",
  "limited",
  "normal",
  "deep"
] as const;

type PatternAxis = typeof HUMAN_CASE_PATTERN_AXES[number];
type PatternCategory = typeof HUMAN_CASE_PATTERN_CATEGORIES[number];
type OriginType = typeof HUMAN_CASE_ORIGIN_TYPES[number];
type EvidenceLevel = typeof HUMAN_CASE_EVIDENCE_LEVELS[number];
type ActionQuality = typeof HUMAN_CASE_ACTION_QUALITIES[number];
type OutcomeType = typeof HUMAN_CASE_OUTCOME_TYPES[number];
type PatternRole = typeof HUMAN_CASE_PATTERN_ROLES[number];
type PatternMaturity = typeof HUMAN_CASE_PATTERN_MATURITIES[number];
type EvidenceRole = typeof HUMAN_CASE_EVIDENCE_ROLES[number];
type PriceSignalType = typeof HUMAN_CASE_PRICE_SIGNAL_TYPES[number];
type BuyerBreadth = typeof HUMAN_CASE_BUYER_BREADTHS[number];
type DependencyLevel = typeof HUMAN_CASE_DEPENDENCY_LEVELS[number];
type ExitLiquidity = typeof HUMAN_CASE_EXIT_LIQUIDITIES[number];

const MAX_LIST_ITEMS = 20;

const normalizeText = (
  value: unknown,
  label: string,
  maxLength: number,
  required = false
) => {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return normalized;
};

const normalizeEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  fallback?: T
) => {
  const normalized = String(value ?? "").trim() as T;
  if (!normalized && fallback) return fallback;
  if (!allowed.includes(normalized)) {
    throw new Error(`${label}不在允许范围内`);
  }
  return normalized;
};

const normalizeTextList = (value: unknown, label: string) => {
  const items = Array.isArray(value)
    ? value
    : String(value ?? "")
      .split(/\r?\n|[,，]/)
      .map(item => item.trim())
      .filter(Boolean);

  if (items.length > MAX_LIST_ITEMS) {
    throw new Error(`${label}最多保留 ${MAX_LIST_ITEMS} 条`);
  }

  const normalized = items.map((item, index) => (
    normalizeText(item, `${label}第 ${index + 1} 条`, 160, true)
  ));
  return Array.from(new Set(normalized));
};

const normalizeOptionalDate = (value: unknown) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!isValidDateOnly(normalized)) throw new Error("案例日期格式应为 YYYY-MM-DD");
  return normalized;
};

const normalizeOptionalId = (value: unknown, label: string) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^\d+$/.test(normalized) || Number(normalized) <= 0) {
    throw new Error(`${label}必须是有效记录 ID`);
  }
  return normalized;
};

const normalizeOptionalPositiveNumber = (value: unknown, label: string) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 1_000_000_000_000) {
    throw new Error(`${label}必须是大于 0 的有效数字`);
  }
  return Math.round(normalized * 100) / 100;
};

export interface HumanCasePricingAnalysisInput {
  basePriceLabel: string;
  basePrice: number | null;
  observedPriceLabel: string;
  observedPriceLow: number | null;
  observedPriceHigh: number | null;
  priceSignalType: PriceSignalType;
  conditionStack: string[];
  buyerBreadth: BuyerBreadth;
  keyBuyerDependency: DependencyLevel;
  exitLiquidity: ExitLiquidity;
  verificationNote: string;
}

const normalizeHumanCasePricingAnalysis = (value: unknown): HumanCasePricingAnalysisInput => {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const basePrice = normalizeOptionalPositiveNumber(
    input.base_price ?? input.basePrice,
    "基础品参考价"
  );
  const observedPriceLow = normalizeOptionalPositiveNumber(
    input.observed_price_low ?? input.observedPriceLow,
    "观察价下限"
  );
  let observedPriceHigh = normalizeOptionalPositiveNumber(
    input.observed_price_high ?? input.observedPriceHigh,
    "观察价上限"
  );
  if (observedPriceLow !== null && observedPriceHigh === null) {
    observedPriceHigh = observedPriceLow;
  }
  if (
    observedPriceLow !== null
    && observedPriceHigh !== null
    && observedPriceHigh < observedPriceLow
  ) {
    throw new Error("观察价上限不能低于下限");
  }

  return {
    basePriceLabel: normalizeText(
      input.base_price_label ?? input.basePriceLabel,
      "基础价口径",
      160
    ),
    basePrice,
    observedPriceLabel: normalizeText(
      input.observed_price_label ?? input.observedPriceLabel,
      "观察价口径",
      160
    ),
    observedPriceLow,
    observedPriceHigh,
    priceSignalType: normalizeEnum(
      input.price_signal_type ?? input.priceSignalType,
      HUMAN_CASE_PRICE_SIGNAL_TYPES,
      "价格信号性质",
      "unconfirmed"
    ),
    conditionStack: normalizeTextList(
      input.condition_stack ?? input.conditionStack,
      "叠加条件"
    ),
    buyerBreadth: normalizeEnum(
      input.buyer_breadth ?? input.buyerBreadth,
      HUMAN_CASE_BUYER_BREADTHS,
      "买盘宽度",
      "unknown"
    ),
    keyBuyerDependency: normalizeEnum(
      input.key_buyer_dependency ?? input.keyBuyerDependency,
      HUMAN_CASE_DEPENDENCY_LEVELS,
      "关键买家依赖",
      "unknown"
    ),
    exitLiquidity: normalizeEnum(
      input.exit_liquidity ?? input.exitLiquidity,
      HUMAN_CASE_EXIT_LIQUIDITIES,
      "退出深度",
      "unknown"
    ),
    verificationNote: normalizeText(
      input.verification_note ?? input.verificationNote,
      "价格验证备注",
      2000
    )
  };
};

export interface HumanCasePatternInput {
  name: string;
  axis: PatternAxis;
  category: PatternCategory;
  summary: string;
  triggerPhrases: string[];
  observableActions: string[];
  mechanism: string;
  riskChain: string;
  counterQuestion: string;
  protectiveAction: string;
  positiveCounterpart: string;
  maturity: PatternMaturity;
  status: "active" | "archived";
  sortOrder: number;
  note: string;
}

export interface HumanCasePatternLinkInput {
  patternId: number;
  role: PatternRole;
}

export interface HumanCaseInput {
  title: string;
  originType: OriginType;
  subjectAlias: string;
  sourceNote: string;
  evidenceLevel: EvidenceLevel;
  caseDate: string;
  track: string;
  projectName: string;
  background: string;
  visibleInformation: string;
  pressureContext: string;
  actionTaken: string;
  result: string;
  actionQuality: ActionQuality;
  outcomeType: OutcomeType;
  evidenceRole: EvidenceRole;
  selfResponse: string;
  learnToKeep: string;
  learnToAvoid: string;
  applicabilityBoundary: string;
  linkedRuleRefs: string[];
  sourceType: string;
  sourceId: string;
  note: string;
  pricingAnalysis: HumanCasePricingAnalysisInput;
  patternLinks: HumanCasePatternLinkInput[];
}

export const normalizeHumanCasePatternInput = (value: unknown): HumanCasePatternInput => {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const axis = normalizeEnum(input.axis, HUMAN_CASE_PATTERN_AXES, "模式轴");
  const category = normalizeEnum(input.category, HUMAN_CASE_PATTERN_CATEGORIES, "模式分类");

  if (axis === "market" && category !== "market_structure") {
    throw new Error("市场轴只能使用市场结构分类");
  }
  if (axis === "human" && category === "market_structure") {
    throw new Error("内部人性轴不能使用市场结构分类");
  }

  const sortOrderValue = Number(input.sort_order ?? input.sortOrder ?? 0);
  if (!Number.isInteger(sortOrderValue) || sortOrderValue < 0 || sortOrderValue > 10000) {
    throw new Error("显示顺序必须是 0 到 10000 的整数");
  }

  return {
    name: normalizeText(input.name, "模式名称", 80, true),
    axis,
    category,
    summary: normalizeText(input.summary, "模式说明", 1200),
    triggerPhrases: normalizeTextList(input.trigger_phrases ?? input.triggerPhrases, "触发语言"),
    observableActions: normalizeTextList(input.observable_actions ?? input.observableActions, "外在动作"),
    mechanism: normalizeText(input.mechanism, "内在机制", 2000),
    riskChain: normalizeText(input.risk_chain ?? input.riskChain, "风险链条", 2000),
    counterQuestion: normalizeText(input.counter_question ?? input.counterQuestion, "临场反问", 1000),
    protectiveAction: normalizeText(input.protective_action ?? input.protectiveAction, "防护动作", 2000),
    positiveCounterpart: normalizeText(
      input.positive_counterpart ?? input.positiveCounterpart,
      "对照能力",
      1000
    ),
    maturity: normalizeEnum(
      input.maturity,
      HUMAN_CASE_PATTERN_MATURITIES,
      "模式成熟度",
      "candidate"
    ),
    status: normalizeEnum(input.status, ["active", "archived"] as const, "模式状态", "active"),
    sortOrder: sortOrderValue,
    note: normalizeText(input.note, "备注", 3000)
  };
};

export const normalizeHumanCaseInput = (value: unknown): HumanCaseInput => {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawLinks = input.pattern_links ?? input.patternLinks;
  const links = Array.isArray(rawLinks) ? rawLinks : [];
  if (links.length > 3) throw new Error("每条案例最多关联 1 个主决策模式和 2 个辅助模式");

  const patternLinks = links.map((item, index) => {
    const link = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const patternId = Number(link.pattern_id ?? link.patternId);
    if (!Number.isInteger(patternId) || patternId <= 0) {
      throw new Error(`第 ${index + 1} 个关联模式 ID 不合法`);
    }
    return {
      patternId,
      role: normalizeEnum(link.role, HUMAN_CASE_PATTERN_ROLES, "模式角色", "secondary")
    };
  });

  const deduplicatedLinks = Array.from(
    new Map(patternLinks.map(link => [link.patternId, link])).values()
  );

  const sourceType = normalizeText(input.source_type ?? input.sourceType, "关联来源类型", 80);
  const sourceId = normalizeOptionalId(input.source_id ?? input.sourceId, "关联来源");
  if (Boolean(sourceType) !== Boolean(sourceId)) {
    throw new Error("来源类型和来源记录 ID 必须同时填写");
  }
  if (sourceType && !HUMAN_CASE_SOURCE_TYPES.includes(sourceType as any)) {
    throw new Error("来源类型不在允许范围内");
  }

  return {
    title: normalizeText(input.title, "案例标题", 160, true),
    originType: normalizeEnum(
      input.origin_type ?? input.originType,
      HUMAN_CASE_ORIGIN_TYPES,
      "案例来源",
      "other"
    ),
    subjectAlias: normalizeText(input.subject_alias ?? input.subjectAlias, "人物或别名", 100),
    sourceNote: normalizeText(input.source_note ?? input.sourceNote, "来源说明", 1000),
    evidenceLevel: normalizeEnum(
      input.evidence_level ?? input.evidenceLevel,
      HUMAN_CASE_EVIDENCE_LEVELS,
      "证据程度",
      "unconfirmed"
    ),
    caseDate: normalizeOptionalDate(input.case_date ?? input.caseDate),
    track: normalizeText(input.track, "品类或赛道", 100),
    projectName: normalizeText(input.project_name ?? input.projectName, "对象或项目", 160),
    background: normalizeText(input.background, "当时背景", 5000, true),
    visibleInformation: normalizeText(
      input.visible_information ?? input.visibleInformation,
      "当时可见信息",
      5000
    ),
    pressureContext: normalizeText(
      input.pressure_context ?? input.pressureContext,
      "当时压力",
      4000
    ),
    actionTaken: normalizeText(input.action_taken ?? input.actionTaken, "实际动作", 5000, true),
    result: normalizeText(input.result, "后来结果", 5000),
    actionQuality: normalizeEnum(
      input.action_quality ?? input.actionQuality,
      HUMAN_CASE_ACTION_QUALITIES,
      "动作质量",
      "unknown"
    ),
    outcomeType: normalizeEnum(
      input.outcome_type ?? input.outcomeType,
      HUMAN_CASE_OUTCOME_TYPES,
      "结果类型",
      "unknown"
    ),
    evidenceRole: normalizeEnum(
      input.evidence_role ?? input.evidenceRole,
      HUMAN_CASE_EVIDENCE_ROLES,
      "证据角色",
      "neutral"
    ),
    selfResponse: normalizeText(
      input.self_response ?? input.selfResponse,
      "如果换成我会怎么做",
      5000,
      true
    ),
    learnToKeep: normalizeText(input.learn_to_keep ?? input.learnToKeep, "要吸收的能力", 3000),
    learnToAvoid: normalizeText(input.learn_to_avoid ?? input.learnToAvoid, "要避免的动作", 3000),
    applicabilityBoundary: normalizeText(
      input.applicability_boundary ?? input.applicabilityBoundary,
      "适用边界",
      3000
    ),
    linkedRuleRefs: normalizeTextList(
      input.linked_rule_refs ?? input.linkedRuleRefs,
      "关联规则"
    ),
    sourceType,
    sourceId,
    note: normalizeText(input.note, "备注", 5000),
    pricingAnalysis: normalizeHumanCasePricingAnalysis(
      input.pricing_analysis ?? input.pricingAnalysis
    ),
    patternLinks: deduplicatedLinks
  };
};

export const parseStoredStringList = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(item => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
};
