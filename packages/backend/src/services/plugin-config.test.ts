import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, chmodSync, statSync, lstatSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

const h = vi.hoisted(() => ({ root: '', inMemory: [] as string[][] }));
vi.mock('../config.js', () => ({
  get PROJECT_ROOT() { return h.root; },
  CONFIG_FILE_NAMES: ['sanctum.yaml', 'config/sanctum.yaml'],
  setPluginsEnabledInMemory: (ids: string[]) => { h.inMemory.push(ids); },
}));
import { writePluginsEnabled, findConfigFile } from './plugin-config.js';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-plugin-config-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
beforeEach(() => { h.root = join(tmp, `r${n++}`); h.inMemory = []; mkdirSync(h.root, { recursive: true }); });

describe('writePluginsEnabled', () => {
  it('sets plugins.enabled, keeps every other key, and updates the running config', () => {
    writeFileSync(join(h.root, 'sanctum.yaml'), 'identity:\n  companion_name: "Echo"\nplugins:\n  dir: "/x"\n  enabled: ["old"]\n  trust: "companion"\n');
    writePluginsEnabled(['a', 'b']);
    const parsed = yaml.load(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')) as any;
    expect(parsed.plugins).toEqual({ dir: '/x', enabled: ['a', 'b'], trust: 'companion' });
    expect(parsed.identity.companion_name).toBe('Echo');
    expect(h.inMemory).toEqual([['a', 'b']]);
    expect(readdirSync(h.root).sort()).toEqual(['sanctum.yaml', 'sanctum.yaml.bak']); // the temp file is gone; one backup stays
  });
  it('memory: false writes the file and leaves the running config alone', () => {
    writeFileSync(join(h.root, 'sanctum.yaml'), 'plugins:\n  enabled: []\n');
    writePluginsEnabled(['a'], { memory: false });
    expect((yaml.load(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')) as any).plugins.enabled).toEqual(['a']);
    expect(h.inMemory).toEqual([]);
  });
  it('adds the plugins block when there is none, and creates sanctum.yaml when there is no config file', () => {
    writeFileSync(join(h.root, 'sanctum.yaml'), 'server:\n  port: 1234\n');
    writePluginsEnabled(['a']);
    expect((yaml.load(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')) as any)).toEqual({ server: { port: 1234 }, plugins: { enabled: ['a'] } });
    rmSync(join(h.root, 'sanctum.yaml'));
    expect(findConfigFile()).toBeNull();
    writePluginsEnabled([]);
    expect(existsSync(join(h.root, 'sanctum.yaml'))).toBe(true);
    expect((yaml.load(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')) as any)).toEqual({ plugins: { enabled: [] } });
  });
  it('a file that is not valid YAML is left untouched and nothing is applied', () => {
    writeFileSync(join(h.root, 'sanctum.yaml'), 'plugins: [unclosed\n');
    expect(() => writePluginsEnabled(['a'])).toThrow();
    expect(readFileSync(join(h.root, 'sanctum.yaml'), 'utf-8')).toBe('plugins: [unclosed\n');
    expect(h.inMemory).toEqual([]);
  });
});

describe('writePluginsEnabled: the file holds secrets', () => {
  const OLD = 'auth:\n  password: "hunter2"\nplugins:\n  enabled: []\n';
  it.skipIf(process.platform === 'win32')('keeps the file mode (0600 stays 0600), also for the backup', () => {
    const f = join(h.root, 'sanctum.yaml');
    writeFileSync(f, OLD);
    chmodSync(f, 0o600);
    writePluginsEnabled(['a']);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(f + '.bak').mode & 0o777).toBe(0o600);
    chmodSync(f, 0o640);
    writePluginsEnabled(['b']);
    expect(statSync(f).mode & 0o777).toBe(0o640);
    expect(statSync(f + '.bak').mode & 0o777).toBe(0o640);
  });
  it.skipIf(process.platform === 'win32')('a symlinked sanctum.yaml stays a symlink and the target is written', () => {
    const real = join(h.root, 'elsewhere');
    mkdirSync(real);
    writeFileSync(join(real, 'real.yaml'), OLD);
    chmodSync(join(real, 'real.yaml'), 0o600);
    symlinkSync(join(real, 'real.yaml'), join(h.root, 'sanctum.yaml'));
    writePluginsEnabled(['a']);
    expect(lstatSync(join(h.root, 'sanctum.yaml')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(h.root, 'sanctum.yaml'))).toBe(realpathSync(join(real, 'real.yaml')));
    expect((yaml.load(readFileSync(join(real, 'real.yaml'), 'utf-8')) as any).plugins.enabled).toEqual(['a']);
    expect(statSync(join(real, 'real.yaml')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(real, 'real.yaml.bak'), 'utf-8')).toBe(OLD);
    expect(readdirSync(h.root)).toEqual(['elsewhere', 'sanctum.yaml']); // no stray temp or backup beside the link
  });
  it('writes sanctum.yaml.bak with the previous content, overwritten each time (one backup)', () => {
    const f = join(h.root, 'sanctum.yaml');
    writeFileSync(f, OLD);
    writePluginsEnabled(['a']);
    expect(readFileSync(f + '.bak', 'utf-8')).toBe(OLD);
    const afterFirst = readFileSync(f, 'utf-8');
    writePluginsEnabled(['b']);
    expect(readFileSync(f + '.bak', 'utf-8')).toBe(afterFirst);
    expect(readdirSync(h.root).sort()).toEqual(['sanctum.yaml', 'sanctum.yaml.bak']);
  });
  it('no file yet: nothing to back up', () => {
    writePluginsEnabled(['a']);
    expect(readdirSync(h.root)).toEqual(['sanctum.yaml']);
  });
});
