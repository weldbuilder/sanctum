// The "Optional: pictures and summaries" step group: image generation (imagegen.*) and the companion-voiced summarizer (agent.summarizer.*).
// Asked only while the block is absent or off; written through the same applySetup as every other step (yaml backed up, .env owner-only).
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { appFixture } from './__fixtures__/setup/scenarios.mjs';
import { applySetup, gatherSetupEnv } from './setup-apply.mjs';
import { buildAnswers, describePlan, setupPlan, walkValues } from './setup-plan.mjs';

const made = [];
afterEach(() => { while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true }); });

const GROUP = ['imageProvider', 'imageKey', 'summaryWho', 'summaryEndpoint', 'summaryKey'];
const KEY_IMG = 'rw-secret-image-key-123';
const KEY_SUM = 'sk-or-secret-summary-key';

function sandbox({ yaml, files = {} } = {}) {
  const sbx = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'setup-optional-')));
  made.push(sbx);
  const root = path.join(sbx, 'app');
  appFixture(fs, path, root);
  const home = path.join(sbx, 'home', 'Documents', 'companion-home');
  fs.mkdirSync(path.join(home, 'identity'), { recursive: true });
  fs.writeFileSync(path.join(home, 'identity', 'profile.md'), 'p\n');
  if (yaml) fs.writeFileSync(path.join(root, 'sanctum.yaml'), JSON.stringify(yaml));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(sbx, rel)), { recursive: true }); fs.writeFileSync(path.join(sbx, rel), text); }
  const env = gatherSetupEnv(root, { processEnv: {}, homeDir: path.join(sbx, 'home'), codexInstalled: true, timezoneDefault: 'UTC' });
  const plan = setupPlan(env.existing, env);
  const asked = (sent = {}) => walkValues(plan, { home, ...sent }).rows.filter((r) => r.active && GROUP.includes(r.step.id)).map((r) => r.step.id);
  const run = (sent) => {
    const w = walkValues(plan, { home, provider: 'claude', password: 'a-long-password', ...sent });
    expect(w.problems).toEqual([]);
    const said = [];
    const result = applySetup(buildAnswers(w.values, plan), plan, { say: (l = '') => said.push(l) }, { writer: 'the setup wizard', backupConfig: true });
    return { result, said, w };
  };
  return { sbx, root, home, env, plan, asked, run };
}
const read = (p) => fs.readFileSync(p, 'utf-8');
const yamlOf = (env) => read(env.yamlPath);

describe('the optional group: what is asked', () => {
  it('a fresh install is asked the provider and who writes summaries, and nothing else until an answer calls for it', () => {
    const { asked } = sandbox();
    expect(asked()).toEqual(['imageProvider', 'summaryWho']);
    expect(asked({ imageProvider: 'none', summaryWho: 'chat' })).toEqual(['imageProvider', 'summaryWho']);
  });

  it('a fresh install with rolling memory on is asked about the summarizer once, and the old summarizer prompts are gone', () => {
    const { plan, asked } = sandbox();
    const w = walkValues(plan, { provider: 'codex', rolling: true });
    const ids = w.rows.filter((r) => r.active).map((r) => r.step.id);
    expect(ids.filter((id) => /summar/i.test(id))).toEqual(['summaryWho']);
    expect(ids).not.toContain('summarizerModel');
    expect(ids).not.toContain('summarizerProvider');
    expect(asked({ provider: 'codex', rolling: true })).toEqual(['imageProvider', 'summaryWho']);
  });

  it('with a legacy agent.rolling.model in the yaml, "chat" says that model writes the summaries', () => {
    const { plan } = sandbox({ yaml: { agent: { rolling: { model: 'old-model' } } } });
    const d = describePlan(plan, { summaryWho: 'chat' });
    expect(JSON.stringify(d.notes)).toContain('old-model writes them (agent.rolling.model, deprecated; move it to agent.summarizer.model)');
    const fresh = describePlan(sandbox().plan, { summaryWho: 'chat' });
    expect(JSON.stringify(fresh.notes)).toContain('The chat model writes them.');
  });

  it('the longest path is five prompts', () => {
    const { asked } = sandbox();
    expect(asked({ imageProvider: 'runware', summaryWho: 'other' })).toEqual(GROUP);
    expect(GROUP).toHaveLength(5);
    expect(asked({ imageProvider: 'replicate', summaryWho: 'other' })).toHaveLength(5);
  });

  it('a configured install sees no new prompts: image generation on, a summarizer chosen', () => {
    const { asked, plan } = sandbox({ yaml: { imagegen: { provider: 'runware' }, agent: { summarizer: { provider: 'openai-compat', model: 'm', base_url: 'https://x.test/v1' } } } });
    expect(asked()).toEqual([]);
    expect(asked({ imageProvider: 'replicate', summaryWho: 'other' })).toEqual([]);
    const d = describePlan(plan, {});
    expect(d.steps.map((s) => s.id).filter((id) => GROUP.includes(id))).toEqual([]);
    // ...and the walk says nothing about it either (no heading in the notes)
    expect(JSON.stringify(d.notes)).not.toMatch(/pictures|summaries/i);
  });

  it('each half is judged alone: pictures on asks only about summaries, and the other way round', () => {
    expect(sandbox({ yaml: { imagegen: { provider: 'replicate' } } }).asked()).toEqual(['summaryWho']);
    expect(sandbox({ yaml: { agent: { summarizer: { provider: 'claude' } } } }).asked()).toEqual(['imageProvider']);
  });

  it('a block at "none" or "" counts as absent', () => {
    const { asked } = sandbox({ yaml: { imagegen: { provider: 'none' }, agent: { summarizer: { provider: '' } } } });
    expect(asked()).toEqual(['imageProvider', 'summaryWho']);
  });

  it('a provider already chosen but with no key is not asked again (npm run doctor says so)', () => {
    expect(sandbox({ yaml: { imagegen: { provider: 'runware' } } }).asked()).not.toContain('imageProvider');
  });

  it('the in-app plan carries the same steps, with the key steps as secrets that never hold a saved value', () => {
    const { plan } = sandbox({ files: { 'app/.env': `RUNWARE_API_KEY=${KEY_IMG}\n` } });
    const d = describePlan(plan, { imageProvider: 'runware', summaryWho: 'other' });
    const g = d.steps.filter((s) => GROUP.includes(s.id));
    expect(g.map((s) => s.id)).toEqual(GROUP);
    expect(g.map((s) => s.kind)).toEqual(['choice', 'secret', 'choice', 'text', 'secret']);
    expect(g[0].options.map((o) => o.value)).toEqual(['none', 'runware', 'replicate']);
    expect(g[2].options.map((o) => o.value)).toEqual(['chat', 'other']);
    expect(g[2].question).toBe("Write your companion's own summaries with");
    expect(g[1]).toMatchObject({ saved: true });
    expect(JSON.stringify(d)).not.toContain(KEY_IMG);
  });

  it('refuses an endpoint that is not "<https url> <model>"', () => {
    const { plan } = sandbox();
    for (const bad of ['', 'https://x.test/v1', 'not-a-url model', 'https://x.test/v1 a b']) {
      const w = walkValues(plan, { summaryWho: 'other', summaryEndpoint: bad });
      expect(w.problems.map((p) => p.id), bad).toContain('summaryEndpoint');
    }
    expect(walkValues(plan, { summaryWho: 'other', summaryEndpoint: ' https://openrouter.ai/api/v1   some/model ' }).problems.map((p) => p.id)).not.toContain('summaryEndpoint');
  });
});

describe('the optional group: what is written', () => {
  it('"nothing" and "the chat model" write no block and no key', () => {
    const { run, env } = sandbox();
    run({ imageProvider: 'none', summaryWho: 'chat' });
    const y = yamlOf(env);
    expect(y).not.toContain('imagegen');
    expect(y).not.toContain('summarizer');
    expect(read(env.envPath)).not.toMatch(/RUNWARE|REPLICATE|SUMMARIZER/);
  });

  it('Runware: provider in sanctum.yaml, key in .env as RUNWARE_API_KEY, the key nowhere else', () => {
    const { run, env } = sandbox();
    const { result, said, w } = run({ imageProvider: 'runware', imageKey: KEY_IMG });
    expect(yamlOf(env)).toMatch(/imagegen:\n\s+provider: "runware"/);
    expect(yamlOf(env)).not.toContain(KEY_IMG);
    expect(read(env.envPath)).toContain(`RUNWARE_API_KEY=${KEY_IMG}`);
    expect(JSON.stringify({ result, said })).not.toContain(KEY_IMG);
    expect(w.values.imageKey).toBe(KEY_IMG);
    if (process.platform !== 'win32') expect(fs.statSync(env.envPath).mode & 0o077).toBe(0);
  });

  it('Replicate: key in .env as REPLICATE_API_TOKEN', () => {
    const { run, env } = sandbox();
    run({ imageProvider: 'replicate', imageKey: 'r8_secret' });
    expect(yamlOf(env)).toMatch(/provider: "replicate"/);
    expect(read(env.envPath)).toContain('REPLICATE_API_TOKEN=r8_secret');
  });

  it('a provider with the key left empty writes the provider only', () => {
    const { run, env } = sandbox();
    run({ imageProvider: 'runware' });
    expect(yamlOf(env)).toMatch(/provider: "runware"/);
    expect(read(env.envPath)).not.toContain('RUNWARE_API_KEY=');
  });

  it('another model: openai-compat block with base_url and model, key in .env as SUMMARIZER_API_KEY', () => {
    const { run, env } = sandbox();
    const { result, said } = run({ summaryWho: 'other', summaryEndpoint: 'https://openrouter.ai/api/v1 deepseek/deepseek-chat', summaryKey: KEY_SUM });
    const y = yamlOf(env);
    expect(y).toMatch(/summarizer:/);
    expect(y).toContain('provider: "openai-compat"');
    expect(y).toContain('base_url: "https://openrouter.ai/api/v1"');
    expect(y).toContain('model: "deepseek/deepseek-chat"');
    expect(y).toContain('api_key_env: "SUMMARIZER_API_KEY"');
    expect(y).not.toContain(KEY_SUM);
    expect(read(env.envPath)).toContain(`SUMMARIZER_API_KEY=${KEY_SUM}`);
    expect(JSON.stringify({ result, said })).not.toContain(KEY_SUM);
    expect(result.restartNeeded).toBe(true);
  });

  it('keeps the api_key_env the yaml already names, and writes the key under it', () => {
    const { run, env } = sandbox({ yaml: { agent: { summarizer: { provider: '', api_key_env: 'MY_SUM_KEY', max_output_tokens: 1500 } } } });
    run({ summaryWho: 'other', summaryEndpoint: 'https://x.test/v1 big-model', summaryKey: KEY_SUM });
    expect(yamlOf(env)).toContain('api_key_env: "MY_SUM_KEY"');
    expect(yamlOf(env)).toContain('max_output_tokens: 1500');
    expect(read(env.envPath)).toContain(`MY_SUM_KEY=${KEY_SUM}`);
    expect(read(env.envPath)).not.toContain('SUMMARIZER_API_KEY=');
  });

  it('backs up sanctum.yaml and .env first, and the copy of .env is owner-only', () => {
    const { run, root, env } = sandbox({ yaml: { identity: { companion_name: 'Old' } }, files: { 'app/.env': 'APP_PASSWORD=old-password\n' } });
    run({ imageProvider: 'runware', imageKey: KEY_IMG, password: '' });
    const baks = fs.readdirSync(root).filter((f) => f.includes('.bak-'));
    expect(baks.filter((f) => f.startsWith('sanctum.yaml.bak-'))).toHaveLength(1);
    const envBak = baks.find((f) => f.startsWith('.env.bak-'));
    expect(read(path.join(root, envBak))).toBe('APP_PASSWORD=old-password\n');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(root, envBak)).mode & 0o077).toBe(0);
    expect(read(env.envPath)).toContain('APP_PASSWORD=old-password');
  });

  it('re-running setup on the configured result changes neither block nor key', () => {
    const first = sandbox();
    first.run({ imageProvider: 'runware', imageKey: KEY_IMG, summaryWho: 'other', summaryEndpoint: 'https://x.test/v1 big-model', summaryKey: KEY_SUM });
    const yaml1 = yamlOf(first.env);
    const env1 = read(first.env.envPath);
    const env2 = gatherSetupEnv(first.root, { processEnv: {}, homeDir: path.join(first.sbx, 'home'), codexInstalled: true, timezoneDefault: 'UTC' });
    const plan2 = setupPlan(env2.existing, env2);
    const w = walkValues(plan2, { home: first.home, provider: 'claude' });
    expect(w.rows.filter((r) => r.active && GROUP.includes(r.step.id))).toEqual([]);
    applySetup(buildAnswers(w.values, plan2), plan2, {}, { writer: 'the setup wizard', backupConfig: true });
    const after = (txt) => txt.replace(/^#.*\n/gm, '');
    expect(after(read(env2.yamlPath))).toBe(after(yaml1));
    expect(read(env2.envPath)).toBe(env1);
  });
});
