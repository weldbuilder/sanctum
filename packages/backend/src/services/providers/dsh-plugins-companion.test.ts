// trust: companion and the dsh overlay. A sealed public run (feat/discord-lanes: buildOverlay drops runKind for
// `sealed`, so pluginRows is never asked) must get no plugin rows whatever the trust mode says.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ root: '', enabled: [] as string[] }));
vi.mock('../../config.js', () => ({
  get PROJECT_ROOT() { return h.root; },
  getSanctumConfig: () => ({ plugins: { trust: 'companion', dir: '', enabled: h.enabled }, agent: { cwd: join(h.root, 'home'), codex: { additional_directories: [] }, dsh: { command: 'dsh', home: '', model_provider: '', api_key_env: '', base_url: '' } }, server: { host: '127.0.0.1', port: 3099 } }),
  internalBaseUrl: (s: { host: string; port: number }) => `http://${s.host}:${s.port}`,
}));
vi.mock('../../middleware/internal-token.js', () => ({ getInternalToken: () => 'secret-token-xyz' }));
import { buildOverlay } from './dsh-exec.js';
import { resetPlugins } from '../plugins.js';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-dsh-plugins-companion-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function repoWith(id: string, enabled: string[]) {
  h.root = join(tmp, `r${n++}`);
  h.enabled = enabled;
  const dir = join(h.root, 'plugins', id);
  mkdirSync(join(dir, 'dsh'), { recursive: true });
  writeFileSync(join(dir, 'sanctum.plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', harness: ['dsh'], dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }], runs: ['turn', 'wake', 'helper', 'summarizer'] } }));
  writeFileSync(join(dir, 'dsh', 'index.mjs'), 'export default {}');
  resetPlugins();
}
const base = { sandboxMode: 'read-only' as const, cwd: '/home/c' };
const insertIds = (o: any[]) => o.flatMap((r) => r.insert ?? []).map((r: any) => r.id).filter((id: string) => id.startsWith('plugin:'));
vi.spyOn(console, 'log').mockImplementation(() => {});

describe('buildOverlay with trust: companion', () => {
  beforeEach(() => repoWith('hello', ['hello']));

  it('an enabled, never-ratified plugin contributes its rows to every run kind that names it', () => {
    for (const runKind of ['turn', 'wake', 'helper', 'summarizer'] as const) {
      expect(insertIds(buildOverlay({ ...base, runKind, threadId: 't' }))).toEqual(['plugin:hello:r']);
    }
  });

  it('a sealed public run still gets 0 plugin rows (a sealed run reaches buildOverlay with no runKind)', () => {
    // buildOverlay's own `sealed` handling lives on feat/discord-lanes: `p = { ...p, runKind: undefined, mcp: undefined, ... }`.
    // The no-runKind path is what that leaves; this pins that companion mode adds nothing to it.
    expect(insertIds(buildOverlay({ ...base, runKind: undefined }))).toEqual([]);
    expect(insertIds(buildOverlay({ ...base }))).toEqual([]);
    const sealedLike = { ...base, sealed: true, runKind: undefined } as any;
    expect(insertIds(buildOverlay(sealedLike))).toEqual([]);
  });

  it('plugins.enabled: [] leaves the overlay free of plugin rows', () => {
    h.enabled = [];
    expect(insertIds(buildOverlay({ ...base, runKind: 'turn' }))).toEqual([]);
  });
});
