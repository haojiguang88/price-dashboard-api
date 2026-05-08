import getDb from '../config/database';

const TREND_PHASE_VERSION = 'trend_phase_v1.1';
const FUNNEL_READY_TREND_PHASES = new Set(['BREAKOUT', 'SLOW_GRIND_UP', 'RECOVERY']);
const FUNNEL_HOLD_TREND_PHASES = new Set(['TREND_UP', 'HIGH_BASE', 'SIDEWAYS', 'CONSOLIDATION', 'TREND_TRANSITION', 'UNKNOWN']);
const FUNNEL_REJECT_TREND_PHASES = new Set(['CRASH_DROP', 'SLOW_BLEED', 'SURGE', 'REBOUND']);

export interface FinancePipelineStep {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'success' | 'error';
  message?: string;
  data?: any;
  started_at?: string;
  finished_at?: string;
}

export interface FinancePipelineConfig {
  source?: string;
  active_plan_limit?: number;
  candidate_limit?: number;
  universe_limit?: number | 'all';
  interval_ms?: number;
  secondary_scan_limit?: number;
  market_symbols?: string[];
}

export interface FinanceCandidateFunnelConfig {
  source?: string;
  candidate_limit?: number;
  secondary_scan_limit?: number;
}

export const DEFAULT_FINANCE_PIPELINE_CONFIG: FinancePipelineConfig = {
  source: 'tushare',
  active_plan_limit: 50,
  candidate_limit: 20,
  universe_limit: 'all',
  interval_ms: 1200,
  secondary_scan_limit: 80,
  market_symbols: ['000300', '000905', '399006', '000688']
};

export const DEFAULT_FINANCE_CANDIDATE_FUNNEL_CONFIG: FinanceCandidateFunnelConfig = {
  source: 'tushare',
  candidate_limit: 120,
  secondary_scan_limit: 120
};

function getLocalBaseUrl() {
  const port = process.env.PORT || 3001;
  return `http://127.0.0.1:${port}`;
}

async function callLocalApi(path: string, body?: any, method: 'GET' | 'POST' = 'POST') {
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${getLocalBaseUrl()}${path}`, options);
  const data = await response.json() as any;
  if (!response.ok || data.success === false) {
    throw new Error(data.message || `接口执行失败: ${path}`);
  }
  return data;
}

function mergeConfig(config?: FinancePipelineConfig | null): Required<FinancePipelineConfig> {
  return {
    ...DEFAULT_FINANCE_PIPELINE_CONFIG,
    ...(config || {})
  } as Required<FinancePipelineConfig>;
}

function mergeFunnelConfig(config?: FinanceCandidateFunnelConfig | null): Required<FinanceCandidateFunnelConfig> {
  return {
    ...DEFAULT_FINANCE_CANDIDATE_FUNNEL_CONFIG,
    ...(config || {})
  } as Required<FinanceCandidateFunnelConfig>;
}

function getShortTrendReason(trendCode: string, trendReason?: string | null) {
  const reason = String(trendReason || '').trim();
  if (!reason) return trendCode || 'UNKNOWN';
  return reason.length > 80 ? `${reason.slice(0, 80)}...` : reason;
}

function getTrendPhaseDecision(trendCode?: string | null) {
  const code = trendCode || 'UNKNOWN';
  if (FUNNEL_READY_TREND_PHASES.has(code)) {
    return {
      action: 'advance',
      label: '进入下一步',
      reason: '走势阶段已进入可推进区'
    };
  }
  if (FUNNEL_REJECT_TREND_PHASES.has(code)) {
    return {
      action: 'reject',
      label: '踢出本轮',
      reason: '走势阶段触发硬拦截，不进入单标的判断'
    };
  }
  if (FUNNEL_HOLD_TREND_PHASES.has(code)) {
    return {
      action: 'hold',
      label: '留在走势队列',
      reason: '走势阶段尚未进入可推进区，等待后续确认'
    };
  }
  return {
    action: 'hold',
    label: '留在走势队列',
    reason: '走势阶段未识别，等待后续确认'
  };
}

function buildPipelineResult(steps: FinancePipelineStep[], config: any) {
  const failedStep = steps.find(step => step.status === 'error');
  return {
    summary: {
      total: steps.length,
      success: steps.filter(step => step.status === 'success').length,
      failed: failedStep ? 1 : 0,
      failed_step: failedStep?.key || null
    },
    steps,
    config,
    finished_at: new Date().toISOString()
  };
}

async function runPipelineStep(steps: FinancePipelineStep[], key: string, fn: () => Promise<any>) {
  const step = steps.find(item => item.key === key);
  if (!step) return true;
  step.status = 'running';
  step.started_at = new Date().toISOString();
  try {
    const result = await fn();
    step.status = 'success';
    step.message = result.message || '完成';
    step.data = result.data;
    step.finished_at = new Date().toISOString();
    return true;
  } catch (error) {
    step.status = 'error';
    step.message = (error as Error).message;
    step.finished_at = new Date().toISOString();
    return false;
  }
}

export async function runFinanceDailyPipeline(config?: FinancePipelineConfig | null) {
  const merged = mergeConfig(config);
  const steps: FinancePipelineStep[] = [
    { key: 'market_environment', label: '市场总闸更新', status: 'pending' },
    { key: 'daily_prices', label: '本地日线更新', status: 'pending' },
    { key: 'candidate_scan', label: '个股/ETF备选池扫描', status: 'pending' },
    { key: 'candidate_funnel', label: '入池漏斗刷新', status: 'pending' },
    { key: 'entry_trigger_scan', label: '入场触发扫描', status: 'pending' },
    { key: 'active_plan_suggestions', label: '持仓/计划建议同步', status: 'pending' },
    { key: 'workflow_summary', label: '指挥台快照', status: 'pending' }
  ];

  const buildResult = () => buildPipelineResult(steps, merged);
  const runStep = (key: string, fn: () => Promise<any>) => runPipelineStep(steps, key, fn);

  if (!await runStep('market_environment', () => callLocalApi('/api/finance/market/environment/update', {
    symbols: merged.market_symbols
  }))) return buildResult();

  if (!await runStep('daily_prices', () => callLocalApi('/api/finance/asset-universe/daily-close-update', {
    source: merged.source,
    active_plan_limit: merged.active_plan_limit,
    candidate_limit: merged.candidate_limit,
    universe_limit: merged.universe_limit,
    interval_ms: merged.interval_ms
  }))) return buildResult();

  if (!await runStep('candidate_scan', () => callLocalApi('/api/finance/candidate-pool/scan-universe', {
    universe_type: 'all',
    source: merged.source
  }))) return buildResult();

  if (!await runStep('candidate_funnel', async () => {
    const result = await runFinanceCandidateFunnelPipeline({
      source: merged.source,
      candidate_limit: Math.max(Number(merged.candidate_limit || 120), 120),
      secondary_scan_limit: merged.secondary_scan_limit
    });
    const failedStep = result.steps.find((step: any) => step.status === 'error');
    if (failedStep) {
      throw new Error(`入池漏斗停在「${failedStep.label}」：${failedStep.message || '原因未知'}`);
    }
    return {
      message: `入池漏斗刷新完成：${result.summary.success}/${result.summary.total} 步完成`,
      data: result
    };
  })) return buildResult();

  if (!await runStep('entry_trigger_scan', () => callLocalApi('/api/finance/assets/entry-trigger-observations/secondary-scan', {
    limit: merged.secondary_scan_limit
  }))) return buildResult();

  if (!await runStep('active_plan_suggestions', () => callLocalApi('/api/finance/trade-plans/sync-active-suggestions', {
    limit: merged.active_plan_limit
  }))) return buildResult();

  await runStep('workflow_summary', () => callLocalApi('/api/finance/workflow-summary', undefined, 'GET'));

  return buildResult();
}

export async function runFinanceCandidateFunnelPipeline(config?: FinanceCandidateFunnelConfig | null) {
  const merged = mergeFunnelConfig(config);
  const db = await getDb();
  const steps: FinancePipelineStep[] = [
    { key: 'active_candidate_collect', label: '读取当前备选池', status: 'pending' },
    { key: 'trend_phase_recalc', label: '走势阶段重算', status: 'pending' },
    { key: 'candidate_recheck', label: '单标的判断', status: 'pending' },
    { key: 'entry_observation_seed', label: '推进入场观察', status: 'pending' },
    { key: 'entry_trigger_scan', label: '入场触发确认', status: 'pending' }
  ];

  const buildResult = () => buildPipelineResult(steps, merged);
  const runStep = (key: string, fn: () => Promise<any>) => runPipelineStep(steps, key, fn);
  const nowIso = () => new Date().toISOString();
  let candidates: any[] = [];
  let trendReadyCandidates: any[] = [];
  let qualifiedCandidates: any[] = [];
  let readyObservationIds: number[] = [];

  if (!await runStep('active_candidate_collect', async () => {
    candidates = await db.all(
      `SELECT id, symbol, name, asset_type, source, priority_score, trade_date
       FROM financial_candidate_pool
       WHERE pool_status = 'active'
         AND source = ?
         AND asset_type IN ('stock', 'etf')
         AND COALESCE(review_status, 'unreviewed') <> 'rejected'
       ORDER BY priority_score DESC, last_checked_at DESC, id DESC
       LIMIT ?`,
      [merged.source, Math.max(Math.min(Number(merged.candidate_limit || 120), 300), 1)]
    );
    return {
      message: `读取 active 备选 ${candidates.length} 个`,
      data: { items: candidates }
    };
  })) return buildResult();

  if (!await runStep('trend_phase_recalc', async () => {
    const results = [];
    for (const item of candidates) {
      try {
        const result = await callLocalApi('/api/finance/trend-phase/recalc', {
          symbol: item.symbol,
          asset_type: item.asset_type,
          source: item.source || merged.source
        });
        const latestTrend = await db.get(
          `SELECT trend_phase_code, trend_phase_reason, trade_date
           FROM financial_trend_phase_results
           WHERE symbol = ? AND asset_type = ? AND source = ? AND rule_version = ?
           ORDER BY trade_date DESC
           LIMIT 1`,
          [item.symbol, item.asset_type, item.source || merged.source, TREND_PHASE_VERSION]
        );
        const trendCode = latestTrend?.trend_phase_code || 'UNKNOWN';
        const trendReason = latestTrend?.trend_phase_reason || `走势阶段为 ${trendCode}，未达到准备入场阶段。`;
        const decision = getTrendPhaseDecision(trendCode);
        if (decision.action === 'advance') {
          trendReadyCandidates.push(item);
          const now = nowIso();
          await db.run(
            `UPDATE financial_candidate_pool
             SET review_status = CASE
                   WHEN COALESCE(review_status, 'unreviewed') IN ('trend_blocked', 'unreviewed', 'drafted') THEN 'structure_pending'
                   ELSE review_status
                 END,
                 trend_phase_code = ?,
                 trend_phase_reason = ?,
                 updated_at = ?
             WHERE id = ?
               AND pool_status = 'active'
               AND COALESCE(review_status, 'unreviewed') NOT IN ('rejected', 'plan_ready')`,
            [trendCode, trendReason, now, item.id]
          );
        } else if (decision.action === 'reject') {
          const now = nowIso();
          const reason = `${decision.label}：${getShortTrendReason(trendCode, trendReason)}`;
          await db.run(
            `UPDATE financial_candidate_pool
             SET pool_status = 'expired',
                 review_status = 'rejected',
                 final_status = 'REJECTED',
                 trend_phase_code = ?,
                 trend_phase_reason = ?,
                 candidate_reason = ?,
                 forbidden_reason = ?,
                 last_review_at = ?,
                 review_action = 'trend_phase_rejected',
                 updated_at = ?
             WHERE id = ?
               AND pool_status = 'active'
               AND COALESCE(review_status, 'unreviewed') NOT IN ('plan_ready')`,
            [trendCode, trendReason, reason, reason, now, now, item.id]
          );
          await db.run(
            `UPDATE financial_entry_trigger_observations
             SET observation_status = 'invalidated',
                 entry_action = 'BLOCKED',
                 action_label = '走势淘汰',
                 trigger_reason = ?,
                 trend_phase_code = ?,
                 note = ?,
                 updated_at = ?
             WHERE symbol = ?
               AND asset_type = ?
               AND source = ?
               AND observation_status IN ('watching', 'plan_candidate', 'confirmed')`,
            [
              reason,
              trendCode,
              '入池漏斗走势阶段硬拦截：本轮踢出 active 备选，后续重新符合条件再由备选池扫描带回。',
              now,
              item.symbol,
              item.asset_type,
              item.source || merged.source
            ]
          );
        } else {
          const now = nowIso();
          await db.run(
            `UPDATE financial_candidate_pool
             SET review_status = 'trend_blocked',
                 trend_phase_code = ?,
                 trend_phase_reason = ?,
                 candidate_reason = ?,
                 updated_at = ?
             WHERE id = ?
               AND pool_status = 'active'
               AND COALESCE(review_status, 'unreviewed') NOT IN ('rejected')`,
            [trendCode, trendReason, `走势阶段卡住：${getShortTrendReason(trendCode, trendReason)}`, now, item.id]
          );
          await db.run(
            `UPDATE financial_entry_trigger_observations
             SET observation_status = 'watching',
                 entry_action = 'OBSERVE',
                 action_label = '走势观察',
                 trigger_reason = ?,
                 trend_phase_code = ?,
                 note = ?,
                 updated_at = ?
             WHERE symbol = ?
               AND asset_type = ?
               AND source = ?
               AND observation_status IN ('plan_candidate', 'confirmed')`,
            [
              `走势阶段为 ${trendCode}，未达到准备入场阶段。`,
              trendCode,
              '入池漏斗走势阶段拦截：退回观察，不生成买入计划草案。',
              now,
              item.symbol,
              item.asset_type,
              item.source || merged.source
            ]
          );
        }
        results.push({
          symbol: item.symbol,
          name: item.name,
          asset_type: item.asset_type,
          success: true,
          passed: decision.action === 'advance',
          decision: decision.action,
          decision_label: decision.label,
          trend_phase_code: trendCode,
          message: result.message,
          reason: `走势阶段${decision.label}：${trendCode}`,
          data: result.data
        });
      } catch (error) {
        results.push({
          symbol: item.symbol,
          name: item.name,
          asset_type: item.asset_type,
          success: false,
          message: (error as Error).message
        });
      }
    }
    const failedCount = results.filter((item: any) => item.success === false).length;
    if (candidates.length > 0 && failedCount === candidates.length) {
      throw new Error(`走势阶段重算全部失败：${failedCount}/${candidates.length} 个标的接口失败`);
    }
    const holdCount = results.filter((item: any) => item.success !== false && item.decision === 'hold').length;
    const rejectedCount = results.filter((item: any) => item.success !== false && item.decision === 'reject').length;
    return {
      message: `走势阶段重算完成：推进 ${trendReadyCandidates.length} 个，留队 ${holdCount} 个，踢出 ${rejectedCount} 个，失败 ${failedCount} 个`,
      data: {
        results,
        checked_count: candidates.length,
        passed_count: trendReadyCandidates.length,
        hold_count: holdCount,
        rejected_count: rejectedCount,
        blocked_count: holdCount + rejectedCount,
        failed_count: failedCount
      }
    };
  })) return buildResult();

  if (!await runStep('candidate_recheck', async () => {
    const results = [];
    for (const item of trendReadyCandidates) {
      try {
        const result = await callLocalApi(`/api/finance/candidate-pool/structure-queue/${item.id}/recheck`, undefined, 'POST');
        const evaluation = result.data?.evaluation || {};
        const queueItem = result.data?.item || {};
        const passedStructure = queueItem.review_status === 'wait_confirmation' || result.data?.decision?.review_status === 'wait_confirmation';
        if (passedStructure) {
          qualifiedCandidates.push(item);
        }
        results.push({
          symbol: item.symbol,
          name: item.name,
          asset_type: item.asset_type,
          selected: passedStructure,
          review_status: queueItem.review_status || result.data?.decision?.review_status,
          priority_score: evaluation.priority_score,
          reason: queueItem.queue_reason || evaluation.candidate_reason || evaluation.reason || result.message
        });
      } catch (error) {
        results.push({
          symbol: item.symbol,
          name: item.name,
          asset_type: item.asset_type,
          selected: false,
          success: false,
          reason: (error as Error).message
        });
      }
    }
    const failedCount = results.filter((item: any) => item.success === false).length;
    if (trendReadyCandidates.length > 0 && failedCount === trendReadyCandidates.length) {
      throw new Error(`备选资格复核全部失败：${failedCount}/${trendReadyCandidates.length} 个标的接口失败`);
    }
    const rejectedCount = results.filter((item: any) => item.success !== false && item.review_status === 'rejected').length;
    const watchCount = results.filter((item: any) => item.success !== false && ['structure_watch', 'trend_blocked', 'model_conflict'].includes(item.review_status)).length;
    return {
      message: `单标的判断完成：通过 ${qualifiedCandidates.length} 个，观察/回退 ${watchCount} 个，淘汰 ${rejectedCount} 个，失败 ${failedCount} 个`,
      data: {
        results,
        selected_count: qualifiedCandidates.length,
        watch_count: watchCount,
        rejected_count: rejectedCount,
        failed_count: failedCount,
        checked_count: trendReadyCandidates.length
      }
    };
  })) return buildResult();

  if (!await runStep('entry_observation_seed', async () => {
    const results = [];
    for (const item of qualifiedCandidates) {
      try {
        const trigger = await callLocalApi('/api/finance/assets/entry-trigger', {
          symbol: item.symbol,
          asset_type: item.asset_type,
          source: item.source || merged.source
        });
        const snapshot = trigger.data;
        if (snapshot?.action !== 'READY_TO_PLAN') {
          const invalidated =
            snapshot?.action === 'BLOCKED' ||
            snapshot?.action === 'INVALIDATED' ||
            snapshot?.structure_status === 'STRUCTURE_BROKEN' ||
            (snapshot?.close && snapshot?.invalidation_line && snapshot.close < snapshot.invalidation_line);
          const nextObservationStatus = invalidated ? 'invalidated' : 'watching';
          const trendReady = FUNNEL_READY_TREND_PHASES.has(snapshot?.trend_phase_code || '');
          const structureDegraded =
            snapshot?.structure_status !== 'STRUCTURE_CONFIRMED' ||
            snapshot?.safe_zone_status !== 'SAFE_ZONE' ||
            (typeof snapshot?.structure_score?.score === 'number' && snapshot.structure_score.score < 50);
          const nextCandidateStatus = invalidated
            ? 'rejected'
            : !trendReady
              ? 'trend_blocked'
              : structureDegraded
                ? 'structure_watch'
                : 'wait_confirmation';
          const now = nowIso();
          const existingObservations = await db.all(
            `SELECT id
             FROM financial_entry_trigger_observations
             WHERE symbol = ?
               AND asset_type = ?
               AND source = ?
               AND observation_status IN ('plan_candidate', 'confirmed', 'watching')
             ORDER BY updated_at DESC, id DESC`,
            [item.symbol, item.asset_type, item.source || merged.source]
          );
          if (existingObservations.length > 0) {
            await db.run(
              `UPDATE financial_entry_trigger_observations
               SET observation_status = ?,
                   entry_action = ?,
                   action_label = ?,
                   trigger_score = ?,
                   trigger_reason = ?,
                   structure_score = ?,
                   trend_phase_code = ?,
                   market_regime = ?,
                   entry_permission = ?,
                   close_price = ?,
                   ma20 = ?,
                   ma60 = ?,
                   invalidation_line = ?,
                   snapshot_json = ?,
                   note = ?,
                   updated_at = ?
               WHERE id IN (${existingObservations.map(() => '?').join(',')})`,
              [
                nextObservationStatus,
                snapshot?.action || '',
                snapshot?.action_label || '',
                snapshot?.trigger_score || 0,
                snapshot?.trigger_reason || '',
                snapshot?.structure_score?.score || null,
                snapshot?.trend_phase_code || '',
                snapshot?.market_regime || '',
                snapshot?.entry_permission || '',
                snapshot?.close || null,
                snapshot?.ma20 || null,
                snapshot?.ma60 || null,
                snapshot?.invalidation_line || null,
                JSON.stringify(snapshot || {}),
                invalidated
                  ? '入池漏斗预检：失效淘汰'
                  : nextCandidateStatus === 'structure_watch'
                    ? '入池漏斗预检：结构/安全区退化，退回单标的判断'
                    : nextCandidateStatus === 'trend_blocked'
                      ? '入池漏斗预检：走势阶段退化，退回走势队列'
                      : '入池漏斗预检：买点未触发，留在入场触发观察',
                now,
                ...existingObservations.map((row: any) => row.id)
              ]
            );
          }
          await db.run(
            `UPDATE financial_candidate_pool
             SET review_status = ?,
                 updated_at = ?
             WHERE symbol = ?
               AND asset_type = ?
               AND source = ?
               AND pool_status = 'active'
               AND review_status IN ('structure_ready', 'plan_ready', 'wait_confirmation', 'unreviewed')`,
            [
              nextCandidateStatus,
              now,
              item.symbol,
              item.asset_type,
              item.source || merged.source
            ]
          );
          results.push({
            symbol: item.symbol,
            name: snapshot?.name || item.name,
            asset_type: item.asset_type,
            passed: false,
            downgraded: existingObservations.length > 0,
            action: snapshot?.action,
            action_label: snapshot?.action_label,
            trigger_score: snapshot?.trigger_score,
            reason: snapshot?.trigger_reason || '入场触发未通过'
          });
          continue;
        }

        const saved = await callLocalApi('/api/finance/assets/entry-trigger-observations', {
          snapshot,
          source: snapshot?.data_source_used || item.source || merged.source,
          note: '入池漏斗流水线自动推进至入场触发观察；只生成流程建议，不自动建仓。'
        });
        if (saved.data?.id) {
          readyObservationIds.push(Number(saved.data.id));
        }
        results.push({
          symbol: item.symbol,
          name: snapshot?.name || item.name,
          asset_type: item.asset_type,
          passed: true,
          action: snapshot?.action,
          action_label: snapshot?.action_label,
          trigger_score: snapshot?.trigger_score,
          observation_status: saved.data?.observation_status,
          observation_id: saved.data?.id,
          reason: snapshot?.trigger_reason
        });
      } catch (error) {
        results.push({
          symbol: item.symbol,
          name: item.name,
          asset_type: item.asset_type,
          success: false,
          reason: (error as Error).message
        });
      }
    }
    const failedCount = results.filter((item: any) => item.success === false).length;
    if (qualifiedCandidates.length > 0 && failedCount === qualifiedCandidates.length) {
      throw new Error(`入场触发预检全部失败：${failedCount}/${qualifiedCandidates.length} 个标的接口失败`);
    }
    const readyCount = results.filter((item: any) => item.passed).length;
    const blockedCount = results.filter((item: any) => item.success !== false && !item.passed).length;
    return {
      message: `入场触发预检完成：准备入场 ${readyCount} 个，继续观察 ${blockedCount} 个，失败 ${failedCount} 个`,
      data: {
        results,
        ready_count: readyCount,
        blocked_count: blockedCount,
        failed_count: failedCount,
        downgraded_count: results.filter((item: any) => item.downgraded).length,
        observation_ids: readyObservationIds
      }
    };
  })) return buildResult();

  await runStep('entry_trigger_scan', async () => {
    const results = [];
    for (const observationId of readyObservationIds.slice(0, Math.max(Math.min(Number(merged.secondary_scan_limit || 120), 200), 1))) {
      try {
        const scan = await callLocalApi(`/api/finance/assets/entry-trigger-observations/${observationId}/secondary-scan`, undefined, 'POST');
        const observation = scan.data?.observation;
        const conclusion = scan.data?.conclusion || '';
        const candidateReviewStatus = conclusion === '可升级计划准备'
          ? 'plan_ready'
          : conclusion === '失效淘汰'
            ? 'rejected'
            : conclusion === '退回单标的判断'
              ? 'structure_watch'
              : conclusion === '退回走势阶段'
                ? 'trend_blocked'
                : 'wait_confirmation';
        if (observation?.symbol) {
          await db.run(
            `UPDATE financial_candidate_pool
             SET review_status = ?, updated_at = ?
             WHERE symbol = ? AND asset_type = ? AND source = ? AND pool_status = 'active'`,
            [
              candidateReviewStatus,
              nowIso(),
              observation.symbol,
              observation.asset_type,
              observation.source
            ]
          );
        }
        results.push({
          symbol: observation?.symbol,
          name: observation?.name,
          asset_type: observation?.asset_type,
          observation_id: observationId,
          conclusion,
          observation_status: observation?.observation_status,
          candidate_review_status: candidateReviewStatus,
          action: observation?.entry_action,
          action_label: observation?.action_label,
          trigger_score: observation?.trigger_score,
          reason: observation?.trigger_reason
        });
      } catch (error) {
        results.push({
          observation_id: observationId,
          success: false,
          reason: (error as Error).message
        });
      }
    }
    const summary = {
      checked: results.length,
      upgraded: results.filter((item: any) => item.conclusion === '可升级计划准备').length,
      waiting: results.filter((item: any) => item.conclusion === '继续等待').length,
      invalidated: results.filter((item: any) => item.conclusion === '失效淘汰').length,
      failed: results.filter((item: any) => item.success === false).length
    };
    if (readyObservationIds.length > 0 && summary.failed === readyObservationIds.length) {
      throw new Error(`入场触发确认全部失败：${summary.failed}/${readyObservationIds.length} 条观察记录接口失败`);
    }
    return {
      message: `入场触发确认完成：检查 ${summary.checked} 个，准备入场 ${summary.upgraded} 个，继续等待 ${summary.waiting} 个，失效 ${summary.invalidated} 个，失败 ${summary.failed} 个`,
      data: { summary, results }
    };
  });

  return buildResult();
}
