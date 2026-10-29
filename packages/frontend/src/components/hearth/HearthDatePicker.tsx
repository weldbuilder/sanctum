/**
 * HearthDatePicker — Hearth-styled replacement for <input type="date">.
 *
 * Input-shaped trigger showing the formatted date ("2 Jul"; year appended when
 * not the current year). Opens a backdrop-glass calendar popover:
 *   — Lora italic month title, mono tabular day grid
 *   — amber today-ring, selected fill (amber default, lavender via `tone`)
 *   — ‹ › month steppers with hearth-press
 *   — today / yesterday quick-chips row
 *   — keyboard: arrows move the cursor day, Enter selects, Esc closes
 * Emits "YYYY-MM-DD". Bottom-sheet positioning under 600px, 16px fonts on
 * mobile (prevents iOS zoom).
 *
 * Optional `marks` prop for cycle contexts: faint rose dots (predicted
 * period) / gold underline (fertile window). Renders nothing when absent.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';

export interface HearthDateMark {
  date: string;                 // "YYYY-MM-DD"
  kind: 'period' | 'fertile';
}

export interface HearthDatePickerProps {
  value: string;                       // "YYYY-MM-DD" ('' = nothing selected)
  onChange: (v: string) => void;
  tone?: 'amber' | 'lavender';         // selected-fill variant (default amber)
  marks?: HearthDateMark[];            // cycle contexts pass these later
  placeholder?: string;                // trigger text when no value
  disabled?: boolean;
  ariaLabel?: string;
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW_HEADERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']; // Monday-first

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fromYmd(s: string | undefined | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
function formatTrigger(value: string): string | null {
  const d = fromYmd(value);
  if (!d) return null;
  const now = new Date();
  const base = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

export function HearthDatePicker({
  value,
  onChange,
  tone = 'amber',
  marks,
  placeholder = 'pick a date',
  disabled = false,
  ariaLabel = 'Date picker',
}: HearthDatePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const today = toYmd(new Date());
  const yesterday = toYmd(addDays(new Date(), -1));

  // Cursor = the keyboard-focused day inside the grid.
  const [cursor, setCursor] = useState<Date>(() => fromYmd(value) ?? new Date());
  // View = which month the grid shows.
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const d = fromYmd(value) ?? new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  // Re-anchor cursor + view whenever the popover opens.
  useEffect(() => {
    if (!open) return;
    const d = fromYmd(value) ?? new Date();
    setCursor(d);
    setView({ y: d.getFullYear(), m: d.getMonth() });
    // Focus the popover so arrow keys work immediately.
    requestAnimationFrame(() => popRef.current?.focus());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Outside click closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const markMap = useMemo(() => {
    const map: Record<string, { period?: boolean; fertile?: boolean }> = {};
    for (const mk of marks ?? []) {
      (map[mk.date] ??= {})[mk.kind] = true;
    }
    return map;
  }, [marks]);

  // Build the day grid for the viewed month (Monday-first, null = leading blank).
  const cells = useMemo(() => {
    const first = new Date(view.y, view.m, 1);
    const lead = (first.getDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(new Date(view.y, view.m, d));
    return out;
  }, [view]);

  const select = (d: Date) => {
    onChange(toYmd(d));
    setOpen(false);
    triggerRef.current?.focus();
  };

  const stepMonth = (dir: 1 | -1) => {
    setView(v => {
      const d = new Date(v.y, v.m + dir, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };

  const moveCursor = (deltaDays: number) => {
    setCursor(c => {
      const next = addDays(c, deltaDays);
      setView({ y: next.getFullYear(), m: next.getMonth() });
      return next;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); moveCursor(-1); break;
      case 'ArrowRight': e.preventDefault(); moveCursor(1);  break;
      case 'ArrowUp':    e.preventDefault(); moveCursor(-7); break;
      case 'ArrowDown':  e.preventDefault(); moveCursor(7);  break;
      case 'PageUp':     e.preventDefault(); stepMonth(-1);  break;
      case 'PageDown':   e.preventDefault(); stepMonth(1);   break;
      case 'Enter':      e.preventDefault(); select(cursor); break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
    }
  };

  const triggerText = formatTrigger(value);
  const cursorYmd = toYmd(cursor);

  return (
    <div className={`hdp-root tone-${tone}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`hdp-trigger hearth-press${triggerText ? '' : ' empty'}`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); }
        }}
      >
        <span className="hdp-trigger-text">{triggerText ?? placeholder}</span>
        <span className="hdp-trigger-glyph" aria-hidden>▾</span>
      </button>

      {open && (
        <>
          <div className="hdp-backdrop" onClick={() => setOpen(false)} aria-hidden />
          <div
            ref={popRef}
            className="hdp-pop backdrop-glass"
            role="dialog"
            aria-label="Choose a date"
            tabIndex={-1}
            onKeyDown={handleKeyDown}
          >
            {/* Month header */}
            <div className="hdp-head">
              <button
                type="button"
                className="hdp-nav hearth-press hearth-hover"
                aria-label="Previous month"
                onClick={() => stepMonth(-1)}
              >‹</button>
              <span className="hdp-month">{MONTHS_LONG[view.m]} {view.y}</span>
              <button
                type="button"
                className="hdp-nav hearth-press hearth-hover"
                aria-label="Next month"
                onClick={() => stepMonth(1)}
              >›</button>
            </div>

            {/* Quick chips */}
            <div className="hdp-chips">
              <button
                type="button"
                className={`hdp-chip hearth-press${value === today ? ' active' : ''}`}
                onClick={() => select(new Date())}
              >today</button>
              <button
                type="button"
                className={`hdp-chip hearth-press${value === yesterday ? ' active' : ''}`}
                onClick={() => select(addDays(new Date(), -1))}
              >yesterday</button>
            </div>

            {/* Day-of-week headers */}
            <div className="hdp-dow" aria-hidden>
              {DOW_HEADERS.map((d, i) => <span key={i}>{d}</span>)}
            </div>

            {/* Day grid */}
            <div className="hdp-grid" role="grid" aria-label={`${MONTHS_LONG[view.m]} ${view.y}`}>
              {cells.map((d, i) => {
                if (!d) return <span key={`b${i}`} className="hdp-blank" aria-hidden />;
                const ymd = toYmd(d);
                const mk = markMap[ymd];
                const cls = [
                  'hdp-day',
                  ymd === value ? 'selected' : '',
                  ymd === today ? 'today' : '',
                  ymd === cursorYmd ? 'cursor' : '',
                  mk?.fertile ? 'mark-fertile' : '',
                ].filter(Boolean).join(' ');
                return (
                  <button
                    key={ymd}
                    type="button"
                    role="gridcell"
                    aria-selected={ymd === value}
                    aria-current={ymd === today ? 'date' : undefined}
                    aria-label={`${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`}
                    tabIndex={-1}
                    className={cls}
                    onClick={() => select(d)}
                    onMouseEnter={() => setCursor(d)}
                  >
                    {d.getDate()}
                    {mk?.period && <span className="hdp-dot" aria-hidden />}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      <style>{`
        .hdp-root {
          position: relative;
          display: inline-block;
        }

        /* ── Trigger — input-shaped, matches .sp-form-input / .cmd-input ── */
        .hdp-trigger {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.875rem;
          color: var(--text-primary, #e2dbd0);
          background: var(--bg-input, #0f0e0c);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 0.5rem;
          padding: 0.4375rem 0.75rem;
          cursor: pointer;
          transition: border-color var(--tx-color, 150ms ease);
          min-width: 6rem;
          justify-content: space-between;
        }
        .hdp-trigger:hover:not(:disabled) { border-color: rgba(255,255,255,0.14); }
        .hdp-trigger:focus-visible {
          outline: none;
          border-color: rgba(201,168,124,0.45);
          box-shadow: 0 0 0 3px rgba(201,168,124,0.09);
        }
        .hdp-trigger:disabled { opacity: 0.5; cursor: default; }
        .hdp-trigger.empty .hdp-trigger-text { color: var(--text-muted, #6a6258); }
        .hdp-trigger-glyph {
          font-size: 0.625rem;
          color: var(--text-muted, #6a6258);
          user-select: none;
        }

        /* ── Popover ── */
        .hdp-pop {
          position: absolute;
          top: calc(100% + 0.375rem);
          left: 0;
          z-index: 1000;
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 0.875rem;
          padding: 0.75rem;
          width: 17.5rem;
          box-shadow: 0 12px 40px rgba(0,0,0,0.45);
          outline: none;
          animation: hdp-in 160ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1));
        }
        @keyframes hdp-in {
          from { opacity: 0; transform: translateY(-0.25rem); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .hdp-backdrop { display: none; }

        /* ── Month header ── */
        .hdp-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 0.5rem;
        }
        .hdp-month {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.9375rem;
          color: var(--text-primary, #e2dbd0);
          letter-spacing: 0.01em;
        }
        .hdp-nav {
          background: transparent;
          border: none;
          border-radius: 0.4375rem;
          color: var(--text-secondary, #a09689);
          font-size: 1.125rem;
          line-height: 1;
          width: 1.75rem;
          height: 1.75rem;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          --press-scale: 0.94;
        }
        .hdp-nav:hover { color: var(--amber-bright, #e3c49a); }

        /* ── Quick chips ── */
        .hdp-chips {
          display: flex;
          gap: 0.375rem;
          margin-bottom: 0.625rem;
        }
        .hdp-chip {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--text-secondary, #a09689);
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 999px;
          padding: 0.25rem 0.625rem;
          cursor: pointer;
          transition: color var(--tx-color, 150ms), border-color var(--tx-color, 150ms), background var(--tx-color, 150ms);
          --press-scale: 0.96;
        }
        .hdp-chip:hover {
          color: var(--amber-bright, #e3c49a);
          border-color: rgba(201,168,124,0.30);
          background: var(--amber-subtle, rgba(201,168,124,0.06));
        }
        .hdp-chip.active {
          color: var(--amber-bright, #e3c49a);
          border-color: rgba(201,168,124,0.45);
        }
        .tone-lavender .hdp-chip:hover,
        .tone-lavender .hdp-chip.active {
          color: var(--lavender-bright, #c4b5e3);
          border-color: rgba(168,147,192,0.45);
          background: var(--lavender-subtle, rgba(168,147,192,0.06));
        }

        /* ── Day-of-week header row ── */
        .hdp-dow {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          margin-bottom: 0.125rem;
        }
        .hdp-dow span {
          text-align: center;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          color: var(--text-muted, #6a6258);
          padding: 0.25rem 0;
          user-select: none;
        }

        /* ── Day grid ── */
        .hdp-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.125rem;
        }
        .hdp-blank { aspect-ratio: 1; }
        .hdp-day {
          position: relative;
          aspect-ratio: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8125rem;
          font-variant-numeric: tabular-nums;
          color: var(--text-secondary, #a09689);
          background: transparent;
          border: none;
          border-radius: 0.4375rem;
          cursor: pointer;
          transition: background-color var(--tx-color, 150ms), color var(--tx-color, 150ms), box-shadow var(--tx-color, 150ms);
        }
        .hdp-day:hover { background: rgba(255,255,255,0.05); color: var(--text-primary, #e2dbd0); }
        .hdp-day.cursor {
          background: rgba(255,255,255,0.05);
          color: var(--text-primary, #e2dbd0);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14);
        }

        /* today — amber ring */
        .hdp-day.today {
          box-shadow: inset 0 0 0 1.5px rgba(201,168,124,0.55);
          color: var(--amber-bright, #e3c49a);
        }
        .hdp-day.today.cursor {
          box-shadow: inset 0 0 0 1.5px rgba(201,168,124,0.75);
        }

        /* selected — filled (amber default, lavender via tone) */
        .hdp-day.selected {
          background: rgba(201,168,124,0.85);
          color: #16130e;
          font-weight: 600;
        }
        .hdp-day.selected:hover { background: var(--amber-bright, #e3c49a); }
        .tone-lavender .hdp-day.selected {
          background: rgba(168,147,192,0.85);
          color: #131019;
        }
        .tone-lavender .hdp-day.selected:hover { background: var(--lavender-bright, #c4b5e3); }
        .tone-lavender .hdp-day.today {
          box-shadow: inset 0 0 0 1.5px rgba(201,168,124,0.55); /* today stays amber even in lavender tone */
        }

        /* ── Cycle marks ── faint rose dot (period), gold underline (fertile) */
        .hdp-dot {
          position: absolute;
          bottom: 0.1875rem;
          left: 50%;
          transform: translateX(-50%);
          width: 0.25rem;
          height: 0.25rem;
          border-radius: 50%;
          background: rgba(201,122,143,0.55);
          pointer-events: none;
        }
        .hdp-day.selected .hdp-dot { background: rgba(92,32,48,0.65); }
        .hdp-day.mark-fertile::after {
          content: '';
          position: absolute;
          bottom: 0.09375rem;
          left: 22%;
          right: 22%;
          height: 1.5px;
          border-radius: 1px;
          background: rgba(196,168,114,0.65);
          pointer-events: none;
        }

        /* ── Bottom sheet <600px ── */
        @media (max-width: 600px) {
          .hdp-backdrop {
            display: block;
            position: fixed;
            inset: 0;
            z-index: 999;
            background: rgba(0,0,0,0.45);
            animation: hdp-fade 200ms ease;
          }
          @keyframes hdp-fade { from { opacity: 0; } to { opacity: 1; } }
          .hdp-pop {
            position: fixed;
            top: auto;
            left: 0;
            right: 0;
            bottom: 0;
            width: auto;
            border-radius: 1.125rem 1.125rem 0 0;
            border-left: none;
            border-right: none;
            border-bottom: none;
            padding: 1rem 1rem calc(1rem + env(safe-area-inset-bottom, 0px));
            animation: hdp-sheet-in 240ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1));
          }
          @keyframes hdp-sheet-in {
            from { transform: translateY(1.5rem); opacity: 0.6; }
            to   { transform: translateY(0); opacity: 1; }
          }
          .hdp-trigger { font-size: 1rem; }   /* 16px — prevents iOS zoom */
          .hdp-month   { font-size: 1.0625rem; }
          .hdp-day     { font-size: 1rem; }
          .hdp-chip    { font-size: 0.8125rem; padding: 0.375rem 0.875rem; }
          .hdp-dow span { font-size: 0.75rem; }
        }
      `}</style>
    </div>
  );
}

export default HearthDatePicker;
