type LatestCoveredTradeDateOptions = {
  source?: string;
  assetTypes?: string[];
  minCoverageRatio?: number;
  lookbackLimit?: number;
};

const TRADE_DATE_CACHE_TTL_MS = 5 * 1000;

type TradeDateCacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type TradeDateCoverageResult = {
  trade_date: string;
  current_count: number;
  previous_trade_date: string | null;
  previous_count: number;
  min_expected: number;
  status: 'unknown' | 'incomplete' | 'ok';
};

const latestCoveredTradeDateCache = new Map<string, TradeDateCacheEntry<string | null>>();
const tradeDateCoverageCache = new Map<string, TradeDateCacheEntry<TradeDateCoverageResult>>();

function getTradeDateCacheKey(
  source: string,
  assetTypes: string[],
  minCoverageRatio: number,
  lookbackLimit?: number,
  tradeDate?: string
) {
  return [
    source,
    [...assetTypes].sort().join(','),
    minCoverageRatio,
    lookbackLimit || '',
    tradeDate || ''
  ].join('|');
}

function getFreshCacheValue<T>(cache: Map<string, TradeDateCacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCacheValue<T>(cache: Map<string, TradeDateCacheEntry<T>>, key: string, value: T) {
  cache.set(key, {
    expiresAt: Date.now() + TRADE_DATE_CACHE_TTL_MS,
    value
  });
  return value;
}

async function getRecentTradeDateRows(
  db: any,
  source: string,
  assetTypes: string[],
  lookbackLimit: number
) {
  const recentDatesByAssetType = await Promise.all(
    assetTypes.map(assetType => db.all(
      `SELECT DISTINCT trade_date
       FROM financial_daily_prices
       WHERE source = ?
         AND asset_type = ?
         AND close IS NOT NULL
         AND close > 0
         AND trade_date IS NOT NULL
       ORDER BY trade_date DESC
       LIMIT ?`,
      [source, assetType, lookbackLimit]
    ))
  );

  const tradeDates = new Set<string>();
  for (const rows of recentDatesByAssetType) {
    for (const row of rows) {
      if (row?.trade_date) {
        tradeDates.add(String(row.trade_date));
      }
    }
  }

  return Array.from(tradeDates)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, lookbackLimit)
    .map(trade_date => ({ trade_date }));
}

async function getPreviousTradeDate(
  db: any,
  source: string,
  assetTypes: string[],
  tradeDate: string
) {
  const previousDatesByAssetType = await Promise.all(
    assetTypes.map(assetType => db.all(
      `SELECT DISTINCT trade_date
       FROM financial_daily_prices
       WHERE source = ?
         AND asset_type = ?
         AND trade_date < ?
         AND close IS NOT NULL
         AND close > 0
         AND trade_date IS NOT NULL
       ORDER BY trade_date DESC
       LIMIT 3`,
      [source, assetType, tradeDate]
    ))
  );

  return previousDatesByAssetType
    .flat()
    .map((row: any) => String(row?.trade_date || '').trim())
    .filter(Boolean)
    .sort((a: string, b: string) => b.localeCompare(a))[0] || null;
}

async function getTradeDateRowCount(
  db: any,
  source: string,
  assetTypes: string[],
  tradeDate: string
) {
  const placeholders = assetTypes.map(() => '?').join(',');
  const count = await db.get(
    `SELECT COUNT(DISTINCT symbol) AS rows
     FROM financial_daily_prices
     WHERE source = ?
       AND asset_type IN (${placeholders})
       AND trade_date = ?
       AND close IS NOT NULL
       AND close > 0`,
    [source, ...assetTypes, tradeDate]
  );
  return Number(count?.rows || 0);
}

export async function getLatestCoveredTradeDate(
  db: any,
  options: LatestCoveredTradeDateOptions = {}
): Promise<string | null> {
  const source = options.source || 'tushare';
  const assetTypes = Array.from(new Set((options.assetTypes?.length
    ? options.assetTypes
    : ['stock', 'etf', 'index'])
    .map(assetType => String(assetType || '').trim())
    .filter(Boolean)));
  const minCoverageRatio = Number.isFinite(options.minCoverageRatio)
    ? Number(options.minCoverageRatio)
    : 0.92;
  const lookbackLimit = Math.max(2, Math.min(Number(options.lookbackLimit || 12), 60));
  if (!assetTypes.length) return null;

  const cacheKey = getTradeDateCacheKey(source, assetTypes, minCoverageRatio, lookbackLimit);
  const cached = getFreshCacheValue(latestCoveredTradeDateCache, cacheKey);
  if (cached !== undefined) return cached;
  const remember = (value: string | null) => setCacheValue(latestCoveredTradeDateCache, cacheKey, value);

  const dateRows = await getRecentTradeDateRows(db, source, assetTypes, lookbackLimit);
  if (!dateRows.length) return remember(null);

  const countByTradeDate = new Map<string, number>();
  const getCount = async (tradeDate: string) => {
    if (!countByTradeDate.has(tradeDate)) {
      countByTradeDate.set(tradeDate, await getTradeDateRowCount(db, source, assetTypes, tradeDate));
    }
    return countByTradeDate.get(tradeDate) || 0;
  };

  for (let index = 0; index < dateRows.length; index += 1) {
    const current = dateRows[index];
    if (index >= dateRows.length - 1) return remember(String(current.trade_date));

    const previous = dateRows[index + 1];
    const [currentCount, previousCount] = await Promise.all([
      getCount(current.trade_date),
      getCount(previous.trade_date)
    ]);
    const minExpected = previousCount > 0 ? Math.floor(previousCount * minCoverageRatio) : 0;
    if (minExpected <= 0 || currentCount >= minExpected) {
      return remember(String(current.trade_date));
    }
  }

  return remember(String(dateRows[dateRows.length - 1].trade_date));
}

export async function getTradeDateCoverage(
  db: any,
  tradeDate: string,
  options: LatestCoveredTradeDateOptions = {}
): Promise<TradeDateCoverageResult> {
  const source = options.source || 'tushare';
  const assetTypes = Array.from(new Set((options.assetTypes?.length
    ? options.assetTypes
    : ['stock', 'etf', 'index'])
    .map(assetType => String(assetType || '').trim())
    .filter(Boolean)));
  const minCoverageRatio = Number.isFinite(options.minCoverageRatio)
    ? Number(options.minCoverageRatio)
    : 0.92;
  if (!assetTypes.length) {
    return {
      trade_date: tradeDate,
      current_count: 0,
      previous_trade_date: null,
      previous_count: 0,
      min_expected: 0,
      status: 'unknown'
    };
  }

  const cacheKey = getTradeDateCacheKey(source, assetTypes, minCoverageRatio, undefined, tradeDate);
  const cached = getFreshCacheValue(tradeDateCoverageCache, cacheKey);
  if (cached !== undefined) return cached;
  const remember = (value: TradeDateCoverageResult) => setCacheValue(tradeDateCoverageCache, cacheKey, value);

  const previousTradeDate = await getPreviousTradeDate(db, source, assetTypes, tradeDate);
  const [currentCount, previousCount] = await Promise.all([
    getTradeDateRowCount(db, source, assetTypes, tradeDate),
    previousTradeDate
      ? getTradeDateRowCount(db, source, assetTypes, previousTradeDate)
      : Promise.resolve(0)
  ]);
  const minExpected = previousCount > 0 ? Math.floor(previousCount * minCoverageRatio) : 0;
  return remember({
    trade_date: tradeDate,
    current_count: currentCount,
    previous_trade_date: previousTradeDate,
    previous_count: previousCount,
    min_expected: minExpected,
    status: previousCount > 0 && currentCount < minExpected ? 'incomplete' : 'ok'
  });
}
