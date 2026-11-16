# Hosting Sanctum on a small cloud box

For when you want your companion running all the time, reachable from your phone, without leaving a computer at home switched on. One person, one box. The companion runs on the box; your own computer is never touched.

There are two ways in, and both end at the same app:

- **The installer** (`install.sh`): Ubuntu 22.04 / 24.04 or Debian 12, one command, Sanctum under systemd.
- **Docker**: an image and a compose file, for a box that already runs containers.

Reaching it from your phone is **private over Tailscale by default** (nothing is open to the internet). Putting it on your own domain over HTTPS, through Caddy, is the alternative.

> There is no release tag yet, so the installer and the image follow `main`. Pin a version with `--ref` / `SANCTUM_REF` (a tag, a branch or a commit) once tags exist; a release tag will replace "main" as the default.

## What you need

- A small Linux box. Two gigabytes of memory is the minimum (the build needs it); 10 GB of disk. A basic droplet at DigitalOcean or a CX-class server at Hetzner is about five dollars a month; check the provider's page for today's price. Pick Ubuntu 24.04.
- For **Tailscale** (the default): a free [Tailscale](https://tailscale.com) account, the Tailscale app on your phone, and **HTTPS Certificates turned on** for your tailnet (admin console, DNS page; `tailscale serve` prints the link if it is off).
- For **a domain**: a name you own that already points at the box (an A record), and ports 80 and 443 open in the provider's firewall. Costs the domain, about the price of a coffee a year or two.
- Either a **Claude plan** or an **Anthropic API key** (or Codex / DeepSeek, as on any install).

## The one-line install

Open a terminal on the box (SSH, or the provider's console) as root or a user with `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/weldbuilder/sanctum/main/install.sh | bash
```

or, to read it first:

```bash
curl -fsSLO https://raw.githubusercontent.com/weldbuilder/sanctum/main/install.sh
less install.sh
bash install.sh --dry-run      # prints every command, writes nothing
bash install.sh
```

Options: `--private` (Tailscale, the default), `--public [--domain NAME]` (Caddy), `--no-proxy`, `--ref REF`, `--dir DIR`, `--dry-run`. A pipe from `curl` is fine: the installer takes its questions from the terminal, and says so and stops if there is none.

It runs eight steps, each safe to run again, each printed as it starts:

1. Checks the box: the system, root or `sudo`, memory (a warning under 2 GB), 10 GB free.
2. Installs Node 22 (from NodeSource), `git`, a compiler and `python3` (for the native parts that sometimes have no prebuilt binary).
3. Makes the `sanctum` system user (no login, home `/var/lib/sanctum`), the install folder `/opt/sanctum`, the data folder `/var/lib/sanctum/data` and the companion's home `/var/lib/sanctum/companion-home`, and fetches Sanctum (`SANCTUM_REF`, default `main`).
4. As `sanctum`: `npm ci` and `npm run build`.
5. Writes `/opt/sanctum/.env` (mode 0600, owned by `sanctum`) with the port, the paths, `SANCTUM_SUPERVISED=1`, `NODE_ENV=production` and your time zone, then runs **the setup wizard on your terminal** as `sanctum`. The wizard asks for the password and the model credential. The installer never sees them and never prints them.
6. Makes it reachable (below).
7. Installs `/etc/systemd/system/sanctum.service`, starts it and waits up to a minute for `/api/health`.
8. Prints the address, where the logs are, and how to update, check and back up.

It asks one extra thing before the wizard: whether to sign in to a Claude plan right now (see "Signing in to Claude on a box").

### A small box

If the box has less than 2 GB, the build can be killed for lack of memory. Add a swap file first:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### The service

`deploy/sanctum.service`, copied to `/etc/systemd/system/sanctum.service` with the install folder you chose:

```ini
[Unit]
Description=Sanctum, your companion's home
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sanctum
Group=sanctum
WorkingDirectory=/opt/sanctum
EnvironmentFile=/opt/sanctum/.env
Environment=HOME=/var/lib/sanctum
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3
RestartForceExitStatus=75
SuccessExitStatus=75
TimeoutStopSec=30
ReadWritePaths=/opt/sanctum /var/lib/sanctum
ProtectSystem=full
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

`npm start` first runs the updater's recovery (it puts back a version that an update was cut short on), then starts `packages/backend/boot.mjs`. With `SANCTUM_SUPERVISED=1` the app does not re-launch itself: after an in-app update it exits 0, after a boot recovery it exits **75**, and the supervisor starts it again. `Restart=always` covers the first, `RestartForceExitStatus=75` and `SuccessExitStatus=75` the second (see [UPGRADE.md](../UPGRADE.md)). A `.env` value that holds a backtick quote is not read by systemd the way the app reads it; the wizard only uses `'` and `"` unless a password holds both.

## Reaching it from your phone

### 1. Private: Tailscale (the default)

The installer installs Tailscale, runs `tailscale up` (it prints a sign-in address: open it on your phone and approve the box), then `tailscale serve --bg 3099`. That puts HTTPS, with a certificate Tailscale manages, on `https://<box>.<tailnet>.ts.net`, **reachable only from devices on your tailnet**. Sanctum itself keeps listening on `127.0.0.1`. The installer reads the box's name from `tailscale status --json` and adds `https://<that name>` to `cors.origins` in `sanctum.yaml` (the live connection is refused without it; the raw Tailscale IP is a different origin and is not added).

On your phone: install the Tailscale app, sign in to the same account, open the address, and use **Add to Home Screen**.

*The session cookie.* The app marks the cookie `Secure` only when the request arrived over HTTPS (or carries `X-Forwarded-Proto: https`). Reading Tailscale's source (`ipn/ipnlocal/serve.go`, `addProxyForwardedHeaders`), `tailscale serve` over HTTPS adds `X-Forwarded-Proto: https` when the request came in over TLS, so behind it the cookie is `Secure`. That is from the source, not from a test against a live tailnet; `npm run doctor -- --headless` shows what it sees.

What it costs: nothing more. What it exposes: nothing to the internet; anyone on your tailnet (you, and anyone you share the box with) can reach the login page.

### 2. Public: your own domain through Caddy

`--public` (or answer 2) asks for the domain, installs Caddy from its own apt repository, and writes `/etc/caddy/Caddyfile` (an existing one is kept as `Caddyfile.before-sanctum`):

```
# managed by Sanctum install.sh
sanctum.example.com {
	reverse_proxy 127.0.0.1:3099
}
```

Caddy gets and renews the certificate by itself and sends `X-Forwarded-Proto`, so the cookie is `Secure`. `https://<domain>` is added to `cors.origins`. Make sure the domain points at the box before you run it, and that ports 80 and 443 are open (the installer opens them in `ufw` if that is on; the provider's own firewall is yours to open).

What it exposes: **the login page is on the public internet.** The password is the only gate, so choose a long one. Tailscale does not have this exposure.

### 3. Neither

`--no-proxy` leaves Sanctum on `http://127.0.0.1:3099` and prints what to proxy: HTTPS for your domain to that address, with `X-Forwarded-Proto` and WebSocket upgrades forwarded, and the https origin added to `cors.origins`.

## Signing in to Claude on a box

A box has no browser. The Claude program that Sanctum ships with (`node_modules/@anthropic-ai/claude-agent-sdk-*/claude`) supports a sign-in that works from a terminal. This is what `claude auth login` printed on a machine with no browser, verified while writing this page (the address is shortened; the code in it is single-use):

```
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=…&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=…&code_challenge=…&code_challenge_method=S256&state=…
Paste code here if prompted >
```

So: open the address on any device with a browser (your phone is fine), sign in, copy the code the page shows, and paste it at the `>` prompt on the box. The sign-in is stored in `~/.claude/.credentials.json` of the user who ran it (the app checks that file: `services/connection-check.ts`). I stopped the program at the prompt and did not complete a sign-in, so the file being written afterwards is what the app's own check expects, not something I watched happen here.

Run it as the service user, so the file lands where the service looks:

```bash
sudo -u sanctum -H "$(find /opt/sanctum/node_modules/@anthropic-ai -maxdepth 2 -type f -name claude | head -n 1)" auth login --claudeai
```

The installer offers to do exactly this before the wizard. In the wizard, leaving the key empty then selects the Claude plan.

The alternative is an **Anthropic API key**: paste it into the wizard's key question (it selects `api_key` mode; see [CONFIGURATION.md](CONFIGURATION.md), "auth mode"). Nothing to sign in to, nothing to expire, billed per use rather than against your plan.

## Updating

```bash
cd /opt/sanctum
sudo -u sanctum -H npm run update
sudo systemctl restart sanctum
```

The in-app **Update and restart** (Settings) works too, because the service restarts whenever the app exits. Until there are release tags, "newest" is the head of `main` (the `updates.branch` setting). If you installed a pinned `--ref`, the updater refuses (a detached checkout is not on the branch): run `install.sh --ref NEWER` again; every step is safe to repeat.

## Backups and restoring

What is worth keeping is in three places: `/var/lib/sanctum` (the database, the companion's home, files, the Claude sign-in), `/opt/sanctum/.env` (the password and keys) and `/opt/sanctum/sanctum.yaml` (plus `/opt/sanctum/.mcp.json` if you have one). **A backup holds your secrets: store it like a password.**

```bash
sudo systemctl stop sanctum      # a still database is a consistent one
sudo tar -C / -czf ~/sanctum-backup-$(date +%F).tgz var/lib/sanctum opt/sanctum/.env opt/sanctum/sanctum.yaml
sudo systemctl start sanctum
```

To restore on a fresh box: run the installer (answer **no** when it offers to run setup again, once you have put the files back), stop the service, unpack over `/`, fix the owner, start:

```bash
sudo systemctl stop sanctum
sudo tar -C / -xzf sanctum-backup-DATE.tgz
sudo chown -R sanctum:sanctum /var/lib/sanctum /opt/sanctum/.env /opt/sanctum/sanctum.yaml
sudo chmod 600 /opt/sanctum/.env
sudo systemctl start sanctum
```

If the new box has another Tailscale name or domain, add its https origin to `cors.origins` (the installer does that when it makes the box reachable).

## Checking it: `doctor --headless`

```bash
cd /opt/sanctum && sudo -u sanctum -H npm run doctor -- --headless
```

The usual checks, plus a **Service** section for a box with no screen: is `sanctum.service` active; does `/api/health` answer on the port; does Tailscale serve or Caddy front it; is the app bound to loopback behind them; does `cors.origins` list the https address the phone uses; is there at least 1 GB free where the database lives; can this user write the companion's home; does this user own `.env`. Run it as `sanctum` (as above): a check of files runs as whoever runs it. `--json` works with it, and without `--headless` the output is exactly what it was.

## The Docker route

For a box that already runs Docker, or to try it on a computer. The image is built for `linux/amd64` and `linux/arm64` and published to `ghcr.io/<owner>/sanctum` when a `v*` tag is pushed; until a tag exists, build it yourself (`docker compose build`).

```bash
git clone https://github.com/weldbuilder/sanctum.git && cd sanctum
docker compose build                                   # or: docker compose pull, once an image is published
docker compose run --rm -it sanctum npm run setup     # the wizard, once. It needs -it: a terminal.
docker compose up -d
```

The compose file (`docker-compose.yml`):

```yaml
services:
  sanctum:
    image: ghcr.io/${SANCTUM_IMAGE_OWNER:-weldbuilder}/sanctum:${SANCTUM_TAG:-latest}
    build: .
    init: true
    restart: unless-stopped
    env_file:
      - path: .env
        required: false
    environment:
      TZ: ${TZ:-UTC}
    ports:
      - "127.0.0.1:3099:3099"
    volumes:
      - sanctum-data:/data
      - sanctum-home:/companion-home

  tailscale:                      # optional: docker compose --profile tailscale up -d
    profiles: ["tailscale"]
    image: tailscale/tailscale:stable
    network_mode: service:sanctum
    depends_on: [sanctum]
    restart: unless-stopped
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY:-}
      TS_HOSTNAME: ${TS_HOSTNAME:-sanctum}
      TS_STATE_DIR: /var/lib/tailscale
      TS_SERVE_CONFIG: /config/serve.json
      TS_USERSPACE: "true"
    volumes:
      - tailscale-state:/var/lib/tailscale
      - ./deploy/tailscale-serve.json:/config/serve.json:ro
```

(Every line a person edits is marked `CHANGE` in the real file.)

How the container is laid out:

- `/data` is a volume: the database, `config/` (**`sanctum.yaml`, `.env` and `.mcp.json` live here**, linked into the app by the entrypoint, so the wizard and Settings write to the volume), `logs/`, and `claude/` (the Claude sign-in, `CLAUDE_CONFIG_DIR`).
- `/companion-home` is a volume: the companion's own folder, seeded from the shipped template the first time it is empty.
- The app is started as `node packages/backend/boot.mjs`, never `npm start`: the updater is for a checkout. **The image is the update**: pull a newer one and `docker compose up -d`.
- `HOST=0.0.0.0` inside the container, published on `127.0.0.1:3099` of the host only. Do not publish it wider without TLS in front.
- `APP_PASSWORD` in the environment (a `.env` next to the compose file) is honoured, if you would rather not run the wizard.

**Reaching it.** On the host, run `tailscale serve --bg 3099` as in the README, or start the sidecar: `TS_AUTHKEY=… docker compose --profile tailscale up -d` (without a key, the sidecar's log prints a sign-in address). Either way, add the https address to `cors.origins` (the wizard's "Phone address" question, or Settings).

**Signing in to Claude in a container:**

```bash
docker compose run --rm -it sanctum sh -c 'exec "$(find /app/node_modules/@anthropic-ai -maxdepth 2 -type f -name claude | head -n 1)" auth login --claudeai'
```

It prints the same address and `Paste code here if prompted >` prompt as above, and keeps the sign-in on the `/data` volume. Or paste an API key into the wizard.

**Backups.** Back up the two volumes (and `.env` next to the compose file):

```bash
docker run --rm -v sanctum_sanctum-data:/data -v "$PWD":/backup debian tar czf /backup/sanctum-data.tgz -C /data .
docker run --rm -v sanctum_sanctum-home:/data -v "$PWD":/backup debian tar czf /backup/sanctum-home.tgz -C /data .
```

(`sanctum_` is the compose project's name; `docker volume ls` shows yours.) To restore, create the volumes and untar into them the same way.

`doctor --headless` also runs inside the container (`docker compose exec sanctum npm run doctor -- --headless`); it cannot see the Tailscale sidecar or an outside proxy, and says so.

## What the box can see

The companion runs **on the box**, as the `sanctum` user (or `node` in the container): it reads and writes its home, the app's files, and whatever that user can reach. It cannot see your own computer or your phone; nothing on them is touched. The consent gate (Settings → Permissions) applies exactly as it does at home. The box does hold your secrets (`.env`, the Claude sign-in, the database), so keep it patched (`sudo apt-get update && sudo apt-get upgrade`), use SSH keys, and keep the backups private.

## Not covered here

Cloud desktops, Kubernetes, hosting for several people (tenancy exists, see [MULTI-TENANT.md](MULTI-TENANT.md); a hosted setup for it is not described here), automatic image updates, and a setup wizard that runs without a terminal: `npm run setup` needs a TTY (`-it` in Docker).
