/**
 * Permissions tab: the consent gate (Guard switch, one row per capability, PIN, receipts), then the older write-access controls that fold in
 * here (app features, Command Center, folders, the Codex sandbox) and plugins. Spec: SPEC-consent-gate.md, "UI".
 *
 * Reads GET /api/consent and /api/consent/receipts; writes POST /api/consent/mode|grant|off|revoke|pin|pin/verify. Open tabs hear
 * `consent_changed` over the socket (chat store `consentTick`) and reload. Every colour is a settings token.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Btn, Eyebrow, Group, ToggleRow } from './primitives';
import { useChatStore } from '../../store/chat';
import { AccessBlock } from './AccessBlock';
import { PluginsSection } from './PluginsSection';
import {
  OUTCOME_FILTERS, WINDOW_CHOICES, guardSentence, pinNeeded, receiptsQuery, rowLabel, selectedButton, turnOnAction, windowMinutes,
  type CapabilityRow, type ChangeAction, type ConsentSnapshot,
} from './permissionsState';

export interface Receipt {
  id: number;
  ts: string;
  capability: string;
  grant_id: string | null;
  harness: string;
  thread_id: string | null;
  tool_or_route: string;
  summary: string;
  outcome: string;
  count: number;
}

interface PinPrompt {
  action: ChangeAction;
  title: string;
}

async function call(base: string, path: string, method: 'GET' | 'POST', body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(`${base}/api/consent${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, data: { message: 'Could not reach the server.' } };
  }
}

const shortWhen = (ts: string) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export interface PermissionsInitial { snap?: ConsentSnapshot; receipts?: Receipt[]; openRow?: string }

export function PermissionsSection({ base, openThread, initial }: { base: string; openThread?: (threadId: string) => void; initial?: PermissionsInitial }) {
  const [snap, setSnap] = useState<ConsentSnapshot | null>(initial?.snap ?? null);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(initial?.openRow ?? null); // the row whose window and note are showing
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState<PinPrompt | null>(null);
  const [pin, setPin] = useState('');
  const [promptError, setPromptError] = useState('');
  const [pinFormOpen, setPinFormOpen] = useState(false);
  const [pinForm, setPinForm] = useState({ password: '', pin: '' });
  const [pinFormMsg, setPinFormMsg] = useState('');
  const afterPinSet = useRef<ChangeAction | null>(null);
  const consentTick = useChatStore(s => s.consentTick);

  const load = useCallback(async () => {
    const r = await call(base, '', 'GET');
    if (r.ok && r.data && Array.isArray(r.data.capabilities)) { setSnap(r.data as ConsentSnapshot); setLoadError(''); }
    else setLoadError(r.status === 401 ? 'Sign in again to see permissions.' : 'Permissions could not be read.');
  }, [base]);

  useEffect(() => { void load(); }, [load, consentTick]);

  // ── receipts ──
  const [filter, setFilter] = useState({ capability: '', outcome: '' });
  const [receipts, setReceipts] = useState<Receipt[]>(initial?.receipts ?? []);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [receiptsError, setReceiptsError] = useState('');
  const loadReceipts = useCallback(async (more: boolean, before: number | null) => {
    const r = await call(base, `/receipts?${receiptsQuery({ ...filter, before: more ? before : null })}`, 'GET');
    if (!r.ok) { setReceiptsError('Receipts could not be read.'); return; }
    setReceiptsError('');
    const page = (r.data.receipts ?? []) as Receipt[];
    setReceipts(prev => (more ? [...prev, ...page] : page));
    setNextBefore(r.data.next_before ?? null);
  }, [base, filter]);
  useEffect(() => { void loadReceipts(false, null); }, [loadReceipts, consentTick]);

  // ── making a change ──
  const run = useCallback(async (action: ChangeAction, token?: string): Promise<boolean> => {
    if (!snap) return false;
    setBusy(true);
    setMessage('');
    let r: { ok: boolean; status: number; data: any };
    const note = (cap: string) => (notes[cap] ?? '').trim() || undefined;
    switch (action.kind) {
      case 'mode': r = await call(base, '/mode', 'POST', { mode: action.to, pin_token: token }); break;
      case 'grant': r = await call(base, '/grant', 'POST', { capability: action.capability, window_minutes: action.windowMinutes, note: note(action.capability), pin_token: token }); break;
      case 'revoke': {
        const row = snap.capabilities.find(c => c.capability === action.capability);
        r = await call(base, '/revoke', 'POST', { grant_id: row?.grant_id, pin_token: token });
        break;
      }
      case 'off': r = await call(base, '/off', 'POST', { capability: action.capability, note: note(action.capability) }); break;
      case 'all_off': {
        r = { ok: true, status: 200, data: {} };
        for (const c of snap.capabilities.filter(x => x.allow)) {
          const one = await call(base, '/off', 'POST', { capability: c.capability });
          if (!one.ok) { r = one; break; }
        }
        break;
      }
    }
    setBusy(false);
    if (r.status === 403 && r.data?.error === 'pin_required') {
      setPrompt({ action, title: 'This change needs your PIN.' });
      return false;
    }
    if (!r.ok) { setMessage(r.data?.message ?? r.data?.error ?? 'That did not go through.'); return false; }
    setPrompt(null);
    setPin('');
    await load();
    await loadReceipts(false, null);
    return true;
  }, [base, snap, notes, load, loadReceipts]);

  const request = useCallback((action: ChangeAction, title: string) => {
    if (!snap) return;
    const need = pinNeeded(snap, action);
    if (need === 'none') { void run(action); return; }
    if (need === 'set_pin_first') {
      afterPinSet.current = action;
      setPinFormOpen(true);
      setPinFormMsg('Guard needs a PIN. Set one here with your app password, then switch Guard on.');
      return;
    }
    setPromptError('');
    setPin('');
    setPrompt({ action, title });
  }, [snap, run]);

  const confirmPin = async () => {
    if (!prompt) return;
    setBusy(true);
    const v = await call(base, '/pin/verify', 'POST', { pin });
    setBusy(false);
    if (!v.ok) {
      setPromptError(
        v.data?.error === 'locked' ? 'Too many wrong PINs. Try again later, or reset it with your app password below.'
        : v.data?.error === 'wrong_pin' ? `That is not the PIN${typeof v.data.attempts_left === 'number' ? ` (${v.data.attempts_left} left)` : ''}.`
        : v.data?.message ?? 'The PIN could not be checked.',
      );
      return;
    }
    const ok = await run(prompt.action, v.data.token);
    if (!ok) setPin('');
  };

  const savePin = async (clear: boolean) => {
    setBusy(true);
    const r = await call(base, '/pin', 'POST', clear ? { password: pinForm.password, clear: true } : { password: pinForm.password, pin: pinForm.pin });
    setBusy(false);
    if (!r.ok) { setPinFormMsg(r.data?.message ?? 'The PIN was not saved.'); return; }
    setPinForm({ password: '', pin: '' });
    setPinFormMsg(clear ? 'PIN removed.' : 'PIN saved.');
    await load();
    const pending = afterPinSet.current;
    afterPinSet.current = null;
    if (!clear && pending) { setPinFormOpen(false); setPromptError(''); setPin(''); setPrompt({ action: pending, title: 'Enter the PIN you just set to switch Guard on.' }); }
  };

  if (!snap) {
    return <div className="pm-section"><style>{PM_CSS}</style><span className="sp-empty-text">{loadError || 'Loading permissions…'}</span></div>;
  }

  const guard = snap.mode === 'guard';
  const anyAllowed = snap.capabilities.some(c => c.allow);
  const locked = snap.locked_until && Date.parse(snap.locked_until) > Date.now();

  return (
    <div className="pm-section">
      <style>{PM_CSS}</style>

      <Eyebrow label="guard" sub={guard ? 'on' : 'off'} />
      <Group>
        <ToggleRow
          label="Guard mode"
          checked={guard}
          onChange={v => request({ kind: 'mode', to: v ? 'guard' : 'open' }, v ? 'Enter your PIN to switch Guard on.' : 'Enter your PIN to switch Guard off.')}
          disabled={busy}
          hint={guardSentence(snap.mode, snap.pin_set)}
        />
      </Group>

      {prompt && (
        <div className="pm-prompt" role="group" aria-label="PIN">
          <label className="pm-prompt-label" htmlFor="pm-pin">{prompt.title}</label>
          <div className="pm-prompt-row">
            <input
              id="pm-pin"
              className="sp-form-input mono pm-pin-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              value={pin}
              maxLength={8}
              onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
              onKeyDown={e => { if (e.key === 'Enter' && pin.length >= 4) void confirmPin(); }}
              aria-label="PIN"
            />
            <Btn variant="primary" onClick={() => void confirmPin()} disabled={busy || pin.length < 4}>Confirm</Btn>
            <Btn variant="muted" onClick={() => { setPrompt(null); setPin(''); }}>Cancel</Btn>
          </div>
          {promptError && <p className="pm-error" role="alert">{promptError}</p>}
        </div>
      )}

      <Eyebrow label="capabilities" sub={guard ? 'default-deny' : 'all on until you change one'} />
      <div className="pm-rows" role="list">
        {snap.capabilities.map(row => (
          <CapabilityRowView
            key={row.capability}
            row={row}
            expanded={open === row.capability}
            note={notes[row.capability] ?? ''}
            busy={busy}
            onToggleOpen={() => setOpen(o => (o === row.capability ? null : row.capability))}
            onNote={v => setNotes(n => ({ ...n, [row.capability]: v }))}
            onOn={() => request(turnOnAction(snap, row), `Enter your PIN to turn on ${row.label.toLowerCase()}.`)}
            onOff={() => request({ kind: 'off', capability: row.capability }, '')}
            onWindow={(minutes) => request({ kind: 'grant', capability: row.capability, windowMinutes: minutes }, `Enter your PIN to grant ${row.label.toLowerCase()}.`)}
          />
        ))}
      </div>

      <div className="pm-actions">
        <Btn variant="danger" onClick={() => request({ kind: 'all_off' }, '')} disabled={busy || !anyAllowed}>Turn everything off</Btn>
        <span className="pm-actions-hint">No PIN needed to turn things off.</span>
      </div>
      {message && <p className="pm-error" role="alert">{message}</p>}
      <p className="pm-note">
        If your companion runs on a local model, these switches still hold, because the gate is code. What the model decides to try is
        its own judgment, and supervising that is yours.
      </p>

      <Eyebrow label="pin" sub={snap.pin_set ? 'set' : 'not set'} />
      <Group>
        <div className="pm-pin-block">
          <p className="pm-note">
            {snap.pin_set
              ? 'The PIN is separate from your app password. Guard, grants in Guard, and turning back on what you turned off ask for it.'
              : 'Optional while Guard is off. Set one to be asked before something you turned off is turned back on, and to use Guard.'}
            {locked ? ' It is locked after too many wrong tries; setting it again with your app password unlocks it.' : ''}
          </p>
          <Btn variant="muted" onClick={() => { setPinFormOpen(o => !o); setPinFormMsg(''); }}>{snap.pin_set ? 'Change or remove PIN' : 'Set a PIN'}</Btn>
          {pinFormOpen && (
            <div className="pm-pin-form">
              <label className="sp-form-label" htmlFor="pm-app-password">App password</label>
              <input id="pm-app-password" className="sp-form-input" type="password" autoComplete="current-password" value={pinForm.password} onChange={e => setPinForm(f => ({ ...f, password: e.target.value }))} />
              <label className="sp-form-label" htmlFor="pm-new-pin">New PIN (4 to 8 digits)</label>
              <input id="pm-new-pin" className="sp-form-input mono" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pinForm.pin} onChange={e => setPinForm(f => ({ ...f, pin: e.target.value.replace(/\D/g, '') }))} />
              <div className="pm-prompt-row">
                <Btn variant="primary" onClick={() => void savePin(false)} disabled={busy || !pinForm.password || pinForm.pin.length < 4}>Save PIN</Btn>
                {snap.pin_set && <Btn variant="danger" onClick={() => void savePin(true)} disabled={busy || !pinForm.password || guard}>Remove PIN</Btn>}
              </div>
              {guard && snap.pin_set && <span className="pm-note">Switch Guard off before removing the PIN.</span>}
            </div>
          )}
          {pinFormMsg && <p className="pm-note" role="status">{pinFormMsg}</p>}
        </div>
      </Group>

      <Eyebrow label="receipts" sub="newest first, kept 90 days" />
      <div className="pm-filters">
        <label className="pm-filter">
          <span className="sp-form-label">Capability</span>
          <select className="sp-form-input" value={filter.capability} onChange={e => setFilter(f => ({ ...f, capability: e.target.value }))} aria-label="Filter by capability">
            <option value="">All</option>
            {snap.capabilities.map(c => <option key={c.capability} value={c.capability}>{c.capability}</option>)}
          </select>
        </label>
        <label className="pm-filter">
          <span className="sp-form-label">Outcome</span>
          <select className="sp-form-input" value={filter.outcome} onChange={e => setFilter(f => ({ ...f, outcome: e.target.value }))} aria-label="Filter by outcome">
            <option value="">All</option>
            {OUTCOME_FILTERS.map(o => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}
          </select>
        </label>
      </div>
      {receiptsError && <p className="pm-error" role="alert">{receiptsError}</p>}
      {receipts.length === 0 && !receiptsError ? (
        <p className="pm-note">Nothing yet. Every use of a capability, allowed or refused, and every change you make, lands here.</p>
      ) : (
        <ul className="pm-receipts">
          {receipts.map(r => (
            <li key={r.id} className="pm-receipt">
              <div className="pm-receipt-head">
                <span className="pm-receipt-when">{shortWhen(r.ts)}</span>
                <span className="pm-receipt-cap">{r.capability}</span>
                <span className={`pm-outcome ${r.outcome}`}>{r.outcome.replace('_', ' ')}{r.count > 1 ? ` ×${r.count}` : ''}</span>
              </div>
              <div className="pm-receipt-body">{r.summary || r.tool_or_route}</div>
              <div className="pm-receipt-meta">
                <span>{r.harness}</span>
                {r.tool_or_route && r.tool_or_route !== r.summary && <span>{r.tool_or_route}</span>}
                {r.thread_id && openThread && (
                  <button type="button" className="pm-link" onClick={() => openThread(r.thread_id!)}>open the thread</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {nextBefore !== null && (
        <div className="pm-actions"><Btn variant="muted" onClick={() => void loadReceipts(true, nextBefore)}>Older receipts</Btn></div>
      )}

      <AccessBlock base={base} />
      <PluginsSection base={base} />
    </div>
  );
}

function CapabilityRowView({ row, expanded, note, busy, onToggleOpen, onNote, onOn, onOff, onWindow }: {
  row: CapabilityRow;
  expanded: boolean;
  note: string;
  busy: boolean;
  onToggleOpen: () => void;
  onNote: (v: string) => void;
  onOn: () => void;
  onOff: () => void;
  onWindow: (minutes: number | null) => void;
}) {
  const sel = selectedButton(row);
  const label = rowLabel(row);
  return (
    <div className="pm-row" role="listitem" data-state={row.state} data-capability={row.capability}>
      <div className="pm-row-head">
        <div className="pm-row-text">
          <span className="pm-row-label">{row.label}</span>
          <span className={`pm-row-state ${row.allow ? 'is-on' : 'is-off'}`}>{label}</span>
          {row.note && <span className="pm-row-note">{row.note}</span>}
        </div>
        <div className="pm-seg" role="group" aria-label={`${row.label}: state`}>
          <button type="button" className={`pm-seg-btn${sel === 'on' ? ' sel' : ''}`} aria-pressed={sel === 'on'} disabled={busy} onClick={onOn}>On</button>
          <button type="button" className={`pm-seg-btn${sel === 'window' || expanded ? ' sel' : ''}`} aria-pressed={sel === 'window'} aria-expanded={expanded} onClick={onToggleOpen}>Window</button>
          <button type="button" className={`pm-seg-btn${sel === 'off' ? ' sel' : ''}`} aria-pressed={sel === 'off'} disabled={busy} onClick={onOff}>Off</button>
        </div>
      </div>
      {expanded && (
        <div className="pm-row-more">
          <div className="pm-chips" role="group" aria-label={`${row.label}: window`}>
            {WINDOW_CHOICES.map(w => (
              <button key={w.id} type="button" className="pm-chip" disabled={busy} onClick={() => onWindow(windowMinutes(w.id))}>{w.label}</button>
            ))}
          </div>
          <label className="pm-note-field">
            <span className="sp-form-label">Note (kept with the receipt)</span>
            <input className="sp-form-input" type="text" maxLength={200} value={note} onChange={e => onNote(e.target.value)} placeholder="why, if you want to remember" />
          </label>
        </div>
      )}
    </div>
  );
}

const PM_CSS = `
.pm-section { padding-bottom: 2rem; }
.pm-rows { display: flex; flex-direction: column; border-top: 1px solid var(--settings-hairline, var(--border)); }
.pm-row { padding: 0.625rem 0; border-bottom: 1px solid var(--settings-hairline, var(--border)); }
.pm-row-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
.pm-row-text { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; flex: 1 1 12rem; }
.pm-row-label { font-size: 0.9375rem; color: var(--text-primary); overflow-wrap: anywhere; }
.pm-row-state { font-size: 0.8125rem; font-weight: 600; }
.pm-row-state.is-on { color: var(--status-success-text); }
.pm-row-state.is-off { color: var(--status-error-text); }
.pm-row-note { font-size: 0.75rem; color: var(--text-muted); font-style: italic; overflow-wrap: anywhere; }
.pm-seg { display: inline-flex; border: 1px solid var(--settings-field-border); border-radius: 0.5rem; overflow: hidden; flex-shrink: 0; }
.pm-seg-btn {
  min-height: 40px; min-width: 3.5rem; padding: 0 0.75rem; cursor: pointer;
  background: var(--settings-field-bg); color: var(--settings-field-text);
  border: 0; border-right: 1px solid var(--settings-field-border); font-size: 0.8125rem;
}
.pm-seg-btn:last-child { border-right: 0; }
.pm-seg-btn.sel { background: var(--toggle-on-bg); color: var(--toggle-on-thumb); font-weight: 600; }
.pm-seg-btn:disabled { cursor: not-allowed; opacity: 0.6; }
.pm-seg-btn:focus-visible, .pm-chip:focus-visible, .pm-link:focus-visible { outline: 2px solid var(--field-border-focus, var(--amber)); outline-offset: 1px; }
.pm-row-more { display: flex; flex-direction: column; gap: 0.625rem; padding-top: 0.625rem; }
.pm-chips { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.pm-chip {
  min-height: 40px; padding: 0 0.875rem; cursor: pointer; border-radius: 0.5rem; font-size: 0.8125rem;
  background: var(--settings-field-bg); color: var(--settings-field-text); border: 1px solid var(--settings-field-border);
}
.pm-chip:hover:not(:disabled) { border-color: var(--field-border-focus, var(--amber)); }
.pm-chip:disabled { cursor: not-allowed; opacity: 0.6; }
.pm-note-field { display: flex; flex-direction: column; gap: 0.25rem; }
.pm-prompt {
  display: flex; flex-direction: column; gap: 0.5rem; margin: 0.5rem 0 0.25rem; padding: 0.75rem 0.875rem;
  border: 1px solid var(--settings-field-border); border-radius: 0.625rem; background: var(--bg-hover);
}
.pm-prompt-label { font-size: 0.875rem; color: var(--text-primary); }
.pm-prompt-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.pm-pin-input { max-width: 9rem; letter-spacing: 0.25em; }
.pm-error { font-size: 0.8125rem; color: var(--status-error-text); margin: 0.375rem 0 0; line-height: 1.45; }
.pm-note { font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.55; margin: 0.5rem 0; }
.pm-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75rem; margin: 1rem 0 0.25rem; }
.pm-actions-hint { font-size: 0.75rem; color: var(--text-muted); }
.pm-pin-block { display: flex; flex-direction: column; align-items: flex-start; gap: 0.5rem; padding: 0.5rem 0; }
.pm-pin-form { display: flex; flex-direction: column; gap: 0.5rem; width: 100%; max-width: 22rem; }
.pm-filters { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 0.5rem; }
.pm-filter { display: flex; flex-direction: column; gap: 0.25rem; flex: 1 1 10rem; min-width: 0; }
.pm-receipts { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--settings-hairline, var(--border)); }
.pm-receipt { padding: 0.625rem 0; border-bottom: 1px solid var(--settings-hairline, var(--border)); display: flex; flex-direction: column; gap: 0.25rem; }
.pm-receipt-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.75rem; }
.pm-receipt-when { font-size: 0.75rem; color: var(--text-muted); }
.pm-receipt-cap { font-family: var(--font-mono, monospace); font-size: 0.8125rem; color: var(--text-primary); }
.pm-outcome { font-size: 0.75rem; font-weight: 600; margin-left: auto; color: var(--text-secondary); }
.pm-outcome.allowed, .pm-outcome.granted { color: var(--status-success-text); }
.pm-outcome.denied, .pm-outcome.error, .pm-outcome.expired { color: var(--status-error-text); }
.pm-outcome.revoked, .pm-outcome.mode_changed { color: var(--status-warning-text); }
.pm-receipt-body { font-size: 0.8125rem; color: var(--text-primary); overflow-wrap: anywhere; }
.pm-receipt-meta { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; font-size: 0.75rem; color: var(--text-muted); overflow-wrap: anywhere; align-items: center; }
.pm-link { background: none; border: 0; padding: 0; min-height: 40px; display: inline-flex; align-items: center; font: inherit; color: var(--amber); text-decoration: underline; cursor: pointer; }
@media (max-width: 600px) {
  .pm-seg { width: 100%; }
  .pm-seg-btn { flex: 1; }
  .pm-pin-input { max-width: 100%; flex: 1 1 8rem; }
}
@media (min-width: 769px) {
  .settings-view .pm-row-state, .settings-view .pm-note, .settings-view .pm-error { font-size: 14px; }
  .settings-view .pm-row-label { font-size: 16px; }
  .settings-view .pm-receipt-body, .settings-view .pm-seg-btn, .settings-view .pm-chip { font-size: 14px; }
  .settings-view .pm-receipt-when, .settings-view .pm-receipt-meta, .settings-view .pm-outcome, .settings-view .pm-row-note, .settings-view .pm-actions-hint { font-size: 13px; }
}
`;
