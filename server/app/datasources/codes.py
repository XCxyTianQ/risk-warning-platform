"""企业名称 ↔ A股代码 解析（用于"自由添加企业"）。

数据来源：AkShare `stock_info_a_code_name()`（沪深京 A 股代码-名称对照表），进程内缓存。
"""

import time

_CACHE: dict = {"ts": 0.0, "rows": []}
TTL = 24 * 3600  # 一天


def _table() -> list[dict]:
    now = time.time()
    if _CACHE["rows"] and now - _CACHE["ts"] < TTL:
        return _CACHE["rows"]
    try:
        import akshare as ak

        df = ak.stock_info_a_code_name()
        rows = [
            {"code": str(r["code"]).zfill(6), "name": str(r["name"]).strip()}
            for _, r in df.iterrows()
        ]
        _CACHE.update(ts=now, rows=rows)
    except Exception:  # noqa: BLE001 —— 网络失败时保留旧缓存
        pass
    return _CACHE["rows"]


def resolve_code(name: str, limit: int = 8) -> list[dict]:
    """按名称匹配股票代码。

    匹配策略（避免"中色集团"这类不存在名称误匹配到"中色股份"）：
    - 完全相等：直接命中
    - 名称以查询串开头且查询串长度 ≥ 4：允许（如"贵州茅台"→"贵州茅台"、"宁德时代"→"宁德时代"）
    - 查询串是证券简称的完整子串且长度 ≥ 4：允许
    其余模糊包含（如 2 字查询）不自动采用，仅作为候选返回给用户确认。
    """
    query = (name or "").strip()
    if not query:
        return []
    rows = _table()
    hits = [r for r in rows if query in r["name"]]
    hits.sort(key=lambda r: (0 if r["name"] == query else 1 if r["name"].startswith(query) else 2, len(r["name"])))
    return hits[:limit]


def resolve_code_strict(name: str) -> dict | None:
    """严格解析（自动添加企业用）：只接受完全相等或长度 ≥4 的前缀匹配。"""
    query = (name or "").strip()
    if len(query) < 2:
        return None
    for r in _table():
        if r["name"] == query:
            return r
    if len(query) >= 4:
        for r in _table():
            if r["name"].startswith(query):
                return r
    return None


def name_of(code: str) -> str:
    code = (code or "").strip().zfill(6)
    for r in _table():
        if r["code"] == code:
            return r["name"]
    return ""


def market_prefix(code: str) -> str:
    """新浪接口需要 sh/sz/bj 前缀。"""
    code = (code or "").strip()
    if code.startswith(("6", "9")):
        return "sh" + code
    if code.startswith(("0", "3", "2")):
        return "sz" + code
    return "bj" + code
