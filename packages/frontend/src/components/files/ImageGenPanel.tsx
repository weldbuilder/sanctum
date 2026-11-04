/**
 * ImageGenPanel: the "Generate" panel inside the Files page. It stands on the Files plate (`fl-plate`, the skin's own
 * surface) and uses Files' own controls (`fl-btn`, `fl-input`); nothing here sets a colour.
 *
 * ImageGenForm is the pure view (props in, markup out) so it can be rendered on the server in a test;
 * ImageGenPanel holds the state: GET /api/images/status on open, POST /api/images/generate on Generate.
 */
import { useEffect, useRef, useState } from 'react';
import { BASE } from '../../lib/base';
import {
  PROMPT_MAX, generateError, statusReason, type ImageStatus,
} from './imageGen';

export interface ImageGenFormProps {
  /** null while the status is still being asked. */
  status: ImageStatus | null;
  prompt: string;
  generating: boolean;
  error: string;
  onPrompt: (v: string) => void;
  onGenerate: () => void;
  onCancel: () => void;
}

export function ImageGenForm(p: ImageGenFormProps) {
  const reason = statusReason(p.status);
  const offered = p.status?.offered === true;
  const provider = p.status?.provider || 'the provider';
  const canGo = offered && !p.generating && p.prompt.trim().length > 0;
  return (
    <section className="fl-gen fl-panel fl-plate" aria-label="Generate an image">
      <form className="fl-gen-form" onSubmit={e => { e.preventDefault(); if (canGo) p.onGenerate(); }}>
        <div className="fl-gen-field">
          <label className="fl-gen-label" htmlFor="fl-gen-prompt">Prompt</label>
          <textarea
            id="fl-gen-prompt"
            className="fl-input fl-gen-prompt"
            rows={4}
            maxLength={PROMPT_MAX}
            value={p.prompt}
            disabled={!offered || p.generating}
            placeholder="Describe the picture"
            onChange={e => p.onPrompt(e.target.value)}
          />
        </div>
        {reason && <p className="fl-gen-line" role="status">{reason}</p>}
        {p.generating && <p className="fl-gen-line" role="status">Generating with {provider}…</p>}
        {p.error && !p.generating && <p className="fl-gen-line fl-gen-error" role="alert">{p.error}</p>}
        <div className="fl-gen-actions">
          <button type="submit" className="fl-btn fl-btn-primary hearth-press" disabled={!canGo}>Generate</button>
          <button type="button" className="fl-btn hearth-press" onClick={p.onCancel}>{p.generating ? 'Cancel' : 'Close'}</button>
        </div>
      </form>
      <style>{`
        .fl-gen { margin-top: 0; }
        .fl-gen-form { display: flex; flex-direction: column; gap: 0.8rem; }
        .fl-gen-field { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
        .fl-gen-label {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.7rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .fl-gen-prompt { width: 100%; box-sizing: border-box; resize: vertical; min-height: 6rem; line-height: 1.45; }
        .fl-gen-prompt::placeholder { color: var(--settings-field-placeholder, var(--surface-chrome-muted)); }
        .fl-gen-prompt:disabled { opacity: 0.6; }
        .fl-gen-line { margin: 0; font-family: var(--font-serif, 'Lora', serif); font-style: italic; font-size: 0.92rem; color: var(--text-secondary); }
        .fl-gen-error { font-style: normal; color: var(--status-error-text); }
        .fl-gen-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
        .fl-gen-actions .fl-btn { min-height: 2.5rem; justify-content: center; }
        .fl-gen-actions .fl-btn:disabled { opacity: 0.55; cursor: default; }
        @media (max-width: 768px) { .fl-gen-actions .fl-btn { flex: 1; } }
      `}</style>
    </section>
  );
}

export function ImageGenPanel({ onClose, onGenerated }: {
  onClose: () => void;
  /** The server made a picture; the page refetches and shows it. `provider` is for the confirmation line. */
  onGenerated: (provider: string) => void;
}) {
  const [status, setStatus] = useState<ImageStatus | null>(null);
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`${BASE}/api/images/status`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: ImageStatus) => { if (live) setStatus(d); })
      .catch(() => { if (live) setStatus({ configured: false, offered: false, reason: 'not_configured' }); });
    return () => { live = false; abort.current?.abort(); };
  }, []);

  const generate = async () => {
    const ctl = new AbortController();
    abort.current = ctl;
    setGenerating(true);
    setError('');
    try {
      const r = await fetch(`${BASE}/api/images/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), post_to_chat: false }),
        signal: ctl.signal,
      });
      const body = await r.json().catch(() => null) as { error?: string; provider?: string; detail?: string } | null;
      if (!r.ok) { setError(generateError(r.status, body)); return; }
      onGenerated((body as { provider?: string } | null)?.provider || status?.provider || '');
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') setError(generateError(0, { provider: status?.provider, detail: 'network' }));
    } finally {
      if (abort.current === ctl) abort.current = null;
      setGenerating(false);
    }
  };

  return (
    <ImageGenForm
      status={status}
      prompt={prompt}
      generating={generating}
      error={error}
      onPrompt={setPrompt}
      onGenerate={() => void generate()}
      onCancel={() => { abort.current?.abort(); onClose(); }}
    />
  );
}
