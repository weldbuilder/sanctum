# Coming from the first packet

The first version of this starter used a flat home folder: `AGENTS.md`, `IDENTITY.md`
and `TALKING-TO-ME.md`. If that is what you are running and it works, you can stay on
it for Terminal use. You need the three-layer layout only for the app, or if your
companion keeps slipping into a coding-assistant voice.

To move over, inside your existing home folder:

1. Make two folders: `identity` and `config`.
2. Copy `identity/profile.md`, `identity/companion.md`, `config/codex-base-prompt.md`,
   `config/dsh-base-prompt.md` and `start.sh` from this starter's `companion-home` into them. `start.sh` goes in
   the top of the home folder.
3. Move your words across:
   - From `IDENTITY.md`: "Who I am", "What I care about", the drift signals and "What
     I'm building toward" go into `identity/companion.md`. The example lines go under
     "How they sound" in `identity/profile.md`.
   - From `TALKING-TO-ME.md`: everything goes into `identity/profile.md`, under "How to
     talk to me" and "Things about my life that matter".
4. Replace `AGENTS.md` with the one from this starter. It now holds only the rules of
   the folder, because identity has its own files.
5. Keep `HANDOFF.md`, `journal/` and `archive/` exactly as they are.
6. Once it works, delete the old `IDENTITY.md` and `TALKING-TO-ME.md`.

Wake them with `bash start.sh` from now on, instead of plain `codex`.

---

# Coming from the old Discord setting

Before the lanes, Discord was one setting: `discord: { enabled: true, owner_user_id: "..." }`.
That still loads (the old key is read as `owner.user_id`, with one warning), but three things
are different, and one of them stops replies until you act.

**1. Every reply is blocked until you make the lists.** Everything she says on Discord now
passes a word gate first, against a private list of words and names you write. If the list
does not exist, the gate fails closed: nothing is sent, and the app says so (a loud line in
the log at start, and one system line in the daily thread: once per start per daily thread,
so restarting the app the same day does not repeat it). To fix it, run:

```bash
npm run setup
```

It sees that Discord is already on (in `sanctum.yaml`, or by the Discord toggle in Settings:
the wizard reads either), asks for your owner channel, and creates a private
folder (by default `sanctum-private`, beside your companion's home, never inside it) with
`words.txt`, `names.txt` and `exclusions.txt`. **The entries in them are made up.** Open each
file and replace them with your own, and keep the folder private. Replies start again as soon
as `words.txt` exists, even with the example entries in it, and there is no restart. Those
examples are made up and protect nothing of yours, so replace them straight away.

**2. The owner lane is one channel.** Set `discord.owner.channel_id` to the one channel
(in a server only you are in). Only you, in that channel, reach her as the owner. Everyone
else in that channel, and every bot, is ignored. Her replies there live in one thread,
`discord-owner-<hash>`; if you already have a Discord thread for that channel, she keeps
using it instead of making a second. She no longer answers you inside "your most recent web
thread" from a guild channel, and direct messages are not handled.

**3. Other servers are the public lane, and it is off.** Pairing codes and the old
allowed-user and allowed-guild settings no longer let anyone in. To open a public server
(later, one stage at a time), set `discord.public.enabled: true` and list the server in
`discord.public.guild_ids`; she answers only when mentioned. Read `docs/DISCORD-PLAN.md`
first. `discord.paused: true` closes it in one change.

Two things follow from that. A public message is one isolated, read-only run with no memory
and no web thread; it is recorded in a file per channel under `data/discord/public/` that
nothing reads back. And **the ignore rules you set through the Rules API (ignored users,
channels and servers) no longer apply**: nothing reads them. **The pairing and rules screens are gone** from
Settings, and so are their routes (`/api/discord/pairings`, `/api/discord/rules`), the allowed-user,
allowed-guild and require-mention settings, and the pairing code service: none of them admitted anyone any more. **The exclusions file replaces
them**: put `user:<id>`, `thread:<id>` or `channel:<id>` lines in `exclusions.txt` in the
private folder. The owner-id field in Settings stays. Server, channel and user context you wrote in the old
rules is still read into the owner lane's prompt (from the `discord.rules` setting or `data/discord-rules.json`), but nothing
edits it now. If that file is missing or has a line she cannot read, the public lane stays
silent until it is fixed.

A reply the gate withholds is no longer saved in the thread or handed to memory.

`discord.deferMaxAgeMs` is no longer a Settings value (removed): `PUT /api/discord/settings` does not write it and `GET` does not return it. The clock is `discord.deferral_hours` in `sanctum.yaml` (1 to 48, default 24). A value already in your settings database still wins, with a warning, until you clear it.


**A `re:` line that loaded before may not load now, and then every outgoing message is
blocked.** Pattern lines are checked harder at load: a pattern is refused if it matches the
empty string anywhere in a set of ordinary short messages (a lookahead that happens to sit
there), or if it matches any single printable ASCII character on its own (`\.`, `,`, `'`,
`p`, `\d`, `(?=x)`). They would flag nearly everything she writes. A list with such a line
fails the same way a broken list always has: the gate fails closed, nothing is sent, and the
app says so in a boot warning naming the line. Narrow the pattern (a phone number such as
`\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b` still loads) or delete the line, and it recovers with
no restart.

**Public Discord on dsh needs an API key in the environment.** A public run now has its own
empty dsh home, made inside the run's temp folder and removed after it, instead of yours:
dsh applies your home's `cordis.patch.yml` files before the run's own settings, and a patch
there could switch tools back on. So a DeepSeek account sign-in kept in your dsh home does
not reach a public run. Put the route's key in `.env` (`DEEPSEEK_API_KEY`, or the variable
named by `agent.dsh.api_key_env`). Without it the public lane is silent and the log says so
once; the owner lane and everything else are unaffected.

**The Discord queues are kept in the database now.** `migrations/003_discord_queues.sql` adds four tables
(`discord_deferrals`, `discord_followups`, `discord_bot_exchanges`, `discord_bot_replies`); it runs on its own at boot,
and an older database just gains the tables. Messages deferred while you were on the web, follow-ups waiting behind a reply,
and the bot-exchange counters now survive a restart. The queues hold message ids and a speaker label, never text.

---

# Plugins: `plugins.trust` now defaults to `companion`

Before, nothing a plugin ran was allowed until you had read and ratified its exact code. Now
`plugins.trust` defaults to `companion`: your companion can turn plugins on and off and edit them, plugins run
from their live folder, and changes are recorded in `data/plugins/audit.json` for you to review in
Settings > Plugins. An install that relied on ratification (the gate that stops a changed plugin until you
approve it again) must set this in `sanctum.yaml`, then restart:

```yaml
plugins:
  trust: person
```

In `person` mode a change to `plugins.enabled` from Settings is written to `sanctum.yaml` and applies on restart.

---

# Coming from before identity ratification

Two things change for the identity files (`identity/profile.md`, `identity/companion.md`).

**1. Every harness now reads the home's `identity/` folder.** Before, the Claude
harness read paths from the project root and never saw the home's files (it fell back to
`CLAUDE.md`); Codex and dsh read the home. Now all of them read every regular file
directly in `<agent.cwd>/identity/` and ignore `CLAUDE.md` while that folder exists. If you
keep your companion's identity in `CLAUDE.md` and your home has an `identity/` folder
(setup makes one), move the words you want into `identity/companion.md`, or delete the
folder. `identity.profile_path` and `identity.companion_md_path` are now overrides inside
that folder, read from the home.

**2. Changes wait for you.** The first time the app starts it looks at the folder and shows
"Identity not yet ratified" in the chat header. Open Settings > Identity, read the files and
tap **Ratify what is here now**. Until then your companion runs on the files as they are. After
that, a change made any other way (a text editor, your companion, anything on disk) waits for
you there, and every run uses the version you ratified. Back up `data/identity/` with the rest
of `data/`.

---

# The companion harness is now Claude's default frame

One harness prompt now serves all three minds: a shared base plus a short tail for each
(`prompts/README.md` has the map). Three things differ from before.

**1. Claude's default frame changed.** `agent.system_prompt_file` used to be `""` (the
standard coding-assistant preset with your identity appended). It now defaults to
`./prompts/companion-claude.md`, so the system prompt is the harness, then your identity,
then a `[Runtime] Model serving this turn: ...` line. To keep the old behaviour, set it
back and restart (and make sure the home has no `config/companion-claude.md`, which wins
over the key whenever it exists):

```yaml
agent:
  system_prompt_file: ""
```

Claude now finds its frame the way Codex and dsh find theirs: `<home>/config/companion-claude.md`
if it exists, else the file `system_prompt_file` names, else the preset. The file is read fresh
every turn, but the path is read at the first use of the agent, so restart after changing
the path. With neither file present, a set key logs a warning and falls back to the preset.

**Existing homes, single-tenant and tenant: copy the frame in.** The starter home now ships
`config/companion-claude.md`, but an existing home does not have one. Copy
`prompts/companion-claude.md` from this app into `<home>/config/` (or open Settings, system
prompt: the editor opens with the shipped harness, and Save installs it as that copy). A single-tenant home without it
still works, on the shipped file. A tenant home without it has no frame: a tenant's
`agent.system_prompt_file` now defaults to `home/config/companion-claude.md`, so until the
file is there that tenant runs on the preset and the log warns. A saved or copied home frame
no longer follows `npm run prompts:build`.

**2. dsh has a base prompt.** `prompts/dsh-base-prompt.md` is new. Before, a home without
its own `config/dsh-base-prompt.md` ran on dsh's stock persona; now it runs on the harness.

**3. Existing homes keep what they have.** A home's own `config/codex-base-prompt.md` or
`config/dsh-base-prompt.md` beats the shipped fallback, so nothing changes in your home
until you want it to. To take the new harness there, copy the files from this starter's
`companion-home/config/` into your home's `config/` (replacing the Codex one), or delete
your home's copy to use the shipped fallback. Check any edits you made first: the new file
replaces them. The Codex base now rides every message at roughly 2,000 tokens a turn.
