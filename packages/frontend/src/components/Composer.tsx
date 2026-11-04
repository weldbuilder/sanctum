import React, { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { VoiceRecorder } from './VoiceRecorder';
import { useChatStore } from '../store/chat';
import { UPDATE_REFUSED_NOTICE, mergeRefused, messagesPaused, useUpdateStore } from '../store/update';
import { useIdentity } from '../store/identity';
import type { CommandRegistryEntry } from '@sanctum/shared';
import { resolveEffectiveAttachments } from './attachmentUtils';
import type { PendingAttachment, PersistedAttachment } from './attachmentUtils';

// Re-export so existing consumers (ChatView) can keep importing from './Composer'.
export type { PendingAttachment };

// ─── BASE URL — match SettingsView ───────────────────────────────────────────
import { BASE, COMPANION_PREFIX, storageKey } from '../lib/base';
import { EXPLORE_PREFILL_KEY } from './onboarding/onboardingState';

function derivedContentType(mimeType: string): 'image' | 'audio' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

// ─── Draft persistence helpers ────────────────────────────────────────────────

function draftKey(threadId: string): string {
  return storageKey(`draft.${threadId}`);
}

export function saveDraft(threadId: string | null, text: string) {
  if (!threadId) return;
  try {
    if (text) {
      localStorage.setItem(draftKey(threadId), text);
    } else {
      localStorage.removeItem(draftKey(threadId));
    }
  } catch { /* ignore quota errors */ }
}

/** The one-time first message onboarding leaves (onboarding/onboardingState.ts EXPLORE_PREFILL_KEY), read once and cleared. */
export function takeOnboardingPrefill(): string {
  try {
    const v = sessionStorage.getItem(EXPLORE_PREFILL_KEY) ?? '';
    if (v) sessionStorage.removeItem(EXPLORE_PREFILL_KEY);
    return v;
  } catch { return ''; }
}

export function loadDraft(threadId: string | null): string {
  if (!threadId) return '';
  try {
    return localStorage.getItem(draftKey(threadId)) ?? '';
  } catch { return ''; }
}

function clearDraft(threadId: string | null) {
  if (!threadId) return;
  try { localStorage.removeItem(draftKey(threadId)); } catch { /* ignore */ }
}

// ─── Pending-attachment persistence ─────────────────────────────────────────────
// Mirrors draft persistence. Pending attachments are otherwise local-only useState,
// so ANY composer remount (notably the mobile photo-picker suspending the tab on
// resume) wipes them — the "chip appears then vanishes" bug. Persisted per-thread,
// the serializable subset only (the blob previewUrl is dropped; chips fall back to
// the server URL /api/files/<id>).
// PersistedAttachment is imported from ./attachmentUtils (Omit<PendingAttachment, 'previewUrl'>).

function attachKey(threadId: string): string {
  return storageKey(`attach.${threadId}`);
}

function saveAttachments(threadId: string | null, atts: PendingAttachment[]) {
  if (!threadId) return;
  try {
    if (atts.length > 0) {
      const slim: PersistedAttachment[] = atts.map(({ fileId, filename, contentType, url }) =>
        ({ fileId, filename, contentType, url }));
      localStorage.setItem(attachKey(threadId), JSON.stringify(slim));
    } else {
      localStorage.removeItem(attachKey(threadId));
    }
  } catch { /* ignore quota errors */ }
}

function loadAttachments(threadId: string | null): PendingAttachment[] {
  if (!threadId) return [];
  try {
    const raw = localStorage.getItem(attachKey(threadId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedAttachment[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(a => a && typeof a.fileId === 'string' && a.fileId.length > 0);
  } catch { return []; }
}

function clearAttachments(threadId: string | null) {
  if (!threadId) return;
  try { localStorage.removeItem(attachKey(threadId)); } catch { /* ignore */ }
}


// ─── Slash command filter ─────────────────────────────────────────────────────

function filterCommands(commands: CommandRegistryEntry[], query: string): CommandRegistryEntry[] {
  if (!query) return commands.slice(0, 12);
  const q = query.toLowerCase();
  return commands
    .filter(c => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
    .slice(0, 10);
}

// ─── Slash popup ──────────────────────────────────────────────────────────────

interface SlashPopupProps {
  commands: CommandRegistryEntry[];
  selected: number;
  onSelect: (cmd: CommandRegistryEntry) => void;
  onHover: (index: number) => void;
}

function SlashPopup({ commands, selected, onSelect, onHover }: SlashPopupProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-slash-index="${selected}"]`);
    if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (commands.length === 0) return null;

  return (
    <div className="slash-popup" role="listbox" aria-label="Commands" ref={listRef}>
      {commands.map((cmd, i) => {
        const isSel = i === selected;
        return (
          <button
            key={cmd.name}
            type="button"
            role="option"
            aria-selected={isSel}
            data-slash-index={i}
            className={`slash-item${isSel ? ' slash-item-sel' : ''}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={e => {
              // mousedown before blur so focus stays in textarea
              e.preventDefault();
              onSelect(cmd);
            }}
          >
            <span className="slash-name">/{cmd.name}</span>
            {cmd.args && <span className="slash-args">{cmd.args}</span>}
            <span className="slash-desc">{cmd.description}</span>
            {isSel && <span className="slash-enter" aria-hidden="true">↵</span>}
          </button>
        );
      })}

      <style>{`
        .slash-popup {
          position: absolute;
          bottom: calc(100% + 0.5rem);
          left: 0;
          right: 0;
          max-height: 17rem;
          overflow-y: auto;
          background: var(--bg-secondary, #131210);
          border: 1px solid rgba(201, 168, 124, 0.14);
          border-radius: var(--radius-card, 1.125rem);
          box-shadow:
            0 -8px 32px rgba(0, 0, 0, 0.45),
            0 0 0 1px rgba(0, 0, 0, 0.3);
          padding: 0.3125rem;
          animation: slashIn 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)) both;
          z-index: 200;
        }

        @keyframes slashIn {
          from { opacity: 0; transform: translateY(4px) scale(0.985); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        .slash-popup::-webkit-scrollbar { width: 4px; }
        .slash-popup::-webkit-scrollbar-track { background: transparent; }
        .slash-popup::-webkit-scrollbar-thumb {
          background: rgba(201, 168, 124, 0.15);
          border-radius: 2px;
        }

        .slash-item {
          display: flex;
          align-items: baseline;
          gap: 0.5rem;
          width: 100%;
          padding: 0.4375rem 0.625rem;
          border-radius: 0.625rem;
          background: transparent;
          border: none;
          cursor: pointer;
          text-align: left;
          color: var(--text-secondary, #a09689);
          position: relative;
          transition:
            background 120ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            color 120ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }

        .slash-item-sel {
          background: rgba(201, 168, 124, 0.10);
          color: var(--amber-bright, #e3c49a);
        }

        .slash-item-sel::before {
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

        .slash-name {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8rem;
          font-weight: 500;
          color: var(--amber, #c9a87c);
          flex-shrink: 0;
          letter-spacing: 0.01em;
        }

        .slash-args {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          flex-shrink: 0;
          font-style: italic;
        }

        .slash-desc {
          flex: 1;
          min-width: 0;
          font-size: 0.75rem;
          color: var(--text-muted, #6a6258);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .slash-item-sel .slash-desc {
          color: var(--text-secondary, #a09689);
        }

        .slash-enter {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          color: var(--amber, #c9a87c);
          flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  onSend: (content: string, attachments?: PendingAttachment[]) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled: boolean;
}

export function Composer({ onSend, onStop, isStreaming, disabled }: Props) {
  const { companion_name: companionName } = useIdentity();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [hasText, setHasText] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** "Updating; your message was not sent.": shown when an update is installing and the draft was kept. */
  const [pausedNotice, setPausedNotice] = useState<string | null>(null);
  const refusedDraft = useChatStore(s => s.refusedDraft);
  const clearRefusedDraft = useChatStore(s => s.clearRefusedDraft);

  // ─── Drag-over visual state ───────────────────────────────────────────────
  const [dragOver, setDragOver] = useState(false);

  // ─── Slash command state ──────────────────────────────────────────────────
  const [slashQuery, setSlashQuery] = useState<string | null>(null); // null = popup closed
  const [slashSelected, setSlashSelected] = useState(0);

  // Pull commands and store actions from the global store
  const commands = useChatStore(s => s.commands);
  const activeThreadId = useChatStore(s => s.activeThreadId);
  const send = useChatStore(s => s.send);

  // ─── Draft persistence ────────────────────────────────────────────────────
  // Track previous thread so we know when to save/restore
  const prevThreadIdRef = useRef<string | null>(null);
  const isFirstMountRef = useRef(true);
  // Onboarding's first message waits here until the composer is in a real thread (the first thread loads after the composer
  // mounts, and restoring its empty draft would wipe it), then goes in once, into an empty composer only.
  const prefillRef = useRef('');
  const applyPrefill = () => {
    const text = prefillRef.current;
    const el = textareaRef.current;
    if (!text || !el || el.value) return;
    el.value = text;
    autoResize();
    setHasText(true);
    el.focus();
    if (activeThreadId) prefillRef.current = '';
  };

  // On thread switch: save outgoing draft, restore incoming draft
  useEffect(() => {
    // Skip the very first run — we only want to restore, not save a blank outgoing
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      // Restore draft for the initial active thread
      if (activeThreadId) {
        const draft = loadDraft(activeThreadId);
        if (draft && textareaRef.current) {
          textareaRef.current.value = draft;
          autoResize();
          setHasText(draft.trim().length > 0);
        }
      }
      // Onboarding's "Explore more with <companion>": the first message, written for the person, once. They read it and send it.
      prefillRef.current = takeOnboardingPrefill();
      applyPrefill();
      // Restore any pending attachments persisted for this thread (survives remount)
      setAttachments(loadAttachments(activeThreadId));
      prevThreadIdRef.current = activeThreadId;
      return;
    }

    const prevId = prevThreadIdRef.current;
    prevThreadIdRef.current = activeThreadId;

    // Save the outgoing thread's draft
    if (prevId && prevId !== activeThreadId) {
      saveDraft(prevId, textareaRef.current?.value ?? '');
    }

    // Restore incoming thread's draft
    if (activeThreadId) {
      const draft = loadDraft(activeThreadId);
      if (textareaRef.current) {
        textareaRef.current.value = draft;
        autoResize();
        setHasText(draft.trim().length > 0);
        textareaRef.current.focus();
      }
    }
    applyPrefill();
    // Restore incoming thread's pending attachments
    setAttachments(loadAttachments(activeThreadId));
  }, [activeThreadId]);

  // ─── Slash filtered results ───────────────────────────────────────────────
  const slashResults = useMemo(() => {
    if (slashQuery === null) return [];
    return filterCommands(commands, slashQuery);
  }, [commands, slashQuery]);

  // Clamp selection when results change
  useEffect(() => {
    setSlashSelected(s => (slashResults.length ? Math.min(s, slashResults.length - 1) : 0));
  }, [slashResults.length]);

  // Auto-grow the textarea
  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // The server refused the last message because an update is installing: the text (and any attachments) come back to the box, never lost.
  useEffect(() => {
    if (!refusedDraft) return;
    const el = textareaRef.current;
    if (el) {
      // The person may already be typing the next draft: keep both (refused text first), and union the attachments.
      const merged = mergeRefused({ text: el.value, attachments }, refusedDraft);
      el.value = merged.text;
      saveDraft(activeThreadId, merged.text);
      setHasText(merged.text.trim().length > 0);
      autoResize();
      setAttachments(merged.attachments);
    }
    setPausedNotice(UPDATE_REFUSED_NOTICE);
    setTimeout(() => setPausedNotice(null), 8000);
    clearRefusedDraft();
  }, [refusedDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Detect slash trigger from current caret position ────────────────────
  function detectSlash(value: string): string | null {
    // Only trigger when the text starts with / (at position 0 or after only whitespace that's
    // at start of text — we match the simplest case: text begins with /)
    // We look at the word currently being typed at the caret.
    const el = textareaRef.current;
    if (!el) return null;
    const pos = el.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    // Find the start of the current word (no spaces)
    const wordMatch = before.match(/(?:^|\s)(\/\S*)$/);
    if (!wordMatch) return null;
    const word = wordMatch[1]; // e.g. "/clear" or "/"
    if (!word.startsWith('/')) return null;
    return word.slice(1); // return the query after /
  }

  const handleInput = useCallback(() => {
    autoResize();
    const el = textareaRef.current;
    if (!el) return;
    const value = el.value;
    setHasText(value.trim().length > 0);

    // Slash detection
    const query = detectSlash(value);
    if (query !== null) {
      setSlashQuery(query);
      setSlashSelected(0);
    } else {
      setSlashQuery(null);
    }
  }, []);

  // ─── Accept a slash command item ─────────────────────────────────────────
  const acceptSlashItem = useCallback((cmd: CommandRegistryEntry) => {
    const el = textareaRef.current;
    if (!el) return;
    // Replace the current /word with /<name> (plus trailing space for args)
    const pos = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, pos);
    const after = el.value.slice(pos);
    // Replace the leading /word at the cursor
    const replaced = before.replace(/(?:^|\s)(\/\S*)$/, (match, _word) => {
      // Preserve any leading whitespace from the match
      const leading = match.length - _word.length;
      return match.slice(0, leading) + `/${cmd.name} `;
    });
    el.value = replaced + after;
    // Put caret after the inserted text
    const newPos = replaced.length;
    el.setSelectionRange(newPos, newPos);
    autoResize();
    setHasText(el.value.trim().length > 0);
    setSlashQuery(null);
    el.focus();
  }, []);

  // ─── Parse and route command vs normal message ────────────────────────────
  function parseCommandText(text: string): { name: string; args: string } | null {
    const m = text.match(/^\/(\w[\w-]*)(?:\s+(.*))?$/s);
    if (!m) return null;
    return { name: m[1], args: (m[2] ?? '').trim() };
  }

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ── Slash popup keyboard navigation ──
    if (slashQuery !== null && slashResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelected(s => (s + 1) % slashResults.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelected(s => (s - 1 + slashResults.length) % slashResults.length);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashQuery(null);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const cmd = slashResults[slashSelected];
        if (cmd) acceptSlashItem(cmd);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      onStop();
    }
  }, [slashQuery, slashResults, slashSelected, acceptSlashItem, isStreaming, onStop]);

  function submit() {
    const el = textareaRef.current;
    if (!el) return;
    const raw = el.value;
    const content = raw.trim();

    // Robust attachment source: the React `attachments` state can be wiped between
    // upload and send (a remount — e.g. the mobile photo-picker suspending the tab —
    // empties local state; the chip "vanishes"). The per-thread persisted copy
    // survives that, so fall back to it. This is the actual send-side fix.
    const persisted = loadAttachments(activeThreadId);
    const effAtt = resolveEffectiveAttachments(attachments, persisted);

    // Allow send if there is text OR attachments
    if ((!content && effAtt.length === 0) || disabled) return;

    // ── Stop-and-steer: if generating and composer has text, stop first then send ──
    if (isStreaming && content) {
      send({ type: 'stop_generation' });
      // Small yield so the backend can process the abort before the new message arrives.
      // Try without delay first; if the backend misses the new message, add 80ms here.
      sendMessage(content, effAtt);
      return;
    }

    // ── Slash command routing (not active popup — final send parse) ──
    if (content.startsWith('/') && effAtt.length === 0) {
      const parsed = parseCommandText(content);
      if (parsed) {
        const known = commands.find(c => c.name === parsed.name);
        if (known) {
          send({ type: 'command', name: parsed.name, args: parsed.args || undefined, threadId: activeThreadId ?? undefined });
          clearDraft(activeThreadId);
          el.value = '';
          el.style.height = 'auto';
          setHasText(false);
          setSlashQuery(null);
          el.focus();
          return;
        }
        // Unknown /command — fall through to normal message
      }
    }

    sendMessage(content, effAtt);
  }

  function sendMessage(content: string, eff?: PendingAttachment[]) {
    const el = textareaRef.current;
    if (!el) return;
    // An update is installing: the app takes nothing in. Keep the draft and the attachments as they are, and say so.
    if (messagesPaused(useUpdateStore.getState().snapshot?.job)) {
      setPausedNotice(UPDATE_REFUSED_NOTICE);
      setTimeout(() => setPausedNotice(null), 8000);
      return;
    }
    const outAtt = (eff && eff.length > 0) ? eff : (attachments.length > 0 ? attachments : undefined);
    onSend(content, outAtt ? [...outAtt] : undefined);
    clearDraft(activeThreadId);
    clearAttachments(activeThreadId);
    // Revoke local preview URLs
    attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
    setAttachments([]);
    el.value = '';
    el.style.height = 'auto';
    setHasText(false);
    setSlashQuery(null);
    el.focus();
  }

  function handleStop(e: React.MouseEvent) {
    e.preventDefault();
    onStop();
  }

  // Called by VoiceRecorder when the backend returns a transcript.
  const handleTranscript = useCallback((text: string) => {
    const el = textareaRef.current;
    if (!el) return;
    el.value = text;
    autoResize();
    setHasText(text.trim().length > 0);
    setTimeout(() => {
      if (el.value.trim() || attachments.length > 0) submit();
    }, 120);
  }, [attachments]);

  // ─── Upload logic ─────────────────────────────────────────────────────────

  async function uploadFile(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${BASE}/api/files`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Upload failed' })) as { error?: string };
        throw new Error(errData.error ?? `Upload failed (${res.status})`);
      }
      const result = await res.json() as {
        fileId?: string;
        id?: string;
        filename?: string;
        name?: string;
        contentType?: 'image' | 'audio' | 'file';
        mimeType?: string;
        url?: string;
      };
      // Defensive: backend may use fileId or id
      const fileId = result.fileId ?? result.id ?? '';
      const filename = result.filename ?? result.name ?? file.name;
      // Derive contentType from backend or fall back to MIME detection
      let contentType: 'image' | 'audio' | 'file';
      if (result.contentType === 'image' || result.contentType === 'audio' || result.contentType === 'file') {
        contentType = result.contentType;
      } else {
        contentType = derivedContentType(result.mimeType ?? file.type);
      }
      const url = result.url ?? `${COMPANION_PREFIX}/api/files/${fileId}`;

      // Build a local preview for images so the thumb is instant
      const previewUrl = contentType === 'image' ? URL.createObjectURL(file) : undefined;

      setAttachments(prev => {
        const next = [...prev, { fileId, filename, contentType, url, previewUrl }];
        saveAttachments(activeThreadId, next);
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      setUploadError(msg);
      setTimeout(() => setUploadError(null), 5000);
    } finally {
      setUploading(false);
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files) {
      for (const file of files) {
        void uploadFile(file);
      }
    }
    e.target.value = '';
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function removeAttachment(index: number) {
    setAttachments(prev => {
      const removed = prev[index];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      const next = prev.filter((_, i) => i !== index);
      saveAttachments(activeThreadId, next);
      return next;
    });
  }

  // ─── Drag and drop ────────────────────────────────────────────────────────

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    // Only leave if departing the outer container
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files) {
      for (const file of files) {
        void uploadFile(file);
      }
    }
  }

  // ─── Paste images from clipboard ──────────────────────────────────────────

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) void uploadFile(file);
        return;
      }
    }
  }

  const canSend = hasText || attachments.length > 0;

  // ─── Action button logic ──────────────────────────────────────────────────
  // While streaming:
  //   - has text → Send (steer: stop + send)
  //   - empty    → Stop
  // While not streaming:
  //   - normal Send
  const showPopupOpen = slashQuery !== null && slashResults.length > 0;

  // Button mode for action area
  type ButtonMode = 'send' | 'stop' | 'steer';
  const buttonMode: ButtonMode = isStreaming
    ? (canSend ? 'steer' : 'stop')
    : 'send';

  return (
    <div
      className={`composer${dragOver ? ' drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {pausedNotice && (
        <div className="upload-error" role="status" data-testid="update-paused-notice">{pausedNotice}</div>
      )}

      {/* Upload error toast */}
      {uploadError && (
        <div className="upload-error" role="alert">{uploadError}</div>
      )}

      {/* Pending attachments strip */}
      {attachments.length > 0 && (
        <div className="attachment-strip">
          {attachments.map((att, i) => (
            <div key={att.fileId || i} className="attachment-chip">
              {att.contentType === 'image' ? (
                <img
                  src={att.previewUrl ?? `${BASE}/api/files/${att.fileId}`}
                  alt={att.filename}
                  className="attachment-thumb"
                  loading="lazy"
                />
              ) : att.contentType === 'audio' ? (
                <span className="attachment-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                  </svg>
                </span>
              ) : (
                <span className="attachment-icon" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                </span>
              )}
              <span className="attachment-label">{att.filename}</span>
              <button
                className="attachment-remove"
                onClick={() => removeAttachment(i)}
                aria-label={`Remove ${att.filename}`}
                type="button"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
          {/* Upload progress indicator when another upload is in flight */}
          {uploading && (
            <div className="attachment-chip uploading">
              <span className="upload-spinner" aria-hidden="true" />
              <span className="attachment-label">uploading…</span>
            </div>
          )}
        </div>
      )}

      {/* Composer inner — position: relative so popup can anchor to it */}
      <div className="composer-inner-wrap">
        {/* Slash popup — above the composer bar */}
        {showPopupOpen && (
          <SlashPopup
            commands={slashResults}
            selected={slashSelected}
            onSelect={acceptSlashItem}
            onHover={setSlashSelected}
          />
        )}

        <div className="composer-inner">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,audio/*,.pdf,.txt,.md,.json,.csv,.docx,.xlsx"
            multiple
            onChange={handleFileInputChange}
            hidden
            aria-hidden="true"
          />

          <textarea
            ref={textareaRef}
            className="composer-textarea"
            placeholder={`Message ${companionName}…`}
            rows={1}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            aria-label="Message input"
            aria-haspopup={showPopupOpen ? 'listbox' : undefined}
            aria-expanded={showPopupOpen}
            aria-autocomplete="list"
          />

          <div className="composer-actions">
            {/* Attach button — only hide during pure stop (not steer) */}
            {buttonMode !== 'stop' && (
              <button
                className={`composer-attach${uploading ? ' loading' : ''}`}
                onClick={openFilePicker}
                disabled={disabled || uploading}
                aria-label={uploading ? 'Uploading…' : 'Attach file'}
                title="Attach file"
                type="button"
              >
                {uploading ? (
                  <span className="upload-spinner small" aria-hidden="true" />
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                  </svg>
                )}
              </button>
            )}

            {/* Voice recorder — only when not in pure stop mode */}
            {buttonMode !== 'stop' && (
              <VoiceRecorder
                onTranscript={handleTranscript}
                disabled={disabled}
              />
            )}

            {buttonMode === 'stop' ? (
              /* Pure Stop — empty composer while generating */
              <button
                className="composer-stop"
                onClick={handleStop}
                aria-label="Stop generation (Esc)"
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="4" y="4" width="16" height="16" rx="2.5" />
                </svg>
              </button>
            ) : buttonMode === 'steer' ? (
              /* Steer Send — has text while generating: stop + redirect */
              <button
                className="composer-send steer ready"
                onClick={() => submit()}
                aria-label="Stop and send (redirect generation)"
                type="button"
              >
                {/* Arrow-up icon to signal "steer" vs normal send */}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5M5 12l7-7 7 7"/>
                </svg>
              </button>
            ) : (
              /* Normal Send — ember dot */
              <button
                className={`composer-send${canSend ? ' ready' : ''}`}
                onClick={() => submit()}
                aria-label="Send message"
                type="button"
                disabled={disabled}
              >
                <svg className="send-plane" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M21.4 3.3 2.9 10.6c-.8.3-.8 1.4 0 1.7l4.6 1.7 1.8 5.6c.2.7 1.1.9 1.6.4l2.5-2.6 4.6 3.4c.6.4 1.4.1 1.6-.6L22.5 4.4c.2-.8-.5-1.4-1.1-1.1Zm-3.6 4.6-8.3 7.1-.9 3-1.2-3.8 10.4-6.3Z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Drag overlay */}
      {dragOver && (
        <div className="drag-overlay" aria-hidden="true">
          <span className="drag-label">drop to attach</span>
        </div>
      )}

      <style>{`
        .composer {
          flex-shrink: 0;
          padding: 0.75rem 1rem 0.875rem;
          background: transparent;
          position: relative;
        }

        /* On mobile the composer is at the bottom of the absolute-positioned chat area
           (above the fixed bottom nav). No extra padding needed beyond nav space since
           the app-content already has padding-bottom for the nav. However when the
           keyboard raises, the viewport shrinks so the composer stays visible. */
        @media (max-width: 600px) {
          .composer {
            /* top/side padding unchanged; bottom grows by safe-area-inset-bottom
               so the composer clears the home indicator in standalone PWA mode.
               message-list already reserves env(safe-area-inset-bottom) in its
               own bottom padding, so messages never slide under the composer. */
            padding: 0.625rem 0.75rem calc(0.75rem + env(safe-area-inset-bottom, 0px));
          }
        }

        /* ─── Upload error ─── */
        .upload-error {
          max-width: 48rem;
          margin: 0 auto 0.375rem;
          padding: 0.375rem 0.75rem;
          font-size: 0.75rem;
          color: var(--status-error-text);
          background: rgba(192, 117, 109, 0.10);
          border: 1px solid rgba(192, 117, 109, 0.22);
          border-radius: 0.5rem;
          font-family: var(--font-body, 'Inter', sans-serif);
        }

        /* ─── Pending attachments strip ─── */
        .attachment-strip {
          display: flex;
          flex-wrap: wrap;
          gap: 0.375rem;
          max-width: 48rem;
          margin: 0 auto 0.5rem;
        }

        .attachment-chip {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.25rem 0.5rem 0.25rem 0.375rem;
          background: rgba(201, 168, 124, 0.07);
          border: 1px solid rgba(201, 168, 124, 0.18);
          border-radius: 0.5rem;
          max-width: 11rem;
          position: relative;
          overflow: hidden;
          flex-shrink: 0;
          transition: border-color var(--tx-fast, 240ms ease);
        }
        .attachment-chip.uploading {
        }

        .attachment-thumb {
          width: 2.25rem;
          height: 2.25rem;
          object-fit: cover;
          border-radius: 0.3125rem;
          flex-shrink: 0;
          display: block;
        }

        .attachment-icon {
          display: flex;
          align-items: center;
          color: var(--amber-dim, #a08960);
          flex-shrink: 0;
        }

        .attachment-label {
          font-size: 0.6875rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          color: var(--text-secondary, #a09689);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          min-width: 0;
        }

        .attachment-remove {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 1.125rem;
          height: 1.125rem;
          border-radius: 50%;
          background: rgba(0, 0, 0, 0.5);
          color: var(--text-muted, #6a6258);
          transition: background var(--tx-fast, 240ms ease), color var(--tx-fast, 240ms ease);
          cursor: pointer;
          border: none;
        }
        .attachment-remove:hover {
          background: rgba(192, 117, 109, 0.7);
          color: rgba(255, 255, 255, 0.9);
        }

        /* Upload spinner */
        .upload-spinner {
          display: block;
          width: 0.875rem;
          height: 0.875rem;
          border: 1.5px solid rgba(201, 168, 124, 0.25);
          border-top-color: var(--amber, #c9a87c);
          border-radius: 50%;
          animation: uploadSpin 0.75s linear infinite;
          flex-shrink: 0;
        }
        .upload-spinner.small {
          width: 0.75rem;
          height: 0.75rem;
        }
        @keyframes uploadSpin { to { transform: rotate(360deg); } }

        /* ─── Wrap for slash popup positioning ─── */
        .composer-inner-wrap {
          position: relative;
          max-width: 48rem;
          margin: 0 auto;
        }

        /* ─── Floating glass bar ─── */
        .composer-inner {
          display: flex;
          align-items: flex-end;
          gap: 0.5rem;
          background: rgba(15, 14, 12, 0.45);
          border: 1px solid rgba(201, 168, 124, 0.10);
          border-radius: 0.875rem;
          padding: 0.625rem 0.75rem;
          backdrop-filter: blur(16px) saturate(1.05);
          box-shadow:
            0 8px 28px -8px rgba(0, 0, 0, 0.55),
            0 0 0 1px rgba(201, 168, 124, 0.04);
          position: relative;
          transition: border-color 240ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
                      box-shadow 240ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }

        /* Bottom breath pulse */
        .composer-inner::after {
          content: '';
          position: absolute;
          bottom: -1px; left: 22%; right: 22%;
          height: 1px;
          background: linear-gradient(to right, transparent, var(--amber, #c9a87c), transparent);
          opacity: 0.18;
          animation: breath 6.5s ease-in-out infinite;
          pointer-events: none;
          border-radius: 999px;
        }

        /* Tight focus ring */
        .composer-inner:focus-within {
          border-color: rgba(201, 168, 124, 0.22);
          box-shadow:
            0 0 0 1px rgba(201, 168, 124, 0.12),
            0 8px 28px -8px rgba(0, 0, 0, 0.55);
        }

        /* Drag-over ring on outer composer */
        .composer.drag-over .composer-inner {
          border-color: rgba(201, 168, 124, 0.45);
          box-shadow:
            0 0 0 2px rgba(201, 168, 124, 0.18),
            0 0 40px -8px rgba(201, 168, 124, 0.22);
        }

        @keyframes breath {
          0%, 100% { opacity: 0.08; transform: scaleX(0.5); }
          50%       { opacity: 0.30; transform: scaleX(1); }
        }

        /* ─── Drag overlay ─── */
        .drag-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(12, 11, 9, 0.70);
          border-radius: 0.75rem;
          z-index: 10;
          pointer-events: none;
        }
        .drag-label {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.875rem;
          color: var(--amber, #c9a87c);
          letter-spacing: 0.02em;
          opacity: 0.85;
        }

        .composer-textarea {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: var(--text-primary, #e2dbd0);
          font-size: 0.9375rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-weight: 400;
          line-height: 1.55;
          resize: none;
          min-height: 1.55rem;
          max-height: 180px;
          overflow-y: auto;
          padding: 0;
        }
        .composer-textarea::placeholder {
          color: var(--text-muted, #6a6258);
          font-style: italic;
          font-family: var(--font-serif, 'Lora', serif);
        }
        /* iOS auto-zooms any focused input under 16px computed px. Our html base is
           15px, so 0.9375rem ≈ 14px triggers the zoom-on-focus. Force 16px on mobile
           to kill it — this is the only reliable threshold (1rem=15px still zooms). */
        @media (max-width: 600px) {
          .composer-textarea { font-size: 16px; }
        }

        .composer-actions {
          display: flex;
          align-items: center;
          gap: 0.25rem;
          flex-shrink: 0;
          padding-bottom: 0.125rem;
        }

        /* ─── Attach button ─── */
        .composer-attach {
          width: 2rem;
          height: 2rem;
          display: grid;
          place-items: center;
          background: transparent;
          border: none;
          cursor: pointer;
          border-radius: 999px;
          color: var(--amber-dim, #a08960);
          opacity: 0.45;
          transition:
            opacity 150ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            color 150ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            background 150ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }
        .composer-attach:hover:not(:disabled) {
          opacity: 1;
          color: var(--amber, #c9a87c);
          background: rgba(201, 168, 124, 0.08);
        }
        .composer-attach:disabled {
          cursor: not-allowed;
          opacity: 0.3;
        }
        .composer-attach:active:not(:disabled) {
          transform: scale(var(--press-scale, 0.985));
          transition: transform 140ms var(--hearth-curve, ease);
        }

        /* ─── Ember send ─── */
        .composer-send {
          width: 2rem;
          height: 2rem;
          display: grid;
          place-items: center;
          background: transparent;
          border: none;
          cursor: pointer;
          border-radius: 999px;
          position: relative;
          color: var(--text-muted, #6a6258);
          transition:
            color 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            background 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }
        .composer-send:disabled { cursor: not-allowed; opacity: 0.4; }

        /* Steer mode — arrow up, amber tint */
        .composer-send.steer {
          color: var(--amber, #c9a87c);
          background: rgba(201, 168, 124, 0.10);
          border-radius: 0.5rem;
          border: 1px solid rgba(201, 168, 124, 0.22);
          transition:
            background 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            border-color 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }
        .composer-send.steer:hover {
          background: rgba(201, 168, 124, 0.18);
          border-color: rgba(201, 168, 124, 0.35);
        }

        .ember-dot {
          display: block;
          width: 0.5rem;
          height: 0.5rem;
          border-radius: 999px;
          background: var(--amber-dim, #a08960);
          opacity: 0.45;
          transition:
            opacity var(--tx-slow, 560ms ease),
            background var(--tx-slow, 560ms ease),
            box-shadow var(--tx-slow, 560ms ease),
            transform var(--tx-slow, 560ms ease);
        }

        .composer-send.ready .ember-dot {
          background: var(--amber, #c9a87c);
          opacity: 1;
          box-shadow: 0 0 14px var(--amber-glow, rgba(201, 168, 124, 0.18)), 0 0 4px var(--amber, #c9a87c);
          animation: emberPulse 2.4s ease-in-out infinite alternate;
        }

        @keyframes emberPulse {
          from {
            opacity: 0.75;
            transform: scale(0.92);
            box-shadow: 0 0 6px var(--amber-glow, rgba(201, 168, 124, 0.18));
          }
          to {
            opacity: 1;
            transform: scale(1.06);
            box-shadow:
              0 0 20px var(--amber, #c9a87c),
              0 0 4px var(--amber-bright, #e3c49a);
          }
        }

        .composer-send:active {
          transform: scale(var(--press-scale, 0.985));
          transition: transform 140ms var(--hearth-curve, ease);
        }

        /* ─── Stop button ─── */
        .composer-stop {
          width: 2rem;
          height: 2rem;
          display: grid;
          place-items: center;
          background: var(--surface-input, rgba(192, 117, 109, 0.10));
          border: 1px solid var(--status-error-text);
          color: var(--status-error-text);
          border-radius: 0.5rem;
          cursor: pointer;
          animation: stopPulse 1.5s ease-in-out infinite;
          background-clip: padding-box;
          transition: background var(--tx-fast, 240ms ease), border-color var(--tx-fast, 240ms ease), transform 140ms ease;
        }
        .composer-stop:hover {
          background: var(--control-hover-bg, rgba(192, 117, 109, 0.18));
        }
        .composer-stop:active {
          transform: scale(var(--press-scale, 0.985));
          transition: transform 140ms var(--hearth-curve, ease);
        }

        /* The stop control stays fully opaque while it pulses: only its ring breathes. */
        @keyframes stopPulse {
          0%, 100% { box-shadow: 0 0 0 0 transparent; }
          50% { box-shadow: 0 0 0 3px var(--status-error-text); }
        }

        @media (max-width: 768px) {
          .composer { padding: 0.625rem 0.75rem 0.75rem; }
        }

        /* ─── Parchment pill: attach | message… mic (send) ─── */
        .composer-inner-wrap { max-width: none; }
        .composer-actions { display: contents; }
        .composer-inner {
          align-items: center;
          gap: 0.5rem;
          background: var(--composer-bg);
          border: 1px solid var(--composer-border);
          border-radius: 999px;
          padding: 0.5rem 0.6rem 0.5rem 0.75rem;
          backdrop-filter: none;
          box-shadow: 0 6px 20px rgba(20, 10, 5, 0.3);
        }
        .composer-inner::after { display: none; }
        .composer-inner:focus-within {
          border-color: var(--focus-ring, rgba(109, 91, 147, 0.55));
          box-shadow: 0 0 0 2px rgba(109, 91, 147, 0.2), 0 6px 20px rgba(20, 10, 5, 0.3);
          /* the ring, not the glow, is the focus cue */
          outline: 2px solid var(--focus-ring, #6d5b93);
          outline-offset: -4px; /* inside the pill, on the input surface, not out on the room */
        }
        .composer-attach {
          order: -1;
          width: 2.25rem;
          height: 2.25rem;
          opacity: 1;
          color: var(--surface-input-text, #6b5d55);
          padding-right: 0;
        }
        .composer-attach svg { width: 22px; height: 22px; }
        .composer-attach::after {
          content: '';
          position: absolute;
          right: -0.45rem;
          top: 15%;
          bottom: 15%;
          width: 1px;
          background: var(--composer-border);
        }
        .composer-attach { position: relative; margin-right: 0.5rem; }
        .composer-attach:hover:not(:disabled) { color: var(--link, #6d5b93); background: var(--bg-active, rgba(109, 91, 147, 0.1)); }
        .composer-textarea {
          order: 0;
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-size: 1.0625rem;
          color: var(--surface-input-text, #2c231f);
          align-self: center;
        }
        .composer-textarea::placeholder { font-style: normal; color: var(--surface-input-placeholder, #8a7c73); opacity: 1; }
        .vr-wrap { order: 1; }
        .vr-btn { color: var(--surface-input-text, #6b5d55); width: 2.25rem; height: 2.25rem; }
        .vr-btn svg { width: 22px; height: 22px; }
        .vr-btn:hover:not(:disabled) { color: var(--link, #6d5b93); background: var(--bg-active, rgba(109, 91, 147, 0.1)); }
        .composer-send,
        .composer-stop { order: 2; }
        .composer-send {
          width: 2.75rem;
          height: 2.75rem;
          background: var(--control-primary-bg, #6d5b93);
          color: var(--control-primary-text, #fff);
          border: 1px solid var(--control-primary-edge, transparent);
          box-shadow: 0 2px 6px rgba(40, 25, 60, 0.35);
        }
        .composer-send:hover:not(:disabled) { background: var(--control-primary-hover, #5d4c82); }
        .composer-send.steer {
          background: var(--control-primary-bg, #6d5b93);
          color: var(--control-primary-text, #fff);
          border: none;
          border-radius: 999px;
        }
        .composer-send.steer:hover { background: var(--control-primary-hover, #5d4c82); }
        /* Disabled is its own readable pair, never a faded copy of the enabled one. */
        .composer-send:disabled { opacity: 1; background: var(--control-disabled-bg); color: var(--control-disabled-text); box-shadow: none; }
        .send-plane { display: block; margin-left: -1px; }
        .attachment-chip { background: var(--surface-popover, rgba(250, 244, 229, 0.96)); }
        .attachment-label { color: var(--surface-popover-text, #2c231f); }
        .composer-attach:disabled, .vr-btn:disabled { opacity: 1; color: var(--surface-input-placeholder, #6a5d54); cursor: not-allowed; }

      `}</style>
    </div>
  );
}
