import express from 'express';
import getDb from '../config/database';
import { validateRequiredDateOnly } from '../utils/dateValidation';

const router = express.Router();

const VALID_DECISION_STAGES = new Set(['seen', 'risk_checked', 'actively_rejected']);
const VALID_DECISION_QUALITIES = new Set(['valid', 'needs_review', 'unclear']);
const VALID_LATER_STATUSES = new Set(['not_tracked', 'trigger_review', 'reviewed']);
const VALID_REVIEW_CATEGORIES = new Set([
  'correct_reject',
  'rule_false_kill',
  'cognition_gap',
  'information_gap',
  'new_variable',
  'execution_issue',
  'not_my_money'
]);

interface RejectedOpportunityInput {
  title?: unknown;
  track?: unknown;
  project_name?: unknown;
  projectName?: unknown;
  related_object?: unknown;
  relatedObject?: unknown;
  decision_date?: unknown;
  decisionDate?: unknown;
  decision_stage?: unknown;
  decisionStage?: unknown;
  risk_result?: unknown;
  riskResult?: unknown;
  rejection_reason?: unknown;
  rejectionReason?: unknown;
  review_category?: unknown;
  reviewCategory?: unknown;
  information_snapshot?: unknown;
  informationSnapshot?: unknown;
  risk_rules_snapshot?: unknown;
  riskRulesSnapshot?: unknown;
  risk_tolerance?: unknown;
  riskTolerance?: unknown;
  execution_consistency?: unknown;
  executionConsistency?: unknown;
  decision_quality?: unknown;
  decisionQuality?: unknown;
  later_status?: unknown;
  laterStatus?: unknown;
  later_summary?: unknown;
  laterSummary?: unknown;
  review_link?: unknown;
  reviewLink?: unknown;
  note?: unknown;
}

const cleanText = (value: unknown) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
};

const normalizeOpportunity = (body: RejectedOpportunityInput) => {
  const decisionStage = cleanText(body.decision_stage ?? body.decisionStage) || 'actively_rejected';
  const decisionQuality = cleanText(body.decision_quality ?? body.decisionQuality) || 'valid';
  const laterStatus = cleanText(body.later_status ?? body.laterStatus) || 'not_tracked';
  const reviewCategory = cleanText(body.review_category ?? body.reviewCategory) || 'correct_reject';

  return {
    title: cleanText(body.title),
    track: cleanText(body.track),
    projectName: cleanText(body.project_name ?? body.projectName),
    relatedObject: cleanText(body.related_object ?? body.relatedObject),
    decisionDate: cleanText(body.decision_date ?? body.decisionDate),
    decisionStage,
    riskResult: cleanText(body.risk_result ?? body.riskResult),
    rejectionReason: cleanText(body.rejection_reason ?? body.rejectionReason),
    reviewCategory,
    informationSnapshot: cleanText(body.information_snapshot ?? body.informationSnapshot),
    riskRulesSnapshot: cleanText(body.risk_rules_snapshot ?? body.riskRulesSnapshot),
    riskTolerance: cleanText(body.risk_tolerance ?? body.riskTolerance),
    executionConsistency: cleanText(body.execution_consistency ?? body.executionConsistency),
    decisionQuality,
    laterStatus,
    laterSummary: cleanText(body.later_summary ?? body.laterSummary),
    reviewLink: cleanText(body.review_link ?? body.reviewLink),
    note: cleanText(body.note)
  };
};

const validateOpportunity = (item: ReturnType<typeof normalizeOpportunity>) => {
  if (!item.title) return '缺少必填字段: title';
  const decisionDate = validateRequiredDateOnly(item.decisionDate, '决策日期');
  if (!decisionDate.ok) return decisionDate.message;
  item.decisionDate = decisionDate.value;
  if (!item.rejectionReason) return '缺少必填字段: rejection_reason';
  if (!VALID_DECISION_STAGES.has(item.decisionStage)) return '无效的 decision_stage';
  if (!VALID_DECISION_QUALITIES.has(item.decisionQuality)) return '无效的 decision_quality';
  if (!VALID_LATER_STATUSES.has(item.laterStatus)) return '无效的 later_status';
  if (!VALID_REVIEW_CATEGORIES.has(item.reviewCategory)) return '无效的 review_category';
  return '';
};

const writeAuditLog = async (
  db: any,
  action: 'create' | 'update' | 'delete',
  entityId: string | number,
  target: string,
  detail: string
) => {
  try {
    const now = new Date().toISOString();
    await db.run(
      `
        INSERT INTO audit_logs
          (id, timestamp, module, action, target, status, detail, entity_id, path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        now,
        '风控中心',
        action,
        target,
        'success',
        detail,
        String(entityId),
        '/risk-control/rejected-pool',
        now,
        now
      ]
    );
  } catch (error) {
    console.warn('Failed to write rejected opportunity audit log:', error);
  }
};

const selectColumns = `
  id, title, track, project_name, related_object, decision_date,
  decision_stage, risk_result, rejection_reason, review_category, information_snapshot,
  risk_rules_snapshot, risk_tolerance, execution_consistency,
  decision_quality, later_status, later_summary, review_link, note,
  created_at, updated_at
`;

router.get('/rejected-opportunities', async (req, res) => {
  try {
    const db = await getDb();
    const { q, track, decision_stage, decision_quality, review_category, later_status } = req.query;
    const pageNum = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || '10'), 10) || 10, 1), 100);
    const offset = (pageNum - 1) * pageSize;

    const where: string[] = ['is_deleted = 0'];
    const params: string[] = [];

    if (q) {
      where.push(`(
        title LIKE ? OR track LIKE ? OR project_name LIKE ? OR related_object LIKE ?
        OR risk_result LIKE ? OR rejection_reason LIKE ? OR information_snapshot LIKE ?
        OR risk_rules_snapshot LIKE ? OR risk_tolerance LIKE ? OR execution_consistency LIKE ?
        OR later_summary LIKE ? OR review_category LIKE ? OR note LIKE ?
      )`);
      const keyword = `%${String(q).trim()}%`;
      params.push(keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword, keyword);
    }

    if (track) {
      where.push('track = ?');
      params.push(String(track));
    }

    if (decision_stage) {
      where.push('decision_stage = ?');
      params.push(String(decision_stage));
    }

    if (decision_quality) {
      where.push('decision_quality = ?');
      params.push(String(decision_quality));
    }

    if (review_category) {
      where.push('review_category = ?');
      params.push(String(review_category));
    }

    if (later_status) {
      where.push('later_status = ?');
      params.push(String(later_status));
    }

    const whereSql = where.join(' AND ');
    const countResult = await db.get(`SELECT COUNT(*) as total FROM rejected_opportunities WHERE ${whereSql}`, params);
    const items = await db.all(
      `
        SELECT ${selectColumns}
        FROM rejected_opportunities
        WHERE ${whereSql}
        ORDER BY date(decision_date) DESC, datetime(updated_at) DESC, id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
    );

    res.json({
      success: true,
      data: {
        items,
        total: countResult?.total || 0,
        page: pageNum,
        pageSize
      }
    });
  } catch (error) {
    console.error('Error fetching rejected opportunities:', error);
    res.status(500).json({ success: false, message: '获取被摁死项目池失败' });
  }
});

router.get('/rejected-opportunities/:id', async (req, res) => {
  try {
    const db = await getDb();
    const record = await db.get(
      `SELECT ${selectColumns} FROM rejected_opportunities WHERE id = ? AND is_deleted = 0`,
      [req.params.id]
    );

    if (!record) {
      return res.status(404).json({ success: false, message: '被摁死项目记录不存在' });
    }

    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error fetching rejected opportunity:', error);
    res.status(500).json({ success: false, message: '获取被摁死项目详情失败' });
  }
});

router.post('/rejected-opportunities', async (req, res) => {
  try {
    const db = await getDb();
    const item = normalizeOpportunity(req.body || {});
    const error = validateOpportunity(item);
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const now = new Date().toISOString();
    const result = await db.run(
      `
        INSERT INTO rejected_opportunities (
          title, track, project_name, related_object, decision_date, decision_stage,
          risk_result, rejection_reason, review_category, information_snapshot, risk_rules_snapshot,
          risk_tolerance, execution_consistency, decision_quality, later_status,
          later_summary, review_link, note, is_deleted, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `,
      [
        item.title,
        item.track,
        item.projectName,
        item.relatedObject,
        item.decisionDate,
        item.decisionStage,
        item.riskResult,
        item.rejectionReason,
        item.reviewCategory,
        item.informationSnapshot,
        item.riskRulesSnapshot,
        item.riskTolerance,
        item.executionConsistency,
        item.decisionQuality,
        item.laterStatus,
        item.laterSummary,
        item.reviewLink,
        item.note,
        now,
        now
      ]
    );

    const insertedId = result.lastID;
    if (insertedId === undefined) {
      throw new Error('Failed to create rejected opportunity');
    }

    const record = await db.get(`SELECT ${selectColumns} FROM rejected_opportunities WHERE id = ?`, [insertedId]);
    await writeAuditLog(db, 'create', insertedId, item.title || '被摁死项目', '新增被摁死项目池记录');
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error creating rejected opportunity:', error);
    res.status(500).json({ success: false, message: '新增被摁死项目记录失败' });
  }
});

router.put('/rejected-opportunities/:id', async (req, res) => {
  try {
    const db = await getDb();
    const existing = await db.get('SELECT id FROM rejected_opportunities WHERE id = ? AND is_deleted = 0', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, message: '被摁死项目记录不存在' });
    }

    const item = normalizeOpportunity(req.body || {});
    const error = validateOpportunity(item);
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const now = new Date().toISOString();
    await db.run(
      `
        UPDATE rejected_opportunities
        SET title = ?,
            track = ?,
            project_name = ?,
            related_object = ?,
            decision_date = ?,
            decision_stage = ?,
            risk_result = ?,
            rejection_reason = ?,
            review_category = ?,
            information_snapshot = ?,
            risk_rules_snapshot = ?,
            risk_tolerance = ?,
            execution_consistency = ?,
            decision_quality = ?,
            later_status = ?,
            later_summary = ?,
            review_link = ?,
            note = ?,
            updated_at = ?
        WHERE id = ?
      `,
      [
        item.title,
        item.track,
        item.projectName,
        item.relatedObject,
        item.decisionDate,
        item.decisionStage,
        item.riskResult,
        item.rejectionReason,
        item.reviewCategory,
        item.informationSnapshot,
        item.riskRulesSnapshot,
        item.riskTolerance,
        item.executionConsistency,
        item.decisionQuality,
        item.laterStatus,
        item.laterSummary,
        item.reviewLink,
        item.note,
        now,
        req.params.id
      ]
    );

    const record = await db.get(`SELECT ${selectColumns} FROM rejected_opportunities WHERE id = ?`, [req.params.id]);
    await writeAuditLog(db, 'update', req.params.id, item.title || '被摁死项目', '更新被摁死项目池记录');
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error updating rejected opportunity:', error);
    res.status(500).json({ success: false, message: '编辑被摁死项目记录失败' });
  }
});

router.delete('/rejected-opportunities/:id', async (req, res) => {
  try {
    const db = await getDb();
    const existing = await db.get('SELECT id, title FROM rejected_opportunities WHERE id = ? AND is_deleted = 0', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, message: '被摁死项目记录不存在' });
    }

    const now = new Date().toISOString();
    await db.run(
      'UPDATE rejected_opportunities SET is_deleted = 1, updated_at = ? WHERE id = ?',
      [now, req.params.id]
    );
    await writeAuditLog(db, 'delete', req.params.id, existing.title || '被摁死项目', '删除被摁死项目池记录');
    res.json({ success: true, data: { id: req.params.id } });
  } catch (error) {
    console.error('Error deleting rejected opportunity:', error);
    res.status(500).json({ success: false, message: '删除被摁死项目记录失败' });
  }
});

export default router;
