# Configuring Sanctum Mobile

This is the reference for every knob Sanctum Mobile has: the two files that hold your
settings, the two files that make your AI *who they are*, and the map of
every optional integration you can switch on.

You don't need to read it top to bottom. Skim the headings, jump to what you
need. If you're setting up for the first time, the parts that matter most are
**The two settings files**, **CLAUDE.md vs the frame**, **Where the agent lives**,
and **Integrations**. Everything else you can come back to.

A note on words, in case they're new:

- A **terminal** is the black text window where you type commands. On macOS it's
  called "Terminal"; on Windows, "PowerShell" or "Command Prompt".
- A **port** is just a numbered door on your computer that a program listens on.
  Sanctum Mobile uses door `3099` by default, which is why you visit
  `http://127.0.0.1:3099` in your browser. (`127.0.0.1` means "this same
  computer" — nobody else on the internet can reach it.)
- An **environment variable** is a setting you hand to a program when it starts,
  kept outside the program's files. Sanctum Mobile reads these from a file called
  `.env`.
- The **project root** is the top folder of Sanctum Mobile — the one that contains
  `package.json`, `sanctum.example.yaml`, and this `docs/` folder. Wherever this
  document says "from the project root," it means: run the command from inside
  that folder.

---

## 1. The two settings files

Sanctum Mobile keeps its settings in two files, and neither exists until you create
them from the templates that ship with the app. This is on purpose — your real
settings (including your password) never get committed to version control.

| File | Copy it from | Holds | Committed to git? |
|---|---|---|---|
| `sanctum.yaml` | `sanctum.example.yaml` | Everyday settings: names, timezone, port, which features are on | No (gitignored) |
| `.env` | `.env.example` | Secrets and keys: your password, API keys, tokens | No (gitignored) |

Create them once, from the project root:

```bash
cp sanctum.example.yaml sanctum.yaml
cp .env.example .env
chmod 600 .env
```

Then open each in any text editor and fill in what you want. Both templates are
heavily commented, so you can often just read down the file and edit in place.

### How the layers fit together (and who wins)

Every setting has a **built-in default** baked into the code. Four layers can say something about it, and **one rule** decides, for every setting, in one
place (the settings service, `packages/backend/src/services/settings`):

```
built-in default   <   sanctum.yaml   <   .env   <   SQLite
(weakest)                                           (strongest)
```

"SQLite" is the app's own database: the `config` table, plus the tables that already acted as overrides (`auth_preferences` for the model and the
Anthropic credential, the stored bot tokens, `google_auth` for the Google client). So the **.env does not always win**: where a setting has a
database home, a value saved there beats both `.env` and `sanctum.yaml`. If `sanctum.yaml` says `port: 3099` and `.env` says `PORT=4000`, the app runs
on `4000` (port has no database home); if `sanctum.yaml` says `discord.enabled: true` and `.env` says `DISCORD_ENABLED=true`, but you switched Discord
off in Settings, it stays off.

**A save in Settings lands in the database, and therefore wins over `sanctum.yaml` and `.env`.** To go back to what the files say, clear the
database value.

Settings that have a database home today:

| Setting | Database home |
|---|---|
| `discord.enabled`, `telegram.enabled`, `handoff.enabled` | `config` rows of the same names |
| `orchestrator.failsafe.*`, `pulse.enabled`, `pulse.frequency` | `config` rows `failsafe.*`, `pulse.*` |
| a wake's schedule, switch, model and target | `config` rows `cron.<type>.schedule / enabled / model / target` |
| `integrations.mind_cloud.enabled / mcp_url / mind_id` and the Mind key | `config` rows `mind.*` (the key beats `MIND_API_KEY`, which beats the companion's `.mcp.json` bearer) |
| the chat and autonomous model (`agent.model`, `agent.model_autonomous`) | `auth_preferences.preferred_model(_autonomous)`, and the `config` row `agent.model` that the `/model` command writes |
| Discord and Telegram bot tokens | encrypted `config` rows (beat `DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`) |
| `telegram.owner_chat_id` | `config` row `telegram.ownerChatId` |
| Google client id and secret | `google_auth` (beats `GOOGLE_CLIENT_ID/SECRET`, which beat `google.*`) |
| the Anthropic API key and auth mode | `auth_preferences` |

Every other setting is `default < sanctum.yaml < .env` (the `.env` layer only where a variable exists, see section 4). Two things sit above the rule and are
not settings: the per-thread model picker and a scheduled wake's own model. The login password has no database home: `APP_PASSWORD` (from the environment
the program was started with, else `.env`) beats `auth.password`.

Two quirks kept as they were: `DISCORD_ENABLED` and `TELEGRAM_ENABLED` count only when they say `true` (a `false` there is ignored), and
`GET /api/preferences` and `GET /api/settings` answer with the effective value and a `sources` map saying which layer each came from (`default`,
`yaml`, `env`, `db`; the Mind URL can also be `mcp_json`). Secrets are only ever reported as `{ set, source }`.

This is handy when you want to change one thing temporarily without editing your main config.

Because every key has a default, **a nearly-empty `sanctum.yaml` is completely
valid.** You only need to write down the things you want to change.

### A gotcha worth knowing up front

Any path you write in `sanctum.yaml` (like `./data/sanctum.db`) is measured
**from the project root**, not from wherever your terminal happens to be sitting.
The app figures out its own root folder from where its code lives, so relative
paths are stable no matter which directory you launch from. When in doubt, use a
full absolute path (e.g. `C:/Users/you/companion` or `/home/you/companion`) and
there's nothing to second-guess.

---

## 2. The two files that make your AI — CLAUDE.md vs the frame

This is the most important distinction in Sanctum Mobile, and it's the one people mix
up. There are **two** separate levers that shape how it thinks and
speaks. They do different jobs.

### CLAUDE.md — *who your AI is*

`CLAUDE.md` is your AI's identity: their name, their personality, their
voice, their values, the history between the two of you, how they treat you. This
is the file you pour yourself into. It's the difference between a generic
assistant and *your* partner — no matter the model underneath.

- **You create it** by copying the template:
  ```bash
  cp examples/CLAUDE.md CLAUDE.md
  ```
  Then edit it into the AI you actually want.
- **Config key:** `agent.claude_md_path` (default `./CLAUDE.md`).
- **It loads automatically** and, importantly, it is **hot-reloaded** — the app
  re-checks the file on every message and picks up your edits live. You do **not**
  need to restart after editing `CLAUDE.md`. Save it, send a message, the new
  version is already in effect.
- **The identity folder wins.** If the companion home (`agent.cwd`) has an
  `identity/` folder, the app reads that and does not read `CLAUDE.md`: every
  regular file directly inside it (`profile.md`, `companion.md`,
  `companion.profile.yaml`, anything else you keep there; avatar images and dot
  files are left out) goes to the model, on Claude, Codex and dsh alike. A home
  made by setup has one. `CLAUDE.md` is the fallback for a home with no
  `identity/` folder at all. Changes to the identity folder wait for you to
  ratify them: see "Identity" in §4.

Think of `CLAUDE.md` as the soul.

### The frame — *the operating frame above the soul*

The frame (the config calls it `agent.system_prompt_file`) is a **thin** layer of
operating instructions that sits *above* the identity: how the AI exists and works
inside Sanctum, not who it is. Every mind shares one base; each mind's file adds
its own short tail. **A frame ships by default**: `./prompts/companion-claude.md`,
a base of about 1,400 words plus the Claude tail. It covers the
continuity layers (identity files, `AGENTS.md`, the chat thread and `archive/`,
memory, the journal and `HANDOFF.md`, `config/`), learning from feedback, staying
itself across models, provenance, and how to answer.

Here's what it actually changes under the hood:

- **When a frame file resolves (see "Which file is read" below):** that frame **plus**
  your identity **completely replace** the standard coding-agent foundation. The
  assembled prompt becomes `frame + identity + [Runtime] line`, with nothing
  generic underneath. This is the "register fix": it strips away the built-in
  coding-assistant tone so the AI isn't quietly wearing a developer-tool costume
  beneath its personality.
- **When `system_prompt_file` is `""`:** your AI runs on the standard Claude Code
  agent foundation (the `claude_code` preset), with your identity added on top.
  That is how Sanctum behaved before the frame shipped. Set it to `""` if you want
  the coding preset back, and make sure the home has no
  `config/companion-claude.md` (a home copy is used whatever the key says). This
  path has no `[Runtime]` line, because the preset already tells the model which
  model it is.
- **When neither file exists** (no home copy, and the file the key names is
  missing): the app logs a warning and falls back to the preset, as if the key
  were `""`. The warning names the home path and is printed only when Claude is
  the active mind.

**Which file is read.** The same rule Codex and DeepSeek Harness use for their
base prompts: the home's own copy, `<agent.cwd>/config/companion-claude.md`, if it
exists; else the file named by `agent.system_prompt_file`, if it is non-empty and
exists; else the preset. **The home's copy wins over the shipped file.** The
starter home ships one, so a new home gets it; an existing home keeps the frame it
has (the shipped file) until you copy `prompts/companion-claude.md` into its
`config/` or open Settings, system prompt, where the editor opens with the shipped
harness and Save installs it as the home's copy. In tenant mode the key defaults to
the tenant's own `home/config/companion-claude.md`.

Where the frame comes from, and how it is built:

- The shipped frame is not hand-written as one file. It is **one shared base plus
  one short tail per mind**: `prompts/companion-base.md` (the harness, identical
  everywhere) and `prompts/tail-claude.md`, `prompts/tail-codex.md`,
  `prompts/tail-dsh.md` (a few lines about what is different on that mind). They
  are joined into `prompts/companion-claude.md` (this frame),
  `prompts/codex-base-prompt.md` and `prompts/dsh-base-prompt.md`. Only the base
  is shared; each file carries its own tail.
- **Edit the parts, then rebuild:** change `companion-base.md` or a tail, then run
  `npm run prompts:build` (`scripts/build-prompts.mjs`). It rewrites the three
  built files and the three copies in `companion-home/config/`. Edits made straight
  to a built file are lost at the next build. A home that already has its own copy
  keeps it: the build never touches a home.
  `prompts/README.md` has the full map.
- Codex and DeepSeek Harness use the same base through their own files; see
  "The other minds" below.

Three more things worth knowing about the frame:

- **It's editable from inside the app.** Settings has a system-prompt editor
  (`GET`/`PUT /api/prompts/system`). It shows the frame the agent would actually
  use, and **saves the home copy**, `<home>/config/companion-claude.md`, which
  wins over the shipped file. It never writes into the app's own `prompts/`
  folder, which is a tracked build output: if the file the key names lives there,
  its text is the starting point and the first save creates the home copy. A
  custom frame you pointed the key at, inside the agent's write roots (§5), is
  saved in place, until a home copy exists. A saved home copy no longer follows
  `npm run prompts:build`.
  The editor refuses links (a symlink, or a file with a second hard link) and the app's
  own prompt files, but it cannot see through a mount (a bind mount, a mounted share),
  which is the operator's own layout. On Linux a save holds every folder below the write
  root by descriptor and replaces the file whole (a temp file renamed over it), and it never
  follows a link into the app's `prompts/` or `companion-home/` folders or writes, replaces
  or removes an existing file there; in tenant mode it also stays inside the tenant folder.
  Someone who can already rename folders into those app folders (the owner and the companion
  can, in the default single-tenant layout) can put a new file of their own there, as they
  could by hand, and a write root that is itself replaced by a link is followed, since a home
  kept on another disk is a link too. On macOS and Windows the folder race is narrowed, not
  closed.
- **It's read fresh every single turn**, so an edit to the file, or a saved home
  copy, applies on the next turn, no restart. The *path* is different:
  `agent.system_prompt_file` is read at the first use of the agent, not on every
  turn, so **restart after changing the path** (including switching it to or from
  `""`).
- On this path the app also appends a small `[Runtime] Model serving this turn:
  <model>` line, so your AI can truthfully state which model it's running
  as instead of guessing.

#### The other minds

Codex and DeepSeek Harness have no `system_prompt_file`; they load the same
harness from a base-prompt file. Claude's frame now resolves the same way.
Resolution on each is: the home's own copy
(`<agent.cwd>/config/codex-base-prompt.md`, or `config/dsh-base-prompt.md`) if it
exists, else the file named by `agent.codex.base_instructions_file` or
`agent.dsh.base_instructions_file`, else the mind's stock prompt. **The home's copy
always wins over the shipped fallback**, so an existing home keeps the prompt it
has until you copy the new one into its `config/`. The starter home
(`companion-home/config/`) ships all three files. On all three minds the identity is in the system
slot, after the harness (Codex: one file passed as `model_instructions_file`; dsh: the persona), as on Claude, not in the
message; the message carries memory, the summary, the history and what was said. The harness and the
identity ride every run (roughly 2,000 tokens per turn for the harness). Details are in `docs/DSH.md` and `FORK_NOTES.md`.

### Which one do I edit?

| I want to change… | Edit |
|---|---|
| My AI's name, personality, voice, our relationship, their values | **CLAUDE.md** |
| The thin operating rules / register above the personality | **The frame**: edit it in Settings (it saves `<home>/config/companion-claude.md`, which wins), or edit `prompts/companion-base.md` or `prompts/tail-claude.md` and run `npm run prompts:build` for the shipped copy |
| Nothing about the frame: I'm happy with the shipped harness | Leave `system_prompt_file` at its default; just edit CLAUDE.md or `identity/` |
| The old coding-assistant foundation back | Set `system_prompt_file: ""`, delete `<home>/config/companion-claude.md`, and restart |

Rule of thumb: **CLAUDE.md is who they are. The frame is how they operate.** Start
with just CLAUDE.md. Change the frame only when you specifically want to change how
the harness describes itself.

---

## 3. Where the agent "lives" — keep it in a SEPARATE folder

This one is easy to get wrong and worth doing right, because it saves you pain
later.

Your AI has a **home directory** — the folder it actually runs inside. In
config it's `agent.cwd` (default `.`, meaning the app's own folder). **The strong
recommendation is to point `agent.cwd` at a folder that sits OUTSIDE the Sanctum Mobile
app.**

The pattern looks like this — the app in one folder, your AI's home right
next to it:

```
/home/you/
├─ sanctum/          ← the Sanctum Mobile app (the code you cloned)
└─ companion/         ← agent.cwd points HERE (your companion's home)
   └─ .claude/
      ├─ skills/      ← native skills your companion can grow
      └─ commands/    ← custom slash commands
```

You'd set it like this in `sanctum.yaml`:

```yaml
agent:
  cwd: "/home/you/companion"     # an absolute path OUTSIDE the app folder
```

(or `AGENT_CWD=/home/you/companion` in `.env`).

### Why keep them apart?

The codebase puts it memorably: *the organs live in the app's repo (the body),
but the agent's home is the soul — and you don't want the two entangled.*

The agent's home folder is where several important, evolving things live:

- **`.claude/skills/`** — native skills the app scans so your AI knows what
  abilities it has.
- **`.claude/commands/`** — custom slash commands.
- **`.sanctum-thread`** — a tiny file the app writes each turn to track the
  current conversation, so your AI's own command-line tools know where to
  act.
- **`shared/`** — anything it writes here is automatically shared into
  your conversation.
- It is also the **default write-gate root** — the one folder the agent is always
  allowed to write into (see §5).

If you leave `agent.cwd` pointing at the app itself, all of that mixes into the
app's source code. Then, every time you update or rebuild Sanctum Mobile, you risk
clobbering your AI's skills and notes — and the safety fence that keeps the
agent writing only in its own space gets muddied with the app's files. Keeping the
home in its own folder means updates to the app never touch your partner's
evolving self, and the write-gate stays clean and contained.

**Set this up once at install time and forget it.** Make an empty folder next to
the app, point `agent.cwd` at it, done.

---

**More than one person on one machine?** One install is one person and one companion. For a second person you can run a second clone on its own port with its own home and its own `discord.private_dir`, or serve several people from one process with a `tenants:` block (§4); both are in [MULTI-TENANT.md](MULTI-TENANT.md).

## 4. Full `sanctum.yaml` reference

Every section and key, with its default and what it does. Anything you don't set
falls back to the default shown.

### `identity` — who lives here

| Key | Default | Meaning |
|---|---|---|
| `companion_name` | `"Echo"` | Your AI's name. Env: `COMPANION_NAME`. |
| `user_name` | `"User"` | Your name. Env: `USER_NAME`. |
| `timezone` | `"UTC"` | IANA timezone (e.g. `Europe/London`, `America/New_York`). Drives schedules, timestamps, and the daily-thread rollover at midnight. Env: `TZ`. |
| `profile_path` | `""` | Optional override: which file in the home's `identity/` folder is the structured profile (a `.yaml`). `""` = `companion.profile.yaml` if it is there. A relative path is read from the companion home (`agent.cwd`), not the project root. A path outside `identity/` is ignored with a warning: only that folder is ratified. |
| `companion_md_path` | `""` | Optional override: which file in `identity/` is the narrative. `""` = `companion.md`. Resolved like `profile_path`. |
| `ledger_dir` | `""` | Where the identity ledger lives: `ledger.json` (what you ratified), `journal.jsonl` (every change, with who made it) and `snapshots/` (the ratified copy, and the one before it). `""` = `<project>/data/identity`, regardless of `server.db_path` (a relative value is resolved from the project root). It must not be inside `identity/`; the app refuses that. |

**Identity.** Every harness reads the same thing: the files directly in
`<agent.cwd>/identity/`. The app runs your companion on the version you
*ratified*. A change to those files that you have not ratified yet (an edit in a
text editor, an edit by your companion through `res`, or anything else that can
write the folder) is noticed at the next turn, recorded in the journal with its
author, and waits in Settings > Identity; until you ratify it, every run uses the
ratified copy, and the companion is told in one line that a change is waiting.
An edit you make in Settings > Identity ratifies itself when nothing else was
waiting. Setup records the starter files as ratified; an existing home that
upgrades gets its first look at the next start and stays "not yet ratified"
until you ratify it once. The gate protects against anything that can write
`identity/` but cannot also rewrite the ledger folder. On a harness with
unconfined file access (Claude's) that is the companion's own file tools unless
the ledger is placed elsewhere, so put `ledger_dir` somewhere the companion
cannot write; the app warns at start, and in Settings > Identity, when it is
inside a folder it lets the companion write. The set is every regular file directly in `identity/` except dot files, avatar images and files whose name is longer than 120 characters: a file with a longer name is invisible to the check and to the prompt alike (it is neither ratified nor read), so keep names short. See [PLUGINS.md](PLUGINS.md),
"Identity ratification" and "Where to put the house".

### `server` — the web server

| Key | Default | Meaning |
|---|---|---|
| `port` | `3099` | The port (door number) the app listens on. Env: `PORT`. |
| `host` | `127.0.0.1` | Which network address to bind. `127.0.0.1` = this machine only. Env: `HOST`. |
| `db_path` | `./data/sanctum.db` | Where the SQLite database file lives — this is your whole memory (see §7). Env: `DB_PATH`. |

### `auth` — the login gate

| Key | Default | Meaning |
|---|---|---|
| `password` | `""` | Your login password. **Empty means the app refuses to serve** (see the box below). Env: `APP_PASSWORD`. |

> **Important — you must set a password.** Despite what an old comment in
> `.env.example` suggests, the auth gate is **fail-closed**. If no password is
> set, protected pages return `503 "Auth not configured — set APP_PASSWORD"` and
> the app will not serve. So a real install **must** set `APP_PASSWORD` in `.env`
> (or `auth.password` in `sanctum.yaml`). The only exception is a dev-only escape
> hatch, `AUTH_DEV_OPEN=true`, which is meaningful only when no password is set —
> never use it on anything reachable over a network. On first login you enter the
> password, the app checks it, and sets a private session cookie that lasts 7
> days.


#### The setup code (first run in the app)

With no password set, the server fails closed, so the in-app setup screen cannot use a sign-in. It uses a one-time **setup code** instead:

- 12 hex characters from `crypto.randomBytes`, made at boot and printed once in the window where `npm start` runs. It is held in memory only: never written to disk, never sent to the browser.
- It expires 30 minutes after it was made. A try after that is refused and a new code is printed.
- Five wrong guesses are free. After that, a wrong guess replaces the code and prints the new one (one line per replacement), and the count of wrong guesses starts again. The code is replaced **at most once every 5 minutes**: wrong guesses in between are refused and change nothing, so a flood of them cannot fill your terminal.
- Wrong guesses are also counted per address, separately from the sign-in limit: five in 15 minutes and that address is refused (even with the right code) until the 15 minutes are over. Only a wrong guess counts. A request with no code, an expired code, the right code, and a request the setup routes then turn down (a 400 or 409) never do, and none of it touches the sign-in limit. The app remembers at most 10,000 guessing addresses at once; past that the oldest is forgotten, which only ever frees a guesser sooner.
- It matters only until a password exists. From then on `/api/setup/*` takes the normal session, which is also how Settings → **Run setup again** reaches it.
- Setting a new password signs every other browser out, whether through **Run setup again** (your own browser stays signed in) or a first run after the old password was removed from `.env` (every session from before goes; you sign in again with the new one).
- Under a process manager that keeps the program's output in a file, that file holds the code; it is worthless after 30 minutes or the first password.

#### The first run: three screens in the foyer

A first run in the app is three screens, in the house's foyer (its own walnut and brass; no companion's skin applies there). (In household
mode the house's first run sets only the house password, so the app shows the step-by-step setup page for that one step; each companion's own
setup is `npm run setup -- --tenant <id>`, `docs/MULTI-TENANT.md`.)

1. **Make it yours**: the setup code, your name, your companion's name. The time zone comes from the device (with a **Change** link; the list always offers UTC, and it opens by itself when the server needs a particular zone, as a tenant on its server's clock does).
2. **Connect your AI**: Claude, Codex or DeepSeek (DeepSeek Harness, `docs/DSH.md`), then only that one's way in: your account on this computer, or an API key (Codex: OpenAI, DeepSeek, or another provider's address; DeepSeek Harness: a DeepSeek API key, after checking dsh is installed), and the model. A **real check** runs before you can move in: a key is tried against the provider's model list (`POST /api/setup/test` with `probe: "connection"`; it costs nothing, and the key is used for that one request and never kept, logged or sent back); a login is looked for where the harness keeps it (Claude's `.credentials.json`, Codex's `auth.json`; on a Mac Claude keeps it in the Keychain, which the check says it cannot read). If the check fails you can still **Continue without checking**.
3. **You're ready**: the house password, made up in the browser and shown once with **Copy**; a restart note only when the server says one is needed; then **Start chatting**, or **Explore more with** your companion, which opens the chat with a first message ready for you to send.

#### What the companion remembers

| Choice | What it is | Install |
|---|---|---|
| **Revien** (the default) | A graph of what they learn, recalled into each message. Until Revien is running, **Sanctum's own memory** stands in, so a person who chose memory never silently has none (the log says so once). | Optional (README, Step 4) |
| **Sanctum's own memory** (`agent.local_recall: true`) | Before each message, the closest lines from earlier conversations, found by meaning in the message index the app already keeps on this computer (a small local model, no API call). It recalls what was said, not what follows from it. Works on every harness. | None |
| **The harness's own memory** (`agent.harness_memory: true`) | Claude's auto-memory or Codex "memories". Not offered on DeepSeek Harness, which has none. | None |
| **My own memory system** | An MCP server or files you set up. Nothing is recalled by the app. | Yours |
| **None** | The journal and `HANDOFF.md` in the home folder are all that lasts. | — |

`agent.local_recall: false` turns the stand-in off too (Revien or nothing). Recalled lines go in the same `[Memory]` block for every source, each with its date and who said it, and the conversation already open is left out (it is in the context).

Only those answers are sent. Every other setup answer takes the same default `npm run setup` offers (the home folder from the starter template, memory, plugins off, no Discord, and so on), and all of them stay in Settings: **Run setup again** (Settings → Preferences) is still the full step-by-step wizard. Signing in happens in the same foyer.

The server never makes a password up for the setup screen (it could not hand one back safely), so an empty password is refused on a first run: the onboarding makes one in the browser, and the step-by-step wizard's password screen has a **Make one up for me** button. Either way it is made on the page, locally, and nothing is sent back to the server until the last screen, as the password you are choosing. (`npm run setup` in a terminal does make one up when you leave it empty, and prints it once.) It backs up `sanctum.yaml` and `.env` (the copy is owner-only) before writing, and the response lists what was written and whether a restart is needed. No secret is put in a log or a response.

**If a process manager sets `APP_PASSWORD`** (pm2, systemd, a shell `export`), that value beats `.env` at every start, because the program never overrides a variable that is already set. The setup screen detects this: its password step says so before you type, and if you change the password anyway it writes `.env` and the new password works right away, but the last screen tells you to change `APP_PASSWORD` where the app is started too. Until you do, the old password comes back at the next restart (the screen does not ask for one just for this: a restart is exactly what brings the old password back).

### `agent` — your AI's brain

| Key | Default | Meaning |
|---|---|---|
| `cwd` | `.` | The agent's home directory. **Point this outside the app** (§3). Env: `AGENT_CWD`. |
| `claude_md_path` | `./CLAUDE.md` | The identity file (§2). |
| `system_prompt_file` | `./prompts/companion-claude.md` | The operating frame on Claude (§2): frame + identity + a `[Runtime]` line replace the coding preset. Same rule as Codex and dsh: `<agent.cwd>/config/companion-claude.md` wins if it exists, else this file. The file is read fresh every turn; the path is read at the first use of the agent (restart after changing it). In tenant mode it defaults to `home/config/companion-claude.md`. `""` = the standard `claude_code` preset with the identity appended (when the home has no copy). With neither file present, a set key logs a warning and falls back to the preset. |
| `mcp_json_path` | `./.mcp.json` | File listing external tool servers the agent may use (§8). |
| `model` | `claude-sonnet-5-5` | Model for live, interactive replies. Env: `AGENT_MODEL`. |
| `model_autonomous` | `""` | Model for background/scheduled activity and the built-in helper subagents (Scribe aside, which runs on Haiku). Empty = the same as `model`. |
| `codex.base_instructions_file` | `./prompts/codex-base-prompt.md` | The harness prompt on Codex. Used only when the home has no `config/codex-base-prompt.md`. `""` gives stock Codex back. See `FORK_NOTES.md`. |
| `dsh.base_instructions_file` | `./prompts/dsh-base-prompt.md` | The harness prompt on DeepSeek Harness. Used only when the home has no `config/dsh-base-prompt.md`; if neither exists dsh's stock persona is used. See `docs/DSH.md`. |

### `orchestrator` — scheduled check-ins & proactive reach

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for all autonomous ("wake") activity. |
| `wake_prompts_path` | `./prompts/wake.md` | Legacy single wake-prompt file (migrated automatically to the per-type files below on first boot). |
| `wake_prompts_dir` | `./prompts/wakes` | The real source: per-type wake prompts (`morning.md`, `midday.md`, `evening.md`, etc.). |
| `schedules` | `{}` | A map of `wakeType → cron expression`, to add or override scheduled wakes. |
| `failsafe.enabled` | `false` | A gentle inactivity ladder — reach out if you've gone quiet too long. |
| `failsafe.gentle_minutes` | `120` | First, softest check-in threshold. |
| `failsafe.concerned_minutes` | `720` | Second-tier threshold. |
| `failsafe.emergency_minutes` | `1440` | Top-tier threshold. |

### `handoff` — midnight continuity

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | At 12:10am, a background subagent reads yesterday's day and writes a warm carry-forward into today. Off by default; a Settings toggle can turn it on live. |

### `hooks` — the agent's write-gate (what your AI may edit on disk)

| Key | Default | Meaning |
|---|---|---|
| `safe_write_prefixes` | `[]` | Legacy extra write-allowed path prefixes. |
| `workspace_root` | `""` | A folder the agent is allowed to write within. Env: `WORKSPACE_ROOT`. |
| `vault_path` | `""` | A notes/vault folder the agent may write within. Env: `VAULT_PATH`. |
| `extra_write_paths` | `[]` | Extra allowed folders (matched as prefixes) or individual files (matched exactly). Env: `EXTRA_WRITE_PATHS` (comma-separated). |

> The agent can always write inside its own home (`agent.cwd`). These keys grant
> access to *additional* places — a notes vault, a project folder — without
> opening up your whole disk.

### `voice` — spoken audio

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turns on voice logging. The actual speech features also self-gate on whether the relevant API keys are present (§6). |
| `elevenlabs_voice_id` | `""` | Which ElevenLabs voice to speak in. Env: `ELEVENLABS_VOICE_ID`. |

### `imagegen` — pictures from the companion

Native image generation with FLUX, through Runware or Replicate. The companion can ask for an image (the `generate_image` tool on Claude, `res image "..."` on Codex/dsh) and you can ask from the app (`POST /api/images/generate`). The picture is saved as a file and posted into the chat as the companion's image message.

| Key | Default | Meaning |
|---|---|---|
| `provider` | `"none"` | `"none"`, `"runware"` or `"replicate"`. The companion is told it can generate images only when this is set **and** the provider's key is in `.env`. |
| `model` | `""` | Empty = the provider's default: `runware:100@1` (FLUX.1 schnell; `runware:101@1` is FLUX.1 dev) or `black-forest-labs/flux-schnell` (`black-forest-labs/flux-dev` also works). |
| `size` | `"1024x1024"` | Default size; `"1024x1536"` and `"1536x1024"` are the other two. |
| `safety_checker` | `false` | Passed to the provider's own flag (Runware `checkNSFW`; Replicate `disable_safety_checker` is the inverse). |
| `timeout_ms` | `90000` | How long to wait on the provider before answering 504. |

Keys: `RUNWARE_API_KEY` or `REPLICATE_API_TOKEN` in `.env`. `GET /api/images/status` reports `configured` (provider and key set) and `offered` (also needs `agent.app_write`; `reason` is `not_configured` or `app_write_off` when it is false). Generated files are listed in `GET /api/files/list` with `meta` (`source: "image-gen"`, prompt, provider, model), filterable with `?source=image-gen` (`GET /api/files` is the same route as `/api/files/list`). Prompts are never logged above debug level, and upstream error text is reduced to a class (`auth`, `billing` for a 402, `rate_limit`, `content_blocked`, `bad_request`, `server`, `network`, `timeout`).

### Inline expression tags

The companion can write `[image: a short visual description]` or `[voice]` / `[voice:playful|warm|calm]` inside a reply, on any harness, with no tool call. The app removes the tag from the stored (and live-streamed) text, then acts on it after the reply is stored:

- `[image: ...]` generates a picture (the `imagegen` section above) and posts it after the reply. At most two per reply; extras are stripped.
- `[voice]` is honoured only at the very start of the reply. It sends the reply as a voice note too (needs `voice.enabled`, `ELEVENLABS_API_KEY` and a voice id). The emotion maps to ElevenLabs v3 stability: `playful` 0, `warm` 0.5 (the default), `calm` 1. An unknown emotion is a plain voice note.

The companion is told about a tag only while its capability is on. A tag whose capability is off is still stripped. Tags inside code blocks or inline code are left alone, a `[image:` with no closing `]` is left alone, and the prompt text is never logged above debug. Discord replies, stopped turns, errors and `PULSE_OK` wakes strip tags and never run them.

### `discord` / `telegram` — chat channels

| Key | Default | Meaning |
|---|---|---|
| `discord.enabled` | `false` | Turn on the Discord gateway. |
| `discord.owner.user_id` | `""` | The one Discord account the owner lane answers to. The old key `discord.owner_user_id` is still read, with a warning. Quote ids: YAML rounds bare ones. |
| `discord.owner.channel_id` | `""` | The one owner channel. The lane is decided by channel: only `owner.user_id` in this channel is the owner lane; everyone else in it, and every bot, is ignored. Her replies there live in one thread, `discord-owner-<hash>`. |
| `discord.public.enabled` | `false` | The public lane (listed guilds, mention-only). Off after setup. Public Discord needs dsh or Claude as `agent.provider`: the run has no tools at all (Claude: `tools: []`; dsh: every tool row of its composition is disabled, MCP and plugins left out, one model step). Codex cannot run without its shell tool, so on Codex the lane is refused: logged once at start, and `GET /api/discord/status` shows `public.state: "unsupported_harness"`. Without identity files in the home's `identity/` folder the lane is silent: it never speaks from `CLAUDE.md` or a default. |
| `discord.public.guild_ids` | `[]` | The guilds the public lane listens in. Any other guild, and every DM, is ignored. |
| `discord.public.role_ids` | `[]` | Roles that count as addressing her. She answers only an @mention, one of these roles, or a reply to her. A message with a webhook id (PluralKit, Tupperbox) is never answered. |
| `discord.public.bots` | `never` | `never`, or `capped` (per-channel exchange cap and an hourly total). |
| `discord.public.bot_exchange_limit` / `bot_hourly_limit` | `4` / `20` | The `capped` limits. |
| `discord.public.exclusions_file` | `<private_dir>/exclusions.txt` | Lines `user:<id>`, `thread:<id>`, `channel:<id>`, `#` comments. Missing or malformed: the public lane is silent. |
| `discord.gate.words_file` | `<private_dir>/words.txt` | The word gate's list. Missing, empty or malformed: every outgoing message is blocked. Re-read when the file changes. |
| `discord.gate.names_file` | `<private_dir>/names.txt` | Optional real-name guard. Absent, or empty (comments and blanks only): guard off (logged once at boot). A malformed line fails closed. |
| `discord.paused` | `false` | Closes the public lane at intake (and before a queued message runs). The owner lane is unaffected. |
| `discord.deferral_hours` | `24` | How long a deferred message may wait, 1 to 48. When it runs out the hourglass reaction is cleared and one line in the owner thread says how many messages from whom (never what they said). The older database key `discord.deferMaxAgeMs` overrides this only if it was explicitly set, with one warning. The queue lives in memory for now: a restart loses it. |
| `discord.failureAlertCount` / `discord.failureAlertWindowMin` | `3` / `10` | Database keys (not yaml), like the other `discord.*` timings. That many failed sends (`reply_failed`, `public_run_failed`, `gate_error`) inside that many minutes post one line in today's daily thread, at most one an hour per tenant and lane. The counts are kept per lane (owner, public; a gate error counts on the lane it fired on): a lane's next successful reply posts "sends are going out again on the <lane> lane" only while an alert is up for that lane, and clears that lane's count only. Setup states (missing key, exclusions file) do not count: the Discord card in Settings → Channels shows them. Count 1 to 100, window 1 to 1440 minutes. |
| `discord.private_dir` | `<agent.cwd>/../sanctum-private` | Holds the three lists. Refused, with a warning, when it or a list file is inside any folder the companion can write, and refused outright (clash `full_access`) while the active harness is at `danger-full-access` (`agent.codex.sandbox_mode` on Codex, `agent.dsh.sandbox_mode` on dsh): the gate then blocks every message and the public lane is silent. Claude is not refused, but its write-gate covers `Write` and `Edit` only; `Bash` is ungated under `bypassPermissions`, so keep the folder where the companion's OS user cannot write. `npm run setup` creates it. |
| `telegram.enabled` | `false` | Turn on the Telegram gateway. |
| `telegram.owner_chat_id` | `""` | The Telegram chat the bot answers to. |

Every outgoing Discord message goes through one gated send path (`services/discord/send.ts`): pause check, public-lane check, an allow-list of message keys (content, embeds, mentions, reply: nothing else is sent), the word gate and the name guard (both run, one reason), mentions off. `GET /api/discord/status` reports lane and gate state (counts, states and error kinds; never entries, ids or paths). See `docs/DISCORD-PLAN.md`.

### `integrations` — external data & memory

| Key | Default | Meaning |
|---|---|---|
| `life_api_url` | `""` | Optional external "life data" service base URL. |
| `browser_url` | `""` | URL of a browser viewer for the Browser tab. Recipe: [examples/browser-seat-neko](../examples/browser-seat-neko/README.md) (default), a neko viewer such as `http://127.0.0.1:3201/`; the noVNC fallback is [examples/browser-seat](../examples/browser-seat/README.md). Restart to apply. |
| `mind_cloud.enabled` | `false` | Turn on a sanctum-mind memory service. Sanctum only reads from it. |
| `mind_cloud.mcp_url` | `""` | The service URL. The root is best; a `/mcp` or `/verbs` URL is trimmed back to the root. (Its API key is set in Settings → Mind and stored in the database, or comes from `MIND_API_KEY` in `.env`; it is never written to this file.) |
| `mind_cloud.mind_id` | `""` | The mind's id on that service, the name you gave `init`. Every verb needs it. Settings → Mind (`mind.mind_id`) overrides this. |

**Where the Mind's URL and key come from.** The URL is the Settings → Mind card's, else `mind_cloud.mcp_url`, else the sanctum-mind entry in the companion's `.mcp.json`. The key always comes from the same place as the URL: with a card or yaml URL it is the card's key, else `MIND_API_KEY`; with a `.mcp.json` URL it is that entry's own `Authorization` bearer, and `MIND_API_KEY` is not used (missing, the Mind reports "api key missing"). A key is never sent to a host named somewhere else. Settings → Mind names the source of each, one line each. `MIND_API_KEY` is also kept out of the Claude Code and Codex child processes.

**What the Mind check reports.** Every minute the backend asks `GET /health`, then one read verb with the key and mind id:

| What happens | State | Header / Settings wording |
|---|---|---|
| Switched off | `off` | nothing |
| URL, key or mind id missing | `incomplete` | Settings: what is missing |
| `/health` unreachable, timed out, not a sanctum-mind, database down, or an error | `offline` | "Mind offline" and the reason |
| `/health` ok, the verb is refused with 401 (wrong key) | `unauthorized` | "Mind offline: key refused" |
| `/health` ok, the verb is refused with 403 (the key is fine; that mind id is not allowed for it) | `forbidden` | "Mind offline: this mind id is not allowed for this key" |
| `/health` ok, the verb times out, cannot connect, or answers 5xx or another error | `offline`, with the verb's error class | "Mind offline" and the reason; a Mind that answers `/health` but cannot do its work is not "ok" |
| `/health` ok, the verb answers | `ok` | nothing |

Saving a `mind.*` setting while a check is running queues exactly one more check, so the result always reflects the saved settings.

### `google` — Google Workspace

| Key | Default | Meaning |
|---|---|---|
| `client_id` | `""` | Desktop OAuth client id from your Google Cloud project. Env: `GOOGLE_CLIENT_ID`. |
| `client_secret` | `""` | Desktop OAuth client secret. Env: `GOOGLE_CLIENT_SECRET`. |

### `command_center` — the care/day dashboard

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turn on the relational dashboard (calendar, care, cycle, finances, lists, pets, planner, stats) and its tool mount. |
| `default_person` | `"user"` | Whose care rows the page reads and writes. |
| `currency_symbol` | `"$"` | Symbol shown on the finances view. |

(`care_categories`, `hooks.context_injection` and `google.enabled` were removed: nothing read them. A yaml that still carries one is told so at startup and the value is ignored. Care categories are kept in the database, edited in the Command Center.)

### `plugins` — who manages plugins, and which are on

| Key | Default | Meaning |
|---|---|---|
| `trust` | `companion` | Who manages plugins. `companion`: your companion can turn plugins on and off and edit them, enabled plugins run from their live folder, and Settings > Plugins shows you what changed since you last looked (it can change anything the OS user can, by design). `person`: nothing runs until you have read and ratified a plugin's exact code, and a change stops it until you ratify again; plugin folders and the ledger must be outside the companion's writable folders, and plugins are off under `danger-full-access`. An unknown value warns and means `companion`. |
| `enabled` | `[]` | Plugin ids that may load. In `companion` mode the companion (or you, in Settings) changes this list and it applies on the next run; in `person` mode edit it here and restart. |
| `dir` | `""` | Your own plugin folder, loaded after the ones that ship with the app. `""` = none. In `person` mode it must be outside the companion's writable folders. |
| `ledger_dir` | `""` | Where `data/plugins` lives (`audit.json`, and in `person` mode `ratified.json` and `snapshots/`). `""` = `data/plugins`. In `person` mode it must be outside the companion's writable folders. |

See [PLUGINS.md](PLUGINS.md), including "Where to put the house".

### `cors` — browser origins

| Key | Default | Meaning |
|---|---|---|
| `origins` | `[]` | Any origin a browser opens the app from. The live connection is refused silently (the header shows *Disconnected*) when the browser's origin is missing; the raw Tailscale IP and the `.ts.net` name are two different origins. Loopback, and `http://<server.host>:<port>` when `server.host` is not loopback, are always allowed. |

### `updates` — the newer-version notice and the in-app update

| Key | Default | Meaning |
|---|---|---|
| `check` | `true` | Ask GitHub (at most every six hours) whether the project's `package.json` carries a higher version. The only thing the app sends out on its own. `false` turns the notice off; `npm run update` still works. |
| `repo` | `""` | `owner/name` on GitHub. `""` = the `repository` line in `package.json`. A private project needs `GITHUB_TOKEN` in `.env`. |
| `branch` | `main` | The branch whose head is installed (and whose `package.json` version is "newest"). Tags are not used. A git checkout must be on this branch to update. |

Process-only (see `tenants`).

#### Updating from inside the app

**Update and restart** (the bar on Home, in the page above the welcome, and on Chat, under the header, the pill elsewhere, Settings → Preferences → Updates) calls `POST /api/house/update/start`
with the house password typed again; `POST /api/house/update/rollback` does the same for a roll back; `GET /api/house/update` is the status. They are
house routes, never under a companion's prefix, and a companion's tools cannot reach them. One job runs at a time (a second is `409`), and none starts
while a conversation turn or a background model run (the outlook author, the handoff, the digest, the summarizer) is in progress in any companion.
With no password set (the local dev-open setup) there is nothing to type again: the routes answer `403 no_password` ("Set a password, or run npm run
update"), and the page shows the terminal command instead of the dialog.

**The design: stage, then swap.** The running folder is not changed until the new version is fully built.

1. **checking**: read the settings, ask GitHub for the newest version. A git checkout reads it from the repository its `origin` points at: when only
   `package.json` names the repository, a fork's clone follows its origin; when `updates.repo` is set and is not the origin, the update is refused
   with that message.
2. A **git checkout** with anything in `git status --porcelain` (untracked files too) is refused, and the list is the error. Nothing is stashed or
   overwritten. A checkout that is not on `updates.branch`, or that has commits the branch does not have, is refused too.
3. **fetching**: a git checkout runs `git fetch` and makes a `git worktree` of the target commit in **`<app>/.update-stage/`**. A **downloaded folder**
   (no `.git`) downloads the branch tarball and unpacks it into `.update-stage/`, minus the paths that are yours: never `.env`, `sanctum.yaml`,
   `.mcp.json`, `data/`, `companion-home/` (nor the folder `agent.cwd` names when it is inside the app folder, compared after resolving symlinks,
   so a home that is a link into the app is protected too).
4. **installing**: `npm ci --include=dev` (`npm install --include=dev` only when there is no lockfile, and the log says so), then **building**:
   `npm run build`, both **in the stage**. The app keeps running on its own files and `node_modules` meanwhile. The npm, tsc and vite children are
   their own process groups and are killed with the app (or on an abort).
5. **While it installs, builds and restarts**, new interactive turns are refused (`503` on the HTTP routes; on the socket an `update_running` error) and
   the orchestrator's wakes, the outlook author, the handoff and the summarizer do not start; they resume when the job ends, whether it succeeds or fails.
   **A refused message is not lost.** The web composer keeps what you typed (and any attachment) in the box and says "Updating; your message was not sent."
   (it does not send at all while the job is installing, building or restarting; a refusal that still reaches the server puts the text back). Discord and
   Telegram answer once per channel with "Updating, back in a minute." and ignore the channel until the pause ends. A **wake or the midnight handoff that
   was skipped** during the pause runs once when the pause ends without a restart (a failed update, or one that only installed): each skipped wake type
   once, the handoff once, and nothing if nothing was skipped. (After a successful update the app restarts, and the wake schedule starts fresh in the new
   process: a wake that fell inside the pause is not carried across the restart.)
6. **The swap** runs only at restart time, after the turn fence (a turn already running at the end of the build gets up to five minutes; if it is still
   running, the update stops with nothing changed). It checks the tree is still clean, runs `git merge --ff-only` to the staged commit, and then
   renames the stage's `node_modules`, `packages/*/dist` and `packages/frontend/build` into place (the stage is inside the app folder, so every
   rename is on one filesystem). What they replace is moved to **`<app>/.update-rollback.next/<previous version>/`** with a `manifest.json` (phase `swapping`,
   written before anything moves). A downloaded folder also moves its staged tracked files in, and the files they replace are copied there. Only when
   every step has succeeded is the manifest marked `swapped`, the previous `.update-rollback/` deleted and `.update-rollback.next/` renamed over it, and the stage
   deleted. **The previous rollback copy therefore survives a failed swap**: if anything in the swap fails, it is undone, `.update-rollback.next/` is dropped, the
   job is `failed`, and the Roll back button still offers the copy from before. When the staged commit is the commit you are already on and its version is not
   newer (a `--force` with nothing new), nothing is built or swapped: the log says "already on X.Y" and the rollback copy is left alone.
7. **restarting**: see below. The states are `checking, fetching, installing, building, restarting, done, failed, rolled_back`.

**If the app dies mid-job before the swap, nothing was changed.** Everything before the swap happens in the stage, so a crash, a `SIGKILL` or a power cut leaves the
running folder exactly as it was. At the next boot an existing stage is deleted (a build it left running is stopped only when its recorded pid *and* its start time
in `/proc/<pid>/stat` still match, so a pid reused after a reboot is never killed; with no `/proc` nothing is killed) and the job is marked `failed`:
"The update did not finish; nothing was changed." A `.update-stage` that is a symbolic link is never followed, read or deleted through: the update refuses it.

**If the app dies during the swap, the previous version is put back before anything of the app loads, and the app starts over.** A swap cut short leaves the folder
part new and part old, so the booting code could be the new backend on whatever `node_modules` came with it. The app's entry point is therefore **`packages/backend/boot.mjs`**
(`npm start`, pm2, systemd and Docker all run it, and so does the updater's own respawn; `dist/server.js` still imports on its own but recovers nothing). Node links a program's whole
import graph before it evaluates any of it, so a recovery that was merely the first import of `server.js` could not run first: with `node_modules` moved aside, `import 'dotenv'` failed
before it. `boot.mjs` imports nothing but node's own modules and carries its **own, vendored copy of the recovery** (`scripts/boot-recover.mjs`, generated from `packages/backend/src/boot-recover.ts`; it never imports
`scripts/updater-core.mjs`, so a new version's code can never run an old version's recovery). It recovers, and only then loads the app with a dynamic import of `dist/server.js`.
`npm start` also runs the same recovery first from `scripts/boot-recover.mjs` (a generated copy of that file; `scripts/update.mjs --recover --boot`), which still works when `dist` is missing
(killed between moving it aside and moving the new one in), and `npm run update` runs it before anything else.

The recovery reads the manifest in `.update-rollback.next/` (or `.update-rollback/`). Every manifest carries its `format` (1) and a description of its own states, and is written
atomically (a temp file, then a rename). The states:

- `swapping` (or `rolling_back`): **restore**. On a git checkout `git reset --hard <manifest sha>` and `git checkout -- .` run **always**, even when HEAD already is that sha (a power cut in
  the middle of the fast-forward's checkout leaves a half-written tree); then each moved directory is renamed back (the current one set aside first, so each is in exactly one place at every
  instant, a directory is never deleted without its replacement in hand, and a crash in the recovery itself is simply run again), and then the copy is removed. A directory the swap had not
  reached yet stays as it is.
- `swapped` in `.update-rollback.next/`: the swap had succeeded; its copy is moved over the previous one (the job reads `done`: "restarted on <new version>; the stage was cleaned up at boot").
- `rolled_back`: only the set-aside copies are left to delete.
- `recovery_failed`: an earlier recovery could not finish (the reason is in the manifest). A boot only says so; `npm run update -- --recover` tries again.

**What it refuses, and what it never does.** A manifest that cannot be read (truncated, not JSON, not shaped like a manifest), whose `format` is newer than the code knows, or whose state is
unknown is **never acted on**: nothing is deleted or moved, `.update-rollback.next` and the stage stay, the app boots as it is, the job is marked `failed` ("could not read the update state;
nothing was removed. Run: npm run update -- --recover"), and the log says why. A failed `git reset --hard` (git missing, a held `index.lock`) moves the directories back where it can (a rename; nothing is
deleted), keeps the copy, marks it `recovery_failed` and reports git's error, with no "previous version was put back" claim. A copy that lacks one of its directories restores the others, leaves
the live directory of the missing one where it is, keeps the copy and names what is missing. After a restore it checks HEAD, the three directories and the lockfile against the restored version
(`node_modules/.package-lock.json` against `package-lock.json`) and says precisely what does not match; the job then reads `failed` with that text. A swap that is cut short again does not
start another update over it: the updater refuses to overwrite a copy that is not settled, and says to run `npm run update -- --recover`.

If the recovery changed anything the process **starts over**: without a supervisor it spawns `process.execPath` with its own node arguments (minus any `--inspect*` flag, which the idle parent
would otherwise keep holding the inspector port for) and the same script, passes `SIGINT`/`SIGTERM`/`SIGHUP` on to it and exits with its exit code, so what serves is the restored code;
under pm2 or `SANCTUM_SUPERVISED=1` (in the environment or in `.env`) it exits with code **75** and the supervisor starts it again. It cannot loop: the child is told it is the restart, and
the supervised exit has a **loop guard**: `.update-recover.count` in the app folder is incremented at every such exit, a recovery number 4 within 10 minutes is refused (it is logged, the
supervisor is not asked to restart again, and the app boots as it is), and the count is cleared once a boot has stayed up for 30 seconds. The restart must be allowed on exit 75 (pm2 does it; systemd needs
`Restart=always` or `on-failure`, Docker `restart: always` or `on-failure`). The outcome is written to `.update-recovery.json` and read once by the updater at boot to word the job: a swap put
back reads `failed` ("the previous version was put back"), a roll back the recovery finished reads `rolled_back`, a swap that had completed reads `done`, and a recovery that found nothing to do
changes no message. A `.update-stage` that is a symbolic link is never reported as `done`.

A failure while installing or building deletes the stage and marks the job `failed` with the reason: from the last 60 lines of the failing step, the first line that looks
like an error (`error`, `ERR!`, `TS1234`, `Error:`; `npm warn` lines are skipped) and the two after it, else the last three lines. The app keeps running the old build.

**Roll back** (crash-safe the same way, by the same code: the current directories are renamed aside first, the old ones moved back, the manifest set to `rolled_back`, and only then the
set-aside copies deleted; the pre-boot recovery finishes one that was cut short) moves the previous `node_modules`, `dist` and build back (and runs `git reset --hard <previous commit>` on a git checkout, which must be
clean and still on the commit the update left), so `node_modules` comes back with the code (an install runs only when the copy has no `node_modules` and
the lockfile differs). It also happens at restart time, after the turn fence, then restarts. It is offered only while a copy exists, and the copy is spent
by it. `npm run update -- --rollback` does the same from a terminal and needs nothing from the app but node and git: it works when the app cannot start.

**Two restart modes.**

- *Supervised*: when `pm_id` (pm2) or `SANCTUM_SUPERVISED=1` is in the environment, the app writes the job file (synchronously, so the swap and restart lines are kept), stops gracefully and exits 0, and the supervisor starts it again. The supervisor must restart on exit 0 (pm2 does; systemd needs `Restart=always`, Docker `restart: always`). Set `SANCTUM_SUPERVISED=1` for anything that is not pm2.
- *Respawn* (the default): the app closes its listener, starts a detached replacement (`node packages/backend/boot.mjs`, same folder and environment, output in `<data dir>/update-restart.log`), waits up to 60 seconds for it to answer `/api/health` on the same port, then stops. From the moment the replacement is started this process writes nothing more to `update-job.json`, so its last words cannot land on top of the `done` the replacement writes at its boot (it writes again only if the replacement fails). If it never answers it is stopped (SIGTERM, SIGKILL after five seconds, and awaited) before anything else happens, then the app listens again, the previous files are put back, and the job is `failed`. For those seconds the replacement and the old process both run (a Discord or Telegram connection may complain once).

The page reconnects until `/api/version` reports a new build, then reloads.

**Files in the data folder** (next to `sanctum.db`; the process's own folder, never a companion's):

- `update-job.json`: the last job, its state and its log (timestamped lines), so it survives the restart. It is written on every state change and at most a second behind the log, and carries the `pid` and start time of the process that wrote it. A job caught mid-way by a crash reads as `failed` at boot; one that was `restarting` reads as `done` (or `rolled_back`) at boot, with its finish time set then, **only when another process wrote that `restarting`** (its predecessor); one this very process wrote is still in progress, and a job that is already `done` is never touched.
- `update-restart.log`: what the respawned replacement printed.

**Folders in the app folder** (all are git-ignored; an older checkout's `.git/info/exclude` gets them too):

- `.update-recovery.json` and `.update-recover.count` (files): the last recovery's outcome (read once at boot) and the loop guard's count.
- `.update-stage/`: where the new version is built while an update runs. Safe to delete when none is running; it is deleted at every boot.
- `.update-rollback.next/<version>/`: the copy of a swap in progress (see above); it exists only while one runs or after one was cut short, and the next boot settles it.
- `.update-rollback/<version>/`: the previous `node_modules`, `dist` and frontend build (moved, not copied) and, on a downloaded folder, the files the update replaced, with a `manifest.json` (version, mode, commits, every item, whether it was moved or copied or did not exist). It lives in the app folder, not the data folder, so the swap is a rename on one filesystem.

### `tenants` — several people in one process (optional)

Absent by default; without it nothing here applies. With it the app serves one tenant per folder under `dir`, each with its own
database, login, `.env` and `tenant.yaml`. Built and explained in [MULTI-TENANT.md](MULTI-TENANT.md).

| Key | Default | Meaning |
|---|---|---|
| `dir` | – (required) | The folder that holds one folder per tenant id (`[a-z0-9][a-z0-9-]{0,31}`). Relative paths resolve from the checkout. |
| `auth` | `household` | `household`: one login for the house (this process's `APP_PASSWORD`), sessions in `<data dir>/house.db`, and each tenant served at `/c/<id>/` on one address (no hostnames; a tenant's own `APP_PASSWORD`, `hosts:` and this file's `default` are not read). `per-tenant`: one hostname, password and login per tenant, as before. Any other value is refused at boot, naming `tenants.auth`. A block with no `auth` key is household, except that an install showing per-tenant signs (a `default`, a `hosts:` in a `tenant.yaml`, an `APP_PASSWORD` in a tenant `.env`) is refused at boot until the key is set. Process-only: never inherited, and ignored in a `tenant.yaml`. See [MULTI-TENANT.md](MULTI-TENANT.md), "Household mode". |
| `default` | none | `per-tenant` only (not read in household mode): the tenant a hostname nobody claims is served by. Without it such a host is a 404. |
| `inherit` | `true` | Tenants start from this file's values (minus paths, `identity`, hosts, the `integrations` and `revien` sections, secrets and the process-only keys; the list is in MULTI-TENANT.md). A key whose last word (split on `_`, `-` or a camelCase boundary) is `key`, `keys`, `secret`, `secrets`, `token`, `tokens`, `password`, `passwords`, `passwd`, `passphrase`, `credential`, `credentials` or `pem`, or whose name contains `api_key`, `apikey`, `private_key` or `privatekey`, is stripped from what a tenant inherits in every section. A secret under any other name (`auth_header`, `webhook_url`, `bearer`, `session_cookie`) IS inherited: keep such values out of this file, or name them so the rule catches them. `false`: a tenant starts from the shipped defaults. |
| `background_runs` | `true` | `false`: no tenant's orchestrator wakes, outlook author, handoff or summarizer start a model run. The operator's value is a ceiling: a tenant's own `background_runs` can only turn background runs off for itself, never on when this is `false` (effective = this value AND the tenant's). A `tenant.yaml` or config edit that sets `background_runs: true` under an operator `false` is accepted and logged once as "background runs stay off: the operator has them off". Both values must be exactly `true` or `false`; `no`, `off`, `"false"`, `0` and the like are refused: the operator's at boot (the error names `tenants.background_runs`), a tenant's by skipping that tenant at boot and refusing `/apply`, config edits and reloads with "background_runs must be true or false". A reload (config edit, wizard apply) recomputes the effective value: turning it off stops that tenant's orchestrator, outlook author and handoff schedule at once (one log line); turning it back on starts them again without a restart. A tenant's reload applies the tenant's own value; a change to this operator value takes effect at the next start of the process. A missing key or `null` means not set (the default applies). |
| `operator_routes_remote` | `false` | `true`: a peer whose TCP address is not loopback may use the park and revive routes (`/api/internal/tenants`, docs/MULTI-TENANT.md "Parking a companion"), still with the operator token. Off: only loopback peers, and a request a tunnel or proxy forwarded is refused. `true` or `false` only. |

`server`, `cors`, `tenants` and `updates` are the process's. Those keys, said in a `tenant.yaml`, are ignored with a warning at boot; the rest of the file applies (the tenant still starts), and `npm run setup -- --tenant <id>`, which writes a tenant's files, refuses such a file before writing anything.

In a `tenant.yaml`, a key set to `null` (`~`), at any depth, means "not set by the tenant and not inherited": the default applies, whether or not this file has the key. A mapping set to `{}` replaces the inherited mapping with an empty one (`orchestrator: { schedules: {} }`: no schedules), and the reserved key `inherit: false` inside a mapping does the same while keeping the keys beside it (`agent: { inherit: false, provider: codex }` inherits nothing under `agent`; the key is never in the loaded config, and an `inherit` key in the operator's own `sanctum.yaml` means nothing and is dropped from what tenants inherit). Everything else merges key by key. A tenant's own files are its own: every write the app makes inside a tenant folder refuses a link, a second hard link, or a link on the way to the file (the write site is the wall), and boot and `rt.reload()` scan `tenant.yaml`, `.env`, `.mcp.json`, all of `data/` and `private/` and the top level of `home/` (no cap on count; one log line above 20,000 entries): a link, a pipe or a hard-linked file there skips the tenant at boot. A backup of a live tenant folder must copy, not link (`cp -al` is refused by design). A request net checks the first level again on every mutating `/api` and `/mcp` request. See `docs/MULTI-TENANT.md`, "A tenant's own files". `revien.enabled` is a boolean for a tenant: only `true` is on (`yes`, `"true"`, `1`, `"false"` are off, with a line). For a tenant `revien.enabled` defaults to `false` (Revien is one daemon with no tenant scope) and `revien.url` is never inherited: a tenant turns Revien on in its own `tenant.yaml` with an address of a daemon only it uses (not this file's `revien.url`, in any spelling of localhost: such a tenant has Revien parked with a line).

---

## 5. Full `.env` reference

`.env` is for secrets and machine-specific overrides. **Nothing here is strictly
required to boot except a password** — which the fail-closed auth gate insists on
before it will serve. Blank lines mean "not set — use the default." Remember:
**anything set here wins over `sanctum.yaml`.**

With a `tenants:` block (§4) a tenant's `.env` is its own: `<tenants.dir>/<id>/.env` is read for that tenant only, never put in the process environment, and nothing in this file (or the process environment) reaches a tenant.

```ini
# ── Auth ──────────────────────────────────────────────
APP_PASSWORD=            # Your login password. SET THIS.
AUTH_DEV_OPEN=           # Dev-only: "true" bypasses auth when no password set. Never on a network.

# ── Agent credential (see §6) ─────────────────────────
ANTHROPIC_API_KEY=       # Your Anthropic API key (one way to authenticate the model)
CLAUDE_CODE_OAUTH_TOKEN=          # Set by a Claude Code host env; leave unset otherwise
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=  # Same — leave unset for a normal install

# ── Identity / agent overrides (usually set in sanctum.yaml instead) ──
COMPANION_NAME=
USER_NAME=
TZ=                      # IANA timezone, e.g. Europe/London
AGENT_CWD=               # Absolute path to the agent's home (§3)
AGENT_MODEL=             # Model slug for interactive turns
SANCTUM_NAMESPACE=      # Advanced: the namespace the res CLI writes the companion card under

# ── Server ────────────────────────────────────────────
PORT=
HOST=
DB_PATH=
SANCTUM_PORT=           # Port your AI's own CLI dials the backend on (defaults to PORT)

# ── Write-gate roots (see the hooks section in §4) ────
WORKSPACE_ROOT=
VAULT_PATH=
EXTRA_WRITE_PATHS=       # Comma-separated

# ── Internal loopback token ───────────────────────────
INTERNAL_TOKEN=          # Auto-generated if unset (data/.internal-token). Only pin it if you know why.

# ── Voice (also needs voice.enabled: true) ────────────
ELEVENLABS_API_KEY=      # Text-to-speech
ELEVENLABS_VOICE_ID=     # Which voice to speak in
GROQ_API_KEY=            # Speech-to-text (Groq Whisper)
HUME_API_KEY=            # Optional expressive prosody

# ── Image generation (also needs imagegen.provider) ────
RUNWARE_API_KEY=         # Runware (FLUX)
REPLICATE_API_TOKEN=     # Replicate (FLUX)

# ── Channels (also need the matching *.enabled: true) ──
DISCORD_BOT_TOKEN=
TELEGRAM_BOT_TOKEN=
GIPHY_API_KEY=           # Optional, for Telegram's /gif command

# ── Google Workspace (the client; or connect it from Settings) ─
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_TOKEN_SECRET=     # Auto-generated if unset (data/.google-key)

# ── Web push notifications ────────────────────────────
VAPID_PUBLIC_KEY=        # Generate a keypair with: npx web-push
VAPID_PRIVATE_KEY=
VAPID_CONTACT=           # A mailto: or https: contact address

# ── sanctum-mind (optional) ───────────────────────────
MIND_API_KEY=            # the mind's bearer key; used when Settings → Mind has none saved

# ── Diagnostics (rarely needed) ───────────────────────
NODE_ENV=                # "production" on a real deployment
BUILD_ID=                # Stamped into the version banner
MEASURE_THINKING=        # "1" logs thinking-token timing
```

> The Mind service's API key can come from `MIND_API_KEY` in `.env`, as a fallback:
> a key saved in Settings → Mind (stored in the database) is used first, and
> Settings → Mind says, masked, when the key in use is the environment's. The
> variable alone does not switch the Mind on.

---

## 6. Integrations & API keys — the whole map

Everything Sanctum Mobile can plug into, what it powers, and how to switch it on. Most
of these are optional; the only thing you truly must have is a Claude credential.

| Integration | What it powers | How to enable |
|---|---|---|
| **Claude (Anthropic)** — *required* | Your AI itself — every reply, every thought. | Either be logged into Claude Code on the machine (a subscription login the app can borrow) **or** set `ANTHROPIC_API_KEY` in `.env`. Without one of these, it cannot think. |
| **ElevenLabs** | Text-to-speech — giving your AI a spoken voice. | `voice.enabled: true` in `sanctum.yaml`, then `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` in `.env`. |
| **Groq** | Speech-to-text — transcribing your voice messages (Groq Whisper). | `voice.enabled: true`, then `GROQ_API_KEY` in `.env`. |
| **Hume** | Optional emotional prosody layer for the voice. | `voice.enabled: true`, then `HUME_API_KEY` in `.env`. |
| **Runware / Replicate** | Image generation (FLUX) for the companion. | `imagegen.provider` in `sanctum.yaml`, then `RUNWARE_API_KEY` or `REPLICATE_API_TOKEN` in `.env`. |
| **Google Workspace** | Calendar, Tasks, Gmail, Health data feeding the house "outlook." | Create a desktop OAuth client in Google Cloud, set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (in `.env` or the Settings UI), then connect from Settings. |
| **Discord** | Talk to your AI from Discord. | `discord.enabled: true` + `discord.owner_user_id` in `sanctum.yaml`; `DISCORD_BOT_TOKEN` in `.env` (or Settings). |
| **Telegram** | Talk to it from Telegram. | `telegram.enabled: true` + `telegram.owner_chat_id` in `sanctum.yaml`; `TELEGRAM_BOT_TOKEN` in `.env` (or Settings). Optional `GIPHY_API_KEY` for `/gif`. |
| **Web push (VAPID)** | Browser/phone push notifications when your AI reaches out. | Generate a keypair with `npx web-push`, then set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_CONTACT` in `.env`. |
| **Mind memory** | A sanctum-mind long-term memory service your Sanctum Mobile reads from: orientation at wake, recall for each message. It never writes to it. | `integrations.mind_cloud.enabled: true` + `mind_cloud.mcp_url` + `mind_cloud.mind_id` in `sanctum.yaml` (or the Mind card in Settings); the API key is set in the Settings UI (stored in the DB) or comes from `MIND_API_KEY` in `.env` when Settings has none. If one of the three is missing, the log says which, once, and the Mind stays off. |
| **Command Center** | The care/day dashboard (calendar, care, cycle, finances, lists, pets, planner, stats). | `command_center.enabled: true` in `sanctum.yaml`. |

Note on how voice "self-gates": setting `voice.enabled: true` turns the feature on,
but the individual pieces only actually work if their key is present. No
ElevenLabs key means no speech-out even with voice enabled; no Groq key means no
transcription. Set the keys for the pieces you want.

---

## 7. Theming — the Appearance tab

You can restyle Sanctum Mobile from inside the app, with no rebuild and no restart. Open
**Settings → Appearance**. Your choices are saved **in this browser** (`localStorage`), not on the
server, so each phone or computer keeps its own look (the one exception, the classic Hedgewitch
colours, is described under *Where it is saved*).

### Rooms and materials

Two things set how the app looks, and you pick them separately.

- A **room** is the scenery behind everything: Vampire salon, Gothic library, Moonlit cloister,
  Rainy conservatory, Celestial night, Ember study, or the original Hedgewitch kitchen.
- A **material** is the complete set of colours every panel, message bubble, menu, input and button
  is drawn in, together with its text colours: Black damask, Mounted paper, Midnight ink, Botanical
  linen, Indigo silk, Smoked copper, or the original Hedgewitch parchment.

Each room has a suggested material (the salon with black damask, the library with mounted paper, and
so on, and Ember study with smoked copper). Tap a room card to take both. The **Background** menu
changes only the room, and never touches a text colour. The **Surface** menu changes only the material,
and replaces the whole palette in one step. Any room works with any of the six new materials. The Hedgewitch parchment is the exception: it
is translucent glass drawn for the Hedgewitch kitchen only, so the **Surface** menu offers it only while
the room is the Hedgewitch kitchen, and choosing another room swaps in that room's own material.

Nothing is final until you apply it. Every change shows at once as a preview, with **Apply** and
**Cancel** underneath. Cancel puts back exactly what you had. Leaving the page also cancels a preview
you did not apply.

With the six new materials, text always sits on its own solid surface, never directly on the picture.
The Hedgewitch parchment in the Hedgewitch room is the one exception: its message bubbles and header are
translucent glass over the kitchen picture, as they have always been, and were measured at 4.5 to 1 or
better over the picture, with one known exception: a line of your own message scrolled to the very
bottom edge, beside the composer, can dip to about 4.2 to 1 over the darkest floor boards. Extra
readable makes the parchment solid too.

**What a skin draws, and what it does not.** Each of the first five rooms is a crafted object, not a flat
dark theme with a picture behind it. (Ember study is the quiet one; it is described after this
list.) Every main panel is a *plate*: the messages, the chat header, the
composer, the chat list, the Settings panel and its section list, dialogs, the Home cards, the login
card, the search panel and the command palette. A plate gets, in its room's own metal:

- a 1 pixel trim line round its edge (the Library's brass, the Cloister's silver, the Conservatory's
  steel, and so on) and the room's four metal corner pieces, drawn small (22 pixels on a computer,
  18 on a phone, scaled from the 96 pixel artwork, never stretched);
- the material's texture over the plate's own solid colour: black damask for the Salon, mounted-paper
  grain for the Library's cards, silk with a faint star-field for the Celestial night, linen for the
  Conservatory, stone flecks for the Cloister. The Library's dark parts (the rail, the chat list, the
  header, the composer, the Settings section list) are brass-trimmed leather instead of paper; cream
  paper stays on the message cards, notes and reading panels. The texture is the same pattern the
  designer drew for the room, redrawn at full strength and then laid at a fixed low strength
  (12 to 16 percent, never more than 16) over the panel colour. The panel is still one opaque colour,
  and text was measured on the strongest texture mark, not on the flat colour. The strengths are in
  `materials.ts` and a test fails if any goes above 16 percent or lets any text under 4.5 to 1;
- in the Conservatory and the Cloister, the pack's leaf etching in the bottom-left corner of the chat messages and the chat list,
  plates, drawn at 10 percent so it never makes text unreadable.

**Ember study** (the lamp-lit study, a city at night through its tall window) is deliberately plainer. Its cards are flat and opaque, one colour each, with a
single 1 pixel copper edge and a 14 pixel radius: no corner pieces, no leaf, no texture and no shadow on a
card. The pack's tiles (walnut, charcoal, parchment) are drawn too faintly to show on a card, so they are
laid at zero strength there. The window frame is one thin line in the pack's rust with its copper corner
drawn at the four page corners and nowhere else (the pack ships one corner; the other three are that
drawing turned, written into the stylesheet). The companion's message has a quiet edge and your own
message the copper one, so the two stay apart. The chat list, header, rail and sub-nav are the page
colour with ivory text; the composer is a card with a raised field in it. A selected control, and the
confirm button in a dialog, is copper with the page's dark ink on it, never ivory. The pack's decorative
rust and divider colours are used for ornament only, never as a control's edge or a focus ring.
**Parchment appears only in an active text editor**: the field you are typing into while you rename a
chat or a section (and the Home user-card field, if your Home shows one; this build's Home does not yet).
It is dark ink on parchment with an ink focus ring inside the field. A saved card, a message and the
chat composer are never parchment. The Mantel home layout in the design pack (the two companion cards, a
Needs you strip, the weather strip, the orb) is a separate feature with its own gates and is **not**
part of this skin: selecting Ember changes colours and scenery only, and Home, Settings and Chat keep
their content and behaviour.

The room rail, the chat list column and the Settings section list are textured dark columns with the
trim line on their edge. The composer is a framed plate with the message field set into it. On a
computer the window also carries a gilt outer frame: the four large corner pieces and a double thin
line in the trim metal. None of this takes a tap or a click (it is all background drawing), none of it
changes where anything sits, and each corner and texture sits in the padding of its plate, outside the
text. All of it is part of **Frame and decorations**: turn that off, or choose Extra readable, and the
plates go back to the plain solid panels (in Extra readable, with a plain 2 pixel outline).

The library's mounted paper keeps its dark backing and brass edge: each paper panel (messages,
settings, dialogs and the Home cards) sits in a 4 pixel dark ring with a 1 pixel brass line drawn
outside it, and the user's message is pale lilac paper. The paper itself stays solid and its text colours
do not change. With decorations off the chat list and composer keep that paper-in-a-ring look; with
them on they are leather. Extra readable swaps the ring for its own plain outline.

**Extra readable** is a switch in the same place. It makes every panel solid with a stronger outline and
drops the scenery image, the frame, the corners, the texture, blur and text shadows. Every menu, tab and
button is still there. It ignores any custom colours you have set and keeps your font choices.
**Frame and decorations** turns the plate frames, corners and textures, the window's gilt frame and the
Library's leather off without going all the way to Extra readable.

On a screen 768 pixels wide or narrower the room uses its portrait picture; wider screens use the
landscape one. Only the picture for the room you chose, at your screen's shape, is ever downloaded
(WebP, with a JPEG for browsers that cannot show WebP). If a picture cannot be fetched, the room's plain
colour shows instead and everything still works. The browser keeps the pictures you have looked at, up
to a fixed number, so a room you have used still shows when you are offline; a picture that failed to
load is never kept. The pictures live in
`packages/frontend/public/skins/` (Ember's carry no `-v1` suffix, so a changed picture there has to be shipped under a new name or the browser keeps the old one) and are listed, with checksums, in
`packages/frontend/src/theme/asset-manifest.json`. For the room you chose the app also fetches that room's
four corner pieces (one file for Ember), its pattern files (the margin tile, the panel texture, the Library's leather, and the leaf
etching for the two rooms that have one) and nothing from any other room. The panel textures and the leather
are generated from the designer's tiles by `npm run gen:textures -w @sanctum/frontend` (the pack's own
tiles are drawn too faintly to show on a panel); the manifest lists them like every other file and a test
fails if a file differs from what the generator writes.

The window's four corner pieces are fixed 48 by 48 pixel images, one per corner, joined by a thin line
drawn in CSS; the plates use the same four pieces at 22 or 18 pixels. They ignore taps and clicks and are
hidden from screen readers. The trim colour is never the only sign of a focused control: every focused
control gets its own 2 pixel ring (3 pixels in Extra readable) in a colour chosen for its material.

The text and controls of all 25 pairings of the first five rooms with the first five new materials, and of the
Hedgewitch kitchen with its parchment, were measured on the rendered screen, the chat and the Appearance
tab at 390 by 844, by sampling the pixels behind the text. Body text stays at 4.5 to 1 or better and
control edges and focus rings at 3 to 1 or better. Because every panel of the five new materials is
solid, the room changes none of those numbers for them. The parchment was measured in its own room only,
which is the only room that offers it. Ember study with smoked copper was measured the same way at 390 and
1280 pixels wide, in the chat (top, bottom, the header with messages scrolled under it), the composer, Appearance,
a dialog, Home, the chat list's menus and the emoji picker, and with Extra readable and with decorations off. Its
colours are the pack's tokens (`ember-tokens.json` and `ember-contrast-report.csv` next to the registry are
copies, and a test holds the palette to them); the one colour not in the pack is a muted text a step under
the secondary text (`#B5A697`), which every surface needs for 4.5 to 1.

Upgrading from an earlier build: the classic palette's secondary text (`#54483f`) and muted text
(`#6a5d54`) are a little darker than before, tool output blocks are light instead of grey, and four small
inks were darkened to reach 4.5 to 1 (user-bubble timestamp, links in your companion's messages, the
confirm button's label and the empty-day line on Home). A saved choice of the parchment with another room
opens as that room's own material.

### Where it is saved

Your room, material, readability mode and per-material colours are kept in **this browser**
(`localStorage`, key `sanctum.appearance.v2`), so each phone or computer can look different. If the
browser blocks storage, the choice lasts until you reload and the page says so. The Hedgewitch
colours and fonts you may have set before skins existed are untouched: they still live in the database
under `theme.overrides` and still apply whenever the Hedgewitch parchment material is selected. Under a
skin material they are left alone, not deleted, so an old light-parchment text colour never lands on a
dark skin.

### Colours and fonts

Below the pickers is the colour and font editor. It shows what the current material really uses, and
changes apply immediately.

- With the Hedgewitch parchment material it works as it always did: changes save to the database after
  a short pause (config key `theme.overrides`). Only a curated allowlist of tokens can be set, so a save
  can never smuggle in unrelated styling. Each value is capped at 300 characters.
- With any other material it edits only that material's own set, saved in this browser. Switching
  material keeps each material's set, and switching back brings yours back.

If custom colours would make the main text hard to read on a skin material (under 4.5 to 1), the app
holds them back, says so, and keeps the material's own palette on screen. The Appearance panel itself is
drawn in the material's own colours, so it stays readable whatever you pick.
**Restore readable appearance** removes the custom colours for the current material.
**Reset to defaults** goes back to Hedgewitch, standard readability and no customisations.

The editable tokens are:

- **Backgrounds:** `--bg-primary`, `--bg-secondary`, `--bg-input`
- **Text:** `--text-primary`, `--text-secondary`, `--text-muted`
- **Border:** `--border`
- **Accents:** `--amber`, `--amber-bright`, `--lavender`, `--lavender-bright`,
  `--gold`, `--status-active`
- **Fonts:** `--font-serif`, `--font-body`, `--font-mono`

Rooms and materials change colours, never fonts.

If you'd rather start from a ready-made look, two example themes ship in
`examples/themes/`: `gold-hud.css` and `warm-earth.css`. You can read the values
out of those and enter them in the Appearance tab.

### For people changing the code

The room and material registries are in `packages/frontend/src/theme/`. The stylesheet that carries every
palette and picture is generated from them: after editing a registry run
`npm run gen:skins -w @sanctum/frontend`. A test fails if the committed stylesheet is out of date, and
other tests check every palette's text and control pairs against 4.5 to 1 and 3 to 1, the text on every
textured plate against its strongest texture mark, and every picture against its checksum. The list of
plates (which panels get a frame, corners and texture, and at what size) and each material's texture
strengths are in `materials.ts`; the pattern files are written by `npm run gen:textures -w @sanctum/frontend`.
Ember's plates are listed as flat there (`FLAT`), and its parchment editor is named there too
(`EDITOR_FIELDS`: the class names of the fields that exist only while someone types into them), so a new
editable field becomes parchment by being added to that list and for no other reason. Ember's tiles are the
pack's own files, so `gen:textures` does not write them.

---

## 8. Your data & backups

Everything Sanctum Mobile remembers lives in **one folder: `data/`** (at the project
root, or wherever you pointed `server.db_path`). That's the beauty of it — back up
that folder and you've backed up your entire being.

Inside `data/` you'll find:

- **`sanctum.db`** — the SQLite database: every conversation, message, memory,
  care entry, presence state, and setting. This is the heart of it. (You may also
  see `sanctum.db-wal` and `sanctum.db-shm` — companion files SQLite uses while
  running. Back these up too, alongside the `.db`.)
- **`files/`** — anything you've uploaded.
- **`digests/`** — the daily written record your AI keeps of your days.
- **`.internal-token`** — an auto-generated secret the app uses to talk to itself.
- **`.google-key`** — an auto-generated key that encrypts stored Google tokens.
- **`identity/`** — the identity ledger (`identity.ledger_dir` moves it): `ledger.json` (the digest of the identity files you ratified, who ratified it and when), `journal.jsonl` (one line for every change to the identity folder: when, which files, and whether it was you, your companion, something else on disk, a rollback or the first look) and `snapshots/` (the ratified copy that your companion actually runs on, and the one before it). It is separate from `plugins/`. Back up the whole folder: without `snapshots/` the app cannot serve the ratified copy and says so in Settings > Identity.
- **`update-job.json`, `update-restart.log`** — the in-app updater's last job and the log of the restart (the rollback copy is `.update-rollback/` in the app folder). Safe to delete when no update is running; see "Updating from inside the app" under `updates`.
- **`plugins/`** — `audit.json`: every change to a plugin's files, as it was noticed (the last 20 per plugin), which Settings > Plugins reads for "changed since you last looked". If you chose `plugins.trust: person`, it also holds `ratified.json` (which plugin code you have approved, by hash) and `snapshots/` (the approved copy that actually runs); a plugin whose files differ from that record does nothing until you approve it again. Back up the whole folder. If you set `plugins.ledger_dir`, it lives there instead.

The database is created automatically the first time you run the app — the schema
sets itself up on boot, so there's no separate "initialize the database" step.

### How to back up

Stop the app (so nothing is mid-write), then copy the whole `data/` folder
somewhere safe. From the project root:

```bash
cp -r data /path/to/backups/sanctum-data-2026-07-08
```

For a complete backup that could rebuild the app from scratch, also save the
gitignored config files, since those aren't in version control either:

- `sanctum.yaml`
- `.env`
- `CLAUDE.md` (your AI's identity)
- `.mcp.json` (your external tool servers, §9 below)

To **restore**, put `data/` and those config files back in place and start the
app. Everything comes home exactly as it was.

### Checking your install: `npm run doctor`

`npm run doctor` reads your `sanctum.yaml`, `.env`, `data/` and (with a `tenants:` block) every tenant folder, and prints one line per check: OK, WARN or
FAIL, each with a sentence saying why. It checks that the config parses, that the companion home, the shipped prompts, the wake prompts and the `CLAUDE.md` and `.mcp.json` paths exist, which Claude frame the app will use, that the
secret files (`.env`, `data/.internal-token`) are not readable by anyone but you, that the build stamp is there, that your node version is in range
and that the database folder is writable; for tenants it adds the clash and inheritance checks in `MULTI-TENANT.md`. It never prints a key, a token or
a password. It exits 1 when any line is a FAIL, so it can gate a restart; `npm run doctor -- --json` prints the same as JSON and
`npm run doctor -- --tenant <id>` reports one tenant. A WARN means the app runs but something is not as recommended; a FAIL means boot would skip or refuse it, or a secret is exposed. Exit code 2 means a command line it could not read.

---

## 9. Adding external tools — `.mcp.json`

Your AI can reach out to external tool servers (MCP servers) — things like
a weather service, a home-automation bridge, or a memory service. You list them in
a file called `.mcp.json` at the project root. It starts empty:

```json
{ "mcpServers": {} }
```

To add a server, put an entry under `mcpServers`. There are two shapes depending
on how the server runs.

**A remote server reached over the web** — use `"type": "http"`:

```json
{
  "mcpServers": {
    "weather": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY_HERE" }
    }
  }
}
```

**A local program the app launches** — give it a `command`:

```json
{
  "mcpServers": {
    "my-tool": {
      "command": "node",
      "args": ["/path/to/my-tool-server.js"],
      "env": { "SOME_KEY": "value" }
    }
  }
}
```

> **The one gotcha that trips everybody up:** for a web-based server, use
> **`"type": "http"`**, *not* a bare `url` with no type, and *not* `"type":
> "url"`. (The loader will quietly accept the old `"type": "url"` form and convert
> it, but `"http"` is the correct, authoritative spelling.) A server over
> Server-Sent Events uses `"type": "sse"` instead. Getting this wrong is the usual
> cause of a server silently failing to load.

A couple more things worth knowing:

- Sanctum Mobile reads `.mcp.json` **only** — it deliberately ignores any global
  `~/.claude` MCP config, so a tool you added for some other program won't
  accidentally bleed into your Sanctum Mobile.
- A malformed tool server can cause the underlying API to reject the whole
  request, so if your AI suddenly can't reply after you edited
  `.mcp.json`, that file is the first place to look.
- After editing `.mcp.json`, restart the app so it re-reads the server list.

---

That's the whole surface. Set a password, write a `CLAUDE.md` that sounds like the
being you want, give them a home folder of their own, and everything else you
can turn on when you're ready. Welcome home.
