/**
 * Skills & Status section.
 * Skills list from GET /api/skills.
 * System health from GET /api/system/status.
 * Uptime, backend, DB, WS, MCP health, model, memory.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { SystemStatus, OrchestratorTaskStatus } from '@sanctum/shared';
import { Group, Eyebrow, FieldRow, Pill, EmptyState, Spinner, StatCard } from './primitives';
import { useChatStore } from '../../store/chat';

// ─── Skill shape ──────────────────────────────────────────────────────────────

interface Skill {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  trigger?: string;
  category?: string;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mins = Math.floor(s / 60);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

function formatMB(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function formatDbSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ─── REST /api/system/status shape ────────────────────────────────────────────
// Different from the WS SystemStatus push — has uptimeSeconds + version + dbStats.

interface SystemInfo {
  version: string;
  uptimeSeconds: number;
  nodeVersion: string;
  env: string;
  dbOk: boolean;
  dbStats: {
    fileSizeBytes: number | null;
    messages: number;
    threads: number;
  };
}

// ─── SkillsStatusSection ──────────────────────────────────────────────────────

export function SkillsStatusSection({ base }: { base: string }) {
  const connectionState = useChatStore(s => s.connectionState);
  const presence = useChatStore(s => s.presence);

  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  // REST endpoint shape (version, dbStats) — separate from WS-pushed SystemStatus
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [skillsLoading, setSkillsLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/system/status`);
      if (res.ok) {
        const data = await res.json();
        // REST endpoint has version + dbStats + uptimeSeconds
        if (data?.version !== undefined) setSystemInfo(data as SystemInfo);
        // WS push shape has uptime in milliseconds
        if (data && typeof data.uptime === 'number') setSystemStatus(data as SystemStatus);
      }
    } catch { /* graceful */ }
    setLoading(false);
  }, [base]);

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true);
    try {
      const res = await fetch(`${base}/api/skills`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setSkills(data);
        else if (Array.isArray(data?.skills)) setSkills(data.skills);
      }
    } catch { /* graceful */ }
    setSkillsLoading(false);
  }, [base]);

  useEffect(() => {
    loadStatus();
    loadSkills();
    // Refresh status every 30s
    const id = setInterval(loadStatus, 30000);
    return () => clearInterval(id);
  }, [loadStatus, loadSkills]);

  // Listen for live system_status WS push
  useEffect(() => {
    const handler = (msg: any) => {
      if (msg.type === 'system_status' && msg.status && typeof msg.status.uptime === 'number') {
        setSystemStatus(msg.status as SystemStatus);
        setLoading(false);
      }
    };
    if (!(window as any).__sanctumWsListeners) (window as any).__sanctumWsListeners = [];
    (window as any).__sanctumWsListeners.push(handler);
    return () => {
      (window as any).__sanctumWsListeners = (
        (window as any).__sanctumWsListeners ?? []
      ).filter((h: any) => h !== handler);
    };
  }, []);

  const mcpOk = systemStatus?.mcpServers?.filter(s => s.status === 'connected').length ?? 0;
  const mcpFail = systemStatus?.mcpServers?.filter(s => s.status === 'failed').length ?? 0;
  const totalMcpTools = systemStatus?.mcpServers?.reduce((acc, s) => acc + (s.toolCount ?? 0), 0) ?? 0;

  return (
    <div className="skills-status-section">

      {/* ── System health ── */}
      <Eyebrow label="system health" />
      {loading ? (
        <div className="ss-loading"><Spinner /></div>
      ) : systemStatus ? (
        <>
          <Group>
            <div className="ss-field-row-status">
              <span className="sp-field-label">websocket</span>
              <span className={`ss-ws-badge${connectionState === 'connected' ? ' ok' : connectionState === 'reconnecting' ? ' warn' : ''}`}>
                <span className="sp-pip" style={{
                  background: connectionState === 'connected' ? '#6dba88' : connectionState === 'reconnecting' ? '#d4a843' : '#71717a',
                  display: 'inline-block',
                  width: '0.375rem',
                  height: '0.375rem',
                  borderRadius: '50%',
                  marginRight: '0.375rem',
                  flexShrink: 0,
                }} aria-hidden="true" />
                {connectionState}
              </span>
            </div>
            <FieldRow label="presence" value={presence} mono />
            <FieldRow label="uptime" value={formatUptime(systemStatus.uptime)} mono />
            <FieldRow label="agent processing" value={systemStatus.agentProcessing} />
            <FieldRow
              label="connections"
              value={`${systemStatus.connections} ws${systemStatus.userConnected ? ' · user connected' : ''}`}
              mono
            />
          </Group>

          <div className="sp-stat-grid" style={{ marginTop: '0.75rem' }}>
            <StatCard label="mem rss" value={formatMB(systemStatus.memoryUsage.rss)} />
            <StatCard label="heap used" value={formatMB(systemStatus.memoryUsage.heapUsed)} />
            <StatCard label="heap total" value={formatMB(systemStatus.memoryUsage.heapTotal)} />
            <StatCard label="mcp ok" value={mcpOk} />
            <StatCard label="mcp fail" value={mcpFail} warn={mcpFail > 0} />
            <StatCard label="tools" value={totalMcpTools} />
          </div>

          {/* ── Build info + DB stats from REST endpoint ── */}
          {systemInfo && (
            <>
              <Eyebrow label="build" />
              <Group>
                <FieldRow label="version" value={systemInfo.version} mono />
                <FieldRow label="node" value={systemInfo.nodeVersion} mono />
                <FieldRow label="env" value={systemInfo.env} mono />
                <FieldRow
                  label="db"
                  value={systemInfo.dbOk ? 'healthy' : 'error'}
                  mono
                />
              </Group>
              <Eyebrow label="database" />
              <div className="sp-stat-grid" style={{ marginTop: '0.25rem' }}>
                <StatCard label="db size" value={formatDbSize(systemInfo.dbStats.fileSizeBytes)} />
                <StatCard label="messages" value={systemInfo.dbStats.messages.toLocaleString()} />
                <StatCard label="threads" value={systemInfo.dbStats.threads.toLocaleString()} />
              </div>
            </>
          )}

          {/* ── Orchestrator tasks snapshot ── */}
          {systemStatus.orchestratorTasks?.length > 0 && (
            <>
              <Eyebrow label="orchestrator snapshot" />
              <div className="ss-orch-list">
                {systemStatus.orchestratorTasks.map((t: OrchestratorTaskStatus) => (
                  <div key={t.wakeType} className="ss-orch-row">
                    <span className={`ss-orch-pip ${t.status}`} aria-hidden="true" />
                    <span className="ss-orch-label">{t.label}</span>
                    <span className="ss-orch-status">{t.status}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── Gateway summary ── */}
          {(systemStatus.discord || systemStatus.telegram) && (
            <>
              <Eyebrow label="gateways" />
              <Group>
                {systemStatus.discord && (
                  <FieldRow
                    label="discord"
                    value={systemStatus.discord.connected ? `connected · ${systemStatus.discord.guilds} guilds` : 'disconnected'}
                    mono
                  />
                )}
                {systemStatus.telegram && (
                  <FieldRow
                    label="telegram"
                    value={systemStatus.telegram.connected ? 'connected' : 'disconnected'}
                    mono
                  />
                )}
              </Group>
            </>
          )}
        </>
      ) : (
        <EmptyState message="System status unavailable — backend may still be starting." />
      )}

      {/* ── Skills ── */}
      <Eyebrow label="skills" sub={skills.length > 0 ? `${skills.length} loaded` : undefined} />
      {skillsLoading ? (
        <div className="ss-loading"><Spinner /></div>
      ) : skills.length === 0 ? (
        <EmptyState message="No skills found at /api/skills — endpoint may not be implemented yet." />
      ) : (
        <div className="ss-skill-list">
          {skills.map(skill => (
            <div key={skill.id ?? skill.name} className="ss-skill-row">
              <div className="ss-skill-info">
                <span className="ss-skill-name">{skill.name}</span>
                {skill.description && (
                  <span className="ss-skill-desc">{skill.description}</span>
                )}
                {skill.trigger && (
                  <span className="ss-skill-trigger">{skill.trigger}</span>
                )}
              </div>
              <div className="ss-skill-right">
                {skill.category && (
                  <Pill
                    color="var(--text-muted, #6a6258)"
                    label={skill.category}
                  />
                )}
                {typeof skill.enabled === 'boolean' && (
                  <Pill
                    color={skill.enabled ? '#6dba88' : '#71717a'}
                    label={skill.enabled ? 'on' : 'off'}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <style>{`
        .skills-status-section { padding-bottom: 2rem; }

        .ss-loading {
          display: flex;
          justify-content: center;
          padding: 2rem 0;
        }

        .ss-field-row-status {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.5625rem 0;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }

        .ss-ws-badge {
          display: inline-flex;
          align-items: center;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--text-muted, #6a6258);
        }
        .ss-ws-badge.ok { color: #6dba88; }
        .ss-ws-badge.warn { color: #d4a843; }

        .ss-orch-list {
          display: flex;
          flex-direction: column;
          gap: 0;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 0.625rem;
          padding: 0 0.875rem;
        }
        .ss-orch-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.4375rem 0;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .ss-orch-row:last-child { border-bottom: none; }
        .ss-orch-pip {
          display: inline-block;
          width: 0.375rem;
          height: 0.375rem;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .ss-orch-pip.scheduled { background: #6dba88; }
        .ss-orch-pip.running   { background: #d4a843; animation: presencePulse 1.4s ease-in-out infinite; }
        .ss-orch-pip.stopped   { background: #3f3f46; }
        .ss-orch-label {
          flex: 1;
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
        }
        .ss-orch-status {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--text-muted, #6a6258);
        }

        .ss-skill-list {
          display: flex;
          flex-direction: column;
          gap: 0;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 0.625rem;
          padding: 0 0.875rem;
        }
        .ss-skill-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 0.75rem;
          padding: 0.625rem 0;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .ss-skill-row:last-child { border-bottom: none; }
        .ss-skill-info {
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
          min-width: 0;
        }
        .ss-skill-name {
          font-size: 0.875rem;
          color: var(--text-primary, #e2dbd0);
        }
        .ss-skill-desc {
          font-size: 0.75rem;
          color: var(--text-secondary, #a09689);
          line-height: 1.4;
        }
        @media (min-width: 769px) { .settings-view .ss-skill-desc, .settings-view .ss-skill-name { font-size: 14px; } }
        .ss-skill-trigger {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--amber-dim, #a08960);
          margin-top: 0.125rem;
        }
        .ss-skill-right {
          display: flex;
          gap: 0.375rem;
          align-items: center;
          flex-shrink: 0;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
      `}</style>
    </div>
  );
}
