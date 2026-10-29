#!/usr/bin/env python3
"""Gold corner brackets that sit over a painted plate's rim, cut out by their own dark outline: a flood fill from the rivet
through everything brighter than the outline, bounded by the corner square, its holes filled, the outline added back as a
soft dark rim. usage: goldbrackets.py <source> <outdir> <prefix> <left> <top> <right> <bottom> <size> <rivet> <outline lum>
(left/top/right/bottom: the plate's outer edge; size: the square cut at each corner; rivet: its offset from the corner)."""
import sys
import numpy as np
from PIL import Image, ImageFilter
from collections import deque

src_path, outdir, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
Lx, Ty, Rx, By, S, RV = (int(v) for v in sys.argv[4:10])
OUT = float(sys.argv[10])
src = np.asarray(Image.open(src_path).convert('RGB'), dtype=np.float64)
boxes = {'tl': (Lx, Ty, False, False), 'tr': (Rx - S + 1, Ty, True, False), 'bl': (Lx, By - S + 1, False, True), 'br': (Rx - S + 1, By - S + 1, True, True)}
for name, (x0, y0, fx, fy) in boxes.items():
    a = src[y0:y0 + S, x0:x0 + S]
    lum = a @ np.array([0.2126, 0.7152, 0.0722])
    sy = S - 1 - RV if fy else RV; sx = S - 1 - RV if fx else RV
    open_ = lum > OUT
    fill = np.zeros((S, S), bool); q = deque([(sy, sx)]); fill[sy, sx] = True
    while q:
        cy, cx = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < S and 0 <= nx < S and open_[ny, nx] and not fill[ny, nx]:
                fill[ny, nx] = True; q.append((ny, nx))
    m = Image.fromarray((fill * 255).astype(np.uint8))
    m = m.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))  # open: drop the rim's 1px highlight the fill leaks along
    closed = m.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))  # close pinholes (the rivet's dark ring)
    body = np.asarray(closed.filter(ImageFilter.GaussianBlur(0.4)), dtype=np.float64) / 255
    rim = np.clip(np.asarray(closed.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.6)), dtype=np.float64) / 255 - body, 0, 1)
    alpha = np.clip(body + rim * 0.85, 0, 1)
    rgb = np.where((body > 0.05)[..., None], a, np.array([20, 8, 2]))
    Image.fromarray(np.dstack([rgb, alpha * 255]).round().clip(0, 255).astype(np.uint8), 'RGBA').save(f'{outdir}/{prefix}-{name}.png')
    print(name, 'filled px', int(fill.sum()), 'of', S * S, file=sys.stderr)
