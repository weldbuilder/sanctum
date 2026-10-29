// The companion's one rewrite. When the gate blocks a reply for words or a name, the turn runs once
// more with the reason appended; a second block is silence and a log line. A block that a rewrite
// cannot fix (the lane is paused or off, the payload was refused, or the gate itself could not run) is not retried.

import type { SendResult } from './send.js';

export interface BlockInfo {
  /** 1 for the first answer, 2 for the rewrite. */
  attempt: 1 | 2;
  /** True when the turn is about to run again. */
  willRetry: boolean;
  result: SendResult;
}

export interface RetryOutcome {
  sent: boolean;
  /** How many times the turn ran. */
  attempts: number;
  /** The last send result, when one was tried. */
  final?: SendResult;
  /** The turn answered with nothing. */
  empty?: boolean;
}

/** The note appended to the rewrite turn. `hits` are what the companion needs to avoid. */
export function retryPrompt(hits: string[]): string {
  return `Your reply was not sent because it contained: ${hits.join(', ')}. Answer again without it.`;
}

/** The short system line for the owner thread. Entry names only: never what the reply said. */
export function withheldNotice(info: BlockInfo): string {
  const { result } = info;
  if (result.reason === 'gate_error') {
    return `A reply was withheld: the word gate could not run (${result.error || 'unknown reason'}). Nothing was sent.`;
  }
  if (result.reason === 'paused') return 'A reply was withheld: the public lane is paused. Nothing was sent.';
  if (result.reason === 'public_off') return 'A reply was withheld: the public lane is off. Nothing was sent.';
  if (result.reason === 'payload') return `A reply was withheld: its message options were not allowed (${result.error || 'unknown'}). Nothing was sent.`;
  const names = (result.entries && result.entries.length ? result.entries : result.hits || []).join(', ');
  const what = result.reason === 'name' ? 'a name on the real-name list' : result.reason === 'word_name' ? 'a word on the list and a name on the real-name list' : 'a word on the list';
  if (info.attempt === 1) {
    return `A reply was withheld: it contained ${what} (${names}). Asking for one rewrite.`;
  }
  return `A reply was withheld again: the rewrite still contained ${what} (${names}). Nothing was sent.`;
}

const isEmptyAnswer = (s: string) => !s || s.trim() === '' || s.trim() === '[No response]';

export async function replyWithRetry(opts: {
  /** Run the turn. `note` is set on the rewrite. */
  produce: (note?: string) => Promise<string>;
  /** Send through the gated path. */
  deliver: (text: string) => Promise<SendResult>;
  /** Told about every block, so the owner lane can post a system line and every lane can log. */
  onBlock: (info: BlockInfo) => void | Promise<void>;
}): Promise<RetryOutcome> {
  const first = await opts.produce(undefined);
  if (isEmptyAnswer(first)) return { sent: false, attempts: 1, empty: true };

  const r1 = await opts.deliver(first);
  if (r1.sent) return { sent: true, attempts: 1, final: r1 };

  const retryable = (r1.reason === 'word' || r1.reason === 'name' || r1.reason === 'word_name') && (r1.hits?.length ?? 0) > 0;
  await opts.onBlock({ attempt: 1, willRetry: retryable, result: r1 });
  if (!retryable) return { sent: false, attempts: 1, final: r1 };

  const second = await opts.produce(retryPrompt(r1.hits!));
  if (isEmptyAnswer(second)) return { sent: false, attempts: 2, final: r1, empty: true };

  const r2 = await opts.deliver(second);
  if (r2.sent) return { sent: true, attempts: 2, final: r2 };
  await opts.onBlock({ attempt: 2, willRetry: false, result: r2 });
  return { sent: false, attempts: 2, final: r2 };
}
