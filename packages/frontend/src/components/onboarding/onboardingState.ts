// The three-screen onboarding's logic with no React in it: the harness choices, the answers it sends, the connection check's body.
// Onboarding.tsx draws it. Everything it does not ask is left out of the answers, so the server's setup plan gives it its default
// (scripts/setup-plan.mjs walkValues): the same defaults `npm run setup` offers, and Settings changes them later.

import type { Answers } from '../setup/setupWizardState';

/** The three harnesses: Claude, Codex, and DeepSeek Harness (`dsh`, docs/DSH.md). */
export type Harness = 'claude' | 'codex' | 'dsh';
export type Method = 'login' | 'key';
/** Codex with a key: a provider the page knows the address and model of, or one the person names. */
export type CodexProvider = 'openai' | 'deepseek' | 'other';

export interface ModelOption { value: string; label: string; detail: string }

export const CLAUDE_MODELS: ModelOption[] = [
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', detail: 'Recommended. Warm, quick and thoughtful.' },
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5', detail: 'The deepest thinker. Slower, and uses more of your plan.' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', detail: 'The lightest and fastest.' },
];

/** The addresses and models the server's own presets use (scripts/setup-plan.mjs CODEX_PRESETS). */
export const CODEX_PROVIDERS: Record<Exclude<CodexProvider, 'other'>, { name: string; baseUrl: string; model: string }> = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
};

export interface Connect {
  harness: Harness;
  method: Method;
  key: string;
  claudeModel: string;
  codexProvider: CodexProvider;
  /** 'other' only: what the person calls it, and its address. */
  otherName: string;
  otherBaseUrl: string;
  /** Codex with a key: the model id at that provider. */
  codexModel: string;
}

export const initialConnect = (): Connect => ({
  harness: 'claude', method: 'login', key: '', claudeModel: CLAUDE_MODELS[0].value,
  codexProvider: 'openai', otherName: '', otherBaseUrl: '', codexModel: CODEX_PROVIDERS.openai.model,
});

/** The provider's name and address for Codex with a key. */
export function codexTarget(c: Connect): { id: string; name: string; baseUrl: string } {
  if (c.codexProvider !== 'other') return { id: c.codexProvider, ...CODEX_PROVIDERS[c.codexProvider] };
  const name = c.otherName.trim();
  // The server keeps letters, digits and dashes in a provider id (setup-plan.mjs coerce); 'custom' when the name has none.
  const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
  return { id, name: name || 'Your provider', baseUrl: c.otherBaseUrl.trim() };
}

/** Choosing a harness: DeepSeek Harness has one way in here (a DeepSeek API key); the others start on the account login. */
export function withHarness(c: Connect, h: Harness): Connect {
  return { ...c, harness: h, method: h === 'dsh' ? 'key' : 'login', key: '' };
}

/** Switching the Codex provider brings its model with it (the person can still change it). */
export function withCodexProvider(c: Connect, p: CodexProvider): Connect {
  return { ...c, codexProvider: p, codexModel: p === 'other' ? '' : CODEX_PROVIDERS[p].model };
}

/** The body of POST /api/setup/test for the connection check. */
export function connectionBody(c: Connect): Record<string, string> {
  if (c.harness === 'codex' && c.method === 'key') {
    const t = codexTarget(c);
    return { probe: 'connection', harness: 'codex', method: 'key', key: c.key, baseUrl: t.baseUrl, providerName: t.name };
  }
  if (c.harness === 'dsh') return { probe: 'connection', harness: 'dsh', method: 'key', key: c.key };
  return { probe: 'connection', harness: c.harness, method: c.method, ...(c.method === 'key' ? { key: c.key } : {}) };
}

/** Whether the screen has everything the check needs (the check button is off until it does). */
export function readyToCheck(c: Connect): boolean {
  if (c.harness === 'dsh') return !!c.key.trim();
  if (c.method === 'login') return true;
  if (!c.key.trim()) return false;
  if (c.harness === 'codex') return !!codexTarget(c).baseUrl && !!c.codexModel.trim();
  return true;
}

export interface Yours { userName: string; companionName: string; timezone: string }

/** The answers the three screens send. Only these: every other setup answer is the server's default. */
export function onboardingAnswers(y: Yours, c: Connect, password: string): Answers {
  const a: Answers = { userName: y.userName.trim(), companionName: y.companionName.trim(), timezone: y.timezone };
  if (password) a.password = password;
  if (c.harness === 'claude') {
    a.provider = 'claude';
    a.claudeModel = c.claudeModel;
    if (c.method === 'key' && c.key.trim()) a.anthropicKey = c.key.trim();
    return a;
  }
  if (c.harness === 'dsh') {
    // Its model stays dsh's own default (Settings changes it, and the route); the key goes to .env as DEEPSEEK_API_KEY.
    a.provider = 'dsh';
    if (c.key.trim()) a.dshKey = c.key.trim();
    return a;
  }
  a.provider = 'codex';
  if (c.method === 'login') { a.addProvider = false; return a; }
  const t = codexTarget(c);
  Object.assign(a, {
    addProvider: true, providerId: t.id, providerName: t.name, providerBaseUrl: t.baseUrl,
    providerKey: c.key.trim(), providerModel: c.codexModel.trim(), providerDefault: true,
  });
  return a;
}

/** This device's time zone, for the line under the names; UTC when the browser will not say. */
export function deviceTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** "America/New_York" as "New York". */
export function placeOf(tz: string): string {
  const last = tz.split('/').pop() || tz;
  return last.replace(/_/g, ' ');
}

/** The one-time note "Explore more with <name>" leaves for the composer: the first message, ready to send. */
export const EXPLORE_PREFILL_KEY = 'sanctum.onboarding.prefill';
export const explorePrompt = (companion: string) =>
  `Hi ${companion}. I just moved in. Can you show me around? Tell me what else Sanctum can do, and help me set up anything worth having.`;
