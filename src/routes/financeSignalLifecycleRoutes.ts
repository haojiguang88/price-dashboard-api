import { Router, Request, Response } from 'express';
import getDb from '../config/database';
import {
  buildSignalLifecycleSummary,
  ensureFinanceSignalLifecycleSchema,
  syncSignalLifecyclesFromEntryObservations
} from '../services/financeSignalLifecycle';

const router = Router();

router.get('/signal-lifecycles/summary', async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const data = await buildSignalLifecycleSummary(db);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `获取信号生命周期失败：${(error as Error).message}`
    });
  }
});

router.patch('/signal-lifecycles/:id/review', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    await ensureFinanceSignalLifecycleSchema(db);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '无效的信号生命周期ID' });
    }

    const humanReviewStatus = String(req.body.human_review_status || req.body.humanReviewStatus || 'reviewed').trim();
    const humanReviewNote = String(req.body.human_review_note || req.body.humanReviewNote || '').trim();
    const modelTrainingReady = req.body.model_training_ready ?? req.body.modelTrainingReady;
    const modelTrainingUsed = req.body.model_training_used ?? req.body.modelTrainingUsed;

    const updates = [
      'human_review_status = ?',
      'human_review_note = ?',
      'updated_at = CURRENT_TIMESTAMP'
    ];
    const params: any[] = [humanReviewStatus, humanReviewNote];

    if (modelTrainingReady !== undefined) {
      updates.push('model_training_ready = ?');
      params.push(modelTrainingReady ? 1 : 0);
    }
    if (modelTrainingUsed !== undefined) {
      updates.push('model_training_used = ?');
      params.push(modelTrainingUsed ? 1 : 0);
    }
    params.push(id);

    await db.run(
      `UPDATE financial_signal_lifecycles SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    const item = await db.get(`SELECT * FROM financial_signal_lifecycles WHERE id = ?`, [id]);
    res.json({ success: true, data: item, message: '信号样本复盘标注已更新' });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `更新信号样本复盘失败：${(error as Error).message}`
    });
  }
});

router.post('/signal-lifecycles/sync-observations', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const limit = Number(req.body?.limit || req.query?.limit || 500);
    const data = await syncSignalLifecyclesFromEntryObservations(db, limit);
    res.json({
      success: true,
      data,
      message: `信号生命周期同步完成：处理 ${data.synced} 条入场观察。`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `同步信号生命周期失败：${(error as Error).message}`
    });
  }
});

export default router;
