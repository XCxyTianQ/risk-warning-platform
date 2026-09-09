"""数据库引擎与会话（SQLAlchemy 2.0，同步原型）。"""

from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.core.config import settings

_REPO_ROOT = Path(__file__).resolve().parents[3]
_DATA_DIR = _REPO_ROOT / "data"


def _resolve_db_url() -> str:
    """sqlite 路径解析：优先 RWP_DATA_DIR（桌面端），否则相对仓库根 data/。"""
    url = settings.database_url
    prefix = "sqlite:///./"
    if url.startswith(prefix):
        rel = Path(url[len(prefix):])
        if settings.data_dir:
            # 桌面端：数据库直接落在数据目录下（rel 形如 data/platform.db → <data_dir>/platform.db）
            target = Path(settings.data_dir).expanduser() / rel.name
        else:
            target = _REPO_ROOT / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        return "sqlite:///" + str(target.resolve()).replace("\\", "/")
    return url


_db_url = _resolve_db_url()
if _db_url.startswith("sqlite"):
    if settings.data_dir:
        Path(settings.data_dir).mkdir(parents=True, exist_ok=True)
    else:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)


class Base(DeclarativeBase):
    pass


engine = create_engine(
    _db_url,
    connect_args={"check_same_thread": False} if _db_url.startswith("sqlite") else {},
    future=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """建表 + 轻量迁移（骨架期自动建；正式版换 Alembic 迁移）。"""
    from app.db import models  # noqa: F401 —— 注册模型

    Base.metadata.create_all(bind=engine)
    _ensure_columns()


def _ensure_columns() -> None:
    """SQLite 轻量迁移：为已存在的表补齐模型中新增的列（幂等，可重复执行）。

    场景：老版本数据库缺少新字段（如 finance.metrics_json），
    升级后无需手工迁移脚本即可继续使用。
    """
    from sqlalchemy import inspect, text

    if not engine.url.drivername.startswith("sqlite"):
        return
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col.type.compile(engine.dialect)}'
                default = getattr(col.default, "arg", None) if col.default is not None else None
                if default is not None and not callable(default):
                    if isinstance(default, str):
                        ddl += " DEFAULT '" + default.replace("'", "''") + "'"
                    elif isinstance(default, bool):
                        ddl += f" DEFAULT {1 if default else 0}"
                    elif isinstance(default, (int, float)):
                        ddl += f" DEFAULT {default}"
                conn.execute(text(ddl))
