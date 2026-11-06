import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock embeddings / vector cache so createMessage never loads the ML model.
vi.mock('./embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));
vi.mock('./vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('./auth-preferences.js', () => ({ applyAuthToEnv: vi.fn() }));

// The summarizer's Claude side-run: answers with one block naming the prompt's date, or throws. The real runSummary runs
// around it (provider and model selection, the short identity in the system slot), so what reaches the harness is asserted as it is.
let scribe: (prompt: string) => string;
let models: Record<string, unknown> = { model: 'claude-m', model_autonomous: '' };
let lastRun: { system: string; user: string; model: string } | undefined;
vi.mock('./summarizer/claude.js', () => ({
  runClaudeSummary: async (o: { system: string; user: string; model: string }) => {
    lastRun = o;
    return scribe(o.user);
  },
}));

let dir: string;
vi.mock('../config.js', async (importOriginal) => ({
  activeProviderName: () => 'claude',
  getSanctumConfig: () => ({
    agent: models,
    identity: { companion_name: 'Echo', user_name: 'Alex', timezone: 'UTC' },
    server: { db_path: join(dir, 'sanctum.db') },
    hooks: { context_injection: false, safe_write_prefixes: [] },
  }),
  PROJECT_ROOT: (await importOriginal<typeof import('../config.js')>()).PROJECT_ROOT,
}));

import { initDb, createThread, createMessage, getConfig, dailyThreadIdFor } from './db.js';
import { runDigest, buildScribePrompt } from './digest.js';

const agent = { isProcessing: () => false } as any;
const todayId = () => dailyThreadIdFor();
const yesterdayId = () => dailyThreadIdFor(new Date(Date.now() - 86_400_000));
const dateOf = (id: string) => id.replace(/^daily-/, '');

function mkThread(id: string) {
  return createThread({ id, name: id, type: 'daily', createdAt: new Date().toISOString() });
}
function say(threadId: string, n: number) {
  for (let i = 0; i < n; i++) {
    createMessage({
      id: `${threadId}-${Math.random().toString(36).slice(2, 8)}`,
      threadId,
      role: i % 2 ? 'companion' : 'user',
      content: 'short',
      createdAt: new Date().toISOString(),
    });
  }
}
const digestFile = (date: string) => join(dir, 'digests', `${date}.md`);
const blocksIn = (date: string) => (readFileSync(digestFile(date), 'utf-8').match(/^## /gm) || []).length;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scribe-'));
  initDb(':memory:');
  models = { model: 'claude-m', model_autonomous: '' }; lastRun = undefined;
  scribe =(prompt) => `## 12:00 — block (${/Today is (\S+)\./.exec(prompt)?.[1]})`;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Scribe digest on the summarizer', () => {
  it('runs on the summarizer model: agent.summarizer.model when set, else the chat model; the digest picks none of its own', async () => {
    mkThread(todayId());
    say(todayId(), 6);
    models = { model: 'claude-x', model_autonomous: 'claude-y' };
    await runDigest(agent);
    expect(lastRun?.model).toBe('claude-y'); // the summarizer's default is the chat tier (model_autonomous, else model)
    say(todayId(), 6);
    models = { model: 'claude-x', model_autonomous: '', summarizer: { model: 'claude-z' } };
    await runDigest(agent);
    expect(lastRun?.model).toBe('claude-z');
    say(todayId(), 6);
    models = { model: 'claude-x', model_autonomous: '' };
    await runDigest(agent);
    expect(lastRun?.model).toBe('claude-x');
  });

  it('puts the short identity and the daily digest section in the system slot and the conversation in the user slot', async () => {
    mkThread(todayId());
    say(todayId(), 6);
    await runDigest(agent);
    expect(lastRun!.system).toContain('## Who you are (short)');
    expect(lastRun!.system).toContain('You are Echo');
    expect(lastRun!.system).toContain('## Daily digest');
    expect(lastRun!.system).toContain('## Voice');
    expect(lastRun!.system).toContain('## Format');
    expect(lastRun!.system).not.toContain('## Rolling fold'); // only this kind's section
    expect(lastRun!.user).toContain('<conversation>');
    expect(lastRun!.user).toContain('short'); // the messages
    expect(lastRun!.user).toContain(`Today is ${dateOf(todayId())}.`);
  });

  it('writes the first-person block the summarizer returns, under the dated file header', async () => {
    mkThread(todayId());
    say(todayId(), 6);
    scribe = () => '## 12:00 — a quiet start\n\n### What happened\nI helped Alex plan the week.';
    await runDigest(agent);
    const text = readFileSync(digestFile(dateOf(todayId())), 'utf-8');
    expect(text.startsWith(`# Daily Digest — ${dateOf(todayId())}\n\n## 12:00 — a quiet start`)).toBe(true);
    expect(text).toContain('I helped Alex plan the week.');
  });

  it('the built digest prompt has no third-person phrase of the old Scribe', () => {
    const p = buildScribePrompt();
    for (const phrase of ['the assistant', 'the user', 'the person', 'You are not', 'You are the Scribe', 'Third person, present tense', 'historian', 'a careful witness']) {
      expect(p.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
    expect(p).toContain('You are Echo');
    expect(p).toContain('Alex');
  });
});

describe('Scribe digest bookmark', () => {
  it('digests today and records a thread-aware bookmark', async () => {
    mkThread(todayId());
    say(todayId(), 6);
    await runDigest(agent);
    expect(existsSync(digestFile(dateOf(todayId())))).toBe(true);
    expect(getConfig('digest.last_thread_id')).toBe(todayId());
    expect(getConfig('digest.last_sequence')).toBe('6');
  });

  it('does not let yesterday\'s sequence hide today\'s messages', async () => {
    // The old bug: one global sequence bookmark. Yesterday reached seq 20; today's
    // 6 messages (seq 1–6) were filtered out as "already digested".
    mkThread(yesterdayId());
    mkThread(todayId());
    say(yesterdayId(), 20);
    await runDigest(agent); // today's thread has nothing yet; bookmark lands on today
    // Simulate the state the old code left behind at midnight.
    const { setConfig } = await import('./db.js');
    setConfig('digest.last_thread_id', yesterdayId());
    setConfig('digest.last_sequence', '20');
    say(todayId(), 6);
    await runDigest(agent);
    expect(existsSync(digestFile(dateOf(todayId())))).toBe(true);
    expect(getConfig('digest.last_thread_id')).toBe(todayId());
    expect(getConfig('digest.last_sequence')).toBe('6');
  });

  it('flushes yesterday\'s undigested tail into yesterday\'s file at rollover', async () => {
    mkThread(yesterdayId());
    mkThread(todayId());
    say(yesterdayId(), 8);
    const { setConfig } = await import('./db.js');
    // Last tick of yesterday digested up to seq 6; two more came after 23:30.
    setConfig('digest.last_thread_id', yesterdayId());
    setConfig('digest.last_sequence', '6');
    say(todayId(), 2); // below MIN_MESSAGES: today is skipped, but the tail still flushes
    await runDigest(agent);
    const y = dateOf(yesterdayId());
    expect(existsSync(digestFile(y))).toBe(true);
    expect(readFileSync(digestFile(y), 'utf-8')).toContain(`block (${y})`);
    expect(existsSync(digestFile(dateOf(todayId())))).toBe(false);
    expect(getConfig('digest.last_thread_id')).toBe(todayId());
    expect(getConfig('digest.last_sequence')).toBe('0');
  });

  it('keeps the old bookmark and retries when the rollover flush fails', async () => {
    mkThread(yesterdayId());
    mkThread(todayId());
    say(yesterdayId(), 3);
    const { setConfig } = await import('./db.js');
    setConfig('digest.last_thread_id', yesterdayId());
    setConfig('digest.last_sequence', '1');
    say(todayId(), 6);
    scribe = () => { throw new Error('API down'); };
    await runDigest(agent);
    expect(getConfig('digest.last_thread_id')).toBe(yesterdayId());
    expect(getConfig('digest.last_sequence')).toBe('1');
    expect(existsSync(digestFile(dateOf(todayId())))).toBe(false);
    scribe = (prompt) => `## 12:00 — block (${/Today is (\S+)\./.exec(prompt)?.[1]})`;
    await runDigest(agent);
    expect(blocksIn(dateOf(yesterdayId()))).toBe(1);
    expect(blocksIn(dateOf(todayId()))).toBe(1);
    expect(getConfig('digest.last_thread_id')).toBe(todayId());
    expect(getConfig('digest.last_sequence')).toBe('6');
  });
});
