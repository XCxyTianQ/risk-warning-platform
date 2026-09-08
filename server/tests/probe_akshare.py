# -*- coding: utf-8 -*-
"""数据源可行性探测：AkShare 免费接口能拿到什么（上市公司通路验证）。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\probe_akshare.py [股票代码]
"""

import sys
import traceback

SYMBOL = sys.argv[1] if len(sys.argv) > 1 else "600519"  # 默认贵州茅台

import akshare as ak

print(f"akshare {ak.__version__} | 探测标的: {SYMBOL}")
print("=" * 70)


def try_call(name, fn):
    print(f"[{name}] ...", flush=True)
    try:
        df = fn()
        rows = len(df) if hasattr(df, "__len__") else "?"
        print(f"[{name}] ✅ 成功 | 形状: {getattr(df, 'shape', '?')}")
        if hasattr(df, "columns"):
            cols = list(df.columns)[:10]
            print(f"    列: {cols}")
        if hasattr(df, "head"):
            print(df.head(3).to_string()[:900])
    except Exception as exc:  # noqa: BLE001
        print(f"[{name}] ❌ 失败: {type(exc).__name__}: {str(exc)[:200]}")
    print("-" * 70)


try_call("财务摘要(东财)", lambda: ak.stock_financial_abstract(symbol=SYMBOL))
try_call("利润表(新浪)", lambda: ak.stock_financial_report_sina(stock=f"sh{SYMBOL}", symbol="利润表"))
try_call("个股新闻(东财)", lambda: ak.stock_news_em(symbol=SYMBOL))
try_call("公告(巨潮)", lambda: ak.stock_zh_a_disclosure_report_cninfo(symbol=SYMBOL, market="沪深京", start_date="20250101", end_date="20260930"))
try_call("基本信息(东财)", lambda: ak.stock_individual_info_em(symbol=SYMBOL))
