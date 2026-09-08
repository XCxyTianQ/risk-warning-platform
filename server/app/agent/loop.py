"""Agent 循环（流式）：模型 ↔ 工具，直到给出最终回答。

对齐 Harness/Codex 的核心循环：
  用户消息 → LLM(带 tools) → tool_calls → 执行工具 → 结果回注 → 再调用 → 纯文本回答
每个阶段产出事件（token / tool / tool_result / done / error），由 SSE 推给前端。
"""

import json
from typing import Iterator

from sqlalchemy.orm import Session as DbSession

from app.agent import approvals
from app.agent.events import AgentEvent
from app.agent.prompt import SYSTEM_PROMPT
from app.agent.session import Session, store
from app.agent.tools import build_registry
from app.core.config import settings
from app.llm.client import LlmClient, LlmConfig

MAX_STEPS = 5
MAX_TOOL_RESULT_CHARS = 6000

_registry = build_registry()


def _client() -> LlmClient:
    return LlmClient(LlmConfig(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.llm_model,
        max_tokens=settings.llm_max_tokens,
    ))


def _summarize(result: dict) -> dict:
    """给前端展示用的工具结果摘要（避免把大 JSON 直接推给 UI）。"""
    if "error" in result:
        return {"ok": False, "error": result["error"]}
    keys = ("count", "score", "grade", "level", "summary", "enterprise_total", "avg_score",
            "enterprise_id", "enterprise_name", "enterprise")
    summary = {k: result[k] for k in keys if k in result}
    ent = result.get("enterprise")
    if isinstance(ent, dict):
        summary["enterprise_id"] = ent.get("id")
        summary["enterprise_name"] = ent.get("name")
    if "enterprises" in result:
        summary["enterprises"] = [
            {"name": e["name"], "score": e["score"], "grade": e["grade"], "level": e["level"]}
            for e in result["enterprises"][:5]
        ]
    if "dimensions" in result:
        summary["dimensions"] = {
            k: {"score": v.get("score"), "label": v.get("label")} for k, v in result["dimensions"].items()
        }
    if "facts" in result:
        summary["facts"] = [f["text"][:60] for f in result["facts"][:5]]
    return {"ok": True, **summary}


def run_agent(db: DbSession, session: Session, user_text: str) -> Iterator[AgentEvent]:
    store.append(db, session, {"role": "user", "content": user_text})
    client = _client()

    for step in range(MAX_STEPS):
        messages = [{"role": "system", "content": SYSTEM_PROMPT}, *store.context(session)]
        text_parts: list[str] = []
        tool_calls: list[dict] | None = None

        try:
            for ev in client.chat_stream(messages, tools=_registry.definitions()):
                if ev["type"] == "text":
                    text_parts.append(ev["text"])
                    yield AgentEvent("token", {"text": ev["text"]})
                elif ev["type"] == "tool_calls":
                    tool_calls = ev["tool_calls"]
        except Exception as exc:  # noqa: BLE001 —— 模型层异常直接反馈给用户
            yield AgentEvent("error", {"message": f"模型调用失败：{exc}"})
            return

        if tool_calls:
            store.append(db, session, {
                "role": "assistant",
                "content": "".join(text_parts),
                "tool_calls": tool_calls,
            })
            for tc in tool_calls:
                fn = tc.get("function", {})
                name = fn.get("name", "")
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = {}
                tool = _registry.get(name)
                yield AgentEvent("tool", {
                    "id": tc.get("id", ""),
                    "name": name,
                    "args": args,
                    "read_only": bool(tool and tool.read_only),
                })

                # 动作工具：先请求用户授权（Harness/Codex 的 approval 机制）
                if tool and not tool.read_only and settings.agent_require_approval:
                    pa = approvals.create(session.id, tc.get("id", ""), name, args, tool.description)
                    yield AgentEvent("approval", {
                        "approval_id": pa.id,
                        "id": tc.get("id", ""),
                        "name": name,
                        "args": args,
                        "description": tool.description,
                        "timeout": settings.agent_approval_timeout,
                    })
                    decided = pa.event.wait(timeout=settings.agent_approval_timeout)
                    approved = bool(decided and pa.approved)
                    approvals.discard(pa.id)
                    if not approved:
                        rejected = {
                            "error": "用户拒绝执行该操作"
                            if decided else f"等待授权超时（{settings.agent_approval_timeout}s）"
                        }
                        store.append(db, session, {
                            "role": "tool",
                            "tool_call_id": tc.get("id", ""),
                            "tool_name": name,
                            "content": json.dumps(rejected, ensure_ascii=False),
                        })
                        yield AgentEvent("tool_result", {
                            "id": tc.get("id", ""),
                            "name": name,
                            "result": {"ok": False, **rejected},
                        })
                        continue

                result = _registry.call(name, args, db)
                store.append(db, session, {
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "tool_name": name,
                    "content": json.dumps(result, ensure_ascii=False)[:MAX_TOOL_RESULT_CHARS],
                })
                yield AgentEvent("tool_result", {
                    "id": tc.get("id", ""),
                    "name": name,
                    "result": _summarize(result),
                })
            continue

        final_text = "".join(text_parts)
        store.append(db, session, {"role": "assistant", "content": final_text})
        yield AgentEvent("done", {"session_id": session.id, "steps": step + 1, "title": session.title})
        return

    yield AgentEvent("error", {"message": f"达到最大工具调用轮次（{MAX_STEPS}），请换一种问法"})
