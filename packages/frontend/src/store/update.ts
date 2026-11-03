import { create } from 'zustand';
import { BASE, HOUSE_BASE } from '../lib/base';

// ─── In-app update store ────────────────────────────────────────────────────────
// The house's update routes (GET /api/house/update, POST .../start, .../rollback) are NOT companion routes: they live at the house's own
// address, never under /c/<id>, so every call here uses HOUSE_BASE. Starting an update or a roll back needs the password typed again.
// While a job runs the store polls the status; when the server goes away for the restart it waits for /api/version to answer with a
// different build id and then reloads the page.

export type JobState = 'checking' | 'fetching' | 'installing' | 'building' | 'restarting' | 'done' | 'failed' | 'rolled_back';
export interface JobLine { t: string; line: string }
export interface UpdateJob {
  id: string;
  kind: 'update' | 'rollback';
  state: JobState;
  from: string;
  to: string | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  dirty: string[] | null;
  restart_pending: boolean;
  log: JobLine[];
}
export interface UpdateSnapshot {
  version: string;
  latest: string | null;
  update_available: boolean;
  repo: string;
  branch: string;
  checked_at: string | null;
  error?: string;
  self_update: { ok: boolean; mode: 'git' | 'tarball'; reason?: string };
  restart_mode: 'supervised' | 'respawn';
  household: boolean;
  companions: number;
  job: UpdateJob | null;
  rollback: { available: boolean; version: string | null; created_at: string | null };
  /** false in dev-open (no password is set): the dialog has nothing to ask for, so the page shows the terminal command. */
  password_set?: boolean;
}

/** Can this install update itself from the page? The platform must allow it and a password must exist to type again. */
export const canSelfUpdate = (s: UpdateSnapshot | null | undefined): boolean => !!s && s.self_update.ok && s.password_set !== false;
/** Why not, in one line (empty when it can). */
export const selfUpdateWhy = (s: UpdateSnapshot | null | undefined): string => (!s || canSelfUpdate(s) ? '' : !s.self_update.ok ? (s.self_update.reason ?? 'This install cannot update itself.') : 'Set a password, or run npm run update');

const ACTIVE: JobState[] = ['checking', 'fetching', 'installing', 'building', 'restarting'];
/** Is the app refusing new messages (an update installing, building or restarting)? The composer keeps the draft instead of sending. */
export const messagesPaused = (j: UpdateJob | null | undefined): boolean => !!j && (j.state === 'installing' || j.state === 'building' || j.state === 'restarting');
/** The line shown where a message was refused. The text stays in the box. */
export const UPDATE_REFUSED_NOTICE = 'Updating; your message was not sent.';
export const jobActive = (j: UpdateJob | null | undefined): boolean => !!j && ACTIVE.includes(j.state);

const STATE_WORDS: Record<JobState, string> = {
  checking: 'Checking', fetching: 'Fetching', installing: 'Installing', building: 'Building', restarting: 'Restarting',
  done: 'Done', failed: 'Failed', rolled_back: 'Rolled back',
};
export const stateWord = (s: JobState): string => STATE_WORDS[s];
export const lastLine = (j: UpdateJob | null | undefined): string => j?.log.length ? j.log[j.log.length - 1].line : '';

// ─── The bar's view of it (pure: tested without a browser) ────────────────────────
export type BarPhase = 'hidden' | 'offer' | 'fallback' | 'progress' | 'failed' | 'finished';
export interface BarModel { phase: BarPhase; text: string; detail: string; dismissible: boolean }
const HIDDEN: BarModel = { phase: 'hidden', text: '', detail: '', dismissible: false };

/** The failed job's reason on one line: its first line, plus the last line of the failing step's output when the error carries it. */
export function failureDetail(job: UpdateJob): string {
  const lines = (job.error ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1 || (job.dirty && job.dirty.length)) return lines[0] ?? '';
  return `${lines[0].replace(/:$/, '')}: ${lines[lines.length - 1]}`;
}

export function barModel(s: UpdateSnapshot | null, dismissedFor: string | null, waiting = false): BarModel {
  if (!s) return waiting ? { phase: 'progress', text: 'Restarting', detail: 'Waiting for the app to come back', dismissible: false } : HIDDEN;
  const job = s.job;
  if (jobActive(job)) {
    const what = job!.kind === 'rollback' ? 'Rolling back' : `Updating${job!.to ? ` to ${job!.to}` : s.latest ? ` to ${s.latest}` : ''}`;
    return { phase: 'progress', text: `${what}: ${stateWord(job!.state).toLowerCase()}`, detail: lastLine(job), dismissible: false };
  }
  if (job && job.state === 'failed' && dismissedFor !== `job:${job.id}`) {
    return { phase: 'failed', text: job.kind === 'rollback' ? 'The roll back did not finish' : 'The update did not finish', detail: failureDetail(job), dismissible: true };
  }
  if (job && job.restart_pending && dismissedFor !== `job:${job.id}`) {
    return { phase: 'finished', text: `${job.to ?? 'The new version'} is installed. Restart the app to finish.`, detail: '', dismissible: true };
  }
  if (s.update_available && s.latest && dismissedFor !== s.latest) {
    if (!canSelfUpdate(s)) {
      return { phase: 'fallback', text: `Sanctum ${s.latest} is out.`, detail: s.self_update.ok ? selfUpdateWhy(s) : `${selfUpdateWhy(s)} In the app's folder, run: npm run update`, dismissible: true };
    }
    return { phase: 'offer', text: `Sanctum ${s.latest} is out.`, detail: '', dismissible: true };
  }
  return HIDDEN;
}

/** A page built as `current` should reload once the server answers with another build id (the dev build id never counts). */
export function shouldReload(current: string, served: string | undefined): boolean {
  return !!served && served !== 'dev' && current !== 'dev' && served !== current;
}

/** What the dialog says will happen. */
export function dialogBody(kind: 'update' | 'rollback', s: UpdateSnapshot | null): string {
  const everyone = s?.household ? ` and every companion in the house (${s.companions})` : '';
  const stops = `The app restarts${everyone}. Anything running stops for a minute or so, and this page reloads by itself when the app is back.`;
  return kind === 'update'
    ? `${stops} The new version is built beside the running one first, and the current one is kept so you can roll back.`
    : `${stops} The files go back to the version kept before the last update.`;
}

// ─── The store ────────────────────────────────────────────────────────────────────
interface UpdateStore {
  snapshot: UpdateSnapshot | null;
  /** The house routes answered 404/401: this install has no in-app update (per-tenant hosts). */
  unavailable: boolean;
  /** A release version (or `job:<id>`) whose notice the person closed this session. */
  dismissedFor: string | null;
  dialog: 'update' | 'rollback' | null;
  submitting: boolean;
  formError: string | null;
  /** The app is expected to be down (it is restarting): poll /api/version instead of the status. */
  waiting: boolean;
  refresh: (force?: boolean) => Promise<void>;
  openDialog: (kind: 'update' | 'rollback') => void;
  closeDialog: () => void;
  dismiss: () => void;
  submit: (password: string) => Promise<void>;
}

const SESSION_KEY = 'sanctum.updateDismissed';
function readDismissed(): string | null { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } }
function writeDismissed(v: string | null): void { try { if (v) sessionStorage.setItem(SESSION_KEY, v); else sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }

const builtAs = (): string => { try { return __BUILD_ID__; } catch { return 'dev'; } };
let timer: ReturnType<typeof setTimeout> | null = null;
/** The id of the last finished update whose build id was checked, so each is checked once. */
let checkedDone: string | null = null;
export function _resetCheckedDone(): void { checkedDone = null; }

export const useUpdateStore = create<UpdateStore>((set, get) => {
  function schedule(ms: number) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void get().refresh(); }, ms);
  }
  return {
    snapshot: null,
    unavailable: false,
    dismissedFor: readDismissed(),
    dialog: null,
    submitting: false,
    formError: null,
    waiting: false,

    async refresh(force = false) {
      const { waiting } = get();
      if (waiting) {
        // The app is down or coming back: only /api/version tells us whether the new build is serving.
        try {
          const res = await fetch(`${BASE}/api/version`, { cache: 'no-store' });
          if (res.ok) {
            const v = await res.json() as { buildId?: string };
            if (shouldReload(builtAs(), v.buildId)) { window.location.reload(); return; }
            set({ waiting: false }); // back on the same build (a failed update, or nothing changed): the status says what happened
          }
        } catch { /* still down */ }
        if (get().waiting) { schedule(2000); return; }
      }
      try {
        const res = await fetch(`${HOUSE_BASE}/api/house/update${force ? '?force=1' : ''}`, { credentials: 'include', cache: 'no-store' });
        if (res.status === 404 || res.status === 401) { set({ unavailable: true }); return; }
        if (!res.ok) return;
        const snapshot = await res.json() as UpdateSnapshot;
        set({ snapshot, unavailable: false });
        if (snapshot.job?.state === 'restarting') set({ waiting: true });
        if (jobActive(snapshot.job)) schedule(snapshot.job!.state === 'restarting' ? 1500 : 2000);
        else if (snapshot.job?.state === 'done' && snapshot.job.kind === 'update' && checkedDone !== snapshot.job.id) {
          // The update finished (whether or not this page ever saw `restarting`): look at /api/version once. A new build id reloads the page.
          checkedDone = snapshot.job.id;
          set({ waiting: true }); // (the line below schedules the check)
        }
        if (get().waiting) schedule(1500);
      } catch {
        // The status stopped answering while a job was running: that is the restart.
        if (jobActive(get().snapshot?.job)) { set({ waiting: true }); schedule(1500); }
      }
    },

    openDialog(kind) { set({ dialog: kind, formError: null }); },
    closeDialog() { set({ dialog: null, formError: null, submitting: false }); },
    dismiss() {
      const s = get().snapshot;
      const key = s?.job && (s.job.state === 'failed' || s.job.restart_pending) ? `job:${s.job.id}` : s?.latest ?? null;
      writeDismissed(key);
      set({ dismissedFor: key });
    },

    async submit(password) {
      const kind = get().dialog;
      if (!kind || get().submitting) return;
      set({ submitting: true, formError: null });
      try {
        const res = await fetch(`${HOUSE_BASE}/api/house/update/${kind === 'update' ? 'start' : 'rollback'}`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
        });
        const body = await res.json().catch(() => ({})) as { job?: UpdateJob; message?: string; error?: string };
        if (!res.ok) { set({ submitting: false, formError: body.message ?? body.error ?? `The app answered ${res.status}.` }); return; }
        set({ submitting: false, dialog: null, dismissedFor: null, snapshot: get().snapshot ? { ...get().snapshot!, job: body.job ?? null } : get().snapshot });
        writeDismissed(null);
        schedule(1000);
      } catch {
        set({ submitting: false, formError: 'Could not reach the app.' });
      }
    },
  };
});
