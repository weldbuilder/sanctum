#!/bin/sh
# Container entrypoint: put the things that must survive a container's life on the /data volume, seed an empty companion home, then run the command.
#
#   /app/sanctum.yaml, /app/.env, /app/.mcp.json  ->  /data/config/<same name>   (links; the setup wizard and the app write through them)
#   /app/data                                     ->  /data                       (some files are kept under <app>/data whatever DB_PATH says)
#   /app/logs                                     ->  /data/logs
#   /companion-home                               <-  /app/companion-home         (the starter template, only when it is empty)
#
# SANCTUM_APP, SANCTUM_DATA and SANCTUM_HOME move the three folders (the tests do; the image uses the defaults).
set -eu

APP="${SANCTUM_APP:-/app}"
DATA="${SANCTUM_DATA:-/data}"
HOME_DIR="${SANCTUM_HOME:-/companion-home}"
CONF="$DATA/config"

if ! mkdir -p "$CONF" "$DATA/logs" "$APP/prompts/wakes" 2>/dev/null; then
  printf 'docker-entrypoint: cannot write to %s. A bind-mounted folder must be owned by the container user (uid %s); a named volume needs nothing.\n' "$DATA" "$(id -u)" >&2
  exit 1
fi

# A link is made only where nothing real is: a regular file or folder already there is the person's, and is left alone.
link() { # link TARGET LINK
  if [ -L "$2" ] || [ ! -e "$2" ]; then ln -sfn "$1" "$2"; fi
}
# The three settings files. A link to a file that is not there yet is how the first run's wizard saves to the volume: writing through the link creates it.
for name in sanctum.yaml .env .mcp.json; do link "$CONF/$name" "$APP/$name"; done
link "$DATA" "$APP/data"
link "$DATA/logs" "$APP/logs"

# The companion's home starts as the shipped template and is never touched once it holds anything.
if [ -d "$APP/companion-home" ] && [ -d "$HOME_DIR" ] && [ -z "$(ls -A "$HOME_DIR" 2>/dev/null)" ]; then
  cp -R "$APP/companion-home/." "$HOME_DIR/"
fi

exec "$@"
