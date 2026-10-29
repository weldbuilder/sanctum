// GET /api/companions (household mode only): the hallway's list. A house route: it needs the house session and no current companion.
// Mounted like info.ts; the gate is authMiddleware, which in household mode reads the house password and the house session store.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import yaml from 'js-yaml';
import { runInTenant, type TenantRuntime } from './context.js';
import { houseCompanionIds } from './house.js';
import { householdCompanion } from './resolve.js';
import { ownReadable, readOwnTextIn } from './own-files.js';

const DEFAULT_COMPANION_NAME = 'Echo'; // (config.ts DEFAULTS.identity.companion_name)

export interface CompanionListing { id: string; name: string; avatar_url: string | null; status: 'ready' | 'unavailable' }

// The same names the avatar route looks for (routes/api.ts), in the same order.
const AVATAR_NAMES = ['avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.webp', 'avatar.gif'];

/** The companion's own name: `identity.companion_name` in its tenant.yaml (or a non-default one from its config); a companion that never named itself is listed by its id,
 *  not by the shipped default name every unnamed companion would share. */
function nameOf(rt: TenantRuntime): string {
  const configured = rt.config.identity.companion_name;
  if (configured !== DEFAULT_COMPANION_NAME) return configured;
  try {
    const own = (yaml.load(readOwnTextIn(rt.dir, join(rt.dir, 'tenant.yaml'))) as { identity?: { companion_name?: unknown } } | null)?.identity?.companion_name;
    if (typeof own === 'string' && own.trim()) return configured;
  } catch { /* no tenant.yaml, or not readable: unnamed */ }
  return rt.id;
}

/** Every tenant folder found at boot. Unavailable ones (skipped, reserved, parked) carry their id and nothing else: never the reason, never a path. */
export function listCompanions(): CompanionListing[] {
  return houseCompanionIds().map((id): CompanionListing => {
    const found = householdCompanion(id);
    if (!found || 'unavailable' in found) return { id, name: id, avatar_url: null, status: 'unavailable' };
    const rt = found.rt;
    // Read inside the companion, through the read guard (a link or a pipe planted at an avatar name is not an avatar).
    const hasAvatar = runInTenant(rt, () => {
      const dir = join(rt.config.agent.cwd, 'identity');
      return AVATAR_NAMES.some((n) => { const p = join(dir, n); return existsSync(p) && ownReadable(p, { kind: 'file' }); });
    });
    return { id, name: nameOf(rt), avatar_url: hasAvatar ? `/c/${id}/api/identity/avatar` : null, status: 'ready' };
  });
}

export const companionsRouter = Router();

companionsRouter.get('/', authMiddleware, (_req, res) => {
  res.json(listCompanions());
});
