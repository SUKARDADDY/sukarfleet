#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Generate tray + app icons from the sukarfleet brand mark (brand/icon-reduced.svg
geometry: hex mesh on a 100-unit grid). The mesh silhouette is constant; the CENTER
node carries the health state — colour AND shape (colourblind-safe, survives GNOME
monochrome handling): ok=circle, degraded=triangle, critical=octagon, setup=circle
(blue), unknown=ring, unreachable=ring+slash. App icons come from the provided
brand PNGs, not drawn here."""
from PIL import Image, ImageDraw
import math, os

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "..", "src-tauri", "icons")
BRAND = os.path.join(HERE, "..", "brand")
SIZES = [22, 24, 32, 48]
SS = 4  # supersample factor

MESH = "#EDEDED"
OK, WARN, BAD, BLUE, GREY = "#00D68F", "#d79921", "#cc3333", "#4a86cf", "#8a8f98"

# brand/icon-reduced.svg geometry (100-unit grid)
HEX = [(50, 12), (82.9, 31), (82.9, 69), (50, 88), (17.1, 69), (17.1, 31)]
STROKE = 5.5
NODE_R = 5.4
CENTER_R = 13.0


def canvas(units):
    img = Image.new("RGBA", (units, units), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def draw_mesh(d, f):
    pts = [(x * f, y * f) for x, y in HEX]
    d.line(pts + [pts[0]], fill=MESH, width=max(1, round(STROKE * f)), joint="curve")
    r = NODE_R * f
    for x, y in pts:
        d.ellipse([x - r, y - r, x + r, y + r], fill=MESH)


def center_circle(d, f, color, r=CENTER_R):
    c, rr = 50 * f, r * f
    d.ellipse([c - rr, c - rr, c + rr, c + rr], fill=color)


def center_ring(d, f, color):
    c, rr = 50 * f, CENTER_R * f
    d.ellipse([c - rr, c - rr, c + rr, c + rr], outline=color, width=max(1, round(5 * f)))


def draw_state(d, f, state):
    if state == "ok":
        center_circle(d, f, OK)
    elif state == "setup":
        center_circle(d, f, BLUE)
    elif state == "degraded":
        c, r = 50 * f, 16 * f
        d.polygon([(c, c - r), (c + r * 0.9, c + r * 0.7), (c - r * 0.9, c + r * 0.7)], fill=WARN)
    elif state == "critical":
        c, r = 50 * f, 15.5 * f
        pts = [(c + r * math.cos(math.radians(22.5 + 45 * i)),
                c + r * math.sin(math.radians(22.5 + 45 * i))) for i in range(8)]
        d.polygon(pts, fill=BAD)
    elif state == "unknown":
        center_ring(d, f, GREY)
    elif state == "unreachable":
        center_ring(d, f, GREY)
        w = max(1, round(STROKE * f))
        d.line([20 * f, 80 * f, 80 * f, 20 * f], fill=GREY, width=w)


STATES = ["ok", "degraded", "critical", "setup", "unknown", "unreachable"]

for state in STATES:
    for s in SIZES:
        big = s * SS
        f = big / 100.0
        img, d = canvas(big)
        draw_mesh(d, f)
        draw_state(d, f, state)
        img = img.resize((s, s), Image.LANCZOS)
        img.save(os.path.join(OUT, f"tray-{state}-{s}.png"))
        # badge variant: unread-notification dot, bottom-right (blue — green would
        # vanish against the ok state)
        bimg, bd = canvas(big)
        draw_mesh(bd, f)
        draw_state(bd, f, state)
        br = 14 * f
        bd.ellipse([big - br * 2, big - br * 2, big, big], fill=BLUE)
        bimg = bimg.resize((s, s), Image.LANCZOS)
        bimg.save(os.path.join(OUT, f"tray-{state}-badge-{s}.png"))

# App/bundle icons from the provided brand renders
src512 = Image.open(os.path.join(BRAND, "app-icon-512.png")).convert("RGBA")
for s, name in [(32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")]:
    src512.resize((s, s), Image.LANCZOS).save(os.path.join(OUT, name))
src512.save(os.path.join(OUT, "icon.png"))

# Windows takes the executable's icon from a resource compiled into the binary at
# build time, and Explorer, the taskbar, the Start menu and alt-tab each pull a
# different size out of it. One .ico holds all of them; a PNG holds none, and a
# Windows build without this file ships with the generic executable icon.
src512.save(
    os.path.join(OUT, "icon.ico"),
    format="ICO",
    sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)],
)

print("icons written to", os.path.abspath(OUT))
