/** A folded-away block with a title and a one-line hint, for the parts of a tab most people never open (Rhythm's advanced, Status's panels). */
import React, { useId, useState } from 'react';

export function Disclosure({ title, sub, defaultOpen = false, open: controlled, children }: {
  title: string;
  sub?: string;
  defaultOpen?: boolean;
  /** When given, the block is open while this is true (and the person can still close it). */
  open?: boolean;
  children: React.ReactNode;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const [seen, setSeen] = useState(controlled);
  // A parent opening it (a "see the log" link) wins once, then the person's own click rules.
  if (controlled !== seen) { setSeen(controlled); if (controlled) setOwn(true); }
  const id = useId();
  return (
    <div className="disc">
      <style>{DISC_CSS}</style>
      <button type="button" className="disc-toggle" aria-expanded={own} aria-controls={id} onClick={() => setOwn(o => !o)}>
        <span className="disc-chev" aria-hidden="true">{own ? '▾' : '▸'}</span>
        <span className="disc-title">{title}</span>
        {sub && <span className="disc-sub">{sub}</span>}
      </button>
      {own && <div id={id} className="disc-body">{children}</div>}
    </div>
  );
}

const DISC_CSS = `
.disc { margin-top: 1.25rem; border: 1px solid var(--settings-hairline, var(--border)); border-radius: 0.625rem; }
.disc-toggle {
  display: flex; align-items: center; gap: 0.625rem; width: 100%; min-height: 44px; padding: 0.5rem 0.875rem;
  background: transparent; border: 0; cursor: pointer; text-align: left; color: var(--text-primary); border-radius: 0.625rem;
}
.disc-toggle:hover { background: var(--bg-hover); }
.disc-toggle:focus-visible { outline: 2px solid var(--field-border-focus, var(--amber)); outline-offset: 1px; }
.disc-chev { color: var(--text-muted); font-size: 0.75rem; flex-shrink: 0; }
.disc-title { font-family: var(--font-serif, serif); font-style: italic; font-size: 0.9375rem; }
.disc-sub { margin-left: auto; font-size: 0.75rem; color: var(--text-muted); text-align: right; }
.disc-body { padding: 0 0.875rem 1rem; border-top: 1px solid var(--settings-hairline, var(--border)); }
@media (max-width: 600px) { .disc-body { padding: 0 0.5rem 1rem; } .disc-sub { display: none; } }
@media (min-width: 769px) { .settings-view .disc-title { font-size: 16px; } .settings-view .disc-sub { font-size: 13px; } }
`;
