import { describe, it, expect } from 'vitest';
import { clipPrompt, generateError, readGenerated, shareError, statusReason } from './imageGen';

describe('image generation helpers', () => {

  it('turns status into one reason line, or none when offered', () => {
    expect(statusReason(null)).toBeNull();
    expect(statusReason({ configured: true, offered: true })).toBeNull();
    expect(statusReason({ configured: false, offered: false, reason: 'not_configured' }))
      .toBe("Image generation isn't set up yet. Ask your companion or see docs/CONFIGURATION.md → imagegen.");
    expect(statusReason({ configured: true, offered: false, reason: 'app_write_off' }))
      .toBe('Companion app writes are off in Settings → permissions');
  });


  it('maps provider error classes to a line', () => {
    const e = (detail: string) => generateError(502, { error: 'provider_error', provider: 'runware', detail });
    expect(e('content_blocked')).toBe('The provider refused this prompt');
    expect(e('auth')).toBe('Provider key was rejected');
    expect(e('billing')).toBe('Provider account is out of credit');
    expect(e('rate_limit')).toBe('Rate limited, try again in a minute');
    expect(e('timeout')).toBe('The provider took too long');
    expect(e('server')).toBe('Generation failed (runware)');
    expect(e('network')).toBe('Generation failed (runware)');
    expect(generateError(504, null)).toBe('The provider took too long');
    expect(generateError(400, { error: 'prompt_required' })).toBe('Write a prompt first');
    expect(generateError(403, null)).toContain('Companion app writes are off');
    expect(generateError(409, null)).toContain("isn't set up");
    expect(generateError(500, null)).toBe('Generation failed (provider)');
  });

  it('says what a failed share means', () => {
    expect(shareError(404)).toBe('No open chat to share into');
    expect(shareError(404, { error: 'thread_not_found' })).toBe('No open chat to share into');
    expect(shareError(404, { error: 'file_not_found' })).toBe('That file is gone');
    expect(shareError(500)).toBe('Could not share to chat (500)');
  });

  it('reads generated items newest first and tolerates both list shapes', () => {
    const files = [
      { fileId: 'a', filename: 'a.png', size: 5, createdAt: '2026-01-01T00:00:00Z', meta: { source: 'image-gen', prompt: 'old', provider: 'runware', createdAt: '2026-01-01T00:00:00Z' } },
      { fileId: 'b', filename: 'b.png', size: 7, createdAt: '2026-02-01T00:00:00Z', meta: { prompt: 'new', provider: 'replicate', createdAt: '2026-02-01T00:00:00Z' } },
      { filename: 'no-id.png' },
    ];
    const urlOf = (id: string) => `/api/files/${id}`;
    const a = readGenerated({ files }, urlOf);
    expect(a.map(x => x.id)).toEqual(['b', 'a']);
    expect(a[0]).toMatchObject({ url: '/api/files/b', prompt: 'new', provider: 'replicate', size: 7 });
    expect(readGenerated(files, urlOf)).toHaveLength(2);
    expect(readGenerated(null, urlOf)).toEqual([]);
  });

  it('clips a prompt to one line', () => {
    expect(clipPrompt('a\n  b')).toBe('a b');
    expect(clipPrompt('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });
});
