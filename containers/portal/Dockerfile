FROM oven/bun:1.4.2-slim
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

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

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

RUN test -n "$PLATFORM_VERSION" \
    && mkdir -p /home/bun /var/lib/fhold \
    && chown -R bun:bun /app /home/bun /var/lib/fhold

ENV HOME=/home/bun
ENV PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -sf "http://127.0.0.1:${PORT}/health" || exit 1

USER bun
CMD ["bun", "run", "src/index.ts"]
