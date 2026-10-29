/**
 * Plugins section.
 * List from GET /api/plugins ({ trust, plugins }); files from GET /api/plugins/:id/files; one file's text from
 * GET /api/plugins/:id/file?path=; reload via POST /api/plugins/:id/reload.
 * Person mode (plugins.trust: person): ratify via POST /api/plugins/:id/ratify { digest }.
 * Companion mode (the default): on/off via PUT /api/plugins/enabled { enabled }, and "Mark as seen" via
 * POST /api/plugins/:id/seen { digest }; no ratification.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Group, Eyebrow, Btn, Pill, EmptyState, Spinner, ToggleRow } from './primitives';
import {
  ratificationBadge, changeSummary, changeLine, canReview, canReload, interpretRatifyFailure,
  orderFiles, describeDisabled, interpretFileView,
  readTrust, changedSinceView, canReviewAudit, describeChangeTime, interpretEnabledFailure, interpretSeenFailure, toggleEnabled,
  type PluginInfo, type PluginFile, type FileView, type PluginsTrust,
} from './pluginsState';

const TONE_COLOR = { ok: '#6dba88', warn: '#d4a843', muted: '#71717a' } as const;
const ERR_COLOR = 'rgba(210,140,130,0.9)';

interface Review { files: PluginFile[] | null; error: string | null }

export function PluginsSection({ base }: { base: string }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [trust, setTrust] = useState<PluginsTrust>('companion');
  const [disabled, setDisabled] = useState<string | null>(null);
  const [disabledDetail, setDisabledDetail] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  // One file's text, keyed by plugin id + path; 'loading' while it is fetched. Closed files have no entry.
  const [views, setViews] = useState<Record<string, FileView | 'loading'>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, { text: string; ok: boolean }>>({});

  const setNote = (id: string, text: string | null, ok = false) =>
    setNotes(prev => {
      const next = { ...prev };
      if (text === null) delete next[id]; else next[id] = { text, ok };
      return next;
    });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/plugins`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTrust(readTrust(data));
      setDisabled(typeof data?.disabled === 'string' ? data.disabled : null);
      setDisabledDetail(typeof data?.detail === 'string' ? data.detail : undefined);
      setPlugins(Array.isArray(data?.plugins) ? data.plugins : []);
      setLoadError(null);
    } catch {
      setLoadError('Could not load plugins.');
    }
    setLoading(false);
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  const viewKey = (id: string, path: string) => `${id}\u0000${path}`;
  const closeReview = (id: string) => {
    setReviews(prev => { const n = { ...prev }; delete n[id]; return n; });
    setViews(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(`${id}\u0000`))));
  };

  // Tap a file to read it; tap again to close it.
  const toggleFile = async (p: PluginInfo, path: string) => {
    const key = viewKey(p.id, path);
    if (views[key]) { setViews(prev => { const n = { ...prev }; delete n[key]; return n; }); return; }
    setViews(prev => ({ ...prev, [key]: 'loading' }));
    try {
      const res = await fetch(`${base}/api/plugins/${encodeURIComponent(p.id)}/file?path=${encodeURIComponent(path)}`);
      const body = await res.json().catch(() => null);
      setViews(prev => ({ ...prev, [key]: interpretFileView(res.status, body) }));
    } catch {
      setViews(prev => ({ ...prev, [key]: { kind: 'error', message: 'Network error.' } }));
    }
  };

  const review = async (p: PluginInfo) => {
    if (reviews[p.id]) { closeReview(p.id); return; }
    setNote(p.id, null);
    setReviews(prev => ({ ...prev, [p.id]: { files: null, error: null } }));
    try {
      const res = await fetch(`${base}/api/plugins/${encodeURIComponent(p.id)}/files`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setReviews(prev => ({ ...prev, [p.id]: { files: Array.isArray(data?.files) ? data.files : [], error: null } }));
    } catch {
      setReviews(prev => ({ ...prev, [p.id]: { files: null, error: 'Could not load the file list.' } }));
    }
  };

  const ratify = async (p: PluginInfo) => {
    setBusy(p.id);
    setNote(p.id, null);
    try {
      const res = await fetch(`${base}/api/plugins/${encodeURIComponent(p.id)}/ratify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The digest the list was fetched with, never a fresher one.
        body: JSON.stringify({ digest: p.ratification?.digest }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        closeReview(p.id);
        setNote(p.id, 'Ratified.', true);
        await load();
      } else {
        const f = interpretRatifyFailure(res.status, body);
        closeReview(p.id);
        setNote(p.id, f.message);
        if (f.refresh) await load();
      }
    } catch {
      setNote(p.id, 'Network error.');
    }
    setBusy(null);
  };

  const reload = async (p: PluginInfo) => {
    setBusy(p.id);
    setNote(p.id, null);
    try {
      const res = await fetch(`${base}/api/plugins/${encodeURIComponent(p.id)}/reload`, { method: 'POST' });
      if (res.ok) {
        setNote(p.id, 'Reloaded.', true);
      } else {
        const body = await res.json().catch(() => null);
        setNote(p.id, body?.detail || body?.error || `Reload failed (${res.status})`);
      }
    } catch {
      setNote(p.id, 'Network error.');
    }
    setBusy(null);
  };

  // Companion mode: the person looked at what is on screen. The digest is the one the list was fetched with.
  const markSeen = async (p: PluginInfo) => {
    setBusy(p.id);
    setNote(p.id, null);
    try {
      const res = await fetch(`${base}/api/plugins/${encodeURIComponent(p.id)}/seen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ digest: p.audit?.digest }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        closeReview(p.id);
        setNote(p.id, 'Marked as seen.', true);
        await load();
      } else {
        const f = interpretSeenFailure(res.status, body);
        closeReview(p.id);
        setNote(p.id, f.message);
        if (f.refresh) await load();
      }
    } catch {
      setNote(p.id, 'Network error.');
    }
    setBusy(null);
  };

  // Companion mode: switch a plugin on or off. Applies on the next run; no restart.
  const setEnabled = async (p: PluginInfo, on: boolean) => {
    setBusy(p.id);
    setNote(p.id, null);
    try {
      const res = await fetch(`${base}/api/plugins/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: toggleEnabled(plugins.filter(x => x.enabled).map(x => x.id), p.id, on) }),
      });
      if (res.ok) {
        await load();
      } else {
        const body = await res.json().catch(() => null);
        setNote(p.id, interpretEnabledFailure(res.status, body));
      }
    } catch {
      setNote(p.id, 'Network error.');
    }
    setBusy(null);
  };

  const companion = trust === 'companion';

  return (
    <div className="plugins-section">
      <style>{`.pl-hint { color: var(--text-muted, #6a6258); font-size: 0.8125rem; }`}</style>
      {companion ? (
        <p className="pl-hint" style={{ margin: '0 0 1rem' }}>
          Your companion manages plugins: it can turn them on and off and edit them, and what it changes is marked here so you can look. Plugins run with the app's own access, and your companion can change anything the OS user can, by design. To read and approve code before it runs instead, set plugins.trust to "person" in sanctum.yaml.
        </p>
      ) : (
        <p className="pl-hint" style={{ margin: '0 0 1rem' }}>
          Plugins run with the app's own access. You ratify the exact code; if it changes, it stops running until you ratify it again. The companion runs as the same OS user as the app, so a process of that user with unconfined file access can rewrite the ratification record too.
        </p>
      )}

      {loading ? (
        <Spinner />
      ) : loadError ? (
        <p style={{ color: ERR_COLOR }} role="alert">{loadError}</p>
      ) : disabled ? (
        <Group>
          <div style={{ padding: '0.75rem 0' }}>
            <p style={{ margin: 0 }}>{describeDisabled(disabled, disabledDetail)?.title}</p>
            <p className="pl-hint" style={{ margin: '0.5rem 0 0', overflowWrap: 'anywhere' }}>
              {describeDisabled(disabled, disabledDetail)?.body}
            </p>
          </div>
        </Group>
      ) : plugins.length === 0 ? (
        <EmptyState message="No plugins found." />
      ) : (
        <>
          <Eyebrow label="plugins" />
          <Group>
            {plugins.map(p => {
              const badge = ratificationBadge(p.ratification?.state);
              const rv = reviews[p.id];
              const note = notes[p.id];
              const changes = companion ? (p.audit?.changes ?? []) : (p.ratification?.changes ?? []);
              const summary = changeSummary(changes);
              const changed = companion && changedSinceView(p);
              return (
                <div key={p.id} className="plugin-row" style={{ padding: '0.75rem 0', borderBottom: '1px solid rgba(90,65,40,0.12)' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                    <strong>{p.name}</strong>
                    <span className="pl-hint">v{p.version}</span>
                    {companion
                      ? (changed && <Pill color={TONE_COLOR.warn} label="Changed since you last looked" />)
                      : <Pill color={TONE_COLOR[badge.tone]} label={badge.label} />}
                  </div>
                  <div className="pl-hint" style={{ marginTop: '0.25rem', overflowWrap: 'anywhere' }}>
                    {p.id} · {p.enabled ? 'enabled' : 'not enabled'}
                    {companion && p.audit?.last_change_at && ` · last changed ${describeChangeTime(p.audit.last_change_at)}`}
                  </div>
                  {companion && (
                    <ToggleRow
                      label="Enabled"
                      checked={p.enabled}
                      disabled={busy === p.id || !!(p.error && !p.enabled)}
                      onChange={(on) => void setEnabled(p, on)}
                      hint="Applies on the next run."
                    />
                  )}
                  {companion && p.warnings && p.warnings.length > 0 && (
                    <div className="pl-hint" style={{ marginTop: '0.25rem', overflowWrap: 'anywhere' }}>
                      Warning: {p.warnings.join('; ')}
                    </div>
                  )}
                  {p.error && (
                    <div style={{ color: ERR_COLOR, marginTop: '0.25rem', overflowWrap: 'anywhere' }}>{p.error}</div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
                    {(companion ? canReviewAudit(p) : canReview(p)) && (
                      <Btn small onClick={() => void review(p)} disabled={busy === p.id}>
                        {rv ? 'Hide' : 'Review'}
                      </Btn>
                    )}
                    {companion && changed && !rv && (
                      <Btn small onClick={() => void markSeen(p)} disabled={busy === p.id}>Mark as seen</Btn>
                    )}
                    {canReload(p, trust) && (
                      <Btn small onClick={() => void reload(p)} disabled={busy === p.id}>Reload</Btn>
                    )}
                  </div>
                  {rv && (
                    <div style={{ marginTop: '0.625rem' }}>
                      {rv.error ? (
                        <div style={{ color: ERR_COLOR }} role="alert">{rv.error}</div>
                      ) : rv.files === null ? (
                        <Spinner />
                      ) : (
                        <>
                          {(companion ? changed : p.ratification?.state === 'changed') && summary && (
                            <div style={{ marginBottom: '0.5rem' }}>
                              <div className="pl-hint">{companion ? 'Changed since you last looked' : 'Changed since you ratified'}: {summary}</div>
                              <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.1rem', fontFamily: 'monospace', fontSize: '0.75rem', overflowWrap: 'anywhere' }}>
                                {changes.map(c => <li key={c.path}>{changeLine(c)}</li>)}
                              </ul>
                            </div>
                          )}
                          <div className="pl-hint">Files ({rv.files.length}). Tap one to read it.</div>
                          <ul style={{ margin: '0.25rem 0 0.75rem', padding: 0, listStyle: 'none', fontFamily: 'monospace', fontSize: '0.75rem', overflowWrap: 'anywhere' }}>
                            {orderFiles(rv.files, changes).map(f => {
                              const view = views[viewKey(p.id, f.path)];
                              return (
                                <li key={f.path} style={{ margin: '0.125rem 0' }}>
                                  <button
                                    type="button"
                                    onClick={() => void toggleFile(p, f.path)}
                                    aria-expanded={!!view}
                                    style={{ all: 'unset', cursor: 'pointer', display: 'block', padding: '0.375rem 0', width: '100%', boxSizing: 'border-box', textDecoration: 'underline', textUnderlineOffset: '2px' }}
                                  >
                                    {f.change && <strong style={{ color: TONE_COLOR.warn }}>{f.change}  </strong>}
                                    {f.path} <span className="pl-hint">({f.size} bytes)</span>
                                  </button>
                                  {view === 'loading' ? (
                                    <Spinner />
                                  ) : view?.kind === 'text' ? (
                                    <pre style={{ margin: '0.25rem 0 0.5rem', padding: '0.5rem', maxHeight: '20rem', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'rgba(90,65,40,0.08)', borderRadius: 6, fontSize: '0.75rem' }}>{view.text === '' ? '(empty file)' : view.text}</pre>
                                  ) : view?.kind === 'binary' ? (
                                    <div className="pl-hint" style={{ margin: '0.25rem 0 0.5rem' }}>Not shown: this file is not plain text, or it is larger than 256 KB.</div>
                                  ) : view?.kind === 'error' ? (
                                    <div role="alert" style={{ color: ERR_COLOR, margin: '0.25rem 0 0.5rem' }}>{view.message}</div>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                          {companion ? (
                            changed && (
                              <Btn variant="primary" onClick={() => void markSeen(p)} disabled={busy === p.id}>
                                Mark as seen
                              </Btn>
                            )
                          ) : (
                            <Btn variant="primary" onClick={() => void ratify(p)} disabled={busy === p.id}>
                              Ratify this code
                            </Btn>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {note && (
                    <div role={note.ok ? 'status' : 'alert'} style={{ marginTop: '0.5rem', color: note.ok ? TONE_COLOR.ok : ERR_COLOR }}>
                      {note.text}
                    </div>
                  )}
                </div>
              );
            })}
          </Group>
          <p className="pl-hint" style={{ marginTop: '0.75rem' }}>
            {companion
              ? 'Turning a plugin on or off here, or by your companion, applies on the next run. It is written to plugins.enabled in sanctum.yaml.'
              : 'Turning a plugin on or off happens in sanctum.yaml (plugins.enabled) and needs a restart.'}
          </p>
        </>
      )}
    </div>
  );
}
