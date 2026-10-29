import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserToolsConfigured, warnIfBrowserUnfiltered } from './browser-gate.js';

const dir = mkdtempSync(join(tmpdir(), 'bgate-'));
const mcp = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p; };
const cfg = (browser_url: string, mcp_json_path: string) => ({ integrations: { browser_url }, agent: { mcp_json_path } }) as any;

describe('browserToolsConfigured', () => {
  it('is true when integrations.browser_url is set, whatever .mcp.json says', () => {
    expect(browserToolsConfigured(cfg('http://127.0.0.1:3201/', join(dir, 'missing.json')))).toBe(true);
  });
  it('is true when .mcp.json has a browser server, with no browser_url (hand-added entry)', () => {
    expect(browserToolsConfigured(cfg('', mcp('a.json', '{"mcpServers":{"browser":{"command":"node"}}}')))).toBe(true);
  });
  it('is false with neither, and never throws on a missing, malformed or oddly shaped file', () => {
    expect(browserToolsConfigured(cfg('', join(dir, 'missing.json')))).toBe(false);
    expect(browserToolsConfigured(cfg('', mcp('b.json', '{"mcpServers":{"other":{}}}')))).toBe(false);
    expect(browserToolsConfigured(cfg('', mcp('c.json', 'not json')))).toBe(false);
    expect(browserToolsConfigured(cfg('', mcp('d.json', '{"mcpServers":[]}')))).toBe(false);
    expect(browserToolsConfigured(cfg('', mcp('e.json', 'null')))).toBe(false);
    expect(browserToolsConfigured(cfg('', ''))).toBe(false);
  });
});

describe('warnIfBrowserUnfiltered', () => {
  const FILTERED = '{"mcpServers":{"browser":{"command":"node","args":["/x/examples/browser-seat-neko/mcp-filter.mjs","--block","browser_run_code_unsafe,browser_evaluate","--workdir","/x/data/browser-out","--","npx"]}}}';
  it('warns once, naming the file, for a browser entry without the filter', () => {
    for (const body of ['{"mcpServers":{"browser":{"command":"npx","args":["-y","@playwright/mcp@0.0.83"]}}}', '{"mcpServers":{"browser":{"type":"http","url":"https://x"}}}', '{"mcpServers":{"browser":null}}']) {
      const warn = vi.fn();
      const p = mcp('w.json', body);
      expect(warnIfBrowserUnfiltered(cfg('', p), warn)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/browser/);
      expect(String(warn.mock.calls[0][0])).toMatch(/no filter|without the filter|mcp-filter/);
      expect(String(warn.mock.calls[0][0])).toContain(p);
    }
  });
  it('warns as unfiltered for an entry that only mentions mcp-filter.mjs in a dummy argument', () => {
    for (const entry of [
      { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--note', 'mcp-filter.mjs'] },
      { command: 'npx', args: ['dummy', '/x/examples/browser-seat-neko/mcp-filter.mjs', '--block', 'browser_run_code_unsafe,browser_evaluate', '--workdir', '/x/data/browser-out', '--', 'npx'] },
      { command: 'node', args: ['/x/not-mcp-filter.mjs', '--block', 'browser_run_code_unsafe,browser_evaluate', '--workdir', '/x/data/browser-out', '--', 'npx'] },
    ]) {
      const warn = vi.fn();
      const p = mcp('d.json', JSON.stringify({ mcpServers: { browser: entry } }));
      expect(warnIfBrowserUnfiltered(cfg('', p), warn), JSON.stringify(entry)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/no filter/);
      expect(String(warn.mock.calls[0][0])).not.toMatch(/outdated/);
    }
  });
  it('warns once for an outdated entry (filter present, no --workdir, or flags after --): the filter would exit 2 and the companion would have no browser tools', () => {
    for (const args of [
      ['--block', 'browser_run_code_unsafe,browser_evaluate', '--', 'npx'],
      ['--block', 'browser_run_code_unsafe,browser_evaluate', '--', 'npx', '--workdir', '/x/data/browser-out'],
      ['--block', 'browser_run_code_unsafe,browser_evaluat', '--workdir', '/x/data/browser-out', '--', 'npx'],
      ['--block', 'browser_run_code_unsafe,browser_evaluate', '--workdir', 'rel', '--', 'npx'],
    ]) {
      const warn = vi.fn();
      const p = mcp('o.json', JSON.stringify({ mcpServers: { browser: { command: 'node', args: ['/x/examples/browser-seat-neko/mcp-filter.mjs', ...args] } } }));
      expect(warnIfBrowserUnfiltered(cfg('', p), warn), args.join(' ')).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/outdated|no browser tools|exit/i);
      expect(String(warn.mock.calls[0][0])).toContain(p);
    }
  });
  it('is silent with the filter in place, with no browser entry, and on a missing or malformed file', () => {
    const warn = vi.fn();
    expect(warnIfBrowserUnfiltered(cfg('http://127.0.0.1:3201/', mcp('f.json', FILTERED)), warn)).toBe(false);
    expect(warnIfBrowserUnfiltered(cfg('', mcp('g.json', '{"mcpServers":{"other":{}}}')), warn)).toBe(false);
    expect(warnIfBrowserUnfiltered(cfg('', join(dir, 'missing.json')), warn)).toBe(false);
    expect(warnIfBrowserUnfiltered(cfg('', mcp('h.json', 'nope')), warn)).toBe(false);
    expect(warnIfBrowserUnfiltered(cfg('http://x/', ''), warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
