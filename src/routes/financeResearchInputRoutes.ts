import { Router, Request, Response } from 'express';
import getDb from '../config/database';

const router = Router();

const parseTags = (value: any) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(item => String(item).trim()).filter(Boolean) : [];
  } catch {
    return String(value)
      .split(/[,\s，、]+/)
      .map(item => item.trim())
      .filter(Boolean);
  }
};

const serializeTags = (value: any) => JSON.stringify(parseTags(value));

const decorateRow = (row: any) => ({
  ...row,
  tags: parseTags(row.tags_json)
});

async function ensureFinanceResearchInputTable(db: any) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS finance_research_inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      name TEXT,
      asset_type TEXT NOT NULL DEFAULT 'stock',
      visible_date TEXT NOT NULL,
      report_date TEXT,
      source_type TEXT,
      finance_change TEXT,
      industry_logic TEXT,
      capital_consensus TEXT,
      evidence_source TEXT,
      certainty TEXT NOT NULL DEFAULT 'unknown',
      tags_json TEXT,
      notes TEXT,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_finance_research_inputs_scope
    ON finance_research_inputs(visible_date DESC, symbol, asset_type, is_archived);
  `);
}

async function ensureFinancialReportStructuredTable(db: any) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS financial_report_structured (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      name TEXT,
      source TEXT NOT NULL DEFAULT 'tushare',
      end_date TEXT NOT NULL,
      ann_date TEXT,
      f_ann_date TEXT,
      report_type TEXT,
      comp_type TEXT,
      total_revenue REAL,
      revenue REAL,
      operate_profit REAL,
      total_profit REAL,
      net_profit REAL,
      net_profit_parent REAL,
      basic_eps REAL,
      total_assets REAL,
      total_liab REAL,
      total_equity REAL,
      money_cap REAL,
      inventories REAL,
      accounts_receiv REAL,
      contract_liab REAL,
      n_cashflow_act REAL,
      c_fr_sale_sg REAL,
      free_cashflow REAL,
      roe REAL,
      grossprofit_margin REAL,
      netprofit_margin REAL,
      debt_to_assets REAL,
      current_ratio REAL,
      quick_ratio REAL,
      revenue_yoy REAL,
      netprofit_yoy REAL,
      ocf_yoy REAL,
      ocf_to_net_profit REAL,
      raw_income_json TEXT,
      raw_balance_json TEXT,
      raw_cashflow_json TEXT,
      raw_indicator_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(symbol, source, end_date)
    );

    CREATE INDEX IF NOT EXISTS idx_financial_report_structured_period
    ON financial_report_structured(end_date DESC, source, symbol);

    CREATE INDEX IF NOT EXISTS idx_financial_report_structured_visible
    ON financial_report_structured(f_ann_date DESC, ann_date DESC, symbol);
  `);
}

const toOptionalDate = (value: any) => {
  const text = String(value || '').trim();
  return text ? text.slice(0, 10) : '';
};

const formatPercent = (value: any, digits = 1) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return `${number.toFixed(Math.abs(number) >= 100 ? 0 : digits)}%`;
};

const formatYuanAmount = (value: any) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const abs = Math.abs(number);
  if (abs >= 100000000) return `${(number / 100000000).toFixed(abs >= 10000000000 ? 0 : 1)}亿`;
  if (abs >= 10000) return `${(number / 10000).toFixed(abs >= 1000000 ? 0 : 1)}万`;
  return `${number.toFixed(0)}`;
};

const buildFinanceChange = (fact: any) => {
  const revenue = fact.total_revenue ?? fact.revenue;
  const profit = fact.net_profit_parent ?? fact.net_profit;
  const parts = [
    `报告期 ${fact.end_date}`,
    fact.f_ann_date || fact.ann_date ? `公告可见 ${fact.f_ann_date || fact.ann_date}` : '',
    revenue != null ? `营收 ${formatYuanAmount(revenue)}` : '',
    fact.revenue_yoy != null ? `营收同比 ${formatPercent(fact.revenue_yoy)}` : '',
    profit != null ? `归母/净利 ${formatYuanAmount(profit)}` : '',
    fact.netprofit_yoy != null ? `净利同比 ${formatPercent(fact.netprofit_yoy)}` : '',
    fact.grossprofit_margin != null ? `毛利率 ${formatPercent(fact.grossprofit_margin)}` : '',
    fact.roe != null ? `ROE ${formatPercent(fact.roe)}` : '',
    fact.n_cashflow_act != null ? `经营现金流 ${formatYuanAmount(fact.n_cashflow_act)}` : '',
    fact.ocf_to_net_profit != null ? `经营现金流/净利 ${(Number(fact.ocf_to_net_profit) * 100).toFixed(0)}%` : '',
    fact.debt_to_assets != null ? `资产负债率 ${formatPercent(fact.debt_to_assets)}` : ''
  ].filter(Boolean);
  return `${parts.join('；')}。需人工对照公告原文确认是否一次性因素、会计调整或非经常损益。`;
};

async function buildIndustryLogic(db: any, fact: any) {
  try {
    const industry = await db.get(
      `SELECT l1_name, l2_name, l3_name
       FROM financial_sw_industry_members
       WHERE symbol = ?
         AND src = 'SW2021'
       ORDER BY CASE is_new WHEN 'Y' THEN 0 ELSE 1 END, id DESC
       LIMIT 1`,
      [fact.symbol]
    );
    const chain = [industry?.l1_name, industry?.l2_name, industry?.l3_name].filter(Boolean).join(' / ');
    if (chain) {
      return `申万行业：${chain}。需人工补充公司在产业链中的真实受益位置、订单/产能/客户变化，以及是否有利润兑现。`;
    }
  } catch {
    // Optional supplemental industry table may not exist yet.
  }
  return '待人工补充产业链位置、真实受益环节、订单/产能/客户变化，以及是否只是蹭概念。';
}

async function buildCapitalConsensus(db: any, fact: any) {
  const visibleDate = fact.f_ann_date || fact.ann_date || fact.end_date;
  try {
    const basic = await db.get(
      `SELECT trade_date, turnover_rate, turnover_rate_f, pe_ttm, pb, total_mv_yuan
       FROM financial_stock_basic_metrics
       WHERE symbol = ?
         AND source = 'tushare'
         AND trade_date <= ?
       ORDER BY trade_date DESC
       LIMIT 1`,
      [fact.symbol, visibleDate]
    );
    if (basic) {
      const turnover = basic.turnover_rate_f ?? basic.turnover_rate;
      const parts = [
        `公告前最近交易日 ${basic.trade_date}`,
        turnover != null ? `换手 ${formatPercent(turnover)}` : '',
        basic.pe_ttm != null ? `PE(TTM) ${Number(basic.pe_ttm).toFixed(1)}` : '',
        basic.pb != null ? `PB ${Number(basic.pb).toFixed(2)}` : '',
        basic.total_mv_yuan != null ? `总市值 ${formatYuanAmount(basic.total_mv_yuan)}` : ''
      ].filter(Boolean);
      return `${parts.join('；')}。公告后是否被重新定价，需要人工结合成交额放大、板块扩散、龙头确认和回撤承接补充。`;
    }
  } catch {
    // Optional daily metrics table may not exist yet.
  }
  return '待人工补充公告后成交额、换手、板块扩散、龙头确认和回撤承接。';
}

const readPayload = (body: any) => ({
  symbol: String(body?.symbol || '').trim(),
  name: String(body?.name || '').trim() || null,
  asset_type: String(body?.asset_type || body?.assetType || 'stock').trim() || 'stock',
  visible_date: String(body?.visible_date || body?.visibleDate || '').trim(),
  report_date: String(body?.report_date || body?.reportDate || '').trim() || null,
  source_type: String(body?.source_type || body?.sourceType || '').trim() || null,
  finance_change: String(body?.finance_change || body?.financeChange || '').trim() || null,
  industry_logic: String(body?.industry_logic || body?.industryLogic || '').trim() || null,
  capital_consensus: String(body?.capital_consensus || body?.capitalConsensus || '').trim() || null,
  evidence_source: String(body?.evidence_source || body?.evidenceSource || '').trim() || null,
  certainty: String(body?.certainty || 'unknown').trim() || 'unknown',
  tags_json: serializeTags(body?.tags ?? body?.tags_json ?? body?.tagsText),
  notes: String(body?.notes || '').trim() || null
});

router.get('/research-inputs/report-facts', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinancialReportStructuredTable(db);
    const query = String(req.query.query || '').trim();
    const period = toOptionalDate(req.query.period);
    const limit = Math.min(Math.max(Number(req.query.limit || 30), 5), 100);
    const clauses = [`source = 'tushare'`];
    const params: any[] = [];
    if (query) {
      clauses.push(`(symbol LIKE ? OR name LIKE ?)`);
      const like = `%${query}%`;
      params.push(like, like);
    }
    if (period) {
      clauses.push(`end_date = ?`);
      params.push(period);
    }
    const rows = await db.all(
      `SELECT *
       FROM financial_report_structured
       WHERE ${clauses.join(' AND ')}
       ORDER BY end_date DESC, COALESCE(f_ann_date, ann_date, '') DESC, symbol ASC
       LIMIT ?`,
      [...params, limit]
    );
    res.json({
      success: true,
      data: rows.map((row: any) => ({
        ...row,
        visible_date: row.f_ann_date || row.ann_date || null,
        summary: buildFinanceChange(row)
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `读取财报结构化字段失败：${(error as Error).message}` });
  }
});

router.post('/research-inputs/from-report', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceResearchInputTable(db);
    await ensureFinancialReportStructuredTable(db);
    const factId = Number(req.body?.fact_id || req.body?.factId || 0);
    const symbol = String(req.body?.symbol || '').trim();
    const endDate = toOptionalDate(req.body?.end_date || req.body?.endDate);
    const fact = factId
      ? await db.get(`SELECT * FROM financial_report_structured WHERE id = ?`, [factId])
      : await db.get(
        `SELECT *
         FROM financial_report_structured
         WHERE symbol = ?
           AND end_date = ?
           AND source = 'tushare'
         ORDER BY COALESCE(f_ann_date, ann_date, '') DESC, id DESC
         LIMIT 1`,
        [symbol, endDate]
      );
    if (!fact) {
      return res.status(404).json({ success: false, message: '未找到对应财报结构化记录' });
    }
    const visibleDate = fact.f_ann_date || fact.ann_date;
    if (!visibleDate) {
      return res.status(400).json({ success: false, message: '该财报缺少公告可见日期，先补 ann_date / f_ann_date 后再生成研究输入。' });
    }
    const existing = await db.get(
      `SELECT *
       FROM finance_research_inputs
       WHERE symbol = ?
         AND asset_type = 'stock'
         AND visible_date = ?
         AND report_date = ?
         AND source_type = 'financial_report_structured'
         AND is_archived = 0
       ORDER BY id DESC
       LIMIT 1`,
      [fact.symbol, visibleDate, fact.end_date]
    );
    if (existing && req.body?.force !== true) {
      return res.json({ success: true, created: false, data: decorateRow(existing), message: '已存在同一财报期的研究输入草稿。' });
    }

    const industryLogic = await buildIndustryLogic(db, fact);
    const capitalConsensus = await buildCapitalConsensus(db, fact);
    const tags = ['财报结构化', 'Tushare', '待人工摘要'];
    const result = await db.run(
      `INSERT INTO finance_research_inputs (
        symbol, name, asset_type, visible_date, report_date, source_type,
        finance_change, industry_logic, capital_consensus, evidence_source,
        certainty, tags_json, notes
      ) VALUES (?, ?, 'stock', ?, ?, 'financial_report_structured', ?, ?, ?, ?, 'medium', ?, ?)`,
      [
        fact.symbol,
        fact.name || null,
        visibleDate,
        fact.end_date,
        buildFinanceChange(fact),
        industryLogic,
        capitalConsensus,
        'Tushare 财报结构化字段；公告原文链接请用巨潮/交易所公开披露补充。',
        serializeTags(tags),
        '半自动草稿：只沉淀当时可见财报字段和待核对问题，不直接进入交易决策或模型训练标签。'
      ]
    );
    const row = await db.get(`SELECT * FROM finance_research_inputs WHERE id = ?`, [result.lastID]);
    res.json({ success: true, created: true, data: decorateRow(row) });
  } catch (error) {
    res.status(500).json({ success: false, message: `生成财报研究输入草稿失败：${(error as Error).message}` });
  }
});

router.get('/research-inputs', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceResearchInputTable(db);
    const query = String(req.query.query || '').trim();
    const includeArchived = String(req.query.include_archived || req.query.includeArchived || '') === '1';
    const limit = Math.min(Math.max(Number(req.query.limit || 80), 10), 200);
    const params: any[] = [];
    const clauses = includeArchived ? ['1 = 1'] : ['is_archived = 0'];
    if (query) {
      clauses.push(`(
        symbol LIKE ?
        OR name LIKE ?
        OR finance_change LIKE ?
        OR industry_logic LIKE ?
        OR capital_consensus LIKE ?
        OR notes LIKE ?
      )`);
      const like = `%${query}%`;
      params.push(like, like, like, like, like, like);
    }
    const rows = await db.all(
      `SELECT *
       FROM finance_research_inputs
       WHERE ${clauses.join(' AND ')}
       ORDER BY visible_date DESC, updated_at DESC, id DESC
       LIMIT ?`,
      [...params, limit]
    );
    res.json({ success: true, data: rows.map(decorateRow) });
  } catch (error) {
    res.status(500).json({ success: false, message: `读取财报产业输入失败：${(error as Error).message}` });
  }
});

router.post('/research-inputs', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceResearchInputTable(db);
    const payload = readPayload(req.body);
    if (!payload.symbol || !payload.visible_date) {
      return res.status(400).json({ success: false, message: '代码和当时可见日期必填' });
    }
    const result = await db.run(
      `INSERT INTO finance_research_inputs (
        symbol, name, asset_type, visible_date, report_date, source_type,
        finance_change, industry_logic, capital_consensus, evidence_source,
        certainty, tags_json, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.symbol,
        payload.name,
        payload.asset_type,
        payload.visible_date,
        payload.report_date,
        payload.source_type,
        payload.finance_change,
        payload.industry_logic,
        payload.capital_consensus,
        payload.evidence_source,
        payload.certainty,
        payload.tags_json,
        payload.notes
      ]
    );
    const row = await db.get(`SELECT * FROM finance_research_inputs WHERE id = ?`, [result.lastID]);
    res.json({ success: true, data: decorateRow(row) });
  } catch (error) {
    res.status(500).json({ success: false, message: `保存财报产业输入失败：${(error as Error).message}` });
  }
});

router.put('/research-inputs/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceResearchInputTable(db);
    const id = Number(req.params.id);
    const payload = readPayload(req.body);
    if (!id || !payload.symbol || !payload.visible_date) {
      return res.status(400).json({ success: false, message: '记录、代码和当时可见日期必填' });
    }
    await db.run(
      `UPDATE finance_research_inputs
       SET symbol = ?, name = ?, asset_type = ?, visible_date = ?, report_date = ?, source_type = ?,
           finance_change = ?, industry_logic = ?, capital_consensus = ?, evidence_source = ?,
           certainty = ?, tags_json = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        payload.symbol,
        payload.name,
        payload.asset_type,
        payload.visible_date,
        payload.report_date,
        payload.source_type,
        payload.finance_change,
        payload.industry_logic,
        payload.capital_consensus,
        payload.evidence_source,
        payload.certainty,
        payload.tags_json,
        payload.notes,
        id
      ]
    );
    const row = await db.get(`SELECT * FROM finance_research_inputs WHERE id = ?`, [id]);
    res.json({ success: true, data: decorateRow(row) });
  } catch (error) {
    res.status(500).json({ success: false, message: `更新财报产业输入失败：${(error as Error).message}` });
  }
});

router.delete('/research-inputs/:id', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceResearchInputTable(db);
    await db.run(
      `UPDATE finance_research_inputs
       SET is_archived = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [Number(req.params.id)]
    );
    res.json({ success: true, data: { id: Number(req.params.id), is_archived: 1 } });
  } catch (error) {
    res.status(500).json({ success: false, message: `归档财报产业输入失败：${(error as Error).message}` });
  }
});

export default router;
