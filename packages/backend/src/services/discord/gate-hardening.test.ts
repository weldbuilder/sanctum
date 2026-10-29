// Verifier pass-A findings against the gate: optional list semantics, regex strictness,
// the file stamp, and error kinds that carry no path.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GateError, RuleSource, check, rulesFromText } from './gate.js';

const tmp = mkdtempSync(join(tmpdir(), 'sanctum-gate-hard-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = (body: string) => { const p = join(tmp, `l${n++}.txt`); writeFileSync(p, body); return p; };

describe('an optional list (names): absent or empty means off, malformed means fail closed', () => {
  const source = (p: string) => new RuleSource({ path: () => p, what: 'name list', optional: true });

  it('an empty file is off', () => {
    const s = source(file(''));
    expect(s.get()).toBeNull();
    expect(s.status()).toEqual({ state: 'off' });
  });
  it('a comments-and-blanks-only file is off', () => {
    const s = source(file('# nothing yet\n\n   \n# still nothing\n'));
    expect(s.get()).toBeNull();
    expect(s.status()).toEqual({ state: 'off' });
  });
  it('a malformed pattern still fails closed', () => {
    const s = source(file('re:(unclosed\n'));
    expect(() => s.get()).toThrow(GateError);
    expect(s.status().state).toBe('failed');
  });
  it('the WORD list stays strict: empty is a failure', () => {
    const s = new RuleSource({ path: () => file('# only a comment\n'), what: 'word list' });
    expect(() => s.get()).toThrow(/empty/);
  });
});

describe('re: lines', () => {
  it('a pattern that matches the empty string is rejected at load', () => {
    for (const p of ['re:x*', 're:(?:)', 're:a?', 're:\\s*']) {
      expect(() => rulesFromText(`Janie\n${p}\n`), p).toThrow(/line 2.*empty string/);
    }
  });
  it('a degenerate pattern is rejected at load: one that matches a single "a", " " or "." would flag nearly every message', () => {
    for (const p of ['re:.', 're:\\w', 're:[a-z]', 're:\\s', 're:\\S', 're:[^0-9]', 're:a', 're: ']) {
      let err: unknown;
      try { rulesFromText(`Janie\n${p}\n`); } catch (e) { err = e; }
      // a trailing-space "re: " is an empty pattern and was rejected before; the rest are the new rule
      expect(err, p).toBeInstanceOf(GateError);
      expect((err as GateError).message, p).toMatch(/line 2/);
      expect((err as GateError).kind, p).toBe('malformed');
    }
    expect(() => rulesFromText('Janie\nre:.\n')).toThrow(/too broad|degenerate|single character/);
  });
  // SHOULD-FIX 3: the three-character probe ('a', ' ', '.') let `e`, `..`, `\w\w`, `[b-z]`, `t|e|o`, `[\s\S]{2}` and `\b` through,
  // and each of them flags nearly every message. The probe is a corpus: a pattern that matches 2 or more of 12 ordinary short
  // messages is refused at load.
  it('a pattern that matches 2 or more of 12 ordinary short messages is rejected at load', () => {
    for (const p of ['re:e', 're:..', 're:\\w\\w', 're:[b-z]', 're:t|e|o', 're:[\\s\\S]{2}', 're:\\b', 're:a*', 're:', 're:o', 're:[aeiou]', 're:\\w+']) {
      let err: unknown;
      try { rulesFromText(`Janie\n${p}\n`); } catch (e) { err = e; }
      expect(err, p).toBeInstanceOf(GateError);
      expect((err as GateError).kind, p).toBe('malformed');
      expect((err as GateError).message, p).toMatch(/line 2/);
    }
    expect(() => rulesFromText('Janie\nre:e\n')).toThrow(/too broad/);
  });
  it('the corpus rule is the documented one: a pattern matching at most 1 of the 12 loads', () => {
    for (const p of ['re:\\bhello\\b', 're:zq', 're:maple\\s+st']) expect(rulesFromText(`Janie\n${p}\n`).entries, p).toBe(2);
  });
  // B2.2: a pattern that matches ONE ordinary message, or one single character, still flags a huge share of what she writes
  // (a `\.`, a `,`, an apostrophe, a `p`). Two more probes: a zero-width match anywhere in the corpus, and any single
  // printable ASCII character tested alone (0x20..0x7E).
  it('a pattern that matches any single printable ASCII character alone is rejected at load', () => {
    for (const p of ['re:\\.', 're:,', "re:'", 're:p', 're:c', 're:f', 're:!', 're:\\?', 're:\\d', 're:(?=x)', 're:[0-9]', 're:\\W', 're:-', 're: ']) {
      let err: unknown;
      try { rulesFromText(`Janie\n${p}\n`); } catch (e) { err = e; }
      expect(err, p).toBeInstanceOf(GateError);
      expect((err as GateError).kind, p).toBe('malformed');
      expect((err as GateError).message, p).toMatch(/line 2/);
    }
    expect(() => rulesFromText('re:\\.\n')).toThrow(/too broad|single character/);
  });
  it('a pattern whose match on any corpus string is the empty string is rejected at load', () => {
    for (const p of ['re:(?<=ok)', 're:(?=hello)', 're:(?<=see you at )', 're:\\bhello\\b|(?=what)', 're:(?:brb)?(?=\\s*$)(?<=lol)']) {
      let err: unknown;
      try { rulesFromText(`Janie\n${p}\n`); } catch (e) { err = e; }
      expect(err, p).toBeInstanceOf(GateError);
      expect((err as GateError).kind, p).toBe('malformed');
      expect((err as GateError).message, p).toMatch(/line 2/);
    }
    expect(() => rulesFromText('re:(?<=ok)\n')).toThrow(/empty|zero-width/);
  });
  it('the phone patterns still load and still catch phone numbers, and not "10 minutes" or "2026"', () => {
    const rules = rulesFromText('re:(?:\\+1[\\s.-]?)?\\(?\\b\\d{3}\\)?[\\s.-]\\d{3}[\\s.-]\\d{4}\\b\nre:\\b\\d{3}[-.\\s]\\d{3}[-.\\s]\\d{4}\\b\n');
    expect(rules.entries).toBe(2);
    expect(check('call 555-123-4567 now', rules)).toHaveLength(1);
    expect(check('call +1 (555) 123 4567 now', rules).length).toBeGreaterThan(0);
    expect(check('back in 10 minutes', rules)).toHaveLength(0);
    expect(check('see you in 2026', rules)).toHaveLength(0);
  });
  it('a legitimate phone-number pattern still loads and still catches the number', () => {
    const rules = rulesFromText('re:\\b\\d{3}[-.\\s]\\d{3}[-.\\s]\\d{4}\\b\n');
    expect(rules.entries).toBe(1);
    expect(check('call me on 555-123-4567', rules)).toHaveLength(1);
    expect(check('see you at 5', rules)).toHaveLength(0);
  });
  it('the shipped example patterns and ordinary specific ones still load', () => {
    const ok = ['re:\\b\\d{3}[-.\\s]\\d{3}[-.\\s]\\d{4}\\b', 're:\\(\\d{3}\\)\\s*\\d{3}[-.\\s]?\\d{4}', 're:(?<!\\d)\\d{10}(?!\\d)', 're:maple\\s+st\\.?', 're:\\p{L}+-\\d{3}'];
    expect(rulesFromText(`${ok.join('\n')}\n`).entries).toBe(ok.length);
  });
  it('a pattern that is only valid without the u flag fails the line, not silently loads without u', () => {
    // "\-" is a legal escape without the u flag and a syntax error with it.
    expect(() => rulesFromText('re:maple\\-street\n')).toThrow(/line 1.*not a valid pattern/);
  });
  it('a pattern valid in unicode mode still loads', () => {
    expect(rulesFromText('re:\\p{L}+-\\d{3}\n').entries).toBe(1);
  });
});

/** A whole-second time, so two files can carry exactly the same mtime. */
const SAME = 1_700_000_000;

describe('the reload stamp', () => {
  it('sees a same-size edit that keeps the same mtime', () => {
    const p = file('Janie\n');
    utimesSync(p, SAME, SAME);
    const s = new RuleSource({ path: () => p, what: 'word list' });
    expect(s.get()!.rules[0].entry).toBe('Janie');
    writeFileSync(p, 'Jamie\n'); // same size
    utimesSync(p, SAME, SAME);
    expect(s.get()!.rules[0].entry).toBe('Jamie');
  });
  it('sees an atomic rename-replace of the same size and mtime', () => {
    const p = file('Janie\n');
    utimesSync(p, SAME, SAME);
    const s = new RuleSource({ path: () => p, what: 'word list' });
    expect(s.get()!.rules[0].entry).toBe('Janie');
    const next = file('Jamie\n');
    utimesSync(next, SAME, SAME);
    renameSync(next, p);
    expect(s.get()!.rules[0].entry).toBe('Jamie');
  });
});

describe('errors say what kind of trouble, with no path', () => {
  it('a missing, empty, malformed and refused list', () => {
    const missing = new RuleSource({ path: () => join(tmp, 'nope.txt'), what: 'word list' }).status();
    const empty = new RuleSource({ path: () => file('# x\n'), what: 'word list' }).status();
    const bad = new RuleSource({ path: () => file('re:(\n'), what: 'word list' }).status();
    const refused = new RuleSource({ path: () => '', what: 'word list' }).status();
    expect(missing).toEqual({ state: 'failed', kind: 'missing' });
    expect(empty).toEqual({ state: 'failed', kind: 'empty' });
    expect(bad).toEqual({ state: 'failed', kind: 'malformed' });
    expect(refused).toEqual({ state: 'failed', kind: 'refused' });
    expect(JSON.stringify([missing, empty, bad, refused])).not.toContain(tmp);
  });
});
