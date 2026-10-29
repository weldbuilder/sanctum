// A small line diff for the identity pages: unified text, three lines of context. Text only. A pair of files whose
// changed middle is too large for the table below is shown as one replaced block, never a hang.
const CELL_CAP = 4_000_000;

type Op = { t: ' ' | '-' | '+'; s: string };

function lines(text: string): string[] {
  if (text === '') return [];
  const out = text.replace(/\r\n/g, '\n').split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

function ops(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const out: Op[] = a.slice(0, head).map((s) => ({ t: ' ', s }));
  if (am.length * bm.length > CELL_CAP) {
    for (const s of am) out.push({ t: '-', s });
    for (const s of bm) out.push({ t: '+', s });
  } else {
    // Longest common subsequence of the changed middle.
    const w = bm.length + 1;
    const table = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = bm.length - 1; j >= 0; j--) {
        table[i * w + j] = am[i] === bm[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) { out.push({ t: ' ', s: am[i] }); i++; j++; }
      else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) out.push({ t: '-', s: am[i++] });
      else out.push({ t: '+', s: bm[j++] });
    }
    while (i < am.length) out.push({ t: '-', s: am[i++] });
    while (j < bm.length) out.push({ t: '+', s: bm[j++] });
  }
  for (const s of a.slice(a.length - tail)) out.push({ t: ' ', s });
  return out;
}

/** Unified diff of `before` to `after` ('' when they are the same text). Headers name the two sides. */
export function unifiedDiff(before: string, after: string, labelBefore: string, labelAfter: string, context = 3): string {
  const all = ops(lines(before), lines(after));
  if (!all.some((o) => o.t !== ' ')) return '';
  const out: string[] = [`--- ${labelBefore}`, `+++ ${labelAfter}`];
  // Hunks: each change with `context` lines around it, overlapping ones merged.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((o, i) => { if (o.t !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep[k] = true; });
  // Running line numbers on each side at every op.
  const aNo: number[] = [];
  const bNo: number[] = [];
  let a = 1;
  let b = 1;
  for (const o of all) { aNo.push(a); bNo.push(b); if (o.t !== '+') a++; if (o.t !== '-') b++; }
  let i = 0;
  while (i < all.length) {
    if (!keep[i]) { i++; continue; }
    let end = i;
    while (end < all.length && keep[end]) end++;
    const slice = all.slice(i, end);
    const aLen = slice.filter((o) => o.t !== '+').length;
    const bLen = slice.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aLen === 0 ? aNo[i] - 1 : aNo[i]},${aLen} +${bLen === 0 ? bNo[i] - 1 : bNo[i]},${bLen} @@`);
    for (const o of slice) out.push(`${o.t}${o.s}`);
    i = end;
  }
  return out.join('\n');
}
