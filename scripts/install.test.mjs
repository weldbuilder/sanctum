// install.sh (the Ubuntu/Debian cloud-box installer): syntax, shellcheck when it is installed, and a dry run that prints every step and writes nothing.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'install.sh');
const text = fs.readFileSync(SCRIPT, 'utf-8');
const haveBash = spawnSync('bash', ['--version']).status === 0 && process.platform !== 'win32';
const haveShellcheck = haveBash && spawnSync('shellcheck', ['--version']).status === 0;

/** A dry run against a temp folder: returns the output and what the run left in that folder. */
function dry(args = []) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'install-'));
  try {
    const r = spawnSync('bash', [SCRIPT, '--dry-run', '--dir', path.join(root, 'opt'), ...args], { encoding: 'utf-8', stdin: 'ignore', input: '', timeout: 30_000 });
    return { status: r.status, out: r.stdout, err: r.stderr, left: fs.readdirSync(root) };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe.skipIf(!haveBash)('install.sh', () => {
  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf-8' }).status).toBe(0);
  });
  it.skipIf(!haveShellcheck)('is shellcheck clean', () => {
    const r = spawnSync('shellcheck', [SCRIPT], { encoding: 'utf-8' });
    expect(r.stdout).toBe('');
    expect(r.status).toBe(0);
  });
  if (!haveShellcheck) it('shellcheck is not installed here: only bash -n ran', () => { expect(true).toBe(true); });

  it('a dry run prints the eight steps in order and writes nothing', () => {
    const { status, out, left } = dry();
    expect(status).toBe(0);
    const heads = [...out.matchAll(/^==> \[(\d)\/8\] (.+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(heads.map((h) => h[0])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(out).toMatch(/useradd --system --home-dir \/var\/lib\/sanctum --create-home --shell \/usr\/sbin\/nologin sanctum/);
    expect(out).toMatch(/git clone https:\/\/github\.com\/weldbuilder\/sanctum\.git/);
    expect(out).toMatch(/npm --prefix \S+ ci\n/);
    expect(out).toMatch(/npm --prefix \S+ run build\n/);
    expect(out).toMatch(/\.env: SANCTUM_SUPERVISED=1/);
    expect(out).toMatch(/\.env: HOST=127\.0\.0\.1/);
    expect(out).toMatch(/npm --prefix \S+ run setup\n/);
    expect(out).toMatch(/tailscale serve --bg 3099/);
    expect(out).toMatch(/systemctl enable sanctum\n/);
    expect(out).toMatch(/systemctl restart sanctum\n/);
    // The wizard creates the companion home (and seeds the template), so the installer does not.
    expect(out).not.toMatch(/install -d .*companion-home/);
    expect(out).toMatch(/DEBIAN_FRONTEND=noninteractive apt-get/);
    expect(out).toMatch(/journalctl -u sanctum -f/);
    expect(out).toMatch(/npm run doctor -- --headless/);
    expect(left).toEqual([]);
  });
  it('--public writes the Caddyfile for the domain and the matching origin', () => {
    const { status, out } = dry(['--public', '--domain', 'sanctum.example.org']);
    expect(status).toBe(0);
    expect(out).toContain('| sanctum.example.org {');
    expect(out).toMatch(/\|\s+reverse_proxy 127\.0\.0\.1:3099/);
    expect(out).toMatch(/set-config\.mjs .*--origin https:\/\/sanctum\.example\.org/);
    expect(out).not.toMatch(/tailscale serve/);
  });
  it('--no-proxy sets nothing up in front and says what to proxy', () => {
    const { out } = dry(['--no-proxy']);
    expect(out).toMatch(/Nothing was set up in front/);
    expect(out).toMatch(/X-Forwarded-Proto/);
  });
  it('--ref reaches the checkout, and an unknown option or a bad domain is refused', () => {
    expect(dry(['--ref', 'v1.2.3']).out).toMatch(/checkout v1\.2\.3/);
    const bad = dry(['--wat']);
    expect(bad.status).toBe(1);
    expect(bad.err).toMatch(/unknown option --wat/);
    const dom = dry(['--public', '--domain', 'a b;c']);
    expect(dom.status).toBe(1);
  });
  it('re-opens the terminal when stdin is a pipe, and refuses when there is none', () => {
    expect(text).toMatch(/\[ ! -t 0 \]/);
    expect(text).toMatch(/exec <\/dev\/tty/);
    expect(text).toMatch(/needs a terminal/);
    // The whole script is read before it runs: the call is the last line and ends in `exit`.
    expect(text.trimEnd().split('\n').at(-1)).toBe('main "$@"; exit $?');
  });
  it('never echoes a password or a key, and never asks for one', () => {
    expect(text).not.toMatch(/echo/);
    for (const line of text.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      expect(line).not.toMatch(/(say|printf|warn|die)\b.*\$\{?(APP_PASSWORD|ANTHROPIC_API_KEY)/);
      expect(line).not.toMatch(/read\b.*-s\b/);
    }
    expect(text).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it('does not pre-create the companion home, and runs git on the service-owned repo as the service user', () => {
    expect(text).not.toMatch(/install -d .*companion-home/);
    expect(text).toMatch(/"\$\{SVC\[@\]\}" git -C "\$INSTALL_DIR" show-ref/);
  });
  it('--help works when the script is piped in', () => {
    const r = spawnSync('bash', ['-s', '--', '--help'], { encoding: 'utf-8', input: text });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--dry-run\s+print every command/);
  });

  /** Run configure_app with the machine-touching helpers stubbed. `yaml` is whether sanctum.yaml exists first; the wizard prompt's answer is `reply`. */
  function configure(yaml, reply) {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'install-cfg-'));
    try {
      if (yaml) fs.writeFileSync(path.join(root, 'sanctum.yaml'), 'identity:\n  user_name: Sam\n');
      const src = text.replace(/^main "\$@"; exit \$\?$/m, '');
      const script = `${src}
INSTALL_DIR='${root}'; STATE_DIR='${root}/state'; SUDO=(); SVC=(env); DRY=0; TZ_NAME=UTC; CLAUDE_NOW=0
as_root() { :; }
env_default() { :; }
ask() { printf '%s' '${reply}'; }
as_svc() { case "$*" in *set-config.mjs*) : > "$INSTALL_DIR/sanctum.yaml" ;; *) echo "RAN $*" ;; esac; }
grep() { return 0; }
configure_app`;
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8', input: '' });
      return r.stdout + r.stderr;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  it('a first install runs the wizard even though the installer has just created sanctum.yaml', () => {
    const out = configure(false, 'n');
    expect(out).toMatch(/RAN .*npm --prefix \S+ run setup/);
    expect(out).not.toMatch(/Keeping the existing setup/);
  });
  it('a re-run asks, and keeps the setup on the default answer or runs it on y', () => {
    expect(configure(true, 'n')).toMatch(/Keeping the existing setup/);
    expect(configure(true, 'y')).toMatch(/RAN .*run setup/);
  });
  it('picks the Claude program that runs, not the first one found', () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'install-claude-'));
    try {
      const mk = (name, ok) => {
        const d = path.join(root, 'node_modules', '@anthropic-ai', name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'claude'), ok ? '#!/bin/sh\necho 1.0\n' : '#!/bin/sh\nexit 127\n', { mode: 0o755 });
      };
      mk('claude-agent-sdk-linux-x64-musl', false);
      mk('claude-agent-sdk-linux-x64', true);
      const src = text.replace(/^main "\$@"; exit \$\?$/m, '');
      const r = spawnSync('bash', ['-c', `${src}\nINSTALL_DIR='${root}'; SVC=(env); pick_claude`], { encoding: 'utf-8' });
      expect(r.stdout).toBe(path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
