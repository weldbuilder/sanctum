// The cloud-box files: scripts/hosting/set-config.mjs (the two sanctum.yaml edits install.sh makes) and deploy/sanctum.service. Demo names are Echo and Sam.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { applyToFile, editConfig, parseArgs } from './set-config.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UNIT = path.join(HERE, '..', '..', 'deploy', 'sanctum.service');
const temp = () => fs.mkdtempSync(path.join(tmpdir(), 'hosting-'));

describe('set-config: cors.origins and the default home', () => {
  it('creates the file from nothing', () => {
    const cfg = yaml.load(editConfig('', { origins: ['https://box.example.ts.net'], defaultCwd: '/var/lib/sanctum/companion-home' }));
    expect(cfg).toEqual({ cors: { origins: ['https://box.example.ts.net'] }, agent: { cwd: '/var/lib/sanctum/companion-home' } });
  });
  it('adds an origin once, keeps the others, and drops a trailing slash', () => {
    const before = 'cors:\n  origins:\n    - "https://old.example.net"\nidentity:\n  companion_name: Echo\n  user_name: Sam\n';
    const once = editConfig(before, { origins: ['https://box.example.ts.net/'] });
    const twice = editConfig(once, { origins: ['https://box.example.ts.net'] });
    expect(yaml.load(twice)).toEqual({ cors: { origins: ['https://old.example.net', 'https://box.example.ts.net'] }, identity: { companion_name: 'Echo', user_name: 'Sam' } });
    expect(twice).toBe(editConfig(twice, { origins: ['https://box.example.ts.net'] }));
  });
  it('sets agent.cwd only when it is unset, empty or "."', () => {
    const own = editConfig('agent:\n  cwd: /home/echo/mine\n  model: x\n', { defaultCwd: '/var/lib/sanctum/companion-home' });
    expect(yaml.load(own).agent).toEqual({ cwd: '/home/echo/mine', model: 'x' });
    for (const text of ['agent:\n  cwd: "."\n', 'agent:\n  cwd: ""\n', 'identity:\n  user_name: Sam\n']) {
      expect(yaml.load(editConfig(text, { defaultCwd: '/h' })).agent.cwd).toBe('/h');
    }
  });
  it('keeps the leading comment block and says so when it does not parse', () => {
    expect(editConfig('# mine\n# two\nidentity:\n  user_name: Sam\n', { origins: ['https://a.example.net'] }).startsWith('# mine\n# two\n')).toBe(true);
    expect(() => editConfig('a: [', {})).toThrow(/does not parse/);
    expect(() => editConfig('- a\n- b\n', {})).toThrow(/not a mapping/);
    expect(() => editConfig('', { origins: ['https://a.example.net/path'] })).toThrow(/not an origin/);
  });
  it('writes the file in place, keeps its mode, and the command line reads the flags', () => {
    const root = temp();
    try {
      const file = path.join(root, 'sanctum.yaml');
      fs.writeFileSync(file, 'identity:\n  user_name: Sam\n', { mode: 0o640 });
      fs.chmodSync(file, 0o640);
      applyToFile(root, { origins: ['https://box.example.ts.net'] });
      expect(yaml.load(fs.readFileSync(file, 'utf-8')).cors.origins).toEqual(['https://box.example.ts.net']);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o640);
      expect(fs.readdirSync(root)).toEqual(['sanctum.yaml']);
      const r = spawnSync(process.execPath, [path.join(HERE, 'set-config.mjs'), '--root', root, '--origin', 'https://two.example.net'], { encoding: 'utf-8' });
      expect(r.status).toBe(0);
      expect(yaml.load(fs.readFileSync(file, 'utf-8')).cors.origins).toEqual(['https://box.example.ts.net', 'https://two.example.net']);
      expect(parseArgs(['--wat'], root).error).toMatch(/Unknown option --wat/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('deploy/sanctum.service', () => {
  const unit = fs.readFileSync(UNIT, 'utf-8');
  it('has the settings the supervisor contract needs', () => {
    for (const line of ['User=sanctum', 'WorkingDirectory=/opt/sanctum', 'EnvironmentFile=/opt/sanctum/.env', 'ExecStart=/usr/bin/npm start', 'Restart=always', 'RestartSec=3',
      'RestartForceExitStatus=75', 'SuccessExitStatus=75', 'ReadWritePaths=/opt/sanctum /var/lib/sanctum', 'ProtectSystem=full', 'NoNewPrivileges=yes', 'After=network-online.target']) {
      expect(unit.split('\n')).toContain(line);
    }
  });
  const haveAnalyze = process.platform === 'linux' && spawnSync('systemd-analyze', ['--version']).status === 0;
  it.skipIf(!haveAnalyze)('passes systemd-analyze verify (the program itself is not checked: npm may not be at /usr/bin here)', () => {
    const dir = temp();
    try {
      const f = path.join(dir, 'sanctum.service');
      fs.writeFileSync(f, unit.replace('/usr/bin/npm start', '/bin/true'));
      const r = spawnSync('systemd-analyze', ['verify', f], { encoding: 'utf-8' });
      expect((r.stderr + r.stdout).replace(/^.*(?:User sanctum|Group sanctum).*$/gm, '').trim()).toBe('');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('docs/HOSTING.md quotes the unit as it is, and is linked from the README and UPGRADE.md', () => {
    const doc = fs.readFileSync(path.join(HERE, '..', '..', 'docs', 'HOSTING.md'), 'utf-8');
    const body = unit.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
    expect(doc).toContain(body);
    for (const f of ['README.md', 'UPGRADE.md']) expect(fs.readFileSync(path.join(HERE, '..', '..', f), 'utf-8')).toContain('docs/HOSTING.md');
  });
  it('docs/HOSTING.md backs up the data folder and the MCP file, and picks a Claude program that runs', () => {
    const doc = fs.readFileSync(path.join(HERE, '..', '..', 'docs', 'HOSTING.md'), 'utf-8');
    expect(doc).toMatch(/tar -C \/ -czf .+ var\/lib\/sanctum opt\/sanctum\/data .*\.mcp\.json/);
    expect(doc).not.toMatch(/-name claude \| head/);
    expect(doc).toMatch(/--version >\/dev\/null 2>&1/);
    expect(fs.readFileSync(path.join(HERE, '..', '..', 'UPGRADE.md'), 'utf-8')).toContain('](docs/HOSTING.md)');
  });
});
