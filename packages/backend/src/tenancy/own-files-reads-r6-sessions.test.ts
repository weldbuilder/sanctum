// Round 6, item 2 (sessions): firstPrompt used to open a session file by name after ownReadable had looked at it. Here the pre-check is made to pass for
// everything (so only the open itself can refuse), a FIFO with a writer waiting sits where a session file should be, and the file is also swapped for a FIFO in
// the gap after the check. A wrong open would deliver the writer's bytes (a first prompt) and fail the test; the right one refuses and delivers nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enableTenancy, runInTenant } from './context.js';
import { fakeRuntime } from './test-runtime.js';
import { setAfterReadCheckForTest } from './own-files.js';
import { listTenantSessions } from './sessions.js';

vi.mock('./own-files.js', async (orig) => ({ ...(await orig<typeof import('./own-files.js')>()), ownReadable: () => true }));

const posix = process.platform !== 'win32';
const made: string[] = [];
const children: ChildProcess[] = [];
const line = (text: string) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n';
function setup() {
  const top = realpathSync.native(mkdtempSync(join(tmpdir(), 'sanctum-sess-')));
  made.push(top);
  const tenant = join(top, 'ada');
  const cwd = join(tenant, 'home');
  const configDir = join(tenant, 'data', 'harness', 'claude');
  const project = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(project, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const list = () => runInTenant(fakeRuntime('ada', { dir: tenant, dataDir: join(tenant, 'data'), homeDir: cwd }), () => listTenantSessions(configDir, cwd));
  return { project, list };
}
beforeEach(() => enableTenancy(true));
afterEach(() => {
  setAfterReadCheckForTest(null);
  enableTenancy(false);
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('sessions.firstPrompt opens once, through the guard', () => {
  it('a real session file gives its first prompt', () => {
    const s = setup();
    writeFileSync(join(s.project, 's1.jsonl'), line('MY-FIRST-PROMPT'));
    expect(s.list().map((x) => x.firstPrompt)).toEqual(['MY-FIRST-PROMPT']);
  });
  it.runIf(posix)('a FIFO where a session file should be (the pre-check passes): no first prompt, no bytes read, no wait', () => {
    const s = setup();
    const fifo = join(s.project, 's2.jsonl');
    execFileSync('mkfifo', [fifo]);
    children.push(spawn('sh', ['-c', 'printf "%s" "$0" > "$1"', line('LEAK-PROMPT'), fifo], { stdio: 'ignore' }));
    const got = s.list();
    expect(JSON.stringify(got)).not.toContain('LEAK-PROMPT');
    expect(got.every((x) => x.firstPrompt === undefined)).toBe(true);
  });
  it.runIf(posix)('a session file swapped for a FIFO after the check: no first prompt', () => {
    const s = setup();
    const file = join(s.project, 's3.jsonl');
    writeFileSync(file, line('REAL'));
    let done = false;
    setAfterReadCheckForTest((abs) => {
      if (done) return;
      done = true;
      rmSync(abs);
      execFileSync('mkfifo', [abs]);
      children.push(spawn('sh', ['-c', 'printf "%s" "$0" > "$1"', line('LEAK-PROMPT'), abs], { stdio: 'ignore' }));
    });
    expect(JSON.stringify(s.list())).not.toContain('LEAK-PROMPT');
  });
});
