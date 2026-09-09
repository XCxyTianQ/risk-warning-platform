# -*- coding: utf-8 -*-
"""检查 docx styles.xml 中是否存在非法样式值（Word 会因此报"需要修复"）。"""

import re
import zipfile

P = r"E:\IUC\risk-warning-platform\docs\设计哲学-企业经营风险预警平台.docx"
z = zipfile.ZipFile(P)
print("包内文件:", z.namelist()[:14])

xml = z.read("word/styles.xml").decode("utf-8", "ignore")

for sid in ("Title", "Heading1", "Heading2", "Heading3", "Normal"):
    m = re.search(r'<w:style [^>]*w:styleId="' + sid + r'"[^>]*>.*?</w:style>', xml, re.S)
    if not m:
        print(f"{sid}: 未定义")
        continue
    frag = m.group(0)
    colors = re.findall(r"<w:color[^>]*/>", frag)
    fonts = re.findall(r"<w:rFonts[^>]*/>", frag)
    print(f"{sid}: color={colors[:2]} rFonts={[f[:90] for f in fonts[:1]]}")

print()
bad = re.findall(r'w:val="[Nn]one"', xml)
print("非法 val=None 出现次数:", len(bad))
