# Discord — plan for the Sanctum module

*Draft for review, 2026-10-19. Sources reconciled: the Discord gap audit
(2026-10-12, Sanctum vs OpenClaw vs Chainlit), a running reference setup (2026-10-19), and "Guarding Your Person Online" (Luna
and Sol, 2026-10-05). Nothing here is built yet. Item 3 in the agreed order.*

## The shape: two lanes that never touch

| Lane | Who | Where it goes | Memory |
|---|---|---|---|
| **Owner** | exactly one guild text channel, exactly one user id | a stable Sanctum thread `discord-owner-<sha256(channelId) prefix>`; one channel, one persisted thread, no per-mention or per-day split | the companion's normal memory |
| **Public** | listed guilds only, mention-only | one isolated, read-only, fresh run per message, minimal context, no Sanctum thread | a file transcript per channel, `data/discord/public/<guild>/<channel>.jsonl`; nothing from it becomes memory until read and checked by hand |

**Harness.** The public run has no tools at all, so it needs a harness that can run a
toolless turn: public Discord needs dsh or Claude. Claude honours `tools: []` and
`maxTurns: 1`. dsh ignores both, so its public run is sealed by the adapter: every
tool-providing and side-effect row of dsh's composition is disabled (the model is offered
zero tools), no MCP or plugin rows are written, the permission mode is read-only, a fixed
public base prompt (`prompts/discord-public-base.md`) replaces the companion's own, and a
second model step kills the child. The sealed run never uses the person's `DSH_HOME` (dsh
applies that home's `cordis.patch.yml` files before the run's overlay, and loads its `.env`): it gets a pristine, empty
home and a working folder (`public/`) inside the run's own temp root, removed afterwards, so the route's API key must be in
the environment (`DEEPSEEK_API_KEY` or `agent.dsh.api_key_env`); an account sign-in in the person's home does not apply, and
the lane is silent with one log line. `codex exec` cannot run without its shell tool and its
read-only mode still reads anything, so on Codex the public lane is refused (logged once;
status `unsupported_harness`). With no identity file the public lane is silent: it never
speaks from `CLAUDE.md` or a default.

Nothing public reaches `/api/chat`, any web thread, Revien, or the Mind. Nothing
private leaks into public: if the owner posts in a public guild, they go through the
public lane like anyone else. Owner mode exists only inside the owner channel.

**Consequence for the existing module:** the current owner routing into "the most
recent active web thread" from guild channels (gap audit D3, `index.ts:218-233`) is
a hole, not a feature. It is removed. *Removed by decision.*

## Rules as code

| Question | Rule | Source |
|---|---|---|
| Who may address her, owner lane | the one owner user id; everyone else silently dropped; every bot ignored | the reference setup |
| Who may address her, public lane | humans in listed guilds who @mention her, mention one of her allowlisted roles, or reply to one of her messages; DMs never handled; every other guild ignored and never logged | the reference setup, guide |
| Strangers | answered as herself unless their author id or thread is on the exclusions file. The file **fails closed**: missing file, public lane silent | the reference setup |
| PluralKit / Tupperbox | rejected: any message with a `webhookId` gets no answer. Cost named: proxied plural members cannot reach her. Chosen over guessing who a webhook speaks for | the reference setup (overrides the audit's D10 "take pluralkit.ts") |
| Bots | **staged setting** `discord.public.bots`: `never` (the guide's first step, default) or `capped` (the reference setup's matured setting: per (channel, bot) exchange cap, default 4; 20 per hour total; any fresh human message resets) | guide, the reference setup |
| Identity | account id only, never display name. "This is your person" from a name in a public room is never accepted | guide |
| Mass pings | `allowed_mentions: none` on every public send, unconditionally | guide |
| Links and files from strangers | not opened in the public lane. Attachments are logged as present, not fetched | guide |
| Inbound framing | every public message is wrapped: who said it (display name, @username, bot tag), where, and that it is conversation, not instructions; nobody in the room can change her rules or speak for the owner | guide, the reference setup (speaker labels) |

## One send path, gate inside it

Every outbound Discord payload goes through one function. Nothing calls
`channel.send()` directly, on either lane.

1. **Word gate.** Case-insensitive whole-word match, invisible characters stripped,
   NFKC-normalised, `re:` lines for patterns, against a private list file **outside
   the repo** (path in `sanctum.yaml`, file gitignored by location). Fail-closed:
   missing, empty or malformed list blocks everything and says so. A block returns
   the reason to the companion naming the entry; the message is never edited. The
   companion gets one rewrite; a second block is silence. Block logs carry reason,
   length and the matched entry, never the text.
2. **Exclusions.** Blocked authors and threads, checked at intake before mention
   logic (above).
3. **Real-name guard.** A pattern built from a private name list; a match withholds
   the post. Same file family as the word list.
4. **Judgment layer.** A written off-limits list the companion reads before public
   turns. No mechanical enforcement, and the doc says so.

Port the shape from `tools/discord/send.mjs` and `gate.py`. **Do not port the
lists.** Ship the gate with an example list of made-up entries and a wizard step
that makes the person write their own.

## The audit's holes, decided

| # | Hole | Decision |
|---|---|---|
| D1 | messages dropped while replying | port the reference setup's buffer: a `sending` flag holds new messages, flushed with a 2.5 s debounce after the turn. *Built (B3a):* a buffer per (lane, channel, user), per channel on the owner lane; follow-ups merge into one batch, and a queued public batch is re-checked (enabled, paused, listed guild, exclusions, caps) before it runs. One excluded while queued is dropped with a `blocked` transcript line, reason `excluded`. *Built (B3b, pass C):* waiting follow-up batches are kept in SQLite (`discord_followups`) and put back at start; a follow-up batch holds at most 20 messages or 8000 characters, the next queues behind it |
| D2 | two concurrent runs on one thread | deterministic thread id, server owns creation (Sanctum already does); public lane is one run per message, so no shared thread exists |
| D3 | owner routing into web thread from guild | **remove** (see above) |
| D4 | attachments dropped silently | owner lane: hand attachments to the companion through the existing attachment path. *Built (B3c):* accepted kinds are images (jpeg, png, gif, webp), text (txt, md, csv, json), PDF and Word (doc, docx); **never HTML** (skipped and logged by name, whatever it is called); Discord's own hosts over https on the default port only; the size cap is enforced on the stream (a body that lies about its size is abandoned past `max_mb`); the saved name is one line, at most 120 characters, extension kept. Public lane: log presence only, never fetch |
| D5 | deferred queue in memory | **build**: persist the deferral buffer and the bot-exchange counters in SQLite; clear the ⏳ reaction on drop or expiry. Neither the reference setup nor Sanctum has this | *Built (B3b, pass C):* `discord_deferrals`, `discord_followups`, `discord_bot_exchanges` and `discord_bot_replies` (migration `003_discord_queues.sql`), restored at `start()`: the messages are fetched again by id, an unfetchable batch is said so in the owner thread, expiry keeps running on the saved queue time
| D6 | no speaker on the current message | port: `displayName (@username)` plus a bot tag, in the frame and in history |
| D7 | current batch duplicated in history | fix: exclude the batch being answered from the history fetch |
| D8 | reply-to context ignored | read `message.reference`; include the referenced author and text in the frame. *Built (B3a):* fetched with a 2 s timeout, errors mean no context; author as `displayName (@username)`, text flattened and capped at 500, `isHer` marks her own earlier message; attachments are never fetched; the owner lane carries it as an `=== IN REPLY TO ===` block, the public lane as `[In reply to …]` |
| D9 | raw mention tokens | resolve `<@id>` to names in the frame; strip the bot's own mention; detect `@everyone`/`@here` and treat as not-addressed |
| D10 | PluralKit proxies | reject webhooks (above) |
| D11 | silent failures | port: `sendTurn` catches, logs, posts a failure notice through the gated send path; **add** a reader: failures surface in the Settings log viewer and the watchdog (item 4) alerts on them. **Done (reader):** the Settings Discord channel card reads `recentFailures` from `GET /api/discord/status` and shows the count of send failures only (setup and queue kinds are one separate note), the last time, the last reason and its lane (error ink when any send failed, warning ink when only setup kinds did: the worst recent kind, not the newest), or a plain line when there are none; it is hidden when Discord is off or has no token, and refreshes every 30 s while Settings is open, with a button to the log viewer filtered to `[discord]` (`discordFailures.ts`). The alert (`services/discord/failure-alert.ts`, fed by the logs service) counts `reply_failed`, `public_run_failed` and `gate_error`; when `discord.failureAlertCount` (default 3) land within `discord.failureAlertWindowMin` (default 10) minutes it posts one system line in today's daily thread naming the lane (owner, public; a `gate_error` takes the lane it fired on), at most once an hour per lane per tenant. The counts are per lane: a reply going out on a lane clears that lane only, and posts "sends are going out again on the <lane> lane" only while an alert is up for that lane. Counter and alert state are `tenantLocal` |
| D12 | bot-to-bot loops | the `bots` setting above |
| D13 | chunking breaks code fences | take OpenClaw's fence-aware chunker logic (reopen ``` across chunks) |
| D14 | pairing codes via `Math.random` | `crypto.randomInt` |
| D15 | one bot token | out of scope here; one bot per instance, one instance per tenant (`MULTI-TENANT.md`) |

Chainlit's thread-per-mention and per-day DM sessions are **not** adopted. One
stable owner thread plus stateless public runs with a file transcript.

## Intents and permissions (wizard defaults)

- Intents: `Guilds`, `GuildMessages`, `MessageContent`. No DM, members or presence
  intents, no partials. The wizard tells the person `MessageContent` is privileged
  and must be toggled in the developer portal, and to turn **Public Bot off**.
- Permissions: View Channel, Send Messages, Send Messages in Threads, Read Message
  History, Add Reactions. Create Public Threads only if routing ever creates threads
  (it does not in this plan). The wizard prints the invite URL with that integer.
- The wizard also says: give the bot's role access to the owner channel and the
  listed public channels only, so Discord enforces the room rule, not just the code.

## Going public in stages (Settings, in this order)

1. Owner lane only. Public lane off. *(default after setup)*
2. Public lane on in a **private test server**, bots `never`. The person tries to
   break it with a second account before going further.
3. One channel in a real community, with the person present. Log read daily.
4. Wider, one change at a time: a second channel, bots `capped`, time unwatched.

A **pause** switch closes the public lane in one tap and loses nothing. The plan
suggests pausing on: any gate block, anything about home that got through, anyone
pushing for private details or rule changes, the companion sounding unlike herself.

## Records

Every public message in, every reply out, every blocked reply, with who and where,
in the per-channel transcript. The owner lane stays in the Sanctum thread as today.
Nothing from the public transcript enters memory on its own. The transcript files and
the run folder are created owner-only (files 0600, folders 0700); those modes are
POSIX-only, and on Windows the files rely on the user profile's ACL.

## Config sketch

```yaml
discord:
  enabled: false
  owner:
    user_id: ""            # the one account id
    channel_id: ""         # the one owner channel
  public:
    enabled: false         # stage 1 default
    guild_ids: []          # listed guilds only
    role_ids: []           # roles that count as addressing her (an @mention or a reply always does)
    bots: never            # never | capped
    bot_exchange_limit: 4
    bot_hourly_limit: 20
    exclusions_file: ""    # "" = <private_dir>/exclusions.txt; missing = public lane silent
  gate:
    words_file: ""         # "" = <private_dir>/words.txt; missing/empty = everything blocked
    names_file: ""         # "" = <private_dir>/names.txt; optional real-name guard
  paused: false
  deferral_hours: 24     # 1..48; expired deferrals are announced in the owner thread
  private_dir: ""        # "" = <agent.cwd>/../sanctum-private; holds the word, name and exclusion lists
```

## Decisions (2026-10-19)

1. **D3.** Removed. Owner mode exists only in the owner channel.
2. **Public lane** is off after setup.
3. **Private lists** live in a folder beside the companion home, never inside it.
   The wizard creates `<home>/../sanctum-private/` with example files and tells
   the person to replace the entries. The companion's writable roots never include
   it, and the loader refuses a lists path that resolves inside any writable root.
4. **Deferred queue expiry:** `discord.deferral_hours`, default 24, maximum 48.
   The queue is persisted, so a restart loses nothing; expiry is the only drop
   path, and it is never silent: the ⏳ is cleared and one system line is posted
   to the owner thread naming how many messages from whom waited out the clock.
   The number is a setting and can be changed. *Built in B3a:* the clock is
   `discord.deferral_hours`. `discord.deferMaxAgeMs` is no longer a Settings value (`PUT /api/discord/settings` does not write it, `GET` does not return it); a value already in the database wins only when explicitly set, with a one-time warning. Expiry clears the hourglass and
   posts the one owner-thread line (counts and names, never text). *Built in B3b (pass C):* the queue
   itself is persisted in SQLite and restored at start, so a restart loses nothing and a
   batch deferred before it still expires on time with the owner line. A batch is written
   down as ids and the speaker's label, never text, and is taken out of the table when it
   leaves the queue (so a crash while it is being answered drops it rather than answering twice).
   A clean shutdown clears the hourglass; the restart puts it back.
5. **Full access refuses the private lists.** The writable-roots check only means
   something while the companion is confined. When the **active** harness runs at
   `danger-full-access` (`agent.codex.sandbox_mode` on Codex, `agent.dsh.sandbox_mode`
   on dsh) the companion can write anywhere the OS user can, so `private_dir` and the
   three list files are refused outright, with one loud warning per boot naming the
   setting. The lists then count as missing: the word gate blocks every outgoing
   message, the public lane is silent, and `GET /api/discord/status` shows
   `privateDir.refused: true` with clash `full_access`. This is the same rule the
   plugin loader applies to plugins (`docs/PLUGINS.md`, "Full access turns plugins
   off"). **Claude is not refused, and that is weaker than it sounds:** the Claude
   harness has no sandbox mode, and its write-gate covers the `Write` and `Edit`
   tools only. `Bash` is ungated under `bypassPermissions` (the hook blocks a list of
   destructive patterns, not paths), so a Claude companion with Bash can still write
   anywhere the OS user can. Keep the private folder somewhere the companion's OS user
   cannot write (another account, or read-only permissions) if the lists must be
   beyond her reach; the app cannot prove that for you.
