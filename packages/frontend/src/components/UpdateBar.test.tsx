import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BAR_CSS, UpdateBarView, UpdateDialogView } from './UpdateBar';
import type { UpdateSnapshot } from '../store/update';

const noop = () => {};
const snap: UpdateSnapshot = {
  version: '1.3.0', latest: '1.4.0', update_available: true, repo: 'echo/sanctum', branch: 'main', checked_at: null,
  self_update: { ok: true, mode: 'git' }, restart_mode: 'respawn', household: true, companions: 2, job: null,
  rollback: { available: true, version: '1.3.0', created_at: null },
};

describe('UpdateBarView', () => {
  it('renders nothing when hidden', () => {
    expect(renderToStaticMarkup(<UpdateBarView model={{ phase: 'hidden', text: '', detail: '', dismissible: false }} onUpdate={noop} onDismiss={noop} />)).toBe('');
  });
  it('offers the button and a dismiss, on the pill surface the skins paint', () => {
    const html = renderToStaticMarkup(<UpdateBarView model={{ phase: 'offer', text: 'Sanctum 1.4.0 is out.', detail: '', dismissible: true }} onUpdate={noop} onDismiss={noop} />);
    expect(html).toContain('Sanctum 1.4.0 is out.');
    expect(html).toContain('Update and restart');
    expect(html).toContain('aria-label="Dismiss update notice"');
    expect(html).toContain('class="update-pill update-bar update-bar-offer"');
  });
  it('shows progress with the log line and neither button', () => {
    const html = renderToStaticMarkup(<UpdateBarView model={{ phase: 'progress', text: 'Updating to 1.4.0: building', detail: 'npm run build', dismissible: false }} onUpdate={noop} onDismiss={noop} />);
    expect(html).toContain('Updating to 1.4.0: building');
    expect(html).toContain('npm run build');
    expect(html).not.toContain('Update and restart');
    expect(html).not.toContain('Dismiss');
  });
  it('the plain-text fallback has no button', () => {
    const html = renderToStaticMarkup(<UpdateBarView model={{ phase: 'fallback', text: 'Sanctum 1.4.0 is out.', detail: 'run: npm run update', dismissible: true }} onUpdate={noop} onDismiss={noop} />);
    expect(html).toContain('npm run update');
    expect(html).not.toContain('class="update-bar-btn"');
  });
});

describe('UpdateDialogView', () => {
  it('says what happens (restart, every companion) and asks for the password', () => {
    const html = renderToStaticMarkup(<UpdateDialogView kind="update" snapshot={snap} busy={false} error={null} onSubmit={noop} onCancel={noop} />);
    expect(html).toContain('Update to Sanctum 1.4.0');
    expect(html).toContain('every companion in the house (2)');
    expect(html).toContain('type="password"');
    expect(html).toContain('Update and restart');
  });
  it('the roll back names the version it returns to, and a wrong password shows inline', () => {
    const html = renderToStaticMarkup(<UpdateDialogView kind="rollback" snapshot={snap} busy={false} error="That is not the password." onSubmit={noop} onCancel={noop} />);
    expect(html).toContain('Roll back to 1.3.0');
    expect(html).toContain('That is not the password.');
    expect(html).toContain('Roll back and restart');
  });
});

// The bar shows on Home and Chat, where the pills (and their <PillStyles/>) never render: its own style block must make it a fixed drop-down.
describe('the bar\'s own layout rules (a CSS contract, like the theme ones)', () => {
  const rule = (sel: string): string => {
    const i = BAR_CSS.indexOf(`${sel} {`);
    expect(i, `${sel} rule`).toBeGreaterThanOrEqual(0);
    return BAR_CSS.slice(i, BAR_CSS.indexOf('}', i));
  };
  it('sits in the flow of its page (under the chat header, above the Home title), never fixed over them', () => {
    const r = rule('.update-pill.update-bar');
    expect(r).toMatch(/position:\s*relative/);
    expect(r).not.toMatch(/position:\s*fixed/);
    expect(r).not.toMatch(/\btop:/);
    expect(r).not.toMatch(/translateX\(-50%\)/);
    expect(r).toMatch(/align-self:\s*center/);
    expect(r).toMatch(/display:\s*flex/);
  });
  it('wears the skins\' pill tokens for its surface and edge (no colour of its own), and the entry animation only fades and slides a little', () => {
    const r = rule('.update-pill.update-bar');
    expect(r).toContain('var(--surface-pill-bg');
    expect(r).toContain('var(--chrome-pill-border');
    expect(BAR_CSS).toMatch(/@keyframes update-bar-in\s*\{\s*from\s*\{[^}]*translateY/);
  });
  it('keeps the dismiss button styled, sized and reachable, and wraps on a phone', () => {
    const x = rule('.update-bar .update-pill-x');
    expect(x).toMatch(/width:\s*1\.5rem/);
    expect(x).toMatch(/cursor:\s*pointer/);
    expect(BAR_CSS).toMatch(/max-width:\s*480px\)\s*\{[^}]*flex-wrap:\s*wrap/);
  });
  it('has no offset of its own from the top of the screen (the page it is in places it)', () => {
    expect(BAR_CSS).not.toMatch(/safe-area-inset-top/);
  });
  it('is the one place the bar\'s base rules live: the pill\'s block is not needed (the bar renders its own style element)', () => {
    expect(renderToStaticMarkup(<UpdateBarView model={{ phase: 'offer', text: 'x', detail: '', dismissible: true }} onUpdate={noop} onDismiss={noop} />)).toContain('<style>');
  });
});
