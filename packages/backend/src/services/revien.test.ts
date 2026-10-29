import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let cfg: any;
vi.mock('../config.js', () => ({ getSanctumConfig: () => cfg }));
// Sanctum's own memory (local-recall.ts) has its own tests; here only which source answers is checked.
const local = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('./local-recall.js', () => ({ localRecall: async (...args: unknown[]) => { local.calls.push(args); return '- Oct 24, Sam: the lighthouse'; } }));

import { recallForPrompt, ingestTurn, _resetRevienWarning } from './revien.js';

const on = { enabled: true, url: 'http://127.0.0.1:7437', recall_limit: 6, timeout_ms: 2500 };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cfg = { revien: { ...on } };
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  _resetRevienWarning();
  local.calls = [];
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('revien plugin', () => {
  it('does nothing when disabled', async () => {
    cfg = { revien: { ...on, enabled: false } };
    expect(await recallForPrompt('hello')).toBe('');
    await ingestTurn({ threadId: 't', user: 'u', assistant: 'a' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty and does not throw when the daemon is unreachable, logging once (with the stand-in turned off)', async () => {
    cfg.agent = { local_recall: false };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await recallForPrompt('hello')).toBe('');
    expect(await recallForPrompt('again')).toBe('');
    await expect(ingestTurn({ threadId: 't', user: 'u', assistant: 'a' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // still retries each call
  });

  it('renders recalled memories one per line and sends the recall limit', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results: [
      { node_id: 'a', label: 'pet', content: 'She has a cat named Miso.', score: 0.9 },
      { node_id: 'b', label: 'only label', content: '', score: 0.5 },
      { node_id: 'c', content: 'multi\nline   text', score: 0.4 },
    ] }) });
    const out = await recallForPrompt('about pets');
    expect(out).toBe('- She has a cat named Miso.\n- only label\n- multi line text');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7437/v1/recall');
    expect(JSON.parse(init.body)).toEqual({ query: 'about pets', top_n: 6 });
  });

  it('returns empty for no results; a non-OK response is a Revien that is not working, so it counts as unreachable', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    expect(await recallForPrompt('q')).toBe('');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    expect(await recallForPrompt('q')).toBe('- Oct 24, Sam: the lighthouse'); // the stand-in
    cfg.agent = { local_recall: false };
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    expect(await recallForPrompt('q')).toBe('');
  });

  it('ingest posts USER/ASSISTANT content with a unique per-turn source_id', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await ingestTurn({ threadId: 'thr-1', user: 'hi there', assistant: 'hello!' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7437/v1/ingest');
    const body = JSON.parse(init.body);
    expect(body.content).toBe('USER: hi there\nASSISTANT: hello!');
    expect(body.source_id).toMatch(/^sanctum-mobile:thr-1:\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(body.content_type).toBe('conversation');
  });
});

describe("Sanctum's own memory, the bridge", () => {
  it('stands in when a chosen Revien cannot be reached, for the same message and thread, and the log says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await recallForPrompt('the lighthouse trip', 'daily-2026-10-26')).toBe('- Oct 24, Sam: the lighthouse');
    expect(local.calls[0]).toEqual(['the lighthouse trip', { threadId: 'daily-2026-10-26', limit: 6 }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("Sanctum's own memory of earlier conversations stands in");
  });

  it('a reachable Revien answers alone, even with nothing to recall', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    expect(await recallForPrompt('hello there', 't')).toBe('');
    expect(local.calls).toEqual([]);
  });

  it('is the memory when chosen (agent.local_recall: true, Revien off)', async () => {
    cfg = { revien: { ...on, enabled: false }, agent: { local_recall: true } };
    expect(await recallForPrompt('the lighthouse trip', 't1')).toBe('- Oct 24, Sam: the lighthouse');
    expect(local.calls[0]).toEqual(['the lighthouse trip', { threadId: 't1' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recalls nothing when no memory was chosen: Revien off and the switch unset or false', async () => {
    for (const agent of [undefined, { local_recall: false }, { harness_memory: true }]) {
      cfg = { revien: { ...on, enabled: false }, ...(agent ? { agent } : {}) };
      expect(await recallForPrompt('the lighthouse trip', 't')).toBe('');
    }
    expect(local.calls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
