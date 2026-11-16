/**
 * SettingsView — six tabs and a Status page, with a left sub-sidebar (a wrapped pill strip on a phone).
 *
 * You & them · Mind · Rhythm · Channels · Permissions · Look, then Status (read-only panels, Google, the server). The tab list is
 * settingsTabs.ts; each tab is one component in ./settings.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { useChatStore } from '../store/chat';
import { AppearanceSection } from './settings/AppearanceSection';
import { OrchestratorSection } from './settings/OrchestratorSection';
import { YouThemTab } from './settings/YouThemTab';
import { MindTab } from './settings/MindTab';
import { ChannelsTab } from './settings/ChannelsTab';
import { PermissionsSection } from './settings/PermissionsSection';
import { StatusTab } from './settings/StatusTab';
import { PRIMITIVES_CSS } from './settings/primitives';
import { TABS, tabFromSearch, type SectionId } from './settingsTabs';

import { BASE } from '../lib/base';

const ICON = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const ICONS: Record<SectionId, React.ReactNode> = {
  you: <svg {...ICON}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.5-3.5 3-5.5 6.5-5.5s6 2 6.5 5.5" /><circle cx="18" cy="9" r="2.5" /><path d="M17 14.5c2.5 0 4 1.5 4.5 4" /></svg>,
  mind: <svg {...ICON}><path d="M12 2a7 7 0 00-4 12.7V18h8v-3.3A7 7 0 0012 2z" /><path d="M9.5 21h5" /></svg>,
  rhythm: <svg {...ICON}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  channels: <svg {...ICON}><circle cx="6" cy="12" r="2" /><circle cx="18" cy="12" r="2" /><line x1="8" y1="12" x2="16" y2="12" /></svg>,
  permissions: <svg {...ICON}><path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3z" /><path d="M9 12l2 2 4-4" /></svg>,
  look: <svg {...ICON}><circle cx="12" cy="12" r="10" /><path d="M12 2a10 10 0 010 20" /><path d="M12 2v20" /><path d="M2 12h20" /></svg>,
  status: <svg {...ICON}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>,
};

// ─── Sub-sidebar ──────────────────────────────────────────────────────────────

function SubSidebar({
  active,
  onChange,
}: {
  active: SectionId;
  onChange: (id: SectionId) => void;
}) {
  const logout = useAuthStore(s => s.logout);

  return (
    <nav className="settings-subnav" aria-label="Settings sections">
      <div className="settings-subnav-label">settings</div>
      {TABS.map(sec => (
        <button
          key={sec.id}
          className={`settings-subnav-btn${active === sec.id ? ' active' : ''}`}
          onClick={() => onChange(sec.id)}
          aria-current={active === sec.id ? 'page' : undefined}
        >
          <span className="settings-subnav-icon" aria-hidden="true">{ICONS[sec.id]}</span>
          <span className="settings-subnav-text">{sec.label}</span>
          {active === sec.id && (
            <span className="settings-subnav-indicator" aria-hidden="true" />
          )}
        </button>
      ))}

      {/* Logout — sits at the bottom of the sidebar, separated */}
      <div className="settings-subnav-spacer" aria-hidden="true" />
      <button
        className="settings-subnav-btn settings-subnav-logout"
        onClick={() => void logout()}
        title="Sign out"
      >
        <span className="settings-subnav-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </span>
        <span className="settings-subnav-text">sign out</span>
      </button>
    </nav>
  );
}

// ─── Content renderer ─────────────────────────────────────────────────────────

function SectionContent({ id, logsQuery, onOpenLogs }: { id: SectionId; logsQuery: string; onOpenLogs: (q: string) => void }) {
  const navigate = useNavigate();
  const openThread = (threadId: string) => { void useChatStore.getState().loadThread(threadId); navigate('/chat'); };
  switch (id) {
    case 'you':         return <YouThemTab base={BASE} />;
    case 'mind':        return <MindTab base={BASE} />;
    case 'rhythm':      return <OrchestratorSection base={BASE} />;
    case 'channels':    return <ChannelsTab base={BASE} onOpenLogs={onOpenLogs} />;
    case 'permissions': return <PermissionsSection base={BASE} openThread={openThread} />;
    case 'look':        return <AppearanceSection />;
    case 'status':      return <StatusTab base={BASE} logsQuery={logsQuery} />;
    default: return null;
  }
}

// ─── SettingsView ─────────────────────────────────────────────────────────────

export function SettingsView() {
  const [activeSection, setActiveSection] = useState<SectionId>(() => tabFromSearch(typeof window === 'undefined' ? '' : window.location.search));
  // A card can send the person to the log viewer with a filter already typed (the Discord card: `[discord]`); the log lives on Status.
  const [logsQuery, setLogsQuery] = useState('');
  const openLogs = (q: string) => { setLogsQuery(q); setActiveSection('status'); };
  // Only the card's button seeds the filter: leaving Status, or opening it from the sidebar, starts clean.
  const chooseSection = (id: SectionId) => { setLogsQuery(''); setActiveSection(id); };

  const activeMeta = TABS.find(s => s.id === activeSection)!;
  // A new tab opens at its top, not where the last one was scrolled to.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [activeSection]);

  return (
    <div className="settings-view" data-settings-tab={activeSection}>
      {/* Inject primitives CSS once */}
      <style>{PRIMITIVES_CSS}</style>

      {/* Sub-sidebar */}
      <SubSidebar active={activeSection} onChange={chooseSection} />

      {/* Content pane */}
      <div className="settings-content" role="main">
        <div className="settings-content-scroll" ref={scrollRef}>
          <div className="settings-content-inner">

            {/* Section header */}
            <header className="settings-section-header">
              <h1 className="settings-section-title">{activeMeta.label}</h1>
              <p className="settings-section-sub">{activeMeta.sub}</p>
            </header>

            {/* Section body */}
            <SectionContent id={activeSection} logsQuery={logsQuery} onOpenLogs={openLogs} />

          </div>
        </div>
      </div>

      <style>{`
        /* ─── Settings shell ─── */
        .settings-view {
          display: flex;
          height: 100%;
          overflow: hidden;
          background: transparent;
        }

        /* Mobile: stacked — tab strip on top, content below */
        @media (max-width: 600px) {
          .settings-view {
            flex-direction: column;
          }
          .settings-content-scroll {
            padding: 1.25rem 1rem 3rem;
          }
          .settings-content-inner {
            max-width: 100%;
          }
          .settings-section-title {
            font-size: 1.25rem;
          }
        }

        /* ─── Sub-sidebar ─── */
        .settings-subnav {
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
          padding: 1.5rem 0.625rem 1.5rem;
          /* Section list on its own frosted parchment strip, so the labels
             read against the kitchen instead of dissolving into it. */
          background: var(--settings-subnav-bg, rgba(246, 238, 219, 0.78));
          -webkit-backdrop-filter: var(--settings-subnav-blur, blur(18px) saturate(1.15));
          backdrop-filter: var(--settings-subnav-blur, blur(18px) saturate(1.15));
          border-right: 1px solid var(--divider, rgba(90, 65, 40, 0.18));
          flex-shrink: 0;
          width: 12.5rem;
          height: 100%;
          overflow-y: auto;
        }

        /* Mobile: collapse sub-sidebar to wrapping pill strip — no horizontal scroll */
        @media (max-width: 600px) {
          .settings-subnav {
            flex-direction: row;
            flex-wrap: wrap;
            width: 100%;
            height: auto;
            padding: 0.5rem 0.5rem 0.375rem;
            border-right: none;
            border-bottom: 1px solid rgba(201, 168, 124, 0.06);
            overflow-x: hidden;
            overflow-y: visible;
            gap: 0.25rem;
            flex-shrink: 0;
            min-height: unset;
          }
        }

        .settings-subnav-label {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 1.0625rem;
          font-weight: 500;
          color: var(--text-primary, #e2dbd0);
          padding: 0 0.625rem 1.125rem;
          letter-spacing: -0.005em;
        }

        /* Mobile: hide "settings" label in horizontal strip — no room */
        @media (max-width: 600px) {
          .settings-subnav-label { display: none; }
        }

        .settings-subnav-btn {
          position: relative;
          display: flex;
          align-items: center;
          gap: 0.5625rem;
          padding: 0.5rem 0.625rem;
          border-radius: 0.5rem;
          color: var(--text-muted, #6a6258);
          cursor: pointer;
          background: transparent;
          border: none;
          width: 100%;
          text-align: left;
          transition: color 150ms var(--hearth-curve, ease), background 150ms var(--hearth-curve, ease);
          isolation: isolate;
          min-height: 40px;
        }

        .settings-subnav-btn::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: inherit;
          z-index: -1;
          opacity: 0;
          background: radial-gradient(circle, rgba(201, 168, 124, 0.12), transparent 80%);
          transition: opacity 150ms var(--hearth-curve, ease);
        }

        .settings-subnav-btn:hover {
          color: var(--text-secondary, #a09689);
        }
        .settings-subnav-btn:hover::before { opacity: 1; }

        .settings-subnav-btn.active {
          color: var(--amber, #c9a87c);
          background: rgba(201, 168, 124, 0.07);
        }
        .settings-subnav-btn.active::before { opacity: 0.6; }

        .settings-subnav-btn:active {
          transform: scale(0.985) translateY(0.5px);
          transition: transform 100ms var(--hearth-curve, ease);
        }

        .settings-subnav-icon {
          display: flex;
          align-items: center;
          flex-shrink: 0;
          opacity: 0.7;
        }
        .settings-subnav-btn.active .settings-subnav-icon {
          opacity: 1;
        }

        .settings-subnav-text {
          font-size: 0.8125rem;
          letter-spacing: 0.005em;
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* Mobile: compact pill buttons — icon + label, wrap to fit viewport */
        @media (max-width: 600px) {
          .settings-subnav-btn {
            flex-direction: row;
            gap: 0.3rem;
            padding: 0.35rem 0.6rem;
            width: auto;
            border-radius: 1.5rem;
            flex-shrink: 1;
            min-height: 40px;
            border: 1px solid rgba(255, 255, 255, 0.05);
          }
          .settings-subnav-btn.active {
            border-color: rgba(201, 168, 124, 0.22);
          }
          .settings-subnav-text {
            font-size: 0.6875rem;
            letter-spacing: 0.02em;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex: none;
            max-width: 7rem;
          }
          /* Active indicator: hide the side-bar variant — amber background is enough */
          .settings-subnav-indicator {
            display: none;
          }
        }

        .settings-subnav-indicator {
          position: absolute;
          right: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 2px;
          height: 60%;
          background: var(--amber, #c9a87c);
          border-radius: 1px;
          box-shadow: 0 0 8px rgba(201, 168, 124, 0.50);
        }

        /* ─── Logout button ─── */
        .settings-subnav-spacer {
          flex: 1;
          min-height: 1rem;
        }

        /* On mobile the subnav is horizontal — hide the spacer and keep logout in flow */
        @media (max-width: 600px) {
          .settings-subnav-spacer { display: none; }
        }

        .settings-subnav-logout {
          color: var(--text-muted, #6a6258) !important;
        }

        :root[data-material="mounted-paper"] .settings-subnav .settings-subnav-text { color: var(--subnav-ink, #F8E8CF); }
        :root[data-material="mounted-paper"] .settings-subnav .settings-subnav-logout { color: var(--subnav-ink, #F8E8CF) !important; }
        .settings-subnav-logout:hover {
          color: var(--subnav-danger, #c87c6a) !important;
        }

        /* ─── Content pane ─── */
        .settings-content {
          flex: 1;
          min-width: 0;
          height: 100%;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .settings-content-scroll {
          flex: 1;
          overflow-y: auto;
          padding: 1.25rem 1.5rem 3rem;
        }

        /* Settings sit on their own parchment sheet, solid rather than glass, so
           form controls and the log block stay legible over the kitchen. */
        .settings-content-inner {
          max-width: 40rem;
          margin: 0 auto;
          background: var(--card-bg);
          border: 1px solid rgba(255, 250, 240, 0.4);
          border-radius: var(--radius-panel, 14px);
          box-shadow: var(--panel-shadow, 0 10px 30px rgba(20, 10, 5, 0.35));
          padding: 1.5rem 1.75rem 2rem;
        }

        /* Desktop: a real page. The plate fills the room (left-aligned to the same
           1.5rem gutter as the chat header plate) instead of a centered 40rem pillar. */
        @media (min-width: 769px) {
          .settings-content-scroll { padding: 1.5rem 1.5rem 3rem; }
          .settings-content-inner {
            max-width: 1152px;
            margin: 0;
            padding: 2rem 2.5rem 2.5rem;
            font-size: 1rem;
          }
        }

        .settings-section-header {
          margin-bottom: 0.125rem;
        }
        .settings-section-sub {
          margin: 0.125rem 0 0;
          font-size: 0.8125rem;
          color: var(--text-muted);
        }
        @media (min-width: 769px) { .settings-section-sub { font-size: 14px; } }

        .settings-section-title {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-weight: 500;
          font-size: 1.625rem;
          color: var(--text-primary, #e2dbd0);
          letter-spacing: -0.01em;
          line-height: 1.2;
        }
        /* After the base rule, so it wins at equal specificity. */
        @media (min-width: 769px) {
          .settings-section-title { font-size: 28px; }
        }

        /* Desktop section menu: the same translucent strip as the nav rail (its fill, blur and gold hairline are
           painted in skins.css), labels at 15px, the current section plated the way the rail plates its room. */
        @media (min-width: 769px) {
          .settings-subnav-text { font-size: 15px; }
          .settings-subnav-btn { border: 1px solid transparent; }
          .settings-subnav-btn.active {
            color: var(--menu-ink, var(--surface-chrome-text, #efe4d0));
            background: var(--surface-chrome-selected, rgba(146, 128, 196, 0.30));
            border-color: color-mix(in oklab, var(--skin-chrome-trim, var(--skin-trim, var(--gold, #c4a872))) 75%, transparent);
          }
          .settings-subnav-btn.active::before { opacity: 0; }
        }

        /* ── Dark glass, same as the Command Center. Controls stay parchment so
           they read; everything else is cream on the room. ── */
        .settings-view {
          --text-primary: var(--settings-ink, #efe4d0);
          --text-secondary: var(--settings-ink-2, #dccfb8);
          --text-muted: var(--settings-ink-3, #c2b39c);
          --status-error-text: var(--settings-error, #e8a698);
          --status-warning-text: var(--settings-warning, #e0b95a);
          --status-success-text: var(--settings-success, #7cc496);
          color: var(--settings-ink, #efe4d0);
        }
        .settings-content-inner {
          background: var(--settings-panel-bg, rgba(22, 16, 20, 0.45));
          -webkit-backdrop-filter: var(--settings-panel-blur, blur(8px));
          backdrop-filter: var(--settings-panel-blur, blur(8px));
          border: 1px solid var(--settings-panel-border, rgba(255, 250, 240, 0.14));
          color: var(--settings-ink, #efe4d0);
        }
        .settings-subnav {
          background: var(--settings-subnav-bg, rgba(22, 16, 20, 0.5));
          border-right: 1px solid var(--settings-subnav-border, rgba(255, 250, 240, 0.12));
          --text-primary: var(--subnav-ink, #efe4d0);
          --text-secondary: var(--subnav-ink-2, #dccfb8);
          --text-muted: var(--subnav-ink-3, #c2b39c);
          --amber: var(--subnav-accent, var(--amber));
          color: var(--subnav-ink, #efe4d0);
        }
        .settings-view input, .settings-view select, .settings-view textarea {
          background: var(--settings-field-bg, rgba(34, 44, 26, 0.72));
          color: var(--settings-field-text, #f3ead7);
          border: 1px solid var(--settings-field-border, rgba(255, 250, 240, 0.22));
        }
        .settings-view input::placeholder, .settings-view textarea::placeholder { color: var(--settings-field-placeholder, #b7a98f); opacity: 1; }
        /* The provider/model dropdown trigger follows the field colours, not --bg-input (parchment on a light skin) under the room's light ink. */
        .settings-view .hsel-trigger {
          background: var(--settings-field-bg, rgba(34, 44, 26, 0.72));
          color: var(--settings-field-text, #f3ead7);
          border-color: var(--settings-field-border, rgba(255, 250, 240, 0.22));
        }
        .settings-view .hsel-trigger:disabled { color: var(--settings-disabled-text, #b7a98f); }
        /* Field text uses the field's own ink, not the lavender the mono slot carries. */
        .settings-view input, .settings-view textarea, .settings-view select, .settings-view .mono, .settings-view .sp-field-value.mono, .settings-view code { color: var(--settings-field-text, #f3ead7) !important; }

        /* ── Tap targets: every control in Settings is at least 40px to hit. Buttons and fields grow; a switch keeps its painted
           track and gets an invisible hit area round it, so no skin's switch changes. ── */
        .settings-view .sp-btn, .settings-view .sp-btn.small, .settings-view .hsel-trigger, .settings-view .sp-form-input,
        .settings-view select.sp-form-input, .settings-view .sysprompt-save, .settings-view .pend-cancel-btn, .settings-view .pend-expand-toggle {
          min-height: 40px;
        }
        .settings-view .pend-cancel-btn, .settings-view .pend-expand-toggle { min-width: 40px; }
        .settings-view .sp-toggle { position: relative; }
        .settings-view .sp-toggle::after { content: ''; position: absolute; inset: 50% auto auto 50%; width: 48px; height: 44px; transform: translate(-50%, -50%); }
      `}</style>
    </div>
  );
}
