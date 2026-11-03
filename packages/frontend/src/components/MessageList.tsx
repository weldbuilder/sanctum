import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { Message, Canvas } from '@sanctum/shared';
import type { ToolEvent, ThinkingEvent, TimelineEntry } from '../store/chat';
import { MessageBubble } from './MessageBubble';
import { LiveThinkingAccordion } from './ThinkingAccordion';

interface StreamingInfo {
  messageId: string | null;
  tokens: string;
  /** Smoothed display text — drip-fed at a capped chars/frame rate. Read this for rendering. */
  displayedTokens?: string;
  toolEvents: ToolEvent[];
  thinkingEvents: ThinkingEvent[];
  timelineEntries?: TimelineEntry[];
}

interface Props {
  messages: Message[];
  toolEvents: Record<string, ToolEvent[]>;
  thinkingEvents: Record<string, ThinkingEvent[]>;
  streaming: StreamingInfo;
  presence: string;
  onReply?: (id: string, preview: string) => void;
  /** Whether to show the thinking timeline (from active thread's show_thinking). */
  showThinking?: boolean;
  /** Canvases belonging to the active thread — used to render artifact cards. */
  threadCanvases?: Canvas[];
  /** Called when user clicks an artifact card to open the panel. */
  onOpenCanvas?: (id: string) => void;
}

// Typing indicator — amber three-dot, Hearth-paced bounce
function TypingIndicator() {
  return (
    <div className="typing-indicator" role="status" aria-label="Companion is thinking">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
      <style>{`
        .typing-indicator {
          display: flex;
          align-items: center;
          gap: 0.3125rem;
          padding: 0.8125rem 1rem;
          margin: 0.1875rem 0;
          /* Mirror companion bubble look — amber-keyed glass */
          background: var(--companion-bg, rgba(201, 168, 124, 0.055));
          border: 1px solid var(--companion-border, rgba(201, 168, 124, 0.14));
          box-shadow: inset 3px 0 0 0 var(--companion-edge, rgba(201, 168, 124, 0.5));
          border-radius: 1.0625rem;
          align-self: flex-start;
          width: fit-content;
          backdrop-filter: blur(8px);
        }
        .typing-dot {
          width: 0.3rem;
          height: 0.3rem;
          background: var(--amber-dim, #a08960);
          border-radius: 50%;
          animation: typingBounce 1.6s infinite ease-in-out;
        }
        .typing-dot:nth-child(2) { animation-delay: 0.22s; }
        .typing-dot:nth-child(3) { animation-delay: 0.44s; }
        @keyframes typingBounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
          30% { transform: translateY(-0.3125rem); opacity: 0.9; }
        }
      `}</style>
    </div>
  );
}

const SCROLL_THRESHOLD = 120; // px from bottom to consider "at bottom"

export function MessageList({ messages, toolEvents, thinkingEvents, streaming, onReply, showThinking = true, threadCanvases = [], onOpenCanvas }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  // ─── Throttle auto-scroll during streaming ────────────────────────────────
  // scrollIntoView({smooth}) called on every token fires browser interrupts that
  // cause the visible jump. Cap to one scroll per ~200ms while streaming is live.
  const scrollThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Scroll-to-bottom button state ───────────────────────────────────────────
  const [scrolledUp, setScrolledUp] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  // The index into `messages` where the unread run starts (set when user is scrolled away
  // and new messages arrive; cleared when user returns to bottom).
  const unreadBoundaryRef = useRef<string | null>(null); // message.id of first unread
  const prevMessagesLengthRef = useRef(messages.length);

  // Track whether user has scrolled up
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const atBottom = scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
    shouldAutoScroll.current = atBottom;
    setScrolledUp(!atBottom);
    if (atBottom) {
      // User returned to bottom — clear the unread run
      setNewMessageCount(0);
      unreadBoundaryRef.current = null;
    }
  }, []);

  // When new messages arrive while user is scrolled away, count them and mark boundary
  useEffect(() => {
    const prevLen = prevMessagesLengthRef.current;
    const currLen = messages.length;
    if (currLen > prevLen && !shouldAutoScroll.current) {
      // Messages appended while scrolled up — first new one is the boundary
      if (unreadBoundaryRef.current === null && currLen > 0) {
        unreadBoundaryRef.current = messages[prevLen]?.id ?? null;
      }
      setNewMessageCount(c => c + (currLen - prevLen));
    }
    prevMessagesLengthRef.current = currLen;
  }, [messages]);

  // Auto-scroll to bottom when new messages arrive (not on every token).
  // Token-driven scroll is handled below via a throttled interval to avoid
  // the interrupted-smooth-scroll jump that fires on every network frame.
  useEffect(() => {
    if (shouldAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  // Throttled scroll during active streaming — at most once per 200ms.
  // One final scroll fires when streaming ends (messageId goes null).
  const isStreamingActive = streaming.messageId !== null;
  useEffect(() => {
    if (!shouldAutoScroll.current) return;
    if (isStreamingActive) {
      // If we're already throttled, skip
      if (scrollThrottleRef.current) return;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      scrollThrottleRef.current = setTimeout(() => {
        scrollThrottleRef.current = null;
      }, 200);
    } else {
      // Streaming just ended — clear any pending throttle and do a final scroll
      if (scrollThrottleRef.current) {
        clearTimeout(scrollThrottleRef.current);
        scrollThrottleRef.current = null;
      }
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreamingActive, streaming.displayedTokens]);

  // Jump to bottom handler
  const jumpToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setScrolledUp(false);
    setNewMessageCount(0);
    unreadBoundaryRef.current = null;
    shouldAutoScroll.current = true;
  }, []);

  const isActiveStreaming = streaming.messageId !== null;
  // Provider reasoning follows the thread's toggle; narration and tool calls always show (they were reply text / work).
  const liveEntries = (streaming.timelineEntries ?? []).filter(e => showThinking || e.kind === 'tool' || e.narration);

  // ─── Grouping: same-role runs collapse header/timestamp ──────────────────────
  // A message is "grouped" when the immediately preceding visible message has the
  // same role. System messages are excluded from the grouping logic.
  const grouped = new Set<string>();
  let prevRole: string | null = null;
  for (const msg of messages) {
    if (msg.role === 'system') { prevRole = null; continue; }
    if (prevRole !== null && msg.role === prevRole) {
      grouped.add(msg.id);
    }
    prevRole = msg.role;
  }

  // ─── Last companion message — for scoping the Regenerate button ──────────────
  // Walk backward to find the last non-deleted companion message.
  let lastCompanionId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'companion' && !msg.deleted_at) {
      lastCompanionId = msg.id;
      break;
    }
  }

  return (
    <div className="message-list-outer">
    <div className="message-list-container" ref={containerRef} onScroll={handleScroll}>
      <div className="message-list">
        {messages.length === 0 && !isActiveStreaming ? (
          <div className="empty-state">
            <p className="empty-state-text">the conversation begins here</p>
          </div>
        ) : (
          messages.map((msg, idx) => {
            // Find any canvases whose message_id links to this message
            const linkedCanvases = threadCanvases.filter(
              c => c.message_id === msg.id
            );
            const isUnreadBoundary = unreadBoundaryRef.current === msg.id;
            return (
              <React.Fragment key={msg.id}>
                {/* "new" divider — shown at the boundary where unread messages begin */}
                {isUnreadBoundary && (
                  <div className="new-messages-divider" aria-label="New messages">
                    <span className="new-divider-line" />
                    <span className="new-divider-label">new</span>
                    <span className="new-divider-line" />
                  </div>
                )}
                <div
                  id={`msg-${msg.id}`}
                  className={`message-row${grouped.has(msg.id) ? ' grouped' : ''}`}
                >
                  <MessageBubble
                    message={msg}
                    toolEvents={toolEvents[msg.id] ?? []}
                    thinkingEvents={thinkingEvents[msg.id] ?? []}
                    onReply={onReply}
                    suppressHeader={grouped.has(msg.id)}
                    showThinking={showThinking}
                    isLastCompanion={msg.id === lastCompanionId}
                    prevTimestamp={idx > 0 ? messages[idx - 1]?.created_at : undefined}
                  />
                  {/* Artifact cards — rendered below the message that created them */}
                  {linkedCanvases.length > 0 && (
                    <div className="artifact-cards">
                      {linkedCanvases.map(c => (
                        <button
                          key={c.id}
                          className="artifact-card"
                          onClick={() => onOpenCanvas?.(c.id)}
                          type="button"
                          aria-label={`Open canvas: ${c.title}`}
                        >
                          <svg className="artifact-card-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          <span className="artifact-card-title">{c.title}</span>
                          <span className="artifact-card-type">{c.content_type ?? 'markdown'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
          })
        )}

        {/* Streaming message */}
        {isActiveStreaming && (
          <div className="message-row">
            {streaming.tokens || liveEntries.length > 0 ? (
              <MessageBubble
                message={{
                  id: streaming.messageId!,
                  thread_id: '',
                  sequence: 0,
                  role: 'companion',
                  // Use smoothed displayedTokens for render — falls back to tokens
                  // (e.g. in the instant before the first drip frame fires).
                  content: streaming.displayedTokens ?? streaming.tokens,
                  content_type: 'text',
                  platform: 'web',
                  metadata: null,
                  reply_to_id: null,
                  reply_to_preview: null,
                  edited_at: null,
                  deleted_at: null,
                  original_content: null,
                  created_at: new Date().toISOString(),
                  delivered_at: null,
                  read_at: null,
                }}
                isStreaming
                streamTokens={streaming.displayedTokens ?? streaming.tokens}
                toolEvents={[]}
                thinkingEvents={[]}
                showThinking={false}
                liveEntries={liveEntries}
              />
            ) : (
              <TypingIndicator />
            )}
          </div>
        )}

        <div ref={bottomRef} className="scroll-sentinel" />
      </div>

      {/* Scroll-to-bottom floating button */}
      {scrolledUp && (
        <button
          className={`jump-to-bottom${newMessageCount > 0 ? ' has-new' : ''}`}
          onClick={jumpToBottom}
          aria-label={newMessageCount > 0 ? `Jump to latest — ${newMessageCount} new` : 'Jump to latest'}
          title={newMessageCount > 0 ? `${newMessageCount} new message${newMessageCount !== 1 ? 's' : ''}` : 'Jump to latest'}
          type="button"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
          {newMessageCount > 0 && (
            <span className="jump-count">{newMessageCount > 9 ? '9+' : newMessageCount} new</span>
          )}
        </button>
      )}
    </div>

      <style>{`
        .message-list-outer {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          position: relative;
        }
        .message-list-container {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          /* Transparent — the body gradient shows through */
          background: transparent;
        }
        .message-list {
          display: flex;
          flex-direction: column;
          /* Bottom padding ≈ composer height so last message clears the glass */
          padding: 1.5rem 1rem 5.5rem;
          min-height: 100%;
          max-width: none;
          margin: 0;
          width: 100%;
          gap: 0;
        }
        .message-row {
          width: 100%;
          min-width: 0;
          display: flex;
          flex-direction: column;
          /* Between runs — full gap */
          margin-top: 0.1875rem;
        }
        /* Within a same-sender run — tighter */
        .message-row.grouped {
          margin-top: 0.0625rem;
        }
        /* First message in list needs no top margin */
        .message-row:first-child {
          margin-top: 0;
        }
        /* Empty state — Lora italic, editorial */
        .empty-state {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-muted, #6a6258);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.9375rem;
          min-height: 40vh;
        }
        /* the line itself sits on its own opaque plate, never straight on the room */
        .empty-state-text {
          background: var(--chip-bg, transparent);
          color: var(--chip-text, var(--text-muted, #6a6258));
          padding: var(--chip-pad, 0);
          border-radius: 999px;
          text-shadow: var(--chip-shadow, none);
        }
        .scroll-sentinel {
          height: 1px;
          flex-shrink: 0;
        }
        /* ── Artifact cards — below the message that created them ── */
        .artifact-cards {
          display: flex;
          flex-wrap: wrap;
          gap: 0.3125rem;
          margin-top: 0.3125rem;
          padding: 0 0.125rem;
        }

        .artifact-card {
          display: inline-flex;
          align-items: center;
          gap: 0.3125rem;
          padding: 0.3125rem 0.625rem 0.3125rem 0.5rem;
          background: rgba(201, 168, 124, 0.06);
          border: 1px solid rgba(201, 168, 124, 0.14);
          border-radius: 0.5rem;
          cursor: pointer;
          text-decoration: none;
          transition:
            background 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            border-color 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            transform 100ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }

        .artifact-card:hover {
          background: rgba(201, 168, 124, 0.11);
          border-color: rgba(201, 168, 124, 0.26);
        }

        .artifact-card:active {
          transform: scale(0.985) translateY(0.5px);
        }

        .artifact-card-icon {
          color: var(--amber-dim, #a08960);
          flex-shrink: 0;
        }

        .artifact-card-title {
          font-size: 0.75rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          color: var(--text-secondary, #a09689);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 14rem;
        }

        .artifact-card:hover .artifact-card-title {
          color: var(--text-primary, #e2dbd0);
        }

        .artifact-card-type {
          font-size: 0.5625rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--amber, #c9a87c);
          background: rgba(201, 168, 124, 0.08);
          padding: 0.125rem 0.3rem;
          border-radius: 99px;
          flex-shrink: 0;
        }

        /* ── "new" messages divider ── */
        .new-messages-divider {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin: 0.625rem 0;
          padding: 0 0.125rem;
        }
        .new-divider-line {
          flex: 1;
          height: 1px;
          background: rgba(201, 168, 124, 0.28);
        }
        .new-divider-label {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.6875rem;
          color: var(--amber-dim, #a08960);
          letter-spacing: 0.04em;
          white-space: nowrap;
          flex-shrink: 0;
        }

        /* ── Scroll-to-bottom floating button ── */
        .jump-to-bottom {
          position: absolute;
          bottom: 1.25rem;
          right: 1.25rem;
          z-index: 20;
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          padding: 0.4375rem 0.625rem;
          background: var(--surface-popover, #faf4e5);
          border: 1px solid var(--control-border, rgba(201, 168, 124, 0.22));
          border-radius: 99px;
          color: var(--amber-dim, #a08960);
          cursor: pointer;
          backdrop-filter: blur(10px);
          box-shadow:
            0 2px 8px rgba(0, 0, 0, 0.35),
            0 0 0 1px rgba(0, 0, 0, 0.2);
          animation: jumpIn 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)) both;
          transition:
            color 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            border-color 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
            background 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }
        @keyframes jumpIn {
          from { opacity: 0; transform: translateY(6px) scale(0.95); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .jump-to-bottom:hover {
          color: var(--link, #6d5b93);
          border-color: var(--link, rgba(201, 168, 124, 0.45));
          background: var(--surface-panel, #f3ead7);
        }
        .jump-to-bottom:active {
          transform: scale(0.985) translateY(0.5px);
          transition: transform 100ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
        }
        .jump-to-bottom.has-new {
          border-color: rgba(201, 168, 124, 0.38);
          color: var(--amber, #c9a87c);
        }
        .jump-count {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.04em;
          color: inherit;
          flex-shrink: 0;
        }

        @media (max-width: 768px) {
          .message-list {
            /* Bottom padding must clear the floating composer (which also adds
               the home-indicator safe-area) — else the last message hides under
               the glass. Tighten the sides, keep the bottom generous. */
            padding: 0.75rem 0.75rem calc(6rem + env(safe-area-inset-bottom, 0px));
            max-width: 100%;
          }
          .jump-to-bottom {
            bottom: 0.875rem;
            right: 0.875rem;
          }
        }
      `}</style>
    </div>
  );
}
