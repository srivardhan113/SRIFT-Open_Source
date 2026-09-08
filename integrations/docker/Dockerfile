# ─────────────────────────────────────────────────────────────────────────────
# SRIFT Sidecar Daemon Dockerfile (Ultra-lightweight ~60MB Alpine runtime)
# Designed for sidecar container deployments alongside any AI agent.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-alpine AS runner
WORKDIR /app
LABEL org.opencontainers.image.title="SRIFT Daemon Sidecar" \
      org.opencontainers.image.description="Localhost-only headless daemon for AI agent file transfer & E2EE chat"

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node cli ./cli
COPY --chown=node:node .env.example ./

ENV SRIFT_DAEMON_PORT=3822 \
    NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

EXPOSE 3822
USER node

HEALTHCHECK --interval=15s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3822/status', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "--experimental-strip-types", "cli/daemon.ts"]
