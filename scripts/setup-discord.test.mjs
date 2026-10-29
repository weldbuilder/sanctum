// The Discord step's pure parts. They live in setup-discord.mjs and are re-exported from
// setup-lib.mjs, so this imports them the way setup.mjs does.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { discordTemplates, createPrivateLists, applyDiscordAnswers, privateDirProblem, defaultPrivateDir, discordEnabled, readDbConfig, wizardDbPath } from './setup-lib.mjs';
import Database from 'better-sqlite3';
import { loadRules } from '../packages/backend/src/services/discord/gate.ts';
import { parseExclusions } from '../packages/backend/src/services/discord/lanes.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'sanctum-setup-discord-'));

describe('discordTemplates', () => {
  const t = discordTemplates();
  it('has the three files', () => {
    expect(Object.keys(t).sort()).toEqual(['exclusions.txt', 'names.txt', 'words.txt']);
  });
  it('every file opens with a header that says to replace the entries and keep the folder private', () => {
    for (const [name, body] of Object.entries(t)) {
      const head = body.split('\n').filter((l) => l.startsWith('#')).join('\n');
      expect(head, name).toMatch(/replace/i);
      expect(head, name).toMatch(/private/i);
      expect(head, name).toMatch(/made[- ]up|example/i);
    }
  });
  it('the names header says what the guard does with an empty file: off. It does not claim an empty file blocks everything', () => {
    const head = t['names.txt'].split('\n').filter((l) => l.startsWith('#')).join('\n').replace(/\n#\s*/g, ' ');
    expect(head).not.toMatch(/empty or broken/i);
    expect(head).toMatch(/(empty|no entries)[^.]*(off)|off[^.]*(empty|no entries)/i);
    expect(head).toMatch(/line[^.]*cannot be read[^.]*NOTHING is sent/i);
  });
  it('the word and name templates load in the real gate, with made-up entries', () => {
    const dir = tmp();
    for (const name of ['words.txt', 'names.txt']) {
      writeFileSync(join(dir, name), t[name]);
      expect(loadRules(join(dir, name)).entries, name).toBeGreaterThan(2);
    }
    rmSync(dir, { recursive: true, force: true });
  });
  it('the exclusions template is valid for the real parser (user:<id>, thread:<id>, channel:<id>), with made-up ids', () => {
    const e = parseExclusions(t['exclusions.txt']);
    expect(e.users.size + e.threads.size + e.channels.size).toBeGreaterThanOrEqual(2);
    expect(t['exclusions.txt']).toMatch(/^user:\d+/m);
    expect(t['exclusions.txt']).toMatch(/^thread:\d+/m);
  });
  it('the word template ships the three phone shapes as patterns', () => {
    expect(t['words.txt'].split('\n').filter((l) => l.startsWith('re:'))).toHaveLength(3);
  });
});

describe('createPrivateLists', () => {
  it('makes the folder and the three files, owner-only', () => {
    const base = tmp();
    const dir = join(base, 'sanctum-private');
    const r = createPrivateLists(dir);
    expect(r.created.sort()).toEqual(['exclusions.txt', 'names.txt', 'words.txt']);
    expect(r.kept).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['exclusions.txt', 'names.txt', 'words.txt']);
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o077).toBe(0);
      expect(statSync(join(dir, 'words.txt')).mode & 0o077).toBe(0);
    }
    rmSync(base, { recursive: true, force: true });
  });
  it('never overwrites a file that is already there, and creates the rest', () => {
    const base = tmp();
    const dir = join(base, 'p');
    mkdirSync(dir);
    writeFileSync(join(dir, 'words.txt'), 'my own words\n');
    const r = createPrivateLists(dir);
    expect(r.kept).toEqual(['words.txt']);
    expect(r.created.sort()).toEqual(['exclusions.txt', 'names.txt']);
    expect(readFileSync(join(dir, 'words.txt'), 'utf-8')).toBe('my own words\n');
    // and a second run changes nothing at all
    const again = createPrivateLists(dir);
    expect(again.created).toEqual([]);
    expect(again.kept.sort()).toEqual(['exclusions.txt', 'names.txt', 'words.txt']);
    rmSync(base, { recursive: true, force: true });
  });
  it('does not follow a symlink someone left where a list should be', () => {
    const base = tmp();
    const dir = join(base, 'p');
    mkdirSync(dir);
    const victim = join(base, 'victim.txt');
    writeFileSync(victim, 'keep me');
    symlinkSync(victim, join(dir, 'words.txt'));
    const r = createPrivateLists(dir);
    expect(r.kept).toContain('words.txt');
    expect(readFileSync(victim, 'utf-8')).toBe('keep me');
    rmSync(base, { recursive: true, force: true });
  });
});

describe('createPrivateLists and links (verifier 5)', () => {
  it('refuses a private folder that is a symlink, and changes nothing behind it', () => {
    const base = tmp();
    const target = join(base, 'elsewhere');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    const link = join(base, 'sanctum-private');
    symlinkSync(target, link);
    expect(() => createPrivateLists(link)).toThrow(/symlink|link/i);
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o755); // POSIX modes only
    expect(readdirSync(target)).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });
  it('refuses a dangling symlink too', () => {
    const base = tmp();
    const link = join(base, 'sanctum-private');
    symlinkSync(join(base, 'nowhere'), link);
    expect(() => createPrivateLists(link)).toThrow(/symlink|link/i);
    expect(existsSync(join(base, 'nowhere'))).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
  it('still tightens a real folder that already exists', () => {
    const base = tmp();
    const dir = join(base, 'p');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    createPrivateLists(dir);
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o077).toBe(0);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('privateDirProblem with a folder that does not exist yet (verifier 6)', () => {
  it('catches a not-yet-existing folder under a symlinked parent that resolves into a writable root', () => {
    const base = tmp();
    const home = join(base, 'home');
    mkdirSync(home);
    const link = join(base, 'link');
    symlinkSync(home, link);
    expect(privateDirProblem(join(link, 'sanctum-private'), [home])).toMatch(/inside/);
    expect(privateDirProblem(join(link, 'a', 'b', 'c'), [home])).toMatch(/inside/);
    rmSync(base, { recursive: true, force: true });
  });
  it('catches a not-yet-existing folder that would contain a writable root through a link', () => {
    const base = tmp();
    const outer = join(base, 'outer');
    mkdirSync(join(outer, 'home'), { recursive: true });
    const link = join(base, 'link');
    symlinkSync(outer, link);
    expect(privateDirProblem(join(base, 'link'), [join(outer, 'home')])).toMatch(/contains/);
    rmSync(base, { recursive: true, force: true });
  });
  it('a missing folder under a real, unrelated parent is fine', () => {
    const base = tmp();
    const home = join(base, 'home');
    mkdirSync(home);
    expect(privateDirProblem(join(base, 'not-yet', 'sanctum-private'), [home])).toBe('');
    rmSync(base, { recursive: true, force: true });
  });
});

describe('the wizard sees Discord already on (verifier 10)', () => {
  it('a legacy block with enabled: true counts, so the lists get made without asking again', () => {
    expect(discordEnabled({ discord: { enabled: true, owner_user_id: '1' } })).toBe(true);
    expect(discordEnabled({ discord: { enabled: false } })).toBe(false);
    expect(discordEnabled({})).toBe(false);
    expect(discordEnabled(undefined)).toBe(false);
  });
  it('the Settings toggle counts too: the wizard reads yaml OR the DB value (server.ts honours the DB toggle)', () => {
    expect(discordEnabled({}, 'true')).toBe(true);
    expect(discordEnabled({ discord: { enabled: false } }, 'true')).toBe(true);
    expect(discordEnabled({ discord: { enabled: true } }, null)).toBe(true);
    expect(discordEnabled({}, 'false')).toBe(false);
    expect(discordEnabled({}, null)).toBe(false);
    expect(discordEnabled({}, undefined)).toBe(false);
  });
});

// SHOULD-FIX 5: the wizard and the server must agree on whether Discord is on, and read the same database.
describe('discordEnabled applies the precedence server.ts applies: the database value wins when it is set', () => {
  it('a database "false" (or anything but true/1) turns Discord OFF even when the yaml says enabled: true', () => {
    expect(discordEnabled({ discord: { enabled: true } }, 'false')).toBe(false);
    expect(discordEnabled({ discord: { enabled: true } }, '0')).toBe(false);
    expect(discordEnabled({ discord: { enabled: true } }, '')).toBe(false);
    expect(discordEnabled({ discord: { enabled: true } }, 'yes')).toBe(false); // getConfigBool only reads 'true' and '1'
  });
  it('a database "true" or "1" turns it ON whatever the yaml says', () => {
    expect(discordEnabled({ discord: { enabled: false } }, 'true')).toBe(true);
    expect(discordEnabled({}, '1')).toBe(true);
  });
  it('no database row (null / undefined) leaves the yaml in charge', () => {
    expect(discordEnabled({ discord: { enabled: true } }, null)).toBe(true);
    expect(discordEnabled({ discord: { enabled: true } }, undefined)).toBe(true);
    expect(discordEnabled({ discord: { enabled: false } }, null)).toBe(false);
    expect(discordEnabled({}, null)).toBe(false);
  });
  it('it agrees with getConfigBool(key, yaml) for every combination', () => {
    const getConfigBool = (v, dflt) => (v === null || v === undefined ? dflt : v === 'true' || v === '1');
    for (const yamlOn of [true, false, undefined]) {
      for (const db of [null, undefined, 'true', 'false', '1', '0', '', 'TRUE', 'yes']) {
        expect(discordEnabled(yamlOn === undefined ? {} : { discord: { enabled: yamlOn } }, db), `${yamlOn} / ${db}`).toBe(getConfigBool(db, yamlOn === true));
      }
    }
  });
});

// B-1 (Codex): the public lane is refused on Codex, so the person is told before they turn it on.
describe('the wizard and the docs say public Discord needs dsh or Claude', () => {
  const read = (...p) => readFileSync(join(import.meta.dirname, '..', ...p), 'utf-8');
  it.each([['the wizard', ['scripts', 'setup-plan.mjs']], ['the configuration reference', ['docs', 'CONFIGURATION.md']], ['the plan', ['docs', 'DISCORD-PLAN.md']]])('%s', (_n, p) => {
    expect(read(...p)).toMatch(/public[^\n]{0,80}(needs|requires)[^\n]{0,40}dsh or Claude/i);
  });
  it('the example config says it too, next to public.enabled', () => {
    expect(read('sanctum.example.yaml')).toMatch(/dsh or Claude/);
  });
});

describe('wizardDbPath resolves the database where config.ts does', () => {
  const root = resolve('/srv/sanctum');
  const has = (...paths) => (p) => paths.includes(p);

  it('defaults to data/sanctum.db under the project root', () => {
    expect(wizardDbPath(root, {}, '', has())).toBe(resolve('/srv/sanctum/data/sanctum.db'));
  });
  it('falls back to an existing data/resonant.db (from before the rename) when sanctum.db is not there', () => {
    expect(wizardDbPath(root, {}, '', has(resolve('/srv/sanctum/data/resonant.db')))).toBe(resolve('/srv/sanctum/data/resonant.db'));
    expect(wizardDbPath(root, {}, '', has(resolve('/srv/sanctum/data/sanctum.db'), resolve('/srv/sanctum/data/resonant.db')))).toBe(resolve('/srv/sanctum/data/sanctum.db'));
  });
  it('DB_PATH from the environment wins, absolute or relative to the root, and is never second-guessed by the legacy fallback', () => {
    expect(wizardDbPath(root, { server: { db_path: 'data/other.db' } }, resolve('/var/lib/s/app.db'), has())).toBe(resolve('/var/lib/s/app.db'));
    expect(wizardDbPath(root, {}, 'var/app.db', has())).toBe(resolve('/srv/sanctum/var/app.db'));
    expect(wizardDbPath(root, {}, 'data/sanctum.db', has(resolve('/srv/sanctum/data/resonant.db')))).toBe(resolve('/srv/sanctum/data/sanctum.db'));
  });
  it('a yaml server.db_path is explicit too: no legacy fallback, and ~ is the home directory', () => {
    expect(wizardDbPath(root, { server: { db_path: 'data/sanctum.db' } }, '', has(resolve('/srv/sanctum/data/resonant.db')))).toBe(resolve('/srv/sanctum/data/sanctum.db'));
    expect(wizardDbPath(root, { server: { db_path: '~/s/app.db' } }, '', has())).toBe(join(homedir(), 's', 'app.db'));
  });
  // B2.2: server.ts loads the root .env first and packages/backend/.env second (dotenv never overrides), so DB_PATH set only
  // in the second file is the one the server opens. The wizard read neither file's DB_PATH itself.
  it('reads DB_PATH from the root .env, then packages/backend/.env (the order server.ts loads them), after the environment', () => {
    // On Windows an absolute path without a drive resolves against the base's drive, which is the temp dir's, not the cwd's.
    const base = tmp();
    mkdirSync(join(base, 'packages', 'backend'), { recursive: true });
    const none = () => false;
    // only the backend .env has it
    writeFileSync(join(base, 'packages', 'backend', '.env'), 'APP_PASSWORD=x\nDB_PATH=/var/lib/s/backend.db\n');
    expect(wizardDbPath(base, {}, '', none)).toBe(resolve(base, '/var/lib/s/backend.db'));
    // a root .env that sets it wins over the backend one
    writeFileSync(join(base, '.env'), 'DB_PATH="/var/lib/s/root.db"\n');
    expect(wizardDbPath(base, {}, '', none)).toBe(resolve(base, '/var/lib/s/root.db'));
    // and the environment wins over both
    expect(wizardDbPath(base, {}, resolve(base, '/var/lib/s/env.db'), none)).toBe(resolve(base, '/var/lib/s/env.db'));
    // a root .env without DB_PATH falls through to the backend one; a relative value is from the project root
    writeFileSync(join(base, '.env'), 'APP_PASSWORD=y\n');
    writeFileSync(join(base, 'packages', 'backend', '.env'), 'DB_PATH=var/b.db\n');
    expect(wizardDbPath(base, {}, '', none)).toBe(join(base, 'var', 'b.db'));
    // an explicit DB_PATH in a .env is never second-guessed by the legacy resonant.db fallback, and beats yaml
    expect(wizardDbPath(base, { server: { db_path: 'data/yaml.db' } }, '', (p) => p.endsWith('resonant.db'))).toBe(join(base, 'var', 'b.db'));
    // neither file: as before
    rmSync(join(base, '.env')); rmSync(join(base, 'packages', 'backend', '.env'));
    expect(wizardDbPath(base, {}, '', none)).toBe(join(base, 'data', 'sanctum.db'));
    rmSync(base, { recursive: true, force: true });
  });
  it('reads the toggle from the resonant.db the server would use', () => {
    const base = tmp();
    mkdirSync(join(base, 'data'));
    const d = new Database(join(base, 'data', 'resonant.db'));
    d.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');
    d.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('discord.enabled', 'false');
    d.close();
    const dbValue = readDbConfig(wizardDbPath(base, {}, ''), 'discord.enabled');
    expect(dbValue).toBe('false');
    expect(discordEnabled({ discord: { enabled: true } }, dbValue)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('readDbConfig: the Settings toggle, read from the app\'s database', () => {
  it('reads a config row, and is null for a missing row, a missing file or an unreadable one', () => {
    const base = tmp();
    const db = join(base, 'sanctum.db');
    const d = new Database(db);
    d.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');
    d.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('discord.enabled', 'true');
    d.close();
    expect(readDbConfig(db, 'discord.enabled')).toBe('true');
    expect(discordEnabled({}, readDbConfig(db, 'discord.enabled'))).toBe(true);
    expect(readDbConfig(db, 'nope')).toBeNull();
    expect(readDbConfig(join(base, 'missing.db'), 'discord.enabled')).toBeNull();
    writeFileSync(join(base, 'junk.db'), 'not a database');
    expect(readDbConfig(join(base, 'junk.db'), 'discord.enabled')).toBeNull();
    rmSync(base, { recursive: true, force: true });
  });
});

describe('defaultPrivateDir and privateDirProblem', () => {
  it('the default sits beside the home, never inside it', () => {
    expect(defaultPrivateDir('/home/me/companion-home')).toBe(resolve('/home/me/sanctum-private'));
  });
  it('flags a folder inside, or containing, anything the companion can write', () => {
    expect(privateDirProblem('/home/me/companion-home/private', ['/home/me/companion-home'])).toMatch(/inside/);
    expect(privateDirProblem('/home/me', ['/home/me/companion-home'])).toMatch(/contains/);
    expect(privateDirProblem('/home/me/companion-home', ['/home/me/companion-home'])).not.toBe('');
    expect(privateDirProblem('/home/me/sanctum-private', ['/home/me/companion-home', '/data/extra'])).toBe('');
    expect(privateDirProblem('/home/me/sanctum-private', [])).toBe('');
  });
  it('sees through a symlink to a writable root', () => {
    const base = tmp();
    const home = join(base, 'home');
    mkdirSync(home);
    const link = join(base, 'link');
    symlinkSync(home, link);
    expect(privateDirProblem(link, [home])).not.toBe('');
    rmSync(base, { recursive: true, force: true });
  });
});

describe('applyDiscordAnswers', () => {
  const answers = { ownerUserId: '111', ownerChannelId: '222', privateDir: '/home/me/sanctum-private' };
  it('writes the block: public off, bots never, the owner ids, the private folder', () => {
    const d = applyDiscordAnswers(undefined, answers);
    expect(d).toMatchObject({
      enabled: true,
      owner: { user_id: '111', channel_id: '222' },
      public: { enabled: false, bots: 'never' },
      paused: false,
      private_dir: '/home/me/sanctum-private',
    });
  });
  it('keeps what the person already chose and keys the wizard does not ask about', () => {
    const d = applyDiscordAnswers({
      enabled: false,
      public: { enabled: true, guild_ids: ['9'], bots: 'capped', bot_exchange_limit: 6 },
      paused: true,
      deferral_hours: 12,
      gate: { words_file: '/x/w.txt' },
    }, answers);
    expect(d.enabled).toBe(true);
    expect(d.public).toEqual({ enabled: true, guild_ids: ['9'], bots: 'capped', bot_exchange_limit: 6 });
    expect(d.paused).toBe(true);
    expect(d.deferral_hours).toBe(12);
    expect(d.gate).toEqual({ words_file: '/x/w.txt' });
  });
  it('moves the legacy owner_user_id to owner.user_id', () => {
    const d = applyDiscordAnswers({ enabled: true, owner_user_id: '555' }, { ...answers, ownerUserId: '555' });
    expect(d.owner.user_id).toBe('555');
    expect(d.owner_user_id).toBeUndefined();
  });
  it('does not touch the input', () => {
    const input = { owner_user_id: '1' };
    applyDiscordAnswers(input, answers);
    expect(input).toEqual({ owner_user_id: '1' });
  });
  it('the folder it made exists after createPrivateLists, as the wizard runs them', () => {
    const base = tmp();
    const dir = join(base, 'sanctum-private');
    createPrivateLists(dir);
    expect(existsSync(join(dir, 'words.txt'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('the upgrade notes and the example config say what the code does', () => {
  const here = new URL('.', import.meta.url);
  const upgrade = readFileSync(new URL('../UPGRADE.md', here), 'utf-8');
  const yaml = readFileSync(new URL('../sanctum.example.yaml', here), 'utf-8');
  const discord = upgrade.slice(upgrade.indexOf('# Coming from the old Discord setting'));

  it('the missing-list notice is once per start per daily thread, not "one line a day"', () => {
    expect(discord).not.toMatch(/one line a day/i);
    expect(discord).toMatch(/once (each|per) start[^.]*daily thread|once per daily thread[^.]*start/i);
  });
  it('replies resume as soon as words.txt exists, even with the made-up examples, which are examples only', () => {
    expect(discord).not.toMatch(/moment `words\.txt` has real entries/);
    expect(discord).toMatch(/as soon\s+as `words\.txt` exists/i);
    expect(discord).toMatch(/made[- ]up/i);
  });
  it('the wizard reads the yaml OR the Settings toggle', () => {
    expect(discord).toMatch(/Settings[^.]*toggle|toggle[^.]*Settings/i);
  });
  it('ignore rules from the Rules API no longer apply: the exclusions file replaces them', () => {
    expect(discord).toMatch(/Rules API/);
    expect(discord).toMatch(/no longer apply|are no longer read|no longer used/i);
    expect(discord).toMatch(/exclusions\.txt/);
  });
  it('the example config says the bot caps count her replies, not the messages that reach her', () => {
    const block = yaml.split('\n').filter((l) => /bot_exchange_limit|bot_hourly_limit/.test(l)).join('\n');
    expect(block).toMatch(/her replies/i);
    expect(block).toMatch(/not (incoming|the messages)/i);
  });
});
