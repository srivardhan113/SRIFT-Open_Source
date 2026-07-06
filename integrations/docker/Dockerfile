# Sidecar Docker image for the SRIFT daemon.
# Run alongside any AI agent container so it can hit http://srift:3822/.
#
# Build:
#   docker build -f integrations/docker/Dockerfile -t srift-daemon .
#
# Run:
#   docker run --rm -p 3822:3822 -e SRIFT_PUBLIC_BASE=https://srift.app srift-daemon
#
# In docker-compose:
#   services:
#     srift:
#       build: { context: ., dockerfile: integrations/docker/Dockerfile }
#       ports: ["3822:3822"]
#     my-agent:
#       image: my-agent
#       environment:
#         SRIFT_BASE_URL: http://srift:3822
#       depends_on: [srift]

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY cli ./cli
COPY .env.example ./
ENV SRIFT_DAEMON_PORT=3822
ENV NODE_ENV=production
EXPOSE 3822
USER node
CMD ["node", "--experimental-strip-types", "cli/daemon.ts"]
