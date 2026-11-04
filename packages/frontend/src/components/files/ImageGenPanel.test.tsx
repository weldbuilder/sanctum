import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImageGenForm, type ImageGenFormProps } from './ImageGenPanel';

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
    expect(renderToStaticMarkup(<ImageGenForm {...base} status={status} prompt="x" generating />)).toContain('Generating with runware…');
    expect(renderToStaticMarkup(<ImageGenForm {...base} status={status} prompt="x" error="Provider key was rejected" />)).toContain('Provider key was rejected');
  });
});
