"""LLM 网关骨架 —— 设计照搬 reasonmc LlmClient.java。

实现要求（照搬要点，详见 docs/reasonmc-调研.md）：
1. 三参数 base_url/api_key/model 由配置注入，支持 mock/DeepSeek/OpenAI/vLLM 切换；
2. 调用前先检查 HTTP 状态码再解析 body（非 2xx 可能是 HTML/空，给可读错误）；
3. 解析防御链：body null → error 字段 → choices 空 → 才取 message；
4. 记录 usage.prompt_tokens（上下文压缩触发用：agent 层可用）；
5. 错误分档 LlmException(status_code)：<0 网络/IO、0 响应异常、其它 HTTP 码；
   retryable() = status<0 || 408 || 429 || >=500（4xx 请求错误不可重试）。

TODO(步骤2)：实现 chat() 的请求/响应逻辑；支持流式留到 P1。
"""

from dataclasses import dataclass

import httpx


class LlmException(RuntimeError):
    """LLM 调用失败（结构化错误，供 agent 层决定是否退避重试）。

    status_code 语义（与 reasonmc 一致）：
      -1 = 网络/IO/中断；0 = 响应异常（无 HTTP 码）；其它 = HTTP 状态码。
    """

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code

    def retryable(self) -> bool:
        """网络错误、408/429 限流、5xx 服务端错误可重试；4xx 请求错误不可重试。"""
        return (
            self.status_code < 0
            or self.status_code in (408, 429)
            or self.status_code >= 500
        )


@dataclass(frozen=True)
class LlmConfig:
    """LLM 端点三参数（从 app.core.config.settings 构造）。"""

    base_url: str
    api_key: str
    model: str
    max_tokens: int = 1024
    timeout_s: float = 90.0
    max_retries: int = 2  # 退避重试次数上限（reasonmc 默认 2）


class LlmClient:
    """OpenAI 兼容 chat/completions 客户端（非流式起步）。

    TODO(步骤2)：实现 chat(messages, tools, max_tokens) -> dict。
    返回 assistant 消息（可能含 tool_calls），契约与 reasonmc 一致；
    失败一律抛 LlmException，由 agent 层按 retryable() 决定重试。
    """

    def __init__(self, config: LlmConfig):
        self._config = config
        self._http = httpx.Client(timeout=config.timeout_s)
        self.last_prompt_tokens = 0  # 最近一次 usage.prompt_tokens（0=未知）

    @property
    def config(self) -> LlmConfig:
        return self._config

    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        max_tokens: int | None = None,
    ) -> dict:
        raise NotImplementedError("步骤2 实现：参考 reasonmc LlmClient.chat()（含解析防御链）")
