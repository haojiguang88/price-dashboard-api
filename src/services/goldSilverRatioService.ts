const TROY_OUNCE_GRAMS = 31.1034768;
const MAX_FX_AGE_DAYS = 7;

type RatioInputRow = {
  trade_date?: string | null;
  close?: number | null;
};

type NormalizedRow = {
  tradeDate: string;
  close: number;
};

type RatioPoint = {
  tradeDate: string;
  goldClose: number;
  silverClose: number;
  fxRate: number;
  fxDate: string;
  goldCnyPerGram: number;
  ratio: number;
};

export type GoldSilverRatioHeatKey =
  | "unavailable"
  | "overheat_watch"
  | "compression_watch"
  | "neutral"
  | "relative_cooling";

export type GoldSilverRatioSummary = {
  value: number | null;
  trade_date: string;
  gold_trade_date: string;
  silver_trade_date: string;
  fx_trade_date: string;
  fx_rate: number | null;
  gold_cny_per_gram: number | null;
  silver_cny_per_gram: number | null;
  change_5d_percent: number | null;
  change_10d_percent: number | null;
  change_20d_percent: number | null;
  silver_change_5d_percent: number | null;
  silver_change_10d_percent: number | null;
  silver_previous_5d_percent: number | null;
  silver_accelerating: boolean;
  heat_key: GoldSilverRatioHeatKey;
  heat_label: string;
  heat_tone: "danger" | "watch" | "neutral" | "cooling";
  heat_summary: string;
  sample_count: number;
  formula: string;
  decision_role: "display_only";
  can_determine_trade: false;
  note: string;
};

type GoldSilverRatioInput = {
  goldRows: RatioInputRow[];
  silverRows: RatioInputRow[];
  fxRows: RatioInputRow[];
};

const roundNumber = (value: number | null, digits = 3) => {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const percentChange = (current?: number, previous?: number) => {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || Number(previous) === 0) return null;
  return ((Number(current) - Number(previous)) / Number(previous)) * 100;
};

const dateTime = (value: string) => Date.parse(`${value}T00:00:00Z`);

const normalizeRows = (rows: RatioInputRow[]): NormalizedRow[] => {
  const byDate = new Map<string, number>();
  rows.forEach(row => {
    const tradeDate = String(row.trade_date || "").trim();
    const close = Number(row.close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || !Number.isFinite(close) || close <= 0) return;
    byDate.set(tradeDate, close);
  });
  return Array.from(byDate.entries())
    .map(([tradeDate, close]) => ({ tradeDate, close }))
    .sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
};

const emptySummary = (): GoldSilverRatioSummary => ({
  value: null,
  trade_date: "",
  gold_trade_date: "",
  silver_trade_date: "",
  fx_trade_date: "",
  fx_rate: null,
  gold_cny_per_gram: null,
  silver_cny_per_gram: null,
  change_5d_percent: null,
  change_10d_percent: null,
  change_20d_percent: null,
  silver_change_5d_percent: null,
  silver_change_10d_percent: null,
  silver_previous_5d_percent: null,
  silver_accelerating: false,
  heat_key: "unavailable",
  heat_label: "待换算数据",
  heat_tone: "neutral",
  heat_summary: "黄金、白银或美元兑人民币数据不足，暂时无法计算金银比。",
  sample_count: 0,
  formula: "XAUUSD × USD/CNH ÷ 31.1034768 ÷ SGE Ag(T+D)",
  decision_role: "display_only",
  can_determine_trade: false,
  note: "金银比只用于观察白银相对黄金的过热程度，不参与规则打分，不单独决定买卖。"
});

const buildRatioPoints = ({ goldRows, silverRows, fxRows }: GoldSilverRatioInput): RatioPoint[] => {
  const gold = normalizeRows(goldRows);
  const silver = normalizeRows(silverRows);
  const fx = normalizeRows(fxRows);
  const goldByDate = new Map(gold.map(row => [row.tradeDate, row.close]));
  const points: RatioPoint[] = [];
  let fxIndex = -1;

  silver.forEach(silverRow => {
    while (fxIndex + 1 < fx.length && fx[fxIndex + 1].tradeDate <= silverRow.tradeDate) {
      fxIndex += 1;
    }
    const goldClose = goldByDate.get(silverRow.tradeDate);
    const fxRow = fxIndex >= 0 ? fx[fxIndex] : null;
    if (!goldClose || !fxRow) return;
    const fxAgeDays = (dateTime(silverRow.tradeDate) - dateTime(fxRow.tradeDate)) / (24 * 60 * 60 * 1000);
    if (!Number.isFinite(fxAgeDays) || fxAgeDays < 0 || fxAgeDays > MAX_FX_AGE_DAYS) return;
    const goldCnyPerGram = goldClose * fxRow.close / TROY_OUNCE_GRAMS;
    const ratio = goldCnyPerGram / silverRow.close;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    points.push({
      tradeDate: silverRow.tradeDate,
      goldClose,
      silverClose: silverRow.close,
      fxRate: fxRow.close,
      fxDate: fxRow.tradeDate,
      goldCnyPerGram,
      ratio
    });
  });

  return points;
};

export const buildGoldSilverRatioSummary = (input: GoldSilverRatioInput): GoldSilverRatioSummary => {
  const points = buildRatioPoints(input);
  if (points.length === 0) return emptySummary();

  const latestIndex = points.length - 1;
  const latest = points[latestIndex];
  const pointAt = (offset: number) => latestIndex >= offset ? points[latestIndex - offset] : undefined;
  const ratioChange5 = percentChange(latest.ratio, pointAt(5)?.ratio);
  const ratioChange10 = percentChange(latest.ratio, pointAt(10)?.ratio);
  const ratioChange20 = percentChange(latest.ratio, pointAt(20)?.ratio);
  const silverChange5 = percentChange(latest.silverClose, pointAt(5)?.silverClose);
  const silverChange10 = percentChange(latest.silverClose, pointAt(10)?.silverClose);
  const previousSilver5 = percentChange(pointAt(5)?.silverClose, pointAt(10)?.silverClose);
  const silverAccelerating = silverChange5 !== null && previousSilver5 !== null && silverChange5 > previousSilver5;

  let heatKey: GoldSilverRatioHeatKey = "neutral";
  let heatLabel = "相对温度平稳";
  let heatTone: GoldSilverRatioSummary["heat_tone"] = "neutral";
  let heatSummary = "金银比近期没有明显压缩或扩张，只作相对强弱背景展示。";

  if (
    ratioChange10 !== null && ratioChange10 <= -8 &&
    silverChange10 !== null && silverChange10 >= 8 &&
    silverAccelerating
  ) {
    heatKey = "overheat_watch";
    heatLabel = "相对过热观察";
    heatTone = "danger";
    heatSummary = "白银涨速加快且金银比快速压缩，说明白银正在明显跑赢黄金，只提高过热观察权重。";
  } else if (ratioChange10 !== null && ratioChange10 <= -4) {
    heatKey = "compression_watch";
    heatLabel = "金银比压缩";
    heatTone = "watch";
    heatSummary = "白银近期相对黄金偏强；继续结合白银自身涨速和波动判断，不能据此单独行动。";
  } else if (ratioChange10 !== null && ratioChange10 >= 4) {
    heatKey = "relative_cooling";
    heatLabel = "相对热度降温";
    heatTone = "cooling";
    heatSummary = "金银比近期扩张，说明白银相对黄金走弱；这不等于白银已经跌透或自动出现买点。";
  }

  return {
    value: roundNumber(latest.ratio, 3),
    trade_date: latest.tradeDate,
    gold_trade_date: latest.tradeDate,
    silver_trade_date: latest.tradeDate,
    fx_trade_date: latest.fxDate,
    fx_rate: roundNumber(latest.fxRate, 6),
    gold_cny_per_gram: roundNumber(latest.goldCnyPerGram, 3),
    silver_cny_per_gram: roundNumber(latest.silverClose, 3),
    change_5d_percent: roundNumber(ratioChange5, 2),
    change_10d_percent: roundNumber(ratioChange10, 2),
    change_20d_percent: roundNumber(ratioChange20, 2),
    silver_change_5d_percent: roundNumber(silverChange5, 2),
    silver_change_10d_percent: roundNumber(silverChange10, 2),
    silver_previous_5d_percent: roundNumber(previousSilver5, 2),
    silver_accelerating: silverAccelerating,
    heat_key: heatKey,
    heat_label: heatLabel,
    heat_tone: heatTone,
    heat_summary: heatSummary,
    sample_count: points.length,
    formula: "XAUUSD × USD/CNH ÷ 31.1034768 ÷ SGE Ag(T+D)",
    decision_role: "display_only",
    can_determine_trade: false,
    note: "金银比只用于观察白银相对黄金的过热程度，不参与规则打分，不单独决定买卖。"
  };
};

export const loadGoldSilverRatioSummary = async (db: any): Promise<GoldSilverRatioSummary> => {
  const loadRows = (symbol: string, source: string) => db.all(
    `SELECT trade_date, close
     FROM market_anchor_daily_prices
     WHERE symbol = ? AND source = ? AND close IS NOT NULL AND close > 0
     ORDER BY trade_date DESC, id DESC
     LIMIT 180`,
    [symbol, source]
  );
  const [goldRows, silverRows, fxRows] = await Promise.all([
    loadRows("XAUUSD", "twelvedata"),
    loadRows("SGE_AGTD", "tushare_sge"),
    loadRows("USDCNH", "tushare_fxcm")
  ]);
  return buildGoldSilverRatioSummary({ goldRows, silverRows, fxRows });
};
