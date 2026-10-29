# Browser seat (default): neko viewer

m1k1o/neko's Chromium image (WebRTC streaming, built-in login, multi-viewer) with Chromium's DevTools port
exposed to an agent. This is the default browser seat; the noVNC recipe in `../browser-seat/` is the fallback.

```bash
cp .env.example .env     # set both passwords; for a phone set NEKO_SEAT_BIND and NEKO_SEAT_NAT_IP to a private-network IP (e.g. a VPN/tailnet address)
docker compose -p seat up -d
```

- Viewer: `http://<bind>:3201/`. Any username plus the user password; the admin password gives admin rights.
  Plain HTTP (neko has no TLS of its own; WebRTC does not need a secure context, clipboard sync does).
  **Warning:** anyone who reaches the viewer URL with a password controls this browser and every account logged
  in inside it. Keep the bind on localhost or a private network; never expose it to the open internet.
- WebRTC media uses one UDP port and one TCP fallback port (`NEKO_SEAT_RTC_PORT`, default 52000), published on the
  bind address only. `NEKO_WEBRTC_NAT1TO1` makes neko advertise that address, so a client on the tailnet connects
  directly, with no TURN server. (neko's default config also lists a public Google STUN server; it is not needed on a tailnet.)
- CDP: `127.0.0.1:9232`. Two changes make it work:
  1. `chromium.conf` replaces the image's supervisor program: adds `--remote-debugging-port=9222`, removes `--bwsi`
     (guest mode discards the profile), and starts `cdp-relay.py` (Chromium binds DevTools to loopback only).
  2. `policies.json` replaces the image's browser policy with `DeveloperToolsAvailability` set to 1. With the stock
     value (2) the port still answers `/json/version`, but Playwright sees no pages and `newPage()` fails.
  Only the container's CDP port 9223 is published, and only as `127.0.0.1:9232` on the host. CDP is full control
  with no password; never widen that publish.

```js
const browser = await chromium.connectOverCDP('http://127.0.0.1:9232');
const page = await browser.contexts()[0].newPage();   // visible in the viewer; do not newContext()
```

Control: implicit hosting is on (`NEKO_SESSION_IMPLICIT_HOSTING`, default true). The served client honors it:
its `system/init` handler stores `implicit_hosting`, a mousedown from a non-controlling viewer sends the control
request and replays that same click once control arrives, and touch events are mapped to mouse events, so the
first tap on the stream both takes control and lands. The toolbar's mouse icon becomes a status indicator, not a
button. A second viewer who touches the stream takes control over from the first, and the first takes it back
with their next touch; when a viewer disconnects, control is released. Whoever touched last holds it; there is no
lock. Verified 2026-10-14 with Playwright WebKit (iPhone 15 profile) against this recipe: with the setting off the
tap sent nothing and no host was set; with it on the first tap sent `control/request`, the server answered
`control/locked` for that session, and the tap reached the seat's page over CDP. Linux WebKit is a model of
iPhone Safari, not the phone itself. Set `NEKO_SEAT_IMPLICIT_HOSTING=false` in `.env` to go back to explicit
requests. Check the live value with the admin token: `GET /api/room/settings` → `implicit_hosting`.

Isolation: own bridge network with `enable_icc=false`; image pinned by digest.
`docker compose -p seat down -v` wipes the profile.

## Agent tools (optional)

`mcp.example.json` is a `.mcp.json` entry named `browser` that runs Playwright MCP (`@playwright/mcp`, pinned
to 0.0.83) against the CDP port above with `--cdp-endpoint http://127.0.0.1:9232`, behind `mcp-filter.mjs`
(see below). It attaches to the running Chromium and uses its existing profile, so the companion works in the
tab you watch. Do not add `--isolated`, `--headless`, `--user-data-dir` or `--browser`: they are for a browser
the tool starts itself. The name `browser` is valid on Claude, Codex and dsh.

**Two tools are blocked: `browser_run_code_unsafe` and `browser_evaluate`.** Playwright MCP runs outside dsh's
sandbox. `browser_run_code_unsafe` runs arbitrary JavaScript in the Playwright server process (its own
description calls it unsafe; it is remote code execution on your machine), and `browser_evaluate` runs
arbitrary JavaScript in the page, which reads cookies and the DOM of every logged-in site. A prompt-injected
page or a confused model could use either to step outside the seat model. 0.0.83 has no flag to leave a tool
out (`--caps` only adds capabilities, and both tools are in the always-on `core` set), so `mcp-filter.mjs`
(no dependencies) sits between the harness and the server: it removes them from `tools/list` and answers a
call to them with an error. If the file or the path is wrong, the companion gets no browser tools at all.
Keep the `--block` list when you edit the entry, and re-check the tool list after you bump the version. The
filter hard-codes both names: it exits 2 with a usage line unless `--block` contains `browser_run_code_unsafe`
and `browser_evaluate` exactly (a typo means no browser tools, not an unblocked tool). `--block` may add more.

**What counts as "filtered".** An entry runs the filter only when its command is `node` (bare, or an absolute path
to `node` / `node.exe`) and the first argument is a path whose last segment is exactly `mcp-filter.mjs`, or when the
command itself is that script. The name appearing anywhere else (`npx @playwright/mcp --note mcp-filter.mjs`, a
longer file name, a flag value) is reported as unfiltered by `npm run setup` and at app start, because that entry
starts Playwright MCP directly.

**Windows.** The filter starts the server from an argument list, never through a shell, so a path with spaces in
`--output-dir` arrives whole. `npx` is not an executable on Windows (it is `npx.cmd`, and Node will not start a
`.cmd` without a shell), so the filter runs it as `node <npm>/bin/npx-cli.js`, found next to the running `node.exe`
or beside the `npx.cmd` on `PATH`. If it cannot find that file and only a `.cmd` exists, it exits with a message
saying so; use an `.exe` or `node <script>` after `--` in that case.

**WebMCP is off.** A page can register its own tools through the WebMCP API (`navigator.modelContext`); they run
page code and would reach the model's list after a `notifications/tools/list_changed`. The entry passes
`--no-webmcp` (0.0.83: "do not collect or expose the tools that a page registers"), and as defence in depth the
filter strips every tool whose name starts with `webmcp_` from `tools/list` and refuses calls to them.

**The server gets its own folder.** Playwright MCP writes into its working directory (`.playwright-mcp/`) and
resolves `filename` / `paths` arguments against it, which would be the companion's own folder. The filter takes
`--workdir <dir>` (required) and starts the server there; the entry also passes `--output-dir <dir>` with the same
path. `npm run setup` uses `<this checkout>/data/browser-out` and creates it with mode 0700; `data/` is gitignored.
By hand, create the directory yourself (`mkdir -m 700`) and put its absolute path in both places.
`--workdir` must be an absolute path and come before `--`; the filter exits 2 otherwise, and exits 2 for a
`--block` or `--workdir` that sits after `--` (it would be passed to the server instead). An existing directory is
not chmodded; the filter only logs its mode to stderr when group or world can read it. The filter also strips the
MCP `roots` capability from the client's `initialize` request and answers a `roots/list` from the server with an
empty list: Claude Code advertises roots and answers with its own cwd (the companion's folder), and Playwright MCP
would move its workspace there, so `filename` arguments would land in the companion's folder. dsh and Codex send
no roots; with the strip this isolation holds on all three harnesses.

**Upgrading an older entry.** If your `.mcp.json` already has a `browser` entry with no `mcp-filter.mjs` in it
(an unfiltered one), the companion can run arbitrary code through it. `npm run setup` warns about that and offers
to replace it (it backs the file up first); an entry that has the filter but whose arguments the filter would refuse (no `--workdir`, a relative one, a missing
required `--block` name, or a flag placed after `--`) is offered the same replacement, because the filter would not
start. The app also logs one warning at startup when it finds an unfiltered or outdated `browser` entry.

**What the remaining tools can still reach in a logged-in browser.** Blocking two tools does not make the rest
harmless; decide with these in mind. The companion can:
- read network request bodies and headers (`browser_network_requests`, `browser_network_request`), which include
  cookies and `Authorization` headers of every site the browser talks to, and the console log
  (`browser_console_messages`), which sites sometimes fill with tokens or personal data;
- see and switch between every open tab (`browser_tabs`), not only the one you are watching, and snapshot or
  screenshot any of them;
- fill forms, type, click, press keys, and answer dialogs (`browser_fill_form`, `browser_type`, `browser_click`,
  `browser_handle_dialog`), so it can submit or send anything your logged-in accounts can;
- upload files from disk into a page (`browser_file_upload`) and save screenshots and snapshots to files (in
  the folder above).
Log in only to accounts you would let it use, and keep sensitive ones in another browser profile.

- `npm run setup` offers to merge it with the real path filled in (it backs up `.mcp.json` first and never
  overwrites other servers).
- By hand: copy the `browser` object from `mcp.example.json` into the `mcpServers` object of the app folder's
  `.mcp.json` (create the file with the whole example if it does not exist), replace
  `/ABSOLUTE/PATH/TO/sanctum-mobile` with this checkout's path, then restart the app.
- **Set both:** the `.mcp.json` entry gives the companion the tools, and `integrations.browser_url` (Settings
  or `sanctum.yaml`) gives you the Browser tab. Without `integrations.browser_url` there is no viewer tab, so
  you cannot watch or take over.
- The seat has to be up first; the tools fail to connect while nothing listens on 9232. The first run
  downloads the package with `npx`.

**Warning:** with this entry the companion controls every account logged in inside that browser. The home
folder's `AGENTS.md` and the `browser` skill tell it to ask first before anything that sends, posts, buys or
signs in, and never to enter credentials, but that is an instruction, not a lock. Log in only to accounts you
would let it use.
