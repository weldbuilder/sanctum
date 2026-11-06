// The boot sites (server.ts starts the gateways; tenancy/channels.ts starts a tenant's) cannot be imported without booting, so they are pinned at
// the source: they ask the settings service for the switch, and no hand-rolled precedence for these keys is left anywhere.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const src = resolve(__dirname, '..', '..');
const text = (f: string) => readFileSync(join(src, f), 'utf8');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []; });

describe('boot sites use the settings service', () => {
  it('server.ts: discord and telegram boot on the resolved switch', () => {
    const s = text('server.ts');
    expect(s).toMatch(/const discordEnabled = !TENANT_MODE && resolveSetting\('discord\.enabled'\)\.value === true;/);
    expect(s).toMatch(/const telegramEnabled = !TENANT_MODE && resolveSetting\('telegram\.enabled'\)\.value === true;/);
  });
  it('tenancy/channels.ts: a tenant\'s channel starts on the same rule, inside the tenant', () => {
    expect(text('tenancy/channels.ts')).toMatch(/resolveSetting\(`\$\{platform\}\.enabled`\)\.value === true && hasBotToken\(platform\)/);
  });
  it('no source file still reads a switch, a token, a model or a Google client with its own order', () => {
    const offenders: string[] = [];
    const patterns: Array<[RegExp, string]> = [
      [/getConfigBool\(\s*[`'](discord|telegram|handoff)\.enabled/, 'channel/handoff switch from KV'],
      [/getConfigBool\(\s*'failsafe\.enabled'|getConfigBool\(\s*'pulse\.enabled'|getConfigNumber\(\s*'(failsafe|pulse)\./, 'failsafe/pulse'],
      [/getConfig\(`cron\.\$\{[^}]+\}\.(schedule|model|target)`\)/, 'cron KV read'],
      [/process\.env\.(DISCORD|TELEGRAM)_BOT_TOKEN|env\.GOOGLE_CLIENT_ID \|\|/, 'token/google env fallback'],
      [/prefs\.preferred_model(_autonomous)? \?\?/, 'model fallback'],
    ];
    for (const f of walk(src)) {
      if (f.includes(`${join('services', 'settings')}`)) continue;
      const t = readFileSync(f, 'utf8');
      for (const [re, what] of patterns) if (re.test(t)) offenders.push(`${f.slice(src.length + 1)}: ${what}`);
    }
    expect(offenders).toEqual([]);
  });
});
