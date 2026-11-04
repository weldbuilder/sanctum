// Inline expression tags: the companion writes `[image: a fox in snow]` or `[voice]` inside its reply and the backend acts on it,
// with no tool call, on every harness (Claude, Codex, dsh all assemble their reply in agent.ts _processQuery).
//
// This file is the registry and the parser; builtin.ts registers the real tags. Rules:
//   - every honoured tag in a reply runs (up to the tag's own cap); extras are stripped, never run
//   - a tag is removed wherever it stands; nothing but the tag (and one neighbouring space) is ever removed
//   - tags inside a code fence or an inline `code` span are prose, not tags, and are left alone
//   - a `[name` with no closing `]` (or a `]` past 300 characters or a newline) is not a tag and is left alone
//   - actions run after the reply is stored and broadcast, off the reply path; a failure is logged by tag name only
//   - the tag's argument (a prompt) is personal content: it is never logged above debug

export interface Tag {
  name: string;
  /** Text after the colon, trimmed. '' for `[voice]`. */
  arg: string;
  /** Offsets in the original text, [start, end). */
  start: number;
  end: number;
  /** false = stripped but not run (over the cap, not at the start for a start-only tag, or empty where an argument is required). */
  honoured: boolean;
}

export interface TagContext {
  threadId: string;
  /** The reply with every tag removed: what was stored. */
  text: string;
  /** Id of the stored companion message. */
  messageId: string;
  platform: string;
}

export interface TagDef {
  /** Is the capability behind the tag usable right now? Governs the instruction and whether the tag runs. */
  offered: () => boolean;
  run: (tag: Tag, ctx: TagContext) => Promise<void>;
  /** One-line syntax shown to the companion, only while offered(). */
  instruction: string;
  /** Honoured only at the very start of the reply (a voice note colours the whole reply). */
  startOnly?: boolean;
  /** At most this many honoured per reply (default 1). */
  max?: number;
  /** An empty argument is not an action. */
  requiresArg?: boolean;
}

const defs = new Map<string, TagDef>();

export function registerTag(name: string, def: TagDef): void { defs.set(name.toLowerCase(), def); }
export function getTagDef(name: string): TagDef | undefined { return defs.get(name.toLowerCase()); }
export function registeredTags(): string[] { return [...defs.keys()]; }
/** Test seam. */
export function clearTags(): void { defs.clear(); }

const MAX_TAG_LENGTH = 300;

type Match =
  | { kind: 'tag'; name: string; arg: string; end: number }
  | { kind: 'pending' }
  | { kind: 'none' };

function matchAt(text: string, i: number): Match {
  let j = i + 1;
  while (j < text.length && /[a-zA-Z]/.test(text[j])) j++;
  const partial = text.slice(i + 1, j).toLowerCase();
  if (j >= text.length) {
    return [...defs.keys()].some((n) => n.startsWith(partial)) ? { kind: 'pending' } : { kind: 'none' };
  }
  if (!partial || !defs.has(partial)) return { kind: 'none' };
  if (text[j] === ']') return { kind: 'tag', name: partial, arg: '', end: j + 1 };
  if (text[j] !== ':') return { kind: 'none' };
  for (let k = j + 1; k < text.length; k++) {
    const ch = text[k];
    if (ch === ']') return { kind: 'tag', name: partial, arg: text.slice(j + 1, k).trim(), end: k + 1 };
    if (ch === '\n' || ch === '[') return { kind: 'none' };
    if (k - i >= MAX_TAG_LENGTH) return { kind: 'none' };
  }
  return { kind: 'pending' };
}

export interface ScanResult {
  tags: Tag[];
  /** Index of a `[` at the end of the text that could still become a tag (streaming), or -1. */
  pending: number;
}

function scan(text: string): ScanResult {
  const tags: Tag[] = [];
  let pending = -1;
  let inFence = false;
  let i = 0;
  while (i < text.length) {
    const atLineStart = i === 0 || text[i - 1] === '\n';
    if (atLineStart) {
      const m = /^ {0,3}(```|~~~)/.exec(text.slice(i, i + 8));
      if (m) { inFence = !inFence; }
    }
    if (inFence) { const nl = text.indexOf('\n', i); if (nl === -1) break; i = nl + 1; continue; }
    const ch = text[i];
    if (ch === '`') {
      let run = 1; while (text[i + run] === '`') run++;
      const close = text.indexOf('`'.repeat(run), i + run);
      i = close === -1 ? i + run : close + run;
      continue;
    }
    if (ch === '[') {
      const m = matchAt(text, i);
      if (m.kind === 'tag') { tags.push({ name: m.name, arg: m.arg, start: i, end: m.end, honoured: false }); i = m.end; continue; }
      if (m.kind === 'pending') { pending = i; break; }
    }
    i++;
  }
  // Honour: per-tag cap, start-only, required argument.
  const counts = new Map<string, number>();
  for (const t of tags) {
    const def = defs.get(t.name)!;
    const n = counts.get(t.name) ?? 0;
    const atStart = text.slice(0, t.start).trim() === '';
    t.honoured = n < (def.max ?? 1) && (!def.startOnly || atStart) && (!def.requiresArg || t.arg !== '');
    if (t.honoured) counts.set(t.name, n + 1);
  }
  return { tags, pending };
}

export interface ParsedTags {
  clean: string;
  tags: Tag[];
  /** Original offset -> offset in `clean` (a removed character maps to where it was removed). */
  map: (originalOffset: number) => number;
}

/** Remove every tag from `text`. Only the tag and one neighbouring run of spaces is dropped. */
export function parseTags(text: string): ParsedTags {
  const { tags } = scan(text);
  if (tags.length === 0) return { clean: text, tags, map: (o) => o };
  const out: string[] = [];
  const keptRaw: number[] = [];
  const rawToClean: number[] = new Array(text.length + 1).fill(0);
  const drop = (rawIdx: number) => { rawToClean[rawIdx] = out.length; };
  const keep = (rawIdx: number) => { rawToClean[rawIdx] = out.length; out.push(text[rawIdx]); keptRaw.push(rawIdx); };
  const trimOutEnd = (re: RegExp) => {
    while (out.length && re.test(out[out.length - 1])) { out.pop(); const r = keptRaw.pop()!; rawToClean[r] = out.length; }
  };
  let pos = 0;
  for (const t of tags) {
    while (pos < t.start) keep(pos++);
    while (pos < t.end) drop(pos++);
    const outStr = out.join('');
    if (text.slice(pos).trim() === '') {
      // Nothing but whitespace follows: the tag was the end of the reply.
      trimOutEnd(/\s/);
      while (pos < text.length) drop(pos++);
    } else if (outStr.trim() === '') {
      trimOutEnd(/\s/);
      while (pos < text.length && /\s/.test(text[pos])) drop(pos++);
    } else if (/[ \t]$/.test(outStr)) {
      while (pos < text.length && /[ \t]/.test(text[pos])) drop(pos++);
      if (pos >= text.length || text[pos] === '\n') trimOutEnd(/[ \t]/);
    } else if (outStr.endsWith('\n') && text[pos] === '\n') {
      drop(pos++);
    }
  }
  while (pos < text.length) keep(pos++);
  rawToClean[text.length] = out.length;
  return { clean: out.join(''), tags, map: (o) => rawToClean[Math.max(0, Math.min(o, text.length))] };
}

/** What a client should see of a reply that is still arriving (the cumulative text): complete tags removed, and a trailing `[` that
 *  might still turn into a known tag held back until it closes (or proves not to be one). Unknown bracket text passes through. */
export function streamView(cumulative: string): string {
  const { pending } = scan(cumulative);
  const visible = pending === -1 ? cumulative : cumulative.slice(0, pending);
  // Trailing spaces wait for the next word: a tag that arrives next would have eaten one, and a view must only ever grow.
  return parseTags(visible).clean.replace(/[ \t]+$/, '');
}

/** Stateful form of streamView for a caller that is fed deltas. */
export class StreamTagFilter {
  private buf = '';
  /** Add a chunk; returns the whole visible text so far. */
  push(chunk: string): string { this.buf += chunk; return streamView(this.buf); }
  /** The reply is over: nothing is held back any more. */
  flush(): string { return parseTags(this.buf).clean; }
}

/** The "Expression" block for the companion's frame: only tags whose capability is usable now. '' when none are. */
export function expressionInstructions(): string {
  const lines: string[] = [];
  for (const def of defs.values()) {
    try { if (def.offered()) lines.push(`  ${def.instruction}`); } catch { /* an unreadable capability is not offered */ }
  }
  if (lines.length === 0) return '';
  return ['EXPRESSION (write these inside a reply, in your own words; the app acts on them and removes them from the text; never inside a code block):', ...lines].join('\n');
}

export interface RunOptions { platform: string; threadId: string; messageId: string; cleanText: string }

/** Run the honoured tags, off the reply path: returns at once, each action runs in the background and a failure is logged by tag name only. */
export function runTags(tags: Tag[], o: RunOptions): void {
  const todo = tags.filter((t) => t.honoured);
  const dropped = tags.length - todo.length;
  if (dropped > 0) console.debug(`[Tags] ${dropped} tag(s) stripped without running (over the cap, misplaced, or empty)`);
  if (todo.length === 0) return;
  const ctx: TagContext = { threadId: o.threadId, text: o.cleanText, messageId: o.messageId, platform: o.platform };
  // Side by side: an image can take a minute or more, and one slow action must not hold up another.
  for (const t of todo) {
    void (async () => {
      const def = defs.get(t.name);
      try {
        if (!def || !def.offered()) { console.debug(`[Tags] ${t.name}: not offered, stripped`); return; }
        await def.run(t, ctx);
      } catch (e) {
        console.warn(`[Tags] ${t.name} failed: ${e instanceof Error ? e.name : 'error'}`);
      }
    })();
  }
}
