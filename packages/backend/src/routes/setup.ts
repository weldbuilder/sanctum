// /api/setup: the setup wizard, served to the browser.
//
// The questions are ONE plan (scripts/setup-plan.mjs) that `npm run setup` walks in a terminal and this router hands to the in-app
// wizard; the writes are one function (scripts/setup-apply.mjs applySetup). So the two cannot drift.
//
//   GET  /status    open: is a password set (does the page need the setup code, or a sign-in)
//   GET  /plan      the steps for the current config. No secret is ever in it: a saved one is only marked `saved`.
//   POST /plan      the same, for the answers given so far ({ answers }): later steps appear, disappear and change their words
//   POST /validate  one step's value, as the app checks it: { id, value, answers? } -> { ok, message }
//   POST /test      a probe a step can run: { probe, value?, answers? } -> { ok, state, message, ... }; probe 'connection' is the
//                   onboarding's "Connect your AI" check ({ harness, method, key?, baseUrl?, providerName? })
//   POST /apply     { answers } -> writes sanctum.yaml, .env, Codex's config.toml and .mcp.json (backed up first), makes the home
//                   folder, ratifies plugins in person mode, makes the Discord lists, reloads the config -> { restartNeeded, changed[] }
//
// The gate: once a password exists, the normal session (authMiddleware). Before one exists the server is fail-closed, so every route
// but /status takes the setup code printed at boot (services/setup-code.ts) in an `x-setup-code` header. Nothing here writes a secret
// into a log line or a response: answers are never echoed, and a probe says only what it found.

import { Router, Request, Response, NextFunction } from 'express';
import { existsSync } from 'fs';
import { readOwnText, withScanMemo } from '../tenancy/own-files.js';
import { spawnSync } from 'child_process';
import { parse as parseCookie } from 'cookie';
import { PROJECT_ROOT, getSanctumConfig, getAppPasswordSource, reloadConfig, setAppPassword } from '../config.js';
import { currentTenant, tenantLocal } from '../tenancy/context.js';
import { tenantEditRefusal } from '../tenancy/edit.js';
import { authMiddleware, getCookieName } from '../middleware/auth.js';
import { checkSetupCode, ensureSetupCode, noteWrongGuess, setupGuessBlocked } from '../services/setup-code.js';
import { deleteWebSessionsExcept, getConfig } from '../services/db.js';
import { hasBotToken } from '../services/bot-token.js';
import { applySetup, gatherSetupEnv } from '../../../../scripts/setup-apply.mjs';
import { buildAnswers, describePlan, setupPlan, walkValues } from '../../../../scripts/setup-plan.mjs';
import { mergeBrowserMcp, parseCodexConfig, tomlFeatures } from '../../../../scripts/setup-lib.mjs';
import { join, resolve } from 'path';
import { householdMode } from '../tenancy/house.js';
import { checkConnection, liveDeps, type ConnectionHarness, type ConnectionMethod } from '../services/connection-check.js';
import { harnessHomesFor } from '../../../../scripts/setup-inherit.mjs';

const router = Router();

// Tenant mode: the wizard works on the folder of the tenant the request's host resolved to (gatherSetupEnv with tenantDir): its tenant.yaml, its .env,
// its home, its database. Nothing here reads or writes the process's sanctum.yaml, .env, home or environment, and no other tenant's folder.

const CODE_MESSAGES = {
  missing: 'Enter the setup code printed in the window where `npm start` runs.',
  wrong: 'That is not the setup code. It is printed in the window where `npm start` runs.',
  rotated: 'That is not the setup code, and after this many wrong tries it was replaced. The new one is printed in the window where `npm start` runs.',
  locked: 'Too many wrong setup codes from this address. Wait 15 minutes, then try again with the code printed in the window where `npm start` runs.',
  expired: 'That setup code has expired. A new one was printed in the window where `npm start` runs.',
} as const;

/** Session when a password exists; the boot setup code before one does. */
export function setupGate(req: Request, res: Response, next: NextFunction): void {
  if (getSanctumConfig().auth.password) { authMiddleware(req, res, next); return; }
  // Household mode: a companion's wizard sits behind the house's login, and the house's first run (its password) is the unprefixed /api/setup (tenancy/house-setup.ts).
  if (householdMode()) { res.status(409).json({ error: 'house_password_required', message: 'Set the house password first: open the app at its address (not a companion) and follow the setup screen.' }); return; }
  // Wrong guesses are counted per address, apart from the sign-in's limiter: no code, an expired code, a right code and the
  // routes' own 400s and 409s never count, so a person cannot lock themselves (or the sign-in) out by clicking around.
  const ip = req.ip || 'unknown';
  if (setupGuessBlocked(ip)) { res.status(429).json({ error: 'setup_code_locked', message: CODE_MESSAGES.locked }); return; }
  const verdict = checkSetupCode(req.get('x-setup-code'));
  if (verdict === 'ok') { next(); return; }
  if (verdict === 'wrong' || verdict === 'rotated') noteWrongGuess(ip);
  res.status(401).json({ error: verdict === 'expired' ? 'setup_code_expired' : 'setup_code', message: CODE_MESSAGES[verdict] });
}

// `codex --version` is a process spawn: once a minute is plenty for a wizard being clicked through.
const codexProbeL = tenantLocal<{ at: number; ok: boolean } | null>(() => null);
function codexInstalled(): boolean {
  const cached = codexProbeL.get();
  if (cached && Date.now() - cached.at < 60_000) return cached.ok;
  let ok = false;
  try { ok = spawnSync('codex', ['--version'], { stdio: 'pipe', shell: process.platform === 'win32', timeout: 5000 }).status === 0; } catch { ok = false; }
  codexProbeL.set({ at: Date.now(), ok });
  return ok;
}

// The same for DeepSeek Harness, run by the command the config names (agent.dsh.command, default `dsh`).
const dshProbeL = tenantLocal<{ at: number; ok: boolean } | null>(() => null);
function dshInstalled(): boolean {
  const cached = dshProbeL.get();
  if (cached && Date.now() - cached.at < 60_000) return cached.ok;
  let ok = false;
  try { ok = spawnSync(getSanctumConfig().agent?.dsh?.command || 'dsh', ['--version'], { stdio: 'pipe', shell: process.platform === 'win32', timeout: 5000 }).status === 0; } catch { ok = false; }
  dshProbeL.set({ at: Date.now(), ok });
  return ok;
}

function readDbToggle(): string | null {
  try { return getConfig('discord.enabled'); } catch { return null; }
}

/** Everything the plan reads, from the same places the terminal reads it; the app's own database answers the Discord toggle. */
export function buildPlan() {
  const rt = currentTenant();
  const env = gatherSetupEnv(PROJECT_ROOT, {
    processEnv: process.env,
    codexInstalled: codexInstalled(),
    discordToggle: readDbToggle(),
    savedPassword: getSanctumConfig().auth.password || '',
    ...(rt ? { tenantDir: rt.dir, tenantId: rt.id, household: householdMode() } : {}),
  });
  return setupPlan(env.existing, env);
}

/** What the probes read: the same places the plan does, for the current tenant in tenant mode. */
function probeEnv(discordToggle: string | null = null) {
  const rt = currentTenant();
  return gatherSetupEnv(PROJECT_ROOT, { processEnv: process.env, codexInstalled: codexInstalled(), discordToggle, ...(rt ? { tenantDir: rt.dir, tenantId: rt.id } : {}) });
}

/** The `answers` of a request body: a plain object, else nothing. */
function answersOf(body: unknown): Record<string, unknown> {
  const a = (body as { answers?: unknown } | null | undefined)?.answers;
  return a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
}

/** The open page asks this first: needs the setup code (no password yet), or a sign-in. */
router.get('/status', (_req, res) => {
  const passwordSet = !!getSanctumConfig().auth.password;
  if (!passwordSet && !householdMode()) ensureSetupCode(); // a page opened after the code expired finds a new one in the terminal
  res.json({ password_set: passwordSet, needs_code: !passwordSet });
});

function sendPlan(req: Request, res: Response): void {
  try {
    const plan = buildPlan();
    const { steps, notes, problems } = describePlan(plan, answersOf(req.body));
    res.json({ steps, notes, problems, passwordSource: getAppPasswordSource(), mode: getSanctumConfig().auth.password ? 'rerun' : 'first_run' });
  } catch (err) {
    console.error('[setup] plan failed:', (err as Error).message);
    // A tenant file that is a link or a pipe is the tenant's to put right, not a server fault.
    const refused = (err as { code?: string }).code === 'tenant_refused';
    res.status(refused ? 400 : 500).json({ error: `Could not read the current setup: ${(err as Error).message}` });
  }
}
router.get('/plan', setupGate, sendPlan);
router.post('/plan', setupGate, sendPlan);

router.post('/validate', setupGate, (req, res) => {
  const body = (req.body ?? {}) as { id?: unknown; value?: unknown };
  if (typeof body.id !== 'string' || !body.id) { res.status(400).json({ error: 'id must be the id of a step' }); return; }
  try {
    const plan = buildPlan();
    const w = walkValues(plan, { ...answersOf(req.body), [body.id]: body.value });
    const row = w.rows.find((r) => r.step.id === body.id);
    if (!row) { res.status(400).json({ error: `no step called ${body.id}` }); return; }
    if (!row.active) { res.json({ ok: true, active: false, message: '' }); return; }
    const problem = w.problems.find((p) => p.id === body.id);
    res.json({ ok: !problem, active: true, message: problem?.message ?? '' });
  } catch (err) {
    const refused = (err as { code?: string }).code === 'tenant_refused';
    res.status(refused ? 400 : 500).json({ error: `Could not check that answer: ${(err as Error).message}` });
  }
});

// What a Discord bot token looks like: three dot-separated URL-safe segments (id, time, secret). A shape check only: it says nothing
// about whether Discord accepts the token, and the token is not kept, logged or sent back.
const DISCORD_TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,32}\.[A-Za-z0-9_-]{5,8}\.[A-Za-z0-9_-]{25,}$/;

const PROBES = ['codex_config', 'discord_token', 'browser_filter', 'connection'] as const;

/** The onboarding's connection check (services/connection-check.ts): { harness, method, key?, baseUrl?, providerName? }. The key is used for
 *  one request to the provider and dropped: never stored, logged or sent back. A tenant's logins are looked for in its own harness homes. */
async function connectionProbe(body: Record<string, unknown>, res: Response): Promise<void> {
  const harness = body.harness === 'claude' || body.harness === 'codex' || body.harness === 'dsh' ? (body.harness as ConnectionHarness) : null;
  const method = body.method === 'login' || body.method === 'key' ? (body.method as ConnectionMethod) : null;
  if (!harness || !method) { res.status(400).json({ error: 'harness must be claude, codex or dsh, and method login or key' }); return; }
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 2000) : '');
  const rt = currentTenant();
  const homes = rt ? (() => { const h = harnessHomesFor(rt.dir); return { claudeConfigDir: h.CLAUDE_CONFIG_DIR, codexHome: h.CODEX_HOME }; })() : {};
  const result = await checkConnection(
    { harness, method, key: str(body.key), baseUrl: str(body.baseUrl), providerName: str(body.providerName) },
    liveDeps({ codexInstalled, dshInstalled, ...homes }),
  );
  res.json(result);
}

router.post('/test', setupGate, (req, res) => {
  const body = (req.body ?? {}) as { probe?: unknown; value?: unknown };
  const probe = body.probe;
  if (probe === 'connection') {
    connectionProbe(req.body as Record<string, unknown>, res).catch((err) => res.status(500).json({ error: `The check failed: ${(err as Error).message}` }));
    return;
  }
  try {
    if (probe === 'codex_config') {
      const env = probeEnv();
      const found = existsSync(env.tomlPath);
      const cx = parseCodexConfig(env.tomlText);
      res.json({
        ok: found || codexInstalled(), state: found ? 'found' : 'missing', installed: codexInstalled(), path: env.tomlPath,
        model: cx.model, model_provider: cx.modelProvider,
        providers: cx.providers.map((p: { key: string; name?: string; baseUrl: string }) => ({ key: p.key, name: p.name ?? '', base_url: p.baseUrl })), // never a key
        memories_on: tomlFeatures(env.tomlText).memories === true,
        message: found
          ? `Read ${env.tomlPath}: ${cx.providers.length} provider${cx.providers.length === 1 ? '' : 's'}${cx.model ? `, default model ${cx.model}` : ''}.`
          : `No ${env.tomlPath} yet. Codex uses its own default until you add a provider or run \`codex login\`.`,
      });
      return;
    }
    if (probe === 'discord_token') {
      const token = typeof body.value === 'string' ? body.value.trim() : '';
      const saved = hasBotToken('discord');
      if (!token) { res.json({ ok: saved, state: saved ? 'saved' : 'empty', saved, message: saved ? 'A Discord token is already saved in Settings.' : 'No token typed, and none saved yet. Paste it into Settings, or into .env as DISCORD_BOT_TOKEN.' }); return; }
      const looks = DISCORD_TOKEN_SHAPE.test(token);
      res.json({ ok: looks, state: looks ? 'shape_ok' : 'shape_wrong', saved, message: looks ? 'That has the shape of a Discord bot token. It was not saved: put it in Settings, or in .env as DISCORD_BOT_TOKEN.' : 'That does not look like a Discord bot token (three parts joined by dots). Copy it again from the developer portal, under Bot.' });
      return;
    }
    if (probe === 'browser_filter') {
      const env = probeEnv();
      const m = mergeBrowserMcp(env.mcpJsonText || '', resolve(PROJECT_ROOT, 'examples', 'browser-seat-neko', 'mcp-filter.mjs'), resolve(env.tenantDir || PROJECT_ROOT, 'data', 'browser-out')) as { action: string; reason?: string };
      const message = m.action === 'exists' ? `${env.mcpJsonPath} already has a filtered "browser" entry.`
        : m.action === 'refused' ? `${env.mcpJsonPath} cannot be changed: ${m.reason}.`
          : m.action === 'upgrade' ? `${env.mcpJsonPath} has a "browser" entry ${m.reason === 'unfiltered' ? 'with no filter (the companion could run arbitrary code)' : 'that calls the filter the old way'}. Setup can replace it.`
            : `${env.mcpJsonPath} has no "browser" entry yet. Setup can add one, behind the filter.`;
      res.json({ ok: m.action === 'exists', state: m.action, message });
      return;
    }
    res.status(400).json({ error: 'unknown probe', probes: PROBES });
  } catch (err) {
    res.status(500).json({ error: `The check failed: ${(err as Error).message}` });
  }
});

const applyingL = tenantLocal(() => ({ on: false }));

router.post('/apply', setupGate, (req, res) => {
  const applying = applyingL.get();
  if (applying.on) { res.status(409).json({ error: 'Setup is already being applied.' }); return; }
  applying.on = true;
  const rt = currentTenant();
  try {
    const sent = answersOf(req.body);
    const plan = buildPlan();
    const w = walkValues(plan, sent);
    if (w.problems.length) { res.status(400).json({ error: 'Some answers need another look.', problems: w.problems }); return; }
    const answers = buildAnswers(w.values, plan);
    const notes: string[] = [];
    // Household mode: the plan has no password step, so a password sent anyway is not read; say so.
    if (rt && householdMode() && Object.hasOwn(sent, 'password')) notes.push('The house has one password, so this companion keeps none of its own: the password answer was ignored.');
    const passwordBefore = getSanctumConfig().auth.password || '';
    const sourceBefore = rt ? 'dotenv' : getAppPasswordSource();
    // A tenant.yaml the tenant could not start with is refused before anything is written: the same checks the config editor makes (confinement,
    // process-only keys, hosts, timezone) plus the dry run of the candidate over the inherited base.
    const check = rt ? (candidate: unknown) => tenantEditRefusal(candidate, existsSync(join(rt.dir, 'tenant.yaml')) ? readOwnText(join(rt.dir, 'tenant.yaml')) : '') : undefined;
    // ONE scan of the tenant folder per request: the pre-write check, the dry run and the reload below share it (withScanMemo; this part is synchronous).
    const result = withScanMemo(() => {
      const applied = applySetup(answers, plan, { say: (line = '') => { if (line) notes.push(line); } }, { writer: 'the setup wizard', backupConfig: true, ...(check ? { check } : {}) });
      if (rt) {
        // A tenant's password and key go to its own config and .env (applySetup wrote them there), never into process.env: this tenant reads them again,
        // after the same checks as at boot, and no other tenant is touched.
        if (answers.password) { const note = rt.setPassword(answers.password); if (note) notes.push(note); }
        try { rt.reload(); } catch (err) { notes.push(`The new settings were saved but could not be loaded until a restart: ${(err as Error).message}`); }
      }
      return applied;
    });
    if (!rt) {
      // The running process reads what it was started with first: hand it the new password (and key) so the saved password signs in now.
      // The password goes to the config's own holder, never into process.env (provider children copy that); the key is one they use.
      if (answers.password) setAppPassword(answers.password);
      if (answers.provider === 'claude' && answers.anthropicKey) process.env.ANTHROPIC_API_KEY = answers.anthropicKey;
      // DeepSeek Harness reads its route's key from the environment it hands the child (docs/DSH.md): the variable the config names.
      if (answers.provider === 'dsh' && answers.dshKey) process.env[(getSanctumConfig().agent?.dsh?.api_key_env) || 'DEEPSEEK_API_KEY'] = answers.dshKey;
      try { reloadConfig(); } catch (err) { notes.push(`The new settings were saved but could not be loaded until a restart: ${(err as Error).message}`); }
    }
    // A changed password signs every other browser out: whoever held the old one (or a session minted with it) no longer has a way in.
    // A first run counts too: clearing the password and setting it again is how a leaked one is reset, and the
    // sessions minted under the old one are still in the table, so they are all removed (the caller has none).
    if (answers.password && answers.password !== passwordBefore) {
      try {
        const keep = passwordBefore ? (parseCookie(req.headers.cookie || '')[getCookieName()] || null) : null;
        const gone = deleteWebSessionsExcept(keep);
        if (gone) notes.push(`The password ${passwordBefore ? 'changed' : 'was set'}, so ${gone} ${passwordBefore ? 'other ' : ''}signed-in browser${gone === 1 ? ' was' : 's were'} signed out.`);
      } catch (err) { notes.push(`The password changed, but other sessions could not be signed out: ${(err as Error).message}`); }
    }
    // The parent's APP_PASSWORD beats .env at every start (dotenv never overrides it): the new one works until the next restart only.
    const parentKeepsOld = !!answers.password && answers.password !== passwordBefore && sourceBefore === 'parent_env';
    if (parentKeepsOld) {
      notes.unshift('APP_PASSWORD is set by whatever starts this app (pm2, systemd, a shell), not by .env. The new password works now, but you must change it there too, or the old password comes back at the next restart.');
    }
    console.log(`[setup] applied: ${result.changed.map((c: { what: string }) => c.what).join(', ')}`);
    res.json({
      ok: true,
      restartNeeded: result.restartNeeded,
      passwordSource: rt ? (rt.config.auth.password ? 'dotenv' : 'none') : getAppPasswordSource(),
      passwordKeptByParent: parentKeepsOld,
      changed: result.changed,
      notes: [...new Set([...notes, ...result.leftOut.map((id: string) => `${id} was left out of plugins.enabled. Ratify it later in Settings > Plugins, then add it to plugins.enabled.`)])],
    });
  } catch (err) {
    console.error('[setup] apply failed:', (err as Error).message);
    // A tenant.yaml that would not start is the person's answer to change, not a server fault.
    const refused = (err as { code?: string }).code === 'tenant_refused';
    res.status(refused ? 400 : 500).json({ error: refused ? `Those answers cannot be saved: ${(err as Error).message}` : `Could not apply the setup: ${(err as Error).message}` });
  } finally { applying.on = false; }
});

export default router;
