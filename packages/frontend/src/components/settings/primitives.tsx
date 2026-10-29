/**
 * Shared primitives for the Settings panel.
 * All styles use CSS custom properties from src/index.css — no Tailwind needed here.
 */
import React from 'react';

// ─── Card — genuine contained surface (textarea, swatches, stat grids) ────────

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`sp-card${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}

// ─── Group — editorial row container (no box, just dividers) ──────────────────
// Replaces Card for toggle rows, field rows, and form-field stacks.

export function Group({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`sp-group${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}

// ─── Section eyebrow ──────────────────────────────────────────────────────────

export function Eyebrow({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="sp-eyebrow">
      <span className="sp-eyebrow-label">{label}</span>
      {sub && <span className="sp-eyebrow-sub">{sub}</span>}
    </div>
  );
}

// ─── Field row (read-only display) ────────────────────────────────────────────

export function FieldRow({
  label,
  value,
  sub,
  mono = false,
  hint,
}: {
  label: string;
  value: string | boolean | null | undefined;
  sub?: string;
  mono?: boolean;
  hint?: string;
}) {
  const display =
    value === null || value === undefined || value === ''
      ? '—'
      : typeof value === 'boolean'
      ? value ? 'enabled' : 'disabled'
      : value;

  return (
    <div className="sp-field-row">
      <div className="sp-field-label">{label}</div>
      <div className={`sp-field-value${mono ? ' mono' : ''}${display === '—' ? ' muted' : ''}`}>
        {display}
        {sub && <span className="sp-field-sub">{sub}</span>}
      </div>
      {hint && <div className="sp-field-hint">{hint}</div>}
    </div>
  );
}

// ─── Editable text field ───────────────────────────────────────────────────────

export function TextField({
  label,
  value,
  onChange,
  hint,
  mono = false,
  placeholder,
  restartRequired = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  mono?: boolean;
  placeholder?: string;
  restartRequired?: boolean;
}) {
  return (
    <div className="sp-form-group">
      <label className="sp-form-label">
        {label}
        {restartRequired && <span className="sp-restart-badge" title="Applies on restart">restart</span>}
      </label>
      <input
        type="text"
        className={`sp-form-input${mono ? ' mono' : ''}`}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {hint && <span className="sp-form-hint">{hint}</span>}
    </div>
  );
}

// ─── Toggle row ───────────────────────────────────────────────────────────────

export function ToggleRow({
  label,
  checked,
  onChange,
  disabled = false,
  hint,
  restartRequired = false,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
  restartRequired?: boolean;
}) {
  return (
    <div className="sp-toggle-row">
      <div className="sp-toggle-left">
        <span className="sp-toggle-label">
          {label}
          {restartRequired && <span className="sp-restart-badge" title="Applies on restart">restart</span>}
        </span>
        {hint && <span className="sp-toggle-hint">{hint}</span>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={`sp-toggle${checked ? ' on' : ''}`}
        onClick={() => onChange(!checked)}
        aria-label={label}
      >
        <span className="sp-toggle-thumb" />
      </button>
    </div>
  );
}

// ─── Action button ─────────────────────────────────────────────────────────────

export function Btn({
  children,
  onClick,
  variant = 'muted',
  disabled = false,
  small = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'danger' | 'muted' | 'ghost';
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <button
      className={`sp-btn sp-btn-${variant}${small ? ' small' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

// ─── Status pip + badge ───────────────────────────────────────────────────────

export function StatusBadge({ state }: { state: string }) {
  const isOk = state === 'connected';
  const isWarn = state === 'reconnecting';
  const color = isOk ? '#6dba88' : isWarn ? '#d4a843' : '#71717a';
  const label = isOk ? 'connected' : isWarn ? 'connecting' : 'offline';

  return (
    <span className="sp-status-badge" style={{ color }}>
      <span className="sp-pip" style={{ background: color, boxShadow: isOk ? `0 0 6px ${color}44` : 'none' }} aria-hidden="true" />
      {label}
    </span>
  );
}

// ─── Inline pill ──────────────────────────────────────────────────────────────

export function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span className="sp-pill" style={{ color, borderColor: `${color}44`, background: `${color}10` }}>
      {label}
    </span>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="sp-empty">
      <span className="sp-empty-text">{message}</span>
    </div>
  );
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

export function Spinner() {
  return <span className="sp-spinner" aria-label="loading" />;
}

// ─── Save indicator ───────────────────────────────────────────────────────────

export function SaveIndicator({ status }: { status: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (status === 'idle') return null;
  return (
    <span className={`sp-save-indicator ${status}`}>
      {status === 'saving' && 'saving…'}
      {status === 'saved' && 'saved'}
      {status === 'error' && 'error saving'}
    </span>
  );
}

// ─── Sub-section divider ──────────────────────────────────────────────────────

export function SubDivider({ label }: { label?: string }) {
  return (
    <div className="sp-sub-divider">
      {label && <span className="sp-sub-divider-label">{label}</span>}
    </div>
  );
}

// ─── Form group wrapper ───────────────────────────────────────────────────────

export function FormGroup({ children }: { children: React.ReactNode }) {
  return <div className="sp-form-group">{children}</div>;
}

// ─── Stat card grid item ──────────────────────────────────────────────────────

export function StatCard({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="sp-stat-card">
      <span className="sp-stat-label">{label}</span>
      <span className={`sp-stat-value${warn ? ' warn' : ''}`}>{value}</span>
    </div>
  );
}

// ─── Shared CSS (mounted once via index.css integration — injected via style tag) ─

export const PRIMITIVES_CSS = `
/* ─── Settings panel primitives ─── */

/*
 * .sp-card  — genuine contained surface (system-prompt textarea, palette swatches,
 *              stat grids, the stat-card mini-blocks). 10px radius, no blur.
 * .sp-group — editorial row-group: transparent, just spacing + inset dividers.
 *             Replaces Card for toggle rows, field rows, and form fields.
 */
.sp-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--settings-hairline, rgba(255,255,255,0.055));
  border-radius: var(--radius-settings, 0.625rem);
  padding: 0.125rem 1rem;
  position: relative;
  isolation: isolate;
}
/* Kept for semantic compat — no blur, just warm top gradient */
.sp-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  z-index: -1;
  background: radial-gradient(ellipse at center top, rgba(201,168,124,0.018), transparent 55%);
  pointer-events: none;
}

/* Editorial group — no box, just spacing context for divider rows */
.sp-group {
  display: flex;
  flex-direction: column;
}

.sp-eyebrow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 2rem 0 0.625rem;
}
/* First eyebrow in a section — reduce top gap */
.sp-eyebrow:first-child {
  margin-top: 0.5rem;
}
.sp-eyebrow-label {
  font-family: var(--font-serif, 'Lora', serif);
  font-style: italic;
  font-size: 0.875rem;
  color: var(--text-secondary, #a09689);
  letter-spacing: 0.005em;
}
.sp-eyebrow-sub {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 0.6875rem;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted, #6a6258);
}

.sp-field-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 0;
  border-bottom: 1px solid var(--settings-hairline, rgba(255,255,255,0.055));
  flex-wrap: wrap;
}
.sp-field-row:last-child { border-bottom: none; }
.sp-field-label {
  font-size: 0.875rem;
  color: var(--text-secondary, #a09689);
  flex-shrink: 0;
}
.sp-field-value {
  font-size: 0.875rem;
  color: var(--text-primary, #e2dbd0);
  text-align: right;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sp-field-value.mono {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 0.8125rem;
  color: var(--amber-bright, #e3c49a);
  letter-spacing: 0.01em;
}
.sp-field-value.muted { color: var(--text-muted, #6a6258); }
.sp-field-sub {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 0.6875rem;
  color: var(--text-muted, #6a6258);
  letter-spacing: 0.04em;
  margin-left: 0.5rem;
}
.sp-field-hint {
  width: 100%;
  font-size: 0.6875rem;
  color: var(--text-muted, #6a6258);
  font-style: italic;
  margin-top: 0.125rem;
}

/* Form inputs */
.sp-form-group {
  display: flex;
  flex-direction: column;
  gap: 0.3125rem;
}
.sp-form-label {
  font-size: 0.8125rem;
  color: var(--text-secondary, #a09689);
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.sp-form-input {
  background: var(--bg-input, #0f0e0c);
  border: 1px solid var(--field-border, rgba(255,255,255,0.08));
  border-radius: 0.5rem;
  color: var(--text-primary, #e2dbd0);
  font-size: 0.875rem;
  padding: 0.4375rem 0.75rem;
  font-family: inherit;
  transition: border-color 240ms var(--hearth-curve, ease);
  width: 100%;
}
.sp-form-input.mono {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 0.8125rem;
  color: var(--amber-bright, #e3c49a);
}
.sp-form-input:focus {
  outline: none;
  border-color: var(--field-border-focus, rgba(201,168,124,0.30));
}
/* Keyboard focus always gets a real ring, whatever the border colour does. */
.sp-form-input:focus-visible, .sp-form-textarea:focus-visible {
  outline: 2px solid var(--focus-ring, #6d5b93);
  outline-offset: 2px;
}
.sp-form-input:disabled {
  background: var(--settings-disabled-bg, rgba(255,255,255,0.05));
  color: var(--settings-disabled-text, #b7a98f) !important;
  cursor: not-allowed;
}
.sp-form-textarea {
  background: var(--bg-input, #0f0e0c);
  border: 1px solid var(--field-border, rgba(255,255,255,0.08));
  border-radius: 0.5rem;
  color: var(--text-primary, #e2dbd0);
  font-size: 0.875rem;
  padding: 0.4375rem 0.75rem;
  font-family: inherit;
  transition: border-color 240ms var(--hearth-curve, ease);
  width: 100%;
  resize: vertical;
  min-height: 3.5rem;
}
.sp-form-textarea:focus {
  outline: none;
  border-color: var(--field-border-focus, rgba(201,168,124,0.30));
}
.sp-form-hint {
  font-size: 0.6875rem;
  color: var(--text-muted, #6a6258);
  font-style: italic;
}
select.sp-form-input { cursor: pointer; }

.sp-restart-badge {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 0.5625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: rgba(212,168,67,0.14);
  color: var(--status-warning-text, #d4a843);
  border: 1px solid rgba(212,168,67,0.25);
  border-radius: 0.25rem;
  padding: 0.0625rem 0.3125rem;
}

/* Toggle */
.sp-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.625rem 0;
  border-bottom: 1px solid var(--settings-hairline, rgba(255,255,255,0.055));
  gap: 0.75rem;
}
.sp-toggle-row:last-child { border-bottom: none; }
.sp-toggle-left {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  flex: 1;
  min-width: 0;
}
.sp-toggle-label {
  font-size: 0.875rem;
  color: var(--text-secondary, #a09689);
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.sp-toggle-hint {
  font-size: 0.6875rem;
  color: var(--text-muted, #6a6258);
  font-style: italic;
}
.sp-toggle {
  position: relative;
  width: 2.25rem;
  height: 1.25rem;
  border-radius: 99px;
  background: var(--toggle-off-bg, rgba(255,255,255,0.08));
  border: 1px solid var(--toggle-off-border, rgba(255,255,255,0.10));
  cursor: pointer;
  transition: background 150ms var(--hearth-curve, ease), border-color 240ms var(--hearth-curve, ease);
  flex-shrink: 0;
}
.sp-toggle.on {
  background: var(--toggle-on-bg, rgba(201,168,124,0.22));
  border-color: var(--toggle-on-border, rgba(201,168,124,0.35));
}
.sp-toggle:disabled { background: var(--settings-disabled-bg, rgba(255,255,255,0.05)); cursor: not-allowed; }
.sp-toggle:active:not(:disabled) {
  transform: scale(0.96);
  transition: transform 100ms var(--hearth-curve, ease);
}
.sp-toggle-thumb {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  left: 0.1875rem;
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 50%;
  background: var(--toggle-off-thumb, var(--text-muted, #6a6258));
  transition: left 160ms var(--hearth-curve, ease), background 150ms var(--hearth-curve, ease);
}
.sp-toggle.on .sp-toggle-thumb {
  left: calc(100% - 0.1875rem - 0.875rem);
  background: var(--toggle-on-thumb, var(--amber, #c9a87c));
  box-shadow: 0 0 8px rgba(201,168,124,0.40);
}

/* Buttons */
.sp-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.4375rem 0.875rem;
  font-size: 0.8125rem;
  font-family: inherit;
  border-radius: 0.5rem;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 150ms var(--hearth-curve, ease),
              color 150ms var(--hearth-curve, ease),
              border-color 240ms var(--hearth-curve, ease),
              transform 100ms var(--hearth-curve, ease);
  white-space: nowrap;
  flex-shrink: 0;
}
.sp-btn.small {
  padding: 0.3rem 0.625rem;
  font-size: 0.75rem;
}
.sp-btn:active:not(:disabled) { transform: scale(0.985) translateY(0.5px); }
.sp-btn:disabled { background: var(--settings-disabled-bg, rgba(255,255,255,0.05)); color: var(--settings-disabled-text, #b7a98f); border-color: transparent; cursor: not-allowed; }

.sp-btn-primary {
  background: rgba(201,168,124,0.16);
  color: var(--amber-bright, #e3c49a);
  border-color: var(--btn-border-primary, rgba(201,168,124,0.28));
}
.sp-btn-primary:hover:not(:disabled) {
  background: rgba(201,168,124,0.24);
  border-color: rgba(201,168,124,0.42);
}
.sp-btn-danger {
  background: transparent;
  color: var(--status-error-text);
  border-color: var(--btn-border-danger, rgba(210,100,90,0.30));
}
.sp-btn-danger:hover:not(:disabled) {
  background: rgba(210,100,90,0.10);
  border-color: rgba(210,100,90,0.50);
}
.sp-btn-muted {
  background: transparent;
  color: var(--text-muted, #6a6258);
  border-color: var(--btn-border-muted, rgba(255,255,255,0.08));
}
.sp-btn-muted:hover:not(:disabled) {
  color: var(--text-secondary, #a09689);
  border-color: var(--btn-border-muted-hover, rgba(255,255,255,0.14));
}
.sp-btn-ghost {
  background: transparent;
  color: var(--text-muted, #6a6258);
  border-color: transparent;
}
.sp-btn-ghost:hover:not(:disabled) {
  color: var(--text-secondary, #a09689);
}

/* Status badge */
.sp-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.sp-pip {
  display: inline-block;
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 50%;
  flex-shrink: 0;
}

/* Pill */
.sp-pill {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 0.625rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border: 1px solid;
  border-radius: 0.25rem;
  padding: 0.0625rem 0.375rem;
}

/* Empty state */
.sp-empty {
  padding: 1.25rem 0;
}
.sp-empty-text {
  font-family: var(--font-serif, 'Lora', serif);
  font-style: italic;
  font-size: 0.875rem;
  color: var(--text-muted, #6a6258);
  line-height: 1.55;
}

/* Spinner */
.sp-spinner {
  display: inline-block;
  width: 0.875rem;
  height: 0.875rem;
  border: 1.5px solid rgba(201,168,124,0.18);
  border-top-color: var(--amber, #c9a87c);
  border-radius: 50%;
  animation: spin 560ms linear infinite;
  flex-shrink: 0;
}

/* Save indicator */
.sp-save-indicator {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 0.6875rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  animation: fadeIn 200ms var(--hearth-curve, ease) both;
}
.sp-save-indicator.saving { color: var(--text-muted, #6a6258); }
.sp-save-indicator.saved  { color: var(--status-success-text, #6dba88); }
.sp-save-indicator.error  { color: var(--status-error-text); }

/* Sub-divider */
.sp-sub-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1rem 0 0.5rem;
}
.sp-sub-divider::before,
.sp-sub-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: rgba(255,255,255,0.05);
}
.sp-sub-divider-label {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 0.625rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--text-muted, #6a6258);
  flex-shrink: 0;
}

/* Stat card */
.sp-stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
  gap: 0.5rem;
}

/* ─── Mobile: settings primitives ─── */
@media (max-width: 600px) {
  .sp-btn {
    /* Ensure tap targets are at least 44px tall */
    min-height: 44px;
    justify-content: center;
  }
  .sp-btn.small {
    min-height: 36px;
  }
  .sp-toggle {
    /* Larger touch target */
    width: 2.5rem;
    height: 1.375rem;
    min-width: 2.5rem;
    flex-shrink: 0;
  }
  .sp-form-input,
  .sp-form-textarea,
  select.sp-form-input {
    /* Prevent iOS zoom on input focus — must be ≥16px */
    font-size: 1rem !important;
    min-height: 44px;
  }
  .sp-form-textarea {
    min-height: 4rem;
  }
  .sp-toggle-row {
    gap: 1rem;
    padding: 0.75rem 0;
  }
  .sp-field-value {
    white-space: normal;
    word-break: break-all;
  }
}
.sp-stat-card {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.625rem 0.75rem;
  background: rgba(255,255,255,0.025);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 0.625rem;
  text-align: center;
}
.sp-stat-label {
  font-size: 0.625rem;
  color: var(--text-muted, #6a6258);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}
.sp-stat-value {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 1rem;
  color: var(--text-primary, #e2dbd0);
}
.sp-stat-value.warn { color: var(--status-warning-text, #d4a843); }
`;
