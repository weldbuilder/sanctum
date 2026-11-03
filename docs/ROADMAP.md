# Roadmap

*Status as of 2026-11-03. The agreed order comes from the OpenClaw gap audit (2026-10-12) and is kept in
`PLUGINS.md` under "Order"; this page is the running list of what is done, what is next, and the small
things each verification pass left behind. Update it when a PR merges.*

## Done (on main)

| # | Item | Where |
|---|---|---|
| 1 | Plugin loader, `plugins.enabled`, hash ratification, `plugins.trust` (companion default, person opt-in) | `PLUGINS.md` |
| 2 | Agent-driven browser seat (`.mcp.json` entry, MCP filter, skill) | `CONFIGURATION.md` |
| 3 | Discord: two lanes, persisted queues, fence-aware chunker, attachments, send-scan guard, holes D1–D14 (the D11 reader is done: channel card plus failure alert) | `DISCORD-PLAN.md` |
| 4 | Mind client and Mind watchdog (status, Test connection, header notice, `MIND_API_KEY` from `.env`, key never in a child env) | `CONFIGURATION.md` |
| 7 | Identity ratification: one identity source for every harness, ledger + journal with authors, boot on the verified ratified copy, Settings → Identity | `PLUGINS.md` "Identity ratification" |
| – | In-app setup wizard (first-run page, Run setup again, CLI on one declarative plan with a byte-identical replay) | `CONFIGURATION.md`, README step 8 |
| – | `npm run doctor`: config, tenants (boot scan, clashes, never-inherited table, file modes, homes) and process health checks, OK / WARN / FAIL, `--tenant`, `--json`, no secrets | `MULTI-TENANT.md`, `CONFIGURATION.md` |
| – | Skins: six rooms and materials, Extra readable, safe preview | `CONFIGURATION.md` §7 |
| 9 | Multi-tenant: built (option b): several tenants in one process, each with its own database, login, channels, scheduler and harness homes, inheriting the operator's `sanctum.yaml`; the wizard per tenant (`--tenant`) and the first-run page; household mode (the default: one login, a `/c/<id>/` path prefix per companion, `tenants.auth: per-tenant` for the hostname shape); hot park and revive of one tenant without a restart (`POST /api/internal/tenants/<id>/park` and `/revive`, behind the operator token); option (a) one clone per tenant stays documented | `MULTI-TENANT.md` |

## Next, in the agreed order

5. **Skills, three tiers** (user defaults, commons with approval, the companion's own): one `dsh-skill-filesystem` row with `customSkillDirs` in tier order; the write tool refuses a colliding name; tier 1 lives outside the companion home.
6. **Approvals and structured-questions answerer**: user-enabled, turns only.
8. **Phone as a device, inbound webhooks, Inkbox as a channel.**

Alongside: **sources of initiative** carry a scored impulse (`source, urgency, what, why, expires_at`); core
sources rewritten onto the same shape; the orchestrator ladder arbitrates on one scale (`PLUGINS.md`,
"Sources of initiative").

## Follow-ups left by verification passes

Small, each a few lines; none blocks anything.

**Identity ratification**
- Serve the bytes `verifyCopy` hashed (read once) instead of re-reading the snapshot after verifying it.
- Move the wire types from `services/identity/types.ts` and the frontend mirror into `packages/shared`.
- With no usable snapshot the public Discord lane serves the live files with no line (documented).

**Setup wizard**
- A stranger who can reach a password-less server directly can replace the setup code once per 5 minutes.
- Duplicate `APP_PASSWORD` lines in `.env`: `upsertEnv` replaces the first, dotenv reads the last (pre-existing).

**Skins** (taste calls for the maintainer)
- Leaf etching on Conservatory and Cloister sits at 10%; louder costs a darker secondary text on those rooms.
- Corner pieces are 22px brackets; the mockups' flourishes are nearer 40px.
- Phone gutter: 24px keeps the corners uncovered; the spec's 8–12px gives about 30px more reading width.
- Ember's picker thumbnail is a plain dark swatch. Night's moon sits behind the header on a phone.
- Layout items in the mockups (collapsed thread list, avatar inside the card, "Open notes", bottom tab bar, the Mantel home) are features, not skin.

**Plugins and Discord**
- Overlapping reloads: merge rather than drop the older one, with a doc note.
- A `res` help topic so the companion knows it can call `PUT /api/plugins/enabled`.
- Discord lows from the B3d pass (one-liners; see the PR #5 thread).
- Browser: `--workdir` pointing at a file gives an ENOTDIR stack trace; stale `setup.mjs` "outdated" message.

**Multi-tenant (item 9, built)**
- Per-tenant tool allow and deny lists, and skill allowlists.
- An OS-user or sandbox boundary per tenant for adversarial tenants (the `spawnWrapper` seam in `tenancy/child.ts` does nothing yet).
- A real-SDK two-tenant soak (two real logins, real turns); the local runbook is in `MULTI-TENANT.md`.
- dsh's `/tmp` exclude; an audit of the ~20 local-time sites so a tenant may have its own timezone.

**Household mode (item 9)**
- Moving a companion in from the hallway itself. Today **+ Add companion** gives the command (`npm run setup -- --tenant <id> --create`) and a restart opens the new door; a house route that makes the folder, runs the three-screen onboarding for it and loads it without a restart would let it all happen in the app.
- The first-run page under a prefix (no house password yet) should send the person to the house address instead of the companion's wizard (which answers 409 `house_password_required`).
- House-level push: one VAPID key for the house, the companion id in the payload (today push is per companion: one service-worker scope, one subscription per browser, a VAPID key per companion).
- `npm run setup` has no process-level step that creates a `tenants:` block yet (so none writes `auth: household`); the key's absence means household.

**Release**
- The `public/weldbuilder` branch needs a fresh single-commit cut from main before any publishing.

## Out of scope here

Dreaming, memory flush, weekly memory review (Loom) and the Obsidian vault belong to sanctum-mind and
Revien. The Mantel home layout from the Ember pack is a separate feature with its own data contracts.
