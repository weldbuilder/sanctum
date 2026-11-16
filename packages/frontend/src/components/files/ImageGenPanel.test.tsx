import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImageGenForm, type ImageGenFormProps } from './ImageGenPanel';
import { generateBody, type ReferenceItem } from './references';

const base: ImageGenFormProps = {
  status: { configured: false, offered: false, reason: 'not_configured' },
  prompt: '', generating: false, error: '',
  onPrompt: () => undefined, onGenerate: () => undefined, onCancel: () => undefined,
};

describe('the image generation panel in Files', () => {
  it('not offered: one plain reason, the controls and Generate disabled', () => {
    const html = renderToStaticMarkup(<ImageGenForm {...base} />);
    expect(html).toContain("Image generation isn&#x27;t set up yet. Ask your companion or see docs/CONFIGURATION.md → imagegen.");
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toMatch(/<button type="submit" class="fl-btn fl-btn-primary hearth-press" disabled="">Generate<\/button>/);
    expect(html).toContain('fl-plate');
  });

  it('app writes off names the setting', () => {
    const html = renderToStaticMarkup(<ImageGenForm {...base} status={{ configured: true, offered: false, reason: 'app_write_off', provider: 'runware' }} />);
    expect(html).toContain('Companion app writes are off in Settings → permissions');
  });

  it('offered and idle: Generate waits for a prompt, then enables', () => {
    const status = { configured: true, offered: true, provider: 'runware', model: 'm' };
    expect(renderToStaticMarkup(<ImageGenForm {...base} status={status} />)).toMatch(/type="submit"[^>]*disabled/);
    const ready = renderToStaticMarkup(<ImageGenForm {...base} status={status} prompt="a fox" />);
    expect(ready).not.toMatch(/type="submit"[^>]*disabled/);
    expect(ready).not.toContain('Provider');
    expect(ready).not.toContain('hsel-trigger');
  });

  it('generating and error lines', () => {
    const status = { configured: true, offered: true, provider: 'runware' };
    expect(renderToStaticMarkup(<ImageGenForm {...base} status={status} prompt="x" generating />)).toContain('Generating…');
    expect(renderToStaticMarkup(<ImageGenForm {...base} status={status} prompt="x" error="Provider key was rejected" />)).toContain('Provider key was rejected');
  });
});

describe('reference chips in the Generate panel', () => {
  const status = { configured: true, offered: true, provider: 'runware', model: 'm' };
  const ref = (id: string, name: string, self = false): ReferenceItem => ({ id, name, self, note: '', fileId: `f${id}`, url: `/api/files/f${id}`, createdAt: '' });
  const refs = [ref('1', 'Echo', true), ref('2', 'Sam'), ref('3', 'Lake house'), ref('4', 'Boat'), ref('5', 'Dog')];
  const chips = (html: string) => [...html.matchAll(/<button type="button" class="fl-gen-chip" aria-pressed="(true|false)"([^>]*)>([^<]*)<\/button>/g)].map(m => [m[3], m[1], /disabled/.test(m[2])]);

  it('no references: no chip row at all, and the panel is as it was', () => {
    const html = renderToStaticMarkup(<ImageGenForm {...base} status={status} refs={[]} />);
    expect(html).not.toContain('class="fl-gen-chips"');
    expect(html).not.toContain('As you');
    expect(renderToStaticMarkup(<ImageGenForm {...base} status={status} />)).not.toContain('class="fl-gen-chips"');
  });

  it('with references: "As you" first (only because one is marked as the companion), then a chip each, own ones labelled (you)', () => {
    const html = renderToStaticMarkup(<ImageGenForm {...base} status={status} refs={refs} />);
    expect(chips(html).map(c => c[0])).toEqual(['As you', 'Echo (you)', 'Sam', 'Lake house', 'Boat', 'Dog']);
    const noSelf = renderToStaticMarkup(<ImageGenForm {...base} status={status} refs={refs.slice(1)} />);
    expect(chips(noSelf).map(c => c[0])).not.toContain('As you');
    expect(html).not.toContain('Up to four.');
  });

  it('picked chips are pressed; "As you" presses and locks the companion\'s own chips', () => {
    const html = renderToStaticMarkup(<ImageGenForm {...base} status={status} refs={refs} picked={['Sam']} asSelf />);
    expect(chips(html)).toEqual([['As you', 'true', false], ['Echo (you)', 'true', true], ['Sam', 'true', false], ['Lake house', 'false', false], ['Boat', 'false', false], ['Dog', 'false', false]]);
  });

  it('at four the rest are disabled and a quiet note says so; the picked ones stay clickable', () => {
    const html = renderToStaticMarkup(<ImageGenForm {...base} status={status} refs={refs} picked={['Sam', 'Lake house', 'Boat', 'Dog']} />);
    expect(html).toContain('Up to four.');
    expect(chips(html)).toEqual([['As you', 'false', false], ['Echo (you)', 'false', true], ['Sam', 'true', false], ['Lake house', 'true', false], ['Boat', 'true', false], ['Dog', 'true', false]]);
  });

  it('chips wait while the picture is not on offer or is being made', () => {
    expect(chips(renderToStaticMarkup(<ImageGenForm {...base} refs={refs} />)).every(c => c[2])).toBe(true);
    expect(chips(renderToStaticMarkup(<ImageGenForm {...base} status={status} refs={refs} generating />)).every(c => c[2])).toBe(true);
  });

  it('the row names no colour of its own', () => {
    const html = renderToStaticMarkup(<ImageGenForm {...base} status={status} refs={refs} />);
    const css = html.slice(html.indexOf('<style>'));
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('the request body carries references and as_self; stale names and "As you" without a companion picture are dropped', () => {
    expect(generateBody('  a fox ', refs, ['Sam', 'Boat'], true)).toEqual({ prompt: 'a fox', post_to_chat: false, references: ['Sam', 'Boat'], as_self: true });
    expect(generateBody('a fox', refs, [], false)).toEqual({ prompt: 'a fox', post_to_chat: false, references: [], as_self: false });
    expect(generateBody('a fox', refs, ['Gone', 'Sam'], false).references).toEqual(['Sam']);
    expect(generateBody('a fox', refs.slice(1), [], true).as_self).toBe(false);
    expect(generateBody('a fox', refs, ['Sam', 'Lake house', 'Boat', 'Dog', 'Echo'], false).references).toHaveLength(4);
  });
});
