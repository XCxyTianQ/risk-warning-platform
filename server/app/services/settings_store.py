"""运行时设置：DB 覆盖 + 前端展示元数据。

- 配置默认值来自 `app.core.config.Settings`
- 用户在设置面板修改后写入 `app_setting` 表，并在运行时覆盖 settings 字段（立即生效）
- 敏感字段（API Key）只回显掩码，不回传明文
"""

import json
from datetime import datetime

from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, Session as DbSession, mapped_column

from app.core.config import settings
from app.db.database import Base


class AppSetting(Base):
    __tablename__ = "app_setting"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(default=datetime.utcnow)


# 可编辑字段元数据：分组 → [字段]
FIELDS: dict[str, list[dict]] = {
    "模型服务": [
        {"key": "llm_base_url", "label": "API 地址", "type": "text", "desc": "OpenAI 兼容端点；选择提供商后自动填入"},
        {"key": "llm_api_key", "label": "API Key", "type": "password", "desc": "仅保存在本地，不会回传明文"},
        {"key": "llm_model", "label": "模型名称", "type": "text", "desc": "点击「获取可用模型」后从列表选择"},
        {"key": "llm_max_tokens", "label": "单次输出上限", "type": "int", "desc": "普通对话的 max_tokens"},
        {"key": "llm_analysis_max_tokens", "label": "研判输出上限", "type": "int", "desc": "风险研判（需输出完整 JSON）的 max_tokens"},
    ],
    "上下文与压缩": [
        {"key": "llm_context_window", "label": "上下文窗口", "type": "int", "desc": "模型窗口 token 数，压缩阈值按它缩放"},
        {"key": "compaction_enabled", "label": "启用自动压缩", "type": "bool", "desc": "上下文接近上限时把历史折叠为摘要"},
        {"key": "compaction_threshold_ratio", "label": "压缩触发比例", "type": "float", "desc": "用量 ≥ 窗口 × 该比例时触发（DSH 默认 0.8）"},
        {"key": "compaction_retain_ratio", "label": "压缩保留比例", "type": "float", "desc": "压缩后保留最近的比例（DSH 默认 0.16）"},
        {"key": "compaction_summary_max_tokens", "label": "摘要输出上限", "type": "int", "desc": "生成摘要的 max_tokens"},
    ],
    "动作审批": [
        {"key": "agent_require_approval", "label": "动作工具需授权", "type": "bool", "desc": "写操作（刷新数据/研判/处置预警）执行前需用户确认"},
        {"key": "agent_approval_timeout", "label": "授权超时(秒)", "type": "int", "desc": "超时视为拒绝"},
    ],
}

# 提供商预设（快速部署：选提供商 → 填 Key → 拉取模型）
PROVIDERS: list[dict] = [
    {"id": "deepseek", "label": "DeepSeek", "base_url": "https://api.deepseek.com/v1",
     "default_model": "deepseek-v4-flash-vision-exp", "key_hint": "sk-...", "note": "推荐：多模态 + 高缓存命中"},
    {"id": "openai", "label": "OpenAI", "base_url": "https://api.openai.com/v1",
     "default_model": "gpt-4o-mini", "key_hint": "sk-..."},
    {"id": "dashscope", "label": "阿里云百炼（通义千问）", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
     "default_model": "qwen-plus", "key_hint": "sk-..."},
    {"id": "zhipu", "label": "智谱 GLM", "base_url": "https://open.bigmodel.cn/api/paas/v4",
     "default_model": "glm-4-plus", "key_hint": "..."},
    {"id": "moonshot", "label": "月之暗面 Kimi", "base_url": "https://api.moonshot.cn/v1",
     "default_model": "moonshot-v1-8k", "key_hint": "sk-..."},
    {"id": "siliconflow", "label": "硅基流动 SiliconFlow", "base_url": "https://api.siliconflow.cn/v1",
     "default_model": "deepseek-ai/DeepSeek-V3", "key_hint": "sk-..."},
    {"id": "ollama", "label": "本地 Ollama", "base_url": "http://127.0.0.1:11434/v1",
     "default_model": "qwen2.5:7b", "key_hint": "可留空", "key_optional": True},
    {"id": "custom", "label": "其他（自定义 OpenAI 兼容端点）", "base_url": "",
     "default_model": "", "key_hint": "按需填写"},
]

MASK_CHAR = "•"


def _mask(value: str) -> str:
    if not value:
        return ""
    return value[:6] + MASK_CHAR * 6 + value[-4:] if len(value) > 12 else MASK_CHAR * 8


def get_view(db: DbSession) -> dict:
    groups = []
    for group, fields in FIELDS.items():
        items = []
        for f in fields:
            raw = getattr(settings, f["key"], None)
            if f["type"] == "password":
                items.append({**f, "value": _mask(str(raw or "")), "has_value": bool(raw)})
            else:
                items.append({**f, "value": raw})
        groups.append({"group": group, "items": items})
    return {
        "groups": groups,
        "providers": PROVIDERS,
        "runtime": {
            "model": settings.llm_model,
            "base_url": settings.llm_base_url,
            "context_window": settings.llm_context_window,
            "compaction_enabled": settings.compaction_enabled,
            "require_approval": settings.agent_require_approval,
            "has_api_key": bool(settings.llm_api_key),
        },
    }


def list_models(base_url: str, api_key: str | None = None) -> dict:
    """拉取提供商可用模型列表（OpenAI 兼容 /models）。"""
    import httpx

    url = (base_url or "").rstrip("/")
    if not url:
        return {"error": "请先选择提供商或填写 API 地址", "models": []}
    if not url.endswith("/v1") and "/v1" not in url:
        url = url + "/v1"
    headers = {}
    key = (api_key or "").strip()
    # 前端传回的是掩码或空值时，回退到已保存的 Key
    if not key or MASK_CHAR in key:
        key = (settings.llm_api_key or "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    try:
        with httpx.Client(timeout=30) as c:
            resp = c.get(url + "/models", headers=headers)
        if resp.status_code != 200:
            return {"error": f"HTTP {resp.status_code}: {resp.text[:200]}", "models": []}
        data = resp.json()
        items = data.get("data") or data.get("models") or []
        models = []
        for m in items:
            mid = m.get("id") or m.get("name") or m.get("model") if isinstance(m, dict) else str(m)
            if mid:
                models.append(mid)
        return {"models": sorted(set(models)), "count": len(models)}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}", "models": []}


def _coerce(field: dict, value):
    t = field["type"]
    if t == "bool":
        if isinstance(value, bool):
            return value
        return str(value).lower() in ("1", "true", "yes", "on")
    if t == "int":
        return int(value)
    if t == "float":
        return float(value)
    return str(value)


def update(db: DbSession, payload: dict) -> dict:
    """保存并立即生效。payload: {field_key: value}"""
    applied, errors = {}, []
    for group, fields in FIELDS.items():
        for f in fields:
            key = f["key"]
            if key not in payload:
                continue
            value = payload[key]
            if f["type"] == "password":
                if not value or MASK_CHAR in str(value):
                    continue  # 未修改
                value = str(value).strip()
            try:
                coerced = _coerce(f, value)
            except (TypeError, ValueError) as exc:
                errors.append(f"{f['label']}: {exc}")
                continue
            row = db.get(AppSetting, key)
            if row is None:
                db.add(AppSetting(key=key, value=json.dumps(coerced, ensure_ascii=False)))
            else:
                row.value = json.dumps(coerced, ensure_ascii=False)
                row.updated_at = datetime.utcnow()
            applied[key] = coerced
    db.commit()

    for key, value in applied.items():
        try:
            setattr(settings, key, value)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{key}: 应用失败 {exc}")

    # 切换模型/端点后重新预热前缀
    if any(k in applied for k in ("llm_model", "llm_base_url", "preheat_enabled")):
        try:
            from app.agent.prompt import SYSTEM_PROMPT
            from app.agent.tools import build_registry
            from app.llm.preheat import warmer

            if settings.preheat_enabled:
                warmer.warm_async(SYSTEM_PROMPT, build_registry().definitions(), label="settings", force=True)
        except Exception:  # noqa: BLE001
            pass

    return {"applied": applied, "errors": errors}


def load_and_apply(db: DbSession) -> dict:
    """启动时把 DB 中的覆盖值应用回 settings。"""
    applied = {}
    for row in db.query(AppSetting).all():
        for group, fields in FIELDS.items():
            for f in fields:
                if f["key"] != row.key:
                    continue
                try:
                    value = json.loads(row.value)
                    setattr(settings, row.key, value)
                    applied[row.key] = value
                except Exception:  # noqa: BLE001
                    pass
    return applied


def reset(db: DbSession) -> dict:
    """清除所有覆盖，回到 .env / 默认值（需重启生效）。"""
    db.query(AppSetting).delete()
    db.commit()
    return {"reset": True, "note": "已清除覆盖值，重启后端后完全恢复默认配置"}
