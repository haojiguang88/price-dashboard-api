import express from 'express';
import getDb from '../config/database';
import { validateOptionalDateOnly, validateRequiredDateOnlyOrLocalDateTime } from '../utils/dateValidation';

const router = express.Router();

const normalizeText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const normalizeNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const recordDateFields = [
  ['launch_date', '发售日期'],
  ['expected_arrival_date', '预计到货'],
  ['actual_arrival_date', '实际到货']
] as const;

const validateRecordDates = (body: any): string => {
  for (const [field, label] of recordDateFields) {
    const validation = validateOptionalDateOnly(body?.[field], label);
    if (!validation.ok) return validation.message;
    body[field] = validation.value || '';
  }
  return '';
};

const recordFields = [
  'category_name',
  'object_name',
  'variant_name',
  'launch_date',
  'official_price',
  'open_price',
  'high_price',
  'low_price',
  'current_price',
  'open_level',
  'release_quantity',
  'total_quantity',
  'first_release_quantity',
  'first_release_status',
  'official_first_release',
  'market_background',
  'cycle_stage',
  'cycle_pattern',
  'rise_nature',
  'main_participants',
  'expected_arrival_date',
  'actual_arrival_date',
  'arrival_scale',
  'supply_release_type',
  'high_level_real_demand',
  'final_result',
  'future_action_rule',
  'experience_tags',
  'summary',
  'lesson',
  'note'
];

const eventFields = [
  'cycle_id',
  'record_time',
  'price',
  'bid_price_band',
  'price_type',
  'stage',
  'market_action',
  'sentiment_level',
  'participation_level',
  'buyer_strength',
  'seller_pressure',
  'discussion_heat',
  'wall_pressure',
  'sweep_strength',
  'trigger_event',
  'risk_signal',
  'experience_tags',
  'source',
  'note'
];

const mapRecordPayload = (body: any) => [
  normalizeText(body.category_name),
  normalizeText(body.object_name),
  normalizeText(body.variant_name),
  normalizeText(body.launch_date),
  normalizeNumber(body.official_price),
  normalizeNumber(body.open_price),
  normalizeNumber(body.high_price),
  normalizeNumber(body.low_price),
  normalizeNumber(body.current_price),
  normalizeText(body.open_level) || '中开',
  normalizeText(body.release_quantity) || '未知',
  normalizeText(body.total_quantity) || '未知',
  normalizeText(body.first_release_quantity) || normalizeText(body.first_release_status) || '未知',
  normalizeText(body.first_release_status) || '未知',
  normalizeText(body.official_first_release) || '未知',
  normalizeText(body.market_background) || '未知',
  normalizeText(body.cycle_stage),
  normalizeText(body.cycle_pattern),
  normalizeText(body.rise_nature),
  normalizeText(body.main_participants),
  normalizeText(body.expected_arrival_date),
  normalizeText(body.actual_arrival_date),
  normalizeText(body.arrival_scale),
  normalizeText(body.supply_release_type),
  normalizeText(body.high_level_real_demand),
  normalizeText(body.final_result),
  normalizeText(body.future_action_rule),
  normalizeText(body.experience_tags),
  normalizeText(body.summary),
  normalizeText(body.lesson),
  normalizeText(body.note)
];

const mapEventPayload = (cycleId: number, body: any) => [
  cycleId,
  normalizeText(body.record_time),
  normalizeNumber(body.price),
  normalizeText(body.bid_price_band),
  normalizeText(body.price_type),
  normalizeText(body.stage),
  normalizeText(body.market_action),
  normalizeText(body.sentiment_level),
  normalizeText(body.participation_level),
  normalizeText(body.buyer_strength),
  normalizeText(body.seller_pressure),
  normalizeText(body.discussion_heat),
  normalizeText(body.wall_pressure),
  normalizeText(body.sweep_strength),
  normalizeText(body.trigger_event),
  normalizeText(body.risk_signal),
  normalizeText(body.experience_tags),
  normalizeText(body.source),
  normalizeText(body.note)
];

router.get('/speculation-cycles', async (req, res) => {
  try {
    const db = await getDb();
    const { q, category_name, cycle_pattern, cycle_stage, future_action_rule, experience_tag } = req.query;
    const params: any[] = [];
    let where = 'WHERE 1=1';

    if (q) {
      where += ` AND (
        r.category_name LIKE ? OR r.object_name LIKE ? OR r.variant_name LIKE ? OR
        r.cycle_pattern LIKE ? OR r.rise_nature LIKE ? OR r.main_participants LIKE ? OR
        r.experience_tags LIKE ? OR r.summary LIKE ? OR r.lesson LIKE ? OR r.note LIKE ?
      )`;
      const term = `%${q}%`;
      params.push(term, term, term, term, term, term, term, term, term, term);
    }
    if (category_name) {
      where += ' AND r.category_name = ?';
      params.push(category_name);
    }
    if (cycle_pattern) {
      where += ' AND r.cycle_pattern LIKE ?';
      params.push(`%${cycle_pattern}%`);
    }
    if (cycle_stage) {
      where += ' AND r.cycle_stage = ?';
      params.push(cycle_stage);
    }
    if (future_action_rule) {
      where += ' AND r.future_action_rule = ?';
      params.push(future_action_rule);
    }
    if (experience_tag) {
      where += ' AND r.experience_tags LIKE ?';
      params.push(`%${experience_tag}%`);
    }

    const records = await db.all(`
      SELECT r.*,
             COUNT(e.id) AS event_count,
             MAX(e.record_time) AS latest_event_time
      FROM speculation_cycle_records r
      LEFT JOIN speculation_cycle_events e ON e.cycle_id = r.id
      ${where}
      GROUP BY r.id
      ORDER BY COALESCE(MAX(e.record_time), r.updated_at, r.created_at) DESC, r.id DESC
    `, params);

    res.json({ success: true, data: records });
  } catch (error) {
    console.error('查询周期模式记录失败:', error);
    res.status(500).json({ success: false, message: '查询周期模式记录失败' });
  }
});

router.post('/speculation-cycles', async (req, res) => {
  try {
    const db = await getDb();
    if (!normalizeText(req.body.category_name) || !normalizeText(req.body.object_name)) {
      return res.status(400).json({ success: false, message: '缺少必填字段: category_name, object_name' });
    }
    const dateError = validateRecordDates(req.body);
    if (dateError) {
      return res.status(400).json({ success: false, message: dateError });
    }

    const placeholders = recordFields.map(() => '?').join(', ');
    const result = await db.run(`
      INSERT INTO speculation_cycle_records (${recordFields.join(', ')})
      VALUES (${placeholders})
    `, mapRecordPayload(req.body));

    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('新增周期模式记录失败:', error);
    res.status(500).json({ success: false, message: '新增周期模式记录失败' });
  }
});

router.get('/speculation-cycles/:id', async (req, res) => {
  try {
    const db = await getDb();
    const record = await db.get('SELECT * FROM speculation_cycle_records WHERE id = ?', [req.params.id]);
    if (!record) {
      return res.status(404).json({ success: false, message: '周期模式记录不存在' });
    }

    const events = await db.all(
      'SELECT * FROM speculation_cycle_events WHERE cycle_id = ? ORDER BY record_time ASC, id ASC',
      [req.params.id]
    );

    res.json({ success: true, data: { record, events } });
  } catch (error) {
    console.error('查询周期模式详情失败:', error);
    res.status(500).json({ success: false, message: '查询周期模式详情失败' });
  }
});

router.put('/speculation-cycles/:id', async (req, res) => {
  try {
    const db = await getDb();
    const existing = await db.get('SELECT id FROM speculation_cycle_records WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, message: '周期模式记录不存在' });
    }
    if (!normalizeText(req.body.category_name) || !normalizeText(req.body.object_name)) {
      return res.status(400).json({ success: false, message: '缺少必填字段: category_name, object_name' });
    }
    const dateError = validateRecordDates(req.body);
    if (dateError) {
      return res.status(400).json({ success: false, message: dateError });
    }

    const assignments = recordFields.map(field => `${field} = ?`).join(', ');
    const result = await db.run(`
      UPDATE speculation_cycle_records
      SET ${assignments}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [...mapRecordPayload(req.body), req.params.id]);

    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('编辑周期模式记录失败:', error);
    res.status(500).json({ success: false, message: '编辑周期模式记录失败' });
  }
});

router.delete('/speculation-cycles/:id', async (req, res) => {
  const db = await getDb();
  try {
    await db.run('BEGIN TRANSACTION');
    await db.run('DELETE FROM speculation_cycle_events WHERE cycle_id = ?', [req.params.id]);
    const result = await db.run('DELETE FROM speculation_cycle_records WHERE id = ?', [req.params.id]);
    await db.run('COMMIT');
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('删除周期模式记录失败:', error);
    res.status(500).json({ success: false, message: '删除周期模式记录失败' });
  }
});

router.post('/speculation-cycles/:id/events', async (req, res) => {
  try {
    const db = await getDb();
    const cycleId = Number(req.params.id);
    const record = await db.get('SELECT id FROM speculation_cycle_records WHERE id = ?', [cycleId]);
    if (!record) {
      return res.status(404).json({ success: false, message: '周期模式记录不存在' });
    }
    const recordTime = validateRequiredDateOnlyOrLocalDateTime(req.body.record_time, '节点时间');
    if (!recordTime.ok) {
      return res.status(400).json({ success: false, message: recordTime.message });
    }
    req.body.record_time = recordTime.value;

    const placeholders = eventFields.map(() => '?').join(', ');
    const result = await db.run(`
      INSERT INTO speculation_cycle_events (${eventFields.join(', ')})
      VALUES (${placeholders})
    `, mapEventPayload(cycleId, req.body));
    await db.run('UPDATE speculation_cycle_records SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [cycleId]);

    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('新增周期过程节点失败:', error);
    res.status(500).json({ success: false, message: '新增周期过程节点失败' });
  }
});

router.put('/speculation-cycles/:id/events/:eventId', async (req, res) => {
  try {
    const db = await getDb();
    const cycleId = Number(req.params.id);
    const existing = await db.get(
      'SELECT id FROM speculation_cycle_events WHERE id = ? AND cycle_id = ?',
      [req.params.eventId, cycleId]
    );
    if (!existing) {
      return res.status(404).json({ success: false, message: '周期过程节点不存在' });
    }
    const recordTime = validateRequiredDateOnlyOrLocalDateTime(req.body.record_time, '节点时间');
    if (!recordTime.ok) {
      return res.status(400).json({ success: false, message: recordTime.message });
    }
    req.body.record_time = recordTime.value;

    const assignments = eventFields.filter(field => field !== 'cycle_id').map(field => `${field} = ?`).join(', ');
    const values = mapEventPayload(cycleId, req.body).slice(1);
    const result = await db.run(`
      UPDATE speculation_cycle_events
      SET ${assignments}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND cycle_id = ?
    `, [...values, req.params.eventId, cycleId]);
    await db.run('UPDATE speculation_cycle_records SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [cycleId]);

    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('编辑周期过程节点失败:', error);
    res.status(500).json({ success: false, message: '编辑周期过程节点失败' });
  }
});

router.delete('/speculation-cycles/:id/events/:eventId', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.run(
      'DELETE FROM speculation_cycle_events WHERE id = ? AND cycle_id = ?',
      [req.params.eventId, req.params.id]
    );
    await db.run('UPDATE speculation_cycle_records SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('删除周期过程节点失败:', error);
    res.status(500).json({ success: false, message: '删除周期过程节点失败' });
  }
});

export default router;
