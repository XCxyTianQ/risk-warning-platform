"""企业创建/删除（自由添加企业）。"""

from sqlalchemy.orm import Session as DbSession

from app.datasources.codes import name_of, resolve_code
from app.datasources.registry import refresh_enterprise
from app.db.models import Enterprise


def create_enterprise(
    db: DbSession,
    name: str,
    stock_code: str | None = None,
    auto_fetch: bool = True,
    industry: str = "",
) -> dict:
    """新建企业；未给股票代码时按名称自动解析（上市公司）。可选自动拉取数据。"""
    name = (name or "").strip()
    if not name:
        return {"error": "企业名称不能为空"}

    existing = db.query(Enterprise).filter(Enterprise.name == name).first()
    if existing is not None:
        return {
            "error": f"企业已存在：{existing.name}（id={existing.id}）",
            "enterprise_id": existing.id,
        }

    code = (stock_code or "").strip()
    resolved_from = ""
    if not code:
        candidates = resolve_code(name, limit=1)
        if candidates:
            code = candidates[0]["code"]
            resolved_from = "名称解析"
            if not industry:
                industry = ""

    ent = Enterprise(
        name=name,
        stock_code=code,
        industry=industry or ("上市公司" if code else "待补充"),
        data_note=(
            f"用户添加：{'股票代码 ' + code + '（' + resolved_from + '）' if code else '非上市/未匹配到代码'}"
        ),
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
    if auto_fetch and code:
        out["refresh"] = refresh_enterprise(db, ent.id)
    elif auto_fetch and not code:
        out["refresh"] = {"skipped": "未匹配到股票代码，无法自动拉取（可手动导入数据）"}
    return out


def delete_enterprise(db: DbSession, enterprise_id: int) -> dict:
    from app.db.models import Finance, LegalRecord, News, RiskFact

    ent = db.get(Enterprise, enterprise_id)
    if ent is None:
        return {"error": f"企业不存在: {enterprise_id}"}
    for model in (RiskFact, Finance, News, LegalRecord):
        db.query(model).filter(model.enterprise_id == enterprise_id).delete()
    db.delete(ent)
    db.commit()
    return {"deleted": enterprise_id, "name": ent.name}


def lookup_stock(name: str) -> dict:
    """名称 → 股票代码候选（供前端"添加企业"确认）。"""
    return {"query": name, "candidates": resolve_code(name)}


def stock_name(code: str) -> str:
    return name_of(code)
