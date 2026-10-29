import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));
vi.mock('./vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../config.js', () => ({
  getSanctumConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import { initDb, createCanvas, getCanvas, updateCanvasContent } from './db.js';

const now = () => new Date().toISOString();

beforeEach(() => {
  initDb(':memory:');
  createCanvas({ id: 'cv', title: 'Draft', content: 'v0', contentType: 'text', createdBy: 'user', createdAt: now() });
});

describe('canvas optimistic versioning', () => {
  it('starts at version 0 and bumps on every content write', () => {
    expect(getCanvas('cv')!.version).toBe(0);
    expect(updateCanvasContent('cv', 'v1', now())).toEqual({ ok: true, version: 1 });
    expect(updateCanvasContent('cv', 'v2', now(), 1)).toEqual({ ok: true, version: 2 });
    expect(getCanvas('cv')!.content).toBe('v2');
  });

  it('refuses a write carrying a stale version and returns the current row', () => {
    // Two editors read version 0. The companion writes first; the browser's
    // save, still carrying version 0, must not overwrite it.
    expect(updateCanvasContent('cv', 'companion wrote this', now(), 0).ok).toBe(true);
    const refused = updateCanvasContent('cv', 'browser wrote this', now(), 0);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.canvas?.content).toBe('companion wrote this');
      expect(refused.canvas?.version).toBe(1);
    }
    expect(getCanvas('cv')!.content).toBe('companion wrote this');
  });

  it('writes unconditionally when no version is given, still bumping it', () => {
    updateCanvasContent('cv', 'a', now(), 0);
    expect(updateCanvasContent('cv', 'b', now())).toEqual({ ok: true, version: 2 });
    expect(getCanvas('cv')!.content).toBe('b');
  });

  it('reports a missing canvas as not ok with canvas null', () => {
    expect(updateCanvasContent('nope', 'x', now())).toEqual({ ok: false, canvas: null });
  });
});
