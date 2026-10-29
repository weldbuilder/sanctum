import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { browserViewState } from './browserViewState';

const ok = { integrations: { browser_url: 'http://h.example:3000/', browser_url_valid: true, browser_active_origin: 'http://h.example:3000' } };

describe('browserViewState', () => {
  it('shows the frame when the saved origin is the active one', () => {
    expect(browserViewState(ok)).toEqual({ kind: 'frame', url: 'http://h.example:3000/' });
  });

  it('asks for a restart when the saved origin differs from the running CSP origin', () => {
    expect(browserViewState({ integrations: { ...ok.integrations, browser_active_origin: 'http://old.example' } }).kind).toBe('restart');
    expect(browserViewState({ integrations: { ...ok.integrations, browser_active_origin: '' } }).kind).toBe('restart');
  });

  it('reports an invalid saved value', () => {
    expect(browserViewState({ integrations: { browser_url: 'http://a,b/', browser_url_valid: false, browser_active_origin: '' } }).kind).toBe('invalid');
  });

  it('shows the empty state only when genuinely unset', () => {
    expect(browserViewState({ integrations: { browser_url: '', browser_url_valid: true, browser_active_origin: '' } }).kind).toBe('empty');
  });

  it('shows an error, not the empty state, when the prefs fetch failed or is unusable', () => {
    expect(browserViewState(null).kind).toBe('error');
    expect(browserViewState({ error: 'No config file found' }).kind).toBe('error');
    expect(browserViewState({}).kind).toBe('error');
  });
});

describe('BrowserView iframe', () => {
  const src = readFileSync(new URL('./BrowserView.tsx', import.meta.url), 'utf-8');
  it('is sandboxed without top navigation', () => {
    const m = /sandbox="([^"]+)"/.exec(src);
    expect(m).not.toBeNull();
    const flags = m![1].split(/\s+/);
    expect(flags).toEqual(expect.arrayContaining(['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-pointer-lock', 'allow-downloads']));
    expect(flags).not.toContain('allow-top-navigation');
    expect(src).toContain('allow="clipboard-read; clipboard-write; fullscreen"');
  });
});
