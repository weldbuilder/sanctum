/**
 * HearthTimePicker — Hearth-styled replacement for <input type="time">.
 *
 * Lifted verbatim from settings/OrchestratorSection.tsx (the original home);
 * this is now the canonical copy. Two clamped segment fields (HH / MM).
 * Stores + emits an "HH:MM" 24h string just like the native input did.
 * Keyboard: arrow up/down increments/decrements the focused segment.
 * Click on up/down affordance buttons also increments/decrements.
 * The colon separator is purely decorative — not an input.
 *
 * Visual language: warm obsidian bg, amber border on focus, mono digits,
 * 100ms press-give on affordance buttons, 150ms focus transition.
 *
 * New here: `compact` size variant — tighter digits + affordances for dense
 * rows (cockpit inline forms).
 */
import React, { useState } from 'react';

function clampHour(v: number): number { return ((v % 24) + 24) % 24; }
function clampMin(v: number): number  { return ((v % 60) + 60) % 60; }
function pad2(n: number): string      { return String(n).padStart(2, '0'); }

export interface HearthTimePickerProps {
  value: string;               // "HH:MM"
  onChange: (v: string) => void;
  compact?: boolean;           // tighter size variant
}

export function HearthTimePicker({
  value,
  onChange,
  compact = false,
}: HearthTimePickerProps) {
  // Parse incoming value
  const [hh, mm] = value.split(':');
  const h = parseInt(hh, 10) || 0;
  const m = parseInt(mm, 10) || 0;

  const [focusedSeg, setFocusedSeg] = useState<'h' | 'm' | null>(null);

  // When typing into a segment we collect a raw string, then apply on blur/enter
  const [rawH, setRawH] = useState<string | null>(null);
  const [rawM, setRawM] = useState<string | null>(null);

  const commitH = (raw: string) => {
    const n = parseInt(raw, 10);
    const clamped = isNaN(n) ? h : clampHour(n);
    onChange(`${pad2(clamped)}:${pad2(m)}`);
    setRawH(null);
  };
  const commitM = (raw: string) => {
    const n = parseInt(raw, 10);
    const clamped = isNaN(n) ? m : clampMin(n);
    onChange(`${pad2(h)}:${pad2(clamped)}`);
    setRawM(null);
  };

  const stepH = (dir: 1 | -1) => onChange(`${pad2(clampHour(h + dir))}:${pad2(m)}`);
  const stepM = (dir: 1 | -1) => onChange(`${pad2(h)}:${pad2(clampMin(m + dir))}`);

  const handleKeyH = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp')   { e.preventDefault(); stepH(1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); stepH(-1); }
    if (e.key === 'Enter' && rawH !== null) commitH(rawH);
  };
  const handleKeyM = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp')   { e.preventDefault(); stepM(1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); stepM(-1); }
    if (e.key === 'Enter' && rawM !== null) commitM(rawM);
  };

  const displayH = rawH !== null ? rawH : pad2(h);
  const displayM = rawM !== null ? rawM : pad2(m);

  return (
    <div className={`htp-root${compact ? ' htp-compact' : ''}`} aria-label="Time picker">
      {/* Hour segment */}
      <div className={`htp-seg${focusedSeg === 'h' ? ' focused' : ''}`}>
        <button
          className="htp-step htp-step-up"
          tabIndex={-1}
          aria-label="Increase hour"
          onMouseDown={e => { e.preventDefault(); stepH(1); }}
        >▴</button>
        <input
          className="htp-digit"
          type="text"
          inputMode="numeric"
          value={displayH}
          aria-label="Hour (00–23)"
          onFocus={() => { setFocusedSeg('h'); setRawH(pad2(h)); }}
          onBlur={() => { setFocusedSeg(null); if (rawH !== null) commitH(rawH); }}
          onChange={e => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 2);
            setRawH(v);
            // Auto-commit when the user types a two-digit value that is valid
            if (v.length === 2) commitH(v);
          }}
          onKeyDown={handleKeyH}
        />
        <button
          className="htp-step htp-step-down"
          tabIndex={-1}
          aria-label="Decrease hour"
          onMouseDown={e => { e.preventDefault(); stepH(-1); }}
        >▾</button>
      </div>

      {/* Separator */}
      <span className="htp-sep" aria-hidden>:</span>

      {/* Minute segment */}
      <div className={`htp-seg${focusedSeg === 'm' ? ' focused' : ''}`}>
        <button
          className="htp-step htp-step-up"
          tabIndex={-1}
          aria-label="Increase minute"
          onMouseDown={e => { e.preventDefault(); stepM(1); }}
        >▴</button>
        <input
          className="htp-digit"
          type="text"
          inputMode="numeric"
          value={displayM}
          aria-label="Minute (00–59)"
          onFocus={() => { setFocusedSeg('m'); setRawM(pad2(m)); }}
          onBlur={() => { setFocusedSeg(null); if (rawM !== null) commitM(rawM); }}
          onChange={e => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 2);
            setRawM(v);
            if (v.length === 2) commitM(v);
          }}
          onKeyDown={handleKeyM}
        />
        <button
          className="htp-step htp-step-down"
          tabIndex={-1}
          aria-label="Decrease minute"
          onMouseDown={e => { e.preventDefault(); stepM(-1); }}
        >▾</button>
      </div>

      <style>{`
        .htp-root {
          display: inline-flex;
          align-items: center;
          gap: 0.125rem;
        }

        .htp-seg {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0;
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 0.4375rem;
          background: rgba(12, 11, 9, 0.55);
          transition: border-color 150ms ease, box-shadow 150ms ease;
          overflow: hidden;
        }
        .htp-seg.focused {
          border-color: rgba(201,168,124,0.55);
          box-shadow: 0 0 0 3px rgba(201,168,124,0.09);
        }

        .htp-digit {
          width: 2.5rem;
          text-align: center;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 1rem;
          font-variant-numeric: tabular-nums;
          color: var(--text-primary, #e2dbd0);
          background: transparent;
          border: none;
          outline: none;
          padding: 0.25rem 0;
          line-height: 1;
          caret-color: var(--amber, #c9a87c);
        }
        .htp-digit:focus { color: var(--amber-bright, #e3c49a); }
        /* Hide native number-input spinners if they appear */
        .htp-digit::-webkit-inner-spin-button,
        .htp-digit::-webkit-outer-spin-button { -webkit-appearance: none; }

        .htp-step {
          width: 100%;
          background: transparent;
          border: none;
          color: var(--text-muted, #6a6258);
          font-size: 0.5rem;
          line-height: 1;
          padding: 0.1875rem 0;
          cursor: pointer;
          transition: color 100ms ease, transform 100ms ease;
          display: flex;
          align-items: center;
          justify-content: center;
          user-select: none;
        }
        .htp-step:hover { color: var(--text-secondary, #a09689); }
        .htp-step:active { transform: scale(0.985) translateY(0.5px); color: var(--amber, #c9a87c); }

        .htp-sep {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 1rem;
          color: var(--text-muted, #6a6258);
          padding: 0 0.125rem;
          padding-bottom: 0.25rem; /* optical alignment with digit baseline */
          user-select: none;
        }

        /* ── Compact variant ── tighter digits + affordances for dense rows */
        .htp-compact .htp-digit {
          width: 2rem;
          font-size: 0.875rem;
          padding: 0.1875rem 0;
        }
        .htp-compact .htp-step {
          font-size: 0.4375rem;
          padding: 0.125rem 0;
        }
        .htp-compact .htp-sep {
          font-size: 0.875rem;
          padding-bottom: 0.1875rem;
        }
      `}</style>
    </div>
  );
}

export default HearthTimePicker;
