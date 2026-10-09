FROM oven/bun:1.4.2-slim AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/lib/package.json ./packages/lib/package.json
COPY packages/skeleton/package.json ./packages/skeleton/package.json
COPY packages/guardian/package.json ./packages/guardian/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/portal/package.json ./packages/portal/package.json
COPY packages/electron/package.json ./packages/electron/package.json
COPY packages/claude-desktop/package.json ./packages/claude-desktop/package.json
COPY containers/assistant/tools/package.json ./containers/assistant/tools/package.json
COPY containers/guardian/tools/package.json ./containers/guardian/tools/package.json
RUN bun install --frozen-lockfile --production --ignore-scripts --linker hoisted --filter @fhold/portal
COPY packages/portal/src ./src
RUN bun build src/index.ts --target=node --packages=external --outfile=dist/index.mjs

# Slack Socket Mode needs the real undici WebSocket and heartbeat implementation.
# Bun substitutes an incomplete builtin; use the SDK's supported Node runtime.
FROM node:24.21.0-bookworm-slim
ARG PLATFORM_VERSION
ARG VCS_REF
ARG BUILD_DATE
LABEL org.opencontainers.image.title="fhold Portal" \
    org.opencontainers.image.description="Private Discord and Slack adapters for guarded fhold MCP access" \
    org.opencontainers.image.source="https://github.com/fwdslsh/fhold" \
    org.opencontainers.image.url="https://github.com/fwdslsh/fhold" \
    org.opencontainers.image.revision="${VCS_REF}" \
    org.opencontainers.image.created="${BUILD_DATE}" \
    org.opencontainers.image.version="${PLATFORM_VERSION}" \
    org.opencontainers.image.licenses="MIT"
WORKDIR /app

# Portal needs Node, not a package manager at runtime.
RUN npm uninstall --global npm \
    && apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN test -n "$PLATFORM_VERSION" \
    && usermod -l fhold -d /home/fhold node \
    && groupmod -n fhold node \
    && mkdir -p /home/fhold /var/lib/fhold \
    && chown -R fhold:fhold /app /home/fhold /var/lib/fhold

ENV HOME=/home/fhold
ENV PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf "http://127.0.0.1:${PORT}/health" || exit 1

USER fhold
CMD ["node", "dist/index.mjs"]
