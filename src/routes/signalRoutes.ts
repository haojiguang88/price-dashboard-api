import express from "express";
import {
  getReviewQueueSummary,
  getSignalDetail,
  getSignalOverview,
  getSourceStats,
  listSignalSources,
  listSignals
} from "../services/signal/signalQueryService";
import {
  SignalReviewError,
  expireSignal,
  recordSignalOutcome,
  reviewSignal,
  updateSignalSettings,
  updateSignalSource
} from "../services/signal/signalReviewService";
import { analyzeNormalizedSignals } from "../services/signal/signalAnalysisService";
import {
  getSignalCollectorStatus,
  triggerSignalCollectorOnce
} from "../services/signal/signalCollectorScheduler";
import { listRecycleProviders } from "../services/signal/recyclePriceService";

/**
 * 线报监控 API。
 * 读取：概览 / 列表 / 详情 / 来源排行 / 采集源健康 / 阈值。
 * 写入：人工审核 / 最终结果 / 失效时间 / 阈值 / 采集源开关 / 重算。
 */
const router = express.Router();

const handleError = (res: express.Response, error: unknown, fallback: string) => {
  if (error instanceof SignalReviewError) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  console.error(`[signal] ${fallback}:`, error);
  return res.status(500).json({ success: false, message: fallback });
};

router.get("/overview", async (req, res) => {
  try {
    const [overview, queue] = await Promise.all([
      getSignalOverview({ date: typeof req.query.date === "string" ? req.query.date : undefined }),
      getReviewQueueSummary()
    ]);
    res.json({ success: true, data: { ...overview, queue } });
  } catch (error) {
    handleError(res, error, "获取线报总览失败");
  }
});

router.get("/signals", async (req, res) => {
  try {
    const result = await listSignals({
      profit_status: req.query.profit_status as string | undefined,
      match_status: req.query.match_status as string | undefined,
      origin_source: req.query.origin_source as string | undefined,
      collector_source: req.query.collector_source as string | undefined,
      review_status: req.query.review_status as string | undefined,
      keyword: req.query.keyword as string | undefined,
      date_from: req.query.date_from as string | undefined,
      date_to: req.query.date_to as string | undefined,
      only_with_profit: ["1", "true"].includes(String(req.query.only_with_profit || "").toLowerCase()),
      page: Number.parseInt(String(req.query.page || "1"), 10),
      page_size: Number.parseInt(String(req.query.page_size || "30"), 10),
      sort: req.query.sort as string | undefined
    });
    res.json({ success: true, ...result });
  } catch (error) {
    handleError(res, error, "获取线报列表失败");
  }
});

router.get("/signals/:id", async (req, res) => {
  try {
    const detail = await getSignalDetail(req.params.id);
    if (!detail) return res.status(404).json({ success: false, message: "线报不存在" });
    res.json({ success: true, data: detail });
  } catch (error) {
    handleError(res, error, "获取线报详情失败");
  }
});

router.get("/sources", async (_req, res) => {
  try {
    const [sources, live] = await Promise.all([listSignalSources(), Promise.resolve(getSignalCollectorStatus())]);
    const liveByKey = new Map((live as Array<{ source_key: string }>).map(item => [item.source_key, item]));
    res.json({
      success: true,
      data: (sources as Array<{ source_key: string }>).map(source => ({
        ...source,
        runtime: liveByKey.get(source.source_key) ?? null
      }))
    });
  } catch (error) {
    handleError(res, error, "获取采集源状态失败");
  }
});

router.get("/stats/sources", async (req, res) => {
  try {
    const data = await getSourceStats({
      date_from: req.query.date_from as string | undefined,
      date_to: req.query.date_to as string | undefined
    });
    res.json({ success: true, data: { ...data, recycle_providers: listRecycleProviders() } });
  } catch (error) {
    handleError(res, error, "获取来源统计失败");
  }
});

router.get("/settings", async (_req, res) => {
  try {
    const overview = await getSignalOverview();
    res.json({ success: true, data: overview.settings });
  } catch (error) {
    handleError(res, error, "获取线报设置失败");
  }
});

router.patch("/settings", async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.settings)
      ? req.body.settings
      : Object.entries(req.body || {}).map(([key, value]) => ({ key, value: String(value) }));
    const data = await updateSignalSettings(entries);
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, "更新线报设置失败");
  }
});

router.patch("/signals/:id/review", async (req, res) => {
  try {
    const data = await reviewSignal(req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, "保存人工判断失败");
  }
});

router.patch("/signals/:id/outcome", async (req, res) => {
  try {
    const data = await recordSignalOutcome(req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, "保存最终结果失败");
  }
});

router.patch("/signals/:id/expire", async (req, res) => {
  try {
    const data = await expireSignal(req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, "记录失效时间失败");
  }
});

router.patch("/sources/:sourceKey", async (req, res) => {
  try {
    const data = await updateSignalSource(req.params.sourceKey, req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, "更新采集源失败");
  }
});

router.post("/sources/:sourceKey/collect", async (req, res) => {
  try {
    const result = await triggerSignalCollectorOnce(req.params.sourceKey);
    if (!result) {
      return res.status(409).json({
        success: false,
        message: "该采集源未在运行（可能被暂停或调度器未启动），请先在任务中心确认后端已重启"
      });
    }
    res.json({ success: true, data: result });
  } catch (error) {
    handleError(res, error, "手动采集失败");
  }
});

router.post("/recompute", async (req, res) => {
  try {
    const data = await analyzeNormalizedSignals({
      limit: Number.parseInt(String(req.body?.limit || "500"), 10),
      onlyPending: req.body?.only_pending !== false
    });
    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, "重算线报失败");
  }
});

export default router;
