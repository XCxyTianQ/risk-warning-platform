"""工具注册表骨架 —— 设计照搬 reasonmc McpTools。

接口：
- register(name, schema, handler)：注册工具（schema 为 OpenAI function 格式）
- definitions()：全部工具 schema（调试/文档用）
- tools_for_request()：随 body 发送的 tools 数组
- call(name, args) -> str：按名分发执行；未知工具 / 执行异常 → 返回 "ERROR: ..."
  （不回抛，让 LLM 自行决定下一步 —— reasonmc 同款策略）

TODO(步骤2)：注册首批工具（get_finance_data / get_legal_records / get_news / get_rules）；
仅白名单内的工具可被 LLM 调用（防 prompt 注入）。
"""

import json


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, tuple[dict, object]] = {}

    def register(self, name: str, schema: dict, handler) -> None:
        if name in self._tools:
            raise ValueError(f"tool already registered: {name}")
        self._tools[name] = (schema, handler)

    def definitions(self) -> list[dict]:
        return [t[0] for t in self._tools.values()]

    def tools_for_request(self) -> list[dict]:
        return self.definitions()

    def call(self, name: str, args: dict) -> str:
        entry = self._tools.get(name)
        if entry is None:
            return f"ERROR: unknown tool {name}"
        try:
            result = entry[1](args)
            if isinstance(result, (dict, list)):
                return json.dumps(result, ensure_ascii=False)
            return str(result)
        except Exception as exc:  # noqa: BLE001 —— 回注错误文本，不中断 Agent 循环
            return f"ERROR: {exc}"
