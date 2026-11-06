// GET /api/approvals and POST /api/approvals/:id/decide need a session; POST /api/internal/approvals (the companion's ask) stays internal-token only.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const h = vi.hoisted(() => { process.env.INTERNAL_TOKEN = 'test-internal-token'; return { auth: true, rows: new Map<string, any>() }; });
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, getSanctumConfig: () => ({ identity: { companion_name: 'Echo', user_name: 'Sam' }, integrations: {}, agent: {}, server: {} }) };
});
vi.mock('../services/db.js', async () => {
  const actual = await vi.importActual<typeof import('../services/db.js')>('../services/db.js');
  return {
    ...actual,
    createApproval: (p: any) => { const a = { id: p.id, thread_id: p.threadId ?? null, what: p.what, detail: p.detail ?? null, status: 'pending', created_at: p.createdAt, decided_at: null }; h.rows.set(a.id, a); return a; },
    getApproval: (id: string) => h.rows.get(id) ?? null,
    listApprovals: (status?: string) => [...h.rows.values()].filter((a) => !status || a.status === status),
    decideApproval: (id: string, status: string, at: string) => { const a = h.rows.get(id); if (!a || a.status !== 'pending') return null; a.status = status; a.decided_at = at; return a; },
  };
});
vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../middleware/auth.js')>('../middleware/auth.js');
  return { ...actual, authMiddleware: (_req: any, res: any, next: () => void) => (h.auth ? next() : res.status(401).json({ error: 'unauthorized' })) };
});

import router from './api.js';

let server: Server;
let base = '';
const app = express();
app.use(express.json());
app.use('/api', router);

beforeAll(async () => {
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  h.auth = true; h.rows.clear();
  h.rows.set('a1', { id: 'a1', thread_id: null, what: 'Send the note to Sam', detail: null, status: 'pending', created_at: '2026-01-01T00:00:00Z', decided_at: null });
});
const decide = (id: string, decision: string) => fetch(`${base}/approvals/${id}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });

describe('approvals need a session', () => {
  it('GET /approvals without a session is 401 and lists nothing', async () => {
    h.auth = false;
    const res = await fetch(`${base}/approvals?status=pending`);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('Send the note');
  });
  it('POST /approvals/:id/decide without a session is 401 and leaves the ask pending', async () => {
    h.auth = false;
    expect((await decide('a1', 'approved')).status).toBe(401);
    expect(h.rows.get('a1').status).toBe('pending');
  });
  it('with a session, the list works as before', async () => {
    const res = await fetch(`${base}/approvals?status=pending`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).approvals.map((a: any) => a.id)).toEqual(['a1']);
  });
  it('with a session, deciding works as before', async () => {
    const res = await decide('a1', 'denied');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).approval).toMatchObject({ id: 'a1', status: 'denied' });
    expect((await decide('a1', 'approved')).status).toBe(409);
    expect((await decide('nope', 'approved')).status).toBe(404);
    expect((await decide('a1', 'maybe')).status).toBe(400);
  });
});

describe('POST /api/internal/approvals (the companion ask)', () => {
  it('is 404 without the internal token, session or not', async () => {
    h.auth = false;
    const res = await fetch(`${base}/internal/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ what: 'x' }) });
    expect(res.status).toBe(404);
    expect(h.rows.size).toBe(1);
  });
  it('with the token needs no session, files the ask and returns the answer', async () => {
    h.auth = false; // the ask is not a browser call: no session
    const ask = fetch(`${base}/internal/approvals`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': 'test-internal-token' }, body: JSON.stringify({ what: 'Open the gate' }) });
    for (let i = 0; i < 50 && h.rows.size < 2; i++) await new Promise((r) => setTimeout(r, 20));
    const id = [...h.rows.keys()].find((k) => k !== 'a1')!;
    h.auth = true;
    expect((await decide(id, 'approved')).status).toBe(200);
    const res = await ask;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, status: 'approved', what: 'Open the gate' });
  }, 10_000);
});
