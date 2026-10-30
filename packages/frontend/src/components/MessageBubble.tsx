import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Message, MessageSegment } from '@sanctum/shared';
import type { ToolEvent, ThinkingEvent } from '../store/chat';
import { renderMarkdown } from '../utils/markdown';
import { HearthAudioPlayer } from './HearthAudioPlayer';
import { PersistedThinkingAccordion } from './ThinkingAccordion';
import { useConfirm } from './ConfirmDialog';
import { useIdentity, avatarSrc } from '../store/identity';

// ─── Base URL (matches SettingsView) ──────────────────────────────────────────
import { BASE } from '../lib/base';
import { ORNAMENT_SLOTS } from '../theme/materials';

// ─── Attachment contract ──────────────────────────────────────────────────────
interface AttachmentMeta {
  fileId: string;
  filename: string;
  contentType: 'image' | 'audio' | 'file';
  url: string;
}

function getAttachments(metadata: Record<string, unknown> | null): AttachmentMeta[] {
  if (!metadata) return [];
  if (!Array.isArray(metadata.attachments)) return [];
  return (metadata.attachments as unknown[]).filter(
    (a): a is AttachmentMeta =>
      !!a &&
      typeof a === 'object' &&
      typeof (a as AttachmentMeta).fileId === 'string' &&
      typeof (a as AttachmentMeta).filename === 'string'
  );
}

// ─── Lightbox (image full-screen) ────────────────────────────────────────────

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="att-lightbox" role="dialog" aria-label="Full size image" aria-modal="true">
      {/* backdrop */}
      <button
        className="att-lightbox-backdrop"
        onClick={onClose}
        aria-label="Close lightbox"
        type="button"
      />
      {/* image */}
      <img src={src} alt="" className="att-lightbox-img" />
      {/* explicit close button */}
      <button
        className="att-lightbox-close"
        onClick={onClose}
        aria-label="Close"
        type="button"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// ─── Attachment grid / audio / file chip ──────────────────────────────────────

function AttachmentBlock({ attachments }: { attachments: AttachmentMeta[] }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const images = attachments.filter(a => a.contentType === 'image');
  const audios  = attachments.filter(a => a.contentType === 'audio');
  const files   = attachments.filter(a => a.contentType === 'file');

  const closeLightbox = useCallback(() => setLightboxSrc(null), []);

  if (attachments.length === 0) return null;

  return (
    <div className="att-block">
      {/* Image grid */}
      {images.length > 0 && (
        <div className={`att-image-grid${images.length === 1 ? ' single' : ''}`}>
          {images.map(img => {
            const src = `${BASE}/api/files/${img.fileId}`;
            return (
              <button
                key={img.fileId}
                className="att-thumb-btn"
                onClick={() => setLightboxSrc(src)}
                aria-label={`View ${img.filename}`}
                type="button"
              >
                <img
                  src={src}
                  alt={img.filename}
                  className="att-thumb-img"
                  loading="lazy"
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Audio players — HearthAudioPlayer replaces native <audio controls> */}
      {audios.map(aud => (
        <HearthAudioPlayer
          key={aud.fileId}
          fileId={aud.fileId}
          filename={aud.filename}
        />
      ))}

      {/* File chips */}
      {files.map(f => {
        const href = `${BASE}/api/files/${f.fileId}`;
        return (
          <a
            key={f.fileId}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="att-file-chip"
            aria-label={`Download ${f.filename}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span className="att-file-name">{f.filename}</span>
          </a>
        );
      })}

      {/* Lightbox */}
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={closeLightbox} />}
    </div>
  );
}

// ─── Per-process TTS blob cache (survives re-renders, shared across instances) ─
const _g = globalThis as Record<string, unknown>;
if (!_g.__ttsCache) _g.__ttsCache = new Map<string, string>();
const _ttsCache = _g.__ttsCache as Map<string, string>;

type TtsState = 'idle' | 'loading' | 'playing';

// Mobile audio unlock — play a silent byte on first user interaction so
// AudioContext / HTMLAudio can play without a gesture later.
let _mobileUnlocked = false;
function ensureMobileUnlock() {
  if (_mobileUnlocked) return;
  _mobileUnlocked = true;
  const a = new Audio();
  a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  a.play().catch(() => { /* best-effort */ });
  a.pause();
}

// ─── Read-aloud button ────────────────────────────────────────────────────────

function ReadAloudButton({ messageId, text }: { messageId: string; text: string }) {
  const [ttsState, setTtsState] = useState<TtsState>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggle = useCallback(async () => {
    // Unlock mobile on first interaction
    ensureMobileUnlock();

    if (ttsState === 'playing' && audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setTtsState('idle');
      return;
    }
    if (ttsState === 'loading') return;

    // Create audio element now (during gesture) for mobile compatibility
    const audio = new Audio();
    audioRef.current = audio;

    const cached = _ttsCache.get(messageId);

    try {
      let blobUrl: string;
      if (cached) {
        blobUrl = cached;
      } else {
        setTtsState('loading');
        const res = await fetch(`${BASE}/api/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, messageId }),
        });
        if (!res.ok) throw new Error(`TTS ${res.status}`);
        const blob = await res.blob();
        if (blob.size === 0) throw new Error('Empty audio');
        blobUrl = URL.createObjectURL(blob);
        _ttsCache.set(messageId, blobUrl);
      }

      audio.onended = () => {
        setTtsState('idle');
        audioRef.current = null;
      };
      audio.onerror = () => {
        setTtsState('idle');
        audioRef.current = null;
      };

      audio.src = blobUrl;
      await audio.play();
      setTtsState('playing');
    } catch (err) {
      console.warn('[TTS] Read aloud failed:', err);
      setTtsState('idle');
      audioRef.current = null;
    }
  }, [ttsState, messageId, text]);

  const label = ttsState === 'playing' ? 'Stop' : ttsState === 'loading' ? 'Generating…' : 'Read aloud';

  return (
    <button
      className={`ral-btn${ttsState === 'playing' ? ' playing' : ''}${ttsState === 'loading' ? ' loading' : ''}`}
      onClick={toggle}
      disabled={ttsState === 'loading'}
      title={label}
      aria-label={label}
      type="button"
    >
      {ttsState === 'loading' ? (
        <span className="ral-spinner" aria-hidden="true" />
      ) : ttsState === 'playing' ? (
        /* Pause bars */
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
        </svg>
      ) : (
        /* Play triangle */
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <polygon points="5,3 19,12 5,21" />
        </svg>
      )}
    </button>
  );
}

interface Props {
  message: Message;
  isStreaming?: boolean;
  streamTokens?: string;
  toolEvents?: ToolEvent[];
  thinkingEvents?: ThinkingEvent[];
  onReply?: (id: string, preview: string) => void;
  /** When true, suppress the sender label + timestamp (grouped same-role run) */
  suppressHeader?: boolean;
  /** Whether the thinking timeline should be visible (from thread's show_thinking) */
  showThinking?: boolean;
  /** Whether this is the last companion message in the thread — used to scope the Regenerate button */
  isLastCompanion?: boolean;
  /** created_at of the previous message in the list — used for cross-day bubble timestamp formatting */
  prevTimestamp?: string;
}

// ─── Emoji picker (micro, 6 quick picks) ──────────────────────────────────────
const QUICK_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🔥'];

function EmojiPicker({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div className="emoji-picker" ref={ref} role="dialog" aria-label="Pick a reaction">
      {QUICK_EMOJIS.map(emoji => (
        <button
          key={emoji}
          className="emoji-pick-btn"
          onClick={() => { onSelect(emoji); onClose(); }}
          aria-label={emoji}
          type="button"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

// ─── Reaction chip row ────────────────────────────────────────────────────────
interface ReactionEntry { emoji: string; user: string; created_at: string }

function ReactionChips({ reactions, messageId }: { reactions: ReactionEntry[]; messageId: string }) {
  // Group by emoji, count
  const groups = reactions.reduce<Record<string, { count: number; mine: boolean }>>((acc, r) => {
    if (!acc[r.emoji]) acc[r.emoji] = { count: 0, mine: false };
    acc[r.emoji].count += 1;
    if (r.user === 'user') acc[r.emoji].mine = true;
    return acc;
  }, {});

  const entries = Object.entries(groups);
  if (entries.length === 0) return null;

  async function toggle(emoji: string, mine: boolean) {
    try {
      const method = mine ? 'DELETE' : 'POST';
      const res = await fetch(`${BASE}/api/messages/${messageId}/reactions`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('[Reactions] Toggle failed:', err);
    }
  }

  return (
    <div className="reaction-chips">
      {entries.map(([emoji, { count, mine }]) => (
        <button
          key={emoji}
          className={`reaction-chip${mine ? ' mine' : ''}`}
          onClick={() => toggle(emoji, mine)}
          title={mine ? `Remove ${emoji}` : `React with ${emoji}`}
          type="button"
        >
          <span>{emoji}</span>
          {count > 1 && <span className="reaction-count">{count}</span>}
        </button>
      ))}
    </div>
  );
}

// ─── Message action row ────────────────────────────────────────────────────────
interface ActionRowProps {
  message: Message;
  isCompanion: boolean;
  isLastCompanion: boolean;
  onReply?: (id: string, preview: string) => void;
  onReactionPicker: () => void;
}

function MessageActionRow({ message, isCompanion, isLastCompanion, onReply, onReactionPicker }: ActionRowProps) {
  const confirm = useConfirm();
  const [copyFlash, setCopyFlash] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveFlash, setSaveFlash] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  async function handleDelete() {
    const ok = await confirm({
      // Honest copy: the backend soft-deletes (deleted_at), it does not purge.
      title: 'Delete this message?',
      body: 'The message will be removed from the thread.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${BASE}/api/messages/${message.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('[Actions] Delete failed:', err);
    }
  }

  function handleReply() {
    if (!onReply) return;
    const preview = message.content.slice(0, 80) + (message.content.length > 80 ? '…' : '');
    onReply(message.id, preview);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopyFlash(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyFlash(false), 1400);
    } catch (err) {
      console.warn('[Actions] Copy failed:', err);
    }
  }

  async function handleSaveToCanvas() {
    try {
      const res = await fetch(`${BASE}/api/messages/${message.id}/save-to-canvas`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // canvas_created broadcast → store → panel auto-opens. Flash ONLY on
      // confirmed success — the checkmark must never lie.
      setSaveFlash(true);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => setSaveFlash(false), 1400);
    } catch (err) {
      console.error('[Actions] Save to canvas failed:', err);
    }
  }

  async function handleRegenerate() {
    if (regenerating) return;
    setRegenerating(true);
    try {
      const res = await fetch(`${BASE}/api/messages/${message.id}/regenerate`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Backend deletes this message (message_deleted → marks deleted_at in store)
      // then streams a fresh response via stream_* events (handled by existing store logic).
    } catch (err) {
      console.error('[Actions] Regenerate failed:', err);
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="msg-action-row">
      {/* Reply — all messages */}
      <button className="msg-action-btn" onClick={handleReply} title="Reply" type="button" aria-label="Reply">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M9 17H5a2 2 0 01-2-2V5a2 2 0 012-2h11a2 2 0 012 2v3"/>
          <path d="M19 17l-4 4-4-4M15 21V11"/>
        </svg>
      </button>

      {/* Reaction picker */}
      <button className="msg-action-btn" onClick={onReactionPicker} title="React" type="button" aria-label="Add reaction">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M8 13s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
        </svg>
      </button>

      {/* Copy — all messages */}
      <button
        className={`msg-action-btn${copyFlash ? ' flashed' : ''}`}
        onClick={handleCopy}
        title={copyFlash ? 'Copied' : 'Copy'}
        type="button"
        aria-label="Copy message"
      >
        {copyFlash ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
        )}
      </button>

      {/* Save to canvas — companion messages only */}
      {isCompanion && (
        <button
          className={`msg-action-btn${saveFlash ? ' flashed' : ''}`}
          onClick={handleSaveToCanvas}
          title={saveFlash ? 'Saved' : 'Save to canvas'}
          type="button"
          aria-label="Save to canvas"
        >
          {saveFlash ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg>
          )}
        </button>
      )}

      {/* Regenerate — companion messages only (scoped to last companion) */}
      {isCompanion && isLastCompanion && (
        <button
          className={`msg-action-btn${regenerating ? ' regenerating' : ''}`}
          onClick={handleRegenerate}
          disabled={regenerating}
          title={regenerating ? 'Regenerating…' : 'Regenerate'}
          type="button"
          aria-label="Regenerate response"
        >
          {regenerating ? (
            <span className="action-spinner" aria-hidden="true" />
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <polyline points="1 4 1 10 7 10"/>
              <path d="M3.51 15a9 9 0 1 0 .49-3.51"/>
            </svg>
          )}
        </button>
      )}

      {/* Delete */}
      <button className="msg-action-btn danger" onClick={handleDelete} title="Delete" type="button" aria-label="Delete message">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
          <path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
        </svg>
      </button>
    </div>
  );
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// Format a per-message bubble timestamp.
// If the message date matches `prevDate` (YYYY-MM-DD), only show HH:MM.
// Otherwise prepend a short date like "Jun 20 · HH:MM".
function formatBubbleTime(timestamp: string, prevTimestamp?: string): string {
  const d = new Date(timestamp);
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (!prevTimestamp) return time;
  const prevD = new Date(prevTimestamp);
  const sameDay =
    d.getFullYear() === prevD.getFullYear() &&
    d.getMonth() === prevD.getMonth() &&
    d.getDate() === prevD.getDate();
  if (sameDay) return time;
  const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${dateStr} · ${time}`;
}

function formatToolOutput(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 2) {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch {}
  }
  return raw;
}

// ─── Thinking block ───────────────────────────────────────────────────────────

function ThinkingBlock({ event, index }: { event: ThinkingEvent; index: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="thinking-block">
      <button
        className="thinking-header"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
        </svg>
        <span className="thinking-summary">{event.summary || 'Thinking...'}</span>
        <span className="thinking-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="thinking-content">{event.content}</div>
      )}
    </div>
  );
}

// ─── Tool chip ────────────────────────────────────────────────────────────────

function ToolChip({ tool, isStreaming: streaming }: { tool: ToolEvent; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`tool-chip${tool.isError ? ' error' : ''}`}>
      <button
        className="tool-chip-header"
        onClick={() => tool.output && setExpanded(e => !e)}
        disabled={!tool.output}
      >
        {!tool.isComplete && streaming ? (
          <span className="tool-spinner" />
        ) : (
          <span className="tool-chevron">{expanded ? '▾' : '▸'}</span>
        )}
        <span className="tool-name">{tool.toolName}</span>
        {tool.input && <span className="tool-input">{tool.input}</span>}
        {tool.isError && <span className="tool-error-badge">error</span>}
        {tool.elapsed !== undefined && (
          <span className="tool-elapsed">{tool.elapsed.toFixed(1)}s</span>
        )}
      </button>
      {expanded && tool.output && (
        <pre className="tool-output">{formatToolOutput(tool.output)}</pre>
      )}
    </div>
  );
}

// ─── Memoized markdown body — isolates the expensive parse from parent re-renders ─
// When MessageBubble re-renders due to tool/thinking/hover state, this subtree
// bails out unless `html` itself changed, preventing redundant marked+DOMPurify
// passes on already-parsed content.
const MarkdownBody = React.memo(function MarkdownBody({ html }: { html: string }) {
  return (
    <div
      className="prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

// ─── Main component ───────────────────────────────────────────────────────────

export function MessageBubble({ message, isStreaming = false, streamTokens = '', toolEvents = [], thinkingEvents = [], onReply, suppressHeader = false, showThinking = true, isLastCompanion = false, prevTimestamp }: Props) {
  const [showTools, setShowTools] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  if (message.role === 'system') {
    return (
      <div className="message-system">
        <span className="system-text">{message.content}</span>
      </div>
    );
  }

  const isCompanion = message.role === 'companion';
  const isDeleted = !!message.deleted_at;
  const displayContent = isStreaming && streamTokens ? streamTokens : message.content;

  // ─── Stream-head split ────────────────────────────────────────────────────
  // While streaming, split displayContent into a stable body (all but the last
  // ~15 chars, clamped to a word boundary) and a head (the newly-revealed tail).
  // The body is rendered once per word-boundary shift; the head gets a fade-in
  // animation so each new word appears softly rather than popping in hard.
  // This also reduces the number of full markdown re-parses (bodyText is stable
  // until the word boundary crosses the cutoff).
  const HEAD_CHARS = 15;
  const { bodyText, headText } = useMemo<{ bodyText: string; headText: string }>(() => {
    if (!isStreaming || !streamTokens) {
      return { bodyText: displayContent, headText: '' };
    }
    if (displayContent.length <= HEAD_CHARS) {
      // Short enough that the whole thing is the "head"
      return { bodyText: '', headText: displayContent };
    }
    // Walk back to a word boundary (space/newline) within the tail
    let splitAt = displayContent.length - HEAD_CHARS;
    const wordBoundarySearch = displayContent.lastIndexOf(' ', splitAt + HEAD_CHARS - 1);
    if (wordBoundarySearch > splitAt - HEAD_CHARS && wordBoundarySearch > 0) {
      splitAt = wordBoundarySearch + 1; // just after the space
    }
    return {
      bodyText: displayContent.slice(0, splitAt),
      headText: displayContent.slice(splitAt),
    };
  }, [isStreaming, streamTokens, displayContent]);

  // Memoize the expensive marked+DOMPurify pass — only re-runs when the render
  // input changes. While streaming, we parse bodyText (stable until word-boundary
  // shifts); when not streaming we parse displayContent (the stored message content).
  const renderInput = isStreaming ? bodyText : displayContent;
  const rendered = useMemo(
    () => (!isDeleted ? renderMarkdown(renderInput) : ''),
    [renderInput, isDeleted]
  );
  const hasTools = toolEvents.length > 0;
  const hasThinking = thinkingEvents.length > 0;

  // ─── Persisted segments ───────────────────────────────────────────────────
  // When the backend has stored metadata.segments, use the accordion renderer.
  // Fall back gracefully for older messages without segments.
  const segments = useMemo<MessageSegment[] | null>(() => {
    if (!message.metadata) return null;
    const segs = message.metadata.segments;
    if (!Array.isArray(segs) || segs.length === 0) return null;
    return segs as MessageSegment[];
  }, [message.metadata]);

  // Text segments from the segments array (for rendering prose)
  const segmentTexts = useMemo<string[]>(() => {
    if (!segments) return [];
    return segments.filter((s): s is Extract<MessageSegment, { type: 'text' }> => s.type === 'text').map(s => s.content);
  }, [segments]);

  // Memoize rendered HTML for each text segment
  const renderedSegments = useMemo<string[]>(() => {
    if (!segments) return [];
    return segmentTexts.map(t => renderMarkdown(t));
  }, [segments, segmentTexts]);

  // Attribution: companion = amber, user = lavender
  const identity = useIdentity();
  const roleName = isCompanion ? identity.companion_name : 'you';

  // Extract reactions from metadata
  const reactions: Array<{ emoji: string; user: string; created_at: string }> =
    Array.isArray(message.metadata?.reactions) ? message.metadata.reactions as Array<{ emoji: string; user: string; created_at: string }> : [];

  // Extract attachments from metadata
  const attachments = getAttachments(message.metadata ?? null);

  async function handleReactionSelect(emoji: string) {
    const mine = reactions.some(r => r.emoji === emoji && r.user === 'user');
    try {
      const method = mine ? 'DELETE' : 'POST';
      const res = await fetch(`${BASE}/api/messages/${message.id}/reactions`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('[Reactions] Select failed:', err);
    }
  }

  return (
    <article
      className={`message ${message.role}${isDeleted ? ' deleted' : ''}`}
      aria-label={`${isCompanion ? 'Companion' : 'You'} message`}
      data-orn={(message.sequence ?? 0) % ORNAMENT_SLOTS}
    >
      {/* Attribution — suppressed in grouped same-role runs.
          Tools toggle only shown on legacy path (no segments); the accordion handles segments. */}
      {(!suppressHeader || (isCompanion && hasTools && !segments)) && (
        <div className="message-header">
          {!suppressHeader && (
            <>
              {isCompanion && identity.avatar_url && (
                <img className="message-avatar is-custom" src={avatarSrc(identity)} alt="" aria-hidden="true" width={22} height={22} />
              )}
              <span className="message-role">{roleName}</span>
              <span className="message-time">{formatTime(message.created_at)}</span>
              {message.edited_at && !isDeleted && (
                <span className="message-edited">edited</span>
              )}
            </>
          )}
          {isCompanion && hasTools && !segments && (
            <button
              className="tools-toggle"
              onClick={() => setShowTools(s => !s)}
            >
              {showTools ? 'hide' : `${toolEvents.length} tool${toolEvents.length !== 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      )}

      <div className="message-content">
        {isDeleted ? (
          <span className="deleted-text">This message was deleted</span>
        ) : segments && isCompanion && !isStreaming ? (
          // ─── Persisted segment rendering (messages with metadata.segments) ───
          // Chronological: thinking accordion (if has thinking/tool segments),
          // then interleaved text blocks from the segments array.
          <>
            {/* Attachments */}
            {attachments.length > 0 && (
              <AttachmentBlock attachments={attachments} />
            )}

            {/* Accordion for thinking + tool segments */}
            <PersistedThinkingAccordion
              segments={segments}
              showThinking={showThinking}
            />

            {/* Text segments — rendered in order */}
            {renderedSegments.map((html, i) => (
              html.trim().length > 0 ? <MarkdownBody key={i} html={html} /> : null
            ))}
          </>
        ) : (
          // ─── Legacy / streaming rendering ────────────────────────────────
          <>
            {/* Thinking events — legacy path (when no segments) */}
            {hasThinking && isCompanion && showThinking && thinkingEvents.map((ev, i) => (
              <ThinkingBlock key={i} event={ev} index={i} />
            ))}

            {/* Attachments — images / audio / file chips */}
            {attachments.length > 0 && (
              <AttachmentBlock attachments={attachments} />
            )}

            {/* Markdown content (may be empty when message is attachment-only) */}
            {displayContent.trim().length > 0 && (
              <>
                {/* Body: stable between word-boundary shifts — avoids per-token
                    markdown re-parse. On non-streaming messages, rendered from
                    full displayContent (headText is ''). */}
                {(isStreaming ? bodyText : displayContent).trim().length > 0 && (
                  <MarkdownBody html={rendered} />
                )}
                {/* Head: the freshly-revealed tail chars, fades in per-token.
                    Opacity only — no transform, to avoid layout shift mid-stream. */}
                {isStreaming && headText && (
                  <span className="stream-head" key={headText} aria-hidden="false">
                    {headText}
                  </span>
                )}
              </>
            )}

            {/* Streaming cursor */}
            {isStreaming && (
              <span className="streaming-cursor" aria-hidden="true">|</span>
            )}
          </>
        )}
      </div>

      {/* Tools panel — collapsible (legacy path only, when no segments) */}
      {!segments && showTools && hasTools && (
        <div className="tools-panel">
          {toolEvents.map(tool => (
            <ToolChip key={tool.toolId} tool={tool} isStreaming={isStreaming} />
          ))}
        </div>
      )}

      {/* Reaction chips — below content, before action row */}
      {reactions.length > 0 && !isDeleted && (
        <ReactionChips reactions={reactions} messageId={message.id} />
      )}

      {/* Emoji picker (positioned relative to the message) */}
      {showEmojiPicker && (
        <EmojiPicker
          onSelect={handleReactionSelect}
          onClose={() => setShowEmojiPicker(false)}
        />
      )}

      {/* Per-message hover timestamp — hidden at rest, appears on bubble hover
          Only shown when suppressHeader=true (grouped bubbles hide the header timestamp)
          or always for non-grouped bubbles where the header shows a group-level time.
          Positioned as part of the ral-row so it reveals together with actions. */}
      {!isDeleted && !isStreaming && (
        <div className="ral-row">
          <MessageActionRow
            message={message}
            isCompanion={isCompanion}
            isLastCompanion={isLastCompanion}
            onReply={onReply}
            onReactionPicker={() => setShowEmojiPicker(s => !s)}
          />
          {isCompanion && message.content.trim().length > 5 && (
            <ReadAloudButton messageId={message.id} text={message.content} />
          )}
          {/* Bubble timestamp — always present but revealed on hover via .ral-row opacity */}
          <span className="bubble-ts" aria-label={`Sent at ${formatBubbleTime(message.created_at, prevTimestamp)}`}>
            {formatBubbleTime(message.created_at, prevTimestamp)}
          </span>
        </div>
      )}

      <style>{`
        /* ─── Fold note — small centred italic line, thin rule either side ─── */
        .message-system {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.9rem;
          margin: 1.1rem 0;
          color: var(--fold-ink, var(--text-secondary, #6b5d55));
        }
        .message-system::before,
        .message-system::after {
          content: '';
          flex: 1;
          height: 1px;
          background: currentColor;
          opacity: 0.3;
        }
        .system-text {
          font-size: 0.875rem;
          color: inherit;
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-style: italic;
          text-align: center;
          max-width: 75%;
        }

        /* ─── Bubble shell ───────────────────────────────────────────────────────
           CRAFT PRINCIPLES APPLIED:
           1. Low-opacity hairline border — depth gestured at, not asserted.
              The nav uses border-outline-variant/12; we mirror that restraint.
           2. Frosted-glass depth — backdrop-blur + layered shadow like the nav pill.
              Shadow is soft and directional, not generic flat.
           3. Generous internal rhythm — spacing lifted from cramped 0.875rem
              to 1.0625rem vertical / 1.1875rem horizontal, closer to editorial
              paragraph breathing.
           4. Reduced radius — from 1.0625rem (chat-bubble pill) to 0.5rem
              (document-edge). The shape stops announcing itself.
           5. Colour identity shifts off the inset stripe onto the role-name
              and the subtle background tint. Stripe removed — too assertive.
           6. The companion at full measure — 96% rather than 88%, trusting the prose
              and placement to carry identity, not the box.
        ─── */
        .message {
          display: flex;
          flex-direction: column;
          gap: 0.4375rem;
          padding: 0.85rem 1.1rem 0.6rem;
          position: relative;
          max-width: 100%;
          overflow-wrap: break-word;
          margin: 0.25rem 0;
          border-radius: 12px;
          border: 1px solid transparent;
          transition:
            border-color var(--tx-base, 240ms var(--hearth-curve)),
            background var(--tx-base, 240ms var(--hearth-curve));
        }

        /* Companion — parchment, a touch lighter than the column, logo at its left */
        .message.companion {
          align-self: flex-start;
          width: auto;
          max-width: min(78%, 680px);
          margin-left: 0;
          margin-right: auto;
          /* Parchment with a little of the wall through it: the bubbles sit in the room, not on top of it. */
          background: var(--surface-companion);
          color: var(--surface-companion-text);
          -webkit-backdrop-filter: var(--surface-blur, none);
          backdrop-filter: var(--surface-blur, none);
          border-color: var(--companion-border, rgba(90, 65, 40, 0.14));
          box-shadow: 0 2px 8px rgba(20, 10, 5, 0.22);
        }
        .message.companion:hover {
          border-color: var(--border-hover, rgba(90, 65, 40, 0.28));
        }
        /* Avatar sits inline in the header, before the name (no side gutter). */
        .message-avatar {
          flex: 0 0 auto;
          align-self: center;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          object-fit: cover;
        }
        /* A custom photo avatar gets the rounded tile; the Sanctum mark does not. */
        .message-avatar.is-custom { border-radius: 50%; object-fit: cover; filter: none; }

        /* User — lavender bubble, ink #3b2f52, right-anchored */
        .message.user {
          align-self: flex-end;
          margin-left: auto;
          margin-right: 0;
          max-width: min(78%, 680px);
          background: var(--surface-user);
          -webkit-backdrop-filter: var(--surface-blur, none);
          backdrop-filter: var(--surface-blur, none);
          border-color: var(--user-border, rgba(109, 91, 147, 0.22));
          box-shadow: 0 2px 8px rgba(20, 10, 5, 0.2);
          color: var(--surface-user-text);
        }
        .message.user:hover {
          border-color: var(--border-hover, rgba(109, 91, 147, 0.4));
        }
        .message.user .message-content,
        .message.user .prose,
        .message.user .prose strong,
        .message.user .prose em,
        .message.user .prose blockquote { color: var(--surface-user-text); }
        .message.user .prose a { color: var(--surface-user-text); text-decoration-color: currentColor; }

        .message.deleted { font-style: italic; } /* the text is already muted; the bubble is not faded */

        /* ─── Attribution header ─── */
        .message-header {
          display: flex;
          align-items: baseline;
          gap: 0.625rem;
          margin-bottom: 0.0625rem;
        }

        /* Role name — Lora italic, sized up slightly, identity colour at full weight.
           This is the primary identity signal. The nav uses Cinzel for the wordmark
           and mono for nav links; here the serif italic is the warmth-equivalent. */
        .message-role {
          font-family: var(--font-serif, 'Lora', serif);
          font-weight: 500;
          font-size: 0.9375rem;
          flex-shrink: 0;
          text-transform: capitalize;
        }
        .companion .message-role { color: var(--text-primary, #2c231f); }
        .user .message-role { color: var(--surface-user-text, #3b2f52); }

        /* Timestamp — mono uppercase, wide tracking: the "infrastructure voice"
           The nav uses text-[11px] uppercase tracking-[0.18em] for all metadata.
           We mirror that here: quiet, precise, machine-voice.
           Resting at low opacity — surfaces on hover like nav secondary items. */
        .message-time {
          display: none; /* the time lives under the text (.bubble-ts), always visible */
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5625rem;
          text-transform: uppercase;
          letter-spacing: 0.14em;
          color: var(--text-muted, #6a6258);
          font-variant-numeric: tabular-nums;
          flex-shrink: 0;
          opacity: 0.45;
          transition: opacity var(--tx-fast, 150ms var(--hearth-curve));
        }
        /* Timestamp brightens on message hover */
        .message:hover .message-time { opacity: 0.72; }

        .message-edited {
          font-size: 0.5625rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
          text-transform: uppercase;
          letter-spacing: 0.10em;
        }

        .tools-toggle {
          margin-left: auto;
          font-size: 0.5rem;
          color: var(--text-muted);
          background: transparent;
          border: 1px solid rgba(201, 168, 124, 0.14);
          padding: 0.125rem 0.4375rem;
          border-radius: 0.1875rem;
          font-family: var(--font-mono);
          letter-spacing: 0.08em;
          text-transform: uppercase;
          cursor: pointer;
          transition: color var(--tx-fast), border-color var(--tx-fast);
        }
        .tools-toggle:hover {
          color: var(--amber-bright);
          border-color: rgba(201, 168, 124, 0.32);
        }

        /* ─── Message body ─── */
        .message-content {
          color: var(--text-primary, #e2dbd0);
          line-height: 1.65;
          word-wrap: break-word;
          overflow-wrap: break-word;
          min-width: 0;
          font-weight: 400;
          font-size: 1.0625rem;
          line-height: 1.5;
        }

        .deleted-text {
          font-style: italic;
          color: var(--text-muted);
          font-family: var(--font-serif);
          font-size: 0.875rem;
        }

        .streaming-cursor {
          display: inline-block;
          animation: cursorPulse 0.9s ease-in-out infinite;
          color: var(--amber, #c9a87c);
          margin-left: 0.125rem;
          opacity: 0.8;
        }
        @keyframes cursorPulse {
          0%, 100% { opacity: 0.8; }
          50% { opacity: 0.2; }
        }

        /* Stream-head: fade newly-revealed tail chars in softly.
           Opacity only — transforms cause layout shift mid-stream. */
        .stream-head {
          animation: streamFade 80ms ease-out both;
        }
        @keyframes streamFade {
          from { opacity: 0.2; }
          to   { opacity: 1; }
        }

        /* ─── Thinking blocks — amber ember collapsible ─── */
        .thinking-block {
          margin: 0.1875rem 0;
          font-size: 0.75rem;
        }
        .thinking-header {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.25rem 0.5rem;
          background: rgba(201, 168, 124, 0.05);
          border: 1px solid rgba(201, 168, 124, 0.12);
          color: var(--text-muted);
          font-size: 0.6875rem;
          font-family: var(--font-mono);
          cursor: pointer;
          text-align: left;
          border-radius: 0.375rem;
          width: 100%;
          transition: background var(--tx-fast, 240ms ease), border-color var(--tx-fast, 240ms ease);
        }
        .thinking-header:hover {
          background: rgba(201, 168, 124, 0.08);
          border-color: rgba(201, 168, 124, 0.22);
          color: var(--text-secondary);
        }
        .thinking-header svg { flex-shrink: 0; color: var(--amber-dim); }
        .thinking-summary {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text-secondary);
        }
        .thinking-chevron {
          flex-shrink: 0;
          font-size: 0.5625rem;
          color: var(--amber-dim);
        }
        .thinking-content {
          padding: 0.5rem 0.625rem;
          background: var(--surface-code);
          border: 1px solid rgba(201, 168, 124, 0.08);
          border-top: none;
          border-radius: 0 0 0.375rem 0.375rem;
          color: var(--text-muted);
          font-size: 0.6875rem;
          font-family: var(--font-mono);
          line-height: 1.5;
          max-height: 300px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
        }

        /* ─── Tool chips — warm, monochrome-bronze, not loud ─── */
        .tools-panel {
          display: flex;
          flex-direction: column;
          gap: 0.0625rem;
          padding: 0.375rem 0.5rem;
          background: var(--surface-code);
          border: 1px solid rgba(201, 168, 124, 0.08);
          border-radius: 0.625rem;
          margin-top: 0.125rem;
        }
        .tool-chip {
          display: flex;
          flex-direction: column;
        }
        .tool-chip.error .tool-name { color: var(--status-error-text); }
        .tool-chip-header {
          display: flex;
          align-items: center;
          gap: 0.3125rem;
          padding: 0.25rem 0.375rem;
          background: transparent;
          color: var(--text-muted);
          font-size: 0.6875rem;
          font-family: var(--font-mono);
          cursor: pointer;
          text-align: left;
          border-radius: 0.25rem;
          border: none;
          transition: background var(--tx-fast, 240ms ease);
          letter-spacing: 0.02em;
        }
        .tool-chip-header:hover:not(:disabled) { background: rgba(201, 168, 124, 0.05); }
        .tool-chip-header:disabled { cursor: default; }
        .tool-chevron {
          width: 0.75rem;
          text-align: center;
          font-size: 0.5625rem;
          flex-shrink: 0;
          color: var(--amber-dim);
        }
        /* tool name: warm bronze, not teal */
        .tool-name {
          color: var(--amber-dim, #a08960);
          white-space: nowrap;
          flex-shrink: 0;
        }
        .tool-input {
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 0.625rem;
        }
        .tool-error-badge {
          font-size: 0.5rem;
          color: var(--status-error-text);
          background: rgba(220, 140, 120, 0.12);
          padding: 0.0625rem 0.25rem;
          border-radius: 0.125rem;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .tool-elapsed {
          font-size: 0.5625rem;
          color: var(--text-muted);
          margin-left: auto;
          flex-shrink: 0;
        }
        .tool-output {
          margin: 0.1875rem 0 0.1875rem 1rem;
          padding: 0.5rem;
          background: var(--surface-code);
          border-radius: 0.25rem;
          color: var(--text-muted);
          font-size: 0.625rem;
          font-family: var(--font-mono);
          line-height: 1.4;
          max-height: 200px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .tool-spinner {
          width: 0.5625rem;
          height: 0.5625rem;
          border: 1.5px solid var(--amber-dim);
          border-top-color: transparent;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          flex-shrink: 0;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* ─── Reaction chips ─── */
        .reaction-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 0.25rem;
          margin-top: 0.25rem;
        }
        .reaction-chip {
          display: inline-flex;
          align-items: center;
          gap: 0.1875rem;
          padding: 0.1875rem 0.4375rem;
          border-radius: 99px;
          border: 1px solid rgba(201, 168, 124, 0.14);
          background: rgba(201, 168, 124, 0.05);
          font-size: 0.75rem;
          cursor: pointer;
          transition: background var(--tx-fast, 240ms ease), border-color var(--tx-fast, 240ms ease);
          color: var(--text-secondary);
        }
        .reaction-chip:hover {
          background: rgba(201, 168, 124, 0.12);
          border-color: rgba(201, 168, 124, 0.28);
        }
        .reaction-chip.mine {
          background: rgba(201, 168, 124, 0.14);
          border-color: rgba(201, 168, 124, 0.32);
        }
        .reaction-count {
          font-size: 0.625rem;
          font-family: var(--font-mono);
          color: var(--amber-dim, #a08960);
          font-weight: 500;
        }

        /* ─── Emoji picker ─── */
        .emoji-picker {
          position: absolute;
          bottom: calc(100% + 0.375rem);
          right: 0.5rem;
          z-index: 50;
          display: flex;
          gap: 0.125rem;
          padding: 0.375rem;
          background: var(--surface-popover, #faf4e5);
          border: 1px solid var(--surface-popover-border, rgba(201, 168, 124, 0.15));
          border-radius: 0.625rem;
          box-shadow: 0 8px 24px -4px rgba(20, 10, 5, 0.35);
          backdrop-filter: blur(12px);
        }
        .companion .emoji-picker { right: auto; left: 0.5rem; }
        .emoji-pick-btn {
          width: 2rem;
          height: 2rem;
          display: grid;
          place-items: center;
          font-size: 1.125rem;
          border-radius: 0.375rem;
          transition: background var(--tx-fast, 240ms ease), transform 140ms ease;
          cursor: pointer;
          border: none;
          background: transparent;
        }
        .emoji-pick-btn:hover {
          background: rgba(201, 168, 124, 0.10);
          transform: scale(1.2);
        }

        /* ─── Message action row ─── */
        .msg-action-row {
          display: flex;
          align-items: center;
          gap: 0.125rem;
          flex: 1;
        }
        .msg-action-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 1.5rem;
          height: 1.5rem;
          background: transparent;
          border: none;
          border-radius: 50%;
          color: var(--text-muted, #6a6258);
          cursor: pointer;
          transition: color var(--tx-fast, 240ms ease), background var(--tx-fast, 240ms ease), transform 140ms ease;
        }
        .msg-action-btn:hover {
          color: var(--amber, #c9a87c);
          background: rgba(201, 168, 124, 0.08);
        }
        .msg-action-btn.danger:hover {
          color: var(--status-error-text);
          background: rgba(220, 140, 120, 0.08);
        }
        .msg-action-btn:active {
          transform: scale(0.985) translateY(0.5px);
        }
        /* Copy / save flash — brief amber confirmation */
        .msg-action-btn.flashed {
          color: var(--amber, #c9a87c);
        }
        /* Regenerate in-flight — muted, shows spinner */
        .msg-action-btn.regenerating {
          color: var(--text-muted, #6a6258);
          cursor: wait;
          opacity: 0.7;
        }
        .msg-action-btn:disabled {
          cursor: wait;
          pointer-events: none;
        }
        /* Tiny spinner for regenerate in-flight */
        .action-spinner {
          display: block;
          width: 9px;
          height: 9px;
          border: 1.5px solid rgba(201, 168, 124, 0.25);
          border-top-color: var(--amber, #c9a87c);
          border-radius: 50%;
          animation: actionSpin 0.75s linear infinite;
        }
        @keyframes actionSpin { to { transform: rotate(360deg); } }

        /* ─── Inline edit ─── */
        .inline-edit {
          display: flex;
          flex-direction: column;
          gap: 0.375rem;
        }
        .inline-edit-ta {
          width: 100%;
          background: var(--surface-code);
          border: 1px solid rgba(201, 168, 124, 0.22);
          border-radius: 0.5rem;
          padding: 0.5rem 0.625rem;
          color: var(--text-primary, #e2dbd0);
          font-size: 0.9375rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          line-height: 1.55;
          resize: none;
          outline: none;
          min-height: 2rem;
          transition: border-color var(--tx-fast, 240ms ease);
        }
        .inline-edit-ta:focus {
          border-color: rgba(201, 168, 124, 0.45);
        }
        .inline-edit-actions {
          display: flex;
          gap: 0.375rem;
          justify-content: flex-end;
        }
        .ie-cancel {
          font-size: 0.75rem;
          font-family: var(--font-serif);
          font-style: italic;
          color: var(--text-muted);
          padding: 0.1875rem 0.5rem;
          border-radius: 0.25rem;
          background: transparent;
          border: none;
          cursor: pointer;
          transition: color var(--tx-fast, 240ms ease);
        }
        .ie-cancel:hover { color: var(--text-secondary); }
        .ie-save {
          font-size: 0.75rem;
          font-family: var(--font-body);
          color: var(--amber-bright, #e3c49a);
          background: rgba(201, 168, 124, 0.12);
          border: 1px solid rgba(201, 168, 124, 0.22);
          padding: 0.1875rem 0.625rem;
          border-radius: 0.25rem;
          cursor: pointer;
          transition: background var(--tx-fast, 240ms ease), border-color var(--tx-fast, 240ms ease);
        }
        .ie-save:hover {
          background: rgba(201, 168, 124, 0.20);
          border-color: rgba(201, 168, 124, 0.38);
        }
        .ie-save:disabled { background: var(--control-disabled-bg); color: var(--control-disabled-text); border-color: transparent; cursor: wait; }

        /* ─── Read-aloud footer row — hover-reveal with entrance lift ─── */
        .ral-row {
          display: flex;
          align-items: center;
          gap: 0.25rem;
          margin-top: 0.1875rem;
          min-height: 1.25rem;
        }
        /* The action buttons are invisible at rest and surface on hover;
           the timestamp (.bubble-ts) is always shown. */
        .ral-row > :not(.bubble-ts) {
          opacity: 0;
          transition: opacity 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }
        .message:hover .ral-row > :not(.bubble-ts),
        .message:focus-within .ral-row > :not(.bubble-ts) { opacity: 1; }

        /* Per-message timestamp — small, secondary ink, bottom right of the bubble */
        .bubble-ts {
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-size: 0.75rem;
          color: var(--text-secondary, #6b5d55);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          flex-shrink: 0;
          margin-left: auto;
          user-select: none;
        }
        .message.user .bubble-ts { color: var(--surface-user-meta, #5d5078); }

        /* The play/pause button — tiny, warm, unobtrusive */
        .ral-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 1.5rem;
          height: 1.5rem;
          background: transparent;
          border: none;
          border-radius: 50%;
          color: var(--text-muted, #6a6258);
          cursor: pointer;
          transition:
            color var(--tx-fast, 240ms ease),
            background var(--tx-fast, 240ms ease),
            transform 140ms ease;
        }
        .ral-btn:hover:not(:disabled) {
          color: var(--amber, #c9a87c);
          background: rgba(201, 168, 124, 0.08);
        }
        .ral-btn:active:not(:disabled) {
          transform: scale(0.985) translateY(0.5px);
        }
        /* Playing state — ember lit */
        .ral-btn.playing {
          color: var(--amber, #c9a87c);
        }
        .ral-btn.loading {
          cursor: wait;
        }
        .ral-btn:disabled {
          cursor: wait;
          opacity: 0.55;
        }

        /* Spinner for the loading state */
        .ral-spinner {
          display: block;
          width: 10px;
          height: 10px;
          border: 1.5px solid rgba(201, 168, 124, 0.3);
          border-top-color: var(--amber, #c9a87c);
          border-radius: 50%;
          animation: ralSpin 0.75s linear infinite;
        }
        @keyframes ralSpin { to { transform: rotate(360deg); } }

        /* ─── Attachment block ─── */
        .att-block {
          display: flex;
          flex-direction: column;
          gap: 0.375rem;
          margin-bottom: 0.25rem;
        }

        /* Image grid — 1 image: large; 2+: 2-column masonry-style */
        .att-image-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 0.25rem;
          border-radius: 0.625rem;
          overflow: hidden;
          max-width: 24rem;
        }
        .att-image-grid.single {
          grid-template-columns: 1fr;
          max-width: 18rem;
        }

        .att-thumb-btn {
          display: block;
          padding: 0;
          border: none;
          background: rgba(0, 0, 0, 0.35);
          cursor: zoom-in;
          overflow: hidden;
          border-radius: 0.375rem;
          transition: opacity var(--tx-fast, 240ms ease), transform 140ms ease;
          aspect-ratio: 1 / 1;
        }
        .att-thumb-btn:hover { opacity: 0.88; }
        .att-thumb-btn:active { transform: scale(0.97); }

        .att-thumb-img {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        /* Audio player — native <audio> controls, styled minimally */
        .att-audio {
          display: flex;
          flex-direction: column;
          gap: 0.1875rem;
        }
        .att-audio-el {
          /* Let the browser render native controls; style the container only */
          width: 100%;
          max-width: 22rem;
          height: 2.25rem;
          border-radius: 0.5rem;
          background: rgba(201, 168, 124, 0.06);
          border: 1px solid rgba(201, 168, 124, 0.14);
          /* accent-color applies to native track thumb in modern browsers */
          accent-color: var(--amber, #c9a87c);
        }
        .att-audio-label {
          font-size: 0.625rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          color: var(--text-muted, #6a6258);
          padding-left: 0.125rem;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 22rem;
        }

        /* File chip — compact link row */
        .att-file-chip {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.3125rem 0.625rem;
          background: rgba(201, 168, 124, 0.06);
          border: 1px solid rgba(201, 168, 124, 0.14);
          border-radius: 0.5rem;
          color: var(--text-secondary, #a09689);
          text-decoration: none;
          max-width: 22rem;
          transition:
            background var(--tx-fast, 240ms ease),
            border-color var(--tx-fast, 240ms ease),
            color var(--tx-fast, 240ms ease);
        }
        .att-file-chip:hover {
          background: rgba(201, 168, 124, 0.12);
          border-color: rgba(201, 168, 124, 0.26);
          color: var(--amber-bright, #e3c49a);
        }
        .att-file-chip svg { flex-shrink: 0; color: var(--amber-dim, #a08960); }
        .att-file-name {
          font-size: 0.75rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          min-width: 0;
        }

        /* ─── Lightbox ─── */
        .att-lightbox {
          position: fixed;
          inset: 0;
          z-index: 200;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .att-lightbox-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.88);
          border: none;
          cursor: zoom-out;
        }
        .att-lightbox-img {
          position: relative;
          z-index: 1;
          max-width: 90vw;
          max-height: 88vh;
          object-fit: contain;
          border-radius: 0.5rem;
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.75);
        }
        .att-lightbox-close {
          position: absolute;
          top: 1rem;
          right: 1rem;
          z-index: 2;
          width: 2.25rem;
          height: 2.25rem;
          display: grid;
          place-items: center;
          background: rgba(15, 14, 12, 0.80);
          border: 1px solid rgba(201, 168, 124, 0.18);
          border-radius: 50%;
          color: var(--text-secondary, #a09689);
          cursor: pointer;
          transition: background var(--tx-fast, 240ms ease), color var(--tx-fast, 240ms ease);
        }
        .att-lightbox-close:hover {
          background: rgba(30, 28, 25, 0.95);
          color: var(--amber, #c9a87c);
        }

        @media (max-width: 768px) {
          .message.companion, .message.user { max-width: 78%; }
          .tool-output { max-width: calc(100vw - 5rem); }
          /* Always show read-aloud on mobile (no hover) */
          .ral-row > :not(.bubble-ts) { opacity: 1; }
          .att-image-grid { max-width: 100%; }
          .att-image-grid.single { max-width: 100%; }
          .att-audio-el { max-width: 100%; }
          .att-file-chip { max-width: 100%; }
          .att-audio-label { max-width: 100%; }
        }
      `}</style>
    </article>
  );
}
