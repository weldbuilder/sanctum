/** Mind tab, pure state: the memory radio's options, and what GET /api/settings says about a key (set or not, never the key). */
import type { MemoryChoice } from './prefsShared';

export interface MemoryOption { value: MemoryChoice; label: string; hint: string }

/** The four memory systems, one at a time. Harness memory is not offered on dsh, which has none. */
export function memoryOptions(provider: string | undefined): MemoryOption[] {
  const harnessName = provider === 'codex' ? 'Codex "memories"' : "Claude's auto-memory";
  const all: MemoryOption[] = [
    { value: 'revien', label: 'Revien', hint: "A local graph the companion searches and writes to. Until it is running, Sanctum's own memory stands in." },
    { value: 'sanctum', label: 'Local recall', hint: "Sanctum's own memory: built in, nothing to install. It recalls the closest lines from earlier conversations on this computer." },
    { value: 'harness', label: 'Harness memory', hint: `The harness's built-in memory: ${harnessName}.` },
    { value: 'none', label: 'None', hint: 'No memory service. Your own MCP server or files still work if you set them up.' },
  ];
  return provider === 'dsh' ? all.filter(o => o.value !== 'harness') : all;
}

export type KeyState = { set: boolean; source: string } | null;

/** One secret's marker from GET /api/settings `effective` ({ set, source }); null when the server did not report it. */
export function keyMarker(effective: Record<string, unknown> | undefined, key: string): KeyState {
  const v = effective?.[key] as { set?: unknown; source?: unknown } | undefined;
  if (!v || typeof v !== 'object' || typeof v.set !== 'boolean') return null;
  return { set: v.set, source: typeof v.source === 'string' ? v.source : '' };
}

/** "set (from .env)" / "not set". */
export function keyText(k: KeyState): string {
  if (!k) return 'not reported';
  if (!k.set) return 'not set';
  return k.source && k.source !== 'default' ? `set (from ${k.source === 'env' ? '.env' : k.source === 'db' ? 'the database' : k.source})` : 'set';
}

export const SUMMARIZER_DEFAULT_KEY_ENV = 'SUMMARIZER_API_KEY';

/** The deprecated agent.rolling.model / model_provider aliases, as GET /api/preferences reports them ('' = unset). */
export interface RollingAlias { model?: string; model_provider?: string }

/** The line under the Summarizer fields: who writes the summaries. A set deprecated alias is named, because the runtime still reads it. */
export function summarizerWho(s: { provider: string; model: string } | undefined, alias?: RollingAlias): string {
  if ((!s || (s.provider === '' && s.model === '')) && alias?.model?.trim()) {
    const via = alias.model_provider?.trim();
    return `Summaries currently use ${alias.model.trim()}${via ? ` (${via})` : ''} via the deprecated agent.rolling.model; move it to agent.summarizer.`;
  }
  if (!s || (s.provider === '' && s.model === '')) return 'The chat model writes them.';
  if (s.provider === '') return `The chat harness writes them, on ${s.model}.`;
  return `${s.provider}${s.model ? ` on ${s.model}` : ''} writes them. They are the companion's own memory, so not a small model.`;
}

/** Which secret an imagegen provider needs, as the registry key GET /api/settings reports it under. */
export function imagegenKeyFor(provider: string): { key: string; env: string } | null {
  if (provider === 'runware') return { key: 'imagegen.runware_api_key', env: 'RUNWARE_API_KEY' };
  if (provider === 'replicate') return { key: 'imagegen.replicate_api_token', env: 'REPLICATE_API_TOKEN' };
  return null;
}

/** The key-env field takes a variable NAME, which is upper case: typing folds to it, and spaces are not part of a name. */
export function keyEnvTyped(v: string): string {
  return v.toUpperCase().replace(/\s+/g, '');
}

export const KEY_ENV_HINT = 'The variable NAME, not the key: e.g. SUMMARIZER_API_KEY. Put the key itself in .env.';

/** The radio shows what is really running: dsh has no harness memory, so a file that says "harness" there is shown as none. */
export function shownMemory(provider: string | undefined, memory: MemoryChoice): MemoryChoice {
  return provider === 'dsh' && memory === 'harness' ? 'none' : memory;
}

/** One line when the file turns on more than one memory system; saving the radio's choice turns the others off. */
export function memoryMixedNote(mixed: boolean | undefined): string | null {
  return mixed ? 'This file turns on more than one memory system. Saving with the choice above selected turns the others off.' : null;
}
