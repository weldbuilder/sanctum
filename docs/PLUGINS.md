# Plugins — draft contract

*Status: draft for review, 2026-10-19, revised the same day after the trust note and the four planning docs (dsh adapter contract, skills design, Discord gap audit, harvest map v3), and again on 2026-10-20 for the trust modes. Built on branches `feat/plugin-loader` and `feat/plugin-trust`: the loader (`services/plugins.ts`), dsh rows, routes, `res help` topics, `GET /api/plugins`, the audit record, companion-managed enabling and the Settings page. Not built: the `ui` tab, the `mcp` block, the answerer plugin. Identity ratification is built on `feat/identity-authorship` (see "Identity ratification" below).*

**Who manages plugins.** `plugins.trust` in `sanctum.yaml` is `companion` (the default) or `person`. By default your companion manages plugins: it can turn them on and off and edit them, enabled plugins run from their live folder, and Settings shows you what changed. The person-gated mode, where nothing runs until you have read and ratified a plugin's exact code, stays available as an opt-in. Each section below says which mode it describes.

Sanctum Mobile has no plugin mechanism of its own. On the dsh harness it does not
need one: dsh is a Cordis plugin host, every run is composed from patch rows, and
the app already writes a patch per run (`services/providers/dsh-exec.ts`,
`buildOverlay`). Verified against dsh 0.2.1-alpha.2 on 2026-10-19:

- an overlay `insert` row may name a plugin by **absolute path** to its entry
  module, with a `config` object; no profile install, no pnpm;
- a plugin's root-level listeners receive dsh's two human-decision seams,
  `approval/request` and `user-questions/request`, for every agent in the run,
  subagents included; the decision flows back as the tool outcome.

A Sanctum plugin is therefore a folder that contributes some of: dsh rows (agent
side), Express routes (app side), a `res help` topic, and a frontend tab served as
an iframe. The app assembles them. Nothing about the three layers, `AGENTS.md` or
the approvals card moves.

## Layout

```
plugins/
  <id>/
    sanctum.plugin.json      manifest
    dsh/index.mjs            Cordis plugin entry (optional)
    routes.mjs               default export: (api) => express.Router (optional)
    help.md                  one res help topic (optional)
    ui/index.html            served at /plugins/<id>/ui/ and shown as a tab (optional)
```

`plugins/` at the repo root ships with the app. A second root, `plugins.dir` in
`sanctum.yaml` (default `""`, meaning none), is the person's own; same layout,
loaded after the shipped ones, same id wins last. **In companion mode (the default) either root
may be somewhere the companion can write**: it may write plugins, and the loader accepts the folder
wherever it is. **In person mode neither root may be somewhere the companion can write.** The same
real-path check (symlinks resolved, `~` expanded)
runs on both: the loader refuses, with a warning, a root that is inside or equal to,
or contains, `agent.cwd`, `agent.codex.additional_directories`, the dsh home or the
write-gate roots (`hooks.workspace_root`, `hooks.vault_path`,
`hooks.extra_write_paths`) or, while Codex or dsh is the active provider, `/tmp` or `$TMPDIR` (the
folders their `workspace-write` sandboxes include; the roots are compared case-folded, as the
write gate does on every OS). Consequence of the default `agent.cwd: "."`: the companion
home IS the app folder, which contains `<repo>/plugins`, so the shipped root is refused
and no shipped plugin loads. The rule for the shipped root is exactly this: it is refused
only when a companion-writable root (`agent.cwd`, the Codex additional directories, the
dsh home, the write-gate roots) contains, equals or sits inside `<repo>/plugins`. A home
elsewhere in the app folder, such as `<app>/companion-home`, is allowed and safe; so is
one outside the app folder. The warning at boot names this (person mode only; companion mode loads the shipped root whatever `agent.cwd` is). A `plugins.dir` that does not exist logs a warning too.
Neither root loads anything by itself: see Enabling.

## Manifest

```json
{
  "id": "answerer",
  "name": "Approvals and questions",
  "version": "0.1.0",
  "harness": ["dsh"],
  "dsh": {
    "rows": [
      { "id": "tool-ask-user", "name": "@deepseek-ai/dsh-tool-ask-user" },
      { "id": "sanctum-answerer", "entry": "dsh/index.mjs", "config": { "timeoutMs": 600000 } }
    ],
    "runs": ["turn"]
  },
  "routes": "routes.mjs",
  "help": "help.md",
  "ui": { "tab": "Browser", "icon": "globe" },
  "tenant_aware": true
}
```

- `id` — 1-32 lowercase letters, digits, `-` or `_`, and not the name of a built-in
  `res help` topic (`chat`, `meal`, `cc`, `presence`, `routine`, `pulse`, `failsafe`,
  `timer`, `impulse`, `watch`, `ask`, `browser`, `tg`; the list is `TOOL_TOPICS`). `res help <id>`
  answers a built-in topic first, so a plugin with one of those ids could never be
  shown; the manifest is rejected with "id collides with a built-in help topic".
- `harness` — which harnesses the plugin's dsh rows apply to. Rows are only
  inserted on a listed harness; routes and help load regardless.
- `dsh.rows` — overlay rows as dsh takes them. `entry` is resolved to an absolute
  path under the plugin folder and becomes the row's `name`. A `name` must be a
  package name dsh can already resolve (`^@?[a-z0-9][a-z0-9._-]*(/...)*$`, no `/`
  prefix, no `..`); a path in `name` rejects the row. Every file a plugin names must
  resolve through symlinks to inside its real folder. A row with neither `entry` nor
  `name` is invalid (dsh treats a nameless inserted row as a new nameless entry and
  disables it, which in turn breaks the base `approval` and `permission` rows for the
  whole run). Row ids are prefixed `plugin:<id>:` by the loader, with one exception:
  `tool-ask-user`, the `ask_user_question` tool. It is emitted as an insert row whose
  `name` (`@deepseek-ai/dsh-tool-ask-user`) the loader forces, so the manifest row may
  omit it and cannot change it; the plugin supplies `config` only, only on a `turn`
  run, and if several enabled plugins ask for it the first one's row is the only one
  emitted. Any other id that equals a row in dsh's real composition is rejected, not
  prefixed: `DSH_BASE_ROW_IDS` in `plugins.ts` lists the ids from dsh-base's and
  dsh-headless's `cordis.patch.yml` (dsh 0.2.1-alpha.2; re-extract on a dsh upgrade),
  plus `mcp-*`. That includes `approval`: a plugin cannot touch the base `approval`
  row (patching an existing row has to be a top-level patch entry, never a row inside
  `insert`, and the loader only writes `insert` rows).
  A manifest may not use the same row `id` twice: dsh addresses rows by id, so the two
  would collide inside dsh after the manifest had passed. It is rejected at scan with an
  error naming the duplicate id (and both row indexes).
- `dsh.runs` — which run kinds get the rows: `turn`, `wake`, `helper`,
  `summarizer`. Default `["turn", "wake"]`. An answerer plugin declares `["turn"]`:
  approvals are **off by default, user-enabled, conversation turns only; wakes are
  the companion's free time and never ask anyone** (harvest map G2). Not built yet:
  the flip of the base `approval` row to `ask` belongs to the answerer item and its
  user setting, and will be done by `buildOverlay` itself as a top-level patch of the
  existing row (`{id: 'approval', config: {...}}`, like the `never` row it writes
  today), only on a turn, only when the setting is on and an answerer is loaded. A
  plugin manifest cannot do it. The only grant dsh knows is `allowed-once`; no
  reusable "allow always" is built, so the CVE-2026-100530 class never opens.
- `tenant_aware` — the plugin accepts a `tenant` in its injected config and scopes
  its routes by it. The loader refuses to load a plugin without this flag once the
  app runs in multi-tenant mode. Single-user installs pass `tenant: "default"`.

  Under multi-tenant option (b) (`docs/MULTI-TENANT.md`) a plugin is operator-trusted
  code running in the one shared process. It is told the tenant id (`req.tenant` is
  `{ id }`, and the injected `tenant`) and nothing else: no runtime, token, password or
  database of any tenant is handed to it. It must scope its own module state by
  `req.tenant.id`, because a shipped or companion-trust module is evaluated once for
  every tenant. A tenant's own plugin root is `<tenant>/plugins/` (set `plugins.dir:
  plugins` in `tenant.yaml`), a sibling of `home/`, which the companion cannot write;
  a `plugins.dir` inside any writable root of any tenant (home, hooks roots, extra
  write paths, temp folders) is refused, whatever the trust mode, with one warning,
  and that root loads nothing. What this cannot do: plugin code runs in the process
  and can read any file the process can, including another tenant's folder. Only
  install plugins you would trust with every tenant's data. The built reference, with
  the walls and what they are not, is [MULTI-TENANT.md](MULTI-TENANT.md) ("The walls, and
  what they are not").

## Enabling

A plugin on disk is inert until it is named. `sanctum.yaml`:

```yaml
plugins:
  trust: companion        # "companion" (default) or "person"; an unknown value warns and means "companion"
  dir: ""                 # the person's own plugin root; "" = none, never <agent.cwd>/plugins
  enabled: []             # plugin ids that may load. Empty = none, shipped ones included.
```

The loader scans both roots and lists everything it finds at `GET /api/plugins`
(the read surface; session auth) with an `enabled` flag and an `error` when something
is wrong. Only ids in `plugins.enabled` contribute dsh rows, mount routes, or appear in
`res help`. A plugin with any scan error (a bad row, a missing or escaping file, a manifest path that
leaves the plugin folder) contributes nothing at all, no rows, routes or help, and its list entry carries
the error. No `deny` list: an id that is not enabled is simply off.

**Companion mode (the default).** Your companion manages plugins.

- Enabled plugins run from their **live folder**. There is no ratification and no snapshot: rows, routes
  and help are read from the files as they are. The manifest is read again for every run, request and
  reload, so an edit applies on the next run and a fix clears an old error.
- The companion turns plugins on and off with `PUT /api/plugins/enabled` and the internal token
  (body `{ "enabled": ["hello", "mine"] }`, the whole list). The app writes `plugins.enabled` into
  `sanctum.yaml` and into the running config, so the **next run** reads the new list: no restart. Routes
  of a plugin enabled this way serve from its first request (they are dispatched by id on each request,
  and answer `404` while the id is not enabled). The person can do the same from Settings > Plugins, which
  calls the same route with the session. The write goes through the companion's write switch
  (`agent.app_write`) like every other companion write; the person's own request does not.
- After editing a plugin's `routes.mjs`, the companion calls `POST /api/plugins/<id>/reload` with the
  internal token (the person can too). A route file is imported once and kept; the reload imports the new
  code. A plugin the companion has just created is found without a restart.
- Nothing stops running. The app still protects its own correctness: a manifest path (a row `entry`,
  `routes`, `help`) that resolves outside its plugin folder is a scan error, and a plugin folder that is
  itself a link out of its root is refused. The import scan (see "What the scan reads", under Ratifying)
  still runs, but its findings are a **warning** on the plugin's list entry (`warnings`), not a refusal.
- No containment refusals: a `plugins.dir` inside the companion's writable folders is accepted, the shipped
  root loads whatever `agent.cwd` is, the ledger folder's location is not checked, and `danger-full-access`
  does not switch plugins off.
- The ledger folder (`data/plugins`) holds an **audit record**, not a gate. See "The audit record".

The companion can change anything the OS user can, by design. Companion mode does not try to confine it; see
"Where to put the house" for the boundary worth having.

**Person mode (`plugins.trust: person`, opt-in).** Nothing runs until you have read and ratified a plugin's
exact code (see Ratifying), a change stops it until you ratify again, plugin roots and the ledger must be
outside the companion's writable folders, and plugins are off under `danger-full-access`. **`sanctum.yaml`
is read once, at startup, in this mode: a change to `plugins.enabled` or `plugins.dir` applies after a
restart**, and the internal token cannot change `plugins.enabled` (`PUT /api/plugins/enabled` answers
`403 {"error": "trust_person"}`). Settings > Plugins shows each plugin's ratification state and lets you review
and ratify it (turning a plugin on or off is an edit to `sanctum.yaml`).

The setup wizard (`scripts/setup.mjs`) asks "Who manages plugins?" first, default your companion. Under
that answer it skips ratification and writes `plugins.trust: companion`; under "you" it runs the ratification
step described below.

**The routes under `/api/plugins`** (mounted before the main api router, so a plugin cannot shadow them):

| Route | Auth | Companion mode | Person mode |
|---|---|---|---|
| `GET /` | session | `{ trust, plugins }`; each entry has `audit` and `warnings` | `{ trust, plugins }` (or `{ trust, disabled, detail?, plugins: [] }`); each entry has `ratification` |
| `PUT /enabled` `{ enabled: string[] }` | session, or the internal token (through the write switch) | `200 { ok, enabled, unknown }`; `400 enabled_required`; `500 config_write_failed`; `501 not_supported` | session: `200 { ok, enabled, applies: "restart" }` (writes the file only; applies on restart); internal token: `403 { error: "trust_person" }` |
| `POST /:id/reload` | session, or (companion mode) the internal token | `200 { ok, plugin }`; `404` unknown, not enabled, or no routes; `503` when the import fails | session only, as before |
| `POST /:id/seen` `{ digest? }` | session | `200 { ok, plugin, digest }`; `409 digest_mismatch` when `digest` is not the last recorded one; `409 plugin_invalid`; `409 plugin_not_enabled`; `404` | `409 { error: "trust_person" }` |
| `POST /:id/ratify` `{ digest }` | session only | `409 { error: "trust_companion" }` | as described under Ratifying |
| `GET /:id/files`, `GET /:id/file?path=` | session | the live folder | the live folder |
| `ALL /:id/internal/*`, `ALL /:id/*` | internal token (then the write switch on writes) / session | by id, from the live folder, `404` while not enabled | from the ratified copy, `503 plugin_not_ratified` otherwise |

Misconfiguration is visible rather than silent: an id in `plugins.enabled` with no
plugin on disk logs a warning at boot and is listed as
`{id, enabled: true, error: "not found on disk"}`; a `plugins.dir` that does not exist
logs a warning; the legacy `plugins_dir` key logs a warning naming `plugins.dir` and
the value it would have migrated.

### The audit record

In companion mode the ledger folder holds `audit.json` (default `<project>/data/plugins/audit.json`;
`plugins.ledger_dir` moves it), separate from `ratified.json`. On every load, run, request, reload and
list, the app computes the plugin folder's digest (the same hash as person mode: every regular file,
sorted by relative path, one sha256 each; a link inside the folder, more than 2000 files or 25 MiB means
it cannot be recorded, and the plugin still runs) and compares it with the last one recorded. When it
differs, the app records `{ digest, files, seen_at, changes }` as the new "last seen", with `changes` listing each
path as `added`, `removed` or `modified`, and keeps the last 20 records per plugin. No person action is
involved and nothing stops running. The file is written atomically (temp file, then rename), 0600 where the
platform honours it. A plugin that was ratified before the switch to companion mode starts from its ratified
entry, already seen. Only **enabled** plugins are audited: a plugin that is not enabled has no record and no
"changed since you last looked" flag until you enable it. If `audit.json` is malformed, the app logs one loud
warning naming it, keeps it as `audit.json.corrupt-<timestamp>` beside it, and starts a fresh record.

**Who can edit the record.** In companion mode the ledger folder may well be inside the companion's reach
(by default it is `<project>/data/plugins`, and a companion with file access can write there). The companion
can therefore edit or delete `audit.json` as easily as it edits a plugin. The record is for your eyes, so you
can see what changed and look at it; it is not a tamper-proof log, and it does not stop or prove anything. If
you need a record the companion cannot touch, use `plugins.trust: person` and keep the ledger out of its reach.

`GET /api/plugins` carries, per plugin, `audit: { digest, last_change_at, changed_since_last_view, changes }`
(`null` when the plugin is not enabled, or when the folder cannot be recorded). `changes` is everything that differs from the code the person last
marked as seen, so several edits since the last look add up; a plugin never viewed lists every file as
added. `POST /api/plugins/:id/seen` records the current code as viewed (with the `digest` the list showed
you, it refuses with `409 digest_mismatch` if the files changed since, so what you mark is what you saw).

Settings > Plugins shows an enabled switch per plugin, a "Changed since you last looked" marker, **Review**
(the changed files first and the full file list; tap a file to read it, from `GET /:id/files` and
`GET /:id/file`) and **Mark as seen**. There is nothing to ratify.

### Ratifying (trust: person)

*This section describes `plugins.trust: person`. In companion mode (the default) nothing is ratified.*

Naming a plugin in `plugins.enabled` is not enough to run its code. The person also
**ratifies** the plugin's exact code, by hash, in the app. Code that differs from the
ratified digest contributes nothing until it is ratified again. This is the integrity
axis (see Trust below) applied to plugins.

**What ratification covers.** Ratification holds against changes made by anything that cannot also write the ledger: a companion confined to its roots (Codex or dsh in `workspace-write`, Claude's `Write` and `Edit` tools behind the write gate), another process, a plugin update, a bad copy. A process that runs as the same OS user with unconfined file access (Claude with `Bash` under `bypassPermissions`, or any harness in `danger-full-access`) can rewrite the ledger and the ratified copies, so in person mode choose a confined harness if you want the gate to hold. See "What this means today" below.

The app does what it can on its side of that line: the ledger is held to the same
containment rule as a person plugin root (see "Where the ledger lives"), and with
`danger-full-access` on Codex or dsh plugins are switched off outright (see "Full access
turns plugins off"). It cannot see what a Bash command does.

**What this means today (person mode).** The companion runs as the same OS user as the app: the harness is a
child of the app, and the app has no option to start it as another user. The ledger and the
ratified copies are owned by that user (0600 files, 0700 folders), so a process that can run
arbitrary commands as that user can read and write them, ratification included. The gate therefore
holds against a confined companion, and a confined companion is what person mode asks for:

- Claude always has `Bash` (the app sets no allowed or disallowed tools for it and has no
  setting for them), so with Claude the ledger is within the companion's reach. For the gate to hold, run
  Codex or dsh in `workspace-write` or `read-only`: those confine file writes to the roots the app
  knows about, and the roots check and the ledger rule keep the plugin roots and the ledger out of
  them. Claude's write gate covers only `Write` and `Edit`, not `MultiEdit`, `NotebookEdit` or MCP tools.
- Keep **the companion's home, the plugin roots and the ledger folder in separate folders** (none
  inside another). The app refuses a layout where one contains the other.
- Reading a plugin's files in Settings before you ratify it is the check that no tool can do for you.

A spawn-as-a-separate-user option is **not built**, and a recipe for one (a `useradd` and a
wrapper script) does not work here: the snapshots are 0600 and 0700 and owned by the app user, the
harness child runs as the app user, and `useradd` does not exist on macOS. For a boundary around the
whole app, see "Where to put the house".

**What is hashed.** Every regular file in the plugin folder (the folder holding
`sanctum.plugin.json`), sorted by posix relative path, each with a sha256 of its
contents. The plugin's `digest` is the sha256 over `relpath\0sha\n` lines. A symlink
anywhere in the folder is a scan error ("plugin folders may not contain links") and
the plugin is refused. More than 2000 files or 25 MiB is refused too: keep
dependencies outside the plugin folder.

**What the scan reads. Code outside the folder is not covered, so the obvious ways in are refused** (in person mode; in companion mode the same scan runs and reports `warnings`). The hash
cannot reach a file outside the plugin folder, so code that reaches one runs bytes the hash never
saw. At scan time (and again on the bytes being copied when you ratify) the scan does this:

- A folder that holds any `.ts`, `.mts`, `.cts`, `.tsx` or `.jsx` file is refused whole ("plugins
  ship JavaScript"): Node can strip types and run such a file, and the scan does not read it.
- Every file in the folder is read as plain text whatever its extension (Node runs
  `require('./helper.txt')` as JavaScript, and an extensionless file under `"type":"module"` is a
  module), comments and strings included, in any quote style (or none), and cut into path-like pieces. A piece is refused when,
  after JavaScript string escapes (`\x2e`, `.`, `\u{2e}`, `\.`, a `\t` that the URL parser
  strips, a line continuation) and percent escapes (`%2e%2e`, `%2f`, `%5c`) are undone, it
  contains a `..` segment that climbs out of the plugin folder, judged from the file's own folder
  (`../sibling.mjs` two folders down is fine; `../../../x` is not), or it is an absolute path or a
  `file:` URL that points inside a folder the companion can write (`agent.cwd`, the Codex extra
  directories, the dsh home, the write-gate roots, `plugins.dir`, and, while Codex or dsh runs,
  `/tmp` and `$TMPDIR`), compared the way the write gate does (case folded). Only a `%` followed
  by two hex digits is a percent escape; the "escapes that cannot be decoded" are `%XX` sequences
  that decode to invalid UTF-8 (`%E0%A4`), and one in something that looks like a path is refused
  too. `%zz` and a printf-style `/%s` are not escapes: they are literal text, and Node refuses
  `%zz` in a specifier as a malformed URI.
- A `data:` URL anywhere in a file (`data:text/javascript;base64,...`, `data:,...`) is refused
  outright ("data: URLs cannot be ratified"): its payload can hide a `file:` import.
- Every file is scanned as text, whatever its extension, and a NUL byte counts as a token
  separator. NUL is legal inside a JavaScript comment or string, so a file whose first kilobytes are NULs
  inside a comment can still be loaded by Node; no file is skipped as binary. A binary file whose
  bytes contain a path-like token is refused; keep images out of plugin folders or rename the token.
- A template literal with a `${` where a specifier goes (`import(\`./${x}\`)`, `require(...)`,
  `import.meta.resolve(...)`, `new Worker(...)`, `createRequire(...)(...)`) is refused as a
  "dynamic specifier".
- A manifest path (a row `entry`, `routes`, `help`) that resolves outside the folder is refused too.

The error names the file and the text it objected to. Because comments and strings are read as text,
**a comment or a regular expression that merely mentions such a path is refused as well** (for
example `// see ../docs`, or `/\.\./` in a path check); reword it. The scan does not try to strip
comments: a quote inside a regular expression or a comment would make a comment stripper lose track
of where a string starts, and a refusal that can be dodged that way is worth less than a false alarm.

**What the scan still misses.** It reads text; it does not run code. It cannot see: a path put
together at run time (`import(name)`, `'.' + './x'`, `String.fromCharCode(...)`, path pieces
handed to `join(here, '..', '..')` one at a time, a template specifier called through an alias
such as `const r = createRequire(url); r(\`./${x}\`)`); a bare package name (`import 'left-pad'`),
which Node resolves by walking up from the ratified copy's own location (a `node_modules` inside
the plugin folder, or the ledger folder's parents), not from the app's `node_modules`, so what it
finds is whatever sits above the ledger folder;
an absolute path or URL outside every companion-writable root; a file in the plugin folder that
is a hard link to one outside it (a hard link is an ordinary file to the hash: the copy is made at
ratify time, so an edit through the other name is seen as a change, but the bytes ratified are
whatever the link held then). Plugins should use `api.Router()` and `api.express` and ship no
dependencies.

**Where the ledger lives.** `<plugins.ledger_dir>/ratified.json`; the folder defaults to
`<project>/data/plugins`. Shape:
`{ "version": 1, "plugins": { "<id>": { "digest", "files": { "<relpath>": "<sha256>" }, "ratified_at", "root", "previous"? } } }`
(`previous` is the digest ratified just before, whose copy is kept until the next start; see below).
It is written atomically (temp file, then rename), mode 0600 where the platform honours
it. A malformed ledger logs a loud warning and counts as empty: nothing is ratified.
Back up the whole folder with the rest of `data/`.

The ledger folder, and the ratified copies inside it (below), get the same rule a person
plugin root gets: if the folder resolves (symlinks followed) inside, or contains, anything the
companion can write (`agent.cwd`, `hooks.workspace_root`, `hooks.vault_path`,
`hooks.safe_write_prefixes`, `hooks.extra_write_paths`, `agent.codex.additional_directories`,
the dsh home, `plugins.dir`, and, while Codex or dsh is the active provider, `/tmp` and `$TMPDIR`: their
`workspace-write` sandboxes include both unless `exclude_slash_tmp` / `exclude_tmpdir_env_var` are set, and
this app sets neither), compared case-folded, as the write gate does on every OS, plugins are **off**: no dsh rows, no routes, no help topics, and
`GET /api/plugins` answers `{"disabled": "ledger_writable", "detail": "<which root>", "plugins": []}`.
One loud warning names the root and the fix. The fix is to set `plugins.ledger_dir` in
`sanctum.yaml` to a folder outside all of those and restart. With the default `agent.cwd`
of `.` (the app folder) the default ledger folder is inside it, so plugins are off until you
either move the companion's home elsewhere (the setup wizard does) or move the ledger. The
wizard checks this and asks for a ledger folder when the default clashes.

**The ratified copy is what runs.** Ratifying copies the plugin folder to
`<ledger folder>/snapshots/<id>/<digest>/` (each file hashed as it is copied; if any byte
differs from the digest you were shown the ratify is refused and nothing is written; the copy
is built in a temp folder and renamed into place; 0600 files and 0700 folders where the
platform honours it). Then:

- `routes.mjs` and everything it imports are loaded from the copy, never from the live folder.
  The bytes imported are the bytes hashed, and ratifying changed code gives a new path, so
  every module is fresh (an ES module cannot be evicted; a new path is the way around that).
- dsh rows and the help topic are read from the copy: a row's file path points into the
  snapshot.
- **The manifest that runs is the copy's.** The live `sanctum.plugin.json` is read once at
  startup, for discovery, the list and the scan error. Whenever the check says `ok`, the rows
  (their `name`/`entry`, `config`, `harness`, `runs`), the help file, the routes file and anything
  else derived from the manifest come from the `sanctum.plugin.json` inside the ratified copy,
  read and validated again for that check. A manifest that is edited and put back cannot change
  what runs while the plugin reports `ok`, and a manifest change you ratify is picked up on the
  next run or request without a restart (a plugin whose manifest, at ratification, is not valid, or
  names another id, contributes nothing and logs one warning). Routes mount at startup for every
  enabled plugin; a plugin whose ratified manifest names none answers its requests like an
  unknown one. A plugin whose scan failed at startup serves nothing until the ratify route has
  scanned it clean.
- The live folder is still what is checked, on every run and every request: the folder is walked in
  full each time, and a file is hashed again unless its size, mtime, ctime and inode are what they
  were when it was last hashed (see "The stat prefilter"). When it differs from the ledger the
  plugin goes quiet until you ratify again; running the copy covers the window between a run's
  check and dsh importing the file, and routes. Measured on Linux (node 22): a typical plugin
  (the shipped `hello`) costs about 0.04 ms per check; a plugin at the cap (2000 files, 25 MiB)
  costs about 50 ms for a full rehash and about 10 ms with the prefilter, which is what a request
  pays.
- Two copies per plugin are kept: the current digest's and the one before it (the ledger's
  `previous`), because a request or a lazy `import()` that started under the old copy may still be
  reading from it. Anything older is deleted after a successful ratification, and the previous copy
  and the copy of a plugin that is no longer in the ledger are deleted at startup. There is no
  un-ratify route. A ledger entry whose copy is missing reports `unavailable` ("the ratified copy
  is missing... ratify it again") and runs nothing.

**The stat prefilter.** Per file, the check remembers the sha256 together with the file's
`{size, mtimeMs, ctimeMs, ino}` and rereads only a file whose tuple changed. The set of files is
walked every time, so an added, removed or replaced file is never missed. It is sound on POSIX
because ctime cannot be set: `utimes` (and `touch -r`) can put size and mtime back after an edit, but
every write, rename, link, chmod and `utimes` sets ctime to the kernel's clock, so the edit still
changes the tuple (only root moving the clock, or writing to the disk behind the file system, gets
around it). Two guards cover what stat cannot see: a cache entry is not trusted while the file's
newest timestamp is within 2 seconds of when it was hashed (a second write in the same timestamp tick
would look unchanged), and every entry expires after 60 seconds, so a file changed through a
long-lived writable memory mapping (which can change bytes without a new ctime) is read again within a
minute. On Windows ctime is the creation time, so nothing is cached there: every check rehashes.

**What happens on a change.** Each plugin reports a `ratification` state in
`GET /api/plugins`: `ok`, `unratified` (never ratified), `changed` (the files differ
from the ratified ones; `changes` lists each path as `added`, `removed` or `modified`),
or `unavailable` (the digest could not be computed: a link, a cap, a read error, a missing
copy; `detail` says which). Any state but `ok` means the plugin contributes nothing: no dsh
rows, no routes, no help topic. Its list entry carries `error: "not ratified: ..."` or
`"changed since ratification: N files (a, b, ...)"`, naming up to five paths. In the `changed`
state the list shows the live manifest as read at boot, so its name and version may be stale until
you re-ratify or restart. The check is
one function with one answer, shared by rows, help, the list and every route request, so an
edit that keeps a file's size and mtime is seen by all of them at once (it changes ctime). A request to a plugin that is not ratified answers
`503 {"error": "plugin_not_ratified", plugin, state, changes}` and imports nothing. A router
already serving when the files change answers 503 on its next request; after the person
ratifies the new code the plugin is imported again from its new copy, not reused. One warning
is logged per plugin per change of state.

**Ratifying.** `POST /api/plugins/:id/ratify` with body `{ "digest": "<sha256>" }`, behind
session auth only: the internal token cannot reach it, so the companion cannot ratify its
own edits through the app. The server scans the plugin again as it is on disk now (the manifest
and the folder, not the answer from startup, so a plugin that was fixed since the start can be
ratified without a restart), reads the files, and if the digest of what it read is
not the body's (a file changed between the person looking and tapping) it answers
`409 {"error": "digest_mismatch", "expected": <what it read>, "changes": [...]}` and writes
nothing, so a change is never ratified blind. On a match it writes the copy and the ledger
entry and answers `{"ok": true, "plugin", "digest", "files": <count>}`. A plugin that is not
enabled may be ratified (ratify first, then enable). A plugin with a scan error (a bad
manifest, a missing file, an import that leaves the folder) is refused:
`409 {"error": "plugin_invalid", "detail"}`. If the copy or the ledger cannot be written:
`500 {"error": "ledger_write_failed", "detail"}`.

To let the person read what they are about to ratify, two read routes (session auth, from the
live folder as it is now):

- `GET /api/plugins/:id/files` lists `{ files: [{ path, sha256, size }] }`.
- `GET /api/plugins/:id/file?path=<relpath>` returns `{ path, sha256, size, text }` for a file
  up to 256 KiB that is valid UTF-8 (a U+FFFD character in it is still text), otherwise
  `{ path, sha256, size, binary: true }`. The path must be one of the listed relative paths,
  compared as a string and never resolved, so there is no traversal: anything else is
  `404`; no `path` (or more than one) is `400 {"error": "path_required"}`; a folder that
  cannot be read is `409 plugin_invalid`. Settings > Plugins uses it: each file in Review
  is tappable and shows its text, changed files first and marked.

These routes are registered ahead of the per-plugin mounts, like `/reload`, so a plugin cannot
shadow them (a plugin's own public `/files`, `/file`, `/ratify` or `/reload` route is
unreachable for that reason). `POST /api/plugins/:id/internal/ratify` reaches only the
plugin's own internal router.

**Shipped plugins are ratified like any other.** There is no exemption: the shipped root
is only as safe as the files in it. The setup wizard (`scripts/setup.mjs`) ratifies the
shipped plugins you turn on, but only after the questions and before it writes
`sanctum.yaml`, and it writes `plugins.enabled` with the ids that are ratified now: the shipped
ones that ratified in that run, and the ones of your own that already have a ratification (a
plugin of your own that is enabled but not ratified is left out, with a message naming
Settings > Plugins). For a plugin never ratified it prints the file list and asks "Ratify this
code? [y/N]"; for a shipped plugin whose code differs from the ledger it prints the changed
paths (kind first, up to 10) and the digest and asks "Ratify this changed code? [y/N]". Both
default to no: you type `y` after reading the list. An id left out says so. The wizard keeps a
JavaScript copy of the ratification code (snapshot writing, the import scan, the containment
rule); it hashes an existing copy again before trusting it, and a test compares its output with
the backend's on a set of fixtures. A ledger write failure is reported, not a crash. The wizard needs a terminal,
so it never ratifies changed code unattended. After an update changes a shipped plugin's
files, it needs ratifying again.

Limits, stated plainly: the check happens before the import and the copy is what is
imported, so there is no gap between hashing and loading for a plugin's own files; the
things the hash cannot see are the ones named above (code outside the folder, a bare package
name, a run-time specifier) and anything a same-user unconfined process does to the ledger.

### Full access turns plugins off (trust: person)

*Person mode only. In companion mode (the default) `danger-full-access` does not switch plugins off:
the companion manages them, and the boundary is the machine (see "Where to put the house").*

The roots check above only means something while the companion is confined. In person mode, when the
**active** harness runs with `danger-full-access` (`agent.codex.sandbox_mode` while
`agent.provider` is `codex`, `agent.dsh.sandbox_mode` while it is `dsh`), the companion
can write anywhere the OS user can, so no plugin root is out of its reach, the ledger
included, and plugin code (which runs unsandboxed) could be code the companion wrote. In
that state the loader loads **no** plugins: no dsh rows, no routes, no help topics,
whatever `plugins.enabled` says. It logs one loud warning naming the setting and the
enabled ids it did not load, and `GET /api/plugins` answers
`{"trust": "person", "disabled": "full_access", "plugins": []}`. Set the mode to `workspace-write` or
`read-only` and restart to get plugins back. A setting on a harness that is not the active
one does not count.

**Claude has no such switch.** The Claude harness has no sandbox mode; it runs
`bypassPermissions` and the app's PreToolUse hook (`services/hooks.ts`) is the only write
boundary. That hook confines the `Write` and `Edit` tools to `agent.cwd`,
`hooks.workspace_root`, `hooks.vault_path`, `hooks.safe_write_prefixes` and
`hooks.extra_write_paths`, and the roots check above (and the ledger rule) keeps plugin roots and
the ledger out of those. It does **not** confine `Bash`: the hook only blocks a list of
destructive command patterns (`DESTRUCTIVE_BASH_PATTERNS`), so a Bash command can write
anywhere the OS user can, a plugin folder, the ledger and the ratified copies included. So with
Claude, person mode's ratification still catches a bad copy, a plugin update, an editor that touched
the wrong file and any `Write`/`Edit` change, but it is not a boundary against a companion that
uses Bash that way. That is why companion mode is the default: say plainly who manages the plugins
instead of gating them. If you want the gate to hold, use Codex or dsh in `workspace-write` or
`read-only` (see "What this means today"). Ratifying does not make a plugin safe either way: read the files first.

## Where to put the house

The only boundary worth recommending is the machine, and the app does not enforce it.

- **Windows:** run the whole app inside WSL2 (Node, the harness, the companion's home and the app's data all
  live in the Linux side), so the companion's reach is the WSL2 distribution, not your Windows profile.
- **Linux and Mac:** give the app a dedicated user, or at least a dedicated directory, and keep what you would
  not want the companion to touch (your documents, SSH keys, other projects) out of that user's reach.

In companion mode the companion can change anything the OS user can, by design. It builds plugins, edits them,
and turns them on; the audit record and Settings are there so you can see what it did, not to stop it.

## What the loader injects

Every plugin dsh row's `config` is merged with a `sanctum` object the plugin never
has to discover:

```json
{
  "sanctum": {
    "baseUrl": "http://127.0.0.1:3099",
    "token": "<internal token>",
    "threadId": "daily-2026-10-19",
    "tenant": "default",
    "runKind": "turn" | "wake" | "helper" | "summarizer",
    "senderIsOwner": true
  }
}
```

`senderIsOwner` fails closed. An explicit answer always wins. Web, API, WebSocket and
Telegram callers say `true` (they are owner-only surfaces), Discord says `true` only
for the owner. When nobody says: `true` for `wake`, `helper` and `summarizer` runs
(no one is speaking), **`false` for a `turn`** (a caller that cannot say who is talking
is not assumed to be the owner). A plugin that answers questions or approvals must
refuse when it is false. The loader merges `sanctum` into the row's `config` beside
the plugin's own keys, which it never drops.

The token travels in row config, not the environment: dsh-exec's child env is an
allowlist and stays that way. The overlay file lives in the run's temp root, which
is removed after the run, as the MCP headers already do.


## App side

- `routes.mjs` default-exports `(api) => Router`. Today `api` gives the plugin:
  `config` (the loaded `sanctum.yaml`), `log(...)`, and `express` and `Router`
  (`api.Router()` is `express.Router()`). Use `api.Router()` rather than
  `import express from 'express'`: a plugin in the person's own root sits outside the
  app's `node_modules` and cannot import `express` (it would fail with "Cannot find
  package 'express'" and a 503). `import express` in a shipped plugin works only while the ledger
  folder is inside the app folder (the default `<project>/data/plugins`): in person mode a ratified copy runs from the
  ledger folder, and Node looks for bare package names in the folders above the copy, so once
  `plugins.ledger_dir` moves outside the app folder it fails with `ERR_MODULE_NOT_FOUND`. The ledger
  folder cannot default to a place where the app's `node_modules` resolves, because the app folder is
  often writable by the companion and the ledger must not be. A plugin that needs a package vendors it
  inside its own folder (`node_modules/<pkg>`, which the hash covers); `api.Router` needs no package at
  all. **Planned, not built:** `db` (read-only handle),
  `broadcast(message)`, `wake(prompt, opts)`, `approvals`, `timers`. Routes mount at `/api/plugins/<id>` behind session auth; a
  plugin may mark a sub-router `internal` to mount it behind the internal token
  instead (for its own dsh half to call back).
- `appWriteGate` (the companion's write switch, `agent.app_write`) guards the internal
  (token) sub-router only, as it does `/internal/*` in `api.ts`. The person's own
  session-authenticated requests to a public route are not the companion writing.
- `routes.mjs` must return an `express.Router()` (or `{public, internal}` of them).
  An `express()` sub-app, a bare function or anything else is rejected at import with
  a clear `error` and a 503.
- A handler that throws or rejects (async handlers, async `router.param` callbacks,
  async 4-argument error middleware, routes registered after import) answers JSON 500
  `{error:"plugin_failed", plugin}`. As a safety net for what Express cannot see, each plugin
  dispatch runs in an `AsyncLocalStorage` context and one `unhandledRejection` handler
  in `plugins.ts` answers the request (or ends it, when headers are already sent)
  instead of letting the process die. **It covers rejections only** (a floating
  promise). A synchronous throw inside a plugin timer, or an unhandled `'error'`
  event, is not a rejection and still ends the process. A rejection outside a plugin
  context is rethrown, as Node does by default.
- A routes.mjs that fails to import is marked `error` (shown in `GET /api/plugins`),
  answers 503 `{error:"plugin_unavailable", plugin}`, and **stays failed**: there is no
  retry on request, since every import attempt leaves a module instance in memory that
  ESM cannot evict. Recovery is `POST /api/plugins/<id>/reload` (session auth, or the internal token in companion mode; POST only, a GET to that path
  falls through to the plugin), which re-imports `routes.mjs` once under a fresh
  cache-buster, or a restart. If a reload's import fails on a plugin that was already
  serving, the previous working router keeps serving; the reload answers 503 with
  `detail` and the list `error` says so, until a later reload succeeds and swaps it in. A reload
  re-evaluates `routes.mjs` only: a fixed **dependency** file that `routes.mjs`
  imports keeps its cached copy, so that needs a restart.
- `help.md` is served as `res help <id>` and listed in the orientation's one-line
  topic index.
- `ui/` (**not built**: the manifest field is accepted and ignored) is meant to be static, served at `/plugins/<id>/ui/`, and shown as a tab exactly as
  the Browser tab is today (iframe, same CSP derivation). No frontend build step
  for plugins.

## Core changes this needs

1. `services/plugins.ts` — scan both roots, validate manifests, expose
   `pluginRows(ctx)`, `pluginHelp()`, `pluginTabs()`.
2. `dsh-exec.ts buildOverlay` — append `pluginRows(ctx)`. (Flipping `approval` per
   the rule above is the answerer item, not built.)
3. `server.ts` — mount plugin routers and static ui.
4. `tool-help.ts` — plugin topics appended to the index.
5. `App.tsx` / `NAV_ITEMS` — tabs from `GET /api/plugins` instead of a static
   list for plugin-provided entries.
6. `.mcp.json` stays the path for MCP servers; a plugin may *ship* an `mcp` block
   in its manifest that the loader merges into the run's MCP set.

Codex and Claude: a plugin whose manifest lists only `dsh` under `harness` simply
contributes no rows there. Routes, help and ui still load. Tool-level plugins that
must work on all three harnesses expose their tools over MCP (manifest `mcp`), which
every harness already consumes.

## Trust: three axes, not tiers

Framing adopted as written. One word was doing two jobs; it is split.

| Axis | Question | Who answers it | How |
|---|---|---|---|
| Integrity | Has this been tampered with? | the engine | Code is verified at install and pinned, re-verified only on a user-chosen update (G11). (Plugin code is the exception, below: by default it is recorded and shown, not gated.) Memory content cannot be "verified at setup" because the store is written daily: every write is signed by the mind process at runtime and the store is append-only; corrections are dated amendments. |
| Provenance | Who said it? | the write path | A tag rides with the chunk: `user`, `companion`, `discord:<id>`, `web`, `webhook:<id>`, `mcp:<server>`. Stored beside the prose, never inside it (OpenClaw's mechanism, our policy). Provenance never gates recall: nothing forgets on its own, no trust-based exclusion. |
| Authority | Can this instruct? | the prompt | Only the ratified identity and the person's live words instruct. Everything else is data the companion reads, memory included: a memory of someone saying "ignore your rules" is a record of them saying it. The Revien header already states this and stays as written. |

Memory therefore reads: trusted by integrity, mixed by provenance, data by
authority. Webhook payloads, channel messages and fetched pages read: unsigned,
foreign, data. The difference is on two axes, not one stamp.

**Plugin code on these axes.** By default (`plugins.trust: companion`) plugin code is neither verified nor pinned:
your companion writes, edits and enables it, and the integrity axis is served by the audit record, which notes every
change to a plugin's files and shows the person what changed since they last looked. Authority is unchanged: plugin
output is data, and only the person's live words instruct. The person-gated mode (`plugins.trust: person`) is the
integrity axis applied to plugin code as a gate: the person ratifies the exact code by hash, and a change stops it
until they ratify again. Neither mode is a sandbox; the boundary is the machine ("Where to put the house").

### Identity ratification (integrity axis for the spine)

Built on `feat/identity-authorship`. The files directly in `<agent.cwd>/identity/`
are the identity; the person ratifies their exact content by hash, and a run
boots on the last ratified version.

**One source.** `services/identity/source.ts` reads the set: every regular file
directly under `identity/` except dot files and avatar images, with the same file
and size caps as a plugin folder, a realpath-contained folder, links skipped and
named, names matched case-folded. The Claude system prompt, the Codex and dsh
identity block and the public Discord lane all render from it. Before this, the
Claude loader read paths resolved from the project root and never saw the home's
`profile.md` and `companion.md`. `identity.profile_path` and `companion_md_path`
remain as overrides that name a file inside `identity/`. The legacy `CLAUDE.md`
lookup runs only when the home has no `identity/` folder.

**Ledger** (`services/identity/ledger.ts`, folder `identity.ledger_dir`, default
`data/identity`; not the plugin ledger, whose pruning must never reach it):

- `ledger.json`: `{ version: 1, ratified?: { digest, files, ratified_at, by }, previous?, observed?, announced?, announced_at? }`.
  `by` is `person` or `setup`. `observed` is the last state the journal records,
  with `author` (the latest) and `authors` (everyone since the ratified digest);
  `announced` and `announced_at` are the digest and time a thread line was last
  posted for, cleared when the files are the ratified ones again.
- `journal.jsonl`, append only, one line per detected or declared change:
  `{ at, digest_before, digest_after, files: { added, removed, modified }, author, detail, kind? }`.
  `author` is `person` (the in-app editor), `companion` (the identity write verb),
  `filesystem` (a change on disk that no app route made), `baseline` (first sight
  of the folder) or `revert`. A `filesystem` line says which harness first noticed
  it and whether a turn was running, and nothing more: it does not say who wrote
  the file. `kind: "ratify"` marks the line that records an approval (the person's edit while `ok` writes the edit and then the approval).
- `snapshots/<digest>/`: the ratified copy and the one before it, copied with the
  plugin ledger's stage-and-rename code (`plugin-ratify.ts`).

The check (`checkIdentity`) walks the folder, hashes it through the same
per-file stat prefilter as plugins (off on Windows) and answers `ok`, `pending`
(live differs from ratified), `unratified` (nothing ratified yet) or
`unavailable` (the folder cannot be read, the ledger is damaged, or its folder is
inside `identity/`, which is refused). A home with no `identity/` folder at all
(and nothing ratified before) is `legacy`: identity is `CLAUDE.md`, there is no
header notice or thread line, and no ledger is written. Every served copy is
rehashed (same prefilter) against its digest first: an altered ratified copy falls
back to the version before it, else the check is `unavailable` naming the copy.

**Boot.** Every place identity is read runs the check: per query on Claude, per
turn on Codex and dsh (first message of a resumed thread when
`identity_every_turn` is off), per public-lane message. It serves the ratified
snapshot whenever one exists. While a change waits it adds one fixed line to the
identity block: "A change to <files> is waiting for the person to ratify it; this
run uses the ratified version." With nothing ratified yet it serves the live
files. When the check cannot run it serves the ratified copy if there is one,
and the live files if not (an identity of nothing would be worse), and in that
case adds the line "The ratified identity could not be read; this run uses the
live files. Ratify in the app." When the ratified copy is missing but the one
before it is intact, that one is served and the state is `pending`, with a note.
The public lane gets the ratified text and not the line. With no usable ratified
copy (nothing ratified yet, or the ledger damaged or missing its copies) the public
Discord lane serves the live files with no line, so text nobody has ratified can
reach strangers until the person ratifies; the header notice in the app ("Identity
not yet ratified" or "Identity needs attention") is where to see that.

**Telling the person.** A newly noticed pending change posts one system line to
today's thread ("Identity change waiting: <files>. Changed by your companion and
you. Settings > Identity.", kept out of the model's history). The line goes out
when the state moves into pending, and while it stays pending at most once per ten
minutes even when the digest keeps changing; it comes again when a change returns
after the files were back at the ratified version (a ratify, a rollback, a check
that finds them `ok` clear the mark). `identity_status` is pushed over the socket
whenever the state or the digest moves. `unavailable` posts one line on entering
it. The authors are everyone who changed the files since the ratified version, in
the order they first did (`pending.authors`; `pending.author` is the latest). The
chat header shows a quiet "Identity change waiting", "Identity not yet ratified"
or "Identity needs attention". In Settings > Identity an `unavailable` state shows
the reason and a Ratify button when ratifying can go ahead (`status.canRatify`);
ratifying over an unreadable `ledger.json` sets it aside as
`ledger.json.damaged-<time>` and starts a new record. The companion can ask with
`res identity status`; it cannot ratify.

**Routes.**

| Route | Auth | Does |
|---|---|---|
| `GET /api/identity/status` | session | state, digests, what is waiting and who changed it |
| `GET /api/identity/history` | session | the journal, newest first, at most 200 |
| `GET /api/identity/files` | session | live file text and the digest it was read at |
| `GET /api/identity/diff?from=&to=` | session | unified diff per file between a digest, `ratified` or `live`; 256 KiB per file |
| `POST /api/identity/ratify {digest}` | session only | 409 when the files moved since that digest; 200 with `unchanged: true` (nothing written) when they are already the ratified ones |
| `POST /api/identity/revert {digest}` | session only | writes the ratified copy back over live; journaled `revert` |
| `PUT /api/identity/file {path, text, digest}` | session only | the person's edit; ratifies in the same step only when the folder was `ok` before it |
| `GET /api/internal/identity/status` | internal token | read-only (`res identity status`) |
| `POST /api/internal/identity/file {path, text}` | internal token + `agent.app_write` | the companion's edit; journaled `companion`; never ratifies |

The internal token never stands in for a session on the person's routes. Writes
are atomic (temp file, then rename), owner-only where the OS honours it, and the
path must be a plain file name directly in `identity/` (no folders, no dot files,
no links, case-folded).

**What this protects against.** Anything that can write `identity/` but cannot
also rewrite the ledger folder: a hostile edit does not take effect until the
person ratifies it. Anything that can rewrite the ledger folder can ratify its own
change. The Claude harness has unconfined file access as the app's OS user, so
on it the companion's own file tools can rewrite the ledger folder, wherever it
sits, unless the ledger is placed elsewhere (a folder the companion's session
cannot reach: "Where to put the house"). This is a gate against a drifting or
hijacked companion, not a sandbox. The default, `data/identity`, is outside the
folders the app itself lets the companion write (the home, the write-gate roots,
the Codex and dsh folders), but that does not confine the Claude harness. Unlike the
plugin ledger, which refuses to start with its ledger inside such a folder,
identity has no person-mode gate to refuse in: the app logs a warning at start and
shows the same warning in Settings > Identity (`status.warning`) when
`identity.ledger_dir` is inside, or contains, a folder the companion can write.

**Not done.** The wire types (`IdentityStatus` and the journal entry) live in
`services/identity/types.ts` and are mirrored in the frontend, not in
`packages/shared`, and `identity_status` is sent with the same cast as
`mantelpiece_update`.

## Skills: three tiers (from skills-design.md, decided)

| Tier | Writes | Sees |
|---|---|---|
| 1. User defaults | the person only | every construct; read-only to companions |
| 2. Commons | any companion proposes, the person approves every publish and edit | every construct |
| 3. Companion's own | that companion | that companion |

Wired as one `@deepseek-ai/dsh-skill-filesystem` row with `includeDefaultRoots:
false` and `customSkillDirs` in tier order; the skill write tool refuses a
colliding name up front rather than relying on dsh's silent shadowing; filesystem
permissions are the real guard. Reflection: a proposal is written at the rolling
fold, built or dropped at the next wake. Tier 1 lives outside the companion home,
since the home is the write boundary.

## Order (agreed 2026-10-19; maintainer's call)

1. The loader: the slot everything else rides. Smallest core change.
2. Agent-driven browser: one `.mcp.json` entry against the neko seat's CDP relay, plus a skill and an `AGENTS.md` line.
3. Discord holes D1, D2, D11, D5 (messages dropped, thread race, silent failure, in-memory deferral). Live bugs beat new features.
4. Watchdog and key-rotation audit (G5, G6).
5. Skills, three tiers.
6. Approvals and structured questions answerer, user-enabled, turns only.
7. Identity ratification (built: `feat/identity-authorship`).
8. Phone as a device, inbound webhooks, Inkbox as a channel.
9. Multi-tenant: option (a), one instance per tenant, documented; option (b), several tenants in one process, built (`MULTI-TENANT.md`).

Dreaming and memory flush belong to sanctum-mind and are out of scope here.

## Sources of initiative (decided 2026-10-19)

The clock and the hands are core and go in now: routines, timers, impulses,
watchers, the watchtower, failsafe, pulse. A companion with no plugins still
reaches out and still notices silence. That is the floor.

A plugin may register a **source of initiative**. The seam carries a **scored
impulse**, not a trigger: drives do not fire, they are pressure that accumulates
and decays across hours, and forcing them through a boolean makes the source lie
to fit the slot.

```ts
interface Impulse {
  source: string;        // plugin id, or 'routine' | 'timer' | 'watcher' | 'failsafe' | 'pulse' for core
  urgency: number;       // 0..1, one scale for every source
  what: string;          // the act proposed, in the companion's terms
  why: string;           // the reason, for the audit line and the wake prompt
  expires_at?: string;   // after which the impulse is dropped unspoken
}
```

The orchestrator's existing ladder arbitrates on that one scale: a routine saying
"9am check-in" and a drive saying "connection, frustration climbing, reach" compete
as peers. Core sources are rewritten onto the same shape so nothing special-cases
the plugin ones. Every acted or dropped impulse writes one audit line naming
source, urgency and why.

What a later want engine adds is a self the clock consults before it acts: drives,
desires, appraisal. It owns none of the heartbeat. Nothing waits for it.


## Open questions

- Second root: decided. `plugins.dir`, default none. In person mode it must be outside the companion's folders
  (the loader refuses one under `agent.cwd`); in companion mode (the default) it may be anywhere.
- Should a plugin be allowed to add a `res` verb, or is `res <id> ...` as a generic
  passthrough enough?
- Authorship record: decided. A ledger and journal in their own folder
  (`identity.ledger_dir`, default `data/identity`), not a git repository in the home
  and not a file beside `identity/`: the home is writable by the companion, so a
  record kept there could be rewritten by the thing it watches.
- Who signs memory writes when Revien is the store: does Sanctum's `revien.ts`
  ingest path hand off to the mind process, or does the mind own ingest outright?
- Approvals setting: one switch per install, or per thread?
- Watchdog alerts: web push, Telegram, or a system line in the daily thread?
- Tier-1 skills location, given it must sit outside the companion home.
