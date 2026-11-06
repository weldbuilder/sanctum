/**
 * CommandPalette — global Cmd/Ctrl+K overlay.
 *
 * A dim-backdrop modal with a fuzzy-filterable list of navigation actions
 * (Home, Chat, Canvas, Files, Settings) plus quick links into Settings.
 * Navigation uses react-router's useNavigate — no chat-store dependency.
 *
 * Keyboard: Cmd/Ctrl+K toggles (listener mounted in App.tsx), Esc closes,
 * ArrowUp/ArrowDown move the selection, Enter activates.
 *
 * Mounted once inside AppShell. Self-contained: owns its own open state via
 * a CustomEvent ('sanctum:command-palette') dispatched from App.tsx's keydown.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// ─── Command shape ──────────────────────────────────────────────────────────────

interface Command {
  id: string;
  name: string;
  description: string;
  group: 'navigate' | 'settings';
  /** route to navigate to */
  to: string;
  keywords?: string;
}

export const COMMANDS: Command[] = [
  // ── Navigate ──
  { id: 'nav-home',     name: 'Home',     description: 'Mantelpiece — presence & the day',  group: 'navigate', to: '/home',     keywords: 'mantelpiece orb presence' },
  { id: 'nav-chat',     name: 'Chat',     description: 'Open the conversation',             group: 'navigate', to: '/chat',     keywords: 'talk message conversation' },
  { id: 'nav-canvas',   name: 'Canvas',   description: 'Shared documents & artifacts',      group: 'navigate', to: '/canvas',   keywords: 'document artifact write' },
  { id: 'nav-files',    name: 'Files',    description: 'Browse the workspace',              group: 'navigate', to: '/files',    keywords: 'workspace browse folder' },
  { id: 'nav-settings', name: 'Settings', description: 'Preferences & configuration',       group: 'navigate', to: '/settings', keywords: 'config preferences options' },

  // ── Settings quick links (one per Settings tab; ?tab= opens it) ──
  { id: 'set-you',         name: 'You & them',  description: 'Names, time, identity files',          group: 'settings', to: '/settings?tab=you',         keywords: 'identity name timezone companion profile ratify' },
  { id: 'set-mind',        name: 'Mind',        description: 'Model, memory, summaries, pictures',   group: 'settings', to: '/settings?tab=mind',        keywords: 'model memory summarizer pictures effort prompt revien' },
  { id: 'set-rhythm',      name: 'Rhythm',      description: 'Check-ins, handoff, watchtower',       group: 'settings', to: '/settings?tab=rhythm',      keywords: 'orchestrator wake cycle schedule autonomous handoff' },
  { id: 'set-channels',    name: 'Channels',    description: 'Discord, Telegram, voice',             group: 'settings', to: '/settings?tab=channels',    keywords: 'discord telegram voice integration channel' },
  { id: 'set-permissions', name: 'Permissions', description: 'What the companion may do',            group: 'settings', to: '/settings?tab=permissions', keywords: 'consent guard pin grant receipts write access plugins' },
  { id: 'set-look',        name: 'Look',        description: 'Room, material, readability',          group: 'settings', to: '/settings?tab=look',        keywords: 'appearance theme colour color visual skin' },
  { id: 'set-status',      name: 'Status',      description: 'Skills, MCPs, usage, logs',            group: 'settings', to: '/settings?tab=status',      keywords: 'skills mcp servers usage tokens cost logs health google update' },
];

const GROUP_LABELS: Record<Command['group'], string> = {
  navigate: 'Navigate',
  settings: 'Settings',
};

// ─── Fuzzy filter ───────────────────────────────────────────────────────────────

function matches(cmd: Command, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const hay = `${cmd.name} ${cmd.description} ${cmd.keywords ?? ''}`.toLowerCase();
  // Subsequence match — every query char appears in order somewhere in haystack.
  let i = 0;
  for (const ch of hay) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  // Fall back to plain substring (catches when subsequence skips spaces oddly).
  return hay.includes(q);
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ── Listen for the toggle event dispatched from App.tsx ──
  useEffect(() => {
    function onToggle() {
      setOpen(prev => {
        const next = !prev;
        if (next) { setQuery(''); setSelected(0); }
        return next;
      });
    }
    window.addEventListener('sanctum:command-palette', onToggle as EventListener);
    return () => window.removeEventListener('sanctum:command-palette', onToggle as EventListener);
  }, []);

  // ── Focus the input when opened ──
  useEffect(() => {
    if (open) {
      // defer so the element exists & is mounted
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  // ── Filtered + grouped results ──
  const results = useMemo(() => COMMANDS.filter(c => matches(c, query)), [query]);

  // Reset selection when the result set changes (clamp).
  useEffect(() => {
    setSelected(s => (s >= results.length ? 0 : s));
  }, [results.length]);

  const activate = useCallback((cmd: Command | undefined) => {
    if (!cmd) return;
    navigate(cmd.to);
    setOpen(false);
  }, [navigate]);

  // ── Keyboard handling inside the modal ──
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelected(s => results.length ? (s + 1) % results.length : 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelected(s => results.length ? (s - 1 + results.length) % results.length : 0);
        break;
      case 'Enter':
        e.preventDefault();
        activate(results[selected]);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
    }
  }, [results, selected, activate, close]);

  // ── Scroll selected into view ──
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-cp-index="${selected}"]`);
    if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [selected, open]);

  if (!open) return null;

  // Build a render list with group headers, tracking the flat selectable index.
  let flatIndex = -1;
  let lastGroup: Command['group'] | null = null;

  return (
    <div
      className="cp-overlay"
      onMouseDown={e => { if (e.target === e.currentTarget) close(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="cp-modal" onKeyDown={onKeyDown}>
        <div className="cp-search-row">
          <svg className="cp-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className="cp-input"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected(0); }}
            placeholder="Jump to…"
            aria-label="Search commands"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="cp-esc">esc</kbd>
        </div>

        <div className="cp-list" ref={listRef} role="listbox">
          {results.length === 0 ? (
            <div className="cp-empty">No matches</div>
          ) : (
            results.map(cmd => {
              flatIndex++;
              const thisIndex = flatIndex;
              const showHeader = cmd.group !== lastGroup;
              lastGroup = cmd.group;
              const isSel = thisIndex === selected;
              return (
                <React.Fragment key={cmd.id}>
                  {showHeader && (
                    <div className="cp-group-header">{GROUP_LABELS[cmd.group]}</div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    data-cp-index={thisIndex}
                    className={`cp-item${isSel ? ' selected' : ''}`}
                    onMouseEnter={() => setSelected(thisIndex)}
                    onClick={() => activate(cmd)}
                  >
                    <span className="cp-item-name">{cmd.name}</span>
                    <span className="cp-item-desc">{cmd.description}</span>
                    {isSel && <span className="cp-item-enter" aria-hidden="true">↵</span>}
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>
      </div>

      <style>{`
        .cp-overlay {
          position: fixed;
          inset: 0;
          z-index: 1000;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding-top: 14vh;
          background: rgba(8, 7, 6, 0.62);
          backdrop-filter: blur(2px);
          animation: cpFade 160ms var(--hearth-curve, ease) both;
        }

        @keyframes cpFade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }

        .cp-modal {
          width: min(33rem, calc(100vw - 2rem));
          max-height: 60vh;
          display: flex;
          flex-direction: column;
          background: var(--bg-secondary, #131210);
          border: 1px solid rgba(201, 168, 124, 0.14);
          border-radius: var(--radius-card, 1.125rem);
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0,0,0,0.3);
          overflow: hidden;
          animation: cpRise 200ms var(--hearth-curve, ease) both;
          isolation: isolate;
        }

        @keyframes cpRise {
          from { opacity: 0; transform: translateY(-0.5rem) scale(0.985); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        .cp-search-row {
          display: flex;
          align-items: center;
          gap: 0.625rem;
          padding: 0.875rem 1rem;
          border-bottom: 1px solid rgba(201, 168, 124, 0.08);
          flex-shrink: 0;
        }
        .cp-search-icon {
          color: var(--text-muted, #6a6258);
          flex-shrink: 0;
        }
        .cp-input {
          flex: 1;
          min-width: 0;
          background: transparent;
          border: none;
          outline: none;
          color: var(--text-primary, #e2dbd0);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 1.0625rem;
          letter-spacing: -0.005em;
        }
        .cp-input::placeholder {
          color: var(--text-muted, #6a6258);
          font-style: italic;
        }
        .cp-esc {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--text-muted, #6a6258);
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 0.3125rem;
          padding: 0.125rem 0.375rem;
          flex-shrink: 0;
        }

        .cp-list {
          overflow-y: auto;
          padding: 0.4375rem;
          flex: 1;
          min-height: 0;
        }

        .cp-group-header {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          color: var(--text-muted, #6a6258);
          padding: 0.625rem 0.625rem 0.3125rem;
        }
        .cp-group-header:first-child { padding-top: 0.25rem; }

        .cp-item {
          position: relative;
          display: flex;
          align-items: baseline;
          gap: 0.625rem;
          width: 100%;
          padding: 0.5rem 0.625rem;
          border-radius: 0.625rem;
          background: transparent;
          border: none;
          cursor: pointer;
          text-align: left;
          color: var(--text-secondary, #a09689);
          transition: background 180ms var(--hearth-curve, ease), color 180ms var(--hearth-curve, ease);
          isolation: isolate;
        }
        .cp-item.selected {
          background: rgba(201, 168, 124, 0.12);
          color: var(--amber-bright, #e3c49a);
        }
        .cp-item.selected::before {
          content: '';
          position: absolute;
          left: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 2px;
          height: 56%;
          background: var(--amber, #c9a87c);
          border-radius: 1px;
          box-shadow: 0 0 8px rgba(201, 168, 124, 0.5);
        }

        .cp-item-name {
          font-size: 0.875rem;
          font-weight: 500;
          color: inherit;
          flex-shrink: 0;
        }
        .cp-item.selected .cp-item-name {
          color: var(--amber-bright, #e3c49a);
        }
        .cp-item-desc {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 0.75rem;
          color: var(--text-muted, #6a6258);
        }
        .cp-item-enter {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          color: var(--amber, #c9a87c);
          flex-shrink: 0;
        }

        .cp-empty {
          padding: 1.5rem 0.625rem;
          text-align: center;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.875rem;
          color: var(--text-muted, #6a6258);
        }

        .cp-list::-webkit-scrollbar { width: 5px; }
        .cp-list::-webkit-scrollbar-track { background: transparent; }
        .cp-list::-webkit-scrollbar-thumb {
          background: rgba(201, 168, 124, 0.15);
          border-radius: 3px;
        }
      `}</style>
    </div>
  );
}
