// Round 6, items 8, 9 and 12: one list of the shipped scalar paths (confine.ts exports it; config.ts defaults from it), and no dead aliases left behind.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SHIPPED_SCALARS } from './confine.js';
import { loadTenantConfig } from './config.js';
import { makeTenantsDir, processConfigFor } from './test-runtime.js';

const here = __dirname;
const dig = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
const set = (o: Record<string, unknown>, path: string, value: unknown): void => {
  const parts = path.split('.');
  let cur = o;
  for (const k of parts.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]] = value;
};

describe('item 12: one SHIPPED_SCALARS list', () => {
  it('config.ts has no list of its own: every entry of the exported list defaults to the process\'s value for a tenant that names none', () => {
    expect(readFileSync(join(here, 'config.ts'), 'utf8')).not.toMatch(/\['agent', 'dsh', 'base_instructions_file'\]/);
    expect(SHIPPED_SCALARS.length).toBeGreaterThanOrEqual(5);
    const proc = processConfigFor(resolve(tmpdir(), 'sanctum-process'));
    SHIPPED_SCALARS.forEach((k, i) => set(proc as unknown as Record<string, unknown>, k, resolve(tmpdir(), 'shipped-with-the-app', `f${i}.md`)));
    const root = makeTenantsDir({ ada: { yaml: 'hosts: [ada.example.net]\n' } });
    const { config } = loadTenantConfig(proc, join(root, 'ada'), 'ada', { quiet: true });
    for (const k of SHIPPED_SCALARS) expect(dig(config, k), k).toBe(dig(proc, k));
  });
});

describe('items 8 and 9: the dead names are gone', () => {
  it('no SCAN_CAP alias or ownUnlinkAsync anywhere in the sources', () => {
    for (const f of ['own-files.ts', 'config.ts']) { const s = readFileSync(join(here, f), 'utf8'); expect(s, f).not.toContain('SCAN_CAP'); expect(s, f).not.toContain('ownUnlinkAsync'); }
    const lib = readFileSync(resolve(here, '..', '..', '..', '..', 'scripts', 'own-files-lib.mjs'), 'utf8');
    expect(lib).not.toContain('SCAN_CAP');
  });
});
