import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { globalErrorHandler } from './error-handler.js';

const MARKER = 'DRAFT-KEY-MARKER-91ac';
let server: import('node:http').Server;
let base = '';
let lines: string[];

beforeEach(async () => {
  lines = [];
  const grab = (...a: unknown[]) => { lines.push(a.map((x) => (x instanceof Error ? `${x.stack ?? x.message} ${JSON.stringify(x, Object.getOwnPropertyNames(x))}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(grab);
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.post('/api/settings', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/boom', () => { throw new Error('boom'); });
  app.use(globalErrorHandler);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { vi.restoreAllMocks(); await new Promise<void>((r) => server.close(() => r())); });

const post = (body: string) => fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('global error handler', () => {
  it('answers a malformed JSON body with 400 bad_json and logs the route and type, never the body', async () => {
    const res = await post(`{"api_key": "${MARKER}", oops`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_json' });
    const text = lines.join('\n');
    expect(text).not.toContain(MARKER);
    expect(text).toContain('/api/settings');
    expect(text).toContain('entity.parse.failed');
  });

  it('treats the other entity errors the same way (too large)', async () => {
    const res = await post(JSON.stringify({ api_key: MARKER, pad: 'x'.repeat(3000) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_json' });
    expect(lines.join('\n')).not.toContain(MARKER);
    expect(lines.join('\n')).toContain('entity.too.large');
  });

  it('still answers any other error with 500 and logs it', async () => {
    const res = await fetch(`${base}/api/boom`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(lines.join('\n')).toContain('boom');
  });

  it('a good body is untouched', async () => {
    expect((await post('{"a":1}')).status).toBe(200);
  });
});
