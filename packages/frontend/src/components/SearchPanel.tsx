import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useChatStore } from '../store/chat';

// ─── Base URL (matches SettingsView) ──────────────────────────────────────────
import { BASE } from '../lib/base';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  messageId: string;
  threadId: string;
  threadName: string;
  role: string;
  content: string;
  highlight: string;
  createdAt: string;
}

interface Props {
  onClose: () => void;
  onSelectThread: (threadId: string, messageId?: string) => void;
}

// ─── Highlight matched terms in amber ─────────────────────────────────────────
function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <span>{text}</span>;

  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const lowerQ = query.toLowerCase();
  let last = 0;
  let idx = lower.indexOf(lowerQ);

  while (idx !== -1) {
    if (idx > last) parts.push(<span key={`t-${last}`}>{text.slice(last, idx)}</span>);
    parts.push(
      <mark key={`m-${idx}`} className="search-highlight">
        {text.slice(idx, idx + query.length)}
      </mark>
    );
    last = idx + query.length;
    idx = lower.indexOf(lowerQ, last);
  }
  if (last < text.length) parts.push(<span key={`t-end`}>{text.slice(last)}</span>);
  return <>{parts}</>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const day = 86400000;
  if (diff < day) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (diff < 7 * day) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ─── SearchPanel ───────────────────────────────────────────────────────────────

export function SearchPanel({ onClose, onSelectThread }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus the input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keyboard: Esc closes
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: q.trim(), limit: '30' });
      const res = await fetch(`${BASE}/api/search?${params}`);
      if (!res.ok) throw new Error(`Search ${res.status}`);
      const data = await res.json() as { results: SearchResult[]; total: number };
      setResults(data.results ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      console.warn('[SearchPanel] Search failed:', err);
      setError('Search failed. Try again.');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 250);
  }, [doSearch]);

  function handleResultClick(result: SearchResult) {
    onSelectThread(result.threadId, result.messageId);
    // Attempt to scroll the message into view after a short delay
    setTimeout(() => {
      const el = document.getElementById(`msg-${result.messageId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('msg-highlight-flash');
        setTimeout(() => el.classList.remove('msg-highlight-flash'), 1600);
      }
    }, 180);
  }

  return (
    <div className="search-panel-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-panel" role="dialog" aria-label="Search messages" aria-modal="true">
        {/* Search input */}
        <div className="search-input-row">
          <span className="search-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="search messages…"
            value={query}
            onChange={handleInput}
            autoComplete="off"
            spellCheck={false}
          />
          {loading && <span className="search-spinner" aria-hidden="true" />}
          <button className="search-close" onClick={onClose} aria-label="Close search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Results */}
        <div className="search-results" role="list">
          {!query.trim() && (
            <div className="search-empty">
              <span className="search-empty-text">type to search all messages</span>
            </div>
          )}

          {query.trim() && !loading && results.length === 0 && !error && (
            <div className="search-empty">
              <span className="search-empty-text">no results for "{query}"</span>
            </div>
          )}

          {error && (
            <div className="search-error">{error}</div>
          )}

          {results.map(result => (
            <button
              key={result.messageId}
              className="search-result"
              role="listitem"
              onClick={() => handleResultClick(result)}
            >
              <div className="search-result-header">
                <span className={`search-result-role ${result.role}`}>
                  {result.role === 'companion' ? 'Companion' : 'you'}
                </span>
                <span className="search-result-thread">{result.threadName}</span>
                <span className="search-result-time">{formatDate(result.createdAt)}</span>
              </div>
              <div className="search-result-snippet">
                <HighlightedSnippet text={result.highlight} query={query} />
              </div>
            </button>
          ))}

          {total > results.length && (
            <div className="search-more">
              +{total - results.length} more — refine your query
            </div>
          )}
        </div>
      </div>

      <style>{`
        /* Backdrop — dims message area, click-outside closes */
        .search-panel-backdrop {
          position: absolute;
          inset: 0;
          z-index: 200;
          background: rgba(12, 11, 9, 0.55);
          backdrop-filter: blur(3px);
          display: flex;
          flex-direction: column;
          align-items: stretch;
          justify-content: flex-start;
        }

        /* Panel — floats at top of the message area */
        .search-panel {
          background: var(--surface-popover, #faf4e5);
          color: var(--surface-popover-text, #2c231f);
          border: 1px solid var(--surface-popover-border, rgba(201, 168, 124, 0.12));
          border-top: none;
          border-radius: 0 0 1rem 1rem;
          box-shadow: 0 12px 40px -8px rgba(0, 0, 0, 0.6);
          max-height: 65vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        /* Input row */
        .search-input-row {
          display: flex;
          align-items: center;
          gap: 0.625rem;
          padding: 0.875rem 1rem;
          border-bottom: 1px solid rgba(201, 168, 124, 0.08);
          flex-shrink: 0;
        }

        .search-icon {
          color: var(--amber-dim, #a08960);
          flex-shrink: 0;
        }

        .search-input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: var(--text-primary, #e2dbd0);
          font-size: 0.9375rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-weight: 400;
        }
        .search-input::placeholder {
          color: var(--text-muted, #6a6258);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
        }

        .search-spinner {
          display: block;
          width: 0.75rem;
          height: 0.75rem;
          border: 1.5px solid rgba(201, 168, 124, 0.2);
          border-top-color: var(--amber, #c9a87c);
          border-radius: 50%;
          animation: spSearch 0.7s linear infinite;
          flex-shrink: 0;
        }
        @keyframes spSearch { to { transform: rotate(360deg); } }

        .search-close {
          display: grid;
          place-items: center;
          width: 1.5rem;
          height: 1.5rem;
          color: var(--text-muted, #6a6258);
          border-radius: 50%;
          flex-shrink: 0;
          transition: color var(--tx-fast, 240ms ease), background var(--tx-fast, 240ms ease);
        }
        .search-close:hover {
          color: var(--text-primary, #e2dbd0);
          background: var(--bg-hover, rgba(255, 255, 255, 0.06));
        }

        /* Results list */
        .search-results {
          flex: 1;
          overflow-y: auto;
          padding: 0.375rem 0;
          scrollbar-width: thin;
          scrollbar-color: rgba(201, 168, 124, 0.15) transparent;
        }

        .search-empty {
          padding: 1.5rem 1.25rem;
          display: flex;
          justify-content: center;
        }
        .search-empty-text {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.875rem;
          color: var(--text-muted, #6a6258);
        }

        .search-error {
          padding: 1rem 1.25rem;
          font-size: 0.8125rem;
          color: var(--status-error-text);
          font-family: var(--font-body);
        }

        /* Individual result */
        .search-result {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          width: 100%;
          padding: 0.625rem 1.25rem;
          text-align: left;
          border: none;
          background: transparent;
          cursor: pointer;
          border-radius: 0;
          transition: background var(--tx-fast, 240ms ease);
          position: relative;
        }
        .search-result:hover {
          background: rgba(201, 168, 124, 0.06);
        }
        .search-result:active {
          background: rgba(201, 168, 124, 0.10);
        }
        /* Thin amber left rule on hover */
        .search-result::before {
          content: '';
          position: absolute;
          left: 0; top: 0; bottom: 0;
          width: 2px;
          background: var(--amber, #c9a87c);
          opacity: 0;
          transition: opacity var(--tx-fast, 240ms ease);
        }
        .search-result:hover::before { opacity: 0.6; }

        .search-result-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        /* Role name — Lora italic, colored to identity */
        .search-result-role {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.75rem;
          font-weight: 500;
          flex-shrink: 0;
        }
        .search-result-role.companion { color: var(--amber, #c9a87c); }
        .search-result-role.user { color: var(--lavender, #a893c0); }

        .search-result-thread {
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          font-family: var(--font-body);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          min-width: 0;
        }

        .search-result-time {
          font-family: var(--font-mono, monospace);
          font-size: 0.5625rem;
          color: var(--text-muted, #6a6258);
          flex-shrink: 0;
          letter-spacing: 0.03em;
        }

        .search-result-snippet {
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
          line-height: 1.5;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }

        /* Amber highlight on matched term */
        .search-highlight {
          background: rgba(201, 168, 124, 0.22);
          color: var(--amber-bright, #e3c49a);
          border-radius: 2px;
          padding: 0 1px;
        }

        .search-more {
          padding: 0.625rem 1.25rem;
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          font-family: var(--font-serif);
          font-style: italic;
          text-align: center;
        }

        /* Flash animation for scrolled-to message */
        .msg-highlight-flash {
          animation: msgFlash 1.6s ease-out forwards;
        }
        @keyframes msgFlash {
          0%   { background: rgba(201, 168, 124, 0.18); }
          100% { background: transparent; }
        }
      `}</style>
    </div>
  );
}
