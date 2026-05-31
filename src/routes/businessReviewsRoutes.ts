import express from 'express';
import getDb from '../config/database';

const router = express.Router();

const textOrNull = (value: unknown) => {
  const normalized = String(value ?? '').trim();
  return normalized || null;
};

const positiveInt = (value: unknown, fallback: number, max: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const ensureBusinessReviewsTable = async (db: any) => {
  const businessTable = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'business_reviews'"
  );
  const oldTradeTable = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trade_reviews'"
  );

  if (!businessTable && oldTradeTable) {
    await db.exec('ALTER TABLE trade_reviews RENAME TO business_reviews');
    return;
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS business_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      track TEXT NOT NULL,
      project_name TEXT,
      review_date TEXT,
      result_type TEXT,
      summary_conclusion TEXT,
      background TEXT,
      judgment_at_that_time TEXT,
      action_at_that_time TEXT,
      later_outcome TEXT,
      root_cause_type TEXT,
      exposed_problem TEXT,
      extracted_lesson TEXT,
      short_lesson TEXT,
      note TEXT,
      is_deleted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
};

const selectFields = `
  id,
  title,
  track,
  project_name,
  review_date,
  result_type,
  summary_conclusion,
  background,
  judgment_at_that_time,
  action_at_that_time,
  later_outcome,
  root_cause_type,
  exposed_problem,
  extracted_lesson,
  short_lesson,
  note,
  created_at,
  updated_at
`;

const getBusinessReviewById = async (db: any, id: string | number) => {
  await ensureBusinessReviewsTable(db);
  return db.get(
    `SELECT ${selectFields}
     FROM business_reviews
     WHERE id = ? AND COALESCE(is_deleted, 0) = 0`,
    [id]
  );
};

router.get('/business-reviews', async (req, res) => {
  try {
    const db = await getDb();
    await ensureBusinessReviewsTable(db);

    const page = positiveInt(req.query.page, 1, 100000);
    const pageSize = positiveInt(req.query.pageSize, 20, 500);
    const offset = (page - 1) * pageSize;
    const keyword = textOrNull(req.query.q);
    const track = textOrNull(req.query.track);
    const params: any[] = [];
    let whereClause = 'WHERE COALESCE(is_deleted, 0) = 0';

    if (track) {
      whereClause += ' AND track = ?';
      params.push(track);
    }
    if (textOrNull(req.query.start_date)) {
      whereClause += ' AND review_date >= ?';
      params.push(textOrNull(req.query.start_date));
    }
    if (textOrNull(req.query.end_date)) {
      whereClause += ' AND review_date <= ?';
      params.push(textOrNull(req.query.end_date));
    }
    if (keyword) {
      const like = `%${keyword}%`;
      whereClause += ' AND (title LIKE ? OR track LIKE ? OR project_name LIKE ? OR result_type LIKE ? OR summary_conclusion LIKE ? OR short_lesson LIKE ? OR note LIKE ?)';
      params.push(like, like, like, like, like, like, like);
    }

    const totalRow = await db.get(`SELECT COUNT(1) as total FROM business_reviews ${whereClause}`, params);
    const records = await db.all(
      `SELECT ${selectFields}
       FROM business_reviews
       ${whereClause}
       ORDER BY review_date DESC, created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({
      success: true,
      data: {
        items: records,
        total: Number(totalRow?.total || 0),
        page,
        pageSize
      }
    });
  } catch (error) {
    console.error('Error fetching business reviews:', error);
    res.status(500).json({ success: false, message: '获取买卖复盘列表失败' });
  }
});

router.get('/business-reviews/:id', async (req, res) => {
  try {
    const db = await getDb();
    const record = await getBusinessReviewById(db, req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, message: '买卖复盘不存在' });
    }
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error fetching business review details:', error);
    res.status(500).json({ success: false, message: '获取买卖复盘详情失败' });
  }
});

router.post('/business-reviews', async (req, res) => {
  try {
    const db = await getDb();
    await ensureBusinessReviewsTable(db);

    const title = textOrNull(req.body?.title);
    const track = textOrNull(req.body?.track);
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }

    const now = new Date().toISOString();
    const result = await db.run(
      `INSERT INTO business_reviews
       (title, track, project_name, review_date, result_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        title,
        track,
        textOrNull(req.body?.project_name),
        textOrNull(req.body?.review_date),
        textOrNull(req.body?.result_type),
        textOrNull(req.body?.summary_conclusion),
        textOrNull(req.body?.background),
        textOrNull(req.body?.judgment_at_that_time),
        textOrNull(req.body?.action_at_that_time),
        textOrNull(req.body?.later_outcome),
        textOrNull(req.body?.root_cause_type),
        textOrNull(req.body?.exposed_problem),
        textOrNull(req.body?.extracted_lesson),
        textOrNull(req.body?.short_lesson),
        textOrNull(req.body?.note),
        now,
        now
      ]
    );
    if (!result.lastID) {
      return res.status(500).json({ success: false, message: '新增买卖复盘失败' });
    }
    const createdRecord = await getBusinessReviewById(db, result.lastID);
    res.json({ success: true, data: createdRecord });
  } catch (error) {
    console.error('Error creating business review:', error);
    res.status(500).json({ success: false, message: '新增买卖复盘失败' });
  }
});

router.put('/business-reviews/:id', async (req, res) => {
  try {
    const db = await getDb();
    await ensureBusinessReviewsTable(db);

    const existingRecord = await getBusinessReviewById(db, req.params.id);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '买卖复盘不存在' });
    }

    const title = textOrNull(req.body?.title);
    const track = textOrNull(req.body?.track);
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }

    const now = new Date().toISOString();
    await db.run(
      `UPDATE business_reviews
       SET title = ?, track = ?, project_name = ?, review_date = ?, result_type = ?, summary_conclusion = ?, background = ?, judgment_at_that_time = ?, action_at_that_time = ?, later_outcome = ?, root_cause_type = ?, exposed_problem = ?, extracted_lesson = ?, short_lesson = ?, note = ?, updated_at = ?
       WHERE id = ?`,
      [
        title,
        track,
        textOrNull(req.body?.project_name),
        textOrNull(req.body?.review_date),
        textOrNull(req.body?.result_type),
        textOrNull(req.body?.summary_conclusion),
        textOrNull(req.body?.background),
        textOrNull(req.body?.judgment_at_that_time),
        textOrNull(req.body?.action_at_that_time),
        textOrNull(req.body?.later_outcome),
        textOrNull(req.body?.root_cause_type),
        textOrNull(req.body?.exposed_problem),
        textOrNull(req.body?.extracted_lesson),
        textOrNull(req.body?.short_lesson),
        textOrNull(req.body?.note),
        now,
        req.params.id
      ]
    );
    const updatedRecord = await getBusinessReviewById(db, req.params.id);
    res.json({ success: true, data: updatedRecord });
  } catch (error) {
    console.error('Error updating business review:', error);
    res.status(500).json({ success: false, message: '编辑买卖复盘失败' });
  }
});

router.delete('/business-reviews/:id', async (req, res) => {
  try {
    const db = await getDb();
    const existingRecord = await getBusinessReviewById(db, req.params.id);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '买卖复盘不存在' });
    }

    const result = await db.run(
      'UPDATE business_reviews SET is_deleted = 1, updated_at = ? WHERE id = ?',
      [new Date().toISOString(), req.params.id]
    );
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting business review:', error);
    res.status(500).json({ success: false, message: '删除买卖复盘失败' });
  }
});

export default router;
