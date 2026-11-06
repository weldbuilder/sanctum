// The daily handoff through the summarizer: the real runSummary runs around a stubbed Claude side-run, so what is asserted is what
// reaches the harness (the short identity and the handoff section in the system slot, yesterday's facts in the user slot) and what the
// handoff stores and posts from the JSON the companion returns.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('./embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));
vi.mock('./vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('./auth-preferences.js', () => ({ applyAuthToEnv: vi.fn() }));
vi.mock('./agent.js', () => ({ isInteractiveAgentBusy: () => false }));
vi.mock('./ws.js', () => ({ registry: { broadcast: vi.fn() } }));

let reply: string;
let models: Record<string, unknown> = { model: 'claude-m', model_autonomous: '' };
let lastRun: { system: string; user: string; model: string } | undefined;
let calls = 0;
vi.mock('./summarizer/claude.js', () => ({
  runClaudeSummary: async (o: { system: string; user: string; model: string }) => { lastRun = o; calls++; return reply; },
}));

let dir: string;
vi.mock('../config.js', async (importOriginal) => ({
  activeProviderName: () => 'claude',
  getSanctumConfig: () => ({
    agent: models,
    identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'Europe/London' },
    server: { db_path: join(dir, 'sanctum.db') },
    hooks: { context_injection: false, safe_write_prefixes: [] },
  }),
  PROJECT_ROOT: (await importOriginal<typeof import('../config.js')>()).PROJECT_ROOT,
}));

import { initDb, createThread, createMessage, getConfig, setConfig } from './db.js';
import { runHandoff, buildHandoffSystemPrompt, getTodayCarryDated, carryLine } from './handoff.js';

const NOW = new Date('2026-11-06T00:10:00Z'); // 12:10am London; yesterday is 2026-11-05
const YESTERDAY = '2026-11-05';
const TODAY = '2026-11-06';

function seedYesterday(withDigest = true) {
  createThread({ id: `daily-${YESTERDAY}`, name: YESTERDAY, type: 'daily', createdAt: '2026-11-05T09:00:00Z' });
  createMessage({ id: 'm1', threadId: `daily-${YESTERDAY}`, role: 'user', content: 'I finally booked the dentist.', createdAt: '2026-11-05T09:01:00Z' });
  createMessage({ id: 'm2', threadId: `daily-${YESTERDAY}`, role: 'companion', content: 'Good. I will remind you on Monday.', createdAt: '2026-11-05T09:02:00Z' });
  if (withDigest) {
    mkdirSync(join(dir, 'digests'), { recursive: true });
    writeFileSync(join(dir, 'digests', `${YESTERDAY}.md`), `# Daily Digest — ${YESTERDAY}\n\n## 09:00 — dentist\n\nI helped Sam book the dentist.\n`);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'handoff-'));
  initDb(':memory:');
  models = { model: 'claude-m', model_autonomous: '' };
  lastRun = undefined; calls = 0;
  reply = JSON.stringify({ opener: 'Morning, Sam. Yesterday we booked the dentist, and I am still holding you to Monday.', carry: `${YESTERDAY}: you booked the dentist; I said I would remind you Monday.` });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const PHRASES = ['the assistant', 'the user', 'the person', 'You are not', 'Scribe'];

describe('daily handoff on the summarizer', () => {
  it('system slot: the short identity, the voice and the daily handoff section, then the JSON format; user slot: the facts', async () => {
    seedYesterday();
    const out = await runHandoff(NOW);
    expect(out.ran).toBe(true);
    expect(lastRun!.system).toContain('## Who you are (short)');
    expect(lastRun!.system).toContain('## Voice');
    expect(lastRun!.system).toContain('## Daily handoff');
    expect(lastRun!.system).not.toContain('## Daily digest');
    expect(lastRun!.system).toContain('"opener"');
    expect(lastRun!.system).toContain('"carry"');
    expect(lastRun!.user).toContain('I finally booked the dentist.');
    expect(lastRun!.user).toContain('Sam: I finally booked the dentist.');
    expect(lastRun!.user).toContain('Echo: Good. I will remind you on Monday.');
    // the digest is quoted as the companion's own
    expect(lastRun!.user).toContain('## Your digest for yesterday');
    expect(lastRun!.user).toContain('I helped Sam book the dentist.');
    expect(lastRun!.user).not.toContain("The Scribe's digest");
    expect(lastRun!.model).toBe('claude-m'); // the summarizer's choice, not a handoff constant
  });

  it('posts the opener into today\'s daily and stores the carry with the date it is for and the date it carries from', async () => {
    seedYesterday();
    const out = await runHandoff(NOW);
    expect(out.opener).toContain('Yesterday we booked the dentist');
    expect(out.postedToThreadId).toBe(`daily-${TODAY}`);
    const stored = JSON.parse(getConfig('handoff_carry')!);
    expect(stored).toMatchObject({ date: TODAY, from: YESTERDAY });
    expect(stored.carry).toContain('you booked the dentist');
  });

  it('runs on agent.summarizer.model when it is set', async () => {
    seedYesterday();
    models = { model: 'claude-m', model_autonomous: '', summarizer: { model: 'claude-s' } };
    await runHandoff(NOW);
    expect(lastRun!.model).toBe('claude-s');
  });

  it('does not call the model when yesterday holds nothing', async () => {
    const out = await runHandoff(NOW);
    expect(out).toMatchObject({ ran: false, reason: 'no_yesterday_daily' });
    expect(calls).toBe(0);
  });

  it('the built handoff prompt has no third-person phrase of the old prompts', () => {
    const p = buildHandoffSystemPrompt();
    for (const phrase of PHRASES) expect(p.toLowerCase()).not.toContain(phrase.toLowerCase());
    expect(p).toContain('You are Echo');
    expect(p).toContain('Sam');
  });
});

describe('handoff JSON tolerance', () => {
  it.each([
    ['a fenced block', (j: string) => '```json\n' + j + '\n```'],
    ['a bare fence', (j: string) => '```\n' + j + '\n```'],
    ['prose before and after', (j: string) => 'Here is the handoff:\n' + j + '\nThat is all.'],
    ['surrounding whitespace', (j: string) => '\n\n  ' + j + '  \n'],
  ])('reads the object from %s', async (_name, wrap) => {
    seedYesterday();
    reply = wrap(JSON.stringify({ opener: 'Morning, Sam.', carry: `${YESTERDAY}: a quiet day.` }));
    const out = await runHandoff(NOW);
    expect(out.ran).toBe(true);
    expect(out.opener).toBe('Morning, Sam.');
    expect(out.carry).toBe(`${YESTERDAY}: a quiet day.`);
  });

  it('a missing field degrades to empty: an opener alone posts and stores no carry', async () => {
    seedYesterday();
    reply = JSON.stringify({ opener: 'Morning, Sam.' });
    const out = await runHandoff(NOW);
    expect(out.ran).toBe(true);
    expect(out.carry).toBeUndefined();
    expect(getConfig('handoff_carry')).toBeFalsy();
  });

  it('unparseable output carries nothing and does not throw', async () => {
    seedYesterday();
    reply = 'I could not manage that today.';
    const out = await runHandoff(NOW);
    expect(out).toMatchObject({ ran: false, reason: 'author_failed' });
    expect(getConfig('handoff_carry')).toBeFalsy();
    expect(calls).toBe(1); // the handoff never retried, and still does not
  });

  it('both fields empty is the author judging there is nothing to carry', async () => {
    seedYesterday();
    reply = JSON.stringify({ opener: '', carry: '' });
    expect(await runHandoff(NOW)).toMatchObject({ ran: false, reason: 'nothing_to_carry' });
  });
});

describe('the carry line', () => {
  const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const dayBefore = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

  it('reads "You carried from yesterday (DATE):" with the day it carries from', () => {
    setConfig('handoff_carry', JSON.stringify({ date: todayLocal(), from: '2026-11-05', carry: 'I owe Sam a call.' }));
    const c = getTodayCarryDated()!;
    expect(carryLine(c)).toBe('**You carried from yesterday (2026-11-05):** I owe Sam a call.');
  });

  it('a row from before the date was stored carries from the day before it is for', () => {
    setConfig('handoff_carry', JSON.stringify({ date: todayLocal(), carry: 'Older row.' }));
    expect(carryLine(getTodayCarryDated()!)).toBe(`**You carried from yesterday (${dayBefore(todayLocal())}):** Older row.`);
  });

  it('is absent for another day', () => {
    setConfig('handoff_carry', JSON.stringify({ date: '2020-01-01', from: '2019-12-31', carry: 'Old.' }));
    expect(getTodayCarryDated()).toBeNull();
  });

  it('the orientation hook uses carryLine', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('./hooks.ts', import.meta.url), 'utf8');
    expect(src).toContain('parts.push(carryLine(carry))');
  });
});
