// The hallway: the house's main screen in household mode, when more than one companion lives here (docs/MULTI-TENANT.md, "Household mode").
// Each painted door is a companion's door. Downstairs holds the first three, the gallery upstairs the next three; a plaque on the floor in front
// of each door names the companion and the room behind it. Choosing one lights the door and steps through it into /c/<id>/.
//
// Always in the house's own walnut and brass, never a companion's skin: the hallway belongs to everyone who lives here. With one companion
// there is nothing to choose, and the house opens straight into their room. The logic (which door, where on the art) is hallway/hallwayState.ts.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useAuthStore } from '../store/auth';
import { HOUSE_BASE } from '../lib/base';
import {
  addCompanionCommand, beyondTheDoors, CLIMB_ARRIVES, CLIMB_MS, doorsOn, FLOORS, folderIdOf, LANDING, parseCompanions, roomName, skipTo, stopCentre, stopsOn,
  upstairsOpen, type CompanionListing, type DoorSpot, type Floor, type Stop,
} from './hallway/hallwayState';

const OPEN_MS = 720;

const reducedMotion = (): boolean => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The layout with the doors as a band and the plaques stacked beneath (a phone, or any tall window). */
const PHONE = '(max-width: 900px), (max-aspect-ratio: 5/4)';
const phoneLayout = (): boolean => typeof matchMedia !== 'undefined' && matchMedia(PHONE).matches;
/** The server's avatar paths are the house's (/c/<id>/api/identity/avatar): in dev the backend is elsewhere. */
const avatarSrc = (u: string): string => (u.startsWith('/') ? `${HOUSE_BASE}${u}` : u);
const pct = (n: number): string => `${+n.toFixed(3)}%`;
const hrefOf = (c: CompanionListing): string => `/c/${c.id}/`;

/** A door's place on the painting, as CSS variables. */
const doorVars = (d: DoorSpot): CSSProperties => ({ '--x': pct(d.x), '--t': pct(d.top), '--h': pct(d.height), '--w': pct(d.width) } as CSSProperties);

const plaqueVars = (d: DoorSpot): CSSProperties => ({ '--x': `${d.x}%`, '--pt': `${d.plaqueTop}%`, '--pw': `${d.plaqueWidth}%`, '--s': d.scale } as CSSProperties);

/** Where the scene zooms from when a door opens: the door's middle. */
const originVars = (d: DoorSpot): CSSProperties => ({ '--ox': pct(d.x), '--oy': pct(d.top + d.height / 2) } as CSSProperties);

/** Whether a media query matches, kept current. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

function Medal({ c }: { c: CompanionListing }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="hw-medal" aria-hidden="true">
      {c.avatar_url && !broken
        ? <img src={avatarSrc(c.avatar_url)} alt="" onError={() => setBroken(true)} />
        : <span className="hw-initial">{(c.name.trim()[0] || '?').toUpperCase()}</span>}
    </span>
  );
}

export interface FloorViewProps {
  list: CompanionListing[];
  floor: Floor;
  /** The room behind each companion's door, by id: the skin's name, or null when it never chose one. Missing while it loads. */
  rooms: Record<string, string | null>;
  lit: string | null;
  openingId: string | null;
  onLight: (id: string | null) => void;
  onOpen: (c: CompanionListing, spot: DoorSpot) => void;
  onAdd: (from: HTMLElement) => void;
}

/** One floor: the scene with its lit doors, and a plaque in front of each. Drawn from props only, so it renders on the server in tests. */
export function FloorView({ list, floor, rooms, lit, openingId, onLight, onOpen, onAdd }: FloorViewProps) {
  const art = FLOORS[floor];
  const doors = doorsOn(list, floor);
  const far = floor === 'up' ? beyondTheDoors(list) : [];

  // A plain click steps through the door; a click that asks for a new tab (or window) keeps the browser's own way, so two tabs can hold two companions.
  const follow = (c: CompanionListing, spot: DoorSpot) => (e: ReactMouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(c, spot);
  };

  const plaque = (c: CompanionListing, spot: DoorSpot | null, number: number) => {
    const ready = c.status === 'ready';
    const room = rooms[c.id];
    return (
      <li key={c.id} className={`hw-plaque${ready ? '' : ' hw-plaque--away'}${spot ? '' : ' hw-plaque--far'}`} style={spot ? plaqueVars(spot) : undefined}
        data-lit={ready && lit === c.id ? '' : undefined}
        onMouseEnter={ready ? () => onLight(c.id) : undefined} onMouseLeave={ready ? () => onLight(null) : undefined}>
        <Medal c={c} />
        <b className="hw-name">{c.name}</b>
        <span className="hw-room">{ready ? (room === undefined ? ' ' : room ?? 'Their own room') : 'Not running right now'}</span>
        {ready
          ? <a className="hw-btn hw-btn--main" href={hrefOf(c)} aria-label={`Open ${c.name}'s room`} aria-describedby={`hw-door-${number}`}
              onFocus={() => onLight(c.id)} onBlur={() => onLight(null)} onClick={spot ? follow(c, spot) : undefined}
              aria-disabled={openingId ? true : undefined}>Open room</a>
          : <span className="hw-away">The Sanctum window says why.</span>}
        <span hidden id={`hw-door-${number}`}>{`Door ${number}${room ? `, ${room}` : ''}`}</span>
      </li>
    );
  };

  return (
    <>
      <div className="hw-stage">
        {doors.map((o, k) => {
          const spot = art.doors[k];
          if (o.kind === 'companion' && o.companion.status === 'ready') {
            const id = o.companion.id;
            return <div key={id} className="hw-door" aria-hidden="true" style={doorVars(spot)}
              data-lit={lit === id || openingId === id ? '' : undefined} data-open={openingId === id ? '' : undefined}
              onMouseEnter={() => onLight(id)} onMouseLeave={() => onLight(null)} onClick={() => onOpen(o.companion, spot)} />;
          }
          if (o.kind === 'add') {
            return <div key="add" className="hw-door hw-door--add" aria-hidden="true" style={doorVars(spot)}
              data-lit={lit === '+add' ? '' : undefined} onMouseEnter={() => onLight('+add')} onMouseLeave={() => onLight(null)}
              onClick={(e) => onAdd(e.currentTarget)} />;
          }
          return null;
        })}
      </div>
      <ul className="hw-plaques" aria-label={`Doors ${floor === 'down' ? 'downstairs' : 'upstairs'}`}>
        {doors.map((o, k) => {
          const spot = art.doors[k];
          if (o.kind === 'companion') return plaque(o.companion, spot, o.number);
          if (o.kind === 'add') {
            return (
              <li key="add" className="hw-plaque hw-plaque--empty" style={plaqueVars(spot)} onMouseEnter={() => onLight('+add')} onMouseLeave={() => onLight(null)}>
                <button className="hw-add" onClick={(e) => onAdd(e.currentTarget)} onFocus={() => onLight('+add')} onBlur={() => onLight(null)}>
                  <b>+ Add companion</b><span>An empty room</span>
                </button>
              </li>
            );
          }
          return null;
        })}
      </ul>
      {far.length > 0 && (
        <div className="hw-far">
          <p className="hw-far-title">Further along the gallery</p>
          <ul className="hw-far-list">{far.map((c, k) => plaque(c, null, 7 + k))}</ul>
        </div>
      )}
    </>
  );
}

export function Hallway() {
  const logout = useAuthStore((s) => s.logout);
  const [list, setList] = useState<CompanionListing[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [rooms, setRooms] = useState<Record<string, string | null>>({});
  const [floor, setFloor] = useState<Floor>('down');
  const [lit, setLit] = useState<string | null>(null);
  const [opening, setOpening] = useState<{ id: string; origin: CSSProperties } | null>(null);
  /** The climb between the floors while it plays, and whether the floor in view was reached by it (its plaques then fade in as the climb ends). */
  const [climb, setClimb] = useState<Floor | null>(null);
  const [climbed, setClimbed] = useState(false);
  /** A phone walking down the stairs arrives at the last door downstairs (the walk is one line: 1, 2, 3, up the stairs, 4, 5, 6). */
  const [arriveAtEnd, setArriveAtEnd] = useState(false);
  const phone = useMedia(PHONE);
  const climbTimers = useRef<number[]>([]);
  const [adding, setAdding] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setFailed(false);
    fetch(`${HOUSE_BASE}/api/companions`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!live) return;
        const found = parseCompanions(d);
        if (!found) { setFailed(true); return; }
        const only = skipTo(found);
        if (only) { setLeaving(true); location.replace(only); return; }
        setList(found);
        // The room behind each door is the companion's own choice (its identity's skin); a door whose room cannot be read just names none.
        for (const c of found) {
          if (c.status !== 'ready') continue;
          fetch(`${HOUSE_BASE}/c/${c.id}/api/identity`, { credentials: 'include' })
            .then((r) => (r.ok ? r.json() : null))
            .then((idn: { skin?: unknown } | null) => { if (live) setRooms((m) => ({ ...m, [c.id]: roomName(idn?.skin) })); })
            .catch(() => { if (live) setRooms((m) => ({ ...m, [c.id]: null })); });
        }
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [attempt]);

  // The landing and the gallery are ready before anyone climbs the stairs.
  const canClimb = !!list && upstairsOpen(list);
  useEffect(() => { if (canClimb) for (const src of [LANDING, FLOORS.up.scene]) { const im = new Image(); im.src = src; } }, [canClimb]);
  useEffect(() => () => { climbTimers.current.forEach((t) => window.clearTimeout(t)); }, []);

  /** To the other floor: up or down the stairs, through the landing; a cut on a phone, or when the person asks for less motion. */
  const goTo = useCallback((to: Floor) => {
    if (climb || to === floor) return;
    setLit(null);
    setArriveAtEnd(to === 'down');
    if (reducedMotion() || phoneLayout()) { setClimbed(false); setFloor(to); return; }
    setClimb(to);
    climbTimers.current = [
      window.setTimeout(() => { setClimbed(true); setFloor(to); }, CLIMB_MS * CLIMB_ARRIVES),
      window.setTimeout(() => setClimb(null), CLIMB_MS),
    ];
  }, [climb, floor]);

  // Back from a companion's room (the browser's page cache keeps this page as it was): the door is closed again.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) { setOpening(null); setLit(null); } };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  const open = useCallback((c: CompanionListing, spot: DoorSpot | null) => {
    if (c.status !== 'ready' || opening) return;
    if (reducedMotion()) { location.assign(hrefOf(c)); return; }
    setOpening({ id: c.id, origin: spot ? originVars(spot) : {} });
    window.setTimeout(() => location.assign(hrefOf(c)), OPEN_MS);
  }, [opening]);

  const startAdding = useCallback((from: HTMLElement) => { returnFocus.current = from; setAdding(true); }, []);
  const stopAdding = useCallback(() => {
    setAdding(false);
    const el = returnFocus.current;
    // The door hotspot is not focusable: hand focus back to the plaque's button instead.
    window.setTimeout(() => (el?.classList.contains('hw-door') ? document.querySelector<HTMLElement>('.hw-add') : el)?.focus(), 0);
  }, []);

  const art = FLOORS[floor];
  const shellStyle = { '--hw-scene': `url(${art.scene})` } as CSSProperties;
  const stageVars = { '--ax': art.anchorX, ...(opening?.origin ?? {}) } as CSSProperties;

  return (
    <div className="hw-shell" style={shellStyle} data-opening={opening ? '' : undefined}>
      <style>{CSS}</style>
      <header className="hw-bar">
        <span className="hw-mark"><img src="/logo.png" width={30} height={30} alt="" /><span>Sanctum</span></span>
        <h1 className="hw-title">{art.title}</h1>
        <span className="hw-bar-end">
          {canClimb && (
            <button className="hw-btn hw-btn--quiet" onClick={() => goTo(floor === 'down' ? 'up' : 'down')} disabled={!!climb}>
              {floor === 'down' ? 'Upstairs ↑' : 'Downstairs ↓'}
            </button>
          )}
          <button className="hw-btn hw-btn--quiet" onClick={() => void logout()}>Sign out</button>
        </span>
      </header>

      {phone && list ? (
        <PhoneHall key={floor} list={list} floor={floor} rooms={rooms} canClimb={canClimb} arriveAtEnd={arriveAtEnd}
          openingId={opening?.id ?? null} onOpen={open} onAdd={startAdding} onFloor={goTo} />
      ) : (
      <main className="hw-floor" key={floor} style={stageVars} data-opening={opening ? '' : undefined} data-climbed={climbed ? '' : undefined} aria-busy={!list && !failed}>
        {list && (
          <FloorView list={list} floor={floor} rooms={rooms} lit={lit} openingId={opening?.id ?? null}
            onLight={opening ? () => undefined : setLit} onOpen={open} onAdd={startAdding} />
        )}
        {!list && <div className="hw-stage" />}
        {(failed || leaving) && (
          <div className="hw-notice" role={failed ? 'alert' : 'status'}>
            {failed
              ? <><p>The house could not find its companions just now.</p><button className="hw-btn hw-btn--main" onClick={() => setAttempt((n) => n + 1)}>Try again</button></>
              : <p>Opening the door…</p>}
          </div>
        )}
      </main>
      )}

      {climb && <Climb to={climb} />}

      {adding && list && <AddCompanion taken={list.map((c) => c.id)} onClose={stopAdding} />}
    </div>
  );
}

/** A phone: the room fills the screen and you face one door at a time, lit, its plaque on the floor in front of you. Swiping, the arrows, the dots
 *  or the arrow keys walk along the hall; past either end the walk carries on up or down the stairs. */
export function PhoneHall({ list, floor, rooms, canClimb, arriveAtEnd, openingId, onOpen, onAdd, onFloor }: {
  list: CompanionListing[]; floor: Floor; rooms: Record<string, string | null>; canClimb: boolean; arriveAtEnd: boolean; openingId: string | null;
  onOpen: (c: CompanionListing, spot: DoorSpot | null) => void; onAdd: (from: HTMLElement) => void; onFloor: (to: Floor) => void;
}) {
  const art = FLOORS[floor];
  const stops = stopsOn(list, floor);
  const [at, setAt] = useState(() => (arriveAtEnd ? stops.length - 1 : 0));
  const touchX = useRef<number | null>(null);
  const i = Math.max(0, Math.min(at, stops.length - 1));
  const stop = stops[i];
  if (!stop) return null;

  const nameAt = (st: Stop) => (st.occupant.kind === 'companion' ? st.occupant.companion.name : 'an empty room');
  const away = (st: Stop) => st.occupant.kind === 'companion' && st.occupant.companion.status !== 'ready';
  const prev = i > 0 ? { label: `Previous door: ${nameAt(stops[i - 1])}`, go: () => setAt(i - 1) }
    : floor === 'up' ? { label: 'Downstairs', stairs: '↓', go: () => onFloor('down') } : null;
  const next = i < stops.length - 1 ? { label: `Next door: ${nameAt(stops[i + 1])}`, go: () => setAt(i + 1) }
    : floor === 'down' && canClimb ? { label: 'Upstairs', stairs: '↑', go: () => onFloor('up') } : null;

  const activate = (el: HTMLElement) => {
    const o = stop.occupant;
    if (o.kind === 'add') onAdd(el);
    else onOpen(o.companion, stop.spot === null ? null : art.doors[stop.spot]);
  };
  const follow = (e: ReactMouseEvent<HTMLElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    activate(e.currentTarget);
  };

  const centre = stopCentre(floor, stop);
  const o = stop.occupant;
  let plate;
  if (o.kind === 'add') {
    plate = (
      <div key={stop.key} className="hw-plaque hw-plaque--empty hp-plate">
        <button className="hw-add" onClick={(e) => onAdd(e.currentTarget)}><b>+ Add companion</b><span>An empty room</span></button>
      </div>
    );
  } else {
    const c = o.companion;
    const ready = c.status === 'ready';
    const room = rooms[c.id];
    plate = (
      <div key={stop.key} className={`hw-plaque hp-plate${ready ? '' : ' hw-plaque--away'}`}>
        <Medal c={c} />
        <b className="hw-name">{c.name}</b>
        <span className="hw-room">{ready ? (room === undefined ? '\u00a0' : room ?? 'Their own room') : 'Not running right now'}</span>
        {ready
          ? <a className="hw-btn hw-btn--main" href={hrefOf(c)} aria-label={`Open ${c.name}'s room`} onClick={follow} aria-disabled={openingId ? true : undefined}>Open room</a>
          : <span className="hw-away">The Sanctum window says why.</span>}
      </div>
    );
  }

  return (
    <main className="hp-hall" aria-label={art.title} data-opening={openingId ? '' : undefined}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft') prev?.go(); else if (e.key === 'ArrowRight') next?.go(); }}
      onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
      onTouchEnd={(e) => {
        const x0 = touchX.current; touchX.current = null;
        if (x0 === null) return;
        const dx = (e.changedTouches[0]?.clientX ?? x0) - x0;
        if (dx < -45) next?.go(); else if (dx > 45) prev?.go();
      }}>
      <div className="hp-scene" style={{ '--img': `url(${art.scene})`, '--cx': centre.x / 100, '--cy': centre.y / 100 } as CSSProperties}>
        {stops.map((st, k) => (st.spot === null ? null : (
          <div key={st.key} className={`hw-door${away(st) ? ' hp-door--away' : ''}`} aria-hidden="true" style={doorVars(art.doors[st.spot])}
            data-lit={k === i && !away(st) ? '' : undefined}
            data-open={k === i && st.occupant.kind === 'companion' && openingId === st.occupant.companion.id ? '' : undefined}
            onClick={(e) => { if (k !== i) setAt(k); else if (!away(st)) activate(e.currentTarget); }} />
        )))}
      </div>
      {prev && <StepButton side="prev" {...prev} />}
      {next && <StepButton side="next" {...next} />}
      <div className="hp-front">
        <div className="hp-plate-slot" aria-live="polite">{plate}</div>
        {stops.length > 1 && (
          <div className="hp-dots" role="group" aria-label="Doors on this floor">
            {stops.map((st, k) => (
              <button key={st.key} className="hp-dot" aria-label={`Door ${k + 1}: ${nameAt(st)}`} aria-current={k === i ? 'true' : undefined} onClick={() => setAt(k)}><i /></button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

/** Along the hall (a chevron), or at its end, up or down the stairs (a labelled step). */
function StepButton({ side, label, stairs, go }: { side: 'prev' | 'next'; label: string; stairs?: string; go: () => void }) {
  if (stairs) return <button className={`hp-stairs hp-stairs--${side}`} onClick={go}>{side === 'prev' ? `${stairs} ${label}` : `${label} ${stairs}`}</button>;
  return <button className={`hp-step hp-step--${side}`} onClick={go} aria-label={label}>{side === 'prev' ? '‹' : '›'}</button>;
}

/** The stairs between the floors: three stills (downstairs, the landing, the gallery), each pushed toward where the eye goes next and dissolved into the
 *  next. Each still is placed exactly as the floor it stands for, so the climb starts on the floor in view and ends on the one it reaches. */
function Climb({ to }: { to: Floor }) {
  const frame = (key: string, scene: string, ax: number) =>
    <div key={key} className={`hw-frame hw-frame--${key}`} style={{ '--img': `url(${scene})`, '--ax': ax } as CSSProperties} />;
  return (
    <div className={`hw-climb hw-climb--${to}`} aria-hidden="true">
      {frame('down', FLOORS.down.scene, FLOORS.down.anchorX)}
      {frame('landing', LANDING, 0.5)}
      {frame('up', FLOORS.up.scene, FLOORS.up.anchorX)}
    </div>
  );
}

/** "+ Add companion": a new companion moves in from the computer Sanctum runs on (each lives in its own folder there), then a restart opens their door. */
function AddCompanion({ taken, onClose }: { taken: string[]; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLElement>(null);
  const id = folderIdOf(typed);
  const clash = !!id && taken.includes(id);
  const cmd = addCompanionCommand(id);

  useEffect(() => { boxRef.current?.querySelector<HTMLInputElement>('input')?.focus(); }, []);
  useEffect(() => { setCopied(false); }, [cmd]);

  // Escape closes; Tab stays inside the dialog.
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab' || !boxRef.current) return;
    const f = [...boxRef.current.querySelectorAll<HTMLElement>('input, button:not([disabled])')];
    if (f.length === 0) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(cmd); setCopied(true); return; } catch { /* no clipboard here: select it instead */ }
    const sel = window.getSelection();
    if (codeRef.current && sel) { sel.selectAllChildren(codeRef.current); try { setCopied(document.execCommand('copy')); } catch { /* selected; the person copies it */ } }
  };

  return (
    <div className="hw-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="hw-dialog" role="dialog" aria-modal="true" aria-labelledby="hw-add-title" ref={boxRef} onKeyDown={onKey}>
        <h2 className="hw-dialog-title" id="hw-add-title">A new companion</h2>
        <p className="hw-text">Every companion has a room of their own: their own folder on the computer Sanctum runs on. A new one moves in from there.</p>
        <label className="hw-label" htmlFor="hw-add-id">A short name for their folder</label>
        <input id="hw-add-id" className="hw-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="e.g. wren"
          autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={clash} aria-describedby="hw-add-hint" />
        <p className={clash ? 'hw-error' : 'hw-hint'} id="hw-add-hint" role={clash ? 'alert' : undefined}>
          {clash ? `A companion already lives in “${id}”. Choose another name.` : 'Letters, numbers and dashes. You name the companion themselves in the next step.'}
        </p>
        <p className="hw-text">On that computer, in the Sanctum folder, run:</p>
        <div className="hw-code-row">
          <code className="hw-code" ref={codeRef}>{cmd}</code>
          <button className="hw-btn hw-btn--quiet hw-btn--small" onClick={() => void copy()} disabled={!id || clash}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <p className="hw-hint">It asks their name and how they think, the same way the first one did. Then restart Sanctum, and their door opens here.</p>
        <div className="hw-dialog-foot"><button className="hw-btn hw-btn--main" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

// ─── the house: walnut, brass and copper (the same palette as the foyer's onboarding). Its own colours, never a skin's. ──────────
// Contrast (WCAG): ink #F4E7D6 on the plaque #1C110C 15.1:1; accent-ink #E9C98F 11.6:1; ink-3 #BBA488 7.9:1; on-accent #FFF1E2 on #7A391F 8.4:1;
// the focus ring #F0C99A on the plaque 11:1. The bar's ink sits on a near-black wash over the ceiling (at least 12:1).

const CSS = `
.hw-shell {
  --hw-page: #120A07; --hw-plate: #1C110C; --hw-chrome: #20130E; --hw-ink: #F4E7D6; --hw-ink-2: #D8C3A8; --hw-ink-3: #BBA488; --hw-accent-ink: #E9C98F;
  --hw-accent: #7A391F; --hw-on-accent: #FFF1E2; --hw-trim: #D49A66; --hw-trim-quiet: #5A4130; --hw-focus: #F0C99A; --hw-bad: #F3B3A7;
  --hw-leather: url(/house/leather-v1.webp);
  --hw-sans: 'Source Sans 3', -apple-system, 'Segoe UI', system-ui, sans-serif;
  --hw-serif: 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
  position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column; overflow: hidden;
  color: var(--hw-ink); font-family: var(--hw-sans); background: var(--hw-page); isolation: isolate;
}
/* The same scene, blurred, fills whatever the window adds around the painting. */
.hw-shell::before { content: ''; position: fixed; inset: -40px; z-index: -1; background: var(--hw-scene) center / cover no-repeat; filter: blur(22px) brightness(0.42); }
.hw-shell[data-opening]::after { content: ''; position: fixed; inset: 0; z-index: 20; background: var(--hw-page); pointer-events: none; animation: hw-dark ${OPEN_MS}ms ease-in both; }
@keyframes hw-dark { 0%, 45% { opacity: 0; } 100% { opacity: 1; } }

.hw-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 4; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px;
  padding: max(12px, env(safe-area-inset-top)) 24px 14px;
  background: linear-gradient(180deg, rgba(10,5,3,0.88), rgba(10,5,3,0.55) 75%, rgba(10,5,3,0)); }
.hw-mark { justify-self: start; display: flex; align-items: center; gap: 10px; font: 500 17px/1 var(--hw-sans); letter-spacing: 0.02em; }
.hw-mark img { display: block; filter: drop-shadow(0 2px 6px rgba(0,0,0,0.6)); }
.hw-title { justify-self: center; margin: 0; font: 500 36px/1 var(--hw-serif); color: var(--hw-ink); text-shadow: 0 2px 14px rgba(0,0,0,0.8); white-space: nowrap; }
.hw-bar-end { justify-self: end; display: flex; gap: 10px; }

.hw-btn { min-height: 44px; padding: 0 18px; border-radius: 8px; font: 500 15px/1 var(--hw-sans); cursor: pointer; border: 1px solid var(--hw-trim);
  display: inline-flex; align-items: center; justify-content: center; text-decoration: none; box-sizing: border-box; white-space: nowrap; }
.hw-btn--main { color: var(--hw-on-accent); background: linear-gradient(180deg, rgba(255,255,255,0.14), transparent 60%), var(--hw-accent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 4px 12px rgba(0,0,0,0.45); }
.hw-btn--main:hover { background: linear-gradient(180deg, rgba(255,255,255,0.22), transparent 60%), var(--hw-accent); }
.hw-btn--quiet { color: var(--hw-ink); background: var(--hw-leather) center / 420px, var(--hw-chrome); background-blend-mode: soft-light; }
.hw-btn--small { min-height: 44px; padding: 0 14px; flex: none; }
.hw-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.hw-btn:focus-visible, .hw-add:focus-visible, .hw-input:focus-visible { outline: 2px solid var(--hw-focus); outline-offset: 2px; }

/* The painting fills the window, as a room would. What a window's shape crops comes off the staircase side and never more than the doors allow
   (a little over a quarter across, a seventh down); past that the blurred scene fills the rest. The plaques are placed in % of the painting, so they
   stay on their doors whatever is cropped. Taller windows than this get the phone layout. */
.hw-floor, .hw-frame { --vh: 100vh; --R: calc(1672 / 941); --W: max(min(100vw, var(--vh) * var(--R) * 1.15), min(var(--vh) * var(--R), 100vw * 1.42)); --H: calc(var(--W) / var(--R));
  position: absolute; width: var(--W); height: var(--H);
  left: calc(min(0px, (100vw - var(--W)) * var(--ax, 0.5)) + max(0px, (100vw - var(--W)) * 0.5));
  top: calc(min(0px, (var(--vh) - var(--H)) * 0.6) + max(0px, (var(--vh) - var(--H)) * 0.6)); }
@supports (height: 100dvh) { .hw-floor, .hw-frame { --vh: 100dvh; } }
.hw-floor { container-type: inline-size; overflow: hidden; animation: hw-arrive 520ms cubic-bezier(0.16, 1, 0.3, 1) both; }
/* Reached by the climb: the painting is already in view (the climb ended on it), so only the plaques arrive. */
.hw-floor[data-climbed] { animation: none; }
.hw-floor[data-climbed] .hw-plaques, .hw-floor[data-climbed] .hw-far { animation: hw-plaques-in 520ms ${Math.round(CLIMB_MS * (1 - CLIMB_ARRIVES))}ms ease-out both; }
@keyframes hw-plaques-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* The climb between the floors. Each still holds its floor's place; the veil over the hall comes up as the climb starts and lifts as it ends. */
.hw-climb { position: fixed; inset: 0; z-index: 3; overflow: hidden; background: var(--hw-page); pointer-events: none; animation: hw-veil ${CLIMB_MS}ms linear both; }
@keyframes hw-veil { 0% { opacity: 0; } 6% { opacity: 1; } 90% { opacity: 1; } 100% { opacity: 0; } }
.hw-frame { background: var(--img) center / 100% 100% no-repeat; opacity: 0; will-change: transform, opacity; animation: ${CLIMB_MS}ms ease-in-out both; }
.hw-frame::after { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse 90% 85% at 62% 52%, transparent 58%, rgba(0,0,0,0.55) 100%); }
/* Up: toward the staircase, onto the landing, along the gallery to its doors. */
.hw-climb--up .hw-frame--down { animation-name: hw-up-down; }
.hw-climb--up .hw-frame--landing { animation-name: hw-up-landing; }
.hw-climb--up .hw-frame--up { animation-name: hw-up-up; }
@keyframes hw-up-down { 0% { opacity: 1; transform: none; transform-origin: 32% 30%; } 34% { opacity: 1; transform: scale(1.3); transform-origin: 32% 30%; } 46% { opacity: 0; transform: scale(1.42); transform-origin: 32% 30%; } 100% { opacity: 0; transform: scale(1.42); transform-origin: 32% 30%; } }
@keyframes hw-up-landing { 0%, 30% { opacity: 0; transform: scale(1.14); transform-origin: 22% 78%; } 46% { opacity: 1; transform: scale(1.05); transform-origin: 22% 78%; }
  56% { opacity: 1; transform: none; transform-origin: 22% 78%; } 58% { opacity: 1; transform: scale(1.004); transform-origin: 66% 42%; }
  68% { opacity: 1; transform: scale(1.12); transform-origin: 66% 42%; } 84%, 100% { opacity: 0; transform: scale(1.34); transform-origin: 66% 42%; } }
@keyframes hw-up-up { 0%, 66% { opacity: 0; transform: scale(1.1); transform-origin: 50% 48%; } ${Math.round(CLIMB_ARRIVES * 100)}%, 100% { opacity: 1; transform: none; transform-origin: 50% 48%; } }
/* Down: toward the railing and the stairwell, onto the landing, down the stairs into the hall. */
.hw-climb--down .hw-frame--up { animation-name: hw-down-up; }
.hw-climb--down .hw-frame--landing { animation-name: hw-down-landing; }
.hw-climb--down .hw-frame--down { animation-name: hw-down-down; }
@keyframes hw-down-up { 0% { opacity: 1; transform: none; transform-origin: 10% 72%; } 34% { opacity: 1; transform: scale(1.28); transform-origin: 10% 72%; } 46% { opacity: 0; transform: scale(1.38); transform-origin: 10% 72%; } 100% { opacity: 0; transform: scale(1.38); transform-origin: 10% 72%; } }
@keyframes hw-down-landing { 0%, 30% { opacity: 0; transform: scale(1.12); transform-origin: 60% 45%; } 46% { opacity: 1; transform: scale(1.04); transform-origin: 60% 45%; }
  56% { opacity: 1; transform: none; transform-origin: 60% 45%; } 58% { opacity: 1; transform: scale(1.004); transform-origin: 18% 82%; }
  68% { opacity: 1; transform: scale(1.12); transform-origin: 18% 82%; } 84%, 100% { opacity: 0; transform: scale(1.34); transform-origin: 18% 82%; } }
@keyframes hw-down-down { 0%, 66% { opacity: 0; transform: scale(1.12); transform-origin: 32% 30%; } ${Math.round(CLIMB_ARRIVES * 100)}%, 100% { opacity: 1; transform: none; transform-origin: 32% 30%; } }
@keyframes hw-arrive { from { opacity: 0; transform: scale(1.015); } to { opacity: 1; transform: none; } }
.hw-stage { position: absolute; inset: 0; background: var(--hw-scene) center / 100% 100% no-repeat, var(--hw-page); transform-origin: var(--ox, 50%) var(--oy, 50%); }
.hw-stage::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse 90% 85% at 62% 52%, transparent 58%, rgba(0,0,0,0.55) 100%); }
.hw-floor[data-opening] .hw-stage { transform: scale(1.75); filter: brightness(1.12); transition: transform ${OPEN_MS}ms cubic-bezier(0.55, 0, 0.8, 0.2), filter ${OPEN_MS}ms ease-in; }
.hw-floor[data-opening] .hw-plaques, .hw-floor[data-opening] .hw-far { opacity: 0; transition: opacity 240ms ease-out; }

/* A door: invisible until lamplight finds it. */
.hw-door { position: absolute; z-index: 1; left: var(--x); top: var(--t); width: var(--w); height: var(--h); transform: translateX(-50%); cursor: pointer;
  border-radius: 40% 40% 2px 2px / 16% 16% 2px 2px; mix-blend-mode: screen; transition: background-color 320ms ease, box-shadow 320ms ease; }
/* Lamplight: warm on the panels, a rim of light around the frame, a pool of it on the floor. */
.hw-door[data-lit] { background: radial-gradient(ellipse 70% 58% at 50% 52%, rgba(255,196,120,0.62), rgba(255,160,80,0.26) 58%, rgba(255,150,70,0.06) 84%);
  box-shadow: 0 0 0 1px rgba(255,200,140,0.28), 0 0 34px 6px rgba(255,170,90,0.42), 0 0 90px 26px rgba(255,150,70,0.26); }
.hw-door[data-lit]::after { content: ''; position: absolute; left: -30%; right: -30%; bottom: -14%; height: 22%; border-radius: 50%;
  background: radial-gradient(ellipse at 50% 30%, rgba(255,180,100,0.5), transparent 70%); }
.hw-door[data-open] { background: radial-gradient(ellipse 80% 72% at 50% 52%, rgba(255,226,160,0.96), rgba(255,176,96,0.66) 55%, rgba(255,140,60,0.2) 85%);
  box-shadow: 0 0 0 1px rgba(255,214,160,0.5), 0 0 60px 16px rgba(255,176,96,0.6), 0 0 160px 60px rgba(255,150,70,0.45); transition-duration: ${Math.round(OPEN_MS * 0.6)}ms; }

/* The plaques stand on the floor in front of their doors; further down the gallery, smaller. */
.hw-plaques { list-style: none; margin: 0; padding: 0; position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.hw-plaque { --u: calc(clamp(9.5px, 1cqw, 19px) * var(--s, 1)); pointer-events: auto; position: absolute; left: var(--x); top: var(--pt); width: var(--pw);
  min-width: calc(var(--u) * 11.5); transform: translateX(-50%); box-sizing: border-box; font-size: var(--u); text-align: center; padding: 2em 0.9em 1em;
  background: var(--hw-leather) center / 420px, var(--hw-plate); background-blend-mode: soft-light; border: 1px solid var(--hw-trim); border-radius: 8px;
  box-shadow: 0 12px 28px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.08); }
/* The chosen plaque catches the light too (on a floor whose doors do not glow, it is the only sign). */
.hw-plaque { transition: box-shadow 260ms ease, border-color 260ms ease; }
.hw-plaque[data-lit] { border-color: #E8B27A; box-shadow: 0 0 0 1px rgba(232,178,122,0.55), 0 0 26px -2px rgba(255,170,90,0.55), 0 12px 28px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.12); }
.hw-medal { position: absolute; top: 0; left: 50%; transform: translate(-50%, -50%); width: 3.4em; height: 3.4em; border-radius: 50%; overflow: hidden;
  display: grid; place-items: center; background: radial-gradient(circle at 35% 30%, rgba(255,255,255,0.18), transparent 60%), var(--hw-accent);
  border: 1px solid var(--hw-trim); box-shadow: 0 0 0 3px var(--hw-plate), 0 0 0 4px var(--hw-trim-quiet), 0 6px 14px rgba(0,0,0,0.6); }
.hw-medal img { width: 100%; height: 100%; object-fit: cover; display: block; }
.hw-initial { font: 500 1.9em/1 var(--hw-serif); color: var(--hw-on-accent); }
.hw-name { display: block; font: 500 2.1em/1.08 var(--hw-serif); color: var(--hw-ink); overflow-wrap: anywhere; }
.hw-room { display: block; font-size: max(12px, 1.05em); line-height: 1.4; color: var(--hw-accent-ink); margin: 0.25em 0 0.85em; }
.hw-plaque .hw-btn { width: 100%; min-height: max(34px, 2.9em); padding: 0 0.6em; font-size: max(13px, 1.15em); }
.hw-plaque .hw-btn[aria-disabled] { pointer-events: none; }
.hw-plaque--away { opacity: 0.72; filter: saturate(0.6); }
.hw-plaque--away .hw-medal { background: var(--hw-chrome); }
.hw-plaque--away .hw-room { color: var(--hw-ink-2); }
.hw-away { display: block; font-size: max(12px, 1em); line-height: 1.35; color: var(--hw-ink-3); }
.hw-plaque--empty { padding: 0; background: rgba(20,10,6,0.55); border-style: dashed; box-shadow: 0 10px 24px rgba(0,0,0,0.4); backdrop-filter: blur(4px); }
.hw-add { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 1.3em 0.9em; cursor: pointer; border-radius: 8px; text-align: center; }
.hw-add b { display: block; font: 500 1.6em/1.1 var(--hw-serif); color: var(--hw-ink); }
.hw-add span { display: block; margin-top: 0.3em; font-size: max(12px, 1.05em); color: var(--hw-ink-3); }
.hw-add:hover b { color: var(--hw-accent-ink); }

/* More than six companions: the rest further along the gallery. */
.hw-far { position: absolute; z-index: 2; left: 3%; bottom: 4%; max-width: 34%; }
.hw-far-title { margin: 0 0 8px; font: 600 12px/16px var(--hw-sans); letter-spacing: 0.14em; text-transform: uppercase; color: var(--hw-accent-ink); text-shadow: 0 1px 6px rgba(0,0,0,0.9); }
.hw-far-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px; }
.hw-far-list .hw-plaque { position: relative; left: auto; top: auto; transform: none; width: auto; min-width: 0; --u: 11px; display: grid; grid-template-columns: auto 1fr;
  column-gap: 10px; align-items: center; text-align: left; padding: 8px 10px; }
.hw-far-list .hw-medal { position: static; transform: none; grid-row: span 3; width: 36px; height: 36px; font-size: 11px; box-shadow: none; }
.hw-far-list .hw-name { font-size: 18px; }
.hw-far-list .hw-room { margin: 0 0 6px; }
.hw-far-list .hw-btn { min-height: 36px; }

.hw-notice { position: absolute; z-index: 3; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(92%, 26rem); padding: 22px 24px; text-align: center;
  background: var(--hw-leather) center / 420px, var(--hw-plate); background-blend-mode: soft-light; border: 1px solid var(--hw-trim); border-radius: 12px;
  box-shadow: 0 0 22px -6px var(--hw-trim), 0 24px 60px rgba(0,0,0,0.7); }
.hw-notice p { margin: 0 0 14px; font-size: 16px; line-height: 24px; color: var(--hw-ink-2); }
.hw-notice p:last-child { margin: 0; }

/* + Add companion */
.hw-scrim { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 16px; background: rgba(8,4,2,0.62); backdrop-filter: blur(3px); }
.hw-dialog { width: min(100%, 34rem); box-sizing: border-box; padding: 26px 28px 22px; border-radius: 14px; border: 1px solid var(--hw-trim);
  background: var(--hw-leather) center / 420px, var(--hw-plate); background-blend-mode: soft-light;
  box-shadow: 0 0 22px -6px var(--hw-trim), 0 30px 90px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,0.07); animation: hw-rise 380ms cubic-bezier(0.16, 1, 0.3, 1) both; }
@keyframes hw-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.hw-dialog-title { margin: 0 0 8px; font: 500 32px/1.15 var(--hw-serif); }
.hw-text { margin: 12px 0 0; font-size: 16px; line-height: 24px; color: var(--hw-ink-2); }
.hw-label { display: block; margin: 18px 0 6px; font-size: 14px; font-weight: 600; color: var(--hw-ink-2); }
.hw-input { width: 100%; box-sizing: border-box; min-height: 48px; padding: 0 14px; border-radius: 8px; font: 400 16px/1.2 var(--hw-sans); color: var(--hw-ink);
  background: linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.03)); border: 1px solid rgba(255,255,255,0.22); box-shadow: inset 0 1px 0 rgba(255,255,255,0.18); }
.hw-input::placeholder { color: var(--hw-ink-3); }
.hw-input[aria-invalid="true"] { border-color: var(--hw-bad); }
.hw-hint { margin: 8px 0 0; font-size: 14px; line-height: 20px; color: var(--hw-ink-3); }
.hw-error { margin: 8px 0 0; font-size: 15px; line-height: 21px; color: var(--hw-bad); }
.hw-code-row { display: flex; gap: 10px; align-items: stretch; margin-top: 8px; }
.hw-code { flex: 1; min-width: 0; display: flex; align-items: center; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--hw-trim-quiet); background: rgba(0,0,0,0.32);
  font: 400 14px/1.4 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; color: var(--hw-accent-ink); overflow-wrap: anywhere; user-select: all; }
.hw-dialog-foot { display: flex; justify-content: flex-end; margin-top: 20px; }
.hw-dialog-foot .hw-btn { min-width: 8rem; min-height: 48px; font-size: 16px; }

/* A phone, or any tall window: the doors in a band across the top, the plaques stacked beneath. */
/* A phone: walking the hall, one door at a time. The painting is drawn at the screen's full height (or width, if that is more) and slides so the
   door you face is in the middle; it never shows past its own edges. */
.hp-hall { position: fixed; inset: 0; overflow: hidden; touch-action: pan-y; animation: hw-arrive 480ms cubic-bezier(0.16, 1, 0.3, 1) both; }
.hp-scene { --vh: 100vh; --R: calc(1672 / 941); --W: max(var(--vh) * var(--R), 100vw); --H: calc(var(--W) / var(--R));
  position: absolute; width: var(--W); height: var(--H);
  left: clamp(100vw - var(--W), 50vw - var(--cx) * var(--W), 0px);
  top: clamp(var(--vh) - var(--H), var(--vh) * 0.4 - var(--cy) * var(--H), 0px);
  background: var(--img) center / 100% 100% no-repeat, var(--hw-page);
  transform-origin: calc(var(--cx) * 100%) calc(var(--cy) * 100%);
  transition: left 700ms cubic-bezier(0.45, 0, 0.2, 1), top 700ms cubic-bezier(0.45, 0, 0.2, 1); }
@supports (height: 100dvh) { .hp-scene { --vh: 100dvh; } }
.hp-scene::after { content: ''; position: fixed; inset: 0; pointer-events: none; background: radial-gradient(ellipse 120% 70% at 50% 42%, transparent 45%, rgba(0,0,0,0.6) 100%); }
.hp-hall[data-opening] .hp-scene { transform: scale(1.6); filter: brightness(1.12); transition: transform ${OPEN_MS}ms cubic-bezier(0.55, 0, 0.8, 0.2), filter ${OPEN_MS}ms ease-in; }
.hp-hall[data-opening] :is(.hp-front, .hp-step, .hp-stairs) { opacity: 0; transition: opacity 240ms ease-out; }
.hp-door--away { cursor: default; }
.hp-step { position: absolute; z-index: 3; top: 50%; width: 44px; height: 44px; padding: 0 0 3px; border-radius: 50%; display: grid; place-items: center; cursor: pointer;
  font: 400 30px/1 var(--hw-serif); color: var(--hw-ink); border: 1px solid var(--hw-trim); background: rgba(10,5,3,0.58); backdrop-filter: blur(4px); box-shadow: 0 4px 14px rgba(0,0,0,0.5); }
.hp-stairs { position: absolute; z-index: 3; top: 50%; min-height: 44px; padding: 0 14px; border-radius: 22px; cursor: pointer; border: 1px solid var(--hw-trim);
  color: var(--hw-ink); font: 500 14px/1 var(--hw-sans); background: var(--hw-leather) center / 420px, var(--hw-chrome); background-blend-mode: soft-light; box-shadow: 0 6px 16px rgba(0,0,0,0.55); }
.hp-step--prev, .hp-stairs--prev { left: 10px; }
.hp-step--next, .hp-stairs--next { right: 10px; }
.hp-front { position: absolute; z-index: 2; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; align-items: center; gap: 12px; pointer-events: none;
  padding: 48px 16px max(12px, env(safe-area-inset-bottom)); background: linear-gradient(180deg, transparent, rgba(10,5,3,0.5) 55%); }
.hp-front > * { pointer-events: auto; }
.hp-plate-slot { width: min(300px, 100%); }
.hp-plate.hw-plaque { position: relative; left: auto; top: auto; transform: none; width: 100%; min-width: 0; --u: 15px; padding-top: 2.6em; animation: hp-plate-in 380ms cubic-bezier(0.16, 1, 0.3, 1) both; }
.hp-plate .hw-medal { width: 64px; height: 64px; }
.hp-plate .hw-name { font-size: 32px; }
.hp-plate .hw-room { font-size: 15px; }
.hp-plate .hw-btn { min-height: 50px; font-size: 17px; }
.hp-plate.hw-plaque--empty { padding: 0; }
.hp-plate .hw-add { padding: 24px 16px; }
.hp-plate .hw-add b { font-size: 28px; }
.hp-plate .hw-add span { font-size: 15px; }
@keyframes hp-plate-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.hp-dots { display: flex; gap: 2px; }
.hp-dot { all: unset; width: 30px; height: 30px; display: grid; place-items: center; cursor: pointer; border-radius: 50%; }
.hp-dot i { width: 9px; height: 9px; box-sizing: border-box; border-radius: 50%; border: 1px solid var(--hw-trim); }
.hp-dot[aria-current] i { background: var(--hw-trim); box-shadow: 0 0 8px var(--hw-trim); }
.hp-dot:focus-visible, .hp-step:focus-visible, .hp-stairs:focus-visible { outline: 2px solid var(--hw-focus); outline-offset: 2px; }

@media ${PHONE} {
  .hw-bar { grid-template-columns: auto 1fr auto; padding: max(10px, env(safe-area-inset-top)) 12px 24px; }
  .hw-mark span { display: none; }
  .hw-title { justify-self: start; font-size: 26px; }
  .hw-bar-end { gap: 8px; }
  .hw-bar .hw-btn { padding: 0 12px; min-height: 44px; font-size: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .hw-floor, .hw-dialog, .hw-floor[data-climbed] .hw-plaques, .hp-hall, .hp-plate.hw-plaque { animation: none; }
  .hw-door, .hp-scene { transition: none; }
}
`;
