#!/usr/bin/env python3
"""The silver brackets at the four corners of a painted plate, cut out onto transparency without the plate's rim
(the stylesheet draws the rim; the bracket sits just inside it).
usage: brackets.py <source> <outdir> <prefix> <left> <top> <right> <bottom> <size> <rim>
(left/top/right/bottom: the plate's outer edge in source pixels; size: the square cut at each corner; rim: how many
pixels in from the outer edge belong to the rim, and are left out)."""
import sys
import numpy as np
from PIL import Image, ImageFilter
from collections import deque

src_path, outdir, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
Lx, Ty, Rx, By, S, RIM = (int(v) for v in sys.argv[4:10])
src = np.asarray(Image.open(src_path).convert('RGB'), dtype=np.float64)

def components(mask):
    lab = np.zeros(mask.shape, dtype=int); n = 0; sizes = {}
    for y, x in zip(*np.nonzero(mask)):
        if lab[y, x]: continue
        n += 1; q = deque([(y, x)]); lab[y, x] = n; c = 0
        while q:
            cy, cx = q.popleft(); c += 1
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = n; q.append((ny, nx))
        sizes[n] = c
    return lab, sizes

boxes = {'tl': (Lx, Ty, False, False), 'tr': (Rx - S + 1, Ty, True, False), 'bl': (Lx, By - S + 1, False, True), 'br': (Rx - S + 1, By - S + 1, True, True)}
yy, xx = np.mgrid[0:S, 0:S]
for name, (x0, y0, flipx, flipy) in boxes.items():
    a = src[y0:y0 + S, x0:x0 + S]
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    # distance from the two outer edges this corner touches
    dx = (S - 1 - xx) if flipx else xx
    dy = (S - 1 - yy) if flipy else yy
    inside = (dx >= RIM) & (dy >= RIM)
    metal = (lum > 38) & (b - r < 26) & inside
    lab, sizes = components(metal)
    keep = np.zeros_like(metal)
    for k, sz in sizes.items():
        if sz >= 12: keep |= lab == k
    m = Image.fromarray((keep * 255).astype(np.uint8))
    core = np.asarray(m.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.4)), dtype=np.float64) / 255
    shadow = np.clip(np.asarray(m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.0)), dtype=np.float64) / 255 - core, 0, 1) * 0.6
    shadow *= inside
    alpha = np.clip(np.maximum(core, shadow), 0, 1)
    rgb = np.where((core > 0.02)[..., None], a, np.array([2, 4, 12]))
    out = np.dstack([rgb, alpha * 255]).round().clip(0, 255).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(f'{outdir}/{prefix}-{name}.png')
    print(name, 'bracket px', int(keep.sum()), file=sys.stderr)
