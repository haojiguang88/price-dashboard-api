export const EVENT_TRANSMISSION_STATUSES = [
  'observation',
  'partially_verified',
  'verified',
  'refuted',
  'expired'
] as const;

export type EventTransmissionStatus = typeof EVENT_TRANSMISSION_STATUSES[number];

export interface EventTransmissionTarget {
  categoryId: string;
  categoryName: string;
  objectId: string;
  objectName: string;
  variantId: string;
  variantName: string;
}

export interface EventTransmissionEvidenceReference {
  sourceType: string;
  sourceId: string;
  title: string;
  path: string;
  relation: string;
}

export interface EventTransmissionAnalysis {
  status: EventTransmissionStatus;
  directImpact: string;
  secondOrderImpact: string;
  thirdOrderImpact: string;
  changedLink: string;
  pendingRepricingLink: string;
  expectedLag: string;
  validationIndicators: string;
  counterEvidence: string;
  reviewDate: string;
  validationNote: string;
  targets: EventTransmissionTarget[];
  evidenceReferences: EventTransmissionEvidenceReference[];
}

export class EventTransmissionValidationError extends Error {}

const STATUS_SET = new Set<string>(EVENT_TRANSMISSION_STATUSES);
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TARGETS = 12;
const MAX_EVIDENCE_REFERENCES = 12;

const isValidDateOnly = (value: string): boolean => {
  if (!DATE_ONLY_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

const normalizeText = (value: unknown, fieldName: string, maxLength = 2000): string => {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') {
    throw new EventTransmissionValidationError(`${fieldName}必须是文本`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new EventTransmissionValidationError(`${fieldName}不能超过${maxLength}个字符`);
  }
  return normalized;
};

const normalizeTarget = (value: unknown, index: number): EventTransmissionTarget => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EventTransmissionValidationError(`映射商品第${index + 1}项格式不正确`);
  }
  const target = value as Record<string, unknown>;
  const categoryId = normalizeText(target.categoryId, '品类ID', 80);
  const categoryName = normalizeText(target.categoryName, '品类名称', 120);
  const objectId = normalizeText(target.objectId, '对象ID', 80);
  const objectName = normalizeText(target.objectName, '对象名称', 120);
  const variantId = normalizeText(target.variantId, '变体ID', 80) || '0';
  const variantName = normalizeText(target.variantName, '变体名称', 120) || '暂无变体数据';

  if (!categoryId || !categoryName || !objectId || !objectName) {
    throw new EventTransmissionValidationError(`映射商品第${index + 1}项缺少稳定品类或对象信息`);
  }

  return { categoryId, categoryName, objectId, objectName, variantId, variantName };
};

const normalizeEvidenceReference = (
  value: unknown,
  index: number
): EventTransmissionEvidenceReference => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EventTransmissionValidationError(`关联证据第${index + 1}项格式不正确`);
  }
  const reference = value as Record<string, unknown>;
  const sourceType = normalizeText(reference.sourceType, '证据来源类型', 80);
  const sourceId = normalizeText(reference.sourceId, '证据来源ID', 80);
  const title = normalizeText(reference.title, '证据标题', 200);
  const path = normalizeText(reference.path, '证据路径', 500);
  const relation = normalizeText(reference.relation, '证据关系', 100);

  if (!sourceType || !sourceId || !title || !path) {
    throw new EventTransmissionValidationError(`关联证据第${index + 1}项缺少来源、标题或路径`);
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new EventTransmissionValidationError(`关联证据第${index + 1}项必须使用站内路径`);
  }

  return { sourceType, sourceId, title, path, relation };
};

const hasMeaningfulContent = (analysis: EventTransmissionAnalysis): boolean => {
  return analysis.targets.length > 0 || analysis.evidenceReferences.length > 0 || [
    analysis.directImpact,
    analysis.secondOrderImpact,
    analysis.thirdOrderImpact,
    analysis.changedLink,
    analysis.pendingRepricingLink,
    analysis.expectedLag,
    analysis.validationIndicators,
    analysis.counterEvidence,
    analysis.reviewDate,
    analysis.validationNote
  ].some(Boolean);
};

export const normalizeEventTransmissionInput = (value: unknown): EventTransmissionAnalysis | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new EventTransmissionValidationError('产业传导观察卡格式不正确');
  }

  const input = value as Record<string, unknown>;
  const status = normalizeText(input.status, '验证状态', 40) || 'observation';
  if (!STATUS_SET.has(status)) {
    throw new EventTransmissionValidationError('产业传导验证状态不受支持');
  }

  const reviewDate = normalizeText(input.reviewDate, '复核日期', 10);
  if (reviewDate && !isValidDateOnly(reviewDate)) {
    throw new EventTransmissionValidationError('复核日期必须使用YYYY-MM-DD格式');
  }

  const rawTargets = input.targets ?? [];
  if (!Array.isArray(rawTargets)) {
    throw new EventTransmissionValidationError('映射商品必须是列表');
  }
  if (rawTargets.length > MAX_TARGETS) {
    throw new EventTransmissionValidationError(`单条事件最多映射${MAX_TARGETS}个商品`);
  }

  const rawEvidenceReferences = input.evidenceReferences ?? [];
  if (!Array.isArray(rawEvidenceReferences)) {
    throw new EventTransmissionValidationError('关联证据必须是列表');
  }
  if (rawEvidenceReferences.length > MAX_EVIDENCE_REFERENCES) {
    throw new EventTransmissionValidationError(`单条事件最多关联${MAX_EVIDENCE_REFERENCES}条证据`);
  }

  const deduplicatedTargets = Array.from(
    new Map(
      rawTargets
        .map(normalizeTarget)
        .map(target => [`${target.categoryId}:${target.objectId}:${target.variantId}`, target] as const)
    ).values()
  );
  const deduplicatedEvidenceReferences = Array.from(
    new Map(
      rawEvidenceReferences
        .map(normalizeEvidenceReference)
        .map(reference => [
          `${reference.sourceType}:${reference.sourceId}:${reference.path}`,
          reference
        ] as const)
    ).values()
  );

  const analysis: EventTransmissionAnalysis = {
    status: status as EventTransmissionStatus,
    directImpact: normalizeText(input.directImpact, '一阶影响'),
    secondOrderImpact: normalizeText(input.secondOrderImpact, '二阶影响'),
    thirdOrderImpact: normalizeText(input.thirdOrderImpact, '三阶影响'),
    changedLink: normalizeText(input.changedLink, '已变化环节'),
    pendingRepricingLink: normalizeText(input.pendingRepricingLink, '尚未重估环节'),
    expectedLag: normalizeText(input.expectedLag, '预计传导时滞', 500),
    validationIndicators: normalizeText(input.validationIndicators, '验证指标'),
    counterEvidence: normalizeText(input.counterEvidence, '反证条件'),
    reviewDate,
    validationNote: normalizeText(input.validationNote, '验证记录'),
    targets: deduplicatedTargets,
    evidenceReferences: deduplicatedEvidenceReferences
  };

  return hasMeaningfulContent(analysis) ? analysis : null;
};

export const parseStoredEventTransmission = (value: unknown): EventTransmissionAnalysis | null => {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return normalizeEventTransmissionInput(parsed);
  } catch {
    return null;
  }
};
