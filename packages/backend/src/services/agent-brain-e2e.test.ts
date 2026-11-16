// End to end, no stubs between agent.ts and the endpoint: real AgentService, real hooks (the real context builder), an in-memory db,
// and a local HTTP server standing in for the fallback chat endpoint. A Claude primary that is signed out; the fallback answers.
// Regression for: the conversation reaching the fallback twice (history, memory, [Current message], two Revien ingests) and the
// [Context] block telling the fallback it has Bash and `res` (and the install's absolute path).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const h = vi.hoisted(() => ({ bodies: [] as any[], ingests: 0, script: [] as any[] }));

vi.mock('./providers/index.js', async (orig) => ({
  ...(await orig<any>()),
  activeProvider: () => 'claude',
  query: () => {
    const g = (async function* () { throw new Error('Invalid API key · Please run /login'); })();
    return Object.assign(g, { mcpServerStatus: async () => [], interrupt: async () => {} });
  },
}));
vi.mock('./revien.js', () => ({ MEMORY_HEADER: '[memory]', recallForPrompt: async () => 'RECALLED-X', ingestTurn: async () => { h.ingests++; } }));
vi.mock('./mind-client.js', async (orig) => ({ ...(await orig<any>()), mindRecallBlock: async () => '', mindWakeBlock: async () => '', prefetchMind: async () => '' }));
process.env.INTERNAL_TOKEN = 'tok-e2e';
process.env.E2E_FB_KEY = 'sk-e2e-key';

import { loadConfig, PROJECT_ROOT } from '../config.js';
import { initDb, createThread, createMessage } from './db.js';

let server: http.Server;
const PORT = 39877;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sanctum-e2e-'));
  writeFileSync(join(dir, 'sanctum.yaml'), [
    'identity:', '  companion_name: Echo', '  user_name: Sam', '  timezone: UTC',
    'server:', '  host: 127.0.0.1', `  port: ${PORT}`,
    'agent:', `  cwd: ${dir}`, '  provider: claude',
    '  fallback:', '    provider: openai-compat', '    mode: always', '    model: vendor/model-x', `    base_url: http://127.0.0.1:${PORT}/v1`, '    api_key_env: E2E_FB_KEY', '    max_tool_turns: 3', '    unhealthy_minutes: 10', '',
  ].join('\n'));
  loadConfig(join(dir, 'sanctum.yaml'));
  initDb(':memory:');
  createThread({ id: 't1', name: 'T', type: 'named', createdAt: new Date().toISOString() });
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
  server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      if (req.url === '/v1/chat/completions') {
        h.bodies.push(JSON.parse(b));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello again.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
        return;
      }
      if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [] })); return; }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
});
afterAll(() => { server?.close(); });

describe('a Claude primary that fails over: what the fallback is sent', () => {
  it('the conversation once (history x1, memory x1, [Current message] x1), one ingest, an honest tool block, no install path', async () => {
    const t0 = Date.now() - 600_000;
    createMessage({ id: 'm1', threadId: 't1', role: 'user', content: 'UNIQUE-EARLIER-USER-LINE', createdAt: new Date(t0).toISOString() });
    createMessage({ id: 'm2', threadId: 't1', role: 'companion', content: 'UNIQUE-EARLIER-REPLY-LINE', createdAt: new Date(t0 + 1000).toISOString() });
    const { AgentService } = await import('./agent.js');
    const out = await new AgentService().processMessage('t1', 'how are you', { name: 'T', type: 'named' }, { platform: 'web' });
    await new Promise((r) => setTimeout(r, 100));
    expect(out).toBe('Hello again.');
    const u = h.bodies[0].messages[1].content as string;
    const count = (x: string) => u.split(x).length - 1;
    expect(count('UNIQUE-EARLIER-USER-LINE')).toBe(1);
    expect(count('RECALLED-X')).toBe(1);
    expect(count('[Conversation so far]')).toBe(1);
    expect(count('[Current message]')).toBe(1);
    expect(u).toContain('[Current message]\nhow are you');
    expect(h.ingests).toBe(1);

    // honesty: the real context builder's TOOLS block and sidebar sentence never reach the endpoint, nor does the install's path
    const sent = JSON.stringify(h.bodies[0].messages);
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    expect(PROJECT_ROOT).toBe(root);
    expect(sent).not.toContain(PROJECT_ROOT);
    expect(sent).not.toContain('res.mjs');
    expect(sent).not.toContain('run via Bash');
    expect(sent).not.toContain('shows live in the UI sidebar');
    expect(u).toContain('[Context]'); // the orientation itself still rides
    expect(h.bodies[0].messages[0].content).toContain('[Harness]'); // the only tool statement
  });
});
