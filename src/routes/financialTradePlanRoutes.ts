import { Router, Request, Response } from 'express';
import getDb from '../config/database';
import { buildFinancePlanQuality } from '../services/financePlanQuality';
import { getFinancePlanProfileConfig, resolveFinancePlanProfile } from '../services/financePlanProfile';
import { getFreshMarketRegime } from '../utils/financeMarketRegime';

const router = Router();
let tradePlanProfileSchemaReady = false;
let financeFailureSamplesSchemaReady = false;

function isTradePlanMarketGateOpen(marketGate: any) {
  return marketGate?.entry_permission === 'ALLOW_STRUCTURE_CHECK';
}

function getTradePlanMarketGateBlockReason(marketGate: any) {
  if (marketGate?.stale) return marketGate.freshness_reason;
  return marketGate?.entry_reason
    || marketGate?.result_reason
    || marketGate?.freshness_reason
    || '市场总闸未开放单标的结构判断。';
}

async function getTradePlanMarketGateBlocker(db: any, source: string) {
  const marketGate = await getFreshMarketRegime(db, { source });
  if (isTradePlanMarketGateOpen(marketGate)) return null;
  return {
    marketGate,
    message: `市场总闸未通过，禁止生成买入计划或新增买入执行；本轮不修改计划状态：${getTradePlanMarketGateBlockReason(marketGate)}`
  };
}

const ACCOUNT_RISK_CONFIG_DEFAULTS = [
  { key: 'consecutive_failures_warn', value: 2 },
  { key: 'consecutive_failures_block', value: 3 },
  { key: 'monthly_loss_warn', value: 0 },
  { key: 'monthly_loss_block', value: -10000 },
  { key: 'largest_position_warn', value: 0.45 },
  { key: 'active_plan_count_warn', value: 12 },
  { key: 'same_asset_type_count_warn', value: 5 }
];

async function ensureFinanceFailureSamplesSchema(db: any) {
  if (financeFailureSamplesSchemaReady) return;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS finance_failure_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      sample_type TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      asset_type TEXT,
      source TEXT,
      trade_date TEXT,
      status TEXT,
      reason TEXT,
      score_json TEXT,
      context_json TEXT,
      outcome_json TEXT,
      followup_status TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_failure_samples_unique
      ON finance_failure_samples(source_type, source_id, sample_type);

    CREATE INDEX IF NOT EXISTS idx_finance_failure_samples_symbol
      ON finance_failure_samples(symbol, asset_type, source);
  `);
  financeFailureSamplesSchemaReady = true;
}

async function ensureTradePlanProfileSchema(db: any) {
  if (tradePlanProfileSchemaReady) return;
  const columns = await db.all(`PRAGMA table_info(financial_trade_plans)`);
  const names = new Set(columns.map((column: any) => column.name));
  if (!names.has('plan_profile')) {
    await db.exec(`ALTER TABLE financial_trade_plans ADD COLUMN plan_profile TEXT`);
  }
  if (!names.has('plan_profile_label')) {
    await db.exec(`ALTER TABLE financial_trade_plans ADD COLUMN plan_profile_label TEXT`);
  }
  if (!names.has('plan_profile_note')) {
    await db.exec(`ALTER TABLE financial_trade_plans ADD COLUMN plan_profile_note TEXT`);
  }
  if (!names.has('account_risk_status')) {
    await db.exec(`ALTER TABLE financial_trade_plans ADD COLUMN account_risk_status TEXT`);
  }
  if (!names.has('account_risk_label')) {
    await db.exec(`ALTER TABLE financial_trade_plans ADD COLUMN account_risk_label TEXT`);
  }
  if (!names.has('account_risk_message')) {
    await db.exec(`ALTER TABLE financial_trade_plans ADD COLUMN account_risk_message TEXT`);
  }
  const missingRows = await db.all(
    `SELECT p.id, p.symbol, p.name, p.asset_type, p.source,
            GROUP_CONCAT(DISTINCT u.universe_type) as universe_type
     FROM financial_trade_plans p
     LEFT JOIN financial_asset_universe u
       ON u.symbol = p.symbol
      AND u.asset_type = p.asset_type
      AND u.source = p.source
     WHERE p.plan_profile IS NULL OR TRIM(p.plan_profile) = ''
     GROUP BY p.id
     LIMIT 500`
  );
  for (const row of missingRows) {
    const profile = resolveFinancePlanProfile({
      assetType: row.asset_type,
      symbol: row.symbol,
      name: row.name,
      universeType: row.universe_type || ''
    });
    await db.run(
      `UPDATE financial_trade_plans
       SET plan_profile = ?,
           plan_profile_label = ?,
           plan_profile_note = ?
       WHERE id = ?`,
      [profile.key, profile.label, profile.note, row.id]
    );
  }
  tradePlanProfileSchemaReady = true;
}

function bucketStructureScore(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'unknown';
  if (score >= 80) return '80-100';
  if (score >= 65) return '65-79';
  if (score >= 50) return '50-64';
  return '0-49';
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildPositionPlan(
  totalCapital: number,
  triggerAction: string,
  structureScore: number,
  maxLossPercent: number | null,
  planProfileKey?: string | null
) {
  const profile = getFinancePlanProfileConfig(planProfileKey);
  let { base: baseRatio, tactical: tacticalRatio, observation: observationRatio } = profile.defaultRatios;

  if (triggerAction !== 'READY_TO_PLAN') {
    baseRatio = 0.2;
    tacticalRatio = 0.2;
    observationRatio = 0.6;
  } else if (structureScore >= 80 && maxLossPercent !== null && maxLossPercent <= profile.tightRiskPercent) {
    baseRatio = profile.strongRatios.base;
    tacticalRatio = profile.strongRatios.tactical;
    observationRatio = profile.strongRatios.observation;
  } else if (structureScore < profile.minStructureScore || (maxLossPercent !== null && maxLossPercent > profile.maxRiskPercent)) {
    baseRatio = profile.weakRatios.base;
    tacticalRatio = profile.weakRatios.tactical;
    observationRatio = profile.weakRatios.observation;
  }

  return {
    principle_snapshot: [
      `计划Profile：${profile.label}。${profile.note}`,
      '底仓负责站对位置，机动仓负责执行纪律，观察仓负责不乱想。',
      '所有止损、止盈、追踪止盈只对机动仓有效。底仓只按结构退出。',
      '不参与任何短期兑现。'
    ].join('\n'),
    base_amount: roundMoney(totalCapital * baseRatio),
    tactical_amount: roundMoney(totalCapital * tacticalRatio),
    observation_amount: roundMoney(totalCapital * observationRatio),
    base_ratio: Math.round(baseRatio * 100),
    tactical_ratio: Math.round(tacticalRatio * 100),
    observation_ratio: Math.round(observationRatio * 100)
  };
}

function buildPlanQuality(plan: any) {
  return buildFinancePlanQuality(plan);
}

function toNumber(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

async function ensureAccountRiskConfigSchema(db: any) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS finance_account_risk_config (
      config_key TEXT PRIMARY KEY,
      numeric_value REAL NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  for (const item of ACCOUNT_RISK_CONFIG_DEFAULTS) {
    await db.run(
      `INSERT OR IGNORE INTO finance_account_risk_config (config_key, numeric_value)
       VALUES (?, ?)`,
      [item.key, item.value]
    );
  }
}

async function getAccountRiskConfigValues(db: any) {
  await ensureAccountRiskConfigSchema(db);
  const rows = await db.all(`SELECT config_key, numeric_value FROM finance_account_risk_config`);
  return Object.fromEntries(
    ACCOUNT_RISK_CONFIG_DEFAULTS.map(item => {
      const row = rows.find((candidate: any) => candidate.config_key === item.key);
      const value = Number(row?.numeric_value ?? item.value);
      return [item.key, Number.isFinite(value) ? value : item.value];
    })
  );
}

async function buildAccountRiskDecision(db: any, incoming?: { assetType?: string }) {
  const config = await getAccountRiskConfigValues(db);
  const activePlans = await db.all(
    `SELECT p.id, p.plan_name, p.symbol, p.name, p.asset_type, p.status, p.total_capital,
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
    `SELECT id, profit, sell_date
     FROM ended_positions
     WHERE sell_date >= date('now', '-30 day')
     ORDER BY sell_date DESC
     LIMIT 100`
  );

  const latestFailures: any[] = [];
  for (const row of recentOutcomes) {
    const failed = row.stopped_out === 1 || row.status === 'invalidated' || toNumber(row.perf_20d, 0) < 0;
    if (!failed) break;
    latestFailures.push(row);
  }
  const recentEndedProfit = endedRows.reduce((sum: number, row: any) => sum + toNumber(row.profit), 0);
  const byAssetTypeMap = new Map<string, number>();
  activePlans.forEach((row: any) => {
    const key = row.asset_type || 'unknown';
    byAssetTypeMap.set(key, (byAssetTypeMap.get(key) || 0) + 1);
  });
  if (incoming?.assetType) {
    byAssetTypeMap.set(incoming.assetType, (byAssetTypeMap.get(incoming.assetType) || 0) + 1);
  }
  const activePlanCount = activePlans.length + (incoming?.assetType ? 1 : 0);
  const maxAssetTypeCount = Array.from(byAssetTypeMap.values()).reduce((max, count) => Math.max(max, count), 0);
  const totalExposure = activePlans.reduce((sum: number, row: any) => sum + Math.max(0, toNumber(row.current_amount)), 0);
  const largest = [...activePlans].sort((a: any, b: any) => toNumber(b.current_amount) - toNumber(a.current_amount))[0] || null;

  const rules = [
    latestFailures.length >= config.consecutive_failures_block ? '连续计划失败达到冷却线' : latestFailures.length >= config.consecutive_failures_warn ? '连续计划失败达到预警线' : '',
    recentEndedProfit <= config.monthly_loss_block ? '近30日已结束盈亏触发冷却线' : recentEndedProfit < config.monthly_loss_warn ? '近30日已结束盈亏触发预警线' : '',
    totalExposure > 0 && largest && toNumber(largest.current_amount) / totalExposure >= config.largest_position_warn ? '最大单计划暴露占比偏高' : '',
    activePlanCount >= config.active_plan_count_warn ? '同时跟踪计划数偏多' : '',
    maxAssetTypeCount >= config.same_asset_type_count_warn ? '同类资产计划数量偏多' : ''
  ].filter(Boolean);

  const hasBlock = latestFailures.length >= config.consecutive_failures_block
    || recentEndedProfit <= config.monthly_loss_block;
  const hasWarn = rules.length > 0;
  const status = hasBlock ? 'COOLDOWN' : hasWarn ? 'LIMITED' : 'NORMAL';
  return {
    status,
    label: hasBlock ? '账户冷却' : hasWarn ? '限制开仓' : '正常',
    message: hasBlock
      ? `账户层面触发冷却：${rules.join('；')}。先暂停新增实仓计划。`
      : hasWarn
        ? `账户层面触发限制：${rules.join('；')}。新计划需要降级执行。`
        : '账户状态未触发限制。'
  };
}

function formatMoney(value: any): string {
  if (value === null || value === undefined || value === '') return '--';
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(3).replace(/\.?0+$/, '') : '--';
}

function formatPercent(value: any): string {
  if (value === null || value === undefined || value === '') return '--';
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  return `${num > 0 ? '+' : ''}${(num * 100).toFixed(2)}%`;
}

function formatPlanProjectName(plan: any): string {
  return [plan.symbol, plan.name].filter(Boolean).join(' ');
}

async function ensureInvalidationTradeReviewDraft(db: any, plan: any, reason: string) {
  const autoKey = `AUTO_FINANCIAL_PLAN_INVALIDATION:${plan.id}`;
  const existing = await db.get(
    `SELECT id, title
     FROM trade_reviews
     WHERE is_deleted = 0
       AND note LIKE ?
     ORDER BY id DESC
     LIMIT 1`,
    [`%${autoKey}%`]
  );
  if (existing) {
    return { id: existing.id, title: existing.title, created: false };
  }

  const latest = await db.get(
    `SELECT trade_date, close
     FROM financial_daily_prices
     WHERE symbol = ?
       AND asset_type = ?
       AND source = ?
     ORDER BY trade_date DESC
     LIMIT 1`,
    [plan.symbol, plan.asset_type || 'stock', plan.source || 'tushare']
  );
  const planQuality = buildPlanQuality(plan);
  const latestClose = toNumber(latest?.close, toNumber(plan.close_price));
  const invalidationLine = toNumber(plan.invalidation_line);
  const breakDistance = latestClose > 0 && invalidationLine > 0 ? latestClose / invalidationLine - 1 : null;
  const now = new Date().toISOString();
  const reviewDate = now.slice(0, 10);
  const projectName = formatPlanProjectName(plan);
  const title = `${projectName} 失效/止损复盘草稿`;
  const background = [
    `来源：金融买入计划 #${plan.id}`,
    `计划日期：${plan.trade_date || '--'}`,
    `资产类型：${plan.asset_type || '--'} / 数据源：${plan.source || '--'}`,
    `计划价：${formatMoney(plan.close_price)}，失效线：${formatMoney(plan.invalidation_line)}，最大允许亏损：${formatPercent(plan.max_loss_percent)}`,
    `最新收盘：${formatMoney(latestClose)}${latest?.trade_date ? `（${latest.trade_date}）` : ''}，相对失效线：${formatPercent(breakDistance)}`,
    `走势：${plan.trend_phase_code || '--'}，结构分：${plan.structure_score ?? '--'}，触发分：${plan.trigger_score ?? '--'}，计划质量：${planQuality.label} ${planQuality.score}`
  ].join('\n');
  const judgment = [
    plan.trigger_reason ? `触发原因：${plan.trigger_reason}` : '',
    plan.entry_reason ? `入场理由：${plan.entry_reason}` : '',
    plan.suggested_entry_zone ? `建议入场区：${plan.suggested_entry_zone}` : '',
    `原计划纪律：跌破失效线后先处理止损/退出，不用后验行情倒推当时决策。`
  ].filter(Boolean).join('\n');
  const laterOutcome = [
    reason,
    `系统已将计划标记为失效/止损，并生成这条交易复盘草稿。`,
    `需要人工补充：当时信息是否充分、计划分数是否可靠、触发分/结构分是否需要调权、执行是否一致。`
  ].join('\n');
  const note = [
    autoKey,
    `source=financial_trade_plan`,
    `plan_id=${plan.id}`,
    `generated_at=${now}`
  ].join('\n');

  const result = await db.run(
    `INSERT INTO trade_reviews (
      title, track, project_name, review_date, result_type, summary_conclusion,
      background, judgment_at_that_time, action_at_that_time, later_outcome,
      root_cause_type, exposed_problem, extracted_lesson, short_lesson,
      note, is_deleted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      title,
      '金融专项',
      projectName,
      reviewDate,
      '失效/止损',
      '自动草稿：计划触发失效/止损，等待人工复盘补充结论。',
      background,
      judgment,
      '按计划纪律确认失效/止损，优先处理风险，不在失效线下方新增。',
      laterOutcome,
      '待复盘',
      '待补充：区分计划本身质量、市场环境变化、触发偏弱、结构误判或执行偏差。',
      '待补充：复盘后决定是否调整触发分、结构分、失效线或计划质量评分。',
      '待补充',
      note,
      0,
      now,
      now
    ]
  );

  return { id: result.lastID, title, created: true };
}

function getFailureFollowupStatusForPlan(sampleType: string, plan: any) {
  if (sampleType === 'plan_invalidated') return 'invalidated';
  if (sampleType === 'false_breakout' || sampleType === 'chased_high') return 'needs_review';
  if (sampleType === 'plan_negative_20d') return 'failed';
  return Number(plan.perf_20d || 0) < 0 ? 'failed' : 'tracking';
}

async function syncFailureSamplesForTradePlan(db: any, plan: any) {
  await ensureFinanceFailureSamplesSchema(db);
  const samples: Array<{ type: string; reason: string }> = [];
  if (String(plan.status || '') === 'invalidated' || Number(plan.stopped_out || 0) === 1) {
    samples.push({ type: 'plan_invalidated', reason: '计划跌破失效线或已确认失效，沉淀为失败样本。' });
  }
  if (Number(plan.false_breakout || 0) === 1) {
    samples.push({ type: 'false_breakout', reason: '计划反馈标记为假突破。' });
  }
  if (Number(plan.chased_high || 0) === 1) {
    samples.push({ type: 'chased_high', reason: '计划反馈标记为追高失败。' });
  }
  if (plan.perf_20d !== null && plan.perf_20d !== undefined && Number(plan.perf_20d) < 0) {
    samples.push({ type: 'plan_negative_20d', reason: '进入计划后20个交易日仍为负收益。' });
  }
  if (!samples.length) return { processed: 0, items: [] };

  const planQuality = buildPlanQuality(plan);
  const synced: Array<{ sample_type: string; followup_status: string }> = [];
  for (const sample of samples) {
    const followupStatus = getFailureFollowupStatusForPlan(sample.type, plan);
    await db.run(
      `INSERT INTO finance_failure_samples
        (source_type, source_id, sample_type, symbol, name, asset_type, source, trade_date, status, reason,
         score_json, context_json, outcome_json, followup_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(source_type, source_id, sample_type) DO UPDATE SET
         symbol = excluded.symbol,
         name = excluded.name,
         asset_type = excluded.asset_type,
         source = excluded.source,
         trade_date = excluded.trade_date,
         status = excluded.status,
         reason = excluded.reason,
         score_json = excluded.score_json,
         context_json = excluded.context_json,
         outcome_json = excluded.outcome_json,
         followup_status = excluded.followup_status,
         updated_at = CURRENT_TIMESTAMP`,
      [
        'trade_plan',
        plan.id,
        sample.type,
        plan.symbol,
        plan.name || '',
        plan.asset_type || 'stock',
        plan.source || 'tushare',
        plan.trade_date || null,
        plan.status || null,
        sample.reason,
        JSON.stringify({
          structureScore: plan.structure_score ?? null,
          triggerScore: plan.trigger_score ?? null,
          planQualityScore: planQuality.score,
          modelProbability: plan.model_probability ?? null
        }),
        JSON.stringify({
          planId: plan.id,
          planName: plan.plan_name,
          trendPhase: plan.trend_phase_code || null,
          invalidationLine: plan.invalidation_line ?? null,
          maxLossPercent: plan.max_loss_percent ?? null,
          entryPrice: plan.close_price ?? null,
          triggerType: plan.trigger_type || null,
          triggerReason: plan.trigger_reason || '',
          feedbackNote: plan.feedback_note || ''
        }),
        JSON.stringify({
          perf5: plan.perf_5d ?? null,
          perf10: plan.perf_10d ?? null,
          perf20: plan.perf_20d ?? null,
          perf60: plan.perf_60d ?? null,
          stoppedOut: Number(plan.stopped_out || 0) === 1,
          falseBreakout: Number(plan.false_breakout || 0) === 1,
          chasedHigh: Number(plan.chased_high || 0) === 1
        }),
        followupStatus
      ]
    );
    synced.push({ sample_type: sample.type, followup_status: followupStatus });
  }

  return { processed: synced.length, items: synced };
}

async function buildInvalidationControl(
  db: any,
  symbol: string,
  source: string,
  invalidationLine: number,
  fallbackClose: number,
  assetType = 'stock',
  planProfileKey?: string | null
) {
  const fallbackProfile = assetType === 'stock' ? 'stock_equity' : assetType === 'etf' ? 'etf_broad_equity' : 'stock_equity';
  const profile = getFinancePlanProfileConfig(planProfileKey || fallbackProfile);
  const rows = await db.all(
    `SELECT trade_date, close, amount, volume
     FROM financial_daily_prices
     WHERE symbol = ? AND asset_type = ? AND source = ?
     ORDER BY trade_date DESC
     LIMIT 25`,
    [symbol, assetType || 'stock', source || 'tushare']
  );
  const latest = rows[0] || null;
  const close = toNumber(latest?.close, fallbackClose);
  const line = toNumber(invalidationLine);
  const distance = close > 0 && line > 0 ? (close - line) / close : null;
  const priorRows = rows.slice(1, 21);
  const latestAmount = toNumber(latest?.amount);
  const latestVolume = toNumber(latest?.volume);
  const amountAvg = priorRows.length
    ? priorRows.reduce((sum: number, row: any) => sum + toNumber(row.amount), 0) / priorRows.length
    : 0;
  const volumeAvg = priorRows.length
    ? priorRows.reduce((sum: number, row: any) => sum + toNumber(row.volume), 0) / priorRows.length
    : 0;
  const amountRatio = amountAvg > 0 && latestAmount > 0 ? latestAmount / amountAvg : null;
  const volumeRatio = volumeAvg > 0 && latestVolume > 0 ? latestVolume / volumeAvg : null;
  const heavyBreak = close > 0 && line > 0 && close < line && ((amountRatio !== null && amountRatio >= profile.heavyBreakVolumeRatio) || (volumeRatio !== null && volumeRatio >= profile.heavyBreakVolumeRatio));
  const consecutiveBreak = rows.length >= 2 && rows.slice(0, 2).every((row: any) => toNumber(row.close) > 0 && line > 0 && toNumber(row.close) < line);
  const deepBreak = close > 0 && line > 0 && close < line * (1 - profile.deepBreakPercent);
  const latestBelow = close > 0 && line > 0 && close < line;
  const recoveringCooldown = close > 0 && line > 0 && close >= line && rows.slice(1, 3).some((row: any) => toNumber(row.close) > 0 && toNumber(row.close) < line);

  let status = 'SAFE';
  let label = '正常';
  let reason = '价格仍在失效线之上，按原计划观察。';

  if (!close || !line) {
    status = 'UNKNOWN';
    label = '失效线不足';
    reason = '缺少有效价格或失效线，暂不触发失效判断。';
  } else if (latestBelow && (consecutiveBreak || heavyBreak || deepBreak)) {
    status = 'CONFIRMED_BREAK';
    label = '确认失效';
    reason = consecutiveBreak
      ? '连续2个交易日收盘跌破失效线，按确认失效处理。'
      : heavyBreak
        ? '收盘跌破失效线且成交放大，按确认失效处理。'
        : '收盘明显跌破失效线超过1%，按确认失效处理。';
  } else if (latestBelow) {
    status = 'LIGHT_BREAK';
    label = '轻微跌破';
    reason = '收盘轻微跌破失效线，但尚未连续确认或放量破位，先处理机动风险。';
  } else if (recoveringCooldown) {
    status = 'RECOVERING_COOLDOWN';
    label = '收回冷静期';
    reason = '刚从失效线下方收回，至少观察1-2天重新站稳，不立刻买回或加仓。';
  } else if (distance !== null && distance >= 0 && distance <= profile.battleZonePercent) {
    status = 'BATTLE_ZONE';
    label = '失效线争夺区';
    reason = `收盘价距离${profile.label}失效线不足${(profile.battleZonePercent * 100).toFixed(1)}%，不加仓，等待方向确认。`;
  }

  return {
    status,
    label,
    reason,
    close_price: close || null,
    invalidation_line: line || null,
    distance_percent: distance,
    latest_trade_date: latest?.trade_date || null,
    consecutive_break: consecutiveBreak,
    heavy_break: heavyBreak,
    amount_ratio: amountRatio,
    volume_ratio: volumeRatio,
    no_add: ['BATTLE_ZONE', 'LIGHT_BREAK', 'CONFIRMED_BREAK', 'RECOVERING_COOLDOWN'].includes(status),
    confirmed_break: status === 'CONFIRMED_BREAK'
  };
}

async function getPositionAmounts(db: any, planId: number) {
  const rows = await db.all(
    `SELECT sleeve_type,
            SUM(CASE
              WHEN action_type IN ('buy', 'add') THEN execution_amount
              WHEN action_type IN ('sell', 'reduce', 'stop_loss', 'exit') THEN -execution_amount
              ELSE 0
            END) as amount
     FROM financial_trade_executions
     WHERE plan_id = ?
     GROUP BY sleeve_type`,
    [planId]
  );
  const result = { base: 0, tactical: 0, observation: 0, total: 0 };
  rows.forEach((row: any) => {
    const amount = Math.max(0, toNumber(row.amount));
    if (row.sleeve_type === 'base') result.base = amount;
    if (row.sleeve_type === 'tactical') result.tactical = amount;
    if (row.sleeve_type === 'observation') result.observation = amount;
  });
  result.total = result.base + result.tactical + result.observation;
  return result;
}

type PositionAmounts = Awaited<ReturnType<typeof getPositionAmounts>>;

const BUY_EXECUTION_ACTIONS = new Set(['buy', 'add']);
const SELL_EXECUTION_ACTIONS = new Set(['sell', 'reduce', 'stop_loss', 'exit']);
const EXECUTION_BLOCKED_STATUSES = new Set(['closed', 'cancelled', 'archived']);
const POSITION_EPSILON = 0.01;
const SLEEVE_LABELS: Record<string, string> = {
  base: '底仓',
  tactical: '机动仓',
  observation: '观察仓'
};

function getSleeveTargetAmount(plan: any, sleeveType: string) {
  if (sleeveType === 'base') return toNumber(plan.base_amount);
  if (sleeveType === 'tactical') return toNumber(plan.tactical_amount);
  if (sleeveType === 'observation') return toNumber(plan.observation_amount);
  return 0;
}

function getSleeveCurrentAmount(positions: PositionAmounts, sleeveType: string) {
  if (sleeveType === 'base') return positions.base;
  if (sleeveType === 'tactical') return positions.tactical;
  if (sleeveType === 'observation') return positions.observation;
  return 0;
}

function formatExecutionAmount(value: number) {
  return roundMoney(Math.max(0, value)).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function validateTradeExecution(
  plan: any,
  positions: PositionAmounts,
  actionType: string,
  sleeveType: string,
  executionAmount: number
) {
  const status = String(plan.status || '').trim();
  const sleeveLabel = SLEEVE_LABELS[sleeveType] || sleeveType;
  if (EXECUTION_BLOCKED_STATUSES.has(status)) {
    return {
      statusCode: 409,
      message: `计划已是“${status === 'closed' ? '已结束' : status}”状态，不能继续新增执行记录。`
    };
  }

  if (BUY_EXECUTION_ACTIONS.has(actionType)) {
    if (status === 'invalidated' || Number(plan.stopped_out || 0) === 1) {
      return {
        statusCode: 409,
        message: '计划已失效或已触发止损，只能记录减仓、止损或退出，不能继续建仓/加仓。'
      };
    }
    if (sleeveType === 'tactical' && positions.base <= POSITION_EPSILON) {
      return {
        statusCode: 409,
        message: '底仓还没有站位，不能先记录机动仓加仓。'
      };
    }
    if (sleeveType === 'observation' && (positions.base <= POSITION_EPSILON || positions.tactical <= POSITION_EPSILON)) {
      return {
        statusCode: 409,
        message: '底仓和机动仓没有完成前，观察仓保持预留，不能先记录观察仓买入。'
      };
    }

    const targetAmount = getSleeveTargetAmount(plan, sleeveType);
    const currentAmount = getSleeveCurrentAmount(positions, sleeveType);
    const remainingAmount = roundMoney(Math.max(0, targetAmount - currentAmount));
    if (targetAmount <= POSITION_EPSILON) {
      return {
        statusCode: 409,
        message: `${sleeveLabel}目标金额为 0，不能记录买入/加仓。`
      };
    }
    if (executionAmount - remainingAmount > POSITION_EPSILON) {
      return {
        statusCode: 409,
        message: `${sleeveLabel}剩余额度为 ${formatExecutionAmount(remainingAmount)}，本次金额 ${formatExecutionAmount(executionAmount)} 超出计划额度。`
      };
    }
  }

  if (SELL_EXECUTION_ACTIONS.has(actionType)) {
    const currentAmount = getSleeveCurrentAmount(positions, sleeveType);
    if (currentAmount <= POSITION_EPSILON) {
      return {
        statusCode: 409,
        message: `${sleeveLabel}当前没有可卖出/减仓的持有金额。`
      };
    }
    if (executionAmount - currentAmount > POSITION_EPSILON) {
      return {
        statusCode: 409,
        message: `${sleeveLabel}当前持有 ${formatExecutionAmount(currentAmount)}，本次卖出/减仓金额 ${formatExecutionAmount(executionAmount)} 超过可用持仓。`
      };
    }
  }

  return null;
}

async function syncTradePlanExecutionState(db: any, plan: any) {
  const positions = await getPositionAmounts(db, plan.id);
  const firstBuy = await db.get(
    `SELECT execution_date, execution_price
     FROM financial_trade_executions
     WHERE plan_id = ?
       AND action_type IN ('buy', 'add')
       AND execution_amount > 0
       AND execution_price > 0
     ORDER BY execution_date ASC, id ASC
     LIMIT 1`,
    [plan.id]
  );
  const latestExecution = await db.get(
    `SELECT action_type
     FROM financial_trade_executions
     WHERE plan_id = ?
     ORDER BY execution_date DESC, id DESC
     LIMIT 1`,
    [plan.id]
  );
  const now = new Date().toISOString();
  if (positions.total > 0) {
    await db.run(
      `UPDATE financial_trade_plans
       SET is_bought = 1,
           status = CASE
             WHEN status IN ('draft', 'watching', 'paper_tracking') THEN 'active'
             ELSE status
           END,
           buy_date = COALESCE(buy_date, ?),
           buy_price = COALESCE(buy_price, ?),
           buy_amount = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        firstBuy?.execution_date || null,
        firstBuy?.execution_price || null,
        positions.total,
        now,
        plan.id
      ]
    );
    return { positions, changed: true };
  }

  if (Number(plan.is_bought || 0) === 1 || Number(plan.buy_amount || 0) > 0) {
    await db.run(
      `UPDATE financial_trade_plans
       SET is_bought = 0,
           status = CASE
             WHEN status = 'active' AND ? = 1 THEN 'closed'
             ELSE status
           END,
           buy_amount = 0,
           updated_at = ?
       WHERE id = ?`,
      [
        SELL_EXECUTION_ACTIONS.has(String(latestExecution?.action_type || '')) ? 1 : 0,
        now,
        plan.id
      ]
    );
    return { positions, changed: true };
  }

  return { positions, changed: false };
}

async function getPositionLedger(db: any, plan: any) {
  const executions = await db.all(
    `SELECT *
     FROM financial_trade_executions
     WHERE plan_id = ?
     ORDER BY execution_date ASC, id ASC`,
    [plan.id]
  );
  const latest = await db.get(
    `SELECT trade_date, close
     FROM financial_daily_prices
     WHERE symbol = ?
       AND asset_type = ?
       AND source = ?
     ORDER BY trade_date DESC
     LIMIT 1`,
    [plan.symbol, plan.asset_type || 'stock', plan.source || 'tushare']
  );
  const latestClose = toNumber(latest?.close, toNumber(plan.close_price));
  const sleeves: Record<string, {
    quantity: number;
    cost: number;
    buy_amount: number;
    sell_amount: number;
    realized_pnl: number;
  }> = {
    base: { quantity: 0, cost: 0, buy_amount: 0, sell_amount: 0, realized_pnl: 0 },
    tactical: { quantity: 0, cost: 0, buy_amount: 0, sell_amount: 0, realized_pnl: 0 },
    observation: { quantity: 0, cost: 0, buy_amount: 0, sell_amount: 0, realized_pnl: 0 }
  };

  executions.forEach((execution: any) => {
    const sleeveKey = ['base', 'tactical', 'observation'].includes(execution.sleeve_type)
      ? execution.sleeve_type
      : 'base';
    const sleeve = sleeves[sleeveKey];
    const amount = toNumber(execution.execution_amount);
    const price = toNumber(execution.execution_price);
    const quantity = toNumber(execution.execution_quantity, price > 0 ? amount / price : 0);
    if (amount <= 0 || quantity <= 0) return;

    if (['buy', 'add'].includes(execution.action_type)) {
      sleeve.quantity += quantity;
      sleeve.cost += amount;
      sleeve.buy_amount += amount;
      return;
    }

    if (['sell', 'reduce', 'stop_loss', 'exit'].includes(execution.action_type)) {
      const sellQuantity = Math.min(quantity, sleeve.quantity);
      const averageCost = sleeve.quantity > 0 ? sleeve.cost / sleeve.quantity : 0;
      const relievedCost = Math.min(sleeve.cost, averageCost * sellQuantity);
      sleeve.quantity = Math.max(0, sleeve.quantity - sellQuantity);
      sleeve.cost = Math.max(0, sleeve.cost - relievedCost);
      sleeve.sell_amount += amount;
      sleeve.realized_pnl += amount - relievedCost;
    }
  });

  const buildSleeve = (key: 'base' | 'tactical' | 'observation') => {
    const sleeve = sleeves[key];
    const marketValue = latestClose > 0 ? sleeve.quantity * latestClose : 0;
    const unrealizedPnl = marketValue - sleeve.cost;
    return {
      quantity: Math.round(sleeve.quantity * 10000) / 10000,
      cost: roundMoney(sleeve.cost),
      buy_amount: roundMoney(sleeve.buy_amount),
      sell_amount: roundMoney(sleeve.sell_amount),
      realized_pnl: roundMoney(sleeve.realized_pnl),
      market_value: roundMoney(marketValue),
      unrealized_pnl: roundMoney(unrealizedPnl),
      unrealized_rate: sleeve.cost > 0 ? unrealizedPnl / sleeve.cost : null
    };
  };

  const bySleeve = {
    base: buildSleeve('base'),
    tactical: buildSleeve('tactical'),
    observation: buildSleeve('observation')
  };
  const totalCost = bySleeve.base.cost + bySleeve.tactical.cost + bySleeve.observation.cost;
  const totalBuyAmount = bySleeve.base.buy_amount + bySleeve.tactical.buy_amount + bySleeve.observation.buy_amount;
  const totalMarketValue = bySleeve.base.market_value + bySleeve.tactical.market_value + bySleeve.observation.market_value;
  const totalRealizedPnl = bySleeve.base.realized_pnl + bySleeve.tactical.realized_pnl + bySleeve.observation.realized_pnl;
  const totalUnrealizedPnl = totalMarketValue - totalCost;

  return {
    latest_close: latestClose || null,
    latest_trade_date: latest?.trade_date || null,
    total_quantity: Math.round((bySleeve.base.quantity + bySleeve.tactical.quantity + bySleeve.observation.quantity) * 10000) / 10000,
    total_cost: roundMoney(totalCost),
    total_buy_amount: roundMoney(totalBuyAmount),
    market_value: roundMoney(totalMarketValue),
    realized_pnl: roundMoney(totalRealizedPnl),
    unrealized_pnl: roundMoney(totalUnrealizedPnl),
    total_pnl: roundMoney(totalRealizedPnl + totalUnrealizedPnl),
    unrealized_rate: totalCost > 0 ? totalUnrealizedPnl / totalCost : null,
    total_return_rate: totalBuyAmount > 0 ? (totalRealizedPnl + totalUnrealizedPnl) / totalBuyAmount : null,
    sleeves: bySleeve
  };
}

async function getSuggestionFromSnapshot(db: any, snapshot: any, positions: { base: number; tactical: number; observation: number; total: number }) {
  const structureScore = toNumber(snapshot.structure_score?.score);
  const trendPhase = snapshot.trend_phase_code || 'UNKNOWN';
  const entryAction = snapshot.action || 'OBSERVE';
  const close = toNumber(snapshot.close);
  const invalidationLine = toNumber(snapshot.invalidation_line);
  const invalidationControl = await buildInvalidationControl(
    db,
    snapshot.symbol,
    snapshot.data_source_used || snapshot.source || 'tushare',
    invalidationLine,
    close,
    snapshot.asset_type || 'stock',
    snapshot.plan_profile
  );
  const hasBase = positions.base > 0;
  const hasTactical = positions.tactical > 0;

  if (invalidationControl.status === 'CONFIRMED_BREAK' || entryAction === 'INVALIDATED') {
    return {
      action_code: hasBase ? 'EXIT_BASE' : hasTactical ? 'STOP_LOSS_TACTICAL' : 'NO_ADD',
      action_label: hasBase ? '底仓退出' : hasTactical ? '机动仓止损' : '禁止新增',
      action_reason: `${invalidationControl.reason} 优先执行退出纪律。`,
      priority: 'high',
      invalidation_control: invalidationControl
    };
  }

  if (invalidationControl.status === 'LIGHT_BREAK') {
    return {
      action_code: hasTactical ? 'STOP_LOSS_TACTICAL' : 'NO_ADD',
      action_label: hasTactical ? '机动仓先处理' : '失效线下方观察',
      action_reason: hasTactical
        ? `${invalidationControl.reason} 底仓先进入退出观察，机动仓优先处理。`
        : `${invalidationControl.reason} 暂不新增仓位，底仓先进入退出观察。`,
      priority: 'high',
      invalidation_control: invalidationControl
    };
  }

  if (invalidationControl.status === 'BATTLE_ZONE' || invalidationControl.status === 'RECOVERING_COOLDOWN') {
    return {
      action_code: 'NO_ADD',
      action_label: invalidationControl.status === 'BATTLE_ZONE' ? '失效线争夺' : '收回冷静',
      action_reason: invalidationControl.reason,
      priority: 'normal',
      invalidation_control: invalidationControl
    };
  }

  if (['CRASH_DROP', 'SLOW_BLEED', 'REBOUND'].includes(trendPhase)) {
    return {
      action_code: hasBase ? 'BASE_EXIT_WATCH' : 'NO_ADD',
      action_label: hasBase ? '底仓退出观察' : '禁止加仓',
      action_reason: `${trendPhase} 阶段风险偏高，不新增仓位；已有底仓进入退出观察。`,
      priority: 'high',
      invalidation_control: invalidationControl
    };
  }

  if (trendPhase === 'SURGE' || snapshot.metrics?.not_chasing === false) {
    return {
      action_code: hasTactical ? 'REDUCE_TACTICAL_WATCH' : 'NO_ADD',
      action_label: hasTactical ? '机动仓减仓观察' : '禁止追高',
      action_reason: '急涨或偏离过远阶段，不追高；已有机动仓优先观察是否减仓。',
      priority: 'normal',
      invalidation_control: invalidationControl
    };
  }

  if (entryAction === 'READY_TO_PLAN' && positions.tactical <= 0 && hasBase) {
    return {
      action_code: 'TACTICAL_CAN_ENTER',
      action_label: '机动仓可执行',
      action_reason: '入场触发仍成立，且已有底仓站位，可考虑执行机动仓。',
      priority: 'high',
      invalidation_control: invalidationControl
    };
  }

  if (entryAction === 'READY_TO_PLAN' && positions.total <= 0) {
    return {
      action_code: 'BASE_CAN_ENTER',
      action_label: '底仓可执行',
      action_reason: '入场触发成立，尚无持仓，可先执行底仓。',
      priority: 'high',
      invalidation_control: invalidationControl
    };
  }

  if (trendPhase === 'SLOW_GRIND_UP' && structureScore >= 70 && hasBase) {
    return {
      action_code: hasTactical ? 'HOLD_BASE_AND_TACTICAL' : 'HOLD_BASE',
      action_label: hasTactical ? '底仓与机动仓继续持有' : '底仓继续持有',
      action_reason: hasTactical
        ? '慢涨阶段且结构分仍可用，底仓按结构持有，机动仓继续按短线防守和止损规则管理。'
        : '慢涨阶段且结构分仍可用，底仓按结构持有，不做短期兑现。',
      priority: 'normal',
      invalidation_control: invalidationControl
    };
  }

  return {
    action_code: 'WATCH',
    action_label: '继续观察',
    action_reason: snapshot.trigger_reason || '当前未出现明确执行动作，继续跟踪结构和触发条件。',
    priority: 'normal',
    invalidation_control: invalidationControl
  };
}

async function saveActionSuggestion(
  db: any,
  plan: any,
  snapshot: any,
  suggestion: any,
  positions: { base: number; tactical: number; observation: number; total: number }
) {
  const now = new Date().toISOString();
  const suggestionDay = now.slice(0, 10);
  const existing = await db.get(
    `SELECT id
     FROM financial_action_suggestions
     WHERE plan_id = ?
       AND substr(suggestion_date, 1, 10) = ?
       AND action_code = ?
     ORDER BY id DESC
     LIMIT 1`,
    [plan.id, suggestionDay, suggestion.action_code]
  );

  if (existing?.id) {
    await db.run(
      `UPDATE financial_action_suggestions
       SET trade_date = ?,
           suggestion_date = ?,
           action_label = ?,
           action_reason = ?,
           priority = ?,
           structure_score = ?,
           trend_phase_code = ?,
           trigger_score = ?,
           entry_action = ?,
           close_price = ?,
           invalidation_line = ?,
           base_position_amount = ?,
           tactical_position_amount = ?,
           observation_position_amount = ?,
           suggestion_snapshot_json = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        snapshot.trade_date || null,
        now,
        suggestion.action_label,
        suggestion.action_reason,
        suggestion.priority,
        toNumber(snapshot.structure_score?.score),
        snapshot.trend_phase_code || '',
        toNumber(snapshot.trigger_score),
        snapshot.action || '',
        snapshot.close || null,
        snapshot.invalidation_line || null,
        positions.base,
        positions.tactical,
        positions.observation,
        JSON.stringify({ snapshot, invalidation_control: suggestion.invalidation_control || null }),
        now,
        existing.id
      ]
    );
    return { id: existing.id, mode: 'updated' };
  }

  const insert = await db.run(
    `INSERT INTO financial_action_suggestions (
      plan_id, symbol, trade_date, suggestion_date, action_code, action_label, action_reason,
      priority, structure_score, trend_phase_code, trigger_score, entry_action, close_price,
      invalidation_line, base_position_amount, tactical_position_amount, observation_position_amount,
      suggestion_snapshot_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      plan.id,
      plan.symbol,
      snapshot.trade_date || null,
      now,
      suggestion.action_code,
      suggestion.action_label,
      suggestion.action_reason,
      suggestion.priority,
      toNumber(snapshot.structure_score?.score),
      snapshot.trend_phase_code || '',
      toNumber(snapshot.trigger_score),
      snapshot.action || '',
      snapshot.close || null,
      snapshot.invalidation_line || null,
      positions.base,
      positions.tactical,
      positions.observation,
      JSON.stringify({ snapshot, invalidation_control: suggestion.invalidation_control || null }),
      now,
      now
    ]
  );
  return { id: insert.lastID, mode: 'created' };
}

function getTrendLabel(value?: string) {
  switch (value) {
    case 'BREAKOUT': return '突破';
    case 'SLOW_GRIND_UP': return '慢涨';
    case 'RECOVERY': return '修复';
    case 'SURGE': return '急涨';
    case 'HIGH_BASE': return '高位横盘';
    case 'TREND_UP': return '趋势上行';
    case 'REBOUND': return '反抽';
    case 'SLOW_BLEED': return '阴跌';
    case 'CRASH_DROP': return '暴跌';
    case 'SIDEWAYS': return '横盘震荡';
    case 'CONSOLIDATION': return '震荡待确认';
    case 'TREND_TRANSITION': return '趋势转换中';
    case 'UNKNOWN': return '状态未确认';
    default: return value || '状态未确认';
  }
}

function getLatestSuggestionLike(plan: any, suggestion: any | null) {
  return {
    action_code: suggestion?.action_code || 'WATCH',
    action_label: suggestion?.action_label || '继续观察',
    action_reason: suggestion?.action_reason || plan.trigger_reason || '等待下一次行情和结构确认。',
    priority: suggestion?.priority || 'normal',
    trend_phase_code: suggestion?.trend_phase_code || plan.trend_phase_code || 'UNKNOWN',
    trigger_score: toNumber(suggestion?.trigger_score ?? plan.trigger_score),
    close_price: toNumber(suggestion?.close_price ?? plan.close_price),
    invalidation_line: toNumber(suggestion?.invalidation_line ?? plan.invalidation_line),
    structure_score: toNumber(suggestion?.structure_score ?? plan.structure_score)
  };
}

async function buildSleeveDiscipline(db: any, plan: any, positions: { base: number; tactical: number; observation: number; total: number }, suggestionRow: any | null) {
  const suggestion = getLatestSuggestionLike(plan, suggestionRow);
  const actionCode = suggestion.action_code;
  const trendPhase = suggestion.trend_phase_code;
  const close = suggestion.close_price;
  const invalidationLine = suggestion.invalidation_line;
  const invalidationControl = await buildInvalidationControl(
    db,
    plan.symbol,
    plan.source || 'tushare',
    invalidationLine,
    close,
    plan.asset_type || 'stock',
    plan.plan_profile
  );
  const isInvalidated = actionCode === 'EXIT_BASE'
    || invalidationControl.status === 'CONFIRMED_BREAK';
  const isNoAdd = ['NO_ADD', 'BASE_EXIT_WATCH', 'REDUCE_TACTICAL_WATCH', 'STOP_LOSS_TACTICAL'].includes(actionCode)
    || invalidationControl.no_add;
  const isChasingRisk = actionCode === 'NO_ADD' || String(suggestion.action_label || '').includes('追高');
  const baseRemaining = Math.max(0, toNumber(plan.base_amount) - positions.base);
  const tacticalRemaining = Math.max(0, toNumber(plan.tactical_amount) - positions.tactical);
  const observationRemaining = Math.max(0, toNumber(plan.observation_amount) - positions.observation);

  const baseBuyTriggered = actionCode === 'BASE_CAN_ENTER' && positions.base <= 0 && !isInvalidated && !isNoAdd;
  const tacticalBuyTriggered = actionCode === 'TACTICAL_CAN_ENTER' && positions.base > 0 && positions.tactical <= 0 && !isInvalidated && !isNoAdd;
  const observationBuyTriggered = ['BREAKOUT', 'SLOW_GRIND_UP'].includes(trendPhase)
    && positions.base > 0
    && positions.tactical > 0
    && positions.observation <= 0
    && !isInvalidated
    && !isChasingRisk
    && suggestion.structure_score >= 75;

  const baseSellTriggered = actionCode === 'EXIT_BASE' || (isInvalidated && positions.base > 0) || (actionCode === 'BASE_EXIT_WATCH' && positions.base > 0);
  const tacticalSellTriggered = actionCode === 'STOP_LOSS_TACTICAL'
    || actionCode === 'REDUCE_TACTICAL_WATCH'
    || (isInvalidated && positions.tactical > 0);
  const observationSellTriggered = positions.observation > 0
    && (isInvalidated || actionCode === 'NO_ADD' || actionCode === 'REDUCE_TACTICAL_WATCH' || actionCode === 'STOP_LOSS_TACTICAL' || ['SURGE', 'SLOW_BLEED', 'CRASH_DROP'].includes(trendPhase));

  const baseHoldReason = positions.base > 0
    ? '底仓已经站位，除非结构破坏、跌破失效线或市场进入冻结风险，否则不做短期兑现。'
    : '底仓还没买，只有入场触发成立且不追高时才允许第一笔。';
  const tacticalHoldReason = positions.tactical > 0
    ? '机动仓已执行，后续按短线防守、止损和急涨滞涨规则管理。'
    : '机动仓等底仓站稳后，再看回踩不破、重新站上短线或突破不跌回。';
  const observationHoldReason = positions.observation > 0
    ? '观察仓已经动用，风险优先级高于收益幻想。'
    : '观察仓默认是预留资金，不出现二次确认或主升强化就不动。';

  const rules = [
    {
      sleeve_type: 'base',
      sleeve_label: '底仓',
      role: '站位仓',
      target_amount: toNumber(plan.base_amount),
      current_amount: positions.base,
      remaining_amount: baseRemaining,
      buy_condition: '入场触发成立、结构未失效、不是追高状态，且不在失效线争夺/冷静期时，允许第一笔底仓。',
      buy_triggered: baseBuyTriggered,
      buy_action_type: 'buy',
      sell_condition: '连续2日收盘跌破失效线、放量跌破、明显破位、结构破坏或市场风险冻结，底仓才退出。',
      sell_triggered: baseSellTriggered,
      sell_action_type: actionCode === 'BASE_EXIT_WATCH' ? 'sell' : 'exit',
      next_action_label: baseSellTriggered ? '底仓退出/退出观察' : baseBuyTriggered ? '可记录底仓建仓' : '底仓不动',
      next_action_reason: baseSellTriggered ? suggestion.action_reason : baseBuyTriggered ? suggestion.action_reason : baseHoldReason,
      lock_reason: isInvalidated ? '结构或失效线已经确认失效，禁止新增底仓。' : isNoAdd ? `${invalidationControl.label}：当前规则禁止新增仓位。` : ''
    },
    {
      sleeve_type: 'tactical',
      sleeve_label: '机动仓',
      role: '执行仓',
      target_amount: toNumber(plan.tactical_amount),
      current_amount: positions.tactical,
      remaining_amount: tacticalRemaining,
      buy_condition: '底仓已有、入场触发仍成立，且回踩不破/重新站上短线/突破不跌回时再执行。',
      buy_triggered: tacticalBuyTriggered,
      buy_action_type: 'add',
      sell_condition: '轻微跌破失效线、急涨后滞涨、跌破短线防守位或结构失效时优先减掉。',
      sell_triggered: tacticalSellTriggered,
      sell_action_type: actionCode === 'STOP_LOSS_TACTICAL' ? 'stop_loss' : 'reduce',
      next_action_label: tacticalSellTriggered ? '机动仓减仓/止损' : tacticalBuyTriggered ? '可记录机动仓加仓' : '机动仓等待',
      next_action_reason: tacticalSellTriggered ? suggestion.action_reason : tacticalBuyTriggered ? suggestion.action_reason : tacticalHoldReason,
      lock_reason: positions.base <= 0 ? '底仓还没站位，机动仓不能先动。' : isInvalidated ? '结构或失效线已经确认失效，禁止新增机动仓。' : isNoAdd ? `${invalidationControl.label}：当前规则禁止加仓。` : ''
    },
    {
      sleeve_type: 'observation',
      sleeve_label: '观察仓',
      role: '预留仓',
      target_amount: toNumber(plan.observation_amount),
      current_amount: positions.observation,
      remaining_amount: observationRemaining,
      buy_condition: '只有底仓和机动仓都成立、走势进入主升强化且仍不追高时，才考虑动用。',
      buy_triggered: observationBuyTriggered,
      buy_action_type: 'add',
      sell_condition: '观察仓一旦动用，遇到失效、急涨滞涨或市场走弱，优先回收。',
      sell_triggered: observationSellTriggered,
      sell_action_type: isInvalidated ? 'stop_loss' : 'reduce',
      next_action_label: observationSellTriggered ? '观察仓回收' : observationBuyTriggered ? '可考虑观察仓补充' : '观察仓保留',
      next_action_reason: observationSellTriggered ? suggestion.action_reason : observationBuyTriggered ? '主升强化且三层条件满足，可考虑动用观察仓。' : observationHoldReason,
      lock_reason: positions.base <= 0 || positions.tactical <= 0 ? '底仓和机动仓没有完成前，观察仓保持预留。' : isNoAdd ? `${invalidationControl.label}：观察仓先保留或回收。` : isChasingRisk ? '追高或急涨状态，不动用观察仓。' : ''
    }
  ];

  let overall_label = '继续趴着';
  let overall_reason = '当前没有必须执行的动作，按计划继续观察。';
  if (isInvalidated) {
    overall_label = '先处理失效/止损';
    overall_reason = suggestion.action_reason;
  } else if (rules.some(rule => rule.sell_triggered)) {
    overall_label = '有卖出/减仓触发';
    overall_reason = rules.find(rule => rule.sell_triggered)?.next_action_reason || suggestion.action_reason;
  } else if (rules.some(rule => rule.buy_triggered)) {
    overall_label = '有买入/加仓触发';
    overall_reason = rules.find(rule => rule.buy_triggered)?.next_action_reason || suggestion.action_reason;
  } else if (isNoAdd) {
    overall_label = '禁止新增仓位';
    overall_reason = suggestion.action_reason;
  }

  return {
    guard: {
      overall_label,
      overall_reason,
      trend_phase_label: getTrendLabel(trendPhase),
      can_record_buy: rules.some(rule => rule.buy_triggered),
      can_record_sell: rules.some(rule => rule.sell_triggered),
      no_add: isNoAdd || isChasingRisk,
      invalidated: isInvalidated,
      just_hold: overall_label === '继续趴着',
      close_price: invalidationControl.close_price || close || null,
      invalidation_line: invalidationControl.invalidation_line || invalidationLine || null,
      invalidation_control: invalidationControl,
      latest_action_code: actionCode,
      latest_action_label: suggestion.action_label,
      latest_action_reason: suggestion.action_reason
    },
    positions: {
      base: { target: toNumber(plan.base_amount), current: positions.base, remaining: baseRemaining, ratio: toNumber(plan.base_ratio) },
      tactical: { target: toNumber(plan.tactical_amount), current: positions.tactical, remaining: tacticalRemaining, ratio: toNumber(plan.tactical_ratio) },
      observation: { target: toNumber(plan.observation_amount), current: positions.observation, remaining: observationRemaining, ratio: toNumber(plan.observation_ratio) },
      total_current: positions.total,
      total_target: toNumber(plan.total_capital)
    },
    sleeve_rules: rules
  };
}

async function getEntryTriggerSnapshot(req: Request | { body: any; protocol?: string; get?: (name: string) => string | undefined }) {
  const host = typeof req.get === 'function'
    ? req.get('host')
    : `127.0.0.1:${process.env.PORT || 3001}`;
  const baseUrl = `${req.protocol || 'http'}://${host}`;
  const response = await fetch(`${baseUrl}/api/finance/assets/entry-trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: req.body.symbol,
      asset_type: req.body.asset_type,
      source: req.body.source || 'tushare'
    })
  });
  const data = await response.json() as { success?: boolean; data?: any; message?: string };
  if (!data.success || !data.data) {
    throw new Error(data.message || '入场触发计算失败');
  }
  return data.data;
}

router.post('/trade-plans/from-entry-trigger', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureTradePlanProfileSchema(db);
    const symbol = String(req.body.symbol || '').trim();
    const assetType = String(req.body.asset_type || '').trim();
    const source = String(req.body.source || 'tushare').trim();
    const totalCapital = Number(req.body.total_capital);
    const observationId = Number(req.body.observation_id || req.body.observationId || 0);

    if (!symbol || !['stock', 'etf', 'index'].includes(assetType)) {
      return res.status(400).json({ success: false, message: '缺少有效的 symbol 或 asset_type' });
    }
	    if (!Number.isFinite(totalCapital) || totalCapital <= 0) {
	      return res.status(400).json({ success: false, message: '总投入金额必须大于 0' });
	    }
	    if (!Number.isFinite(observationId) || observationId <= 0) {
	      return res.status(409).json({
	        success: false,
	        message: '生成金融买入计划必须从计划准备池载入确认后的入场观察记录，不能用即时手工触发结果直接生成。'
	      });
	    }
	    const targetObservation = await db.get(
	      `SELECT id, symbol, asset_type, source, observation_status
	       FROM financial_entry_trigger_observations
	       WHERE id = ?`,
	      [observationId]
	    );
	    if (!targetObservation) {
	      return res.status(404).json({ success: false, message: '入场观察记录不存在，无法生成计划。' });
	    }
	    if (
	      targetObservation.symbol !== symbol
	      || targetObservation.asset_type !== assetType
	      || targetObservation.source !== source
	    ) {
	      return res.status(400).json({ success: false, message: '入场观察记录与当前标的不一致，已阻止生成计划。' });
	    }
		    if (!['confirmed', 'plan_candidate'].includes(String(targetObservation.observation_status || ''))) {
		      return res.status(409).json({ success: false, message: '入场观察记录已不在计划准备状态，请刷新后再生成计划。' });
		    }

    const marketGateBlocker = await getTradePlanMarketGateBlocker(db, source);
    if (marketGateBlocker) {
      return res.status(423).json({
        success: false,
        message: marketGateBlocker.message,
        data: {
          market_gate: marketGateBlocker.marketGate,
          downstream_blocked: true
        }
      });
    }

    const existingPlan = await db.get(
      `SELECT id, plan_name, status, total_capital, updated_at
       FROM financial_trade_plans
       WHERE symbol = ?
         AND asset_type = ?
         AND source = ?
         AND is_deleted = 0
	         AND status IN ('draft', 'watching', 'paper_tracking', 'active')
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [symbol, assetType, source]
    );
    if (existingPlan) {
      return res.status(409).json({
        success: false,
        message: `已存在未结束的金融买入计划：${existingPlan.plan_name}（${existingPlan.status}），不要重复生成。`,
        data: { existing_plan: existingPlan }
      });
    }

    const snapshot = await getEntryTriggerSnapshot(req);
    if (snapshot.action !== 'READY_TO_PLAN') {
      return res.status(409).json({
        success: false,
        message: `入场触发未通过：${snapshot.trigger_reason || snapshot.action_label || '当前不能生成买入计划'}`
      });
    }
    const planProfile = getFinancePlanProfileConfig(snapshot.plan_profile || snapshot.plan_draft?.plan_profile || (assetType === 'stock' ? 'stock_equity' : 'etf_unknown'));
    if (!planProfile.allowsTradePlan) {
      return res.status(409).json({
        success: false,
        message: `${planProfile.label}暂不生成这套金融买入计划：${planProfile.note}`
      });
    }
    const accountRisk = await buildAccountRiskDecision(db, { assetType });
    if (accountRisk.status === 'COOLDOWN') {
      return res.status(409).json({
        success: false,
        message: accountRisk.message,
        data: { account_risk: accountRisk }
      });
    }
    const structureScore = Number(snapshot.structure_score?.score || 0);
    const maxLossPercent = snapshot.plan_draft?.max_loss_percent ?? null;
    const positionPlan = buildPositionPlan(totalCapital, snapshot.action, structureScore, maxLossPercent, planProfile.key);
    const principleSnapshot = accountRisk.status === 'NORMAL'
      ? positionPlan.principle_snapshot
      : `${positionPlan.principle_snapshot}\n账户风控：${accountRisk.label}。${accountRisk.message}`;
    const triggerSnapshot = {
      ...snapshot,
      account_risk_status: accountRisk.status,
      account_risk_label: accountRisk.label,
      account_risk_message: accountRisk.message
    };
    const now = new Date().toISOString();
    const planName = req.body.plan_name || `${snapshot.name || symbol} 入场计划 ${snapshot.trade_date || now.slice(0, 10)}`;
    const triggerTypes = (snapshot.triggered_items || [])
      .filter((item: any) => item.code !== 'NOT_CHASING_TODAY')
      .map((item: any) => item.name)
      .join(' / ') || snapshot.plan_draft?.trigger_condition || '等待触发';

    const result = await db.run(
      `INSERT INTO financial_trade_plans (
        plan_name, symbol, name, asset_type, source, trade_date, status,
        total_capital, base_amount, tactical_amount, observation_amount,
        base_ratio, tactical_ratio, observation_ratio, principle_snapshot,
        entry_action, trigger_score, trigger_type, trigger_reason,
        structure_score, structure_score_bucket, structure_level, structure_status, safe_zone_status,
        trend_phase_code, trend_action, market_regime, entry_permission,
        close_price, ma20, ma60, invalidation_line, max_loss_percent,
        suggested_entry_zone, entry_reason, trigger_snapshot_json, note,
        plan_profile, plan_profile_label, plan_profile_note,
        account_risk_status, account_risk_label, account_risk_message,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        planName,
        symbol,
        snapshot.name || symbol,
        assetType,
        source,
        snapshot.trade_date || null,
        snapshot.action === 'READY_TO_PLAN' ? 'draft' : 'watching',
        totalCapital,
        positionPlan.base_amount,
        positionPlan.tactical_amount,
        positionPlan.observation_amount,
        positionPlan.base_ratio,
        positionPlan.tactical_ratio,
        positionPlan.observation_ratio,
        principleSnapshot,
        snapshot.action,
        snapshot.trigger_score || 0,
        triggerTypes,
        snapshot.trigger_reason || '',
        structureScore,
        bucketStructureScore(structureScore),
        snapshot.structure_score?.level_label || '',
        snapshot.structure_status || '',
        snapshot.safe_zone_status || '',
        snapshot.trend_phase_code || '',
        snapshot.trend_action || '',
        snapshot.market_regime || '',
        snapshot.entry_permission || '',
        snapshot.close || null,
        snapshot.ma20 || null,
        snapshot.ma60 || null,
        snapshot.invalidation_line || null,
        maxLossPercent,
        snapshot.plan_draft?.suggested_entry_zone || '',
        snapshot.plan_draft?.entry_reason || snapshot.trigger_reason || '',
        JSON.stringify(triggerSnapshot),
        req.body.note || '',
        planProfile.key,
        planProfile.label,
        planProfile.note,
        accountRisk.status,
        accountRisk.label,
        accountRisk.message,
        now,
        now
      ]
    );

    const plan = await db.get('SELECT * FROM financial_trade_plans WHERE id = ?', [result.lastID]);
	    await db.run(
	      `UPDATE financial_entry_trigger_observations
	       SET observation_status = 'planned',
	           note = ?,
	           updated_at = ?
	       WHERE id = ?
	         AND observation_status IN ('confirmed', 'plan_candidate')`,
	      [`已生成金融买入计划 #${result.lastID}，入场观察闭环。`, now, targetObservation.id]
	    );
    if (plan) plan.plan_quality = buildPlanQuality(plan);
    res.json({ success: true, data: plan, message: '金融买入计划已生成' });
  } catch (error) {
    console.error('Error creating financial trade plan:', error);
    res.status(500).json({ success: false, message: `生成金融买入计划失败：${(error as Error).message}` });
  }
});

router.get('/trade-plans', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureTradePlanProfileSchema(db);
    const status = req.query.status as string | undefined;
    const params: any[] = [];
    let sql = 'SELECT * FROM financial_trade_plans WHERE is_deleted = 0';
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT 300';
    const items = await db.all(sql, params);
    for (const item of items) {
      item.latest_suggestion = await db.get(
        `SELECT * FROM financial_action_suggestions
         WHERE plan_id = ?
         ORDER BY suggestion_date DESC, id DESC LIMIT 1`,
        [item.id]
      );
      const positions = await getPositionAmounts(db, item.id);
      item.positions = positions;
      item.execution_discipline = await buildSleeveDiscipline(db, item, positions, item.latest_suggestion || null);
      item.position_ledger = await getPositionLedger(db, item);
      item.plan_quality = buildPlanQuality(item);
    }
    res.json({ success: true, data: { items } });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取金融买入计划失败：${(error as Error).message}` });
  }
});

router.get('/trade-plans/:id/execution-discipline', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureTradePlanProfileSchema(db);
    const id = Number(req.params.id);
    const plan = await db.get('SELECT * FROM financial_trade_plans WHERE id = ? AND is_deleted = 0', [id]);
    if (!plan) return res.status(404).json({ success: false, message: '计划不存在' });
    const latestSuggestion = await db.get(
      `SELECT * FROM financial_action_suggestions
       WHERE plan_id = ?
       ORDER BY suggestion_date DESC, id DESC LIMIT 1`,
      [id]
    );
    const positions = await getPositionAmounts(db, id);
    res.json({
      success: true,
      data: {
        ...(await buildSleeveDiscipline(db, plan, positions, latestSuggestion || null)),
        ledger: await getPositionLedger(db, plan)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取执行纪律失败：${(error as Error).message}` });
  }
});

router.get('/trade-plans/:id/executions', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const id = Number(req.params.id);
    const items = await db.all(
      `SELECT * FROM financial_trade_executions
       WHERE plan_id = ?
       ORDER BY execution_date DESC, id DESC`,
      [id]
    );
    res.json({ success: true, data: { items } });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取执行记录失败：${(error as Error).message}` });
  }
});

router.post('/trade-plans/:id/executions', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const id = Number(req.params.id);
    const plan = await db.get('SELECT * FROM financial_trade_plans WHERE id = ? AND is_deleted = 0', [id]);
    if (!plan) return res.status(404).json({ success: false, message: '计划不存在' });

    const actionType = String(req.body.action_type || '').trim();
    const sleeveType = String(req.body.sleeve_type || '').trim();
    const executionDate = String(req.body.execution_date || '').trim();
    const executionPrice = Number(req.body.execution_price);
    const executionAmount = Number(req.body.execution_amount);
    const validActions = ['buy', 'add', 'sell', 'reduce', 'stop_loss', 'exit'];
    const validSleeves = ['base', 'tactical', 'observation'];
    if (!validActions.includes(actionType) || !validSleeves.includes(sleeveType) || !executionDate) {
      return res.status(400).json({ success: false, message: '缺少有效的动作、仓位类型或执行日期' });
    }
    if (!Number.isFinite(executionPrice) || executionPrice <= 0 || !Number.isFinite(executionAmount) || executionAmount <= 0) {
      return res.status(400).json({ success: false, message: '执行价格和金额必须大于 0' });
    }
    if (BUY_EXECUTION_ACTIONS.has(actionType)) {
      const marketGateBlocker = await getTradePlanMarketGateBlocker(db, plan.source || 'tushare');
      if (marketGateBlocker) {
        return res.status(423).json({
          success: false,
          message: marketGateBlocker.message,
          data: {
            market_gate: marketGateBlocker.marketGate,
            downstream_blocked: true
          }
        });
      }
    }
    const currentPositions = await getPositionAmounts(db, id);
    const guardFailure = validateTradeExecution(plan, currentPositions, actionType, sleeveType, executionAmount);
    if (guardFailure) {
      return res.status(guardFailure.statusCode).json({ success: false, message: guardFailure.message });
    }
    const quantity = executionPrice > 0 ? executionAmount / executionPrice : null;
    const now = new Date().toISOString();
    const result = await db.run(
      `INSERT INTO financial_trade_executions (
        plan_id, symbol, action_type, sleeve_type, execution_date, execution_price,
        execution_amount, execution_quantity, trigger_phase, trigger_rule, position_decision,
        note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        plan.symbol,
        actionType,
        sleeveType,
        executionDate,
        executionPrice,
        executionAmount,
        quantity,
        req.body.trigger_phase || plan.trend_phase_code || '',
        req.body.trigger_rule || plan.trigger_type || '',
        req.body.position_decision || '',
        req.body.note || '',
        now,
        now
      ]
    );

    const planState = await syncTradePlanExecutionState(db, plan);
    const execution = await db.get('SELECT * FROM financial_trade_executions WHERE id = ?', [result.lastID]);
    res.json({
      success: true,
      data: execution,
      positions: planState.positions,
      plan_state_synced: planState.changed,
      message: '执行记录已保存'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `保存执行记录失败：${(error as Error).message}` });
  }
});

router.get('/trade-plans/:id/suggestions', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const id = Number(req.params.id);
    const items = await db.all(
      `SELECT * FROM financial_action_suggestions
       WHERE plan_id = ?
       ORDER BY suggestion_date DESC, id DESC LIMIT 60`,
      [id]
    );
    res.json({ success: true, data: { items } });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取动作建议失败：${(error as Error).message}` });
  }
});

router.post('/trade-plans/:id/sync-suggestion', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureTradePlanProfileSchema(db);
    const id = Number(req.params.id);
    const plan = await db.get('SELECT * FROM financial_trade_plans WHERE id = ? AND is_deleted = 0', [id]);
    if (!plan) return res.status(404).json({ success: false, message: '计划不存在' });

    req.body.symbol = plan.symbol;
    req.body.asset_type = plan.asset_type;
    req.body.source = plan.source;
    const snapshot = await getEntryTriggerSnapshot(req);
    const positions = await getPositionAmounts(db, id);
    const suggestion = await getSuggestionFromSnapshot(db, snapshot, positions);
    const savedRef = await saveActionSuggestion(db, plan, snapshot, suggestion, positions);
    const saved = await db.get('SELECT * FROM financial_action_suggestions WHERE id = ?', [savedRef.id]);
    res.json({
      success: true,
      data: saved,
      message: savedRef.mode === 'updated' ? '动作建议已更新' : '动作建议已同步'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `同步动作建议失败：${(error as Error).message}` });
  }
});

router.post('/trade-plans/sync-active-suggestions', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureTradePlanProfileSchema(db);
    const plans = await db.all(
      `SELECT * FROM financial_trade_plans
       WHERE is_deleted = 0 AND status IN ('draft', 'watching', 'paper_tracking', 'active')
       ORDER BY is_bought DESC, updated_at DESC
       LIMIT ?`,
      [Math.max(1, Math.min(Number(req.body.limit || 50), 200))]
    );
    const results: any[] = [];
    for (const plan of plans) {
      const planState = await syncTradePlanExecutionState(db, plan);
      const fakeReq = {
        ...req,
        body: { symbol: plan.symbol, asset_type: plan.asset_type, source: plan.source }
      } as Request;
      const snapshot = await getEntryTriggerSnapshot(fakeReq);
      const positions = planState.positions;
      const suggestion = await getSuggestionFromSnapshot(db, snapshot, positions);
      const savedRef = await saveActionSuggestion(db, plan, snapshot, suggestion, positions);
      results.push({
        plan_id: plan.id,
        suggestion_id: savedRef.id,
        action_label: suggestion.action_label,
        suggestion_mode: savedRef.mode,
        plan_state_synced: planState.changed
      });
    }
    res.json({ success: true, data: { items: results }, message: `已同步 ${results.length} 个计划的动作建议` });
  } catch (error) {
    res.status(500).json({ success: false, message: `批量同步动作建议失败：${(error as Error).message}` });
  }
});

router.post('/trade-plans/:id/review-draft', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureTradePlanProfileSchema(db);
    const id = Number(req.params.id);
    const plan = await db.get('SELECT * FROM financial_trade_plans WHERE id = ? AND is_deleted = 0', [id]);
    if (!plan) return res.status(404).json({ success: false, message: '计划不存在' });
    const shouldCreateReviewDraft =
      String(plan.status || '') === 'invalidated' ||
      Number(plan.stopped_out || 0) === 1;
    if (!shouldCreateReviewDraft) {
      return res.status(409).json({ success: false, message: '只有已失效或已触发止损的计划才生成失效复盘草稿' });
    }
    const reason = [
      String(plan.status || '') === 'invalidated' ? '计划状态已确认失效。' : '',
      Number(plan.stopped_out || 0) === 1 ? '已勾选触发止损。' : '',
      String(req.body?.reason || '').trim()
    ].filter(Boolean).join(' ');
    const reviewDraft = await ensureInvalidationTradeReviewDraft(db, plan, reason || '计划已触发失效处理。');
    res.json({ success: true, data: reviewDraft, message: reviewDraft.created ? '交易复盘草稿已生成' : '交易复盘草稿已存在' });
  } catch (error) {
    res.status(500).json({ success: false, message: `生成交易复盘草稿失败：${(error as Error).message}` });
  }
});

router.patch('/trade-plans/:id/feedback', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureTradePlanProfileSchema(db);
    const id = Number(req.params.id);
    const now = new Date().toISOString();
    const beforePlan = await db.get('SELECT * FROM financial_trade_plans WHERE id = ? AND is_deleted = 0', [id]);
    if (!beforePlan) return res.status(404).json({ success: false, message: '计划不存在' });
    const allowed = [
      'status', 'is_bought', 'buy_date', 'buy_price', 'buy_amount',
      'perf_5d', 'perf_10d', 'perf_20d', 'perf_60d',
      'stopped_out', 'entered_main_rise', 'false_breakout', 'chased_high',
      'feedback_note'
    ];
    const updates: string[] = [];
    const params: any[] = [];
    allowed.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates.push(`${key} = ?`);
        params.push(req.body[key]);
      }
    });
    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: '没有可更新字段' });
    }
    updates.push('updated_at = ?');
    params.push(now, id);
    await db.run(`UPDATE financial_trade_plans SET ${updates.join(', ')} WHERE id = ? AND is_deleted = 0`, params);
	    const plan = await db.get('SELECT * FROM financial_trade_plans WHERE id = ?', [id]);
	    let reviewDraft = null;
	    let failureSampleSync = { processed: 0, items: [] as Array<{ sample_type: string; followup_status: string }> };
	    if (plan) plan.plan_quality = buildPlanQuality(plan);
	    const shouldCreateReviewDraft =
	      plan &&
	      (
        String(plan.status || '') === 'invalidated' ||
        Number(plan.stopped_out || 0) === 1
      );
	    if (shouldCreateReviewDraft) {
	      const reason = [
	        String(plan.status || '') === 'invalidated' ? '计划状态已确认失效。' : '',
	        Number(plan.stopped_out || 0) === 1 ? '已勾选触发止损。' : ''
	      ].filter(Boolean).join(' ');
	      reviewDraft = await ensureInvalidationTradeReviewDraft(db, plan, reason || '计划已触发失效处理。');
	    }
	    if (plan) {
	      failureSampleSync = await syncFailureSamplesForTradePlan(db, plan);
	    }
	    res.json({ success: true, data: plan, review_draft: reviewDraft, failure_sample_sync: failureSampleSync });
  } catch (error) {
    res.status(500).json({ success: false, message: `更新反馈失败：${(error as Error).message}` });
  }
});

router.get('/trade-plans/stats/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const byStructure = await db.all(
      `SELECT structure_score_bucket as bucket,
              COUNT(*) as total,
              SUM(CASE WHEN is_bought = 1 THEN 1 ELSE 0 END) as bought_count,
              AVG(perf_20d) as avg_perf_20d,
              SUM(CASE WHEN perf_20d > 0 THEN 1 ELSE 0 END) as win_20d
       FROM financial_trade_plans
       WHERE is_deleted = 0
       GROUP BY structure_score_bucket
       ORDER BY bucket DESC`
    );
    const byTrend = await db.all(
      `SELECT trend_phase_code,
              COUNT(*) as total,
              AVG(perf_20d) as avg_perf_20d,
              SUM(CASE WHEN false_breakout = 1 THEN 1 ELSE 0 END) as false_breakout_count,
              SUM(CASE WHEN chased_high = 1 THEN 1 ELSE 0 END) as chased_high_count
       FROM financial_trade_plans
       WHERE is_deleted = 0
       GROUP BY trend_phase_code
       ORDER BY total DESC`
    );
    const byTrigger = await db.all(
      `SELECT trigger_type,
              COUNT(*) as total,
              AVG(perf_20d) as avg_perf_20d,
              SUM(CASE WHEN perf_20d > 0 THEN 1 ELSE 0 END) as win_20d
       FROM financial_trade_plans
       WHERE is_deleted = 0
       GROUP BY trigger_type
       ORDER BY total DESC`
    );
    res.json({ success: true, data: { by_structure: byStructure, by_trend: byTrend, by_trigger: byTrigger } });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取统计失败：${(error as Error).message}` });
  }
});

export default router;
