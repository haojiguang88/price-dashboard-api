#!/usr/bin/env python3
import os
import sys
import json
import requests
import argparse
import math
from datetime import datetime

def to_json_number(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None

def format_tushare_date(value):
    text = str(value or "").strip()
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:]}"
    return text[:10]

def is_weekend_trade_date(value):
    text = format_tushare_date(value)
    try:
        return datetime.strptime(text, "%Y-%m-%d").weekday() >= 5
    except (TypeError, ValueError):
        return False

def fetch_twelvedata_metal_daily(symbol, source):
    api_key = os.getenv('TWELVE_DATA_API_KEY')
    
    if not api_key:
        return {
            "success": False,
            "message": "TWELVE_DATA_API_KEY 未配置"
        }
    
    if symbol == "XAUUSD":
        tw_symbol = "XAU/USD"
        name = "Gold Spot"
    elif symbol == "XAGUSD":
        return {
            "success": False,
            "message": "当前数据源权限不足，XAGUSD 暂不可用"
        }
    else:
        return {
            "success": False,
            "message": f"不支持的标的: {symbol}"
        }
    
    try:
        url = f"https://api.twelvedata.com/time_series"
        params = {
            "symbol": tw_symbol,
            "interval": "1day",
            "apikey": api_key,
            "outputsize": 5000,
            "format": "JSON"
        }
        
        response = requests.get(url, params=params, timeout=30)
        response.raise_for_status()
        
        data = response.json()
        
        if 'values' not in data:
            return {
                "success": False,
                "message": f"Twelve Data 返回格式异常: {data}"
            }
        
        items = []
        for item in data['values']:
            trade_date = item['datetime']
            if is_weekend_trade_date(trade_date):
                continue
            items.append({
                "trade_date": trade_date,
                "open": float(item['open']),
                "high": float(item['high']),
                "low": float(item['low']),
                "close": float(item['close']),
                "volume": None,
                "amount": None
            })
        
        items.sort(key=lambda x: x['trade_date'])
        
        return {
            "success": True,
            "symbol": symbol,
            "name": name,
            "asset_type": "metal_anchor",
            "source": source,
            "items": items
        }
    
    except requests.exceptions.RequestException as e:
        return {
            "success": False,
            "message": f"Twelve Data 拉取失败: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"处理数据失败: {str(e)}"
        }

def fetch_tushare_sge_daily(symbol, source):
    token = os.getenv('TUSHARE_TOKEN')
    if not token:
        return {
            "success": False,
            "message": "TUSHARE_TOKEN 未配置"
        }

    try:
        import tushare as ts
    except ImportError as e:
        return {
            "success": False,
            "message": f"Tushare模块未安装: {str(e)}"
        }

    symbol_map = {
        "SGE_AGTD": {
            "ts_code": "Ag(T+D)",
            "name": "白银延期 Ag(T+D)",
            "start_date": "20061030"
        },
        # Backward-compatible alias: the UI uses SGE_AGTD to avoid implying USD spot,
        # but manual callers may still ask for XAGUSD from the old placeholder.
        "XAGUSD": {
            "ts_code": "Ag(T+D)",
            "name": "白银延期 Ag(T+D)",
            "start_date": "20061030"
        }
    }

    config = symbol_map.get(symbol)
    if not config:
        return {
            "success": False,
            "message": f"Tushare SGE 暂不支持的标的: {symbol}"
        }

    try:
        pro = ts.pro_api(token)
        today = datetime.now().strftime('%Y%m%d')
        df = pro.sge_daily(
            ts_code=config["ts_code"],
            start_date=config["start_date"],
            end_date=today
        )

        if df is None or df.empty:
            return {
                "success": False,
                "message": f"Tushare SGE {config['ts_code']} 返回数据为空"
            }

        items = []
        for item in df.to_dict('records'):
            trade_date = format_tushare_date(item.get("trade_date"))
            if is_weekend_trade_date(trade_date):
                continue
            close = to_json_number(item.get("close"))
            open_price = to_json_number(item.get("open")) or close
            high = to_json_number(item.get("high")) or close
            low = to_json_number(item.get("low")) or close
            if close is None:
                continue
            items.append({
                "trade_date": trade_date,
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
                "volume": to_json_number(item.get("vol")),
                "amount": to_json_number(item.get("amount"))
            })

        items.sort(key=lambda x: x['trade_date'])

        return {
            "success": True,
            "symbol": symbol,
            "ts_code": config["ts_code"],
            "name": config["name"],
            "asset_type": "metal_anchor",
            "source": source,
            "items": items
        }

    except Exception as e:
        return {
            "success": False,
            "message": f"Tushare SGE 拉取失败: {str(e)}"
        }

def fetch_metal_daily(symbol, source):
    if source == "twelvedata":
        return fetch_twelvedata_metal_daily(symbol, source)
    if source == "tushare_sge":
        return fetch_tushare_sge_daily(symbol, source)
    return {
        "success": False,
        "message": f"不支持的数据源: {source}"
    }

def main():
    parser = argparse.ArgumentParser(description='Fetch metal daily data')
    parser.add_argument('symbol', type=str, help='Metal symbol (XAUUSD or SGE_AGTD)')
    parser.add_argument('--source', type=str, required=True, help='Data source')
    
    args = parser.parse_args()
    
    result = fetch_metal_daily(args.symbol, args.source)
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
