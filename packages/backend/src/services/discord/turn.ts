// One Discord turn: run the agent with the reply HELD, send it through the gate, and only then let
// the agent save it. A reply the gate withholds is discarded: it is never a companion message in the
// thread, never shown or pushed, and never handed to memory. The retry's note is appended to the
// rewrite prompt only; memory is told the user's original words, and only the reply that went out.

import type { AgentService, AgentImageInput, HeldReply } from '../agent.js';
import { replyWithRetry, type BlockInfo, type RetryOutcome } from './retry.js';
import type { Lane, SendResult } from './send.js';

export interface GatedTurnOptions {
  agent: Pick<AgentService, 'processMessage'>;
  threadId: string;
  /** The user's words, as they should be remembered. */
  content: string;
  /** What the model is asked, when it differs from `content`: the same words with mention tokens resolved to names. */
  promptContent?: string;
  /** Owner attachments (saved files) for the turn's filepath note; the rewrite carries the same ones. */
  images?: AgentImageInput[];
  threadMeta: { name: string; type: 'daily' | 'named' };
  platformContext: string;
  lane: Lane;
  /** Send through the gated path. */
  deliver: (text: string) => Promise<SendResult>;
  onBlock: (info: BlockInfo) => void | Promise<void>;
}

export async function runGatedTurn(o: GatedTurnOptions): Promise<RetryOutcome> {
  let held: HeldReply | null = null;

  const produce = async (note?: string): Promise<string> => {
    // A reply from an earlier attempt that was never settled is dropped before the next one starts.
    held?.discard();
    held = null;
    const text = await o.agent.processMessage(
      o.threadId,
      note ? `${o.promptContent ?? o.content}\n\n${note}` : (o.promptContent ?? o.content),
      o.threadMeta,
      {
        platform: 'discord',
        platformContext: o.platformContext,
        senderIsOwner: o.lane === 'owner',
        ...(o.images && o.images.length ? { images: o.images } : {}),
        hold: {
          userText: o.content,
          // Nothing public enters memory.
          ingest: o.lane === 'owner',
          onHeld: (r) => { held = r; },
        },
      },
    );
    return text;
  };

  const deliver = async (text: string): Promise<SendResult> => {
    let result: SendResult;
    try { result = await o.deliver(text); }
    catch (err) { held?.discard(); held = null; throw err; }
    const mine = held as HeldReply | null;
    held = null;
    if (result.sent) mine?.commit();
    else mine?.discard();
    return result;
  };

  try {
    return await replyWithRetry({ produce, deliver, onBlock: o.onBlock });
  } finally {
    // Whatever is still held (an empty answer, a failed turn) is never committed.
    (held as HeldReply | null)?.discard();
  }
}
