import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import getDb, { closeDatabase, getDatabasePath } from "../src/config/database";
import { runMigrations } from "../src/migrations";
import { getSignalOverview, getSourceStats } from "../src/services/signal/signalQueryService";

const insertEvent = async (db: any, input: {
  title: string;
  originSource: string;
  observations: Array<{ collector: string; collected_at: string; published_at: string | null }>;
  firstSeenSource: string;
  matchStatus?: string;
  profitStatus?: string;
  reviewStatus?: string;
  reviewVerdict?: string | null;
  outcomeStatus?: string | null;
  actualProfit?: number | null;
  grossSpread?: number | null;
}) => {
  const collectors = [...new Set(input.observations.map(item => item.collector))];
  const result = await db.run(
    `INSERT INTO normalized_signal
       (dedupe_hash, origin_source, title, content, published_at, first_seen_at, last_seen_at,
        first_seen_source, source_count, collectors_json, observations_json, content_hash, normalized_hash,
        match_status, profit_status, review_status, review_verdict, outcome_status, actual_profit, gross_spread,
        created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'c', 'n', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      `hash-${Math.random().toString(16).slice(2)}`,
      input.originSource,
      input.title,
      input.observations[0].published_at,
      input.observations[0].collected_at,
      input.observations[input.observations.length - 1].collected_at,
      input.firstSeenSource,
      collectors.length,
      JSON.stringify(collectors),
      JSON.stringify(input.observations.map(item => ({ ...item, external_id: "x", url: null, title: input.title }))),
      input.matchStatus ?? "matched",
      input.profitStatus ?? "HIGH_VALUE_CANDIDATE",
      input.reviewStatus ?? "pending",
      input.reviewVerdict ?? null,
      input.outcomeStatus ?? null,
      input.actualProfit ?? null,
      input.grossSpread ?? null
    ]
  );
  return Number(result.lastID);
};

test("提前量分析：谁先抓到、谁看到的发布时间更早、发布到采集的延迟", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "price-dashboard-signal-lead-"));
  const filename = path.join(directory, "business.db");

  const previousEnv = {
    BUSINESS_DB_PATH: process.env.BUSINESS_DB_PATH,
    ALLOW_DB_CREATE: process.env.ALLOW_DB_CREATE,
    NODE_ENV: process.env.NODE_ENV
  };
  process.env.BUSINESS_DB_PATH = filename;
  process.env.ALLOW_DB_CREATE = "true";
  process.env.NODE_ENV = "development";

  try {
    const db = await getDb();
    assert.equal(getDatabasePath(), filename);
    await runMigrations(filename);

    // 事件 1：线报酷先抓到（10:03），86 十二分钟后才看到（10:15），赚客吧更晚（10:20）
    await insertEvent(db, {
      title: "Zsiga 向往之处 到手399元",
      originSource: "好单",
      firstSeenSource: "xianbaoku",
      observations: [
        { collector: "xianbaoku", collected_at: "2026-10-07T10:03:00+08:00", published_at: "2026-10-07T10:01:00+08:00" },
        { collector: "xb86", collected_at: "2026-10-07T10:15:00+08:00", published_at: "2026-10-07T10:14:00+08:00" },
        { collector: "zuankeba", collected_at: "2026-10-07T10:20:00+08:00", published_at: "2026-10-07T10:19:00+08:00" }
      ],
      reviewStatus: "reviewed",
      reviewVerdict: "真车",
      outcomeStatus: "VALID",
      actualProfit: 205,
      grossSpread: 161
    });

    // 事件 2：86 先抓到
    await insertEvent(db, {
      title: "PS5国行数字slim 2999元",
      originSource: "微博",
      firstSeenSource: "xb86",
      observations: [
        { collector: "xb86", collected_at: "2026-10-07T11:00:00+08:00", published_at: "2026-10-07T10:59:00+08:00" },
        { collector: "xianbaoku", collected_at: "2026-10-07T11:30:00+08:00", published_at: "2026-10-07T11:29:00+08:00" }
      ],
      reviewStatus: "reviewed",
      reviewVerdict: "公交车",
      outcomeStatus: "INVALID",
      grossSpread: 120
    });

    // 事件 3：只有线报酷看到 → 不该参与提前量统计
    await insertEvent(db, {
      title: "MOKOKO系列 大春花 129元",
      originSource: "好单",
      firstSeenSource: "xianbaoku",
      observations: [
        { collector: "xianbaoku", collected_at: "2026-10-07T12:00:00+08:00", published_at: "2026-10-07T11:59:00+08:00" }
      ],
      profitStatus: "PROFITABLE_CANDIDATE",
      grossSpread: 60
    });

    const stats = await getSourceStats();

    // --- 提前量 ---
    const byCollector = new Map(stats.lead_time.by_collector.map(row => [row.key, row]));
    assert.deepEqual([...byCollector.keys()].sort(), ["xb86", "xianbaoku", "zuankeba"]);

    const xianbaoku = byCollector.get("xianbaoku")!;
    const xb86 = byCollector.get("xb86")!;
    const zuankeba = byCollector.get("zuankeba")!;

    assert.equal(xianbaoku.participated_events, 2, "参与了两条多源事件");
    assert.equal(xianbaoku.first_by_collected, 1, "其中一次是第一");
    assert.equal(xianbaoku.first_rate, 0.5);
    // 事件 1 领先 0 分钟，事件 2 落后 30 分钟 → 平均 15 分钟
    assert.equal(xianbaoku.avg_lead_minutes, 15);

    assert.equal(xb86.first_by_collected, 1);
    assert.equal(xb86.first_rate, 0.5);
    // 事件 1 落后 12 分钟，事件 2 领先 0 分钟 → 平均 6 分钟
    assert.equal(xb86.avg_lead_minutes, 6);
    assert.equal(xb86.avg_publish_lag_minutes, 1, "发布到抓到平均 1 分钟");

    assert.equal(zuankeba.participated_events, 1);
    assert.equal(zuankeba.first_rate, 0);

    // 单源事件不进提前量统计
    assert.equal(xianbaoku.participated_events, 2);
    assert.equal(xianbaoku.first_by_collected + xb86.first_by_collected + zuankeba.first_by_collected, 2);

    // --- 按原始来源 ---
    const byOrigin = new Map(stats.lead_time.by_origin_source.map(row => [row.key, row]));
    assert.equal(byOrigin.get("好单")!.events, 1);
    assert.deepEqual(byOrigin.get("好单")!.first_distribution, { xianbaoku: 1 });
    assert.equal(byOrigin.get("微博")!.first_distribution.xb86, 1);
    assert.equal(byOrigin.get("好单")!.avg_publish_to_collect_minutes, 2);

    // --- source_score 原始输入（只记录不自动加权）---
    const scoreById = new Map(stats.source_score_inputs.map(row => [row.collector, row]));
    const scoreXianbaoku = scoreById.get("xianbaoku")!;
    assert.equal(scoreXianbaoku.collected, 3);
    assert.equal(scoreXianbaoku.valid_count, 1);
    assert.equal(scoreXianbaoku.realized_profit, 205);
    assert.equal(scoreXianbaoku.hit_rate, 1);

    const scoreXb86 = scoreById.get("xb86")!;
    assert.equal(scoreXb86.collected, 2);
    assert.equal(scoreXb86.invalid, 1);
    assert.equal(scoreXb86.miss_rate, 0.5);
    assert.match(scoreXb86.note, /权重由人工/);

    // --- 概览仍然正常 ---
    const overview = await getSignalOverview({ date: "2026-10-07" });
    assert.equal(overview.collected, 3);
    assert.equal(overview.valid, 1);
    assert.equal(overview.realized_profit, 205);
  } finally {
    await closeDatabase();
    if (previousEnv.BUSINESS_DB_PATH === undefined) delete process.env.BUSINESS_DB_PATH;
    else process.env.BUSINESS_DB_PATH = previousEnv.BUSINESS_DB_PATH;
    if (previousEnv.ALLOW_DB_CREATE === undefined) delete process.env.ALLOW_DB_CREATE;
    else process.env.ALLOW_DB_CREATE = previousEnv.ALLOW_DB_CREATE;
    if (previousEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv.NODE_ENV;
    await rm(directory, { recursive: true, force: true });
  }
});
