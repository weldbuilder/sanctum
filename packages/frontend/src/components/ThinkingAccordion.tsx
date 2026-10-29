/**
 * ThinkingAccordion
 *
 * The collapsed ember-pill + expandable interleaved timeline.
 * Used in two contexts:
 *
 *   1. LIVE — during streaming (MessageList passes `timelineEntries` from the store).
 *      The pill shows "⬡ thinking · N tools" and stays COLLAPSED by default.
 *      Clicking opens the timeline. RAF-coalescing in the store means only the
 *      in-progress entry re-renders per frame; completed entries are React.memo'd.
 *
 *   2. PERSISTED — from message.metadata.segments (MessageBubble).
 *      Same pill, same expansion, just driven by segments instead of live entries.
 *
 * Design language: warm obsidian, amber ember, Lora italic for thinking prose,
 * JetBrains Mono for tool names. The collapsed pill is deliberately low-contrast
 * and small — a quiet ember, not a banner. Expand uses transform/opacity (NOT
 * height animation) so streaming content doesn't jank-thrash layout.
 */

import React, { useState, useCallback, memo, useRef, useEffect } from 'react';
import type { TimelineEntry, ThinkingEntry, ToolEntry } from '../store/chat';
import type { MessageSegment } from '@sanctum/shared';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatToolOutput(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 2) {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch {}
  }
  return raw;
}

// ─── Single thinking row (memoized — only re-renders when content changes) ────

interface ThinkingRowProps {
  id: string;
  content: string;
  summary: string;
  isComplete: boolean;
  isLive: boolean; // true = streaming, false = persisted/history
}

const ThinkingRow = memo(function ThinkingRow({ content, summary, isComplete, isLive }: ThinkingRowProps) {
  const [expanded, setExpanded] = useState(false);
  // Wall-clock start for duration display — captured on first mount (row appears
  // when thinking starts; ref never changes after that).
  const startTimeRef = useRef<number>(Date.now());
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);

  // When isComplete flips true, freeze the elapsed duration.
  const prevCompleteRef = useRef(isComplete);
  useEffect(() => {
    if (isComplete && !prevCompleteRef.current) {
      const secs = (Date.now() - startTimeRef.current) / 1000;
      setDurationSeconds(Math.round(secs * 10) / 10); // 1 decimal
    }
    prevCompleteRef.current = isComplete;
  }, [isComplete]);

  const isLiveAndRunning = isLive && !isComplete;

  // Duration label — only on live path once complete
  const durationLabel = (isLive && durationSeconds !== null)
    ? `${durationSeconds.toFixed(durationSeconds < 10 ? 1 : 0)}s`
    : null;

  return (
    <div className="ta-thinking-row">
      <button
        className="ta-thinking-header"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        type="button"
      >
        {/* Live spinner or complete glyph */}
        {isLiveAndRunning ? (
          <span className="ta-spinner" aria-hidden="true" />
        ) : (
          <span className="ta-thinking-glyph" aria-hidden="true">⬡</span>
        )}
        {/* Lora italic summary — shimmer class applied while live+running */}
        <span className={`ta-thinking-summary${isLiveAndRunning ? ' shimmer' : ''}`}>
          {summary || (isComplete ? 'reasoning' : 'thinking…')}
        </span>
        {/* "thought for Xs" — mono-uppercase dimmed, revealed on completion */}
        {durationLabel && (
          <span className="ta-thought-duration" aria-label={`thought for ${durationLabel}`}>
            {durationLabel}
          </span>
        )}
        <span className="ta-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="ta-thinking-body" role="region">
          <p className="ta-thinking-prose">{content || '…'}</p>
        </div>
      )}
    </div>
  );
});

// ─── Single tool row (memoized — only re-renders when output/elapsed changes) ─

interface ToolRowProps {
  toolId: string;
  toolName: string;
  input?: string;
  output?: string;
  isError?: boolean;
  isComplete: boolean;
  isLive: boolean;
  elapsed?: number;
}

const ToolRow = memo(function ToolRow({ toolName, input, output, isError, isComplete, isLive, elapsed }: ToolRowProps) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = !!output;

  // Status pip state: running → done → error
  const isRunning = isLive && !isComplete;
  const pipClass = isRunning
    ? 'ta-tool-pip running'
    : isError
      ? 'ta-tool-pip error'
      : 'ta-tool-pip done';

  return (
    <div className={`ta-tool-row${isError ? ' error' : ''}`}>
      <button
        className="ta-tool-header"
        onClick={() => canExpand && setExpanded(e => !e)}
        disabled={!canExpand}
        type="button"
        aria-expanded={canExpand ? expanded : undefined}
      >
        {/* Status pip — replaces the binary spinner/chevron logic with a
            3-state dot: pulsing amber (running), settled muted (done), warm-red (error) */}
        <span className={pipClass} aria-hidden="true" />
        {/* Expand chevron — only when there's output to show */}
        {canExpand && (
          <span className="ta-tool-chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        )}
        <span className="ta-tool-name">{toolName}</span>
        {input && <span className="ta-tool-input">{input}</span>}
        {/* elapsed in mono-uppercase voice — replaces the error-badge when not an error */}
        {elapsed !== undefined && !isError && (
          <span className="ta-tool-elapsed">{elapsed.toFixed(1)}s</span>
        )}
        {isError && <span className="ta-tool-error-badge">err</span>}
      </button>
      {expanded && output && (
        <pre className="ta-tool-output">{formatToolOutput(output)}</pre>
      )}
    </div>
  );
});

// ─── Timeline body (the expanded content) ────────────────────────────────────
// Rendered only when open. Does NOT animate height — uses opacity+translate
// so streaming doesn't force layout recalculation.

interface TimelineBodyProps {
  entries: TimelineEntry[];
  isLive: boolean;
}

const TimelineBody = memo(function TimelineBody({ entries, isLive }: TimelineBodyProps) {
  if (entries.length === 0) {
    return (
      <div className="ta-timeline-body ta-visible">
        <p className="ta-empty">waiting for reasoning…</p>
      </div>
    );
  }

  return (
    <div className="ta-timeline-body ta-visible">
      {entries.map((entry, i) => {
        if (entry.kind === 'thinking') {
          const e = entry as ThinkingEntry;
          return (
            <ThinkingRow
              key={e.id}
              id={e.id}
              content={e.content}
              summary={e.summary}
              isComplete={e.isComplete}
              isLive={isLive}
            />
          );
        } else {
          const e = entry as ToolEntry;
          return (
            <ToolRow
              key={`${e.toolId}-${i}`}
              toolId={e.toolId}
              toolName={e.toolName}
              input={e.input}
              output={e.output}
              isError={e.isError}
              isComplete={e.isComplete}
              isLive={isLive}
              elapsed={e.elapsed}
            />
          );
        }
      })}
    </div>
  );
});

// ─── Pill summary counts ──────────────────────────────────────────────────────

function pillLabel(entries: TimelineEntry[], isLive: boolean): string {
  const toolCount = entries.filter(e => e.kind === 'tool').length;
  const thinkCount = entries.filter(e => e.kind === 'thinking').length;

  if (entries.length === 0) return isLive ? 'thinking…' : 'thinking';

  const parts: string[] = [];
  if (thinkCount > 0) parts.push(isLive ? 'thinking' : 'reasoned');
  if (toolCount > 0) parts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''}`);
  return parts.join(' · ');
}

// ─── Main accordion (live streaming variant) ──────────────────────────────────

interface LiveThinkingAccordionProps {
  entries: TimelineEntry[];
}

export function LiveThinkingAccordion({ entries }: LiveThinkingAccordionProps) {
  // Track whether the user has manually toggled — if so, honour their choice.
  const userActedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggle = useCallback(() => {
    userActedRef.current = true;
    setOpen(o => !o);
  }, []);

  // Determine if any entry is still streaming (incomplete)
  const anyRunning = entries.some(e => !e.isComplete);
  // Whether all entries are now complete (stream just finished)
  const allComplete = entries.length > 0 && !anyRunning;

  // Auto-open while thinking is streaming; auto-collapse a beat after completion.
  // Respect user's manual override throughout.
  const prevAnyRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevAnyRunningRef.current;
    prevAnyRunningRef.current = anyRunning;

    if (entries.length === 0) return;

    if (anyRunning && !wasRunning && !userActedRef.current) {
      // Thinking just started — auto-open
      setOpen(true);
    }

    if (!anyRunning && wasRunning && !userActedRef.current) {
      // Thinking just completed — auto-collapse after a beat
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = setTimeout(() => {
        if (!userActedRef.current) {
          setOpen(false);
        }
      }, 800);
    }

    return () => {
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    };
  }, [anyRunning, allComplete, entries.length]);

  // Reset user-acted state when entries reset (new stream)
  const prevLengthRef = useRef(entries.length);
  useEffect(() => {
    if (entries.length === 0 && prevLengthRef.current > 0) {
      userActedRef.current = false;
    }
    prevLengthRef.current = entries.length;
  }, [entries.length]);

  if (entries.length === 0) return null;

  return (
    <div className="ta-accordion">
      <button
        className={`ta-pill${open ? ' open' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? 'Collapse thinking timeline' : 'Expand thinking timeline'}
        type="button"
      >
        <span className="ta-pill-glyph" aria-hidden="true">⬡</span>
        <span className="ta-pill-label">{pillLabel(entries, true)}</span>
        <span className="ta-pill-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && <TimelineBody entries={entries} isLive={true} />}
      {ACCORDION_STYLES}
    </div>
  );
}

// ─── Persisted variant (from metadata.segments) ────────────────────────────────
// Converts MessageSegment[] to TimelineEntry[] inline — no store involvement.

function segmentsToEntries(segments: MessageSegment[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let textOffset = 0;

  for (const seg of segments) {
    if (seg.type === 'thinking') {
      entries.push({
        kind: 'thinking',
        id: `seg-${entries.length}`,
        content: seg.content,
        summary: seg.summary,
        textOffset,
        isComplete: true,
      } as ThinkingEntry);
    } else if (seg.type === 'tool') {
      entries.push({
        kind: 'tool',
        toolId: seg.toolId,
        toolName: seg.toolName,
        input: seg.input,
        output: seg.output,
        isError: seg.isError,
        textOffset,
        isComplete: true,
      } as ToolEntry);
    } else if (seg.type === 'text') {
      textOffset += seg.content.length;
    }
  }

  return entries;
}

interface PersistedThinkingAccordionProps {
  /** Chronological segment array from message.metadata.segments */
  segments: MessageSegment[];
  /** When false (show_thinking OFF), thinking rows are hidden but tool rows remain */
  showThinking: boolean;
}

export const PersistedThinkingAccordion = memo(function PersistedThinkingAccordion({
  segments,
  showThinking,
}: PersistedThinkingAccordionProps) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(o => !o), []);

  const allEntries = segmentsToEntries(segments);
  // Gate: when showThinking is OFF, only show tool entries
  const visibleEntries = showThinking
    ? allEntries
    : allEntries.filter(e => e.kind === 'tool');

  if (visibleEntries.length === 0) return null;

  return (
    <div className="ta-accordion">
      <button
        className={`ta-pill${open ? ' open' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? 'Collapse thinking timeline' : 'Expand thinking timeline'}
        type="button"
      >
        <span className="ta-pill-glyph" aria-hidden="true">⬡</span>
        <span className="ta-pill-label">{pillLabel(visibleEntries, false)}</span>
        <span className="ta-pill-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && <TimelineBody entries={visibleEntries} isLive={false} />}
      {ACCORDION_STYLES}
    </div>
  );
});

// ─── Styles ───────────────────────────────────────────────────────────────────
// Scoped inside the accordion — injected once (React deduplicates identical
// <style> text nodes across all instances in the same render pass).

const ACCORDION_STYLES = (
  <style>{`
    /* ─── Accordion wrapper ─── */
    .ta-accordion {
      display: flex;
      flex-direction: column;
      margin: 0.25rem 0;
    }

    /* ─── Collapsed pill — the quiet ember ─── */
    .ta-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.3125rem;
      padding: 0.1875rem 0.625rem 0.1875rem 0.4375rem;
      border-radius: 99px;
      border: 1px solid rgba(201, 168, 124, 0.14);
      background: rgba(201, 168, 124, 0.04);
      cursor: pointer;
      align-self: flex-start;
      max-width: 100%;
      /* No layout-triggering transitions */
      transition:
        background 150ms var(--hearth-curve, cubic-bezier(0.16, 1, 0.3, 1)),
        border-color 150ms var(--hearth-curve, cubic-bezier(0.16, 1, 0.3, 1));
    }
    .ta-pill:hover {
      background: rgba(201, 168, 124, 0.08);
      border-color: rgba(201, 168, 124, 0.24);
    }
    .ta-pill:active {
      transform: scale(0.985) translateY(0.5px);
      transition: transform 100ms var(--hearth-curve, cubic-bezier(0.16, 1, 0.3, 1));
    }
    .ta-pill.open {
      background: rgba(201, 168, 124, 0.07);
      border-color: rgba(201, 168, 124, 0.22);
      border-radius: 0.625rem 0.625rem 0 0;
    }

    .ta-pill-glyph {
      font-size: 0.5625rem;
      color: var(--text-secondary, #a09689);
      line-height: 1;
      flex-shrink: 0;
    }
    .ta-pill-label {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 0.625rem;
      letter-spacing: 0.04em;
      color: var(--text-secondary, #a09689);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ta-pill-chevron {
      font-size: 0.5rem;
      color: var(--text-secondary, #a09689);
      flex-shrink: 0;
      margin-left: 0.0625rem;
    }

    /* ─── Timeline body — opacity reveal, NOT height animation ─── */
    /* Height animation during streaming causes layout thrash; we use
       opacity + translate instead. The content appears at its natural
       height without any collapsed-height calculation. */
    .ta-timeline-body {
      border: 1px solid rgba(201, 168, 124, 0.10);
      border-top: none;
      border-radius: 0 0 0.625rem 0.625rem;
      background: var(--surface-code);
      padding: 0.375rem 0.5rem;
      display: flex;
      flex-direction: column;
      gap: 0.0625rem;
    }
    /* Reveal — appear + lift */
    .ta-timeline-body.ta-visible {
      animation: taReveal 160ms var(--hearth-curve, cubic-bezier(0.16, 1, 0.3, 1)) both;
    }
    @keyframes taReveal {
      from { opacity: 0; transform: translateY(-0.25rem); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .ta-empty {
      font-family: var(--font-serif, 'Lora', serif);
      font-style: italic;
      font-size: 0.6875rem;
      color: var(--text-muted, #6a6258);
      padding: 0.25rem 0.25rem;
    }

    /* ─── Thinking row ─── */
    .ta-thinking-row {
      display: flex;
      flex-direction: column;
    }
    .ta-thinking-header {
      display: flex;
      align-items: center;
      gap: 0.3125rem;
      padding: 0.25rem 0.375rem;
      border-radius: 0.3125rem;
      background: transparent;
      border: none;
      cursor: pointer;
      text-align: left;
      width: 100%;
      transition: background 150ms var(--hearth-curve, cubic-bezier(0.16, 1, 0.3, 1));
    }
    .ta-thinking-header:hover {
      background: rgba(201, 168, 124, 0.05);
    }

    .ta-thinking-glyph {
      font-size: 0.5rem;
      color: var(--text-muted);
      flex-shrink: 0;
      line-height: 1;
    }
    /* Lora italic for thinking summary — editorial, not monospace */
    .ta-thinking-summary {
      flex: 1;
      font-family: var(--font-serif, 'Lora', serif);
      font-style: italic;
      font-size: 0.8125rem;
      color: var(--text-secondary, #a09689);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.45;
    }
    .ta-chevron {
      font-size: 0.5rem;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    /* Thinking prose body — Lora italic, muted */
    .ta-thinking-body {
      padding: 0.375rem 0.5rem 0.375rem 1rem;
      border-left: 1px solid rgba(201, 168, 124, 0.12);
      margin: 0.0625rem 0 0.0625rem 0.5rem;
    }
    .ta-thinking-prose {
      font-family: var(--font-serif, 'Lora', serif);
      font-style: italic;
      font-size: 0.8125rem;
      color: var(--text-primary, #e2dbd0);
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* ─── Tool row ─── */
    .ta-tool-row {
      display: flex;
      flex-direction: column;
    }
    .ta-tool-row.error .ta-tool-name {
      color: var(--status-error-text);
    }
    .ta-tool-header {
      display: flex;
      align-items: center;
      gap: 0.3125rem;
      padding: 0.25rem 0.375rem;
      border-radius: 0.3125rem;
      background: transparent;
      border: none;
      cursor: pointer;
      text-align: left;
      width: 100%;
      transition: background 150ms var(--hearth-curve, cubic-bezier(0.16, 1, 0.3, 1));
    }
    .ta-tool-header:hover:not(:disabled) {
      background: rgba(201, 168, 124, 0.05);
    }
    .ta-tool-header:disabled { cursor: default; }

    .ta-tool-chevron {
      width: 0.75rem;
      text-align: center;
      font-size: 0.5rem;
      flex-shrink: 0;
      color: var(--text-muted);
    }
    .ta-tool-name {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 0.6875rem;
      letter-spacing: 0.03em;
      color: var(--amber, #c9a87c);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .ta-tool-input {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 0.6875rem;
      color: var(--text-secondary, #a09689);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .ta-tool-error-badge {
      font-size: 0.5rem;
      color: var(--status-error-text);
      background: rgba(220, 140, 120, 0.10);
      padding: 0.0625rem 0.25rem;
      border-radius: 0.125rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      flex-shrink: 0;
    }
    .ta-tool-elapsed {
      font-size: 0.5rem;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      color: var(--text-muted, #6a6258);
      margin-left: auto;
      flex-shrink: 0;
    }

    .ta-tool-output {
      margin: 0.125rem 0 0.125rem 1rem;
      padding: 0.4375rem 0.5625rem;
      background: var(--surface-code);
      border-radius: 0.25rem;
      color: var(--text-secondary, #a09689);
      font-size: 0.6875rem;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      line-height: 1.5;
      max-height: 16rem;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* ─── Live spinners ─── */
    .ta-spinner {
      display: block;
      width: 0.5rem;
      height: 0.5rem;
      border: 1.5px solid rgba(201, 168, 124, 0.25);
      border-top-color: var(--amber, #c9a87c);
      border-radius: 50%;
      animation: taSpin 0.8s linear infinite;
      flex-shrink: 0;
    }
    @keyframes taSpin { to { transform: rotate(360deg); } }

    /* ─── Thinking shimmer — amber-tinted sweep while live+running ─── */
    /* A single slow sweep from transparent → amber-tinted → transparent.
       Kept intentionally faint — this is an ember glow, not a loading bar.
       The animation stops the instant .shimmer class is removed (isComplete). */
    .ta-thinking-summary.shimmer {
      background: linear-gradient(
        90deg,
        var(--text-secondary, #a09689) 0%,
        rgba(201, 168, 124, 0.85) 40%,
        rgba(201, 168, 124, 0.55) 55%,
        var(--text-secondary, #a09689) 100%
      );
      background-size: 200% 100%;
      background-clip: text;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      animation: taShimmer 2.4s ease-in-out infinite;
    }
    @keyframes taShimmer {
      0%   { background-position: 200% center; }
      100% { background-position: -200% center; }
    }

    /* ─── "thought for Xs" duration label ─── */
    /* Mono-uppercase, deeply dimmed — the same infrastructure voice as bubble timestamps.
       Sits between the summary and the chevron. */
    .ta-thought-duration {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--text-muted, #6a6258);
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
      margin-left: 0.125rem;
    }

    /* ─── Tool status pip ─── */
    /* A 5×5 dot replacing the binary spinner/chevron. Three states:
       running  = pulsing amber dot
       done     = settled, muted, no animation
       error    = warm-red, no animation */
    .ta-tool-pip {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      flex-shrink: 0;
      /* Aligned with the text baseline */
      margin-top: 0.0625rem;
    }
    .ta-tool-pip.running {
      background: var(--amber, #c9a87c);
      animation: taPipPulse 1.2s ease-in-out infinite;
    }
    .ta-tool-pip.done {
      background: rgba(201, 168, 124, 0.28);
    }
    .ta-tool-pip.error {
      background: rgba(220, 140, 120, 0.65);
    }
    @keyframes taPipPulse {
      0%, 100% { opacity: 0.9; transform: scale(1); }
      50%      { opacity: 0.35; transform: scale(0.7); }
    }
  `}</style>
);
