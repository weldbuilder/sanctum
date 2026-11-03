import React, { useEffect, useCallback, useState, useRef } from 'react';
import { useIdentity, avatarSrc } from '../store/identity';
import { useChatStore, getStreamingInfo } from '../store/chat';
import { useShallow } from 'zustand/react/shallow';
import { MessageList } from './MessageList';
import { Composer, type PendingAttachment } from './Composer';
import type { EffortLevel, ThreadSummary } from '@sanctum/shared';
import { ConnectionStatus } from './ConnectionStatus';
import { ConnectionTabs } from './ConnectionTabs';
import { SearchPanel } from './SearchPanel';
import { useConfirm } from './ConfirmDialog';
import { SidebarSection } from './SidebarSection';
import { CanvasPanel } from './CanvasPanel';
import { HearthSelect, HearthDatePicker, HearthTimePicker } from './hearth';

import { BASE, storageKey } from '../lib/base';
const BASE_CV = BASE;

type ActiveTab = 'daily' | string;


// ─── Model / effort types ─────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
  label: string;
  tier?: string;
}

// Effort levels that the backend accepts
const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: '',      label: 'Default' },
  { value: 'low',   label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high',  label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max',   label: 'max' },
];

// ─── Model · effort strip ──────────────────────────────────────────────────────
// Sits inline in the chat header. Reads model/effort off the active thread
// (fields added by the parallel backend agent; optional-chained throughout).
// On change: PATCH /api/threads/:id. On WS thread_updated, the store already
// propagates model/effort so the select re-renders to the confirmed value.

function ModelEffortStrip({
  threadId,
  threadModel,
  threadEffort,
}: {
  threadId: string | null;
  threadModel: string | null | undefined;
  threadEffort: EffortLevel | null | undefined;
}) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  // saved flash: null = idle, 'model' | 'effort' = briefly show checkmark
  const [saved, setSaved] = useState<'model' | 'effort' | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch model list once
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch(`${BASE}/api/models`);
        if (!res.ok) return;
        const data = await res.json() as { models: ModelEntry[] };
        if (alive && Array.isArray(data?.models)) {
          setModels(data.models);
        }
      } catch { /* backend not up yet — strip just shows "Default" for all */ }
    }
    load();
    return () => { alive = false; };
  }, []);

  function flashSaved(which: 'model' | 'effort') {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaved(which);
    savedTimer.current = setTimeout(() => setSaved(null), 1200);
  }

  async function patch(field: 'model' | 'effort', value: string) {
    if (!threadId) return;
    try {
      const body: Record<string, string | null> = {};
      // Empty string → null (clear to default)
      body[field] = value === '' ? null : value;
      const res = await fetch(`${BASE}/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        flashSaved(field);
        // Optimistically update the store so the select reflects the new value
        // immediately (the WS thread_updated broadcast from the backend will
        // reconcile it; until then the local store is the source of truth).
        const threads = useChatStore.getState().threads;
        const coerced = value === '' ? null : value;
        const updated = threads.map(t => {
          if (t.id !== threadId) return t;
          if (field === 'model') return { ...t, model: coerced };
          // field === 'effort': cast to EffortLevel since we control the options
          return { ...t, effort: coerced as EffortLevel | null };
        });
        useChatStore.setState({ threads: updated });
      }
    } catch { /* network failure — select stays at last confirmed value */ }
  }

  // Don't render until we have a thread to act on
  if (!threadId) return null;

  const currentModel = threadModel ?? '';
  const currentEffort = threadEffort ?? '';

  return (
    <div className="model-effort-strip" aria-label="Thread model and effort">
      {/* Model picker */}
      <span className="me-label">
        {/* CPU-chip glyph — Unicode, no SVG weight */}
        <span className="me-glyph" aria-hidden="true">⬡</span>
      </span>
      <div className={`me-select-wrap${saved === 'model' ? ' me-saved' : ''}${currentModel ? ' me-overridden' : ''}`}>
        <HearthSelect
          value={currentModel}
          onChange={v => patch('model', v)}
          options={[
            { value: '', label: 'Default' },
            ...models.map(m => ({
              value: m.id,
              label: m.label,
              sublabel: m.tier && m.tier !== 'custom' ? m.tier : undefined,
            })),
          ]}
          ariaLabel="Thread model override"
          mono
        />
        {saved === 'model' && <span className="me-check" aria-hidden="true">✓</span>}
      </div>

      {/* Separator */}
      <span className="me-sep" aria-hidden="true" />

      {/* Effort picker */}
      <span className="me-label">
        <span className="me-glyph" aria-hidden="true">≡</span>
      </span>
      <div className={`me-select-wrap${saved === 'effort' ? ' me-saved' : ''}${currentEffort ? ' me-overridden' : ''}`}>
        <HearthSelect
          value={currentEffort}
          onChange={v => patch('effort', v)}
          options={EFFORT_OPTIONS}
          ariaLabel="Thread effort override"
          mono
        />
        {saved === 'effort' && <span className="me-check" aria-hidden="true">✓</span>}
      </div>

      <style>{`
        .model-effort-strip {
          display: flex;
          align-items: center;
          gap: 0.1875rem;
          flex-shrink: 0;
          margin-left: 0.375rem;
          /* Don't crowd the companion name — it wraps below on very narrow viewports */
        }

        /* Glyph label — purely visual, muted */
        .me-label {
          display: flex;
          align-items: center;
          cursor: default;
          flex-shrink: 0;
        }
        .me-glyph {
          font-size: 0.8rem;
          color: var(--text-muted, #6a6258);
          line-height: 1;
          letter-spacing: 0;
          transition: color 150ms var(--hearth-curve, cubic-bezier(0.25,0.46,0.45,0.94));
          user-select: none;
        }

        .me-select-wrap {
          position: relative;
          display: flex;
          align-items: center;
          flex-shrink: 0;
        }

        /* HearthSelect trigger, compacted for the header strip — invisible
           chrome, text-only feel (matches the old inline selects). Scoped
           with strip specificity so it wins over HearthSelect's base rules.
           Button triggers don't provoke iOS focus-zoom, so the small font is
           safe on mobile (the popover rows keep HearthSelect's 16px). */
        .model-effort-strip .hsel-trigger {
          background: transparent;
          border: none;
          border-bottom: 1px solid rgba(255,255,255,0.07);
          border-radius: 0.25rem;
          padding: 0.1875rem 0.3125rem;
          min-width: 3.5rem;
          max-width: 9rem;
          gap: 0.25rem;
        }
        .model-effort-strip .hsel-trigger .hsel-trigger-text,
        .model-effort-strip .hsel-trigger.mono .hsel-trigger-text {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8667rem;
          letter-spacing: 0.02em;
          color: var(--text-muted, #6a6258);
          transition: color 150ms var(--hearth-curve, cubic-bezier(0.25,0.46,0.45,0.94));
        }
        .model-effort-strip .hsel-trigger:hover:not(:disabled) {
          border-color: rgba(201,168,124,0.25);
        }
        .model-effort-strip .hsel-trigger:hover:not(:disabled) .hsel-trigger-text {
          color: var(--text-secondary, #a09689);
        }
        .model-effort-strip .hsel-trigger:focus-visible {
          box-shadow: none;
          border-color: rgba(201,168,124,0.55);
          background: rgba(201,168,124,0.04);
        }
        /* Non-default value gets a gentle amber tint to signal "overridden" */
        .model-effort-strip .me-select-wrap.me-overridden .hsel-trigger .hsel-trigger-text {
          color: var(--text-secondary);
        }

        /* Saved flash — the ✓ appears absolutely, the select gets a brief amber glow */
        .me-check {
          position: absolute;
          right: -0.875rem;
          top: 50%;
          transform: translateY(-50%);
          font-size: 0.8rem;
          color: var(--amber, #c9a87c);
          opacity: 1;
          animation: meCheckFade 1.2s ease forwards;
          pointer-events: none;
        }
        @keyframes meCheckFade {
          0%   { opacity: 0; transform: translateY(-50%) scale(0.7); }
          15%  { opacity: 1; transform: translateY(-50%) scale(1); }
          70%  { opacity: 1; }
          100% { opacity: 0; }
        }
        .model-effort-strip .me-select-wrap.me-saved .hsel-trigger {
          border-color: rgba(201,168,124,0.45);
        }
        .model-effort-strip .me-select-wrap.me-saved .hsel-trigger .hsel-trigger-text {
          color: var(--amber, #c9a87c);
        }

        /* Thin vertical rule between model and effort */
        .me-sep {
          width: 1px;
          height: 0.75rem;
          background: rgba(255,255,255,0.07);
          flex-shrink: 0;
          margin: 0 0.1875rem;
        }

        /* Mobile: tighten below 480px */
        @media (max-width: 480px) {
          .model-effort-strip .hsel-trigger {
            max-width: 7rem;
          }
          .model-effort-strip .hsel-trigger .hsel-trigger-text,
          .model-effort-strip .hsel-trigger.mono .hsel-trigger-text {
            font-size: 0.8667rem;
          }
          .model-effort-strip {
            margin-left: 0.25rem;
          }
          /* Popovers must not overflow the narrow header */
          .model-effort-strip .hsel-list {
            left: auto;
            right: 0;
            max-width: calc(100vw - 2rem);
          }
        }
      `}</style>
    </div>
  );
}

// ─── Show-thinking toggle ─────────────────────────────────────────────────────
// Eye glyph + ●ON / ○OFF. PATCHes /api/threads/:id on change.
// Gates the thinking TIMELINE only — tool pills remain visible regardless.

function ShowThinkingToggle({
  threadId,
  showThinking,
}: {
  threadId: string | null;
  showThinking: boolean;
}) {
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flashSaved() {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaved(true);
    savedTimer.current = setTimeout(() => setSaved(false), 1200);
  }

  async function toggle() {
    if (!threadId) return;
    const next = !showThinking;
    try {
      const res = await fetch(`${BASE_CV}/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_thinking: next }),
      });
      if (res.ok) {
        flashSaved();
        // Optimistic local update
        const threads = useChatStore.getState().threads;
        useChatStore.setState({
          threads: threads.map(t =>
            t.id === threadId ? { ...t, show_thinking: next } : t
          ),
        });
      }
    } catch { /* network failure — UI reverts on WS thread_updated */ }
  }

  if (!threadId) return null;

  return (
    <button
      className={`stt-btn${saved ? ' stt-saved' : ''}${showThinking ? ' stt-on' : ' stt-off'}`}
      onClick={toggle}
      title={showThinking ? 'Thinking visible — click to hide' : 'Thinking hidden — click to show'}
      aria-label={showThinking ? 'Hide thinking timeline' : 'Show thinking timeline'}
      aria-pressed={showThinking}
      type="button"
    >
      {/* Eye glyph */}
      <svg
        className="stt-eye"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
        {/* Strike-through when OFF */}
        {!showThinking && <line x1="2" y1="2" x2="22" y2="22" strokeWidth="1.75" />}
      </svg>
      {/* ●ON / ○OFF indicator */}
      <span className="stt-state" aria-hidden="true">
        {showThinking ? '●' : '○'}
      </span>
      {saved && <span className="stt-check" aria-hidden="true">✓</span>}

      <style>{`
        .stt-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.1875rem;
          padding: 0.125rem 0.3125rem;
          border-radius: 0.375rem;
          border: 1px solid transparent;
          cursor: pointer;
          background: transparent;
          position: relative;
          flex-shrink: 0;
          transition:
            color 150ms var(--hearth-curve, cubic-bezier(0.16, 1, 0.3, 1)),
            background 150ms var(--hearth-curve, cubic-bezier(0.16, 1, 0.3, 1)),
            border-color 150ms var(--hearth-curve, cubic-bezier(0.16, 1, 0.3, 1));
        }
        .stt-btn.stt-on {
          color: var(--amber-dim, #a08960);
          border-color: rgba(201, 168, 124, 0.15);
        }
        .stt-btn.stt-off {
          color: var(--text-muted, #6a6258);
          border-color: rgba(255, 255, 255, 0.05);
        }
        .stt-btn:hover {
          color: var(--text-secondary, #a09689);
          background: rgba(201, 168, 124, 0.06);
          border-color: rgba(201, 168, 124, 0.20);
        }
        .stt-btn:active {
          transform: scale(0.985) translateY(0.5px);
          transition: transform 100ms var(--hearth-curve, cubic-bezier(0.16, 1, 0.3, 1));
        }
        .stt-btn.stt-saved {
          color: var(--amber, #c9a87c);
          border-color: rgba(201, 168, 124, 0.40);
        }

        .stt-eye { flex-shrink: 0; }

        .stt-state {
          font-size: 0.6667rem;
          line-height: 1;
          letter-spacing: 0;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
        }
        .stt-on .stt-state { color: var(--amber, #c9a87c); opacity: 1; }
        .stt-off .stt-state { color: var(--text-muted, #6a6258); }

        .stt-check {
          position: absolute;
          right: -0.75rem;
          top: 50%;
          transform: translateY(-50%);
          font-size: 0.6667rem;
          color: var(--amber, #c9a87c);
          animation: sttCheckFade 1.2s ease forwards;
          pointer-events: none;
        }
        @keyframes sttCheckFade {
          0%   { opacity: 0; transform: translateY(-50%) scale(0.7); }
          15%  { opacity: 1; transform: translateY(-50%) scale(1); }
          70%  { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </button>
  );
}

// ─── Jump-to-datetime control ────────────────────────────────────────────────
// A compact clock-icon button. On click, opens a small inline date+time picker.
// On confirm: finds the first message whose created_at >= target datetime, scrolls
// its DOM element into view with a brief amber highlight pulse.

function JumpToDateTime({ messages }: { messages: import('@sanctum/shared').Message[] }) {
  const [open, setOpen] = useState(false);
  const [dateVal, setDateVal] = useState('');
  const [timeVal, setTimeVal] = useState('');
  const [notFound, setNotFound] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const notFoundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Dismiss on outside click or Escape
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  function handleJump() {
    if (!dateVal) return;
    // Build a target Date from the pickers. Time defaults to 00:00 if omitted.
    const isoString = `${dateVal}T${timeVal || '00:00'}:00`;
    const target = new Date(isoString).getTime();
    if (isNaN(target)) return;

    // Find first message whose created_at >= target
    const match = messages.find(m => {
      const t = new Date(m.created_at).getTime();
      return t >= target;
    });

    if (!match) {
      // If no message found at/after target, scroll to the last one
      const last = messages[messages.length - 1];
      if (last) {
        const el = document.getElementById(`msg-${last.id}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        pulseElement(el);
      } else {
        // nothing — briefly show "not found"
        setNotFound(true);
        if (notFoundTimer.current) clearTimeout(notFoundTimer.current);
        notFoundTimer.current = setTimeout(() => setNotFound(false), 2000);
        return;
      }
    } else {
      const el = document.getElementById(`msg-${match.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        pulseElement(el);
      }
    }
    setOpen(false);
  }

  function pulseElement(el: HTMLElement | null) {
    if (!el) return;
    el.classList.add('jtd-pulse');
    setTimeout(() => el.classList.remove('jtd-pulse'), 1200);
  }

  return (
    <div className="jtd-wrap" ref={panelRef}>
      <button
        className={`jtd-btn${open ? ' active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Jump to date & time"
        aria-label="Jump to date and time"
        aria-expanded={open}
        type="button"
      >
        {/* Clock icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      </button>

      {open && (
        <div className="jtd-panel" role="dialog" aria-label="Jump to date and time">
          <div className="jtd-row">
            <HearthDatePicker
              value={dateVal}
              onChange={setDateVal}
              ariaLabel="Date"
              placeholder="date"
            />
            <HearthTimePicker
              value={timeVal || '00:00'}
              onChange={setTimeVal}
              compact
            />
            <button
              className="jtd-go"
              onClick={handleJump}
              disabled={!dateVal}
              aria-label="Jump"
              type="button"
            >
              {notFound ? '—' : '↓'}
            </button>
          </div>
          {notFound && (
            <span className="jtd-not-found">no messages found</span>
          )}
        </div>
      )}

      <style>{`
        .jtd-wrap {
          position: relative;
          flex-shrink: 0;
        }
        .jtd-btn {
          display: grid;
          place-items: center;
          width: 1.75rem;
          height: 1.75rem;
          color: var(--text-muted, #6a6258);
          border-radius: 0.375rem;
          position: relative;
          isolation: isolate;
          transition: color var(--tx-fast, 240ms ease);
          border: none;
          background: transparent;
          cursor: pointer;
        }
        .jtd-btn::before {
          content: '';
          position: absolute; inset: 0;
          border-radius: inherit;
          z-index: -1;
          opacity: 0;
          background: radial-gradient(circle, var(--amber-glow, rgba(201,168,124,0.18)), transparent 70%);
          transition: opacity var(--tx-base, 380ms ease);
        }
        .jtd-btn:hover { color: var(--text-primary, #e2dbd0); }
        .jtd-btn:hover::before { opacity: 1; }
        .jtd-btn.active { color: var(--amber, #c9a87c); }
        .jtd-btn.active::before { opacity: 0.7; }
        .jtd-btn:active {
          transform: scale(0.985) translateY(0.5px);
          transition: transform 100ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }

        .jtd-panel {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          padding: 0.5rem;
          background: var(--surface-popover, #faf4e5);
          border: 1px solid var(--surface-popover-border, rgba(201, 168, 124, 0.16));
          border-radius: 0.625rem;
          box-shadow:
            0 0 0 1px rgba(0, 0, 0, 0.35),
            0 8px 24px rgba(0, 0, 0, 0.5),
            0 2px 6px rgba(0, 0, 0, 0.3);
          backdrop-filter: blur(12px);
          z-index: 200;
          animation: jtdIn 120ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)) both;
          min-width: 16rem;
          max-width: calc(100vw - 1rem);
        }
        @keyframes jtdIn {
          from { opacity: 0; transform: scale(0.95) translateY(-4px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }

        .jtd-row {
          display: flex;
          align-items: center;
          gap: 0.3125rem;
        }

        /* Hearth pickers fill the row — date picker stretches, time stays snug */
        .jtd-row > :first-child { flex: 1; min-width: 0; }

        .jtd-go {
          flex-shrink: 0;
          width: 1.75rem;
          height: 1.75rem;
          display: grid;
          place-items: center;
          border-radius: 0.375rem;
          background: rgba(201, 168, 124, 0.10);
          border: 1px solid rgba(201, 168, 124, 0.18);
          color: var(--amber, #c9a87c);
          font-size: 0.875rem;
          cursor: pointer;
          transition: background 150ms ease, border-color 150ms ease, opacity 150ms ease;
        }
        .jtd-go:hover:not(:disabled) {
          background: rgba(201, 168, 124, 0.18);
          border-color: rgba(201, 168, 124, 0.32);
        }
        .jtd-go:active:not(:disabled) {
          transform: scale(0.985) translateY(0.5px);
        }
        .jtd-go:disabled {
          background: var(--control-disabled-bg, transparent);
          color: var(--control-disabled-text, var(--text-muted));
          border-color: transparent;
          cursor: default;
        }

        .jtd-not-found {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.625rem;
          color: var(--text-muted, #6a6258);
          text-align: center;
          padding: 0.125rem 0;
        }

        /* Pulse highlight — applied via JS to the matched message row */
        .jtd-pulse {
          animation: jtdPulse 1.2s var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)) both;
        }
        @keyframes jtdPulse {
          0%   { outline: 2px solid rgba(201, 168, 124, 0); outline-offset: 2px; }
          20%  { outline: 2px solid rgba(201, 168, 124, 0.55); outline-offset: 3px; }
          100% { outline: 2px solid rgba(201, 168, 124, 0); outline-offset: 6px; }
        }
      `}</style>
    </div>
  );
}

// ─── Context fullness gauge ───────────────────────────────────────────────────
// Shows a thin fill bar + "18% · 1M" label in the header near the model picker.
// Updates live as context_usage events arrive.

function formatContextWindow(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function ContextGauge({ percentage, tokensUsed, contextWindow }: {
  percentage: number;
  tokensUsed: number;
  contextWindow: number;
}) {
  // Color: calm amber below 80%, warming toward a mild terra-cotta above 80%.
  // Use CSS custom property driven by the JS value for smooth transition.
  const warm = percentage > 80;
  const critical = percentage > 95;

  const fmtWindow = formatContextWindow(contextWindow);
  const fmtUsed = tokensUsed.toLocaleString('en-US');
  const fmtTotal = contextWindow.toLocaleString('en-US');
  const pct = Math.min(Math.round(percentage), 100);

  return (
    <div
      className={`ctx-gauge${warm ? ' warm' : ''}${critical ? ' critical' : ''}`}
      title={`Context: ${fmtUsed} / ${fmtTotal} tokens`}
      aria-label={`Context usage: ${pct}% of ${fmtWindow} context window`}
    >
      <div className="ctx-track" aria-hidden="true">
        <div className="ctx-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="ctx-label">
        <span className="ctx-pct">{pct}%</span>
        <span className="ctx-sep" aria-hidden="true">·</span>
        <span className="ctx-window">{fmtWindow}</span>
      </span>

      <style>{`
        .ctx-gauge {
          display: inline-flex;
          align-items: center;
          gap: 0.3125rem;
          flex-shrink: 0;
          margin-left: 0.1875rem;
          cursor: default;
        }

        /* Thin fill bar */
        .ctx-track {
          width: 2.5rem;
          height: 3px;
          background: rgba(255, 255, 255, 0.06);
          border-radius: 99px;
          overflow: hidden;
          flex-shrink: 0;
        }
        .ctx-fill {
          height: 100%;
          border-radius: 99px;
          background: var(--amber-dim, #a08960);
          transition: width 400ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
                      background 600ms ease;
        }
        .ctx-gauge.warm .ctx-fill {
          background: #c9873a;
        }
        .ctx-gauge.critical .ctx-fill {
          background: #c96a3a;
        }

        /* Text label */
        .ctx-label {
          display: inline-flex;
          align-items: center;
          gap: 0.1875rem;
        }
        .ctx-pct {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5625rem;
          letter-spacing: 0.04em;
          color: var(--text-muted, #6a6258);
          font-variant-numeric: tabular-nums;
          transition: color 400ms ease;
        }
        .ctx-gauge.warm .ctx-pct {
          color: var(--status-warning-text);
        }
        .ctx-gauge.critical .ctx-pct {
          color: var(--status-error-text);
        }
        .ctx-sep {
          font-size: 0.4375rem;
          color: var(--text-muted, #6a6258);
        }
        .ctx-window {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5625rem;
          letter-spacing: 0.04em;
          color: var(--text-muted, #6a6258);
          transition: color 400ms ease;
        }
        .ctx-gauge.warm .ctx-window {
          color: var(--status-warning-text);
        }
        .ctx-gauge.critical .ctx-window {
          color: var(--status-error-text);
        }

        @media (max-width: 480px) {
          .ctx-gauge { display: none; }
        }
      `}</style>
    </div>
  );
}

// When embedded=true the parent AppShell already owns the WS connection lifecycle.
// The ChatView just reads from the shared store.

// ─── Presence dot ─────────────────────────────────────────────────────────────
// Amber-keyed for hearth — status is warmth, not a green traffic light.

function PresenceDot({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    active: '#e0a020',      // amber — present and warm
    waking: '#e0a020',      // golden-warm — stirring
    thinking: '#e0a020',    // same — processing
    dormant: '#a89c8c',     // dim warm gray — resting
    offline: '#c4b8a6',     // very dim — away
  };
  const glowMap: Record<string, string> = {
    active: 'rgba(224, 160, 32, 0.40)',
    waking: 'rgba(224, 160, 32, 0.35)',
    thinking: 'rgba(224, 160, 32, 0.35)',
    dormant: 'transparent',
    offline: 'transparent',
  };
  const isAnimated = status === 'active' || status === 'waking' || status === 'thinking';
  const color = colorMap[status] ?? '#c4b8a6';
  const glow = glowMap[status] ?? 'transparent';

  return (
    <span
      className={`presence-dot${isAnimated ? ' animated' : ''}`}
      title={status}
      aria-label={`Status: ${status}`}
      style={{ '--dot-color': color, '--dot-glow': glow } as React.CSSProperties}
    >
      <style>{`
        .presence-dot {
          display: inline-block;
          width: 0.4375rem;
          height: 0.4375rem;
          border-radius: 50%;
          background: var(--dot-color);
          flex-shrink: 0;
          transition: background var(--tx-base, 380ms ease);
        }
        .presence-dot.animated {
          box-shadow: 0 0 0 2px var(--dot-glow);
          animation: presencePulse 2.4s ease-in-out infinite;
        }
        @keyframes presencePulse {
          0%, 100% { opacity: 1; transform: scale(1); box-shadow: 0 0 0 2px var(--dot-glow); }
          50%       { opacity: 0.65; transform: scale(0.82); box-shadow: 0 0 0 1px var(--dot-glow); }
        }
      `}</style>
    </span>
  );
}

// ─── Thread context menu ───────────────────────────────────────────────────────

interface ContextMenuState {
  threadId: string;
  x: number;
  y: number;
  pinned: boolean;
  /** The section this thread is currently in, or null = loose */
  currentSectionId: string | null;
}

function ThreadContextMenu({
  state,
  sections,
  onClose,
  onRename,
  onPin,
  onArchive,
  onDelete,
  onMoveToSection,
}: {
  state: ContextMenuState;
  sections: import('@sanctum/shared').Section[];
  onClose: () => void;
  onRename: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onMoveToSection: (threadId: string, sectionId: string | null) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  // Dismiss on outside-click or Escape
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // Viewport-clamp: if menu would overflow right/bottom, flip
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = state.x;
    let y = state.y;
    if (x + rect.width > vw - 8) x = vw - rect.width - 8;
    if (y + rect.height > vh - 8) y = vh - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    setPos({ x, y });
  }, [state.x, state.y]);

  const hasSections = sections.length > 0;
  const isInSection = state.currentSectionId !== null;

  return (
    <div
      ref={menuRef}
      className="tcm-root"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={e => e.preventDefault()}
    >
      <button className="tcm-item" role="menuitem" onClick={() => { onClose(); onRename(state.threadId); }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Rename
      </button>
      <button className="tcm-item" role="menuitem" onClick={() => { onClose(); onPin(state.threadId, state.pinned); }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
        {state.pinned ? 'Unpin' : 'Pin'}
      </button>

      {/* Move to section submenu — only for named threads */}
      {hasSections && (
        <div
          className="tcm-submenu-wrap"
          onMouseEnter={() => setMoveOpen(true)}
          onMouseLeave={() => setMoveOpen(false)}
        >
          <button
            className="tcm-item tcm-has-sub"
            role="menuitem"
            aria-haspopup="true"
            aria-expanded={moveOpen}
            onClick={() => setMoveOpen(v => !v)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
            Move to
            <svg className="tcm-sub-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M9 18l6-6-6-6"/>
            </svg>
          </button>

          {moveOpen && (
            <div className="tcm-submenu" role="menu">
              {isInSection && (
                <>
                  <button
                    className="tcm-item"
                    role="menuitem"
                    onClick={() => { onClose(); onMoveToSection(state.threadId, null); }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                    Remove from section
                  </button>
                  <div className="tcm-sep" role="separator" />
                </>
              )}
              {sections.map(sec => (
                <button
                  key={sec.id}
                  className={`tcm-item${sec.id === state.currentSectionId ? ' tcm-active-section' : ''}`}
                  role="menuitem"
                  onClick={() => { onClose(); onMoveToSection(state.threadId, sec.id); }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                  </svg>
                  {sec.name}
                  {sec.id === state.currentSectionId && (
                    <svg className="tcm-check" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <button className="tcm-item" role="menuitem" onClick={() => { onClose(); onArchive(state.threadId); }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
        Archive
      </button>
      <div className="tcm-sep" role="separator" />
      <button className="tcm-item tcm-danger" role="menuitem" onClick={() => { onClose(); onDelete(state.threadId); }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        Delete
      </button>

      <style>{`
        .tcm-root {
          position: fixed;
          z-index: 8888;
          min-width: 10rem;
          background: var(--bg-secondary, #131210);
          border: 1px solid rgba(201, 168, 124, 0.14);
          border-radius: 0.625rem;
          padding: 0.3125rem;
          box-shadow:
            0 0 0 1px rgba(0,0,0,0.35),
            0 8px 24px rgba(0,0,0,0.5),
            0 2px 6px rgba(0,0,0,0.3);
          animation: tcmIn 120ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)) both;
        }
        @keyframes tcmIn {
          from { opacity: 0; transform: scale(0.95) translateY(-4px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        .tcm-item {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          width: 100%;
          padding: 0.4375rem 0.625rem;
          border-radius: 0.4375rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.8rem;
          color: var(--text-secondary, #a09689);
          text-align: left;
          background: transparent;
          border: none;
          cursor: pointer;
          transition:
            background 100ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            color 100ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }
        .tcm-item:hover {
          background: rgba(201, 168, 124, 0.08);
          color: var(--text-primary, #e2dbd0);
        }
        .tcm-item svg { flex-shrink: 0; opacity: 0.7; }
        .tcm-sep {
          height: 1px;
          background: rgba(255,255,255,0.06);
          margin: 0.25rem 0.375rem;
        }
        .tcm-danger {
          color: var(--status-error-text);
        }
        .tcm-danger:hover {
          background: rgba(220, 140, 120, 0.1);
          color: var(--status-error-text);
        }
        .tcm-danger svg { opacity: 0.8; }

        /* Move to → submenu */
        .tcm-submenu-wrap {
          position: relative;
        }
        .tcm-has-sub {
          justify-content: flex-start;
        }
        .tcm-sub-arrow {
          margin-left: auto;
          opacity: 0.5;
          flex-shrink: 0;
        }
        .tcm-submenu {
          position: absolute;
          /* Sidebar is on the left — submenu opens to the right of the context menu.
             The context menu itself is viewport-clamped, so left: 100% is safe here.
             If the sidebar is ever on the right, flip this to right: 100%. */
          left: 100%;
          top: 0;
          min-width: 9.5rem;
          background: var(--bg-secondary, #131210);
          border: 1px solid rgba(201,168,124,0.14);
          border-radius: 0.625rem;
          padding: 0.3125rem;
          box-shadow:
            0 0 0 1px rgba(0,0,0,0.35),
            0 8px 24px rgba(0,0,0,0.5),
            0 2px 6px rgba(0,0,0,0.3);
          z-index: 8889;
          animation: tcmIn 100ms var(--hearth-curve, cubic-bezier(0.25,0.46,0.45,0.94)) both;
        }
        .tcm-active-section {
          color: var(--amber, #c9a87c);
        }
        .tcm-check {
          margin-left: auto;
          flex-shrink: 0;
          opacity: 0.8;
        }
      `}</style>
    </div>
  );
}

// ─── Month collapse localStorage helper ───────────────────────────────────────

function getMonthCollapsed(key: string): boolean {
  try {
    const v = localStorage.getItem(storageKey(`month.${key}`));
    // Absent = collapsed by default for archive months
    return v === null ? true : v === 'true';
  } catch { return true; }
}

function setMonthCollapsed(key: string, v: boolean) {
  try { localStorage.setItem(storageKey(`month.${key}`), String(v)); } catch { /* ignore */ }
}

// ─── Thread list sidebar ───────────────────────────────────────────────────────

export function ThreadSidebar({ onClose, onCollapse }: { onClose: () => void; onCollapse?: () => void }) {
  const threads = useChatStore(s => s.threads);
  const sections = useChatStore(s => s.sections);
  const activeThreadId = useChatStore(s => s.activeThreadId);
  const loadThread = useChatStore(s => s.loadThread);
  const send = useChatStore(s => s.send);
  const renameThread = useChatStore(s => s.renameThread);
  const archiveThread = useChatStore(s => s.archiveThread);
  const deleteThread = useChatStore(s => s.deleteThread);
  const reorderThreads = useChatStore(s => s.reorderThreads);
  const moveThreadToSection = useChatStore(s => s.moveThreadToSection);
  const createSection = useChatStore(s => s.createSection);
  const renameSection = useChatStore(s => s.renameSection);
  const deleteSection = useChatStore(s => s.deleteSection);
  const toggleSectionCollapse = useChatStore(s => s.toggleSectionCollapse);
  const reorderSections = useChatStore(s => s.reorderSections);
  const confirm = useConfirm();

  // ── + menu ────────────────────────────────────────────────────────────────
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);

  // ── New thread creation ───────────────────────────────────────────────────
  const [naming, setNaming] = useState<'thread' | 'section' | null>(null);
  const [draftName, setDraftName] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  // ── Context menu ──────────────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  // ── Inline rename ─────────────────────────────────────────────────────────
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // ── Section rename ────────────────────────────────────────────────────────
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null);
  const [renameSectionDraft, setRenameSectionDraft] = useState('');
  const renameSectionInputRef = useRef<HTMLInputElement>(null);

  // ── Thread DnD ────────────────────────────────────────────────────────────
  // dragKind tracks whether we're dragging a thread or a section
  const dragKindRef = useRef<'thread' | 'section' | null>(null);
  const dragIdRef = useRef<string | null>(null);
  // For threads: original section_id when drag started
  const dragFromSectionRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPos, setDragOverPos] = useState<'before' | 'after'>('after');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Section-level DnD
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null);
  const [dragOverSectionId, setDragOverSectionId] = useState<string | null>(null);
  const [dragOverSectionPos, setDragOverSectionPos] = useState<'before' | 'after'>('after');
  // Highlight which section body is the current thread drop target
  const [dropTargetSectionId, setDropTargetSectionId] = useState<string | null>(null);

  // ── Month collapse state (localStorage-backed, initialized lazily) ─────────
  const [monthCollapsed, setMonthCollapsedState] = useState<Record<string, boolean>>({});

  // ── Archived zone (quiet, collapsed by default, lazy-loaded on expand) ─────
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[] | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [archivedBusyId, setArchivedBusyId] = useState<string | null>(null);

  const loadArchived = useCallback(async () => {
    setArchivedLoading(true);
    setArchivedError(null);
    try {
      const res = await fetch(`${BASE}/api/threads/archived`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { threads: ThreadSummary[] };
      setArchivedThreads(data.threads ?? []);
    } catch (err) {
      console.error('[sanctum] Load archived threads failed:', err);
      setArchivedError('couldn’t load the archive');
    } finally {
      setArchivedLoading(false);
    }
  }, []);

  function toggleArchivedZone() {
    const next = !archivedOpen;
    setArchivedOpen(next);
    if (next) void loadArchived();
  }

  async function handleUnarchive(id: string) {
    setArchivedBusyId(id);
    try {
      const res = await fetch(`${BASE}/api/threads/${id}/unarchive`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // The backend broadcasts thread_list, so the thread reappears in the live
      // sidebar; here we just drop it from the local archive list.
      setArchivedThreads(prev => prev ? prev.filter(t => t.id !== id) : prev);
    } catch (err) {
      console.error('[sanctum] Unarchive failed:', err);
      setArchivedError('unarchive failed — try again');
    } finally {
      setArchivedBusyId(null);
    }
  }

  async function handleArchivedDelete(id: string, name: string) {
    const ok = await confirm({
      title: `Delete "${name}" permanently?`,
      body: 'All messages in this archived thread will be permanently removed. This cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    setArchivedBusyId(id);
    try {
      const res = await fetch(`${BASE}/api/threads/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setArchivedThreads(prev => prev ? prev.filter(t => t.id !== id) : prev);
    } catch (err) {
      console.error('[sanctum] Permanent delete failed:', err);
      setArchivedError('delete failed — try again');
    } finally {
      setArchivedBusyId(null);
    }
  }

  // ── + menu close on outside click ─────────────────────────────────────────
  useEffect(() => {
    if (!plusMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (
        plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node) &&
        plusBtnRef.current && !plusBtnRef.current.contains(e.target as Node)
      ) {
        setPlusMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPlusMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [plusMenuOpen]);

  function openNaming(kind: 'thread' | 'section') {
    setPlusMenuOpen(false);
    setDraftName('');
    setNaming(kind);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }

  function commitCreate() {
    const trimmed = draftName.trim();
    if (trimmed) {
      if (naming === 'thread') {
        send({ type: 'create_thread', name: trimmed, threadType: 'named' });
      } else if (naming === 'section') {
        void createSection(trimmed);
      }
    }
    setNaming(null);
    setDraftName('');
    if (naming === 'thread') onClose();
  }

  function cancelCreate() {
    setNaming(null);
    setDraftName('');
  }

  // ── Context menu handlers ─────────────────────────────────────────────────

  function openCtxMenu(e: React.MouseEvent, threadId: string, pinned: boolean, currentSectionId: string | null) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ threadId, x: e.clientX, y: e.clientY, pinned, currentSectionId });
  }

  function handleRename(id: string) {
    const t = threads.find(th => th.id === id);
    if (!t) return;
    setRenameDraft(t.name);
    setRenamingId(id);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }

  function handlePin(id: string, pinned: boolean) {
    send(pinned ? { type: 'unpin_thread', threadId: id } : { type: 'pin_thread', threadId: id });
  }

  async function handleArchive(id: string) {
    const t = threads.find(th => th.id === id);
    const name = t?.name ?? 'this thread';
    const ok = await confirm({
      title: `Archive "${name}"?`,
      body: 'The thread will be hidden from the sidebar. You can recover it later.',
      confirmLabel: 'Archive',
      cancelLabel: 'Keep',
    });
    if (ok) archiveThread(id);
  }

  async function handleDelete(id: string) {
    const t = threads.find(th => th.id === id);
    const name = t?.name ?? 'this thread';
    const ok = await confirm({
      title: `Delete "${name}"?`,
      body: 'All messages in this thread will be permanently removed. This cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (ok) deleteThread(id);
  }

  async function handleSectionDelete(id: string) {
    const sec = sections.find(s => s.id === id);
    const name = sec?.name ?? 'this section';
    const ok = await confirm({
      title: `Delete section "${name}"?`,
      body: 'The threads inside will be moved out, not deleted.',
      confirmLabel: 'Delete section',
      cancelLabel: 'Cancel',
    });
    if (ok) deleteSection(id);
  }

  function handleSectionRename(id: string) {
    const sec = sections.find(s => s.id === id);
    if (!sec) return;
    setRenameSectionDraft(sec.name);
    setRenamingSectionId(id);
    setTimeout(() => renameSectionInputRef.current?.focus(), 0);
  }

  function commitSectionRename() {
    if (!renamingSectionId) return;
    const trimmed = renameSectionDraft.trim();
    if (trimmed) renameSection(renamingSectionId, trimmed);
    setRenamingSectionId(null);
    setRenameSectionDraft('');
  }

  function cancelSectionRename() {
    setRenamingSectionId(null);
    setRenameSectionDraft('');
  }

  // ── Inline thread rename commit/cancel ─────────────────────────────────────

  function commitRename() {
    if (!renamingId) return;
    const trimmed = renameDraft.trim();
    if (trimmed) renameThread(renamingId, trimmed);
    setRenamingId(null);
    setRenameDraft('');
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameDraft('');
  }

  // ── Thread DnD ────────────────────────────────────────────────────────────

  function handleThreadDragStart(e: React.DragEvent, id: string, fromSectionId: string | null) {
    dragKindRef.current = 'thread';
    dragIdRef.current = id;
    dragFromSectionRef.current = fromSectionId;
    setDraggingId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `thread:${id}`);
    // Stop the drag event from also triggering the section drag
    e.stopPropagation();
  }

  function handleThreadDragEnd() {
    dragKindRef.current = null;
    dragIdRef.current = null;
    dragFromSectionRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
    setDropTargetSectionId(null);
  }

  function handleThreadDragOver(e: React.DragEvent, overId: string) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dragKindRef.current !== 'thread') return;
    if (!dragIdRef.current || dragIdRef.current === overId) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDragOverId(overId);
    setDragOverPos(e.clientY < midY ? 'before' : 'after');
    setDropTargetSectionId(null); // thread-over-thread — no section highlight
  }

  function handleThreadDragLeave(e: React.DragEvent) {
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    setDragOverId(null);
  }

  function handleThreadDrop(e: React.DragEvent, targetId: string, targetSectionId: string | null) {
    e.preventDefault();
    e.stopPropagation();
    const fromId = dragIdRef.current;
    if (dragKindRef.current !== 'thread' || !fromId || fromId === targetId) {
      setDragOverId(null);
      return;
    }
    const fromSectionId = dragFromSectionRef.current;

    // If cross-section move, update section first
    if (fromSectionId !== targetSectionId) {
      void moveThreadToSection(fromId, targetSectionId);
    }

    // Reorder within the zone (named loose or within a section)
    // We only reorder named threads by position — dailies are date-ordered
    const zoneThreads = threads.filter(t =>
      t.type === 'named' && t.section_id === targetSectionId
    );
    const ids = zoneThreads.map(t => t.id);
    const fromIdx = ids.indexOf(fromId);
    if (fromIdx === -1) { setDragOverId(null); return; }
    const next = [...ids];
    next.splice(fromIdx, 1);
    let targetIdx = next.indexOf(targetId);
    if (targetIdx === -1) { setDragOverId(null); return; }
    if (dragOverPos === 'after') targetIdx += 1;
    next.splice(targetIdx, 0, fromId);

    setDragOverId(null);
    void reorderThreads(next);
  }

  // Drop thread directly onto a section body (empty body or between threads)
  function handleSectionBodyDragOver(e: React.DragEvent, sectionId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (dragKindRef.current !== 'thread') return;
    e.dataTransfer.dropEffect = 'move';
    setDropTargetSectionId(sectionId);
    setDragOverId(null);
  }

  function handleSectionBodyDrop(e: React.DragEvent, sectionId: string) {
    e.preventDefault();
    e.stopPropagation();
    const fromId = dragIdRef.current;
    if (dragKindRef.current !== 'thread' || !fromId) return;
    const fromSectionId = dragFromSectionRef.current;
    if (fromSectionId !== sectionId) {
      void moveThreadToSection(fromId, sectionId);
    }
    setDropTargetSectionId(null);
    setDragOverId(null);
  }

  // Loose zone drop (thread → zone 1, unfile from section)
  function handleLooseZoneDragOver(e: React.DragEvent) {
    if (dragKindRef.current !== 'thread') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetSectionId('__loose__');
  }

  function handleLooseZoneDrop(e: React.DragEvent) {
    e.preventDefault();
    const fromId = dragIdRef.current;
    if (dragKindRef.current !== 'thread' || !fromId) return;
    const fromSectionId = dragFromSectionRef.current;
    if (fromSectionId !== null) {
      void moveThreadToSection(fromId, null);
    }
    setDropTargetSectionId(null);
  }

  // ── Section DnD ───────────────────────────────────────────────────────────

  function handleSectionDragStart(e: React.DragEvent, sectionId: string) {
    dragKindRef.current = 'section';
    dragIdRef.current = sectionId;
    setDraggingSectionId(sectionId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `section:${sectionId}`);
  }

  function handleSectionDragEnd() {
    dragKindRef.current = null;
    dragIdRef.current = null;
    setDraggingSectionId(null);
    setDragOverSectionId(null);
  }

  function handleSectionDragOver(e: React.DragEvent, sectionId: string) {
    if (dragKindRef.current !== 'section') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragIdRef.current || dragIdRef.current === sectionId) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDragOverSectionId(sectionId);
    setDragOverSectionPos(e.clientY < midY ? 'before' : 'after');
  }

  function handleSectionDragLeave(e: React.DragEvent) {
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    setDragOverSectionId(null);
  }

  function handleSectionDrop(e: React.DragEvent, targetSectionId: string) {
    e.preventDefault();
    const fromId = dragIdRef.current;
    if (dragKindRef.current !== 'section' || !fromId || fromId === targetSectionId) {
      setDragOverSectionId(null);
      return;
    }
    const ids = sections.map(s => s.id);
    const fromIdx = ids.indexOf(fromId);
    if (fromIdx === -1) { setDragOverSectionId(null); return; }
    const next = [...ids];
    next.splice(fromIdx, 1);
    let targetIdx = next.indexOf(targetSectionId);
    if (targetIdx === -1) { setDragOverSectionId(null); return; }
    if (dragOverSectionPos === 'after') targetIdx += 1;
    next.splice(targetIdx, 0, fromId);
    setDragOverSectionId(null);
    void reorderSections(next);
  }

  // ── Month collapse ─────────────────────────────────────────────────────────

  function toggleMonth(key: string) {
    const current = monthCollapsed[key] ?? getMonthCollapsed(key);
    const next = !current;
    setMonthCollapsedState(s => ({ ...s, [key]: next }));
    setMonthCollapsed(key, next);
  }

  function isMonthCollapsed(key: string): boolean {
    if (key in monthCollapsed) return monthCollapsed[key];
    return getMonthCollapsed(key);
  }

  // Close ctx menu on list scroll
  function handleListScroll() {
    if (ctxMenu) setCtxMenu(null);
  }

  // ── Derived data ───────────────────────────────────────────────────────────

  // Zone 1: loose named threads (section_id == null), sorted by position
  const looseNamedThreads = threads
    .filter(t => t.type === 'named' && t.section_id === null)
    .sort((a, b) => a.position - b.position);

  // Zone 3: daily threads grouped by month, months sorted descending
  const dailyThreads = threads.filter(t => t.type === 'daily');

  type MonthGroup = { key: string; label: string; threads: typeof dailyThreads };
  const monthGroups: MonthGroup[] = [];
  const monthMap = new Map<string, typeof dailyThreads>();

  for (const t of dailyThreads) {
    // Parse YYYY-MM from daily id (daily-YYYY-MM-DD) or fall back to last_activity_at
    let monthKey = '';
    const idMatch = t.id.match(/^daily-(\d{4}-\d{2})-\d{2}$/);
    if (idMatch) {
      monthKey = idMatch[1];
    } else if (t.last_activity_at) {
      monthKey = t.last_activity_at.substring(0, 7);
    }
    if (!monthKey) continue;
    if (!monthMap.has(monthKey)) monthMap.set(monthKey, []);
    monthMap.get(monthKey)!.push(t);
  }

  for (const [key, mThreads] of monthMap.entries()) {
    // Month label: "June 2026"
    const [year, month] = key.split('-');
    const label = new Date(Number(year), Number(month) - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    // Sort threads within month descending (newest first)
    const sorted = [...mThreads].sort((a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''));
    monthGroups.push({ key, label, threads: sorted });
  }
  // Sort months descending
  monthGroups.sort((a, b) => b.key.localeCompare(a.key));

  // ── Shared thread-row renderer ────────────────────────────────────────────
  // Used for both zone-1 loose threads and zone-3 daily thread rows.

  function renderThreadRow(
    t: typeof threads[0],
    fromSectionId: string | null,
    draggableInZone: boolean
  ) {
    const isActive = t.id === activeThreadId;
    const isDragging = draggingId === t.id;
    const isDropTarget = dragOverId === t.id;
    const isRenaming = renamingId === t.id;

    return (
      <div
        key={t.id}
        className={[
          'thread-item-wrap',
          isDragging ? 'ti-dragging' : '',
          isDropTarget && dragOverPos === 'before' ? 'ti-drop-before' : '',
          isDropTarget && dragOverPos === 'after'  ? 'ti-drop-after'  : '',
        ].filter(Boolean).join(' ')}
        draggable={draggableInZone}
        onDragStart={draggableInZone ? e => handleThreadDragStart(e, t.id, fromSectionId) : undefined}
        onDragEnd={draggableInZone ? handleThreadDragEnd : undefined}
        onDragOver={draggableInZone ? e => handleThreadDragOver(e, t.id) : undefined}
        onDragLeave={draggableInZone ? handleThreadDragLeave : undefined}
        onDrop={draggableInZone ? e => handleThreadDrop(e, t.id, fromSectionId) : undefined}
      >
        <button
          className={`thread-item${isActive ? ' active' : ''}`}
          onClick={() => {
            if (isRenaming) return;
            onClose();
            void loadThread(t.id);
          }}
          onContextMenu={e => openCtxMenu(e, t.id, !!t.pinned_at, fromSectionId)}
          aria-label={t.name}
        >
          {t.pinned_at && (
            <span className="thread-pin" aria-label="Pinned" title="Pinned">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>
              </svg>
            </span>
          )}

          {isRenaming ? (
            <input
              ref={el => { if (el && renamingId === t.id) renameInputRef.current = el; }}
              className="thread-name-input thread-rename-input"
              value={renameDraft}
              onChange={e => setRenameDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
              }}
              onBlur={commitRename}
              onClick={e => e.stopPropagation()}
              maxLength={80}
              aria-label="Rename thread"
            />
          ) : (
            <span className="thread-name">{t.name}</span>
          )}

          {t.unread_count > 0 && !isRenaming && (
            <span className="thread-unread">{t.unread_count}</span>
          )}

          {!isRenaming && (
            <button
              className="thread-more-btn"
              onClick={e => { e.stopPropagation(); openCtxMenu(e, t.id, !!t.pinned_at, fromSectionId); }}
              aria-label="Thread options"
              title="Options"
              tabIndex={-1}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
              </svg>
            </button>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="thread-sidebar">
      {/* Context menu — rendered at fixed position in viewport */}
      {ctxMenu && (
        <ThreadContextMenu
          state={ctxMenu}
          sections={sections}
          onClose={() => setCtxMenu(null)}
          onRename={handleRename}
          onPin={handlePin}
          onArchive={handleArchive}
          onDelete={handleDelete}
          onMoveToSection={(threadId, sectionId) => void moveThreadToSection(threadId, sectionId)}
        />
      )}

      {/* ── Header ── */}
      <div className="thread-sidebar-header">
        <span className="thread-sidebar-title">Chats</span>

        {/* collapse (desktop): tuck the panel away; the header's reveal button brings it back */}
        {onCollapse && (
          <button
            className="thread-collapse-btn"
            onClick={onCollapse}
            aria-label="Hide threads"
            title="Hide threads"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        )}

        {/* + button — opens small menu: New thread / New section */}
        <div className="thread-plus-wrap">
          <button
            ref={plusBtnRef}
            className="thread-new-btn"
            onClick={() => setPlusMenuOpen(v => !v)}
            aria-label="New thread or section"
            title="New thread or section"
            aria-expanded={plusMenuOpen}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>

          {plusMenuOpen && (
            <div ref={plusMenuRef} className="plus-menu" role="menu">
              <button
                className="plus-menu-item"
                role="menuitem"
                onClick={() => openNaming('thread')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                </svg>
                New thread
              </button>
              <button
                className="plus-menu-item"
                role="menuitem"
                onClick={() => openNaming('section')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                </svg>
                New section
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Inline name-capture ── */}
      {naming !== null && (
        <div className="thread-name-row">
          <input
            ref={nameInputRef}
            className="thread-name-input"
            value={draftName}
            onChange={e => setDraftName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitCreate();
              if (e.key === 'Escape') cancelCreate();
            }}
            placeholder={naming === 'section' ? 'section name…' : 'thread name…'}
            maxLength={80}
            aria-label={naming === 'section' ? 'New section name' : 'New thread name'}
          />
          <button className="thread-name-confirm" onClick={commitCreate} aria-label="Create">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </button>
          <button className="thread-name-cancel" onClick={cancelCreate} aria-label="Cancel">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* ── Three-zone scrollable list ── */}
      <div
        className="thread-list"
        onScroll={handleListScroll}
      >
        {/* ── Zone 1: loose named threads ── */}
        <div
          className={`zone-loose${dropTargetSectionId === '__loose__' ? ' zone-drop-target' : ''}`}
          onDragOver={handleLooseZoneDragOver}
          onDragLeave={() => { if (dropTargetSectionId === '__loose__') setDropTargetSectionId(null); }}
          onDrop={handleLooseZoneDrop}
        >
          {looseNamedThreads.map(t => renderThreadRow(t, null, true))}
          {looseNamedThreads.length === 0 && threads.filter(t => t.type === 'named').length === 0 && sections.length === 0 && dailyThreads.length === 0 && (
            <div className="thread-empty">no threads yet</div>
          )}
        </div>

        {/* ── Zone 2: user sections ── */}
        {sections.length > 0 && (
          <div className="zone-sections">
            {sections.map(sec => {
              const secThreads = threads
                .filter(t => t.type === 'named' && t.section_id === sec.id)
                .sort((a, b) => a.position - b.position);

              const isRenamingSection = renamingSectionId === sec.id;

              return (
                <div key={sec.id} className="section-rename-wrap">
                  {isRenamingSection ? (
                    <div className="thread-name-row section-rename-row">
                      <input
                        ref={renameSectionInputRef}
                        className="thread-name-input"
                        value={renameSectionDraft}
                        onChange={e => setRenameSectionDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitSectionRename(); }
                          if (e.key === 'Escape') { e.preventDefault(); cancelSectionRename(); }
                        }}
                        onBlur={commitSectionRename}
                        maxLength={80}
                        aria-label="Rename section"
                      />
                      <button className="thread-name-confirm" onClick={commitSectionRename} aria-label="Confirm rename">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <path d="M20 6L9 17l-5-5"/>
                        </svg>
                      </button>
                      <button className="thread-name-cancel" onClick={cancelSectionRename} aria-label="Cancel rename">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <SidebarSection
                      section={sec}
                      threads={secThreads}
                      activeThreadId={activeThreadId}
                      renamingThreadId={renamingId}
                      renameDraft={renameDraft}
                      draggingId={draggingId}
                      dragOverId={dragOverId}
                      dragOverPos={dragOverPos}
                      isDraggingSection={draggingSectionId === sec.id}
                      dragOverSectionId={dragOverSectionId}
                      dragOverSectionPos={dragOverSectionPos}
                      onLoadThread={loadThread}
                      onCloseDrawer={onClose}
                      onThreadContextMenu={openCtxMenu}
                      onThreadMoreClick={(e, threadId, pinned, sectionId) => { e.stopPropagation(); openCtxMenu(e, threadId, pinned, sectionId); }}
                      onRenameInputChange={setRenameDraft}
                      onRenameCommit={commitRename}
                      onRenameCancel={cancelRename}
                      onRenameInputRef={el => { if (el) renameInputRef.current = el; }}
                      onThreadDragStart={handleThreadDragStart}
                      onThreadDragEnd={handleThreadDragEnd}
                      onThreadDragOver={handleThreadDragOver}
                      onThreadDragLeave={handleThreadDragLeave}
                      onThreadDrop={handleThreadDrop}
                      onSectionBodyDragOver={handleSectionBodyDragOver}
                      onSectionBodyDrop={handleSectionBodyDrop}
                      onSectionDragStart={handleSectionDragStart}
                      onSectionDragEnd={handleSectionDragEnd}
                      onSectionDragOver={handleSectionDragOver}
                      onSectionDragLeave={handleSectionDragLeave}
                      onSectionDrop={handleSectionDrop}
                      onToggleCollapse={(id, collapsed) => void toggleSectionCollapse(id, collapsed)}
                      onSectionRename={handleSectionRename}
                      onSectionDelete={handleSectionDelete}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Zone 3: monthly daily accordions ── */}
        {monthGroups.length > 0 && (
          <div className="zone-months">
            {monthGroups.map(mg => {
              const collapsed = isMonthCollapsed(mg.key);
              return (
                <div key={mg.key} className="month-accordion">
                  <button
                    className="month-header"
                    onClick={() => toggleMonth(mg.key)}
                    aria-expanded={!collapsed}
                  >
                    <svg
                      className={`month-chevron${collapsed ? '' : ' month-chevron-open'}`}
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M9 18l6-6-6-6"/>
                    </svg>
                    <span className="month-label">{mg.label}</span>
                    <span className="month-count">({mg.threads.length})</span>
                  </button>

                  {!collapsed && (
                    <div className="month-body">
                      {mg.threads.map(t => renderThreadRow(t, null, false))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Zone 4: archived (quiet, collapsed, lazy-loaded) ── */}
        <div className="zone-archived">
          <button
            className="archived-header"
            onClick={toggleArchivedZone}
            aria-expanded={archivedOpen}
          >
            <svg
              className={`month-chevron${archivedOpen ? ' month-chevron-open' : ''}`}
              width="10" height="10" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M9 18l6-6-6-6"/>
            </svg>
            <svg className="archived-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="4.5" rx="1" />
              <path d="M4.5 8.5V19a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V8.5" />
              <path d="M10 12.5h4" />
            </svg>
            <span className="archived-label">Archived</span>
            {archivedThreads !== null && archivedOpen && (
              <span className="month-count">({archivedThreads.length})</span>
            )}
          </button>

          {archivedOpen && (
            <div className="archived-body">
              {archivedLoading && <div className="archived-note">loading…</div>}
              {archivedError && <div className="archived-note archived-err">{archivedError}</div>}
              {!archivedLoading && !archivedError && archivedThreads !== null && archivedThreads.length === 0 && (
                <div className="archived-note">nothing archived</div>
              )}
              {!archivedLoading && archivedThreads?.map(t => (
                <div key={t.id} className="archived-row">
                  <span className="archived-name" title={t.name}>{t.name}</span>
                  <span className="archived-actions">
                    <button
                      className="archived-btn"
                      onClick={() => void handleUnarchive(t.id)}
                      disabled={archivedBusyId === t.id}
                      title="Restore to sidebar"
                      aria-label={`Unarchive ${t.name}`}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <path d="M3 9l9-7 9 7"/><path d="M12 2v14"/><path d="M5 21h14"/>
                      </svg>
                    </button>
                    <button
                      className="archived-btn archived-btn-danger"
                      onClick={() => void handleArchivedDelete(t.id, t.name)}
                      disabled={archivedBusyId === t.id}
                      title="Delete permanently"
                      aria-label={`Delete ${t.name} permanently`}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                      </svg>
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <style>{`
        /* ── Name-capture row ── */
        .thread-name-row {
          display: flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.375rem 0.5rem 0.375rem 0.75rem;
          border-bottom: 1px solid rgba(201, 168, 124, 0.08);
          flex-shrink: 0;
          background: rgba(201, 168, 124, 0.04);
        }
        .section-rename-row {
          border-radius: 0.4375rem;
          border: 1px solid rgba(201,168,124,0.18);
          margin: 0.125rem 0.375rem;
        }
        .thread-name-input {
          flex: 1;
          min-width: 0;
          background: transparent;
          border: none;
          outline: none;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.8125rem;
          color: var(--text-primary, #e2dbd0);
          caret-color: var(--amber, #c9a87c);
        }
        .thread-rename-input {
          padding: 0;
          height: auto;
          line-height: inherit;
        }
        .thread-name-input::placeholder {
          color: var(--text-muted, #6a6258);
          font-style: italic;
          font-family: var(--font-serif, 'Lora', serif);
        }
        .thread-name-confirm,
        .thread-name-cancel {
          flex-shrink: 0;
          width: 1.5rem;
          height: 1.5rem;
          display: grid;
          place-items: center;
          border-radius: 0.3125rem;
          transition: color 160ms ease, background 160ms ease;
        }
        .thread-name-confirm { color: var(--amber, #c9a87c); }
        .thread-name-confirm:hover { background: rgba(201, 168, 124, 0.12); }
        .thread-name-cancel { color: var(--text-muted, #6a6258); }
        .thread-name-cancel:hover {
          color: var(--text-secondary, #a09689);
          background: rgba(255, 255, 255, 0.05);
        }

        /* ── Sidebar shell ── */
        .thread-sidebar {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: var(--bg-secondary, #131210);
          border-right: 1px solid rgba(201, 168, 124, 0.07);
          width: var(--sidebar-width, 16rem);
          flex-shrink: 0;
          overflow: hidden;
          position: relative;
        }

        /* Mobile drawer: wider. drawer-panel already applies safe-area-inset-top — do NOT repeat it here. */
        @media (max-width: 768px) {
          .thread-sidebar {
            width: min(80vw, 18rem);
          }
        }

        .thread-sidebar-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 1rem 0.875rem 0.75rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
          flex-shrink: 0;
        }

        .thread-sidebar-title {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.875rem;
          color: var(--text-secondary, #a09689);
          font-weight: 400;
          letter-spacing: 0.01em;
        }

        /* ── + button + its mini-menu ── */
        .thread-plus-wrap {
          position: relative;
        }
        .thread-collapse-btn {
          width: 1.75rem;
          height: 1.75rem;
          display: grid;
          place-items: center;
          margin-left: auto;
          margin-right: 0.25rem;
          color: var(--text-muted, #6a6258);
          border-radius: 0.375rem;
          transition: color 240ms ease;
        }
        .thread-collapse-btn:hover { color: var(--text-primary, #e2dbd0); }

        .thread-new-btn {
          width: 1.75rem;
          height: 1.75rem;
          display: grid;
          place-items: center;
          color: var(--text-muted, #6a6258);
          border-radius: 0.375rem;
          position: relative;
          isolation: isolate;
          transition: color 240ms ease;
        }
        .thread-new-btn::before {
          content: '';
          position: absolute; inset: 0;
          border-radius: inherit;
          z-index: -1;
          opacity: 0;
          background: radial-gradient(circle, rgba(201,168,124,0.18), transparent 70%);
          transition: opacity 380ms ease;
        }
        .thread-new-btn:hover { color: var(--text-primary, #e2dbd0); }
        .thread-new-btn:hover::before { opacity: 1; }
        .thread-new-btn:active {
          transform: scale(0.985);
          transition: transform 140ms var(--hearth-curve, ease);
        }

        .plus-menu {
          position: absolute;
          top: calc(100% + 4px);
          right: 0;
          min-width: 9.5rem;
          background: var(--bg-secondary, #131210);
          border: 1px solid rgba(201,168,124,0.14);
          border-radius: 0.625rem;
          padding: 0.3125rem;
          z-index: 500;
          box-shadow:
            0 0 0 1px rgba(0,0,0,0.35),
            0 8px 24px rgba(0,0,0,0.5),
            0 2px 6px rgba(0,0,0,0.3);
          animation: plusMenuIn 120ms var(--hearth-curve, cubic-bezier(0.25,0.46,0.45,0.94)) both;
        }
        @keyframes plusMenuIn {
          from { opacity: 0; transform: scale(0.95) translateY(-4px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        .plus-menu-item {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          width: 100%;
          padding: 0.4375rem 0.625rem;
          border-radius: 0.4375rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.8rem;
          color: var(--text-secondary, #a09689);
          text-align: left;
          background: transparent;
          border: none;
          cursor: pointer;
          transition: background 100ms ease, color 100ms ease;
        }
        .plus-menu-item:hover {
          background: rgba(201,168,124,0.08);
          color: var(--text-primary, #e2dbd0);
        }
        .plus-menu-item svg { flex-shrink: 0; opacity: 0.7; }

        /* ── Scrollable list ── */
        .thread-list {
          flex: 1;
          overflow-y: auto;
          padding: 0.5rem 0.375rem;
          display: flex;
          flex-direction: column;
          gap: 0;
        }

        .thread-empty {
          padding: 1.25rem 1rem;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.875rem;
          color: var(--text-muted, #6a6258);
          text-align: center;
        }

        /* ── Zone 1 — loose threads ── */
        /* flex-shrink:0 on all three zones is load-bearing: .thread-list is a flex
           column, so without it flexbox compresses the upper zones below their
           content height when a lower accordion (e.g. June) expands — the fixed-height
           rows then overflow their shrunk zone and OVERLAP. With it, zones keep their
           natural height and .thread-list's overflow-y:auto scrolls instead. */
        .zone-loose {
          flex-shrink: 0;
          min-height: 0.5rem;
          border-radius: 0.375rem;
          transition: background 120ms ease;
        }
        .zone-drop-target {
          background: rgba(201,168,124,0.04);
          outline: 1px dashed rgba(201,168,124,0.2);
          outline-offset: -1px;
        }

        /* ── Zone 2 — sections ── */
        .zone-sections {
          flex-shrink: 0;
          margin-top: 0.25rem;
          border-top: 1px solid rgba(255,255,255,0.04);
          padding-top: 0.25rem;
        }
        .section-rename-wrap { }

        /* ── Zone 3 — monthly accordions ── */
        .zone-months {
          flex-shrink: 0;
          margin-top: 0.375rem;
          border-top: 1px solid rgba(255,255,255,0.04);
          padding-top: 0.25rem;
        }

        .month-accordion {
          margin-bottom: 0.125rem;
        }

        .month-header {
          display: flex;
          align-items: center;
          gap: 0.3125rem;
          width: 100%;
          padding: 0.375rem 0.5rem 0.375rem 0.625rem;
          border-radius: 0.375rem;
          background: transparent;
          border: none;
          cursor: pointer;
          color: var(--text-muted, #6a6258);
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.75rem;
          text-align: left;
          transition: color 160ms ease, background 160ms ease;
        }
        .month-header:hover {
          color: var(--text-secondary, #a09689);
          background: rgba(255,255,255,0.03);
        }

        .month-chevron {
          flex-shrink: 0;
          opacity: 1;
          transition: transform 200ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)), opacity 160ms ease;
        }
        .month-chevron-open {
          transform: rotate(90deg);
        }

        .month-label {
          flex: 1;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.75rem;
          letter-spacing: 0.01em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .month-count {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.04em;
          opacity: 0.5;
          flex-shrink: 0;
        }

        .month-body {
          padding-left: 0.5rem;
          overflow: hidden;
          animation: monthReveal 200ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)) both;
        }
        @keyframes monthReveal {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        /* ── Zone 4 — archived (deliberately dimmer than live zones) ── */
        .zone-archived {
          flex-shrink: 0;
          margin-top: 0.375rem;
          border-top: 1px solid rgba(255,255,255,0.03);
          padding-top: 0.25rem;
          padding-bottom: 0.5rem;
          opacity: 0.75;
        }
        .archived-header {
          display: flex;
          align-items: center;
          gap: 0.3125rem;
          width: 100%;
          padding: 0.375rem 0.5rem 0.375rem 0.625rem;
          border-radius: 0.375rem;
          background: transparent;
          border: none;
          cursor: pointer;
          color: var(--text-muted, #6a6258);
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.75rem;
          text-align: left;
          opacity: 0.7;
          transition: color 160ms ease, background 160ms ease, opacity 160ms ease;
        }
        .archived-header:hover {
          color: var(--text-secondary, #a09689);
          background: rgba(255,255,255,0.02);
          opacity: 1;
        }
        .archived-label {
          flex: 1;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.72rem;
          letter-spacing: 0.02em;
        }
        .archived-body {
          padding-left: 0.5rem;
          overflow: hidden;
          animation: monthReveal 200ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)) both;
        }
        .archived-note {
          padding: 0.3125rem 0.625rem;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.72rem;
          color: var(--text-muted, #6a6258);
        }
        .archived-err {
          color: var(--status-error-text);
        }
        .archived-row {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.25rem 0.5rem 0.25rem 0.625rem;
          border-radius: 0.375rem;
          transition: background 160ms ease;
        }
        .archived-row:hover {
          background: rgba(255,255,255,0.02);
        }
        .archived-name {
          flex: 1;
          min-width: 0;
          font-size: 0.75rem;
          color: var(--text-muted, #6a6258);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .archived-actions {
          display: inline-flex;
          align-items: center;
          gap: 0.125rem;
          flex-shrink: 0;
          /* visible by default — hover has no equivalent on touch */
          transition: opacity 160ms ease;
        }
        .archived-row:hover .archived-actions {
          opacity: 1;
        }
        .archived-btn {
          width: 1.375rem;
          height: 1.375rem;
          display: grid;
          place-items: center;
          border: none;
          background: transparent;
          border-radius: 0.3125rem;
          color: var(--text-muted, #6a6258);
          cursor: pointer;
          transition: color 160ms ease, background 160ms ease;
        }
        .archived-btn:hover:not(:disabled) {
          color: var(--amber, #c9a87c);
          background: rgba(201, 168, 124, 0.08);
        }
        .archived-btn-danger:hover:not(:disabled) {
          color: var(--status-error-text);
          background: rgba(210, 100, 90, 0.08);
        }
        .archived-btn:disabled {
          color: var(--text-muted);
          cursor: default;
        }

        /* ── DnD wrapper — shared by all zones ── */
        .thread-item-wrap {
          position: relative;
        }
        .thread-item-wrap::before,
        .thread-item-wrap::after {
          content: '';
          position: absolute;
          left: 0.5rem;
          right: 0.5rem;
          height: 2px;
          border-radius: 1px;
          background: var(--amber, #c9a87c);
          opacity: 0;
          pointer-events: none;
          transition: opacity 80ms ease;
        }
        .thread-item-wrap::before { top: 0; }
        .thread-item-wrap::after  { bottom: 0; }
        .ti-drop-before::before { opacity: 0.75; }
        .ti-drop-after::after   { opacity: 0.75; }
        .ti-dragging .thread-item { opacity: 0.35; }

        /* ── Thread row ── */
        .thread-item {
          display: flex;
          align-items: center;
          gap: 0.4375rem;
          width: 100%;
          padding: 0.5625rem 0.75rem;
          border-radius: 0.5rem;
          text-align: left;
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
          cursor: pointer;
          border: none;
          background: transparent;
          position: relative;
          isolation: isolate;
          transition: color 240ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }
        .thread-item::before {
          content: '';
          position: absolute; inset: 0;
          border-radius: inherit;
          z-index: -1;
          opacity: 0;
          background: radial-gradient(ellipse 70% 100% at 0% 50%, rgba(201,168,124,0.18), transparent 70%);
          transition: opacity 240ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }
        .thread-item:hover { color: var(--text-primary, #e2dbd0); }
        .thread-item:hover::before { opacity: 0.65; }
        .thread-item.active {
          color: var(--text-primary, #e2dbd0);
          font-weight: 500;
        }
        .thread-item.active::before {
          background: radial-gradient(ellipse 90% 120% at 20% 50%, rgba(201,168,124,0.06), transparent 75%);
          opacity: 1;
        }
        .thread-item:active {
          transform: scale(0.985) translateY(0.5px);
          transition: transform 100ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }

        .thread-more-btn {
          flex-shrink: 0;
          display: grid;
          place-items: center;
          width: 1.375rem;
          height: 1.375rem;
          border-radius: 0.3125rem;
          border: none;
          background: transparent;
          color: var(--text-muted, #6a6258);
          cursor: pointer;
          opacity: 0;
          transition:
            opacity 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            background 120ms ease,
            color 120ms ease;
        }
        .thread-item:hover .thread-more-btn,
        .thread-item:focus-within .thread-more-btn {
          opacity: 1;
        }
        /* No hover on touch screens: the options button is always there. */
        @media (hover: none) { .thread-more-btn { opacity: 1; } }
        .thread-more-btn:hover {
          background: rgba(201, 168, 124, 0.1);
          color: var(--text-primary, #e2dbd0);
          opacity: 1;
        }

        .thread-pin {
          flex-shrink: 0;
          color: var(--text-muted);
          line-height: 1;
          display: flex;
          align-items: center;
        }

        .thread-name {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-style: normal;
        }

        .thread-unread {
          flex-shrink: 0;
          background: rgba(201, 168, 124, 0.18);
          color: var(--amber-bright, #e3c49a);
          font-size: 0.5625rem;
          font-family: var(--font-mono, monospace);
          font-weight: 500;
          padding: 0.0625rem 0.375rem;
          border-radius: 99px;
          letter-spacing: 0.03em;
        }

        /* ═══ Parchment "Chats" panel ═══ */
        .thread-sidebar {
          background: var(--sidebar-bg);
          border: none;
          border-radius: var(--radius-panel, 14px);
          box-shadow: var(--panel-shadow, 0 10px 30px rgba(20, 10, 5, 0.35));
          width: var(--sidebar-width, 18rem);
          color: var(--surface-panel-text, #2c231f);
        }
        .thread-sidebar-header {
          padding: 1rem 1rem 0.85rem 1.25rem;
          border-bottom: 1px solid var(--divider, rgba(90, 65, 40, 0.2));
        }
        .thread-sidebar-title {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: normal;
          font-size: 1.6rem;
          font-weight: 500;
          line-height: 1.2;
          color: var(--text-primary, #2c231f);
        }
        .thread-collapse-btn { color: var(--text-secondary, #6b5d55); }
        .thread-collapse-btn:hover { color: var(--text-primary, #2c231f); }
        .thread-new-btn {
          width: 2.5rem;
          height: 2.5rem;
          color: var(--text-primary, #2c231f);
          border: 1px solid var(--control-border, rgba(90, 65, 40, 0.35));
          border-radius: 8px;
          background: var(--control-bg, rgba(255, 250, 235, 0.55));
        }
        .thread-new-btn svg { width: 18px; height: 18px; }
        .thread-new-btn:hover { color: var(--link, #6d5b93); border-color: var(--link, #6d5b93); }
        .thread-new-btn::before { display: none; }
        .plus-menu { background: var(--surface-popover, #faf4e5); color: var(--surface-popover-text, #2c231f); border-color: var(--surface-popover-border, rgba(90, 65, 40, 0.25)); box-shadow: 0 8px 24px rgba(20, 10, 5, 0.3); }
        .plus-menu-item { font-family: var(--font-serif, 'Lora', serif); font-size: 0.95rem; }

        .thread-list { padding: 0.6rem 0.7rem 0.4rem; }
        .thread-item {
          gap: 0.7rem;
          padding: 0.6rem 0.75rem;
          border-radius: 8px;
          font-size: 1.05rem;
          color: var(--text-primary, #2c231f);
          transition: background 150ms ease, color 150ms ease;
        }
        .thread-item::before { display: none; }
        .thread-item:hover { background: var(--bg-active, rgba(109, 91, 147, 0.09)); color: var(--text-primary, #2c231f); }
        .thread-item.active {
          background: var(--thread-active, #ddd6ec);
          color: var(--thread-active-text, #3b2f52);
          font-weight: 400;
        }
        .thread-name { font-family: var(--font-serif, 'Lora', serif); font-size: 1.05rem; }
        .thread-name::before {
          content: '';
          display: inline-block;
          width: 1.45rem;
          height: 1.45rem;
          border-radius: 50%;
          background: var(--bg-tertiary, #c9c1b3);
          vertical-align: middle;
          margin-right: 0.75rem;
          position: relative;
          top: -1px;
        }
        .thread-item.active .thread-name::before { background: var(--border-hover, #b5abc6); }
        .thread-item::after {
          content: '';
          flex-shrink: 0;
          width: 0.9rem;
          height: 0.9rem;
          /* the chevron takes the row's own secondary ink, so it reads on any material */
          background: var(--surface-panel-secondary, #6b5d55);
          -webkit-mask: no-repeat center / contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 5l7 7-7 7'/%3E%3C/svg%3E");
          mask: no-repeat center / contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 5l7 7-7 7'/%3E%3C/svg%3E");
        }
        .thread-unread { color: var(--surface-panel-text, #3b2f52); background: var(--bg-active, rgba(109, 91, 147, 0.18)); }
        .thread-more-btn { color: var(--text-secondary, #6b5d55); }
        .thread-more-btn:hover { background: var(--bg-active, rgba(109, 91, 147, 0.12)); color: var(--text-primary, #2c231f); }
        .thread-pin { color: var(--link, #6d5b93); }

        .zone-sections { border-top-color: var(--divider, rgba(90, 65, 40, 0.18)); }
        .zone-months {
          margin-top: 0.75rem;
          border-top: 1px solid var(--divider, rgba(90, 65, 40, 0.18));
          padding-top: 0.5rem;
        }
        .month-header {
          padding: 0.5rem 0.6rem 0.35rem;
          color: var(--text-secondary, #6b5d55);
        }
        .month-header:hover { background: var(--bg-hover, rgba(109, 91, 147, 0.06)); color: var(--text-primary, #2c231f); }
        .month-label { font-style: normal; font-size: 1rem; letter-spacing: 0; }
        .month-count { display: none; }
        .month-body { padding-left: 0; }

        .zone-archived {
          margin-top: auto;
          border-top: 1px solid var(--divider, rgba(90, 65, 40, 0.18));
          padding-top: 0.5rem;
          opacity: 1;
        }
        .archived-header {
          gap: 0.7rem;
          padding: 0.65rem 0.75rem;
          font-size: 1.05rem;
          color: var(--text-primary, #2c231f);
          opacity: 1;
        }
        .archived-header:hover { background: var(--bg-hover, rgba(109, 91, 147, 0.08)); }
        .archived-header .archived-icon { flex-shrink: 0; color: var(--text-secondary, #6b5d55); }
        .archived-label { flex: 1; font-style: normal; font-size: 1.05rem; letter-spacing: 0; }
        .archived-header .month-chevron { order: 3; }
        .archived-name, .archived-note { color: var(--text-secondary, #6b5d55); }
        .archived-row:hover { background: var(--bg-hover, rgba(109, 91, 147, 0.06)); }
        .thread-name-input { color: var(--text-primary, #2c231f); }
      `}</style>
    </div>
  );
}

// ─── Main ChatView ─────────────────────────────────────────────────────────────

export function ChatView({ embedded = false }: { embedded?: boolean }) {
  const connectionState = useChatStore(s => s.connectionState);
  const lastError = useChatStore(s => s.lastError);
  const mindStatus = useChatStore(s => s.mindStatus);
  const identityStatus = useChatStore(s => s.identityStatus);
  const pendingMessages = useChatStore(s => s.pendingMessages);
  const messages = useChatStore(s => s.messages);
  const threads = useChatStore(s => s.threads);
  const activeThreadId = useChatStore(s => s.activeThreadId);
  const presence = useChatStore(s => s.presence);
  const contextUsage = useChatStore(s => s.contextUsage);
  const toolEvents = useChatStore(s => s.toolEvents);
  const thinkingEvents = useChatStore(s => s.thinkingEvents);
  const send = useChatStore(s => s.send);
  const connect = useChatStore(s => s.connect);
  const disconnect = useChatStore(s => s.disconnect);
  const loadThread = useChatStore(s => s.loadThread);
  const streamingInfo = useChatStore(useShallow(getStreamingInfo));
  // Canvas panel
  const threadCanvases = useChatStore(s => s.threadCanvases);
  const openCanvasId = useChatStore(s => s.openCanvasId);
  const openCanvas = useChatStore(s => s.openCanvas);
  const closeCanvas = useChatStore(s => s.closeCanvas);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false); // phone: the overflow with search and the chat tools
  // Desktop: the threads panel can be tucked away. Remembered per browser.
  const [threadsCollapsed, setThreadsCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('sanctum.threadsCollapsed') === '1'; } catch { return false; }
  });
  const setCollapsed = (v: boolean) => {
    setThreadsCollapsed(v);
    try { localStorage.setItem('sanctum.threadsCollapsed', v ? '1' : '0'); } catch { /* ignore */ }
  };

  // ─── Connection tabs state ────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>('daily');
  const [tabThreadIds, setTabThreadIds] = useState<string[]>([]);

  // ─── Search panel ─────────────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);

  // ─── Reply-to context ─────────────────────────────────────────────────────────
  const [replyTo, setReplyTo] = useState<{ id: string; preview: string } | null>(null);

  const isStreamingActive = streamingInfo.messageId !== null;

  useEffect(() => {
    // Only manage connection lifecycle when NOT embedded — the shell owns it when embedded.
    if (!embedded) {
      connect();
      return () => disconnect();
    }
  }, [embedded]);

  // ─── Daily thread resolution ──────────────────────────────────────────────────
  // Calls GET /api/threads/today (idempotent ensure + return), then loads it as
  // the active thread. This replaces the old stitched-snapshot DailyMessageView.
  const resolveDailyThread = useCallback(async (force = false) => {
    try {
      const res = await fetch(`${BASE}/api/threads/today`);
      if (!res.ok) throw new Error(`threads/today ${res.status}`);
      const data = await res.json() as { thread: { id: string; name: string; type: string } };
      // Only adopt the daily if nothing is active yet, or the active thread is
      // itself a daily. Read from getState() at await-resolution time (NOT the
      // render closure) so a named thread selected while this fetch was in
      // flight — or active across a remount — is respected and never clobbered.
      // This is the fix for "messages in a named thread route to the daily":
      // activeTab (default 'daily') was decoupled from activeThreadId, so the
      // resolver kept overwriting the user's selection on every ChatView mount.
      // Adopt today's daily ONLY when forced (an explicit Daily-tab click) or when
      // NOTHING is active yet (first load). NEVER bump away from a thread the user is
      // deliberately viewing — that was the bug: selecting a named thread, or reading
      // an old daily, got clobbered back to today's daily on every remount/reconnect
      // (because activeTab resets to 'daily' on remount and re-armed this resolver).
      const current = useChatStore.getState().activeThreadId;
      if (data.thread?.id && (force || !current)) {
        await loadThread(data.thread.id);
      }
    } catch (err) {
      console.warn('[ChatView] Failed to resolve daily thread:', err);
    }
  }, [loadThread]);

  // On mount (Daily tab is the default) and whenever we switch back to it,
  // resolve + load today's daily thread so it becomes the live active thread.
  useEffect(() => {
    if (activeTab === 'daily') {
      void resolveDailyThread();
    }
  }, [activeTab, resolveDailyThread]);

  // ─── Send — never drop silently ──────────────────────────────────────────────
  const handleSend = useCallback(async (content: string, attachments?: PendingAttachment[]) => {
    // Read the active thread FRESH from the store at send time — never trust the
    // closure's activeThreadId. A stale closure / mobile remount race was the bug:
    // the screen showed a named thread but the closure carried a null/old id, so the
    // !threadId branch below resolved the daily and the message fired into the daily.
    let threadId = useChatStore.getState().activeThreadId;
    if (!threadId) {
      // No active thread — resolve the daily thread first, then send
      try {
        const res = await fetch(`${BASE}/api/threads/today`);
        if (res.ok) {
          const data = await res.json() as { thread: { id: string } };
          if (data.thread?.id) {
            await loadThread(data.thread.id);
            threadId = data.thread.id;
          }
        }
      } catch (err) {
        console.warn('[ChatView] handleSend: failed to resolve daily thread', err);
      }
    }
    if (!threadId) return; // genuine failure — backend unreachable

    // Build metadata.attachments when files are present.
    // Strip previewUrl (blob URL, client-only) before sending.
    const attachmentsMeta = attachments && attachments.length > 0
      ? attachments.map(({ fileId, filename, contentType, url }) => ({ fileId, filename, contentType, url }))
      : undefined;

    const msg: Parameters<typeof send>[0] = {
      type: 'message',
      threadId,
      content,
      contentType: 'text',
      ...(replyTo ? { replyToId: replyTo.id } : {}),
      ...(attachmentsMeta ? { metadata: { attachments: attachmentsMeta } } : {}),
    };
    send(msg);
    setReplyTo(null);
  }, [activeThreadId, send, replyTo, loadThread]);

  const handleStop = useCallback(() => {
    send({ type: 'stop_generation' });
  }, [send]);

  const handleTabChange = useCallback((tab: ActiveTab, threadIds: string[]) => {
    setActiveTab(tab);
    setTabThreadIds(threadIds);
    if (tab === 'daily') {
      // Explicit Daily-tab click → FORCE-load today's daily. The passive resolver
      // only loads it when nothing is active, so clicking Daily must force it here.
      void resolveDailyThread(true);
    } else if (threadIds.length > 0) {
      // For non-daily tabs, load the first thread so messages populate.
      void loadThread(threadIds[0]);
    }
  }, [loadThread, resolveDailyThread]);

  const handleReplyTo = useCallback((id: string, preview: string) => {
    setReplyTo({ id, preview });
  }, []);

  const handleClearReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  const activeThread = threads.find(t => t.id === activeThreadId);
  const identity = useIdentity();
  const companionName = identity.companion_name;
  const threadName = activeThread?.name ?? 'Companion';

  return (
    <div className={`chat-view${threadsCollapsed ? ' threads-collapsed' : ''}`}>
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <button
          className="sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}

      {/* Sidebar */}
      <div className={`sidebar-wrapper${sidebarOpen ? ' open' : ''}${threadsCollapsed ? ' collapsed' : ''}`}>
        <ThreadSidebar onClose={() => setSidebarOpen(false)} onCollapse={() => setCollapsed(true)} />
      </div>

      {/* Main area + canvas panel side by side */}
      <div className="chat-main-row">

      {/* Main area */}
      <div className="main-area">
        {/* Header */}
        <header className={`chat-header${toolsOpen ? ' tools-open' : ''}`}>
          {threadsCollapsed && (
            <button
              className="threads-reveal-btn"
              onClick={() => setCollapsed(false)}
              aria-label="Show threads"
              title="Show threads"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </button>
          )}
          {/* Phones: menu (home, chat, notes, settings) at the left */}
          <button
            className="menu-btn"
            onClick={() => window.dispatchEvent(new CustomEvent('sanctum:open-drawer'))}
            aria-label="Open menu"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
          <div className="header-identity">
            <img className="header-avatar" src={avatarSrc(identity)} alt="" aria-hidden="true" width={28} height={28} />
            {/* Lora italic — the name carries weight */}
            <span className="header-name">{companionName}</span>
            <PresenceDot status={presence} />
            {/* Phones: tap the chevron to pick a thread */}
            <button className="threads-chevron" onClick={() => setSidebarOpen(s => !s)} aria-label="Threads" aria-expanded={sidebarOpen}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {threadName !== 'Companion' && (
              <span className="header-thread">{threadName}</span>
            )}
            {/* Model · effort strip — bound to active thread, applies to next message */}
            <ModelEffortStrip
              threadId={activeThreadId}
              threadModel={activeThread?.model}
              threadEffort={activeThread?.effort}
            />
            {/* Show-thinking toggle — gates thinking timeline per thread */}
            <ShowThinkingToggle
              threadId={activeThreadId}
              showThinking={activeThread?.show_thinking ?? true}
            />
            {/* Context fullness gauge — updates live from context_usage events */}
            {contextUsage !== null && (
              <ContextGauge
                percentage={contextUsage.percentage}
                tokensUsed={contextUsage.tokensUsed}
                contextWindow={contextUsage.contextWindow}
              />
            )}
          </div>

          {/* Phones: one overflow for search and the chat tools */}
          <button className="more-btn" onClick={() => setToolsOpen(v => !v)} aria-label="More" aria-expanded={toolsOpen}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
          </button>
          <div className="header-actions">
            {/* Phones only: the pickers live in the overflow */}
            <div className="tools-mobile-extras">
              <ModelEffortStrip threadId={activeThreadId} threadModel={activeThread?.model} threadEffort={activeThread?.effort} />
              <ShowThinkingToggle threadId={activeThreadId} showThinking={activeThread?.show_thinking ?? true} />
            </div>
            {/* Canvas panel toggle */}
            <button
              className={`canvas-panel-btn${openCanvasId !== null ? ' active' : ''}${threadCanvases.length === 0 && openCanvasId === null ? ' disabled' : ''}`}
              onClick={() => {
                if (openCanvasId !== null) {
                  closeCanvas();
                } else if (threadCanvases.length > 0) {
                  // Open most recent canvas
                  const sorted = [...threadCanvases].sort(
                    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
                  );
                  openCanvas(sorted[0].id);
                }
              }}
              disabled={threadCanvases.length === 0 && openCanvasId === null}
              aria-label={openCanvasId !== null ? 'Close canvas panel' : threadCanvases.length > 0 ? 'Open canvas panel' : 'No canvases in this thread'}
              title={openCanvasId !== null ? 'Close canvas panel' : threadCanvases.length > 0 ? `Canvas (${threadCanvases.length})` : 'No canvases'}
            >
              {/* Document/panel icon */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              {threadCanvases.length > 0 && openCanvasId === null && (
                <span className="canvas-panel-count">{threadCanvases.length}</span>
              )}
            </button>

            {/* Jump to date/time */}
            <JumpToDateTime messages={messages} />

            {/* Search toggle */}
            <button
              className={`search-btn${searchOpen ? ' active' : ''}`}
              onClick={() => setSearchOpen(s => !s)}
              aria-label={searchOpen ? 'Close search' : 'Search messages'}
              title="Search (⌘K)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
              </svg>
            </button>

            {isStreamingActive && (
              <button
                className="stop-btn"
                onClick={handleStop}
                aria-label="Stop generation (Esc)"
                title="Stop (Esc)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2.5" />
                </svg>
              </button>
            )}
          </div>
        </header>

        {/* Connection tabs — platform switcher */}
        <ConnectionTabs
          activeTab={activeTab}
          onTabChange={handleTabChange}
        />

        {/* Connection status bar */}
        <ConnectionStatus
          state={connectionState}
          error={lastError}
          pendingCount={pendingMessages.length}
          mind={mindStatus}
          identity={identityStatus}
        />

        {/* Search panel — overlays the message area when open */}
        {searchOpen && (
          <SearchPanel
            onClose={() => setSearchOpen(false)}
            onSelectThread={(threadId) => {
              loadThread(threadId);
              setSearchOpen(false);
            }}
          />
        )}

        {/* Messages — live thread view (daily tab resolves to today's real thread) */}
        <MessageList
          messages={messages}
          toolEvents={toolEvents}
          thinkingEvents={thinkingEvents}
          streaming={streamingInfo}
          presence={presence}
          onReply={handleReplyTo}
          showThinking={activeThread?.show_thinking ?? true}
          threadCanvases={threadCanvases}
          onOpenCanvas={openCanvas}
        />

        {/* Reply-to banner */}
        {replyTo && (
          <div className="reply-banner">
            <span className="reply-label">replying to</span>
            <span className="reply-preview">{replyTo.preview}</span>
            <button className="reply-clear" onClick={handleClearReply} aria-label="Cancel reply">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Composer — onSend receives (content, attachments?) */}
        <Composer
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={isStreamingActive}
          disabled={connectionState !== 'connected'}
        />
      </div>{/* /main-area */}

      {/* Canvas panel — slides in from the right */}
      <CanvasPanel />

      </div>{/* /chat-main-row */}

      <style>{`
        .chat-view {
          display: flex;
          /* Fill the routed content area (which on mobile already sits below the
             shell top bar) — NOT 100dvh, which would overflow under the bar. */
          height: 100%;
          overflow: hidden;
          max-width: 100vw;
          background: var(--bg-primary, #0c0b09);
        }

        /* Flex row: [main-area] [CanvasPanel] */
        .chat-main-row {
          flex: 1;
          min-width: 0;
          display: flex;
          height: 100%;
          overflow: hidden;
        }

        /* Canvas panel toggle button */
        .canvas-panel-btn {
          display: grid;
          place-items: center;
          width: 1.75rem;
          height: 1.75rem;
          color: var(--text-muted, #6a6258);
          border-radius: 0.375rem;
          position: relative;
          isolation: isolate;
          transition: color var(--tx-fast, 240ms ease);
          border: none;
          background: transparent;
          cursor: pointer;
        }
        .canvas-panel-btn::before {
          content: '';
          position: absolute; inset: 0;
          border-radius: inherit;
          z-index: -1;
          opacity: 0;
          background: radial-gradient(circle, var(--amber-glow, rgba(201,168,124,0.18)), transparent 70%);
          transition: opacity var(--tx-base, 380ms ease);
        }
        .canvas-panel-btn:hover:not(:disabled) { color: var(--text-primary, #e2dbd0); }
        .canvas-panel-btn:hover:not(:disabled)::before { opacity: 1; }
        .canvas-panel-btn.active {
          color: var(--amber, #c9a87c);
        }
        .canvas-panel-btn.active::before { opacity: 0.7; }
        .canvas-panel-btn:active:not(:disabled) {
          transform: scale(var(--press-scale, 0.985));
          transition: transform 140ms var(--hearth-curve, ease);
        }
        .canvas-panel-btn:disabled {
          color: var(--text-muted);
          cursor: default;
        }
        .canvas-panel-count {
          position: absolute;
          top: 0.125rem;
          right: 0.125rem;
          font-size: 0.6667rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          background: rgba(201, 168, 124, 0.20);
          color: var(--amber, #c9a87c);
          border-radius: 99px;
          padding: 0 0.2rem;
          min-width: 0.75rem;
          text-align: center;
          pointer-events: none;
          letter-spacing: 0.03em;
          line-height: 1.4;
        }

        .sidebar-overlay {
          display: none;
        }

        .sidebar-wrapper {
          display: none;
          flex-shrink: 0;
        }

        @media (min-width: 769px) {
          .sidebar-wrapper {
            display: flex;
            width: var(--sidebar-width, 16rem);
            overflow: hidden;
            transition: width 240ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1));
          }
          .sidebar-wrapper.collapsed {
            width: 0;
          }
          .threads-reveal-btn {
            display: grid;
            place-items: center;
            width: 1.75rem;
            height: 1.75rem;
            margin-right: 0.25rem;
            color: var(--text-muted, #6a6258);
            border-radius: 0.375rem;
            transition: color 240ms ease;
          }
          .threads-reveal-btn:hover { color: var(--text-primary, #e2dbd0); }
        }
        @media (max-width: 768px) {
          .threads-reveal-btn, .thread-collapse-btn { display: none; }
        }

        @media (max-width: 768px) {
          /* Shell owns nav + chats in ONE drawer on mobile via the top-bar
             hamburger. Hide the in-pane chat sidebar + its overlay — but KEEP the
             chat header: it carries the model/effort pickers + thread name that the
             shell top bar does NOT. Its redundant safe-area top inset is dropped in
             the base rule so it doesn't add dead space under the topbar. */
          .sidebar-wrapper {
            display: flex;
            position: fixed;
            top: 0;
            left: 0;
            bottom: 0;
            z-index: 100;
            transform: translateX(-100%);
            transition: transform 280ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1));
            /* Hidden but mounted — allows CSS transition */
            visibility: hidden;
            pointer-events: none;
          }
          .sidebar-wrapper.open {
            transform: translateX(0);
            visibility: visible;
            pointer-events: auto;
          }
          .sidebar-overlay {
            display: block;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.45);
            z-index: 99;
            border: none;
            /* Fade in/out */
            animation: overlayFadeIn 200ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)) both;
          }
          @keyframes overlayFadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        }

        /* Extra mobile: chat header needs top safe-area even without notch on older devices */
        @media (max-width: 600px) {
          .chat-header {
            gap: 0.5rem;
            padding-left: 0.875rem;
            padding-right: 0.875rem;
          }
          /* On mobile, the header-thread can wrap; allow it */
          .header-identity {
            gap: 0.3rem;
            flex-wrap: wrap;
          }
        }

        .main-area {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow: hidden;
          background: transparent;
          position: relative;
        }

        /* Composer floats over the message list — content scrolls behind the glass */
        .main-area > .composer {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          z-index: 10;
        }

        /* Reply banner sits just above the floating composer */
        .main-area > .reply-banner {
          position: absolute;
          bottom: 4.25rem;
          left: 0;
          right: 0;
          z-index: 11;
        }

        /* Header — lit-from-within, amber-tinted border */
        .chat-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          /* No safe-area-inset-top here: on mobile the shell topbar above already
             clears the notch (adding it again was the dead band under the topbar);
             on desktop the inset is 0. Plain padding works for both. */
          padding: 0.75rem 1.25rem 0.75rem;
          background: rgba(19, 18, 16, 0.45);
          backdrop-filter: blur(14px) saturate(1.05);
          border-bottom: 1px solid rgba(201, 168, 124, 0.08);
          flex-shrink: 0;
        }

        .menu-btn {
          /* Hidden everywhere: desktop shows the sidebar inline; mobile uses the
             shell's single top-bar hamburger. No per-view hamburger. */
          display: none;
          align-items: center;
          color: var(--text-muted, #6a6258);
          padding: 0.25rem;
          border-radius: 0.375rem;
          position: relative;
          isolation: isolate;
          transition: color var(--tx-fast, 240ms ease);
          flex-shrink: 0;
        }
        .menu-btn::before {
          content: '';
          position: absolute; inset: 0;
          border-radius: inherit;
          z-index: -1;
          opacity: 0;
          background: radial-gradient(circle, var(--amber-glow, rgba(201,168,124,0.18)), transparent 70%);
          transition: opacity var(--tx-base, 380ms ease);
        }
        .menu-btn:hover { color: var(--text-primary, #e2dbd0); }
        .menu-btn:hover::before { opacity: 1; }
        .menu-btn:active {
          transform: scale(var(--press-scale, 0.985));
          transition: transform 140ms var(--hearth-curve, ease);
        }

        @media (min-width: 769px) {
          .menu-btn { display: none; }
        }
        .menu-btn-label { display: none; }
        @media (max-width: 768px) { .menu-btn-label { display: inline; } }
        @media (max-width: 768px) {
          /* Phones: the chat has its own hamburger; it slides the thread list in. */
          .menu-btn { display: inline-flex; color: #e6dac3; }
          .thread-collapse-btn { display: none; }
        }

        .header-identity {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex: 1;
          min-width: 0;
        }

        /* The name — Lora italic, amber. Weight without heaviness. */
        .header-name {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 1.0625rem;
          font-weight: 500;
          color: var(--amber, #c9a87c);
          letter-spacing: 0.01em;
          flex-shrink: 0;
          line-height: 1.2;
        }

        .header-thread {
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.75rem;
          color: var(--text-muted, #6a6258);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-weight: 400;
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-shrink: 0;
        }

        /* Search button — quiet at rest, amber on active */
        .search-btn {
          display: grid;
          place-items: center;
          width: 1.75rem;
          height: 1.75rem;
          color: var(--text-muted, #6a6258);
          border-radius: 0.375rem;
          position: relative;
          isolation: isolate;
          transition: color var(--tx-fast, 240ms ease);
        }
        .search-btn::before {
          content: '';
          position: absolute; inset: 0;
          border-radius: inherit;
          z-index: -1;
          opacity: 0;
          background: radial-gradient(circle, var(--amber-glow, rgba(201,168,124,0.18)), transparent 70%);
          transition: opacity var(--tx-base, 380ms ease);
        }
        .search-btn:hover { color: var(--text-primary, #e2dbd0); }
        .search-btn:hover::before { opacity: 1; }
        .search-btn.active {
          color: var(--amber, #c9a87c);
        }
        .search-btn.active::before { opacity: 0.7; }
        .search-btn:active {
          transform: scale(var(--press-scale, 0.985));
          transition: transform 140ms var(--hearth-curve, ease);
        }

        /* Reply-to banner — sits between message list and composer */
        .reply-banner {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.4375rem 1.25rem;
          background: rgba(201, 168, 124, 0.06);
          border-top: 1px solid rgba(201, 168, 124, 0.10);
          flex-shrink: 0;
          max-width: 100%;
          overflow: hidden;
        }
        .reply-label {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.6875rem;
          color: var(--amber-dim, #a08960);
          white-space: nowrap;
          flex-shrink: 0;
        }
        .reply-preview {
          font-size: 0.75rem;
          color: var(--text-secondary, #a09689);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          min-width: 0;
        }
        .reply-clear {
          flex-shrink: 0;
          display: grid;
          place-items: center;
          width: 1.25rem;
          height: 1.25rem;
          color: var(--text-muted, #6a6258);
          border-radius: 50%;
          transition: color var(--tx-fast, 240ms ease), background var(--tx-fast, 240ms ease);
        }
        .reply-clear:hover {
          color: var(--text-primary, #e2dbd0);
          background: rgba(255, 255, 255, 0.06);
        }

        /* Stop button — muted, pulsing */
        .stop-btn {
          display: grid;
          place-items: center;
          width: 1.75rem;
          height: 1.75rem;
          color: var(--status-error-text);
          border-radius: 0.375rem;
          background: rgba(192, 117, 109, 0.08);
          border: 1px solid rgba(192, 117, 109, 0.15);
          animation: stopPulse 1.5s ease-in-out infinite;
          transition: color var(--tx-fast, 240ms ease), background var(--tx-fast, 240ms ease);
        }
        .stop-btn:hover {
          color: var(--status-error-text);
          background: rgba(192, 117, 109, 0.15);
        }
        .stop-btn:active {
          transform: scale(var(--press-scale, 0.985));
          transition: transform 140ms var(--hearth-curve, ease);
        }

        @keyframes stopPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.60; }
        }

        /* ═══ Painted-kitchen layout ═══ */
        .chat-view {
          background: transparent;
          padding: 1.25rem 1.5rem 1.25rem 1.25rem;
        }
        .chat-main-row { gap: 1rem; }
        @media (min-width: 769px) {
          /* The closed canvas panel is a zero-width flex item; its gap pushed the right gutter 1rem past the left. */
          .chat-main-row { gap: 0; }
          .chat-main-row > .cpanel-wrapper--open { margin-left: 1rem; }
        }
        .chat-view .main-area { border-radius: var(--radius-panel, 14px); }

        @media (min-width: 769px) {
          .sidebar-wrapper {
            overflow: visible;
            margin-right: 1rem;
            width: var(--sidebar-width, 18rem);
          }
          .sidebar-wrapper.collapsed { display: none; }
          .threads-reveal-btn {
            width: 2.25rem;
            height: 2.25rem;
            margin-right: 0.35rem;
            padding-right: 0.6rem;
            border-right: 1px solid var(--divider, rgba(90, 65, 40, 0.25));
            border-radius: 0;
            color: var(--text-primary, #2c231f);
            width: auto;
          }
          /* Collapsed: the chat column widens into one parchment card */
          .chat-view.threads-collapsed { padding-left: 1.5rem; }
          .chat-view.threads-collapsed .main-area {
            background: rgba(246, 238, 219, 0.16);
            -webkit-backdrop-filter: blur(6px);
            backdrop-filter: blur(6px);
            border: 1px solid rgba(255, 250, 240, 0.28);
            box-shadow: var(--panel-shadow, 0 10px 30px rgba(20, 10, 5, 0.35));
            max-width: none;
            margin: 0 auto;
          }
          /* Collapsed: the tab becomes a small "Daily ⌄" pill at the top right */
          .chat-view.threads-collapsed .conn-tabs {
            justify-content: flex-end;
            background: transparent;
            border-bottom: none;
            box-shadow: none;
            padding: 0.75rem 1.25rem 0;
            gap: 0.5rem;
          }
          .chat-view.threads-collapsed .conn-tab {
            background: var(--tab-active-bg, #faf4e6);
            color: var(--tab-active-text, #2c231f);
            border: 1px solid var(--control-border, rgba(90, 65, 40, 0.3));
            border-radius: 8px;
            padding: 0.4rem 0.9rem;
            font-size: 0.95rem;
          }
          .chat-view.threads-collapsed .conn-tab::after { display: none; }
          .chat-view.threads-collapsed .conn-tab.active::before {
            content: '';
            order: 2;
            width: 0.5rem;
            height: 0.5rem;
            margin-left: 0.4rem;
            border-right: 1.5px solid var(--tab-active-text, #3b2f52);
            border-bottom: 1.5px solid var(--tab-active-text, #3b2f52);
            transform: rotate(45deg) translateY(-2px);
          }
          /* Open: header + tabs are parchment, the message area shows the wall */
          .chat-view:not(.threads-collapsed) .message-list-container {
            background: transparent;
          }
        }

        @media (max-width: 768px) {
          .chat-view { padding: 12px; }
          .chat-view .main-area {
            background: rgba(246, 238, 219, 0.16);
            -webkit-backdrop-filter: blur(6px);
            backdrop-filter: blur(6px);
            border: 1px solid rgba(255, 250, 240, 0.28);
            box-shadow: var(--panel-shadow, 0 10px 30px rgba(20, 10, 5, 0.35));
          }
        }

        .chat-header {
          background: linear-gradient(180deg, #f8f1e0 0%, #f1e7d0 100%);
          backdrop-filter: none;
          border-bottom: 1px solid rgba(90, 65, 40, 0.2);
          border-radius: var(--radius-panel, 14px) var(--radius-panel, 14px) 0 0;
          padding: 0.85rem 1.4rem 0.75rem;
          color: var(--text-primary, #2c231f);
        }
        .header-name {
          font-style: normal;
          font-size: 2rem;
          font-weight: 500;
          line-height: 1.15;
          color: var(--text-primary, #2c231f);
          letter-spacing: 0;
        }
        .chat-header .presence-dot { width: 0.7rem; height: 0.7rem; margin-left: 0.15rem; }
        .header-thread { color: var(--text-secondary, #6b5d55); font-size: 0.85rem; }
        .header-actions { gap: 0.5rem; }
        .search-btn, .canvas-panel-btn { width: 2.25rem; height: 2.25rem; color: var(--text-primary, #2c231f); }
        .search-btn svg { width: 22px; height: 22px; }
        .canvas-panel-btn svg { width: 20px; height: 20px; }
        .search-btn:hover, .canvas-panel-btn:hover:not(:disabled) { color: var(--link, #6d5b93); }
        .search-btn.active, .canvas-panel-btn.active { color: var(--link, #6d5b93); }
        .canvas-panel-count { background: var(--bg-active, rgba(109, 91, 147, 0.2)); color: var(--surface-panel-text, #3b2f52); }
        .reply-banner {
          background: var(--surface-panel, #f3ead7);
          color: var(--surface-panel-text, #2c231f);
          border-top: 1px solid var(--divider, rgba(90, 65, 40, 0.18));
          margin: 0 0.75rem;
          border-radius: 10px 10px 0 0;
          width: auto;
          left: 0; right: 0;
        }
        .reply-label { color: var(--link, #6d5b93); }
        .reply-clear:hover { background: var(--bg-hover, rgba(90, 65, 40, 0.1)); }
        .message-list { max-width: none; }

        /* ── The wall shows through the chat. Nothing sits between the room and
           the bubbles; the bubbles carry the colour. Header is green glass,
           the threads panel stays parchment. ── */
        .chat-view .main-area,
        .chat-view.threads-collapsed .main-area {
          background: transparent;
          -webkit-backdrop-filter: none;
          backdrop-filter: none;
          border: none;
          box-shadow: none;
        }
        .chat-view .chat-header,
        .chat-view.threads-collapsed .chat-header {
          background: var(--surface-header);
          -webkit-backdrop-filter: var(--surface-header-blur, blur(8px));
          backdrop-filter: var(--surface-header-blur, blur(8px));
          border: 1px solid var(--surface-header-border, rgba(255, 250, 240, 0.14));
          border-bottom-color: var(--surface-header-border, rgba(255, 250, 240, 0.18));
          border-radius: var(--radius-panel, 14px);
          color: var(--surface-header-text);
        }
        /* The glass header makes its own stacking layer; lift it above the
           message list so the date picker and menus open on top of the chat. */
        .chat-view .chat-header { position: relative; z-index: 40; }
        /* Inside the header every ink variable points at the header's own pair, so the model
           picker, mode strip and status marks read on it whatever the panel palette is. */
        .chat-view .chat-header {
          --text-primary: var(--surface-header-text);
          --text-secondary: var(--surface-header-text);
          --text-muted: var(--surface-header-muted);
          --amber: var(--surface-header-title);
          --amber-bright: var(--surface-header-title);
          --amber-dim: var(--surface-header-muted);
          --link: var(--surface-header-title);
          --bg-secondary: var(--surface-header-menu);
          --bg-input: var(--surface-header-menu);
        }
        .chat-view .header-name { color: var(--surface-header-title, #f3ead7); }
        .chat-view .header-thread { color: var(--surface-header-muted, #cdbfa8); }
        .chat-view .search-btn, .chat-view .canvas-panel-btn, .chat-view .threads-reveal-btn, .chat-view .menu-btn { color: var(--surface-header-icon, #e6dac3); }
        .chat-view .search-btn:hover, .chat-view .canvas-panel-btn:hover:not(:disabled), .chat-view .search-btn.active, .chat-view .canvas-panel-btn.active { color: var(--surface-header-title, #f3ead7); }
        .chat-view .canvas-panel-btn:disabled { color: var(--surface-header-muted, #cdbfa8); }
        .chat-view .canvas-panel-count { background: var(--header-badge-bg, rgba(109, 91, 147, 0.2)); color: var(--header-badge-text, #3b2f52); }
        .chat-view .threads-reveal-btn { border-right-color: var(--surface-header-border, rgba(255, 250, 240, 0.2)); }
        .chat-view .conn-tab, .chat-view.threads-collapsed .conn-tab {
          background: var(--tab-bg, rgba(243, 234, 215, 0.14));
          color: var(--tab-text, #efe4d0);
          border-color: var(--tab-border, rgba(255, 250, 240, 0.22));
        }
        .chat-view .conn-tab.dim { color: var(--tab-dim-text, #cdbfa8); }
        .chat-view .conn-tab.active { background: var(--tab-active-bg, rgba(243, 234, 215, 0.9)); color: var(--tab-active-text, #2c231f); }
        .chat-view .conn-tab-badge { background: var(--tab-badge-bg, rgba(109, 91, 147, 0.18)); color: var(--tab-badge-text, #3b2f52); }
        /* Labels that float between bubbles (day, "new", fold notes, the empty line) carry their own opaque plate. */
        .chat-view .day-divider-label, .chat-view .new-divider-label, .chat-view .system-text {
          color: var(--chip-text, #e6dac3);
          background: var(--chip-bg, transparent);
          padding: var(--chip-pad, 0);
          border-radius: 999px;
          text-shadow: var(--chip-shadow, 0 1px 4px rgba(0,0,0,0.5));
        }

        /* ── Phone chat: one compact header attached to the top edge.
           Left: menu. Centre: avatar, name, chevron (thread picker). Right: an
           overflow holding search and the chat tools. Threads slide up from the
           bottom. Messages start below the header. ── */
        .header-avatar, .threads-chevron, .more-btn, .tools-mobile-extras { display: none; }
        @media (max-width: 768px) {
          .chat-view { padding: 0; }
          .chat-view .main-area { border-radius: 0; }
          .chat-view .chat-header, .chat-view.threads-collapsed .chat-header {
            position: sticky;
            top: 0;
            z-index: 40;
            display: flex;
            flex-wrap: nowrap;
            align-items: center;
            gap: 0.4rem;
            margin: 0;
            padding: calc(0.5rem + env(safe-area-inset-top, 0px)) 0.6rem 0.5rem;
            border-radius: 0;
            border-left: none;
            border-right: none;
            border-top: none;
            background: var(--surface-header-mobile, rgba(44, 50, 30, 0.92));
          }
          .chat-view .menu-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 2.5rem;
            height: 2.5rem;
            padding: 0;
            color: var(--surface-header-text, #efe4d0);
            border: none;
            background: transparent;
            flex-shrink: 0;
          }
          .chat-view .header-identity {
            display: flex;
            flex-wrap: nowrap;
            align-items: center;
            justify-content: center;
            gap: 0.4rem;
            flex: 1;
            min-width: 0;
          }
          .chat-view .header-avatar { display: block; width: 28px; height: 28px; object-fit: contain; flex-shrink: 0; }
          .chat-view .header-name { font-size: 1.15rem; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .chat-view .threads-chevron {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 2rem;
            height: 2rem;
            color: var(--surface-header-icon, #e6dac3);
            border: none;
            background: transparent;
            border-radius: 999px;
            flex-shrink: 0;
          }
          .chat-view .header-thread,
          .chat-view .header-identity .model-effort-strip,
          .chat-view .header-identity > :not(.header-name):not(.header-thread):not(.presence-dot):not(.model-effort-strip):not(.header-avatar):not(.threads-chevron) { display: none; }
          .chat-view .more-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 2.5rem;
            height: 2.5rem;
            color: var(--surface-header-text, #efe4d0);
            border: none;
            background: transparent;
            flex-shrink: 0;
          }
          /* the overflow: hidden until opened, then a panel under the header's right edge */
          .chat-view .header-actions { display: none; }
          .chat-view .chat-header.tools-open .header-actions {
            display: flex;
            flex-direction: column;
            align-items: stretch;
            gap: 0.5rem;
            position: absolute;
            top: 100%;
            right: 0.5rem;
            min-width: 12rem;
            padding: 0.6rem;
            background: var(--surface-header-menu, rgba(22, 16, 20, 0.94));
            border: 1px solid var(--surface-header-border, rgba(255, 250, 240, 0.16));
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
            z-index: 50;
          }
          .chat-view .tools-mobile-extras { display: flex; flex-direction: column; gap: 0.4rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--surface-header-border, rgba(255, 250, 240, 0.12)); }
          .chat-view .header-actions > button { justify-content: flex-start; width: 100%; height: 2.5rem; color: var(--surface-header-text, #efe4d0); }
          /* threads: a sheet from the bottom */
          .sidebar-wrapper {
            top: auto;
            bottom: 0;
            left: 0;
            right: 0;
            height: 72vh;
            transform: translateY(100%);
          }
          .sidebar-wrapper.open { transform: translateY(0); }
          .sidebar-wrapper .thread-sidebar { width: 100%; height: 100%; border-radius: 16px 16px 0 0; }
        }
      `}</style>
    </div>
  );
}
