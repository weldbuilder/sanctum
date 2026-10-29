// The word gate and the real-name guard.
//
// A private list file (one entry per line) is compiled to whole-word patterns and held
// against every outgoing public message. The shape is ported from the reference gate
// (gate.py in "Guarding Your Person Online"); the lists are not. The gate never edits a
// message: it returns what it found, and the sender blocks.
//
//   - NFKC-normalised, invisible characters stripped, on both the list and the text.
//   - A plain entry matches whole words only, case-insensitively, with any spacing or
//     punctuation (or none) between the words of the entry: "Maple Street" catches
//     "maple-street", "MapleStreet" and "#MapleStreet", not "Maple Streets".
//   - A line starting `re:` is a regular expression.
//   - Blank lines and `#` comments are ignored.
//   - Fail closed: a missing, unreadable, empty or malformed list throws GateError, and
//     the caller treats that as "block everything". The one exception is an OPTIONAL list (the
//     name guard): absent or empty (blank lines and comments only) means the guard is off, while a
//     malformed line still fails closed.
//   - A `re:` line is compiled in unicode mode only (a line that is valid only without it fails
//     the line rather than loading quietly weaker), and a pattern that matches the empty string
//     is rejected at load: it would flag every message. So is one that matches a single "a", a space or a
//     ".": that would flag nearly every message too.
//   - GateError messages never repeat a list entry, so they are safe to log and to show.
//
// The list is re-read when its file changes (mtime, size, inode or ctime: so an in-place edit that
// keeps the size and mtime, and an atomic rename-replace, both reload).

import { statSync } from 'node:fs';
import { readOwnOrApp } from '../../tenancy/own-files.js';
import { contentStamp } from './stamp.js';

/** What kind of trouble, with no path and no entry in it: safe for the status surface. */
export type GateErrorKind = 'missing' | 'empty' | 'malformed' | 'refused' | 'unreadable';

export class GateError extends Error {
  constructor(message: string, readonly kind: GateErrorKind = 'malformed') {
    super(message);
    this.name = 'GateError';
  }
}

export interface Rule {
  /** The list line, trimmed (a `re:` line keeps its prefix). */
  entry: string;
  pattern: RegExp;
  isPattern: boolean;
}

export interface Rules {
  path: string;
  entries: number;
  rules: Rule[];
}

export interface GateHit {
  /** The list line that matched. Safe to log. */
  entry: string;
  /** What to tell the companion: the entry for a word, what the pattern caught for a `re:` line. */
  label: string;
}

/** Characters that can hide inside a word: format controls (zero-width, bidi, soft hyphen, word joiner,
 *  BOM, tags) and the few invisible fillers that are not Cf. */
const INVISIBLE = /[\p{Cf}͏ᅟᅠ឴឵᠋-᠍ㅤ︀-️ﾠ]/gu;

export function normalize(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '');
}

/** Twelve ordinary short messages. A `re:` line that matches two or more of them would flag nearly every reply she
 *  could write, so it is refused at load. (A three-character probe let `e`, `..`, `\w\w`, `[b-z]`, `t|e|o` and `\b` through.) */
const DEGENERATE_CORPUS = ['the', 'and', 'hello there', 'ok', 'see you at 5', 'what time', 'brb', 'lol', 'thanks', 'good morning', 'I think so', 'no'];
const DEGENERATE_MAX_MATCHES = 1;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Unicode mode only, so \p{L} works and a line is held to one grammar. A line that is valid only
 *  without the `u` flag throws: it is the person's to fix, never quietly loaded in a looser mode. */
function compileRegex(source: string): RegExp {
  return new RegExp(source, 'iu');
}

/** Compile list text. `where` names the list in errors. Throws GateError. `allowEmpty` returns a list
 *  with no entries instead of failing (the optional name guard). */
export function rulesFromText(text: string, where = 'the list', opts: { allowEmpty?: boolean } = {}): Rules {
  const rules: Rule[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const number = i + 1;
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    let pattern: RegExp;
    const isPattern = line.startsWith('re:');
    if (isPattern) {
      const source = line.slice(3).trim();
      if (!source) throw new GateError(`line ${number} of ${where} is an empty pattern`, 'malformed');
      try { pattern = compileRegex(source); }
      catch { throw new GateError(`line ${number} of ${where} is not a valid pattern`, 'malformed'); }
      if (pattern.test('')) throw new GateError(`line ${number} of ${where} is a pattern that matches the empty string, so it would flag every message`, 'malformed');
      // A pattern that matches 2 or more of 12 ordinary short messages is as good as empty: it would flag nearly
      // every message, and every reply would be blocked. (No `g`/`y` flag, so test() keeps no state between probes.)
      // Two more probes. A zero-width match on any corpus string (a lookaround that happens to sit there) is a pattern that
      // matches "nothing" at a place found in nearly every message; and a pattern that matches ANY one printable ASCII
      // character alone (`\.`, `,`, `'`, `p`, `\d`, `(?=x)`) flags a large share of everything she could write.
      for (const probe of DEGENERATE_CORPUS) {
        const m = pattern.exec(probe);
        if (m && m[0] === '') throw new GateError(`line ${number} of ${where} is too broad: the pattern matches the empty string in an ordinary short message ("${probe}"), so it would flag nearly every message`, 'malformed');
      }
      for (let c = 0x20; c <= 0x7e; c++) {
        if (pattern.test(String.fromCharCode(c))) throw new GateError(`line ${number} of ${where} is too broad: the pattern matches a single character (such as "${String.fromCharCode(c)}"), so it would flag nearly every message`, 'malformed');
      }
      const matched = DEGENERATE_CORPUS.filter((probe) => pattern.test(probe)).length;
      if (matched > DEGENERATE_MAX_MATCHES) throw new GateError(`line ${number} of ${where} is too broad: the pattern matches ${matched} of ${DEGENERATE_CORPUS.length} ordinary short messages ("the", "ok", "see you at 5", ...), so it would flag nearly every message`, 'malformed');
    } else {
      // Whole words only. Between the words of one entry, any spacing or punctuation, or none.
      const parts = normalize(line).split(/\s+/).filter(Boolean).map(escapeRegExp);
      if (!parts.length) throw new GateError(`line ${number} of ${where} has nothing in it once invisible characters are removed`, 'malformed');
      pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${parts.join('[^\\p{L}\\p{N}]*')}(?![\\p{L}\\p{N}_])`, 'iu');
    }
    rules.push({ entry: line, pattern, isPattern });
  }
  if (!rules.length && !opts.allowEmpty) throw new GateError(`${where} is empty`, 'empty');
  return { path: '', entries: rules.length, rules };
}

/** Read and compile a list file. Throws GateError. */
export function loadRules(path: string, opts: { allowEmpty?: boolean } = {}): Rules {
  let text: string;
  try { text = readOwnOrApp(path); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new GateError(`cannot read the list at ${path} (${code || 'error'})`, code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  const where = `the list at ${path}`;
  const rules = rulesFromText(text, where, opts);
  rules.path = path;
  return rules;
}

/** What `text` contains from the list. An empty array means clear. */
export function check(text: string, rules: Rules): GateHit[] {
  const clean = normalize(text);
  const hits: GateHit[] = [];
  for (const rule of rules.rules) {
    const m = rule.pattern.exec(clean);
    if (!m) continue;
    const label = rule.isPattern ? m[0] : rule.entry;
    if (!hits.some((h) => h.label === label)) hits.push({ entry: rule.entry, label });
  }
  return hits;
}

export type GateStatus =
  | { state: 'loaded'; entries: number }
  | { state: 'off' }
  /** `kind` only: never a path, never an entry. The full message (with the path) is for the server log. */
  | { state: 'failed'; kind: GateErrorKind };

export interface RuleSourceOptions {
  /** Where the list is, now. '' means unusable (refused or unset). Read on every call, so config can change. */
  path: () => string;
  /** What to call the list in errors: "word list", "name list". */
  what: string;
  /** An absent file means "off" (null) instead of a failure. A present file that is broken still fails. */
  optional?: boolean;
}

/** A list that reloads itself when the file changes. */
export class RuleSource {
  private cached: { path: string; stamp: string; rules: Rules | null } | null = null;

  constructor(private readonly opts: RuleSourceOptions) {}

  /** The current rules, or null when optional and absent or empty. Throws GateError. */
  get(): Rules | null {
    const path = this.opts.path();
    if (!path) throw new GateError(`the ${this.opts.what} has no usable path (unset, or refused because it is inside a folder the companion can write)`, 'refused');
    try { statSync(path); }
    catch (e) {
      this.cached = null;
      const code = (e as NodeJS.ErrnoException).code;
      if (this.opts.optional && code === 'ENOENT') return null;
      throw new GateError(`cannot read the ${this.opts.what} at ${path} (${code || 'error'})`, code === 'ENOENT' ? 'missing' : 'unreadable');
    }
    // Content, not a stat stamp: a same-size edit that keeps the mtime leaves every stat field alone on Windows.
    let stamp: string;
    try { stamp = contentStamp(path); }
    catch (e) {
      this.cached = null;
      const code = (e as NodeJS.ErrnoException).code;
      throw new GateError(`cannot read the ${this.opts.what} at ${path} (${code || 'error'})`, code === 'ENOENT' ? 'missing' : 'unreadable');
    }
    if (this.cached && this.cached.path === path && this.cached.stamp === stamp) return this.cached.rules;
    this.cached = null;
    const loaded = loadRules(path, { allowEmpty: !!this.opts.optional });
    const rules = loaded.entries === 0 ? null : loaded;
    this.cached = { path, stamp, rules };
    return rules;
  }

  /** For the status surface: how the list stands, never what is in it and never where it is. */
  status(): GateStatus {
    return this.inspect().status;
  }

  /** The status plus, when failed, the full message (it names the path: for the server log only). */
  inspect(): { status: GateStatus; message?: string } {
    try {
      const r = this.get();
      return { status: r ? { state: 'loaded', entries: r.entries } : { state: 'off' } };
    } catch (e) {
      const kind: GateErrorKind = e instanceof GateError ? e.kind : 'unreadable';
      return { status: { state: 'failed', kind }, message: (e as Error).message };
    }
  }
}
