#!/usr/bin/env bash
# Sanctum on a small cloud box (Ubuntu 22.04 / 24.04 or Debian 12).
#
#   curl -fsSL https://raw.githubusercontent.com/weldbuilder/sanctum/main/install.sh | bash
#   bash install.sh [--private | --public [--domain NAME] | --no-proxy] [--ref REF] [--dir DIR] [--dry-run]
#
#   --private   reach it over Tailscale (the default)
#   --public    reach it at your own domain over HTTPS, through Caddy
#   --no-proxy  leave it on 127.0.0.1 and print what to proxy
#   --ref REF   the tag, branch or commit to install (default main; or SANCTUM_REF)
#   --dir DIR   the install folder (default /opt/sanctum)
#   --dry-run   print every command and write nothing
#
# Every step is safe to run again. The script never asks for, reads or prints a password or a key: the
# setup wizard (run on your terminal as the service user) does that. docs/HOSTING.md explains the whole thing.
set -euo pipefail

SANCTUM_REPO="${SANCTUM_REPO:-https://github.com/weldbuilder/sanctum.git}"
REF="${SANCTUM_REF:-main}"
INSTALL_DIR="/opt/sanctum"
STATE_DIR="/var/lib/sanctum"
SVC_USER="sanctum"
PORT=3099
MODE=""
DOMAIN=""
DRY=0
SUDO=()
SVC=()
TOTAL=8

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> [%s/%s] %s\n' "$1" "$TOTAL" "$2"; }

# Run a command, or only print it with --dry-run.
run() {
  if [ "$DRY" -eq 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi
}
as_root() { run "${SUDO[@]}" "$@"; }
export DEBIAN_FRONTEND=noninteractive
as_svc() { run "${SVC[@]}" "$@"; }

# Write stdin to a file: put_file PATH MODE OWNER GROUP. Nothing is written with --dry-run.
put_file() {
  local path="$1" mode="$2" owner="$3" group="$4" tmp
  if [ "$DRY" -eq 1 ]; then printf '+ write %s (mode %s, owner %s:%s)\n' "$path" "$mode" "$owner" "$group"; sed 's/^/    | /'; return 0; fi
  tmp="$(mktemp)"
  cat >"$tmp"
  "${SUDO[@]}" install -m "$mode" -o "$owner" -g "$group" "$tmp" "$path"
  rm -f "$tmp"
}

# Ask a question on the terminal: ask "text" DEFAULT. With --dry-run the default is the answer.
ask() {
  local reply=""
  if [ "$DRY" -eq 1 ]; then printf '%s' "$2"; return 0; fi
  read -r -p "$1 [$2] " reply || reply=""
  printf '%s' "${reply:-$2}"
}

usage() {
  cat <<'USAGE'
Sanctum on a small cloud box (Ubuntu 22.04 / 24.04 or Debian 12).

  curl -fsSL https://raw.githubusercontent.com/weldbuilder/sanctum/main/install.sh | bash
  bash install.sh [--private | --public [--domain NAME] | --no-proxy] [--ref REF] [--dir DIR] [--dry-run]

  --private   reach it over Tailscale (the default)
  --public    reach it at your own domain over HTTPS, through Caddy
  --no-proxy  leave it on 127.0.0.1 and print what to proxy
  --ref REF   the tag, branch or commit to install (default main; or SANCTUM_REF)
  --dir DIR   the install folder (default /opt/sanctum)
  --dry-run   print every command and write nothing
USAGE
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --public) MODE=public ;;
      --private) MODE=tailscale ;;
      --no-proxy) MODE=none ;;
      --domain) [ "$#" -ge 2 ] || die "--domain needs a name"; DOMAIN="$2"; shift ;;
      --dry-run) DRY=1 ;;
      --ref) [ "$#" -ge 2 ] || die "--ref needs a tag, branch or commit"; REF="$2"; shift ;;
      --dir) [ "$#" -ge 2 ] || die "--dir needs a folder"; INSTALL_DIR="$2"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option $1 (try --help)" ;;
    esac
    shift
  done
}

# The first existing folder at or above a path (for the disk check).
existing_parent() {
  local p="$1"
  while [ ! -d "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done
  printf '%s' "$p"
}

preflight() {
  step 1 "Checking this machine"
  local id="" version="" os_ok=0 ram_kb disk_kb
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release && printf '%s' "${ID:-}")"
    # shellcheck disable=SC1091
    version="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  fi
  case "$id:$version" in ubuntu:22.04|ubuntu:24.04|debian:12) os_ok=1 ;; *) ;; esac
  if [ "$os_ok" -eq 1 ]; then say "OS: $id $version"
  elif [ "$DRY" -eq 1 ]; then warn "this is ${id:-an unknown system} ${version}, not Ubuntu 22.04/24.04 or Debian 12 (a real run would stop here)"
  else die "this installer supports Ubuntu 22.04, Ubuntu 24.04 and Debian 12 (found ${id:-unknown} ${version})"; fi

  if [ "$(id -u)" -eq 0 ]; then
    SUDO=()
    SVC=(runuser -u "$SVC_USER" -- env "HOME=$STATE_DIR")
  elif command -v sudo >/dev/null 2>&1; then
    SUDO=(sudo)
    SVC=(sudo -u "$SVC_USER" -H env "HOME=$STATE_DIR")
    say "Not root: commands that need it run through sudo."
  elif [ "$DRY" -eq 1 ]; then
    SUDO=(sudo)
    SVC=(sudo -u "$SVC_USER" -H env "HOME=$STATE_DIR")
    warn "neither root nor sudo here (a real run would stop)"
  else die "run this as root, or as a user that can use sudo"; fi

  ram_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
  if [ "${ram_kb:-0}" -lt 1900000 ]; then
    warn "under 2 GB of memory ($((ram_kb / 1024)) MB): the build may run out. Add a swap file first (docs/HOSTING.md, \"A small box\")."
  else say "Memory: $((ram_kb / 1024)) MB"; fi

  disk_kb="$(df -Pk "$(existing_parent "$INSTALL_DIR")" | awk 'NR==2 {print $4}')"
  if [ "${disk_kb:-0}" -lt 10000000 ]; then
    if [ "$DRY" -eq 1 ]; then warn "under 10 GB free for $INSTALL_DIR (a real run would stop here)"
    else die "under 10 GB free for $INSTALL_DIR: pick a bigger disk"; fi
  else say "Disk: $((disk_kb / 1024 / 1024)) GB free"; fi
}

ask_questions() {
  if [ "$DRY" -eq 0 ] && [ -z "$MODE" ]; then
    say ""
    say "How will you reach Sanctum from your phone?"
    say "  1) Privately, over Tailscale (default): nothing is open to the internet."
    say "  2) At your own domain over HTTPS, through Caddy (the domain must already point at this box)."
    say "  3) Neither: I will put my own proxy in front."
    case "$(ask "Choose 1, 2 or 3" 1)" in
      2) MODE=public ;;
      3) MODE=none ;;
      *) MODE=tailscale ;;
    esac
  fi
  MODE="${MODE:-tailscale}"
  if [ "$MODE" = public ] && [ -z "$DOMAIN" ]; then
    DOMAIN="$(ask "Domain name (for example sanctum.example.com)" "sanctum.example.com")"
  fi
  if [ "$MODE" = public ] && ! printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'; then
    die "\"$DOMAIN\" is not a domain name"
  fi
  local default_tz="UTC"
  if command -v timedatectl >/dev/null 2>&1; then default_tz="$(timedatectl show -p Timezone --value 2>/dev/null || printf 'UTC')"; fi
  TZ_NAME="$(ask "Time zone for the companion (IANA name, for example Europe/London)" "${default_tz:-UTC}")"
  if [ ! -e "/usr/share/zoneinfo/$TZ_NAME" ] && [ "$DRY" -eq 0 ]; then die "\"$TZ_NAME\" is not a time zone this box knows"; fi
  CLAUDE_NOW=0
  if [ "$(ask "Sign in to a Claude plan from this terminal now? (n: use an API key in setup, or sign in later)" n)" = y ]; then CLAUDE_NOW=1; fi
}

install_packages() {
  step 2 "Installing Node 22, git and the build tools"
  local have=""
  if command -v node >/dev/null 2>&1; then have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"; fi
  if [ "$have" = 22 ]; then say "Node 22 is already installed."
  else
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
    if [ "$DRY" -eq 1 ]; then say "+ curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"
    else curl -fsSL https://deb.nodesource.com/setup_22.x | "${SUDO[@]}" bash -; fi
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y git build-essential python3 curl ca-certificates
}

create_user_and_folders() {
  step 3 "Making the $SVC_USER user and its folders, and fetching Sanctum ($REF)"
  if id "$SVC_USER" >/dev/null 2>&1; then say "User $SVC_USER exists."
  else as_root useradd --system --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$SVC_USER"; fi
  as_root install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$STATE_DIR"
  as_root install -d -o "$SVC_USER" -g "$SVC_USER" -m 0700 "$STATE_DIR/data"
  # The companion home is left for the setup wizard to create: it seeds the starter template only into a folder that does not exist yet.
  as_root install -d -o "$SVC_USER" -g "$SVC_USER" -m 0755 "$INSTALL_DIR"
  if [ -d "$INSTALL_DIR/.git" ]; then
    say "Sanctum is already cloned: updating to $REF."
    as_svc git -C "$INSTALL_DIR" fetch --tags --prune origin
    as_svc git -C "$INSTALL_DIR" checkout "$REF"
    if [ "$DRY" -eq 1 ] || "${SVC[@]}" git -C "$INSTALL_DIR" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
      as_svc git -C "$INSTALL_DIR" merge --ff-only "origin/$REF"
    fi
  else
    as_svc git clone "$SANCTUM_REPO" "$INSTALL_DIR"
    as_svc git -C "$INSTALL_DIR" checkout "$REF"
  fi
}

build_app() {
  step 4 "Installing dependencies and building (a few minutes)"
  as_svc npm --prefix "$INSTALL_DIR" ci
  as_svc npm --prefix "$INSTALL_DIR" run build
}

# Add KEY=VALUE to .env unless the file already sets KEY (a value you or the wizard chose is never overwritten).
env_default() {
  local key="$1" value="$2" file="$INSTALL_DIR/.env"
  if [ "$DRY" -eq 1 ]; then printf '+ .env: %s=%s (when not already set)\n' "$key" "$value"; return 0; fi
  if "${SUDO[@]}" grep -q "^$key=" "$file"; then return 0; fi
  printf '%s=%s\n' "$key" "$value" | "${SUDO[@]}" tee -a "$file" >/dev/null
}

# The first Claude program under node_modules that runs here (both the glibc and the musl build are installed; only one starts).
pick_claude() {
  local c
  while IFS= read -r c; do
    if "${SVC[@]}" "$c" --version >/dev/null 2>&1; then printf '%s' "$c"; return 0; fi
  done < <(find "$INSTALL_DIR/node_modules/@anthropic-ai" -maxdepth 2 -type f -name claude -perm -u+x 2>/dev/null | sort || true)
  return 0
}

configure_app() {
  step 5 "Writing the settings and running the setup wizard"
  # .env holds the secrets: owner-only from the first byte (an existing one keeps its contents, and gets its mode and owner put right).
  if [ "$DRY" -eq 1 ] || [ ! -e "$INSTALL_DIR/.env" ]; then as_root install -m 0600 -o "$SVC_USER" -g "$SVC_USER" /dev/null "$INSTALL_DIR/.env"; fi
  as_root chown "$SVC_USER:$SVC_USER" "$INSTALL_DIR/.env"
  as_root chmod 0600 "$INSTALL_DIR/.env"
  env_default PORT "$PORT"
  env_default HOST 127.0.0.1
  env_default DB_PATH "$STATE_DIR/data/sanctum.db"
  env_default AGENT_CWD "$STATE_DIR/companion-home"
  env_default SANCTUM_SUPERVISED 1
  env_default NODE_ENV production
  env_default TZ "$TZ_NAME"

  # Setup counts as having run before only if sanctum.yaml was there before this step created it.
  local had_config=0
  if [ "$DRY" -eq 0 ] && "${SUDO[@]}" test -e "$INSTALL_DIR/sanctum.yaml"; then had_config=1; fi

  # The companion's home defaults to the service user's folder, not ~/Documents, so the wizard offers the right one.
  as_svc node "$INSTALL_DIR/scripts/hosting/set-config.mjs" --root "$INSTALL_DIR" --default-cwd "$STATE_DIR/companion-home"

  if [ "$CLAUDE_NOW" -eq 1 ]; then
    say "Signing in to Claude as $SVC_USER. It prints an address: open it in a browser on any device, sign in, and paste the code it shows back here."
    local claude_bin
    claude_bin="$(pick_claude)"
    if [ "$DRY" -eq 1 ]; then claude_bin="$INSTALL_DIR/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"; fi
    if [ -n "$claude_bin" ]; then as_svc "$claude_bin" auth login --claudeai || warn "the sign-in did not finish: run it again later (docs/HOSTING.md, \"Signing in to Claude on a box\")"
    else warn "the Claude program was not found under $INSTALL_DIR/node_modules: sign in later (docs/HOSTING.md)"; fi
  fi

  if [ "$DRY" -eq 0 ] && [ "$had_config" -eq 1 ] && [ "$(ask "Setup has run here before. Run it again?" n)" != y ]; then
    say "Keeping the existing setup."
  else
    say "The wizard asks for the password and the model credential. It needs this terminal."
    as_svc env "PORT=$PORT" "DB_PATH=$STATE_DIR/data/sanctum.db" "AGENT_CWD=$STATE_DIR/companion-home" "TZ=$TZ_NAME" \
      npm --prefix "$INSTALL_DIR" run setup
  fi
  if [ "$DRY" -eq 0 ] && ! "${SUDO[@]}" grep -Eq '^APP_PASSWORD=.' "$INSTALL_DIR/.env"; then
    warn "no app password is saved in .env: the pages stay locked (503) until one is set. Run: cd $INSTALL_DIR && sudo -u $SVC_USER -H npm run setup"
  fi
}

ts_name() {
  tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=((JSON.parse(s).Self||{}).DNSName||"").replace(/\.$/,"");process.stdout.write(n)})'
}

set_origin() {
  as_svc node "$INSTALL_DIR/scripts/hosting/set-config.mjs" --root "$INSTALL_DIR" --origin "$1"
}

setup_reachability() {
  step 6 "Making Sanctum reachable ($MODE)"
  case "$MODE" in
    tailscale)
      if command -v tailscale >/dev/null 2>&1; then say "Tailscale is already installed."
      elif [ "$DRY" -eq 1 ]; then say "+ curl -fsSL https://tailscale.com/install.sh | sh"
      else curl -fsSL https://tailscale.com/install.sh | "${SUDO[@]}" sh; fi
      if [ "$DRY" -eq 0 ] && tailscale status --json 2>/dev/null | grep -Eq '"BackendState": *"Running"'; then say "Tailscale is already signed in."
      else
        say "Tailscale prints a sign-in address next: open it on your phone and approve this box."
        as_root tailscale up
      fi
      as_root tailscale serve --bg "$PORT"
      if [ "$DRY" -eq 1 ]; then ORIGIN="https://<this-box>.<your-tailnet>.ts.net"
      else
        local name; name="$(ts_name)"
        [ -n "$name" ] || die "Tailscale gave no name for this box (is HTTPS turned on for your tailnet? docs/HOSTING.md)"
        ORIGIN="https://$name"
      fi
      set_origin "$ORIGIN"
      ;;
    public)
      if command -v caddy >/dev/null 2>&1; then say "Caddy is already installed."
      else
        as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gpg curl
        if [ "$DRY" -eq 1 ]; then
          say "+ curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
          say "+ curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list"
        else
          curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | "${SUDO[@]}" gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
          curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | "${SUDO[@]}" tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
        fi
        as_root env DEBIAN_FRONTEND=noninteractive apt-get update
        as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
      fi
      if [ "$DRY" -eq 0 ] && [ -s /etc/caddy/Caddyfile ] && ! grep -q 'managed by Sanctum install.sh' /etc/caddy/Caddyfile; then
        as_root cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-sanctum
        say "Your old Caddyfile was kept as /etc/caddy/Caddyfile.before-sanctum."
      fi
      printf '# managed by Sanctum install.sh\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" | put_file /etc/caddy/Caddyfile 0644 root root
      as_root systemctl enable caddy
      as_root systemctl reload-or-restart caddy
      if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then as_root ufw allow 80,443/tcp; fi
      ORIGIN="https://$DOMAIN"
      set_origin "$ORIGIN"
      say "Make sure $DOMAIN points at this box (an A or AAAA record), and that ports 80 and 443 are open in your provider's firewall."
      ;;
    *)
      ORIGIN=""
      say "Nothing was set up in front of Sanctum. It listens on http://127.0.0.1:$PORT only."
      ;;
  esac
}

install_service() {
  step 7 "Installing the service and starting it"
  local unit="$INSTALL_DIR/deploy/sanctum.service"
  if [ "$DRY" -eq 1 ]; then
    printf '+ install %s as /etc/systemd/system/sanctum.service (paths set to %s and %s)\n' "$unit" "$INSTALL_DIR" "$STATE_DIR"
  else
    [ -r "$unit" ] || die "$unit is missing: is $REF a version that has the service file?"
    sed -e "s#/opt/sanctum#$INSTALL_DIR#g" -e "s#/var/lib/sanctum#$STATE_DIR#g" "$unit" | put_file /etc/systemd/system/sanctum.service 0644 root root
  fi
  as_root systemctl daemon-reload
  as_root systemctl enable sanctum
  as_root systemctl restart sanctum
  if [ "$DRY" -eq 1 ]; then say "+ wait up to 60 s for http://127.0.0.1:$PORT/api/health"; return 0; fi
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then say "Sanctum is up."; return 0; fi
    sleep 2
  done
  "${SUDO[@]}" journalctl -u sanctum -n 30 --no-pager || true
  die "Sanctum did not answer on /api/health within 60 seconds (the log is above)"
}

finish() {
  step 8 "Done"
  say ""
  case "$MODE" in
    none) say "Proxy HTTPS for your domain to http://127.0.0.1:$PORT (forward X-Forwarded-Proto and the Upgrade header),"
          say "and add that https origin to cors.origins in $INSTALL_DIR/sanctum.yaml." ;;
    *) say "Open this on your phone: $ORIGIN" ;;
  esac
  say "Logs:    journalctl -u sanctum -f"
  say "Update:  cd $INSTALL_DIR && sudo -u $SVC_USER -H npm run update && sudo systemctl restart sanctum"
  say "Doctor:  cd $INSTALL_DIR && sudo -u $SVC_USER -H npm run doctor -- --headless"
  say "Back up: $STATE_DIR, $INSTALL_DIR/data, $INSTALL_DIR/.env, $INSTALL_DIR/sanctum.yaml and $INSTALL_DIR/.mcp.json (docs/HOSTING.md, Backups)"
}

main() {
  parse_args "$@"
  # `curl ... | bash` leaves stdin on the pipe: the wizard and the questions need the terminal.
  if [ "$DRY" -eq 0 ] && [ ! -t 0 ]; then
    if ( : </dev/tty ) 2>/dev/null; then exec </dev/tty
    else die "this installer asks questions and needs a terminal; run it from an SSH session or a console"; fi
  fi
  [ "$DRY" -eq 0 ] || say "Dry run: nothing is installed, nothing is written."
  TZ_NAME="UTC"; CLAUDE_NOW=0; ORIGIN=""
  preflight
  ask_questions
  install_packages
  create_user_and_folders
  build_app
  configure_app
  setup_reachability
  install_service
  finish
}

# The whole file is read before it runs (stdin may be the script itself), and `exit` stops bash from reading on.
main "$@"; exit $?
