/**
 * CommandCenterView — the user's own CRUD surface. Home REFLECTS; this page OPERATES.
 * /command v2 (COMMAND-CRAFT-SPEC.md, Lane C): the cockpit reskin.
 *
 * Anatomy: header (ember orb + living subline) over a two-column cockpit
 * (≥900px — main: cycle / care / routines; rail: wins / countdowns).
 * Lavender = the user's panels (cycle, wins); amber = companion-held structure
 * (care, routines); gold is reserved for ovulation, the win moment, and the
 * nearest countdown ≤3d.
 *
 * REST contract (routes/cc-routes.ts — snake_case service passthrough; every
 * fetch stays tolerant of a 404/failed route so the page degrades gracefully):
 *   GET  /api/cc/config → { care_categories: [{key,label,repeatable,target?}], sections: {cycle,care,routines,wins,countdowns: boolean} }
 *   PATCH /api/cc/config {sections:{care:false}} → {ok,sections}  (off = hidden, data untouched)
 *   GET  /api/cc/overview → { care, routines: RoutineStatus[], cycle, wins, countdowns }
 *   POST /api/cc/care {category,value?,note?} → {ok,entry,count?} · DELETE /api/cc/care/:id
 *        (rows carry source: 'ui'|'mcp' — mcp rows attribute "logged · HH:MM · companion")
 *   GET  /api/cc/routines → { routines: CareRoutine[], status: RoutineStatus[] }
 *        POST {label,category,window_end,window_start?,days?} · PATCH /:id
 *        DELETE /:id (soft deactivate) · DELETE /:id?hard=true (gone for good)
 *   GET  /api/cc/cycle → {status,history,predict,settings}
 *        POST period-start/period-end {date?} (period-end honestly returns
 *        {ok:false,error:'no_open_period'}) · POST /cycle/log {date?,flow?,notes?}
 *        PATCH/DELETE /cycle/rows/:id (mis-tap repair) · PATCH /cycle/settings
 *   GET/POST/DELETE /api/cc/wins(/:id) {text,who} (slot upsert per person/day)
 *   GET/POST/PATCH/DELETE /api/cc/countdowns(/:id) {title,target_date}
 *
 * Liveness: ONE shared 60s clock (also the overview poll), visibilitychange
 * refetch, and the cc_update WS ripple ({section}) via __sanctumWsListeners.
 * Snapshot-diff rows get a one-shot hearth-pulse (lavender variant on lavender
 * panels, 5s/row throttle). Rejected on principle: skeletons, spinners,
 * tickers, per-second timers. All motion dies under prefers-reduced-motion
 * (global kill in index.css).
 */
import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HearthDatePicker, HearthTimePicker, HearthSelect, Orb } from './hearth';
import type { HearthDateMark } from './hearth';

import { BASE } from '../lib/base';
import { cronSummary } from './settings/cron';
import { cronRunsToday } from './dayTimes';
import { useIdentity } from '../store/identity';

// ─── tolerant readers ─────────────────────────────────────────────────────────
// Every shape read goes through these so a missing / renamed field degrades to
// an empty state instead of a crash.

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
/** Accepts an array directly, or an object holding an array under a common key. */
function listOf(v: unknown, keys: string[] = []): unknown[] {
  if (Array.isArray(v)) return v;
  const r = rec(v);
  if (r) {
    for (const k of [...keys, 'entries', 'items', 'list']) {
      if (Array.isArray(r[k])) return r[k] as unknown[];
    }
  }
  return [];
}
function idOf(r: Rec): string | undefined {
  if (typeof r.id === 'string') return r.id;
  if (typeof r.id === 'number') return String(r.id);
  return undefined;
}
function dateOf(r: Rec, keys: string[]): Date | null {
  for (const k of keys) {
    const s = r[k];
    if (typeof s === 'string' || typeof s === 'number') {
      const d = typeof s === 'string' ? sqliteUtcDate(s) ?? new Date(s) : new Date(s);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}
/** SQLite UTC "YYYY-MM-DD HH:MM:SS" → Date (parsed as UTC, rendered local). */
function sqliteUtcDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return null;
  const d = new Date(v.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── date/format helpers ──────────────────────────────────────────────────────

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function fmtIsoDay(iso: string): string {
  const d = parseIsoDate(iso);
  return d ? fmtDay(d) : iso;
}
function isToday(d: Date): boolean {
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
/** Local-midnight Date from "YYYY-MM-DD" (avoids UTC parsing drift). */
function parseIsoDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function addDaysIso(iso: string, n: number): string {
  const d = parseIsoDate(iso);
  if (!d) return iso;
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function daysAwayFrom(iso: string): number | undefined {
  const d = parseIsoDate(iso) ?? new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const mid = new Date();
  mid.setHours(0, 0, 0, 0);
  const tgt = new Date(d);
  tgt.setHours(0, 0, 0, 0);
  return Math.round((tgt.getTime() - mid.getTime()) / 86_400_000);
}
/** Whole days from ISO a → ISO b (b - a). */
function diffDaysIso(a: string, b: string): number | undefined {
  const da = parseIsoDate(a);
  const db = parseIsoDate(b);
  if (!da || !db) return undefined;
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}
/** "HH:MM" → minutes since midnight. */
function hmToMin(hm: string | undefined): number | undefined {
  if (!hm) return undefined;
  const m = /^(\d{1,2}):(\d{2})/.exec(hm);
  if (!m) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}
function minsLabel(mins: number): string {
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  return h > 0 ? `${h}h ${pad2(r)}m` : `${r}m`;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
/** Sends and returns the parsed body (the backend speaks honest {ok:false,error}
 *  at HTTP 200 for domain failures like period-end with no open period). */
async function apiSend(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: Rec,
): Promise<{ ok: boolean; body: Rec | null }> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let parsed: Rec | null = null;
    try { parsed = rec(await res.json()) ?? null; } catch { /* empty body */ }
    const ok = res.ok && parsed?.ok !== false;
    return { ok, body: parsed };
  } catch {
    return { ok: false, body: null };
  }
}

// ─── normalized shapes ────────────────────────────────────────────────────────

interface CareCategoryCfg { key: string; label: string; repeatable: boolean; target?: number }
interface CareItem {
  id?: string;
  category: string;
  value?: string;
  note?: string;
  source?: string;      // 'ui' | 'mcp'
  time: Date | null;
}
interface RoutineItem {
  id: string;
  label: string;
  category?: string;
  windowStart?: string;
  windowEnd?: string;
  days: string[] | 'daily';
  active: boolean;
}
type RoutineState = 'done' | 'pending' | 'missed';
interface WinItem { id?: string; text: string; who?: string; dateIso?: string; when: Date | null }
interface CountdownItem { id?: string; label: string; dateIso?: string; daysAway?: number }
interface CycleHistoryItem {
  id?: string;
  startIso?: string;
  endIso?: string;
  start: Date | null;
  end: Date | null;
  periodLength?: number;
}

// Degraded-mode only: when GET /config never answers, the chips still exist.
// The live list (order, water target) comes from the backend.
const FALLBACK_CARE_CATEGORIES: CareCategoryCfg[] = [
  { key: 'breakfast', label: 'Breakfast', repeatable: false },
  { key: 'water', label: 'Water', repeatable: true, target: 8 },
  { key: 'meds', label: 'Meds', repeatable: false },
  { key: 'shower', label: 'Shower', repeatable: false },
  { key: 'movement', label: 'Movement', repeatable: false },
  { key: 'lunch', label: 'Lunch', repeatable: false },
  { key: 'dinner', label: 'Dinner', repeatable: false },
];

function normCareCategories(v: unknown): CareCategoryCfg[] | null {
  const arr = listOf(rec(v)?.care_categories);
  const out = arr.flatMap((e): CareCategoryCfg[] => {
    const r = rec(e);
    const key = r && str(r.key);
    if (!r || !key) return [];
    return [{
      key,
      label: str(r.label) ?? key,
      repeatable: bool(r.repeatable) ?? false,
      target: num(r.target),
    }];
  });
  return out.length > 0 ? out : null;
}

function normCare(v: unknown): CareItem[] {
  return listOf(v, ['care', 'today']).flatMap((e): CareItem[] => {
    const r = rec(e);
    if (!r) return [];
    const category = str(r.category) ?? str(r.label) ?? str(r.kind);
    if (!category) return [];
    const value = str(r.value) ?? (num(r.value) !== undefined ? String(r.value) : undefined);
    return [{
      id: idOf(r),
      category,
      value,
      note: str(r.note),
      source: str(r.source),
      time: dateOf(r, ['updated_at', 'created_at', 'at', 'createdAt', 'loggedAt', 'time', 'timestamp']),
    }];
  });
}

function normRoutines(v: unknown): RoutineItem[] {
  return listOf(v, ['routines']).flatMap((e): RoutineItem[] => {
    let r = rec(e);
    if (!r) return [];
    // Overview's `routines` is RoutineStatus[] — the routine sits under `routine`.
    const inner = rec(r.routine);
    if (inner) r = inner;
    const id = idOf(r);
    const label = str(r.label) ?? str(r.name) ?? str(r.title);
    if (!id || !label) return [];
    const daysRaw = r.days;
    const days: string[] | 'daily' = daysRaw === 'daily'
      ? 'daily'
      : typeof daysRaw === 'string'
        ? daysRaw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
        : Array.isArray(daysRaw)
          ? daysRaw.filter((d): d is string => typeof d === 'string').map(d => d.toLowerCase())
          : 'daily';
    return [{
      id,
      label,
      category: str(r.category),
      windowStart: str(r.window_start) ?? str(r.windowStart),
      windowEnd: str(r.window_end) ?? str(r.windowEnd),
      days,
      active: bool(r.active) ?? (num(r.active) !== undefined ? num(r.active) !== 0 : undefined) ?? bool(r.enabled) ?? true,
    }];
  });
}

/** status is RoutineStatus[] ({routine:{id},status,completedAt?}) — with legacy array/map tolerances. */
function routineState(id: string, status: unknown): RoutineState {
  let raw: unknown;
  if (Array.isArray(status)) {
    const e = status.map(rec).find(x => x && (rec(x.routine)?.id === id || x.routineId === id || x.id === id));
    if (e) raw = e.status ?? e.state ?? (e.done === true ? 'done' : e.missed === true ? 'missed' : undefined);
  } else {
    const m = rec(status);
    if (m && id in m) {
      const e = m[id];
      raw = typeof e === 'string' ? e : rec(e)?.state ?? rec(e)?.status ?? (rec(e)?.done === true ? 'done' : undefined);
    }
  }
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (s === 'done' || s === 'complete' || s === 'completed') return 'done';
  if (s === 'missed') return 'missed';
  return 'pending';
}
function routineCompletedAt(id: string, status: unknown): Date | null {
  if (!Array.isArray(status)) return null;
  const e = status.map(rec).find(x => x && rec(x.routine)?.id === id);
  if (!e) return null;
  return dateOf(e, ['completedAt', 'completed_at']);
}

function normWins(v: unknown): WinItem[] {
  return listOf(v, ['wins']).flatMap((e): WinItem[] => {
    if (typeof e === 'string') return [{ text: e, when: null }];
    const r = rec(e);
    if (!r) return [];
    const text = str(r.text) ?? str(r.win) ?? str(r.label) ?? str(r.title);
    if (!text) return [];
    return [{
      id: idOf(r),
      text,
      who: str(r.who)?.toLowerCase(),
      dateIso: str(r.date),
      when: dateOf(r, ['date', 'createdAt', 'created_at', 'at']),
    }];
  });
}

function normCountdowns(v: unknown): CountdownItem[] {
  return listOf(v, ['countdowns']).flatMap((e): CountdownItem[] => {
    const r = rec(e);
    if (!r) return [];
    const label = str(r.title) ?? str(r.label);
    if (!label) return [];
    const dateIso = str(r.target_date) ?? str(r.date) ?? str(r.when) ?? str(r.at);
    const daysAway = num(r.days_until) ?? num(r.daysAway) ?? (dateIso ? daysAwayFrom(dateIso) : undefined);
    return [{ id: idOf(r), label, dateIso, daysAway }];
  });
}

function normHistory(v: unknown): CycleHistoryItem[] {
  return listOf(v, ['history', 'cycles']).flatMap((e): CycleHistoryItem[] => {
    const r = rec(e);
    if (!r) return [];
    const startIso = str(r.start_date) ?? str(r.start) ?? str(r.startDate) ?? str(r.date);
    const endIso = str(r.end_date) ?? str(r.end) ?? str(r.endDate);
    const start = startIso ? parseIsoDate(startIso) : dateOf(r, ['periodStart']);
    const end = endIso ? parseIsoDate(endIso) : null;
    return [{
      id: idOf(r),
      startIso,
      endIso,
      start,
      end,
      periodLength: num(r.periodLength)
        ?? (start && end ? Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1 : undefined),
    }];
  });
}

// ─── shared 60s clock ─────────────────────────────────────────────────────────
// The ONLY repeating timer on the page. Everything time-derived (routine rings,
// "closes in", the poll) hangs off this one beat + visibilitychange.

function useMinuteClock(onTick?: () => void): number {
  const [now, setNow] = useState(() => Date.now());
  const cb = useRef(onTick);
  cb.current = onTick;
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); cb.current?.(); }, 60_000);
    const onVis = () => {
      if (!document.hidden) { setNow(Date.now()); cb.current?.(); }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  return now;
}

// ─── snapshot-diff pulse ──────────────────────────────────────────────────────
// Rows that changed since the last snapshot get a one-shot pulse timestamp.
// First snapshot seeds silently; per-row throttle 5s.

function usePulseOnChange(items: Array<{ id?: string; sig: string }>): Record<string, number> {
  const prev = useRef<Map<string, string> | null>(null);
  const last = useRef<Map<string, number>>(new Map());
  const [pulses, setPulses] = useState<Record<string, number>>({});
  const signature = items.map(i => `${i.id ?? ''}=${i.sig}`).join('|');
  useEffect(() => {
    const map = new Map<string, string>();
    for (const i of items) if (i.id) map.set(i.id, i.sig);
    if (prev.current === null) { prev.current = map; return; }
    const now = Date.now();
    const fresh: Record<string, number> = {};
    for (const [id, sig] of map) {
      if (prev.current.get(id) === sig) continue;
      const lastTs = last.current.get(id) ?? 0;
      if (now - lastTs < 5_000) continue;
      last.current.set(id, now);
      fresh[id] = now;
    }
    prev.current = map;
    if (Object.keys(fresh).length > 0) setPulses(p => ({ ...p, ...fresh }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return pulses;
}

// ─── small primitives ─────────────────────────────────────────────────────────

/** The section a panel belongs to: its title and icon, its id on the page, and the Show switch that hides it
 *  (hidden, not deleted; Manage sections brings it back). */
const PanelSection = createContext<{ key: SectionKey; hide: () => void } | null>(null);

function Panel({
  label, meta, tone, extra, children,
}: {
  label: string;
  meta?: string;
  tone?: 'lavender' | 'amber';
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const section = useContext(PanelSection);
  const title = section ? SECTION_LABELS[section.key] : label;
  return (
    <section className={`cmd-panel${tone ? ` cmd-panel-${tone}` : ''}`} id={section ? `cmd-sec-${section.key}` : undefined}>
      <div className="cmd-panel-head">
        {section && <span className="cmd-panel-icon" aria-hidden="true"><SectionIcon k={section.key} /></span>}
        <h2 className="cmd-panel-label">{title}</h2>
        {extra}
        {meta && <span className="cmd-panel-meta">{meta}</span>}
        {section && <HearthSwitch checked onChange={() => section.hide()} label="Show" ariaLabel={`Show ${title}`} />}
      </div>
      <div className="cmd-panel-body">{children}</div>
    </section>
  );
}

function QuietLine({ children }: { children: React.ReactNode }) {
  return <p className="cmd-quiet">{children}</p>;
}

/** What is folded behind a "+" until it is wanted (an add form, a day's log): the page shows the day, not its inputs. */
function Fold({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="cmd-fold">
      <button type="button" className="cmd-fold-btn hearth-press" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
        <span className="cmd-fold-mark" aria-hidden="true">{open ? '−' : '+'}</span>{label}
      </button>
      {open && <div id={id} className="cmd-fold-body">{children}</div>}
    </div>
  );
}
const foldIf = (fold: boolean | undefined, label: string, body: React.ReactNode) => (fold ? <Fold label={label}>{body}</Fold> : body);

/** Segment-stepper replacing native number spinners: − value + */
function NumStepper({
  value, min, max, unit, onCommit,
}: {
  value: number | undefined;
  min: number;
  max: number;
  unit: string;
  onCommit: (n: number) => void;
}) {
  const [pend, setPend] = useState<number | null>(null);
  const shown = pend ?? value;
  useEffect(() => {
    if (pend === null || pend === value) return;
    const t = setTimeout(() => { onCommit(pend); setPend(null); }, 900);
    return () => clearTimeout(t);
  }, [pend, value, onCommit]);
  const step = (d: number) => {
    const base = shown ?? min;
    setPend(Math.min(max, Math.max(min, base + d)));
  };
  return (
    <span className="cmd-stepper">
      <button className="cmd-stepper-btn hearth-press" type="button" aria-label="decrease" onClick={() => step(-1)}>−</button>
      <span className="cmd-stepper-val">{shown ?? '—'}</span>
      <button className="cmd-stepper-btn hearth-press" type="button" aria-label="increase" onClick={() => step(1)}>+</button>
      <span className="cmd-stepper-unit">{unit}</span>
    </span>
  );
}

/** Hearth switch — replaces the native checkbox, styled like the house. */
function HearthSwitch({
  checked, onChange, label, ariaLabel,
}: { checked: boolean; onChange: (v: boolean) => void; label: string; ariaLabel?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`cmd-switch hearth-press${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="cmd-switch-track" aria-hidden="true"><span className="cmd-switch-knob" /></span>
      <span className="cmd-switch-label">{label}</span>
    </button>
  );
}

// ─── section on/off row ──────────────────────────────────────────────────────

type SectionKey = 'automations' | 'care' | 'routines' | 'cycle' | 'wins' | 'countdowns';
const SECTION_KEYS: SectionKey[] = ['routines', 'automations', 'care', 'countdowns', 'wins', 'cycle'];
const SECTION_LABELS: Record<SectionKey, string> = {
  automations: 'Automations', care: 'Today’s care', routines: 'Today',
  cycle: 'Cycle', wins: 'Wins', countdowns: 'Coming up',
};
type SectionFlags = Record<SectionKey, boolean>;
const ALL_SECTIONS_ON: SectionFlags = { automations: true, care: true, routines: true, cycle: true, wins: true, countdowns: true };

/** GET /config → sections. Missing / malformed = on (default all on). */
function normSections(v: unknown): SectionFlags {
  const raw = rec(rec(v)?.sections);
  const out = { ...ALL_SECTIONS_ON };
  for (const k of SECTION_KEYS) if (raw?.[k] === false) out[k] = false;
  return out;
}

/** Every section's switch in one place, behind a button in the header: where a hidden section is brought back. */
function ManageSections({ sections, onToggle }: { sections: SectionFlags; onToggle: (k: SectionKey, v: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const hidden = SECTION_KEYS.filter(k => !sections[k]).length;
  return (
    <div className="cmd-manage" ref={ref}>
      <button className="cmd-manage-btn hearth-press" type="button" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="4" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
          <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
        </svg>
        Manage sections{hidden > 0 ? ` · ${hidden} hidden` : ''}
      </button>
      {open && (
        <div className="cmd-manage-pop" role="group" aria-label="Sections">
          <p className="cmd-manage-note">Hidden sections can be restored here.</p>
          {SECTION_KEYS.map(k => (
            <HearthSwitch key={k} checked={sections[k]} onChange={v => onToggle(k, v)} label={SECTION_LABELS[k]} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── icons — stroked glyphs in the house set ─────────────────────────────────

function SectionIcon({ k }: { k: SectionKey }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {k === 'automations' && <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></>}
      {k === 'care' && <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>}
      {k === 'routines' && <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>}
      {k === 'cycle' && <><path d="M12 20.5c-4.5-1.5-7-5.2-7-9.3C5 7 8 4 12 3.5c4 .5 7 3.5 7 7.7 0 4.1-2.5 7.8-7 9.3z" /><path d="M12 20.5V9M12 13.5l-3-2.5M12 11l3-2.5" /></>}
      {k === 'wins' && <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />}
      {k === 'countdowns' && <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>}
    </svg>
  );
}

/** A care category's glyph, by its key: water, meals, movement, rest, meds, washing; a plain dot for any other. */
function CareIcon({ k }: { k: string }) {
  const key = k.toLowerCase();
  const is = (...names: string[]) => names.some(n => key.includes(n));
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {is('water', 'drink', 'hydrat') ? <path d="M12 3.5c3.2 4.2 5.5 7.2 5.5 10.2a5.5 5.5 0 01-11 0c0-3 2.3-6 5.5-10.2z" />
        : is('meal', 'breakfast', 'lunch', 'dinner', 'food', 'eat', 'snack') ? <path d="M7 3v8a2 2 0 002 2v8M5 3v5.5M9 3v5.5M17 21V3c-2 1.2-3 3.6-3 6.5V13h3" />
        : is('move', 'walk', 'exercise', 'stretch', 'yoga', 'run') ? <path d="M3 12h4l2-5.5 4 11 2.5-5.5H21" />
        : is('rest', 'sleep', 'nap') ? <path d="M19.5 14.5A7.5 7.5 0 019.5 4.5a7.5 7.5 0 1010 10z" />
        : is('med', 'pill', 'vitamin') ? <><rect x="3.5" y="8.5" width="17" height="7" rx="3.5" transform="rotate(-45 12 12)" /><path d="M9.5 9.5l5 5" /></>
        : is('shower', 'bath', 'wash') ? <><path d="M8 4.5c2 2.7 3.5 4.6 3.5 6.5a3.5 3.5 0 01-7 0c0-1.9 1.5-3.8 3.5-6.5z" /><path d="M16.5 10.5c1.4 1.8 2.5 3.2 2.5 4.6a2.5 2.5 0 01-5 0c0-1.4 1.1-2.8 2.5-4.6z" /></>
        : <circle cx="12" cy="12" r="3.5" />}
    </svg>
  );
}


// ─── header — ember orb + living subline ─────────────────────────────────────

interface OrbState { color: string; blend?: string; shape?: string; motion?: string; intensity?: string }



// ─── 1 · Cycle — the hearth-band ─────────────────────────────────────────────

const FLOW_LEVELS = ['spotting', 'light', 'medium', 'heavy'] as const;

type PhaseKey = 'period' | 'follicular' | 'ovulation' | 'luteal' | 'nodata';

interface CycleModel {
  noData: boolean;
  cycleDay?: number;
  cycleLength: number;
  phase?: string;
  phaseKey: PhaseKey;
  onPeriod: boolean;
  pms: boolean;
  inFertile: boolean;
  startIso?: string;          // day 1 of the current cycle
  nextIso?: string;
  nextIn?: number;
  avgPeriod: number;
  avgCycle: number;
  fertileStartDay?: number;
  fertileEndDay?: number;
  ovulationDay?: number;
  pmsStartDay?: number;
  pmsEndDay?: number;
  completedCycles: number;
}

function buildCycleModel(cycle: Rec | null, overviewCycle: unknown, history: CycleHistoryItem[]): CycleModel {
  const statusRec = rec(cycle?.status) ?? rec(rec(overviewCycle)?.status) ?? rec(overviewCycle);
  const settings = rec(cycle?.settings) ?? rec(statusRec?.settings);
  const avgCycle = num(settings?.average_cycle_length) ?? num(settings?.avgCycleLength) ?? num(statusRec?.cycleLength) ?? 28;
  const avgPeriod = num(settings?.average_period_length) ?? num(settings?.avgPeriodLength) ?? 5;

  const cycleDay = num(statusRec?.cycleDay) ?? num(statusRec?.day);
  const phase = str(statusRec?.phase);
  const onPeriod = bool(statusRec?.onPeriod) ?? bool(statusRec?.inPeriod) ?? bool(statusRec?.bleeding) ?? false;
  const noData =
    bool(statusRec?.noData) === true ||
    str(statusRec?.state)?.toLowerCase().replace('-', '') === 'nodata' ||
    (!statusRec) ||
    (cycleDay === undefined && !phase && !onPeriod);

  const predict = rec(cycle?.predict);
  const fertile = rec(predict?.fertileWindow);
  const pmsWin = rec(predict?.pmsWindow);
  const startIso = str(statusRec?.lastPeriodStart) ?? str(statusRec?.periodStarted) ?? undefined;
  const nextIso = str(predict?.nextPeriod) ?? str(statusRec?.nextPeriodPredicted) ?? str(predict?.nextPeriodStart) ?? str(predict?.date);
  const nextIn = num(statusRec?.daysUntilPeriod)
    ?? (nextIso ? daysAwayFrom(nextIso) : num(predict?.daysUntilNextPeriod) ?? num(predict?.daysUntil));

  const pms = bool(predict?.inPMSWindow) ?? bool(statusRec?.inPMSWindow) ?? bool(statusRec?.pmsWindow) ?? bool(statusRec?.pms) ?? false;
  const inFertile = bool(predict?.inFertileWindow) ?? false;

  const dayFor = (iso: string | undefined): number | undefined => {
    if (!iso || !startIso) return undefined;
    const d = diffDaysIso(startIso, iso);
    return d === undefined ? undefined : d + 1;
  };

  let phaseKey: PhaseKey = 'nodata';
  if (!noData) {
    if (onPeriod || phase === 'menstrual') phaseKey = 'period';
    else if (phase === 'follicular') phaseKey = 'follicular';
    else if (phase === 'ovulation') phaseKey = 'ovulation';
    else phaseKey = 'luteal';
  }

  return {
    noData,
    cycleDay,
    cycleLength: num(statusRec?.cycleLength) ?? avgCycle,
    phase: phase === 'menstrual' ? 'period' : phase,
    phaseKey,
    onPeriod,
    pms,
    inFertile,
    startIso,
    nextIso,
    nextIn,
    avgPeriod,
    avgCycle,
    fertileStartDay: dayFor(str(fertile?.start)),
    fertileEndDay: dayFor(str(fertile?.end)),
    ovulationDay: dayFor(str(predict?.ovulation)),
    pmsStartDay: dayFor(str(pmsWin?.start)),
    pmsEndDay: dayFor(str(pmsWin?.end)),
    completedCycles: history.filter(h => h.end).length,
  };
}

/** The horizon strip — one cycle as a tappable dot timeline. */
function HorizonStrip({
  model, selectedDay, onSelect,
}: {
  model: CycleModel;
  selectedDay: number | null;
  onSelect: (day: number, dateIso: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const todayRef = useRef<HTMLButtonElement>(null);

  const L = Math.max(model.cycleLength, model.cycleDay ?? 0);

  // Center today on mount / data change.
  useEffect(() => {
    const strip = stripRef.current;
    const today = todayRef.current;
    if (!strip || !today) return;
    strip.scrollLeft = Math.max(0, today.offsetLeft - strip.clientWidth / 2);
  }, [model.cycleDay, L]);

  if (model.noData || !model.startIso) {
    // Ghosted strip — honest cold start.
    return (
      <div className="cmd-strip cmd-strip-ghost scrollbar-hide" aria-hidden="true">
        {Array.from({ length: 28 }, (_, i) => (
          <span key={i} className="cmd-day-ghost" />
        ))}
      </div>
    );
  }

  const startIso = model.startIso;
  const periodEndDay = model.onPeriod
    ? Math.max(model.avgPeriod, model.cycleDay ?? 1)
    : model.avgPeriod;

  const dots = Array.from({ length: L }, (_, i) => {
    const n = i + 1;
    const dateIso = addDaysIso(startIso, n - 1);
    const isTodayDot = n === model.cycleDay;
    const cls = ['cmd-day-dot'];
    if (n <= periodEndDay) cls.push('period');
    else if (model.ovulationDay === n) cls.push('ovu');
    else if (model.fertileStartDay !== undefined && model.fertileEndDay !== undefined
      && n >= model.fertileStartDay && n <= model.fertileEndDay) cls.push('fertile');
    else if (model.pmsStartDay !== undefined && n >= model.pmsStartDay
      && n <= (model.pmsEndDay ?? L)) cls.push('pms');
    if (model.cycleDay !== undefined && n < model.cycleDay) cls.push('elapsed');
    if (isTodayDot) cls.push('today');
    if (selectedDay === n) cls.push('selected');
    return (
      <button
        key={n}
        ref={isTodayDot ? todayRef : undefined}
        type="button"
        className="cmd-day"
        aria-label={`day ${n} — ${fmtIsoDay(dateIso)}`}
        title={`day ${n} · ${fmtIsoDay(dateIso)}`}
        onClick={() => onSelect(n, dateIso)}
      >
        <span className={cls.join(' ')} aria-hidden="true" />
      </button>
    );
  });

  return (
    <div className="cmd-strip scrollbar-hide" ref={stripRef}>
      {dots}
      {model.nextIso && (
        <span className="cmd-strip-next" title={`next period ~ ${fmtIsoDay(model.nextIso)}`}>
          <span className="cmd-strip-tick" aria-hidden="true" />
          <span className="cmd-strip-next-date">{fmtIsoDay(model.nextIso)}</span>
        </span>
      )}
    </div>
  );
}

/** Tap-a-day popover — period start/end on that date, flow log. Replaces date typing. */
function DayPopover({
  day, dateIso, busy, onPeriodStart, onPeriodEnd, onLog, onClose,
}: {
  day: number;
  dateIso: string;
  busy: boolean;
  onPeriodStart: (dateIso: string) => void;
  onPeriodEnd: (dateIso: string) => void;
  onLog: (dateIso: string, flow: string | null, note: string) => void;
  onClose: () => void;
}) {
  const [flow, setFlow] = useState<string | null>(null);
  const [note, setNote] = useState('');
  return (
    <div className="cmd-day-pop">
      <div className="cmd-day-pop-head">
        <span className="cmd-day-pop-date">day {day} · {fmtIsoDay(dateIso)}</span>
        <button className="cmd-x" type="button" aria-label="close" onClick={onClose}>×</button>
      </div>
      <div className="cmd-day-pop-actions">
        <button
          className="cmd-btn cmd-btn-rose hearth-press"
          type="button"
          disabled={busy}
          onClick={() => onPeriodStart(dateIso)}
        >
          period started this day
        </button>
        <button
          className="cmd-btn hearth-press"
          type="button"
          disabled={busy}
          onClick={() => onPeriodEnd(dateIso)}
        >
          period ended this day
        </button>
      </div>
      <div className="cmd-day-pop-log">
        <div className="cmd-flow-chips">
          {FLOW_LEVELS.map(f => (
            <button
              key={f}
              className={`cmd-chip hearth-press${flow === f ? ' cmd-chip-selected' : ''}`}
              onClick={() => setFlow(prev => (prev === f ? null : f))}
              type="button"
            >
              {f}
            </button>
          ))}
        </div>
        <input
          className="cmd-input cmd-day-pop-note"
          placeholder="symptoms, mood, anything…"
          value={note}
          onChange={e => setNote(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (flow || note.trim())) onLog(dateIso, flow, note.trim()); }}
        />
        <button
          className="cmd-btn cmd-btn-amber hearth-press"
          type="button"
          disabled={busy || (!flow && !note.trim())}
          onClick={() => onLog(dateIso, flow, note.trim())}
        >
          log
        </button>
      </div>
    </div>
  );
}

/** History row editor — mis-tap repair (PATCH/DELETE cycle rows) behind a confirm. */
function CycleRowEditor({
  row, marks, onDone,
}: {
  row: CycleHistoryItem;
  marks: HearthDateMark[];
  onDone: () => void;
}) {
  const [start, setStart] = useState(row.startIso ?? '');
  const [end, setEnd] = useState(row.endIso ?? '');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function save() {
    if (!row.id || busy) return;
    setBusy(true);
    const body: Rec = {};
    if (start && start !== row.startIso) body.start_date = start;
    if (end && end !== row.endIso) body.end_date = end;
    if (Object.keys(body).length > 0) {
      await apiSend(`/api/cc/cycle/rows/${row.id}`, 'PATCH', body);
    }
    setBusy(false);
    onDone();
  }
  async function del() {
    if (!row.id || busy) return;
    setBusy(true);
    await apiSend(`/api/cc/cycle/rows/${row.id}`, 'DELETE');
    setBusy(false);
    onDone();
  }

  return (
    <div className="cmd-row-editor">
      <div className="cmd-row-editor-fields">
        <label className="cmd-field">
          <span className="cmd-field-key">started</span>
          <HearthDatePicker value={start} onChange={setStart} tone="lavender" marks={marks} ariaLabel="period start date" />
        </label>
        <label className="cmd-field">
          <span className="cmd-field-key">ended</span>
          <HearthDatePicker value={end} onChange={setEnd} tone="lavender" marks={marks} placeholder="still open" ariaLabel="period end date" />
        </label>
      </div>
      <div className="cmd-row-editor-btns">
        {confirming ? (
          <span className="cmd-confirm">
            <span className="cmd-confirm-q">remove this cycle?</span>
            <button className="cmd-btn cmd-btn-danger hearth-press" type="button" disabled={busy} onClick={() => void del()}>yes, remove</button>
            <button className="cmd-btn hearth-press" type="button" onClick={() => setConfirming(false)}>keep it</button>
          </span>
        ) : (
          <>
            <button className="cmd-btn cmd-btn-danger hearth-press" type="button" disabled={busy} onClick={() => setConfirming(true)}>delete</button>
            <button className="cmd-btn hearth-press" type="button" onClick={onDone}>cancel</button>
            <button className="cmd-btn cmd-btn-amber hearth-press" type="button" disabled={busy} onClick={() => void save()}>
              {busy ? 'saving…' : 'save'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function CyclePanel({
  cycle, overviewCycle, failed, onChanged,
}: {
  cycle: Rec | null;
  overviewCycle: unknown;
  failed: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ day: number; dateIso: string } | null>(null);
  const [editingRow, setEditingRow] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const history = normHistory(cycle?.history);
  const model = buildCycleModel(cycle, overviewCycle, history);
  const settings = rec(cycle?.settings);
  const avgCycle = num(settings?.average_cycle_length);
  const avgPeriod = num(settings?.average_period_length);

  function say(msg: string) {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 6_000);
  }
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  async function periodStart(dateIso: string) {
    if (busy) return;
    setBusy(true);
    const { ok } = await apiSend('/api/cc/cycle/period-start', 'POST', { date: dateIso });
    setBusy(false);
    setSelected(null);
    if (ok) say(`period start kept — ${fmtIsoDay(dateIso)}.`);
    onChanged();
  }
  async function periodEnd(dateIso: string) {
    if (busy) return;
    setBusy(true);
    const { ok, body } = await apiSend('/api/cc/cycle/period-end', 'POST', { date: dateIso });
    setBusy(false);
    setSelected(null);
    if (!ok && str(body?.error) === 'no_open_period') {
      say('no period was open — nothing changed.');
    } else if (ok) {
      say(`period end kept — ${fmtIsoDay(dateIso)}.`);
    }
    onChanged();
  }
  async function logDay(dateIso: string, flow: string | null, note: string) {
    if (busy) return;
    setBusy(true);
    const body: Rec = { date: dateIso };
    if (flow) body.flow = flow;
    if (note) body.notes = note;
    const { ok } = await apiSend('/api/cc/cycle/log', 'POST', body);
    setBusy(false);
    setSelected(null);
    if (ok) say(`kept for ${fmtIsoDay(dateIso)}.`);
    onChanged();
  }
  const saveSettings = useCallback(async (key: 'average_cycle_length' | 'average_period_length', n: number) => {
    await apiSend('/api/cc/cycle/settings', 'PATCH', { [key]: n });
    onChanged();
  }, [onChanged]);
  const commitAvgCycle = useCallback((n: number) => { void saveSettings('average_cycle_length', n); }, [saveSettings]);
  const commitAvgPeriod = useCallback((n: number) => { void saveSettings('average_period_length', n); }, [saveSettings]);

  // Marks for the history editor's pickers — predicted period + fertile days.
  const predict = rec(cycle?.predict);
  const marks: HearthDateMark[] = useMemo(() => {
    const out: HearthDateMark[] = [];
    const next = str(predict?.nextPeriod);
    if (next) out.push({ date: next, kind: 'period' });
    const fw = rec(predict?.fertileWindow);
    const fs = str(fw?.start);
    const fe = str(fw?.end);
    if (fs && fe) {
      const span = diffDaysIso(fs, fe);
      if (span !== undefined && span >= 0 && span <= 10) {
        for (let i = 0; i <= span; i++) out.push({ date: addDaysIso(fs, i), kind: 'fertile' });
      }
    }
    return out;
  }, [predict]);

  const phaseLabel: Record<PhaseKey, string> = {
    period: 'on period',
    follicular: 'follicular — rising',
    ovulation: 'ovulation',
    luteal: 'luteal — quiet',
    nodata: '',
  };

  const bandCls = [
    'cmd-band',
    `cmd-band-${model.phaseKey}`,
    model.pms && !model.onPeriod ? ' cmd-band-pms' : '',
  ].join(' ');

  return (
    <Panel label="cycle" tone="lavender" meta={model.cycleDay !== undefined ? `day ${model.cycleDay}` : undefined}>
      {failed && model.noData ? (
        <QuietLine>this room isn't wired up yet — it'll come alive with the backend.</QuietLine>
      ) : (
        <div className={bandCls}>
          {model.noData ? (
            <div className="cmd-band-cold">
              <span className="cmd-band-cold-line">
                one logged period gives me today; two teach me the horizon.
              </span>
            </div>
          ) : (
            <div className="cmd-band-row">
              <span className="cmd-band-day">day {model.cycleDay}</span>
              <div className="cmd-band-facts">
                {model.phaseKey !== 'nodata' && (
                  <span className={`cmd-band-phase${model.phaseKey === 'ovulation' ? ' gold' : ''}`}>
                    {phaseLabel[model.phaseKey]}
                  </span>
                )}
                <div className="cmd-band-pills">
                  {model.inFertile && <span className="cmd-pill cmd-pill-fertile">fertile window</span>}
                  {model.pms && !model.onPeriod && <span className="cmd-pill cmd-pill-lav">pms window</span>}
                  {typeof model.nextIn === 'number' && !model.onPeriod && (
                    model.nextIn >= 0
                      ? <span className="cmd-band-next">next ~{model.nextIn === 0 ? 'today' : `${model.nextIn}d`}</span>
                      : <span className="cmd-band-next late">overdue {-model.nextIn}d</span>
                  )}
                </div>
              </div>
            </div>
          )}

          <HorizonStrip
            model={model}
            selectedDay={selected?.day ?? null}
            onSelect={(day, dateIso) =>
              setSelected(prev => (prev?.day === day ? null : { day, dateIso }))}
          />
        </div>
      )}

      {selected && (
        <DayPopover
          day={selected.day}
          dateIso={selected.dateIso}
          busy={busy}
          onPeriodStart={dateIso => void periodStart(dateIso)}
          onPeriodEnd={dateIso => void periodEnd(dateIso)}
          onLog={(dateIso, flow, note) => void logDay(dateIso, flow, note)}
          onClose={() => setSelected(null)}
        />
      )}

      {/* today's one-tap action */}
      <div className="cmd-cycle-actions">
        {model.onPeriod ? (
          <button className="cmd-big-btn hearth-press" type="button" disabled={busy} onClick={() => void periodEnd(todayISO())}>
            period ended today
          </button>
        ) : (
          <button className="cmd-big-btn cmd-big-btn-rose hearth-press" type="button" disabled={busy} onClick={() => void periodStart(todayISO())}>
            period started today
          </button>
        )}
      </div>
      {!model.noData && (
        <p className="cmd-strip-hint">tap a day on the strip to log against that date.</p>
      )}

      {notice && <p className="cmd-notice">{notice}</p>}

      {/* predictions with confidence voice */}
      {!model.noData && model.nextIso && (
        <div className="cmd-predict">
          <div className="cmd-predict-row">
            <span className="cmd-predict-key">next period</span>
            <span className="cmd-predict-val">~{fmtIsoDay(model.nextIso)}</span>
          </div>
          {str(predict?.ovulation) && (
            <div className="cmd-predict-row">
              <span className="cmd-predict-key">ovulation</span>
              <span className="cmd-predict-val gold">~{fmtIsoDay(str(predict?.ovulation)!)}</span>
            </div>
          )}
          <div className="cmd-predict-conf">
            {model.completedCycles >= 2
              ? `based on ${model.completedCycles} cycles`
              : 'one logged period gives me today; two teach me the horizon.'}
          </div>
        </div>
      )}

      {/* history + settings */}
      <details className="cmd-details">
        <summary className="cmd-details-summary">history & settings</summary>
        <div className="cmd-details-body">
          {history.length > 0 ? (
            <div className="cmd-history">
              {history.slice(0, 8).map((h, i) => {
                // Cycle length = gap to the next-older start (rows are newest-first).
                const older = history[i + 1];
                const cycleLen = h.startIso && older?.startIso
                  ? diffDaysIso(older.startIso, h.startIso)
                  : undefined;
                const isEditing = h.id !== undefined && editingRow === h.id;
                return (
                  <div key={h.id ?? i} className="cmd-history-item">
                    <div className="cmd-history-row">
                      <span className="cmd-history-date">
                        {h.start ? fmtDay(h.start) : '—'}{h.end ? ` — ${fmtDay(h.end)}` : ' — open'}
                      </span>
                      <span className="cmd-history-len">
                        {h.periodLength !== undefined ? `${h.periodLength}d period` : ''}
                        {h.periodLength !== undefined && cycleLen !== undefined ? ' · ' : ''}
                        {cycleLen !== undefined ? `${cycleLen}d cycle` : ''}
                      </span>
                      {h.id && (
                        <button
                          className="cmd-mini-btn hearth-press"
                          type="button"
                          onClick={() => setEditingRow(isEditing ? null : h.id!)}
                        >
                          {isEditing ? 'close' : 'fix'}
                        </button>
                      )}
                    </div>
                    {isEditing && (
                      <CycleRowEditor
                        row={h}
                        marks={marks}
                        onDone={() => { setEditingRow(null); onChanged(); }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <QuietLine>no completed cycles recorded yet.</QuietLine>
          )}

          <div className="cmd-cycle-settings">
            <label className="cmd-setting">
              <span className="cmd-setting-key">avg cycle</span>
              <NumStepper value={avgCycle} min={15} max={60} unit="days" onCommit={commitAvgCycle} />
            </label>
            <label className="cmd-setting">
              <span className="cmd-setting-key">avg period</span>
              <NumStepper value={avgPeriod} min={1} max={14} unit="days" onCommit={commitAvgPeriod} />
            </label>
          </div>
        </div>
      </details>
    </Panel>
  );
}

// ─── 2 · Today's care — the day-arc ──────────────────────────────────────────

function CarePanel({
  care, categories, failed, onChanged, compact,
}: {
  care: CareItem[];
  categories: CareCategoryCfg[];
  failed: boolean;
  onChanged: () => void;
  /** The chips alone; today's log and the free-form add fold behind a "+". */
  compact?: boolean;
}) {
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [addCategory, setAddCategory] = useState('');
  const [addNote, setAddNote] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  const todays = care.filter(c => c.time === null || isToday(c.time));

  // WS-landed / changed rows: mcp rows shimmer, ui rows get the standard pulse.
  const pulses = usePulseOnChange(
    todays.map(c => ({ id: c.id, sig: `${c.category}|${c.value ?? ''}|${c.source ?? ''}|${c.time?.getTime() ?? 0}` })),
  );

  function entriesFor(key: string): CareItem[] {
    return todays.filter(c => c.category.toLowerCase() === key.toLowerCase());
  }
  function countFor(key: string): number {
    const e = entriesFor(key);
    if (e.length === 0) return 0;
    const n = parseInt(e[e.length - 1].value ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : e.length;
  }

  async function quickLog(cat: CareCategoryCfg) {
    const already = entriesFor(cat.key);
    if (already.length > 0 && !cat.repeatable) return;
    if (pending.has(cat.key)) return;
    setPending(prev => new Set(prev).add(cat.key));
    await apiSend('/api/cc/care', 'POST', { category: cat.key });
    onChanged();
    setPending(prev => { const n = new Set(prev); n.delete(cat.key); return n; });
  }

  async function addFreeform() {
    const category = addCategory.trim();
    if (!category || addBusy) return;
    setAddBusy(true);
    const body: Rec = { category };
    if (addNote.trim()) body.note = addNote.trim();
    const { ok } = await apiSend('/api/cc/care', 'POST', body);
    setAddBusy(false);
    if (ok) {
      setAddCategory('');
      setAddNote('');
      onChanged();
    }
  }

  async function remove(id: string) {
    setDeleting(prev => new Set(prev).add(id));
    await apiSend(`/api/cc/care/${id}`, 'DELETE');
    onChanged();
    setDeleting(prev => { const n = new Set(prev); n.delete(id); return n; });
  }

  const doneCount = categories.filter(c => entriesFor(c.key).length > 0).length;
  const total = categories.length;
  const complete = total > 0 && doneCount === total;
  const arcPct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <Panel
      label="today's care"
      tone="amber"
      meta={`${doneCount}/${total}`}
      extra={complete ? <span className="cmd-crest" title="all kept today">✦ all kept</span> : undefined}
    >
      {/* the day-arc: ember track lit as far as completions */}
      <div className="cmd-care-arc">
        <div className="cmd-care-chips">
          {categories.map(cat => {
            const entries = entriesFor(cat.key);
            const isPending = pending.has(cat.key);
            const done = entries.length > 0 || isPending;
            const count = cat.repeatable ? countFor(cat.key) : 0;
            const latest = entries.reduce<Date | null>((acc, e) => {
              if (!e.time) return acc;
              return !acc || e.time > acc ? e.time : acc;
            }, null);
            const met = cat.repeatable && cat.target !== undefined && count >= cat.target;
            return (
              <button
                key={cat.key}
                type="button"
                className={`cmd-care-chip hearth-press${done ? ' done' : ''}${met ? ' met' : ''}`}
                onClick={() => void quickLog(cat)}
                disabled={isPending}
                aria-label={
                  cat.repeatable
                    ? `log ${cat.label}${count > 0 ? ` — ${count}${cat.target ? ` of ${cat.target}` : ''} so far` : ''}`
                    : done ? `${cat.label} — logged` : `log ${cat.label}`
                }
              >
                <span className="cmd-care-chip-mark" aria-hidden="true">{done ? '✓' : ''}</span>
                <span className="cmd-care-chip-icon"><CareIcon k={cat.key} /></span>
                <span className="cmd-care-chip-label">{cat.label}</span>
                {cat.repeatable && count > 0 && (
                  <span className="cmd-care-chip-count">
                    ×{count}{cat.target ? ` / ${cat.target}` : ''}
                  </span>
                )}
                {!cat.repeatable && done && (
                  <span className="cmd-care-chip-time">
                    {isPending && entries.length === 0 ? '…' : latest ? fmtTime(latest) : ''}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className={`cmd-arc-track${complete ? ' full' : ''}`} aria-hidden="true">
          <div className="cmd-arc-fill" style={{ width: `${arcPct}%` }} />
        </div>
      </div>

      {foldIf(compact, `today’s log${todays.length > 0 ? ` · ${todays.length}` : ''}`, <>
      {failed && care.length === 0 ? (
        <QuietLine>care log isn't wired up yet — taps will land once the backend is in.</QuietLine>
      ) : todays.length > 0 ? (
        <div className="cmd-care-list">
          {todays.map((c, i) => {
            const pulsed = c.id ? pulses[c.id] : undefined;
            const fromCompanion = c.source === 'mcp';
            const rowCls = [
              'cmd-care-row',
              c.id && deleting.has(c.id) ? 'dim' : '',
              pulsed ? (fromCompanion ? 'cmd-shimmer' : 'cmd-pulse') : '',
            ].filter(Boolean).join(' ');
            return (
              <div key={c.id ? `${c.id}:${pulsed ?? 0}` : i} className={rowCls}>
                <span className="cmd-care-row-cat">{c.category}</span>
                {c.value && <span className="cmd-care-row-val">{c.value}</span>}
                {c.note && <span className="cmd-care-row-note">{c.note}</span>}
                <span className="cmd-care-row-time">
                  {fromCompanion
                    ? `logged · ${c.time ? fmtTime(c.time) : '—'} · companion`
                    : c.time ? fmtTime(c.time) : ''}
                </span>
                {c.id && (
                  <button
                    className="cmd-x"
                    aria-label={`delete ${c.category} entry`}
                    disabled={deleting.has(c.id)}
                    onClick={() => void remove(c.id!)}
                    type="button"
                  >×</button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <QuietLine>nothing logged yet today.</QuietLine>
      )}

      {/* free-form add */}
      <div className="cmd-add-row">
        <input
          className="cmd-input cmd-add-cat"
          placeholder="category"
          value={addCategory}
          onChange={e => setAddCategory(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void addFreeform(); }}
        />
        <input
          className="cmd-input cmd-add-note"
          placeholder="note (optional)"
          value={addNote}
          onChange={e => setAddNote(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void addFreeform(); }}
        />
        <button
          className="cmd-btn hearth-press"
          disabled={addBusy || !addCategory.trim()}
          onClick={() => void addFreeform()}
          type="button"
        >
          add
        </button>
      </div>
      </>)}
    </Panel>
  );
}

// ─── 3 · Routines — rings on the shared clock ────────────────────────────────

// Full lowercase names — the backend's status logic matches e.g. 'tuesday', not 'tue'.
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

/** 14px ring with a depleting conic arc — time left in the window. */
function RoutineRing({ state, frac }: { state: RoutineState | 'off'; frac: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
  const style = state === 'pending'
    ? { background: `conic-gradient(var(--amber, #c9a87c) ${pct}%, rgba(255,255,255,0.08) 0)` }
    : undefined;
  return (
    <span className={`cmd-ring cmd-ring-${state}`} style={style} aria-hidden="true">
      <span className="cmd-ring-core" />
    </span>
  );
}

function RoutineEditor({
  routine, categories, onSaved, onDeleted, onClose,
}: {
  routine: RoutineItem;
  categories: CareCategoryCfg[];
  onSaved: () => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(routine.label);
  const [category, setCategory] = useState(routine.category ?? '');
  const [windowStart, setWindowStart] = useState(routine.windowStart ?? '');
  const [windowEnd, setWindowEnd] = useState(routine.windowEnd ?? '20:00');
  const [days, setDays] = useState<Set<string>>(
    new Set(routine.days === 'daily' ? WEEKDAYS : routine.days),
  );
  const [active, setActive] = useState(routine.active);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const allDays = days.size === WEEKDAYS.length;

  const categoryOptions = useMemo(() => {
    const opts = categories.map(c => ({ value: c.key, label: c.key }));
    if (category && !opts.some(o => o.value === category)) {
      opts.push({ value: category, label: category });
    }
    return opts;
  }, [categories, category]);

  async function save() {
    if (busy || !label.trim() || !windowEnd.trim()) return;
    setBusy(true);
    // Backend PATCH contract: window_start/window_end are "HH:MM" strings,
    // days is 'daily' or a CSV of full lowercase weekday names.
    const body: Rec = {
      label: label.trim(),
      window_end: windowEnd.trim(),
      days: allDays || days.size === 0 ? 'daily' : WEEKDAYS.filter(d => days.has(d)).join(','),
      active,
    };
    if (category.trim()) body.category = category.trim();
    if (windowStart.trim()) body.window_start = windowStart.trim();
    const { ok } = await apiSend(`/api/cc/routines/${routine.id}`, 'PATCH', body);
    setBusy(false);
    if (ok) { onSaved(); onClose(); }
  }

  async function del(hard: boolean) {
    if (busy) return;
    setBusy(true);
    const { ok } = await apiSend(`/api/cc/routines/${routine.id}${hard ? '?hard=true' : ''}`, 'DELETE');
    setBusy(false);
    if (ok) { onDeleted(); onClose(); }
  }

  return (
    <div className="cmd-routine-editor">
      <div className="cmd-editor-grid">
        <label className="cmd-field">
          <span className="cmd-field-key">label</span>
          <input className="cmd-input" value={label} onChange={e => setLabel(e.target.value)} />
        </label>
        <label className="cmd-field">
          <span className="cmd-field-key">category</span>
          <HearthSelect
            value={category}
            onChange={setCategory}
            options={categoryOptions}
            placeholder="pick one…"
            ariaLabel="routine category"
            block
          />
        </label>
        <div className="cmd-field">
          <span className="cmd-field-key">window start (optional)</span>
          <HearthTimePicker compact value={windowStart || '00:00'} onChange={setWindowStart} />
        </div>
        <div className="cmd-field">
          <span className="cmd-field-key">window end</span>
          <HearthTimePicker compact value={windowEnd || '20:00'} onChange={setWindowEnd} />
        </div>
      </div>

      <div className="cmd-field">
        <span className="cmd-field-key">days</span>
        <div className="cmd-day-toggles">
          <button
            type="button"
            className={`cmd-chip hearth-press${allDays ? ' cmd-chip-selected' : ''}`}
            onClick={() => setDays(allDays ? new Set() : new Set(WEEKDAYS))}
          >
            daily
          </button>
          {WEEKDAYS.map(d => (
            <button
              key={d}
              type="button"
              className={`cmd-chip hearth-press${days.has(d) ? ' cmd-chip-selected' : ''}`}
              onClick={() => setDays(prev => {
                const n = new Set(prev);
                if (n.has(d)) n.delete(d); else n.add(d);
                return n;
              })}
            >
              {d.slice(0, 3)}
            </button>
          ))}
        </div>
      </div>

      <div className="cmd-editor-foot">
        <HearthSwitch checked={active} onChange={setActive} label="active" />
        {confirming ? (
          <span className="cmd-confirm">
            <button className="cmd-btn hearth-press" type="button" disabled={busy} onClick={() => void del(false)}>
              rest it (keeps history)
            </button>
            <button className="cmd-btn cmd-btn-danger hearth-press" type="button" disabled={busy} onClick={() => void del(true)}>
              delete for good
            </button>
            <button className="cmd-btn hearth-press" type="button" onClick={() => setConfirming(false)}>cancel</button>
          </span>
        ) : (
          <div className="cmd-editor-btns">
            <button className="cmd-btn cmd-btn-danger hearth-press" disabled={busy} onClick={() => setConfirming(true)} type="button">remove…</button>
            <button className="cmd-btn hearth-press" onClick={onClose} type="button">cancel</button>
            <button className="cmd-btn cmd-btn-amber hearth-press" disabled={busy || !label.trim() || !windowEnd.trim()} onClick={() => void save()} type="button">
              {busy ? 'saving…' : 'save'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}


function RoutineAddRow({ categories, onChanged }: { categories: CareCategoryCfg[]; onChanged: () => void }) {
  const [addLabel, setAddLabel] = useState('');
  const [addCategory, setAddCategory] = useState('');
  const [addWindowEnd, setAddWindowEnd] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const addCategoryOptions = useMemo(
    () => categories.map(c => ({ value: c.key, label: c.key })),
    [categories],
  );

  async function addRoutine() {
    const label = addLabel.trim();
    const category = addCategory.trim();
    // Backend POST requires label + category + window_end.
    if (!label || !category || !addWindowEnd || addBusy) return;
    setAddBusy(true);
    const { ok } = await apiSend('/api/cc/routines', 'POST', { label, category, window_end: addWindowEnd });
    setAddBusy(false);
    if (ok) { setAddLabel(''); setAddCategory(''); setAddWindowEnd(''); onChanged(); }
  }

  return (
    <div className="cmd-add-row">
      <input
        className="cmd-input cmd-add-note"
        placeholder="new routine…"
        value={addLabel}
        onChange={e => setAddLabel(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void addRoutine(); }}
      />
      <HearthSelect
        value={addCategory}
        onChange={setAddCategory}
        options={addCategoryOptions}
        placeholder="category…"
        ariaLabel="new routine category"
      />
      <HearthTimePicker compact value={addWindowEnd || '20:00'} onChange={setAddWindowEnd} />
      <button
        className="cmd-btn hearth-press"
        disabled={addBusy || !addLabel.trim() || !addCategory.trim() || !addWindowEnd}
        onClick={() => void addRoutine()}
        type="button"
      >
        add
      </button>
    </div>
  );
}

// ─── 4 · Wins — today's one true win, a slot per person ─────────────────────

function WinSlot({
  who, win, onKept,
}: {
  who: 'user' | 'companion';
  win: WinItem | undefined;
  onKept: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [keptTs, setKeptTs] = useState(0);

  async function keep() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    const { ok } = await apiSend('/api/cc/wins', 'POST', { text, who });
    setBusy(false);
    if (ok) {
      setEditing(false);
      setKeptTs(Date.now());
      onKept();
    }
  }

  const label = who === 'user' ? 'yours' : "the companion's";
  const placeholder = who === 'user'
    ? 'one true win…'
    : 'theirs lands from chat — or keep it for them.';

  return (
    <div key={keptTs} className={`cmd-win-slot cmd-win-${who}${keptTs ? ' cmd-pulse-gold' : ''}`}>
      <span className="cmd-win-slot-who">{label}</span>
      {editing ? (
        <input
          className="cmd-input cmd-win-slot-input"
          autoFocus
          defaultValue={win?.text ?? ''}
          placeholder="one true win…"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') setEditing(false);
            if (e.key === 'Enter') void keep();
          }}
          onBlur={() => { if (draft.trim() && draft.trim() !== (win?.text ?? '')) void keep(); else setEditing(false); }}
        />
      ) : win ? (
        <button
          type="button"
          className="cmd-win-slot-text"
          onClick={() => { setDraft(win.text); setEditing(true); }}
          title="edit today's win"
        >
          {win.text}
        </button>
      ) : (
        <button
          type="button"
          className="cmd-win-slot-empty"
          onClick={() => { setDraft(''); setEditing(true); }}
        >
          {placeholder}
        </button>
      )}
    </div>
  );
}

function WinsPanel({
  wins, failed, onChanged,
}: {
  wins: WinItem[];
  failed: boolean;
  onChanged: () => void;
}) {
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  const pulses = usePulseOnChange(
    wins.map(w => ({ id: w.id, sig: `${w.text}|${w.who ?? ''}` })),
  );

  const today = todayISO();
  const todayWins = wins.filter(w => w.dateIso === today || (w.when !== null && isToday(w.when)));
  const userToday = todayWins.find(w => w.who === 'user');
  const companionToday = todayWins.find(w => w.who === 'companion');

  // Past days, grouped: yesterday, then dates.
  const yesterday = addDaysIso(today, -1);
  const past = wins.filter(w => !todayWins.includes(w));
  const groups = new Map<string, WinItem[]>();
  for (const w of past) {
    const k = w.dateIso ?? (w.when ? `${w.when.getFullYear()}-${pad2(w.when.getMonth() + 1)}-${pad2(w.when.getDate())}` : 'earlier');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(w);
  }
  const groupKeys = [...groups.keys()].sort((a, b) => (a < b ? 1 : -1));

  async function remove(id: string) {
    setDeleting(prev => new Set(prev).add(id));
    await apiSend(`/api/cc/wins/${id}`, 'DELETE');
    onChanged();
    setDeleting(prev => { const n = new Set(prev); n.delete(id); return n; });
  }

  const anyWins = wins.length > 0;

  return (
    <Panel label="wins" tone="lavender">
      <div className="cmd-win-group-label">tonight</div>
      <WinSlot who="user" win={userToday} onKept={onChanged} />
      <WinSlot who="companion" win={companionToday} onKept={onChanged} />

      {failed && !anyWins ? (
        <QuietLine>wins aren't wired up yet.</QuietLine>
      ) : !anyWins ? (
        <QuietLine>nothing logged yet — there's been at least one, though.</QuietLine>
      ) : groupKeys.length > 0 ? (
        <div className="cmd-win-list">
          {groupKeys.slice(0, 6).map(k => (
            <div key={k} className="cmd-win-group">
              <div className="cmd-win-group-label">
                {k === yesterday ? 'yesterday' : k === 'earlier' ? 'earlier' : fmtIsoDay(k)}
              </div>
              {groups.get(k)!.map((w, i) => {
                const pulsed = w.id ? pulses[w.id] : undefined;
                return (
                  <div
                    key={w.id ? `${w.id}:${pulsed ?? 0}` : i}
                    className={`cmd-win-row cmd-win-${w.who === 'companion' ? 'companion' : 'user'}${w.id && deleting.has(w.id) ? ' dim' : ''}${pulsed ? ' cmd-pulse-lav' : ''}`}
                  >
                    <span className="cmd-win-who">{w.who === 'companion' ? 'C' : 'U'}</span>
                    <span className="cmd-win-text">{w.text}</span>
                    {w.id && (
                      <button
                        className="cmd-x"
                        aria-label="delete win"
                        disabled={deleting.has(w.id)}
                        onClick={() => void remove(w.id!)}
                        type="button"
                      >×</button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

// ─── 5 · Countdowns — nearest promoted ───────────────────────────────────────

function CountdownRow({
  c, deleting, pulsed, onEdit, onRemove,
}: {
  c: CountdownItem;
  deleting: boolean;
  pulsed: number | undefined;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={`cmd-count-row${deleting ? ' dim' : ''}${pulsed ? ' cmd-pulse' : ''}`}>
      <span className="cmd-count-label">{c.label}</span>
      <span className={`cmd-count-days${c.daysAway === 0 ? ' today' : (c.daysAway ?? 99) <= 7 && (c.daysAway ?? 99) >= 0 ? ' soon' : ''}`}>
        {c.daysAway === undefined ? '—'
          : c.daysAway === 0 ? 'today'
          : c.daysAway === 1 ? 'tomorrow'
          : c.daysAway < 0 ? `${Math.abs(c.daysAway)}d ago`
          : `${c.daysAway}d`}
      </span>
      {c.dateIso && <span className="cmd-count-when">{fmtIsoDay(c.dateIso)}</span>}
      {c.id && !confirming && (
        <>
          <button className="cmd-mini-btn hearth-press" type="button" onClick={onEdit}>edit</button>
          <button
            className="cmd-x"
            aria-label={`delete ${c.label}`}
            disabled={deleting}
            onClick={() => setConfirming(true)}
            type="button"
          >×</button>
        </>
      )}
      {c.id && confirming && (
        <span className="cmd-confirm">
          <button className="cmd-btn cmd-btn-danger hearth-press" type="button" onClick={() => { setConfirming(false); onRemove(); }}>delete</button>
          <button className="cmd-btn hearth-press" type="button" onClick={() => setConfirming(false)}>keep</button>
        </span>
      )}
    </div>
  );
}

function CountdownEditor({
  c, onDone,
}: { c: CountdownItem; onDone: () => void }) {
  const [title, setTitle] = useState(c.label);
  const [date, setDate] = useState(c.dateIso ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!c.id || busy || !title.trim() || !date) return;
    setBusy(true);
    await apiSend(`/api/cc/countdowns/${c.id}`, 'PATCH', { title: title.trim(), target_date: date });
    setBusy(false);
    onDone();
  }
  return (
    <div className="cmd-row-editor">
      <div className="cmd-row-editor-fields">
        <input className="cmd-input cmd-add-note" value={title} onChange={e => setTitle(e.target.value)} aria-label="countdown title" />
        <HearthDatePicker value={date} onChange={setDate} ariaLabel="countdown date" />
      </div>
      <div className="cmd-row-editor-btns">
        <button className="cmd-btn hearth-press" type="button" onClick={onDone}>cancel</button>
        <button className="cmd-btn cmd-btn-amber hearth-press" type="button" disabled={busy || !title.trim() || !date} onClick={() => void save()}>
          {busy ? 'saving…' : 'save'}
        </button>
      </div>
    </div>
  );
}

function CountdownsPanel({
  countdowns, failed, onChanged, compact,
}: {
  countdowns: CountdownItem[];
  failed: boolean;
  onChanged: () => void;
  /** Its add form folds behind a "+". */
  compact?: boolean;
}) {
  const [label, setLabel] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);

  const pulses = usePulseOnChange(
    countdowns.map(c => ({ id: c.id, sig: `${c.label}|${c.dateIso ?? ''}` })),
  );

  async function add() {
    if (!label.trim() || !date || busy) return;
    setBusy(true);
    const { ok } = await apiSend('/api/cc/countdowns', 'POST', { title: label.trim(), target_date: date });
    setBusy(false);
    if (ok) { setLabel(''); setDate(''); onChanged(); }
  }

  async function remove(id: string) {
    setDeleting(prev => new Set(prev).add(id));
    await apiSend(`/api/cc/countdowns/${id}`, 'DELETE');
    onChanged();
    setDeleting(prev => { const n = new Set(prev); n.delete(id); return n; });
  }

  const upcoming = countdowns
    .filter(c => (c.daysAway ?? -1) >= 0)
    .sort((a, b) => (a.daysAway ?? 9999) - (b.daysAway ?? 9999));
  const nearest = upcoming[0];
  const rest = countdowns
    .filter(c => c !== nearest)
    .sort((a, b) => (a.daysAway ?? 9999) - (b.daysAway ?? 9999));

  const nearestGold = nearest && (nearest.daysAway ?? 99) <= 3;
  const nearestSoon = nearest && (nearest.daysAway ?? 99) <= 7;

  return (
    <Panel label="countdowns" meta={countdowns.length > 0 ? String(countdowns.length) : undefined}>
      {failed && countdowns.length === 0 ? (
        <QuietLine>countdowns aren't wired up yet.</QuietLine>
      ) : countdowns.length === 0 ? (
        <QuietLine>nothing logged yet.</QuietLine>
      ) : (
        <>
          {nearest && (
            <div className={`cmd-count-hero${nearestGold ? ' gold' : ''}`}>
              <div className="cmd-count-hero-top">
                {nearestSoon && <span className={`cmd-ember-dot${nearestGold ? ' gold' : ''}`} aria-hidden="true" />}
                <span className="cmd-count-hero-days">
                  {nearest.daysAway === 0 ? 'today'
                    : nearest.daysAway === 1 ? 'tomorrow'
                    : `${nearest.daysAway}d`}
                </span>
                {nearest.id && editing !== nearest.id && (
                  <button className="cmd-mini-btn hearth-press" type="button" onClick={() => setEditing(nearest.id!)}>edit</button>
                )}
              </div>
              <div className="cmd-count-hero-label">{nearest.label}</div>
              {nearest.dateIso && <div className="cmd-count-hero-when">{fmtIsoDay(nearest.dateIso)}</div>}
              <div className="cmd-filament" aria-hidden="true" />
              {nearest.id && editing === nearest.id && (
                <CountdownEditor c={nearest} onDone={() => { setEditing(null); onChanged(); }} />
              )}
            </div>
          )}

          {rest.length > 0 && (
            <div className="cmd-count-list">
              {rest.map((c, i) => (
                <React.Fragment key={c.id ? `${c.id}:${pulses[c.id] ?? 0}` : i}>
                  <CountdownRow
                    c={c}
                    deleting={!!c.id && deleting.has(c.id)}
                    pulsed={c.id ? pulses[c.id] : undefined}
                    onEdit={() => setEditing(c.id ?? null)}
                    onRemove={() => { if (c.id) void remove(c.id); }}
                  />
                  {c.id && editing === c.id && (
                    <CountdownEditor c={c} onDone={() => { setEditing(null); onChanged(); }} />
                  )}
                </React.Fragment>
              ))}
            </div>
          )}
        </>
      )}

      {foldIf(compact, 'add a countdown', <div className="cmd-add-row">
        <input
          className="cmd-input cmd-add-note"
          placeholder="what's coming…"
          value={label}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void add(); }}
        />
        <HearthDatePicker value={date} onChange={setDate} ariaLabel="countdown date" />
        <button
          className="cmd-btn hearth-press"
          disabled={busy || !label.trim() || !date}
          onClick={() => void add()}
          type="button"
        >
          add
        </button>
      </div>)}
    </Panel>
  );
}

// ─── CommandCenterView (main export) ──────────────────────────────────────────



// ─── Automations — the companion's real schedule, watchers and reminders ─────
// The orchestrator's own routes (routes/api.ts): GET /api/orchestrator/status → { tasks }, PATCH /tasks/:wakeType
// { enabled } pauses a scheduled wake without deleting it; GET /triggers?kind=watcher, PATCH /triggers/:id
// { status: 'paused' | 'pending' }; GET /timers, DELETE /timers/:id. The server announces every change over the
// socket as { type: 'orchestrator_update' }, so the panel follows Settings and the companion live.

interface AutoTask { wakeType: string; label: string; cronExpr: string; enabled: boolean; nextRun: Date | null; category: string }
interface AutoWatcher { id: string; label: string; paused: boolean; fireCount: number }
interface AutoTimer { id: string; label: string; fireAt: Date | null }

/** The wakes a person schedules (the morning, midday and evening wakes, check-ins, their own routines); the house's
 *  own machinery (the midnight handoff, the failsafe) stays in Settings. */
const PERSONAL_CATEGORIES = new Set(['wake', 'checkin', 'routine']);

function normTasks(v: unknown): AutoTask[] {
  return listOf(v, ['tasks']).flatMap((e): AutoTask[] => {
    const r = rec(e);
    const wakeType = r && str(r.wakeType);
    if (!r || !wakeType || !PERSONAL_CATEGORIES.has(str(r.category) ?? 'routine')) return [];
    return [{
      wakeType, label: str(r.label) ?? wakeType, cronExpr: str(r.cronExpr) ?? '', enabled: bool(r.enabled) ?? true,
      nextRun: dateOf(r, ['nextRun']), category: str(r.category) ?? 'routine',
    }];
  });
}
function normWatchers(v: unknown): AutoWatcher[] {
  return listOf(v, ['triggers']).flatMap((e): AutoWatcher[] => {
    const r = rec(e);
    const id = r && idOf(r);
    const status = r && str(r.status);
    if (!r || !id || str(r.kind) !== 'watcher' || status === 'cancelled' || status === 'fired') return [];
    return [{ id, label: str(r.label) ?? 'watcher', paused: status === 'paused', fireCount: num(r.fire_count) ?? 0 }];
  });
}
function normTimers(v: unknown): AutoTimer[] {
  return listOf(v, ['timers']).flatMap((e): AutoTimer[] => {
    const r = rec(e);
    const id = r && idOf(r);
    if (!r || !id) return [];
    return [{ id, label: str(r.label) ?? 'reminder', fireAt: dateOf(r, ['fire_at', 'fireAt']) }];
  });
}
function fmtWhen(d: Date): string {
  return isToday(d) ? `today ${fmtTime(d)}` : `${fmtDay(d)} ${fmtTime(d)}`;
}
function countOf(n: number, one: string): string {
  return n === 0 ? '' : `${n} ${one}${n === 1 ? '' : 's'}`;
}

function useAutomations() {
  const [tasks, setTasks] = useState<AutoTask[] | null>(null);
  const [watchers, setWatchers] = useState<AutoWatcher[]>([]);
  const [timers, setTimers] = useState<AutoTimer[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [status, triggers, pending] = await Promise.all([
      apiGet('/api/orchestrator/status'),
      apiGet('/api/orchestrator/triggers?kind=watcher'),
      apiGet('/api/orchestrator/timers'),
    ]);
    setFailed(status === null);
    setTasks(normTasks(status));
    setWatchers(normWatchers(triggers));
    setTimers(normTimers(pending));
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const handler = (msg: unknown) => { if (rec(msg)?.type === 'orchestrator_update') void load(); };
    const w = window as unknown as { __sanctumWsListeners?: Array<(m: unknown) => void> };
    (w.__sanctumWsListeners ??= []).push(handler);
    return () => { w.__sanctumWsListeners = (w.__sanctumWsListeners ?? []).filter(h => h !== handler); };
  }, [load]);

  const mark = (id: string, on: boolean) => setBusy(prev => { const n = new Set(prev); if (on) n.add(id); else n.delete(id); return n; });

  async function toggleTask(t: AutoTask, enabled: boolean) {
    mark(t.wakeType, true);
    setTasks(prev => prev && prev.map(x => x.wakeType === t.wakeType ? { ...x, enabled } : x)); // optimistic
    const { ok } = await apiSend(`/api/orchestrator/tasks/${encodeURIComponent(t.wakeType)}`, 'PATCH', { enabled });
    if (!ok) setTasks(prev => prev && prev.map(x => x.wakeType === t.wakeType ? { ...x, enabled: !enabled } : x));
    mark(t.wakeType, false);
  }
  async function toggleWatcher(w: AutoWatcher, on: boolean) {
    mark(w.id, true);
    setWatchers(prev => prev.map(x => x.id === w.id ? { ...x, paused: !on } : x));
    const { ok } = await apiSend(`/api/orchestrator/triggers/${encodeURIComponent(w.id)}`, 'PATCH', { status: on ? 'pending' : 'paused' });
    if (!ok) setWatchers(prev => prev.map(x => x.id === w.id ? { ...x, paused: on } : x));
    mark(w.id, false);
  }
  async function cancelTimer(t: AutoTimer) {
    mark(t.id, true);
    const { ok } = await apiSend(`/api/orchestrator/timers/${encodeURIComponent(t.id)}`, 'DELETE');
    if (ok) setTimers(prev => prev.filter(x => x.id !== t.id));
    mark(t.id, false);
  }

  return { tasks, watchers, timers, failed, busy, toggleTask, toggleWatcher, cancelTimer, reload: load };
}
type Automations = ReturnType<typeof useAutomations>;

function AutomationsPanel({ auto }: { auto: Automations }) {
  const { tasks, watchers, timers, failed, busy, toggleTask, toggleWatcher, cancelTimer } = auto;
  // Closed to one line (what is next, and how many there are) until asked: the whole list is too much to look at.
  const [open, setOpen] = useState(false);
  const listId = useId();

  const none = tasks !== null && tasks.length === 0 && watchers.length === 0 && timers.length === 0;
  const total = (tasks?.length ?? 0) + watchers.length + timers.length;
  const next = [
    ...(tasks ?? []).flatMap(t => (t.enabled && t.nextRun ? [{ label: t.label, at: t.nextRun }] : [])),
    ...timers.flatMap(t => (t.fireAt ? [{ label: t.label, at: t.fireAt }] : [])),
  ].sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  const counts = [countOf(tasks?.length ?? 0, 'wake-up'), countOf(watchers.length, 'watcher'), countOf(timers.length, 'reminder')]
    .filter(Boolean).join(' · ');
  return (
    <Panel label="automations" meta={tasks ? `${tasks.filter(t => t.enabled).length + watchers.filter(w => !w.paused).length} on` : undefined}>
      {failed ? (
        <QuietLine>the house's schedule isn't reachable right now — it may be switched off in Settings.</QuietLine>
      ) : tasks === null ? (
        <QuietLine>…</QuietLine>
      ) : none ? (
        <QuietLine>nothing scheduled yet — wakes and reminders set in Settings or by the companion land here.</QuietLine>
      ) : (<>
        <button type="button" className="cmd-auto-summary hearth-press" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(o => !o)}>
          <span className="cmd-auto-icon" aria-hidden="true"><SectionIcon k="automations" /></span>
          <span className="cmd-auto-main">
            <span className="cmd-auto-title">{next ? `Next: ${next.label}` : 'Nothing due'}</span>
            <span className="cmd-auto-sub">{next ? <>{fmtWhen(next.at)}{counts && <span className="cmd-auto-counts"> · {counts}</span>}</> : counts}</span>
          </span>
          <span className="cmd-auto-more">
            {open ? 'Hide' : `Show all ${total}`}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={open ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
            </svg>
          </span>
        </button>
        {open && <ul className="cmd-auto-list" id={listId}>
          {tasks.map(t => (
            <li key={`t:${t.wakeType}`} className={`cmd-auto-row${t.enabled ? '' : ' off'}`}>
              <span className="cmd-auto-icon" aria-hidden="true"><SectionIcon k="routines" /></span>
              <span className="cmd-auto-main">
                <span className="cmd-auto-title">{t.label}</span>
                <span className="cmd-auto-sub">{cronSummary(t.cronExpr)}</span>
              </span>
              <span className="cmd-auto-when">{t.enabled && t.nextRun ? `next ${fmtWhen(t.nextRun)}` : t.enabled ? '' : 'paused'}</span>
              <HearthSwitch checked={t.enabled} onChange={v => void toggleTask(t, v)} label={t.enabled ? 'On' : 'Off'} ariaLabel={`${t.label}: ${t.enabled ? 'on' : 'off'}`} />
            </li>
          ))}
          {watchers.map(w => (
            <li key={`w:${w.id}`} className={`cmd-auto-row${w.paused ? ' off' : ''}`}>
              <span className="cmd-auto-icon" aria-hidden="true"><SectionIcon k="automations" /></span>
              <span className="cmd-auto-main">
                <span className="cmd-auto-title">{w.label}</span>
                <span className="cmd-auto-sub">watcher{w.fireCount > 0 ? ` · fired ${w.fireCount}×` : ''}</span>
              </span>
              <span className="cmd-auto-when">{w.paused ? 'paused' : ''}</span>
              <HearthSwitch checked={!w.paused} onChange={v => void toggleWatcher(w, v)} label={w.paused ? 'Off' : 'On'} ariaLabel={`${w.label}: ${w.paused ? 'off' : 'on'}`} />
            </li>
          ))}
          {timers.map(t => (
            <li key={`r:${t.id}`} className="cmd-auto-row">
              <span className="cmd-auto-icon" aria-hidden="true"><SectionIcon k="countdowns" /></span>
              <span className="cmd-auto-main">
                <span className="cmd-auto-title">{t.label}</span>
                <span className="cmd-auto-sub">reminder</span>
              </span>
              <span className="cmd-auto-when">{t.fireAt ? fmtWhen(t.fireAt) : ''}</span>
              <button className="cmd-x" type="button" aria-label={`cancel reminder: ${t.label}`} disabled={busy.has(t.id)} onClick={() => void cancelTimer(t)}>×</button>
            </li>
          ))}
        </ul>}
      </>)}
    </Panel>
  );
}

// ─── The day — Echo's words over the day, morning to night ───────────────────
// Echo's line is the presence the companion authors for the house (GET /api/outlook → hearth.presence, rewritten every few
// hours by the outlook author); without one the header says what is next. The timeline puts everything with a time today in
// one column: routines (their windows), the companion's check-ins (the orchestrator's wakes that run today), calendar
// events and reminders, with a line at now. What has no time (all-day events, to-dos) sits above it.

type DayKind = 'routine' | 'wake' | 'event' | 'reminder';
interface DayRow {
  key: string; min: number; time: string; kind: DayKind; title: string; sub: string;
  right?: string; tone?: 'done' | 'missed' | 'off' | 'warm'; routine?: RoutineItem; ring?: { state: RoutineState | 'off'; frac: number };
}

/** An event's start as "HH:MM": the calendar gives a clock time or an ISO stamp. */
function eventHm(v: string): string | null {
  const hm = /^(\d{1,2}):(\d{2})/.exec(v);
  if (hm) return `${pad2(Number(hm[1]))}:${hm[2]}`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) || !isToday(d) ? null : fmtTime(d);
}

function DayHeader({ orb, room, companion, words, ask, dateLine, fallback, manage }: {
  orb: OrbState | null; room: string | null; companion: string; words: string | null; ask: string | null;
  dateLine: string; fallback: string | null; manage: React.ReactNode;
}) {
  const navigate = useNavigate();
  const title = room ? `the ${room.replace(/-/g, ' ')} — back to the hearth` : 'back to the hearth';
  return (
    <header className="cmd-head cmd-dayhead">
      <button className="cmd-orb-btn hearth-press" type="button" onClick={() => navigate('/')} aria-label="Back to the hearth" title={title}>
        <Orb size="waiting" color={orb?.color ?? 'amber'} blend={orb?.blend} shape={orb?.shape} motion={orb?.motion} intensity={orb?.intensity} />
      </button>
      <div className="cmd-head-text">
        {/* each part whole: the line breaks at its dots, never inside "care 2/4" */}
        <h1 className="cmd-dayhead-date">{dateLine.split(' · ').map((part, i) => <React.Fragment key={i}>{i > 0 && ' · '}<span>{part}</span></React.Fragment>)}</h1>
        {words ? (
          <figure className="cmd-dayhead-words">
            <blockquote><p>{words}</p></blockquote>
            <figcaption>— {companion}</figcaption>
          </figure>
        ) : fallback ? (
          <p className="cmd-dayhead-next">{fallback}</p>
        ) : null}
      </div>
      {manage}
      {ask && <p className="cmd-dayhead-ask"><span>{companion} asks</span>{ask}</p>}
    </header>
  );
}

function DayTimeline({
  routines, status, categories, auto, events, todos, companion, timezone, now, onRoutinesChanged,
}: {
  routines: RoutineItem[]; status: unknown; categories: CareCategoryCfg[]; auto: Automations;
  events: Array<{ time: string; title: string; allDay: boolean }>; todos: Array<{ title: string; due?: string }>;
  companion: string; timezone: string | null; now: number; onRoutinesChanged: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const today = new Date(now);
  const nowMin = today.getHours() * 60 + today.getMinutes();
  const weekday = WEEKDAYS[(today.getDay() + 6) % 7];

  const rows: DayRow[] = [];
  // Rested routines, and those with no window today, stay one tap away (below the day) to be resumed, edited or deleted.
  const others: RoutineItem[] = [];
  for (const r of routines) {
    const start = hmToMin(r.windowStart);
    const end = hmToMin(r.windowEnd);
    const min = start ?? end;
    if (!r.active || (r.days !== 'daily' && r.days.length > 0 && !r.days.includes(weekday)) || min === undefined) { others.push(r); continue; }
    const state = routineState(r.id, status);
    const doneAt = state === 'done' ? routineCompletedAt(r.id, status) : null;
    const open = state === 'pending' && end !== undefined && (start ?? 0) <= nowMin && nowMin < end;
    const left = end !== undefined ? end - nowMin : 0;
    const span = Math.max(1, (end ?? 0) - (start ?? 0));
    rows.push({
      key: `r:${r.id}`, min, time: r.windowStart ?? r.windowEnd ?? '', kind: 'routine', title: r.label, routine: r,
      sub: [r.windowStart && r.windowEnd ? `${r.windowStart}–${r.windowEnd}` : r.windowEnd ? `by ${r.windowEnd}` : '', r.category].filter(Boolean).join(' · '),
      right: state === 'done' ? `kept${doneAt ? ` · ${fmtTime(doneAt)}` : ''}` : state === 'missed' ? 'missed' : open ? `closes in ${minsLabel(left)}` : undefined,
      tone: state === 'done' ? 'done' : state === 'missed' ? 'missed' : open && left < 30 ? 'warm' : undefined,
      ring: { state, frac: open ? left / span : state === 'done' ? 1 : 0 },
    });
  }
  // A wake fires in the house's time zone; it is placed at that instant in this day.
  for (const t of auto.tasks ?? []) {
    for (const at of cronRunsToday(t.cronExpr, today, timezone)) {
      rows.push({ key: `w:${t.wakeType}:${at.getTime()}`, min: at.getHours() * 60 + at.getMinutes(), time: fmtTime(at), kind: 'wake', title: t.label, sub: t.enabled ? `${companion} checks in` : 'paused', tone: t.enabled ? undefined : 'off' });
    }
  }
  events.forEach((e, i) => {
    const hm = e.allDay ? null : eventHm(e.time);
    const min = hmToMin(hm ?? undefined);
    if (!hm || min === undefined) return;
    rows.push({ key: `e:${i}`, min, time: hm, kind: 'event', title: e.title, sub: 'calendar' });
  });
  for (const t of auto.timers) {
    if (!t.fireAt || !isToday(t.fireAt)) continue;
    rows.push({ key: `t:${t.id}`, min: t.fireAt.getHours() * 60 + t.fireAt.getMinutes(), time: fmtTime(t.fireAt), kind: 'reminder', title: t.label, sub: 'reminder' });
  }
  rows.sort((a, b) => a.min - b.min || a.title.localeCompare(b.title));
  const nowAt = rows.findIndex(r => r.min > nowMin);
  const nowIndex = nowAt === -1 ? rows.length : nowAt;
  const anytime = [...events.filter(e => e.allDay).map(e => e.title), ...todos.map(t => t.title)];
  const routineRows = rows.filter(r => r.kind === 'routine');
  const kept = routineRows.filter(r => r.tone === 'done').length;

  const nowLine = (
    <li className="cmd-tl-now" key="now" aria-label={`now, ${fmtTime(today)}`}>
      <span className="cmd-tl-time">{fmtTime(today)}</span>
      <span className="cmd-tl-now-dot" aria-hidden="true" />
      <span className="cmd-tl-now-rule" aria-hidden="true" />
    </li>
  );
  return (
    <Panel label="today" meta={routineRows.length > 0 ? `${kept}/${routineRows.length} kept` : undefined}>
      {anytime.length > 0 && (
        <div className="cmd-tl-anytime">
          <span className="cmd-tl-anytime-label">anytime</span>
          {anytime.map((a, i) => <span key={i} className="cmd-tl-pill">{a}</span>)}
        </div>
      )}
      {rows.length === 0 ? (
        <QuietLine>nothing with a time today — add a routine below, or ask {companion} for a reminder.</QuietLine>
      ) : (
        <ol className="cmd-tl">
          {rows.map((r, i) => {
            const isOpen = r.routine && editing === r.routine.id;
            const body = (
              <>
                <span className="cmd-tl-time">{r.time}</span>
                <span className={`cmd-tl-glyph kind-${r.kind}`} aria-hidden="true">
                  {r.ring ? <RoutineRing state={r.ring.state} frac={r.ring.frac} />
                    : r.kind === 'wake' ? <span className="cmd-tl-wake" />
                    : <SectionIcon k={r.kind === 'event' ? 'countdowns' : 'routines'} />}
                </span>
                <span className="cmd-auto-main">
                  <span className="cmd-auto-title">{r.title}</span>
                  <span className="cmd-auto-sub">{r.sub}</span>
                </span>
                {r.right && <span className={`cmd-tl-right${r.tone ? ` ${r.tone}` : ''}`}>{r.right}</span>}
              </>
            );
            return (
              <React.Fragment key={r.key}>
                {i === nowIndex && nowLine}
                <li className={`cmd-tl-row${r.min <= nowMin ? ' past' : ''}${r.tone ? ` ${r.tone}` : ''}`}>
                  {r.routine ? (
                    <button type="button" className="cmd-tl-hit hearth-hover" aria-expanded={!!isOpen} onClick={() => setEditing(isOpen ? null : r.routine!.id)}>{body}</button>
                  ) : <div className="cmd-tl-hit">{body}</div>}
                  {isOpen && r.routine && (
                    <RoutineEditor routine={r.routine} categories={categories} onSaved={onRoutinesChanged} onDeleted={onRoutinesChanged} onClose={() => setEditing(null)} />
                  )}
                </li>
              </React.Fragment>
            );
          })}
          {nowIndex === rows.length && nowLine}
        </ol>
      )}
      {others.length > 0 && (
        <Fold label={`other routines · ${others.length}`}>
          <ul className="cmd-tl-others">
            {others.map(r => {
              const isOpen = editing === r.id;
              const when = r.days === 'daily' || r.days.length === 0 ? 'daily' : r.days.map(d => d.slice(0, 3)).join(', ');
              return (
                <li key={r.id}>
                  <button type="button" className="cmd-tl-hit cmd-tl-other hearth-hover" aria-expanded={isOpen} onClick={() => setEditing(isOpen ? null : r.id)}>
                    <span className="cmd-auto-main">
                      <span className="cmd-auto-title">{r.label}</span>
                      <span className="cmd-auto-sub">{[r.active ? when : 'rested', r.windowEnd ? `by ${r.windowEnd}` : '', r.category].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                  {isOpen && (
                    <RoutineEditor routine={r} categories={categories} onSaved={onRoutinesChanged} onDeleted={onRoutinesChanged} onClose={() => setEditing(null)} />
                  )}
                </li>
              );
            })}
          </ul>
        </Fold>
      )}
      <Fold label="new routine"><RoutineAddRow categories={categories} onChanged={onRoutinesChanged} /></Fold>
    </Panel>
  );
}

export function CommandCenterView() {
  const [overview, setOverview] = useState<Rec | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [cycle, setCycle] = useState<Rec | null>(null);
  const [cycleFailed, setCycleFailed] = useState(false);
  const [routinesData, setRoutinesData] = useState<Rec | null>(null);
  const [routinesFailed, setRoutinesFailed] = useState(false);
  const [winsData, setWinsData] = useState<unknown>(null);
  const [winsFailed, setWinsFailed] = useState(false);
  const [countdownsData, setCountdownsData] = useState<unknown>(null);
  const [countdownsFailed, setCountdownsFailed] = useState(false);
  const [careCategories, setCareCategories] = useState<CareCategoryCfg[] | null>(null);
  const [sections, setSections] = useState<SectionFlags>(ALL_SECTIONS_ON);
  const [orb, setOrb] = useState<OrbState | null>(null);
  // Sanctuary: the companion's room, for the header-ember tooltip only. Defensive —
  // the field may not exist yet; absent = plain tooltip.
  const [companionRoom, setCompanionRoom] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [outlook, setOutlook] = useState<Rec | null>(null);
  const auto = useAutomations();
  const reloadAutomations = auto.reload;
  const identity = useIdentity();
  const companion = identity.companion_name || 'Echo';

  const loadOutlook = useCallback(async () => {
    setOutlook(rec(await apiGet('/api/outlook')) ?? null);
  }, []);
  const loadOverview = useCallback(async () => {
    const data = await apiGet('/api/cc/overview');
    setOverview(rec(data) ?? null);
    setOverviewFailed(data === null);
  }, []);
  const loadCycle = useCallback(async () => {
    const data = await apiGet('/api/cc/cycle');
    setCycle(rec(data) ?? null);
    setCycleFailed(data === null);
  }, []);
  const loadRoutines = useCallback(async () => {
    const data = await apiGet('/api/cc/routines');
    setRoutinesData(rec(data) ?? null);
    setRoutinesFailed(data === null);
  }, []);
  const loadWins = useCallback(async () => {
    const data = await apiGet('/api/cc/wins?days=7');
    setWinsData(data);
    setWinsFailed(data === null);
  }, []);
  const loadCountdowns = useCallback(async () => {
    const data = await apiGet('/api/cc/countdowns');
    setCountdownsData(data);
    setCountdownsFailed(data === null);
  }, []);
  const loadConfig = useCallback(async () => {
    const data = await apiGet('/api/cc/config');
    setCareCategories(normCareCategories(data));
    if (data !== null) setSections(normSections(data));
  }, []);
  const toggleSection = useCallback(async (k: SectionKey, v: boolean) => {
    setSections(prev => ({ ...prev, [k]: v })); // optimistic
    const { ok, body } = await apiSend('/api/cc/config', 'PATCH', { sections: { [k]: v } });
    if (ok) setSections(normSections(body));
    else setSections(prev => ({ ...prev, [k]: !v })); // revert
  }, []);
  const loadMantel = useCallback(async () => {
    const data = rec(await apiGet('/api/home/mantelpiece'));
    const companion = rec(data?.companion);
    if (companion) {
      setOrb({
        color: str(companion.orb_color) ?? 'amber',
        blend: str(companion.orb_blend),
        shape: str(companion.orb_shape),
        motion: str(companion.orb_motion),
        intensity: str(companion.orb_intensity),
      });
      setCompanionRoom(str(companion.room)?.trim() || null);
    }
  }, []);

  const refetchAll = useCallback(() => {
    void loadOverview();
    void loadCycle();
    void loadRoutines();
    void loadWins();
    void loadCountdowns();
    void loadOutlook();
    // A wake that fired is not announced on the socket: its next run moves on only when asked again.
    void reloadAutomations();
  }, [loadOverview, loadCycle, loadRoutines, loadWins, loadCountdowns, loadOutlook, reloadAutomations]);

  // First paint.
  useEffect(() => {
    void loadConfig();
    void loadMantel();
    void loadOutlook();
    void Promise.all([loadOverview(), loadCycle(), loadRoutines(), loadWins(), loadCountdowns()])
      .then(() => setLoaded(true));
  }, [loadConfig, loadMantel, loadOutlook, loadOverview, loadCycle, loadRoutines, loadWins, loadCountdowns]);

  // ONE shared 60s clock — also drives the overview poll + visibilitychange refetch.
  const now = useMinuteClock(refetchAll);

  // Header ember follows the mantelpiece at HomeView's cadence (30s).
  useEffect(() => {
    const t = setInterval(() => { void loadMantel(); }, 30_000);
    return () => clearInterval(t);
  }, [loadMantel]);

  // cc_update WS ripple — refetch the affected slice.
  useEffect(() => {
    const handler = (msg: { type?: string; section?: string }) => {
      if (msg?.type !== 'cc_update') return;
      switch (msg.section) {
        case 'care': void loadOverview(); break;
        case 'routines': void loadRoutines(); void loadOverview(); break;
        case 'cycle': void loadCycle(); void loadOverview(); break;
        case 'wins': void loadWins(); break;
        case 'countdowns': void loadCountdowns(); break;
        default: refetchAll();
      }
    };
    const w = window as unknown as { __sanctumWsListeners?: Array<(m: unknown) => void> };
    if (!w.__sanctumWsListeners) w.__sanctumWsListeners = [];
    w.__sanctumWsListeners.push(handler as (m: unknown) => void);
    return () => {
      w.__sanctumWsListeners = (w.__sanctumWsListeners ?? []).filter(h => h !== (handler as (m: unknown) => void));
    };
  }, [loadOverview, loadCycle, loadRoutines, loadWins, loadCountdowns, refetchAll]);

  // derived — dedicated endpoints win, overview is the fallback
  const cats = careCategories ?? FALLBACK_CARE_CATEGORIES;
  const care = normCare(overview?.care);
  // GET /routines → { routines: CareRoutine[], status: RoutineStatus[] };
  // overview.routines IS the RoutineStatus[] array (routine nested under `routine`).
  const routines = routinesData
    ? normRoutines(routinesData.routines ?? routinesData)
    : normRoutines(overview?.routines);
  const routineStatus = routinesData?.status ?? overview?.routines;
  const wins = winsData !== null ? normWins(winsData) : normWins(overview?.wins);
  const countdowns = countdownsData !== null ? normCountdowns(countdownsData) : normCountdowns(overview?.countdowns);

  const onCareChanged = useCallback(() => { void loadOverview(); }, [loadOverview]);
  const onCycleChanged = useCallback(() => { void loadCycle(); void loadOverview(); }, [loadCycle, loadOverview]);
  const onRoutinesChanged = useCallback(() => { void loadRoutines(); void loadOverview(); }, [loadRoutines, loadOverview]);
  const onWinsChanged = useCallback(() => { void loadWins(); }, [loadWins]);
  const onCountdownsChanged = useCallback(() => { void loadCountdowns(); }, [loadCountdowns]);

  // ── the date line: `Thursday 29 October · day 21 · luteal · care 3/7` ──
  const dateLine = useMemo(() => {
    const parts = [new Date(now).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })];
    if (!loaded) return parts[0];
    const model = buildCycleModel(cycle, overview?.cycle, normHistory(cycle?.history));
    if (!model.noData && model.cycleDay !== undefined) {
      parts.push(`day ${model.cycleDay}`);
      if (model.phase) parts.push(model.phase);
    }
    const todays = care.filter(c => c.time === null || isToday(c.time));
    const done = cats.filter(cat => todays.some(c => c.category.toLowerCase() === cat.key.toLowerCase())).length;
    if (cats.length > 0) parts.push(`care ${done}/${cats.length}`);
    return parts.join(' · ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, cycle, overview, care, cats, now]);

  // Echo's words: the presence the companion authored for the house. Without them, what is next.
  const presence = rec(rec(outlook?.hearth)?.presence);
  const words = str(presence?.thoughts)?.trim() || null;
  const ask = str(presence?.needsUser)?.trim() || null;
  const fallback = useMemo(() => {
    const nowDate = new Date(now);
    const nowMin = nowDate.getHours() * 60 + nowDate.getMinutes();
    const next = routines
      .filter(r => r.active && routineState(r.id, routineStatus) === 'pending')
      .map(r => ({ r, end: hmToMin(r.windowEnd) }))
      .filter((x): x is { r: RoutineItem; end: number } => x.end !== undefined && x.end > nowMin)
      .sort((a, b) => a.end - b.end)[0];
    return next ? `Next: ${next.r.label}, by ${next.r.windowEnd}.` : 'Nothing pressing. The day is yours.';
  }, [routines, routineStatus, now]);
  const day = rec(outlook?.day);
  const events = listOf(day?.events).flatMap(e => {
    const r = rec(e);
    const title = r && str(r.title);
    return r && title ? [{ time: str(r.time) ?? '', title, allDay: bool(r.allDay) === true || str(r.time) === 'all-day' }] : [];
  });
  const todos = listOf(day?.tasks).flatMap(e => {
    const r = rec(e);
    const title = r && str(r.title);
    return r && title ? [{ title, due: str(r.due) }] : [];
  });

  const section = (k: SectionKey, node: React.ReactNode) => sections[k] && (
    <PanelSection.Provider value={{ key: k, hide: () => void toggleSection(k, false) }}>{node}</PanelSection.Provider>
  );
  const anyShown = SECTION_KEYS.some(k => sections[k]);

  return (
    <div className="cmd-view">
      <div className="cmd-inner">
        <DayHeader
          orb={orb}
          room={companionRoom}
          companion={companion}
          words={words}
          ask={ask}
          dateLine={dateLine}
          fallback={loaded ? fallback : null}
          manage={<ManageSections sections={sections} onToggle={(k, v) => void toggleSection(k, v)} />}
        />

        {!loaded ? (
          <div className="cmd-loading" aria-label="loading">
            <span className="cmd-loading-dot" />
          </div>
        ) : (
          <>
            <div className="cmd-daygrid">
              <div className="cmd-daymain">
                {section('routines', (
                  <DayTimeline
                    routines={routines}
                    status={routineStatus}
                    categories={cats}
                    auto={auto}
                    events={events}
                    todos={todos}
                    companion={companion}
                    timezone={identity.timezone ?? null}
                    now={now}
                    onRoutinesChanged={onRoutinesChanged}
                  />
                ))}
                {/* under the day it runs: the house's schedule is looked in on, not worked in, so it stays closed */}
                {section('automations', <AutomationsPanel auto={auto} />)}
              </div>
              <div className="cmd-dayside">
                {section('care', (
                  <CarePanel care={care} categories={cats} failed={overviewFailed} onChanged={onCareChanged} compact />
                ))}
                {section('countdowns', (
                  <CountdownsPanel countdowns={countdowns} failed={countdownsFailed && overviewFailed} onChanged={onCountdownsChanged} compact />
                ))}
                {section('wins', <WinsPanel wins={wins} failed={winsFailed && overviewFailed} onChanged={onWinsChanged} />)}
                {section('cycle', (
                  <CyclePanel
                    cycle={cycle}
                    overviewCycle={overview?.cycle}
                    failed={cycleFailed && overviewFailed}
                    onChanged={onCycleChanged}
                  />
                ))}
              </div>
            </div>

            {!anyShown && <QuietLine>everything here is hidden — Manage sections brings it back.</QuietLine>}
          </>
        )}
      </div>

      <CommandCenterStyles />
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function CommandCenterStyles() {
  return (
    <style>{`
      /* ── Shell ── */
      .cmd-view {
        height: 100%;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }
      .cmd-inner {
        max-width: 92rem;
        margin: 0 auto;
        padding: 1.25rem 1.25rem calc(env(safe-area-inset-bottom, 0px) + 4rem);
        display: flex;
        flex-direction: column;
        gap: 1rem;
        min-width: 0;
      }

      /* ── Header — the orb, the date, the companion's words and its ask; Manage sections at the right. Open onto the
         room, as Home's welcome. ── */
      .cmd-head {
        position: relative;
        display: flex;
        align-items: center;
        gap: 1.1rem;
        padding: 1.25rem clamp(0.5rem, 3vw, 2.5rem) 0.75rem;
        min-width: 0;
        isolation: isolate;
        /* above the panels that follow, so the Manage sections menu opens over them */
        z-index: 5;
      }
      .cmd-head::before {
        content: '';
        position: absolute;
        inset: 0;
        z-index: -1;
        pointer-events: none;
        background: radial-gradient(ellipse 45% 75% at 22% 50%,
          color-mix(in srgb, var(--surface-chrome, #2c1a10) 55%, transparent) 0%,
          color-mix(in srgb, var(--surface-chrome, #2c1a10) 28%, transparent) 50%,
          transparent 75%);
      }
      .cmd-orb-btn {
        background: none;
        border: none;
        padding: 0.35rem;
        cursor: pointer;
        border-radius: 50%;
        flex-shrink: 0;
        display: grid;
        place-items: center;
        align-self: flex-start;
        margin-top: 0.35rem;
      }
      .cmd-head-text { min-width: 0; flex: 1; }
      .cmd-manage { position: relative; align-self: flex-start; flex-shrink: 0; }
      .cmd-manage-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        border-radius: 999px;
        background: var(--chip-bg, var(--surface-chrome, #2c1a10));
        border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 55%, transparent);
        color: var(--menu-ink, var(--surface-chrome-text, #efe4d0));
        font-family: var(--font-serif, 'Lora', serif);
        font-size: 0.95rem;
        cursor: pointer;
      }
      .cmd-manage-btn svg { color: var(--skin-trim, currentColor); }
      .cmd-manage-pop {
        position: absolute;
        right: 0;
        top: calc(100% + 0.5rem);
        z-index: 20;
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        min-width: 15rem;
        padding: 0.75rem 1rem;
        border-radius: 8px;
        background: var(--surface-popover, var(--surface-chrome, #2c1a10));
        border: 1px solid var(--skin-trim, var(--surface-popover-border, rgba(255,255,255,0.2)));
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
        --text-secondary: var(--surface-popover-text, #efe4d0);
      }
      .cmd-manage-note {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.85rem;
        color: var(--surface-popover-text, #efe4d0);
        opacity: 0.85;
        margin-bottom: 0.35rem;
      }

      .cmd-loading {
        display: grid;
        place-items: center;
        padding: 3rem 0;
      }
      .cmd-loading-dot {
        width: 0.375rem;
        height: 0.375rem;
        border-radius: 50%;
        background: var(--amber-dim, #a08960);
        animation: presencePulse 1.4s ease-in-out infinite;
      }

      /* ── Cockpit anatomy ── */

      /* ── Panel ── */
      .cmd-panel {
        background: rgba(255, 255, 255, 0.02);
        border: 1px solid var(--border, rgba(255,255,255,0.06));
        border-radius: var(--radius-card, 1.125rem);
        overflow: hidden;
        min-width: 0;
        position: relative;
        isolation: isolate;
      }
      /* lavender — the user's panels (HomeView user-card treatment) */
      .cmd-panel-lavender {
        background: rgba(168, 147, 192, 0.04);
        border-color: rgba(168, 147, 192, 0.10);
      }
      .cmd-panel-lavender::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        z-index: -1;
        background: radial-gradient(ellipse at center top, rgba(168, 147, 192, 0.04), transparent 70%);
        pointer-events: none;
      }
      /* amber — companion-held structure */
      .cmd-panel-amber {
        background: rgba(201, 168, 124, 0.025);
        border-color: rgba(201, 168, 124, 0.10);
      }
      .cmd-panel-head {
        display: flex;
        align-items: center;
        gap: 0.625rem;
        padding: 0.75rem 1rem 0.6rem;
        border-bottom: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255,255,255,0.4)) 30%, transparent);
      }
      .cmd-panel-icon { display: grid; place-items: center; color: var(--skin-trim, var(--text-secondary, #a09689)); flex-shrink: 0; }
      .cmd-panel-label {
        font-family: var(--font-serif, 'Lora', serif);
        font-size: 1.2rem;
        font-weight: 400;
        color: var(--text-primary, #efe4d0);
        flex: 1;
        min-width: 0;
      }
      /* the Show switch: its word before its track, as in the demo */
      .cmd-panel-head .cmd-switch { flex-direction: row-reverse; }
      .cmd-panel-head .cmd-switch-label { font-size: 0.85rem; }


      /* ── Automations: one row each, the switch (or a cancel) at the end ── */
      .cmd-auto-list { list-style: none; display: flex; flex-direction: column; }
      .cmd-auto-row { display: flex; align-items: center; gap: 0.85rem; padding: 0.6rem 0.15rem; min-width: 0; }
      .cmd-auto-row + .cmd-auto-row { border-top: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255,255,255,0.3)) 22%, transparent); }
      .cmd-auto-icon {
        display: grid;
        place-items: center;
        width: 2.4rem;
        height: 2.4rem;
        flex-shrink: 0;
        border-radius: 4px;
        border: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255,255,255,0.3)) 45%, transparent);
        color: var(--skin-trim, var(--text-secondary, #a09689));
      }
      .cmd-auto-main { display: flex; flex-direction: column; gap: 0.1rem; flex: 1; min-width: 0; }
      .cmd-auto-title { font-family: var(--font-serif, 'Lora', serif); font-size: 1rem; color: var(--text-primary, #efe4d0); }
      .cmd-auto-sub { font-size: 0.82rem; color: var(--text-secondary, #dccfb8); }
      .cmd-auto-when { font-size: 0.82rem; color: var(--text-secondary, #dccfb8); white-space: nowrap; text-align: right; }
      .cmd-auto-row.off .cmd-auto-title, .cmd-auto-row.off .cmd-auto-icon { opacity: 0.6; }
      /* closed: one line, the next thing due and how many there are; the whole line opens the list */
      .cmd-auto-summary {
        display: flex;
        align-items: center;
        gap: 0.85rem;
        width: 100%;
        min-width: 0;
        padding: 0.35rem 0.15rem;
        background: none;
        border: 0;
        border-radius: 4px;
        color: inherit;
        text-align: left;
        cursor: pointer;
        transition: background 150ms ease;
      }
      .cmd-auto-summary:hover { background: var(--chrome-hover-wash, rgba(239, 228, 208, 0.10)); }
      .cmd-auto-summary[aria-expanded="true"] { margin-bottom: 0.35rem; }
      .cmd-auto-summary[aria-expanded="true"] + .cmd-auto-list { border-top: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255,255,255,0.3)) 22%, transparent); }
      .cmd-auto-more {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        flex-shrink: 0;
        font-size: 0.85rem;
        color: var(--text-primary, #efe4d0);
        white-space: nowrap;
      }
      .cmd-auto-more svg { color: var(--skin-trim, currentColor); }

      /* ── The day: Echo's words on the room, the timeline, the side column ── */
      .cmd-dayhead .horb { --orb-d: 84px; }
      /* orb, words, Manage sections in a row; the ask under the words (centred across the header on a phone) */
      .cmd-dayhead { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; column-gap: 1.1rem; row-gap: 0; }
      .cmd-dayhead > .cmd-orb-btn { grid-column: 1; grid-row: 1; }
      .cmd-dayhead > .cmd-head-text { grid-column: 2; grid-row: 1; }
      .cmd-dayhead > .cmd-manage { grid-column: 3; grid-row: 1; }
      .cmd-dayhead > .cmd-dayhead-ask { grid-column: 2; grid-row: 2; justify-self: start; }
      /* Echo's words sit on the room: a soft shade of the chrome behind them, so a bright patch of the painting (a moon,
         a window) never comes through the letters */
      .cmd-dayhead .cmd-head-text { position: relative; isolation: isolate; }
      .cmd-dayhead .cmd-head-text::before {
        content: '';
        position: absolute;
        inset: -1.25rem -3rem -1.25rem -2rem;
        z-index: -1;
        pointer-events: none;
        background: radial-gradient(ellipse closest-side at 42% 50%,
          color-mix(in srgb, var(--surface-chrome, #2c1a10) 78%, transparent) 0%,
          color-mix(in srgb, var(--surface-chrome, #2c1a10) 60%, transparent) 55%,
          transparent 100%);
      }
      .cmd-dayhead-date {
        font: 600 clamp(1.7rem, 2.6vw, 2.25rem)/1.1 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
        color: var(--home-head-text, #f6eedb);
        text-shadow: 0 2px 18px rgba(0, 0, 0, 0.85), 0 1px 3px rgba(0, 0, 0, 0.7);
      }
      .cmd-dayhead-date span { white-space: nowrap; }
      .cmd-dayhead-words { margin: 0.55rem 0 0; max-width: 48rem; }
      .cmd-dayhead-words p {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: clamp(1.08rem, 1.45vw, 1.28rem);
        line-height: 1.45;
        color: var(--home-head-text, #f6eedb);
        text-shadow: 0 1px 10px rgba(0, 0, 0, 0.9), 0 1px 2px rgba(0, 0, 0, 0.7);
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .cmd-dayhead-words figcaption {
        margin-top: 0.3rem;
        font-family: var(--font-serif, 'Lora', serif);
        font-size: 0.9rem;
        color: var(--home-head-text, #f6eedb);
        text-shadow: 0 1px 8px rgba(0, 0, 0, 0.85);
      }
      .cmd-dayhead-next {
        margin-top: 0.5rem;
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 1.1rem;
        color: var(--home-head-text, #f6eedb);
        text-shadow: 0 1px 10px rgba(0, 0, 0, 0.9);
      }
      .cmd-dayhead-ask {
        display: inline-flex;
        align-items: baseline;
        gap: 0.5rem;
        margin-top: 0.7rem;
        padding: 0.3rem 0.8rem;
        border-radius: 999px;
        background: var(--chip-bg, var(--surface-chrome, #2c1a10));
        border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 55%, transparent);
        color: var(--chip-text, var(--surface-chrome-text, #efe4d0));
        font-family: var(--font-serif, 'Lora', serif);
        font-size: 0.92rem;
      }
      .cmd-dayhead-ask span { font-weight: 600; white-space: nowrap; }

      .cmd-daygrid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(19rem, 1fr); gap: 1rem; align-items: start; min-width: 0; }
      .cmd-daymain, .cmd-dayside { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }

      /* the timeline: time, a glyph on one gilt thread, what it is, how it stands */
      .cmd-tl { position: relative; list-style: none; margin: 0; padding: 0.15rem 0; }
      .cmd-tl::before {
        content: '';
        position: absolute;
        top: 1.1rem;
        bottom: 1.1rem;
        left: calc(0.25rem + 3.4rem + 0.75rem + 1rem - 0.5px);
        width: 1px;
        background: color-mix(in srgb, var(--skin-trim, #c9a87c) 45%, transparent);
      }
      .cmd-tl-hit {
        display: grid;
        grid-template-columns: 3.4rem 2rem minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.75rem;
        width: 100%;
        padding: 0.45rem 0.25rem;
        background: none;
        border: 0;
        border-radius: 4px;
        color: inherit;
        text-align: left;
        font: inherit;
      }
      button.cmd-tl-hit { cursor: pointer; }
      button.cmd-tl-hit:hover { background: var(--chrome-hover-wash, rgba(239, 228, 208, 0.10)); }
      .cmd-tl-time {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.8rem;
        color: var(--text-secondary, #dccfb8);
        text-align: right;
      }
      .cmd-tl-glyph {
        position: relative;
        z-index: 1;
        display: grid;
        place-items: center;
        width: 2rem;
        height: 2rem;
        border-radius: 50%;
        background: var(--surface-chrome-deep, var(--surface-chrome, #2c1a10));
        border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 55%, transparent);
        color: var(--skin-trim, var(--text-secondary, #a09689));
      }
      .cmd-tl-glyph svg { width: 16px; height: 16px; }
      .cmd-tl-wake {
        width: 0.7rem;
        height: 0.7rem;
        border-radius: 50%;
        background: radial-gradient(circle at 40% 35%, #fff6dc 0%, var(--skin-trim, #d4a843) 60%);
        box-shadow: 0 0 8px color-mix(in srgb, var(--skin-trim, #d4a843) 80%, transparent);
      }
      .cmd-tl-row.off .cmd-tl-wake { background: var(--text-muted, #a09689); box-shadow: none; }
      .cmd-tl-right { font-size: 0.82rem; color: var(--text-secondary, #dccfb8); white-space: nowrap; text-align: right; }
      .cmd-tl-right.done::before { content: '✓ '; color: var(--skin-trim, currentColor); }
      .cmd-tl-right.warm { color: var(--text-primary, #efe4d0); font-weight: 600; }
      /* past: the muted ink the contrast gate already holds on every texture, never a fade */
      .cmd-tl-row.past .cmd-auto-title, .cmd-tl-row.off .cmd-auto-title { color: var(--text-muted, #a09689); }
      .cmd-tl-row.past .cmd-tl-glyph { border-color: color-mix(in srgb, var(--skin-trim, #c9a87c) 30%, transparent); }
      .cmd-tl-row .cmd-routine-editor, .cmd-tl-row > :not(.cmd-tl-hit) { margin: 0.1rem 0 0.5rem calc(3.4rem + 2rem + 1.5rem); }
      .cmd-tl-now {
        position: relative;
        display: grid;
        grid-template-columns: 3.4rem 2rem minmax(0, 1fr);
        align-items: center;
        gap: 0.75rem;
        padding: 0.15rem 0.25rem;
      }
      .cmd-tl-now .cmd-tl-time { color: var(--text-primary, #efe4d0); font-weight: 600; }
      .cmd-tl-now-dot {
        position: relative;
        z-index: 1;
        justify-self: center;
        width: 0.65rem;
        height: 0.65rem;
        border-radius: 50%;
        background: var(--skin-trim, #d4a843);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--skin-trim, #d4a843) 30%, transparent);
      }
      .cmd-tl-now-rule { height: 1.5px; background: linear-gradient(90deg, var(--skin-trim, #d4a843), color-mix(in srgb, var(--skin-trim, #d4a843) 10%, transparent)); }
      .cmd-tl-anytime {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.4rem;
        padding: 0.1rem 0.25rem 0.75rem;
        margin-bottom: 0.4rem;
        border-bottom: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255,255,255,0.3)) 22%, transparent);
      }
      .cmd-tl-anytime-label {
        width: 3.4rem;
        text-align: right;
        margin-right: 0.35rem;
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.7rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-muted, #a09689);
      }
      .cmd-tl-pill {
        padding: 0.2rem 0.6rem;
        border-radius: 4px;
        border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 45%, transparent);
        font-size: 0.88rem;
        color: var(--text-primary, #efe4d0);
      }

      .cmd-tl-others { list-style: none; margin: 0; padding: 0; }
      .cmd-tl-other { grid-template-columns: minmax(0, 1fr); }
      .cmd-tl-others > li > :not(.cmd-tl-hit) { margin: 0.1rem 0 0.5rem; }

      /* folded: an add form or a day's log behind a "+" */
      .cmd-fold { margin-top: 0.55rem; }
      .cmd-fold-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.3rem 0.5rem 0.3rem 0.25rem;
        background: none;
        border: 0;
        border-radius: 4px;
        color: var(--text-secondary, #dccfb8);
        font-family: var(--font-serif, 'Lora', serif);
        font-size: 0.9rem;
        cursor: pointer;
      }
      .cmd-fold-btn:hover { background: var(--chrome-hover-wash, rgba(239, 228, 208, 0.10)); }
      .cmd-fold-mark {
        display: grid;
        place-items: center;
        width: 1.25rem;
        height: 1.25rem;
        border-radius: 50%;
        border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 70%, transparent);
        color: var(--skin-trim, currentColor);
        line-height: 1;
      }
      .cmd-fold-body { margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.6rem; }
      @media (max-width: 1100px) {
        .cmd-daygrid { grid-template-columns: minmax(0, 1fr); }
      }
      .cmd-panel-lavender .cmd-panel-label { color: var(--lavender-dim, #8a78a0); }
      .cmd-panel-meta {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
      }
      .cmd-panel-body {
        padding: 0.875rem 1rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.875rem;
        min-width: 0;
      }

      .cmd-quiet {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.875rem;
        color: var(--text-muted, #6a6258);
        line-height: 1.5;
      }
      .dim { opacity: 0.45; }
      .cmd-notice {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.8125rem;
        color: var(--amber-dim, #a08960);
        animation: bannerFadeIn 200ms var(--hearth-curve, ease) both;
      }

      /* ── One-shot pulses (snapshot-diff) + shimmer ── */
      @keyframes cmdPulseLav {
        0%   { background-color: rgba(168, 147, 192, 0.16); }
        100% { background-color: transparent; }
      }
      @keyframes cmdPulseGold {
        0%   { background-color: rgba(224, 190, 120, 0.18); }
        100% { background-color: transparent; }
      }
      @keyframes cmdShimmer {
        0%   { background-position: -200% 0; }
        100% { background-position: 200% 0; }
      }
      .cmd-pulse { animation: hearthPulse 1.2s var(--hearth-curve, ease); border-radius: 0.375rem; }
      .cmd-pulse-lav { animation: cmdPulseLav 1.2s var(--hearth-curve, ease); border-radius: 0.375rem; }
      .cmd-pulse-gold { animation: cmdPulseGold 1.4s var(--hearth-curve, ease); border-radius: 0.625rem; }
      .cmd-shimmer {
        background-image: linear-gradient(100deg, transparent 30%, rgba(224, 190, 120, 0.10) 50%, transparent 70%);
        background-size: 200% 100%;
        animation: cmdShimmer 2.2s ease 2;
        border-radius: 0.375rem;
      }

      /* ── Inputs / buttons ── */
      .cmd-input {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.875rem;
        color: var(--text-primary, #e2dbd0);
        background: var(--bg-input, #0f0e0c);
        border: 1px solid var(--border, rgba(255,255,255,0.06));
        border-radius: 0.5rem;
        padding: 0.5rem 0.625rem;
        min-width: 0;
        transition: border-color var(--tx-color, 150ms);
      }
      .cmd-input:focus {
        outline: none;
        border-color: rgba(201, 168, 124, 0.35);
      }
      .cmd-input::placeholder { color: var(--text-muted, #6a6258); }

      .cmd-btn {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.8125rem;
        color: var(--text-secondary, #a09689);
        background: rgba(255,255,255,0.03);
        border: 1px solid var(--border, rgba(255,255,255,0.06));
        border-radius: 0.5rem;
        padding: 0.5rem 0.875rem;
        min-height: 2.375rem;
        cursor: pointer;
        flex-shrink: 0;
        transition: border-color var(--tx-color, 150ms), color var(--tx-color, 150ms), background var(--tx-color, 150ms);
      }
      .cmd-btn:hover:not(:disabled) {
        border-color: var(--border-hover, rgba(255,255,255,0.12));
        color: var(--text-primary, #e2dbd0);
      }
      .cmd-btn:disabled { color: var(--text-muted, #6a6258); border-color: transparent; cursor: default; }
      .cmd-btn-amber {
        color: var(--amber, #c9a87c);
        background: rgba(201, 168, 124, 0.07);
        border-color: rgba(201, 168, 124, 0.2);
      }
      .cmd-btn-amber:hover:not(:disabled) {
        color: var(--amber-bright, #e3c49a);
        border-color: rgba(201, 168, 124, 0.35);
      }
      .cmd-btn-rose {
        color: #d4849a;
        background: rgba(201, 122, 143, 0.07);
        border-color: rgba(201, 122, 143, 0.25);
      }
      .cmd-btn-rose:hover:not(:disabled) { border-color: rgba(201, 122, 143, 0.45); color: #e39cb0; }
      .cmd-btn-danger {
        color: #c0524a;
        border-color: rgba(192, 82, 74, 0.25);
        background: rgba(192, 82, 74, 0.05);
      }
      .cmd-btn-danger:hover:not(:disabled) { border-color: rgba(192, 82, 74, 0.45); color: #d4675f; }

      .cmd-mini-btn {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        background: none;
        border: 1px solid rgba(255,255,255,0.07);
        border-radius: 0.3rem;
        padding: 0.2rem 0.45rem;
        cursor: pointer;
        flex-shrink: 0;
        transition: color var(--tx-color, 150ms), border-color var(--tx-color, 150ms);
      }
      .cmd-mini-btn:hover { color: var(--amber, #c9a87c); border-color: rgba(201, 168, 124, 0.3); }

      .cmd-x {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.9375rem;
        line-height: 1;
        color: var(--text-muted, #6a6258);
        background: none;
        border: none;
        cursor: pointer;
        padding: 0.25rem 0.375rem;
        border-radius: 0.375rem;
        flex-shrink: 0;
        opacity: 0.5;
        transition: color var(--tx-color, 150ms), opacity var(--tx-color, 150ms);
      }
      .cmd-x:hover { color: #c0524a; opacity: 1; }

      .cmd-add-row {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        min-width: 0;
        flex-wrap: wrap;
      }
      .cmd-add-cat { flex: 0 1 9rem; }
      .cmd-add-note { flex: 1 1 10rem; }

      .cmd-confirm {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        flex-wrap: wrap;
        animation: bannerFadeIn 200ms var(--hearth-curve, ease) both;
      }
      .cmd-confirm-q {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.8125rem;
        color: var(--text-secondary, #a09689);
      }

      /* ── Stepper (replaces number spinners) ── */
      .cmd-stepper {
        display: inline-flex;
        align-items: center;
        gap: 0.125rem;
        background: var(--bg-input, #0f0e0c);
        border: 1px solid var(--border, rgba(255,255,255,0.06));
        border-radius: 0.5rem;
        padding: 0.125rem;
      }
      .cmd-stepper-btn {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.875rem;
        color: var(--text-muted, #6a6258);
        background: none;
        border: none;
        border-radius: 0.375rem;
        width: 1.75rem;
        height: 1.75rem;
        cursor: pointer;
        transition: color var(--tx-color, 150ms), background var(--tx-color, 150ms);
      }
      .cmd-stepper-btn:hover { color: var(--amber, #c9a87c); background: rgba(201, 168, 124, 0.07); }
      .cmd-stepper-val {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.8125rem;
        color: var(--text-primary, #e2dbd0);
        min-width: 1.75rem;
        text-align: center;
      }
      .cmd-stepper-unit {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        padding: 0 0.45rem 0 0.25rem;
      }

      /* ── Switch (replaces the native checkbox) ── */
      .cmd-switch {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        background: none;
        border: none;
        padding: 0.25rem 0;
        cursor: pointer;
      }
      .cmd-switch-track {
        width: 1.875rem;
        height: 1.125rem;
        border-radius: 0.5625rem;
        background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.08);
        position: relative;
        transition: background var(--tx-color, 150ms), border-color var(--tx-color, 150ms);
        flex-shrink: 0;
      }
      .cmd-switch-knob {
        position: absolute;
        top: 1px;
        left: 1px;
        width: 0.875rem;
        height: 0.875rem;
        border-radius: 50%;
        background: var(--text-muted, #6a6258);
        transition: transform var(--tx-motion, 160ms), background var(--tx-color, 150ms);
      }
      .cmd-switch.on .cmd-switch-track {
        background: rgba(201, 168, 124, 0.18);
        border-color: rgba(201, 168, 124, 0.35);
      }
      .cmd-switch.on .cmd-switch-knob {
        transform: translateX(0.75rem);
        background: var(--amber, #c9a87c);
        box-shadow: 0 0 6px rgba(201, 168, 124, 0.4);
      }
      .cmd-switch-label {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.8125rem;
        color: var(--text-secondary, #a09689);
      }

      /* ── Chips (shared) ── */
      .cmd-chip {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.75rem;
        color: var(--text-muted, #6a6258);
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 0.5rem;
        padding: 0.375rem 0.625rem;
        cursor: pointer;
        transition: border-color var(--tx-color, 150ms), color var(--tx-color, 150ms), background var(--tx-color, 150ms);
      }
      .cmd-chip:hover { border-color: rgba(201, 168, 124, 0.25); color: var(--text-secondary, #a09689); }
      .cmd-chip-selected {
        color: var(--amber, #c9a87c);
        background: rgba(201, 168, 124, 0.08);
        border-color: rgba(201, 168, 124, 0.28);
      }

      /* ── Pills ── */
      .cmd-pill {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        padding: 0.175rem 0.45rem;
        border-radius: 0.75rem;
        border: 1px solid transparent;
      }
      .cmd-pill-lav {
        color: var(--lavender, #a893c0);
        background: rgba(168, 147, 192, 0.08);
        border-color: rgba(168, 147, 192, 0.2);
      }
      /* fertile is LOUD — teal-gold (ovulation/fertile bright, PMS quiet) */
      .cmd-pill-fertile {
        color: #8fd6c8;
        background: linear-gradient(100deg, rgba(94, 171, 165, 0.16), rgba(196, 168, 114, 0.16));
        border-color: rgba(94, 171, 165, 0.45);
        text-shadow: 0 0 8px rgba(94, 171, 165, 0.4);
      }

      /* ── Cycle hearth-band ── */
      .cmd-band {
        border-radius: 0.875rem;
        padding: 0.875rem 1rem 0.75rem;
        border: 1px solid rgba(255,255,255,0.05);
        background: rgba(255,255,255,0.015);
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-width: 0;
        transition: background var(--tx-slow, 420ms), border-color var(--tx-slow, 420ms);
      }
      /* period — rose-ember with the border breath (the only continuous
         motion here besides the header ember) */
      @keyframes cmdBandBreath {
        0%, 100% { border-color: rgba(184, 50, 74, 0.22); box-shadow: 0 0 14px rgba(184, 50, 74, 0.07); }
        50%       { border-color: rgba(184, 50, 74, 0.48); box-shadow: 0 0 26px rgba(184, 50, 74, 0.16); }
      }
      .cmd-band-period {
        background: linear-gradient(135deg, rgba(184, 50, 74, 0.12), rgba(201, 122, 143, 0.05));
        animation: cmdBandBreath 7s var(--hearth-curve, ease) infinite;
      }
      /* follicular — teal rising into amber */
      .cmd-band-follicular {
        background: linear-gradient(100deg, rgba(94, 171, 165, 0.09), rgba(201, 168, 124, 0.09));
        border-color: rgba(94, 171, 165, 0.2);
      }
      /* ovulation — GOLD, loud */
      .cmd-band-ovulation {
        background: rgba(196, 168, 114, 0.13);
        border-color: rgba(224, 190, 120, 0.5);
        box-shadow: 0 0 26px rgba(224, 190, 120, 0.14), inset 0 0 32px rgba(224, 190, 120, 0.05);
      }
      /* luteal — amber settling into lavender, quiet */
      .cmd-band-luteal {
        background: linear-gradient(100deg, rgba(201, 168, 124, 0.06), rgba(168, 147, 192, 0.07));
        border-color: rgba(168, 147, 192, 0.14);
      }
      /* PMS overlay — lavender deepening; present, never alarmed */
      .cmd-band-pms {
        box-shadow: inset 0 0 42px rgba(168, 147, 192, 0.12);
        border-color: rgba(168, 147, 192, 0.24);
      }
      .cmd-band-nodata {
        background: rgba(255,255,255,0.012);
        border-style: dashed;
        border-color: rgba(255,255,255,0.08);
      }
      .cmd-band-cold { padding: 0.375rem 0 0.125rem; }
      .cmd-band-cold-line {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.9rem;
        color: var(--text-muted, #6a6258);
        line-height: 1.5;
      }

      .cmd-band-row {
        display: flex;
        align-items: baseline;
        gap: 0.875rem;
        flex-wrap: wrap;
        min-width: 0;
      }
      .cmd-band-day {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-weight: 500;
        font-size: 2.5rem;
        line-height: 1;
        color: var(--text-primary, #e2dbd0);
        flex-shrink: 0;
      }
      .cmd-band-ovulation .cmd-band-day {
        color: #e8cf96;
        text-shadow: 0 0 16px rgba(224, 190, 120, 0.45);
      }
      .cmd-band-period .cmd-band-day { color: #e0a4b2; }
      .cmd-band-facts {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        min-width: 0;
      }
      .cmd-band-phase {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.875rem;
        color: var(--text-secondary, #a09689);
      }
      .cmd-band-phase.gold { color: #e0be78; }
      .cmd-band-pills {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .cmd-band-next {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.625rem;
        letter-spacing: 0.04em;
        color: var(--text-muted, #6a6258);
      }
      .cmd-band-next.late { color: #d4675f; }

      /* ── Horizon strip ── */
      .cmd-strip {
        display: flex;
        align-items: center;
        gap: 0.125rem;
        overflow-x: auto;
        padding: 0.375rem 0.125rem 0.25rem;
        min-width: 0;
      }
      .cmd-day {
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        width: 1.05rem;
        height: 1.75rem;
        display: grid;
        place-items: center;
        cursor: pointer;
        flex-shrink: 0;
      }
      .cmd-day-dot {
        width: 0.4375rem;
        height: 0.4375rem;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.10);
        transition: transform var(--tx-motion, 160ms), box-shadow var(--tx-motion, 160ms);
      }
      .cmd-day:hover .cmd-day-dot { transform: scale(1.4); }
      .cmd-day-dot.elapsed { background: rgba(226, 219, 208, 0.30); }
      .cmd-day-dot.period { background: rgba(201, 122, 143, 0.60); }
      .cmd-day-dot.period.elapsed { background: rgba(201, 122, 143, 0.75); }
      /* fertile span — LOUD teal-gold */
      .cmd-day-dot.fertile {
        width: 0.5rem;
        height: 0.5rem;
        background: linear-gradient(135deg, #5eaba5, #c4a872);
        box-shadow: 0 0 6px rgba(94, 171, 165, 0.55);
      }
      /* ovulation — the gold crown */
      .cmd-day-dot.ovu {
        width: 0.625rem;
        height: 0.625rem;
        background: #e0be78;
        box-shadow: 0 0 10px rgba(224, 190, 120, 0.75), 0 0 3px rgba(224, 190, 120, 0.9);
      }
      /* pms — soft lavender, quiet */
      .cmd-day-dot.pms { background: rgba(168, 147, 192, 0.40); }
      .cmd-day-dot.today {
        width: 0.625rem;
        height: 0.625rem;
        background: var(--amber-bright, #e3c49a);
        box-shadow: 0 0 8px rgba(227, 196, 154, 0.8), 0 0 0 2px rgba(227, 196, 154, 0.25);
      }
      .cmd-day-dot.today.period { background: #e0a4b2; box-shadow: 0 0 8px rgba(224, 164, 178, 0.8), 0 0 0 2px rgba(224, 164, 178, 0.3); }
      .cmd-day-dot.today.ovu { background: #e0be78; box-shadow: 0 0 12px rgba(224, 190, 120, 0.95), 0 0 0 2px rgba(224, 190, 120, 0.35); }
      .cmd-day-dot.selected { outline: 1.5px solid rgba(226, 219, 208, 0.5); outline-offset: 2px; }
      .cmd-strip-next {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        margin-left: 0.375rem;
        flex-shrink: 0;
      }
      .cmd-strip-tick {
        width: 2px;
        height: 1rem;
        border-radius: 1px;
        background: #b8324a;
        box-shadow: 0 0 6px rgba(184, 50, 74, 0.6);
      }
      .cmd-strip-next-date {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.04em;
        color: #c0524a;
        white-space: nowrap;
      }
      .cmd-strip-ghost { pointer-events: none; }
      .cmd-day-ghost {
        width: 0.4375rem;
        height: 0.4375rem;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.05);
        margin: 0 0.3rem 0 0;
        flex-shrink: 0;
      }
      .cmd-strip-hint {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.05em;
        color: var(--text-muted, #6a6258);
        opacity: 0.75;
      }

      /* ── Day popover ── */
      .cmd-day-pop {
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
        padding: 0.75rem;
        background: rgba(168, 147, 192, 0.045);
        border: 1px solid rgba(168, 147, 192, 0.18);
        border-radius: 0.75rem;
        animation: bannerFadeIn 200ms var(--hearth-curve, ease) both;
        min-width: 0;
      }
      .cmd-day-pop-head {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
      }
      .cmd-day-pop-date {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.9375rem;
        color: var(--lavender-bright, #c4b5e3);
        flex: 1;
      }
      .cmd-day-pop-actions {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .cmd-day-pop-log {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
        min-width: 0;
      }
      .cmd-day-pop-note { flex: 1 1 9rem; }
      .cmd-flow-chips { display: flex; gap: 0.3rem; flex-wrap: wrap; }

      /* ── Cycle actions / predict / history / settings ── */
      .cmd-cycle-actions { display: flex; gap: 0.5rem; }
      .cmd-big-btn {
        flex: 1;
        min-height: 2.75rem;
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.9375rem;
        font-weight: 500;
        color: var(--amber, #c9a87c);
        background: rgba(201, 168, 124, 0.06);
        border: 1px solid rgba(201, 168, 124, 0.22);
        border-radius: 0.75rem;
        cursor: pointer;
        transition: border-color var(--tx-color, 150ms), background var(--tx-color, 150ms), color var(--tx-color, 150ms);
      }
      .cmd-big-btn:hover:not(:disabled) {
        color: var(--amber-bright, #e3c49a);
        border-color: rgba(201, 168, 124, 0.4);
        background: rgba(201, 168, 124, 0.09);
      }
      .cmd-big-btn-rose {
        color: #d4849a;
        background: rgba(201, 122, 143, 0.06);
        border-color: rgba(201, 122, 143, 0.22);
      }
      .cmd-big-btn-rose:hover:not(:disabled) {
        color: #e39cb0;
        border-color: rgba(201, 122, 143, 0.4);
        background: rgba(201, 122, 143, 0.09);
      }

      .cmd-predict {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 0.625rem 0.75rem;
        background: rgba(255,255,255,0.015);
        border: 1px solid rgba(255,255,255,0.04);
        border-radius: 0.625rem;
      }
      .cmd-predict-row {
        display: flex;
        align-items: baseline;
        gap: 0.75rem;
      }
      .cmd-predict-key {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        width: 6.5rem;
        flex-shrink: 0;
      }
      .cmd-predict-val {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.75rem;
        color: var(--text-secondary, #a09689);
      }
      .cmd-predict-val.gold { color: #e0be78; }
      .cmd-predict-conf {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.75rem;
        color: var(--text-muted, #6a6258);
        margin-top: 0.125rem;
      }

      .cmd-details {
        border-top: 1px solid rgba(255,255,255,0.04);
        padding-top: 0.625rem;
      }
      .cmd-details-summary {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.625rem;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
        cursor: pointer;
        list-style: none;
        transition: color var(--tx-color, 150ms);
      }
      .cmd-details-summary:hover { color: var(--text-secondary, #a09689); }
      .cmd-details-summary::-webkit-details-marker { display: none; }
      .cmd-details-summary::before { content: '› '; }
      .cmd-details[open] .cmd-details-summary::before { content: '⌄ '; }
      .cmd-details-body {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding-top: 0.625rem;
      }

      .cmd-history { display: flex; flex-direction: column; }
      .cmd-history-item { border-bottom: 1px solid rgba(255,255,255,0.03); }
      .cmd-history-item:last-child { border-bottom: none; }
      .cmd-history-row {
        display: flex;
        align-items: baseline;
        gap: 0.75rem;
        padding: 0.35rem 0;
        min-width: 0;
      }
      .cmd-history-row .cmd-mini-btn { opacity: 0; margin-left: auto; }
      .cmd-history-row:hover .cmd-mini-btn { opacity: 1; }
      .cmd-history-date {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.6875rem;
        color: var(--text-muted, #6a6258);
        flex-shrink: 0;
      }
      .cmd-history-len {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.8125rem;
        color: var(--text-secondary, #a09689);
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .cmd-row-editor {
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
        padding: 0.625rem;
        margin-bottom: 0.5rem;
        background: rgba(255,255,255,0.015);
        border: 1px solid rgba(255,255,255,0.05);
        border-radius: 0.625rem;
        animation: bannerFadeIn 200ms var(--hearth-curve, ease) both;
      }
      .cmd-row-editor-fields {
        display: flex;
        gap: 0.625rem;
        flex-wrap: wrap;
        align-items: flex-end;
        min-width: 0;
      }
      .cmd-row-editor-btns {
        display: flex;
        gap: 0.375rem;
        justify-content: flex-end;
        flex-wrap: wrap;
      }

      .cmd-cycle-settings { display: flex; gap: 1.25rem; flex-wrap: wrap; }
      .cmd-setting { display: flex; align-items: center; gap: 0.5rem; }
      .cmd-setting-key {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.625rem;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
      }

      /* ── Care day-arc ── */
      .cmd-care-arc {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-width: 0;
      }
      /* the care tiles: a glyph in the skin's metal over its name; a tap logs it */
      .cmd-care-chips {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
        gap: 0.6rem;
      }
      .cmd-care-chip {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        min-height: 6rem;
        padding: 0.85rem 0.5rem 0.7rem;
        border-radius: 6px;
        font-family: var(--font-serif, 'Lora', serif);
        font-size: 1rem;
        color: var(--text-primary, #efe4d0);
        background: color-mix(in srgb, var(--surface-chrome-deep, #2c1a10) 55%, transparent);
        border: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255,255,255,0.3)) 40%, transparent);
        cursor: pointer;
        transition: border-color var(--tx-color, 150ms), background var(--tx-color, 150ms);
      }
      .cmd-care-chip:hover:not(:disabled) {
        border-color: var(--skin-trim, rgba(201, 168, 124, 0.5));
        background: var(--chrome-hover-wash, rgba(239, 228, 208, 0.10));
      }
      .cmd-care-chip-icon { display: grid; place-items: center; color: var(--skin-trim, var(--amber, #c9a87c)); }
      .cmd-care-chip.done { border-color: var(--skin-trim, rgba(201, 168, 124, 0.6)); }
      .cmd-care-chip.met { box-shadow: 0 0 0 1px var(--skin-trim, rgba(224, 190, 120, 0.4)), 0 0 10px color-mix(in srgb, var(--skin-trim, #e0be78) 25%, transparent); }
      .cmd-care-chip-mark {
        position: absolute;
        top: 0.35rem;
        right: 0.45rem;
        font-size: 0.8rem;
        color: var(--skin-trim, var(--amber, #c9a87c));
      }
      .cmd-care-chip-time, .cmd-care-chip-count {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.7rem;
        letter-spacing: 0.03em;
        color: var(--text-secondary, #dccfb8);
      }
      /* the ember track — lit as far as the day has been kept */
      .cmd-arc-track {
        height: 3px;
        border-radius: 2px;
        background: rgba(255,255,255,0.04);
        overflow: hidden;
      }
      .cmd-arc-fill {
        height: 100%;
        border-radius: 2px;
        background: linear-gradient(90deg, rgba(160, 137, 96, 0.7), var(--amber, #c9a87c));
        box-shadow: 0 0 8px rgba(201, 168, 124, 0.4);
        transition: width var(--tx-slow, 420ms);
      }
      .cmd-arc-track.full .cmd-arc-fill {
        background: linear-gradient(90deg, var(--amber, #c9a87c), #e0be78);
        box-shadow: 0 0 12px rgba(224, 190, 120, 0.55);
      }
      /* the 7/7 crest — gold, once */
      @keyframes crestIn {
        0%   { opacity: 0; transform: scale(0.6); }
        45%  { opacity: 1; transform: scale(1.18); }
        100% { opacity: 1; transform: scale(1); }
      }
      .cmd-crest {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #e0be78;
        text-shadow: 0 0 10px rgba(224, 190, 120, 0.55);
        animation: crestIn 1.4s var(--hearth-curve, ease) both;
        flex-shrink: 0;
      }

      .cmd-care-list { display: flex; flex-direction: column; }
      .cmd-care-row {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        padding: 0.3rem 0.25rem;
        border-bottom: 1px solid rgba(255,255,255,0.03);
        min-width: 0;
      }
      .cmd-care-row:last-child { border-bottom: none; }
      .cmd-care-row .cmd-x { opacity: 0; }
      .cmd-care-row:hover .cmd-x { opacity: 0.6; }
      .cmd-care-row-cat {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.8125rem;
        color: var(--text-secondary, #a09689);
        flex-shrink: 0;
      }
      .cmd-care-row-val {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.6875rem;
        color: var(--amber-dim, #a08960);
        flex-shrink: 0;
      }
      .cmd-care-row-note {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.8125rem;
        color: var(--text-muted, #6a6258);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cmd-care-row-time {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        color: var(--text-muted, #6a6258);
        flex-shrink: 0;
        margin-left: auto;
        white-space: nowrap;
      }

      /* ── Routine rings (the timeline's) ── */
      .cmd-ring {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        position: relative;
        flex-shrink: 0;
        background: rgba(255,255,255,0.08);
      }
      .cmd-ring-core {
        position: absolute;
        inset: 3px;
        border-radius: 50%;
        background: var(--bg-primary, #0c0b09);
      }
      .cmd-ring-done {
        background: var(--amber, #c9a87c);
        box-shadow: 0 0 6px rgba(201, 168, 124, 0.45);
      }
      .cmd-ring-missed { background: rgba(192, 82, 74, 0.4); }
      .cmd-ring-off { background: rgba(255,255,255,0.10); }

      .cmd-routine-editor {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 0.75rem 0.5rem 0.875rem;
        margin: 0 0.125rem 0.5rem;
        background: rgba(255,255,255,0.015);
        border: 1px solid rgba(255,255,255,0.05);
        border-radius: 0.625rem;
        animation: bannerFadeIn 200ms var(--hearth-curve, ease) both;
      }
      .cmd-editor-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.625rem;
        min-width: 0;
      }
      .cmd-field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
      .cmd-field-key {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: var(--text-muted, #6a6258);
      }
      .cmd-day-toggles { display: flex; flex-wrap: wrap; gap: 0.3rem; }
      .cmd-editor-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.625rem;
        flex-wrap: wrap;
      }
      .cmd-editor-btns { display: flex; gap: 0.375rem; margin-left: auto; }

      /* ── Wins ── */
      .cmd-win-group-label {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--lavender-dim, #8a78a0);
      }
      .cmd-win-slot {
        display: flex;
        align-items: baseline;
        gap: 0.625rem;
        padding: 0.5rem 0.625rem;
        border-radius: 0.625rem;
        border: 1px solid rgba(168, 147, 192, 0.16);
        border-left-width: 2px;
        background: rgba(168, 147, 192, 0.04);
        min-width: 0;
      }
      .cmd-win-slot.cmd-win-companion {
        border-color: rgba(201, 168, 124, 0.16);
        border-left-width: 2px;
        background: rgba(201, 168, 124, 0.035);
      }
      .cmd-win-slot-who {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--lavender-dim, #8a78a0);
        width: 3.25rem;
        flex-shrink: 0;
      }
      .cmd-win-companion .cmd-win-slot-who { color: var(--amber-dim, #a08960); }
      .cmd-win-slot-text {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.9375rem;
        color: var(--text-primary, #e2dbd0);
        line-height: 1.5;
        background: none;
        border: none;
        padding: 0;
        cursor: text;
        text-align: left;
        flex: 1;
        min-width: 0;
        word-break: break-word;
      }
      .cmd-win-slot-empty {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.875rem;
        color: var(--text-muted, #6a6258);
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        text-align: left;
        flex: 1;
        min-width: 0;
        transition: color var(--tx-color, 150ms);
      }
      .cmd-win-slot-empty:hover { color: var(--text-secondary, #a09689); }
      .cmd-win-slot-input { flex: 1; }

      .cmd-win-list { display: flex; flex-direction: column; gap: 0.5rem; }
      .cmd-win-group { display: flex; flex-direction: column; gap: 0.125rem; }
      .cmd-win-row {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
        padding: 0.3rem 0.25rem;
        border-left: 2px solid rgba(168, 147, 192, 0.25);
        padding-left: 0.5rem;
        min-width: 0;
      }
      .cmd-win-row.cmd-win-companion { border-left-color: rgba(201, 168, 124, 0.25); }
      .cmd-win-row .cmd-x { opacity: 0; }
      .cmd-win-row:hover .cmd-x { opacity: 0.6; }
      .cmd-win-who {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        color: var(--lavender-dim, #8a78a0);
        flex-shrink: 0;
      }
      .cmd-win-row.cmd-win-companion .cmd-win-who { color: var(--amber-dim, #a08960); }
      .cmd-win-text {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.875rem;
        color: var(--text-secondary, #a09689);
        line-height: 1.5;
        flex: 1;
        min-width: 0;
        word-break: break-word;
      }

      /* ── Countdowns ── */
      .cmd-count-hero {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 0.75rem 0.875rem 0.625rem;
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 0.75rem;
        background: rgba(255,255,255,0.015);
        min-width: 0;
      }
      .cmd-count-hero.gold {
        border-color: rgba(224, 190, 120, 0.4);
        background: rgba(224, 190, 120, 0.05);
        box-shadow: 0 0 18px rgba(224, 190, 120, 0.09);
      }
      .cmd-count-hero-top {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .cmd-count-hero-top .cmd-mini-btn { margin-left: auto; opacity: 0; }
      .cmd-count-hero:hover .cmd-count-hero-top .cmd-mini-btn { opacity: 1; }
      .cmd-count-hero-days {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 1.75rem;
        font-weight: 500;
        line-height: 1.1;
        color: var(--amber, #c9a87c);
      }
      .cmd-count-hero.gold .cmd-count-hero-days {
        color: #e0be78;
        text-shadow: 0 0 12px rgba(224, 190, 120, 0.45);
      }
      .cmd-count-hero-label {
        font-family: var(--font-serif, 'Lora', serif);
        font-style: italic;
        font-size: 0.9375rem;
        color: var(--text-primary, #e2dbd0);
        line-height: 1.4;
        word-break: break-word;
      }
      .cmd-count-hero-when {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        letter-spacing: 0.05em;
        color: var(--text-muted, #6a6258);
      }
      .cmd-ember-dot {
        width: 0.4375rem;
        height: 0.4375rem;
        border-radius: 50%;
        background: var(--amber, #c9a87c);
        box-shadow: 0 0 6px rgba(201, 168, 124, 0.6);
        animation: presencePulse 3.2s ease-in-out infinite;
        flex-shrink: 0;
      }
      .cmd-ember-dot.gold {
        background: #e0be78;
        box-shadow: 0 0 8px rgba(224, 190, 120, 0.8);
      }
      /* the approaching filament */
      .cmd-filament {
        height: 2px;
        border-radius: 1px;
        margin-top: 0.25rem;
        background: linear-gradient(90deg, var(--amber, #c9a87c), transparent 85%);
        opacity: 0.55;
      }
      .cmd-count-hero.gold .cmd-filament {
        background: linear-gradient(90deg, #e0be78, transparent 85%);
        opacity: 0.75;
      }

      .cmd-count-list { display: flex; flex-direction: column; }
      .cmd-count-row {
        display: flex;
        align-items: baseline;
        gap: 0.625rem;
        padding: 0.4rem 0.25rem;
        border-bottom: 1px solid rgba(255,255,255,0.03);
        min-width: 0;
      }
      .cmd-count-row:last-child { border-bottom: none; }
      .cmd-count-row .cmd-x, .cmd-count-row .cmd-mini-btn { opacity: 0; }
      .cmd-count-row:hover .cmd-x, .cmd-count-row:hover .cmd-mini-btn { opacity: 0.7; }
      .cmd-count-label {
        font-family: var(--font-body, 'Inter', sans-serif);
        font-size: 0.875rem;
        color: var(--text-secondary, #a09689);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cmd-count-days {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--amber-dim, #a08960);
        flex-shrink: 0;
      }
      .cmd-count-days.today { color: var(--amber-bright, #e3c49a); }
      .cmd-count-days.soon { color: var(--amber, #c9a87c); }
      .cmd-count-when {
        font-family: var(--font-mono, 'JetBrains Mono', monospace);
        font-size: 0.5625rem;
        color: var(--text-muted, #6a6258);
        flex-shrink: 0;
      }

      /* ── Mobile ── */
      @media (max-width: 768px) {
        .cmd-inner {
          padding: 0.5rem 0.6rem calc(env(safe-area-inset-bottom, 0px) + 4rem);
          gap: 0.7rem;
        }
        /* the header: orb and date, then the ask; Manage sections tucked to the top right */
        .cmd-head { padding: 0.6rem 0.25rem 0.4rem; gap: 0.6rem; flex-wrap: wrap; }
        .cmd-head .horb { --orb-d: 44px; }
        .cmd-dayhead-date { padding-right: 3.4rem; }
        /* Manage sections floats in the corner here, so no third column (its gap would narrow Echo's words) */
        .cmd-dayhead { grid-template-columns: auto minmax(0, 1fr); row-gap: 0; column-gap: 0.6rem; }
        .cmd-dayhead > .cmd-manage { grid-column: auto; grid-row: auto; }
        .cmd-dayhead > .cmd-dayhead-ask { grid-column: 1 / -1; justify-self: center; justify-content: center; flex-wrap: wrap; column-gap: 0.45rem; row-gap: 0; text-align: center; }
        .cmd-dayhead .horb { --orb-d: 52px; }
        .cmd-dayhead-date { font-size: 1.4rem; }
        /* one column: care's chips first, then the day and its automations, then the rest */
        .cmd-daymain, .cmd-dayside { display: contents; }
        /* the day speaks for itself here: Echo's words stay on a desktop, the ask stays everywhere */
        .cmd-dayhead-words { display: none; }
        .cmd-daygrid #cmd-sec-care { order: -1; }
        .cmd-tl-hit { grid-template-columns: 2.9rem 1.75rem minmax(0, 1fr) auto; gap: 0.55rem; }
        .cmd-tl-now { grid-template-columns: 2.9rem 1.75rem minmax(0, 1fr); gap: 0.55rem; }
        .cmd-tl::before { left: calc(0.25rem + 2.9rem + 0.55rem + 0.875rem - 0.5px); }
        .cmd-tl-glyph { width: 1.75rem; height: 1.75rem; }
        .cmd-tl-anytime-label { width: auto; text-align: left; }
        .cmd-tl-row > :not(.cmd-tl-hit) { margin-left: 0; }
        .cmd-orb-btn { margin-top: 0; }
        .cmd-manage { position: absolute; top: 0.5rem; right: 0.25rem; }
        .cmd-manage-btn { padding: 0.35rem 0.7rem; font-size: 0; gap: 0; }
        .cmd-manage-btn svg { width: 18px; height: 18px; }
        .cmd-manage-pop { right: 0; }
        .cmd-auto-when { display: none; }
        /* closed, a phone says only what is next and when; the header already counts what is on */
        .cmd-auto-counts { display: none; }
        .cmd-care-chips { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.4rem; }
        .cmd-care-chip { min-height: 4.75rem; padding: 0.6rem 0.2rem 0.5rem; font-size: 0.82rem; }
        .cmd-care-chip-icon svg { width: 22px; height: 22px; }
        /* 16px inputs — prevents iOS focus zoom (base font-size is 15px) */
        .cmd-view input,
        .cmd-view textarea,
        .cmd-view select {
          font-size: 16px;
        }
        /* Touch: affordances always visible (no hover) */
        .cmd-care-row .cmd-x,
        .cmd-win-row .cmd-x,
        .cmd-count-row .cmd-x { opacity: 0.5; }
        .cmd-count-row .cmd-mini-btn,
        .cmd-history-row .cmd-mini-btn,
        .cmd-count-hero-top .cmd-mini-btn { opacity: 0.7; }
        .cmd-editor-grid { grid-template-columns: 1fr; }
        .cmd-panel-body { padding: 0.75rem 0.75rem 0.875rem; }
        .cmd-band-day { font-size: 2rem; }
      }
    
        /* ── Dark glass (designer's call): the room shows through, text carries
           the colour. Panels are a darker tint with a light blur. ── */
        .cmd-view {
          --text-primary: #efe4d0;
          --text-secondary: #dccfb8;
          --text-muted: #c2b39c;
          color: #efe4d0;
        }
        .cmd-view .cmd-panel {
          background: rgba(22, 16, 20, 0.45);
          -webkit-backdrop-filter: blur(8px);
          backdrop-filter: blur(8px);
          border: 1px solid rgba(255, 250, 240, 0.14);
          color: #efe4d0;
        }
        /* Fields take the skin's own field pair, as Settings does (Hedgewitch's is the moss green;
           Celestial's is navy, never the moss). The literals are the Hedgewitch values, for a skin with none. */
        .cmd-view input, .cmd-view select, .cmd-view textarea {
          background: var(--settings-field-bg, #222c1ab8);
          color: var(--settings-field-text, #f3ead7);
          border: 1px solid var(--settings-field-border, #fffaf038);
        }
        .cmd-view input::placeholder, .cmd-view textarea::placeholder { color: var(--settings-field-placeholder, #b7a98f); }
        /* Field text is the field's own ink, not the lavender the mono slot carries; code and mono on a panel stay cream. */
        .cmd-view input, .cmd-view textarea, .cmd-view select { color: var(--settings-field-text, #f3ead7) !important; }
        .cmd-view .mono, .cmd-view .sp-field-value.mono, .cmd-view code { color: #f3ead7 !important; }
`}</style>
  );
}
