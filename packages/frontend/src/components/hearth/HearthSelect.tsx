/**
 * HearthSelect — Hearth-styled replacement for native <select>.
 *
 * Trigger styled like the existing form inputs (.sp-form-input / .cmd-input).
 * Opens a backdrop-glass listbox popover: hearth-hover rows, amber ✓ on the
 * selected option, optional sublabels. role=listbox ARIA with roving focus
 * (aria-activedescendant) + type-ahead. value/onChange contract is drop-in
 * compatible with native select swaps.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface HearthSelectOption {
  value: string;
  label: string;
  sublabel?: string;
  disabled?: boolean;
}

export interface HearthSelectProps {
  value: string;
  onChange: (v: string) => void;
  options: HearthSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** Mono trigger text (for model ids, cron-ish values). */
  mono?: boolean;
  /** Full-width trigger (matches .sp-form-input's width: 100%). */
  block?: boolean;
}

export function HearthSelect({
  value,
  onChange,
  options,
  placeholder = 'select…',
  disabled = false,
  ariaLabel,
  mono = false,
  block = false,
}: HearthSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  // Fixed-position box for the portaled listbox — anchored to the trigger's
  // viewport rect. Portaling to <body> escapes the chat-header's stacking
  // context (backdrop-filter) and any overflow clip, so the popover is never
  // hidden behind chat bubbles and always scrolls its full list. null until first measure.
  const [box, setBox] = useState<{
    left: number; width: number; maxHeight: number;
    top?: number; bottom?: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeahead = useRef<{ buf: string; t: number }>({ buf: '', t: 0 });
  const baseId = useId();

  // Measure the trigger and place the popover (below by default; flips above
  // when there isn't room; clamped to the viewport horizontally).
  const reposition = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const GAP = 6;
    const MARGIN = 8;
    const width = Math.min(Math.max(r.width, 176), 320);
    let left = r.left;
    if (left + width > vw - MARGIN) left = vw - MARGIN - width;
    if (left < MARGIN) left = MARGIN;
    const spaceBelow = vh - r.bottom - GAP - MARGIN;
    const spaceAbove = r.top - GAP - MARGIN;
    const openUp = spaceBelow < 176 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(256, openUp ? spaceAbove : spaceBelow));
    setBox(openUp
      ? { left, width, maxHeight, bottom: vh - r.top + GAP }
      : { left, width, maxHeight, top: r.bottom + GAP });
  }, []);

  const selectedIdx = useMemo(
    () => options.findIndex(o => o.value === value),
    [options, value],
  );
  const selected = selectedIdx >= 0 ? options[selectedIdx] : null;

  // On open: measure position before paint (no flash) then activate the
  // selected option (or first enabled) and focus the list.
  useLayoutEffect(() => {
    if (!open) { setBox(null); return; }
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const start = selectedIdx >= 0 ? selectedIdx : options.findIndex(o => !o.disabled);
    setActiveIdx(start);
    requestAnimationFrame(() => {
      listRef.current?.focus();
      if (start >= 0) {
        listRef.current
          ?.querySelector(`#${CSS.escape(`${baseId}-opt-${start}`)}`)
          ?.scrollIntoView({ block: 'nearest' });
      }
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the popover glued to the trigger while open (scroll/resize).
  useEffect(() => {
    if (!open) return;
    const onMove = () => reposition();
    window.addEventListener('scroll', onMove, true); // capture: catch scrolls in any ancestor
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, reposition]);

  // Outside click closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The listbox is portaled to <body>, so it is NOT inside rootRef — check both.
      if (rootRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const commit = (idx: number) => {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    close();
  };

  const moveActive = (dir: 1 | -1) => {
    if (options.length === 0) return;
    setActiveIdx(prev => {
      let i = prev;
      for (let step = 0; step < options.length; step++) {
        i = (i + dir + options.length) % options.length;
        if (!options[i].disabled) break;
      }
      scrollToIdx(i);
      return i;
    });
  };

  const scrollToIdx = (i: number) => {
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`#${CSS.escape(`${baseId}-opt-${i}`)}`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  };

  const handleTypeahead = (key: string) => {
    const now = Date.now();
    const ta = typeahead.current;
    ta.buf = now - ta.t > 600 ? key : ta.buf + key;
    ta.t = now;
    const needle = ta.buf.toLowerCase();
    const startFrom = activeIdx >= 0 ? activeIdx : 0;
    for (let step = 0; step < options.length; step++) {
      // Start searching at the active option when extending the buffer, or
      // just after it when starting fresh — matches native select feel.
      const offset = ta.buf.length > 1 ? step : step + 1;
      const i = (startFrom + offset) % options.length;
      const opt = options[i];
      if (!opt.disabled && opt.label.toLowerCase().startsWith(needle)) {
        setActiveIdx(i);
        scrollToIdx(i);
        return;
      }
    }
  };

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveActive(1); break;
      case 'ArrowUp':   e.preventDefault(); moveActive(-1); break;
      case 'Home': {
        e.preventDefault();
        const i = options.findIndex(o => !o.disabled);
        if (i >= 0) { setActiveIdx(i); scrollToIdx(i); }
        break;
      }
      case 'End': {
        e.preventDefault();
        for (let i = options.length - 1; i >= 0; i--) {
          if (!options[i].disabled) { setActiveIdx(i); scrollToIdx(i); break; }
        }
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (activeIdx >= 0) commit(activeIdx);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        close(false);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          handleTypeahead(e.key);
        }
    }
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div className={`hsel-root${block ? ' block' : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`hsel-trigger${mono ? ' mono' : ''}${selected ? '' : ' empty'}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="hsel-trigger-text">{selected ? selected.label : placeholder}</span>
        <span className="hsel-trigger-glyph" aria-hidden>▾</span>
      </button>

      {open && box && createPortal(
        <ul
          ref={listRef}
          className="hsel-list backdrop-glass"
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={activeIdx >= 0 ? `${baseId}-opt-${activeIdx}` : undefined}
          tabIndex={-1}
          onKeyDown={handleListKeyDown}
          style={{
            left: box.left,
            width: box.width,
            maxHeight: box.maxHeight,
            ...(box.top !== undefined ? { top: box.top } : {}),
            ...(box.bottom !== undefined ? { bottom: box.bottom } : {}),
          }}
        >
          {options.map((opt, i) => (
            <li
              key={opt.value}
              id={`${baseId}-opt-${i}`}
              role="option"
              aria-selected={opt.value === value}
              aria-disabled={opt.disabled || undefined}
              className={[
                'hsel-opt',
                'hearth-hover',
                opt.value === value ? 'selected' : '',
                i === activeIdx ? 'active' : '',
                opt.disabled ? 'disabled' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => commit(i)}
              onMouseEnter={() => !opt.disabled && setActiveIdx(i)}
            >
              <span className="hsel-opt-main">
                <span className="hsel-opt-label">{opt.label}</span>
                {opt.sublabel && <span className="hsel-opt-sub">{opt.sublabel}</span>}
              </span>
              {opt.value === value && <span className="hsel-check" aria-hidden>✓</span>}
            </li>
          ))}
          {options.length === 0 && (
            <li className="hsel-empty" aria-disabled>no options</li>
          )}
        </ul>,
        document.body,
      )}

      <style>{`
        .hsel-root {
          position: relative;
          display: inline-block;
        }
        .hsel-root.block { display: block; width: 100%; }

        /* ── Trigger — matches .sp-form-input / .cmd-input ── */
        .hsel-trigger {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          justify-content: space-between;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.875rem;
          color: var(--text-primary, #e2dbd0);
          background: var(--bg-input, #0f0e0c);
          border: 1px solid var(--field-border, rgba(255,255,255,0.08));
          border-radius: 0.5rem;
          padding: 0.4375rem 0.75rem;
          cursor: pointer;
          transition: border-color var(--tx-color, 150ms ease);
          min-width: 6rem;
          text-align: left;
        }
        .hsel-root.block .hsel-trigger { display: flex; width: 100%; }
        .hsel-trigger.mono .hsel-trigger-text {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8125rem;
        }
        .hsel-trigger:hover:not(:disabled) { border-color: var(--btn-border-muted-hover, rgba(255,255,255,0.14)); }
        .hsel-trigger:focus-visible {
          outline: 2px solid var(--focus-ring, rgba(201,168,124,0.45));
          outline-offset: 2px;
          border-color: var(--focus-ring, rgba(201,168,124,0.45));
          box-shadow: 0 0 0 3px rgba(201,168,124,0.09);
        }
        .hsel-trigger:disabled { background: var(--settings-disabled-bg, rgba(255,255,255,0.05)); color: var(--settings-disabled-text, #b7a98f); cursor: default; }
        .hsel-trigger.empty .hsel-trigger-text { color: var(--text-muted, #6a6258); }
        .hsel-trigger-text {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .hsel-trigger-glyph {
          font-size: 0.625rem;
          color: var(--text-muted, #6a6258);
          flex-shrink: 0;
          user-select: none;
        }

        /* ── Listbox popover ──
           Portaled to <body> and fixed-positioned from the trigger's viewport
           rect (left/top/bottom/width/max-height set inline). z-index sits above
           app chrome so the chat-header's backdrop-filter stacking context can
           never bury it behind message bubbles. */
        .hsel-list {
          position: fixed;
          z-index: 9600;
          max-width: 20rem;
          overflow-y: auto;
          margin: 0;
          padding: 0.3125rem;
          list-style: none;
          border: 1px solid var(--surface-popover-border, rgba(255,255,255,0.10));
          border-radius: 0.75rem;
          box-shadow: 0 12px 40px rgba(0,0,0,0.45);
          outline: none;
          animation: hsel-in 160ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1));
        }
        @keyframes hsel-in {
          from { opacity: 0; transform: translateY(-0.25rem); }
          to   { opacity: 1; transform: translateY(0); }
        }

        /* ── Option rows ── */
        .hsel-opt {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          padding: 0.4375rem 0.625rem;
          border-radius: 0.5rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 1rem;
          color: var(--text-secondary, #a09689);
          cursor: pointer;
          user-select: none;
        }
        .hsel-opt.active {
          background-color: var(--amber-subtle, rgba(201,168,124,0.06));
          color: var(--text-primary, #e2dbd0);
        }
        .hsel-opt.selected { color: var(--text-primary, #e2dbd0); }
        .hsel-opt.disabled { color: var(--text-muted, #6a6258); font-style: italic; cursor: default; }
        .hsel-opt-main {
          display: flex;
          flex-direction: column;
          gap: 0.0625rem;
          min-width: 0;
        }
        .hsel-opt-label {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .hsel-opt-sub {
          font-size: 0.8rem;
          color: var(--text-muted, #6a6258);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .hsel-check {
          color: var(--amber, #c9a87c);
          font-size: 0.8125rem;
          flex-shrink: 0;
        }
        .hsel-empty {
          padding: 0.4375rem 0.625rem;
          font-size: 0.8125rem;
          color: var(--text-muted, #6a6258);
          font-style: italic;
        }

        /* ── Mobile ── 16px fonts prevent iOS zoom */
        @media (max-width: 600px) {
          .hsel-trigger { font-size: 1rem; }
          .hsel-opt { font-size: 1rem; padding: 0.5625rem 0.75rem; }
          .hsel-opt-sub { font-size: 0.8rem; }
        }
      `}</style>
    </div>
  );
}

export default HearthSelect;
