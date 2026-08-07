#!/usr/bin/env python3
"""Generate tray + app icons. Shape AND colour encode state (colourblind-safe,
survives GNOME monochrome handling): ok=dot, degraded=triangle, critical=octagon,
unknown=hollow ring, unreachable=ring+slash, setup=dot-in-ring."""
from PIL import Image, ImageDraw
import math, os

OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
SIZES = [22, 24, 32, 48]
OK, WARN, BAD, GREY, BLUE = "#2ea36b", "#d79921", "#cc3333", "#8a8f98", "#4a86cf"


def canvas(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def pad(size):
    return max(1, size // 10)


def draw_ok(d, s):
    p = pad(s)
    d.ellipse([p, p, s - p, s - p], fill=OK)


def draw_degraded(d, s):
    p = pad(s)
    d.polygon([(s / 2, p), (s - p, s - p), (p, s - p)], fill=WARN)


def draw_critical(d, s):
    p = pad(s)
    c, r = s / 2, s / 2 - p
    pts = [(c + r * math.cos(math.radians(22.5 + 45 * i)),
            c + r * math.sin(math.radians(22.5 + 45 * i))) for i in range(8)]
    d.polygon(pts, fill=BAD)


def draw_unknown(d, s):
    p = pad(s)
    w = max(2, s // 8)
    d.ellipse([p, p, s - p, s - p], outline=GREY, width=w)


def draw_unreachable(d, s):
    draw_unknown(d, s)
    p = pad(s)
    w = max(2, s // 10)
    d.line([p + w, s - p - w, s - p - w, p + w], fill=GREY, width=w)


def draw_setup(d, s):
    p = pad(s)
    w = max(2, s // 10)
    d.ellipse([p, p, s - p, s - p], outline=BLUE, width=w)
    q = s // 3
    d.ellipse([q, q, s - q, s - q], fill=BLUE)


STATES = {
    "ok": draw_ok,
    "degraded": draw_degraded,
    "critical": draw_critical,
    "unknown": draw_unknown,
    "unreachable": draw_unreachable,
    "setup": draw_setup,
}

for name, fn in STATES.items():
    for s in SIZES:
        img, d = canvas(s)
        fn(d, s)
        img.save(os.path.join(OUT, f"tray-{name}-{s}.png"))
    # badge variant: small blue dot bottom-right (unread notification)
    for s in SIZES:
        img, d = canvas(s)
        fn(d, s)
        r = s // 4
        d.ellipse([s - r * 2, s - r * 2, s, s], fill=BLUE)
        img.save(os.path.join(OUT, f"tray-{name}-badge-{s}.png"))

# App icons (bundle): rounded square + ok dot
for s in [32, 128, 256, 512]:
    img, d = canvas(s)
    p = s // 16
    d.rounded_rectangle([p, p, s - p, s - p], radius=s // 5, fill="#1d2230")
    q = s // 4
    d.ellipse([q, q, s - q, s - q], fill=OK)
    suffix = {32: "32x32.png", 128: "128x128.png", 256: "128x128@2x.png", 512: "icon.png"}[s]
    img.save(os.path.join(OUT, suffix))

print("icons written to", os.path.abspath(OUT))
