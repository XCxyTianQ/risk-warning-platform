"""风险研判服务（阶段2 纵向切片版）。

流程（reasonmc AgentLoop 的简化调用，阶段4 补全循环/记忆/窗口）：
  1. LLM(带工具) → 返回 tool_calls → 执行工具并回注 → 再调用
  2. LLM 输出严格 JSON 研判结论（level/维度/证据/综述）
  3. 规则引擎交叉校验（不一致标 mismatch，以规则为准）
  4. 证据写入 risk_fact（供前端展示与人工复核）

数据流：GET /api/enterprise/{id}/risk 直接读风险事实与指标快照；
        POST /api/enterprise/{id}/analyze 触发上面的研判。
"""

import json
import re

from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models import Enterprise, RiskFact
from app.llm.client import LlmClient, LlmConfig
from app.llm.tools import build_data_tools
from app.services.rules import rules_verdict

RISK_SYSTEM = (
    "你是企业经营风险研判分析师。你将获得企业的工商档案、财务、法律（涉诉/行政）、舆情数据。"
    "请先调用工具获取数据，再基于“六维评分规则”给出风险研判。"
    "六个维度：finance 财务健康、legal 法律合规、news 舆情声誉、operation 经营能力、"
    "credit 信用状况、supply 供应链稳定；每维度 0~100 分（越高越健康）。"
    "最终回复必须是一个严格的 JSON 对象，不要包含任何解释文字。JSON 格式：\n"
    '{"level":"red|orange|yellow|green","summary":"一句话结论",'
    '"dimensions":{"finance":{"level":"...","score":0-100,"reason":"..."},'
    '"legal":{"...":"..."},"news":{"...":"..."},"operation":{"...":"..."},'
    '"credit":{"...":"..."},"supply":{"...":"..."}},'
    '"evidence":[{"dimension":"finance|legal|news|operation|credit|supply","text":"事实描述","source":"来源","date":"YYYY-MM-DD"}]}\n'
    "level 取值：red=高风险，orange=较高风险，yellow=关注，green=正常，gray=数据不足。"
    "证据必须逐条来自工具返回的数据，不得编造。"
)


def _llm_client(max_tokens: int | None = None) -> LlmClient:
    return LlmClient(
        LlmConfig(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            model=settings.llm_model,
            max_tokens=max_tokens or settings.llm_max_tokens,
            disable_thinking=settings.llm_disable_thinking,
        )
    )


def _extract_json(text: str) -> dict | None:
    """容忍 ```json 围栏 / 前后杂文的 JSON 提取。"""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if m:
        text = m.group(1)
    s, e = text.find("{"), text.rfind("}")
    if s == -1 or e == -1 or e <= s:
        return None
    try:
        obj = json.loads(text[s : e + 1])
        return obj if isinstance(obj, dict) else None
    except ValueError:
        return None


def _run_agent(reg, client: LlmClient, ent: Enterprise) -> tuple[str, dict | None]:
    messages = [
        {"role": "system", "content": RISK_SYSTEM},
        {"role": "user", "content": f"请对【{ent.name}】（{ent.industry or '工商注册中'}）进行经营风险研判，先调用工具获取数据，再输出结论 JSON。JSON 必须完整，evidence 最多 8 条。"},
    ]
    final_text = ""
    for _ in range(2):  # 阶段2：至多一轮工具 + 一轮结论
        msg = client.chat(messages, tools=reg.tools_for_request())
        tool_calls = msg.get("tool_calls")
        if tool_calls:
            messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": tool_calls})
            for tc in tool_calls:
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = {}
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": reg.call(fn.get("name", ""), args),
                })
            continue
        final_text = msg.get("content") or ""
        break
    verdict = _extract_json(final_text)

    # 输出被截断/夹杂解释时，补一次"只输出完整 JSON"的重试
    if verdict is None:
        messages.append({"role": "assistant", "content": final_text})
        messages.append({
            "role": "user",
            "content": "上面的输出不是完整 JSON。请只输出一个完整 JSON 对象（不要任何解释），"
                       "字段 level/summary/dimensions/evidence，evidence 最多 6 条、每条不超过 60 字。",
        })
        try:
            retry = client.chat(messages, tools=None)
            final_text = retry.get("content") or final_text
            verdict = _extract_json(final_text)
        except Exception:  # noqa: BLE001 —— 重试失败则退回原始文本
            pass
    return final_text, verdict


def analyze_enterprise(db: Session, enterprise_id: int) -> dict:
    ent = db.get(Enterprise, enterprise_id)
    if ent is None:
        raise KeyError(enterprise_id)

    reg = build_data_tools(db, enterprise_id)
    client = _llm_client(max_tokens=settings.llm_analysis_max_tokens)
    raw_text, llm_verdict = _run_agent(reg, client, ent)

    rules = rules_verdict(db, enterprise_id)
    llm_level = (llm_verdict or {}).get("level", "")
    if llm_level not in ("red", "orange", "yellow", "green"):
        llm_level = "unknown"
    cross_check = llm_level == rules["level"]
    # 阶段2 策略：规则为准
    final_level = rules["level"] if not cross_check else llm_level

    # 证据落库 risk_fact（证据来源：LLM 提取 + 规则指标兜底）
    evidence = (llm_verdict or {}).get("evidence", [])
    if isinstance(evidence, list) and evidence:
        for ev in evidence:
            if not isinstance(ev, dict):
                continue
            db.add(RiskFact(
                enterprise_id=enterprise_id,
                dimension=str(ev.get("dimension", "other"))[:30],
                text=str(ev.get("text", ""))[:1000],
                evidence_json=json.dumps({"source": ev.get("source", ""), "date": ev.get("date", "")}, ensure_ascii=False),
                confidence=0.8,
            ))
    db.commit()

    # 研判完成 → 触发预警工单（闭环起点）
    try:
        from app.services.alerts import generate_for_enterprise

        generate_for_enterprise(db, enterprise_id, source="analysis")
    except Exception:  # noqa: BLE001 —— 预警生成失败不影响研判结果
        pass

    return {
        "enterprise": {
            "id": ent.id, "name": ent.name, "legal_rep": ent.legal_rep,
            "reg_date": ent.reg_date, "industry": ent.industry, "data_note": ent.data_note,
        },
        "verdict": {
            "level": final_level,
            "score": rules["score"],
            "grade": rules["grade"],
            "grade_label": rules["grade_label"],
            "level_by": "rules" if not cross_check else "llm",
            "cross_check_ok": cross_check,
            "llm_level": llm_level,
            "rules_level": rules["level"],
            "dimensions": rules["dimensions"],
            "summary": (llm_verdict or {}).get("summary", raw_text[:500]),
            "evidence": evidence,
        },
    }


def risk_snapshot(db: Session, enterprise_id: int) -> dict:
    """读侧快照：风险事实 + 指标（不触发 LLM 调用，页面刷新用）。"""
    ent = db.get(Enterprise, enterprise_id)
    if ent is None:
        raise KeyError(enterprise_id)
    rules = rules_verdict(db, enterprise_id)
    facts = (
        db.query(RiskFact)
        .filter(RiskFact.enterprise_id == enterprise_id)
        .order_by(RiskFact.ts.desc())
        .limit(50)
        .all()
    )
    return {
        "enterprise": {"id": ent.id, "name": ent.name},
        "verdict_level": rules["level"],
        "score": rules["score"],
        "grade": rules["grade"],
        "grade_label": rules["grade_label"],
        "dimensions": rules["dimensions"],
        "facts": [
            {
                "dimension": f.dimension,
                "text": f.text,
                "evidence": json.loads(f.evidence_json) if f.evidence_json else {},
                "confidence": f.confidence,
                "ts": f.ts.isoformat(),
            }
            for f in facts
        ],
    }
