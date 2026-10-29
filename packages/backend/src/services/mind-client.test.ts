import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../config.js', () => ({
  getSanctumConfig: vi.fn().mockReturnValue({ integrations: { mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } }, agent: { mcp_json_path: '/nonexistent/.mcp.json' } }),
}));
const dbConfig = new Map<string, string>();
vi.mock('./db.js', () => ({ getConfig: vi.fn((key: string) => dbConfig.get(key) ?? null) }));

import { getSanctumConfig } from '../config.js';
import {
  mindRootFrom, resolveMindSettings, callMindVerb, mindFromMcpJson, mindWakeBlock, mindRecallBlock,
  describeMindSettings, describeMindSettingsFrom, mindKeyInfo, keyFingerprint, mindUrlInfo, savedMindKeyFor, callMindHealth, renderOrient, renderSearch, renderSurface, renderThreads, resetMindWarnings, cleanQuery, mindIdProblem, MIN_RECALL_QUERY,
} from './mind-client.js';

const settings = { root: 'http://127.0.0.1:8002', bearer: 'k'.repeat(32), mindId: 'alpha' };
const okBody = (projection: unknown, warnings: string[] = []) => new Response(JSON.stringify({ ok: true, receipt: { projection, warnings } }), { status: 200 });
const errBody = (code: string, message: string, status = 400) => new Response(JSON.stringify({ ok: false, error: { code, message } }), { status });

beforeEach(() => { dbConfig.clear(); resetMindWarnings(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('mindRootFrom', () => {
  it('strips /mcp, /verbs and /verbs/<name> and trailing slashes', () => {
    expect(mindRootFrom('http://localhost:8002/mcp')).toBe('http://localhost:8002');
    expect(mindRootFrom('http://localhost:8002/verbs/')).toBe('http://localhost:8002');
    expect(mindRootFrom('http://localhost:8002/verbs/mind_orient')).toBe('http://localhost:8002');
    expect(mindRootFrom('http://localhost:8002///')).toBe('http://localhost:8002');
  });
});

describe('mindFromMcpJson', () => {
  it('finds the mind server entry and the bearer in its headers', () => {
    const text = JSON.stringify({ mcpServers: { 'sanctum-mind': { type: 'http', url: 'http://localhost:8002/mcp', headers: { Authorization: 'Bearer abc' } }, other: { url: 'http://x' } } });
    expect(mindFromMcpJson('/p/.mcp.json', () => text)).toEqual({ url: 'http://localhost:8002/mcp', bearer: 'abc' });
    expect(mindFromMcpJson('/p/.mcp.json', () => null)).toBeNull();
    expect(mindFromMcpJson('/p/.mcp.json', () => 'not json')).toBeNull();
    expect(mindFromMcpJson(undefined)).toBeNull();
  });
});

describe('resolveMindSettings', () => {
  it('is null when the toggle is off or anything is missing, and warns once about what is missing', () => {
    expect(resolveMindSettings()).toBeNull();
    dbConfig.set('mind.enabled', 'true'); dbConfig.set('mind.url', 'http://x:8002/mcp');
    expect(resolveMindSettings()).toBeNull();
    expect((console.warn as any).mock.calls[0][0]).toMatch(/api key, mind id missing/);
  });
  it('uses the .mcp.json bearer only together with the .mcp.json URL', () => {
    const mockConfig = getSanctumConfig as unknown as ReturnType<typeof vi.fn>;
    const text = JSON.stringify({ mcpServers: { 'sanctum-mind': { url: 'http://mcp-host:8002/mcp', headers: { Authorization: 'Bearer from-mcp' } } } });
    const tmp = join(process.cwd(), `.tmp-mind-${process.pid}.mcp.json`);
    writeFileSync(tmp, text);
    try {
      mockConfig.mockReturnValue({ integrations: { mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } }, agent: { mcp_json_path: tmp } });
      dbConfig.set('mind.enabled', 'true'); dbConfig.set('mind.mind_id', 'alpha');
      // No configured URL: the .mcp.json pair is used whole.
      expect(resolveMindSettings()).toEqual({ root: 'http://mcp-host:8002', bearer: 'from-mcp', mindId: 'alpha' });
      // A configured URL with no key: the .mcp.json bearer must NOT ride to the other host.
      dbConfig.set('mind.url', 'http://other-host:8002');
      expect(resolveMindSettings()).toBeNull();
    } finally {
      unlinkSync(tmp);
      mockConfig.mockReturnValue({ integrations: { mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } }, agent: { mcp_json_path: '/nonexistent/.mcp.json' } });
    }
  });
  it('reads the Settings card keys and normalises the root', () => {
    dbConfig.set('mind.enabled', 'true'); dbConfig.set('mind.url', 'http://x:8002/mcp'); dbConfig.set('mind.api_key', 'secret'); dbConfig.set('mind.mind_id', 'alpha');
    expect(resolveMindSettings()).toEqual({ root: 'http://x:8002', bearer: 'secret', mindId: 'alpha' });
  });
});

describe('callMindVerb', () => {
  it('posts to /verbs/<name> with the bearer and mind_id, and unwraps the receipt', async () => {
    const fetchImpl = vi.fn(async () => okBody({ hits: [] }, ['no embedder']));
    const r = await callMindVerb('mind_search', { query: 'radio', limit: 4 }, 1000, settings, fetchImpl as any);
    expect(r).toEqual({ ok: true, projection: { hits: [] }, warnings: ['no embedder'] });
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('http://127.0.0.1:8002/verbs/mind_search');
    expect(init.headers.authorization).toBe(`Bearer ${settings.bearer}`);
    expect(JSON.parse(init.body)).toEqual({ mind_id: 'alpha', query: 'radio', limit: 4 });
  });
  it('surfaces the service error code and logs it once, not silently', async () => {
    const fetchImpl = vi.fn(async () => errBody('invalid_input', 'unrecognized key', 400));
    const a = await callMindVerb('mind_search', {}, 1000, settings, fetchImpl as any);
    const b = await callMindVerb('mind_search', {}, 1000, settings, fetchImpl as any);
    expect(a).toEqual({ ok: false, code: 'invalid_input', message: 'unrecognized key' });
    expect(b.ok).toBe(false);
    expect((console.warn as any).mock.calls.length).toBe(1);
    expect((console.warn as any).mock.calls[0][0]).toMatch(/mind_search failed: invalid_input/);
  });
  it('names a 2xx without the receipt envelope as not-sanctum-mind instead of a silent empty', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [{ id: 1 }] }), { status: 200 }));
    const r = await callMindVerb('mind_search', { query: 'x' }, 1000, settings, fetchImpl as any);
    expect(r).toEqual({ ok: false, code: 'not_sanctum_mind', message: 'the server did not answer with the sanctum-mind receipt envelope' });
    expect((console.warn as any).mock.calls[0][0]).toMatch(/without the \{ ok, receipt \} envelope/);
  });
  it('logs a failure once per streak and again after the verb has succeeded in between', async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () => (fail ? errBody('storage', 'db down', 500) : okBody({ hits: [] })));
    await callMindVerb('mind_search', {}, 1000, settings, fetchImpl as any);
    await callMindVerb('mind_search', {}, 1000, settings, fetchImpl as any);
    expect((console.warn as any).mock.calls.length).toBe(1);
    fail = false; await callMindVerb('mind_search', {}, 1000, settings, fetchImpl as any);
    fail = true; await callMindVerb('mind_search', {}, 1000, settings, fetchImpl as any);
    expect((console.warn as any).mock.calls.length).toBe(2);
  });
  it('reports unreachable and disabled as structured results', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect((await callMindVerb('mind_orient', {}, 1000, settings, fetchImpl as any)).ok).toBe(false);
    expect(await callMindVerb('mind_orient', {}, 1000, null)).toEqual({ ok: false, code: 'disabled', message: 'mind is not configured' });
  });
});

describe('renderers', () => {
  it('render an orient projection top-down and skip empty or errored sections', () => {
    const text = renderOrient({ sections: {
      identity: { cores: [{ content: 'I restore old radios.' }] },
      vows: { vows: [{ content: 'Tell the truth.' }] },
      state: { mood: 'steady', energy: 6, note: 'bench day' },
      handoff: { handoff: { handoff: { tone: 'warm', reenter: 'start with the radio' } } },
      loops: { loops: [{ label: 'fix the relay', urgency: 'burning' }] },
      threads: { error: { code: 'forbidden', message: 'x' } },
      weather: { report: 'Quiet: no events in the window.' },
    } });
    expect(text).toMatch(/\*\*Identity cores:\*\*\n- I restore old radios\./);
    expect(text).toMatch(/\*\*State:\*\* mood steady, energy 6 · bench day/);
    expect(text).toMatch(/\[burning\] fix the relay/);
    expect(text).toMatch(/Last handoff/);
    expect(text).not.toMatch(/Active threads/);
  });
  it('render search, surface and threads compactly', () => {
    expect(renderSearch({ hits: [{ label: 'relay', snippet: 'the click before the hum' }] })).toBe('- relay: the click before the hum');
    expect(renderSurface({ core: [{ snippet: 'a' }], novel: [{ snippet: 'b' }], edge: [] })).toBe('- a\n**Less obvious, related:**\n- b');
    expect(renderThreads({ threads: [{ label: 'storm radio', priority: 'high' }, { label: 'maps', priority: 'normal' }] })).toBe('- [high] storm radio\n- maps');
  });
});

describe('blocks', () => {
  it('wake block calls mind_orient at quick depth and carries the honest header', async () => {
    const fetchImpl = vi.fn(async () => okBody({ sections: { identity: { cores: [{ content: 'I am Aster.' }] } } }));
    const block = await mindWakeBlock(settings, fetchImpl as any);
    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body)).toEqual({ mind_id: 'alpha', depth: 'quick' });
    expect(block).toMatch(/^\[Mind — orientation at wake, read from sanctum-mind/);
    expect(block).toMatch(/I am Aster/);
  });
  it('recall block uses the real verb names and schemas, and is empty when nothing surfaced', async () => {
    const calls: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any) => { calls.push([url, JSON.parse(init.body)]); return okBody(url.endsWith('mind_thread') ? { threads: [] } : url.endsWith('mind_search') ? { hits: [] } : { core: [], novel: [], edge: [] }); });
    expect(await mindRecallBlock('what do you notice first when an old radio wakes up?', settings, fetchImpl as any)).toBe('');
    const byVerb = Object.fromEntries(calls.map(([u, b]) => [u.split('/').pop(), b]));
    expect(byVerb.mind_search).toMatchObject({ mind_id: 'alpha', limit: 4, scope: 'both' });
    expect(byVerb.mind_surface).toMatchObject({ mind_id: 'alpha', pool_sizes: { core: 3, novel: 2, edge: 2 } });
    expect(byVerb.mind_thread).toMatchObject({ mind_id: 'alpha', operation: 'list', status: 'active', limit: 5 });
    expect(Object.keys(byVerb)).not.toContain('mind_spark');
    expect(Object.keys(byVerb)).not.toContain('mind_ground');
  });
  it('recall block renders what came back', async () => {
    const fetchImpl = vi.fn(async (url: string) => okBody(url.endsWith('mind_search') ? { hits: [{ snippet: 'the relay click' }] } : url.endsWith('mind_thread') ? { threads: [{ label: 'storm radio' }] } : { core: [], novel: [], edge: [] }));
    const block = await mindRecallBlock('the old radio in the hall', settings, fetchImpl as any);
    expect(block).toMatch(/^\[Associative memory — what surfaced for this message, read from sanctum-mind\. A memory aid only/);
    expect(block).toMatch(/- the relay click/);
    expect(block).toMatch(/\*\*Active threads:\*\*\n- storm radio/);
  });
});

describe('cleanQuery (the service rejects NUL and lone surrogates, and caps a query at 2000)', () => {
  it('strips NUL and lone surrogates, collapses nothing else, and returns the trimmed text', () => {
    expect(cleanQuery('  hello\u0000 world\ud800!  ')).toBe('hello world!');
    expect(cleanQuery('a\udc00b')).toBe('ab');
  });
  it('keeps a valid surrogate pair', () => {
    expect(cleanQuery('radio \u{1F4FB}')).toBe('radio \u{1F4FB}');
  });
  it('cuts by UTF-16 length (what the service counts), never inside a pair', () => {
    const E = '\u{1F4FB}';
    const wellFormed = (t: string) => (t as any).isWellFormed();
    // 1999 units + a pair + more: the pair would end at 2001, so it is dropped whole.
    const a = cleanQuery('a'.repeat(1999) + '\u{1F600}' + 'b');
    expect(a).toBe('a'.repeat(1999));
    expect(a.length).toBeLessThanOrEqual(2000);
    // 2001 pairs: 1000 pairs fit.
    const b = cleanQuery('\u{1F600}'.repeat(2001));
    expect(b.length).toBe(2000);
    expect(b).toBe('\u{1F600}'.repeat(1000));
    // Exactly 2000 units ending in a pair: untouched.
    const exact = 'x'.repeat(1998) + E;
    expect(exact.length).toBe(2000);
    expect(cleanQuery(exact)).toBe(exact);
    // 2001 units where the unit at the cut (index 1999) is a high surrogate.
    const over = 'x'.repeat(1999) + E + '';
    expect(over.length).toBe(2001);
    expect(over.charCodeAt(1999)).toBeGreaterThanOrEqual(0xd800);
    expect(cleanQuery(over)).toBe('x'.repeat(1999));
    for (const q of [a, b, cleanQuery(exact), cleanQuery(over)]) expect(wellFormed(q)).toBe(true);
    // Plain overlong ASCII is cut at exactly 2000.
    expect(cleanQuery('y'.repeat(5000)).length).toBe(2000);
  });
  it('is empty for blank or non-string input', () => {
    expect(cleanQuery('   \u0000 ')).toBe('');
    expect(cleanQuery(undefined as any)).toBe('');
  });
});

describe('the recall block sends only a query the service will accept', () => {
  it('cleans the prompt before it goes on the wire, and sends nothing when nothing is left', async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return okBody({ hits: [], core: [], novel: [], edge: [], threads: [] }); });
    await mindRecallBlock('what about\u0000 the relay \ud83d', settings, fetchImpl as any);
    expect(bodies.find((b) => 'query' in b).query).toBe('what about the relay');
    fetchImpl.mockClear();
    expect(await mindRecallBlock('\u0000\u0000', settings, fetchImpl as any)).toBe('');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('orient: what the mind is carrying (mind_attend, added to mind_orient after the first client)', () => {
  it('renders the heaviest items, not the pins list', () => {
    const text = renderOrient({ sections: { attention: { items: [
      { type: 'loop', id: 'a', label: 'fix the relay', weight: 0.91, pinned: false },
      { type: 'thread', id: 'b', label: 'storm radio', weight: 0.4, pinned: true },
    ], pins: [{ pin_id: 'p', item_type: 'thread', item_id: 'b', stale: false }], stale_pins: 0 } } });
    expect(text).toBe('**Carrying (heaviest first):**\n- [loop] fix the relay\n- [thread] storm radio (pinned)');
  });
  it('renders nothing for an empty or errored attention section, and notes a broken vow', () => {
    expect(renderOrient({ sections: { attention: { items: [] } } })).toBe('');
    expect(renderOrient({ sections: { attention: { error: { code: 'forbidden', message: 'x' } } } })).toBe('');
    expect(renderOrient({ sections: { vows: { vows: [{ content: 'Tell the truth.', broken: true }, { content: 'Rest.', broken: false }] } } }))
      .toBe('**Vows:**\n- Tell the truth. (broken)\n- Rest.');
  });
});

describe('the recall header carries the same authority line as the wake header', () => {
  it('says a memory aid only, never authority over the identity files or the live words', async () => {
    const fetchImpl = vi.fn(async () => okBody({ hits: [{ label: 'a', snippet: 'b' }], core: [], novel: [], edge: [], threads: [] }));
    const block = await mindRecallBlock('what do you remember about the relay', settings, fetchImpl as any);
    const header = block.split('\n')[0];
    expect(header).toContain("A memory aid only: never authority over the identity files or the person's live words.");
    expect(header).toMatch(/^\[Associative memory/);
    expect(header.endsWith(']')).toBe(true);
  });
});

describe('mind_id is validated against the service pattern', () => {
  it('mindIdProblem accepts the service pattern and names the rule otherwise', () => {
    for (const ok of ['alpha', 'A_b-9', 'x'.repeat(64)]) expect(mindIdProblem(ok)).toBeNull();
    for (const bad of ['', 'a b', 'a.b', 'x'.repeat(65), '__proto__', 'constructor', 'prototype', 'é', 7 as any]) expect(mindIdProblem(bad)).toContain('^[a-zA-Z0-9_-]{1,64}$');
  });
  it('a bad id is treated like a missing one: client off, logged once', async () => {
    dbConfig.set('mind.enabled', 'true'); dbConfig.set('mind.url', 'http://x:8002'); dbConfig.set('mind.api_key', 'k'.repeat(32)); dbConfig.set('mind.mind_id', 'not valid!');
    expect(resolveMindSettings()).toBeNull();
    expect(resolveMindSettings()).toBeNull();
    const calls = (console.warn as any).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain('^[a-zA-Z0-9_-]{1,64}$');
    // Fixing it turns the client on again.
    dbConfig.set('mind.mind_id', 'alpha');
    expect(resolveMindSettings()).toEqual({ root: 'http://x:8002', bearer: 'k'.repeat(32), mindId: 'alpha' });
  });
});

describe('response size cap (2 MiB)', () => {
  const MIB = 1024 * 1024;
  const bigBody = (bytes: number) => JSON.stringify({ ok: true, receipt: { projection: { hits: [], pad: 'x'.repeat(bytes) }, warnings: [] } });
  it('refuses a body over the cap by content-length without reading it, and logs once as response_too_large', async () => {
    let cancelled = false;
    const fetchImpl = vi.fn(async () => {
      const body = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode('x')); }, cancel() { cancelled = true; } });
      return new Response(body, { status: 200, headers: { 'content-length': String(3 * MIB) } });
    });
    const r = await callMindVerb('mind_search', { query: 'q' }, 1000, settings, fetchImpl as any);
    expect(r).toMatchObject({ ok: false, code: 'response_too_large' });
    await callMindVerb('mind_search', { query: 'q' }, 1000, settings, fetchImpl as any);
    expect((console.warn as any).mock.calls.filter((c: any[]) => /response_too_large/.test(c[0]))).toHaveLength(1);
    expect(cancelled).toBe(true); // the body was dropped, not read
  });
  it('aborts a streamed body with no content-length once it passes the cap', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const body = new ReadableStream({ pull(c) { pulled += chunk.length; c.enqueue(chunk); if (pulled > 50 * MIB) c.close(); } });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const r = await callMindVerb('mind_search', { query: 'q' }, 5000, settings, fetchImpl as any);
    expect(r).toMatchObject({ ok: false, code: 'response_too_large' });
    expect(pulled).toBeLessThan(5 * MIB);
  });
  it('a 3 MiB answer from a real server means no block, and the turn goes on', async () => {
    const http = await import('node:http');
    const srv = http.createServer((_req, res) => { const b = bigBody(3 * MIB); res.writeHead(200, { 'content-type': 'application/json' }); res.end(b); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const s = { ...settings, root: `http://127.0.0.1:${(srv.address() as any).port}` };
      expect(await mindRecallBlock('what do you remember about the relay', s)).toBe('');
      expect(await mindWakeBlock(s)).toBe('');
      expect((console.warn as any).mock.calls.some((c: any[]) => /response_too_large/.test(c[0]))).toBe(true);
    } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
  });
  it('still parses a normal body, and one just under the cap', async () => {
    const r = await callMindVerb('mind_search', { query: 'q' }, 1000, settings, (async () => new Response(bigBody(MIB), { status: 200 })) as any);
    expect(r.ok).toBe(true);
  });
});

describe('credentials in the Mind URL never reach a log line', () => {
  it('masks user:pass@ in every warn line (failure, envelope, timeout, config)', async () => {
    const s = { ...settings, root: 'http://admin:hunter2@mind.example:8002' };
    await callMindVerb('mind_search', { query: 'q' }, 1000, s, (async () => { throw new TypeError(`fetch failed for ${s.root}/verbs/mind_search`); }) as any);
    await callMindVerb('mind_surface', { query: 'q' }, 1000, s, (async () => new Response('<html>', { status: 200 })) as any);
    await callMindVerb('mind_orient', {}, 1000, s, (async () => errBody('storage', 'bad', 500)) as any);
    await callMindVerb('mind_thread', {}, 1000, s, (async () => { const e = new Error(`timed out at https://u:p%40ss@h/x`); e.name = 'TimeoutError'; throw e; }) as any);
    const lines = (console.warn as any).mock.calls.map((c: any[]) => c.join(' '));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const l of lines) { expect(l).not.toMatch(/hunter2|admin:|p%40ss|u:p/); }
    expect(lines.join('\n')).toContain('http://***@mind.example:8002');
  });
  it('masks them in the config warning too, and leaves a plain URL alone', () => {
    resetMindWarnings();
    dbConfig.set('mind.enabled', 'true'); dbConfig.set('mind.url', 'http://admin:hunter2@h:8002'); dbConfig.set('mind.api_key', 'k'.repeat(32)); dbConfig.set('mind.mind_id', 'bad id');
    resolveMindSettings();
    expect((console.warn as any).mock.calls.map((c: any[]) => c[0]).join('\n')).not.toMatch(/hunter2/);
  });
});

describe('MIND_API_KEY from the environment', () => {
  const base = () => { dbConfig.set('mind.enabled', 'true'); dbConfig.set('mind.url', 'http://h:8002'); dbConfig.set('mind.mind_id', 'alpha'); };
  beforeEach(() => { vi.unstubAllEnvs(); });

  it('is the key when Settings has none, and says so', () => {
    base();
    vi.stubEnv('MIND_API_KEY', 'env-key-1234');
    const r = describeMindSettings();
    expect(r.settings).toEqual({ root: 'http://h:8002', bearer: 'env-key-1234', mindId: 'alpha' });
    expect(r.keySource).toBe('environment');
    expect(resolveMindSettings()?.bearer).toBe('env-key-1234');
  });

  it('loses to the key saved in Settings', () => {
    base();
    dbConfig.set('mind.api_key', 'settings-key-9999');
    vi.stubEnv('MIND_API_KEY', 'env-key-1234');
    const r = describeMindSettings();
    expect(r.settings?.bearer).toBe('settings-key-9999');
    expect(r.keySource).toBe('settings');
  });

  it('is trimmed, and a blank value is no key', () => {
    base();
    vi.stubEnv('MIND_API_KEY', '   ');
    const r = describeMindSettings();
    expect(r.settings).toBeNull();
    expect(r.missing).toEqual(['api key']);
    expect(r.keySource).toBeNull();
    vi.stubEnv('MIND_API_KEY', '  padded  ');
    expect(describeMindSettings().settings?.bearer).toBe('padded');
  });

  it('does not pair with the .mcp.json URL: that entry uses its own bearer, or the key is missing', () => {
    const mockConfig = getSanctumConfig as unknown as ReturnType<typeof vi.fn>;
    const tmp = join(process.cwd(), `.tmp-mind-env-${process.pid}.mcp.json`);
    writeFileSync(tmp, JSON.stringify({ mcpServers: { mind: { url: 'http://mcp-host:8002/mcp' } } }));
    try {
      mockConfig.mockReturnValue({ integrations: { mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } }, agent: { mcp_json_path: tmp } });
      dbConfig.set('mind.enabled', 'true'); dbConfig.set('mind.mind_id', 'alpha');
      vi.stubEnv('MIND_API_KEY', 'env-key-1234');
      const r = describeMindSettings();
      expect(r.settings).toBeNull();
      expect(r.missing).toEqual(['api key']);
      expect(r.keySource).toBeNull();
      expect(mindKeyInfo()).toEqual({ source: null, fingerprint: null });
      writeFileSync(tmp, JSON.stringify({ mcpServers: { mind: { url: 'http://mcp-host:8002/mcp', headers: { Authorization: 'Bearer mcp-own-5678' } } } }));
      expect(describeMindSettings().settings).toEqual({ root: 'http://mcp-host:8002', bearer: 'mcp-own-5678', mindId: 'alpha' });
      expect(describeMindSettings().keySource).toBe('mcp_json');
      expect(mindKeyInfo().source).toBe('mcp_json');
      expect(mindKeyInfo().fingerprint).toBe('\u2022\u2022\u2022\u20225678');
      // With a card URL the environment key applies again.
      dbConfig.set('mind.url', 'http://card-host:8002');
      expect(describeMindSettings().settings?.bearer).toBe('env-key-1234');
      expect(mindKeyInfo().source).toBe('environment');
    } finally {
      unlinkSync(tmp);
      mockConfig.mockReturnValue({ integrations: { mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } }, agent: { mcp_json_path: '/nonexistent/.mcp.json' } });
    }
  });

  it('does not switch the Mind on by itself', () => {
    vi.stubEnv('MIND_API_KEY', 'env-key-1234');
    expect(describeMindSettings()).toMatchObject({ enabled: false, settings: null });
  });

  it('is read from the sources it is given, so the updater can pass read-only ones', () => {
    const r = describeMindSettingsFrom({ read: (k) => ({ 'mind.enabled': 'true', 'mind.url': 'http://u:1/mcp', 'mind.mind_id': 'm' } as Record<string, string>)[k] ?? '', env: { MIND_API_KEY: 'from-env' } });
    expect(r.settings).toEqual({ root: 'http://u:1', bearer: 'from-env', mindId: 'm' });
    expect(r.keySource).toBe('environment');
  });

  it('is offered to a draft only for the host it belongs to', () => {
    base();
    vi.stubEnv('MIND_API_KEY', 'env-key-1234');
    expect(savedMindKeyFor('http://h:8002')).toEqual({ key: 'env-key-1234', source: 'environment' });
    expect(savedMindKeyFor('http://elsewhere:8002')).toBeNull();
  });

  it('never appears in the warning when something else is missing', () => {
    dbConfig.set('mind.enabled', 'true');
    vi.stubEnv('MIND_API_KEY', 'env-key-1234');
    resolveMindSettings();
    const said = (console.warn as any).mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(said).toMatch(/url, mind id missing/);
    expect(said).not.toContain('env-key-1234');
  });
});

describe('callMindHealth', () => {
  const health = (projection: unknown, status = 200) => new Response(JSON.stringify({ ok: true, receipt: { projection, warnings: [] } }), { status });
  it('reads version and schema from GET /health, with no bearer', async () => {
    const f = vi.fn(async () => health({ verbs: 26, db: 'up', version: '2.0.0', schema: '0007_x' }));
    expect(await callMindHealth('http://h:8002', 1000, f as never)).toEqual({ ok: true, version: '2.0.0', schema: '0007_x' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://h:8002/health');
    expect(init.method).toBe('GET');
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });
  it('names a database that is down (503), a non-envelope 200, and a refused connection', async () => {
    expect(await callMindHealth('http://h', 1000, (async () => health({ db: 'down', version: '2.0.0', schema: null }, 503)) as never)).toMatchObject({ ok: false, code: 'db_down', version: '2.0.0' });
    expect(await callMindHealth('http://h', 1000, (async () => new Response('<html>', { status: 200 })) as never)).toMatchObject({ ok: false, code: 'not_sanctum_mind' });
    expect(await callMindHealth('http://h', 1000, (async () => { throw new Error('connect ECONNREFUSED'); }) as never)).toMatchObject({ ok: false, code: 'unreachable' });
  });
  it('refuses a body over the cap and ignores a non-string version', async () => {
    const big = new Response('x'.repeat(10), { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } });
    expect(await callMindHealth('http://h', 1000, (async () => big) as never)).toMatchObject({ ok: false, code: 'response_too_large' });
    expect(await callMindHealth('http://h', 1000, (async () => health({ db: 'up', version: { x: 1 } })) as never)).toEqual({ ok: true });
  });
});

describe('callMindVerb quiet mode (probes)', () => {
  it('logs nothing and does not clear the streak of the real calls', async () => {
    const f = async () => errBody('unauthorized', 'unknown or missing bearer', 401);
    await callMindVerb('mind_thread', {}, 1000, settings, f as never);
    expect(console.warn).toHaveBeenCalledTimes(1);
    await callMindVerb('mind_thread', {}, 1000, settings, f as never, { quiet: true });
    await callMindVerb('mind_thread', {}, 1000, settings, (async () => okBody({})) as never, { quiet: true });
    expect(console.warn).toHaveBeenCalledTimes(1);
    await callMindVerb('mind_thread', {}, 1000, settings, f as never); // streak was not cleared by the quiet success
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('review follow-ups', () => {
  it('a stored Mind-card key never rides to the .mcp.json host: with no configured URL the bearer is the .mcp.json one, or missing', () => {
    const mockConfig = getSanctumConfig as unknown as ReturnType<typeof vi.fn>;
    const tmp = join(process.cwd(), `.tmp-mind-pair-${process.pid}.mcp.json`);
    writeFileSync(tmp, JSON.stringify({ mcpServers: { mind: { url: 'http://localhost:8002/mcp' } } }));
    try {
      mockConfig.mockReturnValue({ integrations: { mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } }, agent: { mcp_json_path: tmp } });
      dbConfig.set('mind.enabled', 'true'); dbConfig.set('mind.mind_id', 'alpha'); dbConfig.set('mind.api_key', 'card-secret');
      const r = describeMindSettings();
      expect(r.settings).toBeNull();
      expect(r.missing).toContain('api key'); // the card's key does not pair with the .mcp.json URL
      writeFileSync(tmp, JSON.stringify({ mcpServers: { mind: { url: 'http://localhost:8002/mcp', headers: { Authorization: 'Bearer mcp-secret' } } } }));
      expect(describeMindSettings().settings?.bearer).toBe('mcp-secret');
    } finally {
      unlinkSync(tmp);
      mockConfig.mockReturnValue({ integrations: { mind_cloud: { enabled: false, mcp_url: '', mind_id: '' } }, agent: { mcp_json_path: '/nonexistent/.mcp.json' } });
    }
  });

  it('recall skips very short messages on the shared path, so Codex and dsh follow the same rule as the Claude hook', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => { calls.push(String(url)); return okBody({}); }) as unknown as typeof fetch;
    expect(await mindRecallBlock('ok', settings, fetchImpl)).toBe('');
    expect(await mindRecallBlock('👍', settings, fetchImpl)).toBe('');
    expect(await mindRecallBlock('thanks!!', settings, fetchImpl)).toBe('');
    expect(calls).toEqual([]);
    await mindRecallBlock('what did we decide about the database?', settings, fetchImpl);
    expect(calls).toHaveLength(3);
    expect(MIN_RECALL_QUERY).toBe(10);
  });
});

describe('key fingerprint', () => {
  it('shows no tail for a key of 8 characters or fewer, and the last 4 otherwise', () => {
    expect(keyFingerprint('abcd')).toBe('••••');
    expect(keyFingerprint('12345678')).toBe('••••');
    expect(keyFingerprint('123456789')).toBe('••••6789');
    expect(keyFingerprint('k'.repeat(32))).toBe('••••kkkk');
  });
  it('is what mindKeyInfo reports', () => {
    dbConfig.set('mind.url', 'http://h:8002'); dbConfig.set('mind.api_key', 'short');
    expect(mindKeyInfo().fingerprint).toBe('••••');
    dbConfig.set('mind.api_key', 'a-longer-key-WXYZ');
    expect(mindKeyInfo().fingerprint).toBe('••••WXYZ');
  });
});

describe('the effective URL and the key that goes with it', () => {
  const mockConfig = getSanctumConfig as unknown as ReturnType<typeof vi.fn>;
  const cfg = (yamlUrl: string, mcpPath = '/nonexistent/.mcp.json') => mockConfig.mockReturnValue({ integrations: { mind_cloud: { enabled: false, mcp_url: yamlUrl, mind_id: '' } }, agent: { mcp_json_path: mcpPath } });
  const withMcp = (fn: (path: string) => void) => {
    const tmp = join(process.cwd(), `.tmp-mind-eff-${process.pid}.mcp.json`);
    writeFileSync(tmp, JSON.stringify({ mcpServers: { mind: { url: 'http://mcp-host:8002/mcp', headers: { Authorization: 'Bearer mcp-own-5678' } } } }));
    try { fn(tmp); } finally { unlinkSync(tmp); cfg(''); }
  };

  it('is the card URL, else the yaml URL, else the .mcp.json URL, and says which', () => {
    withMcp((tmp) => {
      cfg('http://yaml-host:8002/mcp', tmp);
      dbConfig.set('mind.url', 'http://card-host:8002');
      expect(mindUrlInfo()).toEqual({ source: 'settings', url: 'http://card-host:8002' });
      dbConfig.delete('mind.url');
      expect(mindUrlInfo()).toEqual({ source: 'yaml', url: 'http://yaml-host:8002/mcp' });
      cfg('', tmp);
      expect(mindUrlInfo()).toEqual({ source: 'mcp_json', url: 'http://mcp-host:8002/mcp' });
    });
    expect(mindUrlInfo()).toEqual({ source: null, url: '' });
  });

  it('pairs a blank draft key with the .mcp.json bearer for the .mcp.json host only, and the saved key for the yaml host', () => {
    withMcp((tmp) => {
      cfg('', tmp);
      vi.stubEnv('MIND_API_KEY', 'env-key-1234');
      expect(savedMindKeyFor('http://mcp-host:8002')).toEqual({ key: 'mcp-own-5678', source: 'mcp_json' }); // never the env key
      expect(savedMindKeyFor('http://elsewhere:8002')).toBeNull();
      cfg('http://yaml-host:8002', tmp);
      expect(savedMindKeyFor('http://yaml-host:8002')).toEqual({ key: 'env-key-1234', source: 'environment' });
      expect(savedMindKeyFor('http://mcp-host:8002')).toBeNull();
      vi.unstubAllEnvs();
    });
  });
});
