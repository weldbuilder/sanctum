// The setup wizard's logic with no React in it: reading the plan the server sends, the answers, the review screen, and the calls to
// /api/setup. SetupWizard.tsx draws it. Nothing here keeps a secret anywhere but the answers object the page holds while it is open.

export type StepKind = 'text' | 'yesno' | 'choice' | 'multichoice' | 'secret';
export interface StepOption { value: string; label: string; detail?: string; on?: boolean }
export interface SetupStep {
  id: string;
  kind: StepKind;
  section?: string;
  question: string;
  help: string[];
  default?: unknown;
  /** Secrets only: one is already saved. Its value is never sent to the browser. */
  saved?: boolean;
  options?: StepOption[];
  meta?: { pluginId: string; digest: string; files?: string[]; changes?: { kind: string; path: string }[]; kind: string };
  retry?: boolean;
}
export type Answers = Record<string, unknown>;
export interface Problem { id: string; message: string }
/** Where the password in force comes from. parent_env: whatever starts the app sets APP_PASSWORD, and that beats .env at every start. */
export type PasswordSource = 'parent_env' | 'dotenv' | 'yaml' | 'none';
export interface PlanReply { steps: SetupStep[]; notes: string[]; problems: Problem[]; mode: 'first_run' | 'rerun'; passwordSource?: PasswordSource }
export interface ApplyReply { restartNeeded: boolean; changed: { path: string; what: string }[]; notes: string[]; passwordSource?: PasswordSource; passwordKeptByParent?: boolean }
export interface ProbeReply { ok: boolean; state?: string; message: string; [key: string]: unknown }

export type Failure = { ok: false; message: string; needsCode?: boolean; signedOut?: boolean; problems?: Problem[] };
export type Result<T> = ({ ok: true } & T) | Failure;

// ── the plan's words ──────────────────────────────────────────────────────────

export type HelpBlock = { kind: 'p'; text: string } | { kind: 'list'; items: string[] } | { kind: 'code'; text: string };

/** The plan's help is written for a terminal (hard-wrapped lines, two-space lists, a `digest` line). Paragraphs, lists and code for a page. */
export function helpBlocks(lines: string[]): HelpBlock[] {
  const out: HelpBlock[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ kind: 'p', text: para.join(' ') }); para = []; } };
  for (const raw of lines) {
    if (raw.trim() === '') { flush(); continue; }
    if (/^ {2}\S/.test(raw)) {
      flush();
      const last = out[out.length - 1];
      if (last && last.kind === 'list') last.items.push(raw.trim()); else out.push({ kind: 'list', items: [raw.trim()] });
    } else if (/^digest [0-9a-f]+$/.test(raw)) {
      flush();
      out.push({ kind: 'code', text: raw });
    } else {
      para.push(raw.trim());
    }
  }
  flush();
  return out;
}

// ── answers ───────────────────────────────────────────────────────────────────

/** What a step holds now: the answer if there is one, else its default. A secret is only what was typed (empty keeps the saved one). */
export function valueOf(step: SetupStep, answers: Answers): unknown {
  if (Object.prototype.hasOwnProperty.call(answers, step.id)) return answers[step.id];
  if (step.kind === 'secret') return '';
  if (step.default !== undefined) return step.default;
  return step.kind === 'yesno' ? false : step.kind === 'multichoice' ? [] : '';
}

/** Has the person been through this step (so that what it holds is sent, even when it is the default)? */
export const hasAnswer = (step: SetupStep, answers: Answers): boolean => Object.prototype.hasOwnProperty.call(answers, step.id);

/** The answer as words for the review screen. A secret is never shown: only that one is kept, new, or not set. */
export function describeValue(step: SetupStep, answers: Answers): string {
  const v = valueOf(step, answers);
  switch (step.kind) {
    case 'secret': return typeof v === 'string' && v ? 'new, hidden' : step.saved ? 'kept as saved' : 'not set';
    case 'yesno': return v ? 'yes' : 'no';
    case 'choice': return step.options?.find((o) => o.value === v)?.label ?? String(v);
    case 'multichoice': {
      const picked = Array.isArray(v) ? v : [];
      return picked.length ? picked.map((x) => step.options?.find((o) => o.value === x)?.label ?? String(x)).join(', ') : 'none';
    }
    default: return typeof v === 'string' && v ? v : 'empty';
  }
}

export interface ReviewRow { id: string; section: string; question: string; answer: string }
/** Every step that will be asked, with its answer in words. No secret is in it. */
export function reviewRows(steps: SetupStep[], answers: Answers): ReviewRow[] {
  return steps.map((s) => ({ id: s.id, section: s.section ?? '', question: s.question, answer: describeValue(s, answers) }));
}

/** The plan changed under the person (an answer showed or hid steps): the index in the new list that is the same step, else the next one
 *  of the old list that is still there, else the end (the review). */
export function reconcileIndex(prev: SetupStep[], prevIndex: number, next: SetupStep[]): number {
  for (let i = prevIndex; i < prev.length; i++) {
    const at = next.findIndex((s) => s.id === prev[i].id);
    if (at >= 0) return at;
  }
  return next.length;
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // the terminal's: no look-alikes
/** A password a person can read back, from the browser's random numbers: four groups of four. Shown to them before it is sent. */
export function madePassword(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(16);
  let s = '';
  for (let i = 0; i < 16; i++) { if (i && i % 4 === 0) s += '-'; s += ALPHABET[bytes[i] % ALPHABET.length]; }
  return s;
}

// ── the password's source ────────────────────────────────────────────────────

export const PARENT_PASSWORD_WARNING = 'APP_PASSWORD is set by whatever starts this app (pm2, systemd, a shell), not by .env. A new password works now, but you must change it there too, or the old one comes back at the next restart.';

/** Said on the password step, before anything is typed: only when the program that starts the app supplies APP_PASSWORD. */
export function passwordStepWarning(stepId: string, source: PasswordSource | undefined): string {
  return stepId === 'password' && source === 'parent_env' ? PARENT_PASSWORD_WARNING : '';
}

/** Said on the last screen, prominently, when the password was changed and the parent's value will return: the server asks for it. */
export function passwordRestartWarning(reply: Pick<ApplyReply, 'passwordKeptByParent'>): string {
  return reply.passwordKeptByParent ? PARENT_PASSWORD_WARNING : '';
}

// ── where a failure is shown ─────────────────────────────────────────────────

/** What the page does with a failed /plan. Needing the code (or having it expire) returns to the code prompt; every other failure
 *  (the lockout after five wrong guesses included) is shown where the person is looking: on the intro it is the field under the code,
 *  on a step it is that step's error. Never a field the current screen does not draw. */
export type PlanFailureAction = { phase: 'intro'; codeError: string } | { phase: null; codeError: ''; fieldError: string };
export function planFailureAction(f: Pick<Failure, 'message' | 'needsCode'>, from: 'intro' | 'steps'): PlanFailureAction {
  if (f.needsCode || from === 'intro') return { phase: 'intro', codeError: f.message };
  return { phase: null, codeError: '', fieldError: f.message };
}

/** What the page does with a failed /apply. The code expired during the wizard (needsCode): back to the code prompt with the answers
 *  kept and `resume` set, so the next accepted code lands on the review and not on step one. Anything else stays on the review. */
export type ApplyFailureAction =
  | { phase: 'intro'; codeError: string; resume: true; applyError: '' }
  | { phase: 'review'; codeError: ''; resume: false; applyError: string; problems?: Problem[] };
export function applyFailureAction(f: Pick<Failure, 'message' | 'needsCode' | 'problems'>): ApplyFailureAction {
  if (f.needsCode) return { phase: 'intro', codeError: f.message, resume: true, applyError: '' };
  return { phase: 'review', codeError: '', resume: false, applyError: f.message, ...(f.problems ? { problems: f.problems } : {}) };
}

/** Where a code that was accepted leads: the review when an apply was interrupted, else the first step. */
export const afterCodeAccepted = (resume: boolean): 'review' | 'steps' => (resume ? 'review' : 'steps');

// ── the API ───────────────────────────────────────────────────────────────────

export function createSetupApi(base: string) {
  async function call<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }, code: string): Promise<Result<T>> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (code) headers['x-setup-code'] = code; // before a password exists; the session cookie carries it after
    let res: Response;
    try {
      res = await fetch(`${base}/api/setup${path}`, { method: init.method, credentials: 'include', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    } catch {
      return { ok: false, message: 'Could not reach the server. Is it still running?' };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, ...(data as T) };
    if (res.status === 401 && (data.error === 'setup_code' || data.error === 'setup_code_expired')) {
      return { ok: false, needsCode: true, message: String(data.message ?? 'Enter the setup code printed where `npm start` runs.') };
    }
    if (res.status === 401) return { ok: false, signedOut: true, message: 'You are signed out. Sign in again to carry on.' };
    // The lockout (429) puts its words, with the wait, in `message`; `error` is only a code.
    if (res.status === 429) return { ok: false, message: String(data.message ?? data.error ?? 'Too many tries. Wait a while, then try again.') };
    return { ok: false, message: String(data.error ?? 'Something went wrong.'), ...(Array.isArray(data.problems) ? { problems: data.problems as Problem[] } : {}) };
  }
  return {
    plan: (answers: Answers, code: string) => call<PlanReply>('/plan', { method: 'POST', body: { answers } }, code),
    validate: (id: string, value: unknown, answers: Answers, code: string) => call<{ ok: boolean; message: string }>('/validate', { method: 'POST', body: { id, value, answers } }, code),
    test: (probe: string, value: string, answers: Answers, code: string) => call<ProbeReply>('/test', { method: 'POST', body: { probe, value, answers } }, code),
    apply: (answers: Answers, code: string) => call<ApplyReply>('/apply', { method: 'POST', body: { answers } }, code),
  };
}
