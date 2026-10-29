/**
 * SidebarSection — a collapsible user-created section in the thread sidebar.
 *
 * Renders the section header (chevron + name + ⋯ menu) and its thread children.
 * Accepts the same DnD callbacks and context-menu hooks as the loose thread zone
 * so the parent (ThreadSidebar) controls all interaction state centrally.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { Section, ThreadSummary } from '@sanctum/shared';

export interface SidebarSectionProps {
  section: Section;
  threads: ThreadSummary[];          // threads belonging to this section (pre-filtered)
  activeThreadId: string | null;
  renamingThreadId: string | null;
  renameDraft: string;
  draggingId: string | null;
  dragOverId: string | null;
  dragOverPos: 'before' | 'after';
  // ── Section-level drag ──
  isDraggingSection: boolean;        // this section is being dragged
  dragOverSectionId: string | null;
  dragOverSectionPos: 'before' | 'after';
  // ── Callbacks ──
  onLoadThread: (id: string) => void;
  onCloseDrawer: () => void;
  onThreadContextMenu: (e: React.MouseEvent, threadId: string, pinned: boolean, sectionId: string | null) => void;
  onThreadMoreClick: (e: React.MouseEvent, threadId: string, pinned: boolean, sectionId: string | null) => void;
  onRenameInputChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onRenameInputRef: (el: HTMLInputElement | null) => void;
  // Thread DnD
  onThreadDragStart: (e: React.DragEvent, id: string, fromSectionId: string | null) => void;
  onThreadDragEnd: () => void;
  onThreadDragOver: (e: React.DragEvent, overId: string) => void;
  onThreadDragLeave: (e: React.DragEvent) => void;
  onThreadDrop: (e: React.DragEvent, targetId: string, targetSectionId: string | null) => void;
  // Drop INTO section (header/body area when no threads present)
  onSectionBodyDragOver: (e: React.DragEvent, sectionId: string) => void;
  onSectionBodyDrop: (e: React.DragEvent, sectionId: string) => void;
  // Section DnD
  onSectionDragStart: (e: React.DragEvent, sectionId: string) => void;
  onSectionDragEnd: () => void;
  onSectionDragOver: (e: React.DragEvent, sectionId: string) => void;
  onSectionDragLeave: (e: React.DragEvent) => void;
  onSectionDrop: (e: React.DragEvent, sectionId: string) => void;
  // Section actions
  onToggleCollapse: (id: string, collapsed: boolean) => void;
  onSectionRename: (id: string) => void;
  onSectionDelete: (id: string) => void;
}

export function SidebarSection({
  section,
  threads,
  activeThreadId,
  renamingThreadId,
  renameDraft,
  draggingId,
  dragOverId,
  dragOverPos,
  isDraggingSection,
  dragOverSectionId,
  dragOverSectionPos,
  onLoadThread,
  onCloseDrawer,
  onThreadContextMenu,
  onThreadMoreClick,
  onRenameInputChange,
  onRenameCommit,
  onRenameCancel,
  onRenameInputRef,
  onThreadDragStart,
  onThreadDragEnd,
  onThreadDragOver,
  onThreadDragLeave,
  onThreadDrop,
  onSectionBodyDragOver,
  onSectionBodyDrop,
  onSectionDragStart,
  onSectionDragEnd,
  onSectionDragOver,
  onSectionDragLeave,
  onSectionDrop,
  onToggleCollapse,
  onSectionRename,
  onSectionDelete,
}: SidebarSectionProps) {
  const isCollapsed = section.collapsed;
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false);
  const sectionMenuRef = useRef<HTMLDivElement>(null);
  const sectionMenuBtnRef = useRef<HTMLButtonElement>(null);

  // Close section ⋯ menu on outside click / Escape
  useEffect(() => {
    if (!sectionMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (
        sectionMenuRef.current && !sectionMenuRef.current.contains(e.target as Node) &&
        sectionMenuBtnRef.current && !sectionMenuBtnRef.current.contains(e.target as Node)
      ) {
        setSectionMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSectionMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [sectionMenuOpen]);

  const isDropTargetBefore = dragOverSectionId === section.id && dragOverSectionPos === 'before';
  const isDropTargetAfter  = dragOverSectionId === section.id && dragOverSectionPos === 'after';

  return (
    <div
      className={[
        'ss-root',
        isDraggingSection ? 'ss-dragging' : '',
        isDropTargetBefore ? 'ss-drop-before' : '',
        isDropTargetAfter  ? 'ss-drop-after'  : '',
      ].filter(Boolean).join(' ')}
      draggable
      onDragStart={e => onSectionDragStart(e, section.id)}
      onDragEnd={onSectionDragEnd}
      onDragOver={e => onSectionDragOver(e, section.id)}
      onDragLeave={onSectionDragLeave}
      onDrop={e => onSectionDrop(e, section.id)}
    >
      {/* ── Section header ── */}
      <div
        className="ss-header"
        onClick={() => onToggleCollapse(section.id, !isCollapsed)}
        onContextMenu={e => {
          e.preventDefault();
          setSectionMenuOpen(v => !v);
        }}
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleCollapse(section.id, !isCollapsed); } }}
      >
        {/* Chevron */}
        <svg
          className={`ss-chevron${isCollapsed ? '' : ' ss-chevron-open'}`}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>

        <span className="ss-name">{section.name}</span>

        {/* ⋯ section menu button */}
        <button
          ref={sectionMenuBtnRef}
          className="ss-more-btn"
          onClick={e => { e.stopPropagation(); setSectionMenuOpen(v => !v); }}
          aria-label={`Section options for ${section.name}`}
          title="Section options"
          tabIndex={-1}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
          </svg>
        </button>

        {/* Inline section ⋯ menu */}
        {sectionMenuOpen && (
          <div
            ref={sectionMenuRef}
            className="ss-menu"
            role="menu"
            onClick={e => e.stopPropagation()}
          >
            <button
              className="ss-menu-item"
              role="menuitem"
              onClick={() => { setSectionMenuOpen(false); onSectionRename(section.id); }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              Rename
            </button>
            <div className="ss-menu-sep" role="separator" />
            <button
              className="ss-menu-item ss-menu-danger"
              role="menuitem"
              onClick={() => { setSectionMenuOpen(false); onSectionDelete(section.id); }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
              </svg>
              Delete section
            </button>
          </div>
        )}
      </div>

      {/* ── Section body — threads + empty drop target ── */}
      {!isCollapsed && (
        <div
          className={`ss-body${threads.length === 0 ? ' ss-body-empty' : ''}`}
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onSectionBodyDragOver(e, section.id); }}
          onDrop={e => onSectionBodyDrop(e, section.id)}
        >
          {threads.length === 0 ? (
            <div className="ss-empty-hint">drop threads here</div>
          ) : (
            threads.map(t => {
              const isActive = t.id === activeThreadId;
              const isDraggingThread = draggingId === t.id;
              const isDropTarget = dragOverId === t.id;
              const isRenaming = renamingThreadId === t.id;

              return (
                <div
                  key={t.id}
                  className={[
                    'thread-item-wrap',
                    isDraggingThread ? 'ti-dragging' : '',
                    isDropTarget && dragOverPos === 'before' ? 'ti-drop-before' : '',
                    isDropTarget && dragOverPos === 'after'  ? 'ti-drop-after'  : '',
                  ].filter(Boolean).join(' ')}
                  draggable
                  onDragStart={e => onThreadDragStart(e, t.id, section.id)}
                  onDragEnd={onThreadDragEnd}
                  onDragOver={e => onThreadDragOver(e, t.id)}
                  onDragLeave={onThreadDragLeave}
                  onDrop={e => onThreadDrop(e, t.id, section.id)}
                >
                  <button
                    className={`thread-item ss-thread-item${isActive ? ' active' : ''}`}
                    onClick={async () => {
                      if (isRenaming) return;
                      onLoadThread(t.id);
                      onCloseDrawer();
                    }}
                    onContextMenu={e => onThreadContextMenu(e, t.id, !!t.pinned_at, section.id)}
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
                        ref={onRenameInputRef}
                        className="thread-name-input thread-rename-input"
                        value={renameDraft}
                        onChange={e => onRenameInputChange(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); onRenameCommit(); }
                          if (e.key === 'Escape') { e.preventDefault(); onRenameCancel(); }
                        }}
                        onBlur={onRenameCommit}
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
                        onClick={e => { e.stopPropagation(); onThreadMoreClick(e, t.id, !!t.pinned_at, section.id); }}
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
            })
          )}
        </div>
      )}

      <style>{`
        /* ── Section root — DnD target for reorder ── */
        .ss-root {
          position: relative;
          margin-bottom: 0.125rem;
        }
        .ss-root::before,
        .ss-root::after {
          content: '';
          position: absolute;
          left: 0.375rem;
          right: 0.375rem;
          height: 2px;
          border-radius: 1px;
          background: var(--amber, #c9a87c);
          opacity: 0;
          pointer-events: none;
          transition: opacity 80ms ease;
          z-index: 2;
        }
        .ss-root::before { top: 0; }
        .ss-root::after  { bottom: 0; }
        .ss-drop-before::before { opacity: 0.75; }
        .ss-drop-after::after   { opacity: 0.75; }
        .ss-dragging { opacity: 0.4; }

        /* ── Header ── */
        .ss-header {
          display: flex;
          align-items: center;
          gap: 0.3125rem;
          padding: 0.4375rem 0.5rem 0.4375rem 0.625rem;
          border-radius: 0.4375rem;
          cursor: pointer;
          user-select: none;
          color: var(--text-secondary, #a09689);
          position: relative;
          transition: color 160ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1));
        }
        .ss-header:hover {
          color: var(--text-primary, #e2dbd0);
          background: rgba(201,168,124,0.04);
        }

        .ss-chevron {
          flex-shrink: 0;
          opacity: 0.55;
          transition: transform 200ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)), opacity 160ms ease;
          /* Default: pointing right (collapsed) */
        }
        .ss-chevron-open {
          transform: rotate(90deg);
          opacity: 0.75;
        }

        .ss-name {
          flex: 1;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.8125rem;
          font-weight: 400;
          letter-spacing: 0.01em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          line-height: 1.3;
        }

        .ss-more-btn {
          flex-shrink: 0;
          display: grid;
          place-items: center;
          width: 1.25rem;
          height: 1.25rem;
          border-radius: 0.3125rem;
          border: none;
          background: transparent;
          color: var(--text-muted, #6a6258);
          cursor: pointer;
          opacity: 0;
          transition:
            opacity 160ms var(--hearth-curve, cubic-bezier(0.16,1,0.3,1)),
            background 120ms ease,
            color 120ms ease;
        }
        .ss-header:hover .ss-more-btn,
        .ss-header:focus-within .ss-more-btn {
          opacity: 1;
        }
        .ss-more-btn:hover {
          background: rgba(201,168,124,0.1);
          color: var(--text-primary, #e2dbd0);
          opacity: 1;
        }

        /* ── Section inline menu ── */
        .ss-menu {
          position: absolute;
          top: calc(100% + 2px);
          right: 0;
          z-index: 500;
          min-width: 9.5rem;
          background: var(--bg-secondary, #131210);
          border: 1px solid rgba(201,168,124,0.14);
          border-radius: 0.625rem;
          padding: 0.3125rem;
          box-shadow:
            0 0 0 1px rgba(0,0,0,0.35),
            0 8px 24px rgba(0,0,0,0.5),
            0 2px 6px rgba(0,0,0,0.3);
          animation: ssmenuIn 120ms var(--hearth-curve, cubic-bezier(0.25,0.46,0.45,0.94)) both;
        }
        @keyframes ssmenuIn {
          from { opacity: 0; transform: scale(0.95) translateY(-4px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        .ss-menu-item {
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
        .ss-menu-item:hover {
          background: rgba(201,168,124,0.08);
          color: var(--text-primary, #e2dbd0);
        }
        .ss-menu-item svg { flex-shrink: 0; opacity: 0.7; }
        .ss-menu-sep {
          height: 1px;
          background: rgba(255,255,255,0.06);
          margin: 0.25rem 0.375rem;
        }
        .ss-menu-danger { color: var(--status-error-text); }
        .ss-menu-danger:hover {
          background: rgba(220,140,120,0.1);
          color: var(--status-error-text);
        }
        .ss-menu-danger svg { opacity: 0.8; }

        /* ── Body — thread list inside section ── */
        .ss-body {
          padding: 0.125rem 0 0.25rem 0.75rem;
        }
        .ss-body-empty {
          border: 1px dashed rgba(201,168,124,0.15);
          border-radius: 0.4375rem;
          padding: 0.375rem 0.625rem;
          margin: 0.125rem 0.375rem 0.25rem;
        }
        .ss-empty-hint {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.75rem;
          color: var(--text-muted, #6a6258);
          text-align: center;
          padding: 0.25rem 0;
        }

        /* Threads inside section get a slightly tighter indent */
        .ss-thread-item {
          padding-left: 0.5rem !important;
        }
      `}</style>
    </div>
  );
}
