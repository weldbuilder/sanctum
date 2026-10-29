// The history a turn is handed under rolling context, the same on either
// harness: the derived summary block, a notice for turns that did not fit,
// and the newest turns word for word. Fail-soft: a broken history source
// degrades this one message and says so in the prompt; it never blocks a turn.
import { getSanctumConfig } from '../config.js';
import { getRolling, type Rolling } from './rolling-context.js';
import { renderLine } from './rolling/theora-rolling-context.js';

export type HistoryTurn = { role: 'user' | 'assistant'; content: string };

/**
 * The message being answered is usually already saved in the thread, so it
 * must not also appear under "[Conversation so far]". What was saved can differ
 * from what the agent receives (a voice-tone prefix, trimmed whitespace), so
 * match loosely, and only among turns that have no reply yet. Anything
 * unanswered after it is a later, queued message and gets its own turn.
 */
export function withoutCurrentMessage<T extends HistoryTurn>(turns: T[], userContent: string, autonomous: boolean): T[] {
  if (autonomous) return turns; // wakes save no user message
  const current = userContent.trim();
  if (!current) return turns;
  let lastReply = -1;
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'assistant') { lastReply = i; break; }
  let match = -1;
  for (let i = turns.length - 1; i > lastReply; i--) {
    const saved = turns[i].content.trim();
    if (saved && (saved === current || current.includes(saved))) { match = i; break; }
  }
  return match < 0 ? turns : turns.slice(0, match);
}

export interface RollingHistory {
  /** The derived summary block, '' when the thread has no segments yet. */
  summary: string;
  /** A line for the prompt when turns were left out, '' otherwise. */
  notice: string;
  /** The newest turns, rendered `ROLE: text`, oldest first. */
  lines: string[];
  /** The rolling service, for the fold after the reply; null when history failed to load. */
  rolling: Rolling | null;
  /** Turns in the thread before the current message, and summaries covering the oldest of them. */
  turns: number;
  segments: number;
}

/** `force` assembles the history although rolling is switched off for the
 *  active provider: the one-time carry-over into a fresh session. */
export async function assembleRollingHistory(threadId: string, userContent: string, autonomous: boolean, opts?: { force?: boolean }): Promise<RollingHistory> {
  const rc = getSanctumConfig().agent.rolling;
  try {
    const rolling = getRolling();
    const turns = withoutCurrentMessage(await rolling.readTurns(threadId), userContent, autonomous);
    const serve = await rolling.readForServe(threadId, turns, { force: !!opts?.force });
    const tail = turns.slice(serve?.covered ?? 0);
    // Budget the verbatim tail: the newest turns that fit. The newest turn is
    // always kept, even when it alone is over budget.
    const kept: string[] = [];
    let chars = 0;
    for (let i = tail.length - 1; i >= 0 && kept.length < rc.history_max_turns; i--) {
      const line = renderLine(tail[i]);
      if (kept.length > 0 && chars + line.length + 1 > rc.history_max_chars) break;
      chars += line.length + 1;
      kept.unshift(line);
    }
    const dropped = tail.length - kept.length;
    return {
      summary: serve ? serve.render(dropped) : '',
      lines: kept,
      // Context loss is never silent: the model is told what it is not seeing.
      notice: dropped > 0
        ? `[${dropped} earlier turn${dropped === 1 ? '' : 's'} of this thread ${dropped === 1 ? 'is' : 'are'} not shown here: too much to fit in this message. The full history remains in the thread.]`
        : '',
      rolling,
      turns: turns.length,
      segments: serve?.segments ?? 0,
    };
  } catch (err: any) {
    console.error(`[rolling] history unavailable for thread ${threadId}; answering without it: ${err?.message ?? err}`);
    return {
      summary: '', lines: [], rolling: null, turns: 0, segments: 0,
      notice: '[The earlier conversation in this thread could not be loaded for this message. If continuity matters to the answer, say that you cannot see it right now.]',
    };
  }
}
