import express from 'express';
import getDb from '../config/database';

const router = express.Router();

interface PreferenceInput {
  key?: string;
  preference_key?: string;
  user_key?: string;
  value?: unknown;
  preference_value?: unknown;
}

const normalizeUserKey = (value: unknown) => String(value || 'default').trim() || 'default';
const normalizePreferenceKey = (value: unknown) => String(value || '').trim();

const serializePreferenceValue = (body: PreferenceInput) => {
  const rawValue = body.value !== undefined ? body.value : body.preference_value;
  return JSON.stringify(rawValue ?? null);
};

const validatePreferenceKey = (key: string) => {
  if (!key) return '缺少必填字段: preference_key';
  if (key.length > 160) return 'preference_key 过长';
  return '';
};

const upsertPreference = async (db: any, input: PreferenceInput) => {
  const now = new Date().toISOString();
  const userKey = normalizeUserKey(input.user_key);
  const preferenceKey = normalizePreferenceKey(input.preference_key || input.key);
  const preferenceValue = serializePreferenceValue(input);

  await db.run(
    `
      INSERT INTO user_preferences
        (user_key, preference_key, preference_value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_key, preference_key)
      DO UPDATE SET preference_value = excluded.preference_value, updated_at = excluded.updated_at
    `,
    [userKey, preferenceKey, preferenceValue, now, now]
  );

  return db.get(
    `
      SELECT id, user_key, preference_key, preference_value, created_at, updated_at
      FROM user_preferences
      WHERE user_key = ? AND preference_key = ?
    `,
    [userKey, preferenceKey]
  );
};

router.get('/user-preferences', async (req, res) => {
  try {
    const db = await getDb();
    const userKey = normalizeUserKey(req.query.user_key);
    const prefix = normalizePreferenceKey(req.query.prefix);
    const keys = String(req.query.keys || '')
      .split(',')
      .map(key => key.trim())
      .filter(Boolean);

    const where = ['user_key = ?'];
    const params: string[] = [userKey];

    if (prefix) {
      where.push('preference_key LIKE ?');
      params.push(`${prefix}%`);
    }
    if (keys.length > 0) {
      where.push(`preference_key IN (${keys.map(() => '?').join(', ')})`);
      params.push(...keys);
    }

    const rows = await db.all(
      `
        SELECT id, user_key, preference_key, preference_value, created_at, updated_at
        FROM user_preferences
        WHERE ${where.join(' AND ')}
        ORDER BY preference_key ASC
      `,
      params
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching user preferences:', error);
    res.status(500).json({ success: false, message: '获取用户偏好失败' });
  }
});

router.get('/user-preferences/:key', async (req, res) => {
  try {
    const db = await getDb();
    const userKey = normalizeUserKey(req.query.user_key);
    const preferenceKey = normalizePreferenceKey(req.params.key);
    const error = validatePreferenceKey(preferenceKey);
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const row = await db.get(
      `
        SELECT id, user_key, preference_key, preference_value, created_at, updated_at
        FROM user_preferences
        WHERE user_key = ? AND preference_key = ?
      `,
      [userKey, preferenceKey]
    );

    res.json({ success: true, data: row || null });
  } catch (error) {
    console.error('Error fetching user preference:', error);
    res.status(500).json({ success: false, message: '获取用户偏好失败' });
  }
});

router.put('/user-preferences/:key', async (req, res) => {
  try {
    const db = await getDb();
    const preferenceKey = normalizePreferenceKey(req.params.key);
    const error = validatePreferenceKey(preferenceKey);
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const row = await upsertPreference(db, {
      ...(req.body || {}),
      preference_key: preferenceKey,
    });

    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Error saving user preference:', error);
    res.status(500).json({ success: false, message: '保存用户偏好失败' });
  }
});

router.post('/user-preferences/bulk', async (req, res) => {
  const preferences = Array.isArray(req.body?.preferences) ? req.body.preferences : [];
  if (preferences.length === 0) {
    return res.status(400).json({ success: false, message: '缺少批量偏好数据' });
  }

  try {
    const db = await getDb();
    const normalized = preferences.map((item: PreferenceInput) => ({
      ...item,
      preference_key: normalizePreferenceKey(item.preference_key || item.key)
    }));
    const invalid = normalized
      .map((item: PreferenceInput) => validatePreferenceKey(item.preference_key || ''))
      .find(Boolean);
    if (invalid) {
      return res.status(400).json({ success: false, message: invalid });
    }

    await db.exec('BEGIN');
    try {
      const rows = [];
      for (const preference of normalized) {
        rows.push(await upsertPreference(db, preference));
      }
      await db.exec('COMMIT');
      res.json({ success: true, data: rows });
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error bulk saving user preferences:', error);
    res.status(500).json({ success: false, message: '批量保存用户偏好失败' });
  }
});

export default router;
