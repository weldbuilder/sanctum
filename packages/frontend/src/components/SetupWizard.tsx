/**
 * SetupWizard — `npm run setup`, in the app.
 *
 * The questions come from the server (/api/setup/plan): the same plan the terminal walks, so the words are the terminal's. One step per
 * screen, Back and Next, each answer checked before the next screen, a review of everything before anything is written, and then the
 * restart notice. First run (no password yet): the page says why it is here and asks for the setup code printed where `npm start` runs.
 * Run again from Settings: the saved answers are the defaults, and the names and the avatar stay as they are unless changed.
 * Phone width first: one column, 16px inputs, big touch targets, Back and Next pinned to the bottom of the screen.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '../store/auth';
import { avatarSrc, useIdentity } from '../store/identity';
import {
  afterCodeAccepted, applyFailureAction, createSetupApi, hasAnswer, helpBlocks, madePassword, passwordRestartWarning, passwordStepWarning, planFailureAction, reconcileIndex, reviewRows, valueOf,
  type Answers, type ApplyReply, type PasswordSource, type PlanReply, type Problem, type SetupStep,
} from './setup/setupWizardState';

import { BASE } from '../lib/base';

type Phase = 'intro' | 'steps' | 'review' | 'applying' | 'done';

export interface SetupWizardProps {
  /** first_run: no password yet (the setup code opens it). rerun: a signed-in person, from Settings. */
  mode: 'first_run' | 'rerun';
  /** Run setup again closed or finished: back to Settings. */
  onClose?: () => void;
}

/** The checks a step can run, as buttons under it. */
const PROBES: Record<string, { probe: string; label: string; field?: string }> = {
  addProvider: { probe: 'codex_config', label: "Check Codex's config" },
  discordPrivateDir: { probe: 'discord_token', label: 'Check the bot token\'s shape', field: 'Paste the bot token here to check its shape. It is not saved.' },
  browserSeat: { probe: 'browser_filter', label: 'Check .mcp.json' },
};

export function SetupWizard({ mode, onClose }: SetupWizardProps) {
  const api = useMemo(() => createSetupApi(BASE), []);
  const login = useAuthStore((s) => s.login);
  const loggingIn = useAuthStore((s) => s.loggingIn);
  const loginError = useAuthStore((s) => s.loginError);
  const identity = useIdentity();

  const [phase, setPhase] = useState<Phase>('intro');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [steps, setSteps] = useState<SetupStep[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [answers, setAnswers] = useState<Answers>({});
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<unknown>('');
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [passwordSource, setPasswordSource] = useState<PasswordSource | undefined>(undefined);
  const [resume, setResume] = useState(false); // the code expired during apply: the next accepted code goes back to the review
  const [reply, setReply] = useState<ApplyReply | null>(null);
  const [probeText, setProbeText] = useState('');
  const [probeValue, setProbeValue] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const firstRun = mode === 'first_run';
  const sessionCode = firstRun ? code : '';

  const step: SetupStep | undefined = steps[index];

  // Each screen starts at the top, with what is held for it (the answer given, else its default).
  useEffect(() => {
    if (phase !== 'steps' || !step) return;
    setDraft(valueOf(step, answers));
    setFieldError('');
    setProbeText('');
    setProbeValue('');
    setShowSecret(false);
    bodyRef.current?.scrollTo?.({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, step?.id]);

  const load = useCallback(async (given: Answers, from: 'intro' | 'steps'): Promise<PlanReply | null> => {
    const r = await api.plan(given, sessionCode);
    if (!r.ok) {
      const a = planFailureAction(r, from);
      setCodeError(a.codeError);
      if (a.phase) setPhase(a.phase); else setFieldError(a.fieldError);
      return null;
    }
    setPasswordSource(r.passwordSource);
    return r;
  }, [api, sessionCode]);

  async function begin() {
    if (firstRun && !code.trim()) { setCodeError('Enter the setup code printed in the window where `npm start` runs.'); return; }
    setBusy(true); setCodeError('');
    const r = await load(resume ? answers : {}, 'intro'); // a code that expired during apply: the answers are kept, so ask with them
    setBusy(false);
    if (!r) return;
    setSteps(r.steps); setNotes(r.notes); setProblems(r.problems);
    const to = afterCodeAccepted(resume);
    setResume(false);
    setIndex(0); setPhase(to);
  }

  /** Check what is on screen, keep it, and go on: the plan is asked again because this answer may show or hide later steps. */
  async function next() {
    if (!step) return;
    const value = normalised(step, draft);
    setBusy(true); setFieldError('');
    const v = await api.validate(step.id, value, answers, sessionCode);
    if (!v.ok) {
      setBusy(false);
      if ('needsCode' in v && v.needsCode) { setCodeError(v.message); setPhase('intro'); return; }
      setFieldError(v.message || 'That answer needs another look.');
      return;
    }
    const kept: Answers = { ...answers, [step.id]: value };
    // A plugin's code is ratified against the digest the person was shown: send it back with the answer.
    if (step.meta?.digest) kept[`${step.id}#digest`] = step.meta.digest;
    const r = await load(kept, 'steps');
    setBusy(false);
    if (!r) return;
    setAnswers(kept);
    setSteps(r.steps); setNotes(r.notes); setProblems(r.problems);
    const at = r.steps.findIndex((s) => s.id === step.id);
    const nextIndex = at >= 0 ? at + 1 : reconcileIndex(steps, index, r.steps);
    if (nextIndex >= r.steps.length) setPhase('review'); else setIndex(nextIndex);
  }

  function back() {
    if (phase === 'review') { setPhase('steps'); setIndex(Math.max(steps.length - 1, 0)); return; }
    if (index === 0) { setPhase('intro'); return; }
    setIndex(index - 1);
  }

  async function runProbe() {
    if (!step) return;
    const p = PROBES[step.id];
    if (!p) return;
    setBusy(true); setProbeText('');
    const r = await api.test(p.probe, probeValue, answers, sessionCode);
    setBusy(false);
    setProbeText(r.message);
    setProbeValue(''); // a token typed to check its shape is not kept
  }

  async function apply() {
    setPhase('applying'); setApplyError('');
    const r = await api.apply(answers, sessionCode);
    if (!r.ok) {
      const a = applyFailureAction(r);
      setApplyError(a.applyError); setCodeError(a.codeError); setResume(a.resume);
      if (a.phase === 'review' && a.problems) setProblems(a.problems);
      setPhase(a.phase);
      return;
    }
    setReply({ restartNeeded: r.restartNeeded, changed: r.changed, notes: r.notes, passwordKeptByParent: r.passwordKeptByParent });
    setPhase('done');
  }

  async function finish() {
    if (firstRun) {
      const pw = typeof answers.password === 'string' ? answers.password : '';
      if (pw) await login(pw); // the new password signs in at once: the server reloaded its config
      return;
    }
    onClose?.();
  }

  const progress = phase === 'steps' && steps.length ? Math.round(((index + 1) / (steps.length + 1)) * 100) : phase === 'review' ? 96 : phase === 'done' ? 100 : 0;

  return (
    <div className="sw-shell" role="dialog" aria-modal="true" aria-label="Setup">
      <div className="sw-card">
        <header className="sw-head">
          <div className="sw-kicker">{phase === 'steps' && step ? (step.section ?? 'Setup') : phase === 'review' ? 'Review' : phase === 'done' ? 'Done' : 'Setup'}</div>
          {phase === 'steps' && <div className="sw-count" aria-live="polite">Step {index + 1} of {steps.length}</div>}
          {!firstRun && phase !== 'done' && phase !== 'applying' && (
            <button className="sw-x" onClick={onClose} aria-label="Close setup without saving">×</button>
          )}
          <div className="sw-bar" aria-hidden="true"><div className="sw-bar-fill" style={{ width: `${progress}%` }} /></div>
        </header>

        <div className="sw-body" ref={bodyRef}>
          {phase === 'intro' && (
            <section>
              <h1 className="sw-title">{firstRun ? 'Let’s set this up' : 'Run setup again'}</h1>
              {firstRun ? (
                <>
                  <p className="sw-p">No password has been set yet, so the app cannot let anyone in. That is why you are seeing this page and not a sign-in.</p>
                  <p className="sw-p">A few questions, a few minutes. Your answers are saved on this computer, in <code>sanctum.yaml</code> and <code>.env</code>, and nothing is written until the last screen.</p>
                  <label className="sw-label" htmlFor="sw-code">Setup code</label>
                  <p className="sw-hint">It is printed in the window where <code>npm start</code> is running. It works for 30 minutes.</p>
                  <input
                    id="sw-code" className={`sw-input sw-mono${codeError ? ' sw-input--error' : ''}`} value={code} autoComplete="off" autoCapitalize="off" spellCheck={false}
                    onChange={(e) => { setCode(e.target.value); setCodeError(''); }} onKeyDown={(e) => { if (e.key === 'Enter') void begin(); }}
                    aria-invalid={!!codeError} aria-describedby={codeError ? 'sw-code-error' : undefined} placeholder="12 letters and numbers"
                  />
                  {resume && <p className="sw-hint">Your answers are kept. Enter the new code and you go straight back to the review.</p>}
                  {codeError && <p className="sw-error" id="sw-code-error" role="alert">{codeError}</p>}
                </>
              ) : (
                <>
                  <p className="sw-p">Your saved answers are filled in. Press Next to keep one, or change it. Names and the avatar stay as they are unless you change them. Nothing is written until the last screen.</p>
                  {(codeError || applyError) && <p className="sw-error" role="alert">{codeError || applyError}</p>}
                </>
              )}
            </section>
          )}

          {phase === 'steps' && step && (
            <section>
              {!firstRun && step.id === 'companionName' && <img className="sw-avatar" src={avatarSrc(identity)} alt="" width={56} height={56} />}
              <h1 className="sw-q" id="sw-q">{step.question}</h1>
              {passwordStepWarning(step.id, passwordSource) && <div className="sw-restart" role="note"><strong>Heads up.</strong> {passwordStepWarning(step.id, passwordSource)}</div>}
              <Help lines={step.help} />
              <Control step={step} draft={draft} setDraft={(v) => { setDraft(v); setFieldError(''); }} showSecret={showSecret} setShowSecret={setShowSecret} error={fieldError} onEnter={() => void next()} />
              {fieldError && <p className="sw-error" id="sw-error" role="alert">{fieldError}</p>}
              {PROBES[step.id] && (
                <div className="sw-probe">
                  {PROBES[step.id].field && (
                    <input className="sw-input sw-mono" type="password" autoComplete="off" value={probeValue} onChange={(e) => setProbeValue(e.target.value)} placeholder={PROBES[step.id].field} aria-label={PROBES[step.id].field} />
                  )}
                  <button className="sw-btn sw-btn-quiet" onClick={() => void runProbe()} disabled={busy}>{PROBES[step.id].label}</button>
                  {probeText && <p className="sw-probe-text" role="status">{probeText}</p>}
                </div>
              )}
            </section>
          )}

          {phase === 'review' && (
            <section>
              <h1 className="sw-title">Check it over</h1>
              <p className="sw-p">This is what will be written. Secrets are never shown. Tap a line to change it.</p>
              {applyError && <p className="sw-error" role="alert">{applyError}</p>}
              {problems.length > 0 && (
                <ul className="sw-problems" role="alert">
                  {problems.map((p) => (
                    <li key={`${p.id}-${p.message}`}>
                      <button className="sw-link" onClick={() => { const i = steps.findIndex((s) => s.id === p.id); if (i >= 0) { setIndex(i); setPhase('steps'); } }}>
                        {steps.find((s) => s.id === p.id)?.question ?? p.id}
                      </button>: {p.message}
                    </li>
                  ))}
                </ul>
              )}
              <dl className="sw-review">
                {reviewRows(steps, answers).map((row, i, all) => (
                  <React.Fragment key={row.id}>
                    {(i === 0 || all[i - 1].section !== row.section) && <h2 className="sw-section">{row.section}</h2>}
                    <button className="sw-row" onClick={() => { const at = steps.findIndex((s) => s.id === row.id); if (at >= 0) { setIndex(at); setPhase('steps'); } }}>
                      <dt>{row.question}</dt>
                      <dd className={hasAnswer(steps[i], answers) ? '' : 'sw-default'}>{row.answer}</dd>
                    </button>
                  </React.Fragment>
                ))}
              </dl>
              {notes.length > 0 && (
                <>
                  <h2 className="sw-section">Good to know</h2>
                  <ul className="sw-notes">{notes.map((n, i) => <li key={`${i}-${n}`}>{n}</li>)}</ul>
                </>
              )}
              <p className="sw-p sw-hint">Before it writes <code>sanctum.yaml</code> or <code>.env</code> it keeps a copy of each, with the date in its name.</p>
            </section>
          )}

          {phase === 'applying' && (
            <section>
              <h1 className="sw-title">Writing it down…</h1>
              <p className="sw-p" role="status">One moment.</p>
            </section>
          )}

          {phase === 'done' && reply && (
            <section>
              <h1 className="sw-title">All set</h1>
              {reply.restartNeeded ? (
                <div className="sw-restart" role="status">
                  <strong>Restart the app to finish.</strong> Some of what you chose, like the model, the plugins and the phone address, is read once when it starts.
                  In the window where <code>npm start</code> runs, press <kbd>Ctrl</kbd>+<kbd>C</kbd>, then run <code>npm start</code> again.
                  {firstRun && ' You can sign in now; the restart can wait until you have looked around.'}
                </div>
              ) : (
                <p className="sw-p" role="status">Nothing needs a restart: it is all in effect.</p>
              )}
              {passwordRestartWarning(reply) && <div className="sw-restart" role="alert"><strong>Change APP_PASSWORD where the app is started.</strong> {passwordRestartWarning(reply)}</div>}
              <h2 className="sw-section">What was written</h2>
              <ul className="sw-notes">{reply.changed.map((c) => <li key={c.path}>{c.what} <code className="sw-path">{c.path}</code></li>)}</ul>
              {reply.notes.length > 0 && (
                <>
                  <h2 className="sw-section">Good to know</h2>
                  <ul className="sw-notes">{reply.notes.map((n, i) => <li key={`${i}-${n}`}>{n}</li>)}</ul>
                </>
              )}
              {loginError && <p className="sw-error" role="alert">{loginError}</p>}
            </section>
          )}
        </div>

        <footer className="sw-foot">
          {phase === 'intro' && (
            <>
              {!firstRun && <button className="sw-btn sw-btn-quiet" onClick={onClose}>Cancel</button>}
              <button className="sw-btn sw-btn-main" onClick={() => void begin()} disabled={busy}>{busy ? 'Opening…' : firstRun ? 'Start' : 'Next'}</button>
            </>
          )}
          {phase === 'steps' && (
            <>
              <button className="sw-btn sw-btn-quiet" onClick={back} disabled={busy}>Back</button>
              <button className="sw-btn sw-btn-main" onClick={() => void next()} disabled={busy}>{busy ? 'Checking…' : index === steps.length - 1 ? 'Review' : 'Next'}</button>
            </>
          )}
          {phase === 'review' && (
            <>
              <button className="sw-btn sw-btn-quiet" onClick={back}>Back</button>
              <button className="sw-btn sw-btn-main" onClick={() => void apply()} disabled={problems.length > 0}>Write it</button>
            </>
          )}
          {phase === 'done' && (
            <button className="sw-btn sw-btn-main sw-btn-wide" onClick={() => void finish()} disabled={loggingIn}>
              {firstRun ? (loggingIn ? 'Signing in…' : 'Sign in') : 'Close'}
            </button>
          )}
        </footer>
      </div>
      <style>{CSS}</style>
    </div>
  );
}

// ─── pieces ───────────────────────────────────────────────────────────────────

/** The steps whose answer is a path, an address, an id or a model name: shown in the monospace face. */
const MONO_IDS = /^(home|extraDirs|providerBaseUrl|providerId|providerModel|codexModel|codexProvider|claudeModel|dshModel|summarizerModel|summarizerProvider|discord\w+|ledgerDir|phoneOrigin|timezone)$/;

/** What the page holds for a step, as the value the server takes (a text answer is trimmed there). */
function normalised(step: SetupStep, draft: unknown): unknown {
  if (step.kind === 'yesno') return draft === true;
  if (step.kind === 'multichoice') return Array.isArray(draft) ? draft : [];
  return typeof draft === 'string' ? draft : String(draft ?? '');
}

function Help({ lines }: { lines: string[] }) {
  const blocks = helpBlocks(lines);
  if (!blocks.length) return null;
  return (
    <div className="sw-help">
      {blocks.map((b, i) => b.kind === 'p' ? <p key={i} className="sw-p">{b.text}</p>
        : b.kind === 'list' ? <ul key={i} className="sw-files">{b.items.map((it) => <li key={it}><code>{it}</code></li>)}</ul>
          : <p key={i} className="sw-p"><code className="sw-digest">{b.text}</code></p>)}
    </div>
  );
}

interface ControlProps {
  step: SetupStep;
  draft: unknown;
  setDraft: (v: unknown) => void;
  showSecret: boolean;
  setShowSecret: (b: boolean) => void;
  error: string;
  onEnter: () => void;
}

function Control({ step, draft, setDraft, showSecret, setShowSecret, error, onEnter }: ControlProps) {
  const ariaFor = { 'aria-labelledby': 'sw-q', 'aria-invalid': !!error, 'aria-describedby': error ? 'sw-error' : undefined } as const;
  const isRatify = step.id.startsWith('ratify_');

  if (step.kind === 'yesno') {
    const yes = draft === true;
    return (
      <div className="sw-choices sw-choices--two" role="radiogroup" aria-labelledby="sw-q">
        <button role="radio" aria-checked={yes} className={`sw-choice${yes ? ' sw-choice--on' : ''}`} onClick={() => setDraft(true)}>
          <span className="sw-choice-label">{isRatify ? 'Ratify this code' : 'Yes'}</span>
        </button>
        <button role="radio" aria-checked={!yes} className={`sw-choice${!yes ? ' sw-choice--on' : ''}`} onClick={() => setDraft(false)}>
          <span className="sw-choice-label">{isRatify ? 'Leave it off' : 'No'}</span>
        </button>
      </div>
    );
  }

  if (step.kind === 'choice') {
    return (
      <div className="sw-choices" role="radiogroup" aria-labelledby="sw-q">
        {(step.options ?? []).map((o) => (
          <button key={o.value} role="radio" aria-checked={draft === o.value} className={`sw-choice${draft === o.value ? ' sw-choice--on' : ''}`} onClick={() => setDraft(o.value)}>
            <span className="sw-choice-label">{o.label}</span>
            {o.detail && <span className="sw-choice-detail">{o.detail}</span>}
          </button>
        ))}
      </div>
    );
  }

  if (step.kind === 'multichoice') {
    const picked = Array.isArray(draft) ? (draft as string[]) : [];
    return (
      <div className="sw-choices" role="group" aria-labelledby="sw-q">
        {(step.options ?? []).map((o) => {
          const on = picked.includes(o.value);
          return (
            <button key={o.value} role="checkbox" aria-checked={on} className={`sw-choice${on ? ' sw-choice--on' : ''}`} onClick={() => setDraft(on ? picked.filter((x) => x !== o.value) : [...picked, o.value])}>
              <span className="sw-choice-label">{o.label}</span>
              <span className="sw-choice-detail">{o.value}</span>
            </button>
          );
        })}
        <p className="sw-hint">{picked.length ? `${picked.length} turned on.` : 'None turned on.'}</p>
      </div>
    );
  }

  if (step.kind === 'secret') {
    const text = typeof draft === 'string' ? draft : '';
    return (
      <div className="sw-secret">
        <div className="sw-secret-row">
          <input
            className={`sw-input sw-mono${error ? ' sw-input--error' : ''}`} type={showSecret ? 'text' : 'password'} value={text} autoComplete="new-password" autoCapitalize="off" spellCheck={false}
            placeholder={step.saved ? 'set — leave empty to keep it' : 'not set'} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onEnter(); }} {...ariaFor}
          />
          <button className="sw-btn sw-btn-quiet sw-btn-small" onClick={() => setShowSecret(!showSecret)} aria-pressed={showSecret}>{showSecret ? 'Hide' : 'Show'}</button>
        </div>
        {step.id === 'password' && (
          <button className="sw-btn sw-btn-quiet sw-btn-small" onClick={() => { setDraft(madePassword()); setShowSecret(true); }}>Make one up for me</button>
        )}
        {step.id === 'password' && <p className="sw-hint">{step.saved ? 'A password is set. Leave this empty to keep it.' : 'Write it down: it is what you sign in with.'}</p>}
      </div>
    );
  }

  // text
  const text = typeof draft === 'string' ? draft : '';
  const mono = MONO_IDS.test(step.id);
  return (
    <input
      className={`sw-input${mono ? ' sw-mono' : ''}${error ? ' sw-input--error' : ''}`} type="text" value={text} autoComplete="off" autoCapitalize="off" spellCheck={false}
      onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onEnter(); }} {...ariaFor}
    />
  );
}

// ─── styles: the login card's parchment, one column, phone first ──────────────

const CSS = `
/* The house's dark leather and brass, as the foyer's onboarding: no ivory field or card, whatever the skin. */
.sw-shell {
  --sw-plate: #1C110C; --sw-ink: #F4E7D6; --sw-ink-2: #D8C3A8; --sw-ink-3: #BBA488; --sw-accent-ink: #E9C98F;
  --sw-accent: #7A391F; --sw-on-accent: #FFF1E2; --sw-trim: #D49A66; --sw-trim-quiet: #5A4130; --sw-focus: #F0C99A; --sw-bad: #F3B3A7;
  position: fixed; inset: 0; z-index: 1000; display: flex; justify-content: center; align-items: stretch; background: #120A07;
}
.sw-card {
  position: relative; display: flex; flex-direction: column; width: 100%; max-width: 38rem; min-height: 0; height: 100dvh;
  background: url(/house/leather-v1.webp) center / 420px, var(--sw-plate); background-blend-mode: soft-light;
  color: var(--sw-ink); font-family: var(--font-serif, 'Lora', Georgia, serif);
  padding-top: env(safe-area-inset-top, 0px);
}
@media (min-width: 640px) { .sw-card { height: min(100dvh - 2rem, 52rem); margin: 1rem 0; border: 1px solid var(--sw-trim); border-radius: 14px; box-shadow: 0 0 22px -6px var(--sw-trim), 0 30px 90px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.07); } }
.sw-head { position: relative; padding: 0.9rem 16px 0.6rem; flex: none; }
.sw-kicker { font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sw-accent-ink); font-family: var(--font-body, system-ui, sans-serif); }
.sw-count { font-size: 0.8rem; color: var(--sw-ink-3); font-family: var(--font-body, system-ui, sans-serif); margin-top: 0.1rem; }
.sw-x { position: absolute; top: 0.4rem; right: 8px; width: 44px; height: 44px; border: none; background: transparent; font-size: 1.8rem; color: var(--sw-ink-2); cursor: pointer; }
.sw-bar { margin-top: 0.6rem; height: 3px; background: var(--sw-trim-quiet); border-radius: 2px; overflow: hidden; }
.sw-bar-fill { height: 100%; background: var(--sw-trim); box-shadow: 0 0 8px var(--sw-trim); transition: width 240ms cubic-bezier(0.16, 1, 0.3, 1); }
.sw-body { flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 0.5rem 16px 1.5rem; }
.sw-title { margin: 0.5rem 0 0.75rem; font-size: 1.9rem; font-weight: 500; line-height: 1.15; }
.sw-q { margin: 0.5rem 0 0.75rem; font-size: 1.4rem; font-weight: 500; line-height: 1.25; }
.sw-section { margin: 1.25rem 0 0.25rem; font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sw-accent-ink); font-family: var(--font-body, system-ui, sans-serif); font-weight: 600; }
.sw-p { margin: 0 0 0.75rem; font-size: 1rem; line-height: 1.5; }
.sw-hint { font-size: 0.875rem; color: var(--sw-ink-3); margin: 0.25rem 0 0.5rem; line-height: 1.4; }
.sw-label { display: block; font-weight: 600; margin-top: 1rem; color: var(--sw-ink-2); }
.sw-help { margin-bottom: 0.75rem; }
.sw-avatar { border-radius: 50%; object-fit: cover; margin-bottom: 0.25rem; box-shadow: 0 0 0 1px var(--sw-trim), 0 2px 6px rgba(0, 0, 0, 0.45); }
.sw-input { width: 100%; box-sizing: border-box; min-height: 48px; background: linear-gradient(180deg, rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0.03)); border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 8px; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18); color: var(--sw-ink); font-family: inherit; font-size: 16px; padding: 0.7rem 0.9rem; outline: none; -webkit-appearance: none; }
.sw-input::placeholder { color: var(--sw-ink-3); }
.sw-input:focus { border-color: var(--sw-trim); box-shadow: 0 0 0 2px var(--sw-focus); }
.sw-input--error { border-color: var(--sw-bad); }
.sw-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 16px; }
.sw-error { margin: 0.5rem 0 0; color: var(--sw-bad); font-size: 0.95rem; line-height: 1.4; }
.sw-secret { display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; }
.sw-secret-row { display: flex; gap: 0.5rem; width: 100%; }
.sw-choices { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.25rem; }
.sw-choices--two { flex-direction: row; }
.sw-choices--two .sw-choice { flex: 1 1 0; align-items: center; text-align: center; }
.sw-choice { display: flex; flex-direction: column; gap: 0.2rem; text-align: left; width: 100%; min-height: 52px; padding: 0.75rem 0.9rem; background: linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.05)); border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 8px; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28), 0 6px 18px rgba(0, 0, 0, 0.28); color: inherit; font-family: inherit; cursor: pointer; }
.sw-choice--on { border-color: var(--sw-trim); background: linear-gradient(180deg, rgba(255, 255, 255, 0.20), rgba(255, 255, 255, 0.06)), rgba(122, 57, 31, 0.42); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.32), inset 0 0 0 1px var(--sw-trim), 0 0 18px -4px var(--sw-trim); }
.sw-choice:focus-visible, .sw-btn:focus-visible, .sw-row:focus-visible, .sw-link:focus-visible, .sw-x:focus-visible { outline: 2px solid var(--sw-focus); outline-offset: 2px; }
.sw-choice-label { font-size: 1.05rem; font-weight: 600; }
.sw-choice-detail { font-size: 0.875rem; color: var(--sw-ink-2); line-height: 1.35; }
.sw-files { margin: 0 0 0.75rem; padding: 0.5rem 0.75rem; list-style: none; background: rgba(0, 0, 0, 0.22); border: 1px solid var(--sw-trim-quiet); border-radius: 8px; max-height: 11rem; overflow: auto; }
.sw-files li { padding: 0.1rem 0; }
.sw-files code, .sw-digest, .sw-path, .sw-p code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.82rem; word-break: break-all; }
.sw-probe { margin-top: 1rem; display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; }
.sw-probe .sw-input { width: 100%; }
.sw-probe-text { margin: 0; font-size: 0.95rem; line-height: 1.4; padding: 0.5rem 0.75rem; background: rgba(0, 0, 0, 0.22); border-left: 3px solid var(--sw-trim); border-radius: 4px; }
.sw-review { margin: 0; }
.sw-row { display: block; width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--sw-trim-quiet); padding: 0.6rem 0; min-height: 44px; font-family: inherit; color: inherit; cursor: pointer; }
.sw-row dt { font-size: 0.9rem; color: var(--sw-ink-2); }
.sw-row dd { margin: 0.1rem 0 0; font-size: 1.05rem; font-weight: 600; word-break: break-word; }
.sw-row dd.sw-default { font-weight: 400; color: var(--sw-ink-2); }
.sw-notes, .sw-problems { margin: 0.25rem 0 0.75rem; padding-left: 1.1rem; line-height: 1.45; }
.sw-notes li, .sw-problems li { margin: 0.25rem 0; font-size: 0.95rem; word-break: break-word; }
.sw-problems { color: var(--sw-bad); }
.sw-link { background: none; border: none; padding: 0; color: var(--sw-accent-ink); text-decoration: underline; text-underline-offset: 3px; font: inherit; cursor: pointer; min-height: 32px; }
.sw-restart { margin: 0.5rem 0 1rem; padding: 0.8rem 0.9rem; background: rgba(0, 0, 0, 0.22); border: 1px solid var(--sw-trim); border-radius: 8px; line-height: 1.5; }
.sw-restart kbd { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.85em; padding: 0 0.25em; border: 1px solid var(--sw-trim-quiet); border-radius: 3px; background: rgba(0, 0, 0, 0.3); }
.sw-foot { flex: none; display: flex; gap: 0.75rem; padding: 0.75rem 16px calc(env(safe-area-inset-bottom, 0px) + 0.75rem); border-top: 1px solid var(--sw-trim-quiet); background: rgba(28, 17, 12, 0.96); }
.sw-btn { min-height: 48px; padding: 0.6rem 1.25rem; border-radius: 8px; font-family: inherit; font-size: 1.05rem; cursor: pointer; border: 1px solid var(--sw-trim); }
.sw-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.sw-btn-main { flex: 1 1 auto; background: linear-gradient(180deg, rgba(255, 255, 255, 0.14), transparent 60%), var(--sw-accent); color: var(--sw-on-accent); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 4px 12px rgba(0, 0, 0, 0.45); }
.sw-btn-main:hover:not(:disabled) { background: linear-gradient(180deg, rgba(255, 255, 255, 0.2), transparent 60%), var(--sw-accent); }
.sw-btn-quiet { background: transparent; color: var(--sw-ink); }
.sw-btn-small { min-height: 44px; padding: 0.4rem 0.9rem; font-size: 0.95rem; }
.sw-btn-wide { width: 100%; }
@media (prefers-reduced-motion: reduce) { .sw-bar-fill { transition: none; } }
`;
