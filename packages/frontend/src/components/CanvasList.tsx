/**
 * NotesHome — the Notes page's front: a header open onto the room (the page's name, how many notes and when one was
 * last touched, a search, + New note), then every note as a card with its title, its first lines and when it was
 * edited. Opening a card hands its id up; CanvasView then shows that note's editor across the page.
 * Stateless of the API: CanvasView owns the list, the creation and the open note.
 */
import React, { useMemo, useState } from 'react';
import { HearthSelect } from './hearth';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ContentType = 'markdown' | 'code' | 'text' | 'html';

export interface CanvasMeta {
  id: string;
  title: string;
  content_type?: ContentType;
  updated_at: string;
  /** The list endpoint sends each note whole; the cards show its first lines. */
  content?: string;
}

export interface NotesHomeProps {
  notes: CanvasMeta[];
  loaded: boolean;
  onOpen: (id: string) => void;
  onCreate: (title: string, contentType: ContentType, language?: string) => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const TYPE_LABEL: Record<ContentType, string> = { markdown: 'Note', text: 'Text', code: 'Code', html: 'Page' };

/** A note's opening words as plain text: no markup, no repeat of its own title, at most a few lines' worth. */
export function noteExcerpt(note: CanvasMeta, max = 220): string {
  const raw = note.content ?? '';
  const type = note.content_type ?? 'markdown';
  if (type === 'code') return raw.split('\n').slice(0, 5).join('\n');
  let text = type === 'html' ? raw.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ') : raw;
  if (type === 'markdown') {
    text = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .split('\n')
      .map(l => l.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, ''))
      .filter((l, i) => !(i === 0 && l.trim().toLowerCase() === note.title.trim().toLowerCase()))
      .join('\n')
      .replace(/[*_`~]+/g, '');
  }
  text = text.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text;
}

// ─── NotesHome ─────────────────────────────────────────────────────────────────

export function NotesHome({ notes, loaded, onOpen, onCreate }: NotesHomeProps) {
  const [query, setQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newType, setNewType] = useState<ContentType>('markdown');
  const [newLang, setNewLang] = useState('');

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? notes.filter(n => n.title.toLowerCase().includes(q) || (n.content ?? '').toLowerCase().includes(q)) : notes),
    [notes, q],
  );
  const latest = notes[0];

  function handleCreate() {
    const title = newTitle.trim() || 'Untitled';
    const lang = newType === 'code' ? newLang.trim() || undefined : undefined;
    onCreate(title, newType, lang);
    setNewTitle('');
    setNewType('markdown');
    setNewLang('');
    setShowForm(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); handleCreate(); }
    if (e.key === 'Escape') setShowForm(false);
  }

  return (
    <div className="nt-root">
      <header className="nt-head">
        <div className="nt-head-text">
          <h1 className="nt-title">Notes</h1>
          <p className="nt-sub">
            {notes.length === 0 ? 'Nothing written yet' : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`}
            {latest && ` · last edited ${formatTime(latest.updated_at)}`}
          </p>
        </div>
        <div className="nt-tools">
          <label className="nt-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search notes" aria-label="Search notes" />
          </label>
          <button className="nt-new hearth-press" type="button" aria-expanded={showForm} onClick={() => setShowForm(s => !s)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New note
          </button>
        </div>
      </header>

      {showForm && (
        <div className="nt-card nt-create" role="group" aria-label="New note">
          <input
            className="nt-input"
            type="text"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Title"
            aria-label="New note title"
            autoFocus
          />
          <div className="nt-create-row">
            <div className="nt-select">
              <HearthSelect
                block
                value={newType}
                onChange={v => setNewType(v as ContentType)}
                options={[
                  { value: 'markdown', label: 'Note' },
                  { value: 'text', label: 'Plain text' },
                  { value: 'code', label: 'Code' },
                  { value: 'html', label: 'Page (HTML)' },
                ]}
                ariaLabel="New note kind"
              />
            </div>
            {newType === 'code' && (
              <input className="nt-input nt-input-sm" type="text" value={newLang} onChange={e => setNewLang(e.target.value)} placeholder="Language" aria-label="Language" />
            )}
            <button className="nt-btn nt-btn-primary hearth-press" type="button" onClick={handleCreate}>Create</button>
            <button className="nt-btn hearth-press" type="button" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {!loaded ? (
        <p className="nt-quiet">…</p>
      ) : notes.length === 0 ? (
        <p className="nt-quiet">No notes yet. Start one with New note, or ask in chat and the companion will keep it here.</p>
      ) : shown.length === 0 ? (
        <p className="nt-quiet">No note matches “{query.trim()}”.</p>
      ) : (
        <ul className="nt-grid">
          {shown.map(n => {
            const type = n.content_type ?? 'markdown';
            const excerpt = noteExcerpt(n);
            return (
              <li key={n.id}>
                <button type="button" className="nt-card nt-card-open hearth-press" onClick={() => onOpen(n.id)}>
                  <span className="nt-card-title">{n.title || 'Untitled'}</span>
                  {excerpt
                    ? type === 'code' ? <pre className="nt-card-code">{excerpt}</pre> : <span className="nt-card-excerpt">{excerpt}</span>
                    : <span className="nt-card-excerpt nt-card-empty">Empty</span>}
                  <span className="nt-card-foot">
                    <span className="nt-card-type">{TYPE_LABEL[type]}</span>
                    <span className="nt-card-time">{formatTime(n.updated_at)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <style>{`
        .nt-root {
          height: 100%;
          overflow-y: auto;
          padding: 0 1.25rem calc(env(safe-area-inset-bottom, 0px) + 3rem);
          display: flex;
          flex-direction: column;
          gap: 1rem;
          min-width: 0;
        }
        /* ── header: open onto the room, as Home's welcome and the Command center's day ── */
        .nt-head {
          position: relative;
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 1rem 1.5rem;
          padding: 1.5rem clamp(0.5rem, 3vw, 2.5rem) 0.5rem;
          isolation: isolate;
        }
        .nt-head::before {
          content: '';
          position: absolute;
          inset: 0;
          z-index: -1;
          pointer-events: none;
          background: radial-gradient(ellipse 40% 80% at 18% 55%,
            color-mix(in srgb, var(--surface-chrome, #2c1a10) 60%, transparent) 0%,
            color-mix(in srgb, var(--surface-chrome, #2c1a10) 30%, transparent) 50%,
            transparent 75%);
        }
        .nt-title {
          font: 600 clamp(2.2rem, 3.6vw, 3.1rem)/1.05 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
          color: var(--home-head-text, #f6eedb);
          text-shadow: 0 2px 18px rgba(0, 0, 0, 0.85), 0 1px 3px rgba(0, 0, 0, 0.7);
        }
        .nt-sub {
          margin-top: 0.3rem;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 1rem;
          color: var(--home-head-text, #f6eedb);
          text-shadow: 0 1px 10px rgba(0, 0, 0, 0.9);
        }
        .nt-tools { display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
        .nt-search {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          width: 20rem;
          max-width: 100%;
          min-width: 0;
          padding: 0.5rem 0.9rem;
          border-radius: 999px;
          background: var(--settings-field-bg, var(--surface-chrome-deep, #1a120c));
          border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 55%, transparent);
          color: var(--settings-field-text, var(--surface-chrome-text, #efe4d0));
        }
        .nt-search svg { flex-shrink: 0; color: var(--skin-trim, currentColor); }
        .nt-search input {
          flex: 1;
          min-width: 0;
          background: none;
          border: 0;
          outline: none;
          color: inherit;
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.95rem;
        }
        .nt-search input::placeholder { color: var(--settings-field-placeholder, var(--surface-chrome-muted, #cbbfa9)); }
        .nt-search:focus-within { outline: 2px solid var(--focus-ring-chrome, var(--focus-ring, #e9c688)); outline-offset: 2px; }
        .nt-new {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          flex-shrink: 0;
          white-space: nowrap;
          padding: 0.5rem 1.1rem;
          border-radius: 999px;
          background: var(--chip-bg, var(--surface-chrome, #2c1a10));
          border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 70%, transparent);
          color: var(--menu-ink, var(--surface-chrome-text, #efe4d0));
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.95rem;
          cursor: pointer;
        }
        .nt-new svg { color: var(--skin-trim, currentColor); }

        /* ── the new-note form, a plate of its own ── */
        .nt-create { display: flex; flex-direction: column; gap: 0.6rem; padding: 1rem 1.1rem; max-width: 40rem; }
        .nt-create-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
        .nt-select { min-width: 10rem; }
        .nt-input {
          padding: 0.5rem 0.75rem;
          border-radius: 6px;
          background: var(--settings-field-bg, var(--surface-chrome-deep, #1a120c));
          border: 1px solid var(--settings-field-border, var(--control-border, #8a7c66));
          color: var(--settings-field-text, var(--surface-chrome-text, #efe4d0));
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 1rem;
        }
        .nt-input::placeholder { color: var(--settings-field-placeholder, var(--surface-chrome-muted, #cbbfa9)); }
        .nt-input-sm { width: 9rem; font-size: 0.9rem; }
        .nt-btn {
          padding: 0.45rem 1rem;
          border-radius: 6px;
          background: transparent;
          border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 55%, transparent);
          color: var(--text-primary, #efe4d0);
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.92rem;
          cursor: pointer;
        }
        .nt-btn-primary { border-color: var(--skin-trim, #c9a87c); font-weight: 600; }

        /* ── the notes: cards on the route's plate, title, first lines, kind and time ── */
        .nt-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(16.5rem, 1fr)); gap: 1rem; }
        .nt-card {
          border-radius: 6px;
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          background: rgba(255, 255, 255, 0.02);
          color: var(--text-primary, #efe4d0);
          min-width: 0;
        }
        .nt-card-open {
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
          width: 100%;
          height: 100%;
          min-height: 11rem;
          padding: 1.1rem 1.2rem 0.95rem;
          text-align: left;
          cursor: pointer;
          font: inherit;
        }
        .nt-card-open:hover .nt-card-title { text-decoration: underline; text-decoration-color: var(--skin-trim, currentColor); text-underline-offset: 3px; }
        .nt-card-title {
          font: 600 1.3rem/1.2 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
          color: var(--text-primary, #efe4d0);
          overflow-wrap: anywhere;
        }
        .nt-card-excerpt {
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.92rem;
          line-height: 1.5;
          color: var(--text-secondary, #dccfb8);
          display: -webkit-box;
          -webkit-line-clamp: 4;
          -webkit-box-orient: vertical;
          overflow: hidden;
          overflow-wrap: anywhere;
        }
        .nt-card-empty { font-style: italic; color: var(--text-muted, #a09689); }
        .nt-card-code {
          margin: 0;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.78rem;
          line-height: 1.5;
          color: var(--text-secondary, #dccfb8);
          white-space: pre;
          overflow: hidden;
        }
        .nt-card-foot {
          margin-top: auto;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          padding-top: 0.55rem;
          border-top: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255,255,255,0.3)) 25%, transparent);
        }
        .nt-card-type {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.68rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-muted, #a09689);
        }
        .nt-card-time { font-family: var(--font-serif, 'Lora', serif); font-size: 0.85rem; color: var(--text-muted, #a09689); }
        .nt-quiet {
          padding: 0 clamp(0.5rem, 3vw, 2.5rem);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          color: var(--home-head-text, #f6eedb);
          text-shadow: 0 1px 10px rgba(0, 0, 0, 0.9);
        }

        @media (max-width: 768px) {
          .nt-root { padding: 0 0.6rem calc(env(safe-area-inset-bottom, 0px) + 3rem); gap: 0.8rem; }
          .nt-head { padding: 1rem 0.25rem 0.25rem; align-items: stretch; }
          .nt-title { font-size: 2.1rem; }
          .nt-tools { width: 100%; }
          .nt-search { flex: 1; width: auto; }
          .nt-new { padding: 0.5rem 0.85rem; }
          .nt-grid { grid-template-columns: 1fr; gap: 0.7rem; }
          .nt-card-open { min-height: 0; }
        }
      `}</style>
    </div>
  );
}
