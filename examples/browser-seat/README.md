# Browser seat (noVNC, fallback)

This is the **fallback** recipe. The default browser seat is [`examples/browser-seat-neko/`](../browser-seat-neko/README.md); use this one if you cannot run neko (for example, no WebRTC path to the host).

A Chromium browser running in containers that you can watch and drive from the
**Browser** tab in Sanctum Mobile. It is useful when you and your companion need a
shared browser, for example to log in to a site once and then let the companion work
inside that session.

Two services, one `docker compose`:

| Service | What it runs | Published on the host |
|---|---|---|
| `display` | Xvfb virtual screen, x11vnc (inside the container, loopback, password auth), websockify + noVNC | `BROWSER_SEAT_BIND:6080` (viewer) |
| `chromium` | Playwright's Chromium (`mcr.microsoft.com/playwright:v1.59.1-noble`), drawing on the display's X socket (mounted read-only), persistent profile volume | `127.0.0.1:9222` (CDP, loopback only) |

Both containers drop all capabilities and set `no-new-privileges`. Chromium runs as a
non-root user with `--no-sandbox`: the container is the isolation boundary, and it has no
host mounts, only named volumes. Nothing runs on the host outside Docker, so there is no pm2 step.

## Warning: this exposes every session you log in to

Anyone who can open the viewer and knows the password can use the browser, including every
account logged in inside it. Treat the viewer port and the password like a password.

- The compose file binds to `127.0.0.1` by default. Only the machine itself can reach it.
- To reach it from your phone, put it on a private network (a VPN or tailnet) and set
  `BROWSER_SEAT_BIND` to that interface's address only. Do not publish it to the public
  internet, and do not put it behind a public tunnel without real authentication in front.
- A password is mandatory (`BROWSER_SEAT_VNC_PASSWORD`). VNC authentication only uses the
  **first 8 characters**, so the password is weaker than its length suggests. That is another
  reason to keep this on loopback or a private network.
- Log in only to accounts you are willing to hand to anyone who reaches the viewer.

## Setup

1. Configure and start it:

   ```bash
   cd examples/browser-seat
   cp .env.example .env        # then set BROWSER_SEAT_VNC_PASSWORD in .env
   docker compose up -d --build
   ```

2. Check it by opening `http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale` on the
   same machine. It asks for the password, then shows the browser.

3. Point Sanctum Mobile at it. In `sanctum.yaml`:

   ```yaml
   integrations:
     browser_url: "http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale"
   ```

   You can also set it in Settings, under "browser". Restart Sanctum Mobile afterwards:
   the server only allows the one configured address to be framed, and reads it at startup.

4. Open the **Browser** tab. Use **Reload** to reconnect and **Pop out** to open the
   viewer in its own window. `autoconnect=true` connects straight away (you still type the
   password); `resize=scale` fits the screen to the window.

## Using it from another device

The address in `browser_url` is opened by *your browser*, not by the Sanctum server, so
it must be reachable from the device you are holding. `127.0.0.1` only works when you
browse from the machine running the containers. For a phone, set in `.env`:

```bash
BROWSER_SEAT_BIND=<private-network-ip>
```

and set `browser_url: "http://<private-network-ip>:6080/vnc.html?autoconnect=true&resize=scale"`.

Browsers refuse to frame an `http://` page inside an `https://` page (mixed content). If you
serve Sanctum Mobile over HTTPS, serve the viewer over HTTPS too, using a private-network
HTTPS proxy in front of port 6080 (this recipe serves plain HTTP).

## Letting an agent drive the same browser (CDP)

The viewer and the agent share one browser session. The Chromium you watch also listens for
the Chrome DevTools Protocol (CDP), published on **127.0.0.1:9222** only
(`BROWSER_SEAT_CDP_PORT` changes the host port, not the address). Pages an agent opens over
CDP appear in the viewer, and logins you make in the viewer are visible to the agent.

Chromium only binds CDP to loopback inside its container, so a small node TCP relay in the
same container (started by the `command` in `docker-compose.yml`) forwards the published
port to it. Check it from the host:

```bash
curl -s http://127.0.0.1:9222/json/version     # describes the running browser
curl -s -X PUT 'http://127.0.0.1:9222/json/new?https://example.com'
curl -s http://127.0.0.1:9222/json/list         # the new page is listed, and shows in the viewer
```

With Playwright, attach to the existing browser and reuse its visible context. Do not call
`newContext()`: that creates a separate, invisible profile with none of your logins.

```js
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];          // the context the viewer shows
const page = await context.newPage();
await page.goto('https://example.com');
```

Sanctum Mobile itself has no code that connects to CDP, so there is no `browser_cdp_url`
setting. Point your agent's browser tool at the URL above.

### Warning: CDP is full control of the browser

Anyone who can reach the CDP port can read every cookie and page, run scripts in any
logged-in site, and drive the browser, with no password. It is published on `127.0.0.1`
only, separately from `BROWSER_SEAT_BIND`, on purpose. Never publish it on a
non-loopback address, and never put it behind a tunnel or proxy. If the agent runs on
another machine, use an SSH tunnel (`ssh -L 9222:127.0.0.1:9222 host`) rather than
widening the bind.

## Framing

noVNC's built-in web server sends no `X-Frame-Options` and no `frame-ancestors` policy, so
the Browser tab can frame it with no extra settings. If you put a reverse proxy in front,
make sure it does not add `X-Frame-Options: DENY` or `frame-ancestors 'none'`.

## Options

Set these in `.env` next to `docker-compose.yml` (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_SEAT_VNC_PASSWORD` | none, required | Viewer password (first 8 characters count) |
| `BROWSER_SEAT_BIND` | `127.0.0.1` | Host address the viewer is published on |
| `BROWSER_SEAT_PORT` | `6080` | Host port for the viewer |
| `BROWSER_SEAT_CDP_PORT` | `9222` | Host port for CDP (always bound to 127.0.0.1) |
| `BROWSER_SEAT_RESOLUTION` | `1600x1000x24` | Virtual screen `WIDTHxHEIGHTxDEPTH` |
| `TZ` | `Etc/UTC` | Browser timezone |

## Wiping it

`docker compose down -v` deletes the browser profile, including saved logins.
