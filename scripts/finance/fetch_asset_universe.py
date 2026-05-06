#!/usr/bin/env python3
import json
import os
import re
import sys


def classify_etf_universe_types(name: str, fund_type: str = ""):
    """Return all local universe tags for an ETF.

    full_etf is the coverage row. Other tags are strategy routing hints.
    """
    text = f"{name or ''} {fund_type or ''}".upper()
    tags = ["full_etf"]

    bond_cash_pattern = re.compile(
        r"货币|快线|现金(?!流)|债|国债|地债|政金|城投|信用债|可转债|短融|同业存单|存单"
    )
    commodity_pattern = re.compile(
        r"黄金ETF|上海金|金ETF|白银|豆粕|商品|原油|能源化工|有色期货"
    )
    cross_border_pattern = re.compile(
        r"QDII|纳指|纳斯达克|标普|德国|法国|日经|东证|恒生|港股|中概|海外|美国|亚太|东南亚|沙特|印度"
    )
    special_pattern = re.compile(r"LOF|封闭|REIT|REITS|基础设施|创新未来|定开")
    broad_pattern = re.compile(
        r"沪深300|中证500|中证1000|上证50|科创50|创业板ETF|创业板50|创业板综|深证100|深证50|A500|双创50|MSCI|中证A50|现金流|红利|低波|高股息|股息|价值|成长|质量"
    )
    industry_pattern = re.compile(
        r"半导体|芯片|人工智能|AI|云计算|软件|机器人|新能源|光伏|电力|电网|电池|储能|汽车|证券ETF|证券公司|证券龙头|券商|金融科技|银行|医疗|医药|创新药|生物科技|军工|航空|航天|卫星|消费|农业|农牧|畜牧|传媒|游戏|通信|电子|计算机|数字经济|数据|算力|5G|物联网|稀土|有色|有色金属|黄金股|钢铁|煤炭|油气|环保|绿电|绿色电力|公用事业|家电|食品|酒|白酒|旅游|地产|建材|机械|机床|高端装备|设备|材料"
    )

    is_bond_cash = bool(bond_cash_pattern.search(text))
    is_commodity = bool(commodity_pattern.search(text))
    is_cross_border = bool(cross_border_pattern.search(text))
    is_special = bool(special_pattern.search(text))

    if is_bond_cash:
        tags.append("bond_cash_etf")
    if is_commodity:
        tags.append("commodity_etf")
    if is_cross_border:
        tags.append("cross_border_etf")
    if is_special:
        tags.append("special_fund")
    if not is_bond_cash and not is_commodity and not is_cross_border and not is_special:
        if broad_pattern.search(text):
            tags.append("broad_etf")
        if industry_pattern.search(text):
            tags.append("industry_etf")

    return tags


def fetch_with_tushare(include_stock: bool, include_etf: bool):
    try:
        import tushare as ts
    except ImportError as e:
        return {"success": False, "message": f"Tushare模块未安装: {str(e)}"}

    token = os.environ.get("TUSHARE_TOKEN")
    if not token:
        return {"success": False, "message": "TUSHARE_TOKEN 未配置"}

    try:
        pro = ts.pro_api(token)
        items = []

        if include_stock:
            stock_df = pro.stock_basic(
                exchange="",
                list_status="L",
                fields="ts_code,symbol,name,market,list_date"
            )
            if stock_df is not None and not stock_df.empty:
                for row in stock_df.to_dict("records"):
                    symbol = str(row.get("symbol") or "").zfill(6)
                    if not symbol:
                        continue
                    items.append({
                        "symbol": symbol,
                        "name": row.get("name") or "",
                        "asset_type": "stock",
                        "universe_type": "full_stock",
                        "source": "tushare"
                    })

        if include_etf:
            try:
                fund_df = pro.fund_basic(market="E")
            except Exception:
                fund_df = pro.fund_basic()

            if fund_df is not None and not fund_df.empty:
                records = fund_df.to_dict("records")
                for row in records:
                    ts_code = str(row.get("ts_code") or "")
                    symbol = ts_code.split(".")[0].zfill(6)
                    name = str(row.get("name") or "")
                    fund_type = str(row.get("fund_type") or "")
                    if not symbol:
                        continue
                    if "ETF" not in name.upper() and "ETF" not in fund_type.upper():
                        continue
                    for universe_type in classify_etf_universe_types(name, fund_type):
                        items.append({
                            "symbol": symbol,
                            "name": name,
                            "asset_type": "etf",
                            "universe_type": universe_type,
                            "source": "tushare"
                        })

        return {
            "success": True,
            "source": "tushare",
            "count": len(items),
            "items": items
        }
    except Exception as e:
        return {"success": False, "message": f"Tushare资产清单拉取失败: {str(e)}"}


def main():
    include_stock = "--stocks" in sys.argv
    include_etf = "--etfs" in sys.argv
    if not include_stock and not include_etf:
        include_stock = True
        include_etf = True

    result = fetch_with_tushare(include_stock, include_etf)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("success") else 1)


if __name__ == "__main__":
    main()
