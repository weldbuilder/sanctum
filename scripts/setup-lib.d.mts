// Types for the parts of scripts/setup-lib.mjs the backend's /api/setup routes use.
export function parseCodexConfig(toml: string): { model: string; modelProvider: string; providers: { key: string; name: string; baseUrl: string }[] };
export function tomlFeatures(text: string): Record<string, boolean>;
export function mergeBrowserMcp(text: string, filterPath: string, workdir: string): { action: 'added' | 'exists' | 'upgrade' | 'refused'; text: string; reason?: string };
export function upsertEnv(text: string, values: Record<string, string>): string;
export const AUTH_KEY_IGNORED_LINE: string;
export function authKeyIgnored(authMode: string | null | undefined, envKey: string | null | undefined): boolean;
