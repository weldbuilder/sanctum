# Virtual display plus a browser-reachable viewer: Xvfb, x11vnc (loopback, password auth), websockify + noVNC.
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify \
 && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /entrypoint.sh
# /tmp/.X11-unix is a shared volume: pre-create it sticky+world-writable so Docker copies those perms onto the volume.
RUN chmod 0755 /entrypoint.sh && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
USER 1000:1000
ENTRYPOINT ["/entrypoint.sh"]
