import assert from "node:assert/strict";
import test from "node:test";
import { buildGoldSilverRatioSummary, buildGoldSilverRatioSeries, loadGoldSilverRatioSummary, loadGoldSilverRatioSeries } from "../src/services/goldSilverRatioService";

const dateAt = (offset: number) => {
  const date = new Date(Date.UTC(2026, 0, 1 + offset));
  return date.toISOString().slice(0, 10);
};

test("gold silver ratio converts currencies and marks acceleration as display-only overheat watch", () => {
  const goldRows = Array.from({ length: 21 }, (_, index) => ({
    trade_date: dateAt(index),
    close: 1000
  }));
  const silverRows = Array.from({ length: 21 }, (_, index) => {
    const close = index <= 10
      ? 10 + index * 0.05
      : index <= 15
        ? 10.5 + (index - 10) * 0.04
        : 10.7 + (index - 15) * 0.4;
    return { trade_date: dateAt(index), close };
  });
  const fxRows = Array.from({ length: 20 }, (_, index) => ({
    trade_date: dateAt(index),
    close: 7
  }));

  const summary = buildGoldSilverRatioSummary({ goldRows, silverRows, fxRows });
  const expectedRatio = 1000 * 7 / 31.1034768 / 12.7;

  assert.ok(summary.value !== null);
  assert.ok(Math.abs(Number(summary.value) - expectedRatio) < 0.001);
  assert.equal(summary.trade_date, dateAt(20));
  assert.equal(summary.fx_trade_date, dateAt(19));
  assert.equal(summary.heat_key, "overheat_watch");
  assert.equal(summary.silver_accelerating, true);
  assert.equal(summary.decision_role, "display_only");
  assert.equal(summary.can_determine_trade, false);
  assert.match(summary.note, /不单独决定买卖/);
});

test("gold silver ratio stays unavailable when conversion data is missing", () => {
  const summary = buildGoldSilverRatioSummary({
    goldRows: [{ trade_date: "2026-07-17", close: 4016.98 }],
    silverRows: [{ trade_date: "2026-07-17", close: 13.471 }],
    fxRows: []
  });

  assert.equal(summary.value, null);
  assert.equal(summary.heat_key, "unavailable");
  assert.equal(summary.can_determine_trade, false);
});

test("gold silver ratio rejects stale FX carry-forward data", () => {
  const summary = buildGoldSilverRatioSummary({
    goldRows: [{ trade_date: "2026-07-17", close: 4016.98 }],
    silverRows: [{ trade_date: "2026-07-17", close: 13.471 }],
    fxRows: [{ trade_date: "2026-07-01", close: 6.78 }]
  });

  assert.equal(summary.value, null);
  assert.equal(summary.sample_count, 0);
});

test("gold silver ratio series uses the same conversion and stays display-only", () => {
  const goldRows = [
    { trade_date: "2026-01-01", close: 2000 },
    { trade_date: "2026-01-02", close: 2000 },
    { trade_date: "2026-01-03", close: 2100 }
  ];
  const silverRows = [
    { trade_date: "2026-01-01", close: 10 },
    { trade_date: "2026-01-02", close: 10 },
    { trade_date: "2026-01-03", close: 10 }
  ];
  const fxRows = [
    { trade_date: "2026-01-01", close: 7 },
    { trade_date: "2026-01-02", close: 7 },
    { trade_date: "2026-01-03", close: 7 }
  ];

  const series = buildGoldSilverRatioSeries({ goldRows, silverRows, fxRows });
  assert.equal(series.length, 3);
  assert.equal(series[0].trade_date, "2026-01-01");
  assert.equal(series[2].trade_date, "2026-01-03");
  assert.ok(series[2].close > series[0].close);
  const expected = 2100 * 7 / 31.1034768 / 10;
  assert.ok(Math.abs(series[2].close - expected) < 0.001);
});

test("gold silver ratio database loader applies the as-of boundary to every input", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    all: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return [];
    }
  };

  await loadGoldSilverRatioSummary(db, { asOfDate: "2025-12-01" });

  assert.equal(calls.length, 3);
  calls.forEach(call => {
    assert.match(call.sql, /trade_date <= \?/);
    assert.equal(call.params.at(-1), "2025-12-01");
  });
});

test("gold silver ratio series loader applies as-of and lookback to every input", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    get: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("MAX(trade_date)")) return { start_date: "2025-11-01" };
      return { start_date: "2025-11-15" };
    },
    all: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return [];
    }
  };

  await loadGoldSilverRatioSeries(db, { asOfDate: "2025-12-01", rangeDays: 30 });

  const sourceLoads = calls.filter(call => call.sql.includes("ORDER BY trade_date ASC"));
  assert.equal(sourceLoads.length, 3);
  sourceLoads.forEach(call => {
    assert.equal(call.params.includes("2025-12-01"), true);
    assert.equal(call.params.includes("2025-11-01"), true);
  });
});
