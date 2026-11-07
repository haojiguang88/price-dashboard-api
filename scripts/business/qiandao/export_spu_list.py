#!/usr/bin/env python3
"""Export enabled Qiandao SPU mappings and refresh the DevTools fetch snippet.

Does not call Qiandao. The snippet stays idle until startQiandaoTrades() is
invoked inside WeChat DevTools.
"""
import json
import os
import shutil
import sqlite3
from pathlib import Path

SOURCE_KEY = "qiandao_popmart"
ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
DEFAULT_DB = os.environ.get("BUSINESS_DB_PATH") or str(ROOT / "data" / "price_dashboard_business_dev.db")
HANDOFF_SNIPPET = Path.home() / "wxapkg-analysis" / "qiandao" / "scripts" / "console-fetch-snippet.js"


def load_spus(db_path):
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT external_key, external_name, category_name, object_name, variant_name
            FROM source_mappings
            WHERE source_key = ?
              AND status = 'enabled'
            ORDER BY category_name, object_name, variant_name, id
            """,
            (SOURCE_KEY,),
        ).fetchall()
    finally:
        conn.close()
    spus = []
    for row in rows:
        spu_id = str(row["external_key"] or "").strip()
        if not spu_id:
            continue
        spus.append({
            "spu_id": spu_id,
            "category": row["category_name"],
            "object_name": row["object_name"],
            "variant_name": row["variant_name"] or "",
            "external_name": row["external_name"] or "",
        })
    return spus


def main():
    spus = load_spus(DEFAULT_DB)
    list_path = HERE / "spu-list.json"
    list_path.write_text(json.dumps({
        "source_key": SOURCE_KEY,
        "count": len(spus),
        "spus": spus,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    template = (HERE / "console-fetch-snippet.template.js").read_text(encoding="utf-8")
    snippet = template.replace("__SPU_LIST_JSON__", json.dumps(spus, ensure_ascii=False))
    snippet_path = HERE / "console-fetch-snippet.js"
    snippet_path.write_text(snippet, encoding="utf-8")
    if HANDOFF_SNIPPET.parent.exists():
        try:
            shutil.copyfile(snippet_path, HANDOFF_SNIPPET)
        except OSError as error:
            print(f"handoff copy skipped: {error}")
    print(f"spus={len(spus)} list={list_path} snippet={snippet_path}")


if __name__ == "__main__":
    main()
