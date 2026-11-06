/**
 * Permissions tab, pure state: what a row says, which window a choice means, and whether a change needs the PIN.
 * The PIN rules are the backend's (services/consent/gate.ts pinNeededForGrant / pinNeededForRevoke, routes/consent.ts); this mirrors them so the
 * panel can ask for the PIN before it sends, and the server stays the authority (a 403 pin_required still opens the prompt).
 */

export type ConsentMode = 'open' | 'guard';
export type RowState = 'on' | 'window' | 'expired' | 'off';

export interface CapabilityRow {
  capability: string;
  label: string;
  state: RowState;
  allow: boolean;
  grant_id: string | null;
  expires_at: string | null;
  note: string | null;
  source: 'default' | 'grant' | 'override';
}

export interface ConsentSnapshot {
  mode: ConsentMode;
  capabilities: CapabilityRow[];
  windows: Array<number | null>;
  pin_set: boolean;
  locked_until: string | null;
}

/** The window picker's five choices, in the order the spec lists them. */
export const WINDOW_CHOICES = [
  { id: '15m', label: '15 min', minutes: 15 },
  { id: '30m', label: '30 min', minutes: 30 },
  { id: '1h', label: '1 h', minutes: 60 },
  { id: '24h', label: '24 h', minutes: 1440 },
  { id: 'on', label: 'Leave on', minutes: null },
] as const;
export type WindowChoiceId = (typeof WINDOW_CHOICES)[number]['id'];

/** A picker choice as the number of minutes the API takes (null = leave on, no end). */
export function windowMinutes(choice: WindowChoiceId): number | null {
  return WINDOW_CHOICES.find((c) => c.id === choice)!.minutes;
}

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "14:32" today; "Tue 14:32" on another day. */
export function untilText(expiresAt: string, now: number = Date.now()): string {
  const end = new Date(expiresAt);
  if (Number.isNaN(end.getTime())) return '';
  const today = new Date(now);
  const sameDay = end.getFullYear() === today.getFullYear() && end.getMonth() === today.getMonth() && end.getDate() === today.getDate();
  return sameDay ? clock(end) : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][end.getDay()]} ${clock(end)}`;
}

/** The state word on a row: On / Off / On until 14:32 / Off, window ended. */
export function rowLabel(c: Pick<CapabilityRow, 'state' | 'expires_at'>, now: number = Date.now()): string {
  if (c.state === 'window' && c.expires_at) return `On until ${untilText(c.expires_at, now)}`;
  if (c.state === 'on') return 'On';
  if (c.state === 'expired') return 'Off, window ended';
  return 'Off';
}

export type PinNeed = 'none' | 'pin' | 'set_pin_first';

export type ChangeAction =
  | { kind: 'mode'; to: ConsentMode }
  | { kind: 'grant'; capability: string; windowMinutes: number | null }
  | { kind: 'revoke'; capability: string }
  | { kind: 'off'; capability: string }
  | { kind: 'all_off' };

/**
 * Does this change need the PIN? The rules:
 *  - Guard mode on or off: always. Switching it on with no PIN set yet means setting one first.
 *  - Turning something off, and "Turn everything off": never.
 *  - A grant in Guard mode: always.
 *  - In Open mode, only once a PIN exists: turning back on what was turned off or whose window ended, and stretching a live window to a
 *    longer one or to leave-on. A shorter window, or a window on something that is on with no end, needs none.
 *  - Removing an entry (the "On" button on a switched-off row in Open mode) needs it when it lets through what was not let through.
 */
export function pinNeeded(snap: Pick<ConsentSnapshot, 'mode' | 'pin_set' | 'capabilities'>, action: ChangeAction, now: number = Date.now()): PinNeed {
  if (action.kind === 'off' || action.kind === 'all_off') return 'none';
  if (action.kind === 'mode') return action.to === 'guard' && !snap.pin_set ? 'set_pin_first' : 'pin';
  const row = snap.capabilities.find((c) => c.capability === action.capability);
  if (!row) return snap.mode === 'guard' ? 'pin' : 'none';
  if (action.kind === 'revoke') {
    // Removing the entry puts the capability back to the mode's default: on in Open, off in Guard.
    const after = snap.mode === 'open';
    return snap.pin_set && !row.allow && after ? 'pin' : 'none';
  }
  if (snap.mode === 'guard') return 'pin';
  if (!snap.pin_set) return 'none';
  if (!row.allow) return 'pin';
  if (row.state === 'window' && row.expires_at) {
    const until = action.windowMinutes === null ? Infinity : now + action.windowMinutes * 60_000;
    if (until > Date.parse(row.expires_at)) return 'pin';
  }
  return 'none';
}

/** The row's "On" button: what it does. Open mode with an entry in the way removes it; otherwise it leaves the capability on. */
export function turnOnAction(snap: Pick<ConsentSnapshot, 'mode'>, row: CapabilityRow): ChangeAction {
  if (snap.mode === 'open' && row.grant_id && (row.state === 'off' || row.state === 'expired')) return { kind: 'revoke', capability: row.capability };
  return { kind: 'grant', capability: row.capability, windowMinutes: null };
}

/** Which button on a row reads as selected. */
export function selectedButton(row: Pick<CapabilityRow, 'state'>): 'on' | 'window' | 'off' {
  return row.state === 'on' ? 'on' : row.state === 'window' ? 'window' : 'off';
}

/** Receipts filter: the outcomes the select offers. */
export const OUTCOME_FILTERS = ['allowed', 'denied', 'expired', 'granted', 'revoked', 'mode_changed', 'error'] as const;

export function receiptsQuery(f: { capability: string; outcome: string; before?: number | null }): string {
  const q = new URLSearchParams();
  if (f.capability) q.set('capability', f.capability);
  if (f.outcome) q.set('outcome', f.outcome);
  if (f.before) q.set('before', String(f.before));
  q.set('limit', '25');
  return q.toString();
}

/** The line under the Guard switch. */
export function guardSentence(mode: ConsentMode, pinSet: boolean): string {
  if (mode === 'guard') return 'Guard is on: everything below is off until you give it a window, and every grant asks for your PIN.';
  return pinSet
    ? 'Guard is off: everything below is on. Switch it on to make every capability off until you grant it a window, behind your PIN.'
    : 'Guard is off: everything below is on. Switching Guard on makes every capability off until you grant it a window, behind a PIN you set first.';
}
