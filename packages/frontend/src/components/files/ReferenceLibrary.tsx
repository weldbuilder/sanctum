/**
 * ReferenceLibrary: the "References" chip of the Files page. It sits in the Files plate (`fl-plate`) and uses Files' own
 * controls and tiles (`fl-btn`, `fl-input`, `fl-grid`, `fl-cell`, `fl-thumb`); nothing here sets a colour of its own: the
 * pressed state is the toggle's, the delete is `fl-btn-danger`. Errors and confirmations go to Files' own notice (`fl-notice`).
 *
 * ReferenceGrid is the pure view (props in, markup out) so it can be rendered on the server in a test;
 * ReferenceLibrary holds the state: GET /api/references, POST (name, note, self, file), PATCH /:id ({ self } or { note }), DELETE /:id.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BASE } from '../../lib/base';
import { useConfirm } from '../ConfirmDialog';
import {
  REFERENCE_HINT, REFERENCE_NAME_MAX, REFERENCE_NOTE_MAX, readReferences, referenceDraftProblem, referenceError, type ReferenceItem,
} from './references';

export interface ReferenceGridProps {
  state: 'loading' | 'ready' | 'error';
  refs: ReferenceItem[];
  query: string;
  /** Draft form */
  name: string;
  note: string;
  self: boolean;
  fileName: string;
  busy: boolean;
  /** The card whose note is being edited, with the text so far. */
  editing: { id: string; text: string } | null;
  onName: (v: string) => void;
  onNote: (v: string) => void;
  onSelf: (v: boolean) => void;
  onPick: () => void;
  onAdd: () => void;
  onToggleSelf: (r: ReferenceItem) => void;
  onEdit: (r: ReferenceItem) => void;
  onEditText: (v: string) => void;
  onSaveNote: (r: ReferenceItem) => void;
  onCancelEdit: () => void;
  onDelete: (r: ReferenceItem) => void;
}

export function ReferenceGrid(p: ReferenceGridProps) {
  const q = p.query.trim().toLowerCase();
  const shown = q ? p.refs.filter(r => `${r.name} ${r.note}`.toLowerCase().includes(q)) : p.refs;
  return (
    <div className="fl-ref">
      <form className="fl-ref-form" onSubmit={e => { e.preventDefault(); p.onAdd(); }}>
        <div className="fl-ref-row">
          <input
            className="fl-input fl-ref-name"
            value={p.name}
            maxLength={REFERENCE_NAME_MAX}
            placeholder="Name, e.g. Echo"
            aria-label="Reference name"
            onChange={e => p.onName(e.target.value)}
          />
          <input
            className="fl-input fl-ref-note"
            value={p.note}
            maxLength={REFERENCE_NOTE_MAX}
            placeholder="Note, e.g. green coat"
            aria-label="Reference note"
            onChange={e => p.onNote(e.target.value)}
          />
        </div>
        <div className="fl-ref-row">
          <label className="fl-ref-check">
            <input type="checkbox" checked={p.self} onChange={e => p.onSelf(e.target.checked)} />
            <span>This is the companion</span>
          </label>
          <button type="button" className="fl-btn hearth-press" onClick={p.onPick}>{p.fileName || 'Choose picture'}</button>
          <button type="submit" className="fl-btn fl-btn-primary hearth-press" disabled={p.busy}>Add reference</button>
        </div>
        <p className="fl-ref-hint">{REFERENCE_HINT}</p>
      </form>
      {p.state === 'loading' ? <p className="fl-quiet-in">Opening…</p>
        : p.state === 'error' ? <p className="fl-quiet-in">Could not load the references.</p>
        : shown.length === 0 ? <p className="fl-quiet-in">{q ? `No reference matches “${p.query.trim()}”.` : 'No references yet. Add a picture of someone or something and your companion can draw from it by name.'}</p>
        : (
          <ul className="fl-grid fl-ref-grid">
            {shown.map(r => {
              const editing = p.editing?.id === r.id;
              return (
                <li key={r.id} className="fl-cell fl-ref-cell">
                  <span className="fl-thumb"><img src={r.url} alt={r.name} loading="lazy" decoding="async" /></span>
                  <span className="fl-tile-foot">
                    <span className="fl-tile-text">
                      <span className="fl-ref-title">
                        <span className="fl-tile-name" title={r.name}>{r.name}</span>
                        {r.self && <span className="fl-ref-badge">You</span>}
                      </span>
                      {!editing && <span className="fl-meta fl-ref-notetext">{r.note || 'No note'}</span>}
                    </span>
                  </span>
                  {editing ? (
                    <form className="fl-ref-edit" onSubmit={e => { e.preventDefault(); p.onSaveNote(r); }}>
                      <input
                        className="fl-input"
                        value={p.editing!.text}
                        maxLength={REFERENCE_NOTE_MAX}
                        aria-label={`Note for ${r.name}`}
                        autoFocus
                        onChange={e => p.onEditText(e.target.value)}
                      />
                      <span className="fl-ref-actions">
                        <button type="submit" className="fl-btn fl-btn-primary hearth-press">Save note</button>
                        <button type="button" className="fl-btn hearth-press" onClick={p.onCancelEdit}>Cancel</button>
                      </span>
                    </form>
                  ) : (
                    <span className="fl-ref-actions">
                      <span className="fl-toggle fl-ref-you">
                        <button type="button" aria-pressed={r.self} onClick={() => p.onToggleSelf(r)}>This is you</button>
                      </span>
                      <button type="button" className="fl-btn hearth-press" aria-label={`Edit the note for ${r.name}`} onClick={() => p.onEdit(r)}>Edit note</button>
                      <button type="button" className="fl-btn fl-btn-danger hearth-press" aria-label={`Delete ${r.name}`} onClick={() => p.onDelete(r)}>Delete</button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      <style>{`
        .fl-ref-form { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.9rem; }
        .fl-ref-row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
        .fl-ref-name { flex: 1 1 11rem; min-width: 0; min-height: 2.5rem; box-sizing: border-box; }
        .fl-ref-note { flex: 2 1 14rem; min-width: 0; min-height: 2.5rem; box-sizing: border-box; }
        .fl-ref-check { display: inline-flex; align-items: center; gap: 0.45rem; min-height: 2.5rem; color: var(--text-secondary); font-family: var(--font-serif, 'Lora', serif); font-size: 0.92rem; cursor: pointer; }
        .fl-ref-check input { width: 1.1rem; height: 1.1rem; accent-color: var(--skin-trim); }
        .fl-ref-row .fl-btn { min-height: 2.5rem; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fl-ref-row .fl-btn:disabled { opacity: 0.55; cursor: default; }
        .fl-ref-hint { margin: 0; font-family: var(--font-serif, 'Lora', serif); font-style: italic; font-size: 0.85rem; color: var(--text-muted); }
        .fl-ref-cell .fl-thumb img { width: auto; height: auto; max-width: 100%; max-height: 7rem; object-fit: contain; }
        .fl-ref-cell .fl-tile-foot { padding-right: max(0.8rem, var(--plate-corner, 0px)); }
        .fl-ref-title { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
        .fl-ref-title .fl-tile-name { min-width: 0; }
        .fl-ref-badge {
          flex: none;
          padding: 0.05rem 0.45rem;
          border: 1px solid color-mix(in srgb, var(--text-primary) 40%, transparent);
          border-radius: 4px;
          background: color-mix(in srgb, var(--text-primary) 8%, transparent);
          color: var(--text-primary);
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.65rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .fl-ref-notetext { display: block; white-space: normal; overflow-wrap: anywhere; }
        .fl-ref-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; padding: 0 0.7rem 0.7rem; }
        .fl-ref-actions .fl-btn, .fl-ref-you button { min-height: 2.5rem; justify-content: center; padding-inline: 0.6rem; }
        .fl-ref-you { flex: 1 1 100%; }
        .fl-ref-you button { flex: 1; font-family: var(--font-serif, 'Lora', serif); font-size: 0.92rem; }
        .fl-ref-edit { display: flex; flex-direction: column; gap: 0.4rem; padding: 0 0.7rem 0.7rem; }
        .fl-ref-edit .fl-input { min-height: 2.5rem; box-sizing: border-box; width: 100%; }
        .fl-ref-edit .fl-ref-actions { padding: 0; }
        .fl-ref-edit .fl-ref-actions .fl-btn { flex: 1; }
        @media (max-width: 768px) {
          .fl-ref-row .fl-btn { flex: 1 1 8rem; }
          .fl-ref-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
      `}</style>
    </div>
  );
}

export function ReferenceLibrary({ query, onNotice }: {
  query: string;
  onNotice: (text: string, error: boolean) => void;
}) {
  const confirm = useConfirm();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refs, setRefs] = useState<ReferenceItem[]>([]);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [self, setSelf] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    fetch(`${BASE}/api/references`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (live) { setRefs(readReferences(d).map(r => ({ ...r, url: r.url || `${BASE}/api/files/${encodeURIComponent(r.fileId)}` }))); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [tick]);

  const add = useCallback(async () => {
    const problem = referenceDraftProblem(name, file);
    if (problem || !file) { onNotice(problem ?? 'Choose a picture', true); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('name', name.trim());
      fd.append('note', note.trim());
      fd.append('self', self ? '1' : '0');
      fd.append('file', file);
      const r = await fetch(`${BASE}/api/references`, { method: 'POST', body: fd });
      if (!r.ok) { onNotice(referenceError(r.status, await r.json().catch(() => null)), true); return; }
      onNotice(`Added ${name.trim()} to the references`, false);
      setName(''); setNote(''); setSelf(false); setFile(null);
      setTick(t => t + 1);
    } catch {
      onNotice('Could not reach the file service.', true);
    } finally { setBusy(false); }
  }, [name, note, self, file, onNotice]);

  const patch = useCallback(async (r: ReferenceItem, body: { self?: boolean; note?: string }, done: string) => {
    try {
      const res = await fetch(`${BASE}/api/references/${encodeURIComponent(r.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) { onNotice(referenceError(res.status, await res.json().catch(() => null)), true); return; }
      onNotice(done, false);
      setEditing(null);
      setTick(t => t + 1);
    } catch { onNotice('Could not reach the file service.', true); }
  }, [onNotice]);

  const del = useCallback(async (r: ReferenceItem) => {
    const ok = await confirm({ title: `Delete ${r.name}?`, body: 'The reference and its picture are removed. This cannot be undone.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    try {
      const res = await fetch(`${BASE}/api/references/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      if (!res.ok) { onNotice(referenceError(res.status, await res.json().catch(() => null)), true); return; }
      onNotice(`Deleted ${r.name}`, false);
      setTick(t => t + 1);
    } catch { onNotice('Could not reach the file service.', true); }
  }, [confirm, onNotice]);

  return (
    <>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden
        onChange={e => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      <ReferenceGrid
        state={state} refs={refs} query={query}
        name={name} note={note} self={self} fileName={file?.name ?? ''} busy={busy} editing={editing}
        onName={setName} onNote={setNote} onSelf={setSelf} onPick={() => input.current?.click()} onAdd={() => void add()}
        onToggleSelf={r => void patch(r, { self: !r.self }, r.self ? `${r.name} is no longer you` : `${r.name} is you`)}
        onEdit={r => setEditing({ id: r.id, text: r.note })}
        onEditText={v => setEditing(e => (e ? { ...e, text: v } : e))}
        onSaveNote={r => void patch(r, { note: editing?.text ?? '' }, `Saved the note for ${r.name}`)}
        onCancelEdit={() => setEditing(null)}
        onDelete={r => void del(r)}
      />
    </>
  );
}
