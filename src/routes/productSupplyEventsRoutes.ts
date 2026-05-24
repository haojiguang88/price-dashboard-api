import express from 'express';
import getDb from '../config/database';

const router = express.Router();

interface SupplyEventRow {
  id: number;
  product_name: string;
  event_date: string;
  event_date_label: string | null;
  event_type: string;
  channel_region: string | null;
  countdown_status: string;
  scale_note: string | null;
  date_certainty: string;
  trading_scope: string;
  source_note: string | null;
  is_deleted: number;
  created_at: string;
  updated_at: string;
}

interface ProductRow {
  id: number;
  product_name: string;
  product_note: string | null;
  is_deleted: number;
  created_at: string;
  updated_at: string;
}

interface HydratedSupplyEvent extends SupplyEventRow {
  previous_event_date: string | null;
  previous_event_date_label: string | null;
  previous_event_type: string | null;
  days_since_previous_event: number | null;
  product_min_interval_days: number | null;
  product_max_interval_days: number | null;
}

interface ProductSupplyStat {
  product_name: string;
  event_count: number;
  restock_count: number;
  latest_event_date: string | null;
  latest_event_date_label: string | null;
  latest_event_type: string | null;
  latest_restock_date: string | null;
  latest_restock_date_label: string | null;
  latest_restock_interval_days: number | null;
  days_since_latest_restock: number | null;
  min_interval_days: number | null;
  max_interval_days: number | null;
  has_estimated_date: boolean;
  has_record_only: boolean;
}

interface EventPayload {
  product_name: string;
  event_date: string;
  event_date_label: string | null;
  event_type: string;
  channel_region: string | null;
  countdown_status: string;
  scale_note: string | null;
  date_certainty: string;
  trading_scope: string;
  source_note: string | null;
}

const toQueryString = (value: unknown): string => {
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const toComparableText = (value: unknown): string => String(value ?? '').toLowerCase();

const toOptionalText = (value: unknown): string | null => {
  const text = toQueryString(value);
  return text ? text : null;
};

const isRestockEvent = (eventType: string): boolean => eventType.includes('补货');

const parseDateOnlyUtc = (value: string): number | null => {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return null;
  return Date.UTC(year, month - 1, day);
};

const daysBetween = (fromDate: string, toDate: string): number | null => {
  const from = parseDateOnlyUtc(fromDate);
  const to = parseDateOnlyUtc(toDate);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 86400000);
};

const formatToday = (): string => new Date().toISOString().slice(0, 10);

const normalizeEventPayload = (body: Record<string, unknown>): EventPayload => ({
  product_name: toQueryString(body.product_name),
  event_date: toQueryString(body.event_date),
  event_date_label: toOptionalText(body.event_date_label),
  event_type: toQueryString(body.event_type) || '补货',
  channel_region: toOptionalText(body.channel_region),
  countdown_status: toQueryString(body.countdown_status) || '未记录',
  scale_note: toOptionalText(body.scale_note),
  date_certainty: toQueryString(body.date_certainty) || 'confirmed',
  trading_scope: toQueryString(body.trading_scope) || 'normal',
  source_note: toOptionalText(body.source_note),
});

const validateEventPayload = (payload: EventPayload): string | null => {
  if (!payload.product_name) return '品类不能为空';
  if (!payload.event_date) return '日期不能为空';
  if (!payload.event_type) return '事件类型不能为空';
  if (!['confirmed', 'estimated'].includes(payload.date_certainty)) return '日期确定性不合法';
  if (!['normal', 'record_only'].includes(payload.trading_scope)) return '交易口径不合法';
  return null;
};

const ensureProductExists = async (
  db: any,
  productName: string,
  productNote: string | null = null,
) => {
  const now = new Date().toISOString();
  const existing: ProductRow | undefined = await db.get(
    'SELECT * FROM product_supply_products WHERE product_name = ?',
    [productName],
  );

  if (existing) {
    await db.run(
      `UPDATE product_supply_products
       SET product_note = COALESCE(?, product_note),
           is_deleted = 0,
           updated_at = ?
       WHERE product_name = ?`,
      [productNote, now, productName],
    );
    return;
  }

  await db.run(
    `INSERT INTO product_supply_products (product_name, product_note, is_deleted, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
    [productName, productNote, now, now],
  );
};

const hydrateSupplyEvents = (rows: SupplyEventRow[], products: ProductRow[] = []) => {
  const groups = new Map<string, SupplyEventRow[]>();

  rows.forEach((row) => {
    const list = groups.get(row.product_name) ?? [];
    list.push(row);
    groups.set(row.product_name, list);
  });

  const items: HydratedSupplyEvent[] = [];
  const productStats: ProductSupplyStat[] = [];
  const today = formatToday();
  const productNames = new Set<string>([
    ...products.map((product) => product.product_name),
    ...Array.from(groups.keys()),
  ]);

  productNames.forEach((productName) => {
    const groupRows = groups.get(productName) ?? [];
    const orderedRows = [...groupRows].sort((a, b) => {
      const left = a.event_date.localeCompare(b.event_date);
      return left !== 0 ? left : a.id - b.id;
    });

    const provisional = orderedRows.map((row, index) => {
      const previous = index > 0 ? orderedRows[index - 1] : null;
      return {
        ...row,
        previous_event_date: previous?.event_date ?? null,
        previous_event_date_label: previous?.event_date_label ?? previous?.event_date ?? null,
        previous_event_type: previous?.event_type ?? null,
        days_since_previous_event: previous ? daysBetween(previous.event_date, row.event_date) : null,
        product_min_interval_days: null,
        product_max_interval_days: null,
      };
    });

    const restockIntervals = provisional
      .filter((row) => isRestockEvent(row.event_type) && row.days_since_previous_event !== null)
      .map((row) => row.days_since_previous_event as number);

    const minInterval = restockIntervals.length > 0 ? Math.min(...restockIntervals) : null;
    const maxInterval = restockIntervals.length > 0 ? Math.max(...restockIntervals) : null;
    const hydratedRows = provisional.map((row) => ({
      ...row,
      product_min_interval_days: minInterval,
      product_max_interval_days: maxInterval,
    }));

    items.push(...hydratedRows);

    const latestEvent = hydratedRows[hydratedRows.length - 1] ?? null;
    const restockEvents = hydratedRows.filter((row) => isRestockEvent(row.event_type));
    const latestRestock = restockEvents[restockEvents.length - 1] ?? null;

    productStats.push({
      product_name: productName,
      event_count: hydratedRows.length,
      restock_count: restockEvents.length,
      latest_event_date: latestEvent?.event_date ?? null,
      latest_event_date_label: latestEvent?.event_date_label ?? latestEvent?.event_date ?? null,
      latest_event_type: latestEvent?.event_type ?? null,
      latest_restock_date: latestRestock?.event_date ?? null,
      latest_restock_date_label: latestRestock?.event_date_label ?? latestRestock?.event_date ?? null,
      latest_restock_interval_days: latestRestock?.days_since_previous_event ?? null,
      days_since_latest_restock: latestRestock ? daysBetween(latestRestock.event_date, today) : null,
      min_interval_days: minInterval,
      max_interval_days: maxInterval,
      has_estimated_date: hydratedRows.some((row) => row.date_certainty === 'estimated'),
      has_record_only: hydratedRows.some((row) => row.trading_scope === 'record_only'),
    });
  });

  productStats.sort((a, b) => String(b.latest_event_date ?? '').localeCompare(String(a.latest_event_date ?? '')));
  items.sort((a, b) => {
    const byDate = b.event_date.localeCompare(a.event_date);
    return byDate !== 0 ? byDate : b.id - a.id;
  });

  return { items, productStats };
};

router.get('/product-supply-events', async (req, res) => {
  try {
    const db = await getDb();
    const rows: SupplyEventRow[] = await db.all(`
      SELECT *
      FROM product_supply_events
      WHERE is_deleted = 0
      ORDER BY product_name ASC, event_date ASC, id ASC
    `);
    const products: ProductRow[] = await db.all(`
      SELECT *
      FROM product_supply_products
      WHERE is_deleted = 0
      ORDER BY product_name ASC
    `);

    const { items: hydratedItems, productStats } = hydrateSupplyEvents(rows, products);
    const q = toQueryString(req.query.q).toLowerCase();
    const productName = toQueryString(req.query.product_name);
    const eventType = toQueryString(req.query.event_type);
    const countdownStatus = toQueryString(req.query.countdown_status);
    const dateCertainty = toQueryString(req.query.date_certainty);
    const tradingScope = toQueryString(req.query.trading_scope);

    const items = hydratedItems.filter((item) => {
      if (q) {
        const haystack = [
          item.product_name,
          item.event_date_label,
          item.event_type,
          item.channel_region,
          item.countdown_status,
          item.scale_note,
          item.source_note,
        ].map(toComparableText).join(' ');
        if (!haystack.includes(q)) return false;
      }
      if (productName && item.product_name !== productName) return false;
      if (eventType && eventType !== 'all' && item.event_type !== eventType) return false;
      if (countdownStatus && countdownStatus !== 'all' && item.countdown_status !== countdownStatus) return false;
      if (dateCertainty && dateCertainty !== 'all' && item.date_certainty !== dateCertainty) return false;
      if (tradingScope && tradingScope !== 'all' && item.trading_scope !== tradingScope) return false;
      return true;
    });

    const matchedProductNames = new Set(items.map((item) => item.product_name));
    const hasEventFilters = Boolean(
      eventType && eventType !== 'all'
      || countdownStatus && countdownStatus !== 'all'
      || dateCertainty && dateCertainty !== 'all'
      || tradingScope && tradingScope !== 'all'
    );
    const scopedProductStats = productStats.filter((stat) => {
      if (productName && productName !== 'all' && stat.product_name !== productName) return false;
      if (q && !stat.product_name.toLowerCase().includes(q) && !matchedProductNames.has(stat.product_name)) return false;
      if (hasEventFilters && !matchedProductNames.has(stat.product_name)) return false;
      return true;
    });
    const eventTypes = Array.from(new Set([
      '首发',
      '补货',
      '首次记录/供给',
      '首发/节日前供给',
      ...hydratedItems.map((item) => item.event_type),
    ])).sort();
    const productOptions = Array.from(new Set([
      ...products.map((product) => product.product_name),
      ...hydratedItems.map((item) => item.product_name),
    ])).sort();

    res.json({
      success: true,
      data: {
        items,
        product_stats: scopedProductStats,
        options: {
          products: productOptions,
          event_types: eventTypes,
          countdown_statuses: Array.from(new Set([
            '未记录',
            '无倒计时',
            '有倒计时',
            ...hydratedItems.map((item) => item.countdown_status),
          ])).sort(),
        },
        summary: {
          event_count: items.length,
          product_count: scopedProductStats.length,
          restock_count: items.filter((item) => isRestockEvent(item.event_type)).length,
          estimated_count: items.filter((item) => item.date_certainty === 'estimated').length,
          record_only_count: items.filter((item) => item.trading_scope === 'record_only').length,
        },
      },
    });
  } catch (error) {
    console.error('查询商品补货时间线失败:', error);
    res.status(500).json({ success: false, message: '查询商品补货时间线失败' });
  }
});

router.post('/product-supply-products', async (req, res) => {
  try {
    const db = await getDb();
    const productName = toQueryString(req.body?.product_name);
    const productNote = toOptionalText(req.body?.product_note);

    if (!productName) {
      res.status(400).json({ success: false, message: '品类不能为空' });
      return;
    }

    await ensureProductExists(db, productName, productNote);
    const product: ProductRow | undefined = await db.get(
      'SELECT * FROM product_supply_products WHERE product_name = ? AND is_deleted = 0',
      [productName],
    );

    res.json({ success: true, data: product });
  } catch (error) {
    console.error('保存补货品类失败:', error);
    res.status(500).json({ success: false, message: '保存补货品类失败' });
  }
});

router.post('/product-supply-events', async (req, res) => {
  try {
    const db = await getDb();
    const payload = normalizeEventPayload(req.body ?? {});
    const validationMessage = validateEventPayload(payload);

    if (validationMessage) {
      res.status(400).json({ success: false, message: validationMessage });
      return;
    }

    await ensureProductExists(db, payload.product_name);
    const now = new Date().toISOString();
    const result = await db.run(
      `INSERT INTO product_supply_events (
        product_name, event_date, event_date_label, event_type, channel_region,
        countdown_status, scale_note, date_certainty, trading_scope, source_note,
        is_deleted, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        payload.product_name,
        payload.event_date,
        payload.event_date_label || payload.event_date,
        payload.event_type,
        payload.channel_region,
        payload.countdown_status,
        payload.scale_note,
        payload.date_certainty,
        payload.trading_scope,
        payload.source_note,
        now,
        now,
      ],
    );

    const event: SupplyEventRow | undefined = await db.get(
      'SELECT * FROM product_supply_events WHERE id = ?',
      [result.lastID],
    );

    res.json({ success: true, data: event });
  } catch (error: any) {
    console.error('新增补货事件失败:', error);
    const isDuplicate = String(error?.message || '').includes('UNIQUE constraint failed');
    res.status(isDuplicate ? 409 : 500).json({
      success: false,
      message: isDuplicate ? '同一品类、日期、事件和渠道已存在' : '新增补货事件失败',
    });
  }
});

router.put('/product-supply-events/:id', async (req, res) => {
  try {
    const db = await getDb();
    const id = Number(req.params.id);
    const payload = normalizeEventPayload(req.body ?? {});
    const validationMessage = validateEventPayload(payload);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, message: '事件 ID 不合法' });
      return;
    }
    if (validationMessage) {
      res.status(400).json({ success: false, message: validationMessage });
      return;
    }

    await ensureProductExists(db, payload.product_name);
    const now = new Date().toISOString();
    const result = await db.run(
      `UPDATE product_supply_events
       SET product_name = ?,
           event_date = ?,
           event_date_label = ?,
           event_type = ?,
           channel_region = ?,
           countdown_status = ?,
           scale_note = ?,
           date_certainty = ?,
           trading_scope = ?,
           source_note = ?,
           updated_at = ?
       WHERE id = ? AND is_deleted = 0`,
      [
        payload.product_name,
        payload.event_date,
        payload.event_date_label || payload.event_date,
        payload.event_type,
        payload.channel_region,
        payload.countdown_status,
        payload.scale_note,
        payload.date_certainty,
        payload.trading_scope,
        payload.source_note,
        now,
        id,
      ],
    );

    if ((result.changes ?? 0) === 0) {
      res.status(404).json({ success: false, message: '补货事件不存在' });
      return;
    }

    const event: SupplyEventRow | undefined = await db.get(
      'SELECT * FROM product_supply_events WHERE id = ?',
      [id],
    );

    res.json({ success: true, data: event });
  } catch (error: any) {
    console.error('编辑补货事件失败:', error);
    const isDuplicate = String(error?.message || '').includes('UNIQUE constraint failed');
    res.status(isDuplicate ? 409 : 500).json({
      success: false,
      message: isDuplicate ? '同一品类、日期、事件和渠道已存在' : '编辑补货事件失败',
    });
  }
});

export default router;
