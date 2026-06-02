import express from "express";
import getDb from "../config/database";

const router = express.Router();

const VALID_POSITION_LEVELS = new Set(["main", "watch", "do_not", "low"]);
const VALID_STATUSES = new Set(["active", "draft", "archived"]);
const VALID_CONFIDENCE = new Set(["confirmed", "rough", "unknown"]);

const ARCHIVE_TEXT_FIELDS = [
  "raw_description",
  "issue_info",
  "theme_design",
  "trading_process",
  "risk_basis",
  "experience_note",
  "pending_questions",
  "note"
] as const;

const STAGE_TEXT_FIELDS = [
  "stage_name",
  "time_text",
  "stage_type",
  "stage_summary",
  "action_rule",
  "evidence_note",
  "note"
] as const;

const normalizeText = (value: unknown) => String(value ?? "").trim();

const roundNumber = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const multiplier = Math.pow(10, digits);
  return Math.round(value * multiplier) / multiplier;
};

const percentChange = (current: number, base: number) => {
  if (!Number.isFinite(current) || !Number.isFinite(base) || base === 0) return null;
  return roundNumber(((current - base) / base) * 100);
};

const toDateValue = (date: string) => {
  const value = new Date(date).getTime();
  return Number.isFinite(value) ? value : 0;
};

const parseOptionalPositiveInteger = (value: unknown) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseOptionalNumber = (value: unknown) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildMasterTarget = async (db: any, body: Record<string, any>, existing?: any) => {
  const categoryId = parseOptionalPositiveInteger(
    Object.prototype.hasOwnProperty.call(body, "category_id") ? body.category_id : existing?.category_id
  );
  const objectId = parseOptionalPositiveInteger(
    Object.prototype.hasOwnProperty.call(body, "object_id") ? body.object_id : existing?.object_id
  );
  const variantId = parseOptionalPositiveInteger(
    Object.prototype.hasOwnProperty.call(body, "variant_id") ? body.variant_id : existing?.variant_id
  );

  if (!categoryId || !objectId) {
    throw new Error("品种档案必须关联品类和对象");
  }

  const object = await db.get(
    `SELECT o.id AS object_id, o.name AS object_name, c.id AS category_id, c.name AS category_name
     FROM objects o
     JOIN categories c ON c.id = o.category_id
     WHERE c.id = ?
       AND o.id = ?
       AND COALESCE(c.is_archived, 0) = 0
       AND COALESCE(o.is_archived, 0) = 0`,
    [categoryId, objectId]
  );
  if (!object) {
    throw new Error("关联的品类/对象不存在或已归档");
  }

  let variant: any = null;
  if (variantId) {
    variant = await db.get(
      `SELECT v.id, v.name
       FROM variants v
       WHERE v.id = ?
         AND v.object_id = ?
         AND COALESCE(v.is_archived, 0) = 0`,
      [variantId, objectId]
    );
    if (!variant) {
      throw new Error("关联的变体不存在或已归档");
    }
  }

  return {
    category_id: object.category_id,
    category_name: object.category_name,
    object_id: object.object_id,
    object_name: object.object_name,
    variant_id: variant?.id || null,
    variant_name: variant?.name || ""
  };
};

const archiveDisplayName = (payload: Record<string, any>, explicitName?: unknown) => {
  const name = normalizeText(explicitName);
  if (name) return name;
  return [payload.category_name, payload.object_name, payload.variant_name]
    .filter(Boolean)
    .join(" / ");
};

const buildArchivePayload = async (db: any, body: Record<string, any>, existing?: any) => {
  const target = await buildMasterTarget(db, body, existing);
  const positionLevel = normalizeText(body.position_level ?? existing?.position_level ?? "watch");
  if (!VALID_POSITION_LEVELS.has(positionLevel)) {
    throw new Error("档案定位只能是 main、watch、do_not、low");
  }

  const status = normalizeText(body.status ?? existing?.status ?? "draft");
  if (!VALID_STATUSES.has(status)) {
    throw new Error("档案状态只能是 active、draft、archived");
  }

  const confidence = normalizeText(body.confidence ?? existing?.confidence ?? "unknown");
  if (!VALID_CONFIDENCE.has(confidence)) {
    throw new Error("资料可信度只能是 confirmed、rough、unknown");
  }

  const oneSentenceJudgment = normalizeText(body.one_sentence_judgment ?? existing?.one_sentence_judgment);
  if (!oneSentenceJudgment) {
    throw new Error("请填写一句话判断");
  }

  const payload: Record<string, any> = {
    ...target,
    archive_name: archiveDisplayName(target, body.archive_name ?? existing?.archive_name),
    position_level: positionLevel,
    one_sentence_judgment: oneSentenceJudgment,
    confidence,
    status,
    ...ARCHIVE_TEXT_FIELDS.reduce<Record<string, string>>((acc, field) => {
      acc[field] = normalizeText(body[field] ?? existing?.[field]);
      return acc;
    }, {})
  };
  return payload;
};

const buildStagePayload = (body: Record<string, any>, existing?: any) => {
  const stageName = normalizeText(body.stage_name ?? existing?.stage_name);
  const timeText = normalizeText(body.time_text ?? existing?.time_text);
  const stageSummary = normalizeText(body.stage_summary ?? existing?.stage_summary);
  if (!stageName || !stageSummary) {
    throw new Error("阶段名称和阶段总结不能为空");
  }

  const confidence = normalizeText(body.confidence ?? existing?.confidence ?? "rough");
  if (!VALID_CONFIDENCE.has(confidence)) {
    throw new Error("阶段可信度只能是 confirmed、rough、unknown");
  }

  const payload: Record<string, any> = {
    confidence,
    price_start: parseOptionalNumber(body.price_start ?? existing?.price_start),
    price_high: parseOptionalNumber(body.price_high ?? existing?.price_high),
    price_low: parseOptionalNumber(body.price_low ?? existing?.price_low),
    price_end: parseOptionalNumber(body.price_end ?? existing?.price_end),
    sort_order: Number.isInteger(Number(body.sort_order ?? existing?.sort_order))
      ? Number(body.sort_order ?? existing?.sort_order)
      : 0,
    ...STAGE_TEXT_FIELDS.reduce<Record<string, string>>((acc, field) => {
      acc[field] = normalizeText(body[field] ?? existing?.[field]);
      return acc;
    }, { stage_name: stageName, time_text: timeText, stage_summary: stageSummary })
  };
  return payload;
};

const serializeArchive = (row: any) => ({
  ...row,
  id: String(row.id),
  category_id: String(row.category_id),
  object_id: String(row.object_id),
  variant_id: row.variant_id ? String(row.variant_id) : "",
  stage_count: Number(row.stage_count || 0),
  anchor_count: Number(row.anchor_count || 0)
});

const serializeStage = (row: any) => ({
  ...row,
  id: String(row.id),
  archive_id: String(row.archive_id)
});

const loadArchive = async (db: any, id: string) => db.get(
  `SELECT pa.*,
          COALESCE(stage_counts.stage_count, 0) AS stage_count,
          COALESCE(anchor_counts.anchor_count, 0) AS anchor_count
   FROM product_archives pa
   LEFT JOIN (
     SELECT archive_id, COUNT(*) AS stage_count
     FROM product_archive_stages
     WHERE COALESCE(is_deleted, 0) = 0
     GROUP BY archive_id
   ) stage_counts ON stage_counts.archive_id = pa.id
   LEFT JOIN (
     SELECT pa2.id AS archive_id, COUNT(opr.id) AS anchor_count
     FROM product_archives pa2
     LEFT JOIN original_price_records opr
       ON opr.category_id = pa2.category_id
      AND opr.object_id = pa2.object_id
      AND COALESCE(opr.is_deleted, 0) = 0
      AND (
        pa2.variant_id IS NULL
        OR opr.variant_id = pa2.variant_id
        OR COALESCE(opr.variant_name, '') = COALESCE(pa2.variant_name, '')
      )
     GROUP BY pa2.id
   ) anchor_counts ON anchor_counts.archive_id = pa.id
   WHERE pa.id = ? AND COALESCE(pa.is_deleted, 0) = 0`,
  [id]
);

const loadStages = async (db: any, archiveId: string) => db.all(
  `SELECT *
   FROM product_archive_stages
   WHERE archive_id = ? AND COALESCE(is_deleted, 0) = 0
   ORDER BY sort_order ASC, id ASC`,
  [archiveId]
);

const loadPriceAnchors = async (db: any, archive: any) => db.all(
  `SELECT *
   FROM original_price_records
   WHERE COALESCE(is_deleted, 0) = 0
     AND category_id = ?
     AND object_id = ?
     AND (
       ? IS NULL
       OR variant_id = ?
       OR COALESCE(variant_name, '') = ?
     )
   ORDER BY effective_date ASC, id ASC`,
  [archive.category_id, archive.object_id, archive.variant_id, archive.variant_id, archive.variant_name || ""]
);

const loadPriceStats = async (db: any, archive: any) => db.get(
  `SELECT COUNT(*) AS record_count,
          MIN(date) AS first_date,
          MAX(date) AS latest_date,
          MIN(price) AS low_price,
          MAX(price) AS high_price,
          ROUND(AVG(price), 2) AS avg_price,
          (SELECT price FROM price_records p2
           WHERE p2.category = pr.category
             AND p2.object_name = pr.object_name
             AND COALESCE(p2.variant, '') = COALESCE(pr.variant, '')
           ORDER BY p2.date DESC, p2.id DESC
           LIMIT 1) AS latest_price
   FROM price_records pr
   WHERE pr.category = ?
     AND pr.object_name = ?
     AND (
       ? = ''
       OR COALESCE(pr.variant, '') = ?
     )`,
  [archive.category_name, archive.object_name, archive.variant_name || "", archive.variant_name || ""]
);

const buildPriceEvidence = (rows: any[]) => {
  const records = rows
    .map(row => ({
      id: Number(row.id),
      date: normalizeText(row.date),
      price: Number(row.price),
      source: normalizeText(row.source),
      note: normalizeText(row.note)
    }))
    .filter(row => row.date && Number.isFinite(row.price) && row.price > 0)
    .sort((a, b) => toDateValue(a.date) - toDateValue(b.date) || a.id - b.id);

  if (records.length === 0) {
    return {
      record_count: 0,
      sample_quality: "no_data",
      sample_quality_label: "暂无价格记录",
      trend_label: "暂无价格证据",
      evidence_notes: [],
      recent_records: [],
      key_moves: []
    };
  }

  const first = records[0];
  const latest = records[records.length - 1];
  const previous = records.length > 1 ? records[records.length - 2] : null;
  const minRecord = records.reduce((min, record) => record.price < min.price ? record : min, first);
  const maxRecord = records.reduce((max, record) => record.price > max.price ? record : max, first);
  const spanDays = Math.max(0, Math.round((toDateValue(latest.date) - toDateValue(first.date)) / (24 * 60 * 60 * 1000)));
  const latestChangePercent = previous ? percentChange(latest.price, previous.price) : null;
  const latestChangeAmount = previous ? roundNumber(latest.price - previous.price) : null;
  const fromFirstPercent = percentChange(latest.price, first.price);
  const drawdownPercent = percentChange(latest.price, maxRecord.price);
  const amplitudePercent = percentChange(maxRecord.price, minRecord.price);
  const periodCutoff = toDateValue(latest.date) - 30 * 24 * 60 * 60 * 1000;
  const periodBase = [...records].reverse().find(record => toDateValue(record.date) <= periodCutoff) || first;
  const periodChangePercent = periodBase.id !== latest.id ? percentChange(latest.price, periodBase.price) : null;
  const periodChangeAmount = periodBase.id !== latest.id ? roundNumber(latest.price - periodBase.price) : null;
  const keyMoves = records
    .slice(1)
    .map((record, index) => {
      const from = records[index];
      const changePercent = percentChange(record.price, from.price);
      const changeAmount = roundNumber(record.price - from.price);
      return {
        from_date: from.date,
        to_date: record.date,
        from_price: roundNumber(from.price),
        to_price: roundNumber(record.price),
        change_amount: changeAmount,
        change_percent: changePercent,
        source: record.source,
        note: record.note
      };
    })
    .filter(move => {
      const percent = Math.abs(Number(move.change_percent || 0));
      const amount = Math.abs(Number(move.change_amount || 0));
      return percent >= 10 || amount >= 100;
    })
    .sort((a, b) => Math.abs(Number(b.change_percent || 0)) - Math.abs(Number(a.change_percent || 0)))
    .slice(0, 5);

  const sampleQuality = records.length >= 100
    ? "strong"
    : records.length >= 30
      ? "usable"
      : records.length >= 2
        ? "thin"
        : "single";
  const sampleQualityLabel: Record<string, string> = {
    strong: "样本较充分",
    usable: "样本可参考",
    thin: "样本偏少",
    single: "只有单点价格"
  };

  let trendLabel = "样本不足";
  if (records.length >= 2) {
    if (Number(drawdownPercent || 0) <= -35) {
      trendLabel = "高位明显回撤";
    } else if (Number(periodChangePercent || 0) <= -12) {
      trendLabel = "近期走弱";
    } else if (Number(periodChangePercent || 0) >= 12) {
      trendLabel = "近期走强";
    } else if (Number(fromFirstPercent || 0) >= 40 && Number(drawdownPercent || 0) > -20) {
      trendLabel = "阶段抬升";
    } else if (Number(amplitudePercent || 0) <= 8) {
      trendLabel = "窄幅横盘";
    } else {
      trendLabel = "震荡运行";
    }
  }

  const evidenceNotes = [
    `已有价格记录 ${records.length} 条，覆盖 ${first.date} 至 ${latest.date}`,
    `最新 ${roundNumber(latest.price)}，历史区间 ${roundNumber(minRecord.price)} - ${roundNumber(maxRecord.price)}`,
    fromFirstPercent !== null ? `相对首条记录 ${fromFirstPercent}%` : "",
    drawdownPercent !== null && maxRecord.id !== latest.id
      ? `较历史高点 ${roundNumber(maxRecord.price)}（${maxRecord.date}）回撤 ${drawdownPercent}%`
      : "",
    latestChangePercent !== null
      ? `最近一笔较上次 ${latestChangePercent}%（${latestChangeAmount || 0}）`
      : "",
    periodChangePercent !== null
      ? `约 30 天口径变化 ${periodChangePercent}%（${periodChangeAmount || 0}）`
      : "",
    keyMoves.length > 0
      ? `存在 ${keyMoves.length} 段明显跳变，最大单段 ${keyMoves[0].change_percent}%`
      : ""
  ].filter(Boolean);

  return {
    record_count: records.length,
    first_date: first.date,
    latest_date: latest.date,
    span_days: spanDays,
    first_price: roundNumber(first.price),
    latest_price: roundNumber(latest.price),
    previous_price: previous ? roundNumber(previous.price) : null,
    previous_date: previous?.date || null,
    low_price: roundNumber(minRecord.price),
    low_date: minRecord.date,
    high_price: roundNumber(maxRecord.price),
    high_date: maxRecord.date,
    latest_change_amount: latestChangeAmount,
    latest_change_percent: latestChangePercent,
    from_first_percent: fromFirstPercent,
    drawdown_percent: drawdownPercent,
    period_change_amount: periodChangeAmount,
    period_change_percent: periodChangePercent,
    amplitude_percent: amplitudePercent,
    sample_quality: sampleQuality,
    sample_quality_label: sampleQualityLabel[sampleQuality],
    trend_label: trendLabel,
    evidence_notes: evidenceNotes,
    recent_records: records.slice(-8).reverse().map(record => ({
      id: record.id,
      date: record.date,
      price: roundNumber(record.price),
      source: record.source,
      note: record.note
    })),
    key_moves: keyMoves
  };
};

const loadPriceEvidence = async (db: any, archive: any) => {
  const rows = await db.all(
    `SELECT id, date, CAST(price AS REAL) AS price, source, note
     FROM price_records
     WHERE category = ?
       AND object_name = ?
       AND (
         ? = ''
         OR COALESCE(variant, '') = ?
       )
     ORDER BY date ASC, id ASC`,
    [archive.category_name, archive.object_name, archive.variant_name || "", archive.variant_name || ""]
  );
  return buildPriceEvidence(rows);
};

const loadRelatedRecords = async (db: any, archive: any) => {
  const likeObject = `%${archive.object_name}%`;
  const likeVariant = archive.variant_name ? `%${archive.variant_name}%` : "";
  const matchParams = archive.variant_name ? [likeObject, likeVariant] : [likeObject, likeObject];

  return db.all(
    `SELECT *
     FROM (
       SELECT 'rule' AS record_type, id, title, track, source_case AS related_name,
              substr(COALESCE(core_content, '') || ' ' || COALESCE(summary_conclusion, '') || ' ' || COALESCE(note, ''), 1, 260) AS snippet,
              updated_at
       FROM rule_experiences
       WHERE COALESCE(is_deleted, 0) = 0
         AND (title LIKE ? OR source_case LIKE ? OR core_content LIKE ? OR summary_conclusion LIKE ? OR note LIKE ?)
       UNION ALL
       SELECT 'missed' AS record_type, id, title, track, project_name AS related_name,
              substr(COALESCE(reason, '') || ' ' || COALESCE(trend, '') || ' ' || COALESCE(exposed_problem, '') || ' ' || COALESCE(extracted_lesson, '') || ' ' || COALESCE(note, ''), 1, 260) AS snippet,
              updated_at
       FROM missed_projects
       WHERE COALESCE(is_deleted, 0) = 0
         AND (title LIKE ? OR project_name LIKE ? OR reason LIKE ? OR trend LIKE ? OR note LIKE ?)
       UNION ALL
       SELECT 'business_review' AS record_type, id, title, track, project_name AS related_name,
              substr(COALESCE(summary_conclusion, '') || ' ' || COALESCE(background, '') || ' ' || COALESCE(judgment_at_that_time, '') || ' ' || COALESCE(later_outcome, '') || ' ' || COALESCE(note, ''), 1, 260) AS snippet,
              updated_at
       FROM business_reviews
       WHERE COALESCE(is_deleted, 0) = 0
         AND (title LIKE ? OR project_name LIKE ? OR background LIKE ? OR later_outcome LIKE ? OR note LIKE ?)
       UNION ALL
       SELECT 'market_review' AS record_type, id, title, track, project_name AS related_name,
              substr(COALESCE(summary_conclusion, '') || ' ' || COALESCE(background, '') || ' ' || COALESCE(market_evolution, '') || ' ' || COALESCE(key_turning_points, '') || ' ' || COALESCE(note, ''), 1, 260) AS snippet,
              updated_at
       FROM market_reviews
       WHERE COALESCE(is_deleted, 0) = 0
         AND (title LIKE ? OR project_name LIKE ? OR background LIKE ? OR market_evolution LIKE ? OR note LIKE ?)
     )
     ORDER BY datetime(updated_at) DESC
     LIMIT 16`,
    [
      ...Array(5).fill(matchParams[0]),
      ...Array(5).fill(matchParams[0]),
      ...Array(5).fill(matchParams[0]),
      ...Array(5).fill(matchParams[0])
    ]
  );
};

const writeArchiveAuditLog = async (db: any, action: string, archive: any) => {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO audit_logs
      (id, timestamp, module, action, target, status, detail, entity_id, path, domain, workspace, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `product_archive_${action}_${archive.id}_${Date.now()}`,
      now,
      "品种档案",
      action,
      archive.archive_name,
      "success",
      archive.one_sentence_judgment || "",
      String(archive.id),
      "/risk-control/product-archives",
      "business",
      "business",
      now,
      now
    ]
  ).catch(() => undefined);
};

router.get("/product-archives", async (req, res) => {
  try {
    const db = await getDb();
    const where = ["COALESCE(pa.is_deleted, 0) = 0"];
    const params: any[] = [];
    const q = normalizeText(req.query.q);
    const status = normalizeText(req.query.status);
    const positionLevel = normalizeText(req.query.position_level);

    if (q) {
      where.push(`(
        pa.archive_name LIKE ?
        OR pa.category_name LIKE ?
        OR pa.object_name LIKE ?
        OR pa.variant_name LIKE ?
        OR pa.one_sentence_judgment LIKE ?
        OR pa.raw_description LIKE ?
      )`);
      const likeValue = `%${q}%`;
      params.push(likeValue, likeValue, likeValue, likeValue, likeValue, likeValue);
    }
    if (status) {
      where.push("pa.status = ?");
      params.push(status);
    }
    if (positionLevel) {
      where.push("pa.position_level = ?");
      params.push(positionLevel);
    }

    const rows = await db.all(
      `SELECT pa.*,
              COALESCE(stage_counts.stage_count, 0) AS stage_count,
              COALESCE(anchor_counts.anchor_count, 0) AS anchor_count
       FROM product_archives pa
       LEFT JOIN (
         SELECT archive_id, COUNT(*) AS stage_count
         FROM product_archive_stages
         WHERE COALESCE(is_deleted, 0) = 0
         GROUP BY archive_id
       ) stage_counts ON stage_counts.archive_id = pa.id
       LEFT JOIN (
         SELECT pa2.id AS archive_id, COUNT(opr.id) AS anchor_count
         FROM product_archives pa2
         LEFT JOIN original_price_records opr
           ON opr.category_id = pa2.category_id
          AND opr.object_id = pa2.object_id
          AND COALESCE(opr.is_deleted, 0) = 0
          AND (
            pa2.variant_id IS NULL
            OR opr.variant_id = pa2.variant_id
            OR COALESCE(opr.variant_name, '') = COALESCE(pa2.variant_name, '')
          )
         GROUP BY pa2.id
       ) anchor_counts ON anchor_counts.archive_id = pa.id
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE pa.position_level WHEN 'main' THEN 0 WHEN 'watch' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
         CASE pa.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
         datetime(pa.updated_at) DESC,
         pa.id DESC`,
      params
    );

    res.json({ success: true, data: rows.map(serializeArchive) });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取品种档案失败: ${(error as Error).message}` });
  }
});

router.get("/product-archives/:id", async (req, res) => {
  try {
    const db = await getDb();
    const archive = await loadArchive(db, String(req.params.id));
    if (!archive) {
      return res.status(404).json({ success: false, message: "品种档案不存在" });
    }
    const [stages, priceAnchors, priceStats, priceEvidence, relatedRecords] = await Promise.all([
      loadStages(db, String(archive.id)),
      loadPriceAnchors(db, archive),
      loadPriceStats(db, archive),
      loadPriceEvidence(db, archive),
      loadRelatedRecords(db, archive)
    ]);
    res.json({
      success: true,
      data: {
        archive: serializeArchive(archive),
        stages: stages.map(serializeStage),
        price_anchors: priceAnchors,
        price_stats: priceStats || {},
        price_evidence: priceEvidence,
        related_records: relatedRecords
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `获取品种档案详情失败: ${(error as Error).message}` });
  }
});

router.post("/product-archives", async (req, res) => {
  try {
    const db = await getDb();
    const payload = await buildArchivePayload(db, req.body || {});
    const now = new Date().toISOString();
    const result = await db.run(
      `INSERT INTO product_archives
        (category_id, category_name, object_id, object_name, variant_id, variant_name,
         archive_name, position_level, one_sentence_judgment, raw_description,
         issue_info, theme_design, trading_process, risk_basis, experience_note,
         pending_questions, confidence, status, note, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        payload.category_id,
        payload.category_name,
        payload.object_id,
        payload.object_name,
        payload.variant_id,
        payload.variant_name,
        payload.archive_name,
        payload.position_level,
        payload.one_sentence_judgment,
        payload.raw_description,
        payload.issue_info,
        payload.theme_design,
        payload.trading_process,
        payload.risk_basis,
        payload.experience_note,
        payload.pending_questions,
        payload.confidence,
        payload.status,
        payload.note,
        now,
        now
      ]
    );
    const archive = await loadArchive(db, String(result.lastID));
    await writeArchiveAuditLog(db, "create", archive);
    res.json({ success: true, data: serializeArchive(archive), message: "新增品种档案成功" });
  } catch (error) {
    res.status(400).json({ success: false, message: (error as Error).message || "新增品种档案失败" });
  }
});

router.put("/product-archives/:id", async (req, res) => {
  try {
    const db = await getDb();
    const existing = await loadArchive(db, String(req.params.id));
    if (!existing) {
      return res.status(404).json({ success: false, message: "品种档案不存在" });
    }
    const payload = await buildArchivePayload(db, req.body || {}, existing);
    const now = new Date().toISOString();
    await db.run(
      `UPDATE product_archives
       SET category_id = ?, category_name = ?, object_id = ?, object_name = ?,
           variant_id = ?, variant_name = ?, archive_name = ?, position_level = ?,
           one_sentence_judgment = ?, raw_description = ?, issue_info = ?,
           theme_design = ?, trading_process = ?, risk_basis = ?, experience_note = ?,
           pending_questions = ?, confidence = ?, status = ?, note = ?, updated_at = ?
       WHERE id = ? AND COALESCE(is_deleted, 0) = 0`,
      [
        payload.category_id,
        payload.category_name,
        payload.object_id,
        payload.object_name,
        payload.variant_id,
        payload.variant_name,
        payload.archive_name,
        payload.position_level,
        payload.one_sentence_judgment,
        payload.raw_description,
        payload.issue_info,
        payload.theme_design,
        payload.trading_process,
        payload.risk_basis,
        payload.experience_note,
        payload.pending_questions,
        payload.confidence,
        payload.status,
        payload.note,
        now,
        existing.id
      ]
    );
    const archive = await loadArchive(db, String(existing.id));
    await writeArchiveAuditLog(db, "update", archive);
    res.json({ success: true, data: serializeArchive(archive), message: "编辑品种档案成功" });
  } catch (error) {
    res.status(400).json({ success: false, message: (error as Error).message || "编辑品种档案失败" });
  }
});

router.delete("/product-archives/:id", async (req, res) => {
  try {
    const db = await getDb();
    const archive = await loadArchive(db, String(req.params.id));
    if (!archive) {
      return res.status(404).json({ success: false, message: "品种档案不存在" });
    }
    await db.run("UPDATE product_archives SET is_deleted = 1, updated_at = ? WHERE id = ?", [new Date().toISOString(), archive.id]);
    await writeArchiveAuditLog(db, "delete", archive);
    res.json({ success: true, data: { id: String(archive.id) }, message: "删除品种档案成功" });
  } catch (error) {
    res.status(500).json({ success: false, message: `删除品种档案失败: ${(error as Error).message}` });
  }
});

router.post("/product-archives/:archiveId/stages", async (req, res) => {
  try {
    const db = await getDb();
    const archive = await loadArchive(db, String(req.params.archiveId));
    if (!archive) {
      return res.status(404).json({ success: false, message: "品种档案不存在" });
    }
    const payload = buildStagePayload(req.body || {});
    const now = new Date().toISOString();
    const result = await db.run(
      `INSERT INTO product_archive_stages
        (archive_id, stage_name, time_text, stage_type, price_start, price_high, price_low,
         price_end, stage_summary, action_rule, evidence_note, confidence, sort_order,
         note, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        archive.id,
        payload.stage_name,
        payload.time_text,
        payload.stage_type,
        payload.price_start,
        payload.price_high,
        payload.price_low,
        payload.price_end,
        payload.stage_summary,
        payload.action_rule,
        payload.evidence_note,
        payload.confidence,
        payload.sort_order,
        payload.note,
        now,
        now
      ]
    );
    const stage = await db.get("SELECT * FROM product_archive_stages WHERE id = ?", [result.lastID]);
    res.json({ success: true, data: serializeStage(stage), message: "新增阶段记录成功" });
  } catch (error) {
    res.status(400).json({ success: false, message: (error as Error).message || "新增阶段记录失败" });
  }
});

router.put("/product-archive-stages/:id", async (req, res) => {
  try {
    const db = await getDb();
    const existing = await db.get(
      "SELECT * FROM product_archive_stages WHERE id = ? AND COALESCE(is_deleted, 0) = 0",
      [req.params.id]
    );
    if (!existing) {
      return res.status(404).json({ success: false, message: "阶段记录不存在" });
    }
    const payload = buildStagePayload(req.body || {}, existing);
    const now = new Date().toISOString();
    await db.run(
      `UPDATE product_archive_stages
       SET stage_name = ?, time_text = ?, stage_type = ?, price_start = ?, price_high = ?,
           price_low = ?, price_end = ?, stage_summary = ?, action_rule = ?, evidence_note = ?,
           confidence = ?, sort_order = ?, note = ?, updated_at = ?
       WHERE id = ? AND COALESCE(is_deleted, 0) = 0`,
      [
        payload.stage_name,
        payload.time_text,
        payload.stage_type,
        payload.price_start,
        payload.price_high,
        payload.price_low,
        payload.price_end,
        payload.stage_summary,
        payload.action_rule,
        payload.evidence_note,
        payload.confidence,
        payload.sort_order,
        payload.note,
        now,
        existing.id
      ]
    );
    const stage = await db.get("SELECT * FROM product_archive_stages WHERE id = ?", [existing.id]);
    res.json({ success: true, data: serializeStage(stage), message: "编辑阶段记录成功" });
  } catch (error) {
    res.status(400).json({ success: false, message: (error as Error).message || "编辑阶段记录失败" });
  }
});

router.delete("/product-archive-stages/:id", async (req, res) => {
  try {
    const db = await getDb();
    const stage = await db.get(
      "SELECT * FROM product_archive_stages WHERE id = ? AND COALESCE(is_deleted, 0) = 0",
      [req.params.id]
    );
    if (!stage) {
      return res.status(404).json({ success: false, message: "阶段记录不存在" });
    }
    await db.run("UPDATE product_archive_stages SET is_deleted = 1, updated_at = ? WHERE id = ?", [new Date().toISOString(), stage.id]);
    res.json({ success: true, data: { id: String(stage.id) }, message: "删除阶段记录成功" });
  } catch (error) {
    res.status(500).json({ success: false, message: `删除阶段记录失败: ${(error as Error).message}` });
  }
});

export default router;
