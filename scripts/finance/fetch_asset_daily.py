#!/usr/bin/env python3
import sys
import json
import argparse
import math
from datetime import datetime

def sanitize_for_json(value):
    """Convert non-standard numeric values to strict JSON-safe values."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: sanitize_for_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_for_json(item) for item in value]
    return value

def get_ts_code(symbol: str, asset_type: str) -> str:
    """Convert symbol to Tushare ts_code format."""
    symbol = str(symbol)
    
    if asset_type == 'stock':
        if symbol.startswith('920') or symbol.startswith('8') or symbol.startswith('4'):
            return f"{symbol}.BJ"
        if symbol.startswith('6') or symbol.startswith('688'):
            return f"{symbol}.SH"
        elif symbol.startswith('0') or symbol.startswith('1') or symbol.startswith('2') or symbol.startswith('3'):
            return f"{symbol}.SZ"
        else:
            return f"{symbol}.SH"
    elif asset_type == 'etf':
        if symbol.startswith('5'):
            return f"{symbol}.SH"
        elif symbol.startswith('1'):
            return f"{symbol}.SZ"
        else:
            return f"{symbol}.SH"
    elif asset_type == 'index':
        if symbol.startswith('399'):
            return f"{symbol}.SZ"
        else:
            return f"{symbol}.SH"
    else:
        return f"{symbol}.SH"

def fetch_with_tushare(symbol: str, asset_type: str):
    """Fetch data using Tushare."""
    try:
        import tushare as ts
    except ImportError as e:
        return {"success": False, "message": f"Tushare模块未安装: {str(e)}"}
    
    token = None
    try:
        import os
        token = os.environ.get('TUSHARE_TOKEN')
    except:
        pass
    
    if not token:
        return {"success": False, "message": "TUSHARE_TOKEN 未配置"}
    
    try:
        pro = ts.pro_api(token)
        ts_code = get_ts_code(symbol, asset_type)
        today = datetime.now().strftime('%Y%m%d')
        name = ""
        
        if asset_type == 'stock':
            df = ts.pro_bar(
                ts_code=ts_code,
                adj="qfq",
                freq="D",
                start_date="20000101",
                end_date=today
            )
            try:
                stock_info = pro.stock_basic(ts_code=ts_code)
                if not stock_info.empty:
                    name = stock_info['name'].values[0]
            except:
                pass
            if name == "":
                name = f"股票{symbol}"
            
        elif asset_type == 'etf':
            df = pro.fund_daily(
                ts_code=ts_code,
                start_date="20000101",
                end_date=today
            )
            try:
                fund_info = pro.fund_basic(ts_code=ts_code)
                if not fund_info.empty:
                    name = fund_info['name'].values[0]
            except:
                pass
            if name == "":
                name = f"ETF{symbol}"
                
        elif asset_type == 'index':
            df = pro.index_daily(
                ts_code=ts_code,
                start_date="20000101",
                end_date=today
            )
            try:
                index_info = pro.index_basic(ts_code=ts_code)
                if not index_info.empty:
                    name = index_info['name'].values[0]
            except:
                pass
            if name == "":
                name = f"指数{symbol}"
                
        else:
            return {"success": False, "message": f"不支持的资产类型: {asset_type}"}
        
        if df is None or df.empty:
            return {"success": False, "message": f"{asset_type} {symbol} 返回数据为空"}
        
        df['trade_date'] = df['trade_date'].astype(str)
        df['trade_date'] = df['trade_date'].apply(lambda x: f"{x[:4]}-{x[4:6]}-{x[6:]}")
        
        df = df.rename(columns={
            "vol": "volume"
        })
        
        df = df.sort_values('trade_date')
        
        items = df[['trade_date', 'open', 'high', 'low', 'close', 'volume', 'amount']].to_dict('records')
        
        return {
            "success": True,
            "symbol": symbol,
            "ts_code": ts_code,
            "name": name,
            "asset_type": asset_type,
            "source": "tushare",
            "is_mock": False,
            "items": items
        }
        
    except Exception as e:
        return {"success": False, "message": f"Tushare 拉取失败: {str(e)}"}

def fetch_with_akshare(symbol: str, asset_type: str):
    """Fetch data using AKShare."""
    try:
        import akshare as ak
    except ImportError as e:
        return {"success": False, "message": f"AKShare模块未安装: {str(e)}"}
    
    try:
        if asset_type == 'stock':
            df = ak.stock_zh_a_hist(symbol=symbol, period="daily", start_date="20000101", end_date="20991231", adjust="qfq")
            if df.empty:
                return {"success": False, "message": "股票数据为空"}
            
            df = df.rename(columns={
                "日期": "trade_date",
                "开盘": "open",
                "收盘": "close",
                "最高": "high",
                "最低": "low",
                "成交量": "volume",
                "成交额": "amount"
            })
            
            stock_info = ak.stock_zh_a_spot()
            stock_info = stock_info[stock_info['代码'] == symbol]
            name = stock_info['名称'].values[0] if not stock_info.empty else f"股票{symbol}"
            
        elif asset_type == 'etf':
            df = ak.stock_zh_a_hist(symbol=symbol, period="daily", start_date="20000101", end_date="20991231", adjust="qfq")
            if df.empty:
                return {"success": False, "message": "ETF数据为空"}
            
            df = df.rename(columns={
                "日期": "trade_date",
                "开盘": "open",
                "收盘": "close",
                "最高": "high",
                "最低": "low",
                "成交量": "volume",
                "成交额": "amount"
            })
            
            stock_info = ak.stock_zh_a_spot()
            stock_info = stock_info[stock_info['代码'] == symbol]
            name = stock_info['名称'].values[0] if not stock_info.empty else f"ETF{symbol}"
            
        elif asset_type == 'index':
            df = ak.stock_zh_index_daily(f"sh{symbol}" if not symbol.startswith('sh') else symbol)
            if df.empty:
                return {"success": False, "message": "指数数据为空"}
            
            df = df.rename(columns={
                "date": "trade_date",
                "volume": "volume"
            })
            
            name = f"指数{symbol}"
            
        else:
            return {"success": False, "message": f"不支持的资产类型: {asset_type}"}
        
        df['trade_date'] = df['trade_date'].astype(str)
        items = df[['trade_date', 'open', 'high', 'low', 'close', 'volume', 'amount']].to_dict('records')
        
        return {
            "success": True,
            "symbol": symbol,
            "name": name,
            "asset_type": asset_type,
            "source": "akshare",
            "is_mock": False,
            "items": items
        }
        
    except Exception as e:
        return {"success": False, "message": f"AKShare 拉取失败: {str(e)}"}

def generate_mock_data(symbol, asset_type):
    """Generate mock data for testing."""
    import random
    from datetime import datetime, timedelta
    
    items = []
    today = datetime.now()
    base_price = 5.0 if asset_type == 'etf' else 100.0
    
    for i in range(365):
        date = today - timedelta(days=i)
        if date.weekday() >= 5:
            continue
            
        change = random.uniform(-0.015, 0.02)
        base_price = max(base_price * (1 + change), base_price * 0.5)
        
        items.append({
            "trade_date": date.strftime("%Y-%m-%d"),
            "open": round(base_price * random.uniform(0.99, 1.01), 3),
            "high": round(base_price * random.uniform(1.0, 1.02), 3),
            "low": round(base_price * random.uniform(0.98, 1.0), 3),
            "close": round(base_price, 3),
            "volume": random.randint(1000000, 100000000),
            "amount": random.randint(10000000, 1000000000)
        })
    
    items = items[::-1]
    
    return {
        "success": True,
        "symbol": symbol,
        "name": f"Mock {asset_type} {symbol}",
        "asset_type": asset_type,
        "source": "mock",
        "is_mock": True,
        "items": items
    }

def main():
    parser = argparse.ArgumentParser(description='Fetch daily data for stocks, ETFs and indices')
    parser.add_argument('symbol', help='Symbol (6-digit code)')
    parser.add_argument('asset_type', choices=['stock', 'etf', 'index'], help='Asset type')
    parser.add_argument('--source', choices=['tushare', 'akshare'], default='tushare', help='Data source')
    parser.add_argument('--mock', action='store_true', help='Generate mock data')
    
    args = parser.parse_args()
    
    if args.mock:
        result = generate_mock_data(args.symbol, args.asset_type)
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0)
    
    if args.source == 'tushare':
        result = fetch_with_tushare(args.symbol, args.asset_type)
    else:
        result = fetch_with_akshare(args.symbol, args.asset_type)
    
    print(json.dumps(sanitize_for_json(result), ensure_ascii=False, allow_nan=False))
    sys.exit(0 if result.get('success') else 1)

if __name__ == '__main__':
    main()
