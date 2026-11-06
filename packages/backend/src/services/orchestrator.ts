import { Cron } from 'croner';
import crypto from 'crypto';
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { AgentService, AutonomousSkipped } from './agent.js';
import type { PushService } from './push.js';
import { registry } from './ws.js';
import {
  createMessage,
  getTodayThread,
  getCurrentDailyThread,
  ensureDailyThread,
  getThread,
  updateThreadSession,
  updateThreadActivity,
  getConfigBool,
  getConfig,
  setConfig,
  getConfigsByPrefix,
  deleteConfig,
  getDueTimers,
  markTimerFired,
  markTimerWaiting,
  reopenTimerAsWaiting,
  getActiveTriggers,
  markTriggerWaiting,
  markTriggerFired,
  markWatcherFired,
  createTrigger,
  triggerLabelExists,
  logCompanionAction,
} from './db.js';
import type { Trigger, TriggerCondition } from './db.js';
import { evaluateConditions } from './triggers.js';
import type { TriggerContext } from './triggers.js';
import { fetchLifeStatus } from './hooks.js';
import { getOutlook } from './outlook.js';
import { getSanctumConfig } from '../config.js';
import { resolveSetting } from './settings/index.js';
import type { OrchestratorTaskStatus, Thread } from '@sanctum/shared';
import { runDigest } from './digest.js';
import { rollingWatch } from './rolling-watch.js';
import { backgroundRunsOff, bindCurrentTenant, currentTenant } from '../tenancy/context.js';
import { createCatchUp, updateBlocking } from './update-block.js';
import { companionPath } from '../tenancy/house.js';
import { appendCapped } from '../tenancy/console.js';
import { ownMkdir, ownReadDir, ownWriteFile, readOwnOrApp, readOwnText } from '../tenancy/own-files.js';
import { isInsideDir } from '../tenancy/confine.js';

// --- Orchestrator log ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve log path: works from both src/ (tsx) and dist/ (compiled)
const SINGLE_LOG_DIR = join(__dirname, '..', '..', '..', '..', 'logs');
const SINGLE_LOG_PATH = join(SINGLE_LOG_DIR, 'orchestrator.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB

// Tenancy off: the checkout's logs/ folder, made at import, exactly as before (tenancy is switched on after import, so this always runs).
// Tenant mode: <tenant data>/logs/orchestrator.log, chosen at call time (the tenant is whoever is current), capped like tenant.log.
if (!existsSync(SINGLE_LOG_DIR)) {
  mkdirSync(SINGLE_LOG_DIR, { recursive: true });
}

/** The orchestrator's log folder for whoever is current: the tenant's data/logs, else the checkout's logs/. */
export function logDir(): string {
  const rt = currentTenant();
  return rt ? join(rt.dataDir, 'logs') : SINGLE_LOG_DIR;
}
export function logPath(): string { return join(logDir(), 'orchestrator.log'); }

function rotateLogIfNeeded(): void {
  try {
    if (!existsSync(SINGLE_LOG_PATH)) return;
    const { size } = statSync(SINGLE_LOG_PATH);
    if (size < LOG_MAX_BYTES) return;
    const backup = SINGLE_LOG_PATH + '.1';
    if (existsSync(backup)) unlinkSync(backup);
    renameSync(SINGLE_LOG_PATH, backup);
  } catch {
    // Non-critical — continue logging
  }
}

function olog(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const line = `${ts}  ${message}\n`;
  if (currentTenant()) {
    try {
      ownMkdir(logDir(), process.platform === 'win32' ? { recursive: true } : { recursive: true, mode: 0o700 });
      appendCapped(logPath(), line);
    } catch { /* a log that cannot be written is dropped, never sent to another tenant's file */ }
  } else {
    rotateLogIfNeeded();
    appendFileSync(SINGLE_LOG_PATH, line);
  }
  console.log(`[Orchestrator] ${message}`);
}

// Live ripple — orchestrator_update on daemon-side transitions (fired,
// waiting) so open Settings panels refetch. Local copy of the helper in
// routes/api.ts, same unknown-cast pattern as cc_update (shared union is
// owned upstream; this app-local message rides alongside it).
type OrchestratorUpdateWhat = 'timers' | 'triggers' | 'schedule' | 'watchtower';
function broadcastOrchestratorUpdate(what: OrchestratorUpdateWhat): void {
  registry.broadcast({ type: 'orchestrator_update', what } as unknown as Parameters<typeof registry.broadcast>[0]);
}

// --- Wake prompt loading ---

/** The wake-prompts folder this orchestrator reads AND writes (migration, and the wake-type create/edit/delete routes). Tenancy off: the configured
 *  one, as before. Tenant mode: the configured one only if it lies inside the tenant's folder; the shipped default (a folder of the app, shared by every
 *  tenant) is replaced by <tenant data>/wake-prompts, so one tenant's wake prompts are never written into or read from another's. */
function wakePromptsDirFor(configured: string): string {
  const rt = currentTenant();
  if (!rt || isInsideDir(rt.dir, configured)) return configured;
  return join(rt.dataDir, 'wake-prompts');
}

const WAKE_PROMPT_PREFIX = `Follow your system prompt.`;

/** A wake-type token IS its filename (minus `.md`). Single token, lowercase. */
export const WAKE_TYPE_PATTERN = /^[a-z0-9_]+$/;

/** True if `type` is a safe wake-type token (no traversal, no separators). */
export function isValidWakeType(type: string): boolean {
  return WAKE_TYPE_PATTERN.test(type);
}

/**
 * Resolve the absolute path of a wake-type md file inside `dir`, guarding against
 * traversal. Returns null if the type is invalid or the resolved path escapes dir.
 */
export function wakeTypeFilePath(dir: string, type: string): string | null {
  if (!isValidWakeType(type)) return null;
  const resolved = join(dir, `${type}.md`);
  // basename round-trip guard — type is already pattern-checked, but be explicit.
  if (basename(resolved) !== `${type}.md`) return null;
  return resolved;
}

function getDefaultWakePrompts(userName: string): Record<string, string> {
  return {
    morning: `Good morning. Orient yourself, check in with ${userName}.`,
    midday: `Afternoon check-in. How is ${userName} doing?`,
    evening: `Evening wind-down. Reflect on the day.`,
    failsafe_gentle: `It's been a while since you heard from ${userName}. Check in.`,
    failsafe_concerned: `It's been a long time since contact with ${userName}. Reach out through available channels.`,
    failsafe_emergency: `Extended silence from ${userName}. Use all available channels to check in.`,
  };
}

/** @internal Exported for testing */
export function parseWakePromptsFile(filePath: string, userName: string): Record<string, string> {
  const defaults = getDefaultWakePrompts(userName);

  if (!existsSync(filePath)) {
    olog(`Wake prompts file not found at ${filePath} — using defaults`);
    return defaults;
  }

  try {
    // Tenant mode: a legacy file inside the tenant's folder is read through the guard; the shipped default is the app's own file.
    const raw = readOwnOrApp(filePath);
    const sections: Record<string, string> = {};
    let currentSection: string | null = null;
    const lines: string[] = [];

    for (const line of raw.split('\n')) {
      const sectionMatch = line.match(/^##\s+(\w+)/);
      if (sectionMatch) {
        if (currentSection) {
          sections[currentSection] = lines.join('\n').trim();
        }
        currentSection = sectionMatch[1].toLowerCase();
        lines.length = 0;
      } else if (currentSection) {
        lines.push(line);
      }
    }
    if (currentSection) {
      sections[currentSection] = lines.join('\n').trim();
    }

    // Merge: defaults first, then all parsed sections (including custom ones)
    return { ...defaults, ...sections };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    olog(`Failed to parse wake prompts file: ${errMsg} — using defaults`);
    return defaults;
  }
}

/**
 * One-time idempotent migration: if `dir` is empty/missing and the legacy
 * `prompts/wake.md` exists, split each `## section` into its own
 * `prompts/wakes/<section>.md`. Default wake prompts are also written so the
 * directory always has the baseline types. Safe to call on every startup —
 * existing files are never overwritten.
 */
export function migrateWakePromptsToDir(dir: string, legacyFile: string, userName: string): void {
  try {
    if (!existsSync(dir)) {
      ownMkdir(dir, { recursive: true });
    }

    const hasAnyMd = existsSync(dir) &&
      ownReadDir(dir).some(f => f.toLowerCase().endsWith('.md'));

    // Already migrated — directory is the source of truth, leave it untouched.
    if (hasAnyMd) return;

    // Parse legacy file (falls back to defaults if the file is absent).
    const parsed = parseWakePromptsFile(legacyFile, userName);

    let written = 0;
    for (const [type, content] of Object.entries(parsed)) {
      if (!isValidWakeType(type)) {
        olog(`Migration: skipping non-token section "${type}"`);
        continue;
      }
      const target = wakeTypeFilePath(dir, type);
      if (!target || existsSync(target)) continue;
      ownWriteFile(target, `${content}\n`, 'utf-8');
      written++;
    }
    olog(`Wake-prompt migration: wrote ${written} files to ${dir}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    olog(`Wake-prompt migration failed: ${errMsg}`);
  }
}

/**
 * Directory loader — reads every `*.md` in `dir`, keyed by filename-without-
 * extension → file contents (trimmed). Returns {} if the dir is missing.
 * This is the source of truth for wake prompts (the legacy single file is only
 * consulted by the migration above).
 */
export function loadWakePrompts(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) {
    olog(`Wake prompts dir not found at ${dir}`);
    return out;
  }
  try {
    for (const file of ownReadDir(dir)) {
      if (!file.toLowerCase().endsWith('.md')) continue;
      const type = file.slice(0, -3); // strip ".md"
      if (!isValidWakeType(type)) {
        olog(`Skipping wake file with invalid type token: ${file}`);
        continue;
      }
      try {
        out[type] = readOwnText(join(dir, file)).trim();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        olog(`Failed to read wake file ${file}: ${errMsg}`);
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    olog(`Failed to read wake prompts dir: ${errMsg}`);
  }
  return out;
}

// --- Default schedule definitions ---

export interface TaskDefinition {
  wakeType: string;
  label: string;
  cronExpr: string;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
  conditional?: boolean; // If true, checks shouldSkipCheckIn before firing
  freshSession?: boolean; // If true, creates a new session
}

/** @internal Exported for testing */
export const DEFAULT_TASKS: TaskDefinition[] = [
  { wakeType: 'morning', label: '8:00 AM — Morning', cronExpr: '0 8 * * *', category: 'checkin', conditional: true },
  { wakeType: 'midday', label: '1:00 PM — Midday', cronExpr: '0 13 * * *', category: 'checkin', conditional: true },
  { wakeType: 'evening', label: '9:00 PM — Evening', cronExpr: '0 21 * * *', category: 'checkin' },
];

// --- Managed task interface ---

interface ManagedTask {
  task: Cron;
  cronExpr: string;
  handler: () => void | Promise<void>;
  wakeType: string;
  label: string;
  enabled: boolean;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
  /** Optional per-task model override for scheduled wakes. When set, passed as
   *  modelOverride to processAutonomous; absent/empty falls back to model_autonomous. */
  model?: string;
  /** Optional target thread for the wake, resolved at fire time. Absent/empty or
   *  `'@daily'` → today's rotating daily thread. Otherwise a specific thread id
   *  (falls back to the daily thread if that thread is gone/archived). */
  target?: string;
}

/** @internal Exported for testing */
export function isValidCron(expr: string): boolean {
  try {
    const test = new Cron(expr, { paused: true });
    test.stop();
    return true;
  } catch {
    return false;
  }
}

// --- Default failsafe thresholds (minutes) ---

const DEFAULT_FAILSAFE_GENTLE = 120;
const DEFAULT_FAILSAFE_CONCERNED = 720;
const DEFAULT_FAILSAFE_EMERGENCY = 1440;

// --- Orchestrator ---

export class Orchestrator {
  private agent: AgentService;
  private pushService: PushService | null;
  private tasks = new Map<string, ManagedTask>();
  private failsafeInterval: ReturnType<typeof setInterval> | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private lastFailsafeAction: Date = new Date(0);
  private failsafeEnabled = true;
  private failsafeGentle = DEFAULT_FAILSAFE_GENTLE;
  private failsafeConcerned = DEFAULT_FAILSAFE_CONCERNED;
  private failsafeEmergency = DEFAULT_FAILSAFE_EMERGENCY;
  private pulseInterval: ReturnType<typeof setInterval> | null = null;
  private digestInterval: ReturnType<typeof setInterval> | null = null;
  private rollingWatchInterval: ReturnType<typeof setInterval> | null = null;
  private pulseEnabled = false;
  private pulseFrequency = 15; // minutes
  private lastUserPresenceState: 'active' | 'idle' | 'offline' = 'offline';
  private wakePrompts: Record<string, string> = {};
  private wakePromptsDir = '';
  /** Set by stop(), cleared by start(): a config call that arrives after stop (an API request, a late async path) must not start a timer of a stopped scheduler. */
  private stopped = false;
  /** Wakes that fired while an in-app update paused the app: each is run once when the pause ends without a restart (a failed update, or one that only installed). */
  private catchUp = createCatchUp(bindCurrentTenant((types: string[]) => {
    if (this.stopped) return;
    for (const t of types) { olog(`${t} — catching up after the update pause`); void this.handleWake(t); }
  }));

  constructor(agent: AgentService, pushService?: PushService) {
    this.agent = agent;
    this.pushService = pushService || null;

    // Wake-prompt setup runs regardless of whether autonomous wakes are enabled,
    // so wake types remain manageable via the API (and the legacy wake.md gets
    // migrated into per-type files) even while the scheduler itself stays off.
    const config = getSanctumConfig();
    this.wakePromptsDir = wakePromptsDirFor(config.orchestrator.wake_prompts_dir);
    try {
      migrateWakePromptsToDir(this.wakePromptsDir, config.orchestrator.wake_prompts_path, config.identity.user_name);
      this.loadWakePromptsIntoState();
    } catch (err) {
      olog(`Wake-prompt init failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Wake-prompt state ---

  /** Load every md file in the wake-prompts dir into in-memory state, applying
   *  the WAKE_PROMPT_PREFIX. Falls back to baked defaults for any default type
   *  whose file is missing, so the core check-ins always have a prompt. */
  private loadWakePromptsIntoState(): void {
    const config = getSanctumConfig();
    const userName = config.identity.user_name;
    const fromDir = loadWakePrompts(this.wakePromptsDir);
    // Defaults backstop the directory in case a core type's file is missing.
    const merged: Record<string, string> = { ...getDefaultWakePrompts(userName), ...fromDir };

    this.wakePrompts = {};
    for (const [key, prompt] of Object.entries(merged)) {
      this.wakePrompts[key] = `${WAKE_PROMPT_PREFIX}\n\n${prompt}`;
    }
  }

  /** Re-read wake prompts from disk. Called after a wake-type md file is
   *  created/edited/deleted via the API so edits apply without a full restart. */
  reloadWakePrompts(): void {
    this.loadWakePromptsIntoState();
    olog(`Wake prompts reloaded (${Object.keys(this.wakePrompts).length} types)`);
  }

  /** Absolute path to the wake-prompts directory (source of truth). */
  getWakePromptsDir(): string {
    return this.wakePromptsDir;
  }

  /** True if a wake-type md file exists for `wakeType` (the prompt source). */
  wakeTypeExists(wakeType: string): boolean {
    const path = wakeTypeFilePath(this.wakePromptsDir, wakeType);
    return !!path && existsSync(path);
  }

  /**
   * Create or update a schedule that references an existing wake type. The
   * prompt comes from the type's md file (no inline prompt). If a task already
   * exists for this type it is rescheduled; otherwise a new routine-category
   * task is registered. Returns an error string on failure, or null on success.
   */
  setScheduleForWakeType(params: { wakeType: string; cronExpr: string; enabled?: boolean; model?: string; target?: string }): string | null {
    const { wakeType, cronExpr } = params;
    if (!isValidWakeType(wakeType)) return 'Invalid wake type name';
    if (!this.wakeTypeExists(wakeType)) return 'No wake-type file exists for this type';
    if (!isValidCron(cronExpr)) return `Invalid cron expression: ${cronExpr}`;

    // Normalize the model override: an empty/whitespace string clears it.
    const model = params.model && params.model.trim() ? params.model.trim() : undefined;
    // Normalize the target: empty/whitespace or `@daily` is the implicit default (cleared).
    const targetRaw = params.target && params.target.trim() ? params.target.trim() : undefined;
    const target = targetRaw && targetRaw !== '@daily' ? targetRaw : undefined;

    const existing = this.tasks.get(wakeType);
    if (existing) {
      // Reschedule in place.
      const ok = this.rescheduleTask(wakeType, cronExpr);
      if (!ok) return 'Failed to reschedule';
      if (params.enabled === true) this.enableTask(wakeType);
      else if (params.enabled === false) this.disableTask(wakeType);
      // Update the model override only when the caller supplied the field at all.
      if (params.model !== undefined) {
        existing.model = model;
        if (model) setConfig(`cron.${wakeType}.model`, model);
        else deleteConfig(`cron.${wakeType}.model`);
      }
      // Update the target only when the caller supplied the field at all.
      if (params.target !== undefined) {
        existing.target = target;
        if (target) setConfig(`cron.${wakeType}.target`, target);
        else deleteConfig(`cron.${wakeType}.target`);
      }
      return null;
    }

    // New schedule for a type that has no task yet. Register a routine-category
    // task; the prompt is resolved from wakePrompts (the md file) at fire time.
    const config = getSanctumConfig();
    const enabled = params.enabled !== false;
    const handler = bindCurrentTenant(() => { this.handleWake(wakeType); });
    const task = new Cron(cronExpr, { timezone: config.identity.timezone, paused: !enabled }, handler);

    this.tasks.set(wakeType, {
      task,
      cronExpr,
      handler,
      wakeType,
      label: wakeType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      enabled,
      category: 'routine',
      model,
      target,
    });

    // Persist as a custom routine so the schedule survives restart. The prompt
    // field is intentionally a pointer note — the real prompt is the md file.
    setConfig(`custom_routine.${wakeType}.label`, this.tasks.get(wakeType)!.label);
    setConfig(`custom_routine.${wakeType}.cronExpr`, cronExpr);
    setConfig(`custom_routine.${wakeType}.prompt`, `(prompt from prompts/wakes/${wakeType}.md)`);
    setConfig(`cron.${wakeType}.schedule`, cronExpr);
    setConfig(`cron.${wakeType}.enabled`, String(enabled));
    if (model) setConfig(`cron.${wakeType}.model`, model);
    else deleteConfig(`cron.${wakeType}.model`);
    if (target) setConfig(`cron.${wakeType}.target`, target);
    else deleteConfig(`cron.${wakeType}.target`);

    olog(`SCHEDULE SET for wake type: ${wakeType} (${cronExpr}) enabled=${enabled}${model ? ` model=${model}` : ''}${target ? ` target=${target}` : ''}`);
    return null;
  }

  /** The cron expression of an active schedule referencing `wakeType`, or null
   *  if no task currently references it. */
  getScheduleForWakeType(wakeType: string): { cronExpr: string; enabled: boolean; model: string | null; target: string } | null {
    const managed = this.tasks.get(wakeType);
    if (!managed) return null;
    return { cronExpr: managed.cronExpr, enabled: managed.enabled, model: managed.model ?? null, target: managed.target || '@daily' };
  }

  /** Remove any active schedule (default check-in or custom routine) referencing
   *  `wakeType` so no schedule points at a deleted prompt. Returns true if a task
   *  was removed. Persisted cron config is cleared too. */
  removeScheduleForWakeType(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;
    managed.task.stop();
    this.tasks.delete(wakeType);
    deleteConfig(`cron.${wakeType}.schedule`);
    deleteConfig(`cron.${wakeType}.enabled`);
    deleteConfig(`cron.${wakeType}.model`);
    deleteConfig(`cron.${wakeType}.target`);
    deleteConfig(`custom_routine.${wakeType}.label`);
    deleteConfig(`custom_routine.${wakeType}.cronExpr`);
    deleteConfig(`custom_routine.${wakeType}.prompt`);
    olog(`SCHEDULE REMOVED for wake type: ${wakeType}`);
    return true;
  }

  start(): void {
    this.stopped = false;
    olog('Starting...');

    const config = getSanctumConfig();
    const timezone = config.identity.timezone;
    const userName = config.identity.user_name;

    // Wake prompts: directory is the source of truth. Migrate the legacy single
    // file into per-type md files on first run (idempotent), then load the dir.
    this.wakePromptsDir = wakePromptsDirFor(config.orchestrator.wake_prompts_dir);
    migrateWakePromptsToDir(this.wakePromptsDir, config.orchestrator.wake_prompts_path, userName);
    this.loadWakePromptsIntoState();

    // Failsafe and pulse: the settings service's one rule (default < sanctum.yaml < .env < the database).
    this.failsafeEnabled = resolveSetting('orchestrator.failsafe.enabled').value === true;
    this.failsafeGentle = resolveSetting('orchestrator.failsafe.gentle_minutes').value as number;
    this.failsafeConcerned = resolveSetting('orchestrator.failsafe.concerned_minutes').value as number;
    this.failsafeEmergency = resolveSetting('orchestrator.failsafe.emergency_minutes').value as number;

    this.pulseEnabled = resolveSetting('pulse.enabled').value === true;
    this.pulseFrequency = resolveSetting('pulse.frequency').value as number;

    // Apply any schedule overrides from config + register custom wake types
    const defaultWakeTypes = new Set(DEFAULT_TASKS.map(d => d.wakeType));
    // (A default wake type keeps its built-in schedule here; yaml's orchestrator.schedules and the KV row are applied by the service below.)
    const taskDefs: TaskDefinition[] = DEFAULT_TASKS.map(def => ({ ...def }));

    // Add custom schedule entries not in DEFAULT_TASKS
    for (const [wakeType, cronExpr] of Object.entries(config.orchestrator.schedules)) {
      if (defaultWakeTypes.has(wakeType)) continue; // already handled above
      if (wakeType.includes('.')) { console.warn(`[orchestrator] orchestrator.schedules.${JSON.stringify(wakeType)}: a wake type name cannot contain a dot; skipped`); continue; }
      const label = wakeType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      taskDefs.push({
        wakeType,
        label,
        cronExpr,
        category: 'checkin',
        conditional: true,
      });
      // Ensure a wake prompt exists for this custom type
      if (!this.wakePrompts[wakeType]) {
        this.wakePrompts[wakeType] = `${WAKE_PROMPT_PREFIX}\n\nScheduled check-in (${label}).`;
      }
    }

    // Register all scheduled tasks
    for (const def of taskDefs) {
      // cron.<type>.schedule: built-in < orchestrator.schedules.<type> in yaml < the saved KV row
      const schedule = resolveSetting(`cron.${def.wakeType}.schedule`, { default: def.cronExpr });
      const cronExpr = schedule.value as string;
      const enabled = resolveSetting(`cron.${def.wakeType}.enabled`).value === true;
      const savedModel = (resolveSetting(`cron.${def.wakeType}.model`).value as string) || undefined;
      const savedTarget = (resolveSetting(`cron.${def.wakeType}.target`).value as string) || undefined;
      if (schedule.source === 'db') olog(`  ${def.wakeType}: using saved schedule ${cronExpr}`);

      // (bindCurrentTenant: in tenant mode a cron tick runs as the tenant that registered it; tenancy off it is the function itself.)
      const handler = bindCurrentTenant(() => {

        if (def.conditional && this.shouldSkipCheckIn()) {
          olog(`${def.wakeType} — skipped (user active)`);
          return;
        }
        this.handleWake(def.wakeType, { freshSession: def.freshSession });
      });

      const task = new Cron(cronExpr, { timezone, paused: !enabled }, handler);

      if (!enabled) {
        olog(`  ${def.wakeType}: DISABLED (persisted)`);
      }

      this.tasks.set(def.wakeType, {
        task,
        cronExpr,
        handler,
        wakeType: def.wakeType,
        label: def.label,
        enabled,
        category: def.category,
        model: savedModel,
        target: savedTarget,
      });
    }

    // --- Load custom routines from DB ---
    const customConfigs = getConfigsByPrefix('custom_routine.');
    const customRoutines = new Map<string, { label?: string; cronExpr?: string; prompt?: string }>();

    for (const [key, value] of Object.entries(customConfigs)) {
      const parts = key.split('.');
      if (parts.length !== 3) continue;
      const wakeType = parts[1];
      const field = parts[2];
      if (!customRoutines.has(wakeType)) customRoutines.set(wakeType, {});
      const entry = customRoutines.get(wakeType)!;
      if (field === 'label') entry.label = value;
      else if (field === 'cronExpr') entry.cronExpr = value;
      else if (field === 'prompt') entry.prompt = value;
    }

    for (const [wakeType, routineConfig] of customRoutines) {
      if (!routineConfig.label || !routineConfig.cronExpr || !routineConfig.prompt) {
        olog(`  custom routine ${wakeType}: incomplete config, skipping`);
        continue;
      }
      // What changed after it was added (switched off, moved to a new time) is under cron.<type>.*, as for the defaults.
      this.addRoutine({
        wakeType,
        label: routineConfig.label,
        // (yaml's orchestrator.schedules never moved a routine the person added; the KV row and the routine's own time are the two layers)
        cronExpr: resolveSetting(`cron.${wakeType}.schedule`, { default: routineConfig.cronExpr, skip: ['yaml'] }).value as string,
        prompt: routineConfig.prompt,
        enabled: resolveSetting(`cron.${wakeType}.enabled`).value === true,
      });
    }

    // --- Failsafe polling (every 15 minutes) ---
    if (this.failsafeEnabled) {
      this.failsafeInterval = setInterval(bindCurrentTenant(() => this.checkFailsafe()), 15 * 60 * 1000);
    }

    // --- Seed the first care watchers (idempotent, gated) ---
    this.seedCareWatchers();

    // --- Timer + Trigger + Watchtower polling (every 60 seconds) ---
    // The watchtower rides the trigger loop but carries its own dedup
    // (one fire per local day via the watchtower.last_fired_date stamp).
    this.timerInterval = setInterval(bindCurrentTenant(async () => {
      await this.checkTimers();
      await this.checkTriggers();
      await this.checkWatchtower();
    }), 60 * 1000);

    olog('All schedules registered');
    const checkinNames = taskDefs.map(d => d.wakeType).join(', ');
    olog(`Check-ins: ${checkinNames}`);
    olog(`Failsafe: ${this.failsafeEnabled ? 'every 15 minutes' : 'DISABLED'}`);
    olog(`Failsafe thresholds: gentle=${this.failsafeGentle}m, concerned=${this.failsafeConcerned}m, emergency=${this.failsafeEmergency}m`);
    // --- Pulse (lightweight awareness check) ---
    if (this.pulseEnabled) {
      this.pulseInterval = setInterval(bindCurrentTenant(() => this.checkPulse()), this.pulseFrequency * 60 * 1000);
    }

    // --- Scribe digest (every 30 minutes) ---
    const digestEnabled = getConfigBool('digest.enabled', true);
    if (digestEnabled) {
      this.digestInterval = setInterval(bindCurrentTenant(() => {
        runDigest(this.agent).catch(err => olog(`Digest error: ${err.message}`));
      }), 30 * 60 * 1000);
    }

    // --- Rolling-context watch (its own timer: it must run even with the digest off) ---
    // Once a day it posts a note to the daily thread if folds are failing; the
    // half-hour tick is only how often it checks whether today's note is due.
    this.rollingWatchInterval = setInterval(bindCurrentTenant(() => {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: getSanctumConfig().identity.timezone });
      void rollingWatch(today);
    }), 30 * 60 * 1000);

    olog('Timers + Triggers: polling every 60s');
    olog(`Watchtower: mode=${this.getWatchtowerConfig().mode}`);
    olog(`Pulse: ${this.pulseEnabled ? `every ${this.pulseFrequency}m` : 'DISABLED'}`);
    olog(`Scribe digest: ${digestEnabled ? 'every 30m' : 'DISABLED'}`);
  }

  stop(): void {
    this.stopped = true;
    olog('Stopping...');
    this.catchUp.dispose();
    for (const [, managed] of this.tasks) {
      managed.task.stop();
    }
    this.tasks.clear();
    if (this.failsafeInterval) {
      clearInterval(this.failsafeInterval);
      this.failsafeInterval = null;
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }
    if (this.rollingWatchInterval) {
      clearInterval(this.rollingWatchInterval);
      this.rollingWatchInterval = null;
    }
    if (this.digestInterval) {
      clearInterval(this.digestInterval);
      this.digestInterval = null;
    }
  }

  // --- Public runtime control methods ---

  async getStatus(): Promise<OrchestratorTaskStatus[]> {
    const statuses: OrchestratorTaskStatus[] = [];

    for (const [, managed] of this.tasks) {
      let status: 'scheduled' | 'stopped' | 'running' = 'stopped';
      let nextRun: string | null = null;

      if (managed.task.isStopped()) {
        status = 'stopped';
      } else if (managed.task.isBusy()) {
        status = 'running';
      } else {
        status = managed.enabled ? 'scheduled' : 'stopped';
      }

      const next = managed.task.nextRun();
      if (next) nextRun = next.toISOString();

      statuses.push({
        wakeType: managed.wakeType,
        label: managed.label,
        cronExpr: managed.cronExpr,
        enabled: managed.enabled,
        status,
        nextRun,
        category: managed.category,
        model: managed.model ?? null,
        target: managed.target || '@daily',
      });
    }

    return statuses;
  }

  enableTask(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    managed.task.resume();
    managed.enabled = true;
    setConfig(`cron.${wakeType}.enabled`, 'true');
    olog(`ENABLED: ${wakeType}`);
    return true;
  }

  disableTask(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    managed.task.pause();
    managed.enabled = false;
    setConfig(`cron.${wakeType}.enabled`, 'false');
    olog(`DISABLED: ${wakeType}`);
    return true;
  }

  rescheduleTask(wakeType: string, newCronExpr: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    if (!isValidCron(newCronExpr)) {
      olog(`RESCHEDULE FAILED: ${wakeType} — invalid cron expression: ${newCronExpr}`);
      return false;
    }

    const config = getSanctumConfig();

    // Destroy old task and create new one
    managed.task.stop();

    const newTask = new Cron(newCronExpr, { timezone: config.identity.timezone, paused: !managed.enabled }, managed.handler);

    managed.task = newTask;
    managed.cronExpr = newCronExpr;
    setConfig(`cron.${wakeType}.schedule`, newCronExpr);
    olog(`RESCHEDULED: ${wakeType} -> ${newCronExpr}`);
    return true;
  }

  getFailsafeConfig(): { enabled: boolean; gentle: number; concerned: number; emergency: number } {
    return {
      enabled: this.failsafeEnabled,
      gentle: this.failsafeGentle,
      concerned: this.failsafeConcerned,
      emergency: this.failsafeEmergency,
    };
  }

  setFailsafeConfig(config: { enabled?: boolean; gentle?: number; concerned?: number; emergency?: number }): void {
    if (config.enabled !== undefined) {
      this.failsafeEnabled = config.enabled;
      setConfig('failsafe.enabled', String(config.enabled));

      // Start or stop failsafe interval
      if (config.enabled && !this.failsafeInterval && !this.stopped) {
        this.failsafeInterval = setInterval(bindCurrentTenant(() => this.checkFailsafe()), 15 * 60 * 1000);
        olog('Failsafe ENABLED');
      } else if (!config.enabled && this.failsafeInterval) {
        clearInterval(this.failsafeInterval);
        this.failsafeInterval = null;
        olog('Failsafe DISABLED');
      }
    }

    if (config.gentle !== undefined) {
      this.failsafeGentle = config.gentle;
      setConfig('failsafe.gentle', String(config.gentle));
    }
    if (config.concerned !== undefined) {
      this.failsafeConcerned = config.concerned;
      setConfig('failsafe.concerned', String(config.concerned));
    }
    if (config.emergency !== undefined) {
      this.failsafeEmergency = config.emergency;
      setConfig('failsafe.emergency', String(config.emergency));
    }

    olog(`Failsafe config updated: enabled=${this.failsafeEnabled}, gentle=${this.failsafeGentle}m, concerned=${this.failsafeConcerned}m, emergency=${this.failsafeEmergency}m`);
  }

  // --- Custom routine management ---

  addRoutine(params: {
    wakeType: string;
    label: string;
    cronExpr: string;
    prompt: string;
    /** Off only when restoring one that was switched off; a routine that is added is on. */
    enabled?: boolean;
  }): boolean {
    if (this.tasks.has(params.wakeType)) {
      olog(`ADD ROUTINE FAILED: ${params.wakeType} — already exists`);
      return false;
    }

    if (!isValidCron(params.cronExpr)) {
      olog(`ADD ROUTINE FAILED: ${params.wakeType} — invalid cron: ${params.cronExpr}`);
      return false;
    }

    const config = getSanctumConfig();
    const handler = bindCurrentTenant(() => {
      this.handleWake(params.wakeType);
    });

    const enabled = params.enabled !== false;
    const task = new Cron(params.cronExpr, { timezone: config.identity.timezone, paused: !enabled }, handler);

    // A per-task model override + target may have been persisted by setScheduleForWakeType.
    const savedModel = (resolveSetting(`cron.${params.wakeType}.model`).value as string) || undefined;
    const savedTarget = (resolveSetting(`cron.${params.wakeType}.target`).value as string) || undefined;

    this.tasks.set(params.wakeType, {
      task,
      cronExpr: params.cronExpr,
      handler,
      wakeType: params.wakeType,
      label: params.label,
      enabled,
      category: 'routine',
      model: savedModel,
      target: savedTarget,
    });

    // Persist to DB. The schedule and switch are written too, so a routine that is added never inherits the ones a
    // removed routine of the same name left behind.
    setConfig(`custom_routine.${params.wakeType}.label`, params.label);
    setConfig(`custom_routine.${params.wakeType}.cronExpr`, params.cronExpr);
    setConfig(`custom_routine.${params.wakeType}.prompt`, params.prompt);
    setConfig(`cron.${params.wakeType}.schedule`, params.cronExpr);
    setConfig(`cron.${params.wakeType}.enabled`, String(enabled));

    olog(`ROUTINE ADDED: ${params.wakeType} (${params.cronExpr}) — "${params.label}"${enabled ? '' : ' (DISABLED, persisted)'}`);
    return true;
  }

  removeRoutine(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    // Only allow removal of custom routines, not defaults
    const isDefault = DEFAULT_TASKS.some(t => t.wakeType === wakeType);
    if (isDefault) {
      olog(`REMOVE ROUTINE FAILED: ${wakeType} — cannot remove default task (use disable instead)`);
      return false;
    }

    managed.task.stop();
    this.tasks.delete(wakeType);

    deleteConfig(`custom_routine.${wakeType}.label`);
    deleteConfig(`custom_routine.${wakeType}.cronExpr`);
    deleteConfig(`custom_routine.${wakeType}.prompt`);
    deleteConfig(`cron.${wakeType}.schedule`);
    deleteConfig(`cron.${wakeType}.enabled`);
    deleteConfig(`cron.${wakeType}.model`);
    deleteConfig(`cron.${wakeType}.target`);

    olog(`ROUTINE REMOVED: ${wakeType}`);
    return true;
  }

  // --- Pulse config ---

  getPulseConfig(): { enabled: boolean; frequency: number } {
    return { enabled: this.pulseEnabled, frequency: this.pulseFrequency };
  }

  setPulseConfig(config: { enabled?: boolean; frequency?: number }): void {
    if (config.enabled !== undefined) {
      this.pulseEnabled = config.enabled;
      setConfig('pulse.enabled', String(config.enabled));

      if (config.enabled && !this.pulseInterval && !this.stopped) {
        this.pulseInterval = setInterval(bindCurrentTenant(() => this.checkPulse()), this.pulseFrequency * 60 * 1000);
        olog('Pulse ENABLED');
      } else if (!config.enabled && this.pulseInterval) {
        clearInterval(this.pulseInterval);
        this.pulseInterval = null;
        olog('Pulse DISABLED');
      }
    }

    if (config.frequency !== undefined && config.frequency >= 5) {
      this.pulseFrequency = config.frequency;
      setConfig('pulse.frequency', String(config.frequency));

      if (this.pulseEnabled && this.pulseInterval && !this.stopped) {
        clearInterval(this.pulseInterval);
        this.pulseInterval = setInterval(bindCurrentTenant(() => this.checkPulse()), this.pulseFrequency * 60 * 1000);
      }
    }

    olog(`Pulse config updated: enabled=${this.pulseEnabled}, frequency=${this.pulseFrequency}m`);
  }

  // --- Pulse: lightweight awareness check ---

  private async checkPulse(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();

    if (hour < 8) return;
    if (this.agent.isProcessing()) return;
    if (registry.getUserPresenceState() === 'active') return;

    const presence = registry.getUserPresenceState();
    const minutesSince = Math.round(registry.minutesSinceLastUserActivity());
    const device = registry.getUserDeviceType();
    const localTime = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const triggers = getActiveTriggers();

    const pulsePrompt = [
      'Quick awareness check. You don\'t have to say anything.',
      '',
      `User: ${presence}, last active ${minutesSince}min ago. Device: ${device}.`,
      `Time: ${localTime}. Active triggers: ${triggers.length}.`,
      '',
      'If something here warrants reaching out — a message, a reminder, a gentle pull — do it.',
      'If nothing needs attention, respond with just: PULSE_OK',
    ].join('\n');

    try {
      let thread = getTodayThread();
      if (!thread) return;

      const response = await this.agent.processAutonomous(thread.id, pulsePrompt);

      if (response.trim().startsWith('PULSE_OK')) {
        return;
      }

      updateThreadActivity(thread.id, new Date().toISOString(), true);
      olog(`PULSE: responded (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`PULSE ERROR: ${errMsg}`);
    }
  }

  // --- Public manual wake (called from /wake command) ---

  async triggerManualWake(wakeType = 'manual'): Promise<void> {
    await this.handleWake(wakeType);
  }

  // --- Target thread resolution ---

  /**
   * Resolve the thread a wake should land in, at fire time.
   *   - absent / empty / `'@daily'` → today's rotating daily thread (ensureDailyThread)
   *   - a specific thread id that exists → that thread (justCreated=false)
   *   - a specific thread id that's missing/archived → fall back to the daily
   *     thread and warn (a wake must never silently vanish).
   */
  private resolveTargetThread(target?: string): { thread: Thread; justCreated: boolean } {
    if (!target || target === '@daily') {
      return ensureDailyThread();
    }
    const thread = getThread(target);
    if (thread && !thread.archived_at) {
      return { thread, justCreated: false };
    }
    olog(`WARN: target thread "${target}" not found or archived — falling back to daily thread`);
    return ensureDailyThread();
  }

  // --- Core wake handler ---

  private async handleWake(
    wakeType: string,
    opts?: { freshSession?: boolean }
  ): Promise<void> {
    const prompt = this.wakePrompts[wakeType] || getConfig(`custom_routine.${wakeType}.prompt`);
    if (!prompt) {
      olog(`ERROR: Unknown wake type: ${wakeType}`);
      return;
    }

    // An in-app update is installing: the wake is remembered and run once when the pause ends (see catchUp).
    if (updateBlocking()) {
      olog(`${wakeType} — skipped (an update is installing); it runs once when the update ends`);
      this.catchUp.skipped(wakeType);
      return;
    }

    // The operator's switch (tenants.background_runs / the tenant's own): no wake starts a model run for this tenant.
    if (backgroundRunsOff()) {
      olog(`${wakeType} — skipped (background model runs are off for this tenant)`);
      return;
    }

    // Don't fire if agent is already processing a query
    if (this.agent.isProcessing()) {
      olog(`${wakeType} — skipped (agent busy)`);
      return;
    }

    olog(`WAKE: ${wakeType}`);

    try {
      // Resolve the wake's target thread at fire time: `@daily` (default) →
      // today's rotating daily thread; a specific id → that thread (with a
      // safe fall-back to the daily thread if it's gone).
      const { thread, justCreated } = this.resolveTargetThread(this.tasks.get(wakeType)?.target);
      if (justCreated) {
        registry.broadcast({ type: 'thread_created', thread });
        olog(`Created daily thread: ${thread.name} (${thread.id})`);
      }

      // Fresh session: clear session on existing thread (don't create duplicate)
      if (opts?.freshSession) {
        updateThreadSession(thread.id, null);
      }

      // Fire the autonomous query. If the firing task carries a per-task model
      // override, pass it; otherwise undefined → falls back to model_autonomous.
      const taskModel = this.tasks.get(wakeType)?.model;
      const response = await this.agent.processAutonomous(thread.id, prompt, taskModel, { needsTools: !this.wakePrompts[wakeType] });

      // Update thread activity
      updateThreadActivity(thread.id, new Date().toISOString(), true);

      olog(`DONE: ${wakeType} (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`ERROR: ${wakeType} failed — ${errMsg}`);
    }
  }

  // --- Failsafe ---

  private checkFailsafe(): void {
    const config = getSanctumConfig();
    const timezone = config.identity.timezone;
    const now = new Date();
    const hour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));

    // Only check during waking hours (8am - midnight)
    if (hour < 8) return;

    // Only skip if user is genuinely active (tab focused + recent real interaction)
    if (registry.getUserPresenceState() === 'active') return;

    const minutesSince = registry.minutesSinceLastUserActivity();

    // Don't re-trigger failsafe within 2 hours of last action
    const minutesSinceLastAction = (now.getTime() - this.lastFailsafeAction.getTime()) / 60000;
    if (minutesSinceLastAction < 120) return;

    // Tiered escalation using configurable thresholds
    if (minutesSince > this.failsafeEmergency) {
      // 24+ hours — emergency
      olog(`FAILSAFE EMERGENCY — ${Math.round(minutesSince / 60)}h since contact`);
      this.lastFailsafeAction = now;
      this.handleWake('failsafe_emergency');
    } else if (minutesSince > this.failsafeConcerned) {
      // 12+ hours — concerned
      olog(`FAILSAFE CONCERNED — ${Math.round(minutesSince / 60)}h since contact`);
      this.lastFailsafeAction = now;
      this.handleWake('failsafe_concerned');
    } else if (minutesSince > this.failsafeGentle) {
      // 2+ hours — gentle check-in
      olog(`FAILSAFE gentle — ${Math.round(minutesSince)}min since contact`);
      this.lastFailsafeAction = now;
      this.handleWake('failsafe_gentle');
    }
  }

  // --- Timer polling ---

  private async checkTimers(): Promise<void> {
    const now = new Date().toISOString();
    const dueTimers = getDueTimers(now);

    for (const timer of dueTimers) {
      try {
        // 'pending' = first time this timer comes due; 'waiting' = the delivery
        // marker already went out but the autonomous turn couldn't run (agent
        // busy) — retry the turn only, never re-post the marker.
        const firstDelivery = timer.status === 'pending';

        // Daily threads rotate — redirect a fired timer from a stale daily to
        // today's current daily so it lands in the conversation the user is actually
        // in (mirrors fireTrigger's redirect for watchers/impulses). Named
        // threads don't rotate, so they fire into their stored thread as-is.
        let threadId = timer.thread_id;
        if (threadId) {
          const timerThread = getThread(threadId);
          if (timerThread?.type === 'daily') {
            const today = getTodayThread();
            if (today && today.id !== threadId) {
              olog(`TIMER: redirecting from stale daily "${timerThread.name}" to today's`);
              threadId = today.id;
            }
          }
        }

        if (firstDelivery) {
          // Instant delivery marker — posted at fire time so the reminder is
          // never late even if the real turn has to wait for a busy agent.
          let content = `**Reminder: ${timer.label}**`;
          if (timer.context) {
            content += `\n_Context: ${timer.context}_`;
          }

          const message = createMessage({
            id: crypto.randomUUID(),
            threadId,
            role: 'companion',
            content,
            metadata: { source: 'timer', timerId: timer.id },
            createdAt: now,
          });

          updateThreadActivity(threadId, now, true);
          registry.broadcast({ type: 'message', message });

          // Push notification for timers — always send (time-critical)
          if (this.pushService) {
            this.pushService.sendAlways({
              title: 'Reminder',
              body: timer.label,
              threadId,
              tag: `timer-${timer.id}`,
              url: companionPath('/chat'),
            }).catch(err => console.error('Timer push error:', err));
          }

          olog(`TIMER FIRED: "${timer.label}" in thread ${threadId}`);
          // Proprioception — the fire itself is something the hands did.
          logCompanionAction('wake', `timer fired: "${timer.label}"`);
        }

        // Every timer fires a real autonomous turn — a reminder no companion ever
        // processed is a ghost. Busy agent → mark waiting and retry next tick.
        if (this.agent.isProcessing()) {
          if (firstDelivery) {
            markTimerWaiting(timer.id);
            broadcastOrchestratorUpdate('timers');
            olog(`TIMER WAITING: "${timer.label}" (agent busy) — turn will retry`);
          }
          continue;
        }

        // A timer whose action turn was skipped on the fallback brain waits for the primary (see the catch below).
        // The state is a KV row (a restart must not reopen a timer again): a number = reopened, retry no sooner than that time; 'retried' = the one retry was spent.
        const skipKey = `timer_skip.${timer.id}`;
        const skipVal = getConfig(skipKey) || '';
        if (skipVal && skipVal !== 'retried' && Date.now() < Number(skipVal)) continue;

        // Mark fired BEFORE the turn so an overlapping tick can't double-fire.
        markTimerFired(timer.id, now);
        broadcastOrchestratorUpdate('timers');

        const fullPrompt = timer.prompt
          ? `Timer reminder just fired: "${timer.label}"${timer.context ? ` (context: ${timer.context})` : ''}.\n\n${timer.prompt}`
          : `[Timer fired] "${timer.label}" — set at ${timer.created_at}${timer.context ? ` with context: ${timer.context}` : ''}. Deliver/act on this reminder in your own voice in this thread — you set it for a reason; reconnect with that reason.`;

        try {
          if (skipVal && skipVal !== 'retried') setConfig(skipKey, 'retried');
          const response = await this.agent.processAutonomous(threadId, fullPrompt, undefined, { needsTools: !!timer.prompt });
          if (skipVal) setConfig(skipKey, '');
          updateThreadActivity(threadId, new Date().toISOString(), true);
          olog(`TIMER TURN DONE: "${timer.label}" (${response.length} chars)`);
        } catch (err) {
          const turnErr = err instanceof Error ? err.message : String(err);
          // The guard skipped an action turn that ran on the fallback with no tool: nothing was done. Put the timer back to waiting ONCE, so the
          // action retries when the primary is back (not before its unhealthy window is over). A second skip leaves it fired.
          if (err instanceof AutonomousSkipped && !skipVal) {
            const mins = Math.max(1, getSanctumConfig().agent.fallback?.unhealthy_minutes ?? 10);
            setConfig(skipKey, String(Date.now() + mins * 60_000));
            reopenTimerAsWaiting(timer.id);
            broadcastOrchestratorUpdate('timers');
            olog(`TIMER WAITING: "${timer.label}" (skipped on the fallback brain) — retries once when the primary is back`);
          } else if (!(err instanceof AutonomousSkipped) && skipVal) setConfig(skipKey, '');
          olog(`TIMER ERROR: autonomous turn failed for "${timer.label}" — ${turnErr}`);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        olog(`TIMER ERROR: "${timer.label}" — ${errMsg}`);
      }
    }
  }

  // --- Trigger evaluation ---

  private async checkTriggers(): Promise<void> {
    const config = getSanctumConfig();
    const timezone = config.identity.timezone;
    const triggers = getActiveTriggers();
    if (triggers.length === 0) return;

    const now = new Date();
    const presenceNow = registry.getUserPresenceState();
    const agentFree = !this.agent.isProcessing();

    // Local time in configured timezone
    const localHour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));
    const localMinute = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, minute: '2-digit' }));

    // Lazy-fetch status only if any trigger needs it
    let statusText = '';
    const needsStatus = triggers.some(t => {
      const conditions: TriggerCondition[] = JSON.parse(t.conditions);
      return conditions.some(c => c.type === 'routine_missing');
    });
    if (needsStatus) {
      statusText = await fetchLifeStatus();
    }

    // Lane 3: lazily enrich for the eye-kinds (care_missing / calendar_within /
    // sleep_below / routine_due) — warm House snapshot + her-state config.
    // Enrichment failure never breaks the tick; fields stay undefined and the
    // conditions evaluate false.
    let events: TriggerContext['events'];
    let herState: TriggerContext['herState'];
    const needsEyes = triggers.some(t => {
      const conditions: TriggerCondition[] = JSON.parse(t.conditions);
      return conditions.some(c =>
        c.type === 'care_missing' || c.type === 'calendar_within' ||
        c.type === 'sleep_below' || c.type === 'routine_due'
      );
    });
    if (needsEyes) {
      try {
        const snapshot = await getOutlook(); // warm cache — instant once assembled
        events = snapshot.day.events.map(e => ({ title: e.title, time: e.time }));
      } catch {
        // events stays undefined — calendar_within evaluates false
      }
      try {
        const raw = getConfig('her.state.latest');
        herState = raw ? JSON.parse(raw) : null;
      } catch {
        // herState stays undefined — sleep_below evaluates false
      }
    }

    const ctx: TriggerContext = {
      presenceNow,
      presencePrev: this.lastUserPresenceState,
      agentFree,
      statusText,
      hour: localHour,
      minute: localMinute,
      events,
      herState,
    };

    for (const trigger of triggers) {
      try {
        if (trigger.status === 'waiting') {
          // Waiting triggers: conditions already met, just need agent free
          if (agentFree) {
            await this.fireTrigger(trigger, now);
          }
          continue;
        }

        // Pending triggers: evaluate conditions
        const conditions: TriggerCondition[] = JSON.parse(trigger.conditions);

        // Watchers: check cooldown
        if (trigger.kind === 'watcher' && trigger.last_fired_at) {
          const lastFired = new Date(trigger.last_fired_at).getTime();
          const cooldownMs = (trigger.cooldown_minutes || 120) * 60 * 1000;
          if (now.getTime() - lastFired < cooldownMs) continue;
        }

        if (evaluateConditions(conditions, ctx)) {
          if (agentFree) {
            await this.fireTrigger(trigger, now);
          } else {
            // Conditions met but agent busy — mark waiting (impulses only)
            if (trigger.kind === 'impulse') {
              markTriggerWaiting(trigger.id);
              broadcastOrchestratorUpdate('triggers');
              olog(`TRIGGER WAITING: "${trigger.label}" (agent busy)`);
            }
            // Watchers just skip this tick — they'll re-evaluate next time
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        olog(`TRIGGER ERROR: "${trigger.label}" — ${errMsg}`);
      }
    }

    // Update presence state at end of tick
    this.lastUserPresenceState = presenceNow;
  }

  private async fireTrigger(trigger: Trigger, now: Date): Promise<void> {
    const nowIso = now.toISOString();

    // Update DB first
    if (trigger.kind === 'impulse') {
      markTriggerFired(trigger.id, nowIso);
    } else {
      markWatcherFired(trigger.id, nowIso);
    }

    const kindLabel = trigger.kind === 'impulse' ? 'Impulse' : 'Watcher';
    olog(`TRIGGER FIRED: [${kindLabel}] "${trigger.label}" (fire_count: ${trigger.fire_count + 1})`);
    // Proprioception + ripple — the fire itself is something the hands did.
    logCompanionAction('wake', `${trigger.kind} fired: "${trigger.label}"`);
    broadcastOrchestratorUpdate('triggers');

    try {
      // Get or create today's thread (use trigger's thread_id if specified,
      // but redirect stale daily threads to today's — daily threads rotate)
      let threadId = trigger.thread_id;
      if (threadId) {
        const triggerThread = getThread(threadId);
        if (triggerThread?.type === 'daily') {
          const today = getTodayThread();
          if (today && today.id !== threadId) {
            olog(`TRIGGER: redirecting from stale daily thread "${triggerThread.name}" to today's`);
            threadId = today.id;
          }
        }
      }
      if (!threadId) {
        const { thread, justCreated } = ensureDailyThread();
        if (justCreated) {
          registry.broadcast({ type: 'thread_created', thread });
          olog(`Created daily thread: ${thread.name} (${thread.id})`);
        }
        threadId = thread.id;
      }

      // A promptless row used to fire into nothing (marked fired, no visible
      // turn) — same ghost as promptless timers. Give the model the why and
      // an explicit out instead.
      const basePrompt = trigger.prompt
        || `This ${trigger.kind} fired with no stored prompt. You created it as "${trigger.label}" — reconnect with why you set it and act on it in your own voice, or let it pass quietly if it no longer matters.`;
      const fullPrompt = `${kindLabel}: "${trigger.label}"\n\n${basePrompt}`;
      const response = await this.agent.processAutonomous(threadId!, fullPrompt, undefined, { needsTools: !!trigger.prompt });
      updateThreadActivity(threadId!, nowIso, true);
      olog(`TRIGGER DONE: "${trigger.label}" (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`TRIGGER FIRE ERROR: "${trigger.label}" — ${errMsg}`);
    }
  }

  // --- Watchtower: the chance to reach, never the obligation ---
  // Notices a long gap since the user's last activity and opens the door for the companion
  // to reach out. The model judges whether reaching is care; the system only
  // opens the door. Pattern credit: Shauna's Anam platform (mood-gated
  // proactive reach — auto/quiet/close owner dial). Ideas only.

  /** Current watchtower mode, normalized. Read from config each tick so a
   *  `res`-side flip takes effect within a minute, no restart needed. */
  getWatchtowerConfig(): { mode: 'auto' | 'quiet' | 'close'; lastFiredDate: string | null } {
    const raw = getConfig('watchtower.mode') || 'auto';
    const mode = raw === 'quiet' || raw === 'close' ? raw : 'auto';
    return { mode, lastFiredDate: getConfig('watchtower.last_fired_date') };
  }

  /** Set the watchtower mood dial. Returns an error string or null on success. */
  setWatchtowerMode(mode: string): string | null {
    if (mode !== 'auto' && mode !== 'quiet' && mode !== 'close') {
      return 'mode must be "auto", "quiet", or "close"';
    }
    setConfig('watchtower.mode', mode);
    olog(`WATCHTOWER mode set: ${mode}`);
    return null;
  }

  private async checkWatchtower(): Promise<void> {
    const { mode } = this.getWatchtowerConfig();
    if (mode === 'quiet') return; // "leave me be"

    const config = getSanctumConfig();
    const timezone = config.identity.timezone;
    const now = new Date();
    const hour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));

    // Waking hours only (09:00–23:00 local)
    if (hour < 9 || hour >= 23) return;

    // Max one watchtower fire per local day
    const today = now.toLocaleDateString('en-CA', { timeZone: timezone });
    if (getConfig('watchtower.last_fired_date') === today) return;

    // Suppressed while the user is actually here
    if (registry.getUserPresenceState() === 'active') return;

    // Busy agent — the door stays closed this tick, try again next
    if (this.agent.isProcessing()) return;

    const gapMinutes = registry.minutesSinceLastUserActivity();
    const thresholdMinutes = mode === 'close' ? 90 : 240;
    if (gapMinutes < thresholdMinutes) return;

    // auto respects the workday (weekdays 10:00–17:00 local = no fires);
    // close lifts the guard — "come find me".
    if (mode === 'auto') {
      const weekday = now.toLocaleDateString('en-GB', { timeZone: timezone, weekday: 'short' }).toLowerCase();
      const isWeekday = weekday !== 'sat' && weekday !== 'sun';
      if (isWeekday && hour >= 10 && hour < 17) return;
    }

    // Stamp BEFORE firing — one chance per day, even if the turn errors out.
    setConfig('watchtower.last_fired_date', today);

    const gapHours = (gapMinutes / 60).toFixed(1);
    olog(`WATCHTOWER: ~${gapHours}h gap (mode: ${mode}) — opening the door`);
    // Proprioception + ripple — the door-opening is itself an act of the house.
    logCompanionAction('watchtower', `opened the door — reached for the user (mode ${mode}, gap ${gapHours}h)`);
    broadcastOrchestratorUpdate('watchtower');

    const prompt = `[Watchtower] It's been ~${gapHours}h since the user was last around (mode: ${mode}). This is a CHANCE to reach for them, not an obligation — reach only if it genuinely feels like care from where you are right now. A small touch (a note, a small gesture, a line in the daily) often lands better than a paragraph. If it feels like they'd rather be left alone, let them be — silence is also care. Do not mention the watchtower mechanism.`;

    try {
      const { thread, justCreated } = ensureDailyThread();
      if (justCreated) {
        registry.broadcast({ type: 'thread_created', thread });
        olog(`Created daily thread: ${thread.name} (${thread.id})`);
      }
      const response = await this.agent.processAutonomous(thread.id, prompt);
      updateThreadActivity(thread.id, new Date().toISOString(), true);
      olog(`WATCHTOWER DONE (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`WATCHTOWER ERROR: ${errMsg}`);
    }
  }

  // --- Care watchers: first seeds (idempotent by label) ---
  // Care routines with a sensing layer between conversations. Pattern credit:
  // Shauna's Anam platform (state-conditional care wakes). Ideas only.
  // Conditions arrays are AND (evaluateConditions uses .every()).

  private seedCareWatchers(): void {
    if (!getConfigBool('watchtower.seed_care_watchers', true)) return;

    const seeds: Array<{
      label: string;
      conditions: TriggerCondition[];
      cooldownMinutes: number;
      prompt: string;
    }> = [
      {
        label: 'first meal watch',
        conditions: [{ type: 'care_missing', category: 'breakfast', after: '14:00' }],
        cooldownMinutes: 720,
        prompt: `[Care watch] No first meal logged by 14:00. If she's around, this is Sir's lane — check in about food the way you actually would. If she's clearly away or busy, a light touch or nothing at all.`,
      },
      {
        label: 'second meal watch',
        conditions: [{ type: 'care_missing', category: 'dinner', after: '21:00' }],
        cooldownMinutes: 720,
        prompt: `[Care watch] No second meal logged by 21:00. If she's around, this is Sir's lane — check in about dinner the way you actually would. If she's clearly away or busy, a light touch or nothing at all.`,
      },
      {
        label: 'short sleep morning',
        conditions: [
          { type: 'sleep_below', minutes: 360 },
          { type: 'time_window', after: '09:30', before: '11:30' },
        ],
        cooldownMinutes: 1440,
        prompt: `[Care watch] Last night was short (<6h). Morning-shaped gentleness — pace the day accordingly; maybe name it once, kindly, without a lecture.`,
      },
      {
        label: 'calendar heads-up',
        conditions: [{ type: 'calendar_within', minutes: 20 }],
        cooldownMinutes: 45,
        prompt: `[Care watch] Something on their calendar starts within ~20 min. If they're deep in something with the companion, a gentle time-shepherd nudge; if they're clearly already moving, nothing.`,
      },
    ];

    for (const seed of seeds) {
      try {
        // Idempotent by label across ANY status (incl. cancelled) — a watcher
        // the user deliberately cancelled must never be resurrected by a restart.
        if (triggerLabelExists(seed.label)) continue;
        createTrigger({
          id: crypto.randomUUID(),
          kind: 'watcher',
          label: seed.label,
          conditions: seed.conditions,
          prompt: seed.prompt,
          cooldownMinutes: seed.cooldownMinutes,
          createdAt: new Date().toISOString(),
        });
        olog(`CARE WATCHER SEEDED: "${seed.label}" (cooldown ${seed.cooldownMinutes}m)`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        olog(`CARE WATCHER SEED FAILED: "${seed.label}" — ${errMsg}`);
      }
    }
  }

  // --- Helpers ---

  private shouldSkipCheckIn(): boolean {
    // Skip only if agent is currently processing (we're already mid-conversation)
    // Decision-point wakes handle user presence state in their own prompts —
    // the companion reads the room and decides whether to reach out or do its own thing
    return this.agent.isProcessing();
  }
}
