import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UPDATE_REFUSED_NOTICE, messagesPaused, mergeRefused, showVersionPill } from './update';

// While an update installs the server refuses a message (error code update_running). The composer must not lose what the person typed:
// the store hands the refused text (and attachments) back, with the one-line notice; and the composer itself does not send while the job is installing,
// building or restarting.

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static last: FakeSocket;
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.last = this; }
  send(s: string) { this.sent.push(s); }
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost' } });
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a message the server refused during an update', () => {
  it('comes back as refusedDraft with the notice, text and attachments intact', async () => {
    vi.resetModules();
    const { useChatStore } = await import('./chat');
    useChatStore.getState().connect();
    const att = { fileId: 'f1', filename: 'a.png', contentType: 'image' as const, url: '/api/files/f1' };
    useChatStore.getState().send({ type: 'message', threadId: 't1', content: 'half a long thought', contentType: 'text', metadata: { attachments: [att] } } as never);
    FakeSocket.last.onmessage!({ data: JSON.stringify({ type: 'error', code: 'update_running', message: 'An update is being installed, so new messages are paused for a minute or two.' }) });
    const s = useChatStore.getState();
    expect(s.refusedDraft).toEqual({ content: 'half a long thought', attachments: [att] });
    expect(s.lastError).toEqual({ code: 'update_running', message: UPDATE_REFUSED_NOTICE });
    s.clearRefusedDraft();
    expect(useChatStore.getState().refusedDraft).toBeNull();
  });

  it('other errors do not touch the draft', async () => {
    vi.resetModules();
    const { useChatStore } = await import('./chat');
    useChatStore.getState().connect();
    FakeSocket.last.onmessage!({ data: JSON.stringify({ type: 'error', code: 'boom', message: 'nope' }) });
    expect(useChatStore.getState().refusedDraft).toBeNull();
    expect(useChatStore.getState().lastError).toEqual({ code: 'boom', message: 'nope' });
  });
});

describe('messagesPaused', () => {
  const job = (state: string) => ({ state }) as never;
  it('is true while installing, building or restarting, false otherwise', () => {
    for (const s of ['installing', 'building', 'restarting']) expect(messagesPaused(job(s))).toBe(true);
    for (const s of ['checking', 'fetching', 'done', 'failed', 'rolled_back']) expect(messagesPaused(job(s))).toBe(false);
    expect(messagesPaused(null)).toBe(false);
  });
  it('the notice is the one the person reads', () => { expect(UPDATE_REFUSED_NOTICE).toBe('Updating; your message was not sent.'); });
});

describe('the race: send, type the next draft, then the refusal arrives', () => {
  it('keeps the refused message in the store and merges it with the new draft, all attachments kept', async () => {
    vi.resetModules();
    const { useChatStore } = await import('./chat');
    useChatStore.getState().connect();
    const a1 = { fileId: 'f1', filename: 'a.png', contentType: 'image' as const, url: '/api/files/f1' };
    const a2 = { fileId: 'f2', filename: 'b.png', contentType: 'image' as const, url: '/api/files/f2' };
    useChatStore.getState().send({ type: 'message', threadId: 't1', content: 'first message', contentType: 'text', metadata: { attachments: [a1] } } as never);
    FakeSocket.last.onmessage!({ data: JSON.stringify({ type: 'error', code: 'update_running', message: 'x' }) });
    const refused = useChatStore.getState().refusedDraft!;
    expect(refused.content).toBe('first message');
    // the composer had "second draft" + a2 in the box when the refusal landed
    const merged = mergeRefused({ text: 'second draft', attachments: [a2] }, refused);
    expect(merged.text).toBe('first message\n\nsecond draft');
    expect(merged.attachments.map(a => a.fileId)).toEqual(['f1', 'f2']);
  });
  it('an empty box simply gets the refused text; duplicate attachments are not doubled', () => {
    const a = { fileId: 'f1' };
    expect(mergeRefused({ text: '  ', attachments: [] }, { content: 'x', attachments: [a] })).toEqual({ text: 'x', attachments: [a] });
    expect(mergeRefused({ text: 'y', attachments: [a] }, { content: 'x', attachments: [a] }).attachments).toHaveLength(1);
  });
});

describe('showVersionPill', () => {
  const base = { updateBuildId: null, onBarRoute: false, unavailable: false, hasNewVersion: true };
  it('shows off the bar routes, hides on them while the bar can show', () => {
    expect(showVersionPill(base)).toBe(true);
    expect(showVersionPill({ ...base, onBarRoute: true })).toBe(false);
  });
  it('shows on Home and Chat when the house snapshot is unavailable (per-tenant hosts)', () => {
    expect(showVersionPill({ ...base, onBarRoute: true, unavailable: true })).toBe(true);
  });
  it('never shows without a newer version or while a rebuild pill is up', () => {
    expect(showVersionPill({ ...base, hasNewVersion: false, unavailable: true })).toBe(false);
    expect(showVersionPill({ ...base, updateBuildId: 'abc', unavailable: true })).toBe(false);
  });
});
