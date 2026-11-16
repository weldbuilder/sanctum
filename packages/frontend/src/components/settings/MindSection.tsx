/**
 * MindSection — Settings → Mind: the Mind card (MIND-SURFACE-SPEC §Phase-1.1).
 *
 * Four fields: mind.enabled (toggle) · mind.url (base URL) · mind.mind_id (the
 * mind's id on the service, required by every sanctum-mind verb) · mind.api_key
 * (write-only secret). Saves through the existing DB-config endpoint
 * (PUT /api/settings { key, value }); reads through GET /api/settings.
 *
 * KEY HONESTY (load-bearing):
 *   - The key input is WRITE-ONLY. Once a key is set it renders as a
 *     fingerprint (••••last4) and the input is never pre-filled with the
 *     real value. If the backend already masks the value server-side (the
 *     Lane-A/Hale gate), a value that arrives pre-masked is shown as-is.
 *   - This component never logs, echoes, or re-renders the full key.
 *
 * After any save the mind store re-fetches, so the sidebar /mind entry and
 * the Home night shelf gate ripple live — no reload needed. (The backend's
 * own polls pick the toggle up on their next tick.)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Group, Eyebrow, TextField, ToggleRow, SaveIndicator, Btn } from './primitives';
import { useMindStore } from '../../store/mind';
import { useChatStore } from '../../store/chat';
import { effectiveMindUrl, isMindStatus, mindLastCheckLine, mindSourceLine, mindTestSummary } from '../../store/mindStatusText';
import type { MindStatus } from '@sanctum/shared';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** Reduce whatever the config map carries to a display fingerprint.
 *  Already-masked values (server-side masking) pass through untouched;
 *  a raw value is reduced to ••••last4 and the raw string is dropped. */
function fingerprintOf(value: string | undefined): string | null {
  if (!value) return null;
  if (value.includes('•')) return value;
  return `••••${value.slice(-4)}`;
}

export function MindSection({ base }: { base: string }) {
  const readWatchdogRef = useRef<() => Promise<void>>(async () => {});
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [savedUrl, setSavedUrl] = useState('');
  const [mindId, setMindId] = useState('');
  const [savedMindId, setSavedMindId] = useState('');
  const [keyFingerprint, setKeyFingerprint] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  // Where the key in use came from: 'environment' = MIND_API_KEY in .env (Settings holds none).
  const [keySource, setKeySource] = useState<string | null>(null);
  // Where the URL in effect comes from (settings | yaml | mcp_json), and the URL itself when the card holds none:
  // Test connection posts it, so a yaml or .mcp.json setup does not test as "URL missing".
  const [urlSource, setUrlSource] = useState<string | null>(null);
  const [effectiveUrl, setEffectiveUrl] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ tone: 'ok' | 'bad' | 'neutral'; text: string } | null>(null);
  // The watchdog's last reading: live from the socket, or read once here.
  const liveStatus = useChatStore(s => s.mindStatus);
  const [fetchedStatus, setFetchedStatus] = useState<MindStatus | null>(null);
  const watchdog = liveStatus && fetchedStatus ? (Date.parse(liveStatus.checkedAt) >= Date.parse(fetchedStatus.checkedAt) ? liveStatus : fetchedStatus) : (liveStatus ?? fetchedStatus);

  const refreshGate = useCallback(() => {
    void useMindStore.getState().fetchSurface();
    // The backend re-checks the Mind when a mind.* setting is saved; read its answer once it has had time to.
    setTimeout(() => { void readWatchdogRef.current(); }, 1500);
  }, []);

  // The sources only (after the URL is saved or cleared, the one in effect may be another).
  const readSources = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/settings`, { credentials: 'include' });
      if (!res.ok) return;
      const body = (await res.json()) as { mind_key_source?: string | null; mind_url_source?: string | null; mind_url_effective?: string };
      setKeySource(body.mind_key_source ?? null);
      setUrlSource(body.mind_url_source ?? null);
      setEffectiveUrl(body.mind_url_effective ?? null);
    } catch { /* the lines stay as they were */ }
  }, [base]);

  // ── Load current values ────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${base}/api/settings`, { credentials: 'include' });
        if (!res.ok) return;
        const body = (await res.json()) as { config?: Record<string, string>; mind_key_source?: string | null; mind_key_fingerprint?: string | null; mind_url_source?: string | null; mind_url_effective?: string };
        const { config } = body;
        if (!alive || !config) return;
        setEnabled(config['mind.enabled'] === 'true');
        setUrl(config['mind.url'] ?? '');
        setSavedUrl(config['mind.url'] ?? '');
        setMindId(config['mind.mind_id'] ?? '');
        setSavedMindId(config['mind.mind_id'] ?? '');
        // Fingerprint only — the raw value (if the backend sent one) is
        // reduced immediately and never kept.
        // The key in effect first (it can be the .mcp.json bearer or MIND_API_KEY), else the one saved on the card.
        setKeyFingerprint(body.mind_key_fingerprint ?? fingerprintOf(config['mind.api_key']) ?? null);
        setKeySource(body.mind_key_source ?? null);
        setUrlSource(body.mind_url_source ?? null);
        setEffectiveUrl(body.mind_url_effective ?? null);
      } catch { /* backend not up — card stays empty-honest */ }
      finally { if (alive) setLoaded(true); }
    })();
    return () => { alive = false; };
  }, [base]);

  // The watchdog's last reading, once; later changes arrive over the socket.
  const readWatchdog = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/mind/status`, { credentials: 'include' });
      if (!res.ok) return;
      const body = await res.json();
      if (isMindStatus(body)) setFetchedStatus(body);
    } catch { /* the line just stays out */ }
  }, [base]);
  useEffect(() => { readWatchdogRef.current = readWatchdog; void readWatchdog(); }, [readWatchdog]);

  // ── Test connection: posts the form as it is now, saved or not. The draft is never stored by the server.
  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${base}/api/mind/test`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // A key left blank (or showing its fingerprint) means "the saved one"; the server uses it for the saved URL only.
        // A blank mind id likewise means the one in effect (the card's, else sanctum.yaml's).
        body: JSON.stringify({ url: effectiveMindUrl(url, effectiveUrl), mind_id: mindId.trim(), api_key: keyDraft.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 429) setTestResult({ tone: 'neutral', text: 'One test at a time, and not more than one every 2 seconds. Try again in a moment.' });
      else if (res.ok && isMindStatus(body)) setTestResult(mindTestSummary(body));
      else setTestResult({ tone: 'bad', text: 'The test could not run.' });
    } catch {
      setTestResult({ tone: 'bad', text: 'Could not reach the backend.' });
    } finally {
      setTesting(false);
    }
  };

  // ── Save helper ────────────────────────────────────────────────────────
  const saveKeyValue = useCallback(async (key: string, value: string): Promise<boolean> => {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`${base}/api/settings`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setError(d.error ?? 'Could not save — try again.');
        setStatus('error');
        setTimeout(() => setStatus('idle'), 2600);
        return false;
      }
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2200);
      return true;
    } catch {
      setError('Could not reach the backend.');
      setStatus('error');
      setTimeout(() => setStatus('idle'), 2600);
      return false;
    }
  }, [base]);

  const handleToggle = async (v: boolean) => {
    setEnabled(v); // optimistic — reverted on failure
    const ok = await saveKeyValue('mind.enabled', v ? 'true' : 'false');
    if (!ok) setEnabled(!v);
    else refreshGate();
  };

  const handleSaveUrl = async () => {
    const ok = await saveKeyValue('mind.url', url.trim());
    if (ok) { setSavedUrl(url.trim()); void readSources(); refreshGate(); }
  };

  const handleSaveMindId = async () => {
    const ok = await saveKeyValue('mind.mind_id', mindId.trim());
    if (ok) { setSavedMindId(mindId.trim()); refreshGate(); }
  };

  const handleSaveKey = async () => {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    const ok = await saveKeyValue('mind.api_key', trimmed);
    if (ok) {
      setKeyFingerprint(`••••${trimmed.slice(-4)}`);
      setKeySource('settings');
      setKeyDraft('');
      setEditingKey(false);
      refreshGate();
    }
  };

  // One line saying where the URL in effect comes from: what is typed (saved or not), else the yaml / .mcp.json one.
  const urlLine = url.trim() ? (url.trim() === savedUrl ? mindSourceLine('URL', 'settings') : null) : mindSourceLine('URL', urlSource);

  if (!loaded) {
    return (
      <div className="mind-card">
        <Eyebrow label="mind" />
        <span className="sp-empty-text">Loading…</span>
      </div>
    );
  }

  return (
    <div className="mind-card">
      <Eyebrow label="mind" sub={enabled ? 'window open' : 'off'} />

      {/* The seam, one sentence (spec §Phase-1.3) — ships with the card. */}
      <p className="mind-seam-note">
        Your mind stays wherever it lives — Sanctum is the window, never the
        container; point it at a resonant-mind URL, or toggle this off and the
        house simply doesn't have that window.
      </p>

      <Group>
        <ToggleRow
          label="mind surface"
          checked={enabled}
          onChange={v => void handleToggle(v)}
          hint="Gates everything mind-shaped — the /mind room, the night shelf, the orb weather sync, the env push"
        />

        <div className="mind-fields">
          <div className="mind-url-row">
            <TextField
              label="mind URL"
              value={url}
              onChange={setUrl}
              mono
              placeholder="http://localhost:PORT"
              hint="Root URL of the sanctum-mind service you created the mind on (no key in the URL; /mcp or /verbs suffixes are fine). It must be the current sanctum-mind, the one that answers with { ok, receipt }."
            />
            {urlLine && (
              <span className="sp-form-hint" data-testid="mind-url-source">
                {urlLine}{!url.trim() && effectiveUrl ? ` (${effectiveUrl})` : ''}
              </span>
            )}
            {url.trim() !== savedUrl && (
              <div className="mind-field-save">
                <Btn variant="primary" small onClick={() => void handleSaveUrl()} disabled={status === 'saving'}>
                  save URL
                </Btn>
              </div>
            )}
          </div>

          <div className="mind-url-row">
            <TextField
              label="mind id"
              value={mindId}
              onChange={setMindId}
              mono
              placeholder="alpha"
              hint="The mind's id on the service, the name you gave `init`. Required by every verb."
            />
            {mindId.trim() !== savedMindId && (
              <div className="mind-field-save">
                <Btn variant="primary" small onClick={() => void handleSaveMindId()} disabled={status === 'saving'}>
                  save id
                </Btn>
              </div>
            )}
          </div>

          <div className="mind-key-block">
            <span className="sp-form-label">API key</span>
            {keyFingerprint && !editingKey ? (
              <div className="mind-key-set">
                <span className="mind-key-fingerprint">{keyFingerprint}</span>
                <button
                  type="button"
                  className="mind-key-replace"
                  onClick={() => setEditingKey(true)}
                >
                  replace key
                </button>
              </div>
            ) : (
              <div className="mind-key-entry">
                <input
                  type="password"
                  className="sp-form-input mono"
                  value={keyDraft}
                  onChange={e => setKeyDraft(e.target.value)}
                  placeholder="paste the mind API key"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Mind API key"
                />
                <Btn
                  variant="primary"
                  small
                  onClick={() => void handleSaveKey()}
                  disabled={!keyDraft.trim() || status === 'saving'}
                >
                  save key
                </Btn>
                {keyFingerprint && (
                  <Btn variant="ghost" small onClick={() => { setEditingKey(false); setKeyDraft(''); }}>
                    cancel
                  </Btn>
                )}
              </div>
            )}
            {keyFingerprint && !editingKey && mindSourceLine('key', keySource) && (
              <span className="sp-form-hint" data-testid="mind-key-source">
                {mindSourceLine('key', keySource)}
                {keySource === 'environment' ? '. A key saved here takes its place.' : keySource === 'mcp_json' ? '. It goes with the .mcp.json URL.' : ''}
              </span>
            )}
            <span className="sp-form-hint">
              Write-only — stored server-side, shown here only as a fingerprint.
              The browser never holds the full key after saving.
            </span>
          </div>
        </div>
      </Group>

      <div className="mind-test">
        <div className="mind-test-row">
          <Btn variant="ghost" small onClick={() => void handleTest()} disabled={testing}>
            {testing ? 'testing…' : 'Test connection'}
          </Btn>
          {testResult && (
            <span className={`mind-test-result ${testResult.tone}`} role="status">{testResult.text}</span>
          )}
        </div>
        {watchdog && <span className="sp-form-hint" data-testid="mind-last-check">{mindLastCheckLine(watchdog)}</span>}
        <span className="sp-form-hint">Tests what is in the fields above, saved or not. Nothing is stored by the test.</span>
      </div>

      <div className="mind-feedback">
        {error && <span className="mind-err" role="alert">{error}</span>}
        <SaveIndicator status={status} />
      </div>

      <style>{`
        .mind-card { margin-bottom: 1.5rem; }
        .mind-seam-note {
          font-size: 0.8125rem;
          font-style: italic;
          line-height: 1.55;
          color: var(--text-muted, #6a6258);
          margin: 0 0 0.375rem;
        }
        @media (min-width: 769px) { .settings-view .mind-seam-note { font-size: 14px; } }
        .mind-fields {
          display: flex;
          flex-direction: column;
          gap: 0.875rem;
          padding: 0.875rem 0;
        }
        .mind-url-row { display: flex; flex-direction: column; gap: 0.4375rem; }
        .mind-field-save { display: flex; justify-content: flex-end; }
        .mind-key-block {
          display: flex;
          flex-direction: column;
          gap: 0.3125rem;
        }
        .mind-key-set {
          display: flex;
          align-items: center;
          gap: 0.625rem;
        }
        .mind-key-fingerprint {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8125rem;
          letter-spacing: 0.06em;
          color: var(--amber-bright, #e3c49a);
        }
        .mind-key-replace {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 0.25rem;
          cursor: pointer;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          letter-spacing: 0.04em;
          color: var(--text-muted, #6a6258);
          padding: 0.125rem 0.375rem;
          transition: color 150ms ease, border-color 150ms ease;
        }
        .mind-key-replace:hover {
          color: var(--text-secondary, #a09689);
          border-color: rgba(255,255,255,0.13);
        }
        .mind-key-entry {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .mind-key-entry .sp-form-input { flex: 1; min-width: 12rem; }
        .mind-test { display: flex; flex-direction: column; gap: 0.3125rem; margin-top: 0.5rem; }
        .mind-test-row { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
        .mind-test-result { font-size: 0.8125rem; font-style: italic; color: var(--text-secondary, #a09689); }
        .mind-test-result.ok { color: var(--amber-bright, #e3c49a); }
        .mind-test-result.bad { color: rgba(210,140,130,0.85); }
        .mind-feedback {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0.75rem;
          min-height: 1.25rem;
          margin-top: 0.25rem;
        }
        .mind-err {
          font-size: 0.8125rem;
          font-style: italic;
          color: var(--status-error-text);
          margin-right: auto;
        }
      `}</style>
    </div>
  );
}
