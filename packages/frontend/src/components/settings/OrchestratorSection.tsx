/**
 * Orchestrator section — wake type prompt management + friendly scheduler.
 *
 * Part A: Wake Types — first-class editable prompts (the "what").
 *   GET  /api/orchestrator/wake-types           → list
 *   PUT  /api/orchestrator/wake-types/:type     → save prompt
 *   POST /api/orchestrator/wake-types           → create
 *   DELETE /api/orchestrator/wake-types/:type   → delete (+ its schedule)
 *
 * Part B: Friendly Scheduler — the "when".
 *   GET  /api/orchestrator/status               → scheduled tasks list
 *   PATCH /api/orchestrator/tasks/:wakeType     → reschedule / create schedule
 *   DELETE /api/orchestrator/tasks/:wakeType    → remove schedule
 *   GET  /api/orchestrator (legacy)             → enable/disable toggle
 *   PUT  /api/preferences                       → orchestrator enabled toggle
 *
 * New in this revision:
 *   — Part A-ext: Model picker per scheduled wake (GET /api/models).
 *     set_schedule POST body includes `model` (empty string = default/autonomous).
 *     ScheduledTaskRow displays a small model pill.
 *   — Part B-ext: Custom Hearth-styled time picker replaces <input type="time">.
 *     Segment fields (HH / MM), mono digits, amber focus, arrow-key + click
 *     affordances. Produces / consumes the same "HH:MM" 24h string as before.
 *   — Target picker: which thread the wake posts to. '@daily' (default) = today's
 *     rotating daily thread. A specific thread id locks it to that thread.
 *     GET /api/threads drives the option list (loaded once per panel mount).
 *     set_schedule POST body always includes `target`.
 *     ScheduledTaskRow shows a small target pill next to the model pill.
 *
 * Pulse + failsafe controls preserved from previous version.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OrchestratorTaskStatus } from '@sanctum/shared';
import {
  Card,
  Group,
  Eyebrow,
  ToggleRow,
  Btn,
  Pill,
  EmptyState,
  Spinner,
  SubDivider,
  StatCard,
  TextField,
  SaveIndicator,
} from './primitives';
import { HearthTimePicker } from '../hearth/HearthTimePicker';
import { HearthDatePicker } from '../hearth/HearthDatePicker';
import { HearthSelect } from '../hearth';
import { Disclosure } from './Disclosure';
import { PREFS_CSS, PrefsSaveBar, usePreferences } from './prefsShared';
import { DAY_ABBR, buildCron, parseCron, cronSummary, type FrequencyKey, type FriendlySchedule } from './cron';

// ─── Model catalog types ───────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
  label: string;
  tier: string;
}

interface ModelsResponse {
  models: ModelEntry[];
  current: string;
  currentAutonomous: string;
}

// ─── Thread list shape (from GET /api/threads) ────────────────────────────────

interface ThreadEntry {
  id: string;
  name: string;
}

// ─── Wake type shape (from /api/orchestrator/wake-types) ──────────────────────

interface WakeTypeRecord {
  type: string;
  label: string;
  content: string;
  scheduled: boolean;
  cronExpr: string | null;
}

// ─── Scheduled task shape (from /api/orchestrator/status) ─────────────────────

// OrchestratorTaskStatus already carries all fields we need:
//   wakeType, label, cronExpr, enabled, status, nextRun, category, model
// model is string | null per the shared type; null = no override (use autonomous default).
type ScheduledTask = OrchestratorTaskStatus;

// ─── Category colours ─────────────────────────────────────────────────────────

const CATEGORY_COLOR: Record<string, string> = {
  wake:     '#c9a87c',
  checkin:  '#a893c0',
  handoff:  '#5eaba5',
  failsafe: '#c0524a',
  routine:  '#6a6258',
};

// ─── Tier colour tint ─────────────────────────────────────────────────────────

const TIER_COLOR: Record<string, string> = {
  fable:  '#dfc49a',
  opus:   '#a893c0',
  sonnet: '#c9a87c',
  haiku:  '#5eaba5',
  custom: '#6a6258',
};

// ─── Prettify type token ───────────────────────────────────────────────────────

function prettifyType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── PART A: Wake Types Manager ───────────────────────────────────────────────

function WakeTypeRow({
  wt,
  isExpanded,
  onToggleExpand,
  onSaveContent,
  onDelete,
  saving,
  deleting,
}: {
  wt: WakeTypeRecord;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSaveContent: (type: string, content: string) => Promise<void>;
  onDelete: (type: string) => void;
  saving: boolean;
  deleting: boolean;
}) {
  const [draft, setDraft] = useState(wt.content);
  const [localStatus, setLocalStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const prevContent = useRef(wt.content);

  // Sync if parent reloads content
  useEffect(() => {
    if (!isExpanded && wt.content !== prevContent.current) {
      setDraft(wt.content);
      prevContent.current = wt.content;
    }
  }, [wt.content, isExpanded]);

  const handleSave = async () => {
    setLocalStatus('saving');
    try {
      await onSaveContent(wt.type, draft);
      prevContent.current = draft;
      setLocalStatus('saved');
    } catch {
      setLocalStatus('error');
    }
    setTimeout(() => setLocalStatus('idle'), 2200);
  };

  const isDirty = draft !== wt.content;

  return (
    <div className={`wt-row${isExpanded ? ' wt-row--open' : ''}`}>
      <div className="wt-row-header">
        <button
          className="wt-row-toggle"
          onClick={onToggleExpand}
          aria-expanded={isExpanded}
        >
          <span className="wt-row-chevron">{isExpanded ? '▾' : '▸'}</span>
          <span className="wt-row-label">{wt.label || prettifyType(wt.type)}</span>
          <span className="wt-row-type">{wt.type}</span>
          {wt.scheduled && (
            <span className="wt-scheduled-pip" title={wt.cronExpr ?? ''}>
              {wt.cronExpr ? cronSummary(wt.cronExpr) : 'scheduled'}
            </span>
          )}
        </button>
        <button
          className="sp-btn sp-btn-danger small"
          onClick={() => onDelete(wt.type)}
          disabled={deleting}
          title="Delete wake type and its schedule"
          aria-label={`Delete ${wt.label}`}
        >
          {deleting ? <Spinner /> : '×'}
        </button>
      </div>

      {isExpanded && (
        <div className="wt-row-body">
          <p className="wt-row-hint">
            Prompt injected when this wake type fires. Markdown supported.
          </p>
          <textarea
            className="sysprompt-textarea wt-prompt-textarea"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            spellCheck={false}
            rows={12}
            aria-label={`Prompt for ${wt.label}`}
          />
          <div className="wt-row-actions">
            <SaveIndicator status={localStatus} />
            <button
              className="sysprompt-save"
              onClick={handleSave}
              disabled={!isDirty || saving || localStatus === 'saving'}
            >
              {localStatus === 'saving' ? <Spinner /> : 'save prompt'}
            </button>
          </div>
        </div>
      )}

      <style>{`
        .wt-row {
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 0.625rem;
          background: rgba(255,255,255,0.02);
          overflow: hidden;
          transition: border-color 160ms ease;
        }
        .wt-row:hover { border-color: rgba(255,255,255,0.09); }
        .wt-row--open { border-color: rgba(201,168,124,0.18); }

        .wt-row-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.625rem 0.75rem;
        }

        .wt-row-toggle {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          background: none;
          border: none;
          cursor: pointer;
          text-align: left;
          padding: 0;
          min-width: 0;
        }

        .wt-row-chevron {
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          flex-shrink: 0;
          transition: color 150ms ease;
        }
        .wt-row--open .wt-row-chevron { color: var(--amber, #c9a87c); }

        .wt-row-label {
          font-size: 0.875rem;
          color: var(--text-primary, #e2dbd0);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex-shrink: 1;
        }

        .wt-row-type {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          letter-spacing: 0.03em;
          flex-shrink: 0;
        }

        .wt-scheduled-pip {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.75rem;
          color: var(--amber, #c9a87c);
          flex-shrink: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 10rem;
        }

        .wt-row-body {
          padding: 0 0.875rem 0.875rem;
          display: flex;
          flex-direction: column;
          gap: 0.625rem;
          border-top: 1px solid rgba(255,255,255,0.05);
          padding-top: 0.75rem;
          animation: slideDown 160ms ease both;
        }

        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .wt-row-hint {
          font-size: 0.75rem;
          color: var(--text-muted, #6a6258);
          font-style: italic;
          margin: 0;
        }

        .wt-prompt-textarea {
          min-height: 10rem !important;
        }

        .wt-row-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0.75rem;
        }
      `}</style>
    </div>
  );
}

// ─── New Wake Type inline form ─────────────────────────────────────────────────

const TYPE_PATTERN = /^[a-z0-9_]+$/;

function NewWakeTypeForm({
  onSubmit,
  onCancel,
  submitting,
}: {
  onSubmit: (type: string, content: string) => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [typeVal, setTypeVal] = useState('');
  const [content, setContent] = useState('');
  const [typeError, setTypeError] = useState('');
  const [localStatus, setLocalStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const validateType = (v: string) => {
    if (!v) return 'Required';
    if (!TYPE_PATTERN.test(v)) return 'Only lowercase letters, numbers, underscores';
    return '';
  };

  const handleSubmit = async () => {
    const err = validateType(typeVal);
    if (err) { setTypeError(err); return; }
    setLocalStatus('saving');
    try {
      await onSubmit(typeVal, content);
      setLocalStatus('saved');
    } catch (e: any) {
      setLocalStatus('error');
    }
    setTimeout(() => setLocalStatus('idle'), 2200);
  };

  const canSubmit = typeVal && !typeError && !submitting && localStatus !== 'saving';

  return (
    <div className="new-wt-form">
      <div className="sp-form-group">
        <label className="sp-form-label">
          type id
          <span className="sp-restart-badge" style={{ background: 'rgba(255,255,255,0.04)', color: '#6a6258', borderColor: 'rgba(255,255,255,0.08)' }}>
            a–z 0–9 _
          </span>
        </label>
        <input
          className="sp-form-input mono"
          value={typeVal}
          onChange={e => {
            setTypeVal(e.target.value);
            setTypeError(validateType(e.target.value));
          }}
          placeholder="morning_wake"
          autoFocus
          spellCheck={false}
        />
        {typeError && <span className="sp-form-hint" style={{ color: 'rgba(210,140,130,0.85)' }}>{typeError}</span>}
        {!typeError && typeVal && (
          <span className="sp-form-hint">label will be "{prettifyType(typeVal)}"</span>
        )}
      </div>

      <div className="sp-form-group">
        <label className="sp-form-label">initial prompt</label>
        <textarea
          className="sysprompt-textarea"
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="What should happen when this wake type fires…"
          rows={6}
          spellCheck={false}
        />
      </div>

      <div className="new-wt-footer">
        <SaveIndicator status={localStatus} />
        <Btn variant="muted" onClick={onCancel} disabled={submitting}>cancel</Btn>
        <button
          className="sysprompt-save"
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          {submitting || localStatus === 'saving' ? <Spinner /> : 'create type'}
        </button>
      </div>

      <style>{`
        .new-wt-form {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          padding: 1rem;
          background: rgba(201,168,124,0.04);
          border: 1px solid rgba(201,168,124,0.14);
          border-radius: 0.625rem;
          animation: slideDown 160ms ease both;
        }
        .new-wt-footer {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0.5rem;
          margin-top: 0.25rem;
        }
      `}</style>
    </div>
  );
}

// ─── PART B: Delete-schedule confirm inline ────────────────────────────────────

function DeleteScheduleConfirm({
  label,
  onConfirm,
  onCancel,
  deleting,
}: {
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
}) {
  return (
    <div className="del-confirm">
      <span className="del-confirm-msg">
        Remove the schedule for <em>{label}</em>? The wake type and its prompt are kept.
      </span>
      <div className="del-confirm-actions">
        <Btn variant="muted" onClick={onCancel} disabled={deleting}>keep it</Btn>
        <Btn variant="danger" onClick={onConfirm} disabled={deleting}>
          {deleting ? <Spinner /> : 'remove schedule'}
        </Btn>
      </div>
      <style>{`
        .del-confirm {
          display: flex;
          flex-direction: column;
          gap: 0.625rem;
          padding: 0.75rem;
          background: rgba(210,100,90,0.05);
          border: 1px solid rgba(210,100,90,0.20);
          border-radius: 0.625rem;
          animation: slideDown 160ms ease both;
        }
        .del-confirm-msg {
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
          font-style: italic;
          line-height: 1.45;
        }
        .del-confirm-msg em { color: var(--text-primary, #e2dbd0); font-style: normal; }
        .del-confirm-actions {
          display: flex;
          gap: 0.5rem;
          justify-content: flex-end;
        }
      `}</style>
    </div>
  );
}

// ─── PART B: Friendly schedule panel ──────────────────────────────────────────

const FREQUENCY_OPTIONS: { key: FrequencyKey; label: string }[] = [
  { key: 'daily',    label: 'Every day' },
  { key: 'weekdays', label: 'Weekdays' },
  { key: 'weekends', label: 'Weekends' },
  { key: 'custom',   label: 'Specific days…' },
];

function FriendlySchedulePanel({
  wakeTypes,
  existingTask,
  onSave,
  onCancel,
  saving,
  base,
}: {
  wakeTypes: WakeTypeRecord[];
  existingTask: ScheduledTask | null; // null = new
  onSave: (wakeType: string, cronExpr: string, model: string, target: string) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
  base: string;
}) {
  const defaultFriendly: FriendlySchedule = { time: '08:00', frequency: 'daily', customDays: [] };

  const parsed = existingTask ? parseCron(existingTask.cronExpr) : null;
  const isComplex = existingTask && !parsed;

  const [selectedType, setSelectedType] = useState(existingTask?.wakeType ?? (wakeTypes[0]?.type ?? ''));
  const [friendly, setFriendly] = useState<FriendlySchedule>(parsed ?? defaultFriendly);
  const [localStatus, setLocalStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // ── Model state ──
  // Empty string = "Default (autonomous)" — omit from POST body.
  const [modelsData, setModelsData] = useState<ModelsResponse | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  // Pre-fill from task.model if editing — default '' (= Default) if null/absent.
  const [selectedModel, setSelectedModel] = useState<string>(existingTask?.model ?? '');

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch(`${base}/api/models`);
        if (res.ok) {
          const data = await res.json() as ModelsResponse;
          if (alive && data && Array.isArray(data.models)) {
            setModelsData(data);
          }
        }
      } catch { /* backend not reachable */ }
      if (alive) setModelsLoading(false);
    }
    load();
    return () => { alive = false; };
  }, [base]);

  // ── Target state ──
  // '@daily' = today's rotating daily thread (default).
  // A thread id = that specific thread.
  const [threads, setThreads] = useState<ThreadEntry[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  // Pre-fill from task.target if editing; absent/undefined falls back to '@daily'.
  const [selectedTarget, setSelectedTarget] = useState<string>(
    existingTask?.target && existingTask.target !== '' ? existingTask.target : '@daily'
  );

  useEffect(() => {
    let alive = true;
    async function loadThreads() {
      try {
        const res = await fetch(`${base}/api/threads`);
        if (res.ok) {
          const data = await res.json() as { threads: ThreadEntry[] };
          if (alive && data && Array.isArray(data.threads)) {
            setThreads(data.threads);
          }
        }
      } catch { /* backend not reachable */ }
      if (alive) setThreadsLoading(false);
    }
    loadThreads();
    return () => { alive = false; };
  }, [base]);

  const generatedCron = buildCron(friendly);
  const summary = cronSummary(generatedCron);

  const toggleCustomDay = (day: number) => {
    setFriendly(prev => {
      const has = prev.customDays.includes(day);
      return {
        ...prev,
        customDays: has ? prev.customDays.filter(d => d !== day) : [...prev.customDays, day],
      };
    });
  };

  const handleSave = async () => {
    if (!selectedType) return;
    setLocalStatus('saving');
    try {
      await onSave(selectedType, generatedCron, selectedModel, selectedTarget);
      setLocalStatus('saved');
    } catch {
      setLocalStatus('error');
    }
    setTimeout(() => setLocalStatus('idle'), 2200);
  };

  const canSave = selectedType &&
    (friendly.frequency !== 'custom' || friendly.customDays.length > 0) &&
    !saving &&
    localStatus !== 'saving';

  // Derive readable label for the currently configured autonomous model
  const autonomousLabel = modelsData
    ? (modelsData.models.find(m => m.id === modelsData.currentAutonomous)?.label ?? modelsData.currentAutonomous ?? 'autonomous')
    : 'autonomous';

  return (
    <div className="sch-panel" role="dialog" aria-label={existingTask ? 'Edit schedule' : 'New schedule'}>
      <h3 className="sch-panel-title">
        {existingTask ? 'edit schedule' : 'new schedule'}
      </h3>

      {/* Wake type selector */}
      <div className="sp-form-group">
        <label className="sp-form-label">wake type</label>
        <HearthSelect
          block
          value={selectedType}
          onChange={setSelectedType}
          options={wakeTypes.map(wt => ({
            value: wt.type,
            label: wt.label || prettifyType(wt.type),
          }))}
          placeholder="no wake types yet"
          disabled={!!existingTask}
          ariaLabel="Wake type"
        />
        {existingTask && (
          <span className="sp-form-hint">type is fixed — delete the schedule to change it</span>
        )}
      </div>

      {/* Complex cron warning */}
      {isComplex && (
        <div className="sch-complex-note">
          <span>
            Stored cron <code className="sch-cron-code">{existingTask!.cronExpr}</code> is too complex
            to edit with the friendly picker. Save below to replace it, or cancel to keep it.
          </span>
        </div>
      )}

      {/* Time picker — Hearth-styled, replaces <input type="time"> */}
      <div className="sp-form-group">
        <label className="sp-form-label">time of day</label>
        <HearthTimePicker
          value={friendly.time}
          onChange={time => setFriendly(prev => ({ ...prev, time }))}
        />
      </div>

      {/* Frequency selector */}
      <div className="sp-form-group">
        <label className="sp-form-label">frequency</label>
        <div className="sch-freq-pills">
          {FREQUENCY_OPTIONS.map(opt => (
            <button
              key={opt.key}
              className={`sch-freq-pill${friendly.frequency === opt.key ? ' active' : ''}`}
              onClick={() => setFriendly(prev => ({ ...prev, frequency: opt.key }))}
              type="button"
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Custom day checkboxes */}
      {friendly.frequency === 'custom' && (
        <div className="sp-form-group">
          <label className="sp-form-label">days</label>
          <div className="sch-day-grid">
            {DAY_ABBR.map((day, i) => (
              <button
                key={i}
                className={`sch-day-btn${friendly.customDays.includes(i) ? ' active' : ''}`}
                onClick={() => toggleCustomDay(i)}
                type="button"
                aria-pressed={friendly.customDays.includes(i)}
              >
                {day}
              </button>
            ))}
          </div>
          {friendly.customDays.length === 0 && (
            <span className="sp-form-hint" style={{ color: 'rgba(210,140,130,0.85)' }}>
              Select at least one day
            </span>
          )}
        </div>
      )}

      {/* Model picker */}
      <div className="sp-form-group">
        <label className="sp-form-label">model</label>
        {modelsLoading ? (
          <div className="sch-model-loading"><Spinner /></div>
        ) : (
          <HearthSelect
            block
            value={selectedModel}
            onChange={setSelectedModel}
            options={[
              { value: '', label: `Default (${autonomousLabel})` },
              ...(modelsData?.models ?? []).map(m => ({
                value: m.id,
                label: m.label,
                sublabel: m.tier && m.tier !== 'custom' ? m.tier : undefined,
              })),
            ]}
            ariaLabel="Model override for this scheduled wake"
          />
        )}
        <span className="sp-form-hint">
          Leave as Default to run on your configured autonomous model.
        </span>
      </div>

      {/* Target picker */}
      <div className="sp-form-group">
        <label className="sp-form-label">posts to</label>
        {threadsLoading ? (
          <div className="sch-model-loading"><Spinner /></div>
        ) : (
          <HearthSelect
            block
            value={selectedTarget}
            onChange={setSelectedTarget}
            options={[
              { value: '@daily', label: "Daily (today's thread)" },
              ...threads.map(t => ({ value: t.id, label: t.name })),
            ]}
            ariaLabel="Thread this scheduled wake posts to"
          />
        )}
        <span className="sp-form-hint">
          Daily rotates with the date. A specific thread pins this wake to that conversation.
        </span>
      </div>

      {/* Plain-english summary */}
      <div className="sch-summary">
        <span className="sch-summary-label">fires</span>
        <span className="sch-summary-text">{summary}</span>
        <code className="sch-summary-cron">{generatedCron}</code>
      </div>

      <div className="sch-panel-footer">
        <SaveIndicator status={localStatus} />
        <Btn variant="muted" onClick={onCancel} disabled={saving}>cancel</Btn>
        <button
          className="sysprompt-save"
          onClick={handleSave}
          disabled={!canSave}
        >
          {saving || localStatus === 'saving' ? <Spinner /> : 'save schedule'}
        </button>
      </div>

      <style>{`
        .sch-panel {
          display: flex;
          flex-direction: column;
          gap: 0.875rem;
          padding: 1.125rem;
          background: rgba(201,168,124,0.04);
          border: 1px solid rgba(201,168,124,0.16);
          border-radius: 0.75rem;
          animation: slideDown 160ms ease both;
        }

        .sch-panel-title {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 1rem;
          font-weight: 500;
          color: var(--text-primary, #e2dbd0);
          margin: 0;
        }

        .sch-complex-note {
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
          line-height: 1.5;
          padding: 0.625rem 0.75rem;
          background: rgba(255,255,255,0.03);
          border-radius: 0.375rem;
          border: 1px solid rgba(255,255,255,0.06);
        }
        .sch-cron-code {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          color: var(--amber-bright, #e3c49a);
          background: rgba(201,168,124,0.08);
          padding: 0.0625rem 0.3125rem;
          border-radius: 0.1875rem;
        }

        .sch-freq-pills {
          display: flex;
          flex-wrap: wrap;
          gap: 0.375rem;
        }
        .sch-freq-pill {
          font-size: 0.8125rem;
          font-family: inherit;
          padding: 0.3125rem 0.75rem;
          border-radius: 0.4375rem;
          border: 1px solid rgba(255,255,255,0.09);
          background: transparent;
          color: var(--text-muted, #6a6258);
          cursor: pointer;
          transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
        }
        .sch-freq-pill:hover {
          color: var(--text-secondary, #a09689);
          border-color: rgba(255,255,255,0.14);
        }
        .sch-freq-pill.active {
          background: rgba(201,168,124,0.14);
          color: var(--amber-bright, #e3c49a);
          border-color: rgba(201,168,124,0.30);
        }

        .sch-day-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.25rem;
        }
        .sch-day-btn {
          font-size: 0.6875rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          letter-spacing: 0.03em;
          padding: 0.3125rem 0;
          border-radius: 0.375rem;
          border: 1px solid rgba(255,255,255,0.09);
          background: transparent;
          color: var(--text-muted, #6a6258);
          cursor: pointer;
          transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
          text-align: center;
        }
        .sch-day-btn:hover {
          color: var(--text-secondary, #a09689);
          border-color: rgba(255,255,255,0.15);
        }
        .sch-day-btn.active {
          background: rgba(201,168,124,0.14);
          color: var(--amber-bright, #e3c49a);
          border-color: rgba(201,168,124,0.28);
        }

        .sch-model-loading {
          display: flex;
          align-items: center;
          height: 2.25rem;
        }

        .sch-summary {
          display: flex;
          align-items: baseline;
          gap: 0.5rem;
          padding: 0.5rem 0.75rem;
          background: rgba(255,255,255,0.02);
          border-radius: 0.375rem;
          border: 1px solid rgba(255,255,255,0.05);
          flex-wrap: wrap;
        }
        .sch-summary-label {
          font-size: 0.6875rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-muted, #6a6258);
          flex-shrink: 0;
        }
        .sch-summary-text {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.875rem;
          color: var(--amber, #c9a87c);
          flex: 1;
        }
        .sch-summary-cron {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          letter-spacing: 0.03em;
          flex-shrink: 0;
        }

        .sch-panel-footer {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0.5rem;
          margin-top: 0.25rem;
        }

        /* Mobile: make day grid usable — minimum tap target per button */
        @media (max-width: 600px) {
          .sch-day-grid {
            gap: 0.375rem;
          }
          .sch-day-btn {
            padding: 0.5rem 0;
            font-size: 0.5625rem;
            min-height: 40px;
          }
        }
      `}</style>
    </div>
  );
}

// ─── Scheduled task row ────────────────────────────────────────────────────────

function ScheduledTaskRow({
  task,
  modelsData,
  threads,
  onToggle,
  onEdit,
  onDeleteSchedule,
  actionId,
}: {
  task: ScheduledTask;
  modelsData: ModelsResponse | null;
  threads: ThreadEntry[];
  onToggle: (wakeType: string, enabled: boolean) => void;
  onEdit: (task: ScheduledTask) => void;
  onDeleteSchedule: (wakeType: string) => void;
  actionId: string | null;
}) {
  const catColor = CATEGORY_COLOR[task.category] ?? '#6a6258';
  const isActing = actionId === task.wakeType;

  const nextRunText = task.nextRun
    ? (() => {
        const d = new Date(task.nextRun);
        const diff = d.getTime() - Date.now();
        if (diff < 0) return 'overdue';
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `in ${mins}m`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `in ${hrs}h`;
        return `in ${Math.floor(hrs / 24)}d`;
      })()
    : '—';

  // Resolve model display — model is string | null per shared type
  const taskModel = task.model;
  const modelEntry = taskModel && modelsData
    ? modelsData.models.find(m => m.id === taskModel) ?? null
    : null;
  const modelLabel = modelEntry ? modelEntry.label : (taskModel ?? null);
  const modelTier  = modelEntry?.tier ?? null;
  const modelColor = modelTier ? (TIER_COLOR[modelTier] ?? '#6a6258') : '#6a6258';

  // Resolve target display
  // Treat absent/empty/'@daily' as the daily default.
  const taskTarget = task.target ?? '@daily';
  const isDaily = !taskTarget || taskTarget === '@daily';
  const targetThreadEntry = !isDaily
    ? (threads.find(t => t.id === taskTarget) ?? null)
    : null;
  // Label: fall back to the raw id if thread wasn't found in list (stale/archived)
  const targetLabel = isDaily ? null : (targetThreadEntry?.name ?? taskTarget);

  return (
    <div className={`wake-row${!task.enabled ? ' disabled' : ''}`}>
      <div className="wake-row-top">
        <Pill color={catColor} label={task.category} />
        <span className="wake-label">{task.label}</span>
        {task.status === 'running' && (
          <span className="wake-running-badge">running</span>
        )}
        <div className="wake-row-actions">
          <button
            className="sp-btn sp-btn-ghost small"
            onClick={() => onEdit(task)}
            title="Edit schedule"
            aria-label={`Edit schedule for ${task.label}`}
          >
            edit
          </button>
          <button
            className="sp-btn sp-btn-danger small"
            onClick={() => onDeleteSchedule(task.wakeType)}
            disabled={isActing}
            title="Remove schedule"
            aria-label={`Remove schedule for ${task.label}`}
          >
            {isActing ? <Spinner /> : '×'}
          </button>
        </div>
      </div>

      <div className="wake-row-meta">
        <code className="wake-cron" title={task.cronExpr}>{task.cronExpr}</code>
        <span className="wake-cron-summary">{cronSummary(task.cronExpr)}</span>
        {/* Model pill — only shown when a model override is set */}
        {modelLabel ? (
          <span className="wake-model-pill" style={{ color: modelColor, borderColor: `${modelColor}44`, background: `${modelColor}12` }}>
            {modelLabel}
          </span>
        ) : (
          <span className="wake-model-pill wake-model-pill--default">default</span>
        )}
        {/* Target pill */}
        {isDaily ? (
          <span className="wake-target-pill wake-target-pill--daily">Daily</span>
        ) : (
          <span className="wake-target-pill wake-target-pill--thread">
            → {targetLabel}
          </span>
        )}
        <span className="wake-next">{nextRunText}</span>
        <button
          role="switch"
          aria-checked={task.enabled}
          className={`sp-toggle small${task.enabled ? ' on' : ''}`}
          onClick={() => onToggle(task.wakeType, !task.enabled)}
          disabled={isActing}
          aria-label={task.enabled ? 'Disable' : 'Enable'}
        >
          <span className="sp-toggle-thumb" />
        </button>
      </div>

      <style>{`
        .wake-row {
          padding: 0.75rem;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 0.625rem;
          display: flex;
          flex-direction: column;
          gap: 0.375rem;
          transition: border-color 160ms ease;
        }
        .wake-row:hover { border-color: rgba(255,255,255,0.10); }
        .wake-row.disabled { opacity: 0.55; }

        .wake-row-top {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .wake-label {
          flex: 1;
          min-width: 0;
          font-size: 0.875rem;
          color: var(--text-primary, #e2dbd0);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .wake-running-badge {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5625rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #6dba88;
          background: rgba(109,186,136,0.12);
          border: 1px solid rgba(109,186,136,0.25);
          border-radius: 0.25rem;
          padding: 0.0625rem 0.3125rem;
          animation: presencePulse 2s ease-in-out infinite;
        }
        .wake-row-actions {
          display: flex;
          gap: 0.25rem;
          flex-shrink: 0;
        }
        .wake-row-meta {
          display: flex;
          align-items: center;
          gap: 0.625rem;
          flex-wrap: wrap;
        }
        .wake-cron {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          color: var(--amber-bright, #e3c49a);
          letter-spacing: 0.02em;
          background: rgba(201,168,124,0.07);
          border-radius: 0.25rem;
          padding: 0.0625rem 0.375rem;
        }
        .wake-cron-summary {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
          flex: 1;
        }
        .wake-model-pill {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.04em;
          padding: 0.0625rem 0.375rem;
          border-radius: 0.25rem;
          border: 1px solid;
          flex-shrink: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 8rem;
        }
        .wake-model-pill--default {
          color: var(--text-muted, #6a6258);
          border-color: rgba(106,98,88,0.25);
          background: rgba(106,98,88,0.07);
        }
        .wake-target-pill {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.04em;
          padding: 0.0625rem 0.375rem;
          border-radius: 0.25rem;
          border: 1px solid;
          flex-shrink: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 9rem;
        }
        .wake-target-pill--daily {
          color: var(--text-muted, #6a6258);
          border-color: rgba(106,98,88,0.20);
          background: rgba(106,98,88,0.05);
        }
        .wake-target-pill--thread {
          color: var(--amber, #c9a87c);
          border-color: rgba(201,168,124,0.30);
          background: rgba(201,168,124,0.08);
        }
        .wake-next {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          letter-spacing: 0.04em;
          flex-shrink: 0;
        }
        .sp-toggle.small {
          width: 1.875rem;
          height: 1rem;
        }
        .sp-toggle.small .sp-toggle-thumb {
          width: 0.6875rem;
          height: 0.6875rem;
          left: 0.125rem;
        }
        .sp-toggle.small.on .sp-toggle-thumb {
          left: calc(100% - 0.125rem - 0.6875rem);
        }
      `}</style>
    </div>
  );
}

// ─── Daily Handoff card ───────────────────────────────────────────────────────
//
// A clearly-grouped card for the 12:10am handoff subagent. The wake UI above is
// tightly coupled to orchestrator wake-type/cron objects, so the handoff lives
// as its own card in the same automation section rather than a fake wake row.
//
//   GET   /api/handoff/status         → { enabled, schedule, lastRunAt, lastResult }
//   PATCH /api/handoff/config         → { enabled } (flips the flag)
//   POST  /api/handoff/run            → run now
//
// Keep it simple: toggle + schedule + run-now. (Iris polish flagged in the
// build report: live last-result preview of the posted opener, a friendly
// time/timezone picker like the wakes use, and a peek at the stored carry.)

interface HandoffRunResult {
  ran: boolean;
  reason?: string;
  opener?: string;
  carry?: string;
  postedToThreadId?: string;
}

interface HandoffStatusResponse {
  enabled: boolean;
  schedule: string;
  lastRunAt: string | null;
  lastResult: HandoffRunResult | null;
}

function HandoffCard({ base }: { base: string }) {
  const [status, setStatus] = useState<HandoffStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/handoff/status`);
      if (res.ok) {
        const data = await res.json() as HandoffStatusResponse;
        setStatus(data);
      }
    } catch { /* backend not up */ }
    finally { setLoading(false); }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  function flash(text: string) {
    setMsg(text);
    setTimeout(() => setMsg(null), 3200);
  }

  const toggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      const res = await fetch(`${base}/api/handoff/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        const data = await res.json() as HandoffStatusResponse;
        setStatus(data);
        flash(enabled ? 'Daily handoff enabled' : 'Daily handoff disabled');
      } else {
        flash('Toggle failed');
      }
    } catch { flash('Toggle failed'); }
    finally { setToggling(false); }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await fetch(`${base}/api/handoff/run`, { method: 'POST' });
      if (res.ok) {
        const result = await res.json() as HandoffRunResult;
        if (result.ran) {
          flash(result.postedToThreadId
            ? 'Handoff posted into today’s daily'
            : 'Handoff ran (carry stored)');
        } else {
          flash(`No-op: ${result.reason ?? 'nothing to carry'}`);
        }
        await load();
      } else {
        flash('Run failed');
      }
    } catch { flash('Run failed'); }
    finally { setRunning(false); }
  };

  const lastRunText = status?.lastRunAt
    ? new Date(status.lastRunAt).toLocaleString('en-GB', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : 'never';

  return (
    <>
      <Eyebrow label="daily handoff" sub="off by default" />
      <Card>
        <p className="handoff-blurb">
          At <strong>{status?.schedule ?? '12:10 Europe/London'}</strong> a Sonnet-4.6 subagent reads
          yesterday’s daily and posts a warm first-person carry-forward as the opening message of
          today’s daily — so the day never starts cold.
        </p>

        {loading ? (
          <div className="handoff-loading"><Spinner /></div>
        ) : (
          <>
            <ToggleRow
              label="enabled"
              checked={!!status?.enabled}
              onChange={toggle}
              disabled={toggling}
              hint="Runs the 12:10am carry-forward. Off = the daily starts cold."
            />

            <div className="handoff-meta">
              <span className="handoff-meta-item">
                <span className="handoff-meta-k">schedule</span>
                <span className="handoff-meta-v">{status?.schedule ?? '12:10 Europe/London'}</span>
              </span>
              <span className="handoff-meta-item">
                <span className="handoff-meta-k">last run</span>
                <span className="handoff-meta-v">{lastRunText}</span>
              </span>
              {status?.lastResult && (
                <span className="handoff-meta-item">
                  <span className="handoff-meta-k">last result</span>
                  <span className="handoff-meta-v">
                    {status.lastResult.ran ? 'carried' : (status.lastResult.reason ?? 'no-op')}
                  </span>
                </span>
              )}
            </div>

            <div className="handoff-actions">
              {msg && <span className="handoff-msg">{msg}</span>}
              <Btn variant="muted" onClick={runNow} disabled={running} small>
                {running ? <Spinner /> : 'run now'}
              </Btn>
            </div>
          </>
        )}
      </Card>

      <style>{`
        .handoff-blurb {
          font-size: 0.8125rem;
          line-height: 1.55;
          color: var(--text-secondary, #a09689);
          margin: 0 0 0.875rem;
        }
        .handoff-blurb strong { color: var(--amber, #c9a87c); font-weight: 500; }
        .handoff-loading { display: flex; justify-content: center; padding: 1rem 0; }
        .handoff-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 1.25rem;
          margin: 0.875rem 0 0.25rem;
          padding-top: 0.75rem;
          border-top: 1px solid rgba(255,255,255,0.05);
        }
        .handoff-meta-item { display: flex; flex-direction: column; gap: 0.1875rem; }
        .handoff-meta-k {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-muted, #6a6258);
        }
        .handoff-meta-v {
          font-size: 0.8125rem;
          color: var(--text-primary, #e2dbd0);
        }
        .handoff-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0.75rem;
          margin-top: 0.875rem;
        }
        .handoff-msg {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.8125rem;
          color: #6dba88;
        }
      `}</style>
    </>
  );
}

// ─── Watchtower — the mood dial for the companion's chance to reach ──────────
//
//   GET  /api/orchestrator/watchtower   → { mode, lastFiredDate }
//   POST /api/orchestrator/watchtower   → { mode } → echoes config
//
// Three-way dial: auto (4h gap, respects the workday) · quiet (leave me be) ·
// close (1.5h, come find me). The system only opens the door — the companion decides
// whether reaching is care.

type WatchtowerMode = 'auto' | 'quiet' | 'close';

interface WatchtowerConfigResponse {
  mode: WatchtowerMode;
  lastFiredDate: string | null;  // "YYYY-MM-DD" local, or null
}

const WATCHTOWER_MODES: { key: WatchtowerMode; label: string; sub: string }[] = [
  { key: 'auto',  label: 'auto',  sub: '4h, respects workdays' },
  { key: 'quiet', label: 'quiet', sub: 'leave me be' },
  { key: 'close', label: 'close', sub: '1.5h, come find me' },
];

/** "YYYY-MM-DD" (local) → "today" / "28 Jun" — for the last-reached meta line */
function lastReachedText(lastFiredDate: string | null): string {
  if (!lastFiredDate) return 'never';
  const today = new Date().toLocaleDateString('en-CA');
  if (lastFiredDate === today) return 'today';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastFiredDate);
  if (!m) return lastFiredDate;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function WatchtowerCard({ base }: { base: string }) {
  const [config, setConfig] = useState<WatchtowerConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/orchestrator/watchtower`);
      if (res.ok) {
        const data = await res.json() as WatchtowerConfigResponse;
        if (data && typeof data.mode === 'string') setConfig(data);
      }
    } catch { /* backend not reachable */ }
    setLoading(false);
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  // orchestrator_update WS ripple — a `res` / daemon-side dial flip refetches
  // the card live (mirrors CommandCenterView's cc_update handler).
  useEffect(() => {
    const handler = (msg: { type?: string; what?: string }) => {
      if (msg?.type !== 'orchestrator_update' || msg.what !== 'watchtower') return;
      void load();
    };
    const w = window as unknown as { __sanctumWsListeners?: Array<(m: unknown) => void> };
    if (!w.__sanctumWsListeners) w.__sanctumWsListeners = [];
    w.__sanctumWsListeners.push(handler as (m: unknown) => void);
    return () => {
      w.__sanctumWsListeners = (w.__sanctumWsListeners ?? []).filter(h => h !== (handler as (m: unknown) => void));
    };
  }, [load]);

  const setMode = async (mode: WatchtowerMode) => {
    if (!config || saving || mode === config.mode) return;
    const previous = config;
    setConfig({ ...config, mode }); // optimistic — the dial should feel instant
    setSaving(true);
    try {
      const res = await fetch(`${base}/api/orchestrator/watchtower`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (res.ok) {
        const data = await res.json() as WatchtowerConfigResponse & { success: boolean };
        setConfig({ mode: data.mode, lastFiredDate: data.lastFiredDate });
      } else {
        setConfig(previous);
      }
    } catch { setConfig(previous); }
    finally { setSaving(false); }
  };

  return (
    <>
      <Eyebrow label="watchtower" />
      <Card>
        <p className="wtw-blurb">
          When you’ve been away a while, the companion gets the chance — never the
          obligation — to reach.
        </p>

        {loading ? (
          <div className="wtw-loading"><Spinner /></div>
        ) : (
          <>
            <div className="wtw-seg" role="radiogroup" aria-label="Watchtower mode">
              {WATCHTOWER_MODES.map(m => {
                const active = config?.mode === m.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`wtw-seg-btn${active ? ' active' : ''}`}
                    onClick={() => setMode(m.key)}
                    disabled={saving && !active}
                  >
                    <span className="wtw-seg-label">{m.label}</span>
                    <span className="wtw-seg-sub">{m.sub}</span>
                  </button>
                );
              })}
            </div>
            <p className="wtw-meta">
              last reached: {lastReachedText(config?.lastFiredDate ?? null)}
            </p>
          </>
        )}
      </Card>

      <style>{`
        .wtw-blurb {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.8125rem;
          line-height: 1.55;
          color: var(--text-secondary, #a09689);
          margin: 0 0 0.875rem;
        }
        .wtw-loading { display: flex; justify-content: center; padding: 0.75rem 0; }

        .wtw-seg {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.375rem;
        }
        .wtw-seg-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.1875rem;
          padding: 0.5625rem 0.5rem 0.5rem;
          border-radius: 0.5rem;
          border: 1px solid rgba(255,255,255,0.09);
          background: transparent;
          cursor: pointer;
          font-family: inherit;
          transition: background 150ms ease, border-color 150ms ease;
        }
        .wtw-seg-btn:hover { border-color: rgba(255,255,255,0.14); }
        .wtw-seg-btn.active {
          background: rgba(201,168,124,0.12);
          border-color: rgba(201,168,124,0.30);
        }
        .wtw-seg-btn:active:not(:disabled) { transform: scale(0.99); }
        .wtw-seg-btn:disabled { cursor: default; opacity: 0.6; }

        .wtw-seg-label {
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
          transition: color 150ms ease;
        }
        .wtw-seg-btn.active .wtw-seg-label { color: var(--amber-bright, #e3c49a); }

        .wtw-seg-sub {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          text-align: center;
          line-height: 1.35;
        }
        .wtw-seg-btn.active .wtw-seg-sub { color: var(--text-secondary, #a09689); }

        .wtw-meta {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: var(--text-muted, #6a6258);
          margin: 0.75rem 0 0;
        }

        @media (max-width: 480px) {
          .wtw-seg { grid-template-columns: 1fr; }
          .wtw-seg-btn { flex-direction: row; justify-content: space-between; gap: 0.5rem; }
          .wtw-seg-sub { text-align: right; }
        }
      `}</style>
    </>
  );
}

// ─── Pending Panel — ad-hoc timers + watchers/impulses the companion has set ─

interface PendingTimer {
  id: string;
  label: string;
  context: string | null;
  fire_at: string;     // ISO
  thread_id: string;
  prompt: string | null;
  // 'waiting' = fire time passed but the agent was busy — it retries each
  // tick until a free moment.
  status: 'pending' | 'waiting';
  created_at: string;
  fired_at: string | null;
}

interface PendingTrigger {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: string;  // JSON array of TriggerCondition
  prompt: string | null;
  thread_id: string | null;
  cooldown_minutes: number;
  // 'paused' = parked from this editor; listed but never evaluated.
  status: 'pending' | 'waiting' | 'paused';
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  fired_at: string | null;
}

// Loose record type — conditions arrive as deserialized JSON from db.ts
type CondObj = Record<string, unknown> & { type: string };

/** Convert "HH:MM" (24h) → "9:00am" */
function toAmPm(hhmm: string): string {
  const [hh = '0', mm = '0'] = hhmm.split(':');
  const h = parseInt(hh, 10);
  const m = parseInt(mm, 10);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

function renderOneCondition(c: CondObj): string {
  // Compound conditions: the top-level chip list joins with ' · ' (AND);
  // inside a compound we join with ' or ' / ' and ', parenthesized so the
  // outer ' · ' stays readable. One level of nesting renders naturally.
  if (c.type === 'compound_or' || c.type === 'compound_and') {
    const subs = Array.isArray(c['conditions']) ? (c['conditions'] as CondObj[]) : [];
    if (subs.length === 0) return c.type === 'compound_or' ? '[any of — empty]' : '[all of — empty]';
    const inner = subs.map(renderOneCondition).join(c.type === 'compound_or' ? ' or ' : ' and ');
    return subs.length > 1 ? `(${inner})` : inner;
  }

  if (c.type === 'agent_free') return 'Companion is free';

  if (c.type === 'presence_state') {
    const state = c['state'] as string;
    const map: Record<string, string> = {
      active: "you're active",
      idle:   "you're idle",
      offline: "you're offline",
    };
    return map[state] ?? `you are ${state}`;
  }

  if (c.type === 'presence_transition') {
    return `you move from ${c['from']} to ${c['to']}`;
  }

  if (c.type === 'time_window') {
    const after  = c['after']  as string;
    const before = c['before'] as string | undefined;
    return before
      ? `between ${toAmPm(after)} and ${toAmPm(before)}`
      : `after ${toAmPm(after)}`;
  }

  if (c.type === 'routine_missing') {
    const routine = (c['routine'] as string).replace(/_/g, ' ');
    const afterHour = c['after_hour'] as number;
    const hStr =
      afterHour === 0  ? 'midnight' :
      afterHour < 12   ? `${afterHour}am` :
      afterHour === 12 ? 'noon' :
                         `${afterHour - 12}pm`;
    return `${routine} hasn't happened by ${hStr}`;
  }

  if (c.type === 'care_missing') {
    const category = String(c['category'] ?? 'care').replace(/_/g, ' ');
    return `no ${category} logged by ${toAmPm(c['after'] as string)}`;
  }

  if (c.type === 'calendar_within') {
    const mins = c['minutes'] as number;
    return mins >= 60 && mins % 60 === 0
      ? `a calendar event within ${mins / 60}h`
      : `a calendar event within ${mins}m`;
  }

  if (c.type === 'sleep_below') {
    const mins = c['minutes'] as number;
    const hrs = mins / 60;
    const hStr = Number.isInteger(hrs) ? String(hrs) : hrs.toFixed(1);
    return `sleep under ${hStr}h`;
  }

  if (c.type === 'routine_due') {
    const routineId = c['routineId'] as string | undefined;
    const grace = c['grace_min'] as number | undefined;
    const who = routineId ? String(routineId).replace(/_/g, ' ') : 'any routine';
    return grace ? `${who} past its window by ${grace}m` : `${who} past its window`;
  }

  return `[${c.type}]`;
}

/** Human strings, one per condition — a compound trigger yields several. */
function renderConditionList(conditionsJson: string): string[] {
  try {
    const arr = JSON.parse(conditionsJson) as CondObj[];
    if (!Array.isArray(arr)) return [];
    return arr.map(renderOneCondition);
  } catch {
    return [];
  }
}

function renderConditions(conditionsJson: string): string {
  const parts = renderConditionList(conditionsJson);
  if (parts.length === 0) return '';
  return 'when ' + parts.join(' · ');
}

/** "in 2h" / "tomorrow at 9:00am" / "Mon at 9:00am" / "in 5d" */
function relativeFireAt(iso: string): string {
  const d    = new Date(iso);
  const diff = d.getTime() - Date.now();
  if (diff < 0) return 'overdue';

  const totalMins = Math.floor(diff / 60000);
  if (totalMins < 2)  return 'any moment';
  if (totalMins < 60) return `in ${totalMins}m`;

  const totalHrs = Math.floor(totalMins / 60);
  if (totalHrs < 24)  return `in ${totalHrs}h`;

  // Compute 12h time string for the target date
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const time12 = `${h12}:${String(m).padStart(2, '0')}${suffix}`;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time12}`;

  const totalDays = Math.floor(totalHrs / 24);
  if (totalDays < 7) {
    const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    return `${dayName} at ${time12}`;
  }
  return `in ${totalDays}d`;
}

/** Absolute fire time for the title tooltip */
function absoluteFireAt(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// ── Timer row ──────────────────────────────────────────────────────────────────

/** Split an ISO datetime into local "YYYY-MM-DD" + "HH:MM" for the pickers */
function isoToLocalParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Local "YYYY-MM-DD" + "HH:MM" → ISO (null when the date is unparseable) */
function localPartsToIso(date: string, time: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!dm || !tm) return null;
  const d = new Date(
    Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]),
    Number(tm[1]), Number(tm[2]),
  );
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function PendingTimerRow({
  timer,
  cancelling,
  onCancel,
  expanded,
  onToggleExpand,
  onReschedule,
  rescheduling,
}: {
  timer: PendingTimer;
  cancelling: boolean;
  onCancel: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
  onReschedule: (fireAtIso: string) => Promise<void>;
  rescheduling: boolean;
}) {
  const rel = relativeFireAt(timer.fire_at);
  const abs = absoluteFireAt(timer.fire_at);
  const isWaiting = timer.status === 'waiting';

  const initial = isoToLocalParts(timer.fire_at);
  const [draftDate, setDraftDate] = useState(initial.date);
  const [draftTime, setDraftTime] = useState(initial.time);
  const [saveError, setSaveError] = useState(false);

  // Re-seed the pickers whenever the row opens (fire_at may have changed)
  useEffect(() => {
    if (expanded) {
      const parts = isoToLocalParts(timer.fire_at);
      setDraftDate(parts.date);
      setDraftTime(parts.time);
      setSaveError(false);
    }
  }, [expanded, timer.fire_at]);

  const draftIso = localPartsToIso(draftDate, draftTime);
  const isDirty = draftIso !== null && draftIso !== new Date(timer.fire_at).toISOString();

  const handleSave = async () => {
    if (!draftIso) return;
    setSaveError(false);
    try {
      await onReschedule(draftIso);
    } catch {
      setSaveError(true);
    }
  };

  return (
    <div className={`pend-row${expanded ? ' pend-row--open' : ''}`} title={expanded ? undefined : abs}>
      <div className="pend-row-top">
        <button
          className="pend-expand-toggle"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Reschedule'} timer: ${timer.label}`}
        >
          <span className="pend-kind-tag pend-kind-timer" aria-hidden>TIMER</span>
          <span className="pend-label">{timer.label}</span>
        </button>
        {isWaiting ? (
          <span className="pend-waiting">waiting for a free moment</span>
        ) : (
          <span className="pend-rel-time">{rel}</span>
        )}
        <button
          className="pend-cancel-btn"
          onClick={onCancel}
          disabled={cancelling}
          aria-label={`Cancel timer: ${timer.label}`}
        >
          {cancelling ? <Spinner /> : '×'}
        </button>
      </div>
      <div className="pend-row-meta">
        <span className="pend-abs-time">{abs}</span>
        {timer.context && (
          <>
            <span className="pend-meta-dot" aria-hidden>·</span>
            <span className="pend-ctx">{timer.context}</span>
          </>
        )}
      </div>

      {expanded && (
        <div className="pend-edit-body">
          <div className="pend-resched-fields">
            <HearthDatePicker
              value={draftDate}
              onChange={setDraftDate}
              ariaLabel={`New date for ${timer.label}`}
            />
            <HearthTimePicker
              value={draftTime}
              onChange={setDraftTime}
              compact
            />
          </div>
          {isWaiting && (
            <p className="pend-edit-hint">
              This one already came due while the companion was mid-thought — a new time
              gives it a fresh moment.
            </p>
          )}
          <div className="pend-edit-actions">
            {saveError && <span className="pend-edit-error">couldn’t move it — try again</span>}
            <Btn variant="muted" onClick={onToggleExpand} disabled={rescheduling}>cancel</Btn>
            <button
              className="sysprompt-save"
              onClick={handleSave}
              disabled={!isDirty || rescheduling}
            >
              {rescheduling ? <Spinner /> : 'move it'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Trigger row ────────────────────────────────────────────────────────────────

interface TriggerEditFields {
  label?: string;
  prompt?: string | null;
  cooldownMinutes?: number;
}

function PendingTriggerRow({
  trigger,
  cancelling,
  onCancel,
  expanded,
  onToggleExpand,
  onSave,
  onTogglePause,
  saving,
  pausing,
}: {
  trigger: PendingTrigger;
  cancelling: boolean;
  onCancel: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
  onSave: (fields: TriggerEditFields) => Promise<void>;
  onTogglePause: () => Promise<void>;
  saving: boolean;
  pausing: boolean;
}) {
  const condText  = renderConditions(trigger.conditions);
  const condList  = renderConditionList(trigger.conditions);
  const isWatcher = trigger.kind === 'watcher';
  const isPaused  = trigger.status === 'paused';
  const isWaiting = trigger.status === 'waiting';
  const hasMeta   = condText || (isWatcher && trigger.cooldown_minutes > 0);

  const [draftLabel, setDraftLabel] = useState(trigger.label);
  const [draftPrompt, setDraftPrompt] = useState(trigger.prompt ?? '');
  const [draftCooldown, setDraftCooldown] = useState(trigger.cooldown_minutes);
  const [saveError, setSaveError] = useState(false);

  // Re-seed drafts whenever the editor opens (row may have refreshed)
  useEffect(() => {
    if (expanded) {
      setDraftLabel(trigger.label);
      setDraftPrompt(trigger.prompt ?? '');
      setDraftCooldown(trigger.cooldown_minutes);
      setSaveError(false);
    }
  }, [expanded, trigger.label, trigger.prompt, trigger.cooldown_minutes]);

  const isDirty =
    draftLabel.trim() !== trigger.label ||
    draftPrompt !== (trigger.prompt ?? '') ||
    draftCooldown !== trigger.cooldown_minutes;

  const stepCooldown = (dir: 1 | -1) => {
    setDraftCooldown(prev => Math.max(0, Math.min(10080, prev + dir * 15)));
  };

  const handleSave = async () => {
    if (!draftLabel.trim()) return;
    setSaveError(false);
    const fields: TriggerEditFields = {};
    if (draftLabel.trim() !== trigger.label) fields.label = draftLabel.trim();
    if (draftPrompt !== (trigger.prompt ?? '')) fields.prompt = draftPrompt === '' ? null : draftPrompt;
    if (draftCooldown !== trigger.cooldown_minutes) fields.cooldownMinutes = draftCooldown;
    try {
      await onSave(fields);
    } catch {
      setSaveError(true);
    }
  };

  return (
    <div className={`pend-row${expanded ? ' pend-row--open' : ''}${isPaused ? ' pend-row--paused' : ''}`}>
      <div className="pend-row-top">
        <button
          className="pend-expand-toggle"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Edit'} ${trigger.kind}: ${trigger.label}`}
        >
          <span className={`pend-kind-tag${isWatcher ? ' pend-kind-watcher' : ' pend-kind-impulse'}`}>
            {trigger.kind}
          </span>
          <span className="pend-label">{trigger.label}</span>
        </button>
        {isPaused && <span className="pend-paused-tag">paused</span>}
        {isWaiting && <span className="pend-waiting">waiting for a free moment</span>}
        {trigger.fire_count > 0 && (
          <span className="pend-fire-count">×{trigger.fire_count}</span>
        )}
        <button
          className="pend-cancel-btn"
          onClick={onCancel}
          disabled={cancelling}
          aria-label={`Cancel ${trigger.kind}: ${trigger.label}`}
        >
          {cancelling ? <Spinner /> : '×'}
        </button>
      </div>
      {hasMeta && !expanded && (
        <div className="pend-row-meta">
          {condText && <span className="pend-conditions">{condText}</span>}
          {isWatcher && trigger.cooldown_minutes > 0 && (
            <>
              {condText && <span className="pend-meta-dot" aria-hidden>·</span>}
              <span className="pend-cooldown">{trigger.cooldown_minutes}m cooldown</span>
            </>
          )}
        </div>
      )}

      {expanded && (
        <div className="pend-edit-body">
          {/* Conditions — read-only, rendered human */}
          {condList.length > 0 && (
            <div className="pend-cond-summary">
              <span className="pend-edit-label">listens for</span>
              <div className="pend-cond-list">
                {condList.map((c, i) => (
                  <span key={i} className="pend-cond-chip">{c}</span>
                ))}
              </div>
              <span className="pend-edit-hint">
                Conditions are Simon’s to shape — editable from his side, read-only here.
              </span>
            </div>
          )}

          <div className="pend-edit-field">
            <span className="pend-edit-label">label</span>
            <input
              className="sp-form-input"
              value={draftLabel}
              onChange={e => setDraftLabel(e.target.value)}
              spellCheck={false}
              aria-label={`Label for ${trigger.kind}`}
            />
          </div>

          <div className="pend-edit-field">
            <span className="pend-edit-label">prompt</span>
            <textarea
              className="pend-prompt-textarea"
              value={draftPrompt}
              onChange={e => setDraftPrompt(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder="what the companion hears when this fires…"
              aria-label={`Prompt for ${trigger.kind}`}
            />
          </div>

          <div className="pend-edit-field">
            <span className="pend-edit-label">cooldown</span>
            <div className="pend-cooldown-stepper">
              <button
                type="button"
                className="pend-step-btn"
                onClick={() => stepCooldown(-1)}
                disabled={draftCooldown <= 0}
                aria-label="Decrease cooldown by 15 minutes"
              >
                −
              </button>
              <input
                className="pend-step-value"
                value={draftCooldown}
                onChange={e => {
                  const n = parseInt(e.target.value, 10);
                  setDraftCooldown(isNaN(n) ? 0 : Math.max(0, Math.min(10080, n)));
                }}
                inputMode="numeric"
                aria-label="Cooldown minutes"
              />
              <span className="pend-step-unit">min</span>
              <button
                type="button"
                className="pend-step-btn"
                onClick={() => stepCooldown(1)}
                disabled={draftCooldown >= 10080}
                aria-label="Increase cooldown by 15 minutes"
              >
                +
              </button>
            </div>
            <span className="pend-edit-hint">quiet time between fires</span>
          </div>

          <div className="pend-edit-actions">
            {saveError && <span className="pend-edit-error">couldn’t save — try again</span>}
            <button
              type="button"
              className={`pend-pause-btn${isPaused ? ' pend-pause-btn--resume' : ''}`}
              onClick={onTogglePause}
              disabled={pausing}
              aria-label={isPaused ? 'Resume this watcher' : 'Pause this watcher'}
            >
              {pausing ? <Spinner /> : (isPaused ? 'resume' : 'pause')}
            </button>
            <div className="pend-edit-spacer" />
            <Btn variant="muted" onClick={onToggleExpand} disabled={saving}>close</Btn>
            <button
              className="sysprompt-save"
              onClick={handleSave}
              disabled={!isDirty || !draftLabel.trim() || saving}
            >
              {saving ? <Spinner /> : 'save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pending panel (self-contained, like HandoffCard) ───────────────────────────

function PendingPanel({ base }: { base: string }) {
  const [timers,   setTimers]   = useState<PendingTimer[]>([]);
  const [triggers, setTriggers] = useState<PendingTrigger[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  // One row open at a time — "t:<id>" (timer) or "tr:<id>" (trigger)
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [pausingRow, setPausingRow] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [tRes, trRes] = await Promise.all([
        fetch(`${base}/api/orchestrator/timers`),
        fetch(`${base}/api/orchestrator/triggers`),
      ]);
      const nextTimers:   PendingTimer[]   = [];
      const nextTriggers: PendingTrigger[] = [];
      if (tRes.ok) {
        const d = await tRes.json() as { timers?: PendingTimer[] };
        if (Array.isArray(d.timers)) nextTimers.push(...d.timers);
      }
      if (trRes.ok) {
        const d = await trRes.json() as { triggers?: PendingTrigger[] };
        if (Array.isArray(d.triggers)) nextTriggers.push(...d.triggers);
      }
      setTimers(nextTimers);
      setTriggers(nextTriggers);
    } catch { /* backend not reachable */ }
    finally { setLoading(false); }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  // orchestrator_update WS ripple — timer/trigger mutations and daemon
  // transitions (fired, waiting) refresh the pending list live.
  useEffect(() => {
    const handler = (msg: { type?: string; what?: string }) => {
      if (msg?.type !== 'orchestrator_update') return;
      if (msg.what === 'timers' || msg.what === 'triggers') void load();
    };
    const w = window as unknown as { __sanctumWsListeners?: Array<(m: unknown) => void> };
    if (!w.__sanctumWsListeners) w.__sanctumWsListeners = [];
    w.__sanctumWsListeners.push(handler as (m: unknown) => void);
    return () => {
      w.__sanctumWsListeners = (w.__sanctumWsListeners ?? []).filter(h => h !== (handler as (m: unknown) => void));
    };
  }, [load]);

  const cancelTimer = async (id: string) => {
    const key = `t:${id}`;
    setCancelling(prev => new Set([...prev, key]));
    try {
      const res = await fetch(
        `${base}/api/orchestrator/timers/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (res.ok) await load();
    } catch { /* ignore */ }
    setCancelling(prev => { const s = new Set(prev); s.delete(key); return s; });
  };

  const cancelTrigger = async (id: string) => {
    const key = `tr:${id}`;
    setCancelling(prev => new Set([...prev, key]));
    try {
      const res = await fetch(
        `${base}/api/orchestrator/triggers/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (res.ok) await load();
    } catch { /* ignore */ }
    setCancelling(prev => { const s = new Set(prev); s.delete(key); return s; });
  };

  const rescheduleTimer = async (id: string, fireAtIso: string) => {
    const key = `t:${id}`;
    setSavingRow(key);
    try {
      const res = await fetch(
        `${base}/api/orchestrator/timers/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fireAt: fireAtIso }),
        },
      );
      if (!res.ok) throw new Error('reschedule failed');
      await load();
      setExpandedRow(null);
    } finally {
      setSavingRow(null);
    }
  };

  const saveTrigger = async (id: string, fields: TriggerEditFields) => {
    const key = `tr:${id}`;
    setSavingRow(key);
    try {
      const res = await fetch(
        `${base}/api/orchestrator/triggers/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        },
      );
      if (!res.ok) throw new Error('save failed');
      await load();
    } finally {
      setSavingRow(null);
    }
  };

  const togglePauseTrigger = async (trigger: PendingTrigger) => {
    const key = `tr:${trigger.id}`;
    setPausingRow(key);
    try {
      const res = await fetch(
        `${base}/api/orchestrator/triggers/${encodeURIComponent(trigger.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: trigger.status === 'paused' ? 'pending' : 'paused' }),
        },
      );
      if (res.ok) await load();
    } catch { /* ignore */ }
    finally { setPausingRow(null); }
  };

  const toggleRow = (key: string) => {
    setExpandedRow(prev => (prev === key ? null : key));
  };

  const hasAny = timers.length > 0 || triggers.length > 0;

  return (
    <>
      <Eyebrow label="pending" sub="what the companion has set" />

      {loading ? (
        <div className="pend-loading"><Spinner /></div>
      ) : !hasAny ? (
        <p className="pend-empty">nothing pending</p>
      ) : (
        <div className="pend-list">
          {timers.map(t => (
            <PendingTimerRow
              key={t.id}
              timer={t}
              cancelling={cancelling.has(`t:${t.id}`)}
              onCancel={() => cancelTimer(t.id)}
              expanded={expandedRow === `t:${t.id}`}
              onToggleExpand={() => toggleRow(`t:${t.id}`)}
              onReschedule={iso => rescheduleTimer(t.id, iso)}
              rescheduling={savingRow === `t:${t.id}`}
            />
          ))}
          {triggers.map(tr => (
            <PendingTriggerRow
              key={tr.id}
              trigger={tr}
              cancelling={cancelling.has(`tr:${tr.id}`)}
              onCancel={() => cancelTrigger(tr.id)}
              expanded={expandedRow === `tr:${tr.id}`}
              onToggleExpand={() => toggleRow(`tr:${tr.id}`)}
              onSave={fields => saveTrigger(tr.id, fields)}
              onTogglePause={() => togglePauseTrigger(tr)}
              saving={savingRow === `tr:${tr.id}`}
              pausing={pausingRow === `tr:${tr.id}`}
            />
          ))}
        </div>
      )}

      <style>{`
        .pend-loading {
          display: flex;
          justify-content: center;
          padding: 0.75rem 0;
        }

        .pend-empty {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.875rem;
          color: var(--text-muted, #6a6258);
          margin: 0;
          padding: 0.125rem 0;
        }

        .pend-list {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        /* ── Row shell ── */
        .pend-row {
          padding: 0.5625rem 0.75rem;
          background: rgba(255,255,255,0.015);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 0.5rem;
          display: flex;
          flex-direction: column;
          gap: 0.1875rem;
          transition: border-color 160ms ease;
        }
        .pend-row:hover { border-color: rgba(255,255,255,0.09); }

        /* ── Top line ── */
        .pend-row-top {
          display: flex;
          align-items: center;
          gap: 0.4375rem;
          min-width: 0;
        }

        /* ── Kind tags ── */
        .pend-kind-tag {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 0.0625rem 0.3125rem;
          border-radius: 0.1875rem;
          border: 1px solid;
          flex-shrink: 0;
          line-height: 1.4;
          user-select: none;
        }
        .pend-kind-timer {
          color: var(--text-muted);
          border-color: rgba(201,168,124,0.18);
          background: rgba(201,168,124,0.06);
        }
        .pend-kind-watcher {
          color: rgba(168,147,192,0.60);
          border-color: rgba(168,147,192,0.20);
          background: rgba(168,147,192,0.06);
        }
        .pend-kind-impulse {
          color: rgba(94,171,165,0.60);
          border-color: rgba(94,171,165,0.18);
          background: rgba(94,171,165,0.06);
        }

        .pend-label {
          flex: 1;
          font-size: 0.875rem;
          color: var(--text-primary, #e2dbd0);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }

        .pend-rel-time {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.6875rem;
          color: var(--amber, #c9a87c);
          letter-spacing: 0.03em;
          flex-shrink: 0;
          white-space: nowrap;
        }

        .pend-fire-count {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          color: var(--text-muted, #6a6258);
          letter-spacing: 0.04em;
          flex-shrink: 0;
        }

        /* ── Cancel — hidden until row hover; always visible on touch ── */
        .pend-cancel-btn {
          opacity: 0;
          background: none;
          border: none;
          color: var(--text-muted, #6a6258);
          font-size: 0.9375rem;
          line-height: 1;
          width: 1.25rem;
          height: 1.25rem;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 0.25rem;
          cursor: pointer;
          flex-shrink: 0;
          transition: opacity 160ms ease, color 100ms ease, transform 100ms ease;
        }
        .pend-row:hover .pend-cancel-btn { opacity: 1; }
        .pend-cancel-btn:hover  { color: var(--status-error-text); }
        .pend-cancel-btn:active { transform: scale(0.985) translateY(0.5px); }
        .pend-cancel-btn:disabled { opacity: 0.4 !important; cursor: default; }
        /* Touch devices — always visible since no :hover */
        @media (pointer: coarse) {
          .pend-cancel-btn { opacity: 0.5; }
        }

        /* ── Meta line ── */
        .pend-row-meta {
          display: flex;
          align-items: baseline;
          gap: 0.375rem;
          flex-wrap: wrap;
          overflow: hidden;
        }

        .pend-abs-time {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5625rem;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-muted, #6a6258);
          opacity: 0.55;
          transition: opacity 160ms ease;
          flex-shrink: 0;
          white-space: nowrap;
        }
        .pend-row:hover .pend-abs-time { opacity: 1; }

        .pend-meta-dot {
          font-size: 0.5625rem;
          color: var(--text-muted, #6a6258);
          opacity: 0.35;
          flex-shrink: 0;
        }

        .pend-ctx {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.75rem;
          color: var(--text-muted, #6a6258);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }

        .pend-conditions {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.75rem;
          color: var(--text-secondary, #a09689);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }

        .pend-cooldown {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5rem;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--text-muted, #6a6258);
          flex-shrink: 0;
          white-space: nowrap;
        }

        /* ── Expandable rows (edit + reschedule) ── */
        .pend-row--open { border-color: rgba(201,168,124,0.18); }
        .pend-row--paused { opacity: 0.6; }
        .pend-row--paused.pend-row--open { opacity: 1; }

        .pend-expand-toggle {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 0.4375rem;
          background: none;
          border: none;
          padding: 0;
          cursor: pointer;
          text-align: left;
          min-width: 0;
          font-family: inherit;
        }

        .pend-waiting {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.75rem;
          color: var(--amber, #c9a87c);
          flex-shrink: 0;
          white-space: nowrap;
        }

        .pend-paused-tag {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 0.0625rem 0.3125rem;
          border-radius: 0.1875rem;
          border: 1px solid rgba(106,98,88,0.30);
          color: var(--text-muted, #6a6258);
          background: rgba(106,98,88,0.08);
          flex-shrink: 0;
          line-height: 1.4;
        }

        .pend-edit-body {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          margin-top: 0.5rem;
          padding-top: 0.75rem;
          border-top: 1px solid rgba(255,255,255,0.05);
          animation: slideDown 160ms ease both;
        }

        .pend-edit-field {
          display: flex;
          flex-direction: column;
          gap: 0.3125rem;
        }

        .pend-edit-label {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-muted, #6a6258);
        }

        .pend-edit-hint {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.6875rem;
          color: var(--text-muted, #6a6258);
          margin: 0;
          line-height: 1.45;
        }

        .pend-edit-error {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.75rem;
          color: var(--status-error-text);
        }

        /* Prompt — Lora, the voice the companion hears */
        .pend-prompt-textarea {
          width: 100%;
          box-sizing: border-box;
          resize: vertical;
          min-height: 5rem;
          background: rgba(12, 11, 9, 0.6);
          border: 1px solid rgba(201, 168, 124, 0.14);
          border-radius: 0.5rem;
          padding: 0.625rem 0.75rem;
          color: var(--text-primary, #e2dbd0);
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.8125rem;
          line-height: 1.55;
          transition: border-color 240ms ease;
        }
        .pend-prompt-textarea:focus {
          outline: none;
          border-color: rgba(201, 168, 124, 0.45);
          box-shadow: 0 0 0 3px rgba(201, 168, 124, 0.07);
        }
        .pend-prompt-textarea::placeholder {
          color: var(--text-muted, #6a6258);
          font-style: italic;
        }

        /* Cooldown stepper — mono digits, hearth affordances */
        .pend-cooldown-stepper {
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          background: rgba(12, 11, 9, 0.6);
          border: 1px solid rgba(201, 168, 124, 0.14);
          border-radius: 0.5rem;
          padding: 0.25rem 0.375rem;
          width: fit-content;
        }
        .pend-step-btn {
          width: 1.5rem;
          height: 1.5rem;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 0.3125rem;
          color: var(--text-secondary, #a09689);
          font-size: 0.875rem;
          line-height: 1;
          cursor: pointer;
          transition: background 100ms ease, color 100ms ease, transform 100ms ease;
        }
        .pend-step-btn:hover:not(:disabled) {
          background: rgba(201,168,124,0.10);
          color: var(--amber-bright, #e3c49a);
        }
        .pend-step-btn:active:not(:disabled) { transform: scale(0.95); }
        .pend-step-btn:disabled { opacity: 0.35; cursor: default; }
        .pend-step-value {
          width: 3.25rem;
          background: none;
          border: none;
          text-align: center;
          color: var(--text-primary, #e2dbd0);
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8125rem;
          font-variant-numeric: tabular-nums;
        }
        .pend-step-value:focus { outline: none; }
        .pend-step-unit {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-muted, #6a6258);
          padding-right: 0.125rem;
        }

        /* Conditions summary — read-only chips */
        .pend-cond-summary {
          display: flex;
          flex-direction: column;
          gap: 0.3125rem;
        }
        .pend-cond-list {
          display: flex;
          flex-wrap: wrap;
          gap: 0.3125rem;
        }
        .pend-cond-chip {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.75rem;
          color: var(--text-secondary, #a09689);
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 0.375rem;
          padding: 0.1875rem 0.5rem;
          line-height: 1.4;
        }

        /* Pause / resume */
        .pend-pause-btn {
          font-size: 0.75rem;
          font-family: inherit;
          padding: 0.3125rem 0.75rem;
          border-radius: 0.4375rem;
          border: 1px solid rgba(106,98,88,0.35);
          background: transparent;
          color: var(--text-secondary, #a09689);
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 0.375rem;
          transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
        }
        .pend-pause-btn:hover:not(:disabled) {
          border-color: rgba(106,98,88,0.55);
          color: var(--text-primary, #e2dbd0);
        }
        .pend-pause-btn--resume {
          border-color: rgba(201,168,124,0.30);
          color: var(--amber, #c9a87c);
        }
        .pend-pause-btn--resume:hover:not(:disabled) {
          border-color: rgba(201,168,124,0.50);
          color: var(--amber-bright, #e3c49a);
        }
        .pend-pause-btn:disabled { opacity: 0.5; cursor: default; }

        .pend-edit-actions {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .pend-edit-spacer { flex: 1; }

        /* Timer reschedule — date + time side by side */
        .pend-resched-fields {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
        }

        /* Mobile: let conditions wrap rather than truncate */
        @media (max-width: 480px) {
          .pend-ctx,
          .pend-conditions { white-space: normal; }
          .pend-waiting { white-space: normal; }
        }
      `}</style>
    </>
  );
}

// ─── OrchestratorSection ──────────────────────────────────────────────────────

/* Desktop floor (>=769px): body text >= 14px, pills/badges >= 12px. Phone sizes untouched. */
const ORCH_DESKTOP_FLOOR_CSS = `
@media (min-width: 769px) {
  .settings-view .wt-row-hint,
  .settings-view .wt-del-confirm-msg,
  .settings-view .del-confirm-msg,
  .settings-view .sch-complex-note,
  .settings-view .sch-cron-code,
  .settings-view .sch-summary-label,
  .settings-view .sch-summary-cron,
  .settings-view .wake-cron,
  .settings-view .wake-cron-summary,
  .settings-view .wake-next,
  .settings-view .handoff-blurb,
  .settings-view .handoff-meta-v,
  .settings-view .handoff-msg,
  .settings-view .wtw-blurb,
  .settings-view .wtw-seg-label,
  .settings-view .wtw-seg-sub,
  .settings-view .pend-rel-time,
  .settings-view .pend-abs-time,
  .settings-view .pend-ctx,
  .settings-view .pend-conditions,
  .settings-view .pend-waiting,
  .settings-view .pend-edit-hint,
  .settings-view .pend-edit-error,
  .settings-view .pend-prompt-textarea,
  .settings-view .pend-step-value,
  .settings-view .orch-status-msg,
  .settings-view .orch-error-msg,
  .settings-view .sysprompt-textarea,
  .settings-view .sysprompt-save,
  .settings-view .pend-pause-btn { font-size: 14px; }
  .settings-view .sch-day-btn { font-size: 13px; }
  .settings-view .wt-row-type,
  .settings-view .wt-row-label,
  .settings-view .wake-label,
  .settings-view .pend-label { font-size: 14px; }
  .settings-view .wt-scheduled-pip,
  .settings-view .pend-cooldown,
  .settings-view .handoff-meta-k,
  .settings-view .wtw-meta { font-size: 13px; }
  .settings-view .wt-row-chevron,
  .settings-view .sch-freq-pill,
  .settings-view .wake-running-badge,
  .settings-view .wake-model-pill,
  .settings-view .wake-target-pill,
  .settings-view .pend-kind-tag,
  .settings-view .pend-paused-tag,
  .settings-view .pend-cond-chip,
  .settings-view .pend-fire-count,
  .settings-view .pend-meta-dot,
  .settings-view .pend-edit-label,
  .settings-view .pend-step-unit { font-size: 12px; }
}
`;

/** Advanced: the directory the scheduled wakes read their prompt files from (PUT /api/preferences, as before). */
function WakePromptsPath({ base }: { base: string }) {
  const { draft, patchDraft, saveAll, saveStatus, saveError, dirty } = usePreferences(base);
  if (!draft) return null;
  return (
    <>
      <style>{PREFS_CSS}</style>
      <Eyebrow label="wake prompts folder" />
      <Group>
        <div className="prefs-form-block">
          <TextField
            label="wake prompts path"
            value={draft.orchestrator.wake_prompts_path ?? ''}
            onChange={v => patchDraft({ orchestrator: { ...draft.orchestrator, wake_prompts_path: v } })}
            mono
            hint="Directory containing .md prompt files for scheduled wakes"
          />
        </div>
      </Group>
      <PrefsSaveBar saveStatus={saveStatus} saveError={saveError} dirty={dirty} onSave={() => void saveAll()} />
    </>
  );
}

export function OrchestratorSection({ base }: { base: string }) {
  // ── Part A state ──
  const [wakeTypes, setWakeTypes] = useState<WakeTypeRecord[]>([]);
  const [wtLoading, setWtLoading] = useState(true);
  const [expandedType, setExpandedType] = useState<string | null>(null);
  const [wtSaving, setWtSaving] = useState<string | null>(null);   // type being saved
  const [wtDeleting, setWtDeleting] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newSubmitting, setNewSubmitting] = useState(false);
  const [wtDeleteConfirm, setWtDeleteConfirm] = useState<string | null>(null);

  // ── Part B state ──
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [scheduleEditing, setScheduleEditing] = useState<ScheduledTask | null | 'new'>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleDeleteConfirm, setScheduleDeleteConfirm] = useState<string | null>(null);
  const [scheduleDeleting, setScheduleDeleting] = useState<string | null>(null);
  const [toggleActionId, setToggleActionId] = useState<string | null>(null);

  // ── Shared models catalog (loaded once for the task rows) ──
  const [modelsData, setModelsData] = useState<ModelsResponse | null>(null);

  // ── Shared thread list (loaded once for the task rows — target resolution) ──
  const [rowThreads, setRowThreads] = useState<ThreadEntry[]>([]);

  // ── Global ──
  const [orchestratorEnabled, setOrchestratorEnabled] = useState(true);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function showMsg(msg: string, isErr = false) {
    if (isErr) { setErrorMsg(msg); setStatusMsg(null); }
    else { setStatusMsg(msg); setErrorMsg(null); }
    setTimeout(() => { setStatusMsg(null); setErrorMsg(null); }, 3000);
  }

  // ── Loaders ──
  const loadWakeTypes = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/orchestrator/wake-types`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.wakeTypes)) setWakeTypes(data.wakeTypes);
    } catch { /* backend not up */ }
    finally { setWtLoading(false); }
  }, [base]);

  const loadTasks = useCallback(async () => {
    try {
      // Try /status first (new backend), fall back to /api/orchestrator
      const res = await fetch(`${base}/api/orchestrator/status`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.tasks)) {
          setTasks(data.tasks);
          if (typeof data.enabled === 'boolean') setOrchestratorEnabled(data.enabled);
        }
      } else {
        // Fallback
        const r2 = await fetch(`${base}/api/orchestrator`);
        if (r2.ok) {
          const data = await r2.json();
          if (Array.isArray(data.tasks)) {
            setTasks(data.tasks);
            if (typeof data.enabled === 'boolean') setOrchestratorEnabled(data.enabled);
          } else if (Array.isArray(data)) {
            setTasks(data);
          }
        }
      }
    } catch { /* backend not up */ }
    finally { setTasksLoading(false); }
  }, [base]);

  // Load models catalog once — shared between panel and rows
  const loadModels = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/models`);
      if (res.ok) {
        const data = await res.json() as ModelsResponse;
        if (data && Array.isArray(data.models)) setModelsData(data);
      }
    } catch { /* backend not up */ }
  }, [base]);

  // Load thread list once — shared for row target-name resolution
  const loadRowThreads = useCallback(async () => {
    try {
      const res = await fetch(`${base}/api/threads`);
      if (res.ok) {
        const data = await res.json() as { threads: ThreadEntry[] };
        if (data && Array.isArray(data.threads)) setRowThreads(data.threads);
      }
    } catch { /* backend not up */ }
  }, [base]);

  useEffect(() => {
    loadWakeTypes();
    loadTasks();
    loadModels();
    loadRowThreads();
  }, [loadWakeTypes, loadTasks, loadModels, loadRowThreads]);

  // orchestrator_update WS ripple — schedule mutations from `res` / the daemon
  // refetch the task list + scheduled indicators live (cc_update pattern).
  useEffect(() => {
    const handler = (msg: { type?: string; what?: string }) => {
      if (msg?.type !== 'orchestrator_update' || msg.what !== 'schedule') return;
      void loadTasks();
      void loadWakeTypes();
    };
    const w = window as unknown as { __sanctumWsListeners?: Array<(m: unknown) => void> };
    if (!w.__sanctumWsListeners) w.__sanctumWsListeners = [];
    w.__sanctumWsListeners.push(handler as (m: unknown) => void);
    return () => {
      w.__sanctumWsListeners = (w.__sanctumWsListeners ?? []).filter(h => h !== (handler as (m: unknown) => void));
    };
  }, [loadTasks, loadWakeTypes]);

  // ── Part A handlers ──
  const saveWakeTypeContent = async (type: string, content: string) => {
    setWtSaving(type);
    try {
      const res = await fetch(`${base}/api/orchestrator/wake-types/${encodeURIComponent(type)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Save failed');
      }
      // Update local state immediately — avoid full refetch on every keystroke save
      setWakeTypes(prev => prev.map(wt => wt.type === type ? { ...wt, content } : wt));
    } finally {
      setWtSaving(null);
    }
  };

  const createWakeType = async (type: string, content: string) => {
    setNewSubmitting(true);
    try {
      const res = await fetch(`${base}/api/orchestrator/wake-types`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, content }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Create failed');
      }
      setShowNewForm(false);
      await loadWakeTypes();
      showMsg(`Wake type "${prettifyType(type)}" created`);
    } finally {
      setNewSubmitting(false);
    }
  };

  const deleteWakeType = async (type: string) => {
    setWtDeleting(type);
    try {
      const res = await fetch(`${base}/api/orchestrator/wake-types/${encodeURIComponent(type)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setWakeTypes(prev => prev.filter(wt => wt.type !== type));
        await loadTasks(); // schedule may have been removed too
        showMsg('Wake type deleted');
      } else {
        showMsg('Delete failed', true);
      }
    } catch { showMsg('Delete failed', true); }
    finally { setWtDeleting(null); setWtDeleteConfirm(null); }
  };

  // ── Part B handlers ──
  // Receives model + target as third/fourth arguments.
  // model: omit from POST when empty ('' = use autonomous default).
  // target: always send; '@daily' = today's thread (backend default).
  const saveSchedule = async (wakeType: string, cronExpr: string, model: string, target: string) => {
    setScheduleSaving(true);
    try {
      const isNew = scheduleEditing === 'new';
      const body: Record<string, string> = { action: 'set_schedule', wakeType, cronExpr };
      // Only send model when a specific override is chosen
      if (model) body.model = model;
      // Always send target — backend treats '@daily' as the default
      body.target = target || '@daily';

      const res = await fetch(`${base}/api/orchestrator`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Schedule save failed');
      }
      await loadTasks();
      await loadWakeTypes(); // refresh scheduled indicators
      showMsg(isNew ? 'Schedule created' : 'Schedule updated');
      setScheduleEditing(null);
    } finally {
      setScheduleSaving(false);
    }
  };

  const toggleTask = async (wakeType: string, enabled: boolean) => {
    setToggleActionId(wakeType);
    try {
      const res = await fetch(`${base}/api/orchestrator/tasks/${encodeURIComponent(wakeType)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        setTasks(prev => prev.map(t => t.wakeType === wakeType ? { ...t, enabled } : t));
      } else {
        showMsg('Toggle failed', true);
      }
    } catch { showMsg('Toggle failed', true); }
    setToggleActionId(null);
  };

  const deleteSchedule = async (wakeType: string) => {
    setScheduleDeleting(wakeType);
    try {
      // remove_routine stops the task + clears its persisted schedule (keeps the type)
      const res = await fetch(`${base}/api/orchestrator`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove_routine', wakeType }),
      });
      if (res.ok) {
        setTasks(prev => prev.filter(t => t.wakeType !== wakeType));
        await loadWakeTypes(); // update scheduled indicators
        showMsg('Schedule removed');
      } else {
        showMsg('Remove failed', true);
      }
    } catch { showMsg('Remove failed', true); }
    finally { setScheduleDeleting(null); setScheduleDeleteConfirm(null); }
  };

  const toggleOrchestrator = async (enabled: boolean) => {
    try {
      const res = await fetch(`${base}/api/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orchestrator: { enabled } }),
      });
      if (res.ok) {
        setOrchestratorEnabled(enabled);
        showMsg(enabled ? 'Orchestrator enabled' : 'Orchestrator paused');
      }
    } catch { showMsg('Failed to toggle orchestrator', true); }
  };

  // ── Derived ──
  const enabledCount = tasks.filter(t => t.enabled).length;
  const runningCount = tasks.filter(t => t.status === 'running').length;

  return (
    <div className="orch-section">
      <style>{ORCH_DESKTOP_FLOOR_CSS}</style>

      {/* ── Master toggle ── */}
      <Eyebrow label="orchestrator" sub={`${enabledCount} / ${tasks.length} scheduled`} />
      <Group>
        <ToggleRow
          label="orchestrator enabled"
          checked={orchestratorEnabled}
          onChange={toggleOrchestrator}
          hint="Pause all scheduled wakes without deleting them"
        />
      </Group>

      {/* ═══════════════════════════════════════════════════════
          PART B — Friendly Scheduler (the "when")
      ═══════════════════════════════════════════════════════ */}

      <div className="orch-section-header">
        <Eyebrow label="schedule" sub={tasks.length > 0 ? `${tasks.length} active` : undefined} />
        {scheduleEditing === null && (
          <button
            className="sp-btn sp-btn-muted small"
            style={{ marginTop: '1.75rem', flexShrink: 0 }}
            onClick={() => setScheduleEditing('new')}
            disabled={wakeTypes.length === 0}
            title={wakeTypes.length === 0 ? 'Create a wake type first' : undefined}
          >
            + schedule
          </button>
        )}
      </div>

      {/* Inline schedule panel (new or edit) */}
      {scheduleEditing !== null && (
        <FriendlySchedulePanel
          wakeTypes={wakeTypes}
          existingTask={scheduleEditing === 'new' ? null : scheduleEditing}
          onSave={saveSchedule}
          onCancel={() => setScheduleEditing(null)}
          saving={scheduleSaving}
          base={base}
        />
      )}

      {tasksLoading ? (
        <div className="orch-loading"><Spinner /></div>
      ) : tasks.length === 0 && scheduleEditing === null ? (
        <EmptyState message="No schedules yet. Pick a wake type and set a time." />
      ) : (
        <div className="orch-task-list">
          {tasks.map(task => {
            const isDelConfirm = scheduleDeleteConfirm === task.wakeType;
            return (
              <React.Fragment key={task.wakeType}>
                {isDelConfirm ? (
                  <DeleteScheduleConfirm
                    label={task.label}
                    onConfirm={() => deleteSchedule(task.wakeType)}
                    onCancel={() => setScheduleDeleteConfirm(null)}
                    deleting={scheduleDeleting === task.wakeType}
                  />
                ) : (
                  <ScheduledTaskRow
                    task={task}
                    modelsData={modelsData}
                    threads={rowThreads}
                    onToggle={toggleTask}
                    onEdit={t => {
                      setScheduleEditing(t);
                      setScheduleDeleteConfirm(null);
                    }}
                    onDeleteSchedule={t => setScheduleDeleteConfirm(t)}
                    actionId={toggleActionId}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════
          Watchtower — the dial for the companion's chance to reach
      ═══════════════════════════════════════════════════════ */}
      <WatchtowerCard base={base} />

      {/* ═══════════════════════════════════════════════════════
          Pending — ad-hoc timers + watchers/impulses
      ═══════════════════════════════════════════════════════ */}
      <PendingPanel base={base} />

      {/* ═══════════════════════════════════════════════════════
          Daily Handoff — its own subagent, alongside the wakes
      ═══════════════════════════════════════════════════════ */}
      <HandoffCard base={base} />

      {/* ═══════════════════════════════════════════════════════
          Advanced — the wake-type manager and the stats; nothing here is deleted, it is folded away
      ═══════════════════════════════════════════════════════ */}
      <Disclosure title="advanced" sub="wake types and routines">
        <WakePromptsPath base={base} />
      {/* ═══════════════════════════════════════════════════════
          PART A — Wake Types (the "what")
      ═══════════════════════════════════════════════════════ */}

      <div className="orch-section-header">
        <Eyebrow label="wake types" sub={`${wakeTypes.length} defined`} />
        {!showNewForm && (
          <button
            className="sp-btn sp-btn-muted small"
            style={{ marginTop: '1.75rem', flexShrink: 0 }}
            onClick={() => setShowNewForm(true)}
          >
            + new type
          </button>
        )}
      </div>

      {wtLoading ? (
        <div className="orch-loading"><Spinner /></div>
      ) : (
        <div className="orch-wt-list">
          {wakeTypes.length === 0 && !showNewForm && (
            <EmptyState message="No wake types defined. Create one to give the orchestrator something to run." />
          )}

          {wakeTypes.map(wt => {
            const isDelConfirm = wtDeleteConfirm === wt.type;
            return (
              <React.Fragment key={wt.type}>
                {isDelConfirm ? (
                  <div className="wt-del-confirm-wrap">
                    <span className="wt-del-confirm-msg">
                      Delete <em>{wt.label || prettifyType(wt.type)}</em>? This removes the prompt and any schedule using it.
                    </span>
                    <div className="wt-del-confirm-actions">
                      <Btn variant="muted" onClick={() => setWtDeleteConfirm(null)} disabled={wtDeleting === wt.type}>keep it</Btn>
                      <Btn variant="danger" onClick={() => deleteWakeType(wt.type)} disabled={wtDeleting === wt.type}>
                        {wtDeleting === wt.type ? <Spinner /> : 'delete'}
                      </Btn>
                    </div>
                  </div>
                ) : (
                  <WakeTypeRow
                    wt={wt}
                    isExpanded={expandedType === wt.type}
                    onToggleExpand={() => setExpandedType(prev => prev === wt.type ? null : wt.type)}
                    onSaveContent={saveWakeTypeContent}
                    onDelete={t => setWtDeleteConfirm(t)}
                    saving={wtSaving === wt.type}
                    deleting={wtDeleting === wt.type}
                  />
                )}
              </React.Fragment>
            );
          })}

          {showNewForm && (
            <NewWakeTypeForm
              onSubmit={createWakeType}
              onCancel={() => setShowNewForm(false)}
              submitting={newSubmitting}
            />
          )}
        </div>
      )}

      {/* ── System stats ── */}
      {tasks.length > 0 && (
        <>
          <Eyebrow label="right now" />
          <div className="sp-stat-grid">
            <StatCard label="types"   value={wakeTypes.length} />
            <StatCard label="scheduled" value={tasks.length} />
            <StatCard label="enabled" value={enabledCount} />
            <StatCard label="running" value={runningCount} warn={runningCount > 0} />
          </div>
        </>
      )}

      </Disclosure>

      {/* ── Status / Error messages ── */}
      {statusMsg && <p className="orch-status-msg">{statusMsg}</p>}
      {errorMsg  && <p className="orch-error-msg">{errorMsg}</p>}

      <style>{`
        .orch-section { padding-bottom: 2rem; }

        .orch-section-header {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 0.5rem;
        }

        .orch-loading {
          display: flex;
          justify-content: center;
          padding: 2rem 0;
        }

        .orch-wt-list {
          display: flex;
          flex-direction: column;
          gap: 0.375rem;
        }

        .orch-task-list {
          display: flex;
          flex-direction: column;
          gap: 0.375rem;
        }

        .wt-del-confirm-wrap {
          display: flex;
          flex-direction: column;
          gap: 0.625rem;
          padding: 0.75rem;
          background: rgba(210,100,90,0.05);
          border: 1px solid rgba(210,100,90,0.20);
          border-radius: 0.625rem;
          animation: slideDown 160ms ease both;
        }
        .wt-del-confirm-msg {
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
          font-style: italic;
          line-height: 1.45;
        }
        .wt-del-confirm-msg em {
          color: var(--text-primary, #e2dbd0);
          font-style: normal;
        }
        .wt-del-confirm-actions {
          display: flex;
          gap: 0.5rem;
          justify-content: flex-end;
        }

        .orch-status-msg {
          font-size: 0.8125rem;
          color: #6dba88;
          margin-top: 0.875rem;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
        }
        .orch-error-msg {
          font-size: 0.8125rem;
          color: var(--status-error-text);
          margin-top: 0.875rem;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
        }

        /* Shared sysprompt-textarea + save button reused from PreferencesSection */
        .sysprompt-textarea {
          width: 100%; box-sizing: border-box; resize: vertical;
          min-height: 16rem;
          background: rgba(12, 11, 9, 0.6);
          border: 1px solid rgba(201, 168, 124, 0.14);
          border-radius: 0.5rem; padding: 0.875rem 1rem;
          color: var(--text-primary, #e2dbd0);
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.78125rem; line-height: 1.6;
          transition: border-color 240ms ease;
        }
        .sysprompt-textarea:focus {
          outline: none;
          border-color: rgba(201, 168, 124, 0.45);
          box-shadow: 0 0 0 3px rgba(201, 168, 124, 0.07);
        }
        .sysprompt-save {
          font-size: 0.8125rem; font-weight: 500;
          color: var(--bg-primary, #0c0b09);
          background: var(--amber, #c9a87c);
          border: none; border-radius: 0.4375rem;
          padding: 0.4375rem 0.9375rem; cursor: pointer;
          display: inline-flex; align-items: center; gap: 0.375rem;
          transition: opacity 200ms ease, transform 100ms ease;
        }
        .sysprompt-save:hover:not(:disabled) { opacity: 0.9; }
        .sysprompt-save:active:not(:disabled) { transform: scale(0.985); }
        .sysprompt-save:disabled { opacity: 0.4; cursor: default; }

        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
