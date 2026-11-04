import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearTags, registerTag, parseTags, streamView, StreamTagFilter, expressionInstructions, runTags } from './index.js';

const run = vi.fn(async () => {});
let imageOffered = true;
let voiceOffered = true;
beforeEach(() => {
  clearTags(); run.mockClear(); imageOffered = true; voiceOffered = true;
  registerTag('image', { max: 2, requiresArg: true, offered: () => imageOffered, run, instruction: '[image: x] makes a picture' });
  registerTag('voice', { max: 1, startOnly: true, offered: () => voiceOffered, run, instruction: '[voice] speaks' });
});

describe('parseTags', () => {
  it('no tags: the text is untouched', () => {
    const t = 'Just words, and a [link](http://x) and [1] and [brackets].';
    expect(parseTags(t)).toMatchObject({ clean: t, tags: [] });
  });

  it('one image tag: removed with one neighbouring space, words intact', () => {
    const r = parseTags("Here you go [image: a fox in snow] and that's all");
    expect(r.clean).toBe("Here you go and that's all");
    expect(r.tags).toEqual([{ name: 'image', arg: 'a fox in snow', start: 12, end: 34, honoured: true }]);
  });

  it('a tag at the end or on its own line leaves no stray space or blank line', () => {
    expect(parseTags('Look at this [image: a lamp]').clean).toBe('Look at this');
    expect(parseTags('Look.\n[image: a lamp]\nBye.').clean).toBe('Look.\nBye.');
    expect(parseTags('[image: a lamp] Look.').clean).toBe('Look.');
  });

  it('two image tags: both honoured', () => {
    const r = parseTags('a [image: one] b [image: two] c');
    expect(r.clean).toBe('a b c');
    expect(r.tags.map((t) => [t.arg, t.honoured])).toEqual([['one', true], ['two', true]]);
  });

  it('three image tags: the third is stripped but not honoured', () => {
    const r = parseTags('[image: one] [image: two] [image: three] done');
    expect(r.clean).toBe('done');
    expect(r.tags.map((t) => t.honoured)).toEqual([true, true, false]);
  });

  it('voice at the start is honoured, with or without an emotion', () => {
    let r = parseTags('[voice] Good morning.');
    expect(r.clean).toBe('Good morning.');
    expect(r.tags[0]).toMatchObject({ name: 'voice', arg: '', honoured: true });
    r = parseTags('  [voice:calm]\nGood night.');
    expect(r.clean).toBe('Good night.');
    expect(r.tags[0]).toMatchObject({ arg: 'calm', honoured: true });
  });

  it('voice mid-text is stripped and not honoured; a second voice too', () => {
    let r = parseTags('Hello there [voice] friend');
    expect(r.clean).toBe('Hello there friend');
    expect(r.tags[0].honoured).toBe(false);
    r = parseTags('[voice] a [voice:warm] b');
    expect(r.tags.map((t) => t.honoured)).toEqual([true, false]);
  });

  it('an image with no description is stripped, not run', () => {
    const r = parseTags('x [image:] y [image] z');
    expect(r.clean).toBe('x y z');
    expect(r.tags.every((t) => !t.honoured)).toBe(true);
  });

  it('malformed [image: with no close passes through untouched', () => {
    const t = 'Look [image: a fox in the snow and then I trailed off';
    expect(parseTags(t)).toMatchObject({ clean: t, tags: [] });
  });

  it('a tag that runs past 300 characters or a newline is not a tag', () => {
    const long = `[image: ${'a'.repeat(300)}]`;
    expect(parseTags(long)).toMatchObject({ clean: long, tags: [] });
    const nl = '[image: a fox\nin snow]';
    expect(parseTags(nl)).toMatchObject({ clean: nl, tags: [] });
  });

  it('nested brackets and unknown tags in prose are untouched', () => {
    for (const t of ['see [image: a [b] c] there', 'a [gif: cat] b', '[note: this] stays', 'arr[0] and [i] and [images: x]']) {
      expect(parseTags(t).clean).toBe(t);
    }
  });

  it('respects code: fences and inline code are prose', () => {
    const fenced = 'Use it like:\n```\n[image: a fox]\n```\nand done';
    expect(parseTags(fenced)).toMatchObject({ clean: fenced, tags: [] });
    const inline = 'Write `[image: a fox]` to draw. [image: real one]';
    const r = parseTags(inline);
    expect(r.clean).toBe('Write `[image: a fox]` to draw.');
    expect(r.tags).toHaveLength(1);
    expect(r.tags[0].arg).toBe('real one');
  });

  it('a tag after a closed fence is still found', () => {
    const r = parseTags('```\ncode\n```\n[image: after]');
    expect(r.tags).toHaveLength(1);
    expect(r.clean).toBe('```\ncode\n```');
  });

  it('is case-insensitive on the name', () => {
    expect(parseTags('[Image: a cat] hi').tags[0]).toMatchObject({ name: 'image', arg: 'a cat' });
  });

  it('offset map: positions after a removed tag shift back by what was removed', () => {
    const raw = 'Here [image: x] is more text';
    const r = parseTags(raw);
    expect(r.clean).toBe('Here is more text');
    expect(r.clean.slice(r.map(raw.indexOf('is more'))).startsWith('is more')).toBe(true);
    expect(r.map(0)).toBe(0);
    expect(r.map(raw.length)).toBe(r.clean.length);
  });
});

describe('streamView / StreamTagFilter', () => {
  it('a tag split across chunks never leaks, and the surrounding text arrives in order', () => {
    const f = new StreamTagFilter();
    const seen = [f.push('Here you go [ima'), f.push('ge: a c'), f.push('at]'), f.push(' and that is all')];
    expect(seen).toEqual(['Here you go', 'Here you go', 'Here you go', 'Here you go and that is all']);
    for (const s of seen) expect(s).not.toMatch(/\[|image|cat/);
    expect(f.flush()).toBe('Here you go and that is all');
  });

  it('every prefix of a reply with tags is free of tag text, and grows monotonically', () => {
    const full = '[voice:calm] Hello [image: a red door] there [image: b] end';
    let prev = '';
    for (let n = 1; n <= full.length; n++) {
      const v = streamView(full.slice(0, n));
      expect(v).not.toMatch(/\[(image|voice|ima|voi|i|v)[^\]]*$|\[(image|voice)/i);
      expect(v.startsWith(prev)).toBe(true);
      prev = v;
    }
    expect(prev).toBe('Hello there end');
  });

  it('held text that turns out not to be a tag is released', () => {
    const f = new StreamTagFilter();
    expect(f.push('see [ima')).toBe('see');
    expect(f.push('ginary friend]')).toBe('see [imaginary friend]');
    expect(f.push(' [1')).toBe('see [imaginary friend] [1');
  });

  it('unknown bracket text passes straight through, and a held [ is released at the end of the stream', () => {
    expect(streamView('a [note: x] b')).toBe('a [note: x] b');
    const f = new StreamTagFilter();
    expect(f.push('trailing [')).toBe('trailing');
    expect(f.flush()).toBe('trailing [');
  });

  it('a newline or 300 characters ends the hold', () => {
    expect(streamView('[image: a fox\nand more')).toBe('[image: a fox\nand more');
    expect(streamView(`[image: ${'a'.repeat(310)}`)).toContain('[image: a');
  });
});

describe('expressionInstructions', () => {
  it('lists only the offered tags, and nothing when none is', () => {
    expect(expressionInstructions()).toContain('[image: x]');
    expect(expressionInstructions()).toContain('[voice]');
    imageOffered = false;
    expect(expressionInstructions()).not.toContain('[image');
    expect(expressionInstructions()).toContain('[voice]');
    voiceOffered = false;
    expect(expressionInstructions()).toBe('');
  });
});

describe('runTags', () => {
  const wait = () => new Promise((r) => setTimeout(r, 5));
  const opts = { platform: 'web', threadId: 't1', messageId: 'm1', cleanText: 'clean' };

  it('runs every honoured tag with the context, off the caller (returns synchronously)', async () => {
    const { tags } = parseTags('[voice] hi [image: a] [image: b] [image: c]');
    const ret = runTags(tags, opts);
    expect(ret).toBeUndefined();
    await wait();
    expect(run).toHaveBeenCalledTimes(3);
    expect((run.mock.calls as any[]).map((c) => c[0].arg)).toEqual(['', 'a', 'b']);
    expect((run.mock.calls as any[])[0][1]).toEqual({ threadId: 't1', text: 'clean', messageId: 'm1', platform: 'web' });
  });

  it('does not run a tag whose capability is not offered; a failing action does not stop the others or log its prompt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    run.mockRejectedValueOnce(new Error('secret prompt text'));
    const { tags } = parseTags('[image: secret prompt text] [image: two]');
    runTags(tags, opts);
    await wait();
    expect(run).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret prompt');
    warn.mockRestore();
    run.mockClear(); imageOffered = false;
    runTags(parseTags('[image: x]').tags, opts);
    await wait();
    expect(run).not.toHaveBeenCalled();
  });
});
