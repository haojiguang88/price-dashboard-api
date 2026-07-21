export interface ProfileDetailEntry {
  id: string;
  title: string;
  summary: string;
  details: string[];
}

export interface ProfileRatedEntry {
  id: string;
  title: string;
  rating: number;
  summary: string;
}

export interface ProfileControlledRiskEntry {
  id: string;
  title: string;
  status: string;
  summary: string;
}

export interface ProfileProgressEntry {
  id: string;
  from: string;
  to: string;
}

export interface SelfCognitionProfileContent {
  stableTraits: ProfileDetailEntry[];
  strengths: ProfileDetailEntry[];
  currentRisks: ProfileRatedEntry[];
  controlledRisks: ProfileControlledRiskEntry[];
  progress: ProfileProgressEntry[];
  values: string;
  direction: string;
  correctionFocus: ProfileRatedEntry[];
  operatingFocus: string[];
  closingNote: string;
  metaPrinciple: string;
}

export interface SelfCognitionProfileInput {
  versionLabel: string;
  profileDate: string;
  changeNote: string;
  phaseTitle: string;
  phaseSummary: string;
  content: SelfCognitionProfileContent;
}

const MAX_LIST_SIZE = 30;

const normalizeText = (value: unknown, field: string, maxLength: number, required = false) => {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw new Error(`${field}不能为空`);
  if (normalized.length > maxLength) throw new Error(`${field}不能超过 ${maxLength} 个字符`);
  return normalized;
};

const normalizeId = (value: unknown, fallback: string) => {
  const normalized = String(value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  return normalized || fallback;
};

const normalizeList = <T>(value: unknown, field: string, mapper: (item: any, index: number) => T) => {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_LIST_SIZE) throw new Error(`${field}最多保留 ${MAX_LIST_SIZE} 项`);
  return value.map(mapper);
};

const normalizeDetails = (value: unknown, field: string) => normalizeList(
  value,
  field,
  (item, index) => normalizeText(item, `${field}第 ${index + 1} 条`, 300, true)
);

const normalizeDetailEntries = (value: unknown, field: string): ProfileDetailEntry[] => normalizeList(
  value,
  field,
  (item, index) => ({
    id: normalizeId(item?.id, `${field}-${index + 1}`),
    title: normalizeText(item?.title, `${field}名称`, 80, true),
    summary: normalizeText(item?.summary, `${field}说明`, 1200),
    details: normalizeDetails(item?.details, `${field}细项`)
  })
);

const normalizeRating = (value: unknown, field: string) => {
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
    throw new Error(`${field}必须是 0 到 5 颗星`);
  }
  return rating;
};

const normalizeRatedEntries = (value: unknown, field: string): ProfileRatedEntry[] => normalizeList(
  value,
  field,
  (item, index) => ({
    id: normalizeId(item?.id, `${field}-${index + 1}`),
    title: normalizeText(item?.title, `${field}名称`, 80, true),
    rating: normalizeRating(item?.rating, `${field}评分`),
    summary: normalizeText(item?.summary, `${field}说明`, 1200)
  })
);

const normalizeDate = (value: unknown) => {
  const normalized = normalizeText(value, "画像日期", 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error("画像日期格式应为 YYYY-MM-DD");
  const [year, month, day] = normalized.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error("画像日期不是有效日期");
  }
  return normalized;
};

export const normalizeSelfCognitionProfileInput = (value: unknown): SelfCognitionProfileInput => {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, any>;
  const content = (input.content && typeof input.content === "object" ? input.content : {}) as Record<string, any>;

  return {
    versionLabel: normalizeText(input.versionLabel, "版本名称", 40, true),
    profileDate: normalizeDate(input.profileDate),
    changeNote: normalizeText(input.changeNote, "本次校准说明", 500, true),
    phaseTitle: normalizeText(input.phaseTitle, "当前阶段", 80, true),
    phaseSummary: normalizeText(input.phaseSummary, "阶段主线", 1200, true),
    content: {
      stableTraits: normalizeDetailEntries(content.stableTraits, "底层性格"),
      strengths: normalizeDetailEntries(content.strengths, "能力优势"),
      currentRisks: normalizeRatedEntries(content.currentRisks, "当前风险"),
      controlledRisks: normalizeList(content.controlledRisks, "已受控风险", (item, index) => ({
        id: normalizeId(item?.id, `controlled-risk-${index + 1}`),
        title: normalizeText(item?.title, "已受控风险名称", 80, true),
        status: normalizeText(item?.status, "已受控风险状态", 80, true),
        summary: normalizeText(item?.summary, "已受控风险说明", 1200)
      })),
      progress: normalizeList(content.progress, "关键进步", (item, index) => ({
        id: normalizeId(item?.id, `progress-${index + 1}`),
        from: normalizeText(item?.from, "过去状态", 300, true),
        to: normalizeText(item?.to, "当前状态", 300, true)
      })),
      values: normalizeText(content.values, "价值观", 3000),
      direction: normalizeText(content.direction, "适合方向", 3000),
      correctionFocus: normalizeRatedEntries(content.correctionFocus, "修正重点"),
      operatingFocus: normalizeList(content.operatingFocus, "当前工作", (item, index) => (
        normalizeText(item, `当前工作第 ${index + 1} 项`, 300, true)
      )),
      closingNote: normalizeText(content.closingNote, "画像结语", 4000),
      metaPrinciple: normalizeText(content.metaPrinciple, "校准原则", 1200)
    }
  };
};

export const DEFAULT_SELF_COGNITION_PROFILE: SelfCognitionProfileInput = {
  versionLabel: "2026 v2.2",
  profileDate: "2026-07-19",
  changeNote: "降低过度分析、完美主义和接受不确定性的当前优先级，并同步校准对应的未来修正重点。",
  phaseTitle: "运营验证阶段",
  phaseSummary: "工作重点已经从把系统做出来，转为证明系统真的有用：持续喂数据、看结果、打标签、修 Bug、调规则并等待真实反馈。",
  content: {
    stableTraits: [
      {
        id: "sincere",
        title: "真诚型",
        summary: "不喜欢套路，更偏好简单、真诚和长期。研究人性主要是保护自己，不是利用别人。",
        details: ["保持善意", "不放弃边界", "更看长期行为而不是一时表达"]
      },
      {
        id: "systematic",
        title: "系统型",
        summary: "遇到问题会寻找结构、规律和可复用的方法，最终沉淀成规则、流程、经验和数据库。",
        details: ["从案例提炼变量", "把经验做成可验证记录", "优先考虑以后如何避免同类问题"]
      },
      {
        id: "defensive",
        title: "防守型",
        summary: "底层顺序是先别死，再谈收益；因此持续重视现金流、风控、等待、退出和边界。",
        details: ["生存优先", "允许等待", "提前定义退出和不能做的条件"]
      }
    ],
    strengths: [
      { id: "execution", title: "执行能力", summary: "想清楚后能持续推进，不是三分钟热度。", details: [] },
      { id: "learning", title: "持续学习", summary: "优势不只是速度，而是长期不断拆解不会的问题；AI让许多旧门槛变得可以逐步攻克。", details: [] },
      { id: "structure", title: "结构提炼", summary: "别人看案例时，更容易看到规律、变量和共性，并迁移到新的场景。", details: [] },
      { id: "risk-control", title: "风控能力", summary: "这一年的关键成长不是更会预测，而是更清楚什么时候不能干、什么时候退出、什么时候等待。", details: [] },
      { id: "long-term", title: "长期主义", summary: "愿意慢一点，但持续积累，让经验最终形成资产。", details: [] }
    ],
    currentRisks: [
      { id: "over-analysis", title: "过度分析", rating: 3, summary: "容易把简单事实继续拆到很深。现实里应先看行动和证据，很多问题不需要解释十八层。" },
      { id: "cash-flow", title: "需要重视现金流", rating: 5, summary: "不能只看利润空间和账面收益，还要持续看资金占用、回款速度和可动用现金；任何机会都不能挤压生存边界。" },
      { id: "perfectionism", title: "完美主义", rating: 2, summary: "当前主要体现在验证标准：容易觉得样本还不够、系统还不成熟，需要更主动接受边跑边修和 80 分可用。" },
      { id: "relationship-judgment", title: "感情判断", rating: 4, summary: "追求简单、纯粹和长期，但感情不能完全规则化；需要保持真诚，同时放慢判断。" },
      { id: "uncertainty", title: "接受不确定性", rating: 3, summary: "系统思维会希望问题都有答案，但关系、合作和朋友都包含无法消除的不确定性，需要观察、等待并接受没有百分百。" }
    ],
    controlledRisks: [
      { id: "new-projects", title: "容易开新坑", status: "已降级，由规则压住", summary: "新功能进入待办，不推进个人 OS，不新增大系统，主线保持跑系统和验证系统。" },
      { id: "energy", title: "容易高估精力", status: "已降级", summary: "注意力仍然稀缺，但执行层已经开始从还能干什么转向哪些不该干。" }
    ],
    progress: [
      { id: "feeling-to-proof", from: "凭感觉", to: "先验证" },
      { id: "prediction-to-wait", from: "急于预测", to: "允许等待" },
      { id: "words-to-actions", from: "听别人怎么说", to: "观察长期行为" },
      { id: "sunk-cost", from: "亏了舍不得", to: "开始按沉没成本和退出条件决策" },
      { id: "builder-to-operator", from: "建设者", to: "运营者" }
    ],
    values: "我理解世界可以很复杂，但希望自己的活法简单一点、纯粹一点、真诚一点、有边界一点。可以理解复杂，但不希望自己变成复杂。",
    direction: "更适合数据、系统、AI、决策、风控和长期积累，把经验持续沉淀成资产，而不是依赖情绪、关系和高频社交。",
    correctionFocus: [
      { id: "verify-more", title: "少分析一点，多验证一点", rating: 3, summary: "不要急着解释，先收集证据。" },
      { id: "unverified-opinion-observation", title: "未经验证记录的观点统一放观察层", rating: 5, summary: "记录不等于采信。外部观点在数据、时间、案例或事实验证前，只作为观察样本，不直接升级为认知规则或行动依据。" },
      { id: "finish-more", title: "少新增一点，多打穿一点", rating: 5, summary: "新功能先记录，不立刻开发。" },
      { id: "accept-80", title: "少追求完整，多接受 80 分", rating: 2, summary: "系统不是论文，能稳定运行比完美更重要。" },
      { id: "accept-uncertainty", title: "接受不确定性，允许观察和等待", rating: 3, summary: "不是所有问题都要立刻得到答案；保留观察期，在证据不足时不强行下结论。" },
      { id: "own-responsibility", title: "少承担别人一点，多负责自己一点", rating: 4, summary: "可以帮助成年人，但不能替别人生活和承担选择。" },
      { id: "sincere-boundary", title: "保持真诚，但提高判断标准", rating: 5, summary: "保持真诚，不轻易相信；保持善意，不放弃边界。" }
    ],
    operatingFocus: ["喂数据", "看结果", "打标签", "修 Bug", "调规则", "等待真实反馈"],
    closingNote: "成长不是把自己变成另一个人，而是让原来的自己越来越成熟。那个喜欢简单、纯粹、讲义气的人没有消失，只是多了风控、边界、验证和耐心。",
    metaPrinciple: "画像不是贴标签，而是反映当前真实状态；能力和风险都会变化，因此要用长期行为和新证据持续校准。"
  }
};
