#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OpenAI 兼容 chat/completions 离线模拟器 —— 改编自 reasonmc cli/mock_llm.py。

用于在无 API Key、无网络时先跑通全链路（开发期烧 0 元、确定性输出）。
行为规则（确定性，按需求换了场景关键词）：

  - 最后一条消息是 tool（工具结果）→ 返回纯文本回复（总结结果）
  - user 含"财务"/"财报" → 返回 tool_calls: get_finance_data
  - user 含"涉诉"/"法律" → 返回 tool_calls: get_legal_records
  - user 含"舆情"/"新闻" → 返回 tool_calls: get_news
  - 其他 → 返回纯文本回复（复述）

用法：
    python mock_llm.py [--port 9000]

后端 .env：
    LLM_BASE_URL=http://127.0.0.1:9000/v1
    LLM_API_KEY=mock-key
    LLM_MODEL=mock
"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

MODEL = "mock"
SEQ = [0]


def build_message(content, tool_calls=None):
    m = {"role": "assistant", "content": content}
    if tool_calls:
        m["tool_calls"] = tool_calls
    return m


def tool_call(call_id, name, arguments):
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)},
    }


def decide(messages, tools):
    """根据会话内容决定 mock 回复（确定性）。"""
    last = messages[-1]
    if last.get("role") == "tool":
        content = (last.get("content") or "")[:200]
        return build_message(f"（mock LLM）收到工具结果：{content} —— 风险判断完成。")
    text = last.get("content") or ""
    if "财务" in text or "财报" in text:
        SEQ[0] += 1
        return build_message(None, [tool_call(f"call_{SEQ[0]}", "get_finance_data", {"enterprise": "样例企业"})])
    if "涉诉" in text or "法律" in text:
        SEQ[0] += 1
        return build_message(None, [tool_call(f"call_{SEQ[0]}", "get_legal_records", {"enterprise": "样例企业"})])
    if "舆情" in text or "新闻" in text:
        SEQ[0] += 1
        return build_message(None, [tool_call(f"call_{SEQ[0]}", "get_news", {"enterprise": "样例企业"})])
    return build_message(f"（mock LLM）你说了：{text[:100]}")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            messages = body.get("messages", [])
            tools = body.get("tools", [])
            msg = decide(messages, tools)
            resp = {
                "id": "chatcmpl-mock-1",
                "object": "chat.completion",
                "created": 0,
                "model": MODEL,
                "choices": [{"index": 0, "message": msg, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
            data = json.dumps(resp, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # noqa: BLE001
            data = json.dumps({"error": {"message": str(e)}}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description="OpenAI-compatible mock LLM server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9000)
    args = ap.parse_args()
    server = HTTPServer((args.host, args.port), Handler)
    print(f"[mock-llm] OpenAI-compatible server on http://{args.host}:{args.port}/v1/chat/completions")
    print(f"[mock-llm] base_url = http://127.0.0.1:{args.port}/v1  api_key = mock-key  model = mock")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[mock-llm] shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
