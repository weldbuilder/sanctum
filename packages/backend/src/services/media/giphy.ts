// Giphy search, shared by the companion's [gif:] tag and Telegram's /gif. The key is GIPHY_API_KEY in the (tenant's) .env, read the
// way every background run reads its env (childRunBase). The search term is personal content: never logged above debug.
import { getSanctumConfig } from '../../config.js';
import { childRunBase } from '../../tenancy/child.js';

export type GifRating = 'g' | 'pg' | 'pg-13' | 'r';
export const GIF_RATINGS: GifRating[] = ['g', 'pg', 'pg-13', 'r'];
export const DEFAULT_GIF_RATING: GifRating = 'pg-13';

export interface GifResult { id: string; url: string; preview: string; title: string }
export interface GifSearchOptions { limit?: number; rating?: GifRating; signal?: AbortSignal }

export function giphyKey(): string {
  try { return (childRunBase().GIPHY_API_KEY || '').trim(); } catch { return ''; }
}

/** True when the companion may be offered gifs: a key is present. */
export function giphyOffered(): boolean { return giphyKey() !== ''; }

/** media.gif_rating, falling back to pg-13 for anything unreadable. */
export function configuredGifRating(): GifRating {
  try {
    const r = getSanctumConfig().media?.gif_rating;
    return GIF_RATINGS.includes(r as GifRating) ? (r as GifRating) : DEFAULT_GIF_RATING;
  } catch { return DEFAULT_GIF_RATING; }
}

/** Search Giphy. Returns [] on no results; throws on a missing key, a failed request or a non-ok status (the message carries the status only). */
export async function search(term: string, opts: GifSearchOptions = {}): Promise<GifResult[]> {
  const key = giphyKey();
  if (!key) throw new Error('GIPHY_API_KEY is not set');
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 5), 1), 25);
  const rating = opts.rating && GIF_RATINGS.includes(opts.rating) ? opts.rating : configuredGifRating();
  const url = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(term)}&limit=${limit}&rating=${rating}`;
  const res = await fetch(url, { signal: opts.signal ?? AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Giphy search failed: ${res.status}`);
  const data = await res.json() as { data?: Array<Record<string, any>> };
  const out: GifResult[] = [];
  for (const r of data?.data ?? []) {
    const img = r?.images ?? {};
    const gifUrl = img.downsized?.url || img.original?.url;
    if (!gifUrl) continue;
    out.push({
      id: String(r.id ?? ''),
      url: gifUrl,
      preview: img.fixed_width_small_still?.url || img.fixed_width_still?.url || img.preview_gif?.url || gifUrl,
      title: typeof r.title === 'string' ? r.title.trim() : '',
    });
  }
  return out;
}
