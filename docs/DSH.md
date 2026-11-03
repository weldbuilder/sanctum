# DeepSeek Harness (dsh) provider

dsh is a third harness beside Claude Code and Codex: `agent.provider: "dsh"` (or `AGENT_PROVIDER=dsh`). It is **alpha**. The adapter is written for `@deepseek-ai/dsh@0.2.1-alpha.2`; pin that exact version, because dsh's session format and patch schema are still moving.

```
npm i -g @deepseek-ai/dsh@0.2.1-alpha.2
```

## Configure

Setup offers it as the third harness: the in-app onboarding (**Connect your AI → DeepSeek**: a DeepSeek API key, checked against DeepSeek after making sure dsh is installed) and `npm run setup` (**3) DeepSeek Harness**: the model id and the key). The key goes to `.env` as `DEEPSEEK_API_KEY`, or under the variable `agent.dsh.api_key_env` names; never into `sanctum.yaml`. The route, base url and autonomous model are in Settings. Setup does not offer the harness's built-in memory on dsh: it has none.

By hand:

See the `agent.dsh` block in `sanctum.example.yaml`. Set a model route and the name of the environment variable that holds its API key (the key itself never goes in the file):

```yaml
agent:
  provider: "dsh"
  dsh:
    model_provider: "openai"      # a dsh llm route; "" = deepseek-official
    model: "gpt-5"
    api_key_env: "OPENAI_API_KEY"
```

With the default route, export `DEEPSEEK_API_KEY` (or store it through dsh's credentials). A **sealed public Discord run** reads only the environment: it gets an empty dsh home of its own, so credentials stored in your home, your `cordis.patch.yml` layers and your `.env` never reach it, and its `HOME`/`USERPROFILE` point at the run's own scratch folder. Put the route's key in the backend's environment (`DEEPSEEK_API_KEY`, or the variable named by `api_key_env`) or the public lane stays silent and says so once. Rolling context (`agent.rolling.dsh`, default on) works as on Codex: the app owns the history and every turn is a fresh run.

## How a turn runs

Each turn spawns `dsh --profile headless --patch <overlay> [--session-id <id>] --json -` in `agent.cwd`, with the prompt on stdin and these environment variables:

| Variable | Value |
|---|---|
| `DSH_TELEMETRY_MODE` | `DISABLED`, on every run |
| `DSH_PERMISSION_MODE` | `agent.dsh.sandbox_mode` (`read-only` for digest/handoff/outlook helpers) |
| `DSH_HOME` | `agent.dsh.home`, if set. A sealed (public Discord) run never uses it: it gets an empty home of its own in the run's temp root |

The child gets an allowlisted environment, not a copy of the backend's: `PATH`, `HOME`, locale and terminal variables, proxy and certificate variables, the route's API key variable (`api_key_env`, or `DEEPSEEK_API_KEY` on the default route), and the `DSH_*` and `TMPDIR` values the adapter sets. Any inherited `DSH_*` is dropped.

The run's temp root holds the overlay (it carries MCP headers), the run's `TMPDIR`, and, for throwaway runs, the session log and storage. It is always removed, including on timeout, abort and crash. A run is limited to 30 minutes; a stop or timeout sends SIGTERM, then SIGKILL after one second, and a child that prints its final event but does not exit is killed after three seconds.

The overlay sets:

- **Approvals:** policy `never`, with every sandbox mode paired to it so dsh's permission plugin loads cleanly. `never` rejects a request that would have asked, meaning an escalation out of the sandbox. Tool calls that stay inside the sandbox do not ask, so they run. This matches Codex's `approval_policy="never"`.
- **Persona:** the base prompt followed by the identity (a main run), with dsh's own "powered by DeepSeek Harness" opener off.
- **Model and route:** from `agent.dsh`.
- **Session title:** dsh's hidden title call is disabled (it is a second model call per run that nothing reads).
- **MCP:** one `@deepseek-ai/dsh-mcp-client` entry per `.mcp.json` server (stdio, or HTTP with headers).
- **Throwaway runs** (rolling, one-shot helpers): the session log and the storage directory (its projection cache holds the first prompt, which carries memory and history) point into the temp root.
- **Summarizer:** also turns `AGENTS.md` discovery off, as `noProjectDocs` does on Codex.

Three layers, as on Codex: the base prompt (`<agent.cwd>/config/dsh-base-prompt.md`, else `agent.dsh.base_instructions_file`, which ships as `prompts/dsh-base-prompt.md`; only if neither file exists is dsh's stock headless persona used), the identity files (added after the base prompt in the same system prompt, on every main run, rolling or not; helper runs do not get them, and the public lane's run gets the identity it builds for itself, after the fixed public base prompt), and `AGENTS.md`, which dsh loads itself.

dsh interpolates `{{name}}` in persona text and fails assembly on an unknown one, and the persona mechanism has no escape for it, so the whole persona (base prompt and identity alike) goes through `defangTemplate`: every `{{` becomes `{ {`. The identity text therefore reaches dsh with a space inside any double brace, which the message path never did to it. Identity files are prose, so this rarely shows; avoid literal `{{` in them.

The shipped base prompt is the same harness Claude and Codex get: one shared base plus a short dsh tail, joined by `npm run prompts:build` (see `prompts/README.md`). Before it shipped, a home without its own `config/dsh-base-prompt.md` ran on dsh's stock persona. The starter home ships a copy in `config/`; an existing home keeps whatever it has until you copy the file in, because the home's copy wins.

## What you get over Codex

Tool calls and results arrive as events. The adapter feeds them to the app's own tool hooks under Claude names (`read` becomes `Read`, `bash` becomes `Bash`, `mcp__server__tool` is unchanged), so the tool timeline and audit log work. The hooks run after dsh has acted, so their deny rules (destructive-bash and write-prefix guards) are logged only; dsh's sandbox is what contains the run. A shell command that exits non-zero is shown as an error, though dsh calls it completed. MCP servers can use HTTP headers directly.

Only a turn that ends `completed` is a success; aborted, blocked and max-token endings, and stdout `error` events, become error results. The context meter shows the last step's input (including cache reads) plus output; spend is the sum over steps.

## Known limits

- Text arrives once per step, not token by token.
- `base_url` sets the endpoint of a route dsh's model catalog already knows (for example `openai`, `anthropic`, `openrouter`). It is not a generic gateway setting: a gateway the catalog has never heard of also needs a hand-written `api` and `models` patch, which this adapter does not generate. Whether `base_url` is applied has not been proven against a live run.
- dsh has no network switch (`network_access` is ignored) and no extra-directory setting (`additional_directories` is ignored).
- MCP server names must be 1-32 letters, digits, `_` or `-`; others are skipped with a warning.
- Optional approvals through a dsh answerer plugin are not built: approvals are off.
- Settings lists dsh in the provider picker (Settings, Preferences, Model). With dsh selected it edits `agent.dsh`: chat model, autonomous model (blank = same as chat), route, base url and the API key variable's name. Saves write `sanctum.yaml`; a provider change applies on restart. Chat runs on `model`; wakes and the digest/handoff/outlook helpers run on `model_autonomous`, falling back to `model` when it is blank.

## OpenRouter

```yaml
agent:
  provider: "dsh"
  dsh:
    model_provider: "openrouter"
    model: "deepseek/deepseek-chat"
    api_key_env: "OPENROUTER_API_KEY"
```

Put `OPENROUTER_API_KEY=<your key>` in `.env` (the real key goes there only, never in `sanctum.yaml`) and restart. The model ids are OpenRouter's; check the route's catalog before relying on one.
