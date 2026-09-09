# -*- coding: utf-8 -*-
"""勘察 AkShare 财务接口可用字段 → 落盘 UTF-8 JSON（避免控制台乱码）。

用法：.venv\\Scripts\\python.exe tests\\probe_finance_fields.py 600519 [600518]
输出：tests/_finance_fields.json
"""

import json
import pathlib
import sys

import akshare as ak

codes = sys.argv[1:] or ["600519"]
out: dict = {}

for code in codes:
    item: dict = {"abstract_indicators": [], "abstract_periods": [], "sina_balance": [], "sina_income": [], "sina_cashflow": []}
    try:
        df = ak.stock_financial_abstract(symbol=code)
        item["abstract_indicators"] = [str(x) for x in df["指标"].tolist()]
        item["abstract_periods"] = [str(c) for c in df.columns[2:12]]
        # 抽样：取最近一个年报期，记录若干关键指标原值
        annual = [c for c in df.columns[2:] if str(c).endswith("1231")]
        if annual:
            col = annual[0]
            item["abstract_sample"] = {
                str(r["指标"]): (None if r.get(col) is None or str(r.get(col)) == "nan" else str(r.get(col)))
                for _, r in df.iterrows()
            }
    except Exception as exc:  # noqa: BLE001
        item["abstract_error"] = f"{type(exc).__name__}: {exc}"
    for name, key in (("资产负债表", "sina_balance"), ("利润表", "sina_income"), ("现金流量表", "sina_cashflow")):
        try:
            df = ak.stock_financial_report_sina(stock="sh" + code, symbol=name)
            item[key] = [str(c) for c in df.columns]
            if not df.empty:
                item[key + "_sample"] = {str(c): str(df.iloc[0][c]) for c in df.columns}
        except Exception as exc:  # noqa: BLE001
            item[key + "_error"] = f"{type(exc).__name__}: {exc}"
    out[code] = item

dst = pathlib.Path(__file__).with_name("_finance_fields.json")
dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("saved:", dst, dst.stat().st_size, "bytes")
