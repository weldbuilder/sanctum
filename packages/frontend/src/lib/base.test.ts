import { describe, it, expect } from 'vitest';
import { storageKeyFor, storageKey, companionPrefixOf, COMPANION_PREFIX, BASE, HOUSE_BASE } from './base';

describe('companionPrefixOf', () => {
  it('reads /c/<id> from the front of the path, with or without more path', () => {
    expect(companionPrefixOf('/c/ada/')).toBe('/c/ada');
    expect(companionPrefixOf('/c/ada')).toBe('/c/ada');
    expect(companionPrefixOf('/c/ada/chat/today')).toBe('/c/ada');
    expect(companionPrefixOf('/c/a-b-2/home')).toBe('/c/a-b-2');
    expect(companionPrefixOf(`/c/${'a'.repeat(32)}/`)).toBe(`/c/${'a'.repeat(32)}`);
  });
  it('is empty with no prefix, and for anything that is not a tenant id', () => {
    for (const p of ['/', '', '/chat', '/c', '/c/', '/cc/ada/', '/x/c/ada/', '/c/-ada/', '/c/Ada/', '/c/a_b/', '/c/ada.x/', `/c/${'a'.repeat(33)}/`]) {
      expect(companionPrefixOf(p), p).toBe('');
    }
  });
  it('has no prefix in a test (no address), so BASE is exactly the old constant', () => {
    expect(COMPANION_PREFIX).toBe('');
    expect(BASE).toBe(HOUSE_BASE);
    expect(HOUSE_BASE).toBe(import.meta.env.DEV ? 'http://127.0.0.1:3099' : '');
  });
});

describe('storageKey', () => {
  it('is exactly the legacy key with no prefix, and differs per companion under one', () => {
    expect(storageKeyFor('', 'draft.daily-2026-10-26')).toBe('sanctum.draft.daily-2026-10-26');
    expect(storageKeyFor('', 'attach.t1')).toBe('sanctum.attach.t1');
    expect(storageKeyFor('', 'month.2026-09')).toBe('sanctum.month.2026-09');
    expect(storageKey('draft.x')).toBe('sanctum.draft.x'); // (no address in a test)
    const ada = storageKeyFor('/c/ada', 'draft.daily-2026-10-26');
    expect(ada).toBe('c.ada.draft.daily-2026-10-26');
    expect(ada).not.toBe(storageKeyFor('/c/bea', 'draft.daily-2026-10-26'));
    expect(ada).not.toBe(storageKeyFor('', 'draft.daily-2026-10-26'));
  });
});
