import express from 'express';
import getDb from '../config/database';

const router = express.Router();

interface AnnotationInput {
  module?: string;
  entity_type?: string;
  entity_key?: string;
  annotation_key?: string;
  annotation_value?: string;
}

const normalizeAnnotation = (body: AnnotationInput) => ({
  module: String(body.module || '').trim(),
  entityType: String(body.entity_type || '').trim(),
  entityKey: String(body.entity_key || '').trim(),
  annotationKey: String(body.annotation_key || '').trim(),
  annotationValue: body.annotation_value === undefined ? '' : String(body.annotation_value)
});

const validateAnnotation = (annotation: ReturnType<typeof normalizeAnnotation>) => {
  if (!annotation.module) return '缺少必填字段: module';
  if (!annotation.entityType) return '缺少必填字段: entity_type';
  if (!annotation.entityKey) return '缺少必填字段: entity_key';
  if (!annotation.annotationKey) return '缺少必填字段: annotation_key';
  return '';
};

const upsertAnnotation = async (db: any, annotation: ReturnType<typeof normalizeAnnotation>) => {
  const now = new Date().toISOString();
  await db.run(
    `
      INSERT INTO analysis_annotations
        (module, entity_type, entity_key, annotation_key, annotation_value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(module, entity_type, entity_key, annotation_key)
      DO UPDATE SET annotation_value = excluded.annotation_value, updated_at = excluded.updated_at
    `,
    [
      annotation.module,
      annotation.entityType,
      annotation.entityKey,
      annotation.annotationKey,
      annotation.annotationValue,
      now,
      now
    ]
  );

  return db.get(
    `
      SELECT id, module, entity_type, entity_key, annotation_key, annotation_value, created_at, updated_at
      FROM analysis_annotations
      WHERE module = ? AND entity_type = ? AND entity_key = ? AND annotation_key = ?
    `,
    [annotation.module, annotation.entityType, annotation.entityKey, annotation.annotationKey]
  );
};

router.get('/analysis-annotations', async (req, res) => {
  try {
    const db = await getDb();
    const { module, entity_type, entity_key, annotation_key } = req.query;
    const where: string[] = [];
    const params: string[] = [];

    if (module) {
      where.push('module = ?');
      params.push(String(module));
    }
    if (entity_type) {
      where.push('entity_type = ?');
      params.push(String(entity_type));
    }
    if (entity_key) {
      where.push('entity_key = ?');
      params.push(String(entity_key));
    }
    if (annotation_key) {
      where.push('annotation_key = ?');
      params.push(String(annotation_key));
    }

    const rows = await db.all(
      `
        SELECT id, module, entity_type, entity_key, annotation_key, annotation_value, created_at, updated_at
        FROM analysis_annotations
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY updated_at DESC, id DESC
      `,
      params
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching analysis annotations:', error);
    res.status(500).json({ success: false, message: '获取分析标注失败' });
  }
});

router.put('/analysis-annotations', async (req, res) => {
  try {
    const db = await getDb();
    const annotation = normalizeAnnotation(req.body || {});
    const error = validateAnnotation(annotation);
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const row = await upsertAnnotation(db, annotation);
    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Error upserting analysis annotation:', error);
    res.status(500).json({ success: false, message: '保存分析标注失败' });
  }
});

router.post('/analysis-annotations/bulk', async (req, res) => {
  const annotations = Array.isArray(req.body?.annotations) ? req.body.annotations : [];
  if (annotations.length === 0) {
    return res.status(400).json({ success: false, message: '缺少批量标注数据' });
  }

  try {
    const db = await getDb();
    const normalized = annotations.map((item: AnnotationInput) => normalizeAnnotation(item));
    const invalid = normalized.map(validateAnnotation).find(Boolean);
    if (invalid) {
      return res.status(400).json({ success: false, message: invalid });
    }

    await db.exec('BEGIN');
    try {
      const rows = [];
      for (const annotation of normalized) {
        rows.push(await upsertAnnotation(db, annotation));
      }
      await db.exec('COMMIT');
      res.json({ success: true, data: rows });
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error bulk upserting analysis annotations:', error);
    res.status(500).json({ success: false, message: '批量保存分析标注失败' });
  }
});

router.delete('/analysis-annotations', async (req, res) => {
  try {
    const db = await getDb();
    const annotation = normalizeAnnotation(req.query as AnnotationInput);
    const error = validateAnnotation(annotation);
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const result = await db.run(
      `
        DELETE FROM analysis_annotations
        WHERE module = ? AND entity_type = ? AND entity_key = ? AND annotation_key = ?
      `,
      [annotation.module, annotation.entityType, annotation.entityKey, annotation.annotationKey]
    );

    res.json({ success: true, data: { changes: result.changes || 0 } });
  } catch (error) {
    console.error('Error deleting analysis annotation:', error);
    res.status(500).json({ success: false, message: '删除分析标注失败' });
  }
});

export default router;
