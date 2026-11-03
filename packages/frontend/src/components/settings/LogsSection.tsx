/**
 * LogsSection — live tail of the PM2 process logs + the house log.
 *
 * Reads GET /api/system/logs (auth-gated, read-only). Polls every ~2.5s while
 * "follow" is on, auto-scrolling to the tail when the user is already at the
 * bottom. Filter by text and by stream (stdout / stderr / both). This is the
 * Hermes-dashboard parity surface — the one log view we didn't have.
 *
 * The "house" source is the proprioception stream —
 * companion_actions rendered as a diary: TIME · [KIND] · summary, the kind
 * tinted amber via the existing [Tag] highlight. Filterable by the same text
 * box (e.g. typing 'watchtower' or 'touch').
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Eyebrow, Btn, Spinner, EmptyState } from './primitives';
import { HearthSelect } from '../hearth';

interface LogLine {
  ts: string | null;
  source: 'out' | 'err' | 'house';
  text: string;
}
interface LogsResponse {
  lines: LogLine[];
  truncated: boolean;
  present: { out: boolean; err: boolean };
}

type SourceFilter = 'all' | 'out' | 'err' | 'house';

const POLL_MS = 2500;
const LINE_OPTIONS = [250, 500, 1000, 2000];

// Split a leading "[Tag]" off a log message so we can tint it amber.
function splitTag(text: string): { tag: string | null; rest: string } {
  const m = /^(\[[^\]]+\])\s?(.*)$/.exec(text);
  return m ? { tag: m[1], rest: m[2] } : { tag: null, rest: text };
}

// PM2's "2026-06-30T12:34:56" → just the clock, the panel is always "today-ish".
// Timestamps carrying explicit timezone info (house entries are UTC ISO) get
// localized to the viewer's clock first — a diary in UTC reads an hour off.
function shortTs(ts: string | null): string {
  if (!ts) return '';
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(ts)) {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  }
  const m = /\d{2}:\d{2}:\d{2}/.exec(ts);
  return m ? m[0] : ts;
}

export function LogsSection({ base, initialQuery = '' }: { base: string; initialQuery?: string }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [present, setPresent] = useState<{ out: boolean; err: boolean }>({ out: true, err: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [source, setSource] = useState<SourceFilter>('all');
  const [query, setQuery] = useState(initialQuery);
  const [lineLimit, setLineLimit] = useState(500);
  const [follow, setFollow] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const fetchLogs = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const params = new URLSearchParams({ lines: String(lineLimit), source });
      if (query.trim()) params.set('q', query.trim());
      const res = await fetch(`${base}/api/system/logs?${params.toString()}`, {
        credentials: 'include',
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as LogsResponse;
      setLines(data.lines);
      setTruncated(data.truncated);
      setPresent(data.present);
      setError(null);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, [base, lineLimit, source, query]);

  // Refetch when filters change (light debounce so typing doesn't hammer the endpoint).
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => void fetchLogs(), 300);
    return () => clearTimeout(t);
  }, [fetchLogs]);

  // Follow-poll.
  useEffect(() => {
    if (!follow) return;
    const id = setInterval(() => void fetchLogs(), POLL_MS);
    return () => clearInterval(id);
  }, [follow, fetchLogs]);

  // Auto-scroll to tail after each update if the user was already at the bottom.
  useEffect(() => {
    if (atBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const jumpToTail = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
    }
  }, []);

  return (
    <div className="sp-group logs-section">
      <Eyebrow
        label={source === 'house' ? 'house log' : 'process logs'}
        sub={source === 'house' ? `what the hands did · ${lines.length} entries` : `pm2 · ${lines.length} lines`}
      />

      {/* Controls */}
      <div className="logs-controls">
        <div className="logs-seg" role="tablist" aria-label="Log stream">
          {(['all', 'out', 'err', 'house'] as SourceFilter[]).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={source === s}
              className={`logs-seg-btn${source === s ? ' active' : ''}`}
              onClick={() => setSource(s)}
            >
              {s === 'all' ? 'all' : s === 'out' ? 'stdout' : s === 'err' ? 'stderr' : 'house'}
            </button>
          ))}
        </div>

        <input
          type="text"
          className="sp-form-input mono logs-filter"
          placeholder="filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter logs"
        />

        <div className="logs-lines">
          <HearthSelect
            value={String(lineLimit)}
            onChange={(v) => setLineLimit(Number(v))}
            options={LINE_OPTIONS.map((n) => ({ value: String(n), label: `${n} lines` }))}
            ariaLabel="Line count"
            mono
          />
        </div>

        <button
          className={`logs-follow${follow ? ' on' : ''}`}
          onClick={() => setFollow((f) => !f)}
          aria-pressed={follow}
          title={follow ? 'Following — auto-refresh on' : 'Paused'}
        >
          <span className="logs-follow-pip" aria-hidden="true" />
          {follow ? 'following' : 'paused'}
        </button>

        <Btn variant="ghost" small onClick={() => void fetchLogs()}>refresh</Btn>
      </div>

      {/* Stream availability note */}
      {(!present.out || !present.err) && (
        <div className="logs-note">
          {!present.out && 'stdout log not found. '}
          {!present.err && 'stderr log not found. '}
          (Logs appear once the app has run under PM2.)
        </div>
      )}

      {/* Log panel */}
      <div className="logs-panel" ref={scrollRef} onScroll={handleScroll}>
        {loading && lines.length === 0 ? (
          <div className="logs-loading"><Spinner /></div>
        ) : error ? (
          <div className="logs-error">Couldn’t read logs — {error}</div>
        ) : lines.length === 0 ? (
          <EmptyState message={query.trim() ? 'No lines match this filter.' : 'No log lines yet.'} />
        ) : (
          <>
            {truncated && <div className="logs-truncated">— older lines truncated —</div>}
            {lines.map((l, i) => {
              const { tag, rest } = splitTag(l.text);
              return (
                <div key={i} className={`logs-line${l.source === 'err' ? ' err' : ''}`}>
                  <span className="logs-ts">{shortTs(l.ts)}</span>
                  <span className="logs-text">
                    {tag && <span className="logs-tag">{tag}</span>}
                    {tag ? ' ' : ''}{rest}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Jump-to-tail when scrolled up */}
      <div className="logs-footer">
        <Btn variant="ghost" small onClick={jumpToTail}>jump to latest ↓</Btn>
      </div>

      <style>{`
        .logs-controls {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 0.5rem;
          margin: 0.75rem 0;
        }
        .logs-seg {
          display: inline-flex;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 0.5rem;
          padding: 0.125rem;
          gap: 0.125rem;
        }
        .logs-seg-btn {
          font-family: var(--font-mono, monospace);
          font-size: 0.6875rem;
          letter-spacing: 0.04em;
          color: var(--text-muted, #6a6258);
          padding: 0.25rem 0.5rem;
          border-radius: 0.375rem;
          transition: color 150ms var(--hearth-curve, ease), background 150ms var(--hearth-curve, ease);
        }
        .logs-seg-btn.active {
          color: var(--amber-bright, #e3c49a);
          background: rgba(201,168,124,0.14);
        }
        .logs-filter { flex: 1; min-width: 7rem; }
        .logs-lines { width: auto; flex-shrink: 0; }

        .logs-follow {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          font-family: var(--font-mono, monospace);
          font-size: 0.6875rem;
          letter-spacing: 0.04em;
          color: var(--text-muted, #6a6258);
          padding: 0.35rem 0.6rem;
          border-radius: 0.5rem;
          border: 1px solid rgba(255,255,255,0.08);
          transition: color 150ms var(--hearth-curve, ease), border-color 150ms var(--hearth-curve, ease);
        }
        .logs-follow.on { color: var(--amber-bright, #e3c49a); border-color: rgba(201,168,124,0.28); }
        .logs-follow-pip {
          width: 0.375rem; height: 0.375rem; border-radius: 50%;
          background: var(--text-muted, #6a6258);
        }
        .logs-follow.on .logs-follow-pip {
          background: var(--status-active, #6dba88);
          box-shadow: 0 0 6px rgba(109,186,136,0.6);
          animation: presencePulse 2s var(--hearth-curve, ease) infinite;
        }

        .logs-note {
          font-size: 0.6875rem;
          color: #d4a843;
          font-style: italic;
          margin-bottom: 0.5rem;
        }

        .logs-panel {
          background: #0a0908;
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: var(--radius-settings, 0.625rem);
          padding: 0.625rem 0.75rem;
          height: 26rem;
          overflow: auto;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          line-height: 1.5;
        }
        .logs-loading { display: flex; justify-content: center; padding: 2rem 0; }
        .logs-error { color: var(--status-error-text); padding: 1rem 0; }
        .logs-truncated, .logs-note {
          text-align: center;
        }
        .logs-truncated {
          color: var(--text-muted, #6a6258);
          font-size: 0.625rem;
          letter-spacing: 0.06em;
          padding: 0.25rem 0 0.5rem;
        }

        .logs-line {
          display: flex;
          gap: 0.625rem;
          padding: 0.0625rem 0;
          white-space: pre-wrap;
          word-break: break-word;
          border-left: 2px solid transparent;
          padding-left: 0.4rem;
          margin-left: -0.4rem;
        }
        .logs-line.err {
          border-left-color: rgba(210,100,90,0.55);
          background: rgba(210,100,90,0.04);
        }
        .logs-ts {
          color: var(--text-muted, #6a6258);
          flex-shrink: 0;
          opacity: 0.7;
          user-select: none;
        }
        .logs-text { color: var(--text-secondary, #a09689); min-width: 0; }
        .logs-line.err .logs-text { color: rgba(214,168,160,0.92); }
        .logs-tag { color: var(--amber, #c9a87c); }

        .logs-footer {
          display: flex;
          justify-content: flex-end;
          margin-top: 0.5rem;
        }

        @media (min-width: 769px) {
          .settings-view .logs-seg-btn, .settings-view .logs-follow, .settings-view .logs-note { font-size: 14px; }
          .settings-view .logs-panel { font-size: 14px; }
          .settings-view .logs-truncated { font-size: 12px; }
        }

        @media (max-width: 600px) {
          .logs-panel { height: 20rem; font-size: 0.6875rem; }
          .logs-filter { min-width: 5rem; }
        }
      `}</style>
    </div>
  );
}
