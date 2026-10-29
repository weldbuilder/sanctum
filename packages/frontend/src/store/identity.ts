// The companion's name and the person's name, from /api/identity (set in
// sanctum.yaml). Fetched once, shared by every component that labels a
// speaker. Falls back to plain words until the fetch resolves or if it fails.
import { useEffect, useState } from 'react';
import { BASE } from '../lib/base';

export interface Identity { companion_name: string; user_name: string; avatar_url: string | null; skin?: string | null;
  /** The house's time zone (sanctum.yaml identity.timezone): the scheduler fires its wakes in it. */
  timezone?: string | null }

const FALLBACK: Identity = { companion_name: 'Companion', user_name: 'you', avatar_url: null };
/** The companion's picture: their own file if they have one, else the Sanctum mark. */
export const avatarSrc = (id: Identity) => id.avatar_url ?? '/logo.png';
let cached: Identity | null = null;
const listeners = new Set<(id: Identity) => void>();
function publish(id: Identity): void { cached = id; listeners.forEach(l => l(id)); }
let inflight: Promise<Identity> | null = null;

export function loadIdentity(): Promise<Identity> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    const base = BASE;
    inflight = fetch(`${base}/api/identity`, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) return FALLBACK;
        const d = await r.json();
        cached = {
          companion_name: typeof d.companion_name === 'string' && d.companion_name.trim() ? d.companion_name.trim() : FALLBACK.companion_name,
          user_name: typeof d.user_name === 'string' && d.user_name.trim() ? d.user_name.trim() : FALLBACK.user_name,
          avatar_url: typeof d.avatar_url === 'string' && d.avatar_url ? d.avatar_url : null,
          skin: typeof d.skin === 'string' && d.skin ? d.skin : null,
          timezone: typeof d.timezone === 'string' && d.timezone ? d.timezone : null,
        };
        return cached;
      })
      .catch(() => FALLBACK)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function useIdentity(): Identity {
  const [id, setId] = useState<Identity>(cached ?? FALLBACK);
  useEffect(() => {
    let alive = true;
    loadIdentity().then((v) => { if (alive) setId(v); });
    const l = (v: Identity) => { if (alive) setId(v); };
    listeners.add(l);
    return () => { alive = false; listeners.delete(l); };
  }, []);
  return id;
}

/** PATCH /api/identity. Updates every component that reads the identity. Returns whether the server took it. */
export async function patchIdentity(patch: { avatar_url?: string | null; skin?: string | null }): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/identity`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!res.ok) return false;
    const d = await res.json() as { avatar_url?: string | null; skin?: string | null };
    const cur = cached ?? await loadIdentity();
    // An unset avatar falls back to whatever GET reports (a file in the home folder), so refetch rather than guess.
    if ('avatar_url' in patch && !d.avatar_url) { cached = null; publish(await loadIdentity()); }
    else publish({ ...cur, ...(d.avatar_url !== undefined && d.avatar_url ? { avatar_url: d.avatar_url } : {}), skin: d.skin ?? null });
    return true;
  } catch { return false; }
}

/** POST /api/identity/avatar (multipart). Resolves with the stored URL, or an error message. */
export async function uploadAvatar(file: File): Promise<{ url: string } | { error: string }> {
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${BASE}/api/identity/avatar`, { method: 'POST', credentials: 'include', body: fd });
    const d = await res.json().catch(() => ({})) as { avatar_url?: string; error?: string };
    return res.ok && d.avatar_url ? { url: d.avatar_url } : { error: d.error ?? 'Upload failed' };
  } catch { return { error: 'Upload failed' }; }
}
