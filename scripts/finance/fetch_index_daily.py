#!/usr/bin/env python3
import sys
import json
import warnings
from datetime import datetime, timedelta

# 忽略urllib3警告
warnings.filterwarnings('ignore')

def generateMockData():
    """生成模拟的沪深300日线数据"""
    data = []
    today = datetime.now()
    
    for i in range(120):
        date = today - timedelta(days=i)
        trade_date = date.strftime("%Y-%m-%d")
        base_close = 3900 + (i % 60 - 30) * 5 + (i % 10) * 2
        
        data.append({
            "trade_date": trade_date,
            "open": round(base_close + (i % 5 - 2) * 3, 2),
            "high": round(base_close + 10 + (i % 3), 2),
            "low": round(base_close - 10 - (i % 3), 2),
            "close": round(base_close, 2),
            "volume": float(123456789 + i * 100000),
            "amount": float(12345678900 + i * 10000000)
        })
    
    data.sort(key=lambda x: x["trade_date"])
    return data

def fetch_real_data(symbol):
    """使用AKShare获取真实数据"""
    try:
        import akshare as ak

        index_symbol_map = {
            "000300": "sh000300",
            "000905": "sh000905",
            "399006": "sz399006",
            "000688": "sh000688",
        }

        if symbol in index_symbol_map:
            df = ak.stock_zh_index_daily(symbol=index_symbol_map[symbol])
            result = []
            for _, row in df.iterrows():
                result.append({
                    "trade_date": str(row["date"]),
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "volume": float(row["volume"]),
                    "amount": float(row["volume"] * row["close"] * 100)
                })
        else:
            df = ak.fund_etf_hist_em(symbol=symbol, period="daily", adjust="")
            result = []
            for _, row in df.iterrows():
                result.append({
                    "trade_date": str(row["日期"]),
                    "open": float(row["开盘"]),
                    "high": float(row["最高"]),
                    "low": float(row["最低"]),
                    "close": float(row["收盘"]),
                    "volume": float(row.get("成交量", 0) or 0),
                    "amount": float(row.get("成交额", 0) or 0)
                })
        
        result.sort(key=lambda x: x["trade_date"])
        return result
    
    except Exception as e:
        raise RuntimeError(f"AKShare fetch failed: {str(e)}")

def fetch_index_daily(symbol, use_mock=False):
    try:
        if use_mock:
            result = {
                "data": generateMockData(),
                "source": "mock",
                "is_mock": True
            }
        else:
            data = fetch_real_data(symbol)
            result = {
                "data": data,
                "source": "akshare",
                "is_mock": False
            }
        
        print(json.dumps(result))
        
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    symbol = "000300"
    use_mock = False
    
    for arg in sys.argv[1:]:
        if arg == "--mock":
            use_mock = True
        else:
            symbol = arg
    
    fetch_index_daily(symbol, use_mock)
