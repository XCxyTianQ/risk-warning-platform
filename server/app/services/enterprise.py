"""企业创建/删除（自由添加企业）。

关键校验：**三源都查不到的企业不建档**（避免出现"无数据却 100 分"的假画像）。
"""

import json

from sqlalchemy.orm import Session as DbSession

from app.datasources.codes import name_of, resolve_code, resolve_code_strict
from app.datasources.registry import refresh_enterprise
from app.db.models import Enterprise, Finance, LegalRecord, News, RiskFact


def create_enterprise(
    db: DbSession,
    name: str,
    stock_code: str | None = None,
    auto_fetch: bool = True,
    industry: str = "",
) -> dict:
    """新建企业；未给股票代码时按名称严格解析。auto_fetch=True 时若无任何数据则回滚并报错。"""
    name = (name or "").strip()
    if not name:
        return {"error": "企业名称不能为空"}

    existing = db.query(Enterprise).filter(Enterprise.name == name).first()
    if existing is not None:
        return {"error": f"企业已存在：{existing.name}（id={existing.id}）", "enterprise_id": existing.id}

    code = (stock_code or "").strip()
    resolved_from = ""
    matched_name = ""
    if code:
        resolved_from = "用户指定"
        matched_name = name_of(code)
    else:
        hit = resolve_code_strict(name)
        if hit:
            code = hit["code"]
            matched_name = hit["name"]
            resolved_from = "名称解析"

    if not code:
        candidates = resolve_code(name, limit=5)
        hint = (
            "候选：" + "、".join(f"{c['name']}({c['code']})" for c in candidates)
            if candidates else "未匹配到任何 A 股证券简称"
        )
        return {
            "error": f"未找到企业「{name}」的公开数据源：A股代码解析失败（{hint}）。"
                     f"请检查名称，或直接提供股票代码；非上市企业请使用人工数据导入。",
            "candidates": candidates,
        }

    ent = Enterprise(
        name=matched_name or name,
        stock_code=code,
        industry=industry or "上市公司",
        data_note=f"用户添加：股票代码 {code}（{resolved_from}）",
        data_status_json="{}",
    )
    db.add(ent)
    db.commit()

    out: dict = {
        "enterprise_id": ent.id,
        "name": ent.name,
        "stock_code": ent.stock_code,
        "resolved_from": resolved_from,
        "auto_fetch": auto_fetch,
    }

    if not auto_fetch:
        out["warning"] = "未自动拉取数据；该企业暂无数据，评分将显示为「无数据，无法评估」"
        return out

    refresh = refresh_enterprise(db, ent.id)
    out["refresh"] = refresh

    # 三源都查不到数据 → 回滚建档，避免出现"无数据 100 分"的假画像
    status = refresh.get("data_status", {}) if isinstance(refresh, dict) else {}
    got_data = any(v == "ok" for v in status.values())
    if not got_data:
        _hard_delete(db, ent.id)
        return {
            "error": f"未找到企业「{ent.name}」（{code}）的公开数据："
                     f"东方财富 / 新浪 / 巨潮 三个信源均无对应记录，已撤销建档。"
                     f"请确认名称或代码是否正确。",
            "stock_code": code,
            "data_status": status,
        }

    return out


def _hard_delete(db: DbSession, enterprise_id: int) -> None:
    for model in (RiskFact, Finance, News, LegalRecord):
        db.query(model).filter(model.enterprise_id == enterprise_id).delete()
    db.query(Enterprise).filter(Enterprise.id == enterprise_id).delete()
    db.commit()


def delete_enterprise(db: DbSession, enterprise_id: int) -> dict:
    ent = db.get(Enterprise, enterprise_id)
    if ent is None:
        return {"error": f"企业不存在: {enterprise_id}"}
    name = ent.name
    _hard_delete(db, enterprise_id)
    return {"deleted": enterprise_id, "name": name}


def lookup_stock(name: str) -> dict:
    """名称 → 股票代码候选（供前端"添加企业"确认）。"""
    return {"query": name, "candidates": resolve_code(name)}


def stock_name(code: str) -> str:
    return name_of(code)
