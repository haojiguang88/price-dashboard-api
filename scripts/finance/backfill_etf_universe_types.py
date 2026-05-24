#!/usr/bin/env python3
import os
import sqlite3
import sys

from fetch_asset_universe import classify_etf_universe_types

DEFAULT_DB_PATH = "/Volumes/7100/price-dashboard-data/db/price_dashboard_dev.db"


def main():
    db_path = (
        sys.argv[1]
        if len(sys.argv) > 1
        else os.environ.get("DB_PATH")
        or DEFAULT_DB_PATH
    )

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        """
        SELECT *
        FROM financial_asset_universe
        WHERE asset_type = 'etf'
          AND universe_type = 'full_etf'
          AND enabled = 1
        """
    ).fetchall()

    affected = 0
    removed = 0
    examples = []
    derived_tags = (
        "broad_etf",
        "industry_etf",
        "commodity_etf",
        "cross_border_etf",
        "bond_cash_etf",
        "special_fund",
    )

    for row in rows:
        tags = [tag for tag in classify_etf_universe_types(row["name"] or "") if tag != "full_etf"]
        stale_tags = [tag for tag in derived_tags if tag not in tags]
        if stale_tags:
            before = conn.total_changes
            placeholders = ",".join("?" for _ in stale_tags)
            conn.execute(
                f"""
                DELETE FROM financial_asset_universe
                WHERE symbol = ?
                  AND asset_type = ?
                  AND source = ?
                  AND universe_type IN ({placeholders})
                """,
                (row["symbol"], row["asset_type"], row["source"], *stale_tags),
            )
            removed += conn.total_changes - before

        for tag in tags:
            before = conn.total_changes
            conn.execute(
                """
                INSERT INTO financial_asset_universe (
                  symbol, name, asset_type, universe_type, source, enabled,
                  update_status, total_count, first_trade_date, last_trade_date,
                  last_updated, last_fetch_at, last_fetch_message, local_data_ready,
                  created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT(symbol, asset_type, universe_type, source) DO UPDATE SET
                  name = COALESCE(NULLIF(excluded.name, ''), financial_asset_universe.name),
                  enabled = excluded.enabled,
                  update_status = excluded.update_status,
                  total_count = excluded.total_count,
                  first_trade_date = excluded.first_trade_date,
                  last_trade_date = excluded.last_trade_date,
                  last_updated = excluded.last_updated,
                  last_fetch_at = excluded.last_fetch_at,
                  last_fetch_message = excluded.last_fetch_message,
                  local_data_ready = excluded.local_data_ready,
                  updated_at = CURRENT_TIMESTAMP
                """,
                (
                    row["symbol"],
                    row["name"] or "",
                    row["asset_type"],
                    tag,
                    row["source"],
                    row["enabled"],
                    row["update_status"],
                    row["total_count"],
                    row["first_trade_date"],
                    row["last_trade_date"],
                    row["last_updated"],
                    row["last_fetch_at"],
                    row["last_fetch_message"],
                    row["local_data_ready"],
                ),
            )
            if conn.total_changes > before:
                if examples and examples[-1].get("symbol") == row["symbol"] and examples[-1].get("tag") == tag:
                    pass
                elif len(examples) < 20:
                    examples.append({"symbol": row["symbol"], "name": row["name"], "tag": tag})
                affected += conn.total_changes - before

    conn.commit()

    # SQLite changes() cannot distinguish insert/update for UPSERT reliably here,
    # so report affected derived tags as backfilled_count.
    counts = conn.execute(
        """
        SELECT universe_type, COUNT(*) AS count
        FROM financial_asset_universe
        WHERE asset_type = 'etf'
        GROUP BY universe_type
        ORDER BY count DESC
        """
    ).fetchall()

    print({
        "success": True,
        "db_path": db_path,
        "full_etf_rows": len(rows),
        "backfilled_count": affected,
        "removed_stale_count": removed,
        "examples": examples,
        "counts": [dict(row) for row in counts],
    })
    conn.close()


if __name__ == "__main__":
    main()
