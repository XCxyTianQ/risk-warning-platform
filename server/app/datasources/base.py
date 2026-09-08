"""数据源抽象层：统一记录格式与数据源协议（依赖倒置核心）。

业务层只依赖 DataSource 协议，不关心具体是 AkShare / 付费 API / 人工导入。
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol


@dataclass
class NormalizedRecord:
    """统一记录：任何来源都归一成这个结构，便于幂等入库与溯源。"""

    kind: str            # finance | news | legal
    external_id: str     # 源内唯一键（幂等 upsert 用）
    source: str          # 例如 akshare:stock_financial_abstract
    payload: dict        # 已按目标表字段归一的数据
    raw_ref: str = ""    # 原始链接/参数，便于追溯
    fetched_at: datetime = field(default_factory=datetime.utcnow)


@dataclass
class FetchResult:
    """一次拉取的结果（含降级与缺口信息）。"""

    dimension: str
    source: str
    records: list[NormalizedRecord] = field(default_factory=list)
    error: str = ""
    gap: str = ""        # 数据缺口说明（如"无股票代码"）

    @property
    def ok(self) -> bool:
        return not self.error and not self.gap


class DataSource(Protocol):
    name: str
    dimensions: list[str]

    def fetch(self, enterprise, dimension: str, since: str | None = None) -> FetchResult:
        ...
