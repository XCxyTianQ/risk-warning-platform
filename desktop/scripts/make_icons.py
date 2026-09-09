# -*- coding: utf-8 -*-
"""生成应用图标（跨平台打包用）：1024×1024 PNG + 256×256 ICO。

- `icon.png`：electron-builder 在 macOS 上据此自动生成 icon.icns（要求 ≥512×512）
- `icon.ico`：Windows 打包用（Vista+ PNG 载荷，≤256×256）

用法（任意目录）：python desktop/scripts/make_icons.py
依赖：pillow
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BUILD = Path(__file__).resolve().parents[1] / "build"
BUILD.mkdir(parents=True, exist_ok=True)

SIZE = 1024
NAVY = (15, 27, 61)
BLUE = (37, 99, 235)
CYAN = (6, 182, 212)
WHITE = (255, 255, 255)

# ---------- 背景：圆角方块 + 对角渐变 ----------
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
grad = Image.new("RGB", (SIZE, SIZE))
px = grad.load()
for y in range(SIZE):
    for x in range(SIZE):
        t = (x + y) / (2 * (SIZE - 1))
        px[x, y] = (
            int(NAVY[0] + (BLUE[0] - NAVY[0]) * t),
            int(NAVY[1] + (BLUE[1] - NAVY[1]) * t),
            int(NAVY[2] + (BLUE[2] - NAVY[2]) * t),
        )

mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.22), fill=255)
img.paste(grad, (0, 0), mask)

draw = ImageDraw.Draw(img)

# ---------- 装饰：右下角折线（风险走势） ----------
w = int(SIZE * 0.055)
pts = [(int(SIZE * 0.18), int(SIZE * 0.74)), (int(SIZE * 0.36), int(SIZE * 0.60)),
       (int(SIZE * 0.52), int(SIZE * 0.70)), (int(SIZE * 0.82), int(SIZE * 0.40))]
draw.line(pts, fill=CYAN, width=w, joint="curve")
for cx, cy in pts:
    r = int(SIZE * 0.028)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)

# ---------- 主视觉：字符「险」 ----------
glyph = "险"
font = None
for candidate in (
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
):
    if Path(candidate).exists():
        try:
            font = ImageFont.truetype(candidate, int(SIZE * 0.52))
            break
        except OSError:
            continue

if font is not None:
    box = draw.textbbox((0, 0), glyph, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    tx = (SIZE - tw) / 2 - box[0]
    ty = int(SIZE * 0.30) - box[1]
    draw.text((tx + 6, ty + 6), glyph, font=font, fill=(0, 0, 0, 70))   # 阴影
    draw.text((tx, ty), glyph, font=font, fill=WHITE)
else:  # 无中文字体时退回几何标记（盾牌 + 叹号）
    draw.rounded_rectangle([int(SIZE * 0.30), int(SIZE * 0.16), int(SIZE * 0.70), int(SIZE * 0.56)],
                           radius=int(SIZE * 0.10), outline=WHITE, width=int(SIZE * 0.045))
    draw.rectangle([int(SIZE * 0.475), int(SIZE * 0.24), int(SIZE * 0.525), int(SIZE * 0.42)], fill=WHITE)
    draw.ellipse([int(SIZE * 0.465), int(SIZE * 0.45), int(SIZE * 0.535), int(SIZE * 0.52)], fill=WHITE)

img.save(BUILD / "icon.png")
print("PNG:", BUILD / "icon.png", img.size)

# ---------- ICO：256×256 单尺寸（PNG 载荷） ----------
ico_img = img.resize((256, 256), Image.LANCZOS)
ico_img.save(BUILD / "icon.ico", format="ICO", sizes=[(256, 256)])
print("ICO:", BUILD / "icon.ico")
