"""Agent 循环（流式）：模型 ↔ 工具，直到给出最终回答。

对齐 Harness/Codex 的核心循环：
  用户消息 → LLM(带 tools) → tool_calls → 执行工具 → 结果回注 → 再调用 → 纯文本回答

成本控制（对齐 DSH）：
- 主动压缩：每次调用前按 thresholdRatio 检查 token 压力，必要时触发 compaction
- 溢出恢复：提供方报上下文超限时，强制压缩一次并重试
- 用量事件：每次调用后回传 usage（含缓存命中/未命中 token），供前端展示命中率与成本
"""

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Iterator

from sqlalchemy.orm import Session as DbSession

from app.agent import approvals, context
from app.agent.events import AgentEvent
from app.agent.prompt import SYSTEM_PROMPT
from app.agent.session import Session, store
from app.agent.tools import build_registry
from app.core.config import settings
from app.llm.client import LlmClient, LlmConfig

MAX_STEPS = 5
MAX_TOOL_RESULT_CHARS = 6000

_base_registry = build_registry()


def _registry_for(db: DbSession, preset: dict | None = None):
    """每次运行构建注册表：内置工具（按预设过滤）+ 自定义插件 + 启用的 MCP 工具。"""
    reg = build_registry(preset)
    try:
        reg.register_custom_tools(db)
    except Exception:  # noqa: BLE001
        pass
    try:
        reg.register_mcp(db)
    except Exception:  # noqa: BLE001 —— MCP 不可用不影响内置工具
        pass
    return reg


def _client() -> LlmClient:
    return LlmClient(LlmConfig(
        base_url=settings.llm_base_url,
        api_key=settings.llm_api_key,
        model=settings.llm_model,
        max_tokens=settings.llm_max_tokens,
        disable_thinking=settings.llm_disable_thinking,
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
    if "items" in result and isinstance(result["items"], list):
        summary["alerts"] = [
            {"id": a.get("id"), "level": a.get("level"), "title": (a.get("title") or "")[:40],
             "status": a.get("status_label")}
            for a in result["items"][:5] if isinstance(a, dict)
        ]
    return {"ok": True, **summary}


def _build_messages(session: Session, system_prompt: str = SYSTEM_PROMPT, tool_free: bool = False) -> list[dict]:
    return [{"role": "system", "content": system_prompt}, *store.context(session, tool_free=tool_free)]


def _dump_tool_result(result: dict, limit: int = MAX_TOOL_RESULT_CHARS) -> str:
    """工具结果序列化：超长时给出**合法 JSON** 的截断说明，而不是把 JSON 截成半截。"""
    text = json.dumps(result, ensure_ascii=False)
    if len(text) <= limit:
        return text
    payload = {
        "truncated": True,
        "note": f"结果过大（{len(text)} 字符）已截断；如需完整数据请缩小查询范围或分企业查询",
        "summary": _summarize(result),
    }
    return json.dumps(payload, ensure_ascii=False)[:limit]


def _tool_result_event(db: DbSession, session: Session, tc: dict, name: str,
                       result: dict, latency_ms: int) -> AgentEvent:
    """落库工具结果并生成前端事件（含耗时）。"""
    store.append(db, session, {
        "role": "tool",
        "tool_call_id": tc.get("id", ""),
        "tool_name": name,
        "content": _dump_tool_result(result),
    })
    return AgentEvent("tool_result", {
        "id": tc.get("id", ""),
        "name": name,
        "result": _summarize(result),
        "latency_ms": latency_ms,
    })


def _run_parallel(db: DbSession, session: Session, reg, batch: list[tuple[dict, str, dict]]):
    """同一轮内的多个**只读**工具并行执行（每个线程独立 DB 会话）。

    典型场景：模型一次调用两家企业的 get_financial_analysis，串行需 2×2.5s。
    """
    from app.db.database import SessionLocal

    def call_one(name: str, args: dict):
        db2 = SessionLocal()
        try:
            t = time.perf_counter()
            result = reg.call(name, args, db2)
            return result, int((time.perf_counter() - t) * 1000)
        finally:
            db2.close()

    with ThreadPoolExecutor(max_workers=min(4, len(batch))) as pool:
        futures = {pool.submit(call_one, name, args): (tc, name) for tc, name, args in batch}
        for fut in as_completed(futures):
            tc, name = futures[fut]
            try:
                result, latency_ms = fut.result()
            except Exception as exc:  # noqa: BLE001 —— 单个工具失败不影响其他
                result, latency_ms = {"error": f"{type(exc).__name__}: {exc}"}, 0
            yield _tool_result_event(db, session, tc, name, result, latency_ms)


def _maybe_compact(db: DbSession, session: Session, client: LlmClient, reg, messages: list[dict],
                   force: bool = False) -> Iterator[AgentEvent]:
    """按压力阈值（或强制）压缩上下文；产出 compaction 事件，返回新的 messages 由调用方重建。"""
    if not settings.compaction_enabled:
        return
    over, est = context.should_compact(messages, reg.definitions())
    if not (force or over):
        return
    yield AgentEvent("compaction", {"phase": "start", "estimated_tokens": est,
                                    "window": settings.llm_context_window, "forced": force})
    result = context.compact(db, session, client, messages, reg.definitions())
    if result:
        store.add_usage(db, session, result.get("usage") or {})
        # 压缩后前缀变化（system + 摘要）→ 立即预热新前缀，避免下一次请求全价处理
        try:
            from app.llm.preheat import warmer

            warmer.warm(SYSTEM_PROMPT, reg.definitions(), force=True, label="post-compaction")
        except Exception:  # noqa: BLE001
            pass
        yield AgentEvent("compaction", {
            "phase": "done",
            "folded": result["folded"],
            "summary_chars": len(result["summary"]),
            "compact_count": session.compact_count,
            "usage": store.usage_stats(session),
        })
    else:
        yield AgentEvent("compaction", {"phase": "skipped", "reason": "无可折叠历史或摘要失败"})


def run_agent(db: DbSession, session: Session, user_text: str, preset_id: int | None = None) -> Iterator[AgentEvent]:
    store.append(db, session, {"role": "user", "content": user_text})

    # 载入 Agent 预设（提示词补充 + 工具白名单 + 技能白名单 + 模型覆盖）
    preset_row = None
    preset: dict | None = None
    system_prompt = SYSTEM_PROMPT
    if preset_id:
        try:
            from app.services.plugins import get_preset

            preset_row = get_preset(db, preset_id)
            if preset_row is not None:
                import json as _json

                preset = {
                    "tools": _json.loads(preset_row.tools_json or "[]"),
                    "skills": _json.loads(preset_row.skills_json or "[]"),
                }
                if preset_row.prompt_extra:
                    system_prompt = f"{SYSTEM_PROMPT}\n\n[当前预设：{preset_row.name}]\n{preset_row.prompt_extra}"
        except Exception:  # noqa: BLE001
            preset_row = None

    client = _client()
    if preset_row is not None and preset_row.model_override:
        client = LlmClient(LlmConfig(
            base_url=settings.llm_base_url, api_key=settings.llm_api_key,
            model=preset_row.model_override, max_tokens=settings.llm_max_tokens,
            disable_thinking=settings.llm_disable_thinking,
        ))
    reg = _registry_for(db, preset)

    # 主动压缩检查（DSH：每次调用前按最新压力重新解析）
    messages = _build_messages(session, system_prompt)
    for ev in _maybe_compact(db, session, client, reg, messages):
        yield ev
        messages = _build_messages(session, system_prompt)

    tool_free_retry = False
    for step in range(MAX_STEPS):
        messages = _build_messages(session, system_prompt, tool_free=tool_free_retry)
        text_parts: list[str] = []
        tool_calls: list[dict] | None = None

        while True:
            text_parts = []
            tool_calls = None
            try:
                for ev in client.chat_stream(messages, tools=reg.definitions()):
                    if ev["type"] == "text":
                        text_parts.append(ev["text"])
                        yield AgentEvent("token", {"text": ev["text"]})
                    elif ev["type"] == "reasoning":
                        yield AgentEvent("reasoning", {"text": ev["text"]})
                    elif ev["type"] == "tool_calls":
                        tool_calls = ev["tool_calls"]
                # 每次调用后累计用量（缓存命中率/成本）与耗时（首字延迟/总耗时/tokens 速度）
                if client.last_usage:
                    stats = store.add_usage(db, session, client.last_usage)
                    yield AgentEvent("usage", {
                        "call": dict(client.last_usage),
                        "timing": dict(client.last_timing),
                        **stats,
                    })
                break
            except Exception as exc:  # noqa: BLE001
                # 兜底一：工具消息序列非法（窗口裁剪/会话中断）→ 用无工具历史重试一次
                if context.is_tool_sequence_error(exc) and not tool_free_retry:
                    tool_free_retry = True
                    messages = _build_messages(session, system_prompt, tool_free=True)
                    yield AgentEvent("compaction", {
                        "phase": "skipped",
                        "reason": "工具消息序列异常，已改用精简上下文重试",
                    })
                    continue
                # 兜底二：上下文超限 → 强制压缩一次并重试（DSH overflow recovery）
                if context.is_overflow_error(exc) and settings.compaction_enabled:
                    forced = False
                    for ev in _maybe_compact(db, session, client, reg, messages, force=True):
                        yield ev
                        forced = True
                    if forced:
                        messages = _build_messages(session, system_prompt, tool_free=tool_free_retry)
                        continue
                yield AgentEvent("error", {"message": f"模型调用失败：{exc}"})
                return

        if tool_calls:
            store.append(db, session, {
                "role": "assistant",
                "content": "".join(text_parts),
                "tool_calls": tool_calls,
            })
            readonly_batch: list[tuple[dict, str, dict]] = []
            for tc in tool_calls:
                fn = tc.get("function", {})
                name = fn.get("name", "")
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = {}
                tool = reg.get(name)
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

                if tool is not None and not tool.read_only:
                    # 写操作：顺序执行（避免并发写库）
                    t_tool = time.perf_counter()
                    result = reg.call(name, args, db)
                    yield _tool_result_event(db, session, tc, name, result,
                                             int((time.perf_counter() - t_tool) * 1000))
                    continue
                readonly_batch.append((tc, name, args))

            # 只读工具：同一轮内的多个调用并行执行（如同时分析两家企业的财务）
            if len(readonly_batch) == 1:
                tc, name, args = readonly_batch[0]
                t_tool = time.perf_counter()
                result = reg.call(name, args, db)
                yield _tool_result_event(db, session, tc, name, result,
                                         int((time.perf_counter() - t_tool) * 1000))
            elif len(readonly_batch) > 1:
                yield from _run_parallel(db, session, reg, readonly_batch)
            continue

        final_text = "".join(text_parts)
        store.append(db, session, {"role": "assistant", "content": final_text})
        yield AgentEvent("done", {
            "session_id": session.id,
            "steps": step + 1,
            "title": session.title,
            "usage": store.usage_stats(session),
        })
        return

    yield AgentEvent("error", {"message": f"达到最大工具调用轮次（{MAX_STEPS}），请换一种问法"})
