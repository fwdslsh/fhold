FROM node:24.22.1-bookworm-slim AS node-runtime
ARG NPM_VERSION=12.2.1
# Use npm's supported self-upgrade at build time, without altering its bundle.
# This upgrade fixes several bundled advisories; remaining findings still block CI.
RUN npm install --global "npm@${NPM_VERSION}" \
    && test "$(npm --version)" = "${NPM_VERSION}"

# Build the unchanged upstream scheduler with a patched supported Go runtime.
# Keep the compiler runtime explicit; no vendor code is patched.
FROM golang:1.27.3-bookworm AS scheduler-build
ARG SUPERCRONIC_VERSION=v0.2.51
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go install \
    -ldflags="-X main.Version=${SUPERCRONIC_VERSION}" \
    "github.com/aptible/supercronic@${SUPERCRONIC_VERSION}"

FROM oven/bun:1.4.4 AS tools
ARG TARGETARCH
WORKDIR /repo
COPY package.json bun.lock ./
COPY packages/lib/package.json ./packages/lib/package.json
COPY packages/skeleton/package.json ./packages/skeleton/package.json
COPY packages/guardian/package.json ./packages/guardian/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/portal/package.json ./packages/portal/package.json
COPY packages/electron/package.json ./packages/electron/package.json
COPY packages/claude-desktop/package.json ./packages/claude-desktop/package.json
COPY containers/assistant/tools/package.json ./containers/assistant/tools/package.json
COPY plugins/fhold/package.json ./plugins/fhold/package.json
RUN bun install --frozen-lockfile --production --linker hoisted --filter @fhold/assistant-tools \
    && rm -rf node_modules/@opencode/cli-linux-x64-musl \
              node_modules/@opencode/cli-linux-x64-baseline \
              node_modules/@opencode/cli-linux-x64-baseline-musl \
              node_modules/@opencode/cli-linux-arm64-musl \
    && case "${TARGETARCH}" in \
      amd64) rm -rf node_modules/@img/sharp-libvips-linux-arm64 \
                    node_modules/@img/sharp-libvips-linuxmusl-arm64 \
                    node_modules/@img/sharp-linux-arm64 \
                    node_modules/@img/sharp-linuxmusl-arm64 \
                    node_modules/@img/sharp-libvips-linuxmusl-x64 \
                    node_modules/@img/sharp-linuxmusl-x64 ;; \
      arm64) rm -rf node_modules/@img/sharp-libvips-linux-x64 \
                    node_modules/@img/sharp-libvips-linuxmusl-x64 \
                    node_modules/@img/sharp-linux-x64 \
                    node_modules/@img/sharp-linuxmusl-x64 \
                    node_modules/@img/sharp-libvips-linuxmusl-arm64 \
                    node_modules/@img/sharp-linuxmusl-arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac

COPY packages/skeleton /repo/packages/skeleton
COPY packages/lib/src/control-plane/seed-manifest.ts /repo/packages/lib/src/control-plane/seed-manifest.ts
COPY scripts/bake-assistant-assets.mjs /repo/scripts/bake-assistant-assets.mjs
RUN bun /repo/scripts/bake-assistant-assets.mjs /repo/packages/skeleton /assistant-defaults

# One source of built-in skills, exposed through AKM and each native plugin.
COPY plugins /fhold-plugins
RUN mkdir -p /fhold-bundle/skills \
    && cp -R /assistant-defaults/system/assistant/skills/. /fhold-bundle/skills/ \
    && cp -R /fhold-bundle/skills /fhold-plugins/fhold/skills

# Both native harnesses install the same immutable upstream marketplace.
ADD --checksum=sha256:1d36e583aad4b124b46cd2c96fde003eaf6db8e9642182ce6685612dd28033f8 \
    https://codeload.github.com/itlackey/akm-plugins/tar.gz/62066b5d82c86c07b62e2e0a1fddec97b3182825 /tmp/akm-claude.tar.gz
RUN mkdir -p /akm-marketplace/claude \
    && plugin_root=akm-plugins-62066b5d82c86c07b62e2e0a1fddec97b3182825/claude \
    && tar -xzf /tmp/akm-claude.tar.gz -C /akm-marketplace/claude --strip-components=2 \
      "$plugin_root/.claude-plugin" "$plugin_root/.codex-plugin" "$plugin_root/commands" "$plugin_root/hooks" \
      "$plugin_root/shared" "$plugin_root/skills" "$plugin_root/package.json" "$plugin_root/README.md" \
    && tar -xzf /tmp/akm-claude.tar.gz -C /akm-marketplace --strip-components=1 \
      akm-plugins-62066b5d82c86c07b62e2e0a1fddec97b3182825/.agents/plugins/marketplace.json \
      akm-plugins-62066b5d82c86c07b62e2e0a1fddec97b3182825/.claude-plugin/marketplace.json \
      akm-plugins-62066b5d82c86c07b62e2e0a1fddec97b3182825/LICENSE
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
ENV PATH="/repo/node_modules/.bin:${PATH}"
# AKM owns acquisition and integrity verification. Bake its native runtime into
# its ordinary cache, without retaining a build-only setup config or installing
# anything at container startup. Local embeddings are upstream-supported on x64;
# ARM64 uses native keyword search or an operator's remote embedding endpoint.
RUN export AKM_CACHE_DIR=/akm-cache AKM_CONFIG_DIR=/tmp/akm-build/config \
      AKM_DATA_DIR=/tmp/akm-build/data AKM_STATE_DIR=/tmp/akm-build/state \
      AKM_BUNDLE_DIR=/tmp/akm-build/bundle \
    && bun -e "import { ensureRuntimeBinary } from 'akm-cli/dist/integrations/harnesses/opencode/runtime/binary.js'; await ensureRuntimeBinary();" \
    && if [ "${TARGETARCH}" = amd64 ]; then \
      akm setup --yes --embedding local --dir /tmp/akm-build/bundle --format json -q > /tmp/akm-setup.json \
      && bun -e "import assert from 'node:assert/strict'; const result = await Bun.file('/tmp/akm-setup.json').json(); assert.equal(result.semanticAssets, 'ready', JSON.stringify(result));"; \
    fi
RUN mkdir -p /native-defaults/codex \
    && CLAUDE_CONFIG_DIR=/native-defaults/claude claude plugin marketplace add /akm-marketplace \
    && CLAUDE_CONFIG_DIR=/native-defaults/claude claude plugin install akm@akm-plugins \
    && CODEX_HOME=/native-defaults/codex codex plugin marketplace add /akm-marketplace \
    && CODEX_HOME=/native-defaults/codex codex plugin add akm@akm-plugins \
    && CLAUDE_CONFIG_DIR=/native-defaults/claude claude plugin marketplace add /fhold-plugins \
    && CLAUDE_CONFIG_DIR=/native-defaults/claude claude plugin install fhold@fhold-plugins \
    && CODEX_HOME=/native-defaults/codex codex plugin marketplace add /fhold-plugins \
    && CODEX_HOME=/native-defaults/codex codex plugin add fhold@fhold-plugins \
    && chmod a+r /native-defaults/codex/config.toml

# Playwright supports Noble on both architectures. Its security repositories
# supply patched graphics/XML libraries absent from the Debian 13 browser stack.
FROM ubuntu:24.04

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git libnss-wrapper tzdata tini tree util-linux \
      ripgrep jq python3 python3-venv python3-pip sqlite3 zip unzip \
      poppler-utils file less procps \
    && rm -rf /var/lib/apt/lists/*

COPY --from=scheduler-build /go/bin/supercronic /usr/local/bin/supercronic
COPY --from=tools /repo/node_modules /opt/fhold/tools/node_modules
COPY --from=tools /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# Install the locked upstream browser and its system libraries before USER fhold.
# A shared immutable cache survives home mounts and works on both native arches.
RUN node /opt/fhold/tools/node_modules/playwright/cli.js install --with-deps chromium \
    && ln -s "$(node -e 'process.stdout.write(require("/opt/fhold/tools/node_modules/playwright").chromium.executablePath())')" /usr/local/bin/chromium \
    && chmod -R a+rX /opt/ms-playwright \
    && chmod -R a-w /opt/ms-playwright \
    && rm -rf /var/lib/apt/lists/*
# Keep the compatible, pinned upstream npm/npx installed in the Node stage,
# not Debian's npm or a second package manager installation at startup.
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY containers/assistant/tools/package.json /opt/fhold/tools/package.json
COPY containers/assistant/entrypoint.sh /usr/local/bin/fhold-assistant
COPY containers/assistant/healthcheck.sh /usr/local/bin/fhold-healthcheck
COPY containers/assistant/fhold-task.mjs /usr/local/bin/fhold-task
COPY containers/assistant/fhold-recovery.mjs /usr/local/bin/fhold-recovery
COPY containers/assistant/recovery /usr/local/bin/recovery
COPY --from=tools /assistant-defaults /assistant-defaults
COPY containers/assistant/fhold-remote.mjs /usr/local/bin/fhold-remote
COPY containers/assistant/fhold-remote-setup.mjs /usr/local/bin/fhold-remote-setup
COPY containers/assistant/fhold-codex-recall.mjs /usr/local/bin/fhold-codex-recall.mjs
COPY --from=tools /akm-marketplace /akm-marketplace
COPY --from=tools /fhold-plugins /fhold-plugins
COPY plugins/fhold /opt/fhold/tools/plugins/fhold
COPY --from=tools /fhold-bundle /fhold-bundle
COPY --from=tools /native-defaults /native-defaults
COPY --from=tools /akm-cache /opt/akm/cache
# Native system configuration exists before the non-root entrypoint starts.
COPY --from=tools /assistant-defaults/system/assistant/ /etc/opencode/
COPY --from=tools /assistant-defaults/system/codex/ /etc/codex/
COPY --from=tools /assistant-defaults/system/claude/ /etc/claude-code/

ARG PLATFORM_VERSION
ARG VCS_REF
ARG BUILD_DATE
ENV PLATFORM_VERSION=${PLATFORM_VERSION}
LABEL org.opencontainers.image.title="fhold Assistant" \
    dev.fwdslsh.fhold.recovery-partial-resume="1" \
    org.opencontainers.image.description="A home for your personal AI: OpenCode, persistent knowledge and recurring work" \
    org.opencontainers.image.source="https://github.com/fwdslsh/fhold" \
    org.opencontainers.image.url="https://github.com/fwdslsh/fhold" \
    org.opencontainers.image.revision="${VCS_REF}" \
    org.opencontainers.image.created="${BUILD_DATE}" \
    org.opencontainers.image.version="${PLATFORM_VERSION}" \
    org.opencontainers.image.licenses="MIT"

RUN test -n "$PLATFORM_VERSION" \
    && usermod -l fhold -d /home/fhold ubuntu \
    && groupmod -n fhold ubuntu \
    && chmod -R a-w /fhold-bundle /fhold-plugins /akm-marketplace /etc/opencode /etc/codex /etc/claude-code \
    && chmod -R a+rX /fhold-bundle /fhold-plugins /akm-marketplace /etc/opencode /etc/codex /etc/claude-code \
    && ln -s /fhold-plugins/fhold/scripts/activity.mjs /usr/local/bin/fhold-keepalive \
    && chmod 0555 /fhold-plugins/fhold/scripts/activity.mjs \
    && for command in opencode akm codex claude playwright; do \
      test -x "/opt/fhold/tools/node_modules/.bin/$command" || exit 1; \
      ln -s "/opt/fhold/tools/node_modules/.bin/$command" "/usr/local/bin/$command" || exit 1; \
    done \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && chmod 0755 /usr/local/bin/fhold-assistant /usr/local/bin/fhold-task /usr/local/bin/fhold-recovery /usr/local/bin/fhold-remote /usr/local/bin/fhold-remote-setup /usr/local/bin/fhold-codex-recall.mjs /usr/local/bin/fhold-healthcheck \
    && ln -s fhold-remote /usr/local/bin/fhold-remote.mjs \
    && mkdir -p /home/fhold /etc/opencode /etc/akm /opt/akm/cache /opt/akm/data/state /stash /work \
    && chown -R fhold:fhold /home/fhold /etc/akm /opt/akm /stash /work \
    && chmod -R a+rwX /home/fhold /etc/akm /opt/akm /stash /work

ENV HOME=/home/fhold \
    OPENCODE_CONFIG_DIR=/etc/opencode \
    OPENCODE_CONFIG=/home/fhold/.config/opencode/opencode.json \
    OPENCODE_DISABLE_EMBEDDED_WEB_UI=true \
    OPENCODE_PORT=4096 \
    AKM_BUNDLE_DIR=/stash \
    AKM_CONFIG_DIR=/etc/akm \
    AKM_CACHE_DIR=/opt/akm/cache \
    AKM_DATA_DIR=/opt/akm/data \
    AKM_STATE_DIR=/opt/akm/data/state \
    AKM_REDACT_HIGH_ENTROPY=1 \
    AKM_REDACT_PII=1 \
    FH_SCHEDULER_ENABLED=1 \
    DISABLE_AUTOUPDATER=1 \
    BUN_OPTIONS="--no-env-file --config=/dev/null" \
    TZ=UTC \
    PATH="/home/fhold/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/fhold/tools/node_modules/.bin"

WORKDIR /work
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD fhold-healthcheck

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/fhold-assistant"]
USER fhold
