import { Router, Request, Response } from 'express';
import getDb from '../config/database';

const router = Router();

type ForwardMetrics = {
  ret5: number | null;
  ret10: number | null;
  ret20: number | null;
  maxDrawdown20: number | null;
  brokeInvalidation: boolean;
  latestTradeDate: string | null;
};

function toNumber(value: any, fallback = 0): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function roundMetric(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function avg(values: Array<number | null | undefined>): number | null {
  const clean = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

async function getForwardMetrics(db: any, row: any): Promise<ForwardMetrics> {
  const tradeDate = row.trade_date || row.created_at?.slice(0, 10);
  if (!row.symbol || !tradeDate) {
    return { ret5: null, ret10: null, ret20: null, maxDrawdown20: null, brokeInvalidation: false, latestTradeDate: null };
  }

  const prices = await db.all(
    `SELECT trade_date, close, low
     FROM financial_daily_prices
     WHERE symbol = ?
       AND asset_type = ?
       AND source = ?
       AND trade_date >= ?
     ORDER BY trade_date ASC
     LIMIT 26`,
    [row.symbol, row.asset_type || 'stock', row.source || 'tushare', tradeDate]
  );

  const entryClose = toNumber(row.close ?? row.close_price, toNumber(prices[0]?.close));
  if (!entryClose || prices.length < 2) {
    return { ret5: null, ret10: null, ret20: null, maxDrawdown20: null, brokeInvalidation: false, latestTradeDate: prices[0]?.trade_date || null };
  }

  const getReturn = (offset: number) => {
    const item = prices[offset];
    const close = toNumber(item?.close);
    return close > 0 ? roundMetric(close / entryClose - 1) : null;
  };
  const window20 = prices.slice(1, 21);
  const minLow = window20.length ? Math.min(...window20.map((item: any) => toNumber(item.low, toNumber(item.close)))) : null;
  const invalidationLine = toNumber(row.invalidation_line);

  return {
    ret5: getReturn(5),
    ret10: getReturn(10),
    ret20: getReturn(20),
    maxDrawdown20: minLow && minLow > 0 ? roundMetric(minLow / entryClose - 1) : null,
    brokeInvalidation: invalidationLine > 0 && window20.some((item: any) => toNumber(item.low, toNumber(item.close)) < invalidationLine),
    latestTradeDate: prices[prices.length - 1]?.trade_date || null
  };
}

function summarize(items: any[]) {
  const valid20 = items.filter(item => item.metrics?.ret20 !== null && item.metrics?.ret20 !== undefined);
  const wins20 = valid20.filter(item => Number(item.metrics.ret20) > 0);
  const invalidated = items.filter(item => item.metrics?.brokeInvalidation);
  return {
    total: items.length,
    evaluable20: valid20.length,
    winRate20: valid20.length ? roundMetric(wins20.length / valid20.length) : null,
    avgRet5: roundMetric(avg(items.map(item => item.metrics?.ret5))),
    avgRet10: roundMetric(avg(items.map(item => item.metrics?.ret10))),
    avgRet20: roundMetric(avg(items.map(item => item.metrics?.ret20))),
    avgMaxDrawdown20: roundMetric(avg(items.map(item => item.metrics?.maxDrawdown20))),
    invalidationBreakRate: items.length ? roundMetric(invalidated.length / items.length) : null
  };
}

function compactSample(row: any, metrics: ForwardMetrics) {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    assetType: row.asset_type,
    source: row.source,
    tradeDate: row.trade_date,
    status: row.pool_status || row.status || row.review_status,
    score: row.priority_score ?? row.structure_score ?? null,
    trendPhase: row.trend_phase_code || null,
    reason: row.first_blocking_gate_label || row.forbidden_reason || row.downgrade_reason || row.risk_note || row.trigger_reason || row.entry_reason || '',
    metrics
  };
}

function groupByTrend(items: any[]) {
  const groups = new Map<string, any[]>();
  items.forEach(item => {
    const key = item.trendPhase || 'UNKNOWN';
    groups.set(key, [...(groups.get(key) || []), item]);
  });
  return Array.from(groups.entries())
    .map(([trendPhase, rows]) => ({ trendPhase, ...summarize(rows) }))
    .sort((a, b) => b.total - a.total);
}

router.get('/sample-validation/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const candidateRows = await db.all(
      `SELECT id, symbol, name, asset_type, source, trade_date, close, pool_status, review_status,
              priority_score, trend_phase_code, invalidation_line, first_blocking_gate_label,
              forbidden_reason, downgrade_reason, risk_note, created_at, updated_at
       FROM financial_candidate_pool
       WHERE asset_type IN ('stock', 'etf')
       ORDER BY COALESCE(last_checked_at, updated_at, created_at) DESC
       LIMIT 260`
    );
    const planRows = await db.all(
      `SELECT id, plan_name, symbol, name, asset_type, source, trade_date, close_price as close,
              status, structure_score, trigger_score, trend_phase_code, invalidation_line,
              trigger_reason, entry_reason, created_at, updated_at
       FROM financial_trade_plans
       WHERE is_deleted = 0
       ORDER BY created_at DESC
       LIMIT 220`
    );
    const modelConflictRows = await db.all(
      `SELECT r.id, r.symbol, r.name, r.asset_type, r.source, r.trade_date,
              c.close, c.pool_status, c.review_status, c.priority_score, c.trend_phase_code,
              c.invalidation_line, c.safe_zone_status, c.structure_status, c.forbidden_reason,
              c.downgrade_reason, c.risk_note, r.model_probability, r.lane_label, r.created_at
       FROM financial_candidate_reviews r
       LEFT JOIN financial_candidate_pool c
         ON c.symbol = r.symbol
        AND c.asset_type = r.asset_type
        AND c.source = r.source
       WHERE r.model_probability >= 0.65
         AND (
           COALESCE(c.safe_zone_status, '') <> 'SAFE_ZONE'
           OR COALESCE(c.structure_status, '') <> 'STRUCTURE_CONFIRMED'
           OR COALESCE(c.pool_status, '') = 'expired'
         )
       ORDER BY r.created_at DESC
       LIMIT 120`
    );
    const rejectedRows = await db.all(
      `SELECT id, title, project_name, track, decision_date, decision_stage,
              decision_quality, later_status, rejection_reason, risk_result
       FROM rejected_opportunities
       WHERE is_deleted = 0
       ORDER BY decision_date DESC, id DESC
       LIMIT 80`
    );

    const candidates = await Promise.all(candidateRows.map(async (row: any) => compactSample(row, await getForwardMetrics(db, row))));
    const plans = await Promise.all(planRows.map(async (row: any) => compactSample(row, await getForwardMetrics(db, row))));
    const modelConflicts = await Promise.all(modelConflictRows.map(async (row: any) => compactSample(row, await getForwardMetrics(db, row))));

    const enteredCandidates = candidates.filter(item => ['active', 'planned'].includes(String(item.status)));
    const blockedCandidates = candidates.filter(item => String(item.status) === 'expired');
    const planFailures = plans.filter(item => item.metrics.brokeInvalidation || (item.metrics.ret20 !== null && item.metrics.ret20 < 0));

    res.json({
      success: true,
      data: {
        cards: [
          { key: 'candidate', label: '备选池样本', value: enteredCandidates.length, summary: summarize(enteredCandidates) },
          { key: 'blocked', label: '规则拦截样本', value: blockedCandidates.length, summary: summarize(blockedCandidates) },
          { key: 'plan', label: '计划样本', value: plans.length, summary: summarize(plans) },
          { key: 'model_conflict', label: '模型冲突样本', value: modelConflicts.length, summary: summarize(modelConflicts) }
        ],
        sections: {
          enteredCandidates: { title: '进入备选池后的表现', summary: summarize(enteredCandidates), items: enteredCandidates.slice(0, 30) },
          blockedCandidates: { title: '被规则/风控拦截后的表现', summary: summarize(blockedCandidates), items: blockedCandidates.slice(0, 30) },
          plans: { title: '进入计划池后的表现', summary: summarize(plans), items: plans.slice(0, 30) },
          modelConflicts: { title: '模型高分但规则未通过', summary: summarize(modelConflicts), items: modelConflicts.slice(0, 30) },
          planFailures: { title: '计划失败样本', summary: summarize(planFailures), items: planFailures.slice(0, 30) }
        },
        trendFailure: groupByTrend([...plans, ...blockedCandidates].filter(item => item.metrics.brokeInvalidation || (item.metrics.ret20 !== null && item.metrics.ret20 < 0))),
        rejectedOpportunities: {
          total: rejectedRows.length,
          reviewNeeded: rejectedRows.filter((row: any) => row.decision_quality === 'needs_review' || row.later_status === 'trigger_review').length,
          items: rejectedRows.slice(0, 20)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取样本验证失败：${(error as Error).message}` });
  }
});

router.get('/account-risk/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const activePlans = await db.all(
      `SELECT p.id, p.plan_name, p.symbol, p.name, p.asset_type, p.status, p.total_capital,
              p.structure_score, p.trend_phase_code, p.max_loss_percent, p.updated_at,
              COALESCE(SUM(CASE
                WHEN e.action_type IN ('buy', 'add') THEN e.execution_amount
                WHEN e.action_type IN ('sell', 'reduce', 'stop_loss', 'exit') THEN -e.execution_amount
                ELSE 0
              END), 0) as current_amount
       FROM financial_trade_plans p
       LEFT JOIN financial_trade_executions e ON e.plan_id = p.id
       WHERE p.is_deleted = 0
         AND p.status IN ('draft', 'watching', 'paper_tracking', 'active')
       GROUP BY p.id
       ORDER BY p.updated_at DESC
       LIMIT 300`
    );
    const recentOutcomes = await db.all(
      `SELECT id, plan_name, symbol, name, asset_type, status, perf_20d, stopped_out,
              false_breakout, chased_high, updated_at
       FROM financial_trade_plans
       WHERE is_deleted = 0
         AND (
           status IN ('closed', 'invalidated')
           OR stopped_out = 1
           OR perf_20d IS NOT NULL
         )
       ORDER BY updated_at DESC
       LIMIT 30`
    );
    const endedRows = await db.all(
      `SELECT id, category_name, object_name, variant_name, profit, sell_date
       FROM ended_positions
       WHERE sell_date >= date('now', '-30 day')
       ORDER BY sell_date DESC
       LIMIT 100`
    );

    const totalExposure = activePlans.reduce((sum: number, row: any) => sum + Math.max(0, toNumber(row.current_amount)), 0);
    const plannedCapital = activePlans.reduce((sum: number, row: any) => sum + Math.max(0, toNumber(row.total_capital)), 0);
    const byAssetTypeMap = new Map<string, { assetType: string; count: number; exposure: number; planned: number }>();
    activePlans.forEach((row: any) => {
      const key = row.asset_type || 'unknown';
      const current = byAssetTypeMap.get(key) || { assetType: key, count: 0, exposure: 0, planned: 0 };
      current.count += 1;
      current.exposure += Math.max(0, toNumber(row.current_amount));
      current.planned += Math.max(0, toNumber(row.total_capital));
      byAssetTypeMap.set(key, current);
    });
    const byAssetType = Array.from(byAssetTypeMap.values()).sort((a, b) => b.exposure - a.exposure);
    const largest = [...activePlans].sort((a: any, b: any) => toNumber(b.current_amount) - toNumber(a.current_amount))[0] || null;
    const latestFailures: any[] = [];
    for (const row of recentOutcomes) {
      const failed = row.stopped_out === 1 || row.status === 'invalidated' || toNumber(row.perf_20d, 0) < 0;
      if (!failed) break;
      latestFailures.push(row);
    }
    const recentEndedProfit = endedRows.reduce((sum: number, row: any) => sum + toNumber(row.profit), 0);
    const recentEndedLossCount = endedRows.filter((row: any) => toNumber(row.profit) < 0).length;

    const rules = [
      {
        key: 'consecutive_failures',
        label: '连续计划失败',
        status: latestFailures.length >= 3 ? 'block' : latestFailures.length >= 2 ? 'warn' : 'pass',
        value: latestFailures.length,
        message: latestFailures.length >= 3 ? '连续失败达到3次，建议进入账户冷却，只允许复盘和减风险。' : latestFailures.length >= 2 ? '连续失败达到2次，新开仓降级。' : '没有触发连续失败冷却。'
      },
      {
        key: 'monthly_loss',
        label: '近30日已结束盈亏',
        status: recentEndedProfit <= -10000 ? 'block' : recentEndedProfit < 0 ? 'warn' : 'pass',
        value: roundMetric(recentEndedProfit, 2),
        message: recentEndedProfit <= -10000 ? '近30日亏损较大，暂停新增实仓。' : recentEndedProfit < 0 ? '近30日为亏损，降低单笔计划金额。' : '近30日已结束仓位未触发亏损限制。'
      },
      {
        key: 'largest_position',
        label: '最大单计划暴露',
        status: totalExposure > 0 && largest && toNumber(largest.current_amount) / totalExposure >= 0.45 ? 'warn' : 'pass',
        value: totalExposure > 0 && largest ? roundMetric(toNumber(largest.current_amount) / totalExposure) : null,
        message: totalExposure > 0 && largest && toNumber(largest.current_amount) / totalExposure >= 0.45 ? '最大单计划占比偏高，继续新增前先考虑退出路径。' : '单计划暴露没有明显过度集中。'
      },
      {
        key: 'active_plan_count',
        label: '同时跟踪计划数',
        status: activePlans.length >= 12 ? 'warn' : 'pass',
        value: activePlans.length,
        message: activePlans.length >= 12 ? '同时跟踪计划过多，容易执行分散，建议清理低质量计划。' : '同时跟踪计划数量可控。'
      }
    ];
    const hasBlock = rules.some(rule => rule.status === 'block');
    const hasWarn = rules.some(rule => rule.status === 'warn');

    res.json({
      success: true,
      data: {
        status: hasBlock ? 'COOLDOWN' : hasWarn ? 'LIMITED' : 'NORMAL',
        statusLabel: hasBlock ? '账户冷却' : hasWarn ? '限制开仓' : '正常',
        headline: hasBlock
          ? '账户层面触发冷却，先暂停新增实仓。'
          : hasWarn
            ? '账户层面有风险项，新计划要降金额或先做纸面跟踪。'
            : '账户层面未触发硬限制。',
        exposure: {
          activePlanCount: activePlans.length,
          totalExposure: roundMetric(totalExposure, 2),
          plannedCapital: roundMetric(plannedCapital, 2),
          largestPlan: largest ? {
            id: largest.id,
            name: largest.plan_name,
            symbol: largest.symbol,
            amount: roundMetric(toNumber(largest.current_amount), 2),
            percent: totalExposure > 0 ? roundMetric(toNumber(largest.current_amount) / totalExposure) : null
          } : null,
          byAssetType
        },
        recent: {
          consecutiveFailures: latestFailures.length,
          recentEndedProfit: roundMetric(recentEndedProfit, 2),
          recentEndedLossCount,
          latestFailures: latestFailures.slice(0, 6),
          endedRows: endedRows.slice(0, 8)
        },
        rules
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取账户级风控失败：${(error as Error).message}` });
  }
});

export default router;
