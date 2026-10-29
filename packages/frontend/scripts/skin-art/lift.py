#!/usr/bin/env python3
"""A painted ornament lifted off its cloth by colour distance (alpha rises from t0 to t1 away from the cloth colour), its colour
unmixed from the cloth, specks under 30 px dropped, boxes (studs, rims) left out. Saved square, turned to sit bottom-left
(mirrored first if it was painted on the right), with a margin under and beside it so it clears the plate's corner piece.
usage: lift.py <source> <out.webp> <x0,y0,x1,y1> <cloth r,g,b> <t0> <t1> <painted: left|right> <margin> [exclude x0,y0,x1,y1 ...]"""
import sys
import numpy as np
from PIL import Image, ImageFilter
from collections import deque
src, out = sys.argv[1], sys.argv[2]
x0, y0, x1, y1 = (int(v) for v in sys.argv[3].split(','))
cloth = np.array([float(v) for v in sys.argv[4].split(',')])
t0, t1 = float(sys.argv[5]), float(sys.argv[6]); side = sys.argv[7]; margin = float(sys.argv[8])
a = np.asarray(Image.open(src).convert('RGB'), dtype=np.float64)[y0:y1, x0:x1]
d = np.sqrt(((a - cloth) ** 2).sum(-1))
alpha = np.clip((d - t0) / (t1 - t0), 0, 1)
import os
if os.environ.get('LIFT_NOBLUE'):  # leave out strongly blue paint (an avatar beside the sprig): blue above red and green by this much
    alpha[(a[..., 2] - np.maximum(a[..., 0], a[..., 1])) > float(os.environ['LIFT_NOBLUE'])] = 0
for box in sys.argv[9:]:
    bx0, by0, bx1, by1 = (int(v) for v in box.split(','))
    alpha[max(0, by0 - y0):max(0, by1 - y0), max(0, bx0 - x0):max(0, bx1 - x0)] = 0
mask = alpha > 0.1; lab = np.zeros(mask.shape, int); n = 0; sizes = {}
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
keep = np.isin(lab, [k for k, v in sizes.items() if v >= 30])
keep = np.asarray(Image.fromarray(keep.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(3)), dtype=bool)
alpha = alpha * keep
rgb = np.clip((a - (1 - alpha[..., None]) * cloth) / np.maximum(alpha, 1e-3)[..., None], 0, 255)
if os.environ.get('LIFT_BOLD'):  # thicken hairlines by about a pixel (a fine gold line otherwise vanishes when drawn small)
    k = float(os.environ['LIFT_BOLD'])
    A = Image.fromarray((alpha * 255).astype(np.uint8))
    grown = np.asarray(A.filter(ImageFilter.MaxFilter(3)), dtype=np.float64) / 255
    soft = np.asarray(A.filter(ImageFilter.BoxBlur(1)), dtype=np.float64) / 255 + 1e-6
    spread = np.dstack([np.asarray(Image.fromarray((rgb[..., c] * alpha).clip(0, 255).astype(np.uint8)).filter(ImageFilter.BoxBlur(1)), dtype=np.float64) for c in range(3)]) / soft[..., None]
    rgb = np.where((alpha > 0.5)[..., None], rgb, np.clip(spread, 0, 255))
    alpha = np.maximum(alpha, grown * k)
rgba = np.dstack([rgb, alpha * 255])
if side == 'right': rgba = rgba[:, ::-1]
ys, xs = np.nonzero(alpha > 0.04)
rgba = rgba[ys.min():ys.max() + 1, :][:, (xs.min() if side == 'left' else rgba.shape[1] - 1 - xs.max()):(xs.max() + 1 if side == 'left' else rgba.shape[1] - xs.min())]
h, w = rgba.shape[:2]
N = int(np.ceil(max(h, w) / (1 - margin)))
sq = np.zeros((N, N, 4)); oy = N - int(round(margin * N)) - h; ox = int(round(margin * N)); sq[oy:oy + h, ox:ox + w] = rgba
Image.fromarray(sq.round().clip(0, 255).astype(np.uint8), 'RGBA').save(out, 'WEBP', lossless=True)
print(out, w, 'x', h, '->', N, file=sys.stderr)
