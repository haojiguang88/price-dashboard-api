function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function buildFinancePlanQuality(plan: any) {
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
  const rewardPercent = ['BREAKOUT', 'SLOW_GRIND_UP', 'TREND_UP'].includes(trendPhase)
    ? 0.16
    : ['RECOVERY', 'TREND_TRANSITION'].includes(trendPhase)
      ? 0.1
      : 0.07;
  const riskReward = riskPercent && riskPercent > 0 ? rewardPercent / riskPercent : null;

  const factors = [
    {
      key: 'structure',
      label: '结构质量',
      score: Math.min(25, Math.max(0, structureScore / 4)),
      message: structureScore >= 80 ? '结构分高，具备优先观察价值。' : structureScore >= 65 ? '结构合格，但不是顶级样本。' : '结构分偏低，先降低计划级别。'
    },
    {
      key: 'trigger',
      label: '触发质量',
      score: Math.min(20, Math.max(0, triggerScore / 5)),
      message: triggerScore >= 80 ? '触发条件较清晰。' : triggerScore >= 60 ? '触发条件一般，需要二次确认。' : '触发偏弱，不适合直接放大金额。'
    },
    {
      key: 'risk',
      label: '失效线距离',
      score: riskPercent === null ? 6 : riskPercent <= 0.04 ? 20 : riskPercent <= 0.07 ? 14 : riskPercent <= 0.1 ? 8 : 3,
      message: riskPercent === null ? '风险距离缺失，计划质量降级。' : riskPercent <= 0.04 ? '失效线近，风险可控。' : riskPercent <= 0.07 ? '风险距离可接受。' : '失效线偏远，计划不够划算。'
    },
    {
      key: 'risk_reward',
      label: '盈亏比',
      score: riskReward === null ? 5 : riskReward >= 3 ? 20 : riskReward >= 2 ? 15 : riskReward >= 1.4 ? 9 : 3,
      message: riskReward === null ? '缺少盈亏比基础数据。' : riskReward >= 2 ? '盈亏比具备交易意义。' : '盈亏比一般，符合条件也未必值得做。'
    },
    {
      key: 'clarity',
      label: '计划清晰度',
      score: plan.invalidation_line && plan.suggested_entry_zone && plan.trigger_type ? 15 : 8,
      message: plan.invalidation_line && plan.suggested_entry_zone && plan.trigger_type ? '入场区、触发和失效线清楚。' : '计划要素不完整，执行时容易变形。'
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
    score,
    label,
    action,
    risk_percent: riskPercent,
    reward_percent: rewardPercent,
    risk_reward: riskReward !== null ? Math.round(riskReward * 100) / 100 : null,
    factors: factors.map(item => ({ ...item, score: Math.round(item.score) }))
  };
}
