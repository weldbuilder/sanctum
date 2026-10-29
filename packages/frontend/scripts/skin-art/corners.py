#!/usr/bin/env python3
"""The copper corner fittings of a painted plate, cut out of the painting onto transparency.
usage: corners.py <source> <outdir> <prefix> <left> <top> <right> <bottom> <size>
(left/top/right/bottom: the plate's outer rim, in source pixels; each corner is a size x size square at that corner)."""
import sys
import numpy as np
from PIL import Image, ImageFilter
from collections import deque

src_path, outdir, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
Lx, Ty, Rx, By, S = (int(v) for v in sys.argv[4:9])
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

boxes = {'tl': (Lx, Ty), 'tr': (Rx - S + 1, Ty), 'bl': (Lx, By - S + 1), 'br': (Rx - S + 1, By - S + 1)}
for name, (x0, y0) in boxes.items():
    a = src[y0:y0 + S, x0:x0 + S]
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    copper = (r - b > 28) & (r > 70)
    lab, sizes = components(copper)
    big = max(sizes, key=sizes.get)
    keep = lab == big
    # the rivet: the largest other blob of a few pixels, inside the bracket's reach
    others = sorted((s, k) for k, s in sizes.items() if k != big and 3 <= s <= 40)
    if others: keep |= lab == others[-1][1]
    m = Image.fromarray((keep * 255).astype(np.uint8))
    body = np.asarray(m.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.45)), dtype=np.float64) / 255
    core = np.asarray(m.filter(ImageFilter.GaussianBlur(0.35)), dtype=np.float64) / 255
    shadow = np.clip(np.asarray(m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(0.9)), dtype=np.float64) / 255 - core, 0, 1) * 0.55
    # colour: the painting where the fitting is; near-black where only its shadow is
    alpha = np.clip(np.maximum(core, shadow), 0, 1)
    rgb = np.where((core > 0.02)[..., None], a, np.array([12, 8, 6]))
    out = np.dstack([rgb, alpha * 255]).round().clip(0, 255).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(f'{outdir}/{prefix}-{name}.png')
    print(name, 'fitting px', int(keep.sum()), file=sys.stderr)
