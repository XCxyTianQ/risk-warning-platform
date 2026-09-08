"""风险研判 Agent 骨架 —— 设计照搬 reasonmc AgentLoop.java。

TODO(步骤4)：实现 turn() 循环：
  user(企业/维度请求) → LLM(带工具) → tool_calls → 逐个执行并回注 → 再调用
  → 直到 LLM 返回纯文本回复（max_turns 上限）。

设计要点（照搬 reasonmc，详见 docs/reasonmc-调研.md）：
- 上下文恒定：system_prompt + [长期记忆/企业事实块] + 最近 N 轮窗口，体积不膨胀；
- chat_with_retry：指数退避 500ms→1s，仅对 retryable() 错误重试；
- 工具执行异常回注 "ERROR: ..." 不中断；返回最终文本回复；
- 每轮结束 MemoryExtractor 增量提取新事实 → MemoryStore 合并落盘（步骤2 逐步接入）。
"""


class RiskAgent:
    """单企业风险研判 Agent（骨架；接口签名先定，实现留步骤4）。"""

    def __init__(self, llm, tools, memory=None):
        self._llm = llm
        self._tools = tools
        self._memory = memory

    def turn(self, prompt: str) -> str:
        raise NotImplementedError("步骤4 实现：参考 reasonmc AgentLoop.turn()")
