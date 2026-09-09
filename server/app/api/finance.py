"""金融分析 API：概览、单企业分析、Markdown 报告。

数据来自 finance 表（东财财务摘要 + 新浪三表字段级合并），
所有计算在 app/services/finance.py，本层只做参数校验与响应组装。
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session as DbSession

from app.db.database import get_db
from app.services import finance as fin

router = APIRouter(prefix="/api/finance", tags=["finance"])


@router.get("/overview")
def overview(years: int = Query(5, ge=1, le=10), db: DbSession = Depends(get_db)):
    """全库财务概览（供选择器与横向筛选）。"""
    return fin.overview(db, years=years)


@router.get("/{enterprise_id}/analysis")
def analysis(
    enterprise_id: int,
    years: int = Query(5, ge=1, le=10),
    peers: bool = Query(True),
    db: DbSession = Depends(get_db),
):
    """单企业金融分析：KPI、趋势、杜邦、Z/F/M 模型、同业对标、异常勾稽。"""
    data = fin.analysis(db, enterprise_id, years=years, with_peers=peers)
    if data.get("error"):
        raise HTTPException(status_code=404, detail=data["error"])
    return data


@router.get("/{enterprise_id}/report", response_class=PlainTextResponse)
def report(
    enterprise_id: int,
    years: int = Query(5, ge=1, le=10),
    db: DbSession = Depends(get_db),
):
    """确定性 Markdown 财务分析报告（叙述性解读由 Agent 工具完成）。"""
    return PlainTextResponse(
        fin.report_markdown(db, enterprise_id, years=years),
        media_type="text/markdown; charset=utf-8",
    )
