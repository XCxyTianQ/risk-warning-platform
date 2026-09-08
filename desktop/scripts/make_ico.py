# -*- coding: utf-8 -*-
"""把 PNG 打包成 ICO（Vista+ 支持 PNG 压缩的 ICO），供 electron-builder 使用。

用法（任意目录）：python desktop/scripts/make_ico.py
"""

import struct
from pathlib import Path

build = Path(__file__).resolve().parents[1] / "build"
png = (build / "icon.png").read_bytes()

# ICONDIR + 单个 ICONDIRENTRY（256x256，PNG 载荷）
header = struct.pack("<HHH", 0, 1, 1)
entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)
(build / "icon.ico").write_bytes(header + entry + png)
print("ICO 生成:", build / "icon.ico", len(png) + 22, "bytes")
