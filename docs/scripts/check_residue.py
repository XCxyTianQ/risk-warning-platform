# -*- coding: utf-8 -*-
"""定位残留标记与代码块换行情况。"""

import zipfile

import docx

P = r"E:\IUC\risk-warning-platform\docs\设计哲学-企业经营风险预警平台.docx"
doc = docx.Document(P)

for p in doc.paragraphs:
    if "**" in p.text:
        print("残留 ** 段落:", repr(p.text[:200]))
        for r in p.runs:
            print("   run:", repr(r.text[:80]))

z = zipfile.ZipFile(P)
xml = z.read("word/document.xml").decode("utf-8", "ignore")
print()
print("document.xml 中 <w:br/> 数量:", xml.count("<w:br/>"))
print("封面标题字号:", "w:sz w:val=\"56\"" in xml, "(56 半磅 = 28pt)")
print("页面宽度 A4:", "w:w=\"11906\"" in xml, "| 页高:", "w:h=\"16838\"" in xml)
