# prompts/

The text the app sends the models. The harness prompt (how the companion exists and works
inside Sanctum) is one shared base plus a short tail for each mind. It says nothing about who
the companion is: that comes from the home's `identity/` folder.

## Sources and built files

| File | What it is |
|---|---|
| `companion-base.md` | Source. The harness base, shared by every mind (about 1,400 words); each mind's built file adds its own tail. |
| `tail-claude.md` | Source. A few lines for the Claude mind, appended to the base. |
| `tail-codex.md` | Source. The same for Codex. |
| `tail-dsh.md` | Source. The same for DeepSeek Harness (dsh). |
| `companion-claude.md` | **Built**: base + Claude tail. |
| `codex-base-prompt.md` | **Built**: base + Codex tail. |
| `dsh-base-prompt.md` | **Built**: base + dsh tail. |
| `summarizer-own-voice.md` | Hand-written. The instruction for the summarizer run: the companion's own first-person voice (shared opening) and the rolling fold, merge and rebuild, the daily digest, the daily handoff and the house outlook. Names are filled from identity. |
| `codex-summarizer-prompt.md` | Deprecated. The old third-person base prompt; kept for `rolling.summarizer_instructions_file` users. |
| `discord-public-base.md` | Hand-written. The frame for the public Discord lane, which has no tools and never loads the harness. |
| `wake.md` | Hand-written. The legacy single wake prompt; the per-type files live in `prompts/wakes/`. |

**Edit the parts, not the built files.** After changing `companion-base.md` or a tail, run:

```bash
npm run prompts:build
```

(`scripts/build-prompts.mjs`.) It rewrites the three built files from base + tail, and the three
copies in `companion-home/config/` (the starter home). A change made straight to a built file is
overwritten by the next build. It never touches an existing home.

## Which mind loads which file

| Mind | Loaded from | Notes |
|---|---|---|
| Claude | `<home>/config/companion-claude.md` if it exists, else `agent.system_prompt_file` (default `./prompts/companion-claude.md`), else the `claude_code` preset | The system prompt is this frame, then the identity, then a `[Runtime] Model serving this turn: ...` line. The file is read fresh every turn; the path is read at the first use of the agent, so restart after changing it. With no home copy, `""` gives the standard `claude_code` preset with the identity appended, and no Runtime line. With neither file present, a set key logs a warning (Claude only) and falls back to the preset. Settings saves the home copy and never writes this folder. |
| Codex | `<home>/config/codex-base-prompt.md` if it exists, else `agent.codex.base_instructions_file` (`./prompts/codex-base-prompt.md`), else Codex's stock prompt | Read on every run, and written with the identity after it into one file passed as `model_instructions_file`: the system slot, as on Claude. Roughly 2,000 tokens a turn for the harness. With no base at all (`base_instructions_file: ""` and no home copy) Codex keeps its own stock prompt, and the identity goes in through `developer_instructions`, which prepends it to Codex's developer message. |
| dsh | `<home>/config/dsh-base-prompt.md` if it exists, else `agent.dsh.base_instructions_file` (`./prompts/dsh-base-prompt.md`), else dsh's stock persona | Read on every run; the identity is added after it in the same persona. Helper and public runs get the base alone. |

On all three minds the identity is in the system slot, after this harness (on stock Codex: through `developer_instructions`, ahead of Codex's own prompt). The message never carries it, and that includes the public Discord lane: its run (Claude and dsh; Codex is refused there) hands its identity to the system slot too, after the fixed public base prompt. Only the read-only helpers (digest, handoff, outlook) still carry a task brief in the message as a `[System]…[/System]` block on Codex and dsh.

**The home's `config/` copies win.** The starter home (`companion-home/config/`) ships
`companion-claude.md`, `codex-base-prompt.md` and `dsh-base-prompt.md`; a home made from it has its own copies, and the
files in this folder are only the fallback for a home without them. An existing home keeps the
copy it has until you replace it. Those copies belong to the person (see the home's `AGENTS.md`).
Rebuilding here does not touch them, so copy the built file over when you want the home on the
new text.

More: `docs/CONFIGURATION.md` (section 2 and the `agent` table), `docs/DSH.md`, `FORK_NOTES.md`.
