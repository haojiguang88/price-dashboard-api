#!/usr/bin/env python3
"""小鸽手机回收报价。

只写入回收报价板 /purchase/getRecoveryList。请求 brand 与响应都用微信用户密钥
（wx.getUserCryptoManager().getLatestUserKey() 下发的 encryptKey/iv）做 AES-CBC，
密钥按 UTF-8 原文当 key/iv 用（key 是 24 字节 -> AES-192），响应是 Base64。
密钥有时效（约几十分钟），由 Mac 上挂着小程序的抓取器写入 key 文件，
本脚本只读文件不自己取钥匙。没有解析出回收价时任务直接失败。

旧接口 /usedGood/getPriceList 服务端已关闭（恒定返回空密文），不再调用。
不调用 /sale/getPriceDetail。

回填：/purchase/getHisPrice 返回单个 goodsId 近 7 天的回收价历史（响应明文 JSON，
不需要用户密钥），goodsId 用 App 内置静态 aesKey 做 AES-128-CBC 加密。
--backfill YYYY-MM-DD 按 source_mappings 里已匹配的 goodsId 逐条取历史价补写。
"""
import argparse
import base64
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests
from Cryptodome.Cipher import AES
from Cryptodome.Util.Padding import pad, unpad

SOURCE_KEY = "xiaoge_phone"
SOURCE_NAME = "小鸽手机回收"
BASE_URL = "https://wechat.sanmicun.com"
DEFAULT_DB_PATH = (
    os.environ.get("BUSINESS_DB_PATH")
    or str(Path(__file__).resolve().parents[2] / "data" / "price_dashboard_business.db")
)
USERKEY_FILE = (
    os.environ.get("XIAOGE_USERKEY_FILE")
    or str(Path(__file__).resolve().parents[2] / "secrets" / "xiaoge_userkey.json")
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
STATIC_AES_KEY = b"1HA1ar(154idvo!@"
STATIC_AES_IV = b"!@vo(1arA154GHid"
DEFAULT_OPENID = "o65BF5YPe4XO_EXLSB3yrwSXcL78"
BACKFILL_SLEEP_SECONDS = 0.1


def load_userkey(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise RuntimeError(f"小鸽 userKey 文件不存在：{path}（需要 Mac 上的小程序抓取器先写入）")
    key = str(data.get("key") or "").encode("utf-8")
    iv = str(data.get("iv") or "").encode("utf-8")
    openid = str(data.get("openid") or "").strip()
    if len(key) not in (16, 24, 32) or len(iv) != 16 or not openid:
        raise RuntimeError(f"小鸽 userKey 文件内容不完整：{path}")
    return key, iv, openid, int(data.get("expireTime") or 0)


def userkey_encrypt_hex(text, key, iv):
    cipher = AES.new(key, AES.MODE_CBC, iv)
    return cipher.encrypt(pad(str(text).encode("utf-8"), 16)).hex()


def userkey_decrypt_base64(text, key, iv):
    raw = text.strip().strip('"')
    if not raw:
        return ""
    cipher = AES.new(key, AES.MODE_CBC, iv)
    return unpad(cipher.decrypt(base64.b64decode(raw)), 16).decode("utf-8")


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


def fetch_history_price(goods_id, openid=DEFAULT_OPENID):
    body = post_json("/purchase/getHisPrice", {
        "goodsId": userkey_encrypt_hex(goods_id, STATIC_AES_KEY, STATIC_AES_IV),
        "openid": openid,
        "agentId": 10,
    })
    if not body or body == "null":
        return []
    try:
        data = json.loads(body)
    except ValueError:
        return []
    return data if isinstance(data, list) else []


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


# 小鸽销售板用的颜色名。库里已经有规范名时并进去，避免再开一个变体把销售价当成当前价。
APPLE_COLOR_ALIASES = {
    "星宇橙色": "橙色",
}


def canonical_variant_name(variant_name, existing_names):
    alias = APPLE_COLOR_ALIASES.get(str(variant_name or "").strip())
    if alias and alias in existing_names:
        return alias
    return str(variant_name or "").strip()


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


def fetch_recovery_price_lists():
    key, iv, openid, expire_ms = load_userkey(USERKEY_FILE)
    notice = post_json("/user/getNotice", {"typeName": "topBrandListNew"})
    brands = [item.strip() for item in notice.split(",") if item.strip()]
    plaintext_by_brand = {}
    quotes = []
    for brand in brands:
        body = post_json("/purchase/getRecoveryList", {
            "brand": userkey_encrypt_hex(brand, key, iv),
            "openid": openid,
            "agentId": 10,
        })
        plain = ""
        if body and body != "null":
            try:
                plain = userkey_decrypt_base64(body, key, iv)
            except (ValueError, KeyError):
                plain = ""
        plaintext_by_brand[brand] = plain
        if not plain:
            continue
        quotes.extend(quotes_from_recovery(json.loads(plain), brand))
    return brands, plaintext_by_brand, quotes, expire_ms


def quotes_from_recovery(payload, brand):
    found = []
    if not isinstance(payload, list):
        return found
    for series in payload:
        if not isinstance(series, dict):
            continue
        for model in series.get("values") or []:
            if not isinstance(model, dict):
                continue
            model_name = clean_model_name(model.get("name"))
            if not model_name:
                model_name = " ".join(
                    part for part in (model.get("typeClass"), model.get("type")) if part
                ).strip()
            if not model_name:
                continue
            for sku in model.get("values") or []:
                if not isinstance(sku, dict):
                    continue
                price = sku.get("price")
                if price in (None, ""):
                    continue
                found.append({
                    "brand": sku.get("brandName") or brand,
                    "model_name": model_name,
                    "variant": str(sku.get("color") or "").strip(),
                    "price": price,
                    "goods_id": str(sku.get("goodsId") or ""),
                    "channel": "used",
                })
    return found


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
    if channel != "used":
        raise RuntimeError(f"小鸽只写入回收价，拒绝渠道 {channel}")
    note = "小鸽回收报价"
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
        variant_name = canonical_variant_name(variant_name, target["variants"])
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
    brands, used_plain, used_quotes, expire_ms = fetch_recovery_price_lists()
    if not used_quotes:
        nonempty = sum(1 for text in used_plain.values() if str(text or "").strip())
        detail = f"有正文 {nonempty} 个，但没有解析出回收价" if nonempty else "全部为空或解不开"
        expire_text = datetime.fromtimestamp(expire_ms / 1000).strftime("%m-%d %H:%M") if expire_ms else "未知"
        raise RuntimeError(
            f"小鸽没有回收价：回收报价接口 {len(brands)} 个品牌{detail}"
            f"（userKey 过期时间 {expire_text}，过期需先让 Mac 抓取器刷新）。已停止，不使用销售报价。"
        )
    price_date = datetime.now().strftime("%Y-%m-%d")
    quotes = used_quotes
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
        f"回收价 {len(used_quotes)} 条，回收报价接口 {len(brands)} 个品牌解密后有数据 {len(used_nonempty)} 个。"
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
        "used_price_plaintext": used_nonempty or {brand: "" for brand in brands[:3]},
        "created_object_count": counts.get("created_objects", 0),
        "created_variant_count": counts.get("created_variants", 0),
        "archived_count": archived_count,
        "skipped_accessory_count": counts.get("skipped_accessory", 0),
        "records": preview,
    }, ensure_ascii=False))


def write_price_backfill(conn, mapping, price, price_date, prefer, now, dry_run):
    existing = conn.execute(
        """
        SELECT id, price, source
        FROM price_records
        WHERE category = ?
          AND object_name = ?
          AND COALESCE(variant, '') = ?
          AND date = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (mapping["category_name"], mapping["object_name"], mapping["variant_name"] or "", price_date),
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
                mapping["category_name"],
                mapping["object_name"],
                mapping["variant_name"] or None,
                price,
                SOURCE_NAME,
                "小鸽回收报价（历史回填）",
                now,
                now,
            ),
        )
        return "insert"
    record_id, old_price, old_source = existing
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
        (price, SOURCE_NAME, "小鸽回收报价（历史回填）", now, record_id),
    )
    return "update"


def run_backfill(db_path, backfill_date, dry_run, prefer):
    try:
        target_mmdd = datetime.strptime(backfill_date, "%Y-%m-%d").strftime("%m-%d")
    except ValueError:
        raise RuntimeError(f"--backfill 日期格式应为 YYYY-MM-DD：{backfill_date}")
    conn = sqlite3.connect(db_path)
    try:
        mappings = [
            {"external_key": row[0], "category_name": row[1], "object_name": row[2], "variant_name": row[3]}
            for row in conn.execute(
                """
                SELECT external_key, category_name, object_name, COALESCE(variant_name, '')
                FROM source_mappings
                WHERE source_key = ? AND status = 'enabled' AND external_key != ''
                """,
                (SOURCE_KEY,),
            )
        ]
        if not mappings:
            raise RuntimeError("source_mappings 里没有小鸽映射，先跑一次正常采集")
        now = datetime.now().isoformat(timespec="seconds")
        counts = {"insert": 0, "update": 0, "skip": 0, "kept_other_source": 0, "no_history": 0, "bad_price": 0}
        preview = []
        for mapping in mappings:
            history = fetch_history_price(mapping["external_key"])
            entry = next((h for h in history if h.get("priceDate") == target_mmdd), None)
            if entry is None:
                counts["no_history"] += 1
                continue
            try:
                price = normalize_price(entry.get("recoveryPrice"))
            except (TypeError, ValueError):
                counts["bad_price"] += 1
                continue
            action = write_price_backfill(conn, mapping, price, backfill_date, prefer, now, dry_run)
            counts[action] = counts.get(action, 0) + 1
            if len(preview) < 12:
                preview.append({
                    "action": action,
                    "category": mapping["category_name"],
                    "object": mapping["object_name"],
                    "variant": mapping["variant_name"],
                    "price": price,
                    "goods_id": mapping["external_key"],
                })
            time.sleep(BACKFILL_SLEEP_SECONDS)
        if dry_run:
            conn.rollback()
        else:
            conn.commit()
    finally:
        conn.close()
    print(json.dumps({
        "success": True,
        "source_key": SOURCE_KEY,
        "message": (
            f"小鸽历史回填 {backfill_date} 完成：新增 {counts.get('insert', 0)}，"
            f"更新 {counts.get('update', 0)}，跳过 {counts.get('skip', 0)}，"
            f"保留其它来源 {counts.get('kept_other_source', 0)}，"
            f"无当日历史 {counts.get('no_history', 0)}，价格异常 {counts.get('bad_price', 0)}，"
            f"映射 {len(mappings)} 条。"
        ),
        "backfill_date": backfill_date,
        "inserted_count": counts.get("insert", 0),
        "updated_count": counts.get("update", 0),
        "skipped_count": counts.get("skip", 0) + counts.get("kept_other_source", 0),
        "no_history_count": counts.get("no_history", 0),
        "mapping_count": len(mappings),
        "records": preview,
    }, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description="拉取小鸽手机回收报价并写入已有品类")
    parser.add_argument("--db", default=DEFAULT_DB_PATH)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--prefer", action="store_true", help="同一天已有其它来源时改写为小鸽价格")
    parser.add_argument("--backfill", metavar="YYYY-MM-DD", help="按历史曲线回填指定日期（近 7 天内）")
    args = parser.parse_args()
    db_path = Path(args.db)
    if not db_path.exists():
        raise RuntimeError(f"数据库不存在：{db_path}")
    if args.backfill:
        run_backfill(str(db_path), args.backfill, args.dry_run, args.prefer)
    else:
        run(str(db_path), args.dry_run, args.prefer)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
