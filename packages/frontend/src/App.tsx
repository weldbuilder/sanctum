import React, { Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import { ChatView } from './components/ChatView';
import { HomeView } from './components/HomeView';
import { CommandPalette } from './components/CommandPalette';
import { CommandCenterView } from './components/CommandCenterView';
import { LoginView } from './components/LoginView';
import { Onboarding } from './components/Onboarding';
import { SetupWizard } from './components/SetupWizard';
import { useChatStore } from './store/chat';
import { useIdentity, loadIdentity } from './store/identity';
import { useAppearanceStore } from './store/appearance';
import { DrawerHeader } from './components/DrawerHeader';
import { useAuthStore } from './store/auth';
import { useMindStore } from './store/mind';
import { useThemeStore } from './store/theme';
import { ConfirmProvider } from './components/ConfirmDialog';
import { COMPANION_PREFIX } from './lib/base';
import { Hallway } from './components/Hallway';

// ─── Cold routes — lazy-loaded on first visit ──────────────────────────────────
// /home and /chat are the hot path and stay eager; these three only fetch their
// chunk when the route is entered. All are named exports, hence the .then shims.

const SettingsView = React.lazy(() =>
  import('./components/SettingsView').then(m => ({ default: m.SettingsView }))
);
const CanvasView = React.lazy(() =>
  import('./components/Canvas').then(m => ({ default: m.CanvasView }))
);
const FilesView = React.lazy(() =>
  import('./components/FilesView').then(m => ({ default: m.FilesView }))
);
const BrowserView = React.lazy(() =>
  import('./components/BrowserView').then(m => ({ default: m.BrowserView }))
);
const MindView = React.lazy(() =>
  import('./components/MindView').then(m => ({ default: m.MindView }))
);
const ObservatoryView = React.lazy(() =>
  import('./components/observatory/ObservatoryView').then(m => ({ default: m.ObservatoryView }))
);

// Suspense fallback while a lazy route chunk loads — same quiet amber pulse as
// the auth gate, held inside the app-content pane so the rail/topbar stay put.
function RouteFallback() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      background: 'transparent',
    }}>
      <div style={{
        width: '0.375rem',
        height: '0.375rem',
        borderRadius: '50%',
        background: 'var(--surface-chrome-text, #efe4d0)',
        animation: 'route-pulse 1.4s ease-in-out infinite',
      }} />
      <style>{`
        @keyframes route-pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50%       { opacity: 1;   transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

// ─── Nav icons ────────────────────────────────────────────────────────────────
// Plain stroked glyphs, reused in both the desktop rail and the mobile drawer.

function HomeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.625" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 11 12 3.5 20.5 11" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M10 20v-5.5h4V20" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.625" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}
function CommandIcon() {
  // Sliders — the operating surface. Matches the stroked-glyph set.
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.625" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}
function CanvasIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.625" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}
function MindIcon() {
  // Brain — two hemispheres, midline, one gyrus. Stroked-glyph set.
  // (Was a crescent; it read as a moon.)
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.625" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
    </svg>
  );
}
function FilesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.625" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}
function BrowserIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.625" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
    </svg>
  );
}
function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.625" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

const NAV_ITEMS = [
  { to: '/home', label: 'Home', Icon: HomeIcon, orb: true },
  { to: '/chat', label: 'Chat', Icon: ChatIcon, orb: false },
  { to: '/canvas', label: 'Notes', Icon: CanvasIcon, orb: false },
  { to: '/files', label: 'Files', Icon: FilesIcon, orb: false },
  { to: '/browser', label: 'Browser', Icon: BrowserIcon, orb: false },
  { to: '/command', label: 'Command', Icon: CommandIcon, orb: false },
  // /mind sits beside /command but only exists when the mind surface is
  // enabled — filtered in NavLinks (MIND-SURFACE-SPEC: clean absence, the
  // house simply doesn't have that window when the toggle is off).
  { to: '/mind', label: 'Mind', Icon: MindIcon, orb: false },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon, orb: false },
];

const PRESENCE_COLOR: Record<string, string> = {
  active: '#c9a87c',
  waking: '#d4a843',
  dormant: '#5a5650',
  offline: '#3a3830',
};

// ─── Nav links — shared between desktop rail and mobile drawer ─────────────────

function NavLinks({ variant, onNavigate }: { variant: 'rail' | 'drawer'; onNavigate?: () => void }) {
  const presence = useChatStore(s => s.presence);
  const dotColor = PRESENCE_COLOR[presence] ?? '#3a3830';
  // /mind is present only when the mind surface is enabled (strictly true —
  // an unknown gate stays closed; no entry flickers in before the answer).
  const mindEnabled = useMindStore(s => s.enabled);
  const items = NAV_ITEMS.filter(item => item.to !== '/mind' || mindEnabled === true);

  return (
    <>
      {items.map(({ to, label, Icon, orb }) => (
        <React.Fragment key={to}>
          {/* The rail sets Settings apart from the rooms with a rule in the skin's metal. */}
          {variant === 'rail' && to === '/settings' && <span className="nav-divider" aria-hidden="true" />}
          <NavLink
            to={to}
            className={({ isActive }) => `navlink navlink-${variant}${isActive ? ' active' : ''}`}
            aria-label={label}
            title={label}
            onClick={onNavigate}
          >
            <span className="navlink-icon">
              {orb && (
                <span className="nav-orb-dot" style={{ background: dotColor }} aria-hidden="true" />
              )}
              <Icon />
            </span>
            <span className="navlink-label">{label}</span>
          </NavLink>
        </React.Fragment>
      ))}
    </>
  );
}

// ─── Desktop left rail ─────────────────────────────────────────────────────────

function NavRail() {
  return (
    <nav className="nav-rail" aria-label="Primary navigation">
      <div className="nav-brand">
        <img className="nav-logo" src="/logo.png" alt="Sanctum" aria-label="Sanctum" width={64} height={64} />
        {/* The logo already names the house for a screen reader; the word is for the eye. */}
        <span className="nav-wordmark" aria-hidden="true">Sanctum</span>
      </div>
      <NavLinks variant="rail" />
    </nav>
  );
}

// ─── Mobile presence dot ───────────────────────────────────────────────────────

function PresenceDot() {
  const presence = useChatStore(s => s.presence);
  const color = PRESENCE_COLOR[presence] ?? '#3a3830';
  return <span className="topbar-presence" style={{ background: color }} aria-label={`Companion: ${presence}`} />;
}

// ─── Mobile top bar — the ONE hamburger ────────────────────────────────────────

function MobileTopBar({ onMenu }: { onMenu: () => void }) {
  return (
    <header className="mobile-topbar">
      <button className="topbar-menu" onClick={onMenu} aria-label="Open menu" type="button">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
          <path d="M3 12h18M3 6h18M3 18h18" />
        </svg>
      </button>
      {/* Just the mark on phones; the word lives in the drawer and on login. */}
      <img className="topbar-mark" src="/logo.png" alt="Sanctum" width={28} height={28} />
      <PresenceDot />
    </header>
  );
}

// ─── Mobile drawer — nav + (on chat) the chats list ────────────────────────────

function MobileDrawer({ open, onClose, isChat }: { open: boolean; onClose: () => void; isChat: boolean }) {
  return (
    <div className={`mobile-drawer-root${open ? ' open' : ''}`} aria-hidden={!open}>
      <button className="drawer-scrim" onClick={onClose} aria-label="Close menu" tabIndex={open ? 0 : -1} />
      <aside className="drawer-panel" role="dialog" aria-modal="true" aria-label="Navigation and chats">
        <DrawerHeader />
        <nav className="drawer-nav" aria-label="Primary navigation">
          <NavLinks variant="drawer" onNavigate={onClose} />
        </nav>

        {/* The chat list lives behind the chat's own hamburger on phones now. */}
      </aside>
    </div>
  );
}

// ─── Update pill — shown when the backend has a newer build than the baked JS ──
// Appears bottom-centre on any surface. Tap reloads. Never auto-reloads while the
// user might be mid-conversation; auto-reload only fires if the page is hidden/idle.

const UPDATE_CHECK_THROTTLE_MS = 30_000; // not more than once per 30 s

function useVersionCheck(onUpdateAvailable: (buildId?: string) => void) {
  const lastCheckRef = React.useRef<number>(0);

  const check = React.useCallback(async () => {
    const now = Date.now();
    if (now - lastCheckRef.current < UPDATE_CHECK_THROTTLE_MS) return;
    lastCheckRef.current = now;
    try {
      const res = await fetch(`${COMPANION_PREFIX}/api/version`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json() as { buildId?: string };
      if (data.buildId && data.buildId !== 'dev' && data.buildId !== __BUILD_ID__) {
        onUpdateAvailable(data.buildId);
      }
    } catch {
      // network error — silent, we'll retry next visibility
    }
  }, [onUpdateAvailable]);

  useEffect(() => {
    // Check once on mount
    void check();

    // Re-check whenever the tab becomes visible
    function onVisibility() {
      if (document.visibilityState === 'visible') void check();
    }
    document.addEventListener('visibilitychange', onVisibility);

    // Also surface the pill when the SW signals a new worker took control
    function onSwUpdated() { onUpdateAvailable(); }
    window.addEventListener('sanctum:sw-updated', onSwUpdated);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('sanctum:sw-updated', onSwUpdated);
    };
  }, [check, onUpdateAvailable]);
}

// ─── Newer Sanctum on GitHub ───────────────────────────────────────────────────
// The server asks GitHub (at most every six hours) whether package.json on main
// carries a higher version than this install. If so, a pill says which, and
// opening it shows the one command that updates: npm run update.

interface UpdateStatus { version: string; latest: string | null; update_available: boolean }

function useNewVersionCheck(onNewVersion: (s: UpdateStatus) => void) {
  const lastRef = React.useRef<number>(0);
  const check = React.useCallback(async () => {
    const now = Date.now();
    if (now - lastRef.current < 60 * 60 * 1000) return; // the server caches anyway
    lastRef.current = now;
    try {
      const res = await fetch(`${COMPANION_PREFIX}/api/update-check`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json() as UpdateStatus;
      if (data.update_available && data.latest) onNewVersion(data);
    } catch { /* offline: say nothing */ }
  }, [onNewVersion]);
  useEffect(() => {
    void check();
    function onVisibility() { if (document.visibilityState === 'visible') void check(); }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [check]);
}

function NewVersionPill({ status, onDismiss }: { status: UpdateStatus; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="update-pill update-pill-version" role="status" aria-live="polite" onClick={() => setOpen(o => !o)}>
      <span className="update-pill-text">Sanctum {status.latest} is out — how to update</span>
      <button
        type="button"
        className="update-pill-x"
        aria-label="Dismiss new version notice"
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
      >
        ×
      </button>
      {open && (
        <div className="update-sheet" onClick={(e) => e.stopPropagation()}>
          <p className="update-sheet-line">You have {status.version}. The newest is {status.latest}.</p>
          <p className="update-sheet-line">In Terminal, inside the app's folder:</p>
          <pre className="update-sheet-code">npm run update</pre>
          <p className="update-sheet-line">Then stop the app (Ctrl+C where it runs) and start it again with <code>npm start</code>. Your settings, data and companion folder stay as they are.</p>
        </div>
      )}
      <PillStyles />
    </div>
  );
}

// ─── Approval card ────────────────────────────────────────────────────────────
// The companion asked for permission (res ask) and is waiting. One card, the
// oldest request first; Allow or Deny answers it and the next one, if any, follows.

function ApprovalCard() {
  const approvals = useChatStore(s => s.approvals);
  const decide = useChatStore(s => s.decideApproval);
  const identity = useIdentity();
  const a = approvals[0];
  if (!a) return null;
  return (
    <div className="update-pill update-pill-version approval-card" role="dialog" aria-live="assertive" aria-label="Permission request">
      <span className="update-pill-text">{identity.companion_name} asks</span>
      <div className="update-sheet">
        <p className="update-sheet-line approval-what">{a.what}</p>
        {a.detail && <p className="update-sheet-line approval-detail">{a.detail}</p>}
        <div className="approval-actions">
          <button type="button" className="approval-btn approval-allow" onClick={() => void decide(a.id, 'approved')}>Allow</button>
          <button type="button" className="approval-btn approval-deny" onClick={() => void decide(a.id, 'denied')}>Deny</button>
          {approvals.length > 1 && <span className="approval-more">+{approvals.length - 1} more</span>}
        </div>
      </div>
      <PillStyles />
    </div>
  );
}

function UpdatePill({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="update-pill"
      role="status"
      aria-live="polite"
      onClick={() => window.location.reload()}
    >
      <span className="update-pill-text">new version — reload</span>
      <button
        type="button"
        className="update-pill-x"
        aria-label="Dismiss update notice"
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
      >
        ×
      </button>
      <PillStyles />
    </div>
  );
}

function PillStyles() {
  return (
      <style>{`
        .update-pill {
          position: fixed;
          bottom: calc(env(safe-area-inset-bottom, 0px) + 5.5rem);
          left: 50%;
          transform: translateX(-50%);
          z-index: 9000;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 1.125rem;
          background: var(--surface-pill-bg, rgba(44, 26, 16, 0.92));
          border: 1px solid var(--chrome-pill-border, rgba(201, 168, 124, 0.28));
          border-radius: 2rem;
          backdrop-filter: var(--surface-pill-blur, blur(16px) saturate(1.05));
          -webkit-backdrop-filter: var(--surface-pill-blur, blur(16px) saturate(1.05));
          box-shadow:
            0 4px 20px -4px rgba(0, 0, 0, 0.55),
            0 0 0 1px rgba(201, 168, 124, 0.06);
          cursor: pointer;
          white-space: nowrap;
          animation: pill-in 280ms cubic-bezier(0.16, 1, 0.3, 1) both;
          transition: border-color 160ms ease, box-shadow 160ms ease;
        }
        .update-pill:hover {
          border-color: rgba(201, 168, 124, 0.45);
          box-shadow:
            0 4px 24px -4px rgba(0, 0, 0, 0.65),
            0 0 0 1px rgba(201, 168, 124, 0.12);
        }
        .update-pill:active {
          transform: translateX(-50%) scale(0.985) translateY(0.5px);
        }
        .update-pill-text {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.8125rem;
          color: var(--surface-chrome-text, #efe4d0);
          line-height: 1;
          letter-spacing: 0.015em;
        }
        .update-pill-x {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 1.125rem;
          height: 1.125rem;
          margin: -0.25rem -0.375rem -0.25rem 0;
          padding: 0;
          border: none;
          background: transparent;
          color: var(--surface-chrome-muted, #d9cdb6);
          font-size: 1.05rem;
          line-height: 1;
          cursor: pointer;
          border-radius: 999px;
          transition: opacity 140ms ease, background-color 140ms ease;
        }
        .update-pill-x:hover {
          color: var(--surface-chrome-text, #efe4d0);
          background: var(--chrome-hover-wash, rgba(201, 168, 124, 0.14));
        }
        @keyframes pill-in {
          from { opacity: 0; transform: translateX(-50%) translateY(8px) scale(0.97); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0)   scale(1); }
        }
        /* The "how to update" sheet opens above the version pill */
        .update-pill-version { flex-wrap: wrap; white-space: normal; max-width: min(92vw, 26rem); }
        .update-pill-version:active { transform: translateX(-50%); }
        .update-sheet {
          flex-basis: 100%;
          margin-top: 0.625rem;
          padding-top: 0.625rem;
          border-top: 1px solid rgba(201, 168, 124, 0.22);
          cursor: default;
        }
        .update-sheet-line {
          margin: 0 0 0.5rem;
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.8125rem;
          line-height: 1.45;
          color: var(--surface-chrome-text, #efe4d0);
        }
        .update-sheet-line code { font-family: ui-monospace, Menlo, monospace; font-size: 0.78rem; }
        .approval-card { cursor: default; z-index: 9100; }
        .approval-what { font-style: normal; font-size: 0.9rem; }
        .approval-detail { color: var(--surface-chrome-muted, #d9cdb6); }
        .approval-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.25rem; }
        .approval-btn {
          padding: 0.45rem 1rem;
          border-radius: 999px;
          border: 1px solid var(--chrome-control-border, rgba(201, 168, 124, 0.35));
          background: transparent;
          color: var(--surface-chrome-text, #efe4d0);
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.85rem;
          cursor: pointer;
          min-height: 36px;
        }
        .approval-allow { background: var(--approval-allow-bg, rgba(109, 91, 147, 0.45)); border-color: var(--approval-allow-border, rgba(146, 128, 196, 0.6)); }
        .approval-allow:hover { background: var(--approval-allow-hover, rgba(109, 91, 147, 0.7)); }
        .approval-deny:hover { background: var(--chrome-hover-wash, rgba(201, 168, 124, 0.14)); }
        .approval-more { margin-left: auto; font-size: 0.75rem; color: var(--surface-chrome-muted, #d9cdb6); }
        .update-sheet-code {
          margin: 0 0 0.625rem;
          padding: 0.5rem 0.75rem;
          border-radius: 0.5rem;
          background: var(--surface-chrome-deep, rgba(0, 0, 0, 0.35));
          font-family: ui-monospace, Menlo, monospace;
          font-size: 0.85rem;
          color: var(--surface-chrome-text-hover, #fff6e4);
          user-select: all;
        }
      `}</style>
  );
}

// ─── App shell — only mounts when authenticated ────────────────────────────────

function AppShell() {
  const connect = useChatStore(s => s.connect);
  const disconnect = useChatStore(s => s.disconnect);
  const location = useLocation();
  const isChat = location.pathname.startsWith('/chat');
  // Marks which view is showing, so a skin can seat the views that are still drawn for dark glass on a solid plate.
  const routeKey = location.pathname.startsWith('/mind/observatory') ? 'observatory' : location.pathname.split('/')[1] || 'home';

  const [drawerOpen, setDrawerOpen] = useState(false);

  // The chat header's menu button asks the shell to open the drawer.

  useEffect(() => {

    const open = () => setDrawerOpen(true);

    window.addEventListener('sanctum:open-drawer', open);

    return () => window.removeEventListener('sanctum:open-drawer', open);

  }, []);
  // Holds the server buildId that triggered the pill (or 'sw' for a SW signal).
  // null = hidden. Dismissing records the id so the SAME stale build can't wedge
  // the pill again after a reload — but a genuinely newer build still shows.
  const [updateBuildId, setUpdateBuildId] = useState<string | null>(null);

  const onUpdateAvailable = React.useCallback((buildId?: string) => {
    const id = buildId ?? 'sw';
    try {
      if (localStorage.getItem('sanctum.dismissedBuild') === id) return;
    } catch { /* localStorage blocked — show anyway */ }
    setUpdateBuildId(id);
  }, []);
  useVersionCheck(onUpdateAvailable);

  // A newer Sanctum on GitHub (distinct from a newer local build above).
  // Dismissed per version, so the same release doesn't nag after a reload.
  const [newVersion, setNewVersion] = useState<UpdateStatus | null>(null);
  const onNewVersion = React.useCallback((s: UpdateStatus) => {
    try { if (localStorage.getItem('sanctum.dismissedVersion') === s.latest) return; } catch { /* show anyway */ }
    setNewVersion(s);
  }, []);
  useNewVersionCheck(onNewVersion);
  const dismissNewVersion = React.useCallback(() => {
    setNewVersion(s => {
      if (s?.latest) { try { localStorage.setItem('sanctum.dismissedVersion', s.latest); } catch { /* ignore */ } }
      return null;
    });
  }, []);

  const dismissUpdate = React.useCallback(() => {
    setUpdateBuildId((id) => {
      if (id) { try { localStorage.setItem('sanctum.dismissedBuild', id); } catch { /* ignore */ } }
      return null;
    });
  }, []);

  // Connect the WS once at the shell level so all views share it
  useEffect(() => {
    connect();
    return () => disconnect();
  }, []);

  // Ask the mind gate once at shell mount — the sidebar's /mind entry and
  // the Home night shelf both read this store. Settings saves re-fetch it.
  useEffect(() => {
    void useMindStore.getState().fetchSurface();
  }, []);

  // Reconcile the theme with the server's saved overrides — main.tsx already
  // applied whatever was cached in localStorage synchronously at load, this
  // just confirms/corrects it now that the session is authenticated.
  useEffect(() => {
    void useThemeStore.getState().fetchTheme();
  }, []);

  // The room belongs to the companion: take the skin saved on the server (null leaves this browser's choice).
  useEffect(() => {
    void loadIdentity().then(id => useAppearanceStore.getState().adoptServerSkin(id.skin ?? null));
  }, []);

  // Close the drawer whenever the route changes
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  // Lock body scroll + close on Escape while the drawer is open
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setDrawerOpen(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // Global Cmd/Ctrl+K → toggle the command palette
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('sanctum:command-palette'));
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="app-shell">
      <NavRail />
      {/* Chat carries its own compact header on phones; the shell banner would be a second one. */}
      {!isChat && <MobileTopBar onMenu={() => setDrawerOpen(true)} />}
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} isChat={isChat} />
      <ApprovalCard />
      {updateBuildId && <UpdatePill onDismiss={dismissUpdate} />}
      {!updateBuildId && newVersion && <NewVersionPill status={newVersion} onDismiss={dismissNewVersion} />}
      <CommandPalette />
      <div className="app-content" data-route={routeKey}>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="/home" element={<HomeView />} />
            <Route path="/command" element={<CommandCenterView />} />
            <Route path="/mind" element={<MindView />} />
            <Route path="/mind/observatory" element={<ObservatoryView />} />
            <Route path="/chat" element={<ChatView embedded />} />
            <Route path="/canvas" element={<CanvasView />} />
            <Route path="/files" element={<FilesView />} />
            <Route path="/browser" element={<BrowserView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
        </Suspense>
      </div>

      <style>{`
        .app-shell {
          display: flex;
          height: 100dvh;
          overflow: hidden;
          background: transparent;
        }

        .app-content {
          flex: 1;
          min-width: 0;
          height: 100%;
          overflow: hidden;
        }

        /* ─── Desktop left rail — dark wood ─── */
        .nav-rail {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 8px;
          padding: 1.25rem 0.625rem 1rem;
          /* Sits on the room: the skin's chrome ink at ~60% with a light blur (the skins.css rail rule paints it on every skin),
             one gold hairline on its right edge, no plate frame. */
          background: color-mix(in srgb, var(--plate-bg, var(--surface-chrome, #1a1410)) 60%, transparent);
          -webkit-backdrop-filter: blur(6px);
          backdrop-filter: blur(6px);
          border-right: 1px solid color-mix(in oklab, var(--skin-chrome-trim, var(--skin-trim, var(--gold, #c4a872))) 40%, transparent);
          box-shadow: none;
          flex-shrink: 0;
          /* Wide on a desktop: the mark and the house's name, each room a row. Compact below 1100px. */
          width: 164px;
          height: 100dvh;
          position: sticky;
          top: 0;
          z-index: 10;
          overflow-y: auto;
          scrollbar-width: none;
        }
        .nav-rail::-webkit-scrollbar { display: none; }
        /* The rail's foot carries the skin's own painted ornament through the plate's ornament layer: its menu's own
           (Celestial's compass, cut from the demo's menu) or else its Home ornament (the Cloister's and the Greenhouse's
           sprigs); a skin with neither paints nothing. Gone when the rail is compact or too short to keep it clear of Settings. */
        .nav-rail {
          --skin-orn: var(--skin-rail-orn, var(--skin-orn-0-upright-left, none)) !important;
          --plate-orn-size: 0px !important;
          --plate-orn-position: 0 100% !important;
        }
        @media (max-width: 1099px), (max-height: 780px) {
          .nav-rail { --plate-orn-size: 0px !important; }
        }
        .nav-brand {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.4rem;
          margin-bottom: 1.25rem;
          flex-shrink: 0;
        }
        /* The desktop rail carries the mark alone (the logo keeps its aria-label); the phone drawer keeps the word. */
        .nav-rail .nav-wordmark { display: none; }
        .nav-wordmark {
          font: 600 1.75rem/1 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
          letter-spacing: 0.01em;
          color: var(--menu-mark, var(--surface-chrome-text, #efe4d0));
        }
        .nav-logo {
          display: block;
          width: 72px;
          height: 72px;
          margin: 0 auto;
          object-fit: contain;
          flex-shrink: 0;
          border-radius: 0;
          box-shadow: none;
          background: transparent;
          filter: drop-shadow(0 3px 8px rgba(0, 0, 0, 0.5));
        }

        /* ─── Nav links (shared) ─── */
        .navlink {
          position: relative;
          isolation: isolate;
          /* the menu's ink: the chrome's own, tinted toward the skin's metal (materials.ts menuInk; Hedgewitch keeps its cream) */
          color: var(--menu-ink, var(--surface-chrome-text, #efe4d0));
          text-decoration: none;
          transition: color 150ms var(--hearth-curve, ease), background 150ms var(--hearth-curve, ease);
        }
        .navlink-icon {
          position: relative;
          display: grid;
          place-items: center;
        }
        .navlink::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: inherit;
          z-index: -1;
          opacity: 0;
          background: var(--chrome-hover-wash, rgba(239, 228, 208, 0.10));
          transition: opacity 150ms var(--hearth-curve, ease);
        }
        .navlink:hover { color: var(--surface-chrome-text-hover, #fff6e4); }
        .navlink:hover::before { opacity: 1; }
        .navlink.active::before { opacity: 1; background: var(--surface-chrome-selected, rgba(146, 128, 196, 0.30)); }
        /* The current page is marked by more than colour: an underlined label (and aria-current from the link). */
        .navlink.active .navlink-label { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 4px; }
        .navlink:active { transform: scale(0.985) translateY(0.5px); }

        /* Rail variant — icon beside its label; the current room framed in the skin's own metal
           (the Library's wood takes its oxblood rim, Hedgewitch, with no metal, its chrome ink). */
        .navlink-rail {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 0.7rem;
          width: 100%;
          padding: 0 0.75rem;
          min-height: 50px;
          border: 1px solid transparent;
          border-radius: 10px;
          flex-shrink: 0;
        }
        /* Only the current room wears a plate: the skin's selected fill with a thin gold edge. The rest are icon + text. */
        .navlink-rail.active { border-color: color-mix(in oklab, var(--skin-chrome-trim, var(--skin-trim, var(--gold, #c4a872))) 75%, transparent); }
        /* The frame marks the current room on the rail, so its label needs no underline (the drawer keeps one). */
        .navlink-rail.active .navlink-label { text-decoration: none; }
        .navlink-rail .navlink-icon svg { width: 22px; height: 22px; }
        .navlink-rail .navlink-label {
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-size: 16px;
          color: var(--menu-ink, var(--surface-chrome-text, #efe4d0));
          line-height: 1.2;
        }
        .nav-divider {
          display: block;
          height: 1px;
          margin: 0.75rem 0.5rem;
          flex-shrink: 0;
          background: var(--skin-chrome-trim, var(--skin-trim, var(--surface-chrome-muted)));
          opacity: 0.5;
        }

        /* Compact rail between the phone breakpoint and 1100px: icon over label, as before, so the page keeps its width. */
        @media (max-width: 1099px) {
          .nav-rail { width: 80px; gap: 0.375rem; padding: 1rem 0.5rem; }
          .nav-brand { margin-bottom: 0.75rem; }
          .nav-wordmark, .nav-divider { display: none; }
          .nav-logo { width: 44px; height: 44px; }
          .navlink-rail { min-height: 0; flex-direction: column; gap: 0.3rem; padding: 0.55rem 0.25rem 0.45rem; }
          .navlink-rail .navlink-icon svg { width: 20px; height: 20px; }
          .navlink-rail .navlink-label { font-size: 12px; line-height: 1.1; }
        }

        /* Drawer variant — icon + label rows */
        .navlink-drawer {
          display: flex;
          align-items: center;
          gap: 0.875rem;
          width: 100%;
          padding: 0.75rem 0.875rem;
          border-radius: 10px;
          min-height: 44px;
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-size: 1rem;
        }
        .navlink-label { line-height: 1; }

        .nav-orb-dot {
          position: absolute;
          top: -0.0625rem;
          right: -0.0625rem;
          width: 0.3125rem;
          height: 0.3125rem;
          border-radius: 50%;
          pointer-events: none;
          transition: background 420ms var(--hearth-curve, ease);
        }
        .navlink.active .nav-orb-dot {
          box-shadow: 0 0 0 1.5px rgba(12, 11, 9, 0.9), 0 0 5px 1px rgba(201, 168, 124, 0.55);
        }

        /* ─── Mobile top bar (hidden on desktop) ─── */
        .mobile-topbar { display: none; }
        .topbar-menu {
          display: grid;
          place-items: center;
          width: 2.25rem;
          height: 2.25rem;
          border-radius: 0.5rem;
          color: var(--surface-chrome-text, #efe4d0);
          background: transparent;
          border: none;
          cursor: pointer;
          flex-shrink: 0;
          margin-left: -0.25rem;
        }
        .topbar-menu:active { transform: scale(0.96); }
        .topbar-mark { width: 28px; height: 28px; object-fit: contain; flex: 1; filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.5)); }
        .topbar-wordmark {
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 1.25rem;
          letter-spacing: 0.02em;
          text-transform: lowercase;
          color: var(--surface-chrome-text, #efe4d0);
          flex: 1;
          margin-left: 0.25rem;
        }
        .topbar-presence {
          width: 0.5rem;
          height: 0.5rem;
          border-radius: 50%;
          flex-shrink: 0;
          transition: background 420ms var(--hearth-curve, ease);
        }

        /* ─── Mobile drawer (hidden on desktop) ─── */
        .mobile-drawer-root { display: none; }
        .drawer-scrim {
          position: fixed;
          inset: 0;
          z-index: 200;
          background: rgba(0, 0, 0, 0.5);
          border: none;
          opacity: 0;
          pointer-events: none;
          transition: opacity 240ms var(--hearth-curve, ease);
        }
        .drawer-panel {
          position: fixed;
          top: 0;
          left: 0;
          bottom: 0;
          z-index: 201;
          width: min(86vw, 300px);
          display: flex;
          flex-direction: column;
          background: var(--chrome-bar-bg);
          border-right: 1px solid var(--chrome-bar-border);
          box-shadow: 8px 0 32px rgba(0, 0, 0, 0.45);
          transform: translateX(-100%);
          transition: transform 280ms var(--hearth-curve, cubic-bezier(0.16, 1, 0.3, 1));
          will-change: transform;
          padding-top: env(safe-area-inset-top, 0px);
          overflow: hidden;
        }
        .mobile-drawer-root.open .drawer-scrim {
          opacity: 1;
          pointer-events: auto;
        }
        .mobile-drawer-root.open .drawer-panel {
          transform: translateX(0);
        }
        .drawer-head {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.875rem 1.125rem 0.75rem;
          border-bottom: 1px solid var(--skin-trim-quiet, var(--chrome-bar-border));
          color: var(--surface-chrome-text, #efe4d0);
          flex-shrink: 0;
        }
        .drawer-head-ring {
          flex: none;
          width: 40px;
          height: 40px;
          box-sizing: border-box;
          border-radius: 50%;
          border: 2px solid var(--skin-trim, var(--amber, #b59155));
          overflow: hidden;
          background: rgba(0, 0, 0, 0.25);
        }
        .drawer-head-ring img { display: block; width: 100%; height: 100%; object-fit: cover; }
        .drawer-head-name {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: var(--font-serif, 'Lora', Georgia, serif);
          font-size: 1.0625rem;
          font-weight: 600;
        }
        .drawer-nav {
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
          padding: 0.75rem 0.625rem 0.5rem;
          flex-shrink: 0;
        }
        .drawer-divider {
          height: 1px;
          margin: 0.25rem 0.875rem 0.5rem;
          background: rgba(239, 228, 208, 0.16);
          flex-shrink: 0;
        }
        /* The chats list fills the rest of the drawer */
        .drawer-chats {
          flex: 1;
          min-height: 0;
          display: flex;
          padding: 0 0.625rem 0.75rem;
        }
        .drawer-chats .thread-sidebar {
          width: 100%;
          border-right: none;
          border-radius: var(--radius-panel, 14px);
        }

        /* ─── Breakpoint: swap rail → top bar + drawer ─── */
        @media (max-width: 768px) {
          .app-shell { flex-direction: column; }
          .nav-rail { display: none; }
          .mobile-topbar {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            flex-shrink: 0;
            padding: calc(env(safe-area-inset-top, 0px) + 0.5rem) 1rem 0.5rem;
            background: var(--chrome-bar-bg);
            border-bottom: 1px solid var(--chrome-bar-border);
            z-index: 60;
          }
          .mobile-drawer-root { display: block; }
          .app-content {
            flex: 1 1 auto;
            min-height: 0;
            height: auto;
          }
        }
      `}</style>
    </div>
  );
}

// ─── Auth gate — the outermost layer ──────────────────────────────────────────
// Runs the /api/auth/check on mount and holds everything behind it.
// Nothing fetches, no WS opens, until this confirms authenticated.

function AuthGate() {
  const status = useAuthStore(s => s.status);
  const household = useAuthStore(s => s.household);
  const checkAuth = useAuthStore(s => s.checkAuth);

  useEffect(() => {
    void checkAuth();
  }, []);

  if (status === 'checking') {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100dvh',
        background: 'transparent',
      }}>
        <div style={{
          width: '0.375rem',
          height: '0.375rem',
          borderRadius: '50%',
          background: 'var(--surface-chrome-text, #efe4d0)',
          animation: 'auth-pulse 1.4s ease-in-out infinite',
        }} />
        <style>{`
          @keyframes auth-pulse {
            0%, 100% { opacity: 0.3; transform: scale(0.8); }
            50%       { opacity: 1;   transform: scale(1); }
          }
        `}</style>
      </div>
    );
  }

  if (status === 'unconfigured') {
    // No password yet: the server cannot let anyone in, so the app opens the three-screen onboarding in the foyer instead of a sign-in.
    // (The step-by-step wizard stays in Settings, under Preferences, for everything onboarding leaves at its default.) A household's first run
    // is the house's, and the house has one step, its password (tenancy/house-setup.ts): the plan-driven wizard walks exactly that.
    return household ? <SetupWizard mode="first_run" /> : <Onboarding />;
  }

  if (status === 'unauthenticated') {
    return <LoginView />;
  }

  // Household mode, no companion in the address: the hallway, not a companion (nothing connects until a door is chosen; one companion opens straight in)
  if (household && !COMPANION_PREFIX) return <Hallway />;

  // authenticated — render the full app, WS connects here
  return (
    <BrowserRouter basename={COMPANION_PREFIX || undefined}>
      <ConfirmProvider>
        <AppShell />
      </ConfirmProvider>
    </BrowserRouter>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export function App() {
  return <AuthGate />;
}
