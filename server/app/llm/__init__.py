"""大模型接入层（骨架）。

模块定位（源自 docs/reasonmc-调研.md）：
- client.py   OpenAI 兼容 LLM 网关（三参数 + 错误分档 + 解析防御）
- tools.py    工具注册表（definitions / call 分发，白名单）
- agent.py    风险研判 Agent 循环（tool_calls → 执行 → 回注，恒定上下文）
- memory.py   企业风险信号事实库（增量提取 + 去重 + 原子写盘，步骤2 实现）
"""
