import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionsSection, type Receipt } from './PermissionsSection';
import type { CapabilityRow, ConsentSnapshot } from './permissionsState';

const CAPS = ['app_write', 'shell', 'files_outside_home', 'web', 'outward_telegram', 'outward_discord', 'google_write', 'self_code_edit', 'voice_out'];
const rows = (o: Record<string, Partial<CapabilityRow>> = {}): CapabilityRow[] => CAPS.map(c => ({
  capability: c, label: `label of ${c}`, state: 'on', allow: true, grant_id: null, expires_at: null, note: null, source: 'default', ...o[c],
}));
const snap = (o: Partial<ConsentSnapshot>, r = rows()): ConsentSnapshot => ({ mode: 'open', capabilities: r, windows: [15, 30, 60, 1440, null], pin_set: false, locked_until: null, ...o });
const receipt = (o: Partial<Receipt> = {}): Receipt => ({ id: 2, ts: '2026-11-06T13:00:00.000Z', capability: 'web', grant_id: null, harness: 'claude', thread_id: 't-1', tool_or_route: 'WebFetch', summary: 'WebFetch example.test', outcome: 'allowed', count: 1, ...o });
const html = (initial: Parameters<typeof PermissionsSection>[0]['initial']) => renderToStaticMarkup(<PermissionsSection base="" initial={initial} openThread={() => {}} />);

describe('Permissions tab, Open mode with nothing changed', () => {
  const out = html({ snap: snap({}) });
  it('shows Guard off with its sentence, and a row per capability, all On', () => {
    expect(out).toContain('Guard mode');
    expect(out).toMatch(/aria-checked="false"[^>]*aria-label="Guard mode"|aria-label="Guard mode"[^>]*aria-checked="false"/);
    expect(out).toContain('Guard is off: everything below is on.');
    for (const c of CAPS) expect(out).toContain(`data-capability="${c}"`);
    expect((out.match(/class="pm-row-state is-on">On</g) ?? []).length).toBe(CAPS.length);
    expect(out).not.toContain('pm-row-state is-off');
  });
  it('has Turn everything off, the local-model sentence, the PIN block and the receipts filters', () => {
    expect(out).toContain('Turn everything off');
    expect(out).toContain('If your companion runs on a local model');
    expect(out).toContain('Set a PIN');
    expect(out).toContain('Filter by capability');
    expect(out).toContain('Filter by outcome');
    expect(out).toContain('Nothing yet.');
  });
  it('asks for no PIN until a change needs one', () => {
    expect(out).not.toContain('aria-label="PIN"');
  });
});

describe('Permissions tab, Guard with one window', () => {
  const until = (() => { const d = new Date(); d.setHours(14, 32, 0, 0); return d.toISOString(); })(); // today at 14:32, so the label reads "14:32" and not "Fri 14:32" after the date passes
  const r = rows();
  for (const c of r) { c.state = 'off'; c.allow = false; }
  Object.assign(r.find(c => c.capability === 'web')!, { state: 'window', allow: true, expires_at: until, grant_id: 'g-1', source: 'grant', note: 'research' });
  const out = html({ snap: snap({ mode: 'guard', pin_set: true }, r), receipts: [receipt(), receipt({ id: 1, outcome: 'denied', capability: 'shell', thread_id: null, summary: 'Bash ls' })], openRow: 'web' });
  it('shows Guard on, one row On until HH:MM with its note, the rest Off', () => {
    expect(out).toMatch(/aria-checked="true"[^>]*aria-label="Guard mode"|aria-label="Guard mode"[^>]*aria-checked="true"/);
    expect(out).toContain('Guard is on:');
    expect(out).toContain('On until 14:32');
    expect(out).toContain('research');
    expect((out.match(/class="pm-row-state is-off">Off</g) ?? []).length).toBe(CAPS.length - 1);
  });
  it('shows the window picker with its five choices on the open row', () => {
    for (const w of ['15 min', '30 min', '1 h', '24 h', 'Leave on']) expect(out).toContain(`>${w}<`);
  });
  it('lists receipts newest first, with a thread link only where there is a thread', () => {
    expect(out.indexOf('WebFetch example.test')).toBeLessThan(out.indexOf('Bash ls'));
    expect((out.match(/open the thread/g) ?? []).length).toBe(1);
    expect(out).toContain('pm-outcome denied');
  });
  it('keeps the PIN form for changing it', () => {
    expect(out).toContain('Change or remove PIN');
  });
});

describe('Permissions tab styling', () => {
  const source = readFileSync(new URL('./PermissionsSection.tsx', import.meta.url), 'utf8');
  it('draws in tokens only: no hex and no rgb() literal', () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
  });
  it('gives every control a 40px tap target', () => {
    for (const cls of ['.pm-seg-btn', '.pm-chip', '.pm-link']) expect(source).toMatch(new RegExp(`\\${cls} \\{[^}]*min-height: 40px`));
  });
});
