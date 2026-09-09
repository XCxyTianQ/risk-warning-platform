"""上下文压缩（compaction）——对齐 DeepSeek Harness 的两条核心设计。

1. **前缀缓存复用**（DSH 2026-07-21 笔记）：提供方按请求 token 序列的**前缀**做 KV Cache。
   如果摘要调用另起一个"摘要器 system 提示词"，第一个 token 就不同 → 整个已缓存前缀失效，
   恰好在对话最大时为整段历史付出两次全价。
   正确做法：**逐字复现最近一次已路由请求的前缀（system + tools + 历史），
   在末尾追加一条 user 压缩指令**，让摘要调用成为已预热请求的前缀扩展。
   tools 也必须一起带上——省略它们会缩短 token 序列，破坏对齐。

2. **压缩策略**（DSH 2026-07-20 笔记）：`thresholdRatio=0.8` 触发、`retainRatio=0.16` 保留，
   容量由模型决定，策略可逐目标覆盖。本实现把阈值/保留比例放在 config（模型容量也在 config）。
"""

import json

from sqlalchemy.orm import Session as DbSession

from app.agent.session import Session, store
from app.core.config import settings
from app.llm.client import LlmClient

# 尾部压缩指令（DSH：指令必须在末尾，不能另起 system 提示词）
COMPACTION_INSTRUCTION = (
    "你现在是压缩引擎（compaction engine）。请把上面的对话浓缩成一份可继续工作的检查点，"
    "只保留：用户目标与约束、已确认的事实与数据（企业名称/评分/预警编号）、工具调用结论、未完成的待办。"
    "要求：不要提及本次摘要请求；不要调用任何工具；只输出检查点正文；不超过 400 字；用中文。"
)

OVERFLOW_HINTS = (
    "context length", "context_length_exceeded", "maximum context", "too many tokens",
    "exceed", "上下文长度", "token limit",
)


def estimate_tokens(messages: list[dict], tools: list[dict] | None = None) -> int:
    """粗估 token 压力（中文约 1 字≈0.7 token，英文约 4 字符≈1 token，保守取字符/1.6）。"""
    total = 0
    for m in messages:
        content = m.get("content") or ""
        if isinstance(content, (list, dict)):
            content = json.dumps(content, ensure_ascii=False)
        total += int(len(str(content)) / 1.6) + 6
        for tc in m.get("tool_calls") or []:
            total += int(len(json.dumps(tc, ensure_ascii=False)) / 2.5) + 4
    for t in tools or []:
        total += int(len(json.dumps(t, ensure_ascii=False)) / 2.5) + 4
    return total


def should_compact(messages: list[dict], tools: list[dict] | None = None) -> tuple[bool, int]:
    """是否达到压缩压力阈值（DSH thresholdRatio，默认 0.8）。"""
    est = estimate_tokens(messages, tools)
    threshold = int(settings.llm_context_window * settings.compaction_threshold_ratio)
    return est >= threshold, est


def is_overflow_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(h in text for h in OVERFLOW_HINTS)


TOOL_SEQUENCE_HINTS = (
    "role 'tool'", 'role "tool"', "tool_calls", "tool messages", "tool_call_id",
)


def is_tool_sequence_error(exc: Exception) -> bool:
    """是否为"工具消息序列不合法"类 400（可退化为无工具上下文重试一次）。"""
    text = str(exc).lower()
    if "400" not in text:
        return False
    return any(h in text for h in TOOL_SEQUENCE_HINTS)


def _split_for_compaction(session: Session) -> tuple[list[dict], int]:
    """按 retainRatio 切分：返回 (待折叠消息, 折叠到的消息 id)。

    待折叠 = 压缩点之后、保留预算之外的最早一段（保持 tool 调用配对完整）。
    """
    active = [m for m in session.messages if (m.get("id") or 0) > session.compacted_until]
    if len(active) <= 2:
        return [], 0

    retain_budget = int(settings.llm_context_window * settings.compaction_retain_ratio)
    # 从后往前累计，直到超过保留预算
    kept: list[dict] = []
    used = 0
    for m in reversed(active):
        used += estimate_tokens([m])
        if used > retain_budget and kept:
            break
        kept.insert(0, m)
    cut_index = len(active) - len(kept)
    if cut_index <= 0:
        return [], 0

    fold = active[:cut_index]
    # 保证不在 assistant(tool_calls) 与 tool 结果之间切断
    while fold and fold[-1].get("role") == "assistant" and fold[-1].get("tool_calls"):
        fold.pop()
    if not fold:
        return [], 0
    return fold, fold[-1].get("id") or 0


def compact(db: DbSession, session: Session, client: LlmClient, base_messages: list[dict], tools: list[dict]) -> dict | None:
    """执行压缩。base_messages 必须是"最近一次已路由请求"的完整前缀（system + 历史）。

    返回 {"summary": str, "until_id": int, "folded": int, "usage": {...}} 或 None（无需/失败）。
    """
    fold, until_id = _split_for_compaction(session)
    if not fold or not until_id:
        return None

    # ★ 缓存友好：完整复现前缀 + 尾部追加压缩指令（不新建 system，不带省略 tools）
    messages = [*base_messages, {"role": "user", "content": COMPACTION_INSTRUCTION}]
    try:
        msg = client.chat(messages, tools=tools, max_tokens=settings.compaction_summary_max_tokens)
    except Exception:  # noqa: BLE001 —— 压缩失败不阻塞对话
        return None

    summary = (msg.get("content") or "").strip()
    if not summary:
        return None

    store.set_summary(db, session, summary, until_id)
    return {
        "summary": summary,
        "until_id": until_id,
        "folded": len(fold),
        "usage": dict(client.last_usage),
    }
