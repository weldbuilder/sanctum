// Fake discord.js Client and Telegraf bot for the stage 3c tests: they never open a socket, login() only records the token it was given, and
// nothing a fake does can start a model run. (No imports on purpose: the vi.mock factories load this file while the app is still loading.)
type Fn = (...a: any[]) => any;

export class FakeClient {
  handlers = new Map<string, Fn>();
  user = { id: 'bot-id', username: 'discord-bot', tag: 'discord-bot#0' };
  guilds = { cache: { size: 1 } };
  ready = false;
  token = '';
  destroyed = false;
  constructor(public opts: unknown) { fakes.discord.push(this); }
  on(event: string, fn: Fn): this { this.handlers.set(event, fn); return this; }
  async login(token: string): Promise<string> { this.token = token; this.ready = true; return token; }
  isReady(): boolean { return this.ready; }
  destroy(): void { this.destroyed = true; this.ready = false; }
}

export class FakeBot {
  handlers: Array<{ kind: string; name?: string; fn: Fn }> = [];
  getMe = 0;
  sent: Array<{ chat: string; text: string }> = [];
  stopped = false;
  launched = false;
  telegram: { getMe: () => Promise<{ username: string }>; sendMessage: (chat: string, text: string) => Promise<void> };
  constructor(public token: string) {
    fakes.telegram.push(this);
    this.telegram = {
      getMe: async () => { this.getMe++; return { username: `bot-${this.token.replace(/^tok-|-secret$/g, "")}` }; },
      sendMessage: async (chat, text) => { this.sent.push({ chat, text }); },
    };
  }
  use(fn: Fn): void { this.handlers.push({ kind: 'use', fn }); }
  command(name: string, fn: Fn): void { this.handlers.push({ kind: 'command', name, fn }); }
  on(name: string, fn: Fn): void { this.handlers.push({ kind: 'on', name, fn }); }
  catch(fn: Fn): void { this.handlers.push({ kind: 'catch', fn }); }
  launch(): Promise<void> { this.launched = true; return new Promise(() => {}); }
  stop(): void { this.stopped = true; }
}

export const fakes = { discord: [] as FakeClient[], telegram: [] as FakeBot[] };

