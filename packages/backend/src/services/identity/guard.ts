// What every harness asks at the places it reads identity: "what text does this run get?". The answer is
// the RATIFIED copy whenever one exists (docs/PLUGINS.md "Identity ratification"): a change on disk that the
// person has not ratified is noted, and the run still boots on what they ratified. With nothing ratified yet
// (first run after an upgrade, a fresh install) the live files are served and the state is `unratified`.
// The stat prefilter in the ledger keeps the check cheap enough to run per turn.
import { dirname, join } from 'node:path';
import type { SanctumConfig } from '../../config.js';
import { checkIdentity, type CheckContext, type IdentityCheck } from './ledger.js';
import { hasIdentityFolder, identityRoles, readFolder, readIdentity, renderIdentity, IdentitySourceError, type IdentityFile } from './source.js';
import { currentTenant, tenancyEnabled, tenantLocal } from '../../tenancy/context.js';

/** What the harness is told when it is running on the ratified version while a change waits. `files` are sanitised names. */
export function pendingLine(files: string[]): string {
  if (files.length === 0) return 'A change is waiting for the person to ratify it; this run uses the ratified version.';
  return `A change to ${files.join(', ')} is waiting for the person to ratify it; this run uses the ratified version.`;
}

/** What the harness is told when no ratified copy could be read at all and the live files are served instead. */
export const UNREADABLE_LINE = 'The ratified identity could not be read; this run uses the live files. Ratify in the app.';
/** The identity folder is gone and no ratified copy can be read: the run gets this line and nothing else, never a CLAUDE.md. */
export const MISSING_LINE = 'The identity folder is missing and no ratified copy could be read; this run has no identity. Settings → You & them.';

const KNOWN_NAMES = ['profile.md', 'companion.md', 'companion.profile.yaml', 'companion.profile.yml'];

/** What a prompt or a thread line says about changed files. Names come from the disk, so a name is never copied into a prompt unless it is exactly
 *  (case included) one of the identity file names the app knows; anything else is counted, with its extensions ("2 other files (.md, .txt)"). */
export function nameList(paths: string[]): string[] {
  const known = new Set<string>();
  const other: string[] = [];
  for (const p of paths) {
    const k = KNOWN_NAMES.find((n) => n === p); // exact and case-sensitive: "PROFILE.MD" is another file, so it is counted, not named
    if (k) known.add(k); else other.push(p);
  }
  const out = [...known];
  if (other.length > 0) {
    const exts = [...new Set(other.map((p) => /\.([A-Za-z0-9]{1,8})$/.exec(p)?.[1]?.toLowerCase()).filter((e): e is string => !!e))].slice(0, 3);
    out.push(`${other.length} ${known.size > 0 ? 'other ' : ''}${other.length === 1 ? 'file' : 'files'}${exts.length ? ` (${exts.map((e) => `.${e}`).join(', ')})` : ''}`);
  }
  return out;
}

/** Where the ledger lives for this config, or null when nothing says (a test double): then nothing is gated and the live files are served. */
export function ledgerDirFor(cfg: Pick<SanctumConfig, 'identity' | 'server'>): string | null {
  const configured = cfg.identity?.ledger_dir;
  if (configured) return configured;
  const db = cfg.server?.db_path;
  return db && db !== ':memory:' ? join(dirname(db), 'identity') : null;
}

export interface IdentityRun {
  /** The home has an identity folder. False: the Claude harness falls back to the legacy CLAUDE.md lookup. */
  present: boolean;
  /** The block to inject, names not yet filled in. '' when there is none to give. */
  text: string;
  /** The files it was made from (the ratified copy's when it was served). */
  files: string[];
  /** The ledger's answer; absent when no ledger folder is configured. */
  check?: IdentityCheck;
  /** The ratified copy was served instead of the live folder. */
  ratifiedServed: boolean;
  /** The files themselves (the ratified copy's when it was served), for a reader that wants one of them (the summarizer's short identity). */
  fileTexts?: IdentityFile[];
}

type Listener = (check: IdentityCheck) => void;
// Per tenant in tenant mode (one listener, one "last state" each); one of each for the process otherwise.
const listenerLocal = tenantLocal<Listener | null>(() => null);
const lastStateLocal = tenantLocal<IdentityCheck['state'] | undefined>(() => undefined);
/** The app registers one function that hears every check that finds a change waiting, and every check that finds the state moved (the thread
 *  line and the broadcast: notify.ts). */
export function setIdentityListener(fn: Listener | null): void { listenerLocal.set(fn); lastStateLocal.set(undefined); }

/** Hand a check's answer to the listener when it found a change waiting, or when the state moved since the last check anyone made
 *  (so the header does not go stale when the files return to the ratified ones). Never throws. */
export function emitCheck(check: IdentityCheck): IdentityCheck {
  const lastState = lastStateLocal.get();
  const moved = lastState !== undefined && lastState !== check.state;
  lastStateLocal.set(check.state);
  if (check.state === 'pending' || check.state === 'unavailable' || check.detected || moved) {
    try { listenerLocal.get()?.(check); } catch (e) { console.warn('[identity] the change listener failed:', e instanceof Error ? e.message : e); }
  }
  return check;
}

type TurnProbe = () => boolean;
// Per tenant in tenant mode (each tenant's agent registers its own); one for the process otherwise.
const turnProbeLocal = tenantLocal<TurnProbe | null>(() => null);
/** The agent registers how to tell whether a turn is running, for the journal line the app's own checks write.
 *  Tenancy on and no tenant current (process-level code): ignored, a process has no turn of its own. */
export function setTurnProbe(fn: TurnProbe | null): void {
  if (tenancyEnabled() && !currentTenant()) return;
  turnProbeLocal.set(fn);
}
/** The context for a check the app makes itself (status request, boot): says whether a turn was running.
 *  Tenancy on and no tenant current: 'idle' (nothing of any tenant's is running at process level). */
export function appContext(): CheckContext {
  if (tenancyEnabled() && !currentTenant()) return { turn: 'idle' };
  const turnProbe = turnProbeLocal.get();
  if (!turnProbe) return { turn: 'unknown' };
  try { return { turn: turnProbe() ? 'running' : 'idle' }; } catch { return { turn: 'unknown' }; }
}

export interface RunOptions {
  /** Which harness is asking ('claude', 'codex', 'dsh', 'claude public lane'...): recorded when the check notices a change on disk. */
  harness: string;
  /** Add the "a change is waiting" line when the ratified copy is served over a pending change. Default true. */
  pendingLine?: boolean;
}

/** Run the check and read the identity for one run on `harness`. Never throws: a read that fails answers with no text and the reason is logged. */
export function identityForRun(cfg: SanctumConfig, opts: RunOptions): IdentityRun {
  const home = cfg.agent.cwd;
  const ledgerDir = ledgerDirFor(cfg);
  let check: IdentityCheck | undefined;
  if (ledgerDir) {
    check = checkIdentity(home, { ledgerDir, context: { harness: opts.harness, turn: 'preparing' } });
    emitCheck(check);
  }
  // The check comes first. Only a home that never had a ratified identity (state `legacy`, or no ledger configured) hands
  // the run to the CLAUDE.md fallback. A folder that was ratified and has since gone is served from the ledger like any
  // other unavailable state, so deleting `identity/` and writing a CLAUDE.md cannot swap the spine.
  const folder = hasIdentityFolder(home);
  if (!folder && (!check || check.state === 'legacy')) return { present: false, text: '', files: [], ratifiedServed: false };
  let files: IdentityFile[] = [];
  let ratifiedServed = false;
  try {
    if (check?.snapshot) {
      try { files = readFolder(check.snapshot).files; ratifiedServed = true; } catch (e) {
        console.warn(`[identity] the ratified copy could not be read (${e instanceof Error ? e.message : e}); serving the live files`);
        files = folder ? readIdentity(home).files : [];
      }
    } else files = folder ? readIdentity(home).files : [];
  } catch (e) {
    if (!(e instanceof IdentitySourceError)) throw e;
    console.warn(`[identity] ${e.message}`);
    return { present: true, text: '', files: [], ...(check && { check }), ratifiedServed: false };
  }
  let text = renderIdentity(files, identityRoles(home, cfg.identity));
  if (text && ratifiedServed && check?.state === 'pending' && opts.pendingLine !== false) {
    text = `${text}\n\n${pendingLine(nameList((check.changes ?? []).map((c) => c.path)))}`;
  } else if (text && check?.state === 'unavailable' && !ratifiedServed && opts.pendingLine !== false) {
    text = `${text}\n\n${UNREADABLE_LINE}`;
  } else if (!text && !folder && !ratifiedServed) {
    text = opts.pendingLine === false ? '' : MISSING_LINE;
  }
  return { present: true, text, files: files.map((f) => f.name), fileTexts: files, ...(check && { check }), ratifiedServed };
}
