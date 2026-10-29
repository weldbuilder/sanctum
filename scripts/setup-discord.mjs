// setup-discord.mjs — the pure parts of the wizard's Discord step (docs/DISCORD-PLAN.md).
// Re-exported from setup-lib.mjs. Kept in its own file so the step merges cleanly beside
// the other wizard steps.
import { createRequire } from 'node:module';
import { closeSync, constants, existsSync, fchmodSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { ambientTenantDir, ownMkdir, ownWriteFile } from './own-files-lib.mjs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const header = (title, what) => `# ${title}
#
# THESE ENTRIES ARE MADE UP. REPLACE EVERY ONE of them with your own, then delete this note.
#
# ${what}
#
# KEEP THIS FOLDER PRIVATE. It sits beside your companion's home on purpose, never inside it, and
# the app refuses to read it from anywhere she can write. Never commit it, post it, or paste it
# into a chat: it is a list of the very things you are protecting.
#
# One entry per line. Blank lines and lines starting with # are ignored.
`;

/** The three example files, by name. Every entry is made up; the header says to replace them. */
export function discordTemplates() {
  return {
    'words.txt': `${header(
      'words.txt: the word gate',
      'Every message your companion sends to Discord is checked against this file first. A message that\n# contains an entry is not sent: she is told which entry and gets one chance to say it again without\n# it. If this file is missing, empty or broken, NOTHING is sent (the gate fails closed).',
    )}# Whole words only, any capitalisation, and any spacing or punctuation between the words of one entry:
# "Maple Street" also catches maple-street, MapleStreet and #MapleStreet.
# Nicknames and other spellings each need their own line.
# A line starting with re: is a regular expression. These three catch phone numbers written
# 555-010-0142, (555) 010-0142 and 5550100142.

Jane Example
Janie
Maple Street
Springfield
Example Elementary
Acme Widgets
re:\\b\\d{3}[-.\\s]\\d{3}[-.\\s]\\d{4}\\b
re:\\(\\d{3}\\)\\s*\\d{3}[-.\\s]?\\d{4}
re:(?<!\\d)\\d{10}(?!\\d)
`,
    'names.txt': `${header(
      'names.txt: the real-name guard',
      'Optional. Real names of you and the people close to you. A message that contains one is withheld,\n# the same way as a word-list hit. Delete this file, or leave it with no entries, to turn the guard off.\n# If a line in it cannot be read, NOTHING is sent.',
    )}# Full names, first names people might use for you, and nicknames: each on its own line.

Pat Placeholder
Patricia Placeholder
Sam Sample
Samuel Sample
`,
    'exclusions.txt': `${header(
      'exclusions.txt: who she will not answer in public',
      'Accounts, threads and channels the public lane ignores, even when they mention her. One per line:\n# user:<id>, thread:<id> or channel:<id>, with a note after # if you like. If this file is missing or has a\n# line she cannot read, the public lane stays silent (it fails closed). Public mode is off until you turn it on.',
    )}user:100000000000000001  # made-up user id: replace with an account you want ignored
thread:100000000000000002  # made-up thread id: replace with a thread you want ignored
`,
  };
}

/**
 * Make `dir` (owner-only) and the three files in it. A file that is already there is kept as it
 * is, never overwritten, and a link left where a file should be is never followed.
 * Returns the names created and the names kept.
 */
export function createPrivateLists(dir) {
  // A folder that is a symlink is refused outright: following it would put the lists, and a chmod,
  // wherever the link points. lstat does not follow it (a dangling link shows up too).
  let st = null;
  try { st = lstatSync(dir); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  if (st?.isSymbolicLink()) throw new Error(`${dir} is a symlink. The private folder must be a real folder, not a link: pick another path, or remove the link.`);
  ownMkdir(ambientTenantDir(), dir, { recursive: true, mode: 0o700 });
  // Tighten it without ever going through a link: open the folder itself (O_NOFOLLOW) and chmod that handle.
  try {
    const fd = openSync(dir, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_DIRECTORY || 0));
    try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
  } catch { /* not ours to change, a link raced in (refused above), or a platform without modes */ }
  const created = [];
  const kept = [];
  for (const [name, body] of Object.entries(discordTemplates())) {
    try {
      // 'wx' is O_EXCL: it fails on anything already at the path, a dangling or live symlink included.
      ownWriteFile(ambientTenantDir(), join(dir, name), body, { flag: 'wx', mode: 0o600 });
      created.push(name);
    } catch (err) {
      if (err?.code === 'EEXIST') kept.push(name);
      else throw err;
    }
  }
  return { created, kept };
}

/** Beside the companion's home, never inside it. */
export function defaultPrivateDir(home) {
  return join(dirname(resolve(home)), 'sanctum-private');
}

// The same algorithm as realOrResolved in packages/backend/src/services/plugin-paths.ts (a plain .mjs
// cannot import that file): the nearest existing ancestor is realpath'd and the rest appended, so a
// folder that does not exist yet under a symlinked parent is still seen where it will land.
const realOrResolved = (p, depth = 0) => {
  const abs = resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    try { return join(realpathSync(cur), ...rest.reverse()); } catch { /* not there, or a dangling link */ }
    try {
      if (lstatSync(cur).isSymbolicLink() && depth < 40) return realOrResolved(join(resolve(dirname(cur), readlinkSync(cur)), ...rest.reverse()), depth + 1);
    } catch { /* does not exist at all */ }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    rest.push(basename(cur));
    cur = parent;
  }
};
const isInside = (child, parent) => {
  const r = relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

/**
 * Why `dir` may not hold the private lists, or '' when it may: it is inside, or contains, a folder
 * the companion can write. The app refuses the same thing at load; this stops the wizard offering it.
 */
export function privateDirProblem(dir, writableRoots) {
  const real = realOrResolved(dir);
  for (const root of writableRoots || []) {
    if (!root) continue;
    const rr = realOrResolved(root);
    if (isInside(real, rr)) return `${dir} is inside ${root}, which your companion can write. She could read or change the lists.`;
    if (isInside(rr, real)) return `${dir} contains ${root}, which your companion can write. She could read or change the lists.`;
  }
  return '';
}

/** True when Discord is on, by the precedence server.ts applies: `getConfigBool('discord.enabled', yaml)`. The Settings
 *  toggle (the `discord.enabled` row in the app's database) WINS whenever the row exists, in either direction, and only
 *  'true' and '1' mean on, exactly as getConfigBool reads it; with no row the yaml decides (including the old
 *  `discord: { enabled, owner_user_id }` shape). The wizard then makes the private lists without asking again. */
export function discordEnabled(cfg, dbValue) {
  if (dbValue !== null && dbValue !== undefined) return dbValue === true || dbValue === 'true' || dbValue === '1';
  return cfg?.discord?.enabled === true;
}

/** DB_PATH as server.ts would load it from the .env files: the root `.env` first, then `packages/backend/.env` (the
 *  working directory `npm start` runs from). dotenv never overrides, so the first file that defines the key wins, even
 *  with an empty value. Never throws. The real environment is the caller's (`envDbPath`) and wins over both. */
function dotenvDbPath(root) {
  try {
    const { parse } = createRequire(import.meta.url)('dotenv');
    for (const file of [join(root, '.env'), join(root, 'packages', 'backend', '.env')]) {
      if (!existsSync(file)) continue;
      const vars = parse(readFileSync(file, 'utf-8'));
      if (Object.prototype.hasOwnProperty.call(vars, 'DB_PATH')) return vars.DB_PATH;
    }
  } catch { /* unreadable: the wizard just falls back to yaml and the default */ }
  return '';
}

/** The database file the server will open, resolved as packages/backend/src/config.ts does: `DB_PATH` (environment, or
 *  .env) wins over yaml `server.db_path`, over `data/sanctum.db`; a leading `~` is the home directory; relative paths
 *  are from the project root; and when nothing was set explicitly an existing `data/resonant.db` (from before the
 *  rename) stands in for a missing `data/sanctum.db`. `exists` is for tests. */
export function wizardDbPath(root, cfg, envDbPath, exists = existsSync) {
  const explicit = String(envDbPath || '').trim() || String(dotenvDbPath(root) || '').trim() || String(cfg?.server?.db_path || '').trim();
  const chosen = explicit || 'data/sanctum.db';
  const abs = resolve(root, chosen === '~' ? homedir() : chosen.startsWith('~/') ? join(homedir(), chosen.slice(2)) : chosen);
  if (explicit) return abs;
  const legacy = abs.replace(/sanctum\.db$/, 'resonant.db');
  return legacy !== abs && !exists(abs) && exists(legacy) ? legacy : abs;
}

/** One value from the app's config table (the Settings toggles), read-only, or null when there is no
 *  database, no such row, or better-sqlite3 cannot load. Never throws: the wizard just asks as before. */
export function readDbConfig(dbPath, key) {
  try {
    if (!dbPath || !existsSync(dbPath)) return null;
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
      return row && typeof row.value === 'string' ? row.value : null;
    } finally { db.close(); }
  } catch { return null; }
}

/**
 * The `discord` block after the wizard's answers. Public stays off and bots stay never unless the
 * person already chose otherwise; every other key they have is kept; the legacy owner_user_id moves
 * to owner.user_id. Does not touch its input.
 */
export function applyDiscordAnswers(existing, a) {
  const d = structuredClone(existing && typeof existing === 'object' ? existing : {});
  delete d.owner_user_id;
  d.enabled = true;
  d.owner = { ...(d.owner || {}), user_id: a.ownerUserId, channel_id: a.ownerChannelId };
  d.public = { enabled: false, bots: 'never', ...(d.public || {}) };
  if (typeof d.paused !== 'boolean') d.paused = false;
  d.private_dir = a.privateDir;
  return d;
}
