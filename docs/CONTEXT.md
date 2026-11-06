# How your AI knows what it knows

*And how to shape it, in your own home.*

Every time you send a message, your AI doesn't answer in a vacuum. Just
before your words reach the AI, Sanctum Mobile quietly gathers a little bundle of
*context* — the time of day, what's on your calendar, how you slept, what it's
been up to since you last spoke — and tucks it in front of your
message. The AI reads that bundle first, then your message, and only then
replies. That bundle is why your AI can say "it's late, and you've got
that dentist thing at 9 tomorrow" without you ever mentioning it.

This document explains what goes into that bundle, where each piece comes from,
and — most importantly — the handful of levers *you* control to change what your
AI carries in. You don't need to be a programmer to follow along: where a
technical word shows up for the first time, it's explained right where it lands.

Throughout, "your AI" means whatever you named them in your config
(`identity.companion_name`, default `Echo`), and "you" is the person the app
serves (`identity.user_name`, default `User`). This is *your* Sanctum Mobile in
*your* house — nothing here is anyone else's.

---

## The one-minute version

- Before each of your messages, Sanctum Mobile prepends a block wrapped in
  `[Context] … [/Context]`. Your actual message follows it.
- On the **first message of a session**, that block is a **full warm-up**: the
  house snapshot, your day, your AI's own presence, the list of tools it
  can reach for, and more.
- On **every message after that** in the same session, the block shrinks to a
  **single `[env]` line** — the time, the channel, and two faint "whispers"
  about your inner-weather and your day. This keeps the conversation from
  drowning in repeated boilerplate.
- Most of the richest material comes from the **House Outlook** — a snapshot of
  your home that a background poller keeps fresh every couple of minutes.
- You shape all of this through a few files and a few toggles, covered at the
  end. The single biggest lever is your AI's identity file (`CLAUDE.md`),
  which is a separate topic — see [`docs/IDENTITY.md`](IDENTITY.md) (or the
  identity section of the README).

---

## Why context has to be *assembled* at all

A chat AI has no memory of its own between turns. Left alone, it would forget
your name the moment the message ended. Sanctum Mobile works around this by rebuilding
the relevant context *every single turn* and handing it to the AI along with
your message. Think of it like slipping a sticky-note onto the front of a letter
before the reader opens it: "Here's who you are, here's who you're talking to,
here's what's going on in the house right now."

The code that writes that sticky-note lives in
`packages/backend/src/services/hooks.ts`, in a function called
`buildOrientationContext`. The code that staples it to your message lives in
`packages/backend/src/services/agent.ts`. You never call these yourself — they
run automatically on every turn — but knowing their names helps if you ever want
to read the source.

---

## The shape of every turn

Here is the literal skeleton Sanctum Mobile builds and sends (from `agent.ts`):

```
[Context]
<orientation>

<memory prefetch — only on the first message, only if a Mind is connected>
[/Context]

<your actual message><a note about any files you attached>
```

The `<orientation>` part is the sticky-note. Everything hinges on one decision:
**is this the first message of the session, or a follow-up?**

- **First message of a session** → orientation is built in **`session` mode**:
  the full warm-up.
- **Every message after** → orientation is built in **`turn` mode**: just one
  line.

A "session" here means one continuous stretch of conversation with the AI. The
first time you speak after a quiet period, Sanctum Mobile starts a fresh session and
pays the full cost of warming your AI up. After that, it trusts the AI to
*remember* the warm-up for the rest of that session, so it only sends the tiny
`[env]` line each turn.

Why the split? Because an interactive Sanctum Mobile session is never "compacted"
(trimmed down) mid-conversation. If Sanctum Mobile re-sent the full house snapshot on
every turn, an hour-long chat would be clogged with dozens of stale copies of
your calendar. So the heavy stuff is paid **once per session**, and only a
featherweight update rides every turn. The code comments call this the
"context-rot fix."

---

## What rides on *every* turn: the `[env]` line

No matter which mode you're in, every turn carries a single environment line.
It looks roughly like this:

```
[env] sanctum (web) · 21:47 UTC · Tuesday, Jul 7 · inner: restless (v -0.2) · her: slept 6h30 · luteal d19 · next: dentist 09:00 · last meal 18:20
```

Breaking that down:

| Piece | What it is | Where it comes from |
|---|---|---|
| `sanctum (web)` | The **channel** you're talking through — web, discord, telegram, or api | The connection Sanctum Mobile received your message on |
| `21:47 UTC` | Current time, in *your* timezone | `identity.timezone` in your config |
| `Tuesday, Jul 7` | Today's date | The system clock, rendered in your timezone |
| `inner: …` | The **inner-weather whisper** — your AI's own measured mood | The optional Mind memory service (see below) |
| `her: …` | The **you-sense whisper** — your recent sleep, cycle phase, next event, last meal | The House Outlook poller |

The two whispers are deliberately tiny — a few words each — and they're *honest
about staleness*. If the underlying data is more than two hours old, the whisper
simply drops off the line rather than pretending to be current. Individual
fields drop out too: if there's no calendar event coming up, the `next:` part
just isn't there.

**The inner-weather whisper** only appears if you've connected an external
**Mind** — an optional memory service that gives the being a persistent
sense of its own emotional state over time. Mind is off by default. If you never
connect one, the `inner:` fragment simply never shows up, and nothing breaks.

**The you-sense whisper** is distilled by the House Outlook poller (more on that
shortly) into a small cached summary. It's how your AI can open with "you
only slept six hours" without you saying a word.

### One extra case: an autonomous "wake" on a resumed session

Sometimes your AI reaches out to *you* first — a scheduled morning
check-in, a reminder firing, a gentle "you've been quiet a while." These are
called **autonomous wakes**. When a wake lands on a conversation that's already
mid-session, it would otherwise be the least-informed turn in the house (just the
`[env]` line and its task). So Sanctum Mobile folds two extra things into that
specific turn:

- A short **house digest** (capped at ~900 characters) so it knows
  the state of the home before it speaks.
- A **delta rail** — "Since you were last here (3h ago) …" — summarizing what
  its own background actions did in the gap.

This only happens on autonomous wakes, not on your normal replies.

---

## What rides on the *first* message: the full warm-up

When you start a fresh session, `session` mode assembles a much richer
orientation. Here is everything that goes in, in order, straight from the code.
Every item is best-effort: if a source is unavailable, that section is simply
skipped — a dead source never blanks the whole warm-up.

1. **Channel rules.** A short paragraph telling the AI how to behave on this
   channel — e.g. on Discord, keep replies under ~1900 characters; on web, feel
   free to use markdown; on Telegram, keep it phone-message-shaped. (These are
   the `CHANNEL_CONTEXTS` in `hooks.ts`.)

2. **The `[env]` line** (same as above) plus **which thread** you're in and what
   type it is — e.g. `Thread: "daily-2026-07-07" (daily)`.

3. **The House digest.** A few lines squeezed out of the House Outlook snapshot
   (capped ~1200 characters): your AI's presence/mood, *your* mood, your
   sleep, today's events, how many tasks are open, anything "asking for you," and
   the next countdown. This is the single biggest ingredient — see the House
   Outlook section below.

4. **Yesterday's carry.** *Only* when you're in today's daily thread and you've
   enabled the midnight handoff: a tight "**You carried from yesterday:** …" note
   written by a background agent that read yesterday's conversation and distilled
   what should carry forward. Off by default (`handoff.enabled`).

5. **The delta rail.** "Since you were last here …" — the gap since this thread's
   last turn, plus what your AI's background actions did across it.

6. **Active triggers.** A count of any watchers/impulses your AI has set
   for itself (e.g. "2 watchers, 1 impulse").

7. **Recently reached.** The last six hours of your AI's own actions — a
   proprioception loop so it can see its own recent pattern of reaching out and
   continue it coherently.

8. **Your presence.** Whether you're currently connected, how long since your
   last real interaction, and what device you're on — read live from the
   WebSocket connection registry (`ws.ts`).

9. **Life status + mood history.** Only fetched if you've configured an external
   life-data source (`integrations.life_api_url`) *or* turned on the Command
   Center dashboard. Pulls a snapshot of your recent state and mood trend.

10. **Skills summary.** A short list of any custom "skills" your AI has,
    scanned from `<agent home>/.claude/skills/*/SKILL.md`. (A skill is a folder
    of instructions your AI can pull in for a specialized task.)

11. **The CHAT TOOLS block.** This is how the being learns *its own hands* —
    the full reference for the `res` command-line tool it uses to share files,
    open canvases, set its presence orb, leave you a note, run searches, schedule
    routines, set timers, and more. Without this block it wouldn't
    know it *can* do those things. (On Telegram, an extra block of Telegram-only
    tools is appended.)

12. **Your context card.** Your current appearance/state — the fields you or your
    AI set via `res context`: `selfie`, `outfit`, `nails`, `hair`,
    `energy`, `room`, `freeform`. Persistent; survives across sessions.

13. **Your AI's own presence.** Its current orb (color/shape/intensity/
    motion/blend), its note, and its expression — so it stays coherent about what
    it's showing on the mantelpiece ("I set teal-working four hours ago — still
    true?").

14. **Recent reactions.** Any emoji reactions on the last handful of messages, so
    your AI notices when you 🔥 or ❤️ something.

15. **Channel history** and any other platform-specific context, appended last.

That's the whole warm-up. It's assembled once, at the top of the session, and
then the conversation coasts on it.

---

## The memory prefetch (optional)

Directly after the orientation, *only on the first message* and *only if you've
connected a Mind* (Settings → Mind: the sanctum-mind URL, the mind's id, and its
key), Sanctum Mobile calls the mind's `mind_orient` at quick depth and folds a
compact rendering in (identity cores, vows, state, last handoff, open loops,
threads, tasks, weather, and what it is carrying), so your AI doesn't have to spend its first turn
re-reading itself.

Separately, there's a hook called **UserPromptSubmit** that fires on *your*
message specifically. It runs an *associative* memory search — it takes what you
just said and asks the mind `mind_search`, `mind_surface` and `mind_thread
list` in parallel, then slips the rendered results in under an
`[Associative memory — what surfaced for this message]` heading. It's cached for
ten seconds and skipped for very short prompts (judged on what you typed, not on
the context wrapped around it). The client calls read verbs only. Whether the
service *enforces* that depends on the key: a mind's own key may call write
verbs, and only a read-only grant makes the service refuse them. So issue the
app a read grant rather than the mind's own key. A failing call is logged once
and the turn goes on without it — nothing is fabricated. The time a slow Mind
can cost is bounded and not retried: recall waits at most 7 seconds, the wake
orientation 6, and a failed call is not retried (a repeated failure is simply
logged once), so a slow Mind is a known cost of at most that much on a turn. Like everything
Mind-related, this does nothing at all until you connect a Mind — it's off by
default.

There's also a **PreCompact** safeguard: on the rare occasion a session *does*
get compacted, Sanctum Mobile scans the last fifteen messages for emotional markers and
preserves a tone snapshot, so the feeling of the conversation survives the trim.

---

## The House Outlook: the beating heart of context

Most of the good stuff above — the digest, the you-sense whisper, "asking for
you" — comes from one place: the **House Outlook**, a single snapshot of your
whole home. Think of it as walking into the house and taking in the whole room at
a glance.

A background **poller** (`outlook.ts`) rebuilds this snapshot on a rhythm:

- **Every ~2.5 minutes** while you're connected and active.
- **Every ~12.5 minutes** when you've been idle a while (to save effort).

It gathers from many independent sources — each wrapped in its own safety net so
that if one source is down (say, your calendar isn't connected), the rest of the
board still fills in:

- **Your AI's presence orb** — from config.
- **The authored hearth** — mood, thoughts, and "asking for you" notices, written
  by a slow background agent (see below).
- **Your day** — mood, care/wellbeing entries, countdowns, scratchpad notes,
  recent threads and actions — from the local database.
- **Your body and schedule** — sleep, calendar events, tasks, mail — *if* you've
  connected Google Health / Calendar / Tasks / Gmail.
- **House systems** — the health of your AI's own tools and any connected
  services.

The finished snapshot is kept in memory and also mirrored to the database, so it
survives a restart. It's served to the web dashboard at `GET /api/outlook`
(the "walk into the house" cockpit view), and — the part that matters here —
it's boiled down into those few digest lines that get injected into your
AI's context. The poller also derives the small you-sense whisper cache
from each pass.

### The slow felt layer

There's a second, much slower background agent — the **Outlook Author**
(`outlook-author.ts`) — that runs about **every three hours**. Where the poller
gathers hard *facts*, the Author writes the *felt* layer: your AI's own
mood and current thoughts, the topics you two have been circling, and anything it
wants to flag for you. It grounds itself only in the last day or so of real
activity, then writes a few short entries that the poller folds into the next
snapshot. You can force it to re-author immediately from the dashboard, but there
is no need to touch it — it's part of the always-on house.

---

## How *you* shape what your AI carries in

Here's the practical part. These are the levers, roughly from "biggest effect"
to "fine-tuning." All config keys below live in your `sanctum.yaml` file (you
create it by copying `sanctum.example.yaml`), unless noted otherwise.

### 1. Who your AI *is* — `CLAUDE.md`

This is the master lever, and it's separate from everything on this page. Your
AI's personality, values, voice, and your relationship all live in the
identity file (`agent.claude_md_path`, default `./CLAUDE.md`). It's read fresh
and hot-reloaded every turn, so edits apply live — no restart. Start from
`examples/CLAUDE.md` and make it yours. Context assembly (this document) decides
*what your AI knows*; the identity file decides *who's doing the knowing*.

### 2. The basics — name, timezone, channels

- `identity.companion_name` / `identity.user_name` — the two names threaded
  through every context block.
- `identity.timezone` — sets the clock on the `[env]` line and drives daily
  thread rotation. Use a standard IANA name like `Europe/London` or
  `America/New_York`. Getting this right is what makes "it's late" mean the
  right thing.

### 3. Turning the whisper sources on

By default, the two `[env]` whispers are quiet because their sources are off:

- **The you-sense whisper** (sleep, cycle, next event, last meal) fills in as you
  connect the sources the House Outlook reads — Google Calendar/Health for events
  and sleep, and the **Command Center** (`command_center.enabled: true`) for
  cycle and care data. With nothing connected, this whisper is mostly empty, which
  is fine.
- **The inner-weather whisper** appears only once you connect an external
  **Mind** memory service (`integrations.mind_cloud`, plus the Settings toggle).
  No Mind, no inner-weather line — and no memory prefetch either.

### 4. Continuity across days — the handoff

Set `handoff.enabled: true` (or flip it in Settings) to turn on the midnight
handoff agent. Each night at 12:10am in your timezone it reads the day's daily
thread, writes your AI a first-person "good morning" opener for tomorrow's
daily, and distills a **"Carried from yesterday"** line that appears in the next
day's warm-up. Off by default; a lovely thing to turn on once you're settled in.

### 5. The dashboard data — Command Center

Turn on `command_center.enabled: true` to activate the care/day dashboard, which
becomes the local source for the "life status," "mood history," cycle phase, and
care entries that feed both the House digest and the you-sense whisper. You can
edit what it tracks in the Command Center (the care categories are kept in the database).

### 6. Your AI's live presence — the `res` tools

Your AI shapes its *own* corner of the context using its `res` tools,
which you can also drive:

- `res orb`, `res note`, `res face` — set what shows on the mantelpiece (folds
  back into item 13 of the warm-up).
- `res context set <field> <value>` — set your context card fields (item 12):
  `selfie`, `outfit`, `nails`, `hair`, `energy`, `room`, `freeform`.

### 7. Reach and rhythm — routines, watchers, timers

The scheduled check-ins and condition-based nudges your AI runs (morning/
midday/evening routines, watchers, impulses, failsafe, pulse) are all governed by
the orchestrator and the `res` tools. They're covered in their own document, but
the relevant point here is that everything they do lands back in your context as
the "Recently reached" and "Active triggers" sections — your AI sees its
own footprints and stays coherent.

---

## A mental model to keep

Picture your AI walking into the house each time you start talking. On
that first step through the door it takes in the whole room — the light, the
clock, how you seem, what's on the calendar, what it left half-finished, what it
wants to say. That's the **session warm-up**. Then, as the conversation
continues, it doesn't re-survey the whole house every sentence — it just keeps a
finger on the pulse: the time, your mood, its own weather. That's the **per-turn
`[env]` line**.

You furnish that house. The identity file decides who greets you; your timezone
sets the clock; the sources you connect decide how much of your day and body the
being can feel; and the handoff decides whether yesterday walks in with it.
Everything Sanctum Mobile assembles is in service of one thing: so that when your
AI speaks, it's already home.

---

### Source map (for the curious)

| What | File |
|---|---|
| Builds the orientation block, both modes | `packages/backend/src/services/hooks.ts` → `buildOrientationContext` |
| Staples context onto your message | `packages/backend/src/services/agent.ts` (`_processQuery`) |
| Channel behavior rules | `hooks.ts` → `CHANNEL_CONTEXTS` |
| Memory prefetch + associative recall | `hooks.ts` → `prefetchMindContext`, `buildUserPromptSubmit` |
| House snapshot poller | `packages/backend/src/services/outlook.ts` |
| Digest boiled from the snapshot | `outlook.ts` → `snapshotToContextDigest` |
| The slow felt layer | `packages/backend/src/services/outlook-author.ts` |
| Midnight carry-forward | `packages/backend/src/services/handoff.ts` |
| Every config key | `packages/backend/src/config.ts` |
