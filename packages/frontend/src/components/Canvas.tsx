/**
 * Canvas — two-pane CanvasView: list (left) + editor (right).
 *
 * CanvasView  — top-level export; drop into a route.
 * CanvasEditor — internal; editor/preview pane for a single canvas.
 *
 * Backend contract (built in parallel):
 *   GET    /api/canvas          → CanvasMeta[]
 *   GET    /api/canvas/:id      → CanvasFull
 *   POST   /api/canvas          body {title, content, content_type, language?}
 *   PUT    /api/canvas/:id      body {title?, content?}
 *   DELETE /api/canvas/:id
 */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { renderMarkdown } from '../utils/markdown';
import { NotesHome } from './CanvasList';
import type { CanvasMeta, ContentType } from './CanvasList';
import { useConfirm } from './ConfirmDialog';

// ─── Base URL (matches SettingsView pattern) ───────────────────────────────────

import { BASE } from '../lib/base';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CanvasFull extends CanvasMeta {
  content: string;
  language?: string;
  /** Server write counter; sent back with each save so a stale save is refused (409). */
  version?: number;
}

// ─── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ─── SVGs ──────────────────────────────────────────────────────────────────────

function IconEye() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  );
}

// ─── CanvasEditor ──────────────────────────────────────────────────────────────

interface CanvasEditorProps {
  canvas: CanvasFull;
  onSaved: (updated: Partial<CanvasMeta> & { id: string }) => void;
  /** A save was refused because the canvas changed elsewhere; `fresh` is the server's copy. */
  onConflict: (fresh: CanvasFull) => void;
  onDeleted: (id: string) => void;
}

function CanvasEditor({ canvas, onSaved, onConflict, onDeleted }: CanvasEditorProps) {
  const confirm = useConfirm();
  const [localTitle, setLocalTitle] = useState(canvas.title);
  const [localContent, setLocalContent] = useState(canvas.content);
  const [isDirty, setIsDirty] = useState(false);
  const [editMode, setEditMode] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The version this editor last saw. Rides with every content save so the
  // server can refuse a write over something newer.
  const versionRef = useRef<number>(canvas.version ?? 0);
  useEffect(() => { versionRef.current = canvas.version ?? 0; }, [canvas.id, canvas.version]);

  // When canvas id changes, sync from fresh fetch result
  useEffect(() => {
    setLocalTitle(canvas.title);
    setLocalContent(canvas.content);
    setIsDirty(false);
    setEditMode(true);
  }, [canvas.id]);

  // If parent refreshes the canvas record (not an id switch), pull non-dirty fields
  useEffect(() => {
    if (!isDirty) {
      setLocalTitle(canvas.title);
      setLocalContent(canvas.content);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas.title, canvas.content]);

  const flushSave = useCallback(async (content: string) => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/canvases/${canvas.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, version: versionRef.current }),
      });
      if (res.status === 409) {
        // Someone else (another tab, or the companion mid-turn) wrote first.
        // Take the server's copy rather than overwrite it; say so.
        const data = await res.json().catch(() => null) as { canvas?: CanvasFull } | null;
        const fresh = data?.canvas ?? (await apiFetch<{ canvas: CanvasFull }>(`/api/canvases/${canvas.id}`)).canvas;
        versionRef.current = fresh.version ?? 0;
        setLocalContent(fresh.content);
        setLocalTitle(fresh.title);
        setIsDirty(false);
        setConflictNote('Changed elsewhere — showing the latest version');
        setTimeout(() => setConflictNote(null), 4000);
        onConflict(fresh);
        return;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json().catch(() => null) as { version?: number } | null;
      if (typeof data?.version === 'number') versionRef.current = data.version;
      setIsDirty(false);
      onSaved({ id: canvas.id });
    } catch {
      // Non-fatal — dirty flag stays, user retries on next keystroke
    } finally {
      setSaving(false);
    }
  }, [canvas.id, onSaved, onConflict]);

  function handleContentChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setLocalContent(value);
    setIsDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      flushSave(value);
    }, 500);
  }

  async function handleTitleBlur() {
    const trimmed = localTitle.trim() || 'Untitled';
    if (trimmed === canvas.title) return;
    try {
      await apiFetch(`/api/canvases/${canvas.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: trimmed }),
      });
      onSaved({ id: canvas.id, title: trimmed });
    } catch { /* ignore */ }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') e.currentTarget.blur();
  }

  function handleToggleMode() {
    // Flush pending save before entering preview
    if (editMode && saveTimer.current) {
      clearTimeout(saveTimer.current);
      flushSave(localContent);
    }
    setEditMode(m => !m);
  }

  async function handleDelete() {
    const ok = await confirm({
      title: `Delete "${canvas.title}"?`,
      body: 'This canvas will be permanently removed.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/canvases/${canvas.id}`, { method: 'DELETE' });
      onDeleted(canvas.id);
    } catch { /* ignore */ }
  }

  const isMarkupType = canvas.content_type === 'markdown' || canvas.content_type === 'html';
  const isMono = canvas.content_type === 'code' || canvas.content_type === 'html';

  const badgeLabel =
    canvas.content_type === 'code'
      ? canvas.language ?? 'code'
      : canvas.content_type ?? 'markdown';

  const placeholder =
    canvas.content_type === 'code'
      ? 'Write code...'
      : canvas.content_type === 'html'
      ? 'Write HTML...'
      : 'Start writing...';

  return (
    <div className="cve-root">
      {/* Header */}
      <header className="cve-header">
        <div className="cve-header-left">
          <input
            className="cve-title"
            type="text"
            value={localTitle}
            onChange={e => setLocalTitle(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            placeholder="Untitled"
            aria-label="Canvas title"
          />
          <span className="cve-badge">{badgeLabel}</span>
        </div>
        <div className="cve-actions">
          {isMarkupType && (
            <button
              className="cve-btn"
              onClick={handleToggleMode}
              title={editMode ? 'Preview' : 'Edit'}
              aria-label={editMode ? 'Switch to preview' : 'Switch to edit'}
            >
              {editMode ? <IconEye /> : <IconEdit />}
            </button>
          )}
          <button
            className="cve-btn cve-btn--danger"
            onClick={handleDelete}
            title="Delete canvas"
            aria-label="Delete canvas"
          >
            <IconTrash />
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="cve-body">
        {isMarkupType && !editMode ? (
          <div className="cve-preview">
            {canvas.content_type === 'html' ? (
              <iframe
                className="cve-iframe"
                srcDoc={localContent}
                sandbox="allow-same-origin"
                title={canvas.title}
              />
            ) : (
              <div
                className="cve-markdown"
                // renderMarkdown sanitizes via DOMPurify
                dangerouslySetInnerHTML={{ __html: renderMarkdown(localContent) }}
              />
            )}
          </div>
        ) : (
          <textarea
            className={`cve-editor${isMono ? ' cve-editor--mono' : ''}`}
            value={localContent}
            onChange={handleContentChange}
            placeholder={placeholder}
            spellCheck={!isMono}
            aria-label="Canvas content"
          />
        )}
      </div>

      {/* Save indicator */}
      {(isDirty || saving || conflictNote) && (
        <div className="cve-save-indicator" aria-live="polite">
          {conflictNote ?? (saving ? 'Saving…' : 'Unsaved')}
        </div>
      )}

      <style>{`
        /* ── CanvasEditor shell ── */
        .cve-root {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          height: 100%;
          position: relative;
          background: transparent;
        }

        /* ── Header ── */
        .cve-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          padding: 0.875rem 1.125rem 0.8125rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          flex-shrink: 0;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent);
          backdrop-filter: blur(12px);
        }

        .cve-header-left {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex: 1;
          min-width: 0;
        }

        /* ── Title input ── */
        .cve-title {
          background: transparent;
          border: none;
          border-bottom: 1px solid transparent;
          color: var(--text-primary, #e2dbd0);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-weight: 500;
          font-size: 1.0625rem;
          letter-spacing: -0.005em;
          padding: 0.05rem 0;
          flex: 1;
          min-width: 0;
          outline: none;
          transition: border-color 200ms var(--hearth-curve, ease);
        }

        .cve-title:focus {
          border-bottom-color: rgba(201, 168, 124, 0.30);
        }

        /* ── Type badge ── */
        .cve-badge {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 0.2rem 0.5rem;
          border-radius: 1rem;
          background: rgba(201, 168, 124, 0.08);
          color: var(--amber, #c9a87c);
          white-space: nowrap;
          flex-shrink: 0;
        }

        /* ── Action buttons ── */
        .cve-actions {
          display: flex;
          align-items: center;
          gap: 0.1875rem;
          padding: 0.1875rem;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.05);
          background: rgba(255, 255, 255, 0.02);
          flex-shrink: 0;
        }

        .cve-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 2.125rem;
          height: 2.125rem;
          border-radius: 0.75rem;
          color: var(--text-muted, #6a6258);
          border: 1px solid transparent;
          background: transparent;
          cursor: pointer;
          transition: color 200ms var(--hearth-curve, ease),
                      background 200ms var(--hearth-curve, ease),
                      border-color 200ms var(--hearth-curve, ease),
                      transform 100ms var(--hearth-curve, ease);
        }

        .cve-btn:hover {
          color: var(--text-secondary, #a09689);
          background: rgba(255, 255, 255, 0.045);
          border-color: rgba(255, 255, 255, 0.07);
        }

        .cve-btn:active {
          transform: scale(0.985) translateY(0.5px);
        }

        .cve-btn--danger:hover {
          color: rgba(210, 120, 110, 0.90);
        }

        /* ── Body ── */
        .cve-body {
          flex: 1;
          min-height: 0;
          display: flex;
          overflow: hidden;
        }

        /* ── Textarea editor ── */
        .cve-editor {
          flex: 1;
          background: transparent;
          color: var(--text-primary, #e2dbd0);
          border: none;
          outline: none;
          resize: none;
          padding: 1.125rem 1.25rem 1.5rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.9375rem;
          line-height: 1.65;
          overflow-y: auto;
        }

        .cve-editor::placeholder {
          color: var(--text-muted, #6a6258);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
        }

        .cve-editor--mono {
          font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace);
          font-size: 0.875rem;
          line-height: 1.55;
          tab-size: 2;
        }

        /* ── Preview pane ── */
        .cve-preview {
          flex: 1;
          overflow-y: auto;
          padding: 1.125rem 1.25rem 1.5rem;
          display: flex;
          flex-direction: column;
        }

        /* ── Markdown preview typography — matches Hearth warm-obsidian palette ── */
        .cve-markdown {
          flex: 1;
          color: var(--text-primary, #e2dbd0);
          font-size: 0.9375rem;
          line-height: 1.65;
        }

        .cve-markdown p { margin: 0.5rem 0; }
        .cve-markdown p:first-child { margin-top: 0; }
        .cve-markdown p:last-child { margin-bottom: 0; }

        .cve-markdown h1,
        .cve-markdown h2,
        .cve-markdown h3 {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          color: var(--amber-bright, #e3c49a);
          margin: 1.25rem 0 0.5rem;
          letter-spacing: -0.005em;
        }

        .cve-markdown h1 { font-size: 1.5rem; }
        .cve-markdown h2 { font-size: 1.25rem; }
        .cve-markdown h3 { font-size: 1.0625rem; }

        .cve-markdown h1:first-child,
        .cve-markdown h2:first-child,
        .cve-markdown h3:first-child { margin-top: 0; }

        .cve-markdown code {
          background: rgba(0, 0, 0, 0.28);
          padding: 0.125rem 0.3rem;
          border-radius: 0.3rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.875em;
          color: var(--amber, #c9a87c);
        }

        .cve-markdown pre {
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.05);
          padding: 0.875rem 1rem;
          border-radius: 0.5rem;
          overflow-x: auto;
          margin: 0.75rem 0;
        }

        .cve-markdown pre code {
          background: none;
          padding: 0;
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
        }

        .cve-markdown blockquote {
          border-left: 2px solid rgba(201, 168, 124, 0.35);
          padding-left: 1rem;
          margin: 0.75rem 0;
          color: var(--text-secondary, #a09689);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
        }

        .cve-markdown ul,
        .cve-markdown ol {
          margin: 0.5rem 0;
          padding-left: 1.5rem;
        }

        .cve-markdown li { margin: 0.2rem 0; }

        .cve-markdown a {
          color: var(--amber, #c9a87c);
          text-decoration: underline;
          text-decoration-color: rgba(201, 168, 124, 0.40);
          text-underline-offset: 2px;
        }

        .cve-markdown strong { font-weight: 600; color: var(--text-primary, #e2dbd0); }
        .cve-markdown em { font-style: italic; }

        .cve-markdown hr {
          border: none;
          border-top: 1px solid rgba(255, 255, 255, 0.07);
          margin: 1.25rem 0;
        }

        /* ── HTML iframe ── */
        .cve-iframe {
          flex: 1;
          width: 100%;
          height: 100%;
          border: none;
          background: #fff;
          border-radius: 0.25rem;
        }

        /* ── Save indicator ── */
        .cve-save-indicator {
          position: absolute;
          bottom: 0.625rem;
          right: 0.875rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.06em;
          color: var(--text-muted, #6a6258);
          opacity: 0.55;
          pointer-events: none;
          text-transform: uppercase;
        }
      `}</style>
    </div>
  );
}

// ─── Empty-state placeholder (no canvas selected) ──────────────────────────────


// ─── CanvasView (top-level export) ─────────────────────────────────────────────

export function CanvasView() {
  const [canvases, setCanvases] = useState<CanvasMeta[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  // The open note is in the address (?note=<id>), so the browser's back (a phone's too) returns to the notes.
  const [params, setParams] = useSearchParams();
  const activeId = params.get('note');
  const setActiveId = useCallback((id: string | null) => setParams(id ? { note: id } : {}), [setParams]);
  const [activeCanvas, setActiveCanvas] = useState<CanvasFull | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  // ── Fetch list ──────────────────────────────────────────────────────────────
  async function fetchList() {
    try {
      const res = await apiFetch<{ canvases: CanvasMeta[] }>('/api/canvases');
      setCanvases(res.canvases);
    } catch { /* graceful — backend may not be up yet */ }
    setListLoaded(true);
  }

  // Read whenever the cards show (on arrival, and on coming back from a note), so their first lines and search see what
  // was just written there, or what the companion wrote meanwhile. Saves update only a note's time in the list: putting
  // the saved text back into the open note would undo keystrokes typed while it was saving.
  const onCards = !activeId;
  useEffect(() => {
    if (onCards) fetchList();
  }, [onCards]);

  // ── Fetch full canvas when selection changes ────────────────────────────────
  useEffect(() => {
    if (!activeId) {
      setActiveCanvas(null);
      return;
    }
    let cancelled = false;
    setLoadingFull(true);
    apiFetch<{ canvas: CanvasFull }>(`/api/canvases/${activeId}`)
      .then(res => { if (!cancelled) setActiveCanvas(res.canvas); })
      .catch(() => { if (!cancelled) setActiveCanvas(null); })
      .finally(() => { if (!cancelled) setLoadingFull(false); });
    return () => { cancelled = true; };
  }, [activeId]);

  // ── Create ──────────────────────────────────────────────────────────────────
  async function handleCreate(
    title: string,
    contentType: ContentType,
    language?: string,
  ) {
    try {
      const { canvas: created } = await apiFetch<{ canvas: CanvasFull }>('/api/canvases', {
        method: 'POST',
        body: JSON.stringify({ title, contentType, language }),
      });
      setCanvases(prev => [created, ...prev]);
      setActiveId(created.id);
      setActiveCanvas(created);
    } catch { /* ignore */ }
  }

  // ── After autosave or title change ─────────────────────────────────────────
  function handleSaved(patch: Partial<CanvasMeta> & { id: string }) {
    setCanvases(prev =>
      prev.map(c =>
        c.id === patch.id
          ? { ...c, ...patch, updated_at: new Date().toISOString() }
          : c,
      ),
    );
    if (activeCanvas && activeCanvas.id === patch.id) {
      setActiveCanvas(prev => prev ? { ...prev, ...patch } : prev);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  function handleDeleted(id: string) {
    setCanvases(prev => prev.filter(c => c.id !== id));
    if (activeId === id) {
      setActiveId(null);
      setActiveCanvas(null);
    }
  }

  if (!activeId) {
    return <NotesHome notes={canvases} loaded={listLoaded} onOpen={id => setActiveId(id)} onCreate={handleCreate} />;
  }

  return (
    <div className="cvv-root">
      {/* An open note takes the page, with the way back to all of them above it. */}
      <button className="cvv-back hearth-press" type="button" onClick={() => setActiveId(null)}>
        <span aria-hidden="true">‹</span> All notes
      </button>
      {activeCanvas && !loadingFull ? (
        <CanvasEditor
          canvas={activeCanvas}
          onSaved={handleSaved}
          onConflict={fresh => {
            setActiveCanvas(fresh);
            setCanvases(prev => prev.map(c => (c.id === fresh.id ? { ...c, ...fresh } : c)));
          }}
          onDeleted={handleDeleted}
        />
      ) : (
        <div className="cvv-loading">
          <p className="cvv-loading-text">{loadingFull ? 'Loading…' : 'This note is gone.'}</p>
        </div>
      )}

      <style>{`
        /* ── An open note: the way back, then its editor across the page ── */
        .cvv-root {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          height: 100%;
          width: 100%;
          overflow: hidden;
          background: transparent;
          position: relative;
          padding: 0.75rem 1.25rem 1rem;
        }
        .cvv-root > .cve-root { flex: 1; min-height: 0; }
        .cvv-back {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          align-self: flex-start;
          padding: 0.4rem 1rem;
          border-radius: 999px;
          background: var(--chip-bg, var(--surface-chrome, #2c1a10));
          border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 55%, transparent);
          color: var(--menu-ink, var(--surface-chrome-text, #efe4d0));
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.95rem;
          cursor: pointer;
        }
        .cvv-back span { color: var(--skin-trim, currentColor); font-size: 1.15rem; line-height: 1; }
        @media (max-width: 768px) {
          .cvv-root { padding: 0.5rem 0.4rem 0.6rem; }
        }

        /* Loading placeholder, quiet */
        .cvv-loading {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 0;
        }

        .cvv-loading-text {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.9375rem;
          color: var(--text-muted, #6a6258);
          margin: 0;
          opacity: 0.6;
          animation: cvv-pulse 2s ease-in-out infinite;
        }

        @keyframes cvv-pulse {
          0%, 100% { opacity: 0.4; }
          50%       { opacity: 0.75; }
        }
      `}</style>
    </div>
  );
}
