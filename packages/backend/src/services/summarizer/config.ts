// What the summarizer is, resolved from config: which client runs it, on which model. Pure and light (no provider or SDK
// imports), so config loading and the startup warning can use it without pulling the harnesses in.
//
// agent.summarizer.{provider, model, ...} is the one block. agent.rolling.model and agent.rolling.model_provider are
// read as aliases for one release: used only while the summarizer key is empty, with one "deprecated" warning.
import type { SanctumConfig } from '../../config.js';

export type SummarizerProvider = 'claude' | 'codex' | 'dsh' | 'openai-compat';
const HARNESSES = ['claude', 'codex', 'dsh'] as const;
const isHarness = (v: string): v is typeof HARNESSES[number] => (HARNESSES as readonly string[]).includes(v);

export interface ResolvedSummarizer {
  provider: SummarizerProvider;
  /** '' = the harness default (openai-compat: a missing model, which runSummary refuses). */
  model: string;
  /** A Codex [model_providers.*] key or a dsh llm route (the old rolling.model_provider, or the harness's own); '' = the harness default. */
  route: string;
  baseUrl: string;
  apiKeyEnv: string;
  maxOutputTokens: number;
  headers: Record<string, string>;
  /** An agent.rolling alias supplied a value. */
  aliased: boolean;
}

const warned = new Set<string>();
export function resetSummarizerWarnings(): void { warned.clear(); }
function warnOnce(key: string, msg: string, warn: (m: string) => void): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn(msg);
}

/** The summarizer for this config. `chat` is the harness that runs turns (activeProviderName()). */
export function resolveSummarizer(cfg: SanctumConfig, chat: string, warn: (m: string) => void = console.warn): ResolvedSummarizer {
  const s = (cfg.agent as { summarizer?: Partial<SanctumConfig['agent']['summarizer']> }).summarizer ?? {};
  const rolling = cfg.agent.rolling ?? ({} as SanctumConfig['agent']['rolling']);
  let aliased = false;
  let provider = (s.provider || '').trim();
  let model = (s.model || '').trim();
  let route = '';
  const oldModel = (rolling.model || '').trim();
  const oldProvider = (rolling.model_provider || '').trim();
  if (!model && oldModel) {
    model = oldModel; aliased = true;
    warnOnce('rolling.model', '[config] agent.rolling.model is deprecated, use agent.summarizer.model', warn);
  }
  if (oldProvider) {
    if (!provider && (isHarness(oldProvider) || oldProvider === 'openai-compat')) {
      provider = oldProvider; aliased = true;
      warnOnce('rolling.model_provider', '[config] agent.rolling.model_provider is deprecated, use agent.summarizer.provider', warn);
    } else if (!provider) {
      route = oldProvider; aliased = true; // a Codex / dsh route name, as it always was
      warnOnce('rolling.model_provider', '[config] agent.rolling.model_provider is deprecated, use agent.summarizer.provider (a route name stays a route of the chat harness)', warn);
    }
  }
  const resolved: SummarizerProvider = provider === 'openai-compat' ? 'openai-compat' : isHarness(provider) ? provider : isHarness(chat) ? chat : 'claude';
  if (provider && provider !== 'openai-compat' && !isHarness(provider)) {
    warnOnce(`provider:${provider}`, `[config] agent.summarizer.provider "${provider}" is not claude, codex, dsh or openai-compat; using the chat harness (${resolved})`, warn);
  }
  // No model named: the chosen harness's own autonomous model, else its chat model.
  if (!model) {
    const a = cfg.agent;
    if (resolved === 'claude') model = a.model_autonomous || a.model || '';
    else if (resolved === 'codex') model = a.codex?.model_autonomous || a.codex?.model || '';
    else if (resolved === 'dsh') model = a.dsh?.model_autonomous || a.dsh?.model || '';
  }
  // A leftover non-Claude alias (gpt-5-mini from a Codex setup) must not reach the Claude SDK: every fold would fail.
  // Fall back to the chat model, as before. (openai-compat is never here: any model id is valid at that endpoint.)
  if (resolved === 'claude' && model && !model.toLowerCase().startsWith('claude')) {
    warnOnce(`notclaude:${model}`, `[config] summarizer model "${model}" is not a Claude model but the summarizer runs on claude; using the chat model instead (set agent.summarizer.provider for another provider, or clear the model)`, warn);
    model = cfg.agent.model_autonomous || cfg.agent.model || '';
  }
  if (!route && resolved === 'codex') route = cfg.agent.codex?.model_provider || '';
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.headers ?? {})) if (typeof v === 'string' && k.trim()) headers[k.trim()] = v;
  return {
    provider: resolved, model, route,
    baseUrl: (s.base_url || '').trim(),
    apiKeyEnv: (s.api_key_env || 'SUMMARIZER_API_KEY').trim() || 'SUMMARIZER_API_KEY',
    maxOutputTokens: Number.isFinite(s.max_output_tokens) && (s.max_output_tokens as number) > 0 ? Math.floor(s.max_output_tokens as number) : 2000,
    headers, aliased,
  };
}

/** Models that are small or fast tier. `mini` must not be the tail of another word ("gemini"). */
export const SMALL_TIER = /haiku|(?<![a-z])mini(?!max)|small|lite|nano|\b[1-8]b\b/i;
export const looksSmallTier = (model: string): boolean => SMALL_TIER.test(model || '');

export const SMALL_MODEL_WARNING = 'summarizer model looks small-tier; it writes the companion\'s own memory and will flatten the voice; see docs/CONFIGURATION.md → summarizer';

/** One warning when the effective summarizer model looks small-tier. `where` names a tenant. Returns true when it warned. */
export function warnIfSmallSummarizer(cfg: SanctumConfig, chat: string, where = '', warn: (m: string) => void = console.warn): boolean {
  const r = resolveSummarizer(cfg, chat, warn);
  if (!looksSmallTier(r.model)) return false;
  const key = `small:${where}\0${r.model}`;
  if (warned.has(key)) return false; // once per (tenant, model) per process: a tenant reload must not repeat it
  warned.add(key);
  warn(`[config]${where ? ` ${where}:` : ''} ${r.model}: ${SMALL_MODEL_WARNING}`);
  return true;
}

/** Boot-time check: openai-compat needs a base URL and a model (a Claude model id would be wrong at that endpoint, so
 *  there is no fallback). One log line per problem, naming the key; the same problem is not logged twice for a tenant.
 *  Returns the problems found. */
export function checkSummarizerConfig(cfg: SanctumConfig, chat: string, where = '', warn: (m: string) => void = console.warn): string[] {
  const r = resolveSummarizer(cfg, chat, warn);
  if (r.provider !== 'openai-compat') return [];
  const out: string[] = [];
  if (!r.model) out.push('agent.summarizer.model is required when agent.summarizer.provider is openai-compat (there is no fallback: the chat model\'s id would be wrong at that endpoint); every summary will fail until it is set');
  if (!r.baseUrl) out.push('agent.summarizer.base_url is required when agent.summarizer.provider is openai-compat; every summary will fail until it is set');
  for (const m of out) warnOnce(`check:${where}\0${m}`, `[config]${where ? ` ${where}:` : ''} ${m}`, warn);
  return out;
}
