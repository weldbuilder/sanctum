/**
 * LoginView — the gate before the app.
 *
 * A parchment card on the painted kitchen: logo, wordmark, one password field,
 * Enter submits, inline error, mobile-safe (no iOS zoom).
 */
import React, { useState, useRef, useEffect, FormEvent } from 'react';
import { useAuthStore } from '../store/auth';

// ─── LoginView ────────────────────────────────────────────────────────────────

export function LoginView() {
  const login = useAuthStore(s => s.login);
  const loginError = useAuthStore(s => s.loginError);
  const loggingIn = useAuthStore(s => s.loggingIn);

  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount — after the brief fade-in settles
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 220);
    return () => clearTimeout(t);
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password.trim() || loggingIn) return;
    void login(password);
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <span className="vine vine-tl" aria-hidden="true" />
        <span className="vine vine-tr" aria-hidden="true" />
        <span className="vine vine-bl" aria-hidden="true" />
        <span className="vine vine-br" aria-hidden="true" />
        <img className="login-logo" src="/logo.png" alt="" width={140} height={140} aria-hidden="true" />

        <h1 className="login-title">sanctum</h1>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="login-field-wrap">
            <svg className="login-lock" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10H7Zm2 0h6V8a3 3 0 0 0-6 0v2Zm3 4a1.5 1.5 0 0 0-.75 2.8V18h1.5v-1.2A1.5 1.5 0 0 0 12 14Z" />
            </svg>
            <input
              ref={inputRef}
              className={`login-input${loginError ? ' login-input--error' : ''}`}
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={loggingIn}
              aria-label="Password"
              aria-invalid={!!loginError}
              aria-describedby={loginError ? 'login-error' : undefined}
              // 16px prevents iOS auto-zoom
              style={{ fontSize: '16px' }}
            />
          </div>

          {loginError && (
            <p className="login-error" id="login-error" role="alert">
              {loginError}
            </p>
          )}

          <button
            type="submit"
            className="login-btn"
            disabled={loggingIn || !password}
            aria-busy={loggingIn}
          >
            {loggingIn ? (
              <span className="login-spinner" aria-hidden="true" />
            ) : (
              'Sign in'
            )}
          </button>
        </form>
      </div>

      <style>{`
        /* ─── Shell — the kitchen shows through ─── */
        .login-shell {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100dvh;
          background: transparent;
          padding: calc(env(safe-area-inset-top, 0px) + 1rem) calc(env(safe-area-inset-right, 0px) + 12px)
                   calc(env(safe-area-inset-bottom, 0px) + 1rem) calc(env(safe-area-inset-left, 0px) + 12px);
          box-sizing: border-box;
          position: relative;
          isolation: isolate;
        }
        /* Signing in happens at the house's front door, not in a companion's room: the foyer, softly out of focus, whatever the skin.
           Extra readable draws no scene anywhere, so none here either. */
        .login-shell::before {
          content: '';
          position: fixed;
          inset: -24px;
          z-index: -1;
          background:
            radial-gradient(ellipse 80% 75% at 50% 45%, transparent 50%, rgba(0, 0, 0, 0.6) 100%),
            #120A07 url(/house/foyer-v1.webp) center / cover no-repeat;
          filter: blur(4px) brightness(0.82);
        }
        :root[data-readability="extra"] .login-shell::before { display: none; }

        /* ─── Card ─── */
        .login-card {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          width: min(100%, 29rem);
          padding: 3rem 3.5rem 3.25rem;
          overflow: hidden;
          isolation: isolate;
          border-radius: 10px;
          background: var(--login-card-bg);
          color: var(--surface-panel-text);
          box-shadow: var(--panel-shadow, 0 10px 30px rgba(20, 10, 5, 0.35));
          animation: login-arrive 420ms cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        /* The illustrated frame: hairline rule and four small corner herbs, drawn
           for this card's proportions. Stretches with the card; keep it close to 0.86. */
        .login-card::before {
          content: '';
          position: absolute;
          inset: 0;
          background: var(--login-frame-image) center / 100% 100% no-repeat; /* classic Hedgewitch only; skins set none */
          pointer-events: none;
          z-index: 0;
        }

        /* Botanical corners: sage leaves and a lavender sprig, outside the text. */
        .vine {
          position: absolute;
          width: 112px;
          height: 112px;
          background: url(/hedgewitch/vine-corner.svg) center / contain no-repeat;
          opacity: 0.75;
          pointer-events: none;
          z-index: 0;
        }
        /* The kit's placement: the sprig top-left, turned 180° bottom-right. Two, not four. */
        .vine { display: none; } /* superseded by the illustrated frame */
        .login-card > :not(.vine) { position: relative; z-index: 1; }
        @media (max-width: 600px) {
          .vine { width: 52px; height: 52px; opacity: 0.5; }
          .login-card { padding: 2rem 1.5rem 2.25rem; }
          .login-btn { width: auto; min-width: 11rem; margin: 0 auto; display: block; }
        }

        @keyframes login-arrive {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .login-logo {
          display: block;
          width: 140px;
          height: 140px;
          object-fit: contain;
          margin-bottom: 0.5rem;
          /* The mark sits on the card with no tile: a soft glow that follows its shape, nothing square. */
          border-radius: 0;
          box-shadow: none;
          background: transparent;
          filter: drop-shadow(0 4px 10px rgba(20, 10, 40, 0.35));
        }

        /* ─── Title ─── */
        .login-title {
          margin: 0 0 1.5rem;
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-size: 3rem;
          font-weight: 500;
          line-height: 1.1;
          letter-spacing: -0.01em;
          color: var(--surface-panel-text, #2c231f);
          text-transform: lowercase;
        }

        /* ─── Form ─── */
        .login-form {
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 0.875rem;
        }

        .login-field-wrap {
          position: relative;
          width: 100%;
        }
        .login-lock {
          position: absolute;
          left: 0.85rem;
          top: 50%;
          transform: translateY(-50%);
          color: var(--surface-input-placeholder, #7d6e66);
          pointer-events: none;
        }

        .login-input {
          width: 100%;
          box-sizing: border-box;
          background: var(--surface-input, #faf5e8);
          border: 1px solid var(--control-border, #b89c70);
          border-radius: 6px;
          color: var(--surface-input-text, #2c231f);
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-size: 16px; /* prevents iOS zoom */
          padding: 0.8rem 1rem 0.8rem 2.6rem;
          outline: none;
          transition:
            border-color 160ms cubic-bezier(0.16, 1, 0.3, 1),
            box-shadow 160ms cubic-bezier(0.16, 1, 0.3, 1);
          -webkit-appearance: none;
        }

        .login-input::placeholder {
          color: var(--surface-input-placeholder, #7d6e66);
        }

        .login-input:focus {
          border-color: var(--focus-ring, #6d5b93);
          box-shadow: 0 0 0 3px rgba(109, 91, 147, 0.18);
        }
        /* The ring is the focus cue; the border and glow are only a bonus. */
        .login-input:focus-visible {
          outline: 2px solid var(--focus-ring, #6d5b93);
          outline-offset: 2px;
        }

        .login-input:disabled {
          background: var(--control-disabled-bg);
          color: var(--control-disabled-text);
          cursor: not-allowed;
        }

        .login-input--error {
          border-color: #b5503f;
        }

        /* ─── Error ─── */
        .login-error {
          margin: 0;
          font-size: 0.85rem;
          color: var(--status-error-text, #a4402f);
          text-align: center;
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          animation: login-arrive 200ms ease both;
        }

        /* ─── Button ─── */
        .login-btn {
          width: 100%;
          padding: 0.75rem 1rem;
          border: none;
          border-radius: 6px;
          background: var(--control-primary-bg, #6d5b93);
          color: var(--control-primary-text, #fff);
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-size: 1.1rem;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 3rem;
          box-shadow: 0 2px 6px rgba(40, 25, 60, 0.3);
          transition:
            background 160ms cubic-bezier(0.16, 1, 0.3, 1),
            transform 100ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        .login-btn:hover:not(:disabled) {
          background: var(--control-primary-hover, #5d4c82);
        }

        .login-btn:active:not(:disabled) {
          transform: scale(0.985) translateY(0.5px);
        }

        .login-btn:disabled {
          background: var(--control-disabled-bg);
          color: var(--control-disabled-text);
          box-shadow: none;
          cursor: not-allowed;
        }

        /* ─── Spinner ─── */
        .login-spinner {
          display: inline-block;
          width: 1.1rem;
          height: 1.1rem;
          border: 2px solid currentColor;
          border-top-color: transparent;
          border-radius: 50%;
          animation: login-spin 600ms linear infinite;
        }

        @keyframes login-spin {
          to { transform: rotate(360deg); }
        }

        @media (max-width: 600px) {
          .login-card {
            padding: 2rem 1.5rem 2.25rem;
          }
          .login-title { font-size: 2.6rem; }
        }
      `}</style>
    </div>
  );
}
