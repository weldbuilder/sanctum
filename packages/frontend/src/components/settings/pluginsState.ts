/** Pure helpers for the Plugins settings section. */

export type RatificationState = 'ok' | 'unratified' | 'changed' | 'unavailable';
export type ChangeKind = 'added' | 'removed' | 'modified';
export interface PluginChange { path: string; kind: ChangeKind }

export type PluginsTrust = 'companion' | 'person';

/** Companion mode: what the audit record says about a plugin's code. */
export interface PluginAudit {
  digest: string;
  last_change_at: string | null;
  changed_since_last_view: boolean;
  changes: PluginChange[];
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  harness: string[];
  routes: boolean;
  help: boolean;
  tenant_aware: boolean;
  enabled: boolean;
  error: string | null;
  /** Person mode only. */
  ratification?: { state: RatificationState; digest: string; changes?: PluginChange[]; detail?: string };
  /** Companion mode only; null when the code could not be recorded. */
  audit?: PluginAudit | null;
  /** Companion mode only: what the import scan found. A warning, not a refusal. */
  warnings?: string[];
}

/** The mode GET /api/plugins reports. A response without one is an older server: person mode, as it was. */
export function readTrust(data: unknown): PluginsTrust {
  const t = (data as { trust?: unknown } | null)?.trust;
  return t === 'companion' ? 'companion' : 'person';
}

export interface PluginFile { path: string; sha256: string; size: number }

export type BadgeTone = 'ok' | 'warn' | 'muted';

export function ratificationBadge(state: RatificationState | undefined): { label: string; tone: BadgeTone } {
  switch (state) {
    case 'ok': return { label: 'Ratified', tone: 'ok' };
    case 'unratified': return { label: 'Not ratified', tone: 'warn' };
    case 'changed': return { label: 'Changed since ratified', tone: 'warn' };
    default: return { label: 'Unavailable', tone: 'muted' };
  }
}

export function changeSummary(changes: PluginChange[] | undefined): string {
  if (!changes || changes.length === 0) return '';
  const kinds: ChangeKind[] = ['added', 'modified', 'removed'];
  return kinds
    .map(k => [k, changes.filter(c => c.kind === k).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${n === 1 ? 'file' : 'files'} ${k}`)
    .join(', ');
}

export function changeLine(c: PluginChange): string {
  return `${c.kind}  ${c.path}`;
}

export function canReview(p: PluginInfo): boolean {
  return p.ratification?.state === 'unratified' || p.ratification?.state === 'changed';
}

export function canReload(p: PluginInfo, trust: PluginsTrust = 'person'): boolean {
  // Companion mode: an error does not hide Reload. A failed route import sets the error, and Reload is how a fixed edit is picked up.
  if (trust === 'companion') return p.routes && p.enabled;
  return p.routes && p.enabled && p.ratification?.state === 'ok';
}

/** Companion mode: whether the person has something to look at (the code changed since they last did). */
export function changedSinceView(p: PluginInfo): boolean {
  return !!p.audit?.changed_since_last_view;
}

/** Companion mode: the Review button shows for any plugin that has files to read; the marker only when it changed. */
export function canReviewAudit(p: PluginInfo): boolean {
  return p.audit !== undefined && p.audit !== null;
}

/** "Changed 20 Oct, 10:03" style text for the marker; falls back to nothing when there is no date. */
export function describeChangeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((now.getTime() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** What to say when PUT /api/plugins/enabled did not go through. */
export function interpretEnabledFailure(status: number, body: { error?: string; detail?: string } | null): string {
  if (body?.error === 'config_write_failed') return `Could not save the change to sanctum.yaml${body.detail ? ` (${body.detail})` : ''}. Nothing changed.`;
  if (status === 400) return 'That list was not accepted.';
  if (status === 501) return 'This server cannot change the plugin list.';
  return body?.error || `Could not change the plugin list (${status})`;
}

/** What to say when POST /api/plugins/:id/seen did not go through. */
export function interpretSeenFailure(status: number, body: { error?: string; detail?: string } | null): { message: string; refresh: boolean } {
  if (status === 409 && body?.error === 'digest_mismatch') return { message: 'The files changed while you were looking. Review again.', refresh: true };
  if (status === 409 && body?.error === 'plugin_invalid') return { message: `Cannot mark it as seen: ${body.detail ?? 'the plugin folder cannot be read'}`, refresh: false };
  return { message: body?.error || `Could not mark it as seen (${status})`, refresh: false };
}

/** The new plugins.enabled when `id` is switched on or off in `current`. */
export function toggleEnabled(current: string[], id: string, on: boolean): string[] {
  const without = current.filter((x) => x !== id);
  return on ? [...without, id] : without;
}

export function interpretRatifyFailure(
  status: number,
  body: { error?: string; detail?: string } | null,
): { message: string; refresh: boolean } {
  if (status === 409 && body?.error === 'digest_mismatch') {
    return { message: 'The files changed while you were reading. Review again.', refresh: true };
  }
  if (status === 409 && body?.error === 'plugin_invalid') {
    return { message: `This plugin cannot be ratified: ${body.detail ?? 'invalid plugin'}`, refresh: false };
  }
  if (body?.error === 'ledger_write_failed') {
    return { message: `The app could not save your approval${body.detail ? ` (${body.detail})` : ''}. Nothing was ratified.`, refresh: false };
  }
  return { message: body?.error || `Ratify failed (${status})`, refresh: false };
}

/** The note shown when a ratify did not go through. */
export function ratifyFailureNote(status: number, body: { error?: string; detail?: string } | null): string {
  return interpretRatifyFailure(status, body).message;
}

export interface ReviewFile extends PluginFile { change?: ChangeKind }

/** The files to show for review: the ones that changed since the last ratification first (by path,
 *  each marked added or modified), then the rest in the order they came. Removed files are not in the
 *  current list; the change summary above it names them. */
export function orderFiles(files: PluginFile[], changes: PluginChange[] | undefined): ReviewFile[] {
  const kind = new Map((changes ?? []).map(c => [c.path, c.kind] as const));
  const marked: ReviewFile[] = files.map(f => (kind.has(f.path) && kind.get(f.path) !== 'removed' ? { ...f, change: kind.get(f.path) } : { ...f }));
  const changed = marked.filter(f => f.change).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return [...changed, ...marked.filter(f => !f.change)];
}

/** What to say when the Plugins section finds plugins switched off, or null when they are not. */
export function describeDisabled(disabled: string | null, detail: string | undefined): { title: string; body: string } | null {
  if (!disabled) return null;
  const title = 'Plugins are off.';
  if (disabled === 'full_access') {
    return { title, body: 'The active harness sandbox mode is danger-full-access (agent.codex.sandbox_mode for Codex, agent.dsh.sandbox_mode for dsh). Set it to workspace-write or read-only and restart the app to turn plugins back on.' };
  }
  if (disabled === 'ledger_writable') {
    return {
      title,
      body: `The record of what you approved (the ratification ledger) is in a folder your companion can write${detail ? `: ${detail}` : ''}. Anything that can write there could change the record of what you approved, so nothing runs. Set plugins.ledger_dir in sanctum.yaml to a folder outside every folder your companion can write, then restart the app.`,
    };
  }
  return { title, body: `Plugins are switched off (${disabled}). Check the app's log for why.` };
}

export type FileView = { kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'error'; message: string };

/** One file's answer from GET /api/plugins/:id/file, as something to show. */
export function interpretFileView(status: number, body: { path?: string; sha256?: string; size?: number; text?: unknown; binary?: unknown; error?: string; detail?: string } | null): FileView {
  if (status === 200 && body && typeof body.text === 'string') return { kind: 'text', text: body.text };
  if (status === 200 && body && body.binary === true) return { kind: 'binary' };
  if (status === 404) return { kind: 'error', message: 'That file is no longer in the plugin. Reload the list.' };
  if (status === 409) return { kind: 'error', message: `Cannot show it: ${body?.detail ?? 'the plugin folder cannot be read'}` };
  return { kind: 'error', message: 'Could not load the file.' };
}
