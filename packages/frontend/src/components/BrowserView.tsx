/**
 * BrowserView — a browser viewer (e.g. neko) embedded in an iframe.
 *
 * The URL comes from `integrations.browser_url` in sanctum.yaml, read through
 * GET /api/preferences. Unset shows a short empty state pointing at the recipe
 * in examples/browser-seat-neko/ (noVNC fallback: examples/browser-seat/). The backend allows only that one origin in its CSP
 * `frame-src`, so a change to the URL applies after a restart.
 *
 * Toolbar: reload (remounts the iframe) and pop-out (opens the URL in a new window).
 */
import React, { useEffect, useState } from 'react';
import { browserViewState, type BrowserViewState } from './browserViewState';

import { BASE } from '../lib/base';

const SETUP_DOC = 'examples/browser-seat-neko/README.md';

export function BrowserView() {
  const [state, setState] = useState<BrowserViewState | null>(null); // null = loading
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/api/preferences`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(p => { if (!cancelled) setState(browserViewState(p)); })
      .catch(() => { if (!cancelled) setState({ kind: 'error' }); });
    return () => { cancelled = true; };
  }, []);

  const note = (title: string, body: React.ReactNode) => (
    <div className="browser-view">
      <div className="browser-empty">
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
      <style>{BROWSER_CSS}</style>
    </div>
  );

  if (state === null) {
    return <div className="browser-view"><p className="browser-empty">Loading…</p><style>{BROWSER_CSS}</style></div>;
  }
  if (state.kind === 'error') {
    return note('Could not load settings', 'The Browser tab could not read its configuration. Check that you are signed in and the server is running, then reopen the tab.');
  }
  if (state.kind === 'empty') {
    return note('No browser configured', <>
      Set <code>integrations.browser_url</code> in <code>sanctum.yaml</code> (or in Settings) to
      a browser viewer such as neko (or noVNC as a fallback), then restart. Setup steps are in <code>{SETUP_DOC}</code>.
    </>);
  }
  if (state.kind === 'invalid') {
    return note('Browser URL is not valid', <>
      The saved <code>integrations.browser_url</code> must be a plain <code>http(s)://host:port/...</code> address
      (no wildcards or <code>user:pass@</code>). Fix it in Settings, then restart.
    </>);
  }
  if (state.kind === 'restart') {
    return note('Restart to apply', 'The browser URL was changed. Restart Sanctum Mobile and the Browser tab will load it.');
  }

  const url = state.url;
  return (
    <div className="browser-view">
      <div className="browser-toolbar">
        <button type="button" className="browser-btn" onClick={() => setReloadKey(k => k + 1)}>
          Reload
        </button>
        <button
          type="button"
          className="browser-btn"
          onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
        >
          Pop out
        </button>
      </div>
      {/* allow-scripts + allow-same-origin together would let a SAME-origin frame remove its own
          sandbox. That is safe here only because the viewer is cross-origin to this app (the
          server's CSP frame-src allows just that one origin), so the frame keeps its own origin
          and cannot reach this page. Do not host the viewer under the app's own origin. No
          allow-top-navigation: the frame cannot navigate this page. */}
      <iframe
        key={reloadKey}
        className="browser-frame"
        src={url}
        title="Browser"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-pointer-lock allow-downloads"
        allow="clipboard-read; clipboard-write; fullscreen"
        referrerPolicy="no-referrer"
      />
      <style>{BROWSER_CSS}</style>
    </div>
  );
}

const BROWSER_CSS = `
  .browser-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: transparent;
  }
  .browser-toolbar {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.06));
    flex-shrink: 0;
  }
  .browser-btn {
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
    padding: 0.25rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    background: transparent;
    color: var(--text-muted, #6a6258);
    cursor: pointer;
  }
  .browser-btn:hover {
    color: var(--amber, #c9a87c);
    background: var(--amber-subtle, rgba(201, 168, 124, 0.06));
  }
  .browser-frame {
    flex: 1;
    min-height: 0;
    width: 100%;
    border: 0;
    background: #000;
  }
  .browser-empty {
    margin: auto;
    max-width: 28rem;
    padding: 2rem 1.5rem;
    text-align: center;
    color: var(--text-muted, #6a6258);
  }
  .browser-empty h2 {
    color: var(--text-primary, #e2dbd0);
    font-size: 1rem;
    margin-bottom: 0.5rem;
  }
  .browser-empty code { font-family: var(--font-mono, monospace); }
`;
