import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";
import { attachMarketBooks, listMarketTrades } from "../src/services/marketBookService";

const pythonBin = path.join(__dirname, "..", ".venv", "bin", "python");
const bookScriptDir = path.join(__dirname, "..", "scripts", "business");

test("parses Qiandao flash/ask/bid book and prefers bid as display price", () => {
  const result = spawnSync(pythonBin, ["-c", `
from qiandao_book import choose_display_price, detect_sweep, parse_revived_book, parse_spu_html
html = '''<html><script type="application/json" data-nuxt-data="nuxt-app">[{"totalSellingMount":502,"minPrice":522,"shops":[{"name":"千岛闪购潮玩"}]},{"strikePrice":522.67},{"id":"s1","direction":"STOCK_ORDER_DIRECTION_SELL","price":522,"amount":5,"ownerId":"a"},{"id":"s2","direction":"STOCK_ORDER_DIRECTION_SELL","price":524,"amount":1,"ownerId":"b"},{"id":"s3","direction":"STOCK_ORDER_DIRECTION_SELL","price":522,"amount":2,"ownerId":"c"}]</script></html>'''
parsed = parse_spu_html(html)
chosen_html = choose_display_price(parsed)
assert chosen_html["flash_selling_qty"] == 502
assert chosen_html["flash_min_price"] == 522
assert chosen_html["ask_qty"] == 502
assert chosen_html["price_kind"] == "flash_min"
assert chosen_html["display_price"] == 522
book = parse_revived_book([
  {"totalSellingMount": 502, "minPrice": 522, "shops": [{"name": "千岛闪购潮玩"}]},
  {"strikePrice": 522.67},
  {"id": "s1", "direction": "STOCK_ORDER_DIRECTION_SELL", "price": 522, "amount": 5, "ownerId": "a"},
  {"id": "s2", "direction": "STOCK_ORDER_DIRECTION_SELL", "price": 524, "amount": 1, "ownerId": "b"},
  {"id": "s3", "direction": "STOCK_ORDER_DIRECTION_SELL", "price": 522, "amount": 2, "ownerId": "c"},
  {"id": "b1", "direction": "STOCK_ORDER_DIRECTION_BUY", "price": 500, "amount": 3, "ownerId": "d"},
  {"id": "b2", "direction": "STOCK_ORDER_DIRECTION_BUY", "price": 498, "amount": 8, "ownerId": "e"},
])
chosen = choose_display_price(book)
assert chosen["flash_selling_qty"] == 502
assert chosen["flash_min_price"] == 522
assert chosen["ask_qty"] == 502
assert chosen["bid_price"] == 500
assert chosen["bid_qty"] == 11
assert chosen["price_kind"] == "bid"
assert chosen["display_price"] == 500
ask_522 = next(level for level in chosen["ask_levels"] if level["price"] == 522)
assert ask_522["qty"] == 7
assert detect_sweep([
  {"buyer_account_id": "x", "qty": 5, "traded_at": "2026-09-14T10:00:00+08:00"},
  {"buyer_account_id": "x", "qty": 5, "traded_at": "2026-09-14T10:01:00+08:00"},
  {"buyer_account_id": "x", "qty": 5, "traded_at": "2026-09-14T10:02:00+08:00"},
]) == 1
assert detect_sweep([
  {"buyer_account_id": "x", "qty": 5, "traded_at": "2026-09-14T10:00:00+08:00"},
]) == 0
print("ok")
`], { cwd: bookScriptDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(String(result.stdout), /ok/);
});

test("upserts market book snapshots by day and dedupes trades", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qiandao-market-book-"));
  const filename = path.join(directory, "business.db");
  const manager = new DatabaseManager({
    filename,
    allowCreate: true,
    initialize: initializeBusinessBaseSchema
  });
  try {
    await manager.getDb();
    await runMigrations(filename);
    const upsert = spawnSync(pythonBin, ["-c", `
from qiandao_book import upsert_market_book
record = {"category": "泡泡玛特", "object": "嘎子姐", "variant": "", "price_date": "2026-09-14"}
book = {
  "avg_deal_price": 522.67,
  "flash": {"min_price": 522, "selling_qty": 502, "shop_name": "千岛闪购潮玩"},
  "ask_orders": [{"price": 522, "qty": 5, "external_id": "s1"}, {"price": 524, "qty": 1, "external_id": "s2"}],
  "bid_orders": [{"price": 500, "qty": 3, "external_id": "b1"}],
  "trades": [
    {"external_id": "t1", "price": 522, "qty": 5, "traded_at": "2026-09-14T10:00:00+08:00", "trade_date": "2026-09-14", "buyer_account_id": "acct-1", "seller_account_id": "shop"},
    {"external_id": "t2", "price": 522, "qty": 5, "traded_at": "2026-09-14T10:01:00+08:00", "trade_date": "2026-09-14", "buyer_account_id": "acct-1", "seller_account_id": "shop"},
    {"external_id": "t3", "price": 522, "qty": 5, "traded_at": "2026-09-14T10:02:00+08:00", "trade_date": "2026-09-14", "buyer_account_id": "acct-1", "seller_account_id": "shop"},
  ],
}
upsert_market_book(${JSON.stringify(filename)}, record, book)
book["flash"] = {"min_price": 522, "selling_qty": 400, "shop_name": "千岛闪购潮玩"}
upsert_market_book(${JSON.stringify(filename)}, record, book)
print("ok")
`], { cwd: bookScriptDir, encoding: "utf8" });
    assert.equal(upsert.status, 0, upsert.stderr || upsert.stdout);

    const db = await manager.getDb();
    const snapshot = await db.get(
      `SELECT display_price, price_kind, flash_selling_qty, bid_price, bid_qty, sweep_hint
       FROM market_book_snapshots
       WHERE object_name = '嘎子姐' AND date = '2026-09-14'`
    );
    assert.equal(snapshot.display_price, 500);
    assert.equal(snapshot.price_kind, "bid");
    assert.equal(snapshot.flash_selling_qty, 400);
    assert.equal(snapshot.bid_price, 500);
    assert.equal(snapshot.bid_qty, 3);
    assert.equal(snapshot.sweep_hint, 1);

    const snapshotCount = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM market_book_snapshots");
    const tradeCount = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM market_trades");
    assert.equal(snapshotCount?.count, 1);
    assert.equal(tradeCount?.count, 3);

    const attached = await attachMarketBooks(db, [{
      category: "泡泡玛特",
      object_name: "嘎子姐",
      variant: "",
      date: "2026-09-14",
      price: 500
    }]);
    assert.equal(attached[0].book?.flash_selling_qty, 400);
    assert.equal(attached[0].book?.trade_count, 3);
    assert.equal(attached[0].book?.sweep_hint, true);

    const trades = await listMarketTrades(db, {
      category: "泡泡玛特",
      object_name: "嘎子姐",
      date: "2026-09-14"
    });
    assert.equal(trades.pagination.total, 3);
    assert.equal(trades.data[0].buyer_account_id, "acct-1");

    const empty = await attachMarketBooks(db, [{
      category: "游戏机",
      object_name: "Switch OLED日版红蓝",
      variant: "",
      date: "2026-09-14"
    }]);
    assert.equal(empty[0].book, null);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
