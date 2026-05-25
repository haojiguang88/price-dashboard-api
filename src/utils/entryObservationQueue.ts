export interface EntryObservationQueueInfo {
  observation_queue_bucket: string;
  observation_queue_label: string;
  observation_queue_reason: string;
  observation_queue_recommendation: string;
  raw_entry_action: string | null;
  lifecycle_status: string | null;
  lifecycle_label: string | null;
  lifecycle_check_count: number | null;
  lifecycle_consecutive_valid_days: number | null;
  lifecycle_valid_check_count: number | null;
  lifecycle_flip_count: number | null;
  high_trigger_risk_review: number;
  should_auto_advance_to_plan_ready: number;
}

const nullableNumber = (value: any): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

export function buildEntryObservationQueueInfo(item: any, snapshot: any = null, lifecycle: any = null): EntryObservationQueueInfo {
  const status = String(item.observation_status || '');
  const rawAction = String(snapshot?.action || item.entry_action || '');
  const maturityStatus = String(lifecycle?.maturity_status ?? item.lifecycle_status ?? '');
  const maturityLabel = (lifecycle?.maturity_label ?? item.lifecycle_label ?? maturityStatus) || null;
  const consecutiveValidDays = Number(lifecycle?.consecutive_valid_days ?? item.lifecycle_consecutive_valid_days ?? 0);
  const triggerScore = Number(item.trigger_score || snapshot?.trigger_score || 0);
  const structureScore = Number(item.structure_score || snapshot?.structure_score?.score || snapshot?.structure_score || 0);
  const manualReviewAction = String(item.manual_review_action || '');
  const manualReviewLabel = item.manual_review_label || '';
  const manualReviewNote = item.manual_review_note || '';
  const close = Number(item.close_price ?? snapshot?.close ?? snapshot?.close_price);
  const invalidationLine = Number(item.invalidation_line ?? snapshot?.invalidation_line);
  const maxLossPercent = Number.isFinite(close) && close > 0 && Number.isFinite(invalidationLine) && invalidationLine > 0
    ? Math.max(0, (close - invalidationLine) / close)
    : null;
  const rawReadyToPlan = rawAction === 'READY_TO_PLAN';
  const highTriggerRiskReview = rawReadyToPlan
    && triggerScore >= 80
    && structureScore >= 75
    && (maxLossPercent === null || maxLossPercent <= 0.06);
  const needsHighTriggerRiskReview = highTriggerRiskReview && !['continue_observe', 'return_risk_hold'].includes(manualReviewAction);

  let bucket = 'waiting_trigger';
  let label = '继续观察触发';
  let recommendation = 'continue_observe';
  let reason = item.trigger_reason || '等待触发条件继续确认。';

  if (['confirmed', 'plan_candidate'].includes(status)) {
    bucket = 'plan_ready';
    label = '计划准备池';
    recommendation = 'manual_create_trade_plan';
    reason = '入场触发已确认，可进入计划准备；生成正式计划和金额仍需人工确认。';
  } else if (status === 'watching' && rawReadyToPlan) {
    if (['mature_plan', 'stable_plan'].includes(maturityStatus)) {
      bucket = 'ready_to_plan';
      label = '应进计划准备';
      recommendation = 'auto_advance_to_plan_ready';
      reason = `${maturityLabel || '生命周期已成熟'}，且触发分 ${triggerScore} / 结构分 ${structureScore}，应由自动流程推进到计划准备池。`;
    } else if (['face_slap_zone', 'short_lived_signal', 'invalidation_watch', 'invalidated'].includes(maturityStatus)) {
      if (maturityStatus === 'face_slap_zone' && highTriggerRiskReview) {
        if (manualReviewAction === 'return_risk_hold') {
          bucket = 'risk_hold';
          label = manualReviewLabel || '人工退回风险观察';
          recommendation = 'continue_risk_observe';
          reason = `人工复核已退回风险观察：${manualReviewNote || '生命周期仍有真实翻转，先不占高触发优先位。'}`;
        } else if (manualReviewAction === 'continue_observe') {
          bucket = 'lifecycle_recheck';
          label = manualReviewLabel || '人工继续观察';
          recommendation = 'continue_lifecycle_recheck';
          reason = `人工复核选择继续观察：${manualReviewNote || '保留观察记录，等待后续自动流水线重新确认。'}`;
        } else {
          bucket = 'risk_priority_recheck';
          label = manualReviewAction === 'wait_next_day' ? (manualReviewLabel || '等下一日确认') : '高触发复核';
          recommendation = manualReviewAction === 'wait_next_day' ? 'wait_next_day_recheck' : 'manual_risk_recheck';
          reason = manualReviewAction === 'wait_next_day'
            ? `人工复核选择等下一日确认：${manualReviewNote || '今天不进计划，下一交易日继续优先复核。'}`
            : `${maturityLabel || '扇脸区'}，但触发分 ${triggerScore} / 结构分 ${structureScore} 较高，失效线距离${maxLossPercent !== null ? ` ${(maxLossPercent * 100).toFixed(1)}%` : '可控'}；不自动进计划，建议优先人工复核是否继续观察或等待下一日确认。`;
        }
      } else {
        bucket = 'risk_hold';
        label = maturityStatus === 'face_slap_zone' ? '扇脸风险观察' : '风险观察';
        recommendation = 'continue_risk_observe';
        reason = `${maturityLabel || '生命周期风险'}，虽然触发条件满足，但历史复核不稳定，先不推进计划准备。`;
      }
    } else if (maturityStatus === 'rechecking') {
      bucket = 'lifecycle_recheck';
      label = '已触发待复核';
      recommendation = 'continue_lifecycle_recheck';
      reason = `触发条件已满足，但生命周期只有连续 ${consecutiveValidDays} 天有效；需要至少 3 天稳定后再进计划准备。`;
    } else {
      bucket = 'lifecycle_recheck';
      label = '新触发待复核';
      recommendation = 'continue_lifecycle_recheck';
      reason = '触发条件刚满足，先观察生命周期是否连续有效，避免当天假触发直接进计划。';
    }
  } else if (status === 'watching' && rawAction === 'WAIT_PULLBACK') {
    bucket = 'wait_pullback';
    label = '等待回踩';
    recommendation = 'continue_wait_pullback';
    reason = item.trigger_reason || '位置不在安全触发区，继续等待回踩确认。';
  } else if (status === 'watching') {
    bucket = 'waiting_trigger';
    label = '触发未完成';
    recommendation = 'continue_wait_trigger';
    reason = item.trigger_reason || '结构仍可观察，但入场触发条件还不完整。';
  } else if (['invalidated', 'returned', 'planned'].includes(status)) {
    bucket = 'resolved';
    label = status === 'invalidated' ? '已失效' : status === 'planned' ? '已建计划' : '已退回';
    recommendation = 'resolved';
    reason = item.note || item.trigger_reason || '该记录已归档。';
  }

  return {
    observation_queue_bucket: bucket,
    observation_queue_label: label,
    observation_queue_reason: reason,
    observation_queue_recommendation: recommendation,
    raw_entry_action: rawAction || null,
    lifecycle_status: maturityStatus || null,
    lifecycle_label: maturityLabel,
    lifecycle_check_count: nullableNumber(lifecycle?.check_count ?? item.lifecycle_check_count),
    lifecycle_consecutive_valid_days: nullableNumber(lifecycle?.consecutive_valid_days ?? item.lifecycle_consecutive_valid_days),
    lifecycle_valid_check_count: nullableNumber(lifecycle?.valid_check_count ?? item.lifecycle_valid_check_count),
    lifecycle_flip_count: nullableNumber(lifecycle?.flip_count ?? item.lifecycle_flip_count),
    high_trigger_risk_review: needsHighTriggerRiskReview ? 1 : 0,
    should_auto_advance_to_plan_ready: recommendation === 'auto_advance_to_plan_ready' ? 1 : 0
  };
}

export function buildObservationQueueSummary(items: Array<{ observation_queue_bucket?: string; should_auto_advance_to_plan_ready?: number }>) {
  const summary: Record<string, number> = {
    plan_ready: 0,
    ready_to_plan: 0,
    risk_priority_recheck: 0,
    lifecycle_recheck: 0,
    risk_hold: 0,
    wait_pullback: 0,
    waiting_trigger: 0,
    resolved: 0,
    should_auto_advance: 0
  };
  items.forEach((item) => {
    const bucket = item.observation_queue_bucket || 'waiting_trigger';
    summary[bucket] = Number(summary[bucket] || 0) + 1;
    if (item.should_auto_advance_to_plan_ready) {
      summary.should_auto_advance += 1;
    }
  });
  return summary;
}

export function getObservationQueueSortRank(item: any) {
  switch (item.observation_queue_bucket) {
    case 'ready_to_plan':
    case 'plan_ready':
      return 0;
    case 'risk_priority_recheck':
      return 1;
    case 'lifecycle_recheck':
      return 2;
    case 'risk_hold':
      return 3;
    case 'wait_pullback':
      return 4;
    case 'waiting_trigger':
      return 5;
    default:
      return 9;
  }
}

export function compareObservationQueueItems(a: any, b: any) {
  const bucketDiff = getObservationQueueSortRank(a) - getObservationQueueSortRank(b);
  if (bucketDiff !== 0) return bucketDiff;
  const triggerDiff = Number(b.trigger_score || 0) - Number(a.trigger_score || 0);
  if (triggerDiff !== 0) return triggerDiff;
  const structureDiff = Number(b.structure_score || 0) - Number(a.structure_score || 0);
  if (structureDiff !== 0) return structureDiff;
  const aLoss = typeof a.max_loss_percent === 'number' ? a.max_loss_percent : 9;
  const bLoss = typeof b.max_loss_percent === 'number' ? b.max_loss_percent : 9;
  if (aLoss !== bLoss) return aLoss - bLoss;
  const flipDiff = Number(b.lifecycle_flip_count || 0) - Number(a.lifecycle_flip_count || 0);
  if (flipDiff !== 0) return flipDiff;
  return new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime();
}

export function getEntryObservationQueueActionCode(queueInfo: Pick<EntryObservationQueueInfo, 'observation_queue_bucket'>, isPlanReady = false) {
  if (isPlanReady) return 'READY_TO_PLAN';
  switch (queueInfo.observation_queue_bucket) {
    case 'ready_to_plan': return 'READY_TO_PLAN_AUTO';
    case 'risk_priority_recheck': return 'RISK_PRIORITY_RECHECK';
    case 'lifecycle_recheck': return 'LIFECYCLE_RECHECK';
    case 'risk_hold': return 'RISK_HOLD';
    case 'wait_pullback': return 'WAIT_PULLBACK';
    default: return 'WATCH_ENTRY';
  }
}
