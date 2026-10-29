/**
 * ConfirmProvider + useConfirm()
 *
 * Usage:
 *   const confirm = useConfirm();
 *   const ok = await confirm({ title: 'Delete thread?', body: '...', destructive: true });
 *
 * Mount <ConfirmProvider> near the app root (done in App.tsx).
 * The modal is Hearth-styled: warm-obsidian panel, backdrop blur, subtle
 * entrance. Escape + backdrop-click resolve false. Focus lands on Cancel
 * by default (safe default for destructive). destructive:true → danger tone.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';

// ─── Public API ────────────────────────────────────────────────────────────────

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** true → confirm button rendered in the danger tone */
  destructive?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}

// ─── Internal state ────────────────────────────────────────────────────────────

interface DialogState {
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>(resolve => {
      setDialog({ opts, resolve });
      // Focus Cancel after paint
      setTimeout(() => cancelRef.current?.focus(), 0);
    });
  }, []);

  function resolve(value: boolean) {
    if (!dialog) return;
    dialog.resolve(value);
    setDialog(null);
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    // Only fire when clicking the backdrop itself, not its children
    if (e.target === e.currentTarget) resolve(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      resolve(false);
    }
  }

  const isDestructive = dialog?.opts.destructive ?? false;
  const confirmLabel = dialog?.opts.confirmLabel ?? (isDestructive ? 'Delete' : 'Confirm');
  const cancelLabel = dialog?.opts.cancelLabel ?? 'Cancel';

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {dialog && (
        <div
          className="cdlg-backdrop"
          onMouseDown={handleBackdrop}
          onKeyDown={handleKeyDown}
          role="dialog"
          aria-modal="true"
          aria-labelledby="cdlg-title"
          aria-describedby={dialog.opts.body ? 'cdlg-body' : undefined}
        >
          <div className="cdlg-panel">
            <p id="cdlg-title" className="cdlg-title">{dialog.opts.title}</p>
            {dialog.opts.body && (
              <p id="cdlg-body" className="cdlg-body">{dialog.opts.body}</p>
            )}
            <div className="cdlg-actions">
              {/* Cancel focused first — safe default */}
              <button
                ref={cancelRef}
                className="cdlg-btn cdlg-cancel"
                onClick={() => resolve(false)}
                type="button"
              >
                {cancelLabel}
              </button>
              <button
                className={`cdlg-btn cdlg-confirm${isDestructive ? ' cdlg-danger' : ' cdlg-amber'}`}
                onClick={() => resolve(true)}
                type="button"
              >
                {confirmLabel}
              </button>
            </div>
          </div>

          <style>{`
            .cdlg-backdrop {
              position: fixed;
              inset: 0;
              z-index: 9999;
              display: grid;
              place-items: center;
              /* Warm dark veil — not a harsh black */
              background: rgba(6, 5, 4, 0.68);
              backdrop-filter: blur(6px);
              -webkit-backdrop-filter: blur(6px);
              animation: cdlgFadeIn 160ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)) both;
            }

            @keyframes cdlgFadeIn {
              from { opacity: 0; }
              to   { opacity: 1; }
            }

            .cdlg-panel {
              /* Warm obsidian panel — one shade lighter than bg-primary */
              background: var(--bg-secondary, #131210);
              border: 1px solid rgba(201, 168, 124, 0.14);
              border-radius: 0.875rem;
              padding: 1.5rem 1.75rem 1.375rem;
              width: min(92vw, 22rem);
              box-shadow:
                0 0 0 1px rgba(0, 0, 0, 0.4),
                0 8px 32px rgba(0, 0, 0, 0.55),
                0 2px 8px rgba(0, 0, 0, 0.35);
              /* Entrance: fade + tiny rise */
              animation: cdlgSlideIn 200ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)) both;
            }

            @keyframes cdlgSlideIn {
              from {
                opacity: 0;
                transform: translateY(6px) scale(0.97);
              }
              to {
                opacity: 1;
                transform: translateY(0) scale(1);
              }
            }

            .cdlg-title {
              font-family: var(--font-body, 'Inter', sans-serif);
              font-size: 0.9375rem;
              font-weight: 500;
              color: var(--text-primary, #e2dbd0);
              margin: 0 0 0.5rem;
              line-height: 1.4;
            }

            .cdlg-body {
              font-family: var(--font-body, 'Inter', sans-serif);
              font-size: 0.8125rem;
              color: var(--text-secondary, #a09689);
              margin: 0 0 1.25rem;
              line-height: 1.55;
            }

            .cdlg-actions {
              display: flex;
              justify-content: flex-end;
              gap: 0.5rem;
              margin-top: 1.25rem;
            }

            .cdlg-btn {
              font-family: var(--font-body, 'Inter', sans-serif);
              font-size: 0.8125rem;
              font-weight: 500;
              padding: 0.4375rem 0.875rem;
              border-radius: 0.5rem;
              border: 1px solid transparent;
              cursor: pointer;
              transition:
                background 140ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
                border-color 140ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
                color 140ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94)),
                transform 100ms var(--hearth-curve, cubic-bezier(0.25, 0.46, 0.45, 0.94));
            }
            .cdlg-btn:active {
              transform: scale(0.985) translateY(0.5px);
            }

            /* Cancel — ghost, muted */
            .cdlg-cancel {
              background: transparent;
              color: var(--text-secondary, #a09689);
              border-color: var(--control-border, rgba(255, 255, 255, 0.08));
            }
            .cdlg-cancel:hover {
              background: var(--bg-hover, rgba(255, 255, 255, 0.05));
              color: var(--text-primary, #e2dbd0);
              border-color: var(--control-border, rgba(255, 255, 255, 0.12));
            }
            .cdlg-cancel:focus-visible {
              outline: 2px solid var(--focus-ring, rgba(201, 168, 124, 0.45));
              outline-offset: 2px;
            }

            /* Confirm amber — non-destructive */
            .cdlg-amber {
              background: rgba(201, 168, 124, 0.12);
              color: var(--amber, #c9a87c);
              border-color: var(--control-border, rgba(201, 168, 124, 0.28));
            }
            .cdlg-amber:hover {
              background: rgba(201, 168, 124, 0.2);
              border-color: var(--amber, rgba(201, 168, 124, 0.45));
            }
            .cdlg-amber:focus-visible {
              outline: 2px solid var(--focus-ring, rgba(201, 168, 124, 0.55));
              outline-offset: 2px;
            }

            /* Confirm danger — destructive */
            .cdlg-danger {
              background: rgba(220, 140, 120, 0.1);
              color: var(--status-error-text);
              border-color: var(--status-error-text);
            }
            .cdlg-danger:hover {
              background: rgba(220, 140, 120, 0.18);
            }
            .cdlg-danger:focus-visible {
              outline: 2px solid var(--focus-ring, rgba(220, 140, 120, 0.55));
              outline-offset: 2px;
            }
          `}</style>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
