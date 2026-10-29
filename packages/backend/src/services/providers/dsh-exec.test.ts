import { describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const fakeBin = vi.hoisted(() => ({ path: '' }));
vi.mock('../../config.js', () => ({ PROJECT_ROOT: '/nonexistent-sanctum-root', getSanctumConfig: () => ({ agent: { dsh: { command: fakeBin.path, home: '', model_provider: '', api_key_env: '', base_url: '' } } }) }));
import { runDshSummarizer, buildOverlay, buildExecArgs, buildExecEnv, defangTemplate, runDshExec } from './dsh-exec.js';
import { DSH_BASE_ROW_IDS } from '../plugins.js';

const base = { sandboxMode: 'workspace-write' as const, cwd: '/home/c' };
const row = (o: any[], id: string) => o.find((r) => r.id === id);

describe('buildOverlay', () => {
  it('always sets approvals to never, pairs every sandbox mode with it, and turns the hidden title call off', () => {
    const o = buildOverlay(base);
    expect(row(o, 'approval')).toEqual({ id: 'approval', config: { policy: 'never' } });
    // otherwise `never` + read-only/workspace-write match no preset and the permission plugin fails to load
    const presets = row(o, 'permission').config.presets;
    for (const m of ['read-only', 'workspace-write', 'danger-full-access']) expect(presets[m]).toEqual({ sandbox: m, approval: 'never' });
    expect(row(o, 'permission').config.defaultPreset).toBe('workspace-write');
    expect(row(buildOverlay({ ...base, sandboxMode: 'read-only' }), 'permission').config.defaultPreset).toBe('read-only');
    expect(row(o, 'session-title-llm')).toEqual({ id: 'session-title-llm', disabled: true });
  });

  it('turns AGENTS.md discovery off only when asked (the summarizer)', () => {
    expect(row(buildOverlay({ ...base, noProjectDocs: true }), 'agent-instructions')).toEqual({ id: 'agent-instructions', disabled: true });
    expect(row(buildOverlay(base), 'agent-instructions')).toBeUndefined();
  });

  it('turns the harness identity off and sets the persona from the base prompt', () => {
    const o = buildOverlay({ ...base, basePrompt: '  You are a companion.\n' });
    expect(row(o, 'system-prompt').config).toEqual({ includeHarnessIdentity: false, personaPrefix: 'You are a companion.' });
    expect(buildOverlay({ ...base, basePrompt: '   ' }).some((r) => r.id === 'system-prompt')).toBe(false);
  });

  it('defangs {{ so prose is never read as a dsh template variable, triple braces included', () => {
    expect(defangTemplate('use {{x}} and {{y}}')).toBe('use { {x}} and { {y}}');
    expect(defangTemplate('{{{x}}}')).toBe('{ { {x}}}');
    expect(defangTemplate('{{{{x}}}}')).not.toMatch(/\{\{/);
    expect(defangTemplate('{single} and {')).toBe('{single} and {');
  });

  it('sets model and route; a non-default route also gets its key env and endpoint', () => {
    const o = buildOverlay({ ...base, model: 'gpt-x', modelProvider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', baseUrl: 'https://gw.example/v1', effort: 'high' });
    expect(row(o, 'agent-default-model').config).toEqual({ provider: 'openai', model: 'gpt-x', reasoningEffort: 'high' });
    expect(row(o, 'llm-pi-ai').config).toEqual({ providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://gw.example/v1' } } });
    // the default route needs no pi-ai row
    expect(row(buildOverlay({ ...base, model: 'deepseek-chat' }), 'llm-pi-ai')).toBeUndefined();
    expect(row(buildOverlay({ ...base, model: 'deepseek-chat' }), 'agent-default-model').config.provider).toBe('deepseek-official');
  });

  it('points session log AND storage (the projection cache holds the first prompt) at a throwaway root when ephemeral', () => {
    // dsh takes native paths (backslashes on Windows), so the overlay joins with the platform separator.
    const eph = join(tmpdir(), 'x');
    const o = buildOverlay(base, eph);
    expect(row(o, 'session-persistence-jsonl').config).toEqual({ root: join(eph, 'sessions') });
    expect(row(o, 'storage-json').config).toEqual({ root: join(eph, 'storages') });
    expect(row(buildOverlay(base), 'session-persistence-jsonl')).toBeUndefined();
    expect(row(buildOverlay(base), 'storage-json')).toBeUndefined();
  });

  it('maps .mcp.json servers to mcp-client entries, http headers included, bad names skipped', () => {
    const o = buildOverlay({
      ...base,
      mcp: {
        memory: { command: '/bin/node', args: ['srv.js'], env: { TOKEN: 't' } },
        cc: { url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer abc' } },
        'bad.name': { url: 'http://x' },
        inproc: { type: 'sdk' },
      },
    });
    const ins = o.find((r) => r.insert).insert;
    expect(ins.map((r: any) => r.id)).toEqual(['mcp-memory', 'mcp-cc']);
    expect(ins[0]).toMatchObject({ name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'memory', transport: 'stdio', command: '/bin/node', args: ['srv.js'], env: { TOKEN: 't' } } });
    expect(ins[1].config).toEqual({ serverName: 'cc', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer abc' } });
  });
});

// B-1: the public lane's run is SEALED. Against real dsh the verifier found the full 25-tool set (bash, read,
// write, web_fetch, subagent, workflow, ...) behind `tools: []`, because the adapter's read-only mode only
// blocks writes. A sealed overlay disables every tool-providing and side-effect row of dsh's base composition.
describe('buildOverlay: sealed (the public lane)', () => {
  const sealed = { ...base, sandboxMode: 'read-only' as const, sealed: true };
  const disabled = (o: any[]) => new Set(o.filter((r) => r.disabled === true).map((r) => r.id as string));
  // The rows that provide a tool or reach outside the run, from the committed base list.
  const SEALED_PATTERNS: RegExp[] = [
    /^tool-/, /^web$/, /^web-search-deepseek$/, /^web-fetch-http$/, /^mcp-resources$/, /^subagent/, /^workflow-ptc$/, /^ptc-runtime$/,
    /^plan-mode$/, /^skill$/, /^skill-filesystem$/, /^agent-instructions$/, /^commands$/, /^command-/,
  ];
  const mustBeOff = [...DSH_BASE_ROW_IDS].filter((id) => SEALED_PATTERNS.some((re) => re.test(id)));

  it('disables every id of the committed dsh base list that provides a tool or a side effect, so a dsh upgrade that adds a tool row fails here', () => {
    const off = disabled(buildOverlay(sealed));
    expect(mustBeOff.length).toBeGreaterThanOrEqual(25);
    expect(mustBeOff.filter((id) => !off.has(id))).toEqual([]);
  });

  it('names the tool rows dsh ships today (the verifier run had 25 tools)', () => {
    const off = disabled(buildOverlay(sealed));
    for (const id of ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'tool-skill', 'tool-subagent', 'tool-subagent-fork',
      'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow', 'tool-web', 'tool-todo', 'tool-goal', 'tool-working-directory',
      'web', 'web-search-deepseek', 'web-fetch-http', 'mcp-resources', 'workflow-ptc', 'ptc-runtime', 'plan-mode', 'skill', 'skill-filesystem',
      'agent-instructions', 'commands']) expect(off.has(id), id).toBe(true);
  });

  it('disables only ids that exist in the base composition (a typo would silently disable nothing)', () => {
    const off = [...disabled(buildOverlay(sealed))];
    expect(off.filter((id) => !DSH_BASE_ROW_IDS.has(id))).toEqual([]);
  });

  it('writes no mcp row and no plugin row, whatever it is handed', () => {
    const o = buildOverlay({ ...sealed, runKind: 'turn', mcp: { memory: { command: '/bin/node', args: [] }, cc: { url: 'http://127.0.0.1:9/mcp' } } });
    expect(o.some((r) => r.insert)).toBe(false);
    expect(JSON.stringify(o)).not.toMatch(/mcp-memory|mcp-cc|dsh-mcp-client/);
  });

  it('pairs read-only with the permission plugin whatever sandbox mode was asked for', () => {
    const o = buildOverlay({ ...sealed, sandboxMode: 'workspace-write' });
    expect(row(o, 'permission').config.defaultPreset).toBe('read-only');
    expect(row(o, 'approval')).toEqual({ id: 'approval', config: { policy: 'never' } });
  });

  it('an unsealed overlay is exactly what it was: no tool row is disabled', () => {
    const off = disabled(buildOverlay(base));
    expect([...off].filter((id) => /^tool-|^web|^subagent|^skill|^commands/.test(id))).toEqual([]);
  });

  it('the child runs with DSH_PERMISSION_MODE=read-only even if a looser mode was asked for', () => {
    expect(buildExecEnv({ ...base, sealed: true }, {}, undefined, '/r/dsh-home').DSH_PERMISSION_MODE).toBe('read-only');
  });
});

// B2.2 BLOCKER: dsh applies $DSH_HOME/cordis.patch.yml and $DSH_HOME/profiles/headless/cordis.patch.yml BEFORE --patch, and
// loads $DSH_HOME/.env. A sealed run on the person's own home was re-armed by a user patch. It gets a pristine home instead.
describe("buildExecEnv: the sealed run never uses the person's dsh home", () => {
  it('DSH_HOME is the sealed home it is given, never p.home; with none given it throws instead of falling back', () => {
    const env = buildExecEnv({ ...base, sealed: true, home: '/person/.dsh' }, {}, '/r/tmp', '/r/dsh-home');
    expect(env.DSH_HOME).toBe('/r/dsh-home');
    expect(() => buildExecEnv({ ...base, sealed: true, home: '/person/.dsh' }, {}, '/r/tmp')).toThrow(/sealed/i);
    // unsealed is as before
    expect(buildExecEnv({ ...base, home: '/person/.dsh' }, {}).DSH_HOME).toBe('/person/.dsh');
  });

  it('the route key still reaches a sealed run through the allowlist (DEEPSEEK_API_KEY, or agent.dsh.api_key_env); HOME points into the run, not at the person', () => {
    const baseEnv = { PATH: '/bin', HOME: '/home/pat', USER: 'pat', DEEPSEEK_API_KEY: 'sk-d', OTHER_KEY: 'x', DSH_HOME: '/evil' };
    const e1 = buildExecEnv({ ...base, sealed: true }, baseEnv, '/r/tmp', '/r/dsh-home', '/r/public');
    expect(e1.DEEPSEEK_API_KEY).toBe('sk-d');
    expect(e1.OTHER_KEY).toBeUndefined();
    expect(e1.DSH_HOME).toBe('/r/dsh-home');
    expect(e1.HOME).toBe('/r/public');
    const e2 = buildExecEnv({ ...base, sealed: true, modelProvider: 'openai', apiKeyEnv: 'OTHER_KEY' }, baseEnv, '/r/tmp', '/r/dsh-home', '/r/public');
    expect(e2.OTHER_KEY).toBe('x');
    expect(e2.DEEPSEEK_API_KEY).toBeUndefined();
  });
});

describe('buildExecArgs / buildExecEnv', () => {
  it('boots the headless profile with the overlay, reads the task from stdin, emits JSON', () => {
    expect(buildExecArgs(base, '/t/o.yml')).toEqual(['--profile', 'headless', '--patch', '/t/o.yml', '--json', '-']);
    expect(buildExecArgs({ ...base, sessionId: 'session-1' }, '/t/o.yml')).toEqual(['--profile', 'headless', '--patch', '/t/o.yml', '--session-id', 'session-1', '--json', '-']);
  });

  it('passes only an allowlisted environment: planted secrets and inherited DSH_* never reach dsh', () => {
    const planted = {
      PATH: '/bin', HOME: '/home/u', LANG: 'C', LC_ALL: 'C', TERM: 'xterm', TMPDIR: '/evil-tmp', HTTPS_PROXY: 'http://proxy',
      APP_PASSWORD: 'hunter2', OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-ant', DEEPSEEK_API_KEY: 'sk-ds', MY_ROUTE_KEY: 'sk-route',
      DSH_HOME: '/evil-home', DSH_TELEMETRY_OTLP_URL: 'http://evil', DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY', DSH_PERMISSION_MODE: 'danger-full-access',
    };
    const e = buildExecEnv({ ...base, apiKeyEnv: 'MY_ROUTE_KEY', modelProvider: 'openai' }, planted, '/run/tmp');
    expect(e).toEqual({
      PATH: '/bin', HOME: '/home/u', LANG: 'C', LC_ALL: 'C', TERM: 'xterm', HTTPS_PROXY: 'http://proxy', MY_ROUTE_KEY: 'sk-route',
      TMPDIR: '/run/tmp', DSH_TELEMETRY_MODE: 'DISABLED', DSH_PERMISSION_MODE: 'workspace-write',
    });
    // the default route takes DEEPSEEK_API_KEY; nothing else leaks
    const d = buildExecEnv(base, planted);
    expect(d.DEEPSEEK_API_KEY).toBe('sk-ds');
    expect(d.OPENAI_API_KEY).toBeUndefined();
    expect(d.DSH_HOME).toBeUndefined();
    expect(d.DSH_TELEMETRY_OTLP_URL).toBeUndefined();
  });

  it('disables telemetry on every run and sets the permission mode and home', () => {
    const e = buildExecEnv({ ...base, home: '/h' }, { DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY', PATH: '/bin' });
    expect(e).toMatchObject({ DSH_TELEMETRY_MODE: 'DISABLED', DSH_PERMISSION_MODE: 'workspace-write', DSH_HOME: '/h', PATH: '/bin' });
    expect(buildExecEnv(base, {}).DSH_HOME).toBeUndefined();
  });
});

// A stand-in `dsh` executable: records argv/stdin/env, replays canned NDJSON.
function fakeDsh(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fakedsh-'));
  const bin = join(dir, 'dsh.cjs');
  writeFileSync(bin, `#!${process.execPath}\n${script}`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}
const collect = async (g: AsyncGenerator<any>) => { const o: any[] = []; for await (const e of g) o.push(e); return o; };

describe.skipIf(process.platform === 'win32')('runDshExec against a fake dsh', () => {
  const rec = (dir: string) => join(dir, 'rec.json');
  const okScript = (dir: string, exit = 0) => `
const fs = require('fs'); let stdin = '';
process.stdin.on('data', d => stdin += d); process.stdin.on('end', () => {
  const i = process.argv.indexOf('--patch');
  fs.writeFileSync(${JSON.stringify(rec(dir))}, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), tele: process.env.DSH_TELEMETRY_MODE, perm: process.env.DSH_PERMISSION_MODE, overlay: fs.readFileSync(process.argv[i + 1], 'utf8') }));
  console.log(JSON.stringify({ type: 'session', sessionId: 's1', cwd: process.cwd() }));
  console.log('not json noise');
  console.log(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: ${exit ? "'error', error: { message: 'boom', code: 'X' }" : "'completed'"} } }));
  console.log(JSON.stringify({ type: 'final', text: 'ok' }));
  process.exit(${exit});
});`;

  it('spawns with the overlay, prompt on stdin, telemetry off; the temp overlay is removed', async () => {
    const f = fakeDsh('');
    writeFileSync(f.bin, `#!${process.execPath}\n${okScript(f.dir)}`);
    const evs = await collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'hello there', sandboxMode: 'read-only', ephemeral: true }));
    expect(evs.map((e) => e.type)).toEqual(['session', 'status', 'final']); // stray non-JSON line dropped
    const r = JSON.parse(readFileSync(rec(f.dir), 'utf-8'));
    expect(r.stdin).toBe('hello there');
    expect(r.tele).toBe('DISABLED');
    expect(r.perm).toBe('read-only');
    expect(r.argv.slice(0, 2)).toEqual(['--profile', 'headless']);
    expect(r.argv.slice(-2)).toEqual(['--json', '-']);
    expect(JSON.parse(r.overlay).some((x: any) => x.id === 'session-persistence-jsonl')).toBe(true);
    const patchPath = r.argv[r.argv.indexOf('--patch') + 1];
    expect(existsSync(patchPath)).toBe(false);
  });

  it('an error turn_end with exit 1 is an event, not a throw', async () => {
    const f = fakeDsh('');
    writeFileSync(f.bin, `#!${process.execPath}\n${okScript(f.dir, 1)}`);
    const evs = await collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x' }));
    expect(evs.find((e) => e.phase === 'turn_end').reason.kind).toBe('error');
  });

  it('a crash before any turn_end throws with stderr', async () => {
    const f = fakeDsh('process.stderr.write("no adapter"); process.exit(3);');
    await expect(collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x' }))).rejects.toThrow(/code 3: no adapter/);
  });

  it('a missing binary is a clear error', async () => {
    await expect(collect(runDshExec({ ...base, cwd: tmpdir(), command: '/nonexistent/dsh', prompt: 'x' }))).rejects.toThrow(/dsh exited with code -1/);
  });

  // Scoped to this test's own temp dir: counting every `sanctum-dsh-*` under the shared tmpdir
  // trips whenever another test file (or another worker) is mid-run. os.tmpdir() reads TMPDIR on
  // each call, so pointing it at a private dir makes runDshExec create its run root in there.
  const scopedTmp = async <T>(fn: (own: () => string[]) => Promise<T>): Promise<T> => {
    const old = process.env.TMPDIR;
    const mine = mkdtempSync(join(tmpdir(), 'sanctum-dsh-exec-test-'));
    process.env.TMPDIR = mine;
    try { return await fn(() => readdirSync(mine).filter((n) => n.startsWith('sanctum-dsh-'))); }
    finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; rmSync(mine, { recursive: true, force: true }); }
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('nothing survives a throwaway run: session log, storage projection, spill files, overlay', async () => {
    const f = fakeDsh('');
    writeFileSync(f.bin, `#!${process.execPath}\n` + `
const fs = require('fs'), path = require('path');
const o = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--patch') + 1], 'utf8'));
const root = (id) => o.find((r) => r.id === id).config.root;
for (const r of [root('session-persistence-jsonl'), root('storage-json')]) { fs.mkdirSync(r, { recursive: true }); fs.writeFileSync(path.join(r, 'first-prompt.json'), 'IDENTITY AND MEMORY'); }
fs.writeFileSync(path.join(process.env.TMPDIR, 'dsh-spill-1'), 'big tool output');
fs.writeFileSync(${JSON.stringify(join(f.dir, 'seen.json'))}, JSON.stringify({ roots: [root('session-persistence-jsonl'), root('storage-json')], tmp: process.env.TMPDIR, overlay: process.argv[process.argv.indexOf('--patch') + 1] }));
console.log(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } })); console.log(JSON.stringify({ type: 'final', text: 'ok' }));`);
    await scopedTmp(async (own) => {
      await collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x', ephemeral: true }));
      expect(own()).toEqual([]);
    });
    const seen = JSON.parse(readFileSync(join(f.dir, 'seen.json'), 'utf-8'));
    for (const p of [...seen.roots, seen.tmp, seen.overlay, join(seen.tmp, 'dsh-spill-1')]) expect(existsSync(p), p).toBe(false);
  });

  it('the child sees only the allowlisted environment, with TMPDIR inside the run root', async () => {
    const f = fakeDsh('');
    writeFileSync(f.bin, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(join(f.dir, 'env.json'))}, JSON.stringify(process.env));\nconsole.log(JSON.stringify({ type: 'final', text: '' }));`);
    process.env.APP_PASSWORD_PLANTED = 'hunter2'; process.env.DSH_HOME = '/evil-home';
    try { await collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x' })); } finally { delete process.env.APP_PASSWORD_PLANTED; delete process.env.DSH_HOME; }
    const env = JSON.parse(readFileSync(join(f.dir, 'env.json'), 'utf-8'));
    expect(env.APP_PASSWORD_PLANTED).toBeUndefined();
    expect(env.DSH_HOME).toBeUndefined();
    expect(env.DSH_TELEMETRY_MODE).toBe('DISABLED');
    expect(env.TMPDIR).toContain('sanctum-dsh-');
  });

  it('a hung child is stopped by the overall timeout, SIGKILL included when it ignores SIGTERM', async () => {
    const f = fakeDsh('');
    writeFileSync(f.bin, `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nrequire('fs').writeFileSync(${JSON.stringify(join(f.dir, 'pid'))}, String(process.pid));\nsetInterval(() => {}, 1000);`);
    const t0 = Date.now();
    await scopedTmp(async (own) => {
      await expect(collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x', timeoutMs: 400, killGraceMs: 200 }))).rejects.toThrow(/timed out after 400ms/);
      expect(own()).toEqual([]);
    });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(alive(Number(readFileSync(join(f.dir, 'pid'), 'utf-8')))).toBe(false);
  });

  it('an abort that SIGTERM cannot land is escalated to SIGKILL', async () => {
    const f = fakeDsh('');
    writeFileSync(f.bin, `#!${process.execPath}\nprocess.on('SIGTERM', () => {});\nrequire('fs').writeFileSync(${JSON.stringify(join(f.dir, 'pid'))}, String(process.pid));\nconsole.log(JSON.stringify({ type: 'session', sessionId: 's' }));\nsetInterval(() => {}, 1000);`);
    const ac = new AbortController();
    const t0 = Date.now();
    const evs: any[] = [];
    for await (const e of runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x', signal: ac.signal, killGraceMs: 200 })) { evs.push(e); ac.abort(); }
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(alive(Number(readFileSync(join(f.dir, 'pid'), 'utf-8')))).toBe(false);
  });

  it('a child that prints final but never exits is killed after the grace and the run completes', async () => {
    const f = fakeDsh('');
    writeFileSync(f.bin, `#!${process.execPath}\nconsole.log(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }));\nconsole.log(JSON.stringify({ type: 'final', text: 'done' }));\nsetInterval(() => {}, 1000);`);
    const t0 = Date.now();
    const evs = await collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x', exitGraceMs: 200, killGraceMs: 200 }));
    expect(evs.at(-1)).toMatchObject({ type: 'final', text: 'done' });
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('a stdout error event with a non-zero exit is reported through the stream, not a crash', async () => {
    const f = fakeDsh('');
    writeFileSync(f.bin, `#!${process.execPath}\nconsole.log(JSON.stringify({ type: 'error', message: 'provider down' }));\nprocess.exit(1);`);
    const evs = await collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x' }));
    expect(evs).toEqual([{ type: 'error', message: 'provider down' }]);
  });

  it('a missing working directory is a clear error, not a spawn ENOENT, and leaves no temp dir', async () => {
    await scopedTmp(async (own) => {
      await expect(collect(runDshExec({ ...base, cwd: '/nonexistent/cwd/here', command: 'dsh', prompt: 'x' }))).rejects.toThrow(/working directory does not exist: \/nonexistent\/cwd\/here/);
      expect(own()).toEqual([]);
    });
  });

  // B-1: maxTurns is enforced here, because dsh ignores it. A model that calls a tool that does not exist gets a
  // tool error and a SECOND model step: that step must never begin.
  it('maxSteps: 1 stops the child when a second model step begins, and says why', async () => {
    const f = fakeDsh('');
    const marker = join(f.dir, 'step2-ran');
    writeFileSync(f.bin, `#!${process.execPath}
const ev = (o) => console.log(JSON.stringify(o));
ev({ type: 'session', sessionId: 's1' });
ev({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
ev({ type: 'tool_call', callId: 'c1', tool: 'read', input: { file_path: '/etc/hostname' } });
ev({ type: 'tool_result', callId: 'c1', status: 'error', result: 'Error: unknown tool "read"' });
ev({ type: 'status', phase: 'step_end', turn: 1, step: 1 });
ev({ type: 'status', phase: 'step_start', turn: 1, step: 2 });
setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); ev({ type: 'text', text: 'LEAK' }); ev({ type: 'final', text: 'LEAK' }); }, 600);
setInterval(() => {}, 1000);`);
    const evs = await collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x', sealed: true, sandboxMode: 'read-only', maxSteps: 1, killGraceMs: 200 }));
    expect(JSON.stringify(evs)).not.toContain('LEAK');
    expect(evs.at(-1)).toMatchObject({ type: 'status', phase: 'turn_end', reason: { kind: 'max_turns' } });
    await new Promise((r) => setTimeout(r, 900));
    expect(existsSync(marker)).toBe(false); // the child was killed before its second step could do anything
  });

  it('maxSteps: a one-step reply is untouched', async () => {
    const f = fakeDsh('');
    writeFileSync(f.bin, `#!${process.execPath}
const ev = (o) => console.log(JSON.stringify(o));
ev({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
ev({ type: 'text', text: 'hello' });
ev({ type: 'status', phase: 'step_end', turn: 1, step: 1 });
ev({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
ev({ type: 'final', text: 'hello' });`);
    const evs = await collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x', sealed: true, sandboxMode: 'read-only', maxSteps: 1 }));
    expect(evs.at(-1)).toMatchObject({ type: 'final', text: 'hello' });
    expect(evs.some((e) => e.reason?.kind === 'max_turns')).toBe(false);
  });

  it('without maxSteps nothing is counted (an ordinary multi-step turn is unchanged)', async () => {
    const f = fakeDsh('');
    writeFileSync(f.bin, `#!${process.execPath}
const ev = (o) => console.log(JSON.stringify(o));
for (const step of [1, 2, 3]) ev({ type: 'status', phase: 'step_start', turn: 1, step });
ev({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
ev({ type: 'final', text: 'ok' });`);
    const evs = await collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x' }));
    expect(evs.filter((e) => e.phase === 'step_start')).toHaveLength(3);
    expect(evs.at(-1)).toMatchObject({ type: 'final', text: 'ok' });
  });

  it('a sealed run: DSH_HOME and the working directory are fresh folders inside the run root, never p.home or p.cwd; the home is not there before the run and is gone after', async () => {
    const f = fakeDsh('');
    const person = mkdtempSync(join(tmpdir(), 'person-dsh-home-'));
    writeFileSync(join(person, 'cordis.patch.yml'), '- insert:\n  - id: my-bash\n    name: "@deepseek-ai/dsh-tool-bash"\n');
    writeFileSync(f.bin, `#!${process.execPath}\nconst fs = require('fs');
fs.writeFileSync(${JSON.stringify(join(f.dir, 'seen.json'))}, JSON.stringify({ home: process.env.DSH_HOME, homeExisted: fs.existsSync(process.env.DSH_HOME), cwd: process.cwd(), HOME: process.env.HOME, tmp: process.env.TMPDIR, key: process.env.DEEPSEEK_API_KEY }));
fs.mkdirSync(process.env.DSH_HOME, { recursive: true }); fs.writeFileSync(process.env.DSH_HOME + '/made-by-dsh', 'x');
console.log(JSON.stringify({ type: 'final', text: 'ok' }));`);
    process.env.DEEPSEEK_API_KEY = 'sk-from-env';
    try {
      await scopedTmp(async (own) => {
        await collect(runDshExec({ ...base, cwd: f.dir, command: f.bin, prompt: 'x', sealed: true, sandboxMode: 'read-only', home: person }));
        expect(own()).toEqual([]);
      });
    } finally { delete process.env.DEEPSEEK_API_KEY; }
    const seen = JSON.parse(readFileSync(join(f.dir, 'seen.json'), 'utf-8'));
    expect(seen.home).not.toBe(person);
    expect(seen.home.startsWith(tmpdir())).toBe(true);
    expect(seen.homeExisted).toBe(false); // dsh creates the headless profile there itself
    expect(existsSync(seen.home)).toBe(false); // and the whole run root is gone
    expect(seen.cwd).not.toBe(f.dir);
    expect(seen.cwd).toBe(join(dirname(seen.home), 'public'));
    expect(seen.HOME).toBe(seen.cwd);
    expect(seen.tmp.startsWith(dirname(seen.home))).toBe(true);
    expect(seen.key).toBe('sk-from-env');
    expect(readFileSync(join(person, 'cordis.patch.yml'), 'utf-8')).toContain('my-bash'); // the person's home is untouched
    expect(existsSync(join(person, 'made-by-dsh'))).toBe(false);
  });

  it('a sealed run does not need its p.cwd to exist (the folder it works in is its own)', async () => {
    const f = fakeDsh('');
    writeFileSync(f.bin, `#!${process.execPath}\nconsole.log(JSON.stringify({ type: 'final', text: 'ok' }));`);
    const evs = await collect(runDshExec({ ...base, cwd: '/nonexistent/data/discord/run', command: f.bin, prompt: 'x', sealed: true, sandboxMode: 'read-only' }));
    expect(evs.at(-1)).toMatchObject({ type: 'final' });
  });

  it('the summarizer runs throwaway, read-only, with AGENTS.md discovery off', async () => {
    const f = fakeDsh('');
    fakeBin.path = f.bin;
    writeFileSync(f.bin, `#!${process.execPath}\nconst fs = require('fs');\nfs.writeFileSync(${JSON.stringify(join(f.dir, 'o.json'))}, fs.readFileSync(process.argv[process.argv.indexOf('--patch') + 1], 'utf8'));\nconsole.log(JSON.stringify({ type: 'text', text: 'SUMMARY' }));\nconsole.log(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }));\nconsole.log(JSON.stringify({ type: 'final', text: 'SUMMARY' }));`);
    const r = await runDshSummarizer({ prompt: 'p', baseFile: '', dir: f.dir, signal: new AbortController().signal });
    expect(r).toEqual({ text: 'SUMMARY', engine: 'dsh' });
    const o = JSON.parse(readFileSync(join(f.dir, 'o.json'), 'utf-8'));
    expect(o.find((x: any) => x.id === 'agent-instructions')).toEqual({ id: 'agent-instructions', disabled: true });
    expect(o.some((x: any) => x.id === 'storage-json')).toBe(true);
    expect(o.find((x: any) => x.id === 'permission').config.defaultPreset).toBe('read-only');
  });
});
