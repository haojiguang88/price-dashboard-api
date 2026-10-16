#!/usr/bin/env python3
"""小鸽手机回收报价。

二手成色价走 /usedGood/getPriceList（AES-128-CBC，响应是 Base64）。
该接口目前解密后是空串。销售报价板 /sale/getPriceDetail 用同一套密钥，
返回型号 + 颜色 + 价格，用来补当天还没有其它来源的型号。

不调用 /purchase/getRecoveryList，那条用的是微信用户密钥，离线复现不了。
"""
import argparse
import json
import os
import re
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import requests
from Cryptodome.Cipher import AES
from Cryptodome.Util.Padding import pad, unpad

SOURCE_KEY = "xiaoge_phone"
SOURCE_NAME = "小鸽手机回收"
BASE_URL = "https://wechat.sanmicun.com"
AES_KEY = b"1HA1ar(154idvo!@"
AES_IV = b"!@vo(1arA154GHid"
DEFAULT_DB_PATH = (
    os.environ.get("BUSINESS_DB_PATH")
    or str(Path(__file__).resolve().parents[2] / "data" / "price_dashboard_business.db")
)
CURATED_CATEGORIES = set()
ACCESSORY_KEYWORDS = (
    "耳机", "手环", "手表", "watch", "充电器", "充电头", "充电宝", "移动电源",
    "保护壳", "保护套", "手写笔", "触控笔", "数据线", "散热", "风扇",
    "保温杯", "随行杯", "双肩包", "背包", "音响", "剃须刀", "吹风机",
    "打印机", "传感器", "网关", "摄像机", "智能锁", "配件", "pencil",
)
ACCESSORY_STALE_DAYS = 45
XIAOGE_STALE_DAYS = 30
BRAND_CATEGORY = {
    "苹果": "苹果手机",
    "华为": "华为",
    "小米": "小米",
    "红米": "红米",
    "荣耀": "荣耀",
    "oppo": "OPPO",
    "vivo": "VIVO",
    "iqoo": "iQOO",
    "realme": "真我",
    "一加": "一加",
    "三星": "三星",
}
HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 MicroMessenger/8.0.62 MiniProgram",
    "Referer": "https://servicewechat.com/wx0a7ae5458d961b2a/0/page-frame.html",
    "secretKey": "PcnMh+UXAmk/iNlqFFahKu",
}


def encrypt_hex(text):
    cipher = AES.new(AES_KEY, AES.MODE_CBC, AES_IV)
    return cipher.encrypt(pad(str(text).encode("utf-8"), 16)).hex()


def decrypt_base64(text):
    raw = text.strip().strip('"')
    if not raw:
        return ""
    cipher = AES.new(AES_KEY, AES.MODE_CBC, AES_IV)
    return unpad(cipher.decrypt(__import__("base64").b64decode(raw)), 16).decode("utf-8")


def post_json(path, payload):
    response = requests.post(
        BASE_URL + path,
        json=payload,
        headers=HEADERS,
        timeout=40,
    )
    response.raise_for_status()
    response.encoding = "utf-8"
    return response.text.strip()


def normalize_key(value):
    text = str(value or "").strip().lower()
    text = text.replace("（", "(").replace("）", ")")
    text = re.sub(r"\([^)]*\)", "", text)
    text = re.sub(r"pro\s*max", "promax", text)
    text = re.sub(r"[\s+_／/\\-]+", "", text)
    text = text.replace("gb", "g")
    return text


def clean_model_name(value):
    text = re.sub(r"\([^)]*\)", "", str(value or ""))
    text = text.replace("（", " ").replace("）", " ")
    return re.sub(r"\s+", " ", text).strip()


def category_for_brand(brand):
    return BRAND_CATEGORY.get(str(brand or "").strip().lower()) or BRAND_CATEGORY.get(str(brand or "").strip())


def strip_brand(name):
    text = clean_model_name(name)
    return re.sub(
        r"^(苹果|华为|小米|红米|荣耀|oppo|vivo|iqoo|realme|一加|三星|redmi)\s*",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()


def resolve_category(brand, model_name):
    folded = f"{brand} {model_name}".lower()
    if "redmi" in folded or "红米" in folded:
        return "红米"
    return category_for_brand(brand)


def candidate_categories(category):
    if category in {"小米", "红米"}:
        return ["红米", "小米"] if category == "红米" else ["小米", "红米"]
    return [category]


def is_accessory(name):
    text = str(name or "").lower()
    return any(keyword.lower() in text for keyword in ACCESSORY_KEYWORDS)


def display_object_name(category, model_name):
    name = clean_model_name(model_name)
    if category != "苹果手机":
        return name
    name = re.sub(r"(?i)iphone\s*air", "iPhone Air", name)
    name = re.sub(r"(?i)iphone\s*(\d{1,2})", r"iPhone \1", name)
    name = re.sub(r"(?i)pro\s*max", "Pro Max", name)
    name = re.sub(r"(?i)(?<![A-Za-z])pro(?!\s*max)", "Pro", name)
    return re.sub(r"\s+", " ", name).strip()


def lookup_target(catalog, category, model_name):
    keys = []
    for text in (model_name, strip_brand(model_name)):
        key = normalize_key(text)
        if key and key not in keys:
            keys.append(key)
    for item_category in candidate_categories(category):
        for key in keys:
            found = catalog.get((item_category, key))
            if found:
                return found
    return None


def normalize_price(raw_price):
    text = str(raw_price).replace(",", "").replace("￥", "").strip()
    if not text or text in {"暂无", "null", "None"}:
        raise ValueError("价格为空")
    price = round(float(text))
    if price <= 0:
        raise ValueError("价格无效")
    return price


def load_catalog(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        categories = {
            row["name"]: row["id"]
            for row in conn.execute(
                """
                SELECT id, name FROM categories
                WHERE COALESCE(is_archived, 0) = 0
                """
            )
        }
        objects = {}
        rows = conn.execute(
            """
            SELECT c.name AS category, o.id AS object_id, o.name AS object_name,
                   v.id AS variant_id, v.name AS variant_name
            FROM categories c
            JOIN objects o ON o.category_id = c.id
            LEFT JOIN variants v ON v.object_id = o.id AND COALESCE(v.is_archived, 0) = 0
            WHERE COALESCE(c.is_archived, 0) = 0
              AND COALESCE(o.is_archived, 0) = 0
            """
        ).fetchall()
    finally:
        conn.close()

    for row in rows:
        keys = [
            key for key in {
                normalize_key(row["object_name"]),
                normalize_key(strip_brand(row["object_name"])),
            }
            if key
        ]
        bucket = None
        for key in keys:
            bucket = objects.get((row["category"], key))
            if bucket and bucket["object_id"] == row["object_id"]:
                break
            bucket = None
        if bucket is None:
            bucket = {
                "category": row["category"],
                "object_id": row["object_id"],
                "object_name": row["object_name"],
                "variants": {},
            }
        for key in keys:
            objects.setdefault((row["category"], key), bucket)
        if row["variant_name"]:
            bucket["variants"][row["variant_name"]] = row["variant_id"]
    return categories, objects


def fetch_used_price_lists():
    notice = post_json("/user/getNotice", {"typeName": "topBrandList"})
    brands = [item.strip() for item in notice.split(",") if item.strip()]
    plaintext_by_brand = {}
    quotes = []
    for brand in brands:
        body = post_json("/usedGood/getPriceList", {"brand": encrypt_hex(brand)})
        plain = decrypt_base64(body)
        plaintext_by_brand[brand] = plain
        if not plain:
            continue
        payload = json.loads(plain)
        quotes.extend(quotes_from_used(payload, brand))
    return brands, plaintext_by_brand, quotes


def quotes_from_used(node, brand, inherited=None):
    inherited = inherited or {}
    found = []
    if isinstance(node, list):
        for item in node:
            found.extend(quotes_from_used(item, brand, inherited))
        return found
    if not isinstance(node, dict):
        return found

    context = dict(inherited)
    for key in ("goodName", "name", "model", "typeName", "prodName"):
        if node.get(key):
            context["model_name"] = node.get(key)
    if node.get("capacity"):
        context["capacity"] = node.get("capacity")
    if node.get("level"):
        context["level"] = node.get("level")
    if node.get("warranty"):
        context["warranty"] = node.get("warranty")
    price = node.get("recoveryPrice")
    if price in (None, ""):
        price = node.get("price") if node.get("goodsId") or node.get("level") or node.get("capacity") else None
    if price not in (None, ""):
        model_name = clean_model_name(context.get("model_name") or "")
        capacity = str(context.get("capacity") or "").strip()
        if capacity and capacity not in model_name:
            model_name = f"{model_name} {capacity}".strip()
        level = str(context.get("level") or "").strip()
        warranty = str(context.get("warranty") or "").strip()
        variant = " ".join(part for part in (warranty, level) if part).strip()
        found.append({
            "brand": brand,
            "model_name": model_name,
            "variant": variant,
            "price": price,
            "goods_id": str(node.get("goodsId") or node.get("usedGoodId") or ""),
            "channel": "used",
        })
    for value in node.values():
        if isinstance(value, (list, dict)):
            found.extend(quotes_from_used(value, brand, context))
    return found


def fetch_sale_quotes():
    notice = post_json("/user/getNotice", {"typeName": "saleBrandList"})
    brands = [item.strip() for item in notice.split(",") if item.strip()]
    searches = [(brand, brand) for brand in brands]
    if "苹果" in brands:
        searches.append(("苹果", "iPhone"))
    quotes = []
    seen = set()
    for brand, keyword in searches:
        body = post_json("/sale/getPriceDetail", {"search": encrypt_hex(keyword)})
        if not body:
            continue
        rows = json.loads(body)
        if not isinstance(rows, list):
            continue
        for row in rows:
            row_brand = str(row.get("brandName") or brand).strip()
            model_name = clean_model_name(row.get("typeName") or "")
            for item in row.get("priceList") or []:
                goods_id = str(item.get("goodsId") or "").strip()
                color = str(item.get("color") or "").strip()
                dedupe = goods_id or f"{row_brand}|{model_name}|{color}"
                if dedupe in seen:
                    continue
                seen.add(dedupe)
                quotes.append({
                    "brand": row_brand,
                    "model_name": model_name,
                    "variant": color,
                    "price": item.get("price"),
                    "goods_id": goods_id,
                    "channel": "sale",
                })
    return quotes


def fetch_model_price():
    probes = [
        {"brand": "iPhone", "model": "iPhone 15"},
        {"brand": "苹果", "model": "iPhone 17"},
        {"brand": "苹果", "model": "苹果 iPhone 14"},
    ]
    results = []
    for payload in probes:
        body = post_json("/usedGood/getModelPrice", payload)
        results.append({"request": payload, "body": body})
        if body:
            return results
    return results


def register_target(catalog, category, model_name, bucket):
    keys = []
    for text in (model_name, strip_brand(model_name), bucket["object_name"], strip_brand(bucket["object_name"])):
        key = normalize_key(text)
        if key and key not in keys:
            keys.append(key)
    for item_category in candidate_categories(category):
        for key in keys:
            catalog.setdefault((item_category, key), bucket)


def ensure_object(conn, categories, catalog, category, model_name, dry_run):
    object_name = display_object_name(category, model_name)
    existing = lookup_target(catalog, category, object_name)
    if existing:
        return existing, False
    category_id = categories.get(category)
    if not category_id:
        return None, False
    if not dry_run:
        conn.execute(
            """
            INSERT OR IGNORE INTO objects (category_id, name, created_at, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (category_id, object_name),
        )
        row = conn.execute(
            """
            SELECT id, COALESCE(is_archived, 0)
            FROM objects
            WHERE category_id = ? AND name = ?
            """,
            (category_id, object_name),
        ).fetchone()
        if not row or int(row[1]) == 1:
            return None, False
        object_id = row[0]
    else:
        object_id = None
    bucket = {
        "category": category,
        "object_id": object_id,
        "object_name": object_name,
        "variants": {},
    }
    register_target(catalog, category, model_name, bucket)
    return bucket, True


def ensure_variant(conn, target, variant_name, category):
    if not variant_name:
        return ""
    if variant_name in target["variants"]:
        return variant_name
    if category in CURATED_CATEGORIES or not target.get("object_id"):
        return variant_name
    conn.execute(
        """
        INSERT OR IGNORE INTO variants (object_id, name, created_at, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        (target["object_id"], variant_name),
    )
    target["variants"][variant_name] = None
    return variant_name


def upsert_mapping(conn, quote, target, variant_name, now):
    if not quote.get("goods_id"):
        return
    meta = json.dumps({
        "brand": quote.get("brand"),
        "channel": quote.get("channel"),
        "model_name": quote.get("model_name"),
    }, ensure_ascii=False)
    conn.execute(
        """
        INSERT INTO source_mappings (
          source_key, source_name, external_key, external_name, external_meta_json,
          category_id, object_id, variant_id, category_name, object_name, variant_name,
          status, last_seen_at, last_matched_at, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'enabled', ?, ?, ?, ?, ?)
        ON CONFLICT(source_key, external_key) DO UPDATE SET
          external_name = excluded.external_name,
          external_meta_json = excluded.external_meta_json,
          category_id = excluded.category_id,
          object_id = excluded.object_id,
          category_name = excluded.category_name,
          object_name = excluded.object_name,
          variant_name = excluded.variant_name,
          last_seen_at = excluded.last_seen_at,
          last_matched_at = excluded.last_matched_at,
          updated_at = excluded.updated_at
        """,
        (
            SOURCE_KEY,
            SOURCE_NAME,
            quote["goods_id"],
            f"{target['object_name']} {variant_name}".strip(),
            meta,
            None,
            target["object_id"],
            target["category"],
            target["object_name"],
            variant_name,
            now,
            now,
            "小鸽 goodsId",
            now,
            now,
        ),
    )


def write_price(conn, target, variant_name, price, price_date, channel, prefer, now, dry_run):
    note = "小鸽二手成色价" if channel == "used" else "小鸽销售报价板。近两天已有其它来源时不覆盖"
    fresh_since = (datetime.strptime(price_date, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    existing = conn.execute(
        """
        SELECT id, price, source, date
        FROM price_records
        WHERE category = ?
          AND object_name = ?
          AND COALESCE(variant, '') = ?
          AND date >= ?
        ORDER BY date DESC, id DESC
        LIMIT 1
        """,
        (target["category"], target["object_name"], variant_name, fresh_since),
    ).fetchone()
    if existing is None:
        if dry_run:
            return "insert"
        conn.execute(
            """
            INSERT INTO price_records
              (date, category, object_name, variant, price, source, note, price_kind, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'market_reference', ?, ?)
            """,
            (
                price_date,
                target["category"],
                target["object_name"],
                variant_name,
                price,
                SOURCE_NAME,
                note,
                now,
                now,
            ),
        )
        return "insert"
    record_id, old_price, old_source, _existing_date = existing
    if old_source != SOURCE_NAME and not prefer:
        return "kept_other_source"
    if float(old_price) == float(price) and old_source == SOURCE_NAME:
        return "skip"
    if dry_run:
        return "update"
    conn.execute(
        """
        UPDATE price_records
        SET price = ?, source = ?, note = ?, price_kind = 'market_reference', updated_at = ?
        WHERE id = ?
        """,
        (price, SOURCE_NAME, note, now, record_id),
    )
    return "update"


def collect_records(catalog, categories, quotes, conn, prefer, price_date, dry_run):
    now = datetime.now().isoformat(timespec="seconds")
    counts = {
        "insert": 0,
        "update": 0,
        "skip": 0,
        "kept_other_source": 0,
        "created_objects": 0,
        "created_variants": 0,
        "unmatched": 0,
        "skipped_accessory": 0,
    }
    preview = []
    for quote in quotes:
        category = resolve_category(quote.get("brand"), quote.get("model_name"))
        if not category or category not in categories:
            counts["unmatched"] += 1
            continue
        model_name = clean_model_name(quote.get("model_name"))
        if len(model_name) < 2:
            counts["unmatched"] += 1
            continue
        try:
            price = normalize_price(quote.get("price"))
        except (TypeError, ValueError):
            counts["unmatched"] += 1
            continue
        variant_name = str(quote.get("variant") or "").strip()
        if is_accessory(model_name):
            counts["skipped_accessory"] += 1
            continue
        target = lookup_target(catalog, category, model_name)
        created_object = False
        if target is None:
            target, created_object = ensure_object(
                conn, categories, catalog, category, model_name, dry_run
            )
            if target is None:
                counts["unmatched"] += 1
                continue
        if created_object:
            counts["created_objects"] += 1
        had_variant = variant_name in target["variants"] or not variant_name
        if dry_run:
            resolved_variant = variant_name
            if variant_name and not had_variant:
                counts["created_variants"] += 1
                target["variants"][variant_name] = None
        else:
            before = set(target["variants"])
            resolved_variant = ensure_variant(conn, target, variant_name, target["category"])
            if variant_name and not resolved_variant:
                counts["unmatched"] += 1
                continue
            if variant_name and variant_name not in before:
                counts["created_variants"] += 1
            if quote.get("goods_id") and target.get("object_id"):
                upsert_mapping(conn, quote, target, resolved_variant, now)
        action = write_price(
            conn,
            target,
            resolved_variant,
            price,
            price_date,
            quote.get("channel"),
            prefer,
            now,
            dry_run,
        )
        counts[action] = counts.get(action, 0) + 1
        if len(preview) < 12:
            preview.append({
                "action": action,
                "category": target["category"],
                "object": target["object_name"],
                "variant": resolved_variant,
                "price": price,
                "channel": quote.get("channel"),
                "goods_id": quote.get("goods_id"),
            })
    return counts, preview


def archive_unpriced(conn):
    accessory_clause = " OR ".join("o.name LIKE ?" for _ in ACCESSORY_KEYWORDS)
    accessory_params = [f"%{keyword}%" for keyword in ACCESSORY_KEYWORDS]
    accessory_ids = [
        row[0]
        for row in conn.execute(
            f"""
            SELECT o.id
            FROM objects o
            JOIN categories c ON c.id = o.category_id
            LEFT JOIN (
              SELECT category, object_name, MAX(date) AS last_price
              FROM price_records
              GROUP BY category, object_name
            ) pr ON pr.category = c.name AND pr.object_name = o.name
            WHERE COALESCE(o.is_archived, 0) = 0
              AND (pr.last_price IS NULL OR pr.last_price < date('now', ?))
              AND ({accessory_clause})
            """,
            (f"-{ACCESSORY_STALE_DAYS} day", *accessory_params),
        )
    ]
    stale_ids = [
        row[0]
        for row in conn.execute(
            """
            SELECT DISTINCT o.id
            FROM objects o
            JOIN source_mappings sm
              ON sm.object_id = o.id
             AND sm.source_key = ?
            LEFT JOIN (
              SELECT category, object_name, MAX(date) AS last_price
              FROM price_records
              GROUP BY category, object_name
            ) pr ON pr.category = sm.category_name AND pr.object_name = o.name
            WHERE COALESCE(o.is_archived, 0) = 0
              AND date(o.created_at) <= date('now', ?)
              AND (pr.last_price IS NULL OR pr.last_price < date('now', ?))
            """,
            (SOURCE_KEY, f"-{XIAOGE_STALE_DAYS} day", f"-{XIAOGE_STALE_DAYS} day"),
        )
    ]
    object_ids = sorted(set(accessory_ids) | set(stale_ids))
    if not object_ids:
        return 0
    placeholders = ",".join("?" for _ in object_ids)
    conn.execute(
        f"""
        UPDATE objects
        SET is_archived = 1,
            archived_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id IN ({placeholders})
        """,
        object_ids,
    )
    conn.execute(
        f"""
        UPDATE variants
        SET is_archived = 1,
            archived_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE COALESCE(is_archived, 0) = 0
          AND object_id IN ({placeholders})
        """,
        object_ids,
    )
    return len(object_ids)


def run(db_path, dry_run, prefer):
    categories, catalog = load_catalog(db_path)
    brands, used_plain, used_quotes = fetch_used_price_lists()
    sale_quotes = fetch_sale_quotes()
    model_price = fetch_model_price()
    price_date = datetime.now().strftime("%Y-%m-%d")
    quotes = used_quotes + sale_quotes
    conn = sqlite3.connect(db_path)
    try:
        counts, preview = collect_records(
            catalog, categories, quotes, conn, prefer, price_date, dry_run
        )
        archived_count = 0 if dry_run else archive_unpriced(conn)
        if dry_run:
            conn.rollback()
        else:
            conn.commit()
    finally:
        conn.close()

    used_nonempty = {brand: text[:180] for brand, text in used_plain.items() if text}
    message = (
        f"小鸽报价完成：新增 {counts.get('insert', 0)}，更新 {counts.get('update', 0)}，"
        f"保留其它来源 {counts.get('kept_other_source', 0)}，"
        f"新建对象 {counts.get('created_objects', 0)}，新建变体 {counts.get('created_variants', 0)}，"
        f"跳过配件 {counts.get('skipped_accessory', 0)}，归档长期无价 {archived_count}，"
        f"未匹配 {counts.get('unmatched', 0)}。"
        f"二手成色接口 {len(brands)} 个品牌解密后"
        + (f"有数据 {len(used_nonempty)} 个" if used_nonempty else "全部为空，价格来自销售报价板")
    )
    print(json.dumps({
        "success": True,
        "source_key": SOURCE_KEY,
        "message": message,
        "inserted_count": counts.get("insert", 0),
        "updated_count": counts.get("update", 0),
        "skipped_count": counts.get("skip", 0) + counts.get("kept_other_source", 0),
        "matched_count": counts.get("insert", 0) + counts.get("update", 0) + counts.get("skip", 0) + counts.get("kept_other_source", 0),
        "source_count": len(quotes),
        "used_brand_count": len(brands),
        "used_quote_count": len(used_quotes),
        "sale_quote_count": len(sale_quotes),
        "used_price_plaintext": used_nonempty or {brand: "" for brand in brands[:3]},
        "model_price": model_price,
        "created_object_count": counts.get("created_objects", 0),
        "created_variant_count": counts.get("created_variants", 0),
        "archived_count": archived_count,
        "skipped_accessory_count": counts.get("skipped_accessory", 0),
        "records": preview,
    }, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description="拉取小鸽手机回收报价并写入已有品类")
    parser.add_argument("--db", default=DEFAULT_DB_PATH)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--prefer", action="store_true", help="同一天已有其它来源时改写为小鸽价格")
    args = parser.parse_args()
    db_path = Path(args.db)
    if not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")
    run(str(db_path), args.dry_run, args.prefer)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        raise
