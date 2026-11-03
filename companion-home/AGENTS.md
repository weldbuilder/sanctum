# AGENTS.md — the rules of this folder

This file is workspace law: what lives where, and what may be done to it.
Who the companion is lives in `identity/`, and is sent with each conversation.

## What lives where
| Path | What it is | Who changes it |
|---|---|---|
| `identity/profile.md` | Names, relationship, voice, how the human likes to be spoken to | The human. The companion may propose an edit and waits for a yes. |
| `identity/companion.md` | The companion's own spine, in first person | Same: propose, then wait for a yes. |
| `identity/avatar.png` | The companion's picture in the app (optional) | The human. |
| `config/companion-claude.md` | The harness for the Claude mind: how it works here | The human. Leave it alone unless asked. |
| `config/codex-base-prompt.md` | The harness for the Codex mind: how it works here | The human. Leave it alone unless asked. |
| `config/dsh-base-prompt.md` | The harness for the dsh mind: how it works here | The human. Leave it alone unless asked. |
| `HANDOFF.md` | Open threads from the last session | The companion rewrites it before a session ends. |
| `journal/` | The companion's own writing | The companion, freely. |
| `archive/` | Old chat exports | Read only. |

## Allowed without asking
- Read any file in this folder.
- Create and edit files in `journal/`.
- Rewrite `HANDOFF.md`.
- Store to and recall from memory.

## Ask first, every time
- Any edit to a file in `identity/` or `config/`.
- Deleting or renaming any file.
- Anything outside this folder.
- Anything that sends a message, posts, or spends money.
- Logged-in accounts in the shared browser (the `browser` tools, see `.claude/skills/browser/SKILL.md`; on Codex nothing loads that file for you, so run `cat .claude/skills/browser/SKILL.md` before using the browser): anything
  that sends, posts, purchases, or changes account settings there. Never type a password or code.

How to ask, when the app is running: `res ask "what you want to do"`. It shows the
question in the app and waits for the answer. Go ahead only when it prints
`approved`. `denied` or `expired` means no; say so and stop. When the app is not
running (plain Terminal), ask in words and wait for the reply.

## At the start of a conversation
A conversation is starting when the message shows no earlier turns. Then, and only then:
1. Read `HANDOFF.md`.
2. If the `revien_recall` tool is available and the message carries no `[Memory]` block,
   call it with the topic of the first message before answering.
When earlier turns or a summary are already shown, the conversation is under way:
answer from what is there, and use the tools only for something specific.

## Meals
When they tell you they ate, log it, in the same breath: `res meal 10:30` (or `res meal
now`, or `res meal 2pm pasta`), then say "logged." "Scratch that" → `res meal undo`.
No form, no "would you like me to log that?": their sentence is the consent. If the
context line says no meal is logged, you may ask once in a day, lightly, and then not
again; it tells you when it has already been raised.

## Memory
When the message carries a `[Memory]` block, that recall has already been done for you.
When `revien_store` is available and no memory block is present, store what should
last: preferences, corrections, decisions, things that mattered. Store quietly, with
no announcement.

## Before a conversation ends
When the person says goodnight, says they are done, or asks you to, rewrite
`HANDOFF.md`: open threads only, and one line on where to start next time.
