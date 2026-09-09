# -*- coding: utf-8 -*-
"""LLM HTTP 400 根因定位与修复验证。

用法（server 目录）：.venv\\Scripts\\python.exe tests\\probe_llm_400.py
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

from app.agent.session import Session, sanitize_tool_pairs, store
from app.db.database import SessionLocal, init_db
from app.llm.client import LlmClient, LlmConfig, LlmException
from app.services.settings_store import load_and_apply

init_db()
db = SessionLocal()
load_and_apply(db)

from app.core.config import settings  # noqa: E402

client = LlmClient(LlmConfig(
    base_url=settings.llm_base_url, api_key=settings.llm_api_key,
    model=settings.llm_model, max_tokens=64,
))

SYS = {"role": "system", "content": "你是测试助手，只需回复 ok。"}
TOOL_CALL = {"id": "call_1", "type": "function",
             "function": {"name": "search_enterprise", "arguments": '{"keyword": "600518"}'}}


def call_api(name: str, messages: list[dict]) -> None:
    try:
        msg = client.chat(messages)
        print(f"  [{name}] OK -> {str(msg.get('content'))[:40]!r}")
    except LlmException as exc:
        print(f"  [{name}] FAIL status={exc.status_code} :: {str(exc)[:200]}")


print("== 一、根因确认（直接构造非法序列）==")
call_api("合法工具对", [SYS, {"role": "user", "content": "查 600518"},
                    {"role": "assistant", "content": "", "tool_calls": [TOOL_CALL]},
                    {"role": "tool", "tool_call_id": "call_1", "content": "{}"},
                    {"role": "user", "content": "只回复 ok"}])
call_api("孤立 tool", [SYS, {"role": "tool", "tool_call_id": "call_1", "content": "{}"},
                    {"role": "user", "content": "只回复 ok"}])
call_api("assistant.tool_calls 缺结果", [SYS, {"role": "user", "content": "查 600518"},
                                     {"role": "assistant", "content": "", "tool_calls": [TOOL_CALL]},
                                     {"role": "user", "content": "只回复 ok"}])
call_api("空 assistant 消息", [SYS, {"role": "user", "content": "你好"},
                           {"role": "assistant", "content": ""},
                           {"role": "user", "content": "只回复 ok"}])
call_api("连续两条 user", [SYS, {"role": "user", "content": "你好"},
                        {"role": "user", "content": "只回复 ok"}])
call_api("首条不是 user（assistant 开头）", [SYS, {"role": "assistant", "content": "你好"},
                                      {"role": "user", "content": "只回复 ok"}])

print("\n== 二、窗口裁剪复现（14 条消息 → 最近 12 条从 tool 开始）==")
s = Session(id="probe")
seq = [
    ("user", "第一问"), ("assistant_tool", "c1"), ("tool", "c1"), ("assistant", "答一"),
    ("user", "第二问"), ("assistant_tool", "c2"), ("tool", "c2"), ("assistant", "答二"),
    ("user", "第三问"), ("assistant_tool", "c3"), ("tool", "c3"), ("assistant", "答三"),
    ("user", "复杂问题：为什么毛利率低"), ("assistant_tool", "c4"),
]
for i, (kind, payload) in enumerate(seq, start=1):
    if kind == "assistant_tool":
        s.messages.append({"id": i, "role": "assistant", "content": "", "tool_calls": [
            {"id": payload, "type": "function",
             "function": {"name": "get_financial_analysis", "arguments": "{}"}}]})
    elif kind == "tool":
        s.messages.append({"id": i, "role": "tool", "tool_call_id": payload, "content": '{"ok": true}'})
    else:
        s.messages.append({"id": i, "role": kind, "content": payload})

raw_window = s.messages[-12:]
print(f"  修复前窗口首条: {raw_window[0]['role']}（孤立 tool → 400）")

ctx = store.context(s)
roles = [m["role"] for m in ctx if m["role"] != "system"]
print(f"  修复后窗口角色: {roles}")
print(f"  修复后首条是否为 tool: {roles[0] == 'tool'}")
call_api("修复后的窗口上下文", [SYS, *ctx, {"role": "user", "content": "只回复 ok"}])

print("\n== 三、会话中断（assistant.tool_calls 缺结果）自愈 ==")
broken = [
    {"role": "user", "content": "查 600518"},
    {"role": "assistant", "content": "", "tool_calls": [TOOL_CALL]},
]
fixed = sanitize_tool_pairs(broken)
print("  补齐后:", [m["role"] for m in fixed])
call_api("补齐后的上下文", [SYS, *fixed, {"role": "user", "content": "只回复 ok"}])

print("\n== 四、tool_free 兜底上下文 ==")
free_ctx = store.context(s, tool_free=True)
print("  tool_free 角色:", [m["role"] for m in free_ctx if m["role"] != "system"])
call_api("tool_free 上下文", [SYS, *free_ctx, {"role": "user", "content": "只回复 ok"}])

db.close()
