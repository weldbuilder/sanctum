// docker-entrypoint.sh and the container files (Dockerfile, docker-compose.yml, .dockerignore, deploy/tailscale-serve.json), without a Docker daemon.
// The entrypoint runs against temp folders; its final `exec` runs a command that prints what it was given. Demo names are Echo and Sam.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'docker-entrypoint.sh');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const haveSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'true']).status === 0;

/** Three folders like the container's: app (with a template home), data, and an empty companion home. */
function box(opts = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'entry-')));
  const dirs = { base, app: path.join(base, 'app'), data: path.join(base, 'data'), home: path.join(base, 'home') };
  fs.mkdirSync(path.join(dirs.app, 'companion-home', 'identity'), { recursive: true });
  fs.writeFileSync(path.join(dirs.app, 'companion-home', 'identity', 'profile.md'), 'Echo and Sam\n');
  fs.writeFileSync(path.join(dirs.app, 'companion-home', '.hidden'), 'dot\n');
  fs.mkdirSync(dirs.data, { recursive: true });
  if (opts.home !== false) fs.mkdirSync(dirs.home, { recursive: true });
  return dirs;
}
const run = (d, cmd = ['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'one', 'two words']) =>
  spawnSync('sh', [ENTRY, ...cmd], { encoding: 'utf-8', env: { ...process.env, SANCTUM_APP: d.app, SANCTUM_DATA: d.data, SANCTUM_HOME: d.home } });
const done = (d) => fs.rmSync(d.base, { recursive: true, force: true });

describe.skipIf(!haveSh)('docker-entrypoint.sh', () => {
  it('is valid sh, and shellcheck clean when it is installed', () => {
    expect(spawnSync('sh', ['-n', ENTRY]).status).toBe(0);
    if (spawnSync('shellcheck', ['--version']).status === 0) expect(spawnSync('shellcheck', [ENTRY], { encoding: 'utf-8' }).status).toBe(0);
  });
  it('runs its command with the arguments it was given, and passes the exit code on', () => {
    const d = box();
    try {
      const r = run(d);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual(['one', 'two words']);
      expect(run(d, ['sh', '-c', 'exit 7']).status).toBe(7);
    } finally { done(d); }
  });
  it('links the settings files, data and logs onto the volume, and makes the folders the app writes', () => {
    const d = box();
    try {
      expect(run(d).status).toBe(0);
      for (const n of ['sanctum.yaml', '.env', '.mcp.json']) expect(fs.readlinkSync(path.join(d.app, n))).toBe(path.join(d.data, 'config', n));
      expect(fs.readlinkSync(path.join(d.app, 'data'))).toBe(d.data);
      expect(fs.readlinkSync(path.join(d.app, 'logs'))).toBe(path.join(d.data, 'logs'));
      expect(fs.statSync(path.join(d.data, 'logs')).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(d.app, 'prompts', 'wakes')).isDirectory()).toBe(true);
      // A link to a file that is not there yet: writing through it creates the file on the volume (the first run's wizard).
      expect(fs.existsSync(path.join(d.app, '.env'))).toBe(false);
      fs.writeFileSync(path.join(d.app, 'sanctum.yaml'), 'identity:\n  user_name: Sam\n');
      expect(fs.readFileSync(path.join(d.data, 'config', 'sanctum.yaml'), 'utf-8')).toContain('Sam');
    } finally { done(d); }
  });
  it('a second run changes nothing, and files already on the volume are what the app sees', () => {
    const d = box();
    try {
      fs.mkdirSync(path.join(d.data, 'config'));
      fs.writeFileSync(path.join(d.data, 'config', '.env'), 'TZ=UTC\n', { mode: 0o600 });
      expect(run(d).status).toBe(0);
      expect(run(d).status).toBe(0);
      expect(fs.readFileSync(path.join(d.app, '.env'), 'utf-8')).toBe('TZ=UTC\n');
      expect(fs.readlinkSync(path.join(d.app, '.env'))).toBe(path.join(d.data, 'config', '.env'));
    } finally { done(d); }
  });
  it('leaves a real file or folder in the app alone', () => {
    const d = box();
    try {
      fs.writeFileSync(path.join(d.app, 'sanctum.yaml'), 'mine: true\n');
      fs.mkdirSync(path.join(d.app, 'logs'));
      expect(run(d).status).toBe(0);
      expect(fs.lstatSync(path.join(d.app, 'sanctum.yaml')).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(d.app, 'sanctum.yaml'), 'utf-8')).toBe('mine: true\n');
      expect(fs.lstatSync(path.join(d.app, 'logs')).isDirectory()).toBe(true);
    } finally { done(d); }
  });
  it('seeds an empty companion home from the template, and never touches one that holds anything', () => {
    const d = box();
    try {
      expect(run(d).status).toBe(0);
      expect(fs.readFileSync(path.join(d.home, 'identity', 'profile.md'), 'utf-8')).toBe('Echo and Sam\n');
      expect(fs.existsSync(path.join(d.home, '.hidden'))).toBe(true);
      fs.writeFileSync(path.join(d.home, 'identity', 'profile.md'), 'edited by Echo\n');
      fs.rmSync(path.join(d.home, '.hidden'));
      expect(run(d).status).toBe(0);
      expect(fs.readFileSync(path.join(d.home, 'identity', 'profile.md'), 'utf-8')).toBe('edited by Echo\n');
      expect(fs.existsSync(path.join(d.home, '.hidden'))).toBe(false);
    } finally { done(d); }
    const e = box({ home: false });
    try { expect(run(e).status).toBe(0); expect(fs.existsSync(e.home)).toBe(false); } finally { done(e); }
  });
  it('stops with one clear line when the data folder cannot be written', () => {
    const d = box();
    try {
      fs.rmSync(d.data, { recursive: true });
      fs.writeFileSync(d.data, 'a file where the volume should be');
      const r = run(d);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/cannot write to .*data/);
      expect(r.stdout).toBe('');
    } finally { done(d); }
  });
});

describe('the container files', () => {
  const docker = read('Dockerfile');
  it('Dockerfile: two stages on Node 22, the image runs boot.mjs as the node user', () => {
    expect(docker).toMatch(/^FROM node:22-bookworm AS build$/m);
    expect(docker).toMatch(/^FROM node:22-bookworm-slim$/m);
    expect(docker).toMatch(/RUN npm ci\n/);
    expect(docker).toMatch(/RUN npm run build\n/);
    expect(docker).toMatch(/^USER node$/m);
    expect(docker).toMatch(/^WORKDIR \/app$/m);
    expect(docker).toMatch(/^VOLUME \["\/data", "\/companion-home"\]$/m);
    expect(docker).toMatch(/^ENTRYPOINT \["docker-entrypoint\.sh"\]$/m);
    expect(docker).toMatch(/^CMD \["node", "packages\/backend\/boot\.mjs"\]$/m);
    expect(docker.split('\n').filter((l) => !l.startsWith('#')).join('\n')).not.toMatch(/npm start/);
    expect(docker).toMatch(/HEALTHCHECK[\s\S]*\/api\/health/);
    for (const env of ['HOST=0.0.0.0', 'PORT=3099', 'DB_PATH=/data/sanctum.db', 'AGENT_CWD=/companion-home', 'SANCTUM_SUPERVISED=1', 'NODE_ENV=production', 'CLAUDE_CONFIG_DIR=/data/claude']) expect(docker).toContain(env);
  });
  it('Dockerfile: every COPY source exists in the repository', () => {
    for (const m of docker.matchAll(/^COPY (?:--\S+ )*(\S+(?: \S+)*?) \S+$/gm)) {
      for (const src of m[1].split(' ')) if (src !== '.' && !m[0].includes('--from')) expect(fs.existsSync(path.join(ROOT, src)), src).toBe(true);
    }
  });
  it('compose: the app on loopback with two named volumes, and the Tailscale sidecar behind a profile', () => {
    const c = yaml.load(read('docker-compose.yml'));
    expect(c.services.sanctum.ports).toEqual(['127.0.0.1:3099:3099']);
    expect(c.services.sanctum.volumes).toEqual(['sanctum-data:/data', 'sanctum-home:/companion-home']);
    expect(c.services.sanctum.env_file).toEqual([{ path: '.env', required: false }]);
    expect(c.services.sanctum.init).toBe(true);
    const ts = c.services.tailscale;
    expect(ts.profiles).toEqual(['tailscale']);
    expect(ts.network_mode).toBe('service:sanctum');
    expect(Object.keys(ts.environment)).toEqual(expect.arrayContaining(['TS_AUTHKEY', 'TS_STATE_DIR', 'TS_SERVE_CONFIG']));
    expect(ts.environment.TS_STATE_DIR).toBe('/var/lib/tailscale');
    expect(Object.keys(c.volumes).sort()).toEqual(['sanctum-data', 'sanctum-home', 'tailscale-state']);
    for (const v of ts.volumes) if (v.startsWith('./')) expect(fs.existsSync(path.join(ROOT, v.split(':')[0]))).toBe(true);
  });
  it('the Tailscale serve file serves 3099 over HTTPS and is not a Funnel', () => {
    const j = JSON.parse(read('deploy/tailscale-serve.json'));
    expect(j.TCP['443'].HTTPS).toBe(true);
    expect(j.Web['${TS_CERT_DOMAIN}:443'].Handlers['/'].Proxy).toBe('http://127.0.0.1:3099');
    expect(j.AllowFunnel['${TS_CERT_DOMAIN}:443']).toBe(false);
  });
  it('.dockerignore keeps secrets, state and the checkout out of the build', () => {
    const lines = read('.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const must of ['.git', 'node_modules', '.env', 'sanctum.yaml', 'data', 'logs', '.mcp.json']) expect(lines).toContain(must);
    expect(lines).not.toContain('companion-home');
  });
  it('the image workflow: v* tags and manual runs, both platforms, ghcr under the repository owner (no literal name)', () => {
    const text = read('.github/workflows/image.yml');
    const w = yaml.load(text);
    expect(w.on.push.tags).toEqual(['v*']);
    expect(Object.keys(w.on)).toEqual(expect.arrayContaining(['push', 'workflow_dispatch']));
    expect(w.permissions.packages).toBe('write');
    expect(text).toContain('ghcr.io/${{ github.repository_owner }}/sanctum');
    expect(text).toContain('platforms: linux/amd64,linux/arm64');
    expect(text).toMatch(/type=raw,value=latest/);
    expect(text).toMatch(/type=ref,event=tag/);
    expect(text.toLowerCase()).not.toContain('weldbuilder');
  });
});
