// The house outlook author through the summarizer: the real runSummary runs around a stubbed Claude side-run.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('./embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));
vi.mock('./vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('./auth-preferences.js', () => ({ applyAuthToEnv: vi.fn() }));
vi.mock('./agent.js', () => ({ isInteractiveAgentBusy: () => false }));

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
    identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' },
    server: { db_path: join(dir, 'sanctum.db') },
    hooks: { context_injection: false, safe_write_prefixes: [] },
  }),
  PROJECT_ROOT: (await importOriginal<typeof import('../config.js')>()).PROJECT_ROOT,
}));

import { initDb, createThread, createMessage, getConfig } from './db.js';
import { authorOutlook, buildAuthorSystemPrompt } from './outlook-author.js';

const GOOD = {
  presence: { mood: 'settled', thoughts: 'I keep thinking about the garden plan.', artifacts: [{ title: 'Garden sketch', why: 'it is the plan for spring' }], needsUser: 'Tell me which bed first.' },
  topics: [{ topic: 'Garden', note: 'we keep circling the beds', room: 'Daily' }],
  needsYou: [{ kind: 'decision', text: 'Pick the first bed.' }, { kind: 'bogus', text: 'See the sketch.' }],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outlook-'));
  initDb(':memory:');
  models = { model: 'claude-m', model_autonomous: '' };
  lastRun = undefined; calls = 0;
  reply = JSON.stringify(GOOD);
  const now = new Date().toISOString();
  createThread({ id: 'daily-x', name: 'Today', type: 'daily', createdAt: now });
  createMessage({ id: 'o1', threadId: 'daily-x', role: 'user', content: 'Let us plan the garden.', createdAt: now });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('house outlook author on the summarizer', () => {
  it('system slot: the short identity, the voice, the house outlook section and the JSON shape; user slot: the facts', async () => {
    expect(await authorOutlook()).toBe(true);
    expect(lastRun!.system).toContain('## Who you are (short)');
    expect(lastRun!.system).toContain('## Voice');
    expect(lastRun!.system).toContain('## House outlook');
    expect(lastRun!.system).not.toContain('## Daily handoff');
    for (const key of ['"presence"', '"topics"', '"needsYou"', '"needsUser"']) expect(lastRun!.system).toContain(key);
    expect(lastRun!.user).toContain('Sam: Let us plan the garden.');
    expect(lastRun!.user).toContain('FACTS');
    expect(lastRun!.model).toBe('claude-m');
  });

  it('stores the three KV rows from the JSON the companion returns', async () => {
    expect(await authorOutlook()).toBe(true);
    const presence = JSON.parse(getConfig('outlook_presence')!);
    expect(presence).toMatchObject({ mood: 'settled', thoughts: 'I keep thinking about the garden plan.', needsUser: 'Tell me which bed first.' });
    expect(presence.artifacts).toEqual([{ title: 'Garden sketch', why: 'it is the plan for spring' }]);
    expect(JSON.parse(getConfig('outlook_topics')!)).toEqual([{ topic: 'Garden', note: 'we keep circling the beds', room: 'Daily' }]);
    expect(JSON.parse(getConfig('outlook_needsYou')!)).toEqual([{ kind: 'decision', text: 'Pick the first bed.' }, { kind: 'notice', text: 'See the sketch.' }]);
  });

  it('runs on agent.summarizer.model when it is set', async () => {
    models = { model: 'claude-m', model_autonomous: '', summarizer: { model: 'claude-s' } };
    await authorOutlook();
    expect(lastRun!.model).toBe('claude-s');
  });

  it.each([
    ['a fenced block', (j: string) => '```json\n' + j + '\n```'],
    ['prose around it', (j: string) => 'Here you go:\n' + j + '\nDone.'],
  ])('reads the object from %s', async (_n, wrap) => {
    reply = wrap(JSON.stringify(GOOD));
    expect(await authorOutlook()).toBe(true);
    expect(JSON.parse(getConfig('outlook_presence')!).mood).toBe('settled');
  });

  it('unparseable or empty output stores nothing and does not throw', async () => {
    reply = 'nothing to say';
    expect(await authorOutlook()).toBe(false);
    reply = '   ';
    expect(await authorOutlook()).toBe(false);
    expect(getConfig('outlook_presence')).toBeFalsy();
    expect(calls).toBe(2);
  });

  it('the built author prompt has no third-person phrase of the old prompt', () => {
    const p = buildAuthorSystemPrompt();
    for (const phrase of ['the assistant', 'the user', 'the person', 'You are not', 'NOT a reporter or a summarizer']) {
      expect(p.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
    expect(p).toContain('You are Echo');
    expect(p).toContain('Sam');
  });
});
