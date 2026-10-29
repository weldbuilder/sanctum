/**
 * Onboarding — the first run, in three screens, standing in the house's foyer.
 *
 *   1. Make it yours      the setup code (first run only), your name, your companion's name; the time zone from this device
 *   2. Connect your AI    Claude or Codex, then only that harness's way in, its model, and a real check that it connects
 *   3. You're ready       the house password (made up here, shown once, with Copy), then Start chatting or Explore more
 *
 * Only those answers are sent; every other setup answer takes the server plan's default (onboarding/onboardingState.ts), and all of
 * them stay in Settings. The step-by-step wizard (SetupWizard.tsx) is still there, from Settings, for everything else.
 * The foyer and its walnut and brass are the house's own: no companion's skin applies here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '../store/auth';
import { BASE, COMPANION_PREFIX } from '../lib/base';
import { createSetupApi, madePassword, passwordRestartWarning, type ApplyReply, type ProbeReply } from './setup/setupWizardState';
import {
  CLAUDE_MODELS, EXPLORE_PREFILL_KEY, codexTarget, connectionBody, deviceTimezone, explorePrompt, initialConnect, onboardingAnswers, placeOf,
  readyToCheck, withCodexProvider, withHarness, type CodexProvider, type Connect, type Harness, type Method,
} from './onboarding/onboardingState';

type Screen = 1 | 2 | 3;

export function Onboarding() {
  const api = useMemo(() => createSetupApi(BASE), []);
  const login = useAuthStore((s) => s.login);
  const loggingIn = useAuthStore((s) => s.loggingIn);
  const loginError = useAuthStore((s) => s.loginError);

  const [screen, setScreen] = useState<Screen>(1);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [userName, setUserName] = useState('');
  const [companionName, setCompanionName] = useState('');
  const [timezone, setTimezone] = useState(deviceTimezone);
  const [tzOpen, setTzOpen] = useState(false);
  const [namesError, setNamesError] = useState('');
  const [connect, setConnect] = useState<Connect>(initialConnect);
  const [showKey, setShowKey] = useState(false);
  const [check, setCheck] = useState<ProbeReply | null>(null);
  const [checking, setChecking] = useState(false);
  const [skipCheck, setSkipCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [reply, setReply] = useState<ApplyReply | null>(null);
  const [password] = useState(() => madePassword());
  const [copied, setCopied] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const name = companionName.trim() || 'your companion';
  // The browser's own list leaves out UTC, which a server often runs on (and a tenant must match its server's clock): it is always offered, as is this device's.
  const zones = useMemo(() => {
    let known: string[] = [];
    try { known = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { /* only the two below */ }
    return [...new Set([...known, 'UTC', deviceTimezone()])].sort();
  }, []);
  // The connection on screen now, for a check that answers after it changed (see runCheck).
  const connectNow = useRef(connect);
  connectNow.current = connect;
  const checkRun = useRef(0);

  // Each screen starts at its heading, for a screen reader and for the keyboard.
  useEffect(() => { headingRef.current?.focus(); }, [screen]);

  const set = (patch: Partial<Connect>) => { setConnect((c) => ({ ...c, ...patch })); setCheck(null); setSkipCheck(false); };

  // A login is checked as soon as it is chosen (nothing to type); a key waits for the button.
  useEffect(() => {
    if (screen !== 2 || connect.method !== 'login') return;
    void runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, connect.harness, connect.method]);

  async function runCheck() {
    if (!readyToCheck(connect)) return;
    const run = ++checkRun.current;
    setChecking(true);
    const body = connectionBody(connect);
    const sent = JSON.stringify(body);
    const r = await fetch(`${BASE}/api/setup/test`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-setup-code': code.trim() }, body: sent,
    }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => ({})) })).catch(() => null);
    if (run === checkRun.current) setChecking(false);
    // An answer about a key or harness that is no longer on screen (or overtaken by a newer check) never decides whether Move in opens.
    if (run !== checkRun.current || JSON.stringify(connectionBody(connectNow.current)) !== sent) return;
    if (!r) { setCheck({ ok: false, message: 'Could not reach Sanctum. Is it still running?' }); return; }
    if (r.status === 401) { setCodeError(String((r.data as { message?: string }).message ?? 'Enter the setup code again.')); setScreen(1); return; }
    setCheck(r.status === 200 ? (r.data as ProbeReply) : { ok: false, message: String((r.data as { error?: string }).error ?? 'The check failed.') });
  }

  async function fromYours() {
    setNamesError(''); setCodeError('');
    if (!code.trim()) { setCodeError('Enter the setup code. It is shown in the window where Sanctum is running.'); return; }
    if (!userName.trim() || !companionName.trim()) { setNamesError('Both names, please. You can change them later.'); return; }
    setBusy(true);
    const plan = await api.plan({}, code.trim());
    if (!plan.ok) { setBusy(false); if (plan.needsCode) setCodeError(plan.message); else setNamesError(plan.message); return; }
    for (const [id, value] of [['userName', userName.trim()], ['companionName', companionName.trim()], ['timezone', timezone]] as const) {
      // (an answer the server does not take comes back as ok: false with its sentence)
      const v = await api.validate(id, value, {}, code.trim());
      if (!v.ok) {
        setBusy(false);
        if (v.needsCode) setCodeError(v.message); else setNamesError(v.message);
        if (id === 'timezone') setTzOpen(true); // the sentence names the zone to use: open the list to choose it
        return;
      }
    }
    setBusy(false);
    setScreen(2);
  }

  async function moveIn() {
    setBusy(true); setApplyError('');
    const r = await api.apply(onboardingAnswers({ userName, companionName, timezone }, connect, password), code.trim());
    setBusy(false);
    if (!r.ok) {
      if (r.needsCode) { setCodeError(r.message); setScreen(1); return; }
      setApplyError(r.problems?.length ? r.problems.map((p) => p.message).join(' ') : r.message);
      return;
    }
    setReply({ restartNeeded: r.restartNeeded, changed: r.changed, notes: r.notes, passwordKeptByParent: r.passwordKeptByParent });
    setScreen(3);
  }

  async function copyPassword() {
    try { await navigator.clipboard.writeText(password); setCopied(true); return; } catch { /* not a secure page: select it instead */ }
    pwRef.current?.select();
    try { setCopied(document.execCommand('copy')); } catch { setCopied(false); }
  }

  async function enter(explore: boolean) {
    if (explore) { try { sessionStorage.setItem(EXPLORE_PREFILL_KEY, explorePrompt(companionName.trim() || 'there')); } catch { /* the chat simply opens empty */ } }
    // The app opens where the address points once signed in: the chat.
    try { window.history.replaceState(null, '', `${COMPANION_PREFIX || ''}/chat`); } catch { /* stays on Home */ }
    await login(password);
  }

  const canMoveIn = !busy && (check?.ok === true || skipCheck);
  const tgt = codexTarget(connect);

  return (
    <div className="ob-shell" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <div className="ob-card">
        <header className="ob-head">
          <div className="ob-kicker">
            <span>{screen === 1 ? 'Welcome to Sanctum' : name}</span>
            <span className="ob-step" aria-live="polite">{screen} of 3</span>
          </div>
          <div className="ob-bar" aria-hidden="true"><i style={{ width: `${Math.round((screen / 3) * 100)}%` }} /></div>
        </header>

        <div className="ob-body">
          {screen === 1 && (
            <section>
              <h1 className="ob-title" id="ob-title" tabIndex={-1} ref={headingRef}>Make it yours</h1>
              <p className="ob-help">Two names, and the house is ready to be lived in.</p>

              <label className="ob-label" htmlFor="ob-code">Setup code</label>
              <input id="ob-code" className={`ob-input ob-mono${codeError ? ' ob-input--error' : ''}`} value={code} autoComplete="off" autoCapitalize="off" spellCheck={false}
                onChange={(e) => { setCode(e.target.value); setCodeError(''); }} aria-invalid={!!codeError} aria-describedby="ob-code-hint" placeholder="12 letters and numbers" />
              <p className="ob-hint" id="ob-code-hint">It's shown in the window where Sanctum is running, and works for 30 minutes.</p>
              {codeError && <p className="ob-error" role="alert">{codeError}</p>}

              <label className="ob-label" htmlFor="ob-you">What should {companionName.trim() || 'they'} call you?</label>
              <input id="ob-you" className="ob-input" value={userName} autoComplete="given-name" onChange={(e) => { setUserName(e.target.value); setNamesError(''); }} />

              <label className="ob-label" htmlFor="ob-them">What's your companion's name?</label>
              <input id="ob-them" className="ob-input" value={companionName} autoComplete="off" onChange={(e) => { setCompanionName(e.target.value); setNamesError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void fromYours(); }} />
              {namesError && <p className="ob-error" role="alert">{namesError}</p>}

              {tzOpen && zones.length ? (
                <>
                  <label className="ob-label" htmlFor="ob-tz">Time zone</label>
                  <select id="ob-tz" className="ob-input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                    {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
                  </select>
                </>
              ) : (
                <p className="ob-hint">Time zone: {placeOf(timezone)}, from this device. {zones.length > 0 && <button className="ob-link" onClick={() => setTzOpen(true)}>Change</button>}</p>
              )}
            </section>
          )}

          {screen === 2 && (
            <section>
              <h1 className="ob-title" id="ob-title" tabIndex={-1} ref={headingRef}>Connect {name}'s mind</h1>
              <p className="ob-help">Choose what {name} thinks with. You can change this any time in Settings.</p>

              <Choices label="Which AI?" value={connect.harness} onChange={(v) => { setConnect((c) => withHarness(c, v as Harness)); setCheck(null); setSkipCheck(false); }} options={[
                { value: 'claude', label: 'Claude', detail: 'By Anthropic.' },
                { value: 'codex', label: 'Codex', detail: 'By OpenAI. Your ChatGPT account, or an API key.' },
                { value: 'dsh', label: 'DeepSeek', detail: "DeepSeek's own harness. New, and still in testing." },
              ]} />

              {connect.harness !== 'dsh' && <Choices label="How do you sign in?" value={connect.method} onChange={(v) => set({ method: v as Method, key: '' })} options={connect.harness === 'claude' ? [
                { value: 'login', label: 'My Claude account', detail: 'The Claude account signed in on this computer.' },
                { value: 'key', label: 'An API key', detail: 'From console.anthropic.com.' },
              ] : [
                { value: 'login', label: 'My ChatGPT account', detail: 'The ChatGPT account signed in to Codex on this computer.' },
                { value: 'key', label: 'An API key', detail: 'OpenAI, DeepSeek, or another provider.' },
              ]} />}

              {connect.harness === 'codex' && connect.method === 'key' && (
                <>
                  <label className="ob-label" htmlFor="ob-provider">Provider</label>
                  <select id="ob-provider" className="ob-input" value={connect.codexProvider} onChange={(e) => { setConnect((c) => withCodexProvider(c, e.target.value as CodexProvider)); setCheck(null); }}>
                    <option value="openai">OpenAI</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="other">Another provider…</option>
                  </select>
                  {connect.codexProvider === 'other' && (
                    <>
                      <label className="ob-label" htmlFor="ob-oname">Its name</label>
                      <input id="ob-oname" className="ob-input" value={connect.otherName} onChange={(e) => set({ otherName: e.target.value })} placeholder="e.g. My local server" />
                      <label className="ob-label" htmlFor="ob-ourl">Its address</label>
                      <input id="ob-ourl" className="ob-input ob-mono" value={connect.otherBaseUrl} onChange={(e) => set({ otherBaseUrl: e.target.value })} placeholder="https://…/v1" autoCapitalize="off" spellCheck={false} />
                    </>
                  )}
                </>
              )}

              {connect.method === 'key' && (
                <>
                  <label className="ob-label" htmlFor="ob-key">{connect.harness === 'claude' ? 'Anthropic API key' : connect.harness === 'dsh' ? 'DeepSeek API key' : `${tgt.name} API key`}</label>
                  <div className="ob-row">
                    <input id="ob-key" className="ob-input ob-mono" type={showKey ? 'text' : 'password'} value={connect.key} autoComplete="off" autoCapitalize="off" spellCheck={false}
                      onChange={(e) => set({ key: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void runCheck(); }} />
                    <button className="ob-btn ob-btn--quiet ob-btn--small" onClick={() => setShowKey(!showKey)} aria-pressed={showKey}>{showKey ? 'Hide' : 'Show'}</button>
                  </div>
                  <p className="ob-hint">{connect.harness === 'dsh' ? 'From platform.deepseek.com, under API keys. ' : ''}It's saved only on this computer, and never shown again.</p>
                </>
              )}

              {connect.harness === 'claude' ? (
                <>
                  <label className="ob-label" htmlFor="ob-model">Model</label>
                  <select id="ob-model" className="ob-input" value={connect.claudeModel} onChange={(e) => setConnect((c) => ({ ...c, claudeModel: e.target.value }))}>
                    {CLAUDE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  <p className="ob-hint">{CLAUDE_MODELS.find((m) => m.value === connect.claudeModel)?.detail}</p>
                </>
              ) : connect.harness === 'dsh' ? (
                <p className="ob-hint">DeepSeek Harness uses DeepSeek's default model. You can change the model in Settings.</p>
              ) : connect.method === 'key' ? (
                <>
                  <label className="ob-label" htmlFor="ob-cmodel">Model</label>
                  <input id="ob-cmodel" className="ob-input ob-mono" value={connect.codexModel} onChange={(e) => set({ codexModel: e.target.value })} autoCapitalize="off" spellCheck={false} />
                </>
              ) : (
                <p className="ob-hint">Codex chooses the model your ChatGPT plan includes.</p>
              )}

              <div className="ob-check" aria-live="polite">
                {connect.method === 'key' && !check && (
                  <button className="ob-btn ob-btn--quiet" onClick={() => void runCheck()} disabled={checking || !readyToCheck(connect)}>{checking ? 'Checking…' : 'Check the connection'}</button>
                )}
                {checking && connect.method === 'login' && <p className="ob-status">Checking…</p>}
                {check && (
                  <p className={`ob-status ${check.ok ? 'ob-status--ok' : 'ob-status--bad'}`}>
                    <span aria-hidden="true">{check.ok ? '✓' : '!'}</span> {check.message}
                  </p>
                )}
                {check && !check.ok && (
                  <div className="ob-row ob-row--start">
                    <button className="ob-btn ob-btn--quiet ob-btn--small" onClick={() => void runCheck()} disabled={checking || !readyToCheck(connect)}>Check again</button>
                    {!skipCheck && <button className="ob-link" onClick={() => setSkipCheck(true)}>Continue without checking</button>}
                  </div>
                )}
              </div>
              {applyError && <p className="ob-error" role="alert">{applyError}</p>}
            </section>
          )}

          {screen === 3 && reply && (
            <section>
              <h1 className="ob-title" id="ob-title" tabIndex={-1} ref={headingRef}>You're ready</h1>
              <p className="ob-help">{companionName.trim()} is home. This is the password for this house: keep it somewhere safe. You'll use it on your phone too.</p>
              <label className="ob-label" htmlFor="ob-pw">Your password</label>
              <div className="ob-row">
                <input id="ob-pw" ref={pwRef} className="ob-input ob-mono" readOnly value={password} onFocus={(e) => e.currentTarget.select()} />
                <button className="ob-btn ob-btn--quiet ob-btn--small" onClick={() => void copyPassword()}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <p className="ob-hint">You can change it later in Settings, under Preferences.</p>
              {reply.restartNeeded && (
                <p className="ob-note" role="status">One last thing: Sanctum needs a restart to take in everything you chose. Ask your AI to restart it, or stop it where it's running and start it again. You can look around first.</p>
              )}
              {passwordRestartWarning(reply) && <p className="ob-note" role="alert">{passwordRestartWarning(reply)}</p>}
              {loginError && <p className="ob-error" role="alert">{loginError}</p>}
            </section>
          )}
        </div>

        <footer className="ob-foot">
          {screen === 1 && <button className="ob-btn ob-btn--main" onClick={() => void fromYours()} disabled={busy}>{busy ? 'One moment…' : 'Next'}</button>}
          {screen === 2 && (
            <>
              <button className="ob-btn ob-btn--quiet" onClick={() => setScreen(1)} disabled={busy}>Back</button>
              <button className="ob-btn ob-btn--main" onClick={() => void moveIn()} disabled={!canMoveIn}>{busy ? 'Moving in…' : 'Move in'}</button>
            </>
          )}
          {screen === 3 && (
            <div className="ob-actions">
              <button className="ob-btn ob-btn--main" onClick={() => void enter(false)} disabled={loggingIn}>{loggingIn ? 'Opening the door…' : 'Start chatting'}</button>
              <button className="ob-btn ob-btn--quiet" onClick={() => void enter(true)} disabled={loggingIn}>Explore more with {companionName.trim()}</button>
            </div>
          )}
        </footer>
      </div>
      <style>{CSS}</style>
    </div>
  );
}

function Choices({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string; detail: string }[] }) {
  return (
    <fieldset className="ob-fieldset">
      <legend className="ob-label">{label}</legend>
      <div className="ob-choices" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} role="radio" aria-checked={value === o.value} className="ob-choice" onClick={() => onChange(o.value)}>
            <b>{o.label}</b><span>{o.detail}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

// ─── the house: walnut, brass and copper, in the foyer. Its own colours, never a skin's. ──────────
// Contrast (WCAG): ink #F4E7D6 on #1C110C 15.1:1; ink-2 #D8C3A8 11.0:1; ink-3 #BBA488 7.9:1; accent-ink #E9C98F 11.6:1;
// on-accent #FFF1E2 on #7A391F 8.4:1; the focus ring #F0C99A on the card 11:1; the brass edge #D49A66 on the card 7.6:1.

const CSS = `
.ob-shell {
  --ob-plate: #1C110C; --ob-chrome: #20130E; --ob-ink: #F4E7D6; --ob-ink-2: #D8C3A8; --ob-ink-3: #BBA488; --ob-accent-ink: #E9C98F;
  --ob-accent: #7A391F; --ob-on-accent: #FFF1E2; --ob-trim: #D49A66; --ob-trim-quiet: #5A4130; --ob-focus: #F0C99A;
  --ob-ok: #B5D6A4; --ob-bad: #F3B3A7;
  --ob-sans: 'Source Sans 3', -apple-system, 'Segoe UI', system-ui, sans-serif;
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; overflow-y: auto;
  padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
  color: var(--ob-ink); font-family: var(--ob-sans); background: #120A07; isolation: isolate;
}
.ob-shell::before { content: ''; position: fixed; inset: -24px; z-index: -1;
  background: radial-gradient(ellipse 80% 75% at 50% 45%, transparent 50%, rgba(0,0,0,0.6) 100%), linear-gradient(rgba(255,160,80,0.08), rgba(255,160,80,0.08)),
    url(/house/foyer-v1.webp) center / cover no-repeat;
  filter: blur(5px) brightness(0.8); }
.ob-card { position: relative; width: 100%; max-width: 34rem; margin: auto; display: flex; flex-direction: column;
  background: url(/house/leather-v1.webp) center / 420px, var(--ob-plate); background-blend-mode: soft-light;
  border: 1px solid var(--ob-trim); border-radius: 14px;
  box-shadow: 0 0 22px -6px var(--ob-trim), 0 30px 90px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.07);
  animation: ob-rise 420ms cubic-bezier(0.16, 1, 0.3, 1) both; }
@keyframes ob-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
.ob-head { padding: 24px 28px 4px; }
.ob-kicker { display: flex; justify-content: space-between; font: 600 12px/16px var(--ob-sans); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ob-accent-ink); }
.ob-step { color: var(--ob-ink-3); }
.ob-bar { margin-top: 12px; height: 3px; background: var(--ob-trim-quiet); border-radius: 2px; overflow: hidden; }
.ob-bar i { display: block; height: 100%; background: var(--ob-trim); box-shadow: 0 0 8px var(--ob-trim); transition: width 420ms cubic-bezier(0.16, 1, 0.3, 1); }
.ob-body { padding: 4px 28px 8px; }
.ob-title { margin: 14px 0 6px; font: 500 34px/1.15 'Cormorant Garamond', 'EB Garamond', Georgia, serif; color: var(--ob-ink); outline: none; }
.ob-help { margin: 0 0 6px; font-size: 16px; line-height: 24px; color: var(--ob-ink-2); }
.ob-label { display: block; margin: 16px 0 6px; font-size: 14px; font-weight: 600; color: var(--ob-ink-2); padding: 0; }
.ob-fieldset { border: 0; margin: 18px 0 0; padding: 0; min-width: 0; }
.ob-fieldset > legend.ob-label { margin: 0 0 8px; }
.ob-input { width: 100%; box-sizing: border-box; min-height: 48px; padding: 0 14px; border-radius: 8px; font: 400 16px/1.2 var(--ob-sans); color: var(--ob-ink);
  background: linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.03)); border: 1px solid rgba(255,255,255,0.22);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.18); -webkit-appearance: none; appearance: none; }
select.ob-input { padding-right: 36px; background-image: linear-gradient(45deg, transparent 50%, var(--ob-ink-2) 50%), linear-gradient(135deg, var(--ob-ink-2) 50%, transparent 50%), linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.03));
  background-position: calc(100% - 19px) 21px, calc(100% - 14px) 21px, 0 0; background-size: 5px 5px, 5px 5px, 100% 100%; background-repeat: no-repeat; }
select.ob-input option { background: var(--ob-plate); color: var(--ob-ink); }
.ob-input::placeholder { color: var(--ob-ink-3); }
.ob-input:focus-visible, .ob-btn:focus-visible, .ob-choice:focus-visible, .ob-link:focus-visible { outline: 2px solid var(--ob-focus); outline-offset: 2px; }
.ob-input--error { border-color: var(--ob-bad); }
.ob-mono { font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; letter-spacing: 0.02em; }
.ob-hint { margin: 8px 0 0; font-size: 14px; line-height: 20px; color: var(--ob-ink-3); }
.ob-error { margin: 8px 0 0; font-size: 15px; line-height: 21px; color: var(--ob-bad); }
.ob-note { margin: 16px 0 0; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--ob-trim-quiet); background: rgba(0,0,0,0.22); font-size: 15px; line-height: 22px; color: var(--ob-ink-2); }
.ob-choices { display: flex; flex-direction: column; gap: 10px; }
.ob-choice { display: flex; flex-direction: column; gap: 2px; width: 100%; min-height: 56px; padding: 12px 16px; text-align: left; cursor: pointer; border-radius: 8px; color: var(--ob-ink); font: inherit;
  background: linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0.05)); -webkit-backdrop-filter: blur(10px) saturate(1.25); backdrop-filter: blur(10px) saturate(1.25);
  border: 1px solid rgba(255,255,255,0.22); box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 6px 18px rgba(0,0,0,0.28); transition: border-color 150ms, box-shadow 240ms, background-color 150ms; }
.ob-choice b { font-size: 17px; font-weight: 600; }
.ob-choice span { font-size: 15px; line-height: 20px; color: var(--ob-ink-2); }
.ob-choice[aria-checked="true"] { border-color: var(--ob-trim); background: linear-gradient(180deg, rgba(255,255,255,0.20), rgba(255,255,255,0.06)), rgba(122,57,31,0.42);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.32), inset 0 0 0 1px var(--ob-trim), 0 0 18px -4px var(--ob-trim), 0 6px 18px rgba(0,0,0,0.3); }
.ob-row { display: flex; gap: 10px; align-items: center; }
.ob-row .ob-input { flex: 1; }
.ob-row--start { justify-content: flex-start; margin-top: 10px; flex-wrap: wrap; }
.ob-check { margin-top: 18px; }
.ob-status { display: flex; gap: 10px; align-items: flex-start; margin: 0; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--ob-trim-quiet); background: rgba(0,0,0,0.22); font-size: 15px; line-height: 21px; }
.ob-status--ok { color: var(--ob-ok); }
.ob-status--bad { color: var(--ob-bad); }
.ob-foot { display: flex; gap: 12px; padding: 18px 28px 24px; }
.ob-actions { display: grid; gap: 12px; width: 100%; }
.ob-btn { min-height: 48px; padding: 0 22px; border-radius: 8px; font: 500 16px/1 var(--ob-sans); cursor: pointer; border: 1px solid var(--ob-trim); display: inline-flex; align-items: center; justify-content: center; }
.ob-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ob-btn--main { flex: 1; color: var(--ob-on-accent); background: linear-gradient(180deg, rgba(255,255,255,0.14), transparent 60%), var(--ob-accent); box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 4px 12px rgba(0,0,0,0.45); }
.ob-actions .ob-btn { min-height: 56px; font-size: 17px; }
.ob-btn--quiet { color: var(--ob-ink); background: url(/house/leather-v1.webp) center / 420px, var(--ob-chrome); background-blend-mode: soft-light; }
.ob-btn--small { min-height: 48px; padding: 0 16px; font-size: 15px; flex: none; }
.ob-link { background: none; border: 0; padding: 0 2px; min-height: 32px; color: var(--ob-accent-ink); font: inherit; font-size: 14px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
@media (max-width: 480px) {
  .ob-head { padding: 20px 20px 4px; } .ob-body { padding: 4px 20px 8px; } .ob-foot { padding: 16px 20px 20px; }
  .ob-title { font-size: 30px; }
}
@media (prefers-reduced-motion: reduce) { .ob-card { animation: none; } .ob-bar i { transition: none; } }
`;
