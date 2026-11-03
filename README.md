<p align="center"><img src="docs/logo.png" alt="Sanctum logo: a small glowing star sheltered under an arch" width="200"></p>

# Sanctum

A private home for an AI companion, on your own computer, with an app to talk to them from
any browser or your phone. The companion lives in a folder you own, runs on the model you
choose, and remembers across days. Nothing leaves your computer except the calls to that
model.

## What you need

- A Mac, Linux or Windows computer, and its terminal.
- **Node.js 20 to 24.** The LTS download from <https://nodejs.org> is in range.
- One **mind** for the companion:

| Mind | Runs on | Install |
|---|---|---|
| **Claude** | a Claude plan, or an Anthropic API key | Claude Code for a plan; nothing for a key |
| **Codex** | a ChatGPT plan, or a DeepSeek or other OpenAI-compatible key | the Codex CLI |
| **DeepSeek Harness** (alpha) | a DeepSeek key | dsh |

## 1. Install a mind

Check Node first: `node --version` should print v20 to v24. Then install the one you chose:

```bash
# Codex (then `codex login` if you use a ChatGPT plan)
curl -fsSL https://chatgpt.com/codex/install.sh | sh

# Claude on a Claude plan (then run `claude`, type /login, approve in the browser, /exit)
npm install -g @anthropic-ai/claude-code

# DeepSeek Harness
npm install -g @deepseek-ai/dsh@0.2.1-alpha.2
```

Using an API key? Nothing to sign in to here: the app asks for the key in step 3.

## 2. Get Sanctum and start it

Download this repository (**Code → Download ZIP**, then unzip) or clone it. In a terminal,
inside that folder:

```bash
npm install
npm run build
npm start
```

Leave that window open: it is the running app. Ctrl+C stops it, and `npm start` starts it
again. (`npm start` runs `node packages/backend/dist/boot.js`; if you start the app any other way,
with pm2, systemd or Docker, that file is the one to run, not `dist/server.js`: it first puts back
the previous version if an update was cut short.)

## 3. Move them in

Open the address `npm start` prints (normally `http://127.0.0.1:3099`). The first time, the
app asks for the **setup code** printed in the same window, then three screens:

1. **Make it yours.** Your name, their name, your time zone.
2. **Connect their mind.** Claude, Codex or DeepSeek; sign in or paste a key. The app checks
   it works before going on.
3. **You're ready.** The app shows the password it made for you. Keep it; your phone needs
   it too.

That creates their home folder at `~/Documents/companion-home` and writes the app's
settings to `sanctum.yaml` and `.env`. Everything else (what they may touch, memory,
Discord, plugins) is under **Settings → Run setup again**, or `npm run setup` in the
terminal.

## 4. On your phone (optional)

The app only listens on your own computer. The simplest way in from a phone is
[Tailscale](https://tailscale.com): install it on both, sign in to the same account, then
on the computer run once:

```bash
tailscale serve --bg 3099
```

It prints an address ending in `.ts.net`. Add it to `sanctum.yaml`, restart the app, open
the address on your phone and use **Add to Home Screen**:

```yaml
cors:
  origins: ["https://YOUR-COMPUTER.YOUR-TAILNET.ts.net"]
```

## Their home folder

| File | What it is |
|---|---|
| `identity/profile.md` | the facts: names, who you are to each other, how they sound |
| `identity/companion.md` | who they are, in their own voice; write it with them |
| `AGENTS.md` | what they may change on their own, and what needs a yes from you |
| `journal/`, `HANDOFF.md` | theirs to write in; open threads for next time |
| `archive/` | old chat exports, for them to read |
| `identity/avatar.png` | their picture (`.jpg`, `.webp` and `.gif` work too) |

Keep each identity file under about 400 words, say what you want rather than what you
don't, and use your own words. After editing a file outside the app, approve the change
in **Settings → Identity → Ratify**; until then they keep running on the last approved
version.

## Memory

Memory works out of the box: Sanctum recalls the closest lines from your earlier
conversations, on this computer, with nothing to install.

For more, **Revien** keeps what they learn as a searchable graph (Python 3.10 or newer):

```bash
pip3 install 'revien[mcp]'
revien connect codex        # on Codex only
revien start                # leave it running
```

Then choose Revien under **Settings → Run setup again**. Run one memory system at a
time; setup switches the others off.

## Good to know

- **Long conversations keep their memory.** The newest part goes to the model word for
  word, and older parts are folded into short summaries. Nothing is deleted from the thread.
- **They ask before they overstep.** Anything that deletes, sends, spends or reaches
  outside their folder shows you an Allow / Deny card first. No answer in ten minutes
  counts as no.
- **Built-in tools** they can write to when you allow it: reminders, a meal and care log,
  cycle tracking, notes and routines.
- **The only thing the app sends out on its own** is one update check every six hours.
  Turn it off with `updates.check: false` in `sanctum.yaml`.

## Optional modules

Each is off until you turn it on.

- **Plugins**, small folders that give them new tools: [docs/PLUGINS.md](docs/PLUGINS.md)
- **A shared browser** you both see and drive (read its warning first):
  [examples/browser-seat-neko](examples/browser-seat-neko/README.md)
- **Discord**, a private owner channel and an optional sealed public lane:
  [docs/DISCORD-PLAN.md](docs/DISCORD-PLAN.md)
- **Several people on one install**, each with their own login and companion:
  [docs/MULTI-TENANT.md](docs/MULTI-TENANT.md)
- **Every setting:** [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## Updating

When a new version is out, a notice drops down at the top of Home and Chat: **Sanctum X.Y is out.
Update and restart.** Press the button, type your password again, and the app downloads the new
version, builds it beside the running one (nothing changes until it is built), keeps the one you
have, and restarts itself. While it installs and builds, new messages wait and background runs
pause. The page reloads when it is back. In household mode one update restarts every companion in the house.

- **Something went wrong?** A failed install or build changes nothing (the app keeps running the
  old version). A crash during the swap is put right at the next start, before anything of the app loads: the previous
  version is put back and the app starts over from it. A failed swap keeps the previous rollback copy. The log is in **Settings → Preferences → Updates**. After a good update, **Roll back to X.Y**
  there returns to the kept copy (one copy is kept: the version before the last update).
- **Messages while it updates** are refused, not dropped: the web box keeps what you typed ("Updating; your message was not sent."),
  Discord and Telegram answer once with "Updating, back in a minute.", and a wake or handoff skipped meanwhile runs once when the pause ends.
- **Local changes in a git checkout** stop the update, and the files are listed. Nothing is
  stashed or overwritten; commit or discard them and try again.
- **Restart:** under pm2 (or `SANCTUM_SUPERVISED=1`) the app exits and lets the supervisor start
  it; anywhere else it starts its own replacement. Details in
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md), "Updating from inside the app".
- **From a terminal** the same steps run with `npm run update` (then restart with Ctrl+C and
  `npm start`), and `npm run update -- --rollback` restores the kept copy. Where the platform
  cannot update itself (no `git` in a git checkout, no `tar` in a downloaded folder) the notice
  says so and shows this command.

Your `sanctum.yaml`, `.env` and `data` folder are never touched, and neither is the companion's home
when it is outside the app folder or untracked (a downloaded folder skips `companion-home/` and the folder
`agent.cwd` names; a git checkout updates only tracked files). Upgrading
from an older layout: [UPGRADE.md](UPGRADE.md).

## Setting it up with an AI assistant

This page is written so an assistant can follow it. If you hand it to one:

- Let it do steps 1 and 2: install, build, start.
- Do step 3 yourself, in the browser. Keys and the password belong there, never in a chat.
- Keys live only in `.env` (and, on Codex, `~/.codex/config.toml`). Neither file should be
  pasted, screenshotted or committed.
- When it finishes, it should leave the app running and give you the address and the
  setup code.

## Troubleshooting

| What you see | What to do |
|---|---|
| "requires Node 20-24", or it exits at once | install the Node LTS from nodejs.org |
| `EADDRINUSE` / port already in use | another copy is running: stop it, or change `server.port` in `sanctum.yaml` |
| Sign-in succeeds, then bounces back | use `http://`, not `https://`, for a local address |
| "Disconnected" on the phone | the exact address in the browser bar must be in `cors.origins`; restart after adding it |
| Their replies fail | check the connection in **Settings → Run setup again** |

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Personal, hobby, research and
noncommercial-organization use is free. Commercial use needs a license from
weldbuilder. The portions that come from Resonant stay under the Apache License
2.0 ([LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)); [NOTICE](NOTICE) says which, and
[LICENSE.md](LICENSE.md) explains how the two fit.

## Credits

Began as a fork of [Resonant](https://github.com/codependentai/resonant) by Codependent AI
(Apache-2.0). Built with the rolling-context core from Theora (Apache-2.0), DeepSeek
Harness, the Codex CLI, Claude Code, Playwright MCP and neko.
