// Rolling thread context for the Codex path: the APP owns the history.
//
// Older turns of a thread are held as append-only summary SEGMENTS (sidecar
// JSON per thread). A fold summarizes only the oldest slice of the still-
// verbatim tail into one NEW segment; existing segments are never rewritten;
// past a cap the two OLDEST segments merge. The pure core (cut rule, prompts,
// fold/merge steps, cooldown) is the vendored theora-rolling-context.ts; this
// file is the wiring: storage, summarizer, trigger, serve shape.
//
// Rules:
//   - The summary is DERIVED context. Never authority over the identity files,
//     AGENTS.md, or the person's live words. The served block says so.
//   - No record / disabled = null from readForServe = history unchanged.
//   - Context loss is never silent: every fold and merge appends a system
//     marker message to the thread (visible in the room, never in model history).
//   - This module reaches the DB only through injected deps (or the lazy import
//     inside getRolling), so it loads and tests without better-sqlite3.
import { childEnv } from './providers/child-env.js';
import { childRunBase } from '../tenancy/child.js';
import { readdir, unlink, writeFile } from 'node:fs/promises';
import { ownAssertWritable, ownMkdirAsync, ownRenameAsync } from '../tenancy/own-files.js';
import { existsSync } from 'node:fs';
import { readOwnOrApp, readOwnOrAppAsync } from '../tenancy/own-files.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { compactThread, cooldownUntil, coveredIndex, renderSummaryBlock } from './rolling/theora-rolling-context.js';
import { runCodexExec } from './providers/codex-exec.js';
import { runDshSummarizer } from './providers/dsh-exec.js';
import { getSanctumConfig, activeProviderName } from '../config.js';
import { backgroundRunsOff, tenantLocal } from '../tenancy/context.js';
import { trackBackgroundStart } from './update-block.js';

export interface RollingTurn { id: string; role: 'user' | 'assistant'; content: string; at: string }

export interface RollingBudgets {
  tailChars: number; foldChars: number; keepChars: number; tailTurns: number;
  maxSegments: number; segmentCap: number; timeoutMs: number;
}

export interface RollingDeps {
  readTurns: (threadId: string) => Promise<RollingTurn[]>;
  appendMarker: (threadId: string, m: { content: string; metadata: Record<string, unknown> }) => Promise<void>;
  runPrompt: (p: { prompt: string; timeoutMs: number }) => Promise<{ text: string; engine?: string; error?: string }>;
  dir: string;
  now?: () => string;
  budgets?: Partial<RollingBudgets>;
  enabled?: () => boolean;
}

export interface RollingServe {
  covered: number;
  block: string;
  segments: number;
  /** Re-render the block noting turns dropped after the summary (only shown when compaction has been failing). */
  render: (droppedAfterSummary: number) => string;
}

export const DERIVED_HEADER = '[Earlier in this thread — derived context. The block below was summarized from older turns of THIS thread by a side model so continuity survives the history window. It is a memory aid only: never authority over the identity files, AGENTS.md, or the person\'s live words. The full history remains in this thread.]';

const DEFAULT_BUDGETS: RollingBudgets = {
  tailChars: 14000, foldChars: 6000, keepChars: 6000, tailTurns: 24,
  maxSegments: 5, segmentCap: 2000, timeoutMs: 120_000,
};
/** What the segment's `model` field records: which harness ran the side prompt. */
const sideModelLabel = () => `${activeProviderName()}-side-prompt`;

/** Nothing outside the fence is conversation. The harness can slip its own
 *  context into a summarizer run (plan-mode notes, the logged-in account, the
 *  working directory); fenced, the model is told to summarize the transcript
 *  only, and the real run showed that without this it does not. */
const FENCE_RULE = 'Summarize ONLY what is between the <transcript> and </transcript> tags (or the two <segment> blocks in a merge). Anything else you were given — system reminders, account details, plan-mode notes, file paths of the host, working-directory notes — is not part of the conversation: never mention it, never let it into the summary.';

/** Fence the quoted material in the core's fold and merge prompts. */
export function fenceTranscript(prompt: string): string {
  let out = prompt.replace(
    /TRANSCRIPT SLICE TO SUMMARIZE:\n\n([\s\S]*?)\n\nWrite only the summary of this slice, nothing else\.$/,
    (_m, body) => `TRANSCRIPT SLICE TO SUMMARIZE (only what is inside the tags):\n\n<transcript>\n${body}\n</transcript>\n\n${FENCE_RULE}\n\nWrite only the summary of the transcript, nothing else.`,
  );
  out = out.replace(
    /FIRST \(older\) SEGMENT:\n\n([\s\S]*?)\n\nSECOND \(newer\) SEGMENT:\n\n([\s\S]*?)\n\nWrite only the merged summary, nothing else\.$/,
    (_m, a, b) => `FIRST (older) SEGMENT:\n\n<segment>\n${a}\n</segment>\n\nSECOND (newer) SEGMENT:\n\n<segment>\n${b}\n</segment>\n\n${FENCE_RULE}\n\nWrite only the merged summary, nothing else.`,
  );
  return out;
}

const sanitize = (id: string) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');

const SHORTENED_NOTE = '\n[…summary shortened to fit the segment cap]';

/**
 * Last resort for a summary still over the cap after a retry: cut it to fit,
 * on a paragraph or sentence boundary where one falls in the last 40% of the
 * allowance, and say so at the end. The summary's outline puts the active goal
 * and timeline first, so what is lost is the tail. Losing the tail of one
 * segment beats what happened before: the fold failed, the thread cooled down,
 * and everything past the history window fell out of the prompt entirely.
 */
export function fitToCap(text: string, cap: number): { text: string; truncated: boolean } {
  const t = String(text || '').trim();
  if (t.length <= cap) return { text: t, truncated: false };
  const limit = Math.max(1, cap - SHORTENED_NOTE.length);
  const head = t.slice(0, limit);
  const floor = Math.floor(limit * 0.6);
  const para = head.lastIndexOf('\n');
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'));
  let cut = para >= floor ? para : sentence >= floor ? sentence + 1 : limit;
  // A hard cut must not split a surrogate pair (an emoji is two UTF-16 units).
  const last = head.charCodeAt(cut - 1);
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return { text: head.slice(0, cut).trimEnd() + SHORTENED_NOTE, truncated: true };
}

// The summary outline the core asks for (SUMMARY_RULES), as exact headers.
const H_ACTIVE = '## Active Goal';
const H_PREVIOUS = '## Previous Goals (completed or shifted away from)';
const H_TIMELINE = '## Timeline';
const H_STATE = '## Current State';
const H_DETAILS = '## Key Details';
const OMITTED_GOALS = '- (earlier goals omitted to fit the segment cap)';

/** Positions of every line that is exactly `header` (column 0, nothing after). */
function headerLines(lines: string[], header: string): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => { if (l.trimEnd() === header) out.push(i); });
  return out;
}
/** Positions of every line that starts with `header` at column 0 ("## Timeline (continued)" counts). */
function headerPrefixLines(lines: string[], header: string): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => { if (l.startsWith(header) && !/[A-Za-z0-9]/.test(l.charAt(header.length))) out.push(i); });
  return out;
}

/**
 * Shrink a summary to the cap by its least important parts first: collapse
 * Previous Goals, then drop Timeline steps oldest first. Active Goal, Current
 * State and Key Details are never touched. Only an exact vendor header that
 * comes before the Timeline counts as the Previous Goals section (a quoted
 * "## Previous Goals" inside Key Details is content); when the layout is
 * ambiguous, or this still does not fit, fall back to fitToCap.
 */
export function fitSectionsToCap(text: string, cap: number): { text: string; truncated: boolean; how: 'none' | 'sections' | 'truncate' } {
  const t = String(text || '').trim();
  if (t.length <= cap) return { text: t, truncated: false, how: 'none' };
  const lines = t.split('\n');
  const timelineAt = headerPrefixLines(lines, H_TIMELINE);
  const stateAt = headerPrefixLines(lines, H_STATE);
  const detailsAt = headerPrefixLines(lines, H_DETAILS);
  // Ambiguous layout: no single Timeline, or the sections after it are not single, in-order headers.
  const nextAfterTimeline = Math.min(...[...stateAt, ...detailsAt].filter((i) => i > (timelineAt[0] ?? -1)), lines.length);
  const ambiguous = timelineAt.length !== 1 || stateAt.length > 1 || detailsAt.length > 1
    || (stateAt.length === 1 && stateAt[0] < timelineAt[0]) || (detailsAt.length === 1 && detailsAt[0] < timelineAt[0]);
  if (ambiguous) {
    const f = fitToCap(t, cap);
    return { ...f, how: 'truncate' };
  }
  const tl = timelineAt[0];
  let work = lines.slice();

  // 1. Collapse Previous Goals: exactly one exact header before the Timeline,
  //    else leave it (two candidates means the layout is not what we think).
  const prevAt = headerLines(work, H_PREVIOUS).filter((i) => i < tl);
  if (prevAt.length === 1) {
    const start = prevAt[0] + 1;
    const end = tl; // the section runs to the Timeline header
    const body = work.slice(start, end);
    if (body.some((l) => l.trim() && l.trim() !== OMITTED_GOALS)) {
      work = [...work.slice(0, start), OMITTED_GOALS, '', ...work.slice(end)];
    }
    if (work.join('\n').length <= cap) return { text: work.join('\n'), truncated: true, how: 'sections' };
  }

  // 2. Drop Timeline steps, oldest first. Keep the lead-in and the newest step.
  //    Items are recognised at column 0 only (an indented "1." is a sub-point of
  //    the step above), and surviving steps keep their original numbers.
  const tl2 = headerPrefixLines(work, H_TIMELINE)[0];
  const end2 = Math.min(...[...headerPrefixLines(work, H_STATE), ...headerPrefixLines(work, H_DETAILS)].filter((i) => i > tl2), work.length);
  const body = work.slice(tl2 + 1, end2);
  const isNumbered = (l: string) => /^\d+[.)]\s/.test(l);
  const isBullet = (l: string) => /^[-*•]\s/.test(l);
  const firstItem = body.findIndex((l) => isNumbered(l) || isBullet(l));
  if (firstItem >= 0) {
    const numbered = isNumbered(body[firstItem]);
    const isItem = numbered ? isNumbered : isBullet;
    const leadIn = body.slice(0, firstItem);
    // Group each item with its continuation lines.
    const items: string[][] = [];
    for (const l of body.slice(firstItem)) {
      if (isItem(l) || !items.length) items.push([l]);
      else items[items.length - 1].push(l);
    }
    for (let dropped = 1; dropped < items.length; dropped++) {
      const kept = items.slice(dropped);
      const note = `${numbered ? '0.' : '-'} (${dropped} earlier step${dropped === 1 ? '' : 's'} omitted to fit the segment cap)`;
      const candidate = [...work.slice(0, tl2 + 1), ...leadIn, note, ...kept.flat(), ...work.slice(end2)];
      const joined = candidate.join('\n');
      if (joined.length <= cap) return { text: joined, truncated: true, how: 'sections' };
    }
  }

  const f = fitToCap(work.join('\n'), cap);
  return { ...f, how: 'truncate' };
}

// Where the vendor prompts switch from instructions to quoted material. The
// budget rules must land BEFORE the earliest of these, or the model reads them
// as part of the conversation (and, in a transcript, as the person's words).
const PROMPT_MARKERS = [
  'The conversation before this slice is already summarized',
  'TRANSCRIPT SLICE TO SUMMARIZE:',
  'FIRST (older) SEGMENT:',
];

/** Insert the budget rules as labelled housekeeping before the first quoted
 *  material. Uses the earliest marker across all known ones, so a marker that
 *  happens to be quoted inside the conversation cannot pull the rules into it. */
export function placeBudgetRules(prompt: string, rules: string): string {
  const block = `Budget (housekeeping, part of this request, not the conversation): ${rules}`;
  const positions = PROMPT_MARKERS.map((m) => prompt.indexOf(m)).filter((i) => i >= 0);
  if (!positions.length) return `${prompt}\n\n${block}`;
  const at = Math.min(...positions);
  return `${prompt.slice(0, at).trimEnd()}\n\n${block}\n\n${prompt.slice(at)}`;
}

export interface RollingThreadHealth {
  threadId: string;
  segments: number;
  coveredCount: number;
  updatedAt: string;
  failures: { count: number; lastAt: string; lastError: string } | null;
  cooldownUntil: string | null;
  /** The last thing that happened to this thread's summary was a failure. */
  failing: boolean;
  /** Nothing has ever been covered and folds keep failing: the thread is running on its tail alone. */
  stuck: boolean;
  /** Segments that had to be shortened to fit the cap. */
  truncated: number;
}

export interface RollingHealth {
  checkedAt: string;
  dir: string;
  threads: RollingThreadHealth[];
  totals: { threads: number; failing: number; stuck: number; truncated: number; segments: number };
}

const toMessages = (turns: RollingTurn[]) =>
  turns.map((t) => ({ id: t.id, role: t.role, content: t.content, createdAt: t.at || '' }));

const validRecord = (r: any) =>
  !!r && Array.isArray(r.segments) && r.segments.length > 0 && typeof r.coveredThroughMessageId === 'string'
  && r.segments.every((s: any) => typeof s?.text === 'string' && Number.isInteger(s?.coveredCount) && s.coveredCount > 0);

export function createRolling(deps: RollingDeps) {
  const b: RollingBudgets = { ...DEFAULT_BUDGETS, ...deps.budgets };
  const now = deps.now ?? (() => new Date().toISOString());
  const enabled = deps.enabled ?? (() => true);
  const failureClock = new Map<string, any>(); // first-ever-fold failures, before any sidecar exists
  const inflight = new Map<string, Promise<any>>();
  const pathFor = (id: string) => join(deps.dir, `${id}.json`);

  async function readSidecar(id: string): Promise<any> {
    try { return JSON.parse(await readOwnOrAppAsync(pathFor(id))); } catch { return null; }
  }

  async function writeSidecar(id: string, record: unknown): Promise<void> {
    const path = pathFor(id);
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await ownMkdirAsync(deps.dir, { recursive: true });
      ownAssertWritable(path); // (a tenant: the sidecar and the way to it are real, never a link)
      await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await ownRenameAsync(tmp, path);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  // The record as the core wants it; null when absent, malformed, or its cut no
  // longer resolves against the thread (never served, never extended).
  async function readRecord(id: string, turns: RollingTurn[]): Promise<any> {
    const record = await readSidecar(id);
    if (!validRecord(record)) return null;
    if (coveredIndex(toMessages(turns), record) < 0) {
      console.error(`[rolling] thread=${id} record no longer matches the thread (cut ${record.coveredThroughMessageId}); ignoring it`);
      return null;
    }
    return record;
  }

  // `force` reads the record although rolling is switched off: the one-time
  // carry-over into a fresh harness session after the switch (agent.ts).
  async function readForServe(threadId: string, turnsIn?: RollingTurn[], opts?: { force?: boolean }): Promise<RollingServe | null> {
    if (!enabled() && !opts?.force) return null;
    const id = sanitize(threadId);
    if (!id) return null;
    const turns = turnsIn ?? await deps.readTurns(threadId);
    const record = await readRecord(id, turns);
    if (!record) return null;
    const covered = coveredIndex(toMessages(turns), record) + 1;
    if (covered <= 0) return null;
    const render = (dropped: number) => `${DERIVED_HEADER}\n${renderSummaryBlock(record, { droppedAfterSummary: dropped })}`;
    return { covered, block: render(0), segments: record.segments.length, render };
  }

  function makeCoreDeps(threadId: string, id: string) {
    let engine = 'unknown';
    // What the last summarizer call had to do to fit the cap; read by the fold
    // marker so a retried or shortened summary is announced, never silent.
    let lastFit: { retried: boolean; truncated: boolean; originalChars: number; how: 'none' | 'sections' | 'truncate' } = { retried: false, truncated: false, originalChars: 0, how: 'none' };
    const marker = async (content: string, metadata: Record<string, unknown>) => {
      try { await deps.appendMarker(threadId, { content, metadata }); }
      catch (err: any) { console.error(`[rolling] marker append failed thread=${id}: ${err?.message ?? err}`); }
    };
    return {
      failureClock,
      readThread: async () => ({ id, agentId: 'companion', kind: 'thread', messages: toMessages(await deps.readTurns(threadId)) }),
      readRolling: async () => {
        const record = await readRecord(id, await deps.readTurns(threadId));
        if (record) return record;
        // failures-only sidecar keeps the cooldown durable before the first segment lands
        const raw = await readSidecar(id);
        if (raw?.failures && !raw.segments?.length) {
          return { segments: [], coveredThroughMessageId: '', coveredThroughAt: '', coveredCount: 0, updatedAt: raw.updatedAt || '', failures: raw.failures };
        }
        return null;
      },
      writeRolling: async (_t: string, record: any) => {
        const before = await readSidecar(id);
        const prev = Array.isArray(before?.segments) ? before.segments.length : 0;
        const next = record.segments.length;
        // A shortened summary is marked in the sidecar too, so the health scan can
        // count it: the newest segment after a fold, the merged one (segments[0])
        // after a merge.
        const isMerge = next < prev && next === prev - 1 && record.coveredThroughMessageId === before?.coveredThroughMessageId;
        if (lastFit.truncated && (next > prev || isMerge)) {
          const at = next > prev ? next - 1 : 0;
          record.segments[at] = { ...record.segments[at], truncated: true, truncatedHow: lastFit.how, originalChars: lastFit.originalChars };
        }
        await writeSidecar(id, record);
        const at = now();
        if (next > prev) {
          const seg = record.segments[next - 1];
          const fit = lastFit.truncated
            ? (lastFit.how === 'sections'
              ? ` The summary came back over the ${b.segmentCap}-character cap twice (${lastFit.originalChars} characters) and was shortened to fit by collapsing earlier goals and the oldest timeline steps; the active goal, current state and key details are intact.`
              : ` The summary came back over the ${b.segmentCap}-character cap twice (${lastFit.originalChars} characters) and was shortened to fit; its ending is lost.`)
            : lastFit.retried ? ' The first summary was over the cap; the retry fit.' : '';
          await marker(
            `[context folded — ${seg.coveredCount} earlier turn${seg.coveredCount === 1 ? '' : 's'} summarized into rolling segment ${next} at ${at} (${record.coveredCount} turns covered by ${next} segment${next === 1 ? '' : 's'}; engine ${engine}).${fit} Earlier segments are unchanged; full history remains in this thread.]`,
            { kind: 'rolling_fold', folded_turns: seg.coveredCount, covered_turns: record.coveredCount, segments: next, engine, retried: lastFit.retried, truncated: lastFit.truncated, ...(lastFit.truncated ? { original_chars: lastFit.originalChars, truncated_how: lastFit.how } : {}) },
          );
        } else if (next < prev && !(next === prev - 1 && record.coveredThroughMessageId === before?.coveredThroughMessageId)) {
          // Not a merge. The old summaries pointed at a message that is gone
          // (deleted, or removed by a regenerate), so they could not be trusted
          // or extended and the thread was summarized again from the start.
          // Say exactly that; calling it a merge would be false.
          await marker(
            `[context rebuilt — a message the earlier summaries depended on is no longer in this thread, so the ${prev} earlier summar${prev === 1 ? 'y was' : 'ies were'} discarded and older turns were summarized again from the start at ${at} (${record.coveredCount} turns covered by ${next} segment${next === 1 ? '' : 's'}; engine ${engine}). Full history remains in this thread.]`,
            { kind: 'rolling_reset', covered_turns: record.coveredCount, segments: next, previous_segments: prev, engine },
          );
        } else if (next < prev) {
          const seg = record.segments[0];
          const fit = lastFit.truncated ? ` The merged summary came back over the ${b.segmentCap}-character cap twice (${lastFit.originalChars} characters) and was shortened to fit.` : '';
          await marker(
            `[context merged — the two oldest rolling segments became one (gen ${seg.generation}, ${seg.coveredCount} turns) at ${at}; ${next} segment${next === 1 ? '' : 's'} remain, the rest unchanged.${fit} Full history remains in this thread.]`,
            { kind: 'rolling_merge', covered_turns: record.coveredCount, segments: next, generation: seg.generation, engine, truncated: lastFit.truncated, ...(lastFit.truncated ? { original_chars: lastFit.originalChars, truncated_how: lastFit.how } : {}) },
          );
        }
      },
      chooseModels: () => [sideModelLabel()],
      // A hard failure throws (the core records it + starts the cooldown). A
      // summary over the cap is NOT a failure any more: it used to be, and a
      // model that ran long every time meant every fold failed, the thread sat
      // in cooldown, and everything past the history window left the prompt.
      // Now: retry once with the overage spelled out, then shorten to fit.
      runPrompt: async ({ prompt }: { prompt: string }) => {
        const rules = `Budget overrides the outline above: aim for ${Math.floor(b.segmentCap * 0.6)} characters, with a hard maximum of ${b.segmentCap} characters. State each fact only once; omit empty or redundant sections and compress the timeline. Preserve who said what: keep the person's corrections and reserved decisions distinct from the assistant's suggestions, and never turn a suggestion into approval.`;
        lastFit = { retried: false, truncated: false, originalChars: 0, how: 'none' };
        const ask = async (p: string) => {
          const result = await deps.runPrompt({ prompt: p, timeoutMs: b.timeoutMs });
          if (result?.error) throw new Error(result.error);
          engine = result?.engine || engine;
          return String(result?.text || '').trim();
        };
        let text = await ask(fenceTranscript(placeBudgetRules(prompt, rules)));
        if (text.length > b.segmentCap) {
          lastFit.retried = true;
          lastFit.originalChars = text.length;
          const tighter = `${rules} Your previous attempt was ${text.length} characters, over the hard maximum of ${b.segmentCap}. Write it again at no more than ${Math.floor(b.segmentCap * 0.7)} characters: drop the least important details first, keep decisions, corrections and the current state.`;
          // A retry that throws must not lose the first attempt: shorten that instead.
          let shorter = '';
          try { shorter = await ask(fenceTranscript(placeBudgetRules(prompt, tighter))); }
          catch (err: any) { console.warn(`[rolling-context] thread=${id} retry failed (${err?.message ?? err}); shortening the first attempt`); }
          if (shorter && shorter.length <= text.length) text = shorter;
          console.log(`[rolling-context] thread=${id} summary over cap (${lastFit.originalChars} > ${b.segmentCap}); retry returned ${shorter.length || 'nothing'}`);
        }
        if (text.length > b.segmentCap) {
          const fit = fitSectionsToCap(text, b.segmentCap);
          lastFit.truncated = true;
          lastFit.how = fit.how;
          lastFit.originalChars = Math.max(lastFit.originalChars, text.length);
          console.warn(`[rolling-context] thread=${id} summary still over cap after retry (${text.length}); shortened to ${fit.text.length} by ${fit.how}`);
          text = fit.text;
        }
        return text;
      },
      now: () => new Date(now()),
      log: (line: string) => console.log(`[rolling-context] ${line}`),
      foldChars: b.foldChars, keepChars: b.keepChars, tailChars: b.tailChars, maxSegments: b.maxSegments,
    };
  }

  async function runCompaction(threadId: string, id: string): Promise<any> {
    const turns = await deps.readTurns(threadId);
    if (!turns.length) return { status: 'skipped', folds: 0, merges: 0, detail: 'empty thread' };
    const core = makeCoreDeps(threadId, id);
    // Turn-count trigger: fires one fold step regardless of chars (keep fence still holds).
    const record = await core.readRolling();
    const messages = toMessages(turns);
    const coveredCount = record?.segments?.length ? coveredIndex(messages, record) + 1 : 0;
    let effective: any = core;
    if (turns.length - coveredCount > b.tailTurns) {
      const lineChars = (t: RollingTurn) => t.role.length + 2 + t.content.length;
      const tail = turns.slice(coveredCount);
      const keepTurns = Math.max(1, Math.floor(b.tailTurns / 2));
      const keepChars = tail.slice(-keepTurns).reduce((s, t) => s + lineChars(t), 0);
      const foldChars = tail.slice(0, tail.length - keepTurns).reduce((s, t) => s + lineChars(t), 0);
      effective = { ...core, tailChars: 1, maxFoldSteps: 1, keepChars: Math.max(1, keepChars), foldChars: Math.max(1, foldChars) };
    }
    const outcome = await compactThread(id, effective);
    // The core keeps first-failure cooldowns in memory when no record exists; persist it.
    if (outcome.status === 'failed' && !record) {
      const failures = failureClock.get(id);
      if (failures) await writeSidecar(id, { segments: [], coveredThroughMessageId: '', coveredThroughAt: '', coveredCount: 0, updatedAt: now(), failures });
    }
    // Context loss is never silent: the first failure of a streak leaves a
    // note in the thread. Later ones in the same streak are throttled by the
    // cooldown and would only repeat it; the next successful fold says so itself.
    if (outcome.status === 'failed') {
      const failures = (await readSidecar(id))?.failures ?? failureClock.get(id);
      if (failures?.count === 1) {
        const until = cooldownUntil(failures);
        try {
          await deps.appendMarker(threadId, {
            content: `[context fold failed at ${now()} — ${String(failures.lastError || outcome.detail || 'unknown error').slice(0, 200)}. Older turns past the history window are not in the prompt until a fold succeeds; the next try is after ${new Date(until).toISOString()}. Full history remains in this thread.]`,
            metadata: { kind: 'rolling_fold_failed', error: String(failures.lastError || '').slice(0, 500), cooldown_until: new Date(until).toISOString() },
          });
        } catch (err: any) {
          console.error(`[rolling] marker append failed thread=${id}: ${err?.message ?? err}`);
        }
      }
    }
    return outcome;
  }

  /** Every thread's summary state, from the sidecars on disk. Never throws. */
  async function health(): Promise<RollingHealth> {
    const checkedAt = now();
    const threads: RollingThreadHealth[] = [];
    let names: string[] = [];
    try { names = (await readdir(deps.dir)).filter((n) => n.endsWith('.json')).sort(); } catch { /* no dir yet */ }
    for (const name of names) {
      const threadId = name.slice(0, -5);
      const raw = await readSidecar(threadId);
      if (!raw) continue;
      const segments = Array.isArray(raw.segments) ? raw.segments.length : 0;
      const failures = raw.failures ?? null;
      const lastSuccess = segments ? Date.parse(raw.updatedAt || '') || 0 : 0;
      const lastFailure = failures ? Date.parse(failures.lastAt || '') || 0 : 0;
      const failing = !!failures && lastFailure >= lastSuccess;
      const stuck = segments === 0 && !!failures && failures.count >= 3;
      const truncated = (Array.isArray(raw.segments) ? raw.segments : []).filter((s: any) => s?.truncated).length;
      const until = failures ? cooldownUntil(failures) : 0;
      threads.push({
        threadId, segments, coveredCount: raw.coveredCount ?? 0, updatedAt: raw.updatedAt || '',
        failures, cooldownUntil: until && until > Date.parse(checkedAt) ? new Date(until).toISOString() : null, failing, stuck, truncated,
      });
    }
    return {
      checkedAt, dir: deps.dir, threads,
      totals: {
        threads: threads.length,
        failing: threads.filter((t) => t.failing).length,
        stuck: threads.filter((t) => t.stuck).length,
        truncated: threads.reduce((s, t) => s + t.truncated, 0),
        segments: threads.reduce((s, t) => s + t.segments, 0),
      },
    };
  }

  // One compaction per thread at a time; concurrent triggers share the run. Never rejects.
  function trigger(threadId: string): Promise<any> {
    const id = sanitize(threadId);
    if (!id) return Promise.resolve({ status: 'skipped', folds: 0, merges: 0, detail: 'bad thread id' });
    const existing = inflight.get(id);
    if (existing) return existing;
    const run: Promise<any> = runCompaction(threadId, id)
      .catch((err: any) => {
        console.error(`[rolling] thread=${id} compaction threw: ${err?.stack || err?.message || err}`);
        return { status: 'failed', folds: 0, merges: 0, detail: String(err?.message || err).slice(0, 200) };
      })
      .finally(() => { if (inflight.get(id) === run) inflight.delete(id); });
    inflight.set(id, run);
    return run;
  }

  return {
    readTurns: (threadId: string) => deps.readTurns(threadId),
    readForServe,
    /** Fire-and-forget after a turn. Off = no-op. Never rejects. */
    maybeCompact: (threadId: string): Promise<any> =>
      enabled() ? trigger(threadId) : Promise.resolve({ status: 'skipped', folds: 0, merges: 0, detail: 'disabled' }),
    /** Run now regardless of the enabled flag. Never rejects. */
    compact: trigger,
    health,
  };
}

export type Rolling = ReturnType<typeof createRolling>;

// ── production instance ────────────────────────────────────────────────────
// One per database: its directory, its fold state and its sidecars are the tenant's own.
const prodLocal = tenantLocal<Rolling | null>(() => null);

/** Is rolling on for the harness that runs turns right now? */
export function rollingEnabledForActiveProvider(): boolean {
  const rc = getSanctumConfig().agent.rolling;
  const p = activeProviderName();
  return p === 'codex' ? !!rc.codex : p === 'dsh' ? rc.dsh !== false : !!rc.claude;
}

/** The summarizer as a Claude run: one isolated, tool-less, unsaved query on the
 *  autonomous model (or rolling.model when it names a Claude model), the same
 *  shape digest.ts uses. Nothing of the person's settings or memory rides in. */
export async function runClaudeSummarizer(prompt: string, baseFile: string, cwd: string, signal: AbortSignal): Promise<{ text: string; engine?: string; error?: string }> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const cfg = getSanctumConfig();
  const wanted = cfg.agent.rolling.model || '';
  const model = wanted.startsWith('claude') ? wanted : cfg.agent.model_autonomous || cfg.agent.model;
  const base = baseFile ? readOwnOrApp(baseFile).trim() : 'You write faithful summaries of conversation transcripts. Output only the summary text.';
  const systemPrompt = `${base}\n\n${FENCE_RULE}`;
  let text = '';
  const ac = new AbortController();
  signal.addEventListener('abort', () => ac.abort(), { once: true });
  for await (const message of query({
    prompt,
    options: {
      // 'default', not 'plan': plan mode injects its own system text ("Plan mode is
      // active with the plan file at …") and the real run showed it ending up in
      // every summary. tools: [] already means there is nothing to permit.
      model, systemPrompt, cwd, maxTurns: 1, permissionMode: 'default', tools: [],
      strictMcpConfig: true, mcpServers: {}, persistSession: false, settingSources: [], env: childEnv(childRunBase()),
      settings: { autoCompactEnabled: false, autoMemoryEnabled: false },
      abortController: ac,
    },
  })) {
    const msg = message as any;
    if (msg?.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) if (block.type === 'text' && block.text) text += block.text;
    }
    if (msg?.type === 'result' && msg.result && !text) text = msg.result;
  }
  return { text, engine: `claude:${model}` };
}

/** metadata.kind values that mark a system line as the app's own words (services/system-line.ts), on any platform. */
const APP_LINE_KINDS = ['withheld', 'discord_notice', 'identity_pending'] as const;

/** Which stored messages are conversation. People's and the companion's turns are. Fold/merge notes are role
 *  'system' and stay out of the model's history. Discord stores messages from people other than the owner as
 *  role 'system' too; those are real conversation, so they count as user turns rather than vanishing from the
 *  transcript. But the app's own lines in the owner's thread ("a reply was withheld", "reply failed", the
 *  upgrade notice) are also role 'system' on Discord, marked metadata.kind withheld or discord_notice: they are
 *  the app talking, never the person's words, and they stay out. */
export function isSpokenTurn(m: { role: string; platform?: string | null; metadata?: unknown }): boolean {
  if (m.role === 'user' || m.role === 'companion') return true;
  if (m.role !== 'system') return false;
  const kind = m.metadata && typeof m.metadata === 'object' ? (m.metadata as { kind?: unknown }).kind : undefined;
  // The identity gate's line ("Identity change waiting: ...") is the app talking, on whatever platform it was posted.
  if (typeof kind === 'string' && (APP_LINE_KINDS as readonly string[]).includes(kind)) return false;
  return m.platform === 'discord';
}

export function getRolling(): Rolling {
  const existing = prodLocal.get();
  if (existing) return existing;
  const cfg = getSanctumConfig();
  const rc = cfg.agent.rolling;
  const dir = join(dirname(cfg.server.db_path), 'rolling');
  const prod = createRolling({
    dir,
    enabled: rollingEnabledForActiveProvider,
    budgets: { tailChars: rc.tail_chars, foldChars: rc.fold_chars, keepChars: rc.keep_chars, tailTurns: rc.tail_turns, maxSegments: rc.max_segments, segmentCap: rc.segment_cap },
    readTurns: async (threadId) => {
      const { getMessages } = await import('./db.js');
      // People's and the companion's turns. Fold/merge notes are role 'system'
      // and stay out of the model's history. Discord stores messages from people
      // other than the owner as role 'system' too; those are real conversation,
      // so they count as user turns rather than vanishing from the transcript.
      return getMessages({ threadId, limit: 100000 })
        .filter(isSpokenTurn)
        .map((m) => ({ id: m.id, role: (m.role === 'companion' ? 'assistant' : 'user') as 'user' | 'assistant', content: m.content, at: m.created_at }));
    },
    appendMarker: async (threadId, { content, metadata }) => {
      const { createMessage } = await import('./db.js');
      createMessage({ id: randomUUID(), threadId, role: 'system', content, metadata, createdAt: new Date().toISOString() });
    },
    runPrompt: async ({ prompt, timeoutMs }) => {
      if (backgroundRunsOff()) return { text: '', error: 'background model runs are off for this tenant' }; // the operator's switch
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const untrack = trackBackgroundStart();
      try {
        await ownMkdirAsync(dir, { recursive: true });
        const cx = getSanctumConfig().agent.codex;
        const rcNow = getSanctumConfig().agent.rolling;
        const baseFile = rc.summarizer_instructions_file && existsSync(rc.summarizer_instructions_file) ? rc.summarizer_instructions_file : '';
        // One summarizer, on whichever harness runs turns.
        if (activeProviderName() === 'claude') {
          const r = await runClaudeSummarizer(prompt, baseFile, dir, ac.signal);
          if (ac.signal.aborted) return { text: '', error: `summarizer timed out after ${timeoutMs}ms` };
          return r;
        }
        let text = '';
        let failure = '';
        if (activeProviderName() === 'dsh') {
          const dx = getSanctumConfig().agent.dsh;
          const r = await runDshSummarizer({ prompt, baseFile, dir, signal: ac.signal, model: rcNow.model || dx.model_autonomous || dx.model || undefined });
          if (ac.signal.aborted) return { text: '', error: `summarizer timed out after ${timeoutMs}ms` };
          return r;
        }
        for await (const ev of runCodexExec({
          prompt, signal: ac.signal, sandboxMode: 'read-only', cwd: dir, networkAccess: false,
          // The summarizer's own model, else the autonomous one, else chat's, else Codex's default.
          model: rcNow.model || cx.model_autonomous || cx.model || undefined,
          modelProvider: rcNow.model_provider || cx.model_provider || undefined,
          harnessMemory: false, // a summary must not read or write anyone's memory
          baseFile, noProjectDocs: true,
        })) {
          if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text;
          else if (ev?.type === 'turn.failed') failure = ev.error?.message || 'turn failed';
          else if (ev?.type === 'error') failure = ev.message || 'error';
        }
        if (ac.signal.aborted) return { text: '', error: `summarizer timed out after ${timeoutMs}ms` };
        if (failure && !text) return { text: '', error: failure };
        return { text, engine: 'codex' };
      } catch (err: any) {
        return { text: '', error: String(err?.message ?? err) };
      } finally {
        clearTimeout(timer);
        untrack();
      }
    },
  });
  prodLocal.set(prod);
  return prod;
}
