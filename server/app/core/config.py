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
    llm_max_turns: int = 8      # Agent 循环上限（reasonmc 默认值）
    llm_short_term_window: int = 3  # 上下文中保留的最近轮数

    # --- 数据库（原型 SQLite；正式换 PostgreSQL） ---
    database_url: str = "sqlite:///./data/platform.db"


settings = Settings()
