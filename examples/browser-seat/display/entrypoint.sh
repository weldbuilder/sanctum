#!/bin/sh
# Xvfb on :77 (no TCP), x11vnc on 127.0.0.1:5900 only, websockify + noVNC on 0.0.0.0:6080.
# Docker publishes 6080 on the host address you chose; nothing else leaves this container.
set -eu
: "${VNC_PASSWORD:?VNC_PASSWORD is required}"
export DISPLAY=:77
RES="${SEAT_RESOLUTION:-1600x1000x24}"

# Password goes through a file on tmpfs, never argv. VNC auth only uses the first 8 characters.
PWFILE=/tmp/vnc.passwd
umask 077
printf '%s\n' "$VNC_PASSWORD" > "$PWFILE"
unset VNC_PASSWORD

rm -f /tmp/.X77-lock /tmp/.X11-unix/X77
Xvfb :77 -screen 0 "$RES" -nolisten tcp &
for i in $(seq 1 50); do [ -S /tmp/.X11-unix/X77 ] && break; sleep 0.2; done
chmod 0777 /tmp/.X11-unix/X77 2>/dev/null || true   # the browser container runs as another uid

x11vnc -display :77 -localhost -rfbport 5900 -passwdfile "$PWFILE" -forever -shared -noxdamage -quiet &
exec websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900
