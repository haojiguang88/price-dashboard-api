export const TROY_OUNCE_GRAMS = 31.1034768;
export const RONGTONGJIN_QUOTE_URL = "https://i.ytj9999.com/res/quote/pq.json";
export const SHUIBEI_BASIS_SOURCE = "ytj9999";
export const SHUIBEI_AG_BASIS_SYMBOL = "SHUIBEI_AG_BASIS";
export const SHUIBEI_AU_BASIS_SYMBOL = "SHUIBEI_AU_BASIS";

export type ConverterQuoteUnit = "usd_oz" | "cny_g";
export type ConverterQuoteBook = "domestic_spot" | "international";

export type PreciousMetalConvertedQuote = {
  usd_per_oz: number;
  usd_per_g: number;
  cny_per_oz: number;
  cny_per_g: number;
};

export type RongtongjinQuoteItem = {
  code?: string;
  bidprice?: string;
  askprice?: string;
  high?: string;
  low?: string;
  open?: string;
  preclose?: string;
  stime?: string;
};

export type RongtongjinQuotePayload = {
  result?: number;
  items?: RongtongjinQuoteItem[];
};

export type ShuibeiMetalSnapshot = {
  code: string;
  quote_time: string;
  domestic_bid: number;
  domestic_bid_raw: number;
  askprice: number | null;
  x_usd_oz: number;
  usdcnh_bid: number;
  international_cny_g: number;
  international_cny_g_raw: number;
  basis: number;
  basis_raw: number;
};

type LatestQuoteRow = {
  trade_date?: string | null;
  close?: number | null;
};

type ConverterFetch = (input: string, init?: RequestInit) => Promise<Response>;

const roundNumber = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const parsePositiveNumber = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

export const convertPreciousMetalQuote = (
  input: number,
  fxRate: number,
  from: ConverterQuoteUnit
): PreciousMetalConvertedQuote | null => {
  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(fxRate) || fxRate <= 0) {
    return null;
  }
  const usdPerOz = from === "usd_oz"
    ? input
    : (input * TROY_OUNCE_GRAMS) / fxRate;
  const cnyPerGram = (usdPerOz * fxRate) / TROY_OUNCE_GRAMS;
  return {
    usd_per_oz: roundNumber(usdPerOz, 2),
    usd_per_g: roundNumber(usdPerOz / TROY_OUNCE_GRAMS, 4),
    cny_per_oz: roundNumber(usdPerOz * fxRate, 2),
    cny_per_g: roundNumber(cnyPerGram, 2)
  };
};

export const convertUsdOzToCnyG = (usdOz: number, fxRate: number) => {
  if (!Number.isFinite(usdOz) || usdOz <= 0 || !Number.isFinite(fxRate) || fxRate <= 0) {
    return null;
  }
  return (usdOz * fxRate) / TROY_OUNCE_GRAMS;
};

export const applyShuibeiBasisToInput = (
  input: number,
  fxRate: number,
  basisRaw: number,
  from: ConverterQuoteUnit,
  quoteBook: ConverterQuoteBook
) => {
  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(fxRate) || fxRate <= 0 || !Number.isFinite(basisRaw)) {
    return null;
  }
  let internationalRaw = 0;
  let domesticRaw = 0;
  if (from === "usd_oz") {
    const converted = convertUsdOzToCnyG(input, fxRate);
    if (converted == null) return null;
    internationalRaw = converted;
    domesticRaw = internationalRaw + basisRaw;
  } else if (quoteBook === "domestic_spot") {
    domesticRaw = input;
    internationalRaw = input - basisRaw;
  } else {
    internationalRaw = input;
    domesticRaw = input + basisRaw;
  }
  if (internationalRaw <= 0 || domesticRaw <= 0) return null;
  return {
    usd_per_oz: roundNumber((internationalRaw * TROY_OUNCE_GRAMS) / fxRate, 3),
    international_cny_g: roundNumber(internationalRaw, 2),
    domestic_cny_g: roundNumber(domesticRaw, 2),
    international_cny_g_raw: internationalRaw,
    domestic_cny_g_raw: domesticRaw
  };
};

export const indexRongtongjinQuotes = (payload: RongtongjinQuotePayload | null | undefined) => {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const indexed: Record<string, RongtongjinQuoteItem> = {};
  for (const item of items) {
    const code = String(item?.code || "").trim();
    if (!code) continue;
    indexed[code] = item;
  }
  return indexed;
};

export const buildShuibeiSnapshot = (
  quotes: Record<string, RongtongjinQuoteItem>,
  domesticCode: string,
  internationalCode: string
): ShuibeiMetalSnapshot | null => {
  const domesticItem = quotes[domesticCode];
  const domesticBid = parsePositiveNumber(domesticItem?.bidprice);
  const usdOz = parsePositiveNumber(quotes[internationalCode]?.bidprice);
  const fxRate = parsePositiveNumber(quotes.USDCNH?.bidprice);
  const internationalRaw = usdOz != null && fxRate != null
    ? convertUsdOzToCnyG(usdOz, fxRate)
    : null;
  if (domesticBid == null || usdOz == null || fxRate == null || internationalRaw == null) {
    return null;
  }
  const basisRaw = domesticBid - internationalRaw;
  return {
    code: domesticCode,
    quote_time: String(domesticItem?.stime || quotes[internationalCode]?.stime || quotes.USDCNH?.stime || ""),
    domestic_bid: roundNumber(domesticBid, 2),
    domestic_bid_raw: domesticBid,
    askprice: parsePositiveNumber(domesticItem?.askprice),
    x_usd_oz: usdOz,
    usdcnh_bid: fxRate,
    international_cny_g: roundNumber(internationalRaw, 2),
    international_cny_g_raw: internationalRaw,
    basis: roundNumber(basisRaw, 2),
    basis_raw: basisRaw
  };
};

const readLatestQuote = async (
  db: any,
  symbol: string,
  source: string
): Promise<{ trade_date: string; close: number } | null> => {
  const row = await db.get(
    `SELECT trade_date, close
     FROM market_anchor_daily_prices
     WHERE symbol = ?
       AND source = ?
       AND close IS NOT NULL
       AND close > 0
     ORDER BY trade_date DESC, id DESC
     LIMIT 1`,
    [symbol, source]
  ) as LatestQuoteRow | undefined;
  const tradeDate = String(row?.trade_date || "").trim();
  const close = Number(row?.close);
  if (!tradeDate || !Number.isFinite(close) || close <= 0) return null;
  return { trade_date: tradeDate, close };
};

export const shanghaiTradeDate = (now = new Date()) => (
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now)
);

const snapshotFromStoredRow = (row: {
  trade_date?: string | null;
  close?: number | null;
  raw_json?: string | null;
} | null, fallbackCode: string): ShuibeiMetalSnapshot | null => {
  if (!row) return null;
  const stored = row.raw_json ? parseJsonValue(row.raw_json) as Partial<ShuibeiMetalSnapshot> | null : null;
  const basisRaw = Number(stored?.basis_raw ?? stored?.basis ?? row.close);
  if (!Number.isFinite(basisRaw)) return null;
  return {
    code: String(stored?.code || fallbackCode),
    quote_time: String(stored?.quote_time || ""),
    domestic_bid: Number(stored?.domestic_bid) || 0,
    domestic_bid_raw: Number(stored?.domestic_bid_raw) || Number(stored?.domestic_bid) || 0,
    askprice: stored?.askprice ?? null,
    x_usd_oz: Number(stored?.x_usd_oz) || 0,
    usdcnh_bid: Number(stored?.usdcnh_bid) || 0,
    international_cny_g: Number(stored?.international_cny_g) || 0,
    international_cny_g_raw: Number(stored?.international_cny_g_raw) || 0,
    basis: roundNumber(basisRaw, 2),
    basis_raw: basisRaw
  };
};

const parseJsonValue = (value: unknown) => {
  if (value == null || value === "") return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
};

const readDailyBasis = async (db: any, symbol: string, tradeDate: string) => {
  const row = await db.get(
    `SELECT trade_date, close, raw_json
     FROM market_anchor_daily_prices
     WHERE symbol = ?
       AND source = ?
       AND trade_date = ?
     LIMIT 1`,
    [symbol, SHUIBEI_BASIS_SOURCE, tradeDate]
  ) as { trade_date?: string | null; close?: number | null; raw_json?: string | null } | undefined;
  return row || null;
};

const saveDailyBasis = async (db: any, symbol: string, name: string, tradeDate: string, snapshot: ShuibeiMetalSnapshot) => {
  if (typeof db.run !== "function") return;
  await db.run(
    `INSERT INTO market_anchor_daily_prices
      (symbol, name, market, asset_type, trade_date, close, source, source_label, raw_json, updated_at)
     VALUES (?, ?, 'shuibei', 'precious_metal_converter', ?, ?, ?, '融通金/水贝基差', ?, datetime('now'))
     ON CONFLICT(symbol, trade_date, source) DO NOTHING`,
    [symbol, name, tradeDate, snapshot.basis_raw, SHUIBEI_BASIS_SOURCE, JSON.stringify(snapshot)]
  );
};

const loadDailyShuibeiSnapshots = async (
  db: any,
  fetcher: ConverterFetch,
  tradeDate: string
) => {
  const [storedSilver, storedGold] = await Promise.all([
    readDailyBasis(db, SHUIBEI_AG_BASIS_SYMBOL, tradeDate),
    readDailyBasis(db, SHUIBEI_AU_BASIS_SYMBOL, tradeDate)
  ]);
  let silverSpot = snapshotFromStoredRow(storedSilver, "JZJ_ag");
  let goldSpot = snapshotFromStoredRow(storedGold, "JZJ_au");
  if (silverSpot && goldSpot) {
    return { silverSpot, goldSpot, fetched: false, error: "" };
  }

  try {
    const payload = await fetchRongtongjinPayload(fetcher);
    const quotes = indexRongtongjinQuotes(payload);
    silverSpot = silverSpot || buildShuibeiSnapshot(quotes, "JZJ_ag", "XAG");
    goldSpot = goldSpot || buildShuibeiSnapshot(quotes, "JZJ_au", "XAU");
    if (silverSpot) await saveDailyBasis(db, SHUIBEI_AG_BASIS_SYMBOL, "水贝白银基差", tradeDate, silverSpot);
    if (goldSpot) await saveDailyBasis(db, SHUIBEI_AU_BASIS_SYMBOL, "水贝黄金基差", tradeDate, goldSpot);
    return { silverSpot, goldSpot, fetched: true, error: "" };
  } catch (error) {
    return {
      silverSpot,
      goldSpot,
      fetched: false,
      error: (error as Error).message || "融通金行情读取失败"
    };
  }
};

const fetchRongtongjinPayload = async (fetcher: ConverterFetch) => {
  const response = await fetcher(RONGTONGJIN_QUOTE_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw new Error(`融通金行情读取失败 ${response.status}`);
  }
  return await response.json() as RongtongjinQuotePayload;
};

const dateDiffDays = (fromDate: string, toDate = new Date()) => {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  if (!Number.isFinite(from)) return null;
  const utcToday = Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate());
  return Math.round((utcToday - from) / 86400000);
};

export const loadPreciousMetalConverterContext = async (
  db: any,
  options: { fetchQuotes?: ConverterFetch; now?: Date } = {}
) => {
  const fetcher = options.fetchQuotes || fetch;
  const tradeDate = shanghaiTradeDate(options.now);
  const [fx, gold, delayedSilver, daily] = await Promise.all([
    readLatestQuote(db, "USDCNH", "tushare_fxcm"),
    readLatestQuote(db, "XAUUSD", "twelvedata"),
    readLatestQuote(db, "SGE_AGTD", "tushare_sge"),
    loadDailyShuibeiSnapshots(db, fetcher, tradeDate)
  ]);

  const silverSpot = daily.silverSpot;
  const goldSpot = daily.goldSpot;
  const liveFx = silverSpot?.usdcnh_bid || goldSpot?.usdcnh_bid || null;
  const fxRate = liveFx || fx?.close || null;
  const goldConverted = gold && fxRate ? convertPreciousMetalQuote(gold.close, fxRate, "usd_oz") : null;
  const delayedConverted = delayedSilver && fxRate
    ? convertPreciousMetalQuote(delayedSilver.close, fxRate, "cny_g")
    : null;

  return {
    troy_ounce_grams: TROY_OUNCE_GRAMS,
    formula: "国内现货 = 输入折算 + 当日水贝基差；基差每个交易日只取一次",
    silver_spot_formula: "输入美元/盎司后，国内现货 = 国际折算 + 当日水贝基差。基差一天更新一次。",
    default_quote_book: "international" as ConverterQuoteBook,
    quote_source: {
      url: RONGTONGJIN_QUOTE_URL,
      label: "融通金官方报价 / 水贝",
      available: Boolean(silverSpot || goldSpot),
      error: daily.error,
      basis_trade_date: tradeDate,
      basis_refreshed_today: daily.fetched
    },
    fx: {
      symbol: "USDCNH",
      source: liveFx ? "ytj9999" : "tushare_fxcm",
      rate: fxRate,
      trade_date: liveFx ? tradeDate : (fx?.trade_date || ""),
      age_days: fx?.trade_date ? dateDiffDays(fx.trade_date) : null
    },
    gold: gold
      ? {
        symbol: "XAUUSD",
        label: "黄金现货",
        speaking_book: "融通金 / 水贝",
        trade_date: gold.trade_date,
        usd_per_oz: gold.close,
        cny_per_g: goldConverted?.cny_per_g ?? null,
        usd_per_g: goldConverted?.usd_per_g ?? null
      }
      : null,
    delayed_silver: delayedSilver
      ? {
        symbol: "SGE_AGTD",
        label: "白银延期",
        trade_date: delayedSilver.trade_date,
        cny_per_g: delayedSilver.close,
        usd_per_oz: delayedConverted?.usd_per_oz ?? null
      }
      : null,
    shuibei: {
      gold: goldSpot,
      silver: silverSpot
    },
    note: silverSpot
      ? `国内现货跟你输入走，基差用 ${tradeDate} 这一天的水贝口径，当天不再刷新。`
      : "水贝基差暂时没读到，换不出国内现货。"
  };
};
