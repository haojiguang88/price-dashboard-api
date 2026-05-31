import express from 'express';
import getDb from '../config/database';
import {
  annualPlanLinkJoins,
  annualPlanLinkSelectFields,
  serializeAnnualPlanLink,
  validateOptionalAnnualPlanItemLink
} from '../utils/annualPlanLinks';
import { validateOptionalDateOnly } from '../utils/dateValidation';
import { normalizeQueryText, parsePagination, toLikePattern } from '../utils/listQuery';

const router = express.Router();

// 买卖复盘相关接口

const businessReviewSelectFields = `
  br.id,
  br.title,
  br.track,
  br.project_name,
  br.review_date,
  br.result_type,
  br.summary_conclusion,
  br.background,
  br.judgment_at_that_time,
  br.action_at_that_time,
  br.later_outcome,
  br.root_cause_type,
  br.exposed_problem,
  br.extracted_lesson,
  br.short_lesson,
  br.annual_plan_item_id,
  br.note,
  br.created_at,
  br.updated_at,
  ${annualPlanLinkSelectFields}
`;

const serializeBusinessReview = (record: any) => ({
  ...record,
  annual_plan_item_id: record.annual_plan_item_id ? String(record.annual_plan_item_id) : '',
  annual_plan_item: serializeAnnualPlanLink(record)
});

const getBusinessReviewById = async (db: any, id: string | number) => {
  const record = await db.get(
    `SELECT ${businessReviewSelectFields}
     FROM business_reviews br
     ${annualPlanLinkJoins('br')}
     WHERE br.id = ? AND br.is_deleted = 0`,
    [id]
  );

  return record ? serializeBusinessReview(record) : null;
};

// 新增买卖复盘
router.post('/business-reviews', async (req, res) => {
  try {
    const db = await getDb();
    const { project_name, review_date, result_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, annual_plan_item_id } = req.body;
    const title = normalizeQueryText(req.body?.title);
    const track = normalizeQueryText(req.body?.track);
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    const reviewDate = validateOptionalDateOnly(review_date, '复盘日期');
    if (!reviewDate.ok) {
      return res.status(400).json({ success: false, message: reviewDate.message });
    }
    const annualPlanLink = await validateOptionalAnnualPlanItemLink(db, annual_plan_item_id);
    if (!annualPlanLink.ok) {
      return res.status(400).json({ success: false, message: annualPlanLink.message });
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO business_reviews (title, track, project_name, review_date, result_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, annual_plan_item_id, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, track, project_name, reviewDate.value, result_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, annualPlanLink.value, note, 0, now, now]
    );
    const createdRecord = result.lastID ? await getBusinessReviewById(db, result.lastID) : null;
    res.json({ success: true, data: createdRecord });
  } catch (error) {
    console.error('Error creating business review:', error);
    res.status(500).json({ success: false, message: '新增买卖复盘失败' });
  }
});

// 编辑买卖复盘
router.put('/business-reviews/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { project_name, review_date, result_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, note, annual_plan_item_id } = req.body;
    const title = normalizeQueryText(req.body?.title);
    const track = normalizeQueryText(req.body?.track);
    
    // 校验字段
    if (!title || !track) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track' });
    }
    const reviewDate = validateOptionalDateOnly(review_date, '复盘日期');
    if (!reviewDate.ok) {
      return res.status(400).json({ success: false, message: reviewDate.message });
    }
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM business_reviews WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '买卖复盘不存在' });
    }

    const annualPlanItemIdInput = Object.prototype.hasOwnProperty.call(req.body, 'annual_plan_item_id')
      ? annual_plan_item_id
      : existingRecord.annual_plan_item_id;
    const annualPlanLink = await validateOptionalAnnualPlanItemLink(db, annualPlanItemIdInput);
    if (!annualPlanLink.ok) {
      return res.status(400).json({ success: false, message: annualPlanLink.message });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE business_reviews SET title = ?, track = ?, project_name = ?, review_date = ?, result_type = ?, summary_conclusion = ?, background = ?, judgment_at_that_time = ?, action_at_that_time = ?, later_outcome = ?, root_cause_type = ?, exposed_problem = ?, extracted_lesson = ?, short_lesson = ?, annual_plan_item_id = ?, note = ?, updated_at = ? WHERE id = ?',
      [title, track, project_name, reviewDate.value, result_type, summary_conclusion, background, judgment_at_that_time, action_at_that_time, later_outcome, root_cause_type, exposed_problem, extracted_lesson, short_lesson, annualPlanLink.value, note, now, id]
    );
    const updatedRecord = await getBusinessReviewById(db, id);
    res.json({ success: true, data: updatedRecord ? { ...updatedRecord, changes: result.changes } : { id, changes: result.changes } });
  } catch (error) {
    console.error('Error updating business review:', error);
    res.status(500).json({ success: false, message: '编辑买卖复盘失败' });
  }
});

// 删除买卖复盘
router.delete('/business-reviews/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM business_reviews WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '买卖复盘不存在' });
    }
    
    // 软删除记录
    const now = new Date().toISOString();
    const result = await db.run('UPDATE business_reviews SET is_deleted = 1, updated_at = ? WHERE id = ?', [now, id]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting business review:', error);
    res.status(500).json({ success: false, message: '删除买卖复盘失败' });
  }
});

// 获取买卖复盘列表
router.get('/business-reviews', async (req, res) => {
  try {
    const db = await getDb();
    const { track, start_date, end_date, q, page, pageSize } = req.query;
    const trackFilter = normalizeQueryText(track);
    const keyword = normalizeQueryText(q);
    const pagination = parsePagination(page, pageSize);
    
    const selectClause = `SELECT ${businessReviewSelectFields}`;
    const fromClause = `FROM business_reviews br ${annualPlanLinkJoins('br')}`;
    const countFromClause = 'FROM business_reviews br';
    let whereClause = 'WHERE br.is_deleted = 0';
    const params: any[] = [];
    const startDate = validateOptionalDateOnly(start_date, '开始日期');
    if (!startDate.ok) {
      return res.status(400).json({ success: false, message: startDate.message });
    }
    const endDate = validateOptionalDateOnly(end_date, '结束日期');
    if (!endDate.ok) {
      return res.status(400).json({ success: false, message: endDate.message });
    }
    
    if (trackFilter) {
      whereClause += ' AND br.track = ?';
      params.push(trackFilter);
    }
    if (startDate.value) {
      whereClause += ' AND br.review_date >= ?';
      params.push(startDate.value);
    }
    if (endDate.value) {
      whereClause += ' AND br.review_date <= ?';
      params.push(endDate.value);
    }
    if (keyword) {
      const like = toLikePattern(keyword);
      whereClause += ' AND (br.title LIKE ? OR br.track LIKE ? OR br.project_name LIKE ? OR br.result_type LIKE ? OR br.summary_conclusion LIKE ? OR br.short_lesson LIKE ? OR br.note LIKE ?)';
      params.push(like, like, like, like, like, like, like);
    }
    
    const totalRow = await db.get(`SELECT COUNT(1) as total ${countFromClause} ${whereClause}`, params);
    const records = await db.all(
      `${selectClause} ${fromClause} ${whereClause} ORDER BY br.review_date DESC, br.created_at DESC, br.id DESC LIMIT ? OFFSET ?`,
      [...params, pagination.limit, pagination.offset]
    );
    
    res.json({
      success: true,
      data: {
        items: records.map(serializeBusinessReview),
        total: Number(totalRow?.total || 0),
        page: pagination.page,
        pageSize: pagination.pageSize
      }
    });
  } catch (error) {
    console.error('Error fetching business reviews:', error);
    res.status(500).json({ success: false, message: '获取买卖复盘列表失败' });
  }
});

// 获取买卖复盘详情
router.get('/business-reviews/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 获取记录详情
    const record = await getBusinessReviewById(db, id);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '买卖复盘不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error fetching business review details:', error);
    res.status(500).json({ success: false, message: '获取买卖复盘详情失败' });
  }
});

export default router;
