import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILTER = fileURLToPath(new URL('../examples/browser-seat-neko/mcp-filter.mjs', import.meta.url));
const REQUIRED = 'browser_run_code_unsafe,browser_evaluate';

// A stand-in MCP server: newline-delimited JSON-RPC on stdio. Answers tools/list with five tools
// (one a page-registered WebMCP tool), echoes every tools/call as a success so a call that reaches it
// is visible, reports its cwd in the initialize result, and holds a call whose arguments say slow:true
// for 400 ms so an id stays in flight.
const FAKE = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    let result = {};
    if (m.method === 'initialize') result = { cwd: process.cwd() };
    if (m.method === 'tools/list') result = { tools: ['browser_navigate', 'browser_evaluate', 'browser_run_code_unsafe', 'browser_snapshot', 'webmcp_x'].map((name) => ({ name, inputSchema: { type: 'object' } })) };
    if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'REACHED ' + m.params.name }] };
    const out = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.params && m.params.arguments && m.params.arguments.slow) setTimeout(out, 400); else out();
  }
});
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// requests: objects (sent as JSON-RPC), { raw: '...' } (sent as a line), or { wait: ms }.
function run(requests, { block = REQUIRED, workdir, args } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpf-'));
  const fake = join(dir, 'fake.mjs');
  writeFileSync(fake, FAKE);
  const wd = workdir ?? mkdtempSync(join(tmpdir(), 'mcpf-wd-'));
  const a = args ?? ['--block', block, '--workdir', wd];
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [FILTER, ...a, '--', process.execPath, fake], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ msgs: out.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)), err, code, workdir: wd }));
    (async () => {
      for (const r of requests) {
        if (r.wait) await sleep(r.wait);
        else p.stdin.write((r.raw ?? JSON.stringify({ jsonrpc: '2.0', ...r })) + '\n');
      }
      await sleep(600);
      p.stdin.end();
    })();
  });
}

const exitOf = (args) => new Promise((res) => {
  const p = spawn(process.execPath, [FILTER, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => res({ code, err }));
});

describe('mcp-filter', () => {
  it('drops the blocked tools from tools/list and keeps the rest', async () => {
    const { msgs } = await run([{ id: 1, method: 'initialize', params: {} }, { id: 2, method: 'tools/list' }]);
    const names = msgs.find((m) => m.id === 2).result.tools.map((t) => t.name);
    expect(names).toEqual(['browser_navigate', 'browser_snapshot']);
  });
  it('refuses a tools/call for a blocked tool without forwarding it, and forwards the others', async () => {
    const { msgs } = await run([
      { id: 1, method: 'tools/call', params: { name: 'browser_evaluate', arguments: {} } },
      { id: 2, method: 'tools/call', params: { name: 'browser_run_code_unsafe', arguments: {} } },
      { id: 3, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } },
    ]);
    const by = (id) => msgs.find((m) => m.id === id);
    expect(by(1).error).toBeTruthy();
    expect(JSON.stringify(by(1))).not.toContain('REACHED');
    expect(by(2).error).toBeTruthy();
    expect(JSON.stringify(by(2))).not.toContain('REACHED');
    expect(by(3).result.content[0].text).toBe('REACHED browser_snapshot');
  });
  it('exits non-zero without a command after --', async () => {
    const r = await exitOf(['--block', REQUIRED, '--workdir', tmpdir()]);
    expect(r.code).not.toBe(0);
  });

  // 1. a non-string tool name must neither crash the filter nor reach the server
  it('answers -32602 to a tools/call whose name is not a string, forwards nothing, and survives', async () => {
    const { msgs, err, code } = await run([
      { id: 1, method: 'tools/call', params: { name: { toString: 'browser_evaluate' }, arguments: {} } },
      { id: 2, method: 'tools/call', params: { name: ['browser_evaluate'], arguments: {} } },
      { id: 3, method: 'tools/call', params: { name: 5 } },
      { id: 4, method: 'tools/call', params: {} },
      { id: 5, method: 'tools/call' },
      { id: 6, method: 'tools/list' },
      { id: 7, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } },
    ]);
    const by = (id) => msgs.find((m) => m.id === id);
    for (const id of [1, 2, 3, 4, 5]) {
      expect(by(id).error.code).toBe(-32602);
      expect(JSON.stringify(by(id))).not.toContain('REACHED');
    }
    expect(by(6).result.tools.map((t) => t.name)).toEqual(['browser_navigate', 'browser_snapshot']);
    expect(by(7).result.content[0].text).toBe('REACHED browser_snapshot');
    expect(code).toBe(0);
    expect(err).not.toMatch(/TypeError|at .*mcp-filter/);
  });
  it('logs a malformed line to stderr, drops it, and keeps serving', async () => {
    const { msgs, err, code } = await run([
      { raw: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":' },
      { raw: 'null' },
      { raw: '[null, 5, {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":{"toString":"x"}}}]' },
      { id: 3, method: 'tools/list' },
    ]);
    expect(msgs.find((m) => m.id === 3).result.tools.length).toBe(2);
    expect(msgs.find((m) => m.id === 2).error.code).toBe(-32602);
    expect(msgs.find((m) => m.id === 1)).toBeUndefined();
    expect(err).toMatch(/mcp-filter: .*dropped/);
    expect(code).toBe(0);
  });

  // 2. the required blocks are hard-coded
  it('refuses to start (exit 2, usage) unless both required names are in --block', async () => {
    for (const block of ['browser_evaluat,browser_run_code_unsafe', 'browser_evaluate', 'browser_run_code_unsafe', 'browser_navigate', 'browser_evaluate,browser_run_code_unsafes']) {
      const r = await exitOf(['--block', block, '--workdir', tmpdir(), '--', process.execPath, '-e', '0']);
      expect(r.code, block).toBe(2);
      expect(r.err, block).toMatch(/usage/);
    }
    const none = await exitOf(['--workdir', tmpdir(), '--', process.execPath, '-e', '0']);
    expect(none.code).toBe(2);
  });
  it('--block may add more names on top of the required two', async () => {
    const { msgs } = await run([{ id: 1, method: 'tools/list' }, { id: 2, method: 'tools/call', params: { name: 'browser_navigate' } }], { block: REQUIRED + ',browser_navigate' });
    expect(msgs.find((m) => m.id === 1).result.tools.map((t) => t.name)).toEqual(['browser_snapshot']);
    expect(msgs.find((m) => m.id === 2).error).toBeTruthy();
  });

  // 3. WebMCP tools registered by a page
  it('strips webmcp_* tools from tools/list and refuses calls to them', async () => {
    const { msgs } = await run([
      { id: 1, method: 'tools/list' },
      { id: 2, method: 'tools/call', params: { name: 'webmcp_x', arguments: {} } },
      { id: 3, method: 'tools/call', params: { name: 'webmcp_anything_else' } },
    ]);
    expect(msgs.find((m) => m.id === 1).result.tools.map((t) => t.name)).not.toContain('webmcp_x');
    for (const id of [2, 3]) {
      const r = msgs.find((m) => m.id === id);
      expect(r.error).toBeTruthy();
      expect(JSON.stringify(r)).not.toContain('REACHED');
    }
  });

  // 4. the child runs in the dedicated directory
  it('requires --workdir and starts the inner command with that directory as its cwd', async () => {
    const r = await exitOf(['--block', REQUIRED, '--', process.execPath, '-e', '0']);
    expect(r.code).toBe(2);
    const { msgs, workdir } = await run([{ id: 1, method: 'initialize', params: {} }]);
    // .native: on Windows the child may report the 8.3 (RUNNER~1) or the long form of the same folder.
    expect(realpathSync.native(msgs.find((m) => m.id === 1).result.cwd)).toBe(realpathSync.native(workdir));
  });

  // 5. a blocked call must not steal the id of a call that is still in flight
  it('answers a blocked call that reuses an in-flight id with -32600 and logs "duplicate id"; the real response still arrives once', async () => {
    const { msgs, err } = await run([
      { id: 7, method: 'tools/call', params: { name: 'browser_snapshot', arguments: { slow: true } } },
      { wait: 100 },
      { id: 7, method: 'tools/call', params: { name: 'browser_evaluate', arguments: {} } },
      { wait: 600 },
      { id: 7, method: 'tools/call', params: { name: 'browser_evaluate', arguments: {} } },
    ]);
    const seven = msgs.filter((m) => m.id === 7);
    expect(seven.length).toBe(3);
    expect(seven[0].error.code).toBe(-32600);
    expect(seven[1].result.content[0].text).toBe('REACHED browser_snapshot');
    expect(seven[2].error.code).toBe(-32601); // released once the response passed back
    expect(err).toMatch(/duplicate id/);
  });
});

// Claude Code advertises the MCP `roots` capability and answers roots/list with its cwd (the companion's
// folder); Playwright MCP then moves its workspace there and `filename` arguments land in that folder.
// The filter must hide roots from the server, whatever the harness sends.
const ROOTS_FAKE = `
let buf = '';
let rootsReply = null;
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === undefined && m.id === 'srv-roots') { rootsReply = m; continue; }
    if (m.id === undefined) continue;
    let result = {};
    if (m.method === 'initialize') {
      result = { sawCapabilities: m.params && m.params.capabilities };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'srv-roots', method: 'roots/list' }) + '\\n');
    }
    if (m.method === 'ping') result = { rootsReply };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  }
});
`;

function runRoots(requests, workdir) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpf-r-'));
  const fake = join(dir, 'fake.mjs');
  writeFileSync(fake, ROOTS_FAKE);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [FILTER, '--block', REQUIRED, '--workdir', workdir, '--', process.execPath, fake], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => resolve(out.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))));
    (async () => {
      // { waitForId }: hold the next request until the response to that id has come out of the filter. The server writes
      // its roots/list request BEFORE that response, and the filter answers it on the server's stdin before forwarding the
      // response, so the reply is queued ahead of anything sent after this point. A fixed sleep here raced a loaded machine.
      const seen = (id) => out.split(/\r?\n/).some((l) => { try { return JSON.parse(l).id === id; } catch { return false; } });
      for (const r of requests) {
        if (r.waitForId !== undefined) { for (let i = 0; i < 100 && !seen(r.waitForId); i++) await sleep(50); }
        else if (r.wait) await sleep(r.wait);
        else p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...r }) + '\n');
      }
      await sleep(500);
      p.stdin.end();
    })();
  });
}

describe('mcp-filter roots', () => {
  it('strips the roots capability from initialize, answers the server roots/list with an empty list, and never forwards it to the client', async () => {
    const wd = mkdtempSync(join(tmpdir(), 'mcpf-wd-'));
    const msgs = await runRoots([
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true }, elicitation: {} }, clientInfo: { name: 'claude-code', version: '1' } } },
      { waitForId: 1 },
      { method: 'notifications/roots/list_changed' },
      { id: 2, method: 'ping' },
    ], wd);
    const init = msgs.find((m) => m.id === 1);
    expect(init.result.sawCapabilities.roots).toBeUndefined();
    expect(init.result.sawCapabilities.elicitation).toEqual({}); // other capabilities pass through
    expect(msgs.some((m) => m.method === 'roots/list')).toBe(false);
    expect(msgs.find((m) => m.id === 2).result.rootsReply).toMatchObject({ id: 'srv-roots', result: { roots: [] } });
  });
});

describe('mcp-filter --workdir', () => {
  it('exits 2 for a relative --workdir', async () => {
    for (const wd of ['rel/dir', './x', 'x']) {
      const r = await exitOf(['--block', REQUIRED, '--workdir', wd, '--', process.execPath, '-e', '0']);
      expect(r.code, wd).toBe(2);
      expect(r.err, wd).toMatch(/absolute/);
    }
  });
  // Windows has no group/world mode bits: statSync reports 0o666/0o777 whatever chmod was asked for, so the
  // mode assertions (and the warning they check) only apply where the bits mean something.
  const posixModes = process.platform !== 'win32';
  it('leaves an existing workdir alone and logs its mode when group or world can read it', async () => {
    const wd = mkdtempSync(join(tmpdir(), 'mcpf-open-'));
    chmodSync(wd, 0o755);
    const { err } = await run([{ id: 1, method: 'initialize', params: {} }], { workdir: wd });
    if (posixModes) {
      expect(statSync(wd).mode & 0o777).toBe(0o755);
      expect(err).toMatch(/755/);
    } else {
      expect(err).not.toMatch(/group\/world readable/); // no bits to report, so no claim about them
    }
    const wd2 = mkdtempSync(join(tmpdir(), 'mcpf-closed-'));
    chmodSync(wd2, 0o700);
    const r2 = await run([{ id: 1, method: 'initialize', params: {} }], { workdir: wd2 });
    expect(r2.err).not.toMatch(/readable/);
  });
});
