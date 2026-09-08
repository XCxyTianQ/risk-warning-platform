"""提示词缓存预热（prompt cache preheat）。

原理：提供方按请求 token 序列的**前缀**做 KV Cache。我们的静态前缀
（`SYSTEM_PROMPT` + 全部工具 schema，约 7k token）在每个请求里都出现，
但进程启动后/新会话的第一个请求仍要全价处理一次这段前缀。

做法：用**完全相同**的 system 与 tools 发一个最小请求（max_tokens=1），
把这段前缀提前写进提供方缓存；之后真实请求的前缀部分即按缓存价计费。

注意：
- 预热请求必须逐字复用真实请求的 system 与 tools（顺序、字节一致），否则前缀不对齐
- TTL 内不重复预热（提供方缓存有存活时间；默认 10 分钟）
- 压缩后前缀变化（system + 摘要），需要重新预热一次
"""

import threading
import time

from app.core.config import settings
from app.llm.client import LlmClient, LlmConfig

# 预热请求的 user 内容（不参与前缀匹配，仅需构成一次合法请求）
WARM_USER_TEXT = "预热"


class PromptCacheWarmer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.last_warm_at: float = 0.0
        self.last_label: str = ""
        self.warm_count: int = 0
        self.warm_cost: float = 0.0
        self.last_usage: dict = {}
        self.last_error: str = ""
        self.last_hit_tokens: int = 0

    # ---------- 对外接口 ----------
    def status(self) -> dict:
        return {
            "enabled": settings.preheat_enabled,
            "warm_count": self.warm_count,
            "last_warm_at": self.last_warm_at,
            "last_warm_ago": round(time.time() - self.last_warm_at, 1) if self.last_warm_at else None,
            "last_label": self.last_label,
            "last_hit_tokens": self.last_hit_tokens,
            "ttl_seconds": settings.preheat_ttl_seconds,
            "last_error": self.last_error,
        }

    def is_fresh(self) -> bool:
        return bool(self.last_warm_at) and (time.time() - self.last_warm_at) < settings.preheat_ttl_seconds

    def warm(self, system_prompt: str, tools: list[dict], force: bool = False, label: str = "manual") -> dict:
        """预热静态前缀。返回状态字典；失败不抛异常。"""
        if not settings.preheat_enabled:
            return {"skipped": "preheat disabled"}
        if _is_local_endpoint(settings.llm_base_url):
            return {"skipped": "本地 mock 端点无需预热"}
        with self._lock:
            if self.is_fresh() and not force:
                return {"skipped": f"缓存仍新鲜（{round(time.time() - self.last_warm_at, 1)}s 前预热）"}
            client = LlmClient(LlmConfig(
                base_url=settings.llm_base_url,
                api_key=settings.llm_api_key,
                model=settings.llm_model,
                max_tokens=1,
            ))
            try:
                client.chat(
                    [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": WARM_USER_TEXT},
                    ],
                    tools=tools or None,
                    max_tokens=1,
                )
            except Exception as exc:  # noqa: BLE001 —— 预热失败不影响主流程
                self.last_error = f"{type(exc).__name__}: {exc}"
                return {"error": self.last_error}

            usage = dict(client.last_usage)
            self.last_usage = usage
            self.last_warm_at = time.time()
            self.last_label = label
            self.warm_count += 1
            self.last_hit_tokens = int(usage.get("cache_hit_tokens", 0) or 0)
            return {"ok": True, "label": label, "usage": usage, **self.status()}

    def warm_async(self, system_prompt: str, tools: list[dict], label: str = "startup", force: bool = False) -> None:
        threading.Thread(
            target=self.warm, args=(system_prompt, tools), kwargs={"force": force, "label": label},
            daemon=True,
        ).start()


def _is_local_endpoint(base_url: str) -> bool:
    return any(h in (base_url or "") for h in ("127.0.0.1", "localhost", "0.0.0.0"))


warmer = PromptCacheWarmer()
