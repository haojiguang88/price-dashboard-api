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

def normalize_date_arg(value, default_value):
    if not value:
        return default_value
    cleaned = str(value).strip().replace("-", "")
    if len(cleaned) != 8 or not cleaned.isdigit():
        raise ValueError(f"日期格式无效: {value}")
    return cleaned

def format_trade_date(value):
    return f"{value[:4]}-{value[4:6]}-{value[6:]}"

def filter_by_trade_date(df, start_date, end_date):
    if df is None or df.empty or "trade_date" not in df.columns:
        return df
    start_iso = format_trade_date(start_date)
    end_iso = format_trade_date(end_date)
    df["trade_date"] = df["trade_date"].astype(str).str.slice(0, 10)
    return df[(df["trade_date"] >= start_iso) & (df["trade_date"] <= end_iso)]

def fetch_with_tushare(symbol: str, asset_type: str, start_date=None, end_date=None):
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
        query_start = normalize_date_arg(start_date, "20000101")
        query_end = normalize_date_arg(end_date, today)
        name = ""
        
        if asset_type == 'stock':
            df = ts.pro_bar(
                ts_code=ts_code,
                adj="qfq",
                freq="D",
                start_date=query_start,
                end_date=query_end
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
                start_date=query_start,
                end_date=query_end
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
                start_date=query_start,
                end_date=query_end
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
            "requested_start_date": format_trade_date(query_start),
            "requested_end_date": format_trade_date(query_end),
            "items": items
        }
        
    except Exception as e:
        return {"success": False, "message": f"Tushare 拉取失败: {str(e)}"}

def fetch_with_akshare(symbol: str, asset_type: str, start_date=None, end_date=None):
    """Fetch data using AKShare."""
    try:
        import akshare as ak
    except ImportError as e:
        return {"success": False, "message": f"AKShare模块未安装: {str(e)}"}
    
    try:
        today = datetime.now().strftime('%Y%m%d')
        query_start = normalize_date_arg(start_date, "20000101")
        query_end = normalize_date_arg(end_date, today)

        if asset_type == 'stock':
            df = ak.stock_zh_a_hist(symbol=symbol, period="daily", start_date=query_start, end_date=query_end, adjust="qfq")
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
            df = ak.stock_zh_a_hist(symbol=symbol, period="daily", start_date=query_start, end_date=query_end, adjust="qfq")
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
        df = filter_by_trade_date(df, query_start, query_end)
        items = df[['trade_date', 'open', 'high', 'low', 'close', 'volume', 'amount']].to_dict('records')
        
        return {
            "success": True,
            "symbol": symbol,
            "name": name,
            "asset_type": asset_type,
            "source": "akshare",
            "is_mock": False,
            "requested_start_date": format_trade_date(query_start),
            "requested_end_date": format_trade_date(query_end),
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
    parser.add_argument('--start-date', help='Start date, YYYYMMDD or YYYY-MM-DD')
    parser.add_argument('--end-date', help='End date, YYYYMMDD or YYYY-MM-DD')
    parser.add_argument('--mock', action='store_true', help='Generate mock data')
    
    args = parser.parse_args()
    
    if args.mock:
        result = generate_mock_data(args.symbol, args.asset_type)
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0)
    
    try:
        if args.source == 'tushare':
            result = fetch_with_tushare(args.symbol, args.asset_type, args.start_date, args.end_date)
        else:
            result = fetch_with_akshare(args.symbol, args.asset_type, args.start_date, args.end_date)
    except ValueError as e:
        result = {"success": False, "message": str(e)}
    
    print(json.dumps(sanitize_for_json(result), ensure_ascii=False, allow_nan=False))
    sys.exit(0 if result.get('success') else 1)

if __name__ == '__main__':
    main()
