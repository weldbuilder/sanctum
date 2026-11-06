/** Look tab, pure state: the old server-synced colour overrides (Hedgewitch's legacy palette) that can still be stored with no editor left for them. */
import { legacyOverrides } from '../../theme/appearance';

/** How many stored legacy overrides there are (known token keys with usable values: the same reading the applicator uses). */
export function legacyOverrideCount(raw: unknown): number {
  return Object.keys(legacyOverrides(raw)).length;
}

/** The row's sentence, or null when there is nothing to clear (the row is not drawn). */
export function legacyOverrideLine(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  return `Legacy colour overrides are active (${count})`;
}
