// PUT /api/preferences: the provider + dsh slice of the agent merge, pulled out of
// the route so it can be tested without a server. Mutates `agent` (the parsed
// yaml's agent block) in place; returns an error string for a 400, else null.

export const PROVIDERS = ['claude', 'codex', 'dsh'] as const;
export const DSH_STRING_FIELDS = ['model', 'model_autonomous', 'model_provider', 'base_url', 'api_key_env'] as const;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);

export function mergeProviderAndDsh(agent: Record<string, any>, updates: Record<string, any>): string | null {
  if (updates.provider !== undefined) {
    if (!(PROVIDERS as readonly unknown[]).includes(updates.provider)) {
      return `agent.provider must be one of ${PROVIDERS.join(', ')}`;
    }
    agent.provider = updates.provider;
  }
  if (updates.dsh && typeof updates.dsh === 'object') {
    if (!agent.dsh) agent.dsh = {};
    for (const k of DSH_STRING_FIELDS) {
      // '' is a real value (model_autonomous '' = follow chat); it is never filled from another field.
      const v = str(updates.dsh[k]);
      if (v !== undefined) agent.dsh[k] = v;
    }
  }
  return null;
}

/** GET side: the yaml values as saved ('' when unset), never the resolved ones. */
export function readDshPrefs(agent: Record<string, any> | undefined): Record<(typeof DSH_STRING_FIELDS)[number], string> {
  const out = {} as Record<(typeof DSH_STRING_FIELDS)[number], string>;
  for (const k of DSH_STRING_FIELDS) out[k] = agent?.dsh?.[k] ?? '';
  return out;
}
