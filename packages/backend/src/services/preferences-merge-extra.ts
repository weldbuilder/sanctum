// PUT /api/preferences: the summarizer and picture-making slices, kept out of the route so they can be tested without a server.
// Both mutate the parsed yaml in place and return an error string for a 400, else null. Values equal to what the panel was shown are
// weeded out afterwards by settleWrittenKeys, so only a real change reaches the file.

export const SUMMARIZER_PROVIDERS = ['', 'claude', 'codex', 'dsh', 'openai-compat'] as const;
export const SUMMARIZER_STRING_FIELDS = ['model', 'base_url', 'api_key_env'] as const;
export const IMAGEGEN_PROVIDERS = ['none', 'runware', 'replicate'] as const;
export const IMAGEGEN_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);

export function mergeSummarizer(agent: Record<string, any>, updates: Record<string, any>): string | null {
  const u = updates.summarizer;
  if (u === undefined) return null;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return 'agent.summarizer must be an object';
  if (u.provider !== undefined && !(SUMMARIZER_PROVIDERS as readonly unknown[]).includes(u.provider)) {
    return `agent.summarizer.provider must be one of "", ${SUMMARIZER_PROVIDERS.filter(Boolean).join(', ')}`;
  }
  if (u.api_key_env !== undefined && !(typeof u.api_key_env === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$|^$/.test(u.api_key_env.trim()))) {
    return 'agent.summarizer.api_key_env is the NAME of an environment variable (letters, digits, underscore), never the key';
  }
  if (!agent.summarizer) agent.summarizer = {};
  if (u.provider !== undefined) agent.summarizer.provider = u.provider;
  for (const k of SUMMARIZER_STRING_FIELDS) {
    const v = str(u[k]);
    if (v !== undefined) agent.summarizer[k] = v;
  }
  return null;
}

export function mergeImagegen(parsed: Record<string, any>, updates: Record<string, any>): string | null {
  const u = updates.imagegen;
  if (u === undefined) return null;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return 'imagegen must be an object';
  if (u.provider !== undefined && !(IMAGEGEN_PROVIDERS as readonly unknown[]).includes(u.provider)) return `imagegen.provider must be one of ${IMAGEGEN_PROVIDERS.join(', ')}`;
  if (u.size !== undefined && !(IMAGEGEN_SIZES as readonly unknown[]).includes(u.size)) return `imagegen.size must be one of ${IMAGEGEN_SIZES.join(', ')}`;
  if (u.safety_checker !== undefined && typeof u.safety_checker !== 'boolean') return 'imagegen.safety_checker must be true or false';
  if (!parsed.imagegen) parsed.imagegen = {};
  if (u.provider !== undefined) parsed.imagegen.provider = u.provider;
  if (u.size !== undefined) parsed.imagegen.size = u.size;
  if (u.safety_checker !== undefined) parsed.imagegen.safety_checker = u.safety_checker;
  const model = str(u.model);
  if (model !== undefined) parsed.imagegen.model = model;
  return null;
}

// ── memory: one choice, three keys ──────────────────────────────────────────
// The wizard forces one memory system (scripts/setup-lib.mjs applyMemoryChoice); the panel does the same through one radio.
export const MEMORY_CHOICES = ['revien', 'sanctum', 'harness', 'none'] as const;
export type MemoryChoice = (typeof MEMORY_CHOICES)[number];

/** The choice a yaml tree amounts to (the same reading as the wizard's default); an absent revien block is the shipped default: Revien on. */
export function memoryChoiceOf(file: Record<string, any> | undefined): MemoryChoice {
  const revienOn = file?.revien?.enabled !== false;
  if (file?.agent?.local_recall === true && !revienOn) return 'sanctum';
  if (file?.agent?.harness_memory === true) return 'harness';
  return revienOn ? 'revien' : 'none';
}

/** Writes the trio revien.enabled / agent.harness_memory / agent.local_recall for a choice (only 'sanctum' keeps local_recall). */
export function mergeMemory(parsed: Record<string, any>, updates: Record<string, any>): string | null {
  if (updates.memory === undefined) return null;
  const choice = typeof updates.memory === 'string' ? updates.memory : (updates.memory as any)?.choice;
  if (!(MEMORY_CHOICES as readonly unknown[]).includes(choice)) return `memory must be one of ${MEMORY_CHOICES.join(', ')}`;
  if (memoryChoiceOf(parsed) === choice) return null; // already what the file says: leave its spelling alone
  parsed.revien = { ...(parsed.revien || {}), enabled: choice === 'revien' };
  parsed.agent = { ...(parsed.agent || {}), harness_memory: choice === 'harness' };
  if (choice === 'sanctum') parsed.agent.local_recall = true; else delete parsed.agent.local_recall;
  return null;
}
