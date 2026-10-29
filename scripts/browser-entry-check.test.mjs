import { describe, it, expect } from 'vitest';
import { entryHasFilter, browserEntryProblem, filterArgs } from '../examples/browser-seat-neko/entry-check.mjs';

const GOOD_TAIL = ['--block', 'browser_run_code_unsafe,browser_evaluate', '--workdir', '/opt/sanctum/data/browser-out', '--', 'npx', '-y', '@playwright/mcp@0.0.83'];
// One filter path per style the entry can be written in; the check must not care which.
const FILTERS = [
  '/opt/sanctum/examples/browser-seat-neko/mcp-filter.mjs',
  'C:\\sanctum\\examples\\browser-seat-neko\\mcp-filter.mjs',
  'C:/sanctum/examples/browser-seat-neko/mcp-filter.mjs',
  '\\\\srv\\share\\sanctum\\examples\\browser-seat-neko\\mcp-filter.mjs',
  './examples/browser-seat-neko/mcp-filter.mjs',
  '..\\mcp-filter.mjs',
  'mcp-filter.mjs',
];
const NODES = ['node', '/usr/bin/node', '/usr/local/bin/node', 'C:\\Program Files\\nodejs\\node.exe', 'C:/Program Files/nodejs/node.exe', 'D:\\tools\\NODE.EXE'];

describe('the filter is recognised by what the entry RUNS, not by a substring', () => {
  it('accepts node (bare, or an absolute path to node / node.exe) running a script whose basename is exactly mcp-filter.mjs', () => {
    for (const command of NODES) for (const f of FILTERS) {
      const entry = { command, args: [f, ...GOOD_TAIL] };
      expect(entryHasFilter(entry), `${command} ${f}`).toBe(true);
      expect(browserEntryProblem(entry), `${command} ${f}`).toBeNull();
    }
  });
  it('accepts the script itself as the command (a shebang entry), with the filter arguments in args', () => {
    for (const f of FILTERS.filter((x) => /^(\/|[A-Za-z]:|\\\\)/.test(x))) {
      const entry = { command: f, args: GOOD_TAIL };
      expect(entryHasFilter(entry), f).toBe(true);
      expect(browserEntryProblem(entry), f).toBeNull();
    }
  });
  it('filterArgs returns what follows the script, and null when there is no filter', () => {
    expect(filterArgs({ command: 'node', args: [FILTERS[0], ...GOOD_TAIL] })).toEqual(GOOD_TAIL);
    expect(filterArgs({ command: FILTERS[0], args: GOOD_TAIL })).toEqual(GOOD_TAIL);
    expect(filterArgs({ command: 'npx', args: ['mcp-filter.mjs'] })).toBeNull();
    expect(filterArgs(null)).toBeNull();
    expect(filterArgs('node')).toBeNull();
  });

  describe('anything that merely CONTAINS mcp-filter.mjs is unfiltered', () => {
    const cases = {
      'a dummy argument to the Playwright server': { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--cdp-endpoint', 'http://127.0.0.1:9232', '--note', 'mcp-filter.mjs'] },
      'a path argument to the Playwright server': { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--user-data-dir', '/x/mcp-filter.mjs'] },
      'the filter arguments after a dummy one, run by npx': { command: 'npx', args: ['dummy', 'mcp-filter.mjs', ...GOOD_TAIL] },
      'node running another script that is given the filter as an argument': { command: 'node', args: ['server.js', '/x/mcp-filter.mjs', ...GOOD_TAIL] },
      'node running a script that only ends the same way': { command: 'node', args: ['/x/not-mcp-filter.mjs', ...GOOD_TAIL] },
      'node running a script with a longer name': { command: 'node', args: ['/x/mcp-filter.mjs.js', ...GOOD_TAIL] },
      'node running a script inside a folder called mcp-filter.mjs': { command: 'node', args: ['/x/mcp-filter.mjs/run.js', ...GOOD_TAIL] },
      'node with a flag first (args[0] is not the script)': { command: 'node', args: ['--no-warnings', FILTERS[0], ...GOOD_TAIL] },
      'a relative node path': { command: 'bin/node', args: [FILTERS[0], ...GOOD_TAIL] },
      'a command that is not node': { command: 'nodejs', args: [FILTERS[0], ...GOOD_TAIL] },
      'another interpreter': { command: 'python3', args: [FILTERS[0], ...GOOD_TAIL] },
      'a command whose path merely contains the name': { command: '/opt/mcp-filter.mjs-dir/bin/evil', args: GOOD_TAIL },
      'a command that is the script name plus a suffix': { command: '/opt/mcp-filter.mjs.sh', args: GOOD_TAIL },
      'a relative script as the command with a different basename': { command: './evil-mcp-filter.mjs', args: GOOD_TAIL },
      'a flag value containing the name': { command: 'node', args: ['--eval=mcp-filter.mjs', ...GOOD_TAIL] },
      'a non-string first argument': { command: 'node', args: [7, ...GOOD_TAIL] },
      'no args at all': { command: 'node' },
      'the name in an env value': { command: 'npx', args: ['-y', '@playwright/mcp'], env: { X: 'mcp-filter.mjs' } },
    };
    for (const [name, entry] of Object.entries(cases)) {
      it(`${name}`, () => {
        expect(entryHasFilter(entry)).toBe(false);
        expect(browserEntryProblem(entry)).toBe('unfiltered');
      });
    }
  });

  it('still reports an entry that runs the real filter with bad arguments as outdated, not unfiltered', () => {
    for (const command of ['node', 'C:\\Program Files\\nodejs\\node.exe']) {
      expect(browserEntryProblem({ command, args: [FILTERS[1], '--block', 'browser_evaluate', '--workdir', 'C:\\w', '--', 'npx'] })).toBe('outdated');
      expect(browserEntryProblem({ command, args: [FILTERS[0], '--block', 'browser_run_code_unsafe,browser_evaluate', '--', 'npx'] })).toBe('outdated');
      expect(browserEntryProblem({ command, args: [FILTERS[0], ...GOOD_TAIL.slice(0, 2), '--workdir', 'rel', '--', 'npx'] })).toBe('outdated');
    }
  });
  it('rejects anything that is not an object', () => {
    for (const e of [null, undefined, 'node', 5, [], true]) expect(browserEntryProblem(e)).toBe('unfiltered');
  });
});
