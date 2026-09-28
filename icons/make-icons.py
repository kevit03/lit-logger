#!/usr/bin/env python3
"""Renders the LIT padlock mark to icons/icon{16,48,128}.png.

A closed padlock (shackle engaged: "locked in") in white on a blue rounded
square, the same mark the popup header and calendar dock draw inline as SVG.
Drawn at 8x and downsampled so the small sizes stay crisp. Needs Pillow:

    python3 icons/make-icons.py
"""
import os
from PIL import Image, ImageDraw

BLUE = (26, 115, 232, 255)      # #1a73e8, matches --blue
WHITE = (255, 255, 255, 255)
SIZES = (16, 48, 128)
SCALE = 8


def render(size):
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = s / 24.0  # work in the same 24-unit grid as the SVG mark

    # Background: rounded square.
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=BLUE)

    # Shackle: two uprights joined by a half ring, round caps.
    stroke = 2.2 * u
    r_out = 4 * u + stroke / 2
    r_in = 4 * u - stroke / 2
    cx, cy = 12 * u, 7.5 * u
    d.pieslice([cx - r_out, cy - r_out, cx + r_out, cy + r_out], 180, 360, fill=WHITE)
    d.pieslice([cx - r_in, cy - r_in, cx + r_in, cy + r_in], 180, 360, fill=BLUE)
    for x in (8 * u, 16 * u):
        d.rectangle([x - stroke / 2, cy, x + stroke / 2, 11.6 * u], fill=WHITE)

    # Body.
    d.rounded_rectangle([5 * u, 11 * u, 19 * u, 21 * u], radius=2.5 * u, fill=WHITE)

    # Keyhole: a disc with a tapered slot, cut back to the background color.
    kr = 1.6 * u
    kx, ky = 12 * u, 15 * u
    d.ellipse([kx - kr, ky - kr, kx + kr, ky + kr], fill=BLUE)
    d.polygon([(11.2 * u, 16.3 * u), (12.8 * u, 16.3 * u), (13.1 * u, 18.6 * u), (10.9 * u, 18.6 * u)], fill=BLUE)

    return img.resize((size, size), Image.LANCZOS)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    for size in SIZES:
        path = os.path.join(here, "icon%d.png" % size)
        render(size).save(path, optimize=True)
        print("wrote", path)


if __name__ == "__main__":
    main()
