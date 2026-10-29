// Who is speaking, as the frame and the record both name them: `displayName (@username)`, plus `, bot`
// for a bot. Display names are untrusted text (a stranger picks them), so they are flattened to one
// capped line with control characters removed before they go anywhere.

export interface PublicSpeaker {
  id: string;
  displayName: string;
  username: string;
  bot: boolean;
}

/** Characters that draw nothing but change how the text around them reads or is laid out: bidi controls (U+202A to U+202E,
 *  U+2066 to U+2069), zero-width characters (U+200B to U+200D, U+2060, U+FEFF) and every other format character (Cf). A name
 *  carrying them can reorder the line after it, or look like someone else's. */
export const INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF\p{Cf}]/gu;

/** Characters that draw as nothing, or as an empty box, in a name: the Hangul fillers (U+3164, U+115F, U+1160, U+FFA0), the
 *  braille blank (U+2800) and the no-break spaces. A name made only of them (and whitespace) looks like no name at all. */
const BLANK_LOOKING = /^[\s\u3164\u115F\u1160\uFFA0\u2800\u00A0\u202F\u2007\u2060]*$/u;
/** Bidi controls (the embeddings, overrides and isolates, the marks LRM, RLM and ALM) and the Unicode tag characters
 *  (U+E0000 to U+E007F, which can carry a hidden message or the tail of a flag). */
const BIDI_AND_TAGS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u{E0000}-\u{E007F}]/gu;

/** `t` cut at `cap` code points (never through a surrogate pair), with an ellipsis when something was cut. */
function cutAt(t: string, cap: number): string {
  if (t.length <= cap) return t;
  const cps = Array.from(t);
  return cps.length > cap ? `${cps.slice(0, cap).join('')}…` : t;
}

/** One line of an untrusted NAME: control (C0 and C1) and invisible characters out, lone surrogates out, whitespace
 *  collapsed, capped by code points. A name that is only blank-looking characters comes back empty. Not for message text
 *  (see bodyLine): this takes zero-width joiners and every other format character, which a name has no use for. */
export function oneLine(s: string, cap: number): string {
  // eslint-disable-next-line no-control-regex
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/[\u0080-\u009f]/g, '').replace(/\p{Cs}/gu, '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (BLANK_LOOKING.test(t)) return '';
  return cutAt(t, cap);
}

/** One line of untrusted MESSAGE TEXT for the frame: line breaks and control characters flatten to spaces (so a message cannot
 *  open a line of its own), bidi controls and tag characters go, lone surrogates go; everything else stays, a zero-width
 *  joiner and the variation selectors included (an emoji sequence is one picture). Capped by code points. */
export function bodyLine(s: string, cap: number): string {
  // eslint-disable-next-line no-control-regex
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\p{Cs}/gu, '').replace(BIDI_AND_TAGS, '').replace(/\s+/g, ' ').trim();
  return cutAt(t, cap);
}

const NAME_CAP = 32;

/** `displayName (@username)`, plus `, bot` for a bot when `withBotTag`. */
export function speakerLabel(s: PublicSpeaker, withBotTag = false): string {
  // The display name is chosen by a stranger: capped on its own, so the handle and the bot tag after it are never cut off.
  // (A Discord username is at most 32 characters.)
  const name = oneLine(s.displayName, NAME_CAP) || oneLine(s.username, NAME_CAP) || 'unnamed';
  const handle = oneLine(s.username, NAME_CAP);
  const label = handle ? `${name} (@${handle})` : name;
  return withBotTag && s.bot ? `${label}, bot` : label;
}
