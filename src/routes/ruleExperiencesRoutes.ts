import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 规则经验相关接口

// 新增规则经验
router.post('/rule-experiences', async (req, res) => {
  try {
    const db = await getDb();
    const { title, type, track, source_case, core_content, summary_conclusion, note } = req.body;
    
    // 校验字段
    if (!title) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title' });
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO rule_experiences (title, type, track, source_case, core_content, summary_conclusion, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, type, track, source_case, core_content, summary_conclusion, note, 0, now, now]
    );
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error creating rule experience:', error);
    res.status(500).json({ success: false, message: '新增规则经验失败' });
  }
});

// 编辑规则经验
router.put('/rule-experiences/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { title, type, track, source_case, core_content, summary_conclusion, note } = req.body;
    
    // 校验字段
    if (!title) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title' });
    }
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM rule_experiences WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '规则经验不存在' });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE rule_experiences SET title = ?, type = ?, track = ?, source_case = ?, core_content = ?, summary_conclusion = ?, note = ?, updated_at = ? WHERE id = ?',
      [title, type, track, source_case, core_content, summary_conclusion, note, now, id]
    );
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error updating rule experience:', error);
    res.status(500).json({ success: false, message: '编辑规则经验失败' });
  }
});

// 删除规则经验
router.delete('/rule-experiences/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM rule_experiences WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '规则经验不存在' });
    }
    
    // 软删除记录
    const now = new Date().toISOString();
    const result = await db.run('UPDATE rule_experiences SET is_deleted = 1, updated_at = ? WHERE id = ?', [now, id]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting rule experience:', error);
    res.status(500).json({ success: false, message: '删除规则经验失败' });
  }
});

// 获取规则经验列表
router.get('/rule-experiences', async (req, res) => {
  try {
    const db = await getDb();
    const { q, type, track, page = 1, pageSize = 10 } = req.query;
    
    // 构建查询条件
    let whereClause = 'is_deleted = 0';
    const params: any[] = [];
    
    // 搜索条件
    if (q) {
      whereClause += ' AND (title LIKE ? OR core_content LIKE ? OR summary_conclusion LIKE ? OR source_case LIKE ? OR track LIKE ? OR type LIKE ? OR note LIKE ?)';
      const searchTerm = `%${q}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    // 类型和跟踪条件
    if (type) {
      whereClause += ' AND type = ?';
      params.push(type);
    }
    
    if (track) {
      whereClause += ' AND track = ?';
      params.push(track);
    }
    
    // 计算分页
    const pageNum = parseInt(page as string) || 1;
    const size = parseInt(pageSize as string) || 10;
    const offset = (pageNum - 1) * size;
    
    // 获取总数
    const countQuery = `SELECT COUNT(*) as total FROM rule_experiences WHERE ${whereClause}`;
    const countResult = await db.get(countQuery, params);
    const total = countResult.total || 0;
    
    // 获取分页数据
    const dataQuery = `
      SELECT id, title, type, track, source_case, core_content, summary_conclusion, note, created_at, updated_at 
      FROM rule_experiences 
      WHERE ${whereClause} 
      ORDER BY created_at DESC, id DESC 
      LIMIT ? OFFSET ?
    `;
    
    const dataParams = [...params, size, offset];
    const items = await db.all(dataQuery, dataParams);
    
    // 返回结果
    res.json({
      success: true,
      data: {
        items,
        total,
        page: pageNum,
        pageSize: size
      }
    });
  } catch (error) {
    console.error('Error fetching rule experiences:', error);
    res.status(500).json({ success: false, message: '获取规则经验列表失败' });
  }
});

// 获取规则经验详情
router.get('/rule-experiences/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 获取记录详情
    const record = await db.get('SELECT id, title, type, track, source_case, core_content, summary_conclusion, note, created_at, updated_at FROM rule_experiences WHERE id = ? AND is_deleted = 0', [id]);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '规则经验不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error fetching rule experience details:', error);
    res.status(500).json({ success: false, message: '获取规则经验详情失败' });
  }
});

export default router;