/**
 * Identity section.
 * Status from GET /api/identity/status; the live files (text and the digest they were read at) from GET /api/identity/files;
 * the journal from GET /api/identity/history; per-file unified diffs from GET /api/identity/diff.
 * Ratify: POST /api/identity/ratify { digest }. Roll back: POST /api/identity/revert { digest }.
 * Edit a file: PUT /api/identity/file { path, text, digest } with the digest the editor was opened at; a 409 means the files moved.
 * Your companion runs on the ratified version. A change that is not ratified yet (made by you, your companion, or something
 * on disk) waits here until you look at it and ratify it or roll it back.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Group, Eyebrow, Btn, Pill, EmptyState, Spinner } from './primitives';
import { useConfirm } from '../ConfirmDialog';
import { useChatStore } from '../../store/chat';
import {
  isIdentityStatus, LEGACY_EXPLANATION, statusNeedsReload, identityBadge, pendingHeadline, describeWhen, changeLine, parseDiff, diffNote,
  interpretWriteFailure, canSave, saveHint, canEdit, showRatifyWhenUnavailable, ratifyReady, diffsShown, entryState, entryTitle, entryFiles, ENTRY_STATE_WORDS,
  type IdentityStatus, type IdentityJournalEntry, type IdentityDiffFile,
} from './identityState';

const TONE_COLOR = { ok: '#6dba88', warn: '#d4a843', muted: '#71717a' } as const;
const ERR_COLOR = 'rgba(210,140,130,0.9)';
const DIFF_COLOR = { add: '#6dba88', del: 'rgba(210,140,130,0.95)', hunk: '#8a9bb0', header: '#71717a', context: 'inherit' } as const;

interface LiveFile { name: string; text: string }
type Note = { text: string; ok: boolean } | null;

export function IdentitySection({ base }: { base: string }) {
  const confirm = useConfirm();
  const [status, setStatus] = useState<IdentityStatus | null>(null);
  const [files, setFiles] = useState<LiveFile[]>([]);
  const [filesDigest, setFilesDigest] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<IdentityJournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [fileNotes, setFileNotes] = useState<Record<string, Note>>({});
  const [diffs, setDiffs] = useState<Record<string, IdentityDiffFile> | 'loading' | 'error' | null>(null);
  const [openDiffs, setOpenDiffs] = useState<Record<string, boolean>>({});
  const [openEditors, setOpenEditors] = useState<Record<string, boolean>>({});

  const publish = (s: IdentityStatus) => { setStatus(s); useChatStore.setState({ identityStatus: s }); };

  const load = useCallback(async () => {
    try {
      const [st, fl, hi] = await Promise.all([
        fetch(`${base}/api/identity/status`),
        fetch(`${base}/api/identity/files`),
        fetch(`${base}/api/identity/history?limit=50`),
      ]);
      if (!st.ok) throw new Error(`HTTP ${st.status}`);
      const sBody = await st.json();
      if (!isIdentityStatus(sBody)) throw new Error('bad status');
      publish(sBody);
      if (fl.ok) {
        const f = await fl.json();
        const list: LiveFile[] = Array.isArray(f?.files) ? f.files : [];
        setFiles(list);
        setFilesDigest(typeof f?.digest === 'string' ? f.digest : '');
      } else { setFiles([]); setFilesDigest(''); }
      if (hi.ok) {
        const h = await hi.json();
        setHistory(Array.isArray(h?.entries) ? h.entries : []);
      }
      setDiffs(null);
      setLoadError(null);
    } catch {
      setLoadError('Could not load the identity files.');
    }
    setLoading(false);
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  // The live status follows the socket (`identity_status`): a change noticed while this page is open shows up at once.
  const live = useChatStore(s => s.identityStatus);
  useEffect(() => {
    if (statusNeedsReload(status, live)) void load();
  }, [live, status, load]);

  const loadDiffs = async () => {
    setDiffs('loading');
    try {
      const res = await fetch(`${base}/api/identity/diff?from=ratified&to=live`);
      if (!res.ok) throw new Error();
      const body = await res.json();
      const map: Record<string, IdentityDiffFile> = {};
      for (const f of (Array.isArray(body?.files) ? body.files : []) as IdentityDiffFile[]) map[f.path] = f;
      setDiffs(map);
    } catch { setDiffs('error'); }
  };

  // Over a damaged ledger the card shows what ratifying would record, so it never asks for approval of text that is not on screen.
  const damagedCard = showRatifyWhenUnavailable(status);
  useEffect(() => { if (damagedCard && diffs === null) void loadDiffs(); }, [damagedCard, diffs]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDiff = (path: string) => {
    const open = !openDiffs[path];
    setOpenDiffs(prev => ({ ...prev, [path]: open }));
    if (open && diffs === null) void loadDiffs();
  };

  const act = async (kind: 'ratify' | 'revert') => {
    if (!status) return;
    const ok = await confirm(kind === 'ratify'
      ? {
        title: status.state === 'pending' ? 'Ratify these changes?' : 'Ratify the identity files?',
        body: 'Your companion will run on these files from its next turn. You are saying you have read them.',
        confirmLabel: 'Ratify',
      }
      : {
        title: 'Roll back to the ratified version?',
        body: 'The waiting changes are written over with the version you ratified, and files added since are removed. This cannot be undone.',
        confirmLabel: 'Roll back',
        destructive: true,
      });
    if (!ok) return;
    setBusy(kind);
    setNote(null);
    try {
      // The digest on screen, never a fresher one.
      const res = await fetch(`${base}/api/identity/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ digest: status.digest }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        if (isIdentityStatus(body?.status)) publish(body.status);
        setNote({ text: kind === 'ratify' ? 'Ratified.' : 'Rolled back.', ok: true });
        setDrafts({});
        await load();
      } else {
        const f = interpretWriteFailure(res.status, body, kind);
        setNote({ text: f.message, ok: false });
        if (f.reload) await load();
      }
    } catch {
      setNote({ text: 'Network error.', ok: false });
    }
    setBusy(null);
  };

  const save = async (f: LiveFile) => {
    const text = drafts[f.name] ?? f.text;
    setBusy(`save:${f.name}`);
    setFileNotes(prev => ({ ...prev, [f.name]: null }));
    try {
      const res = await fetch(`${base}/api/identity/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: f.name, text, digest: filesDigest }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        if (isIdentityStatus(body?.status)) publish(body.status);
        setFileNotes(prev => ({ ...prev, [f.name]: { text: body?.ratified ? 'Saved and ratified.' : 'Saved. It is waiting for you to ratify it.', ok: true } }));
        setDrafts(prev => { const n = { ...prev }; delete n[f.name]; return n; });
        await load();
      } else {
        const fail = interpretWriteFailure(res.status, body, 'save');
        setFileNotes(prev => ({ ...prev, [f.name]: { text: fail.message, ok: false } }));
        if (fail.reload) await load(); // the drafts stay: what you typed is not lost
      }
    } catch {
      setFileNotes(prev => ({ ...prev, [f.name]: { text: 'Network error.', ok: false } }));
    }
    setBusy(null);
  };

  const badge = identityBadge(status?.state);

  return (
    <div className="identity-section">
      <style>{`
        .id-hint { color: var(--text-muted, #6a6258); font-size: 0.8125rem; }
        .id-diff { margin: 0.25rem 0 0.5rem; padding: 0.5rem; max-height: 20rem; overflow: auto; background: rgba(90,65,40,0.08); border-radius: 6px; font-family: monospace; font-size: 0.75rem; line-height: 1.45; }
        .id-diff div { white-space: pre-wrap; overflow-wrap: anywhere; }
        .id-textarea { width: 100%; box-sizing: border-box; min-height: 12rem; resize: vertical; padding: 0.5rem; border-radius: 6px; border: 1px solid rgba(90,65,40,0.25); background: rgba(90,65,40,0.06); color: inherit; font-family: monospace; font-size: 0.8125rem; line-height: 1.5; }
      `}</style>
      <p className="id-hint" style={{ margin: '0 0 1rem' }}>
        The files in your companion's identity folder are who it is. It runs on the version you ratified. A change that you have not ratified yet waits here, whoever made it: you, your companion, or something else on this machine. This protects against anything that cannot also rewrite the ratification record, which the app keeps outside the identity folder.
      </p>

      {loading ? (
        <Spinner />
      ) : loadError ? (
        <p style={{ color: ERR_COLOR }} role="alert">{loadError}</p>
      ) : !status ? (
        <EmptyState message="No identity status." />
      ) : (
        <>
          <Eyebrow label="status" />
          <Group>
            <div style={{ padding: '0.75rem 0' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                <span className="conn-pip" aria-hidden style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: TONE_COLOR[badge.tone] }} />
                <Pill color={TONE_COLOR[badge.tone]} label={badge.label} />
                {status.ratified && (
                  <span className="id-hint">ratified {describeWhen(status.ratified.at)}{status.ratified.by === 'setup' ? ' at setup' : ''}</span>
                )}
              </div>
              {status.state === 'ok' && (
                <p className="id-hint" style={{ margin: '0.5rem 0 0' }}>The files on disk are the version you ratified.</p>
              )}
              {status.state === 'unratified' && (
                <>
                  <p className="id-hint" style={{ margin: '0.5rem 0 0' }}>
                    Nothing has been ratified yet. Your companion is running on the files as they are now. Read them below, then ratify them once; after that, any change waits for you.
                  </p>
                  <div style={{ marginTop: '0.5rem' }}>
                    <Btn variant="primary" onClick={() => void act('ratify')} disabled={busy !== null || !ratifyReady(status, filesDigest)}>Ratify what is here now</Btn>
                  </div>
                </>
              )}
              {status.state === 'legacy' && (
                <p className="id-hint" style={{ margin: '0.5rem 0 0' }}>{LEGACY_EXPLANATION}</p>
              )}
              {status.state === 'unavailable' && (
                <p style={{ color: ERR_COLOR, margin: '0.5rem 0 0', overflowWrap: 'anywhere' }} role="alert">
                  The identity check could not run: {status.detail ?? 'unknown reason'}. Runs use the ratified copy when there is one, and the live files otherwise.
                </p>
              )}
              {showRatifyWhenUnavailable(status) && (
                <div style={{ marginTop: '0.5rem' }}>
                  <p className="id-hint" style={{ margin: '0 0 0.5rem' }}>
                    If the files below are what you want, ratifying them starts a new record (an unreadable ledger is kept beside it, not deleted).
                  </p>
                  {diffs === 'loading' || diffs === null ? <Spinner />
                    : diffs === 'error' ? <div role="alert" style={{ color: ERR_COLOR, marginBottom: '0.5rem' }}>Could not load the files. Reload before ratifying.</div>
                    : Object.values(diffs).map(d => (
                      <div key={d.path} style={{ marginBottom: '0.5rem' }}>
                        <strong style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{d.path}</strong>
                        {diffNote(d) ? <div className="id-hint">{diffNote(d)}</div> : (
                          <div className="id-diff" role="region" aria-label={`Text of ${d.path}`}>
                            {parseDiff(d.diff).map((l, i) => <div key={i} style={{ color: DIFF_COLOR[l.kind] }}>{l.text}</div>)}
                          </div>
                        )}
                      </div>
                    ))}
                  <Btn variant="primary" onClick={() => void act('ratify')} disabled={busy !== null || !ratifyReady(status, filesDigest) || !diffsShown(diffs)}>Ratify what is here now</Btn>
                </div>
              )}
              {status.warning && (
                <p style={{ color: TONE_COLOR.warn, margin: '0.5rem 0 0', overflowWrap: 'anywhere' }} role="note">{status.warning}</p>
              )}
              {status.skipped.length > 0 && (
                <p className="id-hint" style={{ margin: '0.5rem 0 0' }}>Left out because they are links, not files: {status.skipped.join(', ')}.</p>
              )}
              {note && (
                <div role={note.ok ? 'status' : 'alert'} style={{ marginTop: '0.5rem', color: note.ok ? TONE_COLOR.ok : ERR_COLOR }}>{note.text}</div>
              )}
            </div>
          </Group>

          {status.state === 'pending' && status.pending && (
            <>
              <Eyebrow label="waiting for you" />
              <Group>
                <div style={{ padding: '0.75rem 0' }}>
                  <div style={{ fontWeight: 600 }}>{pendingHeadline(status)}</div>
                  <div className="id-hint" style={{ marginTop: '0.25rem' }}>
                    {status.pending.since ? `First noticed ${describeWhen(status.pending.since)}. ` : ''}
                    Until you ratify it, every run uses the version you ratified {status.ratified ? describeWhen(status.ratified.at) : ''}.
                  </div>
                  <ul style={{ margin: '0.625rem 0 0', padding: 0, listStyle: 'none', fontFamily: 'monospace', fontSize: '0.75rem', overflowWrap: 'anywhere' }}>
                    {status.pending.changes.map(c => {
                      const open = !!openDiffs[c.path];
                      const d = diffs && typeof diffs === 'object' ? diffs[c.path] : undefined;
                      return (
                        <li key={c.path} style={{ margin: '0.125rem 0' }}>
                          <button
                            type="button"
                            onClick={() => toggleDiff(c.path)}
                            aria-expanded={open}
                            style={{ all: 'unset', cursor: 'pointer', display: 'block', padding: '0.375rem 0', width: '100%', boxSizing: 'border-box', textDecoration: 'underline', textUnderlineOffset: '2px' }}
                          >
                            <strong style={{ color: TONE_COLOR.warn }}>{changeLine(c)}</strong>
                          </button>
                          {open && (diffs === 'loading' || diffs === null ? <Spinner />
                            : diffs === 'error' ? <div role="alert" style={{ color: ERR_COLOR }}>Could not load the changes.</div>
                            : d ? (diffNote(d)
                              ? <div className="id-hint" style={{ margin: '0.25rem 0 0.5rem' }}>{diffNote(d)}</div>
                              : (
                                <div className="id-diff" role="region" aria-label={`Changes to ${c.path}`}>
                                  {parseDiff(d.diff).map((l, i) => <div key={i} style={{ color: DIFF_COLOR[l.kind] }}>{l.text}</div>)}
                                </div>
                              ))
                              : <div className="id-hint">No text changes.</div>)}
                        </li>
                      );
                    })}
                  </ul>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem' }}>
                    <Btn variant="primary" onClick={() => void act('ratify')} disabled={busy !== null || !ratifyReady(status, filesDigest)}>Ratify</Btn>
                    <Btn variant="danger" onClick={() => void act('revert')} disabled={busy !== null}>Roll back</Btn>
                  </div>
                </div>
              </Group>
            </>
          )}

          <Eyebrow label="files" sub="edit" />
          <Group>
            {files.length === 0 ? (
              <EmptyState message="No identity files." />
            ) : files.map(f => {
              const draft = drafts[f.name] ?? f.text;
              const open = !!openEditors[f.name];
              const n = fileNotes[f.name];
              return (
                <div key={f.name} style={{ padding: '0.75rem 0', borderBottom: '1px solid rgba(90,65,40,0.12)' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                    <strong style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}>{f.name}</strong>
                    {draft !== f.text && <Pill color={TONE_COLOR.warn} label="Unsaved" />}
                    <Btn small onClick={() => setOpenEditors(prev => ({ ...prev, [f.name]: !open }))}>{open ? 'Close' : 'Edit'}</Btn>
                  </div>
                  {open && (
                    <div style={{ marginTop: '0.5rem' }}>
                      <textarea
                        className="id-textarea"
                        aria-label={`Text of ${f.name}`}
                        value={draft}
                        spellCheck={false}
                        disabled={!canEdit(status)}
                        onChange={(e) => setDrafts(prev => ({ ...prev, [f.name]: e.target.value }))}
                      />
                      <div className="id-hint" style={{ margin: '0.25rem 0 0.5rem' }}>{saveHint(status)}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <Btn variant="primary" onClick={() => void save(f)} disabled={!canEdit(status) || !canSave(f.text, draft, busy !== null)}>Save</Btn>
                        <Btn onClick={() => setDrafts(prev => { const x = { ...prev }; delete x[f.name]; return x; })} disabled={draft === f.text}>Discard changes</Btn>
                      </div>
                    </div>
                  )}
                  {n && <div role={n.ok ? 'status' : 'alert'} style={{ marginTop: '0.5rem', color: n.ok ? TONE_COLOR.ok : ERR_COLOR }}>{n.text}</div>}
                </div>
              );
            })}
          </Group>

          <Eyebrow label="history" />
          <Group>
            {history.length === 0 ? (
              <EmptyState message="Nothing recorded yet." />
            ) : history.map((e, i) => {
              const st = entryState(e, status);
              const names = entryFiles(e);
              return (
                <div key={`${e.at}-${i}`} style={{ padding: '0.625rem 0', borderBottom: '1px solid rgba(90,65,40,0.12)' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'baseline' }}>
                    <strong>{entryTitle(e)}</strong>
                    <span className="id-hint">{describeWhen(e.at)}</span>
                    <Pill color={st === 'ratified' ? TONE_COLOR.ok : st === 'waiting' ? TONE_COLOR.warn : TONE_COLOR.muted} label={ENTRY_STATE_WORDS[st]} />
                  </div>
                  {names && <div className="id-hint" style={{ fontFamily: 'monospace', overflowWrap: 'anywhere', marginTop: '0.125rem' }}>{names}</div>}
                  <div className="id-hint" style={{ marginTop: '0.125rem', overflowWrap: 'anywhere' }}>{e.detail}</div>
                </div>
              );
            })}
          </Group>
        </>
      )}
    </div>
  );
}
