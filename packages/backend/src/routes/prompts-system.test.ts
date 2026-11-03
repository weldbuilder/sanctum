// GET/PUT /api/prompts/system: the Claude frame editor. It shows the frame the agent would use (services/frame-file.ts: the home copy, else the
// configured file) and saves to the home copy, or to a custom frame inside the write roots. It never writes into the app's prompts/ folder.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { closeSync, constants, mkdtempSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ top: '', home: '', cwd: '', outside: '', configured: '', writeRoots: [] as string[], extra: [] as string[] }));
// A save's writes can be made to fail part-way (ENOSPC): the first write puts half its bytes, the next one throws. Off unless a test sets it.
const failWrites = vi.hoisted(() => ({ on: false, calls: 0 }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const writeSync = ((fd: number, buf: any, ...rest: any[]) => {
    if (!failWrites.on || typeof buf === 'string') return (actual.writeSync as any)(fd, buf, ...rest);
    failWrites.calls++;
    if (failWrites.calls === 1) { const [off = 0, len = buf.length - off] = rest; return actual.writeSync(fd, buf, off, Math.max(1, Math.floor(len / 2))); }
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
  }) as typeof actual.writeSync;
  return { ...actual, default: { ...actual, writeSync }, writeSync };
});
// The temp file's random name can be fixed for one request (a name already taken, EEXIST). Off unless a test sets it.
const rnd = vi.hoisted(() => ({ fixed: null as string | null }));
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  const randomBytes = ((n: number, ...rest: any[]) => (rnd.fixed && n === 8 ? Buffer.from(rnd.fixed, 'hex') : (actual.randomBytes as any)(n, ...rest))) as typeof actual.randomBytes;
  return { ...actual, default: { ...actual, randomBytes }, randomBytes };
});
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  h.top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-system-')));
  h.home = path.join(h.top, 'home'); h.outside = path.join(h.top, 'outside');
  for (const d of [h.home, h.outside]) fs.mkdirSync(d);
  return {
    ...actual,
    getSanctumConfig: () => ({
      identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' },
      agent: { cwd: h.cwd || h.home, system_prompt_file: h.configured },
      hooks: { safe_write_prefixes: h.writeRoots, workspace_root: '', vault_path: '', extra_write_paths: h.extra },
      integrations: {}, server: {},
    }),
  };
});
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
  return { ...actual, authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() };
});

import router from './api.js';
import { PROJECT_ROOT } from '../config.js';
import { FrameRefused, assertNotProtectedInode, procFdUsable, protectedFrameFiles, protectedFrameSet, samePath, setFrameStageHookForTest, underFolder, type FrameStage } from '../services/frame-guard.js';

let server: Server;
let base = '';
const app = express();
app.use(express.json());
app.use('/api', router);
beforeAll(async () => {
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); rmSync(h.top, { recursive: true, force: true }); });

const homeCopy = () => join(h.home, 'config', 'companion-claude.md');
const appFrame = () => join(PROJECT_ROOT, 'prompts', 'companion-claude.md');
/** A home on the same device as the app's files, for a test that hard-links an app file into it (a hard link cannot cross devices: EXDEV on Windows, where the
 *  repo and the OS temp folder are on different drives). Made inside the repo (.gitignore: .tmp-*), not under prompts/ or companion-home/, so a save there is
 *  legitimate; removed after the test. */
let repoHome = '';
const useRepoHome = () => { repoHome = realpathSync(mkdtempSync(join(PROJECT_ROOT, '.tmp-prompts-system-'))); h.home = repoHome; };
/** Hard-link `from` to `to`. Only a cross-device refusal (EXDEV) skips the case, and only that one; on Linux the home is on the app's device, so this never
 *  skips there, and any other error (EPERM, EEXIST, ...) is rethrown, never swallowed. */
const hardLink = (ctx: { skip: (note?: string) => never }, from: string, to: string) => {
  try { linkSync(from, to); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EXDEV') ctx.skip('hard link across devices not possible here'); throw e; }
};
const get = async () => { const r = await fetch(`${base}/prompts/system`); return { status: r.status, json: (await r.json()) as any }; };
const put = async (content: unknown) => {
  const r = await fetch(`${base}/prompts/system`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
  return { status: r.status, json: (await r.json()) as any };
};

let shipped = '';
beforeEach(() => {
  rmSync(join(h.home, 'config'), { recursive: true, force: true });
  h.configured = appFrame(); // the default of a single-tenant install: ./prompts/companion-claude.md
  h.writeRoots = [];
  h.extra = [];
  shipped = readFileSync(appFrame(), 'utf8');
});
afterEach(() => {
  delete process.env.AGENT_PROVIDER;
  setFrameStageHookForTest(null);
  failWrites.on = false; failWrites.calls = 0;
  rnd.fixed = null;
  h.cwd = '';
  if (repoHome) { h.home = join(h.top, 'home'); rmSync(repoHome, { recursive: true, force: true }); repoHome = ''; }
  // The app's own file is never touched by any case here.
  expect(readFileSync(appFrame(), 'utf8')).toBe(shipped);
});

describe('GET /api/prompts/system', () => {
  it('single-tenant default: the shipped frame is the starting text, and the save target is the home copy', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.json.configured).toBe(true);
    expect(r.json.source).toBe('configured');
    expect(r.json.content).toBe(shipped);
    expect(r.json.path).toBe(homeCopy());
    expect(r.json.read_path).toBe(appFrame()); // (where the text came from, so the page can say the save creates a copy)
    expect(r.json.template).toBe(true); // (a save would create the copy, so the page enables Save unedited)
    expect(r.json.provider).toBe('claude');
    expect(r.json.agents_md).toBe('');
  });

  it('the app prompts/ folder is never the save target, even when a write root covers it', async () => {
    h.writeRoots = [PROJECT_ROOT];
    const r = await get();
    expect(r.json.source).toBe('configured');
    expect(r.json.content).toBe(shipped);
    expect(r.json.path).toBe(homeCopy());
  });

  it('a home copy wins: source "home", its text, and its own path', async () => {
    mkdirSync(join(h.home, 'config'));
    writeFileSync(homeCopy(), 'HOME FRAME');
    const r = await get();
    expect(r.json).toMatchObject({ configured: true, source: 'home', content: 'HOME FRAME', path: homeCopy(), read_path: homeCopy(), template: false });
  });

  it('a custom frame inside the write roots is read, and saved, in place', async () => {
    const custom = join(h.home, 'frame.md');
    writeFileSync(custom, 'CUSTOM FRAME');
    h.configured = custom;
    const r = await get();
    expect(r.json).toMatchObject({ source: 'configured', content: 'CUSTOM FRAME', path: custom, read_path: custom, template: false });
    rmSync(custom);
  });

  it('a configured file outside the write roots is shown as the starting text and saved to the home copy', async () => {
    const elsewhere = join(h.outside, 'frame.md');
    writeFileSync(elsewhere, 'ELSEWHERE FRAME');
    h.configured = elsewhere;
    const r = await get();
    expect(r.json).toMatchObject({ source: 'configured', content: 'ELSEWHERE FRAME', path: homeCopy(), read_path: elsewhere, template: true });
  });

  it('no frame resolves (the key names a file that is not there): the shipped harness is the starting text, template, source stays "none"', async () => {
    h.configured = join(h.home, 'frame.md');
    const r = await get();
    expect(r.json).toMatchObject({ configured: true, source: 'none', content: shipped, path: join(h.home, 'frame.md'), read_path: appFrame(), template: true });
  });

  it('the tenant default (key = the home copy, not made yet): the shipped harness is offered, and the save target is the home copy', async () => {
    h.configured = homeCopy();
    const r = await get();
    expect(r.json).toMatchObject({ configured: true, source: 'none', content: shipped, path: homeCopy(), read_path: appFrame(), template: true });
    expect((await put(r.json.content)).status).toBe(200); // (saving it unedited installs the copy)
    expect(readFileSync(homeCopy(), 'utf8')).toBe(shipped);
    expect((await get()).json).toMatchObject({ source: 'home', read_path: homeCopy(), template: false });
  });

  it('an empty key and no home copy: not configured, nothing to save to', async () => {
    h.configured = '';
    const r = await get();
    expect(r.json).toMatchObject({ configured: false, source: 'none', content: '', path: '', template: false });
  });

  it('an empty key with a home copy: the home copy is the frame the agent uses, so it is offered', async () => {
    h.configured = '';
    mkdirSync(join(h.home, 'config'));
    writeFileSync(homeCopy(), 'HOME FRAME');
    expect((await get()).json).toMatchObject({ configured: true, source: 'home', content: 'HOME FRAME', path: homeCopy() });
  });

  it('on dsh (and Codex) the answer points at the identity folder', async () => {
    process.env.AGENT_PROVIDER = 'dsh';
    const r = await get();
    expect(r.json.provider).toBe('dsh');
    expect(r.json.agents_md).toBe(join(h.home, 'identity'));
  });
});

describe('PUT /api/prompts/system', () => {
  it('single-tenant default: writes the home copy (creating config/) and leaves prompts/companion-claude.md untouched', async () => {
    expect(existsSync(join(h.home, 'config'))).toBe(false);
    const r = await put('MY FRAME\n');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, bytes: 9, source: 'home', path: homeCopy() });
    expect(readFileSync(homeCopy(), 'utf8')).toBe('MY FRAME\n');
    expect(readFileSync(appFrame(), 'utf8')).toBe(shipped); // (also checked after every case)
    const again = await get();
    expect(again.json).toMatchObject({ source: 'home', content: 'MY FRAME\n', path: homeCopy() });
  });

  it('refuses the app prompts/ folder even when a write root covers it: the save still goes to the home copy', async () => {
    h.writeRoots = [PROJECT_ROOT];
    const r = await put('NOT IN PROMPTS');
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(homeCopy());
    expect(readFileSync(homeCopy(), 'utf8')).toBe('NOT IN PROMPTS');
  });

  it('a custom frame inside the write roots is written in place, and no home copy appears', async () => {
    const custom = join(h.home, 'frame.md');
    writeFileSync(custom, 'OLD');
    h.configured = custom;
    const r = await put('NEW');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, source: 'configured', path: custom });
    expect(readFileSync(custom, 'utf8')).toBe('NEW');
    expect(existsSync(homeCopy())).toBe(false);
    rmSync(custom);
  });

  it('with a home copy present the save goes to it (it is the file the agent reads), not to the configured file', async () => {
    const custom = join(h.home, 'frame.md');
    writeFileSync(custom, 'CUSTOM');
    h.configured = custom;
    mkdirSync(join(h.home, 'config'));
    writeFileSync(homeCopy(), 'HOME');
    const r = await put('EDITED');
    expect(r.json.path).toBe(homeCopy());
    expect(readFileSync(homeCopy(), 'utf8')).toBe('EDITED');
    expect(readFileSync(custom, 'utf8')).toBe('CUSTOM');
    rmSync(custom);
  });

  it('a configured file outside the write roots is not written: the home copy is', async () => {
    const elsewhere = join(h.outside, 'frame.md');
    writeFileSync(elsewhere, 'UNTOUCHED');
    h.configured = elsewhere;
    const r = await put('EDITED');
    expect(r.status).toBe(200);
    expect(readFileSync(elsewhere, 'utf8')).toBe('UNTOUCHED');
    expect(readFileSync(homeCopy(), 'utf8')).toBe('EDITED');
  });

  it('an empty key and no home copy: 400, nothing written', async () => {
    h.configured = '';
    const r = await put('X');
    expect(r.status).toBe(400);
    expect(existsSync(join(h.home, 'config'))).toBe(false);
  });

  describe('never through a link, never into the app folders', () => {
    const appHome = () => join(PROJECT_ROOT, 'companion-home');
    const trackedHome = () => join(appHome(), 'config', 'companion-claude.md');
    it('a home copy that is a link to prompts/companion-claude.md: refused, the app file byte-identical', async () => {
      mkdirSync(join(h.home, 'config'));
      symlinkSync(appFrame(), homeCopy());
      const before = readFileSync(appFrame());
      const r = await put('OVERWRITTEN THROUGH THE LINK');
      expect(r.status).toBe(400);
      expect(readFileSync(appFrame()).equals(before)).toBe(true);
    });

    it('a home copy that is a link to the tracked starter home: refused, that file byte-identical', async () => {
      mkdirSync(join(h.home, 'config'));
      symlinkSync(trackedHome(), homeCopy());
      const before = readFileSync(trackedHome());
      expect((await put('X')).status).toBe(400);
      expect(readFileSync(trackedHome()).equals(before)).toBe(true);
    });

    it('a config/ folder that is a link (to the app prompts/ folder): refused, nothing written there', async () => {
      symlinkSync(join(PROJECT_ROOT, 'prompts'), join(h.home, 'config'));
      const before = readFileSync(appFrame());
      const r = await put('X');
      expect(r.status).toBe(400);
      expect(readFileSync(appFrame()).equals(before)).toBe(true);
      expect(existsSync(join(PROJECT_ROOT, 'prompts', 'companion-claude.md.tmp'))).toBe(false);
    });

    it('a config/ folder that is a link to an ordinary folder is refused too (no save lands through a link)', async () => {
      symlinkSync(h.outside, join(h.home, 'config'));
      expect((await put('X')).status).toBe(400);
      expect(existsSync(join(h.outside, 'companion-claude.md'))).toBe(false);
    });

    it('a custom frame inside the write roots that is a link: refused, the target untouched', async () => {
      const custom = join(h.home, 'frame.md');
      const target = join(h.outside, 'target.md');
      writeFileSync(target, 'TARGET');
      symlinkSync(target, custom);
      h.configured = custom;
      expect((await put('X')).status).toBe(400);
      expect(readFileSync(target, 'utf8')).toBe('TARGET');
      rmSync(custom);
    });

    it('a home copy hard-linked to the app file: refused, the app file byte-identical', async (ctx) => {
      useRepoHome();
      mkdirSync(join(h.home, 'config'));
      hardLink(ctx, appFrame(), homeCopy());
      const before = readFileSync(appFrame());
      const r = await put('OVERWRITTEN THROUGH THE HARD LINK');
      expect(r.status).toBe(400);
      expect(readFileSync(appFrame()).equals(before)).toBe(true);
    });

    it('a write root that is itself a link into the app prompts/ folder: 403 (by where the save would really land)', async () => {
      const viaLink = join(h.top, 'via-link');
      symlinkSync(join(PROJECT_ROOT, 'prompts'), viaLink);
      h.cwd = viaLink;
      const before = readFileSync(appFrame());
      expect((await put('X')).status).toBe(403);
      expect(readFileSync(appFrame()).equals(before)).toBe(true);
      rmSync(viaLink);
    });

    it('agent.cwd under the tracked starter home: 403, the tracked home copy byte-identical', async () => {
      h.cwd = appHome();
      h.configured = '';
      const before = readFileSync(trackedHome());
      const r = await put('X');
      expect(r.status).toBe(403);
      expect(readFileSync(trackedHome()).equals(before)).toBe(true);
    });

    it('agent.cwd in a not-yet-made folder under the starter home: 403, and the folder is not made', async () => {
      h.cwd = join(appHome(), 'not-made-yet');
      expect((await put('X')).status).toBe(403);
      expect(existsSync(h.cwd)).toBe(false);
    });

    it('agent.cwd under the app prompts/ folder: 403, nothing written', async () => {
      h.cwd = join(PROJECT_ROOT, 'prompts', 'not-made-yet');
      expect((await put('X')).status).toBe(403);
      expect(existsSync(h.cwd)).toBe(false);
    });
  });

  it('refuses a body without a string content', async () => {
    expect((await put(5)).status).toBe(400);
    expect(existsSync(homeCopy())).toBe(false);
  });
});

const posix = process.platform !== 'win32';
/** The points of a save or read where a test swaps a folder (services/frame-guard.ts, setFrameStageHookForTest). */
const stages: FrameStage[] = ['boundary', 'parent'];
const withPlatform = async (platform: NodeJS.Platform, fn: () => unknown | Promise<unknown>) => {
  const was = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...was, value: platform });
  try { await fn(); } finally { Object.defineProperty(process, 'platform', was); }
};
const appFolderFiles = () => [join(PROJECT_ROOT, 'prompts'), join(PROJECT_ROOT, 'companion-home', 'config')].flatMap((d) => readdirSync(d).map((n) => join(d, n)));
const snapshotApp = () => new Map(appFolderFiles().map((f) => [f, readFileSync(f)]));
const sameApp = (before: Map<string, Buffer>) => {
  const now = appFolderFiles();
  expect(now.sort()).toEqual([...before.keys()].sort()); // (no file added to, or removed from, the app's folders)
  for (const [f, bytes] of before) expect(readFileSync(f).equals(bytes), f).toBe(true);
};
/** Every entry under the app's prompts/ and companion-home/, recursively (lstat): its kind, inode, size and modification time (a folder's changes when a
 *  name is made in it or taken from it, even when it is gone again; its change time too), and a hash of a file's bytes. Equal before and after: nothing was made, removed or written there. */
const appTree = (): Map<string, string> => {
  const m = new Map<string, string>();
  const walk = (p: string) => {
    const st = lstatSync(p, { bigint: true });
    const kind = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : st.isFile() ? 'f' : 'o';
    m.set(p, `${kind}:${st.ino}:${st.size}:${st.mtimeNs}${kind === 'd' ? ':' + st.ctimeNs : ''}${kind === 'f' ? ':' + createHash('sha256').update(readFileSync(p)).digest('hex') : ''}`);
    if (kind === 'd') for (const n of readdirSync(p)) walk(join(p, n));
  };
  walk(join(PROJECT_ROOT, 'prompts')); walk(join(PROJECT_ROOT, 'companion-home'));
  return m;
};
const sameTree = (before: Map<string, string>) => {
  const now = appTree();
  expect([...now.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [p, v] of before) expect(now.get(p), p).toBe(v);
};
/** Swap `dir` (a real folder) for a link to `to`, keeping the real one at `${dir}-real`; and back. */
const swapForLink = (dir: string, to: string) => { renameSync(dir, `${dir}-real`); symlinkSync(to, dir); };
const swapBack = (dir: string) => { rmSync(dir, { force: true }); if (existsSync(`${dir}-real`)) renameSync(`${dir}-real`, dir); };

describe('an exact-file write root: the target itself is always checked', () => {
  it('a hard link at the home copy, named exactly by a write root: refused, the tracked file byte-identical', async (ctx) => {
    useRepoHome();
    mkdirSync(join(h.home, 'config'));
    hardLink(ctx, appFrame(), homeCopy());
    h.extra = [homeCopy()];
    const app = snapshotApp();
    const r = await put('OVERWRITTEN THROUGH THE HARD LINK');
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('hard-linked');
    sameApp(app);
  });

  it('a symlink at the home copy, named exactly by a write root: refused, the target byte-identical', async () => {
    mkdirSync(join(h.home, 'config'));
    symlinkSync(appFrame(), homeCopy());
    h.extra = [homeCopy()];
    const app = snapshotApp();
    const r = await put('OVERWRITTEN THROUGH THE LINK');
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('link');
    sameApp(app);
  });

  it('a symlink at the configured frame, named exactly by a write root: refused, the target untouched', async () => {
    const custom = join(h.outside, 'exact.md');
    const target = join(h.outside, 'exact-target.md');
    writeFileSync(target, 'TARGET');
    symlinkSync(target, custom);
    h.configured = custom;
    h.extra = [custom];
    expect((await put('X')).status).toBe(400);
    expect(readFileSync(target, 'utf8')).toBe('TARGET');
    rmSync(custom);
  });

  it.runIf(posix)('a FIFO at an exact-file write root: 400 promptly, nothing hangs', async () => {
    const fifo = join(h.outside, 'exact.fifo');
    execFileSync('mkfifo', [fifo]);
    h.configured = fifo;
    h.extra = [fifo];
    try {
      const r = await Promise.race([put('X'), new Promise<never>((_, no) => setTimeout(() => no(new Error('PUT hung on a FIFO')), 4000))]);
      expect(r.status).toBe(400);
    } finally { rmSync(fifo, { force: true }); }
  }, 8000);

  it('a folder at the target path: 400, not a 500', async () => {
    const custom = join(h.outside, 'folder-frame');
    mkdirSync(custom);
    h.configured = custom;
    h.extra = [custom];
    expect((await put('X')).status).toBe(400);
    rmSync(custom, { recursive: true });
  });

  it('an exact-file write root that is a plain file is written in place (the control)', async () => {
    const custom = join(h.outside, 'plain.md');
    writeFileSync(custom, 'OLD');
    h.configured = custom;
    h.extra = [custom];
    expect((await put('NEW')).status).toBe(200);
    expect(readFileSync(custom, 'utf8')).toBe('NEW');
    rmSync(custom);
  });
});

describe('a home that is not made yet', () => {
  it('agent.cwd naming a folder that does not exist yet: 200, the folders and the copy are created', async () => {
    h.cwd = join(h.top, 'fresh', 'deeper-home');
    expect(existsSync(h.top + '/fresh')).toBe(false);
    const r = await put('FIRST SAVE');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, source: 'home', path: join(h.cwd, 'config', 'companion-claude.md') });
    expect(readFileSync(join(h.cwd, 'config', 'companion-claude.md'), 'utf8')).toBe('FIRST SAVE');
    rmSync(join(h.top, 'fresh'), { recursive: true });
  });

  it('a not-yet-made home under a link into the app prompts/ folder is still refused (by the deepest existing part)', async () => {
    const viaLink = join(h.top, 'via-link2');
    symlinkSync(join(PROJECT_ROOT, 'prompts'), viaLink);
    h.cwd = join(viaLink, 'not-made');
    const app = snapshotApp();
    expect((await put('X')).status).toBe(403);
    sameApp(app);
    rmSync(viaLink);
  });
});

describe('case-insensitive file systems (macOS, Windows)', () => {
  it('underFolder and samePath fold case on darwin and win32, and only there', async () => {
    const dir = join(PROJECT_ROOT, 'prompts');
    const odd = join(PROJECT_ROOT, 'Prompts', 'x.md');
    await withPlatform('linux', () => {
      expect(underFolder(odd, dir)).toBe(false);
      expect(samePath('/A/b', '/a/B')).toBe(false);
    });
    for (const platform of ['darwin', 'win32'] as const) {
      await withPlatform(platform, () => {
        expect(underFolder(odd, dir)).toBe(true);
        expect(underFolder(join(PROJECT_ROOT, 'PROMPTS'), dir)).toBe(true);
        expect(underFolder(`${dir}-other`, dir)).toBe(false); // (a sibling that merely starts with the name)
        expect(underFolder(join(PROJECT_ROOT, 'Promptsx', 'a'), dir)).toBe(false);
        expect(samePath('/A/b', '/a/B')).toBe(true);
      });
    }
  });

  it('on darwin a configured <root>/PROMPTS/... is "under prompts/": not the save target, the home copy is', async () => {
    h.writeRoots = [PROJECT_ROOT];
    h.configured = join(PROJECT_ROOT, 'PROMPTS', 'companion-claude.md');
    await withPlatform('darwin', async () => {
      const r = await get();
      expect(r.json.path).toBe(homeCopy());
    });
  });

  it('on darwin agent.cwd spelled <root>/Companion-Home/...: 403, nothing made', async () => {
    h.cwd = join(PROJECT_ROOT, 'Companion-Home', 'not-made-yet');
    await withPlatform('darwin', async () => { expect((await put('X')).status).toBe(403); });
    expect(existsSync(h.cwd)).toBe(false);
  });
});

describe('the open handle is verified by inode, whatever the path checks saw', () => {
  it('assertNotProtectedInode: a descriptor on a protected file is refused (403), any other file passes', () => {
    const other = join(h.outside, 'other.md');
    writeFileSync(other, 'OTHER');
    const protectedSet = protectedFrameFiles(PROJECT_ROOT);
    expect(protectedSet.size).toBeGreaterThanOrEqual(3);
    const tracked = openSync(appFrame(), 'r');
    const starter = openSync(join(PROJECT_ROOT, 'companion-home', 'config', 'companion-claude.md'), 'r');
    const plain = openSync(other, 'r');
    try {
      expect(() => assertNotProtectedInode(tracked, protectedSet)).toThrow(FrameRefused);
      try { assertNotProtectedInode(tracked, protectedSet); } catch (e) { expect((e as FrameRefused).status).toBe(403); }
      expect(() => assertNotProtectedInode(starter, protectedSet)).toThrow(FrameRefused);
      expect(() => assertNotProtectedInode(plain, protectedSet)).not.toThrow();
    } finally { closeSync(tracked); closeSync(starter); closeSync(plain); }
    rmSync(other);
  });

  it('protectedFrameFiles follows a link: a link to a tracked file is that file', () => {
    const lnk = join(h.outside, 'lnk.md');
    symlinkSync(appFrame(), lnk);
    const viaLink = openSync(lnk, 'r');
    try { expect(() => assertNotProtectedInode(viaLink, protectedFrameFiles(PROJECT_ROOT))).toThrow(FrameRefused); } finally { closeSync(viaLink); }
    rmSync(lnk);
  });

  it('protectedFrameSet walks both trees: every folder and file under prompts/ and companion-home/ (companion-home/AGENTS.md and the folders too)', () => {
    const set = protectedFrameSet(PROJECT_ROOT);
    const key = (p: string) => { const st = statSync(p, { bigint: true }); return `${st.dev}:${st.ino}`; };
    for (const f of [appFrame(), join(PROJECT_ROOT, 'companion-home', 'AGENTS.md'), join(PROJECT_ROOT, 'companion-home', 'identity', 'profile.md')]) expect(set.files.has(key(f)), f).toBe(true);
    for (const d of ['prompts', 'companion-home', join('companion-home', 'config'), join('companion-home', 'identity')]) expect(set.dirs.has(key(join(PROJECT_ROOT, d))), d).toBe(true);
    expect(set.files.has(key(h.home))).toBe(false);
    expect(set.dirs.has(key(h.home))).toBe(false);
  });

  // A folder on the way swapped for a link into the app's folders, at each point of the save: after the folder the walk starts at is held ('boundary'),
  // and once the target's parent folder is held ('parent'). Refused every time, and nothing is made in, removed from or written to the app's trees.
  // Linux: the walk holds each folder by descriptor, so the swapped link is refused as a link (boundary), or the held folder is found moved (parent).
  // Elsewhere the path walk sees the link (boundary), or the open handle is a tracked file by inode (parent, an existing name: 403).
  const linkInto = (name: string) => join(PROJECT_ROOT, ...name.split('/'));
  for (const stage of stages) {
    for (const into of ['prompts', 'companion-home/config']) {
      it(`RACE at '${stage}': <home>/config is a real folder at every path check, then swapped for a link to <root>/${into}: refused, the app's trees unchanged`, async () => {
        mkdirSync(join(h.home, 'config'));
        writeFileSync(homeCopy(), 'REAL HOME COPY');
        const tree = appTree();
        let swapped = 0;
        setFrameStageHookForTest((at) => { if (at === stage && !swapped++) swapForLink(join(h.home, 'config'), linkInto(into)); });
        try {
          const r = await put('OVERWRITTEN THROUGH THE SWAPPED FOLDER');
          expect(swapped).toBe(1); // (the path checks all passed: the hook ran after them)
          if (procFdUsable()) {
            expect(r.status).toBe(400);
            expect(r.json.error).toContain(stage === 'boundary' ? 'config is a link' : 'changed while it was being used');
          } else expect(r.status).toBe(stage === 'boundary' ? 400 : 403);
          sameTree(tree);
        } finally { setFrameStageHookForTest(null); swapBack(join(h.home, 'config')); }
        expect(readFileSync(homeCopy(), 'utf8')).toBe('REAL HOME COPY'); // (the real folder got nothing either: no save lands in a folder that moved)
        expect(readdirSync(join(h.home, 'config'))).toEqual(['companion-claude.md']); // (no temp file left)
      });

      it.runIf(procFdUsable())(`RACE at '${stage}': a NEW name (a custom frame not there yet) through a folder swapped for a link to <root>/${into}: refused, nothing made there`, async () => {
        mkdirSync(join(h.home, 'sub'));
        h.configured = join(h.home, 'sub', 'frame-not-there-yet.md');
        const tree = appTree();
        setFrameStageHookForTest((at) => { if (at === stage) swapForLink(join(h.home, 'sub'), linkInto(into)); });
        try { expect((await put('X')).status).toBe(400); sameTree(tree); }
        finally { setFrameStageHookForTest(null); swapBack(join(h.home, 'sub')); }
        expect(readdirSync(join(h.home, 'sub'))).toEqual([]);
        rmSync(join(h.home, 'sub'), { recursive: true });
      });
    }
  }

  it.runIf(procFdUsable())('RACE: missing folders (a/b) are made through the held folder above: a swapped for a link to prompts/ makes no prompts/b', async () => {
    mkdirSync(join(h.home, 'a'));
    h.configured = join(h.home, 'a', 'b', 'frame.md');
    const tree = appTree();
    setFrameStageHookForTest((at) => { if (at === 'boundary') swapForLink(join(h.home, 'a'), join(PROJECT_ROOT, 'prompts')); });
    try { expect((await put('X')).status).toBe(400); sameTree(tree); expect(existsSync(join(PROJECT_ROOT, 'prompts', 'b'))).toBe(false); }
    finally { setFrameStageHookForTest(null); swapBack(join(h.home, 'a')); rmSync(join(h.home, 'a'), { recursive: true, force: true }); }
    // (the control: with no swap the folders are made and the frame saved)
    h.configured = join(h.home, 'a', 'b', 'frame.md');
    expect((await put('MADE')).status).toBe(200);
    expect(readFileSync(join(h.home, 'a', 'b', 'frame.md'), 'utf8')).toBe('MADE');
    rmSync(join(h.home, 'a'), { recursive: true, force: true });
  });

  it('RACE: a hard link to the tracked file appears at the target once its folder is held: 400, the app trees unchanged', async (ctx) => {
    useRepoHome();
    const tree = appTree();
    // (the hook runs inside the request: a cross-device refusal would surface there as a 500, so it is found out first, before the request)
    mkdirSync(join(h.home, 'config')); hardLink(ctx, appFrame(), homeCopy()); rmSync(join(h.home, 'config'), { recursive: true });
    setFrameStageHookForTest((at) => { if (at === 'parent') { mkdirSync(join(h.home, 'config'), { recursive: true }); linkSync(appFrame(), homeCopy()); } });
    const r = await put('X');
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('hard-linked');
    setFrameStageHookForTest(null);
    rmSync(homeCopy());
    sameTree(tree);
  });

  it('RACE: a symlink to the tracked file appears at the target once its folder is held: refused (no link is followed), the app trees unchanged', async () => {
    const tree = appTree();
    setFrameStageHookForTest((at) => { if (at === 'parent') { mkdirSync(join(h.home, 'config'), { recursive: true }); symlinkSync(appFrame(), homeCopy()); } });
    const r = await put('X');
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('link');
    setFrameStageHookForTest(null);
    rmSync(homeCopy());
    sameTree(tree);
  });

  it('off Linux (darwin): an existing name through a folder swapped for a link into companion-home/ is a tracked file by inode (AGENTS.md too): 403, unchanged', async () => {
    mkdirSync(join(h.home, 'sub'));
    writeFileSync(join(h.home, 'sub', 'AGENTS.md'), 'MINE');
    h.configured = join(h.home, 'sub', 'AGENTS.md');
    const tree = appTree();
    setFrameStageHookForTest((at) => { if (at === 'parent') swapForLink(join(h.home, 'sub'), join(PROJECT_ROOT, 'companion-home')); });
    try { await withPlatform('darwin', async () => { expect((await put('PWNED')).status).toBe(403); }); sameTree(tree); }
    finally { setFrameStageHookForTest(null); swapBack(join(h.home, 'sub')); }
    expect(readFileSync(join(h.home, 'sub', 'AGENTS.md'), 'utf8')).toBe('MINE');
    rmSync(join(h.home, 'sub'), { recursive: true });
  });

  it('off Linux (darwin): a folder swapped for a link before the walk is refused by the walk (400), the app trees unchanged', async () => {
    mkdirSync(join(h.home, 'config'));
    writeFileSync(homeCopy(), 'REAL HOME COPY');
    const tree = appTree();
    setFrameStageHookForTest((at) => { if (at === 'boundary') swapForLink(join(h.home, 'config'), join(PROJECT_ROOT, 'prompts')); });
    try { await withPlatform('darwin', async () => { expect((await put('X')).status).toBe(400); }); sameTree(tree); }
    finally { setFrameStageHookForTest(null); swapBack(join(h.home, 'config')); }
    expect(readFileSync(homeCopy(), 'utf8')).toBe('REAL HOME COPY');
  });
});

describe('the save is all or nothing (a temp file in the folder, renamed over the name)', () => {
  it.skipIf(!procFdUsable())('rename, unlink and mkdir through /proc/self/fd/<fd>/<name> work on this kernel, and land in the HELD folder after it moved (skipped where /proc/self/fd is not readable)', () => {
    const real = join(h.outside, 'held');
    mkdirSync(real);
    writeFileSync(join(real, 'f.md'), 'OLD');
    const P = openSync(real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      expect(readlinkSync(`/proc/self/fd/${P}`)).toBe(real);
      renameSync(real, `${real}-moved`); mkdirSync(join(h.outside, 'decoy')); symlinkSync(join(h.outside, 'decoy'), real); // (the path now names another folder)
      expect(readlinkSync(`/proc/self/fd/${P}`)).toBe(`${real}-moved`);
      const t = openSync(`/proc/self/fd/${P}/.f.md.tmp`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      writeSync(t, 'NEW'); closeSync(t);
      renameSync(`/proc/self/fd/${P}/.f.md.tmp`, `/proc/self/fd/${P}/f.md`);
      mkdirSync(`/proc/self/fd/${P}/made`);
      writeFileSync(join(`${real}-moved`, 'gone.md'), 'x');
      unlinkSync(`/proc/self/fd/${P}/gone.md`);
      expect(readFileSync(join(`${real}-moved`, 'f.md'), 'utf8')).toBe('NEW');
      expect(readdirSync(`${real}-moved`).sort()).toEqual(['f.md', 'made']);
      expect(readdirSync(join(h.outside, 'decoy'))).toEqual([]);
      symlinkSync(join(h.outside, 'decoy'), join(`${real}-moved`, 'lnk'));
      expect(() => openSync(`/proc/self/fd/${P}/lnk`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)).toThrow(/ENOTDIR|ELOOP/);
    } finally { closeSync(P); }
  });

  it('a write that fails part-way (ENOSPC) leaves the existing frame byte-identical, and no temp file behind', async () => {
    mkdirSync(join(h.home, 'config'));
    writeFileSync(homeCopy(), 'THE FRAME AS IT WAS\n');
    const ino = statSync(homeCopy()).ino;
    const tree = appTree();
    failWrites.on = true;
    const r = await put('A NEW FRAME, '.repeat(6000)); // (78 KB: under the JSON body limit, several writes' worth)
    failWrites.on = false;
    expect(failWrites.calls).toBe(2); // (half the bytes went out, then the disk was full)
    expect(r.status).toBe(500);
    expect(readFileSync(homeCopy(), 'utf8')).toBe('THE FRAME AS IT WAS\n');
    expect(statSync(homeCopy()).ino).toBe(ino); // (the rename never happened: the same file)
    expect(readdirSync(join(h.home, 'config'))).toEqual(['companion-claude.md']); // (the temp file removed)
    sameTree(tree);
  });

  it('off Linux (darwin path): a write that fails part-way (ENOSPC) leaves the existing frame byte-identical, and no temp file behind', async () => {
    mkdirSync(join(h.home, 'config'));
    writeFileSync(homeCopy(), 'THE FRAME AS IT WAS\n');
    const ino = statSync(homeCopy()).ino;
    const tree = appTree();
    failWrites.on = true;
    let r!: { status: number; json: any };
    await withPlatform('darwin', async () => { r = await put('A NEW FRAME, '.repeat(6000)); });
    failWrites.on = false;
    expect(failWrites.calls).toBe(2); // (half the bytes went out, then the disk was full)
    expect(r.status).toBe(500);
    expect(readFileSync(homeCopy(), 'utf8')).toBe('THE FRAME AS IT WAS\n');
    expect(statSync(homeCopy()).ino).toBe(ino); // (the rename never happened: the same file)
    expect(readdirSync(join(h.home, 'config'))).toEqual(['companion-claude.md']); // (the temp file removed)
    sameTree(tree);
  });

  it.runIf(procFdUsable())('a save replaces the file whole (a new inode), keeps its mode, and leaves no temp file; a reader never sees it empty', async () => {
    mkdirSync(join(h.home, 'config'));
    writeFileSync(homeCopy(), 'OLD', { mode: 0o600 });
    const ino = statSync(homeCopy()).ino;
    expect((await put('NEW')).status).toBe(200);
    expect(readFileSync(homeCopy(), 'utf8')).toBe('NEW');
    expect(statSync(homeCopy()).ino).not.toBe(ino);
    expect(statSync(homeCopy()).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(h.home, 'config'))).toEqual(['companion-claude.md']);
    let empty = 0;
    for (let i = 0; i < 30; i++) {
      const saving = put(`SAVE ${i} ` + 'x'.repeat(50000));
      if (readFileSync(homeCopy()).length === 0) empty++;
      expect((await saving).status).toBe(200);
      if (readFileSync(homeCopy()).length === 0) empty++;
    }
    expect(empty).toBe(0);
  });
});

describe('a folder or the temp file changed underneath a save or a read (Linux)', () => {
  const tmpName = () => readdirSync(join(h.home, 'config')).find((n) => n.includes('.tmp-'))!;

  for (const kind of ['symlink', 'hard link']) it.runIf(procFdUsable())(`RACE: the temp file replaced by a ${kind} to the tracked file before the rename: 400, no home copy, the app file unchanged, the other entry left alone`, async (ctx) => {
    useRepoHome();
    mkdirSync(join(h.home, 'config'));
    if (kind === 'hard link') { hardLink(ctx, appFrame(), join(h.home, 'config', 'probe')); rmSync(join(h.home, 'config', 'probe')); }
    const tree = appTree();
    let planted = '';
    setFrameStageHookForTest((at) => {
      if (at !== 'written') return;
      planted = join(h.home, 'config', tmpName());
      unlinkSync(planted);
      if (kind === 'symlink') symlinkSync(appFrame(), planted); else linkSync(appFrame(), planted);
    });
    const r = await put('MY TEXT');
    setFrameStageHookForTest(null);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('The frame path changed during the save');
    expect(existsSync(homeCopy())).toBe(false);
    expect(kind === 'symlink' ? lstatSync(planted).isSymbolicLink() : lstatSync(planted).nlink).toBe(kind === 'symlink' ? true : 2); // (not ours: not removed)
    rmSync(planted);
    sameTree(tree);
  });

  it.runIf(procFdUsable())('RACE: a folder put at the name before the rename (EISDIR): 400 "changed during the save", our temp file removed, the folder left', async () => {
    setFrameStageHookForTest((at) => { if (at === 'written') mkdirSync(homeCopy()); });
    const r = await put('X');
    setFrameStageHookForTest(null);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('The frame path changed during the save');
    expect(readdirSync(join(h.home, 'config'))).toEqual(['companion-claude.md']);
    expect(statSync(homeCopy()).isDirectory()).toBe(true);
  });

  it.runIf(procFdUsable())('the temp name already taken (EEXIST): 400 "changed during the save", the other file untouched, no home copy', async () => {
    mkdirSync(join(h.home, 'config'));
    rnd.fixed = '00ff00ff00ff00ff';
    const taken = join(h.home, 'config', '.companion-claude.md.tmp-00ff00ff00ff00ff');
    writeFileSync(taken, 'THEIRS');
    const r = await put('X');
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('The frame path changed during the save');
    expect(readFileSync(taken, 'utf8')).toBe('THEIRS');
    expect(existsSync(homeCopy())).toBe(false);
  });

  it.runIf(procFdUsable())('a PUT whose write root is removed mid-walk (ENOENT): 400 "changed during the save", not a 500', async () => {
    setFrameStageHookForTest((at) => { if (at === 'boundary') rmSync(h.home, { recursive: true }); });
    try {
      const r = await put('X');
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('The frame path changed during the save');
    } finally { setFrameStageHookForTest(null); mkdirSync(h.home, { recursive: true }); }
  });

  it.runIf(procFdUsable())('a GET whose folder is removed mid-walk (ENOENT): 400 "changed during the read", not a 500', async () => {
    mkdirSync(join(h.home, 'config'));
    writeFileSync(homeCopy(), 'HOME');
    setFrameStageHookForTest((at) => { if (at === 'boundary') rmSync(join(h.home, 'config'), { recursive: true }); });
    const r = await get();
    setFrameStageHookForTest(null);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('The frame path changed during the read');
  });

  it.runIf(procFdUsable())('a save that fails after it made the missing folder takes that folder away again (one folder, then two nested)', async () => {
    expect(existsSync(join(h.home, 'config'))).toBe(false);
    failWrites.on = true;
    expect((await put('A NEW FRAME, '.repeat(6000))).status).toBe(500);
    failWrites.on = false; failWrites.calls = 0;
    expect(existsSync(join(h.home, 'config'))).toBe(false);
    h.configured = join(h.home, 'a', 'b', 'frame.md');
    failWrites.on = true;
    expect((await put('A NEW FRAME, '.repeat(6000))).status).toBe(500);
    expect(existsSync(join(h.home, 'a'))).toBe(false);
    // (the control: the same save, with the disk not full, keeps its folders)
    failWrites.on = false; failWrites.calls = 0;
    expect((await put('KEPT')).status).toBe(200);
    expect(readFileSync(join(h.home, 'a', 'b', 'frame.md'), 'utf8')).toBe('KEPT');
    rmSync(join(h.home, 'a'), { recursive: true });
  });
});

describe('GET never reads through a link or opens a pipe (single-tenant)', () => {
  it('a home copy that is a link to a file elsewhere: 400, and the link target\'s bytes are nowhere in the response', async () => {
    const secret = join(h.outside, 'secret.md');
    writeFileSync(secret, 'SECRET-BYTES-OF-THE-LINK-TARGET');
    mkdirSync(join(h.home, 'config'));
    symlinkSync(secret, homeCopy());
    const r = await fetch(`${base}/prompts/system`);
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(text).not.toContain('SECRET-BYTES');
    expect(text).toContain('link');
    rmSync(secret);
  });

  it('a configured frame that is a link: 400, no bytes', async () => {
    const secret = join(h.outside, 'secret2.md');
    const custom = join(h.home, 'frame.md');
    writeFileSync(secret, 'SECRET-BYTES-OF-THE-LINK-TARGET');
    symlinkSync(secret, custom);
    h.configured = custom;
    const r = await fetch(`${base}/prompts/system`);
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain('SECRET-BYTES');
    rmSync(custom);
  });

  it.runIf(posix)('a FIFO at the home copy: 400 promptly (the server is not left waiting for a writer)', async () => {
    mkdirSync(join(h.home, 'config'));
    execFileSync('mkfifo', [homeCopy()]);
    try {
      const r = await fetch(`${base}/prompts/system`, { signal: AbortSignal.timeout(3000) });
      expect(r.status).toBe(400);
      expect((await r.json() as any).error).toContain('not a regular file');
    } finally { rmSync(homeCopy(), { force: true }); }
  }, 8000);

  it.runIf(posix)('a home copy hard-linked to a file elsewhere: 400, and that file\'s bytes are nowhere in the response', async () => {
    const secret = join(h.outside, 'secret-hl.md');
    writeFileSync(secret, 'SECRET-BYTES-OF-THE-HARD-LINK');
    mkdirSync(join(h.home, 'config'));
    linkSync(secret, homeCopy());
    const r = await fetch(`${base}/prompts/system`);
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(text).not.toContain('SECRET-BYTES');
    expect(text).toContain('more than one hard link');
    rmSync(secret);
  });

  it('<home>/config is a link to a folder elsewhere holding a companion-claude.md: 400, none of its bytes', async () => {
    mkdirSync(join(h.outside, 'cfg'));
    writeFileSync(join(h.outside, 'cfg', 'companion-claude.md'), 'SECRET-BYTES-BEHIND-THE-FOLDER-LINK');
    symlinkSync(join(h.outside, 'cfg'), join(h.home, 'config'));
    const r = await fetch(`${base}/prompts/system`);
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(text).not.toContain('SECRET-BYTES');
    expect(text).toContain('config is a link');
    rmSync(join(h.home, 'config'));
    rmSync(join(h.outside, 'cfg'), { recursive: true });
  });

  it('a configured frame behind a folder link inside the write roots: 400, no bytes', async () => {
    writeFileSync(join(h.outside, 'secret3.md'), 'SECRET-BYTES-BEHIND-A-LINK');
    symlinkSync(h.outside, join(h.home, 'd'));
    h.configured = join(h.home, 'd', 'secret3.md');
    const r = await fetch(`${base}/prompts/system`);
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain('SECRET-BYTES');
    rmSync(join(h.home, 'd'));
  });

  it.runIf(posix)('a FIFO as the configured frame (no home copy): 400 promptly', async () => {
    const fifo = join(h.home, 'frame.fifo');
    execFileSync('mkfifo', [fifo]);
    h.configured = fifo;
    try {
      const r = await fetch(`${base}/prompts/system`, { signal: AbortSignal.timeout(3000) });
      expect(r.status).toBe(400);
      expect((await r.json() as any).error).toContain('not a regular file');
    } finally { rmSync(fifo, { force: true }); }
  }, 8000);

  it.runIf(procFdUsable())('a GET while <home>/config is swapped for a link to an outside folder once the walk has started: 400 or the real copy, never the outside bytes', async () => {
    mkdirSync(join(h.home, 'config'));
    writeFileSync(homeCopy(), 'REAL HOME COPY');
    mkdirSync(join(h.outside, 'cfg2'));
    writeFileSync(join(h.outside, 'cfg2', 'companion-claude.md'), 'SECRET-BYTES-SWAPPED-IN');
    for (const stage of stages) {
      setFrameStageHookForTest((at) => { if (at === stage) swapForLink(join(h.home, 'config'), join(h.outside, 'cfg2')); });
      const r = await fetch(`${base}/prompts/system`);
      const text = await r.text();
      setFrameStageHookForTest(null);
      swapBack(join(h.home, 'config'));
      expect(text).not.toContain('SECRET-BYTES');
      if (stage === 'boundary') expect(r.status).toBe(400);
      else expect(JSON.parse(text).content).toBe('REAL HOME COPY'); // (the held folder is the real one, wherever it was moved to)
    }
    rmSync(join(h.outside, 'cfg2'), { recursive: true });
  });

  it('a plain home copy is still read (the control)', async () => {
    mkdirSync(join(h.home, 'config'));
    writeFileSync(homeCopy(), 'PLAIN HOME FRAME');
    expect((await get()).json.content).toBe('PLAIN HOME FRAME');
  });
});
