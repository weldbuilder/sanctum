// The old admission machinery is gone, not just unused: pairing codes, the allowed-user / allowed-guild / require-mention
// settings and the ignore rules admit nobody (preflight.ts is gone; the lane is decided at intake, lanes.ts). What
// admitted nobody was removed so nothing suggests it still does.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..');
const REPO = join(SRC, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(...p), 'utf-8');

describe('the pairing and rules admission code is removed', () => {
  it('pairing.ts and its types are gone, and nothing in the backend imports them', () => {
    expect(existsSync(join(here, 'pairing.ts'))).toBe(false);
    expect(read(here, 'types.ts')).not.toMatch(/PairingCode|PreflightResult/);
    for (const f of ['index.ts', 'config.ts']) expect(read(here, f)).not.toMatch(/pairing|Pairing/);
  });

  it('config.ts no longer reads allowed users, allowed guilds, active channels, require-mention or the pairing expiry', () => {
    const src = read(here, 'config.ts');
    for (const gone of ['getAllowedUsers', 'getAllowedGuilds', 'getActiveChannels', 'requireMentionInGuilds', 'pairingExpiryMs', 'allowedUsers', 'allowedGuilds']) {
      expect(src, gone).not.toContain(gone);
    }
  });

  it('rules.ts keeps only what has a caller: the context the owner lane reads', () => {
    const src = read(here, 'rules.ts');
    for (const gone of ['isChannelIgnored', 'requiresMention', 'isUserAllowedInServer', 'getRulesData', 'saveRules', 'reloadRules']) {
      expect(src, gone).not.toContain(`function ${gone}`);
    }
    expect(src).toContain('export function buildRulesContext');
  });

  it('the Settings screen for them is deleted, and the owner-id field is still there', () => {
    expect(existsSync(join(SRC, '..', '..', 'frontend', 'src', 'components', 'settings', 'DiscordSection.tsx'))).toBe(false);
    expect(read(SRC, '..', '..', 'frontend', 'src', 'components', 'settings', 'ChannelsSection.tsx')).toContain('ownerUserId');
  });

  it('UPGRADE.md says the pairing and rules screens are gone and the exclusions file replaces them', () => {
    const up = read(REPO, 'UPGRADE.md');
    expect(up).toMatch(/pairing and rules screens are gone/i);
    expect(up).toMatch(/exclusions file replaces/i);
  });
});
