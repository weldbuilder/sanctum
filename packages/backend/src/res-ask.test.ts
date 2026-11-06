// `res ask` with a capability: the short form (res ask web 30), the long form (--capability / --window), and the plain ask unchanged.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const RES = fileURLToPath(new URL('../../../tools/res.mjs', import.meta.url));
let server: Server;
let port = 0;
let bodies: any[] = [];
let answer = 'approved';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { bodies.push(JSON.parse(raw || '{}')); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'a', status: answer, what: 'x' })); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const res = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>((done) => {
  bodies = [];
  execFile(process.execPath, [RES, ...args], { env: { ...process.env, SANCTUM_HOST: '127.0.0.1', SANCTUM_PORT: String(port), INTERNAL_TOKEN: 't', RES_ASK_TIMEOUT_MS: '5000' } }, (e: any, out, err) => done({ code: e?.code ?? 0, out: String(out).trim(), err: String(err).trim() }));
});

describe('res ask', () => {
  it('a plain ask is unchanged: what and detail, no capability', async () => {
    const r = await res('ask', 'send the email', 'to Sam');
    expect(r).toMatchObject({ code: 0, out: 'approved' });
    expect(bodies[0]).toMatchObject({ what: 'send the email', detail: 'to Sam' });
    expect(bodies[0]).not.toHaveProperty('capability');
    expect(bodies[0]).not.toHaveProperty('window_minutes');
  });
  it('short form: res ask web 30', async () => {
    const r = await res('ask', 'web', '30');
    expect(r.out).toBe('approved');
    expect(bodies[0]).toMatchObject({ what: 'web for 30 minutes', capability: 'web', window_minutes: 30 });
  });
  it('short form: res ask shell on leaves it on (window null)', async () => {
    await res('ask', 'shell', 'on');
    expect(bodies[0]).toMatchObject({ capability: 'shell', window_minutes: null });
  });
  it('long form with a reason', async () => {
    await res('ask', 'I need to read the docs', '--capability', 'web', '--window', '15');
    expect(bodies[0]).toMatchObject({ what: 'I need to read the docs', capability: 'web', window_minutes: 15 });
  });
  it('a denied ask exits 1 and prints denied', async () => {
    answer = 'denied';
    try { expect(await res('ask', 'web', '30')).toMatchObject({ code: 1, out: 'denied' }); } finally { answer = 'approved'; }
  });
  it('refuses an unknown capability or a bad window without calling the server', async () => {
    expect((await res('ask', 'why', '--capability', 'root')).err).toMatch(/Unknown capability "root"/);
    expect((await res('ask', 'why', '--capability', 'web', '--window', 'soon')).err).toMatch(/--window is a number of minutes/);
    expect(bodies).toEqual([]);
  });
});
