import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ root: '', enabled: [] as string[] }));
vi.mock('../../config.js', () => ({
  get PROJECT_ROOT() { return h.root; },
  getSanctumConfig: () => ({ plugins: { trust: 'person', dir: '', enabled: h.enabled }, agent: { cwd: join(h.root, 'home'), codex: { additional_directories: [] }, dsh: { command: 'dsh', home: '', model_provider: '', api_key_env: '', base_url: '' } }, server: { host: '127.0.0.1', port: 3099 } }),
  internalBaseUrl: (s: { host: string; port: number }) => `http://${s.host}:${s.port}`,
}));
vi.mock('../../middleware/internal-token.js', () => ({ getInternalToken: () => 'secret-token-xyz' }));
import { buildOverlay } from './dsh-exec.js';
import { resetPlugins } from '../plugins.js';
import { ledgerPath, ratifyPlugin, readLedger, snapshotDir } from '../plugin-ratify.js';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-dsh-plugins-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function repoWith(manifests: Record<string, Record<string, unknown>>, enabled: string[] = Object.keys(manifests)) {
  h.root = join(tmp, `r${n++}`);
  h.enabled = enabled;
  for (const [id, m] of Object.entries(manifests)) {
    const dir = join(h.root, 'plugins', id);
    mkdirSync(join(dir, 'dsh'), { recursive: true });
    writeFileSync(join(dir, 'sanctum.plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', harness: ['dsh'], ...m }));
    writeFileSync(join(dir, 'dsh', 'index.mjs'), 'export default {}');
    ratifyPlugin(ledgerPath(h.root), { id, dir }); // enabled code runs only once ratified; this file tests the overlay, not that
  }
  mkdirSync(join(h.root, 'plugins'), { recursive: true });
  resetPlugins();
}

// Captured by running buildOverlay from the parent commit (docs/plugin-contract-draft),
// before plugins existed. The two ephemeral roots are the one platform-dependent part (dsh takes
// native paths, so buildOverlay joins with the platform separator): the capture had
// ephemeralRoot /tmp/x, and the placeholders below are filled in with join() at load.
const EPH = join(tmpdir(), 'x');
const fill = (s: string) => s
  .replace('"@@SESSIONS@@"', JSON.stringify(join(EPH, 'sessions')))
  .replace('"@@STORAGES@@"', JSON.stringify(join(EPH, 'storages')));
const BEFORE = ([
  "[{\"id\":\"approval\",\"config\":{\"policy\":\"never\"}},{\"id\":\"permission\",\"config\":{\"presets\":{\"read-only\":{\"sandbox\":\"read-only\",\"approval\":\"never\"},\"workspace-write\":{\"sandbox\":\"workspace-write\",\"approval\":\"never\"},\"danger-full-access\":{\"sandbox\":\"danger-full-access\",\"approval\":\"never\"}},\"defaultPreset\":\"workspace-write\"}},{\"id\":\"session-title-llm\",\"disabled\":true},{\"id\":\"session-persistence-jsonl\",\"config\":{\"root\":\"@@SESSIONS@@\"}},{\"id\":\"storage-json\",\"config\":{\"root\":\"@@STORAGES@@\"}}]",
  "[{\"id\":\"approval\",\"config\":{\"policy\":\"never\"}},{\"id\":\"permission\",\"config\":{\"presets\":{\"read-only\":{\"sandbox\":\"read-only\",\"approval\":\"never\"},\"workspace-write\":{\"sandbox\":\"workspace-write\",\"approval\":\"never\"},\"danger-full-access\":{\"sandbox\":\"danger-full-access\",\"approval\":\"never\"}},\"defaultPreset\":\"read-only\"}},{\"id\":\"session-title-llm\",\"disabled\":true},{\"id\":\"agent-instructions\",\"disabled\":true},{\"id\":\"system-prompt\",\"config\":{\"includeHarnessIdentity\":false,\"personaPrefix\":\"You are { {x}}\"}},{\"id\":\"agent-default-model\",\"config\":{\"provider\":\"openai\",\"model\":\"gpt-x\",\"reasoningEffort\":\"high\"}},{\"id\":\"llm-pi-ai\",\"config\":{\"providers\":{\"openai\":{\"apiKeyEnv\":\"K\",\"baseURL\":\"https://g/v1\"}}}},{\"id\":\"session-persistence-jsonl\",\"config\":{\"root\":\"@@SESSIONS@@\"}},{\"id\":\"storage-json\",\"config\":{\"root\":\"@@STORAGES@@\"}},{\"insert\":[{\"id\":\"mcp-cc\",\"name\":\"@deepseek-ai/dsh-mcp-client\",\"config\":{\"serverName\":\"cc\",\"transport\":\"streamable-http\",\"url\":\"http://h/mcp\",\"headers\":{\"x-internal-token\":\"t\"}}},{\"id\":\"mcp-loc\",\"name\":\"@deepseek-ai/dsh-mcp-client\",\"config\":{\"serverName\":\"loc\",\"transport\":\"stdio\",\"command\":\"node\",\"args\":[\"a\"]}}]}]",
]).map(fill);
const CASES = [
  { sandboxMode: 'workspace-write' as const, cwd: '/home/c' },
  { sandboxMode: 'read-only' as const, cwd: '/home/c', noProjectDocs: true, basePrompt: 'You are {{x}}', model: 'gpt-x', modelProvider: 'openai', apiKeyEnv: 'K', baseUrl: 'https://g/v1', effort: 'high',
    mcp: { cc: { url: 'http://h/mcp', headers: { 'x-internal-token': 't' } }, loc: { command: 'node', args: ['a'] } } },
];
const KINDS = ['turn', 'wake', 'helper', 'summarizer'] as const;

describe('buildOverlay with plugins', () => {
  beforeEach(() => repoWith({}));

  it('with zero plugins installed the overlay is byte-identical to the one from before plugins, for every run kind', () => {
    CASES.forEach((c, i) => {
      expect(JSON.stringify(buildOverlay(c, EPH))).toBe(BEFORE[i]);
      for (const runKind of KINDS) expect(JSON.stringify(buildOverlay({ ...c, runKind, threadId: 't' }, EPH))).toBe(BEFORE[i]);
    });
  });

  it('plugins.enabled: [] with plugins present (hello among them) leaves the overlay byte-identical for every run kind', () => {
    repoWith({ hello: { dsh: { rows: [{ id: 'marker', entry: 'dsh/index.mjs' }], runs: ['turn'] } }, other: { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } } }, []);
    CASES.forEach((c, i) => {
      for (const runKind of KINDS) expect(JSON.stringify(buildOverlay({ ...c, runKind, threadId: 't' }, EPH))).toBe(BEFORE[i]);
    });
    h.enabled = ['hello'];
    expect(JSON.stringify(buildOverlay({ ...CASES[0], runKind: 'turn' }, EPH))).not.toBe(BEFORE[0]);
  });

  it('only the enabled plugin contributes rows', () => {
    repoWith({ a: { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } }, b: { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } } }, ['b']);
    const o = buildOverlay({ ...CASES[0], runKind: 'turn' }, EPH);
    expect(o[o.length - 1].insert.map((r: any) => r.id)).toEqual(['plugin:b:r']);
  });

  it('passes senderIsOwner through to the injected block (false for a Discord stranger)', () => {
    repoWith({ p: { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } } });
    const get = (extra: object) => buildOverlay({ ...CASES[0], runKind: 'turn', ...extra }, EPH).at(-1).insert[0].config.sanctum.senderIsOwner;
    expect(get({})).toBe(false); // a turn that never said who is talking is not assumed to be the owner
    expect(get({ senderIsOwner: false })).toBe(false);
    expect(get({ senderIsOwner: true })).toBe(true);
  });

  it('the owner default is true only for wake, helper and summarizer runs', () => {
    repoWith({ p: { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }], runs: ['turn', 'wake', 'helper', 'summarizer'] } } });
    for (const runKind of ['wake', 'helper', 'summarizer'] as const) {
      expect(buildOverlay({ ...CASES[0], runKind }, EPH).at(-1).insert[0].config.sanctum.senderIsOwner, runKind).toBe(true);
    }
    expect(buildOverlay({ ...CASES[0], runKind: 'turn' }, EPH).at(-1).insert[0].config.sanctum.senderIsOwner).toBe(false);
  });

  it('S1: every insert row has a name (dsh disables a nameless entry and breaks approval and permission with it), and approval is patched only by buildOverlay itself', () => {
    repoWith({
      ans: { dsh: { rows: [{ id: 'tool-ask-user', config: {} }, { id: 'answerer', entry: 'dsh/index.mjs' }], runs: ['turn'] } },
      bad: { dsh: { rows: [{ id: 'approval', name: 'pkg', config: { policy: 'ask' } }, { id: 'permission', name: 'pkg' }, { id: 'fine', name: 'pkg' }], runs: ['turn'] } }, // a scan error: contributes nothing
      ask2: { dsh: { rows: [{ id: 'tool-ask-user' }], runs: ['turn'] } },
    });
    const o = buildOverlay({ ...CASES[1], runKind: 'turn', threadId: 't' }, EPH);
    const inserted = o.flatMap((r: any) => r.insert ?? []);
    expect(inserted.length).toBeGreaterThan(2);
    expect(inserted.some((r: any) => String(r.id).startsWith('plugin:bad:'))).toBe(false);
    for (const r of inserted) expect(typeof r.name, r.id).toBe('string');
    expect(inserted.filter((r: any) => r.id === 'tool-ask-user')).toEqual([{ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user', config: {} }]); // the first plugin's config wins
    expect(o.filter((r: any) => r.id === 'approval')).toEqual([{ id: 'approval', config: { policy: 'never' } }]);
    expect(o.filter((r: any) => r.id === 'permission')).toHaveLength(1);
    // no row id appears twice anywhere in the overlay's insert lists, and none is a top-level patch id
    const ids = inserted.map((r: any) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('plugins installed but none matching this run kind also leave the overlay byte-identical', () => {
    repoWith({ only: { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }], runs: ['turn'] } }, other: { harness: ['codex'], dsh: { rows: [{ id: 'r', name: 'pkg' }] } } });
    CASES.forEach((c, i) => {
      for (const runKind of ['wake', 'helper', 'summarizer'] as const) expect(JSON.stringify(buildOverlay({ ...c, runKind }, EPH))).toBe(BEFORE[i]);
    });
  });

  it('no runKind means the plugin loader is not consulted at all', () => {
    repoWith({ p: { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } } });
    expect(JSON.stringify(buildOverlay(CASES[0], EPH))).toBe(BEFORE[0]);
  });

  it('appends one insert list after the MCP rows and changes nothing before it', () => {
    repoWith({ p: { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }], runs: ['turn'] } } });
    const before = JSON.parse(BEFORE[1]);
    const o = buildOverlay({ ...CASES[1], runKind: 'turn', threadId: 'daily-1' }, EPH);
    expect(o.slice(0, before.length)).toEqual(before); // every earlier row, MCP included, untouched
    expect(o).toHaveLength(before.length + 1);
    const ins = o[o.length - 1].insert;
    expect(ins).toEqual([{
      id: 'plugin:p:r',
      // the ratified copy, not the live folder
      name: realpathSync.native(join(snapshotDir(ledgerPath(h.root), 'p', readLedger(ledgerPath(h.root)).plugins.p.digest), 'dsh', 'index.mjs')),
      config: { sanctum: { baseUrl: 'http://127.0.0.1:3099', token: 'secret-token-xyz', threadId: 'daily-1', tenant: 'default', runKind: 'turn', senderIsOwner: false } }, // a turn that did not say who is talking is not the owner
    }]);
  });

  it('with no MCP rows the plugin insert is still last', () => {
    repoWith({ p: { dsh: { rows: [{ id: 'r', entry: 'dsh/index.mjs' }] } } });
    const o = buildOverlay({ ...CASES[0], runKind: 'wake' }, EPH);
    expect(o[o.length - 1].insert[0].id).toBe('plugin:p:r');
    expect(o[o.length - 1].insert[0].config.sanctum.runKind).toBe('wake');
  });
});
