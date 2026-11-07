#!/usr/bin/env python3
"""Pull Qiandao app trade history for enabled qiandao_popmart mappings.

The app client takes a standard-product id, not the SPU id stored on the mapping.
That id is the productId on the public SPU page. Paging uses QD_OFFSET on a client
built with that environment variable; the stock binary only returns the first page.
"""
import argparse
import json
import os
import random
import sqlite3
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qiandao.import_trading_history import import_rows, load_rows
from qiandao_book import extract_nuxt_payload, revive_nuxt

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DB = os.environ.get("BUSINESS_DB_PATH") or str(ROOT / "data" / "price_dashboard_business_dev.db")
SPU_URL = "https://oia.qiandao.com/spu?id={spu_id}"


def load_token(path):
    text = Path(path).read_text(encoding="utf-8").strip()
    if text.startswith("{"):
        token = json.loads(text).get("token") or ""
    else:
        token = text
    token = token.strip()
    if token.lower().startswith("bearer "):
        return token
    if not token:
        raise RuntimeError(f"token 文件是空的：{path}")
    return "Bearer " + token


def load_mappings(db_path):
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT external_key, category_name, object_name, variant_name, external_name
            FROM source_mappings
            WHERE source_key = 'qiandao_popmart' AND status = 'enabled'
            ORDER BY category_name, object_name, variant_name
            """
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def product_ids_for(spu_id):
    try:
        proc = subprocess.run(
            ["curl", "-fsS", "-m", "40", "-A", "Mozilla/5.0", SPU_URL.format(spu_id=spu_id)],
            capture_output=True,
            text=True,
            timeout=50,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"公开页超时 {spu_id}") from exc
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"公开页拉取失败 {spu_id}")
    html = proc.stdout
    payload = extract_nuxt_payload(html)
    if not payload:
        return []
    memo = {}
    found = []

    def walk(node):
        if isinstance(node, dict):
            product_id = node.get("productId")
            node_spu = node.get("spuId")
            if product_id and str(node_spu or "") == str(spu_id):
                found.append(str(product_id))
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    for index, node in enumerate(payload):
        if isinstance(node, dict):
            walk(revive_nuxt(payload, index, memo))
    # Preserve order, drop duplicates.
    seen = []
    for item in found:
        if item not in seen and item != str(spu_id):
            seen.append(item)
    return seen


def fetch_page(client, token, product_id, offset):
    last_error = None
    for attempt in range(3):
        try:
            return fetch_page_once(client, token, product_id, offset)
        except RuntimeError as exc:
            last_error = exc
            if "6700001" in str(exc) or "滑块" in str(exc):
                raise
            time.sleep(2 + attempt)
    raise last_error


def fetch_page_once(client, token, product_id, offset):
    env = os.environ.copy()
    env["QD_OFFSET"] = str(offset)
    try:
        proc = subprocess.run(
            [client, token, product_id],
            capture_output=True,
            text=True,
            timeout=40,
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"成交接口超时 {product_id} offset={offset}") from exc
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or f"qdclient exit {proc.returncode}")
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    status = next((line for line in lines if "HTTP/" in line), "")
    body = next((line for line in reversed(lines) if line.startswith("{")), "")
    if "6700001" in body or "滑块" in body:
        raise RuntimeError(f"千岛风控，已停止：{product_id} offset={offset}")
    if "200" not in status:
        raise RuntimeError(f"{status or 'no status'} {body[:180]}")
    if not body:
        raise RuntimeError(f"空响应 {product_id} offset={offset}")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"响应不是 JSON {product_id}: {exc}") from exc
    if str(payload.get("code")) not in {"0", "200"}:
        raise RuntimeError(f"千岛返回 code={payload.get('code')} {payload.get('message')}")
    data = payload.get("data") or {}
    history = data.get("tradeHistory") or []
    return history, bool(data.get("hasMore"))


def checkpoint(path, items, report):
    Path(path).write_text(json.dumps({"items": items, "report": report}, ensure_ascii=False), encoding="utf-8")


def collect(args):
    token = load_token(args.token_file)
    mappings = load_mappings(args.db)
    known = load_known_keys(args.db) if args.until_known else set()
    items = []
    report = []
    done = set()
    out_path = Path(args.out)
    if args.resume and out_path.exists():
        previous = json.loads(out_path.read_text(encoding="utf-8"))
        report = [row for row in previous.get("report") or [] if not row.get("error")]
        done = {row["spu_id"] for row in report}
        items = [row for row in previous.get("items") or [] if str(row.get("spu_id")) in done]
    for mapping in mappings:
        spu_id = str(mapping["external_key"])
        if spu_id in done:
            continue
        try:
            product_ids = product_ids_for(spu_id)
        except RuntimeError as exc:
            report.append({
                "spu_id": spu_id,
                "name": mapping["external_name"],
                "product_ids": [],
                "trades": 0,
                "truncated": False,
                "error": str(exc),
            })
            checkpoint(args.out, items, report)
            print(str(exc), flush=True)
            continue
        entry = {
            "spu_id": spu_id,
            "name": mapping["external_name"],
            "product_ids": product_ids,
            "trades": 0,
            "truncated": False,
        }
        if not product_ids:
            entry["error"] = "公开页没有标品号"
            report.append(entry)
            checkpoint(args.out, items, report)
            continue
        for product_id in product_ids:
            offset = 0
            try:
                overlapped = False
                for _page in range(args.max_pages):
                    history, has_more = fetch_page(args.client, token, product_id, offset)
                    if not history:
                        break
                    fresh = []
                    for row in history:
                        if row.get("price") is None or not row.get("tradingTime"):
                            continue
                        key = trade_key(spu_id, row["tradingTime"], row["price"], row.get("userId"))
                        if key in known:
                            continue
                        known.add(key)
                        fresh.append(row)
                    for row in fresh:
                        append_trade(items, mapping, row)
                    entry["trades"] += len(fresh)
                    offset += len(history)
                    if fresh:
                        overlapped = False
                    elif args.until_known:
                        overlapped = True
                    if overlapped or not has_more:
                        break
                    time.sleep(args.interval)
                else:
                    if not overlapped:
                        entry["truncated"] = True
            except RuntimeError as exc:
                entry["error"] = str(exc)
                report.append(entry)
                checkpoint(args.out, items, report)
                print(entry["error"], flush=True)
                if "6700001" in entry["error"] or "滑块" in entry["error"]:
                    return items, report
                break
            time.sleep(args.interval)
        if entry.get("error"):
            continue
        report.append(entry)
        print(
            f"{mapping['category_name']} {mapping['object_name']} {mapping['variant_name'] or ''} "
            f"trades={entry['trades']} products={len(product_ids)}",
            flush=True,
        )
        checkpoint(args.out, items, report)
    return items, report


def norm_price(value):
    number = float(value)
    if number == int(number):
        return str(int(number))
    return str(number)


def trade_key(spu_id, trading_time, price, user_id):
    return (str(spu_id), str(trading_time), norm_price(price), str(user_id or ""))


def load_known_keys(db_path):
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            """
            SELECT external_id
            FROM market_trades
            WHERE source_key = 'qiandao_popmart'
            """
        )
        keys = set()
        for (external_id,) in rows:
            body = str(external_id or "")
            if body.startswith("qiandao:"):
                body = body[len("qiandao:") :]
            parts = body.split("|")
            if len(parts) < 6:
                continue
            spu_id, trading_time, price, _flag, buyer, seller = parts[:6]
            keys.add(trade_key(spu_id, trading_time, price, buyer or seller))
        return keys
    finally:
        conn.close()


def append_trade(items, mapping, row):
    items.append({
        "spu_id": str(mapping["external_key"]),
        "category": mapping["category_name"],
        "object_name": mapping["object_name"],
        "variant_name": mapping["variant_name"] or "",
        "tradingTime": row["tradingTime"],
        "tradingAmount": row["price"],
        "qty": int(row.get("amount") or 1),
        "userId": row.get("userId") or "",
        "isDealBySeller": bool(row.get("isDealBySeller")),
        "buyerName": "" if row.get("isDealBySeller") else (row.get("userId") or ""),
        "sellerName": (row.get("userId") or "") if row.get("isDealBySeller") else "",
    })


def pause(interval):
    time.sleep(interval + random.uniform(0, max(interval * 0.4, 1)))


def extend_history(args):
    token = load_token(args.token_file)
    previous = json.loads(Path(args.out).read_text(encoding="utf-8"))
    items = list(previous.get("items") or [])
    report = list(previous.get("report") or [])
    by_spu = {str(row["spu_id"]): row for row in report}
    counts = Counter(str(row["spu_id"]) for row in items)
    known = {
        trade_key(row["spu_id"], row["tradingTime"], row["tradingAmount"], row.get("userId"))
        for row in items
    }
    mappings = {
        str(row["external_key"]): row
        for row in load_mappings(args.db)
    }
    for entry in report:
        spu_id = str(entry["spu_id"])
        mapping = mappings.get(spu_id)
        if mapping is None or not entry.get("truncated"):
            continue
        if counts[spu_id] >= args.target:
            entry["truncated"] = False
            continue
        if "前方高能" in str(entry.get("name") or "") or "前方高能" in str(mapping["object_name"]):
            continue
        for product_id in entry.get("product_ids") or []:
            if counts[spu_id] >= args.target:
                break
            offset = 200
            known_pages = 0
            try:
                while counts[spu_id] < args.target:
                    history, has_more = fetch_page(args.client, token, product_id, offset)
                    if not history:
                        break
                    fresh = []
                    for row in history:
                        if row.get("price") is None or not row.get("tradingTime"):
                            continue
                        key = trade_key(spu_id, row["tradingTime"], row["price"], row.get("userId"))
                        if key in known:
                            continue
                        known.add(key)
                        fresh.append(row)
                    if not fresh:
                        known_pages += 1
                        offset += len(history)
                        if known_pages >= 4 or not has_more:
                            break
                        pause(args.interval)
                        continue
                    known_pages = 0
                    for row in fresh:
                        if counts[spu_id] >= args.target:
                            break
                        append_trade(items, mapping, row)
                        counts[spu_id] += 1
                        entry["trades"] = counts[spu_id]
                    offset += len(history)
                    print(
                        f"{mapping['object_name']} {mapping['variant_name'] or ''} "
                        f"{counts[spu_id]}/{args.target} offset={offset}",
                        flush=True,
                    )
                    if not has_more:
                        break
                    pause(args.interval)
            except RuntimeError as exc:
                entry["error"] = str(exc)
                checkpoint(args.out, items, report)
                print(entry["error"], flush=True)
                if "6700001" in entry["error"] or "滑块" in entry["error"]:
                    return items, report
                break
            pause(args.interval)
        entry["truncated"] = counts[spu_id] < args.target
        entry.pop("error", None)
        print(
            f"{mapping['category_name']} {mapping['object_name']} {mapping['variant_name'] or ''} "
            f"trades={counts[spu_id]}",
            flush=True,
        )
        checkpoint(args.out, items, report)
    return items, report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--client", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-pages", type=int, default=8)
    parser.add_argument("--interval", type=float, default=2)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--until-known", action="store_true")
    parser.add_argument("--extend", action="store_true")
    parser.add_argument("--target", type=int, default=700)
    args = parser.parse_args()
    if args.extend:
        items, report = extend_history(args)
    else:
        items, report = collect(args)
    payload = {"items": items, "report": report}
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    rows = load_rows(args.out)
    imported = import_rows(args.db, rows, args.dry_run)
    print(json.dumps({
        "mappings": len(report),
        "items": len(items),
        "imported": imported,
        "missing_product": sum(1 for item in report if item.get("error")),
        "truncated": sum(1 for item in report if item.get("truncated")),
        "dry_run": args.dry_run,
        "out": args.out,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
