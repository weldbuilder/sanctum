// `res image` flags: --with name,name and --self reach the internal route as references / as_self; plain use sends neither.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const RES = fileURLToPath(new URL('../../../tools/res.mjs', import.meta.url));
let server: Server;
let port = 0;
let bodies: any[] = [];
let reply: Record<string, unknown> = { ok: true, provider: 'runware', model: 'bfl:3@1', references: [], unknown_references: [] };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { bodies.push({ url: req.url, ...JSON.parse(raw || '{}') }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply)); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const res = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>((done) => {
  bodies = [];
  execFile(process.execPath, [RES, ...args], { env: { ...process.env, SANCTUM_HOST: '127.0.0.1', SANCTUM_PORT: String(port), INTERNAL_TOKEN: 't' } }, (e: any, out, err) => done({ code: e?.code ?? 0, out: String(out).trim(), err: String(err).trim() }));
});

describe('res image', () => {
  it('plain use sends the prompt only', async () => {
    const r = await res('image', 'a lamp at dusk');
    expect(r).toMatchObject({ code: 0, out: 'Image generated and posted (runware, bfl:3@1)' });
    expect(bodies[0]).toMatchObject({ url: '/api/internal/image', prompt: 'a lamp at dusk' });
    expect(bodies[0]).not.toHaveProperty('references');
    expect(bodies[0]).not.toHaveProperty('as_self');
  });
  it('--with names (comma separated, trimmed) and --self, in any position, stay out of the prompt', async () => {
    await res('image', 'Echo', 'on', 'the', 'porch', '--with', 'Sam, Lake house', '--self', '--size', '1024x1536');
    expect(bodies[0]).toMatchObject({ prompt: 'Echo on the porch', references: ['Sam', 'Lake house'], as_self: true, size: '1024x1536' });
    await res('image', '--self', 'at the window');
    expect(bodies[0]).toMatchObject({ prompt: 'at the window', as_self: true });
    expect(bodies[0]).not.toHaveProperty('references');
  });
  it('tells which names the library did not have', async () => {
    reply = { ok: true, provider: 'runware', model: 'bfl:3@1', references: ['Sam'], unknown_references: ['Ghost'] };
    const r = await res('image', 'a walk', '--with', 'Sam,Ghost');
    expect(r.out).toBe('Image generated and posted (runware, bfl:3@1)\nNot in your references, skipped: Ghost');
  });
  it('the usage line names the new flags', async () => {
    const r = await res('image', '--self');
    expect(r.code).toBe(2);
    expect(r.err).toContain('[--with name,name] [--self]');
  });
});
