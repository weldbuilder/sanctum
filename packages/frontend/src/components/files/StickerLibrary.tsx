/**
 * StickerLibrary: the "Stickers" chip of the Files page. It sits in the Files plate (`fl-plate`) and uses Files' own
 * controls and tiles (`fl-btn`, `fl-input`, `fl-grid`, `fl-cell`, `fl-thumb`); nothing here sets a colour. Errors and
 * confirmations go to Files' own notice (`fl-notice`) through `onNotice`.
 *
 * StickerGrid is the pure view (props in, markup out) so it can be rendered on the server in a test;
 * StickerLibrary holds the state: GET /api/stickers, POST /api/stickers (name + file), DELETE /api/stickers/:id,
 * and "Send to chat" through the existing POST /api/files/:id/share-to-chat (a user message carrying the picture).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BASE } from '../../lib/base';
import { useConfirm } from '../ConfirmDialog';
import { NO_CHAT_TITLE, shareError } from './imageGen';
import { STICKER_NAME_MAX, readStickers, stickerDraftProblem, stickerError, type StickerItem } from './stickers';

export interface StickerGridProps {
  state: 'loading' | 'ready' | 'error';
  stickers: StickerItem[];
  query: string;
  canSend: boolean;
  /** Draft form */
  name: string;
  fileName: string;
  busy: boolean;
  onName: (v: string) => void;
  onPick: () => void;
  onAdd: () => void;
  onSend: (s: StickerItem) => void;
  onDelete: (s: StickerItem) => void;
}

export function StickerGrid(p: StickerGridProps) {
  const q = p.query.trim().toLowerCase();
  const shown = q ? p.stickers.filter(s => s.name.toLowerCase().includes(q)) : p.stickers;
  return (
    <div className="fl-stk">
      <form className="fl-stk-form" onSubmit={e => { e.preventDefault(); p.onAdd(); }}>
        <input
          className="fl-input fl-stk-name"
          value={p.name}
          maxLength={STICKER_NAME_MAX}
          placeholder="Name, e.g. wave"
          aria-label="Sticker name"
          onChange={e => p.onName(e.target.value)}
        />
        <button type="button" className="fl-btn hearth-press" onClick={p.onPick}>{p.fileName || 'Choose picture'}</button>
        <button type="submit" className="fl-btn fl-btn-primary hearth-press" disabled={p.busy}>Add sticker</button>
      </form>
      {p.state === 'loading' ? <p className="fl-quiet-in">Opening…</p>
        : p.state === 'error' ? <p className="fl-quiet-in">Could not load the stickers.</p>
        : shown.length === 0 ? <p className="fl-quiet-in">{q ? `No sticker matches “${p.query.trim()}”.` : 'No stickers yet. Name a picture and add it; your companion can then send it with its name.'}</p>
        : (
          <ul className="fl-grid fl-stk-grid">
            {shown.map(s => (
              <li key={s.id} className="fl-cell fl-stk-cell">
                <span className="fl-thumb"><img src={s.url} alt={s.name} loading="lazy" decoding="async" /></span>
                <span className="fl-tile-foot">
                  <span className="fl-tile-text"><span className="fl-tile-name" title={s.name}>{s.name}</span></span>
                </span>
                <span className="fl-stk-actions">
                  <button type="button" className="fl-btn hearth-press" disabled={!p.canSend} title={p.canSend ? undefined : NO_CHAT_TITLE} onClick={() => p.onSend(s)}>Send to chat</button>
                  <button type="button" className="fl-btn fl-danger hearth-press" aria-label={`Delete ${s.name}`} onClick={() => p.onDelete(s)}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      <style>{`
        .fl-stk-form { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin-top: 0.9rem; }
        .fl-stk-name { flex: 1 1 11rem; min-width: 0; min-height: 2.5rem; box-sizing: border-box; }
        .fl-stk-form .fl-btn { min-height: 2.5rem; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fl-stk-form .fl-btn:disabled { opacity: 0.55; cursor: default; }
        .fl-stk-cell .fl-thumb img { width: auto; height: auto; max-width: 100%; max-height: 5.5rem; object-fit: contain; }
        .fl-stk-actions { display: flex; gap: 0.4rem; padding: 0 0.7rem 0.7rem; }
        .fl-stk-actions .fl-btn { flex: 1; min-height: 2.5rem; justify-content: center; padding-inline: 0.5rem; }
        .fl-stk-actions .fl-danger { color: var(--status-error-text, #e08a7a); }
        .fl-stk-actions .fl-btn:disabled { opacity: 0.55; cursor: default; }
        @media (max-width: 768px) {
          .fl-stk-form .fl-btn { flex: 1 1 8rem; }
          .fl-stk-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .fl-stk-actions { flex-direction: column; }
        }
      `}</style>
    </div>
  );
}

export function StickerLibrary({ query, threadId, onNotice }: {
  query: string;
  threadId: string | null;
  onNotice: (text: string, error: boolean) => void;
}) {
  const confirm = useConfirm();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [stickers, setStickers] = useState<StickerItem[]>([]);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    fetch(`${BASE}/api/stickers`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (live) { setStickers(readStickers(d).map(s => ({ ...s, url: s.url || `${BASE}/api/files/${encodeURIComponent(s.fileId)}` }))); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [tick]);

  const add = useCallback(async () => {
    const problem = stickerDraftProblem(name, file);
    if (problem || !file) { onNotice(problem ?? 'Choose a picture', true); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('name', name.trim());
      fd.append('file', file);
      const r = await fetch(`${BASE}/api/stickers`, { method: 'POST', body: fd });
      if (!r.ok) { onNotice(stickerError(r.status, await r.json().catch(() => null)), true); return; }
      onNotice(`Added the ${name.trim()} sticker`, false);
      setName(''); setFile(null);
      setTick(t => t + 1);
    } catch {
      onNotice('Could not reach the file service.', true);
    } finally { setBusy(false); }
  }, [name, file, onNotice]);

  const send = useCallback(async (s: StickerItem) => {
    if (!threadId) { onNotice(NO_CHAT_TITLE, true); return; }
    try {
      const r = await fetch(`${BASE}/api/files/${encodeURIComponent(s.fileId)}/share-to-chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thread_id: threadId }),
      });
      if (r.ok) { onNotice(`Sent ${s.name} to chat`, false); return; }
      onNotice(shareError(r.status, await r.json().catch(() => null)), true);
    } catch { onNotice('Could not reach the file service.', true); }
  }, [threadId, onNotice]);

  const del = useCallback(async (s: StickerItem) => {
    const ok = await confirm({ title: `Delete ${s.name}?`, body: 'The sticker and its picture are removed. This cannot be undone.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    try {
      const r = await fetch(`${BASE}/api/stickers/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      if (!r.ok) { onNotice(`Could not delete ${s.name} (${r.status})`, true); return; }
      onNotice(`Deleted ${s.name}`, false);
      setTick(t => t + 1);
    } catch { onNotice('Could not reach the file service.', true); }
  }, [confirm, onNotice]);

  return (
    <>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
        onChange={e => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      <StickerGrid
        state={state} stickers={stickers} query={query} canSend={!!threadId}
        name={name} fileName={file?.name ?? ''} busy={busy}
        onName={setName} onPick={() => input.current?.click()} onAdd={() => void add()}
        onSend={s => void send(s)} onDelete={s => void del(s)}
      />
    </>
  );
}
