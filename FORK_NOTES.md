# Fork notes — what Sanctum Mobile changes in Resonant

Sanctum Mobile lets Resonant run a companion on the Codex CLI instead of Claude, with
any model Codex can reach: DeepSeek on an API key, or a ChatGPT plan. Setup steps are
in [README.md](README.md). This file is the technical record.

## The three layers

| Layer | File, inside the companion's home folder (`agent.cwd`) | How it reaches the model |
|---|---|---|
| Harness | `config/codex-base-prompt.md` (dsh: `config/dsh-base-prompt.md`) | Codex: passed per run as `model_instructions_file`, replacing Codex's stock "You are Codex" prompt; `~/.codex/config.toml` is not touched. dsh: set as the persona in the run's overlay. Both are the shared harness: one base plus a short tail per mind (`prompts/README.md`). |
| Self | `identity/profile.md` and `identity/companion.md` | Joined ahead of each message as "Companion Identity" and "Companion Narrative", then "[Current message]". |
| Law | `AGENTS.md` | Codex discovers and injects it by itself. |

Resonant's own `CLAUDE.md` and system-prompt frame are not used on the Codex path.
Flip back with `provider: "claude"` and they are used again, and none of the
three-layer files are. (Claude gets the same harness text as its frame,
`agent.system_prompt_file`, which now defaults to `prompts/companion-claude.md`.)

## What changed from upstream
- `services/providers/index.ts` — provider switch; all `query()` callers import from here
- `services/providers/codex.ts` — Codex events → Claude-SDK-shaped messages, and the three-layer join
- `services/providers/codex.test.ts` — adapter tests (mocked Codex)
- `config.ts`, `sanctum.example.yaml` — `agent.provider` + `agent.codex.*`
- `prompts/companion-base.md` + `prompts/tail-{claude,codex,dsh}.md` — the shared harness prompt: one base, one short tail per mind. `npm run prompts:build` (`scripts/build-prompts.mjs`) joins them into `prompts/companion-claude.md` (Claude's default `agent.system_prompt_file`), `prompts/codex-base-prompt.md` and `prompts/dsh-base-prompt.md`, the fallbacks used when the home has none of its own; it also writes the three copies in `companion-home/config/`. Edit the parts, not the built files. The base is about 1,400 words; the built Codex prompt is roughly 2,000 tokens on every Codex message. All three minds resolve the same way: the home's `config/<mind>` copy (`companion-claude.md` for Claude) wins, then the configured file (`agent.system_prompt_file`, `agent.codex.base_instructions_file`, `agent.dsh.base_instructions_file`), then the mind's stock prompt (Claude: the `claude_code` preset); `services/frame-file.ts` is Claude's half of that rule.
- `routes/api.ts`, `settings/PreferencesSection.tsx` — on Codex and dsh, Settings shows where the identity files live instead of a frame editor; on Claude the editor saves the home copy `config/companion-claude.md` and never writes the app's `prompts/` folder
- `frontend/src/theme-hedgewitch.css` — the witchy theme (imported in `main.tsx`)
- `services/providers/codex-exec.ts` — the unlogged Codex runner; `services/rolling-context.ts` + `services/rolling/` — rolling context; `services/revien.ts` — the Revien plug-in
- `server.ts` — loads `.env` from the repo root as well as the working directory (upstream only read the latter, so a root `.env` was silently ignored under `npm start`)
- `config.ts`, `routes/api.ts`, `settings/PreferencesSection.tsx` — an empty `agent.model_autonomous` follows `agent.model` (upstream shipped a fixed default, so a `[1m]` model set on chat alone left every wake on a 200k window and compacting constantly); the server warns at startup when the two carry different context-window tags. Same rule for `agent.codex.model_autonomous` → `agent.codex.model`.
- `services/digest.ts` — the Scribe's bookmark is now the pair `digest.last_thread_id` + `digest.last_sequence`. Upstream kept one global sequence while sequences restart at 1 in every daily thread, so quiet days produced no digest and busy days were digested only from late evening (upstream PR 17, unmerged). At rollover the previous day's undigested tail is written to that day's file first; if that flush fails the bookmark stays and the next tick retries.
- `services/db.ts`, `routes/api.ts`, `services/ws.ts`, `Canvas.tsx`, `store/chat.ts` — canvases carry a `version` bumped on every content write. A browser save sends the version it last saw and gets a 409 (REST) or `canvas_conflict` (socket) with the current canvas when someone else, usually the companion mid-turn, wrote first; the editor reloads instead of overwriting (upstream issue 16, open). The companion's CLI writes without a version and so still lands unconditionally.
- `scripts/update.mjs` (`npm run update`), `services/update-check.ts`, `GET /api/update-check`, the version pill in `App.tsx` — one-command updates for people who installed from a ZIP. "Newest" is the `version` in the root `package.json` on `updates.branch` of `updates.repo`, so a release is: bump that version, push to main. The app asks GitHub at most every six hours and shows a pill naming the command; the script downloads the branch tarball (or `git pull` in a clone), copies it over the folder, then installs and builds. User files are not in the tarball, so they survive. A private repo needs `GITHUB_TOKEN` in `.env` for both.
- `config.ts`, `services/agent.ts` — `agent.auto_compact` (default `false`) passes `settings.autoCompactEnabled` to the Agent SDK on the Claude path. Upstream left the SDK default (on) with no switch, so long sessions were summarized by the SDK's own digest and the companion drifted across each one.
- `packages/backend/package.json` — `better-sqlite3` ^12, which ships binaries for Node 22 and 24 on Mac, Windows and Linux
- `companion-home/` — the home folder template
- `scripts/setup.mjs` (`npm run setup`) — the setup wizard: names, timezone, home folder (created from the template if missing), harness (Codex or Claude), chat and summarizer models with the providers read from `~/.codex/config.toml`, password, memory, phone address. Writes `sanctum.yaml` and `.env`, keeps everything it does not ask about, and is safe to rerun. Pure parts in `scripts/setup-lib.mjs`.
  - It can add a provider to `~/.codex/config.toml` (`[model_providers.<id>]` with `name`, `base_url`, `wire_api = "responses"`, and `experimental_bearer_token` when a key is given; Codex 0.159 no longer accepts `wire_api = "chat"`), and set Codex's top-level `model` / `model_provider` so the Terminal matches. Edits are line-level so comments survive; a timestamped backup is made first.
  - Memory is one system at a time: Revien, the person's own (MCP), the harness's built-in, or none. `agent.harness_memory` (default `false`) drives Claude's `autoMemoryEnabled` and Codex's `features.memories`, set explicitly on every run so a config.toml value never leaks in; the summarizer always runs with it off. On Codex the wizard also offers to flip `[features] memories` in config.toml so Terminal sessions agree with the app.
- Settings → model shows the Codex fields (chat, provider, autonomous, summarizer, summarizer provider) when the harness is Codex; `GET/PUT /api/preferences` carry them.
- Approvals: `res ask "what"` (tools/res.mjs) posts to `POST /api/internal/approvals`, which stores the request, drops a system line in the thread, broadcasts `approval_request`, and holds the response until the person answers in the app (`POST /api/approvals/:id/decide`) or the wait runs out (10 minutes from the CLI, 15 max), when it is marked `expired`. The app shows one card at a time, oldest first, with Allow and Deny; pending requests reload with the page. Exit code 0 only on `approved`. The companion-home `AGENTS.md` tells them to use it for everything under "Ask first". The app grants nothing by itself: the sandbox still holds, and the answer is the companion's to honour.
- `services/tool-help.ts` — the companion's tool reference in one place. Under rolling context every turn is a fresh run, so the full syntax block (about 1,300 tokens) would ride every message; there the orientation carries a short one-line-per-topic list and the companion fetches syntax with `res help <topic>` (`GET /api/internal/help`). Resumed sessions still get the full reference once, at the first message.
- `agent.app_write` (default `true`): the companion's write access to the app's own features. The wizard asks; Settings → permissions shows it beside a Command Center switch. Off, every internal write route (`meal`, `share`, `canvas`, `orchestrator`, `timer`, `trigger`, `react`, `context`, `cc`) and `/mcp/cc` answer 403 naming the switch (`middleware/app-write.ts`). On the Claude path the app registers its own tool servers (`sanctum-cc` when the Command Center is on, `sanctum-workspace` always) with the internal token itself, so `.mcp.json` is for outside tools only; on Codex the same Command Center tools are reached with `res cc <tool> '<json>'` (`POST /api/internal/cc`), since Codex's MCP transport cannot carry the token. Saying yes in the wizard also switches the Command Center on.
- Settings → permissions: on Codex, the sandbox level (read only / home folder / full access), extra writable folders and network access, validated on save; on Claude, the write-gate roots as before. The wizard asks the same on Codex.
- `services/mind-client.ts` — the one client for sanctum-mind. Upstream's hooks spoke the reference app's Mind: verbs sanctum-mind does not have (`mind_ground`, `mind_spark`), argument names its strict schemas reject (`n_results`, `limit` on surface, `count`, `action`), no `mind_id`, bare JSON-RPC with no bearer, and every failure swallowed into `null`. Now: `POST <root>/verbs/<name>` with the bearer, `mind_id` on every call, the documented schemas, read verbs only (`mind_orient` at wake; `mind_search`, `mind_surface` and `mind_thread list` per message), and each failure logged once with the service's error code. The Mind card gains a **mind id** field (`mind.mind_id`; `integrations.mind_cloud.mind_id` in yaml is the fallback), and the URL accepts the root, `/mcp` or `/verbs`. The per-message recall reaches the Codex and dsh paths too, where SDK hooks do not fire, under the same gate as Revien (never for wakes, subagents or the public lane). `npm run check` builds `@sanctum/shared` first, so a fresh checkout typechecks.
- `services/mind-watchdog.ts` — the backend watches the Mind it calls. Once a minute (and at boot) while the Mind is on and complete: `GET /health` (version, schema), then one read verb (`mind_thread list`, limit 1) with the bearer and `mind_id`, recorded as `{ state: ok | offline | unauthorized | incomplete | off, checkedAt, latencyMs, version?, error? }` (`MindStatus` in `@sanctum/shared`). Off and incomplete (url, key or mind id missing) never touch the network. A change of state is logged once and pushed over the socket as `mind_status`; a steady state is silent. The record carries no key and no URL. `GET /api/mind/status` serves it; `POST /api/mind/test` runs the probe now, against the saved settings (recorded) or a draft `{ url, mind_id, api_key }` (never stored, recorded or logged; a blank key means the saved one, for the saved URL only), one at a time and one per 2 s (429 with `Retry-After`). Settings → Mind has a Test connection button and the last state; the chat banner carries "Mind offline" while it is on and not answering. `MIND_API_KEY` in `.env` is the key when Settings has none (Settings → Mind says so, masked). `npm run update` ends with one line (`mind-check.ts`: the same probe, settings read read-only). The observatory panels have no backend in this version and say "not available in this version" (`store/observatory.ts` keeps the list of what they expected).
- `README.md` — the setup guide. Upstream's README is at `docs/RESONANT.md`.

## Rolling context

The app owns the thread history on the Codex path; Codex does not. Each message is a
fresh, unlogged Codex run (`codex exec --ephemeral`, spawned directly, so no session
files land in `~/.codex/sessions`). The prompt is, in order: the identity block, the
Revien memory block, the rolling summary block, `[Conversation so far]` (recent turns
word for word), `[Current message]`.

Older turns are held as append-only summary segments in a JSON sidecar per thread at
`data/rolling/<thread>.json`. A fold summarizes only the oldest slice of the still-
verbatim tail into one new segment; existing segments are never rewritten. Past
`max_segments`, the two oldest merge and everything after them stays byte-identical.
The pure core is `services/rolling/theora-rolling-context.ts` (vendored, Apache-2.0,
from Theora; summary rules adapted from claude-rolling-context, MIT). The wiring is
`services/rolling-context.ts`, ported from Sanctum. Budgets are Sanctum's live ones.

Rules it holds to:
- The summary is derived context. Its header says it is never authority over the
  identity files, `AGENTS.md`, or the person's live words.
- Context loss is never silent. Every fold, merge and rebuild appends a `system`
  message to the thread, and when recent turns are left out of a prompt for space the
  prompt says how many.
- If the history source fails, the turn still runs, with a line in the prompt saying
  the earlier conversation could not be loaded. It never fails or blocks the turn.
- The summarizer is one read-only Codex run in a neutral folder with its own short
  base prompt (`prompts/codex-summarizer-prompt.md`), so no `AGENTS.md` or identity
  leaks into it. The budget rules are placed before the transcript and labelled as
  housekeeping (appended after it, the model read them as the person's words; the
  earliest of the vendor markers is used so a marker quoted inside the conversation
  cannot pull them in).
- A summary over `segment_cap` is not a failure. It is retried once with the overage
  spelled out; if the retry throws, the first attempt is kept. Still over, it is
  shortened by section: Previous Goals collapses to one line, then Timeline steps go
  oldest first (numbered or bulleted, lead-in kept, newest step kept). Active Goal,
  Current State and Key Details are never touched. Only an exact vendor header before
  the Timeline counts as a section; a quoted header inside Key Details is content, and
  an ambiguous layout falls back to a head-truncate on a sentence boundary that never
  splits a surrogate pair. The segment carries `truncated`, `truncatedHow` and
  `originalChars`; the fold marker says what happened. (Before this chain, a model that
  ran long every time meant every fold failed, the thread sat in cooldown, and
  everything past the history window left the prompt: the same bug Sanctum hit, and
  the same seven-step fix chain, ported from its history.)
- A failed fold leaves a system note in the thread the first time in a streak, with
  the error and when the next try is.
- Something reads the counters: `node tools/rolling-health.mjs` (or
  `GET /api/rolling/health`) lists every thread's segments, shortened summaries,
  cooldowns, and flags `failing` (last event was a failure) and `stuck` (nothing ever
  covered, three or more failures); it exits 1 when any thread is failing. Once a day,
  on the orchestrator's half-hour tick, `services/rolling-watch.ts` posts one system
  note to the daily thread naming failing threads and summaries shortened since the
  last check, and says nothing when there is nothing to say.
- Folding runs after a turn completes, in the background, one per thread at a time.

## Where the server listens
`server.host` may be a Tailscale or LAN address instead of loopback. Then the server
does not listen on localhost at all, so everything that calls it from the same
machine resolves the address the same way: `tools/res.mjs` reads `host:` under
`server:` in the config file (or `SANCTUM_HOST`), and the built-in MCP servers the
app registers on the Claude path use `internalBaseUrl()` from `config.ts`. The
browser origin for that address (`http://<host>:<port>`) is always allowed for the
live connection and the setup writes it into `cors.origins` as well.

## Revien plug-in

`services/revien.ts`. Before each of the person's messages the app asks the local
Revien daemon for relevant memories and adds them under a `[Memory]` header. After
the reply it hands Revien the exchange as one append-only ingest with a unique
`source_id` (`sanctum-mobile:<thread>:<timestamp>`). Never for background helpers
or autonomous wakes. Unreachable daemon: one log line, then quiet retries; worst
case added latency per turn is `timeout_ms`.

Because the app's Codex runs are unlogged, Revien's own Codex session reader
(`revien connect codex`) does not see them, so nothing is counted twice.

## Moving the project to another GitHub account

The GitHub address is read from one line, `repository` in the root `package.json`
(`github:owner/name`). The in-app version check and `npm run update` both use it.
To move:

1. Push the code to the new repository.
2. Change `repository` in `package.json` to the new `github:owner/name` and push again.
3. Make the repository public, or tell people to add `GITHUB_TOKEN` to `.env`.

People on an old copy still point at the old address; their next `npm run update`
pulls from wherever their copy's `package.json` says, so leave the old repository
readable until they have updated once, or tell them to download the new ZIP.

## Settings under `agent.rolling` (both harnesses)
| Key | Default | Meaning |
|---|---|---|
| `claude` / `codex` | `true` / `true` | Rolling context on that harness. Off keeps the summaries on disk; nothing is deleted. A legacy `agent.codex.rolling.enabled` is read once and folded in. |
| `model` / `model_provider` | `""` / `""` | The summarizer. Empty follows `model_autonomous`, then `model`. On Claude the summarizer is an isolated Claude run (`rolling.model` if it names a Claude model, else the autonomous model); on Codex an isolated Codex run. One summarizer, whichever harness runs turns. |
| budgets | as before | `tail_chars`, `fold_chars`, `keep_chars`, `tail_turns`, `max_segments`, `segment_cap`, `history_max_chars`, `history_max_turns`, `summarizer_instructions_file`. |

On the Claude path with rolling on: no session is ever resumed, the prompt is context → recalled memory → derived summary → dropped-turns notice → `[Conversation so far]` → `[Current message]` (identity rides in the system prompt), the SDK's compaction and auto-memory stay off, `settingSources: []` is pinned, and the fold runs after the reply. `services/rolling-history.ts` builds that history for both adapters.

## Settings under `agent.codex`
| Key | Default | Meaning |
|---|---|---|
| `model` | `""` | Chat model id. Empty uses whatever `~/.codex/config.toml` sets. |
| `model_provider` | `""` | A `[model_providers.*]` key from `~/.codex/config.toml`. Empty = Codex's default provider. |
| `identity_every_turn` | `true` | Send the identity files with every message, so edits apply at once. `false` sends them on a thread's first message only: fewer tokens, edits reach new threads. |
| `base_instructions_file` | `./prompts/codex-base-prompt.md` | The shared harness. Used only when the home has no `config/codex-base-prompt.md` (the home's copy wins). `""` gives stock Codex back. |
| `sandbox_mode` | `workspace-write` | The write boundary: the home folder plus `additional_directories`. |
| `network_access` | `true` | Must stay `true`. The `res` CLI calls the local backend. |
| `rolling.tail_chars` / `fold_chars` / `keep_chars` | `14000` / `6000` / `6000` | Fold once the un-summarized tail passes `tail_chars`; one fold covers about `fold_chars` of the oldest tail; the newest `keep_chars` are never folded. |
| `rolling.tail_turns` | `24` | Fold once this many turns are un-summarized, whatever their size. |
| `rolling.max_segments` / `segment_cap` | `5` / `2000` | Merge the two oldest past this many segments; max characters per summary. |
| `rolling.history_max_chars` / `history_max_turns` | `24000` / `30` | How much recent verbatim history goes with each message. The newest turn is always sent. |
| `rolling.summarizer_instructions_file` | `./prompts/codex-summarizer-prompt.md` | Base prompt for the summarizer run. |

`agent.dsh.base_instructions_file` (default `./prompts/dsh-base-prompt.md`) follows the same rule for dsh: used only when the home has no `config/dsh-base-prompt.md`, and now ships. `""` or a missing file gives dsh's stock persona back. See [docs/DSH.md](docs/DSH.md).

## Settings under `revien`
| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Recall before and ingest after each of the person's messages. |
| `url` | `http://127.0.0.1:7437` | The local Revien daemon. |
| `recall_limit` | `6` | Memories added per message. |
| `timeout_ms` | `2500` | Give up on a recall after this long. |

## Optional features (all off by default)
- Discord → `discord.enabled: true` + bot token in `.env`
- Command Center → `command_center.enabled: true`
- Google → `google.enabled: true` + `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- Browser tools → one `.mcp.json` entry named `browser` (`examples/browser-seat-neko/mcp.example.json`, or `npm run setup`): `@playwright/mcp@0.0.83 --cdp-endpoint http://127.0.0.1:9232` run behind `examples/browser-seat-neko/mcp-filter.mjs`, which removes `browser_run_code_unsafe` (RCE in the server process, outside dsh's sandbox) and `browser_evaluate` (page JS, reads logged-in cookies/DOM) because 0.0.83 has no exclude flag, so all three harnesses drive the seat's browser through the existing MCP path, with no backend service. `browser` is a legal name on dsh and Codex. The skill is shipped twice, in `companion-home/.claude/skills/` (Claude) and `.agents/skills/` (dsh); `res help browser` appears when `integrations.browser_url` is set or `.mcp.json` has a `browser` server. **Codex has no skill root**, so the SKILL.md body never reaches the companion there; only the `AGENTS.md` pointer does, and it (and the skill's first line) tells the companion to `cat` the file. Without `integrations.browser_url` there is no viewer tab: the person cannot watch or take over. The filter also requires `--workdir` (the server's cwd, `data/browser-out`, mode 0700, same path as `--output-dir`), hard-codes the two required blocks (exit 2 otherwise), strips `webmcp_*` tools (the entry also passes `--no-webmcp`), survives malformed lines and non-string tool names, and answers a blocked call that reuses an in-flight id with -32600; `npm run setup` offers to replace a `browser` entry that has no filter, and the backend logs one startup warning for it.

## Known gaps on Codex
- **No tool timeline pills or audit log.** Those ride Claude SDK hooks, which Codex doesn't fire. Tool calls are logged to the server console instead.
- **The write-gate is the Codex sandbox**, not a per-tool hook.
- **The MCP status panel in Settings shows empty.** Servers from `.mcp.json` are still passed through.
- **One Codex note remains with DeepSeek.** Codex adds a short "you are the primary agent in a team" note, followed by its own instruction not to delegate unless asked. It comes from DeepSeek's `models.json`, not from this app.
- **Background helpers share the base prompt.** Digest, handoff and outlook runs get the same harness prompt plus their own task brief, and no identity block.
- **A global `~/.codex/AGENTS.md` rides into every run, including the summarizer.** Codex loads it regardless of the working folder and there is no per-run switch for it (folder files can be switched off, and the summarizer does). If you keep one, keep identity out of it, or summaries will pick up names and voice from it.
- **Background helpers run unlogged too** (digest, handoff, outlook), through the same runner, so nothing the app does lands in `~/.codex/sessions`. A helper that resumes a real Codex session still goes through the SDK.
- **Rolling mode re-sends the session orientation every message.** Resonant sends its tools and skills orientation once per session; with a fresh Codex run per message it goes every time. Estimated from the code at 6,000 to 10,000 characters per message, not measured. The mind prefetch runs every message for the same reason.
- **Edited or deleted messages that were already summarized stay in the summaries.** Deleting the message a summary depended on triggers a rebuild from the start, which is announced in the thread.
- **Fold notes appear on reload, not live,** and the daily Scribe digest sees them as `System:` lines.
- **Two messages sent while a reply is still streaming** can leave the second one repeated in the next prompt. Not observed, and the UI may not allow it.
- **MCP servers with dots or other punctuation in their names are skipped** with a warning. Codex splits config keys on dots even inside quotes.
