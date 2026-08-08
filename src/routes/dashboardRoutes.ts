import express from 'express';
import getDb from '../config/database';

const router = express.Router();

const ensureActionStatusTable = async (db: any) => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_action_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL DEFAULT 'business',
      action_key TEXT NOT NULL,
      action_title TEXT NOT NULL DEFAULT '',
      action_source TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('handled', 'ignored')),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace, action_key)
    );

    CREATE INDEX IF NOT EXISTS idx_dashboard_action_statuses_scope
      ON dashboard_action_statuses(workspace, status, updated_at DESC);
  `);
};

const normalizeWorkspace = (value: unknown) => {
  const workspace = String(value || 'business').trim();
  return workspace || 'business';
};

const normalizeText = (value: unknown) => {
  return typeof value === 'string' ? value.trim() : '';
};

// 已实现盈亏 TOP 接口
router.get('/realized-top', async (req, res) => {
  try {
    const db = await getDb();
    
    const includeArchived = ['1', 'true'].includes(String(req.query.include_archived || '').toLowerCase());
    const activeMasterFilter = `
      EXISTS (
        SELECT 1
        FROM categories c
        JOIN objects o ON o.category_id = c.id
        WHERE c.name = sr.category_name
          AND o.name = sr.object_name
          AND COALESCE(c.is_archived, 0) = 0
          AND COALESCE(o.is_archived, 0) = 0
          AND (
            COALESCE(sr.variant_name, '') = ''
            OR EXISTS (
              SELECT 1
              FROM variants v
              WHERE v.object_id = o.id
                AND v.name = sr.variant_name
                AND COALESCE(v.is_archived, 0) = 0
            )
          )
      )
    `;

    // 聚合计算每个品类/对象/变体的盈亏数据（默认排除已归档主数据）
    const realizedData = await db.all(`
      SELECT 
        sr.category_name, 
        sr.object_name, 
        COALESCE(sr.variant_name, '') as variant_name, 
        SUM(sr.quantity) as total_quantity, 
        SUM(sr.amount) as total_amount, 
        SUM(sr.cost) as total_cost, 
        SUM(sr.profit) as total_profit
      FROM sell_records sr
      WHERE ${includeArchived ? '1 = 1' : activeMasterFilter}
      GROUP BY sr.category_name, sr.object_name, COALESCE(sr.variant_name, '')
      HAVING SUM(sr.profit) IS NOT NULL
    `);
    
    // 按盈亏排序，提取 TOP 10
    const topProfit = [...realizedData]
      .filter(item => item.total_profit > 0)
      .sort((a, b) => b.total_profit - a.total_profit)
      .slice(0, 10);
    
    const topLoss = [...realizedData]
      .filter(item => item.total_profit < 0)
      .sort((a, b) => a.total_profit - b.total_profit)
      .slice(0, 10);
    
    res.json({
      status: "success",
      data: {
        top_profit: topProfit,
        top_loss: topLoss
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "获取已实现盈亏 TOP 失败", error: errorMessage });
  }
});

router.get('/action-statuses', async (req, res) => {
  try {
    const db = await getDb();
    await ensureActionStatusTable(db);

    const workspace = normalizeWorkspace(req.query.workspace);
    const rows = await db.all(
      `
        SELECT
          id,
          workspace,
          action_key,
          action_title,
          action_source,
          status,
          note,
          created_at,
          updated_at
        FROM dashboard_action_statuses
        WHERE workspace = ?
        ORDER BY updated_at DESC, id DESC
      `,
      [workspace]
    );

    res.json({ success: true, data: rows || [] });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: '获取行动队列状态失败', error: errorMessage });
  }
});

router.post('/action-statuses', async (req, res) => {
  try {
    const db = await getDb();
    await ensureActionStatusTable(db);

    const workspace = normalizeWorkspace(req.body?.workspace);
    const actionKey = normalizeText(req.body?.action_key);
    const actionTitle = normalizeText(req.body?.action_title);
    const actionSource = normalizeText(req.body?.action_source);
    const status = normalizeText(req.body?.status);
    const note = normalizeText(req.body?.note);
    const now = new Date().toISOString();

    if (!actionKey) {
      res.status(400).json({ success: false, message: 'action_key 不能为空' });
      return;
    }
    if (!['handled', 'ignored'].includes(status)) {
      res.status(400).json({ success: false, message: 'status 只能是 handled 或 ignored' });
      return;
    }

    await db.run(
      `
        INSERT INTO dashboard_action_statuses (
          workspace,
          action_key,
          action_title,
          action_source,
          status,
          note,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace, action_key) DO UPDATE SET
          action_title = excluded.action_title,
          action_source = excluded.action_source,
          status = excluded.status,
          note = excluded.note,
          updated_at = excluded.updated_at
      `,
      [workspace, actionKey, actionTitle, actionSource, status, note || null, now, now]
    );

    const row = await db.get(
      `
        SELECT
          id,
          workspace,
          action_key,
          action_title,
          action_source,
          status,
          note,
          created_at,
          updated_at
        FROM dashboard_action_statuses
        WHERE workspace = ? AND action_key = ?
      `,
      [workspace, actionKey]
    );

    res.json({ success: true, data: row });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: '保存行动队列状态失败', error: errorMessage });
  }
});

router.delete('/action-statuses/:actionKey', async (req, res) => {
  try {
    const db = await getDb();
    await ensureActionStatusTable(db);

    const workspace = normalizeWorkspace(req.query.workspace);
    const actionKey = normalizeText(req.params.actionKey);
    if (!actionKey) {
      res.status(400).json({ success: false, message: 'action_key 不能为空' });
      return;
    }

    await db.run(
      'DELETE FROM dashboard_action_statuses WHERE workspace = ? AND action_key = ?',
      [workspace, actionKey]
    );

    res.json({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: '恢复行动队列状态失败', error: errorMessage });
  }
});

export default router;
