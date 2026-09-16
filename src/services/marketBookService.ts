export type MarketBookLevel = {
  side: "ask" | "bid";
  price: number;
  qty: number;
};

export type MarketBookSummary = {
  flash_min_price: number | null;
  flash_selling_qty: number | null;
  ask_qty: number | null;
  bid_qty: number | null;
  bid_price: number | null;
  display_price: number | null;
  price_kind: string;
  avg_deal_price: number | null;
  sweep_hint: boolean;
  trade_count: number;
  ask_levels: MarketBookLevel[];
  bid_levels: MarketBookLevel[];
};

export type MarketTradeRow = {
  id: number;
  external_id: string;
  traded_at: string;
  trade_date: string;
  price: number;
  qty: number;
  buyer_account_id: string | null;
  seller_account_id: string | null;
};

const toNumberOrNull = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toIntOrNull = (value: unknown) => {
  const number = toNumberOrNull(value);
  return number === null ? null : Math.trunc(number);
};

export const marketBookTableExists = async (db: any) => {
  const row = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'market_book_snapshots'"
  );
  return Boolean(row);
};

export const attachMarketBooks = async (
  db: any,
  records: Array<{ category?: string; object_name?: string; variant?: string; date?: string; price_kind?: string | null }>,
  sourceKey = "qiandao_popmart"
) => {
  if (!records.length || !(await marketBookTableExists(db))) {
    return records.map((record) => ({ ...record, book: null }));
  }

  const keys = [...new Set(records.map((record) => ({
    category: String(record.category || "").trim(),
    object_name: String(record.object_name || "").trim(),
    variant: String(record.variant || "").trim(),
    date: String(record.date || "").slice(0, 10)
  })).filter((item) => item.category && item.object_name && item.date))];

  if (!keys.length) {
    return records.map((record) => ({ ...record, book: null }));
  }

  const snapshotParams = [
    sourceKey,
    ...keys.flatMap((item) => [item.category, item.object_name, item.variant, item.date])
  ];
  const snapshots = await db.all(
    `SELECT *
     FROM market_book_snapshots
     WHERE source_key = ?
       AND (${keys.map(() => "(category = ? AND object_name = ? AND COALESCE(variant, '') = ? AND date = ?)").join(" OR ")})`,
    snapshotParams
  );

  const snapshotByKey = new Map<string, any>();
  for (const snapshot of snapshots || []) {
    const key = [
      String(snapshot.category || "").trim(),
      String(snapshot.object_name || "").trim(),
      String(snapshot.variant || "").trim(),
      String(snapshot.date || "").slice(0, 10)
    ].join("|");
    snapshotByKey.set(key, snapshot);
  }

  const snapshotIds = (snapshots || []).map((row: any) => Number(row.id)).filter((id: number) => Number.isFinite(id) && id > 0);
  const levelsBySnapshot = new Map<number, MarketBookLevel[]>();
  if (snapshotIds.length) {
    const placeholders = snapshotIds.map(() => "?").join(", ");
    const levels = await db.all(
      `SELECT snapshot_id, side, price, qty
       FROM market_book_levels
       WHERE snapshot_id IN (${placeholders})
       ORDER BY side ASC, price ASC`,
      snapshotIds
    );
    for (const level of levels || []) {
      const snapshotId = Number(level.snapshot_id);
      const list = levelsBySnapshot.get(snapshotId) || [];
      list.push({
        side: level.side === "bid" ? "bid" : "ask",
        price: Number(level.price),
        qty: Number(level.qty)
      });
      levelsBySnapshot.set(snapshotId, list);
    }
  }

  const tradeCounts = await db.all(
    `SELECT category, object_name, COALESCE(variant, '') AS variant, trade_date, COUNT(*) AS trade_count
     FROM market_trades
     WHERE source_key = ?
       AND (${keys.map(() => "(category = ? AND object_name = ? AND COALESCE(variant, '') = ? AND trade_date = ?)").join(" OR ")})
     GROUP BY category, object_name, COALESCE(variant, ''), trade_date`,
    [sourceKey, ...keys.flatMap((item) => [item.category, item.object_name, item.variant, item.date])]
  );
  const tradeCountByKey = new Map<string, number>();
  for (const row of tradeCounts || []) {
    tradeCountByKey.set(
      [
        String(row.category || "").trim(),
        String(row.object_name || "").trim(),
        String(row.variant || "").trim(),
        String(row.trade_date || "").slice(0, 10)
      ].join("|"),
      Number(row.trade_count || 0)
    );
  }

  return records.map((record) => {
    const key = [
      String(record.category || "").trim(),
      String(record.object_name || "").trim(),
      String(record.variant || "").trim(),
      String(record.date || "").slice(0, 10)
    ].join("|");
    const snapshot = snapshotByKey.get(key);
    if (!snapshot) {
      return { ...record, book: null };
    }
    const levels = levelsBySnapshot.get(Number(snapshot.id)) || [];
    const book: MarketBookSummary = {
      flash_min_price: toNumberOrNull(snapshot.flash_min_price),
      flash_selling_qty: toIntOrNull(snapshot.flash_selling_qty),
      ask_qty: toIntOrNull(snapshot.ask_qty),
      bid_qty: toIntOrNull(snapshot.bid_qty),
      bid_price: toNumberOrNull(snapshot.bid_price),
      display_price: toNumberOrNull(snapshot.display_price),
      price_kind: String(snapshot.price_kind || record.price_kind || "avg_deal"),
      avg_deal_price: toNumberOrNull(snapshot.avg_deal_price),
      sweep_hint: Number(snapshot.sweep_hint || 0) === 1,
      trade_count: tradeCountByKey.get(key) || 0,
      ask_levels: levels.filter((level) => level.side === "ask"),
      bid_levels: levels.filter((level) => level.side === "bid")
    };
    return { ...record, book };
  });
};

export const listMarketTrades = async (
  db: any,
  params: {
    category: string;
    object_name: string;
    variant?: string;
    date: string;
    page?: number;
    pageSize?: number;
    sourceKey?: string;
  }
) => {
  if (!(await marketBookTableExists(db))) {
    return { data: [] as MarketTradeRow[], pagination: { total: 0, page: 1, pageSize: 50, totalPages: 1 } };
  }
  const pageSize = Math.min(100, Math.max(10, Number(params.pageSize || 50) || 50));
  const requestedPage = Math.max(1, Number(params.page || 1) || 1);
  const variant = String(params.variant || "").trim();
  const where = [
    "source_key = ?",
    "category = ?",
    "object_name = ?",
    "COALESCE(variant, '') = ?",
    "trade_date = ?"
  ];
  const values = [
    params.sourceKey || "qiandao_popmart",
    params.category,
    params.object_name,
    variant,
    params.date
  ];
  const countRow = await db.get(
    `SELECT COUNT(*) AS total FROM market_trades WHERE ${where.join(" AND ")}`,
    values
  );
  const total = Number(countRow?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const page = Math.min(requestedPage, totalPages);
  const rows = await db.all(
    `SELECT id, external_id, traded_at, trade_date, price, qty, buyer_account_id, seller_account_id
     FROM market_trades
     WHERE ${where.join(" AND ")}
     ORDER BY traded_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...values, pageSize, (page - 1) * pageSize]
  );
  return {
    data: (rows || []).map((row: any) => ({
      id: Number(row.id),
      external_id: String(row.external_id || ""),
      traded_at: String(row.traded_at || ""),
      trade_date: String(row.trade_date || ""),
      price: Number(row.price),
      qty: Number(row.qty),
      buyer_account_id: row.buyer_account_id ? String(row.buyer_account_id) : null,
      seller_account_id: row.seller_account_id ? String(row.seller_account_id) : null
    })),
    pagination: { total, page, pageSize, totalPages }
  };
};
