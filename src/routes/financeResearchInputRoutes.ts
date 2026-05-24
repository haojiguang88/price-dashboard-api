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
