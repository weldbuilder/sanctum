// GET/PUT /api/prompts/system: the Claude frame editor. It shows the frame the agent would use (services/frame-file.ts: the home copy, else the
// configured file) and saves to the home copy, or to a custom frame inside the write roots. It never writes into the app's prompts/ folder.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => ({ top: '', home: '', outside: '', configured: '', writeRoots: [] as string[] }));
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
      agent: { cwd: h.home, system_prompt_file: h.configured },
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
    expect(r.json).toMatchObject({ configured: true, source: 'home', content: 'HOME FRAME', path: homeCopy() });
  });

  it('a custom frame inside the write roots is read, and saved, in place', async () => {
    const custom = join(h.home, 'frame.md');
    writeFileSync(custom, 'CUSTOM FRAME');
    h.configured = custom;
    const r = await get();
    expect(r.json).toMatchObject({ source: 'configured', content: 'CUSTOM FRAME', path: custom });
    rmSync(custom);
  });

  it('a configured file outside the write roots is shown as the starting text and saved to the home copy', async () => {
    const elsewhere = join(h.outside, 'frame.md');
    writeFileSync(elsewhere, 'ELSEWHERE FRAME');
    h.configured = elsewhere;
    const r = await get();
    expect(r.json).toMatchObject({ source: 'configured', content: 'ELSEWHERE FRAME', path: homeCopy() });
  });

  it('a configured file that does not exist yet: source "none", empty text, the save target named', async () => {
    h.configured = join(h.home, 'frame.md');
    const r = await get();
    expect(r.json).toMatchObject({ configured: true, source: 'none', content: '', path: join(h.home, 'frame.md') });
  });

  it('an empty key and no home copy: not configured, nothing to save to', async () => {
    h.configured = '';
    const r = await get();
    expect(r.json).toMatchObject({ configured: false, source: 'none', content: '', path: '' });
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

  it('refuses a body without a string content', async () => {
    expect((await put(5)).status).toBe(400);
    expect(existsSync(homeCopy())).toBe(false);
  });
});
