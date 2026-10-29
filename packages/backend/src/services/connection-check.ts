// The onboarding's "Connect your AI" check: does the harness the person chose (Claude, Codex or DeepSeek Harness) have a way in?
//
// An API key is checked for real, with the provider's own model list (GET .../models): it costs nothing, proves the key is accepted,
// and nothing is generated. A login is checked by the file the harness keeps it in (Claude's .credentials.json, Codex's auth.json),
// because there is no way to ask the account without running the harness. Nothing here keeps, logs or returns a key, and no response
// body from a provider is passed on: the person sees one of the sentences below.

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type ConnectionHarness = 'claude' | 'codex' | 'dsh';
export type ConnectionMethod = 'login' | 'key';

export interface ConnectionInput {
  harness: ConnectionHarness;
  method: ConnectionMethod;
  /** The key typed on the screen (method 'key'). */
  key?: string;
  /** Codex with a key: the provider's API address (an OpenAI-compatible base URL, e.g. https://api.openai.com/v1). */
  baseUrl?: string;
  /** Codex with a key: the provider's name as the person knows it, for the sentence. */
  providerName?: string;
}

export type ConnectionState = 'connected' | 'signed_in' | 'cannot_check' | 'not_signed_in' | 'not_installed' | 'no_key' | 'key_rejected' | 'unreachable' | 'bad_address';
export interface ConnectionResult { ok: boolean; state: ConnectionState; message: string }

export interface ConnectionDeps {
  fetch: (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number }>;
  exists: (path: string) => boolean;
  codexInstalled: () => boolean;
  /** DeepSeek Harness (agent.dsh.command) answers `--version`. */
  dshInstalled: () => boolean;
  platform: NodeJS.Platform;
  /** Where the harnesses keep their logins: the tenant's harness homes in tenant mode, else the environment's or the defaults. */
  claudeConfigDir: string;
  codexHome: string;
  timeoutMs?: number;
}

export function defaultHomes(env: NodeJS.ProcessEnv = process.env): { claudeConfigDir: string; codexHome: string } {
  return {
    claudeConfigDir: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    codexHome: env.CODEX_HOME || join(homedir(), '.codex'),
  };
}

const ANTHROPIC_MODELS = 'https://api.anthropic.com/v1/models';
const DEEPSEEK_MODELS = 'https://api.deepseek.com/models';

/** The models list of an OpenAI-compatible base URL, or null when the address is not an http(s) URL. */
export function modelsUrl(baseUrl: string): string | null {
  let u: URL;
  try { u = new URL(baseUrl.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/models`;
}

async function askModels(deps: ConnectionDeps, url: string, headers: Record<string, string>): Promise<'ok' | 'rejected' | 'unreachable'> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 8000);
  try {
    const r = await deps.fetch(url, { method: 'GET', headers, signal: ctrl.signal });
    if (r.status >= 200 && r.status < 300) return 'ok';
    if (r.status === 401 || r.status === 403) return 'rejected';
    return 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

export async function checkConnection(input: ConnectionInput, deps: ConnectionDeps): Promise<ConnectionResult> {
  const key = (input.key || '').trim();

  if (input.harness === 'claude') {
    if (input.method === 'key') {
      if (!key) return { ok: false, state: 'no_key', message: 'Paste your Anthropic API key first.' };
      const r = await askModels(deps, ANTHROPIC_MODELS, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
      if (r === 'ok') return { ok: true, state: 'connected', message: 'Connected. Anthropic accepted your key.' };
      if (r === 'rejected') return { ok: false, state: 'key_rejected', message: "Anthropic didn't accept that key. Copy it again from console.anthropic.com, under API keys." };
      return { ok: false, state: 'unreachable', message: "Couldn't reach Anthropic from this computer. Check the internet connection, then try again." };
    }
    if (deps.exists(join(deps.claudeConfigDir, '.credentials.json'))) {
      return { ok: true, state: 'signed_in', message: 'Signed in. Claude found your account on this computer.' };
    }
    // On a Mac, `claude login` keeps the sign-in in the Keychain, where nothing but Claude itself can read it.
    if (deps.platform === 'darwin') {
      return { ok: true, state: 'cannot_check', message: "On a Mac your Claude sign-in is kept in the Keychain, so it can't be checked from here. If you've signed in with `claude login`, you're set; the first reply will prove it." };
    }
    return { ok: false, state: 'not_signed_in', message: "Claude isn't signed in on this computer yet. Ask your AI to run `claude login` (or run it in a terminal), then check again. Or choose an API key instead." };
  }

  // DeepSeek Harness (docs/DSH.md): its own program, on a DeepSeek API key (the default route). It is installed first, then the key is tried.
  if (input.harness === 'dsh') {
    if (!deps.dshInstalled()) {
      return { ok: false, state: 'not_installed', message: "DeepSeek Harness isn't installed on this computer yet. Ask your AI to install it (npm i -g @deepseek-ai/dsh@0.2.1-alpha.2), then check again." };
    }
    if (!key) return { ok: false, state: 'no_key', message: 'Paste your DeepSeek API key first.' };
    const r = await askModels(deps, DEEPSEEK_MODELS, { Authorization: `Bearer ${key}` });
    if (r === 'ok') return { ok: true, state: 'connected', message: 'Connected. DeepSeek accepted your key.' };
    if (r === 'rejected') return { ok: false, state: 'key_rejected', message: "DeepSeek didn't accept that key. Copy it again from platform.deepseek.com, under API keys." };
    return { ok: false, state: 'unreachable', message: "Couldn't reach DeepSeek from this computer. Check the internet connection, then try again." };
  }

  // Codex
  if (input.method === 'key') {
    const name = (input.providerName || '').trim() || 'The provider';
    const url = modelsUrl(input.baseUrl || '');
    if (!url) return { ok: false, state: 'bad_address', message: "That address doesn't look right. It should start with https://, like https://api.openai.com/v1." };
    if (!key) return { ok: false, state: 'no_key', message: `Paste your ${name === 'The provider' ? 'API' : name} key first.` };
    const r = await askModels(deps, url, { Authorization: `Bearer ${key}` });
    if (r === 'ok') return { ok: true, state: 'connected', message: `Connected. ${name} accepted your key.` };
    if (r === 'rejected') return { ok: false, state: 'key_rejected', message: `${name} didn't accept that key. Copy it again from your account's API keys page.` };
    return { ok: false, state: 'unreachable', message: `Couldn't reach ${name} at that address. Check the address and the internet connection, then try again.` };
  }
  if (!deps.codexInstalled()) {
    return { ok: false, state: 'not_installed', message: "Codex isn't installed on this computer yet. Ask your AI to install it (the README's first step), then check again." };
  }
  if (deps.exists(join(deps.codexHome, 'auth.json'))) {
    return { ok: true, state: 'signed_in', message: 'Signed in. Codex will use your ChatGPT account.' };
  }
  return { ok: false, state: 'not_signed_in', message: 'Codex is installed but not signed in. Run `codex login` and sign in with your ChatGPT account, then check again.' };
}

/** The real dependencies. */
export function liveDeps(over: Partial<ConnectionDeps> & Pick<ConnectionDeps, 'codexInstalled' | 'dshInstalled'>): ConnectionDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    exists: existsSync,
    platform: process.platform,
    ...defaultHomes(),
    ...over,
  };
}
