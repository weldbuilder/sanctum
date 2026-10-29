import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAllTextures } from '../src/theme/textures';

const pub = fileURLToPath(new URL('../public/', import.meta.url));
const files = buildAllTextures(room => readFileSync(join(pub, `skins/${room}/material-tile-v1.svg`), 'utf8'), room => readFileSync(join(pub, `skins/${room}/edge-ornament-v1.svg`), 'utf8'));
for (const [p, text] of Object.entries(files)) {
  mkdirSync(dirname(join(pub, p)), { recursive: true });
  writeFileSync(join(pub, p), text);
  console.log('wrote', p, text.length, 'bytes');
}

// Keep integrity metadata in sync with deterministic generated vectors and the approved raster input.
const manifestPath = fileURLToPath(new URL('../src/theme/asset-manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const name of [...Object.keys(files), 'skins/ember/ember-black-leather.webp', 'skins/ember/ember-navy-leather.webp',
  'skins/cloister/cloister-navy-cloth.webp', 'skins/cloister/cloister-you-cloth.webp',
  ...['home', 'comp', 'you'].flatMap(p => ['bl', 'tl', 'br', 'tr'].map(c => `skins/cloister/cloister-sprig-${p}-${c}.webp`)),
  ...['tl', 'tr', 'bl', 'br'].map(c => `skins/cloister/cloister-bracket-${c}.webp`),
  ...['tl', 'tr', 'bl', 'br'].map(c => `skins/ember/ember-fitting-${c}.webp`),
  'skins/library/library-parchment.webp', 'skins/library/library-you.webp', 'skins/library/library-wood.webp',
  ...['tl', 'tr', 'bl', 'br'].map(c => `skins/library/library-bracket-${c}.webp`),
  'skins/salon/velvet-damask.webp', 'skins/salon/velvet-crimson.webp',
  ...['tl', 'tr', 'bl', 'br'].map(c => `skins/salon/velvet-filigree-${c}.webp`),
  'skins/conservatory/greenhouse-navy.webp', 'skins/conservatory/greenhouse-slate.webp', 'skins/conservatory/greenhouse-indigo.webp',
  ...['tl', 'tr', 'bl', 'br'].map(c => `skins/conservatory/greenhouse-stud-${c}.webp`),
  ...['home', 'comp', 'bloom', 'you'].flatMap(p => ['bl', 'tl', 'br', 'tr'].map(c => `skins/conservatory/greenhouse-sprig-${p}-${c}.webp`)),
  'skins/night/celestial-navy.webp', 'skins/night/celestial-violet.webp', 'skins/night/celestial-rail-compass.webp',
  ...['tl', 'tr', 'bl', 'br'].map(c => `skins/night/celestial-stud-${c}.webp`),
  ...['home', 'comp', 'you'].flatMap(p => ['bl', 'tl', 'br', 'tr'].map(c => `skins/night/celestial-moon-${p}-${c}.webp`))]) {
  const buf = readFileSync(join(pub, name));
  const entry = { path: `public/${name}`, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  const i = manifest.files.findIndex((f: { path: string }) => f.path === entry.path);
  if (i < 0) manifest.files.push(entry); else manifest.files[i] = { ...manifest.files[i], ...entry };
}
manifest.files.sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
