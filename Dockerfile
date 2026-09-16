# syntax=docker/dockerfile:1

# ---- build stage -----------------------------------------------------------
# The full image, not slim: argon2 is a native module and needs a toolchain to
# compile. None of that follows into the runtime image.
FROM node:22-bookworm AS build
WORKDIR /app

# Dependencies first, on their own layer, so a source-only change does not
# re-run npm ci — the slowest step, because it compiles argon2.
COPY package.json package-lock.json ./
RUN npm ci

# Then the sources the build actually reads. Listed explicitly rather than
# `COPY . .` so the build cache is not busted by an unrelated file, and so the
# image can never accidentally include data/, .env, or the phase prompts.
COPY tsconfig.json vite.config.ts index.html ./
COPY scripts ./scripts
COPY shared ./shared
COPY server ./server
COPY client ./client

RUN npm run build

# A second, production-only dependency tree to copy into the runtime image.
# `npm ci` into a clean prefix keeps argon2's compiled binary but drops vite,
# esbuild, playwright and the rest of devDependencies.
RUN npm ci --omit=dev

# ---- runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# dumb-init so signals reach node directly: without an init, node runs as PID 1
# and does not get the default SIGTERM behaviour, and the graceful shutdown the
# server installs would never be reached on `docker stop`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

# Only what runs: the built server and client, production node_modules, and the
# manifest. No sources, no dev tooling, no tests.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY docker-entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

# The persistent boundary (contracts §1). Declared a volume so its contents
# survive the container, and owned by the unprivileged user the server runs as
# — directories must be 0700, which the app also enforces at write time.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Never root. The one file tree the process writes to is /data, already owned
# by this user; everything else is read-only to it, which is the point.
USER node

ENV PORT=3001
EXPOSE 3001

# Answers on the health route the app already serves. `start-period` covers the
# generation-recovery pass that runs before the listener opens. Honoured by
# Docker; Podman ignores it unless the image is built with `--format docker`.
#
# The probe is a subcommand of the entrypoint rather than an inline one-liner
# so that it reads PORT and the TLS variables the same way the server does. An
# http:// probe against a TLS listener fails forever, which marks a perfectly
# healthy container unhealthy and deadlocks anything waiting on
# `service_healthy`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["entrypoint", "healthcheck"]

ENTRYPOINT ["dumb-init", "--", "entrypoint"]
CMD ["serve"]
