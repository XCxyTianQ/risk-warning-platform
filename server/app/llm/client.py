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
import json

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
        """OpenAI 兼容 chat/completions（阶段2 实现：照搬 reasonmc 解析防御链）。"""
        url = self._config.base_url.rstrip("/") + "/chat/completions"
        body: dict = {
            "model": self._config.model,
            "messages": messages,
            "max_tokens": max_tokens or self._config.max_tokens,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        try:
            resp = self._http.post(
                url,
                json=body,
                headers={"Authorization": f"Bearer {self._config.api_key}"},
            )
        except httpx.HTTPError as exc:
            raise LlmException(-1, f"LLM call failed: {exc}") from exc

        # 先检查状态码再解析 body（非 2xx 可能是 HTML/空，给可读错误）
        if resp.status_code // 100 != 2:
            raise LlmException(resp.status_code, f"LLM HTTP {resp.status_code}: {resp.text[:500]}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise LlmException(0, "LLM 响应体无效（非 JSON）: " + resp.text[:200]) from exc
        if data is None or (isinstance(data, dict) and data.get("error")):
            err = data.get("error") if isinstance(data, dict) else data
            raise LlmException(0, f"LLM error: {err}")
        # 记录 usage.prompt_tokens（上下文压缩触发用；缺失时保持上次值）
        usage = data.get("usage") or {}
        if isinstance(usage.get("prompt_tokens"), int):
            self.last_prompt_tokens = usage["prompt_tokens"]
        choices = data.get("choices") or []
        if not choices:
            raise LlmException(0, "LLM returned no choices: " + str(data)[:500])
        msg = choices[0].get("message") or {}
        if not msg:
            raise LlmException(0, "LLM message missing")
        return msg

    def chat_stream(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        max_tokens: int | None = None,
    ):
        """流式 chat/completions（SSE）。

        yield 事件：
          {"type": "text", "text": "..."}           增量正文
          {"type": "tool_calls", "tool_calls": [...]} 本轮工具调用（聚合后一次性给出）
        """
        url = self._config.base_url.rstrip("/") + "/chat/completions"
        body: dict = {
            "model": self._config.model,
            "messages": messages,
            "max_tokens": max_tokens or self._config.max_tokens,
            "stream": True,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        tool_calls: dict[int, dict] = {}
        try:
            with self._http.stream(
                "POST",
                url,
                json=body,
                headers={"Authorization": f"Bearer {self._config.api_key}"},
            ) as resp:
                if resp.status_code // 100 != 2:
                    detail = resp.read().decode("utf-8", "ignore")[:500]
                    raise LlmException(resp.status_code, f"LLM HTTP {resp.status_code}: {detail}")
                for raw in resp.iter_lines():
                    if not raw:
                        continue
                    line = raw if isinstance(raw, str) else raw.decode("utf-8", "ignore")
                    if line.startswith("data:"):
                        data = line[5:].strip()
                    else:
                        continue
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    usage = chunk.get("usage") or {}
                    if isinstance(usage.get("prompt_tokens"), int):
                        self.last_prompt_tokens = usage["prompt_tokens"]
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    content = delta.get("content")
                    if content:
                        yield {"type": "text", "text": content}
                    for tc in delta.get("tool_calls") or []:
                        idx = tc.get("index", 0)
                        slot = tool_calls.setdefault(
                            idx,
                            {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
                        )
                        if tc.get("id"):
                            slot["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["function"]["name"] = fn["name"]
                        if fn.get("arguments"):
                            slot["function"]["arguments"] += fn["arguments"]
        except httpx.HTTPError as exc:
            raise LlmException(-1, f"LLM stream failed: {exc}") from exc

        if tool_calls:
            yield {"type": "tool_calls", "tool_calls": [tool_calls[i] for i in sorted(tool_calls)]}
