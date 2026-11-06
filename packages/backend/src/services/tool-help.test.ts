import { describe, it, expect, vi } from 'vitest';
vi.mock('../routes/cc-mcp.js', () => ({ CC_TOOL_NAMES: ['cc_status', 'cc_care', 'cc_cycle'] }));
import { shortToolList, fullToolHelp, topicHelp, TOOL_TOPICS } from './tool-help.js';

const o = { SC: 'res', userName: 'Alex', ccEnabled: true, telegram: false };

describe('tool help', () => {
  it('the short list is small and names every family of tool', () => {
    const s = shortToolList(o);
    expect(s.length).toBeLessThan(900);
    for (const v of ['meal', 'ask', 'canvas', 'orb', 'timer', 'pulse', 'cc ']) expect(s).toContain(v);
    expect(s).toContain('res help <topic>');
    expect(shortToolList({ ...o, ccEnabled: false })).not.toContain('cc <tool>');
  });
  it('the full help is the same content the short list points at, and much bigger', () => {
    const f = fullToolHelp(o);
    expect(f.length).toBeGreaterThan(shortToolList(o).length * 4);
    expect(f).toContain('TIMERS:');
    expect(f).toContain('COMMAND CENTER');
    expect(f).not.toContain('TELEGRAM');
    expect(fullToolHelp({ ...o, telegram: true })).toContain('TELEGRAM');
  });
  it('topic help returns one section, or the topic list', () => {
    expect(topicHelp(o, 'timer')).toMatch(/^TIMERS:\n/);
    expect(topicHelp(o, 'TIMER')).toMatch(/^TIMERS:/);
    expect(topicHelp(o, 'nope')).toMatch(/^Topics: /);
    expect(topicHelp({ ...o, ccEnabled: false }, 'cc')).toMatch(/^Topics: /);
    for (const t of TOOL_TOPICS) expect(typeof topicHelp(o, t)).toBe('string');
  });

  it('the identity topic is read-only: status, and who ratifies', () => {
    expect(shortToolList(o)).toContain('res identity status');
    const t = topicHelp(o, 'identity');
    expect(t).toContain('res identity status');
    expect(t).toMatch(/cannot ratify/);
    expect(fullToolHelp(o)).toContain('IDENTITY (');
  });

  it('the browser topic is listed and servable only when the seat is configured, and stays inside the short-list budget', () => {
    const b = { ...o, browser: true, telegram: true };
    const s = shortToolList(b);
    expect(s).toContain('res help browser');
    expect(s.length).toBeLessThan(1100);
    const t = topicHelp(b, 'browser');
    for (const v of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_take_screenshot', 'res ask', '.claude/skills/browser/SKILL.md']) expect(t).toContain(v);
    expect(t).toContain('integrations.browser_url');
    expect(t).toMatch(/no viewer tab/);
    expect(fullToolHelp(b)).toContain('BROWSER (');
    expect(shortToolList(o)).not.toContain('help browser');
    expect(topicHelp(o, 'browser')).toMatch(/^Topics: /);
    expect(topicHelp(o, 'browser')).not.toContain('browser,');
  });

  it('plugin topics are one line each in the index and servable by id; no plugins changes nothing', () => {
    const p = { ...o, pluginHelp: { hello: 'hello: example plugin.\nSecond line.', other: 'x'.repeat(200) } };
    const s = shortToolList(p);
    const lines = s.split('\n').filter((l) => l.includes('help hello') || l.includes('help other'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('hello: example plugin.');
    expect(lines[0]).not.toContain('Second line');
    expect(lines[1].length).toBeLessThan(160);
    expect(topicHelp(p, 'hello')).toBe('hello: example plugin.\nSecond line.');
    expect(topicHelp(p, 'nope')).toContain('hello, other');
    expect(fullToolHelp(p)).toContain('PLUGIN hello:\nhello: example plugin.');
    expect(shortToolList({ ...o, pluginHelp: {} })).toBe(shortToolList(o));
    expect(fullToolHelp({ ...o, pluginHelp: {} })).toBe(fullToolHelp(o));
    expect(topicHelp(p, 'constructor')).toMatch(/^Topics: /);
  });

  it('SHOULD-FIX 4: a plugin line aligns with the built-in rows under a realistic long SC, not a fixed 49', () => {
    const SC = 'node /Users/someone/Documents/sanctum-mobile/tools/res.mjs';
    const p = { ...o, SC, pluginHelp: { hello: 'hello: example plugin.', 'longer-plugin-id': 'longer: another.' } };
    const lines = shortToolList(p).split('\n');
    // the column where each row's description starts, measured from the end of the SC prefix
    const descCol = (l: string, desc: string) => l.indexOf(desc) - `  ${SC} `.length;
    const builtin = descCol(lines.find((l) => l.includes('permission, waits'))!, 'permission, waits');
    expect(builtin).toBeGreaterThan(20);
    expect(descCol(lines.find((l) => l.includes('help hello'))!, 'hello: example')).toBe(builtin);
    expect(descCol(lines.find((l) => l.includes('help longer-plugin-id'))!, 'longer: another')).toBe(builtin);
    const short = shortToolList({ ...o, pluginHelp: { hello: 'hello: example plugin.' } }).split('\n');
    expect(short.find((l) => l.includes('help hello'))!.indexOf('hello: example')).toBe(short.find((l) => l.includes('permission, waits'))!.indexOf('permission, waits'));
  });
});

describe('what is not set up (the companion can say so, and is never offered it)', () => {
  const PICTURES = 'Pictures: not set up on this install (the person can enable it; see UPGRADE.md, "Pictures and companion-voiced summaries")';
  const PICTURES_APP_WRITE = 'Pictures: off on this install while app writes are disabled (agent.app_write)';
  const VOICE = 'Voice: not set up on this install (the person can enable it; see UPGRADE.md, "Pictures and companion-voiced summaries", What to add)';

  it('adds one Pictures line only when image generation is explicitly not offered', () => {
    const off = shortToolList({ ...o, image: false });
    expect(off.split('\n').filter((l) => l.includes('Pictures:'))).toEqual([`  ${PICTURES}`]);
    expect(shortToolList({ ...o, image: true })).not.toContain('Pictures:');
    expect(shortToolList(o)).not.toContain('Pictures:'); // unset: the caller did not say
    expect(shortToolList({ ...o, image: true })).toContain('res image "prompt"'); // offered: the verb, not the line
    expect(off).not.toContain('res image'); // not offered: no verb, no topic
    expect(topicHelp({ ...o, image: false }, 'image')).toMatch(/^Topics: /);
  });

  it('says app writes are off, not "not set up", when pictures are configured but agent.app_write is off', () => {
    const off = shortToolList({ ...o, image: false, imageReason: 'app_write_off' });
    expect(off.split('\n').filter((l) => l.includes('Pictures:'))).toEqual([`  ${PICTURES_APP_WRITE}`]);
    expect(off).not.toContain('not set up');
    expect(off).not.toContain('res image');
    expect(shortToolList({ ...o, image: false, imageReason: 'not_configured' })).toContain(PICTURES);
  });

  it('drops the voice verbs from the short list and the topics when voice is off, and keeps them when it is on or unset', () => {
    const off = shortToolList({ ...o, voice: false, telegram: true });
    expect(off).not.toMatch(/\| voice \|/);
    expect(off).not.toMatch(/tg [a-z|]*voice/);
    expect(fullToolHelp({ ...o, voice: false, telegram: true })).not.toMatch(/ voice "/);
    for (const on of [{ ...o, voice: true, telegram: true }, { ...o, telegram: true }]) {
      expect(shortToolList(on)).toContain('| voice |');
      expect(shortToolList(on)).toContain('react|voice|text');
      expect(fullToolHelp(on)).toMatch(/ voice "/);
    }
  });

  it('adds one Voice line only when voice is explicitly off', () => {
    expect(shortToolList({ ...o, voice: false }).split('\n').filter((l) => l.includes('Voice:'))).toEqual([`  ${VOICE}`]);
    expect(shortToolList({ ...o, voice: true })).not.toContain('Voice:');
    expect(shortToolList(o)).not.toContain('Voice:');
  });

  it('both lines together stay inside the short-list budget; the full help carries them once', () => {
    const both = { ...o, image: false, voice: false };
    expect(shortToolList(both).length).toBeLessThan(1100);
    const f = fullToolHelp(both);
    expect(f.split(PICTURES)).toHaveLength(2);
    expect(f.split(VOICE)).toHaveLength(2);
    expect(fullToolHelp({ ...o, image: true, voice: true })).not.toMatch(/not set up on this install/);
  });
});
