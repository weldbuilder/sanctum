// A message that reaches Discord or Telegram while an in-app update is installing gets one line ("Updating, back in a minute.") per channel, and nothing
// else: it is not processed and not queued. Exercised at the entry of each channel's message handler.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UPDATING_REPLY, _resetUpdateBlock, setUpdateBlocking } from './update-block.js';

const sent = vi.hoisted(() => ({ calls: [] as Array<{ target: any; payload: any; lane: string }> }));
vi.mock('./discord/send.js', async (orig) => ({ ...(await orig<typeof import('./discord/send.js')>()), sendGated: async (target: any, payload: any, lane: string) => { sent.calls.push({ target, payload, lane }); return { sent: true }; } }));
vi.mock('./telegram/config.js', async (orig) => ({ ...(await orig<typeof import('./telegram/config.js')>()), getTelegramConfig: () => ({ ownerChatId: '42' }) }));

beforeEach(() => { _resetUpdateBlock(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { _resetUpdateBlock(); vi.restoreAllMocks(); });

describe('Telegram', () => {
  it('replies once per chat while paused and never reaches the debouncer; after the pause it processes again', async () => {
    const { TelegramService } = await import('./telegram/index.js');
    const add = vi.fn();
    const fake = { stats: { messagesReceived: 0 }, debouncer: { add } };
    const handle = (TelegramService.prototype as unknown as { handleMessage(this: unknown, ctx: unknown): Promise<void> }).handleMessage;
    const reply = vi.fn(async () => {});
    const ctx = { chat: { id: 42 }, message: { text: 'hello', message_id: 1 }, reply };
    setUpdateBlocking(true);
    await handle.call(fake, ctx);
    await handle.call(fake, ctx);
    await handle.call(fake, ctx);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(UPDATING_REPLY);
    expect(add).not.toHaveBeenCalled();
    expect(fake.stats.messagesReceived).toBe(0);
    setUpdateBlocking(false);
    await handle.call(fake, ctx);
    expect(add).toHaveBeenCalledTimes(1); // the block cleared: the message goes through as usual
    expect(reply).toHaveBeenCalledTimes(1);
  });
});

describe('Discord', () => {
  it('replies once per channel while paused and does not process or queue the batch', async () => {
    const { DiscordService } = await import('./discord/index.js');
    const handle = (DiscordService.prototype as unknown as { handleBatch(this: unknown, b: unknown): Promise<void> }).handleBatch;
    const process = vi.fn();
    const fake = { _processBatch: process, deferredBatches: [] as unknown[] };
    const mk = (channelId: string) => {
      const reply = vi.fn(async (_o: unknown) => {});
      const lastMessage = { reply, react: vi.fn(async () => {}), author: { username: 'sam' } };
      return { reply, batch: { lane: 'owner', channelId, userId: 'u', firstMessage: lastMessage, lastMessage, messages: [lastMessage], combinedContent: 'hi' } };
    };
    const a1 = mk('c1'), a2 = mk('c1'), b = mk('c2');
    sent.calls.length = 0;
    setUpdateBlocking(true);
    await handle.call(fake, a1.batch); await handle.call(fake, a2.batch); await handle.call(fake, b.batch);
    expect(sent.calls).toHaveLength(2); // one per channel, through the gated sender
    expect(sent.calls[0]).toMatchObject({ payload: UPDATING_REPLY, lane: 'owner', target: { kind: 'reply', message: a1.batch.lastMessage } });
    expect(sent.calls[1].target.message).toBe(b.batch.lastMessage);
    expect(a1.reply).not.toHaveBeenCalled(); // (never a raw reply)
    expect(process).not.toHaveBeenCalled();
    expect(fake.deferredBatches).toHaveLength(0);
    setUpdateBlocking(false);
    await handle.call(fake, a1.batch);
    expect(process).toHaveBeenCalledTimes(1);
  });
});

describe('Orchestrator wakes', () => {
  it('a wake that fires during the pause is remembered (not run, not dropped); the catch-up runs each skipped wake type once when the pause ends', async () => {
    const { Orchestrator } = await import('./orchestrator.js');
    const wake = (Orchestrator.prototype as unknown as { handleWake(this: unknown, t: string): Promise<void> }).handleWake;
    const skipped = vi.fn();
    const fake = { wakePrompts: { morning: 'good morning' }, catchUp: { skipped }, agent: { isProcessing: () => { throw new Error('must not get this far'); } } };
    setUpdateBlocking(true);
    await wake.call(fake, 'morning');
    expect(skipped).toHaveBeenCalledWith('morning');
    // and the real catch-up a scheduler builds re-fires it
    const { createCatchUp } = await import('./update-block.js');
    const fired: string[] = [];
    const c = createCatchUp((types) => { for (const t of types) fired.push(t); });
    c.skipped('morning'); c.skipped('morning');
    setUpdateBlocking(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(fired).toEqual(['morning']);
    c.dispose();
  });
});
