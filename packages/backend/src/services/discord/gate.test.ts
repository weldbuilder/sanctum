import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GateError, loadRules, check, normalize, RuleSource } from './gate.js';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-gate-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function listFile(body: string): string {
  const p = join(tmp, `list-${n++}.txt`);
  writeFileSync(p, body, 'utf-8');
  return p;
}

const PHONE_1 = 're:\\b\\d{3}[-.\\s]\\d{3}[-.\\s]\\d{4}\\b';

// Made-up entries only. Three phone shapes by pattern.
const LIST = `# words.txt (test list, made up)
# blank lines and comments are ignored

Jane Example
Janie
Maple Street
Springfield
Example Elementary
Acme Widgets
${PHONE_1}
re:\\(\\d{3}\\)\\s*\\d{3}[-.\\s]?\\d{4}
re:(?<!\\d)\\d{10}(?!\\d)
`;

describe('normalize', () => {
  it('NFKC-folds and strips invisible characters', () => {
    expect(normalize('Ｍａple​ Street')).toBe('Maple Street');
    expect(normalize('a­b⁠c﻿d‌e‍f')).toBe('abcdef');
  });
});

describe('check: the 24 cases', () => {
  const rules = loadRules(listFile(LIST));
  // [text, expected hits]. A word entry reports the entry; a pattern reports what it caught.
  const cases: Array<[string, string[]]> = [
    // clear
    ['I had a lovely afternoon and made soup.', []],
    ['The Maples on a street nearby were pretty.', []],
    ['Springfields of the mind', []],
    ['Janet said hello', []],
    ['call me on channel 12 at 3pm', []],
    ['it was 555 or 0142, nobody remembers', []],
    // plain, capitals, spacing
    ['I grew up in Springfield.', ['Springfield']],
    ['i grew up in SPRINGFIELD!', ['Springfield']],
    ['Maple Street is where it was', ['Maple Street']],
    ['maple   street', ['Maple Street']],
    ['Maple\n\tStreet', ['Maple Street']],
    ['MapleStreet', ['Maple Street']],
    // hyphens and other punctuation between the words; whole words only
    ['Maple-Street', ['Maple Street']],
    ['Maple_Street', ['Maple Street']],
    ['The Maple Streets were closed', []],
    ['Maple...Street', ['Maple Street']],
    // hashtags and surrounding punctuation
    ['#MapleStreet', ['Maple Street']],
    ['(Janie)', ['Janie']],
    ['see #ExampleElementary tomorrow', ['Example Elementary']],
    // hidden and look-alike characters
    ['Spring​field', ['Springfield']],
    ['Ja­nie', ['Janie']],
    ['Ａｃｍｅ Widgets', ['Acme Widgets']],
    // phone shapes, by pattern: the hit is what the pattern caught
    ['ring 555-010-0142 later', ['555-010-0142']],
    ['ring (555) 010-0142 later', ['(555) 010-0142']],
  ];
  it('has 24 cases', () => { expect(cases).toHaveLength(24); });
  it.each(cases)('%j', (text, expected) => {
    expect(check(text, rules).map((h) => h.label)).toEqual(expected);
  });

  it('the bare ten-digit shape is caught too, and a word and a number are both reported', () => {
    expect(check('5550100142', rules).map((h) => h.label)).toEqual(['5550100142']);
    expect(check('Janie at 555.010.0142', rules).map((h) => h.label)).toEqual(['Janie', '555.010.0142']);
  });

  it('reports the list line as the entry, so logs never need the text', () => {
    const hits = check('Maple-Street and 555-010-0142', rules);
    expect(hits.map((h) => h.entry)).toEqual(['Maple Street', PHONE_1]);
  });

  it('does not repeat a hit', () => {
    expect(check('Janie, Janie, JANIE', rules)).toHaveLength(1);
  });
});

describe('loadRules: fail closed', () => {
  it('throws GateError for a missing list', () => {
    expect(() => loadRules(join(tmp, 'nope.txt'))).toThrow(GateError);
  });
  it('throws GateError for an empty list and for one with only comments', () => {
    expect(() => loadRules(listFile(''))).toThrow(/empty/);
    expect(() => loadRules(listFile('# one\n\n   \n# two\n'))).toThrow(GateError);
  });
  it('throws GateError for a path that is a folder', () => {
    const d = join(tmp, 'a-folder');
    mkdirSync(d);
    expect(() => loadRules(d)).toThrow(GateError);
  });
  it('throws GateError for a broken pattern, naming the line but never echoing the pattern', () => {
    const f = listFile('Janie\nre:SECRETPART([\n');
    let err: unknown;
    try { loadRules(f); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GateError);
    expect((err as Error).message).toMatch(/line 2/);
    expect((err as Error).message).not.toMatch(/SECRETPART/);
  });
  it('throws GateError for an empty pattern line and for a line with only invisible characters', () => {
    expect(() => loadRules(listFile('Janie\nre:   \n'))).toThrow(/line 2/);
    expect(() => loadRules(listFile('Janie\n​‍\n'))).toThrow(/line 2/);
  });
  it('counts entries, not comments', () => {
    expect(loadRules(listFile(LIST)).entries).toBe(9);
  });
});

describe('RuleSource: reload on mtime, no restart', () => {
  it('picks up an edited list the next time it is asked', () => {
    const f = listFile('Janie\n');
    const src = new RuleSource({ path: () => f, what: 'word list' });
    expect(check('Springfield', src.get()!)).toEqual([]);
    writeFileSync(f, 'Janie\nSpringfield\n');
    const later = new Date(Date.now() + 5000);
    utimesSync(f, later, later);
    expect(check('Springfield', src.get()!).map((h) => h.label)).toEqual(['Springfield']);
  });
  it('does not re-read an unchanged file', () => {
    const f = listFile('Janie\n');
    const src = new RuleSource({ path: () => f, what: 'word list' });
    expect(src.get()).toBe(src.get());
  });
  it('fails closed when the file is deleted or emptied after a good load', () => {
    const f = listFile('Janie\n');
    const src = new RuleSource({ path: () => f, what: 'word list' });
    src.get();
    rmSync(f);
    expect(() => src.get()).toThrow(GateError);
    writeFileSync(f, '# nothing\n');
    expect(() => src.get()).toThrow(GateError);
  });
  it('an unusable path (refused or unset) is a GateError', () => {
    expect(() => new RuleSource({ path: () => '', what: 'word list' }).get()).toThrow(GateError);
  });
  it('optional: an absent or empty file is off (null), a present broken one still fails closed', () => {
    const f = join(tmp, 'names-later.txt');
    const src = new RuleSource({ path: () => f, what: 'name list', optional: true });
    expect(src.get()).toBeNull();
    expect(src.status()).toEqual({ state: 'off' });
    writeFileSync(f, '');
    expect(src.get()).toBeNull(); // empty means off
    writeFileSync(f, 're:(broken\n');
    const soon = new Date(Date.now() + 4000);
    utimesSync(f, soon, soon);
    expect(() => src.get()).toThrow(GateError);
    writeFileSync(f, 'Pat Placeholder\n');
    const later = new Date(Date.now() + 9000);
    utimesSync(f, later, later);
    expect(src.get()).not.toBeNull();
  });
  it('status reports loaded with a count, or failed with a message, never an entry', () => {
    const f = listFile('Secret Entry\nOther One\n');
    const ok = new RuleSource({ path: () => f, what: 'word list' }).status();
    expect(ok).toEqual({ state: 'loaded', entries: 2 });
    const bad = new RuleSource({ path: () => join(tmp, 'absent.txt'), what: 'word list' }).status();
    expect(bad.state).toBe('failed');
    expect(JSON.stringify(bad)).not.toMatch(/Secret Entry/);
  });
});
