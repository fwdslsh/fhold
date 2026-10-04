FROM node:24.21.0-bookworm-slim AS node-runtime
ARG NPM_VERSION=12.2.0
# Use npm's supported self-upgrade at build time, without altering its bundle.
# This upgrade fixes several bundled advisories; remaining findings still block CI.
RUN npm install --global "npm@${NPM_VERSION}" \
    && test "$(npm --version)" = "${NPM_VERSION}"

FROM oven/bun:1.4.2 AS tools
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
COPY containers/guardian/tools/package.json ./containers/guardian/tools/package.json
RUN bun install --frozen-lockfile --production --linker hoisted --filter @fhold/assistant-tools \
    && rm -rf node_modules/opencode-linux-x64-musl \
              node_modules/opencode-linux-x64-baseline \
              node_modules/opencode-linux-x64-baseline-musl \
              node_modules/opencode-linux-arm64-musl \
              node_modules/onnxruntime-node/bin/napi-v6/darwin \
              node_modules/onnxruntime-node/bin/napi-v6/win32 \
    && case "${TARGETARCH}" in \
      amd64) rm -rf node_modules/onnxruntime-node/bin/napi-v6/linux/arm64 \
                    node_modules/@img/sharp-libvips-linux-arm64 \
                    node_modules/@img/sharp-libvips-linuxmusl-arm64 \
                    node_modules/@img/sharp-linux-arm64 \
                    node_modules/@img/sharp-linuxmusl-arm64 \
                    node_modules/@img/sharp-libvips-linuxmusl-x64 \
                    node_modules/@img/sharp-linuxmusl-x64 ;; \
      arm64) rm -rf node_modules/onnxruntime-node/bin/napi-v6/linux/x64 \
                    node_modules/@img/sharp-libvips-linux-x64 \
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
ADD --checksum=sha256:364e42cbdce9bda435758fd7df7861ce360aa15286ac18a83a871595de39f8cc \
    https://codeload.github.com/itlackey/akm-plugins/tar.gz/26a281d923060f40af52c636fd7abc8cb5f64390 /tmp/akm-claude.tar.gz
RUN mkdir -p /akm-marketplace/claude \
    && plugin_root=akm-plugins-26a281d923060f40af52c636fd7abc8cb5f64390/claude \
    && tar -xzf /tmp/akm-claude.tar.gz -C /akm-marketplace/claude --strip-components=2 \
      "$plugin_root/.claude-plugin" "$plugin_root/.codex-plugin" "$plugin_root/commands" "$plugin_root/hooks" \
      "$plugin_root/shared" "$plugin_root/skills" "$plugin_root/package.json" "$plugin_root/README.md" \
    && tar -xzf /tmp/akm-claude.tar.gz -C /akm-marketplace --strip-components=1 \
      akm-plugins-26a281d923060f40af52c636fd7abc8cb5f64390/.agents/plugins/marketplace.json \
      akm-plugins-26a281d923060f40af52c636fd7abc8cb5f64390/.claude-plugin/marketplace.json \
      akm-plugins-26a281d923060f40af52c636fd7abc8cb5f64390/LICENSE
COPY scripts/bake-managed-hooks.mjs /repo/scripts/bake-managed-hooks.mjs
RUN bun /repo/scripts/bake-managed-hooks.mjs /managed-defaults
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
ENV PATH="/repo/node_modules/.bin:${PATH}"
# Let the pinned native CLI generate its SDK dependency cache at build time.
# Copy only its generated package/lock/modules, never the blank build home's
# native databases, configuration, accounts, trust, or registration state.
RUN mkdir -p /etc/opencode /opt/fhold/tools /native-defaults/opencode-sdk \
    && cp -R /assistant-defaults/system/assistant/. /etc/opencode/ \
    && ln -s /repo/node_modules /opt/fhold/tools/node_modules \
    && HOME=/opencode-build-home OPENCODE_CONFIG_DIR=/etc/opencode \
      OPENCODE_DISABLE_PROJECT_CONFIG=true OPENCODE_DISABLE_CLAUDE_CODE=true \
      OPENCODE_DISABLE_EXTERNAL_SKILLS=true BUN_OPTIONS="--no-env-file --config=/dev/null" \
      opencode debug config >/dev/null \
    && cp /opencode-build-home/.config/opencode/package.json \
      /opencode-build-home/.config/opencode/package-lock.json /native-defaults/opencode-sdk/ \
    && cp -R /opencode-build-home/.config/opencode/node_modules /native-defaults/opencode-sdk/ \
    && bun --no-env-file --config=/dev/null -e \
      'const p=require("/native-defaults/opencode-sdk/node_modules/@opencode-ai/plugin/package.json"); const v=require("/repo/containers/assistant/tools/package.json").dependencies["opencode-ai"]; if(p.version!==v)throw new Error("Native SDK cache pin mismatch")'
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

FROM oven/bun:1.4.2-slim

ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.49

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git libnss-wrapper tzdata tini util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && case "${TARGETARCH}" in \
      amd64) supercronic_sha=a53ae236602c7338aba3fbaff40bda6300eae3b9fedb8261eb06cfe3724430c1 ;; \
      arm64) supercronic_sha=02aa0cb229ba09050cba6638059dadb9eedc2276632ea43d6a57a2f8c1629dd5 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL --retry 5 --retry-all-errors \
      -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}" \
    && echo "${supercronic_sha}  /usr/local/bin/supercronic" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/supercronic

COPY --from=tools /repo/node_modules /opt/fhold/tools/node_modules
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
# Keep the compatible, pinned upstream npm/npx installed in the Node stage,
# not Debian's npm or a second package manager installation at startup.
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY containers/assistant/tools/package.json /opt/fhold/tools/package.json
COPY containers/assistant/entrypoint.sh /usr/local/bin/fhold-assistant
COPY containers/assistant/healthcheck.sh /usr/local/bin/fhold-healthcheck
COPY containers/assistant/opencode-run.sh /usr/local/bin/fhold-opencode-run
COPY containers/assistant/fhold-task.mjs /usr/local/bin/fhold-task
COPY containers/assistant/fhold-recovery.mjs /usr/local/bin/fhold-recovery
COPY containers/assistant/recovery /usr/local/bin/recovery
COPY --from=tools /assistant-defaults /assistant-defaults
COPY containers/assistant/fhold-remote.mjs /usr/local/bin/fhold-remote
COPY containers/assistant/fhold-remote-setup.mjs /usr/local/bin/fhold-remote-setup
COPY containers/assistant/fhold-codex-recall.mjs /usr/local/bin/fhold-codex-recall.mjs
COPY --from=tools /akm-marketplace /akm-marketplace
COPY --from=tools /fhold-plugins /fhold-plugins
COPY --from=tools /fhold-bundle /fhold-bundle
COPY --from=tools /native-defaults /native-defaults
COPY --from=tools /managed-defaults/ /
# Native system configuration exists before the non-root entrypoint starts.
COPY --from=tools /assistant-defaults/system/assistant/ /etc/opencode/
COPY --from=tools /assistant-defaults/config/opencode/ /etc/opencode/
COPY --from=tools /assistant-defaults/config/codex/ /etc/codex/
COPY --from=tools /assistant-defaults/config/claude/ /etc/claude-code/
COPY --from=tools /native-defaults/opencode-sdk/ /etc/opencode/

ARG PLATFORM_VERSION
ARG VCS_REF
ARG BUILD_DATE
ENV PLATFORM_VERSION=${PLATFORM_VERSION}
LABEL org.opencontainers.image.title="fhold Assistant" \
    dev.fwdslsh.fhold.managed-harness-policy="1" \
    org.opencontainers.image.description="A home for your personal AI: OpenCode, persistent knowledge and recurring work" \
    org.opencontainers.image.source="https://github.com/fwdslsh/fhold" \
    org.opencontainers.image.url="https://github.com/fwdslsh/fhold" \
    org.opencontainers.image.revision="${VCS_REF}" \
    org.opencontainers.image.created="${BUILD_DATE}" \
    org.opencontainers.image.version="${PLATFORM_VERSION}" \
    org.opencontainers.image.licenses="MIT"

RUN test -n "$PLATFORM_VERSION" \
    && usermod -l fhold -d /home/fhold bun \
    && groupmod -n fhold bun \
    && chmod -R a-w /fhold-bundle /fhold-plugins /akm-marketplace /etc/opencode /etc/codex /etc/claude-code \
    && chmod -R a+rX /fhold-bundle /fhold-plugins /akm-marketplace /etc/opencode /etc/codex /etc/claude-code \
    && ln -s /fhold-plugins/fhold/scripts/activity.mjs /usr/local/bin/fhold-keepalive \
    && chmod 0555 /fhold-plugins/fhold/scripts/activity.mjs \
    && for command in opencode akm codex claude; do \
      test -x "/opt/fhold/tools/node_modules/.bin/$command" || exit 1; \
      ln -s "/opt/fhold/tools/node_modules/.bin/$command" "/usr/local/bin/$command" || exit 1; \
    done \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && chmod 0755 /usr/local/bin/fhold-assistant /usr/local/bin/fhold-task /usr/local/bin/fhold-recovery /usr/local/bin/fhold-remote /usr/local/bin/fhold-remote-setup /usr/local/bin/fhold-codex-recall.mjs /usr/local/bin/fhold-healthcheck /usr/local/bin/fhold-opencode-run \
    && ln -s fhold-remote /usr/local/bin/fhold-remote.mjs \
    && mkdir -p /home/fhold /etc/opencode /etc/akm /opt/akm/cache /opt/akm/data/state /stash /work \
    && chown -R fhold:fhold /home/fhold /etc/akm /opt/akm /stash /work \
    && chmod -R a+rwX /home/fhold /etc/akm /opt/akm /stash /work

ENV HOME=/home/fhold \
    OPENCODE_CONFIG_DIR=/etc/opencode \
    OPENCODE_DISABLE_PROJECT_CONFIG=true \
    OPENCODE_DISABLE_CLAUDE_CODE=true \
    OPENCODE_DISABLE_EXTERNAL_SKILLS=true \
    OPENCODE_DISABLE_EMBEDDED_WEB_UI=true \
    OPENCODE_PORT=4096 \
    OPENCODE_SERVER_USERNAME=user \
    AKM_BUNDLE_DIR=/stash \
    AKM_CONFIG_DIR=/etc/akm \
    AKM_CACHE_DIR=/opt/akm/cache \
    AKM_DATA_DIR=/opt/akm/data \
    AKM_STATE_DIR=/opt/akm/data/state \
    AKM_AUTO_MEMORY=0 \
    AKM_AUTO_LEARNING=0 \
    AKM_REDACT_HIGH_ENTROPY=1 \
    AKM_REDACT_PII=1 \
    FH_AUTOMATIC_MEMORY=1 \
    FH_SCHEDULER_ENABLED=1 \
    DISABLE_AUTOUPDATER=1 \
    BUN_OPTIONS="--no-env-file --config=/dev/null" \
    TZ=UTC \
    PATH="/opt/fhold/tools/node_modules/.bin:/home/fhold/.local/bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /work
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD fhold-healthcheck

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/fhold-assistant"]
USER fhold
