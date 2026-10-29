import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './diff.js';

describe('unifiedDiff', () => {
  it('is empty for the same text, whatever the line endings', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x', 'y')).toBe('');
    expect(unifiedDiff('a\r\nb', 'a\nb\n', 'x', 'y')).toBe('');
  });

  it('shows a change with three lines of context and the right line numbers', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n');
    const after = ['1', '2', '3', '4', 'five', '6', '7', '8', '9', '10'].join('\n');
    expect(unifiedDiff(before, after, 'a', 'b')).toBe(['--- a', '+++ b', '@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8'].join('\n'));
  });

  it('two far-apart changes are two hunks', () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l2\n', 'L2\n').replace('l27\n', 'L27\n');
    const out = unifiedDiff(before, after, 'a', 'b');
    expect(out.split('\n').filter((l) => l.startsWith('@@'))).toHaveLength(2);
  });

  it('an added and a removed whole file', () => {
    expect(unifiedDiff('', 'new\n', '/dev/null', 'b')).toBe('--- /dev/null\n+++ b\n@@ -0,0 +1,1 @@\n+new');
    expect(unifiedDiff('old', '', 'a', '/dev/null')).toBe('--- a\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old');
  });

  it('a huge changed middle does not hang: it is one replaced block', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const out = unifiedDiff(a, b, 'x', 'y');
    expect(out.split('\n').filter((l) => l.startsWith('-a')).length).toBe(3000);
    expect(out.split('\n').filter((l) => l.startsWith('+b')).length).toBe(3000);
  });
});
