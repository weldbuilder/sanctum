import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The store drips the cumulative stream_token text onto the screen a few characters a frame. When the server seals
// pre-tool narration into the Thinking disclosure it sends token '' and then the post-tool reply; what is on screen
// must follow that restart instead of keeping the narration.

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static last: FakeSocket;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.last = this; }
  send() {}
  close() {}
}

let frames: Array<() => void> = [];
const runFrames = (limit = 5000) => {
  for (let i = 0; i < limit && frames.length; i++) { const f = frames.shift()!; f(); }
};

async function openStream() {
  vi.resetModules();
  const { useChatStore } = await import('./chat');
  useChatStore.setState({ activeThreadId: 't1' });
  useChatStore.getState().connect();
  const send = (m: object) => FakeSocket.last.onmessage!({ data: JSON.stringify(m) });
  send({ type: 'stream_start', messageId: 'm1', threadId: 't1' });
  return { useChatStore, send };
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost' } });
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the displayed reply when pre-tool narration is sealed', () => {
  it('shows a reply that is shorter than the narration it follows', async () => {
    const { useChatStore, send } = await openStream();
    const narration = 'Let me look through the notes folder and the calendar before I answer you.';
    send({ type: 'stream_token', messageId: 'm1', token: narration });
    runFrames();
    expect(useChatStore.getState().displayedTokens).toBe(narration);

    send({ type: 'stream_token', messageId: 'm1', token: '' });
    expect(useChatStore.getState().displayedTokens).toBe('');

    send({ type: 'stream_token', messageId: 'm1', token: 'Found it.' });
    runFrames();
    expect(useChatStore.getState().displayedTokens).toBe('Found it.');
  });

  it('shows a longer reply from its first character, not appended to the narration', async () => {
    const { useChatStore, send } = await openStream();
    send({ type: 'stream_token', messageId: 'm1', token: 'Looking at the notes now.' });
    runFrames();

    send({ type: 'stream_token', messageId: 'm1', token: '' });
    send({ type: 'stream_token', messageId: 'm1', token: 'Found three notes due this week, and one is already late.' });
    runFrames();
    expect(useChatStore.getState().displayedTokens).toBe('Found three notes due this week, and one is already late.');
  });

  it('shows the whole of a reply that opens with the same words as the narration', async () => {
    const { useChatStore, send } = await openStream();
    const narration = 'Let me check';
    send({ type: 'stream_token', messageId: 'm1', token: narration });
    runFrames();
    expect(useChatStore.getState().displayedTokens).toBe(narration);

    send({ type: 'stream_token', messageId: 'm1', token: '' });
    send({ type: 'stream_token', messageId: 'm1', token: 'Let me check the notes: three are due this week.' });
    runFrames();
    expect(useChatStore.getState().displayedTokens).toBe('Let me check the notes: three are due this week.');
  });

  it('still reveals an ordinary growing reply without resetting', async () => {
    const { useChatStore, send } = await openStream();
    send({ type: 'stream_token', messageId: 'm1', token: 'Hello' });
    runFrames();
    send({ type: 'stream_token', messageId: 'm1', token: 'Hello there, Sam.' });
    runFrames();
    expect(useChatStore.getState().displayedTokens).toBe('Hello there, Sam.');
  });
});
