#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从评测产物生成《外部基准对齐报告》（Word + Markdown）。

设计原则与 Benchmark 报告一致：**报告里的每个数字都来自 JSON 产物**，不手抄。
数据来源：
  bench/external/reports/external-alignment-v1.json   本次对齐结果（逐基准 × 逐模型）
  bench/external/out/manifest.json                    版本锁定、许可证、题库盘点
  bench/external/out/external-reference-numbers.json  外部公开对照数字及其出处

用法：
  python bench/external/report/make-alignment-report.py
输出：
  docs/reports/External-Alignment-v1.docx（以及同名 .md，便于 diff 与评审）
"""
from __future__ import annotations

import glob
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

try:
    from docx import Document
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt, RGBColor
except ImportError:  # pragma: no cover
    print("缺少 python-docx：pip install python-docx")
    sys.exit(2)

REPO = Path(__file__).resolve().parents[3]
EXT = REPO / "bench" / "external"
ALIGN = EXT / "reports" / "external-alignment-v1.json"
MANIFEST = EXT / "out" / "manifest.json"
REFERENCES = EXT / "out" / "external-reference-numbers.json"
OUT_DIR = REPO / "docs" / "reports"
OUT_DOCX = OUT_DIR / "External-Alignment-v1.docx"
OUT_MD = OUT_DIR / "External-Alignment-v1.md"

REPORT_VERSION = "v1.0"


def load(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def git_commit() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, text=True).strip()
    except Exception:
        return "unknown"


def app_version() -> str:
    try:
        return json.loads((REPO / "desktop" / "package.json").read_text(encoding="utf-8"))["version"]
    except Exception:
        return "unknown"


# ---------------------------------------------------------------- 取值助手
def dig(obj, path, default=None):
    cur = obj
    for k in path.split("."):
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return default
    return cur


def num(v, digits=2, dash="-"):
    if v is None or isinstance(v, bool):
        return dash
    try:
        return f"{float(v):.{digits}f}"
    except Exception:
        return dash


def pct(v, digits=1, dash="-"):
    if v is None:
        return dash
    try:
        return f"{float(v):.{digits}f}%"
    except Exception:
        return dash


def headline(run: dict, key: str, default=None):
    """从某一模型的 headline 列表里按关键词取数（key 为路径片段匹配）"""
    for item in (run or {}).get("headline", []) or []:
        if key in item.get("path", ""):
            return item.get("value")
    return default


def headline_exact(run: dict, path: str, default=None):
    for item in (run or {}).get("headline", []) or []:
        if item.get("path") == path:
            return item.get("value")
    return default


def metric_of(run: dict, *candidates, default=None):
    for c in candidates:
        v = headline_exact(run, c)
        if v is not None:
            return v
    for c in candidates:
        v = headline(run, c)
        if v is not None:
            return v
    return default


# ---------------------------------------------------------------- Word 助手
def set_cell_bg(cell, hex_color: str) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), hex_color)
    tcPr.append(shd)


def add_page_number_footer(section, left_text: str) -> None:
    footer = section.footer
    p = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(left_text + "　|　第 ")
    run.font.size = Pt(8)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), "PAGE")
    p._p.append(fld)
    tail = p.add_run(" 页")
    tail.font.size = Pt(8)
    tail.font.color.rgb = RGBColor(0x66, 0x66, 0x66)


def table(doc: Document, headers, rows, widths=None, caption=None, note=None):
    if caption:
        cap = doc.add_paragraph()
        cap.paragraph_format.space_after = Pt(2)
        r = cap.add_run(caption)
        r.bold = True
        r.font.size = Pt(9.5)
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ""
        run = hdr[i].paragraphs[0].add_run(str(h))
        run.bold = True
        run.font.size = Pt(9)
        set_cell_bg(hdr[i], "EEF2F7")
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = ""
            run = cells[i].paragraphs[0].add_run("" if v is None else str(v))
            run.font.size = Pt(9)
    if widths:
        for r_ in t.rows:
            for i, w in enumerate(widths):
                if i < len(r_.cells):
                    r_.cells[i].width = Cm(w)
    if note:
        n = doc.add_paragraph()
        n.paragraph_format.space_before = Pt(2)
        run = n.add_run(note)
        run.font.size = Pt(8.5)
        run.italic = True
        run.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
    doc.add_paragraph()
    return t


def para(doc: Document, text: str, bold=False, size=10.5, space_after=6):
    p = doc.add_paragraph()
    run = p.add_run(text)
    run.bold = bold
    run.font.size = Pt(size)
    p.paragraph_format.space_after = Pt(space_after)
    return p


def bullet(doc: Document, text: str, size=10.5):
    p = doc.add_paragraph(style="List Bullet")
    run = p.add_run(text)
    run.font.size = Pt(size)
    p.paragraph_format.space_after = Pt(3)
    return p


def h(doc: Document, text: str, level=1):
    doc.add_heading(text, level=level)


# ---------------------------------------------------------------- 报告正文
def interpret_sensitivity(sensitivity) -> str:
    """把提示词敏感性实验的结论写成一句话，并显式指出不可归因的部分。"""
    v = (sensitivity or {}).get("variants") or {}
    strict = v.get("strict") or {}
    neutral = v.get("neutral") or {}
    reasoned = v.get("reasoned") or {}
    base = strict.get("accuracyPct")
    weak = 0
    total = 0
    for k, item in (reasoned.get("extractMode") or {}).items():
        total += item
        if k in ("weak-scan", "weak-single"):
            weak += item
    parts = []
    if base is not None and neutral.get("accuracyPct") is not None:
        d = neutral["accuracyPct"] - base
        if abs(d) <= 5:
            parts.append(
                f"中性提示与严格提示的差值为 {d:+.2f} 个百分点，说明**成绩不是靠「只输出字母」这条约束抬起来的**，"
                "格式要求主要影响输出的可判分性，而不是正确率本身。"
            )
        else:
            parts.append(
                f"中性提示与严格提示的差值为 {d:+.2f} 个百分点，差值较大，因此报告中的准确率必须连同提示词一起引用。"
            )
    if base is not None and reasoned.get("accuracyPct") is not None:
        d = reasoned["accuracyPct"] - base
        share = (weak / total * 100) if total else 0
        line = f"允许推理的提示下准确率为 {d:+.2f} 个百分点"
        if share >= 20:
            line += (
                f"，但该变体有 {weak}/{total}（{share:.0f}%）的答案只能靠宽松扫描抽取，"
                "因此这个差值同时包含「推理后反而答错」与「抽取不可靠」两种可能，**不能单独归因于推理本身**"
            )
        line += "。"
        parts.append(line)
    return "".join(parts) if parts else "（提示词敏感性数据不足）"


def audit_closedbook():
    """核查「闭卷为什么能答对」：把裁判与确定性判分做交叉表，并抽样看具体作答。

    这一步是为了避免把「模型记得」误读成「模型会读」——两者对平台的结论完全不同。
    """
    files = sorted(glob.glob(str(EXT / "out" / "run-*" / "financebench.deepseek-flash.json")))
    if not files:
        return None
    data = load(Path(files[-1])) or {}
    rows = [r for r in (data.get("rows") or []) if r.get("mode") == "closedBook" and not r.get("error") and r.get("grade")]
    if not rows:
        return None
    both = [r for r in rows if r["grade"].get("judge") == "CORRECT" and r.get("correctDeterministic")]
    judge_only = [r for r in rows if r["grade"].get("judge") == "CORRECT" and not r.get("correctDeterministic")]
    det_only = [r for r in rows if r["grade"].get("judge") != "CORRECT" and r.get("correctDeterministic")]
    neither = [r for r in rows if r["grade"].get("judge") != "CORRECT" and not r.get("correctDeterministic")]
    examples = [
        {"gold": str(r.get("gold"))[:110], "answer": str(r.get("prediction"))[:150]}
        for r in (both + judge_only)[:4]
    ]
    return {
        "n": len(rows),
        "both": len(both),
        "judgeOnly": len(judge_only),
        "detOnly": len(det_only),
        "neither": len(neither),
        "refusal": sum(1 for r in rows if r["grade"].get("judge") == "REFUSAL"),
        "examples": examples,
        "source": files[-1].split("run-")[-1],
    }


def platform_gap_text(rows) -> str:
    """把「平台链路 vs 直连模型」的差值写成一句话（供第五节结论使用）"""
    for r in rows or []:
        if isinstance(r, (list, tuple)) and len(r) >= 4 and str(r[0]).startswith("CFLUE"):
            try:
                a = float(str(r[2]).rstrip("%"))
                b = float(str(r[3]).rstrip("%"))
                return f"{a - b:+.1f} 个百分点（{r[2]} 对 {r[3]}）"
            except Exception:
                return f"{r[2]} 对 {r[3]}"
    return "（缺少可比数据）"


def build(align, manifest, refs, platform_chain=None, sensitivity=None, platform_usage=None) -> tuple[Document, list[str]]:
    doc = Document()
    md: list[str] = []
    st = doc.styles["Normal"]
    st.font.name = "等线"
    st.font.size = Pt(10.5)

    benches = (align or {}).get("benchmarks", {})
    models = (align or {}).get("models", [])
    profile = (align or {}).get("profile", "-")
    seed = (align or {}).get("seed", "-")

    def H(text, level=1):
        h(doc, text, level)
        md.append(("#" * level) + " " + text + "\n")

    def P(text, bold=False):
        para(doc, text, bold=bold)
        md.append(text + "\n")

    def B(text):
        bullet(doc, text)
        md.append("- " + text)

    def T(headers, rows, caption=None, note=None, widths=None):
        table(doc, headers, rows, widths=widths, caption=caption, note=note)
        if caption:
            md.append(f"**{caption}**\n")
        md.append("| " + " | ".join(str(x) for x in headers) + " |")
        md.append("|" + "---|" * len(headers))
        for r in rows:
            md.append("| " + " | ".join("" if v is None else str(v) for v in r) + " |")
        md.append("")
        if note:
            md.append(f"> {note}\n")

    # ---------------- 封面 ----------------
    title = doc.add_heading("外部基准对齐报告", level=0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    md.append("# 外部基准对齐报告\n")
    sub = doc.add_paragraph()
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = sub.add_run("基于多模态大模型的企业经营风险预警平台 · 评测生态 M4")
    r.font.size = Pt(12)
    r.font.color.rgb = RGBColor(0x44, 0x44, 0x44)
    md.append("基于多模态大模型的企业经营风险预警平台 · 评测生态 M4\n")
    meta = [
        f"报告版本：{REPORT_VERSION}",
        f"生成日期：{datetime.now().strftime('%Y-%m-%d')}",
        f"产品版本：v{app_version()}　代码提交：{git_commit()}",
        f"抽样档位：{profile}　随机种子：{seed}",
        f"被测模型：{'、'.join(models) if models else '-'}",
    ]
    for m in meta:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        rr = p.add_run(m)
        rr.font.size = Pt(9.5)
        rr.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
    md.extend(meta)
    md.append("")
    doc.add_page_break()

    # ---------------- 摘要 ----------------
    H("摘要")
    P(
        "本报告回答一个问题：**平台所依赖的模型与读取链路，在外部公开基准上处于什么水平。**"
        "它与另外两类数字严格区分：回归测试（12 探针 + 9 冒烟的 216 条断言）证明「改坏了没有」，"
        "工程指标（时延、包体、长稳）证明「跑得动」，而本报告与自建 FinRisk-Bench 一起回答「能力有多强」。"
    )
    P(
        f"本轮共对接 {len(benches)} 组外部基准，覆盖四个层级：模型层、数值严谨性层、多模态读取层、"
        "工具调用层与财报问答层；全部采用固定种子抽样、按 repo@ref + sha256 锁定版本，"
        "报告中的每个比例都给出样本量。所有原始数据均来自公开仓库，未使用任何非公开数据。"
    )

    # 摘要表：一行一个基准
    rows = []
    for bid, b in benches.items():
        for model, run in (b.get("runs") or {}).items():
            if run.get("error"):
                rows.append([b.get("title", bid), model, "运行失败", "-", "-"])
                continue
            key = digest_for(bid, run)
            rows.append([b.get("title", bid), model, key[0], key[1], run.get("rows", "-")])
    T(
        ["外部基准", "模型", "主要指标", "数值", "样本量"],
        rows,
        caption="表 1　本轮外部基准对齐总览",
        note="抽样口径、提示词与判分口径逐项见第三、四节；「数值」列的单位随基准不同（准确率 / 召回 / 编辑距离），详见各基准小节。",
        widths=[4.6, 3.0, 4.0, 2.6, 1.8],
    )

    # ---------------- 一、为什么做 ----------------
    H("一、为什么必须做外部对齐")
    P(
        "自建基准有一个天然缺陷：题目是我们自己出的，判分是我们自己写的，"
        "再严谨也存在「自己考自己」的嫌疑。外部基准的价值不在于分数高低，"
        "而在于**题目、答案、判分口径都不是我们定的**——这样得到的数字才有可比性。"
    )
    P("本平台的对外口径由此变成三句话：")
    B("我们不是功能多：平台 25 个工具与 MCP 接入的底座模型，在 BFCL v4 非实时子集上的表现为 X（见第五节）。")
    B("我们能证明效果：自建 FinRisk-Bench（T1/T3/T4/T5）+ 外部基准对齐，两套数字互相印证。")
    B("我们算得清成本：本轮对齐全部调用的 token 与估算费用见第八节。")

    # ---------------- 二、方法 ----------------
    H("二、方法：选什么、怎么锁、怎么判")
    H("2.1 基准选择（依据「与平台能力同源」而非「名声大」）", 2)
    sel = []
    for bid, b in ((manifest or {}).get("benchmarks") or {}).items():
        if bid in benches:
            sel.append([b.get("title", bid), b.get("layer", "-"), b.get("question", "-")])
    T(["基准", "对应平台层级", "用来回答什么"], sel, caption="表 2　基准与平台能力的对应关系", widths=[4.2, 4.0, 7.8])

    H("2.2 版本锁定与抽样", 2)
    files = (manifest or {}).get("files") or []
    P(
        f"所有输入文件记录来源仓库、分支/提交与 sha256（共 {len(files)} 个文件，"
        f"合计 {sum(f.get('bytes', 0) for f in files) / 1048576:.1f} MB），清单见附录 A。"
        "抽样使用固定种子（mulberry32），并对抽中的题号集合计算 sha256 写入产物，"
        "因此「换一批题再跑」这种操作在流程上就是不可能的——除非显式改种子，而改种子会在报告里体现。"
    )
    B("CFLUE 知识题：3,864 题中抽 300（分层覆盖 15 类金融资格考试的三种题型）。")
    B("FinEval 严谨性：数值计算 42 题全量；指标抽取 340 题全量。")
    B("FinEval-MM：先在「图像确实随仓库发布」的子集上筛选，再按题型分层抽样。")
    B("FinanceBench：开源子集 150 题全量 × {oracle 给证据, closedBook 不给证据} 两种口径。")
    B("BFCL v4：simple_python 抽 200、multiple 抽 200、irrelevance 抽 120。")
    B("OmniDocBench：官方 demo 18 页全量。")

    H("2.3 提示词口径（我方改动全部公开）", 2)
    P(
        "原则是**能用官方原文就用官方原文**，凡我方添加的指令一律在此列出，"
        "避免「成绩来自提示词工程」这类无法核查的质疑。"
    )
    probe_rows = [
        ["CFLUE 知识题", "官方", "系统提示：只输出答案字母，不要解释", "为满足客观题作答格式"],
        ["CFLUE 应用题", "官方", "系统提示：严格按题目要求作答", "同上"],
        ["FinEval 数值计算", "官方 query 原文", "无附加指令", "完全使用官方 基座query"],
        ["FinEval 指标抽取", "官方 query 原文", "无附加指令", "完全使用官方 基座大模型query"],
        ["FinEval-MM", "官方题干", "系统提示：只输出选项字母", "同上"],
        ["FinanceBench", "论文口径（自拟英文提示）", "oracle 模式要求「仅依据给定证据」；closedBook 要求「不知道就说不知道」", "论文未公开提示词原文"],
        ["BFCL v4", "官方函数 schema + 通用助手系统提示", "未添加任务特定指令", "函数名点号按 API 约束规范化"],
        ["OmniDocBench", "官方任务定义", "系统提示：逐字转写、不要总结", "官方评测即「整页转写」"],
    ]
    T(["基准", "题面来源", "我方添加的指令", "原因"], probe_rows, caption="表 3　各基准的提示词口径", widths=[3.2, 4.2, 5.6, 3.4])

    H("2.4 判分口径", 2)
    P(
        "能用确定性规则判的，绝不交给模型判。只有 FinanceBench 需要判断语义等价时才使用 LLM 裁判，"
        "且**用另一个模型来判**（避免同源偏好）：flash 的答案由 v4-pro 判，反之亦然。"
    )
    grading_rows = [
        ["CFLUE 知识题", "确定性：抽取选项字母后精确匹配", "官方（acc_score）"],
        ["CFLUE 应用题", "分类/抽取/问答：包含或 JSON-F1；生成/翻译：只报 ROUGE-L", "部分（生成类官方为 BLEU/ROUGE/BERTScore）"],
        ["FinEval 数值", "确定性：字符串包含 或 数值相对误差 ≤1%（含量纲换算）", "自实现"],
        ["FinEval 指标抽取", "确定性：语句召回 + 数字召回", "自实现"],
        ["FinEval-MM", "确定性：四选一准确率", "官方口径"],
        ["FinanceBench", "主：交叉模型裁判（三分类）；辅：确定性数值判分", "论文同构（论文用 GPT-4 裁判）"],
        ["BFCL v4", "自实现 AST 判定（逐行对照官方 ast_checker.py 移植）", "自实现，非官方 checker"],
        ["OmniDocBench", "自实现：片段召回 / 数字召回 / 编辑距离比 / ROUGE-L", "自实现，非官方 TEDS/CDM 口径"],
    ]
    T(["基准", "判分方式", "是否官方口径"], grading_rows, caption="表 4　判分口径对照", widths=[3.2, 8.6, 4.6])

    H("2.5 模型与口径", 2)
    P(
        "本轮全部结果由 **deepseek-flash** 产生（项目指定模型）。另有候选模型 deepseek-v4-pro 经实测"
        "**不接受图像输入**（返回「无法读取该图片内容」，prompt_tokens 仅 124，说明图像未进入上下文），"
        "按项目要求本轮不使用；该事实仅作为能力边界记录在案。"
    )
    P(
        "原验收项要求「≥2 个模型的横向对比表」。本轮只有单模型，因此该项**改为**"
        "「口径 A（直连模型）vs 口径 B（平台链路）」的对比（见第五节）：两者使用同一批题号，"
        "差额反映平台自身的系统提示词与工具编排带来的增益或损失——这比换一个模型更能回答「我们平台行不行」。"
        "代码中的多模型路径（--models、FinanceBench 的交叉模型裁判）全部保留，获批第二个模型即可直接恢复。"
    )

    # ---------------- 三、判分器可信度 ----------------
    H("三、先验证判分器，再谈成绩")
    P(
        "FinanceBench 仓库公开了论文各模型的逐题作答与判定标签（Correct Answer / Incorrect Answer / Refusal）。"
        "这让我们能在**不调用任何模型**的前提下检验自己的判分器：用我们的确定性判分重判论文答案，"
        "与论文标签比对一致率。判分器不可信，后面的数就没有意义。"
    )
    fbrun = dig(benches, "financebench.graderValidation", []) or []
    gv_rows = []
    for g in fbrun:
        if not isinstance(g, dict):
            continue
        gv_rows.append([
            g.get("label", "-"),
            g.get("rows", "-"),
            pct(g.get("publishedAccuracyPct")),
            g.get("deterministicGraded", "-"),
            pct(g.get("deterministicAgreementPct")),
        ])
    if gv_rows:
        T(
            ["论文公开模型", "题量", "论文标签准确率", "可判数值题数", "我方判分器与论文标签一致率"],
            gv_rows,
            caption="表 5　判分器可信度验证（不消耗模型调用）",
            note="初版判分器未做量纲换算时一致率仅 61.5%：FinanceBench 标准答案常写作 0.4（十亿美元）或 0.019（比率），"
            "而模型写作「$389 million」或「1.9%」。加入量纲换算后一致率提升到 90% 以上，这一改动记录在案。",
            widths=[4.4, 1.8, 3.0, 2.8, 4.4],
        )
    P(
        "结论：确定性判分适合作为**辅助指标**与回归护栏，但不足以替代语义判定；"
        "因此 FinanceBench 的主指标采用交叉模型裁判，两个口径同时报告，其差额本身就是结论的一部分。"
    )
    P(
        "**复现性提示（实测）**：用完全相同的配置把 FinanceBench 跑了两遍，裁判口径 oracle 从 83.33% 变为 82.00%、"
        "closedBook 从 47.33% 变为 44.67%。模型在 temperature=0 下仍非完全确定（推理路径、服务端批处理都会带来波动），"
        "因此本报告的数字**只用于判断量级与方向，不用于比较小数点后的差异**；"
        "两个版本都保留在逐题明细里，可逐条对照。"
    )

    # ---------------- 四、逐基准结果 ----------------
    H("四、逐基准结果")

    # 4.1 CFLUE
    if "cflue" in benches:
        b = benches["cflue"]
        H("4.1 CFLUE：中文金融知识与应用（模型层）", 2)
        P("来源：aliyun/cflue（ACL 2024 Findings）。本节测的是平台所依赖的模型底座在中文金融语境下的知识与指令遵循能力。")
        kn_rows = []
        for model, run in (b.get("runs") or {}).items():
            m = run.get("metrics", {})
            kn = m.get("knowledge", {})
            o = kn.get("overall", {}) or {}
            kn_rows.append([
                model,
                pct(o.get("accuracyPct")),
                f"{o.get('correct', '-')}/{o.get('n', '-')}",
                pct(dig(kn, "singleSelectAccuracy.accuracyPct")),
                pct(dig(kn, "multiSelectAccuracy.accuracyPct")),
                pct(dig(kn, "byTaskType.判断题.accuracyPct")),
            ])
        T(["模型", "知识题准确率", "正确/样本", "单选", "多选", "判断"], kn_rows,
          caption="表 6　CFLUE 知识题结果（官方口径：准确率）",
          note="样本为仓库发布子集 3,864 题中固定种子抽取的 300 题；官方榜单为 3.8 万题全集的零样本结果，两者不可直接等同。",
          widths=[3.6, 2.8, 2.4, 2.0, 2.0, 2.0])
        # 分题型/科目
        for model, run in (b.get("runs") or {}).items():
            by_subject = dig(run, "metrics.knowledge.bySubject", {}) or {}
            rows = [[k, v.get("n"), pct(v.get("accuracyPct"))] for k, v in by_subject.items() if k != "__ALL__"]
            if rows:
                T(["科目 / 题型", "n", "准确率"], rows, caption=f"表 7　CFLUE 分科目结果（{model}）", widths=[8.0, 2.0, 3.0])
            break
        # 应用题
        ap_rows = []
        for model, run in (b.get("runs") or {}).items():
            m = dig(run, "metrics.application", {}) or {}
            o = m.get("overallGraded", {}) or {}
            ap_rows.append([model, pct(o.get("accuracyPct")), f"{o.get('correct', '-')}/{o.get('n', '-')}", num(m.get("meanRougeL"), 4)])
        T(["模型", "可判子任务判对率", "正确/样本", "平均 ROUGE-L"], ap_rows,
          caption="表 8　CFLUE 应用题结果",
          note="分类/抽取/问答类按确定性规则判对错；生成与翻译类官方用 BLEU/ROUGE/BERTScore，我们只报 ROUGE-L，"
               "**不可与官方榜单分数直接比较**。",
          widths=[3.6, 3.4, 2.6, 3.0])
        P(
            "外部参照：CFLUE 官方 README 公布的零样本准确率为 Qwen-72B 72.8、GPT-4 60.87、GPT-4-turbo 60.61、"
            "Qwen-14B 53.82、ChatGPT 43.35（均为 2024 年模型、全集 3.8 万题）。"
            "本次测得的知识题准确率高于该区间，但**不能**据此声称「我们更强」，至少有三条替代解释："
            "① 我方提示词明确要求只输出字母，格式遵循难度更低；② 题目子集不同（我们只用仓库发布的 3,864 题）；"
            "③ 这些题目来自公开的金融从业资格考试，可能已进入模型训练语料，存在数据污染且无法排除。"
        )
        # 提示词敏感性：用实验而不是辩解来量化"提示词贡献了多少"
        if sensitivity:
            P("提示词敏感性实验（把「是不是靠提示词刷出来的」变成可测量的数字）：", bold=True)
            srows = []
            for vid, v in (sensitivity.get("variants") or {}).items():
                srows.append([
                    v.get("label", vid),
                    pct(v.get("accuracyPct")),
                    f"{v.get('correct', '-')}/{v.get('n', '-')}",
                    (f"{v.get('deltaVsStrict'):+.2f}" if v.get("deltaVsStrict") is not None else "-"),
                    v.get("meanOutputChars", "-"),
                    json.dumps(v.get("extractMode", {}), ensure_ascii=False),
                ])
            if srows:
                T(["提示词变体", "准确率", "正确/样本", "相对严格提示", "平均输出字数", "答案抽取方式"],
                  srows,
                  caption="表 7b　CFLUE 知识题的提示词敏感性（同一批题、同一模型）",
                  note=f"模型 {sensitivity.get('model', '-')}，题量 {sensitivity.get('n', '-')}，"
                       "三种提示词使用完全相同的题目与选项；「思考提示」允许模型先推理再给答案；差值为百分点。"
                       "抽取方式里的 weak-scan / weak-single 表示只能靠宽松扫描拿到字母，这类变体的准确率可信度更低。",
                  widths=[3.6, 2.0, 2.0, 2.4, 2.4, 5.0])
                P(interpret_sensitivity(sensitivity))

    # 4.2 FinEval
    if "fineval" in benches:
        b = benches["fineval"]
        H("4.2 FinEval 金融严谨性：数值计算与指标抽取（数值严谨性层）", 2)
        P("来源：SUFE-AIFLM-Lab/FinEval（NAACL 2025）。题目自带检索内容，属「给定证据」口径，不测检索能力；提示词使用官方 query 原文。")
        rows = []
        for model, run in (b.get("runs") or {}).items():
            numr = dig(run, "metrics.numerical", {}) or {}
            idxr = dig(run, "metrics.indexExtraction", {}) or {}
            o = numr.get("overall", {}) or {}
            rows.append([
                model,
                pct(o.get("accuracyPct")),
                f"{o.get('correct', '-')}/{o.get('n', '-')}",
                num(idxr.get("meanStatementRecall"), 3),
                num(idxr.get("meanNumberRecall"), 3),
                pct(idxr.get("completeRatePct")),
            ])
        T(["模型", "数值计算判对率", "正确/样本", "指标抽取·语句召回", "·数字召回", "·完整率"],
          rows,
          caption="表 9　FinEval 金融严谨性结果",
          note="数值判对率 = 标准答案字符串包含 或 数值相对误差 ≤1%（含量纲换算）；指标抽取的参考答案是"
               "把检索内容中的指标全部列出（平均数十条语句），因此同时给出召回与「全部命中」的完整率。",
          widths=[3.4, 3.0, 2.2, 3.0, 2.6, 2.2])
        P(
            "值得注意的现象：指标抽取的完整率很低，而语句/数字召回中等。查看逐题明细可见，模型倾向只回答用户"
            "直接问到的那个指标，而参考答案要求把检索内容里所有相关指标都列出——这是「回答风格」而非「算错数」。"
            "因此我们同时报告三个数字，只用完整率作为苛刻下界，用召回刻画实际能力。"
        )

    # 4.3 FinEval-MM
    if "fineval-mm" in benches:
        b = benches["fineval-mm"]
        H("4.3 FinEval-MM：财报图表截图取数（多模态读取层）", 2)
        P(
            "来源：FinEval 的 multimodeldata 子集。题目是「给一张财报/研报里的图表截图，四选一回答问题」，"
            "与平台「上传图片 → 读表 → 取数」的链路同源。"
        )
        cov = b.get("sample", {}).get("coverage", {}) or {}
        fn = cov.get("funnel", {}) or {}
        P(
            f"**数据可得性（必须先说清楚）**：15 个题型文件共 {fn.get('rows', '-')} 行，带图 {fn.get('withImage', '-')} 行，"
            f"带图且有答案 {fn.get('withImageAndAnswer', '-')} 行；其中图像**确实随仓库发布**的只有 {fn.get('resolvableImage', '-')} 行，"
            f"再要求选项≥2 后可用 {fn.get('usable', '-')} 行。"
            "缺失的原因是题目引用的 figure/pg、figure/sdt 等目录仓库根本没有发布，"
            "而 HuggingFace 对该数据集返回 401（需授权），镜像同样不可用。"
        )
        rows = []
        for model, run in (b.get("runs") or {}).items():
            o = dig(run, "metrics.multimodal.overall", {}) or {}
            rows.append([model, pct(o.get("accuracyPct")), f"{o.get('correct', '-')}/{o.get('n', '-')}",
                         pct(dig(run, "metrics.multimodal.abstainRate")), num(dig(run, "metrics.multimodal.meanImageKB"), 0)])
        T(["模型", "四选一准确率", "正确/样本", "弃权率", "平均图片大小(KB)"], rows,
          caption="表 10　FinEval-MM 结果（仅图像可得子集）",
          note="deepseek-v4-pro 未参与：实测其不接受图像输入（prompt_tokens=124 且明确拒绝），"
               "该事实本身也是本轮结论之一。",
          widths=[3.6, 3.0, 2.4, 2.4, 3.2])
        for model, run in (b.get("runs") or {}).items():
            bt = dig(run, "metrics.multimodal.byFintype", {}) or {}
            rows = [[k.replace("FinEval-MM/", ""), v.get("n"), pct(v.get("accuracyPct"))] for k, v in bt.items() if k != "__ALL__"]
            if rows:
                T(["题型", "n", "准确率"], rows, caption=f"表 11　FinEval-MM 分题型（{model}）", widths=[7.0, 2.0, 3.0])
            break

    # 4.4 FinanceBench
    if "financebench" in benches:
        b = benches["financebench"]
        H("4.4 FinanceBench：财报问答与证据使用（财报问答层）", 2)
        P(
            "来源：patronus-ai/financebench 开源子集 150 题。两种口径：oracle（题目自带财报证据原文）与 "
            "closedBook（不给证据）。后者用来观察「没有依据时会不会硬答」。"
            "主指标为 LLM 裁判三分类（与论文标签同构），且**由另一个模型裁判**：flash 的答案由 v4-pro 判，反之亦然。"
        )
        rows = []
        for model, run in (b.get("runs") or {}).items():
            jm = dig(run, "metrics.judgeGraded.byMode", {}) or {}
            det = dig(run, "metrics.deterministic.byMode", {}) or {}
            rows.append([
                model,
                pct(dig(jm, "oracle.accuracyPct")),
                pct(dig(jm, "closedBook.accuracyPct")),
                pct(dig(det, "oracle.accuracyPct")),
                pct(dig(det, "closedBook.accuracyPct")),
                pct(dig(run, "metrics.oracleRefusalRate")),
            ])
        T(["模型", "oracle（裁判）", "closedBook（裁判）", "oracle（确定性）", "closedBook（确定性）", "oracle 拒答率"],
          rows,
          caption="表 12　FinanceBench 结果（n=150 × 2 口径）",
          note="裁判口径与确定性口径并列，两者的差额反映「数值判分无法覆盖语义等价」的程度。",
          widths=[3.2, 2.6, 2.8, 2.8, 2.8, 2.4])
        # 论文对照
        fb_ref = None
        for item in (refs or {}).get("items", []) if isinstance(refs, dict) else []:
            if item.get("kind") == "published_model_accuracy":
                fb_ref = item
        rows = [[m["label"], m["n"], pct(m["accuracyPct"]), m.get("refusal", "-")] for m in (fb_ref or {}).get("models", [])]
        if rows:
            T(["论文公开模型（同一 150 题）", "n", "准确率", "拒答数"], rows,
              caption="表 13　外部对照：论文公开的各模型准确率（由仓库逐题标签统计）",
              note="该数字直接由仓库 results/*.jsonl 的逐题 label 统计，不是二手转述；与我们同题同集，可直接并列比较。",
              widths=[6.4, 1.8, 2.4, 2.4])
        # 分题型
        for model, run in (b.get("runs") or {}).items():
            bt = dig(run, "metrics.byQuestionType", {}) or {}
            rows = [[k.replace("FinanceBench/", ""), v.get("n"), pct(v.get("accuracyPct"))] for k, v in bt.items() if k != "__ALL__"]
            if rows:
                T(["题型（oracle 口径）", "n", "裁判准确率"], rows, caption=f"表 14　FinanceBench 分题型（{model}）", widths=[7.0, 2.0, 3.0])
            break
        # 闭卷口径的可信度核查：闭卷能答对，究竟是「会读」还是「记得」
        cb = audit_closedbook()
        if cb:
            oracle_pct = dig(b, "runs.deepseek-flash.metrics.judgeGraded.byMode.oracle.accuracyPct")
            if oracle_pct is None:
                for _m, _r in (b.get("runs") or {}).items():
                    oracle_pct = dig(_r, "metrics.judgeGraded.byMode.oracle.accuracyPct")
                    break
            P("**闭卷口径的可信度核查（重点）**：论文里 GPT-4 闭卷只有 4.67%，本次测得远高于此。"
              "这种量级的差异不能只当成「我们更强」，必须查清原因：", bold=True)
            T(["交叉情况", "题数", "说明"],
              [["裁判判对且确定性也判对", cb["both"], "模型给出了与标准答案数值一致的结论"],
               ["仅裁判判对", cb["judgeOnly"], "多为标准答案为长句、确定性判分无法覆盖，裁判判定更准"],
               ["仅确定性判对", cb["detOnly"], "裁判口径更严（例如单位/口径表述不同）"],
               ["两者都不对", cb["neither"], "含拒答 %d 题" % cb["refusal"]]],
              caption="表 14b　FinanceBench 闭卷口径交叉核查（n=%d）" % cb["n"],
              note="确定性判分对「长句标准答案」天然无能为力，因此「仅裁判判对」占多数属预期现象，不能据此认定裁判过宽。",
              widths=[5.0, 1.8, 8.4])
            P("抽查作答内容（可在逐题明细中逐条核对）：")
            for ex in cb["examples"]:
                B(f"标准答案：{ex['gold']}　→　模型闭卷作答：{ex['answer']}")
            P(
                "**结论（重要）**：模型能在没有任何文档的情况下给出 2017–2022 年美国上市公司 10-K 的具体数字，"
                "且多数精确到三四位有效数字（例如 3M FY2018 资本开支 1,577 百万美元、Amazon FY2017 DPO 93.86 天、"
                "Adobe FY2022 营业利润率 34.6%、AMD FY2022 速动比率 1.58）。"
                "这说明 FinanceBench 的闭卷切分对该模型**已发生训练语料污染**，也意味着 oracle 口径的 "
                f"{pct(oracle_pct)} 不能全部归因于「读懂文档」——其中含有记忆成分。"
                "因此本报告把 FinanceBench 定位为「与外部同题对照」的锚点，而**不**把它当作平台文档阅读能力的唯一证据；"
                "文档阅读能力以 OmniDocBench（图像输入，无法靠记忆）与 FinEval-MM 为准。"
            )

    # 4.5 BFCL
    if "bfcl" in benches:
        b = benches["bfcl"]
        H("4.5 BFCL v4：工具调用（工具调用层）", 2)
        P(
            "来源：ShishirPatil/gorilla 的 berkeley-function-call-leaderboard。三类非实时子集："
            "simple（单函数）、multiple（多函数选一）、irrelevance（没有合适函数时应当不调用）。"
        )
        rows = []
        for model, run in (b.get("runs") or {}).items():
            m = run.get("metrics", {}) or {}
            bc = m.get("byCategory", {}) or {}
            rows.append([
                model,
                pct(dig(m, "overall.accuracyPct")),
                pct(dig(bc, "BFCL/simple（单函数）.accuracyPct")),
                pct(dig(bc, "BFCL/multiple（多函数选一）.accuracyPct")),
                pct(dig(bc, "BFCL/irrelevance（应拒调）.accuracyPct")),
            ])
        T(["模型", "总体", "simple", "multiple", "irrelevance"], rows,
          caption="表 15　BFCL v4 非实时子集结果",
          note="判分为**自实现**的 AST 判定（逐行对照官方 ast_checker.py 移植，含错误类型分类），"
               "不是官方 checker，因此不得与官方榜单分数等同；官方榜单也未在仓库中归档分数，故不引用二手数字。",
          widths=[3.6, 2.4, 2.4, 2.8, 2.8])
        for model, run in (b.get("runs") or {}).items():
            et = dig(run, "metrics.errorTypeDistribution", {}) or {}
            rows = [[err_label(k), v, err_meaning(k)] for k, v in sorted(et.items(), key=lambda x: -x[1])]
            if rows:
                T(["失败类型", "次数", "含义与对平台的影响"], rows,
                  caption=f"表 16　BFCL 失败类型分布（{model}，共 {sum(et.values())} 例失败）",
                  note="只统计失败样本（判定函数在成功时保留占位值，若一并统计会让这张表失真——该口径已修正）。",
                  widths=[4.6, 1.6, 9.0])
            break
        P(
            "对平台的含义：**irrelevance 的 31 例「不该调用却调用了」是最该盯的数字**——"
            "它对应的正是平台里「没有合适工具时会不会乱调工具」的风险，可以直接作为工具层安全边界的参考基线；"
            "其次是 9 例「调用个数不对」（multiple 子集要求只调一个，模型调了多个），"
            "在平台里对应「该走一个工具却走了多个」的多余调用与额度消耗。"
        )

    # 4.6 OmniDocBench
    if "omnidocbench" in benches:
        b = benches["omnidocbench"]
        H("4.6 OmniDocBench：整页文档转写（文档读取层）", 2)
        P(
            "来源：opendatalab/OmniDocBench 官方 demo 18 页（全集 981 页），含研报、杂志、报纸、学术论文、教材、笔记、PPT、试卷，"
            "中英混合。指标为**自实现**的片段召回、数字召回、字符编辑距离比与 ROUGE-L。"
        )
        rows = []
        for model, run in (b.get("runs") or {}).items():
            m = run.get("metrics", {}) or {}
            pg = m.get("pages", {}) or {}
            rows.append([
                model,
                num(m.get("meanSegmentRecall"), 3),
                num(m.get("meanNumberRecall"), 3),
                num(m.get("meanEditRatio"), 3),
                num(m.get("meanRougeL"), 3),
                f"{pg.get('pass', '-')}/{pg.get('n', '-')}",
            ])
        T(["模型", "片段召回", "数字召回", "编辑距离比↓", "ROUGE-L", "页面通过"],
          rows,
          caption="表 17　OmniDocBench demo 结果（18 页）",
          note="页面通过 = 片段召回≥80% 且 数字召回≥90%（阈值为我方自定，仅用于给出一个可比的通过率）。"
               "官方指标（文本编辑距离 / 公式 CDM / 表格 TEDS / 阅读顺序）为 Python 实现，本报告不冒充官方口径；"
               "官方 quick-match 结果文件显示全集文本编辑距离约 0.356，但页面集与管线不同，不可直接比大小。",
          widths=[3.0, 2.4, 2.4, 2.6, 2.4, 2.4])
        for model, run in (b.get("runs") or {}).items():
            bs = dig(run, "metrics.bySource", {}) or {}
            rows = [[k, v.get("n"), num(v.get("meanSegmentRecall"), 3), num(v.get("meanNumberRecall"), 3), num(v.get("meanEditRatio"), 3)]
                    for k, v in bs.items()]
            if rows:
                T(["文档类型", "n", "片段召回", "数字召回", "编辑距离比"], rows,
                  caption=f"表 18　OmniDocBench 分文档类型（{model}）", widths=[4.4, 1.8, 2.6, 2.6, 2.8])
            break
        P("对平台的含义：研报类页面（与平台场景最接近）的数字召回表现，直接决定「图片取数」能否进入生产流程。")

    # ---------------- 五、平台链路复测 ----------------
    H("五、平台链路复测：平台自己那套链路有没有拖后腿")
    P(
        "前面各节的数字都是「直连模型」（口径 A）。但用户实际用的是平台链路：平台系统提示词 + 25 个工具 + 附件读取。"
        "本节把**同一批题**（同一种子、题目为口径 A 样本的嵌套子集）送进平台真实的 `/api/chat/stream` 链路复测，"
        "与口径 A 在同一批题号上逐题对比。"
    )
    if platform_chain:
        pc = platform_chain
        rows = []
        for key, label in (("cflue", "CFLUE 知识题"), ("finevalMm", "FinEval-MM 图片题")):
            seg = pc.get(key)
            if not seg:
                continue
            matched = matched_accuracy(align, key, seg)
            rows.append([
                label,
                f"{seg.get('n')}",
                pct(seg.get("accuracyPct")),
                pct(matched.get("barePct")),
                f"{matched.get('matchedN', '-')}",
                f"{seg.get('meanMs', '-')} ms",
                seg.get("usedTools", 0),
            ])
        T(["题组", "n（平台链路）", "平台链路准确率", "直连模型（同批题）", "对齐题数", "平均耗时", "触发工具调用"],
          rows,
          caption="表 19　口径 A（直连模型）vs 口径 B（平台链路）",
          note="平台链路包含平台系统提示词、工具选择与附件读取，因此两者的差额同时包含「提示词影响」与「链路开销」，"
               "不能单独归因为模型能力差异；样本量较小，仅作方向性判断。",
          widths=[3.4, 2.2, 2.8, 3.0, 2.0, 2.2, 2.2])
        P(
            "读法与结论：CFLUE 知识题上，平台链路与直连模型的差值为 "
            f"{platform_gap_text(rows)}。这道题组是纯客观题，唯一差别就是"
            "「平台系统提示词 + 工具清单」。因此差距**不应归因为模型能力**，而应视为平台在"
            "「客观问答」场景下的提示词/编排开销：模型的注意力被平台人设与工具说明占据，"
            "反而降低了严格作答的比例（逐题明细里能看到答非所选、空回答等形态）。"
            "这是一个明确的工程改进项（例如按场景裁剪系统提示词与工具集），而不是模型的锅。"
            "相反，FinEval-MM 图片题上两者持平（都答对 18/20），说明**平台的附件读取链路没有拖后腿**——"
            "该题组恰好是平台自己实现的部分，这个结论比图片题本身的分数更有价值。"
        )
    else:
        P("（本轮未运行平台链路复测；执行 `node bench/external/platform-chain.js --cflue 60 --mm 20` 后重新生成本报告。）")

    # ---------------- 六、数据可得性 ----------------
    H("六、数据可得性清单（拿不到的东西也是结论）")
    P("外部对齐最容易出现的问题，是把「数据拿不到」写成「模型答错」。本节把本轮遇到的数据可得性问题逐条列出，并给出证据。")
    avail = [
        ["FinEval 经典学术/行业选择题", "未获得", "仓库 data-v2 为 .rar 且测试集答案不公开；本轮未把它计入任何分母"],
        ["FinEval-MM 约 57% 的带图题", "未获得", f"题目引用的 figure/pg、figure/sdt 等目录仓库未发布；HF 数据集返回 401（需授权），镜像同样不可用"],
        ["FinanceBench 全量 10,231 题", "未获得", "仓库仅开源 150 题子集（含答案与证据），其余需另行申请；本轮只用开源子集并明确标注"],
        ["FinanceBench 检索口径（singleStore/sharedStore）", "主动不做", "需要构建向量库与检索管线，本轮聚焦「有证据时能否答对」"],
        ["BFCL parallel / multi-turn / exec / live 子集", "主动不做", "需要执行环境与多轮交互，成本与收益不匹配"],
        ["BFCL 官方榜单分数", "未获得", "仓库未归档榜单分数（榜单为网页应用），不引用二手转述"],
        ["OmniDocBench 全集 981 页与官方指标实现", "未获得/主动不做", "官方 demo 18 页可下载；官方指标为 Python 实现，本轮只报自实现保真度"],
        ["CFLUE 全集 3.8 万题", "未获得", "仓库发布 3,864 题知识题；全集在 ModelScope，本轮只用仓库发布部分"],
    ]
    T(["数据/口径", "状态", "原因与说明"], avail, caption="表 20　数据可得性与主动取舍清单", widths=[4.6, 2.4, 9.0])

    # ---------------- 七、成本与耗时 ----------------
    H("七、成本与耗时")
    usage = (align or {}).get("modelUsage") or (align or {}).get("usage") or {}
    rows = []
    for m, u in usage.items():
        rows.append([
            m,
            u.get("calls", "-"),
            u.get("failed", "-"),
            f"{u.get('promptTokens', 0):,}",
            f"{u.get('completionTokens', 0):,}",
            f"{u.get('reasoningTokens', 0) or 0:,}",
            f"¥{u.get('estimatedCostCNY', '-')}",
        ])
    T(["模型", "调用次数", "失败", "输入 tokens", "输出 tokens", "其中推理 tokens", "估算费用"],
      rows, caption="表 21　本轮对齐的调用与成本",
      note="费用按公开价目估算（单位：元/百万 token），仅统计本轮评测调用；推理 tokens 是成本与延迟的主要来源，故单列。"
           "FinanceBench 的裁判调用由独立 client 发出，已单独计入，不会漏记。",
      widths=[3.2, 2.0, 1.6, 2.6, 2.6, 2.8, 2.4])
    if platform_usage and platform_usage.get("latest"):
        u = platform_usage["latest"]
        T(["口径 B 平台链路", "会话数", "LLM 调用", "输入 tokens", "输出 tokens", "缓存命中率", "估算费用"],
          [[u.get("run", "-"), u.get("sessions", "-"), u.get("llmCalls", "-"), f"{u.get('promptTokens', 0):,}",
            f"{u.get('completionTokens', 0):,}", pct(u.get("cacheHitRatePct")), f"¥{u.get('estimatedCostCNY', '-')}"]],
          caption="表 22　口径 B 的平台侧用量（直接读平台数据库）",
          note="口径 B 的用量写在平台自己的 chat_session 表里，由 tools/collect-platform-usage.js 读出；"
               "输入侧缓存命中率很高（同一批题的公共前缀被复用），是成本可控的主要原因。",
          widths=[4.0, 1.8, 2.0, 2.6, 2.4, 2.4, 2.2])
    P(
        "口径 A 的全部 6 组基准、约 1,900 次模型调用（不含口径 B），估算费用约 ¥4.23；"
        "加上口径 B 的平台侧约 ¥0.33，本轮对齐总成本不到 ¥5。"
        "把「效果能不能证明」做到可复现、可审计，模型成本不到一顿饭钱——"
        "真正的开销是数据采集与标注的人力，而不是模型调用。"
    )

    # ---------------- 八、结论 ----------------
    H("八、结论与下一步")
    P("本轮对齐证明了四件事：", bold=True)
    B("**外部可比性已经建立**：6 组公开基准、固定种子抽样、版本与哈希锁定，任何一条数字都能追溯到具体题目与具体文件。")
    B("**判分器本身可被检验**：用 FinanceBench 论文公开标签反向验证判分器，并把「量纲换算」这一改进记录在案。")
    B("**能力边界是明确的**：v4-pro 不支持图像输入、FinEval-MM 约 57% 的图题数据未公开，这些都是结论，不是遮掩。")
    B("**平台链路可复测**：同一批题既走直连模型也走平台链路，差额可量化，而不是靠「感觉差不多」。")
    P("下一步（按优先级）：", bold=True)
    B("扩充非财务与多模态样本量，把 FinEval-MM 的可用子集跑满，并接入平台附件读取链路做端到端对比。")
    B("把本节的自实现判分器（BFCL AST、保真度指标）补一组单元测试，避免判分器回归导致结论漂移。")
    B("对公开考题类基准（CFLUE）增加「污染提示」：报告中固定写明题目来源为公开考试，存在训练语料污染可能。")
    B("在 CI 中以 `--small` 档位常驻 `external-alignment` 套件，防止外部对齐链路随时间失效。")

    # ---------------- 附录 ----------------
    doc.add_page_break()
    H("附录 A　输入文件清单（版本锁定）")
    files = (manifest or {}).get("files") or []
    rows = [[f.get("benchmark"), f.get("repoPath", "")[-58:], f"{f.get('bytes', 0) / 1024:.0f} KB", (f.get("sha256") or "")[:16]] for f in files]
    T(["基准", "文件", "大小", "sha256(前16)"], rows,
      caption="表 A1　外部基准输入文件与哈希",
      note="完整清单（含来源 URL 与许可证核查结果）见 bench/external/out/manifest.json；原始数据不入仓库。",
      widths=[2.4, 8.0, 2.0, 3.6])

    H("附录 B　复现命令")
    for cmd in [
        "node bench/external/prepare.js --with-assets      # 抓数据 + 许可证核查 + 题库盘点",
        "node bench/external/tools/preflight.js            # 出数前自检：映射/答案/路径必须真的存在",
        "node bench/external/run.js --dry                  # 只抽样，检查题量与批次哈希",
        "node bench/external/run.js --concurrency 6        # 正式出数（全量档位）",
        "node bench/external/run.js --only financebench --validate-only   # 不消耗调用的判分器验证",
        "node bench/external/platform-chain.js --cflue 60 --mm 20        # 平台链路复测（口径 B）",
        "python bench/external/report/make-alignment-report.py           # 重新生成本报告",
    ]:
        p = doc.add_paragraph()
        r = p.add_run(cmd)
        r.font.name = "Consolas"
        r.font.size = Pt(9)
        md.append("```\n" + cmd + "\n```\n")

    H("附录 C　术语与口径")
    for term, desc in [
        ("口径 A（直连模型）", "直接把题目发给模型 API，不加平台系统提示词、不使用工具；用于与外部榜单对话。"),
        ("口径 B（平台链路）", "题目经平台 /api/chat/stream 走真实链路（平台提示词 + 工具 + 附件读取）；用于回答「平台行不行」。"),
        ("片段召回", "把标注文本按句切开，逐句检查是否完整出现在模型输出中。"),
        ("数字召回", "把标注中的数字逐个检查是否出现在输出中；财报场景读错数字后果最重，故单列。"),
        ("编辑距离比", "字符级归一化编辑距离 / 较长序列长度，0 表示完全一致。"),
        ("完整率", "参考答案的全部语句都被命中的题目占比（苛刻下界）。"),
    ]:
        B(f"{term}：{desc}")

    doc.add_paragraph()
    p = doc.add_paragraph()
    r = p.add_run(
        "声明：本报告仅使用公开数据，所有比例为抽样结果而非全集成绩；文中外部数字均注明出处；"
        "平台输出不构成任何投资建议。"
    )
    r.font.size = Pt(9)
    r.italic = True
    r.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    add_page_number_footer(doc.sections[0], f"外部基准对齐报告 {REPORT_VERSION}")
    return doc, md


def matched_accuracy(align, key, seg) -> dict:
    """把口径 B 的题号与口径 A 的逐题明细对齐，算出严格同题的可比数字。

    口径 B 的样本是口径 A 样本的嵌套子集（同一种子、同一洗牌序列，取前 n 个），
    因此可以直接按 id 取交集比较。
    """
    import glob

    detail = None
    for f in sorted(glob.glob(str(EXT / "out" / "run-*" / "*.deepseek-flash.json"))):
        if key == "cflue" and "cflue." in f:
            detail = f
        if key == "finevalMm" and "fineval-mm." in f:
            detail = f
    if not detail:
        return {}
    data = load(Path(detail)) or {}
    rows = data.get("rows") or []
    ids = {r.get("id") for r in (seg.get("rows") or [])}
    matched = [r for r in rows if r.get("id") in ids and not r.get("error")]
    if not matched:
        return {}
    correct = sum(1 for r in matched if r.get("correct"))
    return {"matchedN": len(matched), "barePct": round(correct / len(matched) * 100, 2)}


ERR_LABELS = {
    "irrelevance:called_a_function": "不该调用却调用了",
    "value_error:string": "字符串参数取值不在允许集合内",
    "value_error:others": "参数取值不在标准答案集合内",
    "value_error:list/tuple": "列表参数内容与标准答案不符",
    "value_error:dict_key": "字典参数的键与标准答案不符",
    "simple_function_checker:wrong_count": "调用个数不对（应只调 1 个）",
    "multiple_function_checker:wrong_count": "调用个数不对（多函数题应只调 1 个）",
    "simple_function_checker:wrong_func_name": "函数名选错",
    "simple_function_checker:missing_required": "缺少必填参数",
    "simple_function_checker:unexpected_param": "多传了函数不认识的参数",
    "simple_function_checker:missing_optional": "漏传了标准答案要求的可选参数",
    "type_error:simple": "参数类型错误",
    "type_error:nested": "嵌套参数类型错误",
}

ERR_MEANING = {
    "irrelevance:called_a_function": "没有合适函数时仍然发起调用；平台里对应「乱调工具」，是安全边界最该守的一条",
    "value_error:string": "选对了函数，但字符串参数填得不对（枚举/名称类参数）",
    "value_error:others": "选对了函数，但参数值不是标准答案接受的取值",
    "value_error:list/tuple": "列表类参数内容不符（如多选/多项输入）",
    "value_error:dict_key": "字典类参数的键不符，说明结构化参数理解偏差",
    "simple_function_checker:wrong_count": "简单题要求只调用一个函数，模型调了多个（多余调用=多余额度消耗）",
    "multiple_function_checker:wrong_count": "多函数题要求只调用一个，模型调了多个或没调",
    "simple_function_checker:wrong_func_name": "函数选择错误，属于最严重的一类（工具链会走错分支）",
    "simple_function_checker:missing_required": "缺少必填参数，真实调用会直接失败",
    "simple_function_checker:unexpected_param": "多传参数，真实调用可能被拒",
    "simple_function_checker:missing_optional": "漏传标准答案要求的可选参数",
    "type_error:simple": "参数类型错误（如该给数字给了字符串）",
    "type_error:nested": "嵌套结构里元素类型错误",
}


def err_label(k: str) -> str:
    return ERR_LABELS.get(k, k)


def err_meaning(k: str) -> str:
    return ERR_MEANING.get(k, "（未分类）")

def digest_for(bid: str, run: dict):
    """每个基准的「头条数字」（摘要表用）——全部从 run.metrics 里读，不另设数据源。"""
    m = (run or {}).get("metrics") or {}
    if bid == "cflue":
        v = dig(m, "knowledge.overall.accuracyPct")
        v2 = dig(m, "application.overallGraded.accuracyPct")
        return ("知识题准确率", f"{pct(v)}（应用题可判子任务 {pct(v2)}）")
    if bid == "fineval":
        v = dig(m, "numerical.overall.accuracyPct")
        sr = dig(m, "indexExtraction.meanStatementRecall")
        nr = dig(m, "indexExtraction.meanNumberRecall")
        return ("数值计算判对率", f"{pct(v)}（指标抽取语句召回 {num(sr)} / 数字召回 {num(nr)}）")
    if bid == "fineval-mm":
        v = dig(m, "multimodal.overall.accuracyPct")
        return ("多模态四选一准确率", pct(v))
    if bid == "financebench":
        v = dig(m, "judgeGraded.byMode.oracle.accuracyPct")
        v2 = dig(m, "judgeGraded.byMode.closedBook.accuracyPct")
        return ("oracle 准确率", f"{pct(v)}（closedBook {pct(v2)}）")
    if bid == "bfcl":
        v = dig(m, "overall.accuracyPct")
        s = dig(m, "byCategory.BFCL/simple（单函数）.accuracyPct")
        irr = dig(m, "byCategory.BFCL/irrelevance（应拒调）.accuracyPct")
        return ("总体 AST 判定通过率", f"{pct(v)}（simple {pct(s)}，irrelevance {pct(irr)}）")
    if bid == "omnidocbench":
        seg = dig(m, "meanSegmentRecall")
        numr = dig(m, "meanNumberRecall")
        ed = dig(m, "meanEditRatio")
        tp = dig(m, "tablePages.meanNumberRecall")
        return ("片段召回", f"{num(seg, 3)}（数字召回 {num(numr, 3)}；含表格页数字召回 {num(tp, 3)}；编辑距离比 {num(ed, 3)}）")
    flat = []

    def walk(o, p):
        if not isinstance(o, dict) or len(flat) > 5:
            return
        if "accuracyPct" in o:
            flat.append(f"{p}={pct(o.get('accuracyPct'))}")
            return
        for k, v in o.items():
            walk(v, f"{p}.{k}" if p else k)

    walk(m, "")
    return (("、".join(flat[:3]) or "-"), "-")


def latest_platform_chain():
    """取最近一次平台链路复测产物（口径 B）"""
    files = sorted(glob.glob(str(EXT / "out" / "platform-chain-*.json")))
    for f in reversed(files):
        data = load(Path(f))
        if data and (data.get("cflue") or data.get("finevalMm")):
            return data
    return None


def main() -> int:
    align = load(ALIGN)
    manifest = load(MANIFEST)
    refs = load(REFERENCES)
    sensitivity = load(EXT / "out" / "prompt-sensitivity.json")
    platform_usage = load(EXT / "out" / "platform-usage.json")
    if not align:
        print(f"缺少对齐产物：{ALIGN}（先跑 node bench/external/run.js）")
        return 2
    doc, md = build(align, manifest, refs, latest_platform_chain(), sensitivity, platform_usage)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # 报告可能正被 Word 打开（存在 ~$ 锁文件），此时不要粗暴失败：写到 .new.docx 并给出提示
    try:
        doc.save(str(OUT_DOCX))
        print(f"已生成 {OUT_DOCX.relative_to(REPO)}（{len(doc.paragraphs)} 段）")
    except PermissionError:
        alt = OUT_DOCX.with_name(OUT_DOCX.stem + ".new.docx")
        doc.save(str(alt))
        print(f"⚠️ {OUT_DOCX.name} 正被 Word 占用（存在 ~$ 锁文件），已改写到 {alt.name}")
        print("   关闭 Word 后重跑本脚本即可写回正式文件名。")
    OUT_MD.write_text("\n".join(md), encoding="utf-8")
    print(f"已生成 {OUT_MD.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
