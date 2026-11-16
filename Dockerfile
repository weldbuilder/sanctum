# Sanctum as a container image: docs/HOSTING.md ("The Docker route"). The image is the update: pull a newer one and recreate.
# Build:  docker build -t sanctum .
# Run:    docker compose up -d   (the first time, run the setup wizard once: see the doc)

# ── stage 1: install and build ───────────────────────────────────────────────
# The full image carries the toolchain better-sqlite3, sharp and onnxruntime-node fall back to when a prebuilt binary is missing.
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci
COPY . .
RUN npm run build

# ── stage 2: run ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
# curl is the healthcheck; git and python3 are what the companion's own shell tools commonly reach for.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data /companion-home /app/prompts/wakes \
 && chown -R node:node /data /companion-home /app/prompts

ENV HOST=0.0.0.0 \
    PORT=3099 \
    DB_PATH=/data/sanctum.db \
    AGENT_CWD=/companion-home \
    SANCTUM_SUPERVISED=1 \
    NODE_ENV=production

USER node
# /data: the database, the settings (config/), logs. /companion-home: the companion's own folder.
VOLUME ["/data", "/companion-home"]
EXPOSE 3099
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

# boot.mjs, never `npm start`: the updater is for a checkout, not a container.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "packages/backend/boot.mjs"]
