import React, { useEffect, useRef, useState } from 'react';
import { CDLG_CSS } from './ConfirmDialog';
import { barModel, dialogBody, useUpdateStore, type BarModel, type UpdateSnapshot } from '../store/update';

// ─── The notice bar: drops down at the top of Home and Chat ─────────────────────────
// "Sanctum X.Y is out. Update and restart", one button, a dismiss for this session. While a job runs the same bar shows its state and last log
// line. It wears the update pill's surface (the class `update-pill`, which the skins already paint: border, focus ring, readability edge) and
// the chrome tokens; it brings no colour of its own.

export function UpdateBarView({ model, onUpdate, onDismiss }: { model: BarModel; onUpdate: () => void; onDismiss: () => void }) {
  if (model.phase === 'hidden') return null;
  const busy = model.phase === 'progress';
  return (
    <div className={`update-pill update-bar update-bar-${model.phase}`} role="status" aria-live="polite" data-phase={model.phase}>
      <div className="update-bar-body">
        <span className="update-bar-text">{model.text}</span>
        {model.detail && <span className="update-bar-detail">{model.detail}</span>}
      </div>
      {model.phase === 'offer' && <button type="button" className="update-bar-btn" onClick={onUpdate}>Update and restart</button>}
      {busy && <span className="update-bar-spin" aria-hidden="true" />}
      {model.dismissible && <button type="button" className="update-pill-x" aria-label="Dismiss update notice" onClick={onDismiss}>×</button>}
      <style>{BAR_CSS}</style>
    </div>
  );
}

/** Mounted once in the shell, only on Home and Chat. */
export function UpdateBar() {
  const snapshot = useUpdateStore(s => s.snapshot);
  const dismissedFor = useUpdateStore(s => s.dismissedFor);
  const waiting = useUpdateStore(s => s.waiting);
  const openDialog = useUpdateStore(s => s.openDialog);
  const dismiss = useUpdateStore(s => s.dismiss);
  return <UpdateBarView model={barModel(snapshot, dismissedFor, waiting)} onUpdate={() => openDialog('update')} onDismiss={dismiss} />;
}

// ─── The password dialog: says what happens, asks for the password again ──────────────

export function UpdateDialogView({ kind, snapshot, busy, error, onSubmit, onCancel }: {
  kind: 'update' | 'rollback'; snapshot: UpdateSnapshot | null; busy: boolean; error: string | null;
  onSubmit: (password: string) => void; onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const title = kind === 'update' ? `Update to Sanctum ${snapshot?.latest ?? ''}`.trim() : `Roll back to ${snapshot?.rollback.version ?? 'the previous version'}`;
  return (
    <div
      className="cdlg-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upd-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); onCancel(); } }}
    >
      <form className="cdlg-panel" onSubmit={(e) => { e.preventDefault(); if (password && !busy) onSubmit(password); }}>
        <p id="upd-title" className="cdlg-title">{title}</p>
        <p className="cdlg-body">{dialogBody(kind, snapshot)}</p>
        <label className="upd-label" htmlFor="upd-password">Password</label>
        <input
          id="upd-password" ref={input} className="upd-input" type="password" autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
        />
        {error && <p className="upd-error" role="alert">{error}</p>}
        <div className="cdlg-actions">
          <button type="button" className="cdlg-btn cdlg-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="cdlg-btn cdlg-amber" disabled={!password || busy}>{busy ? 'Starting…' : kind === 'update' ? 'Update and restart' : 'Roll back and restart'}</button>
        </div>
      </form>
      <style>{CDLG_CSS}{DIALOG_CSS}</style>
    </div>
  );
}

/** Mounted once in the shell: any "Update and restart" (the bar, the pill, Settings) opens it through the store. */
export function UpdateDialog() {
  const dialog = useUpdateStore(s => s.dialog);
  const snapshot = useUpdateStore(s => s.snapshot);
  const submitting = useUpdateStore(s => s.submitting);
  const formError = useUpdateStore(s => s.formError);
  const submit = useUpdateStore(s => s.submit);
  const close = useUpdateStore(s => s.closeDialog);
  if (!dialog) return null;
  return <UpdateDialogView kind={dialog} snapshot={snapshot} busy={submitting} error={formError} onSubmit={(p) => void submit(p)} onCancel={close} />;
}

const DIALOG_CSS = `
  .upd-label { display: block; margin: 0.875rem 0 0.25rem; font-size: 0.75rem; color: var(--text-secondary, var(--surface-chrome-muted, #d9cdb6)); }
  .upd-input {
    width: 100%; box-sizing: border-box; padding: 0.5rem 0.625rem; border-radius: 0.375rem;
    background: transparent; color: var(--text-primary, #e2dbd0);
    border: 1px solid var(--control-border, rgba(201, 168, 124, 0.35)); font: inherit; font-size: 0.9375rem;
  }
  .upd-error { margin: 0.5rem 0 0; font-size: 0.8125rem; color: var(--status-error-text, #dc8c78); }
`;

const BAR_CSS = `
  /* Over the pill's own rules (they position it at the bottom): this one hangs from the top edge. */
  .update-pill.update-bar {
    top: 0.75rem; bottom: auto; left: 50%;
    width: max-content; max-width: min(94vw, 40rem);
    border-radius: 0.75rem; padding: 0.625rem 0.875rem; white-space: normal; cursor: default;
    animation: update-bar-in 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .update-pill.update-bar:active { transform: translateX(-50%); }
  @media (max-width: 768px) {
    /* Under the phone's top bar (Home) and the chat header, not over them. */
    .update-pill.update-bar { top: calc(env(safe-area-inset-top, 0px) + 3.75rem); }
  }
  .update-bar-body { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
  .update-bar-text {
    font-family: var(--font-serif, 'Lora', serif); font-size: 0.875rem; line-height: 1.3;
    color: var(--surface-chrome-text, #efe4d0);
  }
  .update-bar-detail {
    font-family: ui-monospace, Menlo, monospace; font-size: 0.72rem; line-height: 1.3;
    color: var(--surface-chrome-muted, #d9cdb6); overflow-wrap: anywhere; max-height: 3.4em; overflow: hidden;
  }
  .update-bar-btn {
    flex-shrink: 0; padding: 0.4rem 0.875rem; border-radius: 4px; min-height: 36px; cursor: pointer;
    background: transparent; color: var(--surface-chrome-text, #efe4d0);
    border: 1px solid var(--chrome-control-border, rgba(201, 168, 124, 0.35));
    font-family: var(--font-serif, 'Lora', serif); font-size: 0.85rem;
  }
  .update-bar-btn:hover { background: var(--chrome-hover-wash, rgba(201, 168, 124, 0.14)); }
  .update-bar-spin {
    flex-shrink: 0; width: 0.9rem; height: 0.9rem; border-radius: 50%;
    border: 2px solid var(--chrome-control-border, rgba(201, 168, 124, 0.35));
    border-top-color: var(--surface-chrome-text, #efe4d0); animation: update-bar-turn 900ms linear infinite;
  }
  .update-bar .update-pill-x {
    display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 1.5rem; height: 1.5rem; padding: 0; border: none; border-radius: 999px;
    background: transparent; color: var(--surface-chrome-muted, #d9cdb6); font-size: 1.1rem; line-height: 1; cursor: pointer;
  }
  .update-bar .update-pill-x:hover { color: var(--surface-chrome-text, #efe4d0); background: var(--chrome-hover-wash, rgba(201, 168, 124, 0.14)); }
  @keyframes update-bar-in { from { opacity: 0; transform: translateX(-50%) translateY(-120%); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
  @keyframes update-bar-turn { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .update-pill.update-bar { animation: none; }
    .update-bar-spin { animation: none; }
  }
`;
