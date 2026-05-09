import express from "express";
import getDb from "../config/database";

const router = express.Router();

interface PriceRecordRow {
  id: number;
  date: string;
  category: string;
  object_name: string;
  variant: string;
  price: number;
  source: string | null;
  note: string | null;
  category_id: number | null;
  object_id: number | null;
  variant_id: number | null;
}

interface SeriesStats {
  label: string;
  category_name: string;
  object_name: string;
  variant_name: string;
  category_id: number | null;
  object_id: number | null;
  variant_id: number | null;
  record_count: number;
  first_date: string;
  first_price: number;
  current_date: string;
  current_price: number;
  previous_date: string | null;
  previous_price: number | null;
  change_amount: number | null;
  change_percent: number | null;
  period_start_date: string | null;
  period_change_percent: number | null;
  min_price: number;
  min_date: string;
  max_price: number;
  max_date: string;
  drawdown_percent: number;
  from_first_percent: number;
  historical_high_break_percent: number | null;
  historical_low_break_percent: number | null;
  days_since_latest: number;
  source: string | null;
  note: string | null;
}

interface JumpInsight {
  label: string;
  category_name: string;
  object_name: string;
  variant_name: string;
  category_id: number | null;
  object_id: number | null;
  variant_id: number | null;
  from_date: string;
  to_date: string;
  from_price: number;
  to_price: number;
  change_amount: number;
  change_percent: number;
  source: string | null;
  note: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const toDateValue = (date: string) => new Date(`${date}T00:00:00`).getTime();

const daysBetween = (fromDate: string, toDate: string) => {
  return Math.round((toDateValue(toDate) - toDateValue(fromDate)) / DAY_MS);
};

const roundNumber = (value: number, digits = 2) => {
  return Number(value.toFixed(digits));
};

const roundNullable = (value: number | null, digits = 2) => {
  return value === null || !Number.isFinite(value) ? null : roundNumber(value, digits);
};

const percentChange = (current: number, previous: number) => {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
};

const getSeriesKey = (record: PriceRecordRow) => {
  return [record.category, record.object_name, record.variant || ''].join('|');
};

const buildSeriesLabel = (record: PriceRecordRow) => {
  return [record.category, record.object_name, record.variant].filter(Boolean).join(' / ');
};

const toInsightItem = (item: SeriesStats) => ({
  ...item,
  first_price: roundNumber(item.first_price),
  current_price: roundNumber(item.current_price),
  previous_price: item.previous_price === null ? null : roundNumber(item.previous_price),
  change_amount: roundNullable(item.change_amount),
  change_percent: roundNullable(item.change_percent),
  period_change_percent: roundNullable(item.period_change_percent),
  min_price: roundNumber(item.min_price),
  max_price: roundNumber(item.max_price),
  drawdown_percent: roundNumber(item.drawdown_percent),
  from_first_percent: roundNumber(item.from_first_percent)
});

const toJumpInsightItem = (item: JumpInsight) => ({
  ...item,
  from_price: roundNumber(item.from_price),
  to_price: roundNumber(item.to_price),
  change_amount: roundNumber(item.change_amount),
  change_percent: roundNumber(item.change_percent)
});

const getTargetIdMaps = async (db: any) => {
  const categories = await db.all('SELECT id, name FROM categories');
  const objects = await db.all('SELECT id, category_id, name FROM objects');
  const variants = await db.all('SELECT id, object_id, name FROM variants');

  const categoryIds = new Map<string, number>();
  const objectIds = new Map<string, number>();
  const variantIds = new Map<string, number>();

  categories.forEach((category: any) => {
    categoryIds.set(category.name, category.id);
  });

  objects.forEach((object: any) => {
    objectIds.set(`${object.category_id}|${object.name}`, object.id);
  });

  variants.forEach((variant: any) => {
    variantIds.set(`${variant.object_id}|${variant.name}`, variant.id);
  });

  return { categoryIds, objectIds, variantIds };
};

const buildPriceInsights = (records: PriceRecordRow[]) => {
  if (records.length === 0) {
    return {
      overview: {
        total_records: 0,
        series_count: 0,
        category_count: 0,
        earliest_date: null,
        latest_date: null,
        latest_date_records: 0,
        active_series_last_7d: 0,
        stale_series_over_14d: 0,
        suspected_anomaly_count: 0
      },
      category_summary: [],
      latest_moves: [],
      period_gainers: [],
      period_losers: [],
      drawdowns: [],
      record_highs: [],
      record_lows: [],
      stale_targets: [],
      suspected_anomalies: [],
      recent_dates: []
    };
  }

  const groupedRecords: Record<string, PriceRecordRow[]> = {};
  const categoryCounts = new Map<string, number>();
  const dateCounts = new Map<string, number>();

  records.forEach(record => {
    const key = getSeriesKey(record);
    if (!groupedRecords[key]) {
      groupedRecords[key] = [];
    }
    groupedRecords[key].push(record);
    categoryCounts.set(record.category, (categoryCounts.get(record.category) || 0) + 1);
    dateCounts.set(record.date, (dateCounts.get(record.date) || 0) + 1);
  });

  Object.values(groupedRecords).forEach(seriesRecords => {
    seriesRecords.sort((a, b) => (
      toDateValue(a.date) - toDateValue(b.date) ||
      a.id - b.id
    ));
  });

  const sortedDates = [...dateCounts.keys()].sort((a, b) => toDateValue(a) - toDateValue(b));
  const earliestDate = sortedDates[0];
  const latestDate = sortedDates[sortedDates.length - 1];
  const seriesStats: SeriesStats[] = [];
  const jumps: JumpInsight[] = [];

  Object.values(groupedRecords).forEach(seriesRecords => {
    const first = seriesRecords[0];
    const last = seriesRecords[seriesRecords.length - 1];
    const previous = seriesRecords.length > 1 ? seriesRecords[seriesRecords.length - 2] : null;
    const previousRecords = seriesRecords.slice(0, -1);
    const minRecord = seriesRecords.reduce((min, record) => record.price < min.price ? record : min, first);
    const maxRecord = seriesRecords.reduce((max, record) => record.price > max.price ? record : max, first);
    const previousMinRecord = previousRecords.length > 0
      ? previousRecords.reduce((min, record) => record.price < min.price ? record : min, previousRecords[0])
      : null;
    const previousMaxRecord = previousRecords.length > 0
      ? previousRecords.reduce((max, record) => record.price > max.price ? record : max, previousRecords[0])
      : null;
    const periodCutoff = toDateValue(last.date) - 30 * DAY_MS;
    const periodBase = [...seriesRecords].reverse().find(record => toDateValue(record.date) <= periodCutoff) || first;
    const periodChangePercent = periodBase.id !== last.id ? percentChange(last.price, periodBase.price) : null;
    const changeAmount = previous ? last.price - previous.price : null;
    const changePercent = previous ? percentChange(last.price, previous.price) : null;
    const fromFirstPercent = percentChange(last.price, first.price) || 0;
    const drawdownPercent = percentChange(last.price, maxRecord.price) || 0;
    const historicalHighBreakPercent = previousMaxRecord && last.price > previousMaxRecord.price
      ? percentChange(last.price, previousMaxRecord.price)
      : null;
    const historicalLowBreakPercent = previousMinRecord && last.price < previousMinRecord.price
      ? percentChange(last.price, previousMinRecord.price)
      : null;

    seriesStats.push({
      label: buildSeriesLabel(last),
      category_name: last.category,
      object_name: last.object_name,
      variant_name: last.variant || '',
      category_id: last.category_id,
      object_id: last.object_id,
      variant_id: last.variant_id,
      record_count: seriesRecords.length,
      first_date: first.date,
      first_price: first.price,
      current_date: last.date,
      current_price: last.price,
      previous_date: previous?.date || null,
      previous_price: previous?.price || null,
      change_amount: changeAmount,
      change_percent: changePercent,
      period_start_date: periodBase.id !== last.id ? periodBase.date : null,
      period_change_percent: periodChangePercent,
      min_price: minRecord.price,
      min_date: minRecord.date,
      max_price: maxRecord.price,
      max_date: maxRecord.date,
      drawdown_percent: drawdownPercent,
      from_first_percent: fromFirstPercent,
      historical_high_break_percent: historicalHighBreakPercent,
      historical_low_break_percent: historicalLowBreakPercent,
      days_since_latest: daysBetween(last.date, latestDate),
      source: last.source,
      note: last.note
    });

    for (let index = 1; index < seriesRecords.length; index++) {
      const fromRecord = seriesRecords[index - 1];
      const toRecord = seriesRecords[index];
      const jumpPercent = percentChange(toRecord.price, fromRecord.price);
      if (jumpPercent === null) continue;

      jumps.push({
        label: buildSeriesLabel(toRecord),
        category_name: toRecord.category,
        object_name: toRecord.object_name,
        variant_name: toRecord.variant || '',
        category_id: toRecord.category_id,
        object_id: toRecord.object_id,
        variant_id: toRecord.variant_id,
        from_date: fromRecord.date,
        to_date: toRecord.date,
        from_price: fromRecord.price,
        to_price: toRecord.price,
        change_amount: toRecord.price - fromRecord.price,
        change_percent: jumpPercent,
        source: toRecord.source,
        note: toRecord.note
      });
    }
  });

  const activeSeries = seriesStats.filter(item => item.days_since_latest <= 7);
  const staleSeries = seriesStats.filter(item => item.days_since_latest >= 14);
  const suspectedAnomalies = jumps
    .filter(item => Math.abs(item.change_percent) >= 20 || Math.abs(item.change_amount) >= 1000)
    .sort((a, b) => Math.abs(b.change_percent) - Math.abs(a.change_percent))
    .slice(0, 20)
    .map(toJumpInsightItem);

  const categorySummary = [...categoryCounts.entries()].map(([category, totalRecords]) => {
    const categorySeries = seriesStats.filter(item => item.category_name === category);
    const movedSeries = categorySeries.filter(item => item.change_percent !== null);
    const totalMove = movedSeries.reduce((sum, item) => sum + (item.change_percent || 0), 0);

    return {
      category,
      total_records: totalRecords,
      series_count: categorySeries.length,
      active_series_last_7d: categorySeries.filter(item => item.days_since_latest <= 7).length,
      latest_up: movedSeries.filter(item => (item.change_percent || 0) > 0).length,
      latest_down: movedSeries.filter(item => (item.change_percent || 0) < 0).length,
      latest_flat: movedSeries.filter(item => item.change_percent === 0).length,
      avg_latest_change_percent: movedSeries.length > 0 ? roundNumber(totalMove / movedSeries.length) : null
    };
  }).sort((a, b) => b.total_records - a.total_records);

  return {
    overview: {
      total_records: records.length,
      series_count: seriesStats.length,
      category_count: categoryCounts.size,
      earliest_date: earliestDate,
      latest_date: latestDate,
      latest_date_records: dateCounts.get(latestDate) || 0,
      active_series_last_7d: activeSeries.length,
      stale_series_over_14d: staleSeries.length,
      suspected_anomaly_count: suspectedAnomalies.length
    },
    category_summary: categorySummary,
    latest_moves: activeSeries
      .filter(item => item.change_percent !== null)
      .sort((a, b) => Math.abs(b.change_percent || 0) - Math.abs(a.change_percent || 0))
      .slice(0, 12)
      .map(toInsightItem),
    period_gainers: activeSeries
      .filter(item => item.period_change_percent !== null)
      .sort((a, b) => (b.period_change_percent || 0) - (a.period_change_percent || 0))
      .slice(0, 10)
      .map(toInsightItem),
    period_losers: activeSeries
      .filter(item => item.period_change_percent !== null)
      .sort((a, b) => (a.period_change_percent || 0) - (b.period_change_percent || 0))
      .slice(0, 10)
      .map(toInsightItem),
    drawdowns: activeSeries
      .sort((a, b) => a.drawdown_percent - b.drawdown_percent)
      .slice(0, 12)
      .map(toInsightItem),
    record_highs: activeSeries
      .filter(item => item.record_count >= 2 && item.historical_high_break_percent !== null)
      .sort((a, b) => toDateValue(b.current_date) - toDateValue(a.current_date) || b.current_price - a.current_price)
      .slice(0, 10)
      .map(toInsightItem),
    record_lows: activeSeries
      .filter(item => item.record_count >= 2 && item.historical_low_break_percent !== null)
      .sort((a, b) => toDateValue(b.current_date) - toDateValue(a.current_date) || a.current_price - b.current_price)
      .slice(0, 10)
      .map(toInsightItem),
    stale_targets: staleSeries
      .sort((a, b) => b.days_since_latest - a.days_since_latest || b.record_count - a.record_count)
      .slice(0, 20)
      .map(toInsightItem),
    suspected_anomalies: suspectedAnomalies,
    recent_dates: [...dateCounts.entries()]
      .sort((a, b) => toDateValue(b[0]) - toDateValue(a[0]))
      .slice(0, 12)
      .map(([date, count]) => ({ date, count }))
  };
};

router.get("/price-records/insights", async (req, res) => {
  try {
    const db = await getDb();
    const { categoryIds, objectIds, variantIds } = await getTargetIdMaps(db);
    const rows = await db.all(`
      SELECT 
        id,
        date,
        category,
        object_name,
        COALESCE(variant, '') as variant,
        CAST(price AS REAL) as price,
        source,
        note
      FROM price_records
      WHERE date IS NOT NULL AND price IS NOT NULL
      ORDER BY category, object_name, variant, date ASC, created_at ASC, id ASC
    `);

    const records: PriceRecordRow[] = rows
      .map((row: any) => {
        const categoryId = categoryIds.get(row.category) || null;
        const objectId = categoryId ? objectIds.get(`${categoryId}|${row.object_name}`) || null : null;
        const variantId = objectId && row.variant ? variantIds.get(`${objectId}|${row.variant}`) || null : null;

        return {
          id: Number(row.id),
          date: String(row.date || '').slice(0, 10),
          category: String(row.category || '').trim(),
          object_name: String(row.object_name || '').trim(),
          variant: String(row.variant || '').trim(),
          price: Number(row.price),
          source: row.source || null,
          note: row.note || null,
          category_id: categoryId,
          object_id: objectId,
          variant_id: variantId
        };
      })
      .filter((row: PriceRecordRow) => row.date && row.category && row.object_name && Number.isFinite(row.price));

    res.json({
      status: "success",
      data: buildPriceInsights(records)
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "Failed to build price insights", error: errorMessage });
  }
});

router.get("/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const { category, object_name, variant } = req.query;
    
    let query = "SELECT * FROM price_records";
    const params = [];
    
    if (category || object_name || variant) {
      query += " WHERE";
      if (category) {
        query += " category = ?";
        params.push(category);
      }
      if (object_name) {
        query += params.length > 0 ? " AND" : "";
        query += " object_name = ?";
        params.push(object_name);
      }
      if (variant) {
        query += params.length > 0 ? " AND" : "";
        query += " variant = ?";
        params.push(variant);
      }
    }
    
    const priceRecords = await db.all(query, params);
    res.json({ status: "success", data: priceRecords });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ status: "error", message: "Failed to fetch price records", error: errorMessage });
  }
});

router.post("/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const { date, category_name, object_name, variant_name, price, source, note } = req.body;
    
    // 校验字段
    if (!category_name || !object_name || !price || !date) {
      return res.status(400).json({ 
        success: false, 
        message: "缺少必填字段", 
        error_code: "MISSING_REQUIRED_FIELD", 
        data: null 
      });
    }
    
    // 校验价格是否为数字
    if (typeof price !== 'number') {
      return res.status(400).json({ 
        success: false, 
        message: "price 字段格式错误", 
        error_code: "INVALID_PRICE", 
        data: null 
      });
    }
    
    // 校验日期格式
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ 
        success: false, 
        message: "日期格式错误", 
        error_code: "INVALID_DATE", 
        data: null 
      });
    }
    
    // 标准化 variant_name
    const variant = variant_name || '';
    
    // 校验主数据是否存在
    const category = await db.get("SELECT * FROM categories WHERE name = ?", [category_name]);
    if (!category) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ?", [category.id, object_name]);
    if (!object) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (variant_name) {
      const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ?", [object.id, variant_name]);
      if (!variant) {
        return res.status(400).json({ 
          success: false, 
          message: "未找到对应主数据", 
          error_code: "MASTER_DATA_NOT_FOUND", 
          data: null 
        });
      }
    }
    
    // 检查是否已存在相同记录
    const existingRecord = await db.get(
      "SELECT * FROM price_records WHERE date = ? AND category = ? AND object_name = ? AND variant = ?",
      [date, category_name, object_name, variant]
    );
    
    if (existingRecord) {
      return res.status(400).json({
        success: false,
        message: "该对象在该日期已有价格记录，请使用编辑功能修改",
        error_code: "PRICE_RECORD_DUPLICATE",
        data: null
      });
    }
    
    // 插入记录
    const now = new Date().toISOString();
    const result = await db.run("INSERT INTO price_records (date, category, object_name, variant, price, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [date, category_name, object_name, variant, price, source, note, now, now]);
    
    // 返回新增后的数据
    const newRecord = await db.get("SELECT * FROM price_records WHERE id = ?", [result.lastID]);
    res.json({
      success: true,
      message: "价格记录新增成功",
      data: {
        id: newRecord.id,
        date: newRecord.date,
        category_name: newRecord.category,
        object_name: newRecord.object_name,
        variant_name: newRecord.variant,
        price: newRecord.price,
        source: newRecord.source,
        note: newRecord.note
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "未知错误，请联系开发排查", 
      error_code: "UNKNOWN_ERROR", 
      data: null 
    });
  }
});

router.put("/price-records/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const { date, category_name, object_name, variant_name, price, source, note } = req.body;
    
    // 标准化字段
    const normalizedDate = date ? date.trim() : '';
    const normalizedCategoryName = category_name ? category_name.trim() : '';
    const normalizedObjectName = object_name ? object_name.trim() : '';
    const normalizedVariantName = variant_name ? variant_name.trim() : '';
    const normalizedSource = source ? source.trim() : '';
    const normalizedNote = note ? note.trim() : '';
    
    // 校验必填字段
    if (!normalizedCategoryName || !normalizedObjectName || price === undefined || !normalizedDate) {
      return res.status(400).json({ 
        success: false, 
        message: "缺少必填字段", 
        error_code: "MISSING_REQUIRED_FIELD", 
        data: null 
      });
    }
    
    // 校验价格是否为数字
    if (typeof price !== 'number') {
      return res.status(400).json({ 
        success: false, 
        message: "price 字段格式错误", 
        error_code: "INVALID_PRICE", 
        data: null 
      });
    }
    
    // 校验日期格式
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(normalizedDate)) {
      return res.status(400).json({ 
        success: false, 
        message: "日期格式错误", 
        error_code: "INVALID_DATE", 
        data: null 
      });
    }
    
    // 校验主数据是否存在
    const category = await db.get("SELECT * FROM categories WHERE name = ?", [normalizedCategoryName]);
    if (!category) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ?", [category.id, normalizedObjectName]);
    if (!object) {
      return res.status(400).json({ 
        success: false, 
        message: "未找到对应主数据", 
        error_code: "MASTER_DATA_NOT_FOUND", 
        data: null 
      });
    }
    
    // 如果 variant_name 不为空，校验变体是否存在
    if (normalizedVariantName) {
      const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ?", [object.id, normalizedVariantName]);
      if (!variant) {
        return res.status(400).json({ 
          success: false, 
          message: "未找到对应主数据", 
          error_code: "MASTER_DATA_NOT_FOUND", 
          data: null 
        });
      }
    }
    
    // 检查是否已存在相同记录（排除当前记录自身）
    const existingRecord = await db.get(
      "SELECT * FROM price_records WHERE date = ? AND category = ? AND object_name = ? AND variant = ? AND id != ?",
      [normalizedDate, normalizedCategoryName, normalizedObjectName, normalizedVariantName, id]
    );
    
    if (existingRecord) {
      return res.status(400).json({
        success: false,
        message: "该对象在该日期已有其它价格记录，请检查后修改",
        error_code: "PRICE_RECORD_DUPLICATE",
        data: null
      });
    }
    
    // 更新记录
    const now = new Date().toISOString();
    const result = await db.run(
      "UPDATE price_records SET date = ?, category = ?, object_name = ?, variant = ?, price = ?, source = ?, note = ?, updated_at = ? WHERE id = ?", 
      [normalizedDate, normalizedCategoryName, normalizedObjectName, normalizedVariantName, price, normalizedSource, normalizedNote, now, id]
    );
    
    // 检查记录是否存在
    if (result.changes === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "记录不存在", 
        error_code: "UNKNOWN_ERROR", 
        data: null 
      });
    }
    
    // 返回更新后的数据
    const updatedRecord = await db.get("SELECT * FROM price_records WHERE id = ?", [id]);
    res.json({
      success: true,
      message: "修改成功",
      data: {
        id: updatedRecord.id,
        date: updatedRecord.date,
        category_name: updatedRecord.category,
        object_name: updatedRecord.object_name,
        variant_name: updatedRecord.variant,
        price: updatedRecord.price,
        source: updatedRecord.source,
        note: updatedRecord.note
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "未知错误，请联系开发排查", 
      error_code: "UNKNOWN_ERROR", 
      data: null 
    });
  }
});

router.post("/import/price-records", async (req, res) => {
  try {
    const db = await getDb();
    const records = req.body;
    
    if (!Array.isArray(records)) {
      return res.status(400).json({ 
        success: false, 
        message: "导入失败：请求体格式错误", 
        data: null 
      });
    }
    
    let success = 0;
    let skipped = 0;
    let failed = 0;
    const failed_records = [];
    const skipped_records = [];
    
    // 用于跟踪本批已处理的记录，避免包内重复
    const processedRecords = new Set();
    
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      
      // 标准化字段
      const date = record.date ? record.date.trim() : '';
      const category_name = record.category_name ? record.category_name.trim() : '';
      const object_name = record.object_name ? record.object_name.trim() : '';
      const variant_name = record.variant_name ? record.variant_name.trim() : '';
      const price = record.price;
      const source = record.source ? record.source.trim() : '';
      const note = record.note ? record.note.trim() : '';
      
      // 校验必填字段
      if (!category_name || !object_name || price === undefined || !date) {
        failed++;
        failed_records.push({
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "MISSING_REQUIRED_FIELD",
          message: "缺少必填字段"
        });
        continue;
      }
      
      // 校验价格是否为数字
      if (typeof price !== 'number') {
        failed++;
        failed_records.push({
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "INVALID_PRICE",
          message: "price 字段格式错误"
        });
        continue;
      }
      
      // 校验日期格式
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        failed++;
        failed_records.push({
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "INVALID_DATE",
          message: "日期格式错误"
        });
        continue;
      }
      
      // 检查本批数据内部重复
      const recordKey = `${date}|${category_name}|${object_name}|${variant_name}`;
      if (processedRecords.has(recordKey)) {
        skipped++;
        skipped_records.push({
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "PRICE_RECORD_DUPLICATE",
          message: "该对象在该日期已有价格记录，已跳过"
        });
        continue;
      }
      
      // 校验主数据是否存在
      try {
        const category = await db.get("SELECT * FROM categories WHERE name = ?", [category_name]);
        if (!category) {
          failed++;
          failed_records.push({
            date: date,
            category_name: category_name,
            object_name: object_name,
            variant_name: variant_name,
            reason: "MASTER_DATA_NOT_FOUND",
            message: "未找到对应主数据"
          });
          continue;
        }
        
        const object = await db.get("SELECT * FROM objects WHERE category_id = ? AND name = ?", [category.id, object_name]);
        if (!object) {
          failed++;
          failed_records.push({
            date: date,
            category_name: category_name,
            object_name: object_name,
            variant_name: variant_name,
            reason: "MASTER_DATA_NOT_FOUND",
            message: "未找到对应主数据"
          });
          continue;
        }
        
        // 如果 variant_name 不为空，校验变体是否存在
        if (variant_name) {
          const variant = await db.get("SELECT * FROM variants WHERE object_id = ? AND name = ?", [object.id, variant_name]);
          if (!variant) {
            failed++;
            failed_records.push({
              date: date,
              category_name: category_name,
              object_name: object_name,
              variant_name: variant_name,
              reason: "MASTER_DATA_NOT_FOUND",
              message: "未找到对应主数据"
            });
            continue;
          }
        }
        
        // 检查数据库中是否已存在
        const existingRecord = await db.get(
          "SELECT * FROM price_records WHERE date = ? AND category = ? AND object_name = ? AND variant = ?",
          [date, category_name, object_name, variant_name]
        );
        
        if (existingRecord) {
          skipped++;
          skipped_records.push({
            date: date,
            category_name: category_name,
            object_name: object_name,
            variant_name: variant_name,
            reason: "PRICE_RECORD_DUPLICATE",
            message: "该对象在该日期已有价格记录，已跳过"
          });
          continue;
        }
        
        // 插入记录
        const now = new Date().toISOString();
        await db.run(
          "INSERT INTO price_records (date, category, object_name, variant, price, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [date, category_name, object_name, variant_name, price, source, note, now, now]
        );
        success++;
        processedRecords.add(recordKey);
      } catch (error) {
        failed++;
        failed_records.push({
          date: date,
          category_name: category_name,
          object_name: object_name,
          variant_name: variant_name,
          reason: "UNKNOWN_ERROR",
          message: "未知错误，请联系开发排查"
        });
      }
    }
    
    res.json({
      success: true,
      message: "导入完成",
      data: {
        success_count: success,
        skipped_count: skipped,
        failed_count: failed,
        skipped_records: skipped_records,
        failed_records: failed_records
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "导入失败：服务端异常", 
      data: null 
    });
  }
});

export default router;
