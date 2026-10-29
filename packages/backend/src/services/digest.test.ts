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

// The Scribe model: answers with one block naming the prompt's date, or throws.
let scribe: (prompt: string) => string;
let models = { model: 'm', model_autonomous: '' };
let lastModel: string | undefined;
vi.mock('./providers/index.js', () => ({
  query: ({ prompt, options }: { prompt: string; options?: { model?: string } }) => (async function* () {
    lastModel = options?.model;
    const text = scribe(prompt);
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
  })(),
}));

let dir: string;
vi.mock('../config.js', async (importOriginal) => ({
  resolveAutonomousModel: (await importOriginal<typeof import('../config.js')>()).resolveAutonomousModel,
  getSanctumConfig: () => ({
    agent: models,
    identity: { companion_name: 'Echo', user_name: 'Alex', timezone: 'UTC' },
    server: { db_path: join(dir, 'sanctum.db') },
    hooks: { context_injection: false, safe_write_prefixes: [] },
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import { initDb, createThread, createMessage, getConfig, dailyThreadIdFor } from './db.js';
import { runDigest } from './digest.js';

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
  models = { model: 'm', model_autonomous: '' }; lastModel = undefined;
  scribe =(prompt) => `## 12:00 — block (${/Today is (\S+)\./.exec(prompt)?.[1]})`;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Scribe digest model', () => {
  it('runs on model_autonomous when set, else follows the chat model', async () => {
    mkThread(todayId());
    say(todayId(), 6);
    models = { model: 'x', model_autonomous: 'y' };
    await runDigest(agent);
    expect(lastModel).toBe('y');
    say(todayId(), 6);
    models = { model: 'x', model_autonomous: '' };
    await runDigest(agent);
    expect(lastModel).toBe('x');
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
