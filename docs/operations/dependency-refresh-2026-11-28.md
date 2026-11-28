# Dependency review, November 28, 2026

This refresh covers all container runtime/tool pins, package manifests, supported
Slack transitive updates, Admin and the documentation builder. AKM CLI/Web
0.10.261135 and plugins 0.10.261141 are already included in the same PR.

| Component | Previous | Selected stable version |
| --- | --- | --- |
| Node (Assistant and Portal) | 26.13.0 | 26.13.1 |
| Bun, compiler, CI and bun-types | 1.4.4 | 1.4.5 |
| npm (Assistant) | 12.2.2 | 12.2.3 |
| Claude Code | 2.1.319 | 2.1.332 |
| Codex | 0.167.0 | 0.172.0 |
| Playwright and playwright-core | 1.65.0 | 1.65.1 |
| Slack Socket Mode (transitive) | 3.1.0 | 3.2.0 |
| Slack Web API (transitive) | 8.2.0 | 8.5.0 |
| jose | 6.2.16 | 6.2.18 |
| tar | 7.5.22 | 7.5.24 |
| Electron | 45.2.3 | 45.5.0 |
| axe-core | 4.14.0 | 4.14.1 |
| Biome | 2.6.6 | 2.6.9 |
| Node types | 26.6.6 | 26.6.11 |
| Unify (website) | 0.11.17 | 0.12.0 |

## Compatibility and holds

- **OpenCode CLI/client/plugin remain at 2.2.6 by owner direction.** Investigate
  the reported async background-agent issue before upgrading to 2.4.2 or later.
  This refresh does not diagnose or resolve that issue. Effect remains 4.1.0,
  aligned with the selected OpenCode SDK; it is not independently forced to 4.1.7.
  AKM's plugin still declares SDK 2.1.4/Effect 4.0.1 peers. Keep the existing native
  integration checks; no override or vendor patch conceals this mismatch.
- [Node 26.13.1](https://nodejs.org/en/blog/release/v26.13.1) and
  [Bun 1.4.5](https://bun.com/blog/bun-v1.4.5) are security releases. Bun includes
  SQLite and TLS changes; preserve native migration/recovery checks and verify
  operator trust stores where applicable. Both Node image variants and the Bun
  images are published for amd64 and arm64.
- [Slack Socket Mode 3.2.0](https://github.com/slackapi/node-slack-sdk/releases/tag/%40slack/socket-mode%403.2.0)
  fixes disconnect watchdog warnings, reconnect races and connection-refresh
  gaps. Bolt 5.1.0 already permits Socket Mode `^3.0.1` and Web API `^8.1.1`.
  `bun update @slack/socket-mode @slack/web-api --lockfile-only --ignore-scripts`
  refreshes those native ranges without adding direct dependencies or overrides.
  Refresh briefly overlaps two connections per instance; preserve room under
  Slack's per-app connection limit. These fixes do not retrospectively prove the
  cause of every observed transport incident.
- Native harness upgrades retain existing sign-in, consent and worker settings.
  Verify hooks, marketplace refresh and harness-specific activity/keep-alive.
  Playwright and its Admin test client move together.
- Electron builder 26.18.1 and updater 6.8.12 remain pinned. Their published
  versions are ahead of their current npm `latest` tags; following the tags would
  downgrade them. Go 1.27.4, Supercronic 0.2.51, Azure SDKs, MCP SDKs, Slack Bolt,
  Discord.js, TypeScript and MCPB have no newer stable update in this review.
- Keep the approved Zod/glob/minimatch audit exceptions until supported parent
  packages update their dependency chains. MCPB still depends on Zod 3; even
  OpenCode util 2.4.2 still pins the affected glob/minimatch majors. Do not force
  incompatible transitive versions. No new exception is introduced.

## Verification and release scope

Use Bun 1.4.5 to regenerate and install the frozen lockfile. Check the OpenCode
and Effect records against the pre-refresh lockfile, run source tests with socket
fixtures, type checks, lint, CLI/Admin builds, documentation checks and the audit.
Exercise the newly built images using the existing native smoke tests.

This changes Assistant AIO/Slim, Guardian, Portal, Admin and build inputs. It is
not an Assistant-only release. The shared CI toolchain change requires all eight
native image jobs at final qualification. Local amd64 development evidence does
not qualify ARM64 or publication. No release version or live deployment changes
are made as part of this dependency refresh; record completed results in the PR.

### Local development evidence

- Frozen installation with Bun 1.4.5 passed. Every OpenCode and Effect lockfile
  record is unchanged from the preceding PR commit.
- Full source suite: 1,304 passed, zero failed, 11 opt-in provider/history tests
  skipped. Type checks and lint passed; lint reports warnings. Documentation
  check/build/tests passed with Unify 0.12.0. The dependency audit passed with the
  same three approved exceptions.
- Built AIO, Slim, Guardian and Portal on Linux amd64. Both Assistant runtime
  smokes passed browser rendering/PDF, native AKM Web authentication/origin checks,
  native harness recall and policy integration. AIO tested Claude Code and Codex;
  Slim tested its included OpenCode harness.
- Guardian startup/security smoke passed. Portal verified native Node SQLite,
  Slack heartbeat, mention/acknowledgement and automatic reconnect behavior.
- Admin's Chromium renderer/accessibility test passed all 380 assertions. The
  freshly compiled CLI generated a valid all-profile Compose project in an
  isolated home. These checks do not constitute a released-image upgrade or
  native ARM64 qualification.
- AIO lifecycle smoke passed native plugin/config migration, retained operator
  off choices, scheduled execution, keyring and delegated credential isolation.
- Native Electron 45.5.0 end-to-end testing passed, including CLI/Admin builds,
  instance selection, recovery controls and app relaunch. This uses disposable
  instances with the published container defaults; the refreshed image evidence
  comes from the separate image smokes above.
- Codex 0.172.0 activity smoke passed idle coverage, completed/failed/interrupted
  turns, quiet active-turn protection and consent revocation/restoration with a
  controlled local provider. The first run's shell received SIGTERM without an
  assertion failure; one unchanged isolated rerun completed successfully. No
  timeout, observation interval or runtime behavior was changed to obtain a pass.
  Vendor-account qualification and final CI image/security gates remain separate.
