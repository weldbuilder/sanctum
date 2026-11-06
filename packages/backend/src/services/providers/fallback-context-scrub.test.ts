import { describe, it, expect } from 'vitest';
import { scrubFallbackContext } from './openai-compat-harness.js';

describe('scrubFallbackContext: the orientation makes no tool claim the fallback cannot keep', () => {
  const SC = 'node /srv/sanctum-home/tools/res.mjs';
  const opts = { SC, userName: 'Sam', ccEnabled: true, browser: false, image: false, voice: true, telegram: false } as any;
  const wrap = (tools: string) => `[Context]\nCHANNEL: web chat. Tool activity (tool_use/tool_result) shows live in the UI sidebar. You can use markdown.\n[env] sanctum (web)\n${tools}\nEXPRESSION (write these inside a reply):\n  [tag: x]\n[/Context]`;
  it('drops the short TOOLS list, keeps EXPRESSION and the env line, removes the sidebar sentence', async () => {
    const { shortToolList } = await import('../tool-help.js');
    const out = scrubFallbackContext(wrap(shortToolList(opts)));
    expect(out).not.toMatch(/res\.mjs|run via Bash|sidebar|Bash/);
    expect(out).toContain('[env] sanctum (web)');
    expect(out).toContain('EXPRESSION (write these inside a reply):\n  [tag: x]');
    expect(out).toContain('You can use markdown.');
  });
  it('drops the full reference too', async () => {
    const { fullToolHelp } = await import('../tool-help.js');
    const out = scrubFallbackContext(wrap(fullToolHelp(opts)));
    expect(out).not.toMatch(/res\.mjs|TIMERS|MEALS/);
    expect(out).toContain('EXPRESSION');
  });
  it('leaves text outside the [Context] block alone', () => {
    expect(scrubFallbackContext('node /x/tools/res.mjs is what the person typed')).toBe('node /x/tools/res.mjs is what the person typed');
  });
});
