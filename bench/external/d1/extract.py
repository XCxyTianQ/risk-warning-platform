#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""D1 第一步：从 FinanceBench 的 10-K PDF 里抽文本，并**立刻验证抽出来的文本里有没有答案**。

为什么先做这一步：如果抽出来的文本根本不含标准答案所在的段落，
后面所有的检索与作答都是白搭——必须先证明"抽取这一环没把答案弄丢"。

用法：
  python bench/external/d1/extract.py --docs 3M_2018_10K,ADOBE_2018_10K --check
  python bench/external/d1/extract.py --all
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
RAW = REPO / "bench" / "external" / "cache" / "raw"
PDF_DIR = RAW / "financebench_pdfs"
TXT_DIR = RAW / "financebench_text"
OUT = REPO / "bench" / "external" / "out"
PDF_DIR.mkdir(parents=True, exist_ok=True)
TXT_DIR.mkdir(parents=True, exist_ok=True)


def norm(s: str) -> str:
    """归一化：去空白与常见标点，便于"答案是否在文本里"的包含判断"""
    s = re.sub(r"[\u00a0\u3000]", " ", s or "")
    s = re.sub(r"\s+", "", s)
    return re.sub(r"[，。、；：（）()\[\]「」【】《》\"'`~!@#$%^&*_+=|\\/<>,.;:?\-—]", "", s).lower()


def extract(pdf: Path) -> tuple[str, dict]:
    from pypdf import PdfReader

    reader = PdfReader(str(pdf))
    pages = []
    for i, page in enumerate(reader.pages):
        try:
            pages.append(page.extract_text() or "")
        except Exception as e:  # 个别页抽不出来不应中断整篇
            pages.append("")
            print(f"    ! 第 {i + 1} 页抽取失败：{e}", file=sys.stderr)
    text = "\n".join(pages)
    meta = {
        "file": pdf.name,
        "bytes": pdf.stat().st_size,
        "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
        "pages": len(reader.pages),
        "chars": len(text),
        "charsPerPage": round(len(text) / max(1, len(reader.pages)), 1),
        "emptyPages": sum(1 for p in pages if len(p.strip()) < 20),
    }
    return text, meta


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--check", action="store_true", help="与题目里的标准答案/证据做包含性比对")
    args = ap.parse_args()

    questions = [json.loads(l) for l in (RAW / "financebench_open_source.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    by_doc: dict[str, list] = {}
    for q in questions:
        by_doc.setdefault(q["doc_name"], []).append(q)

    if args.all:
        docs = sorted(by_doc)
    elif args.docs:
        docs = [d.strip() for d in args.docs.split(",") if d.strip()]
    else:
        docs = sorted(by_doc)[:3]

    manifest = []
    for i, doc in enumerate(docs, 1):
        pdf = PDF_DIR / f"{doc}.pdf"
        if not pdf.exists():
            print(f"[{i}/{len(docs)}] 缺少 PDF：{pdf.name}（先跑下载脚本）", file=sys.stderr)
            continue
        txt_file = TXT_DIR / f"{doc}.txt"
        if txt_file.exists():
            text = txt_file.read_text(encoding="utf-8")
            meta = json.loads((TXT_DIR / f"{doc}.meta.json").read_text(encoding="utf-8"))
        else:
            try:
                text, meta = extract(pdf)
            except Exception as e:  # 单篇失败不能中断整批（例如 AES 加密或缺依赖）
                print(f"[{i}/{len(docs)}] ❌ {doc}: {type(e).__name__}: {e}", file=sys.stderr)
                manifest.append({"file": doc, "error": f"{type(e).__name__}: {e}"})
                continue
            txt_file.write_text(text, encoding="utf-8")
            (TXT_DIR / f"{doc}.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        line = f"[{i}/{len(docs)}] {doc}: {meta['pages']} 页 / {meta['chars']:,} 字 / {meta['charsPerPage']} 字每页 / 空页 {meta['emptyPages']}"
        if args.check:
            qs = by_doc.get(doc, [])
            hits = 0
            for q in qs:
                # 用标准答案的数字/关键词判断"答案要素是否在抽取文本里"
                ev_norm = norm(" ".join(e.get("evidence_text", "") for e in (q.get("evidence") or [])))
                ans_norm = norm(str(q.get("answer", "")))
                probe = ev_norm[:400] if len(ev_norm) > 400 else ev_norm
                found_ev = bool(probe) and probe in norm(text)
                found_ans = bool(ans_norm) and ans_norm in norm(text)
                if found_ev or found_ans:
                    hits += 1
            line += f" | 该文档 {len(qs)} 题：证据/答案能在抽取文本中定位 {hits} 题"
        print(line)
        manifest.append({**meta, "questions": len(by_doc.get(doc, []))})

    if manifest:
        OUT.mkdir(parents=True, exist_ok=True)
        f = OUT / "d1-extract-manifest.json"
        prev = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {"docs": []}
        merged = {d["file"]: d for d in prev.get("docs", [])}
        for m in manifest:
            merged[m["file"]] = m
        f.write_text(json.dumps({"docs": sorted(merged.values(), key=lambda x: x["file"])}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n清单已更新：{f.relative_to(REPO)}（累计 {len(merged)} 份）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
