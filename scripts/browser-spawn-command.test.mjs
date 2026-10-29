import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { win32, posix } from 'node:path';
import { resolveCommand, childSpawnOptions } from '../examples/browser-seat-neko/spawn-command.mjs';

const FILTER = fileURLToPath(new URL('../examples/browser-seat-neko/mcp-filter.mjs', import.meta.url));
const FILTER_SRC = readFileSync(FILTER, 'utf-8');
const REQUIRED = 'browser_run_code_unsafe,browser_evaluate';

// The resolver takes the platform, environment, path module and an `exists` probe, so the Windows
// rules run on any platform: CI on Linux covers path.win32 behaviour here.
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const NPX_CLI = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js';
const win = (files, env = {}) => ({
  platform: 'win32', pathApi: win32, execPath: NODE,
  env: { PATH: 'C:\\Windows\\System32;C:\\tools;C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD', ...env },
  exists: (p) => files.map((f) => f.toLowerCase()).includes(String(p).toLowerCase()),
});

describe('resolveCommand', () => {
  it('leaves everything alone off Windows', () => {
    for (const c of ['npx', 'node', '/usr/bin/npx', 'my-tool']) expect(resolveCommand(c, { platform: 'linux', pathApi: posix, env: { PATH: '/usr/bin' }, exists: () => true })).toEqual({ command: c, args: [] });
  });

  it('win32: npx becomes node + npm\'s npx-cli.js, so no .cmd shim (Node refuses to spawn one without a shell) and no shell is needed', () => {
    const o = win([NPX_CLI, 'C:\\tools\\npx.cmd']);
    expect(resolveCommand('npx', o)).toEqual({ command: NODE, args: [NPX_CLI] });
    expect(resolveCommand('npx.cmd', o)).toEqual({ command: NODE, args: [NPX_CLI] });
    expect(resolveCommand('NPX', o)).toEqual({ command: NODE, args: [NPX_CLI] });
  });
  it('win32: npx with no npx-cli.js next to node falls back to the npx.cmd found on PATH, as a full path', () => {
    expect(resolveCommand('npx', win(['C:\\tools\\npx.cmd']))).toEqual({ command: 'C:\\tools\\npx.cmd', args: [] });
  });
  it('win32: npx-cli.js beside a PATH npx.cmd (nvm, volta layouts) is used before the .cmd', () => {
    const cli = 'C:\\tools\\node_modules\\npm\\bin\\npx-cli.js';
    expect(resolveCommand('npx', win([cli, 'C:\\tools\\npx.cmd']))).toEqual({ command: NODE, args: [cli] });
  });
  it('win32: an extensionless command tries PATHEXT in order on each PATH entry, .exe before .cmd', () => {
    expect(resolveCommand('tool', win(['C:\\tools\\tool.cmd', 'C:\\tools\\tool.exe']))).toEqual({ command: 'C:\\tools\\tool.exe', args: [] });
    expect(resolveCommand('tool', win(['C:\\Windows\\System32\\tool.cmd', 'C:\\tools\\tool.exe']))).toEqual({ command: 'C:\\Windows\\System32\\tool.cmd', args: [] }); // earlier PATH entry wins
    expect(resolveCommand('node', win(['C:\\Program Files\\nodejs\\node.exe']))).toEqual({ command: 'C:\\Program Files\\nodejs\\node.exe', args: [] });
  });
  it('win32: a command that already has an extension, or is a path, is passed through', () => {
    const o = win(['C:\\tools\\tool.exe', 'C:\\tools\\tool.cmd']);
    expect(resolveCommand('tool.exe', o)).toEqual({ command: 'tool.exe', args: [] });
    expect(resolveCommand('C:\\tools\\tool', o)).toEqual({ command: 'C:\\tools\\tool', args: [] });
    expect(resolveCommand('.\\tool', o)).toEqual({ command: '.\\tool', args: [] });
    expect(resolveCommand('C:\\x\\node.exe', o)).toEqual({ command: 'C:\\x\\node.exe', args: [] });
  });
  it('win32: nothing found means the original name comes back, and spawn reports the failure', () => {
    expect(resolveCommand('ghost', win([]))).toEqual({ command: 'ghost', args: [] });
    expect(resolveCommand('npx', win([]))).toEqual({ command: 'npx', args: [] });
  });
  it('win32: Path / pathext in any case, and a missing PATH, do not throw', () => {
    expect(resolveCommand('tool', win(['C:\\tools\\tool.exe'], { PATH: undefined, Path: 'C:\\tools', PATHEXT: undefined, pathext: '.EXE' }))).toEqual({ command: 'C:\\tools\\tool.exe', args: [] });
    expect(resolveCommand('tool', { ...win([]), env: {} })).toEqual({ command: 'tool', args: [] });
  });
});

describe('the filter never starts the server through a shell', () => {
  it('childSpawnOptions has no shell key, whatever the platform, and keeps stdin/stdout piped', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const o = childSpawnOptions('/work dir', platform);
      expect(o, platform).not.toHaveProperty('shell');
      expect(o.cwd).toBe('/work dir');
      expect(o.stdio).toEqual(['pipe', 'pipe', 'inherit']);
      expect(o.windowsVerbatimArguments).toBeUndefined();
    }
  });
  it('mcp-filter.mjs sets no shell option anywhere and goes through the resolver', () => {
    expect(FILTER_SRC).not.toMatch(/shell\s*:/);
    expect(FILTER_SRC).not.toMatch(/\bexec(Sync)?\s*\(/);
    expect(FILTER_SRC).toMatch(/resolveCommand\(/);
    expect(FILTER_SRC).toMatch(/childSpawnOptions\(/);
  });
  it('an argument with spaces (a --output-dir under "Program Files" or a user name) reaches the server whole, and so does a command path with spaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp filter spaces-'));
    const out = join(dir, 'argv.json');
    const server = join(dir, 'server script.mjs');
    writeFileSync(server, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`);
    const wd = join(dir, 'work dir');
    const spaced = join(dir, 'out put', 'x y');
    await new Promise((res, rej) => {
      const p = spawn(process.execPath, [FILTER, '--block', REQUIRED, '--workdir', wd, '--', process.execPath, server, '--output-dir', spaced, 'a  b', '"q"'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', rej);
      p.on('close', (code) => (code === 0 ? res() : rej(new Error(`filter exited ${code}: ${err}`))));
    });
    expect(JSON.parse(readFileSync(out, 'utf-8'))).toEqual(['--output-dir', spaced, 'a  b', '"q"']);
    expect(readdirSync(dir)).toContain('work dir'); // the workdir with a space was created
  });
});
