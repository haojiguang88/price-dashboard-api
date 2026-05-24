import { getFinancePlanProfileConfig, getFinanceStructureProfileConfig } from './financePlanProfile';

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toNullableNumber(value: any): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function buildFinancePlanQuality(plan: any) {
  const profileKey = plan.plan_profile || plan.profile_key || (plan.asset_type === 'etf' ? 'etf_broad_equity' : 'stock_equity');
  const planProfile = getFinancePlanProfileConfig(profileKey);
  const structureProfile = getFinanceStructureProfileConfig(profileKey);
  const structureScore = toNumber(plan.structure_score);
  const triggerScore = toNumber(plan.trigger_score);
  const close = toNumber(plan.close_price ?? plan.close);
  const invalidationLine = toNumber(plan.invalidation_line);
  const riskPercent = Number.isFinite(Number(plan.max_loss_percent)) && plan.max_loss_percent !== null
    ? Number(plan.max_loss_percent)
    : close > 0 && invalidationLine > 0
      ? Math.max(0, (close - invalidationLine) / close)
      : null;
  const trendPhase = String(plan.trend_phase_code || 'UNKNOWN');
  const targetSpacePercent = toNullableNumber(plan.target_space_percent ?? plan.target_space);
  const pressureDistancePercent = toNullableNumber(plan.pressure_distance_percent ?? plan.distance_to_pressure);
  const industryStrengthScore = toNullableNumber(plan.industry_strength_score ?? plan.industry_score);
  const accountRiskStatus = String(plan.account_risk_status || plan.account_status || 'NORMAL');
  const trendRewardEstimate = ['BREAKOUT', 'SLOW_GRIND_UP', 'TREND_UP'].includes(trendPhase)
    ? structureProfile.targetExtensionPercent * 2
    : ['RECOVERY', 'TREND_TRANSITION'].includes(trendPhase)
      ? structureProfile.targetExtensionPercent * 1.4
      : structureProfile.targetExtensionPercent;
  const rewardIsEstimated = targetSpacePercent === null;
  const rewardPercent = rewardIsEstimated ? trendRewardEstimate : targetSpacePercent;
  const rewardSource = rewardIsEstimated ? 'profile_estimate' : 'explicit_target_space';
  const riskReward = riskPercent && riskPercent > 0 ? rewardPercent / riskPercent : null;
  const tightRisk = planProfile.tightRiskPercent;
  const maxRisk = planProfile.maxRiskPercent;
  const looseRisk = maxRisk * 1.25;
  const strongTarget = structureProfile.targetExtensionPercent * 2;
  const okTarget = structureProfile.targetExtensionPercent * 1.4;
  const minTarget = structureProfile.targetExtensionPercent;

  const factors = [
    {
      key: 'structure',
      label: '结构质量',
      score: Math.min(18, Math.max(0, structureScore / 5.6)),
      message: structureScore >= 80 ? '结构分高，具备优先观察价值。' : structureScore >= 65 ? '结构合格，但不是顶级样本。' : '结构分偏低，先降低计划级别。'
    },
    {
      key: 'trigger',
      label: '触发质量',
      score: Math.min(14, Math.max(0, triggerScore / 7.2)),
      message: triggerScore >= 80 ? '触发条件较清晰。' : triggerScore >= 60 ? '触发条件一般，需要二次确认。' : '触发偏弱，不适合直接放大金额。'
    },
    {
      key: 'risk',
      label: '失效线距离',
      score: riskPercent === null ? 5 : riskPercent <= tightRisk ? 18 : riskPercent <= maxRisk ? 13 : riskPercent <= looseRisk ? 7 : 2,
      message: riskPercent === null ? '风险距离缺失，计划质量降级。' : riskPercent <= tightRisk ? `符合${planProfile.label}的紧风险区。` : riskPercent <= maxRisk ? `符合${planProfile.label}的最大风险区。` : '失效线偏远，计划不够划算。'
    },
    {
      key: 'risk_reward',
      label: '盈亏比',
      score: riskReward === null ? 4 : riskReward >= 3 ? (rewardIsEstimated ? 10 : 14) : riskReward >= 2 ? (rewardIsEstimated ? 8 : 11) : riskReward >= 1.4 ? 7 : 2,
      message: riskReward === null
        ? '缺少盈亏比基础数据。'
        : rewardIsEstimated
          ? '盈亏比来自算法估算目标空间，只能做粗筛，不能当真实上方压力。'
          : riskReward >= 2 ? '盈亏比具备交易意义。' : '盈亏比一般，符合条件也未必值得做。'
    },
    {
      key: 'clarity',
      label: '计划清晰度',
      score: plan.invalidation_line && plan.suggested_entry_zone && plan.trigger_type ? 10 : 5,
      message: plan.invalidation_line && plan.suggested_entry_zone && plan.trigger_type ? '入场区、触发和失效线清楚。' : '计划要素不完整，执行时容易变形。'
    },
    {
      key: 'target_space',
      label: '目标空间',
      score: rewardIsEstimated
        ? Math.min(5, rewardPercent >= okTarget ? 5 : rewardPercent >= minTarget ? 4 : 2)
        : rewardPercent >= strongTarget ? 9 : rewardPercent >= okTarget ? 7 : rewardPercent >= minTarget ? 4 : 2,
      message: rewardIsEstimated ? `暂未接入明确目标位，按${structureProfile.label}估算目标空间，质量分不按真实目标满分计算。` : rewardPercent >= okTarget ? '目标空间相对充足。' : '目标空间偏窄，计划吸引力下降。'
    },
    {
      key: 'pressure',
      label: '压力位距离',
      score: pressureDistancePercent === null ? 4 : pressureDistancePercent >= okTarget ? 7 : pressureDistancePercent >= minTarget ? 5 : 2,
      message: pressureDistancePercent === null ? '暂未接入压力位，后续需从结构/前高补充。' : pressureDistancePercent >= minTarget ? '上方压力距离尚可。' : '离压力位过近，容易涨了也不好做。'
    },
    {
      key: 'industry_strength',
      label: '行业强度',
      score: industryStrengthScore === null ? 3 : industryStrengthScore >= 80 ? 5 : industryStrengthScore >= 60 ? 4 : 2,
      message: industryStrengthScore === null ? '非行业ETF或暂未接入行业强度，按中性处理。' : industryStrengthScore >= 60 ? '行业强度有支撑。' : '行业强度偏弱，降低计划级别。'
    },
    {
      key: 'account_risk',
      label: '账户风险状态',
      score: accountRiskStatus === 'COOLDOWN' ? 0 : accountRiskStatus === 'LIMITED' ? 2 : 5,
      message: accountRiskStatus === 'COOLDOWN' ? '账户冷却中，计划不能升级为实仓。' : accountRiskStatus === 'LIMITED' ? '账户受限，计划金额需要降级。' : '账户状态未触发限制。'
    }
  ];
  const score = Math.round(factors.reduce((sum, item) => sum + item.score, 0));
  const label = score >= 80 ? '高质量' : score >= 65 ? '合格' : score >= 50 ? '观察' : '不划算';
  const action = score >= 80
    ? '可作为重点计划，但仍按批次和失效线执行。'
    : score >= 65
      ? '可以保留计划，金额不要自动放大。'
      : score >= 50
        ? '先纸面跟踪或小金额验证。'
        : '不建议新增实仓，优先等更近失效线或更好结构。';

  return {
    version: 'v2',
    score,
    label,
    action,
    risk_percent: riskPercent,
    reward_percent: rewardPercent,
    target_space_percent: targetSpacePercent,
    pressure_distance_percent: pressureDistancePercent,
    reward_source: rewardSource,
    reward_is_estimated: rewardIsEstimated,
    target_space_confidence: rewardIsEstimated ? 'estimated' : 'explicit',
    industry_strength_score: industryStrengthScore,
    account_risk_status: accountRiskStatus,
    risk_reward: riskReward !== null ? Math.round(riskReward * 100) / 100 : null,
    factors: factors.map(item => ({ ...item, score: Math.round(item.score) }))
  };
}
