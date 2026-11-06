// outward_telegram: every proactive send method asks the consent gate first; a refusal throws ConsentDeniedError and nothing is sent.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('telegraf', () => ({
  Telegraf: class {
    telegram = {
      sendMessage: async () => { h.sent.push('message'); }, sendVoice: async () => { h.sent.push('voice'); }, sendPhoto: async () => { h.sent.push('photo'); },
      sendDocument: async () => { h.sent.push('document'); }, sendAnimation: async () => { h.sent.push('animation'); },
      getMe: async () => ({ username: 'bot' }),
    };
    on() {} use() {} catch() {} command() {} action() {}
  },
}));
vi.mock('../bot-token.js', async (orig) => ({ ...(await orig<object>()), getBotToken: () => 'tok' }));
vi.mock('../embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('../vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../../config.js', async (orig) => ({ ...(await orig<object>()), getSanctumConfig: () => ({ identity: { companion_name: 'Echo', user_name: 'Sam', timezone: 'UTC' }, telegram: {}, server: { db_path: ':memory:' }, agent: { cwd: '/tmp/home' } }) }));

import { TelegramService } from './index.js';
import { initDb, setConfig, getDb } from '../db.js';
import { ConsentDeniedError, grant, setMode, turnOff } from '../consent/gate.js';

const svc = () => new TelegramService({} as never, { broadcast() {} } as never, { canTTS: true, generateTTS: async () => Buffer.from('x') } as never);
const sends: Array<[string, (s: TelegramService) => Promise<void>]> = [
  ['sendToOwner', (s) => s.sendToOwner('hi')],
  ['sendVoiceToOwner', (s) => s.sendVoiceToOwner('hi')],
  ['sendPhotoToOwner', (s) => s.sendPhotoToOwner('https://x.test/a.png', 'cap')],
  ['sendDocumentToOwner', (s) => s.sendDocumentToOwner('https://x.test/a.pdf', 'a.pdf', 'cap')],
  ['sendAnimationToOwner', (s) => s.sendAnimationToOwner('https://x.test/a.gif')],
];
const receipts = () => getDb().prepare("SELECT capability, outcome, tool_or_route FROM consent_receipts WHERE outcome IN ('allowed','denied','expired') ORDER BY id").all() as any[];

beforeEach(() => { initDb(':memory:'); setConfig('telegram.ownerChatId', '4242'); h.sent.length = 0; vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('Telegram send methods', () => {
  for (const [name, run] of sends) {
    it(`${name}: sends when on (receipt: allowed); refuses when off (ConsentDeniedError, receipt: denied, nothing sent)`, async () => {
      const s = svc();
      await run(s);
      expect(h.sent.length).toBe(1);
      expect(receipts()[0]).toMatchObject({ capability: 'outward_telegram', outcome: 'allowed' });
      h.sent.length = 0;
      turnOff('outward_telegram');
      await expect(run(s)).rejects.toBeInstanceOf(ConsentDeniedError);
      await expect(run(s)).rejects.toThrow('Telegram sending is turned off (Settings → Permissions).');
      expect(h.sent).toEqual([]);
      expect(receipts().at(-1)).toMatchObject({ capability: 'outward_telegram', outcome: 'denied' });
    });
  }
  it('guard mode: refused until a window is granted', async () => {
    setMode('guard');
    await expect(svc().sendToOwner('hi')).rejects.toBeInstanceOf(ConsentDeniedError);
    grant('outward_telegram', 15);
    await svc().sendToOwner('hi');
    expect(h.sent).toEqual(['message']);
  });
  it('a voice note also needs voice_out (it spends credit)', async () => {
    turnOff('voice_out');
    await expect(svc().sendVoiceToOwner('hi')).rejects.toThrow('Voice output is turned off');
    expect(h.sent).toEqual([]);
    await svc().sendToOwner('plain text still goes');
    expect(h.sent).toEqual(['message']);
  });
  it('no owner chat: nothing is sent and nothing is gated (no receipt for a send that never happens)', async () => {
    setConfig('telegram.ownerChatId', '');
    await svc().sendToOwner('hi');
    expect(h.sent).toEqual([]);
    expect(receipts()).toEqual([]);
  });
});
