export const HUMAN_CASE_SOURCE_TYPES = [
  "business_review",
  "missed_project",
  "tree_case",
  "market_review",
  "opinion_record"
] as const;

export type HumanCaseSourceType = typeof HUMAN_CASE_SOURCE_TYPES[number];
export type HumanCaseSourceReadiness = "ready" | "observation";

export interface HumanCaseSourcePrefill {
  title: string;
  originType: "self" | "other" | "public" | "unconfirmed";
  subjectAlias: string;
  sourceNote: string;
  evidenceLevel: "first_hand" | "documented" | "second_hand" | "unconfirmed";
  caseDate: string;
  track: string;
  projectName: string;
  background: string;
  visibleInformation: string;
  pressureContext: string;
  actionTaken: string;
  result: string;
  actionQuality: "unknown";
  outcomeType: "unknown";
  evidenceRole: "neutral";
  selfResponse: string;
  learnToKeep: string;
  learnToAvoid: string;
  applicabilityBoundary: string;
  linkedRuleRefs: string[];
  sourceType: HumanCaseSourceType;
  sourceId: string;
  note: string;
  patternLinks: [];
}

export interface HumanCaseSourceRecord {
  sourceType: HumanCaseSourceType;
  sourceId: string;
  sourceModule: string;
  title: string;
  sourceDate: string;
  track: string;
  projectName: string;
  summary: string;
  validationStatus: string;
  readiness: HumanCaseSourceReadiness;
  readinessReason: string;
  sourcePath: string;
  linkedCaseId: string;
  linkedCaseTitle: string;
  prefill: HumanCaseSourcePrefill;
}

const clean = (value: unknown) => String(value ?? "").trim();

const joinSections = (sections: Array<[string, unknown]>) => sections
  .map(([label, value]) => {
    const text = clean(value);
    return text ? `${label}：${text}` : "";
  })
  .filter(Boolean)
  .join("\n");

const createPrefill = (
  sourceType: HumanCaseSourceType,
  sourceId: unknown,
  values: Partial<HumanCaseSourcePrefill>
): HumanCaseSourcePrefill => ({
  title: clean(values.title),
  originType: values.originType || "unconfirmed",
  subjectAlias: clean(values.subjectAlias),
  sourceNote: clean(values.sourceNote),
  evidenceLevel: values.evidenceLevel || "unconfirmed",
  caseDate: clean(values.caseDate),
  track: clean(values.track),
  projectName: clean(values.projectName),
  background: clean(values.background),
  visibleInformation: clean(values.visibleInformation),
  pressureContext: clean(values.pressureContext),
  actionTaken: clean(values.actionTaken),
  result: clean(values.result),
  actionQuality: "unknown",
  outcomeType: "unknown",
  evidenceRole: "neutral",
  selfResponse: clean(values.selfResponse),
  learnToKeep: clean(values.learnToKeep),
  learnToAvoid: clean(values.learnToAvoid),
  applicabilityBoundary: clean(values.applicabilityBoundary),
  linkedRuleRefs: [],
  sourceType,
  sourceId: clean(sourceId),
  note: clean(values.note),
  patternLinks: []
});

const sourcePath = (sourceType: HumanCaseSourceType, sourceId: string) => {
  const paths: Record<HumanCaseSourceType, string> = {
    business_review: "/review/business",
    missed_project: "/review/missed",
    tree_case: "/review/case",
    market_review: "/review/market",
    opinion_record: `/opinion/detail/${encodeURIComponent(sourceId)}`
  };
  if (sourceType === "opinion_record") return paths[sourceType];
  return `${paths[sourceType]}?recordId=${encodeURIComponent(sourceId)}`;
};

const buildRecord = (
  sourceType: HumanCaseSourceType,
  sourceModule: string,
  row: any,
  prefill: HumanCaseSourcePrefill,
  options: {
    summary?: unknown;
    validationStatus?: unknown;
    readiness?: HumanCaseSourceReadiness;
    readinessReason?: string;
  } = {}
): HumanCaseSourceRecord => {
  const sourceId = clean(row.id);
  return {
    sourceType,
    sourceId,
    sourceModule,
    title: clean(row.title),
    sourceDate: clean(prefill.caseDate),
    track: clean(prefill.track),
    projectName: clean(prefill.projectName),
    summary: clean(options.summary),
    validationStatus: clean(options.validationStatus),
    readiness: options.readiness || "ready",
    readinessReason: options.readinessReason || "原始复盘已具备结果，可进入人工提炼。",
    sourcePath: sourcePath(sourceType, sourceId),
    linkedCaseId: "",
    linkedCaseTitle: "",
    prefill
  };
};

const mapBusinessReview = (row: any) => buildRecord(
  "business_review",
  "买卖复盘",
  row,
  createPrefill("business_review", row.id, {
    title: row.title,
    originType: "self",
    evidenceLevel: "first_hand",
    caseDate: row.review_date,
    track: row.track,
    projectName: row.project_name,
    sourceNote: joinSections([
      ["来源", "买卖复盘"],
      ["一句话结论", row.summary_conclusion],
      ["一句话经验", row.short_lesson]
    ]),
    background: row.background,
    visibleInformation: row.judgment_at_that_time,
    pressureContext: joinSections([
      ["根因类型", row.root_cause_type],
      ["暴露问题", row.exposed_problem]
    ]),
    actionTaken: row.action_at_that_time,
    result: row.later_outcome,
    selfResponse: row.extracted_lesson || row.short_lesson,
    learnToAvoid: row.exposed_problem,
    note: row.note
  }),
  { summary: row.summary_conclusion || row.short_lesson || row.extracted_lesson }
);

const mapMissedProject = (row: any) => buildRecord(
  "missed_project",
  "错过复盘",
  row,
  createPrefill("missed_project", row.id, {
    title: row.title,
    originType: "self",
    evidenceLevel: "first_hand",
    caseDate: row.review_date,
    track: row.track,
    projectName: row.project_name,
    sourceNote: joinSections([
      ["来源", "错过复盘"],
      ["原信息来源", row.source],
      ["错过类型", row.miss_type]
    ]),
    background: joinSections([
      ["当时信号", row.signal],
      ["错过原因", row.reason]
    ]),
    visibleInformation: row.signal,
    pressureContext: row.reason,
    actionTaken: row.miss_type ? `当时未能完成参与：${clean(row.miss_type)}` : "当时没有参与或没有拿住。",
    result: row.trend,
    selfResponse: row.extracted_lesson || row.short_lesson,
    learnToAvoid: row.exposed_problem,
    note: row.note
  }),
  { summary: row.summary_conclusion || row.short_lesson || row.extracted_lesson }
);

const mapTreeCase = (row: any) => buildRecord(
  "tree_case",
  "挂树复盘",
  row,
  createPrefill("tree_case", row.id, {
    title: row.title,
    originType: "unconfirmed",
    evidenceLevel: "documented",
    caseDate: row.review_date,
    track: row.track,
    projectName: row.project_name,
    sourceNote: joinSections([
      ["来源", "挂树复盘"],
      ["挂树类型", row.tree_type],
      ["根因类型", row.root_cause_type]
    ]),
    background: row.background,
    visibleInformation: row.judgment_at_that_time,
    pressureContext: row.exposed_problem,
    actionTaken: row.action_at_that_time,
    result: row.later_outcome,
    selfResponse: row.extracted_lesson || row.short_lesson,
    learnToAvoid: row.exposed_problem,
    note: row.note
  }),
  { summary: row.summary_conclusion || row.short_lesson || row.extracted_lesson }
);

const mapMarketReview = (row: any) => buildRecord(
  "market_review",
  "行情复盘",
  row,
  createPrefill("market_review", row.id, {
    title: row.title,
    originType: "public",
    evidenceLevel: "documented",
    caseDate: row.review_date,
    track: row.track,
    projectName: row.project_name,
    sourceNote: joinSections([
      ["来源", "行情复盘"],
      ["行情类型", row.market_type_custom || row.market_type_preset],
      ["一句话结论", row.summary_conclusion]
    ]),
    background: row.background,
    visibleInformation: joinSections([
      ["行情起点", row.market_start],
      ["行情演变", row.market_evolution],
      ["关键转折", row.key_turning_points]
    ]),
    pressureContext: row.exposed_problem,
    actionTaken: "",
    result: row.later_outcome,
    selfResponse: row.extracted_lesson || row.short_lesson,
    learnToAvoid: row.exposed_problem,
    note: row.note
  }),
  { summary: row.summary_conclusion || row.short_lesson || row.extracted_lesson }
);

const opinionReadiness = (status: string): HumanCaseSourceReadiness => (
  ["validated", "falsified", "partial"].includes(status) ? "ready" : "observation"
);

const mapOpinion = (row: any) => {
  const status = clean(row.validation_status) || "pending";
  const readiness = opinionReadiness(status);
  return buildRecord(
    "opinion_record",
    "观点记录",
    row,
    createPrefill("opinion_record", row.id, {
      title: row.title,
      originType: "other",
      subjectAlias: row.person_name,
      evidenceLevel: readiness === "ready" ? "documented" : "unconfirmed",
      caseDate: row.opinion_date,
      track: row.track,
      projectName: "",
      sourceNote: joinSections([
        ["来源", `${clean(row.person_name) || "未知人物"} · ${clean(row.source_platform) || "未知平台"}`],
        ["验证状态", status],
        ["摘要", row.summary_result]
      ]),
      background: row.original_opinion,
      visibleInformation: row.judgment_basis,
      pressureContext: row.person_observation,
      actionTaken: "",
      result: joinSections([
        ["验证结果", row.validation_result],
        ["验证备注", row.validation_note]
      ]),
      selfResponse: row.my_interpretation,
      note: row.note
    }),
    {
      summary: row.summary_result || row.validation_result || row.original_opinion,
      validationStatus: status,
      readiness,
      readinessReason: readiness === "ready"
        ? "观点已有验证结果，可作为案例来源继续人工提炼。"
        : "未经验证或无法验证的观点保留在观察层，不直接沉淀为案例。"
    }
  );
};

export const loadHumanCaseSources = async (db: any): Promise<HumanCaseSourceRecord[]> => {
  const [businessRows, missedRows, treeRows, marketRows, opinionRows, linkedRows] = await Promise.all([
    db.all(`SELECT id, title, track, project_name, review_date, result_type,
                   summary_conclusion, background, judgment_at_that_time,
                   action_at_that_time, later_outcome, root_cause_type,
                   exposed_problem, extracted_lesson, short_lesson, note
            FROM business_reviews WHERE is_deleted = 0`),
    db.all(`SELECT id, title, track, project_name, source, review_date, miss_type,
                   signal, reason, trend, exposed_problem, extracted_lesson,
                   summary_conclusion, short_lesson, note
            FROM missed_projects WHERE is_deleted = 0`),
    db.all(`SELECT id, title, track, project_name, review_date, tree_type,
                   summary_conclusion, background, judgment_at_that_time,
                   action_at_that_time, later_outcome, root_cause_type,
                   exposed_problem, extracted_lesson, short_lesson, note
            FROM tree_hanging_cases WHERE is_deleted = 0`),
    db.all(`SELECT id, title, track, project_name, review_date, market_type_preset,
                   market_type_custom, summary_conclusion, short_lesson, background,
                   market_start, market_evolution, key_turning_points, later_outcome,
                   exposed_problem, extracted_lesson, note
            FROM market_reviews WHERE is_deleted = 0`),
    db.all(`SELECT id, title, track, person_name, source_platform, opinion_date,
                   validation_status, summary_result, original_opinion, judgment_basis,
                   my_interpretation, validation_result, validation_note,
                   person_observation, note
            FROM opinion_records WHERE is_deleted = 0`),
    db.all(`SELECT id, title, source_type, source_id
            FROM behavior_cases
            WHERE is_deleted = 0 AND source_type <> '' AND source_id <> ''`)
  ]);

  const linkedBySource = new Map<string, { id: string; title: string }>();
  linkedRows.forEach((row: any) => {
    linkedBySource.set(`${clean(row.source_type)}:${clean(row.source_id)}`, {
      id: clean(row.id),
      title: clean(row.title)
    });
  });

  const records = [
    ...businessRows.map(mapBusinessReview),
    ...missedRows.map(mapMissedProject),
    ...treeRows.map(mapTreeCase),
    ...marketRows.map(mapMarketReview),
    ...opinionRows.map(mapOpinion)
  ];

  return records.map(record => {
    const linked = linkedBySource.get(`${record.sourceType}:${record.sourceId}`);
    return linked
      ? { ...record, linkedCaseId: linked.id, linkedCaseTitle: linked.title }
      : record;
  });
};

export const loadHumanCaseSource = async (
  db: any,
  sourceType: string,
  sourceId: string
) => {
  if (!HUMAN_CASE_SOURCE_TYPES.includes(sourceType as HumanCaseSourceType)) return null;
  const sources = await loadHumanCaseSources(db);
  return sources.find(source => source.sourceType === sourceType && source.sourceId === sourceId) || null;
};

export const createHumanCaseSourceSnapshot = (source: HumanCaseSourceRecord) => ({
  sourceType: source.sourceType,
  sourceId: source.sourceId,
  sourceModule: source.sourceModule,
  sourceTitle: source.title,
  sourceDate: source.sourceDate,
  sourcePath: source.sourcePath,
  track: source.track,
  projectName: source.projectName,
  summary: source.summary,
  validationStatus: source.validationStatus,
  readiness: source.readiness,
  readinessReason: source.readinessReason,
  prefill: { ...source.prefill },
  capturedAt: new Date().toISOString()
});
