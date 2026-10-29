#!/usr/bin/env node
// A stdio filter for an MCP server:
//   node mcp-filter.mjs --block tool_a,tool_b --workdir <dir> -- <command> [args...]
// Runs <command> as the MCP server, with <dir> as its working directory, and sits between it and the
// harness. The blocked tools are removed from every tools/list result, and a tools/call for one is
// answered here with a JSON-RPC error and never reaches the server.
//
// Why it exists: @playwright/mcp 0.0.83 has no way to leave a tool out. Its --caps flag only adds
// capabilities, and browser_evaluate and browser_run_code_unsafe both sit in "core", which is
// always on. The server runs outside dsh's sandbox, so those two would let a page, or a confused
// model, run code in the server process or read cookies and DOM of logged-in sites.
//
// Hard rules, so a typo in .mcp.json cannot weaken it:
//  - REQUIRED_BLOCKS must all appear in --block (it may add more), or the filter exits 2. The rules live in
//    entry-check.mjs, which setup and the app run over .mcp.json entries too.
//  - Any tool named webmcp_* (registered by a page, not by the server) is stripped and refused.
//  - --workdir is required, absolute and before `--`: the server writes into its cwd and resolves relative `filename`/`paths`
//    arguments against it, so it gets a dedicated directory instead of the companion's.
//  - A malformed line is logged to stderr and dropped; it never ends the process.
//  - The server is started from an argv array, never through a shell (spawn-command.mjs): a shell splits an
//    argument with a space in it. On Windows `npx` is run as node + npm's npx-cli.js, since Node will not spawn npx.cmd.
// No dependencies. Fails closed: if this file is missing or the command is wrong, the harness
// gets no browser tools, not unfiltered ones.
import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { REQUIRED_BLOCKS, parseFilterArgs } from './entry-check.mjs';
import { resolveCommand, childSpawnOptions } from './spawn-command.mjs';

const BLOCKED_PREFIXES = ['webmcp_'];

const argv = process.argv.slice(2);
const parsed = parseFilterArgs(argv);
if (!parsed.ok) {
  process.stderr.write(`usage: mcp-filter.mjs --block ${REQUIRED_BLOCKS.join(',')}[,more] --workdir <absolute dir> -- <command> [args...]\n`
    + `  ${parsed.problem}. --block must include every one of: ${REQUIRED_BLOCKS.join(', ')}; --workdir (absolute) and a command are required.\n`);
  process.exit(2);
}
const { blocked, workdir, cmd } = parsed;
const cwd = resolve(workdir);
try {
  // An existing directory is left as it is (it may be shared on purpose), but say so when others can read it.
  // Windows has no group/world mode bits (statSync reports 0o666/0o777 for everything), so the note is for POSIX only.
  let mode = null;
  try { mode = statSync(cwd).mode & 0o777; } catch { /* does not exist yet */ }
  if (mode === null) mkdirSync(cwd, { recursive: true, mode: 0o700 });
  else if (process.platform !== 'win32' && (mode & 0o077)) process.stderr.write(`mcp-filter: ${cwd} already exists with mode ${mode.toString(8)} (group/world readable); leaving it as is. Screenshots and snapshots land there.\n`);
} catch (e) {
  process.stderr.write(`mcp-filter: cannot create ${cwd}: ${e.message}\n`);
  process.exit(2);
}

const isBlocked = (name) => typeof name === 'string' && (blocked.has(name) || BLOCKED_PREFIXES.some((p) => name.startsWith(p)));

const { command: serverCmd, args: serverPrefix } = resolveCommand(cmd[0]);
let child;
try {
  child = spawn(serverCmd, [...serverPrefix, ...cmd.slice(1)], childSpawnOptions(cwd));
} catch (e) {
  // Node throws EINVAL, rather than emitting 'error', when asked to spawn a .cmd/.bat without a shell.
  const shim = /\.(cmd|bat)$/i.test(serverCmd) ? ` ${serverCmd} is a batch file, which Node will not start without a shell (and a shell would split arguments that contain spaces); put \`node <script>\` or an .exe after \`--\` instead.` : '';
  process.stderr.write(`mcp-filter: cannot start ${cmd[0]}: ${e.message}.${shim}\n`);
  process.exit(1);
}
child.on('error', (e) => { process.stderr.write(`mcp-filter: cannot start ${cmd[0]}: ${e.message}\n`); process.exit(1); });
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));

const warn = (msg) => process.stderr.write(`mcp-filter: ${msg}\n`);
const lines = (stream, onLine) => {
  let buf = '';
  // A line that makes a handler throw is dropped and logged; one bad line must never end the session.
  const safe = (l) => { try { onLine(l); } catch (e) { warn(`dropped a line (${e && e.message ? e.message : e})`); } };
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) safe(l); }
  });
  stream.on('end', () => { if (buf.trim()) safe(buf); });
};
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

// Ids of requests forwarded to the server and not yet answered. An id is the only thing tying a response to
// its request, so a call the filter answers itself must not reuse one that is still in flight.
const idKey = (id) => `${typeof id}:${JSON.stringify(id)}`;
const inflight = new Set();

const refuse = (x, code, message) => {
  if (x.id === undefined) return;
  if (inflight.has(idKey(x.id))) {
    warn(`duplicate id ${JSON.stringify(x.id)}: refused a call that reuses an id still in flight`);
    send({ jsonrpc: '2.0', id: x.id, error: { code: -32600, message: 'Invalid Request: duplicate id (a request with this id is still in flight).' } });
    return;
  }
  send({ jsonrpc: '2.0', id: x.id, error: { code, message } });
};

// Harness -> server
lines(process.stdin, (line) => {
  let m;
  try { m = JSON.parse(line); } catch (e) { warn(`dropped a line that is not JSON (${e.message})`); return; }
  const msgs = Array.isArray(m) ? m : [m];
  const keep = [];
  for (const x of msgs) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) { warn('dropped a message that is not a JSON-RPC object'); continue; }
    if (x.method === 'tools/call') {
      const name = x.params?.name;
      if (typeof name !== 'string') { refuse(x, -32602, 'Invalid params: tool name must be a string.'); continue; }
      if (isBlocked(name.trim())) { refuse(x, -32601, `Tool "${name}" is disabled on this server.`); continue; }
    }
    // The server must not learn the client's roots: Playwright MCP moves its workspace to the first root
    // (Claude Code's is the companion's folder), and `filename` arguments would resolve there instead of --workdir.
    if (x.method === 'notifications/roots/list_changed') continue;
    if (x.method === 'initialize' && x.params?.capabilities && typeof x.params.capabilities === 'object') delete x.params.capabilities.roots;
    if (typeof x.method === 'string' && x.id !== undefined) inflight.add(idKey(x.id));
    keep.push(x);
  }
  if (!keep.length) return;
  child.stdin.write(JSON.stringify(Array.isArray(m) ? keep : keep[0]) + '\n');
});
process.stdin.on('end', () => child.stdin.end());

// Server -> harness
const strip = (x) => {
  if (x && typeof x === 'object' && x.method === undefined && x.id !== undefined) inflight.delete(idKey(x.id));
  if (x && x.result && Array.isArray(x.result.tools)) x.result.tools = x.result.tools.filter((t) => !isBlocked(t?.name));
  return x;
};
const toChild = (m) => child.stdin.write(JSON.stringify(m) + '\n');
// A server that asks for roots anyway gets an empty list, and the request never reaches the client.
const isRootsRequest = (x) => x && typeof x === 'object' && x.method === 'roots/list' && x.id !== undefined;
lines(child.stdout, (line) => {
  let m;
  try { m = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
  const msgs = Array.isArray(m) ? m : [m];
  const rest = [];
  for (const x of msgs) {
    if (isRootsRequest(x)) toChild({ jsonrpc: '2.0', id: x.id, result: { roots: [] } });
    else rest.push(strip(x));
  }
  if (rest.length) send(Array.isArray(m) ? rest : rest[0]);
});
