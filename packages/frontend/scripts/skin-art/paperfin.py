#!/usr/bin/env python3
"""Roll a light paper tile's darkest fibres off above a per-channel floor (soft knee), encode WebP, and report the
worst text pair on it. usage: paperfin.py <in.png> <out.webp> <floor r,g,b> <knee share> <alpha> <base hex> <ink:min,...>"""
import sys, numpy as np
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
F = np.array([float(v) for v in sys.argv[3].split(',')]); knee = float(sys.argv[4]); alpha = float(sys.argv[5]); base = sys.argv[6]
inks = [(i.split(':')[0], float(i.split(':')[1])) for i in sys.argv[7].split(',')]
a = np.asarray(Image.open(src).convert('RGB'), dtype=np.float64)
mean = a.reshape(-1, 3).mean(0)
o = a.copy()
for c in range(3):
    k = F[c] + knee * (mean[c] - F[c]); v = a[..., c]
    o[..., c] = np.where(v >= k, v, k - (k - F[c]) * (1 - np.exp(-(k - v) / (k - F[c]))))
Image.fromarray(o.round().clip(0, 255).astype(np.uint8)).save(out, 'WEBP', quality=90, method=6)
b = np.asarray(Image.open(out).convert('RGB')).reshape(-1, 3)
def lin(v):
    v = np.asarray(v, float) / 255; return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
L = lambda c: float(lin(c) @ [0.2126, 0.7152, 0.0722])
hx = lambda h: np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], float)
h = lambda c: '#%02X%02X%02X' % tuple(int(round(x)) for x in c)
lo, hi = b.min(0), b.max(0)
comp = (1 - alpha) * hx(base) + alpha * lo
cr = lambda f, g: (max(L(f), L(g)) + 0.05) / (min(L(f), L(g)) + 0.05)
print(out, 'mean', h(b.mean(0)), 'extremes', h(lo), h(hi), 'std', b.std(0).round(1), 'bytes', len(open(out, 'rb').read()))
print('  darkest composite', h(comp), ' '.join(f"{n}:{cr(hx(n), comp):.2f}{'' if cr(hx(n), comp) >= m else ' FAIL'}" for n, m in inks))
