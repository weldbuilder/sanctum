// GET/PUT /api/prompts/system: the Claude frame editor. It shows the frame the agent would use (services/frame-file.ts: the home copy, else the
// configured file) and saves to the home copy, or to a custom frame inside the write roots. It never writes into the app's prompts/ folder.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ top: '', home: '', cwd: '', outside: '', configured: '', writeRoots: [] as string[] }));
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
      hooks: { safe_write_prefixes: h.writeRoots, workspace_root: '', vault_path: '', extra_write_paths: [] },
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
  shipped = readFileSync(appFrame(), 'utf8');
});
afterEach(() => {
  delete process.env.AGENT_PROVIDER;
  h.cwd = '';
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

    it('a home copy hard-linked to the app file: refused, the app file byte-identical', async () => {
      mkdirSync(join(h.home, 'config'));
      linkSync(appFrame(), homeCopy());
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
