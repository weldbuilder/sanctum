import { describe, it, expect, vi } from 'vitest';
import {
  resolveEffectiveAttachments,
  type PendingAttachment,
  type PersistedAttachment,
} from './attachmentUtils.js';

// Regression guard for the mobile attach->send drop. The composer's React
// `attachments` state can be wiped by a remount (the photo-picker suspending the
// tab on mobile). The per-thread persisted copy survives. resolveEffectiveAttachments
// MUST fall back to the persisted copy when live state is empty — otherwise the
// attachment is silently dropped and the message sends with no image.

const img = (id: string): PendingAttachment => ({
  fileId: id,
  filename: `${id}.png`,
  contentType: 'image',
  url: `/api/files/${id}`,
  previewUrl: `blob:${id}`,
});

const persistedImg = (id: string): PersistedAttachment => ({
  fileId: id,
  filename: `${id}.png`,
  contentType: 'image',
  url: `/api/files/${id}`,
});

describe('resolveEffectiveAttachments', () => {
  it('uses live state when it has attachments', () => {
    const state = [img('a')];
    const persisted = [persistedImg('b')];
    expect(resolveEffectiveAttachments(state, persisted)).toBe(state);
  });

  it('falls back to persisted when live state is empty (the mobile drop bug)', () => {
    const persisted = [persistedImg('b')];
    const result = resolveEffectiveAttachments([], persisted);
    expect(result).toHaveLength(1);
    expect(result[0].fileId).toBe('b');
  });

  it('returns empty when both sources are empty', () => {
    expect(resolveEffectiveAttachments([], [])).toEqual([]);
  });

  it('prefers live state over persisted when both are non-empty', () => {
    const state = [img('a')];
    const persisted = [persistedImg('b')];
    const result = resolveEffectiveAttachments(state, persisted);
    expect(result).toHaveLength(1);
    expect(result[0].fileId).toBe('a');
  });
});

describe('drafts are per companion', () => {
  it('a draft saved under /c/ada is not read under /c/bea, nor with no prefix, and the legacy key is kept without one', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    const load = async (path: string) => { vi.resetModules(); vi.stubGlobal('location', { pathname: path }); return import('./Composer.js'); };
    try {
      const ada = await load('/c/ada/chat');
      ada.saveDraft('daily-2026-10-26', 'for ada');
      expect([...store.keys()]).toEqual(['c.ada.draft.daily-2026-10-26']);
      const bea = await load('/c/bea/chat');
      expect(bea.loadDraft('daily-2026-10-26')).toBe('');
      bea.saveDraft('daily-2026-10-26', '');
      expect((await load('/c/ada/')).loadDraft('daily-2026-10-26')).toBe('for ada'); // (clearing bea's did not clear ada's)
      const plain = await load('/chat');
      expect(plain.loadDraft('daily-2026-10-26')).toBe('');
      plain.saveDraft('daily-2026-10-26', 'single');
      expect(store.get('sanctum.draft.daily-2026-10-26')).toBe('single');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("onboarding's first message", () => {
  it('is read once and cleared, so it is offered on the first chat only; no session storage means no message', async () => {
    const store = new Map<string, string>([['sanctum.onboarding.prefill', 'Hi Ada. I just moved in.']]);
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    try {
      const { takeOnboardingPrefill } = await import('./Composer.js');
      expect(takeOnboardingPrefill()).toBe('Hi Ada. I just moved in.');
      expect(takeOnboardingPrefill()).toBe('');
      vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); } });
      expect(takeOnboardingPrefill()).toBe('');
    } finally { vi.unstubAllGlobals(); }
  });
});
