// A fake sanctum-mind for tests, shaped by the real contract: GET /health is open and answers
// { ok, receipt: { projection: { verbs, db, version, schema } } } (503 with db "down" when the
// database is out); POST /verbs/<name> needs `Authorization: Bearer <key>` (401 unauthorized), a body
// whose mind_id matches the bearer's mind (403 forbidden), and answers { ok: true, receipt } or
// { ok: false, error: { code, message } }. Only the read verbs the client calls are modelled.
import http from 'node:http';

export type FakeMode = 'normal' | 'http500' | 'html' | 'hang' | 'dbdown' | 'healthhang' | 'verbfail';
// verbfail: /health answers fine, the verb answers 500 (a service that is up but cannot do its work).

export interface FakeRequest { method: string; path: string; auth?: string; body: unknown }

const MIND_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const err = (code: string, message: string, field?: string) => ({ ok: false, error: field === undefined ? { code, message } : { code, message, field } });

export async function startFakeMind(opts: { key: string; mindId: string; version?: string; schema?: string }) {
  const state = { mode: 'normal' as FakeMode, delayMs: 0, reqs: [] as FakeRequest[] };
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = raw;
    try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { /* keep the text */ }
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    state.reqs.push({ method: req.method ?? '', path, auth: req.headers.authorization, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': typeof payload === 'string' ? 'text/html' : 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    if (path === '/health') {
      if (state.mode === 'healthhang') return;
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (req.method !== 'GET') return send(405, err('invalid_input', 'method not allowed'));
      if (state.mode === 'html') return send(200, '<html>Welcome to nginx</html>');
      if (state.mode === 'http500') return send(500, err('storage', 'storage operation failed'));
      const down = state.mode === 'dbdown';
      return send(down ? 503 : 200, { ok: true, receipt: { projection: { verbs: 26, db: down ? 'down' : 'up', version: opts.version ?? '2.0.0-test', schema: down ? null : opts.schema ?? '0007_x' }, warnings: [] } });
    }
    const m = /^\/verbs\/([^/]+)$/.exec(path);
    if (!m || req.method !== 'POST') return send(404, err('not_found', 'no such route'));
    const bearer = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? '').trim())?.[1]?.trim();
    if (bearer !== opts.key) return send(401, err('unauthorized', 'unknown or missing bearer'));
    if (m[1] !== 'mind_thread') return send(404, err('not_found', `unknown verb: ${m[1]}`));
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (typeof b.mind_id !== 'string' || !MIND_ID.test(b.mind_id)) return send(400, err('invalid_input', 'invalid mind_id', 'mind_id'));
    if (b.operation !== 'list') return send(400, err('invalid_input', 'this fake only models mind_thread list', 'operation'));
    if (b.mind_id !== opts.mindId) return send(403, err('forbidden', `bearer may not act on mind ${b.mind_id}`));
    if (state.mode === 'hang') return;
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.mode === 'http500' || state.mode === 'verbfail') return send(500, err('storage', 'storage operation failed'));
    if (state.mode === 'html') return send(200, '<html>Welcome to nginx</html>');
    return send(200, { ok: true, receipt: { projection: { threads: [] }, warnings: [] } });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    state, port, root: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
