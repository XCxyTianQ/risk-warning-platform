"""FastAPI 入口：健康检查 + CORS + 企业/研判路由（阶段2）。"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.alerts import router as alert_router
from app.api.chat import router as chat_router
from app.api.dashboard import router as dashboard_router
from app.api.enterprises import router as enterprise_router
from app.api.finance import router as finance_router
from app.api.mcp import router as mcp_router
from app.api.plugins import router as plugins_router
from app.api.settings import router as settings_router
from app.api.share import router as share_router
from app.api.skills import router as skills_router
from app.core.config import settings
from app.db.database import SessionLocal, init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # 应用 DB 中的设置覆盖（先于预热，确保用最新模型/端点）
    try:
        from app.services.settings_store import load_and_apply

        db = SessionLocal()
        try:
            load_and_apply(db)
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        pass
    # 内置技能与预设入库
    try:
        from app.services.plugins import seed_builtin_presets
        from app.skills.service import seed_builtin

        db = SessionLocal()
        try:
            seed_builtin(db)
            seed_builtin_presets(db)
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        pass
    # 首次运行（空库）灌入样例企业数据
    try:
        from app.db.seed import seed_if_empty

        seed_if_empty()
    except Exception:  # noqa: BLE001
        pass
    # 启动时预热提示词缓存（后台线程，不阻塞启动）
    try:
        from app.agent.prompt import SYSTEM_PROMPT
        from app.agent.tools import build_registry
        from app.core.config import settings as _s
        from app.llm.preheat import warmer

        if _s.preheat_on_startup:
            warmer.warm_async(SYSTEM_PROMPT, build_registry().definitions(), label="startup")
    except Exception:  # noqa: BLE001 —— 预热失败不影响服务
        pass
    yield


app = FastAPI(title=settings.app_name, version="0.4.1", lifespan=lifespan)

# 开发期允许 Vite dev server 跨域访问（生产改为同源/反代）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(enterprise_router)
app.include_router(dashboard_router)
app.include_router(chat_router)
app.include_router(alert_router)
app.include_router(finance_router)
app.include_router(settings_router)
app.include_router(mcp_router)
app.include_router(skills_router)
app.include_router(plugins_router)
app.include_router(share_router)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": settings.app_name, "version": "0.4.1"}


# ---------------------------------------------------------------------------
# 桌面端：托管前端构建产物（Electron 通过 RWP_WEB_DIST 传入目录）
# ---------------------------------------------------------------------------
def _mount_web(dist_dir: str) -> bool:
    from pathlib import Path

    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    dist = Path(dist_dir)
    if not (dist / "index.html").is_file():
        return False
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=str(dist / "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        target = (dist / full_path).resolve()
        if full_path and target.is_file() and str(target).startswith(str(dist.resolve())):
            return FileResponse(str(target))
        return FileResponse(str(dist / "index.html"))

    return True


if settings.web_dist:
    _mount_web(settings.web_dist)
