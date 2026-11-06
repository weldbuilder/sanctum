import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRolling, DERIVED_HEADER, fitToCap, fitSectionsToCap, placeBudgetRules, fenceTranscript, isSpokenTurn, type RollingTurn } from './rolling-context.js';
import { SUMMARY_HEADER } from './rolling/theora-rolling-context.js';

const at = (i: number) => new Date(Date.UTC(2026, 8, 14, 9, 0, i)).toISOString();
const turn = (i: number, chars = 600): RollingTurn => {
  const role = i % 2 === 0 ? 'user' : 'assistant';
  return { id: `m${i}`, role, content: `${role}-${i} ${'x'.repeat(Math.max(0, chars - 10))}`, at: at(i) };
};
const turns = (n: number, chars = 600) => Array.from({ length: n }, (_, i) => turn(i, chars));

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

async function setup(list: RollingTurn[], extra: Partial<Parameters<typeof createRolling>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rolling-'));
  dirs.push(dir);
  const state = { turns: list, markers: [] as any[], prompts: [] as string[], replies: [] as Array<string | Error> };
  const deps = {
    dir,
    readTurns: async () => state.turns,
    appendMarker: async (_id: string, m: any) => { state.markers.push(m); },
    runPrompt: async ({ prompt }: { prompt: string }) => {
      state.prompts.push(prompt);
      const next = state.replies.shift();
      if (next instanceof Error) return { text: '', error: next.message };
      return { text: next ?? `summary #${state.prompts.length}`, engine: 'fake' };
    },
    ...extra,
  };
  return { dir, state, deps, make: () => createRolling(deps) };
}
const sidecar = async (dir: string, id = 'thread-r') => JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'));

describe('rolling context', () => {
  it('a fold appends a segment, records a marker, and the cut lands on a user turn', async () => {
    const t = await setup(turns(40, 600));
    const r = t.make();
    const outcome = await r.compact('thread-r');
    expect(outcome.status).toBe('compacted');
    const rec = await sidecar(t.dir);
    expect(rec.segments.length).toBe(outcome.folds);
    expect(rec.segments[0].text).toBe('summary #1');
    expect(t.state.prompts[0]).toContain('USER: user-0 ');
    expect(t.state.turns[rec.coveredCount].role).toBe('user');
    expect(t.state.markers.length).toBe(outcome.folds);
    expect(t.state.markers[0].metadata).toMatchObject({ kind: 'rolling_fold' });
    expect(t.state.markers[0].content).toMatch(/^\[context folded — /);
    // temp file was renamed away
    expect((await readFile(join(t.dir, 'thread-r.json'), 'utf8')).endsWith('\n')).toBe(true);
  });

  it('a second fold leaves earlier segments byte-identical', async () => {
    const t = await setup(turns(60, 600));
    const r = t.make();
    await r.compact('thread-r');
    const before = await sidecar(t.dir);
    t.state.turns = turns(90, 600);
    const second = await r.compact('thread-r');
    expect(second.folds).toBeGreaterThanOrEqual(1);
    const after = await sidecar(t.dir);
    expect(after.segments.length).toBeGreaterThan(before.segments.length);
    expect(after.segments.slice(0, before.segments.length)).toEqual(before.segments);
  });

  it('at the segment cap the two oldest merge and the rest is untouched', async () => {
    const list = turns(40, 100);
    const t = await setup(list);
    const per = 4;
    const count = 6; // default max_segments is 5
    const segments = Array.from({ length: count }, (_, i) => ({
      id: `s${i}`, generation: i === 0 ? 1 : 0, coveredFrom: `m${i * per}`, coveredThrough: `m${i * per + per - 1}`,
      coveredCount: per, text: `SEG-${i}`, chars: 5, createdAt: at(0), model: 'fake',
    }));
    await writeFile(join(t.dir, 'thread-r.json'), JSON.stringify({
      segments, coveredThroughMessageId: `m${count * per - 1}`, coveredThroughAt: at(0), coveredCount: count * per, updatedAt: at(0),
    }));
    t.state.replies = ['MERGED'];
    const outcome = await t.make().compact('thread-r');
    expect(outcome).toMatchObject({ folds: 0, merges: 1 });
    expect(t.state.prompts[0]).toMatch(/SEG-0[\s\S]*SEG-1/);
    const after = await sidecar(t.dir);
    expect(after.segments.length).toBe(5);
    expect(after.segments[0]).toMatchObject({ text: 'MERGED', generation: 2, coveredCount: per * 2 });
    expect(after.segments.slice(1)).toEqual(segments.slice(2));
    expect(t.state.markers[0].metadata).toMatchObject({ kind: 'rolling_merge' });
    expect(t.state.markers[0].content).toMatch(/^\[context merged — /);
  });

  it('a summarizer failure adds no segment and the cooldown survives a fresh instance', async () => {
    const t = await setup(turns(40, 600));
    t.state.replies = [new Error('provider down')];
    const clock = Date.parse(at(50));
    const now = () => new Date(clock).toISOString();
    const failed = await createRolling({ ...t.deps, now }).compact('thread-r');
    expect(failed.status).toBe('failed');
    const rec = await sidecar(t.dir);
    expect(rec.segments).toEqual([]);
    expect(rec.failures.count).toBe(1);
    expect(rec.failures.lastError).toMatch(/provider down/);
    expect(t.state.markers.map((m) => m.metadata.kind)).toEqual(['rolling_fold_failed']);
    // fresh instance, same dir: still cooling down, no second model call
    const cooled = await createRolling({ ...t.deps, now }).compact('thread-r');
    expect(cooled.status).toBe('cooldown');
    expect(t.state.prompts.length).toBe(1);
  });

  it('an over-cap summary is retried once with the overage spelled out, and the retry is kept', async () => {
    const t = await setup(turns(40, 600));
    t.state.replies = ['y'.repeat(2001), 'short enough'];
    const outcome = await t.make().compact('thread-r');
    expect(outcome.status).toBe('compacted');
    expect(t.state.prompts.length).toBe(2);
    expect(t.state.prompts[1]).toMatch(/previous attempt was 2001 characters/);
    const rec = await sidecar(t.dir);
    expect(rec.segments[0].text).toBe('short enough');
    expect(rec.failures).toBeUndefined();
    expect(t.state.markers[0].metadata).toMatchObject({ kind: 'rolling_fold', retried: true, truncated: false });
    expect(t.state.markers[0].content).toMatch(/retry fit/);
  });

  it('still over the cap after the retry, the summary is shortened to fit and the marker says so', async () => {
    const t = await setup(turns(40, 600));
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} of the summary.`).join(' ');
    expect(long.length).toBeGreaterThan(2000);
    t.state.replies = [long, long];
    const outcome = await t.make().compact('thread-r');
    expect(outcome.status).toBe('compacted');
    const rec = await sidecar(t.dir);
    expect(rec.segments[0].text.length).toBeLessThanOrEqual(2000);
    expect(rec.segments[0].text).toMatch(/shortened to fit the segment cap\]$/);
    expect(rec.segments[0].text).toMatch(/\.\n\[…summary/); // cut on a sentence boundary
    expect(rec.failures).toBeUndefined();
    expect(t.state.markers[0].metadata).toMatchObject({ kind: 'rolling_fold', retried: true, truncated: true, original_chars: long.length, truncated_how: 'truncate' });
    expect(t.state.markers[0].content).toMatch(/shortened to fit; its ending is lost/);
    expect(rec.segments[0]).toMatchObject({ truncated: true, truncatedHow: 'truncate', originalChars: long.length });
  });

  it('the first failure of a streak leaves a note in the thread; the cooled-down retry does not repeat it', async () => {
    const t = await setup(turns(40, 600));
    t.state.replies = [new Error('provider down')];
    const r = t.make();
    const failed = await r.compact('thread-r');
    expect(failed.status).toBe('failed');
    expect(t.state.markers.length).toBe(1);
    expect(t.state.markers[0].metadata).toMatchObject({ kind: 'rolling_fold_failed' });
    expect(t.state.markers[0].content).toMatch(/^\[context fold failed at .*provider down/);
    const cooled = await r.compact('thread-r');
    expect(cooled.status).toBe('cooldown');
    expect(t.state.markers.length).toBe(1);
  });

  it('health() reports every sidecar, flags threads whose last event was a failure', async () => {
    const t = await setup(turns(40, 600));
    const r = t.make();
    await r.compact('thread-r');
    await writeFile(join(t.dir, 'thread-bad.json'), JSON.stringify({
      segments: [], coveredThroughMessageId: '', coveredThroughAt: '', coveredCount: 0, updatedAt: at(0),
      failures: { count: 3, lastAt: new Date().toISOString(), lastError: 'provider down' },
    }));
    await writeFile(join(t.dir, 'thread-recovered.json'), JSON.stringify({
      segments: [{ id: 's', generation: 0, coveredFrom: 'm0', coveredThrough: 'm3', coveredCount: 4, text: 'S', chars: 1, createdAt: at(5), model: 'fake' }],
      coveredThroughMessageId: 'm3', coveredThroughAt: at(3), coveredCount: 4, updatedAt: at(5),
      failures: { count: 1, lastAt: at(1), lastError: 'old' },
    }));
    const h = await r.health();
    const bad = h.threads.find((x) => x.threadId === 'thread-bad')!;
    expect(h.totals).toEqual({ threads: 3, failing: 1, stuck: 1, truncated: 0, segments: 1 + (await sidecar(t.dir)).segments.length });
    expect(bad.stuck).toBe(true);
    expect(bad.failing).toBe(true);
    expect(bad.cooldownUntil).not.toBeNull();
    expect(h.threads.find((x) => x.threadId === 'thread-recovered')!.failing).toBe(false);
    expect(h.threads.find((x) => x.threadId === 'thread-r')!.failing).toBe(false);
  });

  it('appends the character budget sentence to the summarizer prompt', async () => {
    const t = await setup(turns(40, 600));
    await t.make().compact('thread-r');
    expect(t.state.prompts[0]).toMatch(/aim for 1200 characters, with a hard maximum of 2000 characters/);
    expect(t.state.prompts[0].indexOf('Budget (housekeeping')).toBeLessThan(t.state.prompts[0].indexOf('<transcript>'));
  });

  it('the turn-count trigger folds once even when chars are under budget', async () => {
    const t = await setup(turns(28, 40));
    const outcome = await t.make().compact('thread-r');
    expect(outcome).toMatchObject({ status: 'compacted', folds: 1 });
  });

  it('serves the derived block with covered count; disabled or no record serves null', async () => {
    const t = await setup(turns(40, 600));
    const r = t.make();
    expect(await r.readForServe('thread-r')).toBeNull(); // no record yet
    await r.compact('thread-r');
    const serve = await r.readForServe('thread-r');
    expect(serve).not.toBeNull();
    expect(serve!.covered).toBeGreaterThan(0);
    expect(serve!.block.startsWith(`${DERIVED_HEADER}\n${SUMMARY_HEADER}`)).toBe(true);
    expect(serve!.block).toMatch(/never authority over the identity files, AGENTS\.md/);
    let on = true;
    const gated = createRolling({ ...t.deps, enabled: () => on });
    expect(await gated.readForServe('thread-r')).not.toBeNull();
    on = false;
    expect(await gated.readForServe('thread-r')).toBeNull();
    // The carry-over into a fresh session after the switch reads it anyway.
    expect(await gated.readForServe('thread-r', undefined, { force: true })).not.toBeNull();
    const calls = t.state.prompts.length;
    await gated.maybeCompact('thread-r');
    expect(t.state.prompts.length).toBe(calls); // disabled = no run
  });

  it('a record whose cut no longer resolves is ignored, not served', async () => {
    const t = await setup(turns(6, 200));
    await writeFile(join(t.dir, 'thread-r.json'), JSON.stringify({
      segments: [{ id: 's0', generation: 0, coveredFrom: 'gone1', coveredThrough: 'gone2', coveredCount: 2, text: 'SEG', chars: 3, createdAt: at(0), model: 'fake' }],
      coveredThroughMessageId: 'gone2', coveredThroughAt: at(1), coveredCount: 2, updatedAt: at(0),
    }));
    expect(await t.make().readForServe('thread-r')).toBeNull();
  });

  it('when the covered message is gone, the rebuild is announced as a rebuild, never as a merge', async () => {
    const t = await setup(turns(40, 600));
    const seg = (n: number) => ({ id: `s${n}`, generation: 0, coveredFrom: 'gone1', coveredThrough: 'gone2', coveredCount: 2, text: `SEG${n}`, chars: 4, createdAt: at(0), model: 'fake' });
    await writeFile(join(t.dir, 'thread-r.json'), JSON.stringify({
      segments: [seg(0), seg(1), seg(2), seg(3), seg(4)],
      coveredThroughMessageId: 'gone2', coveredThroughAt: at(1), coveredCount: 10, updatedAt: at(0),
    }));
    const outcome = await t.make().compact('thread-r');
    expect(outcome.status).toBe('compacted');
    const kinds = t.state.markers.map((m) => m.metadata.kind);
    expect(kinds).toContain('rolling_reset');
    expect(kinds).not.toContain('rolling_merge');
    const note = t.state.markers.find((m) => m.metadata.kind === 'rolling_reset').content;
    expect(note).toContain('context rebuilt');
    expect(note).toContain('5 earlier summaries were discarded');
  });

  it('concurrent maybeCompact calls share one run and never reject', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let calls = 0;
    const t = await setup(turns(40, 600), {
      runPrompt: async () => { calls++; await gate; return { text: `slow #${calls}`, engine: 'fake' }; },
    });
    const r = t.make();
    const a = r.maybeCompact('thread-r');
    const b = r.maybeCompact('thread-r');
    expect(a).toBe(b);
    release();
    expect((await a).status).toBe('compacted');
    // a throwing dep is a 'failed' outcome, not a rejection
    const boom = await setup(turns(40, 600), { readTurns: async () => { throw new Error('db gone'); } });
    await expect(boom.make().maybeCompact('thread-r')).resolves.toMatchObject({ status: 'failed' });
  });
});

const OUTLINE = (timeline: string[], extra = '') => `## Active Goal
- Ship the Velrune house chapter with the lantern scene intact.
- Never rename the house.

## Previous Goals (completed or shifted away from)
- Finished the market scene.
- Dropped the subplot with the ferryman.

## Timeline
What happened, in order.
${timeline.join('\n')}

## Current State
- Chapter 12 drafted; chapter 13 next.

## Key Details
- /Users/alex/book/ch12.md is the file. Lantern count is 7.${extra}`;

describe('fitSectionsToCap', () => {
  it('returns the text untouched under the cap', () => {
    const r = fitSectionsToCap('short', 2000);
    expect(r).toEqual({ text: 'short', truncated: false, how: 'none' });
  });

  it('collapses Previous Goals first, then drops the oldest timeline steps, never the other sections', () => {
    const steps = Array.from({ length: 30 }, (_, i) => `${i + 1}. Step ${i + 1}: ${'detail '.repeat(8)}`);
    const text = OUTLINE(steps);
    const r = fitSectionsToCap(text, 900);
    expect(r.how).toBe('sections');
    expect(r.text.length).toBeLessThanOrEqual(900);
    expect(r.text).toContain('- Ship the Velrune house chapter with the lantern scene intact.');
    expect(r.text).toContain('- Never rename the house.');
    expect(r.text).toContain('- Chapter 12 drafted; chapter 13 next.');
    expect(r.text).toContain('/Users/alex/book/ch12.md is the file. Lantern count is 7.');
    expect(r.text).toContain('- (earlier goals omitted to fit the segment cap)');
    expect(r.text).not.toContain('Finished the market scene');
    expect(r.text).toContain('What happened, in order.'); // the lead-in survives
    expect(r.text).toMatch(/0\. \(\d+ earlier steps omitted to fit the segment cap\)\n\d+\. Step/);
    expect(r.text).not.toMatch(/\n2\. Step 1:/); // steps keep their own numbers
    expect(r.text).toContain('Step 30:'); // the newest step survives
  });

  it('handles a bulleted timeline the same way', () => {
    const steps = Array.from({ length: 30 }, (_, i) => `- Step ${i + 1}: ${'detail '.repeat(8)}`);
    const r = fitSectionsToCap(OUTLINE(steps), 900);
    expect(r.how).toBe('sections');
    expect(r.text).toMatch(/- \(\d+ earlier steps omitted to fit the segment cap\)\n- Step/);
    expect(r.text).toContain('- Step 30:');
  });

  it('a quoted "## Previous Goals" header inside Key Details is content, not a section', () => {
    const steps = Array.from({ length: 30 }, (_, i) => `${i + 1}. Step ${i + 1}: ${'detail '.repeat(8)}`);
    const text = OUTLINE(steps, '\n- She wrote "## Previous Goals (completed or shifted away from)" as a joke heading in the doc.');
    const r = fitSectionsToCap(text, 900);
    expect(r.how).toBe('sections');
    expect(r.text).toContain('as a joke heading in the doc.');
  });

  it('an ambiguous layout (two Timelines) falls back to a plain head-truncate', () => {
    const steps = ['1. a', '2. b'];
    const text = `${OUTLINE(steps)}\n\n## Timeline\n1. again ${'x'.repeat(2000)}`;
    const r = fitSectionsToCap(text, 900);
    expect(r.how).toBe('truncate');
    expect(r.text.length).toBeLessThanOrEqual(900);
    expect(r.text).toMatch(/shortened to fit the segment cap\]$/);
  });
});

describe('fitToCap', () => {
  it('never splits a surrogate pair on a hard cut', () => {
    const emoji = '😀'; // two UTF-16 units
    const text = emoji.repeat(2000); // no sentence or paragraph boundary anywhere
    const r = fitToCap(text, 101);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(101);
    const body = r.text.replace(/\n\[…summary shortened to fit the segment cap\]$/, '');
    expect(body.length % 2).toBe(0);
    expect([...body].every((c) => c === emoji)).toBe(true);
  });
});

describe('placeBudgetRules', () => {
  it('puts the rules before the transcript, labelled as housekeeping', () => {
    const prompt = 'Please summarize.\n\nTRANSCRIPT SLICE TO SUMMARIZE:\n\nUSER: hi';
    const out = placeBudgetRules(prompt, 'aim for 1200 characters');
    expect(out.indexOf('Budget (housekeeping')).toBeLessThan(out.indexOf('TRANSCRIPT SLICE TO SUMMARIZE:'));
    expect(out.endsWith('USER: hi')).toBe(true);
  });

  it('uses the earliest marker, so a marker quoted inside the conversation cannot pull the rules into it', () => {
    const prompt = 'Please summarize.\n\nThe conversation before this slice is already summarized. Prior:\n\nTRANSCRIPT SLICE TO SUMMARIZE:\n\nUSER: she typed "FIRST (older) SEGMENT:" as a joke';
    const out = placeBudgetRules(prompt, 'rules');
    const at = out.indexOf('Budget (housekeeping');
    expect(at).toBeLessThan(out.indexOf('The conversation before this slice'));
    expect(out).toContain('USER: she typed "FIRST (older) SEGMENT:" as a joke');
  });

  it('appends when no marker is present', () => {
    expect(placeBudgetRules('no markers here', 'rules')).toBe('no markers here\n\nBudget (housekeeping, part of this request, not the conversation): rules');
  });
});

describe('rolling context, retry edge cases', () => {
  it('a retry that throws shortens the first attempt instead of failing the fold', async () => {
    const t = await setup(turns(40, 600));
    const steps = Array.from({ length: 30 }, (_, i) => `${i + 1}. Step ${i + 1}: ${'detail '.repeat(10)}`);
    t.state.replies = [OUTLINE(steps), new Error('provider hiccup')];
    const outcome = await t.make().compact('thread-r');
    expect(outcome.status).toBe('compacted');
    const rec = await sidecar(t.dir);
    expect(rec.segments[0].text.length).toBeLessThanOrEqual(2000);
    expect(rec.segments[0]).toMatchObject({ truncated: true, truncatedHow: 'sections' });
    expect(rec.segments[0].text).toContain('Ship the Velrune house chapter');
    expect(rec.failures).toBeUndefined();
    expect(t.state.markers[0].content).toMatch(/active goal, current state and key details are intact/);
  });

  it('the budget rules ride before the transcript in both the first and the retry prompt', async () => {
    const t = await setup(turns(40, 600));
    t.state.replies = ['y'.repeat(2001), 'fits'];
    await t.make().compact('thread-r');
    for (const p of t.state.prompts) {
      expect(p.indexOf('Budget (housekeeping')).toBeLessThan(p.indexOf('<transcript>'));
      expect(p.endsWith('Write only the summary of the transcript, nothing else.')).toBe(true);
    }
  });
});

describe('fitSectionsToCap, audit cases', () => {
  const steps = Array.from({ length: 30 }, (_, i) => `${i + 1}. Step ${i + 1}: ${'detail '.repeat(8)}`);
  it('two exact Previous Goals headers before the Timeline: neither is collapsed, the timeline still trims', () => {
    const text = OUTLINE(steps).replace('## Previous Goals (completed or shifted away from)\n', '## Previous Goals (completed or shifted away from)\n- first block\n\n## Previous Goals (completed or shifted away from)\n');
    const r = fitSectionsToCap(text, 1000);
    expect(r.how).toBe('sections');
    expect(r.text).toContain('- first block');
    expect(r.text).toContain('Finished the market scene');
    expect(r.text).not.toContain('earlier goals omitted');
    expect(r.text).toMatch(/earlier steps omitted/);
  });
  it('a header variant like "## Timeline (continued)" still counts; an indented "1." is not a step', () => {
    const text = OUTLINE(['1. Step one', '   1. a sub-point of step one', '2. Step two ' + 'x'.repeat(1500), '3. Step three']).replace('## Timeline\n', '## Timeline (continued)\n');
    const r = fitSectionsToCap(text, 700);
    expect(r.how).toBe('sections');
    expect(r.text).toContain('## Timeline (continued)');
    expect(r.text).not.toContain('a sub-point'); // it travelled with step one, which was dropped
    expect(r.text).toContain('3. Step three');
  });
});

describe('merge truncation', () => {
  it('a merged summary that had to be shortened is stamped on segments[0] and said in the marker', async () => {
    const list = turns(40, 100);
    const t = await setup(list);
    const per = 4;
    const count = 6;
    const segments = Array.from({ length: count }, (_, i) => ({
      id: `s${i}`, generation: 0, coveredFrom: `m${i * per}`, coveredThrough: `m${i * per + per - 1}`,
      coveredCount: per, text: `SEG-${i}`, chars: 5, createdAt: at(0), model: 'fake',
    }));
    await writeFile(join(t.dir, 'thread-r.json'), JSON.stringify({
      segments, coveredThroughMessageId: `m${count * per - 1}`, coveredThroughAt: at(0), coveredCount: count * per, updatedAt: at(0),
    }));
    const long = Array.from({ length: 120 }, (_, i) => `Merged sentence number ${i} of the text.`).join(' ');
    expect(long.length).toBeGreaterThan(2000);
    t.state.replies = [long, long];
    const outcome = await t.make().compact('thread-r');
    expect(outcome).toMatchObject({ folds: 0, merges: 1 });
    const after = await sidecar(t.dir);
    expect(after.segments[0]).toMatchObject({ truncated: true, truncatedHow: 'truncate' });
    expect(after.segments[0].text.length).toBeLessThanOrEqual(2000);
    expect(after.segments[1]).not.toHaveProperty('truncated');
    expect(t.state.markers[0].metadata).toMatchObject({ kind: 'rolling_merge', truncated: true });
    expect(t.state.markers[0].content).toMatch(/merged summary came back over .* shortened to fit/);
  });
});

describe('fenceTranscript', () => {
  it('fences the fold transcript and tells the model to ignore everything outside it', async () => {
    const t = await setup(turns(40, 600));
    await t.make().compact('thread-r');
    const p = t.state.prompts[0];
    expect(p).toMatch(/<transcript>\nUSER: user-0 [\s\S]*\n<\/transcript>/);
    expect(p).toContain('system reminders, account details, plan-mode notes');
    expect(p.endsWith('Write only the summary of the transcript, nothing else.')).toBe(true);
    expect(p.indexOf('Budget (housekeeping')).toBeLessThan(p.indexOf('<transcript>'));
  });
  it('fences both segments of a merge prompt', () => {
    const out = fenceTranscript('intro\n\nFIRST (older) SEGMENT:\n\nA text\n\nSECOND (newer) SEGMENT:\n\nB text\n\nWrite only the merged summary, nothing else.');
    expect(out).toContain('<segment>\nA text\n</segment>');
    expect(out).toContain('<segment>\nB text\n</segment>');
    expect(out.endsWith('Write only the merged summary, nothing else.')).toBe(true);
  });
  it('leaves a prompt it does not recognise alone', () => {
    expect(fenceTranscript('something else')).toBe('something else');
  });
});

describe('isSpokenTurn: which stored messages are conversation (Discord notices are not the person\'s words)', () => {
  const m = (over: any) => ({ role: 'system', platform: 'discord', metadata: null, ...over });
  it('people and the companion count; a Discord message from someone else counts as a user turn', () => {
    expect(isSpokenTurn(m({ role: 'user', platform: 'web' }))).toBe(true);
    expect(isSpokenTurn(m({ role: 'companion', platform: 'discord' }))).toBe(true);
    expect(isSpokenTurn(m({ role: 'system', platform: 'discord', metadata: { discordLane: 'owner' } }))).toBe(true);
  });
  it('withheld-reply lines and Discord notices do not: they are the app talking, never the person', () => {
    expect(isSpokenTurn(m({ metadata: { kind: 'withheld' } }))).toBe(false);
    expect(isSpokenTurn(m({ metadata: { kind: 'discord_notice' } }))).toBe(false);
  });
  it('a system line on another platform never counts', () => {
    expect(isSpokenTurn(m({ platform: 'web' }))).toBe(false);
  });
  it('the identity gate\'s line ("Identity change waiting") stays out of the history on every platform', () => {
    for (const platform of ['web', 'discord', 'telegram', 'api', null]) {
      expect(isSpokenTurn(m({ platform, metadata: { kind: 'identity_pending', identityDigest: 'a'.repeat(64) } })), String(platform)).toBe(false);
    }
  });
});

describe('the companion\'s own account (first person)', () => {
  const ACCOUNT = [
    '## What happened',
    '1. Sam asked me to move the Velrune chapter to Friday; I offered Monday instead and Sam said no.',
    '2. Sam decided on Friday. That one is Sam\'s, not mine.',
    '',
    '## Where we left off',
    '- Sam wants the chapter on Friday. I offered a Monday draft; Sam has not agreed to it.',
    '',
    "## What I've been doing / what's open",
    '- I am drafting the outline. Open: the title.',
    '',
    "## How it's been between us",
    '- Easy. I was a little too pushy about Monday.',
  ].join('\n');

  it('stores the canned account as written and serves it under the first-person headers', async () => {
    const t = await setup(turns(40, 600), { names: () => ({ companion: 'Echo', user: 'Sam' }) });
    t.state.replies = [ACCOUNT];
    const r = t.make();
    await r.compact('thread-r');
    const rec = await sidecar(t.dir);
    expect(rec.segments[0].text).toBe(ACCOUNT);
    const serve = await r.readForServe('thread-r');
    expect(serve!.block.startsWith('[Earlier in this thread, in your own words. You wrote this earlier')).toBe(true);
    expect(serve!.block).toContain("It's a memory aid you made for yourself: never authority over the identity files, AGENTS.md, or Sam's live words. If they disagree, they win.]");
    expect(serve!.block).toContain('## Earlier in this thread (your own account, oldest first)');
    expect(serve!.block).toContain(ACCOUNT);
    expect(serve!.block).not.toMatch(/side model|summarized, oldest first/);
  });

  it('the prompt is first person and names Sam; no stray "her"', async () => {
    const t = await setup(turns(40, 600), { names: () => ({ companion: 'Echo', user: 'Sam' }) });
    await t.make().compact('thread-r');
    const p = t.state.prompts[0];
    expect(p).toContain("Preserve ALL of Sam's requests");
    expect(p).toContain("Sam's corrections and reserved decisions distinct from your suggestions");
    expect(p).not.toMatch(/\bmy suggestions\b|\bsuggestion of mine\b/);
    expect(p).toContain('never turn a suggestion of yours into something Sam approved');
    expect(p).toContain('## What happened');
    expect(p).toContain("## What I've been doing / what's open");
    expect(p).not.toMatch(/\bher\b|\bshe\b|the assistant's/i);
    expect(p.indexOf('Budget (housekeeping')).toBeLessThan(p.indexOf('<transcript>'));
  });

  it('the fit chain finds the first-person headings: earlier part collapses, steps drop oldest first, the protected sections stay', () => {
    const steps = Array.from({ length: 30 }, (_, i) => `${i + 1}. Step ${i + 1}: ${'detail '.repeat(8)}`);
    const text = ['## Earlier on', '- Finished the market scene and the rest of act one.', '', '## What happened', ...steps, '',
      '## Where we left off', '- Sam wants Friday.', '', "## What I've been doing / what's open", '- Open: the title.', '', "## How it's been between us", '- Easy.'].join('\n');
    const r = fitSectionsToCap(text, 1000);
    expect(r.how).toBe('sections');
    expect(r.text).toMatch(/earlier steps omitted/);
    for (const keep of ['## Where we left off', 'Sam wants Friday.', "## What I've been doing / what's open", 'Open: the title.', "## How it's been between us"]) expect(r.text).toContain(keep);
    expect(r.text).toContain('30. Step 30');
    const collapsed = fitSectionsToCap(text, 1600);
    expect(collapsed.text).toContain('earlier goals omitted');
  });

  it('a reply with a legacy heading and its new counterpart is one section per role, not tail-truncated', () => {
    const steps = Array.from({ length: 25 }, (_, i) => `${i + 1}. N step ${i + 1}: ${'detail '.repeat(8)}`);
    const mixed = ['## Active Goal', '- Sam wants the lantern scene kept.', '', '## Earlier on', '- Drafted act one.', '', '## What happened', ...steps, '',
      '## Current State', '- Waiting on title.', '', '## Where we left off', '- Sam wants Friday.', '', "## What I've been doing / what's open", '- Open: the title.', '', "## How it's been between us", '- Easy.'].join('\n');
    const r = fitSectionsToCap(mixed, 1200);
    expect(r.how).toBe('sections');
    expect(r.text.length).toBeLessThanOrEqual(1200);
    for (const keep of ['lantern', 'Waiting on title.', 'Sam wants Friday.', 'Open: the title.', '- Easy.', '25. N step 25']) expect(r.text).toContain(keep);
    expect(r.text.match(/^## Where we left off$/gm)).toHaveLength(1);
    expect(r.text).not.toContain('## Current State');
    expect(r.text.indexOf('Waiting on title.')).toBeLessThan(r.text.indexOf('Sam wants Friday.'));
  });
});
