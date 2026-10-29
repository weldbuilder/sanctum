#!/usr/bin/env python3
"""Finish a dark cloth tile: move its mean to the plate colour (its grain and mottling kept), then roll its brightest pixels
off (a soft knee, per channel) until every ink keeps its contrast on the lightest composite at the plate's alpha.
usage: clothfin.py <in.png> <out.webp> <plate hex> <alpha> <ink:min,...>"""
import sys, numpy as np
from PIL import Image
src, out, plate, alpha = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
inks = [(i.split(':')[0], float(i.split(':')[1])) for i in sys.argv[5].split(',')]
hx = lambda h: np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], float)
hh = lambda c: '#%02X%02X%02X' % tuple(int(round(x)) for x in c)
def lin(v):
    v = np.asarray(v, float) / 255; return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
L = lambda c: float(lin(c) @ [0.2126, 0.7152, 0.0722])
cr = lambda f, g: (max(L(f), L(g)) + 0.05) / (min(L(f), L(g)) + 0.05)
a = np.asarray(Image.open(src).convert('RGB'), dtype=np.float64)
P = hx(plate)
a = a - a.reshape(-1, 3).mean(0) + P
spread = a.reshape(-1, 3).max(0) - P
for f in np.linspace(1.0, 0.15, 60):
    cap = P + spread * f; o = a.copy()
    for c in range(3):
        C = cap[c]; k = P[c] + 0.6 * (C - P[c]); v = a[..., c]
        o[..., c] = np.where(v <= k, v, k + (C - k) * (1 - np.exp(-(v - k) / max(C - k, 1e-6))))
    o = np.clip(o, 0, 255)
    Image.fromarray(o.round().astype(np.uint8)).save(out, 'WEBP', quality=90, method=6)
    b = np.asarray(Image.open(out).convert('RGB')).reshape(-1, 3)
    lo, hi = b.min(0), b.max(0)
    worst = [(1 - alpha) * P + alpha * x for x in (lo, hi)]
    if all(cr(hx(i), w) >= m for i, m in inks for w in worst): break
print(out, 'mean', hh(b.mean(0)), 'extremes', hh(lo), hh(hi), 'std', b.std(0).round(1), 'bytes', len(open(out, 'rb').read()), 'cap share', round(f, 2))
print('  ', ' '.join(f'{i}:{min(cr(hx(i), w) for w in worst):.2f}' for i, m in inks))
