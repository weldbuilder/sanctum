/**
 * SettingsView — multi-section panel with left sub-sidebar.
 *
 * Nav rail (Home/Chat/Settings) stays unchanged at the app level.
 * Inside Settings: sub-sidebar on the left lists 7 sections, content pane renders
 * the selected section.
 *
 * Sections: Preferences · Appearance · Orchestrator · Discord · Telegram · MCPs · Skills & Status
 */
import React, { useState } from 'react';
import { useAuthStore } from '../store/auth';
import { PreferencesSection } from './settings/PreferencesSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { OrchestratorSection } from './settings/OrchestratorSection';
import { ChannelsSection } from './settings/ChannelsSection';
import { McpSection } from './settings/McpSection';
import { SkillsStatusSection } from './settings/SkillsStatusSection';
import { UsageSection } from './settings/UsageSection';
import { GoogleSection } from './settings/GoogleSection';
import { MindSection } from './settings/MindSection';
import { LogsSection } from './settings/LogsSection';
import { PluginsSection } from './settings/PluginsSection';
import { IdentitySection } from './settings/IdentitySection';
import { PRIMITIVES_CSS } from './settings/primitives';

// ─── Base URL ─────────────────────────────────────────────────────────────────

import { BASE } from '../lib/base';

// ─── Section registry ─────────────────────────────────────────────────────────

type SectionId =
  | 'preferences'
  | 'appearance'
  | 'orchestrator'
  | 'channels'
  | 'mcps'
  | 'skills'
  | 'usage'
  | 'integrations'
  | 'plugins'
  | 'identity'
  | 'logs';

interface SectionMeta {
  id: SectionId;
  label: string;
  sub?: string;
  icon: React.ReactNode;
}

const SECTIONS: SectionMeta[] = [
  {
    id: 'preferences',
    label: 'preferences',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    ),
  },
  {
    id: 'appearance',
    label: 'appearance',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a10 10 0 010 20" />
        <path d="M12 2v20" />
        <path d="M2 12h20" />
      </svg>
    ),
  },
  {
    id: 'orchestrator',
    label: 'orchestrator',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
      </svg>
    ),
  },
  {
    id: 'channels',
    label: 'channels',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6" cy="12" r="2" />
        <circle cx="18" cy="12" r="2" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </svg>
    ),
  },
  {
    id: 'mcps',
    label: 'registered MCPs',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    id: 'skills',
    label: 'skills & status',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    id: 'usage',
    label: 'usage & model',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
  },
  {
    id: 'integrations',
    label: 'integrations',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" />
      </svg>
    ),
  },
  {
    id: 'plugins',
    label: 'plugins',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v5M8 2v5M16 2v5M6 7h12v4a6 6 0 01-12 0V7z" /><path d="M12 17v5" />
      </svg>
    ),
  },
  {
    id: 'identity',
    label: 'identity',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3z" /><path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
  {
    id: 'logs',
    label: 'logs',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 4h16M4 9h16M4 14h10M4 19h7" />
      </svg>
    ),
  },
];

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
      {SECTIONS.map(sec => (
        <button
          key={sec.id}
          className={`settings-subnav-btn${active === sec.id ? ' active' : ''}`}
          onClick={() => onChange(sec.id)}
          aria-current={active === sec.id ? 'page' : undefined}
        >
          <span className="settings-subnav-icon" aria-hidden="true">{sec.icon}</span>
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
  switch (id) {
    case 'preferences': return <PreferencesSection base={BASE} />;
    case 'appearance':  return <AppearanceSection />;
    case 'orchestrator': return <OrchestratorSection base={BASE} />;
    case 'channels':    return <ChannelsSection base={BASE} onOpenLogs={onOpenLogs} />;
    case 'mcps':        return <McpSection base={BASE} />;
    case 'skills':        return <SkillsStatusSection base={BASE} />;
    case 'usage':         return <UsageSection base={BASE} />;
    case 'integrations':  return (
      <>
        {/* The Mind card first — the seam lives at the top of Integrations
            (MIND-SURFACE-SPEC §Phase-1.1), then Google below. */}
        <MindSection base={BASE} />
        <GoogleSection base={BASE} />
      </>
    );
    case 'plugins':       return <PluginsSection base={BASE} />;
    case 'identity':      return <IdentitySection base={BASE} />;
    case 'logs':          return <LogsSection base={BASE} initialQuery={logsQuery} />;
    default: return null;
  }
}

// ─── SettingsView ─────────────────────────────────────────────────────────────

export function SettingsView() {
  const [activeSection, setActiveSection] = useState<SectionId>('preferences');
  // A card can send the person to the log viewer with a filter already typed (the Discord card: `[discord]`).
  const [logsQuery, setLogsQuery] = useState('');
  const openLogs = (q: string) => { setLogsQuery(q); setActiveSection('logs'); };

  const activeMeta = SECTIONS.find(s => s.id === activeSection)!;

  return (
    <div className="settings-view">
      {/* Inject primitives CSS once */}
      <style>{PRIMITIVES_CSS}</style>

      {/* Sub-sidebar */}
      <SubSidebar active={activeSection} onChange={setActiveSection} />

      {/* Content pane */}
      <div className="settings-content" role="main">
        <div className="settings-content-scroll">
          <div className="settings-content-inner">

            {/* Section header */}
            <header className="settings-section-header">
              <h1 className="settings-section-title">{activeMeta.label}</h1>
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
            min-height: 36px;
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
      `}</style>
    </div>
  );
}
