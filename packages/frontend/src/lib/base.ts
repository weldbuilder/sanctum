// Where the app's API lives (docs/MULTI-TENANT.md, "Household mode").
//
// In household mode one login opens several companions, and each is served under a path prefix: the page is at /c/<id>/, every companion call is
// /c/<id>/api/..., and the websocket is /c/<id>/ws. The prefix is the ONLY scope: it is read from the address of this tab, so two tabs hold two
// companions, and nothing (cookie, header, local storage) says which one is active. With no prefix (a single install, a per-tenant host, or the
// house's own hallway) COMPANION_PREFIX is '' and BASE is exactly what it always was.
const DEV_BASE = 'http://127.0.0.1:3099';

/** `/c/<id>` for a path that starts with one (a tenant id: a-z, 0-9, -, up to 32, not starting with -), else ''. */
export function companionPrefixOf(pathname: string): string {
  const m = pathname.match(/^\/c\/([a-z0-9][a-z0-9-]{0,31})(?=\/|$)/);
  return m ? `/c/${m[1]}` : '';
}

/** The browser-storage key for `name` ('draft.<thread>'), for state that belongs to ONE companion (drafts, unsent attachments, collapsed months). One origin serves
 *  every companion, so without a prefix the key is exactly the legacy `sanctum.<name>` (single installs and per-tenant hosts keep their saved state); under `/c/<id>` it is
 *  `c.<id>.<name>`, so two companions' same-named threads never share a key. House-level state (theme, skin, panel width, update banners) keeps its plain key. */
export function storageKeyFor(prefix: string, name: string): string {
  return `${prefix ? prefix.slice(1).replace('/', '.') : 'sanctum'}.${name}`;
}

export const COMPANION_PREFIX = typeof location === 'undefined' ? '' : companionPrefixOf(location.pathname);
export const storageKey = (name: string): string => storageKeyFor(COMPANION_PREFIX, name);
/** Prepend to a companion route (`${BASE}/api/threads`): the dev backend address in dev, then the companion prefix. */
export const BASE = import.meta.env.DEV ? `${DEV_BASE}${COMPANION_PREFIX}` : COMPANION_PREFIX;
/** The house routes (sign-in, the companion list, the house's first run) are never under a prefix. */
export const HOUSE_BASE = import.meta.env.DEV ? DEV_BASE : '';
