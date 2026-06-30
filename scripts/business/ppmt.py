#!/usr/bin/env python3
import argparse
import html
import json
import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import requests

from source_mappings import (
    load_enabled_source_mappings,
    mark_source_mapping_errors,
    mark_source_mappings_matched,
    mark_source_mappings_seen,
    mark_source_run_error,
)

CATEGORY_NAME = "泡泡玛特"
SOURCE_KEY = "qiandao_popmart"
SOURCE_NAME = "千岛泡泡玛特"
SEARCH_URL = "https://oia.qiandao.com/search"
SPU_URL = "https://oia.qiandao.com/spu"
DEFAULT_DB_PATH = (
    os.environ.get("BUSINESS_DB_PATH")
    or str(Path(__file__).resolve().parents[2] / "data" / "price_dashboard_business.db")
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# 泡泡玛特这一类在系统里没有变体，只按对象入库。
# 这里只放已经能从名称、历史价格和搜索结果稳定对上的对象。
SOURCE_TARGETS = [
    {"object": "XG限定", "query": "XG限定", "spu_id": "929006833488630705"},
    {"object": "万圣节", "query": "Magic of Pumpkin", "spu_id": "789523968431240995"},
    {"object": "嘎子姐", "query": "向往之处", "spu_id": "875239228831738922"},
    {"object": "大春花", "query": "MOKOKO 春花", "spu_id": "704852597684613737"},
    {"object": "大甜心", "query": "大甜心", "spu_id": "675597453717760702"},
    {"object": "大米兰", "query": "大米兰", "spu_id": "778075948925892646"},
    {"object": "姜饼人", "query": "姜饼人1/8", "spu_id": "927988138113005044"},
    {"object": "小甜心", "query": "小甜心", "spu_id": "672953785382971923"},
    {"object": "情人节", "query": "Catch Me If You Like Me", "spu_id": "681855448701274650"},
    {"object": "拿铁", "query": "拿铁", "spu_id": "650794262396462371"},
    {"object": "星星人礼盒", "query": "星星人礼盒", "spu_id": "954718264364114252"},
    {"object": "晒晒", "query": "晒晒", "spu_id": "897177903526088129"},
    {"object": "毛球", "query": "毛球", "spu_id": "915985249635145047"},
    {"object": "白裙子", "query": "FALL INTO SPRING", "spu_id": "704906800172085180"},
    {"object": "蓝裙子", "query": "The Blue Diamond", "spu_id": "740254741795247881"},
    {"object": "醒醒", "query": "醒醒", "spu_id": "970617028555622512"},
    {"object": "闪闪", "query": "闪闪", "spu_id": "801090280999627960"},
    {"object": "飞行员", "query": "JUMP FOR JOY", "spu_id": "593651152747287737"},
]


def load_source_targets(db_path):
    mappings, configured = load_enabled_source_mappings(db_path, SOURCE_KEY)
    if not configured:
        return SOURCE_TARGETS

    targets = []
    for mapping in mappings:
        meta = mapping.get("external_meta") or {}
        object_name = str(mapping.get("object_name") or "").strip()
        spu_id = str(meta.get("spu_id") or mapping.get("external_key") or "").strip()
        query = str(meta.get("query") or mapping.get("external_name") or object_name).strip()
        if not object_name or not spu_id or not query:
            continue
        targets.append({
            "object": object_name,
            "query": query,
            "spu_id": spu_id,
            "external_key": spu_id,
        })
    return targets


def today():
    return datetime.now().strftime("%Y-%m-%d")


def strip_tags(value):
    text = re.sub(r"<[^>]+>", " ", value or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def normalize_price(raw_price):
    text = str(raw_price or "").replace(",", "").strip()
    if not text:
        raise ValueError("价格为空")
    value = float(text)
    return round(value) if value.is_integer() else round(value, 2)


def fetch_search_html(session, query):
    url = f"{SEARCH_URL}?q={quote(query)}"
    response = session.get(url, headers=HEADERS, timeout=25)
    response.raise_for_status()
    return response.text


def fetch_spu_html(session, spu_id):
    response = session.get(SPU_URL, params={"id": spu_id}, headers=HEADERS, timeout=25)
    response.raise_for_status()
    return response.text


def parse_search_results(page_html):
    blocks = re.findall(
        r'<a[^>]+href="https://qiandao\.com/spu\?id=(\d+)"[^>]*>(.*?)</a>',
        page_html,
        flags=re.S,
    )
    results = []
    seen = set()
    for spu_id, block in blocks:
        if spu_id in seen:
            continue
        seen.add(spu_id)

        name_match = re.search(r"<h3[^>]*>(.*?)</h3>", block, flags=re.S)
        name = strip_tags(name_match.group(1)) if name_match else ""
        clean_text = strip_tags(block)
        price_match = re.search(r"¥\s*([0-9]+(?:\.[0-9]+)?)", clean_text)
        price = normalize_price(price_match.group(1)) if price_match else None

        results.append({
            "spu_id": spu_id,
            "name": name,
            "price": price,
            "text": clean_text[:300],
        })
    return results


def parse_spu_page(page_html, spu_id):
    title_match = re.search(r"<title>(.*?)</title>", page_html, flags=re.S)
    name = strip_tags(title_match.group(1)) if title_match else ""
    price = None

    data_match = re.search(
        r'<script type="application/ld\+json">(.*?)</script>',
        page_html,
        flags=re.S,
    )
    if data_match:
        try:
            structured_data = json.loads(html.unescape(data_match.group(1)))
            offers = structured_data.get("offers") or {}
            if offers.get("price") is not None:
                price = normalize_price(offers.get("price"))
            if structured_data.get("name"):
                name = structured_data["name"]
        except (json.JSONDecodeError, ValueError, TypeError):
            pass

    if price is None:
        price_match = re.search(r"千岛成交均价：¥\(?([0-9]+(?:\.[0-9]+)?)\)?", page_html)
        if price_match:
            price = normalize_price(price_match.group(1))

    return {
        "spu_id": spu_id,
        "name": name,
        "price": price,
        "text": strip_tags(page_html[:1000]),
    }


def fetch_source_items(source_targets):
    session = requests.Session()
    source_items = []
    for target in source_targets:
        page_html = fetch_search_html(session, target["query"])
        candidates = parse_search_results(page_html)
        matched = next(
            (item for item in candidates if item["spu_id"] == target["spu_id"]),
            None,
        )
        if matched is None:
            matched = parse_spu_page(
                fetch_spu_html(session, target["spu_id"]),
                target["spu_id"],
            )
        source_items.append({
            **target,
            "matched": matched,
            "candidate_count": len(candidates),
        })
    return source_items


def load_enabled_objects(db_path, category):
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT o.name
            FROM categories c
            JOIN objects o ON o.category_id = c.id
            WHERE c.name = ?
              AND COALESCE(c.is_archived, 0) = 0
              AND COALESCE(o.is_archived, 0) = 0
            ORDER BY o.name
            """,
            (category,),
        ).fetchall()
    finally:
        conn.close()
    return {row[0] for row in rows}


def extract_records(source_items, enabled_objects, category, source_targets, source_name=SOURCE_NAME):
    records = []
    missing_source_objects = []
    missing_errors = {}
    mapped_objects = {target["object"] for target in source_targets}

    for item in source_items:
        object_name = item["object"]
        if object_name not in enabled_objects:
            continue

        matched = item.get("matched")
        if not matched or matched.get("price") is None:
            missing_source_objects.append(object_name)
            missing_errors[item["spu_id"]] = "本次来源未返回成交均价"
            continue

        records.append({
            "category": category,
            "object": object_name,
            "variant": "",
            "price": matched["price"],
            "raw_price": matched["price"],
            "price_date": today(),
            "source": source_name,
            "source_id": matched["spu_id"],
            "source_name": matched["name"],
            "query": item["query"],
        })

    unmapped_enabled_objects = sorted(enabled_objects - mapped_objects)
    return records, unmapped_enabled_objects, missing_source_objects, missing_errors


def upsert_price_records(db_path, records, dry_run=False):
    inserted = 0
    updated = 0
    skipped = 0
    results = []

    if dry_run:
        for record in records:
            results.append({**record, "action": "dry_run"})
        return inserted, updated, skipped, results

    conn = sqlite3.connect(db_path)
    try:
        for record in records:
            now = datetime.now().isoformat()
            existing = conn.execute(
                """
                SELECT id, price
                FROM price_records
                WHERE date = ?
                  AND category = ?
                  AND object_name = ?
                  AND COALESCE(variant, '') = ?
                ORDER BY id DESC
                LIMIT 1
                """,
                (
                    record["price_date"],
                    record["category"],
                    record["object"],
                    record["variant"],
                ),
            ).fetchone()

            if existing is None:
                conn.execute(
                    """
                    INSERT INTO price_records
                      (date, category, object_name, variant, price, source, note, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record["price_date"],
                        record["category"],
                        record["object"],
                        record["variant"],
                        record["price"],
                        record["source"],
                        "",
                        now,
                        now,
                    ),
                )
                inserted += 1
                action = "inserted"
            elif float(existing[1]) != float(record["price"]):
                conn.execute(
                    """
                    UPDATE price_records
                    SET price = ?, source = ?, note = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        record["price"],
                        record["source"],
                        "",
                        now,
                        existing[0],
                    ),
                )
                updated += 1
                action = "updated"
            else:
                skipped += 1
                action = "skipped"

            results.append({**record, "action": action})
        conn.commit()
    finally:
        conn.close()

    return inserted, updated, skipped, results


def build_parser():
    parser = argparse.ArgumentParser(description="同步千岛泡泡玛特价格到商品价格工作台")
    parser.add_argument(
        "--db",
        default=DEFAULT_DB_PATH,
        help="SQLite 数据库路径",
    )
    parser.add_argument("--category", default=CATEGORY_NAME)
    parser.add_argument("--source-name", default=SOURCE_NAME)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    try:
        enabled_objects = load_enabled_objects(args.db, args.category)
        source_targets = load_source_targets(args.db)
        if not source_targets:
            payload = {
                "success": True,
                "status": "skipped",
                "skipped": True,
                "message": "泡泡玛特价格更新已跳过：当前没有启用的数据源映射",
                "category": args.category,
                "source": args.source_name,
                "dry_run": args.dry_run,
                "source_count": 0,
                "matched_count": 0,
                "inserted": 0,
                "updated": 0,
                "skipped_count": 0,
                "records": [],
                "unmapped_enabled_objects": [],
                "missing_source_objects": [],
            }
            print(json.dumps(payload, ensure_ascii=False))
            return
        source_items = fetch_source_items(source_targets)
        if not args.dry_run:
            mark_source_mappings_seen(args.db, SOURCE_KEY, [item["spu_id"] for item in source_items])
        records, unmapped_enabled_objects, missing_source_objects, missing_errors = extract_records(
            source_items,
            enabled_objects,
            args.category,
            source_targets,
            args.source_name,
        )
        inserted, updated, skipped, results = upsert_price_records(
            args.db,
            records,
            dry_run=args.dry_run,
        )
        matched_keys = {record["source_id"] for record in records}
        if not args.dry_run:
            mark_source_mappings_matched(args.db, SOURCE_KEY, matched_keys)
            mark_source_mapping_errors(args.db, SOURCE_KEY, {
                key: message
                for key, message in missing_errors.items()
                if key not in matched_keys
            })
        payload = {
            "success": True,
            "message": (
                f"泡泡玛特价格更新完成：抓取 {len(source_items)} 个映射对象，"
                f"匹配 {len(records)} 条，新增 {inserted}，更新 {updated}，跳过 {skipped}"
            ),
            "category": args.category,
            "source": args.source_name,
            "dry_run": args.dry_run,
            "source_count": len(source_items),
            "matched_count": len(records),
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "records": results,
            "unmapped_enabled_objects": unmapped_enabled_objects,
            "missing_source_objects": missing_source_objects,
        }
    except Exception as exc:
        try:
            mark_source_run_error(args.db, SOURCE_KEY, f"泡泡玛特价格更新失败：{exc}")
        except Exception:
            pass
        payload = {
            "success": False,
            "message": f"泡泡玛特价格更新失败：{exc}",
        }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
