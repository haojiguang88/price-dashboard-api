import assert from "node:assert/strict";
import test from "node:test";
import {
  TROY_OUNCE_GRAMS,
  applyShuibeiBasisToInput,
  buildShuibeiSnapshot,
  convertPreciousMetalQuote,
  indexRongtongjinQuotes,
  loadPreciousMetalConverterContext
} from "../src/services/preciousMetalConverterService";

test("5000 USD/oz converts to RMB per gram with USD/CNH", () => {
  const converted = convertPreciousMetalQuote(5000, 7, "usd_oz");
  const expectedCnyPerGram = 5000 * 7 / TROY_OUNCE_GRAMS;

  assert.ok(converted);
  assert.equal(converted.usd_per_oz, 5000);
  assert.ok(Math.abs(converted.cny_per_g - expectedCnyPerGram) < 0.01);
  assert.ok(Math.abs(converted.usd_per_g - 5000 / TROY_OUNCE_GRAMS) < 0.0001);
  assert.equal(converted.cny_per_oz, 35000);
});

test("silver 67 USD/oz stays on the international conversion", () => {
  const converted = convertPreciousMetalQuote(67, 6.705415, "usd_oz");
  assert.ok(converted);
  assert.equal(converted.cny_per_g, 14.44);
});

test("RMB per gram converts back to USD per gram and USD/oz", () => {
  const converted = convertPreciousMetalQuote(1141.35, 7, "cny_g");

  assert.ok(converted);
  assert.ok(Math.abs(converted.usd_per_g - 1141.35 / 7) < 0.0001);
  assert.ok(Math.abs(converted.usd_per_oz - 1141.35 * TROY_OUNCE_GRAMS / 7) < 0.05);
  assert.equal(converted.cny_per_g, 1141.35);
});

test("invalid input does not convert", () => {
  assert.equal(convertPreciousMetalQuote(0, 7, "usd_oz"), null);
  assert.equal(convertPreciousMetalQuote(5000, 0, "usd_oz"), null);
});

test("input USD/oz converts to domestic spot by adding live basis", () => {
  const converted = applyShuibeiBasisToInput(67, 6.705415, 0.58, "usd_oz", "international");
  assert.ok(converted);
  assert.equal(converted.international_cny_g, 14.44);
  assert.equal(converted.domestic_cny_g, 15.02);
});

test("input domestic CNY/g converts back to international by subtracting basis", () => {
  const converted = applyShuibeiBasisToInput(15.17, 6.7059, 0.5872, "cny_g", "domestic_spot");
  assert.ok(converted);
  assert.equal(converted.domestic_cny_g, 15.17);
  assert.equal(converted.international_cny_g, 14.58);
});

test("shuibei silver uses bidprice and rounds after computing basis", () => {
  const quotes = indexRongtongjinQuotes({
    result: 0,
    items: [
      { code: "JZJ_ag", bidprice: "15.165", askprice: "15.265", stime: "1789002233" },
      { code: "XAG", bidprice: "67.615" },
      { code: "USDCNH", bidprice: "6.7059" },
      { code: "Ag(T+D)", bidprice: "16380.0" }
    ]
  });
  const snapshot = buildShuibeiSnapshot(quotes, "JZJ_ag", "XAG");

  assert.ok(snapshot);
  assert.equal(snapshot.domestic_bid, 15.17);
  assert.equal(snapshot.international_cny_g, 14.58);
  assert.equal(snapshot.basis, 0.59);
  assert.equal(snapshot.askprice, 15.265);
  assert.notEqual(snapshot.domestic_bid, 16.38);
});

test("converter context prefers 水贝 silver over delayed SGE", async () => {
  const rows = [
    { symbol: "USDCNH", source: "tushare_fxcm", trade_date: "2026-09-08", close: 7.12, id: 1 },
    { symbol: "XAUUSD", source: "twelvedata", trade_date: "2026-09-09", close: 4390, id: 2 },
    { symbol: "SGE_AGTD", source: "tushare_sge", trade_date: "2026-09-09", close: 16.233, id: 3 }
  ];
  const db = {
    get: async (_sql: string, params: unknown[]) => rows.find(row => row.symbol === params[0] && row.source === params[1]) || null
  };
  const fetchQuotes = async () => ({
    ok: true,
    json: async () => ({
      result: 0,
      items: [
        { code: "JZJ_ag", bidprice: "15.165", askprice: "15.265", stime: "1789002233" },
        { code: "JZJ_au", bidprice: "948.6", askprice: "951.6" },
        { code: "XAG", bidprice: "67.615" },
        { code: "XAU", bidprice: "4409.35" },
        { code: "USDCNH", bidprice: "6.7059" }
      ]
    })
  }) as unknown as typeof fetch;

  const context = await loadPreciousMetalConverterContext(db, { fetchQuotes });

  assert.equal(context.default_quote_book, "international");
  assert.equal(context.shuibei.silver?.domestic_bid, 15.17);
  assert.equal(context.shuibei.silver?.basis, 0.59);
  assert.equal(context.delayed_silver?.cny_per_g, 16.233);
  assert.equal(context.fx.source, "ytj9999");
  assert.match(context.note, /基差用/);
});

test("converter context still loads when 水贝 feed fails", async () => {
  const rows = [
    { symbol: "USDCNH", source: "tushare_fxcm", trade_date: "2026-09-08", close: 7.12, id: 1 },
    { symbol: "XAUUSD", source: "twelvedata", trade_date: "2026-09-09", close: 4390, id: 2 },
    { symbol: "SGE_AGTD", source: "tushare_sge", trade_date: "2026-09-09", close: 16.233, id: 3 }
  ];
  const db = {
    get: async (_sql: string, params: unknown[]) => rows.find(row => row.symbol === params[0] && row.source === params[1]) || null
  };
  const fetchQuotes = async () => {
    throw new Error("network down");
  };

  const context = await loadPreciousMetalConverterContext(db, { fetchQuotes });

  assert.equal(context.shuibei.silver, null);
  assert.equal(context.delayed_silver?.cny_per_g, 16.233);
  assert.equal(context.fx.source, "tushare_fxcm");
  assert.match(context.note, /暂时没读到/);
});

test("daily basis is reused and does not refetch the same Shanghai day", async () => {
  let fetchCount = 0;
  const tradeDate = "2026-09-10";
  const silverSnapshot = {
    code: "JZJ_ag",
    quote_time: "1789002233",
    domestic_bid: 15.17,
    domestic_bid_raw: 15.165,
    askprice: 15.265,
    x_usd_oz: 67.615,
    usdcnh_bid: 6.7059,
    international_cny_g: 14.58,
    international_cny_g_raw: 14.5778,
    basis: 0.59,
    basis_raw: 0.5872
  };
  const goldSnapshot = {
    code: "JZJ_au",
    quote_time: "1789002233",
    domestic_bid: 948.6,
    domestic_bid_raw: 948.6,
    askprice: 951.6,
    x_usd_oz: 4409.35,
    usdcnh_bid: 6.7059,
    international_cny_g: 950.4,
    international_cny_g_raw: 950.4,
    basis: -1.8,
    basis_raw: -1.8
  };
  const rows = [
    { symbol: "USDCNH", source: "tushare_fxcm", trade_date: "2026-09-08", close: 7.12 },
    { symbol: "XAUUSD", source: "twelvedata", trade_date: "2026-09-09", close: 4390 },
    { symbol: "SGE_AGTD", source: "tushare_sge", trade_date: "2026-09-09", close: 16.233 },
    { symbol: "SHUIBEI_AG_BASIS", source: "ytj9999", trade_date: tradeDate, close: 0.5872, raw_json: JSON.stringify(silverSnapshot) },
    { symbol: "SHUIBEI_AU_BASIS", source: "ytj9999", trade_date: tradeDate, close: -1.8, raw_json: JSON.stringify(goldSnapshot) }
  ];
  const db = {
    get: async (_sql: string, params: unknown[]) => {
      if (params.length >= 3) {
        return rows.find(row => row.symbol === params[0] && row.source === params[1] && row.trade_date === params[2]) || null;
      }
      return rows.find(row => row.symbol === params[0] && row.source === params[1]) || null;
    }
  };
  const fetchQuotes = async () => {
    fetchCount += 1;
    throw new Error("should not fetch");
  };

  const context = await loadPreciousMetalConverterContext(db, {
    fetchQuotes,
    now: new Date("2026-09-10T04:00:00Z")
  });

  assert.equal(fetchCount, 0);
  assert.equal(context.shuibei.silver?.basis, 0.59);
  assert.equal(context.quote_source.basis_trade_date, tradeDate);
  assert.equal(context.quote_source.basis_refreshed_today, false);
});
