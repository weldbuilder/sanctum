import { describe, it, expect } from 'vitest';
import type { MindStatus } from '@sanctum/shared';
import { mindHeaderNotice, mindTestSummary, mindLastCheckLine, isMindStatus, effectiveMindUrl, mindSourceLine } from './mindStatusText.js';

const at = '2026-10-21T14:31:00.000Z';
const s = (over: Partial<MindStatus>): MindStatus => ({ state: 'ok', checkedAt: at, latencyMs: 41, ...over });

describe('mindHeaderNotice (the line in the chat header)', () => {
  it('is quiet until there is a reading, while ok, off, or incomplete', () => {
    expect(mindHeaderNotice(null)).toBeNull();
    expect(mindHeaderNotice(s({ state: 'ok' }))).toBeNull();
    expect(mindHeaderNotice(s({ state: 'off', latencyMs: null }))).toBeNull();
    expect(mindHeaderNotice(s({ state: 'incomplete', latencyMs: null, error: 'mind id missing' }))).toBeNull();
  });
  it('says the Mind is offline when it does not answer', () => {
    expect(mindHeaderNotice(s({ state: 'offline', latencyMs: null, error: 'no answer' }))).toBe('Mind offline');
  });
  it('says so when the key is refused', () => {
    expect(mindHeaderNotice(s({ state: 'unauthorized', error: 'the Mind refused the key' }))).toBe('Mind offline: key refused');
    expect(mindHeaderNotice(s({ state: 'forbidden', error: 'x' }))).toBe('Mind offline: this mind id is not allowed for this key');
  });
});

describe('mindTestSummary (the Test connection result, in plain words)', () => {
  it('connected, with version and latency', () => {
    expect(mindTestSummary(s({ version: '2.0.0', latencyMs: 41 }))).toEqual({ tone: 'ok', text: 'Connected. sanctum-mind 2.0.0 answered in 41 ms.' });
  });
  it('connected with no version', () => {
    expect(mindTestSummary(s({ latencyMs: 1234.6 })).text).toBe('Connected. It answered in 1235 ms.');
    expect(mindTestSummary(s({ latencyMs: null })).text).toBe('Connected.');
  });
  it('offline, with the reason', () => {
    expect(mindTestSummary(s({ state: 'offline', latencyMs: null, error: 'no answer from the Mind (could not connect)' }))).toEqual({ tone: 'bad', text: 'Offline: no answer from the Mind (could not connect).' });
  });
  it('key refused', () => {
    expect(mindTestSummary(s({ state: 'unauthorized', error: 'the Mind refused the key' }))).toEqual({ tone: 'bad', text: 'Key refused: the Mind refused the key.' });
    expect(mindTestSummary(s({ state: 'forbidden', error: 'this mind id is not allowed for this key' }))).toEqual({ tone: 'bad', text: 'Not allowed: this mind id is not allowed for this key.' });
    expect(mindTestSummary(s({ state: 'forbidden' })).text).not.toMatch(/refused/i);
  });
  it('mind id missing, and other missing pieces', () => {
    expect(mindTestSummary(s({ state: 'incomplete', latencyMs: null, error: 'mind id missing' }))).toEqual({ tone: 'bad', text: 'Mind id missing.' });
    expect(mindTestSummary(s({ state: 'incomplete', latencyMs: null, error: 'url and api key missing' })).text).toBe('URL and api key missing.');
    expect(mindTestSummary(s({ state: 'incomplete', latencyMs: null, error: 'the URL must start with http:// or https://' })).text).toBe('The URL must start with http:// or https://.');
  });
  it('off', () => {
    expect(mindTestSummary(s({ state: 'off', latencyMs: null })).tone).toBe('neutral');
  });
});

describe('mindLastCheckLine (the watchdog line in Settings)', () => {
  const clock = (iso: string) => `T(${iso})`;
  it('names the state and when it was checked', () => {
    expect(mindLastCheckLine(s({ version: '2.0.0' }), clock)).toBe(`Last check: connected (2.0.0), T(${at})`);
    expect(mindLastCheckLine(s({ state: 'offline', latencyMs: null }), clock)).toBe(`Last check: offline, T(${at})`);
    expect(mindLastCheckLine(s({ state: 'unauthorized' }), clock)).toBe(`Last check: key refused, T(${at})`);
    expect(mindLastCheckLine(s({ state: 'forbidden' }), clock)).toBe(`Last check: mind id not allowed, T(${at})`);
    expect(mindLastCheckLine(s({ state: 'incomplete', latencyMs: null }), clock)).toBe(`Last check: not set up, T(${at})`);
    expect(mindLastCheckLine(s({ state: 'off', latencyMs: null }), clock)).toBe(`Last check: off, T(${at})`);
    expect(mindLastCheckLine(null, clock)).toBeNull();
  });
});

describe('isMindStatus', () => {
  it('accepts a record and refuses anything else', () => {
    expect(isMindStatus(s({}))).toBe(true);
    expect(isMindStatus(s({ state: 'forbidden' }))).toBe(true);
    expect(isMindStatus({ state: 'nope', checkedAt: at })).toBe(false);
    expect(isMindStatus({ error: 'x' })).toBe(false);
    expect(isMindStatus(null)).toBe(false);
  });
});

describe('effectiveMindUrl (what Test connection posts)', () => {
  it('is the URL typed in the card, else the one in effect from sanctum.yaml or .mcp.json', () => {
    expect(effectiveMindUrl('  http://card:8002 ', 'http://yaml:8002')).toBe('http://card:8002');
    expect(effectiveMindUrl('', 'http://yaml:8002')).toBe('http://yaml:8002');
    expect(effectiveMindUrl('   ', 'http://mcp:8002')).toBe('http://mcp:8002');
    expect(effectiveMindUrl('', null)).toBe('');
    expect(effectiveMindUrl('', undefined)).toBe('');
  });
  it('is the card\'s URL when it differs from the saved one, even if another source is in effect', () => {
    expect(effectiveMindUrl('http://typed:1', 'http://mcp:8002')).toBe('http://typed:1');
  });
});

describe('mindSourceLine (where a value comes from)', () => {
  it('names each source in one line', () => {
    expect(mindSourceLine('URL', 'settings')).toBe('URL: from Settings');
    expect(mindSourceLine('URL', 'yaml')).toBe('URL: from sanctum.yaml');
    expect(mindSourceLine('URL', 'mcp_json')).toBe('URL: from .mcp.json');
    expect(mindSourceLine('key', 'settings')).toBe('Key: from Settings');
    expect(mindSourceLine('key', 'environment')).toBe('Key: from MIND_API_KEY in .env');
    expect(mindSourceLine('key', 'mcp_json')).toBe('Key: from .mcp.json');
  });
  it('says nothing, rather than guess, when there is no source or an unknown one', () => {
    expect(mindSourceLine('URL', null)).toBeNull();
    expect(mindSourceLine('key', undefined)).toBeNull();
    expect(mindSourceLine('URL', 'something-else')).toBeNull();
  });
});
