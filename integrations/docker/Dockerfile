# ─────────────────────────────────────────────────────────────────────────────
# SRIFT daemon sidecar image (published CLI from npm, ~60 MB Alpine runtime).
#
# The daemon listens on 127.0.0.1:3822 only and accepts only loopback Host
# headers, so it must share the agent's network namespace:
#   - Kubernetes: a second container in the SAME pod (see ../kubernetes)
#   - Docker Compose: network_mode: "service:<agent>" (see docker-compose.yml)
# The agent then calls http://127.0.0.1:3822 (or runs `srift` itself).
#
#   docker build -t srift-daemon:4.1.0 integrations/docker
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine

ARG SRIFT_VERSION=4.1.0
RUN npm install -g "srift-transfer@${SRIFT_VERSION}" --no-audit --no-fund \
 && npm cache clean --force

LABEL org.opencontainers.image.title="SRIFT daemon sidecar" \
      org.opencontainers.image.description="Localhost-only SRIFT daemon: encrypted P2P file transfer and chat for AI agents"

ENV SRIFT_NO_UPDATE_CHECK=1 \
    NODE_ENV=production
USER node

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3822/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Foreground daemon on 127.0.0.1:3822
CMD ["srift", "daemon", "start"]
