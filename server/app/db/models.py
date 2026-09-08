"""数据模型（阶段2 纵向切片所需子集；alert 表阶段4 建）。"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.database import Base


class Enterprise(Base):
    __tablename__ = "enterprise"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    unified_code: Mapped[str] = mapped_column(String(40), default="", index=True)
    stock_code: Mapped[str] = mapped_column(String(10), default="", index=True)  # A股代码（数据源标识）
    legal_rep: Mapped[str] = mapped_column(String(80), default="")
    reg_capital_wan: Mapped[float] = mapped_column(Float, default=0)
    reg_date: Mapped[str] = mapped_column(String(20), default="")
    industry: Mapped[str] = mapped_column(String(80), default="")
    address: Mapped[str] = mapped_column(String(300), default="")
    data_note: Mapped[str] = mapped_column(Text, default="")  # 信源与数据说明
    # 各维度数据状态：{"finance": "ok|empty|error|never", ...}
    # ok=查到记录；empty=查过但无记录（可判 0 风险）；error=拉取失败；never=从未采集
    data_status_json: Mapped[str] = mapped_column(Text, default="{}")

    legal_records: Mapped[list["LegalRecord"]] = relationship(back_populates="enterprise")
    news: Mapped[list["News"]] = relationship(back_populates="enterprise")
    finances: Mapped[list["Finance"]] = relationship(back_populates="enterprise")
    facts: Mapped[list["RiskFact"]] = relationship(back_populates="enterprise")


class LegalRecord(Base):
    __tablename__ = "legal_record"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enterprise_id: Mapped[int] = mapped_column(ForeignKey("enterprise.id"), index=True)
    case_no: Mapped[str] = mapped_column(String(60), default="")
    doc_type: Mapped[str] = mapped_column(String(40), default="")  # 判决/裁定/行政决定/处罚
    title: Mapped[str] = mapped_column(String(300))
    court: Mapped[str] = mapped_column(String(120), default="")
    cause: Mapped[str] = mapped_column(String(120), default="")
    amount: Mapped[float] = mapped_column(Float, default=0)
    status: Mapped[str] = mapped_column(String(40), default="")
    judgment_date: Mapped[str] = mapped_column(String(20), default="")
    source: Mapped[str] = mapped_column(String(200), default="")

    enterprise: Mapped[Enterprise] = relationship(back_populates="legal_records")


class News(Base):
    __tablename__ = "news"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enterprise_id: Mapped[int] = mapped_column(ForeignKey("enterprise.id"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    content: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(120), default="")
    url: Mapped[str] = mapped_column(String(400), default="")
    published_at: Mapped[str] = mapped_column(String(20), default="")
    sentiment: Mapped[str] = mapped_column(String(20), default="neutral")  # positive/neutral/negative

    enterprise: Mapped[Enterprise] = relationship(back_populates="news")


class Finance(Base):
    __tablename__ = "finance"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enterprise_id: Mapped[int] = mapped_column(ForeignKey("enterprise.id"), index=True)
    year: Mapped[str] = mapped_column(String(10), default="")
    report_type: Mapped[str] = mapped_column(String(40), default="")
    total_assets: Mapped[float] = mapped_column(Float, default=0)
    total_liabilities: Mapped[float] = mapped_column(Float, default=0)
    revenue: Mapped[float] = mapped_column(Float, default=0)
    net_profit: Mapped[float] = mapped_column(Float, default=0)
    debt_ratio: Mapped[float] = mapped_column(Float, default=0)
    source: Mapped[str] = mapped_column(String(200), default="")

    enterprise: Mapped[Enterprise] = relationship(back_populates="finances")


class RiskFact(Base):
    """风险信号事实（memory 落库）：供证据引用与人工复核。"""

    __tablename__ = "risk_fact"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enterprise_id: Mapped[int] = mapped_column(ForeignKey("enterprise.id"), index=True)
    dimension: Mapped[str] = mapped_column(String(30), default="")  # finance/legal/news/other
    text: Mapped[str] = mapped_column(Text)
    evidence_json: Mapped[str] = mapped_column(Text, default="")  # 源头/时间/文章引用
    confidence: Mapped[float] = mapped_column(Float, default=0)
    ts: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    enterprise: Mapped[Enterprise] = relationship(back_populates="facts")


class ChatSession(Base):
    """对话会话（Agent 工作区）。"""

    __tablename__ = "chat_session"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    title: Mapped[str] = mapped_column(String(120), default="新对话")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class ChatMessage(Base):
    """会话消息（user / assistant / tool），保留工具调用以便回放。"""

    __tablename__ = "chat_message"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("chat_session.id"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text, default="")
    tool_calls_json: Mapped[str] = mapped_column(Text, default="")   # assistant 消息的工具调用
    tool_call_id: Mapped[str] = mapped_column(String(60), default="")  # tool 消息对应的调用
    tool_name: Mapped[str] = mapped_column(String(60), default="")
    ts: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    session: Mapped[ChatSession] = relationship(back_populates="messages")


class Alert(Base):
    """预警工单（闭环：待处理 → 处理中 → 已处置 / 已忽略，含处理流水）。"""

    __tablename__ = "alert"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    enterprise_id: Mapped[int] = mapped_column(ForeignKey("enterprise.id"), index=True)
    level: Mapped[str] = mapped_column(String(10), index=True)      # red/orange/yellow
    dimension: Mapped[str] = mapped_column(String(30), default="")  # 六维之一或 overall
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(Text, default="")
    evidence_json: Mapped[str] = mapped_column(Text, default="")
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    source: Mapped[str] = mapped_column(String(20), default="scoring")  # scoring/analysis/manual
    fingerprint: Mapped[str] = mapped_column(String(120), default="", index=True)
    handler: Mapped[str] = mapped_column(String(60), default="")
    notes_json: Mapped[str] = mapped_column(Text, default="[]")     # 处理流水 [{ts, action, handler, note}]
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    handled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    enterprise: Mapped[Enterprise] = relationship()
