#!/usr/bin/env python3
import os
import sys
import json
from datetime import datetime

def main():
    token = os.environ.get('TUSHARE_TOKEN')
    
    if not token:
        print(json.dumps({
            "success": False,
            "message": "TUSHARE_TOKEN 未配置"
        }))
        sys.exit(0)
    
    try:
        import tushare as ts
    except ImportError as e:
        print(json.dumps({
            "success": False,
            "message": f"Tushare模块未安装: {str(e)}"
        }))
        sys.exit(0)
    
    pro = ts.pro_api(token)
    today = datetime.now().strftime('%Y%m%d')
    
    results = []
    
    def test_pro_bar():
        try:
            df = ts.pro_bar(
                ts_code="600519.SH",
                adj="qfq",
                freq="D",
                start_date="20240101",
                end_date=today
            )
            if df is None or df.empty:
                return {
                    "api": "pro_bar_qfq",
                    "ts_code": "600519.SH",
                    "success": False,
                    "rows": 0,
                    "error": "返回数据为空"
                }
            return {
                "api": "pro_bar_qfq",
                "ts_code": "600519.SH",
                "success": True,
                "rows": len(df),
                "columns": df.columns.tolist()
            }
        except Exception as e:
            return {
                "api": "pro_bar_qfq",
                "ts_code": "600519.SH",
                "success": False,
                "rows": 0,
                "error": str(e)
            }
    
    def test_fund_daily():
        try:
            df = pro.fund_daily(
                ts_code="510300.SH",
                start_date="20240101",
                end_date=today
            )
            if df is None or df.empty:
                return {
                    "api": "fund_daily",
                    "ts_code": "510300.SH",
                    "success": False,
                    "rows": 0,
                    "error": "返回数据为空"
                }
            return {
                "api": "fund_daily",
                "ts_code": "510300.SH",
                "success": True,
                "rows": len(df),
                "columns": df.columns.tolist()
            }
        except Exception as e:
            return {
                "api": "fund_daily",
                "ts_code": "510300.SH",
                "success": False,
                "rows": 0,
                "error": str(e)
            }
    
    def test_index_daily():
        try:
            df = pro.index_daily(
                ts_code="000300.SH",
                start_date="20240101",
                end_date=today
            )
            if df is None or df.empty:
                return {
                    "api": "index_daily",
                    "ts_code": "000300.SH",
                    "success": False,
                    "rows": 0,
                    "error": "返回数据为空"
                }
            return {
                "api": "index_daily",
                "ts_code": "000300.SH",
                "success": True,
                "rows": len(df),
                "columns": df.columns.tolist()
            }
        except Exception as e:
            return {
                "api": "index_daily",
                "ts_code": "000300.SH",
                "success": False,
                "rows": 0,
                "error": str(e)
            }
    
    results.append(test_pro_bar())
    results.append(test_fund_daily())
    results.append(test_index_daily())
    
    all_success = all(r["success"] for r in results)
    
    print(json.dumps({
        "success": all_success,
        "token_loaded": True,
        "results": results
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
