#!/usr/bin/env python3
"""A painted sprig lifted off its cloth onto transparency: alpha from how much brighter (and bluer) it is than the cloth,
colour unmixed from the cloth so the painted shading stays. Metal (the plate's bracket) is left out.
usage: sprig.py <source> <out.webp> <x0> <y0> <x1> <y1> <cloth r,g,b> <full-strength lum> [left bottom]
left/bottom: the margin kept under and beside the sprig in its square, as a share of the square (default 0 0), so it rises
above and beside the plate's corner bracket, as painted."""
import sys
import numpy as np
from PIL import Image, ImageFilter

src_path, out_path = sys.argv[1], sys.argv[2]
x0, y0, x1, y1 = (int(v) for v in sys.argv[3:7])
cloth = np.array([float(v) for v in sys.argv[7].split(',')])
full = float(sys.argv[8])
a = np.asarray(Image.open(src_path).convert('RGB'), dtype=np.float64)[y0:y1, x0:x1]
lum = a @ np.array([0.2126, 0.7152, 0.0722])
base = float(cloth @ np.array([0.2126, 0.7152, 0.0722]))
blue = (a[..., 2] - a[..., 0]) > 25
alpha = np.clip((lum - base - 4) / (full - base), 0, 1) * blue
alpha = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(3)), dtype=np.float64) / 255
# keep only the sprig itself: drop specks and slivers (a few pixels of rim line or cloth fleck) smaller than 30 pixels
from collections import deque
mask = alpha > 0.08; lab = np.zeros(mask.shape, dtype=int); n = 0; sizes = {}
for sy, sx in zip(*np.nonzero(mask)):
    if lab[sy, sx]: continue
    n += 1; q = deque([(sy, sx)]); lab[sy, sx] = n; c = 0
    while q:
        cy, cx = q.popleft(); c += 1
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = n; q.append((ny, nx))
    sizes[n] = c
small = np.isin(lab, [k for k, v in sizes.items() if v < 30])
grown = np.asarray(Image.fromarray((~small & mask).astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(3)), dtype=bool)
alpha = alpha * grown
safe = np.maximum(alpha, 1e-3)[..., None]
rgb = np.clip((a - (1 - alpha[..., None]) * cloth) / safe, 0, 255)
ys, xs = np.nonzero(alpha > 0.04)
by0, by1, bx0, bx1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
rgba = np.dstack([rgb, alpha * 255])[by0:by1, bx0:bx1]
left, bottom = (float(v) for v in sys.argv[9:11]) if len(sys.argv) > 10 else (0.0, 0.0)
h, w = rgba.shape[:2]
n = int(np.ceil(max(h / (1 - bottom), w / (1 - left))))
ox, oy = int(round(left * n)), n - int(round(bottom * n)) - h
sq = np.zeros((n, n, 4)); sq[oy:oy + h, ox:ox + w] = rgba  # bottom-left, above and beside the bracket, as it sits on the plate
Image.fromarray(sq.round().clip(0, 255).astype(np.uint8), 'RGBA').save(out_path, 'WEBP', lossless=True)
print('sprig', w, 'x', h, '->', n, file=sys.stderr)
