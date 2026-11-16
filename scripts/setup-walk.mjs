// setup-walk.mjs — `npm run setup`, as a walk over the plan (setup-plan.mjs). It prints the plan's words, asks each step that
// applies, and hands the answers to applySetup (setup-apply.mjs). `io` is { say(line), prompt(text) }: the terminal's
// (scripts/setup.mjs) or a script's (scripts/setup-walk.test.mjs replays the recorded transcripts through it).
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { applySetup, gatherSetupEnv } from './setup-apply.mjs';
import { TENANT_ID_RE, harnessHomesFor, readProcessFile, tenantFilesProblem, tenantFolderProblem, authKeyMissingProblem, tenantsBlockOf, tenantsDirProblem } from './setup-inherit.mjs';
import { buildAnswers, defaultText, evalStep, isActive, parseAnswer, setupPlan, settle, skipFill } from './setup-plan.mjs';

/** Ask one step in the terminal's words and return what was answered, as { value, generated }. */
async function askStep(step, r, v, io) {
  // `shown` is what the brackets print when it is not the default itself (a saved .env value is shown as the line has it).
  const ask = async (q, def, shown = def) => {
    const text = (await io.prompt(def ? `${q} [${shown}] ` : `${q} `)).trim();
    return text || def;
  };
  for (;;) {
    let text;
    if (r.kind === 'yesno') {
      const shown = r.style === 'bracket' ? `[${r.default ? 'Y/n' : 'y/N'}]` : `(${r.default ? 'Y/n' : 'y/N'})`;
      text = (await ask(`${r.question} ${shown}`, '')).toLowerCase();
    } else {
      const def = defaultText(r);
      text = await ask(r.question, def, step.display ? step.display(def) : def);
    }
    // A yes/no and a choice are parsed from what was typed (an empty answer already is the default); text and secrets are kept.
    let value = r.kind === 'text' || r.kind === 'secret' ? text : parseAnswer(step, r, text, v);
    let generated = false;
    if (step.generate && !value) { value = io.generate ? io.generate() : step.generate(); generated = true; }
    const s = settle(step, value, v);
    for (const line of s.lines) io.say(line);
    if (s.set) Object.assign(v, s.set);
    if (step.retry) {
      const problem = step.validate?.(s.value, v) || '';
      if (problem) { for (const line of problem.split('\n')) io.say(line); continue; }
    }
    return { value: s.value, generated };
  }
}

/** Walk the plan, asking in the terminal's words, then write everything. Returns what applySetup returns.
 *  `phase`: 'one' (the first-run questions; whatever is already set is kept and not asked), 'more' (the rest), 'all' (every question,
 *  as the wizard asked before it had phases). A tenant's wizard is always 'all'.
 *  `setAuthMode`: the terminal wizard's writer for the Anthropic auth mode (a pasted key selects api_key); absent for a tenant. */
export async function runSetup({ root, io, processEnv, homeDir, codexInstalled, timezoneDefault, tenant, create, phase = 'one', setAuthMode }) {
  // `--tenant <id>`: the same plan against <tenants.dir>/<id>/, which must exist unless `--create` says to make it.
  let tenantDir = '';
  if (tenant !== undefined) {
    if (!TENANT_ID_RE.test(String(tenant))) throw new Error(`${JSON.stringify(tenant)} is not a tenant id. Use a-z, 0-9 and - (up to 32 characters, not starting with -).`);
    const block = tenantsBlockOf(root, readProcessFile(root), homeDir);
    if (!block) throw new Error('sanctum.yaml has no tenants: block, so there are no tenants to set up. Add `tenants:` with a `dir:` (see docs/MULTI-TENANT.md).');
    // tenants.dir that is the app folder itself would read every folder of the app as a tenant (boot refuses it too).
    const dirBad = tenantsDirProblem(block.dir, root);
    if (dirBad) throw new Error(dirBad);
    const authBad = authKeyMissingProblem(block.dir, block);
    if (authBad) throw new Error(authBad);
    tenantDir = join(block.dir, tenant);
    // A link is never a tenant folder (boot skips links, and one pointing at the app folder would make the wizard write over the process's own .env).
    const bad = tenantFolderProblem(block.dir, tenantDir, root);
    if (bad) throw new Error(bad);
    if (!existsSync(tenantDir)) {
      if (!create) throw new Error(`There is no folder ${tenantDir}. Run again with --create to make it.`);
      mkdirSync(tenantDir, process.platform === 'win32' ? { recursive: true } : { recursive: true, mode: 0o700 });
      const made = tenantFolderProblem(block.dir, tenantDir, root); // (tenants.dir itself may have been a link)
      if (made) throw new Error(made);
    }
    // A link or a second hard link at one of the tenant's own files or folders: boot skips such a tenant, and a write would go through it. The quick look (the
    // top of the folder) fails before the questions; the ONE full scan of the wizard is the one applySetup makes before its first write.
    const files = tenantFilesProblem(tenantDir, { quick: true });
    if (files) throw new Error(files);
  }
  io.say();
  io.say('Sanctum Mobile setup');
  io.say('====================');
  const mode = tenantDir ? 'all' : phase;
  io.say(mode === 'one' ? 'Just the essentials. Press Enter to keep the value in brackets. Run this again any time.'
    : mode === 'more' ? 'The other options. Press Enter to keep the value in brackets. Run this again any time.'
      : 'A few questions. Press Enter to keep the value in brackets. Run this again any time.');
  io.say();
  if (tenantDir) {
    const h = harnessHomesFor(tenantDir);
    io.say(`Tenant ${tenant}: ${tenantDir}`);
    io.say(`Its logins live in ${join(tenantDir, 'data', 'harness')} (CLAUDE_CONFIG_DIR=${h.CLAUDE_CONFIG_DIR}, CODEX_HOME=${h.CODEX_HOME}, DSH_HOME=${h.DSH_HOME}); log in per tenant, never copy credential files between tenants.`);
    io.say();
  }

  const env = gatherSetupEnv(root, { processEnv, homeDir, codexInstalled, ...(timezoneDefault ? { timezoneDefault } : {}), ...(tenantDir ? { tenantDir, tenantId: tenant, operator: true } : {}) });
  env.phase = mode;
  const plan = setupPlan(env.existing, env);
  const v = {};
  for (const step of plan) {
    plan.reset();
    const intro = step.skip ? null : step.intro?.(v);
    if (intro) {
      if (intro.heading) io.say(`— ${intro.heading} —`);
      for (const line of intro.lines || []) io.say(line);
    }
    if (!isActive(step, v)) {
      // Not asked on this run: it keeps the value Enter would have taken (and says so when that value was already in the config).
      const f = skipFill(step, v);
      if (f) { v[step.id] = f.value; if (f.set) Object.assign(v, f.set); }
      for (const line of step.skip ? (f?.line ? [f.line] : []) : step.otherwise?.(v) || []) io.say(line);
    } else {
      const r = evalStep(step, v);
      for (const line of r.help) io.say(line);
      for (const line of r.cli) io.say(line);
      const { value, generated } = await askStep(step, r, v, io);
      v[step.id] = value;
      if (r.meta?.digest) v[`${step.id}#digest`] = r.meta.digest;
      for (const line of step.after?.(value, v, { generated }) || []) io.say(line);
    }
    if (!step.skip) for (const line of step.outro?.(v) || []) io.say(line);
  }

  const answers = buildAnswers(v, plan);
  const result = applySetup(answers, plan, { say: (s = '') => io.say(s) }, setAuthMode ? { setAuthMode } : {});
  io.say();
  if (tenantDir) {
    io.say('Tenants are read when the app starts: restart it to serve this one.');
    io.say(`To change any of this later: Settings in the app, or npm run setup -- --tenant ${tenant} again.`);
    return result;
  }
  io.say('Next, in this folder:');
  io.say('  npm run build');
  io.say('  npm start');
  io.say('Then open the address it prints and log in with your password.');
  io.say('To change any of this later: Settings in the app, or npm run setup again.');
  if (mode === 'one') io.say('More options (Discord, the browser, plugins, pictures, Codex providers, write folders): npm run setup -- --more');
  return result;
}
