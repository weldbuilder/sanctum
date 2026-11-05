# Multi-tenant

*Roadmap item 9 (`PLUGINS.md`, "Order"). Option (a), one instance per tenant, needs
no code and is written down here. Option (b), several tenants in one process, is built
and is the reference below.*

A **tenant** is one person with one companion: their own identity folder, their own
database, their own login, their own channels. Sanctum Mobile is built single-user
(`RESONANT.md`), and nothing in the code shares state between two people on purpose.

## Option (a): one instance per tenant (works today)

The checkout **is** the instance. Everything an instance owns resolves from the folder
the code runs in, not from a flag:

| What | Where it comes from | Default |
|---|---|---|
| `sanctum.yaml` | fixed search under the checkout (`CONFIG_FILE_NAMES` in `config.ts`) | `<checkout>/sanctum.yaml` |
| `.env` | `<checkout>/.env`, then the shell's current folder (`server.ts`) | – |
| database, sessions, internal token, Google key | `server.db_path`, env `DB_PATH`; the token (unless `INTERNAL_TOKEN` is set) and the key sit beside the DB | `<checkout>/data/sanctum.db` |
| uploaded files | fixed | `<checkout>/data/files` |
| identity ledger and snapshots | `identity.ledger_dir` | `<checkout>/data/identity` |
| plugin ledger | `plugins.ledger_dir` | `<checkout>/data/plugins` |
| shipped plugins | fixed | `<checkout>/plugins` |
| the person's plugins | `plugins.dir` | none |
| companion home (identity files, CLAUDE.md, the write boundary) | `agent.cwd`, env `AGENT_CWD` | the checkout |
| Discord private lists (word gate, names, exclusions) | `discord.private_dir` | **`<agent.cwd>/../sanctum-private`** |
| Discord rules | the `discord.rules` setting in the DB, else a file | `<checkout>/packages/backend/data/discord-rules.json` |
| Discord public transcripts | beside the DB | `<db dir>/discord/public/` |
| logs | Settings → Logs reads `data/logs/pm2-{out,err}.log` (only if pm2 writes there, step 4); the orchestrator log is fixed | `<checkout>/data/logs`, `<checkout>/logs` |
| port and bind address | `server.port`/`PORT`, `server.host`/`HOST` | `3099`, `127.0.0.1` |
| login | `APP_PASSWORD` (process env, then the wizard's `.env`, then `auth.password`) | fails closed |
| Discord bot | one encrypted token in the config table, or `DISCORD_BOT_TOKEN` | – |

So one tenant is one clone, **and one OS user**. The companion can change anything its OS
user can (`CONFIGURATION.md` §4, `hooks`): Claude Code's Bash is ungated, and Codex in
`workspace-write` still reads everywhere. Two clones under one OS user are two folders one
companion can read, including the other tenant's `.env`, database and private lists, and
they share one `~/.claude` and one Codex login. The isolation below is the filesystem's
only when the filesystem separates them. The recipe:

1. **One OS user and one clone per tenant, under a parent only that user can enter.**
   Ownership alone is not enough: with the usual `022` umask the server creates `data/`,
   the database and the home files world-readable, so a `0755` tenant tree lets another
   tenant's companion read chat history, identity files and uploads. Make the parent
   `0700` before anything is cloned into it, and check it:

   ```bash
   sudo install -d -m 0700 -o ada -g ada /srv/sanctum/ada
   sudo install -d -m 0700 -o bea -g bea /srv/sanctum/bea
   stat -c '%a %U' /srv/sanctum/*      # 700 ada, 700 bea
   ```

   Each tenant's companion home sits outside the clone (`CONFIGURATION.md` §3), for
   example:

   ```text
   /srv/sanctum/ada/app            owned by user `ada`: git clone, `npm install`, `npm run build`
   /srv/sanctum/ada/home           agent.cwd (identity/, CLAUDE.md, config/companion-claude.md)
   /srv/sanctum/ada/private        discord.private_dir
   /srv/sanctum/bea/app
   /srv/sanctum/bea/home
   /srv/sanctum/bea/private
   ```

   Each clone here is single-tenant, so its `agent.system_prompt_file` keeps the single-tenant
   default, `./prompts/companion-claude.md`: a clone runs on the shipped frame, not on the
   preset. A frame at `home/config/companion-claude.md` wins over it. A home made from the
   starter ships one, and the user can edit it from Settings (which saves that file and
   never writes the app's `prompts/` folder). An older home has none: it keeps the shipped
   frame until the user copies `prompts/companion-claude.md` into its `config/`, or opens
   Settings, system prompt, and saves once (the editor opens with the shipped harness, and
   Save installs it as the home's copy).

2. **Run the setup wizard in each clone** (`npm run setup`, or the first-run page). It
   writes that clone's `sanctum.yaml` and `.env`, so each tenant gets their own password
   and their own keys. The wizard does not ask for a port; set it in step 3.

3. **Three keys must differ per tenant** in `sanctum.yaml`, and the code will not catch
   you if they do not:

   ```yaml
   server:
     port: 3101                      # 3102 for the next tenant, and so on
   agent:
     cwd: /srv/sanctum/ada/home
   discord:
     private_dir: /srv/sanctum/ada/private
   ```

   - `port`: two instances on one port is `EADDRINUSE` for the second one
     (the README's Troubleshooting, "Port already in use"). Set it in `sanctum.yaml`, not with
     `PORT` in the environment: the server honours `PORT`, but the `res` tool reads
     `SANCTUM_PORT` or the yaml's `port:` line and would otherwise call 3099, which may be
     another tenant. Leave `server.db_path` at its default: the server writes its token
     beside the database, but `res` always reads `<checkout>/data/.internal-token`, so a
     database anywhere else (even `data/ada/sanctum.db` inside the clone) leaves the
     companion's `res` calls without a matching token and every one of them fails.
     Never put one `INTERNAL_TOKEN` in a process manager's shared environment.
   - `agent.cwd`: two companions in one home share one identity, one ledger of
     authorship and one write boundary. That is one tenant, not two.
   - `discord.private_dir`: **the trap.** The default is a *sibling of the companion
     home*, so two homes with the same parent folder (`/srv/homes/ada` and `/srv/homes/bea`
     both default to `/srv/homes/sanctum-private`) share one word list, one name list and
     one exclusions file; `/srv/sanctum/ada/home` and `/srv/sanctum/bea/home` do not. Set it
     explicitly for every tenant that uses Discord. The path checker only knows *this*
     instance's writable folders, so nothing stops one tenant's private folder from
     sitting inside another tenant's home. Keep them apart yourself; separate OS users
     make the mistake fail loudly.

4. **One process per clone.** With pm2, name them:

   ```bash
   # as user ada
   cd /srv/sanctum/ada/app && pm2 start npm --name sanctum-ada --time \
     -o data/logs/pm2-out.log -e data/logs/pm2-err.log -- start
   # as user bea, in their own pm2
   cd /srv/sanctum/bea/app && pm2 start npm --name sanctum-bea --time \
     -o data/logs/pm2-out.log -e data/logs/pm2-err.log -- start
   ```

   The `-o`/`-e` paths are where Settings → Logs looks; without them pm2 logs under
   `~/.pm2` and that tab is empty. `APP_PASSWORD` in a process manager's environment
   beats the clone's `.env` (`CONFIGURATION.md` §5), so if you set it that way, set it per
   process.

5. **One hostname per tenant** in front, if they are reached from outside. The app trusts
   one proxy hop (`trust proxy`) and needs `x-forwarded-proto: https` from it
   (the README's Troubleshooting, "Login seems to succeed but immediately bounces back"). A path prefix per tenant
   (`/ada/`, `/bea/`) is **not** supported: the frontend and the service worker assume
   they are served from `/`. Use `ada.example.net` → `127.0.0.1:3101`,
   `bea.example.net` → `127.0.0.1:3102`, or one Tailscale `serve` per port.

6. **Channels are per tenant by construction.** One Discord bot token per instance
   (`DISCORD-PLAN.md` D15), one Telegram bot, one set of Google credentials. Two tenants
   who want Discord each create their own bot in the developer portal. One token in two
   instances would have both receive and answer every message.

7. **Back up per clone.** Each clone's `data/` is that tenant's state (`CONFIGURATION.md`
   §8), and the restore also needs the clone's gitignored `sanctum.yaml`, `.env` and
   `.mcp.json` (password, keys, paths, port, tools), their home folder and their private
   folder. With the `0700` parent from step 1, backing up `/srv/sanctum/ada` as that user
   takes all of it.

8. **Upgrade per clone** with `npm run update` in each (README, "Updating"). Nothing is
   shared, so the tenants can sit on different versions.

What this costs: one OS user, one Node process and one SQLite file per tenant, and `n`
wizard runs. What it buys: the isolation is the operating system's, not the code's. A bug
in one tenant's plugin, a leaked key in one tenant's `.env`, a companion that reads past
its home, all stop at that user's files. For a handful of tenants on
one box this is the right answer and the one the maintainer picked.

## Option (b): several tenants in one process (built)

Several people, each with their own companion, in one Node process: one database, one login, one folder, one
set of channels and one scheduler per tenant. It is built; what it is not is a security boundary against an
adversarial tenant (see "The walls, and what they are not"). Without a `tenants:` block none of it runs and the
server is the single-user server, byte for byte.

### Household mode (the default)

`tenants.auth` is `household` unless the operator says `per-tenant`. Household mode is one front door with several companions behind it: one login for
the house, and each companion served under a path prefix on the same address. The hostname-per-tenant shape below (`tenants.auth: per-tenant`, the
OpenClaw and Hermes shape: each tenant its own host, password and login) is unchanged and still built; this section is what is different when the house
is one person's (or one family's) and the companions share it.

```yaml
tenants:
  dir: /srv/sanctum/tenants
  auth: household        # the default; per-tenant keeps one hostname, one password and one login per tenant
```

**One door.** The page, the sign-in and the list of companions are at the house's address. A companion is at `/c/<id>/` (`<id>` is the tenant folder's
name, `[a-z0-9][a-z0-9-]{0,31}`): its calls are `/c/<id>/api/...`, its websocket is `/c/<id>/ws`, its page is `/c/<id>/`. The prefix is stripped before
the routers see the request (`req.url` loses it, `req.originalUrl` keeps it, and a path that spells itself with `//`, `..` or an encoded slash is a 400
before and after). Nothing else names the active companion: no cookie, header or local-storage value, so two tabs can hold two companions.

**What is the house's** (one of each, in the process): the password (the process's `APP_PASSWORD`, exactly as a single install: `.env` or the environment,
never a tenant's), the sessions (`<process data dir>/house.db`, the `web_sessions` table and nothing else; one cookie opens every companion, and signing
out deletes its row), the list of companions (`GET /api/companions`) and the house's first run (no password yet: the unprefixed `/api/setup/status|plan|apply`,
behind a setup code printed at boot, one step, the password, written to the process `.env`). A tenant `.env` `APP_PASSWORD` is ignored in household mode, with one
boot line per tenant. `hosts:` in a `tenant.yaml` and `tenants.default` are not read (one line each; no fail-open: the hallway chooses).

**What stays per companion, exactly as built** (everything under the resolver): the database, home, harness homes, internal token, the config and `tenant.yaml`,
channels (Discord and Telegram), the scheduler, Revien, push (keys and subscriptions), plugins, Google, and the own-files layer. A companion's own setup wizard
(`/c/<id>/api/setup/*`, and `npm run setup -- --tenant <id>`) has no password step and no hostname step in household mode, and a password sent to it is ignored with a note.

**Routes.** Unprefixed, only the house routes answer: `/api/auth/*`, `/api/companions`, `/api/health`, `/api/version`, `/api/push/vapid-public` (no key: push is per companion), `/api/setup/*` (the
house's first run), `/api/house/update`, `/api/house/update/start` and `/api/house/update/rollback` (the in-app updater: a house session, and for the two writes the house password typed again), the page and its static files (`/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`, `/assets/*`), and the Google callback
(`/api/google/auth/callback`, unchanged: its `state` carries the companion). Any other `/api/*` or `/mcp/*` without a prefix is `404 {"error":"companion_required"}`. An
internal token (`x-internal-token`) still resolves its own companion with no prefix (harness children call `/mcp/cc` and `/api/internal/*` that way); with a prefix too, both must name
the same companion or the answer is 404. The house routes also answer under a prefix, except `/api/house/*`, which is 404 under one and to the internal token (so no companion tool can start an update). **One update restarts every companion**: there is one process, so the restart takes every companion's turn, channel and scheduler with it; an update is refused while a turn is running in any of them. A companion that was skipped or reserved at boot (it did not start) answers 503 under its prefix and at `/c/<id>/ws`, and is listed `unavailable`; parking is per service (Revien, a channel) and does not make a companion unavailable. A websocket path with `//`, `..` or an encoded slash is 400, as for HTTP. The login budget is one per address across every prefix. A push notification's click opens `/c/<id>/chat`.

**Upgrading.** A `tenants:` block with no `auth` key is household. An install that looks per-tenant (a `tenants.default`, a `hosts:` in a `tenant.yaml`, or an `APP_PASSWORD` in a tenant `.env`) and has no key is refused at boot, and by `npm run setup -- --tenant`, with one error naming `tenants.auth` and its two values: say `per-tenant` to keep hostnames and a login per tenant, or `household` for one login. With none of those signs the missing key stays household.

**Dev.** The Vite dev server proxies `^/c/` to the backend (with ws), except a page navigation to `/c/<id>/`, which keeps Vite's SPA fallback; the app itself calls the backend directly in dev as before.

**Server-issued URLs** are made with the prefix in household mode (`companionPath()` in `tenancy/house.ts`, at the point of making, so stored history is never rewritten): the upload answer and message attachment fallback (`/c/<id>/api/files/<id>`), and avatar URLs (`/c/<id>/api/identity/avatar/...`). A prefixed avatar URL sent back in `PATCH /api/identity` is stored in its plain form. Static paths (`/logo.png`, `/avatars/01.svg`) are never prefixed.

**Hallway contract** (what the hallway, the house's main menu, is built on):

- One sign-in at `POST /api/auth/login` with the house password; the session cookie is the house's, not a companion's.
- `GET /api/companions` lists `{ id, name, avatar_url, status }` for the signed-in person; the hallway renders from it.
- Every companion-scoped call carries the prefix `/c/<id>` before `/api/...`, and the websocket upgrades at `/c/<id>/ws`. Unprefixed `/api/...` serves only the house-level routes; a companion route reached without a prefix is 404.
- The path prefix is the only scope. No cookie, header or local-storage value names the active companion, so two tabs can hold two companions.
- A companion that failed to start (skipped or reserved at boot) answers 503 under its prefix and is listed with `status: "unavailable"`; parking is per service and does not make a companion unavailable.

As built: `GET /api/companions` (house session required, else 401) answers a JSON array in folder-name order, one object per tenant folder found at boot:
`{ "id": "ada", "name": "<identity.companion_name>", "avatar_url": "/c/ada/api/identity/avatar" | null, "status": "ready" | "unavailable" }`. A companion with no `identity.companion_name` of its own is listed by its id. `avatar_url` is set when
the companion has an avatar file (read through the same guard as the avatar route); an unavailable companion carries its id, `name` equal to the id, `avatar_url: null`, and never a reason or a path.
`GET /api/auth/check` answers `mode: "household"` in household mode (and no `mode` key in any other mode, so single-tenant and per-tenant answers are byte-identical to before).

**Frontend (the minimum this stage touched).** `packages/frontend/src/lib/base.ts` reads the prefix from the address of the tab (`COMPANION_PREFIX`) and
`BASE` carries it (with the dev backend address in dev); the old per-file `BASE` constants and the literal `/api` fetches use it, the websocket URL gets
`/c/<id>/ws`, and `BrowserRouter` gets `basename`. The auth store posts to the unprefixed `/api/auth/*` and reads `mode`. `components/HouseChooser.tsx` was a plain
placeholder list of links to `/c/<id>/` (unavailable ones greyed); the hallway has replaced it (below). Files touched: `App.tsx`; `components/` `BrowserView`, `Canvas`, `ChatView`,
`CommandCenterView` (its `BASE` line only), `Composer`, `ConnectionTabs`, `FilesView`, `HearthAudioPlayer`, `HomeView`, `HouseChooser` (new), `MessageBubble`, `OutlookView`,
`SearchPanel`, `SettingsView`, `SetupWizard`; `lib/base.ts` (new); `store/` `auth`, `chat`, `mind`, `observatory`, `theme`. Also `store/identity.ts` (its `BASE` now comes from `lib/base.ts`) and `components/settings/AppearanceSection.tsx` (its avatar check accepts the prefixed URL the server now issues). The service worker needed nothing: scope `/` covers `/c/*`, it never intercepts anything but `/assets`, `/icons`, `/skins` and navigations, and its
navigation fallback is the cached shell.

**The hallway** (`components/Hallway.tsx`, its logic in `components/hallway/hallwayState.ts`) is what the house shows at its address once someone is signed in: the
painted hall, each door a companion's. Downstairs (`public/house/hallway-downstairs-v1.webp`) holds companions 1-3 in folder-name order, the gallery upstairs
(`hallway-gallery-v1.webp`, painted square-on) holds 4-6, and any past the sixth are listed "further along the gallery". **Upstairs ↑** / **Downstairs ↓** appears once
downstairs is full, and plays the climb: up the staircase, across the landing (`hallway-landing-v1.webp`, the gallery seen at an angle from the top of the stairs) and
along to the gallery's doors, or the same way down (a cut on a phone, or with reduced motion). A plaque in front of each door carries the companion's avatar (or initial), name, the room it chose (its `GET /c/<id>/api/identity` `skin`), and **Open room**,
a link to `/c/<id>/` (a new-tab click keeps the browser's way, so two tabs can hold two companions). Hovering or focusing a plaque lights its door; choosing it zooms
through the door into the room. An unavailable companion's plaque is dimmed, has no link, and points at the window Sanctum runs in (the list never carries a reason).
The next free door holds **+ Add companion**, which gives the one command that moves a companion in (`npm run setup -- --tenant <id> --create`, then a restart).
With exactly one companion, and that one ready, there is nothing to choose: the house opens straight into `/c/<id>/`. The hallway is always in the house's own
walnut-and-brass palette, never a companion's skin. On a phone, or any tall window, the painting fills the screen and you face one door at a time, lit, its
plaque on the floor in front: swipe, the arrows, the dots or the arrow keys walk along the hall, and past either end the walk carries on up or down the stairs.

### The tenants block

```yaml
# sanctum.yaml (the operator's)
tenants:
  dir: /srv/sanctum/tenants     # one folder per tenant id; relative paths resolve from the checkout
  auth: household               # optional, default household: one login, a path prefix per companion (see "Household mode"); per-tenant: a hostname and a login per tenant
  default: ada                  # optional, per-tenant only (not read in household mode): the tenant a hostname nobody claims is served by (else such a host is a 404)
  inherit: true                 # optional, default true: tenants start from this file (see "What a tenant inherits")
  background_runs: true         # optional, default true: false stops every tenant's orchestrator wakes, outlook author,
                                #   handoff and summarizer from starting model runs; a ceiling: a tenant's own background_runs can only turn it off for itself; true or false only (anything else is refused); a tenant's reload applies the tenant's own flip at once (off stops its timers, on starts them); a change to this operator value needs a restart; null or missing means not set
  operator_routes_remote: false  # optional, default false: true lets a peer that is not loopback use the park and revive routes (with the operator token)
```

Tenants are discovered when the app starts. Adding one is: make the folder, run the wizard, restart (below).
A tenant whose own files are wrong is skipped at boot with one line naming why; the others start, and the skipped
tenant's hostnames answer 503, never someone else's. Operator mistakes stop the boot: a `tenants.dir` that does not
exist or holds no tenant, a `default` that names no folder, `INTERNAL_TOKEN` in the process environment (it would be
every tenant's token), a malformed `tenants:` block, a `tenants.dir` that is the app folder itself or holds it (an app copy named like an id would become a tenant holding the operator's `.env` and database; the shipped `<app>/tenants`, held by the app folder, is fine). A tenant folder that equals or holds the app folder is skipped.

### The tenant folder

```text
<tenants.dir>/<id>/
  tenant.yaml        hosts: and the part of sanctum.yaml this tenant sets itself (usually small)
  .env               this tenant's keys: APP_PASSWORD, provider keys, DISCORD_BOT_TOKEN, VAPID keys. Never put in process.env
  home/              agent.cwd (identity/, CLAUDE.md, the write boundary)
  private/           discord.private_dir
  plugins/           optional: plugins.dir
  data/
    sanctum.db       this tenant's database: chat, sessions, settings, vector cache
    .internal-token  this tenant's internal token (0600)
    identity/        the identity ledger
    plugins/         the plugin ledger
    files/           uploads
    logs/tenant.log  this tenant's log (the process log keeps only process-level lines)
    harness/         claude/, codex/, dsh/ (logins), home/ (HOME), tmp/ (TMPDIR)
```

A tenant id is `[a-z0-9][a-z0-9-]{0,31}`; it appears in paths and hostnames and nowhere a person reads.
`data/`, `data/harness/` and its folders are created `0700` (not on Windows). Every path a tenant's config names
must resolve, symlinks followed, inside its own folder; one outside is refused when the tenant loads, when its
`tenant.yaml` is edited through the app, and when the wizard would write it.

A tenant's own files are its own, and the rule lives where the write happens, not in a list of paths. Three layers, each as built:

1. **The write site (the wall).** Every write, append, mkdir, copy, rename and delete that can land inside a tenant folder goes through one file layer
   (`tenancy/own-files.ts`, over `scripts/own-files-lib.mjs`, which `npm run setup` shares): ledgers and journals, snapshots, uploads, Discord
   transcripts, digests, rolling-context records, the Google key, logs, the wake-prompt migration, `home/.sanctum-thread` on every chat turn, the plugin ledger,
   the wizard's `config.toml`, `.mcp.json`, their backups and the identity baseline. Inside a tenant folder each call refuses a target that is a link (a symlink,
   or a junction on Windows), a regular file with more than one hard link (posix), or whose folder, or any folder between it and the tenant folder, is a link;
   the sentence names the path relative to the tenant folder, never an absolute one. A write goes to a temp file in the same folder (random name, opened
   exclusively, so a link planted at the name is never written through), gets its mode, then is renamed over the target; an append opens with `O_NOFOLLOW` (on
   Windows: checked first) and reads the link count of the open file; a delete never follows a link (a link at `data/plugins/snapshots` is refused, not emptied).
   "Inside the tenant folder" is decided from the REAL path of the target's deepest existing folder, never from how the path is spelled: `/proc/self/root<real>/home`
   or a path through a second link is the tenant folder, and the layer applies. **Every helper normalises the target with `path.resolve` first**, so a `.` or `..`
   segment never reaches the decision (`<tenant>/data/link/./x` is `<tenant>/data/link/x`, and a link is refused); a path whose `..` a link would carry elsewhere (the
   text and the operating system disagree) is refused as undecidable. **On Windows, case is not an alias:** `path.relative` is case-insensitive there, so a case-only
   spelling of an existing path is the same path and is accepted; on macOS (a case-insensitive filesystem, a case-sensitive path comparison) a case-only spelling of the folder is an alias and is refused in configuration; on Linux there is no such path.
   A pipe, socket or device is never opened (refused by type before the open, and checked again on the open handle). `flag: 'a'` on a write appends (it never replaces);
   a create-only flag (`wx`, `wx+`, `ax`, `ax+`) opens the target directly with `O_EXCL | O_NOFOLLOW`, so `EEXIST` still means something is there.
   **Writes fail closed too.** In tenant mode (a current tenant is set) a write helper that cannot prove the target is inside the tenant folder REFUSES: it never falls
   through to the plain `fs` call. "Cannot decide" (a loop, no permission, an ambiguous `..`) is a refusal; a target provably outside the folder is refused as well
   unless the caller passes the explicit `{ process: true }` for a genuinely process-level write that happens to run inside a tenant context (the app uses it nowhere
   today). With tenancy ON and no tenant entered at all, a write helper throws `NoTenantContext` (as the reads do) unless `{ process: true }` is passed; the process's own
   boot-time writes (its app data folder, its internal token, its logs) do not go through this layer, so nothing in the app needs the flag. With tenancy off each helper
   is the plain `fs` call it replaces: same arguments, same errors.
2. **The scan (boot and `rt.reload()`).** `tenant.yaml`, `.env`, `.mcp.json`, everything under `data/` (except `data/harness`, `data/tmp`, `data/files` and `data/logs`: the harnesses own their homes, and the write layer guards every server write into those four, while every read of an upload or a log refuses a link, a hard link or anything behind one) and `private/`, the top level of `home/` (depth 1; what is
   deeper in `home/` is the companion's own space) and the wake prompts folder when it lives elsewhere in the tenant folder must hold no link, no pipe, socket or
   device, and no file with a second hard link. A tenant that fails is skipped at boot with one line naming
   the path relative to its folder, `rt.reload()` refuses it, and the wizard and the first-run page refuse to write. The walk has no cap and never refuses on
   count (plugin snapshots, identity snapshots, daily transcripts and digests are all healthy and large; 20,000 entries take well under a second): above 20,000
   entries it logs one line with the count. One implementation serves boot and the
   wizard, so the two cannot drift. **One scan per request:** `/apply` scans the tenant folder once, and its pre-write check, the dry run of the candidate `tenant.yaml`
   and the `rt.reload()` that follows share that walk; the wizard (`npm run setup -- --tenant`) makes one full scan too (its early look at the top of the folder is the
   quick form). **Hard-link backups are refused by design:** `cp -al` (or `rsync --link-dest`) of a live tenant folder makes every file a second
   name for the same bytes, and a write through either name would change both. A backup must copy, not link.
3. **The request net (second, not the wall).** In tenant mode `server.ts` mounts a cheap check at app level, after tenant resolution and before any router, on every
   `POST`, `PUT`, `PATCH` and `DELETE` under `/api` and `/mcp` (plugins, identity, setup, google, auth preferences, the MCP endpoints and the internal routes, not
   only the api router). It looks at `tenant.yaml`, `.env`, `.mcp.json`, `home/`, `private/`, `data/` and the first level of `data/` and `private/`, answers `400` with the
   boot sentence, and speaks only to a caller who holds the tenant's own login or token (an anonymous caller is left to the router's own answer and learns nothing about the folder).

4. **Reads fail closed.** Every read of a path in tenant mode goes through the same layer (`readOwn`, `readOwnText`, `ownReadDir`, `ownStat`, `sendOwnFile`): a path
   outside the tenant's folder is refused (the app's `.env`, its database, another tenant's folder), unless the caller passes `{ shipped: true }`, and then only the
   shipped plugin root and the built frontend are allowed. Inside the folder a link, a hard-linked file, a path behind a link and a pipe are refused, and the file is
   opened without following a link and checked on the open handle. **Every read of a tenant file is one guarded open with an inode check.** The read opens through
   `ownOpenRead` (`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, then `fstat` must say a regular file with one hard link), and the open handle's inode and device are compared with
   the path's own (`lstat`) taken at the check: a pipe swapped in after the check opens at once and is refused (it never blocks the event loop for a writer), and so is
   a link or another file swapped in after it. That includes the files the process reads at boot and reload: `tenant.yaml`, `.env`, the token file, the identity journal
   and the plugin config. What remains is the **parent-swap window**: a folder on the way swapped for a link between the path check and the open is not seen by the open
   itself (the next check or scan sees it). **On Windows there is no `O_NOFOLLOW`**, so the inode comparison is the only guard against a link swapped in late: it closes
   the window to that comparison and no further (a swap that restores the same inode is not seen). Tailing and streaming read from the open handle (the log tail, the Discord
   transcript tail, the session titles), and so does `sendOwnFile`: it streams from the handle (`Content-Type`, `Content-Length`, a weak `ETag` of size and mtime,
   `Last-Modified`, `HEAD`, `If-None-Match` and `If-Modified-Since` as 304 (before any `Range`, as express answers), `Range` as 206 or 416, a file gone before the open as 404)
   and never hands the path to express, so a link swapped in after the check is never served. The rolling-context sidecars, the Google key file, a tenant's
   `plugins.dir` manifests and `help.md`, and the identity files are read the same way. The server also **reads** some files deeper in `home/`, which the scan does not cover: the
   companion's avatar, its `SKILL.md` and command files, the system-prompt frame (in tenant mode `agent.system_prompt_file` defaults to the tenant's own home, so the file is `<home>/config/companion-claude.md`, following that tenant's `agent.cwd`: shipped with new homes, editable from Settings, and an older tenant home can copy it from the app's `prompts/` folder or save it once from Settings, whose editor opens with the shipped harness; with none there the tenant runs on the preset), and the files the companion writes into `shared/`. Those reads go through the read
   guard, so a link planted there is refused (the avatar and the skill answer 404 or are left out), never served. A refused read is a `400` (or `404`/`403` where the
   route already says so), never a `500`.

What this does not close: **the window between a check and the write.** A process that can already write inside the tenant folder (the companion in `home/`, a plugin)
can swap a folder for a link in the microseconds after the check; the temp-and-rename and `O_NOFOLLOW` keep a write off a link that is already there, a swap inside that
window is caught by the next write's check, the next request, or the next scan, not before. The OS-user or sandbox boundary (below) is what closes it for an adversarial tenant.

The wizard and the first-run page write `.env` and `tenant.yaml` through the same layer (a temp file inside the tenant folder, owner-only for `.env`, renamed into place).

### Resolution

One request, one tenant, decided once at the edge and carried through everything it starts (an `AsyncLocalStorage`
store, entered again after the body parsers, which call `next()` from stream events):

1. **By hostname.** `hosts:` in `tenant.yaml`. The host is the last `X-Forwarded-Host` entry (the one trusted hop
   appended it), else `Host`, lower-cased, port stripped; never Express's `req.hostname`, which takes the first
   entry, which the client controls. A host two tenants claim belongs to neither and answers 503. A host nobody
   claims gets `tenants.default`, or 404. (This is `tenants.auth: per-tenant`. In household mode, the default, the
   companion is the `/c/<id>/` path prefix instead and no host is read: see "Household mode".)
2. **By token.** A request with `x-internal-token` resolves by the token (unique per tenant, checked at boot).
   If its `Host` also names a tenant the two must agree, else 404.
3. **By OAuth state.** The Google callback returns to localhost with no tenant hostname, so the consent URL's
   `state` is `<tenant id>:<nonce>:<marker>`; the nonce lives ten minutes in that tenant's database, and the
   callback enters that tenant only if its own database knows the nonce. An unknown tenant or nonce is 404.
4. **WebSocket** upgrades resolve the tenant from the same host and cookie and never rebind (household mode: from `/c/<id>/ws` and the house cookie).

With tenancy on, code that asks for tenant state outside any tenant **throws**; it never falls back to the
process's. Unrouted traffic never maps to a tenant unless `default` is set explicitly.

### What is per tenant

| Since | Per tenant |
|---|---|
| stage 1 | the config (defaults, then the inherited base, then `tenant.yaml`, then the tenant's `.env`); the SQLite file and its handle; sessions (a cookie presented to another tenant is not a session there); the login password; the internal token; uploads; the identity and plugin ledgers; the config editor (`PUT /api/config/raw` and friends, which refuse `hosts`, the timezone, process-only keys and paths outside the folder) |
| stage 2 | the agent: its own queue, presence, active query, MCP status and turn probe, so one tenant's turn never waits behind another's; the provider child environment (see "Harness runs"); prompt caches; the vector cache |
| stage 3a | the websocket registry and the turn over it; voice (keys from the tenant's `.env`); the system line; sessions routes; Google state and tokens |
| stage 3b | the scheduler (orchestrator wakes, timers, failsafe), the Mind watchdog, outlook, handoff, the push service (VAPID keys from the tenant's `.env`, subscriptions from its database), plugins (one mount per tenant; its own plugin root) |
| stage 3c | Discord and Telegram: one service per tenant that has a token, every handler bound to its tenant; the Discord rules file and activity; the per-tenant HOME and TMPDIR; the `background_runs` switch |
| stage 4 | the setup wizard (`--tenant`, and the first-run page), the setup code, the Settings line |
| memory | Revien, **only when each tenant runs its own daemon**: the daemon has no tenant scope, so for a tenant `revien.enabled` is off unless its own `tenant.yaml` turns it on, `revien.url` is never inherited, and two tenants on one address are both parked at boot (one line each, naming the other tenant) |

### What is shared

The process (one listener, one Node event loop, one timezone), the shipped plugins and the code, and the operator's
`sanctum.yaml`, which is the inherited base. Nothing else: no table, cache, queue, token or key is shared.
Plugin code is one module instance per plugin for every tenant (below).

The process's Revien daemon is **never shared by default**. Revien is one daemon and its requests carry no tenant id, so
two tenants on one daemon would recall each other's memories. In tenant mode a tenant has Revien only when its own
`tenant.yaml` sets `revien.enabled: true` and its own `revien.url`, and that address is a daemon only that tenant uses.
A tenant that turns Revien on must name its own `revien.url`, and never the process's (the operator's configured `url`, or the
shipped default `http://127.0.0.1:7437`): such a tenant has Revien parked with one line (it still boots), and the wizard asks the
address again with a sentence. Two addresses are the same when they reach one daemon: the host is lower-cased without a
trailing dot, userinfo, path and query are dropped, the scheme's default port is filled in, and every loopback spelling
(`localhost`, `127.0.0.1` or any `127.x.x.x` in dotted or short form such as `127.1`, `[::1]`, `[::ffff:127.0.0.1]`,
`0.0.0.0`) is one place. What it cannot see: the operator's daemon on a LAN address or a hostname (`192.168.1.20`, `memory.internal`)
is not recognised as the process's own, because there is no way to tell, from the text, that two names reach one machine; a tenant that names one gets a daemon
shared with the operator, so name a daemon that only that tenant uses.
Two tenants that are both enabled on the same address are both parked at boot (Revien off for each, the tenants still
boot), with one line each naming the other tenant id, never the address. The clash is decided from what each tenant's files
say (its configured settings), not from the effective config that parking itself changes, so a reload never revives a tenant
that still clashes: a reload recomputes the reloaded tenant's parking from every tenant's configured settings, and a park
lifts when the clash is gone, on that tenant's own next reload (or restart), with one line. The park on reload is **one-sided**: when `bea` moves onto the address
of a running `ada`, only `bea` parks (at its reload); `ada` keeps the daemon until its own reload or a restart, when both park (at boot both always park). A reload writes only the
reloaded tenant's own config, never another tenant's. The wizard does not make Revien the default memory choice for a
tenant and asks for the tenant's own address.

### What a tenant inherits

Tenants start from the operator's `sanctum.yaml`, with each tenant's `tenant.yaml` on top. The base is the shipped
defaults plus the values the operator's **file** holds (never the environment, never the operator's `.env`) minus the
never rows below. A mapping merges key by key; a list a tenant names replaces the operator's. `tenants.inherit: false`
turns it off. A key the table does not name is inherited, except that a key whose name looks like a secret is stripped from
the inherited base in every section and at every depth (the last row: for example `my_plugin.api_key` never reaches a tenant,
while `my_plugin.endpoint` does). The rule reads the key name's **last word** (split on `_`, `-` or a camelCase boundary): `key`,
`keys`, `secret`, `secrets`, `token`, `tokens`, `password`, `passwords`, `passwd`, `passphrase`, `credential`, `credentials` or
`pem`, or a name that contains `api_key`, `apikey`, `private_key` or `privatekey`. `monkey_count` and `keyboard` are not caught.
A secret under any other name (for example `auth_header`, `webhook_url`, `bearer`, `session_cookie`) **is** inherited: keep such
values out of the operator file, or name them so the rule catches them.

A tenant can take inherited values away. In `tenant.yaml`, a key set to `null` (`~`) removes the inherited key, at any depth, and means "this key is not set by
the tenant and not inherited; the default applies", whether or not the operator's file has it (`orchestrator: ~` gives the tenant
the pristine orchestrator defaults, `schedules: { operator_morning: ~ }` drops that one schedule, `agent: { cwd: ~ }` is the
tenant's own `home/`, `identity: { timezone: ~ }` is the process timezone). A mapping set to an empty mapping `{}` replaces
the inherited mapping with an empty one (`schedules: {}` leaves the tenant with no schedules). A reserved key `inherit: false`
inside any mapping means the same as `{}` plus the keys listed beside it: the inherited mapping is replaced by this one
(`agent: { inherit: false, provider: codex }` inherits nothing under `agent`); the loader honours it at any depth and the key
is never in the resulting config. At the top of the file it turns the whole inherited base off for that tenant. Everything else
deep-merges as above. The wizard keeps these markers when it rewrites a `tenant.yaml`, and when it must write values into a
mapping that was `~` or `{}` it writes `inherit: false` beside them, so the meaning survives. The table is one module (`scripts/setup-inherit.mjs`, re-exported
by `tenancy/config.ts`); the code, the wizard and this list all read it, and a test fails if this list drifts.

<!-- inherit-table:start -->
**Inherited** from the operator's `sanctum.yaml` (its file values only):

| Keys | What |
|---|---|
| `agent.provider`, `agent.model`, `agent.model_autonomous` | model and provider |
| `agent.auto_compact`, `agent.harness_memory`, `agent.app_write`, `agent.dsh.*`, `agent.codex.*`, `agent.rolling.*`, `agent.summarizer.*` | agent settings that are not paths (sandbox mode, rolling context, per-harness models, the summarizer; `api_key_env` is only the NAME of a variable and inherits with the rest, but the key itself is read from the tenant's own `.env`) |
| `tools` | tool settings |
| `orchestrator.enabled`, `orchestrator.schedules`, `orchestrator.failsafe` | orchestrator cadence and schedules |
| `voice.*` | voice flags |
| `imagegen.*` | image generation settings (the keys are the tenant's own .env) |
| `skins`, `appearance` | skins and appearance |
| `plugins.enabled`, `plugins.trust` | which plugins are on and who manages them |
| `command_center.*`, `handoff.*`, `outlook.*` | Command Center, handoff and outlook settings |
| `discord.*`, `telegram.*` | channel switches and limits (the bots and their tokens are the tenant's own) |
| `(any other key)` | a key this table does not name is inherited, unless its name looks like a secret (the last row below) |

**Never inherited** (a tenant gets the default, or what its own `tenant.yaml` says):

| Keys | Why |
|---|---|
| `agent.cwd`, `agent.claude_md_path`, `agent.mcp_json_path`, `agent.system_prompt_file`, `agent.dsh.home`, `agent.dsh.command`, `agent.dsh.base_instructions_file`, `agent.codex.base_instructions_file`, `agent.codex.additional_directories`, `agent.rolling.summarizer_instructions_file` | a path: every tenant has its own folder |
| `hooks` | the write-gate roots are paths |
| `plugins.dir`, `plugins.ledger_dir`, `plugins_dir` | a path: the plugin root and ledger |
| `discord.private_dir`, `discord.public.exclusions_file`, `discord.gate.words_file`, `discord.gate.names_file` | a path: the private lists |
| `orchestrator.wake_prompts_path`, `orchestrator.wake_prompts_dir` | a path: the wake prompts folder |
| `identity` | who the tenant and the companion are, and where their identity ledger lives |
| `hosts` | the hostnames a tenant answers to |
| `auth`, `google.client_id`, `google.client_secret` | a secret: the login and the Google client belong to one tenant |
| `discord.owner_user_id`, `discord.owner`, `discord.public.guild_ids`, `discord.public.role_ids`, `telegram.owner_chat_id` | names one person or server: inheriting it would hand the operator (or another tenant) this tenant's companion |
| `integrations`, `revien` | names a person or server: the operator's life status address, browser seat and Mind, and the one Revien daemon, are not a tenant's; a tenant names its own, and Revien is off for a tenant until its own tenant.yaml turns it on |
| `server`, `cors`, `tenants`, `updates` | process-only: the listen address, CORS, the tenants block (tenants.inherit: false turns inheritance off) and update checks |
| `(a key named like a secret, in any section)` | a key whose name (any case) has as its last word (split on _, - or a camelCase boundary) key, keys, secret, secrets, token, tokens, password, passwords, passwd, passphrase, credential, credentials or pem, or contains api_key, apikey, private_key or privatekey, is stripped from the inherited base at every depth, whatever its section. A secret under any other name (auth_header, webhook_url, bearer, session_cookie) IS inherited: keep such values out of the operator file or name them so the rule catches them |
<!-- inherit-table:end -->

What the environment holds never reaches a tenant: `AGENT_MODEL` or `APP_PASSWORD` exported for the process do not become
a tenant's model or login, and a tenant's own `.env` is the only environment it has.

### Adding a tenant: the wizard

```bash
npm run setup -- --tenant ada --create     # --create makes <tenants.dir>/ada; without it the folder must exist
npm start                                  # tenants are read at start: restart to serve the new one
```

`--tenant <id>` walks the same questions as `npm run setup`, against the tenant's folder: `tenant.yaml` and `.env` (0600)
there, the database at `data/sanctum.db`, the home at `<tenant>/home`, the private folder at `<tenant>/private`, Codex's
`config.toml` in the tenant's own Codex home. There is no port or phone question (where the process listens is the
operator's), and it asks the hostname the tenant is served at. It writes only what differs from the inherited base and the
defaults, so a `tenant.yaml` stays a few lines. It refuses what the app would refuse at boot, with a sentence, and writes
nothing if the finished file or its `.env` would be skipped: a path outside the folder (in `tenant.yaml`, or `AGENT_CWD` and the
other path keys in the tenant's `.env`), a timezone other than the process's (in the yaml or as `TZ` in the `.env`; the process
timezone is read in the order the app uses: the environment's `TZ`, the process `.env`, `sanctum.yaml`, then UTC), a host that is
not a bare hostname (also one carried over from an existing `tenant.yaml`), a host another tenant folder already claims (it names
that tenant), and process-only keys such as `server:` (boot ignores those with a warning; the wizard refuses before writing). The
id is checked against the id rule; with no `tenants:` block it says so and stops. The tenant folder must be a real folder inside
`tenants.dir`, never a link, and never the app folder or one that holds it; `tenants.dir` itself is refused when it is the app
folder or holds it (boot refuses it too). Where the tenant's own files and folders (`.env`, `tenant.yaml`, `data/`, ...) are links or hard-linked,
it refuses with the sentence boot uses. A tenant's `.env` is made owner-only (0600) even when it already existed. The login line names all three harness homes (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `DSH_HOME`).
A tenant has browser tools only from a seat its own `tenant.yaml` names (`integrations.browser_url` is never inherited);
the wizard never offers the process's seat.

The first-run page does the same job inside the app: a tenant with no password opens its own setup page on its own
hostname, which asks for **that tenant's setup code**. Each code is printed once at start, to the process's stdout with the
tenant id (the operator reads it) and to that tenant's own log, never the password or the token. A tenant's code opens that
tenant's page and no other. `/apply` writes that tenant's `tenant.yaml` and `.env` and reloads that tenant (`rt.reload()`:
the same load, confinement and layout checks as boot; on failure the tenant keeps the config it had); nothing is written
into `process.env` and no other tenant's folder is touched. Settings shows one line, "Served at `<host>`; data in `<dir>`",
from `GET /api/tenant`.

### Harness runs

Each turn spawns a harness (Codex, Claude, dsh) with `cwd` at the tenant's home. The child's environment is an allowlist plus the
tenant's own `.env`; the process's provider keys and the operator's `HOME` and temp folders are not copied in, and
`APP_PASSWORD` and `MIND_API_KEY` never enter a child. `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `DSH_HOME` point into
`<tenant>/data/harness/`, `HOME` (and `USERPROFILE` on Windows) at `data/harness/home`, `TMPDIR`, `TMP` and `TEMP` at
`data/harness/tmp`: git, ssh, gh, npm and every tool that reads `~/` see the tenant's files and not the operator's or
another tenant's. MCP servers and pooled clients are keyed by tenant id plus a hash of their config and never shared by name.

**Log in per tenant; never copy credential files between tenants.** Subscription logins (and the single-use refresh tokens
behind them) work per tenant: run the login with that tenant's `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `DSH_HOME` set (the wizard prints
them), or put an API key in the tenant's `.env`. Google works the same way: each tenant connects its own account, with its
own state in its own database.

Background model runs (orchestrator wakes, the outlook author, handoff, the summarizer) can be switched off for all tenants
or one with `background_runs: false` (above). A bot token present in two tenants' `.env` or settings parks Discord (or
Telegram) for **both**, with one line each naming the other tenant and never the token. Provider API keys are left alone;
they may be shared on purpose.

### The walls, and what they are not

What the code enforces: one database file per tenant (no `tenant_id` column anywhere, so a missing `WHERE` is not
expressible); one token per tenant, one session table per tenant; a throw, not a fallback, when no tenant is current;
every path confined to the tenant's folder; the writable roots of every tenant checked against every other tenant's
`data/`, `private/`, `.env` and `tenant.yaml` and the process's own files at boot (a tenant that fails is skipped);
duplicate hosts, tokens and bot tokens refused; the child environment above.

What it is **not**:

- **Plugins are operator-trusted code in the one process.** A plugin is told the tenant (`req.tenant` is `{ id }`) and
  nothing else, but it runs with the process's access and can read any file the process can, another tenant's folder
  included. It must scope its own module state by `req.tenant.id`. Install only plugins you would trust with every
  tenant's data (`PLUGINS.md`, `tenant_aware`).
- **It is not an OS-user or container boundary.** Claude Code's Bash is ungated and Codex's sandbox is its own, so a
  companion that wants to read another tenant's files can, if the process's OS user can. For adversarial tenants run
  option (a) (one OS user per tenant), or fill the seam: every harness spawn goes through `spawnWrapper` in
  `tenancy/child.ts`, the one place a per-tenant OS user or sandbox plugs in. It does nothing today.
- **dsh's `/tmp`.** dsh's sandbox can still write the system `/tmp` until it has an exclude for it; for Codex the clash checks
  use the tenant's own temp folder, but a dsh tenant keeps `/tmp` in them.
- **The Google callback returns on localhost.** A remote tenant connecting Google completes the consent on the machine the
  app runs on (or through a tunnel to it); the tenant is carried in the OAuth state, not the hostname.
- **One clock.** A tenant whose `identity.timezone` differs from the process's is refused at boot; the local-time sites
  are an audit for later.
- **One process.** A crash, a runaway loop or an out-of-memory in one tenant's work takes every tenant down.
- **Parking is not isolation.** A parked companion is switched off, not walled off (see "Parking a companion"): a harness child mid-turn is asked to stop, not killed, and the files and token stay where they were. The operator token that parks a companion is a file the server's OS user can read, and every companion's harness child runs as that user: under the one-OS-user setup a companion (or anyone who can prompt-inject one over a channel) can read it and park a neighbour. This is the same limit the walls section above states for reads, and the same fix: one OS user per tenant, or a sandbox in `spawnWrapper`.

### Parking a companion

One companion can be switched off and on again without restarting the process, with the operator's token (not a companion's):

```sh
curl -X POST -H "x-internal-token: $(cat <process data dir>/.operator-token)" http://127.0.0.1:<port>/api/internal/tenants/<id>/park
curl -X POST -H "x-internal-token: $(cat <process data dir>/.operator-token)" http://127.0.0.1:<port>/api/internal/tenants/<id>/revive
```

(`GET /api/internal/tenants` lists every folder as `running`, `parked` or `failed`, with the last error.) The token is the file `.operator-token` in the process's
data folder (the folder that holds the process's database), made owner-only at boot. It must be a regular file with no group or world permission bits: a symlink,
a directory or a file with mode wider than 600 is refused, one line is logged, and the routes are off until it is fixed (the file is never overwritten). The file
is read on every request, so deleting it revokes the token at once (and the routes stay off until the next restart creates a new one); replacing its contents
revokes the old token. The routes are inside the normal middleware chain (security headers, rate limiter, body parsers) and answer 404, like the other internal
routes, for a missing or wrong token (a companion's own internal token included), for a peer whose TCP address is not loopback, for a request a tunnel or proxy
forwarded (`X-Forwarded-For` and similar headers are never trusted, and their presence is refused), and for a companion's own prefix or host. Set
`tenants.operator_routes_remote: true` in the process config to let a non-loopback peer use them (with the token). The routes exist only in tenant mode: with no
`tenants:` block they are as unknown as any path.

**Park** stops that companion's scheduler, watchdog, pollers and channels (the same stop as a shutdown, for it alone), asks a turn in flight to stop, closes its
websocket clients (code 1013) and its database, and keeps its hosts reserved: its prefix (household) or hosts answer 503, its socket path answers 503, and the
house list says `unavailable`. It does not touch another companion: their routes, sockets, scheduler and Revien are as they were. **Revive** builds the companion
again from its files as they are now, by the code path boot uses (the same admission, the same layout check a reload makes, the same service start under the same
catch), so a companion whose files were fixed while it was parked comes back; one that fails to start stays down, the answer is a 500 with the line, and the line is
kept (`GET` shows it). A companion that did not start at boot (listed `failed`) is revived with the same call. A park of one that is not running, or a revive of one
that is, is 409; a name with no folder is 404. The folder list is the one read at boot: a new folder still needs a restart.

What a park is not: it is one process still, so it is not a security measure against the companion (it keeps its files and its token). The loopback rule keeps the
routes off public hostnames, not off the host: the token is a file the server's OS user can read, and every companion's harness child runs as that user, so under
the one-OS-user setup a companion (or anyone who can prompt-inject one over a channel) can read it and park a neighbour. It is the same limit the walls section states
for reads, and one OS user per tenant, or a sandbox in `spawnWrapper`, is the real fix. A turn in flight is asked to stop and the park waits for it (up to 30 s)
before it closes the database; a harness child that ignores the stop is not killed: the park returns with `turn_still_running: true`, and a revive is refused with
409 until that turn and its child have ended. A request already inside the companion when the database closes answers 503, not 500. A plugin's own module state is not reset (one module is shared by every companion). The
words are not interchangeable with the per-service parks above (a duplicate bot token or Revien address parks one service and leaves the companion up). A companion
that held a bot token another companion also holds stays parked on that service until it is toggled, and a revive checks the token again, so a token another
companion took while it was away parks it on that service.

### Compared with OpenClaw and Hermes Agent

Both projects were read for how they isolate (their docs and issue trackers, main branch); only the walls are compared here.

| | OpenClaw | Hermes Agent | Here |
|---|---|---|---|
| Unit | an agent inside one gateway process (own workspace, agent dir, sqlite for auth and sessions); the coarser unit is a gateway profile, its own process and port | a profile: a home directory with its own config, `.env`, state database; one multiplexing gateway serves them | a tenant folder: config, keys, home, private lists, database and harness homes in one place |
| Scope carried by | routing bindings | a context variable holding the home override, deliberately not written to the environment | an async store entered at the edge and re-entered where callbacks come from sockets and timers |
| No scope | unrouted traffic is left undispatched unless one owner exists | falls back to the default profile with a warning | the accessors throw; unrouted traffic is a 404 unless `default` is set |
| Secrets | channel tokens in one global config file | per-profile `.env`, scrubbed from children by name | per-tenant `.env`, never in `process.env`; children get an allowlist plus that tenant's file |
| Subprocess HOME | per agent sandbox, off by default | the real HOME unless a profile home mode is chosen | always the tenant's own `data/harness/home` |
| Duplicate credentials | not checked here | a duplicate (platform, token) adapter is parked | a duplicate bot token parks both tenants |
| Sandbox | per agent or session, optional, documented as not a perfect boundary | none in-process | none in-process; the `spawnWrapper` seam |
| Trust statement | one trust boundary per gateway; adversarial users need a separate gateway and OS user | in-process isolation is not enough for adversarial profiles | the same: option (a), or the seam |

What they have and this does not: a filesystem sandbox per agent, per-agent tool allow and deny lists, and a full per-profile
HOME as an option (here it is the only mode). Those are in the roadmap. A doctor command exists now: `npm run doctor` (below); an
audit of a running process's state does not. Hot park and revive of one tenant exists too ("Parking a companion", below). Their open
reports are the checklist this was built against: a singleton that wrote one profile's memory into
another, configuration bridged into the process environment, scope lost across an executor or a watcher task, a same-named MCP
server shared across profiles, a reload with no secret scope. Each has a counterpart here (per-tenant state behind `tenantLocal`,
the environment never written, bound callbacks, MCP keyed by tenant, `rt.reload()` reading the tenant's own files) and a test.

### `npm run doctor`

`npm run doctor [-- --tenant <id>] [--json] [--root <dir>]` prints the health checks the runbook below does by hand, one line each (OK, WARN or FAIL, with a
sentence). It exits 0 when no line is a FAIL, 1 when any is, and 2 for a command line it cannot read. It reads and never writes, and prints names, paths, modes and lengths, never a secret.

- **WARN**: the app runs, but something is not as recommended (a missing optional file, a short token, a home folder others can list).
- **FAIL**: boot would skip or refuse it, or a secret is exposed (a `.env` that group or world can read).
- `--root <dir>` checks the install in another folder (operator use): it reads that folder with the permissions of whoever runs it.

- **Config**: `sanctum.yaml` parses; the shipped prompts, the wake prompts and the companion-home config files exist; the Claude frame as the
  app resolves it (the home's copy, the configured file, or the preset).
- **Tenants** (when a `tenants:` block exists, or `--tenant` names one): per tenant, the boot scan (no link, pipe or second hard link), the
  `tenant.yaml` and `.env` rules boot enforces, the never-inherited table against the live merged config (a never-inherited key may hold only what
  the tenant's own file says, and no secret-named key may come from the operator's file), file modes (`.env`, `app.env`, `data/.internal-token`,
  `data/.google-key`: none group or world readable), and the home with `identity/` and the three harness copies in `config/`. Across tenants:
  duplicate hosts, hosts reserved by a tenant boot would skip, duplicate internal tokens and duplicate bot tokens in the `.env` files (compared by
  hash; a token saved in a tenant's database is not read). `--tenant` reports one tenant in full and still runs the clash checks over all.
- **Process**: the node version against `engines`, the build folder (`packages/frontend/build`: missing is a FAIL, no UI is served) and its stamp (`.build-id`, or `BUILD_ID` in the environment: neither is a WARN), the database path writable, and the
  process's own secret files.

`--json` prints the same report as `{ ok, exitCode, counts, root, sections: [{ name, checks: [{ status, check, message }] }] }`. Run it before the
soak below and after every step that edits a tenant's files.

### A chaos and soak run, locally

Before putting real people on it, run two tenants against a cheap model for a few hours.

1. Two tenants with throwaway names and hosts you can resolve locally (`ada.localhost`, `bea.localhost`, or `/etc/hosts` entries):

   ```bash
   mkdir -p /tmp/soak/tenants
   # sanctum.yaml: tenants: { dir: /tmp/soak/tenants }, server.host 127.0.0.1, a cheap model in agent.model
   npm run setup -- --tenant ada --create    # hostname ada.localhost, a different password for each
   npm run setup -- --tenant bea --create
   npm run build && npm start
   ```

   Log each tenant into its own harness home (the wizard prints the variables) or give each its own API key for the cheap
   model in its `.env`. Keep `background_runs: false` for the first pass; turn it on for the second.
2. Drive both at once from two browser profiles, one per host: long turns on both, a turn on A while B queues several, uploads on
   both, a Google connect on only one, a second browser signing in to A while B's session is open.
3. Break things on purpose: restart while both are mid-turn; put a second tenant's bot token into the first's `.env`
   (both must park, with one line each); edit one `tenant.yaml` to an outside path and restart (that tenant is skipped, its host
   answers 503, the other is unaffected); delete one tenant's `data/sanctum.db` while stopped.
4. Watch: the process log (only `[tenancy]` lines, never a tenant's text or a key); each `data/logs/tenant.log` (a line from A
   in B's log is a leak); `ls -l` on each `data/` and `.env` (0700 and 0600); `PRAGMA database_list` through each session
   shows its own file; resident memory and open handles per hour (a climb that tracks the number of turns is a per-turn leak);
   the same tenant id in every line of a turn; sessions and cookies from A refused on B; no key in `process.env` of the server
   (`/proc/<pid>/environ`) beyond what you exported yourself.
5. Stop it clean (SIGTERM): every tenant's timers and database close, and nothing is left running.

The real-SDK two-tenant soak (two real logins, real turns) has not been run; it is on the roadmap.

### Why it is built this way

Option (b) was first designed for cost at scale and for a hosted offering; it is built so several people can share one box
without one OS user and one clone each. The design's central choice stands: one database file per tenant, so "export my
tenant" is a file copy, the backup story of `CONFIGURATION.md` §8 holds, and a missing `WHERE tenant_id =` cannot happen.
