// Variables the backend holds for itself that no provider child process (Claude Code, Codex) may inherit.
// MIND_API_KEY is the Mind's bearer; the backend calls the Mind, a child never does (dsh's allowlist
// already leaves it out). Everything else in the environment passes through unchanged.
// Names are matched case-insensitively: Windows environment keys are case-insensitive, so `Mind_Api_Key`
// in process.env is the same variable.
const WITHHELD = new Set(['MIND_API_KEY']);

/** `base` (default process.env) as a plain copy, without the backend's own secrets. */
export function childEnv<T extends Record<string, string | undefined> = NodeJS.ProcessEnv>(base: T = process.env as unknown as T): T {
  const env = { ...base };
  for (const name of Object.keys(env)) if (WITHHELD.has(name.toUpperCase())) delete env[name];
  return env;
}
