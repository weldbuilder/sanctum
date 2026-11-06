// The terminal wizard, replayed. scripts/__fixtures__/setup holds what the ORIGINAL `npm run setup` (before its questions
// became a plan) printed and wrote, recorded through a real pseudo-terminal for every scenario in scenarios.mjs
// (scripts/setup-proof.mjs makes the recording and compares two checkouts). This replays each scenario through the plan's walker
// in-process and requires the same words and the same bytes in sanctum.yaml, .env, config.toml, .mcp.json, the Discord lists and
// the ratification ledger. POSIX only: the recording holds POSIX paths and plugin digests of LF files.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { appFixture, answersFor, fileText, normalize, scenarios } from './__fixtures__/setup/scenarios.mjs';
import { generatePassword } from './setup-lib.mjs';
import { runSetup } from './setup-walk.mjs';

// Where the identity ledger lands: the app's own data/ for a single-tenant scenario (the original, strict form), a tenant's data/ for a tenant one.
const ledgerRe = (sc) => (sc.tenant ? /^app\/tenants\/[^/]+\/data\/identity\// : /^app\/data\/identity\//);
const ledgerDirRe = (sc) => (sc.tenant ? /^app\/tenants\/[^/]+\/data\/identity/ : /^app\/data\/identity/);
const FIX = path.join(import.meta.dirname, '__fixtures__', 'setup');
const require = createRequire(import.meta.url);
const posix = process.platform !== 'win32';
// The Codex sandbox may write /tmp and the temp folder; a checkout inside one would put the plugin ledger in reach and change the recording.
const inTemp = [tmpdir(), '/tmp'].some((t) => FIX.startsWith(path.resolve(t) + path.sep));

const walkFiles = (dir, out = []) => {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walkFiles(p, out); else if (it.isFile()) out.push(p);
  }
  return out;
};
const walkDirs = (dir, out = []) => {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!it.isDirectory()) continue;
    const p = path.join(dir, it.name);
    out.push(p);
    walkDirs(p, out);
  }
  return out;
};
const digestOf = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// The same bytes the recording's preload hands crypto.randomBytes.
const fixedBytes = Buffer.from(Array.from({ length: 16 }, (_v, i) => (i * 7 + 3) % 256));

const OPTIONAL_PROMPTS = ['Make pictures with', "Write your companion's own summaries with"];
// The orchestrator question was added after the recordings of the original (and with phases): the recordings run `--all`, where it is answered with its
// default and its block is stripped below. A scenario with its own `phase` records it for real.
const ORCHESTRATOR_PROMPT = 'Let your companion keep time';
const withoutOrchestrator = (t) => t.replace(/^The orchestrator is the clock behind your companion[\s\S]*?\n\n/gm, '');
/** The optional group's block (heading to the blank line the group ends with), which the recordings predate. */
const withoutOptionalGroup = (t) => t.replace(/^— Optional: pictures and summaries —\n[\s\S]*?\n\n/gm, '');

/** Run `npm run setup` for one list of answers, in-process: the transcript is every line said, and every prompt followed by its answer. */
async function walk(sbx, answers, codex, sc = {}) {
  let out = '';
  const queue = [...answers];
  const io = {
    say: (s = '') => { out += `${s}\n`; },
    prompt: async (text) => {
      // The optional group added after the recording ("Optional: pictures and summaries"): answered with its defaults and stripped from the
      // transcript below, so the recordings of the original stay as they were. setup-optional.test.mjs covers the group itself.
      if (OPTIONAL_PROMPTS.some((q) => text.startsWith(q))) { out += `${text}\n`; return ''; }
      if (!sc.phase && text.startsWith(ORCHESTRATOR_PROMPT)) { out += `${text}\n`; return ''; }
      const next = queue.shift();
      if (!next) throw new Error(`no answer left for the prompt ${JSON.stringify(text)}`);
      if (!text.includes(next[0])) throw new Error(`the script expected a prompt containing ${JSON.stringify(next[0])} but the wizard asked ${JSON.stringify(text)}`);
      out += `${text}${next[1]}\n`;
      return next[1];
    },
    generate: () => generatePassword(fixedBytes),
  };
  const processEnv = {};
  await runSetup({ root: path.join(sbx, 'app'), io, processEnv, homeDir: path.join(sbx, 'home'), codexInstalled: !!codex, timezoneDefault: 'UTC', tenant: sc.tenant, create: sc.create, phase: sc.phase || 'all' });
  expect(queue, 'answers the wizard never asked for').toEqual([]);
  return out;
}

function build(sc, sbx) {
  const app = path.join(sbx, 'app');
  fs.mkdirSync(path.join(sbx, 'home'), { recursive: true });
  appFixture(fs, path, app);
  if (sc.extraPlugin) {
    const d = path.join(app, 'plugins', sc.extraPlugin);
    fs.mkdirSync(path.join(d, 'dsh'), { recursive: true });
    fs.writeFileSync(path.join(d, 'sanctum.plugin.json'), JSON.stringify({ id: sc.extraPlugin, name: `The ${sc.extraPlugin} plugin` }));
    fs.writeFileSync(path.join(d, 'dsh', 'index.mjs'), `export default '${sc.extraPlugin}';\n`);
  }
  for (const [rel, text] of Object.entries(sc.beforeRun || {})) fs.writeFileSync(path.join(sbx, rel), fileText(text, sbx));
  for (const [rel, text] of Object.entries(sc.files || {})) {
    const p = path.join(sbx, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, fileText(text, sbx));
  }
  for (const [rel, rows] of Object.entries(sc.db || {})) {
    const p = path.join(sbx, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const Database = require('better-sqlite3');
    const db = new Database(p);
    db.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');
    for (const [k, v] of Object.entries(rows)) db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(k, v);
    db.close();
  }
}

describe.skipIf(!posix || inTemp)('the terminal wizard prints and writes what the original did', () => {
  it('has a recording for every scenario, and recorded the owner-only folders it makes', () => {
    for (const name of ['browser-add', 'discord-on']) {
      const dirs = JSON.parse(fs.readFileSync(path.join(FIX, `${name}.dirs.json`), 'utf-8'));
      expect(Object.values(dirs).some((d) => d.private), name).toBe(true);
    }
    expect(scenarios.length).toBeGreaterThanOrEqual(30);
    for (const sc of scenarios) {
      expect(fs.existsSync(path.join(FIX, `${sc.name}.transcript.txt`)), sc.name).toBe(true);
      expect(fs.existsSync(path.join(FIX, `${sc.name}.files.json`)), sc.name).toBe(true);
    }
  });

  it.each(scenarios.map((s) => [s.name, s]))('%s', async (_name, sc) => {
    const sbx = fs.realpathSync(fs.mkdtempSync(path.join(FIX, '.sbx-')));
    try {
      build(sc, sbx);
      const before = new Map(walkFiles(sbx).map((p) => [p, digestOf(p)]));
      const dirsBefore = new Set(walkDirs(sbx));
      const existedBefore = new Set([...before.keys()].map((p) => normalize(path.relative(sbx, p).replaceAll('\\', '/'), sbx)));
      let transcript = await walk(sbx, answersFor(sc, sbx), sc.codex, sc);
      if (sc.again) {
        for (const [rel, text] of Object.entries(sc.again.files || {})) fs.writeFileSync(path.join(sbx, rel), fileText(text, sbx));
        transcript += `\n=== the same setup, run again ===\n${await walk(sbx, answersFor(sc.again, sbx), sc.codex, sc)}`;
      }
      const want = fs.readFileSync(path.join(FIX, `${sc.name}.transcript.txt`), 'utf-8');
      // The one thing added since the recording: a home made from the starter template gets its identity baseline (the first journal line and
      // the ratified copy, by `setup`) and the wizard says so in one line. The ledger holds timestamps, so it is checked below, not byte for byte.
      const baselineSaid = /^Identity: the starter files in .* are recorded as ratified \([0-9a-f]{12}\)\./m.test(transcript);
      expect(normalize((sc.phase ? withoutOptionalGroup(transcript) : withoutOrchestrator(withoutOptionalGroup(transcript))).replace(/^Identity: .*\n/gm, ''), sbx)).toBe(want);
      // The Identity line itself is checked, not stripped: only the digest (and the sandbox path, through normalize) may vary; the rest is verbatim.
      const identityLines = normalize(transcript, sbx).split('\n').filter((l) => l.startsWith('Identity: '));
      for (const line of identityLines) {
        const masked = line.replace(/(are recorded as ratified \()[0-9a-f]{12}(\))/, '$1<digest>$2');
        expect(masked, 'the Identity line says exactly what it is expected to say').toMatch(
          /^Identity: (?:the starter files in .+ are recorded as ratified \(<digest>\)\. Changes after this wait for you in Settings → You & them\.|no ledger written \(the identity folder already has a ledger\)\.)$/);
      }

      const golden = JSON.parse(fs.readFileSync(path.join(FIX, `${sc.name}.files.json`), 'utf-8'));
      const got = {};
      const ledgerFiles = [];
      for (const p of walkFiles(sbx)) {
        if (before.get(p) === digestOf(p)) continue;
        const rel = normalize(path.relative(sbx, p).replaceAll('\\', '/'), sbx);
        if (ledgerRe(sc).test(rel)) { ledgerFiles.push(rel); continue; }
        const text = normalize(fs.readFileSync(p, 'utf-8'), sbx);
        got[rel] = { private: (fs.statSync(p).mode & 0o077) === 0, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
      }
      // The identity ledger exists exactly when the wizard said it wrote it, and records the starter as ratified at setup.
      expect(ledgerFiles.length > 0, 'identity ledger written iff the wizard said so').toBe(baselineSaid);
      if (baselineSaid) {
        const ledgerPath = sc.tenant ? ledgerFiles.find((f) => f.endsWith('/ledger.json')) : 'app/data/identity/ledger.json';
        const ledger = JSON.parse(fs.readFileSync(path.join(sbx, ...ledgerPath.split('/')), 'utf-8'));
        expect(ledger.ratified.by).toBe('setup');
        expect(ledger.ratified.digest).toBe(ledger.observed.digest);
        if (sc.tenant) expect(ledgerFiles.map((f) => f.split('/').pop())).toEqual(expect.arrayContaining(['ledger.json', 'journal.jsonl']));
        else expect(ledgerFiles).toEqual(expect.arrayContaining(['app/data/identity/ledger.json', 'app/data/identity/journal.jsonl']));
      }

      // Which files were written, and byte for byte what each holds (the made-up password is fixed, so even .env is compared).
      expect(Object.keys(got).sort()).toEqual(Object.keys(golden).sort());
      for (const rel of Object.keys(golden)) {
        expect(got[rel].sha256, rel).toBe(golden[rel].sha256);
        // The one intended difference from the original: a .env the wizard creates is owner-only (0600) where the original used the umask.
        const madeEnv = rel === 'app/.env' && !existedBefore.has('app/.env');
        expect(got[rel].private, `${rel} is owner-only`).toBe(madeEnv ? true : golden[rel].private);
      }

      // The folders it created, and which of them are owner-only (browser-out, the Discord private folder): recorded from the original.
      if (process.platform !== 'win32') {
        const dirsGolden = fs.existsSync(path.join(FIX, `${sc.name}.dirs.json`)) ? JSON.parse(fs.readFileSync(path.join(FIX, `${sc.name}.dirs.json`), 'utf-8')) : {};
        const dirsGot = {};
        for (const d of walkDirs(sbx)) if (!dirsBefore.has(d) && !ledgerDirRe(sc).test(normalize(path.relative(sbx, d).replaceAll('\\', '/'), sbx))) dirsGot[normalize(path.relative(sbx, d).replaceAll('\\', '/'), sbx)] = { private: (fs.statSync(d).mode & 0o077) === 0 };
        // The identity baseline makes <root>/data (owner-only) when nothing else had: the recording predates it.
        if (baselineSaid && !dirsGolden['app/data']) delete dirsGot['app/data'];
        if (baselineSaid && sc.tenant && !dirsGolden[`app/tenants/${sc.tenant}/data`]) delete dirsGot[`app/tenants/${sc.tenant}/data`];
        expect(dirsGot).toEqual(dirsGolden);
      }
    } finally { fs.rmSync(sbx, { recursive: true, force: true }); }
  });
});
