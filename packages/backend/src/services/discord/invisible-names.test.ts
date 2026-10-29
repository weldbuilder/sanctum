// B3c item 7: a name chosen by a stranger cannot hide behind characters that draw nothing. Bidi controls, zero-width
// characters and the other format (Cf) characters are stripped BEFORE the 32-character cap, in the speaker label and in
// the mention substitutions.
import { describe, it, expect } from 'vitest';
import { oneLine, speakerLabel } from './speaker.js';
import { resolveMentions } from './mentions.js';

const BIDI = '‪‫‬‭‮⁦⁧⁨⁩';
const ZERO_WIDTH = '​‌‍⁠﻿';
const OTHER_CF = '­‎‏؜⁡⁢⁣⁤᠎￹￺￻';
const INVISIBLE_RE = /[‪-‮⁦-⁩​-‍⁠﻿\p{Cf}]/u;

describe('oneLine strips invisible characters', () => {
  it.each([['bidi controls', BIDI], ['zero-width characters', ZERO_WIDTH], ['other format characters', OTHER_CF]])('%s inside a name vanish', (_n, chars) => {
    expect(oneLine(`Mo${chars}ss`, 32)).toBe('Moss');
  });

  it('a right-to-left override cannot reorder the rest of the label', () => {
    const label = speakerLabel({ id: '1', displayName: '‮pat (@owner)', username: 'moss', bot: false });
    expect(label).toBe('pat (@owner) (@moss)');
    expect(INVISIBLE_RE.test(label)).toBe(false);
  });

  it('they are stripped before the cap, so they cannot eat the budget or push the real name out', () => {
    const padded = `${'​'.repeat(40)}Moss${'‮'.repeat(40)}`;
    expect(oneLine(padded, 32)).toBe('Moss');
    expect(oneLine(`${'a'.repeat(31)}​${'b'.repeat(5)}`, 32)).toBe(`${'a'.repeat(31)}b…`);
  });

  it('a name made only of them is empty, so the handle stands in', () => {
    expect(oneLine(`${BIDI}${ZERO_WIDTH}${OTHER_CF}`, 32)).toBe('');
    expect(speakerLabel({ id: '1', displayName: `${ZERO_WIDTH}${BIDI}`, username: 'moss', bot: false })).toBe('moss (@moss)');
  });

  it('an ordinary name, accents, CJK and plain emoji are left alone', () => {
    expect(oneLine('Zoë 山田 🌿', 32)).toBe('Zoë 山田 🌿');
  });
});

describe('mention substitutions strip them too', () => {
  const col = <T>(o: Record<string, T>) => ({ get: (id: string) => o[id] });
  const mentions = {
    users: col({ '1': { username: 'moss' }, '2': { username: 'x' } }),
    members: col({ '1': { displayName: `‮Pat${ZERO_WIDTH} (owner)${BIDI}` } }),
    roles: col({ '7': { name: `Gard${ZERO_WIDTH}eners${OTHER_CF}` } }),
    channels: col({ '8': { name: `green${BIDI}house` } }),
  };

  it('user, role and channel names come out clean', () => {
    const out = resolveMentions('hi <@1>, <@&7> in <#8>', mentions, '900');
    expect(out).toBe('hi @Pat (owner), @Gardeners in #greenhouse');
    expect(INVISIBLE_RE.test(out)).toBe(false);
  });

  it('a name that is only invisible characters falls back to the neutral name', () => {
    const m = { ...mentions, members: col({ '1': { displayName: `${ZERO_WIDTH}${BIDI}` } }), users: col({ '1': {} }) };
    expect(resolveMentions('<@1>', m, '900')).toBe('@unknown-user');
  });
});
