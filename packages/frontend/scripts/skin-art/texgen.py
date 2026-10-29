#!/usr/bin/env python3
"""A seamless leather tile from clean patches of a painting, in two layers:
  - the grain (everything finer than ~sigma px: pores, scuffs, flecks), taken from the painting itself and spread over a
    toroidal canvas by variance-preserving overlap of random patches (zero-mean detail, so no block edges can show);
  - the mottling (the large soft light/dark patches), as periodic 1/f noise, coloured with the painting's own blurred
    light, mid and dark leather.
usage: texgen.py <source> <out.png> <N> <seed> <mottle_gain> <grain_gain> x0,y0,x1,y1 [...]"""
import os
import sys
import numpy as np
from PIL import Image, ImageFilter

src_path, out_path = sys.argv[1], sys.argv[2]
N, seed = int(sys.argv[3]), int(sys.argv[4])
mottle_gain, grain_gain = float(sys.argv[5]), float(sys.argv[6])
rects = [tuple(int(v) for v in r.split(',')) for r in sys.argv[7:]]
rng = np.random.default_rng(seed)

img = Image.open(src_path).convert('RGB')
SIG = float(os.environ.get('TEXGEN_SIGMA', '5'))  # larger keeps a pattern's motifs in the grain layer
src = np.asarray(img, dtype=np.float64)
low = np.asarray(img.filter(ImageFilter.GaussianBlur(SIG)), dtype=np.float64)
hp = src - low

# the painting's own leather colours, from the blurred clean areas
lows = np.concatenate([low[y0:y1, x0:x1].reshape(-1, 3) for x0, y0, x1, y1 in rects])
lum = lows @ np.array([0.2126, 0.7152, 0.0722])
order = np.argsort(lum)
pick = lambda q: lows[order[int(q * (len(order) - 1))]]
dark, mid, light = pick(0.04), pick(0.5), pick(0.96)
if os.environ.get('TEXGEN_COLORS'):  # recolour the mottling (the grain stays the painting's): "r,g,b;r,g,b;r,g,b" dark;mid;light
    dark, mid, light = (np.array([float(v) for v in c.split(',')]) for c in os.environ['TEXGEN_COLORS'].split(';'))
print('dark', dark.round(), 'mid', mid.round(), 'light', light.round(), file=sys.stderr)

# grain: random patches of the high-pass, Hann-weighted, summed and divided by sqrt(sum w^2) (keeps its variance)
B = int(os.environ.get('TEXGEN_BLOCK', '40'))  # larger for a patterned cloth, so whole motifs survive
win = np.outer(np.hanning(B), np.hanning(B))
acc = np.zeros((N, N, 3)); wsq = np.zeros((N, N))
spots = [(y, x) for x0, y0, x1, y1 in rects for y in range(y0, y1 - B + 1) for x in range(x0, x1 - B + 1)]
for _ in range(int((N / B) ** 2 * 9)):
    sy, sx = spots[rng.integers(len(spots))]
    patch = hp[sy:sy + B, sx:sx + B]
    if not os.environ.get('TEXGEN_NOFLIP') and rng.random() < 0.5: patch = patch[:, ::-1]  # TEXGEN_NOFLIP keeps a weave's lean
    y, x = rng.integers(N), rng.integers(N)
    ys = (np.arange(B) + y) % N; xs = (np.arange(B) + x) % N
    acc[np.ix_(ys, xs)] += patch * win[..., None]
    wsq[np.ix_(ys, xs)] += win ** 2
grain = acc / np.sqrt(np.maximum(wsq, 1e-6))[..., None]
src_std = np.concatenate([hp[y0:y1, x0:x1].reshape(-1, 3) for x0, y0, x1, y1 in rects]).std(axis=0)
grain *= (src_std / grain.reshape(-1, 3).std(axis=0)) * grain_gain

# mottling: periodic noise with a 1/f^1.6 spectrum between ~300px and ~20px, normalised to [-1, 1]
fy = np.fft.fftfreq(N)[:, None]; fx = np.fft.fftfreq(N)[None, :]
# TEXGEN_ANISO (0..1) stretches the mottling along y, as a wood's soft streaks run along its grain
an = float(os.environ.get('TEXGEN_ANISO', '1'))
f = np.sqrt((fx * an) ** 2 + fy ** 2)
amp = np.where((f > 1 / 300) & (f < 1 / 20), 1 / np.maximum(f, 1e-9) ** 1.6, 0)
noise = np.real(np.fft.ifft2(amp * np.exp(2j * np.pi * rng.random((N, N)))))
noise = noise / np.abs(noise).max()
n3 = np.clip(noise * mottle_gain, -1, 1)[..., None]
base = np.where(n3 >= 0, mid + n3 * (light - mid), mid + (-n3) * (dark - mid))

out = np.clip(base + grain, 0, 255)
Image.fromarray(out.astype(np.uint8)).save(out_path)
o = out.reshape(-1, 3)
print('mean', o.mean(axis=0).round(), 'min', o.min(axis=0), 'max', o.max(axis=0), file=sys.stderr)
