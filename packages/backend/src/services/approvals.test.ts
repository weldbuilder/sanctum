import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('./embeddings.js', () => ({ embed: vi.fn().mockResolvedValue(new Float32Array(384)), vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)) }));
vi.mock('./vector-cache.js', () => ({ cacheEmbedding: vi.fn(), removeEmbedding: vi.fn() }));
vi.mock('../config.js', () => ({
  getSanctumConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
  }),
  PROJECT_ROOT: '/tmp/test',
}));
import { initDb, createApproval, getApproval, listApprovals, decideApproval } from './db.js';

const now = () => new Date().toISOString();
beforeEach(() => initDb(':memory:'));

describe('approvals', () => {
  it('is pending when created and lists oldest first', () => {
    createApproval({ id: 'a1', what: 'edit identity/profile.md', createdAt: '2026-10-08T10:00:00.000Z' });
    createApproval({ id: 'a2', what: 'delete journal/old.md', detail: 'it is empty', createdAt: '2026-10-08T10:01:00.000Z' });
    expect(getApproval('a1')).toMatchObject({ status: 'pending', thread_id: null, detail: null });
    expect(listApprovals('pending').map(a => a.id)).toEqual(['a1', 'a2']);
  });
  it('settles once, and only from pending', () => {
    createApproval({ id: 'a1', what: 'x', createdAt: now() });
    expect(decideApproval('a1', 'approved', now())).toMatchObject({ status: 'approved' });
    expect(decideApproval('a1', 'denied', now())).toBeNull();
    expect(getApproval('a1')!.status).toBe('approved');
    expect(decideApproval('nope', 'approved', now())).toBeNull();
    expect(listApprovals('pending')).toEqual([]);
  });
  it('can expire', () => {
    createApproval({ id: 'a1', what: 'x', createdAt: now() });
    expect(decideApproval('a1', 'expired', now())!.decided_at).toBeTruthy();
  });
});
