"""FastAPI 入口：健康检查 + CORS + 企业/研判路由（阶段2）。"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.alerts import router as alert_router
from app.api.chat import router as chat_router
from app.api.dashboard import router as dashboard_router
from app.api.enterprises import router as enterprise_router
from app.core.config import settings
from app.db.database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
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


app = FastAPI(title=settings.app_name, version="0.2.0", lifespan=lifespan)

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


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": settings.app_name, "version": "0.2.0"}
