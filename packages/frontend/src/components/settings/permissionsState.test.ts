import { describe, expect, it } from 'vitest';
import {
  guardSentence, pinNeeded, receiptsQuery, rowLabel, selectedButton, turnOnAction, untilText, windowMinutes,
  type CapabilityRow, type ConsentSnapshot,
} from './permissionsState';

const NOW = new Date(2026, 10, 6, 13, 0, 0).getTime(); // 6 Nov 2026, 13:00 local
const row = (o: Partial<CapabilityRow> = {}): CapabilityRow => ({
  capability: 'web', label: 'Web', state: 'on', allow: true, grant_id: null, expires_at: null, note: null, source: 'default', ...o,
});
const snap = (o: Partial<ConsentSnapshot> = {}, rows: CapabilityRow[] = [row()]): ConsentSnapshot => ({
  mode: 'open', capabilities: rows, windows: [15, 30, 60, 1440, null], pin_set: false, locked_until: null, ...o,
});
const inMin = (m: number) => new Date(NOW + m * 60_000).toISOString();

describe('rowLabel: state to words', () => {
  it('On, Off, On until HH:MM, and a window that ended', () => {
    expect(rowLabel(row())).toBe('On');
    expect(rowLabel(row({ state: 'off', allow: false }))).toBe('Off');
    expect(rowLabel(row({ state: 'expired', allow: false }))).toBe('Off, window ended');
    expect(rowLabel(row({ state: 'window', expires_at: new Date(2026, 10, 6, 14, 32).toISOString() }), NOW)).toBe('On until 14:32');
  });
  it('names the day when the window ends on another one', () => {
    expect(untilText(new Date(2026, 10, 7, 9, 5).toISOString(), NOW)).toBe('Sat 09:05');
  });
});

describe('windowMinutes: the picker to the API', () => {
  it('15m/30m/1h/24h/leave on', () => {
    expect(windowMinutes('15m')).toBe(15);
    expect(windowMinutes('30m')).toBe(30);
    expect(windowMinutes('1h')).toBe(60);
    expect(windowMinutes('24h')).toBe(1440);
    expect(windowMinutes('on')).toBeNull();
  });
});

describe('pinNeeded: the rules', () => {
  it('Guard mode on or off always asks; switching it on with no PIN set means setting one first', () => {
    expect(pinNeeded(snap({ pin_set: true }), { kind: 'mode', to: 'guard' })).toBe('pin');
    expect(pinNeeded(snap({ pin_set: false }), { kind: 'mode', to: 'guard' })).toBe('set_pin_first');
    expect(pinNeeded(snap({ mode: 'guard', pin_set: true }), { kind: 'mode', to: 'open' })).toBe('pin');
  });
  it('turning something off, or everything off, never asks', () => {
    expect(pinNeeded(snap({ pin_set: true }), { kind: 'off', capability: 'web' })).toBe('none');
    expect(pinNeeded(snap({ mode: 'guard', pin_set: true }), { kind: 'off', capability: 'web' })).toBe('none');
    expect(pinNeeded(snap({ pin_set: true }), { kind: 'all_off' })).toBe('none');
  });
  it('a grant in Guard mode always asks', () => {
    const g = snap({ mode: 'guard', pin_set: true }, [row({ state: 'off', allow: false })]);
    expect(pinNeeded(g, { kind: 'grant', capability: 'web', windowMinutes: 15 })).toBe('pin');
    expect(pinNeeded(g, { kind: 'grant', capability: 'web', windowMinutes: null })).toBe('pin');
  });
  it('Open mode, no PIN set: nothing asks', () => {
    const s = snap({ pin_set: false }, [row({ state: 'off', allow: false, grant_id: 'g1', source: 'override' })]);
    expect(pinNeeded(s, { kind: 'revoke', capability: 'web' })).toBe('none');
    expect(pinNeeded(s, { kind: 'grant', capability: 'web', windowMinutes: null })).toBe('none');
  });
  it('Open mode with a PIN: turning back on what was turned off, or whose window ended, asks', () => {
    const off = snap({ pin_set: true }, [row({ state: 'off', allow: false, grant_id: 'g1', source: 'override' })]);
    expect(pinNeeded(off, { kind: 'revoke', capability: 'web' })).toBe('pin');
    expect(pinNeeded(off, { kind: 'grant', capability: 'web', windowMinutes: 30 })).toBe('pin');
    const ended = snap({ pin_set: true }, [row({ state: 'expired', allow: false, grant_id: 'g2', source: 'grant' })]);
    expect(pinNeeded(ended, { kind: 'revoke', capability: 'web' })).toBe('pin');
  });
  it('Open mode with a PIN: a window on something that is on, or a shorter one, does not ask; a longer one does', () => {
    expect(pinNeeded(snap({ pin_set: true }), { kind: 'grant', capability: 'web', windowMinutes: 15 }, NOW)).toBe('none');
    const live = snap({ pin_set: true }, [row({ state: 'window', expires_at: inMin(60), grant_id: 'g3', source: 'grant' })]);
    expect(pinNeeded(live, { kind: 'grant', capability: 'web', windowMinutes: 15 }, NOW)).toBe('none');
    expect(pinNeeded(live, { kind: 'grant', capability: 'web', windowMinutes: 1440 }, NOW)).toBe('pin');
    expect(pinNeeded(live, { kind: 'grant', capability: 'web', windowMinutes: null }, NOW)).toBe('pin');
  });
  it('removing a Guard-mode grant (which turns it off) never asks', () => {
    const g = snap({ mode: 'guard', pin_set: true }, [row({ state: 'window', expires_at: inMin(30), grant_id: 'g4', source: 'grant' })]);
    expect(pinNeeded(g, { kind: 'revoke', capability: 'web' })).toBe('none');
  });
});

describe('turnOnAction and selectedButton', () => {
  it('Open mode removes the switch-off; otherwise it leaves the capability on', () => {
    const off = row({ state: 'off', allow: false, grant_id: 'g1', source: 'override' });
    expect(turnOnAction({ mode: 'open' }, off)).toEqual({ kind: 'revoke', capability: 'web' });
    expect(turnOnAction({ mode: 'guard' }, off)).toEqual({ kind: 'grant', capability: 'web', windowMinutes: null });
    expect(turnOnAction({ mode: 'open' }, row({ state: 'window', grant_id: 'g', expires_at: inMin(5) }))).toEqual({ kind: 'grant', capability: 'web', windowMinutes: null });
  });
  it('the selected button follows the state; an ended window reads as off', () => {
    expect(selectedButton(row())).toBe('on');
    expect(selectedButton(row({ state: 'window' }))).toBe('window');
    expect(selectedButton(row({ state: 'off' }))).toBe('off');
    expect(selectedButton(row({ state: 'expired' }))).toBe('off');
  });
});

describe('receipts query and the Guard sentence', () => {
  it('sends only the filters that are set, and the page cursor', () => {
    expect(receiptsQuery({ capability: '', outcome: '' })).toBe('limit=25');
    expect(receiptsQuery({ capability: 'shell', outcome: 'denied', before: 40 })).toBe('capability=shell&outcome=denied&before=40&limit=25');
  });
  it('says what Guard changes, one sentence per state', () => {
    expect(guardSentence('open', false)).toContain('PIN you set first');
    expect(guardSentence('open', true)).toContain('behind your PIN');
    expect(guardSentence('guard', true)).toContain('every grant asks for your PIN');
  });
});
