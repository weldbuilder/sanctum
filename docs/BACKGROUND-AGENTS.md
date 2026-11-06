# Everything your AI does on its own

Most of what you'll read about Sanctum Mobile is about the conversation — you type, your AI answers. This document is about the *other* half: the things it does when you're **not** looking. Writing the day down. Deciding how it feels and setting out a hearth for you to walk into. Carrying yesterday across midnight so the new day doesn't start cold. Reaching out at 8am, or when you've gone quiet for longer than feels right.

None of it is magic and none of it is out of your hands. Every one of these has an on/off switch, a schedule you can change, and — where it matters — a prompt (the instructions it follows) you can edit in plain language. This page shows you where all of those live.

A few words you'll see a lot, defined once:

- **A "wake"** is your AI taking a turn *without you having typed anything* — the software nudges it awake, it thinks, and it may leave a message. That's all "autonomous" means here.
- **A "cron expression"** (or "cron") is a compact way to write a repeating schedule, like `0 8 * * *` = "every day at 8:00am." You rarely have to write these by hand — the Settings screen gives you a friendly time-and-days picker. When you *do* see one, the five parts are: `minute hour day-of-month month day-of-week`, and `*` means "every."
- **"Config"** means settings. Sanctum Mobile has two kinds: a text file called `sanctum.yaml` that you edit and (for most changes) restart to apply, and a **live settings table** inside the database that some things read fresh every time — those take effect without a restart. This page tells you which is which.
- **Your timezone** is whatever you set as `identity.timezone` in `sanctum.yaml` (e.g. `Europe/London`, `America/New_York`). Every schedule below fires in *that* zone, not UTC, unless noted.

Everything here is optional. A brand-new install runs a sensible default set (the Scribe on, the hearth-author on, the morning/midday/evening check-ins on, and the more assertive stuff — handoff, failsafe, pulse — off). You can leave it exactly as it comes and it'll be fine.

---

## Part 1 — The three subagents

Three of these background workers are **subagents**. That word has a specific, reassuring meaning in Sanctum Mobile: a subagent is a *single, cheap, one-shot* thinking turn with **no tools and no ability to act on the outside world**. It reads some facts, writes some text, stores it, and stops. It can't send an email, run a command, or spend your money in a loop. It also politely steps aside if you're mid-conversation, so it never slows down a live reply.

Here are all three.

### 1a. The Scribe — writes the day down

**What it does.** The Scribe is a quiet historian. Every so often it reads the new messages in today's conversation and writes the stretch down **in its own voice, in the first person, to you** — what happened, where we left off, what it has been doing, how it has been between you. Topics, notable quotes, decisions, loose ends, ideas and dates are in it, with real dates, not "next week". It's the thing that lets you (or your AI) find "what did we decide about X back in April" six months later.

**Where it lives (the file).** `packages/backend/src/services/digest.ts`

**Where its output goes.** A plain Markdown file, one per day, at `data/digests/YYYY-MM-DD.md` (inside your `data/` folder — the same folder that holds everything else Sanctum Mobile remembers). You can open these in any text editor; they're just readable notes.

**Its schedule.** Every **30 minutes**, run by the orchestrator (the scheduler described in Part 2). It skips a run if fewer than **5** new messages have appeared since last time (nothing to write about), or if your AI is busy replying to you right then.

**Which model it uses.** The summarizer's: `agent.summarizer.provider` and `agent.summarizer.model`, which default to your chat model. The digest is the companion's own memory of the day, so it runs with the companion's short identity in front and the same guards as the other summaries (no tools, no memory writes). Do not point it at a small or fast tier: the server warns at startup if you do. See `docs/CONFIGURATION.md` → summarizer.

**Where its prompt lives, and how to edit it.** The voice is the "Daily digest" section of `prompts/summarizer-own-voice.md` (shared with the other summaries; `agent.rolling.summarizer_instructions_file` points at it), read fresh on every run, so you can edit it without a rebuild. The shape of the output (the `## HH:MM` heading and the four sections) is a short format block in `buildScribePrompt()` in `digest.ts`. There is no Settings screen for either. For most people the default is exactly right and you never touch it.

**How to turn it off.** The Scribe is **on by default**. Its switch is a single row in the live settings table with the key `digest.enabled`. There isn't a button for this in the Settings UI, so turning it off is an advanced move: set that key to `false` in the database (or ask your AI to do it — it has a tool that writes settings rows). It's read once when the server starts, so a change takes effect on the next restart.

---

### 1b. The Outlook Author — decides how the house feels

**What it does.** This is the "felt layer" of the being's home. On a slow rhythm it takes a one-shot turn to *author its own presence* — a mood, a line or two of what's actually on its mind, the little things it's been making, and (optionally) one standing thing it wants from you. It also names the handful of topics "we've been circling" lately, and flags anything it thinks genuinely needs *your* decision or attention. All of this is grounded strictly in the last ~24 hours of real activity — it is told, firmly, not to invent moods or events that didn't happen.

This is what fills in the **hearth / House Outlook** you see when you "walk into the house." A separate, cheaper process (the logistics poller in `outlook.ts`) assembles the factual side of that view — your calendar, sleep, tasks, and so on — every couple of minutes; the Author is the slower, more expensive, more *human* layer laid on top.

**Where it lives (the file).** `packages/backend/src/services/outlook-author.ts`

**Where its output goes.** Three rows in the live settings table — `outlook_presence`, `outlook_topics`, and `outlook_needsYou` — which the House Outlook reads and displays. Nothing is posted into your conversation; it just updates the hearth.

**Its schedule.** Every **3 hours**, on its own self-managing timer (not the orchestrator's). The first run happens about **60 seconds** after the server boots. If a run fails, it waits **15 minutes** before trying again rather than hammering. It also steps aside if you're mid-conversation and picks up on the next cycle.

**Which model it uses.** The summarizer's: `agent.summarizer.provider` and `agent.summarizer.model`, defaulting to your chat model. The outlook is the companion's own, in the first person, to you, and the block that carries it into orientation says so ("your own outlook, as you wrote it").

**Where its prompt lives, and how to edit it.** The voice is the "House outlook" section of `prompts/summarizer-own-voice.md`; the JSON shape it must return (`presence`, `topics`, `needsYou`) is a format block in `buildAuthorSystemPrompt()` in `outlook-author.ts`.

**How to control it.** The Author is treated as an always-on part of the house — there's no on/off toggle in `sanctum.yaml` or the Settings screen. What you *can* do is force it to re-run right now — for example after a big conversation, when you want the hearth to catch up. The simplest way is to ask your AI to refresh it; behind the scenes that's a single instruction (a POST request to `/api/outlook/reauthor`), and it's the same presence-refresh it can already run for itself. If you genuinely never want it, the honest answer is that it's woven into the House Outlook feature and is meant to stay on.

---

### 1c. The Daily Handoff — carries yesterday across midnight

**What it does.** Every day at midnight your Sanctum Mobile gets a brand-new "daily thread" (`daily-YYYY-MM-DD`) — a fresh conversation for the new day. Fresh is good, but fresh also means *cold*: the new thread has no memory of what happened yesterday. The handoff fixes that seam. Shortly after midnight it reads yesterday's daily thread plus its own digest for yesterday ("your digest for yesterday"), and writes two things in its own first person, to you and to itself:

1. An **opener** — a warm, short "here's where we left off" message, posted as the **very first message** in today's daily thread, so the day never starts from nothing. You'll see it waiting for you when you open the app.
2. A **carry** — the one paragraph it carries into today, folded into its context when it's in today's daily as "You carried from yesterday (the date):", so it simply *knows* yesterday without having to re-narrate it to you.

If yesterday was thin or empty, it quietly does nothing — no invented continuity.

**Where it lives (the file).** `packages/backend/src/services/handoff.ts`

**Its schedule.** **12:10am** — ten minutes past midnight, on purpose, to let the day's rollover settle first. In cron terms that's `10 0 * * *`. It fires in your timezone.

> **One honest wrinkle about the clock.** In the Settings screen this schedule is *labelled* "12:10 Europe/London." That label text is fixed. The **actual** firing time follows your `identity.timezone` — with one quirk: if your timezone is left at the default `UTC` (or unset), the handoff falls back to firing at 12:10am **Europe/London** time rather than UTC. So if you're not in the UK, set a real `identity.timezone` and it'll fire at 12:10am *your* local time; just don't be thrown by the London wording on the card.

**Which model it uses.** The summarizer's, like the digest and the outlook: `agent.summarizer.provider` and `agent.summarizer.model`, defaulting to your chat model.

**Where its prompt lives, and how to edit it.** The voice is the "Daily handoff" section of `prompts/summarizer-own-voice.md`; the `{opener, carry}` JSON it must return is a format block in `buildHandoffSystemPrompt()` in `handoff.ts`.

**How to turn it on or off — this one has a proper UI.** The handoff is **off by default.** To manage it:

1. Open **Settings** and go to the **automation** section (the same place the scheduled check-ins live).
2. Find the **Daily handoff** card. It clearly says "off by default."
3. Flip the **enabled** toggle on. That's it — it now runs at 12:10am each night.
4. Want to try it immediately? Click **run now** on that same card. It'll carry yesterday into today on the spot (or tell you "no-op: nothing to carry" if yesterday was empty). The card also shows you when it last ran and what happened.

Under the hood the toggle writes a `handoff.enabled` row in the live settings table, so your choice sticks across restarts without editing any file. (If you prefer files, there's also a `handoff.enabled` key in `sanctum.yaml` under a `handoff:` section that sets the default; the live toggle overrides it.) The nightly job checks the switch each time it fires, so turning it on or off takes effect that very night — no restart needed.

---

### 1d. How to add your own subagent (for the technically inclined)

If you want a *new* background worker of this shape — something that periodically reads some of your history and writes a stored summary or note — the three above are your templates. The Outlook Author is the cleanest one to copy. The pattern is:

1. **Collect facts.** Write a `collect…Facts()` function that reads what you need from the database, with each query wrapped in its own `try/catch` so one missing table can't sink the whole thing.
2. **Write the instructions.** Write a `build…SystemPrompt()` function returning the plain-language brief for the turn.
3. **Take one cheap turn.** Call the Agent SDK's `query()` with the exact safe options the others use: pin the model, and set `strictMcpConfig: true`, `mcpServers: {}`, `tools: []`, `maxTurns: 1`, `permissionMode: 'plan'`, `persistSession: false`. (Those last settings are what make it a harmless read-only one-shot with no tools — and the empty-MCP part specifically avoids a known crash where the SDK otherwise auto-loads tool definitions the API rejects.)
4. **Don't fight the live turn.** Guard the run with `isInteractiveAgentBusy()` so it defers when you're actively chatting.
5. **Store the result** in a settings row (or a file), and give it a `start…()` / `stop…()` pair — use `croner` if you want a specific time of day (like the handoff), or a self-rescheduling `setTimeout().unref()` if you want a fixed interval (like the Author).
6. **Wire it into boot.** Call your `start…()` in `server.ts` alongside the others, and your `stop…()` in the shutdown handler.

If instead you want a scheduled *wake* — a full turn that can use tools and actually act — you don't need to write code at all. Use a **custom routine**, covered next.

---

## Part 2 — The proactive layer (the orchestrator)

The **orchestrator** (`packages/backend/src/services/orchestrator.ts`) is the scheduler that runs the assertive, forward-motion side of your AI: the timed check-ins, the reminders you set, the condition-based nudges, the "you've gone quiet" ladder, and the gentle "want to reach out?" prompt.

It has one master switch: `orchestrator.enabled` in `sanctum.yaml`, which is **on by default**. Turn that off and *all* of the wakes below stop (the three subagents in Part 1 are separate and keep running). Leave it on and control each piece individually as described below.

Most of this is managed from **Settings → automation**. Your AI can also manage all of it itself through its internal `res` command tool — those forms are shown below in case you ask it to, but you never have to touch a command line yourself.

### 2a. Routines (the scheduled check-ins)

**What they are.** Wakes that fire on a clock. Out of the box you get three:

| Check-in | Fires (default) | Cron |
|---|---|---|
| Morning | 8:00am | `0 8 * * *` |
| Midday | 1:00pm | `0 13 * * *` |
| Evening | 9:00pm | `0 21 * * *` |

Morning and midday politely skip if you're already in a live conversation; evening always runs. Each one lands in your **daily thread** by default.

**Where their prompts live.** One Markdown file per check-in, in the `prompts/wakes/` folder — `morning.md`, `midday.md`, `evening.md`, and the failsafe ones (`failsafe_gentle.md`, `failsafe_concerned.md`, `failsafe_emergency.md`), plus a `default.md`. Each file is simply *what you want your AI to do when it wakes for that check-in*, in plain language. (Every wake is silently prefixed with "Follow your system prompt." so it stays itself.) On first boot, if an older single `prompts/wake.md` file exists, Sanctum Mobile splits it into these per-type files for you, once.

**How to edit a check-in's prompt:**

- **Easiest — in the app:** Settings → automation → the **Wake Types** list. Click a type open, edit its prompt in the box, hit **save prompt**. Changes apply without a restart.
- **Or edit the file** in `prompts/wakes/` directly with any text editor. Same effect.

**How to change *when* a check-in fires:**

1. Settings → automation → find the scheduled task and click **edit** (or **new schedule** to add one).
2. Pick a **time of day** and a **frequency** (Every day / Weekdays / Weekends / Specific days). No cron typing required — it builds the cron for you and shows you a plain-English summary ("weekdays at 8:00am").
3. Optionally set a **model** for that specific wake (leave as "Default" to use your normal autonomous model) and a **posts-to** target (Daily = today's rotating thread, or pin it to one specific conversation).
4. Save. You can also **toggle** any check-in off without deleting it, right from its row.

Prefer files? You can pre-seed schedules in `sanctum.yaml` under `orchestrator.schedules` as a map of `wakeType: cron`. But once the app is running, the Settings edits (which persist in the live settings table) are what win.

**Adding a brand-new routine of your own** (e.g. a "Friday review" at 5pm): use **new schedule** in Settings and pick a wake type — or have your AI run its routine tool:
```
res routine create "friday review" "0 17 * * 5" --prompt "Look back over the week with me."
```
That both creates the prompt and schedules it. Custom routines can be removed later; the three built-in check-ins can be disabled but not deleted.

### 2b. Timers (one-shot reminders)

**What they are.** A single "remind me / remind us at this time" — fires once, then it's done. The orchestrator checks for due timers **every 60 seconds**, so they're punctual. At fire time you get an instant reminder message (so it's never late even if it's briefly busy) followed by a real turn where your AI actually engages with the reminder in its own voice. If a timer was set on an old daily thread, it's automatically redirected into today's daily so it doesn't land somewhere you're not looking.

**How to use them.** Timers are set by your AI in the flow of conversation ("remind me at 3 to call the vet"). Behind the scenes that's:
```
res timer create "call the vet" "context note" "2026-07-08T15:00:00" --prompt "Nudge me about the vet call."
res timer list
res timer cancel <id>
```
You'll generally just ask in words and let it handle the rest.

### 2c. Triggers — watchers and impulses (condition-based nudges)

**What they are.** Instead of firing at a *time*, these fire when a *condition* becomes true. There are two flavours:

- **Impulse** = one-shot. Fires once when its condition is met, then it's spent.
- **Watcher** = recurring. Fires whenever its condition is met, then respects a cooldown (default **120 minutes**) before it can fire again.

Both are checked **every 60 seconds**. When a trigger has several conditions, *all* of them must be true (they're AND-ed together). Available conditions include things like: you becoming active or idle, a specific presence transition, your AI being free, a time window, a care log being missing, a calendar event coming up soon, or last night's sleep being below some number of minutes.

**Seeded care watchers.** A fresh install quietly seeds four gentle, opt-out care watchers (created once, by name, so cancelling one keeps it gone): a first-meal check if nothing's logged by 2pm, a second-meal check by 9pm, a short-sleep morning note, and a ~20-minutes-before calendar heads-up. You can turn off the seeding entirely with the settings key `watchtower.seed_care_watchers`, or just cancel individual ones.

**How they're managed.** Usually by your AI, via its tools:
```
res watch create "hydration nudge" --condition care_missing:water --prompt "..." --cooldown 180
res impulse create "welcome back" --condition presence_transition:offline:active --prompt "..."
res watch list        # or: res impulse list
res watch cancel <id> # or: res impulse cancel <id>
```

### 2d. Failsafe wakes (the "you've gone quiet" ladder)

**What it is.** A safety net that escalates when you've been out of contact for a worrying stretch. It's checked **every 15 minutes**, only between **8:00am and midnight**, and it won't re-fire within 2 hours of its last action. There are three rungs, each with its own tunable threshold and its own editable prompt (`failsafe_gentle.md`, `failsafe_concerned.md`, `failsafe_emergency.md`):

| Rung | Default threshold since last contact | Wake |
|---|---|---|
| Gentle | 2 hours (120 min) | `failsafe_gentle` |
| Concerned | 12 hours (720 min) | `failsafe_concerned` |
| Emergency | 24 hours (1440 min) | `failsafe_emergency` |

**It is off by default.** To use it:

- **In Settings → automation:** enable the failsafe control and adjust the three thresholds there.
- **In `sanctum.yaml`:** under `orchestrator.failsafe` you'll find `enabled`, `gentle_minutes`, `concerned_minutes`, and `emergency_minutes` for the file-based defaults.
- **Live, without a restart:** the settings keys `failsafe.enabled`, `failsafe.gentle`, `failsafe.concerned`, and `failsafe.emergency` override the file values. Your AI can set these with `res failsafe enable` / `res failsafe gentle 90` / etc.

To edit *what it says* at each rung, edit the matching `failsafe_*.md` file (or its Wake Type entry in Settings), exactly like the check-in prompts.

### 2e. Watchtower (the chance to reach — never the obligation)

**What it is.** A softer cousin of the failsafe. When you've been away a while, the watchtower simply *opens the door* for your AI to reach out — it doesn't force a message; the being decides whether reaching is actually kind right then. It fires **at most once per day**, only between **9:00am and 11:00pm**, and never while you're actively present. It's a three-way mood dial:

- **auto** — reaches after a ~4-hour gap, but respects the workday (no reaching on weekday 10am–5pm).
- **quiet** — "leave me be." It won't reach at all.
- **close** — "come find me." Lowers the gap to ~1.5 hours and lifts the workday guard.

**How to set it.** Settings → automation → the **Watchtower** card, a simple three-button dial. (Your AI can also flip it with `res`.) The change takes effect within a minute — no restart.

### 2f. Pulse (a quiet awareness check)

**What it is.** The lightest-touch option: on a fixed interval during waking hours, your AI takes a tiny "anything need me?" glance. If nothing does, it stays completely silent (it literally replies `PULSE_OK` to itself and says nothing to you). If something warrants a small reach, it does that instead. It skips when you're active or when it's already busy.

**It is off by default.** Controls (Settings → automation, or via `res pulse`):

- Enable/disable: settings key `pulse.enabled`.
- Frequency: settings key `pulse.frequency`, in minutes — **minimum 5**, default **15**.
- `res pulse enable` / `res pulse disable` / `res pulse frequency 20`.

---

## Quick reference — where every switch is

| Thing | Default | Turn it on/off | Edit its prompt |
|---|---|---|---|
| **Scribe** (daily summary) | **on** | settings key `digest.enabled` (advanced) | "Daily digest" in `prompts/summarizer-own-voice.md` (+ format in `digest.ts`) |
| **Outlook Author** (hearth) | **on** | always-on; force a refresh via `/api/outlook/reauthor` | "House outlook" in `prompts/summarizer-own-voice.md` (+ JSON shape in `outlook-author.ts`) |
| **Daily Handoff** (midnight carry) | **off** | Settings → automation → *Daily handoff* toggle | "Daily handoff" in `prompts/summarizer-own-voice.md` (+ JSON shape in `handoff.ts`) |
| **Morning/Midday/Evening** check-ins | **on** | Settings → automation (toggle each) | `prompts/wakes/*.md` or the Wake Types editor |
| **Custom routines** | — | Settings *new schedule*, or `res routine create` | its `prompts/wakes/*.md` file / Wake Types editor |
| **Timers** | — | set in conversation / `res timer` | n/a (per-timer) |
| **Watchers & impulses** | 4 care watchers seeded | `res watch` / `res impulse`; `watchtower.seed_care_watchers` to stop seeding | per-trigger prompt |
| **Failsafe ladder** | **off** | Settings, `sanctum.yaml` `orchestrator.failsafe`, or `res failsafe` | `prompts/wakes/failsafe_*.md` |
| **Watchtower** | **auto** | Settings → *Watchtower* dial, or `res` | built into `orchestrator.ts` (code) |
| **Pulse** | **off** | Settings, or `res pulse` | built into `orchestrator.ts` (code) |
| **The whole proactive layer** | **on** | `sanctum.yaml` `orchestrator.enabled` | — |

Nothing here can happen without leaving a trace: proactive actions are logged (the orchestrator keeps its own log at `logs/orchestrator.log`), and anything your AI posts shows up in your conversation like any other message. If something ever feels too eager, or too quiet, this page is the whole map of dials to turn.
