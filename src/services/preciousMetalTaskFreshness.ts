export type PreciousMetalTaskFreshness = {
  expected_date: string;
  required_symbols: string[];
  latest_dates: Record<string, string>;
  fresh_symbols: string[];
  stale_symbols: Array<{
    symbol: string;
    latest_date: string | null;
  }>;
  is_fresh: boolean;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeSymbol(value: unknown) {
  return String(value || '').trim().toUpperCase();
}

function normalizeDate(value: unknown) {
  const date = String(value || '').trim().slice(0, 10);
  return DATE_PATTERN.test(date) ? date : '';
}

export function assessPreciousMetalTaskFreshness(input: {
  expectedDate: string;
  requiredSymbols: unknown[];
  latestDates?: Record<string, unknown> | null;
}): PreciousMetalTaskFreshness {
  const expectedDate = normalizeDate(input.expectedDate);
  if (!expectedDate) {
    throw new Error(`Invalid precious metal freshness date: ${input.expectedDate}`);
  }

  const requiredSymbols = Array.from(new Set(
    input.requiredSymbols.map(normalizeSymbol).filter(Boolean)
  ));
  const latestDates = Object.entries(input.latestDates || {}).reduce<Record<string, string>>(
    (result, [symbol, date]) => {
      const normalizedSymbol = normalizeSymbol(symbol);
      const normalizedDate = normalizeDate(date);
      if (normalizedSymbol && normalizedDate) result[normalizedSymbol] = normalizedDate;
      return result;
    },
    {}
  );

  const freshSymbols: string[] = [];
  const staleSymbols: PreciousMetalTaskFreshness['stale_symbols'] = [];
  for (const symbol of requiredSymbols) {
    const latestDate = latestDates[symbol] || null;
    if (latestDate && latestDate >= expectedDate) {
      freshSymbols.push(symbol);
    } else {
      staleSymbols.push({ symbol, latest_date: latestDate });
    }
  }

  return {
    expected_date: expectedDate,
    required_symbols: requiredSymbols,
    latest_dates: latestDates,
    fresh_symbols: freshSymbols,
    stale_symbols: staleSymbols,
    is_fresh: requiredSymbols.length > 0 && staleSymbols.length === 0
  };
}

export function formatPreciousMetalFreshness(freshness: PreciousMetalTaskFreshness) {
  return freshness.required_symbols
    .map(symbol => `${symbol} ${freshness.latest_dates[symbol] || '无数据'}`)
    .join('，');
}
