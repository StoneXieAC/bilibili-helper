"""生成旧版深色断环图标的设计稿。"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets"
ITERS = OUT / "icon-iters"
ITERS.mkdir(parents=True, exist_ok=True)

BLUE = (0, 161, 214, 255)
PINK = (251, 114, 153, 255)
BG = (15, 23, 42, 255)  # matches panel --bdl-bg
SIZE = 1024


def rounded_bg(size: int, bg: tuple, ratio: float = 0.22) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * ratio), fill=bg
    )
    return img


def squircle_mask(img: Image.Image, ratio: float = 0.22) -> Image.Image:
    s = img.size[0]
    m = Image.new("L", (s, s), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * ratio), fill=255)
    out = img.copy()
    out.putalpha(m)
    return out


def thick_line(draw, p0, p1, width, color):
    draw.line([p0, p1], fill=color, width=width)
    r = width / 2
    for x, y in (p0, p1):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


def soft_glow(base: Image.Image, color, blur=18, alpha=55) -> Image.Image:
    """Subtle halo for dark-toolbar readability."""
    mask = base.split()[-1]
    tint = Image.new("RGBA", base.size, (*color[:3], alpha))
    tint.putalpha(mask.point(lambda a: min(255, int(a * 0.7))))
    tint = tint.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(tint, base)


def compose() -> Image.Image:
    img = rounded_bg(SIZE, BG)
    d = ImageDraw.Draw(img)

    # Moderate / airy — closer to popular extension icons (more padding than
    # the previous full-bleed). Content ≈ 68% of canvas.
    cx = SIZE / 2
    cy = SIZE / 2 + 10
    r = 348          # diameter ≈ 68%
    stroke = 46      # refined line weight
    gap = 52

    # Antennas — short, vertical, ball tips
    spread = r * 0.27
    stem = r * 0.17
    stem_w = max(int(stroke * 0.55), 18)
    ball = max(int(stroke * 0.40), 12)
    y_base = cy - r + stroke * 0.30
    for sign in (-1, 1):
        x = cx + sign * spread
        y1 = y_base - stem
        thick_line(d, (x, y_base), (x, y1), stem_w, BLUE)
        d.ellipse([x - ball, y1 - ball, x + ball, y1 + ball], fill=BLUE)

    half = gap / 2
    start, end = 90 + half, 90 - half + 360
    d.arc([cx - r, cy - r, cx + r, cy + r], start=start, end=end, fill=BLUE, width=stroke)
    for ang in (start, end):
        rad = math.radians(ang)
        x = cx + r * math.cos(rad)
        y = cy + r * math.sin(rad)
        rr = stroke / 2
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=BLUE)

    # Download — balanced inside ring (~42% of inner diameter)
    inner = 2 * (r - stroke / 2)
    scale = inner * 0.42
    sw = scale * 0.26
    aw = scale * 0.55
    dl_cy = cy + 6
    top = dl_cy - scale * 0.52
    neck = dl_cy + scale * 0.02
    tip = dl_cy + scale * 0.46

    arrow = [
        (cx - sw / 2, top),
        (cx + sw / 2, top),
        (cx + sw / 2, neck),
        (cx + aw, neck),
        (cx, tip),
        (cx - aw, neck),
        (cx - sw / 2, neck),
    ]
    d.polygon(arrow, fill=PINK)
    d.ellipse([cx - sw / 2, top - sw / 2, cx + sw / 2, top + sw / 2], fill=PINK)

    tray_w = max(int(stroke * 0.95), 32)
    ty = tip + scale * 0.14
    tw = scale * 0.60
    th = scale * 0.24
    thick_line(d, (cx - tw, ty), (cx - tw, ty + th), tray_w, PINK)
    thick_line(d, (cx + tw, ty), (cx + tw, ty + th), tray_w, PINK)
    thick_line(d, (cx - tw, ty + th), (cx + tw, ty + th), tray_w, PINK)

    # Very light glow only — avoid “neon blob” look
    img = soft_glow(img, BLUE, blur=12, alpha=28)

    img = squircle_mask(img)
    a = img.split()[-1]
    rgb = ImageEnhance.Contrast(img.convert("RGB")).enhance(1.03)
    img = rgb.convert("RGBA")
    img.putalpha(a)
    return img


def main() -> None:
    img = compose()
    img.save(ITERS / "icon-iter-14-moderate.png", "PNG", optimize=True)
    # quick fill report
    px = img.load()
    br, bg, bb = BG[:3]
    minx = miny = SIZE
    maxx = maxy = 0
    for y in range(SIZE):
        for x in range(SIZE):
            r, g, b, a = px[x, y]
            if a < 20:
                continue
            if abs(r - br) + abs(g - bg) + abs(b - bb) < 30:
                continue
            minx = min(minx, x)
            miny = min(miny, y)
            maxx = max(maxx, x)
            maxy = max(maxy, y)
    span = maxx - minx
    print(f"OK moderate icon — content width {span}/{SIZE} = {100*span/SIZE:.1f}%")


if __name__ == "__main__":
    main()
