import { describe, expect, it } from 'vitest';
import { legacyOverrideCount, legacyOverrideLine } from './legacyOverridesState';

describe('legacy colour overrides row', () => {
  it('counts only stored, usable overrides', () => {
    expect(legacyOverrideCount({})).toBe(0);
    expect(legacyOverrideCount(null)).toBe(0);
    expect(legacyOverrideCount([])).toBe(0);
    expect(legacyOverrideCount({ '--bg-primary': '#123456', '--text-primary': '#fedcba' })).toBe(2);
    expect(legacyOverrideCount({ '--bg-primary': '', '--not-a-token': '#fff', '--text-primary': 7 })).toBe(0);
  });
  it('draws a sentence only when there is something to clear', () => {
    expect(legacyOverrideLine(0)).toBeNull();
    expect(legacyOverrideLine(NaN)).toBeNull();
    expect(legacyOverrideLine(3)).toBe('Legacy colour overrides are active (3)');
  });
});
