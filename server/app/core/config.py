"""应用配置（pydantic-settings）。

设计来源：reasonmc LlmClient 的三参数配置（base_url / api_key / model），
通过环境变量与 .env 注入，支持 mock → DeepSeek 等无缝切换（见 docs/reasonmc-调研.md）。
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_name: str = "risk-warning-platform"

    # --- LLM（OpenAI 兼容端点；默认指向本地 mock_llm.py） ---
    llm_base_url: str = "http://127.0.0.1:9000/v1"
    llm_api_key: str = "mock-key"
    llm_model: str = "mock"
    llm_max_tokens: int = 1024
    llm_analysis_max_tokens: int = 8192  # 风险研判输出（JSON + 推理 token 需要更大空间）
    llm_max_turns: int = 8      # Agent 循环上限（reasonmc 默认值）
    llm_short_term_window: int = 3  # 上下文中保留的最近轮数

    # --- Agent 审批（动作工具） ---
    agent_require_approval: bool = True   # 动作工具是否需用户确认
    agent_approval_timeout: int = 300     # 等待确认超时（秒），超时视为拒绝

    # --- 上下文压缩（对齐 DSH compaction 策略） ---
    llm_context_window: int = 128000      # 模型上下文窗口（token）
    compaction_enabled: bool = True
    compaction_threshold_ratio: float = 0.8   # 估算用量 ≥ 窗口×该比例时触发压缩
    compaction_retain_ratio: float = 0.16     # 压缩后保留最近的比例
    compaction_summary_max_tokens: int = 1024 # 摘要输出上限

    # --- 成本估算（每 100 万 token 单价，元；按 DeepSeek 缓存/未命中/输出计） ---
    price_cache_hit: float = 0.5
    price_cache_miss: float = 4.0
    price_output: float = 12.0

    # --- 数据库（原型 SQLite；正式换 PostgreSQL） ---
    database_url: str = "sqlite:///./data/platform.db"


settings = Settings()
