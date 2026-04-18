import express from 'express';
import getDb from '../config/database';

const router = express.Router();

// 事件记录相关接口

// 新增事件记录
router.post('/events', async (req, res) => {
  try {
    const db = await getDb();
    const { title, track, event_date, event_type, description, related_object, impact, source, note } = req.body;
    
    // 校验字段
    if (!title || !track || !event_date) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track, event_date' });
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO event_records (title, track, event_date, event_type, description, related_object, impact, source, note, is_deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, track, event_date, event_type, description, related_object, impact, source, note, 0, now, now]
    );
    res.json({ success: true, data: { id: result.lastID } });
  } catch (error) {
    console.error('Error creating event record:', error);
    res.status(500).json({ success: false, message: '新增事件记录失败' });
  }
});

// 编辑事件记录
router.put('/events/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { title, track, event_date, event_type, description, related_object, impact, source, note } = req.body;
    
    // 校验字段
    if (!title || !track || !event_date) {
      return res.status(400).json({ success: false, message: '缺少必填字段: title, track, event_date' });
    }
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM event_records WHERE id = ?', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '事件记录不存在' });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      'UPDATE event_records SET title = ?, track = ?, event_date = ?, event_type = ?, description = ?, related_object = ?, impact = ?, source = ?, note = ?, updated_at = ? WHERE id = ?',
      [title, track, event_date, event_type, description, related_object, impact, source, note, now, id]
    );
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error updating event record:', error);
    res.status(500).json({ success: false, message: '编辑事件记录失败' });
  }
});

// 删除事件记录
router.delete('/events/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 检查记录是否存在
    const existingRecord = await db.get('SELECT * FROM event_records WHERE id = ? AND is_deleted = 0', [id]);
    if (!existingRecord) {
      return res.status(404).json({ success: false, message: '事件记录不存在' });
    }
    
    // 软删除记录
    const now = new Date().toISOString();
    const result = await db.run('UPDATE event_records SET is_deleted = 1, updated_at = ? WHERE id = ?', [now, id]);
    res.json({ success: true, data: { changes: result.changes } });
  } catch (error) {
    console.error('Error deleting event record:', error);
    res.status(500).json({ success: false, message: '删除事件记录失败' });
  }
});

// 获取事件记录列表
router.get('/events', async (req, res) => {
  try {
    const db = await getDb();
    const { q, track, event_type, page = 1, pageSize = 10 } = req.query;
    
    // 构建查询条件
    let whereClause = 'is_deleted = 0';
    const params: any[] = [];
    
    // 搜索条件
    if (q) {
      whereClause += ' AND (title LIKE ? OR description LIKE ? OR related_object LIKE ? OR impact LIKE ? OR source LIKE ? OR note LIKE ? OR track LIKE ? OR event_type LIKE ?)';
      const searchTerm = `%${q}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    // 精确筛选条件
    if (track) {
      whereClause += ' AND track = ?';
      params.push(track);
    }
    
    if (event_type) {
      whereClause += ' AND event_type = ?';
      params.push(event_type);
    }
    
    // 计算分页
    const pageNum = parseInt(page as string) || 1;
    const size = parseInt(pageSize as string) || 10;
    const offset = (pageNum - 1) * size;
    
    // 获取总数
    const countQuery = `SELECT COUNT(*) as total FROM event_records WHERE ${whereClause}`;
    const countResult = await db.get(countQuery, params);
    const total = countResult.total || 0;
    
    // 获取分页数据
    const dataQuery = `
      SELECT id, title, track, event_date, event_type, description, related_object, impact, source, note, created_at, updated_at 
      FROM event_records 
      WHERE ${whereClause} 
      ORDER BY event_date DESC, created_at DESC, id DESC 
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
    console.error('Error fetching event records:', error);
    res.status(500).json({ success: false, message: '获取事件记录列表失败' });
  }
});

// 获取事件记录详情
router.get('/events/:id', async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    
    // 获取记录详情
    const record = await db.get('SELECT id, title, track, event_date, event_type, description, related_object, impact, source, note, created_at, updated_at FROM event_records WHERE id = ? AND is_deleted = 0', [id]);
    
    if (!record) {
      return res.status(404).json({ success: false, message: '事件记录不存在' });
    }
    
    res.json({ success: true, data: record });
  } catch (error) {
    console.error('Error fetching event record details:', error);
    res.status(500).json({ success: false, message: '获取事件记录详情失败' });
  }
});

export default router;