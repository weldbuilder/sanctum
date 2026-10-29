#!/usr/bin/env python3
"""The painted sprigs as a set of corner variants: each recoloured to the cloth it will sit on (its alpha-weighted mean moved
to that cloth's sprig colour, its painted shading kept, its strength brought to the same peak) and turned to each corner.
usage: sprigset.py <outdir> <prefix> <dark r,g,b> <light r,g,b> <peak alpha> <name=in.webp> ...
writes <prefix>-<name>-bl/-tl (dark, the left plates) and -br/-tr (light, mirrored, the right plates)."""
import sys
import numpy as np
from PIL import Image
out, prefix = sys.argv[1], sys.argv[2]
keep = sys.argv[3] == 'keep'  # 'keep keep': the paintings keep their own colours on every cloth
dark, light = (None, None) if keep else (np.array([float(v) for v in c.split(',')]) for c in sys.argv[3:5])
peak = float(sys.argv[5])
for spec in sys.argv[6:]:
    name, path = spec.split('=')
    a = np.asarray(Image.open(path).convert('RGBA'), dtype=np.float64)
    al = a[..., 3] / 255
    mean = (a[..., :3] * al[..., None]).reshape(-1, 3).sum(0) / al.sum()
    al = np.clip(al * (peak / al.max()), 0, 1)
    for tone, target, corners in [('dark', dark, {'bl': (False, False), 'tl': (False, True)}), ('light', light, {'br': (True, False), 'tr': (True, True)})]:
        rgb = a[..., :3] if keep else np.clip(a[..., :3] * (target / mean), 0, 255)
        img = np.dstack([rgb, al * 255])
        for corner, (fx, fy) in corners.items():
            t = img[:, ::-1] if fx else img
            t = t[::-1] if fy else t
            Image.fromarray(t.round().clip(0, 255).astype(np.uint8), 'RGBA').save(f'{out}/{prefix}-{name}-{corner}.webp', 'WEBP', lossless=True)
    print(name, 'mean', mean.round(), file=sys.stderr)
