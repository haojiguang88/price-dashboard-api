#!/usr/bin/env python3
import os
import sys
import json
import requests
import argparse

def fetch_metal_daily(symbol, source):
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
            items.append({
                "trade_date": item['datetime'],
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

def main():
    parser = argparse.ArgumentParser(description='Fetch metal daily data from Twelve Data')
    parser.add_argument('symbol', type=str, help='Metal symbol (XAUUSD or XAGUSD)')
    parser.add_argument('--source', type=str, required=True, help='Data source')
    
    args = parser.parse_args()
    
    result = fetch_metal_daily(args.symbol, args.source)
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()