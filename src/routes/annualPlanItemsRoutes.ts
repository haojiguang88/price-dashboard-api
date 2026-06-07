import express from 'express';
import getDb from '../config/database';
import { validateActiveMasterTargetByNames } from '../utils/masterData';
import { isValidDateOnly } from '../utils/dateValidation';

const router = express.Router();

// 年度计划子项相关接口
const validScopeTypes = ['赛道', '品类', '对象'];
const validRoles = ['主线', '次主线', '观察', '试错', '禁区'];
const validActions = ['主做', '轻仓参与', '只观察', '快进快出', '暂停', '不碰'];
const validStatuses = ['生效中', '已降级', '已停用', '已替换'];

const normalizePriorityOrder = (value: unknown) => {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: null as number | null };
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, value: null as number | null };
  }

  return { ok: true, value: parsed };
};

const normalizeAnnualPlanItemPayload = async (db: any, body: any) => {
  const scopeType = String(body.scope_type || '').trim();
  const category = String(body.category || '').trim();
  const objectName = String(body.object_name || '').trim();
  const currentRole = String(body.current_role || '').trim();
  const currentAction = String(body.current_action || '').trim();
  const currentStatus = String(body.current_status || '').trim();

  if (!validScopeTypes.includes(scopeType)) {
    return { error: '范围类型不合法' };
  }
  if (!category) {
    return { error: '品类不能为空' };
  }
  if (!validRoles.includes(currentRole)) {
    return { error: '当前角色不合法' };
  }
  if (!validActions.includes(currentAction)) {
    return { error: '当前动作不合法' };
  }
  if (!validStatuses.includes(currentStatus)) {
    return { error: '当前状态不合法' };
  }

  if (scopeType === '品类') {
    const categoryRecord = await db.get(
      'SELECT name FROM categories WHERE name = ? AND COALESCE(is_archived, 0) = 0',
      [category]
    );
    if (!categoryRecord) {
      return { error: '品类不存在或已归档' };
    }
    return { value: { scopeType, category: categoryRecord.name, objectName: '', currentRole, currentAction, currentStatus } };
  }

  if (scopeType === '对象') {
    if (!objectName) {
      return { error: '对象范围必须填写对象名称' };
    }
    const masterTarget = await validateActiveMasterTargetByNames(db, category, objectName);
    if (!masterTarget.ok) {
      return { error: masterTarget.message };
    }
    return {
      value: {
        scopeType,
        category: masterTarget.target.category_name,
        objectName: masterTarget.target.object_name,
        currentRole,
        currentAction,
        currentStatus
      }
    };
  }

  return { value: { scopeType, category, objectName, currentRole, currentAction, currentStatus } };
};

const rolePriority = ['主线', '次主线', '观察', '试错', '禁区'];
const actionPriority = ['主做', '轻仓参与', '快进快出', '只观察', '暂停', '不碰'];

const compactText = (value: unknown, maxLength = 120) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
};

const splitSearchTerms = (value: unknown) => {
  const text = String(value ?? '').trim();
  if (!text) return [];
  const rawTerms = text
    .split(/[\/、,，;；\s]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  const expandedTerms = rawTerms.flatMap((term) => {
    const terms = [term];
    if (term.includes('龙银币')) terms.push('龙银币');
    if (term.includes('龙钞')) terms.push('龙钞');
    if (term.includes('白银')) terms.push('白银');
    if (term.includes('黄金')) terms.push('黄金');
    const normalized = term
      .replace(/信泰评级/g, '')
      .replace(/评级/g, '')
      .replace(/裸币/g, '')
      .replace(/散张/g, '')
      .replace(/标10不带4/g, '')
      .replace(/标10带4/g, '')
      .trim();
    if (normalized.length >= 2) terms.push(normalized);
    return terms;
  });
  return Array.from(new Set(expandedTerms)).slice(0, 8);
};

const addTextSearchClause = (
  conditions: string[],
  params: any[],
  fields: string[],
  terms: string[],
  tableAlias = ''
) => {
  if (terms.length === 0) return;
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const fragments: string[] = [];
  terms.forEach((term) => {
    fields.forEach((field) => {
      fragments.push(`COALESCE(${prefix}${field}, '') LIKE ?`);
      params.push(`%${term}%`);
    });
  });
  if (fragments.length > 0) {
    conditions.push(`(${fragments.join(' OR ')})`);
  }
};

const buildPriceWhereForAnnualItem = (item: any, objectTerms: string[], withObjectTerms: boolean, tableAlias = '') => {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const conditions = [`${prefix}category = ?`];
  const params: any[] = [item.category];
  if (withObjectTerms) {
    addTextSearchClause(conditions, params, ['object_name', 'variant', 'note'], objectTerms, tableAlias);
  }
  return { where: conditions.join(' AND '), params };
};

const loadPriceSnapshot = async (db: any, item: any, objectTerms: string[]) => {
  const loadWithWhere = async (withObjectTerms: boolean) => {
    const { where, params } = buildPriceWhereForAnnualItem(item, objectTerms, withObjectTerms);
    const { where: latestWhere, params: latestParams } = buildPriceWhereForAnnualItem(item, objectTerms, withObjectTerms, 'p2');
    const stats = await db.get(
      `SELECT COUNT(*) AS record_count,
              MIN(date) AS first_date,
              MAX(date) AS latest_date,
              MIN(price) AS low_price,
              MAX(price) AS high_price,
              ROUND(AVG(price), 2) AS avg_price,
              (SELECT price FROM price_records p2
               WHERE ${latestWhere}
               ORDER BY p2.date DESC, p2.id DESC
               LIMIT 1) AS latest_price
       FROM price_records
       WHERE ${where}`,
      [...latestParams, ...params]
    );
    const latest = await db.all(
      `SELECT id, date, object_name, variant, price, source, note
       FROM price_records
       WHERE ${where}
       ORDER BY date DESC, id DESC
       LIMIT 5`,
      params
    );
    return { stats, latest };
  };

  const scoped = objectTerms.length > 0 ? await loadWithWhere(true) : { stats: null, latest: [] };
  if (scoped.stats && Number(scoped.stats.record_count || 0) > 0) {
    return { ...scoped, scope: 'object_or_terms' };
  }
  const categoryOnly = await loadWithWhere(false);
  return { ...categoryOnly, scope: 'category' };
};

const roundNumber = (value: unknown, digits = 2) => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return null;
  const scale = 10 ** digits;
  return Math.round(numberValue * scale) / scale;
};

const formatPct = (value: unknown) => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return '-';
  const rounded = roundNumber(numberValue, 2);
  return `${numberValue > 0 ? '+' : ''}${rounded}%`;
};

const pctChange = (current: unknown, base: unknown) => {
  const currentNumber = Number(current);
  const baseNumber = Number(base);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(baseNumber) || baseNumber === 0) return null;
  return roundNumber(((currentNumber - baseNumber) / baseNumber) * 100, 2);
};

const classifyTrend = (pctShort: number | null, pctMedium: number | null, sampleCount: number, type: 'commodity' | 'anchor') => {
  if (sampleCount < 3) {
    return { code: 'sample_short', label: '样本不足', tone: 'yellow' };
  }

  const sharpRise = type === 'anchor' ? 5 : 15;
  const sharpDrop = type === 'anchor' ? -5 : -15;
  const slowRise = type === 'anchor' ? 1.5 : 5;
  const slowDrop = type === 'anchor' ? -1.5 : -5;
  const shortRise = type === 'anchor' ? 2 : 8;
  const shortDrop = type === 'anchor' ? -2 : -8;

  if ((pctShort !== null && pctShort >= shortRise) || (pctMedium !== null && pctMedium >= sharpRise)) {
    return { code: 'sharp_rise', label: '大涨', tone: 'yellow' };
  }
  if ((pctShort !== null && pctShort <= shortDrop) || (pctMedium !== null && pctMedium <= sharpDrop)) {
    return { code: 'sharp_drop', label: '大跌', tone: 'red' };
  }
  if (pctMedium !== null && pctMedium >= slowRise) {
    return { code: 'slow_rise', label: '慢涨', tone: 'green' };
  }
  if (pctMedium !== null && pctMedium <= slowDrop) {
    return { code: 'slow_drop', label: '慢跌', tone: 'yellow' };
  }
  return { code: 'flat', label: '横盘/窄幅', tone: 'blue' };
};

const buildSeriesTrend = (rows: any[], priceField: string, type: 'commodity' | 'anchor') => {
  const normalizedRows = rows
    .map((row) => ({
      ...row,
      numeric_price: Number(row[priceField])
    }))
    .filter((row) => Number.isFinite(row.numeric_price))
    .sort((a, b) => String(b.date || b.trade_date).localeCompare(String(a.date || a.trade_date)));
  const latest = normalizedRows[0] || null;
  const previous = normalizedRows[1] || null;
  const medium = normalizedRows[Math.min(19, Math.max(normalizedRows.length - 1, 0))] || null;
  const long = normalizedRows[Math.min(59, Math.max(normalizedRows.length - 1, 0))] || null;
  const pctPrevious = previous ? pctChange(latest.numeric_price, previous.numeric_price) : null;
  const pctMedium = medium ? pctChange(latest.numeric_price, medium.numeric_price) : null;
  const pctLong = long ? pctChange(latest.numeric_price, long.numeric_price) : null;
  const trend = classifyTrend(pctPrevious, pctMedium, normalizedRows.length, type);

  return {
    sample_count: normalizedRows.length,
    latest_date: latest ? String(latest.date || latest.trade_date) : '',
    latest_price: latest ? roundNumber(latest.numeric_price, type === 'anchor' ? 3 : 2) : null,
    previous_price: previous ? roundNumber(previous.numeric_price, type === 'anchor' ? 3 : 2) : null,
    pct_previous: pctPrevious,
    pct_medium: pctMedium,
    pct_long: pctLong,
    trend
  };
};

const loadDisciplinePriceSeries = async (db: any, item: any, objectTerms: string[]) => {
  const loadWithWhere = async (withObjectTerms: boolean, crossCategory = false) => {
    const conditions = crossCategory ? ['1 = 1'] : ['category = ?'];
    const params: any[] = crossCategory ? [] : [item.category];
    if (withObjectTerms) {
      addTextSearchClause(conditions, params, ['object_name', 'variant', 'note'], objectTerms);
    }
    return db.all(
      `SELECT id, date, category, object_name, variant, price, source, note
       FROM price_records
       WHERE ${conditions.join(' AND ')}
       ORDER BY date DESC, id DESC
       LIMIT 90`,
      params
    );
  };

  const scopedRows = objectTerms.length > 0 ? await loadWithWhere(true) : [];
  if (scopedRows.length > 0) {
    return { rows: scopedRows, scope: 'same_category_terms' };
  }

  const crossRows = objectTerms.length > 0 ? await loadWithWhere(true, true) : [];
  if (crossRows.length > 0) {
    return { rows: crossRows, scope: 'cross_category_terms' };
  }

  if (objectTerms.length > 0) {
    return { rows: [] as any[], scope: 'no_object_match' };
  }

  return { rows: await loadWithWhere(false), scope: 'category' };
};

const inferAnchorSymbol = (item: any) => {
  const text = [
    item.category,
    item.object_name,
    item.thesis,
    item.current_reason,
    item.position_rule,
    item.exit_rule,
    item.note
  ].filter(Boolean).join(' ');
  if (/黄金|金价|XAU/i.test(text)) {
    return { symbol: 'XAUUSD', label: '黄金现货锚' };
  }
  if (/白银|银价|龙银币|纪念币|贵金属|银币|SGE/i.test(text)) {
    return { symbol: 'SGE_AGTD', label: '白银延期锚' };
  }
  return null;
};

const loadMarketAnchorSeries = async (db: any, item: any) => {
  const anchor = inferAnchorSymbol(item);
  if (!anchor) {
    return { anchor: null, rows: [] as any[] };
  }
  const rows = await db.all(
    `SELECT id, symbol, name, trade_date, close, source, source_label
     FROM market_anchor_daily_prices
     WHERE symbol = ?
     ORDER BY trade_date DESC, id DESC
     LIMIT 90`,
    [anchor.symbol]
  );
  return { anchor, rows };
};

const loadMarketAnchorSnapshot = async (db: any, item: any) => {
  const anchor = inferAnchorSymbol(item);
  if (!anchor) {
    return { anchor: null, stats: null };
  }

  const stats = await db.get(
    `SELECT COUNT(*) AS record_count,
            MIN(trade_date) AS first_date,
            MAX(trade_date) AS latest_date,
            (SELECT close FROM market_anchor_daily_prices p2
             WHERE p2.symbol = ?
             ORDER BY p2.trade_date DESC, p2.id DESC
             LIMIT 1) AS latest_price
     FROM market_anchor_daily_prices
     WHERE symbol = ?`,
    [anchor.symbol, anchor.symbol]
  );

  return { anchor, stats };
};

const getCountLevel = (count: number) => {
  if (count >= 1000) return { level: '高', score: 45 };
  if (count >= 200) return { level: '高', score: 38 };
  if (count >= 50) return { level: '中', score: 28 };
  if (count >= 10) return { level: '中', score: 18 };
  if (count > 0) return { level: '低', score: 10 };
  return { level: '低', score: 0 };
};

const buildAssistanceConfidence = (
  item: any,
  profiles: any[],
  archives: any[],
  cycles: any[],
  priceSnapshot: any,
  anchorSnapshot: any
) => {
  const text = [item.category, item.object_name, item.thesis, item.current_reason, item.note]
    .filter(Boolean)
    .join(' ');
  const commodityRecordCount = Number(priceSnapshot?.stats?.record_count || 0);
  const anchorRecordCount = Number(anchorSnapshot?.stats?.record_count || 0);
  const effectiveRecordCount = /贵金属|白银|黄金/.test(text)
    ? Math.max(commodityRecordCount, anchorRecordCount)
    : commodityRecordCount;
  const countLevel = getCountLevel(effectiveRecordCount);
  const evidenceScore = Math.min(
    25,
    (profiles.length > 0 ? 8 : 0)
    + (archives.length > 0 ? 8 : 0)
    + (cycles.length > 0 ? 9 : 0)
  );

  let scenarioStability = '中';
  let scenarioScore = 18;
  let systemWeight = '半辅助';
  let manualFocus = ['真实可成交价格', '出货通道', '库存和现金流压力'];
  let scenarioReason = '这个方向既看价格，也看现实成交、供货和承接，系统只能做半辅助。';

  if (/贵金属|白银|黄金/.test(text)) {
    scenarioStability = '高';
    scenarioScore = 30;
    systemWeight = '强辅助';
    manualFocus = ['实物回收价/卖价是否跟大盘同步', '暴涨/阴跌/回踩不破', '趋势仓和波段仓拆清楚'];
    scenarioReason = '贵金属大盘锚点连续，价格变化能被长期历史验证，适合系统强辅助。';
  } else if (/纪念币|纪念钞|龙银|龙钞|银币|闷包/.test(text)) {
    scenarioStability = '中';
    scenarioScore = 18;
    systemWeight = '半辅助';
    manualFocus = ['白银大盘锚是否支持', '发行量/首发/评级窗口', '真实成交/承接/闷包赔率'];
    scenarioReason = '纪念币/钞有价格和案例证据，但发行、评级、资金炒作和承接会改变结论。';
  } else if (/泡泡|MOKOKO|LABUBU|福袋|千岛/.test(text)) {
    scenarioStability = '低';
    scenarioScore = 8;
    systemWeight = '只记录';
    manualFocus = ['补货/预售是否变化', '税务/平台规则是否冲击玩法', '福袋承接/车主是否还在', '二级跑货速度'];
    scenarioReason = '泡泡玛特受补货、平台规则、福袋玩法和二级情绪影响很大，数据容易被场景改写。';
  } else if (/苹果|游戏机|手机|Switch|PS5|固态|电子/.test(text)) {
    scenarioStability = '低';
    scenarioScore = 10;
    systemWeight = '只记录';
    manualFocus = ['平台活动真实可买量', '档口回收价是否锁定', '能否当天出货'];
    scenarioReason = '撸货类核心是能不能真实拿货和快速出货，价格历史只能做背景记录。';
  }

  let score = Math.min(100, countLevel.score + evidenceScore + scenarioScore);
  if (scenarioStability === '低') {
    score = Math.min(score, 49);
  }
  if (systemWeight === '强辅助' && countLevel.score < 28) {
    systemWeight = '半辅助';
  }

  const label = score >= 70 && systemWeight === '强辅助'
    ? '高'
    : score >= 45 && systemWeight !== '只记录'
      ? '中'
      : '低';
  const level = label === '高' ? 'high' : label === '中' ? 'medium' : 'low';
  const dataCompleteness = countLevel.level;
  const dataReason = effectiveRecordCount > 0
    ? `可用价格/锚点样本${effectiveRecordCount}条${anchorSnapshot?.anchor ? `，含${anchorSnapshot.anchor.label}` : ''}`
    : '缺少可用价格样本';
  const evidenceReason = `画像${profiles.length}条、档案${archives.length}条、周期案例${cycles.length}条`;

  return {
    level,
    label,
    score,
    system_weight: systemWeight,
    data_completeness: dataCompleteness,
    scenario_stability: scenarioStability,
    summary: `${label}可信度，${systemWeight}。${dataReason}；${evidenceReason}。${scenarioReason}`,
    reasons: [dataReason, evidenceReason, scenarioReason],
    manual_focus: manualFocus
  };
};

const buildAnnualEntityConditions = (
  item: any,
  objectTerms: string[],
  fields: string[],
  includeAnnualPlanId = false
) => {
  const categoryCondition = 'category_name = ?';
  const conditions: string[] = [categoryCondition];
  const params: any[] = [item.category];
  if (objectTerms.length > 0) {
    const scopedConditions: string[] = ['category_name = ?'];
    const scopedParams: any[] = [item.category];
    addTextSearchClause(scopedConditions, scopedParams, fields, objectTerms);
    const crossConditions: string[] = [];
    const crossParams: any[] = [];
    addTextSearchClause(crossConditions, crossParams, fields, objectTerms);
    conditions.length = 0;
    params.length = 0;
    conditions.push(`((${scopedConditions.join(' AND ')}) OR (${crossConditions.join(' AND ')}))`);
    params.push(...scopedParams, ...crossParams);
  }
  if (includeAnnualPlanId) {
    conditions.unshift('(annual_plan_item_id = ? OR');
    conditions.push(')');
    params.unshift(item.id);
  }
  return { where: conditions.join(' '), params };
};

const loadDisciplinePositions = async (db: any, item: any, objectTerms: string[]) => {
  const { where, params } = buildAnnualEntityConditions(item, objectTerms, ['object_name', 'variant_name']);
  return db.all(
    `SELECT id, category_name, object_name, variant_name, total_quantity, total_cost,
            avg_price, current_price, total_profit, profit_rate, updated_at
     FROM positions
     WHERE ${where}
     ORDER BY datetime(updated_at) DESC, id DESC
     LIMIT 8`,
    params
  );
};

const loadDisciplinePlans = async (db: any, item: any, objectTerms: string[], tableName: 'buying_plans' | 'selling_plans') => {
  const { where, params } = buildAnnualEntityConditions(item, objectTerms, ['object_name', 'variant_name', 'note'], true);
  return db.all(
    `SELECT id, plan_name, category_name, object_name, variant_name, target_price,
            plan_quantity, total_amount, status, annual_plan_item_id, note, updated_at
     FROM ${tableName}
     WHERE ${where}
       AND COALESCE(status, '') NOT IN ('cancelled', 'completed', 'done', '已取消', '已完成')
     ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
              datetime(updated_at) DESC,
              id DESC
     LIMIT 8`,
    params
  );
};

const isSellTargetReached = (latestPrice: number | null, sellPlans: any[]) => {
  if (latestPrice === null) return false;
  return sellPlans.some((plan) => {
    const targetPrice = Number(plan.target_price);
    return Number.isFinite(targetPrice) && targetPrice > 0 && latestPrice >= targetPrice;
  });
};

const isSellTargetNear = (latestPrice: number | null, sellPlans: any[]) => {
  if (latestPrice === null) return false;
  return sellPlans.some((plan) => {
    const targetPrice = Number(plan.target_price);
    return Number.isFinite(targetPrice) && targetPrice > 0 && latestPrice >= targetPrice * 0.97 && latestPrice < targetPrice;
  });
};

const isBuyTargetReached = (latestPrice: number | null, buyPlans: any[]) => {
  if (latestPrice === null) return false;
  return buyPlans.some((plan) => {
    const targetPrice = Number(plan.target_price);
    return Number.isFinite(targetPrice) && targetPrice > 0 && latestPrice <= targetPrice;
  });
};

const summarizeExecutionDisciplineAssist = (
  item: any,
  priceSeries: any,
  anchorSeries: any,
  positions: any[],
  buyPlans: any[],
  sellPlans: any[]
) => {
  const priceTrend = buildSeriesTrend(priceSeries.rows || [], 'price', 'commodity');
  const anchorTrend = buildSeriesTrend(anchorSeries.rows || [], 'close', 'anchor');
  const hasPosition = positions.some((position) => Number(position.total_quantity || 0) > 0);
  const latestPrice = priceTrend.latest_price;
  const sellReached = isSellTargetReached(latestPrice, sellPlans);
  const sellNear = isSellTargetNear(latestPrice, sellPlans);
  const buyReached = isBuyTargetReached(latestPrice, buyPlans);
  const disciplineHits: Array<{ rule: string; reason: string; tone: string }> = [];
  const actionNotes: string[] = [];
  const riskNotes: string[] = [];
  const evidenceCards: Array<{ title: string; value: string; detail: string; tone: string }> = [];

  if (item.current_status !== '生效中' || item.current_action === '暂停' || item.current_action === '不碰' || item.current_role === '禁区') {
    disciplineHits.push({
      rule: '现金为王 / 切勿幻想',
      reason: `年度计划状态是${item.current_status}，动作是${item.current_action}，纪律上先按不执行处理。`,
      tone: 'red'
    });
  }

  if (item.current_action === '快进快出') {
    disciplineHits.push({
      rule: '有利必跑 / 落袋为安',
      reason: '当前年度动作是快进快出，盈利和成交窗口优先于长期幻想。',
      tone: 'yellow'
    });
  }

  if (sellReached) {
    disciplineHits.push({
      rule: '大涨要出 / 见好就收',
      reason: '商品最新价格已经触及或超过有效卖出计划价，先检查兑现动作。',
      tone: 'green'
    });
  } else if (sellNear) {
    disciplineHits.push({
      rule: '见好就收',
      reason: '商品价格已经接近卖出计划价，适合提前准备出货和分批兑现。',
      tone: 'green'
    });
  }

  if (priceTrend.trend.code === 'sharp_rise') {
    disciplineHits.push({
      rule: hasPosition ? '大涨要出' : '不要追涨',
      reason: `商品价格被识别为大涨，近中期变化${formatPct(priceTrend.pct_medium)}，纪律上先看兑现或等待回踩。`,
      tone: 'yellow'
    });
  }
  if (priceTrend.trend.code === 'slow_rise') {
    disciplineHits.push({
      rule: '慢涨不出',
      reason: `商品价格属于慢涨，近中期变化${formatPct(priceTrend.pct_medium)}，有仓位时不急着一把卖飞，但要保留卖点。`,
      tone: 'green'
    });
  }
  if (priceTrend.trend.code === 'sharp_drop') {
    disciplineHits.push({
      rule: hasPosition ? '大跌不出' : '现金为王',
      reason: `商品价格出现急跌，近中期变化${formatPct(priceTrend.pct_medium)}，不在恐慌点机械卖，也不急着接飞刀。`,
      tone: 'red'
    });
  }
  if (priceTrend.trend.code === 'slow_drop') {
    disciplineHits.push({
      rule: '慢跌要出 / 切勿幻想',
      reason: `商品价格处于慢跌，近中期变化${formatPct(priceTrend.pct_medium)}，这种最容易磨损现金流和判断。`,
      tone: 'yellow'
    });
  }

  if (buyReached) {
    disciplineHits.push({
      rule: '不要追涨 / 先过风控',
      reason: '买入计划价格已经到位，但仍要看供货、成交真实性、风控依据和仓位纪律。',
      tone: 'blue'
    });
  }

  if (anchorSeries.anchor && anchorTrend.sample_count > 0) {
    if (anchorTrend.trend.code === 'sharp_rise') {
      riskNotes.push(`${anchorSeries.anchor.label}短中期偏大涨，实物端容易追高，已有货优先看兑现纪律。`);
    } else if (anchorTrend.trend.code === 'slow_drop' || anchorTrend.trend.code === 'sharp_drop') {
      riskNotes.push(`${anchorSeries.anchor.label}走弱，纪念币/贵金属补仓要更慢，先等承接和回踩结构。`);
    } else if (anchorTrend.trend.code === 'slow_rise') {
      actionNotes.push(`${anchorSeries.anchor.label}慢涨，背景偏支持，但商品本身仍要看成交承接。`);
    }
  }

  if (priceTrend.sample_count < 3) {
    riskNotes.push('商品价格样本少，纪律辅助只能提示原则，不能把单点价格当趋势。');
  }
  if (!hasPosition && !buyReached) {
    actionNotes.push('没有匹配到当前仓位，纪律上优先现金为王，等价格、供货和风控条件同时出现。');
  }
  if (hasPosition && sellPlans.length === 0) {
    riskNotes.push('匹配到仓位但没有有效卖出计划，建议先补卖出纪律和分批兑现条件。');
  }
  if (sellPlans.length > 0) {
    actionNotes.push(`当前有${sellPlans.length}条有效卖出计划，可作为“见好就收/大涨要出”的执行锚。`);
  }
  if (buyPlans.length > 0) {
    actionNotes.push(`当前有${buyPlans.length}条有效买入计划，到价后仍要叠加风控和真实可买数量。`);
  }

  evidenceCards.push({
    title: '年度纪律口径',
    value: `${item.current_action} / ${item.current_status}`,
    detail: item.exit_rule ? `退出规则：${compactText(item.exit_rule, 110)}` : '年度计划没有单独写退出规则，先按通用纪律辅助。',
    tone: item.current_status === '生效中' ? 'blue' : 'red'
  });
  evidenceCards.push({
    title: '商品行情',
    value: priceTrend.latest_price !== null ? `${priceTrend.trend.label} · 最新${priceTrend.latest_price}` : '暂无样本',
    detail: priceTrend.sample_count > 0
      ? `样本${priceTrend.sample_count}条，最新${priceTrend.latest_date}，近一笔${formatPct(priceTrend.pct_previous)}，近中期${formatPct(priceTrend.pct_medium)}。`
      : '未找到商品价格样本，不生成趋势结论。',
    tone: priceTrend.trend.tone
  });
  evidenceCards.push({
    title: '仓位/计划',
    value: `仓位${positions.length} · 买${buyPlans.length} · 卖${sellPlans.length}`,
    detail: hasPosition
      ? `匹配到持仓，平均成本最低按${roundNumber(Math.min(...positions.map((p) => Number(p.avg_price || 0)).filter((v) => v > 0)), 2) ?? '-'}参考。`
      : '未匹配到持仓，默认先按现金纪律看。',
    tone: hasPosition ? 'green' : 'yellow'
  });
  evidenceCards.push({
    title: anchorSeries.anchor ? anchorSeries.anchor.label : '大盘锚点',
    value: anchorSeries.anchor && anchorTrend.latest_price !== null ? `${anchorTrend.trend.label} · 最新${anchorTrend.latest_price}` : '无关联锚点',
    detail: anchorSeries.anchor && anchorTrend.sample_count > 0
      ? `锚点样本${anchorTrend.sample_count}条，最新${anchorTrend.latest_date}，近中期${formatPct(anchorTrend.pct_medium)}；只作背景证据。`
      : '当前品类没有自动匹配黄金/白银锚点。',
    tone: anchorSeries.anchor ? anchorTrend.trend.tone : 'blue'
  });

  if (disciplineHits.length === 0) {
    disciplineHits.push({
      rule: '现金为王 / 不要追涨',
      reason: '暂未触发明显买卖纪律，保持现金和观察优先，等价格、供货、承接和计划条件更明确。',
      tone: 'blue'
    });
  }

  let level = 'cash';
  let title = '现金为王，等待更明确触发';
  if (item.current_status !== '生效中' || item.current_role === '禁区') {
    level = 'blocked';
    title = '当前计划不执行，纪律上先收住';
  } else if (sellReached || priceTrend.trend.code === 'sharp_rise') {
    level = 'take_profit';
    title = hasPosition ? '优先检查兑现动作' : '大涨不追，等回踩和供货';
  } else if (priceTrend.trend.code === 'slow_drop') {
    level = 'reduce';
    title = '慢跌优先降风险';
  } else if (priceTrend.trend.code === 'sharp_drop') {
    level = 'wait';
    title = hasPosition ? '大跌先不恐慌卖出' : '急跌先别接飞刀';
  } else if (priceTrend.trend.code === 'slow_rise') {
    level = 'hold';
    title = hasPosition ? '慢涨持有观察，保留卖点' : '慢涨不追，等计划价';
  } else if (buyReached) {
    level = 'buy_check';
    title = '买入价到位，先过风控再动手';
  }

  const summary = [
    `商品行情：${priceTrend.latest_price !== null ? `${priceTrend.trend.label}，最新${priceTrend.latest_price}` : '暂无有效样本'}`,
    anchorSeries.anchor && anchorTrend.latest_price !== null ? `${anchorSeries.anchor.label}：${anchorTrend.trend.label}` : '',
    sellPlans.length > 0 ? `有效卖出计划${sellPlans.length}条` : '',
    buyPlans.length > 0 ? `有效买入计划${buyPlans.length}条` : ''
  ].filter(Boolean).join('；');

  return {
    recommendation: {
      level,
      title,
      summary: `${summary || '证据不足'}。该辅助只负责提醒纪律，不替代风控和真实成交判断。`
    },
    discipline_hits: disciplineHits.slice(0, 6),
    evidence_cards: evidenceCards,
    action_notes: actionNotes.slice(0, 5),
    risk_notes: riskNotes.slice(0, 5),
    data: {
      price_scope: priceSeries.scope,
      price_trend: priceTrend,
      market_anchor: anchorSeries.anchor ? {
        symbol: anchorSeries.anchor.symbol,
        label: anchorSeries.anchor.label,
        trend: anchorTrend
      } : null,
      positions: positions.map((position) => ({
        id: String(position.id),
        category_name: position.category_name,
        object_name: position.object_name,
        variant_name: position.variant_name || '',
        total_quantity: position.total_quantity,
        avg_price: position.avg_price,
        current_price: position.current_price ?? null,
        profit_rate: position.profit_rate ?? null
      })),
      buy_plans: buyPlans.map((plan) => ({
        id: String(plan.id),
        plan_name: plan.plan_name,
        category_name: plan.category_name,
        object_name: plan.object_name,
        variant_name: plan.variant_name || '',
        target_price: plan.target_price,
        plan_quantity: plan.plan_quantity,
        status: plan.status
      })),
      sell_plans: sellPlans.map((plan) => ({
        id: String(plan.id),
        plan_name: plan.plan_name,
        category_name: plan.category_name,
        object_name: plan.object_name,
        variant_name: plan.variant_name || '',
        target_price: plan.target_price,
        plan_quantity: plan.plan_quantity,
        status: plan.status
      }))
    }
  };
};

const summarizeAnnualPlanAssist = (
  item: any,
  planItems: any[],
  profiles: any[],
  archives: any[],
  cycles: any[],
  priceSnapshot: any,
  anchorSnapshot: any
) => {
  const activeMainlines = planItems.filter((planItem) => (
    planItem.current_status === '生效中'
    && ['主线', '次主线'].includes(planItem.current_role)
  ));
  const downgradedItems = planItems.filter((planItem) => planItem.current_status !== '生效中');
  const supportPoints: string[] = [];
  const riskPoints: string[] = [];
  const switchSignals: string[] = [];
  const evidenceCards: Array<{ title: string; value: string; detail: string; tone: string }> = [];
  const assistanceConfidence = buildAssistanceConfidence(item, profiles, archives, cycles, priceSnapshot, anchorSnapshot);

  if (item.current_status === '生效中' && ['主线', '次主线'].includes(item.current_role)) {
    supportPoints.push(`年度计划当前把它列为${item.current_role}，动作是${item.current_action}。`);
  } else if (item.current_status !== '生效中') {
    riskPoints.push(`年度计划当前状态是${item.current_status}，不应按主线默认执行。`);
  } else {
    supportPoints.push(`年度计划当前定位为${item.current_role}，更适合按${item.current_action}处理。`);
  }

  if (item.current_action === '快进快出') {
    riskPoints.push('当前动作是快进快出，辅助判断会优先提醒兑现和不留仓。');
  }
  if (item.downgrade_reason) {
    riskPoints.push(`已有降级/停用理由：${compactText(item.downgrade_reason, 96)}`);
  }
  if (item.resume_condition) {
    switchSignals.push(`恢复/切换条件：${compactText(item.resume_condition, 120)}`);
  }

  const mainArchives = archives.filter((archive) => archive.position_level === 'main');
  const activeArchives = archives.filter((archive) => archive.status === 'active');
  if (profiles.length > 0) {
    supportPoints.push(`已找到${profiles.length}条相关品类画像，可用来校准经营风格和纪律。`);
  }
  if (mainArchives.length > 0) {
    supportPoints.push(`相关品种档案里有${mainArchives.length}条主力档案。`);
  } else if (activeArchives.length > 0) {
    supportPoints.push(`相关品种档案里有${activeArchives.length}条启用档案，但未全部标为主力。`);
  }
  if (cycles.length > 0) {
    supportPoints.push(`周期模式库有${cycles.length}条相关案例，可辅助判断强弱市、爆炒、回落和承接。`);
  }

  const recordCount = Number(priceSnapshot?.stats?.record_count || 0);
  if (recordCount > 0) {
    supportPoints.push(`价格记录有${recordCount}条样本，最近记录到${priceSnapshot.stats.latest_date || '未知日期'}。`);
  } else {
    riskPoints.push('暂未找到相关价格样本，主线辅助只能依赖计划、画像和案例。');
  }

  const currentMainlineLabels = activeMainlines
    .map((planItem) => [planItem.category, planItem.object_name].filter(Boolean).join(' / '))
    .slice(0, 4);
  evidenceCards.push({
    title: '辅助可信度',
    value: `${assistanceConfidence.label} · ${assistanceConfidence.system_weight}`,
    detail: assistanceConfidence.summary,
    tone: assistanceConfidence.level === 'high' ? 'green' : assistanceConfidence.level === 'medium' ? 'blue' : 'yellow'
  });
  if (assistanceConfidence.level === 'high') {
    supportPoints.push(`辅助可信度高：${assistanceConfidence.summary}`);
  } else if (assistanceConfidence.level === 'low') {
    riskPoints.push(`辅助可信度低：${assistanceConfidence.summary}`);
  } else {
    switchSignals.push(`辅助可信度中等：${assistanceConfidence.manual_focus.join('、')}确认后再升级动作。`);
  }

  evidenceCards.push({
    title: '年度计划内位置',
    value: `${item.current_role} / ${item.current_action} / ${item.current_status}`,
    detail: currentMainlineLabels.length
      ? `当前生效主线/次主线：${currentMainlineLabels.join('、')}`
      : '当前年度计划没有其它生效主线/次主线。',
    tone: item.current_status === '生效中' ? 'green' : 'yellow'
  });
  evidenceCards.push({
    title: '证据覆盖',
    value: `画像${profiles.length} · 档案${archives.length} · 周期${cycles.length}`,
    detail: `同计划已降级/停用子项${downgradedItems.length}条；辅助会把这些当作对比背景。`,
    tone: profiles.length + archives.length + cycles.length > 0 ? 'blue' : 'yellow'
  });
  evidenceCards.push({
    title: '价格样本',
    value: recordCount > 0 ? `${recordCount}条 · 最新${priceSnapshot.stats.latest_price ?? '-'}` : '暂无',
    detail: recordCount > 0
      ? `区间 ${priceSnapshot.stats.low_price ?? '-'} - ${priceSnapshot.stats.high_price ?? '-'}，样本范围：${priceSnapshot.scope === 'category' ? '品类' : '对象/关键词'}`
      : '没有价格样本时，不自动给强结论。',
    tone: recordCount > 0 ? 'purple' : 'yellow'
  });

  if (activeMainlines.some((planItem) => String(planItem.id) !== String(item.id))) {
    switchSignals.push('同一年度计划内已有其它生效主线/次主线，资金分配要比较证据强弱和兑现能力。');
  }
  if (profiles.length + archives.length + cycles.length === 0) {
    switchSignals.push('画像、档案和周期案例不足时，先补证据，不要只按年度计划旧文字执行。');
  }
  switchSignals.push('如果其它品类进入强市并出现更强承接、利润结构和可执行计划，应允许年度主线切换。');

  let title = '保持观察，等待证据补齐';
  let level = 'watch';
  if (item.current_status !== '生效中' || item.current_role === '禁区') {
    title = '当前不按主线执行';
    level = 'blocked';
  } else if (item.current_role === '主线') {
    title = '保留主线，但继续动态验证';
    level = 'mainline';
  } else if (item.current_role === '次主线') {
    title = '保留次主线，适合轮动比较';
    level = 'secondary';
  } else if (item.current_action === '快进快出') {
    title = '按短线兑现处理';
    level = 'tactical';
  }

  const primaryReason = supportPoints[0] || riskPoints[0] || '当前数据不足，需要继续补画像、档案和价格证据。';
  const summary = `${primaryReason}${recordCount > 0 ? ` 价格样本最新日期为${priceSnapshot.stats.latest_date}。` : ''}`;

  return {
    level,
    title,
    summary,
    assistance_confidence: assistanceConfidence,
    support_points: supportPoints.slice(0, 5),
    risk_points: riskPoints.slice(0, 5),
    switch_signals: switchSignals.slice(0, 5),
    evidence_cards: evidenceCards
  };
};

const inferAnnualPlanChangeType = (existingRecord: any, normalizedItem: any) => {
  if (existingRecord.current_status !== normalizedItem.currentStatus) {
    if (normalizedItem.currentStatus === '已降级') return '降级';
    if (normalizedItem.currentStatus === '已停用') return '暂停';
    if (
      normalizedItem.currentStatus === '生效中' &&
      ['已降级', '已停用'].includes(existingRecord.current_status)
    ) {
      return '恢复';
    }
    return '状态调整';
  }

  if (existingRecord.current_role !== normalizedItem.currentRole) {
    const oldRoleIndex = rolePriority.indexOf(existingRecord.current_role);
    const newRoleIndex = rolePriority.indexOf(normalizedItem.currentRole);
    if (oldRoleIndex >= 0 && newRoleIndex >= 0) {
      if (newRoleIndex > oldRoleIndex) return '降级';
      if (newRoleIndex < oldRoleIndex) return '升级';
    }
    return '修正';
  }

  if (existingRecord.current_action !== normalizedItem.currentAction) {
    const oldActionIndex = actionPriority.indexOf(existingRecord.current_action);
    const newActionIndex = actionPriority.indexOf(normalizedItem.currentAction);
    if (oldActionIndex >= 0 && newActionIndex >= 0) {
      if (newActionIndex > oldActionIndex) return '降级';
      if (newActionIndex < oldActionIndex) return '升级';
    }
    return '修正';
  }

  return '状态调整';
};

// 新增年度计划子项
router.post('/annual-plan-items', async (req, res) => {
  try {
    const db = await getDb();
    const { plan_id, thesis, current_reason, position_rule, exit_rule, downgrade_reason, resume_condition, priority_order, note } = req.body;
    
    if (!plan_id) {
      return res.status(400).json({ success: false, message: '缺少必填字段: plan_id' });
    }
    
    // 验证计划是否存在
    const planExists = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [plan_id]);
    if (!planExists) {
      return res.status(404).json({ success: false, message: '关联的年度计划不存在' });
    }

    const normalizedPriorityOrder = normalizePriorityOrder(priority_order);
    if (!normalizedPriorityOrder.ok) {
      return res.status(400).json({ success: false, message: '优先级必须是正整数或留空' });
    }

    const normalizedItem = await normalizeAnnualPlanItemPayload(db, req.body);
    if ('error' in normalizedItem) {
      return res.status(400).json({ success: false, message: normalizedItem.error });
    }
    
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO annual_plan_items (plan_id, scope_type, category, object_name, current_role, current_action, current_status, thesis, current_reason, position_rule, exit_rule, downgrade_reason, resume_condition, priority_order, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        plan_id,
        normalizedItem.value.scopeType,
        normalizedItem.value.category,
        normalizedItem.value.objectName,
        normalizedItem.value.currentRole,
        normalizedItem.value.currentAction,
        normalizedItem.value.currentStatus,
        thesis,
        current_reason,
        position_rule,
        exit_rule,
        downgrade_reason,
        resume_condition,
        normalizedPriorityOrder.value,
        note,
        0,
        now,
        now
      ]
    );
    const createdRecord = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [result.lastID]);
    
    res.json({ success: true, data: createdRecord || { id: result.lastID } });
  } catch (error) {
    console.error('Error creating annual plan item:', error);
    res.status(500).json({ success: false, message: '新增年度计划子项失败' });
  }
});

// 获取年度计划子项列表
router.get('/annual-plan-items', async (req, res) => {
  try {
    const db = await getDb();
    const { plan_id } = req.query;
    
    let query = 'SELECT * FROM annual_plan_items WHERE is_deleted = 0';
    const params: any[] = [];
    
    if (plan_id) {
      query += ' AND plan_id = ?';
      params.push(plan_id);
    }
    
    query += ' ORDER BY CASE WHEN priority_order IS NULL THEN 1 ELSE 0 END, priority_order ASC, created_at DESC';
    
    const records = await db.all(query, params);
    res.json({ success: true, data: records });
  } catch (error) {
    console.error('Error getting annual plan items:', error);
    res.status(500).json({ success: false, message: '获取年度计划子项列表失败' });
  }
});

// 获取年度计划子项动态主线辅助
router.get('/annual-plan-items/:id/mainline-assist', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const item = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);

    if (!item) {
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }

    const objectTerms = splitSearchTerms(item.object_name);
    const [planItems, profiles, archives, cycles, priceSnapshot, anchorSnapshot] = await Promise.all([
      db.all(
        `SELECT *
         FROM annual_plan_items
         WHERE plan_id = ? AND COALESCE(is_deleted, 0) = 0
         ORDER BY CASE WHEN priority_order IS NULL THEN 1 ELSE 0 END, priority_order ASC, id ASC`,
        [item.plan_id]
      ),
      (async () => {
        const conditions = ['COALESCE(is_deleted, 0) = 0', 'category_name = ?'];
        const params: any[] = [item.category];
        if (objectTerms.length > 0) {
          conditions.push(`(COALESCE(object_name, '') = '' OR ${objectTerms.map(() => 'COALESCE(object_name, \'\') LIKE ?').join(' OR ')})`);
          objectTerms.forEach((term) => params.push(`%${term}%`));
        }
        return db.all(
          `SELECT id, category_name, object_name, variant_name, business_style, operation_scene,
                  price_pattern, risk_points, operating_discipline, decision_notes, status, updated_at
           FROM category_profiles
           WHERE ${conditions.join(' AND ')}
           ORDER BY
             CASE WHEN COALESCE(object_name, '') = '' THEN 1 ELSE 0 END,
             datetime(updated_at) DESC,
             id DESC
           LIMIT 5`,
          params
        );
      })(),
      (async () => {
        const loadArchives = async (useTerms: boolean) => {
          const conditions = ['COALESCE(is_deleted, 0) = 0', 'category_name = ?'];
          const params: any[] = [item.category];
          if (useTerms) {
            addTextSearchClause(
              conditions,
              params,
              ['object_name', 'variant_name', 'archive_name', 'one_sentence_judgment', 'raw_description', 'risk_basis', 'experience_note', 'note'],
              objectTerms
            );
          }
          return db.all(
            `SELECT id, category_name, object_name, variant_name, archive_name, position_level,
                    one_sentence_judgment, risk_basis, experience_note, status, confidence, updated_at
             FROM product_archives
             WHERE ${conditions.join(' AND ')}
             ORDER BY
               CASE position_level WHEN 'main' THEN 0 WHEN 'watch' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
               CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
               datetime(updated_at) DESC,
               id DESC
             LIMIT 8`,
            params
          );
        };
        const scopedArchives = objectTerms.length > 0 ? await loadArchives(true) : [];
        if (objectTerms.length > 0) return scopedArchives;
        return loadArchives(false);
      })(),
      (async () => {
        const loadCycles = async (useTerms: boolean) => {
          const conditions = ['category_name = ?'];
          const params: any[] = [item.category];
          if (useTerms) {
            addTextSearchClause(
              conditions,
              params,
              ['object_name', 'variant_name', 'cycle_pattern', 'rise_nature', 'summary', 'lesson', 'note', 'experience_tags'],
              objectTerms
            );
          }
          return db.all(
            `SELECT id, category_name, object_name, variant_name, cycle_stage, cycle_pattern,
                    rise_nature, market_background, open_level, high_price, current_price,
                    summary, lesson, updated_at
             FROM speculation_cycle_records
             WHERE ${conditions.join(' AND ')}
             ORDER BY datetime(updated_at) DESC, id DESC
             LIMIT 8`,
            params
          );
        };
        const scopedCycles = objectTerms.length > 0 ? await loadCycles(true) : [];
        if (objectTerms.length > 0) return scopedCycles;
        return loadCycles(false);
      })(),
      loadPriceSnapshot(db, item, objectTerms),
      loadMarketAnchorSnapshot(db, item)
    ]);

    const assist = summarizeAnnualPlanAssist(item, planItems, profiles, archives, cycles, priceSnapshot, anchorSnapshot);

    res.json({
      success: true,
      data: {
        generated_at: new Date().toISOString(),
        item: {
          id: String(item.id),
          plan_id: String(item.plan_id),
          scope_type: item.scope_type,
          category: item.category,
          object_name: item.object_name || '',
          current_role: item.current_role,
          current_action: item.current_action,
          current_status: item.current_status,
          priority_order: item.priority_order ?? null
        },
        recommendation: {
          level: assist.level,
          title: assist.title,
          summary: assist.summary
        },
        assistance_confidence: assist.assistance_confidence,
        support_points: assist.support_points,
        risk_points: assist.risk_points,
        switch_signals: assist.switch_signals,
        evidence_cards: assist.evidence_cards,
        related: {
          plan_items: planItems.map((planItem: any) => ({
            id: String(planItem.id),
            category: planItem.category,
            object_name: planItem.object_name || '',
            current_role: planItem.current_role,
            current_action: planItem.current_action,
            current_status: planItem.current_status,
            priority_order: planItem.priority_order ?? null
          })),
          profiles: profiles.map((profile: any) => ({
            id: String(profile.id),
            category_name: profile.category_name,
            object_name: profile.object_name || '',
            variant_name: profile.variant_name || '',
            business_style: profile.business_style || '',
            operation_scene: profile.operation_scene || '',
            risk_points: compactText(profile.risk_points, 180),
            operating_discipline: compactText(profile.operating_discipline, 180),
            decision_notes: compactText(profile.decision_notes, 180),
            updated_at: profile.updated_at
          })),
          archives: archives.map((archive: any) => ({
            id: String(archive.id),
            archive_name: archive.archive_name,
            object_name: archive.object_name || '',
            variant_name: archive.variant_name || '',
            position_level: archive.position_level,
            status: archive.status,
            one_sentence_judgment: archive.one_sentence_judgment || '',
            risk_basis: compactText(archive.risk_basis, 180),
            experience_note: compactText(archive.experience_note, 180),
            updated_at: archive.updated_at
          })),
          cycles: cycles.map((cycle: any) => ({
            id: String(cycle.id),
            object_name: cycle.object_name || '',
            variant_name: cycle.variant_name || '',
            cycle_stage: cycle.cycle_stage || '',
            cycle_pattern: cycle.cycle_pattern || '',
            rise_nature: cycle.rise_nature || '',
            market_background: cycle.market_background || '',
            open_level: cycle.open_level || '',
            high_price: cycle.high_price ?? null,
            current_price: cycle.current_price ?? null,
            summary: compactText(cycle.summary, 180),
            lesson: compactText(cycle.lesson, 180),
            updated_at: cycle.updated_at
          })),
          latest_prices: (priceSnapshot.latest || []).map((record: any) => ({
            id: String(record.id),
            date: record.date,
            object_name: record.object_name,
            variant: record.variant || '',
            price: record.price,
            source: record.source || '',
            note: record.note || ''
          }))
        }
      }
    });
  } catch (error) {
    console.error('Error getting annual plan mainline assist:', error);
    res.status(500).json({ success: false, message: '获取年度计划动态主线辅助失败' });
  }
});

// 获取年度计划子项执行纪律辅助
router.get('/annual-plan-items/:id/execution-discipline-assist', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const item = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);

    if (!item) {
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }

    const objectTerms = splitSearchTerms(item.object_name);
    const [priceSeries, anchorSeries, positions, buyPlans, sellPlans] = await Promise.all([
      loadDisciplinePriceSeries(db, item, objectTerms),
      loadMarketAnchorSeries(db, item),
      loadDisciplinePositions(db, item, objectTerms),
      loadDisciplinePlans(db, item, objectTerms, 'buying_plans'),
      loadDisciplinePlans(db, item, objectTerms, 'selling_plans')
    ]);

    const assist = summarizeExecutionDisciplineAssist(
      item,
      priceSeries,
      anchorSeries,
      positions,
      buyPlans,
      sellPlans
    );

    res.json({
      success: true,
      data: {
        generated_at: new Date().toISOString(),
        item: {
          id: String(item.id),
          plan_id: String(item.plan_id),
          scope_type: item.scope_type,
          category: item.category,
          object_name: item.object_name || '',
          current_role: item.current_role,
          current_action: item.current_action,
          current_status: item.current_status,
          priority_order: item.priority_order ?? null
        },
        ...assist
      }
    });
  } catch (error) {
    console.error('Error getting annual plan execution discipline assist:', error);
    res.status(500).json({ success: false, message: '获取年度计划执行纪律辅助失败' });
  }
});

// 获取年度计划子项详情
router.get('/annual-plan-items/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const record = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error getting annual plan item:', error);
    res.status(500).json({ success: false, message: '获取年度计划子项详情失败' });
  }
});

// 获取年度计划子项的变更记录
router.get('/annual-plan-items/:id/changes', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 验证子项是否存在
    const itemExists = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);
    if (!itemExists) {
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }
    
    const changes = await db.all('SELECT * FROM annual_plan_item_changes WHERE plan_item_id = ? ORDER BY change_date DESC, created_at DESC', [id]);
    res.json({ success: true, data: changes });
  } catch (error) {
    console.error('Error getting annual plan item changes:', error);
    res.status(500).json({ success: false, message: '获取年度计划子项变更记录失败' });
  }
});

// 更新年度计划子项
router.put('/annual-plan-items/:id', async (req, res) => {
  let db: any;
  let transactionStarted = false;
  try {
    db = await getDb();
    const { id } = req.params;
    const body = req.body || {};
    
    // 验证记录是否存在
    const existingRecord = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }

    const pickValue = (key: string, fallback: any) => (
      Object.prototype.hasOwnProperty.call(body, key) ? body[key] : fallback
    );
    const planId = pickValue('plan_id', existingRecord.plan_id);
    if (planId === undefined || planId === null || String(planId).trim() === '') {
      return res.status(400).json({ success: false, message: '缺少必填字段: plan_id' });
    }
    
    // 验证计划是否存在
    const planExists = await db.get('SELECT * FROM annual_plans WHERE id = ? AND is_deleted = 0', [planId]);
    if (!planExists) {
      return res.status(404).json({ success: false, message: '关联的年度计划不存在' });
    }

    const mergedItemPayload = {
      scope_type: pickValue('scope_type', existingRecord.scope_type),
      category: pickValue('category', existingRecord.category),
      object_name: pickValue('object_name', existingRecord.object_name),
      current_role: pickValue('current_role', existingRecord.current_role),
      current_action: pickValue('current_action', existingRecord.current_action),
      current_status: pickValue('current_status', existingRecord.current_status)
    };
    const thesisValue = pickValue('thesis', existingRecord.thesis);
    const currentReasonValue = pickValue('current_reason', existingRecord.current_reason);
    const positionRuleValue = pickValue('position_rule', existingRecord.position_rule);
    const exitRuleValue = pickValue('exit_rule', existingRecord.exit_rule);
    const downgradeReasonValue = pickValue('downgrade_reason', existingRecord.downgrade_reason);
    const resumeConditionValue = pickValue('resume_condition', existingRecord.resume_condition);
    const noteValue = pickValue('note', existingRecord.note);

    const normalizedPriorityOrder = normalizePriorityOrder(pickValue('priority_order', existingRecord.priority_order));
    if (!normalizedPriorityOrder.ok) {
      return res.status(400).json({ success: false, message: '优先级必须是正整数或留空' });
    }

    const normalizedItem = await normalizeAnnualPlanItemPayload(db, mergedItemPayload);
    if ('error' in normalizedItem) {
      return res.status(400).json({ success: false, message: normalizedItem.error });
    }
    
    const roleChanged = existingRecord.current_role !== normalizedItem.value.currentRole;
    const actionChanged = existingRecord.current_action !== normalizedItem.value.currentAction;
    const statusChanged = existingRecord.current_status !== normalizedItem.value.currentStatus;
    const shouldCreateChangeRecord = Boolean(roleChanged || actionChanged || statusChanged);
    const changeRecord = req.body?.adjustment_record ?? {};
    const changeDate = String(changeRecord.change_date || new Date().toISOString().slice(0, 10)).trim();
    if (shouldCreateChangeRecord && !isValidDateOnly(changeDate)) {
      return res.status(400).json({ success: false, message: '变更日期格式错误' });
    }

    const now = new Date().toISOString();
    await db.run('BEGIN TRANSACTION');
    transactionStarted = true;
    const result = await db.run(
      'UPDATE annual_plan_items SET plan_id = ?, scope_type = ?, category = ?, object_name = ?, current_role = ?, current_action = ?, current_status = ?, thesis = ?, current_reason = ?, position_rule = ?, exit_rule = ?, downgrade_reason = ?, resume_condition = ?, priority_order = ?, note = ?, updated_at = ? WHERE id = ? AND is_deleted = 0',
      [
        planId,
        normalizedItem.value.scopeType,
        normalizedItem.value.category,
        normalizedItem.value.objectName,
        normalizedItem.value.currentRole,
        normalizedItem.value.currentAction,
        normalizedItem.value.currentStatus,
        thesisValue,
        currentReasonValue,
        positionRuleValue,
        exitRuleValue,
        downgradeReasonValue,
        resumeConditionValue,
        normalizedPriorityOrder.value,
        noteValue,
        now,
        id
      ]
    );

    if ((result.changes ?? 0) === 0) {
      await db.run('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }

    if (shouldCreateChangeRecord) {
      await db.run(
        `INSERT INTO annual_plan_item_changes (
          plan_item_id, change_date, change_type,
          old_role, new_role, old_action, new_action, old_status, new_status,
          reason, trigger_condition, evidence_note, decision_note, next_action,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          changeDate,
          changeRecord.change_type || inferAnnualPlanChangeType(existingRecord, normalizedItem.value),
          existingRecord.current_role,
          normalizedItem.value.currentRole,
          existingRecord.current_action,
          normalizedItem.value.currentAction,
          existingRecord.current_status,
          normalizedItem.value.currentStatus,
          changeRecord.reason ?? currentReasonValue ?? '',
          changeRecord.trigger_condition ?? '',
          changeRecord.evidence_note ?? '',
          changeRecord.decision_note ?? '',
          changeRecord.next_action ?? '',
          now,
          now
        ]
      );
    }

    await db.run('COMMIT');
    transactionStarted = false;

    const updatedRecord = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);
    
    res.json({ success: true, data: updatedRecord });
  } catch (error) {
    if (transactionStarted && db) {
      try {
        await db.run('ROLLBACK');
      } catch (rollbackError) {
        console.error('Error rolling back annual plan item update:', rollbackError);
      }
    }
    console.error('Error updating annual plan item:', error);
    res.status(500).json({ success: false, message: '更新年度计划子项失败' });
  }
});

// 软删除年度计划子项
router.delete('/annual-plan-items/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    const existingRecord = await db.get('SELECT * FROM annual_plan_items WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '年度计划子项不存在' });
    }
    
    const now = new Date().toISOString();
    const result = await db.run('UPDATE annual_plan_items SET is_deleted = 1, updated_at = ? WHERE id = ? AND is_deleted = 0', [now, id]);
    
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting annual plan item:', error);
    res.status(500).json({ success: false, message: '删除年度计划子项失败' });
  }
});

export default router;
