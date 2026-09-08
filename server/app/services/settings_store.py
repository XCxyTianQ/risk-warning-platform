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
    "模型与接入": [
        {"key": "llm_base_url", "label": "API 地址", "type": "text", "desc": "OpenAI 兼容端点，如 https://api.deepseek.com/v1"},
        {"key": "llm_model", "label": "模型名称", "type": "text", "desc": "如 deepseek-v4-flash-vision-exp / deepseek-v4-pro"},
        {"key": "llm_api_key", "label": "API Key", "type": "password", "desc": "仅保存在本地 .env 与数据库，不会回传明文"},
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
    "缓存与成本": [
        {"key": "preheat_enabled", "label": "启用缓存预热", "type": "bool", "desc": "用相同 system+tools 预热静态前缀"},
        {"key": "preheat_on_startup", "label": "启动时预热", "type": "bool", "desc": "服务启动后台线程预热"},
        {"key": "preheat_ttl_seconds", "label": "预热新鲜期(秒)", "type": "int", "desc": "期内不重复预热"},
        {"key": "price_cache_hit", "label": "缓存命中价", "type": "float", "desc": "元 / 百万 token"},
        {"key": "price_cache_miss", "label": "缓存未命中价", "type": "float", "desc": "元 / 百万 token"},
        {"key": "price_output", "label": "输出价", "type": "float", "desc": "元 / 百万 token"},
    ],
    "动作审批": [
        {"key": "agent_require_approval", "label": "动作工具需授权", "type": "bool", "desc": "写操作（刷新数据/研判/处置预警）执行前需用户确认"},
        {"key": "agent_approval_timeout", "label": "授权超时(秒)", "type": "int", "desc": "超时视为拒绝"},
    ],
}

_MASK = "••••••••"


def _mask(value: str) -> str:
    if not value:
        return ""
    return value[:6] + _MASK[2:] + value[-4:] if len(value) > 12 else _MASK


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
        "runtime": {
            "model": settings.llm_model,
            "context_window": settings.llm_context_window,
            "preheat_enabled": settings.preheat_enabled,
            "compaction_enabled": settings.compaction_enabled,
            "require_approval": settings.agent_require_approval,
        },
    }


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
                if not value or _MASK in str(value):
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
